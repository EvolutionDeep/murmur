// genome.ts — determinism + operator invariants for the breeding market's genetic core.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  GENOME_BOUNDS,
  buildFromGenome,
  canonicalGenome,
  crossoverGenome,
  genomeFromOptions,
  genomeFromSeed,
  mutateGenome,
  specFromGenome,
  type Genome,
} from "./genome.js";

const base = genomeFromSeed(0xfeedface, { nSensory: 60, nInterL1: 120, nInterL2: 120, nModulatory: 40, nMotorPerChannel: 8, density: 0.02 });
const other = genomeFromSeed(0x1234567, { nSensory: 80, nInterL1: 200, nInterL2: 160, nModulatory: 60, nMotorPerChannel: 12, density: 0.03 });

test("canonicalGenome is key-order independent and stable", () => {
  const shuffled: Genome = { ...base, nSensory: base.nSensory };
  const a = canonicalGenome(base);
  const b = canonicalGenome({ ...shuffled });
  assert.equal(a, b, "same fields ⇒ same canonical bytes regardless of insertion order");
  assert.ok(a.startsWith('{"density":'), "canonical is sorted-key (first key = density)");
  assert.notEqual(canonicalGenome(base), canonicalGenome(other));
});

test("genomeFromOptions fills effective defaults (no undefined in a genome)", () => {
  const g = genomeFromOptions({});
  for (const [k, v] of Object.entries(g)) {
    assert.equal(typeof v, "number", `field ${k} is a number`);
    assert.ok(Number.isFinite(v), `field ${k} finite`);
  }
  assert.deepEqual(genomeFromOptions({ seed: 7 }), genomeFromSeed(7));
});

test("mutateGenome is pure in (parent, rngSeed) and reseeds wiring", () => {
  const c1 = mutateGenome(base, 99);
  const c2 = mutateGenome(base, 99);
  assert.deepEqual(c1, c2, "same parent+seed ⇒ identical offspring");
  const c3 = mutateGenome(base, 100);
  assert.notDeepEqual(c1, c3, "different rngSeed ⇒ different offspring");
  assert.notEqual(c1.seed, base.seed, "mutation reseeds the wiring");
});

test("mutateGenome offspring stay within GENOME_BOUNDS", () => {
  for (let s = 1; s <= 50; s++) {
    const c = mutateGenome(base, s);
    for (const f of ["nSensory", "nInterL1", "nInterL2", "nModulatory", "nMotorPerChannel"] as const) {
      assert.ok(c[f] >= GENOME_BOUNDS[f][0] && c[f] <= GENOME_BOUNDS[f][1], `${f} in bounds`);
    }
    assert.ok(c.density >= GENOME_BOUNDS.density[0] && c.density <= GENOME_BOUNDS.density[1], "density in bounds");
  }
});

test("crossoverGenome inherits every field from exactly one parent", () => {
  const c = crossoverGenome(base, other, 42);
  assert.ok([base.seed, other.seed].includes(c.seed), "seed from a parent");
  assert.ok([base.nSensory, other.nSensory].includes(c.nSensory));
  assert.ok([base.nInterL1, other.nInterL1].includes(c.nInterL1));
  assert.ok([base.nInterL2, other.nInterL2].includes(c.nInterL2));
  assert.ok([base.nModulatory, other.nModulatory].includes(c.nModulatory));
  assert.ok([base.nMotorPerChannel, other.nMotorPerChannel].includes(c.nMotorPerChannel));
  assert.ok([base.density, other.density].includes(c.density));
  assert.deepEqual(crossoverGenome(base, other, 42), c, "pure in rngSeed");
});

test("a genome rebuilds to a stable brain (spec is reproducible)", () => {
  const child = mutateGenome(base, 7);
  const s1 = specFromGenome(child);
  const s2 = specFromGenome(child);
  assert.deepEqual(s1, s2, "same genome ⇒ identical structural spec");
  const conn = buildFromGenome(child);
  assert.equal(conn.neurons.length, s1.neuronCount, "spec neuronCount matches rebuilt brain");
  assert.notDeepEqual(specFromGenome(base), s1, "offspring brain differs from parent brain");
});
