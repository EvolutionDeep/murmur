// FlyShardDO — one contiguous slice of the fly swarm, living in its OWN Durable Object isolate.
//
// Sharding is how murmur scales each brain past the single-isolate 128 MB ceiling: instead of one
// FlyStateDO holding all 24 (or more) connectomes, the coordinator (state.ts + swarm.ts) fans the
// HEAVY half of every tick out to N of these, each owning a contiguous slice of maxLivePopulation/
// shardCount id slots with its own memory budget, its own 30 s CPU allowance and its own SQLite. Slots
// below populationSize are the genesis flies (always present); slots at/above it stay EMPTY until the
// coordinator hatches a bred offspring into them. A shard does exactly four things:
//   · advance — drive + integrate its flies' spiking nets and return the COMPACT motor/sensory read-out
//               (a fixed handful of floats per fly, independent of neuron count) to the coordinator;
//   · hatch   — build a bred offspring's brain from the genome the coordinator ships and add it to the slice;
//   · persist — write its own brains to its own storage, once per cron (on the coordinator's commit);
//   · serve  — the per-fly neural inspector reads (/snapshot, /fly) routed here by the owning shard.
//
// Shards are reachable ONLY from the coordinator via the FLY_SHARD binding — the public Worker fetch
// never routes here — so they are internal by construction and need no auth gate or CORS of their own.

import { FlyBrain, genomeToConnectomeOptions, type Genome, type MarketPulse, type StimulusEvent } from "@fly/fly-brain";
import type { Env, RuntimeConfig } from "./config.js";
import { loadConfig, shardSlice } from "./config.js";
import {
  advanceFlies,
  flyTemperament,
  type AdvanceableFly,
  type FlyReadOut,
  type FlyVitals,
} from "./population.js";
import { neuralSnapshotOf } from "./swarm.js";

/** This shard's own brains, persisted separately from the coordinator and from every other shard. The KEY
 *  is stable across schema bumps (renaming it would orphan live shards' state); the payload's `version`
 *  field tracks the schema — v1 genesis-only, v2 adds a hatched fly's genome inside vitals. */
const KEY_SHARD_POPULATION = "shardPopulation:v1";

export class FlyShardDO {
  private state: DurableObjectState;
  private env: Env;
  private cfg: RuntimeConfig;
  /** Which slice this isolate owns, recovered from its DO name ("fly-shard-K"). */
  private shardIndex: number;
  /** This shard's flies (brains + identity). Lazily built/restored; null after an eviction or reset. */
  private flies: AdvanceableFly[] | null = null;
  /** Tombstoned ids retired by the coordinator (a dead fly whose brain was deleted here). Persisted in the
   *  v3 payload so a cold-boot ensureFlies NEVER resurrects a retired founder from the config genesis seed.
   *  A recycled slot lifts its id back out (a new offspring hatched into it). */
  private retiredIds: Set<number> | null = null;

  constructor(state: DurableObjectState, env: Env) {
    this.state = state;
    this.env = env;
    this.cfg = loadConfig(env);
    // The coordinator names each shard "fly-shard-K" (see swarm.ts); recover K so this isolate derives
    // the SAME slice from config the coordinator routed to. Falls back to 0 if the name is absent.
    const m = /(\d+)\s*$/.exec(state.id.name ?? "");
    this.shardIndex = m ? Number(m[1]) : 0;
  }

  /** The half-open [start, end) range of global fly id SLOTS this shard owns (derived from the stable
   *  growth ceiling, so an id's shard never changes as offspring hatch — no brain ever migrates). */
  private slice(): { start: number; end: number } {
    return shardSlice(this.cfg.maxLivePopulation, this.cfg.shardCount, this.shardIndex);
  }

  /**
   * Lazily (re)build this shard's brains, restoring archived electrical state when present. A brain
   * whose archive came from a DIFFERENTLY-SIZED connectome (e.g. after a neuron-count bump) wakes fresh
   * rather than misaligning membrane potentials — FlyBrain.deserialize already guarantees that.
   */
  private async ensureFlies(): Promise<AdvanceableFly[]> {
    if (this.flies) return this.flies;
    const { start, end } = this.slice();
    const archived = await this.loadArchived();   // also populates this.retiredIds
    const retired = this.retiredIds ?? new Set<number>();
    const flies: AdvanceableFly[] = [];
    for (let id = start; id < end; id++) {
      if (retired.has(id)) continue;   // tombstone: a retired fly stays dead, never rebuilt from the seed
      const rec = archived?.get(id);
      if (rec?.genome) {
        // OFFSPRING / RECYCLED slot (a genesis id reclaimed by a new offspring carries a genome here): rebuild
        // from its OWN genome (NOT the genesis sizing) so a restored bred brain matches its archive.
        const genome = rec.genome;
        const opts = genomeToConnectomeOptions(genome);
        const brain = rec.brain ? FlyBrain.deserialize(rec.brain, opts) : new FlyBrain(opts);
        const vitals: FlyVitals = { id, seed: genome.seed, temperament: flyTemperament(genome.seed), genome };
        flies.push({ id, brain, vitals });
      } else if (id < this.cfg.populationSize) {
        // GENESIS slot (never retired, never recycled): reproducible from (seed, shared brainOpts).
        const seed = this.cfg.populationSeeds[id];
        const opts = { seed, ...this.cfg.brainOpts };
        const brain = rec ? FlyBrain.deserialize(rec.brain, opts) : new FlyBrain(opts);
        const vitals: FlyVitals = { id, seed, temperament: flyTemperament(seed) };
        flies.push({ id, brain, vitals });
      }
      // else: an empty growth slot (id >= populationSize with no hatched genome yet) holds no fly.
    }
    this.flies = flies;
    return this.flies;
  }

  /** id → {brain JSON, genome?} archived for this shard, or null when nothing is stored / it is unreadable.
   *  Reads the v1 (genesis-only), v2 (adds a hatched genome) and v3 (adds retiredIds tombstones) payloads;
   *  always refreshes this.retiredIds from the stored tombstone list. */
  private async loadArchived(): Promise<Map<number, { brain: string; genome?: Genome }> | null> {
    const stored = await this.state.storage.get<string>(KEY_SHARD_POPULATION);
    if (!stored) { this.retiredIds = new Set(); return null; }
    try {
      const parsed = JSON.parse(stored);
      const map = new Map<number, { brain: string; genome?: Genome }>();
      for (const f of parsed?.flies ?? []) {
        const id = Number(f?.vitals?.id);
        if (Number.isFinite(id) && typeof f?.brain === "string") {
          map.set(id, { brain: f.brain, ...(f?.vitals?.genome ? { genome: f.vitals.genome as Genome } : {}) });
        }
      }
      this.retiredIds = new Set(
        (Array.isArray(parsed?.retiredIds) ? parsed.retiredIds : []).map(Number).filter((n: number) => Number.isInteger(n)),
      );
      return map.size > 0 ? map : null;
    } catch (e) {
      console.warn(`[shard ${this.shardIndex}] deserialize failed:`, (e as Error).message);
      this.retiredIds = new Set();
      return null;
    }
  }

  /** Write this shard's brains to its own storage — splitting the once-per-cron persistence cost N ways.
   *  vitals carries a hatched fly's genome, so the payload is self-describing (v2) and rebuilds on reload.
   *  v3 adds the retiredIds tombstone so a cold boot can't resurrect a retired founder. */
  private async persistFlies(): Promise<void> {
    if (!this.flies) return;
    const payload = JSON.stringify({
      version: 3,   // v3 adds the retiredIds tombstone; v2 added a hatched genome; reader tolerates v1/v2
      shardIndex: this.shardIndex,
      flies: this.flies.map((f) => ({ vitals: f.vitals, brain: f.brain.serialize() })),
      retiredIds: Array.from(this.retiredIds ?? []).sort((a, b) => a - b),
    });
    await this.state.storage.put(KEY_SHARD_POPULATION, payload);
  }

  // ---------- Internal RPC (coordinator → shard only) ----------

  async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url);
    const path = url.pathname;
    try {
      if (req.method === "POST" && path === "/advance") return await this.advance(req);
      if (req.method === "POST" && path === "/hatch") return await this.hatch(req);
      if (req.method === "POST" && path === "/retire") return await this.retire(req);
      if (req.method === "GET" && path === "/snapshot") return await this.snapshot(url);
      if (req.method === "GET" && path === "/fly") return await this.fly(url);
      if (req.method === "POST" && path === "/reset") return await this.reset();
      return json({ error: "not found" }, 404);
    } catch (e) {
      console.error(`[shard ${this.shardIndex}] fetch error:`, e);
      return json({ error: (e as Error).message }, 500);
    }
  }

  /**
   * HEAVY half of the tick for this slice: drive every fly with the shared pulse (+ stimuli) and advance
   * its spiking net, returning only the compact read-outs. The coordinator reduces them globally. Brains
   * persist on the cron's commit sub-tick (persist=true), not on every sub-tick — mirroring the
   * single-DO path's once-per-cron write.
   */
  private async advance(req: Request): Promise<Response> {
    const body = (await req.json()) as {
      pulse: MarketPulse;
      stimuli?: StimulusEvent[];
      simSteps: number;
      persist?: boolean;
    };
    const flies = await this.ensureFlies();
    const readOuts: FlyReadOut[] = advanceFlies(flies, body.pulse, body.stimuli ?? [], body.simSteps);
    if (body.persist) await this.persistFlies();
    return json({ shardIndex: this.shardIndex, readOuts });
  }

  /**
   * Hatch a bred offspring into this shard: build its brain from the genome the coordinator ships, add it
   * to this slice and persist it so it survives an eviction. Idempotent (a repeat /hatch for an id already
   * here is a no-op). The id MUST fall in this shard's slice — the coordinator routes it here via
   * shardOf(maxLivePopulation, …), so a mismatch is a routing bug and is refused.
   */
  private async hatch(req: Request): Promise<Response> {
    const body = (await req.json()) as { id: number; genome: Genome };
    const id = Number(body?.id);
    const genome = body?.genome;
    const { start, end } = this.slice();
    if (!Number.isInteger(id) || id < start || id >= end || !genome) {
      return json({ error: `id ${id} not owned by shard ${this.shardIndex} [${start},${end})` }, 400);
    }
    const flies = await this.ensureFlies();
    this.retiredIds?.delete(id);   // reclaim a tombstoned slot: the new offspring is live here, not retired
    const existing = flies.find((f) => f.id === id);
    if (existing?.vitals.genome) return json({ ok: true, id, already: true });   // genuinely already hatched here
    if (existing) {
      // A leftover GENESIS brain in a slot being reclaimed (its /retire never reached this shard): drop it so
      // the offspring brain below takes the id, matching the coordinator's roster.
      flies.splice(flies.indexOf(existing), 1);
    }
    const opts = genomeToConnectomeOptions(genome);
    const brain = new FlyBrain(opts);
    const vitals: FlyVitals = { id, seed: genome.seed, temperament: flyTemperament(genome.seed), genome };
    flies.push({ id, brain, vitals });
    flies.sort((a, b) => a.id - b.id);   // keep the slice ascending (the coordinator re-orders by id anyway)
    await this.persistFlies();
    return json({ ok: true, id, shardIndex: this.shardIndex });
  }

  /**
   * Retire a dead fly from this shard: delete its brain, tombstone the id (so a cold boot can't rebuild it
   * from the config genesis seed) and persist. The coordinator routes the id here via shardOf(cap, …), so a
   * mismatch is a routing bug and is refused. Idempotent (an unknown id is simply a no-op tombstone).
   */
  private async retire(req: Request): Promise<Response> {
    const body = (await req.json()) as { id: number };
    const id = Number(body?.id);
    const { start, end } = this.slice();
    if (!Number.isInteger(id) || id < start || id >= end) {
      return json({ error: `id ${id} not owned by shard ${this.shardIndex} [${start},${end})` }, 400);
    }
    const flies = await this.ensureFlies();
    const i = flies.findIndex((f) => f.id === id);
    if (i >= 0) flies.splice(i, 1);
    this.retiredIds = this.retiredIds ?? new Set();
    this.retiredIds.add(id);
    await this.persistFlies();
    return json({ ok: true, id, shardIndex: this.shardIndex });
  }

  /** Full neural snapshot of one fly in this shard (for the coordinator's GET /snapshot?flyId=). */
  private async snapshot(url: URL): Promise<Response> {
    const flyId = Number(url.searchParams.get("flyId"));
    const flies = await this.ensureFlies();
    const fly = flies.find((f) => f.id === flyId);
    if (!fly) return json({ error: `fly ${flyId} not in shard ${this.shardIndex}` }, 404);
    return json(neuralSnapshotOf(fly));
  }

  /** Motor + identity of one fly in this shard (for the coordinator's GET /flies/:id). */
  private async fly(url: URL): Promise<Response> {
    const flyId = Number(url.searchParams.get("flyId"));
    const flies = await this.ensureFlies();
    const fly = flies.find((f) => f.id === flyId);
    if (!fly) return json({ error: "not found" }, 404);
    return json({
      vitals: fly.vitals,
      motor: fly.brain.readAllMotor(),
      t: fly.brain.t,
      step: fly.brain.step,
    });
  }

  /** Wipe this shard back to a fresh founding slice (rebuilt deterministically from the seeds). */
  private async reset(): Promise<Response> {
    this.flies = null;
    await this.state.storage.delete(KEY_SHARD_POPULATION);
    const flies = await this.ensureFlies();
    await this.persistFlies();
    return json({ ok: true, shardIndex: this.shardIndex, flies: flies.length });
  }
}

/**
 * Internal RPC responder. Shards are reachable only from the coordinator over the FLY_SHARD binding
 * (never routed from the public Worker fetch and never seen by a browser), so — unlike the coordinator's
 * responder — no CORS headers are needed here.
 */
function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" },
  });
}
