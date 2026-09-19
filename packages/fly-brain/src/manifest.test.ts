// Brain-manifest structural-spec tests — the deterministic core of the "prove the brain" story.
//
// These pin the property the whole offline replay rests on: a connectome's quantised structural spec is
// (a) identical for the same (seed, opts) — reproducible by anyone, and (b) different for different
// seeds — so each fly's brain has a distinct identity. Plus the ULP-safety choices: coarse milli
// quantisation on gaussian-derived weights, fine micro on integer-PRNG-derived tau/vThresh.

import test from "node:test";
import assert from "node:assert/strict";

import { buildConnectome, DEFAULT_CONNECTOME_OPTIONS } from "./connectome.js";
import {
  connectomeStructuralSpec,
  connectomeSpecForSeed,
  effectiveConnectomeOptions,
  BRAIN_MANIFEST_VERSION,
  CONNECTOME_PROVENANCE,
  LIF_CONSTANTS,
} from "./manifest.js";

test("structural spec is deterministic for the same seed", () => {
  const a = connectomeSpecForSeed(42);
  const b = connectomeSpecForSeed(42);
  assert.deepEqual(a, b, "same seed ⇒ identical structural spec");
});

test("structural spec is distinct across seeds (per-fly identity, worker stride 7919)", () => {
  const a = connectomeSpecForSeed(42);
  const b = connectomeSpecForSeed(42 + 7919);
  assert.notEqual(a.edgeHash, b.edgeHash, "different seed ⇒ different topology fingerprint");
  assert.notEqual(a.weightMilli, b.weightMilli, "different seed ⇒ different weight checksum");
  // Same species: layer sizes are unchanged, only the wiring differs.
  assert.equal(a.neuronCount, b.neuronCount);
  assert.deepEqual(a.byKind, b.byKind);
});

test("connectomeSpecForSeed == connectomeStructuralSpec(buildConnectome(...)) (rebuild match)", () => {
  const opts = { nSensory: 60, nInterL1: 80, nInterL2: 80, density: 0.03 };
  const viaHelper = connectomeSpecForSeed(7, opts);
  const viaBuild = connectomeStructuralSpec(buildConnectome({ ...opts, seed: 7 }));
  assert.deepEqual(viaHelper, viaBuild, "the verifier's rebuild path matches the direct spec");
});

test("default spec is the documented ~1,080-neuron graph", () => {
  const s = connectomeSpecForSeed(42);
  assert.equal(s.neuronCount, 1080);
  assert.equal(s.byKind.sensory, 180);
  assert.equal(s.byKind.inter, 800);
  assert.equal(s.byKind.modulatory, 40);
  assert.equal(s.byKind.motor, 60);
  assert.ok(s.synapseCount > 5_000, "richly connected, not a stub");
  assert.match(s.edgeHash, /^[0-9a-f]{8}$/, "edgeHash is 8 lowercase hex chars");
  for (const ch of ["leg_left", "leg_right", "wing", "proboscis", "abdomen"]) {
    assert.equal(s.motorChannels[ch], 12, `${ch} has 12 motor neurons`);
  }
});

test("spec is sensitive to a wiring change (a tampered synapse cannot slip through)", () => {
  const conn = buildConnectome({ seed: 99 });
  const before = connectomeStructuralSpec(conn);
  // Perturb one synapse's weight by more than the milli quantisation step.
  conn.synapses[conn.synapses.length >> 1].w += 0.01;
  const after = connectomeStructuralSpec(conn);
  assert.notEqual(before.edgeHash, after.edgeHash, "a weight change flips the topology fingerprint");
  assert.notEqual(before.weightMilli, after.weightMilli);
});

test("effectiveConnectomeOptions fills defaults and treats explicit undefined as absent", () => {
  const eff = effectiveConnectomeOptions({ nSensory: undefined, density: 0.05 });
  assert.equal(eff.nSensory, DEFAULT_CONNECTOME_OPTIONS.nSensory, "undefined ⇒ default");
  assert.equal(eff.density, 0.05, "explicit value preserved");
  assert.equal(eff.seed, DEFAULT_CONNECTOME_OPTIONS.seed);
  // A verifier rebuilding from the effective opts must get the same brain as from the raw opts.
  const fromRaw = connectomeSpecForSeed(5, { nSensory: undefined, density: 0.05 });
  const fromEff = connectomeSpecForSeed(5, eff);
  assert.deepEqual(fromRaw, fromEff, "effective opts reproduce the same structural spec");
});

test("recorded constants are internally consistent and honest", () => {
  assert.equal(BRAIN_MANIFEST_VERSION, 1);
  assert.equal(CONNECTOME_PROVENANCE.flywireLiteral, false, "never claims to ship literal FlyWire data");
  assert.equal(CONNECTOME_PROVENANCE.llmInvolved, false);
  assert.equal(LIF_CONSTANTS.adaptIncrement, 0.05, "matches the tuned SFA in lif.ts");
  assert.equal(LIF_CONSTANTS.tauSyn, 5.0);
});
