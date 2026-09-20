import type { MotorChannel, MotorOutput, FlyBehavior, BehaviorState, SensoryInput } from "./types.js";
import { MOTOR_CHANNEL_LIST } from "./connectome.js";
import { Ethogram } from "./ethogram.js";

/**
 * Behaviour decoder: translates the fly's motor-neuron firing rates into a behavioural state plus
 * the continuous drives the frontend renders. NOTHING here trades — it only describes motion/mood.
 *
 * WHY POPULATION-RELATIVE. Calibration against the real LIF connectome showed the normalised motor
 * rates are small and strongly channel-asymmetric: the leg channels (fed by the focused
 * winner-take-all competition) reach ~0.4, the proboscis (a direct appetitive reflex) ~0.2, while
 * wing/abdomen (fed diffusely by BOTH mutually-inhibiting L2 halves, so their drive partly cancels)
 * stay under ~0.06. A single absolute threshold is therefore meaningless across channels and across
 * each fly's uniquely-wired connectome. Instead we read each fly RELATIVE TO ITS PEERS this tick:
 *
 *   raw drive ──(population 10–90 band)──▶ relative standing 0..1  (individual layer)
 *   market temperature ──────────────────▶ collective base 0..1     (regime layer)
 *   rendered drive = clamp01(base + spread·(standing − ½))
 *
 * The collective base makes the WHOLE swarm track the regime (HOT → high arousal / low cohesion;
 * COLD → low arousal / high cohesion / high rest); the relative standing spreads individuals around
 * that base and picks which minority breaks rank, so flies diverge within a regime.
 *
 * Motor → raw drive mapping (biological analogy):
 *   arousal  = ½(leg_left + leg_right) + wing   — locomotor drive + wing-beat = overall activity
 *   turn     = leg_left − leg_right             — steering asymmetry (−1..1)
 *   cohesion = proboscis                        — appetitive approach reflex → seek the swarm centre
 *   rest     = abdomen                          — abdominal stillness tone
 *
 * State selection (temperature anchors the collective; relative standing drives the individual):
 *   HOT  (t ≥ hotT) : AGITATE, except the sluggish minority (low arousal standing) → EXPLORE
 *   COLD (t ≤ coldT): AGGREGATE (huddle), except the stillest minority → REST
 *   CALM            : EXPLORE by default; the most aroused → AGITATE, the most cohesive → AGGREGATE
 * A short hysteresis stops the state flickering tick-to-tick on motor noise.
 */

/** Per-fly raw drives read straight off the motor channels (before population normalisation). */
export interface RawDrives {
  arousal: number;
  turn: number;
  cohesion: number;
  rest: number;
}

/** Robust per-channel range across the population this tick, used to compute relative standing. */
export interface PopulationBands {
  arousal: [number, number];
  cohesion: [number, number];
  rest: [number, number];
  /** Max |turn| across the population (turn is symmetric, so one magnitude suffices). */
  turnAbs: number;
}

/**
 * Fallback bands for standalone decoding (no population context — e.g. tests / a single fly).
 * Taken from the observed HOT-regime maxima so a lone fly still lands in a sensible 0..1 range.
 */
export const REF_BANDS: PopulationBands = {
  arousal: [0, 0.42],
  cohesion: [0, 0.2],
  rest: [0, 0.06],
  turnAbs: 0.1,
};

/** Read the four raw drives off a fly's motor output. */
export function readRawDrives(motor: MotorOutput[]): RawDrives {
  const g = (ch: MotorChannel) => motor.find((m) => m.channel === ch)?.normalized ?? 0;
  const legL = g("leg_left");
  const legR = g("leg_right");
  const wing = g("wing");
  const prob = g("proboscis");
  const abd = g("abdomen");
  return {
    arousal: 0.5 * (legL + legR) + wing,
    turn: legL - legR,
    cohesion: prob,
    rest: abd,
  };
}

/** Compute the population bands from every fly's raw drives this tick (robust 10–90 percentiles). */
export function computeBands(all: RawDrives[]): PopulationBands {
  if (all.length === 0) {
    return { arousal: [0, 0], cohesion: [0, 0], rest: [0, 0], turnAbs: 0 };
  }
  const sorted = (pick: (d: RawDrives) => number) =>
    all.map(pick).sort((a, b) => a - b);
  const aro = sorted((d) => d.arousal);
  const coh = sorted((d) => d.cohesion);
  const rst = sorted((d) => d.rest);
  const turnAbs = all.reduce((m, d) => Math.max(m, Math.abs(d.turn)), 0);
  return {
    arousal: [percentile(aro, 0.1), percentile(aro, 0.9)],
    cohesion: [percentile(coh, 0.1), percentile(coh, 0.9)],
    rest: [percentile(rst, 0.1), percentile(rst, 0.9)],
    turnAbs,
  };
}

function percentile(sortedAsc: number[], p: number): number {
  if (sortedAsc.length === 0) return 0;
  const idx = clamp(Math.round(p * (sortedAsc.length - 1)), 0, sortedAsc.length - 1);
  return sortedAsc[idx];
}

/** Rescale a raw value into its population band → relative standing 0..1 (½ when the band is flat). */
function relative(raw: number, band: [number, number]): number {
  const width = band[1] - band[0];
  if (width < 1e-9) return 0.5; // no population spread → neutral standing
  return clamp01((raw - band[0]) / width);
}

export interface DecoderConfig {
  /** Temperature at/above which the collective regime is HOT */
  hotT: number;
  /** Temperature at/below which the collective regime is COLD */
  coldT: number;
  /** How far an individual deviates from the collective base (0..1 spread of the relative term) */
  spread: number;
  /** Relative standing below this → the sluggish minority breaks rank (HOT→EXPLORE, COLD→REST) */
  lowQ: number;
  /** Relative standing above this → the activated/cohesive minority breaks rank in CALM */
  highQ: number;
  /** Hysteresis: commit to a new state only after N consecutive same-state signals */
  hysteresisSteps: number;
}

export const DEFAULT_DECODER_CONFIG: DecoderConfig = {
  hotT: 0.66,
  coldT: 0.33,
  spread: 0.45,
  lowQ: 0.25,
  highQ: 0.75,
  hysteresisSteps: 2,
};

export class MotorDecoder {
  private cfg: DecoderConfig;
  private lastState: BehaviorState = "EXPLORE";
  private candidate: BehaviorState = "EXPLORE";
  private candidateCount = 0;
  /**
   * Per-fly ethogram engine (ring-attractor heading + FAP suppression hierarchy + bout timeline). One
   * instance per decoder, advanced one step per decode() tick. Purely a read-out layer: it consumes the
   * motor/sensory signals and the drives computed below, and NEVER writes back into the connectome, so
   * the on-chain brain manifest and the economic provenance are unaffected (see ethogram.ts header).
   */
  private readonly etho = new Ethogram();

  constructor(cfg: Partial<DecoderConfig> = {}) {
    this.cfg = { ...DEFAULT_DECODER_CONFIG, ...cfg };
  }

  /** Decode one fly's motor output into its behavioural response for this tick.
   *  @param temperature market temperature 0..1 (HOT → 1) — the collective anchor for the regime.
   *  @param bands       this tick's population bands; omit only for standalone/single-fly decoding. */
  decode(
    motor: MotorOutput[],
    sensory: SensoryInput[],
    simTimeMs: number,
    temperature = 0.5,
    bands: PopulationBands = REF_BANDS,
  ): FlyBehavior {
    const raw = readRawDrives(motor);

    // Individual layer: where this fly sits within its peers (0..1).
    const relAro = relative(raw.arousal, bands.arousal);
    const relCoh = relative(raw.cohesion, bands.cohesion);
    const relRest = relative(raw.rest, bands.rest);
    const turnBias =
      bands.turnAbs > 1e-9
        ? clamp(raw.turn / bands.turnAbs, -1, 1)
        : clamp(raw.turn * 8, -1, 1);

    // Collective layer: the regime base every fly shares, driven by market temperature.
    const T = clamp01(temperature);
    const s = this.cfg.spread;
    const arousal = clamp01(T + s * (relAro - 0.5));
    const cohesion = clamp01(1 - T + s * (relCoh - 0.5));
    const rest = clamp01(1 - T + s * (relRest - 0.5));
    const wingbeat = arousal;

    let rawState: BehaviorState;
    if (T >= this.cfg.hotT) {
      // HOT: the swarm is agitated; the least-active minority lags behind as explorers.
      rawState = relAro < this.cfg.lowQ ? "EXPLORE" : "AGITATE";
    } else if (T <= this.cfg.coldT) {
      // COLD: the swarm huddles; the stillest minority drops into rest.
      rawState = relAro < this.cfg.lowQ ? "REST" : "AGGREGATE";
    } else {
      // CALM: drift/explore; the most aroused break into agitation, the most cohesive aggregate.
      if (relAro >= this.cfg.highQ) rawState = "AGITATE";
      else if (relCoh >= this.cfg.highQ) rawState = "AGGREGATE";
      else rawState = "EXPLORE";
    }

    // Hysteresis: commit only after N consecutive same-state signals, else hold the last state.
    if (rawState === this.candidate) this.candidateCount++;
    else {
      this.candidate = rawState;
      this.candidateCount = 1;
    }
    const state =
      this.candidateCount >= this.cfg.hysteresisSteps ? this.candidate : this.lastState;
    this.lastState = state;

    // Ethogram enrichment: derive the named FAP, approach/avoid valence, persistent ring-attractor
    // heading, economic role and bout timeline from the SAME motor/sensory read-outs (pure read-out).
    const etho = this.etho.step(motor, sensory, {
      arousal,
      turnBias,
      cohesion,
      wingbeat,
      rest,
      temperature: T,
    });

    return {
      state,
      arousal,
      turnBias,
      cohesion,
      wingbeat,
      rest,
      motor,
      sensory,
      neuralFingerprint: neuralFingerprint(motor, simTimeMs),
      fap: etho.fap,
      valence: etho.valence,
      heading: etho.heading,
      role: etho.role,
      bouts: etho.bouts,
    };
  }

  /** Convenience: return a summary of MotorOutput for all channels */
  static summarizeMotor(readChannel: (ch: MotorChannel) => MotorOutput): MotorOutput[] {
    return MOTOR_CHANNEL_LIST.map(readChannel);
  }
}

function clamp(x: number, lo: number, hi: number): number {
  return x < lo ? lo : x > hi ? hi : x;
}
function clamp01(x: number): number {
  return clamp(x, 0, 1);
}

/**
 * Neural fingerprint: packs motor outputs into a verifiable short hash (FNV-1a 32-bit, doubled).
 * Non-cryptographic — enough for display / per-fly identity colouring.
 */
export function neuralFingerprint(motor: MotorOutput[], simTimeMs: number): string {
  let h1 = 0x811c9dc5;
  let h2 = 0x01000193;
  const mix = (x: number) => {
    h1 = (h1 ^ (x & 0xff)) >>> 0;
    h1 = Math.imul(h1, 0x01000193) >>> 0;
    h2 = (h2 ^ ((x >>> 8) & 0xff)) >>> 0;
    h2 = Math.imul(h2, 0x85ebca6b) >>> 0;
  };
  for (const m of motor) {
    const q = Math.round(m.normalized * 255);
    mix(q);
    mix(Math.round(m.firingRate));
  }
  const t = Math.floor(simTimeMs);
  mix(t & 0xff);
  mix((t >>> 8) & 0xff);
  mix((t >>> 16) & 0xff);
  mix((t >>> 24) & 0xff);
  return h1.toString(16).padStart(8, "0") + h2.toString(16).padStart(8, "0");
}
