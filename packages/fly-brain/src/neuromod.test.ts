// A3 neuromodulatory read-out + gating tests.
//
// Three contracts pinned here:
//   1. DETERMINISM / REPLAYABILITY — computeNeuromod() and FlyBrain.readNeuromod() are pure functions of
//      the firing rates + the modulatory id list, so the same neural state always yields the same DA/OA
//      scalars (offline-replayable, like the connectome and the ethogram).
//   2. DARK-DEPLOY REGRESSION PROTECTION — with NEUROMOD_GATING OFF (the decoder default), supplying a
//      neuromod read-out (even an extreme one) changes NOTHING: arousal/turnBias/cohesion/wingbeat/rest,
//      the behavioural state, the neural fingerprint and the whole ethogram are byte-for-byte what a
//      no-neuromod decode produces. The modulation term is fully bypassed.
//   3. GATING ON — with neuromodGating=true the OA-like octopamine tone really does shade exploration
//      (arousal), monotonically and within a bounded band, while the read-out stays observable either way.

import test from "node:test";
import assert from "node:assert/strict";

import { FlyBrain } from "./fly-brain.js";
import { MotorDecoder, REF_BANDS, type PopulationBands } from "./motor-decoder.js";
import {
  computeNeuromod,
  neuromodPartition,
  NEUROMOD_CONFIG,
  NEUTRAL_NEUROMOD,
} from "./neuromod.js";
import { encodeMarketPulse } from "./stimuli.js";
import type { MotorChannel, MotorOutput, NeuromodState } from "./types.js";

const CH: MotorChannel[] = ["leg_left", "leg_right", "wing", "proboscis", "abdomen"];

/** Build a full 5-channel motor output from a sparse {channel: normalized} map (mirrors motor-decoder.test). */
function motor(vals: Partial<Record<MotorChannel, number>>): MotorOutput[] {
  return CH.map((channel) => {
    const normalized = vals[channel] ?? 0;
    return { channel, normalized, firingRate: normalized * 50, spikes: Math.round(normalized * 10) };
  });
}

const flatBands: PopulationBands = { arousal: [0, 1], cohesion: [0, 1], rest: [0, 1], turnAbs: 1 };
const sensory = encodeMarketPulse({
  temperature: 0.5, momentum: 0, turbulence: 0, density: 0, richness: 0, arousal: 0.5,
} as any);

/** The behavioural fields that feed the frontend render AND the economic read-out / provenance receipt. */
function behavioralSignature(b: ReturnType<MotorDecoder["decode"]>) {
  return {
    state: b.state,
    arousal: b.arousal,
    turnBias: b.turnBias,
    cohesion: b.cohesion,
    wingbeat: b.wingbeat,
    rest: b.rest,
    neuralFingerprint: b.neuralFingerprint,
    fap: b.fap,
    valence: b.valence,
    heading: b.heading,
    role: b.role,
    bouts: b.bouts,
  };
}

// ---------------------------------------------------------------------------
// 1) DETERMINISM / REPLAYABILITY of the neuromodulatory read-out
// ---------------------------------------------------------------------------

test("computeNeuromod is a pure, deterministic function of (firingRates, modulatoryIds)", () => {
  const ids = Array.from({ length: 40 }, (_, i) => 1000 + i);
  const rates = new Float32Array(1200);
  for (const id of ids) rates[id] = 8 + (id % 5); // arbitrary but fixed
  const a = computeNeuromod(rates, ids);
  const b = computeNeuromod(rates, ids);
  assert.deepEqual(a, b, "same input ⇒ identical DA/OA scalars (replayable)");
  for (const k of ["dopamine", "octopamine", "learningRateGate"] as const) {
    assert.ok(Number.isFinite(a[k]) && a[k] >= 0 && a[k] <= 1, `${k} normalized 0..1`);
  }
});

test("neuromodPartition deterministically splits the modulatory population into DA (lower) / OA (upper) halves", () => {
  const ids = [10, 11, 12, 13, 14, 15];
  const { da, oa } = neuromodPartition(ids);
  assert.deepEqual(da, [10, 11, 12]);
  assert.deepEqual(oa, [13, 14, 15]);
  // stable across calls
  assert.deepEqual(neuromodPartition(ids), { da, oa });
  // odd count ⇒ DA gets the smaller (floor) slice
  const odd = neuromodPartition([1, 2, 3, 4, 5]);
  assert.deepEqual(odd.da, [1, 2]);
  assert.deepEqual(odd.oa, [3, 4, 5]);
  // empty ⇒ two empty halves ⇒ zero DA/OA; the learning-rate gate falls back to its floor (not 0)
  const empty = computeNeuromod(new Float32Array(0), []);
  assert.equal(empty.dopamine, 0);
  assert.equal(empty.octopamine, 0);
  assert.ok(Math.abs(empty.learningRateGate - NEUROMOD_CONFIG.lrGateFloor) < 1e-9);
});

test("computeNeuromod is NaN-safe: a poisoned rate never yields a NaN scalar", () => {
  const ids = [0, 1, 2, 3];
  const rates = new Float32Array(4);
  rates[0] = NaN; rates[1] = 5; rates[2] = 5; rates[3] = 5;
  const s = computeNeuromod(rates, ids);
  for (const k of ["dopamine", "octopamine", "learningRateGate"] as const) {
    assert.ok(Number.isFinite(s[k]), `${k} finite even with a NaN input rate`);
  }
});

test("learningRateGate tracks dopamine within [floor, 1] (reserved A1 plasticity output)", () => {
  const ids = Array.from({ length: 20 }, (_, i) => i);
  const floor = NEUROMOD_CONFIG.lrGateFloor;
  const lo = computeNeuromod(new Float32Array(20), ids); // silent DA half ⇒ dopamine 0
  assert.ok(Math.abs(lo.dopamine) < 1e-9);
  assert.ok(lo.learningRateGate >= floor - 1e-9 && lo.learningRateGate <= 1);
  const hot = new Float32Array(20);
  for (let i = 0; i < 10; i++) hot[i] = NEUROMOD_CONFIG.refHz; // saturate the DA half
  const hi = computeNeuromod(hot, ids);
  assert.ok(hi.dopamine > lo.dopamine, "more DA firing ⇒ higher dopamine");
  assert.ok(hi.learningRateGate >= lo.learningRateGate, "gate is monotonic in dopamine");
});

test("FlyBrain.readNeuromod() is reproducible from the same seed + drive history (replay)", () => {
  const drive = (b: FlyBrain) => {
    const pulse = encodeMarketPulse({
      temperature: 0.7, momentum: 0.1, turbulence: 0.2, density: 0.3, richness: 0.6, arousal: 0.5,
    } as any);
    for (let i = 0; i < 30; i++) { for (const s of pulse) b.inject(s); b.advance(50); }
  };
  const a = new FlyBrain({ seed: 42 }); drive(a);
  const c = new FlyBrain({ seed: 42 }); drive(c);
  const na = a.readNeuromod();
  const nc = c.readNeuromod();
  assert.deepEqual(na, nc, "identical seed + identical drive ⇒ identical DA/OA state");
  // snapshot() carries the same read-out (observability) and is manifest-neutral
  assert.deepEqual(a.snapshot().neuromod, na);
});

// ---------------------------------------------------------------------------
// 2) DARK-DEPLOY REGRESSION PROTECTION — gating OFF ⇒ byte-for-byte unchanged
// ---------------------------------------------------------------------------

test("GATING OFF (default): a supplied neuromod read-out changes NO behavioural output", () => {
  const dec = new MotorDecoder(); // neuromodGating defaults to false
  const m = motor({ leg_left: 0.4, leg_right: 0.1, wing: 0.05, proboscis: 0.2, abdomen: 0.03 });

  const extreme: NeuromodState = { dopamine: 1, octopamine: 1, learningRateGate: 1 };
  const withoutNeuromod = dec.decode(m, sensory, 1000, 0.5, flatBands);
  // A FRESH decoder for the neuromod-supplied call so hysteresis state is identical between the two.
  const dec2 = new MotorDecoder();
  const withNeuromod = dec2.decode(m, sensory, 1000, 0.5, flatBands, extreme);

  assert.deepEqual(
    behavioralSignature(withNeuromod),
    behavioralSignature(withoutNeuromod),
    "with gating off, the octopamine/dopamine terms are fully bypassed (byte-for-byte identical behaviour)",
  );
  // The read-out is still OBSERVABLE even when it drives nothing.
  assert.deepEqual(withNeuromod.neuromod, extreme, "neuromod is surfaced for observability regardless of the gate");
  assert.deepEqual(withoutNeuromod.neuromod, NEUTRAL_NEUROMOD, "no neuromod supplied ⇒ neutral zero read-out");
});

test("GATING OFF is the decoder default even when explicitly constructed with neuromodGating:false", () => {
  const m = motor({ leg_left: 0.3, leg_right: 0.3, wing: 0.04, proboscis: 0.15, abdomen: 0.02 });
  const off = new MotorDecoder({}, { neuromodGating: false });
  const hi: NeuromodState = { dopamine: 0.9, octopamine: 0.95, learningRateGate: 0.9 };
  const base = new MotorDecoder({}, { neuromodGating: false }).decode(m, sensory, 500, 0.6, REF_BANDS);
  const gated = off.decode(m, sensory, 500, 0.6, REF_BANDS, hi);
  assert.equal(gated.arousal, base.arousal, "octopamine never touches arousal when the gate is off");
  assert.deepEqual(behavioralSignature(gated), behavioralSignature(base));
});

// ---------------------------------------------------------------------------
// 3) GATING ON — octopamine really modulates exploration/arousal
// ---------------------------------------------------------------------------

test("GATING ON: octopamine shades arousal monotonically within a bounded band", () => {
  const m = motor({ leg_left: 0.4, leg_right: 0.1, wing: 0.05, proboscis: 0.2, abdomen: 0.03 });
  const mk = (oa: number) =>
    new MotorDecoder({}, { neuromodGating: true }).decode(
      m, sensory, 1000, 0.5, flatBands, { dopamine: 0.5, octopamine: oa, learningRateGate: 0.5 },
    );
  const low = mk(0).arousal;
  const mid = mk(0.5).arousal;
  const high = mk(1).arousal;
  assert.ok(high > mid && mid > low, `arousal rises with octopamine (${low} < ${mid} < ${high})`);
  // Bounded: the modulation can move arousal by at most ±gain/2 around the ungated base.
  const ungated = new MotorDecoder().decode(m, sensory, 1000, 0.5, flatBands).arousal;
  const gain = 0.25; // DEFAULT_DECODER_OPTIONS.neuromodGain
  assert.ok(Math.abs(high - ungated) <= gain / 2 + 1e-9, "high octopamine stays within +gain/2 of the base");
  assert.ok(Math.abs(low - ungated) <= gain / 2 + 1e-9, "low octopamine stays within −gain/2 of the base");
  // At the neutral octopamine midpoint the gated arousal equals the ungated base (no net modulation).
  assert.ok(Math.abs(mid - ungated) < 1e-9, "octopamine=0.5 is the neutral point");
});

test("GATING ON: dopamine does NOT leak into arousal (only octopamine gates exploration)", () => {
  const m = motor({ leg_left: 0.4, leg_right: 0.1, wing: 0.05, proboscis: 0.2, abdomen: 0.03 });
  const dec = (da: number) =>
    new MotorDecoder({}, { neuromodGating: true }).decode(
      m, sensory, 1000, 0.5, flatBands, { dopamine: da, octopamine: 0.5, learningRateGate: da },
    );
  assert.equal(dec(0).arousal, dec(1).arousal, "arousal is a function of octopamine only");
});

test("GATING ON: the neuromod read-out is still surfaced on the behaviour", () => {
  const m = motor({ leg_left: 0.2, leg_right: 0.2, wing: 0.03, proboscis: 0.1, abdomen: 0.02 });
  const nm: NeuromodState = { dopamine: 0.3, octopamine: 0.7, learningRateGate: 0.4 };
  const b = new MotorDecoder({}, { neuromodGating: true }).decode(m, sensory, 10, 0.5, flatBands, nm);
  assert.deepEqual(b.neuromod, nm);
});
