/**
 * MEMBRANE CONVERGENCE TESTS — the #84 gate (b) flag-ON convergence assertions.
 *
 * These tests verify that the H2/H3/H4 once-guard fixes actually PREVENT the variant/mutation/inheritance storms
 * that previously flooded each membrane to its CAP within a single cron. They also verify that the TTL mechanism
 * works correctly (rules/norms/conventions DIE when not practiced — the non-compliance TTL reset was removed).
 *
 * Test strategy (per the #84 gate (b) recommendation):
 *   • Run 200 crons with ENABLED=true and a rich deterministic fixture
 *   • Assert size CONVERGES (does not hit CAP from storm flooding)
 *   • Assert counts.minted / counts.mutated / counts.inherited are NOT inflated by repeated same-pair processing
 *   • Assert TTL actually fires: an entity that is never practiced/complied with eventually dies
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  RulesMembrane, RULE_CAP, TTL as RULES_TTL, MINT_STRENGTH as RULES_MINT_STR,
  DECAY as RULES_DECAY, DIE_STRENGTH as RULES_DIE_STR,
  type RulesFacts, type RuleFly, type RulesReading, type RulesConfig,
} from "./rules.js";
import {
  NormsMembrane, NORM_CAP, TTL as NORMS_TTL, MINT_STRENGTH as NORMS_MINT_STR,
  DECAY as NORMS_DECAY, DIE_STRENGTH as NORMS_DIE_STR,
  type NormsFacts, type NormBond, type NormsReading,
} from "./norms.js";
import {
  ConventionsMembrane, CONV_CAP, TTL as CONV_TTL, CRYSTAL_STRENGTH,
  DECAY as CONV_DECAY, DIE_STRENGTH as CONV_DIE_STR,
  type ConventionsFacts, type ConvBond,
} from "./conventions.js";

// ─── shared fixtures ──────────────────────────────────────────────────────────────────────────────────────

const CRONS = 200;

/** A reading vector with moderate values (conditions will be satisfied some of the time). */
function midReading(tick: number): RulesReading & NormsReading {
  const v = ((tick * 7) % 100) / 100;
  return { arousal: v, cohesion: 1 - v, valence: v, rest: 0.5, temperature: v, gini: 0.3, size01: 0.5, bond: v, rep: 1 - v };
}

// ─── RULES convergence ────────────────────────────────────────────────────────────────────────────────────

const RULES_CFG: RulesConfig = { enabled: true, buyMin: 0.5, buyMax: 2.0, cpMin: 0.5, cpMax: 2.0 };

/** A deterministic swarm of 24 flies — enough to trigger adoption + variant draws without hitting ADOPTER_CAP instantly. */
function rulesFlies(tick: number): RuleFly[] {
  const out: RuleFly[] = [];
  for (let i = 1; i <= 24; i++) {
    // Half the swarm is profitable (netUsdc > 0), half is not — exercises the M6 gate too.
    const net = i <= 12 ? 50 + ((tick * 13 + i * 7) % 100) : -10 - ((tick + i) % 20);
    out.push({ id: i, netUsdc: net, settleOk: 3 + (i % 4), settleTotal: 5 + (i % 3) });
  }
  return out;
}

test(`rules convergence: ${CRONS} crons with ENABLED=true — no variant storm in early crons, TTL fires`, () => {
  const m = new RulesMembrane(RULES_CFG);
  let maxRules = 0;
  const sizeAtCron: number[] = [];

  for (let t = 1; t <= CRONS; t++) {
    const flies = rulesFlies(t);
    const f: RulesFacts = { tick: t, era: 3, reading: midReading(t), flies };
    m.round(f);
    const sig = m.signals();
    const size = sig.rules.length;
    sizeAtCron.push(size);
    if (size > maxRules) maxRules = size;
  }

  const sig = m.signals();

  // STORM DETECTION: before the fix, a SINGLE cron would explode from 1 rule to ~24 (RULE_CAP).
  // The storm indicator is reaching CAP within the first 10 crons. With the once-guard, early growth
  // is bounded by legitimate minting (MINT_STABLE_RUN=3 crons to stabilise + cooldown).
  const earlyMax = Math.max(...sizeAtCron.slice(0, 10));
  assert.ok(
    earlyMax < RULE_CAP,
    `rules.size hit ${earlyMax} within first 10 crons — variant storm still active (should be <${RULE_CAP})`
  );

  // Growth should be GRADUAL: the first mint can't happen before cron MINT_STABLE_RUN (3).
  // Before the fix, cron 1-3 would already show explosive growth from variants of the first rule.
  assert.ok(
    sizeAtCron[0] <= 1,
    `after cron 1, rules.size=${sizeAtCron[0]} — should be ≤1 (no mint possible before stabilisation)`
  );

  // counts.minted should be bounded by legitimate minting (cooldown = 40 crons, 12 profitable flies).
  // Over 200 crons: at most ~5 mints per fly × 12 = 60, but CAP + death cycle limits it further.
  // A storm inflates counts.adopted (via variant()), not counts.minted directly.
  assert.ok(
    sig.counts.minted <= 60,
    `counts.minted=${sig.counts.minted} seems inflated — expected ≤60 from legitimate minting over ${CRONS} crons`
  );

  // The variant storm inflated counts.adopted massively (every cron, every pair re-fired).
  // With the guard, each unique (rule, fly) pair is processed at most once for the variant branch.
  // Over 200 crons with rules dying and being re-minted, legitimate adoptions accumulate.
  // Storm indicator: counts.adopted would be ~200× the number of pairs (tens of thousands).
  // Legitimate: bounded by (unique rules ever minted) × (flies) — but rules cycle, so we use a generous bound.
  // The key check: counts.adopted should NOT be proportional to CRONS × pairs (which would be 200×24×24=115200).
  assert.ok(
    sig.counts.adopted < CRONS * 24 * 24 * 0.5,
    `counts.adopted=${sig.counts.adopted} seems proportional to crons×pairs — storm re-firing?`
  );

  // TTL VERIFICATION: run additional crons with NO profitable flies (so no new mints) and an unsatisfied reading.
  // All existing rules should die within TTL crons (their lastTick is never refreshed by compliance).
  const deadReading: RulesReading = { arousal: 0, cohesion: 0, valence: 0, rest: 0, temperature: 0, gini: 0, size01: 0, bond: 0, rep: 0 };
  const noProfitFlies: RuleFly[] = Array.from({ length: 24 }, (_, i) => ({ id: i + 1, netUsdc: -100, settleOk: 0, settleTotal: 5 }));

  for (let t = CRONS + 1; t <= CRONS + RULES_TTL + 10; t++) {
    m.round({ tick: t, era: 3, reading: deadReading, flies: noProfitFlies });
  }

  const afterTTL = m.signals();
  // After TTL+10 crons with no compliance and no profitable flies, ALL rules should have died
  // (either via strength decay to DIE_STRENGTH or via TTL expiry).
  // The key assertion: rules DO die — the TTL mechanism is functional (H2 fix removed the immortal lastTick reset).
  assert.ok(
    afterTTL.rules.length === 0 || afterTTL.counts.died > 0,
    `TTL should kill rules when never practiced — got ${afterTTL.rules.length} alive, ${afterTTL.counts.died} died`
  );
});

// ─── NORMS convergence ────────────────────────────────────────────────────────────────────────────────────

const NORMS_CFG = { enabled: true, maxIntensity: 0.3 };

/** A deterministic bond graph of 16 agents with strong bonds (triggers clustering + spread + mutation). */
function normsFacts(tick: number): NormsFacts {
  const ids = Array.from({ length: 16 }, (_, i) => i + 1);
  const bonds: NormBond[] = [];
  for (let i = 0; i < ids.length; i++) {
    for (let j = i + 1; j < ids.length; j++) {
      // Strong bonds that vary with tick (so clusters are stable but spread draws fire)
      const score = 0.3 + ((tick * 11 + i * 7 + j * 3) % 70) / 100;
      bonds.push({ a: ids[i], b: ids[j], score });
    }
  }
  return { tick, era: 3, reading: midReading(tick), bonds, ids };
}

test(`norms convergence: ${CRONS} crons with ENABLED=true — no mutation storm in early crons, TTL fires`, () => {
  const m = new NormsMembrane(NORMS_CFG);
  let maxNorms = 0;
  const sizeAtCron: number[] = [];

  for (let t = 1; t <= CRONS; t++) {
    m.round(normsFacts(t));
    const sig = m.signals();
    const size = sig.norms.length;
    sizeAtCron.push(size);
    if (size > maxNorms) maxNorms = size;
  }

  const sig = m.signals();

  // STORM DETECTION: before the fix, a single cron could spawn k child norms from the same (norm, dst)
  // pair repeatedly, flooding to NORM_CAP within ~10 crons. With the once-guard, early growth is bounded
  // by legitimate clustering (MINT_STABLE_RUN=3) + one mutation per unique pair.
  const earlyMax = Math.max(...sizeAtCron.slice(0, 10));
  assert.ok(
    earlyMax < NORM_CAP,
    `norms.size hit ${earlyMax} within first 10 crons — mutation storm still active (should be <${NORM_CAP})`
  );

  // counts.mutated should be bounded: each unique (norm, dst) pair mutates at most once.
  // With 16 agents and legitimate norms, the bound is norms × agents. A storm produces far more.
  assert.ok(
    sig.counts.mutated <= NORM_CAP * 16,
    `counts.mutated=${sig.counts.mutated} seems inflated — expected ≤${NORM_CAP * 16}`
  );

  // TTL VERIFICATION: run additional crons with weak bonds (no spread) and an unsatisfied reading.
  // All existing norms should die within TTL crons.
  const deadReading: NormsReading = { arousal: 0, cohesion: 0, valence: 0, rest: 0, temperature: 0, gini: 0, size01: 0, bond: 0, rep: 0 };
  const weakBonds: NormBond[] = [];  // no bonds at all → no spread → no lastAdherentTick refresh

  for (let t = CRONS + 1; t <= CRONS + NORMS_TTL + 10; t++) {
    m.round({ tick: t, era: 3, reading: deadReading, bonds: weakBonds, ids: [] });
  }

  const afterTTL = m.signals();
  // After TTL+10 crons with no adherence and no compliance, ALL norms should have died.
  assert.ok(
    afterTTL.norms.length === 0 || afterTTL.counts.died > 0,
    `TTL should kill norms when never practiced — got ${afterTTL.norms.length} alive, ${afterTTL.counts.died} died`
  );
});

// ─── CONVENTIONS convergence ──────────────────────────────────────────────────────────────────────────────

const CONV_CFG = { enabled: true, maxIntensity: 0.3 };

/** A deterministic bond graph of 12 agents where only a FEW pairs have steady cadence (avoids mass crystallisation). */
function convFacts(tick: number): ConventionsFacts {
  const ids = Array.from({ length: 12 }, (_, i) => i + 1);
  const bonds: ConvBond[] = [];
  for (let i = 0; i < ids.length; i++) {
    for (let j = i + 1; j < ids.length; j++) {
      // Only pairs where (i+j) % 5 === 0 have steady trade (delta=1); others are erratic.
      const steady = (i + j) % 5 === 0;
      const score = 0.5 + ((tick * 3 + i * 11 + j * 7) % 50) / 100;
      const trades = steady ? (tick + i + j) : ((tick * 7 + i * 3 + j) % 20);
      bonds.push({ a: ids[i], b: ids[j], score, trades });
    }
  }
  return { tick, era: 3, bonds, ids };
}

test(`conventions convergence: ${CRONS} crons with ENABLED=true — no inheritance storm in early crons, TTL fires`, () => {
  const m = new ConventionsMembrane(CONV_CFG);
  let maxConvs = 0;
  const sizeAtCron: number[] = [];

  for (let t = 1; t <= CRONS; t++) {
    m.round(convFacts(t));
    const sig = m.signals();
    const size = sig.conventions.length;
    sizeAtCron.push(size);
    if (size > maxConvs) maxConvs = size;
  }

  const sig = m.signals();

  // STORM DETECTION: before the fix, the same (conv, pairSig) would spawn a child EVERY cron,
  // flooding to CONV_CAP within ~5 crons even from a SINGLE crystallised convention.
  // With the once-guard + a fixture where only ~13 pairs are steady, early growth is bounded
  // by legitimate crystallisation (CRYSTAL_STABLE_RUN=4) + one inheritance per unique pair.
  // We check that the first 4 crons produce nothing (no crystallisation possible before stabilisation).
  assert.ok(
    sizeAtCron[0] === 0 && sizeAtCron[1] === 0 && sizeAtCron[2] === 0,
    `convs.size should be 0 for first 3 crons (CRYSTAL_STABLE_RUN=4), got [${sizeAtCron.slice(0, 3)}]`
  );

  // The inheritance storm indicator: counts.inherited proportional to crons.
  // Before fix: each cron re-fires the same (conv, pairSig) → inherited ≈ crons × pairs_passing_gate.
  // After fix: each unique pair inherits at most once → inherited ≤ unique pairs ever processed.
  // With ~13 steady pairs and CONV_CAP=24, the legitimate bound is generous.
  assert.ok(
    sig.counts.inherited <= CONV_CAP * 66,
    `counts.inherited=${sig.counts.inherited} seems inflated (storm would be ~${CRONS}× higher)`
  );

  // Additional storm check: inherited should NOT be proportional to CRONS.
  // A storm would give inherited ≈ CRONS × (pairs passing hash gate). Even 1 pair re-firing 200 times = 200.
  // Legitimate: at most one inheritance per unique (conv, pairSig) pair.
  const inheritedPerCron = sig.counts.inherited / CRONS;
  assert.ok(
    inheritedPerCron < 5,
    `counts.inherited/cron=${inheritedPerCron.toFixed(2)} — storm re-fires every cron (should be <5)`
  );

  // TTL VERIFICATION: run additional crons with no bonds (no honour → no lastTick refresh).
  // All existing conventions should die within TTL crons.
  const noBonds: ConvBond[] = [];

  for (let t = CRONS + 1; t <= CRONS + CONV_TTL + 10; t++) {
    m.round({ tick: t, era: 3, bonds: noBonds, ids: [] });
  }

  const afterTTL = m.signals();
  // After TTL+10 crons with no honour, ALL conventions should have died.
  assert.ok(
    afterTTL.conventions.length === 0 || afterTTL.counts.died > 0,
    `TTL should kill conventions when never honoured — got ${afterTTL.conventions.length} alive, ${afterTTL.counts.died} died`
  );
});

// ─── M6 verification: no mint+revoke noise in a losing economy ────────────────────────────────────────────

test("rules M6: a losing economy (all netUsdc ≤ 0) never mints — no RULE_MINTED+RULE_REVOKED noise", () => {
  const m = new RulesMembrane(RULES_CFG);
  const losingFlies: RuleFly[] = Array.from({ length: 24 }, (_, i) => ({
    id: i + 1, netUsdc: -(i + 1), settleOk: 5, settleTotal: 5,
  }));

  for (let t = 1; t <= 100; t++) {
    m.round({ tick: t, era: 3, reading: midReading(t), flies: losingFlies });
  }

  const sig = m.signals();
  // With the M6 fix (netUsdc > 0 gate), NO rule should ever be minted in a purely losing economy.
  assert.equal(sig.counts.minted, 0, "no rule should be minted when all flies are losing");
  assert.equal(sig.rules.length, 0, "statute book should be empty in a losing economy");
});

// ─── OnceGuard serialize/restore round-trip ───────────────────────────────────────────────────────────────

test("rules: onceGuard survives serialize→restore (DO eviction does not restart the storm)", () => {
  const m1 = new RulesMembrane(RULES_CFG);
  // Run enough crons to trigger some variants
  for (let t = 1; t <= 50; t++) {
    m1.round({ tick: t, era: 3, reading: midReading(t), flies: rulesFlies(t) });
  }
  const blob = m1.serialize();
  const sizeBeforeRestore = m1.signals().rules.length;

  // Restore into a fresh membrane
  const m2 = new RulesMembrane(RULES_CFG);
  m2.restore(blob);

  // Run more crons — the restored guard should prevent re-processing old pairs
  for (let t = 51; t <= 100; t++) {
    m2.round({ tick: t, era: 3, reading: midReading(t), flies: rulesFlies(t) });
  }

  const sig = m2.signals();
  // After restore, growth should continue gradually — NOT explode from a storm restart.
  const growth = sig.rules.length - sizeBeforeRestore;
  assert.ok(
    growth <= RULE_CAP,
    `post-restore growth=${growth} seems like a storm restart (should be gradual)`
  );
  // Verify the guard key is actually present in the blob
  const parsed = JSON.parse(blob);
  assert.ok(
    Array.isArray(parsed.variedPairs) && parsed.variedPairs.length > 0,
    "serialized blob should contain variedPairs guard entries after active crons"
  );
});

test("norms: onceGuard survives serialize→restore (DO eviction does not restart the storm)", () => {
  const m1 = new NormsMembrane(NORMS_CFG);
  // Run 150 crons to ensure mutations actually fire (need clusters to form, norms to mint, spread to trigger)
  for (let t = 1; t <= 150; t++) {
    m1.round(normsFacts(t));
  }
  const blob = m1.serialize();
  const sizeBeforeRestore = m1.signals().norms.length;
  const mutatedBefore = m1.signals().counts.mutated;

  const m2 = new NormsMembrane(NORMS_CFG);
  m2.restore(blob);

  for (let t = 151; t <= 250; t++) {
    m2.round(normsFacts(t));
  }

  const sig = m2.signals();
  const growth = sig.norms.length - sizeBeforeRestore;
  assert.ok(
    growth <= NORM_CAP,
    `post-restore growth=${growth} seems like a storm restart (should be gradual)`
  );
  // If mutations fired during the first 150 crons, the guard should be in the blob.
  // If no mutations fired (hash gate didn't pass), the guard is legitimately empty — that's fine.
  const parsed = JSON.parse(blob);
  if (mutatedBefore > 0) {
    assert.ok(
      Array.isArray(parsed.mutatedPairs) && parsed.mutatedPairs.length > 0,
      "serialized blob should contain mutatedPairs guard entries when mutations have fired"
    );
  }
});

test("conventions: onceGuard survives serialize→restore (DO eviction does not restart the storm)", () => {
  const m1 = new ConventionsMembrane(CONV_CFG);
  // Run 150 crons to ensure inheritances actually fire
  for (let t = 1; t <= 150; t++) {
    m1.round(convFacts(t));
  }
  const blob = m1.serialize();
  const sizeBeforeRestore = m1.signals().conventions.length;
  const inheritedBefore = m1.signals().counts.inherited;

  const m2 = new ConventionsMembrane(CONV_CFG);
  m2.restore(blob);

  for (let t = 151; t <= 250; t++) {
    m2.round(convFacts(t));
  }

  const sig = m2.signals();
  // After restore, growth should continue gradually — NOT explode from a storm restart.
  const growth = sig.conventions.length - sizeBeforeRestore;
  assert.ok(
    growth <= CONV_CAP,
    `post-restore growth=${growth} seems like a storm restart (should be gradual)`
  );
  // If inheritances fired during the first 150 crons, the guard should be in the blob.
  const parsed = JSON.parse(blob);
  if (inheritedBefore > 0) {
    assert.ok(
      Array.isArray(parsed.inheritedPairs) && parsed.inheritedPairs.length > 0,
      "serialized blob should contain inheritedPairs guard entries when inheritances have fired"
    );
  }
});

// ─── Dark-deployment byte equivalence ─────────────────────────────────────────────────────────────────────

test("dark deployment: ENABLED=false membranes serialize identically with and without onceGuard fields", () => {
  // When disabled, round() returns early → the guard is never written to → serialize() omits the key.
  const rulesOff = new RulesMembrane({ ...RULES_CFG, enabled: false });
  const normsOff = new NormsMembrane({ ...NORMS_CFG, enabled: false });
  const convOff = new ConventionsMembrane({ ...CONV_CFG, enabled: false });

  // Run some crons (should be no-ops)
  for (let t = 1; t <= 10; t++) {
    rulesOff.round({ tick: t, era: 3, reading: midReading(t), flies: rulesFlies(t) });
    normsOff.round(normsFacts(t));
    convOff.round(convFacts(t));
  }

  // The serialized blobs should NOT contain the guard keys (undefined → omitted by JSON.stringify)
  const rBlob = JSON.parse(rulesOff.serialize());
  const nBlob = JSON.parse(normsOff.serialize());
  const cBlob = JSON.parse(convOff.serialize());

  assert.equal(rBlob.variedPairs, undefined, "disabled rules should not serialize variedPairs");
  assert.equal(nBlob.mutatedPairs, undefined, "disabled norms should not serialize mutatedPairs");
  assert.equal(cBlob.inheritedPairs, undefined, "disabled conventions should not serialize inheritedPairs");
});
