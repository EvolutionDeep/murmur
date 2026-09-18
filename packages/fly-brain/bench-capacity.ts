// bench-capacity.ts — measure the REAL per-shard cost of the 10x (10,800-neuron) swarm so we can pick a
// SHARD_COUNT that keeps every FlyShardDO isolate under Cloudflare's three hard limits:
//   · 128 MB heap / isolate     · 30 s CPU / invocation     · ~2 MB comfortable per-cron SQLite write
//
// A shard holds ceil(populationSize / shardCount) flies and runs the HEAVY, per-fly-independent advance,
// so heap / CPU / persist all scale LINEARLY with flies-per-shard. This bench measures small real slices
// (1, 2, 4 flies) at each connectome sizing, confirms that linearity, then derives the whole shard table.
//
// Run:  $env:NODE_OPTIONS="--expose-gc"; npx --yes tsx packages/fly-brain/bench-capacity.ts

import { FlyBrain } from "./src/index.js";
import type { ConnectomeOptions } from "./src/connectome.js";

const POPULATION = 24;
const CRON_STEPS = 498; // one cron = ticksPerCron(6) × floor(simStepsPerTick(500)/6)=83 → 498 LIF steps/fly

// 10x sizing: every layer ×10 → 1800+4000+4000+400+600 = 10,800 neurons (FlyWire downsample ~13× vs ~129×).
const BIG = { nSensory: 1800, nInterL1: 4000, nInterL2: 4000, nModulatory: 400, nMotorPerChannel: 120 };
const CONFIGS: { label: string; opts: ConnectomeOptions }[] = [
  { label: "1x  1,080n  d=0.02   (today)", opts: { nSensory: 180, nInterL1: 400, nInterL2: 400, nModulatory: 40, nMotorPerChannel: 12, density: 0.02 } },
  { label: "10x 10,800n d=0.02   (fan-in ×10 → synapses ~×100)", opts: { ...BIG, density: 0.02 } },
  { label: "10x 10,800n d=0.002  (fan-in held constant → synapses ~×10)", opts: { ...BIG, density: 0.002 } },
];

const gc = () => { if (typeof (globalThis as any).gc === "function") (globalThis as any).gc(); };
// Isolate-memory proxy: heapUsed (the retained Synapse[]/NeuronMeta[] JS-object arrays dominate) PLUS
// arrayBuffers (the LifNetwork CSR + state typed arrays live off-heap but still count against the 128 MB
// isolate budget). Measuring both keeps the verdict honest near the ceiling.
const heapMB = () => { const m = process.memoryUsage(); return (m.heapUsed + (m.arrayBuffers ?? 0)) / 1048576; };
const mb = (x: number) => x.toFixed(1);

interface Slice { count: number; buildMB: number; buildMs: number; advanceMs: number; serializeMB: number; neurons: number; synapses: number; }

/** Build `count` flies, advance one cron, serialize — measuring each phase. Live heap is the delta over a
 *  gc'd baseline (the flies stay reachable, so gc() can't collect them: buildMB is their true footprint). */
function measureSlice(opts: ConnectomeOptions, count: number): Slice {
  gc();
  const base = heapMB();
  const brains: FlyBrain[] = [];
  const t0 = Date.now();
  for (let i = 0; i < count; i++) brains.push(new FlyBrain({ seed: (42 + i * 7919) >>> 0, ...opts }));
  const buildMs = Date.now() - t0;
  gc();
  const buildMB = heapMB() - base;

  const t1 = Date.now();
  for (const b of brains) b.advance(CRON_STEPS);
  const advanceMs = Date.now() - t1;

  let bytes = 0;
  for (const b of brains) bytes += b.serialize().length;

  const s = brains[0].snapshot();
  const neurons = s.firingRates.length;
  const synapses = (brains[0] as any).network.S as number;
  return { count, buildMB, buildMs, advanceMs, serializeMB: bytes / 1048576, neurons, synapses };
}

console.log(`\n=== murmur shard capacity bench — population ${POPULATION}, one cron = ${CRON_STEPS} steps/fly ===`);
console.log(`limits per isolate: heap 128 MB · CPU 30 s · comfortable per-cron write ~2 MB\n`);

for (const cfg of CONFIGS) {
  console.log(`── ${cfg.label} ──`);
  // Measure 1 / 2 / 4-fly slices; skip 4 for the huge config if it would risk the dev machine.
  const probes = [1, 2, 4];
  const slices = probes.map((n) => measureSlice(cfg.opts, n));
  const per = slices[0];
  console.log(`   neurons/fly ${per.neurons.toLocaleString()} · synapses/fly ${per.synapses.toLocaleString()}`);
  for (const s of slices) {
    console.log(`   ${s.count} fly  → heap ${mb(s.buildMB)} MB · build ${s.buildMs} ms · advance/cron ${s.advanceMs} ms · serialize ${mb(s.serializeMB)} MB`);
  }
  // Linearity check: heap per fly across the probes should be ~constant.
  const perFly = slices.map((s) => s.buildMB / s.count);
  const spread = (Math.max(...perFly) - Math.min(...perFly)) / (perFly.reduce((a, b) => a + b, 0) / perFly.length);
  console.log(`   linearity: heap/fly spread across probes = ${(spread * 100).toFixed(1)}% (≈0 ⇒ shards scale linearly)`);

  // Derive the shard table from the measured per-fly cost (average of the probes).
  const avgHeapPerFly = perFly.reduce((a, b) => a + b, 0) / perFly.length;
  const avgAdvPerFly = slices.reduce((a, s) => a + s.advanceMs / s.count, 0) / slices.length;
  const avgSerPerFly = slices.reduce((a, s) => a + s.serializeMB / s.count, 0) / slices.length;
  console.log(`   per-fly: heap ${mb(avgHeapPerFly)} MB · advance/cron ${mb(avgAdvPerFly)} ms · serialize ${mb(avgSerPerFly)} MB`);
  console.log(`   shard table (24 flies):`);
  console.log(`     N   flies/shard   heap/shard   CPU/shard   persist/shard   verdict`);
  for (const N of [1, 2, 3, 4, 6, 8, 12, 24]) {
    const fps = Math.ceil(POPULATION / N);
    const heap = avgHeapPerFly * fps;
    const cpu = (avgAdvPerFly * fps) / 1000;
    const persist = avgSerPerFly * fps;
    const ok = heap < 128 && cpu < 30 && persist < 2;
    const verdict = ok ? "✓ fits" : `✗ ${heap >= 128 ? "HEAP " : ""}${cpu >= 30 ? "CPU " : ""}${persist >= 2 ? "WRITE" : ""}`;
    console.log(`     ${String(N).padStart(2)}   ${String(fps).padStart(2)}          ${mb(heap).padStart(6)} MB   ${cpu.toFixed(2).padStart(5)} s   ${mb(persist).padStart(6)} MB       ${verdict}`);
  }
  // Smallest N that fits all three limits.
  let minN = -1;
  for (const N of [1, 2, 3, 4, 6, 8, 12, 24]) {
    const fps = Math.ceil(POPULATION / N);
    if (avgHeapPerFly * fps < 128 && (avgAdvPerFly * fps) / 1000 < 30 && avgSerPerFly * fps < 2) { minN = N; break; }
  }
  console.log(`   → smallest SHARD_COUNT that fits all three limits: ${minN > 0 ? minN : "none (needs the object-array fix or fewer neurons)"}\n`);
}
