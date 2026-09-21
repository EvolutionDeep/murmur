// Pure decision engine for murmur's on-chain house WAR + TAXATION layer (see contracts/WarCoffer.sol
// and state.ts driveWar). Extracted into its own module — with NO Durable Object, chain, viem-wallet or
// fly-brain imports — so every rule that decides where REAL USDC moves can be unit-tested in isolation.
//
// THE WAR MODEL (mirrors the arena's resolver discipline, but the outcome is fully PUBLIC). Wars are
// discrete bouts between two feuding HOUSES, cadenced by unix time buckets exactly like arena rounds:
// warId = floor(now / warCadenceSec). Each cron tick, the Worker (as the coffer's authorized resolver) does
// at most a few best-effort writes — top up a vault, declare the feud that is due, resolve the bucket that
// just closed, and post the extra on-chain tax — but WHICH war to declare/resolve is a PURE function of
// (now, cadence, cursor) computed here, so the real-gas decision is testable without a live chain.
//
// WHY NO SEED ORACLE (the deliberate difference from the arena): the coffer derives the winner from the
// inputs COMMITTED AT DECLARE — (warId, attacker, defender, powerA, powerB) — through a public keccak draw,
// so the resolver supplies NOTHING at resolve time and cannot steer a result. The instant a war is declared
// its outcome is fixed and recomputable by anyone. `winnerOf` below is kept BYTE-FOR-BYTE in lock-step with
// WarCoffer._deriveWinner / previewWinner: same field order, same keccak, same modulo. If they ever diverge,
// the on-chain payout and the Worker's mirror disagree — so a unit test pins this against the contract rule.

import { encodePacked, hexToBigInt, keccak256 } from "viem";

/** Outcome codes matching WarCoffer's WIN_* constants (0 is the unset / stale-refund sentinel). */
export const WIN_NONE = 0;
export const WIN_ATTACKER = 1;
export const WIN_DEFENDER = 2;

/**
 * The war/tax knobs, folded from config.ts's `war` block. All amounts are HUMAN USDC here (state.ts
 * converts to the coffer's 6-dec atomic units at the boundary); every bound is enforced again on-chain.
 */
export interface WarConfig {
  stakePct: number;         // fraction of a house vault posted as EACH side's stake into the pot
  minVaultUsdc: number;     // both houses need at least this on-chain vault before they may feud
  perWarCapUsdc: number;    // hard ceiling on one side's stake, no matter how rich the vault
  maxEscrowUsdc: number;    // the coffer's hard cap — vaults are topped up only up to a fair share of it
  warCadenceSec: number;    // seconds per war bucket (== the betting/commit window, like a round length)
  feudThreshold: number;    // a cross-house bond <= this (negative) ⇒ a deep feud that may go to war
  taxPct: number;           // fraction of a house vault levied as EXTRA on-chain tax into the commons
  taxDest: "coffer" | "dominant";  // tax held in the coffer purse, or swept to the dominant house
}

/** A house reduced to ONLY the public read-outs that are safe to commit on-chain (never a neuron/genome). */
export interface WarHouse {
  id: number;             // house id (= founder fly id), the coffer's vault key
  live: number;           // living members
  gen: number;            // highest generation under this name
  earnedUsdc: number;     // lifetime gross income tithed in (dynasty prestige)
  capitalShare: number;   // this house's share of swarm wealth, 0..1
  vaultOnchainUsdc: number; // the house's on-chain vault mirror (USDC), the stake/tax base
}

/** An AGGREGATED cross-house bond (economy.ts folds member bonds to house level; a<b house ids). */
export interface HouseFeud {
  a: number;      // lower house id
  b: number;      // higher house id
  score: number;  // mean directed bond score across the two houses' members, −1 (blood feud) .. +1
}

/** The Worker's persisted resolver cursor: the highest war bucket it has already opened / resolved. */
export interface WarCursor {
  openedWar: number;    // last warId declareWar() succeeded for (-1 ⇒ none yet)
  resolvedWar: number;  // last warId resolveWar() succeeded for (-1 ⇒ none yet)
}

/** The resolver's timing plan for one cron tick (which bucket to declare, which to resolve, the deadline). */
export interface WarPlan {
  cur: number;                  // the live bucket = floor(now / cadence)
  prev: number;                 // cur - 1 — the bucket that just closed (-1 in the very first bucket)
  resolveWar: number | null;    // prev, but ONLY if we opened it and haven't resolved it yet; else null
  declareWar: number | null;    // cur, but ONLY if we haven't opened it yet; else null
  declareDeadline: number;      // unix sec the cur war becomes resolvable (== the next bucket's open)
}

/**
 * Advance the resolver cursor after declareWar(warId) SUCCEEDED. Mirrors arena.ts cursorAfterOpen exactly:
 * on a FRESH mid-stream start (openedWar was -1) the Worker has opened `cur` without ever opening `prev`,
 * yet openedWar>=prev would otherwise make planWar target prev for resolve on EVERY cron this bucket — and
 * the coffer reverts NotOpened on a never-opened war, burning gas until the bucket rolls. Baselining
 * resolvedWar to warId-1 marks that un-openable prev as handled, so the dead chase never starts. The NEXT
 * bucket resolves `cur` normally, because cur genuinely was opened. Pure + idempotent; unit-tested.
 */
export function cursorAfterWarOpen(cursor: WarCursor, warId: number): WarCursor {
  const resolvedWar = cursor.openedWar < 0
    ? Math.max(cursor.resolvedWar, warId - 1)   // fresh start: skip the prev we never baselined
    : cursor.resolvedWar;                        // steady state: resolve cursor is managed separately
  return { openedWar: warId, resolvedWar };
}

/**
 * Decide the resolver's war TIMING for this tick from (now, cadence, cursor) — the pure, testable half of
 * driveArena's sibling. Idempotent and self-healing: a bucket already declared is never re-declared, one
 * already resolved is never re-resolved, and prev is only resolved if WE declared it (openedWar >= prev),
 * so a Worker that comes online mid-stream opens the live bucket without chasing one it never baselined.
 * A failed declare/resolve leaves the cursor put so the next cron retries within the coffer's stale grace;
 * past that grace anyone may expireStaleWar for a refund, so escrowed stakes can never lock.
 */
export function planWar(nowSec: number, warCadenceSec: number, cursor: WarCursor): WarPlan {
  const cadence = Math.max(1, Math.floor(warCadenceSec));
  const cur = Math.floor(nowSec / cadence);
  const prev = cur - 1;
  // Resolve prev only when it exists, we declared it, and it isn't resolved yet.
  const resolveWar = prev >= 0 && cursor.resolvedWar < prev && cursor.openedWar >= prev ? prev : null;
  // Declare cur only when we haven't declared it yet (fresh start, or the bucket rolled over since last tick).
  const declareWar = cursor.openedWar < cur ? cur : null;
  // A war declared in `cur` is only resolvable once `cur` closes, i.e. at the next bucket's open instant.
  const declareDeadline = (cur + 1) * cadence;
  return { cur, prev, resolveWar, declareWar, declareDeadline };
}

/**
 * A house's committed POWER: a strictly-positive integer derived ONLY from public dynasty read-outs
 * (capital share, living members, lifetime earnings, dynasty depth) — never from a neuron, genome or any
 * private ledger state, so it is safe to commit on-chain and recomputable by anyone. Weighting is a fixed
 * formula (not env-tunable) so a declared power never depends on when it is read. Always >= 1, guaranteeing
 * powerA + powerB > 0 (the coffer's ZeroPower guard can never trip from a well-formed house).
 */
export function housePower(h: WarHouse): number {
  const cap = Math.max(0, h.capitalShare) * 1000;              // wealth share dominates (0..1000)
  const pop = Math.max(0, h.live) * 25;                        // living members
  const earn = Math.sqrt(Math.max(0, h.earnedUsdc)) * 10;      // diminishing returns on gross earnings
  const gen = Math.max(1, h.gen);                              // dynasty depth (at least 1)
  return Math.max(1, Math.round(cap + pop + earn + gen));
}

/**
 * The bounded stake EACH side posts for a war: a fraction of the SMALLER vault (so both can cover it after
 * the coffer's InsufficientVault check), hard-capped by perWarCapUsdc so even a feud between the two richest
 * houses moves only a bounded slice of the escrow. Returns 0 when either house is below `minVaultUsdc` or
 * the stake would round to nothing — the caller then skips the declaration rather than opening a dust war.
 */
export function stakeOf(vaultA: number, vaultB: number, cfg: WarConfig): number {
  if (vaultA < cfg.minVaultUsdc || vaultB < cfg.minVaultUsdc) return 0;
  const base = Math.min(vaultA, vaultB) * cfg.stakePct;
  const stake = Math.min(base, cfg.perWarCapUsdc);
  return stake > 0 ? stake : 0;
}

/**
 * How much EXTRA on-chain tax to levy from a house vault this cron: a bounded fraction of its CURRENT vault,
 * clamped so a levy can never overdraw the vault (the coffer reverts InsufficientVault, so we never ask for
 * more than the mirror holds). taxPct is small (a tithe-like skim), so this drains gradually, not at once.
 * Returns 0 for an empty vault so a house with nothing on-chain is skipped, not reverted against.
 */
export function taxLevy(vaultUsdc: number, cfg: WarConfig): number {
  if (vaultUsdc <= 0) return 0;
  const levy = vaultUsdc * cfg.taxPct;
  return levy > 0 ? Math.min(levy, vaultUsdc) : 0;
}

/**
 * Candidate house-vs-house wars this cron, deepest feud first: a pair may go to war only when their
 * cross-house bond is at or below `feudThreshold` (a deep, negative score) AND BOTH vaults clear
 * `minVaultUsdc` AND the stake comes out non-zero. A per-pair cooldown (>= warCadenceSec, so a freshly
 * fought pair cannot immediately re-fund) keeps the escrow from thrashing. `lastWarByPair` maps a
 * "a-b" pair key to the unix seconds of its last declaration; the caller (driveWar) persists it.
 */
export function feudPairs(
  houses: WarHouse[],
  feuds: HouseFeud[],
  cfg: WarConfig,
  nowSec: number,
  lastWarByPair: Record<string, number> = {},
): { attacker: number; defender: number }[] {
  const byId = new Map(houses.map((h) => [h.id, h]));
  const out: { attacker: number; defender: number }[] = [];
  for (const f of feuds) {
    if (f.a === f.b) continue;
    if (f.score > cfg.feudThreshold) continue;                 // not a deep enough feud
    const ha = byId.get(f.a);
    const hb = byId.get(f.b);
    if (!ha || !hb) continue;
    if (stakeOf(ha.vaultOnchainUsdc, hb.vaultOnchainUsdc, cfg) <= 0) continue;  // a side too poor to fight
    const key = pairKey(f.a, f.b);
    const last = lastWarByPair[key];
    if (last != null && nowSec - last < cfg.warCadenceSec) continue;            // per-pair cooldown
    // Deeper (more negative) feud attacks: the aggressor is the house with the LESS wealth (a grab up),
    // tie-broken by lower id so the pairing is deterministic for a given committed read-out snapshot.
    const attacker = ha.capitalShare <= hb.capitalShare ? ha.id : hb.id;
    const defender = attacker === ha.id ? hb.id : ha.id;
    out.push({ attacker, defender });
  }
  // Deepest feud first (score ascending), then by pair for a stable order when scores tie.
  out.sort((x, y) => {
    const sx = feuds.find((f) => pairKey(f.a, f.b) === pairKey(x.attacker, x.defender))?.score ?? 0;
    const sy = feuds.find((f) => pairKey(f.a, f.b) === pairKey(y.attacker, y.defender))?.score ?? 0;
    return sx - sy || pairKey(x.attacker, x.defender).localeCompare(pairKey(y.attacker, y.defender));
  });
  return out;
}

/** Canonical undirected pair key (order-independent) for the cooldown map. */
export function pairKey(a: number, b: number): string {
  return a < b ? `${a}-${b}` : `${b}-${a}`;
}

/**
 * The deterministic, PUBLIC winner — BYTE-IDENTICAL to WarCoffer._deriveWinner / previewWinner. It packs the
 * five committed uint256 inputs the SAME way Solidity's abi.encodePacked does, keccaks them, and takes the
 * roll modulo the total power; the attacker wins iff the roll lands in its own power slice. Because this
 * mirrors the contract exactly, both sides of the boundary always agree on the winner with no oracle.
 */
export function warRoll(warId: bigint, attacker: bigint, defender: bigint, powerA: bigint, powerB: bigint): bigint {
  const packed = encodePacked(
    ["uint256", "uint256", "uint256", "uint256", "uint256"],
    [warId, attacker, defender, powerA, powerB],
  );
  const total = powerA + powerB;
  return hexToBigInt(keccak256(packed)) % total;
}

/** The winner code for a committed war, with the roll + total exposed for the event/log and tests. */
export function winnerOf(
  warId: bigint, attacker: bigint, defender: bigint, powerA: bigint, powerB: bigint,
): { winner: number; roll: bigint; total: bigint } {
  const total = powerA + powerB;
  if (total <= 0n) return { winner: WIN_NONE, roll: 0n, total };
  const roll = warRoll(warId, attacker, defender, powerA, powerB);
  const winner = roll < powerA ? WIN_ATTACKER : WIN_DEFENDER;
  return { winner, roll, total };
}
