// Phase 4 (capability ④) tests — multi-objective fitness + tournament selection.
//
// What MUST be pinned (the fee is REAL USDC, so a wrong pick spends money on the wrong offspring):
//   1. BOUNDED NORMALIZATION — every dimension is a rational clamp into [0,1]; unobserved ⇒ neutral 0.5;
//      no transcendental, no NaN, no value ever escapes [0,1]. Same input ⇒ same float, byte-for-byte.
//   2. HARD GATE IMMUTABLE — `netUsdc > 0` still filters the pool BEFORE any score is consulted. A
//      loss-maker with a perfect multi-objective vector is NEVER a parent and NEVER pays.
//   3. TOURNAMENT DETERMINISM — hash01 draws (no Math.random / Date.now): same (tickIndex, callIndex,
//      candidates, k) ⇒ same winner, reproducible run-to-run; ties break on the lower agentId.
//   4. OFF IS INERT — mofit=null (config default) is byte-for-byte the pre-Phase-4 novelty/top-1 path, and
//      the feature adds NO serialized field, so an old blob still restores under KEY_VERSION economy:v1.

import test from "node:test";
import assert from "node:assert/strict";

import {
  MOFIT_WEIGHTS, MOFIT_WEIGHT_TOTAL, MOFIT_PROFIT_CAP_USDC, MOFIT_SURVIVAL_CAP_TICKS, MOFIT_NEUTRAL,
  passesHardGate, mofitVector, mofitScore, computeMofit, type MofitInput,
} from "./mofit.js";
import { ElitesArchive, defaultScoring, type ParentCandidate } from "./elites.js";
import { planEvolution, type EvolutionLimits } from "./evolution.js";
import { loadConfig, type Env } from "./config.js";
import { AgentEconomy, type EconomyConfig } from "./economy.js";
import type { FlyReading, CollectiveState } from "./population.js";
import type { LeaderRow } from "./economy.js";

// ---------- helpers ----------

/** A raw multi-objective observation; tests override only the dimensions they exercise. */
function mi(over: Partial<MofitInput> = {}): MofitInput {
  return {
    netUsdc: 0.5,
    survivalTicks: 43_200,     // half the survival cap
    settleOk: 8,
    settleTotal: 10,
    predictRounds: null,       // unobserved by default (offline pure-economy run)
    predictHits: null,
    rep: null,                 // unobserved by default
    ...over,
  };
}

function env(over: Partial<Env> = {}): Env {
  return {
    FLY_STATE: {} as Env["FLY_STATE"],
    CHAIN_ID: "5042002",
    RPC_URL: "https://rpc.testnet.arc.io",
    ...over,
  } as Env;
}

function row(id: number, netUsdc: number, over: Partial<LeaderRow> = {}): LeaderRow {
  return {
    id, address: `0xagent${id}`, netUsdc,
    earnedUsdc: Math.max(0, netUsdc), paidUsdc: Math.max(0, -netUsdc),
    balanceUsdc: 6, deals: 3, sales: 3, ...over,
  };
}

const hashById = (id: number): string | null => `g${id}`.padEnd(64, "0");

function lim(over: Partial<EvolutionLimits> = {}): EvolutionLimits {
  return {
    perCron: 1, perCronUsed: 0, perAgentDaily: 0, globalDaily: 0, globalUsed: 0,
    perAgentUsed: {}, crossBias: 0, ...over,
  };
}

function econCfg(over: Partial<EconomyConfig> = {}): EconomyConfig {
  return {
    enabled: true, network: "arc", initialBalanceUsdc: 6, basePriceUsdc: 0.002,
    solvencyFloorUsdc: 0.5, maxDealsPerTick: 24, facilitatorMode: "simulated", seedBase: 42,
    realSpendEnabled: false, dailyCapUsdc: 0, perAgentDailyCapUsdc: 0, maxDealUsdc: 0,
    netMinBroadcastUsdc: 0, netFlushTicks: 0, populationSize: 24, hatchSeedUsdc: 0.002, ...over,
  };
}

function reading(id: number, state: FlyReading["state"]): FlyReading {
  return {
    id, state, arousal: 0.9, turnBias: id % 2 ? 0.4 : -0.4, cohesion: 0.5, wingbeat: 0.8, rest: 0.05,
    temperament: ((id * 7919) % 1000) / 1000, fingerprint: `fp${id}`, fap: "FORAGE", valence: 0,
    heading: 0, role: "signal-seeker", bouts: [],
    neuromod: { dopamine: 0, octopamine: 0, learningRateGate: 0, daHz: 0, oaHz: 0 },
  };
}

function collective(temperature = 0.8): CollectiveState {
  return {
    temperature, regime: temperature >= 0.66 ? "HOT" : temperature <= 0.33 ? "COLD" : "CALM",
    vitality: temperature, size: 24, arousal: 0.7, cohesion: 0.5, rest: 0.1, wingbeat: 0.6,
    states: { AGITATE: 0, EXPLORE: 0, AGGREGATE: 0, REST: 0 }, faps: {}, valence: 0,
    meanDopamine: 0, meanOctopamine: 0, meanDaHz: 0, meanOaHz: 0,
  };
}

const population = (state: FlyReading["state"], n = 24) =>
  Array.from({ length: n }, (_, i) => reading(i, state));

// ---------- 1. Normalization is bounded + rational ----------

test("mofitVector: every dimension lands in [0,1], never NaN", () => {
  const extremes: MofitInput[] = [
    mi({ netUsdc: 1e9, survivalTicks: 1e9, settleOk: 1e9, settleTotal: 1, predictRounds: 1, predictHits: 1, rep: 99 }),
    mi({ netUsdc: -5, survivalTicks: -5, settleOk: -5, settleTotal: -5, predictRounds: -1, predictHits: -1, rep: -99 }),
    mi({ netUsdc: NaN, survivalTicks: NaN, settleOk: NaN, settleTotal: NaN, predictRounds: NaN, predictHits: NaN, rep: NaN }),
    mi({ netUsdc: 0.25, survivalTicks: 21_600, settleOk: 3, settleTotal: 4, predictRounds: 4, predictHits: 3, rep: 0.5 }),
  ];
  for (const input of extremes) {
    const v = mofitVector(input);
    for (const k of ["profit", "survival", "settle", "predict", "social"] as const) {
      assert.ok(Number.isFinite(v[k]), `${k} finite`);
      assert.ok(v[k] >= 0 && v[k] <= 1, `${k}=${v[k]} in [0,1]`);
    }
  }
});

test("mofitVector: profit + survival saturate at their caps", () => {
  const v = mofitVector(mi({ netUsdc: MOFIT_PROFIT_CAP_USDC * 3, survivalTicks: MOFIT_SURVIVAL_CAP_TICKS * 3 }));
  assert.equal(v.profit, 1, "profit saturates at cap");
  assert.equal(v.survival, 1, "survival saturates at cap");
  const half = mofitVector(mi({ netUsdc: MOFIT_PROFIT_CAP_USDC / 2, survivalTicks: MOFIT_SURVIVAL_CAP_TICKS / 2 }));
  assert.ok(Math.abs(half.profit - 0.5) < 1e-12, "profit linear below cap");
  assert.ok(Math.abs(half.survival - 0.5) < 1e-12, "survival linear below cap");
});

test("mofitVector: unobserved dimensions score NEUTRAL 0.5", () => {
  const v = mofitVector(mi({ settleTotal: 0, predictRounds: null, rep: null }));
  assert.equal(v.settle, MOFIT_NEUTRAL, "no settlement attempts ⇒ neutral");
  assert.equal(v.predict, MOFIT_NEUTRAL, "no prediction rounds ⇒ neutral");
  assert.equal(v.social, MOFIT_NEUTRAL, "no social record ⇒ neutral");
});

test("mofitVector: reputation maps −1→0, 0→0.5, +1→1", () => {
  assert.equal(mofitVector(mi({ rep: -1 })).social, 0);
  assert.equal(mofitVector(mi({ rep: 0 })).social, 0.5);
  assert.equal(mofitVector(mi({ rep: 1 })).social, 1);
});

test("mofitVector: settle rate is ok/total, clamped", () => {
  assert.equal(mofitVector(mi({ settleOk: 5, settleTotal: 8 })).settle, 5 / 8);
  assert.equal(mofitVector(mi({ settleOk: 99, settleTotal: 8 })).settle, 1, "ok>total clamps to 1");
});

// ---------- 2. Weighted score: renormalized, bounded, deterministic ----------

test("mofitScore: weights renormalize over OBSERVED dimensions only", () => {
  // profit + survival observed only (settle unobserved, predict unobserved, social unobserved).
  const input = mi({ netUsdc: MOFIT_PROFIT_CAP_USDC, survivalTicks: MOFIT_SURVIVAL_CAP_TICKS, settleTotal: 0, predictRounds: null, rep: null });
  const v = mofitVector(input);
  const s = mofitScore(v, input);
  // Both observed dims saturate at 1 ⇒ weighted mean of (1,1) = 1 regardless of renormalization.
  assert.ok(Math.abs(s - 1) < 1e-12, `saturated observed dims ⇒ score 1 (got ${s})`);
});

test("mofitScore: always in [0,1]", () => {
  for (let i = 0; i < 200; i++) {
    const input = mi({
      netUsdc: (i % 10) * 0.2, survivalTicks: i * 900,
      settleOk: i % 5, settleTotal: i % 7, predictRounds: i % 3, predictHits: i % 2,
      rep: ((i % 21) - 10) / 10,
    });
    const s = computeMofit(input);
    assert.ok(Number.isFinite(s) && s >= 0 && s <= 1, `score ${s} in [0,1]`);
  }
});

test("mofitScore: profit dominates (highest weight) — a richer fly outranks a poorer one, all else equal", () => {
  const rich = computeMofit(mi({ netUsdc: 0.9, survivalTicks: 1000, settleTotal: 0, rep: null }));
  const poor = computeMofit(mi({ netUsdc: 0.1, survivalTicks: 1000, settleTotal: 0, rep: null }));
  assert.ok(rich > poor, "higher netUsdc ⇒ higher score (profit weight dominant)");
  assert.ok(MOFIT_WEIGHTS.profit > MOFIT_WEIGHTS.survival, "profit is the heaviest dimension");
  assert.equal(MOFIT_WEIGHT_TOTAL, 100, "weights sum to 100 parts");
});

test("mofitScore: deterministic — same input twice is byte-identical", () => {
  const input = mi({ netUsdc: 0.42, survivalTicks: 12_345, settleOk: 6, settleTotal: 9, predictRounds: 5, predictHits: 3, rep: 0.25 });
  const a = computeMofit(input);
  const b = computeMofit(input);
  assert.equal(a, b, "same input ⇒ identical float");
  // Bit-pattern identity (stronger than ===): the IEEE-754 words match exactly.
  const buf = new ArrayBuffer(8);
  const f64 = new Float64Array(buf); const u32 = new Uint32Array(buf);
  f64[0] = a; const wa = [u32[0], u32[1]];
  f64[0] = b; const wb = [u32[0], u32[1]];
  assert.deepEqual(wa, wb, "identical bit pattern (run-to-run reproducible)");
});

// ---------- 3. Hard gate is IMMUTABLE ----------

test("passesHardGate: strictly netUsdc > 0 (0 and negatives rejected)", () => {
  assert.equal(passesHardGate(0.000001), true);
  assert.equal(passesHardGate(0), false, "zero is NOT profitable");
  assert.equal(passesHardGate(-0.0001), false);
  assert.equal(passesHardGate(NaN), false);
  assert.equal(passesHardGate(Infinity), false, "non-finite is rejected (a real-money gate never trusts Infinity)");
});

test("planEvolution + mofit: a loss-maker with a PERFECT vector is never a parent", () => {
  // id2 loses money but would score the max multi-objective fitness if the gate did not bind first.
  const rows = [row(0, 0.5), row(1, 0.3), row(2, -1)];
  const archive = new ElitesArchive();
  const inputs = new Map<number, MofitInput>([
    [0, mi({ netUsdc: 0.5 })],
    [1, mi({ netUsdc: 0.3 })],
    [2, mi({ netUsdc: -1, survivalTicks: MOFIT_SURVIVAL_CAP_TICKS, settleOk: 100, settleTotal: 100, predictRounds: 100, predictHits: 100, rep: 1 })],
  ]);
  for (let tick = 0; tick < 40; tick++) {
    const plan = planEvolution(rows, hashById, lim(), () => 0.9, 42, {
      archive, tickIndex: tick, exploreRate: 0.3, mofit: { inputs, tournamentK: 3 },
    });
    assert.ok(plan !== null, "a profitable fly exists ⇒ plan produced");
    assert.notEqual(plan!.payerId, 2, "loss-maker never pays");
    assert.ok(!plan!.parents.includes(hashById(2)), "loss-maker never a parent");
  }
});

// ---------- 4. Tournament selection: deterministic + reproducible ----------

function cand(agentId: number, fitness: number): ParentCandidate {
  return { agentId, fitness, bins: [agentId % 4, 0, 0] };
}

test("tournamentSelectParent: empty pool ⇒ null", () => {
  const archive = new ElitesArchive();
  assert.equal(archive.tournamentSelectParent(1, 0, 3, []), null);
});

test("tournamentSelectParent: reproducible under a fixed seed (run-to-run identical)", () => {
  const archive = new ElitesArchive();
  const pool = [cand(0, 0.5), cand(1, 0.9), cand(2, 0.1), cand(3, 0.7), cand(4, 0.3), cand(5, 0.6)];
  const first: number[] = [];
  for (let tick = 0; tick < 50; tick++) first.push(archive.tournamentSelectParent(tick, 0, 3, pool)!);
  // Rebuild an identical pool + a fresh archive and replay — must match element-for-element.
  const archive2 = new ElitesArchive();
  const pool2 = [cand(0, 0.5), cand(1, 0.9), cand(2, 0.1), cand(3, 0.7), cand(4, 0.3), cand(5, 0.6)];
  for (let tick = 0; tick < 50; tick++) {
    assert.equal(archive2.tournamentSelectParent(tick, 0, 3, pool2)!, first[tick], `tick ${tick} reproducible`);
  }
});

test("tournamentSelectParent: k ≥ pool ⇒ full-pool argmax under the scorer", () => {
  const archive = new ElitesArchive();
  const pool = [cand(0, 0.5), cand(1, 0.9), cand(2, 0.1), cand(3, 0.7)];
  for (let tick = 0; tick < 20; tick++) {
    assert.equal(archive.tournamentSelectParent(tick, 0, 99, pool), 1, "full pool ⇒ highest fitness wins");
  }
});

test("tournamentSelectParent: k ≤ 1 ⇒ 1-way tournament (argmax of the single draw)", () => {
  const archive = new ElitesArchive();
  const pool = [cand(7, 0.2), cand(8, 0.4)];
  // k=1 samples exactly one candidate ⇒ that candidate wins regardless of fitness.
  const w = archive.tournamentSelectParent(3, 0, 1, pool)!;
  assert.ok(w === 7 || w === 8, "single sampled candidate returned");
});

test("tournamentSelectParent: exercises novelty pressure — winner varies with tick (not always top-1)", () => {
  const archive = new ElitesArchive();
  const pool = [cand(0, 0.5), cand(1, 0.95), cand(2, 0.4), cand(3, 0.85), cand(4, 0.3)];
  const winners = new Set<number>();
  for (let tick = 0; tick < 200; tick++) winners.add(archive.tournamentSelectParent(tick, 0, 2, pool)!);
  assert.ok(winners.size >= 2, `tournament surfaces >1 distinct winner across ticks (got ${winners.size})`);
  // The argmax (id=1) must still win sometimes — the pressure is stochastic, not a demotion of the best.
  assert.ok(winners.has(1), "the fittest still wins some tournaments");
});

test("tournamentSelectParent: honours an injected ScoringFn (multi-objective plug-point)", () => {
  const archive = new ElitesArchive();
  const pool = [cand(0, 0.9), cand(1, 0.1)];
  // A contrarian scorer: the LOWER fitness wins the contest. Full pool ⇒ id=1 must be returned.
  const inverted = (inc: { fitness: number }, ch: { fitness: number }) => ch.fitness < inc.fitness;
  const w = archive.tournamentSelectParent(5, 0, 99, pool, inverted as typeof defaultScoring);
  assert.equal(w, 1, "injected scorer governs the contest");
});

test("tournamentSelectParent: ties break on the lower agentId (order-independent)", () => {
  const archive = new ElitesArchive();
  const a = [cand(3, 0.5), cand(1, 0.5), cand(2, 0.5)];
  const b = [cand(2, 0.5), cand(3, 0.5), cand(1, 0.5)];
  for (let tick = 0; tick < 20; tick++) {
    const wa = archive.tournamentSelectParent(tick, 0, 99, a)!;
    const wb = archive.tournamentSelectParent(tick, 0, 99, b)!;
    assert.equal(wa, 1, "all-tie full pool ⇒ lowest agentId");
    assert.equal(wb, wa, "result independent of candidate ordering");
  }
});

// ---------- 5. planEvolution + tournament is deterministic ----------

test("planEvolution + mofit: deterministic — same inputs ⇒ identical plan", () => {
  const rows = [row(0, 0.5), row(1, 0.4), row(2, 0.3), row(3, 0.2)];
  const archive = new ElitesArchive();
  const inputs = new Map<number, MofitInput>(rows.map((r) => [r.id, mi({ netUsdc: r.netUsdc, survivalTicks: r.id * 5000 })]));
  const mk = () => planEvolution(rows, hashById, lim({ crossBias: 0.5 }), () => 0.3, 42, {
    archive, tickIndex: 17, exploreRate: 0.3, mofit: { inputs, tournamentK: 3 },
  });
  assert.deepEqual(mk(), mk(), "same (rows, inputs, tick) ⇒ identical plan");
});

// ---------- 6. OFF is INERT (byte-for-byte the pre-Phase-4 path) ----------

test("planEvolution: mofit=null is byte-identical to mofit absent (pre-Phase-4 novelty path)", () => {
  const rows = [row(0, 0.5), row(1, 0.4), row(2, 0.3)];
  const archive = new ElitesArchive();
  archive.insert({ agentId: 0, fitness: 0.5, treeHash: "t0", tick: 1, bins: [0, 0, 0] });
  archive.insert({ agentId: 1, fitness: 0.4, treeHash: "t1", tick: 1, bins: [2, 2, 2] });
  const absent = planEvolution(rows, hashById, lim({ crossBias: 0.5 }), () => 0.3, 42, { archive, tickIndex: 10, exploreRate: 0.3 });
  const explicitNull = planEvolution(rows, hashById, lim({ crossBias: 0.5 }), () => 0.3, 42, { archive, tickIndex: 10, exploreRate: 0.3, mofit: null });
  assert.deepEqual(absent, explicitNull, "mofit=null ≡ mofit absent ⇒ pre-Phase-4 selection");
});

test("config: EVOLUTION_MULTI_OBJECTIVE defaults OFF, tournamentK defaults 3 (clamped 2..16)", () => {
  const off = loadConfig(env());
  assert.equal(off.evolution.multiObjective.enabled, false, "ships dark");
  assert.equal(off.evolution.multiObjective.tournamentK, 3, "default tournament size");

  const on = loadConfig(env({ EVOLUTION_MULTI_OBJECTIVE: "true", EVOLUTION_TOURNAMENT_K: "5" }));
  assert.equal(on.evolution.multiObjective.enabled, true);
  assert.equal(on.evolution.multiObjective.tournamentK, 5);

  assert.equal(loadConfig(env({ EVOLUTION_TOURNAMENT_K: "999" })).evolution.multiObjective.tournamentK, 16, "clamped high");
  assert.equal(loadConfig(env({ EVOLUTION_TOURNAMENT_K: "0" })).evolution.multiObjective.tournamentK, 2, "clamped low");
  assert.equal(loadConfig(env({ EVOLUTION_MULTI_OBJECTIVE: "TRUE" })).evolution.multiObjective.enabled, true, "case-insensitive");
});

// ---------- 7. Additive persistence: no new serialized field, old blob restores ----------

test("mofitInputs is read-only: calling it never changes the serialized blob", async () => {
  const econ = new AgentEconomy(econCfg({ elites: { enabled: true } }));
  const readings = population("AGITATE");
  await econ.step(readings, collective(0.9), 1);
  await econ.step(readings, collective(0.9), 2);
  const before = econ.serialize();
  const inputs = econ.mofitInputs(2);
  const after = econ.serialize();
  assert.equal(before, after, "read-out writes nothing (one-way law holds)");
  assert.ok(inputs.size > 0, "observations gathered for the leaderboard");
  // Every observation is well-formed and hard-gate-consistent with its netUsdc.
  for (const [id, m] of inputs) {
    assert.ok(Number.isFinite(m.netUsdc), `id ${id} netUsdc finite`);
    assert.equal(passesHardGate(m.netUsdc), m.netUsdc > 0, `id ${id} hard gate matches netUsdc > 0`);
    assert.ok(Number.isFinite(m.survivalTicks) && m.survivalTicks >= 0, `id ${id} survivalTicks ≥ 0`);
    assert.ok(m.settleTotal >= m.settleOk, `id ${id} settleTotal ≥ settleOk`);
  }
});

test("old blob (no Phase-4 field) restores under economy:v1 and still yields observations", async () => {
  const econ1 = new AgentEconomy(econCfg({ elites: { enabled: true } }));
  const readings = population("AGITATE");
  await econ1.step(readings, collective(0.9), 1);
  await econ1.step(readings, collective(0.9), 2);
  const blob = econ1.serialize();
  // The multi-objective feature adds NO serialized key — assert none of its vocabulary leaked into the blob.
  assert.ok(!blob.includes("mofit"), "blob carries no multi-objective field (purely additive at read-time)");
  assert.ok(blob.includes("economy:v1"), "KEY_VERSION unchanged");
  const econ2 = new AgentEconomy(econCfg({ elites: { enabled: true } }), blob);
  const inputs = econ2.mofitInputs(2);
  assert.ok(inputs.size > 0, "restored economy produces observations");
});
