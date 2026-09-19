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

/** Rebuild the exact connectome a genome describes (deterministic). */
export function buildFromGenome(g: Genome): Connectome {
  return buildConnectome({
    seed: g.seed,
    nSensory: g.nSensory,
    nInterL1: g.nInterL1,
    nInterL2: g.nInterL2,
    nModulatory: g.nModulatory,
    nMotorPerChannel: g.nMotorPerChannel,
    density: g.density,
  });
}

/** The quantised, ULP-safe structural spec of the brain a genome describes (the replayable identity). */
export function specFromGenome(g: Genome): ConnectomeStructuralSpec {
  return connectomeStructuralSpec(buildFromGenome(g));
}
