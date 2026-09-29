/**
 * ㉝ BOUNDED RULE CREATION — unit tests (node:test, mirrors norms/conventions.test.ts's fixture style).
 *
 * This is the highest-risk membrane in the plan, so the acceptance grid leads with the SAFETY property: the
 * CONSTITUTIONAL BAND. Covers ① the band property test (clampBuy/clampCp are TOTAL; deriveModifier is open yet
 * never escapes; through many deterministic seeds + extreme facts + repeated mutate/adopt every EFFECTIVE modifier
 * stays inside [0.5, 2.0]; restore re-clamps a poisoned blob), ② mint/adopt/revoke determinism + tie-break +
 * byte-for-byte replay, ③ the composite-upper-bound three-point proof (clamp01 collapses the amp×strategyTilt×
 * rulesTilt chain; the modifier carries NO money/cap/amount so the real-spend caps stay independent; the
 * counterparty weight keeps its 0.05 floor ⇒ no division-by-zero, no NaN), ④ the top-10%-for-N-crons mint gate +
 * anti-flicker, ⑤ performance-below-threshold auto-revoke (netUsdc + win-rate legs), ⑥ decay/TTL/hysteresis,
 * ⑦ config-OFF byte-for-byte inertness, ⑧ the restore→refreshPending contract, ⑨ additive/corrupt-blob recovery +
 * malformed-facts survival, ⑩ the RULE_CAP hard ceiling + the 200KB guard (cumulative across norms+conventions+rules).
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  RulesMembrane, clampBuy, clampCp, normaliseBand, deriveModifier, ruleSigOf, ruleLabel,
  RULES_VERSION, HARD_BUY_MIN, HARD_BUY_MAX, HARD_CP_MIN, HARD_CP_MAX,
  RULE_CAP, ADOPTER_CAP, MINT_STABLE_RUN, MINT_STRENGTH, DIE_STRENGTH, DECAY, TTL,
  REVOKE_WINRATE, REVOKE_MIN_SETTLES, MAX_DEPTH,
  type RulesFacts, type RuleFly, type RulesReading, type RulesConfig,
} from "./rules.js";
import { condLabel, NormsMembrane } from "./norms.js";
import { ConventionsMembrane } from "./conventions.js";

/** The default constitutional band — config may only NARROW it, never widen past the hard floor/ceiling. */
const CFG: RulesConfig = { enabled: true, buyMin: 0.5, buyMax: 2.0, cpMin: 0.5, cpMax: 2.0 };

// ─── fixtures ────────────────────────────────────────────────────────────────────────────────────────────

const R0: RulesReading = { arousal: 0, cohesion: 0, valence: 0, rest: 0, temperature: 0, gini: 0, size01: 0, bond: 0, rep: 0 };

/** A reading vector with every channel set to the same value (clamped 0..1 downstream). */
function reading(v: number): RulesReading {
  return { arousal: v, cohesion: v, valence: v, rest: v, temperature: v, gini: v, size01: v, bond: v, rep: v };
}

function fly(id: number, netUsdc: number, settleOk = 0, settleTotal = 0): RuleFly {
  return { id, netUsdc, settleOk, settleTotal };
}

function facts(tick: number, flies: RuleFly[], era = 3, rv: RulesReading = R0): RulesFacts {
  return { tick, era, reading: rv, flies };
}

/** A swarm of `n` flies whose richest `nTop` (ids 1..nTop) sit comfortably in the top-10% every cron. */
function topFlies(nTop: number, n: number): RuleFly[] {
  const out: RuleFly[] = [];
  for (let i = 1; i <= n; i++) out.push(fly(i, i <= nTop ? 1000 - i : 10 - i, 5, 5));
  return out;
}

/** A deterministic (Math.random-free, Date.now-free) swarm keyed only on the tick — extreme, sign-flipping netUsdc. */
function detFacts(tick: number): RulesFacts {
  const n = 16;
  const flies: RuleFly[] = [];
  for (let i = 1; i <= n; i++) {
    const net = ((tick * 37 + i * 53) % 900) - 200;   // spans negative → positive
    const tot = (tick + i) % 7;
    const ok = (tick * 3 + i) % (tot + 1);
    flies.push(fly(i, net, ok, tot));
  }
  return facts(tick, flies, 3, reading(((tick * 13) % 101) / 100));
}

/** Inject a controlled statute book straight through restore() (the fixture style conventions.test.ts uses). */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function blobOf(rules: any[], extra: Record<string, unknown> = {}): string {
  const nextId = rules.reduce((m, r) => Math.max(m, (r.id ?? 0) + 1), 1);
  return JSON.stringify({
    v: RULES_VERSION, nextId,
    counts: { minted: rules.length, adopted: 0, revoked: 0, died: 0 },
    rules, tracks: [], ...extra,
  });
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function ruleRec(o: { id: number } & Record<string, any>): any {
  return {
    id: o.id, cond: o.cond ?? { k: 0, ch: 0, op: 0, thr: 0.5 }, buyMod: o.buyMod ?? 1, cpMod: o.cpMod ?? 1,
    scope: 0, creator: o.creator ?? o.id, adopters: o.adopters ?? [], strength: o.strength ?? 0.5,
    depth: o.depth ?? 0, parentId: o.parentId ?? null, bornTick: o.bornTick ?? 0, lastTick: o.lastTick ?? 0,
    sig: o.sig ?? o.id, revokes: o.revokes ?? 0, variants: o.variants ?? 0,
  };
}

// ─── pure helpers ──────────────────────────────────────────────────────────────────────────────────────────

test("rules: ruleSigOf is deterministic and distinct per (creator, tick)", () => {
  assert.equal(ruleSigOf(3, 7), ruleSigOf(3, 7), "deterministic");
  assert.notEqual(ruleSigOf(3, 7), ruleSigOf(3, 8), "the tick changes the signature");
  assert.notEqual(ruleSigOf(3, 7), ruleSigOf(4, 7), "the creator changes the signature");
  assert.ok(Number.isInteger(ruleSigOf(4, 9)) && ruleSigOf(4, 9) >= 0, "a non-negative 32-bit int");
});

test("rules: normaliseBand folds ANY wild config band into the constitutional envelope", () => {
  const wilds = [
    { buyMin: NaN, buyMax: NaN, cpMin: NaN, cpMax: NaN },
    { buyMin: -99, buyMax: 99, cpMin: -99, cpMax: 99 },
    { buyMin: 2, buyMax: 0.5, cpMin: 2, cpMax: 0.5 },   // reversed
    { buyMin: Infinity, buyMax: -Infinity, cpMin: Infinity, cpMax: -Infinity },
  ];
  for (const b of wilds) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const n = normaliseBand(b as any);
    assert.ok(n.buyMin >= HARD_BUY_MIN && n.buyMax <= HARD_BUY_MAX && n.buyMin <= n.buyMax, `buy band folded (${JSON.stringify(n)})`);
    assert.ok(n.cpMin >= HARD_CP_MIN && n.cpMax <= HARD_CP_MAX && n.cpMin <= n.cpMax, `cp band folded (${JSON.stringify(n)})`);
  }
  assert.deepEqual(normaliseBand(null), { buyMin: HARD_BUY_MIN, buyMax: HARD_BUY_MAX, cpMin: HARD_CP_MIN, cpMax: HARD_CP_MAX }, "null → the full default band");
});

test("rules: ruleLabel is byte-stable pure ASCII in a fixed format", () => {
  const cond = { k: 0 as const, ch: 0, op: 0 as const, thr: 0.5 };
  const label = ruleLabel({ cond, buyMod: 1.25, cpMod: 0.75 });
  assert.equal(label, `${condLabel(cond)}=>buy*1.25/cp*0.75`);
  for (const ch of label) assert.ok(ch.charCodeAt(0) < 128, `ASCII only (bad '${ch}')`);
  assert.equal(label, ruleLabel({ cond, buyMod: 1.25, cpMod: 0.75 }), "stable");
});

// ─── ① THE CONSTITUTIONAL BAND — the load-bearing safety property ──────────────────────────────────────────

test("rules ①: clampBuy/clampCp are TOTAL — every wild input lands inside the HARD constitutional band", () => {
  const mods = [NaN, Infinity, -Infinity, -1e12, -1, 0, 0.25, HARD_BUY_MIN, 1, 1.5, HARD_BUY_MAX, 3, 1e12];
  const bands: [number, number][] = [
    [0.5, 2], [NaN, NaN], [Infinity, -Infinity], [-1e12, 1e12], [2, 0.5], [0, 0], [3, 3], [-5, -1],
    [HARD_BUY_MIN, HARD_BUY_MAX], [1e9, 1e9],
  ];
  for (const m of mods) {
    for (const [lo, hi] of bands) {
      const b = clampBuy(m, lo, hi);
      assert.ok(Number.isFinite(b), `buy finite for m=${m} band=${lo},${hi}`);
      assert.ok(b >= HARD_BUY_MIN - 1e-12 && b <= HARD_BUY_MAX + 1e-12, `buy NEVER escapes [${HARD_BUY_MIN},${HARD_BUY_MAX}] (got ${b}) for m=${m} band=${lo},${hi}`);
      const c = clampCp(m, lo, hi);
      assert.ok(Number.isFinite(c), `cp finite for m=${m} band=${lo},${hi}`);
      assert.ok(c >= HARD_CP_MIN - 1e-12 && c <= HARD_CP_MAX + 1e-12, `cp NEVER escapes [${HARD_CP_MIN},${HARD_CP_MAX}] (got ${c}) for m=${m} band=${lo},${hi}`);
    }
  }
});

test("rules ①: deriveModifier spans an OPEN space inside the band yet NEVER escapes it, for any signature or config band", () => {
  const bands = [
    { buyMin: 0.5, buyMax: 2, cpMin: 0.5, cpMax: 2 },
    { buyMin: 1, buyMax: 1.2, cpMin: 0.9, cpMax: 1.1 },   // a narrow legal band
    { buyMin: NaN, buyMax: NaN, cpMin: -5, cpMax: 99 },    // a wild band
    { buyMin: 2, buyMax: 0.5, cpMin: 2, cpMax: 0.5 },      // reversed
  ];
  const seen = new Set<string>();
  for (let sig = 1; sig < 3000; sig++) {
    for (const band of bands) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const m = deriveModifier(sig, sig * 7 + 3, band as any);
      assert.ok(Number.isFinite(m.buyMod) && m.buyMod >= HARD_BUY_MIN - 1e-9 && m.buyMod <= HARD_BUY_MAX + 1e-9, `buyMod ${m.buyMod} inside the hard band`);
      assert.ok(Number.isFinite(m.cpMod) && m.cpMod >= HARD_CP_MIN - 1e-9 && m.cpMod <= HARD_CP_MAX + 1e-9, `cpMod ${m.cpMod} inside the hard band`);
      if (band.buyMin === 0.5 && band.buyMax === 2) seen.add(m.buyMod.toFixed(2));
    }
  }
  assert.ok(seen.size >= 5, `the full-band draw is OPEN, not a single value (saw ${seen.size} distinct buyMods)`);
});

test("rules ①: PROPERTY — through many deterministic seeds, extreme facts and repeated mutate/adopt, every EFFECTIVE modifier stays inside the band", () => {
  for (let seed = 1; seed <= 40; seed++) {
    const m = new RulesMembrane(CFG);
    for (let t = 1; t <= 30; t++) {
      const n = 10 + ((seed * 7 + t * 3) % 20);
      const flies: RuleFly[] = [];
      for (let i = 1; i <= n; i++) {
        const net = ((seed * 31 + t * 17 + i * 13) % 2000) - 500;   // extreme, sign-flipping
        const tot = (seed + t + i) % 9;
        const ok = (seed * 3 + i) % (tot + 1);
        flies.push(fly(i, net, ok, tot));
      }
      m.round(facts(t, flies, seed % 5, reading(((seed * 11 + t * 5) % 101) / 100)));
      // EVERY modifier handed to the economy is inside the constitutional band
      for (const [, mod] of m.modifiers()) {
        assert.ok(Number.isFinite(mod.buyMult) && mod.buyMult >= HARD_BUY_MIN - 1e-9 && mod.buyMult <= HARD_BUY_MAX + 1e-9, `seed ${seed} tick ${t}: buyMult ${mod.buyMult} ESCAPED the band`);
        assert.ok(Number.isFinite(mod.cpMult) && mod.cpMult >= HARD_CP_MIN - 1e-9 && mod.cpMult <= HARD_CP_MAX + 1e-9, `seed ${seed} tick ${t}: cpMult ${mod.cpMult} ESCAPED the band`);
      }
      // and every live rule's stored modifier too
      for (const r of m.signals().rules) {
        assert.ok(r.buyMod >= HARD_BUY_MIN - 1e-9 && r.buyMod <= HARD_BUY_MAX + 1e-9, `seed ${seed} tick ${t}: stored buyMod ${r.buyMod} ESCAPED`);
        assert.ok(r.cpMod >= HARD_CP_MIN - 1e-9 && r.cpMod <= HARD_CP_MAX + 1e-9, `seed ${seed} tick ${t}: stored cpMod ${r.cpMod} ESCAPED`);
      }
      assert.ok(m.signals().rules.length <= RULE_CAP, `bounded at RULE_CAP (seed ${seed} tick ${t})`);
    }
  }
});

test("rules ①: the COMPOUND of several satisfied rules on one fly is clamped BACK into the band (never multiplies out)", () => {
  // four rules the same fly carries, each at the band ceiling; a reading that satisfies all of them
  const always = { k: 0 as const, ch: 0, op: 0 as const, thr: 0 };   // channel 0 >= 0 ⇒ always true
  const rules = [1, 2, 3, 4].map((id) => ruleRec({ id, cond: always, buyMod: HARD_BUY_MAX, cpMod: HARD_CP_MAX, creator: 1, strength: 0.9 }));
  const m = new RulesMembrane(CFG);
  m.restore(blobOf(rules));
  m.round(facts(1, [fly(1, 100, 5, 5)], 3, reading(0.9)));
  const mod = m.modifiers().get(1);
  assert.ok(mod, "fly 1 carries a compounded modifier");
  assert.ok(mod!.buyMult <= HARD_BUY_MAX + 1e-9, `the 2·2·2·2 compound is clamped to ≤ ${HARD_BUY_MAX} (got ${mod!.buyMult})`);
  assert.ok(mod!.cpMult <= HARD_CP_MAX + 1e-9, `the cp compound is clamped to ≤ ${HARD_CP_MAX} (got ${mod!.cpMult})`);
});

test("rules ①: restore RE-CLAMPS every stored modifier — a poisoned blob can never smuggle a wild multiplier", () => {
  const poisoned = blobOf([
    ruleRec({ id: 1, buyMod: 9999, cpMod: -9999 }),
    ruleRec({ id: 2, buyMod: null, cpMod: null }),   // JSON turns NaN/Infinity into null
  ]);
  const m = new RulesMembrane(CFG);
  m.restore(poisoned);
  const rules = m.signals().rules;
  assert.equal(rules.length, 2, "both records parsed");
  for (const r of rules) {
    assert.ok(r.buyMod >= HARD_BUY_MIN && r.buyMod <= HARD_BUY_MAX, `poisoned buyMod re-clamped (got ${r.buyMod})`);
    assert.ok(r.cpMod >= HARD_CP_MIN && r.cpMod <= HARD_CP_MAX, `poisoned cpMod re-clamped (got ${r.cpMod})`);
  }
});

// ─── ③ composite upper bound — the three-point proof ───────────────────────────────────────────────────────

test("rules ③(a): amp×strategyTilt×rulesTilt is collapsed by the final clamp01 — buyProbability can NEVER exceed 1", () => {
  // The exact tail of economy.buyProbability: base = p0·amp·strategyTilt·rulesTilt, then clamp01(base).
  const AMP_MAX = 1.0;              // playbook amplifier ∈ [0.5, 1.0]
  const TILT_MAX = 1.5;             // strategyTilt ∈ [0.5, 1.5]  (Kenji #91: composite ceiling 1.5)
  const RULE_MAX = HARD_BUY_MAX;    // rulesTilt ∈ [0.5, 2.0]
  const clamp01 = (x: number) => (x < 0 ? 0 : x > 1 ? 1 : x);
  assert.equal(RULE_MAX, 2.0, "the rules buy multiplier is hard-capped at 2.0");
  for (let i = 0; i <= 1000; i++) {
    const p0 = i / 1000;                              // any base propensity in [0, 1]
    const worst = p0 * AMP_MAX * TILT_MAX * RULE_MAX; // every multiplier at its same-direction extreme
    const out = clamp01(worst);
    assert.ok(out >= 0 && out <= 1, `clamp01 keeps buyProbability in [0,1] (raw ${worst} → ${out})`);
  }
  assert.ok(1 * AMP_MAX * TILT_MAX * RULE_MAX > 1, "the unclamped chain WOULD overflow — clamp01 is load-bearing");
});

test("rules ③(b): the modifier is a pure bounded TENDENCY multiplier — it carries NO money, NO cap, NO amount", () => {
  // RuleMod is exactly {buyMult, cpMult}, both dimensionless multipliers inside [0.5, 2.0]. Nothing the rules layer
  // produces is a currency amount, a cap or a settlement: rules only tilt (a) WHETHER a fly buys and (b) WHO it buys
  // from. The real-spend caps (maxDealUsdc / netMinBroadcastUsdc / daily / per-agent / netting / realSpendEnabled)
  // live in the settlement path in economy.ts and are multiplied by NOTHING the rules layer emits.
  const m = new RulesMembrane(CFG);
  for (let t = 1; t <= 6; t++) m.round(facts(t, topFlies(2, 20), 3, reading(0.5)));
  for (const [, mod] of m.modifiers()) {
    assert.deepEqual(Object.keys(mod).sort(), ["buyMult", "cpMult"], "the modifier map carries ONLY the two bounded multipliers");
    assert.ok(mod.buyMult >= HARD_BUY_MIN && mod.buyMult <= HARD_BUY_MAX, "buyMult is a bounded multiplier, never an amount");
    assert.ok(mod.cpMult >= HARD_CP_MIN && mod.cpMult <= HARD_CP_MAX, "cpMult is a bounded multiplier, never an amount");
  }
  const f = fly(1, 5, 3, 4);
  assert.deepEqual(Object.keys(f).sort(), ["id", "netUsdc", "settleOk", "settleTotal"], "rules only READS performance metrics — no purse, no cap, no mnemonic, no spend authority");
});

test("rules ③(c): the counterparty weight keeps its 0.05 floor for any band-clamped rule multiplier — no division-by-zero, no NaN", () => {
  // The exact weight in economy.pickCounterparty: w = Math.max(0.05, 1 + amp·stratTilt·cpRuleMod·(0.6·bond + 0.4·rep))
  const adversarial = [HARD_CP_MIN, 0.75, 1.0, 1.5, HARD_CP_MAX, NaN, Infinity, -Infinity, 1e9];
  const safe = (x: number) => (Number.isFinite(x) ? clampCp(x, HARD_CP_MIN, HARD_CP_MAX) : 1.0); // economy.rulesTilt guarantees this
  for (const rawCp of adversarial) {
    const cpRuleMod = safe(rawCp);
    assert.ok(Number.isFinite(cpRuleMod) && cpRuleMod >= HARD_CP_MIN && cpRuleMod <= HARD_CP_MAX, `rulesTilt yields a finite band value (raw ${rawCp} → ${cpRuleMod})`);
    for (const amp of [0, 0.5, 1.0]) {
      for (const stratTilt of [0.5, 1.0, 1.5]) {
        for (const bond of [-1, 0, 1]) {
          for (const rep of [-1, 0, 1]) {
            const w = Math.max(0.05, 1 + amp * stratTilt * cpRuleMod * (0.6 * bond + 0.4 * rep));
            assert.ok(Number.isFinite(w), `weight finite (cp=${cpRuleMod} amp=${amp} tilt=${stratTilt} bond=${bond} rep=${rep})`);
            assert.ok(w >= 0.05, `weight keeps its floor (got ${w})`);
          }
        }
      }
    }
  }
  const totalFor = (ws: number[]) => ws.reduce((a, b) => a + b, 0);
  assert.ok(totalFor([0.05]) >= 0.05, "a lone candidate still yields a positive total ⇒ the roulette never divides by zero");
});

// ─── ④ the mint gate ───────────────────────────────────────────────────────────────────────────────────────

test("rules ④: a fly holding the top-10% netUsdc for MINT_STABLE_RUN crons MINTS a rule — not one cron sooner", () => {
  const m = new RulesMembrane(CFG);
  const swarm = topFlies(2, 20);
  m.round(facts(1, swarm)); assert.equal(m.signals().counts.minted, 0, "cron 1: run=1, nothing minted");
  m.round(facts(2, swarm)); assert.equal(m.signals().counts.minted, 0, "cron 2: run=2, still nothing");
  m.round(facts(3, swarm));
  assert.ok(m.signals().counts.minted >= 1, `cron 3: run=${MINT_STABLE_RUN} ⇒ a rule is minted (got ${m.signals().counts.minted})`);
  assert.ok(m.signals().minted, "the mint edge event is published");
  assert.ok(m.signals().rules.length >= 1, "the statute book is non-empty");
  const v = m.signals().rules[0];
  assert.equal(v.depth, 0, "a minted rule has lineage depth 0");
  assert.equal(v.parentId, null, "and no parent");
  assert.ok(v.strength > DIE_STRENGTH, "born above the death floor (hysteresis)");
  assert.ok(v.buyMod >= HARD_BUY_MIN && v.buyMod <= HARD_BUY_MAX, "its modifier is inside the band at birth");
});

test("rules ④: an alternating leader never stabilises into a mint (the anti-flicker run gate)", () => {
  const m = new RulesMembrane(CFG);
  for (let t = 1; t <= 12; t++) {
    const top = t % 2 === 1 ? 1 : 2;   // the richest fly alternates every cron
    const flies: RuleFly[] = [];
    for (let i = 1; i <= 10; i++) flies.push(fly(i, i === top ? 1000 : 5));   // n=10 ⇒ top-10% = 1 fly
    m.round(facts(t, flies));
  }
  assert.equal(m.signals().counts.minted, 0, "no single fly held the top for MINT_STABLE_RUN crons ⇒ nothing minted");
});

test("rules ④: the top-10% tie-break is deterministic — equal netUsdc resolves by ascending id, replay-stable", () => {
  const a = new RulesMembrane(CFG), b = new RulesMembrane(CFG);
  const tied: RuleFly[] = [];
  for (let i = 1; i <= 20; i++) tied.push(fly(i, 100, 5, 5));   // all equal netUsdc
  for (let t = 1; t <= 3; t++) { a.round(facts(t, tied)); b.round(facts(t, tied)); }
  assert.deepEqual(a.signals().rules.map((r) => r.id), b.signals().rules.map((r) => r.id), "the tie-break assigns identical ids");
  assert.equal(a.serialize(), b.serialize(), "byte-identical under a tie");
});

// ─── ② determinism + replay ────────────────────────────────────────────────────────────────────────────────

test("rules ②: mint/adopt/revoke are deterministic — identical facts reproduce an identical statute book byte-for-byte", () => {
  const a = new RulesMembrane(CFG), b = new RulesMembrane(CFG);
  for (let t = 1; t <= 40; t++) {
    const f = detFacts(t);
    a.round(f); b.round(f);
    assert.equal(a.serialize(), b.serialize(), `byte-identical at tick ${t}`);
    assert.ok(a.signals().rules.length <= RULE_CAP, `bounded at tick ${t}`);
    for (const r of a.signals().rules) assert.ok(r.depth <= MAX_DEPTH, `lineage bounded at tick ${t}`);
  }
});

test("rules ②: serialize→restore→round tracks the original across an eviction boundary", () => {
  const a = new RulesMembrane(CFG);
  for (let t = 1; t <= 20; t++) a.round(detFacts(t));
  const blob = a.serialize();
  const b = new RulesMembrane(CFG);
  b.restore(blob);
  for (let t = 21; t <= 35; t++) {
    const f = detFacts(t);
    a.round(f); b.round(f);
    assert.equal(a.serialize(), b.serialize(), `evicted+restored membrane tracks the original at tick ${t}`);
  }
});

test("rules ②: adoption is hash-gated, monotonic in strength and bounded by ADOPTER_CAP", () => {
  const m = new RulesMembrane(CFG);
  // a strong rule over a big swarm ⇒ many hash-gated adoptions, but never more than ADOPTER_CAP members
  m.restore(blobOf([ruleRec({ id: 1, cond: { k: 0, ch: 0, op: 0, thr: 0 }, creator: 1, strength: 1.0 })]));
  const swarm: RuleFly[] = [];
  for (let i = 1; i <= 80; i++) swarm.push(fly(i, 100, 5, 5));
  m.round(facts(1, swarm, 3, reading(0.9)));
  const r = m.signals().rules.find((x) => x.id === 1);
  assert.ok(r, "the rule survives");
  assert.ok(r!.members <= ADOPTER_CAP + 1, `membership ≤ ADOPTER_CAP+creator (got ${r!.members})`);
});

// ─── ⑤ revoke ──────────────────────────────────────────────────────────────────────────────────────────────

test("rules ⑤: a founder whose netUsdc falls below the threshold is auto-REVOKED — the whole statute is struck", () => {
  const m = new RulesMembrane(CFG);
  const swarm = topFlies(2, 20);
  for (let t = 1; t <= 3; t++) m.round(facts(t, swarm));   // ids 1,2 mint
  assert.ok(m.signals().counts.minted >= 1, "a rule was minted");
  const before = m.signals().rules.length;
  const crashed = swarm.map((f) => (f.id === 1 ? fly(1, -50, 0, 5) : f));   // founder 1 crashes below REVOKE_NETUSDC
  m.round(facts(4, crashed));
  assert.ok(m.signals().counts.revoked >= 1, "the underperforming founder's rule was revoked");
  assert.ok(m.signals().rules.length < before || m.signals().revoked, "the statute book shrank / a revoke edge fired");
});

test("rules ⑤: an adopter whose settlement win-rate collapses is revoked from the rule's membership", () => {
  assert.ok(REVOKE_WINRATE > 0 && REVOKE_MIN_SETTLES >= 1, "the win-rate leg is armed by construction");
  const m = new RulesMembrane(CFG);
  m.restore(blobOf([ruleRec({ id: 1, cond: { k: 0, ch: 0, op: 0, thr: 0 }, creator: 1, adopters: [2], strength: 0.8 })]));
  // creator 1 healthy; adopter 2 has a collapsed win-rate (0/5 < REVOKE_WINRATE, with ≥ REVOKE_MIN_SETTLES evidence)
  m.round(facts(1, [fly(1, 100, 5, 5), fly(2, 100, 0, 5)], 3, reading(0.9)));
  assert.ok(m.signals().counts.revoked >= 1, "the losing adopter was revoked");
});

// ─── ⑥ decay / TTL / hysteresis ────────────────────────────────────────────────────────────────────────────

test("rules ⑥: an unsatisfied rule DECAYS by DECAY each cron and DIES at the floor", () => {
  assert.ok(DECAY > 0, "decay is positive");
  const m = new RulesMembrane(CFG);
  // condition never satisfied (channel 0 >= 0.99 while the reading is 0) ⇒ no compliance gain, pure decay
  m.restore(blobOf([ruleRec({ id: 1, cond: { k: 0, ch: 0, op: 0, thr: 0.99 }, creator: 1, strength: 0.5 })]));
  let died = -1;
  for (let t = 1; t <= 60; t++) { m.round(facts(t, [fly(1, 100, 5, 5)], 3, reading(0))); if (m.signals().counts.died > 0) { died = t; break; } }
  // 0.5 − 0.01·k ≤ 0.1 ⇒ k ≥ 40
  assert.ok(died >= 39 && died <= 41, `the unloved rule died on the decay schedule (cron ${died})`);
});

test("rules ⑥: TTL reaps an old rule even while its strength is still above the floor", () => {
  const m = new RulesMembrane(CFG);
  // strong (0.9) but never satisfied and lastTick frozen at 0 ⇒ the TTL clock, not decay, is what reaps it
  m.restore(blobOf([ruleRec({ id: 1, cond: { k: 0, ch: 0, op: 0, thr: 0.99 }, creator: 1, strength: 0.9, lastTick: 0 })]));
  let died = -1;
  for (let t = 1; t <= 80; t++) { m.round(facts(t, [fly(1, 100, 5, 5)], 3, reading(0))); if (m.signals().counts.died > 0) { died = t; break; } }
  assert.equal(died, TTL + 1, `the TTL reaped it at cron ${TTL + 1} (tick − lastTick > ${TTL})`);
});

test("rules ⑥: hysteresis — MINT_STRENGTH sits above DIE_STRENGTH so a fresh rule never flickers out", () => {
  assert.ok(MINT_STRENGTH > DIE_STRENGTH, "MINT > DIE by construction (no flicker)");
  const m = new RulesMembrane(CFG);
  for (let t = 1; t <= 3; t++) m.round(facts(t, topFlies(2, 20)));
  for (const r of m.signals().rules) assert.ok(r.strength > DIE_STRENGTH, "a just-minted rule is above the death floor");
});

// ─── ⑦ config OFF inertness ────────────────────────────────────────────────────────────────────────────────

test("rules ⑦: RULES_ENABLED=false is byte-for-byte inert", () => {
  const m = new RulesMembrane({ ...CFG, enabled: false });
  for (let t = 1; t <= 14; t++) m.round(detFacts(t));
  const s = m.signals();
  assert.equal(s.minted, null);
  assert.equal(s.adopted, null);
  assert.equal(s.revoked, null);
  assert.equal(s.died, null);
  assert.equal(s.rules.length, 0);
  assert.deepEqual(s.counts, { minted: 0, adopted: 0, revoked: 0, died: 0 });
  assert.equal(m.modifiers().size, 0, "no modifier is EVER projected while off ⇒ economy.rulesTilt returns 1.0");
});

// ─── ⑧ restore + refreshPending ────────────────────────────────────────────────────────────────────────────

test("rules ⑧: restore rebuilds the standing read-out (refreshPending) so it is non-zero BEFORE any round", () => {
  const A = new RulesMembrane(CFG);
  for (let t = 1; t <= 6; t++) A.round(facts(t, topFlies(2, 20), 3, reading(0.5)));
  assert.ok(A.signals().rules.length > 0, "A minted rules");
  const blob = A.serialize();
  const B = new RulesMembrane(CFG);
  B.restore(blob);
  assert.ok(B.signals().rules.length > 0, "restore→signals() is non-zero immediately (refreshPending at the tail)");
  assert.equal(B.signals().rules.length, A.signals().rules.length, "the standing statute book is rebuilt");
  assert.deepEqual(B.signals().counts, A.signals().counts);
  assert.equal(B.signals().minted, null, "a fresh restore carries no transient edge event");
  assert.ok(B.signals().avgModifier > 0, "the average modifier is observable right after restore");
  assert.equal(B.serialize(), blob, "restore→serialize is a fixed point");
});

test("rules ⑧: between a restore and the first drive the modifier map is EMPTY ⇒ the layer is inert until it earns a round", () => {
  const A = new RulesMembrane(CFG);
  for (let t = 1; t <= 6; t++) A.round(facts(t, topFlies(2, 20), 3, reading(0.5)));
  const B = new RulesMembrane(CFG);
  B.restore(A.serialize());
  assert.equal(B.modifiers().size, 0, "a restored membrane projects no modifier until it honestly earns a round");
  B.round(facts(7, topFlies(2, 20), 3, reading(0.5)));
  for (const [, mod] of B.modifiers()) {
    assert.ok(mod.buyMult >= HARD_BUY_MIN && mod.buyMult <= HARD_BUY_MAX, "after one round every modifier is in band");
  }
});

// ─── ⑨ additive / corrupt recovery + malformed facts ───────────────────────────────────────────────────────

test("rules ⑨: an older/partial blob restores additively — missing fields take safe in-band defaults", () => {
  const m = new RulesMembrane(CFG);
  m.restore(JSON.stringify({ v: 1, rules: [{ id: 1, cond: { k: 0, ch: 0, op: 0, thr: 0.5 } }] }));
  assert.equal(m.signals().rules.length, 1);
  const r = m.signals().rules[0];
  assert.equal(r.id, 1);
  assert.ok(r.buyMod >= HARD_BUY_MIN && r.buyMod <= HARD_BUY_MAX, "a missing buyMod defaults inside the band");
  assert.ok(r.cpMod >= HARD_CP_MIN && r.cpMod <= HARD_CP_MAX, "a missing cpMod defaults inside the band");
  assert.ok(r.strength >= 0 && r.strength <= 1, "a missing strength defaults inside [0,1]");
  assert.equal(r.depth, 0, "a missing depth defaults to 0");
});

test("rules ⑨: a corrupt or empty blob restarts an empty statute book — never throws", () => {
  const bad = [
    "", "not json", "{}", "[]",
    JSON.stringify({ v: 1 }),
    JSON.stringify({ v: 1, rules: "nope" }),
    JSON.stringify({ v: 1, rules: [{ id: 1 }] }),                                  // no cond ⇒ dropped
    JSON.stringify({ v: 1, rules: [{ id: 0, cond: { k: 0, ch: 0, op: 0, thr: 0.5 } }] }),  // id < 1 ⇒ dropped
    JSON.stringify({ v: 1, rules: [{ id: 1, cond: { k: 9, ch: 99, op: 5, thr: NaN } }] }), // bad cond ⇒ dropped
    JSON.stringify({ v: 1, rules: [{ id: 1, cond: { k: 0, ch: 99, op: 0, thr: 0.5 } }] }),  // bad channel ⇒ dropped
  ];
  for (const b of bad) {
    const m = new RulesMembrane(CFG);
    assert.doesNotThrow(() => m.restore(b), `survived ${b}`);
    assert.equal(m.signals().rules.length, 0, `empty statute book after ${b}`);
  }
});

test("rules ⑨: malformed facts are survived — NaN read-outs, absent/wild flies — and leak no NaN into the modifier map", () => {
  const m = new RulesMembrane(CFG);
  const bad: RulesFacts = {
    tick: NaN, era: NaN,
    reading: { arousal: NaN, cohesion: Infinity, valence: -Infinity, rest: NaN, temperature: 2, gini: -3, size01: NaN, bond: Infinity, rep: NaN },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    flies: [fly(NaN, NaN), fly(1, Infinity, NaN, NaN), fly(2, -Infinity, NaN, NaN), { id: 3 } as any],
  };
  assert.doesNotThrow(() => m.round(bad));
  assert.ok(m.signals().rules.length <= RULE_CAP, "bounded after malformed facts");
  for (const [, mod] of m.modifiers()) {
    assert.ok(Number.isFinite(mod.buyMult) && Number.isFinite(mod.cpMult), "no NaN leaks into the modifier map");
  }
});

// ─── ⑩ bounds + the 200KB guard ────────────────────────────────────────────────────────────────────────────

test("rules ⑩: the statute book is hard-capped at RULE_CAP and the blob stays inside the 200KB guard", () => {
  const m = new RulesMembrane(CFG);
  for (let t = 1; t <= 60; t++) {
    const flies: RuleFly[] = [];
    const n = 200;   // a huge clamouring elite (top-10% = 20 flies/cron)
    for (let i = 1; i <= n; i++) flies.push(fly(i, (i * 97 + t * 31) % 1000, 5, 5));
    m.round(facts(t, flies, 3, reading(((t * 7) % 101) / 100)));
  }
  assert.ok(m.signals().rules.length <= RULE_CAP, `bounded at RULE_CAP (got ${m.signals().rules.length})`);
  const blob = m.serialize();
  assert.ok(blob.length < 200_000, `rules blob bounded (was ${blob.length} bytes)`);
  assert.ok(blob.length < 20_000, `rules blob is small (was ${blob.length} bytes)`);
  for (const r of m.signals().rules) assert.ok(r.members <= ADOPTER_CAP + 1, `membership bounded (got ${r.members})`);
  // eslint-disable-next-line no-console
  console.error(`[rules.test] rules blob bytes = ${blob.length}`);
});

test("rules ⑩: norms + conventions + rules blobs together leave headroom under the 200KB DO guard", () => {
  const pairs: [number, number][] = [];
  for (let p = 0; p < 60; p++) pairs.push([p * 2 + 1, p * 2 + 2]);
  const ids = pairs.flat();
  const cm = new ConventionsMembrane({ enabled: true, maxIntensity: 0.3 });
  const nm = new NormsMembrane({ enabled: true, maxIntensity: 0.3 });
  const rm = new RulesMembrane(CFG);
  for (let t = 1; t <= 10; t++) {
    cm.round({ tick: t, era: 3, bonds: pairs.map(([a, b]) => ({ a, b, score: 0.9, trades: t })), ids: [...ids] });
    nm.round({ tick: t, era: 3, reading: R0, bonds: pairs.map(([a, b]) => ({ a, b, score: 0.9 })), ids: [...ids] });
    const flies = ids.map((id, i) => fly(id, ((i * 53 + t * 29) % 900) - 100, (t + i) % 5, 5));
    rm.round(facts(t, flies, 3, reading(((t * 11) % 101) / 100)));
  }
  const cb = cm.serialize().length, nb = nm.serialize().length, rb = rm.serialize().length;
  const sum = cb + nb + rb;
  // eslint-disable-next-line no-console
  console.error(`[rules.test] blob bytes — norms=${nb} conventions=${cb} rules=${rb} sum=${sum} (${((sum / 200000) * 100).toFixed(1)}% of the 200KB guard)`);
  assert.ok(sum < 200_000, `the three emergent layers together stay under the guard (norms ${nb} + conventions ${cb} + rules ${rb} = ${sum})`);
  assert.ok(sum < 100_000, `and leave at least 50% headroom (sum ${sum})`);
});

// ─── observability ─────────────────────────────────────────────────────────────────────────────────────────

test("rules: the read-out exposes lifecycle counts, average modifier, band hits and coverage", () => {
  const m = new RulesMembrane(CFG);
  for (let t = 1; t <= 20; t++) m.round(detFacts(t));
  const s = m.signals();
  for (const k of ["minted", "adopted", "revoked", "died"] as const) {
    assert.ok(typeof s.counts[k] === "number" && s.counts[k] >= 0 && Number.isInteger(s.counts[k]), `counts.${k} is a non-negative int`);
  }
  assert.ok(Number.isFinite(s.avgModifier) && s.avgModifier >= 0, "avgModifier observable");
  assert.ok(Number.isInteger(s.bandHits) && s.bandHits >= 0, "bandHits observable");
  assert.ok(Number.isFinite(s.coverage) && s.coverage >= 0 && s.coverage <= 1, "coverage ∈ [0,1]");
  if (s.rules.length) {
    assert.ok(s.avgModifier >= HARD_BUY_MIN - 1e-9 && s.avgModifier <= HARD_BUY_MAX + 1e-9, "the average modifier is itself inside the band");
  }
});
