// P0.4 — generationReport unit tests: binning + statistic correctness (a pure, deterministic fold).
//
// Every expected number below is hand-computed from the fixture so the test pins the EXACT aggregation
// semantics (per-generation rollup + per-(generation × temperature-band) cells), not just "it ran".

import test from "node:test";
import assert from "node:assert/strict";

import {
  generationReport,
  type GenAgentEntry,
  type GenLeaderRow,
  type GenPredictRow,
} from "./generationStats.js";

const near = (a: number, b: number, eps = 1e-9): boolean => Math.abs(a - b) < eps;

function entry(id: number, generation: number, bornTick: number, deathTick: number | null, temperature: number, settleOk: number, settleTotal: number): GenAgentEntry {
  return { id, generation, bornTick, deathTick, alive: deathTick == null, temperature, settleOk, settleTotal };
}

test("generationReport folds a two-generation roster into exact per-generation + per-band statistics", () => {
  const entries: GenAgentEntry[] = [
    entry(0, 0, 0, null, 0.8, 8, 10),    // gen0 HOT, alive, lifespan 200 (asOf 200)
    entry(1, 0, 0, 100, 0.7, 5, 5),      // gen0 HOT, dead@100, lifespan 100
    entry(2, 1, 50, null, 0.2, 0, 0),    // gen1 COLD, alive, lifespan 150
    entry(3, 1, 50, 150, 0.5, 3, 4),     // gen1 CALM, dead@150, lifespan 100
  ];
  const leaderboard: GenLeaderRow[] = [
    { id: 0, netUsdc: 2.0, deals: 8, sales: 2 },
    { id: 1, netUsdc: -1.0, deals: 5, sales: 0 },
    { id: 2, netUsdc: 0.5, deals: 0, sales: 0 },
    { id: 3, netUsdc: 1.0, deals: 3, sales: 1 },
  ];
  const predictStats: GenPredictRow[] = [
    { id: 0, rounds: 10, hits: 6 },
    { id: 1, rounds: 0, hits: 0 },
    { id: 3, rounds: 4, hits: 3 },
  ];

  const r = generationReport(entries, leaderboard, predictStats, { asOfTick: 200 });

  assert.equal(r.asOfTick, 200);
  assert.equal(r.agents, 4);
  assert.equal(r.generations, 1);          // highest generation present
  assert.equal(r.byGeneration.length, 2);

  // ---- generation 0 rollup (agents 0 + 1) ----
  const g0 = r.byGeneration[0];
  assert.equal(g0.generation, 0);
  assert.equal(g0.agents, 2);
  assert.ok(near(g0.survivalRate, 0.5));                 // 1 alive / 2
  assert.ok(near(g0.avgLifespanTicks, 150));             // (200 + 100) / 2
  assert.ok(near(g0.avgNetUsdcPer1kTick, 0));            // ((2/200)*1000 + (-1/100)*1000)/2 = (10 - 10)/2
  assert.ok(near(g0.settleSuccessRate as number, 13 / 15)); // (8+5)/(10+5)
  assert.ok(near(g0.predictHitRate as number, 0.6));     // (6+0)/(10+0)
  assert.equal(g0.bands.length, 1);
  assert.equal(g0.bands[0].band, "HOT");
  assert.equal(g0.bands[0].agents, 2);

  // ---- generation 1 rollup (agents 2 + 3) ----
  const g1 = r.byGeneration[1];
  assert.equal(g1.generation, 1);
  assert.equal(g1.agents, 2);
  assert.ok(near(g1.survivalRate, 0.5));
  assert.ok(near(g1.avgLifespanTicks, 125));             // (150 + 100) / 2
  assert.ok(near(g1.avgNetUsdcPer1kTick, (0.5 / 150 * 1000 + 1.0 / 100 * 1000) / 2));
  assert.ok(near(g1.settleSuccessRate as number, 0.75)); // (0+3)/(0+4)
  assert.ok(near(g1.predictHitRate as number, 0.75));    // (0+3)/(0+4)
  assert.equal(g1.bands.length, 2);
  assert.equal(g1.bands[0].band, "COLD");
  assert.equal(g1.bands[1].band, "CALM");

  // ---- flat bins: ascending generation, then COLD < CALM < HOT ----
  assert.deepEqual(r.bins.map((b) => `${b.generation}/${b.band}`), ["0/HOT", "1/COLD", "1/CALM"]);

  // The COLD cell (agent 2 alone) had no settlement attempts and no decisive rounds ⇒ null rates.
  const cold = r.bins.find((b) => b.generation === 1 && b.band === "COLD")!;
  assert.equal(cold.agents, 1);
  assert.equal(cold.settleSuccessRate, null);
  assert.equal(cold.predictHitRate, null);
  assert.ok(near(cold.survivalRate, 1));
  assert.ok(near(cold.avgLifespanTicks, 150));

  // The CALM cell (agent 3 alone) is dead ⇒ survival 0, lifespan 100.
  const calm = r.bins.find((b) => b.generation === 1 && b.band === "CALM")!;
  assert.equal(calm.agents, 1);
  assert.ok(near(calm.survivalRate, 0));
  assert.ok(near(calm.avgLifespanTicks, 100));
  assert.ok(near(calm.settleSuccessRate as number, 0.75));
});

test("generationReport on an empty roster is an honest empty report", () => {
  const r = generationReport([], [], []);
  assert.equal(r.asOfTick, 0);
  assert.equal(r.agents, 0);
  assert.equal(r.generations, 0);
  assert.deepEqual(r.byGeneration, []);
  assert.deepEqual(r.bins, []);
});

test("generationReport derives asOfTick from the entries when not overridden", () => {
  const entries: GenAgentEntry[] = [
    entry(0, 0, 10, 90, 0.5, 1, 1),     // dead@90 ⇒ end 90
    entry(1, 0, 40, null, 0.5, 1, 1),   // alive ⇒ end = bornTick 40
  ];
  const r = generationReport(entries, [], []);
  // asOfTick = max(deathTick ?? bornTick) + 1 = max(90, 40) + 1 = 91
  assert.equal(r.asOfTick, 91);
  // The alive agent's lifespan is measured up to asOfTick: 91 - 40 = 51.
  const g0 = r.byGeneration[0];
  assert.ok(near(g0.avgLifespanTicks, (80 + 51) / 2));   // dead: 90-10=80; alive: 91-40=51
});

test("generationReport bins exactly on the temperature thresholds (COLD ≤ 0.33, HOT ≥ 0.66)", () => {
  const entries: GenAgentEntry[] = [
    entry(0, 0, 0, null, 0.33, 0, 0),   // boundary ⇒ COLD
    entry(1, 0, 0, null, 0.34, 0, 0),   // ⇒ CALM
    entry(2, 0, 0, null, 0.65, 0, 0),   // ⇒ CALM
    entry(3, 0, 0, null, 0.66, 0, 0),   // boundary ⇒ HOT
  ];
  const r = generationReport(entries, [], [], { asOfTick: 1 });
  const bands = r.bins.map((b) => b.band).sort();
  assert.deepEqual(bands, ["CALM", "COLD", "HOT"]);
  const cold = r.bins.find((b) => b.band === "COLD")!;
  const hot = r.bins.find((b) => b.band === "HOT")!;
  const calm = r.bins.find((b) => b.band === "CALM")!;
  assert.equal(cold.agents, 1);
  assert.equal(hot.agents, 1);
  assert.equal(calm.agents, 2);
});

test("generationReport honours custom band thresholds", () => {
  const entries: GenAgentEntry[] = [entry(0, 0, 0, null, 0.5, 0, 0)];
  // With hotMin 0.4, a temperature of 0.5 is HOT instead of CALM.
  const r = generationReport(entries, [], [], { asOfTick: 1, coldMax: 0.2, hotMin: 0.4 });
  assert.equal(r.bins.length, 1);
  assert.equal(r.bins[0].band, "HOT");
});

test("generationReport treats a zero-tick life without a division blow-up", () => {
  // born == death ⇒ lifespan 0 ⇒ netPer1k falls back to the raw netUsdc (no /0).
  const entries: GenAgentEntry[] = [entry(0, 0, 50, 50, 0.5, 0, 0)];
  const leaderboard: GenLeaderRow[] = [{ id: 0, netUsdc: 3.0, deals: 0, sales: 0 }];
  const r = generationReport(entries, leaderboard, [], { asOfTick: 100 });
  assert.ok(near(r.byGeneration[0].avgLifespanTicks, 0));
  assert.ok(near(r.byGeneration[0].avgNetUsdcPer1kTick, 3.0));   // raw net, not Infinity/NaN
  assert.ok(Number.isFinite(r.byGeneration[0].avgNetUsdcPer1kTick));
});

test("generationReport is deterministic: identical inputs ⇒ identical JSON", () => {
  const entries: GenAgentEntry[] = [
    entry(0, 0, 0, null, 0.8, 8, 10),
    entry(1, 1, 20, 120, 0.3, 4, 6),
  ];
  const leaderboard: GenLeaderRow[] = [{ id: 0, netUsdc: 1, deals: 5, sales: 1 }, { id: 1, netUsdc: 2, deals: 3, sales: 2 }];
  const predictStats: GenPredictRow[] = [{ id: 0, rounds: 5, hits: 3 }];
  const a = JSON.stringify(generationReport(entries, leaderboard, predictStats, { asOfTick: 200 }));
  const b = JSON.stringify(generationReport(entries, leaderboard, predictStats, { asOfTick: 200 }));
  assert.equal(a, b);
});
