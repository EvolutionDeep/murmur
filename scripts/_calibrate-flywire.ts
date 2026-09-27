#!/usr/bin/env -S npx tsx
/**
 * Quick weight-gain sweep for the FlyWire topology.
 * Finds the maxWeight that produces healthy (non-saturated, non-silent) dynamics.
 * Tests a single fly (seed 42) at each gain value.
 */
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { gunzipSync } from "node:zlib";
import {
  FlyBrain,
  buildFromFlyWire,
  decodePayload,
  readRawDrives,
  type FlyWireSubgraph,
} from "@fly/fly-brain";

const here = dirname(fileURLToPath(import.meta.url));
const ARTIFACT_PATH = join(here, "..", "packages", "fly-brain", "src", "connectome-data", "fafb783-mb-cx.bin.gz.b64");

function loadSubgraph(): FlyWireSubgraph {
  const b64 = readFileSync(ARTIFACT_PATH, "utf-8").trim();
  const compressed = Buffer.from(b64, "base64");
  const raw = new Uint8Array(gunzipSync(compressed));
  return decodePayload(raw);
}

const subgraph = loadSubgraph();
const SEED = 42;
const SIM_STEPS = 200;
const TICKS = 3;

// Sweep maxWeight around the new calibrated default (0.22)
const gains = [0.10, 0.15, 0.18, 0.20, 0.22, 0.25, 0.28, 0.30, 0.35, 0.40];

console.log("maxWeight | modRate(Hz) | DA     | OA     | arousal | turn    | cohesion | rest    | motorHz(5ch)");
console.log("-".repeat(110));

for (const maxWeight of gains) {
  const conn = buildFromFlyWire(subgraph, { seed: SEED, weightJitter: 0.30, maxWeight });
  const brain = new FlyBrain({ seed: SEED, connectome: conn });

  for (let t = 0; t < TICKS; t++) {
    brain.inject({ channel: "thermal_warmth", intensity: 0.4 });
    brain.inject({ channel: "olfactory_density", intensity: 0.3 });
    brain.inject({ channel: "internal_arousal", intensity: 0.42 });
    brain.advance(SIM_STEPS);
  }

  const motor = brain.readAllMotor();
  const neuromod = brain.readNeuromod();
  const drives = readRawDrives(motor);
  const modIds = conn.byKind.modulatory;
  let modRateSum = 0;
  for (const mid of modIds) modRateSum += brain.network.firingRate[mid];
  const modRate = modIds.length > 0 ? modRateSum / modIds.length : 0;
  const motorStr = motor.map(m => m.firingRate.toFixed(1)).join("/");

  console.log(
    `  ${maxWeight.toFixed(2)}    | ` +
    `  ${modRate.toFixed(1).padStart(7)}   | ` +
    `${neuromod.dopamine.toFixed(4)} | ${neuromod.octopamine.toFixed(4)} | ` +
    `  ${drives.arousal.toFixed(4)} |  ${drives.turn.toFixed(4)} |  ${drives.cohesion.toFixed(4)}  |  ${drives.rest.toFixed(4)} | ${motorStr}`
  );
}

// Multi-seed variance test at the calibrated default
console.log("\n" + "=".repeat(110));
console.log("MULTI-SEED VARIANCE TEST (maxWeight=0.22, weightJitter=0.30, 8 seeds)");
console.log("=".repeat(110));
const testSeeds = [42, 7961, 15880, 23799, 31718, 39637, 47556, 55475];
const arousals: number[] = [];
const modRates: number[] = [];
for (const s of testSeeds) {
  const conn = buildFromFlyWire(subgraph, { seed: s, weightJitter: 0.30, maxWeight: 0.22 });
  const brain = new FlyBrain({ seed: s, connectome: conn });
  for (let t = 0; t < TICKS; t++) {
    brain.inject({ channel: "thermal_warmth", intensity: 0.4 });
    brain.inject({ channel: "olfactory_density", intensity: 0.3 });
    brain.inject({ channel: "internal_arousal", intensity: 0.42 });
    brain.advance(SIM_STEPS);
  }
  const motor = brain.readAllMotor();
  const drives = readRawDrives(motor);
  const modIds = conn.byKind.modulatory;
  let mr = 0;
  for (const mid of modIds) mr += brain.network.firingRate[mid];
  mr /= modIds.length || 1;
  arousals.push(drives.arousal);
  modRates.push(mr);
  console.log(`  seed ${String(s).padStart(6)} | arousal ${drives.arousal.toFixed(4)} | turn ${drives.turn.toFixed(4)} | coh ${drives.cohesion.toFixed(4)} | rest ${drives.rest.toFixed(4)} | mod ${mr.toFixed(2)} Hz`);
}
const aMean = arousals.reduce((a, b) => a + b, 0) / arousals.length;
const aVar = Math.sqrt(arousals.reduce((s, x) => s + (x - aMean) ** 2, 0) / arousals.length);
console.log(`  arousal: mean ${aMean.toFixed(4)}, stddev ${aVar.toFixed(4)}, range [${Math.min(...arousals).toFixed(4)}, ${Math.max(...arousals).toFixed(4)}]`);
const mMean = modRates.reduce((a, b) => a + b, 0) / modRates.length;
console.log(`  modRate: mean ${mMean.toFixed(2)} Hz, range [${Math.min(...modRates).toFixed(2)}, ${Math.max(...modRates).toFixed(2)}]`);
