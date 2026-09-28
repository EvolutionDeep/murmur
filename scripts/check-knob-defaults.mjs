#!/usr/bin/env node
// check-knob-defaults.mjs — CI gate: verify KNOB_DEFAULTS in gen-codecommit.mjs matches config.ts.
//
// The KNOB_DEFAULTS object (21 keys) is a hand-maintained snapshot of the `env.X ?? "default"` fallbacks
// in packages/trader-worker/src/config.ts. If config.ts defaults drift and KNOB_DEFAULTS is not updated,
// CODE_COMMITMENT silently stops rotating with posture changes. This script catches that at CI time.
//
// Strategy:
//   1. Parse KNOB_DEFAULTS from scripts/gen-codecommit.mjs via regex (avoids importing/executing it).
//   2. Parse config.ts for every `env.KEY ?? "value"` pattern.
//   3. Compare: any key in KNOB_DEFAULTS whose value disagrees with config.ts exits 1.
//
// Exemptions: keys whose default cannot be statically extracted (e.g. computed at runtime) are listed in
// EXEMPT_KEYS and skipped with a note. Currently none — all 21 knobs use the simple `?? "literal"` pattern.

import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");

// Keys that cannot be statically extracted from config.ts (add with a comment explaining why).
const EXEMPT_KEYS = [];

// ─── 1. Extract KNOB_DEFAULTS from gen-codecommit.mjs ───────────────────────────────────────────────────────
const genSrc = readFileSync(join(ROOT, "scripts", "gen-codecommit.mjs"), "utf8");
const knobBlockMatch = genSrc.match(/const\s+KNOB_DEFAULTS\s*=\s*\{([\s\S]*?)\};/);
if (!knobBlockMatch) {
  console.error("FATAL: could not locate KNOB_DEFAULTS block in gen-codecommit.mjs");
  process.exit(1);
}
const knobDefaults = {};
const entryRe = /(\w+)\s*:\s*"([^"]*)"/g;
let m;
while ((m = entryRe.exec(knobBlockMatch[1])) !== null) {
  knobDefaults[m[1]] = m[2];
}
const knobKeys = Object.keys(knobDefaults);
if (knobKeys.length === 0) {
  console.error("FATAL: KNOB_DEFAULTS parsed as empty");
  process.exit(1);
}

// ─── 2. Extract env.X ?? "default" from config.ts ────────────────────────────────────────────────────────────
const configSrc = readFileSync(join(ROOT, "packages", "trader-worker", "src", "config.ts"), "utf8");
// Pattern: env.KEY_NAME ?? "literal"  (the canonical nullish-coalescing default pattern)
const configRe = /env\.(\w+)\s*\?\?\s*"([^"]*)"/g;
const configDefaults = new Map();
while ((m = configRe.exec(configSrc)) !== null) {
  // If a key appears multiple times (e.g. in comments + code), the LAST occurrence in loadConfig wins.
  // In practice each key has exactly one `??` fallback in the function body.
  configDefaults.set(m[1], m[2]);
}

// ─── 3. Compare ─────────────────────────────────────────────────────────────────────────────────────────────
const mismatches = [];
const missing = [];

for (const key of knobKeys) {
  if (EXEMPT_KEYS.includes(key)) continue;
  const genVal = knobDefaults[key];
  const cfgVal = configDefaults.get(key);
  if (cfgVal === undefined) {
    missing.push(key);
  } else if (cfgVal !== genVal) {
    mismatches.push({ key, genVal, cfgVal });
  }
}

// ─── 4. Report ──────────────────────────────────────────────────────────────────────────────────────────────
let hasError = false;

if (missing.length > 0) {
  console.error("ERROR: keys in KNOB_DEFAULTS with NO matching `env.X ?? \"…\"` in config.ts:");
  for (const k of missing) console.error(`  • ${k} (gen-codecommit value: "${knobDefaults[k]}")`);
  hasError = true;
}

if (mismatches.length > 0) {
  console.error("ERROR: KNOB_DEFAULTS ↔ config.ts value mismatches:");
  for (const { key, genVal, cfgVal } of mismatches) {
    console.error(`  • ${key}: gen-codecommit="${genVal}" vs config.ts="${cfgVal}"`);
  }
  hasError = true;
}

if (hasError) {
  console.error("\nFix: update KNOB_DEFAULTS in scripts/gen-codecommit.mjs to match config.ts, then re-run.");
  process.exit(1);
}

const exemptNote = EXEMPT_KEYS.length > 0 ? ` (${EXEMPT_KEYS.length} exempt)` : "";
console.log(`check-knob-defaults: ${knobKeys.length} keys verified against config.ts${exemptNote} — all consistent.`);
process.exit(0);
