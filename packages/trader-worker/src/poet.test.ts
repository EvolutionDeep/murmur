// ⑮ THE LAUREATE tests — the poet's own contracts (poet.ts).
//
// The iron rule under test everywhere: a poem is a DETERMINISTIC function of PUBLISHED inputs (the laureate's
// quantized neural read-out + the era + the on-chain reality) decoded through the PUBLIC grammar — no LLM, no
// Math.random, no wall clock. So the two things that MUST be pinned are the war.ts / socialStimulus.ts discipline:
//   1. REPLAYABLE + SELF-CONSISTENT — compose() twice on the same integers is byte-identical; replayCompose() of a
//      stored poem reproduces its text; recomputePoemHash() reproduces its receipt hash; tamper a single published
//      integer and the text changes (replayMatch=false); tamper the text and the hash no longer matches.
//   2. BOUNDED + INDEPENDENT + INERT-WHEN-COLD — the chain is a ring (≤ cap), genesis prevHash is "" and every
//      later poem links to its predecessor, a cold cron (no live fly / no reading) composes nothing, and a NaN
//      knob or a NaN neural field never leaks (config falls back to defaults; every neuralInt stays finite).
// On top of those we pin the SEMANTIC ANCHORING: a dark/plague age can never reach for a bright (gold/song/light)
// word, because a domain with weight 0 in both phase and shock is never chosen — whatever the on-chain weather.

import test from "node:test";
import assert from "node:assert/strict";

import { FAP_ROLE, type Fap } from "@fly/fly-brain";
import {
  Poet,
  compose,
  quantizeNeural,
  replayCompose,
  poemReceiptHash,
  recomputePoemHash,
  selectLaureate,
  poetGrammarHash,
  LEXICON,
  DOMAINS,
  POET_VERSION,
  POET_POLICY,
  type PoemChain,
  type PoemEntry,
  type PoetConfig,
  type PoetContext,
  type PoetEraInput,
} from "./poet.js";
import type { FlyReading } from "./population.js";
import { loadConfig, type Env } from "./config.js";

// ---------- helpers ----------

const FAP: Fap = "REST";

/** A minimal, valid FlyReading (the culture.test.ts shape); the fingerprint is a real 32-hex string per id. */
function reading(id: number, over: Partial<FlyReading> = {}): FlyReading {
  return {
    id, state: "EXPLORE",
    arousal: 0.5, turnBias: 0, cohesion: 0.5,
    wingbeat: 0.5, rest: 0.2, temperament: ((id * 7919) % 1000) / 1000,
    fingerprint: (id.toString(16).padStart(2, "0") + "abcdef0123456789").slice(0, 32),
    fap: FAP, valence: 0, heading: 0, role: FAP_ROLE[FAP], bouts: [],
    ...over,
  };
}

function era(over: Partial<PoetEraInput> = {}): PoetEraInput {
  return {
    era: 1, seq: 1, eraName: "First Light", eraRegime: "CALM",
    civPhase: "golden", civLevel: 50, eraShock: null,
    generation: 1, headHash: "head0000000000000000000000000000000000",
    ...over,
  };
}

function chain(over: Partial<PoemChain> = {}): PoemChain {
  return {
    temperature: 0.5, regime: "CALM", volumeUsdcDelta: 0,
    settlementsDelta: 0, deathsDelta: 0, liveAgents: 8, gini: 0.3,
    ...over,
  };
}

const LIVE_IDS = Array.from({ length: 24 }, (_, i) => i);

function ctx(over: Partial<PoetContext> = {}): PoetContext {
  return {
    tick: 100, cron: 1, era: era(), liveIds: LIVE_IDS,
    readingOf: (id) => (LIVE_IDS.includes(id) ? reading(id) : null),
    houseOf: () => null,
    temperature: 0.5, regime: "CALM",
    totals: { volumeUsdc: 100, count: 10, liveAgents: 8, gini: 0.3 },
    deathsDelta: 0,
    ...over,
  };
}

const CFG: PoetConfig = { cap: 64, minCrons: 1 };

/** Drive `n` poems, advancing the cron each time so the ≈hourly cadence fires (minCrons=1). */
async function drive(poet: Poet, n: number, base: PoetContext = ctx()): Promise<(PoemEntry | null)[]> {
  const out: (PoemEntry | null)[] = [];
  for (let i = 0; i < n; i++) {
    out.push(await poet.maybeCompose({
      ...base,
      tick: base.tick + i * 6,
      cron: base.cron + i,
      totals: { volumeUsdc: 100 + i, count: 10 + i, liveAgents: 8, gini: 0.3 },
    }));
  }
  return out;
}

/** A minimal, valid Env (only the required fields matter for config parsing; the rest default). */
function env(over: Partial<Env> = {}): Env {
  return {
    FLY_STATE: {} as Env["FLY_STATE"],
    CHAIN_ID: "5042002",
    RPC_URL: "https://rpc.testnet.arc.io",
    ...over,
  } as Env;
}

const BRIGHT = new Set([...LEXICON.GOLD, ...LEXICON.SONG, ...LEXICON.LIGHT].map((w) => w.toLowerCase()));
const tokens = (text: string) => text.toLowerCase().split(/[^a-z]+/).filter(Boolean);

// ================= determinism: the same published integers ⇒ the same poem =================

test("compose is byte-identical across calls on the same inputs (no hidden RNG / clock)", () => {
  const ints = quantizeNeural(reading(3), 50);
  const a = compose(ints, era(), chain(), { id: 3 });
  const b = compose(ints, era(), chain(), { id: 3 });
  assert.equal(a.text, b.text);
  assert.deepEqual(a.lines, b.lines);
  assert.equal(a.lines.length, 4);
  assert.equal(a.text, a.lines.join("\n"));
});

test("compose varies with the neural integers and with the laureate's id (the ink matters)", () => {
  const e = era(), c = chain();
  const base = compose(quantizeNeural(reading(3), 50), e, c, { id: 3 });
  const otherInk = compose(quantizeNeural(reading(9), 80), e, c, { id: 3 });
  const otherPoet = compose(quantizeNeural(reading(3), 50), e, c, { id: 11 });
  // At least one of a different fly's drives or a different crown changes the quatrain.
  assert.ok(base.text !== otherInk.text || base.text !== otherPoet.text);
});

test("every composed line is non-empty, capitalized, and free of unfilled slots", () => {
  for (let s = 0; s < 50; s++) {
    const ints = Array.from({ length: 26 }, (_, k) => (s * 31 + k * 17) % 256);
    const { lines } = compose(ints, era({ civPhase: "dark", eraShock: "PLAGERA" }), chain({ regime: "HOT", gini: 0.9, deathsDelta: 2 }), { id: s });
    for (const ln of lines) {
      assert.ok(ln.length > 0);
      assert.ok(!ln.includes("{0}") && !ln.includes("{1}"), `unfilled slot in: ${ln}`);
      assert.equal(ln[0], ln[0].toUpperCase(), `not capitalized: ${ln}`);
    }
  }
});

// ================= replay: the core "neurons wrote it, anyone can check" proof =================

test("replayCompose reproduces a stored poem's text byte-for-byte (replayMatch=true)", async () => {
  const poet = new Poet(CFG);
  const entry = (await drive(poet, 1))[0];
  assert.ok(entry);
  const replay = replayCompose(entry);
  assert.equal(replay.match, true);
  assert.equal(replay.text, entry.text);
});

test("tampering ONE published neural integer changes the text and breaks replayMatch", async () => {
  const poet = new Poet(CFG);
  const entry = (await drive(poet, 1))[0]!;
  // ints[2] picks line 0's first word within its domain; +1 shifts the index by one modulo the lexicon
  // length, and every word in a domain is distinct, so the text is GUARANTEED to change.
  const tampered: PoemEntry = { ...entry, neuralInts: entry.neuralInts.slice() };
  tampered.neuralInts[2] += 1;
  const replay = replayCompose(tampered);
  assert.equal(replay.match, false);
  assert.notEqual(replay.text, entry.text);
});

// ================= receipt: the hash is a pure function of the entry's own bytes =================

test("poemReceiptHash / recomputePoemHash are self-consistent; editing the text breaks the hash", async () => {
  const poet = new Poet(CFG);
  const entry = (await drive(poet, 1))[0]!;
  const { hash, ...base } = entry;
  assert.equal(await poemReceiptHash(base), hash);
  assert.equal(await recomputePoemHash(entry), entry.hash);
  const bad: PoemEntry = { ...entry, text: entry.text + " tampered" };
  assert.notEqual(await recomputePoemHash(bad), bad.hash);
});

test("the stored grammarHash equals the current poetGrammarHash (the decoding rules are unchanged)", async () => {
  const gh = await poetGrammarHash();
  assert.match(gh, /^[0-9a-f]{64}$/);
  assert.equal(gh, await poetGrammarHash()); // stable
  const poet = new Poet(CFG);
  const entry = (await drive(poet, 1))[0]!;
  assert.equal(entry.grammarHash, gh);
});

// ================= bounded: the chain is a ring, the ordinal is monotonic =================

test("the poem ring truncates to cap while headSeq stays monotonic and the head is correct", async () => {
  const poet = new Poet({ cap: 4, minCrons: 1 });
  const made = await drive(poet, 6);
  assert.equal(made.filter(Boolean).length, 6);
  assert.equal(poet.size, 4);                 // ring holds only the last 4
  assert.equal(poet.headSeq, 6);              // ordinal survives truncation
  const kept = made.slice(-4) as PoemEntry[]; // seqs 3,4,5,6
  assert.deepEqual(poet.recent(4).map((e) => e.seq), kept.map((e) => e.seq));
  assert.equal(poet.chainHead, kept[kept.length - 1].hash);
  assert.equal(poet.latest()!.seq, 6);
  assert.equal(poet.get(3)!.seq, 3);
  assert.equal(poet.get(1), null);            // truncated away
});

// ================= hash chain: genesis + linkage =================

test("genesis prevHash is empty and every later poem links to its predecessor's hash", async () => {
  const poet = new Poet(CFG);
  const made = (await drive(poet, 5)) as PoemEntry[];
  assert.equal(made[0].prevHash, "");
  for (let i = 1; i < made.length; i++) {
    assert.equal(made[i].prevHash, made[i - 1].hash);
    assert.equal(made[i].seq, made[i - 1].seq + 1);
  }
  assert.equal(poet.chainHead, made[made.length - 1].hash);
});

test("serialize → restore round-trips the chain, the ordinal and the sitting laureate", async () => {
  const a = new Poet(CFG);
  await drive(a, 3);
  const b = new Poet(CFG);
  b.restore(a.serialize());
  assert.equal(b.headSeq, a.headSeq);
  assert.equal(b.chainHead, a.chainHead);
  assert.deepEqual(b.currentLaureate(), a.currentLaureate());
  assert.equal(b.recent(3).map((e) => e.hash).join(), a.recent(3).map((e) => e.hash).join());
});

test("a corrupt stored blob restores an EMPTY chain (poems are forgotten, never thrown)", () => {
  const poet = new Poet(CFG);
  poet.restore("{ this is not json :::");
  assert.equal(poet.size, 0);
  assert.equal(poet.headSeq, 0);
  assert.equal(poet.chainHead, "");
  assert.equal(poet.latest(), null);
});

// ================= cold cron: best-effort, composes nothing =================

test("a cold cron (no live fly / no neural reading) composes nothing and never throws", async () => {
  const poet = new Poet(CFG);
  assert.equal(await poet.maybeCompose(ctx({ liveIds: [] })), null);
  assert.equal(await poet.maybeCompose(ctx({ readingOf: () => null })), null);
  assert.equal(poet.size, 0);
});

test("the ≈hourly cadence gates composition: an off-cadence cron in the same era writes nothing", async () => {
  const poet = new Poet({ cap: 64, minCrons: 60 });
  const first = await poet.maybeCompose(ctx({ cron: 10 }));
  assert.ok(first);
  // Same era, only 1 cron later ⇒ not due yet (minCrons=60), so no second poem.
  assert.equal(await poet.maybeCompose(ctx({ cron: 11 })), null);
  // 60 crons later ⇒ due by cadence.
  assert.ok(await poet.maybeCompose(ctx({ cron: 71 })));
});

// ================= laureate: a deterministic draw over the LIVING flies =================

test("selectLaureate is deterministic, always returns a living fly, and a new era can crown a successor", async () => {
  const head = "head0000000000000000000000000000000000";
  const a = await selectLaureate(1, head, LIVE_IDS);
  const b = await selectLaureate(1, head, LIVE_IDS);
  assert.equal(a, b);                                   // same (era, headHash, liveIds) ⇒ same fly
  assert.ok(a != null && LIVE_IDS.includes(a));         // only ever a living fly
  assert.equal(await selectLaureate(1, head, []), null); // no one alive ⇒ no laureate
  // The era ordinal feeds the draw, so across eras more than one fly wears the crown.
  const crowned = new Set<number>();
  for (let e = 1; e <= 24; e++) crowned.add((await selectLaureate(e, head, LIVE_IDS))!);
  assert.ok(crowned.size > 1, "a new era never re-crowns — the era ordinal is not feeding the draw");
  for (const id of crowned) assert.ok(LIVE_IDS.includes(id));
});

test("the Poet crowns a living fly and re-crowns when the era advances", async () => {
  const poet = new Poet(CFG);
  const first = (await poet.maybeCompose(ctx({ era: era({ era: 1 }) })))!;
  assert.ok(LIVE_IDS.includes(first.laureate.id));
  assert.equal(first.laureate.crownedEraSeq, 1);
  assert.deepEqual(poet.currentLaureate()!.id, first.laureate.id);
  const second = (await poet.maybeCompose(ctx({ cron: 2, era: era({ era: 2 }) })))!;
  assert.equal(second.laureate.crownedEraSeq, 2);       // a successor is crowned in the new era
  assert.ok(LIVE_IDS.includes(second.laureate.id));
});

// ================= NaN guards: a bad knob or a bad neural field never leaks =================

test("config falls back to defaults on malformed poet knobs (NaN never reaches the ring bound)", () => {
  const off = loadConfig(env());
  assert.equal(off.poet.enabled, false);                // dark-deploy default
  assert.equal(off.poet.cap, 64);
  assert.equal(off.poet.minCrons, 60);

  const on = loadConfig(env({ POET_ENABLED: "TRUE" }));  // case-insensitive
  assert.equal(on.poet.enabled, true);

  const junk = loadConfig(env({ POET_ENABLED: "true", POEMS_CAP: "abc", POET_MIN_CRONS: "xyz" }));
  assert.equal(junk.poet.cap, 64);                       // NaN ⇒ default
  assert.equal(junk.poet.minCrons, 60);
  assert.ok(Number.isFinite(junk.poet.cap) && Number.isFinite(junk.poet.minCrons));

  const clamped = loadConfig(env({ POEMS_CAP: "999999", POET_MIN_CRONS: "-5" }));
  assert.equal(clamped.poet.cap, 512);                   // clamped to the ceiling
  assert.equal(clamped.poet.minCrons, 1);                // clamped to the floor
});

test("quantizeNeural is NaN-safe: every integer is finite and in 0..255 even for a garbage reading", () => {
  const junk = reading(1, {
    arousal: NaN, turnBias: NaN, cohesion: NaN, wingbeat: NaN,
    rest: NaN, temperament: NaN, valence: NaN, heading: NaN,
    fingerprint: undefined as unknown as string,
  });
  const ints = quantizeNeural(junk, NaN);
  assert.equal(ints.length, 26);                         // 10 quantized scalars + 16 fingerprint nibbles
  for (const n of ints) {
    assert.ok(Number.isFinite(n), "a neural integer is not finite");
    assert.ok(Number.isInteger(n) && n >= 0 && n <= 255, `out of range: ${n}`);
  }
  // A clean reading is likewise all-finite and bounded.
  for (const n of quantizeNeural(reading(5), 73)) {
    assert.ok(Number.isInteger(n) && n >= 0 && n <= 255);
  }
});

test("a poem composed from a garbage reading is still a valid, replayable receipt", async () => {
  const poet = new Poet(CFG);
  const junkCtx = ctx({
    readingOf: (id) => reading(id, { arousal: NaN, valence: NaN, heading: NaN, fingerprint: "" }),
    temperature: NaN,
    totals: { volumeUsdc: NaN, count: NaN, liveAgents: NaN, gini: NaN },
    deathsDelta: NaN,
  });
  const entry = (await poet.maybeCompose(junkCtx))!;
  assert.ok(entry);
  assert.equal(replayCompose(entry).match, true);        // still byte-for-byte replayable
  assert.equal(await recomputePoemHash(entry), entry.hash);
  for (const n of entry.neuralInts) assert.ok(Number.isFinite(n));
  assert.ok(Number.isFinite(entry.chain.temperature) && Number.isFinite(entry.chain.gini));
});

// ================= semantic anchoring: the era's palette is law =================

test("a dark / plague age NEVER reaches for a bright (gold / song / light) word, whatever the weather", () => {
  const dark = era({ civPhase: "dark", eraShock: "PLAGERA" });
  // The most provocative on-chain weather: a HOT market, extreme inequality, burials and volume — the chain
  // nudges may only modulate domains the era ALREADY admits, so the bright domains stay at weight 0.
  const hot = chain({ regime: "HOT", temperature: 1, gini: 0.95, deathsDelta: 3, volumeUsdcDelta: 9, settlementsDelta: 4 });
  for (let s = 0; s < 300; s++) {
    const ints = Array.from({ length: 26 }, (_, k) => (s * 37 + k * 19 + 5) % 256);
    const { text } = compose(ints, dark, hot, { id: s });
    for (const t of tokens(text)) {
      assert.ok(!BRIGHT.has(t), `a dark/plague age reached for a bright word: "${t}" in:\n${text}`);
    }
  }
});

test("a golden / boom age DOES draw on the bright palette (the anchoring is a weighting, not a mute)", () => {
  const golden = era({ civPhase: "golden", eraShock: "BOOM" });
  let sawBright = false;
  for (let s = 0; s < 200 && !sawBright; s++) {
    const ints = Array.from({ length: 26 }, (_, k) => (s * 41 + k * 23 + 7) % 256);
    const { text } = compose(ints, golden, chain({ regime: "HOT" }), { id: s });
    sawBright = tokens(text).some((t) => BRIGHT.has(t));
  }
  assert.ok(sawBright, "a golden/boom age never used a bright word — the palette weighting is broken");
});

test("every domain in the lexicon has the same fixed width and the domain order is stable", () => {
  assert.equal(DOMAINS.length, 12);
  for (const d of DOMAINS) {
    assert.ok(Array.isArray(LEXICON[d]));
    assert.equal(LEXICON[d].length, 12, `domain ${d} is not 12 words`);
    assert.equal(new Set(LEXICON[d]).size, 12, `domain ${d} has duplicate words`);
  }
});

test("a composed poem is versioned + policy-stamped and carries its full published receipt", async () => {
  const poet = new Poet(CFG);
  const entry = (await drive(poet, 1))[0]!;
  assert.equal(entry.v, POET_VERSION);
  assert.equal(entry.policy, POET_POLICY);
  assert.equal(entry.seq, 1);
  assert.equal(entry.lines.length, 4);
  assert.equal(entry.text, entry.lines.join("\n"));
  assert.equal(entry.neural.id, entry.laureate.id);      // the receipt freezes the crowned fly's own read-out
  assert.ok(Array.isArray(entry.neuralInts) && entry.neuralInts.length === 26);
});
