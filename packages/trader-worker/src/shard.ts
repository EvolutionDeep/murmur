// FlyShardDO — one contiguous slice of the fly swarm, living in its OWN Durable Object isolate.
//
// Sharding is how murmur scales each brain past the single-isolate 128 MB ceiling: instead of one
// FlyStateDO holding all 24 (or more) connectomes, the coordinator (state.ts + swarm.ts) fans the
// HEAVY half of every tick out to N of these, each holding populationSize/shardCount flies with its own
// memory budget, its own 30 s CPU allowance and its own SQLite. A shard does exactly three things:
//   · advance — drive + integrate its flies' spiking nets and return the COMPACT motor/sensory read-out
//               (a fixed handful of floats per fly, independent of neuron count) to the coordinator;
//   · persist — write its own brains to its own storage, once per cron (on the coordinator's commit);
//   · serve  — the per-fly neural inspector reads (/snapshot, /fly) routed here by the owning shard.
//
// Shards are reachable ONLY from the coordinator via the FLY_SHARD binding — the public Worker fetch
// never routes here — so they are internal by construction and need no auth gate or CORS of their own.

import { FlyBrain, type MarketPulse, type StimulusEvent } from "@fly/fly-brain";
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

/** This shard's own brains, persisted separately from the coordinator and from every other shard. */
const KEY_SHARD_POPULATION = "shardPopulation:v1";

export class FlyShardDO {
  private state: DurableObjectState;
  private env: Env;
  private cfg: RuntimeConfig;
  /** Which slice this isolate owns, recovered from its DO name ("fly-shard-K"). */
  private shardIndex: number;
  /** This shard's flies (brains + identity). Lazily built/restored; null after an eviction or reset. */
  private flies: AdvanceableFly[] | null = null;

  constructor(state: DurableObjectState, env: Env) {
    this.state = state;
    this.env = env;
    this.cfg = loadConfig(env);
    // The coordinator names each shard "fly-shard-K" (see swarm.ts); recover K so this isolate derives
    // the SAME slice from config the coordinator routed to. Falls back to 0 if the name is absent.
    const m = /(\d+)\s*$/.exec(state.id.name ?? "");
    this.shardIndex = m ? Number(m[1]) : 0;
  }

  /** The half-open [start, end) range of global fly ids this shard owns. */
  private slice(): { start: number; end: number } {
    return shardSlice(this.cfg.populationSize, this.cfg.shardCount, this.shardIndex);
  }

  /**
   * Lazily (re)build this shard's brains, restoring archived electrical state when present. A brain
   * whose archive came from a DIFFERENTLY-SIZED connectome (e.g. after a neuron-count bump) wakes fresh
   * rather than misaligning membrane potentials — FlyBrain.deserialize already guarantees that.
   */
  private async ensureFlies(): Promise<AdvanceableFly[]> {
    if (this.flies) return this.flies;
    const { start, end } = this.slice();
    const archived = await this.loadArchivedBrains();
    const flies: AdvanceableFly[] = [];
    for (let id = start; id < end; id++) {
      const seed = this.cfg.populationSeeds[id];
      const opts = { seed, ...this.cfg.brainOpts };
      const brain = archived?.has(id)
        ? FlyBrain.deserialize(archived.get(id)!, opts)
        : new FlyBrain(opts);
      const vitals: FlyVitals = { id, seed, temperament: flyTemperament(seed) };
      flies.push({ id, brain, vitals });
    }
    this.flies = flies;
    return this.flies;
  }

  /** id → archived brain JSON for this shard, or null when there is nothing stored / it is unreadable. */
  private async loadArchivedBrains(): Promise<Map<number, string> | null> {
    const stored = await this.state.storage.get<string>(KEY_SHARD_POPULATION);
    if (!stored) return null;
    try {
      const parsed = JSON.parse(stored);
      const map = new Map<number, string>();
      for (const f of parsed?.flies ?? []) {
        const id = Number(f?.vitals?.id);
        if (Number.isFinite(id) && typeof f?.brain === "string") map.set(id, f.brain);
      }
      return map.size > 0 ? map : null;
    } catch (e) {
      console.warn(`[shard ${this.shardIndex}] deserialize failed:`, (e as Error).message);
      return null;
    }
  }

  /** Write this shard's brains to its own storage — splitting the once-per-cron persistence cost N ways. */
  private async persistFlies(): Promise<void> {
    if (!this.flies) return;
    const payload = JSON.stringify({
      version: 1,
      shardIndex: this.shardIndex,
      flies: this.flies.map((f) => ({ vitals: f.vitals, brain: f.brain.serialize() })),
    });
    await this.state.storage.put(KEY_SHARD_POPULATION, payload);
  }

  // ---------- Internal RPC (coordinator → shard only) ----------

  async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url);
    const path = url.pathname;
    try {
      if (req.method === "POST" && path === "/advance") return await this.advance(req);
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
