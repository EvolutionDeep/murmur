import { LifNetwork } from "./lif.js";
import {
  buildConnectome,
  MOTOR_CHANNEL_LIST,
  type ConnectomeOptions,
} from "./connectome.js";
import type {
  BrainSnapshot,
  Connectome,
  IFlyBrain,
  MotorChannel,
  MotorOutput,
  SensoryInput,
} from "./types.js";

/**
 * Reference sensory-channel size the injection gain was calibrated at (default nSensory 180 / 10
 * channels = 18). inject() normalises per-neuron drive against THIS constant rather than the live
 * channel size, so scaling the connectome up (e.g. 10× → 180-neuron channels) leaves each sensory
 * neuron's drive — and the whole calibrated downstream dynamic — unchanged. See inject().
 */
const SENSORY_DRIVE_REF = 18;

/**
 * FlyBrain — top-level wrapper around the whole fruit-fly brain simulation.
 *
 * Lifecycle:
 *   const brain = new FlyBrain({ seed: 42 });
 *   brain.inject({ channel: "thermal_warmth", intensity: 0.7 });
 *   for (let i = 0; i < 100; i++) brain.tick(1);   // advance 100 ms
 *   const motor = brain.readMotor("leg_left");
 *
 * Sensory injection strategy:
 *   inject() turns intensity into external current, distributes it evenly across
 *   every sensory neuron on that channel, and layers a constant spontaneous
 *   noise current on top (mimicking biological neurons' random firing) so the
 *   fly is never completely silent, even without external input.
 */
export class FlyBrain implements IFlyBrain {
  readonly connectome: Connectome;
  private readonly net: LifNetwork;
  private readonly channelNeurons: Map<string, number[]>;
  /** Spontaneous-noise amplitude per sensory channel */
  private readonly spontaneousRate: number;
  /** Injection gain: maps 0..1 intensity onto a current magnitude that can trigger spikes */
  private readonly injectGain: number;
  /** Internal noise source */
  private noiseState: number;

  constructor(opts: ConnectomeOptions & {
    spontaneousRate?: number;
    injectGain?: number;
  } = {}) {
    this.connectome = buildConnectome(opts);
    this.net = new LifNetwork(this.connectome.neurons, this.connectome.synapses);
    this.channelNeurons = this.connectome.byChannel;
    this.spontaneousRate = opts.spontaneousRate ?? 0.3;
    this.injectGain = opts.injectGain ?? 50;
    this.noiseState = (opts.seed ?? 0xfeedface) >>> 0;
  }

  get t(): number {
    return this.net.t;
  }
  get step(): number {
    return this.net.step;
  }
  get network(): LifNetwork {
    return this.net;
  }

  /** Inject a sensory stimulus */
  inject(input: SensoryInput): void {
    const ids = this.channelNeurons.get(input.channel);
    if (!ids || ids.length === 0) return;
    // Normalise against the fixed reference channel size, NOT ids.length — dividing by ids.length
    // would dilute each neuron's drive 10× when the connectome is scaled 10× (180-neuron channels),
    // starving sensory→L1→L2→motor so the leg/wing/abdomen channels fall silent. See SENSORY_DRIVE_REF.
    const amplitude = (input.intensity * this.injectGain) / SENSORY_DRIVE_REF;
    for (const id of ids) {
      this.net.injectCurrent(id, amplitude);
    }
  }

  /** Advance one simulation step */
  tick(dtMs: number = 1): void {
    // Layer spontaneous noise so sensory neurons have baseline random firing
    this.addSpontaneousNoise(dtMs);
    this.net.tick(dtMs);
  }

  /** Advance ms milliseconds in one call (internally stepped at 1 ms) */
  advance(ms: number): void {
    const steps = Math.max(1, Math.floor(ms));
    for (let i = 0; i < steps; i++) this.tick(1);
  }

  private addSpontaneousNoise(dtMs: number): void {
    // xorshift32 for fast pseudo-random numbers
    const sensory = this.connectome.byKind.sensory;
    for (const id of sensory) {
      const r = this.rand();
      if (r < this.spontaneousRate * dtMs * 0.05) {
        this.net.injectCurrent(id, 1.0 + this.rand() * 1.5);
      }
    }
  }

  private rand(): number {
    let x = this.noiseState;
    x ^= x << 13; x >>>= 0;
    x ^= x >>> 17;
    x ^= x << 5;  x >>>= 0;
    this.noiseState = x;
    return x / 4294967296;
  }

  /** Read the firing rate of a given motor channel */
  readMotor(channel: MotorChannel, windowMs: number = 500): MotorOutput {
    const ids = this.channelNeurons.get(channel) ?? [];
    if (ids.length === 0) {
      return { channel, firingRate: 0, spikes: 0, normalized: 0 };
    }
    let sumRate = 0;
    let spikes = 0;
    for (const id of ids) {
      sumRate += this.net.firingRate[id];
      if (this.net.spiking[id] === 1) spikes++;
    }
    const avgRate = sumRate / ids.length;
    // Normalization: 50 Hz counts as full motor output
    const normalized = Math.min(1, avgRate / 50);
    return { channel, firingRate: avgRate, spikes, normalized };
  }

  /** Read every motor channel in one call */
  readAllMotor(windowMs: number = 500): MotorOutput[] {
    return MOTOR_CHANNEL_LIST.map((ch) => this.readMotor(ch, windowMs));
  }

  /** Full snapshot (used for frontend visualization) */
  snapshot(): BrainSnapshot {
    return {
      t: this.net.t,
      step: this.net.step,
      membrane: this.net.V,
      spikesLastStep: this.net.spiking,
      firingRates: this.net.firingRate,
      motor: this.readAllMotor(),
    };
  }

  /** Serialize to a string (for persistence into a Durable Object / D1).
   *  version 3 marks archives written under the TUNED SFA (adaptIncrement=0.05) that actually breaks
   *  the WTA latch under the worker's real drive; see deserialize() for the one-time migration that
   *  wakes brains frozen in the latch (v1 = pre-SFA, v2 = re-latched under the too-weak 0.03 SFA). */
  serialize(): string {
    return JSON.stringify({
      version: 3,
      net: this.net.toJSON(),
      noiseState: this.noiseState,
    });
  }

  /** Deserialize from a string (the connectome structure must match — same seed & options).
   *  Two cases DISCARD the archived electrical state and wake the network fresh:
   *   (1) a differently-sized connectome (e.g. after a neuron-count upgrade) — the TypedArray layout
   *       no longer lines up, so restoring would misalign membrane potentials;
   *   (2) a pre-v3 archive — v1 predates spike-frequency adaptation (SFA); v2 was written under the
   *       too-weak 0.03 SFA and re-latched — either may be frozen in the permanent winner-take-all
   *       latch that SFA was added to cure (one motor leg pinned at
   *       max rate, the antagonist silent, never flipping). SFA prevents a latch from forming but
   *       cannot by itself release one that is already latched, so restoring that pathological state
   *       would keep the fly frozen. We therefore reset the dynamic state (membrane/synaptic/rate)
   *       while preserving the sim clock. The connectome is rebuilt deterministically from the seed
   *       and the fly's stats/generation/parent live OUTSIDE the brain, so lineage is fully preserved;
   *       SFA then keeps the woken network from re-latching. */
  static deserialize(
    data: string,
    opts: ConnectomeOptions = {},
  ): FlyBrain {
    const parsed = JSON.parse(data);
    const brain = new FlyBrain(opts);
    const sameSize =
      parsed?.net && Array.isArray(parsed.net.V) && parsed.net.V.length === brain.net.N;
    const sfaEra = (parsed?.version ?? 1) >= 3;
    if (sameSize && sfaEra) {
      brain.net.fromJSON(parsed.net);
    } else if (sameSize && parsed.net) {
      // pre-v3 archive (v1 = pre-SFA, v2 = still latched under the too-weak 0.03 SFA): keep the
      // simulation clock continuous but wake the electrical state fresh so the tuned 0.05 SFA bites.
      brain.net.t = parsed.net.t ?? 0;
      brain.net.step = parsed.net.step ?? 0;
    }
    if (typeof parsed?.noiseState === "number") brain.noiseState = parsed.noiseState;
    return brain;
  }
}
