/**
 * Deterministic FlyWire-based connectome generator.
 *
 * Takes a decoded FlyWireSubgraph (real FAFB 783 topology) and a seed, and produces
 * a Connectome compatible with the existing 5-layer interface (types.ts).
 *
 * DETERMINISM CONTRACT:
 *   buildFromFlyWire(subgraph, { seed: X }) === buildFromFlyWire(subgraph, { seed: X })
 *   byte-for-byte, on every JS engine. The topology is FIXED (from real data);
 *   the seed only controls LIF parameter jitter and weight perturbation via
 *   mulberry32 (integer-only PRNG, bit-identical cross-engine).
 *
 * LAYER MAPPING (FAFB → existing 5-layer structure):
 *   sensory    ← antennal lobe PNs (olfactory relay), CX input neurons
 *   inter_l1   ← Kenyon cells (MB computation), CX intrinsic (ring attractor, PFN)
 *   inter_l2   ← MBONs (MB output), CX output neurons (FS, FC, PFL)
 *   modulatory ← dopaminergic (PAM, PPL1, PPL2), serotonergic, octopaminergic
 *   motor      ← descending neurons (CX/MB → body motor)
 *
 * SIGN ASSIGNMENT (Eckstein et al. 2024):
 *   Excitatory (+1): ACh, GLU, ASP, HIS, and modulatory NTs (net depolarizing)
 *   Inhibitory (-1): GABA, GLY
 *
 * NOT CONNECTED TO PRODUCTION: This module does NOT modify connectome.ts,
 * buildConnectome, or manifest.ts. Integration is Step 3 (A2 online).
 */

import type {
  Connectome,
  MotorChannel,
  NeuronKind,
  NeuronMeta,
  SensoryChannel,
  Synapse,
} from "../types.js";
import type { FlyWireSubgraph, FlyWireConnectomeOptions } from "./types.js";
import { FlyWireLayer } from "./types.js";

/** Default generator options. */
export const DEFAULT_FLYWIRE_OPTIONS: Required<FlyWireConnectomeOptions> = {
  seed: 0xfafb7830,
  weightJitter: 0.15,
  maxWeight: 1.0,
};

/** Integer-only mulberry32 PRNG (bit-identical cross-engine). Mirrors connectome.ts. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Per-kind base LIF parameters (mirrors connectome.ts / manifest.ts NEURON_BASE_PARAMS). */
const BASE_PARAMS: Record<NeuronKind, { tau: number; vRest: number; vThresh: number; vReset: number; refractory: number }> = {
  sensory:    { tau: 10, vRest: 0, vThresh: 1.0, vReset: -0.5, refractory: 3 },
  inter:      { tau: 15, vRest: 0, vThresh: 1.0, vReset: -0.5, refractory: 4 },
  modulatory: { tau: 40, vRest: 0, vThresh: 0.8, vReset: -0.3, refractory: 10 },
  motor:      { tau: 8,  vRest: 0, vThresh: 1.0, vReset: -0.5, refractory: 2 },
};

/** Map FlyWireLayer code → NeuronKind for the existing Connectome interface. */
function layerToKind(layer: number): NeuronKind {
  switch (layer) {
    case FlyWireLayer.Sensory: return "sensory";
    case FlyWireLayer.InterL1: return "inter";
    case FlyWireLayer.InterL2: return "inter";
    case FlyWireLayer.Modulatory: return "modulatory";
    case FlyWireLayer.Motor: return "motor";
    default: return "inter";
  }
}

/**
 * Sensory channel assignment for FlyWire sensory neurons.
 * Maps based on position within the sensory population (round-robin over
 * the existing 10 channels, matching connectome.ts's SENSORY_CHANNELS order).
 */
const SENSORY_CHANNELS: SensoryChannel[] = [
  "thermal_warmth", "thermal_flux", "mechanical_turbulence",
  "olfactory_density", "gustatory_richness", "internal_arousal",
  "stimulus_food", "stimulus_threat", "stimulus_light", "stimulus_dark",
];

/**
 * Motor channel assignment for FlyWire motor (descending) neurons.
 * Round-robin over the 5 existing channels.
 */
const MOTOR_CHANNELS: MotorChannel[] = [
  "leg_left", "leg_right", "wing", "proboscis", "abdomen",
];

/**
 * Build a Connectome from a decoded FlyWire subgraph + seed.
 *
 * The TOPOLOGY (which neurons connect to which, with what base strength and sign)
 * is FIXED from the real FAFB 783 data. The seed controls:
 *   1. Per-neuron LIF parameter jitter (tau, vThresh ± 20%)
 *   2. Per-synapse weight perturbation (± weightJitter multiplicative)
 *
 * Same (subgraph, seed) → identical Connectome, always.
 */
export function buildFromFlyWire(
  subgraph: FlyWireSubgraph,
  opts: FlyWireConnectomeOptions = {},
): Connectome {
  const {
    seed = DEFAULT_FLYWIRE_OPTIONS.seed,
    weightJitter = DEFAULT_FLYWIRE_OPTIONS.weightJitter,
    maxWeight = DEFAULT_FLYWIRE_OPTIONS.maxWeight,
  } = opts;

  const rand = mulberry32(seed);
  const { nNeurons, nEdges, layers, signs, preIndices, postIndices, weightsQuantized } = subgraph;

  // ============ 1) Build neurons ============
  const neurons: NeuronMeta[] = new Array(nNeurons);
  const byKind: Record<NeuronKind, number[]> = {
    sensory: [], inter: [], modulatory: [], motor: [],
  };
  const byChannel: Map<string, number[]> = new Map();

  // Initialize channel arrays
  for (const ch of SENSORY_CHANNELS) byChannel.set(ch, []);
  for (const ch of MOTOR_CHANNELS) byChannel.set(ch, []);

  let sensoryIdx = 0;
  let motorIdx = 0;

  for (let i = 0; i < nNeurons; i++) {
    const layer = layers[i]!;
    const kind = layerToKind(layer);
    const jitter = () => 0.8 + rand() * 0.4;
    const base = BASE_PARAMS[kind];

    // Channel assignment
    let channel: SensoryChannel | MotorChannel | null = null;
    if (kind === "sensory") {
      channel = SENSORY_CHANNELS[sensoryIdx % SENSORY_CHANNELS.length]!;
      sensoryIdx++;
    } else if (kind === "motor") {
      channel = MOTOR_CHANNELS[motorIdx % MOTOR_CHANNELS.length]!;
      motorIdx++;
    }

    neurons[i] = {
      id: i,
      kind,
      channel,
      tau: base.tau * jitter(),
      vRest: base.vRest,
      vThresh: base.vThresh * jitter(),
      vReset: base.vReset,
      refractory: base.refractory,
    };

    byKind[kind].push(i);
    if (channel) {
      byChannel.get(channel)!.push(i);
    }
  }

  // ============ 2) Build synapses ============
  const synapses: Synapse[] = new Array(nEdges);

  for (let e = 0; e < nEdges; e++) {
    const pre = preIndices[e]!;
    const post = postIndices[e]!;
    const wq = weightsQuantized[e]!;
    const sign = signs[pre]!; // Sign from PRESYNAPTIC neuron's NT

    // Reconstruct float weight: quantized [1-255] → [0, maxWeight]
    const baseW = (wq / 255) * maxWeight;

    // Apply seed-driven multiplicative jitter: w * (1 + jitter * uniform(-1, 1))
    const perturbFactor = 1.0 + weightJitter * (rand() * 2 - 1);
    const w = baseW * sign * perturbFactor;

    synapses[e] = { pre, post, w };
  }

  return { neurons, synapses, byKind, byChannel };
}

/**
 * Compute summary statistics of a FlyWire subgraph (for verification/reporting).
 */
export function subgraphStats(subgraph: FlyWireSubgraph): {
  nNeurons: number;
  nEdges: number;
  layerCounts: Record<string, number>;
  excitatoryNeurons: number;
  inhibitoryNeurons: number;
  fanInMean: number;
  fanInMax: number;
} {
  const { nNeurons, nEdges, layers, signs, postIndices } = subgraph;

  const layerCounts: Record<string, number> = {};
  const layerNames = ["sensory", "inter_l1", "inter_l2", "modulatory", "motor"];
  for (let i = 0; i < nNeurons; i++) {
    const name = layerNames[layers[i]!] ?? "unknown";
    layerCounts[name] = (layerCounts[name] ?? 0) + 1;
  }

  let exc = 0, inh = 0;
  for (let i = 0; i < nNeurons; i++) {
    if (signs[i]! > 0) exc++;
    else inh++;
  }

  const fanIn = new Uint32Array(nNeurons);
  for (let e = 0; e < nEdges; e++) {
    fanIn[postIndices[e]!]++;
  }
  let fanSum = 0, fanMax = 0;
  for (let i = 0; i < nNeurons; i++) {
    fanSum += fanIn[i]!;
    if (fanIn[i]! > fanMax) fanMax = fanIn[i]!;
  }

  return {
    nNeurons,
    nEdges,
    layerCounts,
    excitatoryNeurons: exc,
    inhibitoryNeurons: inh,
    fanInMean: nNeurons > 0 ? fanSum / nNeurons : 0,
    fanInMax: fanMax,
  };
}
