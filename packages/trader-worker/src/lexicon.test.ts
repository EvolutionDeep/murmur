// ㉓ lexicon.test.ts — coinage edges, doubling spreads, silence deaths, no resurrection, ordering, bounding, restore, inert off.
import { test } from "node:test";
import assert from "node:assert/strict";
import { LexiconMembrane, LEX_WORDS, LEX_COIN_AT, LEX_DORMANT_GAP, LEX_DEAD_ROLL, type LexiconConfig, type LexiconFacts } from "./lexicon.js";

const CFG: LexiconConfig = { enabled: true };

const facts = (over: Partial<LexiconFacts> = {}): LexiconFacts => ({
  era: 5, uses: {}, lastSeq: {}, maxSeq: 100, ...over,
});
const spoken = (kind: string, uses: number, lastSeq = 100): LexiconFacts =>
  facts({ uses: { [kind]: uses }, lastSeq: { [kind]: lastSeq } });

test("㉓ a word told LEX_COIN_AT times enters the lexicon", () => {
  const m = new LexiconMembrane(CFG);
  m.round(1, spoken("FEUD", LEX_COIN_AT));
  const sig = m.signals();
  assert.ok(sig.coinage, "feud has passed into common tongue");
  assert.equal(sig.coinage!.word, LEX_WORDS.FEUD);
  assert.equal(sig.coinage!.uses, LEX_COIN_AT);
  assert.equal(sig.coinage!.era, 5);
  assert.equal(sig.counts.coinages, 1);
  assert.equal(sig.lexicon.length, 1);
  assert.equal(sig.lexicon[0].word, "feud");
});

test("㉓ a word below the tellings stays slang — nothing is coined", () => {
  const m = new LexiconMembrane(CFG);
  m.round(1, spoken("FEUD", LEX_COIN_AT - 1));
  assert.equal(m.signals().coinage, null);
  assert.deepEqual(m.signals().lexicon, []);
});

test("㉓ the desk works in fixed priority order — one coinage per cron, then the queue advances", () => {
  const m = new LexiconMembrane(CFG);
  m.round(1, facts({ uses: { FEUD: 30, PANIC: 40 }, lastSeq: { FEUD: 100, PANIC: 100 } }));
  assert.equal(m.signals().coinage!.word, "feud", "FEUD precedes PANIC in the watched vocabulary");
  m.round(2, facts({ uses: { FEUD: 30, PANIC: 40 }, lastSeq: { FEUD: 100, PANIC: 100 } }));
  assert.equal(m.signals().coinage!.word, "panic", "the waiting word enters next cron");
  m.round(3, facts({ uses: { FEUD: 30, PANIC: 40 }, lastSeq: { FEUD: 100, PANIC: 100 } }));
  assert.equal(m.signals().coinage, null, "held words are never re-coined");
});

test("㉓ spread fires when tellings DOUBLE past the mark, once per doubling", () => {
  const m = new LexiconMembrane(CFG);
  m.round(1, spoken("FEUD", LEX_COIN_AT));                    // coined at 25 → next mark 50
  m.round(2, spoken("FEUD", 49));
  assert.equal(m.signals().spread, null, "49 is not yet double");
  m.round(3, spoken("FEUD", 50));
  const sp = m.signals().spread;
  assert.ok(sp);
  assert.equal(sp!.word, "feud");
  assert.equal(sp!.uses, 50);
  m.round(4, spoken("FEUD", 99));
  assert.equal(m.signals().spread, null, "99 has passed the OLD mark but not the new one (100)");
  m.round(5, spoken("FEUD", 100));
  assert.ok(m.signals().spread, "the second doubling speaks");
  assert.equal(m.signals().counts.spreads, 2);
});

test("㉓ a word unspoken for the dormancy gap leaves the living tongue", () => {
  const m = new LexiconMembrane(CFG);
  m.round(1, spoken("FEUD", LEX_COIN_AT, 100));               // coined, last telling at seq 100
  m.round(2, facts({ uses: { FEUD: 25 }, lastSeq: {}, maxSeq: 100 + LEX_DORMANT_GAP }));
  assert.equal(m.signals().dying, null, "exactly the gap is not past it");
  m.round(3, facts({ uses: { FEUD: 25 }, lastSeq: {}, maxSeq: 101 + LEX_DORMANT_GAP }));
  const d = m.signals().dying;
  assert.ok(d, "the silence outlasted the word");
  assert.equal(d!.word, "feud");
  assert.equal(d!.gap, LEX_DORMANT_GAP + 1);
  assert.deepEqual(m.signals().dead, ["feud"]);
  assert.equal(m.signals().lexicon.length, 0, "the living rows forgot it");
});

test("㉓ a fresh telling rescues the word — memory updates before silence is judged", () => {
  const m = new LexiconMembrane(CFG);
  m.round(1, spoken("FEUD", LEX_COIN_AT, 100));
  m.round(2, spoken("FEUD", 26, 150));                        // spoken again at seq 150
  assert.equal(m.signals().dying, null);
});

test("㉓ dead words are not resurrected — the graveyard holds even when tellings return", () => {
  const m = new LexiconMembrane(CFG);
  m.round(1, spoken("FEUD", LEX_COIN_AT, 100));
  m.round(2, facts({ uses: { FEUD: 25 }, maxSeq: 101 + LEX_DORMANT_GAP }));
  assert.ok(m.signals().dying);
  m.round(3, spoken("FEUD", 999, 400));
  assert.equal(m.signals().coinage, null, "the lexicon marks it remembered, not living — twice");
});

test("㉓ the dead roll is FIFO-bounded", () => {
  const m = new LexiconMembrane(CFG);
  const kinds = Object.keys(LEX_WORDS).slice(0, LEX_DEAD_ROLL + 4);
  for (let t = 1; t <= kinds.length; t++) {
    const uses: Record<string, number> = {}; const last: Record<string, number> = {};
    for (const k of kinds.slice(0, t)) { uses[k] = LEX_COIN_AT; last[k] = 1000 + t; }
    m.round(t, facts({ uses, lastSeq: last, maxSeq: 1000 + t }));          // coin one per cron…
    m.round(100 + t, facts({ uses, lastSeq: last, maxSeq: 2000 + t * 200 })); // …then let it die
  }
  assert.equal(m.signals().dead.length, LEX_DEAD_ROLL, "the graveyard keeps its last few names");
});

test("㉓ null-object (enabled=false) never speaks", () => {
  const m = new LexiconMembrane({ enabled: false });
  m.round(1, spoken("FEUD", 999, 1));
  m.round(999, facts({ uses: { FEUD: 999 }, maxSeq: 9999 }));
  const sig = m.signals();
  assert.equal(sig.coinage, null);
  assert.equal(sig.spread, null);
  assert.equal(sig.dying, null);
  assert.deepEqual(sig.counts, { coinages: 0, spreads: 0, deaths: 0 });
});

test("㉓ twin desks compiling the same tellings keep the same book", () => {
  const run = () => {
    const m = new LexiconMembrane(CFG);
    m.round(1, facts({ uses: { FEUD: 25, CHAMPION: 25 }, lastSeq: { FEUD: 10, CHAMPION: 10 }, maxSeq: 10 }));
    m.round(2, facts({ uses: { FEUD: 25, CHAMPION: 25 }, lastSeq: { FEUD: 10, CHAMPION: 10 }, maxSeq: 10 }));
    m.round(3, facts({ uses: { FEUD: 60, CHAMPION: 25 }, lastSeq: { FEUD: 12, CHAMPION: 11 }, maxSeq: 12 }));
    return { sig: m.signals(), blob: m.serialize() };
  };
  const a = run(); const b = run();
  assert.deepEqual(JSON.parse(JSON.stringify(a.sig)), JSON.parse(JSON.stringify(b.sig)));
  assert.equal(a.blob, b.blob);
});

test("㉓ restore round-trips the desk; the graveyard survives inside the kept roll", () => {
  const m = new LexiconMembrane(CFG);
  m.round(1, spoken("FEUD", LEX_COIN_AT, 100));
  m.round(2, facts({ uses: { FEUD: 25 }, maxSeq: 400 }));     // feud dies, sits in the dead roll
  const blob = m.serialize();
  const m2 = new LexiconMembrane(CFG);
  m2.restore(blob);
  assert.equal(m2.serialize(), blob, "the book round-trips whole");
  m2.round(3, spoken("FEUD", 40, 401));
  assert.equal(m2.signals().coinage, null, "a dead word in the kept roll is not re-coined");
});

test("㉓ corrupt blobs restart an empty desk, never a poisoned one", () => {
  const m = new LexiconMembrane(CFG);
  m.restore("{not json");
  m.restore('{"entries":{"FEUD":"nope","GHOST":{"word":"x","born":1,"nextMark":1,"lastSeq":1}},"dead":[1,"feud"]}');
  m.round(1, facts({}));
  assert.equal(m.signals().coinage, null);
  const sig = m.signals();
  assert.equal(sig.lexicon.length, 0, "junk entries dropped");
  m.round(2, spoken("FEUD", LEX_COIN_AT, 500));
  assert.equal(m.signals().coinage, null, "the word 'feud' in the dead roll still bars the coinage");
  assert.equal(sig.counts.deaths, 0, "counts survive only as real numbers");
});

test("㉓ bounded: at most the watched vocabulary held, at most eight rows shown, a small book", () => {
  const m = new LexiconMembrane(CFG);
  const uses: Record<string, number> = {}; const last: Record<string, number> = {};
  for (const k of Object.keys(LEX_WORDS)) { uses[k] = 30; last[k] = 100; }
  for (let t = 1; t <= Object.keys(LEX_WORDS).length + 2; t++) m.round(t, facts({ uses, lastSeq: last, maxSeq: 100 }));
  const sig = m.signals();
  assert.equal(sig.lexicon.length <= 8, true, "the drawer sees the top eight tellings only");
  assert.equal(m.serialize().length < 4096, true, "the desk's book stays small");
});
