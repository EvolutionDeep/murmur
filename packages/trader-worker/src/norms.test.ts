/**
 * ㉛ EMERGENT NORMS — unit tests (node:test, mirrors rumor.test.ts's fixture style).
 *
 * Covers the whole acceptance grid: deterministic clustering + minting, the OPEN condition space (not an
 * enumeration), the NORM_CAP hard ceiling + the 200KB blob guard, hysteresis (MINT_STRENGTH > DIE_STRENGTH),
 * decay + TTL reaping, hash-gated spread (bond floor + monotonic-in-strength adoption), the bounded ±0.1
 * mutation clamp, the Channel-A causal leg (≤ maxIntensity ≤ 0.3, never money), config OFF inertness, the
 * restore→refreshPending contract, additive/corrupt-blob recovery, malformed-facts survival, and full replay.
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  NormsMembrane, clusterBonds, clusterSig, deriveCond, deriveAction, mutateNorm,
  evalCond, condLabel, actionLabel, normLabel,
  NORMS_VERSION, NORM_CAP, ADHERENT_CAP, MINT_STRENGTH, DIE_STRENGTH, DECAY, TTL, BOND_MIN,
  type Cond, type CondLeaf, type Norm, type NormBond, type NormsFacts, type NormsReading,
} from "./norms.js";

const CFG = { enabled: true, maxIntensity: 0.3 };

// ─── fixtures ────────────────────────────────────────────────────────────────────────────────────────────

/** A swarm read-out; every channel defaults to 0 unless overridden. */
function rdg(over: Partial<NormsReading> = {}): NormsReading {
  return { arousal: 0, cohesion: 0, valence: 0, rest: 0, temperature: 0, gini: 0, size01: 0, bond: 0, rep: 0, ...over };
}

function facts(tick: number, ids: number[], bonds: NormBond[], reading: NormsReading = rdg(), era = 3): NormsFacts {
  return { tick, era, reading, bonds, ids };
}

/** A deterministic (LCG-free, Math.random-free) facts stream keyed only on the tick. */
function detFacts(tick: number): NormsFacts {
  const ids = [1, 2, 3, 4, 5, 6];
  const bonds: NormBond[] = [];
  for (let i = 0; i < ids.length; i++) {
    for (let j = i + 1; j < ids.length; j++) {
      bonds.push({ a: ids[i], b: ids[j], score: ((tick * 31 + i * 7 + j * 13) % 100) / 100 });
    }
  }
  const r = (k: number) => ((tick * k) % 100) / 100;
  return { tick, era: 3, reading: rdg({ arousal: r(17), cohesion: r(23), valence: r(29), rest: r(37), temperature: r(41), gini: r(43), size01: r(47), bond: r(53), rep: r(59) }), bonds, ids };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function normRec(o: { id: number } & Record<string, any>): any {
  return {
    id: o.id, cond: o.cond ?? { k: 0, ch: 0, op: 0, thr: 0 }, action: o.action ?? { channel: 0, gain: 0.5 },
    strength: o.strength ?? 0.5, depth: o.depth ?? 0, parentId: o.parentId ?? null,
    adherents: o.adherents ?? [o.id], bornTick: o.bornTick ?? 0, lastAdherentTick: o.lastAdherentTick ?? 0,
    clusterSig: o.clusterSig ?? 1, mutations: o.mutations ?? 0,
  };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function blobOf(recs: any[], extra: Record<string, unknown> = {}): string {
  const nextId = recs.reduce((m, r) => Math.max(m, (r.id ?? 0) + 1), 1);
  return JSON.stringify({ v: NORMS_VERSION, nextId, counts: { minted: 0, spread: 0, mutated: 0, died: 0 }, compliance: 0, norms: recs, clusters: [], ...extra });
}

function leaves(c: Cond, acc: CondLeaf[] = []): CondLeaf[] {
  if (c.k === 0) { acc.push(c); return acc; }
  for (const x of c.of ?? []) leaves(x, acc);
  return acc;
}

function countNodes(c: Cond): number {
  if (c.k === 0) return 1;
  return 1 + (c.of ?? []).reduce((s, x) => s + countNodes(x), 0);
}

// ─── pure helpers: the open condition space ────────────────────────────────────────────────────────────────

test("norms: evalCond folds leaf/AND/OR/NOT correctly against a reading vector", () => {
  const rv = [0.7, 0.2, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5];
  const ge: Cond = { k: 0, ch: 0, op: 0, thr: 0.6 };   // arousal >= 0.60 → 0.7 ≥ 0.6 true
  const lt: Cond = { k: 0, ch: 1, op: 1, thr: 0.6 };   // cohesion < 0.60 → 0.2 < 0.6 true
  const geF: Cond = { k: 0, ch: 1, op: 0, thr: 0.6 };  // cohesion >= 0.60 → false
  assert.equal(evalCond(ge, rv), true);
  assert.equal(evalCond(lt, rv), true);
  assert.equal(evalCond(geF, rv), false);
  const and: Cond = { k: 1, of: [ge, geF] };
  const or: Cond = { k: 2, of: [ge, geF] };
  const not: Cond = { k: 3, of: [geF] };
  assert.equal(evalCond(and, rv), false, "AND needs every child");
  assert.equal(evalCond(or, rv), true, "OR needs one child");
  assert.equal(evalCond(not, rv), true, "NOT flips its first child");
});

test("norms: labels are byte-stable ASCII (the {norm} token both sides re-derive)", () => {
  const c: Cond = { k: 0, ch: 0, op: 0, thr: 0.6 };
  const c2: Cond = { k: 0, ch: 1, op: 1, thr: 0.5 };
  assert.equal(condLabel(c), "arousal>=0.60");
  assert.equal(condLabel(c2), "cohesion<0.50");
  assert.equal(actionLabel({ channel: 0, gain: 0.3 }), "food*0.30");
  assert.equal(normLabel({ cond: c, action: { channel: 0, gain: 0.3 } }), "arousal>=0.60->food*0.30");
  const notC: Cond = { k: 3, of: [c] };
  const andC: Cond = { k: 1, of: [c, c2] };
  const orC: Cond = { k: 2, of: [c, c2] };
  assert.equal(condLabel(notC), "!arousal>=0.60");
  assert.equal(condLabel(andC), "(arousal>=0.60&cohesion<0.50)");
  assert.equal(condLabel(orC), "(arousal>=0.60|cohesion<0.50)");
  // determinism
  assert.equal(condLabel(andC), condLabel(andC));
});

test("norms: the condition space is OPEN — deriveCond spans leaf/AND/OR/NOT/nested, bounded at 5 nodes", () => {
  const ks = new Set<number>();
  let maxNodes = 0;
  for (let sig = 1; sig < 600; sig++) {
    const c = deriveCond(sig, sig * 7 + 3);
    ks.add(c.k);
    maxNodes = Math.max(maxNodes, countNodes(c));
    // a derived tree is total + pure: evaluating it twice on one vector agrees
    const rv = [0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5];
    assert.equal(evalCond(c, rv), evalCond(c, rv));
  }
  assert.ok(ks.has(0) && ks.has(1) && ks.has(2) && ks.has(3), `all four node kinds appear (saw ${[...ks].join(",")})`);
  assert.ok(maxNodes <= 5, `node count bounded at 5 (saw ${maxNodes})`);
});

test("norms: deriveCond / deriveAction / clusterSig are deterministic functions of their inputs", () => {
  assert.deepEqual(deriveCond(42, 7), deriveCond(42, 7));
  assert.deepEqual(deriveAction(42, 7), deriveAction(42, 7));
  assert.equal(clusterSig([3, 1, 2]), clusterSig([1, 2, 3]), "the signature is order-independent (sorted fold)");
  assert.notEqual(clusterSig([1, 2]), clusterSig([1, 3]), "different members → different signature");
});

test("norms: mutation drifts ONE parameter by at most ±0.1 and never leaves [0,1]", () => {
  for (const base of [0, 1, 0.5, 0.05, 0.95]) {
    for (let d = 0; d < 200; d++) {
      const sig = (d * 2654435761) % 0xffffffff;
      const tick = d + 1;
      const n: Norm = {
        id: 1, cond: { k: 0, ch: 0, op: 0, thr: base }, action: { channel: 1, gain: base },
        strength: base, depth: 0, parentId: null, adherents: [1], bornTick: 0, lastAdherentTick: 0, clusterSig: 1, mutations: 0,
      };
      const m = mutateNorm(n, sig, tick);
      assert.ok(m.strength >= 0 && m.strength <= 1, "strength stays in [0,1]");
      assert.ok(m.action.gain >= 0 && m.action.gain <= 1, "gain stays in [0,1]");
      const ls = leaves(m.cond);
      for (const l of ls) assert.ok(l.thr >= 0 && l.thr <= 1, "leaf threshold stays in [0,1]");
      assert.ok(Math.abs(m.strength - base) <= 0.1 + 1e-9, "strength drift ≤ 0.1");
      assert.ok(Math.abs(m.action.gain - base) <= 0.1 + 1e-9, "gain drift ≤ 0.1");
      assert.ok(Math.abs(ls[0].thr - base) <= 0.1 + 1e-9, "threshold drift ≤ 0.1");
      assert.deepEqual(mutateNorm(n, sig, tick), m, "mutation is deterministic");
    }
  }
});

// ─── clustering ────────────────────────────────────────────────────────────────────────────────────────────

test("norms: clustering is deterministic — the same graph yields byte-identical clusters", () => {
  const ids = [1, 2, 3, 4, 5];
  const bonds: NormBond[] = [{ a: 1, b: 2, score: 0.6 }, { a: 2, b: 3, score: 0.6 }, { a: 4, b: 5, score: 0.8 }];
  const c1 = clusterBonds(ids, bonds);
  const c2 = clusterBonds(ids, bonds);
  const norm = (m: Map<number, number[]>) => [...m.entries()].map(([k, v]) => [k, [...v].sort((a, b) => a - b)]).sort((a, b) => a[0] - b[0]);
  assert.deepEqual(norm(c1), norm(c2));
  const all = [...c1.values()].flat().sort((a, b) => a - b);
  assert.deepEqual(all, [1, 2, 3, 4, 5], "every finite node is labelled");
});

test("norms: bonds below BOND_MIN are not edges — a weak tie clusters nobody", () => {
  const ids = [1, 2];
  const weak = clusterBonds(ids, [{ a: 1, b: 2, score: BOND_MIN - 0.001 }]);
  // no edge ⇒ two singletons, neither of which can ever mint (MIN_CLUSTER = 2)
  const sizes = [...weak.values()].map((v) => v.length).sort();
  assert.deepEqual(sizes, [1, 1], "the sub-floor bond left both nodes alone");
  const strong = clusterBonds(ids, [{ a: 1, b: 2, score: 0.9 }]);
  assert.ok([...strong.values()].some((v) => v.length === 2), "a strong bond merges the pair");
});

// ─── minting + hysteresis ──────────────────────────────────────────────────────────────────────────────────

test("norms: a stable cluster mints after MINT_STABLE_RUN crons — one mint per stable run", () => {
  const m = new NormsMembrane(CFG);
  const ids = [1, 2];
  const bonds: NormBond[] = [{ a: 1, b: 2, score: 0.9 }];
  let mints = 0;
  for (let t = 1; t <= 10; t++) {
    m.round(facts(t, ids, bonds));
    if (m.signals().minted) mints++;
  }
  assert.equal(mints, 1, "a single stable pair mints exactly once across ten crons (cooldown holds)");
  assert.equal(m.signals().norms.length, 1);
});

test("norms: hysteresis — MINT_STRENGTH sits above DIE_STRENGTH so a fresh norm never flickers", () => {
  assert.ok(MINT_STRENGTH > DIE_STRENGTH, "mint floor is above the death floor by construction");
  assert.ok(MINT_STRENGTH - DECAY > DIE_STRENGTH, "a freshly minted norm survives its own first decay");
  const m = new NormsMembrane(CFG);
  for (let t = 1; t <= 3; t++) m.round(facts(t, [1, 2], [{ a: 1, b: 2, score: 0.9 }]));
  assert.ok(m.signals().minted, "minted on the third stable cron");
  assert.equal(m.signals().died, null, "it is not reaped on the cron it is born");
  assert.equal(m.signals().norms.length, 1);
});

// ─── decay + TTL ───────────────────────────────────────────────────────────────────────────────────────────

test("norms: an unloved norm decays by DECAY each cron and dies at the hysteresis floor", () => {
  const m = new NormsMembrane(CFG);
  // cond arousal>=1 with an all-zero reading ⇒ never satisfied ⇒ no compliance reinforcement
  m.restore(blobOf([normRec({ id: 1, cond: { k: 0, ch: 0, op: 0, thr: 1 }, strength: 0.5, bornTick: 0, lastAdherentTick: 0, adherents: [1] })]));
  let prev = 0.5;
  for (let t = 1; t <= 50; t++) {
    m.round(facts(t, [], [], rdg()));
    const n = m.signals().norms[0];
    if (!n) break;
    assert.ok(n.strength <= prev + 1e-9, "strength never rises while unsatisfied");
    prev = n.strength;
  }
  assert.equal(m.signals().norms.length, 0, "the unloved norm is reaped by decay");
  assert.ok(m.signals().counts.died >= 1, "the death is chronicled");
});

test("norms: TTL reaps an old norm even while its strength is still above the floor", () => {
  const m = new NormsMembrane(CFG);
  // strength 1.0 ⇒ decay alone needs 90 crons to reach the floor, but TTL fires at 60 ⇒ proves the TTL path
  m.restore(blobOf([normRec({ id: 1, cond: { k: 0, ch: 0, op: 0, thr: 1 }, strength: 1.0, bornTick: 0, lastAdherentTick: 0, adherents: [1] })]));
  let diedAt = -1;
  let lastStrength = 1;
  for (let t = 1; t <= 80; t++) {
    m.round(facts(t, [], [], rdg()));
    const n = m.signals().norms[0];
    if (!n) { diedAt = t; break; }
    lastStrength = n.strength;
  }
  assert.ok(diedAt > 0 && diedAt <= TTL + 2, `TTL fired near tick ${TTL} (died at ${diedAt})`);
  assert.ok(lastStrength > DIE_STRENGTH, "it died by TTL, not by the strength floor");
});

// ─── spread (hash-gated) ───────────────────────────────────────────────────────────────────────────────────

test("norms: spread is bond-gated — a sub-BOND_MIN edge carries nothing (invisible mind)", () => {
  const mk = () => {
    const m = new NormsMembrane(CFG);
    m.restore(blobOf([normRec({ id: 1, cond: { k: 0, ch: 0, op: 0, thr: 1 }, strength: 0.9, adherents: [10] })]));
    return m;
  };
  const strong: NormBond[] = [{ a: 10, b: 11, score: 1 }, { a: 10, b: 12, score: 1 }];
  const withWeak = mk();
  withWeak.round(facts(1, [10, 11, 12, 13], [...strong, { a: 10, b: 13, score: 0.01 }], rdg()));
  const without = mk();
  without.round(facts(1, [10, 11, 12], strong, rdg()));
  assert.equal(withWeak.serialize(), without.serialize(), "the sub-floor tie to 13 changed nothing");
});

test("norms: adoption is monotonic in strength — a stronger norm reaches a superset of minds", () => {
  const bonds: NormBond[] = [{ a: 10, b: 11, score: 1 }, { a: 10, b: 12, score: 1 }, { a: 10, b: 13, score: 1 }, { a: 10, b: 14, score: 1 }];
  const ids = [10, 11, 12, 13, 14];
  const low = new NormsMembrane(CFG);
  low.restore(blobOf([normRec({ id: 1, cond: { k: 0, ch: 0, op: 0, thr: 1 }, strength: 0.15, adherents: [10] })]));
  low.round(facts(1, ids, bonds, rdg()));
  const high = new NormsMembrane(CFG);
  high.restore(blobOf([normRec({ id: 1, cond: { k: 0, ch: 0, op: 0, thr: 1 }, strength: 0.9, adherents: [10] })]));
  high.round(facts(1, ids, bonds, rdg()));
  const lc = low.signals().norms.find((n) => n.id === 1)!.adherents;
  const hc = high.signals().norms.find((n) => n.id === 1)!.adherents;
  assert.ok(hc >= lc, `the stronger norm adopts at least as many (${hc} ≥ ${lc})`);
});

test("norms: spread is deterministic — replaying the same bonds reproduces the same society", () => {
  const bonds: NormBond[] = [{ a: 10, b: 11, score: 1 }, { a: 10, b: 12, score: 0.8 }, { a: 11, b: 13, score: 0.7 }];
  const ids = [10, 11, 12, 13];
  const run = () => {
    const m = new NormsMembrane(CFG);
    m.restore(blobOf([normRec({ id: 1, cond: { k: 0, ch: 0, op: 0, thr: 1 }, strength: 0.9, adherents: [10] })]));
    for (let t = 1; t <= 5; t++) m.round(facts(t, ids, bonds, rdg()));
    return m.serialize();
  };
  assert.equal(run(), run());
});

// ─── the causal leg (Channel A only, ≤ 0.3) ────────────────────────────────────────────────────────────────

test("norms: satisfied compliance emits swarm-wide food+light, hard-capped at maxIntensity", () => {
  const m = new NormsMembrane(CFG);
  m.restore(blobOf([normRec({ id: 1, cond: { k: 0, ch: 0, op: 0, thr: 0 }, strength: 0.5, adherents: [1] })])); // arousal>=0 always true
  m.round(facts(1, [], [], rdg({ arousal: 0.5 })));
  assert.ok(m.signals().compliance > 0.5, "the satisfied norm reads as high compliance");
  const s = m.stimuli({ maxIntensity: 0.3 });
  assert.deepEqual(s.map((x) => x.type).sort(), ["food", "light"]);
  for (const e of s) {
    assert.ok(Number.isFinite(e.intensity) && e.intensity >= 0 && e.intensity <= 0.3 + 1e-9, `intensity ≤ 0.3 (got ${e.intensity})`);
    assert.ok(["food", "threat", "light", "dark"].includes(e.type as string), "only the existing four channels");
    assert.equal(e.from, "norms");
  }
});

test("norms: violated compliance emits a single bounded threat, never money", () => {
  const m = new NormsMembrane(CFG);
  m.restore(blobOf([
    normRec({ id: 1, cond: { k: 0, ch: 0, op: 0, thr: 0 }, strength: 0.5, adherents: [1] }),   // satisfied
    normRec({ id: 2, cond: { k: 0, ch: 0, op: 0, thr: 1 }, strength: 0.5, adherents: [2] }),   // violated
    normRec({ id: 3, cond: { k: 0, ch: 0, op: 0, thr: 1 }, strength: 0.5, adherents: [3] }),   // violated
  ]));
  m.round(facts(1, [], [], rdg({ arousal: 0.5 })));
  assert.ok(m.signals().compliance < 0.5, "two of three violated ⇒ compliance below half");
  const s = m.stimuli({ maxIntensity: 0.3 });
  assert.equal(s.length, 1);
  assert.equal(s[0].type, "threat");
  assert.ok(s[0].intensity <= 0.3 + 1e-9);
});

test("norms: the ceiling scales the leg; a zero ceiling or no norms is inert", () => {
  const m = new NormsMembrane(CFG);
  m.restore(blobOf([normRec({ id: 1, cond: { k: 0, ch: 0, op: 0, thr: 0 }, strength: 0.5, adherents: [1] })]));
  m.round(facts(1, [], [], rdg({ arousal: 0.5 })));
  for (const e of m.stimuli({ maxIntensity: 0.1 })) assert.ok(e.intensity <= 0.1 + 1e-9, "the leg obeys a lower ceiling");
  assert.deepEqual(m.stimuli({ maxIntensity: 0 }), [], "a zero ceiling is inert");
  const empty = new NormsMembrane(CFG);
  assert.deepEqual(empty.stimuli({ maxIntensity: 0.3 }), [], "no live norm ⇒ no stimulus");
});

// ─── bounds ────────────────────────────────────────────────────────────────────────────────────────────────

test("norms: the ledger is hard-capped at NORM_CAP and the blob stays inside the 200KB guard", () => {
  const ids: number[] = [];
  const bonds: NormBond[] = [];
  for (let p = 0; p < 60; p++) { const a = p * 2 + 1, b = p * 2 + 2; ids.push(a, b); bonds.push({ a, b, score: 0.9 }); }
  const m = new NormsMembrane(CFG);
  for (let t = 1; t <= 6; t++) m.round(facts(t, ids, bonds));
  assert.equal(m.signals().norms.length, NORM_CAP, "60 clamouring clusters still yield exactly NORM_CAP norms");
  const blob = m.serialize();
  assert.ok(blob.length < 200_000, `blob bounded (was ${blob.length} bytes)`);
  for (const n of m.signals().norms) assert.ok(n.adherents <= ADHERENT_CAP, "membership list bounded");
});

// ─── config OFF inertness ───────────────────────────────────────────────────────────────────────────────────

test("norms: NORMS_ENABLED=false is byte-for-byte inert", () => {
  const m = new NormsMembrane({ enabled: false, maxIntensity: 0.3 });
  for (let t = 1; t <= 12; t++) m.round(detFacts(t));
  const s = m.signals();
  assert.equal(s.minted, null);
  assert.equal(s.spread, null);
  assert.equal(s.mutated, null);
  assert.equal(s.died, null);
  assert.equal(s.norms.length, 0);
  assert.deepEqual(s.counts, { minted: 0, spread: 0, mutated: 0, died: 0 });
  assert.deepEqual(m.stimuli({ maxIntensity: 0.3 }), []);
});

// ─── persistence: restore + refreshPending + additive recovery ──────────────────────────────────────────────

test("norms: restore rebuilds the standing read-out (refreshPending) and keeps edges null", () => {
  const A = new NormsMembrane(CFG);
  for (let t = 1; t <= 3; t++) A.round(facts(t, [1, 2], [{ a: 1, b: 2, score: 0.9 }]));
  assert.ok(A.signals().minted, "A minted");
  const blobA = A.serialize();
  const B = new NormsMembrane(CFG);
  B.restore(blobA);
  assert.equal(B.signals().minted, null, "a fresh restore carries no edge event (minted is transient)");
  assert.equal(B.signals().norms.length, A.signals().norms.length, "the standing society is rebuilt at restore's tail");
  assert.deepEqual(B.signals().counts, A.signals().counts);
  assert.equal(B.serialize(), blobA, "restore→serialize is a fixed point");
});

test("norms: an older/partial blob restores additively — missing fields take safe defaults", () => {
  const partial = JSON.stringify({ v: 1, norms: [{ id: 1, cond: { k: 0, ch: 0, op: 0, thr: 0.5 } }] });
  const m = new NormsMembrane(CFG);
  m.restore(partial);
  assert.equal(m.signals().norms.length, 1);
  const n = m.signals().norms[0];
  assert.equal(n.id, 1);
  assert.ok(n.strength >= 0 && n.strength <= 1, "a missing strength defaults inside [0,1]");
});

test("norms: a corrupt or empty blob restarts an empty society — never throws", () => {
  const bad = ["", "not json", "{}", "[]", JSON.stringify({ v: 1 }), JSON.stringify({ v: 1, norms: "nope" }), JSON.stringify({ v: 1, norms: [{ id: 1, cond: { k: 99 } }] })];
  for (const b of bad) {
    const m = new NormsMembrane(CFG);
    assert.doesNotThrow(() => m.restore(b), `survived ${b}`);
    assert.equal(m.signals().norms.length, 0, `empty society after ${b}`);
  }
});

test("norms: restore drops an invalid / over-deep condition tree but keeps valid siblings", () => {
  const good = normRec({ id: 1, cond: { k: 0, ch: 0, op: 0, thr: 0.5 }, strength: 0.6 });
  const badKind = { id: 2, cond: { k: 7, ch: 999 } };
  let deep: Cond = { k: 0, ch: 0, op: 0, thr: 0.5 };
  for (let i = 0; i < 8; i++) deep = { k: 3, of: [deep] };   // depth 8 > the bounded parse depth
  const badDeep = { id: 3, cond: deep };
  const m = new NormsMembrane(CFG);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  m.restore(blobOf([good, badKind, badDeep as any]));
  assert.equal(m.signals().norms.length, 1, "only the valid sibling survives");
  assert.equal(m.signals().norms[0].id, 1);
});

// ─── robustness + full replay ──────────────────────────────────────────────────────────────────────────────

test("norms: malformed facts are survived — NaN read-outs, self-bonds, absent ids", () => {
  const m = new NormsMembrane(CFG);
  const bad: NormsFacts = {
    tick: NaN, era: NaN,
    reading: { arousal: NaN, cohesion: NaN, valence: NaN, rest: NaN, temperature: NaN, gini: NaN, size01: NaN, bond: NaN, rep: NaN },
    bonds: [{ a: 1, b: 1, score: NaN }, { a: 1, b: 2, score: Infinity }],
    ids: [1, 2, NaN],
  };
  assert.doesNotThrow(() => m.round(bad));
  assert.ok(m.signals().norms.length <= NORM_CAP);
  for (const e of m.stimuli({ maxIntensity: NaN as unknown as number })) assert.ok(Number.isFinite(e.intensity), "a NaN ceiling leaks no NaN intensity");
});

test("norms: replay — two membranes fed identical facts serialize identically every cron", () => {
  const a = new NormsMembrane(CFG);
  const b = new NormsMembrane(CFG);
  for (let t = 1; t <= 40; t++) {
    const f = detFacts(t);
    a.round(f);
    b.round(f);
    assert.equal(a.serialize(), b.serialize(), `byte-identical at tick ${t}`);
    assert.ok(a.signals().norms.length <= NORM_CAP, `bounded at tick ${t}`);
    for (const e of a.stimuli({ maxIntensity: 0.3 })) assert.ok(e.intensity <= 0.3 + 1e-9, `Channel A ≤ 0.3 at tick ${t}`);
  }
});

test("norms: serialize→restore→round is stable across an eviction boundary", () => {
  const a = new NormsMembrane(CFG);
  for (let t = 1; t <= 20; t++) a.round(detFacts(t));
  const blob = a.serialize();
  const b = new NormsMembrane(CFG);
  b.restore(blob);
  // both continue from tick 21 with identical facts ⇒ identical future
  for (let t = 21; t <= 35; t++) {
    const f = detFacts(t);
    a.round(f);
    b.round(f);
    assert.equal(a.serialize(), b.serialize(), `evicted+restored membrane tracks the original at tick ${t}`);
  }
});
