// RELIGION tests — the faith membrane's own contracts (religion.ts).
//
// The iron rule under test everywhere: faith is a deterministic function of (tick, ids, hashes, regime) —
// no RNG state, no wall-clock, no LLM — and it only ever rewrites the READ-OUT line (fap/role), and only
// for the DEVOTED on a HOLY DAY. Two membranes fed the same ticks MUST agree byte-for-byte, a switch-off
// MUST be inert, the faith table MUST stay bounded (DO-safe), and a corrupt blob MUST restart empty
// without ever touching the ledger.

import test from "node:test";
import assert from "node:assert/strict";

import { FAP_ROLE, type Fap } from "@fly/fly-brain";
import { FaithMembrane, GOD_LIST, reigningGod, oldWayOf, type HouseBanner } from "./religion.js";
import type { FlyReading } from "./population.js";

const CFG = { enabled: true, holyEvery: 48, devotionMin: 0.5, sectCap: 8 };

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

const NO_HOUSE = () => null;
const OCHRE: HouseBanner = { id: 42, name: "Ochre", sigil: "◆", tradition: "FEED" };

/** A swarm at the shrine: the first `nGather` worship together (AGGREGATE + REST), the rest trade on. */
function worshipSwarm(n = 24, nGather = 10): FlyReading[] {
  return Array.from({ length: n }, (_, i) =>
    i < nGather ? reading(i, "REST", { state: "AGGREGATE" }) : reading(i, "FEED"),
  );
}

test("religion: the three faces of the Tape reign by regime — HOT⇒SCORCH, COLD⇒FROST, else DRIFT", () => {
  assert.equal(reigningGod("HOT"), "SCORCH");
  assert.equal(reigningGod("COLD"), "FROST");
  assert.equal(reigningGod("CALM"), "DRIFT");
  assert.equal(reigningGod("anything"), "DRIFT", "an unknown regime falls back to the middle face");
  assert.deepEqual(GOD_LIST, ["SCORCH", "DRIFT", "FROST"]);
  assert.equal(oldWayOf(OCHRE), "the Old Way of Ochre");
});

test("religion: same ticks + same readings ⇒ byte-identical membranes (determinism, no hidden RNG)", () => {
  const houseOf = (id: number) => (id < 3 ? OCHRE : null);
  const a = new FaithMembrane(CFG);
  const b = new FaithMembrane(CFG);
  for (let tick = 100; tick < 160; tick++) {
    a.ritual(tick, worshipSwarm(), houseOf, "CALM");
    b.ritual(tick, worshipSwarm(), houseOf, "CALM");
  }
  assert.ok(a.size > 0, "sixty crons among gathering house-kin kindle at least one faith");
  assert.equal(a.serialize(), b.serialize(), "two membranes over identical history agree byte-for-byte");
});

test("religion: a house fly gathered at the shrine remembers its ancestor cult", () => {
  const r = new FaithMembrane(CFG);
  const houseOf = (id: number) => (id === 1 ? OCHRE : null);
  r.ritual(1, [reading(1, "REST", { state: "AGGREGATE" })], houseOf, "CALM");
  const f = r.faithOf(1);
  assert.ok(f, "the gathered house fly is recorded");
  assert.equal(f!.sect, "the Old Way of Ochre", "the ancestor cult is the house's own shrine");
  assert.equal(f!.god, "DRIFT", "CALM ⇒ DRIFT reigns at the moment of kindling");
});

test("religion: an unsected commoner's god turns with the tape; a house's ancestor cult does not", () => {
  const r = new FaithMembrane(CFG);
  r.restore(JSON.stringify({ version: 1, faiths: [
    { id: 1, god: "DRIFT", sect: null, devotion: 0.9 },                    // a commoner
    { id: 2, god: "DRIFT", sect: "the Old Way of Ochre", devotion: 0.9 },  // a house cult
  ] }));
  // Neither gathers (FEED/EXPLORE ⇒ out of the worship cohort), so ONLY the tape-turn step ③ can move them.
  r.ritual(5, [reading(1, "FEED"), reading(2, "FEED")], NO_HOUSE, "HOT");
  assert.equal(r.faithOf(1)!.god, "SCORCH", "the commoner follows the tape into the HOT face");
  assert.equal(r.faithOf(2)!.god, "DRIFT", "the ancestor cult keeps its own god against the tape");
});

test("religion: devotion kindles in the gathering and cools in silence", () => {
  const r = new FaithMembrane(CFG);
  r.restore(JSON.stringify({ version: 1, faiths: [{ id: 1, god: "DRIFT", sect: "x", devotion: 0.5 }] }));
  r.ritual(1, [reading(1, "REST", { state: "AGGREGATE" })], NO_HOUSE, "CALM");   // at the shrine
  const up = r.faithOf(1)!.devotion;
  assert.ok(up > 0.5, `gathering kindles devotion (0.5 → ${up})`);
  r.ritual(2, [reading(1, "FEED")], NO_HOUSE, "CALM");                            // away, trading
  const down = r.faithOf(1)!.devotion;
  assert.ok(down < up, `silence cools devotion (${up} → ${down})`);
});

test("religion: on a holy day the devoted rest (fap→REST); the lukewarm, the faithless and the plain cron stand", () => {
  const r = new FaithMembrane({ ...CFG, holyEvery: 10 });
  r.restore(JSON.stringify({ version: 1, faiths: [
    { id: 1, god: "DRIFT", sect: null, devotion: 0.9 },   // devoted
    { id: 2, god: "DRIFT", sect: null, devotion: 0.2 },   // lukewarm (< devotionMin)
  ] }));
  const flies = [reading(1, "FEED"), reading(2, "FEED"), reading(3, "FEED")];
  const before = structuredClone(flies);
  assert.equal(r.apply(flies, 3), 0, "a plain cron (tick 3, not a multiple of 10) is inert");
  assert.deepEqual(flies, before, "no reading moves off the holy day");
  const n = r.apply(flies, 10);
  assert.equal(n, 1, "only the devoted keep the holy day");
  assert.equal(flies[0].fap, "REST");
  assert.equal(flies[0].role, FAP_ROLE.REST, "role follows through the SAME decode table");
  assert.deepEqual(flies[0].bouts, before[0].bouts, "behavioural history is never rewritten by faith");
  assert.equal(flies[0].fingerprint, before[0].fingerprint, "the neural fingerprint is untouched");
  assert.equal(flies[1].fap, "FEED", "the lukewarm keep trading");
  assert.equal(flies[2].fap, "FEED", "the faithless keep trading");
});

test("religion: the holy day falls every holyEvery crons (isHoly + the holyIn countdown)", () => {
  const r = new FaithMembrane({ ...CFG, holyEvery: 12 });
  assert.equal(r.isHoly(0), true);
  assert.equal(r.isHoly(12), true);
  assert.equal(r.isHoly(24), true);
  assert.equal(r.isHoly(7), false);
  r.ritual(5, [], NO_HOUSE, "CALM");
  assert.equal(r.signals([], "CALM").holyIn, 7, "from tick 5 the next holy day (12) is 7 crons off");
  r.ritual(12, [], NO_HOUSE, "CALM");
  assert.equal(r.signals([], "CALM").holyIn, 0, "on the holy day the countdown reads zero");
});

test("religion: three devoted kin of one house raise a prophet the chronicle can name (PROPHECY edge)", () => {
  const r = new FaithMembrane(CFG);
  const houseOf = (id: number) => (id < 3 ? OCHRE : null);
  const trio = [0, 1, 2].map((i) => reading(i, "REST", { state: "AGGREGATE" }));
  let prophecy: { prophetId: number; sect: string; god: string; adherents: number } | null = null;
  for (let tick = 1; tick <= 20 && !prophecy; tick++) {
    r.ritual(tick, trio, houseOf, "CALM");
    prophecy = r.signals(trio, "CALM").prophecy;
  }
  assert.ok(prophecy, "a flock of three burning above the prophet threshold is heard");
  assert.equal(prophecy!.sect, "the Old Way of Ochre");
  assert.equal(prophecy!.adherents, 3);
  assert.ok([0, 1, 2].includes(prophecy!.prophetId), "the prophet is one of the devoted kin");
});

test("religion: signals report the reigning god and the sect table sorted by souls, capped at sectCap", () => {
  const r = new FaithMembrane({ ...CFG, sectCap: 2 });
  const ash: HouseBanner = { id: 43, name: "Ash", sigil: "✦", tradition: "GROOM" };
  const houseOf = (id: number) => (id < 4 ? OCHRE : id < 6 ? ash : null);
  const flies = Array.from({ length: 6 }, (_, i) => reading(i, "REST", { state: "AGGREGATE" }));
  for (let tick = 1; tick <= 6; tick++) r.ritual(tick, flies, houseOf, "COLD");
  const sig = r.signals(flies, "COLD");
  assert.equal(sig.reigning, "FROST", "COLD ⇒ FROST reigns");
  assert.ok(sig.sects.length >= 1 && sig.sects.length <= 2, "the read-out never exceeds sectCap");
  for (let i = 1; i < sig.sects.length; i++) {
    assert.ok(sig.sects[i - 1].adherents >= sig.sects[i].adherents, "sects are sorted by souls, descending");
  }
  for (const s of sig.sects) assert.ok(GOD_LIST.includes(s.god as never), "every sect bears a valid face");
});

test("religion: the faith table is bounded (DO storage safe) — restore caps, serialize stays inside", () => {
  const r = new FaithMembrane(CFG);
  const fat = { version: 1, faiths: Array.from({ length: 200 }, (_, i) => ({ id: i, god: "DRIFT", sect: `s${i % 3}`, devotion: 0.5 })) };
  r.restore(JSON.stringify(fat));
  assert.equal(r.size, 64, "restore clamps to the cap");
  assert.equal(JSON.parse(r.serialize()).faiths.length, 64, "serialize stays inside the cap");
});

test("religion: RELIGION_ENABLED=false is byte-for-byte inert — no ritual, no override, no state", () => {
  const off = new FaithMembrane({ ...CFG, enabled: false });
  const flies = worshipSwarm();
  const before = structuredClone(flies);
  for (let tick = 0; tick < 30; tick++) off.ritual(tick, flies, NO_HOUSE, "CALM");
  assert.equal(off.apply(flies, 0), 0, "even on a holy day a disabled membrane rests no one");
  assert.deepEqual(flies, before, "a disabled membrane changes nothing anywhere");
  assert.equal(off.size, 0);
});

test("religion: serialize/restore round-trips; corrupt or foreign blobs restore an EMPTY membrane", () => {
  const houseOf = (id: number) => (id < 3 ? OCHRE : null);
  const r = new FaithMembrane(CFG);
  for (let tick = 200; tick < 240; tick++) r.ritual(tick, worshipSwarm(), houseOf, "CALM");
  const blob = r.serialize();
  assert.ok(r.size > 0, "forty crons of gathering house-kin leave live faiths to persist");
  const twin = new FaithMembrane(CFG);
  twin.restore(blob);
  assert.equal(twin.serialize(), blob, "an eviction + reload loses nothing");
  const junk = new FaithMembrane(CFG);
  for (const bad of ["", "{not json", JSON.stringify({ version: 99, faiths: [] }),
    JSON.stringify({ version: 1, faiths: [{ id: 1, god: "NOT_A_GOD", sect: null, devotion: 0.5 }] })]) {
    junk.restore(bad);
    assert.equal(junk.size, 0, `corrupt/foreign payload ⇒ empty membrane, never a crash: ${bad.slice(0, 20)}`);
  }
});
