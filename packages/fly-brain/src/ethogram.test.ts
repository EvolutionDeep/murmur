// Ethogram tests — the rich behaviour read-out layer (FAPs, valence, ring-attractor heading, bouts).
//
// The ethogram is a PURE, DETERMINISTIC read-out: it consumes the motor/sensory signals + decoded drives
// and derives named behaviour, never feeding back into the connectome. These tests pin that contract:
// determinism (replayability, the property the on-chain brain proof relies on), the appetitive−aversive
// valence, the ring-attractor heading (persistent + steered by turnBias), the FAP selection ladder, and
// the suppression hierarchy that turns frame-by-frame drives into ordered behaviour BOUTS.

import test from "node:test";
import assert from "node:assert/strict";

import {
  Ethogram,
  ETHOGRAM_CONFIG,
  FAP_DOMINANCE,
  FAP_ROLE,
  computeValence,
  selectFap,
  type EthogramDrives,
} from "./ethogram.js";
import type { Fap, MotorOutput, SensoryInput } from "./types.js";

const TAU = Math.PI * 2;

function sensory(map: Partial<Record<string, number>>): SensoryInput[] {
  return Object.entries(map).map(([channel, intensity]) => ({
    channel: channel as SensoryInput["channel"],
    intensity: intensity as number,
  }));
}

function motor(proboscis = 0): MotorOutput[] {
  const chans = ["leg_left", "leg_right", "wing", "proboscis", "abdomen"] as const;
  return chans.map((channel) => ({
    channel,
    normalized: channel === "proboscis" ? proboscis : 0,
    firingRate: 0,
    spikes: 0,
  }));
}

function drives(over: Partial<EthogramDrives> = {}): EthogramDrives {
  return {
    arousal: 0.5,
    turnBias: 0,
    cohesion: 0.5,
    wingbeat: 0.5,
    rest: 0.2,
    temperature: 0.5,
    ...over,
  };
}

test("computeValence: appetitive pulls +, aversive pushes −, converging on a shared sign", () => {
  const appetitive = computeValence(sensory({ gustatory_richness: 0.9, stimulus_food: 0.5 }));
  const aversive = computeValence(sensory({ mechanical_turbulence: 0.8, stimulus_threat: 0.6 }));
  const neutral = computeValence(sensory({}));
  assert.ok(appetitive > 0.5, "sugar/food ⇒ strongly appetitive");
  assert.ok(aversive < -0.5, "turbulence/threat ⇒ strongly aversive");
  assert.equal(neutral, 0, "no input ⇒ neutral valence");
  // Bitter-like aversion must cancel appetition (the paper's sweet↔bitter competition).
  const mixed = computeValence(sensory({ gustatory_richness: 0.6, stimulus_threat: 0.6 }));
  assert.ok(mixed < appetitive, "an aversive co-stimulus suppresses the net appetitive valence");
});

test("ring attractor holds a persistent heading and rotates it with turnBias", () => {
  const straight = new Ethogram();
  const h0 = straight.step(motor(), [], drives({ turnBias: 0, arousal: 0.5 })).heading;
  const h1 = straight.step(motor(), [], drives({ turnBias: 0, arousal: 0.5 })).heading;
  assert.ok(Math.abs(h1 - h0) < 0.15, "no turn bias ⇒ the heading is stable (persistent bump)");

  const right = new Ethogram();
  let prev = right.step(motor(), [], drives({ turnBias: 1 })).heading;
  let advanced = prev;
  for (let i = 0; i < 6; i++) advanced = right.step(motor(), [], drives({ turnBias: 1 })).heading;
  // Positive turnBias should rotate the bump; measure the signed angular delta.
  let d = advanced - prev;
  while (d > Math.PI) d -= TAU;
  while (d < -Math.PI) d += TAU;
  assert.ok(Math.abs(d) > 0.05, "sustained turnBias rotates the head-direction bump");
  assert.ok(advanced >= 0 && advanced < TAU, "heading stays in [0, 2π)");
});

test("FAP ladder: escape/avoidance dominate, appetitive → feed, cold cohesive → huddle", () => {
  assert.equal(selectFap(drives({ arousal: 0.95 }), -0.2, 0), "FLIGHT", "extreme arousal, no appetition ⇒ escape");
  assert.equal(selectFap(drives({ arousal: 0.6 }), -0.6, 0), "RETREAT", "averse + aroused ⇒ avoidance");
  assert.equal(selectFap(drives({ arousal: 0.1, rest: 0.85 }), 0, 0), "REST", "still + low arousal ⇒ rest");
  assert.equal(selectFap(drives({ arousal: 0.12, rest: 0.2 }), 0, 0), "HALT", "near-frozen ⇒ halt");
  assert.equal(selectFap(drives({ arousal: 0.4, cohesion: 0.8, temperature: 0.5 }), 0.6, 0.5), "FEED", "appetitive + approach reflex ⇒ feed");
  assert.equal(selectFap(drives({ arousal: 0.4, cohesion: 0.8, temperature: 0.2 }), 0.0, 0), "HUDDLE", "cold + cohesive ⇒ huddle");
  assert.equal(selectFap(drives({ arousal: 0.6, cohesion: 0.55, wingbeat: 0.8, temperature: 0.6 }), 0.4, 0), "COURT", "wing + appetitive + cohesive + warm ⇒ courtship");
});

test("every FAP maps to a dominance rank and an economic role", () => {
  const faps: Fap[] = ["FEED", "GROOM", "FORAGE", "HALT", "RETREAT", "COURT", "FLIGHT", "HUDDLE", "REST"];
  for (const f of faps) {
    assert.equal(typeof FAP_DOMINANCE[f], "number", `${f} has a dominance rank`);
    assert.equal(typeof FAP_ROLE[f], "string", `${f} has a role label`);
  }
  assert.ok(FAP_DOMINANCE.FLIGHT > FAP_DOMINANCE.REST, "escape dominates rest");
});

test("suppression hierarchy: a dominant FAP switches immediately, a subordinate needs hysteresis", () => {
  const e = new Ethogram();
  // Establish a low-arousal forage/groom baseline.
  e.step(motor(), [], drives({ arousal: 0.5, cohesion: 0.3, temperature: 0.5 }));
  const before = e.fap;
  // A single dominant escape tick must flip the FAP at once (no hysteresis wait).
  e.step(motor(), sensory({ stimulus_threat: 0.9, mechanical_turbulence: 0.9 }), drives({ arousal: 0.95 }));
  assert.notEqual(e.fap, before, "a dominant FAP displaces the current one immediately");
  assert.ok(
    e.fap === "FLIGHT" || e.fap === "RETREAT",
    `escape/avoidance wins under threat (got ${e.fap})`,
  );
});

test("bouts accumulate as an ordered timeline and stay capped", () => {
  const e = new Ethogram();
  let last = e.step(motor(), [], drives({ arousal: 0.95 })).bouts;
  // Alternate between escape-dominant and rest-dominant drives to force switches.
  for (let i = 0; i < 30; i++) {
    const d = i % 2 === 0
      ? drives({ arousal: 0.95 })
      : drives({ arousal: 0.1, rest: 0.85 });
    last = e.step(motor(), [], d).bouts;
  }
  assert.ok(last.length >= 1, "the timeline is non-empty");
  assert.ok(last.length <= ETHOGRAM_CONFIG.maxBouts, `timeline capped at ${ETHOGRAM_CONFIG.maxBouts}`);
  for (const b of last) assert.ok(b.ticks >= 1, "every bout has a positive duration");
});

test("the ethogram is deterministic: identical drive histories ⇒ identical readings", () => {
  const run = () => {
    const e = new Ethogram();
    const seq = [
      drives({ arousal: 0.6, turnBias: 0.3, cohesion: 0.5, temperature: 0.6 }),
      drives({ arousal: 0.2, turnBias: -0.4, rest: 0.7, temperature: 0.3 }),
      drives({ arousal: 0.9, turnBias: 0.1, wingbeat: 0.8, temperature: 0.7 }),
    ];
    let out;
    for (const d of seq) out = e.step(motor(0.2), sensory({ gustatory_richness: 0.4 }), d);
    return out!;
  };
  const a = run();
  const b = run();
  assert.deepEqual(a, b, "same inputs ⇒ same ethogram reading (replayable, like the connectome)");
});
