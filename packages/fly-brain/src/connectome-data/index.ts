/**
 * FlyWire/FAFB real connectome subgraph — deterministic generator module.
 *
 * This module provides the offline infrastructure for using REAL fruit-fly brain
 * wiring data (from the FAFB 783 / FlyWire connectome) instead of the current
 * procedural random generator in connectome.ts.
 *
 * ARCHITECTURE:
 *   1. Offline extraction (Python): FAFB 783 → MB+CX subgraph → compressed binary artifact
 *   2. Decoder (this module): base64+gzip → typed arrays (FlyWireSubgraph)
 *   3. Generator (this module): FlyWireSubgraph + seed → Connectome (5-layer compatible)
 *
 * CURRENT STATUS (Task 57, A2 offline):
 *   - NOT connected to production buildConnectome / manifest
 *   - flywireLiteral remains false in manifest.ts
 *   - manifestHash is NOT rotated
 *   - Integration is Step 3 (A2 online)
 *
 * DATA PROVENANCE:
 *   Dataset: FAFB_783 (FlyWire adult female brain, compiled 2026-04)
 *   Source: Lee Lab GCS bucket (public access)
 *   License: CC-BY 4.0
 *   Subgraph: Mushroom Body + Central Complex + olfactory PN input + descending output
 *   Scale: ~10,361 neurons, ~467k synapses (min synapse count ≥ 2)
 *   NT predictions: Eckstein et al. 2024 (Cell)
 *
 * CONSTRAINTS VERIFIED:
 *   - Neurons < 30,800 production budget: PASS (10,361)
 *   - Compressed artifact < 2MB: PASS (1.38 MB base64 of gzip)
 *   - Deserialization heap < 72MB: PASS (~2.6 MB estimated)
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
