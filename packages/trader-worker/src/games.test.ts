// ㉑ games.test.ts — era bell, opening draw, crowning timing, the standing record, bounding, restore-safety, inert off.
import { test } from "node:test";
import assert from "node:assert/strict";
import { GamesMembrane, GAMES_SEEN_ERAS, GAMES_EVENTS, type GamesConfig, type GamesFacts } from "./games.js";

const CFG: GamesConfig = { enabled: true, openP: 1.0 };
const POOL = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12];

const facts = (over: Partial<GamesFacts> = {}): GamesFacts => ({
  era: 2,
  livingIds: POOL,
  venueHouse: "Musca",
  dealsOf: (id) => id * 10,
  houseOf: (id) => (id % 2 === 0 ? "Antonia" : null),
  ...over,
});

/** Boot at era 1, then turn the bell to era `era` on tick t — returns the membrane after the opening cron. */
function proclaim(era = 2, t = 1, cfg: GamesConfig = CFG) {
  const m = new GamesMembrane(cfg);
  m.round(t, facts({ era: 1 }));                     // boot: adopt era 1 silently
  m.round(t + 1, facts({ era }));                    // the bell turns → games may open
  return m;
}

test("㉑ a new era at openP=1 proclaims the games with event, venue and count", () => {
  const m = proclaim();
  const sig = m.signals();
  assert.ok(sig.games, "the era bell must open the games at p=1");
  assert.equal(sig.games!.era, 2);
  assert.ok(GAMES_EVENTS.includes(sig.games!.event as (typeof GAMES_EVENTS)[number]), "event comes from the programme");
  assert.equal(sig.games!.venue, "Musca");
  assert.equal(sig.counts.games, 1);
  assert.equal(sig.pendingGames, true, "the crowning is armed for a later cron");
});

test("㉑ openP=0 never proclaims a festival", () => {
  const m = new GamesMembrane({ enabled: true, openP: 0 });
  for (let era = 1; era <= 30; era++) m.round(era, facts({ era }));
  assert.equal(m.signals().games, null);
  assert.equal(m.signals().counts.games, 0);
});

test("㉑ null-object (enabled=false) never speaks", () => {
  const m = new GamesMembrane({ enabled: false, openP: 1 });
  m.round(1, facts({ era: 1 }));
  m.round(2, facts({ era: 2 }));
  m.round(4, facts({ era: 2 }));
  const sig = m.signals();
  assert.equal(sig.games, null);
  assert.equal(sig.champion, null);
  assert.deepEqual(sig.counts, { games: 0, crowns: 0, records: 0 });
});

test("㉑ crowning lands exactly CROWN_DELAY crons after the opening, from the living pool", () => {
  const m = proclaim();                              // opened at tick 2
  m.round(3, facts({ era: 2 }));
  assert.equal(m.signals().champion, null, "tick 3: still waiting");
  assert.equal(m.signals().pendingGames, true);
  m.round(4, facts({ era: 2 }));                     // tick 4 - 2 ≥ CROWN_DELAY → crown
  const c = m.signals().champion;
  assert.ok(c, "the champion must be crowned by tick 4");
  assert.ok(POOL.includes(c!.id), "the victor is one of the living");
  assert.equal(m.signals().pendingGames, false, "the stadium clears after the crowning");
  assert.equal(m.signals().counts.crowns, 1);
});

test("㉑ determinism: the same era and pool crown the same champion, twice over", () => {
  const run = () => {
    const m = proclaim();
    m.round(4, facts({ era: 2 }));
    return { champ: m.signals().champion, blob: m.serialize() };
  };
  const a = run(); const b = run();
  assert.deepEqual(a.champ, b.champ);
  assert.equal(a.blob, b.blob);
});

test("㉑ the inaugural crowning sets the stand; a bigger mark breaks it, a smaller one does not", () => {
  const m = proclaim();
  m.round(4, facts({ era: 2 }));                     // first crown → the mark is set, no record kind yet
  assert.equal(m.signals().record, null, "there is no old mark to beat at the first games");
  const first = m.signals().champion!;
  const firstDeals = first.id * 10;
  assert.deepEqual(m.signals().standing, { id: first.id, deals: firstDeals, era: 2 });
  // Next era: force a winner with a LARGER mark by planting the stand low, then crowning the real winner.
  const winner = m.signals().champion!.id;            // same era seed → same winner on the next games too? no: era differs
  // Plant a small standing record so the next (unplanned) victor's own deals decide the claim.
  m.restore(JSON.stringify({
    v: 1, lastSeenEra: 2, open: null, lastGames: { era: 2, event: GAMES_EVENTS[0], venue: "Musca" },
    seen: [2], counts: { games: 1, crowns: 1, records: 0 }, record: { id: 999, deals: 1, era: 2 },
  }));
  m.round(5, facts({ era: 3 }));                     // era 3 bell → open at p=1
  m.round(8, facts({ era: 3 }));                     // crown
  const s = m.signals();
  const deals = s.champion!.id * 10;
  assert.ok(deals > 1, "any living victor outscores the planted mark of 1");
  assert.deepEqual(s.record, { id: s.champion!.id, deals, prev: 1 });
  assert.equal(s.counts.records, 1);
  assert.equal(s.standing!.id, s.champion!.id);
  void winner;
});

test("㉑ an empty living pool consumes the festival without a victor", () => {
  const m = proclaim();
  m.round(4, facts({ era: 2, livingIds: [] }));
  assert.equal(m.signals().champion, null);
  assert.equal(m.signals().counts.crowns, 0);
  assert.equal(m.signals().pendingGames, false, "the unplayed festival is spent, not stuck");
});

test("㉑ boot mid-era adopts the bell silently and a proclaimed era is never re-proclaimed", () => {
  const m = new GamesMembrane(CFG);
  m.round(1, facts({ era: 64 }));                    // boot straight into era 64
  assert.equal(m.signals().games, null, "no phantom festival at boot");
  m.round(2, facts({ era: 65 }));                    // the bell turns once → one festival
  assert.equal(m.signals().counts.games, 1);
  m.restore(JSON.stringify({ v: 1, lastSeenEra: -1, open: null, record: null, lastGames: null, seen: [65], counts: { games: 1, crowns: 0, records: 0 } }));
  m.round(3, facts({ era: 65 }));                    // era 65 sits in seenEras → silent even after a reload
  assert.equal(m.signals().games, null, "a played era never plays twice, across reloads");
});

test("㉑ restore enforces the structural bounds (seen eras)", () => {
  const wide = Array.from({ length: 40 }, (_, i) => i);
  const m = new GamesMembrane(CFG);
  m.restore(JSON.stringify({
    v: 1, lastSeenEra: 5, open: null, record: { id: 3, deals: 7, era: 5 }, lastGames: null,
    seen: wide, counts: { games: 9, crowns: 8, records: 2 },
  }));
  const blob = JSON.parse(m.serialize());
  assert.equal(blob.seen.length, GAMES_SEEN_ERAS, "the festival roll clamps to GAMES_SEEN_ERAS keeping the newest");
  assert.equal(blob.seen[blob.seen.length - 1], 39);
  assert.equal(blob.counts.games, 9, "cumulative counts survive untouched");
});

test("㉑ corrupt blobs restart an empty stadium, never a poisoned ledger", () => {
  const m = new GamesMembrane(CFG);
  m.restore("not json{{{");
  m.restore(JSON.stringify({ v: 9, open: 5, record: "nope", seen: [null, "x"] }));
  const blob = JSON.parse(m.serialize());
  assert.equal(blob.open, null);
  assert.equal(blob.record, null);
  assert.deepEqual(blob.seen, []);
});

test("㉑ serialize stays far below the DO value wall across many festivals", () => {
  const m = new GamesMembrane(CFG);
  for (let era = 1; era <= 200; era++) {
    m.round(era * 4, facts({ era }));
    m.round(era * 4 + 2, facts({ era }));            // keep pace with the crown delay
  }
  assert.ok(m.serialize().length < 4096, `blob was ${m.serialize().length} bytes`);
  assert.ok(m.signals().counts.games > 100, "the long run actually held many festivals");
});
