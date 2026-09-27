#!/usr/bin/env -S npx tsx
/**
 * Offline verification of the FLYWIRE_TOPOLOGY=true path.
 *
 * Runs entirely in Node (tsx) — no server, no network, no real money.
 * Outputs:
 *   1. Fan-in distribution (real vs PRNG)
 *   2. Neural drive output distribution (arousal/turn/cohesion/rest)
 *   3. A3 neuromodulatory state dynamics (DA/OA not stuck at 0)
 *   4. Motor channel firing rates
 *   5. Memory usage (single brain / serialized size)
 *   6. Trading personality band statistics
 *
 * Usage:
 *   npx tsx scripts/verify-flywire.ts
 */

import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { gunzipSync } from "node:zlib";

import {
  FlyBrain,
  buildFromFlyWire,
  decodePayload,
  subgraphStats,
  readRawDrives,
  computeBands,
  REF_BANDS,
  FLYWIRE_DEFAULTS,
  type FlyWireSubgraph,
  type MarketPulse,
  type NeuromodState,
  type RawDrives,
} from "@fly/fly-brain";

const here = dirname(fileURLToPath(import.meta.url));
const ARTIFACT_PATH = join(here, "..", "packages", "fly-brain", "src", "connectome-data", "fafb783-mb-cx.bin.gz.b64");

// Production sizing (from wrangler.toml)
const POPULATION_SIZE = 24;
const SEED_BASE = 42;
const SEED_STRIDE = 7919;
const SIM_STEPS = 200;  // reduced for offline verification (production uses 500)
const TICKS = 3;        // reduced for offline verification (production uses 6)

function seed(i: number): number {
  return (SEED_BASE + i * SEED_STRIDE) >>> 0;
}

function loadSubgraph(): FlyWireSubgraph {
  const b64 = readFileSync(ARTIFACT_PATH, "utf-8").trim();
  const compressed = Buffer.from(b64, "base64");
  const raw = new Uint8Array(gunzipSync(compressed));
  return decodePayload(raw);
}

const CALM_PULSE: MarketPulse = {
  temperature: 0.5,
  volatility: 0.3,
  volume: 0.5,
  momentum: 0.0,
};

interface FlyStats {
  id: number;
  seed: number;
  neuronCount: number;
  synapseCount: number;
  fanInMean: number;
  fanInMax: number;
  modulatoryCount: number;
  drives: RawDrives;
  neuromod: NeuromodState;
  motorRates: number[];
  modFiringRateMean: number;
  serializeSize: number;
}

function runFlyWireBrain(subgraph: FlyWireSubgraph, flySeed: number, id: number): FlyStats {
  const conn = buildFromFlyWire(subgraph, {
    seed: flySeed,
    weightJitter: FLYWIRE_DEFAULTS.weightJitter,
    maxWeight: FLYWIRE_DEFAULTS.weightGain,
  });
  const brain = new FlyBrain({ seed: flySeed, connectome: conn });

  for (let t = 0; t < TICKS; t++) {
    brain.inject({ channel: "thermal_warmth", intensity: CALM_PULSE.temperature * 0.8 });
    brain.inject({ channel: "olfactory_density", intensity: CALM_PULSE.volume * 0.6 });
    brain.inject({ channel: "internal_arousal", intensity: 0.3 + CALM_PULSE.volatility * 0.4 });
    brain.advance(SIM_STEPS);
  }

  const motor = brain.readAllMotor();
  const neuromod = brain.readNeuromod();
  const modIds = conn.byKind.modulatory;
  let modRateSum = 0;
  for (const mid of modIds) modRateSum += brain.network.firingRate[mid];
  const modFiringRateMean = modIds.length > 0 ? modRateSum / modIds.length : 0;

  const drives = readRawDrives(motor);
  const serialized = brain.serialize();

  const fanIn = new Uint32Array(conn.neurons.length);
  for (const s of conn.synapses) fanIn[s.post]++;
  let fanSum = 0, fanMax = 0;
  for (let i = 0; i < fanIn.length; i++) {
    fanSum += fanIn[i];
    if (fanIn[i] > fanMax) fanMax = fanIn[i];
  }

  return {
    id, seed: flySeed,
    neuronCount: conn.neurons.length,
    synapseCount: conn.synapses.length,
    fanInMean: conn.neurons.length > 0 ? fanSum / conn.neurons.length : 0,
    fanInMax: fanMax,
    modulatoryCount: modIds.length,
    drives, neuromod,
    motorRates: motor.map(m => m.firingRate),
    modFiringRateMean,
    serializeSize: serialized.length,
  };
}

function runPRNGBrain(flySeed: number, id: number): FlyStats {
  const brain = new FlyBrain({ seed: flySeed });
  const conn = brain.connectome;

  for (let t = 0; t < TICKS; t++) {
    brain.inject({ channel: "thermal_warmth", intensity: CALM_PULSE.temperature * 0.8 });
    brain.inject({ channel: "olfactory_density", intensity: CALM_PULSE.volume * 0.6 });
    brain.inject({ channel: "internal_arousal", intensity: 0.3 + CALM_PULSE.volatility * 0.4 });
    brain.advance(SIM_STEPS);
  }

  const motor = brain.readAllMotor();
  const neuromod = brain.readNeuromod();
  const modIds = conn.byKind.modulatory;
  let modRateSum = 0;
  for (const mid of modIds) modRateSum += brain.network.firingRate[mid];
  const modFiringRateMean = modIds.length > 0 ? modRateSum / modIds.length : 0;

  const drives = readRawDrives(motor);
  const serialized = brain.serialize();

  const fanIn = new Uint32Array(conn.neurons.length);
  for (const s of conn.synapses) fanIn[s.post]++;
  let fanSum = 0, fanMax = 0;
  for (let i = 0; i < fanIn.length; i++) {
    fanSum += fanIn[i];
    if (fanIn[i] > fanMax) fanMax = fanIn[i];
  }

  return {
    id, seed: flySeed,
    neuronCount: conn.neurons.length,
    synapseCount: conn.synapses.length,
    fanInMean: conn.neurons.length > 0 ? fanSum / conn.neurons.length : 0,
    fanInMax: fanMax,
    modulatoryCount: modIds.length,
    drives, neuromod,
    motorRates: motor.map(m => m.firingRate),
    modFiringRateMean,
    serializeSize: serialized.length,
  };
}

function percentile(arr: number[], p: number): number {
  const sorted = [...arr].sort((a, b) => a - b);
  const idx = Math.floor(sorted.length * p / 100);
  return sorted[Math.min(idx, sorted.length - 1)];
}

function mean(arr: number[]): number {
  return arr.length > 0 ? arr.reduce((a, b) => a + b, 0) / arr.length : 0;
}

function stddev(arr: number[]): number {
  const m = mean(arr);
  return Math.sqrt(mean(arr.map(x => (x - m) ** 2)));
}

async function main() {
  console.log("=".repeat(80));
  console.log("  FLYWIRE_TOPOLOGY=true  |  offline verification (no server, no network, no money)");
  console.log("=".repeat(80));

  const t0 = performance.now();
  const subgraph = loadSubgraph();
  const tLoad = performance.now();
  const stats = subgraphStats(subgraph);
  console.log(`\n  [1] SUBGRAPH LOADED  (${(tLoad - t0).toFixed(0)} ms)`);
  console.log(`      neurons     : ${stats.nNeurons.toLocaleString()}`);
  console.log(`      synapses    : ${stats.nEdges.toLocaleString()}`);
  console.log(`      fan-in mean : ${stats.fanInMean.toFixed(1)}`);
  console.log(`      fan-in max  : ${stats.fanInMax}`);
  console.log(`      excitatory  : ${stats.excitatoryNeurons} (${(100 * stats.excitatoryNeurons / stats.nNeurons).toFixed(1)}%)`);
  console.log(`      inhibitory  : ${stats.inhibitoryNeurons} (${(100 * stats.inhibitoryNeurons / stats.nNeurons).toFixed(1)}%)`);
  console.log(`      layers      :`, JSON.stringify(stats.layerCounts));

  // FlyWire brains
  console.log(`\n  [2] FLYWIRE BRAINS  (${POPULATION_SIZE} flies x ${TICKS} ticks x ${SIM_STEPS} steps)`);
  const tBuild0 = performance.now();
  const fwStats: FlyStats[] = [];
  for (let i = 0; i < POPULATION_SIZE; i++) {
    fwStats.push(runFlyWireBrain(subgraph, seed(i), i));
  }
  const tBuild = performance.now();
  console.log(`      build+sim time: ${((tBuild - tBuild0) / 1000).toFixed(1)}s total, ${((tBuild - tBuild0) / POPULATION_SIZE).toFixed(0)}ms/fly`);

  const fwFanMeans = fwStats.map(s => s.fanInMean);
  console.log(`      fan-in mean   : ${mean(fwFanMeans).toFixed(1)} +/- ${stddev(fwFanMeans).toFixed(1)}  (max: ${Math.max(...fwStats.map(s => s.fanInMax))})`);
  console.log(`      neurons/fly   : ${fwStats[0].neuronCount.toLocaleString()} (FIXED topology)`);
  console.log(`      synapses/fly  : ${fwStats[0].synapseCount.toLocaleString()} (FIXED topology)`);
  console.log(`      modulatory/fly: ${fwStats[0].modulatoryCount}`);

  // PRNG brains (baseline)
  console.log(`\n  [3] PRNG BRAINS (baseline, same ${POPULATION_SIZE} seeds)`);
  const tPrng0 = performance.now();
  const prngStats: FlyStats[] = [];
  for (let i = 0; i < POPULATION_SIZE; i++) {
    prngStats.push(runPRNGBrain(seed(i), i));
  }
  const tPrng = performance.now();
  console.log(`      build+sim time: ${((tPrng - tPrng0) / 1000).toFixed(1)}s total, ${((tPrng - tPrng0) / POPULATION_SIZE).toFixed(0)}ms/fly`);

  const prngFanMeans = prngStats.map(s => s.fanInMean);
  console.log(`      fan-in mean   : ${mean(prngFanMeans).toFixed(1)} +/- ${stddev(prngFanMeans).toFixed(1)}  (max: ${Math.max(...prngStats.map(s => s.fanInMax))})`);
  console.log(`      neurons/fly   : ${prngStats[0].neuronCount.toLocaleString()}`);
  console.log(`      synapses/fly  : ${prngStats[0].synapseCount.toLocaleString()}`);
  console.log(`      modulatory/fly: ${prngStats[0].modulatoryCount}`);

  // A3 Neuromodulatory dynamics
  console.log(`\n  [4] A3 NEUROMODULATORY STATE (modulatory firing rates)`);
  const fwModRates = fwStats.map(s => s.modFiringRateMean);
  const prngModRates = prngStats.map(s => s.modFiringRateMean);
  const fwDA = fwStats.map(s => s.neuromod.dopamine);
  const fwOA = fwStats.map(s => s.neuromod.octopamine);
  const prngDA = prngStats.map(s => s.neuromod.dopamine);
  const prngOA = prngStats.map(s => s.neuromod.octopamine);

  console.log(`      FlyWire mod mean rate : ${mean(fwModRates).toFixed(3)} Hz  (min ${Math.min(...fwModRates).toFixed(3)}, max ${Math.max(...fwModRates).toFixed(3)})`);
  console.log(`      PRNG    mod mean rate : ${mean(prngModRates).toFixed(3)} Hz  (min ${Math.min(...prngModRates).toFixed(3)}, max ${Math.max(...prngModRates).toFixed(3)})`);
  console.log(`      FlyWire DA: mean ${mean(fwDA).toFixed(4)}, range [${Math.min(...fwDA).toFixed(4)}, ${Math.max(...fwDA).toFixed(4)}]`);
  console.log(`      FlyWire OA: mean ${mean(fwOA).toFixed(4)}, range [${Math.min(...fwOA).toFixed(4)}, ${Math.max(...fwOA).toFixed(4)}]`);
  console.log(`      PRNG    DA: mean ${mean(prngDA).toFixed(4)}, range [${Math.min(...prngDA).toFixed(4)}, ${Math.max(...prngDA).toFixed(4)}]`);
  console.log(`      PRNG    OA: mean ${mean(prngOA).toFixed(4)}, range [${Math.min(...prngOA).toFixed(4)}, ${Math.max(...prngOA).toFixed(4)}]`);
  const fwModNonZero = fwModRates.filter(r => r > 0.001).length;
  const prngModNonZero = prngModRates.filter(r => r > 0.001).length;
  console.log(`      VERDICT FlyWire: ${fwModNonZero}/${POPULATION_SIZE} flies mod rate > 0.001 Hz  ${fwModNonZero > 0 ? "PASS (not stuck at 0)" : "FAIL (still 0 Hz)"}`);
  console.log(`      VERDICT PRNG   : ${prngModNonZero}/${POPULATION_SIZE} flies mod rate > 0.001 Hz  ${prngModNonZero > 0 ? "PASS" : "FAIL (known 0Hz shortboard)"}`);

  // Drive distribution
  console.log(`\n  [5] NEURAL DRIVE DISTRIBUTION (raw, per-fly)`);
  const driveKeys: (keyof RawDrives)[] = ["arousal", "turn", "cohesion", "rest"];
  for (const k of driveKeys) {
    const fw = fwStats.map(s => s.drives[k]);
    const prng = prngStats.map(s => s.drives[k]);
    console.log(`      ${k.padEnd(10)} FlyWire: mean ${mean(fw).toFixed(4)} sd ${stddev(fw).toFixed(4)} p10 ${percentile(fw, 10).toFixed(4)} p90 ${percentile(fw, 90).toFixed(4)}`);
    console.log(`      ${k.padEnd(10)} PRNG   : mean ${mean(prng).toFixed(4)} sd ${stddev(prng).toFixed(4)} p10 ${percentile(prng, 10).toFixed(4)} p90 ${percentile(prng, 90).toFixed(4)}`);
  }

  // Motor channel rates
  console.log(`\n  [6] MOTOR CHANNEL FIRING RATES (Hz)`);
  const channels = ["leg_left", "leg_right", "wing", "proboscis", "abdomen"];
  for (let c = 0; c < channels.length; c++) {
    const fw = fwStats.map(s => s.motorRates[c]);
    const prng = prngStats.map(s => s.motorRates[c]);
    console.log(`      ${channels[c].padEnd(12)} FlyWire: ${mean(fw).toFixed(2)} +/- ${stddev(fw).toFixed(2)} Hz   PRNG: ${mean(prng).toFixed(2)} +/- ${stddev(prng).toFixed(2)} Hz`);
  }

  // Serialization
  console.log(`\n  [7] SERIALIZATION`);
  const fwSizes = fwStats.map(s => s.serializeSize);
  const prngSizes = prngStats.map(s => s.serializeSize);
  console.log(`      FlyWire v4 size: mean ${(mean(fwSizes) / 1024).toFixed(1)} KB, max ${(Math.max(...fwSizes) / 1024).toFixed(1)} KB  (limit 2048 KB)`);
  console.log(`      PRNG    v4 size: mean ${(mean(prngSizes) / 1024).toFixed(1)} KB, max ${(Math.max(...prngSizes) / 1024).toFixed(1)} KB  (limit 2048 KB)`);
  console.log(`      FlyWire < 2 MB single-value: ${Math.max(...fwSizes) < 2 * 1024 * 1024 ? "PASS" : "FAIL"}`);

  // Population bands
  console.log(`\n  [8] POPULATION BANDS (for trading-personality recalibration)`);
  const fwAllMotor = fwStats.map((s, i) => {
    // We already have motor rates, reconstruct MotorOutput-like for computeBands
    return channels.map((ch, ci) => ({
      channel: ch as any,
      firingRate: s.motorRates[ci],
      spikes: 0,
      normalized: Math.min(1, s.motorRates[ci] / 50),
    }));
  });
  const fwBands = computeBands(fwAllMotor);
  console.log(`      FlyWire bands:`);
  for (const [k, v] of Object.entries(fwBands)) {
    if (typeof v === "object" && v !== null && "p10" in v) {
      const band = v as { p10: number; p90: number };
      console.log(`        ${k.padEnd(12)} p10=${band.p10.toFixed(4)}  p90=${band.p90.toFixed(4)}`);
    } else {
      console.log(`        ${k}: ${v}`);
    }
  }
  console.log(`      REF_BANDS (current production):`);
  for (const [k, v] of Object.entries(REF_BANDS)) {
    if (typeof v === "object" && v !== null && "p10" in v) {
      const band = v as { p10: number; p90: number };
      console.log(`        ${k.padEnd(12)} p10=${band.p10.toFixed(4)}  p90=${band.p90.toFixed(4)}`);
    } else {
      console.log(`        ${k}: ${v}`);
    }
  }

  // Memory
  console.log(`\n  [9] MEMORY (heap after ${POPULATION_SIZE} FlyWire brains)`);
  if (global.gc) global.gc();
  const memAfter = process.memoryUsage();
  console.log(`      heapUsed  : ${(memAfter.heapUsed / 1024 / 1024).toFixed(1)} MB`);
  console.log(`      heapTotal : ${(memAfter.heapTotal / 1024 / 1024).toFixed(1)} MB`);
  console.log(`      rss       : ${(memAfter.rss / 1024 / 1024).toFixed(1)} MB`);
  console.log(`      external  : ${(memAfter.external / 1024 / 1024).toFixed(1)} MB`);

  // Summary
  console.log(`\n${"=".repeat(80)}`);
  console.log(`  SUMMARY`);
  console.log(`${"=".repeat(80)}`);
  const checks = [
    { name: "Subgraph loads + decodes (10361 neurons)", pass: stats.nNeurons === 10361 },
    { name: "Fan-in ~45 (vs PRNG ~13)", pass: mean(fwFanMeans) > 30 },
    { name: "Modulatory firing > 0 Hz (A3 fix)", pass: fwModNonZero > 0 },
    { name: "DA/OA neuromod dynamic (not stuck)", pass: Math.max(...fwDA) > 0.001 || Math.max(...fwOA) > 0.001 },
    { name: "Serialization < 2 MB", pass: Math.max(...fwSizes) < 2 * 1024 * 1024 },
    { name: "All 24 flies produce motor output", pass: fwStats.every(s => s.motorRates.some(r => r > 0)) },
    { name: "Drive variance across population", pass: stddev(fwStats.map(s => s.drives.arousal)) > 0.001 },
  ];
  let allPass = true;
  for (const c of checks) {
    const icon = c.pass ? "PASS" : "FAIL";
    console.log(`    [${icon}] ${c.name}`);
    if (!c.pass) allPass = false;
  }
  console.log(`${"=".repeat(80)}`);
  console.log(`  RESULT: ${allPass ? "ALL CHECKS PASS" : "SOME CHECKS FAILED"}`);
  console.log(`${"=".repeat(80)}`);
  process.exit(allPass ? 0 : 1);
}

main().catch((err) => {
  console.error("verify-flywire failed:", err);
  process.exit(1);
});
