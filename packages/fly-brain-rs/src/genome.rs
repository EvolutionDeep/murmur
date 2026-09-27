//! Port of genome.ts — `Genome`, `mutateGenome`, `crossoverGenome`, `canonicalGenome`,
//! `genomeFromOptions`, `genomeToConnectomeOptions`, `buildFromGenome`, `estimateConnectomeSize`.

use crate::connectome::{build_connectome, Connectome, ConnectomeOptions};
use crate::jsmath;
use crate::prng::Mulberry32;
use serde::{Deserialize, Serialize};

pub const GENOME_SCHEMA_VERSION: i64 = 1;

/// Field names follow the TS JSON shape exactly so genome files round-trip verbatim.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Genome {
    pub v: i64,
    pub seed: u32,
    #[serde(rename = "nSensory")]
    pub n_sensory: i64,
    #[serde(rename = "nInterL1")]
    pub n_inter_l1: i64,
    #[serde(rename = "nInterL2")]
    pub n_inter_l2: i64,
    #[serde(rename = "nModulatory")]
    pub n_modulatory: i64,
    #[serde(rename = "nMotorPerChannel")]
    pub n_motor_per_channel: i64,
    pub density: f64,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SizeField {
    NSensory,
    NInterL1,
    NInterL2,
    NModulatory,
    NMotorPerChannel,
}

const SIZE_FIELDS: [SizeField; 5] = [
    SizeField::NSensory,
    SizeField::NInterL1,
    SizeField::NInterL2,
    SizeField::NModulatory,
    SizeField::NMotorPerChannel,
];

fn bounds(f: SizeField) -> (f64, f64) {
    match f {
        SizeField::NSensory => (8.0, 2000.0),
        SizeField::NInterL1 => (8.0, 4000.0),
        SizeField::NInterL2 => (8.0, 4000.0),
        SizeField::NModulatory => (4.0, 2000.0),
        SizeField::NMotorPerChannel => (1.0, 500.0),
    }
}
pub const DENSITY_BOUNDS: (f64, f64) = (0.0005, 0.2);

impl Genome {
    fn get(&self, f: SizeField) -> i64 {
        match f {
            SizeField::NSensory => self.n_sensory,
            SizeField::NInterL1 => self.n_inter_l1,
            SizeField::NInterL2 => self.n_inter_l2,
            SizeField::NModulatory => self.n_modulatory,
            SizeField::NMotorPerChannel => self.n_motor_per_channel,
        }
    }
    fn set(&mut self, f: SizeField, x: i64) {
        match f {
            SizeField::NSensory => self.n_sensory = x,
            SizeField::NInterL1 => self.n_inter_l1 = x,
            SizeField::NInterL2 => self.n_inter_l2 = x,
            SizeField::NModulatory => self.n_modulatory = x,
            SizeField::NMotorPerChannel => self.n_motor_per_channel = x,
        }
    }
}

fn clamp_int(x: f64, lo: f64, hi: f64) -> f64 {
    if !x.is_finite() {
        return lo;
    }
    jsmath::max(lo, jsmath::min(hi, x.floor()))
}
#[inline]
fn clamp(x: f64, lo: f64, hi: f64) -> f64 {
    if x < lo {
        lo
    } else if x > hi {
        hi
    } else {
        x
    }
}
#[inline]
pub fn round4(x: f64) -> f64 {
    jsmath::round(x * 1e4) / 1e4
}

/// `canonicalGenome(g)`: sorted-key JSON with JS number formatting.
pub fn canonical_genome(g: &Genome) -> String {
    format!(
        "{{\"density\":{},\"nInterL1\":{},\"nInterL2\":{},\"nModulatory\":{},\"nMotorPerChannel\":{},\"nSensory\":{},\"seed\":{},\"v\":{}}}",
        jsmath::number_to_string(g.density),
        g.n_inter_l1,
        g.n_inter_l2,
        g.n_modulatory,
        g.n_motor_per_channel,
        g.n_sensory,
        g.seed,
        g.v
    )
}

/// `genomeFromOptions(opts)` with every option already effective.
pub fn genome_from_options(o: &ConnectomeOptions) -> Genome {
    Genome {
        v: GENOME_SCHEMA_VERSION,
        seed: o.seed,
        n_sensory: o.n_sensory as i64,
        n_inter_l1: o.n_inter_l1 as i64,
        n_inter_l2: o.n_inter_l2 as i64,
        n_modulatory: o.n_modulatory as i64,
        n_motor_per_channel: o.n_motor_per_channel as i64,
        density: round4(o.density),
    }
}

pub fn genome_to_connectome_options(g: &Genome) -> ConnectomeOptions {
    ConnectomeOptions {
        seed: g.seed,
        n_sensory: g.n_sensory.max(0) as usize,
        n_inter_l1: g.n_inter_l1.max(0) as usize,
        n_inter_l2: g.n_inter_l2.max(0) as usize,
        n_modulatory: g.n_modulatory.max(0) as usize,
        n_motor_per_channel: g.n_motor_per_channel.max(0) as usize,
        density: g.density,
    }
}

pub fn build_from_genome(g: &Genome) -> Connectome {
    build_connectome(&genome_to_connectome_options(g))
}

/// POINT MUTATION — pure in (parent, rngSeed). Draw order: seed xor, field pick, step, sign,
/// density coin, density direction.
pub fn mutate_genome(parent: &Genome, rng_seed: u32) -> Genome {
    let mut rng = Mulberry32::new(rng_seed);
    let mut child = parent.clone();
    child.v = GENOME_SCHEMA_VERSION;
    // Math.floor(rng() * 4294967296) is exactly the raw u32 draw.
    child.seed = parent.seed ^ rng.next_u32();
    let f = SIZE_FIELDS[(rng.next() * SIZE_FIELDS.len() as f64).floor() as usize];
    let pf = parent.get(f) as f64;
    let step = 1.0 + (rng.next() * jsmath::max(1.0, jsmath::round(pf * 0.15))).floor();
    let delta = (if rng.next() < 0.5 { -1.0 } else { 1.0 }) * step;
    let (lo, hi) = bounds(f);
    child.set(f, clamp_int(pf + delta, lo, hi) as i64);
    if rng.next() < 0.5 {
        let d = parent.density + (if rng.next() < 0.5 { -0.001 } else { 0.001 });
        child.density = round4(clamp(d, DENSITY_BOUNDS.0, DENSITY_BOUNDS.1));
    }
    child
}

/// UNIFORM CROSSOVER — pure in (a, b, rngSeed). One coin per field, in field order.
pub fn crossover_genome(a: &Genome, b: &Genome, rng_seed: u32) -> Genome {
    let mut rng = Mulberry32::new(rng_seed);
    let seed = if rng.next() < 0.5 { a.seed } else { b.seed };
    let n_sensory = if rng.next() < 0.5 { a.n_sensory } else { b.n_sensory };
    let n_inter_l1 = if rng.next() < 0.5 { a.n_inter_l1 } else { b.n_inter_l1 };
    let n_inter_l2 = if rng.next() < 0.5 { a.n_inter_l2 } else { b.n_inter_l2 };
    let n_modulatory = if rng.next() < 0.5 { a.n_modulatory } else { b.n_modulatory };
    let n_motor_per_channel = if rng.next() < 0.5 { a.n_motor_per_channel } else { b.n_motor_per_channel };
    let density = round4(if rng.next() < 0.5 { a.density } else { b.density });
    Genome {
        v: GENOME_SCHEMA_VERSION,
        seed,
        n_sensory,
        n_inter_l1,
        n_inter_l2,
        n_modulatory,
        n_motor_per_channel,
        density,
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct SizeEstimate {
    pub neurons: i64,
    pub synapses: i64,
}

fn channel_count(n: i64, r: i64, m: i64) -> i64 {
    if n <= r {
        return 0;
    }
    ((n - r - 1) as f64 / m as f64).floor() as i64 + 1
}

/// `estimateConnectomeSize(g)` — closed-form, no build.
pub fn estimate_connectome_size(g: &Genome) -> SizeEstimate {
    let n_sens = g.n_sensory.max(0);
    let n_l1 = g.n_inter_l1.max(0);
    let n_l2 = g.n_inter_l2.max(0);
    let n_mod = g.n_modulatory.max(0);
    let n_motor_per = g.n_motor_per_channel.max(0);
    let d = jsmath::max(0.0, g.density);

    let l2_half = (n_l2 as f64 / 2.0).floor() as i64;
    let l2_right = n_l2 - l2_half;
    let neurons = n_sens + n_l1 + n_l2 + n_mod + 5 * n_motor_per;

    let fan = |from_size: i64, dens: f64| -> i64 { ((from_size as f64 * dens).floor() as i64).max(1) };

    let mut syn: i64 = 0;
    syn += n_l1 * fan(n_sens, d * 1.5);
    syn += n_l2 * fan(n_l1, d * 1.2);
    syn += l2_right * fan(l2_half, d * 0.8);
    syn += l2_half * fan(l2_right, d * 0.8);
    syn += l2_half * fan(l2_half, d * 0.3);
    syn += l2_right * fan(l2_right, d * 0.3);
    syn += n_motor_per * 40;
    syn += n_motor_per * 40;
    syn += 2 * n_motor_per * 30;
    let gus = channel_count(n_sens, 4, 10);
    syn += n_motor_per * gus.clamp(1, 6);
    syn += (0.05 * neurons as f64).ceil() as i64;
    syn += n_mod * fan(n_sens + n_l1, d * 0.4);
    let threat = channel_count(n_sens, 7, 10);
    syn += ((threat * n_mod) as f64 * 0.25).ceil() as i64;

    SizeEstimate { neurons, synapses: syn }
}
