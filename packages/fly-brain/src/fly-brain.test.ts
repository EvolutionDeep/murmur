import test from "node:test";
import assert from "node:assert/strict";
import { FlyBrain, LifNetwork } from "./index.js";
import type { NeuronMeta } from "./types.js";

// Small, fast options so the archive tests stay quick (production runs 10,800–30,800 neurons).
const tiny = { seed: 7, nSensory: 12, nInterL1: 16, nInterL2: 16, nModulatory: 6, nMotorPerChannel: 3, density: 0.08 };

// net/noiseState are private by design (the public surface is advance/serialize/readAllMotor);
// archive-format tests need to look inside, so we reach through a typed escape hatch.
const internals = (b: FlyBrain) => b as unknown as { net: LifNetwork; noiseState: number };

function neuron(o: Partial<NeuronMeta> = {}): NeuronMeta {
  return {
    id: 0, layer: "sensory", vRest: -65, vThresh: -50, vReset: -70, tau: 10, refractory: 2,
    ...o,
  } as NeuronMeta;
}

test("compact (v4) round-trip is bit-exact — the runtime state is already float32", () => {
  const meta = [neuron({ id: 0 }), neuron({ id: 1 })];
  const net = new LifNetwork(meta, [{ pre: 0, post: 1, w: 0.3 }]);
  net.injectCurrent(0, 50);
  for (let i = 0; i < 30; i++) net.tick(1);

  const packed = net.toCompact();
  const clone = new LifNetwork(meta, [{ pre: 0, post: 1, w: 0.3 }]);
  assert.equal(clone.fromCompact(packed), true, "size matches ⇒ restore accepted");
  assert.equal(clone.t, net.t);
  assert.equal(clone.step, net.step);
  assert.deepEqual(Array.from(clone.V), Array.from(net.V), "membrane restored exactly");
  assert.deepEqual(Array.from(clone.firingRate), Array.from(net.firingRate));
  assert.deepEqual(Array.from(clone.adaptation), Array.from(net.adaptation));

  net.tick(1); clone.tick(1);
  assert.deepEqual(Array.from(clone.V), Array.from(net.V), "continues identically after restore");
});

test("fromCompact rejects a differently-sized archive without touching state", () => {
  const meta = [neuron({ id: 0 }), neuron({ id: 1 })];
  const net = new LifNetwork(meta, []);
  net.injectCurrent(0, 50);
  for (let i = 0; i < 5; i++) net.tick(1);
  const packed = net.toCompact();

  const other = new LifNetwork([neuron({ id: 0 })], []);   // N=1 vs N=2
  assert.equal(other.fromCompact(packed), false, "length mismatch ⇒ refused");
  assert.equal(other.t, 0, "clock untouched");
  assert.equal(other.step, 0, "step untouched");
});

test("FlyBrain.serialize is v4 compact and deserializes back to the same state", () => {
  const brain = new FlyBrain(tiny);
  brain.advance(40);
  const s = brain.serialize();
  const parsed = JSON.parse(s);
  assert.equal(parsed.version, 4, "archive is marked v4");
  assert.equal(typeof parsed.net.b64, "string", "electrical state is one base64 blob");
  assert.equal(Array.isArray(parsed.net.V), false, "no decimal float arrays in v4");

  const back = FlyBrain.deserialize(s, tiny);
  assert.equal(back.t, brain.t, "clock restored");
  assert.equal(back.step, brain.step, "step restored");
  assert.equal(internals(back).noiseState, internals(brain).noiseState, "noise rng state restored");
  assert.deepEqual(Array.from(internals(back).net.V), Array.from(internals(brain).net.V), "membranes restored exactly");
});

test("deserialize still reads a legacy v3 text archive (migration path)", () => {
  const brain = new FlyBrain(tiny);
  brain.advance(30);
  // Reconstruct the exact v3 shape the previous serialize() wrote.
  const v3 = JSON.stringify({ version: 3, net: internals(brain).net.toJSON(), noiseState: internals(brain).noiseState });

  const back = FlyBrain.deserialize(v3, tiny);
  assert.equal(back.t, brain.t, "clock restored from v3");
  assert.equal(back.step, brain.step, "step restored from v3");
  assert.deepEqual(Array.from(internals(back).net.V), Array.from(internals(brain).net.V), "membranes restored from v3");
});

test("a v4 archive from a differently-sized connectome wakes the brain fresh", () => {
  const brain = new FlyBrain(tiny);
  brain.advance(25);
  const s = brain.serialize();

  const bigger = { ...tiny, nInterL1: 24 };
  const back = FlyBrain.deserialize(s, bigger);
  assert.equal(back.t, 0, "fresh clock (layout no longer lines up)");
  assert.equal(back.step, 0, "fresh step");
  assert.equal(internals(back).noiseState, internals(brain).noiseState, "noise state still carries (it is size-independent)");
});

test("the compact form is strictly smaller than the v3 text form", () => {
  const brain = new FlyBrain(tiny);
  brain.advance(60);   // run a while so floats carry real decimals, like a live archive
  const v4 = brain.serialize().length;
  const v3 = JSON.stringify({ version: 3, net: internals(brain).net.toJSON(), noiseState: internals(brain).noiseState }).length;
  // base64 inflates raw bytes by 4/3, so the win comes from not spelling floats out in decimal.
  // On this tiny network many values are still short defaults ("-65", "0") so the ratio is ~0.77;
  // at production scale (10,800+ neurons, fully decimal floats) it approaches ~0.35.
  assert.ok(v4 < v3 * 0.8, `v4 ${v4}B is <80% of v3 ${v3}B`);
});
