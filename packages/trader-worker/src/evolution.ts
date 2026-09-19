// Autonomous evolution — the PURE natural-selection planner.
//
// THE IDEA. The 24 live flies are economic agents that earn/lose real USDC every tick. This module turns
// that realized performance into a selection pressure: each cron, the FITTEST agents (highest realized PnL)
// may autonomously found the next generation of connectomes in the on-chain breeding market, paying the
// breeding fee from their OWN wallet. No LLM and no human decides who reproduces — the ledger does. The
// swarm propagates the strategies that actually made money and never lets a money-losing fly spend on
// offspring.
//
// WHY PURE. planEvolution() is a deterministic function of (leaderboard, genome resolver, budgets, rng):
// it touches no storage, signs nothing, and moves no money. All side effects — paying the fee, persisting
// the offspring, the on-chain commit — live in state.ts/economy.ts, so the selection rule is trivially
// unit-testable and cannot spend on its own. It mirrors the arena/prediction split: a pure planner here,
// an armed executor at the edge.
//
// SAFETY. This planner only ever PROPOSES one breed per call and hard-stops at the per-cron / per-day /
// per-agent ceilings. Whether the proposal is carried out (and whether real USDC moves) is gated again in
// state.ts on the same master rails as settlement (onchain + real spend on + not shadow-only + treasury
// set). A simulated/keyless Worker never evolves.

import type { LeaderRow } from "./economy.js";
import type { LineageEntry } from "./breed.js";

/** One autonomous breeding decision the cron step should carry out (null = nothing worth breeding). */
export interface EvolutionPlan {
  /** Genetic operator: clone-and-mutate the fittest, or recombine the two fittest. */
  op: "mutate" | "cross";
  /** Parent genomeHashes: exactly 1 for mutate, exactly 2 for cross (fed straight to applyBreed). */
  parents: string[];
  /** The agent that funds the breeding fee from its own wallet — always the fittest eligible parent. */
  payerId: number;
  /** The payer's on-chain address; credited as the offspring's `breeder` (its royalty/ancestry identity). */
  payerAddress: string;
  /** Operator seed, recorded on the offspring so the pure genome operator is reproducible by anyone. */
  rngSeed: number;
}

/** Per-cron / per-day budgets the planner must respect (read from the persisted guard in state.ts). */
export interface EvolutionLimits {
  /** Max offspring to breed this cron tick (0 ⇒ evolution disabled for this call). */
  perCron: number;
  /** Offspring already bred this cron tick. */
  perCronUsed: number;
  /** Max offspring ONE agent may fund per UTC day (0 ⇒ no per-agent limit). */
  perAgentDaily: number;
  /** Max offspring bred per UTC day across the whole swarm (0 ⇒ no global limit). */
  globalDaily: number;
  /** Offspring already bred today (whole swarm). */
  globalUsed: number;
  /** Offspring funded per agent id today. */
  perAgentUsed: Record<number, number>;
  /** 0..1 — with ≥2 eligible parents, P(cross the top two); else (or on a mutate draw) mutate the top one. */
  crossBias: number;
}

/**
 * Decide the single best autonomous breed for this cron, or null when nothing should breed.
 *
 * FITNESS = realized PnL (`netUsdc` = earned − paid), the trustless leaderboard key recomputable from
 * on-chain settlements. Selection rule:
 *   1. Hard-stop at the per-cron and per-day ceilings (never overspend the budget).
 *   2. Keep only PROFITABLE agents (netUsdc > 0) that have a resolvable genome and are under their per-agent
 *      daily breeding budget — ranked fittest first. A losing or unknown fly is never a parent.
 *   3. With ≥2 fit parents, cross the top two with probability `crossBias` (sexual recombination of the two
 *      best strategies); otherwise mutate the single fittest (clone-and-perturb the champion).
 *   4. The fittest eligible parent always PAYS (funds the fee from its own wallet) and is credited as breeder.
 *
 * `genomeHashById` resolves a live agent id to the genome it actually runs (its genesis brain); ids with no
 * genome (null/"") are ineligible. `rng` supplies the cross/mutate draw; `rngSeed` is recorded on the plan so
 * the offspring is reproducible.
 */
export function planEvolution(
  rows: LeaderRow[],
  genomeHashById: (id: number) => string | null,
  lim: EvolutionLimits,
  rng: () => number,
  rngSeed: number,
): EvolutionPlan | null {
  // 1) Hard budget gates first: never breed past the per-cron or per-day ceilings.
  if (lim.perCron <= 0 || lim.perCronUsed >= lim.perCron) return null;
  if (lim.globalDaily > 0 && lim.globalUsed >= lim.globalDaily) return null;

  // 2) FITNESS filter + ranking. Only profitable agents with a known genome, still under their per-agent
  //    daily budget, may reproduce. leaderboard() already sorts by netUsdc desc, but we re-sort so the rule
  //    is robust to any caller and the eligible ranking is explicit (PnL, then balance, then id as tiebreak).
  const eligible = rows
    .filter((r) => r.netUsdc > 0)
    .map((r) => ({ row: r, hash: genomeHashById(r.id) }))
    .filter((e): e is { row: LeaderRow; hash: string } => e.hash != null && e.hash !== "")
    .filter((e) => lim.perAgentDaily <= 0 || (lim.perAgentUsed[e.row.id] ?? 0) < lim.perAgentDaily)
    .sort(
      (a, b) =>
        b.row.netUsdc - a.row.netUsdc ||
        b.row.balanceUsdc - a.row.balanceUsdc ||
        a.row.id - b.row.id,
    );

  if (eligible.length === 0) return null;

  // 3) + 4) Choose the operator and the payer (always the fittest eligible parent).
  const top = eligible[0];
  const doCross = eligible.length >= 2 && rng() < lim.crossBias;
  if (doCross) {
    const second = eligible[1];
    return {
      op: "cross",
      parents: [top.hash, second.hash],
      payerId: top.row.id,
      payerAddress: top.row.address,
      rngSeed,
    };
  }
  return {
    op: "mutate",
    parents: [top.hash],
    payerId: top.row.id,
    payerAddress: top.row.address,
    rngSeed,
  };
}

/**
 * Build the live-agent-id → parent-genomeHash resolver that ADVANCES each agent's germline.
 *
 * An agent breeds from its OWN most-recent offspring when it has one, so its line accumulates generations
 * (gen1 → gen2 → …) instead of re-spawning gen1 clones of its genesis root forever. Only once lines have
 * diverged does `cross` become meaningful: two germlines with different layer sizes recombine into a novel
 * genome, whereas two genesis roots (identical sizing, seed inherited whole) only ever copy a parent
 * verbatim. An agent that has not bred yet falls back to its genesis root — the genome it actually runs and
 * earns with. Pure over (leaderboard rows, lineage entries); touches no storage.
 *
 * Assumes genesis entries are stored in fly-id order (cfg.populationSeeds order == spawn order), so
 * `genesis[id]` is agent `id`'s root. Offspring are matched to their funder by `breeder` address (the payer
 * credited on the entry), keeping the most recent by `ts`.
 */
export function germlineResolver(
  rows: LeaderRow[],
  entries: LineageEntry[],
): (id: number) => string | null {
  const genesis = entries.filter((e) => e.op === "genesis");
  const addrById = new Map<number, string>();
  for (const r of rows) if (r.address) addrById.set(r.id, r.address.toLowerCase());
  const latestByBreeder = new Map<string, LineageEntry>();
  for (const e of entries) {
    if (e.op === "genesis" || !e.breeder) continue;
    const b = e.breeder.toLowerCase();
    const cur = latestByBreeder.get(b);
    if (!cur || e.ts >= cur.ts) latestByBreeder.set(b, e);   // entries are append-ordered ⇒ keep the newest
  }
  return (id: number): string | null => {
    const addr = addrById.get(id);
    const own = addr ? latestByBreeder.get(addr) : undefined;
    return own?.genomeHash ?? genesis[id]?.genomeHash ?? null;
  };
}

/**
 * Resolve a proposed breed into a NOVEL offspring, or null when none could be produced within `maxAttempts`.
 *
 * `applyBreed` is pure and refuses a duplicate genome FOR FREE, so this never spends on a no-op. Because
 * crossing two undiverged roots copies a parent verbatim ("already in lineage"), on a duplicate we retry
 * with a fresh seed and downgrade `cross` → `mutate` (mutate always reseeds ⇒ always novel), guaranteeing a
 * real fee is only ever charged for a genuinely new genome. A NON-duplicate failure (e.g. unknown parent) is
 * a real error and is re-thrown for the caller to log — it is not retried.
 *
 * `breed` is injected as (op, parents, rngSeed) ⇒ offspring | throws, so this stays unit-testable without
 * the DO / storage / crypto.subtle wiring. The first attempt uses the plan's own recorded `rngSeed` (so a
 * clean success is reproducible from the plan); later attempts perturb it by a golden-ratio stride.
 */
export async function resolveNovelBreed<T>(
  plan: Pick<EvolutionPlan, "op" | "parents" | "rngSeed">,
  breed: (op: "mutate" | "cross", parents: string[], rngSeed: number) => Promise<T>,
  maxAttempts = 4,
): Promise<{ child: T; op: "mutate" | "cross" } | null> {
  let op = plan.op;
  let parents = plan.parents;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const seed = (plan.rngSeed + attempt * 2654435761) >>> 0;
    try {
      const child = await breed(op, parents, seed);
      return { child, op };
    } catch (e) {
      const msg = (e as Error).message;
      if (!msg.includes("already in lineage")) throw e;              // real error ⇒ caller logs, no retry
      if (op === "cross") { op = "mutate"; parents = [parents[0]]; } // degenerate recomb ⇒ clone-and-mutate
      // else: a mutate seed collision ⇒ loop retries with a fresh seed
    }
  }
  return null;
}

/** One on-chain ConnectomeLineage commit the anchoring pass should attempt (pure; the caller executes it). */
export interface AnchorCandidate {
  genomeHash: string;   // 64-hex sha256(canonical(genome)), no 0x
  parentA: string;      // 64-hex, or "" for genesis
  parentB: string;      // 64-hex, or "" unless op === 2
  op: 0 | 1 | 2;        // genesis | mutate | cross
  generation: number;
  breeder: string;      // 0x… credited breeder (the contract rejects address(0))
}

/**
 * Plan the batch of lineage entries to anchor on-chain now (pure; the caller performs the commits).
 *
 * ConnectomeLineage enforces ancestry IN-CONTRACT: a mutate/cross child reverts `ParentNotCommitted` unless
 * both parents are already committed, and generations can never skip. The 24 genesis roots were seeded
 * off-chain with breeder=null and never committed, so every descendant's commit reverted and the on-chain log
 * stayed empty. This walks the append-ordered lineage and returns every entry whose commitTx is still null AND
 * whose parents are all committed — either already on Arc, or committed EARLIER IN THIS SAME BATCH (so genesis
 * roots go first and their descendants follow within one pass) — capped at `maxCommits` to bound the work per
 * cron. Re-running is free: an anchored entry has commitTx set and is skipped, so the pass is idempotent and
 * self-healing across ticks.
 *
 * Genesis roots have no breeder off-chain, so each is credited to the address of the agent that runs it,
 * matched positionally (genesis order == fly-id == agent id — the same assumption germlineResolver makes). An
 * entry with no resolvable non-zero breeder is skipped (the contract reverts ZeroBreeder) and retried later.
 * Touches no storage and signs nothing.
 */
export function lineageAnchorPlan(
  entries: LineageEntry[],
  addrById: Map<number, string>,
  maxCommits: number,
): AnchorCandidate[] {
  const committed = new Set(entries.filter((e) => e.commitTx).map((e) => e.genomeHash));
  const genesisAddr = new Map<string, string>();
  entries.filter((e) => e.op === "genesis").forEach((e, i) => {
    const a = addrById.get(i);
    if (a) genesisAddr.set(e.genomeHash, a.toLowerCase());
  });
  const out: AnchorCandidate[] = [];
  for (const e of entries) {
    if (out.length >= maxCommits) break;
    if (e.commitTx || committed.has(e.genomeHash)) continue;      // already anchored (or planned below)
    if (!e.parents.every((p) => committed.has(p))) continue;      // ancestry order: parents committed first
    const breeder =
      (e.breeder ?? "").trim() || (e.op === "genesis" ? genesisAddr.get(e.genomeHash) ?? "" : "");
    if (!breeder) continue;                                       // ZeroBreeder would revert; retry next tick
    out.push({
      genomeHash: e.genomeHash,
      parentA: e.parents[0] ?? "",
      parentB: e.parents[1] ?? "",
      op: (e.op === "genesis" ? 0 : e.op === "mutate" ? 1 : 2) as 0 | 1 | 2,
      generation: e.generation,
      breeder,
    });
    committed.add(e.genomeHash);                                  // enables this entry's descendants in-batch
  }
  return out;
}
