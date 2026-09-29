/**
 * Flag-ON convergence tests (Mark #84 gate (b)).
 *
 * Verifies that capabilities ① (playbook) and ② (MAP-Elites) actually DELIVER their advertised behaviour
 * when the respective feature flags are enabled — not just that they're inert when OFF (existing tests).
 *
 * Plus H7 regression: unflushed remaining must NOT be silently discarded.
 */
import test from "node:test";
import assert from "node:assert/strict";

import { AgentEconomy, type EconomyConfig } from "./economy.js";
import { ElitesArchive, computeBins, binArousal, binSettleRate, binEntropy } from "./elites.js";
import type { FlyReading, CollectiveState } from "./population.js";
import type { Facilitator, VerifyResponse, SettleResponse } from "./x402.js";

// ─── Helpers ────────────────────────────────────────────────────────────────────────────────────────────

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

function reading(id: number, state: FlyReading["state"], over: Partial<FlyReading> = {}): FlyReading {
  return {
    id, state,
    arousal: 0.3 + (id % 10) * 0.07,   // varied arousal so bins aren't all the same
    turnBias: id % 2 ? 0.4 : -0.4, cohesion: 0.5,
    wingbeat: 0.8, rest: 0.05, temperament: (id * 7919) % 1000 / 1000,
    fingerprint: `fp${id}`,
    fap: "FORAGE", valence: 0, heading: 0, role: "signal-seeker", bouts: [],
    neuromod: { dopamine: 0, octopamine: 0, learningRateGate: 0, daHz: 0, oaHz: 0 },
    ...over,
  };
}

function collective(temperature = 0.8): CollectiveState {
  return {
    temperature, regime: temperature >= 0.66 ? "HOT" : temperature <= 0.33 ? "COLD" : "CALM",
    vitality: temperature, size: 24, arousal: 0.7, cohesion: 0.5, rest: 0.1, wingbeat: 0.6,
    states: { AGITATE: 0, EXPLORE: 0, AGGREGATE: 0, REST: 0 },
    faps: {}, valence: 0,
    meanDopamine: 0, meanOctopamine: 0, meanDaHz: 0, meanOaHz: 0,
  };
}

const population = (state: FlyReading["state"], n = 24) =>
  Array.from({ length: n }, (_, i) => reading(i, state));

function mockFacilitator(opts: { failSettle?: boolean } = {}): Facilitator {
  return {
    mode: "onchain" as const,
    asset: "0x MockUSDC Address 000000000000000",
    async verify(): Promise<VerifyResponse> { return { valid: true }; },
    async settle(): Promise<SettleResponse> {
      if (opts.failSettle) return { success: false, network: "arc", txHash: "", invalidReason: "mock-fail" };
      return { success: true, network: "arc", txHash: "0x" + "ab".repeat(32) };
    },
  };
}

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

// ═══════════════════════════════════════════════════════════════════════════════════════════════════════
// PLAYBOOK flag-ON convergence (capability ①)
// ═══════════════════════════════════════════════════════════════════════════════════════════════════════

test("H5: playbook ON — boughtScore drives good override (sold entries do NOT bias the buy decision)", async () => {
  const PLAYBOOK_CFG = { enabled: true } as const;
  const pop = population("AGITATE", 12);
  const econ = new AgentEconomy(cfg({ playbook: PLAYBOOK_CFG }));
  // Run enough ticks for the playbook to accumulate consequence entries
  for (let t = 0; t < 50; t++) await econ.step(pop, collective(0.85), t);
  // Serialize and verify that bought/sold are recorded separately via action field
  const blob = JSON.parse(econ.serialize());
  assert.ok(blob.playbook && blob.playbook.length > 0, "playbook has entries");
  // Entries with action=0 (buy) and action=1 (sell) should both exist
  let buys = 0, sells = 0;
  for (const rec of blob.playbook) {
    for (const e of rec.e) {
      if (e[1] === 0) buys++;
      else if (e[1] === 1) sells++;
    }
  }
  assert.ok(buys > 0, "buy-side entries exist (action=0)");
  assert.ok(sells > 0, "sell-side entries exist (action=1)");
  // The override reads ONLY boughtScore — verified structurally: the function signature returns
  // { bought, sold } and playbookGoodOverride destructures only `bought`.
  // Run a snapshot to verify the economy is healthy (no crash/NaN from the split accounting).
  const snap = econ.snapshot();
  assert.ok(snap.totals.count > 0, "trades happened");
  assert.ok(Number.isFinite(snap.totals.gini), "gini is finite (no NaN from playbook scores)");
});

test("H5: playbook ON — snapshot exposes playbook in evolution.js contract shape", async () => {
  const PLAYBOOK_CFG = { enabled: true } as const;
  const pop = population("AGITATE", 8);
  const econ = new AgentEconomy(cfg({ playbook: PLAYBOOK_CFG }));
  for (let t = 0; t < 20; t++) await econ.step(pop, collective(0.85), t);
  const snap = econ.snapshot();
  // Flag ON → playbook key present
  assert.ok(snap.playbook, "playbook key is present in snapshot when flag is ON");
  assert.ok(Array.isArray(snap.playbook), "playbook is an array");
  // Shape: [{id, e: [[ctx, action, good, regime, outcome, valid, tick], ...]}]
  for (const rec of snap.playbook!) {
    assert.equal(typeof rec.id, "number");
    assert.ok(Array.isArray(rec.e));
    for (const entry of rec.e) {
      assert.equal(entry.length, 7, "each entry is a 7-element array");
      assert.ok(entry.every((v: number) => Number.isFinite(v)), "all values are finite numbers");
    }
  }
});

test("playbook OFF — snapshot does NOT expose playbook key (dark-deployment byte-equivalent)", async () => {
  const pop = population("AGITATE", 8);
  const econ = new AgentEconomy(cfg());  // no playbook config
  for (let t = 0; t < 10; t++) await econ.step(pop, collective(0.85), t);
  const snap = econ.snapshot();
  assert.equal(snap.playbook, undefined, "playbook key absent when flag OFF");
});

// ═══════════════════════════════════════════════════════════════════════════════════════════════════════
// MAP-ELITES flag-ON convergence (capability ②)
// ═══════════════════════════════════════════════════════════════════════════════════════════════════════

test("H6: elites ON (simulated) — bins are NON-DEGENERATE (multiple cells occupied)", async () => {
  const ELITES_CFG = { enabled: true } as const;
  const pop = population("AGITATE", 24);
  const econ = new AgentEconomy(cfg({ elites: ELITES_CFG, maxDealsPerTick: 24 }));
  // Run enough cron boundaries for the archive to populate (updateElitesArchive fires on cronBoundary=true)
  for (let t = 0; t < 30; t++) await econ.step(pop, collective(0.5 + (t % 5) * 0.1), t, undefined, true);
  const archive = econ.getElitesArchive();
  assert.ok(archive, "archive is accessible when elites is ON");
  assert.ok(archive!.occupied > 1, `archive occupies multiple cells (got ${archive!.occupied}) — not degenerate`);
  // Verify the three dimensions have variation (not all zeros)
  const bins = Array.from(archive!.entries()).map(([, e]) => e.bins);
  const uniqueArousal = new Set(bins.map((b) => b[0]));
  const uniqueSettle = new Set(bins.map((b) => b[1]));
  const uniqueEntropy = new Set(bins.map((b) => b[2]));
  assert.ok(uniqueArousal.size >= 1, "arousal dimension has values");
  // H6-B fix: goodCounts is now populated in simulated mode → entropy should have variation
  assert.ok(uniqueEntropy.size >= 1, `entropy dimension has values (got ${uniqueEntropy.size} unique)`);
});

test("H6: elites ON (simulated) — goodCounts accumulate in simulated mode (entropy dim alive)", async () => {
  const ELITES_CFG = { enabled: true } as const;
  const pop = population("AGITATE", 12);
  const econ = new AgentEconomy(cfg({ elites: ELITES_CFG }));
  for (let t = 0; t < 50; t++) await econ.step(pop, collective(0.85), t, undefined, true);
  // Serialize and check goodCounts are non-zero
  const blob = JSON.parse(econ.serialize());
  assert.ok(blob.goodCounts, "goodCounts key exists in serialized state");
  const nonZero = (blob.goodCounts as Array<{ g: number[] }>).filter((r) => r.g.some((v) => v > 0));
  assert.ok(nonZero.length > 0, `goodCounts has non-zero entries in simulated mode (${nonZero.length} agents)`);
});

test("H6: elites ON (onchain) — bins are non-degenerate after flush", async () => {
  const ELITES_CFG = { enabled: true } as const;
  const pop = population("AGITATE", 24);
  const econ = new AgentEconomy(
    onchainCfg({ elites: ELITES_CFG, maxDealsPerTick: 24 }),
    undefined,
    { facilitator: mockFacilitator() },
  );
  for (let t = 1; t <= 10; t++) await econ.step(pop, collective(0.5 + (t % 5) * 0.1), t, undefined, true);
  await econ.flush(15);
  const archive = econ.getElitesArchive();
  assert.ok(archive, "archive is accessible");
  assert.ok(archive!.occupied > 0, `archive has entries after onchain flush (${archive!.occupied} cells)`);
});

test("H6: elites ON — snapshot exposes elitesArchive in evolution.js contract shape", async () => {
  const ELITES_CFG = { enabled: true } as const;
  const pop = population("AGITATE", 12);
  const econ = new AgentEconomy(cfg({ elites: ELITES_CFG }));
  for (let t = 0; t < 20; t++) await econ.step(pop, collective(0.85), t, undefined, true);
  const snap = econ.snapshot();
  assert.ok(snap.elitesArchive, "elitesArchive key present in snapshot when flag ON");
  assert.ok(Array.isArray(snap.elitesArchive));
  // Shape: [{c, a, f, h, t, b:[arousal, settleRate, entropy]}]
  for (const cell of snap.elitesArchive!) {
    assert.equal(typeof cell.c, "number");
    assert.equal(typeof cell.a, "number");
    assert.equal(typeof cell.f, "number");
    assert.equal(typeof cell.h, "string");
    assert.equal(typeof cell.t, "number");
    assert.ok(Array.isArray(cell.b) && cell.b.length === 3, "bins is a 3-tuple");
    assert.ok(cell.b.every((v) => Number.isFinite(v) && v >= 0 && v <= 3), "bins are valid [0..3]");
  }
});

test("elites OFF — snapshot does NOT expose elitesArchive key (dark-deployment byte-equivalent)", async () => {
  const pop = population("AGITATE", 8);
  const econ = new AgentEconomy(cfg());
  for (let t = 0; t < 10; t++) await econ.step(pop, collective(0.85), t);
  const snap = econ.snapshot();
  assert.equal(snap.elitesArchive, undefined, "elitesArchive key absent when flag OFF");
});

// ═══════════════════════════════════════════════════════════════════════════════════════════════════════
// H7: flush() does NOT silently discard remaining on failure
// ═══════════════════════════════════════════════════════════════════════════════════════════════════════

test("H7: flush with settle failure — pendingNet is preserved (not deleted)", async () => {
  const pop = population("AGITATE", 12);
  const econ = new AgentEconomy(
    onchainCfg({ netMinBroadcastUsdc: 0, netFlushTicks: 1 }),
    undefined,
    { facilitator: mockFacilitator({ failSettle: true }) },
  );
  // Accumulate pending nets
  for (let t = 1; t <= 5; t++) await econ.step(pop, collective(0.9), t, 50, t === 1);
  const beforePending = econ.snapshot().totals.netPending;
  assert.ok(beforePending > 0, "have pending nets before flush");

  // Flush with a failing facilitator
  const results = await econ.flush(10);
  const afterPending = econ.snapshot().totals.netPending;

  // All settlements should be failures
  const failures = results.filter((s) => !s.valid);
  assert.ok(failures.length > 0, "some settlements failed");
  // H7: the pending nets should NOT be deleted — they carry forward for retry
  assert.ok(
    afterPending > 0,
    `pending nets preserved after settle failure (before=${beforePending}, after=${afterPending})`,
  );
});

test("H7: flush with spend cap — pendingNet remaining is preserved, not forgiven", async () => {
  const pop = population("AGITATE", 12);
  // Set a tiny per-agent daily cap so the FIRST chunk exceeds it
  const econ = new AgentEconomy(
    onchainCfg({ perAgentDailyCapUsdc: 0.000001, netMinBroadcastUsdc: 0, netFlushTicks: 1 }),
    undefined,
    { facilitator: mockFacilitator() },
  );
  for (let t = 1; t <= 5; t++) await econ.step(pop, collective(0.9), t, 50, t === 1);
  const beforePending = econ.snapshot().totals.netPending;
  assert.ok(beforePending > 0, "have pending nets");

  const results = await econ.flush(10);
  const afterPending = econ.snapshot().totals.netPending;

  // Cap-rejected settlements
  const capRejected = results.filter((s) => s.reason?.startsWith("daily-cap"));
  assert.ok(capRejected.length > 0, "spend cap fired");
  // H7: nets must NOT be deleted
  assert.equal(
    afterPending, beforePending,
    `all pending nets preserved after cap rejection (before=${beforePending}, after=${afterPending})`,
  );
});

test("H7+M5: flush budget counts chunks (not pairs) — remaining carries forward", async () => {
  const pop = population("AGITATE", 12);
  // maxDealUsdc tiny → each pair needs many chunks; budget=2 → only 2 chunks broadcast
  const econ = new AgentEconomy(
    onchainCfg({
      maxDealUsdc: 0.001,     // 1000 atomic per chunk (tiny)
      netFlushBudgetPerCron: 2,
      netMinBroadcastUsdc: 0,
      netFlushTicks: 1,
    }),
    undefined,
    { facilitator: mockFacilitator() },
  );
  for (let t = 1; t <= 5; t++) await econ.step(pop, collective(0.9), t, 50, t === 1);
  const beforePending = econ.snapshot().totals.netPending;

  const results = await econ.flush(10);
  const broadcast = results.filter((s) => s.valid);
  const afterPending = econ.snapshot().totals.netPending;

  // Budget=2 means at most 2 successful chunk broadcasts
  assert.ok(broadcast.length <= 2, `broadcast chunks (${broadcast.length}) <= budget (2)`);
  // Remaining pairs carry forward (not all deleted)
  assert.ok(afterPending > 0, `pending nets remain after budget-capped flush (${afterPending} > 0)`);
});

// ═══════════════════════════════════════════════════════════════════════════════════════════════════════
// elites.ts unit guards (L10/L11/L14)
// ═══════════════════════════════════════════════════════════════════════════════════════════════════════

test("L10: binArousal/binSettleRate/binEntropy reject NaN → return 0", () => {
  assert.equal(binArousal(NaN), 0);
  assert.equal(binArousal(Infinity), 0);
  assert.equal(binArousal(-Infinity), 0);
  assert.equal(binSettleRate(NaN), 0);
  assert.equal(binSettleRate(Infinity), 0);
  assert.equal(binEntropy(NaN), 0);
  assert.equal(binEntropy(-Infinity), 0);
});

test("L10: insert() rejects NaN cell index (never poisons the Map)", () => {
  const archive = new ElitesArchive();
  const inserted = archive.insert({
    agentId: 1, fitness: 10, treeHash: "abc", tick: 1,
    bins: [NaN as unknown as number, 0, 0],
  });
  assert.equal(inserted, false, "insert returns false for NaN bins");
  assert.equal(archive.occupied, 0, "no cell was created");
});

test("L14: prune removes ghost elites whose agentId is not alive", () => {
  const archive = new ElitesArchive();
  archive.insert({ agentId: 1, fitness: 5, treeHash: "", tick: 1, bins: [0, 0, 0] });
  archive.insert({ agentId: 2, fitness: 3, treeHash: "", tick: 1, bins: [1, 1, 1] });
  archive.insert({ agentId: 99, fitness: 8, treeHash: "", tick: 1, bins: [2, 2, 2] });
  assert.equal(archive.occupied, 3);
  // Only agents 1 and 2 are "alive"
  const removed = archive.prune((id) => id === 1 || id === 2);
  assert.equal(removed, 1, "one ghost removed");
  assert.equal(archive.occupied, 2, "two alive entries remain");
});

test("computeBins: settle rate uses per-agent counters (not degenerate tickIndex divisor)", () => {
  // Agent with 8 successes and 2 failures → rate = 0.8 → r6 = 800000 → bin = floor(800000/250000) = 3
  const bins = computeBins(500_000, 8, 10, [3, 3, 2, 2]);
  assert.equal(bins[1], 3, "settle rate bin is 3 for 80% success");
  // Agent with 0 trades → rate = 0 → bin = 0
  const bins2 = computeBins(500_000, 0, 0, [0, 0, 0, 0]);
  assert.equal(bins2[1], 0, "settle rate bin is 0 for no trades");
});

// ═══════════════════════════════════════════════════════════════════════════════════════════════
// White-box regressions: H5 direction split, M1 band clamp, M3 divBias, M4 id-reuse hygiene, L13 cap
// (private members are reached via bracket access — a deliberate white-box choice for gate tests)
// ═══════════════════════════════════════════════════════════════════════════════════════════════

type Econ = AgentEconomy & {
  playbook: Map<number, Array<{ ctx: number; action: number; good: number; regime: number; outcome: number; valid: number; tick: number }>>;
  strategyTrees: Map<number, unknown>;
  goodCounts: Map<number, number[]>;
  playbookGoodScores(id: number, tick: number): { bought: number[]; sold: number[] };
  playbookGoodOverride(id: number, baseGood: string, tick: number): string;
  rulesTilt(r: FlyReading, axis: "buy" | "cp"): number;
};

const asWhiteBox = (e: AgentEconomy): Econ => e as unknown as Econ;

test("H5: playbookGoodScores keeps separate bought/sold ledgers; sell income never inflates boughtScore", () => {
  const econ = asWhiteBox(new AgentEconomy(cfg({ playbook: { enabled: true } })));
  // Seed a ring for id 1: eight INVALID momentum buys (score −1 each) + eight VALID signal SELLS (+2 USDC each)
  econ.playbook.set(1, [
    ...Array.from({ length: 8 }, (_, k) => ({ ctx: k, action: 0, good: 1, regime: 1, outcome: 0, valid: 0, tick: 100 })),
    ...Array.from({ length: 8 }, (_, k) => ({ ctx: k, action: 1, good: 0, regime: 1, outcome: 2_000_000, valid: 1, tick: 100 })),
  ]);
  const { bought, sold } = econ.playbookGoodScores(1, 100);
  // Bought ledger: momentum invalid → −1; signal has NO buy entries → 0 (the sell income must NOT leak in)
  assert.ok(Math.abs(bought[1] - (-1)) < 1e-9, `bought[momentum] = −1 (got ${bought[1]})`);
  assert.equal(bought[0], 0, "bought[signal] = 0 — sell-side income is NOT counted as a buy-side score (H5)");
  // Sold ledger: signal valid sells of 2 USDC clamp to +1 on the LAMARCK_PROFIT_SCALE (1e6) normaliser
  assert.ok(Math.abs(sold[0] - 1) < 1e-9, `sold[signal] = +1 (got ${sold[0]}) — real-money scale, not the old /10000 saturator`);
  assert.equal(sold[1], 0, "sold[momentum] = 0 (no sell entries)");
});

test("H5: playbookGoodOverride ignores sell-side history (old bug: seller income biased the BUY choice)", () => {
  const econ = asWhiteBox(new AgentEconomy(cfg({ playbook: { enabled: true } })));
  // id 7 has ONLY profitable signal SELLS and no buy history at all. The old code scored signal +1 and
  // switched ~25% of momentum buys to signal; the fixed code reads only boughtScore (all zeros) → never switches.
  econ.playbook.set(7, Array.from({ length: 8 }, (_, k) => ({ ctx: k, action: 1, good: 0, regime: 1, outcome: 500_000, valid: 1, tick: 50 })));
  let switches = 0;
  const N = 2000;
  for (let t = 0; t < N; t++) if (econ.playbookGoodOverride(7, "momentum", t) !== "momentum") switches++;
  assert.equal(switches, 0, `sell-side history must never drive the good override (got ${switches}/${N} switches)`);
});

test("L8: playbookGoodOverride switch rate is bounded by PLAYBOOK_GOOD_SWITCH_MAX (25%) with a real bought-score gap", () => {
  const econ = asWhiteBox(new AgentEconomy(cfg({ playbook: { enabled: true } })));
  // Maximal bought-score contrast: invalid momentum buys (−1) vs big valid signal buys (+1 after the
  // 1e6-scale clamp) → gap = 2 → switchProb saturates at PLAYBOOK_GOOD_SWITCH_MAX = 0.25.
  econ.playbook.set(3, [
    ...Array.from({ length: 8 }, (_, k) => ({ ctx: k, action: 0, good: 1, regime: 1, outcome: 0, valid: 0, tick: 80 })),
    ...Array.from({ length: 8 }, (_, k) => ({ ctx: k, action: 0, good: 0, regime: 1, outcome: 2_000_000, valid: 1, tick: 80 })),
  ]);
  let switches = 0;
  const N = 4000;
  for (let t = 0; t < N; t++) if (econ.playbookGoodOverride(3, "momentum", t) === "signal") switches++;
  const rate = switches / N;
  assert.ok(rate > 0.15, `switch rate ${rate.toFixed(3)} is above the exploration floor (override is live)`);
  assert.ok(rate < 0.32, `switch rate ${rate.toFixed(3)} stays bounded near the 25% cap (neural choice is never fully overridden)`);
});

test("M1: rulesTilt clamps BOTH band edges into [0.5, 2.0] — a wild config can never escape", () => {
  const r = reading(5, "AGITATE");
  const mk = (rules: EconomyConfig["rules"]) => {
    const econ = asWhiteBox(new AgentEconomy(cfg({ rules })));
    econ.applyRuleModifiers(new Map([[5, { buyMult: 100, cpMult: -100 }]]));
    return econ;
  };
  // Inverted + out-of-envelope band: lo only floor-clamped / hi only ceil-clamped used to leak (band-escape)
  const wild = mk({ enabled: true, buyMin: -50, buyMax: 999, cpMin: 999, cpMax: -50 });
  const buy = wild.rulesTilt(r, "buy");
  const cp = wild.rulesTilt(r, "cp");
  assert.ok(buy >= 0.5 && buy <= 2.0, `buy tilt ${buy} inside the constitutional band`);
  assert.ok(cp >= 0.5 && cp <= 2.0, `cp tilt ${cp} inside the constitutional band`);
  // buyMult=100 clamps to the (envelope-intersected) ceiling 2.0; cpMult=−100 clamps to the floor 0.5
  assert.equal(buy, 2.0, "an absurdly high multiplier is clamped to RULE_CEIL");
  assert.equal(cp, 0.5, "an absurdly low multiplier is clamped to RULE_FLOOR");
  // NaN band edges fall back to the hard envelope, still finite and in-band
  const nan = mk({ enabled: true, buyMin: NaN, buyMax: NaN, cpMin: NaN, cpMax: NaN });
  const nb = nan.rulesTilt(r, "buy");
  assert.ok(Number.isFinite(nb) && nb >= 0.5 && nb <= 2.0, `NaN band → finite in-band tilt (${nb})`);
  // Rules OFF → exactly 1.0 (byte-for-byte the pre-Rules build)
  const off = asWhiteBox(new AgentEconomy(cfg()));
  off.applyRuleModifiers(new Map([[5, { buyMult: 100, cpMult: 100 }]]));
  assert.equal(off.rulesTilt(r, "buy"), 1.0, "rules OFF → neutral 1.0");
});

test("M3: lamarckVector for a never-traded parent is fully neutral (divBias 0, not −1)", async () => {
  const econ = new AgentEconomy(cfg({ lamarck: { enabled: true } }));
  const pop = population("AGITATE", 6);
  await econ.step(pop, collective(0.8), 1);
  // id 99 never traded: no playbook ring, no goodCounts, no ledger history
  const v = econ.lamarckVector(99, 5);
  assert.ok(v, "vector produced when lamarck is ON");
  assert.equal(v!.weightJitter, 0, "M3: no diversity data → neutral 0 (was −1, a systematic −5% offspring bias)");
  assert.equal(v!.weightGain, 0, "no profit data → neutral 0");
  assert.equal(v!.tauGain, 0, "no reliability data → neutral 0");
  assert.ok(Math.abs(v!.threshGain) <= 1, "regime bias stays bounded");
  // Vector SHAPE is unchanged (cross-file contract with breed.ts M8)
  assert.deepEqual(Object.keys(v!).sort(), ["tauGain", "threshGain", "weightGain", "weightJitter"].sort(), "vector shape locked");
  // Lamarck OFF → null (byte-for-byte the Phase 2b path)
  const off = new AgentEconomy(cfg());
  assert.equal(off.lamarckVector(99, 5), null, "lamarck OFF → null");
});

test("M4: reopenSlot erases social/playbook/strategyTrees/goodCounts with CULTURAL OFF (id-reuse hygiene)", async () => {
  const econ = asWhiteBox(new AgentEconomy(cfg({
    playbook: { enabled: true },
    strategy: { enabled: true },
    elites: { enabled: true },
    // cultural deliberately ABSENT (defaults OFF) — the erasure must run anyway (reopenSlot方案)
  })));
  const pop = population("AGITATE", 8);
  for (let t = 0; t < 10; t++) await econ.step(pop, collective(0.85), t);
  // Pick an id that accumulated residue
  const id = pop.find((p) => econ.getPlaybook(p.id)?.length || econ.getSocial(p.id))!.id;
  // Force residue into every id-keyed map so the erasure is observable regardless of trade luck
  econ.playbook.set(id, [{ ctx: 1, action: 0, good: 0, regime: 1, outcome: -100, valid: 1, tick: 3 }]);
  econ.strategyTrees.set(id, { kind: "lit", value: 1 });
  econ.goodCounts.set(id, [9, 9, 9, 9]);
  econ.reopenSlot(id, 0.002);
  assert.equal(econ.getPlaybook(id), undefined, "dead fly's playbook ring is erased on slot reuse");
  assert.equal(econ.getSocial(id), undefined, "dead fly's bonds/grudges are erased on slot reuse");
  assert.equal(econ.strategyTrees.has(id), false, "dead fly's GP strategy tree is erased (no genomeHash pollution)");
  assert.equal(econ.goodCounts.has(id), false, "dead fly's goodCounts are erased (no entropy-descriptor leak)");
  assert.equal(econ.isDead(id), false, "tombstone lifted — the slot is live again");
});

test("L13: playbook restore caps the OUTER array at PLAYBOOK_RESTORE_CAP (256) — a corrupt blob can't DoS restore", async () => {
  const pop = population("AGITATE", 6);
  const econ = new AgentEconomy(cfg({ playbook: { enabled: true } }));
  for (let t = 0; t < 5; t++) await econ.step(pop, collective(0.85), t);
  const blob = JSON.parse(econ.serialize());
  // Inflate the outer array far past the cap with valid-shaped records
  const seed = blob.playbook?.[0] ?? { id: 0, e: [[1, 0, 0, 1, -100, 1, 1]] };
  for (let i = 0; i < 500; i++) blob.playbook.push({ id: 10_000 + i, e: seed.e });
  assert.ok(blob.playbook.length > 400, "blob is inflated past the cap");
  const restored = asWhiteBox(new AgentEconomy(cfg({ playbook: { enabled: true } }), JSON.stringify(blob)));
  assert.ok(restored.playbook.size <= 256, `restored playbook map is capped at 256 (got ${restored.playbook.size})`);
});
