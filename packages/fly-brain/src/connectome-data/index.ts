/**
 * FlyWire/FAFB real connectome subgraph — deterministic generator module.
 *
 * This module provides the PRODUCTION topology for murmur: the REAL fruit-fly brain
 * wiring data from the FAFB 783 / FlyWire connectome, replacing the procedural random
 * generator in connectome.ts (which remains as a fallback when FLYWIRE_TOPOLOGY=false).
 *
 * ARCHITECTURE:
 *   1. Offline extraction (Python): FAFB 783 → MB+CX subgraph → compressed binary artifact
 *   2. Decoder (this module): base64+gzip → typed arrays (FlyWireSubgraph)
 *   3. Generator (this module): FlyWireSubgraph + seed → Connectome (5-layer compatible)
 *
 * CURRENT STATUS (production, FLYWIRE_TOPOLOGY=true):
 *   - Connected to production via shard.ts / population.ts / manifest.ts
 *   - flywireLiteral = true in FLYWIRE_PROVENANCE (manifest.ts)
 *   - manifestHash rotated to 100712db…ef9c (on-chain commitCount 3)
 *   - Every live fly instantiates the same fixed 10,361-neuron topology;
 *     genomes parameterize synaptic weights and LIF properties only
 *
 * DATA PROVENANCE:
 *   Dataset: FAFB_783 (FlyWire adult female brain, compiled 2026-04)
 *   Source: Lee Lab GCS bucket (public access)
 *   License: CC-BY 4.0
 *   Subgraph: Mushroom Body + Central Complex + olfactory PN input + descending output
 *   Scale: 10,361 neurons, 467,314 synapses (min synapse count ≥ 2)
 *   NT predictions: Eckstein et al. 2024 (Cell)
 *
 * CONSTRAINTS VERIFIED:
 *   - Neurons within DO 128 MB isolate budget (single fly/shard): PASS
 *   - Compressed artifact < 2MB: PASS (1.32 MB base64 of gzip)
 *   - Deserialization heap < 72MB: PASS (~24.7 MB peak, ~2.6 MB retained)
 */

// Types
export type {
  FlyWireSubgraph,
  FlyWireConnectomeOptions,
  FlyWireArtifactMeta,
} from "./types.js";

export { FlyWireLayer, FlyWireNT, NT_NAMES, LAYER_NAMES } from "./types.js";

// Decoder
export {
  decodePayload,
  decompressBase64Gzip,
  decodeFlyWireArtifact,
  decodeBase64Raw,
} from "./decoder.js";

// Generator
export {
  buildFromFlyWire,
  subgraphStats,
  DEFAULT_FLYWIRE_OPTIONS,
} from "./generator.js";

// Artifact cache (Node-only: uses node:fs/zlib) — NOT re-exported here to avoid pulling Node
// types into the Workers typecheck when trader-worker resolves @fly/fly-brain.
// In Node contexts (tests/scripts), import directly:
//   import { getSubgraphSync } from "./artifact-cache.js";
// In Workers (trader-worker), use the local flywire-loader.ts which reads from R2 + DecompressionStream.
