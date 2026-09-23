// APPRENTICESHIP tests — education + cumulative culture's own contracts (apprentice.ts).
//
// The iron rule under test everywhere: a lesson is a deterministic function of (tick, cohort ids, inventedTop,
// houseOf) — no RNG state, no wall-clock, no LLM — and the membrane only ever writes its OWN bounded ledger (it
// moves no money and touches no neuron). Two membranes fed the same crons MUST agree byte-for-byte, a switch-off
// MUST be inert, a personal craft MUST never exceed the rung the swarm has actually invented, the fragile-
// knowledge edge (an art losing its last living keeper) MUST fire, and a corrupt blob MUST restart empty.

import test from "node:test";
import assert from "node:assert/strict";

import { FAP_ROLE, type Fap } from "@fly/fly-brain";
import { ApprenticeMembrane, NULL_APPRENTICE, craftName } from "./apprentice.js";
import { LADDER } from "./invention.js";
import type { HouseBanner } from "./culture.js";
import type { FlyReading } from "./population.js";

function reading(id: number, fap: Fap, over: Partial<FlyReading> = {}): FlyReading {
  return {
    id, state: "EXPLORE",
    arousal: 0.5, turnBias: 0, cohesion: 0.5,
    wingbeat: 0.5, rest: 0.2, temperament: ((id * 7919) % 1000) / 1000,
    fingerprint: `fp${id}`,
    fap, valence: 0, heading: 0, role: FAP_ROLE[fap], bouts: [],
    ...over,
  };
}

const NO_HOUSE = (): HouseBanner | null => null;
const OCHRE: HouseBanner = { id: 7, name: "Ochre", sigil: "◆", tradition: null };

/** A swarm at the food (the whole cohort feeds, so every pair can meet over the crons). */
function feeders(n: number, from = 0): FlyReading[] {
  return Array.from({ length: n }, (_, i) => reading(from + i, "FEED"));
}

/** A stored blob carrying exactly these (id → rung) keepers — lets a test plant a known state. */
function blobWith(keepers: [number, number][], extra: Record<string, unknown> = {}): string {
  return JSON.stringify({
    version: 1,
    craft: keepers.map(([id, c]) => ({ id, c })),
    lineage: (extra.lineage as unknown[]) ?? [],
    announced: (extra.announced as unknown[]) ?? [],
    topCraft: keepers.reduce((mx, [, c]) => Math.max(mx, c), 0),
    lineages: 0,
    lastTick: 0,
  });
}

test("apprentice: the switch-off membrane is completely inert (byte-for-byte the pre-education build)", () => {
  const m = NULL_APPRENTICE;
  m.round(10, feeders(8), 5, NO_HOUSE);
  const s = m.signals();
  assert.equal(s.skilled, 0);
  assert.equal(s.topCraft, 0);
  assert.equal(s.lineages, 0);
  assert.equal(s.transmission, null);
  assert.equal(s.surpass, null);
  assert.equal(s.school, null);
  assert.equal(s.craftLost, null);
});

test("apprentice: a personal craft never climbs above the rung the swarm has actually invented", () => {
  // ceiling is rung 1: even fed a rich 200-cron life with a full cohort, no mind may hold more than rung 1.
  const m = new ApprenticeMembrane({ enabled: true, learnPct: 1, selfPct: 1, schoolMin: 2 });
  const crew = feeders(12);
  for (let t = 1; t <= 200; t++) m.round(t * 90, crew, 1, NO_HOUSE);
  const s = m.signals();
  assert.equal(s.topCraft, 1, "the ceiling of a personal art is ⑬'s invented top");
  assert.ok(s.keepers.every((k) => k.craft <= 1), "no keeper may hold an un-invented art");
});

test("apprentice: selfPct seeds a keeper, then learnPct spreads it hand to hand until the swarm carries it", () => {
  const m = new ApprenticeMembrane({ enabled: true, learnPct: 1, selfPct: 0.5, schoolMin: 99 });
  const crew = feeders(12);
  let sawTransmission = false;
  for (let t = 1; t <= 400; t++) {
    m.round(t * 90, crew, 3, NO_HOUSE);
    if (m.signals().transmission) sawTransmission = true;
  }
  const s = m.signals();
  assert.ok(s.topCraft >= 1, "a self-taught grasp seeds the first keeper");
  assert.ok(s.skilled > 1, "…and apprenticeship spreads the art beyond that first mind");
  assert.ok(sawTransmission, "a lesson taught is told as a TRANSMISSION");
  assert.ok(s.lineages > 0, "the ledger tallies the lessons taught");
});

test("apprentice: the last living keeper of an art dying untaught tells a CRAFT_LOST (knowledge is fragile)", () => {
  // plant a single keeper of rung 3, then run a cron where it is simply gone from the readings (it died).
  const m = new ApprenticeMembrane({ enabled: true, learnPct: 0.5, selfPct: 0, schoolMin: 3 });
  m.restore(blobWith([[5, 3]]));
  assert.equal(m.top(), 3, "the planted keeper carries the swarm's whole memory of the art");
  // survivors (ids 0..3) are at the food, but none holds rung 3; the keeper (id 5) is absent ⇒ extinct.
  m.round(100, feeders(4), 3, NO_HOUSE);
  const lost = m.signals().craftLost;
  assert.ok(lost, "the art's last hand died, so the craft is lost");
  assert.equal(lost!.rung, 3);
  assert.equal(lost!.name, LADDER[2].name);
  assert.equal(lost!.last, 5, "…and the chronicle names the last keeper who held it");
  assert.equal(m.top(), 0, "the swarm remembers nothing at rung 3 now");
});

test("apprentice: an art held by enough kin of one house becomes a named SCHOOL, told once", () => {
  const m = new ApprenticeMembrane({ enabled: true, learnPct: 0.5, selfPct: 0, schoolMin: 3 });
  m.restore(blobWith([[1, 2], [2, 2], [3, 2]]));   // three Ochre kin, all at rung 2
  const house = (id: number): HouseBanner | null => (id >= 1 && id <= 3 ? OCHRE : null);
  m.round(10, feeders(4), 2, house);                // keepers stay present so none is buried
  const school = m.signals().school;
  assert.ok(school, "three same-house keepers of one art is a school");
  assert.equal(school!.name, LADDER[1].name);
  assert.equal(school!.houseName, "Ochre");
  assert.equal(school!.adherents, 3);
  // one chapter per (art,house): the next cron has nothing new to announce
  m.round(11, feeders(4), 2, house);
  assert.equal(m.signals().school, null, "…never a per-cron census");
});

test("apprentice: two membranes fed the same crons agree byte-for-byte (deterministic, no hidden RNG)", () => {
  const cfg = { enabled: true, learnPct: 0.4, selfPct: 0.2, schoolMin: 2 };
  const a = new ApprenticeMembrane(cfg);
  const b = new ApprenticeMembrane(cfg);
  const house = (id: number): HouseBanner | null => (id % 3 === 0 ? OCHRE : null);
  for (let t = 1; t <= 300; t++) {
    const crew = feeders(10 + (t % 7), t % 5);      // a churning cohort, deterministic in t
    a.round(t * 90, crew, 1 + (t % 6), house);
    b.round(t * 90, crew, 1 + (t % 6), house);
  }
  assert.equal(a.serialize(), b.serialize());
  assert.equal(JSON.stringify(a.signals()), JSON.stringify(b.signals()));
});

test("apprentice: craftName clamps to the ladder and never indexes off either end", () => {
  assert.equal(craftName(1), LADDER[0].name);
  assert.equal(craftName(LADDER.length), LADDER[LADDER.length - 1].name);
  assert.equal(craftName(0), LADDER[0].name, "a non-art falls back to the first rung's name, never a crash");
  assert.equal(craftName(999), LADDER[0].name, "an out-of-range rung falls back too");
});

test("apprentice: serialize round-trips, and a corrupt or out-of-range blob restarts the ledger empty", () => {
  const m = new ApprenticeMembrane({ enabled: true, learnPct: 1, selfPct: 1, schoolMin: 2 });
  const crew = feeders(12);
  for (let t = 1; t <= 120; t++) m.round(t * 90, crew, 4, (id) => (id % 2 ? OCHRE : null));
  const blob = m.serialize();
  const revived = new ApprenticeMembrane({ enabled: true, learnPct: 1, selfPct: 1, schoolMin: 2 });
  revived.restore(blob);
  assert.equal(revived.serialize(), blob, "a restored ledger is byte-for-byte the stored one");
  // only the PERSISTED facts survive a restore — the transient school/pending fields await the next round
  assert.equal(revived.signals().skilled, m.signals().skilled);
  assert.equal(revived.signals().topCraft, m.signals().topCraft);
  assert.equal(revived.signals().lineages, m.signals().lineages);

  for (const junk of ["", "not json", "{}", '{"version":99,"craft":[]}', '{"version":1,"craft":"nope"}']) {
    const r = new ApprenticeMembrane({ enabled: true, learnPct: 1, selfPct: 1, schoolMin: 2 });
    r.restore(junk);
    assert.equal(r.signals().skilled, 0, `corrupt blob must restart empty: ${junk.slice(0, 24)}`);
  }
  // a keeper whose rung is off the ladder is refused — the ceiling is public and fixed
  const evil = new ApprenticeMembrane({ enabled: true, learnPct: 1, selfPct: 1, schoolMin: 2 });
  evil.restore(JSON.stringify({ version: 1, craft: [{ id: 1, c: 999 }, { id: 2, c: 0 }], lineage: [], announced: [], topCraft: 0, lineages: 0 }));
  assert.equal(evil.signals().skilled, 0, "an out-of-range craft is not an art this swarm could know");
});

test("apprentice: the persisted blob stays bounded by the live population, never a value wall", () => {
  const m = new ApprenticeMembrane({ enabled: true, learnPct: 1, selfPct: 1, schoolMin: 2 });
  for (let t = 1; t <= 400; t++) m.round(t * 90, feeders(40, t % 100), 12, (id) => (id % 4 ? OCHRE : null));
  const parsed = JSON.parse(m.serialize());
  assert.ok(parsed.craft.length <= 256, "keepers are capped at the swarm's own ceiling");
  assert.ok(m.serialize().length < 16384, "the apprentice blob must stay small, never a value wall");
});

test("apprentice: an empty or absent cohort moves nothing and never divides by zero", () => {
  const m = new ApprenticeMembrane({ enabled: true, learnPct: 1, selfPct: 1, schoolMin: 2 });
  m.round(10, [], 5, NO_HOUSE);
  assert.equal(m.signals().skilled, 0);
  m.restore(blobWith([[9, 2]]));
  m.round(20, [], 2, NO_HOUSE);                     // keeper 9 absent from an empty swarm ⇒ buried, not a crash
  assert.equal(m.top(), 0);
});
