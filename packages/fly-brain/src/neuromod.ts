// Neuromodulatory read-out — the A3 layer that upgrades the modulatory population from decorative
// diffuse wiring into an OBSERVABLE DA/OA-like state, and (behind a config switch) a behavioural gate.
//
// WHY THIS IS MANIFEST-NEUTRAL. Like the ethogram, this module is a PURE READ-OUT: it consumes the
// modulatory neurons' firing rates that the connectome ALREADY produces and reduces them to two scalars.
// It never adds neurons, never changes the connectome topology/sizing (BRAIN_N_*/BRAIN_DENSITY), never
// writes back into the network, and never touches a hashed manifest input (DEFAULT_DECODER_CONFIG,
// LIF_CONSTANTS, NEURON_BASE_PARAMS, CONNECTOME_PROVENANCE or any structural spec). So the on-chain
// brain-manifest hash is byte-for-byte unchanged and provenance receipts stay identical. All tunables
// live in NEUROMOD_CONFIG, which is deliberately NOT part of the hashed manifest.
//
// PURE + DETERMINISTIC. No clock, no Math.random, no I/O. computeNeuromod() is a function of
// (firingRates, modulatoryIds) only, so a fly's neuromodulatory state is replayable offline exactly like
// the connectome and the ethogram — the same neural archive always yields the same DA/OA scalars.
//
// BIOLOGICAL GROUNDING (functional emulation, not a literal FlyWire claim — see CONNECTOME_PROVENANCE).
// The modulatory layer stands in for the fly's neuromodulatory systems:
//   DA-like (dopamine)  — reward / reinforcement tone. In the real fly, dopaminergic PPL1/PAM neurons
//                         gate mushroom-body plasticity (learning rate). Here it drives `learningRateGate`,
//                         a RESERVED output for the A1 STDP plasticity step (not wired to any weight yet).
//   OA-like (octopamine)— arousal / behavioural-state tone. Octopaminergic neurons set arousal and the
//                         explore–exploit balance. Here it modulates the decoder's exploration/arousal drive,
//                         but ONLY when NEUROMOD_GATING is enabled (production default OFF ⇒ zero change).
//
// The modulatory population carries no per-neuron subtype label (channel === null), so we partition it
// DETERMINISTICALLY by index into a lower DA-like half and an upper OA-like half. The split is a pure
// function of the connectome's modulatory id list, so it is stable across restarts and replays.

import type { NeuromodState } from "./types.js";

/** Neuromodulatory tunables. Deliberately NOT part of the hashed brain manifest. */
export const NEUROMOD_CONFIG = {
  /**
   * Reference firing rate (Hz) that maps a modulatory subpopulation's mean rate onto normalized 1.0 —
   * the same "population-relative" convention readMotor() uses for the motor channels (rate / refHz,
   * clamped 0..1). Modulatory neurons are slow (tau 40, refractory 10) so their ceiling sits well below
   * the 50 Hz motor reference; 40 Hz keeps the normalized scalars in a lively 0..1 band.
   */
  refHz: 40,
  /** Gain on the DA-like normalized rate (learning-rate gate input). */
  daGain: 1.0,
  /** Gain on the OA-like normalized rate (arousal/exploration drive). */
  oaGain: 1.0,
  /**
   * Floor of the learning-rate gate, so a RESERVED plasticity signal is never fully frozen at low DA.
   * learningRateGate = floor + (1 − floor)·dopamine ∈ [floor, 1]. Not consumed by any weight update yet.
   */
  lrGateFloor: 0.05,
} as const;

/**
 * The neutral (all-zero) neuromodulatory state. Used when a caller decodes without a neuromod read-out
 * (standalone/single-fly tests), so the observable field is always present and never NaN. Deliberately
 * dopamine = octopamine = 0 and learningRateGate = 0 (NOT the derived floor) so a gating-off decode and a
 * gating-on decode with no modulatory drive differ only through the octopamine term, keeping the read-out
 * honest about "no neuromod information available".
 */
export const NEUTRAL_NEUROMOD: NeuromodState = {
  dopamine: 0,
  octopamine: 0,
  learningRateGate: 0,
};

function clamp01(x: number): number {
  // NaN-safe: any non-finite input collapses to 0 rather than poisoning the read-out (see config.ts clamp pitfall).
  return Number.isFinite(x) ? (x < 0 ? 0 : x > 1 ? 1 : x) : 0;
}

/**
 * Deterministically partition the modulatory id list into a DA-like half (lower ids) and an OA-like half
 * (upper ids). Pure function of the id list ⇒ stable across restarts and offline replays. An odd count
 * gives the DA half the smaller slice (floor); an empty list yields two empty halves (⇒ all-zero state).
 */
export function neuromodPartition(modulatoryIds: readonly number[]): {
  da: number[];
  oa: number[];
} {
  const half = Math.floor(modulatoryIds.length / 2);
  return { da: modulatoryIds.slice(0, half), oa: modulatoryIds.slice(half) };
}

/** Mean firing rate (Hz) over a set of neuron ids read out of a per-neuron rate array (0 when empty). */
function meanRate(firingRates: ArrayLike<number>, ids: readonly number[]): number {
  if (ids.length === 0) return 0;
  let sum = 0;
  for (const id of ids) {
    const r = firingRates[id];
    if (typeof r === "number" && Number.isFinite(r)) sum += r;
  }
  return sum / ids.length;
}

/**
 * Compute the DA/OA-like neuromodulatory state from the modulatory layer's firing rates. PURE and
 * DETERMINISTIC: a function of (firingRates, modulatoryIds, cfg) only — no clock, no RNG, no I/O — so the
 * same neural archive always reproduces the same scalars (offline-replayable, like the ethogram).
 *
 * @param firingRates  per-neuron moving-average firing rate (Hz), indexed by neuron id (LifNetwork.firingRate).
 * @param modulatoryIds the connectome's modulatory neuron ids (Connectome.byKind.modulatory).
 */
export function computeNeuromod(
  firingRates: ArrayLike<number>,
  modulatoryIds: readonly number[],
  cfg: Partial<typeof NEUROMOD_CONFIG> = {},
): NeuromodState {
  const c = { ...NEUROMOD_CONFIG, ...cfg };
  const { da, oa } = neuromodPartition(modulatoryIds);
  const ref = Number.isFinite(c.refHz) && c.refHz > 0 ? c.refHz : 1;
  const dopamine = clamp01((meanRate(firingRates, da) / ref) * (Number.isFinite(c.daGain) ? c.daGain : 1));
  const octopamine = clamp01((meanRate(firingRates, oa) / ref) * (Number.isFinite(c.oaGain) ? c.oaGain : 1));
  const floor = clamp01(Number.isFinite(c.lrGateFloor) ? c.lrGateFloor : 0);
  const learningRateGate = clamp01(floor + (1 - floor) * dopamine);
  return { dopamine, octopamine, learningRateGate };
}
