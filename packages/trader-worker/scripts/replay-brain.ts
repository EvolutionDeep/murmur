#!/usr/bin/env -S npx tsx
// Offline, trustless replay of the murmur fly-brain manifest — "prove the brain" as a runnable artifact.
//
// This script needs NO murmur server, NO API key and (in its default mode) NO network. It either
// assembles a manifest from a declared config, or loads one you hand it, then does the two checks that
// make the on-chain commitment meaningful:
//
//   1. HASH   — recompute sha256(canonical(manifest)). With --expect <hash> (e.g. the manifestHash you
//               read off NeuralManifestRegistry on Arc) it asserts they match ⇒ the body is untampered.
//   2. REPLAY — rebuild every fly's connectome from the committed (seed, sizing opts) and re-derive its
//               quantised structural spec, comparing to the committed one ⇒ the published brains are
//               EXACTLY what those seeds deterministically generate. No hidden wiring, no LLM.
//
// Exit code is 0 on PASS, 1 on FAIL, so it drops straight into CI.
//
// Usage:
//   npx tsx scripts/replay-brain.ts                       # build the default config offline and verify
//   npx tsx scripts/replay-brain.ts --population 24 --seed-base 42
//   npx tsx scripts/replay-brain.ts --file ./manifest.json --expect 3f9a...   # verify a saved manifest
//   npx tsx scripts/replay-brain.ts --url  https://<worker>/manifest          # verify the live one
//   npx tsx scripts/replay-brain.ts --out ./manifest.json                     # also dump the artifact

import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig, type Env } from "../src/config.js";
import {
  assembleManifest,
  manifestHash,
  replayVerifyManifest,
  type BrainManifest,
} from "../src/manifest.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_WRANGLER = path.resolve(here, "..", "wrangler.toml");

interface Args {
  file?: string;
  url?: string;
  out?: string;
  outHash?: string;
  expect?: string;
  population?: string;
  seedBase?: string;
  chainId?: string;
  /** "" = default wrangler.toml; otherwise the given path; undefined = don't read wrangler. */
  fromWrangler?: string;
  noWrangler?: boolean;
}

function parseArgs(argv: string[]): Args {
  const a: Args = {};
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    const v = argv[i + 1];
    if (k === "--file") { a.file = v; i++; }
    else if (k === "--url") { a.url = v; i++; }
    else if (k === "--out") { a.out = v; i++; }
    else if (k === "--out-hash") { a.outHash = v; i++; }
    else if (k === "--expect") { a.expect = v; i++; }
    else if (k === "--population") { a.population = v; i++; }
    else if (k === "--seed-base") { a.seedBase = v; i++; }
    else if (k === "--chain-id") { a.chainId = v; i++; }
    else if (k === "--from-wrangler") {
      // Optional value: `--from-wrangler path.toml`, or bare `--from-wrangler` = the package default.
      if (v && !v.startsWith("--")) { a.fromWrangler = v; i++; } else { a.fromWrangler = ""; }
    }
    else if (k === "--no-wrangler") { a.noWrangler = true; }
  }
  return a;
}

/**
 * Minimal read of wrangler.toml's `[vars]` block into the Env shape loadConfig expects — so the offline
 * CLI rebuilds the SAME brain the deployed Worker runs (production is 10x, not the coded default).
 * Only the quoted `KEY = "value"` lines inside `[vars]` are taken; everything else (comments, other
 * tables, secrets) is ignored. Explicit CLI flags still override the file afterwards.
 */
function parseWranglerVars(file: string): Partial<Env> {
  const text = readFileSync(file, "utf8");
  const env: Record<string, string> = {};
  let inVars = false;
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line.startsWith("[")) { inVars = line.replace(/#.*$/, "").trim() === "[vars]"; continue; }
    if (!inVars || line.startsWith("#") || line === "") continue;
    const m = /^([A-Z0-9_]+)\s*=\s*"([^"]*)"/.exec(line);
    if (m) env[m[1]] = m[2];
  }
  return env as Partial<Env>;
}

/** Load a manifest from --file / --url, else assemble one offline from the declared (or default) config. */
async function obtainManifest(a: Args): Promise<{ manifest: BrainManifest; source: string }> {
  if (a.file) {
    return { manifest: JSON.parse(readFileSync(a.file, "utf8")), source: `file:${a.file}` };
  }
  if (a.url) {
    // NOTE: Node's global fetch (undici) does NOT honour HTTPS_PROXY. Behind a proxy, save the body to a
    // file (e.g. with curl.exe) and pass --file instead.
    const res = await fetch(a.url);
    if (!res.ok) throw new Error(`fetch ${a.url} → HTTP ${res.status}`);
    const body = await res.json();
    return { manifest: (body.manifest ?? body) as BrainManifest, source: `url:${a.url}` };
  }
  // Offline assembly. Unless --no-wrangler, seed the env from wrangler.toml's [vars] so the rebuild uses
  // the DEPLOYED sizing (production 10x), then let explicit CLI flags win.
  const env: Partial<Env> = {};
  let source = "offline:assembled";
  if (a.fromWrangler !== undefined && !a.noWrangler) {
    const file = a.fromWrangler || DEFAULT_WRANGLER;
    Object.assign(env, parseWranglerVars(file));
    source = `offline:wrangler:${path.relative(here, file) || file}`;
  }
  if (a.population) env.POPULATION_SIZE = a.population;
  if (a.seedBase) env.POPULATION_SEED_BASE = a.seedBase;
  if (a.chainId) env.CHAIN_ID = a.chainId;
  const cfg = loadConfig(env as Env);
  return { manifest: assembleManifest(cfg), source };
}

async function main(): Promise<void> {
  const a = parseArgs(process.argv.slice(2));
  const t0 = performance.now();
  const { manifest, source } = await obtainManifest(a);
  const tAssemble = performance.now();

  const hash = await manifestHash(manifest);
  const tHash = performance.now();
  const replay = replayVerifyManifest(manifest);
  const tReplay = performance.now();

  const expect = a.expect ? a.expect.replace(/^0x/i, "").toLowerCase() : null;
  const hashOk = expect ? expect === hash : true;

  console.log("═".repeat(72));
  console.log("  murmur brain-manifest replay  ·  trustless, offline, no LLM");
  console.log("═".repeat(72));
  console.log(`  source        : ${source}`);
  console.log(`  schema        : ${manifest.schema} v${manifest.v}  (brain v${manifest.brainManifestVersion})`);
  console.log(`  chain         : ${manifest.chainTag} (${manifest.chainId})`);
  console.log(`  policy / proof: ${manifest.policy} / v${manifest.proofV}`);
  console.log(`  population    : ${manifest.population.size} flies  ·  seedBase ${manifest.population.seedBase}  ·  ${manifest.population.seedFormula}`);
  const c = manifest.connectome as Record<string, unknown>;
  console.log(`  connectome    : sensory ${c.nSensory} · L1 ${c.nInterL1} · L2 ${c.nInterL2} · mod ${c.nModulatory} · motor/ch ${c.nMotorPerChannel} · density ${c.density}`);
  console.log(`  provenance    : flywireLiteral=${manifest.provenance.flywireLiteral} · generated=${manifest.provenance.generatedDeterministically} · llm=${manifest.llm.used}`);
  console.log("─".repeat(72));
  console.log(`  manifestHash  : ${hash}`);
  if (expect) console.log(`  expected      : ${expect}   →  ${hashOk ? "MATCH ✓" : "MISMATCH ✗"}`);
  console.log("─".repeat(72));
  console.log(`  replay        : ${replay.checked} brains rebuilt from committed seeds`);
  if (replay.ok) {
    console.log(`                  every structural spec reproduced → PASS ✓`);
  } else {
    console.log(`                  ${replay.mismatches.length} mismatch(es) → FAIL ✗`);
    for (const m of replay.mismatches.slice(0, 12)) console.log(`                    · fly ${m.id} (seed ${m.seed}): ${m.reason}`);
    if (replay.mismatches.length > 12) console.log(`                    … +${replay.mismatches.length - 12} more`);
  }
  console.log("─".repeat(72));
  console.log("  per-fly structural identity:");
  for (const f of manifest.flies) {
    const s = f.structural;
    console.log(`    #${String(f.id).padStart(2, "0")}  seed ${String(f.seed).padStart(10, " ")}  ·  ${s.neuronCount}n/${s.synapseCount}s  ·  wMilli ${String(s.weightMilli).padStart(9, " ")}  ·  edge ${s.edgeHash}`);
  }
  console.log("═".repeat(72));

  if (a.out) {
    writeFileSync(a.out, JSON.stringify(manifest, null, 2));
    console.log(`  wrote artifact → ${a.out}`);
  }
  if (a.outHash) {
    writeFileSync(a.outHash, hash + "\n");
    console.log(`  wrote hash     → ${a.outHash}`);
  }

  console.log("═".repeat(72));
  console.log(`  timing        : assemble ${(tAssemble - t0).toFixed(0)}ms · hash ${(tHash - tAssemble).toFixed(0)}ms · replay ${(tReplay - tHash).toFixed(0)}ms`);
  console.log("═".repeat(72));

  const pass = replay.ok && hashOk;
  console.log(`  RESULT: ${pass ? "PASS ✓  (structure reproduces from committed seeds" + (expect ? " and hash matches on-chain" : "") + ")" : "FAIL ✗"}`);
  console.log("═".repeat(72));
  process.exit(pass ? 0 : 1);
}

main().catch((err) => {
  console.error("replay-brain failed:", err?.message ?? err);
  process.exit(1);
});
