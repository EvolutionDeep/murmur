// Brain-manifest primitives — the deterministic, dependency-free core of murmur's "prove the brain"
// story. Everything here is PURE and SYNCHRONOUS (no crypto, no I/O, no worker/config knowledge) so it
// runs identically in a Cloudflare Worker, in Node/tsx tests, in a browser and in an offline CLI.
//
// WHAT IT GIVES YOU. A connectome built by buildConnectome(seed, opts) is fully reproducible: the PRNG
// is mulberry32 (integer-only ⇒ bit-identical on every JS engine). So a compact, quantised STRUCTURAL
// SPEC of one brain is a stable identity anyone can recompute from just (seed, opts) — no trust in us.
// The worker assembles these per-fly specs into a manifest, hashes it, and (optionally) commits that
// hash on-chain; a verifier then rebuilds every brain from the committed seeds and checks the specs
// match. That is the offline replay this module makes possible.
//
// QUANTISATION IS DELIBERATE (ULP safety). Two families of floats feed the spec:
//   • neuron tau / vThresh — derived straight from mulberry32 (integer ⇒ exact everywhere), so we keep
//     fine micro (1e-6) integer sums.
//   • synapse weights — pass through gaussian() (Math.sqrt/log/cos), whose last ULP is NOT guaranteed
//     identical across engines, so we quantise COARSELY to milli (1e-3). A 1-ULP drift (~1e-16 at these
//     magnitudes) can never move a milli-quantised value, so the digest is stable cross-engine.

import {
  buildConnectome,
  DEFAULT_CONNECTOME_OPTIONS,
  MOTOR_CHANNEL_LIST,
  SENSORY_CHANNEL_LIST,
  type ConnectomeOptions,
} from "./connectome.js";
import type { Connectome, NeuronKind } from "./types.js";

/** Bump when the manifest/spec schema or the digest algorithm changes (invalidates comparability). */
export const BRAIN_MANIFEST_VERSION = 1;

/**
 * HONEST provenance, recorded verbatim in every manifest. It must never overstate what the code is:
 * the graph is a PROGRAMMATIC, reproducible-from-seed downsample whose laminar motif + left/right
 * winner-take-all are INSPIRED BY the FlyWire adult fruit-fly connectome — it is NOT the literal
 * ~138k-neuron FlyWire adjacency data. This mirrors connectome.ts's own header and connectome.test.ts.
 */
export const CONNECTOME_PROVENANCE = {
  name: "murmur fly connectome",
  architecture:
    "FlyWire-inspired layered downsample: sensory → interneuron L1 → mutually-inhibitory interneuron L2 (winner-take-all) → modulatory → motor",
  flywireLiteral: false,
  generatedDeterministically: true,
  reproducibleFromSeed: true,
  llmInvolved: false,
  note:
    "Every neuron and synapse is produced deterministically by buildConnectome(seed, opts) using an integer PRNG (mulberry32). The laminar organisation and the left/right turn-competition are inspired by the FlyWire adult fruit-fly connectome, trimmed ~50× so 24 brains run per cron tick on the edge. This is NOT a copy of FlyWire adjacency data, and no LLM is used anywhere.",
} as const;

/** LIF integrator constants, recorded so a replay uses the identical dynamics. Mirrors lif.ts. */
export const LIF_CONSTANTS = {
  tauSyn: 5.0,
  R: 1.0,
  rateAlpha: 0.01,
  synapticGain: 3,
  tauAdapt: 200.0,
  adaptIncrement: 0.05,
  adaptMax: 4.0,
  extDecayTau: 20,
  dtMs: 1,
} as const;

/** Per-kind base membrane parameters (before the ±20% seed-derived jitter). Mirrors connectome.ts makeMeta(). */
export const NEURON_BASE_PARAMS: Record<
  NeuronKind,
  { tau: number; vRest: number; vThresh: number; vReset: number; refractory: number }
> = {
  sensory: { tau: 10, vRest: 0, vThresh: 1.0, vReset: -0.5, refractory: 3 },
  inter: { tau: 15, vRest: 0, vThresh: 1.0, vReset: -0.5, refractory: 4 },
  modulatory: { tau: 40, vRest: 0, vThresh: 0.8, vReset: -0.3, refractory: 10 },
  motor: { tau: 8, vRest: 0, vThresh: 1.0, vReset: -0.5, refractory: 2 },
};

/** The jitter window applied to tau/vThresh per neuron (0.8 + rand()*0.4 ⇒ ±20%). Mirrors makeMeta(). */
export const NEURON_JITTER = { min: 0.8, span: 0.4 } as const;

/**
 * A compact, quantised, ULP-safe structural identity of one connectome. Two brains with the same
 * (seed, opts) produce an identical spec; different seeds produce different specs. Small enough to
 * embed 24 of them in a manifest, strong enough (topology edgeHash + integer checksums) that a wiring
 * change cannot slip through.
 */
export interface ConnectomeStructuralSpec {
  neuronCount: number;
  synapseCount: number;
  /** Neuron count per kind. */
  byKind: Record<NeuronKind, number>;
  /** Motor-neuron count per channel (fixed channel order). */
  motorChannels: Record<string, number>;
  /** Sensory-neuron count per channel (fixed channel order). */
  sensoryChannels: Record<string, number>;
  /** Σ round(tau·1e6) over all neurons — integer, exact (tau comes from the integer PRNG). */
  tauMicro: number;
  /** Σ round(vThresh·1e6) over all neurons — integer, exact. */
  threshMicro: number;
  /** Σ round(w·1e3) over all synapses — signed integer, coarse to stay ULP-safe (w comes via gaussian). */
  weightMilli: number;
  /** Mean fan-in per neuron, in milli (round(mean·1e3)). */
  fanInMeanMilli: number;
  /** Max fan-in over all neurons. */
  fanInMax: number;
  /** FNV-1a 32-bit fold over every (pre, post, round(w·1e3)) triple in order — the topology fingerprint. */
  edgeHash: string;
}

/** FNV-1a 32-bit over one byte. */
function fnvByte(h: number, byte: number): number {
  return (Math.imul(h ^ (byte & 0xff), 0x01000193) >>> 0);
}

/** Fold a signed 32-bit integer into the FNV state, byte by byte (little-endian, deterministic). */
function fnvInt(h: number, n: number): number {
  const u = n | 0;
  let x = h;
  x = fnvByte(x, u & 0xff);
  x = fnvByte(x, (u >>> 8) & 0xff);
  x = fnvByte(x, (u >>> 16) & 0xff);
  x = fnvByte(x, (u >>> 24) & 0xff);
  return x;
}

/** Compute the quantised structural spec of an already-built connectome (pure, synchronous). */
export function connectomeStructuralSpec(conn: Connectome): ConnectomeStructuralSpec {
  const byKind: Record<NeuronKind, number> = {
    sensory: conn.byKind.sensory.length,
    inter: conn.byKind.inter.length,
    modulatory: conn.byKind.modulatory.length,
    motor: conn.byKind.motor.length,
  };

  const motorChannels: Record<string, number> = {};
  for (const ch of MOTOR_CHANNEL_LIST) motorChannels[ch] = (conn.byChannel.get(ch) ?? []).length;
  const sensoryChannels: Record<string, number> = {};
  for (const ch of SENSORY_CHANNEL_LIST) sensoryChannels[ch] = (conn.byChannel.get(ch) ?? []).length;

  let tauMicro = 0;
  let threshMicro = 0;
  for (const n of conn.neurons) {
    tauMicro += Math.round(n.tau * 1e6);
    threshMicro += Math.round(n.vThresh * 1e6);
  }

  let weightMilli = 0;
  let edge = 0x811c9dc5; // FNV-1a offset basis
  const fanIn = new Int32Array(conn.neurons.length);
  for (const s of conn.synapses) {
    const wq = Math.round(s.w * 1e3);
    weightMilli += wq;
    edge = fnvInt(edge, s.pre);
    edge = fnvInt(edge, s.post);
    edge = fnvInt(edge, wq);
    if (s.post >= 0 && s.post < fanIn.length) fanIn[s.post]++;
  }

  let fanSum = 0;
  let fanMax = 0;
  for (let i = 0; i < fanIn.length; i++) {
    fanSum += fanIn[i];
    if (fanIn[i] > fanMax) fanMax = fanIn[i];
  }
  const fanInMeanMilli =
    fanIn.length > 0 ? Math.round((fanSum / fanIn.length) * 1e3) : 0;

  return {
    neuronCount: conn.neurons.length,
    synapseCount: conn.synapses.length,
    byKind,
    motorChannels,
    sensoryChannels,
    tauMicro,
    threshMicro,
    weightMilli,
    fanInMeanMilli,
    fanInMax: fanMax,
    edgeHash: edge.toString(16).padStart(8, "0"),
  };
}

/**
 * The exact call an offline verifier makes: rebuild a connectome from (seed, opts) and spec it. `seed`
 * is authoritative (opts never carries one). Deterministic — same inputs ⇒ identical spec, always.
 */
export function connectomeSpecForSeed(
  seed: number,
  opts: ConnectomeOptions = {},
): ConnectomeStructuralSpec {
  return connectomeStructuralSpec(buildConnectome({ ...opts, seed }));
}

/**
 * Fill in the generator defaults so a manifest records the EFFECTIVE sizing (never `undefined`), which
 * is what a verifier needs to rebuild without knowing buildConnectome's internal fallbacks. An explicit
 * undefined in opts falls back to the default, exactly like buildConnectome does.
 */
export function effectiveConnectomeOptions(
  opts: ConnectomeOptions = {},
): Required<ConnectomeOptions> {
  return {
    seed: opts.seed ?? DEFAULT_CONNECTOME_OPTIONS.seed,
    nSensory: opts.nSensory ?? DEFAULT_CONNECTOME_OPTIONS.nSensory,
    nInterL1: opts.nInterL1 ?? DEFAULT_CONNECTOME_OPTIONS.nInterL1,
    nInterL2: opts.nInterL2 ?? DEFAULT_CONNECTOME_OPTIONS.nInterL2,
    nModulatory: opts.nModulatory ?? DEFAULT_CONNECTOME_OPTIONS.nModulatory,
    nMotorPerChannel: opts.nMotorPerChannel ?? DEFAULT_CONNECTOME_OPTIONS.nMotorPerChannel,
    density: opts.density ?? DEFAULT_CONNECTOME_OPTIONS.density,
  };
}
