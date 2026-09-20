// Connectome GENOME + genetic operators — the deterministic core of murmur's breeding market.
//
// WHAT A GENOME IS. A connectome built by buildConnectome(seed, opts) is fully reproducible (integer
// mulberry32 PRNG ⇒ bit-identical on every JS engine). So the COMPLETE heritable identity of one brain
// is just its EFFECTIVE generator parameters: (seed, per-layer counts, density). We call that tuple a
// `Genome`. It is small, JSON-serialisable, and — crucially — anyone can rebuild the exact brain from
// it offline (buildFromGenome) and re-derive its quantised structural spec (specFromGenome), exactly
// like the brain-manifest replay does for the base population.
//
// BREEDING. mutateGenome / crossoverGenome are PURE functions of (parents, rngSeed): the same parents +
// the same integer rngSeed always yield the same offspring genome. That determinism is what lets an
// offspring be committed on-chain by hash and re-derived by a stranger (see ConnectomeLineage.sol and
// the worker's /lineage endpoints). No randomness is hidden: the rngSeed is part of the lineage record.
//
// This module is PURE and SYNCHRONOUS (no crypto, no I/O) so it runs identically in a Worker, in Node
// tests, in a browser and in an offline CLI — mirroring manifest.ts's discipline. Hashing a genome
// (sha256 of canonicalGenome) lives in the worker (breed.ts), which has crypto.subtle.

import { buildConnectome, type ConnectomeOptions } from "./connectome.js";
import {
  connectomeStructuralSpec,
  effectiveConnectomeOptions,
  type ConnectomeStructuralSpec,
} from "./manifest.js";
import type { Connectome } from "./types.js";

/** Bump when the genome field set / operator semantics change (invalidates comparability). */
export const GENOME_SCHEMA_VERSION = 1;

/**
 * The complete heritable identity of one connectome: the effective generator parameters. Two genomes
 * that are equal produce equal brains; different genomes produce different brains.
 */
export interface Genome {
  v: number;
  /** uint32 PRNG seed — the wiring identity. */
  seed: number;
  nSensory: number;
  nInterL1: number;
  nInterL2: number;
  nModulatory: number;
  nMotorPerChannel: number;
  /** Synapse density fraction (0,1]; rounded to 4dp by operators to stay canonical-stable. */
  density: number;
}

/** Sane breeding bounds so offspring stay buildable on the edge (never 0-size, never absurd). */
export const GENOME_BOUNDS = {
  nSensory: [8, 2000],
  nInterL1: [8, 4000],
  nInterL2: [8, 4000],
  nModulatory: [4, 2000],
  nMotorPerChannel: [1, 500],
  density: [0.0005, 0.2],
} as const;

const SIZE_FIELDS = ["nSensory", "nInterL1", "nInterL2", "nModulatory", "nMotorPerChannel"] as const;
type SizeField = (typeof SIZE_FIELDS)[number];

/** Integer-only mulberry32 (bit-identical across engines). Local copy: genome.ts must stay dependency-free. */
function mulberry32(a: number): () => number {
  let t = a >>> 0;
  return () => {
    t = (t + 0x6d2b79f5) >>> 0;
    let r = Math.imul(t ^ (t >>> 15), 1 | t);
    r = (r + Math.imul(r ^ (r >>> 7), 61 | r)) ^ r;
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
  };
}

function clampInt(x: number, lo: number, hi: number): number {
  if (!Number.isFinite(x)) return lo;
  return Math.max(lo, Math.min(hi, Math.floor(x)));
}
function clamp(x: number, lo: number, hi: number): number {
  return x < lo ? lo : x > hi ? hi : x;
}
function round4(x: number): number {
  return Math.round(x * 1e4) / 1e4;
}

/** Recursive sorted-key JSON (canonical form). Mirrors the worker's provenance canonical, locally. */
function canonicalJson(v: unknown): string {
  if (v === null || typeof v !== "object") return JSON.stringify(v);
  if (Array.isArray(v)) return "[" + v.map(canonicalJson).join(",") + "]";
  const o = v as Record<string, unknown>;
  const keys = Object.keys(o).sort();
  return "{" + keys.map((k) => JSON.stringify(k) + ":" + canonicalJson(o[k])).join(",") + "}";
}

/** The byte-stable form a genome hash is taken over: canonicalGenome(g). Deterministic. */
export function canonicalGenome(g: Genome): string {
  return canonicalJson(g);
}

/** Lift generator opts (defaults filled) into a Genome. The base population's genomes come from here. */
export function genomeFromOptions(opts: ConnectomeOptions = {}): Genome {
  const e = effectiveConnectomeOptions(opts);
  return {
    v: GENOME_SCHEMA_VERSION,
    seed: e.seed >>> 0,
    nSensory: e.nSensory,
    nInterL1: e.nInterL1,
    nInterL2: e.nInterL2,
    nModulatory: e.nModulatory,
    nMotorPerChannel: e.nMotorPerChannel,
    density: round4(e.density),
  };
}

/** Convenience: a genome for one seed over shared sizing opts. */
export function genomeFromSeed(seed: number, opts: ConnectomeOptions = {}): Genome {
  return genomeFromOptions({ ...opts, seed });
}

/**
 * POINT MUTATION: reseed the wiring and perturb exactly one layer count (± up to ~15%), with a small
 * chance of density drift. Pure in (parent, rngSeed).
 */
export function mutateGenome(parent: Genome, rngSeed: number): Genome {
  const rng = mulberry32(rngSeed >>> 0);
  const child: Genome = { ...parent, v: GENOME_SCHEMA_VERSION };
  child.seed = (parent.seed ^ Math.floor(rng() * 4294967296)) >>> 0;
  const f: SizeField = SIZE_FIELDS[Math.floor(rng() * SIZE_FIELDS.length)];
  const step = 1 + Math.floor(rng() * Math.max(1, Math.round(parent[f] * 0.15)));
  const delta = (rng() < 0.5 ? -1 : 1) * step;
  child[f] = clampInt(parent[f] + delta, GENOME_BOUNDS[f][0], GENOME_BOUNDS[f][1]);
  if (rng() < 0.5) {
    child.density = round4(
      clamp(parent.density + (rng() < 0.5 ? -0.001 : 0.001), GENOME_BOUNDS.density[0], GENOME_BOUNDS.density[1]),
    );
  }
  return child;
}

/**
 * UNIFORM CROSSOVER: each field is inherited from either parent (coin-flip per field via rngSeed); the
 * wiring seed is inherited whole from one parent (recombination, not blending). Pure in (a, b, rngSeed).
 */
export function crossoverGenome(a: Genome, b: Genome, rngSeed: number): Genome {
  const rng = mulberry32(rngSeed >>> 0);
  const pick = <T>(x: T, y: T): T => (rng() < 0.5 ? x : y);
  return {
    v: GENOME_SCHEMA_VERSION,
    seed: pick(a.seed, b.seed),
    nSensory: pick(a.nSensory, b.nSensory),
    nInterL1: pick(a.nInterL1, b.nInterL1),
    nInterL2: pick(a.nInterL2, b.nInterL2),
    nModulatory: pick(a.nModulatory, b.nModulatory),
    nMotorPerChannel: pick(a.nMotorPerChannel, b.nMotorPerChannel),
    density: round4(pick(a.density, b.density)),
  };
}

/** The ConnectomeOptions a genome describes — what FlyBrain / buildConnectome consume to rebuild it. */
export function genomeToConnectomeOptions(g: Genome): ConnectomeOptions {
  return {
    seed: g.seed,
    nSensory: g.nSensory,
    nInterL1: g.nInterL1,
    nInterL2: g.nInterL2,
    nModulatory: g.nModulatory,
    nMotorPerChannel: g.nMotorPerChannel,
    density: g.density,
  };
}

/** Rebuild the exact connectome a genome describes (deterministic). */
export function buildFromGenome(g: Genome): Connectome {
  return buildConnectome(genomeToConnectomeOptions(g));
}

/** The quantised, ULP-safe structural spec of the brain a genome describes (the replayable identity). */
export function specFromGenome(g: Genome): ConnectomeStructuralSpec {
  return connectomeStructuralSpec(buildFromGenome(g));
}

// ---------- resource envelope: screen a genome for LIVE-hatch safety WITHOUT building it ----------
//
// A bred genome may be heavier than genesis (mutate grows a layer ±15%, density drifts up), so before one
// is hatched into a live trading fly we estimate the connectome it WOULD build and refuse it if it is too
// big — building it first is exactly what could OOM the isolate. Two independent Durable Object limits
// bind, so the estimate returns both counts:
//   · neurons  → serialized size (FlyBrain.serialize stores ~6 per-neuron float arrays; ∝ neurons), bounded
//                by the 2 MB per-value limit (a shard persists 2 brains in one value);
//   · synapses → retained heap (buildConnectome keeps a full Synapse[] object array; ∝ density), bounded by
//                the 128 MB isolate heap (2 flies/shard).

/** MOTOR_CHANNELS.length in connectome.ts — mirrored so the estimator stays dependency-free. */
const MOTOR_CHANNEL_COUNT = 5;
/** SENSORY_CHANNELS.length — a sensory neuron's channel is (i % this). */
const SENSORY_CHANNEL_COUNT = 10;
/** Index of gustatory_richness in SENSORY_CHANNELS (drives the fixed proboscis reflex fan). */
const GUSTATORY_INDEX = 4;
/** Index of stimulus_threat in SENSORY_CHANNELS (drives the threat→modulatory wiring). */
const THREAT_INDEX = 7;

/** How many i in [0,n) satisfy (i % mod) === r — the neuron count of one sensory channel. */
function channelCount(n: number, r: number, mod: number): number {
  if (n <= r) return 0;
  return Math.floor((n - r - 1) / mod) + 1;
}

/**
 * Closed-form estimate of the connectome a genome builds — {neurons, synapses} — WITHOUT building it.
 * Mirrors buildConnectome's exact fan-in arithmetic (the same fixed fans for the leg/wing/proboscis
 * reflexes, the same max(1, floor(fromSize*density)) fans for the layered projections, and expected
 * counts for the probabilistic modulatory/threat wiring), so it tracks the real graph closely and rounds
 * UP to stay conservative (a slightly-over estimate only means a borderline genome stays lineage-only).
 */
export function estimateConnectomeSize(g: Genome): { neurons: number; synapses: number } {
  const nSens = Math.max(0, Math.floor(g.nSensory));
  const nL1 = Math.max(0, Math.floor(g.nInterL1));
  const nL2 = Math.max(0, Math.floor(g.nInterL2));
  const nMod = Math.max(0, Math.floor(g.nModulatory));
  const nMotorPer = Math.max(0, Math.floor(g.nMotorPerChannel));
  const d = Math.max(0, g.density);

  const l2Half = Math.floor(nL2 / 2);
  const l2Right = nL2 - l2Half;
  const neurons = nSens + nL1 + nL2 + nMod + MOTOR_CHANNEL_COUNT * nMotorPer;

  // Same fan-in rule the builder's connect() uses.
  const fan = (fromSize: number, dens: number): number => Math.max(1, Math.floor(fromSize * dens));

  let syn = 0;
  syn += nL1 * fan(nSens, d * 1.5);          // sensory → Inter L1
  syn += nL2 * fan(nL1, d * 1.2);            // Inter L1 → Inter L2
  syn += l2Right * fan(l2Half, d * 0.8);     // L2 left → right (mutual inhibition)
  syn += l2Half * fan(l2Right, d * 0.8);     // L2 right → left
  syn += l2Half * fan(l2Half, d * 0.3);      // L2 left → left (same-side excitation)
  syn += l2Right * fan(l2Right, d * 0.3);    // L2 right → right
  syn += nMotorPer * 40;                     // L2 left → leg_left (fixed fan 40)
  syn += nMotorPer * 40;                     // L2 right → leg_right (fixed fan 40)
  syn += 2 * nMotorPer * 30;                 // L2 → wing + abdomen (fixed fan 30)
  const gus = channelCount(nSens, GUSTATORY_INDEX, SENSORY_CHANNEL_COUNT);
  syn += nMotorPer * Math.max(1, Math.min(gus, 6)); // gustatory → proboscis (fixed fan ≤6)
  syn += Math.ceil(0.05 * neurons);          // modulatory ↔ whole brain (p=0.05 per neuron)
  syn += nMod * fan(nSens + nL1, d * 0.4);   // sensory+L1 → modulatory
  const threat = channelCount(nSens, THREAT_INDEX, SENSORY_CHANNEL_COUNT);
  syn += Math.ceil(threat * nMod * 0.25);    // stimulus_threat → modulatory (p=0.25)

  return { neurons, synapses: syn };
}

/** A resource envelope a genome must fit to be hatched into a LIVE fly (see estimateConnectomeSize). */
export interface HatchBudget {
  maxNeurons: number;
  maxSynapses: number;
}

/**
 * Derive the hatch budget from the GENESIS connectome sizing (the worker's brainOpts) times safety
 * factors, so the envelope auto-calibrates to whatever production actually runs instead of hardcoding
 * neuron/synapse counts. Genesis is proven to fit 2 flies/shard within BOTH DO limits, and the factors
 * leave real evolutionary headroom while staying well inside them: 1.2× neurons keeps 2 serialized
 * brains under the 2 MB value limit; 2.0× synapses keeps 2 retained connectomes well under 128 MB.
 */
export function hatchBudgetFromGenesis(
  genesisOpts: ConnectomeOptions = {},
  factors: { neurons: number; synapses: number } = { neurons: 1.2, synapses: 2.0 },
): HatchBudget {
  const g = estimateConnectomeSize(genomeFromOptions(genesisOpts));
  return {
    maxNeurons: Math.ceil(g.neurons * factors.neurons),
    maxSynapses: Math.ceil(g.synapses * factors.synapses),
  };
}

/** True when a genome's estimated connectome fits the budget (both the serialization and heap limits). */
export function genomeWithinBudget(g: Genome, budget: HatchBudget): boolean {
  const s = estimateConnectomeSize(g);
  return s.neurons <= budget.maxNeurons && s.synapses <= budget.maxSynapses;
}
