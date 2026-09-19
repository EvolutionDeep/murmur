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
  genomeFromSeed,
  mutateGenome,
  specFromGenome,
  type Genome,
  type ConnectomeStructuralSpec,
} from "@fly/fly-brain";
import type { RuntimeConfig } from "./config.js";

/** Bump when the lineage record shape changes. */
export const LINEAGE_SCHEMA_VERSION = 1;

export type BreedOp = "genesis" | "mutate" | "cross";

/** One committed connectome individual + its ancestry. */
export interface LineageEntry {
  /** sha256(canonicalGenome(genome)), 64 lowercase hex (no 0x) — the on-chain identity. */
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

/** sha256 of the genome's canonical bytes (64 lowercase hex, no 0x). */
export async function genomeHash(g: Genome): Promise<string> {
  const bytes = new TextEncoder().encode(canonicalGenome(g));
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
 */
export async function applyBreed(entries: LineageEntry[], req: BreedRequest): Promise<LineageEntry> {
  const byHash = new Map(entries.map((e) => [e.genomeHash, e]));
  const rngSeed = (req.rngSeed ?? (Date.now() & 0xffffffff)) >>> 0;

  let child: Genome;
  let parents: string[];
  let generation: number;
  let op: BreedOp;

  if (req.op === "mutate") {
    if (req.parents.length !== 1) throw new Error("mutate needs exactly 1 parent");
    const p = byHash.get(req.parents[0]);
    if (!p) throw new Error(`unknown parent genome ${req.parents[0]}`);
    child = mutateGenome(p.genome, rngSeed);
    parents = [p.genomeHash];
    generation = p.generation + 1;
    op = "mutate";
  } else if (req.op === "cross") {
    if (req.parents.length !== 2) throw new Error("cross needs exactly 2 parents");
    const a = byHash.get(req.parents[0]);
    const b = byHash.get(req.parents[1]);
    if (!a || !b) throw new Error("unknown parent genome in cross");
    child = crossoverGenome(a.genome, b.genome, rngSeed);
    parents = [a.genomeHash, b.genomeHash];
    generation = Math.max(a.generation, b.generation) + 1;
    op = "cross";
  } else {
    throw new Error(`unsupported op ${String(req.op)}`);
  }

  const hash = await genomeHash(child);
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
