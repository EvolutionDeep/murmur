// MAP-Elites novelty archive — Phase 2b, capability ② (open-ended evolution).
//
// THE IDEA. Natural selection on PnL alone converges fast and loses behavioural diversity. A MAP-Elites
// archive keeps the BEST individual in each region of a low-dimensional BEHAVIOUR SPACE, so evolution
// explores multiple viable strategies simultaneously. When planEvolution picks a parent, it can draw from
// an under-occupied or low-quality cell (novelty search) instead of always the PnL champion — producing
// offspring that explore new niches while still requiring netUsdc > 0 (the hard profitability gate).
//
// BEHAVIOUR DESCRIPTORS (3-D, deterministic, r6 fixed-point):
//   dim 0 — mean arousal band (average of all live flies' arousal readings)
//   dim 1 — settle rate (settleOk / totalSettleAttempts per agent lifetime)
//   dim 2 — good-preference Shannon entropy (how uniformly an agent trades across the 4 goods)
//
// ARCHIVE BOUNDS. 4 bins × 4 bins × 4 bins = 64 cells maximum. Each cell stores at most one elite
// (~100 bytes), so the full archive is ≤6.4 KB — well within the DO storage budget.
//
// DETERMINISM. All randomness is FNV-1a hash01 (same as economy.ts); no Math.random, no Date.now in
// decisions or serialized state. The archive is purely additive to the existing persistence blob.
//
// PHASE 4 EXTENSIBILITY. The selection function accepts a `ScoringFn` callback so Phase 4 can plug in
// multi-objective fitness (NSGA-II crowding distance, tournament selection) without rewriting the archive
// structure. The archive cell stores an opaque `fitness` number that the scorer defines.
//
// PHASE 4 (capability ④) LANDED: `tournamentSelectParent` below is the tournament-selection draw. It samples
// K candidates WITHOUT replacement via hash01 and resolves the winner through the SAME `ScoringFn` callback
// the cell-contest uses — so a multi-objective scorer (see mofit.ts) injected by the caller governs BOTH cell
// occupancy and parent choice. No Math.random, no Date.now: same (tickIndex, callIndex, candidates) ⇒ same
// winner, byte-for-byte.

import type { MofitVector } from "./mofit.js";

/** FNV-1a 32-bit hash (identical to economy.ts internal hash32 — byte-for-byte deterministic). */
function hash32(a: number, b: number, c: number): number {
  let h = 0x811c9dc5;
  const mix = (x: number) => {
    for (let s = 0; s < 32; s += 8) { h = Math.imul(h ^ ((x >>> s) & 0xff), 0x01000193) >>> 0; }
  };
  mix(a >>> 0); mix(b >>> 0); mix(c >>> 0);
  return h >>> 0;
}

/** Uniform [0,1) draw from (a, b, salt) — deterministic, no Date.now/Math.random. */
function hash01(a: number, b: number, salt: number): number {
  return hash32(a, b, salt) / 0xffffffff;
}

// ---------- Constants ----------

/** Number of bins per dimension. 4×4×4 = 64 cells (within ≤96 budget). */
export const BINS_PER_DIM = 4;
/** Total cells in the archive. */
export const ARCHIVE_CELLS = BINS_PER_DIM * BINS_PER_DIM * BINS_PER_DIM;
/** Salt for novelty cell draws. */
const SALT_ELITES = 0x454c4954; // "ELIT"
/** Salt for Phase 4 tournament draws ("TRNM") — a disjoint stream so a tournament draw never aliases a novelty draw. */
const SALT_TOURNAMENT = 0x54524e4d; // "TRNM"

// ---------- Behaviour descriptor binning ----------

/**
 * Bin an arousal value [0..1] into 0..3 (4 equal bands).
 * r6 input: the caller passes Math.trunc(arousal * 1e6); we bin on the integer.
 */
export function binArousal(arousalR6: number): number {
  // arousal ∈ [0, R6_SCALE]; 4 bins of 250_000 each
  const b = Math.floor(arousalR6 / 250_000);
  return Math.max(0, Math.min(BINS_PER_DIM - 1, b));
}

/**
 * Bin a settle rate [0..1] into 0..3 (4 equal bands).
 * Input: r6 integer = Math.trunc(settleOk / total * 1e6).
 */
export function binSettleRate(rateR6: number): number {
  const b = Math.floor(rateR6 / 250_000);
  return Math.max(0, Math.min(BINS_PER_DIM - 1, b));
}

/**
 * Bin Shannon entropy of good-preference distribution [0..2] into 0..3.
 * Max entropy for 4 goods = log2(4) = 2.0. Input: r6 integer = Math.trunc(entropy * 1e6).
 * Bins: [0, 0.5), [0.5, 1.0), [1.0, 1.5), [1.5, 2.0].
 */
export function binEntropy(entropyR6: number): number {
  const b = Math.floor(entropyR6 / 500_000);
  return Math.max(0, Math.min(BINS_PER_DIM - 1, b));
}

/** Compute the flat cell index from three bin coordinates. */
export function cellIndex(aBin: number, sBin: number, eBin: number): number {
  return aBin * BINS_PER_DIM * BINS_PER_DIM + sBin * BINS_PER_DIM + eBin;
}

// ---------- Archive entry ----------

/** One elite stored in a behaviour cell. */
export interface EliteEntry {
  /** Agent id of the current occupant. */
  agentId: number;
  /** Fitness value (netUsdc for Phase 2b; Phase 4 may use multi-objective crowding distance). */
  fitness: number;
  /** The strategy treeHash (32 hex) of the occupant at insertion time. */
  treeHash: string;
  /** Tick when this elite was inserted/last replaced. */
  tick: number;
  /** Behaviour descriptor bins [arousal, settleRate, entropy] for introspection. */
  bins: [number, number, number];
}

// ---------- Archive ----------

/**
 * A parent-selection candidate. Phase 4 (additive): `vec` optionally carries the normalized multi-objective
 * fitness vector (mofit.ts) for evidence/introspection — the selection itself compares the opaque scalar
 * `fitness` through the injected ScoringFn, exactly like the cell contest does.
 */
export interface ParentCandidate {
  agentId: number;
  fitness: number;
  bins: [number, number, number];
  vec?: MofitVector;
}

/**
 * The MAP-Elites archive: a bounded grid of behaviour cells, each holding at most one elite.
 * Pure data structure — no side effects, no storage access, no randomness.
 *
 * PHASE 4 EXTENSION POINT: `fitness` in EliteEntry is opaque; a multi-objective scorer can replace
 * the scalar with crowding distance or hypervolume contribution without changing the archive shape.
 * The `ScoringFn` type below is the plug-point.
 */
export type ScoringFn = (entry: EliteEntry, candidate: EliteEntry) => boolean;

/** Default scorer: higher fitness wins the cell. */
export const defaultScoring: ScoringFn = (incumbent, candidate) => candidate.fitness > incumbent.fitness;

export class ElitesArchive {
  private cells = new Map<number, EliteEntry>();

  /** Number of occupied cells. */
  get occupied(): number { return this.cells.size; }

  /** Get the elite in a cell (or undefined). */
  get(cell: number): EliteEntry | undefined { return this.cells.get(cell); }

  /** All occupied entries. */
  entries(): IterableIterator<[number, EliteEntry]> { return this.cells.entries(); }

  /**
   * Attempt to insert a candidate into its behaviour cell.
   * Returns true if the candidate replaced the incumbent (or the cell was empty).
   */
  insert(candidate: EliteEntry, score: ScoringFn = defaultScoring): boolean {
    const ci = cellIndex(candidate.bins[0], candidate.bins[1], candidate.bins[2]);
    const incumbent = this.cells.get(ci);
    if (!incumbent || score(incumbent, candidate)) {
      this.cells.set(ci, candidate);
      return true;
    }
    return false;
  }

  /**
   * Select a parent for evolution using novelty pressure.
   *
   * Strategy: with probability `exploreRate`, pick an agent from an UNDER-OCCUPIED or EMPTY cell
   * (novelty search); otherwise pick the global best (exploitation). The draw is deterministic from
   * (tickIndex, callIndex, SALT_ELITES).
   *
   * Returns the agentId of the selected parent, or null if no elites qualify.
   *
   * PHASE 4 EXTENSION: this is where tournament selection / NSGA-II front ranking plugs in.
   * The function signature already accepts `candidates` (all eligible agents) so Phase 4 can
   * apply multi-objective ranking over the full pool.
   */
  selectParent(
    tickIndex: number,
    callIndex: number,
    exploreRate: number,
    candidates: Array<{ agentId: number; fitness: number; bins: [number, number, number] }>,
  ): number | null {
    if (candidates.length === 0) return null;

    const draw = hash01(tickIndex, callIndex, SALT_ELITES);
    if (draw < exploreRate) {
      // NOVELTY: prefer candidates whose cell is empty or low-fitness in the archive.
      const novel = candidates.filter((c) => {
        const ci = cellIndex(c.bins[0], c.bins[1], c.bins[2]);
        const inc = this.cells.get(ci);
        return !inc || inc.fitness < c.fitness;
      });
      if (novel.length > 0) {
        // Deterministic pick among novel candidates.
        const idx = Math.floor(hash01(tickIndex, callIndex + 1, SALT_ELITES) * novel.length);
        return novel[Math.min(idx, novel.length - 1)].agentId;
      }
    }
    // EXPLOITATION: pick the highest-fitness candidate.
    let best = candidates[0];
    for (let i = 1; i < candidates.length; i++) {
      if (candidates[i].fitness > best.fitness) best = candidates[i];
    }
    return best.agentId;
  }

  /**
   * PHASE 4 (capability ④) — TOURNAMENT SELECTION: sample `k` candidates WITHOUT replacement (deterministic
   * hash01 draws over the shrinking pool) and return the winner under the injected `ScoringFn` — the SAME
   * callback type that governs cell contests, so a multi-objective scorer plugs in here without the archive
   * knowing its shape. Ties resolve deterministically: strictly-greater replaces, otherwise the lower agentId
   * wins, so the result never depends on candidate ordering.
   *
   * Guarantees:
   *   • k ≤ 1 or a single candidate ⇒ degenerates to argmax under the scorer (a 1-way tournament).
   *   • k ≥ candidates.length ⇒ every candidate is sampled once — also argmax (full-pool tournament).
   *   • PURE: no mutation of the archive or the input; no Math.random; no Date.now. Same inputs ⇒ same winner.
   */
  tournamentSelectParent(
    tickIndex: number,
    callIndex: number,
    k: number,
    candidates: ParentCandidate[],
    score: ScoringFn = defaultScoring,
  ): number | null {
    if (candidates.length === 0) return null;
    const size = Math.max(1, Math.floor(k));
    // Sample WITHOUT replacement: each draw indexes into the shrinking pool (Fisher–Yates prefix, hash-gated).
    const pool = candidates.slice();
    const sampled: ParentCandidate[] = [];
    for (let s = 0; s < size && pool.length > 0; s++) {
      const draw = hash01(tickIndex, (callIndex << 8) + s, SALT_TOURNAMENT);
      const idx = Math.min(pool.length - 1, Math.floor(draw * pool.length));
      sampled.push(pool[idx]);
      pool.splice(idx, 1);
    }
    // Resolve the winner under the injected scorer. `score(incumbent, challenger) === true` means the
    // challenger takes the slot — the exact cell-contest semantics, reused for the tournament.
    let best = sampled[0];
    for (let i = 1; i < sampled.length; i++) {
      const c = sampled[i];
      const incumbentAsEntry = { agentId: best.agentId, fitness: best.fitness, treeHash: "", tick: 0, bins: best.bins };
      const challengerAsEntry = { agentId: c.agentId, fitness: c.fitness, treeHash: "", tick: 0, bins: c.bins };
      if (score(incumbentAsEntry, challengerAsEntry)) best = c;
      else if (c.fitness === best.fitness && c.agentId < best.agentId) best = c;   // deterministic tiebreak
    }
    return best.agentId;
  }

  // ---------- Persistence (additive) ----------

  /** Serialize to a compact JSON-friendly array. */
  serialize(): Array<{ c: number; a: number; f: number; h: string; t: number; b: [number, number, number] }> {
    const out: Array<{ c: number; a: number; f: number; h: string; t: number; b: [number, number, number] }> = [];
    for (const [ci, e] of this.cells) {
      out.push({ c: ci, a: e.agentId, f: e.fitness, h: e.treeHash, t: e.tick, b: e.bins });
    }
    return out.sort((x, y) => x.c - y.c);
  }

  /** Restore from serialized form. Invalid entries are silently skipped. */
  static deserialize(data: unknown): ElitesArchive {
    const archive = new ElitesArchive();
    if (!Array.isArray(data)) return archive;
    for (const rec of data.slice(0, ARCHIVE_CELLS)) {
      if (!rec || typeof rec !== "object") continue;
      const ci = Number(rec.c);
      if (!Number.isFinite(ci) || ci < 0 || ci >= ARCHIVE_CELLS) continue;
      const bins: [number, number, number] = Array.isArray(rec.b) && rec.b.length === 3
        ? [Number(rec.b[0]) || 0, Number(rec.b[1]) || 0, Number(rec.b[2]) || 0]
        : [0, 0, 0];
      archive.cells.set(ci, {
        agentId: Number(rec.a) || 0,
        fitness: Number(rec.f) || 0,
        treeHash: typeof rec.h === "string" ? rec.h : "",
        tick: Number(rec.t) || 0,
        bins,
      });
    }
    return archive;
  }
}

// ---------- Behaviour descriptor computation ----------

/**
 * Compute Shannon entropy (in bits, 0..2) of a good-preference distribution.
 * Input: counts per good kind [signal, momentum, attestation, prediction].
 * Returns r6 integer (Math.trunc(entropy * 1e6)).
 */
export function goodEntropyR6(counts: [number, number, number, number]): number {
  const total = counts[0] + counts[1] + counts[2] + counts[3];
  if (total === 0) return 0;
  let h = 0;
  for (const c of counts) {
    if (c <= 0) continue;
    const p = c / total;
    h -= p * Math.log2(p);
  }
  // h ∈ [0, 2] for 4 categories; scale to r6
  return Math.trunc(h * 1_000_000);
}

/**
 * Build behaviour descriptor bins for one agent from its lifetime stats.
 * All inputs are already available from the economy ledger (no new sensory channels).
 *
 * @param arousalR6   Math.trunc(meanArousal * 1e6) for this agent's recent readings
 * @param settleOk    successful settlements (deals + sales)
 * @param settleTotal total settlement attempts (settleOk + failures)
 * @param goodCounts  per-good trade counts [signal, momentum, attestation, prediction]
 */
export function computeBins(
  arousalR6: number,
  settleOk: number,
  settleTotal: number,
  goodCounts: [number, number, number, number],
): [number, number, number] {
  const rateR6 = settleTotal > 0 ? Math.trunc((settleOk / settleTotal) * 1_000_000) : 0;
  const entropyR6 = goodEntropyR6(goodCounts);
  return [binArousal(arousalR6), binSettleRate(rateR6), binEntropy(entropyR6)];
}
