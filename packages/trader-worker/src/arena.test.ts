// Human-vs-swarm prediction arena tests — the resolver wiring + the config gates that keep it inert.
//
// The arena lets MURMUR holders bet on the SAME Arc-temperature move the fly swarm does. It is a REAL,
// non-custodial on-chain market: the Worker is the contract's authorized resolver and its openRound /
// resolve calls cost real gas and commit the temperatures that decide real payouts. So the two things
// that MUST be pinned by tests are:
//   1. ZERO REGRESSION WHEN OFF — the arena is disabled by default and every gate (config disabled, no
//      address, simulated facilitator, real-spend kill switch, shadow mode) must leave the live tick
//      byte-for-byte unchanged and never emit an arena write. A deployed Worker with no ARENA_* vars must
//      behave exactly as before the arena existed.
//   2. RESOLVER CORRECTNESS WHEN ON — the round-bucketing decision (which round to resolve, which to open,
//      the betting deadline) must be right, idempotent and self-healing, because a wrong roundId or
//      deadline is real money mis-committed on-chain.
//
// The decision logic is a PURE function (arena.ts arenaRoundPlan / tempToR6), tested here directly; the
// side-effecting delegators (economy.ts arenaOpen/arenaResolve/arenaRoundInfo) are tested to degrade to
// null in simulated mode; and the config gates are tested through loadConfig.

import test from "node:test";
import assert from "node:assert/strict";

import { arenaRoundPlan, cursorAfterOpen, tempToR6, type ArenaCursor } from "./arena.js";
import { loadConfig, type Env } from "./config.js";
import { AgentEconomy, type EconomyConfig } from "./economy.js";

// ---------- helpers ----------

/** A minimal, valid Env (only the three required fields matter for config parsing; the rest default). */
function env(over: Partial<Env> = {}): Env {
  return {
    FLY_STATE: {} as Env["FLY_STATE"],
    CHAIN_ID: "5042002",
    RPC_URL: "https://rpc.testnet.arc.io",
    ...over,
  } as Env;
}

/** Deterministic simulated-mode economy config (no keys, no chain, no RPC). */
function econCfg(over: Partial<EconomyConfig> = {}): EconomyConfig {
  return {
    enabled: true,
    network: "arc",
    initialBalanceUsdc: 6,
    basePriceUsdc: 0.002,
    solvencyFloorUsdc: 0.5,
    maxDealsPerTick: 24,
    facilitatorMode: "simulated",
    seedBase: 42,
    realSpendEnabled: false,
    dailyCapUsdc: 0,
    perAgentDailyCapUsdc: 0,
    maxDealUsdc: 0.05,
    netMinBroadcastUsdc: 0.004,
    netFlushTicks: 30,
    populationSize: 24,
    hatchSeedUsdc: 0.002,
    ...over,
  };
}

const FRESH: ArenaCursor = { openedRound: -1, resolvedRound: -1 };
const LEN = 3600; // 1-hour rounds

// ---------- tempToR6: the fixed-point encoding the contract stores ----------

test("tempToR6 encodes a 0..1 temperature as the r6 int64 the contract compares against", () => {
  assert.equal(tempToR6(0), 0);
  assert.equal(tempToR6(1), 1_000_000);
  assert.equal(tempToR6(0.5), 500_000);
  assert.equal(tempToR6(0.008), 8_000);        // the default flat band
  assert.equal(tempToR6(0.1234567), 123_457);  // rounds to nearest micro
  assert.equal(tempToR6(0.9999994), 999_999);
});

// ---------- arenaRoundPlan: the resolver's open/resolve decision ----------

test("a fresh resolver opens the live round and does NOT resolve a bucket it never baselined", () => {
  const now = 1_000 * LEN + 1234; // mid-way through bucket 1000
  const plan = arenaRoundPlan(now, LEN, FRESH);
  assert.equal(plan.cur, 1000);
  assert.equal(plan.prev, 999);
  assert.equal(plan.openRound, 1000, "opens the current bucket");
  assert.equal(plan.resolveRound, null, "prev was never opened by us ⇒ nothing to resolve (no bogus exit)");
  assert.equal(plan.betDeadline, 1001 * LEN, "betting closes exactly at the next bucket's open");
});

test("in steady state the resolver closes prev and opens cur with the SAME instant (continuous rounds)", () => {
  const now = 1_001 * LEN + 10; // just rolled into bucket 1001
  const cursor: ArenaCursor = { openedRound: 1000, resolvedRound: 999 };
  const plan = arenaRoundPlan(now, LEN, cursor);
  assert.equal(plan.cur, 1001);
  assert.equal(plan.resolveRound, 1000, "resolves the bucket that just closed");
  assert.equal(plan.openRound, 1001, "opens the new bucket");
  assert.equal(plan.betDeadline, 1002 * LEN);
});

test("the plan is idempotent: re-running inside the same bucket writes nothing", () => {
  const now = 1_001 * LEN + 999;
  const cursor: ArenaCursor = { openedRound: 1001, resolvedRound: 1000 };
  const plan = arenaRoundPlan(now, LEN, cursor);
  assert.equal(plan.openRound, null, "cur already opened");
  assert.equal(plan.resolveRound, null, "prev already resolved");
});

test("a missed resolve is retried on the next tick (self-healing within the stale grace)", () => {
  // prev opened but the resolve tx failed last cron ⇒ resolvedRound lagged behind.
  const now = 1_001 * LEN + 5;
  const cursor: ArenaCursor = { openedRound: 1001, resolvedRound: 999 };
  const plan = arenaRoundPlan(now, LEN, cursor);
  assert.equal(plan.resolveRound, 1000, "retries the unresolved bucket");
  assert.equal(plan.openRound, null, "does not re-open the already-open live round");
});

test("the very first bucket (cur=0) opens but never resolves a negative round", () => {
  const plan = arenaRoundPlan(10, LEN, FRESH);
  assert.equal(plan.cur, 0);
  assert.equal(plan.prev, -1);
  assert.equal(plan.openRound, 0);
  assert.equal(plan.resolveRound, null, "prev < 0 ⇒ guard holds");
  assert.equal(plan.betDeadline, LEN);
});

test("coming online far mid-stream opens the live round without resolving ancient history", () => {
  const cursor: ArenaCursor = { openedRound: -1, resolvedRound: -1 };
  const plan = arenaRoundPlan(5_000_000 * LEN + 7, LEN, cursor);
  assert.equal(plan.cur, 5_000_000);
  assert.equal(plan.openRound, 5_000_000);
  assert.equal(plan.resolveRound, null, "openedRound < prev ⇒ we never baselined it ⇒ do not resolve");
});

test("a non-standard cadence buckets correctly (5-minute rounds)", () => {
  const len = 300;
  const now = 42 * len + 42; // bucket 42
  const plan = arenaRoundPlan(now, len, { openedRound: 41, resolvedRound: 40 });
  assert.equal(plan.cur, 42);
  assert.equal(plan.resolveRound, 41);
  assert.equal(plan.openRound, 42);
  assert.equal(plan.betDeadline, 43 * len);
});

// ---------- cursorAfterOpen: the fresh-start baseline that prevents a resolve gas-drain ----------

test("a fresh first open baselines resolvedRound to cur-1 so the un-opened prev is never chased", () => {
  // The Worker comes online mid-stream and opens bucket 1000 without ever opening 999.
  const c = cursorAfterOpen(FRESH, 1000);
  assert.equal(c.openedRound, 1000);
  assert.equal(c.resolvedRound, 999, "prev (999) is marked handled — it was never opened, so resolving it would revert NotOpened");
});

test("REGRESSION: after a fresh open, every later cron in the SAME bucket writes nothing (no ~59 reverting resolve txs)", () => {
  const now = 1_000 * LEN + 1234;              // mid-bucket 1000
  const opened = cursorAfterOpen(FRESH, arenaRoundPlan(now, LEN, FRESH).openRound!);
  // Cron 2..end-of-hour: cur is still 1000, prev still 999. With the baseline, both writes are null.
  const plan = arenaRoundPlan(now + 60, LEN, opened);
  assert.equal(plan.openRound, null, "cur already opened");
  assert.equal(plan.resolveRound, null, "prev baselined as resolved ⇒ NO dead resolve chase ⇒ no wasted gas");
});

test("the bucket AFTER a fresh start resolves cur normally (cur genuinely was opened)", () => {
  const opened = cursorAfterOpen(FRESH, 1000);          // {1000, 999}
  const plan = arenaRoundPlan(1_001 * LEN + 5, LEN, opened);
  assert.equal(plan.resolveRound, 1000, "the round we truly opened is resolved with a real exit");
  assert.equal(plan.openRound, 1001, "and the next bucket opens");
});

test("steady-state open leaves resolvedRound untouched (the resolve step owns it)", () => {
  const c = cursorAfterOpen({ openedRound: 1000, resolvedRound: 999 }, 1001);
  assert.equal(c.openedRound, 1001);
  assert.equal(c.resolvedRound, 999, "no baseline once we've opened before");
});

// ---------- economy delegators: safe degrade when the arena is not wired ----------

test("in simulated mode the arena delegators all return null (no chain, no resolver key, zero regression)", async () => {
  const econ = new AgentEconomy(econCfg());
  assert.equal(econ.facilitatorMode, "simulated");
  assert.equal(await econ.arenaOpen(1, 500_000, 8_000, 7_200), null);
  assert.equal(await econ.arenaResolve(1, 520_000), null);
  assert.equal(await econ.arenaRoundInfo(1), null);
});

test("a delegator whose facilitator throws still returns null (an arena fault can never abort a tick)", async () => {
  const econ = new AgentEconomy(econCfg());
  // Inject a facilitator whose arena methods throw — the delegators must swallow and return null.
  const boom = () => {
    throw new Error("rpc down");
  };
  (econ as unknown as { facilitator: object }).facilitator = {
    mode: "onchain",
    arenaOpen: boom,
    arenaResolve: boom,
    arenaRoundInfo: boom,
  };
  assert.equal(await econ.arenaOpen(1, 500_000, 8_000, 7_200), null);
  assert.equal(await econ.arenaResolve(1, 520_000), null);
  assert.equal(await econ.arenaRoundInfo(1), null);
});

// ---------- loadConfig: the ARENA_* gates and inert-by-default guarantee ----------

test("by default the arena is disabled and inert (zero behaviour change for an existing deployment)", () => {
  const a = loadConfig(env()).arena;
  assert.equal(a.enabled, false, "ARENA_ENABLED unset ⇒ disabled");
  assert.equal(a.address, null);
  assert.equal(a.token, null);
  assert.equal(a.roundLenSec, 3600, "default 60-minute rounds");
  assert.equal(a.flatBand, 0.008, "defaults to the swarm's flat band so both markets resolve identically");
  assert.equal(a.staleGraceSec, 259200, "3 days before anyone may expire an unresolved round");
});

test("enabled requires ARENA_ENABLED=true; address/token are trimmed and empty⇒null", () => {
  const on = loadConfig(
    env({ ARENA_ENABLED: "true", ARENA_ADDRESS: "  0xabc  ", ARENA_TOKEN: "0xdef" }),
  ).arena;
  assert.equal(on.enabled, true);
  assert.equal(on.address, "0xabc", "whitespace trimmed");
  assert.equal(on.token, "0xdef");

  assert.equal(loadConfig(env({ ARENA_ENABLED: "TRUE" })).arena.enabled, true, "case-insensitive");
  assert.equal(loadConfig(env({ ARENA_ENABLED: "false" })).arena.enabled, false);
  assert.equal(loadConfig(env({ ARENA_ENABLED: "1" })).arena.enabled, false, "only 'true' enables");
  assert.equal(loadConfig(env({ ARENA_ADDRESS: "   " })).arena.address, null, "blank ⇒ null (step skipped)");
});

test("round length is parsed from minutes and clamped to 1..1440 minutes", () => {
  assert.equal(loadConfig(env({ ARENA_ROUND_MIN: "15" })).arena.roundLenSec, 900);
  assert.equal(loadConfig(env({ ARENA_ROUND_MIN: "0" })).arena.roundLenSec, 60, "clamped up to 1 minute");
  assert.equal(loadConfig(env({ ARENA_ROUND_MIN: "99999" })).arena.roundLenSec, 1440 * 60, "clamped to 1 day");
});

test("the arena flat band falls back to PREDICT_FLAT_BAND, and an explicit band wins", () => {
  assert.equal(loadConfig(env({ PREDICT_FLAT_BAND: "0.02" })).arena.flatBand, 0.02, "inherits the swarm band");
  assert.equal(
    loadConfig(env({ PREDICT_FLAT_BAND: "0.02", ARENA_FLAT_BAND: "0.05" })).arena.flatBand,
    0.05,
    "explicit arena band overrides",
  );
});

test("the stale grace is clamped to 1 hour .. 30 days", () => {
  assert.equal(loadConfig(env({ ARENA_STALE_GRACE_SEC: "10" })).arena.staleGraceSec, 3600);
  assert.equal(loadConfig(env({ ARENA_STALE_GRACE_SEC: "99999999" })).arena.staleGraceSec, 30 * 86400);
  assert.equal(loadConfig(env({ ARENA_STALE_GRACE_SEC: "7200" })).arena.staleGraceSec, 7200);
});
