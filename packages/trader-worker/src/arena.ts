// Pure helpers for the human-vs-swarm prediction arena's RESOLVER side (see contracts/PredictionArena.sol
// and state.ts driveArena). Extracted into their own module — with no Durable Object, chain or fly-brain
// imports — so the round-bucketing decision that commits real gas can be unit-tested in isolation.
//
// THE RESOLVER MODEL. Arena rounds are plain unix time buckets: roundId = floor(now / roundLenSec). Each
// cron tick, the Worker (as the contract's authorized resolver) does at most two writes:
//   · resolve the bucket that JUST closed (prev), supplying this tick's temperature as its exit;
//   · open the new bucket (cur), committing this same temperature as its entry baseline + the flat band.
// Using the SAME temperature for prev's exit and cur's entry makes the rounds continuous (no gap between
// one round's close and the next's open). The contract — not the resolver — derives UP/DOWN/FLAT from the
// committed entry/exit + band, so the resolver cannot steer an outcome; it only reports temperature.
//
// Everything here is a PURE function of (now, cadence, cursor). The side effects (the actual openRound /
// resolve calls and the cursor advance) live in driveArena; keeping the decision separate means the
// "which round, what deadline" logic is testable without a live chain or a real-money key.

/** The Worker's persisted resolver cursor: the highest roundId it has already opened / resolved. */
export interface ArenaCursor {
  openedRound: number;    // last roundId openRound() succeeded for (-1 ⇒ none yet)
  resolvedRound: number;  // last roundId resolve() succeeded for (-1 ⇒ none yet)
}

/** The resolver's plan for one cron tick: which round (if any) to resolve, which to open, and the deadline. */
export interface ArenaPlan {
  cur: number;                 // the live round's id (floor(now / len)) — accepting bets until betDeadline
  prev: number;                // cur - 1 — the round that just closed (-1 in the very first bucket)
  resolveRound: number | null; // prev, but ONLY if we opened it and haven't resolved it yet; else null
  openRound: number | null;    // cur, but ONLY if we haven't opened it yet; else null
  betDeadline: number;         // unix sec the cur round's betting window closes (== the next bucket's open)
}

/**
 * Encode a 0..1 market temperature as the r6 fixed-point int the contract stores (int64 = round(temp·1e6)).
 * The swarm's flat band is encoded identically, so entry/exit/band all compare in the same integer space.
 */
export function tempToR6(temperature: number): number {
  return Math.round(temperature * 1e6);
}

/**
 * Decide the resolver's writes for this tick from the current time, the round cadence and the persisted
 * cursor. Idempotent and self-healing: a round already opened is never re-opened, a round already resolved
 * is never re-resolved, and prev is only resolved if WE opened it (openedRound >= prev) — so a Worker that
 * comes online mid-stream opens the live round without trying to resolve a bucket it never baselined.
 * A missed resolve (e.g. a failed tx) leaves resolvedRound behind, so the next tick retries within the
 * contract's stale grace; past that grace anyone can refund the round (expireStale), so funds never lock.
 */
export function arenaRoundPlan(nowSec: number, roundLenSec: number, cursor: ArenaCursor): ArenaPlan {
  const cur = Math.floor(nowSec / roundLenSec);
  const prev = cur - 1;
  // Resolve prev only when it exists, we opened it, and it isn't resolved yet.
  const resolveRound = prev >= 0 && cursor.resolvedRound < prev && cursor.openedRound >= prev ? prev : null;
  // Open cur only when we haven't opened it yet (fresh start, or the bucket rolled over since last tick).
  const openRound = cursor.openedRound < cur ? cur : null;
  // Bet right up to the window close, which is exactly the next bucket's open instant (continuous rounds).
  const betDeadline = cur * roundLenSec + roundLenSec;
  return { cur, prev, resolveRound, openRound, betDeadline };
}

/**
 * Advance the resolver cursor after openRound(roundId) SUCCEEDED. Normally this just records the new high
 * water mark. The one subtlety is a FRESH mid-stream start (openedRound was -1): the Worker just opened
 * `cur` without ever opening `prev`, yet openedRound>=prev would otherwise make arenaRoundPlan target prev
 * for resolve on every cron this hour — and the contract reverts NotOpened on a never-opened round, burning
 * gas on ~one failed tx per cron until the bucket rolls over. Baselining resolvedRound to cur-1 marks that
 * un-openable prev as already handled, so the dead chase never starts. The NEXT bucket resolves `cur`
 * normally, because cur genuinely was opened. Pure + idempotent; unit-tested in arena.test.ts.
 */
export function cursorAfterOpen(cursor: ArenaCursor, openedRound: number): ArenaCursor {
  const resolvedRound = cursor.openedRound < 0
    ? Math.max(cursor.resolvedRound, openedRound - 1)   // fresh start: skip the prev we never baselined
    : cursor.resolvedRound;                             // steady state: resolve cursor is managed separately
  return { openedRound, resolvedRound };
}
