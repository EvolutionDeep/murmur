/**
 * Type definitions for the FlyWire/FAFB real connectome subgraph.
 *
 * The subgraph is extracted offline from the FAFB 783 dataset (FlyWire adult female brain)
 * and stored as a compact gzip+base64 binary artifact. These types describe the decoded
 * in-memory representation used by the deterministic generator.
 *
 * Data provenance:
 *   Dataset: FAFB_783 (compiled 2026-04), Lee Lab GCS bucket (public)
 *   License: CC-BY 4.0
 *   Citations: Schlegel et al. 2021 (eLife), Dorkenwald et al. 2024 (Nature),
 *              Matsunami et al. 2024 (bioRxiv), Eckstein et al. 2024 (Cell)
 *   Subgraph: Mushroom Body + Central Complex + antennal lobe PN + descending neurons
 */

/** Layer codes matching the existing 5-layer connectome structure. */
export const enum FlyWireLayer {
  Sensory = 0,
  InterL1 = 1,
  InterL2 = 2,
  Modulatory = 3,
  Motor = 4,
}

/** Neurotransmitter type codes (from Eckstein et al. 2024 predictions). */
export const enum FlyWireNT {
  Acetylcholine = 0,
  Glutamate = 1,
  GABA = 2,
  Glycine = 3,
  Dopamine = 4,
  Serotonin = 5,
  Octopamine = 6,
  Tyramine = 7,
  Histamine = 8,
  Unknown = 9,
}

/** Human-readable names for NT codes. */
export const NT_NAMES: readonly string[] = [
  "acetylcholine", "glutamate", "gaba", "glycine", "dopamine",
  "serotonin", "octopamine", "tyramine", "histamine", "unknown",
] as const;

/** Human-readable names for layer codes. */
export const LAYER_NAMES: readonly string[] = [
  "sensory", "inter_l1", "inter_l2", "modulatory", "motor",
] as const;

/**
 * Decoded FlyWire subgraph — the fixed real topology extracted from FAFB 783.
 * All arrays are indexed by local neuron ID [0, nNeurons).
 * Edges are stored in flat parallel arrays sorted by (post, pre).
 */
export interface FlyWireSubgraph {
  /** Number of neurons in the subgraph. */
  nNeurons: number;
  /** Number of directed edges (synaptic connections). */
  nEdges: number;
  /** Format version of the binary payload. */
  version: number;
  /** Per-neuron layer assignment (FlyWireLayer code). */
  layers: Uint8Array;
  /** Per-neuron sign: +1 excitatory, -1 inhibitory (from presynaptic NT). */
  signs: Int8Array;
  /** Per-neuron neurotransmitter type code (FlyWireNT). */
  ntCodes: Uint8Array;
  /** Edge presynaptic neuron indices (uint16, sorted by post then pre). */
  preIndices: Uint16Array;
  /** Edge postsynaptic neuron indices (uint16). */
  postIndices: Uint16Array;
  /** Edge weights quantized to uint8 [1-255] (log-scaled synapse count). */
  weightsQuantized: Uint8Array;
}

/**
 * Options for the FlyWire-based connectome generator.
 * The seed controls per-neuron LIF parameter jitter and per-synapse weight perturbation,
 * while the TOPOLOGY is fixed from the real FAFB data.
 */
export interface FlyWireConnectomeOptions {
  /** Random seed for deterministic jitter/perturbation (uint32). */
  seed?: number;
  /**
   * Weight perturbation factor [0, 1). 0 = use quantized weights exactly,
   * 0.2 = ±20% multiplicative jitter per synapse. Default: 0.15.
   */
  weightJitter?: number;
  /**
   * Scale factor for reconstructed float weights. The quantized uint8 [1-255]
   * is mapped to [0, maxWeight]. Default: 1.0 (matching existing connectome scale).
   */
  maxWeight?: number;
}

/** Metadata about the extracted subgraph (from the JSON sidecar). */
export interface FlyWireArtifactMeta {
  version: number;
  format: string;
  source: {
    dataset: string;
    description: string;
    version: string;
    license: string;
    citations: string[];
    url: string;
    neurotransmitter_method: string;
    extraction_date: string;
    min_synapse_count: number;
    subgraph_scope: string;
  };
  stats: {
    n_neurons: number;
    n_edges: number;
    layer_counts: Record<string, number>;
    sign_distribution: {
      excitatory_neurons: number;
      inhibitory_neurons: number;
      excitatory_pct: number;
      inhibitory_pct: number;
    };
    fan_in: { mean: number; max: number; median: number };
  };
  encoding: {
    format: string;
    layout: string;
    weight_quantization: string;
    sign_rule: string;
    layer_codes: Record<string, number>;
    nt_names: string[];
  };
  integrity: {
    raw_sha256: string;
    compressed_sha256: string;
    raw_bytes: number;
    compressed_bytes: number;
    base64_chars: number;
  };
  constraints: {
    neurons_under_30800: boolean;
    compressed_b64_under_2MB: boolean;
    heap_under_72MB: boolean;
    heap_estimate_mb: number;
  };
}
