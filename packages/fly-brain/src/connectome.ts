import type {
  Connectome,
  MotorChannel,
  NeuronKind,
  NeuronMeta,
  SensoryChannel,
  Synapse,
} from "./types.js";

/**
 * Fruit-fly-style layered connectome generator.
 *
 * Inspiration: the FlyWire adult fruit-fly whole-brain connectome (~138k neurons / ~5M synapses),
 * trimmed down to a compact version that runs in real time inside a Cloudflare Worker:
 *
 *   Sensory layer          : ~180 neurons  ← outside world & governance stimuli
 *   Interneuron layer L1   : ~400 neurons  ← feature extraction
 *   Interneuron layer L2   : ~400 neurons  ← decision competition (left/right symmetric)
 *   Modulatory layer       : ~40  neurons  ← "mood" (dopamine / octopamine)
 *   Motor layer            : ~60  neurons  ← 5 channels × 12 neurons each
 *
 *   Total ~1,080 neurons, ~30k synapses (sparse connectivity)
 *
 * Structural symmetry:
 *   Inter L2 is split into a "left half" and a "right half" biased toward the
 *   leg_left / leg_right motor channels respectively, forming a mutually
 *   inhibitory winner-take-all competition network whose left/right asymmetry the
 *   behaviour decoder reads as the fly's turn bias (approach–avoid lean).
 */

export interface ConnectomeOptions {
  /** Random seed (reproducible) */
  seed?: number;
  /** Number of sensory neurons */
  nSensory?: number;
  /** Number of Inter L1 neurons */
  nInterL1?: number;
  /** Number of Inter L2 neurons (half on each side) */
  nInterL2?: number;
  /** Number of modulatory neurons */
  nModulatory?: number;
  /** Number of neurons per motor channel */
  nMotorPerChannel?: number;
  /** Connection density (0..1) */
  density?: number;
}

const MOTOR_CHANNELS: MotorChannel[] = [
  "leg_left",
  "leg_right",
  "wing",
  "proboscis",
  "abdomen",
];

const SENSORY_CHANNELS: SensoryChannel[] = [
  "thermal_warmth",
  "thermal_flux",
  "mechanical_turbulence",
  "olfactory_density",
  "gustatory_richness",
  "internal_arousal",
  "stimulus_food",
  "stimulus_threat",
  "stimulus_light",
  "stimulus_dark",
];

/** Simple reproducible PRNG (mulberry32) */
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

function makeMeta(
  id: number,
  kind: NeuronKind,
  channel: SensoryChannel | MotorChannel | null,
  rand: () => number,
): NeuronMeta {
  // Normalized LIF parameters: vRest=0, vThresh≈1, vReset=-0.5
  // Jitter gives each fly's neurons ±20% individual variance on thresholds
  const jitter = () => 0.8 + rand() * 0.4;
  const base = {
    sensory:     { tau: 10, vRest: 0, vThresh: 1.0, vReset: -0.5, refractory: 3 },
    inter:       { tau: 15, vRest: 0, vThresh: 1.0, vReset: -0.5, refractory: 4 },
    modulatory:  { tau: 40, vRest: 0, vThresh: 0.8, vReset: -0.3, refractory: 10 },
    motor:       { tau: 8,  vRest: 0, vThresh: 1.0, vReset: -0.5, refractory: 2 },
  }[kind];
  return {
    id,
    kind,
    channel,
    tau: base.tau * jitter(),
    vRest: base.vRest,
    vThresh: base.vThresh * jitter(),
    vReset: base.vReset,
    refractory: base.refractory,
  };
}

/**
 * The exact default generator parameters buildConnectome() falls back to. Exported so a brain manifest
 * can record the AUTHORITATIVE sizing from one source of truth (a verifier rebuilding from these opts +
 * a seed reproduces the graph byte-for-byte). buildConnectome keeps destructuring-with-defaults below, so
 * an explicit `undefined` in opts still falls back to these — behaviour is identical to before.
 */
export const DEFAULT_CONNECTOME_OPTIONS: Required<ConnectomeOptions> = {
  seed: 0xfeedface,
  nSensory: 180,
  nInterL1: 400,
  nInterL2: 400,
  nModulatory: 40,
  nMotorPerChannel: 12,
  density: 0.02,
};

export function buildConnectome(opts: ConnectomeOptions = {}): Connectome {
  const {
    seed = DEFAULT_CONNECTOME_OPTIONS.seed,
    nSensory = DEFAULT_CONNECTOME_OPTIONS.nSensory,
    nInterL1 = DEFAULT_CONNECTOME_OPTIONS.nInterL1,
    nInterL2 = DEFAULT_CONNECTOME_OPTIONS.nInterL2,
    nModulatory = DEFAULT_CONNECTOME_OPTIONS.nModulatory,
    nMotorPerChannel = DEFAULT_CONNECTOME_OPTIONS.nMotorPerChannel,
    density = DEFAULT_CONNECTOME_OPTIONS.density,
  } = opts;

  const rand = mulberry32(seed);
  const neurons: NeuronMeta[] = [];
  const synapses: Synapse[] = [];

  // ============ 1) Allocate neurons ============
  const ranges = {} as Record<NeuronKind, [number, number]>;
  const channelMap = new Map<string, number[]>();

  // Sensory
  const sensoryStart = neurons.length;
  for (let i = 0; i < nSensory; i++) {
    const ch = SENSORY_CHANNELS[i % SENSORY_CHANNELS.length];
    const id = neurons.length;
    neurons.push(makeMeta(id, "sensory", ch, rand));
    const arr = channelMap.get(ch) ?? [];
    arr.push(id);
    channelMap.set(ch, arr);
  }
  ranges.sensory = [sensoryStart, neurons.length];

  // Inter L1
  const l1Start = neurons.length;
  for (let i = 0; i < nInterL1; i++) {
    neurons.push(makeMeta(neurons.length, "inter", null, rand));
  }
  const l1End = neurons.length;

  // Inter L2 (left/right symmetric)
  const l2Start = neurons.length;
  const l2Half = Math.floor(nInterL2 / 2);
  for (let i = 0; i < nInterL2; i++) {
    neurons.push(makeMeta(neurons.length, "inter", null, rand));
  }
  const l2End = neurons.length;
  const l2Left = [l2Start, l2Start + l2Half] as [number, number];
  const l2Right = [l2Start + l2Half, l2End] as [number, number];

  // Modulatory
  const modStart = neurons.length;
  for (let i = 0; i < nModulatory; i++) {
    neurons.push(makeMeta(neurons.length, "modulatory", null, rand));
  }
  ranges.modulatory = [modStart, neurons.length];

  // Motor
  const motorStart = neurons.length;
  for (const ch of MOTOR_CHANNELS) {
    const ids: number[] = [];
    for (let i = 0; i < nMotorPerChannel; i++) {
      const id = neurons.length;
      neurons.push(makeMeta(id, "motor", ch, rand));
      ids.push(id);
    }
    channelMap.set(ch, ids);
  }
  ranges.motor = [motorStart, neurons.length];
  ranges.inter = [l1Start, l2End];

  // ============ 2) Wire the synapses ============
  const connect = (
    fromRange: [number, number],
    toRange: [number, number],
    d: number,
    wMean: number,
    wStd: number,
  ) => {
    for (let post = toRange[0]; post < toRange[1]; post++) {
      const fan = Math.max(1, Math.floor((fromRange[1] - fromRange[0]) * d));
      for (let k = 0; k < fan; k++) {
        const pre =
          fromRange[0] + Math.floor(rand() * (fromRange[1] - fromRange[0]));
        const w = gaussian(rand, wMean, wStd);
        synapses.push({ pre, post, w });
      }
    }
  };

  // Sensory → Inter L1 (excitatory)
  connect(ranges.sensory, [l1Start, l1End], density * 1.5, 0.40, 0.10);
  // Inter L1 → Inter L2 (excitatory)
  connect([l1Start, l1End], [l2Start, l2End], density * 1.2, 0.35, 0.10);
  // Inter L2 left ↔ right mutual inhibition (winner-take-all)
  connect(l2Left, l2Right, density * 0.8, -1.0, 0.2);
  connect(l2Right, l2Left, density * 0.8, -1.0, 0.2);
  // Inter L2 same-side mild excitation (sustains persistent firing)
  connect(l2Left, l2Left, density * 0.3, 0.15, 0.05);
  connect(l2Right, l2Right, density * 0.3, 0.15, 0.05);

  // Inter L2 left → leg_left motor (excitatory)
  const legLeftIds = channelMap.get("leg_left")!;
  const legRightIds = channelMap.get("leg_right")!;
  for (const post of legLeftIds) {
    const fan = 40;
    for (let k = 0; k < fan; k++) {
      const pre = l2Left[0] + Math.floor(rand() * (l2Left[1] - l2Left[0]));
      synapses.push({ pre, post, w: gaussian(rand, 0.15, 0.04) });
    }
  }
  for (const post of legRightIds) {
    const fan = 40;
    for (let k = 0; k < fan; k++) {
      const pre = l2Right[0] + Math.floor(rand() * (l2Right[1] - l2Right[0]));
      synapses.push({ pre, post, w: gaussian(rand, 0.15, 0.04) });
    }
  }

  // Inter L2 → wing / abdomen (excitatory, from the sum of both sides)
  const wingIds = channelMap.get("wing")!;
  const abdomenIds = channelMap.get("abdomen")!;
  for (const post of [...wingIds, ...abdomenIds]) {
    const fan = 30;
    for (let k = 0; k < fan; k++) {
      const pre = l2Start + Math.floor(rand() * (l2End - l2Start));
      synapses.push({ pre, post, w: gaussian(rand, 0.10, 0.03) });
    }
  }

  // gustatory_richness sensory → proboscis motor (appetitive richness → extend proboscis = approach).
  // FIXED fan-in (like the leg/wing channels above), NOT all-to-all: a probabilistic all-to-all wiring
  // makes each proboscis neuron's input count scale with the gustatory population, so at 10× sizing it
  // over-fans (~63 inputs vs ~6 at default) and saturates the channel (normalized pinned at 1, killing
  // the cohesion drive's population spread). A constant fan-in keeps the reflex drive scale-invariant;
  // 6 ≈ the default expected count (0.35 × 18 gustatory neurons).
  const gusIds = channelMap.get("gustatory_richness") ?? [];
  const probIds = channelMap.get("proboscis")!;
  const probFan = Math.max(1, Math.min(gusIds.length, 6));
  for (const post of probIds) {
    for (let k = 0; k < probFan; k++) {
      const pre = gusIds[Math.floor(rand() * gusIds.length)];
      synapses.push({ pre, post, w: gaussian(rand, 0.15, 0.04) });
    }
  }

  // Modulatory ↔ whole brain (diffuse modulation, sparse)
  for (let post = 0; post < neurons.length; post++) {
    if (rand() < 0.05) {
      const pre = modStart + Math.floor(rand() * (neurons.length - modStart));
      synapses.push({ pre, post, w: gaussian(rand, 0.12, 0.04) });
    }
  }
  // Sensory & L1 → Modulatory
  connect([sensoryStart, l1End], [modStart, modStart + nModulatory], density * 0.4, 0.05, 0.015);

  // stimulus_threat → modulatory (negative bias: induces "anxiety")
  const threatIds = channelMap.get("stimulus_threat") ?? [];
  for (const pre of threatIds) {
    for (let post = modStart; post < modStart + nModulatory; post++) {
      if (rand() < 0.25) synapses.push({ pre, post, w: gaussian(rand, 0.06, 0.015) });
    }
  }

  // ============ 3) Build byKind / byChannel indices ============
  const byKind: Record<NeuronKind, number[]> = {
    sensory: [],
    inter: [],
    modulatory: [],
    motor: [],
  };
  for (const n of neurons) byKind[n.kind].push(n.id);

  return { neurons, synapses, byKind, byChannel: channelMap };
}

/** Box-Muller Gaussian sampler */
function gaussian(rand: () => number, mean: number, std: number): number {
  let u = 0, v = 0;
  while (u === 0) u = rand();
  while (v === 0) v = rand();
  const n = Math.sqrt(-2.0 * Math.log(u)) * Math.cos(2.0 * Math.PI * v);
  return mean + std * n;
}

export const MOTOR_CHANNEL_LIST = MOTOR_CHANNELS;
export const SENSORY_CHANNEL_LIST = SENSORY_CHANNELS;
