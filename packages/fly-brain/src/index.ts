export * from "./types.js";
export { LifNetwork } from "./lif.js";
export {
  buildConnectome,
  DEFAULT_CONNECTOME_OPTIONS,
  MOTOR_CHANNEL_LIST,
  SENSORY_CHANNEL_LIST,
  type ConnectomeOptions,
} from "./connectome.js";
export { FlyBrain, type FlyBrainOptions } from "./fly-brain.js";
export {
  MotorDecoder,
  DEFAULT_DECODER_CONFIG,
  DEFAULT_DECODER_OPTIONS,
  neuralFingerprint,
  readRawDrives,
  computeBands,
  REF_BANDS,
  REF_BANDS_FLYWIRE,
  type DecoderConfig,
  type DecoderOptions,
  type RawDrives,
  type PopulationBands,
} from "./motor-decoder.js";
export {
  computeNeuromod,
  neuromodPartition,
  NEUROMOD_CONFIG,
  NEUTRAL_NEUROMOD,
} from "./neuromod.js";
export {
  Ethogram,
  ETHOGRAM_CONFIG,
  ETHOGRAM_MOTIFS,
  FAP_DOMINANCE,
  FAP_LIST,
  FAP_ROLE,
  computeValence,
  selectFap,
  type EthogramDrives,
} from "./ethogram.js";
export {
  encodeMarketPulse,
  encodeStimulus,
  type MarketPulse,
  type StimulusEvent,
} from "./stimuli.js";
export {
  BRAIN_MANIFEST_VERSION,
  CONNECTOME_PROVENANCE,
  FLYWIRE_PROVENANCE,
  LIF_CONSTANTS,
  NEURON_BASE_PARAMS,
  NEURON_JITTER,
  connectomeStructuralSpec,
  connectomeSpecForSeed,
  connectomeSpecForSeedFlyWire,
  effectiveConnectomeOptions,
  flyWireManifestConnectome,
  type ConnectomeStructuralSpec,
  type FlyWireManifestConnectome,
} from "./manifest.js";
export {
  GENOME_SCHEMA_VERSION,
  GENOME_BOUNDS,
  FLYWIRE_GENOME_BOUNDS,
  FLYWIRE_DEFAULTS,
  canonicalGenome,
  genomeFromOptions,
  genomeFromSeed,
  mutateGenome,
  mutateGenomeFlyWire,
  crossoverGenome,
  crossoverGenomeFlyWire,
  buildFromGenome,
  buildFromGenomeFlyWire,
  genomeToConnectomeOptions,
  genomeToFlyWireOptions,
  specFromGenome,
  estimateConnectomeSize,
  estimateFlyWireConnectomeSize,
  hatchBudgetFromGenesis,
  genomeWithinBudget,
  type Genome,
  type HatchBudget,
} from "./genome.js";

// FlyWire connectome-data module (real FAFB 783 topology)
export {
  buildFromFlyWire,
  subgraphStats,
  DEFAULT_FLYWIRE_OPTIONS,
  decodePayload,
  decodeFlyWireArtifact,
  decompressBase64Gzip,
  FlyWireLayer,
  FlyWireNT,
  NT_NAMES,
  LAYER_NAMES,
  type FlyWireSubgraph,
  type FlyWireConnectomeOptions,
  type FlyWireArtifactMeta,
} from "./connectome-data/index.js";
// Node-only artifact cache (tests/scripts) — NOT re-exported here to avoid pulling node:fs into
// the Workers typecheck. Import directly from "@fly/fly-brain/src/connectome-data/artifact-cache.js"
// in Node contexts, or use the worker-side loader in trader-worker.
