/**
 * ㉕ THE TREATY — unit tests (node:test, mirrors rumor.test.ts's fixture style).
 *
 * Covers: the seal edge (depth gate, deepest-first, one per cron), the probation ratify, breach
 * priority and its full re-seal cooldown, quiet lapse at term, the active cap and per-pair cool,
 * inertness, and the serialize/restore round trip.
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  TreatyMembrane, trTerms,
  TR_SIGN_AT, TR_BREACH_AT, TR_RATIFY_AFTER, TR_RATIFY_BOND, TR_TERM, TR_SIGN_COOL, TR_MAX_ACTIVE,
  type TreatyFacts, type TreatyFeud,
} from "./treaty.js";

const CFG = { enabled: true };

function feud(a: number, b: number, score: number): TreatyFeud {
  return { a, b, score };
}

function facts(era: number, feuds: TreatyFeud[]): TreatyFacts {
  return { era, feuds };
}

/** A membrane that just sealed the 1-2 pair at tick 1 with a −0.5 grudge. */
function sealed(): { tr: TreatyMembrane } {
  const tr = new TreatyMembrane(CFG);
  tr.round(1, facts(4, [feud(1, 2, -0.5)]));
  return { tr };
}

test("treaty: a deep feud sets seals — one treaty, real clause count, names resolved", () => {
  const { tr } = sealed();
  const sig = tr.signals();
  assert.ok(sig.signed, "the seal is news this cron");
  assert.equal(sig.signed!.a, 1);
  assert.equal(sig.signed!.b, 2, "ids are stored canonical (low first)");
  assert.equal(sig.signed!.terms, trTerms(-0.5), "clauses count from the depth of the grudge");
  assert.equal(sig.signed!.nameA, "House 1", "the default resolver still names the pair");
  assert.equal(sig.counts.signed, 1);
  assert.equal(sig.active.length, 1, "one treaty on the roll");
});

test("treaty: the depth gate holds — shallow bonds never sign, and neither does a tie to itself", () => {
  const tr = new TreatyMembrane(CFG);
  tr.round(1, facts(4, [feud(1, 2, TR_SIGN_AT + 0.01), feud(3, 3, -1)]));
  assert.equal(tr.signals().signed, null, "above the line, nobody reaches for a pen");
  assert.equal(tr.signals().active.length, 0);
  // exactly at the line it speaks (<=, the same convention the war gate uses)
  tr.round(2, facts(4, [feud(1, 2, TR_SIGN_AT)]));
  assert.ok(tr.signals().signed, "at the line is deep enough");
});

test("treaty: the deepest feud signs first — one seal per cron, in a stable order", () => {
  const tr = new TreatyMembrane(CFG);
  // both deeper than the seal line but shallower than the breach line, so round 2 judges SEAL, not BREACH
  tr.round(1, facts(4, [feud(1, 2, -0.5), feud(3, 4, -0.55)]));
  assert.equal(tr.signals().signed!.a, 3, "the deeper grudge gets the pen first");
  assert.equal(tr.signals().active.length, 1, "one seal per cron");
  tr.round(2, facts(4, [feud(1, 2, -0.5), feud(3, 4, -0.55)]));
  assert.ok(tr.signals().signed, "the next-deepest pair seals on the following cron");
  assert.equal(tr.signals().signed!.a, 1);
});

test("treaty: ratification needs probation AND a lifted bond — and it fires exactly once", () => {
  const { tr } = sealed();
  // probation not over yet — even a warm bond cannot ratify inside the window
  tr.round(1 + TR_RATIFY_AFTER - 1, facts(4, [feud(1, 2, 0)]));
  assert.equal(tr.signals().ratified, null, "no ratification before the probation runs");
  // probation over but the spite is still open (below the ratify line, above breach)
  tr.round(1 + TR_RATIFY_AFTER, facts(4, [feud(1, 2, -0.3)]));
  assert.equal(tr.signals().ratified, null, "a cold truce is not yet a ratified peace");
  // now the bond has genuinely lifted
  tr.round(1 + TR_RATIFY_AFTER + 1, facts(4, [feud(1, 2, TR_RATIFY_BOND)]));
  assert.ok(tr.signals().ratified, "at the line, past the probation: ratified");
  assert.equal(tr.signals().ratified!.ratified, true);
  // and never again for the same seal
  tr.round(1 + TR_RATIFY_AFTER + 2, facts(4, [feud(1, 2, 0.5)]));
  assert.equal(tr.signals().ratified, null, "one seal is ratified at most once");
});

test("treaty: a breach outranks the rest of the cron and cools the pair fully", () => {
  const { tr } = sealed();
  tr.round(5, facts(4, [feud(1, 2, TR_BREACH_AT)]));
  const sig = tr.signals();
  assert.ok(sig.breached, "at the war line the seal breaks");
  assert.equal(sig.breached!.terms, trTerms(-0.5));
  assert.equal(sig.signed, null, "the breach cron never also announces a fresh seal");
  assert.equal(sig.active.length, 0, "a broken treaty leaves the roll");
  assert.equal(sig.archive.length, 1);
  assert.equal(sig.archive[0].end, "breached");
  assert.equal(sig.counts.breached, 1);
  // the pair may not re-seal until the full cooldown has run
  for (let t = 6; t < 5 + TR_SIGN_COOL; t++) {
    tr.round(t, facts(4, [feud(1, 2, -0.9)]));
    assert.equal(tr.signals().signed, null, `still cooling at tick ${t}`);
  }
  tr.round(5 + TR_SIGN_COOL, facts(4, [feud(1, 2, -0.9)]));
  assert.ok(tr.signals().signed, "once cool, the chancery takes up the pen again");
});

test("treaty: a seal that simply runs its term lapses quietly into the archive", () => {
  const { tr } = sealed();
  // keep the bond in the no-man's-land: too cold to ratify, too warm to breach
  for (let t = 2; t <= TR_TERM; t++) tr.round(t, facts(4, [feud(1, 2, -0.2)]));
  assert.equal(tr.signals().ratified, null);
  assert.equal(tr.signals().active.length, 1, "still live one tick short of term");
  tr.round(TR_TERM + 1, facts(4, [feud(1, 2, -0.2)]));
  const sig = tr.signals();
  assert.equal(sig.active.length, 0, "the term ran out");
  assert.equal(sig.breached, null, "lapse is harvest, not news");
  assert.equal(sig.archive[0].end, "lived");
  assert.equal(sig.counts.lived, 1);
});

test("treaty: the chancery seats at most TR_MAX_ACTIVE seals at once", () => {
  const tr = new TreatyMembrane(CFG);
  const many: TreatyFeud[] = [];
  for (let i = 1; i <= TR_MAX_ACTIVE + 2; i++) many.push(feud(i, i + 100, -0.5));
  for (let t = 1; t <= TR_MAX_ACTIVE; t++) tr.round(t, facts(4, many));
  assert.equal(tr.signals().active.length, TR_MAX_ACTIVE, "the room fills one seal per cron");
  tr.round(TR_MAX_ACTIVE + 1, facts(4, many));
  assert.equal(tr.signals().signed, null, "no pen when the chancery is full");
});

test("treaty: injected names ride the record; disabled membranes never speak", () => {
  const tr = new TreatyMembrane(CFG);
  tr.setNames((id) => `Of ${id}`);
  tr.round(1, facts(4, [feud(1, 2, -0.5)]));
  assert.equal(tr.signals().signed!.nameA, "Of 1");
  assert.equal(tr.signals().signed!.nameB, "Of 2");
  const off = new TreatyMembrane({ enabled: false });
  off.round(1, facts(4, [feud(1, 2, -1)]));
  assert.equal(off.signals().signed, null, "inert: no seal, ever");
  assert.equal(off.signals().active.length, 0);
});

test("treaty: serialize → restore keeps the roll, the cool and the counter", () => {
  const { tr } = sealed();
  tr.round(6, facts(4, [feud(1, 2, TR_BREACH_AT)]));   // breach it: fills archive + lastSign
  const blob = tr.serialize();
  const back = new TreatyMembrane(CFG);
  back.restore(blob);
  const a = tr.signals();
  const b = back.signals();
  assert.deepEqual(b.counts, a.counts, "lifetime counts survive");
  assert.equal(b.archive.length, a.archive.length);
  assert.equal(b.active.length, 0);
  // a fresh seal on the restored membrane must respect the restored cooldown exactly like the original
  for (let t = 7; t < 6 + TR_SIGN_COOL; t++) {
    back.restore(blob); back.round(t, facts(4, [feud(1, 2, -0.9)]));
    tr.round(t, facts(4, [feud(1, 2, -0.9)]));
    assert.equal(back.signals().signed, tr.signals().signed, `tick ${t}: restore and original agree on the cool`);
  }
  // corrupt blobs restart an empty chancery, never a poisoned one
  const junk = new TreatyMembrane(CFG);
  junk.restore("{not json");
  junk.round(1, facts(4, [feud(1, 2, -0.5)]));
  assert.ok(junk.signals().signed, "after junk the desk simply starts fresh");
});
