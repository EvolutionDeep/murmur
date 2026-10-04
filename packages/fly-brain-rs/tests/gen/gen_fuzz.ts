/**
 * Fuzz-parity fixture generator for fly-brain-rs.
 *
 * Runs the TypeScript reference (packages/fly-brain/src) over many random
 * genomes under random stimulus sequences and records COMPACT evidence (sha256 of the full state,
 * not the arrays) so the Rust test can assert bit-exact agreement over ~250k brain-steps without a
 * multi-hundred-MB fixture.
 *
 *   npx --yes tsx packages/fly-brain-rs/tests/gen/gen_fuzz.ts [--out DIR] [--quick]
 *
 * The full run takes ~10–20 min of single-core time (230 genomes × 1000 steps + 3 × 10,000 + the
 * serialize cases; the largest genome has 9.1 M synapses); `--quick` is a ~1 min smoke variant.
 * Then: cargo test --release -- --include-ignored
 *
 * Protocol (mirrored verbatim in tests/parity.rs — any change here must change there):
 *   • Genome sampling: mulberry32(FUZZ_SEED); each genome takes its draws in field order
 *     (seed, nSensory, nInterL1, nInterL2, nModulatory, nMotorPerChannel, density).
 *   • Stimulus per step: rng = mulberry32(genome.seed ^ 0x5f3759df) created once per genome;
 *     per step: if rng() < 0.15 → no stimulus; else for each of the 10 sensory channels in
 *     SENSORY_CHANNEL_LIST order: if rng() < 0.35 → inject(channel, rng() < 0.1 ? rng()*5 : rng()*1.2).
 *     Then brain.tick(1).
 *   • State hash: sha256 over the raw little-endian bytes of V, Isyn, Iext, adaptation, lastSpikeT,
 *     firingRate (Float32Array buffers, in that order) followed by the spiking Uint8Array.
 */
import { writeFileSync, mkdirSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  FlyBrain,
  GENOME_BOUNDS,
  SENSORY_CHANNEL_LIST,
  MOTOR_CHANNEL_LIST,
  estimateConnectomeSize,
  genomeToConnectomeOptions,
  type Genome,
} from "../../../fly-brain/src/index.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const outIdx = argv.indexOf("--out");
const OUT = outIdx >= 0 ? argv[outIdx + 1] : join(HERE, "..", "fixtures");
const QUICK = argv.includes("--quick");
mkdirSync(OUT, { recursive: true });

// mulberry32 (same sequence as both copies in the reference; see gen_fixtures.ts)
function mulberry32(seed: number) {
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

const FUZZ_SEED = 0xf0220922;
const STIM_XOR = 0x5f3759df;

function stateHash(brain: FlyBrain): string {
  const net = brain.network;
  const h = createHash("sha256");
  for (const arr of [net.V, net.Isyn, net.Iext, net.adaptation, net.lastSpikeT, net.firingRate]) {
    h.update(Buffer.from(arr.buffer, arr.byteOffset, arr.byteLength));
  }
  h.update(Buffer.from(net.spiking.buffer, net.spiking.byteOffset, net.spiking.byteLength));
  return h.digest("hex");
}

/** One stimulus+tick step under the shared protocol. Returns the number of injections made. */
function stepOnce(brain: FlyBrain, rng: () => number): number {
  let injected = 0;
  if (rng() >= 0.15) {
    for (const channel of SENSORY_CHANNEL_LIST) {
      if (rng() < 0.35) {
        const intensity = rng() < 0.1 ? rng() * 5 : rng() * 1.2;
        brain.inject({ channel, intensity });
        injected++;
      }
    }
  }
  brain.tick(1);
  return injected;
}

function round4(x: number): number {
  return Math.round(x * 1e4) / 1e4;
}

// ----------------------------------------------------------------------------- genome sampling
const grng = mulberry32(FUZZ_SEED);
const uniformInt = (lo: number, hi: number) => lo + Math.floor(grng() * (hi - lo + 1));
const B = GENOME_BOUNDS;

function sampleUniform(): Genome {
  return {
    v: 1,
    seed: Math.floor(grng() * 4294967296) >>> 0,
    nSensory: uniformInt(B.nSensory[0], B.nSensory[1]),
    nInterL1: uniformInt(B.nInterL1[0], B.nInterL1[1]),
    nInterL2: uniformInt(B.nInterL2[0], B.nInterL2[1]),
    nModulatory: uniformInt(B.nModulatory[0], B.nModulatory[1]),
    nMotorPerChannel: uniformInt(B.nMotorPerChannel[0], B.nMotorPerChannel[1]),
    density: round4(B.density[0] + grng() * (B.density[1] - B.density[0])),
  };
}
function sample10x(): Genome {
  const seed = Math.floor(grng() * 4294967296) >>> 0;
  // half at the production density, half at a random nearby density (draw order: seed, coin, density)
  const dens = grng() < 0.5 ? 0.02 : round4(0.005 + grng() * 0.025);
  return { v: 1, seed, nSensory: 1800, nInterL1: 4000, nInterL2: 4000, nModulatory: 400, nMotorPerChannel: 120, density: dens };
}
function sampleEdge(i: number): Genome {
  const seed = Math.floor(grng() * 4294967296) >>> 0;
  const pick = (lo: number, hi: number, which: boolean) => (which ? hi : lo);
  // 0 = all-min, 1 = all-max, 2.. = random corners (one coin per field, in field order)
  const corner = (k: number) => (i === 0 ? false : i === 1 ? true : grng() < 0.5);
  return {
    v: 1,
    seed,
    nSensory: pick(B.nSensory[0], B.nSensory[1], corner(0)),
    nInterL1: pick(B.nInterL1[0], B.nInterL1[1], corner(1)),
    nInterL2: pick(B.nInterL2[0], B.nInterL2[1], corner(2)),
    nModulatory: pick(B.nModulatory[0], B.nModulatory[1], corner(3)),
    nMotorPerChannel: pick(B.nMotorPerChannel[0], B.nMotorPerChannel[1], corner(4)),
    density: pick(B.density[0], B.density[1], corner(5)),
  };
}

const N_UNIFORM = QUICK ? 6 : 200;
const N_10X = QUICK ? 1 : 20;
const N_EDGE = QUICK ? 2 : 10;
const STEPS = 1000;
const CHECK_EVERY = 100;

const genomes: { kind: string; genome: Genome }[] = [];
for (let i = 0; i < N_UNIFORM; i++) genomes.push({ kind: "uniform", genome: sampleUniform() });
for (let i = 0; i < N_10X; i++) genomes.push({ kind: "10x", genome: sample10x() });
for (let i = 0; i < N_EDGE; i++) genomes.push({ kind: "edge", genome: sampleEdge(i) });

let totalSyn = 0;
for (const g of genomes) totalSyn += estimateConnectomeSize(g.genome).synapses;
console.log(`${genomes.length} genomes, ${(totalSyn / 1e6).toFixed(1)}M synapses total (est.), ${STEPS} steps each`);

// ----------------------------------------------------------------------------- run
const t0 = Date.now();
const cases: unknown[] = [];
let stepsDone = 0;
for (let gi = 0; gi < genomes.length; gi++) {
  const { kind, genome } = genomes[gi];
  const tg = Date.now();
  const brain = new FlyBrain(genomeToConnectomeOptions(genome));
  const rng = mulberry32((genome.seed ^ STIM_XOR) >>> 0);
  const checkpoints: { step: number; hash: string }[] = [];
  let spikesTotal = 0;
  let injections = 0;
  const spiking = brain.network.spiking;
  for (let step = 1; step <= STEPS; step++) {
    injections += stepOnce(brain, rng);
    for (let i = 0; i < spiking.length; i++) spikesTotal += spiking[i];
    if (step % CHECK_EVERY === 0) checkpoints.push({ step, hash: stateHash(brain) });
  }
  stepsDone += STEPS;
  cases.push({
    kind,
    genome,
    neurons: brain.network.N,
    synapses: brain.network.S,
    steps: STEPS,
    checkpoints,
    spikesTotal,
    injections,
    noiseState: (brain as any).noiseState,
    t: brain.t,
    step: brain.step,
    motor: MOTOR_CHANNEL_LIST.map((ch) => brain.readMotor(ch)),
  });
  console.log(
    `[${gi + 1}/${genomes.length}] ${kind} N=${brain.network.N} S=${brain.network.S} spikes=${spikesTotal} ${((Date.now() - tg) / 1000).toFixed(1)}s`,
  );
}

// ----------------------------------------------------------------------------- long runs
const LONG_STEPS = QUICK ? 2000 : 10000;
const LONG_EVERY = 1000;
const SIZING_1X = { nSensory: 180, nInterL1: 400, nInterL2: 400, nModulatory: 40, nMotorPerChannel: 12, density: 0.02 };
const longGenomes: Genome[] = [
  { v: 1, ...SIZING_1X, seed: 0xfeedface },
  { v: 1, ...SIZING_1X, seed: 42 },
  { v: 1, seed: 1407879688, nSensory: 193, nInterL1: 436, nInterL2: 328, nModulatory: 44, nMotorPerChannel: 9, density: 0.023 },
];
const longCases: unknown[] = [];
for (const genome of longGenomes) {
  const brain = new FlyBrain(genomeToConnectomeOptions(genome));
  const rng = mulberry32((genome.seed ^ STIM_XOR) >>> 0);
  const checkpoints: { step: number; hash: string; motor: unknown }[] = [];
  let spikesTotal = 0;
  const spiking = brain.network.spiking;
  for (let step = 1; step <= LONG_STEPS; step++) {
    stepOnce(brain, rng);
    for (let i = 0; i < spiking.length; i++) spikesTotal += spiking[i];
    if (step % LONG_EVERY === 0) {
      checkpoints.push({ step, hash: stateHash(brain), motor: MOTOR_CHANNEL_LIST.map((ch) => brain.readMotor(ch)) });
    }
  }
  stepsDone += LONG_STEPS;
  longCases.push({ genome, steps: LONG_STEPS, checkpoints, spikesTotal, noiseState: (brain as any).noiseState, t: brain.t, step: brain.step });
  console.log(`long seed=${genome.seed} ${LONG_STEPS} steps spikes=${spikesTotal}`);
}

// ----------------------------------------------------------------------------- serialize round-trip
// FlyBrain.serialize() → FlyBrain.deserialize(): the TS restores t/step/V/lastSpikeT/Isyn/Iext/
// firingRate/adaptation and noiseState, but NOT `spiking` / the previous-step spike buffer, so a
// restored brain's next tick propagates no synaptic input. Both continuations are recorded: the
// restored brain (what deserialize() actually yields) and the original brain kept running
// (they differ whenever a spike was in flight at serialize time).
const SER_STEPS_BEFORE = 500;
const SER_STEPS_AFTER = 500;
const serCases: unknown[] = [];
for (const genome of longGenomes) {
  const opts = genomeToConnectomeOptions(genome);
  const brain = new FlyBrain(opts);
  const rng = mulberry32((genome.seed ^ STIM_XOR) >>> 0);
  for (let step = 1; step <= SER_STEPS_BEFORE; step++) stepOnce(brain, rng);
  const serialized = brain.serialize();
  const hashAtSerialize = stateHash(brain);
  const spikesInFlight = Array.from(brain.network.spiking).reduce((a, b) => a + b, 0);
  const restored = FlyBrain.deserialize(serialized, opts);
  if (stateHash(restored) === hashAtSerialize && spikesInFlight > 0) {
    throw new Error("unexpected: restored hash equals live hash although spikes were in flight");
  }
  const hashAfterRestore = stateHash(restored);
  const restoredNoiseState = (restored as any).noiseState;
  const restoredT = restored.t;
  const restoredStep = restored.step;
  // Continue both with the SAME fresh stimulus stream (seeded from the serialized step count).
  const contSeed = (genome.seed ^ STIM_XOR ^ SER_STEPS_BEFORE) >>> 0;
  const rngA = mulberry32(contSeed);
  const rngB = mulberry32(contSeed);
  for (let step = 1; step <= SER_STEPS_AFTER; step++) {
    stepOnce(restored, rngA);
    stepOnce(brain, rngB);
  }
  serCases.push({
    genome,
    stepsBefore: SER_STEPS_BEFORE,
    stepsAfter: SER_STEPS_AFTER,
    serialized,
    hashAtSerialize,
    spikesInFlight,
    hashAfterRestore,
    restoredNoiseState,
    restoredT,
    restoredStep,
    continued: {
      restored: { hash: stateHash(restored), motor: MOTOR_CHANNEL_LIST.map((ch) => restored.readMotor(ch)), noiseState: (restored as any).noiseState, t: restored.t, step: restored.step },
      original: { hash: stateHash(brain), motor: MOTOR_CHANNEL_LIST.map((ch) => brain.readMotor(ch)), noiseState: (brain as any).noiseState, t: brain.t, step: brain.step },
    },
  });
  console.log(`serialize seed=${genome.seed}: ${serialized.length} bytes, spikes in flight=${spikesInFlight}`);
}

const out = {
  protocol: { fuzzSeed: FUZZ_SEED, stimXor: STIM_XOR, checkEvery: CHECK_EVERY, noStimP: 0.15, channelP: 0.35, burstP: 0.1, burstScale: 5, scale: 1.2 },
  node: process.version,
  arch: process.arch,
  cases,
  long: longCases,
  serialize: serCases,
};
const s = JSON.stringify(out);
writeFileSync(join(OUT, "fuzz.json"), s);
console.log(`fuzz.json: ${(s.length / 1024).toFixed(0)} KB, ${stepsDone} brain-steps, ${((Date.now() - t0) / 1000).toFixed(0)}s`);
