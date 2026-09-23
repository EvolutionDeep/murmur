// TECH tests — the ladder of arts' own contracts (invention.ts).
//
// The iron rule under test everywhere: an art is a deterministic function of (tick, generation, civLevel,
// size, the dominant house) — no RNG state, no wall-clock, no LLM — and the membrane only ever writes its OWN
// bounded ledger (it re-prices nothing and moves no money). Two membranes fed the same generations MUST agree
// byte-for-byte, a switch-off MUST be inert, the ladder MUST stay bounded by its twelve public rungs, and a
// corrupt blob MUST restart empty without ever touching the ledger.

import test from "node:test";
import assert from "node:assert/strict";

import { TechMembrane, NULL_TECH, LADDER, creditOf } from "./invention.js";

const ALWAYS = { enabled: true, discoverP: 1, adoptPct: 0.1 };
const NEVER = { enabled: true, discoverP: 0, adoptPct: 0.1 };
const OCHRE = { id: 42, name: "Ochre", sigil: "◆" };

/** Walk a membrane through generations 1..n at a steady fortune and swarm size. */
function climb(m: TechMembrane, gens: number, civ = 90, size = 40, house = OCHRE): void {
  for (let g = 1; g <= gens; g++) {
    m.turnGeneration(g * 90, g, civ, size, house);
    for (let k = 1; k < 90; k++) m.diffuse(g * 90 + k, size);
  }
}

test("tech: the ladder is twelve PUBLIC rungs, uniquely named, with gates that never loosen", () => {
  assert.equal(LADDER.length, 12);
  const names = new Set(LADDER.map((r) => r.name));
  assert.equal(names.size, 12, "every rung must carry its own permanent name");
  for (let i = 1; i < LADDER.length; i++) {
    assert.ok(LADDER[i].minGen >= LADDER[i - 1].minGen, `rung ${i + 1} must not be gated EARLIER than rung ${i}`);
    assert.ok(LADDER[i].minCiv >= LADDER[i - 1].minCiv, `rung ${i + 1} must not need LESS fortune than rung ${i}`);
  }
});

test("tech: a rung needs BOTH its gates — generation alone or fortune alone invents nothing", () => {
  const byGen = new TechMembrane(ALWAYS);
  byGen.turnGeneration(90, 0, 100, 40, OCHRE);
  assert.equal(byGen.size, 0, "generation 0 is before the first rung's gate");

  // a civilisation stuck at fortune 0 climbs no higher than the one rung that asks for nothing
  const poor = new TechMembrane(ALWAYS);
  for (let g = 1; g <= 12; g++) poor.turnGeneration(g * 90, g, 0, 40, OCHRE);
  assert.deepEqual(poor.signals().rungs.map((r) => r.name), [LADDER[0].name]);
  assert.equal(poor.signals().next?.name, LADDER[1].name, "…and the horizon names exactly what fortune withholds");

  // an early generation, however rich, stops at the rung its generation gate allows
  const young = new TechMembrane(ALWAYS);
  young.turnGeneration(90, 1, 100, 40, OCHRE);
  young.turnGeneration(180, 2, 100, 40, OCHRE);
  assert.equal(young.size, 2, "two generations may hold at most two rungs, whatever the fortune");
});

test("tech: one rung per generation, at most — turning twice on the same generation climbs once", () => {
  const m = new TechMembrane(ALWAYS);
  m.turnGeneration(90, 1, 90, 40, OCHRE);
  m.turnGeneration(91, 1, 90, 40, OCHRE);
  m.turnGeneration(92, 1, 90, 40, OCHRE);
  assert.equal(m.size, 1);
  m.turnGeneration(180, 2, 90, 40, OCHRE);
  assert.equal(m.size, 2, "the next generation may climb exactly one more rung");
});

test("tech: discoverP=0 ⇒ the ladder never climbs, and the switch-off membrane is inert", () => {
  const never = new TechMembrane(NEVER);
  climb(never, 20);
  assert.equal(never.size, 0);
  assert.equal(never.signals().discovery, null);

  const off = NULL_TECH;
  off.turnGeneration(90, 5, 99, 40, OCHRE);
  off.diffuse(91, 40);
  const sig = off.signals();
  assert.equal(sig.rungs.length, 0);
  assert.equal(sig.discovery, null);
  assert.equal(sig.diffusion, null);
  assert.equal(sig.lostArt, null);
});

test("tech: the whole ladder climbs in sixteen generations when the gates are open", () => {
  const m = new TechMembrane(ALWAYS);
  climb(m, 16, 100, 40);
  const sig = m.signals();
  assert.equal(sig.rungs.length, 12);
  assert.equal(sig.rungs[11].name, LADDER[11].name);
  assert.equal(sig.next, null, "a complete ladder has no horizon left");
  assert.equal(sig.rungs[0].gen, 1, "the rungs are credited to the generation that found them");
  assert.equal(sig.rungs[11].gen, LADDER[11].minGen, "…and the top rung lands the generation its gate opens");
});

test("tech: an invention credits the dominant house, and nobody in particular when there is none", () => {
  const withHouse = new TechMembrane(ALWAYS);
  withHouse.turnGeneration(90, 1, 90, 40, OCHRE);
  assert.equal(withHouse.signals().discovery?.credit, "the House of Ochre");
  assert.equal(withHouse.signals().rungs[0].houseId, 42);

  const without = new TechMembrane(ALWAYS);
  without.turnGeneration(90, 1, 90, 40, null);
  assert.equal(without.signals().discovery?.credit, creditOf(null));
  assert.equal(without.signals().rungs[0].houseId, null);
});

test("tech: diffusion grows toward the swarm, caps at it, and DIFFUSION is told once per art", () => {
  const m = new TechMembrane(ALWAYS);
  m.turnGeneration(90, 1, 90, 40, OCHRE);
  const seen: number[] = [];
  for (let k = 1; k <= 30; k++) {
    m.diffuse(90 + k, 40);
    const d = m.signals().diffusion;
    if (d) seen.push(d.adopted);
  }
  assert.ok(seen.length > 0, "an art that reaches half the swarm is announced as a custom");
  assert.equal(seen.length, 1, "…exactly once, never a per-cron census");
  assert.equal(m.signals().rungs[0].adopted, 40, "adoption is capped at the live swarm");
});

test("tech: adoption follows a shrinking swarm down, never past it", () => {
  const m = new TechMembrane(ALWAYS);
  m.turnGeneration(90, 1, 90, 40, OCHRE);
  for (let k = 1; k <= 20; k++) m.diffuse(90 + k, 40);
  assert.equal(m.signals().rungs[0].adopted, 40);
  for (let k = 1; k <= 20; k++) m.diffuse(200 + k, 12);   // a plague thins the swarm
  assert.equal(m.signals().rungs[0].adopted, 12);
});

test("tech: a dark age unlearns the TOP art, keeps the ladder's floor, and the art can be found again", () => {
  const m = new TechMembrane(ALWAYS);
  climb(m, 4, 90, 40);                       // four rungs in force
  assert.equal(m.size, 4);
  m.turnGeneration(450, 5, 10, 40, OCHRE);   // fortune breaks
  const lost = m.signals().lostArt;
  assert.ok(lost, "a dark age takes an art");
  assert.equal(lost!.name, LADDER[3].name, "…and it takes the HIGHEST one");
  assert.equal(m.size, 3);
  assert.deepEqual(m.signals().lost.map((l) => l.name), [LADDER[3].name]);

  // the horizon falls back to the lost rung, so a recovery reinvents it
  assert.equal(m.signals().next?.name, LADDER[3].name);
  climb(m, 8, 90, 40);
  assert.equal(m.signals().lost.length, 0, "a reinvention ends the forgetting");
  assert.ok(m.signals().rungs.some((r) => r.name === LADDER[3].name));
});

test("tech: forgetting never strips the ladder past its floor", () => {
  const m = new TechMembrane(ALWAYS);
  climb(m, 4, 90, 40);
  assert.equal(m.size, 4);
  for (let g = 5; g <= 12; g++) m.turnGeneration(g * 90, g, 5, 40, OCHRE);   // a long dark age
  assert.equal(m.size, 2, "a dark age forgets, it does not erase");
  assert.equal(m.signals().lost.length, 2);
});

test("tech: two membranes fed the same generations agree byte-for-byte (deterministic, no RNG state)", () => {
  const a = new TechMembrane({ enabled: true, discoverP: 0.75, adoptPct: 0.08 });
  const b = new TechMembrane({ enabled: true, discoverP: 0.75, adoptPct: 0.08 });
  for (let g = 1; g <= 14; g++) {
    for (const m of [a, b]) {
      m.turnGeneration(g * 90, g, 40 + ((g * 7) % 55), 30 + (g % 9), g % 3 === 0 ? OCHRE : null);
      for (let k = 1; k < 90; k++) m.diffuse(g * 90 + k, 30 + (g % 9));
    }
  }
  assert.equal(a.serialize(), b.serialize());
  assert.equal(JSON.stringify(a.signals()), JSON.stringify(b.signals()));
});

test("tech: serialize round-trips, and a corrupt or tampered blob restores an empty ladder", () => {
  const m = new TechMembrane(ALWAYS);
  climb(m, 3, 90, 40);
  const blob = m.serialize();

  const revived = new TechMembrane(ALWAYS);
  revived.restore(blob);
  assert.equal(revived.serialize(), blob, "a restored ladder is byte-for-byte the stored one");
  assert.equal(revived.signals().rungs.length, 3);

  for (const junk of ["", "not json", "{}", '{"version":99,"arts":[]}', '{"version":1,"arts":"nope"}']) {
    const r = new TechMembrane(ALWAYS);
    r.restore(junk);
    assert.equal(r.signals().rungs.length, 0, `corrupt blob must restart empty: ${junk.slice(0, 24)}`);
  }

  // the ladder is PUBLIC and fixed: a stored rung whose name is not the table's is refused
  const tampered = new TechMembrane(ALWAYS);
  climb(tampered, 1, 90, 40);
  const evil = JSON.parse(tampered.serialize());
  evil.arts[0].name = "the LLM Oracle";
  evil.arts.push({ rung: 99, name: "out of bounds", gen: 1, tick: 1, adopted: 1, houseId: null, houseName: null });
  const checked = new TechMembrane(ALWAYS);
  checked.restore(JSON.stringify(evil));
  assert.equal(checked.signals().rungs.length, 0, "a renamed or out-of-range rung is not an art this swarm knows");
});

test("tech: the persisted blob stays bounded by the twelve rungs", () => {
  const m = new TechMembrane(ALWAYS);
  climb(m, 30, 100, 40);
  const parsed = JSON.parse(m.serialize());
  assert.ok(parsed.arts.length <= 12, `arts must never exceed the ladder: ${parsed.arts.length}`);
  assert.ok(parsed.lost.length <= 12);
  assert.ok(parsed.diffused.length <= 12);
  assert.ok(m.serialize().length < 4096, "the tech blob must stay a few hundred bytes, never a value wall");
});

test("tech: a zero or negative swarm neither adopts nor divides by zero", () => {
  const m = new TechMembrane(ALWAYS);
  m.turnGeneration(90, 1, 90, 0, null);
  m.diffuse(91, 0);
  assert.equal(m.signals().diffusion, null);
  assert.equal(m.signals().rungs[0].adopted >= 0, true);
});
