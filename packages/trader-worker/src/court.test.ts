// ⑳ court.test.ts — determinism, docket lifecycle, jury fairness, amnesty, bounding, restore-safety, inert off.
import { test } from "node:test";
import assert from "node:assert/strict";
import { CourtMembrane, COURT_CASES, COURT_OUTLAWS, COURT_KEYS, type CourtConfig, type CourtFacts } from "./court.js";

const CFG: CourtConfig = { enabled: true, fileP: 1.0, jurySize: 5 };
const POOL = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12];

const facts = (over: Partial<CourtFacts> = {}): CourtFacts => ({
  deadbeat: { id: 7, kept: 3, broken: 5, score: -2 },   // evidence 1.0 — exile-grade debt
  betrayal: null,
  feud: null,
  era: 1,
  livingIds: POOL,
  ...over,
});

/** Run one membrane through a full case lifecycle (file → convene → decide) and collect every edge event. */
function oneLife(cfg: CourtConfig = CFG, f: CourtFacts = facts()) {
  const m = new CourtMembrane(cfg);
  const seen: ReturnType<CourtMembrane["signals"]>[] = [];
  for (let t = 1; t <= 8; t++) {
    m.round(t, f);
    seen.push(m.signals());
  }
  return { m, seen };
}

// A mid-lifecycle blob lets us test the trial/verdict stages WITHOUT depending on hash luck at filing.
const CASE_BLOB = (defendantId: number, prosecutorId: number, evidence: number) => JSON.stringify({
  v: 1,
  cases: [{
    key: `debt:${defendantId}`, crime: "debt", defendantId, prosecutorId,
    filedTick: 5, evidence, convenedTick: 0, jurors: [], verdict: null, votesGuilty: 0,
  }],
  outlaws: [], seen: [], counts: { indicted: 1, convicted: 0, cleared: 0, exiles: 0, amnesties: 0 }, amnestyEra: 1,
});

test("⑳ indictment fires when fileP=1 and a broken-debt fact exists", () => {
  const m = new CourtMembrane(CFG);
  m.round(1, facts());
  const sig = m.signals();
  assert.ok(sig.indictment, "a case should be filed on tick 1 at p=1");
  assert.equal(sig.indictment!.id, 7);
  assert.equal(sig.indictment!.crime, "debt");
  assert.equal(sig.counts.indicted, 1);
  assert.equal(sig.openCases, 1);
});

test("⑳ fileP=0 never opens a case", () => {
  const m = new CourtMembrane({ enabled: true, fileP: 0, jurySize: 5 });
  for (let t = 1; t <= 50; t++) m.round(t, facts());
  assert.equal(m.signals().indictment, null);
  assert.equal(m.signals().counts.indicted, 0);
});

test("⑳ no ledger facts, no justice: nothing is indictable", () => {
  const m = new CourtMembrane(CFG);
  for (let t = 1; t <= 30; t++) m.round(t, facts({ deadbeat: null, betrayal: null, feud: null }));
  assert.equal(m.signals().counts.indicted, 0);
});

test("⑳ null-object (enabled=false) never speaks", () => {
  const m = new CourtMembrane({ enabled: false, fileP: 1, jurySize: 5 });
  for (let t = 1; t <= 20; t++) m.round(t, facts());
  const sig = m.signals();
  assert.equal(sig.indictment, null);
  assert.equal(sig.openCases, 0);
  assert.equal(sig.counts.indicted, 0);
  assert.deepEqual(sig.outlaws, []);
});

test("⑳ determinism: identical input streams serialize identically", () => {
  const mk = () => {
    const m = new CourtMembrane(CFG);
    for (let t = 1; t <= 40; t++) m.round(t, facts({ betrayal: { tick: t, buyerId: 3, sellerId: 8, amountUsdc: t / 10 } }));
    return m.serialize();
  };
  assert.equal(mk(), mk());
});

test("⑳ lifecycle: filed case convenes after the trial delay, then decides", () => {
  const m = new CourtMembrane({ enabled: true, fileP: 0, jurySize: 5 }); // no new filings; drive the restored case
  m.restore(CASE_BLOB(7, 2, 0.8));
  m.round(7, facts({ deadbeat: null }));            // tick 7 - filed 5 = 2 < 3 → still waiting
  assert.equal(m.signals().trial, null);
  m.round(8, facts({ deadbeat: null }));            // convene (≥ TRIAL_DELAY)
  const trial = m.signals().trial;
  assert.ok(trial, "jury should be seated on tick 8");
  assert.equal(trial!.id, 7);
  assert.ok(trial!.jurors >= 1 && trial!.jurors <= 5, "seated jury within configured size");
  m.round(9, facts({ deadbeat: null }));            // convened 8 → 1 < VERDICT_DELAY
  assert.equal(m.signals().verdict, null);
  m.round(10, facts({ deadbeat: null }));           // decide (≥ VERDICT_DELAY)
  const v = m.signals().verdict;
  assert.ok(v, "a verdict must land by tick 10");
  assert.equal(v!.id, 7);
  assert.ok(v!.votes <= v!.jurors, "guilty votes never exceed seated jurors");
  assert.equal(m.signals().openCases, 0, "the docket drains after the verdict");
  assert.equal(v!.guilty ? m.signals().counts.convicted : m.signals().counts.cleared, 1);
});

test("⑳ jury excludes both parties and the outlaw roll", () => {
  const m = new CourtMembrane({ enabled: true, fileP: 0, jurySize: 5 });
  m.restore(JSON.stringify({
    v: 1,
    cases: [{ key: "feud:4:9", crime: "feud", defendantId: 4, prosecutorId: 9, filedTick: 5, evidence: 0.5, convenedTick: 0, jurors: [], verdict: null, votesGuilty: 0 }],
    outlaws: [{ id: 1, crime: "debt", since: 2 }],
    seen: [], counts: { indicted: 1, convicted: 0, cleared: 0, exiles: 0, amnesties: 0 }, amnestyEra: 1,
  }));
  // Pool of 1,2,3,4,9,10 minus defendant 4, prosecutor 9, outlaw 1 → exactly {2,3,10} can be seated.
  m.round(8, facts({ deadbeat: null, livingIds: [1, 2, 3, 4, 9, 10] }));
  assert.equal(m.signals().trial!.jurors, 3);
});

test("⑳ exile follows only a guilty verdict on heavy evidence, and amnesty clears the roll", () => {
  // Find one deterministic route to exile by walking betrayal keys (each changes the matter key → the draws).
  let found: CourtMembrane | null = null;
  for (let k = 1; k <= 60 && !found; k++) {
    const { m, seen } = oneLife(CFG, facts({
      deadbeat: null,
      betrayal: { tick: k, buyerId: 2, sellerId: 8, amountUsdc: 5 }, // evidence 1.0 → exile-grade
    }));
    if (seen.some((s) => s.exile) && seen.some((s) => s.verdict?.guilty)) {
      assert.ok(m.signals().outlaws.some((o) => o.id === 8), "the exiled defendant sits on the roll");
      found = m;
    }
  }
  assert.ok(found, "a guilty-exile verdict should appear within 60 matter keys at p=1");
  // Amnesty: the turn of an era pardons the whole roll exactly once.
  found.restore(JSON.stringify({ v: 1, cases: [], outlaws: [{ id: 8, crime: "treason", since: 4 }], seen: [], counts: { indicted: 1, convicted: 1, cleared: 0, exiles: 1, amnesties: 0 }, amnestyEra: 1 }));
  found.round(9, facts({ era: 2 }));
  const sig = found.signals();
  assert.deepEqual(sig.amnesty, { outlaws: 1 });
  assert.deepEqual(sig.outlaws, []);
  assert.equal(sig.counts.amnesties, 1);
  found.round(10, facts({ era: 2 }));
  assert.equal(found.signals().amnesty, null, "no repeat amnesty inside the same era");
});

test("⑳ boot mid-era adopts the era silently (no phantom amnesty)", () => {
  const m = new CourtMembrane(CFG);
  m.round(1, facts({ era: 64 }));
  assert.equal(m.signals().amnesty, null);
});

test("⑳ a matter is never re-indicted (seen keys) and one defendant holds one case", () => {
  const m = new CourtMembrane(CFG);
  for (let t = 1; t <= 30; t++) m.round(t, facts({ betrayal: { tick: t, buyerId: 2, sellerId: 8, amountUsdc: 0.2 } }));
  const s = m.signals();
  // debt:#7 and treason:#…:t are distinct matters, but each single matter can only be filed once.
  assert.ok(s.counts.indicted <= 2, `indictments must not repeat a matter key (got ${s.counts.indicted})`);
  assert.ok(s.counts.indicted >= 1);
});

test("⑳ restore enforces the structural bounds (cases/outlaws/keys)", () => {
  const wide = (n: number, mk: (i: number) => unknown) => Array.from({ length: n }, (_, i) => mk(i));
  const m = new CourtMembrane(CFG);
  m.restore(JSON.stringify({
    v: 1,
    cases: wide(20, (i) => ({ key: `debt:${i}`, crime: "debt", defendantId: i, prosecutorId: i, filedTick: 1, evidence: 0.5, convenedTick: 0, jurors: [], verdict: null, votesGuilty: 0 })),
    outlaws: wide(30, (i) => ({ id: 1000 + i, crime: "debt", since: 1 })),
    seen: wide(100, (i) => `k${i}`),
    counts: { indicted: 9, convicted: 2, cleared: 1, exiles: 4, amnesties: 0 }, amnestyEra: 3,
  }));
  const blob = JSON.parse(m.serialize());
  assert.equal(blob.cases.length, COURT_CASES, "docket clamps to COURT_CASES keeping the newest");
  assert.equal(blob.outlaws.length, COURT_OUTLAWS);
  assert.equal(blob.seen.length, COURT_KEYS);
  assert.equal(blob.counts.indicted, 9, "cumulative counts survive untouched");
});

test("⑳ corrupt blobs restart an empty docket, never a poisoned ledger", () => {
  const m = new CourtMembrane(CFG);
  m.restore("not json{{{");
  m.restore(JSON.stringify({ v: 9, cases: "nope", outlaws: [null], seen: 5 }));
  const blob = JSON.parse(m.serialize());
  assert.deepEqual(blob.cases, []);
  assert.deepEqual(blob.outlaws, []);
  assert.deepEqual(blob.seen, []);
});

test("⑳ serialize stays far below the DO value wall", () => {
  const m = new CourtMembrane(CFG);
  for (let t = 1; t <= 500; t++) {
    m.round(t, facts({
      betrayal: t % 3 === 0 ? { tick: t, buyerId: 2, sellerId: 8 + (t % 4), amountUsdc: 5 } : null,
      feud: { a: 3, b: 4, score: 10 },
    }));
  }
  assert.ok(m.serialize().length < 16_000, `blob is ${m.serialize().length} bytes`);
});
