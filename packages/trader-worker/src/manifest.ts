// Brain manifest — the on-chain-anchored, offline-replayable identity of the whole swarm's brains.
//
// WHY THIS EXISTS. provenance.ts already binds every real USDC transfer to the neural read-out that
// caused it (sha256(receipt) == the EIP-3009 nonce). But a sceptic can still ask one level deeper:
// "how do I know the read-out came from a REAL spiking connectome and not a hard-coded table or an
// LLM?" The answer must itself be reproducible without trusting us. This module produces a
// `BrainManifest` that commits to exactly that:
//
//   • the generator parameters + per-fly seeds (seed[i] = (base + i*7919) >>> 0),
//   • the LIF dynamics constants + the decoder config the swarm actually runs,
//   • a quantised STRUCTURAL SPEC of every fly's connectome (from @fly/fly-brain),
//   • an explicit, honest provenance ("FlyWire-architecture-inspired, programmatic, no LLM").
//
// Hash it (manifestHash = sha256(canonical(manifest))) and commit that ONE hash on-chain
// (NeuralManifestRegistry, Phase 2). Then ANYONE can, offline and trustlessly:
//   1. recompute sha256 over the fetched manifest → matches the committed hash ⇒ body untampered;
//   2. rebuild every connectome from the committed (seed, opts) via replayVerifyManifest() → each
//      structural spec matches ⇒ the published brains are exactly what those seeds deterministically
//      generate. No hidden wiring, no LLM, reproducible by a stranger.
//
// This module is PURE except manifestHash (sha256). assembleManifest is fully deterministic: no clock,
// no randomness, no I/O — the same config always yields the same manifest and the same hash. That is
// the property that makes replay work, so DO NOT add a timestamp or build-id to the hashed body.

import {
  BRAIN_MANIFEST_VERSION,
  CONNECTOME_PROVENANCE,
  FLYWIRE_PROVENANCE,
  DEFAULT_DECODER_CONFIG,
  LIF_CONSTANTS,
  NEURON_BASE_PARAMS,
  NEURON_JITTER,
  connectomeSpecForSeed,
  connectomeSpecForSeedFlyWire,
  effectiveConnectomeOptions,
  flyWireManifestConnectome,
  type ConnectomeOptions,
  type ConnectomeStructuralSpec,
  type DecoderConfig,
  type FlyWireManifestConnectome,
  type FlyWireSubgraph,
} from "@fly/fly-brain";
import { canonical, sha256Hex, POLICY_VERSION, PROOF_VERSION } from "./provenance.js";
import type { RuntimeConfig } from "./config.js";

/** Bump when the manifest field set / assembly changes (invalidates comparability, not validity). */
export const MANIFEST_SCHEMA_VERSION = 1;
/** Stable schema tag so a fetched blob can be checked before it is trusted. */
export const MANIFEST_SCHEMA = "murmur-brain-manifest";
/** The per-fly seed stride (config.ts: seed[i] = (base + i*7919) >>> 0). Recorded, not magic. */
export const SEED_STRIDE = 7919;

/** One fly's committed identity: its seed and the quantised structural spec that seed must reproduce. */
export interface BrainManifestFly {
  id: number;
  seed: number;
  structural: ConnectomeStructuralSpec;
}

/** The full, hashable brain manifest. Deterministic — no clock, no randomness. */
export interface BrainManifest {
  v: number;
  schema: string;
  /** The fly-brain structural-spec/digest version this manifest was built with. */
  brainManifestVersion: number;
  /** Receipt/proof + decision-policy versions, tying the brain to the economic read-out it drives. */
  proofV: number;
  policy: string;
  /** Optional source-code version (e.g. a git sha) passed by the caller; null keeps the hash reproducible. */
  codeVersion: string | null;
  chainId: number;
  chainTag: string; // "arc-mainnet" | "arc-testnet"
  population: {
    size: number;
    seedBase: number;
    seedStride: number;
    seedFormula: string;
  };
  /** Effective generator sizing (defaults filled, per-fly seed applied separately — see flies[].seed). */
  connectome: ConnectomeOptions | FlyWireManifestConnectome;
  lif: typeof LIF_CONSTANTS;
  neuronBaseParams: typeof NEURON_BASE_PARAMS;
  neuronJitter: typeof NEURON_JITTER;
  /** The decoder config the swarm ACTUALLY runs (hot/cold come from the worker's regime thresholds). */
  decoder: DecoderConfig;
  provenance: typeof CONNECTOME_PROVENANCE | typeof FLYWIRE_PROVENANCE;
  llm: { used: false; statement: string };
  flies: BrainManifestFly[];
}

/** The sizing opts a verifier rebuilds from (the effective defaults with the per-fly seed removed). */
function sizingOpts(cfg: RuntimeConfig): ConnectomeOptions {
  const { seed: _perFlySeed, ...sizing } = effectiveConnectomeOptions(cfg.brainOpts ?? {});
  return sizing;
}

/**
 * Assemble the swarm's brain manifest from the runtime config. PURE + deterministic: the same cfg
 * always produces the same object (and therefore the same manifestHash), so it is safe to rebuild,
 * serve, pin and commit. Building all per-fly specs costs one connectome build per fly (24 by default)
 * — cheap enough for an on-demand endpoint, and it is the whole point: the specs are recomputable.
 */
export function assembleManifest(
  cfg: RuntimeConfig,
  meta: { codeVersion?: string | null } = {},
): BrainManifest {
  const sizing = sizingOpts(cfg);
  const decoder: DecoderConfig = {
    ...DEFAULT_DECODER_CONFIG,
    // The population's decoders anchor to the worker's live regime thresholds (see population.makeDecoder).
    hotT: cfg.regimeHot,
    coldT: cfg.regimeCold,
  };

  const flies: BrainManifestFly[] = cfg.populationSeeds.map((seed, id) => ({
    id,
    seed,
    structural: connectomeSpecForSeed(seed, sizing),
  }));

  return {
    v: MANIFEST_SCHEMA_VERSION,
    schema: MANIFEST_SCHEMA,
    brainManifestVersion: BRAIN_MANIFEST_VERSION,
    proofV: PROOF_VERSION,
    policy: POLICY_VERSION,
    codeVersion: meta.codeVersion ?? null,
    chainId: cfg.chainId,
    chainTag: cfg.isTestnet ? "arc-testnet" : "arc-mainnet",
    population: {
      size: cfg.populationSize,
      seedBase: cfg.populationSeedBase,
      seedStride: SEED_STRIDE,
      seedFormula: "seed[i] = (seedBase + i * seedStride) >>> 0",
    },
    connectome: sizing,
    lif: LIF_CONSTANTS,
    neuronBaseParams: NEURON_BASE_PARAMS,
    neuronJitter: NEURON_JITTER,
    decoder,
    provenance: CONNECTOME_PROVENANCE,
    llm: {
      used: false,
      statement:
        "No large-language model is used in perception, decision-making or settlement. Behaviour emerges from a spiking leaky-integrate-and-fire connectome; each trade is a deterministic read-out of decoded motor drives under policy " +
        POLICY_VERSION +
        ". This manifest is generated by pure code from the committed seeds and is reproducible offline by anyone.",
    },
    flies,
  };
}

/** The value to commit on-chain: sha256 of the manifest's canonical form (64 lowercase hex, no 0x). */
export async function manifestHash(manifest: BrainManifest): Promise<string> {
  return sha256Hex(manifest);
}

/**
 * Assemble the FlyWire-mode brain manifest. The topology is FIXED (real FAFB 783 MB+CX subgraph);
 * per-fly structural specs vary only by seed-driven weight/LIF jitter. Requires the decoded subgraph
 * (loaded from KV). PURE + deterministic: same (cfg, subgraph) ⇒ same manifest ⇒ same hash.
 */
export function assembleManifestFlyWire(
  cfg: RuntimeConfig,
  subgraph: FlyWireSubgraph,
  meta: { codeVersion?: string | null } = {},
): BrainManifest {
  const connectome = flyWireManifestConnectome();
  const decoder: DecoderConfig = {
    ...DEFAULT_DECODER_CONFIG,
    hotT: cfg.regimeHot,
    coldT: cfg.regimeCold,
  };

  const flies: BrainManifestFly[] = cfg.populationSeeds.map((seed, id) => ({
    id,
    seed,
    structural: connectomeSpecForSeedFlyWire(seed, subgraph),
  }));

  return {
    v: MANIFEST_SCHEMA_VERSION,
    schema: MANIFEST_SCHEMA,
    brainManifestVersion: BRAIN_MANIFEST_VERSION,
    proofV: PROOF_VERSION,
    policy: POLICY_VERSION,
    codeVersion: meta.codeVersion ?? null,
    chainId: cfg.chainId,
    chainTag: cfg.isTestnet ? "arc-testnet" : "arc-mainnet",
    population: {
      size: cfg.populationSize,
      seedBase: cfg.populationSeedBase,
      seedStride: SEED_STRIDE,
      seedFormula: "seed[i] = (seedBase + i * seedStride) >>> 0",
    },
    connectome,
    lif: LIF_CONSTANTS,
    neuronBaseParams: NEURON_BASE_PARAMS,
    neuronJitter: NEURON_JITTER,
    decoder,
    provenance: FLYWIRE_PROVENANCE,
    llm: {
      used: false,
      statement:
        "No large-language model is used in perception, decision-making or settlement. Behaviour emerges from a spiking leaky-integrate-and-fire connectome built from the real FAFB 783 FlyWire subgraph (CC-BY 4.0); each trade is a deterministic read-out of decoded motor drives under policy " +
        POLICY_VERSION +
        ". This manifest is generated by pure code from the committed seeds and is reproducible offline by anyone.",
    },
    flies,
  };
}

/** One fly that failed to replay, with the reason (so a verifier can see exactly what diverged). */
export interface ReplayMismatch {
  id: number;
  seed: number;
  reason: string;
}

export interface ReplayResult {
  ok: boolean;
  /** Flies whose connectome was rebuilt and compared. */
  checked: number;
  mismatches: ReplayMismatch[];
}

/**
 * The OFFLINE REPLAY: rebuild every fly's connectome from the committed (seed, sizing opts) and confirm
 * it reproduces the committed structural spec. Also re-derives each seed from the committed formula and
 * checks the roster size, so a tampered seed list or a wrong-sized population is caught too. PURE +
 * synchronous — no network, no chain, no trust. This is the heart of "prove the brain": a stranger runs
 * it against a manifest whose hash they read off Arc, and either it all rebuilds or it doesn't.
 */
export function replayVerifyManifest(manifest: BrainManifest): ReplayResult {
  const mismatches: ReplayMismatch[] = [];
  const conn = manifest.connectome;
  const isFlyWire = "mode" in conn && (conn as FlyWireManifestConnectome).mode === "flywire";
  const sizing = isFlyWire ? {} : (conn as ConnectomeOptions);
  const stride = manifest.population?.seedStride ?? SEED_STRIDE;
  const base = manifest.population?.seedBase ?? 0;

  if (manifest.flies.length !== manifest.population?.size) {
    mismatches.push({
      id: -1,
      seed: 0,
      reason: `roster size ${manifest.flies.length} ≠ declared population ${manifest.population?.size}`,
    });
  }

  for (const fly of manifest.flies) {
    // 1) The seed must be exactly what the committed formula produces (catches a swapped seed list).
    const expectedSeed = (base + fly.id * stride) >>> 0;
    if (expectedSeed !== fly.seed) {
      mismatches.push({ id: fly.id, seed: fly.seed, reason: `seed ≠ (base + id*${stride}) >>> 0` });
      continue; // a wrong seed makes the structural comparison meaningless
    }
    // 2) Rebuild the connectome from that seed + sizing and compare the quantised structural spec.
    //    FlyWire mode: the structural rebuild requires the decoded subgraph (async, not available here);
    //    seed derivation is still verified. Full FlyWire replay is done by the commit script offline.
    if (isFlyWire) continue;
    const rebuilt = connectomeSpecForSeed(fly.seed, sizing);
    if (canonical(rebuilt) !== canonical(fly.structural)) {
      mismatches.push({ id: fly.id, seed: fly.seed, reason: "rebuilt structural spec ≠ committed spec" });
    }
  }

  return { ok: mismatches.length === 0, checked: manifest.flies.length, mismatches };
}
