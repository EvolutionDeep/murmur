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
  type MarketPulse,
  type MotorOutput,
  type StimulusEvent,
} from "@fly/fly-brain";
import type { Env, RuntimeConfig } from "./config.js";
import { shardOf } from "./config.js";
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

/** Coordinator-side storage keys owned by the swarm layer. */
export const KEY_POPULATION = "population:v3";   // LocalSwarm: the whole single-DO Population.serialize()
export const KEY_COORDINATOR = "coordinator:v1"; // ShardedSwarm: the {tickIndex, vitality} counter (brains live in shards)

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
  /** Full neural snapshot of one fly (routed to its owning shard when sharded); null if unknown. */
  snapshotFly(flyId: number): Promise<FlyNeuralSnapshot | null>;
  /** Motor + identity + last behaviour of one fly; null if unknown. */
  flyDetail(flyId: number): Promise<FlyDetail | null>;
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
 * and persist their own brains; the coordinator persists just the {tickIndex, vitality} counter.
 */
export class ShardedSwarm implements SwarmBackend {
  readonly sharded = true;
  private roster: ReduceRosterEntry[];
  private stubs: DurableObjectStub[];
  private tickIndex = 0;
  private vitality = 0.5;
  /** Last decoded behaviour per fly, so /flies/:id can show it without a shard round-trip. */
  private lastBehavior = new Map<number, FlyBehavior>();

  constructor(private cfg: RuntimeConfig, private env: Env) {
    const ns = env.FLY_SHARD;
    if (!ns) throw new Error("ShardedSwarm requires the FLY_SHARD Durable Object binding");
    // Roster is fully derivable from config — no brains here, just identity + a fresh decoder per fly.
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
    return swarm;
  }

  size(): number { return this.roster.length; }
  getTickIndex(): number { return this.tickIndex; }
  getVitality(): number { return clamp01(this.vitality); }

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
    const results = await Promise.all(
      this.stubs.map((stub) =>
        stub
          .fetch(
            new Request("https://shard.internal/advance", {
              method: "POST",
              headers: { "content-type": "application/json" },
              body,
            }),
          )
          .then(async (r) => {
            if (!r.ok) throw new Error(`shard advance failed: HTTP ${r.status}`);
            return (await r.json()) as { readOuts: FlyReadOut[] };
          }),
      ),
    );
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
    const stub = this.stubs[shardOf(this.cfg.populationSize, this.cfg.shardCount, flyId)];
    const r = await stub.fetch(new Request(`https://shard.internal/snapshot?flyId=${flyId}`));
    return r.ok ? ((await r.json()) as FlyNeuralSnapshot) : null;
  }

  async flyDetail(flyId: number): Promise<FlyDetail | null> {
    const stub = this.stubs[shardOf(this.cfg.populationSize, this.cfg.shardCount, flyId)];
    const r = await stub.fetch(new Request(`https://shard.internal/fly?flyId=${flyId}`));
    if (!r.ok) return null;
    const d = (await r.json()) as { vitals: FlyVitals; motor: MotorOutput[]; t: number; step: number };
    return { vitals: d.vitals, motor: d.motor, t: d.t, step: d.step, behavior: this.lastBehavior.get(flyId) ?? null };
  }

  async persist(storage: DurableObjectStorage): Promise<void> {
    // Brains already persisted inside the shards on the commit sub-tick; only the counter lives here.
    await storage.put(KEY_COORDINATOR, { tickIndex: this.tickIndex, vitality: this.vitality });
  }

  async reset(storage: DurableObjectStorage): Promise<void> {
    this.tickIndex = 0;
    this.vitality = 0.5;
    this.lastBehavior.clear();
    for (const entry of this.roster) entry.decoder = this.makeDecoder();
    await Promise.all(
      this.stubs.map((stub) => stub.fetch(new Request("https://shard.internal/reset", { method: "POST" }))),
    );
    await this.persist(storage);
  }
}
