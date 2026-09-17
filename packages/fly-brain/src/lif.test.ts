// LIF network dynamics tests — the spiking core every fly's decisions emerge from.
//
// These check the biophysics the docs promise: leaky integration toward rest, threshold crossing →
// spike → reset, a refractory blackout, weighted synaptic propagation between layers, and — critically
// — spike-frequency adaptation (SFA), the fatigue current added specifically so the mutually-inhibitory
// L2 winner-take-all ALTERNATES instead of hard-latching one motor leg at max rate forever.

import test from "node:test";
import assert from "node:assert/strict";

import { LifNetwork } from "./lif.js";
import type { NeuronMeta, Synapse } from "./types.js";

/** A single, hand-tuned neuron so dynamics can be asserted exactly (no connectome noise). */
function neuron(over: Partial<NeuronMeta> = {}): NeuronMeta {
  return { id: 0, kind: "sensory", channel: null, tau: 10, vRest: 0, vThresh: 1, vReset: -0.5, refractory: 3, ...over };
}

test("an undriven neuron sits at rest and never spikes", () => {
  const net = new LifNetwork([neuron()], []);
  for (let i = 0; i < 200; i++) net.tick(1);
  assert.equal(net.spiking[0], 0, "no spontaneous spike without drive");
  assert.ok(Math.abs(net.V[0] - 0) < 1e-6, "membrane stays at vRest");
  assert.equal(net.t, 200, "clock advanced");
});

test("a suprathreshold drive spikes the neuron and resets its membrane", () => {
  const net = new LifNetwork([neuron()], []);
  net.injectCurrent(0, 50); // dV = (0 + 50)·(1/10) = +5 ≫ vThresh=1 on the first step
  net.tick(1);
  assert.equal(net.spiking[0], 1, "spiked on threshold crossing");
  assert.equal(net.V[0], -0.5, "membrane reset to vReset after the spike");
  assert.equal(net.lastSpikeT[0], 0, "spike time recorded");
});

test("the membrane leaks back toward rest when drive stops", () => {
  const net = new LifNetwork([neuron({ refractory: 0 })], []);
  net.V[0] = 0.8; // sub-threshold, no spike
  const v0 = net.V[0];
  net.tick(1);
  assert.ok(net.V[0] < v0, "V decays toward vRest (=0) with no input");
  assert.ok(net.V[0] > 0, "leak is gradual, not an instant snap");
  for (let i = 0; i < 500; i++) net.tick(1);
  assert.ok(Math.abs(net.V[0]) < 1e-3, "fully leaked to rest");
});

test("a neuron is silent through its refractory window", () => {
  const net = new LifNetwork([neuron({ refractory: 5 })], []);
  net.injectCurrent(0, 50);
  net.tick(1); // spikes at t=0
  assert.equal(net.spiking[0], 1);
  // Keep hammering it: during the refractory window (t=1..4) it must stay clamped at vReset, no spike.
  let refractorySpikes = 0;
  for (let i = 0; i < 4; i++) {
    net.injectCurrent(0, 50);
    net.tick(1);
    refractorySpikes += net.spiking[0];
    assert.equal(net.V[0], -0.5, "held at vReset while refractory");
  }
  assert.equal(refractorySpikes, 0, "no firing during the refractory blackout");
});

test("a presynaptic spike delivers weighted current to the postsynaptic neuron", () => {
  const meta = [neuron({ id: 0 }), neuron({ id: 1, tau: 15 })];
  const syn: Synapse[] = [{ pre: 0, post: 1, w: 0.4 }];
  const net = new LifNetwork(meta, syn);

  net.injectCurrent(0, 50);
  net.tick(1); // neuron 0 spikes; its spike is buffered for the NEXT step
  assert.equal(net.spiking[0], 1);
  assert.equal(net.Isyn[1], 0, "no synaptic current yet (double-buffered one-step delay)");

  net.tick(1); // now neuron 1 receives w·gain from the previous step's spike
  const expected = 0.4 * net.synapticGain;
  assert.ok(net.Isyn[1] > 0, "excitatory postsynaptic current arrived");
  assert.ok(Math.abs(net.Isyn[1] - expected) < 1e-3, `Isyn ≈ w·gain (${expected})`);
});

test("an inhibitory synapse drives the postsynaptic current negative", () => {
  const meta = [neuron({ id: 0 }), neuron({ id: 1 })];
  const net = new LifNetwork(meta, [{ pre: 0, post: 1, w: -1.0 }]);
  net.injectCurrent(0, 50);
  net.tick(1);
  net.tick(1);
  assert.ok(net.Isyn[1] < 0, "cross-hemisphere inhibition pulls the target down");
});

test("spike-frequency adaptation fatigues a persistently driven neuron (the WTA latch cure)", () => {
  // Two identical neurons under the same constant drive; only the SFA increment differs. The fatigued
  // one must fire LESS over a long run — this is exactly what stops the winner-take-all from latching.
  const run = (adaptIncrement: number) => {
    const net = new LifNetwork([neuron({ refractory: 2 })], []);
    net.adaptIncrement = adaptIncrement;
    let spikes = 0;
    for (let i = 0; i < 600; i++) {
      net.injectCurrent(0, 0.35); // modest, sustained drive
      net.tick(1);
      spikes += net.spiking[0];
    }
    return { spikes, adaptation: net.adaptation[0] };
  };

  const fresh = run(0);      // no fatigue
  const adapted = run(0.05); // production SFA
  assert.ok(adapted.spikes < fresh.spikes, `SFA reduces sustained firing (${adapted.spikes} < ${fresh.spikes})`);
  assert.ok(adapted.adaptation > 0, "adaptation current built up while spiking");
  assert.ok(adapted.adaptation <= 4.0 + 1e-6, "adaptation is capped (never runs away)");
});

test("firing rate tracks spiking and is smoothed, not instantaneous", () => {
  const net = new LifNetwork([neuron({ refractory: 0 })], []);
  for (let i = 0; i < 20; i++) {
    net.injectCurrent(0, 50);
    net.tick(1);
  }
  assert.ok(net.firingRate[0] > 0, "rate rose while spiking");
  // Stop driving: the smoothed rate must decay back toward zero, not stay pinned.
  const peak = net.firingRate[0];
  for (let i = 0; i < 500; i++) net.tick(1);
  assert.ok(net.firingRate[0] < peak * 0.1, "rate decays after the drive stops");
});

test("state serialises and restores exactly (Durable Object persistence)", () => {
  const meta = [neuron({ id: 0 }), neuron({ id: 1 })];
  const net = new LifNetwork(meta, [{ pre: 0, post: 1, w: 0.3 }]);
  net.injectCurrent(0, 50);
  for (let i = 0; i < 30; i++) net.tick(1);

  const clone = new LifNetwork(meta, [{ pre: 0, post: 1, w: 0.3 }]);
  clone.fromJSON(JSON.parse(JSON.stringify(net.toJSON())));

  assert.equal(clone.t, net.t, "clock restored");
  assert.equal(clone.step, net.step, "step restored");
  assert.deepEqual(Array.from(clone.V), Array.from(net.V), "membrane restored");
  assert.deepEqual(Array.from(clone.adaptation), Array.from(net.adaptation), "SFA state restored");

  // And the restored network continues identically from here.
  net.tick(1); clone.tick(1);
  assert.deepEqual(Array.from(clone.V), Array.from(net.V), "diverges not at all after restore");
});
