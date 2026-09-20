// LIMIT-BOOK tests (books.ts) — the market-structure half of institutions layer ⑥.
// Contracts: the ladder is pure geometry of the readings (deterministic, bounded), a buyer pays where
// they CROSS (walking UP as depth drains, a swept book prints beyond the top), panic widens every
// spread at once, and the mark tape is the bounded price line the frontend will draw.

import test from "node:test";
import assert from "node:assert/strict";

import { FAP_ROLE } from "@fly/fly-brain";
import { MarketBooks, BOOK_LEVELS, MARK_CAP } from "./books.js";
import type { FlyReading } from "./population.js";

function drive(id: number, over: Partial<FlyReading> = {}): FlyReading {
  return {
    id, state: "EXPLORE",
    arousal: 0.5, turnBias: 0, cohesion: 0.5,
    wingbeat: 0.5, rest: 0.2, temperament: 0.5,
    fingerprint: `fp${id}`,
    fap: "FEED", valence: 0, heading: 0, role: FAP_ROLE.FEED, bouts: [],
    ...over,
  };
}

/** Eager seller: negative valence, calm, rested ⇒ will w = 0.5+0.4+0.3 → clamps to 1 → best ask rung. */
const SELLER = (id: number) => drive(id, { valence: -1, arousal: 0, rest: 1 });
/** Eager buyer: the mirror. */
const BUYER = (id: number) => drive(id, { valence: 1, arousal: 1, rest: 0 });

test("books: a calm ladder is pure 5% geometry around the center, depth = the flies behind each rung", () => {
  const b = new MarketBooks();
  const view = b.build("signal", 100_000, [SELLER(0), SELLER(1), BUYER(2), BUYER(3)]);
  assert.equal(view.spreadBoost, 0, "identical |valence| ⇒ no dispersion ⇒ no panic bonus");
  // 2 eager sellers stack at rung 0 (+5%); buyers mirror at the best bid (−5%).
  assert.equal(view.asks[0].price, "105000");
  assert.equal(view.asks[0].qty, 2);
  assert.equal(view.bids[0].price, "95000");
  assert.equal(view.bids[0].qty, 2);
  assert.equal(view.markAtomic, "100000", "mark = midpoint of the best resting prices");
  assert.equal(view.asks.length, BOOK_LEVELS);
  const askDepth = view.asks.reduce((s, l) => s + l.qty, 0);
  const bidDepth = view.bids.reduce((s, l) => s + l.qty, 0);
  assert.equal(askDepth, 4, "every reading rests a supply order — depth is conserved");
  assert.equal(bidDepth, 4);
});

test("books: buyers CROSS the book — depth drains rung by rung and a swept book prints beyond the top", () => {
  const b = new MarketBooks();
  b.build("momentum", 100_000, [SELLER(0), SELLER(1)]);   // two offers at +5%, nothing further out
  assert.equal(b.eatAsk("momentum"), "105000");           // first crossing eats the first offer
  assert.equal(b.eatAsk("momentum"), "105000");           // second eats the last one on that rung
  assert.equal(b.eatAsk("momentum"), "125000", "the third sweeps an empty ladder: +25% beyond the top");
  assert.equal(b.eatAsk("signal"), null, "no book built for that good ⇒ null (caller keeps the formula)");
});

test("books: panic is a SPREAD — |valence| dispersion widens every rung spacing at once", () => {
  const calm = new MarketBooks();
  const panic = new MarketBooks();
  const flies = (v: (id: number) => number) =>
    Array.from({ length: 8 }, (_, i) => drive(i, { valence: v(i) }));
  const vc = calm.build("signal", 100_000, flies(() => 0));
  // Half the swarm at |valence| 1, half at 0 ⇒ stddev 0.5 ⇒ full dispersion bonus.
  const vp = panic.build("signal", 100_000, flies((i) => (i < 4 ? 1 : 0)));
  assert.ok(vp.spreadBoost > vc.spreadBoost + 0.5, "a dispersed herd panics the spread wide");
  assert.ok(Number(vp.asks[0].price) > Number(vc.asks[0].price), "asks lift");
  assert.ok(Number(vp.bids[0].price) < Number(vc.bids[0].price), "bids drop — the ladder steepens both ways");
});

test("books: the mark tape is the bounded price line (≤ MARK_CAP per good)", () => {
  const b = new MarketBooks();
  for (let i = 0; i < MARK_CAP + 25; i++) b.build("signal", 100_000 + i, [SELLER(0), BUYER(1)]);
  const tape = b.marksOf("signal");
  assert.equal(tape.length, MARK_CAP, "the tape keeps exactly the last MARK_CAP marks");
  assert.equal(tape[tape.length - 1], String(100_000 + MARK_CAP + 24), "newest mark is last");
});

test("books: same readings ⇒ same book, same crossing sequence (determinism, no hidden RNG)", () => {
  const a = new MarketBooks();
  const c = new MarketBooks();
  const rs = Array.from({ length: 12 }, (_, i) =>
    drive(i, { valence: ((i * 37) % 200 - 100) / 100, arousal: (i % 7) / 6, rest: (i % 5) / 4 }),
  );
  a.build("attestation", 77_000, rs);
  c.build("attestation", 77_000, rs);
  assert.deepEqual(a.views(), c.views());
  const eatsA = Array.from({ length: 12 }, () => a.eatAsk("attestation"));
  const eatsC = Array.from({ length: 12 }, () => c.eatAsk("attestation"));
  assert.deepEqual(eatsA, eatsC, "the same twelve crossing orders print the same twelve prices");
  assert.ok(eatsA.every((p, i) => i === 0 || Number(p) >= Number(eatsA[i - 1])),
    "the tape only walks UP the ladder — crossings never print cheaper");
});
