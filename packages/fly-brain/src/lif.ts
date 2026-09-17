import type { NeuronMeta } from "./types.js";

/**
 * An efficient TypeScript implementation of a Leaky Integrate-and-Fire neuron population.
 *
 * All state is stored in TypedArrays, giving O(N + S) cost per step:
 *   N = number of neurons, S = number of synapses
 *
 * Membrane equation:
 *   tau * dV/dt = -(V - V_rest) + R * I_syn + R * I_ext
 *   if V >= V_thresh and not refractory: spike; V <- V_reset
 *
 * Synaptic current uses exponential decay:
 *   dI/dt = -I / tau_syn + w * spike_pre
 */
export class LifNetwork {
  readonly N: number;
  readonly meta: NeuronMeta[];

  /** Membrane potential */
  readonly V: Float32Array;
  /** Last spike time (ms), used for the refractory period */
  readonly lastSpikeT: Float32Array;
  /** Whether the neuron spikes on the current step */
  readonly spiking: Uint8Array;
  /** Synaptic current (one per post-synaptic neuron) */
  readonly Isyn: Float32Array;
  /** Externally injected current (one per neuron) */
  readonly Iext: Float32Array;
  /** Moving-average firing rate (Hz), exponentially smoothed */
  readonly firingRate: Float32Array;
  /**
   * Spike-frequency adaptation (SFA) current, one per neuron. Builds on each spike and decays
   * slowly; subtracted from the drive so a persistently-firing population gradually fatigues. This
   * is what lets the mutually-inhibitory L2 winner-take-all ALTERNATE (winner tires → antagonist
   * recovers) instead of latching permanently at max rate.
   */
  readonly adaptation: Float32Array;

  /** Synapse table in CSR (Compressed Sparse Row) format, grouped by post neuron */
  readonly synPostPtr: Uint32Array;   // length N+1
  readonly synPreIdx: Uint32Array;     // length S
  readonly synWeight: Float32Array;    // length S
  readonly S: number;

  /** Simulated time (ms) */
  t = 0;
  /** Step count */
  step = 0;

  /** Synaptic time constant (ms) */
  readonly tauSyn = 5.0;
  /** Membrane resistance (normalized to 1) */
  readonly R = 1.0;
  /** Firing-rate smoothing factor (per ms) — 0.01 corresponds to a ~100ms window */
  private readonly rateAlpha = 0.01;
  /** Synaptic gain: amplifies synaptic current to ensure cross-layer signal propagation */
  readonly synapticGain = 3;

  /** SFA decay time constant (ms) — SHORT on purpose: fatigue trims the peak firing rate without
   *  silencing the population. Longer τ (≥250ms) over-suppresses into silence under a mild drive. */
  tauAdapt = 200.0;
  /** SFA increment per spike. Spike-frequency adaptation keeps the winner-take-all leg competition
   *  from LATCHING (one motor leg pinned at max rate, its antagonist silent, never flipping) so the
   *  motor output stays graded and alive across drive levels: 0.05 breaks the latch while preserving
   *  amplitude; weaker (0.03) leaves it latched, stronger (≥0.07) silences a mild drive. Validated
   *  against the population's real market-temperature drive (see the fly-brain motor calibration). */
  adaptIncrement = 0.05;
  /** SFA ceiling — prevents runaway suppression of any single neuron */
  adaptMax = 4.0;

  constructor(meta: NeuronMeta[], synapses: { pre: number; post: number; w: number }[]) {
    this.meta = meta;
    this.N = meta.length;
    this.S = synapses.length;

    this.V = new Float32Array(this.N);
    this.lastSpikeT = new Float32Array(this.N).fill(-1e9);
    this.spiking = new Uint8Array(this.N);
    this.Isyn = new Float32Array(this.N);
    this.Iext = new Float32Array(this.N);
    this.firingRate = new Float32Array(this.N);
    this.adaptation = new Float32Array(this.N);

    // Initialize membrane potentials to the resting potential
    for (let i = 0; i < this.N; i++) this.V[i] = meta[i].vRest;

    // Sort by post neuron and build the CSR structure
    const sorted = [...synapses].sort((a, b) => a.post - b.post);
    this.synPostPtr = new Uint32Array(this.N + 1);
    this.synPreIdx = new Uint32Array(this.S);
    this.synWeight = new Float32Array(this.S);

    let cursor = 0;
    for (let post = 0; post < this.N; post++) {
      this.synPostPtr[post] = cursor;
      while (cursor < this.S && sorted[cursor].post === post) {
        this.synPreIdx[cursor] = sorted[cursor].pre;
        this.synWeight[cursor] = sorted[cursor].w;
        cursor++;
      }
    }
    this.synPostPtr[this.N] = cursor;
  }

  /**
   * Inject external current into a given neuron (auto-decays after dt ms).
   * Simplification: we accumulate directly into Iext, then decay it uniformly at the end of each step.
   */
  injectCurrent(neuronId: number, amplitude: number): void {
    if (neuronId < 0 || neuronId >= this.N) return;
    this.Iext[neuronId] += amplitude;
  }

  /**
   * Single simulation step (double-buffered: propagates synaptic current from the previous step's spikes).
   * @param dtMs step size, 1ms recommended
   */
  private prevSpikes: Uint8Array | null = null;

  tick(dtMs: number): void {
    const { N, V, meta, Isyn, Iext, spiking, lastSpikeT, firingRate, adaptation, R } = this;
    const t = this.t;

    if (!this.prevSpikes) this.prevSpikes = new Uint8Array(N);
    const prev = this.prevSpikes;

    // 1) Clear this step's spike flags
    spiking.fill(0);

    // 2) Decay synaptic current
    const synDecay = Math.exp(-dtMs / this.tauSyn);
    for (let i = 0; i < N; i++) Isyn[i] *= synDecay;

    // 2b) Decay the SFA current (slow — fatigue persists across steps and sub-ticks)
    const adaptDecay = Math.exp(-dtMs / this.tauAdapt);
    for (let i = 0; i < N; i++) adaptation[i] *= adaptDecay;

    // 3) Inject synaptic current from the previous step's spikes (times synapticGain to ensure cross-layer propagation)
    for (let post = 0; post < N; post++) {
      const start = this.synPostPtr[post];
      const end = this.synPostPtr[post + 1];
      let sum = 0;
      for (let s = start; s < end; s++) {
        const pre = this.synPreIdx[s];
        if (prev[pre] === 1) sum += this.synWeight[s];
      }
      Isyn[post] += sum * this.synapticGain;
    }

    // 4) Update membrane potentials and firing
    for (let i = 0; i < N; i++) {
      const m = meta[i];
      if (t - lastSpikeT[i] < m.refractory) {
        V[i] = m.vReset;
        continue;
      }
      const dV = (-(V[i] - m.vRest) + R * (Isyn[i] + Iext[i] - adaptation[i])) * (dtMs / m.tau);
      V[i] += dV;
      if (V[i] >= m.vThresh) {
        spiking[i] = 1;
        lastSpikeT[i] = t;
        V[i] = m.vReset;
        // SFA: each spike builds fatigue that later suppresses this neuron, so a latched
        // winner-take-all population eventually tires and its antagonist can recover.
        const aNext = adaptation[i] + this.adaptIncrement;
        adaptation[i] = aNext > this.adaptMax ? this.adaptMax : aNext;
      }
    }

    // 5) Moving firing rate (Hz)
    const instRate = 1000 / dtMs;
    const a = Math.min(1, this.rateAlpha * dtMs);
    for (let i = 0; i < N; i++) {
      const target = spiking[i] === 1 ? instRate : 0;
      firingRate[i] += a * (target - firingRate[i]);
    }

    // 6) Decay external current
    const extDecay = Math.exp(-dtMs / 20);
    for (let i = 0; i < N; i++) Iext[i] *= extDecay;

    // 7) Swap the double buffer
    prev.set(spiking);

    this.t += dtMs;
    this.step++;
  }

  /** Serialize to a JSON-safe object */
  toJSON() {
    return {
      t: this.t,
      step: this.step,
      V: Array.from(this.V),
      lastSpikeT: Array.from(this.lastSpikeT),
      Isyn: Array.from(this.Isyn),
      Iext: Array.from(this.Iext),
      firingRate: Array.from(this.firingRate),
      adaptation: Array.from(this.adaptation),
    };
  }

  /** Restore from JSON (neuron/synapse structure must match) */
  fromJSON(obj: any): void {
    this.t = obj.t;
    this.step = obj.step;
    this.V.set(obj.V);
    this.lastSpikeT.set(obj.lastSpikeT);
    this.Isyn.set(obj.Isyn);
    this.Iext.set(obj.Iext);
    this.firingRate.set(obj.firingRate);
    // Archives predating SFA carry no adaptation array: leave it at 0 (fresh) so lineage is
    // preserved and fatigue rebuilds naturally within the first cron.
    if (obj.adaptation) this.adaptation.set(obj.adaptation);
  }
}
