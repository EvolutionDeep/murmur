// Storage budget test — 100-fly full blob with ALL additive blocks enabled.
// Measures: playbook + strategy trees + elites archive + goodCounts.
// Confirms < 200KB application guard and reports % of 128MB DO limit.

import test from "node:test";
import assert from "node:assert/strict";

import { AgentEconomy, type EconomyConfig } from "./economy.js";
import type { FlyReading, CollectiveState } from "./population.js";

function cfg100(over: Partial<EconomyConfig> = {}): EconomyConfig {
  return {
    enabled: true,
    network: "arc",
    initialBalanceUsdc: 6,
    basePriceUsdc: 0.002,
    solvencyFloorUsdc: 0.5,
    maxDealsPerTick: 100,
    facilitatorMode: "simulated",
    seedBase: 42,
    realSpendEnabled: false,
    dailyCapUsdc: 0,
    perAgentDailyCapUsdc: 0,
    maxDealUsdc: 0,
    netMinBroadcastUsdc: 0,
    netFlushTicks: 0,
    populationSize: 100,
    hatchSeedUsdc: 0.002,
    playbook: { enabled: true },
    strategy: { enabled: true },
    elites: { enabled: true },
    ...over,
  };
}

function reading(id: number, over: Partial<FlyReading> = {}): FlyReading {
  return {
    id, state: "AGITATE",
    arousal: 0.5 + (id % 50) / 100, turnBias: (id % 2 ? 0.4 : -0.4), cohesion: 0.3 + (id % 30) / 100,
    wingbeat: 0.6 + (id % 40) / 100, rest: 0.05, temperament: (id * 7919) % 1000 / 1000,
    fingerprint: `fp${id}`,
    fap: "FORAGE", valence: 0, heading: 0, role: "signal-seeker", bouts: [], neuromod: { dopamine: 0, octopamine: 0, learningRateGate: 0, daHz: 0, oaHz: 0 },
    ...over,
  };
}

function collective(temperature = 0.8): CollectiveState {
  return {
    temperature, regime: "HOT",
    vitality: temperature, size: 100, arousal: 0.7, cohesion: 0.5, rest: 0.1, wingbeat: 0.6,
    states: { AGITATE: 0, EXPLORE: 0, AGGREGATE: 0, REST: 0 },
    faps: {}, valence: 0,
    meanDopamine: 0, meanOctopamine: 0, meanDaHz: 0, meanOaHz: 0,
  };
}

test("storage budget: 100-fly full blob < 200KB application guard", async () => {
  const econ = new AgentEconomy(cfg100());
  const readings = Array.from({ length: 100 }, (_, i) => reading(i));
  const coll = collective(0.9);

  // Run 10 ticks to accumulate playbook entries, goodCounts, elites archive
  for (let tick = 1; tick <= 10; tick++) {
    await econ.step(readings, coll, tick);
  }

  const blob = econ.serialize();
  const blobBytes = new TextEncoder().encode(blob).length;
  const blobKB = blobBytes / 1024;

  const GUARD_KB = 200;
  const DO_LIMIT_MB = 128;
  const doLimitBytes = DO_LIMIT_MB * 1024 * 1024;
  const pctOfGuard = (blobKB / GUARD_KB) * 100;
  const pctOfDO = (blobBytes / doLimitBytes) * 100;

  console.log(`\n=== STORAGE BUDGET (100 flies, ALL additive blocks ON) ===`);
  console.log(`  Blob size:        ${blobBytes.toLocaleString()} bytes (${blobKB.toFixed(1)} KB)`);
  console.log(`  200KB guard:      ${pctOfGuard.toFixed(1)}%`);
  console.log(`  128MB DO limit:   ${pctOfDO.toFixed(4)}%`);
  console.log(`  Playbook ON:      ${blob.includes("playbook")}`);
  console.log(`  StrategyTrees ON: ${blob.includes("strategyTrees")}`);
  console.log(`  ElitesArchive ON: ${blob.includes("elitesArchive")}`);
  console.log(`  GoodCounts ON:    ${blob.includes("goodCounts")}`);
  console.log(`=========================================================\n`);

  assert.ok(blobKB < GUARD_KB, `blob ${blobKB.toFixed(1)}KB must be < ${GUARD_KB}KB guard`);
  assert.ok(blob.includes("strategyTrees"), "strategy trees present");
  assert.ok(blob.includes("elitesArchive"), "elites archive present");
  assert.ok(blob.includes("goodCounts"), "goodCounts present");
  assert.ok(blob.includes("playbook"), "playbook present");
});
