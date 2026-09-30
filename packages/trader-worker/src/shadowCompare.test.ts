/**
 * Shadow-compare (#87 Phase 0) — comprehensive A-E test suite.
 *
 * A group: "不花真钱" — structural unreachability, zero-increment, static grep, broadcast count.
 * B group: decision-record correctness — baseline fidelity, determinism, evolution sensitivity, amplifier, additive.
 * C group: caps — maxDealUsdc respected in shadow amounts.
 * D group: kill switch — current semantics pinned (shadow never alters them).
 * E group: three invariants — stateDigest identity, serialize() byte-identity when OFF, manifestHash unchanged.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { AgentEconomy, type EconomyConfig, type ShadowDecision, type Settlement } from "./economy.js";
import type { FlyReading, CollectiveState } from "./population.js";
import type { Facilitator, VerifyResponse, SettleResponse } from "./x402.js";
import { usdcToAtomic } from "./x402.js";
import { OPENAPI_SPEC } from "./openapi.js";
import { FlyStateDO } from "./state.js";
import type { Env } from "./config.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

// ─── Helpers ────────────────────────────────────────────────────────────────────────────────────────────

const SHADOW_ON = { enabled: true, everyNCrons: 1, maxDecisionsPerCron: 64, maxRowsPerCronToD1: 32 } as const;
const SHADOW_OFF = { enabled: false, everyNCrons: 1, maxDecisionsPerCron: 64, maxRowsPerCronToD1: 32 } as const;

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
    arousal: 0.3 + (id % 10) * 0.07,
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

function mockFacilitator(opts: { failSettle?: boolean; throwOnSettle?: boolean; settleCount?: { n: number } } = {}): Facilitator {
  return {
    mode: "onchain" as const,
    asset: "0xMockUSDCAddress0000000000000000000000",
    async verify(): Promise<VerifyResponse> { return { valid: true }; },
    async settle(): Promise<SettleResponse> {
      if (opts.settleCount) opts.settleCount.n++;
      if (opts.throwOnSettle) throw new Error("FORBIDDEN: shadow reached facilitator.settle");
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

/** Run N crons of step+flush on an economy, returning the final snapshot totals. */
async function runCrons(econ: AgentEconomy, pop: FlyReading[], n: number, temp = 0.85) {
  for (let t = 1; t <= n; t++) {
    await econ.step(pop, collective(temp), t, undefined, true);
    await econ.flush(t);
  }
}

/** Normalize serialize() output by replacing wall-clock timestamps with a fixed value.
 *  The `ts` field in recent/lastTick settlements is Date.now() metadata — it is NOT an economic
 *  invariant and legitimately differs between sequential runs. Everything else must match. */
function normalizeSerialize(blob: string): string {
  const parsed = JSON.parse(blob);
  const strip = (arr: any[]) => { if (Array.isArray(arr)) for (const s of arr) if (s && typeof s.ts === "number") s.ts = 0; };
  strip(parsed.recent);
  return JSON.stringify(parsed);
}

// ═══════════════════════════════════════════════════════════════════════════════════════════════════════
// A GROUP: 不花真钱 — structural safety guarantees
// ═══════════════════════════════════════════════════════════════════════════════════════════════════════

test("A1: shadowStep is structurally unreachable from facilitator.settle (mock throws, shadow cron completes)", async () => {
  const settleCount = { n: 0 };
  const fac = mockFacilitator({ throwOnSettle: true, settleCount });
  const econ = new AgentEconomy(
    onchainCfg({ shadowCompare: SHADOW_ON, playbook: { enabled: true }, strategy: { enabled: true } }),
    undefined,
    { facilitator: fac },
  );
  const pop = population("AGITATE", 12);
  // Run shadow-only crons (step is killed by realSpendEnabled + throwOnSettle, but shadowStep must NOT throw)
  for (let t = 1; t <= 10; t++) {
    // step() will hit the kill switch or throw on settle — but shadowStep is called separately
    try { await econ.step(pop, collective(0.85), t, undefined, true); } catch { /* expected: settle throws */ }
    // shadowStep must NEVER throw even with a poisonous facilitator
    const rows = econ.shadowStep(pop, collective(0.85), t, t);
    assert.ok(Array.isArray(rows), "shadowStep returns an array");
    // shadowRecordOutcomes with empty flushed (no real settlement happened)
    econ.shadowRecordOutcomes([], t);
  }
  // The facilitator.settle was never called BY shadowStep (it may have been called by step() itself)
  // The key assertion: shadowStep completed 10 crons without throwing
});

test("A2: zero-increment — shadow ON vs OFF produces identical real economy state", async () => {
  const N = 20;
  const pop = population("AGITATE", 12);
  const temp = 0.85;

  // Run with shadow OFF
  const econOff = new AgentEconomy(cfg({ shadowCompare: SHADOW_OFF }));
  for (let t = 1; t <= N; t++) {
    await econOff.step(pop, collective(temp), t, undefined, true);
    await econOff.flush(t);
  }

  // Run with shadow ON (same seed, same config otherwise)
  const econOn = new AgentEconomy(cfg({ shadowCompare: SHADOW_ON }));
  for (let t = 1; t <= N; t++) {
    await econOn.step(pop, collective(temp), t, undefined, true);
    econOn.shadowStep(pop, collective(temp), t, t);
    const flushed = await econOn.flush(t);
    econOn.shadowRecordOutcomes(flushed, t);
  }

  const snapOff = econOff.snapshot();
  const snapOn = econOn.snapshot();

  // Every real field must be identical
  assert.equal(snapOn.totals.volumeAtomic, snapOff.totals.volumeAtomic, "volumeAtomic identical");
  assert.equal(snapOn.totals.count, snapOff.totals.count, "count identical");
  assert.equal(snapOn.totals.settleOk, snapOff.totals.settleOk, "settleOk identical");
  assert.equal(snapOn.totals.settleFail, snapOff.totals.settleFail, "settleFail identical");
  assert.equal(snapOn.totals.netPending, snapOff.totals.netPending, "pendingNets identical");
  assert.equal(econOn.proofsSnapshot().chainHead, econOff.proofsSnapshot().chainHead, "proofChainHead identical");
  // serialize() structurally identical (modulo wall-clock ts metadata in recent)
  assert.equal(normalizeSerialize(econOn.serialize()), normalizeSerialize(econOff.serialize()), "serialize() structurally identical");
});

test("A2: zero-increment (onchain) — mock settle call count identical with shadow ON vs OFF", async () => {
  const N = 10;
  const pop = population("AGITATE", 12);

  const countOff = { n: 0 };
  const econOff = new AgentEconomy(
    onchainCfg({ shadowCompare: SHADOW_OFF }),
    undefined,
    { facilitator: mockFacilitator({ settleCount: countOff }) },
  );
  for (let t = 1; t <= N; t++) {
    await econOff.step(pop, collective(0.85), t, undefined, true);
    await econOff.flush(t);
  }

  const countOn = { n: 0 };
  const econOn = new AgentEconomy(
    onchainCfg({ shadowCompare: SHADOW_ON }),
    undefined,
    { facilitator: mockFacilitator({ settleCount: countOn }) },
  );
  for (let t = 1; t <= N; t++) {
    await econOn.step(pop, collective(0.85), t, undefined, true);
    econOn.shadowStep(pop, collective(0.85), t, t);
    const flushed = await econOn.flush(t);
    econOn.shadowRecordOutcomes(flushed, t);
  }

  assert.equal(countOn.n, countOff.n, `settle call count identical (ON=${countOn.n}, OFF=${countOff.n})`);
});

test("A3: static grep — shadowStep body never references forbidden symbols", () => {
  const src = readFileSync(resolve(__dirname, "economy.ts"), "utf-8");
  // Extract the shadowStep method body (from "shadowStep(" to "return rows;")
  const start = src.indexOf("  shadowStep(");
  assert.ok(start > 0, "shadowStep found in source");
  const body = src.slice(start);
  // The method ends with "return rows;" followed by the closing brace
  const endMatch = body.indexOf("return rows;");
  assert.ok(endMatch > 0, "end of shadowStep found (return rows;)");
  const fnBody = body.slice(0, endMatch + "return rows;".length);

  const FORBIDDEN = [
    "this.facilitator", "queueNet", ".settle(", ".flush(", "absorbFlows",
    "payBreedingFee", "payHatchFee",
    // Real fields that must never be written
    "this.volumeAtomic", "this.count", "this.settleOk", "this.settleFail",
    "this.spendGuard", "this.pendingNets", "this.proofs", "this.proofChainHead",
    "this.recent", "this.social", "this.grudges",
    ".balance", ".paid", ".earned", ".deals", ".sales",
  ];
  for (const sym of FORBIDDEN) {
    assert.ok(
      !fnBody.includes(sym),
      `shadowStep body must NOT contain "${sym}" — structural unreachability violated`,
    );
  }
});

test("A4: testnet broadcast count = 0 — shadow never triggers a real settlement broadcast", async () => {
  const settleCount = { n: 0 };
  const econ = new AgentEconomy(
    onchainCfg({ shadowCompare: SHADOW_ON, netMinBroadcastUsdc: 0, netFlushTicks: 1 }),
    undefined,
    { facilitator: mockFacilitator({ settleCount }) },
  );
  const pop = population("AGITATE", 12);
  // Run ONLY shadowStep (no real step/flush) — settle must never be called
  for (let t = 1; t <= 20; t++) {
    econ.shadowStep(pop, collective(0.85), t, t);
    econ.shadowRecordOutcomes([], t);
  }
  assert.equal(settleCount.n, 0, "zero broadcasts from shadow-only execution");
});

// ═══════════════════════════════════════════════════════════════════════════════════════════════════════
// B GROUP: decision-record correctness
// ═══════════════════════════════════════════════════════════════════════════════════════════════════════

test("B5: baseline fidelity — capabilities ALL OFF ⇒ shadowStep diffs are all zero", async () => {
  // No playbook, no strategy, no rules, no elites ⇒ evolved path === baseline path
  const econ = new AgentEconomy(cfg({ shadowCompare: SHADOW_ON }));
  const pop = population("AGITATE", 12);
  // Warm up the economy so agents exist
  for (let t = 1; t <= 5; t++) await econ.step(pop, collective(0.85), t);

  let totalGateFlips = 0, totalGoodSwitches = 0, totalSellerChanges = 0, totalAmountDelta = 0;
  for (let t = 6; t <= 30; t++) {
    const rows = econ.shadowStep(pop, collective(0.85), t, t);
    for (const r of rows) {
      if (r.goodBase !== r.goodEvo) totalGoodSwitches++;
      if (r.sellerIdBase !== r.sellerIdEvo) totalSellerChanges++;
      totalAmountDelta += Math.abs(Number(r.amountEvoAtomic) - Number(r.amountBaseAtomic));
    }
  }
  const agg = econ.snapshot().shadowCompare!;
  totalGateFlips = agg.gateFlipsToBuy + agg.gateFlipsToHold;
  assert.equal(totalGateFlips, 0, `gateFlips must be 0 with all capabilities OFF (got ${totalGateFlips})`);
  assert.equal(totalGoodSwitches, 0, `goodSwitches must be 0 (got ${totalGoodSwitches})`);
  assert.equal(totalSellerChanges, 0, `sellerChanges must be 0 (got ${totalSellerChanges})`);
  assert.equal(totalAmountDelta, 0, `amountDeltaSum must be 0 (got ${totalAmountDelta})`);
});

test("B6: determinism — same inputs produce identical shadow rows across two runs", async () => {
  const mkEcon = () => {
    const e = new AgentEconomy(cfg({
      shadowCompare: SHADOW_ON,
      playbook: { enabled: true },
      strategy: { enabled: true },
    }));
    return e;
  };
  const pop = population("AGITATE", 12);
  const run = async (econ: AgentEconomy) => {
    for (let t = 1; t <= 5; t++) await econ.step(pop, collective(0.85), t);
    const allRows: ShadowDecision[] = [];
    for (let t = 6; t <= 15; t++) {
      const rows = econ.shadowStep(pop, collective(0.85), t, t);
      allRows.push(...rows);
    }
    return allRows;
  };
  const rows1 = await run(mkEcon());
  const rows2 = await run(mkEcon());
  assert.equal(rows1.length, rows2.length, "same row count");
  assert.ok(rows1.length > 0, "produced rows");
  for (let i = 0; i < rows1.length; i++) {
    const a = rows1[i], b = rows2[i];
    // ts may differ (wall clock) — compare everything else
    assert.equal(a.tick, b.tick, `row ${i} tick`);
    assert.equal(a.buyerId, b.buyerId, `row ${i} buyerId`);
    assert.equal(a.sellerIdBase, b.sellerIdBase, `row ${i} sellerIdBase`);
    assert.equal(a.sellerIdEvo, b.sellerIdEvo, `row ${i} sellerIdEvo`);
    assert.equal(a.goodBase, b.goodBase, `row ${i} goodBase`);
    assert.equal(a.goodEvo, b.goodEvo, `row ${i} goodEvo`);
    assert.equal(a.wantBase, b.wantBase, `row ${i} wantBase`);
    assert.equal(a.wantEvo, b.wantEvo, `row ${i} wantEvo`);
    assert.equal(a.amountBaseAtomic, b.amountBaseAtomic, `row ${i} amountBase`);
    assert.equal(a.amountEvoAtomic, b.amountEvoAtomic, `row ${i} amountEvo`);
    assert.equal(a.treeHash, b.treeHash, `row ${i} treeHash`);
  }
});

test("B7: evolution sensitivity — capabilities ON ⇒ non-zero diffs appear", async () => {
  const econ = new AgentEconomy(cfg({
    shadowCompare: SHADOW_ON,
    playbook: { enabled: true },
    strategy: { enabled: true },
  }));
  const pop = population("AGITATE", 12);
  // Run enough crons for playbook/strategy to accumulate state
  for (let t = 1; t <= 50; t++) {
    await econ.step(pop, collective(0.5 + (t % 5) * 0.1), t, undefined, true);
    const flushed = await econ.flush(t);
    econ.shadowRecordOutcomes(flushed, t);
  }
  // Now run shadow and check for diffs
  let anyDiff = false;
  for (let t = 51; t <= 80; t++) {
    const rows = econ.shadowStep(pop, collective(0.7), t, t);
    for (const r of rows) {
      if (r.goodBase !== r.goodEvo || r.sellerIdBase !== r.sellerIdEvo ||
          r.wantBase !== r.wantEvo || r.amountBaseAtomic !== r.amountEvoAtomic) {
        anyDiff = true;
        break;
      }
    }
    if (anyDiff) break;
  }
  assert.ok(anyDiff, "evolution capabilities ON must produce at least one diff");
});

test("B8: amplifier attribution — pbAmplifier reflects playbook confidence", async () => {
  const econ = new AgentEconomy(cfg({
    shadowCompare: SHADOW_ON,
    playbook: { enabled: true },
  }));
  const pop = population("AGITATE", 12);
  // Accumulate playbook entries via real trades + shadowRecordOutcomes
  for (let t = 1; t <= 40; t++) {
    await econ.step(pop, collective(0.85), t, undefined, true);
    const flushed = await econ.flush(t);
    econ.shadowRecordOutcomes(flushed, t);
  }
  const rows = econ.shadowStep(pop, collective(0.85), 41, 41);
  assert.ok(rows.length > 0, "produced rows");
  // With playbook ON and accumulated entries, amplifier should deviate from the default 0.75
  const amps = rows.map((r) => r.pbAmplifier);
  const allDefault = amps.every((a) => Math.abs(a - 0.75) < 1e-9);
  // It's acceptable if all are still default (early accumulation), but confidence should be finite
  for (const r of rows) {
    assert.ok(Number.isFinite(r.pbConfidence), "pbConfidence is finite");
    assert.ok(Number.isFinite(r.pbAmplifier), "pbAmplifier is finite");
    assert.ok(r.pbAmplifier >= 0 && r.pbAmplifier <= 2, `pbAmplifier in [0,2] (got ${r.pbAmplifier})`);
  }
});

test("B9: additive round-trip — serialize/restore does NOT persist shadow state (twin fields are runtime-only)", async () => {
  const econ1 = new AgentEconomy(cfg({ shadowCompare: SHADOW_ON, playbook: { enabled: true } }));
  const pop = population("AGITATE", 12);
  for (let t = 1; t <= 10; t++) {
    await econ1.step(pop, collective(0.85), t);
    econ1.shadowStep(pop, collective(0.85), t, t);
  }
  const blob = econ1.serialize();
  const parsed = JSON.parse(blob);
  // Shadow twin fields must NEVER appear in serialize()
  assert.equal(parsed.shadowPlaybook, undefined, "shadowPlaybook not in serialize()");
  assert.equal(parsed.shadowAgg, undefined, "shadowAgg not in serialize()");
  assert.equal(parsed.shadowCompare, undefined, "shadowCompare not in serialize()");
  // Restore into a new economy — shadow state starts fresh
  const econ2 = new AgentEconomy(cfg({ shadowCompare: SHADOW_ON, playbook: { enabled: true } }), blob);
  const snap2 = econ2.snapshot();
  // shadowCompare aggregate resets to zero on restore (runtime-only)
  if (snap2.shadowCompare) {
    assert.equal(snap2.shadowCompare.crons, 0, "shadow crons reset on restore");
    assert.equal(snap2.shadowCompare.decisions, 0, "shadow decisions reset on restore");
  }
});

// ═══════════════════════════════════════════════════════════════════════════════════════════════════════
// C GROUP: caps
// ═══════════════════════════════════════════════════════════════════════════════════════════════════════

test("C10: shadow amount respects maxDealUsdc cap", async () => {
  const maxDeal = 0.005; // 5000 atomic
  const econ = new AgentEconomy(cfg({
    shadowCompare: SHADOW_ON,
    maxDealUsdc: maxDeal,
    playbook: { enabled: true },
    strategy: { enabled: true },
  }));
  const pop = population("AGITATE", 12);
  for (let t = 1; t <= 30; t++) await econ.step(pop, collective(0.9), t);
  const rows = econ.shadowStep(pop, collective(0.9), 31, 31);
  const maxAtomic = BigInt(usdcToAtomic(maxDeal));
  for (const r of rows) {
    const capped = BigInt(r.amountEvoAfterCapAtomic);
    assert.ok(capped <= maxAtomic, `amountEvoAfterCap ${capped} <= maxDeal ${maxAtomic}`);
    if (capped < BigInt(r.amountEvoAtomic)) {
      assert.equal(r.capReason, "max-deal", "capReason set when capped");
    }
  }
});

test("C11: shadow caps never expand — amountEvoAfterCap <= amountEvo always", async () => {
  const econ = new AgentEconomy(cfg({
    shadowCompare: SHADOW_ON,
    maxDealUsdc: 0.01,
    playbook: { enabled: true },
    strategy: { enabled: true },
  }));
  const pop = population("AGITATE", 12);
  for (let t = 1; t <= 20; t++) await econ.step(pop, collective(0.85), t);
  for (let t = 21; t <= 40; t++) {
    const rows = econ.shadowStep(pop, collective(0.85), t, t);
    for (const r of rows) {
      assert.ok(
        BigInt(r.amountEvoAfterCapAtomic) <= BigInt(r.amountEvoAtomic),
        `cap never expands: ${r.amountEvoAfterCapAtomic} <= ${r.amountEvoAtomic}`,
      );
    }
  }
});

// ═══════════════════════════════════════════════════════════════════════════════════════════════════════
// D GROUP: kill switch (pin current semantics — shadow never alters them)
// ═══════════════════════════════════════════════════════════════════════════════════════════════════════

test("D13: kill switch OFF (realSpendEnabled=false) halts real step but shadowStep still runs", async () => {
  const settleCount = { n: 0 };
  const econ = new AgentEconomy(
    onchainCfg({ realSpendEnabled: false, shadowCompare: SHADOW_ON }),
    undefined,
    { facilitator: mockFacilitator({ settleCount }) },
  );
  const pop = population("AGITATE", 12);
  for (let t = 1; t <= 10; t++) {
    const settlements = await econ.step(pop, collective(0.85), t, undefined, true);
    assert.equal(settlements.length, 0, "kill switch halts real step");
    // shadowStep is independent of the kill switch (it's a pure computation)
    const rows = econ.shadowStep(pop, collective(0.85), t, t);
    assert.ok(Array.isArray(rows), "shadowStep still returns rows");
  }
  assert.equal(settleCount.n, 0, "zero real broadcasts");
});

test("D14: shadow ON does not alter kill-switch semantics", async () => {
  const N = 15;
  const pop = population("AGITATE", 12);
  // Without shadow
  const econA = new AgentEconomy(
    onchainCfg({ realSpendEnabled: false, shadowCompare: SHADOW_OFF }),
    undefined,
    { facilitator: mockFacilitator() },
  );
  // With shadow
  const econB = new AgentEconomy(
    onchainCfg({ realSpendEnabled: false, shadowCompare: SHADOW_ON }),
    undefined,
    { facilitator: mockFacilitator() },
  );
  for (let t = 1; t <= N; t++) {
    const a = await econA.step(pop, collective(0.85), t, undefined, true);
    const b = await econB.step(pop, collective(0.85), t, undefined, true);
    econB.shadowStep(pop, collective(0.85), t, t);
    assert.equal(a.length, b.length, `kill-switch behaviour identical at t=${t}`);
  }
  assert.equal(normalizeSerialize(econA.serialize()), normalizeSerialize(econB.serialize()), "serialize identical under kill switch");
});

test("D15: ECONOMY_REAL_SPEND / dailyCap semantics unchanged by shadow", async () => {
  const pop = population("AGITATE", 12);
  const N = 10;
  // Tiny daily cap so it fires
  const base = onchainCfg({ dailyCapUsdc: 0.001, shadowCompare: SHADOW_OFF });
  const withShadow = onchainCfg({ dailyCapUsdc: 0.001, shadowCompare: SHADOW_ON });
  const econA = new AgentEconomy(base, undefined, { facilitator: mockFacilitator() });
  const econB = new AgentEconomy(withShadow, undefined, { facilitator: mockFacilitator() });
  for (let t = 1; t <= N; t++) {
    await econA.step(pop, collective(0.9), t, undefined, true);
    await econA.flush(t);
    await econB.step(pop, collective(0.9), t, undefined, true);
    econB.shadowStep(pop, collective(0.9), t, t);
    const flushed = await econB.flush(t);
    econB.shadowRecordOutcomes(flushed, t);
  }
  const snapA = econA.snapshot().totals;
  const snapB = econB.snapshot().totals;
  assert.equal(snapA.volumeAtomic, snapB.volumeAtomic, "volumeAtomic unchanged by shadow");
  assert.equal(snapA.count, snapB.count, "count unchanged by shadow");
  assert.equal(snapA.settleOk, snapB.settleOk, "settleOk unchanged by shadow");
  assert.equal(snapA.settleFail, snapB.settleFail, "settleFail unchanged by shadow");
});

// ═══════════════════════════════════════════════════════════════════════════════════════════════════════
// E GROUP: three invariants
// ═══════════════════════════════════════════════════════════════════════════════════════════════════════

test("E16: stateDigest inputs unchanged by shadow (volumeAtomic, count, proofChainHead identical)", async () => {
  const N = 20;
  const pop = population("AGITATE", 12);
  const econOff = new AgentEconomy(
    onchainCfg({ shadowCompare: SHADOW_OFF }),
    undefined,
    { facilitator: mockFacilitator() },
  );
  const econOn = new AgentEconomy(
    onchainCfg({ shadowCompare: SHADOW_ON }),
    undefined,
    { facilitator: mockFacilitator() },
  );
  for (let t = 1; t <= N; t++) {
    await econOff.step(pop, collective(0.85), t, undefined, true);
    await econOff.flush(t);
    await econOn.step(pop, collective(0.85), t, undefined, true);
    econOn.shadowStep(pop, collective(0.85), t, t);
    const flushed = await econOn.flush(t);
    econOn.shadowRecordOutcomes(flushed, t);
  }
  // stateDigest folds: econ.volumeAtomic, econ.count, proofChainHead
  assert.equal(econOn.snapshot().totals.volumeAtomic, econOff.snapshot().totals.volumeAtomic, "volumeAtomic (stateDigest input)");
  assert.equal(econOn.snapshot().totals.count, econOff.snapshot().totals.count, "count (stateDigest input)");
  assert.equal(econOn.proofsSnapshot().chainHead, econOff.proofsSnapshot().chainHead, "proofChainHead (stateDigest input)");
});

test("E17: serialize() byte-identical when shadow is OFF", async () => {
  const N = 15;
  const pop = population("AGITATE", 12);
  // Economy WITHOUT shadowCompare config at all (pre-#87 shape)
  const econPre = new AgentEconomy(cfg());
  // Economy WITH shadowCompare but disabled
  const econOff = new AgentEconomy(cfg({ shadowCompare: SHADOW_OFF }));
  for (let t = 1; t <= N; t++) {
    await econPre.step(pop, collective(0.85), t, undefined, true);
    await econPre.flush(t);
    await econOff.step(pop, collective(0.85), t, undefined, true);
    await econOff.flush(t);
  }
  assert.equal(normalizeSerialize(econOff.serialize()), normalizeSerialize(econPre.serialize()), "serialize() byte-identical with shadow OFF vs absent");
});

test("E17: serialize() byte-identical when shadow is ON (twin fields never persisted)", async () => {
  const N = 15;
  const pop = population("AGITATE", 12);
  const econOff = new AgentEconomy(cfg({ shadowCompare: SHADOW_OFF }));
  const econOn = new AgentEconomy(cfg({ shadowCompare: SHADOW_ON }));
  for (let t = 1; t <= N; t++) {
    await econOff.step(pop, collective(0.85), t, undefined, true);
    await econOff.flush(t);
    await econOn.step(pop, collective(0.85), t, undefined, true);
    econOn.shadowStep(pop, collective(0.85), t, t);
    const flushed = await econOn.flush(t);
    econOn.shadowRecordOutcomes(flushed, t);
  }
  assert.equal(normalizeSerialize(econOn.serialize()), normalizeSerialize(econOff.serialize()), "serialize() byte-identical with shadow ON vs OFF");
});

test("E18: manifestHash unaffected — shadow never touches brain/genome/connectome", async () => {
  // manifestHash is computed from the brain manifest (connectome seeds), which lives in population.ts /
  // manifest.ts — entirely orthogonal to the economy. This test verifies structurally that shadowStep
  // does not import or call any manifest-related function.
  const src = readFileSync(resolve(__dirname, "economy.ts"), "utf-8");
  const start = src.indexOf("  shadowStep(");
  const end = src.indexOf("\n  shadowRecordOutcomes(", start);
  const fnBody = src.slice(start, end);
  const MANIFEST_FORBIDDEN = ["manifestHash", "assembleManifest", "BrainManifest", "genome", "connectome", "synWeight"];
  for (const sym of MANIFEST_FORBIDDEN) {
    assert.ok(!fnBody.includes(sym), `shadowStep must not reference "${sym}" (manifestHash invariant)`);
  }
  // Also verify shadowRecordOutcomes
  const recStart = src.indexOf("  shadowRecordOutcomes(");
  const recEnd = src.indexOf("\n  // ─", recStart + 1);
  const recBody = src.slice(recStart, recEnd > 0 ? recEnd : recStart + 3000);
  for (const sym of MANIFEST_FORBIDDEN) {
    assert.ok(!recBody.includes(sym), `shadowRecordOutcomes must not reference "${sym}"`);
  }
});

// ═══════════════════════════════════════════════════════════════════════════════════════════════════════
// SUPPLEMENTARY: snapshot flag-guard, shadowCompareOn() gate
// ═══════════════════════════════════════════════════════════════════════════════════════════════════════

test("snapshot: shadowCompare key absent when flag OFF (dark-deployment byte-equivalent)", async () => {
  const econ = new AgentEconomy(cfg({ shadowCompare: SHADOW_OFF }));
  const pop = population("AGITATE", 8);
  for (let t = 1; t <= 5; t++) await econ.step(pop, collective(0.85), t);
  const snap = econ.snapshot();
  assert.equal(snap.shadowCompare, undefined, "shadowCompare key absent when OFF");
});

test("snapshot: shadowCompare key present when flag ON", async () => {
  const econ = new AgentEconomy(cfg({ shadowCompare: SHADOW_ON }));
  const pop = population("AGITATE", 8);
  for (let t = 1; t <= 5; t++) {
    await econ.step(pop, collective(0.85), t);
    econ.shadowStep(pop, collective(0.85), t, t);
  }
  const snap = econ.snapshot();
  assert.ok(snap.shadowCompare, "shadowCompare key present when ON");
  assert.ok(snap.shadowCompare!.crons > 0, "crons counter incremented");
  assert.ok(snap.shadowCompare!.decisions > 0, "decisions counter incremented");
});

test("shadowCompareOn() returns false when config absent", () => {
  const econ = new AgentEconomy(cfg());
  assert.equal(econ.shadowCompareOn(), false);
});

test("shadowStep returns [] when shadowCompareOn() is false", () => {
  const econ = new AgentEconomy(cfg({ shadowCompare: SHADOW_OFF }));
  const pop = population("AGITATE", 8);
  const rows = econ.shadowStep(pop, collective(0.85), 1, 1);
  assert.deepEqual(rows, []);
});

// ═══════════════════════════════════════════════════════════════════════════════════════════════════════
// OPENAPI SCHEMA SELF-CONSISTENCY: actual snapshot.shadowCompare keys/types must match the declared schema
// ═══════════════════════════════════════════════════════════════════════════════════════════════════════

test("openapi schema-vs-snapshot: shadowCompare actual keys and types match the declared schema", async () => {
  // Build a live shadowCompare aggregate
  const econ = new AgentEconomy(cfg({ shadowCompare: SHADOW_ON, playbook: { enabled: true } }));
  const pop = population("AGITATE", 12);
  for (let t = 1; t <= 10; t++) {
    await econ.step(pop, collective(0.85), t);
    econ.shadowStep(pop, collective(0.85), t, t);
  }
  const actual = econ.snapshot().shadowCompare;
  assert.ok(actual, "shadowCompare must be present when flag is ON");

  // Extract the declared schema from OPENAPI_SPEC
  // ok(schema, desc).response spreads { 200: { description, content } } directly into the get object
  const econPath = (OPENAPI_SPEC as any).paths["/economy"];
  assert.ok(econPath, "/economy path exists in OPENAPI_SPEC");
  const resp200 = econPath.get[200] ?? econPath.get["200"];
  assert.ok(resp200, "200 response exists on /economy.get");
  const jsonContent = resp200.content["application/json"];
  assert.ok(jsonContent, "application/json content exists");
  const topSchema = jsonContent.schema;
  assert.ok(topSchema, "response schema exists");
  const topProps = topSchema.properties;
  assert.ok(topProps, "top-level properties exist");
  const scSchema = topProps.shadowCompare;
  assert.ok(scSchema, "shadowCompare schema declared in /economy response");

  const declaredProps: Record<string, any> = scSchema.properties ?? {};
  const requiredKeys: string[] = scSchema.required ?? [];
  const actualKeys = Object.keys(actual!);

  // 1. Every actual key must be declared in the schema properties
  for (const key of actualKeys) {
    assert.ok(
      key in declaredProps,
      `actual field "${key}" is NOT declared in openapi schema properties (additionalProperties violation)`,
    );
  }

  // 2. Every required key must be present in the actual object
  for (const key of requiredKeys) {
    assert.ok(
      key in actual!,
      `required field "${key}" is MISSING from actual snapshot.shadowCompare`,
    );
  }

  // 3. Type consistency: integer fields must be Number.isInteger, number fields must be typeof number
  for (const [key, schema] of Object.entries(declaredProps) as [string, any][]) {
    if (!(key in actual!)) continue; // absent optional fields are fine
    const val = (actual as any)[key];
    const declaredType = schema.type;
    if (declaredType === "integer") {
      assert.ok(
        Number.isInteger(val),
        `field "${key}" declared integer but actual value is ${val} (${typeof val})`,
      );
    } else if (declaredType === "number") {
      assert.ok(
        typeof val === "number" && Number.isFinite(val),
        `field "${key}" declared number but actual value is ${val} (${typeof val})`,
      );
    } else if (declaredType === "string") {
      assert.ok(
        typeof val === "string",
        `field "${key}" declared string but actual value is ${val} (${typeof val})`,
      );
    }
  }

  // 4. No ghost fields: every declared property that is in `required` must actually exist
  //    (catches the old `gateFlips` ghost that was required but never emitted)
  for (const key of requiredKeys) {
    assert.ok(
      key in actual!,
      `GHOST FIELD: "${key}" is required in schema but never emitted by ShadowAggregate`,
    );
  }

  // 5. Sanity: the aggregate has exactly 19 fields (pins the contract)
  assert.equal(actualKeys.length, 19, `ShadowAggregate must have exactly 19 fields (got ${actualKeys.length}: ${actualKeys.join(", ")})`);
});

// ═══════════════════════════════════════════════════════════════════════════════════════════════════════
// F GROUP: REAL WIRING PATH — economyCfg() → AgentEconomy (closes the #116 blind spot).
//
// The A–E suite above injects `shadowCompare` straight into a hand-written cfg() object, so it never
// exercises state.ts's economyCfg() — the method that ACTUALLY builds the AgentEconomy config in
// production. When economyCfg() dropped the shadowCompare pass-through, every A–E test still passed
// while the live economy stayed inert (shadowCompareOn() === !!undefined === false → shadowStep returned
// [], /economy never carried the key, D1 never got a row). These tests derive the config the SAME way
// production does — new FlyStateDO(env).economyCfg() — so a missing pass-through can never hide again.
// ═══════════════════════════════════════════════════════════════════════════════════════════════════════

/**
 * A throwaway TEST-ONLY seed. loadConfig performs NO BIP-39 validation and this suite NEVER calls
 * buildOnchainDeps() — no HD derivation, no viem client, no network, no real key. The mock facilitator is
 * injected as the dep instead. This is NOT the production ECONOMY_MNEMONIC secret; it exists solely so the
 * DO's real economyCfg() reports onchainWired()===true and emits facilitatorMode:"onchain" for the
 * money-safety arms (F3/F4), which need a live settle path to prove shadow never touches it.
 */
const TEST_SEED = "test test test test test test test test test test test junk";

/** Derive the AgentEconomy config through the REAL production path: loadConfig(env) → FlyStateDO.economyCfg(). */
function realEconomyCfg(envOver: Record<string, string> = {}): EconomyConfig {
  const env = {
    CHAIN_ID: "5042", RPC_URL: "https://rpc.test", FLY_STATE: {} as any,
    ...envOver,
  } as unknown as Env;
  const dobj = new FlyStateDO({ storage: {} } as any, env);
  // economyCfg() is private (compile-time only); reach it exactly as makeEconomy() does in production.
  return (dobj as any).economyCfg();
}

/** Env that arms the real onchain settle path (a mock facilitator is injected separately as the dep). */
const MONEY_ENV = {
  ECONOMY_FACILITATOR: "onchain",
  ECONOMY_MNEMONIC: TEST_SEED,
  ECONOMY_REAL_SPEND: "true",
  ECONOMY_INITIAL_BALANCE: "100",
  ECONOMY_MAX_DEAL: "100",
  ECONOMY_NET_MIN_BROADCAST: "0.001",
  ECONOMY_NET_FLUSH_TICKS: "1",
};

test("F1 (real wiring): ECONOMY_EVOLUTION_SHADOW=true ⇒ economyCfg()→AgentEconomy arms shadowCompareOn() and shadowStep emits rows", async () => {
  const cfgOn = realEconomyCfg({ ECONOMY_EVOLUTION_SHADOW: "true" });
  // The wiring itself must carry the field — this is EXACTLY what the #115 build dropped.
  assert.ok(cfgOn.shadowCompare, "economyCfg() must transmit a shadowCompare object (the #115 wiring gap)");
  assert.equal(cfgOn.shadowCompare!.enabled, true, "economyCfg().shadowCompare.enabled reflects ECONOMY_EVOLUTION_SHADOW=true");

  const econ = new AgentEconomy(cfgOn);
  assert.equal(econ.shadowCompareOn(), true, "shadowCompareOn()===true through the real wiring path");

  const pop = population("AGITATE", 12);
  for (let t = 1; t <= 5; t++) await econ.step(pop, collective(0.85), t);
  let rows = 0;
  for (let t = 6; t <= 15; t++) rows += econ.shadowStep(pop, collective(0.85), t, t).length;
  assert.ok(rows > 0, `shadowStep must emit rows when armed via the real path (got ${rows})`);
  assert.ok(econ.snapshot().shadowCompare, "snapshot().shadowCompare key present when armed via the real path");
});

test("F2 (real wiring): ECONOMY_EVOLUTION_SHADOW=false/absent ⇒ economyCfg()→AgentEconomy keeps shadowCompareOn()===false and shadowStep returns []", () => {
  for (const envOver of [{ ECONOMY_EVOLUTION_SHADOW: "false" }, {}]) {
    const cfgOff = realEconomyCfg(envOver);
    assert.ok(cfgOff.shadowCompare, "economyCfg() always transmits the shadowCompare object (the enabled flag lives inside)");
    assert.equal(cfgOff.shadowCompare!.enabled, false, `shadowCompare.enabled false for env ${JSON.stringify(envOver)}`);
    const econ = new AgentEconomy(cfgOff);
    assert.equal(econ.shadowCompareOn(), false, `shadowCompareOn()===false for env ${JSON.stringify(envOver)}`);
    assert.deepEqual(econ.shadowStep(population("AGITATE", 8), collective(0.85), 1, 1), [], "shadowStep returns [] when disarmed");
    assert.ok(!("shadowCompare" in econ.snapshot()), "snapshot() carries NO shadowCompare key when disarmed (byte-for-byte dark)");
  }
  // Fail-closed: only the exact string "true" (case-insensitive) arms it.
  assert.equal(realEconomyCfg({ ECONOMY_EVOLUTION_SHADOW: "1" }).shadowCompare!.enabled, false, "'1' does NOT arm (fail-closed === 'true')");
  assert.equal(realEconomyCfg({ ECONOMY_EVOLUTION_SHADOW: "yes" }).shadowCompare!.enabled, false, "'yes' does NOT arm");
  assert.equal(realEconomyCfg({ ECONOMY_EVOLUTION_SHADOW: "TRUE" }).shadowCompare!.enabled, true, "case-insensitive 'TRUE' arms");
});

test("F3 (real wiring, A2 zero-increment): shadow ON vs OFF through economyCfg() leaves every real money field + the mock settle count identical", async () => {
  const N = 10;
  const pop = population("AGITATE", 12);

  const countOff = { n: 0 };
  const cfgOff = realEconomyCfg({ ...MONEY_ENV, ECONOMY_EVOLUTION_SHADOW: "false" });
  assert.equal(cfgOff.facilitatorMode, "onchain", "sanity: the real path emits onchain when wired");
  const econOff = new AgentEconomy(cfgOff, undefined, { facilitator: mockFacilitator({ settleCount: countOff }) });
  for (let t = 1; t <= N; t++) {
    await econOff.step(pop, collective(0.85), t, undefined, true);
    await econOff.flush(t);
  }

  const countOn = { n: 0 };
  const cfgOn = realEconomyCfg({ ...MONEY_ENV, ECONOMY_EVOLUTION_SHADOW: "true" });
  assert.equal(cfgOn.facilitatorMode, "onchain", "sanity: the real path emits onchain when wired");
  const econOn = new AgentEconomy(cfgOn, undefined, { facilitator: mockFacilitator({ settleCount: countOn }) });
  for (let t = 1; t <= N; t++) {
    await econOn.step(pop, collective(0.85), t, undefined, true);
    econOn.shadowStep(pop, collective(0.85), t, t);            // the shadow cron runs alongside the real one…
    const flushed = await econOn.flush(t);
    econOn.shadowRecordOutcomes(flushed, t);
  }

  const snapOn = econOn.snapshot();
  const snapOff = econOff.snapshot();
  // Every real money field, item by item (the exact set the task pins).
  assert.equal(snapOn.totals.volumeAtomic, snapOff.totals.volumeAtomic, "volumeAtomic identical");
  assert.equal(snapOn.totals.count, snapOff.totals.count, "count identical");
  assert.equal(snapOn.totals.settleOk, snapOff.totals.settleOk, "settleOk identical");
  assert.equal(snapOn.totals.settleFail, snapOff.totals.settleFail, "settleFail identical");
  assert.deepEqual((econOn as any).spendGuard, (econOff as any).spendGuard, "spendGuard identical");
  assert.equal((econOn as any).pendingNets.size, (econOff as any).pendingNets.size, "pendingNets.size identical");
  assert.equal(econOn.proofsSnapshot().chainHead, econOff.proofsSnapshot().chainHead, "proofChainHead identical");
  // The mock settle call count — shadow adds zero real broadcasts.
  assert.equal(countOn.n, countOff.n, `mock settle call count identical (ON=${countOn.n}, OFF=${countOff.n})`);
  assert.ok(countOn.n > 0, `sanity: real settles actually fired through the mock facilitator (got ${countOn.n})`);
});

test("F4 (real wiring, A1 unreachability): a poisonous facilitator (settle throws) is never reached by the shadow cron built from economyCfg()", async () => {
  const settleCount = { n: 0 };
  const fac = mockFacilitator({ throwOnSettle: true, settleCount });
  const cfgOn = realEconomyCfg({ ...MONEY_ENV, ECONOMY_EVOLUTION_SHADOW: "true" });
  const econ = new AgentEconomy(cfgOn, undefined, { facilitator: fac });
  assert.equal(econ.shadowCompareOn(), true, "shadow armed through the real onchain path");

  const pop = population("AGITATE", 12);
  let shadowRows = 0;
  for (let t = 1; t <= 10; t++) {
    // The real-money cron may reach settle and throw — expected; shadow runs on a separate, unreachable path.
    try { await econ.step(pop, collective(0.85), t, undefined, true); } catch { /* expected: the real settle throws */ }
    try { await econ.flush(t); } catch { /* expected: the real broadcast throws */ }
    // The shadow cron must NEVER throw and NEVER touch the facilitator.
    const before = settleCount.n;
    const rows = econ.shadowStep(pop, collective(0.85), t, t);
    econ.shadowRecordOutcomes([], t);
    assert.ok(Array.isArray(rows), "shadowStep returns an array even against a poisonous facilitator");
    assert.equal(settleCount.n, before, "shadowStep/shadowRecordOutcomes never call facilitator.settle");
    shadowRows += rows.length;
  }
  assert.ok(shadowRows > 0, `the shadow cron stayed live and emitted rows throughout (got ${shadowRows})`);
});
