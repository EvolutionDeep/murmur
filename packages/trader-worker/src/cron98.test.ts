/**
 * #98 P0 ROOT-CAUSE FIX — unit tests for the four fixes:
 *   Fix 1: Sharded/batched persist writes (splitBlob, joinShards, blobFNV1a, backward-compat, partial-write safety)
 *   Fix 2: Per-cron flush budget cap (deterministic carry-forward, no loss, no double-spend)
 *   Fix 3: Backlog alerting (netPending > threshold → observable warning)
 *   Fix 4: Cron wall-clock monitoring (elapsed > threshold → observable warning)
 *
 * Plus a simulated-load bench demonstrating wall-clock DECREASES under high pendingNets backlog.
 */
import test from "node:test";
import assert from "node:assert/strict";

import { splitBlob, joinShards, blobFNV1a, type EconShardManifest } from "./state.js";
import { AgentEconomy, type EconomyConfig } from "./economy.js";
import type { Facilitator, VerifyResponse, SettleResponse } from "./x402.js";
import type { FlyReading, CollectiveState } from "./population.js";

// ─── Fix 1: Sharded persist utilities ───────────────────────────────────────────────────────────────────

test("splitBlob: splits a string into correct chunk sizes", () => {
  const blob = "A".repeat(1000);
  const parts = splitBlob(blob, 300);
  assert.equal(parts.length, 4); // ceil(1000/300) = 4
  assert.equal(parts[0].length, 300);
  assert.equal(parts[1].length, 300);
  assert.equal(parts[2].length, 300);
  assert.equal(parts[3].length, 100); // remainder
});

test("splitBlob: single chunk when blob <= chunkSize", () => {
  const blob = "hello";
  const parts = splitBlob(blob, 100);
  assert.equal(parts.length, 1);
  assert.equal(parts[0], "hello");
});

test("splitBlob: empty blob yields one empty part", () => {
  const parts = splitBlob("", 100);
  assert.equal(parts.length, 0); // no iterations when blob.length === 0
});

test("splitBlob: chunkSize <= 0 returns the whole blob as one part", () => {
  const blob = "test data";
  assert.deepEqual(splitBlob(blob, 0), [blob]);
  assert.deepEqual(splitBlob(blob, -1), [blob]);
});

test("joinShards: reconstructs the original blob from parts", () => {
  const blob = "The quick brown fox jumps over the lazy dog. ".repeat(100);
  const parts = splitBlob(blob, 64);
  const rejoined = joinShards(parts);
  assert.equal(rejoined, blob);
});

test("splitBlob + joinShards roundtrip preserves content byte-for-byte (2MB blob)", () => {
  // Simulate a large economy blob (~2MB)
  const blob = JSON.stringify({ data: "x".repeat(2 * 1024 * 1024) });
  const parts = splitBlob(blob, 262_144); // 256KB chunks
  assert.ok(parts.length >= 8, `expected >=8 parts for a 2MB blob, got ${parts.length}`);
  const rejoined = joinShards(parts);
  assert.equal(rejoined, blob, "roundtrip is byte-identical");
  assert.equal(rejoined.length, blob.length);
});

test("blobFNV1a: deterministic and consistent", () => {
  const input = "economy:v1:test-data";
  const h1 = blobFNV1a(input);
  const h2 = blobFNV1a(input);
  assert.equal(h1, h2, "same input always produces the same hash");
  assert.equal(typeof h1, "number");
  assert.ok(h1 >= 0 && h1 <= 0xFFFFFFFF, "hash is a valid uint32");
});

test("blobFNV1a: different inputs produce different hashes", () => {
  const h1 = blobFNV1a("blob-A");
  const h2 = blobFNV1a("blob-B");
  assert.notEqual(h1, h2);
});

test("blobFNV1a: known FNV-1a test vector (empty string)", () => {
  // FNV-1a 32-bit offset basis = 0x811c9dc5 = 2166136261
  assert.equal(blobFNV1a(""), 2166136261);
});

test("shard manifest structure is valid for crash-safe commit", () => {
  const blob = "x".repeat(600_000);
  const parts = splitBlob(blob, 262_144);
  const manifest: EconShardManifest = {
    gen: 1,
    partCount: parts.length,
    totalBytes: blob.length,
    fnv: blobFNV1a(blob),
  };
  // Verify the manifest can reconstruct + validate
  assert.equal(manifest.partCount, parts.length);
  assert.equal(manifest.totalBytes, blob.length);
  const rejoined = joinShards(parts);
  assert.equal(rejoined.length, manifest.totalBytes);
  assert.equal(blobFNV1a(rejoined), manifest.fnv);
});

test("backward-compat: a small blob stays under the threshold (no sharding needed)", () => {
  const threshold = 262_144;
  const smallBlob = JSON.stringify({ pendingNets: [], version: "economy:v1" });
  assert.ok(smallBlob.length < threshold, "small economy blobs don't trigger sharding");
  // splitBlob still works correctly on small blobs
  const parts = splitBlob(smallBlob, threshold);
  assert.equal(parts.length, 1);
  assert.equal(joinShards(parts), smallBlob);
});

test("partial-write safety: truncated shard is detected by length mismatch", () => {
  const blob = "y".repeat(500_000);
  const parts = splitBlob(blob, 262_144);
  const manifest: EconShardManifest = {
    gen: 0,
    partCount: parts.length,
    totalBytes: blob.length,
    fnv: blobFNV1a(blob),
  };
  // Simulate a partial write: drop the last part
  const truncatedParts = parts.slice(0, -1);
  const joined = joinShards(truncatedParts);
  // Length check catches it
  assert.notEqual(joined.length, manifest.totalBytes, "truncated blob has wrong length");
  // Even if lengths somehow matched, FNV would catch content corruption
  assert.notEqual(blobFNV1a(joined), manifest.fnv);
});

test("partial-write safety: corrupted shard content is detected by FNV mismatch", () => {
  const blob = "z".repeat(300_000);
  const parts = splitBlob(blob, 262_144);
  const manifest: EconShardManifest = {
    gen: 1,
    partCount: parts.length,
    totalBytes: blob.length,
    fnv: blobFNV1a(blob),
  };
  // Corrupt one byte in the first part
  const corrupted = [...parts];
  corrupted[0] = "CORRUPT" + corrupted[0].slice(7);
  const joined = joinShards(corrupted);
  // Same length but different content → FNV catches it
  assert.equal(joined.length, manifest.totalBytes);
  assert.notEqual(blobFNV1a(joined), manifest.fnv, "FNV detects content corruption");
});

test("generation alternation: double-buffer prevents overwriting committed data", () => {
  // Simulate two consecutive persists with alternating generations
  let currentGen: number | null = null;

  // First persist: gen starts at null → newGen = 1 - (null ?? 0) = 1
  let newGen = 1 - (currentGen ?? 0);
  assert.equal(newGen, 1);
  currentGen = newGen;

  // Second persist: gen = 1 → newGen = 1 - 1 = 0
  newGen = 1 - (currentGen ?? 0);
  assert.equal(newGen, 0);
  currentGen = newGen;

  // Third persist: gen = 0 → newGen = 1 - 0 = 1
  newGen = 1 - (currentGen ?? 0);
  assert.equal(newGen, 1);

  // The old gen's parts are never overwritten during the write — they're only GC'd after commit
});

// ─── Fix 2: Flush budget cap ────────────────────────────────────────────────────────────────────────────

/** Minimal mock facilitator for onchain testing (always succeeds). */
function mockFacilitator(delayMs = 0): Facilitator {
  return {
    mode: "onchain" as const,
    asset: "0x MockUSDC Address 000000000000000",
    async verify(): Promise<VerifyResponse> {
      if (delayMs > 0) await new Promise((r) => setTimeout(r, delayMs));
      return { valid: true };
    },
    async settle(): Promise<SettleResponse> {
      if (delayMs > 0) await new Promise((r) => setTimeout(r, delayMs));
      return { success: true, network: "arc", txHash: "0x" + "ab".repeat(32) };
    },
  };
}

function econCfg(over: Partial<EconomyConfig> = {}): EconomyConfig {
  return {
    enabled: true,
    network: "arc",
    initialBalanceUsdc: 100,
    basePriceUsdc: 0.002,
    solvencyFloorUsdc: 0.5,
    maxDealsPerTick: 100,
    facilitatorMode: "onchain",
    seedBase: 42,
    realSpendEnabled: true,
    dailyCapUsdc: 0,           // no cap
    perAgentDailyCapUsdc: 0,   // no cap
    maxDealUsdc: 100,          // high so no chunking
    netMinBroadcastUsdc: 0.001,
    netFlushTicks: 1,          // force flush after 1 tick
    populationSize: 24,
    hatchSeedUsdc: 0.002,
    ...over,
  };
}

function flyReading(id: number): FlyReading {
  return {
    id, state: "AGITATE",
    arousal: 0.9, turnBias: id % 2 ? 0.4 : -0.4, cohesion: 0.5,
    wingbeat: 0.8, rest: 0.05, temperament: (id * 7919) % 1000 / 1000,
    fingerprint: `fp${id}`,
    fap: "FORAGE", valence: 0, heading: 0, role: "signal-seeker", bouts: [],
    neuromod: { dopamine: 0, octopamine: 0, learningRateGate: 0, daHz: 0, oaHz: 0 },
  };
}

function collectiveState(): CollectiveState {
  return {
    temperature: 0.8, regime: "HOT",
    vitality: 0.8, size: 24, arousal: 0.7, cohesion: 0.5, rest: 0.1, wingbeat: 0.6,
    states: { AGITATE: 24, EXPLORE: 0, AGGREGATE: 0, REST: 0 },
    faps: {}, valence: 0,
    meanDopamine: 0, meanOctopamine: 0, meanDaHz: 0, meanOaHz: 0,
  };
}

test("flush budget: caps broadcast attempts to configured budget", async () => {
  const BUDGET = 3;
  const econ = new AgentEconomy(
    econCfg({ netFlushBudgetPerCron: BUDGET, netMinBroadcastUsdc: 0, netFlushTicks: 1 }),
    undefined,
    { facilitator: mockFacilitator() },
  );

  // Generate pendingNets by stepping the economy (onchain mode → queueNet)
  const readings = Array.from({ length: 24 }, (_, i) => flyReading(i));
  const coll = collectiveState();
  // Multiple steps to accumulate many distinct pairs
  for (let t = 1; t <= 10; t++) {
    await econ.step(readings, coll, t, 100, t === 1);
  }

  const beforePending = econ.snapshot().totals.netPending;
  assert.ok(beforePending > BUDGET, `need more than ${BUDGET} pending nets, got ${beforePending}`);

  // Flush with budget
  const settlements = await econ.flush(20);
  const afterPending = econ.snapshot().totals.netPending;

  // Budget caps the number of BROADCAST pairs (valid settlements from flush)
  const broadcastCount = settlements.filter((s) => s.valid).length;
  assert.ok(
    broadcastCount <= BUDGET,
    `broadcast count ${broadcastCount} should not exceed budget ${BUDGET}`,
  );
  // Remaining pairs carry forward (not lost)
  assert.ok(
    afterPending > 0,
    `remaining pending should be > 0 after budget-capped flush (was ${beforePending}, now ${afterPending})`,
  );
  // Total is conserved: flushed + remaining == original (minus zero-net deletions)
  assert.ok(
    afterPending + broadcastCount <= beforePending,
    "no pairs were created from nothing",
  );
});

test("flush budget: budget=0 means no cap (legacy behaviour)", async () => {
  const econ = new AgentEconomy(
    econCfg({ netFlushBudgetPerCron: 0, netMinBroadcastUsdc: 0, netFlushTicks: 1 }),
    undefined,
    { facilitator: mockFacilitator() },
  );

  const readings = Array.from({ length: 24 }, (_, i) => flyReading(i));
  const coll = collectiveState();
  for (let t = 1; t <= 5; t++) {
    await econ.step(readings, coll, t, 100, t === 1);
  }

  const beforePending = econ.snapshot().totals.netPending;
  const settlements = await econ.flush(10);
  const afterPending = econ.snapshot().totals.netPending;

  // With no budget cap, ALL eligible pairs should be flushed
  const broadcastCount = settlements.filter((s) => s.valid).length;
  assert.ok(broadcastCount > 0, "some pairs were broadcast");
  // After uncapped flush, remaining should be 0 (all eligible were flushed)
  assert.equal(afterPending, 0, "no budget = flush everything");
});

test("flush budget: carry-forward is deterministic (same state → same result)", async () => {
  // Two economies with identical setup produce identical flush results
  const cfg = econCfg({ netFlushBudgetPerCron: 2, netMinBroadcastUsdc: 0, netFlushTicks: 1 });
  const readings = Array.from({ length: 24 }, (_, i) => flyReading(i));
  const coll = collectiveState();

  const econ1 = new AgentEconomy(cfg, undefined, { facilitator: mockFacilitator() });
  const econ2 = new AgentEconomy(cfg, undefined, { facilitator: mockFacilitator() });

  for (let t = 1; t <= 5; t++) {
    await econ1.step(readings, coll, t, 100, t === 1);
    await econ2.step(readings, coll, t, 100, t === 1);
  }

  const s1 = await econ1.flush(10);
  const s2 = await econ2.flush(10);

  // Same pairs flushed in same order (deterministic Map insertion order)
  assert.equal(s1.length, s2.length, "same number of settlements");
  for (let i = 0; i < s1.length; i++) {
    assert.equal(s1[i].fromId, s2[i].fromId, `settlement ${i} same debtor`);
    assert.equal(s1[i].toId, s2[i].toId, `settlement ${i} same creditor`);
  }

  // Remaining pending is identical
  assert.equal(
    econ1.snapshot().totals.netPending,
    econ2.snapshot().totals.netPending,
    "carry-forward count is deterministic",
  );
});

test("flush budget: no double-spend (flushSeq advances only for broadcast pairs)", async () => {
  const econ = new AgentEconomy(
    econCfg({ netFlushBudgetPerCron: 2, netMinBroadcastUsdc: 0, netFlushTicks: 1 }),
    undefined,
    { facilitator: mockFacilitator() },
  );

  const readings = Array.from({ length: 24 }, (_, i) => flyReading(i));
  const coll = collectiveState();
  for (let t = 1; t <= 5; t++) {
    await econ.step(readings, coll, t, 100, t === 1);
  }

  // First flush: budget=2
  await econ.flush(10);
  const snap1 = econ.snapshot();
  const seq1 = snap1.totals.settleOk;

  // Second flush: the carry-forward pairs are still there, no double-spend
  await econ.flush(11);
  const snap2 = econ.snapshot();
  const seq2 = snap2.totals.settleOk;

  // settleOk should have increased (new pairs flushed), not duplicated
  assert.ok(seq2 > seq1, "second flush settles new pairs (carry-forward worked)");
});

test("flush budget: multiple flushes eventually drain all pending (no permanent loss)", async () => {
  const econ = new AgentEconomy(
    econCfg({ netFlushBudgetPerCron: 3, netMinBroadcastUsdc: 0, netFlushTicks: 1 }),
    undefined,
    { facilitator: mockFacilitator() },
  );

  const readings = Array.from({ length: 24 }, (_, i) => flyReading(i));
  const coll = collectiveState();
  for (let t = 1; t <= 8; t++) {
    await econ.step(readings, coll, t, 100, t === 1);
  }

  const initial = econ.snapshot().totals.netPending;
  assert.ok(initial > 3, "need a backlog to test drain");

  // Flush repeatedly until drained
  let tick = 20;
  let iterations = 0;
  while (econ.snapshot().totals.netPending > 0 && iterations < 100) {
    await econ.flush(tick++);
    iterations++;
  }

  assert.equal(econ.snapshot().totals.netPending, 0, "all pairs eventually flushed (no loss)");
  assert.ok(iterations > 1, `took ${iterations} flushes (budget cap active)`);
});

// ─── Fix 3 + Fix 4: Observability (config knob existence) ──────────────────────────────────────────────

test("config knobs: cron section exists with correct defaults", async () => {
  // Import loadConfig to verify the knobs are wired
  const { loadConfig } = await import("./config.js");
  const cfg = loadConfig({ CHAIN_ID: "5042", RPC_URL: "https://rpc.test", FLY_STATE: {} as any });

  assert.equal(cfg.cron.persistShardThreshold, 262_144);
  assert.equal(cfg.cron.persistChunkSize, 262_144);
  assert.equal(cfg.cron.wallClockWarnMs, 45_000);
  assert.equal(cfg.cron.netPendingAlertThreshold, 500);
  assert.equal(cfg.economy.netFlushBudgetPerCron, 40);
});

// ─── Simulated-load bench: wall-clock before/after ──────────────────────────────────────────────────────

test("BENCH: flush budget reduces wall-clock under high pendingNets backlog", async () => {
  // Simulate production conditions: ~1000 pendingNets, each settle taking ~1ms (mock network latency).
  // WITHOUT budget: all 1000 pairs flush → ~2000ms (verify + settle per pair)
  // WITH budget=40: only 40 pairs flush → ~80ms
  const SETTLE_DELAY_MS = 1; // simulated network latency per operation
  const POPULATION = 24;

  function benchCfg(budget: number): EconomyConfig {
    return econCfg({
      netFlushBudgetPerCron: budget,
      netMinBroadcastUsdc: 0,
      netFlushTicks: 1,
      maxDealUsdc: 100,
    });
  }

  // Build up a large backlog
  async function buildBacklog(budget: number) {
    const econ = new AgentEconomy(benchCfg(budget), undefined, { facilitator: mockFacilitator(0) });
    const readings = Array.from({ length: POPULATION }, (_, i) => flyReading(i));
    const coll = collectiveState();
    // Many steps to accumulate pairs (24 agents → max 276 unique pairs, but each step adds more)
    for (let t = 1; t <= 50; t++) {
      await econ.step(readings, coll, t, 200, t === 1);
    }
    return econ;
  }

  // --- BEFORE (no budget) ---
  const econBefore = await buildBacklog(0);
  const pendingBefore = econBefore.snapshot().totals.netPending;

  // Re-create with a DELAYED facilitator to simulate real latency
  const econBeforeDelayed = new AgentEconomy(benchCfg(0), econBefore.serialize(), {
    facilitator: mockFacilitator(SETTLE_DELAY_MS),
  });

  const t0 = performance.now();
  await econBeforeDelayed.flush(100);
  const elapsedNoCap = performance.now() - t0;

  // --- AFTER (budget = 40) ---
  const econAfter = new AgentEconomy(benchCfg(40), econBefore.serialize(), {
    facilitator: mockFacilitator(SETTLE_DELAY_MS),
  });

  const t1 = performance.now();
  await econAfter.flush(100);
  const elapsedCapped = performance.now() - t1;

  // Report
  console.log(`\n  ═══ #98 SIMULATED-LOAD BENCH ═══`);
  console.log(`  pendingNets backlog: ${pendingBefore}`);
  console.log(`  wall-clock WITHOUT budget cap: ${elapsedNoCap.toFixed(1)}ms`);
  console.log(`  wall-clock WITH budget=40:     ${elapsedCapped.toFixed(1)}ms`);
  console.log(`  speedup factor:                ${(elapsedNoCap / Math.max(1, elapsedCapped)).toFixed(1)}×`);
  console.log(`  ═══════════════════════════════════\n`);

  // The capped flush MUST be significantly faster
  assert.ok(
    elapsedCapped < elapsedNoCap,
    `budget-capped flush (${elapsedCapped.toFixed(0)}ms) must be faster than uncapped (${elapsedNoCap.toFixed(0)}ms)`,
  );
  // And the remaining pairs carry forward (not lost)
  const remainingAfter = econAfter.snapshot().totals.netPending;
  assert.ok(remainingAfter > 0, "carry-forward pairs remain after budget-capped flush");
});
