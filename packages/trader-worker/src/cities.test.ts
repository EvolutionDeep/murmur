// CITIES tests — the settlement map's own contracts (cities.ts).
//
// The iron rule under test everywhere: a place is a deterministic function of the economy's OWN zone ledger and
// grave ring — no RNG state, no wall-clock, no LLM, and above all NO contagion model: a plague wave is narrated
// over burials the ledger already recorded, never caused. Two membranes fed the same surveys MUST agree
// byte-for-byte, a switch-off MUST be inert, the map MUST stay bounded by the sixteen-zone grid, and a corrupt
// blob MUST restart empty without ever touching the ledger.

import test from "node:test";
import assert from "node:assert/strict";

import { CityMembrane, NULL_CITIES, SETTLEMENT_NAMES, settlementName, houseCreditOf, type CitySurveyInput } from "./cities.js";

const CFG = { enabled: true, hamletMin: 2, townMin: 5, cityMin: 9, urbanShare: 0.35 };
const OCHRE = { zone: 3, houseId: 42, name: "Ochre", sigil: "◆" };

/** A zone ledger where zone i holds counts[i] living kin. */
function zoneMap(counts: number[]): Record<number, number> {
  const z: Record<number, number> = {};
  let id = 0;
  counts.forEach((n, zone) => { for (let i = 0; i < n; i++) z[id++] = zone; });
  return z;
}

function input(over: Partial<CitySurveyInput> = {}): CitySurveyInput {
  return { tick: 100, size: 20, zones: zoneMap([4, 4]), zoneOwners: null, graves: [], living: 20, dead: 0, deathsRecent: 0, ...over };
}

const live = (m: CityMembrane) => m.signals().settlements;

test("cities: sixteen fixed names, one per zone, and a place never changes its name", () => {
  assert.equal(SETTLEMENT_NAMES.length, 16);
  assert.equal(new Set(SETTLEMENT_NAMES).size, 16, "no two places may share a name");
  assert.equal(settlementName(3), SETTLEMENT_NAMES[3]);
  assert.equal(settlementName(3), settlementName(3), "the name is a pure function of the zone");
  assert.equal(settlementName(16 + 3), SETTLEMENT_NAMES[3], "a grid larger than the table wraps deterministically");
  assert.equal(settlementName(-1), SETTLEMENT_NAMES[15], "a nonsense zone still yields a name, never undefined");
  assert.equal(houseCreditOf("Ochre"), "the House of Ochre");
  assert.equal(houseCreditOf(null), "no house");
});

test("cities: kin are ranked hamlet → town → city, and a lone fly is not a place", () => {
  const m = new CityMembrane(CFG);
  m.survey(input({ zones: zoneMap([1, 2, 5, 9, 12]), size: 29 }));
  const rows = live(m).map((s) => ({ zone: s.zone, rank: s.rank, pop: s.pop }));
  assert.equal(rows.length, 4, "zone 0 holds one kin — a camp, not a settlement");
  const byZone = new Map(rows.map((r) => [r.zone, r.rank]));
  assert.equal(byZone.get(1), "HAMLET");
  assert.equal(byZone.get(2), "TOWN");
  assert.equal(byZone.get(3), "CITY");
  assert.equal(byZone.get(4), "CITY");
  assert.equal(rows[0].zone, 4, "the greatest place leads the map");
});

test("cities: the road joins the two greatest places, and a banner comes off the zone ledger", () => {
  const m = new CityMembrane(CFG);
  m.survey(input({ zones: zoneMap([0, 0, 0, 12, 7]), size: 19, zoneOwners: [OCHRE] }));
  const sig = m.signals();
  assert.deepEqual(sig.road, { a: settlementName(3), b: settlementName(4) });
  const city = sig.settlements.find((s) => s.zone === 3)!;
  assert.equal(city.houseName, "Ochre");
  assert.equal(city.sigil, "◆");
  assert.equal(houseCreditOf(city.houseName), "the House of Ochre");
});

test("cities: a place is founded once per zone for good — never re-founded, never stuttered", () => {
  const m = new CityMembrane(CFG);
  m.survey(input({ zones: zoneMap([3, 3]) }));
  assert.ok(m.signals().founding, "the first place is named");
  assert.equal(m.signals().founding!.zone, 0, "…and the greatest of them is named first");

  m.survey(input({ zones: zoneMap([3, 3]), tick: 190 }));
  assert.equal(m.signals().founding?.zone, 1, "the second place follows on the next cron");

  m.survey(input({ zones: zoneMap([3, 3]), tick: 280 }));
  assert.equal(m.signals().founding, null, "a standing town is history, not news");

  m.survey(input({ zones: zoneMap([3, 3, 4]), tick: 370 }));
  assert.equal(m.signals().founding?.zone, 2, "a NEW place is named the cron it appears");

  m.survey(input({ zones: zoneMap([3, 3, 4]), tick: 460 }));
  assert.equal(m.signals().founding, null);

  // a place that empties and refills is still the same place: founded once, ever
  m.survey(input({ zones: zoneMap([0, 0, 0]), tick: 550 }));
  m.survey(input({ zones: zoneMap([3, 3, 4]), tick: 640 }));
  assert.equal(m.signals().founding, null, "a refilled zone is not founded twice");
});

test("cities: several places appearing at once are named on successive crons, none dropped", () => {
  const m = new CityMembrane(CFG);
  m.survey(input({ zones: zoneMap([3, 4, 5]) }));
  const first = m.signals().founding?.zone;
  m.survey(input({ zones: zoneMap([3, 4, 5]), tick: 190 }));
  const second = m.signals().founding?.zone;
  m.survey(input({ zones: zoneMap([3, 4, 5]), tick: 280 }));
  const third = m.signals().founding?.zone;
  assert.deepEqual([first, second, third].sort(), [0, 1, 2], "every new place is told, one cron each");
  m.survey(input({ zones: zoneMap([3, 4, 5]), tick: 370 }));
  assert.equal(m.signals().founding, null);
});

test("cities: the urban turn is told once, and only again after the towns really empty", () => {
  const m = new CityMembrane(CFG);
  m.survey(input({ zones: zoneMap([6, 6]), size: 12 }));   // share 1.0, two places
  const u = m.signals().urbanization;
  assert.ok(u, "a swarm living wholly in two places has turned urban");
  assert.equal(u!.urban, 12);
  assert.equal(u!.settlements, 2);
  assert.equal(u!.largest, settlementName(0));

  m.survey(input({ zones: zoneMap([6, 6]), size: 12, tick: 190 }));
  assert.equal(m.signals().urbanization, null, "…and it is not told twice while it stands");

  m.survey(input({ zones: null, size: 12, tick: 280 }));    // the map empties (share 0)
  m.survey(input({ zones: zoneMap([6, 6]), size: 12, tick: 370 }));
  assert.ok(m.signals().urbanization, "a swarm that emptied and refilled may turn urban again");

  // one place is not urbanisation, however crowded
  const lone = new CityMembrane(CFG);
  lone.survey(input({ zones: zoneMap([12]), size: 12 }));
  assert.equal(lone.signals().urbanization, null);
});

test("cities: a plague wave needs BOTH a dying and a road, and is paced by crons", () => {
  const m = new CityMembrane(CFG);
  m.survey(input({ deathsRecent: 5 }));
  assert.ok(m.signals().plagueWave, "a wave of burials between two places is narrated");
  assert.equal(m.signals().plagueWave!.a, settlementName(0));
  assert.equal(m.signals().plagueWave!.b, settlementName(1));

  for (let k = 1; k <= 7; k++) {
    m.survey(input({ deathsRecent: 5, tick: 100 + k * 90 }));
    assert.equal(m.signals().plagueWave, null, `cron ${k} is inside the wave's own gap`);
  }
  m.survey(input({ deathsRecent: 5, tick: 100 + 8 * 90 }));
  assert.ok(m.signals().plagueWave, "a LONG dying is several chapters, not one");

  const quiet = new CityMembrane(CFG);
  quiet.survey(input({ deathsRecent: 2 }));
  assert.equal(quiet.signals().plagueWave, null, "two burials are grief, not a wave");

  const roadless = new CityMembrane(CFG);
  roadless.survey(input({ zones: zoneMap([12]), deathsRecent: 9 }));
  assert.equal(roadless.signals().plagueWave, null, "one place has no road for the rot to walk");
});

test("cities: the census reads the grave ring honestly and counts a whole generation", () => {
  const m = new CityMembrane(CFG);
  m.survey(input({ size: 20 }));
  assert.equal(m.signals().census, null, "no census outside a generation turn");

  m.survey(input({
    tick: 190, size: 18,
    graves: [{ tick: 150, age: 900, cause: "aged" }, { tick: 160, age: 200, cause: "plague" }],
    living: 18, dead: 2,
  }));
  const d = m.signals().demography;
  assert.equal(d.graves, 2);
  assert.equal(d.meanAge, 550, "the mean is read off the ring it cites");
  assert.equal(d.topCause, "aged", "a tie is broken by name, deterministically");
  assert.equal(d.deaths, 2);
  assert.equal(d.births, 0, "two burials and two fewer minds is no hatchings at all");

  m.turnGeneration(190, 1);
  const c = m.signals().census!;
  assert.deepEqual({ size: c.size, meanAge: c.meanAge, graves: c.graves, births: c.births, deaths: c.deaths, gen: c.gen },
    { size: 18, meanAge: 550, graves: 2, births: 0, deaths: 2, gen: 1 });

  // the count resets, so the next census reports only the next generation
  m.survey(input({ tick: 280, size: 21, graves: [{ tick: 150, age: 900, cause: "aged" }, { tick: 160, age: 200, cause: "plague" }] }));
  m.turnGeneration(280, 2);
  const c2 = m.signals().census!;
  assert.equal(c2.gen, 2);
  assert.equal(c2.births, 3, "three more minds and no new graves is three hatchings");
  assert.equal(c2.deaths, 0, "old burials are never counted twice");
});

test("cities: with the territory layer off there is no map — but the census still speaks", () => {
  const m = new CityMembrane(CFG);
  m.survey(input({ zones: null, size: 20, graves: [{ tick: 90, age: 500, cause: "aged" }] }));
  const sig = m.signals();
  assert.equal(sig.settlements.length, 0);
  assert.equal(sig.founding, null);
  assert.equal(sig.urbanization, null);
  assert.equal(sig.plagueWave, null);
  assert.equal(sig.road, null);
  assert.equal(sig.urbanShare, 0);
  assert.equal(sig.demography.size, 20);
  m.turnGeneration(100, 1);
  assert.equal(m.signals().census?.size, 20, "demography does not depend on the zone ledger");
});

test("cities: two membranes fed the same surveys agree byte-for-byte", () => {
  const run = (m: CityMembrane) => {
    for (let g = 1; g <= 4; g++) {
      for (let k = 0; k < 6; k++) {
        m.survey(input({
          tick: g * 900 + k * 90,
          size: 12 + ((g + k) % 7),
          zones: zoneMap([3 + (k % 3), 4, 2 + (g % 4)]),
          zoneOwners: g % 2 ? [OCHRE] : null,
          graves: [{ tick: g * 900 + k * 90 - 10, age: 300 + k * 50, cause: k % 2 ? "aged" : "plague" }],
          living: 12, dead: g, deathsRecent: k % 3 === 0 ? 4 : 1,
        }));
      }
      m.turnGeneration(g * 900 + 540, g);
    }
  };
  const a = new CityMembrane(CFG);
  const b = new CityMembrane(CFG);
  run(a); run(b);
  assert.equal(a.serialize(), b.serialize());
  assert.equal(JSON.stringify(a.signals()), JSON.stringify(b.signals()));
});

test("cities: serialize round-trips, and a corrupt blob restores an empty map", () => {
  const m = new CityMembrane(CFG);
  m.survey(input({ zones: zoneMap([3, 4, 5]), deathsRecent: 4 }));
  m.survey(input({ zones: zoneMap([3, 4, 5]), tick: 190 }));
  m.survey(input({ zones: zoneMap([3, 4, 5]), tick: 280 }));
  m.survey(input({ zones: zoneMap([3, 4, 5]), tick: 370 }));
  assert.equal(m.signals().founding, null, "all three places have now been named, one cron each");
  m.turnGeneration(370, 1);
  const blob = m.serialize();

  const revived = new CityMembrane(CFG);
  revived.restore(blob);
  assert.equal(revived.serialize(), blob, "a restored map is byte-for-byte the stored one");
  revived.survey(input({ zones: zoneMap([3, 4, 5]), tick: 460 }));
  assert.equal(revived.signals().founding, null, "…and it remembers which places were already named");
  // the census LINE is a one-shot edge event (never persisted), but the generation it was struck in IS — that
  // is exactly what stops an eviction from striking the same generation's count twice.
  assert.equal(revived.generation(), 1, "…and which generation the last count was struck in");
  revived.turnGeneration(460, 1);
  assert.equal(revived.signals().census?.gen, 1, "a re-struck count still names its own generation");

  for (const junk of ["", "not json", "{}", '{"version":99}', '{"version":1,"announced":"nope"}']) {
    const r = new CityMembrane(CFG);
    r.restore(junk);
    r.survey(input({ zones: zoneMap([3, 4]), tick: 190 }));
    assert.ok(r.signals().founding, `corrupt blob must restart empty (and so re-found): ${junk.slice(0, 24)}`);
  }

  const off = NULL_CITIES;
  off.survey(input());
  off.turnGeneration(100, 1);
  assert.equal(off.signals().settlements.length, 0);
  assert.equal(off.signals().census, null);
  assert.equal(off.signals().plagueWave, null);
});

test("cities: the persisted blob stays bounded by the sixteen-zone grid", () => {
  const m = new CityMembrane(CFG);
  const counts = Array.from({ length: 16 }, (_, i) => 2 + (i % 5));
  for (let k = 0; k < 40; k++) m.survey(input({ zones: zoneMap(counts), size: 60, tick: 100 + k * 90, deathsRecent: 4 }));
  const parsed = JSON.parse(m.serialize());
  assert.ok(parsed.announced.length <= 16, `announced zones must never exceed the grid: ${parsed.announced.length}`);
  assert.equal(live(m).length, 16);
  assert.ok(m.serialize().length < 4096, "the city blob must stay a few hundred bytes, never a value wall");
});

test("cities: an empty or zero swarm yields no places and no divisions by zero", () => {
  const m = new CityMembrane(CFG);
  m.survey(input({ zones: {}, size: 0, living: 0 }));
  const sig = m.signals();
  assert.equal(sig.settlements.length, 0);
  assert.equal(sig.urbanShare, 0);
  assert.equal(sig.largest, null);
  assert.equal(sig.demography.meanAge, null);
});
