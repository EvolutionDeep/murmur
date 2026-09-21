// Population — a swarm of fruit-fly brains that FEEL the Arc market and react, both collectively
// and individually. Nothing here trades, holds a wallet or touches a private key.
//
// This is a PURELY REACTIVE population: a set of flies, each an independent connectome grown from its
// own seed (its "temperament"). It does NOT breed, age or retire on its own — but it CAN GROW: the
// evolution layer (state.ts driveEvolution) may hatch a bred offspring into a new live fly via
// spawnFromGenome, expanding the population from the fixed genesis 24 toward maxLivePopulation. That
// growth is driven entirely from outside; the population itself only persists and reacts. Per tick:
//   1. Every fly receives the SAME market pulse (temperature + its facets) through its sensory
//      channels, plus its own stable internal arousal ("temperament") so individuals keep a tempo.
//   2. Every fly advances its spiking network independently for `simSteps` ms.
//   3. We read each fly's motor output, then compute the POPULATION bands (how the whole swarm is
//      doing right now) and decode each fly RELATIVE to its peers. This is what makes the reaction
//      two-layered: the market temperature sets the collective regime (HOT → agitated & scattered,
//      COLD → huddled & still, CALM → drifting), while each fly's own wiring decides how strongly it
//      expresses that regime and whether it breaks rank (an explorer in a hot swarm, a sleeper in a
//      cold one). See fly-brain/motor-decoder.ts for the calibrated mapping.
//   4. The result is a snapshot of per-fly drives (for the generative frontend) + a collective mood.
//
// The population state (every fly's brain) persists across restarts via serialize/deserialize so the
// swarm keeps its learned dynamics rather than resetting each isolate eviction.

import {
  FlyBrain,
  MotorDecoder,
  encodeMarketPulse,
  encodeStimulus,
  readRawDrives,
  computeBands,
  type MarketPulse,
  type StimulusEvent,
  type SensoryInput,
  type MotorOutput,
  type RawDrives,
  type FlyBehavior,
  type BehaviorState,
  type Fap,
  type Bout,
  type ConnectomeOptions,
  type Genome,
  genomeToConnectomeOptions,
} from "@fly/fly-brain";
import type { RuntimeConfig } from "./config.js";
import type { Regime } from "./market.js";

/** Persistent per-fly identity: a seed and the stable temperament derived from it. No lineage. */
export interface FlyVitals {
  id: number;
  seed: number;
  /** Stable per-fly internal arousal 0..1 (drawn from the seed → individual tempo). */
  temperament: number;
  /**
   * Present ONLY on a hatched offspring (id >= populationSize): the bred genome its brain was built from.
   * Genesis flies have none — their brain is reproducible from (seed, brainOpts) alone. Persisted so a
   * restored population rebuilds a bred brain from its genome (not the genesis sizing), and served so the
   * inspector can show an offspring's heritable identity.
   */
  genome?: Genome;
}

export interface FlyInstance {
  id: number;
  brain: FlyBrain;
  decoder: MotorDecoder;
  vitals: FlyVitals;
  lastBehavior?: FlyBehavior;
}

/** One fly's projected reading for the frontend (the scalar drives; raw motor stays server-side). */
export interface FlyReading {
  id: number;
  state: BehaviorState;
  arousal: number;                // 0..1 → movement speed & visual pulse amplitude
  turnBias: number;               // −1..1 → wander / turn direction
  cohesion: number;               // 0..1 → pull toward the swarm centre
  wingbeat: number;               // 0..1 → visual pulse frequency
  rest: number;                   // 0..1 → stillness
  temperament: number;            // 0..1 → the fly's stable personality (for colour identity)
  fingerprint: string;            // neural fingerprint hash (per-fly identity)
  /** --- Ethogram enrichment (read-out only; never a settlement input) --- */
  fap: Fap;                       // named fixed action pattern (richer than `state`)
  valence: number;                // −1..1 appetitive − aversive (approach/avoid conflict)
  heading: number;                // 0..2π persistent ring-attractor head direction
  role: string;                   // observable economic role implied by `fap`
  bouts: Bout[];                  // recent behaviour sequence (oldest → newest), capped
}

/** The swarm's shared mood this tick (collective response to the market regime). */
export interface CollectiveState {
  temperature: number;            // 0..1 the instantaneous market temperature
  regime: Regime;                 // HOT | CALM | COLD (from the MarketMeter)
  vitality: number;               // 0..1 slow EWMA of temperature — the population's long-run mood
  size: number;                   // number of flies
  arousal: number;                // mean per-fly arousal
  cohesion: number;               // mean per-fly cohesion
  rest: number;                   // mean per-fly rest
  wingbeat: number;               // mean per-fly wingbeat
  states: Record<BehaviorState, number>;   // how many flies are in each behavioural state
  /** How many flies express each fixed action pattern this tick (ethogram distribution; loose keys). */
  faps: Record<string, number>;
  /** Mean appetitive−aversive valence across the swarm, −1..1 (the collective approach/avoid mood). */
  valence: number;
}

export interface PopulationSnapshot {
  tickIndex: number;
  collective: CollectiveState;
  flies: FlyReading[];
}

/** The minimal per-fly structure the HEAVY advance needs: a brain to drive plus the identity that
 *  seeds its internal arousal. No decoder — behaviour decoding is a GLOBAL reduce that runs in the
 *  coordinator (it needs every fly's read-out to compute the population bands). FlyInstance satisfies
 *  this structurally, so Population.advanceRead() hands its own flies straight in. */
export interface AdvanceableFly {
  id: number;
  brain: FlyBrain;
  vitals: FlyVitals;
}

/** One fly's compact post-advance read-out: everything the coordinator needs to compute the global
 *  bands and decode this fly, WITHOUT holding its heavy neural state. Deliberately independent of the
 *  neuron count (a fixed handful of per-channel floats), so it is cheap to ship across a Durable Object
 *  RPC boundary — which is the whole point of sharding the swarm across isolates. */
export interface FlyReadOut {
  id: number;
  motor: MotorOutput[];
  sensory: SensoryInput[];
  /** The brain's simulation clock (ms) at read time — feeds the neural fingerprint. */
  t: number;
}

/** The per-fly coordinator-side state the reduce needs alongside each read-out: identity, the stable
 *  temperament (frontend colour/reading) and the decoder carrying this fly's behavioural hysteresis. */
export interface ReduceRosterEntry {
  id: number;
  temperament: number;
  decoder: MotorDecoder;
}

export interface ReduceContext {
  pulse: MarketPulse;
  regime: Regime;
  /** Incoming slow-EWMA "vitality" carrier (raw, unclamped) — eased toward this tick's temperature. */
  vitality: number;
}

export interface ReduceOutput {
  readings: FlyReading[];
  collective: CollectiveState;
  /** Aligned with `roster` — each fly's decoded behaviour, so the caller can stash it as lastBehavior. */
  behaviors: FlyBehavior[];
  /** Updated RAW vitality carrier (clamped only when published/read). */
  vitality: number;
}

const EMPTY_STATES = (): Record<BehaviorState, number> => ({
  AGITATE: 0,
  EXPLORE: 0,
  AGGREGATE: 0,
  REST: 0,
});

export class Population {
  readonly flies: FlyInstance[] = [];
  private cfg: RuntimeConfig;
  /** Connectome sizing applied to every FlyBrain (spawn / restore) */
  private brainOpts: ConnectomeOptions;
  private tickIndex = 0;
  /** Slow EWMA of the market temperature — a "vitality" the whole population carries. */
  private vitality: number;
  private lastSnapshot: PopulationSnapshot | null = null;

  constructor(
    cfg: RuntimeConfig,
    restored?: { flies: FlyVitals[]; brains: string[]; tickIndex: number; vitality: number },
  ) {
    this.cfg = cfg;
    this.brainOpts = cfg.brainOpts ?? {};
    this.vitality = restored?.vitality ?? 0.5;
    if (restored) {
      for (let i = 0; i < restored.flies.length; i++) {
        const vitals = restored.flies[i];
        // A hatched offspring rebuilds from its OWN genome; a genesis fly from (seed, shared brainOpts).
        const opts = vitals.genome
          ? genomeToConnectomeOptions(vitals.genome)
          : { seed: vitals.seed, ...this.brainOpts };
        const brain = restored.brains[i]
          ? FlyBrain.deserialize(restored.brains[i], opts)
          : new FlyBrain(opts);
        this.flies.push({ id: vitals.id, brain, decoder: this.makeDecoder(), vitals });
      }
      this.tickIndex = restored.tickIndex;
    } else {
      for (let i = 0; i < cfg.populationSize; i++) {
        this.spawnFly(cfg.populationSeeds[i], i);
      }
    }
  }

  /** The decoder's regime anchor tracks the SAME hot/cold thresholds the MarketMeter uses. */
  private makeDecoder(): MotorDecoder {
    return new MotorDecoder({ hotT: this.cfg.regimeHot, coldT: this.cfg.regimeCold });
  }

  /** A stable temperament in 0.2..0.8 drawn from the seed (so it survives restarts). */
  private temperamentOf(seed: number): number {
    return flyTemperament(seed);
  }

  private spawnFly(seed: number, id: number): FlyInstance {
    const brain = new FlyBrain({ seed, ...this.brainOpts });
    const vitals: FlyVitals = { id, seed, temperament: this.temperamentOf(seed) };
    const inst: FlyInstance = { id, brain, decoder: this.makeDecoder(), vitals };
    this.flies.push(inst);
    return inst;
  }

  /**
   * Hatch a BRED offspring into a live fly: build its brain from its OWN genome (not the genesis sizing)
   * and append it at the caller-assigned id (>= populationSize). Idempotent — a duplicate id is ignored.
   * This is how the live trading population grows past the fixed genesis 24 toward maxLivePopulation.
   */
  spawnFromGenome(genome: Genome, id: number): FlyInstance | null {
    if (this.flies.some((f) => f.id === id)) return null;
    const brain = new FlyBrain(genomeToConnectomeOptions(genome));
    const vitals: FlyVitals = { id, seed: genome.seed, temperament: flyTemperament(genome.seed), genome };
    const inst: FlyInstance = { id, brain, decoder: this.makeDecoder(), vitals };
    this.flies.push(inst);
    return inst;
  }

  /**
   * LIVE-RETIREMENT: remove a dead fly from the population, freeing its id/slot. Returns true when a fly
   * with that id was present and dropped. The serialiser is LIST-driven (it stores exactly the living flies,
   * in `id` order, no index==id assumption) and `deserialize` never re-derives a genesis roster, so a retired
   * founder STAYS retired across an eviction. The vacated id is then reused by the next hatch.
   */
  retire(id: number): boolean {
    const i = this.flies.findIndex((f) => f.id === id);
    if (i < 0) return false;
    this.flies.splice(i, 1);
    // Purge it from the cached snapshot so a stale read-out (before the next step) never shows the retired fly.
    if (this.lastSnapshot) this.lastSnapshot.flies = this.lastSnapshot.flies.filter((r) => r.id !== id);
    return true;
  }

  /**
   * Advance one tick: drive every fly with the shared market pulse (+ any visitor stimuli), then
   * decode each fly RELATIVE to the population so the reaction is collective + individual.
   *
   * Split into the two halves that sharding separates across isolates: advanceRead() is the HEAVY,
   * per-fly, cross-fly-independent LIF integration; reduceReadOuts() is the LIGHT global reduce that
   * must see every fly at once. In the single-DO configuration both run here, in-process, exactly as
   * before — the split is what lets a sharded coordinator run the reduce while the shards run advance.
   */
  step(
    pulse: MarketPulse,
    regime: Regime,
    stimuli: StimulusEvent[],
    simSteps: number,
  ): PopulationSnapshot {
    this.tickIndex++;

    // 1) HEAVY: drive + advance every fly's spiking net, collecting the compact read-outs.
    const readOuts = this.advanceRead(pulse, stimuli, simSteps);

    // 2) LIGHT: the global reduce — population bands → per-fly decode → collective mood.
    const roster: ReduceRosterEntry[] = this.flies.map((f) => ({
      id: f.id,
      temperament: f.vitals.temperament,
      decoder: f.decoder,
    }));
    const { readings, collective, behaviors, vitality } = reduceReadOuts(readOuts, roster, {
      pulse,
      regime,
      vitality: this.vitality,
    });
    for (let i = 0; i < this.flies.length; i++) this.flies[i].lastBehavior = behaviors[i];
    this.vitality = vitality;

    this.lastSnapshot = { tickIndex: this.tickIndex, collective, flies: readings };
    return this.lastSnapshot;
  }

  /** HEAVY half of a tick for this (single-isolate) population: drive + advance every fly's net. */
  advanceRead(pulse: MarketPulse, stimuli: StimulusEvent[], simSteps: number): FlyReadOut[] {
    return advanceFlies(this.flies, pulse, stimuli, simSteps);
  }

  getTickIndex(): number { return this.tickIndex; }
  getVitality(): number { return clamp01(this.vitality); }
  getLastSnapshot(): PopulationSnapshot | null { return this.lastSnapshot; }

  /** Serialise for persistence into the Durable Object. */
  serialize(): string {
    return JSON.stringify({
      // v6 = the roster may now contain HOLES / recycled genesis ids after live-retirement (a dead fly is
      // removed and its id later reused by an offspring); the LIST-driven shape already encodes this
      // (exactly the living flies, ascending). v5 = reactive population that MAY carry hatched offspring
      // (vitals.genome); v4 was genesis-only (v1–v3 carried the old lineage/generations — dropped).
      version: 6,
      tickIndex: this.tickIndex,
      vitality: this.vitality,
      flies: this.flies.map((f) => ({ vitals: f.vitals, brain: f.brain.serialize() })),
    });
  }

  static deserialize(data: string, cfg: RuntimeConfig): Population {
    const parsed = JSON.parse(data);
    const version = parsed?.version;
    // v6 (holes/recycled ids) and v5 (may carry hatched offspring genomes) are native; v4 is genesis-only;
    // v3 is tolerated by stripping the old lineage fields (id/seed/temperament survive). A fly with no genome
    // rebuilds as genesis. The reader is LIST-driven, so a sparser post-retirement roster restores verbatim.
    if (version === 6 || version === 5 || version === 4 || version === 3) {
      return new Population(cfg, {
        flies: parsed.flies.map((x: any) => ({
          id: Number(x.vitals.id),
          seed: Number(x.vitals.seed),
          temperament: Number(x.vitals.temperament ?? 0.5),
          ...(x.vitals.genome ? { genome: x.vitals.genome as Genome } : {}),
        })),
        brains: parsed.flies.map((x: any) => x.brain),
        tickIndex: Number(parsed.tickIndex ?? 0),
        vitality: Number(parsed.vitality ?? 0.5),
      });
    }
    throw new Error("unsupported population serialization version");
  }
}

/** A stable per-fly temperament in 0.2..0.8 drawn from the seed (survives restarts). Exported so the
 *  sharded coordinator and each shard derive the SAME temperament the single-DO Population does. */
export function flyTemperament(seed: number): number {
  return (((seed >>> 5) % 1000) / 1000) * 0.6 + 0.2;
}

/**
 * HEAVY half of a tick: drive every fly with the shared market pulse (+ its own stable internal
 * arousal, + any visitor stimuli landed as a short perturbation on the first chunks) and advance its
 * spiking net for `simSteps` ms, returning the compact motor/sensory read-out per fly. Touches NO
 * cross-fly state, so it behaves identically whether the flies live in one isolate (Population) or are
 * fanned out across shard Durable Objects — which is exactly why the tick splits cleanly along it.
 */
export function advanceFlies(
  flies: AdvanceableFly[],
  pulse: MarketPulse,
  stimuli: StimulusEvent[],
  simSteps: number,
): FlyReadOut[] {
  const out: FlyReadOut[] = [];
  for (const fly of flies) {
    // Per-fly internal arousal gives each individual its own tempo on top of the shared pulse.
    const sensory = encodeMarketPulse({ ...pulse, arousal: fly.vitals.temperament });
    const chunkSize = 50;
    const chunks = Math.max(1, Math.ceil(simSteps / chunkSize));
    for (let c = 0; c < chunks; c++) {
      for (const s of sensory) fly.brain.inject(s);
      // Visitor stimuli land as a short perturbation at the start of the tick.
      if (c < 3) for (const st of stimuli) fly.brain.inject(encodeStimulus(st));
      fly.brain.advance(Math.min(chunkSize, simSteps - c * chunkSize));
    }
    out.push({ id: fly.id, motor: fly.brain.readAllMotor(), sensory, t: fly.brain.t });
  }
  return out;
}

/**
 * LIGHT half of a tick: given every fly's read-out, compute the population bands, decode each fly
 * RELATIVE to its peers, and aggregate the collective mood + per-fly readings. This is the global
 * reduce that MUST see the whole swarm at once, so it always runs in the coordinator — a shard only
 * ever produces read-outs. Read-outs are aligned to the roster BY ID (shards return contiguous
 * ascending slices; the map is cheap insurance that a reorder can never mis-assign a decoder).
 */
export function reduceReadOuts(
  readOuts: FlyReadOut[],
  roster: ReduceRosterEntry[],
  ctx: ReduceContext,
): ReduceOutput {
  const byId = new Map<number, FlyReadOut>();
  for (const r of readOuts) byId.set(r.id, r);

  // 1) Population bands from every fly's raw drives (robust 10–90 percentiles + max |turn|).
  const raws: RawDrives[] = roster.map((entry) => {
    const r = byId.get(entry.id);
    return r ? readRawDrives(r.motor) : { arousal: 0, turn: 0, cohesion: 0, rest: 0 };
  });
  const bands = computeBands(raws);

  // 2) Decode every fly against the bands; aggregate the collective mood.
  const readings: FlyReading[] = [];
  const behaviors: FlyBehavior[] = [];
  const states = EMPTY_STATES();
  const faps: Record<string, number> = {};
  let sumAro = 0, sumCoh = 0, sumRest = 0, sumWing = 0, sumVal = 0;
  for (const entry of roster) {
    const r = byId.get(entry.id);
    const b = entry.decoder.decode(
      r?.motor ?? [],
      r?.sensory ?? [],
      r?.t ?? 0,
      ctx.pulse.temperature,
      bands,
    );
    behaviors.push(b);
    states[b.state]++;
    faps[b.fap] = (faps[b.fap] ?? 0) + 1;
    sumAro += b.arousal;
    sumCoh += b.cohesion;
    sumRest += b.rest;
    sumWing += b.wingbeat;
    sumVal += b.valence;
    readings.push({
      id: entry.id,
      state: b.state,
      arousal: b.arousal,
      turnBias: b.turnBias,
      cohesion: b.cohesion,
      wingbeat: b.wingbeat,
      rest: b.rest,
      temperament: entry.temperament,
      fingerprint: b.neuralFingerprint,
      fap: b.fap,
      valence: b.valence,
      heading: b.heading,
      role: b.role,
      bouts: b.bouts,
    });
  }

  const n = Math.max(1, roster.length);
  // Vitality tracks the market slowly: a hot streak leaves the population buzzing for a while.
  const vitality = ctx.vitality + 0.02 * (ctx.pulse.temperature - ctx.vitality);

  const collective: CollectiveState = {
    temperature: ctx.pulse.temperature,
    regime: ctx.regime,
    vitality: clamp01(vitality),
    size: roster.length,
    arousal: sumAro / n,
    cohesion: sumCoh / n,
    rest: sumRest / n,
    wingbeat: sumWing / n,
    states,
    faps,
    valence: sumVal / n,
  };

  return { readings, collective, behaviors, vitality };
}

function clamp01(x: number): number {
  return x < 0 ? 0 : x > 1 ? 1 : x;
}
