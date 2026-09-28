// A3 neuromodulatory read-out + gating tests.
//
// Four contracts pinned here:
//   1. DETERMINISM / REPLAYABILITY — computeNeuromod() and FlyBrain.readNeuromod() are pure functions of
//      the firing rates + the modulatory id list, so the same neural state always yields the same DA/OA
//      scalars (offline-replayable, like the connectome and the ethogram).
//   1b. RAW Hz PAIR — daHz/oaHz are the un-normalized half-population mean rates, reduced ONCE and reused
//      for the normalized pair, so dopamine === clamp01(daHz/refHz) and octopamine === clamp01(oaHz/refHz)
//      always hold (refHz = 40) and the raw values stay honest (unclamped, 0 for an empty half, never NaN).
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
  // The raw pair rides along on the same reduction and is replayable too.
  for (const k of ["daHz", "oaHz"] as const) {
    assert.ok(Number.isFinite(a[k]) && a[k] >= 0, `${k} is a finite, non-negative raw rate`);
  }
});

// ---------------------------------------------------------------------------
// 1b) The RAW Hz pair (daHz/oaHz) and its exact relation to the normalized pair
// ---------------------------------------------------------------------------

test("daHz/oaHz are the RAW half-population mean rates and the normalized pair is derived from them", () => {
  const ids = Array.from({ length: 8 }, (_, i) => i); // DA = ids 0..3, OA = ids 4..7
  const rates = new Float32Array(8);
  for (let i = 0; i < 4; i++) rates[i] = 10; // DA half fires at 10 Hz
  for (let i = 4; i < 8; i++) rates[i] = 30; // OA half fires at 30 Hz
  const s = computeNeuromod(rates, ids);
  assert.ok(Math.abs(s.daHz - 10) < 1e-6, `daHz is the DA half's mean rate (${s.daHz} Hz)`);
  assert.ok(Math.abs(s.oaHz - 30) < 1e-6, `oaHz is the OA half's mean rate (${s.oaHz} Hz)`);
  const ref = NEUROMOD_CONFIG.refHz; // 40
  assert.ok(Math.abs(s.dopamine - Math.min(1, Math.max(0, s.daHz / ref))) < 1e-9, "dopamine === clamp01(daHz/refHz)");
  assert.ok(Math.abs(s.octopamine - Math.min(1, Math.max(0, s.oaHz / ref))) < 1e-9, "octopamine === clamp01(oaHz/refHz)");
});

test("the raw Hz pair is UNCLAMPED (it keeps reporting the true rate above refHz) while the normalized pair saturates", () => {
  const ids = Array.from({ length: 8 }, (_, i) => i);
  const hot = new Float32Array(8).fill(120); // 3x the 40 Hz reference
  const s = computeNeuromod(hot, ids);
  assert.ok(Math.abs(s.daHz - 120) < 1e-6 && Math.abs(s.oaHz - 120) < 1e-6, "raw rates are not clamped to refHz");
  assert.equal(s.dopamine, 1, "normalized dopamine saturates at 1");
  assert.equal(s.octopamine, 1, "normalized octopamine saturates at 1");
});

test("daHz/oaHz follow the deterministic DA/OA split (odd counts give DA the floor half)", () => {
  const ids = [0, 1, 2, 3, 4]; // DA = {0,1}, OA = {2,3,4}
  const rates = new Float32Array(5);
  rates[0] = 4; rates[1] = 8; rates[2] = 10; rates[3] = 20; rates[4] = 30;
  const s = computeNeuromod(rates, ids);
  assert.ok(Math.abs(s.daHz - 6) < 1e-6, `DA mean over the floor half = (4+8)/2 (${s.daHz})`);
  assert.ok(Math.abs(s.oaHz - 20) < 1e-6, `OA mean over the larger half = (10+20+30)/3 (${s.oaHz})`);
});

test("daHz/oaHz are 0 for an empty modulatory population and never NaN for a poisoned rate", () => {
  const empty = computeNeuromod(new Float32Array(0), []);
  assert.equal(empty.daHz, 0, "no modulatory neurons ⇒ 0 Hz, not NaN");
  assert.equal(empty.oaHz, 0);
  // The DA/OA pair (raw + normalized) matches the neutral state. The RESERVED gate deliberately does NOT:
  // an empty layer still reports its floor, while NEUTRAL_NEUROMOD pins 0 (see its doc) — so compare only
  // the four rate fields here.
  assert.deepEqual(
    { dopamine: empty.dopamine, octopamine: empty.octopamine, daHz: empty.daHz, oaHz: empty.oaHz },
    { dopamine: NEUTRAL_NEUROMOD.dopamine, octopamine: NEUTRAL_NEUROMOD.octopamine, daHz: NEUTRAL_NEUROMOD.daHz, oaHz: NEUTRAL_NEUROMOD.oaHz },
    "an empty modulatory layer reads the neutral DA/OA state",
  );

  const ids = [0, 1, 2, 3];
  const rates = new Float32Array(4);
  rates[0] = NaN; rates[1] = 5; rates[2] = 5; rates[3] = 5;
  const s = computeNeuromod(rates, ids);
  assert.ok(Number.isFinite(s.daHz) && Number.isFinite(s.oaHz), "raw rates stay finite through a NaN input");
  // A non-finite rate contributes 0 to the sum but the half size still divides ⇒ the half reads LOW, never NaN.
  assert.ok(Math.abs(s.daHz - 2.5) < 1e-6, `DA = {NaN, 5} ⇒ (0+5)/2 (${s.daHz})`);
  assert.ok(Math.abs(s.oaHz - 5) < 1e-6, `OA = {5, 5} ⇒ 5 (${s.oaHz})`);
});

test("NEUTRAL_NEUROMOD carries the raw pair at zero (a no-neuromod decode never invents a rate)", () => {
  assert.deepEqual(NEUTRAL_NEUROMOD, { dopamine: 0, octopamine: 0, learningRateGate: 0, daHz: 0, oaHz: 0 });
});

test("FlyBrain.readNeuromod's raw pair equals the actual modulatory halves' firing rates", () => {
  const b = new FlyBrain({ seed: 7 });
  const pulse = encodeMarketPulse({
    temperature: 0.6, momentum: 0.2, turbulence: 0.1, density: 0.2, richness: 0.5, arousal: 0.5,
  } as any);
  for (let i = 0; i < 20; i++) { for (const s of pulse) b.inject(s); b.advance(50); }
  const snap = b.snapshot();
  const nm = snap.neuromod;
  const ids = b.connectome.byKind.modulatory;
  const half = Math.floor(ids.length / 2);
  const meanOf = (list: readonly number[]) => {
    if (list.length === 0) return 0;
    let sum = 0;
    for (const id of list) {
      const r = snap.firingRates[id];
      if (typeof r === "number" && Number.isFinite(r)) sum += r;
    }
    return sum / list.length;
  };
  const expectedDa = meanOf(ids.slice(0, half));
  const expectedOa = meanOf(ids.slice(half));
  assert.ok(ids.length > 0, "the seeded connectome has a modulatory population to read");
  assert.ok(Math.abs(nm.daHz - expectedDa) < 1e-4, `daHz is the live DA half's mean rate (${nm.daHz} ≈ ${expectedDa})`);
  assert.ok(Math.abs(nm.oaHz - expectedOa) < 1e-4, `oaHz is the live OA half's mean rate (${nm.oaHz} ≈ ${expectedOa})`);
  // And the published normalized pair is exactly the derived one.
  const ref = NEUROMOD_CONFIG.refHz;
  assert.ok(Math.abs(nm.dopamine - Math.min(1, Math.max(0, nm.daHz / ref))) < 1e-9);
  assert.ok(Math.abs(nm.octopamine - Math.min(1, Math.max(0, nm.oaHz / ref))) < 1e-9);
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
  // empty ⇒ two empty halves ⇒ zero DA/OA (raw + normalized); the learning-rate gate falls back to its floor (not 0)
  const empty = computeNeuromod(new Float32Array(0), []);
  assert.equal(empty.dopamine, 0);
  assert.equal(empty.octopamine, 0);
  assert.equal(empty.daHz, 0);
  assert.equal(empty.oaHz, 0);
  assert.ok(Math.abs(empty.learningRateGate - NEUROMOD_CONFIG.lrGateFloor) < 1e-9);
});

test("computeNeuromod is NaN-safe: a poisoned rate never yields a NaN scalar", () => {
  const ids = [0, 1, 2, 3];
  const rates = new Float32Array(4);
  rates[0] = NaN; rates[1] = 5; rates[2] = 5; rates[3] = 5;
  const s = computeNeuromod(rates, ids);
  for (const k of ["dopamine", "octopamine", "learningRateGate", "daHz", "oaHz"] as const) {
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

  // Fixture keeps the published identity honest: raw Hz = normalized × refHz (40).
  const extreme: NeuromodState = { dopamine: 1, octopamine: 1, learningRateGate: 1, daHz: 40, oaHz: 40 };
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
  const hi: NeuromodState = { dopamine: 0.9, octopamine: 0.95, learningRateGate: 0.9, daHz: 36, oaHz: 38 };
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
      m, sensory, 1000, 0.5, flatBands, { dopamine: 0.5, octopamine: oa, learningRateGate: 0.5, daHz: 20, oaHz: oa * 40 },
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
      m, sensory, 1000, 0.5, flatBands, { dopamine: da, octopamine: 0.5, learningRateGate: da, daHz: da * 40, oaHz: 20 },
    );
  assert.equal(dec(0).arousal, dec(1).arousal, "arousal is a function of octopamine only");
});

test("GATING ON: the neuromod read-out is still surfaced on the behaviour", () => {
  const m = motor({ leg_left: 0.2, leg_right: 0.2, wing: 0.03, proboscis: 0.1, abdomen: 0.02 });
  const nm: NeuromodState = { dopamine: 0.3, octopamine: 0.7, learningRateGate: 0.4, daHz: 12, oaHz: 28 };
  const b = new MotorDecoder({}, { neuromodGating: true }).decode(m, sensory, 10, 0.5, flatBands, nm);
  assert.deepEqual(b.neuromod, nm);
});
