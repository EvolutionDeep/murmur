// Offline diagnostic harness for the 10x motor-read-out degeneration (x6).
//
// Faithfully reproduces the LIVE worker pipeline WITHOUT the Durable Objects, so the connectome motor
// wiring can be re-tuned against real drive data in a fast local loop (memory: offline tuning MUST
// replicate the live input pipeline). Per cron it mirrors, exactly:
//   · state.ts cronInner   — 6 sub-ticks, subSteps = floor(500/6) = 83 ms each
//   · population.advanceFlies — per-fly encodeMarketPulse({...pulse, arousal: temperament}), chunk 50 ms
//   · population.reduceReadOuts — global computeBands(raws) → per-fly MotorDecoder.decode (hysteresis carried)
//   · market.derivePulse   — a CALM pulse at the given temperature
//
// Run:  npx tsx packages/fly-brain/diag-motor.ts [temperature]
// Prints default (1,080n — the calibrated reference) vs 10x (10,800n) side by side.

import {
  FlyBrain,
  MotorDecoder,
  encodeMarketPulse,
  readRawDrives,
  computeBands,
  type ConnectomeOptions,
  type MarketPulse,
  type MotorOutput,
  type RawDrives,
  type BehaviorState,
} from "./src/index.js";

const SEED_BASE = 42;
const SEED_STRIDE = 7919;
const N_FLIES = 24;
const SUB_TICKS = 6;
const SUB_STEPS = Math.floor(500 / SUB_TICKS); // 83 ms — matches state.ts cronInner
const CHUNK = 50;                               // matches advanceFlies

function flySeed(i: number): number { return SEED_BASE + i * SEED_STRIDE; }
function flyTemperament(seed: number): number { return (((seed >>> 5) % 1000) / 1000) * 0.6 + 0.2; }

const SIZINGS: Record<string, ConnectomeOptions & { injectGain?: number; spontaneousRate?: number }> = {
  "1080n (default/reference)": { nSensory: 180, nInterL1: 400, nInterL2: 400, nModulatory: 40, nMotorPerChannel: 12, density: 0.02 },
  "10800n (10x FIXED)":        { nSensory: 1800, nInterL1: 4000, nInterL2: 4000, nModulatory: 400, nMotorPerChannel: 120, density: 0.002 },
};

const MOTOR_CHANNELS = ["leg_left", "leg_right", "wing", "proboscis", "abdomen"] as const;

/** CALM pulse at temperature T (mirrors market.derivePulse with gasRatio≈txRatio≈1, momentum≈0). */
function calmPulse(T: number): MarketPulse {
  return { temperature: T, momentum: 0, turbulence: Math.abs(T - 0.5) * 2, density: 0.5, richness: 0.5 };
}

function stat(vals: number[]): { min: number; mean: number; max: number; spread: number } {
  const min = Math.min(...vals), max = Math.max(...vals);
  const mean = vals.reduce((a, b) => a + b, 0) / vals.length;
  return { min, mean, max, spread: max - min };
}

function run(label: string, sizing: ConnectomeOptions, pulse: MarketPulse): void {
  const flies = Array.from({ length: N_FLIES }, (_, i) => {
    const seed = flySeed(i);
    return { id: i, temperament: flyTemperament(seed), brain: new FlyBrain({ seed, ...sizing }), decoder: new MotorDecoder() };
  });
  const sensory = flies.map((f) => encodeMarketPulse({ ...pulse, arousal: f.temperament }));

  let lastMotor: MotorOutput[][] = [];
  let lastBands = { arousal: [0, 0], cohesion: [0, 0], rest: [0, 0], turnAbs: 0 } as ReturnType<typeof computeBands>;
  const states: Record<BehaviorState, number> = { AGITATE: 0, EXPLORE: 0, AGGREGATE: 0, REST: 0 };

  for (let st = 0; st < SUB_TICKS; st++) {
    // HEAVY: advance every fly one sub-tick (chunked exactly like advanceFlies), read motor.
    lastMotor = flies.map((f, i) => {
      const chunks = Math.max(1, Math.ceil(SUB_STEPS / CHUNK));
      for (let c = 0; c < chunks; c++) {
        for (const s of sensory[i]) f.brain.inject(s);
        f.brain.advance(Math.min(CHUNK, SUB_STEPS - c * CHUNK));
      }
      return f.brain.readAllMotor();
    });
    // LIGHT: global bands → per-fly decode (decoder carries hysteresis across sub-ticks).
    const raws: RawDrives[] = lastMotor.map(readRawDrives);
    lastBands = computeBands(raws);
    // Reset the histogram each sub-tick so the reported STATES are the final sub-tick's committed
    // per-fly states (24 total) — exactly what /population collective.states shows live.
    for (const k of Object.keys(states) as BehaviorState[]) states[k] = 0;
    for (let i = 0; i < N_FLIES; i++) {
      const b = flies[i].decoder.decode(lastMotor[i], sensory[i], flies[i].brain.t, pulse.temperature, lastBands);
      states[b.state]++;
    }
  }

  // Per-channel motor read-out at the final sub-tick.
  console.log(`\n=== ${label} — T=${pulse.temperature.toFixed(2)} ===`);
  for (const ch of MOTOR_CHANNELS) {
    const norms = lastMotor.map((m) => m.find((x) => x.channel === ch)?.normalized ?? 0);
    const rates = lastMotor.map((m) => m.find((x) => x.channel === ch)?.firingRate ?? 0);
    const n = stat(norms), r = stat(rates);
    console.log(
      `  ${ch.padEnd(10)} normalized min/mean/max=${n.min.toFixed(3)}/${n.mean.toFixed(3)}/${n.max.toFixed(3)} spread=${n.spread.toFixed(3)} | Hz mean=${r.mean.toFixed(1)} max=${r.max.toFixed(1)}`,
    );
  }
  const bw = (b: [number, number]) => (b[1] - b[0]);
  console.log(
    `  BAND widths: arousal=${bw(lastBands.arousal).toFixed(4)} cohesion=${bw(lastBands.cohesion).toFixed(4)} rest=${bw(lastBands.rest).toFixed(4)} turnAbs=${lastBands.turnAbs.toFixed(4)}`,
  );
  const aro = stat(lastMotor.map((m) => readRawDrives(m).arousal));
  const coh = stat(lastMotor.map((m) => readRawDrives(m).cohesion));
  console.log(`  RAW arousal spread=${aro.spread.toFixed(4)} (mean ${aro.mean.toFixed(3)}) | cohesion spread=${coh.spread.toFixed(4)} (mean ${coh.mean.toFixed(3)})`);
  console.log(`  STATES: ${Object.entries(states).map(([k, v]) => `${k}=${v}`).join(" ")}`);
}

const T = Number(process.argv[2] ?? "0.53");
const pulse = calmPulse(Number.isFinite(T) ? T : 0.53);
console.log(`diag-motor: ${N_FLIES} flies × ${SUB_TICKS} sub-ticks × ${SUB_STEPS} ms, CALM pulse T=${pulse.temperature}`);
for (const [label, sizing] of Object.entries(SIZINGS)) run(label, sizing, pulse);
