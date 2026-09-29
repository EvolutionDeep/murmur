// ㉓ lexicon.test.ts — coinage edges, lifetime doubling spreads, silence tombstones (never deleted), no
// resurrection, ordering, cold-read truth, reachability calibration (20/20 words coinable), permanent
// archive queue, restore round-trip, corrupt-blob safety, inert off. Task #107 hardening.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  LexiconMembrane, LEX_WORDS, LEX_KINDS, LEX_COIN_AT, LEX_DORMANT_GAP,
  LEX_CALIBRATION_WINDOW, LEX_COIN_AT_BY_KIND, coinThresholdFor, lexiconGrammarHash,
  type LexiconConfig, type LexiconFacts,
} from "./lexicon.js";
import { COOLDOWN } from "./chronicler.js";

const CFG: LexiconConfig = { enabled: true };

const facts = (over: Partial<LexiconFacts> = {}): LexiconFacts => ({
  era: 5, uses: {}, lastSeq: {}, maxSeq: 100, ...over,
});
const spoken = (kind: string, uses: number, lastSeq = 100): LexiconFacts =>
  facts({ uses: { [kind]: uses }, lastSeq: { [kind]: lastSeq } });

test("㉓ a word told its threshold times enters the lexicon", () => {
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

test("㉓ a word below its threshold stays slang — nothing is coined", () => {
  const m = new LexiconMembrane(CFG);
  m.round(1, spoken("FEUD", coinThresholdFor("FEUD") - 1));
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

test("㉓ spread fires when LIFETIME tellings DOUBLE past the mark, once per doubling (A-3 fix)", () => {
  // Spread is driven by the MONOTONE lifetimeUses (fed by `fresh`), NOT the shrinking rolling window —
  // the old `uses >= nextMark*2` test was dead code once the window aged below the mark.
  const m = new LexiconMembrane(CFG);
  const seq = (n: number, uses: number, fresh: number): LexiconFacts =>
    facts({ uses: { FEUD: uses }, lastSeq: { FEUD: n }, maxSeq: n, fresh: { FEUD: fresh } });
  m.round(1, spoken("FEUD", LEX_COIN_AT, 100));   // coined: lifetime=25, next mark=50
  m.round(2, seq(124, 25, 24));                    // lifetime 25→49
  assert.equal(m.signals().spread, null, "49 lifetime is not yet double");
  m.round(3, seq(125, 26, 1));                     // lifetime 49→50
  const sp = m.signals().spread;
  assert.ok(sp);
  assert.equal(sp!.word, "feud");
  assert.equal(sp!.uses, 50, "the spread edge reports the LIFETIME doubling number");
  m.round(4, seq(174, 26, 49));                    // lifetime 50→99
  assert.equal(m.signals().spread, null, "99 has passed the OLD mark but not the new one (100)");
  m.round(5, seq(175, 27, 1));                     // lifetime 99→100
  assert.ok(m.signals().spread, "the second doubling speaks");
  assert.equal(m.signals().counts.spreads, 2);
});

test("㉓ lifetimeUses is monotone and ≥ rolling uses even as the window shrinks (A-2 fix)", () => {
  const m = new LexiconMembrane(CFG);
  m.round(1, spoken("FEUD", LEX_COIN_AT, 100));    // lifetime seeded at rolling 25
  let prev = m.dictionary()[0].lifetimeUses;
  assert.equal(prev, LEX_COIN_AT);
  // Roll the window: uses SHRINKS (old tellings age out) but fresh keeps arriving → lifetime only grows.
  const steps: [number, number, number][] = [[120, 10, 5], [140, 6, 4], [160, 3, 7], [180, 2, 0]];
  let n = 1;
  for (const [seq, uses, fresh] of steps) {
    n++;
    m.round(n, facts({ uses: { FEUD: uses }, lastSeq: { FEUD: seq }, maxSeq: seq, fresh: { FEUD: fresh } }));
    const w = m.dictionary()[0];
    assert.ok(w.lifetimeUses >= prev, "lifetime never decreases");
    assert.ok(w.lifetimeUses >= w.uses, "lifetime ≥ rolling window, always");
    prev = w.lifetimeUses;
  }
  assert.equal(prev, LEX_COIN_AT + 5 + 4 + 7 + 0, "lifetime accumulated exactly the fresh tellings");
});

test("㉓ a word unspoken for the dormancy gap leaves the living tongue — as a TOMBSTONE, not deleted", () => {
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
  // P0-2: the entry is NOT deleted — it survives as a tombstone in the full dictionary.
  const buried = m.dictionary().find((w) => w.kind === "FEUD");
  assert.ok(buried, "the word is kept forever (never delete entries[kind])");
  assert.equal(buried!.status, "dead");
  assert.equal(buried!.lifetimeUses, LEX_COIN_AT, "its history is intact");
  assert.equal(buried!.deathTick, 3);
});

test("㉓ a fresh telling rescues the word — memory updates before silence is judged", () => {
  const m = new LexiconMembrane(CFG);
  m.round(1, spoken("FEUD", LEX_COIN_AT, 100));
  m.round(2, spoken("FEUD", 26, 150));                        // spoken again at seq 150
  assert.equal(m.signals().dying, null);
});

test("㉓ dead words are not resurrected — the tombstone holds even when tellings return (C-3 fix)", () => {
  const m = new LexiconMembrane(CFG);
  m.round(1, spoken("FEUD", LEX_COIN_AT, 100));
  m.round(2, facts({ uses: { FEUD: 25 }, maxSeq: 101 + LEX_DORMANT_GAP }));
  assert.ok(m.signals().dying);
  m.round(3, spoken("FEUD", 999, 400));
  assert.equal(m.signals().coinage, null, "the lexicon marks it remembered, not living — twice");
  // Even a serialize/restore cycle keeps the bar (the graveyard is rebuilt from the persisted book).
  const m2 = new LexiconMembrane(CFG);
  m2.restore(m.serialize());
  m2.round(4, spoken("FEUD", 999, 500));
  assert.equal(m2.signals().coinage, null, "a restored tombstone still bars re-coinage — no fabricated rebirth");
});

test("㉓ tombstones are PERMANENT — no FIFO eviction, the graveyard keeps every name (C-1 fix)", () => {
  const m = new LexiconMembrane(CFG);
  const kinds = LEX_KINDS.slice(0, 12);   // more than the old LEX_DEAD_ROLL=8 cap
  for (let t = 1; t <= kinds.length; t++) {
    const uses: Record<string, number> = {}; const last: Record<string, number> = {};
    for (const k of kinds.slice(0, t)) { uses[k] = LEX_COIN_AT; last[k] = 1000 + t; }
    m.round(t, facts({ uses, lastSeq: last, maxSeq: 1000 + t }));              // coin one per cron…
    m.round(100 + t, facts({ uses, lastSeq: last, maxSeq: 2000 + t * 400 }));  // …then let it die
  }
  assert.equal(m.signals().dead.length, kinds.length, "ALL twelve names are kept — nothing evicted");
  assert.equal(m.dictionary().filter((w) => w.status === "dead").length, kinds.length, "twelve tombstones persist");
  // And none of them can be re-coined (structural no-resurrection).
  const uses: Record<string, number> = {}; const last: Record<string, number> = {};
  for (const k of kinds) { uses[k] = 999; last[k] = 99999; }
  m.round(900, facts({ uses, lastSeq: last, maxSeq: 99999 }));
  assert.equal(m.signals().coinage, null, "no dead word is reborn");
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

test("㉓ COLD READ (A-1 fix): a restored desk reads TRUTH before any round(), never an empty drawer", () => {
  const m = new LexiconMembrane(CFG);
  m.round(1, spoken("FEUD", LEX_COIN_AT, 100));
  m.round(2, facts({ uses: { FEUD: 18 }, lastSeq: { FEUD: 140 }, maxSeq: 140, fresh: { FEUD: 6 } }));
  const blob = m.serialize();
  // A freshly-evicted DO reloads the blob and the /economy read-out fires BEFORE the next cron's round().
  const cold = new LexiconMembrane(CFG);
  cold.restore(blob);
  const sig = cold.signals();          // NO round() — the cold-read path that used to show empty
  assert.equal(sig.lexicon.length, 1, "the living row is present on a cold read");
  assert.equal(sig.lexicon[0].word, "feud");
  assert.equal(sig.lexicon[0].uses, 18, "the persisted rolling count surfaces (not 0)");
  const w = cold.dictionary()[0];
  assert.equal(w.lifetimeUses, LEX_COIN_AT + 6, "the persisted lifetime count survives eviction");
  assert.equal(w.lastTold, 140, "the persisted last-telling seq survives eviction");
});

test("㉓ restore round-trips the desk byte-for-byte; the tombstone survives whole", () => {
  const m = new LexiconMembrane(CFG);
  m.round(1, spoken("FEUD", LEX_COIN_AT, 100));
  m.round(2, facts({ uses: { FEUD: 25 }, maxSeq: 400 }));     // feud dies → tombstone
  const blob = m.serialize();
  const m2 = new LexiconMembrane(CFG);
  m2.restore(blob);
  assert.equal(m2.serialize(), blob, "the book round-trips whole");
  m2.round(3, spoken("FEUD", 40, 401));
  assert.equal(m2.signals().coinage, null, "a tombstoned word is not re-coined");
});

test("㉓ corrupt blobs restart an empty desk, never a poisoned one", () => {
  const m = new LexiconMembrane(CFG);
  m.restore("{not json");
  m.restore('{"entries":{"FEUD":"nope","GHOST":{"word":"x","born":1,"nextMark":1,"lastSeq":1}},"dead":[1,"feud"]}');
  m.round(1, facts({}));
  assert.equal(m.signals().coinage, null);
  const sig = m.signals();
  assert.equal(sig.lexicon.length, 0, "junk entries dropped; the legacy dead-roll word is a tombstone, not living");
  m.round(2, spoken("FEUD", LEX_COIN_AT, 500));
  assert.equal(m.signals().coinage, null, "the word 'feud' migrated from the legacy dead roll still bars coinage");
  assert.equal(sig.counts.deaths, 0, "counts survive only as real numbers");
});

test("㉓ legacy full-key blob migrates: dead[] becomes tombstones, entries keep their history", () => {
  const m = new LexiconMembrane(CFG);
  m.restore(JSON.stringify({
    v: 1,
    entries: { FEUD: { word: LEX_WORDS.FEUD, born: 2, nextMark: LEX_COIN_AT, lastSeq: 90 } },
    dead: [LEX_WORDS.PANIC],
    counts: { coinages: 3, spreads: 1, deaths: 2 },
  }));
  const sig = m.signals();          // NO round() — the DO-reload read-out path
  assert.deepEqual(sig.counts, { coinages: 3, spreads: 1, deaths: 2 }, "restored counts surface immediately, not 0");
  assert.deepEqual(sig.dead, [LEX_WORDS.PANIC], "the legacy dead roll migrated to a permanent tombstone");
  assert.equal(sig.coinage, null);
  assert.equal(sig.spread, null);
  assert.equal(sig.dying, null);
  // A migrated tombstone can never be re-coined.
  m.round(1, spoken("PANIC", 999, 500));
  assert.equal(m.signals().coinage, null, "panic stays remembered, not living");
});

test("㉓ bounded: the FULL living dictionary is exposed (no slice-8 truncation, C-5 fix) and the book stays small", () => {
  const m = new LexiconMembrane(CFG);
  const uses: Record<string, number> = {}; const last: Record<string, number> = {};
  for (const k of LEX_KINDS) { uses[k] = 30; last[k] = 100; }
  for (let t = 1; t <= LEX_KINDS.length + 2; t++) m.round(t, facts({ uses, lastSeq: last, maxSeq: 100 }));
  const sig = m.signals();
  assert.equal(sig.lexicon.length, LEX_KINDS.length, "all twenty living rows are exposed — nothing hidden");
  assert.equal(m.dictionary().length, LEX_KINDS.length, "the dictionary holds the whole vocabulary");
  assert.equal(m.serialize().length < 4096, true, "the desk's book stays small even holding all twenty words");
});

test("㉓ coinedBy records who was speaking when the word was made (P2-2)", () => {
  const m = new LexiconMembrane(CFG);
  m.round(1, facts({ uses: { FEUD: LEX_COIN_AT }, lastSeq: { FEUD: 100 }, maxSeq: 100, lastActor: { FEUD: "17" } }));
  const w = m.dictionary().find((x) => x.kind === "FEUD");
  assert.equal(w?.coinedBy, "17", "the coining mouth is remembered forever");
  const ev = m.drainArchive().find((e) => e.event === "COINAGE");
  assert.equal(ev?.coinedBy, "17", "the archive event carries the coiner too");
});

test("㉓ the archive queue yields immutable COINAGE / SPREAD / SILENCE events for the D1 layer (P0-1)", () => {
  const m = new LexiconMembrane(CFG);
  m.round(1, spoken("FEUD", LEX_COIN_AT, 100));
  let q = m.drainArchive();
  assert.equal(q.length, 1);
  assert.equal(q[0].event, "COINAGE");
  assert.equal(q[0].kind, "FEUD");
  assert.equal(q[0].word, "feud");
  assert.equal(q[0].lifetimeUses, LEX_COIN_AT);
  assert.equal(q[0].era, 5);
  assert.deepEqual(m.drainArchive(), [], "draining empties the queue (no double-append)");
  // A spread then a burial, each queued once.
  m.round(2, facts({ uses: { FEUD: 25 }, lastSeq: { FEUD: 150 }, maxSeq: 150, fresh: { FEUD: 25 } }));  // lifetime→50
  q = m.drainArchive();
  assert.equal(q.some((e) => e.event === "SPREAD"), true, "the doubling is archived");
  m.round(3, facts({ uses: { FEUD: 25 }, lastSeq: {}, maxSeq: 151 + LEX_DORMANT_GAP }));                 // silence
  q = m.drainArchive();
  const sil = q.find((e) => e.event === "SILENCE");
  assert.ok(sil, "the burial is archived");
  assert.equal(sil!.gap, LEX_DORMANT_GAP + 1);
  assert.equal(sil!.lifetimeUses, 50, "the buried word's lifetime history is preserved in the archive");
});

test("㉓ P2-1 REACHABILITY: all 20 words are mathematically coinable within the annals window", () => {
  // A kind with chronicle cooldown C can accumulate at most floor(W/C)+1 tellings in a window of W ticks.
  // A word is reachable iff its threshold ≤ that maximum. Prove it for the nominal window AND a halved one
  // (the dynamic-shrinkage margin: a noisier chronicle contracts W, so the calibration keeps a 2× cushion).
  const W_NOMINAL = 942;   // ≈ ANNALS_CAP-derived hot-roll window
  const W_HALVED = Math.floor(W_NOMINAL / 2);
  assert.equal(LEX_CALIBRATION_WINDOW, W_HALVED, "the calibration window is the halved nominal window");
  for (const kind of LEX_KINDS) {
    const c = COOLDOWN[kind as keyof typeof COOLDOWN] ?? 30;
    const threshold = LEX_COIN_AT_BY_KIND[kind];
    assert.equal(threshold, coinThresholdFor(kind), "the frozen map matches the derivation");
    assert.ok(threshold >= 2, `${kind}: threshold has a floor`);
    assert.ok(threshold <= LEX_COIN_AT, `${kind}: threshold never exceeds the flat gravitas ceiling`);
    const maxNominal = Math.floor(W_NOMINAL / c) + 1;
    const maxHalved = Math.floor(W_HALVED / c) + 1;
    assert.ok(threshold <= maxNominal, `${kind} (C=${c}) is coinable in the nominal window: ${threshold} ≤ ${maxNominal}`);
    assert.ok(threshold <= maxHalved, `${kind} (C=${c}) stays coinable in a HALVED window: ${threshold} ≤ ${maxHalved}`);
  }
  // The eight historically-starved words (the civilisation-weight vocabulary) are now reachable.
  for (const kind of ["EXILE", "AMNESTY", "CHAMPION", "GOLDEN_AGE", "DARK_AGE", "MIGRATION", "INVENTION", "CRAFT_LOST"]) {
    assert.ok(LEX_COIN_AT_BY_KIND[kind] <= LEX_COIN_AT, `${kind} was recalibrated below the unreachable flat 25`);
  }
  assert.equal(LEX_KINDS.length, 20, "the vocabulary is the closed twenty");
});

test("㉓ lexiconGrammarHash is a stable 64-hex anchor over the word-list + thresholds", async () => {
  const a = await lexiconGrammarHash();
  const b = await lexiconGrammarHash();
  assert.equal(a, b, "a pure function of the source — deterministic");
  assert.match(a, /^[0-9a-f]{64}$/, "sha256 hex, no 0x");
});
