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

// ================= DYNASTY: foundings, dominations, epitaphs =================
// Same contract as the social entries: each dynasty moment is landscape-triggered, told once, and every
// sentence must re-derive from its public template — including the epitaphs on the graves.

const dynasty = {
  founding: { houseId: 7, name: "Ochre", sigil: "\u2B22", founder: 7, childId: 30, tick: 40 },
  dominance: null,
  death: null,
};

test("HOUSE_FOUNDED is proclaimed once per house, from the template + the house's own name", async () => {
  const c = new Chronicler();
  await c.observe(ctx({ tick: 1 }));
  const out = await c.observe(ctx({ tick: 41, settlements: 5, dynasty }));
  const f = out.find((e) => e.kind === "HOUSE_FOUNDED");
  assert.ok(f, "the founding is announced");
  assert.match(f!.text, /Fly #7 founds the House of Ochre/);
  assert.deepEqual(f!.actors, [7, 30], "founder and first heir star in the entry");
  assert.equal(renderTemplate("HOUSE_FOUNDED", f!.tokens), f!.text);
  // The SAME standing house on later crons is not news again (key dedup), far past the cooldown.
  const again = await c.observe(ctx({ tick: 400, settlements: 6, dynasty }));
  assert.ok(!kinds(again).includes("HOUSE_FOUNDED"), "a house already proclaimed stays proclaimed");
  // A DIFFERENT house founding is a new chapter.
  const second = await c.observe(ctx({ tick: 401, settlements: 7, dynasty: { ...dynasty, founding: { ...dynasty.founding!, houseId: 9, founder: 9, childId: 31 } } }));
  assert.ok(kinds(second).includes("HOUSE_FOUNDED"), "the second house gets its own line");
});

test("DYNASTY sounds only when a house holds the swarm's capital — and re-sounds at a new generation", async () => {
  const c = new Chronicler();
  await c.observe(ctx({ tick: 1 }));
  const dom = { id: 7, name: "Ochre", sigil: "\u2B22", capitalShare: 0.22, gen: 6 };
  const out = await c.observe(ctx({ tick: 20, settlements: 5, dynasty: { founding: null, dominance: dom, death: null } }));
  const d = out.find((e) => e.kind === "DYNASTY");
  assert.ok(d, "dominance is announced");
  assert.match(d!.text, /holds 22% of all the swarm's capital at generation 6/);
  assert.equal(renderTemplate("DYNASTY", d!.tokens), d!.text);
  const same = await c.observe(ctx({ tick: 200, settlements: 6, dynasty: { founding: null, dominance: dom, death: null } }));
  assert.ok(!kinds(same).includes("DYNASTY"), "the same house at the same generation is not fresh news");
  const rose = await c.observe(ctx({ tick: 201, settlements: 7, dynasty: { founding: null, dominance: { ...dom, gen: 7 }, death: null } }));
  assert.ok(kinds(rose).includes("DYNASTY"), "a generational high under the same name is a new chapter");
});

test("ELEGY carves an epitaph per burial — cause, dealings, estate and heirs all from the grave record", async () => {
  const c = new Chronicler();
  await c.observe(ctx({ tick: 1 }));
  const death = { id: 3, tick: 11, cause: "penury", deals: 4207, age: 99999, estateUsdc: 1.5, heirIds: [12, 13], houseName: "Ochre" };
  const out = await c.observe(ctx({ tick: 12, settlements: 5, dynasty: { founding: null, dominance: null, death } }));
  const e = out.find((x) => x.kind === "ELEGY");
  assert.ok(e, "the falling is mourned");
  assert.match(e!.text, /Fly #3 of the House of Ochre falls to penury — 4207 dealings/);
  assert.match(e!.text, /estate of 1\.5 USDC passes to #12, #13/);
  assert.match(e!.text, /The name endures\./);
  assert.equal(renderTemplate("ELEGY", e!.tokens), e!.text);
  // The same grave on a later cron is not re-mourned (the burial tick was already told).
  const again = await c.observe(ctx({ tick: 90, settlements: 6, dynasty: { founding: null, dominance: null, death } }));
  assert.ok(!kinds(again).includes("ELEGY"), "one grave, one epitaph");
  // A plague death with no named heirs reads "the plague" and "the commons".
  const plague = await c.observe(ctx({ tick: 91, settlements: 7, dynasty: { founding: null, dominance: null, death: { ...death, tick: 90, cause: "plague", heirIds: [], houseName: null } } }));
  const p = plague.find((x) => x.kind === "ELEGY")!;
  assert.match(p.text, /Fly #3 of no house falls to the plague/);
  assert.match(p.text, /passes to the commons/);
});

test("a full dynasty history passes in-browser-style verifyChain end to end", async () => {
  const c = new Chronicler();
  const all = await run(c, [
    ctx({ tick: 1 }),
    ctx({ tick: 41, settlements: 5, dynasty }),
    ctx({ tick: 42, settlements: 6, dynasty: { ...dynasty, dominance: { id: 7, name: "Ochre", sigil: "\u2B22", capitalShare: 0.19, gen: 2 }, death: { id: 4, tick: 42, cause: "aged", deals: 10, age: 400, estateUsdc: 0.25, heirIds: [30], houseName: "Ochre" } } }),
  ]);
  assert.deepEqual(
    all.filter((e) => ["HOUSE_FOUNDED", "DYNASTY", "ELEGY"].includes(e.kind)).map((e) => e.kind).sort(),
    ["DYNASTY", "ELEGY", "HOUSE_FOUNDED"],
  );
  const v = await verifyChain(all);
  assert.ok(v.ok, `chain over dynasty entries intact: ${v.reason} @${v.brokenAt}`);
});

test("contexts without dynasty signals behave exactly as before (older callers unaffected)", async () => {
  const c = new Chronicler();
  await c.observe(ctx({ tick: 1 }));
  const out = await c.observe(ctx({ tick: 2, settlements: 3, social }));
  assert.ok(!kinds(out).some((k) => ["HOUSE_FOUNDED", "DYNASTY", "ELEGY"].includes(k)), "no dynasty ctx ⇒ no dynasty lines");
});

// ================= ⑦ EPOCHS: shock detector force-opens an era (pure read-out, never feeds back) =================
// A shock closes the current era with a retrospective line and dawns a NEW, shock-named age at severity 5.
// The spontaneous (fly-side) detector and the governance-injection path share ONE forcing entry, differing
// only in the source tag. SHOCK_COOLDOWN (200 crons) keeps the calendar from flooding, and EPOCHS-OFF
// restores today's slow regime drift byte-for-byte (not a single EPOCH line may appear).

test("a one-cron volume record while wealth concentrates forces a BOOM epoch (the Gilding)", async () => {
  const c = new Chronicler();
  await c.observe(ctx({ tick: 1, volumeUsdc: 0.01 }));            // init seeds the volume/gini baselines
  const out = await c.observe(ctx({ tick: 2, volumeUsdc: 5, gini: 0.3 })); // a genuine one-cron record + rising gini
  const close = out.find((e) => e.kind === "EPOCH_CLOSE");
  const open = out.find((e) => e.kind === "EPOCH_OPEN");
  assert.ok(close && open, "the old era closes and a shock era opens");
  assert.equal(close!.era, 1, "the CLOSE line still names the outgoing era");
  assert.match(close!.text, /closes Era I · the Awakening/);
  assert.equal(open!.era, 2, "the forced epoch advanced the era counter");
  assert.equal(open!.severity, 5, "a shock is the loudest kind of line");
  assert.equal(open!.eraName, "the Gilding", "the new age is named for the shock kind");
  assert.match(open!.text, /Era II · the Gilding — BOOM falls upon the swarm\./);
  assert.ok(!/willed by the commons/.test(open!.text), "a spontaneous shock carries no human-source tag");
  const info = c.eraInfo();
  assert.equal(info.era, 2);
  assert.equal(info.eraShock, "BOOM");
  assert.equal(info.eraShockWilled, false);
  // re-derivation + chain hold across the new kinds too.
  for (const e of [close!, open!]) assert.equal(renderTemplate(e.kind, e.tokens), e.text);
});

test("a governance-injected shock dawns the SAME kind of epoch, tagged 'willed by the commons'", async () => {
  const c = new Chronicler();
  await c.observe(ctx({ tick: 1 }));
  const out = await c.observe(ctx({ tick: 2, governanceShock: { kind: "PLAGERA", actor: 7 } }));
  const open = out.find((e) => e.kind === "EPOCH_OPEN")!;
  assert.ok(open, "the passed miracle/cataclysm forces an epoch through the ONE shared entry");
  assert.equal(open.eraName, "the Rot");
  assert.deepEqual(open.actors, [7], "the proposing citizen is named on the line");
  assert.match(open.text, /PLAGERA falls upon the swarm, willed by the commons\./);
  assert.equal(open.metrics.willed, 1);
  const info = c.eraInfo();
  assert.equal(info.eraShock, "PLAGERA");
  assert.equal(info.eraShockWilled, true, "the UI badge reads the source from eraInfo()");
  assert.equal(renderTemplate("EPOCH_OPEN", open.tokens), open.text);
});

test("a sustained signal-food drought (richness < 0.18) dawns the Famine after 45 crons", async () => {
  const c = new Chronicler();
  await c.observe(ctx({ tick: 1, richness: 0.1 }));                 // init: the famine counter stays at 0
  let fired: ChronicleEntry | null = null;
  let firedAt = 0;
  for (let t = 2; t <= 60 && !fired; t++) {
    const out = await c.observe(ctx({ tick: t, richness: 0.1 }));   // the drought holds cron after cron
    const open = out.find((e) => e.kind === "EPOCH_OPEN");
    if (open) { fired = open; firedAt = t; }
  }
  assert.ok(fired, "the long famine eventually forces an epoch");
  assert.equal(firedAt, 46, "FAMINE needs exactly 45 consecutive drought crons (tick 2..46)");
  assert.equal(fired!.eraName, "the Famine");
  assert.equal(c.eraInfo().eraShock, "FAMINE");
});

test("SHOCK_COOLDOWN (200 crons) stops one shock from spamming the calendar", async () => {
  const c = new Chronicler();
  await c.observe(ctx({ tick: 1 }));
  const first = await c.observe(ctx({ tick: 2, volumeUsdc: 5, gini: 0.3 }));      // BOOM #1
  assert.ok(kinds(first).includes("EPOCH_OPEN"), "the first shock dawns an epoch");
  const second = await c.observe(ctx({ tick: 3, volumeUsdc: 10, gini: 0.4 }));    // record again, one cron later
  assert.ok(!kinds(second).includes("EPOCH_OPEN"), "a fresh record inside the cooldown must NOT re-crown an era");
  assert.ok(c.eraInfo().eraShock === "BOOM", "the era is still the first forced one");
});

test("EPOCHS OFF: the very shock that would force an epoch stays silent (byte-for-byte today's era logic)", async () => {
  const c = new Chronicler(false);                                   // epochsEnabled = false
  await c.observe(ctx({ tick: 1 }));
  const out = await c.observe(ctx({ tick: 2, volumeUsdc: 5, gini: 0.3, governanceShock: { kind: "PLAGERA" } }));
  assert.ok(!kinds(out).some((k) => k === "EPOCH_OPEN" || k === "EPOCH_CLOSE"),
    "with epochs off neither the spontaneous detector nor a governance injection may force an era");
  assert.equal(c.eraInfo().era, 1, "the era counter never moved");
  assert.equal(c.eraInfo().eraShock, null, "no shock is remembered");
});

test("a full shock-epoch history passes in-browser-style verifyChain end to end", async () => {
  const c = new Chronicler();
  const all = await run(c, [
    ctx({ tick: 1 }),
    ctx({ tick: 2, settlements: 1, volumeUsdc: 5, gini: 0.3 }),   // spontaneous BOOM epoch
    ctx({ tick: 3, settlements: 1000, volumeUsdc: 5.1 }),          // a milestone, but inside the epoch cooldown
  ]);
  const epochKinds = all.filter((e) => e.kind === "EPOCH_OPEN" || e.kind === "EPOCH_CLOSE").map((e) => e.kind);
  assert.deepEqual(epochKinds, ["EPOCH_CLOSE", "EPOCH_OPEN"],
    "exactly one close-then-open from the single BOOM; the cooldown holds the next one off");
  assert.equal(c.eraInfo().era, 2, "one forced epoch dawned (Era I → II)");
  assert.ok(all.some((e) => e.kind === "MILESTONE"), "an ordinary milestone still rides the same chain");
  const v = await verifyChain(all);
  assert.ok(v.ok, `chain over epoch entries intact: ${v.reason} @${v.brokenAt}`);
});

// ================= ⑤ CULTURE + ⑥ INSTITUTIONS narrative kinds (landscape read-outs, told once) =================
// TREND/TRADITION ride the culture membrane's signals; MARKET_SHIFT/CREDIT/RUN/CLASS ride the economy's
// market read-out. Each is a landscape detector (fire on a CHANGE, deduped by key/edge + a cooldown), and
// every sentence still re-derives from its public template. No `culture`/`market` in the context ⇒ silent.

function marketOver(over: Record<string, unknown> = {}) {
  return {
    marks: { signal: 0.01 }, openIous: 0, topIou: null, run: false,
    badRate: 0, creditors: 0, creditorNetShare: 0, ...over,
  };
}

test("⑤ TREND and TRADITION are proclaimed from the culture signals, once per landscape change", async () => {
  const c = new Chronicler();
  const out = await c.observe(ctx({
    tick: 1,
    culture: {
      trend: { fap: "FEED", adherents: 8, share: 0.33 },
      tradition: { houseId: 7, name: "Ochre", sigil: "\u2726", fap: "FORAGE", streak: 9 },
    },
  }));
  const tr = out.find((e) => e.kind === "TREND");
  const td = out.find((e) => e.kind === "TRADITION");
  assert.ok(tr && td, "a sweeping fashion and a held tradition both make the record");
  assert.match(tr!.text, /A custom sweeps the swarm — 8 flies take to FEED at once, one mood carrying 33% of the market\./);
  assert.match(td!.text, /The House of Ochre keeps the old way — FORAGE, held by its kindred for 9 crons against the passing fashion\./);
  for (const e of [tr!, td!]) assert.equal(renderTemplate(e.kind, e.tokens), e.text);
  // The SAME creed leading, and the SAME house+creed tradition, are not news again next cron.
  const again = await c.observe(ctx({
    tick: 2,
    culture: {
      trend: { fap: "FEED", adherents: 9, share: 0.35 },
      tradition: { houseId: 7, name: "Ochre", sigil: "\u2726", fap: "FORAGE", streak: 10 },
    },
  }));
  assert.ok(!kinds(again).includes("TREND"), "the same fashion does not re-sweep");
  assert.ok(!kinds(again).includes("TRADITION"), "the same house+creed is already told");
  // A DIFFERENT creed seizing the swarm (past TREND's 8-cron cooldown) is a new chapter.
  const shift = await c.observe(ctx({ tick: 12, culture: { trend: { fap: "GROOM", adherents: 10, share: 0.4 }, tradition: null } }));
  assert.ok(kinds(shift).includes("TREND"), "a different creed at the head of the swarm is news");
});

test("⑥ the market's drama — MARKET_SHIFT, CREDIT, RUN and CLASS each read off the tape and ledger", async () => {
  const c = new Chronicler();
  await c.observe(ctx({ tick: 1, market: marketOver() }));            // primes the mark tape, no move yet
  // MARKET_SHIFT: signal jumps +40% in a single cron (a first-cron mark only primes, so this is the real break).
  const ms = (await c.observe(ctx({ tick: 2, market: marketOver({ marks: { signal: 0.014 } }) })))
    .find((e) => e.kind === "MARKET_SHIFT")!;
  assert.ok(ms, "a one-cron +40% move is a market shift");
  assert.match(ms.text, /signal moves \+40% in a single breath to 0\.014 USDC; the market's mind has changed\./);
  assert.equal(renderTemplate("MARKET_SHIFT", ms.tokens), ms.text);
  // CREDIT: a fresh, weighty promise appears (open-IOU count grew, largest note ≥ the floor).
  const cr = (await c.observe(ctx({ tick: 12, market: marketOver({ marks: { signal: 0.014 }, openIous: 3, topIou: { debtor: 4, creditor: 9, amountUsdc: 0.05 } }) })))
    .find((e) => e.kind === "CREDIT")!;
  assert.ok(cr, "the first consequential promise is recorded");
  assert.match(cr.text, /fly #4 owes fly #9 0\.05 USDC/);
  assert.deepEqual(cr.actors, [4, 9]);
  // RUN: a live credit panic announced on its false→true edge — the economy's loudest event (severity 4).
  const rn = (await c.observe(ctx({ tick: 20, market: marketOver({ marks: { signal: 0.014 }, openIous: 6, run: true, badRate: 0.4, creditors: 5 }) })))
    .find((e) => e.kind === "RUN")!;
  assert.ok(rn, "a run on credit breaks");
  assert.equal(rn.severity, 4);
  assert.match(rn.text, /5 creditors call, 40% of the paper is overdue, the spreads double\./);
  // CLASS: the creditor purse grips >15% of net capital — a chapter, told once.
  const cl = (await c.observe(ctx({ tick: 30, market: marketOver({ marks: { signal: 0.014 }, creditorNetShare: 0.22 }) })))
    .find((e) => e.kind === "CLASS")!;
  assert.ok(cl, "a class gripping capital enters history");
  assert.match(cl.text, /creditor purse now grips 22% of the swarm's whole net capital\./);
  const later = await c.observe(ctx({ tick: 400, market: marketOver({ marks: { signal: 0.014 }, creditorNetShare: 0.4 }) }));
  assert.ok(!kinds(later).includes("CLASS"), "the class chapter is told once, not censused every cron");
});

test("contexts with no culture/market read-out narrate none of the ⑤⑥ lines (byte-for-byte older chronicle)", async () => {
  const c = new Chronicler();
  await c.observe(ctx({ tick: 1 }));
  const out = await c.observe(ctx({ tick: 2, settlements: 3, volumeUsdc: 0.01 }));
  assert.ok(!kinds(out).some((k) => ["TREND", "TRADITION", "MARKET_SHIFT", "CREDIT", "RUN", "CLASS"].includes(k)),
    "no culture/market in the context ⇒ those detectors never speak");
});

test("a culture-and-market history passes in-browser-style verifyChain end to end", async () => {
  const c = new Chronicler();
  const all = await run(c, [
    ctx({ tick: 1, culture: { trend: { fap: "FEED", adherents: 8, share: 0.33 }, tradition: null }, market: marketOver() }),
    ctx({ tick: 2, culture: { trend: { fap: "FEED", adherents: 8, share: 0.33 }, tradition: null }, market: marketOver({ marks: { signal: 0.02 }, openIous: 2, topIou: { debtor: 1, creditor: 2, amountUsdc: 0.03 } }) }),
    ctx({ tick: 30, market: marketOver({ marks: { signal: 0.02 }, creditorNetShare: 0.3 }) }),
  ]);
  assert.ok(all.some((e) => e.kind === "TREND"), "trend line present");
  assert.ok(all.some((e) => e.kind === "MARKET_SHIFT"), "shift line present");
  assert.ok(all.some((e) => e.kind === "CLASS"), "class line present");
  const v = await verifyChain(all);
  assert.ok(v.ok, `chain over culture/market entries intact: ${v.reason} @${v.brokenAt}`);
});

// ================= ⑧ THE COMMONS narrative kinds (a seated council + the law it writes, told once) ==========
// ASSEMBLY/DECREE ride the commons read-out (state.ts folds `commons` when LAW_ENABLED + institutions +
// economy are all on). Both are landscape detectors: one council per seated era, one law per (knob, era),
// deduped by the era/param trackers + a cooldown, and every sentence still re-derives from its template.
// No `commons` in the context (LAW off) or a zero seatedEra (no council yet) ⇒ the whole block stays silent.

test("⑧ the commons legislates into the chronicle — an ASSEMBLY and per-knob DECREEs, each told once per era", async () => {
  const c = new Chronicler();
  await c.observe(ctx({ tick: 1 }));
  const a = await c.observe(ctx({ tick: 2, commons: { seatedEra: 1, seats: 7, decrees: [{ param: "creditCap", target: 0.02 }] } }));
  const asb = a.find((e) => e.kind === "ASSEMBLY")!;
  assert.ok(asb, "a council seated for an era opens a chapter");
  assert.match(asb.text, /A commons sits in Era I — 7 of the swarm's honoured and propertied take the seats/);
  assert.equal(renderTemplate("ASSEMBLY", asb.tokens), asb.text);
  const dec = a.find((e) => e.kind === "DECREE")!;
  assert.ok(dec, "the knob it settles is written into the record");
  assert.equal(dec.severity, 3);
  assert.match(dec.text, /The commons decrees in Era I: the base credit line shall stand at 0\.02\./);
  assert.equal(renderTemplate("DECREE", dec.tokens), dec.text);

  // Same era, next cron: neither the council nor the already-told knob repeats.
  const b = await c.observe(ctx({ tick: 3, commons: { seatedEra: 1, seats: 7, decrees: [{ param: "creditCap", target: 0.02 }] } }));
  assert.ok(!kinds(b).includes("ASSEMBLY"), "one council per era");
  assert.ok(!kinds(b).includes("DECREE"), "creditCap was already decreed this era");
  // A DIFFERENT knob settling (past DECREE's 6-cron cooldown) is a fresh chapter in the same era.
  const cdec = await c.observe(ctx({ tick: 9, commons: { seatedEra: 1, seats: 7, decrees: [{ param: "creditCap", target: 0.02 }, { param: "iouRate", target: 0.05 }] } }));
  assert.ok(!kinds(cdec).includes("ASSEMBLY"), "the era's council is already seated");
  const rate = cdec.find((e) => e.kind === "DECREE")!;
  assert.ok(rate, "the second knob's law is news");
  assert.match(rate.text, /the rate of interest shall stand at 0\.05\./);

  // A NEW seated era convenes a NEW council.
  const d = await c.observe(ctx({ tick: 30, commons: { seatedEra: 2, seats: 7, decrees: [] } }));
  assert.ok(kinds(d).includes("ASSEMBLY"), "a new seatedEra is a new assembly");
});

test("contexts with no commons (or an unseated era 0) narrate none of the ⑧ lines (byte-for-byte older chronicle)", async () => {
  const c = new Chronicler();
  await c.observe(ctx({ tick: 1 }));
  const o1 = await c.observe(ctx({ tick: 2, settlements: 3, volumeUsdc: 0.01 }));
  assert.ok(!kinds(o1).some((k) => ["ASSEMBLY", "DECREE"].includes(k)), "no commons in the context ⇒ those detectors never speak");
  const o2 = await c.observe(ctx({ tick: 3, commons: { seatedEra: 0, seats: 0, decrees: [] } }));
  assert.ok(!kinds(o2).some((k) => ["ASSEMBLY", "DECREE"].includes(k)), "an unseated commons (era 0) stays silent");
});

test("a commons history passes in-browser-style verifyChain end to end", async () => {
  const c = new Chronicler();
  const all = await run(c, [
    ctx({ tick: 1 }),
    ctx({ tick: 2, commons: { seatedEra: 1, seats: 7, decrees: [{ param: "creditCap", target: 0.02 }] } }),
    ctx({ tick: 30, commons: { seatedEra: 2, seats: 7, decrees: [{ param: "iouRate", target: 0.05 }] } }),
  ]);
  assert.ok(all.some((e) => e.kind === "ASSEMBLY"), "assembly line present");
  assert.ok(all.some((e) => e.kind === "DECREE"), "decree line present");
  const v = await verifyChain(all);
  assert.ok(v.ok, `chain over commons entries intact: ${v.reason} @${v.brokenAt}`);
});

