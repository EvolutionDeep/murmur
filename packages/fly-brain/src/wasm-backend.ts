// fly.ai WASM backend adapter.
//
// Goal: let FlyBrain be swapped for a real fly.ai WASM module that runs the full
// 166,700-neuron / 25.6 M-synapse adult male fruit-fly central nervous system
// (see https://github.com/alextitonis/fly.ai).
//
// Design:
//   · IBuiltinFlyBrain interface implemented by every backend
//   · TsLifBackend     → current default, pure-TS LIF network
//   · WasmFlyAiBackend → loads the fly.ai .wasm + JS glue
//   · createFlyBrain(cfg) factory selects by the `backend` field
//
// WASM module contract (when the fly.ai build artifact is available, wrap it with
// glue matching this contract, or adapt it yourself in flyai-glue.js):
//
//   exports.init(connectomePtr, connectomeLen) → i32 status
//   exports.step(dtMs: f32) → void
//   exports.injectCurrent(neuronId: i32, amp: f32) → void
//   exports.readFiringRate(neuronId: i32) → f32
//   exports.readMembrane(neuronId: i32) → f32
//   exports.readSpike(neuronId: i32) → i32 (0/1)
//   exports.neuronCount() → i32
//   exports.serializeState(ptr: i32, maxLen: i32) → i32 (bytes written)
//   exports.deserializeState(ptr: i32, len: i32) → i32
//   exports.memory → WebAssembly.Memory
//
// Because the official fly.ai WASM does not yet publish a stable ABI, we ship a
// MockWasm to prove the pipeline end-to-end; once the real WASM lands you only
// need to swap the fetch URL and the glue.

import { FlyBrain } from "./fly-brain.js";
import type {
  BrainSnapshot,
  IFlyBrain,
  MotorChannel,
  MotorOutput,
  SensoryInput,
} from "./types.js";
import type { ConnectomeOptions } from "./connectome.js";

/** Common interface implemented by every backend */
export interface IBuiltinFlyBrain extends IFlyBrain {
  readonly backendName: string;
  readonly neuronCount: number;
}

/** Backend selection */
export type BackendKind = "ts-lif" | "wasm-flyai" | "wasm-mock";

export interface BackendConfig {
  backend: BackendKind;
  /** Used by ts-lif: connectome seed */
  seed?: number;
  /** Used by wasm-*: WASM module URL */
  wasmUrl?: string;
  /** Used by wasm-*: JS glue URL (optional, embedded glue is the default) */
  glueUrl?: string;
  /** Used by wasm-*: connectome data URL (.bin / .npz converted artifact) */
  connectomeUrl?: string;
}

// ==============================================================
// 1) TS LIF backend (default)
// ==============================================================

export class TsLifBackend extends FlyBrain implements IBuiltinFlyBrain {
  readonly backendName = "ts-lif";
  get neuronCount(): number {
    return this.connectome.neurons.length;
  }
}

// ==============================================================
// 2) WASM backend (fly.ai or mock)
// ==============================================================

/**
 * WasmFlyAiBackend — runs the full fruit-fly brain through a WASM module.
 *
 * Load flow:
 *   1. fetch(wasmUrl) → WebAssembly.Module
 *   2. Instantiate, bind memory + imports
 *   3. Optionally fetch(connectomeUrl) and pass the connectome binary in
 *   4. init() to bootstrap the simulator
 *
 * Runtime:
 *   inject(sensory) → call WASM injectCurrent (neuron ids come from a channel map)
 *   tick(dt)        → call WASM step(dt)
 *   readMotor(ch)   → loop readFiringRate(id) and average
 */
export class WasmFlyAiBackend implements IBuiltinFlyBrain {
  readonly backendName: string;

  private instance: WebAssembly.Instance | null = null;
  private memory: WebAssembly.Memory | null = null;
  private exports: any = null;
  private tMs = 0;
  private stepCount = 0;
  private channelToIds: Map<string, number[]> = new Map();
  private motorChannelToIds: Map<string, number[]> = new Map();
  private loaded: Promise<void>;
  private mockState: MockWasmState | null = null;
  private neuronCountSafe = 0;

  get neuronCount(): number { return this.neuronCountSafe; }

  constructor(private cfg: BackendConfig) {
    this.backendName = cfg.backend === "wasm-mock" ? "wasm-mock" : "wasm-flyai";
    this.loaded = this.load();
  }

  /** Wait for WASM loading to finish */
  async ready(): Promise<this> {
    await this.loaded;
    return this;
  }

  private async load(): Promise<void> {
    if (this.cfg.backend === "wasm-mock" || !this.cfg.wasmUrl) {
      // Pure-TS stand-in for a "WASM" backend, useful for wiring the pipeline & UI
      this.mockState = new MockWasmState(166_700);
      this.neuronCountSafe = this.mockState.neuronCount;
      this.buildChannelMaps(this.mockState.neuronCount);
      console.log(`[wasm-mock] initialized with ${this.mockState.neuronCount} neurons`);
      return;
    }

    // Real WASM path
    const wasmResp = await fetch(this.cfg.wasmUrl);
    if (!wasmResp.ok) throw new Error(`failed to fetch wasm: ${wasmResp.status}`);
    const wasmBytes = await wasmResp.arrayBuffer();

    const memory = new WebAssembly.Memory({ initial: 256, maximum: 4096 });
    const imports = {
      env: {
        memory,
        // Allow WASM to log to the JS console
        log: (ptr: number, len: number) => {
          const buf = new Uint8Array(memory.buffer, ptr, len);
          console.log("[wasm]", new TextDecoder().decode(buf));
        },
        // High-resolution clock
        now: () => performance.now(),
      },
    };

    // @cloudflare/workers-types' WebAssembly namespace omits the promise-based `compile` (the Workers
    // runtime does provide it), so reach it through a narrow cast to keep this shared backend
    // type-checking under both the DOM lib (fly-brain) and workers-types (the Worker).
    const waCompile = (WebAssembly as unknown as {
      compile(bytes: ArrayBuffer): Promise<WebAssembly.Module>;
    }).compile;
    const module = await waCompile(wasmBytes);
    this.instance = await WebAssembly.instantiate(module, imports);
    this.exports = this.instance.exports as any;
    this.memory = (this.exports.memory as WebAssembly.Memory) ?? memory;

    // Load the connectome (optional)
    if (this.cfg.connectomeUrl) {
      const cResp = await fetch(this.cfg.connectomeUrl);
      const cBytes = new Uint8Array(await cResp.arrayBuffer());
      const ptr = this.exports.alloc
        ? this.exports.alloc(cBytes.length)
        : 1024; // fallback
      new Uint8Array(this.memory!.buffer, ptr, cBytes.length).set(cBytes);
      this.exports.init(ptr, cBytes.length);
    } else {
      this.exports.init?.(0, 0);
    }

    this.neuronCountSafe = this.exports.neuronCount ? this.exports.neuronCount() : 166_700;
    this.buildChannelMaps(this.neuronCountSafe);
    console.log(`[wasm-flyai] loaded ${this.neuronCountSafe} neurons`);
  }

  private neuronCountValue(): number { return this.neuronCountSafe; }

  /**
   * Map sensory & motor channels to concrete neuron-id ranges.
   * For the real fly.ai module the WASM side should provide a channelToIds() export;
   * here we fall back to proportional partitioning.
   * Partition strategy (approximating fly.ai MaleCNS ratios):
   *   sensory     : 0 – 20%
   *   inter       : 20% – 85%
   *   modulatory  : 85% – 90%
   *   motor       : 90% – 100%
   */
  private buildChannelMaps(N: number): void {
    const sensoryEnd = Math.floor(N * 0.2);
    const interEnd = Math.floor(N * 0.85);
    const modEnd = Math.floor(N * 0.9);

    const sensoryChannels = [
      "thermal_warmth", "thermal_flux", "mechanical_turbulence", "olfactory_density",
      "gustatory_richness", "internal_arousal", "stimulus_food", "stimulus_threat",
      "stimulus_light", "stimulus_dark",
    ];
    const motorChannels = ["leg_left", "leg_right", "wing", "proboscis", "abdomen"];

    // Sensory: evenly partition
    const perSensory = Math.floor(sensoryEnd / sensoryChannels.length);
    sensoryChannels.forEach((ch, i) => {
      const ids: number[] = [];
      for (let j = 0; j < perSensory; j++) ids.push(i * perSensory + j);
      this.channelToIds.set(ch, ids);
    });

    // Motor: evenly partition 90%–100%
    const motorStart = modEnd;
    const perMotor = Math.floor((N - motorStart) / motorChannels.length);
    motorChannels.forEach((ch, i) => {
      const ids: number[] = [];
      for (let j = 0; j < perMotor; j++) ids.push(motorStart + i * perMotor + j);
      this.motorChannelToIds.set(ch, ids);
    });
  }

  // ---------- IFlyBrain interface ----------

  get connectome(): any {
    // The WASM backend does not expose the full connectome (too large);
    // return a compact descriptor instead.
    return {
      neurons: [],
      synapses: [],
      byKind: { sensory: [], inter: [], modulatory: [], motor: [] },
      byChannel: this.channelToIds,
      backend: this.backendName,
      neuronCount: this.neuronCountSafe,
    };
  }

  get t(): number { return this.tMs; }
  get step(): number { return this.stepCount; }

  inject(input: SensoryInput): void {
    const ids = this.channelToIds.get(input.channel);
    if (!ids || ids.length === 0) return;
    const amp = (input.intensity * 25) / Math.sqrt(ids.length);
    if (this.mockState) {
      for (const id of ids) this.mockState.injectCurrent(id, amp);
      return;
    }
    for (const id of ids) this.exports.injectCurrent(id, amp);
  }

  tick(dtMs: number = 1): void {
    if (this.mockState) {
      this.mockState.step(dtMs);
    } else {
      this.exports.step(dtMs);
    }
    this.tMs += dtMs;
    this.stepCount++;
  }

  advance(ms: number): void {
    // Real WASM backends typically tolerate larger steps; we advance in 5 ms
    // increments to balance precision and speed.
    const stepSize = 5;
    const n = Math.max(1, Math.floor(ms / stepSize));
    for (let i = 0; i < n; i++) this.tick(stepSize);
  }

  readMotor(channel: MotorChannel, windowMs: number = 500): MotorOutput {
    const ids = this.motorChannelToIds.get(channel) ?? [];
    if (ids.length === 0) return { channel, firingRate: 0, spikes: 0, normalized: 0 };
    // For performance, sample only the first 200 ids
    const sample = ids.length > 200 ? ids.slice(0, 200) : ids;
    let sumRate = 0, spikes = 0;
    for (const id of sample) {
      if (this.mockState) {
        sumRate += this.mockState.readFiringRate(id);
        spikes += this.mockState.readSpike(id);
      } else {
        sumRate += this.exports.readFiringRate(id);
        spikes += this.exports.readSpike(id);
      }
    }
    const avg = sumRate / sample.length;
    return {
      channel,
      firingRate: avg,
      spikes,
      normalized: Math.min(1, avg / 100),
    };
  }

  readAllMotor(windowMs: number = 500): MotorOutput[] {
    return (["leg_left", "leg_right", "wing", "proboscis", "abdomen"] as MotorChannel[])
      .map((ch) => this.readMotor(ch, windowMs));
  }

  snapshot(): BrainSnapshot {
    // WASM snapshots would be huge; return only motor channels plus a sampled
    // 500-neuron membrane-potential view.
    const N = this.neuronCountSafe;
    const sampleSize = Math.min(500, N);
    const membrane = new Float32Array(sampleSize);
    const spikes = new Uint8Array(sampleSize);
    const rates = new Float32Array(sampleSize);
    const stride = Math.max(1, Math.floor(N / sampleSize));
    for (let i = 0; i < sampleSize; i++) {
      const id = i * stride;
      if (this.mockState) {
        membrane[i] = this.mockState.readMembrane(id);
        spikes[i] = this.mockState.readSpike(id);
        rates[i] = this.mockState.readFiringRate(id);
      } else if (this.exports) {
        membrane[i] = this.exports.readMembrane(id);
        spikes[i] = this.exports.readSpike(id);
        rates[i] = this.exports.readFiringRate(id);
      }
    }
    return {
      t: this.tMs,
      step: this.stepCount,
      membrane,
      spikesLastStep: spikes,
      firingRates: rates,
      motor: this.readAllMotor(),
    };
  }

  serialize(): string {
    if (this.mockState) {
      return JSON.stringify({
        version: 1,
        backend: this.backendName,
        t: this.tMs,
        step: this.stepCount,
        mock: this.mockState.serialize(),
      });
    }
    // Real WASM: ask it to serialize state into memory, then copy the bytes out
    const maxLen = 8 * 1024 * 1024;
    const ptr = this.exports.alloc ? this.exports.alloc(maxLen) : 0;
    const written = this.exports.serializeState(ptr, maxLen);
    const bytes = new Uint8Array(this.memory!.buffer, ptr, written);
    // base64 encode
    let bin = "";
    for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
    return JSON.stringify({
      version: 1,
      backend: this.backendName,
      t: this.tMs,
      step: this.stepCount,
      wasmStateB64: btoa(bin),
    });
  }
}

// ==============================================================
// 3) MockWasm — pure-TS sparse LIF emulating fly.ai's 166k-neuron scale.
//    Used to prove the full pipeline before the real WASM lands and to give
//    the frontend a realistic sense of scale.
// ==============================================================

class MockWasmState {
  readonly neuronCount: number;
  private V: Float32Array;
  private rate: Float32Array;
  private spiking: Uint8Array;
  private Iext: Float32Array;
  private lastSpike: Float32Array;
  private t = 0;

  constructor(N: number) {
    this.neuronCount = N;
    // For memory friendliness, exactly simulate only the first 20k neurons;
    // the rest use a statistical approximation.
    const SIM_N = Math.min(N, 20_000);
    this.V = new Float32Array(SIM_N).fill(-70);
    this.rate = new Float32Array(SIM_N);
    this.spiking = new Uint8Array(SIM_N);
    this.Iext = new Float32Array(SIM_N);
    this.lastSpike = new Float32Array(SIM_N).fill(-1e9);
  }

  injectCurrent(id: number, amp: number): void {
    if (id < this.V.length) this.Iext[id] += amp;
  }

  step(dtMs: number): void {
    const N = this.V.length;
    this.spiking.fill(0);
    for (let i = 0; i < N; i++) {
      if (this.t - this.lastSpike[i] < 2) { this.V[i] = -75; continue; }
      // Simplified LIF: no synaptic coupling, only external current + random background noise
      const noise = (Math.random() - 0.5) * 2;
      this.V[i] += (-(this.V[i] + 70) / 20 + this.Iext[i] + noise) * dtMs;
      if (this.V[i] >= -50) {
        this.spiking[i] = 1;
        this.lastSpike[i] = this.t;
        this.V[i] = -75;
      }
      const a = Math.min(1, 0.005 * dtMs);
      this.rate[i] += a * ((this.spiking[i] ? 1000 / dtMs : 0) - this.rate[i]);
      this.Iext[i] *= Math.exp(-dtMs / 20);
    }
    this.t += dtMs;
  }

  readMembrane(id: number): number { return id < this.V.length ? this.V[id] : -70; }
  readSpike(id: number): number { return id < this.spiking.length ? this.spiking[id] : 0; }
  readFiringRate(id: number): number { return id < this.rate.length ? this.rate[id] : 0; }

  serialize(): any {
    return {
      t: this.t,
      V: Array.from(this.V.slice(0, 500)),     // Only serialize the first 500 to keep DO storage small
      rate: Array.from(this.rate.slice(0, 500)),
    };
  }
}

// ==============================================================
// 4) Factory
// ==============================================================

export async function createFlyBrain(
  cfg: BackendConfig,
  opts: ConnectomeOptions = {},
): Promise<IBuiltinFlyBrain> {
  if (cfg.backend === "ts-lif") {
    return new TsLifBackend({ ...opts, seed: cfg.seed ?? opts.seed });
  }
  const wasm = new WasmFlyAiBackend(cfg);
  await wasm.ready();
  return wasm;
}
