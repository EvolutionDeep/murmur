// Motor-decoder tests — the read-out that turns motor-neuron firing into behaviour + drives.
//
// The decoder is the seam between the spiking network and everything downstream (the frontend render
// AND the agent economy's intent). These tests pin its two-layer contract: a market-temperature
// COLLECTIVE base (HOT → aroused/dispersed, COLD → huddled/restful) modulated by each fly's
// POPULATION-RELATIVE standing, with hysteresis so the behavioural state does not flicker on noise.

import test from "node:test";
import assert from "node:assert/strict";

import {
  MotorDecoder,
  readRawDrives,
  computeBands,
  neuralFingerprint,
  REF_BANDS,
  type PopulationBands,
} from "./motor-decoder.js";
import type { MotorChannel, MotorOutput } from "./types.js";

const CH: MotorChannel[] = ["leg_left", "leg_right", "wing", "proboscis", "abdomen"];

/** Build a full 5-channel motor output from a sparse {channel: normalized} map. */
function motor(vals: Partial<Record<MotorChannel, number>>): MotorOutput[] {
  return CH.map((channel) => {
    const normalized = vals[channel] ?? 0;
    return { channel, normalized, firingRate: normalized * 50, spikes: Math.round(normalized * 10) };
  });
}

const flatBands: PopulationBands = { arousal: [0, 1], cohesion: [0, 1], rest: [0, 1], turnAbs: 1 };

test("readRawDrives maps motor channels to the documented biological drives", () => {
  const raw = readRawDrives(motor({ leg_left: 0.6, leg_right: 0.2, wing: 0.1, proboscis: 0.4, abdomen: 0.3 }));
  assert.ok(Math.abs(raw.arousal - (0.5 * (0.6 + 0.2) + 0.1)) < 1e-9, "arousal = ½(legs)+wing");
  assert.ok(Math.abs(raw.turn - (0.6 - 0.2)) < 1e-9, "turn = leg_left − leg_right");
  assert.equal(raw.cohesion, 0.4, "cohesion = proboscis (appetitive approach)");
  assert.equal(raw.rest, 0.3, "rest = abdomen");
});

test("HOT regime raises arousal and suppresses cohesion + rest (the collective base)", () => {
  const d = new MotorDecoder();
  // Neutral individual standing (every drive at the band midpoint) isolates the COLLECTIVE base = f(T).
  const mid = motor({ leg_left: 0.5, leg_right: 0.5, proboscis: 0.5, abdomen: 0.5 });
  const hot = d.decode(mid, [], 0, 0.95, flatBands);
  const cold = new MotorDecoder().decode(mid, [], 0, 0.05, flatBands);

  assert.ok(hot.arousal > cold.arousal, "HOT is more aroused than COLD");
  assert.ok(hot.cohesion < cold.cohesion, "HOT is less cohesive (dispersed) than COLD");
  assert.ok(hot.rest < cold.rest, "HOT is less restful than COLD");
  assert.ok(hot.arousal > 0.8, "a hot swarm is strongly aroused");
  assert.ok(cold.cohesion > 0.8, "a cold swarm huddles");
});

test("individuals spread around the collective base by their population-relative standing", () => {
  const d = new MotorDecoder();
  // Same temperature, same channel shape — only the raw magnitude (hence relative standing) differs.
  const top = d.decode(motor({ leg_left: 0.95, leg_right: 0.95 }), [], 0, 0.5, flatBands);
  const bottom = new MotorDecoder().decode(motor({ leg_left: 0.05, leg_right: 0.05 }), [], 0, 0.5, flatBands);
  assert.ok(top.arousal > bottom.arousal, "the more-active individual reads more aroused at equal temperature");
  // A flat band (no population spread) must yield neutral ½ standing, not an arbitrary value.
  const neutral = new MotorDecoder().decode(
    motor({ leg_left: 0.5, leg_right: 0.5 }), [], 0, 0.5,
    { arousal: [0.3, 0.3], cohesion: [0, 0], rest: [0, 0], turnAbs: 0 },
  );
  assert.ok(Math.abs(neutral.arousal - 0.5) < 1e-6, "flat band ⇒ neutral standing ⇒ drive = base");
});

test("all decoded drives stay clamped to [0,1] and turnBias to [−1,1]", () => {
  const d = new MotorDecoder();
  for (const T of [0, 0.5, 1]) {
    for (const v of [0, 0.5, 1]) {
      const b = d.decode(motor({ leg_left: v, leg_right: 1 - v, wing: v, proboscis: v, abdomen: v }), [], 0, T, flatBands);
      for (const x of [b.arousal, b.cohesion, b.rest, b.wingbeat]) {
        assert.ok(x >= 0 && x <= 1, `drive ${x} within [0,1]`);
      }
      assert.ok(b.turnBias >= -1 && b.turnBias <= 1, `turnBias ${b.turnBias} within [−1,1]`);
      assert.equal(b.wingbeat, b.arousal, "wingbeat mirrors arousal");
    }
  }
});

test("state selection follows the regime + relative standing, committed through hysteresis", () => {
  const commit = (T: number, arousalRaw: number) => {
    const d = new MotorDecoder(); // hysteresisSteps = 2 by default
    let out = d.decode(motor({ leg_left: arousalRaw, leg_right: arousalRaw }), [], 0, T, flatBands);
    out = d.decode(motor({ leg_left: arousalRaw, leg_right: arousalRaw }), [], 0, T, flatBands);
    return out.state;
  };
  assert.equal(commit(0.95, 0.9), "AGITATE", "HOT + active ⇒ AGITATE");
  assert.equal(commit(0.95, 0.05), "EXPLORE", "HOT + sluggish minority ⇒ EXPLORE");
  assert.equal(commit(0.05, 0.9), "AGGREGATE", "COLD + active ⇒ AGGREGATE (huddle)");
  assert.equal(commit(0.05, 0.05), "REST", "COLD + stillest minority ⇒ REST");
});

test("hysteresis holds the last state against a single-tick blip", () => {
  const d = new MotorDecoder();
  const hot = motor({ leg_left: 0.9, leg_right: 0.9 });
  const cold = motor({ leg_left: 0.02, leg_right: 0.02 });
  d.decode(hot, [], 0, 0.95, flatBands);
  const committed = d.decode(hot, [], 0, 0.95, flatBands); // AGITATE now committed
  assert.equal(committed.state, "AGITATE");
  // One contradictory tick must NOT flip the committed state (needs hysteresisSteps consecutive).
  const blip = d.decode(cold, [], 0, 0.95, flatBands);
  assert.equal(blip.state, "AGITATE", "a single blip does not flicker the state");
});

test("computeBands returns robust 10–90 percentiles and the max |turn|", () => {
  const all = Array.from({ length: 11 }, (_, i) => ({
    arousal: i / 10,        // 0.0 .. 1.0
    cohesion: 0.5,
    rest: 0.2,
    turn: (i - 5) / 5,      // −1 .. +1
  }));
  const b = computeBands(all);
  assert.equal(b.arousal[0], 0.1, "10th percentile of arousal");
  assert.equal(b.arousal[1], 0.9, "90th percentile of arousal");
  assert.equal(b.turnAbs, 1, "turnAbs is the population max |turn|");
  // Empty population must not blow up.
  const empty = computeBands([]);
  assert.deepEqual(empty.arousal, [0, 0]);
  assert.equal(empty.turnAbs, 0);
});

test("standalone decoding falls back to REF_BANDS and stays in range", () => {
  const d = new MotorDecoder();
  const b = d.decode(motor({ leg_left: 0.4, leg_right: 0.1, proboscis: 0.15, abdomen: 0.05 }), [], 1234);
  assert.equal(REF_BANDS.arousal[0], 0, "reference bands are the documented HOT-regime maxima");
  assert.ok(b.arousal >= 0 && b.arousal <= 1);
  assert.ok(b.neuralFingerprint.length === 16, "fingerprint is a 16-hex-char identity");
});

test("neuralFingerprint is deterministic and sensitive to motor state + sim time", () => {
  const m = motor({ leg_left: 0.5, leg_right: 0.5, wing: 0.3 });
  const f1 = neuralFingerprint(m, 1000);
  const f2 = neuralFingerprint(m, 1000);
  assert.equal(f1, f2, "same input ⇒ same fingerprint (reproducible identity)");
  assert.notEqual(f1, neuralFingerprint(m, 1001), "a different sim time changes the fingerprint");
  assert.notEqual(f1, neuralFingerprint(motor({ leg_left: 0.9, leg_right: 0.5, wing: 0.3 }), 1000), "different motor ⇒ different fingerprint");
});
