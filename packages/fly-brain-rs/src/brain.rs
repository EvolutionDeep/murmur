//! Port of fly-brain.ts — `FlyBrain` (inject / tick / readMotor / readAllMotor).

use crate::connectome::{
    build_connectome, Connectome, ConnectomeOptions, MotorChannel, NeuronKind, SensoryChannel, MOTOR_CHANNELS,
};
use crate::jsmath;
use crate::lif::{LifNetwork, LifNetworkJson};
use crate::prng::XorShift32;
use serde::{Deserialize, Serialize};

/// Reference sensory-channel size the injection gain was calibrated at.
const SENSORY_DRIVE_REF: f64 = 18.0;

/// `FlyBrain.serialize()` payload. `version` 3 marks the SFA-tuned era (see the reference's
/// `deserialize()` for the migration rules, reproduced in [`FlyBrain::deserialize`]).
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct BrainArchive {
    #[serde(default = "BrainArchive::default_version")]
    pub version: i64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub net: Option<LifNetworkJson>,
    #[serde(default, rename = "noiseState", skip_serializing_if = "Option::is_none")]
    pub noise_state: Option<u32>,
}

impl BrainArchive {
    fn default_version() -> i64 {
        1
    }
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct MotorOutput {
    pub channel: MotorChannel,
    #[serde(rename = "firingRate")]
    pub firing_rate: f64,
    pub spikes: u32,
    pub normalized: f64,
}

pub struct FlyBrain {
    pub connectome: Connectome,
    pub net: LifNetwork,
    spontaneous_rate: f64,
    inject_gain: f64,
    noise: XorShift32,
}

impl FlyBrain {
    pub fn new(opts: &ConnectomeOptions) -> Self {
        let connectome = build_connectome(opts);
        let net = LifNetwork::new(connectome.neurons.clone(), &connectome.synapses);
        Self { connectome, net, spontaneous_rate: 0.3, inject_gain: 50.0, noise: XorShift32::new(opts.seed) }
    }

    #[inline]
    pub fn t(&self) -> f64 {
        self.net.t
    }
    #[inline]
    pub fn step(&self) -> u64 {
        self.net.step
    }
    #[inline]
    pub fn noise_state(&self) -> u32 {
        self.noise.state
    }

    /// `inject({channel, intensity})`.
    #[inline]
    pub fn inject(&mut self, channel: SensoryChannel, intensity: f64) {
        let ids = &self.connectome.sensory_ids[channel.index()];
        if ids.is_empty() {
            return;
        }
        let amplitude = (intensity * self.inject_gain) / SENSORY_DRIVE_REF;
        for &id in ids {
            self.net.inject_current(id, amplitude);
        }
    }

    /// `tick(dtMs)`: spontaneous noise on the sensory layer, then one LIF step.
    pub fn tick(&mut self, dt_ms: f64) {
        self.add_spontaneous_noise(dt_ms);
        self.net.tick(dt_ms);
    }

    /// `advance(ms)`: `max(1, floor(ms))` 1 ms ticks.
    pub fn advance(&mut self, ms: f64) {
        let steps = (ms.floor() as i64).max(1);
        for _ in 0..steps {
            self.tick(1.0);
        }
    }

    fn add_spontaneous_noise(&mut self, dt_ms: f64) {
        let threshold = self.spontaneous_rate * dt_ms * 0.05;
        let sensory = &self.connectome.by_kind[NeuronKind::Sensory.index()];
        for &id in sensory {
            let r = self.noise.next();
            if r < threshold {
                let amp = 1.0 + self.noise.next() * 1.5;
                self.net.inject_current(id, amp);
            }
        }
    }

    /// `readMotor(channel)` — the `windowMs` argument of the TS API is unused there and omitted.
    pub fn read_motor(&self, channel: MotorChannel) -> MotorOutput {
        let ids = &self.connectome.motor_ids[channel.index()];
        if ids.is_empty() {
            return MotorOutput { channel, firing_rate: 0.0, spikes: 0, normalized: 0.0 };
        }
        let mut sum_rate = 0.0f64;
        let mut spikes = 0u32;
        for &id in ids {
            sum_rate += self.net.firing_rate[id] as f64;
            if self.net.spiking[id] == 1 {
                spikes += 1;
            }
        }
        let avg_rate = sum_rate / ids.len() as f64;
        let normalized = jsmath::min(1.0, avg_rate / 50.0);
        MotorOutput { channel, firing_rate: avg_rate, spikes, normalized }
    }

    /// `serialize()` as a structure (the reference emits `JSON.stringify` of the same shape;
    /// number formatting is JS's shortest round-trip, which serde_json also uses, but the two
    /// choose exponent notation at different magnitudes, so the TEXT is not byte-identical —
    /// the parsed VALUES are).
    pub fn to_archive(&self) -> BrainArchive {
        BrainArchive { version: 3, net: Some(self.net.to_json()), noise_state: Some(self.noise.state) }
    }

    /// `serialize()`.
    pub fn serialize(&self) -> String {
        serde_json::to_string(&self.to_archive()).expect("BrainArchive serialises")
    }

    /// `FlyBrain.deserialize(data, opts)`: build a fresh brain for `opts` and restore the archive
    /// into it under the reference's rules — the electrical state is restored only when the
    /// archive's `V` length equals this connectome's neuron count AND `version >= 3`; a same-size
    /// pre-v3 archive keeps only the simulation clock; `noiseState` is restored whenever present.
    /// Like the reference, the spike flags / previous-step buffer are those of a fresh network.
    pub fn deserialize(data: &str, opts: &ConnectomeOptions) -> Result<Self, serde_json::Error> {
        let parsed: BrainArchive = serde_json::from_str(data)?;
        Ok(Self::from_archive(&parsed, opts))
    }

    /// `deserialize` on an already-parsed archive.
    pub fn from_archive(parsed: &BrainArchive, opts: &ConnectomeOptions) -> Self {
        let mut brain = FlyBrain::new(opts);
        if let Some(net) = &parsed.net {
            let same_size = net.v.len() == brain.net.n;
            let sfa_era = parsed.version >= 3;
            if same_size && sfa_era {
                brain.net.from_json(net);
            } else if same_size {
                brain.net.t = net.t;
                brain.net.step = net.step;
            }
        }
        if let Some(ns) = parsed.noise_state {
            brain.noise.state = ns;
        }
        brain
    }

    pub fn read_all_motor(&self) -> [MotorOutput; 5] {
        [
            self.read_motor(MOTOR_CHANNELS[0]),
            self.read_motor(MOTOR_CHANNELS[1]),
            self.read_motor(MOTOR_CHANNELS[2]),
            self.read_motor(MOTOR_CHANNELS[3]),
            self.read_motor(MOTOR_CHANNELS[4]),
        ]
    }
}
