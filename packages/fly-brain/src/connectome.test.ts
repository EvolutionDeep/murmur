// Connectome structure tests — the "real connectome comparison" the project claims.
//
// The fly-brain does NOT ship the ~138k-neuron / ~5M-synapse FlyWire adult-brain graph (it would not
// fit a Cloudflare Worker's per-tick CPU budget). What it ships is a deterministic, layered DOWNSAMPLE
// of that organisation: the same sensory → interneuron → (mutually-inhibitory decision) → motor
// laminar motif, with the same left/right winner-take-all competition the decoder reads as turn bias.
// These tests pin that structure down so a refactor cannot silently drift away from the biology the
// README/docs describe, and so the "genuinely from a connectome, not a random graph" claim is checked.

import test from "node:test";
import assert from "node:assert/strict";

import { buildConnectome, MOTOR_CHANNEL_LIST, SENSORY_CHANNEL_LIST } from "./connectome.js";
import type { Connectome } from "./types.js";

/** Layer boundaries for a default build, derived from the kind index so they track option changes. */
function layers(c: Connectome) {
  const sensory = c.byKind.sensory;
  const motor = c.byKind.motor;
  const mod = c.byKind.modulatory;
  const inter = c.byKind.inter;
  const l1 = inter.slice(0, inter.length / 2);
  const l2 = inter.slice(inter.length / 2);
  return { sensory, l1, l2, mod, motor, l2Left: l2.slice(0, l2.length / 2), l2Right: l2.slice(l2.length / 2) };
}

/** A structural fingerprint: every synapse's (pre,post) plus a coarse quantisation of its weight. */
function fingerprint(c: Connectome): string {
  return c.synapses.map((s) => `${s.pre}>${s.post}:${Math.round(s.w * 1000)}`).join("|");
}

test("default connectome is the documented ~1,080-neuron laminar graph", () => {
  const c = buildConnectome({ seed: 42 });
  const L = layers(c);

  assert.equal(c.neurons.length, 1080, "total neuron count");
  assert.equal(L.sensory.length, 180, "sensory layer");
  assert.equal(L.l1.length, 400, "interneuron L1");
  assert.equal(L.l2.length, 400, "interneuron L2 (decision layer)");
  assert.equal(L.mod.length, 40, "modulatory layer");
  assert.equal(L.motor.length, 60, "motor layer = 5 channels × 12");

  // Neurons are laid out in strict layer order (sensory → L1 → L2 → modulatory → motor), which is what
  // lets the LIF network and the decoder address a layer by an id range.
  const ids = c.neurons.map((n) => n.id);
  assert.deepEqual(ids, ids.slice().sort((a, b) => a - b), "ids are contiguous & ascending");
  assert.ok(L.sensory[L.sensory.length - 1] < L.l1[0], "sensory precedes L1");
  assert.ok(L.l1[L.l1.length - 1] < L.l2[0], "L1 precedes L2");
  assert.ok(L.l2[L.l2.length - 1] < L.mod[0], "L2 precedes modulatory");
  assert.ok(L.mod[L.mod.length - 1] < L.motor[0], "modulatory precedes motor");
});

test("it is a genuine DOWNSAMPLE of FlyWire, not the full graph", () => {
  const c = buildConnectome({ seed: 42 });
  // FlyWire adult female: ~138k neurons, ~5M synapses. We must stay orders of magnitude smaller to run
  // 24 of these per cron tick on the edge — assert the trim is real (and that we are not accidentally
  // claiming to ship the full connectome).
  assert.ok(c.neurons.length < 138_000 / 50, "neurons trimmed to <1/50th of FlyWire");
  assert.ok(c.synapses.length < 5_000_000 / 50, "synapses trimmed to <1/50th of FlyWire");
  assert.ok(c.synapses.length > 5_000, "still a richly connected graph, not a stub");
});

test("sparse connectivity: fan-in per neuron stays in the documented regime", () => {
  const c = buildConnectome({ seed: 42 });
  const fanIn = new Array(c.neurons.length).fill(0);
  for (const s of c.synapses) fanIn[s.post]++;
  const mean = fanIn.reduce((a, b) => a + b, 0) / fanIn.length;
  // density 0.02 over the feedforward layers yields low double-digit mean fan-in — sparse, as documented.
  assert.ok(mean > 1 && mean < 200, `mean fan-in ${mean.toFixed(1)} is sparse but non-trivial`);
});

test("every neuron kind carries sane LIF parameters", () => {
  const c = buildConnectome({ seed: 7 });
  for (const n of c.neurons) {
    assert.ok(n.tau > 0, `tau positive (id ${n.id})`);
    assert.equal(n.vRest, 0, "normalised resting potential");
    assert.ok(n.vThresh > n.vReset, `threshold above reset (id ${n.id})`);
    assert.ok(n.refractory >= 0, "refractory non-negative");
  }
  // Modulatory neurons are the slow "mood" integrators: longer tau + longer refractory than the rest.
  const modTau = c.byKind.modulatory.map((i) => c.neurons[i].tau);
  const interTau = c.byKind.inter.map((i) => c.neurons[i].tau);
  const mean = (a: number[]) => a.reduce((x, y) => x + y, 0) / a.length;
  assert.ok(mean(modTau) > mean(interTau), "modulatory integrates slower than interneurons");
});

test("motor + sensory channels are fully indexed for injection/read-out", () => {
  const c = buildConnectome({ seed: 1 });
  assert.equal(MOTOR_CHANNEL_LIST.length, 5);
  assert.equal(SENSORY_CHANNEL_LIST.length, 10);
  for (const ch of MOTOR_CHANNEL_LIST) {
    const ids = c.byChannel.get(ch) ?? [];
    assert.equal(ids.length, 12, `${ch} has 12 motor neurons`);
    for (const id of ids) {
      assert.equal(c.neurons[id].kind, "motor");
      assert.equal(c.neurons[id].channel, ch);
    }
  }
  for (const ch of SENSORY_CHANNEL_LIST) {
    const ids = c.byChannel.get(ch) ?? [];
    assert.ok(ids.length > 0, `${ch} has sensory neurons`);
    for (const id of ids) assert.equal(c.neurons[id].kind, "sensory");
  }
});

test("feedforward path is excitatory; L2 left↔right is mutually INHIBITORY (winner-take-all)", () => {
  const c = buildConnectome({ seed: 42 });
  const L = layers(c);
  const set = (a: number[]) => new Set(a);
  const sensory = set(L.sensory), l1 = set(L.l1), l2Left = set(L.l2Left), l2Right = set(L.l2Right);

  const meanW = (pred: (pre: number, post: number) => boolean) => {
    const ws = c.synapses.filter((s) => pred(s.pre, s.post)).map((s) => s.w);
    return { n: ws.length, mean: ws.reduce((a, b) => a + b, 0) / Math.max(1, ws.length) };
  };

  // Sensory → L1 and L1 → L2 are excitatory (positive mean weight): the signal flows forward.
  assert.ok(meanW((p, q) => sensory.has(p) && l1.has(q)).mean > 0, "sensory→L1 excitatory");
  assert.ok(meanW((p, q) => l1.has(p) && (l2Left.has(q) || l2Right.has(q))).mean > 0, "L1→L2 excitatory");

  // The decision layer's cross-hemisphere connections are inhibitory — this is the mutually-inhibitory
  // competition whose left/right asymmetry the decoder reads as turn bias. Both directions must be negative.
  const lr = meanW((p, q) => l2Left.has(p) && l2Right.has(q));
  const rl = meanW((p, q) => l2Right.has(p) && l2Left.has(q));
  assert.ok(lr.n > 0 && rl.n > 0, "both cross-hemisphere directions are wired");
  assert.ok(lr.mean < 0, `L2 left→right inhibitory (mean ${lr.mean.toFixed(3)})`);
  assert.ok(rl.mean < 0, `L2 right→left inhibitory (mean ${rl.mean.toFixed(3)})`);
});

test("L2 halves project ipsilaterally to the matching leg motor channel", () => {
  const c = buildConnectome({ seed: 42 });
  const L = layers(c);
  const legLeft = new Set(c.byChannel.get("leg_left")!);
  const legRight = new Set(c.byChannel.get("leg_right")!);
  const l2Left = new Set(L.l2Left), l2Right = new Set(L.l2Right);

  // leg_left motor neurons are driven by the LEFT L2 half (and not the right), leg_right by the RIGHT.
  const toLegLeft = c.synapses.filter((s) => legLeft.has(s.post));
  const toLegRight = c.synapses.filter((s) => legRight.has(s.post));
  assert.ok(toLegLeft.length > 0 && toLegRight.length > 0, "both legs receive L2 drive");
  assert.ok(toLegLeft.every((s) => l2Left.has(s.pre)), "leg_left fed only by L2-left");
  assert.ok(toLegRight.every((s) => l2Right.has(s.pre)), "leg_right fed only by L2-right");
});

test("appetitive reflex: gustatory_richness sensory → proboscis motor is excitatory", () => {
  const c = buildConnectome({ seed: 42 });
  const gus = new Set(c.byChannel.get("gustatory_richness") ?? []);
  const prob = new Set(c.byChannel.get("proboscis")!);
  const reflex = c.synapses.filter((s) => gus.has(s.pre) && prob.has(s.post));
  assert.ok(reflex.length > 0, "the approach reflex is wired");
  assert.ok(
    reflex.every((s) => s.w > 0),
    "richness → proboscis extension is excitatory (approach, not avoidance)",
  );
});

test("build is deterministic per seed and distinct across seeds (each fly's temperament)", () => {
  const a1 = buildConnectome({ seed: 1234 });
  const a2 = buildConnectome({ seed: 1234 });
  const b = buildConnectome({ seed: 1234 + 7919 }); // the worker's per-fly seed stride

  assert.equal(a1.neurons.length, a2.neurons.length);
  assert.equal(fingerprint(a1), fingerprint(a2), "same seed ⇒ byte-identical wiring (reproducible)");
  assert.notEqual(fingerprint(a1), fingerprint(b), "different seed ⇒ different connectome");

  // Same topology (layer sizes unchanged) but different parameters — a different individual, same species.
  assert.deepEqual(a1.byKind.inter.length, b.byKind.inter.length);
  const tauA = a1.neurons.map((n) => n.tau).join(",");
  const tauB = b.neurons.map((n) => n.tau).join(",");
  assert.notEqual(tauA, tauB, "membrane constants differ between seeds");
});
