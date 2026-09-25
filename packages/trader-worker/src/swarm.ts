// SwarmBackend — the seam that lets the fly swarm run either in ONE Durable Object (today) or be
// SHARDED across many, without the coordinator (state.ts) knowing which.
//
// A tick has two halves (see population.ts):
//   · HEAVY  advanceFlies()   — the O(N+S) LIF integration over every neuron of every fly. Per-fly,
//                               no cross-fly coupling, so it can run anywhere the brains live.
//   · LIGHT  reduceReadOuts() — computeBands() over the WHOLE swarm, then decode each fly against its
//                               peers and aggregate the collective mood. Must see every fly at once.
//
// LocalSwarm keeps both halves in the coordinator isolate (a single Population) — byte-for-byte the
// behaviour the piece has always run. ShardedSwarm pushes the HEAVY half out to N FlyShardDO isolates
// (one contiguous slice of flies each, its own 128 MB + CPU budget, its own SQLite) in parallel, and
// keeps only the LIGHT reduce + the tiny per-fly roster here. Because just the compact read-out crosses
// the boundary — a fixed handful of per-channel floats, independent of neuron count — the coordinator
// stays small no matter how big the brains get. That is what lifts the single-isolate memory ceiling.

import {
  MotorDecoder,
  type FlyBehavior,
  type Genome,
  type MarketPulse,
  type MotorOutput,
  type StimulusEvent,
} from "@fly/fly-brain";
import type { Env, RuntimeConfig } from "./config.js";
import { fliesPerShard, shardOf } from "./config.js";
import type { Regime } from "./market.js";
import {
  Population,
  flyTemperament,
  reduceReadOuts,
  type AdvanceableFly,
  type FlyReadOut,
  type FlyVitals,
  type PopulationSnapshot,
  type ReduceRosterEntry,
} from "./population.js";

// Bound EVERY coordinator→shard RPC. A FlyShardDO saturated by read fan-out can leave a `stub.fetch`
// pending forever — it neither resolves nor rejects, so the try/catch + one-retry degrade below never
// fires and swarm.step() hangs the whole cron BEFORE persist() → lastCron/史官 freeze (the production
// 900s-wall / ~0-CPU `canceled` we caught). A hard ceiling turns that silent hang into a caught
// TimeoutError so the retry→degrade actually runs and the clock ALWAYS advances. Both values sit well
// inside the 60s cadence even across the ceil(shardCount/6) fan-out waves (50 shards ≈ 9 waves).
const ADVANCE_TIMEOUT_MS = 5000;    // the hot per-sub-tick cron path (a healthy shard advance is <1s)
const SHARD_IO_TIMEOUT_MS = 6000;   // snapshot/fly reads + retire/hatch/reset one-shots

/** Coordinator-side storage keys owned by the swarm layer. */
export const KEY_POPULATION = "population:v3";   // LocalSwarm: the whole single-DO Population.serialize()
export const KEY_COORDINATOR = "coordinator:v1"; // ShardedSwarm: the {tickIndex, vitality} counter (brains live in shards)
export const KEY_ROSTER = "coordinatorRoster:v1"; // ShardedSwarm: hatched offspring (id + seed + genome) beyond the config-derived genesis roster — NOT derivable from config, so persisted
export const KEY_RETIRED = "coordinatorRetired:v1"; // ShardedSwarm: tombstoned ids (retired dead flies), so a cold boot rebuilds the genesis roster WITHOUT resurrecting them
export const KEY_LAYOUT = "coordinatorLayout:v1"; // ShardedSwarm: the flies/shard signature the persisted brains were last seeded under — a clamp/shard change that REMAPS id→shard triggers a one-time offspring re-seed (see migrateLayoutIfNeeded) instead of orphaning live brains

/** The full neural read-out of one fly, for GET /snapshot (the generative inspector view). */
export interface FlyNeuralSnapshot {
  flyId: number;
  seed: number;
  temperament: number;
  t: number;
  step: number;
  firingRates: number[];
  membrane: number[];
  spikesLastStep: number[];
  motor: MotorOutput[];
  neuronKinds: string[];
  neuronChannels: (string | null)[];
  neuronCount: number;
}

/** The compact per-fly detail for GET /flies/:id (motor + identity + last decoded behaviour). */
export interface FlyDetail {
  vitals: FlyVitals;
  motor: MotorOutput[];
  t: number;
  step: number;
  behavior: FlyBehavior | null;
}

/** The swarm the coordinator drives each cron, however the brains are physically arranged. */
export interface SwarmBackend {
  /** True when the heavy advance is fanned out to shard DOs (vs. run in-process here). */
  readonly sharded: boolean;
  /**
   * Advance one sub-tick across the whole swarm and return the reduced snapshot. `commit` marks the
   * final sub-tick of a cron, so a sharded backend tells its shards to persist their brains then
   * (once per cron, mirroring the single-DO path) rather than on every sub-tick.
   */
  step(
    pulse: MarketPulse,
    regime: Regime,
    stimuli: StimulusEvent[],
    simSteps: number,
    commit: boolean,
  ): Promise<PopulationSnapshot>;
  getTickIndex(): number;
  getVitality(): number;
  size(): number;
  /** The ids of the CURRENTLY LIVE flies (retired/dead ids are absent). Drives the coordinator's
   *  vacant-slot allocation + live-count gate; length === size(). */
  liveIds(): number[];
  /**
   * Retire a dead fly (live-retirement): remove it from the live population and free its id/slot, so the
   * swarm holds ONLY the living. Persisted (a tombstone when sharded) so an eviction can't resurrect it.
   * Returns true when a live fly with that id was removed, false when it was already absent.
   */
  retireFly(id: number, storage: DurableObjectStorage): Promise<boolean>;
  /** Full neural snapshot of one fly (routed to its owning shard when sharded); null if unknown. */
  snapshotFly(flyId: number): Promise<FlyNeuralSnapshot | null>;
  /** Motor + identity + last behaviour of one fly; null if unknown. */
  flyDetail(flyId: number): Promise<FlyDetail | null>;
  /**
   * Hatch a bred offspring (genome) into the LIVE population at `id` (>= populationSize), persisting it
   * into `storage` so it survives an eviction. Idempotent; returns false if the fly could NOT be created
   * (e.g. a shard rejected the id), so the caller knows the live population did not grow.
   */
  hatchLiveFly(id: number, genome: Genome, storage: DurableObjectStorage): Promise<boolean>;
  /** Persist coordinator-owned swarm state into `storage` (brains persist in shards when sharded). */
  persist(storage: DurableObjectStorage): Promise<void>;
  /** Reset to a fresh founding swarm (fresh brains everywhere; shards reset too when sharded). */
  reset(storage: DurableObjectStorage): Promise<void>;
}

function clamp01(x: number): number {
  return x < 0 ? 0 : x > 1 ? 1 : x;
}

/** Build the full neural read-out of one fly for GET /snapshot. Shared by the single-DO LocalSwarm and
 *  by each shard (shard.ts) so both return an identical shape no matter where the brain physically
 *  lives — the coordinator passes it straight through to the inspector. */
export function neuralSnapshotOf(fly: AdvanceableFly): FlyNeuralSnapshot {
  const snap = fly.brain.snapshot();
  return {
    flyId: fly.id,
    seed: fly.vitals.seed,
    temperament: fly.vitals.temperament,
    t: snap.t,
    step: snap.step,
    firingRates: Array.from(snap.firingRates),
    membrane: Array.from(snap.membrane),
    spikesLastStep: Array.from(snap.spikesLastStep),
    motor: snap.motor,
    neuronKinds: fly.brain.connectome?.neurons?.map((n) => n.kind) ?? [],
    neuronChannels: fly.brain.connectome?.neurons?.map((n) => n.channel) ?? [],
    neuronCount: fly.brain.connectome?.neurons?.length ?? 0,
  };
}

/**
 * The original single-Durable-Object swarm: one Population holds every brain and runs both halves of
 * the tick in the coordinator isolate. This is the DEFAULT (SHARD_COUNT = 1) and is behaviourally
 * identical to the pre-sharding code — it simply delegates to Population and persists the same
 * population:v3 blob, so a live deployment keeps its state untouched until an operator opts in.
 */
export class LocalSwarm implements SwarmBackend {
  readonly sharded = false;
  private population: Population;

  constructor(private cfg: RuntimeConfig, population: Population) {
    this.population = population;
  }

  /** Load the persisted population (or found a fresh one) — the exact path ensurePopulation() used. */
  static async load(cfg: RuntimeConfig, storage: DurableObjectStorage): Promise<LocalSwarm> {
    const stored = await storage.get<string>(KEY_POPULATION);
    let population: Population | null = null;
    if (stored) {
      try {
        population = Population.deserialize(stored, cfg);
      } catch (e) {
        console.warn("[swarm] population deserialize failed:", (e as Error).message);
      }
    }
    return new LocalSwarm(cfg, population ?? new Population(cfg));
  }

  async step(
    pulse: MarketPulse,
    regime: Regime,
    stimuli: StimulusEvent[],
    simSteps: number,
  ): Promise<PopulationSnapshot> {
    return this.population.step(pulse, regime, stimuli, simSteps);
  }

  getTickIndex(): number { return this.population.getTickIndex(); }
  getVitality(): number { return this.population.getVitality(); }
  size(): number { return this.population.flies.length; }
  liveIds(): number[] { return this.population.flies.map((f) => f.id); }

  async retireFly(id: number, storage: DurableObjectStorage): Promise<boolean> {
    // The list-driven population stores exactly the living flies, so removing one frees its id and a
    // reload never re-adds it — a retired founder (even a genesis id) STAYS retired. No tombstone needed.
    if (!this.population.retire(id)) return false;
    await storage.put(KEY_POPULATION, this.population.serialize());
    return true;
  }

  async snapshotFly(flyId: number): Promise<FlyNeuralSnapshot | null> {
    const fly = this.population.flies.find((f) => f.id === flyId);
    return fly ? neuralSnapshotOf(fly) : null;
  }

  async flyDetail(flyId: number): Promise<FlyDetail | null> {
    const fly = this.population.flies.find((f) => f.id === flyId);
    if (!fly) return null;
    return {
      vitals: fly.vitals,
      motor: fly.brain.readAllMotor(),
      t: fly.brain.t,
      step: fly.brain.step,
      behavior: fly.lastBehavior ?? null,
    };
  }

  async hatchLiveFly(id: number, genome: Genome, storage: DurableObjectStorage): Promise<boolean> {
    // With live-retirement a hatch may land on ANY in-capacity slot, including a freed genesis id, so the
    // old `id < populationSize` genesis-refusal is relaxed to the hard cap bounds. The caller allocates only
    // VACANT ids, and spawnFromGenome is idempotent (a live fly already at `id` returns null ⇒ success).
    if (id < 0 || id >= this.cfg.maxLivePopulation) return false;
    const inst = this.population.spawnFromGenome(genome, id);
    if (!inst) return true;                       // already live — idempotent success
    await storage.put(KEY_POPULATION, this.population.serialize());
    return true;
  }

  async persist(storage: DurableObjectStorage): Promise<void> {
    await storage.put(KEY_POPULATION, this.population.serialize());
  }

  async reset(storage: DurableObjectStorage): Promise<void> {
    this.population = new Population(this.cfg);
    await storage.put(KEY_POPULATION, this.population.serialize());
  }
}

/**
 * The sharded swarm: the coordinator holds only a tiny per-fly ROSTER (id + temperament + an ephemeral
 * decoder carrying hysteresis — decoders are NOT persisted, exactly as in the single-DO Population) and
 * fans the HEAVY advance out to `shardCount` FlyShardDO isolates in parallel each sub-tick. Shards own
 * and persist their own brains; the coordinator persists the {tickIndex, vitality} counter plus the list
 * of hatched offspring (which, unlike genesis, are not derivable from config).
 */
export class ShardedSwarm implements SwarmBackend {
  readonly sharded = true;
  private roster: ReduceRosterEntry[];
  /** Hatched offspring (id >= populationSize) added to the live population. NOT derivable from config
   *  (unlike genesis), so persisted to KEY_ROSTER and recovered in load(); the reduce roster is rebuilt
   *  from it. Each entry keeps the genome so a shard that lost its state could be re-seeded if needed. */
  private bred: Array<{ id: number; seed: number; genome: Genome }> = [];
  /** Tombstoned ids: flies RETIRED on death (live-retirement). Genesis ids live here too once their founder
   *  dies, so a cold-boot roster rebuild (which otherwise re-derives genesis 0..populationSize-1 from config)
   *  never resurrects a buried founder. A recycled id is REMOVED from this set the moment a new offspring
   *  hatches back into its slot (it then lives in `bred` with a fresh genome instead). Persisted to KEY_RETIRED. */
  private retired = new Set<number>();
  private stubs: DurableObjectStub[];
  private tickIndex = 0;
  private vitality = 0.5;
  /** Last decoded behaviour per fly, so /flies/:id can show it without a shard round-trip. */
  private lastBehavior = new Map<number, FlyBehavior>();
  /** True while a layout re-seed landed only PART of the offspring (e.g. one shard's /hatch timed out). load()'s
   *  migrateLayoutIfNeeded records KEY_LAYOUT only on a FULL re-seed, so its "retry next cold boot" would fire on
   *  the next load() — but this coordinator DO is kept warm by the frontend's per-second polling and may NEVER
   *  evict, so load() never re-runs and the un-landed offspring stays a ghost forever. persist() runs on every
   *  committing cron WITH `storage` in hand, so it re-drives the (idempotent) migration until it completes and
   *  clears this flag — a warm-DO retry path that needs no eviction. */
  private migrationPending = false;

  constructor(private cfg: RuntimeConfig, private env: Env) {
    const ns = env.FLY_SHARD;
    if (!ns) throw new Error("ShardedSwarm requires the FLY_SHARD Durable Object binding");
    // GENESIS roster is fully derivable from config — no brains here, just identity + a fresh decoder per
    // fly. load() then appends any HATCHED offspring recovered from KEY_ROSTER (not derivable from config).
    this.roster = cfg.populationSeeds.slice(0, cfg.populationSize).map((seed, id) => ({
      id,
      temperament: flyTemperament(seed),
      decoder: this.makeDecoder(),
    }));
    this.stubs = Array.from({ length: cfg.shardCount }, (_, k) => ns.get(ns.idFromName(`fly-shard-${k}`)));
  }

  private makeDecoder(): MotorDecoder {
    return new MotorDecoder({ hotT: this.cfg.regimeHot, coldT: this.cfg.regimeCold });
  }

  /**
   * Load the coordinator counter. On the FIRST sharded run after a single-DO life there is no
   * coordinator:v1 yet, so inherit tickIndex from the legacy population:v3 blob — keeping the counter
   * monotonic means the EIP-3009 nonces the economy derives from it can never replay a used nonce.
   */
  static async load(cfg: RuntimeConfig, env: Env, storage: DurableObjectStorage): Promise<ShardedSwarm> {
    const swarm = new ShardedSwarm(cfg, env);
    const coord = await storage.get<{ tickIndex: number; vitality: number }>(KEY_COORDINATOR);
    if (coord) {
      swarm.tickIndex = Number(coord.tickIndex ?? 0);
      swarm.vitality = Number(coord.vitality ?? 0.5);
    } else {
      const legacy = await storage.get<string>(KEY_POPULATION);
      if (legacy) {
        try {
          const p = JSON.parse(legacy);
          swarm.tickIndex = Number(p?.tickIndex ?? 0);
          swarm.vitality = Number(p?.vitality ?? 0.5);
        } catch {
          /* no usable legacy counter — start fresh at 0 */
        }
      }
    }
    // Recover the tombstones (retired-dead ids) + any hatched offspring, then rebuild the LIVE roster so it
    // holds ONLY the living. A recycled genesis id is present in `bred` (its offspring genome) AND absent
    // from `retired`, so it re-joins as the NEW individual — not the founder that was buried in its slot.
    const retiredIds = await storage.get<number[]>(KEY_RETIRED);
    if (Array.isArray(retiredIds)) {
      swarm.retired = new Set(retiredIds.map(Number).filter((n) => Number.isInteger(n)));
    }
    const bred = await storage.get<Array<{ id: number; seed: number; genome: Genome }>>(KEY_ROSTER);
    if (Array.isArray(bred)) {
      for (const b of bred) {
        if (!b || !Number.isInteger(b.id) || b.id < 0 || b.id >= cfg.maxLivePopulation || !b.genome) continue;
        if (swarm.bred.some((x) => x.id === b.id)) continue;
        const seed = Number.isFinite(b.seed) ? b.seed : b.genome.seed;
        swarm.bred.push({ id: b.id, seed, genome: b.genome });
      }
    }
    swarm.rebuildRosterFromState();
    // ONE-TIME LAYOUT MIGRATION: a fly id's owning shard is floor(id / fliesPerShard(cap, shardCount)), so a
    // change to flies/shard (e.g. the SHARD_COUNT clamp fix 64→100 taking cap 100 from 2 flies/shard to 1)
    // REMAPS every id to a different isolate. Persisted brains do NOT follow (each shard is its own DO
    // storage), so without this the live offspring in `bred` would wake as ghosts — roster-present, brain
    // absent (reduceReadOuts then feeds them zero drives). Genesis ids self-heal (a shard rebuilds them from
    // the config seed), but offspring genomes live ONLY in KEY_ROSTER, so re-ship them to their new shards via
    // the idempotent /hatch. Guarded by the stored signature, so it fires only on an actual flies/shard change.
    await swarm.migrateLayoutIfNeeded(storage);
    return swarm;
  }

  /**
   * Recompose the reduce roster from the coordinator's own truth (config genesis + persisted bred − tombstones),
   * so a cold boot that re-derived a full genesis roster in the constructor drops every retired founder and
   * swaps a recycled slot for its offspring. Used on load; decoders are legitimately fresh at startup.
   */
  private rebuildRosterFromState(): void {
    const byId = new Map<number, number>();   // id → seed (temperament source)
    for (let id = 0; id < this.cfg.populationSize; id++) byId.set(id, this.cfg.populationSeeds[id]);
    for (const b of this.bred) byId.set(b.id, b.seed);   // hatched/recycled overrides genesis at that id
    const roster: ReduceRosterEntry[] = [];
    for (const [id, seed] of byId) {
      if (this.retired.has(id)) continue;                 // a retired-and-not-recycled fly is NOT live
      roster.push({ id, temperament: flyTemperament(seed), decoder: this.makeDecoder() });
    }
    roster.sort((a, b) => a.id - b.id);
    this.roster = roster;
  }

  /**
   * The current shard-layout signature. `per` (flies/shard) is the ONLY value that decides an id's owning
   * shard — shardOf = floor(id / per) — so it alone identifies the mapping the persisted brains were seeded
   * under. shardCount/cap ride along purely for a readable log/diagnostic.
   */
  private layoutSignature(): { per: number; shardCount: number; cap: number } {
    return {
      per: fliesPerShard(this.cfg.maxLivePopulation, this.cfg.shardCount),
      shardCount: this.cfg.shardCount,
      cap: this.cfg.maxLivePopulation,
    };
  }

  /**
   * One-time re-seed when the shard layout changed under the persisted brains (called from load()). If the
   * stored signature's `per` differs from the current one (or nothing is stored yet — the first run of this
   * code on a live deployment), re-ship every live offspring's genome to the shard that owns its id NOW, then
   * record the layout so it never re-runs. Genesis ids are deliberately NOT re-seeded: each shard rebuilds
   * them deterministically from the config seed on its next /advance. Non-fatal by construction — the layout
   * is recorded ONLY when every offspring re-seed confirmed, so a partial failure retries on the next cold
   * boot (and /hatch idempotency makes a retry touch only the offspring that didn't land).
   */
  private async migrateLayoutIfNeeded(storage: DurableObjectStorage): Promise<void> {
    const now = this.layoutSignature();
    let stored: { per?: number } | undefined;
    try {
      stored = await storage.get<{ per?: number }>(KEY_LAYOUT);
    } catch (e) {
      console.warn("[swarm] layout read failed (treating layout as changed):", (e as Error).message);
    }
    if (stored && Number(stored.per) === now.per) return;   // same flies/shard ⇒ same id→shard map ⇒ nothing to do
    // No offspring brains to orphan: record nothing. (hatchLiveFly always ships a new genome to the shard
    // derived from the CURRENT config, so a future hatch lands correctly without a stored baseline.)
    if (this.bred.length === 0) return;
    const t0 = Date.now();
    let ok = 0;
    try {
      ok = await this.reseedOffspring();
    } catch (e) {
      console.error("[swarm] layout re-seed threw (offspring stay ghosts until the next cold boot):", (e as Error).message);
    }
    if (ok === this.bred.length) {
      await storage.put(KEY_LAYOUT, now);
      this.migrationPending = false;
      console.log(
        `[swarm] layout migration complete: flies/shard ${stored?.per ?? "none"}→${now.per}, ` +
          `re-seeded ${ok}/${this.bred.length} offspring in ${Date.now() - t0}ms`,
      );
    } else {
      // Flag it so persist() re-drives the re-seed on the next committing cron — the coordinator may never evict
      // (the frontend polls it every second), so a cold-boot-only retry could strand the missing offspring forever.
      this.migrationPending = true;
      console.error(
        `[swarm] layout migration INCOMPLETE: re-seeded ${ok}/${this.bred.length} offspring; ` +
          `NOT recording layout, will retry on the next cron persist (/hatch is idempotent)`,
      );
    }
  }

  /**
   * Re-ship every live offspring's genome to the shard that owns its id under the CURRENT layout, via the
   * idempotent /hatch (a shard that already hosts the id returns already:true — a no-op). Fired in parallel:
   * the runtime QUEUES subrequests beyond the 6th (the same proven pattern as step()'s fan-out), each bounded
   * by SHARD_IO_TIMEOUT_MS and each failure isolated, so one wedged shard can't abort the rest. Returns how
   * many confirmed (ok or already), which migrateLayoutIfNeeded compares against bred.length.
   */
  private async reseedOffspring(): Promise<number> {
    const results = await Promise.all(
      this.bred.map(async (b) => {
        const stub = this.stubs[shardOf(this.cfg.maxLivePopulation, this.cfg.shardCount, b.id)];
        if (!stub) return false;
        try {
          const r = await stub.fetch(
            new Request("https://shard.internal/hatch", {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ id: b.id, genome: b.genome }),
              signal: AbortSignal.timeout(SHARD_IO_TIMEOUT_MS),
            }),
          );
          if (!r.ok) {
            console.warn(`[swarm] re-seed #${b.id} rejected: HTTP ${r.status}`);
            return false;
          }
          return true;
        } catch (e) {
          console.warn(`[swarm] re-seed #${b.id} failed (will retry next boot):`, (e as Error).message);
          return false;
        }
      }),
    );
    return results.filter(Boolean).length;
  }

  size(): number { return this.roster.length; }
  getTickIndex(): number { return this.tickIndex; }
  getVitality(): number { return clamp01(this.vitality); }
  liveIds(): number[] { return this.roster.map((r) => r.id); }

  /**
   * Retire a dead fly from the SHARDED swarm: drop it from the reduce roster + the bred list, tombstone its
   * id (so a cold boot never re-derives it from the config genesis roster), tell the owning shard to delete
   * its brain + tombstone it there, then persist the roster + tombstone immediately (an eviction can't
   * un-retire it). Idempotent: a unknown/already-retired id is a no-op returning false.
   */
  async retireFly(id: number, storage: DurableObjectStorage): Promise<boolean> {
    if (this.retired.has(id)) return false;
    const ri = this.roster.findIndex((r) => r.id === id);
    if (ri < 0) return false;                 // not currently live — nothing to retire
    this.roster.splice(ri, 1);
    this.bred = this.bred.filter((b) => b.id !== id);
    this.lastBehavior.delete(id);
    this.retired.add(id);
    // Tell the shard that owns this id (derived from the STABLE cap) to drop the brain and tombstone it.
    const stub = this.stubs[shardOf(this.cfg.maxLivePopulation, this.cfg.shardCount, id)];
    if (stub) {
      try {
        await stub.fetch(new Request("https://shard.internal/retire", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ id }),
          signal: AbortSignal.timeout(SHARD_IO_TIMEOUT_MS),
        }));
      } catch (e) {
        console.warn(`[swarm] shard retire #${id} failed (coordinator roster already updated):`, (e as Error).message);
      }
    }
    await storage.put(KEY_ROSTER, this.bred);
    await storage.put(KEY_RETIRED, Array.from(this.retired).sort((a, b) => a - b));
    return true;
  }

  async step(
    pulse: MarketPulse,
    regime: Regime,
    stimuli: StimulusEvent[],
    simSteps: number,
    commit: boolean,
  ): Promise<PopulationSnapshot> {
    this.tickIndex++;
    // Fan the HEAVY advance out to every shard IN PARALLEL — each runs in its own isolate with its own
    // 128 MB + CPU budget, which is the whole point. Only the compact read-outs come back.
    //
    // NOTE on the fan-out width: a Worker invocation may have at most 6 subrequests simultaneously
    // "waiting for response headers", but Cloudflare QUEUES (never rejects) any beyond the 6th until a
    // slot frees. So firing all `shardCount` fetches at once is safe for any shard count — the runtime
    // runs them in ~ceil(N/6) transparent waves. Each shard /advance is its OWN DO invocation, so it gets
    // a fresh 30 s CPU budget and only integrates ONE sub-tick (simSteps), not the whole cron — which is
    // why sharding also lifts the single-isolate CPU ceiling, not just the 128 MB memory one.
    const body = JSON.stringify({ pulse, stimuli, simSteps, persist: commit });
    // One misbehaving shard (e.g. its storage write timing out and the DO resetting) must NOT abort the
    // whole cron: a rejected Promise.all here would skip the coordinator's persist() and freeze lastCron.
    // So each shard gets ONE bounded retry, then degrades to "no read-outs this sub-tick" — that shard's
    // flies simply hold still for this cron and catch up on the next, instead of stalling the clock.
    const advanceOne = async (stub: (typeof this.stubs)[number], k: number): Promise<{ readOuts: FlyReadOut[] }> => {
      for (let attempt = 0; ; attempt++) {
        try {
          const r = await stub.fetch(
            new Request("https://shard.internal/advance", {
              method: "POST",
              headers: { "content-type": "application/json" },
              body,
              // The ceiling that keeps a wedged shard from hanging the cron forever (see ADVANCE_TIMEOUT_MS).
              signal: AbortSignal.timeout(ADVANCE_TIMEOUT_MS),
            }),
          );
          if (!r.ok) throw new Error(`shard advance failed: HTTP ${r.status}`);
          return (await r.json()) as { readOuts: FlyReadOut[] };
        } catch (e) {
          // A timeout means the shard is saturated, not briefly glitching — do NOT burn a second window
          // retrying it this sub-tick; degrade immediately so 6 sub-ticks stay inside the 60s cadence. Any
          // other error (e.g. a one-off storage reset) still gets the single retry the old design intended.
          const timedOut = (e as Error)?.name === "TimeoutError" || (e as Error)?.name === "AbortError";
          if (attempt === 0 && !timedOut) continue;
          console.warn(`[swarm] shard ${k} advance ${timedOut ? "timed out" : "failed twice"}; skipping its read-outs this sub-tick:`, (e as Error).message);
          return { readOuts: [] };
        }
      }
    };
    const results = await Promise.all(this.stubs.map((stub, k) => advanceOne(stub, k)));
    const readOuts: FlyReadOut[] = [];
    for (const res of results) readOuts.push(...res.readOuts);

    // LIGHT global reduce here in the coordinator (the population bands need every fly at once).
    const { readings, collective, behaviors, vitality } = reduceReadOuts(readOuts, this.roster, {
      pulse,
      regime,
      vitality: this.vitality,
    });
    this.lastBehavior.clear();
    for (let i = 0; i < this.roster.length; i++) this.lastBehavior.set(this.roster[i].id, behaviors[i]);
    this.vitality = vitality;

    return { tickIndex: this.tickIndex, collective, flies: readings };
  }

  async snapshotFly(flyId: number): Promise<FlyNeuralSnapshot | null> {
    const stub = this.stubs[shardOf(this.cfg.maxLivePopulation, this.cfg.shardCount, flyId)];
    try {
      const r = await stub.fetch(new Request(`https://shard.internal/snapshot?flyId=${flyId}`, {
        signal: AbortSignal.timeout(SHARD_IO_TIMEOUT_MS),
      }));
      return r.ok ? ((await r.json()) as FlyNeuralSnapshot) : null;
    } catch (e) {
      console.warn(`[swarm] shard snapshot #${flyId} failed (read degrades to null):`, (e as Error).message);
      return null;
    }
  }

  async flyDetail(flyId: number): Promise<FlyDetail | null> {
    const stub = this.stubs[shardOf(this.cfg.maxLivePopulation, this.cfg.shardCount, flyId)];
    try {
      const r = await stub.fetch(new Request(`https://shard.internal/fly?flyId=${flyId}`, {
        signal: AbortSignal.timeout(SHARD_IO_TIMEOUT_MS),
      }));
      if (!r.ok) return null;
      const d = (await r.json()) as { vitals: FlyVitals; motor: MotorOutput[]; t: number; step: number };
      return { vitals: d.vitals, motor: d.motor, t: d.t, step: d.step, behavior: this.lastBehavior.get(flyId) ?? null };
    } catch (e) {
      console.warn(`[swarm] shard flyDetail #${flyId} failed (read degrades to null):`, (e as Error).message);
      return null;
    }
  }

  async hatchLiveFly(id: number, genome: Genome, storage: DurableObjectStorage): Promise<boolean> {
    // Any in-capacity slot may receive a hatch once the dead retire — INCLUDING a freed genesis id reused by
    // a new offspring (which is why the old `id < populationSize` genesis-refusal is gone). The caller only
    // allocates VACANT ids; a still-live fly at `id` is left untouched (idempotent), and a retired id being
    // reclaimed is lifted from the tombstone so a cold boot keeps the NEW individual, not the buried founder.
    if (id < 0 || id >= this.cfg.maxLivePopulation) return false;
    if (this.roster.some((r) => r.id === id)) return true;        // already live — idempotent success
    // Ship the genome to the shard that owns this id (derived from the STABLE cap, so it never moves); the
    // shard builds + persists the brain. Only grow the roster once the shard confirms it hosts the fly.
    const stub = this.stubs[shardOf(this.cfg.maxLivePopulation, this.cfg.shardCount, id)];
    if (!stub) return false;
    let r: Response;
    try {
      r = await stub.fetch(
        new Request("https://shard.internal/hatch", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ id, genome }),
          signal: AbortSignal.timeout(SHARD_IO_TIMEOUT_MS),
        }),
      );
    } catch (e) {
      console.warn(`[swarm] shard hatch #${id} failed (child stays absent, may retry):`, (e as Error).message);
      return false;
    }
    if (!r.ok) return false;
    this.bred.push({ id, seed: genome.seed, genome });
    this.roster.push({ id, temperament: flyTemperament(genome.seed), decoder: this.makeDecoder() });
    this.roster.sort((a, b) => a.id - b.id);
    this.retired.delete(id);   // reclaiming a retired slot: the offspring is live, lift its tombstone
    await storage.put(KEY_ROSTER, this.bred);   // persist immediately so an eviction can't drop the new live fly
    await storage.put(KEY_RETIRED, Array.from(this.retired).sort((a, b) => a - b));
    return true;
  }

  async persist(storage: DurableObjectStorage): Promise<void> {
    // Warm-DO retry for a PARTIAL layout migration (see migrationPending): a coordinator kept hot by the
    // frontend's polling never evicts, so load()'s migrateLayoutIfNeeded — and its "retry next cold boot" —
    // would never re-run, stranding any offspring whose /hatch timed out as a permanent ghost. persist() runs
    // every committing cron with `storage`, so re-drive the idempotent migration here until it fully lands and
    // clears the flag; once KEY_LAYOUT is recorded the re-seed short-circuits and this is a no-op.
    if (this.migrationPending) await this.migrateLayoutIfNeeded(storage);
    // Brains already persisted inside the shards on the commit sub-tick; the counter AND the hatched-offspring
    // roster (not derivable from config) live here, alongside the retired-id tombstone.
    await storage.put(KEY_COORDINATOR, { tickIndex: this.tickIndex, vitality: this.vitality });
    await storage.put(KEY_ROSTER, this.bred);
    await storage.put(KEY_RETIRED, Array.from(this.retired).sort((a, b) => a - b));
  }

  async reset(storage: DurableObjectStorage): Promise<void> {
    this.tickIndex = 0;
    this.vitality = 0.5;
    this.lastBehavior.clear();
    // Reset returns the swarm to its FOUNDING state: drop every hatched offspring AND every tombstone (the
    // shards wipe theirs too) and rebuild the genesis-only roster from config, then persist the cleared lists.
    this.bred = [];
    this.retired = new Set();
    this.roster = this.cfg.populationSeeds.slice(0, this.cfg.populationSize).map((seed, id) => ({
      id,
      temperament: flyTemperament(seed),
      decoder: this.makeDecoder(),
    }));
    await Promise.all(
      this.stubs.map((stub) =>
        stub.fetch(new Request("https://shard.internal/reset", {
          method: "POST",
          signal: AbortSignal.timeout(SHARD_IO_TIMEOUT_MS),
        })).catch((e) => console.warn("[swarm] shard reset failed on one shard (continuing):", (e as Error).message)),
      ),
    );
    await this.persist(storage);
  }
}
