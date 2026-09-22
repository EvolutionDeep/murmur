//! Port of manifest.ts — `connectomeStructuralSpec` (the quantised, replayable brain identity).

use crate::connectome::{Connectome, NeuronKind, MOTOR_CHANNELS, SENSORY_CHANNELS};
use crate::jsmath;
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct ConnectomeStructuralSpec {
    #[serde(rename = "neuronCount")]
    pub neuron_count: i64,
    #[serde(rename = "synapseCount")]
    pub synapse_count: i64,
    #[serde(rename = "byKind")]
    pub by_kind: BTreeMap<String, i64>,
    #[serde(rename = "motorChannels")]
    pub motor_channels: BTreeMap<String, i64>,
    #[serde(rename = "sensoryChannels")]
    pub sensory_channels: BTreeMap<String, i64>,
    #[serde(rename = "tauMicro")]
    pub tau_micro: f64,
    #[serde(rename = "threshMicro")]
    pub thresh_micro: f64,
    #[serde(rename = "weightMilli")]
    pub weight_milli: f64,
    #[serde(rename = "fanInMeanMilli")]
    pub fan_in_mean_milli: f64,
    #[serde(rename = "fanInMax")]
    pub fan_in_max: i64,
    #[serde(rename = "edgeHash")]
    pub edge_hash: String,
}

#[inline]
fn fnv_byte(h: u32, byte: u32) -> u32 {
    jsmath::imul(h ^ (byte & 0xff), 0x0100_0193)
}

#[inline]
fn fnv_int(h: u32, n: i32) -> u32 {
    let u = n as u32;
    let mut x = h;
    x = fnv_byte(x, u & 0xff);
    x = fnv_byte(x, (u >> 8) & 0xff);
    x = fnv_byte(x, (u >> 16) & 0xff);
    x = fnv_byte(x, (u >> 24) & 0xff);
    x
}

pub fn connectome_structural_spec(conn: &Connectome) -> ConnectomeStructuralSpec {
    let mut by_kind = BTreeMap::new();
    for k in NeuronKind::ALL {
        by_kind.insert(k.as_str().to_string(), conn.by_kind[k.index()].len() as i64);
    }
    let mut motor_channels = BTreeMap::new();
    for ch in MOTOR_CHANNELS {
        motor_channels.insert(ch.as_str().to_string(), conn.motor_ids[ch.index()].len() as i64);
    }
    let mut sensory_channels = BTreeMap::new();
    for ch in SENSORY_CHANNELS {
        sensory_channels.insert(ch.as_str().to_string(), conn.sensory_ids[ch.index()].len() as i64);
    }

    let mut tau_micro = 0.0f64;
    let mut thresh_micro = 0.0f64;
    for n in &conn.neurons {
        tau_micro += jsmath::round(n.tau * 1e6);
        thresh_micro += jsmath::round(n.v_thresh * 1e6);
    }

    let mut weight_milli = 0.0f64;
    let mut edge: u32 = 0x811c_9dc5;
    let mut fan_in = vec![0i32; conn.neurons.len()];
    for s in &conn.synapses {
        let wq = jsmath::round(s.w * 1e3);
        weight_milli += wq;
        edge = fnv_int(edge, jsmath::to_int32(s.pre as f64));
        edge = fnv_int(edge, jsmath::to_int32(s.post as f64));
        edge = fnv_int(edge, jsmath::to_int32(wq));
        if (s.post as usize) < fan_in.len() {
            fan_in[s.post as usize] += 1;
        }
    }

    let mut fan_sum = 0.0f64;
    let mut fan_max = 0i32;
    for &f in &fan_in {
        fan_sum += f as f64;
        if f > fan_max {
            fan_max = f;
        }
    }
    let fan_in_mean_milli = if !fan_in.is_empty() { jsmath::round((fan_sum / fan_in.len() as f64) * 1e3) } else { 0.0 };

    ConnectomeStructuralSpec {
        neuron_count: conn.neurons.len() as i64,
        synapse_count: conn.synapses.len() as i64,
        by_kind,
        motor_channels,
        sensory_channels,
        tau_micro,
        thresh_micro,
        weight_milli,
        fan_in_mean_milli,
        fan_in_max: fan_max as i64,
        edge_hash: format!("{edge:08x}"),
    }
}
