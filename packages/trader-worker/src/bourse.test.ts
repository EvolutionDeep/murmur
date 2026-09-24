// ⑲ THE BOURSE tests — the pure coin-tape core: reducer + meter + climate→stimulus mapping + config gates.
//
// coinStimuli() writes straight into the live neural input that drives REAL trades, and the tape it reads is
// ADVERSARIALLY CONTROLLABLE (anyone with tokens can transfer), so the invariants pinned here are the
// socialStimulus.ts discipline plus the burst-defence:
//   1. ZERO REGRESSION WHEN OFF / EMPTY — a null climate or a zero/NaN ceiling must emit NOTHING, so the
//      cron's stimulus array is byte-for-byte today's pendingStimuli. Both config switches default OFF.
//   2. BOUNDED + DETERMINISTIC — every intensity in [0, maxIntensity], at most three events, stable order
//      (brightness, threat, food), only the four visitor channels, no RNG/clock in the math.
//   3. BURST DEFENCE — reduceTransferLogs counts UNIQUE txs (a 100-leg airdrop is ONE event) and routes the
//      argus tax skim into a separate tithe FLOW (never volume, never whale).
//   4. EDGE HYSTERESIS — fever/silence are announced ONCE per spell; tithe milestones never re-speak.
//   5. PERSISTENCE — serialize/restore round-trips exactly; a corrupt blob restarts cold, never poisons.

import test from "node:test";
import assert from "node:assert/strict";

import {
  reduceTransferLogs,
  BourseMeter,
  coinStimuli,
  QUIET_CRONS,
  TRANSFER_TOPIC,
  type TransferLeg,
  type BourseSample,
  type CoinClimate,
  type CoinStimulusConfig,
} from "./bourse.js";
import { loadConfig, type Env } from "./config.js";

// ---------- helpers ----------

const CAP: CoinStimulusConfig = { maxIntensity: 0.35 };
const TAX = "0xc38e7c9e5cb1b59a53e892b938a7d79f0b741cb3";
const MURMUR = "0x8faae5592b9acc27a79fca745c6b872adf514a5d";
const MILESTONE = { titheMilestoneRaw: 5_000_000n * 10n ** 18n };
const E18 = 10n ** 18n;

function leg(from: string, to: string, murmur: number, txHash: string): TransferLeg {
  return {
    from, to, txHash,
    value: BigInt(Math.round(murmur)) * E18,
    blockNumber: 100,
  };
}

function reduce(legs: TransferLeg[], taxWallet: string | null = TAX, whaleMurmur = 1_000_000): BourseSample {
  return reduceTransferLogs(legs, {
    taxWallet,
    whaleRaw: BigInt(whaleMurmur) * E18,
    fromBlock: 1,
    toBlock: 100,
    fetchedAt: 1234,
  });
}

/** A synthetic per-cron sample (bypasses the reducer; drives the meter directly). */
function sample(o: Partial<BourseSample> = {}): BourseSample {
  return {
    fromBlock: 1,
    toBlock: 100,
    txCount: 2,
    transferCount: 2,
    volumeRaw: (10_000n * E18).toString(),
    taxRaw: "0",
    whaleCount: 0,
    whaleMaxRaw: "0",
    addresses: 4,
    fetchedAt: 1234,
    ...o,
  };
}

function climate(o: Partial<CoinClimate> = {}): CoinClimate {
  return { feverLevel: 0.5, quietCrons: 0, whaleExcess: null, titheCrossed: false, ...o };
}

function pick(events: { type: string; intensity: number }[], type: string) {
  return events.find((e) => e.type === type) ?? null;
}

function closeTo(actual: number, expected: number, msg?: string) {
  assert.ok(Math.abs(actual - expected) < 1e-9, `${msg ?? ""} expected ~${expected}, got ${actual}`);
}

function env(over: Partial<Env> = {}): Env {
  return {
    FLY_STATE: {} as Env["FLY_STATE"],
    CHAIN_ID: "5042002",
    RPC_URL: "https://rpc.testnet.arc.io",
    ...over,
  } as Env;
}

// ================= the ERC-20 Transfer topic (the only on-chain contract this layer relies on) =================

test("TRANSFER_TOPIC is keccak256(Transfer(address,address,uint256))", () => {
  assert.equal(TRANSFER_TOPIC, "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef");
});

// ================= reduceTransferLogs: the burst-defence reducer =================

test("zero legs reduce to a valid silent sample", () => {
  const s = reduce([]);
  assert.equal(s.txCount, 0);
  assert.equal(s.transferCount, 0);
  assert.equal(s.volumeRaw, "0");
  assert.equal(s.taxRaw, "0");
  assert.equal(s.whaleCount, 0);
  assert.equal(s.whaleMaxRaw, "0");
  assert.equal(s.addresses, 0);
  assert.equal(s.fromBlock, 1);
  assert.equal(s.toBlock, 100);
  assert.equal(s.fetchedAt, 1234);
});

test("legs INTO the tax wallet are the tithe flow — excluded from volume AND whale math", () => {
  const s = reduce([
    leg("0xaaa", "0xbbb", 2_000_000, "0x1"),      // main leg, whale-sized
    leg("0xaaa", TAX, 40_000, "0x1"),             // the 2% skim of the SAME tx
    leg("0xccc", TAX, 5_000, "0x2"),              // another skim
  ]);
  assert.equal(s.transferCount, 1, "only the main leg counts as activity");
  assert.equal(s.volumeRaw, (2_000_000n * E18).toString());
  assert.equal(s.taxRaw, (45_000n * E18).toString(), "both skims accumulate into the tithe flow");
  assert.equal(s.whaleCount, 1);
  assert.equal(s.txCount, 2, "unique tx hashes");
});

test("a null taxWallet simply means no leg is classified as tithe", () => {
  const s = reduce([leg("0xaaa", TAX, 100, "0x1")], null);
  assert.equal(s.transferCount, 1);
  assert.equal(s.taxRaw, "0");
  assert.equal(s.volumeRaw, (100n * E18).toString());
});

test("unique-tx counting: a 100-leg airdrop in ONE tx reads as ONE event", () => {
  const legs: TransferLeg[] = [];
  for (let i = 0; i < 100; i++) legs.push(leg("0xaaa", `0x${i.toString(16).padStart(4, "0")}`, 10, "0xsame"));
  const s = reduce(legs);
  assert.equal(s.txCount, 1, "one tx hash ⇒ one activity count, no matter how many legs");
  assert.equal(s.transferCount, 100, "legs still count as legs (volume is honest)");
  assert.equal(s.addresses, 101);
});

test("whale detection: legs at/above the threshold count, below do not; max is tracked", () => {
  const s = reduce([
    leg("0xa", "0xb", 999_999, "0x1"),
    leg("0xa", "0xc", 1_000_000, "0x2"),   // exactly the threshold ⇒ whale
    leg("0xa", "0xd", 2_500_000, "0x3"),   // the biggest
  ]);
  assert.equal(s.whaleCount, 2);
  assert.equal(s.whaleMaxRaw, (2_500_000n * E18).toString());
});

// ================= BourseMeter: baselines, edges, hysteresis =================

test("cold start: the first observation seeds the baseline; fever is calm (0.5) by definition", () => {
  const m = new BourseMeter();
  assert.equal(m.signals(), null, "no signals before the first update");
  assert.equal(m.lastBlock, 0);
  const s = m.update(sample({ txCount: 4, volumeRaw: (20_000n * E18).toString(), toBlock: 500 }), MILESTONE);
  closeTo(s.climate.feverLevel, 0.5, "logistic(1) = 0.5 — no norm existed, so no fever");
  assert.equal(s.fever, null);
  assert.equal(s.whale, null);
  assert.equal(s.tithe, null);
  assert.equal(s.silence, null);
  assert.equal(s.lastBlock, 500);
  assert.equal(m.lastBlock, 500);
});

test("a burst fires the fever edge ONCE per hot spell (hysteresis re-arms below the reset band)", () => {
  const m = new BourseMeter();
  m.update(sample({ txCount: 2 }), MILESTONE);           // prime: baseline 2 tx
  const hot = m.update(sample({ txCount: 30 }), MILESTONE);
  assert.ok(hot.fever, "a 15× burst breaks out");
  assert.equal(hot.fever!.txs, 30);
  closeTo(hot.fever!.mult, 9.4, "0.6·txRatio(15) + 0.4·volRatio(1) = 9.4 — breadth-weighted");
  assert.ok(hot.climate.feverLevel >= 0.75);
  const stillHot = m.update(sample({ txCount: 30 }), MILESTONE);
  assert.equal(stillHot.fever, null, "the spell is announced once, never re-spoken while fever holds");
  const cool = m.update(sample({ txCount: 0 }), MILESTONE);
  assert.ok(cool.climate.feverLevel < 0.65, "a silent cron cools below the reset band");
  const again = m.update(sample({ txCount: 30 }), MILESTONE);
  assert.ok(again.fever, "re-armed ⇒ a NEW hot spell speaks again");
});

test("a whale leg yields the edge + a bounded log-scaled excess (100× saturates at 1)", () => {
  const m = new BourseMeter();
  m.setWhaleHint(1_000_000);
  m.update(sample(), MILESTONE);
  const s = m.update(sample({ whaleCount: 1, whaleMaxRaw: (2_000_000n * E18).toString() }), MILESTONE);
  assert.ok(s.whale);
  closeTo(s.whale!.amountMurmur, 2_000_000);
  closeTo(s.climate.whaleExcess!, Math.log10(2) / 2, "log10(leg/threshold)/2");
  assert.equal(s.whaleTotal, 1);
  const lev = m.update(sample({ whaleCount: 1, whaleMaxRaw: (1_000_000_000n * E18).toString() }), MILESTONE);
  closeTo(lev.climate.whaleExcess!, 1, "a 1000× leviathan saturates at 1");
  const none = m.update(sample(), MILESTONE);
  assert.equal(none.whale, null);
  assert.equal(none.climate.whaleExcess, null, "no whale ⇒ null excess (the stimulus leg reads it as no threat)");
});

test("the tithe milestone speaks ONCE per crossing and carries the cumulative FLOW", () => {
  const m = new BourseMeter();
  m.update(sample({ taxRaw: (3_000_000n * E18).toString() }), MILESTONE);
  const cross = m.update(sample({ taxRaw: (2_500_000n * E18).toString() }), MILESTONE);
  assert.ok(cross.tithe, "5.5M total crosses the 5M milestone");
  closeTo(cross.tithe!.milestoneMurmur, 5_000_000);
  closeTo(cross.tithe!.totalMurmur, 5_500_000);
  assert.equal(cross.climate.titheCrossed, true);
  const after = m.update(sample({ taxRaw: (100n * E18).toString() }), MILESTONE);
  assert.equal(after.tithe, null, "no re-speak inside the same milestone band");
  assert.equal(after.climate.titheCrossed, false);
  closeTo(after.taxTotalMurmur, 5_500_100, "the flow keeps accumulating");
  const second = m.update(sample({ taxRaw: (4_500_000n * E18).toString() }), MILESTONE);
  assert.ok(second.tithe, "crossing 10M speaks again");
  closeTo(second.tithe!.milestoneMurmur, 10_000_000);
});

test("a zero milestone knob never divides by zero and never speaks a tithe", () => {
  const m = new BourseMeter();
  const s = m.update(sample({ taxRaw: (1_000n * E18).toString() }), { titheMilestoneRaw: 0n });
  assert.equal(s.tithe, null);
  closeTo(s.taxTotalMurmur, 1_000, "the flow is still tracked for /bourse");
});

test("silence: the dark edge fires once at QUIET_CRONS and re-arms on any activity", () => {
  const m = new BourseMeter();
  m.update(sample({ txCount: 1 }), MILESTONE);
  for (let i = 0; i < QUIET_CRONS - 1; i++) {
    const s = m.update(sample({ txCount: 0 }), MILESTONE);
    assert.equal(s.silence, null, `not yet at ${i + 1} quiet crons`);
  }
  const spoke = m.update(sample({ txCount: 0 }), MILESTONE);
  assert.ok(spoke.silence, `exactly QUIET_CRONS (${QUIET_CRONS}) silent crons ⇒ speaks`);
  assert.equal(spoke.silence!.crons, QUIET_CRONS);
  const held = m.update(sample({ txCount: 0 }), MILESTONE);
  assert.equal(held.silence, null, "a still spell is announced once");
  const active = m.update(sample({ txCount: 1 }), MILESTONE);
  assert.equal(active.climate.quietCrons, 0);
  // a fresh still spell re-arms and speaks again exactly once, at the QUIET_CRONS-th silent cron
  let spokeAgain = 0;
  for (let i = 0; i < QUIET_CRONS + 5; i++) {
    if (m.update(sample({ txCount: 0 }), MILESTONE).silence) spokeAgain++;
  }
  assert.equal(spokeAgain, 1, "re-armed ⇒ a NEW still spell speaks exactly once");
});

test("update() is deterministic: same stored state + same samples ⇒ identical signals", () => {
  const run = () => {
    const m = new BourseMeter();
    m.setWhaleHint(1_000_000);
    const seq = [
      sample({ txCount: 3 }),
      sample({ txCount: 20, whaleCount: 1, whaleMaxRaw: (3_000_000n * E18).toString() }),
      sample({ txCount: 0, taxRaw: (6_000_000n * E18).toString() }),
    ];
    return seq.map((s) => m.update(s, MILESTONE));
  };
  assert.deepEqual(run(), run());
});

// ================= persistence =================

test("serialize/restore round-trips the meter exactly (a DO eviction loses nothing)", () => {
  const m = new BourseMeter();
  m.setWhaleHint(250_000);
  m.update(sample({ txCount: 5, toBlock: 42, taxRaw: (1_000n * E18).toString() }), MILESTONE);
  m.update(sample({ txCount: 30, toBlock: 84, whaleCount: 1, whaleMaxRaw: (900_000n * E18).toString() }), MILESTONE);
  const blob = m.serialize();
  const n = new BourseMeter();
  n.restore(blob);
  assert.equal(n.lastBlock, m.lastBlock);
  const next = sample({ txCount: 7, toBlock: 120 });
  assert.deepEqual(n.update(next, MILESTONE), m.update(next, MILESTONE), "same continuation");
  assert.equal(n.serialize(), m.serialize(), "byte-identical state after the same fold");
});

test("a corrupt blob restarts cold — it can never poison the meter", () => {
  for (const junk of ["", "not json", "{}", "[]", '{"baselineTx": -5, "lastBlock": "x", "taxTotalRaw": "-1"}']) {
    const m = new BourseMeter();
    m.restore(junk);
    const s = m.update(sample({ txCount: 2 }), MILESTONE);
    assert.ok(Number.isFinite(s.climate.feverLevel));
    assert.ok(s.climate.feverLevel >= 0 && s.climate.feverLevel <= 1);
    assert.equal(m.lastBlock, 100);
  }
  const m = new BourseMeter();
  m.restore(123 as unknown);   // a non-string blob (e.g. a schema drift) is ignored, not thrown
  assert.equal(m.lastBlock, 0);
});

// ================= coinStimuli: the felt leg =================

test("a null climate (bourse off, or a cron the sampler skipped) emits NOTHING", () => {
  assert.deepEqual(coinStimuli(null, CAP), []);
});

test("a zero master ceiling emits NOTHING even for the most extreme tape", () => {
  const wild = climate({ feverLevel: 1, quietCrons: 999, whaleExcess: 1, titheCrossed: true });
  assert.deepEqual(coinStimuli(wild, { maxIntensity: 0 }), []);
});

test("a NaN ceiling (defence-in-depth) emits NOTHING rather than poisoning the connectome", () => {
  const wild = climate({ feverLevel: 1, quietCrons: 999, whaleExcess: 1, titheCrossed: true });
  assert.deepEqual(coinStimuli(wild, { maxIntensity: NaN }), []);
});

test("a calm tape (fever 0.5, no whale, no tithe, no silence) is never felt", () => {
  assert.deepEqual(coinStimuli(climate(), CAP), []);
});

test("non-finite climate fields never yield a NaN intensity", () => {
  const nasty = climate({ feverLevel: NaN, quietCrons: NaN, whaleExcess: NaN, titheCrossed: false });
  for (const e of coinStimuli(nasty, CAP)) assert.ok(Number.isFinite(e.intensity));
  const nasty2 = { feverLevel: Infinity, quietCrons: -1, whaleExcess: Infinity, titheCrossed: true } as CoinClimate;
  for (const e of coinStimuli(nasty2, CAP)) {
    assert.ok(Number.isFinite(e.intensity) && e.intensity >= 0 && e.intensity <= CAP.maxIntensity + 1e-12);
  }
});

test("fever above the onset tastes of plenty; full fever scales to FOOD_MAX × cap", () => {
  const full = coinStimuli(climate({ feverLevel: 1 }), CAP);
  assert.equal(full.length, 1);
  assert.equal(full[0].type, "food");
  closeTo(full[0].intensity, 0.7 * 0.35, "fever 1.0 ⇒ FOOD_MAX under the cap");
  assert.equal(full[0].from, "coin-climate");
  // below the onset, nothing appetitive
  assert.deepEqual(coinStimuli(climate({ feverLevel: 0.55 }), CAP), []);
  // monotonic in the fever band
  const lo = pick(coinStimuli(climate({ feverLevel: 0.7 }), CAP), "food")!.intensity;
  const hi = pick(coinStimuli(climate({ feverLevel: 0.9 }), CAP), "food")!.intensity;
  assert.ok(hi > lo, "a hotter tape smells stronger");
});

test("a whale stir startles: 0.35 base threat, up to 0.7 for a saturated leviathan", () => {
  const small = coinStimuli(climate({ whaleExcess: 0 }), CAP);
  assert.equal(small.length, 1);
  closeTo(small[0].intensity, 0.35 * 0.35, "THREAT_BASE under the cap");
  const big = coinStimuli(climate({ whaleExcess: 1 }), CAP);
  closeTo(big[0].intensity, 0.7 * 0.35, "THREAT_BASE + THREAT_WHALE_MAX under the cap");
  const mid = coinStimuli(climate({ whaleExcess: 0.5 }), CAP);
  closeTo(mid[0].intensity, (0.35 + 0.175) * 0.35);
});

test("a tithe milestone glows (light 0.45); a long silence dims (dark 0.25 deepening to 0.5)", () => {
  const glow = coinStimuli(climate({ titheCrossed: true }), CAP);
  assert.equal(glow.length, 1);
  assert.equal(glow[0].type, "light");
  closeTo(glow[0].intensity, 0.45 * 0.35);
  const dusk = coinStimuli(climate({ quietCrons: QUIET_CRONS }), CAP);
  assert.equal(dusk[0].type, "dark");
  closeTo(dusk[0].intensity, 0.25 * 0.35, "the onset dusk");
  const deep = coinStimuli(climate({ quietCrons: 240 }), CAP);
  closeTo(deep[0].intensity, 0.5 * 0.35, "four silent hours ⇒ the deepest dusk");
  const abyss = coinStimuli(climate({ quietCrons: 100_000 }), CAP);
  closeTo(abyss[0].intensity, 0.5 * 0.35, "…and it never darkens past DARK_MAX");
});

test("light and dark are NEVER both emitted (one net brightness axis, dominance by construction)", () => {
  for (const qc of [0, QUIET_CRONS, QUIET_CRONS + 10, 240, 10_000]) {
    for (const tithe of [false, true]) {
      const events = coinStimuli(climate({ quietCrons: qc, titheCrossed: tithe }), CAP);
      assert.ok(!(pick(events, "light") && pick(events, "dark")), `qc=${qc} tithe=${tithe} emitted both`);
    }
  }
});

test("at most three events, stable order (brightness, threat, food), no duplicate channels", () => {
  const events = coinStimuli(climate({ feverLevel: 1, whaleExcess: 1, titheCrossed: true }), CAP);
  assert.equal(events.length, 3);
  assert.deepEqual(events.map((e) => e.type), ["light", "threat", "food"]);
  for (const f of [0, 0.5, 1]) {
    for (const w of [null, 0, 1]) {
      for (const q of [0, QUIET_CRONS, 300]) {
        for (const t of [false, true]) {
          const ev = coinStimuli(climate({ feverLevel: f, whaleExcess: w, quietCrons: q, titheCrossed: t }), CAP);
          assert.ok(ev.length <= 3);
          const types = ev.map((e) => e.type);
          assert.equal(new Set(types).size, types.length);
          const order = types.map((x) => (x === "light" || x === "dark" ? 0 : x === "threat" ? 1 : 2));
          assert.deepEqual(order, [...order].sort((a, b) => a - b));
        }
      }
    }
  }
});

test("only the four visitor channels are ever used (no new sensory channel ⇒ manifestHash safe)", () => {
  const allowed = new Set(["food", "threat", "light", "dark"]);
  for (const f of [0, 0.6, 1]) {
    for (const w of [null, 1]) {
      for (const e of coinStimuli(climate({ feverLevel: f, whaleExcess: w, quietCrons: QUIET_CRONS, titheCrossed: true }), CAP)) {
        assert.ok(allowed.has(e.type), `unexpected channel ${e.type}`);
      }
    }
  }
});

test("every intensity is bounded by the master ceiling and scales with it proportionally", () => {
  const wild = climate({ feverLevel: 1, quietCrons: 0, whaleExcess: 1, titheCrossed: true });
  for (const cap of [0.05, 0.35, 0.5, 1]) {
    for (const e of coinStimuli(wild, { maxIntensity: cap })) {
      assert.ok(e.intensity >= 0 && e.intensity <= cap + 1e-12, `${e.type}=${e.intensity} out of [0,${cap}]`);
    }
  }
  const third = coinStimuli(wild, { maxIntensity: 0.35 });
  const full = coinStimuli(wild, { maxIntensity: 1 });
  for (let i = 0; i < third.length; i++) closeTo(full[i].intensity, third[i].intensity / 0.35, "linear in the cap");
});

test("coinStimuli is deterministic: the same climate always yields byte-identical events", () => {
  const c = climate({ feverLevel: 0.83, quietCrons: 12, whaleExcess: 0.4, titheCrossed: true });
  assert.deepEqual(coinStimuli(c, CAP), coinStimuli(c, CAP));
  assert.deepEqual(coinStimuli(c, { maxIntensity: 0.35 }), coinStimuli(c, CAP));
});

// ================= config gates (the dark deploy) =================

test("both switches default OFF; the defaults match the wrangler dark-deploy values", () => {
  const cfg = loadConfig(env());
  assert.equal(cfg.bourse.enabled, false, "BOURSE_ENABLED must default false (dark deploy)");
  assert.equal(cfg.tokenStimulus.enabled, false, "TOKEN_STIMULUS_ENABLED must default false");
  assert.equal(cfg.bourse.token, MURMUR, "the MURMUR CA is the default watch target");
  assert.equal(cfg.bourse.taxWallet, TAX, "the argus tax wallet is the default tithe sink");
  assert.equal(cfg.bourse.whaleRaw, (1_000_000n * E18).toString());
  assert.equal(cfg.bourse.lookbackBlocks, 1200);
  assert.equal(cfg.bourse.titheMilestoneRaw, (5_000_000n * E18).toString());
  closeTo(cfg.tokenStimulus.maxIntensity, 0.35, "the coin ceiling sits below the civic bus's 0.5");
});

test("the knobs parse + clamp exactly like the other membrane knobs", () => {
  const on = loadConfig(env({ BOURSE_ENABLED: "true", TOKEN_STIMULUS_ENABLED: "TRUE" }));
  assert.equal(on.bourse.enabled, true);
  assert.equal(on.tokenStimulus.enabled, true);
  assert.equal(loadConfig(env({ BOURSE_ENABLED: "nonsense" })).bourse.enabled, false);
  // whale threshold clamps into [1e3, 1e9] whole MURMUR
  assert.equal(loadConfig(env({ BOURSE_WHALE_MURMUR: "99999999999" })).bourse.whaleRaw, (1_000_000_000n * E18).toString());
  assert.equal(loadConfig(env({ BOURSE_WHALE_MURMUR: "1" })).bourse.whaleRaw, (1_000n * E18).toString());
  assert.equal(loadConfig(env({ BOURSE_WHALE_MURMUR: "junk" })).bourse.whaleRaw, (1_000_000n * E18).toString(), "fallback");
  // lookback clamps into [100, 7200] blocks; a non-finite value falls to the floor (clampInt's NaN guard)
  assert.equal(loadConfig(env({ BOURSE_LOOKBACK: "999999" })).bourse.lookbackBlocks, 7200);
  assert.equal(loadConfig(env({ BOURSE_LOOKBACK: "x" })).bourse.lookbackBlocks, 100);
  // the stimulus ceiling clamps into [0,1] with a NaN-safe 0.35 fallback
  closeTo(loadConfig(env({ TOKEN_STIMULUS_MAX: "0.9" })).tokenStimulus.maxIntensity, 0.9);
  closeTo(loadConfig(env({ TOKEN_STIMULUS_MAX: "5" })).tokenStimulus.maxIntensity, 1);
  closeTo(loadConfig(env({ TOKEN_STIMULUS_MAX: "-1" })).tokenStimulus.maxIntensity, 0);
  closeTo(loadConfig(env({ TOKEN_STIMULUS_MAX: "junk" })).tokenStimulus.maxIntensity, 0.35, "fallback");
  // an explicit empty token disables the membrane entirely
  assert.equal(loadConfig(env({ BOURSE_ENABLED: "true", BOURSE_TOKEN: "" })).bourse.token, null);
});
