#!/usr/bin/env -S npx tsx --expose-gc
/**
 * Memory verification — single FlyWire brain peak heap (independent process + gc).
 * Measures: subgraph decode, single brain build, simulate, serialize.
 * Run with: npx tsx --expose-gc scripts/_mem-flywire.ts
 */
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { gunzipSync } from "node:zlib";
import {
  FlyBrain,
  buildFromFlyWire,
  decodePayload,
  FLYWIRE_DEFAULTS,
  type FlyWireSubgraph,
} from "@fly/fly-brain";

const here = dirname(fileURLToPath(import.meta.url));
const ARTIFACT_PATH = join(here, "..", "packages", "fly-brain", "src", "connectome-data", "fafb783-mb-cx.bin.gz.b64");

function mb(bytes: number): string { return (bytes / 1024 / 1024).toFixed(2) + " MB"; }
function snap(label: string): void {
  if (global.gc) global.gc();
  const m = process.memoryUsage();
  console.log(`  ${label.padEnd(30)} heapUsed ${mb(m.heapUsed).padStart(10)}  heapTotal ${mb(m.heapTotal).padStart(10)}  rss ${mb(m.rss).padStart(10)}  external ${mb(m.external).padStart(10)}`);
}

console.log("=== FlyWire Single-Brain Memory Verification ===");
console.log(`    (independent process, --expose-gc, FLYWIRE_DEFAULTS: weightGain=${FLYWIRE_DEFAULTS.weightGain}, jitter=${FLYWIRE_DEFAULTS.weightJitter})`);
console.log("");

snap("baseline (before load)");

// 1. Load + decode subgraph
const b64 = readFileSync(ARTIFACT_PATH, "utf-8").trim();
snap("after readFileSync(b64)");

const compressed = Buffer.from(b64, "base64");
const raw = new Uint8Array(gunzipSync(compressed));
snap("after gunzip");

const subgraph: FlyWireSubgraph = decodePayload(raw);
snap("after decodePayload (subgraph)");

// 2. Build ONE brain
const conn = buildFromFlyWire(subgraph, {
  seed: 42,
  weightJitter: FLYWIRE_DEFAULTS.weightJitter,
  maxWeight: FLYWIRE_DEFAULTS.weightGain,
});
snap("after buildFromFlyWire (connectome)");

const brain = new FlyBrain({ seed: 42, connectome: conn });
snap("after new FlyBrain (LIF network)");

// 3. Simulate
for (let t = 0; t < 3; t++) {
  brain.inject({ channel: "thermal_warmth", intensity: 0.4 });
  brain.inject({ channel: "olfactory_density", intensity: 0.3 });
  brain.advance(200);
}
snap("after 600 sim steps");

// 4. Serialize
const serialized = brain.serialize();
snap("after serialize()");
console.log(`\n  serialized size: ${mb(serialized.length)} (${serialized.length.toLocaleString()} bytes)`);
console.log(`  < 2 MB single-value limit: ${serialized.length < 2 * 1024 * 1024 ? "PASS" : "FAIL"}`);

// 5. Clone test (build a second brain from the same subgraph)
const conn2 = buildFromFlyWire(subgraph, {
  seed: 7961,
  weightJitter: FLYWIRE_DEFAULTS.weightJitter,
  maxWeight: FLYWIRE_DEFAULTS.weightGain,
});
const brain2 = new FlyBrain({ seed: 7961, connectome: conn2 });
brain2.advance(200);
snap("after 2nd brain (clone peak)");

console.log("\n=== BUDGET CHECK ===");
if (global.gc) global.gc();
const final = process.memoryUsage();
const budgetMB = 72;
const heapMB = final.heapUsed / 1024 / 1024;
console.log(`  heapUsed with 2 brains + subgraph: ${heapMB.toFixed(1)} MB`);
console.log(`  Workers isolate budget: ${budgetMB} MB`);
console.log(`  Single-fly estimate (heapUsed - 1 brain): ~${(heapMB * 0.65).toFixed(1)} MB`);
console.log(`  VERDICT: ${heapMB < budgetMB ? "PASS (< 72 MB)" : "NEEDS INVESTIGATION"}`);
