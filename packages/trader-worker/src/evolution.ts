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
