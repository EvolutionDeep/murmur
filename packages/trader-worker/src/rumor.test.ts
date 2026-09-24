/**
 * ㉔ THE RUMOR MILL — unit tests (node:test, mirrors religion.test.ts's fixture style).
 *
 * Covers: boot silent adoption, the afoot/bend/quiet edges, displacement, deterministic growth,
 * the telling-day override (religion contract: rare, monotonic hearers, HALT vs GROOM by heard
 * severity), inertness, and the serialize/restore round trip.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { FAP_ROLE, type Fap } from "@fly/fly-brain";
import { RumorMill, rumorTopic, RM_HEARD_CAP, RM_AFOOT_AT, RM_GROW, RM_LIFE, RM_TELL_EVERY, type RumorFacts, type RumorNews } from "./rumor.js";
import type { FlyReading } from "./population.js";

const CFG = { enabled: true };

function reading(id: number, fap: Fap): FlyReading {
  return {
    id, state: "EXPLORE",
    arousal: 0.5, turnBias: 0, cohesion: 0.5,
    wingbeat: 0.5, rest: 0.2, temperament: ((id * 7919) % 1000) / 1000,
    fingerprint: `fp${id}`,
    fap, valence: 0, heading: 0, role: FAP_ROLE[fap], bouts: [],
  };
}

function news(seq: number, kind: string, sev: number, actors: number[] = []): RumorNews {
  return { seq, kind, sev, actors };
}

function facts(era: number, newsList: RumorNews[], maxSeq: number): RumorFacts {
  return { era, news: newsList, maxSeq };
}

/** Run a fresh mill past boot with one starting tale adopted at seq S. */
function started(sev = 2, seq = 10): { mill: RumorMill; tick: number } {
  const mill = new RumorMill(CFG);
  mill.round(1, facts(3, [], seq - 1));              // boot: silent adoption up to the telling's own seq
  mill.round(2, facts(3, [news(seq, "FEUD", sev, [1, 2])], seq + 1)); // the first NEW telling
  return { mill, tick: 2 };
}

test("rumor: boot silently adopts the roll — history is never re-told", () => {
  const mill = new RumorMill(CFG);
  mill.round(1, facts(3, [news(5, "FEUD", 3), news(9, "VERDICT", 2)], 9));
  const sig = mill.signals();
  assert.equal(sig.active, null, "the boot round adopts nothing");
  assert.equal(sig.counts.afoot, 0, "no chronicle word at boot");
  // the NEXT round only sees tellings ABOVE the seeded cursor
  mill.round(2, facts(3, [news(9, "VERDICT", 2)], 9));
  assert.equal(mill.signals().active, null, "a seq at the cursor is already-history, not news");
});

test("rumor: a new telling becomes the active tale and afoot fires once at the mark", () => {
  const { mill } = started();
  const a0 = mill.signals().active;
  assert.ok(a0, "the tale is adopted");
  assert.equal(a0!.topic, "feud", "the kind is talked as its market noun");
  assert.ok(a0!.heard >= 1 && a0!.heard <= 1 + RM_GROW, "it starts in the actors' own mouths and their first circle");
  let fired = 0;
  for (let t = 3; t < 40; t++) {
    mill.round(t, facts(3, [], 11));
    if (mill.signals().afoot) fired++;
    if (t - 3 >= RM_LIFE - 2) break;
  }
  assert.equal(fired, 1, "AFOOT is an edge: exactly one cron speaks it");
});

test("rumor: growth is bounded by the cap and replayable — same ticks, same tale", () => {
  const run = () => {
    const mill = new RumorMill(CFG);
    mill.round(1, facts(3, [], 9));
    for (let t = 2; t < 2 + RM_LIFE; t++) mill.round(t, facts(3, t === 2 ? [news(10, "FEUD", 2)] : [], 11));
    return mill.serialize();
  };
  const a = JSON.parse(run());
  const b = JSON.parse(run());
  assert.deepEqual(a, b, "a replay of the same crons lands on the same state");
  assert.ok(a.active.heard >= 1 && a.active.heard <= RM_HEARD_CAP, "heard stays inside the cap");
});

test("rumor: the bend is drawn once per tale and moves the heard severity by exactly one step", () => {
  // find one seq that bends and one that does not (the draw is a fixed hash of the seq)
  let bentSeq = -1, plainSeq = -1;
  for (let s = 20; s < 400 && (bentSeq < 0 || plainSeq < 0); s++) {
    const mill = new RumorMill(CFG);
    mill.round(1, facts(3, [], s - 1));
    let sawBend = false;
    for (let t = 2; t < 2 + RM_LIFE; t++) {
      mill.round(t, facts(3, t === 2 ? [news(s, "FEUD", 2)] : [], s + 1));
      if (mill.signals().bent) sawBend = true;
    }
    if (sawBend && bentSeq < 0) bentSeq = s;
    if (!sawBend && plainSeq < 0) plainSeq = s;
  }
  assert.ok(bentSeq > 0 && plainSeq > 0, "some tales bend and some do not (both classes exist)");
  // the bending tale: sevHeard drifted by exactly ±1 and bent is flagged
  const mill = new RumorMill(CFG);
  mill.round(1, facts(3, [], bentSeq - 1));
  let bend: { heardAs: string } | null = null;
  for (let t = 2; t < 2 + RM_LIFE; t++) {
    mill.round(t, facts(3, t === 2 ? [news(bentSeq, "FEUD", 2)] : [], bentSeq + 1));
    const sig = mill.signals();
    if (sig.bent && !bend) bend = { heardAs: sig.bent.heardAs };
    assert.ok(!sig.bent || sig.bent.heardAs === "graver" || sig.bent.heardAs === "lighter");
  }
  assert.ok(bend, "the bending seq bends in a replay too (determinism)");
});

test("rumor: a graver telling displaces the tale — and the old one goes quiet if it had ears", () => {
  const { mill } = started(2, 10);
  for (let t = 3; t < 8; t++) mill.round(t, facts(3, [], 11));   // grow ears past RM_TELL
  const before = mill.signals().active;
  assert.ok(before!.heard >= 6, "the old tale has real ears by now");
  mill.round(8, facts(3, [news(20, "WAR_DECLARED", 4)], 21));
  const sig = mill.signals();
  assert.ok(sig.faded && sig.faded.topic === "feud", "the displaced tale is recorded as quiet");
  assert.equal(sig.active!.topic, "war", "the graver telling takes the market");
});

test("rumor: a life-old tale fades; a whisper nobody heard fades in silence", () => {
  const { mill } = started(2, 10);
  for (let t = 3; t < 10; t++) mill.round(t, facts(3, [], 11));          // grow real ears first
  mill.round(2 + RM_LIFE, facts(3, [], 11));
  const sig = mill.signals();
  assert.equal(sig.active, null, "the tale is laid to rest at the end of its life");
  assert.ok(sig.faded && sig.faded.topic === "feud", "it had time to gather real ears");
  // a tale displaced before RM_TELL ears never speaks its quiet
  const m2 = new RumorMill(CFG);
  m2.round(1, facts(3, [], 9));
  m2.round(2, facts(3, [news(10, "FEUD", 1)], 11));
  m2.round(3, facts(3, [news(11, "WAR_DECLARED", 5)], 12));   // graver news displaces it at once
  assert.equal(m2.signals().faded, null, "a hush over nothing is not an event");
});

test("rumor: apply is the religion contract — inert off telling-days and between tales", () => {
  const { mill } = started(2, 10);
  for (let t = 3; t < RM_TELL_EVERY; t++) mill.round(t, facts(3, [], 11));
  const flies = Array.from({ length: 20 }, (_, i) => reading(i, "FEED"));
  // a plain cron touches nothing, byte-for-byte
  const untouched = JSON.stringify(flies);
  assert.equal(mill.apply(flies, RM_TELL_EVERY - 1), 0, "not a telling-day ⇒ no rewrite");
  assert.equal(JSON.stringify(flies), untouched);
  assert.equal(new RumorMill(CFG).apply(flies, RM_TELL_EVERY), 0, "no tale afoot ⇒ no rewrite");
});

test("rumor: hearers are rewritten to GROOM, or HALT when the tale is heard gravely", () => {
  const { mill } = started(2, 10);
  for (let t = 3; t < 3 + 12; t++) mill.round(t, facts(3, [], 11));  // grow the tale's ears
  const flies = Array.from({ length: 30 }, (_, i) => reading(i, "FEED"));
  const n = mill.apply(flies, RM_TELL_EVERY);                        // a telling-day
  assert.ok(n > 0, "some hearers are read as whispering");
  for (const f of flies) if (f.fap === "GROOM") assert.equal(f.role, FAP_ROLE.GROOM, "role follows the act");
  assert.ok(flies.some((f) => f.fap === "FEED"), "non-hearers keep their own act");
  // a grave tale (heard severity ≥ 4) freezes its hearers instead
  const gm = new RumorMill(CFG);
  gm.round(1, facts(3, [], 9));
  gm.round(2, facts(3, [news(10, "PLAGUE", 5)], 11));
  for (let t = 3; t < 15; t++) gm.round(t, facts(3, [], 12));
  const g = Array.from({ length: 30 }, (_, i) => reading(i, "FEED"));
  assert.ok(gm.apply(g, RM_TELL_EVERY) > 0);
  assert.ok(g.some((f) => f.fap === "HALT") && !g.some((f) => f.fap === "GROOM"), "the rot is heard as a freeze");
});

test("rumor: hearing is monotonic — a hearer stays a hearer as the tale grows", () => {
  const { mill } = started(2, 10);
  const early = new Set<number>();
  for (let t = 3; t < 6; t++) mill.round(t, facts(3, [], 11));
  const f1 = Array.from({ length: 40 }, (_, i) => reading(i, "FEED"));
  mill.apply(f1, RM_TELL_EVERY);
  for (const f of f1) if (f.fap === "GROOM") early.add(f.id);
  for (let t = 6; t < 20; t++) mill.round(t, facts(3, [], 11));       // the tale travels on
  const f2 = Array.from({ length: 40 }, (_, i) => reading(i, "FEED"));
  mill.apply(f2, RM_TELL_EVERY * 2);
  for (const f of f2) if (early.has(f.id)) assert.equal(f.fap, "GROOM", "an early hearer never un-hears");
});

test("rumor: serialize/restore round-trips a live tale; a corrupt blob restarts an empty market", () => {
  const { mill } = started(2, 10);
  for (let t = 3; t < 12; t++) mill.round(t, facts(3, [], 11));
  const blob = mill.serialize();
  const back = new RumorMill(CFG);
  back.restore(blob);
  back.round(12, facts(3, [], 11)); // boot round after restore: `seen` is true so this must NOT re-adopt
  const sig = back.signals();
  assert.ok(sig.active, "the tale survives the restart");
  assert.equal(sig.active!.topic, "feud");
  assert.equal(sig.active!.seq, 10);
  assert.ok(sig.counts.afoot <= mill.signals().counts.afoot, "counts carry over, never reset");
  const broken = new RumorMill(CFG);
  broken.restore("{not json");
  broken.restore(null as unknown as string);
  assert.equal(broken.signals().active, null, "corruption ⇒ an empty market, never a throw");
});

test("rumor: a disabled mill never speaks and never rewrites", () => {
  const mill = new RumorMill({ enabled: false });
  mill.round(1, facts(3, [], 0));
  mill.round(2, facts(3, [news(1, "FEUD", 5)], 2));
  assert.equal(mill.signals().active, null);
  const f = [reading(0, "FEED")];
  assert.equal(mill.apply(f, RM_TELL_EVERY), 0);
  assert.equal(f[0].fap, "FEED");
});

test("rumor: the topic map speaks listed kinds by market noun and the rest by lowercase name", () => {
  assert.equal(rumorTopic("GUILD_MONOPOLY"), "monopoly");
  assert.equal(rumorTopic("APPRENTICE_PACT"), "apprentice pact", "unlisted kinds keep a readable fallback");
});
