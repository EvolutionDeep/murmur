// Multi-objective fitness — Phase 4, capability ④ (open-ended evolution: cross-generation improvement).
//
// THE IDEA. Selecting parents on realized PnL alone (netUsdc top-1) is a single-objective rule: it rewards
// one lucky hot streak as much as a durable, reliable, well-liked trader. This module upgrades the RANKING
// inside planEvolution to a bounded weighted score over five dimensions the ledger ALREADY keeps:
//
//   dim 1 — profit:         netUsdc (realized earned − paid), the trustless leaderboard key
//   dim 2 — survival:       ticks lived since birth (a fly that keeps flying keeps earning)
//   dim 3 — reliability:    settleOk / settleTotal (promises kept vs broken — the social-memory signal)
//   dim 4 — foresight:      prediction hit rate (decisive rounds called correctly)
//   dim 5 — socialStanding: reputation (−1 deadbeat .. +1 honourable), the membrane's own read-out
//
// HARD-GATE INVARIANT (IMMUTABLE). `netUsdc > 0` REMAINS a hard eligibility gate enforced UPSTREAM in
// planEvolution BEFORE any score is consulted — the multi-objective score only RE-ORDERS the already-eligible
// pool. No weight, cap or score can ever promote a loss-maker, relax a money cap, or bypass a budget gate.
// `passesHardGate()` below is the SAME predicate planEvolution filters on, exported for tests/evidence.
//
// DETERMINISM. Every normalization is a rational clamp (divide + min/max) — no transcendental function, no
// Math.random, no Date.now. Same inputs ⇒ same score, bit-for-bit, on any IEEE-754 runtime.
//
// MISSING DATA. A dimension with no observations (e.g. the prediction layer never ran for this fly) scores the
// NEUTRAL 0.5 and its weight is RENORMALIZED over the observed dimensions, so an unmeasured fly is neither
// rewarded nor punished for data the system does not have. (Offline pure-economy runs produce no prediction
// data at all — the neutral treatment is what keeps before/after curves like-for-like.)
//
// PRIVACY OF CONSTANTS. Weights and normalization caps are CODE-DEFAULT CONSTANTS here (NOT env knobs): the
// fitness function is part of the selection rule, so retuning it must rotate CODE_COMMITMENT like any other
// src change. Only the master switch + tournament size are configurable (config.ts evolution.multiObjective).

/** Raw per-agent observations the score folds. All fields are read-time facts from existing ledgers. */
export interface MofitInput {
  /** Realized PnL in USDC (earned − paid) — the leaderboard key. Hard-gated > 0 upstream. */
  netUsdc: number;
  /** Sub-ticks lived (current tick − birth tick), ≥ 0. */
  survivalTicks: number;
  /** Lifetime settled deals (promises kept) — social-memory counter. */
  settleOk: number;
  /** Lifetime settlement attempts (kept + broken). 0 ⇒ reliability unobserved (neutral). */
  settleTotal: number;
  /** Decisive prediction rounds bet; null when the prediction layer has no record for this fly. */
  predictRounds: number | null;
  /** Decisive prediction rounds called correctly (only meaningful when predictRounds != null). */
  predictHits: number | null;
  /** Social reputation, −1 (deadbeat) .. +1 (honourable); null when no social record exists. */
  rep: number | null;
}

/** The five normalized dimension scores, each in [0,1] (0.5 = neutral/unobserved). Exported for evidence. */
export interface MofitVector {
  profit: number;
  survival: number;
  settle: number;
  predict: number;
  social: number;
}

/** Integer dimension weights (parts per 100). CODE-DEFAULT CONSTANTS — see the header note. */
export const MOFIT_WEIGHTS = {
  profit: 40,       // realized PnL stays the dominant signal (it is the trustless, on-chain-verifiable one)
  survival: 15,     // durability: a fly that keeps flying through regimes
  settle: 20,       // reliability: promises kept vs broken
  predict: 10,      // foresight: prediction-market hit rate (neutral when unobserved)
  social: 15,       // standing: membrane reputation (neutral when unobserved)
} as const;

/** The weight total — scores are parts-per-total, so weights need not sum to a round number. */
export const MOFIT_WEIGHT_TOTAL =
  MOFIT_WEIGHTS.profit + MOFIT_WEIGHTS.survival + MOFIT_WEIGHTS.settle + MOFIT_WEIGHTS.predict + MOFIT_WEIGHTS.social;

/** Normalization caps (bounded, rational). A dimension saturates at its cap — no unbounded term exists. */
export const MOFIT_PROFIT_CAP_USDC = 1;     // netUsdc ≥ 1.0 USDC saturates the profit dimension
export const MOFIT_SURVIVAL_CAP_TICKS = 86_400; // ~1 day of sub-ticks saturates the survival dimension

/** The neutral score for an unobserved dimension (its weight is renormalized away — see header). */
export const MOFIT_NEUTRAL = 0.5;

function clamp01(x: number): number {
  if (!Number.isFinite(x)) return 0;
  return x < 0 ? 0 : x > 1 ? 1 : x;
}

/**
 * The hard eligibility gate — UNCHANGED from the single-objective build: only a strictly profitable fly may
 * ever be a parent. Exported so tests pin it and callers never re-implement it differently. This predicate is
 * applied in planEvolution BEFORE any multi-objective score is computed or consulted.
 */
export function passesHardGate(netUsdc: number): boolean {
  return Number.isFinite(netUsdc) && netUsdc > 0;
}

/**
 * Normalize the raw observations into the five bounded [0,1] dimension scores. PURE + rational only:
 *   profit   = clamp01(netUsdc / MOFIT_PROFIT_CAP_USDC)
 *   survival = clamp01(survivalTicks / MOFIT_SURVIVAL_CAP_TICKS)
 *   settle   = settleTotal > 0 ? clamp01(settleOk / settleTotal) : NEUTRAL
 *   predict  = rounds > 0 ? clamp01(hits / rounds) : NEUTRAL
 *   social   = rep != null ? clamp01((rep + 1) / 2) : NEUTRAL
 * A malformed input (NaN/negative counters) degrades to 0 or NEUTRAL — never NaN, never > 1.
 */
export function mofitVector(input: MofitInput): MofitVector {
  const net = Number.isFinite(input.netUsdc) ? input.netUsdc : 0;
  const surv = Number.isFinite(input.survivalTicks) && input.survivalTicks > 0 ? input.survivalTicks : 0;
  const ok = Number.isFinite(input.settleOk) && input.settleOk > 0 ? input.settleOk : 0;
  const total = Number.isFinite(input.settleTotal) && input.settleTotal > 0 ? input.settleTotal : 0;
  const rounds = input.predictRounds != null && Number.isFinite(input.predictRounds) && input.predictRounds > 0
    ? input.predictRounds : 0;
  const hits = input.predictHits != null && Number.isFinite(input.predictHits) && input.predictHits > 0
    ? Math.min(input.predictHits, rounds) : 0;
  const rep = input.rep != null && Number.isFinite(input.rep)
    ? Math.max(-1, Math.min(1, input.rep)) : null;
  return {
    profit: clamp01(net / MOFIT_PROFIT_CAP_USDC),
    survival: clamp01(surv / MOFIT_SURVIVAL_CAP_TICKS),
    settle: total > 0 ? clamp01(ok / total) : MOFIT_NEUTRAL,
    predict: rounds > 0 ? clamp01(hits / rounds) : MOFIT_NEUTRAL,
    social: rep != null ? clamp01((rep + 1) / 2) : MOFIT_NEUTRAL,
  };
}

/**
 * The scalar multi-objective fitness score in [0,1]: the integer-weighted mean of the OBSERVED dimension
 * scores. Unobserved dimensions (settle with 0 attempts, predict with no rounds, social with no record) are
 * EXCLUDED and their weight renormalized over the observed ones, so the score stays in [0,1] and absence of
 * data is never a penalty or a bonus. PURE + rational: same input ⇒ same float, byte-for-byte.
 *
 * @param vec   the normalized dimension scores (from mofitVector)
 * @param raw   the raw input — consulted ONLY to decide which of settle/predict/social were observed
 */
export function mofitScore(vec: MofitVector, raw: MofitInput): number {
  let weightSum = MOFIT_WEIGHTS.profit + MOFIT_WEIGHTS.survival;
  let acc = MOFIT_WEIGHTS.profit * vec.profit + MOFIT_WEIGHTS.survival * vec.survival;
  const settleTotal = Number.isFinite(raw.settleTotal) && raw.settleTotal > 0 ? raw.settleTotal : 0;
  if (settleTotal > 0) { weightSum += MOFIT_WEIGHTS.settle; acc += MOFIT_WEIGHTS.settle * vec.settle; }
  const rounds = raw.predictRounds != null && Number.isFinite(raw.predictRounds) && raw.predictRounds > 0
    ? raw.predictRounds : 0;
  if (rounds > 0) { weightSum += MOFIT_WEIGHTS.predict; acc += MOFIT_WEIGHTS.predict * vec.predict; }
  if (raw.rep != null && Number.isFinite(raw.rep)) { weightSum += MOFIT_WEIGHTS.social; acc += MOFIT_WEIGHTS.social * vec.social; }
  return weightSum > 0 ? clamp01(acc / weightSum) : 0;
}

/** One-call convenience: raw observations → bounded [0,1] score. */
export function computeMofit(input: MofitInput): number {
  const vec = mofitVector(input);
  return mofitScore(vec, input);
}
