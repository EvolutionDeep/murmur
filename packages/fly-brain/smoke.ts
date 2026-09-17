// Neural smoke test — NO chain interaction, NO keys, NO wallet.
//
// Grows a small population of fly brains, sweeps the market temperature COLD → HOT, and verifies the
// ~1,080-neuron connectome produces diverse, peer-relative behaviour and survives a serialize round-trip
// (the persistence path used by the Durable Object). Exits non-zero if the population is too uniform.
//
// Run:  npm run smoke        (or: npx tsx packages/fly-brain/smoke.ts)

import {
  FlyBrain,
  MotorDecoder,
  encodeMarketPulse,
  encodeStimulus,
  readRawDrives,
  computeBands,
  type MarketPulse,
  type RawDrives,
  type BehaviorState,
  type MotorOutput,
  type SensoryInput,
} from "./src/index.js";

const POP = 8;
const TICKS = 40;

// A small population, each fly grown from its own seed (its "temperament"), exactly like the Worker.
const brains = Array.from({ length: POP }, (_, i) => new FlyBrain({ seed: (42 + i * 7919) >>> 0 }));
const decoders = brains.map(() => new MotorDecoder());
const temperaments = brains.map((_, i) => (((i + 1) * 2654435761) >>> 0) / 4294967296);

console.log("murmur — neural smoke test\n");
const c0 = brains[0].connectome;
console.log(`Connectome: ${c0.neurons.length} neurons, ${c0.synapses.length} synapses`);
console.log(
  `  sensory ${c0.byKind.sensory.length} · inter ${c0.byKind.inter.length} · ` +
    `modulatory ${c0.byKind.modulatory.length} · motor ${c0.byKind.motor.length}\n`,
);

const stateCount: Record<BehaviorState, number> = { AGITATE: 0, EXPLORE: 0, AGGREGATE: 0, REST: 0 };

// Sweep the market temperature from COLD (0) to HOT (1); each tick advances 500 ms of simulation.
for (let tick = 0; tick < TICKS; tick++) {
  const temperature = tick / (TICKS - 1);
  const pulse: MarketPulse = {
    temperature,
    momentum: 0.2,
    turbulence: 0.3 + 0.4 * temperature,
    density: 0.4,
    richness: 0.5,
  };

  // 1) every fly perceives the SAME market pulse plus its OWN internal arousal
  const perFly: { motor: MotorOutput[]; sensory: SensoryInput[] }[] = [];
  const raws: RawDrives[] = [];
  for (let i = 0; i < POP; i++) {
    const sensory = encodeMarketPulse({ ...pulse, arousal: temperaments[i] });
    for (const s of sensory) brains[i].inject(s);
    if (tick % 8 === 0) brains[i].inject(encodeStimulus({ type: "food", intensity: 0.6 }));
    brains[i].advance(500);
    const motor = brains[i].readAllMotor();
    perFly.push({ motor, sensory });
    raws.push(readRawDrives(motor));
  }

  // 2) decode each fly RELATIVE to its peers this tick (the two-layer behaviour model)
  const bands = computeBands(raws);
  for (let i = 0; i < POP; i++) {
    const b = decoders[i].decode(perFly[i].motor, perFly[i].sensory, brains[i].t, temperature, bands);
    stateCount[b.state]++;
    if (tick % 12 === 0 && i === 0) {
      console.log(
        `  [tick ${String(tick).padStart(2, " ")}] T=${temperature.toFixed(2)} fly0 → ${b.state.padEnd(9)} ` +
          `aro=${b.arousal.toFixed(2)} coh=${b.cohesion.toFixed(2)} rest=${b.rest.toFixed(2)} fp=${b.neuralFingerprint}`,
      );
    }
  }
}

console.log("\nBehaviour distribution across the sweep:", stateCount);
const distinct = Object.values(stateCount).filter((n) => n > 0).length;
console.log(`Distinct behavioural states expressed: ${distinct}/4`);

// 3) serialize round-trip (the Durable Object persistence path)
const blob = brains[0].serialize();
const revived = FlyBrain.deserialize(blob, { seed: 42 });
const ok = revived.t === brains[0].t;
console.log(`Serialized fly0: ${(blob.length / 1024).toFixed(1)} KB · revive t=${revived.t} ${ok ? "ok" : "MISMATCH"}`);

if (distinct < 3 || !ok) {
  console.error("\nSmoke test FAILED: expected ≥3 distinct behavioural states and a clean serialize round-trip.");
  process.exit(1);
}
console.log("\nSmoke test passed.");
