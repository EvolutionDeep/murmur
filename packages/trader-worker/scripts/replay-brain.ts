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
//   npx tsx scripts/replay-brain.ts --flywire             # FlyWire mode (real FAFB 783 subgraph)
//   npx tsx scripts/replay-brain.ts --population 24 --seed-base 42
//   npx tsx scripts/replay-brain.ts --file ./manifest.json --expect 3f9a...   # verify a saved manifest
//   npx tsx scripts/replay-brain.ts --url  https://<worker>/manifest          # verify the live one
//   npx tsx scripts/replay-brain.ts --out ./manifest.json                     # also dump the artifact
//
// FlyWire mode activates when: --flywire flag, FLYWIRE_TOPOLOGY=true env, or wrangler.toml says true.
// It loads packages/fly-brain/src/connectome-data/fafb783-mb-cx.bin.gz.b64 locally (same artifact
// production reads from KV) and calls assembleManifestFlyWire to produce the hash that matches on-chain.

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { decodeFlyWireArtifact, type FlyWireSubgraph } from "@fly/fly-brain";
import { loadConfig, type Env } from "../src/config.js";
import {
  assembleManifest,
  assembleManifestFlyWire,
  manifestHash,
  replayVerifyManifest,
  type BrainManifest,
} from "../src/manifest.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_WRANGLER = path.resolve(here, "..", "wrangler.toml");
/** Local path to the FAFB 783 artifact (same file uploaded to KV for production). */
const FLYWIRE_ARTIFACT_PATH = path.resolve(
  here, "..", "..", "fly-brain", "src", "connectome-data", "fafb783-mb-cx.bin.gz.b64",
);

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
  /** Force FlyWire topology mode (real FAFB 783 subgraph) instead of PRNG. */
  flywire?: boolean;
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
    else if (k === "--flywire") { a.flywire = true; }
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

/**
 * Determine whether FlyWire mode is active. Priority:
 *   1. --flywire CLI flag → always true
 *   2. FLYWIRE_TOPOLOGY env var === "true"
 *   3. wrangler.toml [vars] FLYWIRE_TOPOLOGY === "true"
 */
function detectFlyWireMode(a: Args, wranglerEnv: Partial<Env>): boolean {
  if (a.flywire) return true;
  if ((process.env.FLYWIRE_TOPOLOGY ?? "").toLowerCase() === "true") return true;
  if ((wranglerEnv.FLYWIRE_TOPOLOGY ?? "").toLowerCase() === "true") return true;
  return false;
}

/** Load the FlyWire subgraph from the local artifact file (same data production reads from KV). */
async function loadSubgraphLocal(): Promise<FlyWireSubgraph> {
  if (!existsSync(FLYWIRE_ARTIFACT_PATH)) {
    throw new Error(
      `FlyWire artifact not found at:\n  ${FLYWIRE_ARTIFACT_PATH}\n\n` +
      "This file (fafb783-mb-cx.bin.gz.b64, ~1.32 MB) ships with the repository under\n" +
      "  packages/fly-brain/src/connectome-data/\n" +
      "Ensure you have the full checkout (not a shallow/sparse clone) or download from:\n" +
      "  https://github.com/EvolutionDeep/murmur/tree/main/packages/fly-brain/src/connectome-data",
    );
  }
  const b64 = readFileSync(FLYWIRE_ARTIFACT_PATH, "utf8").trim();
  return decodeFlyWireArtifact(b64);
}

/** Load a manifest from --file / --url, else assemble one offline from the declared (or default) config. */
async function obtainManifest(a: Args): Promise<{ manifest: BrainManifest; source: string; mode: string }> {
  if (a.file) {
    const manifest = JSON.parse(readFileSync(a.file, "utf8")) as BrainManifest;
    const isFW = "mode" in (manifest.connectome as object) && (manifest.connectome as any).mode === "flywire";
    return { manifest, source: `file:${a.file}`, mode: isFW ? "flywire (from file)" : "prng (from file)" };
  }
  if (a.url) {
    // NOTE: Node's global fetch (undici) does NOT honour HTTPS_PROXY. Behind a proxy, save the body to a
    // file (e.g. with curl.exe) and pass --file instead.
    const res = await fetch(a.url);
    if (!res.ok) throw new Error(`fetch ${a.url} → HTTP ${res.status}`);
    const body = await res.json();
    const manifest = (body.manifest ?? body) as BrainManifest;
    const isFW = "mode" in (manifest.connectome as object) && (manifest.connectome as any).mode === "flywire";
    return { manifest, source: `url:${a.url}`, mode: isFW ? "flywire (from url)" : "prng (from url)" };
  }
  // Offline assembly. Unless --no-wrangler, seed the env from wrangler.toml's [vars] so the rebuild uses
  // the DEPLOYED sizing (production 10x), then let explicit CLI flags win.
  // When --flywire is specified, wrangler.toml is ALWAYS read (unless --no-wrangler) because the
  // production manifestHash can only be reproduced with the deployed config (CHAIN_ID, population, etc.).
  const env: Partial<Env> = {};
  let source = "offline:assembled";
  const shouldReadWrangler = (a.fromWrangler !== undefined || a.flywire) && !a.noWrangler;
  if (shouldReadWrangler) {
    const file = a.fromWrangler || DEFAULT_WRANGLER;
    Object.assign(env, parseWranglerVars(file));
    source = `offline:wrangler:${path.relative(here, file) || file}`;
  }
  if (a.population) env.POPULATION_SIZE = a.population;
  if (a.seedBase) env.POPULATION_SEED_BASE = a.seedBase;
  if (a.chainId) env.CHAIN_ID = a.chainId;
  const cfg = loadConfig(env as Env);

  // FlyWire vs PRNG mode detection
  const useFlyWire = detectFlyWireMode(a, env);
  if (useFlyWire) {
    const subgraph = await loadSubgraphLocal();
    const manifest = assembleManifestFlyWire(cfg, subgraph);
    const rel = path.relative(path.resolve(here, "..", "..", ".."), FLYWIRE_ARTIFACT_PATH);
    return { manifest, source, mode: `flywire (subgraph=${rel})` };
  }
  return { manifest: assembleManifest(cfg), source, mode: "prng" };
}

async function main(): Promise<void> {
  const a = parseArgs(process.argv.slice(2));
  const t0 = performance.now();
  const { manifest, source, mode } = await obtainManifest(a);
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
  console.log(`  mode          : ${mode}`);
  console.log(`  source        : ${source}`);
  console.log(`  schema        : ${manifest.schema} v${manifest.v}  (brain v${manifest.brainManifestVersion})`);
  console.log(`  chain         : ${manifest.chainTag} (${manifest.chainId})`);
  console.log(`  policy / proof: ${manifest.policy} / v${manifest.proofV}`);
  console.log(`  population    : ${manifest.population.size} flies  ·  seedBase ${manifest.population.seedBase}  ·  ${manifest.population.seedFormula}`);
  const c = manifest.connectome as Record<string, unknown>;
  if (c.mode === "flywire") {
    console.log(`  connectome    : flywire · ${c.nNeurons} neurons · ${c.nSynapses} synapses · fanInMean ${c.fanInMean} · weightGain ${c.weightGain} · jitter ${c.weightJitter}`);
  } else {
    console.log(`  connectome    : sensory ${c.nSensory} · L1 ${c.nInterL1} · L2 ${c.nInterL2} · mod ${c.nModulatory} · motor/ch ${c.nMotorPerChannel} · density ${c.density}`);
  }
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
