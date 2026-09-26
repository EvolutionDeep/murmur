/**
 * Fixture generator for fly-brain-rs, the Rust port of @fly/fly-brain.
 *
 * Runs the TypeScript reference (packages/fly-brain/src) and dumps exact numeric traces to
 * tests/fixtures/*.json. The Rust parity tests (tests/parity.rs) load these and assert BIT-EXACT
 * equality — no tolerances.
 *
 * From the repository root:
 *   npx --yes tsx packages/fly-brain-rs/tests/gen/gen_fixtures.ts [--out DIR] [--small]
 *
 * `--small` writes the compact committed set (tests/fixtures/small, < 1 MB: PRNG, a mathfns
 * subset, one connectome, one 500-step dynamics trace with a state hash at every step and full
 * arrays at steps 1 and 500, genome ops). The default writes the full set (~15 MB, gitignored):
 * 25k transcendental samples, 3 connectomes, 3 × 2000-step dynamics traces with 47 full snapshots.
 *
 * Every float is emitted with JSON.stringify's shortest round-trip repr, which serde_json
 * (float_roundtrip) parses back to the identical f64. Float32Array contents are emitted via
 * Array.from (each element is an f64 that exactly represents the f32), and additionally as hex bit
 * patterns for the membrane so a divergence report can point at a bit.
 *
 * NOTE: the transcendental outputs (and therefore the f64 synapse weights) are those of the Node
 * build that runs this script — see README.md ("Platform note") for what differs between arm64 and
 * x86-64 Node, why it does not affect the dynamics, and the crate's `fma` feature.
 */
import { writeFileSync, mkdirSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  FlyBrain,
  buildConnectome,
  connectomeStructuralSpec,
  genomeFromOptions,
  genomeToConnectomeOptions,
  mutateGenome,
  crossoverGenome,
  canonicalGenome,
  estimateConnectomeSize,
  type Genome,
  type MotorChannel,
  type SensoryInput,
} from "../../../fly-brain/src/index.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const SMALL = process.argv.includes("--small");
const outIdx = process.argv.indexOf("--out");
const OUT = outIdx >= 0 ? process.argv[outIdx + 1] : join(HERE, "..", "fixtures", SMALL ? "small" : "");
mkdirSync(OUT, { recursive: true });

/** sha256 over the little-endian bytes of V, Isyn, Iext, adaptation, lastSpikeT, firingRate, then
 *  the spike flags — the same digest tests/parity.rs computes (and gen_fuzz.ts uses). */
function stateHash(brain: FlyBrain): string {
  const net = brain.network;
  const h = createHash("sha256");
  for (const arr of [net.V, net.Isyn, net.Iext, net.adaptation, net.lastSpikeT, net.firingRate]) {
    h.update(Buffer.from(arr.buffer, arr.byteOffset, arr.byteLength));
  }
  h.update(Buffer.from(net.spiking.buffer, net.spiking.byteOffset, net.spiking.byteLength));
  return h.digest("hex");
}

function f64bits(x: number): string {
  const b = Buffer.alloc(8);
  b.writeDoubleBE(x);
  return b.toString("hex");
}
function f32bits(x: number): string {
  const b = Buffer.alloc(4);
  b.writeFloatBE(x);
  return b.toString("hex");
}
function write(name: string, obj: unknown): void {
  const s = JSON.stringify(obj);
  writeFileSync(join(OUT, name), s);
  console.log(`${name}: ${(s.length / 1024).toFixed(0)} KB`);
}

// ----------------------------------------------------------------------------- 1) PRNG
// connectome.ts mulberry32 (a |= 0 form) — not exported, so replicate verbatim here.
function mulberry32Conn(seed: number) {
  let a = seed >>> 0;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
// genome.ts mulberry32 (>>> 0 form) — replicate verbatim.
function mulberry32Genome(a: number): () => number {
  let t = a >>> 0;
  return () => {
    t = (t + 0x6d2b79f5) >>> 0;
    let r = Math.imul(t ^ (t >>> 15), 1 | t);
    r = (r + Math.imul(r ^ (r >>> 7), 61 | r)) ^ r;
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
  };
}

const PRNG_SEEDS = [0xfeedface, 0, 1, 42, 4294967295];
{
  const cases = PRNG_SEEDS.map((seed) => {
    const rc = mulberry32Conn(seed);
    const rg = mulberry32Genome(seed);
    const conn: number[] = [];
    const connU32: number[] = [];
    const gen: number[] = [];
    const genU32: number[] = [];
    for (let i = 0; i < 64; i++) {
      const c = rc();
      conn.push(c);
      connU32.push(Math.floor(c * 4294967296));
      const g = rg();
      gen.push(g);
      genU32.push(Math.floor(g * 4294967296));
    }
    // FlyBrain's private xorshift32 noise source
    const brain = new FlyBrain({ seed, nSensory: 10, nInterL1: 8, nInterL2: 8, nModulatory: 4, nMotorPerChannel: 1 });
    const xs: number[] = [];
    for (let i = 0; i < 64; i++) xs.push((brain as any).rand());
    return { seed, connectome: conn, connectomeU32: connU32, genome: gen, genomeU32: genU32, xorshift: xs };
  });
  write("prng.json", { cases });
}

// ----------------------------------------------------------------------------- 1b) Math fns
// V8 transcendental outputs on a fixed grid — lets a divergence be attributed to libm vs. the
// engine logic. Inputs are chosen deterministically from mulberry32 so they are "typical".
{
  const r = mulberry32Conn(12345);
  const log: [string, string][] = [];
  const cos: [string, string][] = [];
  const exp: [string, string][] = [];
  const tanh: [string, string][] = [];
  const sqrt: [string, string][] = [];
  const N_MAIN = SMALL ? 600 : 4000;
  const N_SMALL_TANH = SMALL ? 300 : 2000;
  const N_EXTRA = SMALL ? 0.2 : 1;
  for (let i = 0; i < N_MAIN; i++) {
    const u = r();
    log.push([f64bits(u), f64bits(Math.log(u))]);
    const v = 2.0 * Math.PI * r();
    cos.push([f64bits(v), f64bits(Math.cos(v))]);
    const x = (r() - 0.5) * 12;
    exp.push([f64bits(x), f64bits(Math.exp(x))]);
    const y = (r() - 0.5) * 12;
    tanh.push([f64bits(y), f64bits(Math.tanh(y))]);
    const s = r() * 30;
    sqrt.push([f64bits(s), f64bits(Math.sqrt(s))]);
  }
  // Also: small tanh inputs (encoder regime is |x| < ~3) and tiny ones.
  for (let i = 0; i < N_SMALL_TANH; i++) {
    const y = (r() - 0.5) * 6;
    tanh.push([f64bits(y), f64bits(Math.tanh(y))]);
  }
  for (const y of [0, 1e-30, -1e-30, 1e-9, 0.5, 1, -1, 22, -22, 25, 0.5493061443340549, 0.25]) {
    tanh.push([f64bits(y), f64bits(Math.tanh(y))]);
  }
  // Argument-reduction paths of fdlibm cos/sin that the engine never reaches (|x| < 2π) but the
  // port implements: 3π/4 special case, medium range up to 2^19·π/2, near-multiples of π/2
  // (npio2_hw cancellation path), and the large-argument __kernel_rem_pio2 path.
  const cosExtra: [string, string][] = [];
  const sinExtra: [string, string][] = [];
  const push = (x: number) => {
    cosExtra.push([f64bits(x), f64bits(Math.cos(x))]);
    sinExtra.push([f64bits(x), f64bits(Math.sin(x))]);
  };
  for (let i = 0; i < 1500 * N_EXTRA; i++) push((r() - 0.5) * 2 * 823549.66);
  for (let i = 0; i < 500 * N_EXTRA; i++) push((r() - 0.5) * 2e7);
  for (let i = 0; i < 300 * N_EXTRA; i++) push((r() - 0.5) * Math.pow(10, 8 + r() * 292));
  for (let n = 1; n <= 40; n++) {
    const m = n * Math.PI / 2;
    push(m); push(-m);
    push(m + 1e-9); push(m - 1e-9);
    // exercise every double in a tiny neighbourhood of n·π/2 (npio2_hw path)
    let v = m;
    for (let k = 0; k < 4; k++) { v = v + Number.EPSILON * v; push(v); }
  }
  for (const x of [0, 1e-30, -1e-30, 1e-9, 0.5, 0.7853981633974483, 0.7853981633974484, 1, 2.356194490192345, 2.3561944901923453, 1e300, -1e300, 6.283185307179586, 823549.6645, 823549.6646, 1e22]) push(x);
  // exp / expm1-via-tanh / log edge ranges
  const expExtra: [string, string][] = [];
  for (let i = 0; i < 1000 * N_EXTRA; i++) { const x = (r() - 0.5) * 1400; expExtra.push([f64bits(x), f64bits(Math.exp(x))]); }
  for (const x of [0, 1, -1, 709.782712893384, 709.7827128933841, -745.1332191019411, -745.1332191019412, 1e-300, -1e-300, 0.34657359027997264, 0.3465735902799727, 1.0397207708399179, 1.039720770839918]) expExtra.push([f64bits(x), f64bits(Math.exp(x))]);
  const logExtra: [string, string][] = [];
  for (let i = 0; i < 1000 * N_EXTRA; i++) { const x = Math.pow(2, (r() - 0.5) * 2100); logExtra.push([f64bits(x), f64bits(Math.log(x))]); }
  for (const x of [1, 2, 0.5, 1 + 2 ** -21, 1 - 2 ** -21, 1 + 2 ** -19, 5e-324, 2.2250738585072014e-308, 1.7976931348623157e308, 1.4142135623730951, 0.7071067811865476]) logExtra.push([f64bits(x), f64bits(Math.log(x))]);
  const tanhExtra: [string, string][] = [];
  for (let i = 0; i < 1000 * N_EXTRA; i++) { const x = (r() - 0.5) * 60; tanhExtra.push([f64bits(x), f64bits(Math.tanh(x))]); }
  for (const x of [0.9999999999999999, 1.0000000000000002, 21.999999999999996, 22.000000000000004, 2 ** -28, 2 ** -29, -(2 ** -28), 1e-320]) tanhExtra.push([f64bits(x), f64bits(Math.tanh(x))]);
  const constants = {
    synDecay: f64bits(Math.exp(-1 / 5.0)),
    adaptDecay: f64bits(Math.exp(-1 / 200.0)),
    extDecay: f64bits(Math.exp(-1 / 20)),
    twoPi: f64bits(2.0 * Math.PI),
    noiseThreshold: f64bits(0.3 * 1 * 0.05),
  };
  // Provenance: which Node build produced these bits (see README.md "Platform note").
  write("mathfns.json", { node: process.version, arch: process.arch, platform: process.platform, log, cos, exp, tanh, sqrt, constants, cosExtra, sinExtra, expExtra, logExtra, tanhExtra });
}

// ----------------------------------------------------------------------------- 2) connectome
const SIZING_1X = { nSensory: 180, nInterL1: 400, nInterL2: 400, nModulatory: 40, nMotorPerChannel: 12, density: 0.02 };
const CONN_SEEDS = SMALL ? [42] : [0xfeedface, 42, 1407879688];

function canonicalJson(v: unknown): string {
  if (v === null || typeof v !== "object") return JSON.stringify(v);
  if (Array.isArray(v)) return "[" + v.map(canonicalJson).join(",") + "]";
  const o = v as Record<string, unknown>;
  const keys = Object.keys(o).sort();
  return "{" + keys.map((k) => JSON.stringify(k) + ":" + canonicalJson(o[k])).join(",") + "}";
}

for (const seed of CONN_SEEDS) {
  const c = buildConnectome({ seed, ...SIZING_1X });
  const neurons = c.neurons.map((n) => ({
    id: n.id,
    kind: n.kind,
    channel: n.channel,
    tau: n.tau,
    vRest: n.vRest,
    vThresh: n.vThresh,
    vReset: n.vReset,
    refractory: n.refractory,
  }));
  const synapses = c.synapses.map((s) => [s.pre, s.post, s.w]);
  const canon = canonicalJson({ neurons, synapses });
  const sha256 = createHash("sha256").update(canon).digest("hex");
  const byChannel: Record<string, number[]> = {};
  for (const [k, v] of c.byChannel) byChannel[k] = v;
  write(`connectome_${seed}.json`, {
    seed,
    opts: SIZING_1X,
    neurons,
    synapses,
    byKind: c.byKind,
    byChannel,
    spec: connectomeStructuralSpec(c),
    sha256,
  });
}

// ----------------------------------------------------------------------------- 3) dynamics
const INJECT: SensoryInput[] = [
  { channel: "thermal_warmth", intensity: 0.7 },
  { channel: "thermal_flux", intensity: 0.5 },
  { channel: "mechanical_turbulence", intensity: 0.3 },
  { channel: "olfactory_density", intensity: 0.6 },
  { channel: "internal_arousal", intensity: 0.4 },
];
const MOTORS: MotorChannel[] = ["leg_left", "leg_right", "wing", "proboscis", "abdomen"];
const DYN_STEPS = SMALL ? 500 : 2000;
const RECORD_AT = new Set<number>(SMALL ? [1, DYN_STEPS] : [1, 2, 3, 4, 5, 10, 20]);
if (!SMALL) for (let s = 50; s <= DYN_STEPS; s += 50) RECORD_AT.add(s);

for (const seed of CONN_SEEDS) {
  const brain = new FlyBrain({ seed, ...SIZING_1X });
  const net = brain.network;
  const snapshots: unknown[] = [];
  // sha256 of the full state after EVERY step (locates the first divergent step exactly); the
  // full arrays are only recorded at RECORD_AT (to name the first divergent element and bit).
  const hashes: string[] = [];
  for (let step = 1; step <= DYN_STEPS; step++) {
    for (const inp of INJECT) brain.inject(inp);
    brain.tick(1);
    hashes.push(stateHash(brain));
    if (RECORD_AT.has(step)) {
      const j = net.toJSON();
      snapshots.push({
        step,
        t: brain.t,
        hash: hashes[hashes.length - 1],
        membrane: j.V,
        membraneBits: Array.from(net.V).map(f32bits),
        spikesLastStep: Array.from(net.spiking),
        firingRates: j.firingRate,
        Isyn: j.Isyn,
        Iext: j.Iext,
        adaptation: j.adaptation,
        lastSpikeT: j.lastSpikeT,
        noiseState: (brain as any).noiseState,
        motor: MOTORS.map((ch) => brain.readMotor(ch)),
      });
    }
  }
  write(`dynamics_${seed}.json`, {
    seed,
    opts: SIZING_1X,
    inject: INJECT,
    steps: DYN_STEPS,
    hashes,
    snapshots,
    // readMotor's windowMs argument is accepted but unused by the reference; record both.
    motorWindow100: MOTORS.map((ch) => brain.readMotor(ch, 100)),
    motorWindowDefault: MOTORS.map((ch) => brain.readMotor(ch)),
    readAllMotor: brain.readAllMotor(),
  });
}

// ----------------------------------------------------------------------------- 4) genome ops
{
  const base = genomeFromOptions({ seed: 0xfeedface, ...SIZING_1X });
  const A1: Genome = { ...base, seed: 1407879688, nSensory: 193, nInterL1: 436, nInterL2: 328, nModulatory: 44, nMotorPerChannel: 9, density: 0.023 };
  const A2: Genome = { ...base, seed: 7, nSensory: 8, nInterL1: 8, nInterL2: 9, nModulatory: 4, nMotorPerChannel: 1, density: 0.0005 };
  const A3: Genome = { ...base, seed: 4294967295, nSensory: 2000, nInterL1: 4000, nInterL2: 4000, nModulatory: 2000, nMotorPerChannel: 500, density: 0.2 };
  const A4: Genome = { ...base, seed: 123456789, density: 0.0199 };
  const A5: Genome = { ...base, seed: 99, nSensory: 181, nInterL1: 399, density: 0.1234 };
  const pairs: [Genome, Genome, number][] = [
    [base, A1, 1],
    [base, A1, 2],
    [A1, A2, 0xdeadbeef],
    [A2, A3, 0xdeadbeef + 1],
    [A3, A4, 0],
    [A4, A5, 4294967295],
  ];
  const cases = pairs.map(([a, b, rngSeed]) => ({
    a,
    b,
    rngSeed,
    mutateA: mutateGenome(a, rngSeed),
    mutateB: mutateGenome(b, rngSeed),
    mutateA_plus1: mutateGenome(a, rngSeed + 1),
    crossover: crossoverGenome(a, b, rngSeed),
    crossover_plus1: crossoverGenome(a, b, rngSeed + 1),
    canonicalA: canonicalGenome(a),
    estimateA: estimateConnectomeSize(a),
    estimateB: estimateConnectomeSize(b),
  }));
  // A short mutation chain (each child mutated again) exercises the field-drift/clamp paths.
  const chain: Genome[] = [base];
  for (let i = 0; i < 40; i++) chain.push(mutateGenome(chain[chain.length - 1], 1000 + i));
  write("genome_ops.json", { cases, chain });
}

console.log("done");
