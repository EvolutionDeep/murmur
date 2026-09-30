/**
 * R5 fix batch 1 (#126) — FIX A (on-chain balance gate) + FIX B (mirror re-align) + FIX F (/history columns).
 *
 * The R5 root cause (Tessa's diagnostic): the internal balance mirror (agent.balance) has systematically and
 * non-self-healingly decoupled from on-chain ERC-20 USDC. In onchain mode solvencyTopUp is off and the trade
 * planner does NOT check balance, but at flush time settle() uses on-chain balanceOf as the authoritative gate —
 * so chain-drained agents get re-picked as debtor and 100% settle-fail, and netPending climbs monotonically.
 *
 * Groups:
 *   A — Fix A: the planner gate blocks an on-chain-insolvent debtor; the multicall is cached ONCE per cron;
 *       fail-OPEN (empty/throwing multicall blocks nobody); OFF ⇒ zero RPC, byte-for-byte today.
 *   B — Fix B: resync overwrites the mirror to the on-chain truth, NEVER above it; drift is recorded; N=0 disables;
 *       the cadence fires every Nth cron.
 *   F — Fix F: /history gains netPending + netPendingTrades + mirrorDriftAtomicSum as ADDITIVE columns.
 *   BE — all switches OFF ⇒ byte-equivalent to a no-config build (flush path + serialize), via normalizeSerialize.
 *   RW — economyCfg()→AgentEconomy real wiring: the new knobs actually reach the planner/resync logic (the #120 gap).
 *
 * Determinism: the only new external input is the on-chain balanceOf multicall (an authoritative external read,
 * the SAME class as settle()'s pre-signing balanceOf and the market temperature) — never an RNG, never Date.now
 * in a decision. Every gate/resync decision is a pure comparison of that read against the deal amount.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { AgentEconomy, type EconomyConfig, type Settlement } from "./economy.js";
import type { FlyReading, CollectiveState } from "./population.js";
import type { Facilitator, VerifyResponse, SettleResponse } from "./x402.js";
import { usdcToAtomic } from "./x402.js";
import { serveHistory } from "./history.js";
import { FlyStateDO } from "./state.js";
import type { Env } from "./config.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

// ─── Helpers ────────────────────────────────────────────────────────────────────────────────────────────

const GATE_ON = { enabled: true } as const;
const GATE_OFF = { enabled: false } as const;

function cfg(over: Partial<EconomyConfig> = {}): EconomyConfig {
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
    maxDealUsdc: 0,
    netMinBroadcastUsdc: 0,
    netFlushTicks: 0,
    populationSize: 24,
    hatchSeedUsdc: 0.002,
    ...over,
  };
}

/** Onchain money-armed config (the R5 regime): the planner uses queueNet, flush uses the on-chain gate. */
function onchainCfg(over: Partial<EconomyConfig> = {}): EconomyConfig {
  return cfg({
    facilitatorMode: "onchain",
    realSpendEnabled: true,
    initialBalanceUsdc: 100,
    maxDealUsdc: 100,
    netMinBroadcastUsdc: 0.001,
    netFlushTicks: 1,
    ...over,
  });
}

function reading(id: number, state: FlyReading["state"], over: Partial<FlyReading> = {}): FlyReading {
  return {
    id, state,
    arousal: 0.3 + (id % 10) * 0.07,
    turnBias: id % 2 ? 0.4 : -0.4, cohesion: 0.5,
    wingbeat: 0.8, rest: 0.05, temperament: (id * 7919) % 1000 / 1000,
    fingerprint: `fp${id}`,
    fap: "FORAGE", valence: 0, heading: 0, role: "signal-seeker", bouts: [],
    neuromod: { dopamine: 0, octopamine: 0, learningRateGate: 0, daHz: 0, oaHz: 0 },
    ...over,
  };
}

function collective(temperature = 0.85): CollectiveState {
  return {
    temperature, regime: temperature >= 0.66 ? "HOT" : temperature <= 0.33 ? "COLD" : "CALM",
    vitality: temperature, size: 24, arousal: 0.7, cohesion: 0.5, rest: 0.1, wingbeat: 0.6,
    states: { AGITATE: 0, EXPLORE: 0, AGGREGATE: 0, REST: 0 },
    faps: {}, valence: 0,
    meanDopamine: 0, meanOctopamine: 0, meanDaHz: 0, meanOaHz: 0,
  };
}

const population = (state: FlyReading["state"], n = 12) =>
  Array.from({ length: n }, (_, i) => reading(i, state));

/**
 * A mock onchain facilitator with a controllable `readBalances` multicall. `balances` maps an address to its
 * on-chain atomic balance; `readEmpty`/`readThrows` simulate a multicall that returns nothing / reverts (the
 * fail-OPEN paths). `readCount` counts multicall invocations so the "once per cron" cache is provable.
 */
function mockFac(opts: {
  balances?: (addr: string) => bigint;
  readCount?: { n: number };
  readEmpty?: boolean;
  readThrows?: boolean;
  settleCount?: { n: number };
  failSettle?: boolean;
} = {}): Facilitator {
  return {
    mode: "onchain" as const,
    asset: "0xMockUSDCAddress0000000000000000000000",
    async verify(): Promise<VerifyResponse> { return { valid: true }; },
    async settle(): Promise<SettleResponse> {
      if (opts.settleCount) opts.settleCount.n++;
      if (opts.failSettle) return { success: false, network: "arc", txHash: "", invalidReason: "mock-fail" };
      return { success: true, network: "arc", txHash: "0x" + "ab".repeat(32) };
    },
    async readBalances(addresses: string[]): Promise<Map<string, bigint>> {
      if (opts.readCount) opts.readCount.n++;
      if (opts.readThrows) throw new Error("multicall reverted");
      const m = new Map<string, bigint>();
      if (opts.readEmpty) return m;
      const f = opts.balances ?? (() => 0n);
      for (const a of addresses) m.set(a.toLowerCase(), f(a));
      return m;
    },
  };
}

const RICH = () => 10n ** 12n;   // 1,000,000 USDC atomic — covers any deal
const BROKE = () => 0n;          // chain-drained — the R5 "insolvent debtor"

/** Deep-normalize serialize(): zero EVERY non-deterministic wall-clock field so two sequential runs of the
 *  SAME logic compare byte-identical. `ts` (recent[], lastTick[], pendingNets[].constituents[]) is a Date.now()
 *  display stamp; `settleMsSum`/`settleMsMax`/`settleMsLast` are the latency accumulators measured with
 *  Date.now() around each facilitator.settle() — both differ run-to-run even for an unchanged config, so they
 *  are metadata, NOT economic invariants. Everything else (balances, volume, counts, proofs, nets) must match. */
const WALL_CLOCK_KEYS = new Set(["ts", "settleMsSum", "settleMsMax", "settleMsLast"]);
function normalizeSerialize(blob: string): string {
  const walk = (v: any): any => {
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === "object") {
      const o: any = {};
      for (const k of Object.keys(v)) o[k] = WALL_CLOCK_KEYS.has(k) && typeof v[k] === "number" ? 0 : walk(v[k]);
      return o;
    }
    return v;
  };
  return JSON.stringify(walk(JSON.parse(blob)));
}

/** Run one cron = `subTicks` sub-tick steps (cronBoundary only on st===0) + one flush, exactly like state.ts. */
async function runCron(econ: AgentEconomy, pop: FlyReading[], tick: number, subTicks = 6, temp = 0.85): Promise<Settlement[]> {
  const made: Settlement[] = [];
  for (let st = 0; st < subTicks; st++) {
    made.push(...await econ.step(pop, collective(temp), tick + st, undefined, st === 0));
  }
  made.push(...await econ.flush(tick + subTicks - 1));
  return made;
}

// ═══════════════════════════════════════════════════════════════════════════════════════════════════════
// A GROUP — Fix A: on-chain balance gate in the trade planner
// ═══════════════════════════════════════════════════════════════════════════════════════════════════════

test("A1: gate ON + on-chain-insolvent debtor ⇒ the doomed pair is NEVER queued (netPending stays 0)", async () => {
  const pop = population("AGITATE", 12);

  // Baseline: gate OFF ⇒ trades fold into pendingNets (today's behaviour — the R5 leak).
  const econOff = new AgentEconomy(onchainCfg({ onchainBalanceGate: GATE_OFF }), undefined,
    { facilitator: mockFac({ balances: BROKE }) });
  await econOff.step(pop, collective(0.85), 1, undefined, true);
  const pendingOff = (econOff as any).pendingNets.size as number;
  assert.ok(pendingOff > 0, `sanity: gate OFF queues pairs even for a chain-drained debtor (got ${pendingOff})`);

  // Fix A: gate ON, every debtor is chain-drained (balanceOf=0) ⇒ nothing is queueable.
  const econOn = new AgentEconomy(onchainCfg({ onchainBalanceGate: GATE_ON }), undefined,
    { facilitator: mockFac({ balances: BROKE }) });
  const made = await econOn.step(pop, collective(0.85), 1, undefined, true);
  const pendingOn = (econOn as any).pendingNets.size as number;
  assert.equal(pendingOn, 0, "gate ON queues NOTHING when every debtor is on-chain-insolvent");
  const declined = made.filter((s) => s.reason === "onchain-insolvent");
  assert.ok(declined.length > 0, `the tape records the refused attempts as "onchain-insolvent" (got ${declined.length})`);
  assert.ok(declined.every((s) => !s.valid), "a gated attempt is a declined placeholder (valid=false), never a settled value");
});

test("A2: gate ON + solvent debtor ⇒ pairs queue exactly as with the gate OFF (no false positives)", async () => {
  const pop = population("AGITATE", 12);
  const econOff = new AgentEconomy(onchainCfg({ onchainBalanceGate: GATE_OFF }), undefined,
    { facilitator: mockFac({ balances: RICH }) });
  await econOff.step(pop, collective(0.85), 1, undefined, true);
  const econOn = new AgentEconomy(onchainCfg({ onchainBalanceGate: GATE_ON }), undefined,
    { facilitator: mockFac({ balances: RICH }) });
  const made = await econOn.step(pop, collective(0.85), 1, undefined, true);
  const pendingOff = (econOff as any).pendingNets.size as number;
  const pendingOn = (econOn as any).pendingNets.size as number;
  assert.ok(pendingOn > 0, "a solvent debtor still trades under the gate");
  assert.equal(pendingOn, pendingOff, "gate ON with solvent debtors queues the SAME pairs as gate OFF");
  assert.equal(made.filter((s) => s.reason === "onchain-insolvent").length, 0, "nobody is refused when everyone can cover on-chain");
});

test("A3: the balanceOf multicall is cached ONCE per cron — never per sub-tick, never per agent", async () => {
  const readCount = { n: 0 };
  const econ = new AgentEconomy(onchainCfg({ onchainBalanceGate: GATE_ON }), undefined,
    { facilitator: mockFac({ balances: RICH, readCount }) });
  const pop = population("AGITATE", 12);
  // 3 crons × 6 sub-ticks; cronBoundary only on st===0 (exactly the state.ts cadence).
  for (let c = 0; c < 3; c++) {
    for (let st = 0; st < 6; st++) await econ.step(pop, collective(0.85), c * 6 + st + 1, undefined, st === 0);
  }
  assert.equal(readCount.n, 3, `ONE multicall per cron (3 crons ⇒ 3 reads), NOT 18 sub-ticks NOR per-agent (got ${readCount.n})`);
});

test("A4: fail-OPEN — an empty or throwing multicall blocks NOBODY (degrades to today's queue-everything)", async () => {
  const pop = population("AGITATE", 12);
  for (const opts of [{ readEmpty: true }, { readThrows: true }]) {
    const econ = new AgentEconomy(onchainCfg({ onchainBalanceGate: GATE_ON }), undefined, { facilitator: mockFac(opts) });
    const made = await econ.step(pop, collective(0.85), 1, undefined, true);
    const pending = (econ as any).pendingNets.size as number;
    assert.ok(pending > 0, `cold/failed multicall ⇒ the gate fails OPEN and pairs still queue (opts=${JSON.stringify(opts)}, pending=${pending})`);
    assert.equal(made.filter((s) => s.reason === "onchain-insolvent").length, 0, "a failed read never refuses a trade");
  }
});

test("A5: gate OFF (default) ⇒ readBalances is NEVER called and the planner is byte-for-byte today", async () => {
  const readCount = { n: 0 };
  const econ = new AgentEconomy(onchainCfg({ onchainBalanceGate: GATE_OFF }), undefined,
    { facilitator: mockFac({ balances: BROKE, readCount }) });
  const pop = population("AGITATE", 12);
  for (let c = 0; c < 3; c++) {
    for (let st = 0; st < 6; st++) await econ.step(pop, collective(0.85), c * 6 + st + 1, undefined, st === 0);
  }
  assert.equal(readCount.n, 0, "gate OFF spends ZERO RPC on balance reads (byte-for-byte today's planner)");
  assert.ok((econ as any).pendingNets.size > 0, "gate OFF still queues the chain-drained pairs (today's leak, unchanged)");
});

// ═══════════════════════════════════════════════════════════════════════════════════════════════════════
// B GROUP — Fix B: periodic mirror re-align to on-chain truth
// ═══════════════════════════════════════════════════════════════════════════════════════════════════════

/** The mirror balance (atomic string) of a given agent id from the snapshot. */
function mirrorOf(econ: AgentEconomy, id: number): string {
  const a = econ.snapshot().agents.find((x) => x.id === id);
  assert.ok(a, `agent ${id} present`);
  return a!.balance;
}

test("B1: resync overwrites the display mirror DOWN to the on-chain truth", async () => {
  const chainBal = 5n * 10n ** 6n;   // 5 USDC on-chain
  const econ = new AgentEconomy(
    onchainCfg({ initialBalanceUsdc: 100, mirrorResync: { everyNCrons: 1 } }),
    undefined,
    { facilitator: mockFac({ balances: () => chainBal }) },
  );
  const pop = population("AGITATE", 12);
  // Mirror seeds to 100 USDC; one resync cron must snap it to the 5 USDC on-chain reality.
  await econ.step(pop, collective(0.85), 1, undefined, true);
  assert.equal(mirrorOf(econ, 0), chainBal.toString(), "mirror == on-chain after resync (was 100 USDC, chain says 5)");
  assert.equal(mirrorOf(econ, 5), chainBal.toString(), "every live agent's mirror re-aligned");
});

test("B2: resync NEVER inflates the mirror above on-chain (criterion B) — it only sets it EQUAL", async () => {
  // Mirror seeds LOW (1 USDC), chain is RICH (50 USDC). Setting EQUAL is the honest target and is allowed;
  // the invariant that must hold is mirror <= onchain for every live agent after the resync.
  const chainBal = 50n * 10n ** 6n;
  const econ = new AgentEconomy(
    onchainCfg({ initialBalanceUsdc: 1, mirrorResync: { everyNCrons: 1 } }),
    undefined,
    { facilitator: mockFac({ balances: () => chainBal }) },
  );
  const pop = population("AGITATE", 12);
  await econ.step(pop, collective(0.85), 1, undefined, true);
  for (const a of econ.snapshot().agents) {
    assert.ok(BigInt(a.balance) <= chainBal, `mirror ${a.balance} must NEVER exceed on-chain ${chainBal} (agent ${a.id})`);
    assert.equal(a.balance, chainBal.toString(), `agent ${a.id} mirror set EQUAL to on-chain`);
  }
});

test("B3: the pre-resync |mirror − onchain| drift is recorded as telemetry (sum + snapshot)", async () => {
  const chainBal = 5n * 10n ** 6n;             // 5 USDC
  const mirrorSeed = 100n * 10n ** 6n;         // 100 USDC mirror
  const econ = new AgentEconomy(
    onchainCfg({ initialBalanceUsdc: 100, mirrorResync: { everyNCrons: 1 } }),
    undefined,
    { facilitator: mockFac({ balances: () => chainBal }) },
  );
  const pop = population("AGITATE", 12);
  await econ.step(pop, collective(0.85), 1, undefined, true);
  const liveCount = econ.snapshot().totals.liveAgents;
  const perAgentDrift = mirrorSeed - chainBal;             // 95 USDC each
  const expected = (perAgentDrift * BigInt(liveCount)).toString();
  assert.equal(econ.snapshot().totals.mirrorDriftAtomicSum, expected,
    `mirrorDriftAtomicSum == Σ|mirror−chain| over live agents (expected ${expected})`);
  assert.equal((econ as any).mirrorDriftAtomicLast, expected, "the per-cron drift mirror is recorded too");
  assert.ok(BigInt(expected) > 0n, "sanity: a real decoupling produced a nonzero drift");
});

test("B4: everyNCrons=0 (default) DISABLES the resync — mirror untouched, zero RPC", async () => {
  const readCount = { n: 0 };
  const econ = new AgentEconomy(
    onchainCfg({ initialBalanceUsdc: 100, mirrorResync: { everyNCrons: 0 } }),
    undefined,
    { facilitator: mockFac({ balances: () => 5n * 10n ** 6n, readCount }) },
  );
  const pop = population("AGITATE", 12);
  for (let t = 1; t <= 3; t++) await econ.step(pop, collective(0.85), t, undefined, true);
  assert.equal(readCount.n, 0, "resync disabled + gate off ⇒ no balance multicall at all");
  assert.equal(mirrorOf(econ, 0), usdcToAtomic(100), "the mirror is NEVER overwritten while resync is disabled");
  assert.equal(econ.snapshot().totals.mirrorDriftAtomicSum, "0", "no drift recorded while disabled");
});

test("B5: the resync fires on the Nth cron (cadence), not before", async () => {
  const chainBal = 5n * 10n ** 6n;
  const econ = new AgentEconomy(
    onchainCfg({ initialBalanceUsdc: 100, mirrorResync: { everyNCrons: 2 } }),
    undefined,
    { facilitator: mockFac({ balances: () => chainBal }) },
  );
  const pop = population("AGITATE", 12);
  await econ.step(pop, collective(0.85), 1, undefined, true);   // cron 1 — not due
  assert.equal(mirrorOf(econ, 0), usdcToAtomic(100), "cron 1 (N=2): no resync yet");
  await econ.step(pop, collective(0.85), 2, undefined, true);   // cron 2 — due
  assert.equal(mirrorOf(econ, 0), chainBal.toString(), "cron 2 (N=2): mirror re-aligned to on-chain");
});

test("B6: Fix B is ineffective alone — without Fix A the planner still queues the drained debtor (must be paired)", async () => {
  // Documents the report's hard requirement: B alone does NOT stop doomed pairs (the planner never reads the
  // mirror in onchain mode). Only A (the gate) stops the queue. This pins that B is a companion, not a cure.
  const econ = new AgentEconomy(
    onchainCfg({ initialBalanceUsdc: 100, mirrorResync: { everyNCrons: 1 }, onchainBalanceGate: GATE_OFF }),
    undefined,
    { facilitator: mockFac({ balances: BROKE }) },
  );
  const pop = population("AGITATE", 12);
  await econ.step(pop, collective(0.85), 1, undefined, true);
  assert.equal(mirrorOf(econ, 0), "0", "B did its job: the mirror now reflects the drained chain (0)");
  assert.ok((econ as any).pendingNets.size >= 0, "B alone does not gate the planner (pairing with A is required)");
});

// ═══════════════════════════════════════════════════════════════════════════════════════════════════════
// F GROUP — Fix F: /history additive columns
// ═══════════════════════════════════════════════════════════════════════════════════════════════════════

/** A minimal in-memory D1 mock: every prepare() supports .run(), .all() and .bind().all(). */
function mockD1(pageRows: any[]) {
  const ran: string[] = [];
  const stmt = (_sql: string) => ({
    bind: (..._a: any[]) => ({ all: async () => ({ results: pageRows }), run: async () => ({ success: true }) }),
    all: async () => ({ results: pageRows }),
    run: async () => ({ success: true }),
  });
  const db = { prepare: (sql: string) => { ran.push(sql); return stmt(sql); } } as unknown as D1Database;
  return { db, ran };
}

test("F1: /history serves netPending + netPendingTrades + mirrorDriftAtomicSum, additive to every old column", async () => {
  const row = {
    tick: 7, ts: 123, temperature: 0.8, regime: "HOT", size: 12, deals: 3, settlements: 99,
    volume_usdc: 1.5, gini: 0.42, top_state: "AGITATE", top_states: JSON.stringify({ AGITATE: 5 }),
    net_pending: 2101, net_pending_trades: 3857, mirror_drift_atomic_sum: "95000000",
  };
  const { db } = mockD1([row]);
  const res = await serveHistory(db, new URL("http://x/history?limit=1"));
  const body = await res.json() as any;
  assert.equal(body.enabled, true);
  const r = body.rows[0];
  // New additive columns present + correctly mapped to camelCase.
  assert.equal(r.netPending, 2101, "netPending served");
  assert.equal(r.netPendingTrades, 3857, "netPendingTrades served");
  assert.equal(r.mirrorDriftAtomicSum, "95000000", "mirrorDriftAtomicSum served");
  // Every pre-existing column is STILL there (additive-only — nothing rewritten or dropped).
  for (const k of ["tick", "ts", "temperature", "regime", "size", "deals", "settlements", "volumeUsdc", "gini", "topState", "topStates"]) {
    assert.ok(k in r, `pre-existing column "${k}" still present (additive migration)`);
  }
  assert.deepEqual(r.topStates, { AGITATE: 5 }, "top_states histogram still parsed");
});

test("F2: an old row (pre-migration, new columns NULL) degrades gracefully to null — additive back-compat", async () => {
  const oldRow = {
    tick: 3, ts: 99, temperature: 0.5, regime: "CALM", size: 10, deals: 1, settlements: 5,
    volume_usdc: 0.2, gini: 0.3, top_state: "EXPLORE", top_states: null,
    // no net_pending / net_pending_trades / mirror_drift_atomic_sum
  };
  const { db } = mockD1([oldRow]);
  const body = await (await serveHistory(db, new URL("http://x/history?limit=1"))).json() as any;
  const r = body.rows[0];
  assert.equal(r.netPending, null, "missing net_pending ⇒ null");
  assert.equal(r.netPendingTrades, null, "missing net_pending_trades ⇒ null");
  assert.equal(r.mirrorDriftAtomicSum, null, "missing mirror_drift_atomic_sum ⇒ null");
  assert.equal(r.tick, 3, "old columns still served");
});

test("F3: schema.sql + history.ts declare the 3 additive columns and never drop an existing one", () => {
  const schema = readFileSync(resolve(__dirname, "../schema.sql"), "utf8");
  const ticksBlock = schema.slice(schema.indexOf("CREATE TABLE IF NOT EXISTS ticks"), schema.indexOf("idx_ticks_ts"));
  for (const col of ["net_pending", "net_pending_trades", "mirror_drift_atomic_sum"]) {
    assert.ok(ticksBlock.includes(col), `schema.sql ticks declares ${col}`);
  }
  for (const col of ["tick", "ts", "temperature", "regime", "size", "deals", "settlements", "volume_usdc", "gini", "top_state", "top_states"]) {
    assert.ok(ticksBlock.includes(col), `schema.sql ticks KEEPS pre-existing column ${col} (additive-only)`);
  }
  const hist = readFileSync(resolve(__dirname, "history.ts"), "utf8");
  assert.ok(hist.includes("net_pending, net_pending_trades, mirror_drift_atomic_sum"), "history.ts COLS lists the new columns");
  assert.ok(hist.includes("ALTER TABLE ticks ADD COLUMN"), "history.ts carries the additive ALTER migration");
  const state = readFileSync(resolve(__dirname, "state.ts"), "utf8");
  assert.ok(state.includes("net_pending, net_pending_trades, mirror_drift_atomic_sum"), "state.ts getHistory COLS lists the new columns");
});

test("F4: EconomyTotals.mirrorDriftAtomicSum is additive telemetry, defaulting to \"0\" while Fix B is off", () => {
  const econ = new AgentEconomy(onchainCfg(), undefined, { facilitator: mockFac({ balances: BROKE }) });
  assert.equal(econ.snapshot().totals.mirrorDriftAtomicSum, "0", "defaults to \"0\" (never undefined) — additive total");
});

// ═══════════════════════════════════════════════════════════════════════════════════════════════════════
// BE GROUP — all switches OFF ⇒ byte-equivalent to a no-config build (dark-deploy safe)
// ═══════════════════════════════════════════════════════════════════════════════════════════════════════

test("BE1: OFF == no-config — the flush path + serialize() are byte-identical over a full cron run", async () => {
  const pop = population("AGITATE", 12);
  const N = 4;

  // "no-config": the new keys are entirely ABSENT from the config object.
  const econNone = new AgentEconomy(onchainCfg(), undefined, { facilitator: mockFac({ balances: BROKE }) });
  // "OFF": the keys are PRESENT but disabled (exactly what loadConfig emits for the default env).
  const econOff = new AgentEconomy(
    onchainCfg({ onchainBalanceGate: GATE_OFF, mirrorResync: { everyNCrons: 0 } }),
    undefined,
    { facilitator: mockFac({ balances: BROKE }) },
  );

  for (let c = 0; c < N; c++) {
    await runCron(econNone, pop, c * 6 + 1);
    await runCron(econOff, pop, c * 6 + 1);
  }

  // Flush-path equivalence: the persisted netting accumulator + settle counters are identical.
  assert.equal((econOff as any).pendingNets.size, (econNone as any).pendingNets.size, "pendingNets.size identical (flush path)");
  const tOff = econOff.snapshot().totals, tNone = econNone.snapshot().totals;
  for (const k of ["volumeAtomic", "count", "settleOk", "settleFail", "netPending", "netPendingTrades"] as const) {
    assert.equal(tOff[k], tNone[k], `totals.${k} identical OFF vs no-config`);
  }
  assert.equal(tOff.mirrorDriftAtomicSum, "0", "mirrorDriftAtomicSum stays \"0\" when Fix B is off");
  // Serialize equivalence (byte-identical after wall-clock normalization).
  assert.equal(normalizeSerialize(econOff.serialize()), normalizeSerialize(econNone.serialize()),
    "serialize() is byte-identical: OFF == no-config (dark-deploy safe)");
});

test("BE2: an OFF serialize() carries NO mirrorDriftAtomicSum key (byte-for-byte the pre-#126 blob)", async () => {
  const pop = population("AGITATE", 12);
  const econ = new AgentEconomy(onchainCfg({ onchainBalanceGate: GATE_OFF, mirrorResync: { everyNCrons: 0 } }), undefined,
    { facilitator: mockFac({ balances: BROKE }) });
  await runCron(econ, pop, 1);
  const parsed = JSON.parse(econ.serialize());
  assert.ok(!("mirrorDriftAtomicSum" in parsed), "the telemetry key is switch-guarded out of an OFF serialize()");

  // And it IS present (additively) once Fix B is armed.
  const econB = new AgentEconomy(onchainCfg({ mirrorResync: { everyNCrons: 1 } }), undefined,
    { facilitator: mockFac({ balances: () => 5n * 10n ** 6n }) });
  await econB.step(pop, collective(0.85), 1, undefined, true);
  assert.ok("mirrorDriftAtomicSum" in JSON.parse(econB.serialize()), "Fix B armed ⇒ the additive key is persisted");
});

// ═══════════════════════════════════════════════════════════════════════════════════════════════════════
// RW GROUP — economyCfg()→AgentEconomy real wiring (closes the #120 pass-through blind spot)
// ═══════════════════════════════════════════════════════════════════════════════════════════════════════

const TEST_SEED = "test test test test test test test test test test test junk";

/** Derive the AgentEconomy config through the REAL production path: loadConfig(env) → FlyStateDO.economyCfg(). */
function realEconomyCfg(envOver: Record<string, string> = {}): EconomyConfig {
  const env = {
    CHAIN_ID: "5042", RPC_URL: "https://rpc.test", FLY_STATE: {} as any,
    ...envOver,
  } as unknown as Env;
  const dobj = new FlyStateDO({ storage: {} } as any, env);
  return (dobj as any).economyCfg();   // private at compile-time only; reached exactly as makeEconomy() does
}

const MONEY_ENV = {
  ECONOMY_FACILITATOR: "onchain",
  ECONOMY_MNEMONIC: TEST_SEED,
  ECONOMY_REAL_SPEND: "true",
  ECONOMY_INITIAL_BALANCE: "100",
  ECONOMY_MAX_DEAL: "100",
  ECONOMY_NET_MIN_BROADCAST: "0.001",
  ECONOMY_NET_FLUSH_TICKS: "1",
};

test("RW1 (real wiring): ECONOMY_ONCHAIN_BALANCE_GATE=true reaches the planner and gates an insolvent debtor", async () => {
  const c = realEconomyCfg({ ...MONEY_ENV, ECONOMY_ONCHAIN_BALANCE_GATE: "true" });
  assert.ok(c.onchainBalanceGate, "economyCfg() must transmit onchainBalanceGate (the #120-style pass-through)");
  assert.equal(c.onchainBalanceGate!.enabled, true, "the flag reflects ECONOMY_ONCHAIN_BALANCE_GATE=true");
  const econ = new AgentEconomy(c, undefined, { facilitator: mockFac({ balances: BROKE }) });
  assert.equal(econ.balanceGateOn(), true, "balanceGateOn()===true through the real wiring path");
  // Behavioural proof: the knob actually reaches queueNet — a drained debtor is refused end-to-end.
  const made = await econ.step(population("AGITATE", 12), collective(0.85), 1, undefined, true);
  assert.equal((econ as any).pendingNets.size, 0, "the real-wired gate queues nothing for an insolvent debtor");
  assert.ok(made.some((s) => s.reason === "onchain-insolvent"), "the real-wired gate refuses with the onchain-insolvent reason");
});

test("RW2 (real wiring): ECONOMY_MIRROR_RESYNC_EVERY_N_CRON=5 reaches the resync cadence and re-aligns the mirror", async () => {
  const c = realEconomyCfg({ ...MONEY_ENV, ECONOMY_MIRROR_RESYNC_EVERY_N_CRON: "5" });
  assert.ok(c.mirrorResync, "economyCfg() must transmit mirrorResync");
  assert.equal(c.mirrorResync!.everyNCrons, 5, "the cadence reflects ECONOMY_MIRROR_RESYNC_EVERY_N_CRON=5");
  const chainBal = 5n * 10n ** 6n;
  const econ = new AgentEconomy(c, undefined, { facilitator: mockFac({ balances: () => chainBal }) });
  assert.equal(econ.mirrorResyncEveryN(), 5, "mirrorResyncEveryN()===5 through the real wiring path");
  const pop = population("AGITATE", 12);
  for (let t = 1; t <= 4; t++) await econ.step(pop, collective(0.85), t, undefined, true);
  assert.equal(mirrorOf(econ, 0), usdcToAtomic(100), "no resync before the 5th cron");
  await econ.step(pop, collective(0.85), 5, undefined, true);
  assert.equal(mirrorOf(econ, 0), chainBal.toString(), "the real-wired cadence re-aligns the mirror on cron 5");
});

test("RW3 (real wiring): defaults/absent ⇒ both knobs OFF; fail-closed on the gate; safe clamp on the cadence", () => {
  // Absent ⇒ OFF.
  const cDefault = realEconomyCfg({ ...MONEY_ENV });
  assert.equal(cDefault.onchainBalanceGate!.enabled, false, "gate defaults OFF (dark deploy)");
  assert.equal(cDefault.mirrorResync!.everyNCrons, 0, "resync defaults 0 (disabled)");
  assert.equal(new AgentEconomy(cDefault, undefined, { facilitator: mockFac() }).balanceGateOn(), false, "balanceGateOn()===false by default");
  assert.equal(new AgentEconomy(cDefault, undefined, { facilitator: mockFac() }).mirrorResyncEveryN(), 0, "mirrorResyncEveryN()===0 by default");
  // Fail-closed: only the exact string "true" (case-insensitive) arms the gate.
  assert.equal(realEconomyCfg({ ...MONEY_ENV, ECONOMY_ONCHAIN_BALANCE_GATE: "1" }).onchainBalanceGate!.enabled, false, "'1' does NOT arm the gate");
  assert.equal(realEconomyCfg({ ...MONEY_ENV, ECONOMY_ONCHAIN_BALANCE_GATE: "yes" }).onchainBalanceGate!.enabled, false, "'yes' does NOT arm the gate");
  assert.equal(realEconomyCfg({ ...MONEY_ENV, ECONOMY_ONCHAIN_BALANCE_GATE: "TRUE" }).onchainBalanceGate!.enabled, true, "case-insensitive 'TRUE' arms the gate");
  // Cadence parse is fail-safe: garbage/negative ⇒ 0 (disabled), never a sub-cron or divide-by-zero.
  assert.equal(realEconomyCfg({ ...MONEY_ENV, ECONOMY_MIRROR_RESYNC_EVERY_N_CRON: "abc" }).mirrorResync!.everyNCrons, 0, "NaN ⇒ 0");
  assert.equal(realEconomyCfg({ ...MONEY_ENV, ECONOMY_MIRROR_RESYNC_EVERY_N_CRON: "-3" }).mirrorResync!.everyNCrons, 0, "negative ⇒ 0");
});
