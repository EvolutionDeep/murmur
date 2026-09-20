// CULTURE tests — the Lamarckian layer's own contracts (culture.ts).
//
// The iron rule under test everywhere: contagion is a deterministic function of (tick, ids, hashes) —
// no RNG state, no wall-clock, no LLM — and it only ever rewrites the READ-OUT line (fap/role) after
// the brain decoded it. Two membranes fed the same ticks MUST agree byte-for-byte, a switch-off MUST
// be inert, and the meme table MUST stay bounded (DO-safe).

import test from "node:test";
import assert from "node:assert/strict";

import { FAP_ROLE, type Fap } from "@fly/fly-brain";
import { CultureMembrane, type HouseBanner } from "./culture.js";
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

const NO_HOUSE = () => null;

/** A swarm at the food: the first `nHuddle` share a feeding cohort but EACH bears a different creed
 *  (the cohort joins through the AGGREGATE state — same-feeder adjacency), the rest idle at REST. */
function swarmReadings(n = 24, nHuddle = 8): FlyReading[] {
  const creed: Fap[] = ["FEED", "FORAGE", "COURT", "GROOM", "FLIGHT", "HALT", "RETREAT", "HUDDLE"];
  return Array.from({ length: n }, (_, i) =>
    i < nHuddle
      ? reading(i, creed[i % creed.length], { state: "AGGREGATE" })
      : reading(i, "REST"),
  );
}

test("culture: same ticks + same readings ⇒ byte-identical membranes (determinism, no hidden RNG)", () => {
  const a = new CultureMembrane({ enabled: true });
  const b = new CultureMembrane({ enabled: true });
  for (let tick = 100; tick < 160; tick++) {
    a.contagion(tick, swarmReadings(), NO_HOUSE);
    b.contagion(tick, swarmReadings(), NO_HOUSE);
  }
  assert.ok(a.size > 0, "sixty crons among eight differing co-feeders catch at least one fashion");
  assert.equal(a.serialize(), b.serialize(), "two membranes over identical history agree byte-for-byte");
});

test("culture: apply rewrites fap + role on the read-out line only; bouts and fingerprints stand", () => {
  const c = new CultureMembrane({ enabled: true });
  c.restore(JSON.stringify({ version: 1, memes: [{ id: 5, fap: "HUDDLE", ttl: 10 }] }));
  const flies = swarmReadings();
  const before = structuredClone(flies);
  const n = c.apply(flies);
  assert.equal(n, 1, "exactly the believer is overridden");
  assert.equal(flies[5].fap, "HUDDLE");
  assert.equal(flies[5].role, FAP_ROLE.HUDDLE, "role follows the creed through the SAME decode table");
  assert.deepEqual(flies[5].bouts, before[5].bouts, "behavioural history is never rewritten by fashion");
  assert.equal(flies[5].fingerprint, before[5].fingerprint, "the neural fingerprint is untouched");
  assert.deepEqual(
    flies.filter((f) => f.id !== 5), before.filter((f: FlyReading) => f.id !== 5),
    "every unbelieving reading passes through byte-for-byte",
  );
});

test("culture: creeds burn down — TTL decays once per cron and the innate FAP comes back", () => {
  const c = new CultureMembrane({ enabled: true });
  c.restore(JSON.stringify({ version: 1, memes: [{ id: 9, fap: "COURT", ttl: 2 }] }));
  assert.equal(c.creedOf(9, "FEED"), "COURT");
  c.contagion(1, [], NO_HOUSE);                      // cron ① — ttl 2→1, cohort too small to infect
  assert.equal(c.creedOf(9, "FEED"), "COURT");
  c.contagion(2, [], NO_HOUSE);                      // cron ② — ttl 1→0 ⇒ the meme dies
  assert.equal(c.creedOf(9, "FEED"), "FEED", "fashion fades; the genome's answer returns");
  assert.equal(c.size, 0);
});

test("culture: the meme table is bounded (DO storage safe) — restore caps, full membrane takes no new creed", () => {
  const c = new CultureMembrane({ enabled: true });
  const fat = {
    version: 1,
    memes: Array.from({ length: 200 }, (_, i) => ({ id: i, fap: "FEED", ttl: 5 })),
  };
  c.restore(JSON.stringify(fat));
  assert.equal(c.size, 64, "restore clamps to the cap");
  assert.equal(JSON.parse(c.serialize()).memes.length, 64, "serialize stays inside the cap");
});

test("culture: CULTURE_ENABLED=false is byte-for-byte inert — no contagion, no override, no state", () => {
  const off = new CultureMembrane({ enabled: false });
  const flies = swarmReadings();
  const before = structuredClone(flies);
  for (let tick = 0; tick < 30; tick++) off.contagion(tick, flies, NO_HOUSE);
  assert.equal(off.apply(flies), 0);
  assert.deepEqual(flies, before, "a disabled membrane changes nothing anywhere");
  assert.equal(off.size, 0);
});

test("culture: the house is a breakwater — a home-bred fly catching a contrary fashion may hold the old way", () => {
  const c = new CultureMembrane({ enabled: true });
  const ochre: HouseBanner = { id: 700, name: "Ochre", sigil: "◆", tradition: "GROOM" };
  const houseOf = (id: number) => (id === 2 ? ochre : null);
  let heldOldWay = false;
  for (let tick = 0; tick < 600 && !heldOldWay; tick++) {
    // #1 an unaffiliated FLIGHT huddler (joins the cohort by state); #2 an Ochre FEED feeder — if the
    // contact draw links them and the adoption fires, the hold draw converts it onto the GROOM tradition.
    c.contagion(tick, [reading(1, "FLIGHT", { state: "AGGREGATE" }), reading(2, "FEED")], houseOf);
    if (c.creedOf(2, "FEED") === "GROOM") heldOldWay = true;
  }
  assert.ok(heldOldWay, "over 600 deterministic contact draws the tradition fires at least once");
});

test("culture: a majority-held tradition surfaces for the chronicle after the streak threshold", () => {
  const c = new CultureMembrane({ enabled: true });
  const ochre: HouseBanner = { id: 42, name: "Ochre", sigil: "◆", tradition: "FEED" };
  const houseOf = (id: number) => (id <= 1 ? ochre : null);
  const pair = [reading(0, "FEED"), reading(1, "FEED")];
  let sig = c.signals(pair);
  assert.equal(sig.tradition, null, "no tradition before the first cron is observed");
  for (let tick = 10; tick < 18; tick++) c.contagion(tick, pair, houseOf);
  sig = c.signals(pair);
  assert.ok(sig.tradition, "eight crons of majority FEED = a held tradition");
  assert.equal(sig.tradition!.houseId, 42);
  assert.equal(sig.tradition!.fap, "FEED");
  assert.ok(sig.tradition!.streak >= 8);
});

test("culture: TREND reports only a strict-majority creed, never a bare habit", () => {
  const c = new CultureMembrane({ enabled: true });
  const flies = Array.from({ length: 8 }, (_, i) =>
    reading(i, ["FEED", "GROOM", "FORAGE", "HALT", "RETREAT", "COURT", "FLIGHT", "HUDDLE"][i] as Fap),
  );
  // No memes yet: every creed is innate, max count 1 ⇒ no fashion.
  assert.equal(c.signals(flies).trend, null, "one fly per FAP is a population, not a trend");
  c.restore(JSON.stringify({
    version: 1,
    memes: [0, 1, 2, 3, 4].map((id) => ({ id, fap: "COURT", ttl: 5 })),
  }));
  const trend = c.signals(flies).trend;
  // ids 0–4 believe COURT (memes) + id 5 was born COURT ⇒ six under the banner out of eight.
  assert.ok(trend && trend.fap === "COURT" && trend.adherents === 6, "six believers under COURT = a trend");
  assert.ok(trend.share > 0.25);
});

test("culture: serialize/restore round-trips; corrupt or foreign blobs restore an EMPTY membrane", () => {
  const c = new CultureMembrane({ enabled: true });
  for (let tick = 200; tick < 240; tick++) c.contagion(tick, swarmReadings(), NO_HOUSE);
  const blob = c.serialize();
  assert.ok(c.size > 0, "forty crons of differing creeds leave live memes to persist");
  const twin = new CultureMembrane({ enabled: true });
  twin.restore(blob);
  assert.equal(twin.serialize(), blob, "an eviction + reload loses nothing");
  const junk = new CultureMembrane({ enabled: true });
  for (const bad of ["", "{not json", JSON.stringify({ version: 99, memes: [] }),
    JSON.stringify({ version: 1, memes: [{ id: 1, fap: "NOT_A_FAP", ttl: 5 }, { id: 2, fap: "FEED", ttl: 0 }] })]) {
    junk.restore(bad);
    assert.equal(junk.size, 0, `corrupt/foreign payload ⇒ empty membrane, never a crash: ${bad.slice(0, 20)}`);
  }
});
