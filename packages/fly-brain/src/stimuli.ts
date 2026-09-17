import type { SensoryInput } from "./types.js";

/**
 * Encodes the Arc market pulse + visitor stimuli into the fly's sensory input.
 *
 * The market pulse is Arc's whole-chain activity reduced to a temperature and its facets (computed
 * worker-side in market.ts). Biological analogy per channel:
 *   · temperature → thermosensation (a fly senses warmth; HOT market = warm, COLD = cool)
 *   · momentum    → optic flow (heating up vs cooling down = which way the world is moving)
 *   · turbulence  → mechanosensation (Johnston's organ feels air vibration = activity churn)
 *   · density     → olfaction (gas heaviness = concentration of "substance" in the air)
 *   · richness    → gustation (appetitive richness = how worth-approaching the moment feels)
 *   · arousal     → interoception (the fly's OWN internal drive, giving each individual a tempo)
 *   · visitor stimulus → a direct electrophysiological perturbation (an artificial "poke")
 */

/** The Arc market pulse fed to the population each tick (derived from whole-chain activity). */
export interface MarketPulse {
  /** Market temperature 0..1 (HOT → 1, COLD → 0, CALM ≈ 0.5) */
  temperature: number;
  /** Temperature momentum −1..1 (heating +, cooling −) */
  momentum: number;
  /** Activity turbulence 0..1 (how far throughput deviates from the learned norm) */
  turbulence: number;
  /** Gas density 0..1 (chain "heaviness", normalised) */
  density: number;
  /** Activity richness 0..1 (liquidity / substance proxy) */
  richness: number;
  /** Per-fly internal arousal 0..1 — injected PER FLY (not shared) so individuals keep their own tempo */
  arousal?: number;
}

export interface StimulusEvent {
  /** Stimulus type */
  type: "food" | "threat" | "light" | "dark";
  /** Intensity 0..1 */
  intensity: number;
  /** Triggering id (optional, for audit) */
  from?: string;
}

/**
 * Convert the market pulse into the SHARED sensory inputs every fly receives this tick.
 * `arousal` is optional and per-fly; when present it is folded in as the interoceptive channel.
 */
export function encodeMarketPulse(pulse: MarketPulse): SensoryInput[] {
  const out: SensoryInput[] = [
    { channel: "thermal_warmth",        intensity: clamp01(pulse.temperature) },
    { channel: "thermal_flux",          intensity: (clamp(pulse.momentum, -1, 1) + 1) / 2 },
    { channel: "mechanical_turbulence", intensity: clamp01(pulse.turbulence) },
    { channel: "olfactory_density",     intensity: clamp01(pulse.density) },
    { channel: "gustatory_richness",    intensity: clamp01(pulse.richness) },
  ];
  if (pulse.arousal != null) {
    out.push({ channel: "internal_arousal", intensity: clamp01(pulse.arousal) });
  }
  return out;
}

/** Convert a visitor stimulus into a sensory input (a short 3-second perturbation). */
export function encodeStimulus(ev: StimulusEvent): SensoryInput {
  const map = {
    food:   "stimulus_food",
    threat: "stimulus_threat",
    light:  "stimulus_light",
    dark:   "stimulus_dark",
  } as const;
  return {
    channel: map[ev.type],
    intensity: clamp01(ev.intensity),
    durationMs: 3000,
  };
}

function clamp(x: number, lo: number, hi: number): number {
  return x < lo ? lo : x > hi ? hi : x;
}
function clamp01(x: number): number {
  return clamp(x, 0, 1);
}
