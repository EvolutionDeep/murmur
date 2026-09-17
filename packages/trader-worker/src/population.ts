// Population — a swarm of fruit-fly brains that FEEL the Arc market and react, both collectively
// and individually. Nothing here trades, holds a wallet or touches a private key.
//
// This is a PURELY REACTIVE population: a fixed set of flies, each an independent connectome grown
// from its own seed (its "temperament"). There is NO breeding, NO lineage, NO generations and NO
// retirement — those belonged to the old project and are gone. The population simply persists and
// reacts. Per tick:
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
  type ConnectomeOptions,
} from "@fly/fly-brain";
import type { RuntimeConfig } from "./config.js";
import type { Regime } from "./market.js";

/** Persistent per-fly identity: a seed and the stable temperament derived from it. No lineage. */
export interface FlyVitals {
  id: number;
  seed: number;
  /** Stable per-fly internal arousal 0..1 (drawn from the seed → individual tempo). */
  temperament: number;
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
}

export interface PopulationSnapshot {
  tickIndex: number;
  collective: CollectiveState;
  flies: FlyReading[];
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
        const brain = restored.brains[i]
          ? FlyBrain.deserialize(restored.brains[i], { seed: vitals.seed, ...this.brainOpts })
          : new FlyBrain({ seed: vitals.seed, ...this.brainOpts });
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
    return (((seed >>> 5) % 1000) / 1000) * 0.6 + 0.2;
  }

  private spawnFly(seed: number, id: number): FlyInstance {
    const brain = new FlyBrain({ seed, ...this.brainOpts });
    const vitals: FlyVitals = { id, seed, temperament: this.temperamentOf(seed) };
    const inst: FlyInstance = { id, brain, decoder: this.makeDecoder(), vitals };
    this.flies.push(inst);
    return inst;
  }

  /**
   * Advance one tick: drive every fly with the shared market pulse (+ any visitor stimuli), then
   * decode each fly RELATIVE to the population so the reaction is collective + individual.
   */
  step(
    pulse: MarketPulse,
    regime: Regime,
    stimuli: StimulusEvent[],
    simSteps: number,
  ): PopulationSnapshot {
    this.tickIndex++;
    const flies = this.flies;

    // 1) Drive every fly and collect its raw motor output.
    const motors: MotorOutput[][] = [];
    const sensories: SensoryInput[][] = [];
    const raws: RawDrives[] = [];
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
      const motor = fly.brain.readAllMotor();
      motors.push(motor);
      sensories.push(sensory);
      raws.push(readRawDrives(motor));
    }

    // 2) Population bands → each fly's relative standing this tick.
    const bands = computeBands(raws);

    // 3) Decode every fly against the bands; aggregate the collective mood.
    const readings: FlyReading[] = [];
    const states = EMPTY_STATES();
    let sumAro = 0, sumCoh = 0, sumRest = 0, sumWing = 0;
    for (let i = 0; i < flies.length; i++) {
      const fly = flies[i];
      const b = fly.decoder.decode(
        motors[i],
        sensories[i],
        fly.brain.t,
        pulse.temperature,
        bands,
      );
      fly.lastBehavior = b;
      states[b.state]++;
      sumAro += b.arousal;
      sumCoh += b.cohesion;
      sumRest += b.rest;
      sumWing += b.wingbeat;
      readings.push({
        id: fly.id,
        state: b.state,
        arousal: b.arousal,
        turnBias: b.turnBias,
        cohesion: b.cohesion,
        wingbeat: b.wingbeat,
        rest: b.rest,
        temperament: fly.vitals.temperament,
        fingerprint: b.neuralFingerprint,
      });
    }

    const n = Math.max(1, flies.length);
    // Vitality tracks the market slowly: a hot streak leaves the population buzzing for a while.
    this.vitality += 0.02 * (pulse.temperature - this.vitality);

    const collective: CollectiveState = {
      temperature: pulse.temperature,
      regime,
      vitality: clamp01(this.vitality),
      size: flies.length,
      arousal: sumAro / n,
      cohesion: sumCoh / n,
      rest: sumRest / n,
      wingbeat: sumWing / n,
      states,
    };

    this.lastSnapshot = { tickIndex: this.tickIndex, collective, flies: readings };
    return this.lastSnapshot;
  }

  getTickIndex(): number { return this.tickIndex; }
  getVitality(): number { return clamp01(this.vitality); }
  getLastSnapshot(): PopulationSnapshot | null { return this.lastSnapshot; }

  /** Serialise for persistence into the Durable Object. */
  serialize(): string {
    return JSON.stringify({
      version: 4,   // v4 = pure reactive population (v1–v3 carried lineage/generations — dropped)
      tickIndex: this.tickIndex,
      vitality: this.vitality,
      flies: this.flies.map((f) => ({ vitals: f.vitals, brain: f.brain.serialize() })),
    });
  }

  static deserialize(data: string, cfg: RuntimeConfig): Population {
    const parsed = JSON.parse(data);
    const version = parsed?.version;
    // v4 is native; v3 is tolerated by stripping the old lineage fields (id/seed/temperament survive).
    if (version === 4 || version === 3) {
      return new Population(cfg, {
        flies: parsed.flies.map((x: any) => ({
          id: Number(x.vitals.id),
          seed: Number(x.vitals.seed),
          temperament: Number(x.vitals.temperament ?? 0.5),
        })),
        brains: parsed.flies.map((x: any) => x.brain),
        tickIndex: Number(parsed.tickIndex ?? 0),
        vitality: Number(parsed.vitality ?? 0.5),
      });
    }
    throw new Error("unsupported population serialization version");
  }
}

function clamp01(x: number): number {
  return x < 0 ? 0 : x > 1 ? 1 : x;
}
