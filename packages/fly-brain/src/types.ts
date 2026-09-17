// Core types for the fly-brain simulator.

export type NeuronKind =
  | "sensory"      // Sensory neurons: thermo / mechano / olfaction / gustation / interoception
  | "inter"        // Interneurons
  | "modulatory"   // Modulatory neurons (dopamine / octopamine etc., map to "mood")
  | "motor";       // Motor neurons

/**
 * Sensory channels. The first six carry the Arc market pulse (whole-chain activity reduced to a
 * temperature + its facets); the last four carry visitor-injected stimuli ("poke the swarm").
 * Names follow fruit-fly biology so the connectome reads like a nervous system, not a trading bot.
 */
export type SensoryChannel =
  | "thermal_warmth"          // Market temperature → thermosensation (HOT = warm, COLD = cool)
  | "thermal_flux"            // Temperature momentum → heating (+) vs cooling (−); optic-flow analogue
  | "mechanical_turbulence"   // Activity turbulence (tx-throughput deviation) → Johnston's organ
  | "olfactory_density"       // Gas density / chain "heaviness" → olfaction (substance concentration)
  | "gustatory_richness"      // Activity richness (liquidity proxy) → gustation (appetitive = approach)
  | "internal_arousal"        // Per-fly internal arousal drive → interoception (individual tempo)
  | "stimulus_food"           // Visitor stimulus: feed
  | "stimulus_threat"         // Visitor stimulus: threat
  | "stimulus_light"          // Visitor stimulus: light
  | "stimulus_dark";          // Visitor stimulus: dark

export type MotorChannel =
  | "leg_left"       // Left leg → leftward locomotion (turn bias −)
  | "leg_right"      // Right leg → rightward locomotion (turn bias +)
  | "wing"           // Wing-beat → arousal / activity intensity
  | "proboscis"      // Proboscis (feeding / approach) → cohesion: seek the swarm centre
  | "abdomen";       // Abdominal rhythm → rest tone

export interface NeuronMeta {
  id: number;
  kind: NeuronKind;
  /** Channel bound to a sensory neuron; null for other kinds */
  channel: SensoryChannel | MotorChannel | null;
  /** Membrane time constant (ms) */
  tau: number;
  /** Resting potential */
  vRest: number;
  /** Threshold */
  vThresh: number;
  /** Reset potential */
  vReset: number;
  /** Refractory period (ms) */
  refractory: number;
}

export interface Synapse {
  pre: number;
  post: number;
  /** Synaptic weight; positive = excitatory, negative = inhibitory */
  w: number;
  /** Synaptic delay (ms); simplified to 0 in the MVP */
  delay?: number;
}

export interface Connectome {
  neurons: NeuronMeta[];
  synapses: Synapse[];
  /** Convenience indices */
  byKind: Record<NeuronKind, number[]>;
  byChannel: Map<string, number[]>;
}

export interface SensoryInput {
  channel: SensoryChannel;
  /** Injected current intensity (normalized to 0..1, may slightly exceed) */
  intensity: number;
  /** Duration (ms) */
  durationMs?: number;
}

export interface MotorOutput {
  channel: MotorChannel;
  /** Average firing rate (Hz) over the trailing window */
  firingRate: number;
  /** Spike count over the trailing window */
  spikes: number;
  /** Signal strength normalized to 0..1 */
  normalized: number;
}

export interface BrainSnapshot {
  t: number;                    // Simulation time (ms)
  step: number;                 // Number of simulation steps taken
  membrane: Float32Array;       // Membrane potential per neuron
  spikesLastStep: Uint8Array;   // Whether each neuron spiked on the last step
  firingRates: Float32Array;    // Moving-average firing rate per neuron
  motor: MotorOutput[];         // Aggregated motor outputs
}

/** Discrete behavioural state a fly expresses in response to the market pulse + its own dynamics. */
export type BehaviorState = "AGITATE" | "EXPLORE" | "AGGREGATE" | "REST";

/**
 * One fly's decoded behavioural response for a tick (replaces the old trading decision — nothing
 * here buys or sells; it only describes how the fly MOVES and FEELS, which the frontend renders).
 */
export interface FlyBehavior {
  state: BehaviorState;
  /** Overall activation 0..1 (wing-driven) → movement speed & visual pulse amplitude */
  arousal: number;
  /** Locomotion asymmetry −1..1 (leg_left − leg_right) → wander / turn direction */
  turnBias: number;
  /** Pull toward the swarm centre 0..1 (proboscis / approach) → cohesion vs dispersion */
  cohesion: number;
  /** Wing-beat intensity 0..1 → visual pulse frequency */
  wingbeat: number;
  /** Rest tone 0..1 (abdomen) → stillness / metabolic slowdown */
  rest: number;
  /** Motor-output snapshot used at decode time */
  motor: MotorOutput[];
  /** Sensory inputs used at decode time */
  sensory: SensoryInput[];
  /** Neural fingerprint: hash (hex) of every motor neuron's recent firing rate */
  neuralFingerprint: string;
}

export interface IFlyBrain {
  readonly connectome: Connectome;
  readonly t: number;
  readonly step: number;
  inject(input: SensoryInput): void;
  /** Advance the simulation by dt milliseconds (dt=1 ms recommended) */
  tick(dtMs: number): void;
  /** Read the firing rate of a given motor channel */
  readMotor(channel: MotorChannel, windowMs?: number): MotorOutput;
  /** Take a full snapshot (used for frontend visualization) */
  snapshot(): BrainSnapshot;
  /** Serialize state for persistence to Durable Object / D1 */
  serialize(): string;
}
