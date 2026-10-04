//! Port of lif.ts — `LifNetwork`.
//!
//! PRECISION CONTRACT. The TypeScript keeps per-neuron state in Float32Array (V, lastSpikeT, Isyn,
//! Iext, firingRate, adaptation) and synapse weights in a Float32Array, but every arithmetic
//! expression is evaluated in f64 (JS Number) and only the STORE rounds to f32 (round-to-nearest-
//! even, same as Rust's `as f32`). This file mirrors that exactly: state lives in `Vec<f32>`, each
//! expression widens operands to f64 in the same association order as the TS source, and the
//! result is narrowed once on assignment. Loop/iteration order over synapses is the CSR order
//! (stable sort by post neuron), identical to the TS constructor.

use crate::connectome::{NeuronMeta, Synapse};
use crate::jsmath;
use serde::{Deserialize, Serialize};

/// `LifNetwork.toJSON()` — the JSON-safe state object (Float32Array contents as plain numbers).
/// Arrays are `f64` on the wire because that is what JSON carries; `from_json` stores them with
/// the same f64→f32 rounding as `Float32Array.prototype.set`.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct LifNetworkJson {
    pub t: f64,
    pub step: u64,
    #[serde(rename = "V")]
    pub v: Vec<f64>,
    #[serde(rename = "lastSpikeT")]
    pub last_spike_t: Vec<f64>,
    #[serde(rename = "Isyn")]
    pub isyn: Vec<f64>,
    #[serde(rename = "Iext")]
    pub iext: Vec<f64>,
    #[serde(rename = "firingRate")]
    pub firing_rate: Vec<f64>,
    /// Absent in archives that predate spike-frequency adaptation.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub adaptation: Option<Vec<f64>>,
}

pub struct LifNetwork {
    pub n: usize,
    pub meta: Vec<NeuronMeta>,
    /// Membrane potential
    pub v: Vec<f32>,
    /// Last spike time (ms)
    pub last_spike_t: Vec<f32>,
    /// Spike flag for the current step
    pub spiking: Vec<u8>,
    /// Synaptic current
    pub isyn: Vec<f32>,
    /// External current
    pub iext: Vec<f32>,
    /// Exponentially smoothed firing rate (Hz)
    pub firing_rate: Vec<f32>,
    /// Spike-frequency adaptation current
    pub adaptation: Vec<f32>,
    /// CSR by post neuron
    pub syn_post_ptr: Vec<u32>,
    pub syn_pre_idx: Vec<u32>,
    pub syn_weight: Vec<f32>,
    pub s: usize,
    /// Simulated time (ms) — plain JS number
    pub t: f64,
    pub step: u64,
    prev_spikes: Vec<u8>,
    /// Structure-of-arrays copies of the per-neuron LIF parameters (hot-loop locality).
    tau: Vec<f64>,
    v_rest: Vec<f64>,
    v_thresh: Vec<f64>,
    v_reset: Vec<f64>,
    refractory: Vec<f64>,
    /// `dt_ms / tau[i]` for `cached_dt` (recomputed when dt changes).
    dt_over_tau: Vec<f64>,
    cached_dt: f64,
    /// Transposed synapse index: for each PRE neuron, the CSR positions `s` of its outgoing
    /// synapses (`out_ptr[pre]..out_ptr[pre+1]` into `out_pos`). Lets a step touch only the
    /// synapses whose pre neuron spiked instead of all S.
    out_ptr: Vec<u32>,
    out_pos: Vec<u32>,
    /// Neurons that spiked on the previous step (same information as `prev_spikes`, as a list).
    prev_spike_list: Vec<u32>,
    cur_spike_list: Vec<u32>,
    /// Bitset over CSR positions: "this synapse's pre spiked last step" (cleared every step).
    active_bits: Vec<u64>,

    pub tau_syn: f64,
    pub r: f64,
    rate_alpha: f64,
    pub synaptic_gain: f64,
    pub tau_adapt: f64,
    pub adapt_increment: f64,
    pub adapt_max: f64,
}

impl LifNetwork {
    pub fn new(meta: Vec<NeuronMeta>, synapses: &[Synapse]) -> Self {
        let n = meta.len();
        let s = synapses.len();

        let mut v = vec![0f32; n];
        for i in 0..n {
            v[i] = meta[i].v_rest as f32;
        }

        // Stable sort by post (JS Array.prototype.sort is stable) — a counting sort is stable and
        // avoids the comparator's cost; the resulting order is identical.
        let mut counts = vec![0u32; n + 1];
        for syn in synapses {
            counts[syn.post as usize + 1] += 1;
        }
        let mut syn_post_ptr = vec![0u32; n + 1];
        for post in 0..n {
            syn_post_ptr[post + 1] = syn_post_ptr[post] + counts[post + 1];
        }
        let mut fill = syn_post_ptr.clone();
        let mut syn_pre_idx = vec![0u32; s];
        let mut syn_weight = vec![0f32; s];
        for syn in synapses {
            let slot = fill[syn.post as usize] as usize;
            fill[syn.post as usize] += 1;
            syn_pre_idx[slot] = syn.pre;
            syn_weight[slot] = syn.w as f32;
        }

        // Transposed index (CSR by pre), positions ascending within each pre.
        let mut out_ptr = vec![0u32; n + 1];
        for &pre in &syn_pre_idx {
            out_ptr[pre as usize + 1] += 1;
        }
        for pre in 0..n {
            out_ptr[pre + 1] += out_ptr[pre];
        }
        let mut fill = out_ptr.clone();
        let mut out_pos = vec![0u32; s];
        for (pos, &pre) in syn_pre_idx.iter().enumerate() {
            let slot = fill[pre as usize] as usize;
            fill[pre as usize] += 1;
            out_pos[slot] = pos as u32;
        }

        let tau: Vec<f64> = meta.iter().map(|m| m.tau).collect();
        let v_rest: Vec<f64> = meta.iter().map(|m| m.v_rest).collect();
        let v_thresh: Vec<f64> = meta.iter().map(|m| m.v_thresh).collect();
        let v_reset: Vec<f64> = meta.iter().map(|m| m.v_reset).collect();
        let refractory: Vec<f64> = meta.iter().map(|m| m.refractory).collect();

        Self {
            n,
            meta,
            v,
            last_spike_t: vec![-1e9f32; n],
            spiking: vec![0; n],
            isyn: vec![0f32; n],
            iext: vec![0f32; n],
            firing_rate: vec![0f32; n],
            adaptation: vec![0f32; n],
            syn_post_ptr,
            syn_pre_idx,
            syn_weight,
            s,
            t: 0.0,
            step: 0,
            prev_spikes: vec![0; n],
            tau,
            v_rest,
            v_thresh,
            v_reset,
            refractory,
            dt_over_tau: vec![0.0; n],
            cached_dt: f64::NAN,
            out_ptr,
            out_pos,
            prev_spike_list: Vec::with_capacity(n),
            cur_spike_list: Vec::with_capacity(n),
            active_bits: vec![0u64; s.div_ceil(64) + 1],
            tau_syn: 5.0,
            r: 1.0,
            rate_alpha: 0.01,
            synaptic_gain: 3.0,
            tau_adapt: 200.0,
            adapt_increment: 0.05,
            adapt_max: 4.0,
        }
    }

    /// `injectCurrent(neuronId, amplitude)`: `Iext[id] += amplitude` (f64 add, f32 store).
    #[inline]
    pub fn inject_current(&mut self, neuron_id: usize, amplitude: f64) {
        if neuron_id >= self.n {
            return;
        }
        self.iext[neuron_id] = (self.iext[neuron_id] as f64 + amplitude) as f32;
    }

    /// One simulation step. The per-neuron work of the TS steps 2/2b/3/4/5/6 is fused into
    /// two passes (synaptic pass, then neuron pass); every element's operations still happen in
    /// the TS order and no element depends on another element's same-step result, so the fusion
    /// is bit-exact (tests/parity.rs, dynamics_*.json).
    pub fn tick(&mut self, dt_ms: f64) {
        let n = self.n;
        let t = self.t;

        // Per-step scalars (identical expressions to lif.ts)
        let syn_decay = jsmath::exp(-dt_ms / self.tau_syn);
        let adapt_decay = jsmath::exp(-dt_ms / self.tau_adapt);
        let ext_decay = jsmath::exp(-dt_ms / 20.0);
        let inst_rate = 1000.0 / dt_ms;
        let a = jsmath::min(1.0, self.rate_alpha * dt_ms);
        let gain = self.synaptic_gain;
        let r = self.r;
        let adapt_increment = self.adapt_increment;
        let adapt_max = self.adapt_max;
        if self.cached_dt != dt_ms {
            // dtMs / m.tau — the same division the TS does per neuron per step, computed once
            // per distinct dt (exact: same operands, same rounding).
            for i in 0..n {
                self.dt_over_tau[i] = dt_ms / self.tau[i];
            }
            self.cached_dt = dt_ms;
        }

        // 2 + 3) decay synaptic current, then add this step's synaptic input.
        // The TS sums, per post neuron, the weights of its CSR-ordered synapses whose pre spiked
        // last step. We mark exactly those synapses in a bitset (from the spiking pres' out-lists)
        // and then walk each post's CSR range through the bitset in ASCENDING position order, so
        // the f64 accumulation order — hence every rounding — is identical to the TS loop, while
        // only ~spikes×fan-out synapses are touched instead of all S.
        {
            let bits = &mut self.active_bits;
            for &pre in &self.prev_spike_list {
                let (a, b) = (self.out_ptr[pre as usize] as usize, self.out_ptr[pre as usize + 1] as usize);
                for &pos in &self.out_pos[a..b] {
                    bits[(pos >> 6) as usize] |= 1u64 << (pos & 63);
                }
            }
            let ptr = &self.syn_post_ptr;
            let weight = &self.syn_weight;
            for (post, isyn) in self.isyn.iter_mut().enumerate() {
                let start = ptr[post] as usize;
                let end = ptr[post + 1] as usize;
                let mut sum = 0.0f64;
                if start < end {
                    let mut wi = start >> 6;
                    let last = (end - 1) >> 6;
                    while wi <= last {
                        let mut word = bits[wi];
                        if word != 0 {
                            // keep only positions in [start, end)
                            let base = wi << 6;
                            if base < start {
                                word &= !0u64 << (start - base);
                            }
                            if base + 64 > end {
                                word &= (1u64 << (end - base)) - 1;
                            }
                            while word != 0 {
                                let bit = word.trailing_zeros() as usize;
                                sum += weight[base + bit] as f64;
                                word &= word - 1;
                            }
                        }
                        wi += 1;
                    }
                }
                let decayed = (*isyn as f64 * syn_decay) as f32;
                *isyn = (decayed as f64 + sum * gain) as f32;
            }
            for &pre in &self.prev_spike_list {
                let (a, b) = (self.out_ptr[pre as usize] as usize, self.out_ptr[pre as usize + 1] as usize);
                for &pos in &self.out_pos[a..b] {
                    bits[(pos >> 6) as usize] = 0;
                }
            }
        }

        // 2b + 4 + 5 + 6) per neuron: SFA decay, membrane update/firing, rate, Iext decay.
        // (Slices are re-bound to exactly n elements so the index checks fold away.)
        self.cur_spike_list.clear();
        {
            let v = &mut self.v[..n];
            let last_spike_t = &mut self.last_spike_t[..n];
            let spiking = &mut self.spiking[..n];
            let isyn = &self.isyn[..n];
            let iext = &mut self.iext[..n];
            let firing_rate = &mut self.firing_rate[..n];
            let adaptation_arr = &mut self.adaptation[..n];
            let v_rest = &self.v_rest[..n];
            let v_thresh = &self.v_thresh[..n];
            let v_reset = &self.v_reset[..n];
            let refractory = &self.refractory[..n];
            let dt_over_tau = &self.dt_over_tau[..n];
            let spike_list = &mut self.cur_spike_list;
            for i in 0..n {
                let adaptation = (adaptation_arr[i] as f64 * adapt_decay) as f32;
                let mut spiked = false;
                if (t - last_spike_t[i] as f64) < refractory[i] {
                    v[i] = v_reset[i] as f32;
                    adaptation_arr[i] = adaptation;
                } else {
                    let dv = (-(v[i] as f64 - v_rest[i]) + r * (isyn[i] as f64 + iext[i] as f64 - adaptation as f64))
                        * dt_over_tau[i];
                    let vn = (v[i] as f64 + dv) as f32;
                    if vn as f64 >= v_thresh[i] {
                        spiked = true;
                        spike_list.push(i as u32);
                        last_spike_t[i] = t as f32;
                        v[i] = v_reset[i] as f32;
                        let a_next = adaptation as f64 + adapt_increment;
                        adaptation_arr[i] = (if a_next > adapt_max { adapt_max } else { a_next }) as f32;
                    } else {
                        v[i] = vn;
                        adaptation_arr[i] = adaptation;
                    }
                }
                spiking[i] = spiked as u8;
                let target = if spiked { inst_rate } else { 0.0 };
                let fr = firing_rate[i] as f64;
                firing_rate[i] = (fr + a * (target - fr)) as f32;
                iext[i] = (iext[i] as f64 * ext_decay) as f32;
            }
        }

        // 7) swap the double buffer
        self.prev_spikes.copy_from_slice(&self.spiking);
        std::mem::swap(&mut self.prev_spike_list, &mut self.cur_spike_list);

        self.t += dt_ms;
        self.step += 1;
    }

    /// `toJSON()`.
    pub fn to_json(&self) -> LifNetworkJson {
        let widen = |a: &[f32]| a.iter().map(|&x| x as f64).collect::<Vec<f64>>();
        LifNetworkJson {
            t: self.t,
            step: self.step,
            v: widen(&self.v),
            last_spike_t: widen(&self.last_spike_t),
            isyn: widen(&self.isyn),
            iext: widen(&self.iext),
            firing_rate: widen(&self.firing_rate),
            adaptation: Some(widen(&self.adaptation)),
        }
    }

    /// `fromJSON(obj)`. Exactly like the reference it restores `t`, `step` and the six state
    /// arrays (adaptation only if present) and does NOT touch the spike flags or the previous-step
    /// spike buffer — so a brain restored into a fresh network propagates no synaptic input on its
    /// first tick. Callers must pass arrays of length `n` (`Float32Array.set` would throw otherwise).
    pub fn from_json(&mut self, j: &LifNetworkJson) {
        let n = self.n;
        assert_eq!(j.v.len(), n, "fromJSON: V length");
        assert_eq!(j.last_spike_t.len(), n, "fromJSON: lastSpikeT length");
        assert_eq!(j.isyn.len(), n, "fromJSON: Isyn length");
        assert_eq!(j.iext.len(), n, "fromJSON: Iext length");
        assert_eq!(j.firing_rate.len(), n, "fromJSON: firingRate length");
        self.t = j.t;
        self.step = j.step;
        let narrow = |dst: &mut [f32], src: &[f64]| {
            for (d, &x) in dst.iter_mut().zip(src) {
                *d = x as f32;
            }
        };
        narrow(&mut self.v, &j.v);
        narrow(&mut self.last_spike_t, &j.last_spike_t);
        narrow(&mut self.isyn, &j.isyn);
        narrow(&mut self.iext, &j.iext);
        narrow(&mut self.firing_rate, &j.firing_rate);
        if let Some(a) = &j.adaptation {
            assert_eq!(a.len(), n, "fromJSON: adaptation length");
            narrow(&mut self.adaptation, a);
        }
    }
}
