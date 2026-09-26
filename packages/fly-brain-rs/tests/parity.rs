//! Bit-exact parity against the TypeScript reference (packages/fly-brain), replaying the traces
//! written by tests/gen/gen_fixtures.ts (and, for the `#[ignore]`d fuzz tests, tests/gen/gen_fuzz.ts).
//!
//! Comparison rules: f32 state is compared by bit pattern (`to_bits`), f64 values by exact `==`
//! on the parsed number (NaN never appears), integers exactly. No tolerances anywhere.

// Index loops are kept where the index is part of the failure message.
#![allow(clippy::needless_range_loop)]

use fly_brain_rs::brain::{BrainArchive, FlyBrain};
use fly_brain_rs::connectome::{
    build_connectome, ConnectomeOptions, MotorChannel, NeuronKind, SensoryChannel, MOTOR_CHANNELS, SENSORY_CHANNELS,
};
use fly_brain_rs::genome::{
    canonical_genome, crossover_genome, estimate_connectome_size, genome_to_connectome_options, mutate_genome, Genome,
};
use fly_brain_rs::jsmath;
use fly_brain_rs::manifest::connectome_structural_spec;
use fly_brain_rs::prng::{Mulberry32, XorShift32};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::path::PathBuf;

/// Fixture directory, in order: `$FLY_BRAIN_RS_FIXTURES` (to run the suite against fixtures generated
/// on another platform / Node build), then `tests/fixtures` when the full generated set is present
/// (`gen_fixtures.ts`), else the small committed set in `tests/fixtures/small`
/// (`gen_fixtures.ts --small`).
fn fixture_dir() -> PathBuf {
    if let Some(d) = std::env::var_os("FLY_BRAIN_RS_FIXTURES") {
        return PathBuf::from(d);
    }
    let full = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures");
    if full.join("prng.json").exists() {
        full
    } else {
        full.join("small")
    }
}

/// Fixture files `<prefix>*.json` in the fixture directory (sorted); at least one must exist.
fn fixture_names(prefix: &str) -> Vec<String> {
    let dir = fixture_dir();
    let mut names: Vec<String> = std::fs::read_dir(&dir)
        .unwrap_or_else(|e| panic!("read fixture dir {}: {e}", dir.display()))
        .filter_map(|e| e.ok())
        .map(|e| e.file_name().to_string_lossy().into_owned())
        .filter(|n| n.starts_with(prefix) && n.ends_with(".json"))
        .collect();
    names.sort();
    assert!(!names.is_empty(), "no {prefix}*.json in {} (run tests/gen/gen_fixtures.ts)", dir.display());
    names
}

fn fixture(name: &str) -> Value {
    let p = fixture_dir().join(name);
    let bytes =
        std::fs::read(&p).unwrap_or_else(|e| panic!("read {}: {e} (run tests/gen/gen_fixtures.ts)", p.display()));
    serde_json::from_slice(&bytes).unwrap()
}

fn f64_of(v: &Value) -> f64 {
    v.as_f64().unwrap_or_else(|| panic!("not a number: {v}"))
}
fn bits_hex(x: f64) -> String {
    format!("{:016x}", x.to_bits())
}

// ------------------------------------------------------------------------------------ PRNG

#[test]
fn prng_mulberry32_and_xorshift() {
    let fx = fixture("prng.json");
    for case in fx["cases"].as_array().unwrap() {
        let seed = case["seed"].as_u64().unwrap() as u32;
        let mut rc = Mulberry32::new(seed);
        let mut rg = Mulberry32::new(seed);
        let conn = case["connectome"].as_array().unwrap();
        let conn_u32 = case["connectomeU32"].as_array().unwrap();
        let gen = case["genome"].as_array().unwrap();
        let gen_u32 = case["genomeU32"].as_array().unwrap();
        for i in 0..64 {
            let mut probe = rc.clone();
            let u = probe.next_u32();
            assert_eq!(u as u64, conn_u32[i].as_u64().unwrap(), "seed {seed} connectome u32 #{i}");
            let c = rc.next();
            assert_eq!(c, f64_of(&conn[i]), "seed {seed} connectome float #{i}");
            let mut probe = rg.clone();
            assert_eq!(probe.next_u32() as u64, gen_u32[i].as_u64().unwrap(), "seed {seed} genome u32 #{i}");
            let g = rg.next();
            assert_eq!(g, f64_of(&gen[i]), "seed {seed} genome float #{i}");
        }
        let mut xs = XorShift32::new(seed);
        for (i, want) in case["xorshift"].as_array().unwrap().iter().enumerate() {
            assert_eq!(xs.next(), f64_of(want), "seed {seed} xorshift #{i}");
        }
    }
}

// ------------------------------------------------------------------------------------ Math

/// On a transcendental mismatch, say which Node build wrote the fixture and which contraction mode
/// this crate was built with — the usual cause is running arm64 (FMA) fixtures against a
/// `--no-default-features` build or x86-64 fixtures against the default (see README "Platform note").
fn platform_hint(fx: &Value) -> String {
    let mode = if cfg!(feature = "fma") {
        "fma ON (default; matches arm64 Node)"
    } else {
        "fma OFF (matches baseline x86-64 Node)"
    };
    format!(
        "fixture written by Node {} on {}/{}; this crate was built with {mode}",
        fx["node"].as_str().unwrap_or("?"),
        fx["platform"].as_str().unwrap_or("?"),
        fx["arch"].as_str().unwrap_or("?")
    )
}

fn check_fn(name: &str, pairs: &[Value], f: impl Fn(f64) -> f64) -> usize {
    let mut bad = 0;
    for (i, p) in pairs.iter().enumerate() {
        let x = f64::from_bits(u64::from_str_radix(p[0].as_str().unwrap(), 16).unwrap());
        let want = f64::from_bits(u64::from_str_radix(p[1].as_str().unwrap(), 16).unwrap());
        let got = f(x);
        if got.to_bits() != want.to_bits() {
            if bad < 5 {
                eprintln!(
                    "{name} #{i}: x={x:e} ({}) want={} ({}) got={} ({})",
                    bits_hex(x),
                    want,
                    bits_hex(want),
                    got,
                    bits_hex(got)
                );
            }
            bad += 1;
        }
    }
    bad
}

#[test]
fn math_log_matches_v8() {
    let fx = fixture("mathfns.json");
    assert_eq!(check_fn("log", fx["log"].as_array().unwrap(), jsmath::log), 0, "log: {}", platform_hint(&fx));
}
#[test]
fn math_cos_matches_v8() {
    let fx = fixture("mathfns.json");
    assert_eq!(check_fn("cos", fx["cos"].as_array().unwrap(), jsmath::cos), 0, "cos: {}", platform_hint(&fx));
}
#[test]
fn math_exp_matches_v8() {
    let fx = fixture("mathfns.json");
    assert_eq!(check_fn("exp", fx["exp"].as_array().unwrap(), jsmath::exp), 0, "exp: {}", platform_hint(&fx));
}
#[test]
fn math_tanh_matches_v8() {
    let fx = fixture("mathfns.json");
    assert_eq!(check_fn("tanh", fx["tanh"].as_array().unwrap(), jsmath::tanh), 0, "tanh: {}", platform_hint(&fx));
}
#[test]
fn math_sqrt_matches_v8() {
    let fx = fixture("mathfns.json");
    assert_eq!(check_fn("sqrt", fx["sqrt"].as_array().unwrap(), jsmath::sqrt), 0, "sqrt: {}", platform_hint(&fx));
}
#[test]
fn math_cos_sin_argument_reduction_paths() {
    let fx = fixture("mathfns.json");
    assert_eq!(
        check_fn("cosExtra", fx["cosExtra"].as_array().unwrap(), jsmath::cos),
        0,
        "cosExtra: {}",
        platform_hint(&fx)
    );
    assert_eq!(
        check_fn("sinExtra", fx["sinExtra"].as_array().unwrap(), fly_brain_rs::v8math::sin),
        0,
        "sinExtra: {}",
        platform_hint(&fx)
    );
}
#[test]
fn math_exp_log_tanh_edge_ranges() {
    let fx = fixture("mathfns.json");
    assert_eq!(
        check_fn("expExtra", fx["expExtra"].as_array().unwrap(), jsmath::exp),
        0,
        "expExtra: {}",
        platform_hint(&fx)
    );
    assert_eq!(
        check_fn("logExtra", fx["logExtra"].as_array().unwrap(), jsmath::log),
        0,
        "logExtra: {}",
        platform_hint(&fx)
    );
    assert_eq!(
        check_fn("tanhExtra", fx["tanhExtra"].as_array().unwrap(), jsmath::tanh),
        0,
        "tanhExtra: {}",
        platform_hint(&fx)
    );
}
#[test]
fn math_constants_match_v8() {
    let fx = fixture("mathfns.json");
    let c = &fx["constants"];
    let want = |k: &str| u64::from_str_radix(c[k].as_str().unwrap(), 16).unwrap();
    assert_eq!(jsmath::exp(-1.0 / 5.0).to_bits(), want("synDecay"), "synDecay");
    assert_eq!(jsmath::exp(-1.0 / 200.0).to_bits(), want("adaptDecay"), "adaptDecay");
    assert_eq!(jsmath::exp(-1.0 / 20.0).to_bits(), want("extDecay"), "extDecay");
    assert_eq!((2.0 * std::f64::consts::PI).to_bits(), want("twoPi"), "twoPi");
    assert_eq!((0.3f64 * 1.0 * 0.05).to_bits(), want("noiseThreshold"), "noiseThreshold");
}

// ------------------------------------------------------------------------------------ connectome

fn opts_from(seed: u32, o: &Value) -> ConnectomeOptions {
    ConnectomeOptions {
        seed,
        n_sensory: o["nSensory"].as_u64().unwrap() as usize,
        n_inter_l1: o["nInterL1"].as_u64().unwrap() as usize,
        n_inter_l2: o["nInterL2"].as_u64().unwrap() as usize,
        n_modulatory: o["nModulatory"].as_u64().unwrap() as usize,
        n_motor_per_channel: o["nMotorPerChannel"].as_u64().unwrap() as usize,
        density: f64_of(&o["density"]),
    }
}

fn check_connectome(name: &str) {
    let fx = fixture(name);
    let seed = fx["seed"].as_u64().unwrap() as u32;
    let opts = opts_from(seed, &fx["opts"]);
    let c = build_connectome(&opts);

    let neurons = fx["neurons"].as_array().unwrap();
    assert_eq!(c.neurons.len(), neurons.len(), "neuron count");
    for (i, n) in neurons.iter().enumerate() {
        let m = &c.neurons[i];
        assert_eq!(m.id, n["id"].as_u64().unwrap() as usize, "neuron {i} id");
        assert_eq!(m.kind.as_str(), n["kind"].as_str().unwrap(), "neuron {i} kind");
        let ch = n["channel"].as_str();
        assert_eq!(m.channel.map(|c| c.as_str()), ch, "neuron {i} channel");
        assert_eq!(m.tau.to_bits(), f64_of(&n["tau"]).to_bits(), "neuron {i} tau");
        assert_eq!(m.v_rest.to_bits(), f64_of(&n["vRest"]).to_bits(), "neuron {i} vRest");
        assert_eq!(m.v_thresh.to_bits(), f64_of(&n["vThresh"]).to_bits(), "neuron {i} vThresh");
        assert_eq!(m.v_reset.to_bits(), f64_of(&n["vReset"]).to_bits(), "neuron {i} vReset");
        assert_eq!(m.refractory.to_bits(), f64_of(&n["refractory"]).to_bits(), "neuron {i} refractory");
    }

    let synapses = fx["synapses"].as_array().unwrap();
    assert_eq!(c.synapses.len(), synapses.len(), "synapse count");
    let mut first_bad: Option<usize> = None;
    let mut bad = 0;
    for (i, s) in synapses.iter().enumerate() {
        let got = &c.synapses[i];
        let pre = s[0].as_u64().unwrap() as u32;
        let post = s[1].as_u64().unwrap() as u32;
        let w = f64_of(&s[2]);
        if got.pre != pre || got.post != post || got.w.to_bits() != w.to_bits() {
            if first_bad.is_none() {
                first_bad = Some(i);
                eprintln!(
                    "seed {seed} synapse {i}: want (pre {pre}, post {post}, w {w} {}) got (pre {}, post {}, w {} {})",
                    bits_hex(w),
                    got.pre,
                    got.post,
                    got.w,
                    bits_hex(got.w)
                );
            }
            bad += 1;
        }
    }
    assert_eq!(bad, 0, "seed {seed}: {bad} synapses differ (first at {:?})", first_bad);

    // indices
    for k in NeuronKind::ALL {
        let want: Vec<usize> =
            fx["byKind"][k.as_str()].as_array().unwrap().iter().map(|v| v.as_u64().unwrap() as usize).collect();
        assert_eq!(c.by_kind[k.index()], want, "byKind {}", k.as_str());
    }
    for (name, ids) in fx["byChannel"].as_object().unwrap() {
        let want: Vec<usize> = ids.as_array().unwrap().iter().map(|v| v.as_u64().unwrap() as usize).collect();
        assert_eq!(c.channel_ids(name).unwrap(), &want[..], "byChannel {name}");
    }

    // structural spec (manifest.ts)
    let spec = connectome_structural_spec(&c);
    let want: fly_brain_rs::manifest::ConnectomeStructuralSpec = serde_json::from_value(fx["spec"].clone()).unwrap();
    assert_eq!(spec, want, "structural spec");
}

/// Every `connectome_<seed>.json` in the fixture directory (3 in the full set, 1 in the small set).
#[test]
fn connectome_fixtures() {
    let names = fixture_names("connectome_");
    for name in &names {
        check_connectome(name);
    }
    eprintln!("connectome: {} fixture(s) bit-exact: {}", names.len(), names.join(", "));
}

// ------------------------------------------------------------------------------------ dynamics

fn cmp_f32_array(label: &str, seed: u32, step: u64, got: &[f32], want: &[Value]) {
    assert_eq!(got.len(), want.len(), "{label} length");
    for i in 0..got.len() {
        let w = f64_of(&want[i]) as f32;
        if got[i].to_bits() != w.to_bits() {
            panic!(
                "seed {seed} step {step} {label}[{i}]: want {w} ({:08x}) got {} ({:08x})",
                w.to_bits(),
                got[i],
                got[i].to_bits()
            );
        }
    }
}

fn cmp_motor(label: &str, got: &fly_brain_rs::brain::MotorOutput, want: &Value) {
    assert_eq!(got.channel.as_str(), want["channel"].as_str().unwrap(), "{label} channel");
    assert_eq!(
        got.firing_rate.to_bits(),
        f64_of(&want["firingRate"]).to_bits(),
        "{label} firingRate: got {} want {}",
        got.firing_rate,
        want["firingRate"]
    );
    assert_eq!(got.spikes as u64, want["spikes"].as_u64().unwrap(), "{label} spikes");
    assert_eq!(
        got.normalized.to_bits(),
        f64_of(&want["normalized"]).to_bits(),
        "{label} normalized: got {} want {}",
        got.normalized,
        want["normalized"]
    );
}

fn check_dynamics(name: &str) {
    let fx = fixture(name);
    let seed = fx["seed"].as_u64().unwrap() as u32;
    let opts = opts_from(seed, &fx["opts"]);
    let mut brain = FlyBrain::new(&opts);
    let inject: Vec<(SensoryChannel, f64)> = fx["inject"]
        .as_array()
        .unwrap()
        .iter()
        .map(|v| (SensoryChannel::from_str(v["channel"].as_str().unwrap()).unwrap(), f64_of(&v["intensity"])))
        .collect();
    let steps = fx["steps"].as_u64().unwrap();
    let snapshots = fx["snapshots"].as_array().unwrap();
    // Per-step sha256 of the full state (every step) — the first mismatch names the exact step;
    // the full-array snapshots below then name the element and bit.
    let hashes = fx["hashes"].as_array().unwrap();
    assert_eq!(hashes.len() as u64, steps, "one state hash per step");
    let mut si = 0;
    for step in 1..=steps {
        for &(ch, x) in &inject {
            brain.inject(ch, x);
        }
        brain.tick(1.0);
        let want_hash = hashes[(step - 1) as usize].as_str().unwrap();
        let next_snap = if si < snapshots.len() && snapshots[si]["step"].as_u64().unwrap() == step {
            Some(&snapshots[si])
        } else {
            None
        };
        if state_hash(&brain) != want_hash && next_snap.is_none() {
            panic!("seed {seed} step {step}: state hash differs (first divergent step; no full snapshot at this step)");
        }
        if let Some(snap) = next_snap {
            si += 1;
            assert_eq!(brain.step(), step);
            assert_eq!(brain.t().to_bits(), f64_of(&snap["t"]).to_bits(), "t at step {step}");
            let net = &brain.net;
            // membraneBits is the authoritative f32 pattern; membrane (numbers) must agree with it
            let bits = snap["membraneBits"].as_array().unwrap();
            for i in 0..net.v.len() {
                let want = u32::from_str_radix(bits[i].as_str().unwrap(), 16).unwrap();
                if net.v[i].to_bits() != want {
                    panic!(
                        "seed {seed} step {step} membrane[{i}]: want {} ({want:08x}) got {} ({:08x})",
                        f32::from_bits(want),
                        net.v[i],
                        net.v[i].to_bits()
                    );
                }
            }
            cmp_f32_array("membrane", seed, step, &net.v, snap["membrane"].as_array().unwrap());
            let spikes: Vec<u8> =
                snap["spikesLastStep"].as_array().unwrap().iter().map(|v| v.as_u64().unwrap() as u8).collect();
            assert_eq!(net.spiking, spikes, "seed {seed} step {step} spikesLastStep");
            cmp_f32_array("firingRates", seed, step, &net.firing_rate, snap["firingRates"].as_array().unwrap());
            cmp_f32_array("Isyn", seed, step, &net.isyn, snap["Isyn"].as_array().unwrap());
            cmp_f32_array("Iext", seed, step, &net.iext, snap["Iext"].as_array().unwrap());
            cmp_f32_array("adaptation", seed, step, &net.adaptation, snap["adaptation"].as_array().unwrap());
            cmp_f32_array("lastSpikeT", seed, step, &net.last_spike_t, snap["lastSpikeT"].as_array().unwrap());
            assert_eq!(
                brain.noise_state() as u64,
                snap["noiseState"].as_u64().unwrap(),
                "seed {seed} step {step} noiseState"
            );
            let motor = snap["motor"].as_array().unwrap();
            for (k, ch) in MOTOR_CHANNELS.iter().enumerate() {
                cmp_motor(&format!("seed {seed} step {step} motor {}", ch.as_str()), &brain.read_motor(*ch), &motor[k]);
            }
            assert_eq!(state_hash(&brain), snap["hash"].as_str().unwrap(), "seed {seed} step {step} snapshot hash");
            assert_eq!(state_hash(&brain), want_hash, "seed {seed} step {step} per-step hash");
        }
    }
    assert_eq!(si, snapshots.len(), "all snapshots consumed");
    // readMotor(windowMs) is a no-op argument in the reference
    for (k, ch) in MOTOR_CHANNELS.iter().enumerate() {
        cmp_motor("motorWindow100", &brain.read_motor(*ch), &fx["motorWindow100"][k]);
        cmp_motor("motorWindowDefault", &brain.read_motor(*ch), &fx["motorWindowDefault"][k]);
        cmp_motor("readAllMotor", &brain.read_all_motor()[k], &fx["readAllMotor"][k]);
    }
}

/// Every `dynamics_<seed>.json` in the fixture directory (3 × 2000 steps in the full set,
/// 1 × 500 steps in the small set).
#[test]
fn dynamics_fixtures() {
    let names = fixture_names("dynamics_");
    for name in &names {
        check_dynamics(name);
    }
    eprintln!("dynamics: {} fixture(s) bit-exact: {}", names.len(), names.join(", "));
}

// ------------------------------------------------------------------------------------ genome ops

fn genome_eq(label: &str, got: &Genome, want: &Value) {
    let w: Genome = serde_json::from_value(want.clone()).unwrap();
    assert_eq!(got.v, w.v, "{label} v");
    assert_eq!(got.seed, w.seed, "{label} seed");
    assert_eq!(got.n_sensory, w.n_sensory, "{label} nSensory");
    assert_eq!(got.n_inter_l1, w.n_inter_l1, "{label} nInterL1");
    assert_eq!(got.n_inter_l2, w.n_inter_l2, "{label} nInterL2");
    assert_eq!(got.n_modulatory, w.n_modulatory, "{label} nModulatory");
    assert_eq!(got.n_motor_per_channel, w.n_motor_per_channel, "{label} nMotorPerChannel");
    assert_eq!(got.density.to_bits(), w.density.to_bits(), "{label} density: got {} want {}", got.density, w.density);
}

#[test]
fn genome_operators() {
    let fx = fixture("genome_ops.json");
    for (i, case) in fx["cases"].as_array().unwrap().iter().enumerate() {
        let a: Genome = serde_json::from_value(case["a"].clone()).unwrap();
        let b: Genome = serde_json::from_value(case["b"].clone()).unwrap();
        let rng_seed = case["rngSeed"].as_u64().unwrap() as u32;
        genome_eq(&format!("case {i} mutateA"), &mutate_genome(&a, rng_seed), &case["mutateA"]);
        genome_eq(&format!("case {i} mutateB"), &mutate_genome(&b, rng_seed), &case["mutateB"]);
        genome_eq(
            &format!("case {i} mutateA_plus1"),
            &mutate_genome(&a, rng_seed.wrapping_add(1)),
            &case["mutateA_plus1"],
        );
        genome_eq(&format!("case {i} crossover"), &crossover_genome(&a, &b, rng_seed), &case["crossover"]);
        genome_eq(
            &format!("case {i} crossover_plus1"),
            &crossover_genome(&a, &b, rng_seed.wrapping_add(1)),
            &case["crossover_plus1"],
        );
        assert_eq!(canonical_genome(&a), case["canonicalA"].as_str().unwrap(), "case {i} canonicalA");
        let ea = estimate_connectome_size(&a);
        assert_eq!(ea.neurons, case["estimateA"]["neurons"].as_i64().unwrap(), "case {i} estimateA.neurons");
        assert_eq!(ea.synapses, case["estimateA"]["synapses"].as_i64().unwrap(), "case {i} estimateA.synapses");
        let eb = estimate_connectome_size(&b);
        assert_eq!(eb.neurons, case["estimateB"]["neurons"].as_i64().unwrap(), "case {i} estimateB.neurons");
        assert_eq!(eb.synapses, case["estimateB"]["synapses"].as_i64().unwrap(), "case {i} estimateB.synapses");
    }
    let chain = fx["chain"].as_array().unwrap();
    let mut g: Genome = serde_json::from_value(chain[0].clone()).unwrap();
    for i in 1..chain.len() {
        g = mutate_genome(&g, 1000 + (i as u32 - 1));
        genome_eq(&format!("chain {i}"), &g, &chain[i]);
    }
}

// Genome JSON round-trips byte-for-byte through serde.
#[test]
fn genome_json_roundtrip() {
    let fx = fixture("genome_ops.json");
    let a = &fx["cases"][0]["a"];
    let g: Genome = serde_json::from_value(a.clone()).unwrap();
    assert_eq!(serde_json::to_value(&g).unwrap(), *a);
    let _ = MotorChannel::from_str("wing").unwrap();
}

// ------------------------------------------------------------------------------------ fuzz parity
//
// Mirrors the protocol in tests/gen/gen_fuzz.ts verbatim (stimulus stream, state digest). The
// fixture carries sha256 digests of the full f32 state every 100 steps instead of the arrays, so
// ~250k brain-steps over ~230 random genomes (uniform within GENOME_BOUNDS, 10x-sized, and
// bounds corners) fit in a few hundred KB.

const STIM_XOR: u32 = 0x5f37_59df;

fn fuzz_step(brain: &mut FlyBrain, rng: &mut Mulberry32) -> u64 {
    let mut injected = 0;
    if rng.next() >= 0.15 {
        for ch in SENSORY_CHANNELS {
            if rng.next() < 0.35 {
                let intensity = if rng.next() < 0.1 { rng.next() * 5.0 } else { rng.next() * 1.2 };
                brain.inject(ch, intensity);
                injected += 1;
            }
        }
    }
    brain.tick(1.0);
    injected
}

/// sha256 over the little-endian bytes of V, Isyn, Iext, adaptation, lastSpikeT, firingRate, then
/// the spike flags — the same bytes `Buffer.from(typedArray.buffer)` hashes in gen_fuzz.ts.
fn state_hash(brain: &FlyBrain) -> String {
    let net = &brain.net;
    let mut h = Sha256::new();
    for arr in [&net.v, &net.isyn, &net.iext, &net.adaptation, &net.last_spike_t, &net.firing_rate] {
        let mut bytes = Vec::with_capacity(arr.len() * 4);
        for x in arr.iter() {
            bytes.extend_from_slice(&x.to_le_bytes());
        }
        h.update(&bytes);
    }
    h.update(&net.spiking);
    format!("{:x}", h.finalize())
}

fn spikes_now(brain: &FlyBrain) -> u64 {
    brain.net.spiking.iter().map(|&s| s as u64).sum()
}

fn genome_of(v: &Value) -> Genome {
    serde_json::from_value(v.clone()).unwrap()
}

fn check_end_state(label: &str, brain: &FlyBrain, want: &Value) {
    assert_eq!(brain.noise_state() as u64, want["noiseState"].as_u64().unwrap(), "{label} noiseState");
    assert_eq!(brain.t().to_bits(), f64_of(&want["t"]).to_bits(), "{label} t");
    assert_eq!(brain.step(), want["step"].as_u64().unwrap(), "{label} step");
    if let Some(motor) = want["motor"].as_array() {
        for (k, ch) in MOTOR_CHANNELS.iter().enumerate() {
            cmp_motor(&format!("{label} motor {}", ch.as_str()), &brain.read_motor(*ch), &motor[k]);
        }
    }
}

/// Runs the fixture's fuzz cases whose `kind` passes `filter`; returns (genomes, brain-steps).
fn run_fuzz_cases(filter: impl Fn(&str) -> bool) -> (usize, u64) {
    let fx = fixture("fuzz.json");
    assert_eq!(fx["protocol"]["stimXor"].as_u64().unwrap(), STIM_XOR as u64, "stimulus protocol seed");
    let mut genomes = 0usize;
    let mut steps_done = 0u64;
    for (ci, case) in fx["cases"].as_array().unwrap().iter().enumerate() {
        let kind = case["kind"].as_str().unwrap();
        if !filter(kind) {
            continue;
        }
        let genome = genome_of(&case["genome"]);
        let label = format!("fuzz case {ci} ({kind}) genome {}", canonical_genome(&genome));
        let opts = genome_to_connectome_options(&genome);
        let mut brain = FlyBrain::new(&opts);
        assert_eq!(brain.net.n as u64, case["neurons"].as_u64().unwrap(), "{label} neurons");
        assert_eq!(brain.net.s as u64, case["synapses"].as_u64().unwrap(), "{label} synapses");
        let mut rng = Mulberry32::new(genome.seed ^ STIM_XOR);
        let steps = case["steps"].as_u64().unwrap();
        let checkpoints = case["checkpoints"].as_array().unwrap();
        let mut ck = 0usize;
        let mut spikes_total = 0u64;
        let mut injections = 0u64;
        for step in 1..=steps {
            injections += fuzz_step(&mut brain, &mut rng);
            spikes_total += spikes_now(&brain);
            if ck < checkpoints.len() && checkpoints[ck]["step"].as_u64().unwrap() == step {
                let want = checkpoints[ck]["hash"].as_str().unwrap();
                let got = state_hash(&brain);
                assert_eq!(got, want, "{label}: state hash differs at step {step} (first divergent checkpoint)");
                ck += 1;
            }
        }
        assert_eq!(ck, checkpoints.len(), "{label}: all checkpoints consumed");
        assert_eq!(spikes_total, case["spikesTotal"].as_u64().unwrap(), "{label} spikesTotal");
        assert_eq!(injections, case["injections"].as_u64().unwrap(), "{label} injections");
        check_end_state(&label, &brain, case);
        genomes += 1;
        steps_done += steps;
    }
    (genomes, steps_done)
}

#[test]
#[ignore = "needs tests/fixtures/fuzz.json from tests/gen/gen_fuzz.ts; run with --include-ignored"]
fn fuzz_uniform_genomes() {
    let (g, s) = run_fuzz_cases(|k| k == "uniform");
    eprintln!("fuzz uniform: {g} genomes, {s} brain-steps, all bit-exact");
    assert!(g >= 200, "expected >= 200 uniform genomes, fixture has {g}");
}

#[test]
#[ignore = "needs tests/fixtures/fuzz.json from tests/gen/gen_fuzz.ts; run with --include-ignored"]
fn fuzz_10x_and_bounds_edges() {
    let (g, s) = run_fuzz_cases(|k| k == "10x" || k == "edge");
    eprintln!("fuzz 10x+edge: {g} genomes, {s} brain-steps, all bit-exact");
    assert!(g >= 30, "expected >= 30 10x/edge genomes, fixture has {g}");
}

#[test]
#[ignore = "needs tests/fixtures/fuzz.json from tests/gen/gen_fuzz.ts; run with --include-ignored"]
fn fuzz_long_runs() {
    let fx = fixture("fuzz.json");
    let mut n = 0;
    for case in fx["long"].as_array().unwrap() {
        let genome = genome_of(&case["genome"]);
        let label = format!("long run genome {}", canonical_genome(&genome));
        let mut brain = FlyBrain::new(&genome_to_connectome_options(&genome));
        let mut rng = Mulberry32::new(genome.seed ^ STIM_XOR);
        let steps = case["steps"].as_u64().unwrap();
        let checkpoints = case["checkpoints"].as_array().unwrap();
        let mut ck = 0usize;
        let mut spikes_total = 0u64;
        for step in 1..=steps {
            fuzz_step(&mut brain, &mut rng);
            spikes_total += spikes_now(&brain);
            if ck < checkpoints.len() && checkpoints[ck]["step"].as_u64().unwrap() == step {
                let c = &checkpoints[ck];
                assert_eq!(
                    state_hash(&brain),
                    c["hash"].as_str().unwrap(),
                    "{label}: state hash differs at step {step}"
                );
                let motor = c["motor"].as_array().unwrap();
                for (k, ch) in MOTOR_CHANNELS.iter().enumerate() {
                    cmp_motor(&format!("{label} step {step} motor {}", ch.as_str()), &brain.read_motor(*ch), &motor[k]);
                }
                ck += 1;
            }
        }
        assert_eq!(ck, checkpoints.len(), "{label}: all checkpoints consumed");
        assert_eq!(spikes_total, case["spikesTotal"].as_u64().unwrap(), "{label} spikesTotal");
        check_end_state(&label, &brain, case);
        n += 1;
    }
    assert_eq!(n, 3);
}

// ------------------------------------------------------------------------------------ serialize round-trip

#[test]
#[ignore = "needs tests/fixtures/fuzz.json from tests/gen/gen_fuzz.ts; run with --include-ignored"]
fn serialize_roundtrip_matches_reference() {
    let fx = fixture("fuzz.json");
    let cases = fx["serialize"].as_array().unwrap();
    assert_eq!(cases.len(), 3);
    for case in cases {
        let genome = genome_of(&case["genome"]);
        let label = format!("serialize genome {}", canonical_genome(&genome));
        let opts = genome_to_connectome_options(&genome);
        let steps_before = case["stepsBefore"].as_u64().unwrap();
        let steps_after = case["stepsAfter"].as_u64().unwrap();

        // 1) reach the serialize point
        let mut original = FlyBrain::new(&opts);
        let mut rng = Mulberry32::new(genome.seed ^ STIM_XOR);
        for _ in 0..steps_before {
            fuzz_step(&mut original, &mut rng);
        }
        assert_eq!(state_hash(&original), case["hashAtSerialize"].as_str().unwrap(), "{label} state at serialize");
        assert_eq!(spikes_now(&original), case["spikesInFlight"].as_u64().unwrap(), "{label} spikes in flight");

        // 2) the TS archive parses, and its VALUES equal what Rust serialises from the same state
        let ts_text = case["serialized"].as_str().unwrap();
        let ts_archive: BrainArchive = serde_json::from_str(ts_text).unwrap();
        assert_eq!(ts_archive, original.to_archive(), "{label}: TS archive values != Rust archive values");
        // exact f32 representability of every archived number (Array.from(Float32Array) invariant)
        let net = ts_archive.net.as_ref().unwrap();
        for (name, arr) in [
            ("V", &net.v),
            ("Isyn", &net.isyn),
            ("Iext", &net.iext),
            ("firingRate", &net.firing_rate),
            ("lastSpikeT", &net.last_spike_t),
        ] {
            for &x in arr {
                assert_eq!((x as f32) as f64, x, "{label}: archived {name} value {x} is not an f32");
            }
        }

        // 3) restore from the TS text: state, clock, noise
        let mut restored = FlyBrain::deserialize(ts_text, &opts).unwrap();
        assert_eq!(state_hash(&restored), case["hashAfterRestore"].as_str().unwrap(), "{label} state after restore");
        assert_eq!(
            restored.noise_state() as u64,
            case["restoredNoiseState"].as_u64().unwrap(),
            "{label} restored noiseState"
        );
        assert_eq!(restored.t().to_bits(), f64_of(&case["restoredT"]).to_bits(), "{label} restored t");
        assert_eq!(restored.step(), case["restoredStep"].as_u64().unwrap(), "{label} restored step");
        // The reference drops the in-flight spikes on restore; the fixture asserts they were non-zero.
        assert_eq!(spikes_now(&restored), 0, "{label}: restored brain must carry no spike flags");

        // 4) Rust's own serialize → deserialize lands on the same restored state
        let rust_text = original.serialize();
        let restored_rs = FlyBrain::deserialize(&rust_text, &opts).unwrap();
        assert_eq!(state_hash(&restored_rs), state_hash(&restored), "{label}: Rust serialize round-trip");
        assert_eq!(restored_rs.noise_state(), restored.noise_state());

        // 5) continue both brains under the same fresh stimulus stream and match the reference
        let cont_seed = genome.seed ^ STIM_XOR ^ (steps_before as u32);
        let mut rng_a = Mulberry32::new(cont_seed);
        let mut rng_b = Mulberry32::new(cont_seed);
        for _ in 0..steps_after {
            fuzz_step(&mut restored, &mut rng_a);
            fuzz_step(&mut original, &mut rng_b);
        }
        let cont = &case["continued"];
        assert_eq!(state_hash(&restored), cont["restored"]["hash"].as_str().unwrap(), "{label}: restored continuation");
        check_end_state(&format!("{label} restored continuation"), &restored, &cont["restored"]);
        assert_eq!(state_hash(&original), cont["original"]["hash"].as_str().unwrap(), "{label}: original continuation");
        check_end_state(&format!("{label} original continuation"), &original, &cont["original"]);
    }
}

#[test]
fn deserialize_migration_rules() {
    // size mismatch → fresh electrical state, noiseState still restored; pre-v3 same size → clock only.
    let opts = ConnectomeOptions {
        seed: 7,
        n_sensory: 10,
        n_inter_l1: 8,
        n_inter_l2: 8,
        n_modulatory: 4,
        n_motor_per_channel: 1,
        density: 0.02,
    };
    let fresh = FlyBrain::new(&opts);
    let mut brain = FlyBrain::new(&opts);
    let mut rng = Mulberry32::new(1);
    for _ in 0..50 {
        fuzz_step(&mut brain, &mut rng);
    }
    let mut archive = brain.to_archive();
    // pre-v3
    archive.version = 2;
    let b = FlyBrain::from_archive(&archive, &opts);
    assert_eq!(b.t(), 50.0);
    assert_eq!(b.step(), 50);
    assert_eq!(b.net.v, fresh.net.v, "pre-v3 archive must not restore V");
    assert_eq!(b.noise_state(), brain.noise_state());
    // size mismatch
    archive.version = 3;
    archive.net.as_mut().unwrap().v.push(0.0);
    let b = FlyBrain::from_archive(&archive, &opts);
    assert_eq!(b.t(), 0.0);
    assert_eq!(b.step(), 0);
    assert_eq!(b.noise_state(), brain.noise_state());
    // missing version → 1
    let a: BrainArchive = serde_json::from_str(r#"{"noiseState":5}"#).unwrap();
    assert_eq!(a.version, 1);
    assert_eq!(FlyBrain::from_archive(&a, &opts).noise_state(), 5);
}
