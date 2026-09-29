/**
 * ㉜ EMERGENT CONVENTIONS — unit tests (node:test, mirrors norms.test.ts's fixture style).
 *
 * Covers the whole acceptance grid: deterministic pair tracking + crystallisation (the low-variance sustained
 * cadence gate, the anti-flicker run + cooldown, a stable sorted tie-break), the OPEN descriptor space (a derived
 * good + price band, never a hand-assigned label), hash-gated spread + INHERITANCE with its double guard (a real
 * bond AND a depth cap), the BOUNDED 1.5× breach penalty (clamped to the Channel-A ceiling, never money), the
 * norms←conventions ABSORPTION pathway, the CONV_CAP hard ceiling + the 200KB blob guard (cumulative with norms),
 * hysteresis (CRYSTAL > DIE), decay + TTL reaping, the Channel-A causal leg (≤ maxIntensity ≤ 0.3), config OFF
 * inertness, the restore→refreshPending contract, additive/corrupt-blob recovery, malformed-facts survival, and
 * full byte-for-byte replay.
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  ConventionsMembrane, pairSigOf, deriveDescriptor, convLabel,
  CONVENTIONS_VERSION, CONV_CAP, ADOPTER_CAP, MIN_TRADES, MIN_FREQ, CRYSTAL_STABLE_RUN, VARIANCE_MAX,
  CRYSTAL_STRENGTH, DIE_STRENGTH, DECAY, TTL, BREACH_DROP, BREACH_PENALTY, BREACH_BASE, MAX_DEPTH,
  ABSORB_STRENGTH, ABSORB_RUN, ABSORB_COOLDOWN, GOOD_COUNT, GOOD_NAMES,
  type ConvBond, type ConventionsFacts,
} from "./conventions.js";
import { NormsMembrane, NORM_CAP } from "./norms.js";

const CFG = { enabled: true, maxIntensity: 0.3 };

// ─── fixtures ────────────────────────────────────────────────────────────────────────────────────────────

/** A facts stream where every listed pair trades at a STEADY one-per-cron cadence (delta 1 ⇒ zero variance). */
function steady(tick: number, pairs: [number, number][], score = 0.9, tradesAt = (t: number) => t): ConventionsFacts {
  const ids = new Set<number>();
  const bonds: ConvBond[] = pairs.map(([a, b]) => { ids.add(a); ids.add(b); return { a, b, score, trades: tradesAt(tick) }; });
  return { tick, era: 3, bonds, ids: [...ids] };
}

/** A deterministic (Math.random-free, Date.now-free) facts stream keyed only on the tick. */
function detFacts(tick: number): ConventionsFacts {
  const ids = [1, 2, 3, 4, 5, 6];
  const bonds: ConvBond[] = [];
  for (let i = 0; i < ids.length; i++) {
    for (let j = i + 1; j < ids.length; j++) {
      bonds.push({ a: ids[i], b: ids[j], score: ((tick * 31 + i * 7 + j * 13) % 100) / 100, trades: (tick * 3 + i + j) });
    }
  }
  return { tick, era: 3, bonds, ids };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function convRec(o: { id: number; a: number; b: number } & Record<string, any>): any {
  return {
    id: o.id, a: o.a, b: o.b, pairSig: o.pairSig ?? 0, good: o.good ?? 0,
    priceLo: o.priceLo ?? 0.1, priceHi: o.priceHi ?? 0.2, freq: o.freq ?? 1,
    strength: o.strength ?? 0.5, depth: o.depth ?? 0, parentId: o.parentId ?? null,
    adopters: o.adopters ?? [], bornTick: o.bornTick ?? 0, lastTick: o.lastTick ?? 0,
    lastScore: o.lastScore ?? 0, holdRun: o.holdRun ?? 0, lastAbsorb: o.lastAbsorb ?? -ABSORB_COOLDOWN,
    breaches: o.breaches ?? 0, inherited: o.inherited ?? 0,
  };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function blobOf(recs: any[], extra: Record<string, unknown> = {}): string {
  const nextId = recs.reduce((m, r) => Math.max(m, (r.id ?? 0) + 1), 1);
  return JSON.stringify({
    v: CONVENTIONS_VERSION, nextId,
    counts: { crystallized: 0, spread: 0, inherited: 0, breached: 0, died: 0, absorbed: 0 },
    concordance: 0, convs: recs, pairs: [], ...extra,
  });
}

// ─── pure helpers: signature + the open descriptor space ───────────────────────────────────────────────────

test("conventions: pairSigOf is order-independent, distinct and deterministic", () => {
  assert.equal(pairSigOf(3, 7), pairSigOf(7, 3), "the signature is unordered");
  assert.notEqual(pairSigOf(1, 2), pairSigOf(1, 3), "different pairs → different signatures");
  assert.equal(pairSigOf(4, 9), pairSigOf(4, 9), "deterministic");
  assert.ok(Number.isInteger(pairSigOf(4, 9)) && pairSigOf(4, 9) >= 0, "a non-negative 32-bit int");
});

test("conventions: deriveDescriptor spans an OPEN space (all four goods) and stays bounded + deterministic", () => {
  const goods = new Set<number>();
  for (let sig = 1; sig < 800; sig++) {
    const d = deriveDescriptor(sig, sig * 7 + 3);
    goods.add(d.good);
    assert.ok(d.good >= 0 && d.good < GOOD_COUNT, "good axis in range");
    assert.ok(d.priceLo >= 0 && d.priceLo <= 1, "priceLo bounded");
    assert.ok(d.priceHi >= d.priceLo && d.priceHi <= 1, "priceHi ≥ priceLo, bounded");
    assert.deepEqual(deriveDescriptor(sig, sig * 7 + 3), d, "deterministic");
  }
  assert.equal(goods.size, GOOD_COUNT, `all four goods appear (saw ${[...goods].join(",")})`);
});

test("conventions: convLabel is byte-stable pure ASCII in a fixed format", () => {
  const label = convLabel({ good: 0, priceLo: 0.1, priceHi: 0.3, freq: 3, a: 7, b: 12 });
  assert.equal(label, `${GOOD_NAMES[0]}[0.10-0.30]f3(7~12)`);
  for (const ch of label) assert.ok(ch.charCodeAt(0) < 128, `ASCII only (bad '${ch}')`);
  assert.equal(label, convLabel({ good: 0, priceLo: 0.1, priceHi: 0.3, freq: 3, a: 7, b: 12 }), "stable");
});

// ─── crystallisation ───────────────────────────────────────────────────────────────────────────────────────

test("conventions: a steady low-variance pair crystallises after CRYSTAL_STABLE_RUN crons — once per run", () => {
  const m = new ConventionsMembrane(CFG);
  let crystals = 0;
  for (let t = 1; t <= 20; t++) {
    m.round(steady(t, [[1, 2]]));
    if (m.signals().crystallized) crystals++;
  }
  assert.equal(crystals, 1, "a single steady pair crystallises exactly once across twenty crons (run + cooldown hold)");
  assert.equal(m.signals().counts.crystallized, 1);
  assert.equal(m.signals().conventions.length, 1);
  const c = m.signals().conventions[0];
  assert.equal(c.depth, 0, "a crystallised convention has lineage depth 0");
  assert.equal(c.parentId, null, "and no parent");
  assert.ok(c.strength > DIE_STRENGTH, "it is born above the death floor");
});

test("conventions: crystallisation needs the sustained cadence — an erratic pair never hardens", () => {
  const m = new ConventionsMembrane(CFG);
  // trades alternate 0 / 20 ⇒ the per-cron delta swings wildly ⇒ normVar ≫ VARIANCE_MAX
  for (let t = 1; t <= 12; t++) m.round(steady(t, [[1, 2]], 0.9, (tt) => (tt % 2 === 0 ? 20 : 0)));
  assert.equal(m.signals().counts.crystallized, 0, "high variance never crystallises");
  assert.equal(m.signals().conventions.length, 0);
});

test("conventions: crystallisation is deterministic — the same facts reproduce the same society byte-for-byte", () => {
  const run = () => {
    const m = new ConventionsMembrane(CFG);
    for (let t = 1; t <= 8; t++) m.round(detFacts(t));
    return m.serialize();
  };
  assert.equal(run(), run());
});

test("conventions: the crystallise tie-break is stable — ids are assigned in sorted-pair order", () => {
  const build = () => {
    const m = new ConventionsMembrane(CFG);
    for (let t = 1; t <= 6; t++) m.round(steady(t, [[3, 4], [1, 2]]));   // fed out of order on purpose
    return m.signals().conventions;
  };
  const a = build(), b = build();
  assert.equal(a.length, 2, "both steady pairs crystallised");
  const lo = (v: typeof a) => v.find((c) => c.conv.endsWith("(1~2)"))!.id;
  const hi = (v: typeof a) => v.find((c) => c.conv.endsWith("(3~4)"))!.id;
  assert.ok(lo(a) < hi(a), "the lower sorted pair takes the lower id");
  assert.deepEqual([a.map((c) => c.id), b.map((c) => c.id)], [b.map((c) => c.id), a.map((c) => c.id)], "replay-stable ids");
  assert.equal(lo(a), lo(b), "identical across runs");
});

// ─── hysteresis / decay / TTL ──────────────────────────────────────────────────────────────────────────────

test("conventions: hysteresis — CRYSTAL_STRENGTH sits above DIE_STRENGTH so a fresh custom never flickers", () => {
  assert.ok(CRYSTAL_STRENGTH > DIE_STRENGTH, "the birth floor is above the death floor by construction");
  assert.ok(CRYSTAL_STRENGTH - DECAY > DIE_STRENGTH, "a fresh convention survives its own first decay");
  const m = new ConventionsMembrane(CFG);
  for (let t = 1; t <= CRYSTAL_STABLE_RUN + 1; t++) m.round(steady(t, [[1, 2]]));
  assert.ok(m.signals().crystallized, "it crystallised");
  assert.equal(m.signals().died, null, "and is not reaped on the cron it is born");
});

test("conventions: an unhonoured convention decays by DECAY each cron and dies at the floor", () => {
  const m = new ConventionsMembrane(CFG);
  // no founding bond in the facts ⇒ never honoured ⇒ no compliance reinforcement, only decay
  m.restore(blobOf([convRec({ id: 1, a: 1, b: 2, strength: 0.5, bornTick: 0, lastTick: 10_000 })]));
  let prev = 0.5;
  for (let t = 1; t <= 60; t++) {
    m.round({ tick: t, era: 3, bonds: [], ids: [] });
    const c = m.signals().conventions[0];
    if (!c) break;
    assert.ok(c.strength <= prev + 1e-9, "strength never rises while unhonoured");
    prev = c.strength;
  }
  assert.equal(m.signals().conventions.length, 0, "the unloved convention is reaped by decay");
  assert.ok(m.signals().counts.died >= 1, "the death is counted");
});

test("conventions: TTL reaps an old convention even while its strength is still above the floor", () => {
  const m = new ConventionsMembrane(CFG);
  // strength 1.0 ⇒ decay alone needs 90 crons to reach the floor, but TTL fires at 72 ⇒ proves the TTL path
  m.restore(blobOf([convRec({ id: 1, a: 1, b: 2, strength: 1.0, bornTick: 0, lastTick: 0 })]));
  let diedAt = -1, lastStrength = 1;
  for (let t = 1; t <= 90; t++) {
    m.round({ tick: t, era: 3, bonds: [], ids: [] });
    const c = m.signals().conventions[0];
    if (!c) { diedAt = t; break; }
    lastStrength = c.strength;
  }
  assert.ok(diedAt > 0 && diedAt <= TTL + 2, `TTL fired near tick ${TTL} (died at ${diedAt})`);
  assert.ok(lastStrength > DIE_STRENGTH, "it died by TTL, not by the strength floor");
});

// ─── breach + the bounded 1.5× penalty ─────────────────────────────────────────────────────────────────────

test("conventions: a bond collapse breaches the custom — strength drops and a penalty is recorded", () => {
  const m = new ConventionsMembrane(CFG);
  m.restore(blobOf([convRec({ id: 1, a: 1, b: 2, strength: 0.9, lastScore: 0.9 })]));
  // the founding pair's score craters 0.9 → 0.2 (a drop of 0.7 > BREACH_DROP) with no trade this cron
  m.round({ tick: 1, era: 3, bonds: [{ a: 1, b: 2, score: 0.2, trades: 0 }], ids: [1, 2] });
  const br = m.signals().breached;
  assert.ok(br, "the breach is chronicled this cron");
  assert.equal(m.signals().counts.breached, 1);
  assert.ok(br!.penalty <= 0.3 + 1e-9, `the penalty never exceeds the 0.3 ceiling (got ${br!.penalty})`);
  assert.ok(br!.strength < 0.9, "the convention's strength took a bounded hit");
});

test("conventions: the 1.5× breach penalty is HARD-CLAMPED to the ceiling — it can never exceed maxIntensity", () => {
  // the raw multiplier would be BREACH_BASE × 1.5 = 0.3; a lower ceiling must pull the penalty down with it
  assert.equal(Math.round(BREACH_BASE * BREACH_PENALTY * 100) / 100, 0.3, "0.2 × 1.5 = 0.3 at the default cap");
  for (const cap of [0.3, 0.2, 0.1, 0.05]) {
    const m = new ConventionsMembrane({ enabled: true, maxIntensity: cap });
    m.restore(blobOf([convRec({ id: 1, a: 1, b: 2, strength: 0.9, lastScore: 0.9 })]));
    m.round({ tick: 1, era: 3, bonds: [{ a: 1, b: 2, score: 0.2, trades: 0 }], ids: [1, 2] });
    const br = m.signals().breached!;
    assert.ok(br.penalty <= cap + 1e-9, `penalty ${br.penalty} ≤ cap ${cap}`);
    const felt = m.stimuli({ maxIntensity: cap });
    for (const e of felt) assert.ok(e.intensity <= cap + 1e-9, `felt intensity ${e.intensity} ≤ cap ${cap}`);
  }
});

test("conventions: the breach leg is a bounded Channel-A threat tagged conventions:breach — never money", () => {
  const m = new ConventionsMembrane(CFG);
  m.restore(blobOf([convRec({ id: 1, a: 1, b: 2, strength: 0.9, lastScore: 0.9 })]));
  m.round({ tick: 1, era: 3, bonds: [{ a: 1, b: 2, score: 0.2, trades: 0 }], ids: [1, 2] });
  const felt = m.stimuli({ maxIntensity: 0.3 });
  const breachLeg = felt.find((e) => e.from === "conventions:breach");
  assert.ok(breachLeg, "a breach leg fires");
  assert.equal(breachLeg!.type, "threat", "it is a threat, not a purse");
  assert.ok(breachLeg!.intensity <= 0.3 + 1e-9, "bounded at the ceiling");
  for (const e of felt) {
    assert.ok(["food", "threat", "light", "dark"].includes(e.type as string), "only the existing four channels");
    assert.ok(Number.isFinite(e.intensity) && e.intensity >= 0 && e.intensity <= 0.3 + 1e-9, "every leg bounded");
  }
});

// ─── the causal leg (Channel A only, ≤ 0.3) ────────────────────────────────────────────────────────────────

test("conventions: honoured concordance emits swarm-wide food+light, hard-capped at maxIntensity", () => {
  const m = new ConventionsMembrane(CFG);
  m.restore(blobOf([convRec({ id: 1, a: 1, b: 2, strength: 0.6, lastScore: 0.9 })]));
  // the founding pair trades (trades > 0) at a steady score ⇒ honoured ⇒ concordance 1.0
  m.round({ tick: 1, era: 3, bonds: [{ a: 1, b: 2, score: 0.9, trades: 5 }], ids: [1, 2] });
  assert.ok(m.signals().concordance > 0.5, "an honoured convention reads as high concordance");
  const s = m.stimuli({ maxIntensity: 0.3 });
  assert.deepEqual(s.filter((e) => e.from === "conventions").map((x) => x.type).sort(), ["food", "light"]);
  for (const e of s) {
    assert.ok(e.intensity <= 0.3 + 1e-9, `intensity ≤ 0.3 (got ${e.intensity})`);
    assert.ok(["food", "threat", "light", "dark"].includes(e.type as string), "only the four channels");
  }
});

test("conventions: the ceiling scales the leg; a zero or NaN ceiling and an empty society are inert", () => {
  const m = new ConventionsMembrane(CFG);
  m.restore(blobOf([convRec({ id: 1, a: 1, b: 2, strength: 0.6, lastScore: 0.9 })]));
  m.round({ tick: 1, era: 3, bonds: [{ a: 1, b: 2, score: 0.9, trades: 5 }], ids: [1, 2] });
  for (const e of m.stimuli({ maxIntensity: 0.1 })) assert.ok(e.intensity <= 0.1 + 1e-9, "obeys a lower ceiling");
  assert.deepEqual(m.stimuli({ maxIntensity: 0 }), [], "a zero ceiling is inert");
  assert.deepEqual(m.stimuli({ maxIntensity: NaN as unknown as number }), [], "a NaN ceiling is inert (no NaN leak)");
  const empty = new ConventionsMembrane(CFG);
  assert.deepEqual(empty.stimuli({ maxIntensity: 0.3 }), [], "no live convention ⇒ no stimulus");
});

// ─── spread + inheritance (the double guard) ───────────────────────────────────────────────────────────────

test("conventions: a convention spreads to real neighbouring pairs and is INHERITED with lineage depth", () => {
  const m = new ConventionsMembrane(CFG);
  m.restore(blobOf([convRec({ id: 1, a: 1, b: 2, strength: 0.9, lastScore: 0.9 })]));
  const neighbours: [number, number][] = [];
  for (let k = 3; k <= 42; k++) neighbours.push([1, k]);
  const bonds: ConvBond[] = [{ a: 1, b: 2, score: 0.9, trades: 5 }, ...neighbours.map(([a, b]) => ({ a, b, score: 1, trades: 1 }))];
  m.round({ tick: 1, era: 3, bonds, ids: [1, 2, ...neighbours.map((n) => n[1])] });
  const s = m.signals();
  assert.ok(s.counts.spread + s.counts.inherited > 0, "the convention reached neighbouring pairs");
  assert.ok(s.counts.inherited >= 1, `at least one adoption became an inherited child (got ${s.counts.inherited})`);
  const child = s.conventions.find((c) => c.depth === 1);
  assert.ok(child, "a depth-1 child exists");
  assert.equal(child!.parentId, 1, "the child names its parent");
  assert.ok(s.lineageDepth >= 1, "lineage depth is observable");
});

test("conventions: inheritance is DOUBLE-GUARDED — no real bond ⇒ no child; a depth-MAX parent ⇒ no child", () => {
  // guard 2: with only the founding bond (no neighbour), nothing can inherit
  const lone = new ConventionsMembrane(CFG);
  lone.restore(blobOf([convRec({ id: 1, a: 1, b: 2, strength: 0.9, lastScore: 0.9 })]));
  lone.round({ tick: 1, era: 3, bonds: [{ a: 1, b: 2, score: 0.9, trades: 5 }], ids: [1, 2] });
  assert.equal(lone.signals().counts.inherited, 0, "a reused slot with no live interaction never auto-duplicates");
  assert.equal(lone.signals().counts.spread, 0, "and never spreads");

  // guard 1: the SAME neighbour set, but the parent is already at MAX_DEPTH ⇒ the depth cap blocks every child
  const deep = new ConventionsMembrane(CFG);
  deep.restore(blobOf([convRec({ id: 1, a: 1, b: 2, strength: 0.9, lastScore: 0.9, depth: MAX_DEPTH })]));
  const neighbours: [number, number][] = [];
  for (let k = 3; k <= 42; k++) neighbours.push([1, k]);
  const bonds: ConvBond[] = [{ a: 1, b: 2, score: 0.9, trades: 5 }, ...neighbours.map(([a, b]) => ({ a, b, score: 1, trades: 1 }))];
  deep.round({ tick: 1, era: 3, bonds, ids: [1, 2, ...neighbours.map((n) => n[1])] });
  assert.equal(deep.signals().counts.inherited, 0, "a depth-MAX convention cannot inherit further");
  assert.ok(deep.signals().lineageDepth <= MAX_DEPTH, `lineage never exceeds MAX_DEPTH (got ${deep.signals().lineageDepth})`);
});

test("conventions: adoption is bounded by ADOPTER_CAP", () => {
  const m = new ConventionsMembrane(CFG);
  m.restore(blobOf([convRec({ id: 1, a: 1, b: 2, strength: 0.9, lastScore: 0.9 })]));
  const neighbours: [number, number][] = [];
  for (let k = 3; k <= 80; k++) neighbours.push([1, k]);
  const bonds: ConvBond[] = [{ a: 1, b: 2, score: 0.9, trades: 5 }, ...neighbours.map(([a, b]) => ({ a, b, score: 1, trades: 1 }))];
  m.round({ tick: 1, era: 3, bonds, ids: [1, 2, ...neighbours.map((n) => n[1])] });
  for (const c of m.signals().conventions) assert.ok(c.adopters <= ADOPTER_CAP, `adopters ≤ ${ADOPTER_CAP} (got ${c.adopters})`);
});

// ─── norms ← conventions absorption ────────────────────────────────────────────────────────────────────────

test("conventions: a wide-and-steady convention is offered UP to norms as a promotion seed", () => {
  const m = new ConventionsMembrane(CFG);
  m.restore(blobOf([convRec({ id: 1, a: 1, b: 2, strength: 0.9, lastScore: 0.9, holdRun: 0 })]));
  let promote = null as null | { sig: number; strength: number; label: string; era: number };
  // honour it every cron (a live founding trade) so holdRun climbs to ABSORB_RUN
  for (let t = 1; t <= ABSORB_RUN + 2; t++) {
    m.round({ tick: t, era: 3, bonds: [{ a: 1, b: 2, score: 0.9, trades: 5 }], ids: [1, 2] });
    if (m.signals().promote) { promote = m.signals().promote; break; }
  }
  assert.ok(promote, "the convention was offered up once it held ≥ ABSORB_STRENGTH for ABSORB_RUN crons");
  assert.ok(Number.isInteger(promote!.sig) && promote!.sig >= 0, "the seed carries a deterministic signature");
  assert.ok(promote!.strength >= ABSORB_STRENGTH - 0.05, "the seed strength reflects a strong convention");
  assert.equal(typeof promote!.label, "string");
});

test("conventions: NormsMembrane.absorb() is hash-gated, deterministic, bounded by NORM_CAP and inert when off", () => {
  // find a signature the hash gate accepts (≈ ABSORB_P of all sigs) — deterministic, so it always resolves
  const nm = new NormsMembrane({ enabled: true, maxIntensity: 0.3 });
  let accepted = -1;
  for (let sig = 1; sig < 4000; sig++) {
    const probe = new NormsMembrane({ enabled: true, maxIntensity: 0.3 });
    if (probe.absorb({ sig, tick: 10, era: 3, strength: 0.8 })) { accepted = sig; break; }
  }
  assert.ok(accepted > 0, "some promotion is absorbed (the gate is not always closed)");
  const ok = nm.absorb({ sig: accepted, tick: 10, era: 3, strength: 0.8, origin: "signal[0.10-0.30]f3(1~2)" });
  assert.equal(ok, true, "the same seed is accepted again (determinism)");
  assert.equal(nm.signals().norms.length, 1, "absorption minted exactly one norm");
  const minted = nm.signals().norms[0];
  assert.equal(minted.depth, 0, "an absorbed norm enters at depth 0");
  assert.ok(minted.strength >= 0 && minted.strength <= 1, "its strength is clamped to [0,1]");

  // NORM_CAP guard: a full ledger absorbs nothing
  const full = new NormsMembrane({ enabled: true, maxIntensity: 0.3 });
  const recs = [];
  for (let i = 1; i <= NORM_CAP; i++) recs.push({ id: i, cond: { k: 0, ch: 0, op: 0, thr: 0.5 }, action: { channel: 0, gain: 0.5 }, strength: 0.5, depth: 0, parentId: null, adherents: [i], bornTick: 0, lastAdherentTick: 0, clusterSig: i, mutations: 0 });
  full.restore(JSON.stringify({ v: 1, nextId: NORM_CAP + 1, counts: { minted: 0, spread: 0, mutated: 0, died: 0 }, compliance: 0, norms: recs, clusters: [] }));
  assert.equal(full.absorb({ sig: accepted, tick: 10, era: 3, strength: 0.8 }), false, "a full ledger refuses the absorption");

  // disabled guard
  const off = new NormsMembrane({ enabled: false, maxIntensity: 0.3 });
  assert.equal(off.absorb({ sig: accepted, tick: 10, era: 3, strength: 0.8 }), false, "absorb is inert while norms are off");
});

test("conventions: confirmAbsorb(true) counts the absorption; confirmAbsorb(false) leaves the count", () => {
  const m = new ConventionsMembrane(CFG);
  m.restore(blobOf([convRec({ id: 1, a: 1, b: 2, strength: 0.9 })]));
  assert.equal(m.signals().counts.absorbed, 0);
  m.confirmAbsorb(false);
  assert.equal(m.signals().counts.absorbed, 0, "a refused absorption is not counted");
  m.confirmAbsorb(true);
  assert.equal(m.signals().counts.absorbed, 1, "a successful absorption is observable");
});

// ─── bounds ────────────────────────────────────────────────────────────────────────────────────────────────

test("conventions: the ledger is hard-capped at CONV_CAP and the blob stays inside the 200KB guard", () => {
  const pairs: [number, number][] = [];
  for (let p = 0; p < 60; p++) pairs.push([p * 2 + 1, p * 2 + 2]);
  const m = new ConventionsMembrane(CFG);
  for (let t = 1; t <= 8; t++) m.round(steady(t, pairs));
  assert.equal(m.signals().conventions.length, CONV_CAP, `60 clamouring pairs still yield exactly CONV_CAP conventions (got ${m.signals().conventions.length})`);
  const blob = m.serialize();
  assert.ok(blob.length < 200_000, `conventions blob bounded (was ${blob.length} bytes)`);
  for (const c of m.signals().conventions) assert.ok(c.adopters <= ADOPTER_CAP, "adopter list bounded");
});

test("conventions: the conventions blob + the norms blob together leave headroom under the 200KB DO guard", () => {
  const pairs: [number, number][] = [];
  for (let p = 0; p < 60; p++) pairs.push([p * 2 + 1, p * 2 + 2]);
  const cm = new ConventionsMembrane(CFG);
  for (let t = 1; t <= 8; t++) cm.round(steady(t, pairs));
  const nm = new NormsMembrane({ enabled: true, maxIntensity: 0.3 });
  for (let t = 1; t <= 8; t++) nm.round({ tick: t, era: 3, reading: { arousal: 0, cohesion: 0, valence: 0, rest: 0, temperature: 0, gini: 0, size01: 0, bond: 0, rep: 0 }, bonds: pairs.map(([a, b]) => ({ a, b, score: 0.9 })), ids: pairs.flat() });
  const cb = cm.serialize().length, nb = nm.serialize().length;
  // eslint-disable-next-line no-console
  console.error(`[conventions.test] blob bytes — conventions=${cb} norms=${nb} sum=${cb + nb} (guard 200000)`);
  assert.ok(cb + nb < 200_000, `the two emergent layers together stay under the guard (conventions ${cb} + norms ${nb} = ${cb + nb})`);
});

// ─── config OFF inertness ───────────────────────────────────────────────────────────────────────────────────

test("conventions: CONVENTIONS_ENABLED=false is byte-for-byte inert", () => {
  const m = new ConventionsMembrane({ enabled: false, maxIntensity: 0.3 });
  for (let t = 1; t <= 14; t++) m.round(detFacts(t));
  const s = m.signals();
  assert.equal(s.crystallized, null);
  assert.equal(s.spread, null);
  assert.equal(s.inherited, null);
  assert.equal(s.breached, null);
  assert.equal(s.died, null);
  assert.equal(s.promote, null);
  assert.equal(s.conventions.length, 0);
  assert.deepEqual(s.counts, { crystallized: 0, spread: 0, inherited: 0, breached: 0, died: 0, absorbed: 0 });
  assert.deepEqual(m.stimuli({ maxIntensity: 0.3 }), []);
});

// ─── persistence: restore + refreshPending + additive recovery ─────────────────────────────────────────────

test("conventions: restore rebuilds the standing read-out (refreshPending) so it is non-zero BEFORE any round", () => {
  const A = new ConventionsMembrane(CFG);
  for (let t = 1; t <= 6; t++) A.round(steady(t, [[1, 2], [3, 4]]));
  assert.ok(A.signals().conventions.length > 0, "A crystallised conventions");
  const blobA = A.serialize();
  const B = new ConventionsMembrane(CFG);
  B.restore(blobA);
  // the #92 contract: the drawer is truthful at once — no round() needed, no zeroed read-out after an eviction
  assert.ok(B.signals().conventions.length > 0, "restore→signals() is non-zero immediately (refreshPending at the tail)");
  assert.equal(B.signals().conventions.length, A.signals().conventions.length, "the standing society is rebuilt");
  assert.deepEqual(B.signals().counts, A.signals().counts);
  assert.equal(B.signals().crystallized, null, "a fresh restore carries no transient edge event");
  assert.equal(B.serialize(), blobA, "restore→serialize is a fixed point");
});

test("conventions: an older/partial blob restores additively — missing fields take safe defaults", () => {
  const partial = JSON.stringify({ v: 1, convs: [{ id: 1, a: 1, b: 2 }] });
  const m = new ConventionsMembrane(CFG);
  m.restore(partial);
  assert.equal(m.signals().conventions.length, 1);
  const c = m.signals().conventions[0];
  assert.equal(c.id, 1);
  assert.ok(c.strength >= 0 && c.strength <= 1, "a missing strength defaults inside [0,1]");
  assert.equal(c.depth, 0, "a missing depth defaults to 0");
});

test("conventions: a corrupt or empty blob restarts an empty society — never throws", () => {
  const bad = ["", "not json", "{}", "[]", JSON.stringify({ v: 1 }), JSON.stringify({ v: 1, convs: "nope" }),
    JSON.stringify({ v: 1, convs: [{ id: 1, a: 1, b: 1 }] }), JSON.stringify({ v: 1, convs: [{ id: 0 }] })];
  for (const b of bad) {
    const m = new ConventionsMembrane(CFG);
    assert.doesNotThrow(() => m.restore(b), `survived ${b}`);
    assert.equal(m.signals().conventions.length, 0, `empty society after ${b}`);
  }
});

// ─── robustness + full replay ──────────────────────────────────────────────────────────────────────────────

test("conventions: malformed facts are survived — NaN read-outs, self-bonds, absent ids", () => {
  const m = new ConventionsMembrane(CFG);
  const bad: ConventionsFacts = {
    tick: NaN, era: NaN,
    bonds: [{ a: 1, b: 1, score: NaN, trades: NaN }, { a: 1, b: 2, score: Infinity, trades: Infinity }, { a: 2, b: 3, score: -Infinity, trades: -5 }],
    ids: [1, 2, NaN],
  };
  assert.doesNotThrow(() => m.round(bad));
  assert.ok(m.signals().conventions.length <= CONV_CAP);
  for (const e of m.stimuli({ maxIntensity: NaN as unknown as number })) assert.ok(Number.isFinite(e.intensity), "a NaN ceiling leaks no NaN intensity");
});

test("conventions: replay — two membranes fed identical facts serialize identically every cron", () => {
  const a = new ConventionsMembrane(CFG);
  const b = new ConventionsMembrane(CFG);
  for (let t = 1; t <= 40; t++) {
    const f = detFacts(t);
    a.round(f);
    b.round(f);
    assert.equal(a.serialize(), b.serialize(), `byte-identical at tick ${t}`);
    assert.ok(a.signals().conventions.length <= CONV_CAP, `bounded at tick ${t}`);
    assert.ok(a.signals().lineageDepth <= MAX_DEPTH, `lineage bounded at tick ${t}`);
    for (const e of a.stimuli({ maxIntensity: 0.3 })) assert.ok(e.intensity <= 0.3 + 1e-9, `Channel A ≤ 0.3 at tick ${t}`);
  }
});

test("conventions: serialize→restore→round is stable across an eviction boundary", () => {
  const a = new ConventionsMembrane(CFG);
  for (let t = 1; t <= 20; t++) a.round(detFacts(t));
  const blob = a.serialize();
  const b = new ConventionsMembrane(CFG);
  b.restore(blob);
  for (let t = 21; t <= 35; t++) {
    const f = detFacts(t);
    a.round(f);
    b.round(f);
    assert.equal(a.serialize(), b.serialize(), `evicted+restored membrane tracks the original at tick ${t}`);
  }
});

test("conventions: MIN_TRADES / MIN_FREQ gates mean a pair that barely trades never crystallises", () => {
  assert.ok(MIN_TRADES >= 1 && MIN_FREQ > 0, "the gates are positive by construction");
  const m = new ConventionsMembrane(CFG);
  // a pair whose cumulative trades never move (delta 0 ⇒ mean 0 < MIN_FREQ) cannot harden
  for (let t = 1; t <= 12; t++) m.round(steady(t, [[1, 2]], 0.9, () => 1));
  assert.equal(m.signals().counts.crystallized, 0, "a static pair crystallises nothing");
});
