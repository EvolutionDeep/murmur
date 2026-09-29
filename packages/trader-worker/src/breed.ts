// Connectome BREEDING market — worker-side genetics + the lineage store.
//
// The genetic primitives live in @fly/fly-brain (genome.ts): a Genome is the effective generator
// parameters that deterministically rebuild one connectome, and mutate/crossover are pure in
// (parents, rngSeed). This module adds the worker-only pieces:
//   • genomeHash  — sha256(canonicalGenome(genome)), the identity committed on-chain (ConnectomeLineage).
//   • LineageEntry— a genome + its ancestry (parents, op, generation, breeder, rngSeed) as served by
//                   GET /lineage and GET /lineage/:hash, and persisted in the coordinator DO.
//   • genesisLineage — the base population's genomes (the 24 manifest seeds) as generation-0 roots.
//   • applyBreed  — validate a breed request against the existing lineage and produce the offspring
//                   entry (generation = max(parents)+1), refusing duplicates.
//
// Determinism is the product: because (parents, rngSeed) ⇒ the same offspring genome, anyone can refetch
// an entry, recompute its hash, and rebuild the exact brain offline (specFromGenome) — the same
// trustless-replay story as the brain manifest, now per-bred-individual.

import {
  canonicalGenome,
  crossoverGenome,
  crossoverGenomeFlyWire,
  genomeFromSeed,
  mutateGenome,
  mutateGenomeFlyWire,
  specFromGenome,
  mutateTree,
  crossoverTrees,
  treeHash as gpTreeHash,
  FLYWIRE_GENOME_BOUNDS,
  FLYWIRE_DEFAULTS,
  type Genome,
  type ConnectomeStructuralSpec,
  type StrategyTree,
} from "@fly/fly-brain";
import type { RuntimeConfig } from "./config.js";

// --- Phase 3 capability ③: Lamarckian genome imprinting (deterministic; no Math.random, no Date.now) ---
const LAMARCK_MAX = 0.05;          // ±5% max multiplicative bias on a genome scalar (the heritable imprint ceiling)
const LAMARCK_JITTER = 0.01;       // ±1% deterministic rngSeed jitter layered on the bias (breaks sibling ties)
const LAMARCK_SALT = 0x6c616d61;   // "lama" — FNV salt for the per-field jitter draw (matches economy.ts)

/** The 4 heritable FlyWire genome scalars a Lamarckian imprint may bias (topology/seed are NEVER touched). */
const IMPRINT_FIELDS = ["weightGain", "threshGain", "tauGain", "weightJitter"] as const;
type ImprintField = (typeof IMPRINT_FIELDS)[number];

/**
 * A bounded signed performance vector in [−1,1]^4 derived by the economy from a PARENT's lifetime record
 * (economy.lamarckVector). Each component steers one genome scalar: positive ⇒ bias up, negative ⇒ bias down.
 */
export interface GenomeImprint {
  weightGain: number;
  threshGain: number;
  tauGain: number;
  weightJitter: number;
}

/** FNV-1a 32-bit over three integers — the same deterministic hash the economy uses (self-contained here). */
function imprintHash32(a: number, b: number, c: number): number {
  let h = 0x811c9dc5;
  const mix = (x: number) => {
    for (let s = 0; s < 32; s += 8) { h = Math.imul(h ^ ((x >>> s) & 0xff), 0x01000193) >>> 0; }
  };
  mix(a >>> 0); mix(b >>> 0); mix(c >>> 0);
  return h >>> 0;
}

function imprintRound4(x: number): number { return Math.round(x * 10000) / 10000; }
function imprintClamp(x: number, lo: number, hi: number): number { return x < lo ? lo : x > hi ? hi : x; }

/**
 * Apply a Lamarckian imprint to a child genome's 4 heritable scalars, ON TOP of the mutate/cross output.
 * For each field: multiplier = 1 + LAMARCK_MAX·signed + jitter, where `signed` is the parent-performance bias
 * clamped to [−1,1] and `jitter` is a small deterministic ±LAMARCK_JITTER draw from (rngSeed, fieldIndex). The
 * result is clamped back into FLYWIRE_GENOME_BOUNDS and rounded to 4 decimals — so an imprint can NEVER push a
 * scalar outside its legal range and NEVER touches seed/topology (manifestHash invariant holds). Pure in
 * (genome, vector, rngSeed): the same inputs always yield the same imprinted genome, so the folded genomeHash
 * stays reproducible by anyone re-running the breed.
 */
function applyLamarckImprint(g: Genome, vec: GenomeImprint, rngSeed: number): Genome {
  const out: Genome = { ...g };
  for (let i = 0; i < IMPRINT_FIELDS.length; i++) {
    const f: ImprintField = IMPRINT_FIELDS[i];
    const bounds = FLYWIRE_GENOME_BOUNDS[f];
    const current = out[f] ?? FLYWIRE_DEFAULTS[f];
    const signed = imprintClamp(Number(vec[f]) || 0, -1, 1);
    const jitter = (imprintHash32(rngSeed, i, LAMARCK_SALT) / 0xffffffff - 0.5) * 2 * LAMARCK_JITTER;
    const mult = 1 + LAMARCK_MAX * signed + jitter;
    out[f] = imprintRound4(imprintClamp(current * mult, bounds[0], bounds[1]));
  }
  return out;
}

/** Bump when the lineage record shape changes. */
export const LINEAGE_SCHEMA_VERSION = 1;

export type BreedOp = "genesis" | "mutate" | "cross";

/** One committed connectome individual + its ancestry. */
export interface LineageEntry {
  /** sha256(canonicalGenome(genome) [+ strategyTreeHash]), 64 lowercase hex (no 0x) — the on-chain identity. */
  genomeHash: string;
  /** The full genome body (served so anyone can rebuild + re-spec the brain offline). */
  genome: Genome;
  /** Parent genomeHashes: [] genesis, [a] mutate, [a,b] cross. */
  parents: string[];
  op: BreedOp;
  /** 0 for genesis roots; max(parents.generation)+1 otherwise. */
  generation: number;
  /** Address credited with breeding this individual (royalty payee); null for genesis roots. */
  breeder: string | null;
  /** The integer seed the genetic operator used — recorded so the offspring is reproducible. */
  rngSeed: number | null;
  /** ms epoch when bred (0 for genesis roots). */
  ts: number;
  /** On-chain ConnectomeLineage commit tx, when anchored; null otherwise. */
  commitTx: string | null;
  /**
   * Phase 2b (additive): the GP strategy tree hash (32 hex) carried by this individual. Folded into
   * genomeHash so the on-chain identity reflects BOTH connectome and strategy lineage. Absent on
   * pre-2b entries (genesis roots bred before the strategy layer existed) — those hashes stay valid.
   */
  strategyTreeHash?: string;
}

export interface BreedRequest {
  op: "mutate" | "cross";
  /** genomeHashes: exactly 1 for mutate, exactly 2 for cross. */
  parents: string[];
  /** Optional operator seed; omitted ⇒ derived from the clock but RECORDED on the entry. */
  rngSeed?: number;
  /** Optional breeder address to credit; omitted ⇒ null. */
  breeder?: string | null;
}

/**
 * sha256 of the genome's canonical bytes (64 lowercase hex, no 0x).
 * Phase 2b: when `strategyTreeHash` is provided, it is appended to the canonical genome string BEFORE
 * hashing, so the on-chain identity reflects BOTH connectome and strategy lineage. The OUTPUT FORMAT
 * is unchanged (bytes32 / 64 hex) — only the hash VALUE differs. Pre-2b entries (no treeHash) hash
 * exactly as before, so old receipts/lineage remain valid (backward compatible).
 */
export async function genomeHash(g: Genome, strategyTreeHash?: string): Promise<string> {
  const base = canonicalGenome(g);
  const input = strategyTreeHash ? base + "|" + strategyTreeHash : base;
  const bytes = new TextEncoder().encode(input);
  const dig = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(dig))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/** The base population as generation-0 lineage roots (one per manifest seed). */
export async function genesisLineage(cfg: RuntimeConfig): Promise<LineageEntry[]> {
  const out: LineageEntry[] = [];
  for (const seed of cfg.populationSeeds) {
    const genome = genomeFromSeed(seed, cfg.brainOpts);
    out.push({
      genomeHash: await genomeHash(genome),
      genome,
      parents: [],
      op: "genesis",
      generation: 0,
      breeder: null,
      rngSeed: null,
      ts: 0,
      commitTx: null,
    });
  }
  return out;
}

/**
 * Apply a breed request against the existing lineage. Validates arity + parent existence, runs the
 * pure operator, and returns the offspring entry. Throws on bad requests (caller maps to 400).
 *
 * When `opts.flywireTopology` is true, uses the FlyWire-mode operators (mutateGenomeFlyWire /
 * crossoverGenomeFlyWire) which mutate PARAMETERS (weightGain/threshGain/tauGain/weightJitter)
 * instead of layer sizes. Topology is fixed from the real FAFB 783 subgraph.
 *
 * Phase 2b: when `opts.parentTrees` is provided, the offspring inherits a MUTATED (or CROSSED) strategy
 * tree alongside its genome. The tree's hash is folded into genomeHash (on-chain format unchanged, only
 * the hash value differs) and recorded in `strategyTreeHash`. Without parentTrees, behaviour is identical
 * to pre-2b (no tree inheritance, genomeHash = sha256(canonicalGenome) exactly as before).
 */
export async function applyBreed(
  entries: LineageEntry[],
  req: BreedRequest,
  opts: {
    flywireTopology?: boolean;
    /** Parent strategy trees keyed by genomeHash (Phase 2b). Absent ⇒ no tree inheritance. */
    parentTrees?: Map<string, StrategyTree>;
    /** Tick index for deterministic tree mutation seed (Phase 2b). */
    tickIndex?: number;
    /**
     * Phase 3 capability ③ (Lamarckian): a parent-performance imprint vector + the seed for its jitter. When
     * present AND flywireTopology is on, the child's 4 genome scalars are biased ±5% (clamped to legal bounds)
     * ON TOP of mutate/cross, BEFORE genomeHash — so the on-chain identity reflects the imprint and stays
     * reproducible. Absent ⇒ the genome is exactly the mutate/cross output (byte-for-byte Phase 2b).
     */
    imprint?: { vector: GenomeImprint; rngSeed: number };
  } = {},
): Promise<LineageEntry> {
  const byHash = new Map(entries.map((e) => [e.genomeHash, e]));
  const rngSeed = (req.rngSeed ?? (Date.now() & 0xffffffff)) >>> 0;
  const flywire = opts.flywireTopology === true;
  const tick = opts.tickIndex ?? 0;

  let child: Genome;
  let parents: string[];
  let generation: number;
  let op: BreedOp;
  let childTreeHash: string | undefined;

  if (req.op === "mutate") {
    if (req.parents.length !== 1) throw new Error("mutate needs exactly 1 parent");
    const p = byHash.get(req.parents[0]);
    if (!p) throw new Error(`unknown parent genome ${req.parents[0]}`);
    child = flywire ? mutateGenomeFlyWire(p.genome, rngSeed) : mutateGenome(p.genome, rngSeed);
    parents = [p.genomeHash];
    generation = p.generation + 1;
    op = "mutate";
    // Phase 2b: inherit + mutate the parent's strategy tree.
    const pTree = opts.parentTrees?.get(p.genomeHash);
    if (pTree) {
      const mutated = mutateTree(pTree, rngSeed, tick);
      childTreeHash = gpTreeHash(mutated);
    }
  } else if (req.op === "cross") {
    if (req.parents.length !== 2) throw new Error("cross needs exactly 2 parents");
    const a = byHash.get(req.parents[0]);
    const b = byHash.get(req.parents[1]);
    if (!a || !b) throw new Error("unknown parent genome in cross");
    child = flywire
      ? crossoverGenomeFlyWire(a.genome, b.genome, rngSeed)
      : crossoverGenome(a.genome, b.genome, rngSeed);
    parents = [a.genomeHash, b.genomeHash];
    generation = Math.max(a.generation, b.generation) + 1;
    op = "cross";
    // Phase 2b: crossover the parents' strategy trees (deterministic fallback to parent A on violation).
    const aTree = opts.parentTrees?.get(a.genomeHash);
    const bTree = opts.parentTrees?.get(b.genomeHash);
    if (aTree && bTree) {
      const crossed = crossoverTrees(aTree, bTree, rngSeed, tick);
      childTreeHash = gpTreeHash(crossed);
    } else if (aTree) {
      const mutated = mutateTree(aTree, rngSeed, tick);
      childTreeHash = gpTreeHash(mutated);
    }
  } else {
    throw new Error(`unsupported op ${String(req.op)}`);
  }

  // Phase 3 capability ③ (Lamarckian): bias the child's 4 heritable scalars by the parent-performance imprint,
  // ON TOP of mutate/cross and BEFORE hashing, so genomeHash folds the imprint in (identity stays reproducible).
  // FlyWire mode only — the 4 scalars are the heritable parameters there; PRNG mode varies layer sizes instead.
  if (opts.imprint && flywire) {
    child = applyLamarckImprint(child, opts.imprint.vector, (opts.imprint.rngSeed >>> 0));
  }

  // Phase 2b: fold the strategy tree hash into genomeHash (format unchanged: still bytes32 / 64 hex).
  const hash = await genomeHash(child, childTreeHash);
  if (byHash.has(hash)) throw new Error("offspring genome already in lineage");

  return {
    genomeHash: hash,
    genome: child,
    parents,
    op,
    generation,
    breeder: req.breeder ?? null,
    rngSeed,
    ts: Date.now(),
    commitTx: null,
    ...(childTreeHash ? { strategyTreeHash: childTreeHash } : {}),
  };
}

/** Rebuild + re-spec the brain an entry describes (the per-individual trustless replay). */
export function replayEntry(entry: LineageEntry): ConnectomeStructuralSpec {
  return specFromGenome(entry.genome);
}

/** Recompute an entry's hash from its genome body (tamper-check for served entries). */
export async function verifyEntryHash(entry: LineageEntry): Promise<boolean> {
  return (await genomeHash(entry.genome)) === entry.genomeHash;
}
