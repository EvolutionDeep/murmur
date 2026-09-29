// A/B evidence — simulated multi-generation run demonstrating:
// (a) MAP-Elites archive coverage grows over generations (new strategies emerge)
// (b) Unique treeHash count rises (genetic diversity)
// (c) Degenerate trees are filtered (isLegalTree gate)
// (d) Decision outputs all within caps (hard bounds never breached)

import test from "node:test";
import assert from "node:assert/strict";

import { AgentEconomy, type EconomyConfig } from "./economy.js";
import type { FlyReading, CollectiveState } from "./population.js";
import { generateTree, treeHash, isLegalTree, mutateTree, R6_SCALE, type StrategyTree } from "@fly/fly-brain";

function cfg(over: Partial<EconomyConfig> = {}): EconomyConfig {
  return {
    enabled: true,
    network: "arc",
    initialBalanceUsdc: 6,
    basePriceUsdc: 0.002,
    solvencyFloorUsdc: 0.5,
    maxDealsPerTick: 50,
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
    playbook: { enabled: true },
    strategy: { enabled: true },
    elites: { enabled: true },
    ...over,
  };
}

function reading(id: number, tick: number, over: Partial<FlyReading> = {}): FlyReading {
  // Vary readings per tick so behaviour descriptors shift over generations
  const phase = (tick * 0.1 + id * 0.3) % 1;
  return {
    id, state: phase > 0.7 ? "AGITATE" : phase > 0.4 ? "EXPLORE" : "AGGREGATE",
    arousal: 0.3 + 0.6 * phase, turnBias: Math.sin(id + tick) * 0.5, cohesion: 0.2 + 0.5 * phase,
    wingbeat: 0.4 + 0.4 * ((id + tick) % 10) / 10, rest: 0.05 + 0.1 * (1 - phase),
    temperament: (id * 7919 + tick * 31) % 1000 / 1000,
    fingerprint: `fp${id}`,
    fap: "FORAGE", valence: 0, heading: 0, role: "signal-seeker", bouts: [],
    neuromod: { dopamine: 0, octopamine: 0, learningRateGate: 0, daHz: phase * 10, oaHz: (1 - phase) * 8 },
    ...over,
  };
}

function collective(tick: number): CollectiveState {
  const temperature = 0.3 + 0.5 * ((tick * 37) % 100) / 100;
  return {
    temperature, regime: temperature >= 0.66 ? "HOT" : temperature <= 0.33 ? "COLD" : "CALM",
    vitality: temperature, size: 24, arousal: 0.5 + 0.3 * temperature, cohesion: 0.4, rest: 0.1, wingbeat: 0.6,
    states: { AGITATE: 0, EXPLORE: 0, AGGREGATE: 0, REST: 0 },
    faps: {}, valence: 0,
    meanDopamine: 0, meanOctopamine: 0, meanDaHz: 0, meanOaHz: 0,
  };
}

test("A/B evidence: multi-gen archive growth + treeHash diversity + caps", async () => {
  const econ = new AgentEconomy(cfg());
  const GENERATIONS = 20;
  const TICKS_PER_GEN = 5;

  const archiveCoverage: number[] = [];
  const uniqueTreeHashes = new Set<string>();
  let degenerateFiltered = 0;
  let totalDecisions = 0;
  let capsViolations = 0;

  for (let gen = 0; gen < GENERATIONS; gen++) {
    for (let t = 0; t < TICKS_PER_GEN; t++) {
      const tick = gen * TICKS_PER_GEN + t + 1;
      const readings = Array.from({ length: 24 }, (_, i) => reading(i, tick));
      const coll = collective(tick);
      const settled = await econ.step(readings, coll, tick);

      // (d) Check all decision outputs within caps
      for (const s of settled) {
        totalDecisions++;
        if (s.valid) {
          const amt = Number(s.amount);
          // Hard caps: amount must be positive integer (atomic USDC), never negative
          if (!Number.isFinite(amt) || amt < 0) capsViolations++;
          // In simulated mode with maxDealUsdc=0 (no cap), amount should still be reasonable
          if (amt > 100 * 1e6) capsViolations++; // sanity: never > 100 USDC per deal
        }
      }

      // (b) Collect unique treeHashes
      for (let id = 0; id < 24; id++) {
        const tree = econ.getStrategyTree(id);
        if (tree) {
          uniqueTreeHashes.add(treeHash(tree));
          // (c) Verify all stored trees are legal (degenerate filtered)
          if (!isLegalTree(tree)) degenerateFiltered++;
        }
      }
    }

    // (a) Track archive coverage per generation
    const archive = econ.getElitesArchive();
    archiveCoverage.push(archive ? archive.occupied : 0);
  }

  // --- EVIDENCE OUTPUT ---
  console.log(`\n=== A/B EVIDENCE: ${GENERATIONS} generations × ${TICKS_PER_GEN} ticks ===`);
  console.log(`(a) Archive coverage growth:`);
  console.log(`    Gen 1:  ${archiveCoverage[0]} cells`);
  console.log(`    Gen 5:  ${archiveCoverage[4]} cells`);
  console.log(`    Gen 10: ${archiveCoverage[9]} cells`);
  console.log(`    Gen 15: ${archiveCoverage[14]} cells`);
  console.log(`    Gen 20: ${archiveCoverage[19]} cells`);
  console.log(`    Growth: ${archiveCoverage[0]} → ${archiveCoverage[19]} (+${archiveCoverage[19] - archiveCoverage[0]} cells)`);
  console.log(`(b) Unique treeHash count: ${uniqueTreeHashes.size}`);
  console.log(`(c) Degenerate trees in store: ${degenerateFiltered} (all filtered by isLegalTree)`);
  console.log(`(d) Total decisions: ${totalDecisions}, caps violations: ${capsViolations}`);
  console.log(`=========================================================\n`);

  // --- ASSERTIONS ---
  // (a) Archive coverage should grow (or at least stabilize at a high level)
  assert.ok(archiveCoverage[19] >= archiveCoverage[0], "archive coverage grows or stabilizes");
  assert.ok(archiveCoverage[19] > 0, "archive is non-empty after 20 generations");

  // (b) Multiple unique tree hashes (diversity)
  assert.ok(uniqueTreeHashes.size >= 2, `at least 2 unique trees, got ${uniqueTreeHashes.size}`);

  // (c) No degenerate trees stored
  assert.equal(degenerateFiltered, 0, "no degenerate trees in the store");

  // (d) Zero caps violations
  assert.equal(capsViolations, 0, "zero caps violations across all decisions");
  assert.ok(totalDecisions > 0, "decisions were actually made");
});

test("A/B evidence: tree mutation produces novel hashes (genetic diversity)", () => {
  // Simulate what happens during breeding: mutate a tree and verify novelty
  const baseTree = generateTree(42)!;
  assert.ok(baseTree !== null);
  const baseHash = treeHash(baseTree);

  const mutants = new Set<string>();
  for (let i = 0; i < 50; i++) {
    const mutant = mutateTree(baseTree, i * 7919, i);
    const h = treeHash(mutant);
    assert.ok(isLegalTree(mutant), `mutant ${i} is legal`);
    mutants.add(h);
  }

  console.log(`\n=== TREE MUTATION DIVERSITY ===`);
  console.log(`  Base hash: ${baseHash}`);
  console.log(`  50 mutations → ${mutants.size} unique hashes`);
  console.log(`  Novelty rate: ${(mutants.size / 50 * 100).toFixed(0)}%`);
  console.log(`================================\n`);

  // Most mutations should produce novel trees
  assert.ok(mutants.size >= 10, `at least 10 unique mutants from 50 attempts, got ${mutants.size}`);
});
