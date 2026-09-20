// Chronicler tests — the deterministic historian is a PURE READ-OUT with a PROVABLE, no-LLM contract:
//   1. It emits history-making moments ONLY when the input crosses a stated threshold.
//   2. It is fully DETERMINISTIC: same sequence of ChronicleContext in → byte-identical entries out.
//   3. Every sentence RE-DERIVES from its public template + the entry's own tokens (the "not an LLM" proof).
//   4. Entries form a tamper-evident SHA-256 CHAIN; verifyChain() accepts a real history and rejects any edit.
//   5. chroniclerRulesHash() is a stable digest of the whole rule-set (the historian's "genome").
//   6. snapshot/restore round-trips cleanly (seq, trackers AND the running headHash survive an eviction).
//
// These tests do NOT reach into population / economy / D1 — the historian is decoupled via the
// ChronicleContext shape, so it can be reasoned about (and audited) entirely in isolation.

import test from "node:test";
import assert from "node:assert/strict";

import {
  Chronicler,
  renderTemplate,
  verifyChain,
  computeEntryHash,
  chroniclerRulesHash,
  entryHashInput,
  GENESIS_HASH,
  CHRONICLE_VERSION,
  type ChronicleContext,
  type ChronicleEntry,
} from "./chronicler.js";

/** A calm, empty baseline: a small COLD swarm with no economy yet. */
function ctx(over: Partial<ChronicleContext> = {}): ChronicleContext {
  return {
    tick: 0, ts: 1_700_000_000_000, temperature: 0.3, regime: "COLD",
    size: 24, states: {}, faps: {}, valence: 0, arousal: 0.2, cohesion: 0.5, rest: 0.6,
    settlements: 0, volumeUsdc: 0, gini: 0, richestId: null, poorestId: null,
    liveAgents: 24, meanBalanceUsdc: 0,
    ...over,
  };
}

function kinds(entries: ChronicleEntry[]): string[] { return entries.map((e) => e.kind); }

/** Drive a chronicler through a context sequence, collecting every emitted entry (oldest→newest). */
async function run(c: Chronicler, seq: ChronicleContext[]): Promise<ChronicleEntry[]> {
  const out: ChronicleEntry[] = [];
  for (const x of seq) out.push(...(await c.observe(x)));
  return out;
}

test("first observation writes Era I · the Awakening", async () => {
  const c = new Chronicler();
  const out = await c.observe(ctx({ tick: 1 }));
  assert.equal(out.length, 1);
  assert.equal(out[0].kind, "ERA_OPEN");
  assert.equal(out[0].era, 1);
  assert.equal(out[0].eraName, "the Awakening");
  assert.equal(out[0].severity, 3);
  assert.match(out[0].text, /Era I/);
  assert.match(out[0].text, /Awakening/);
});

test("a held regime shift eventually dawns a new era (ERA_MIN_RUN + ERA_MIN_AGE)", async () => {
  const c = new Chronicler();
  await c.observe(ctx({ tick: 1, regime: "COLD" }));
  const all: ChronicleEntry[] = [];
  for (let t = 2; t <= 15; t++) {
    all.push(...(await c.observe(ctx({ tick: t, regime: "HOT", temperature: 0.8 }))));
  }
  const shift = all.find((e) => e.kind === "ERA_SHIFT");
  assert.ok(shift, "expected an ERA_SHIFT after a sustained HOT regime");
  assert.equal(shift!.era, 2);
  assert.match(shift!.text, /Era II/);
});

test("FIRST_TRADE fires exactly once, on the transition from zero to non-zero settlements", async () => {
  const c = new Chronicler();
  await c.observe(ctx({ tick: 1 }));
  const a = await c.observe(ctx({ tick: 2, settlements: 1, volumeUsdc: 0.02 }));
  assert.ok(kinds(a).includes("FIRST_TRADE"));
  const b = await c.observe(ctx({ tick: 3, settlements: 2, volumeUsdc: 0.04 }));
  assert.ok(!kinds(b).includes("FIRST_TRADE"), "FIRST_TRADE must not repeat");
});

test("a fresh historian meeting a MATURE swarm seeds silently — no false 'first trade' / milestone", async () => {
  // The v2→v3 restart case: the DO's historian state was cleared but the economy already has 22k settlements.
  // It must open the record honestly and NOT re-announce a first trade / milestone it did not witness.
  const c = new Chronicler();
  const out = await c.observe(ctx({ tick: 22064, settlements: 22033, volumeUsdc: 39.65, size: 32, gini: 0.285 }));
  assert.deepEqual(kinds(out), ["ERA_OPEN"], "only the honest opening line; the already-happened past stays quiet");
  assert.match(out[0].text, /chronicle opens/, "the opening is framed as the record beginning, not a genesis");
  const more = await c.observe(ctx({ tick: 22065, settlements: 22040, volumeUsdc: 39.7, size: 32, gini: 0.285 }));
  assert.ok(!kinds(more).includes("FIRST_TRADE"), "first-trade tracker was seeded, so it never fires falsely");
  assert.ok(!kinds(more).includes("MILESTONE"), "milestone tracker seeded to 22; nothing until 23000");
});

test("MILESTONE fires when lifetime settlements cross a 1000x multiple", async () => {
  const c = new Chronicler();
  await c.observe(ctx({ tick: 1 }));
  const out = await c.observe(ctx({ tick: 2, settlements: 1000, volumeUsdc: 12 }));
  assert.ok(kinds(out).includes("MILESTONE"));
  const again = await c.observe(ctx({ tick: 3, settlements: 1500, volumeUsdc: 18 }));
  assert.ok(!kinds(again).includes("MILESTONE"), "no new milestone until we cross 2000");
  const next = await c.observe(ctx({ tick: 4, settlements: 2000, volumeUsdc: 25 }));
  assert.ok(kinds(next).includes("MILESTONE"));
});

test("BIRTH records a new all-time swarm size, respecting the two-cron cooldown", async () => {
  const c = new Chronicler();
  await c.observe(ctx({ tick: 1, size: 24 }));
  const b1 = await c.observe(ctx({ tick: 2, size: 25 }));
  assert.ok(kinds(b1).includes("BIRTH"));
  const b2 = await c.observe(ctx({ tick: 3, size: 26 }));
  assert.ok(!kinds(b2).includes("BIRTH"), "BIRTH must respect 2-cron cooldown");
  const b3 = await c.observe(ctx({ tick: 4, size: 27 }));
  assert.ok(kinds(b3).includes("BIRTH"), "BIRTH resumes after cooldown");
});

test("PANIC only fires in HOT with a high flight+retreat share, and is rate-limited", async () => {
  const c = new Chronicler();
  await c.observe(ctx({ tick: 1 }));
  const calm = await c.observe(ctx({ tick: 2, regime: "CALM", temperature: 0.55, size: 20, faps: { FLIGHT: 8, RETREAT: 2 } }));
  assert.ok(!kinds(calm).includes("PANIC"));
  const hot = await c.observe(ctx({ tick: 3, regime: "HOT", temperature: 0.85, size: 20, faps: { FLIGHT: 8, RETREAT: 4 } }));
  assert.ok(kinds(hot).includes("PANIC"));
  const next1 = await c.observe(ctx({ tick: 4, regime: "HOT", temperature: 0.85, size: 20, faps: { FLIGHT: 8, RETREAT: 4 } }));
  assert.ok(!kinds(next1).includes("PANIC"));
  const next2 = await c.observe(ctx({ tick: 5, regime: "HOT", temperature: 0.85, size: 20, faps: { FLIGHT: 8, RETREAT: 4 } }));
  assert.ok(!kinds(next2).includes("PANIC"));
  const next3 = await c.observe(ctx({ tick: 6, regime: "HOT", temperature: 0.85, size: 20, faps: { FLIGHT: 8, RETREAT: 4 } }));
  assert.ok(kinds(next3).includes("PANIC"), "PANIC may re-fire after 3-cron gap");
});

test("HUDDLE fires on a sustained COLD with most flies still; STORM on an extreme temperature peak", async () => {
  const c = new Chronicler();
  await c.observe(ctx({ tick: 1 }));
  const h = await c.observe(ctx({ tick: 2, regime: "COLD", temperature: 0.15, size: 20, faps: { HUDDLE: 8, REST: 5, HALT: 1 } }));
  assert.ok(kinds(h).includes("HUDDLE"));
  const s = await c.observe(ctx({ tick: 3, regime: "COLD", temperature: 0.98, size: 20 }));
  assert.ok(kinds(s).includes("STORM"));
});

test("RECORD_CONC requires a new all-time gini high of at least +0.02", async () => {
  const c = new Chronicler();
  await c.observe(ctx({ tick: 1 }));
  const r1 = await c.observe(ctx({ tick: 2, gini: 0.5, richestId: 3 }));
  assert.ok(kinds(r1).includes("RECORD_CONC"), "0.5 > 0 is a new high");
  const r2 = await c.observe(ctx({ tick: 3, gini: 0.51, richestId: 3 }));
  assert.ok(!kinds(r2).includes("RECORD_CONC"), "delta < 0.02 does not count");
  await c.observe(ctx({ tick: 4, gini: 0.55, richestId: 3 }));
  const r3 = await c.observe(ctx({ tick: 5, gini: 0.62, richestId: 3 }));
  assert.ok(kinds(r3).includes("RECORD_CONC"));
});

test("LEAD_CHANGE fires only when richestId actually flips, and names both flies", async () => {
  const c = new Chronicler();
  await c.observe(ctx({ tick: 1 }));
  const a = await c.observe(ctx({ tick: 2, richestId: 7 }));
  assert.ok(!kinds(a).includes("LEAD_CHANGE"), "null→7 is a seed, not a flip");
  const b = await c.observe(ctx({ tick: 3, richestId: 9 }));
  assert.ok(kinds(b).includes("LEAD_CHANGE"));
  const entry = b.find((e) => e.kind === "LEAD_CHANGE")!;
  assert.deepEqual(entry.actors.slice().sort((x, y) => x - y), [7, 9]);
  assert.match(entry.text, /#9/);
  assert.match(entry.text, /#7/);
});

test("the historian is deterministic: the same context sequence yields byte-identical entries", async () => {
  const seq: ChronicleContext[] = [
    ctx({ tick: 1 }),
    ctx({ tick: 2, regime: "HOT", temperature: 0.82, settlements: 1, volumeUsdc: 0.02, size: 20, faps: { FLIGHT: 10, RETREAT: 2 } }),
    ctx({ tick: 3, regime: "HOT", temperature: 0.83, settlements: 3, volumeUsdc: 0.06 }),
    ctx({ tick: 4, regime: "HOT", temperature: 0.98, settlements: 4, volumeUsdc: 0.08 }),
  ];
  const outA = await run(new Chronicler(), seq);
  const outB = await run(new Chronicler(), seq);
  assert.deepEqual(outA, outB);
  assert.ok(outA.length >= 2, "expected multiple deterministic entries for the same input");
});

test("snapshot + restore preserves seq and every monotonic tracker (no history rewrite on eviction)", async () => {
  const a = new Chronicler();
  await a.observe(ctx({ tick: 1 }));
  await a.observe(ctx({ tick: 2, settlements: 1, volumeUsdc: 0.01, richestId: 5, size: 30 }));
  await a.observe(ctx({ tick: 3, settlements: 1000, volumeUsdc: 12, gini: 0.5, richestId: 8, size: 32 }));
  const snap = a.snapshot();
  const b = new Chronicler();
  b.restore(snap as any);
  const cont = await b.observe(ctx({ tick: 4, settlements: 1001, volumeUsdc: 13, gini: 0.5, size: 32, richestId: 8 }));
  assert.ok(!kinds(cont).includes("FIRST_TRADE"), "restored state knows first-trade already happened");
  assert.ok(!kinds(cont).includes("MILESTONE"), "no new 1000x milestone crossed");
  assert.ok(!kinds(cont).includes("BIRTH"), "size 32 is not above max 32");
  const bigJump = await b.observe(ctx({ tick: 7, settlements: 2001, volumeUsdc: 25, size: 40, gini: 0.6 }));
  assert.ok(kinds(bigJump).includes("MILESTONE"));
  assert.ok(kinds(bigJump).includes("BIRTH"));
  assert.ok(kinds(bigJump).includes("RECORD_CONC"));
  assert.ok(bigJump.every((e) => e.seq > 3), "seq kept monotonic across restore");
});

// ------------------------------------------------------------------------------------------------------------
// The verification model — the reason a visitor can TRUST these words without trusting the server.
// ------------------------------------------------------------------------------------------------------------

test("every sentence re-derives byte-for-byte from renderTemplate(kind, tokens) — the not-an-LLM proof", async () => {
  const seq: ChronicleContext[] = [
    ctx({ tick: 1 }),
    ctx({ tick: 2, settlements: 1, volumeUsdc: 0.02, richestId: 5 }),
    ctx({ tick: 3, settlements: 1000, volumeUsdc: 12, gini: 0.5, richestId: 8 }),
    ctx({ tick: 4, regime: "HOT", temperature: 0.85, size: 20, faps: { FLIGHT: 8, RETREAT: 4 }, settlements: 1001, volumeUsdc: 13, gini: 0.5, richestId: 9 }),
    ctx({ tick: 5, regime: "HOT", temperature: 0.99, size: 21, faps: { FEED: 12 }, settlements: 2000, volumeUsdc: 30, gini: 0.5, richestId: 9 }),
  ];
  const out = await run(new Chronicler(), seq);
  assert.ok(out.length >= 5, "expected a rich chronicle to check");
  for (const e of out) {
    assert.equal(renderTemplate(e.kind, e.tokens), e.text, `${e.kind} text must regenerate exactly from its template + tokens`);
  }
});

test("a freshly-built history passes end-to-end chain verification, from GENESIS to the head", async () => {
  const seq: ChronicleContext[] = [
    ctx({ tick: 1 }),
    ctx({ tick: 2, settlements: 1, volumeUsdc: 0.02, richestId: 5 }),
    ctx({ tick: 3, settlements: 1000, volumeUsdc: 12, gini: 0.5 }),
    ctx({ tick: 4, size: 30, richestId: 9 }),
    ctx({ tick: 5, settlements: 2000, volumeUsdc: 30, gini: 0.6 }),
  ];
  const c = new Chronicler();
  const out = await run(c, seq);
  assert.equal(out[0].prevHash, GENESIS_HASH, "the founding line links to genesis");
  for (let i = 1; i < out.length; i++) {
    assert.equal(out[i].prevHash, out[i - 1].hash, `entry ${i} must link to its predecessor's hash`);
  }
  const v = await verifyChain(out);
  assert.equal(v.ok, true, "a genuine chronicle must verify: " + v.reason);
  assert.equal(v.brokenAt, -1);
  assert.equal(v.head, out[out.length - 1].hash);
  // eraInfo()'s published head must equal the chain's computed head.
  assert.equal(c.eraInfo().headHash, v.head);
});

test("editing a single WORD breaks the chain (the text is inside the hashed pre-image)", async () => {
  const out = await run(new Chronicler(), [
    ctx({ tick: 1 }),
    ctx({ tick: 2, settlements: 1, volumeUsdc: 0.02 }),
    ctx({ tick: 3, settlements: 1000, volumeUsdc: 12 }),
  ]);
  assert.equal((await verifyChain(out)).ok, true);
  // tamper: silently rewrite the served sentence without touching tokens or the hash.
  const tampered = out.map((e) => ({ ...e }));
  tampered[0].text = tampered[0].text.replace("Awakening", "Deception");
  const v = await verifyChain(tampered);
  assert.equal(v.ok, false);
  assert.equal(v.brokenAt, 0);
  assert.match(v.reason, /hash/i);
});

test("a forger who recomputes hashes still cannot fake a sentence the template cannot produce", async () => {
  const out = await run(new Chronicler(), [ctx({ tick: 1 })]);
  const forged = { ...out[0], text: "Totally made-up prose no template could emit." };
  // Recompute the hash so the chain linkage stays valid — a clever tamperer.
  forged.hash = await computeEntryHash(forged);
  const v = await verifyChain([forged]);
  assert.equal(v.ok, false);
  assert.equal(v.brokenAt, 0);
  assert.match(v.reason, /template/i, "the re-derivation check is the last line of defence");
});

test("removing the hash linkage is caught even when every sentence still re-derives", async () => {
  const out = await run(new Chronicler(), [
    ctx({ tick: 1 }),
    ctx({ tick: 2, settlements: 1, volumeUsdc: 0.02 }),
    ctx({ tick: 3, settlements: 1000, volumeUsdc: 12 }),
  ]);
  // tamper: splice out the middle entry, leaving the next one's prevHash pointing at a now-absent line.
  const spliced = [out[0], out[2]];
  const v = await verifyChain(spliced);
  assert.equal(v.ok, false);
  assert.equal(v.brokenAt, 1);
  assert.match(v.reason, /prev-hash/i);
});

test("an entry's hash commits to its own fields (recompute matches; a field edit diverges)", async () => {
  const out = await run(new Chronicler(), [ctx({ tick: 1, size: 40 })]);
  const e = out[0];
  assert.equal(await computeEntryHash(e), e.hash);
  // the hash input must include the chain-critical fields.
  const input = entryHashInput(e);
  assert.equal(input.prevHash, e.prevHash);
  assert.equal((input as any).tokens, e.tokens);
  const altered = { ...e, metrics: { ...e.metrics, size: 999 } };
  assert.notEqual(await computeEntryHash(altered), e.hash, "changing a committed field must change the hash");
});

test("chroniclerRulesHash is a stable 64-hex digest (the historian's genome)", async () => {
  const h1 = await chroniclerRulesHash();
  const h2 = await chroniclerRulesHash();
  assert.match(h1, /^[0-9a-f]{64}$/);
  assert.equal(h1, h2, "the rule-set fingerprint must be pure/stable");
});

test("snapshot + restore also carries the running headHash (chain survives an eviction)", async () => {
  const a = new Chronicler();
  await run(a, [
    ctx({ tick: 1 }),
    ctx({ tick: 2, settlements: 1, volumeUsdc: 0.02 }),
    ctx({ tick: 3, settlements: 1000, volumeUsdc: 12 }),
  ]);
  const headBefore = a.eraInfo().headHash;
  const b = new Chronicler();
  b.restore(a.snapshot() as any);
  assert.equal(b.eraInfo().headHash, headBefore);
  // continuing on the restored instance must extend the SAME chain, not restart it.
  const more = await b.observe(ctx({ tick: 4, settlements: 1001, volumeUsdc: 13, size: 30 }));
  if (more.length) assert.equal(more[0].prevHash, headBefore, "post-restore entry links to the restored head");
});

test("CHRONICLE_VERSION is exported as a positive integer (entry-shape contract)", () => {
  assert.equal(typeof CHRONICLE_VERSION, "number");
  assert.ok(CHRONICLE_VERSION >= 1);
});

// ---------- SOCIAL chronicles: feuds, alliances, betrayals, reputations ----------

const social = {
  topFeud: { a: 3, b: 7, score: -0.72 },
  topAlliance: { a: 5, b: 2, score: 0.64, trades: 12 },
  betrayal: { tick: 42, buyerId: 3, sellerId: 7, amountUsdc: 0.05 },
  deadbeat: { id: 3, kept: 4, broken: 9, score: -0.4 },
};

test("social signals emit BETRAYAL/FEUD/ALLIANCE/REPUTATION once each, straight from templates", async () => {
  const c = new Chronicler();
  await c.observe(ctx({ tick: 1 }));
  const out = await c.observe(ctx({ tick: 50, settlements: 10, social }));
  const k = kinds(out);
  for (const want of ["BETRAYAL", "FEUD", "ALLIANCE", "REPUTATION"]) {
    assert.ok(k.includes(want), `${want} announced`);
  }
  const text = (want: string) => out.find((e) => e.kind === want)!.text;
  assert.match(text("FEUD"), /Fly #3 will not trade with fly #7/);
  assert.match(text("BETRAYAL"), /grudge book/);
  assert.match(text("ALLIANCE"), /Fly #5 and fly #2 have settled 12 dealings/);
  assert.match(text("REPUTATION"), /fly #3 is known for 9 defaults against 4 kept settlements/);
  // every social sentence re-derives from its public template — the no-LLM contract extends to romances
  for (const e of out.filter((x) => ["FEUD", "ALLIANCE", "BETRAYAL", "REPUTATION"].includes(x.kind))) {
    assert.equal(renderTemplate(e.kind, e.tokens), e.text);
  }
});

test("an unchanged relationship landscape never repeats (a standing feud is announced once)", async () => {
  const c = new Chronicler();
  await c.observe(ctx({ tick: 1 }));
  await c.observe(ctx({ tick: 50, settlements: 10, social }));
  // same feud, same alliance, same betrayal tick, same deadbeat — far past every cooldown, still silent.
  const again = await c.observe(ctx({ tick: 400, settlements: 12, social }));
  assert.deepEqual(kinds(again), [], "no relationship has CHANGED ⇒ the historian stays quiet");
  // a NEW betrayal (different grudge-book tick) is news again once its cooldown has passed.
  const third = await c.observe(ctx({ tick: 401, settlements: 13, social: { ...social, betrayal: { ...social.betrayal, tick: 399 } } }));
  assert.deepEqual(kinds(third), ["BETRAYAL"], "only the fresh betrayal fires; the standing feud does not re-ignite");
});

test("contexts without social signals behave exactly as before (older callers unaffected)", async () => {
  const c = new Chronicler();
  const first = await c.observe(ctx({ tick: 1 }));
  assert.deepEqual(kinds(first), ["ERA_OPEN"]);
  const second = await c.observe(ctx({ tick: 2, settlements: 5, volumeUsdc: 0.1 }));
  assert.deepEqual(kinds(second), ["FIRST_TRADE"]);
});

test("a full social history passes in-browser-style verifyChain end to end", async () => {
  const c = new Chronicler();
  const all = await run(c, [
    ctx({ tick: 1 }),
    ctx({ tick: 50, settlements: 10, social }),
    ctx({ tick: 61, settlements: 11, social: { ...social, topFeud: { a: 8, b: 1, score: -0.9 } } }),
  ]);
  assert.ok(all.some((e) => e.kind === "FEUD" && e.actors.includes(8)), "the NEW feud (changed landscape) fires");
  const v = await verifyChain(all);
  assert.ok(v.ok, `chain over social entries intact: ${v.reason} @${v.brokenAt}`);
});
