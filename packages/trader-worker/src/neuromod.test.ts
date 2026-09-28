// A3 neuromodulatory gating — worker-side contract tests.
//
// Proves the properties the dark deploy depends on:
//   1. NEUROMOD_GATING defaults to FALSE and only "true" turns it on (config.ts).
//   2. The switch is MANIFEST-NEUTRAL: flipping it does not rotate the on-chain brain-manifest hash,
//      because the gate lives outside DEFAULT_DECODER_CONFIG and the read-out adds no neurons.
//   3. DARK DEPLOY at the read-out seam: with gating off, reduceReadOuts threads the neuromod read-out
//      into the observable FlyReading, yet the provenance NeuralEvidence (the bytes that become the
//      EIP-3009 nonce) is byte-for-byte identical no matter what the modulatory layer is doing — so no
//      real-money settlement path changes while the switch is off.
//   4. COLLECTIVE PULSE: reduceReadOuts folds the per-fly read-outs into the four published collective
//      means (meanDopamine/meanOctopamine/meanDaHz/meanOaHz) — coordinator-side, from scalars that already
//      cross the shard boundary, so an empty roster reads exactly 0 and a stale read-out can never NaN it.

import test from "node:test";
import assert from "node:assert/strict";

import { MotorDecoder, type MarketPulse, type MotorOutput, type NeuromodState } from "@fly/fly-brain";
import { loadConfig, type Env, type RuntimeConfig } from "./config.js";
import { assembleManifest, manifestHash } from "./manifest.js";
import { reduceReadOuts, type FlyReadOut, type ReduceRosterEntry } from "./population.js";
import { neuralEvidence } from "./provenance.js";

function cfg(over: Partial<Env> = {}): RuntimeConfig {
  return loadConfig({ POPULATION_SIZE: "3", ...over } as unknown as Env);
}

const CH = ["leg_left", "leg_right", "wing", "proboscis", "abdomen"] as const;
function motor(vals: Partial<Record<(typeof CH)[number], number>>): MotorOutput[] {
  return CH.map((channel) => {
    const normalized = vals[channel] ?? 0;
    return { channel, normalized, firingRate: normalized * 50, spikes: Math.round(normalized * 10) };
  });
}

const pulse: MarketPulse = { temperature: 0.5, momentum: 0, turbulence: 0, density: 0, richness: 0 };
const sensory = [
  { channel: "thermal_warmth" as const, intensity: 0.5 },
  { channel: "gustatory_richness" as const, intensity: 0.4 },
];

// ---------------------------------------------------------------------------
// 1) config: the switch defaults OFF (dark deploy) and only "true" enables it
// ---------------------------------------------------------------------------

test("NEUROMOD_GATING defaults to false (dark deploy)", () => {
  assert.equal(cfg().neuromodGating, false, "absent env ⇒ gating off");
  assert.equal(cfg({ NEUROMOD_GATING: "false" }).neuromodGating, false);
  assert.equal(cfg({ NEUROMOD_GATING: "" }).neuromodGating, false, "empty ⇒ off");
  assert.equal(cfg({ NEUROMOD_GATING: "garbage" }).neuromodGating, false, "non-'true' ⇒ off");
});

test("NEUROMOD_GATING=\"true\" (case-insensitive) enables gating", () => {
  assert.equal(cfg({ NEUROMOD_GATING: "true" }).neuromodGating, true);
  assert.equal(cfg({ NEUROMOD_GATING: "TRUE" }).neuromodGating, true);
});

// ---------------------------------------------------------------------------
// 2) manifest-neutrality: the switch never rotates the on-chain brain hash
// ---------------------------------------------------------------------------

test("flipping NEUROMOD_GATING does NOT change the brain-manifest hash (manifest-neutral)", async () => {
  const off = assembleManifest(cfg({ NEUROMOD_GATING: "false" }));
  const on = assembleManifest(cfg({ NEUROMOD_GATING: "true" }));
  assert.equal(await manifestHash(off), await manifestHash(on), "the gate is outside the hashed body");
});

// ---------------------------------------------------------------------------
// 3) dark deploy at the read-out seam: observable, but provenance-inert while off
// ---------------------------------------------------------------------------

function roster(gating: boolean): ReduceRosterEntry[] {
  return [0, 1].map((id) => ({
    id,
    temperament: 0.5,
    decoder: new MotorDecoder({ hotT: 0.66, coldT: 0.33 }, { neuromodGating: gating }),
  }));
}

function readOut(id: number, nm: NeuromodState): FlyReadOut {
  return { id, motor: motor({ leg_left: 0.4, leg_right: 0.1, wing: 0.05, proboscis: 0.2, abdomen: 0.03 }), sensory, t: 1000, neuromod: nm };
}

test("gating OFF: reduceReadOuts surfaces neuromod but provenance evidence is unchanged by it", () => {
  const calm: NeuromodState = { dopamine: 0.1, octopamine: 0.1, learningRateGate: 0.1, daHz: 4, oaHz: 4 };
  const hot: NeuromodState = { dopamine: 0.95, octopamine: 0.95, learningRateGate: 0.95, daHz: 38, oaHz: 38 };

  const a = reduceReadOuts([readOut(0, calm), readOut(1, calm)], roster(false), { pulse, regime: "CALM", vitality: 0.5 });
  const b = reduceReadOuts([readOut(0, hot), readOut(1, hot)], roster(false), { pulse, regime: "CALM", vitality: 0.5 });

  // The read-out is observable on the FlyReading either way.
  assert.deepEqual(a.readings[0].neuromod, calm, "neuromod is threaded into the reading (observability)");
  assert.deepEqual(b.readings[0].neuromod, hot);

  // ...yet the provenance evidence — the bytes hashed into the EIP-3009 nonce — is IDENTICAL, so no
  // real-money settlement changes while the switch is off.
  assert.deepEqual(neuralEvidence(a.readings[0]), neuralEvidence(b.readings[0]), "dark deploy: money path inert");
  assert.equal(a.readings[0].arousal, b.readings[0].arousal, "arousal untouched by neuromod when gating is off");
  assert.equal(a.readings[0].fingerprint, b.readings[0].fingerprint);
});

test("gating ON: the same octopamine swing DOES move arousal (the coupling is real when enabled)", () => {
  const calm: NeuromodState = { dopamine: 0.1, octopamine: 0.05, learningRateGate: 0.1, daHz: 4, oaHz: 2 };
  const hot: NeuromodState = { dopamine: 0.1, octopamine: 0.95, learningRateGate: 0.1, daHz: 4, oaHz: 38 };
  const a = reduceReadOuts([readOut(0, calm), readOut(1, calm)], roster(true), { pulse, regime: "CALM", vitality: 0.5 });
  const b = reduceReadOuts([readOut(0, hot), readOut(1, hot)], roster(true), { pulse, regime: "CALM", vitality: 0.5 });
  assert.ok(b.readings[0].arousal > a.readings[0].arousal, "higher octopamine ⇒ higher arousal when gating is on");
});

// ---------------------------------------------------------------------------
// 4) the collective neuromodulatory pulse (GET /population → snapshot.collective)
// ---------------------------------------------------------------------------

const MEAN_KEYS = ["meanDopamine", "meanOctopamine", "meanDaHz", "meanOaHz"] as const;

test("reduceReadOuts folds the collective pulse: mean normalized tone + mean RAW Hz across the roster", () => {
  // Fixtures keep the published per-fly identity honest: raw Hz = normalized × refHz (40).
  const low: NeuromodState = { dopamine: 0.2, octopamine: 0.4, learningRateGate: 0.2, daHz: 8, oaHz: 16 };
  const high: NeuromodState = { dopamine: 0.6, octopamine: 0.8, learningRateGate: 0.6, daHz: 24, oaHz: 32 };
  const out = reduceReadOuts([readOut(0, low), readOut(1, high)], roster(false), { pulse, regime: "CALM", vitality: 0.5 });
  const c = out.collective;
  assert.equal(c.size, 2);
  assert.ok(Math.abs(c.meanDopamine - 0.4) < 1e-9, `meanDopamine = (0.2+0.6)/2 (${c.meanDopamine})`);
  assert.ok(Math.abs(c.meanOctopamine - 0.6) < 1e-9, `meanOctopamine = (0.4+0.8)/2 (${c.meanOctopamine})`);
  assert.ok(Math.abs(c.meanDaHz - 16) < 1e-9, `meanDaHz = (8+24)/2 (${c.meanDaHz})`);
  assert.ok(Math.abs(c.meanOaHz - 24) < 1e-9, `meanOaHz = (16+32)/2 (${c.meanOaHz})`);
  // The per-fly readings keep carrying the whole read-out (raw pair included) — the /snapshot + /population contract.
  assert.deepEqual(out.readings[0].neuromod, low);
  assert.deepEqual(out.readings[1].neuromod, high);
});

test("an empty roster reports all-zero collective neuromod means (no divide-by-zero, no NaN)", () => {
  const out = reduceReadOuts([], [], { pulse, regime: "CALM", vitality: 0.5 });
  assert.equal(out.collective.size, 0);
  assert.equal(out.readings.length, 0);
  for (const k of MEAN_KEYS) assert.equal(out.collective[k], 0, `${k} is exactly 0 for an empty population`);
});

test("a fly with no read-out contributes the neutral zero, so the means stay finite (mixed-version shard safety)", () => {
  const hot: NeuromodState = { dopamine: 0.8, octopamine: 0.8, learningRateGate: 0.8, daHz: 32, oaHz: 32 };
  // Only fly 0 reports; fly 1 is on the roster but its shard returned nothing ⇒ decode falls back to neutral.
  const out = reduceReadOuts([readOut(0, hot)], roster(false), { pulse, regime: "CALM", vitality: 0.5 });
  const c = out.collective;
  for (const k of MEAN_KEYS) assert.ok(Number.isFinite(c[k]), `${k} finite when a read-out is missing`);
  assert.ok(Math.abs(c.meanDopamine - 0.4) < 1e-9, `mean over the FULL roster, not just the reporters (${c.meanDopamine})`);
  assert.ok(Math.abs(c.meanDaHz - 16) < 1e-9, `raw mean over the full roster (${c.meanDaHz})`);
});

test("a legacy read-out without the raw Hz pair degrades to 0 rather than poisoning the collective with NaN", () => {
  const legacy = { dopamine: 0.5, octopamine: 0.25, learningRateGate: 0.5 } as unknown as NeuromodState;
  const out = reduceReadOuts([readOut(0, legacy), readOut(1, legacy)], roster(false), { pulse, regime: "CALM", vitality: 0.5 });
  const c = out.collective;
  assert.ok(Math.abs(c.meanDopamine - 0.5) < 1e-9, "the normalized means still aggregate");
  assert.ok(Math.abs(c.meanOctopamine - 0.25) < 1e-9);
  assert.equal(c.meanDaHz, 0, "a missing raw field reads as 0");
  assert.equal(c.meanOaHz, 0);
});
