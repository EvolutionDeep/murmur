// Brain-manifest tests — the assemble → hash → offline-replay round-trip and its tamper-evidence.
//
// The invariant that matters: a manifest assembled from a config must (a) hash deterministically, and
// (b) PASS replayVerifyManifest() when every fly is rebuilt from the committed seeds — while ANY edit to
// a committed spec, seed, or roster makes replay FAIL. That asymmetry is the whole "prove the brain"
// guarantee: the committed structure is exactly what the seeds regenerate, or the check refuses it.

import test from "node:test";
import assert from "node:assert/strict";

import { loadConfig, type Env, type RuntimeConfig } from "./config.js";
import {
  assembleManifest,
  manifestHash,
  replayVerifyManifest,
  MANIFEST_SCHEMA,
  MANIFEST_SCHEMA_VERSION,
  SEED_STRIDE,
  type BrainManifest,
} from "./manifest.js";

/** A deterministic runtime config; defaults to a small population so tests stay fast. */
function cfg(over: Partial<Env> = {}): RuntimeConfig {
  return loadConfig({ POPULATION_SIZE: "3", ...over } as unknown as Env);
}

test("assembleManifest is deterministic: same config ⇒ same hash", async () => {
  const a = assembleManifest(cfg());
  const b = assembleManifest(cfg());
  assert.deepEqual(a, b, "manifest body is reproducible (no clock, no randomness)");
  assert.equal(await manifestHash(a), await manifestHash(b));
  assert.match(await manifestHash(a), /^[0-9a-f]{64}$/, "sha256 hex");
});

test("a freshly assembled manifest replays clean (the offline verifier rebuilds every brain)", () => {
  const m = assembleManifest(cfg());
  const res = replayVerifyManifest(m);
  assert.equal(res.ok, true, JSON.stringify(res.mismatches));
  assert.equal(res.checked, m.flies.length);
  assert.equal(res.mismatches.length, 0);
});

test("the REAL 24-fly config replays clean and its seeds follow base + i*7919", () => {
  const m = assembleManifest(cfg({ POPULATION_SIZE: "24", POPULATION_SEED_BASE: "42" }));
  assert.equal(m.flies.length, 24);
  assert.equal(m.population.size, 24);
  assert.equal(m.population.seedStride, SEED_STRIDE);
  m.flies.forEach((f, i) => assert.equal(f.seed, (42 + i * 7919) >>> 0, `fly ${i} seed`));
  assert.equal(replayVerifyManifest(m).ok, true);
});

test("manifest records honest provenance + the effective decoder anchors", () => {
  const m = assembleManifest(cfg({ REGIME_HOT: "0.7", REGIME_COLD: "0.3" }));
  assert.equal(m.schema, MANIFEST_SCHEMA);
  assert.equal(m.v, MANIFEST_SCHEMA_VERSION);
  assert.equal(m.llm.used, false, "explicitly no LLM");
  assert.match(m.llm.statement, /No large-language model/i);
  assert.equal(m.provenance.flywireLiteral, false, "never claims literal FlyWire data");
  // The decoder must carry the worker's LIVE regime thresholds, not the library defaults.
  assert.equal(m.decoder.hotT, 0.7);
  assert.equal(m.decoder.coldT, 0.3);
  assert.equal(m.chainTag, "arc-testnet", "default config is testnet");
});

test("TAMPER: editing a committed structural spec makes replay FAIL", () => {
  const m: BrainManifest = assembleManifest(cfg());
  m.flies[0].structural.edgeHash = "deadbeef";
  const res = replayVerifyManifest(m);
  assert.equal(res.ok, false, "a changed spec must not replay");
  assert.equal(res.mismatches[0].id, 0);
  assert.match(res.mismatches[0].reason, /structural spec/i);
});

test("TAMPER: editing a committed seed makes replay FAIL (seed-formula check)", () => {
  const m: BrainManifest = assembleManifest(cfg());
  m.flies[1].seed = 123456;
  const res = replayVerifyManifest(m);
  assert.equal(res.ok, false);
  assert.equal(res.mismatches[0].id, 1);
  assert.match(res.mismatches[0].reason, /seed/i);
});

test("TAMPER: dropping a fly (roster ≠ declared size) makes replay FAIL", () => {
  const m: BrainManifest = assembleManifest(cfg());
  m.flies.pop();
  const res = replayVerifyManifest(m);
  assert.equal(res.ok, false);
  assert.ok(res.mismatches.some((x) => /roster size/i.test(x.reason)));
});

test("a manifest survives a JSON round-trip and still replays (what /manifest + IPFS serve)", async () => {
  const m = assembleManifest(cfg({ POPULATION_SIZE: "5" }));
  const clone = JSON.parse(JSON.stringify(m)) as BrainManifest;
  assert.equal(await manifestHash(clone), await manifestHash(m), "hash is stable across serialisation");
  assert.equal(replayVerifyManifest(clone).ok, true);
});

test("different sizing opts ⇒ different hash, but still replay clean", async () => {
  const small = assembleManifest(cfg({ BRAIN_N_SENSORY: "60", BRAIN_N_INTER_L1: "80", BRAIN_N_INTER_L2: "80" }));
  const def = assembleManifest(cfg());
  assert.notEqual(await manifestHash(small), await manifestHash(def), "sizing changes the identity");
  assert.equal(small.flies[0].structural.byKind.sensory, 60);
  assert.equal(replayVerifyManifest(small).ok, true, "the committed sizing replays from its own opts");
});

test("codeVersion is opt-in and folds into the hash (null by default ⇒ reproducible)", async () => {
  const base = assembleManifest(cfg());
  const tagged = assembleManifest(cfg(), { codeVersion: "abc1234" });
  assert.equal(base.codeVersion, null);
  assert.equal(tagged.codeVersion, "abc1234");
  assert.notEqual(await manifestHash(base), await manifestHash(tagged));
  assert.equal(replayVerifyManifest(tagged).ok, true, "codeVersion does not affect the brain rebuild");
});
