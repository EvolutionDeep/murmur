//! Port of connectome.ts — `buildConnectome(opts)`.
//!
//! Every `rand()` draw happens in exactly the order the TypeScript makes it, and every float
//! expression keeps the TS association order, so the neuron metadata and the synapse list are
//! bit-identical (see tests/parity.rs, connectome_<seed>.json).

use crate::jsmath;
use crate::prng::Mulberry32;
use serde::{Deserialize, Serialize};

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum NeuronKind {
    Sensory,
    Inter,
    Modulatory,
    Motor,
}

impl NeuronKind {
    pub const ALL: [NeuronKind; 4] = [Self::Sensory, Self::Inter, Self::Modulatory, Self::Motor];
    #[inline]
    pub fn index(self) -> usize {
        self as usize
    }
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Sensory => "sensory",
            Self::Inter => "inter",
            Self::Modulatory => "modulatory",
            Self::Motor => "motor",
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SensoryChannel {
    ThermalWarmth,
    ThermalFlux,
    MechanicalTurbulence,
    OlfactoryDensity,
    GustatoryRichness,
    InternalArousal,
    StimulusFood,
    StimulusThreat,
    StimulusLight,
    StimulusDark,
}

pub const SENSORY_CHANNELS: [SensoryChannel; 10] = [
    SensoryChannel::ThermalWarmth,
    SensoryChannel::ThermalFlux,
    SensoryChannel::MechanicalTurbulence,
    SensoryChannel::OlfactoryDensity,
    SensoryChannel::GustatoryRichness,
    SensoryChannel::InternalArousal,
    SensoryChannel::StimulusFood,
    SensoryChannel::StimulusThreat,
    SensoryChannel::StimulusLight,
    SensoryChannel::StimulusDark,
];

impl SensoryChannel {
    #[inline]
    pub fn index(self) -> usize {
        self as usize
    }
    pub fn as_str(self) -> &'static str {
        match self {
            Self::ThermalWarmth => "thermal_warmth",
            Self::ThermalFlux => "thermal_flux",
            Self::MechanicalTurbulence => "mechanical_turbulence",
            Self::OlfactoryDensity => "olfactory_density",
            Self::GustatoryRichness => "gustatory_richness",
            Self::InternalArousal => "internal_arousal",
            Self::StimulusFood => "stimulus_food",
            Self::StimulusThreat => "stimulus_threat",
            Self::StimulusLight => "stimulus_light",
            Self::StimulusDark => "stimulus_dark",
        }
    }
    pub fn from_str(s: &str) -> Option<Self> {
        SENSORY_CHANNELS.iter().copied().find(|c| c.as_str() == s)
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum MotorChannel {
    LegLeft,
    LegRight,
    Wing,
    Proboscis,
    Abdomen,
}

pub const MOTOR_CHANNELS: [MotorChannel; 5] =
    [MotorChannel::LegLeft, MotorChannel::LegRight, MotorChannel::Wing, MotorChannel::Proboscis, MotorChannel::Abdomen];

impl MotorChannel {
    #[inline]
    pub fn index(self) -> usize {
        self as usize
    }
    pub fn as_str(self) -> &'static str {
        match self {
            Self::LegLeft => "leg_left",
            Self::LegRight => "leg_right",
            Self::Wing => "wing",
            Self::Proboscis => "proboscis",
            Self::Abdomen => "abdomen",
        }
    }
    pub fn from_str(s: &str) -> Option<Self> {
        MOTOR_CHANNELS.iter().copied().find(|c| c.as_str() == s)
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Channel {
    Sensory(SensoryChannel),
    Motor(MotorChannel),
}

impl Channel {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Sensory(c) => c.as_str(),
            Self::Motor(c) => c.as_str(),
        }
    }
}

#[derive(Clone, Debug, PartialEq)]
pub struct NeuronMeta {
    pub id: usize,
    pub kind: NeuronKind,
    pub channel: Option<Channel>,
    /// Membrane time constant (ms) — plain JS number (f64).
    pub tau: f64,
    pub v_rest: f64,
    pub v_thresh: f64,
    pub v_reset: f64,
    /// Refractory period (ms).
    pub refractory: f64,
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Synapse {
    pub pre: u32,
    pub post: u32,
    /// Weight as the f64 the generator produced (LifNetwork rounds it to f32 on load).
    pub w: f64,
}

#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize)]
pub struct ConnectomeOptions {
    pub seed: u32,
    pub n_sensory: usize,
    pub n_inter_l1: usize,
    pub n_inter_l2: usize,
    pub n_modulatory: usize,
    pub n_motor_per_channel: usize,
    pub density: f64,
}

/// `DEFAULT_CONNECTOME_OPTIONS` in connectome.ts.
pub const DEFAULT_CONNECTOME_OPTIONS: ConnectomeOptions = ConnectomeOptions {
    seed: 0xfeed_face,
    n_sensory: 180,
    n_inter_l1: 400,
    n_inter_l2: 400,
    n_modulatory: 40,
    n_motor_per_channel: 12,
    density: 0.02,
};

impl Default for ConnectomeOptions {
    fn default() -> Self {
        DEFAULT_CONNECTOME_OPTIONS
    }
}

#[derive(Clone, Debug)]
pub struct Connectome {
    pub neurons: Vec<NeuronMeta>,
    pub synapses: Vec<Synapse>,
    /// Neuron ids per kind (index = NeuronKind::index()).
    pub by_kind: [Vec<usize>; 4],
    /// Sensory neuron ids per channel (index = SensoryChannel::index()).
    pub sensory_ids: [Vec<usize>; 10],
    /// Motor neuron ids per channel (index = MotorChannel::index()).
    pub motor_ids: [Vec<usize>; 5],
}

impl Connectome {
    /// `byChannel.get(name)` for either channel family.
    pub fn channel_ids(&self, name: &str) -> Option<&[usize]> {
        if let Some(c) = SensoryChannel::from_str(name) {
            return Some(&self.sensory_ids[c.index()]);
        }
        if let Some(c) = MotorChannel::from_str(name) {
            return Some(&self.motor_ids[c.index()]);
        }
        None
    }
}

struct Base {
    tau: f64,
    v_rest: f64,
    v_thresh: f64,
    v_reset: f64,
    refractory: f64,
}

fn base_params(kind: NeuronKind) -> Base {
    match kind {
        NeuronKind::Sensory => Base { tau: 10.0, v_rest: 0.0, v_thresh: 1.0, v_reset: -0.5, refractory: 3.0 },
        NeuronKind::Inter => Base { tau: 15.0, v_rest: 0.0, v_thresh: 1.0, v_reset: -0.5, refractory: 4.0 },
        NeuronKind::Modulatory => Base { tau: 40.0, v_rest: 0.0, v_thresh: 0.8, v_reset: -0.3, refractory: 10.0 },
        NeuronKind::Motor => Base { tau: 8.0, v_rest: 0.0, v_thresh: 1.0, v_reset: -0.5, refractory: 2.0 },
    }
}

/// makeMeta(): tau jitter is drawn BEFORE vThresh jitter (object-literal evaluation order).
fn make_meta(id: usize, kind: NeuronKind, channel: Option<Channel>, rand: &mut Mulberry32) -> NeuronMeta {
    let base = base_params(kind);
    let tau = base.tau * (0.8 + rand.next() * 0.4);
    let v_thresh = base.v_thresh * (0.8 + rand.next() * 0.4);
    NeuronMeta {
        id,
        kind,
        channel,
        tau,
        v_rest: base.v_rest,
        v_thresh,
        v_reset: base.v_reset,
        refractory: base.refractory,
    }
}

/// Box-Muller, exactly as gaussian() in connectome.ts.
#[inline]
fn gaussian(rand: &mut Mulberry32, mean: f64, std: f64) -> f64 {
    let mut u = 0.0;
    let mut v = 0.0;
    while u == 0.0 {
        u = rand.next();
    }
    while v == 0.0 {
        v = rand.next();
    }
    let n = jsmath::sqrt(-2.0 * jsmath::log(u)) * jsmath::cos(2.0 * std::f64::consts::PI * v);
    mean + std * n
}

/// `Math.floor(rand() * span)` as a usize.
#[inline]
fn floor_rand(rand: &mut Mulberry32, span: usize) -> usize {
    (rand.next() * span as f64).floor() as usize
}

pub fn build_connectome(opts: &ConnectomeOptions) -> Connectome {
    let ConnectomeOptions { seed, n_sensory, n_inter_l1, n_inter_l2, n_modulatory, n_motor_per_channel, density } =
        *opts;

    let mut rand = Mulberry32::new(seed);
    let mut neurons: Vec<NeuronMeta> = Vec::new();
    let mut synapses: Vec<Synapse> = Vec::new();
    let mut sensory_ids: [Vec<usize>; 10] = Default::default();
    let mut motor_ids: [Vec<usize>; 5] = Default::default();

    // ============ 1) Allocate neurons ============
    let sensory_start = neurons.len();
    for i in 0..n_sensory {
        let ch = SENSORY_CHANNELS[i % SENSORY_CHANNELS.len()];
        let id = neurons.len();
        neurons.push(make_meta(id, NeuronKind::Sensory, Some(Channel::Sensory(ch)), &mut rand));
        sensory_ids[ch.index()].push(id);
    }
    let sensory_range = (sensory_start, neurons.len());

    let l1_start = neurons.len();
    for _ in 0..n_inter_l1 {
        let id = neurons.len();
        neurons.push(make_meta(id, NeuronKind::Inter, None, &mut rand));
    }
    let l1_end = neurons.len();

    let l2_start = neurons.len();
    let l2_half = n_inter_l2 / 2;
    for _ in 0..n_inter_l2 {
        let id = neurons.len();
        neurons.push(make_meta(id, NeuronKind::Inter, None, &mut rand));
    }
    let l2_end = neurons.len();
    let l2_left = (l2_start, l2_start + l2_half);
    let l2_right = (l2_start + l2_half, l2_end);

    let mod_start = neurons.len();
    for _ in 0..n_modulatory {
        let id = neurons.len();
        neurons.push(make_meta(id, NeuronKind::Modulatory, None, &mut rand));
    }

    for ch in MOTOR_CHANNELS {
        for _ in 0..n_motor_per_channel {
            let id = neurons.len();
            neurons.push(make_meta(id, NeuronKind::Motor, Some(Channel::Motor(ch)), &mut rand));
            motor_ids[ch.index()].push(id);
        }
    }

    // ============ 2) Wire the synapses ============
    let connect = |from: (usize, usize),
                   to: (usize, usize),
                   d: f64,
                   w_mean: f64,
                   w_std: f64,
                   rand: &mut Mulberry32,
                   syn: &mut Vec<Synapse>| {
        let span = from.1 - from.0;
        let fan = ((span as f64 * d).floor() as i64).max(1) as usize;
        for post in to.0..to.1 {
            for _ in 0..fan {
                let pre = from.0 + floor_rand(rand, span);
                let w = gaussian(rand, w_mean, w_std);
                syn.push(Synapse { pre: pre as u32, post: post as u32, w });
            }
        }
    };

    connect(sensory_range, (l1_start, l1_end), density * 1.5, 0.40, 0.10, &mut rand, &mut synapses);
    connect((l1_start, l1_end), (l2_start, l2_end), density * 1.2, 0.35, 0.10, &mut rand, &mut synapses);
    connect(l2_left, l2_right, density * 0.8, -1.0, 0.2, &mut rand, &mut synapses);
    connect(l2_right, l2_left, density * 0.8, -1.0, 0.2, &mut rand, &mut synapses);
    connect(l2_left, l2_left, density * 0.3, 0.15, 0.05, &mut rand, &mut synapses);
    connect(l2_right, l2_right, density * 0.3, 0.15, 0.05, &mut rand, &mut synapses);

    // Inter L2 left → leg_left, right → leg_right (fixed fan 40)
    for &post in &motor_ids[MotorChannel::LegLeft.index()] {
        for _ in 0..40 {
            let pre = l2_left.0 + floor_rand(&mut rand, l2_left.1 - l2_left.0);
            let w = gaussian(&mut rand, 0.15, 0.04);
            synapses.push(Synapse { pre: pre as u32, post: post as u32, w });
        }
    }
    for &post in &motor_ids[MotorChannel::LegRight.index()] {
        for _ in 0..40 {
            let pre = l2_right.0 + floor_rand(&mut rand, l2_right.1 - l2_right.0);
            let w = gaussian(&mut rand, 0.15, 0.04);
            synapses.push(Synapse { pre: pre as u32, post: post as u32, w });
        }
    }

    // Inter L2 → wing then abdomen (fixed fan 30)
    let wing_abd: Vec<usize> = motor_ids[MotorChannel::Wing.index()]
        .iter()
        .chain(motor_ids[MotorChannel::Abdomen.index()].iter())
        .copied()
        .collect();
    for post in wing_abd {
        for _ in 0..30 {
            let pre = l2_start + floor_rand(&mut rand, l2_end - l2_start);
            let w = gaussian(&mut rand, 0.10, 0.03);
            synapses.push(Synapse { pre: pre as u32, post: post as u32, w });
        }
    }

    // gustatory_richness → proboscis (fixed fan ≤ 6)
    let gus_ids = &sensory_ids[SensoryChannel::GustatoryRichness.index()];
    let prob_fan = gus_ids.len().clamp(1, 6);
    assert!(
        !gus_ids.is_empty(),
        "buildConnectome: no gustatory_richness sensory neurons (nSensory < 5); the TS reference would index undefined here"
    );
    for &post in &motor_ids[MotorChannel::Proboscis.index()] {
        for _ in 0..prob_fan {
            let pre = gus_ids[floor_rand(&mut rand, gus_ids.len())];
            let w = gaussian(&mut rand, 0.15, 0.04);
            synapses.push(Synapse { pre: pre as u32, post: post as u32, w });
        }
    }

    // Modulatory ↔ whole brain (p = 0.05 per neuron)
    let n_total = neurons.len();
    for post in 0..n_total {
        if rand.next() < 0.05 {
            let pre = mod_start + floor_rand(&mut rand, n_total - mod_start);
            let w = gaussian(&mut rand, 0.12, 0.04);
            synapses.push(Synapse { pre: pre as u32, post: post as u32, w });
        }
    }
    // Sensory & L1 → Modulatory
    connect(
        (sensory_start, l1_end),
        (mod_start, mod_start + n_modulatory),
        density * 0.4,
        0.05,
        0.015,
        &mut rand,
        &mut synapses,
    );

    // stimulus_threat → modulatory (p = 0.25)
    for &pre in &sensory_ids[SensoryChannel::StimulusThreat.index()] {
        for post in mod_start..mod_start + n_modulatory {
            if rand.next() < 0.25 {
                let w = gaussian(&mut rand, 0.06, 0.015);
                synapses.push(Synapse { pre: pre as u32, post: post as u32, w });
            }
        }
    }

    // ============ 3) byKind ============
    let mut by_kind: [Vec<usize>; 4] = Default::default();
    for n in &neurons {
        by_kind[n.kind.index()].push(n.id);
    }

    Connectome { neurons, synapses, by_kind, sensory_ids, motor_ids }
}
