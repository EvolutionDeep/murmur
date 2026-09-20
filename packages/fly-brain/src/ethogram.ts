// Ethogram engine — the RICH behaviour layer that turns the fly's coarse drives into a named, sequenced
// ethogram: fixed action patterns (FAPs), an approach/avoid valence, a persistent ring-attractor heading,
// and a suppression-hierarchy bout timeline.
//
// WHY THIS LIVES OUTSIDE THE CONNECTOME. murmur commits a brain manifest on Arc (NeuralManifestRegistry):
// anyone can rebuild every connectome from its seed and check it matches the committed structural spec,
// and the hashed manifest body also pins DEFAULT_DECODER_CONFIG + CONNECTOME_PROVENANCE. So adding
// neurons, or changing the decoder config object, would change that hash and force a gas-costly re-anchor.
// The ethogram instead READS the signals the connectome already produces (the 5 motor channels + the 10
// sensory channels + the decoded drives) and derives richer behaviour from them as a pure READ-OUT. It
// never feeds back into the connectome (respecting the one-way economy/neural firewall) and never touches
// any hashed manifest input, so: on-chain brain proofs stay valid, provenance receipts stay identical,
// and the DO neuron budget is unchanged. All tunables live in ETHOGRAM_CONFIG (NOT part of the manifest).
//
// PURE + DETERMINISTIC. No clock, no Math.random, no I/O. The only state is per-instance (ring-attractor
// rates + bout history), advanced one step per decode() tick, so a fly's ethogram is a reproducible
// function of its drive history — replayable offline exactly like the connectome.
//
// BIOLOGICAL GROUNDING (see ETHOGRAM_MOTIFS). Each FAP emulates a circuit published for the real fly
// brain: the taste feeding-initiation circuit (Shiu et al. 2022/2024), the Johnston's-organ → aBN → aDN
// antennal-grooming circuit (Hampel/Seeds), the protocerebral-bridge ring attractor for head direction
// (Kakaria & de Bivort 2017), context-specific halting (Sapkal et al. 2023), and the feeding↔locomotion
// competition (Mann & Scott 2013). These are FUNCTIONAL emulations at the read-out layer, consistent with
// CONNECTOME_PROVENANCE.flywireLiteral = false — we do not claim the literal FlyWire adjacency matrix.

import type { Bout, EthogramReading, Fap, MotorOutput, SensoryChannel, SensoryInput } from "./types.js";

/** Ethogram tunables. Deliberately NOT part of the hashed brain manifest (unlike DEFAULT_DECODER_CONFIG). */
export const ETHOGRAM_CONFIG = {
  // --- ring attractor (head direction) ---
  /** Number of units on the head-direction ring (a bump of activity whose peak angle = heading). */
  ringUnits: 8,
  /** Local excitation each unit passes to its two ring neighbours (sustains the bump). */
  ringExcite: 0.55,
  /** Global inhibition subtracted from every unit (sharpens the bump to a single peak). */
  ringInhibit: 0.30,
  /** Per-tick leak on each unit's rate. */
  ringDecay: 0.70,
  /** How strongly turnBias rotates the bump's target angle per tick (radians). */
  turnGain: 0.42,
  /** Width (radians) of the excitatory input bump injected at the target angle. */
  inputWidth: 0.9,
  /** Strength of the injected input bump (arousal-scaled on top of this). */
  inputGain: 0.85,

  // --- valence (appetitive vs aversive competition) ---
  /** Weight on the appetitive side (gustatory richness + food stimulus). */
  appetitiveWeight: 1.0,
  /** Weight on the aversive side (turbulence + threat stimulus + heavy olfactory density). */
  aversiveWeight: 1.0,
  /** How much olfactory "heaviness" counts as mildly aversive. */
  densityAversion: 0.4,

  // --- suppression hierarchy / bout sequencing ---
  /** Ticks a SUBORDINATE candidate FAP must persist before it can displace the current one. */
  boutHysteresis: 2,
  /** Max completed bouts kept in the timeline shipped to the frontend. */
  maxBouts: 8,
} as const;

/**
 * Suppression-hierarchy dominance rank (higher = more dominant). A dominant candidate displaces the
 * current FAP IMMEDIATELY (escape/avoidance override everything); a subordinate candidate must persist
 * for ETHOGRAM_CONFIG.boutHysteresis ticks before switching, which is what produces realistic, ordered
 * behaviour BOUTS instead of frame-by-frame flicker. Mirrors the suppression hierarchy among competing
 * motor programs that sequences grooming (Seeds et al. 2014).
 */
export const FAP_DOMINANCE: Record<Fap, number> = {
  FLIGHT: 7,   // escape takeoff overrides all
  RETREAT: 6,  // avoidance overrides maintenance/approach
  HALT: 4,     // a freeze interrupts ongoing locomotion
  COURT: 3,
  FEED: 3,
  FORAGE: 2,
  GROOM: 2,
  HUDDLE: 1,
  REST: 0,     // the least dominant — anything wakes a resting fly
};

/** Ordered FAP list (stable, for histograms / legends). */
export const FAP_LIST: Fap[] = [
  "FEED", "GROOM", "FORAGE", "HALT", "RETREAT", "COURT", "FLIGHT", "HUDDLE", "REST",
];

/** Observable economic role per FAP. UI/analytical label only — NEVER a settlement decision input. */
export const FAP_ROLE: Record<Fap, string> = {
  FEED: "momentum-buyer",
  GROOM: "self-maintainer",
  FORAGE: "signal-seeker",
  HALT: "observer",
  RETREAT: "risk-off",
  COURT: "attestation-broadcaster",
  FLIGHT: "liquidator",
  HUDDLE: "consensus-follower",
  REST: "dormant",
};

/**
 * HONEST map of which published real-fly circuits each FAP functionally emulates. Recorded so the
 * frontend/API can present a "behavioural circuit atlas" without overstating the claim: these are
 * decoder-level functional emulations, not the literal FlyWire adjacency graph (flywireLiteral=false).
 */
export const ETHOGRAM_MOTIFS: Record<Fap, { circuit: string; reference: string }> = {
  FEED: { circuit: "taste feeding-initiation: sugar GRN → pre-MN → proboscis MN (MN6/8/9/11)", reference: "Shiu et al. 2024 Nature; Gordon & Scott 2009" },
  GROOM: { circuit: "antennal grooming: Johnston's organ JON → aBN1/aBN2 → aDN1/aDN2 descending", reference: "Hampel et al. 2015/2020; Seeds et al. 2014" },
  FORAGE: { circuit: "locomotor foraging program (walking), gated against feeding", reference: "Sapkal et al. 2023; Mann & Scott 2013" },
  HALT: { circuit: "context-specific halting / freezing", reference: "Sapkal et al. 2023 Nature" },
  RETREAT: { circuit: "aversive inhibition of approach at pre-motor level (bitter/Ir94e → pre-MN)", reference: "Shiu et al. 2024 Nature" },
  COURT: { circuit: "courtship song: wing extension + vibration motor program", reference: "Baker et al. 2022" },
  FLIGHT: { circuit: "escape takeoff / wing burst (giant-fibre-like)", reference: "Card & Dickinson 2008" },
  HUDDLE: { circuit: "cold-driven aggregation / clustering", reference: "murmur collective regime" },
  REST: { circuit: "quiescence / sleep-like abdominal rest tone", reference: "Guo et al. 2016" },
};

/** The drive bundle the ethogram reads (produced by the MotorDecoder this tick). */
export interface EthogramDrives {
  arousal: number;    // 0..1
  turnBias: number;   // −1..1
  cohesion: number;   // 0..1
  wingbeat: number;   // 0..1
  rest: number;       // 0..1
  temperature: number; // 0..1 (HOT → 1)
}

function clamp(x: number, lo: number, hi: number): number {
  return x < lo ? lo : x > hi ? hi : x;
}
function clamp01(x: number): number {
  return clamp(x, 0, 1);
}
const TAU = Math.PI * 2;

/** Read one sensory channel's intensity from a sensory input list (0 when absent). */
function sense(sensory: SensoryInput[], ch: SensoryChannel): number {
  for (const s of sensory) if (s.channel === ch) return s.intensity;
  return 0;
}

/** Read one motor channel's normalized drive (0 when absent). */
function motorOf(motor: MotorOutput[], ch: string): number {
  for (const m of motor) if (m.channel === ch) return m.normalized;
  return 0;
}

/**
 * Appetitive − aversive valence, −1..1. This is the approach/avoid CONFLICT that the FAP ladder reads:
 * gustatory richness + food pull toward (+), while turbulence + threat + heavy olfactory density push
 * away (−). Emulating the paper's headline result — appetitive and aversive pathways converging on a
 * shared pre-motor node, with the aversive side inhibiting approach.
 */
export function computeValence(sensory: SensoryInput[], cfg = ETHOGRAM_CONFIG): number {
  const appetitive =
    sense(sensory, "gustatory_richness") + sense(sensory, "stimulus_food");
  const aversive =
    sense(sensory, "mechanical_turbulence") +
    sense(sensory, "stimulus_threat") +
    cfg.densityAversion * sense(sensory, "olfactory_density");
  return clamp(appetitive * cfg.appetitiveWeight - aversive * cfg.aversiveWeight, -1, 1);
}

/**
 * The FAP selection ladder: a deterministic priority over the decoded drives + valence. First match wins.
 * Ordered so escape/avoidance dominate, then maintenance/approach, then the low-arousal defaults — which
 * is exactly the suppression hierarchy FAP_DOMINANCE encodes for bout sequencing.
 */
export function selectFap(d: EthogramDrives, valence: number, proboscis: number): Fap {
  const { arousal: a, cohesion: c, wingbeat: w, rest: r, temperature: T } = d;
  const turnMag = Math.abs(d.turnBias);

  // 1) Extreme arousal with no appetitive pull → escape takeoff.
  if (a >= 0.86 && valence < 0.12) return "FLIGHT";
  // 2) Averse + aroused → back off / avoid.
  if (valence <= -0.32 && a >= 0.42) return "RETREAT";
  // 3) Very still + low arousal → sleep-like rest.
  if (r >= 0.70 && a <= 0.30) return "REST";
  // 4) Near-frozen low arousal → context-specific halt.
  if (a <= 0.20) return "HALT";
  // 5) Wing-driven + appetitive + cohesive + warm → courtship song.
  if (w >= 0.58 && valence >= 0.18 && c >= 0.48 && T >= 0.44) return "COURT";
  // 6) Strong approach reflex (proboscis) + appetitive + calm → feeding.
  if (proboscis >= 0.30 && valence >= 0.12 && a <= 0.72) return "FEED";
  if (c >= 0.66 && valence >= 0.20 && a <= 0.62) return "FEED";
  // 7) Appetitive + active + steering → walking/foraging search.
  if (valence >= 0.02 && a >= 0.34) return "FORAGE";
  // 8) Cold + cohesive + not searching → huddle.
  if (c >= 0.55 && T <= 0.44) return "HUDDLE";
  // 9) Moderate arousal, low locomotion, neutral valence → grooming (self-maintenance default).
  if (a < 0.5 && turnMag < 0.55) return "GROOM";
  // 10) Fallback: keep searching.
  return "FORAGE";
}

/**
 * A per-fly, stateful ethogram engine. One instance per fly (the MotorDecoder owns it), advanced one step
 * per decode() tick. Holds the ring-attractor head-direction state and the suppression-hierarchy bout
 * timeline. Deterministic: the same drive history always yields the same heading/fap/bouts.
 */
export class Ethogram {
  private readonly cfg: typeof ETHOGRAM_CONFIG;
  /** Ring-attractor unit rates (length = ringUnits). */
  private ring: Float64Array;
  /** The bump's target angle (radians) — rotated by turnBias each tick. */
  private targetAngle = 0;
  /** Current committed FAP + how long it has run. */
  private currentFap: Fap = "FORAGE";
  private currentLen = 0;
  /** Pending subordinate candidate awaiting hysteresis. */
  private pending: Fap | null = null;
  private pendingCount = 0;
  /** Completed bouts, oldest → newest (capped at maxBouts). */
  private bouts: Bout[] = [];
  private lastHeading = 0;
  private lastValence = 0;

  constructor(cfg: Partial<typeof ETHOGRAM_CONFIG> = {}) {
    this.cfg = { ...ETHOGRAM_CONFIG, ...cfg };
    const n = this.cfg.ringUnits;
    this.ring = new Float64Array(n);
    // Seed a bump at angle 0 so the fly starts with a definite heading.
    for (let i = 0; i < n; i++) {
      const a = (i / n) * TAU;
      this.ring[i] = Math.exp(-(a * a) / (2 * this.cfg.inputWidth * this.cfg.inputWidth));
    }
  }

  /** Advance one tick: update the ring attractor, pick the FAP, apply the suppression hierarchy. */
  step(
    motor: MotorOutput[],
    sensory: SensoryInput[],
    drives: EthogramDrives,
  ): EthogramReading {
    const valence = computeValence(sensory, this.cfg);
    const heading = this.stepRing(drives.turnBias, drives.arousal);
    const proboscis = motorOf(motor, "proboscis");
    const candidate = selectFap(drives, valence, proboscis);
    this.applyHierarchy(candidate);

    this.lastValence = valence;
    this.lastHeading = heading;

    // The timeline the frontend draws: completed bouts + the in-progress one as a live tail.
    const timeline: Bout[] = this.bouts.slice(-Math.max(0, this.cfg.maxBouts - 1));
    timeline.push({ fap: this.currentFap, ticks: Math.max(1, this.currentLen) });

    return {
      fap: this.currentFap,
      valence,
      heading,
      role: FAP_ROLE[this.currentFap],
      bouts: timeline,
    };
  }

  /** One ring-attractor update: rotate the input bump by turnBias, then local-excite / global-inhibit. */
  private stepRing(turnBias: number, arousal: number): number {
    const n = this.cfg.ringUnits;
    // Persistent rotation of the preferred direction — this is what gives the fly a real compass.
    this.targetAngle = (this.targetAngle + this.cfg.turnGain * turnBias) % TAU;
    if (this.targetAngle < 0) this.targetAngle += TAU;

    const drive = this.cfg.inputGain * (0.35 + 0.65 * clamp01(arousal));
    const next = new Float64Array(n);
    let sum = 0;
    for (let i = 0; i < n; i++) sum += this.ring[i];
    const mean = sum / n;
    for (let i = 0; i < n; i++) {
      const a = (i / n) * TAU;
      // Angular distance to the target bump centre.
      let da = a - this.targetAngle;
      while (da > Math.PI) da -= TAU;
      while (da < -Math.PI) da += TAU;
      const input = drive * Math.exp(-(da * da) / (2 * this.cfg.inputWidth * this.cfg.inputWidth));
      const prev = this.ring[(i - 1 + n) % n];
      const nxt = this.ring[(i + 1) % n];
      const local = this.cfg.ringExcite * 0.5 * (prev + nxt);
      const r = this.cfg.ringDecay * this.ring[i] + input + local - this.cfg.ringInhibit * mean;
      next[i] = r > 0 ? r : 0;
    }
    this.ring = next;

    // Circular mean of the bump → heading.
    let sx = 0, sy = 0;
    for (let i = 0; i < n; i++) {
      const a = (i / n) * TAU;
      sx += Math.cos(a) * this.ring[i];
      sy += Math.sin(a) * this.ring[i];
    }
    let h = Math.atan2(sy, sx);
    if (h < 0) h += TAU;
    return h;
  }

  /** Suppression hierarchy: dominant candidates switch now; subordinates must persist to earn a bout. */
  private applyHierarchy(candidate: Fap): void {
    if (candidate === this.currentFap) {
      this.currentLen++;
      this.pending = null;
      this.pendingCount = 0;
      return;
    }
    const dominant = FAP_DOMINANCE[candidate] > FAP_DOMINANCE[this.currentFap];
    if (dominant) {
      this.commit(candidate);
      return;
    }
    // Subordinate: require hysteresis so short blips don't fracture the timeline.
    if (candidate === this.pending) this.pendingCount++;
    else { this.pending = candidate; this.pendingCount = 1; }
    if (this.pendingCount >= this.cfg.boutHysteresis) this.commit(candidate);
    else this.currentLen++;
  }

  /** Close the current bout and start a new one for `fap`. */
  private commit(fap: Fap): void {
    if (this.currentLen > 0) {
      this.bouts.push({ fap: this.currentFap, ticks: this.currentLen });
      if (this.bouts.length > this.cfg.maxBouts * 2) {
        this.bouts = this.bouts.slice(-this.cfg.maxBouts);
      }
    }
    this.currentFap = fap;
    this.currentLen = 1;
    this.pending = null;
    this.pendingCount = 0;
  }

  /** The last computed heading (radians) — handy for tests / standalone reads. */
  get heading(): number { return this.lastHeading; }
  /** The last computed valence (−1..1). */
  get valence(): number { return this.lastValence; }
  /** The current committed FAP. */
  get fap(): Fap { return this.currentFap; }
}
