// On-chain house WAR + TAXATION tests — the pure coffer decision engine + the config gates that keep it inert.
//
// WarCoffer moves REAL USDC: the Worker is the contract's authorized resolver and its deposit / declareWar /
// resolveWar / levyTax calls cost real gas and escrow bounded stakes. So, exactly like arena.test.ts, the two
// things that MUST be pinned are:
//   1. ZERO REGRESSION WHEN OFF — disabled by default; every gate (config disabled, blank address, simulated
//      facilitator) must leave the tick byte-for-byte unchanged and never emit a coffer write.
//   2. RESOLVER + WINNER CORRECTNESS — which war to declare/resolve is a PURE function of (now, cadence,
//      cursor); and the winner must be derivable INDEPENDENTLY by anyone from the inputs committed at declare.
//      `winnerOf` is kept BYTE-FOR-BYTE with WarCoffer._deriveWinner, so a divergence here = a mis-settled
//      payout there. The strongest check below re-derives the contract's keccak draw a SECOND, hand-rolled way
//      (manual 32-byte padding == Solidity abi.encodePacked) and requires war.ts to agree on every vector.

import test from "node:test";
import assert from "node:assert/strict";
import { keccak256 } from "viem";

import {
  planWar, cursorAfterWarOpen, housePower, stakeOf, taxLevy, feudPairs, winnerOf, warRoll, pairKey,
  WIN_NONE, WIN_ATTACKER, WIN_DEFENDER,
  type WarCursor, type WarConfig, type WarHouse, type HouseFeud,
} from "./war.js";
import { loadConfig, type Env } from "./config.js";
import { AgentEconomy, type EconomyConfig } from "./economy.js";

// ---------- helpers ----------

/** A minimal, valid Env (only the three required fields matter for config parsing; the rest default). */
function env(over: Partial<Env> = {}): Env {
  return {
    FLY_STATE: {} as Env["FLY_STATE"],
    CHAIN_ID: "5042002",
    RPC_URL: "https://rpc.testnet.arc.io",
    ...over,
  } as Env;
}

/** Deterministic simulated-mode economy config (no keys, no chain, no RPC). */
function econCfg(over: Partial<EconomyConfig> = {}): EconomyConfig {
  return {
    enabled: true,
    network: "arc",
    initialBalanceUsdc: 6,
    basePriceUsdc: 0.002,
    solvencyFloorUsdc: 0.5,
    maxDealsPerTick: 24,
    facilitatorMode: "simulated",
    seedBase: 42,
    realSpendEnabled: false,
    dailyCapUsdc: 0,
    perAgentDailyCapUsdc: 0,
    maxDealUsdc: 0.05,
    netMinBroadcastUsdc: 0.004,
    netFlushTicks: 30,
    populationSize: 24,
    hatchSeedUsdc: 0.002,
    ...over,
  };
}

function warCfg(over: Partial<WarConfig> = {}): WarConfig {
  return {
    stakePct: 0.05,
    minVaultUsdc: 1,
    perWarCapUsdc: 5,
    maxEscrowUsdc: 50,
    warCadenceSec: 3600,
    feudThreshold: -0.6,
    taxPct: 0.01,
    taxDest: "coffer",
    bootstrap: false,
    ...over,
  };
}

function house(id: number, over: Partial<WarHouse> = {}): WarHouse {
  return { id, live: 3, gen: 1, earnedUsdc: 10, capitalShare: 0.1, vaultOnchainUsdc: 20, ...over };
}

const FRESH: WarCursor = { openedWar: -1, resolvedWar: -1 };
const CAD = 3600; // 1-hour war buckets

// Organic-conflict knobs + a stable genome hash, for the end-to-end aggregation↔war-candidate test below.
const HASH_A = "a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90";
const HASH_B = "0f1e2d3c4b5a69788796a5b4c3d2e1f00f1e2d3c4b5a69788796a5b4c3d2e1f0";
type ConflictKnobs = NonNullable<EconomyConfig["conflict"]>;
function econConflict(on: boolean, over: Partial<ConflictKnobs> = {}): ConflictKnobs {
  return { enabled: on, rivalStep: 0, envyStep: 0, embargoStep: 0, raidStep: 0, raidProb: 0, feudBlend: 0, ...over };
}

// ---------- planWar: the resolver's declare/resolve timing (a pure function of now + cursor) ----------

test("a fresh resolver declares the live bucket and does NOT resolve a bucket it never declared", () => {
  const now = 1_000 * CAD + 1234; // mid-way through bucket 1000
  const plan = planWar(now, CAD, FRESH);
  assert.equal(plan.cur, 1000);
  assert.equal(plan.prev, 999);
  assert.equal(plan.declareWar, 1000, "declares the current bucket");
  assert.equal(plan.resolveWar, null, "prev was never declared by us ⇒ nothing to resolve");
  assert.equal(plan.declareDeadline, 1001 * CAD, "the war is resolvable exactly when the next bucket opens");
});

test("in steady state the resolver closes prev and declares cur", () => {
  const now = 1_001 * CAD + 10;
  const plan = planWar(now, CAD, { openedWar: 1000, resolvedWar: 999 });
  assert.equal(plan.cur, 1001);
  assert.equal(plan.resolveWar, 1000, "resolves the bucket that just closed");
  assert.equal(plan.declareWar, 1001, "declares the new bucket");
  assert.equal(plan.declareDeadline, 1002 * CAD);
});

test("the plan is idempotent: re-running inside the same bucket writes nothing", () => {
  const now = 1_001 * CAD + 999;
  const plan = planWar(now, CAD, { openedWar: 1001, resolvedWar: 1000 });
  assert.equal(plan.declareWar, null, "cur already declared");
  assert.equal(plan.resolveWar, null, "prev already resolved");
});

test("a missed resolve is retried on the next cron (self-healing within the stale grace)", () => {
  const now = 1_001 * CAD + 5;
  const plan = planWar(now, CAD, { openedWar: 1001, resolvedWar: 999 });
  assert.equal(plan.resolveWar, 1000, "retries the unresolved bucket");
  assert.equal(plan.declareWar, null, "does not re-declare the already-declared live war");
});

test("the very first bucket (cur=0) declares but never resolves a negative bucket", () => {
  const plan = planWar(10, CAD, FRESH);
  assert.equal(plan.cur, 0);
  assert.equal(plan.prev, -1);
  assert.equal(plan.declareWar, 0);
  assert.equal(plan.resolveWar, null, "prev < 0 ⇒ guard holds");
  assert.equal(plan.declareDeadline, CAD);
});

// ---------- cursorAfterWarOpen: the fresh-start baseline that prevents a resolve gas-drain ----------

test("a fresh first declare baselines resolvedWar to warId-1 so the un-declared prev is never chased", () => {
  const c = cursorAfterWarOpen(FRESH, 1000);
  assert.equal(c.openedWar, 1000);
  assert.equal(c.resolvedWar, 999, "prev (999) marked handled — the coffer reverts resolveWar on a never-opened war");
});

test("REGRESSION: after a fresh declare, every later cron in the SAME bucket writes nothing", () => {
  const now = 1_000 * CAD + 1234;
  const declared = cursorAfterWarOpen(FRESH, planWar(now, CAD, FRESH).declareWar!);
  const plan = planWar(now + 60, CAD, declared);
  assert.equal(plan.declareWar, null, "cur already declared");
  assert.equal(plan.resolveWar, null, "prev baselined as resolved ⇒ NO dead resolve chase ⇒ no wasted gas");
});

test("the bucket AFTER a fresh start resolves cur normally (cur genuinely was declared)", () => {
  const declared = cursorAfterWarOpen(FRESH, 1000); // {1000, 999}
  const plan = planWar(1_001 * CAD + 5, CAD, declared);
  assert.equal(plan.resolveWar, 1000, "the war we truly declared is resolved");
  assert.equal(plan.declareWar, 1001, "and the next bucket declares");
});

test("steady-state declare leaves resolvedWar untouched (the resolve step owns it)", () => {
  const c = cursorAfterWarOpen({ openedWar: 1000, resolvedWar: 999 }, 1001);
  assert.equal(c.openedWar, 1001);
  assert.equal(c.resolvedWar, 999, "no baseline once we've declared before");
});

// ---------- housePower: the committed power, always positive, monotonic in wealth ----------

test("housePower is always >= 1 and depends only on public read-outs", () => {
  assert.ok(housePower(house(1, { capitalShare: 0, live: 0, earnedUsdc: 0, gen: 0 })) >= 1, "a destitute house still fields power 1");
  const poor = housePower(house(1, { capitalShare: 0.05 }));
  const rich = housePower(house(1, { capitalShare: 0.5 }));
  assert.ok(rich > poor, "capital share dominates the committed power");
  assert.equal(housePower(house(7, { capitalShare: 0.2, live: 4, gen: 2, earnedUsdc: 9 })), housePower(house(999, { capitalShare: 0.2, live: 4, gen: 2, earnedUsdc: 9 })), "power ignores the house id");
});

test("housePower: powerPerZone defaults to 0 (byte-for-byte the pre-territory power) and weights held ground when armed", () => {
  const h = house(1, { capitalShare: 0.2, live: 4, gen: 2, earnedUsdc: 9, zonesControlled: 3 });
  // Default (no second arg) == an explicit 0: the committed power is byte-for-byte the pre-territory value, so
  // the winnerOf lock-step with WarCoffer._deriveWinner is untouched unless TERR_POWER_PER_ZONE is armed.
  assert.equal(housePower(h), housePower(h, 0), "powerPerZone defaults to 0");
  const base = housePower({ ...h, zonesControlled: 0 }, 0);   // cap 200 + pop 100 + earn 30 + gen 2 = 332
  assert.equal(housePower(h, 0), base, "with powerPerZone=0 the zones a house holds add NOTHING");
  // Armed: each controlled zone adds exactly powerPerZone, monotonic in the zone count.
  assert.equal(housePower(h, 10), base + 30, "3 zones × 10 power/zone = +30");
  assert.ok(housePower(h, 10) > housePower(h, 0), "held ground is power once armed");
  assert.ok(housePower({ ...h, zonesControlled: 5 }, 10) > housePower(h, 10), "more zones ⇒ more power");
  // A house with NO zonesControlled key at all (territory off ⇒ warHouses emits none) is unaffected by powerPerZone.
  const noKey = house(1, { capitalShare: 0.2, live: 4, gen: 2, earnedUsdc: 9 });
  assert.equal(housePower(noKey, 10), housePower(noKey, 0), "absent zonesControlled ⇒ no land bonus even when armed");
});

// ---------- stakeOf: the bounded, symmetric stake ----------

test("stakeOf returns 0 when either vault is below the minimum (no dust wars)", () => {
  const c = warCfg({ minVaultUsdc: 10 });
  assert.equal(stakeOf(5, 100, c), 0, "attacker side too poor");
  assert.equal(stakeOf(100, 5, c), 0, "defender side too poor");
  assert.equal(stakeOf(100, 100, c), 5, "100 * 0.05 stake a side once both clear the floor");
});

test("stakeOf sizes off the SMALLER vault and never exceeds the per-war cap", () => {
  const c = warCfg({ stakePct: 0.1, perWarCapUsdc: 5, minVaultUsdc: 1 });
  assert.equal(stakeOf(10, 1000, c), 1, "10% of the SMALLER (10) = 1");
  assert.equal(stakeOf(1000, 1000, c), 5, "10% of 1000 would be 100 but the cap binds at 5");
});

// ---------- taxLevy: bounded, never overdraws ----------

test("taxLevy is a bounded fraction of the vault and 0 for an empty vault", () => {
  const c = warCfg({ taxPct: 0.01 });
  assert.equal(taxLevy(0, c), 0, "nothing to levy");
  assert.equal(taxLevy(-5, c), 0, "never negative");
  assert.equal(taxLevy(100, c), 1, "1% tithe-like skim");
  // A pathological 100% tax can never overdraw the vault it draws from.
  assert.equal(taxLevy(3, warCfg({ taxPct: 1 })), 3, "clamped to the vault itself");
});

// ---------- feudPairs: the deep-feud gate, vault gate, cooldown, ordering ----------

test("feudPairs admits only a bond at/below the threshold where BOTH sides can fund a stake", () => {
  const c = warCfg({ feudThreshold: -0.6, minVaultUsdc: 1 });
  const houses = [house(1, { capitalShare: 0.1 }), house(2, { capitalShare: 0.2 })];
  const feuds: HouseFeud[] = [
    { a: 1, b: 2, score: -0.5 },  // not deep enough
    { a: 3, b: 4, score: -0.7 },  // deep, but houses 3/4 unknown
  ];
  assert.deepEqual(feudPairs(houses, feuds, c, 1000, {}), [], "a -0.5 bond is not war");

  const deep: HouseFeud[] = [{ a: 1, b: 2, score: -0.8 }];
  const bouts = feudPairs(houses, deep, c, 1000, {});
  assert.equal(bouts.length, 1);
  assert.equal(bouts[0].attacker, 1, "the poorer house (lower capitalShare) attacks up");
  assert.equal(bouts[0].defender, 2);
});

test("feudPairs respects the per-pair cooldown (a freshly-fought pair cannot immediately re-fund)", () => {
  const c = warCfg({ feudThreshold: -0.6, minVaultUsdc: 1, warCadenceSec: 3600 });
  const houses = [house(1), house(2)];
  const feuds: HouseFeud[] = [{ a: 1, b: 2, score: -0.9 }];
  const key = pairKey(1, 2);
  assert.equal(feudPairs(houses, feuds, c, 5_000, { [key]: 4_000 }).length, 0, "1000s < cadence ⇒ cooling");
  assert.equal(feudPairs(houses, feuds, c, 5_000, { [key]: 1_000 }).length, 1, "4000s ≥ cadence ⇒ may feud again");
});

test("feudPairs orders the deepest feud first", () => {
  const c = warCfg({ feudThreshold: -0.6, minVaultUsdc: 1 });
  const houses = [house(1), house(2), house(3), house(4)];
  const feuds: HouseFeud[] = [
    { a: 1, b: 2, score: -0.7 },
    { a: 3, b: 4, score: -0.95 }, // deeper
  ];
  const bouts = feudPairs(houses, feuds, c, 1000, {});
  assert.equal(bouts.length, 2);
  assert.deepEqual(bouts[0], { attacker: 3, defender: 4 }, "the -0.95 blood feud leads");
});

test("feudPairs bootstrap mode lifts the VAULT gate only: the deepest feud is picked even with EMPTY vaults (cold-start)", () => {
  // Two houses that HATE each other but hold nothing on-chain — the exact cold-start deadlock: stakeOf <= 0 so the
  // vault gate skips them, driveWar never funds a vault, and the first war can never begin. bootstrap=true lifts
  // ONLY the vault gate (the feud threshold + cooldown still hold), so driveWar can fund the deepest feud first.
  const houses = [house(1, { vaultOnchainUsdc: 0, capitalShare: 0.1 }), house(2, { vaultOnchainUsdc: 0, capitalShare: 0.2 })];
  const feuds: HouseFeud[] = [{ a: 1, b: 2, score: -0.9 }];
  const gated = warCfg({ feudThreshold: -0.6, minVaultUsdc: 1, bootstrap: false });
  const boot = warCfg({ feudThreshold: -0.6, minVaultUsdc: 1, bootstrap: true });
  assert.equal(feudPairs(houses, feuds, gated, 1000, {}).length, 0, "bootstrap OFF ⇒ empty vaults ⇒ gated out (today's inert deadlock)");
  const bouts = feudPairs(houses, feuds, boot, 1000, {});
  assert.equal(bouts.length, 1, "bootstrap ON ⇒ the vault gate is lifted ⇒ the deepest feud surfaces");
  assert.deepEqual(bouts[0], { attacker: 1, defender: 2 }, "the poorer house still attacks up");
  // The feud gate is NOT lifted: a shallow bond is still not war, even in bootstrap mode.
  const shallow: HouseFeud[] = [{ a: 1, b: 2, score: -0.3 }];
  assert.equal(feudPairs(houses, shallow, boot, 1000, {}).length, 0, "bootstrap lifts the VAULT gate only, never the feud threshold");
  // The per-pair cooldown still applies under bootstrap (a freshly-fought pair cannot immediately re-fund).
  assert.equal(feudPairs(houses, feuds, boot, 5000, { [pairKey(1, 2)]: 4000 }).length, 0, "the cooldown holds under bootstrap");
});

test("pairKey is order-independent", () => {
  assert.equal(pairKey(5, 2), pairKey(2, 5));
  assert.equal(pairKey(2, 5), "2-5");
});

test("the conflict blend aggregation unblocks feudPairs: a diluted cluster of grudges is war once weighted, not on the pure mean", () => {
  // Two houses with real (positive) vaults, plus a HAND-CRAFTED cross-house bond cluster: three -1 grudges and
  // two -0.5 grudges diluted by three +0.2 friendly bonds — a cluster five bonds deep, since FEUD_WORST_K=5 now
  // averages the five worst (was three). This is the exact shape that kept a war from ever surfacing while
  // houseFeuds was a pure mean — the ONLY thing that changes the outcome is the feudBlend aggregation.
  const base = new AgentEconomy(econCfg({ dynasty: {} }));
  base.noteHatch(2, 10, HASH_A);
  base.noteHatch(5, 15, HASH_B);
  base.setVaultOnchain(2, "20000000");                                // 20 USDC escrowed on-chain each
  base.setVaultOnchain(5, "20000000");
  const p = JSON.parse(base.serialize());
  const fr = { trades: 0, lastTick: 0 };
  p.social = {
    mem: [
      { id: 2, rep: 0, repTick: 0, kept: 0, broken: 0, bonds: [{ other: 5, score: -1, ...fr }, { other: 15, score: -0.5, ...fr }] },
      { id: 10, rep: 0, repTick: 0, kept: 0, broken: 0, bonds: [{ other: 5, score: -1, ...fr }, { other: 15, score: 0.2, ...fr }] },
      { id: 5, rep: 0, repTick: 0, kept: 0, broken: 0, bonds: [{ other: 2, score: -1, ...fr }, { other: 10, score: -0.5, ...fr }] },
      { id: 15, rep: 0, repTick: 0, kept: 0, broken: 0, bonds: [{ other: 2, score: 0.2, ...fr }, { other: 10, score: 0.2, ...fr }] },
    ],
    grudges: [],
  };
  const blob = JSON.stringify(p);
  const wc = warCfg({ feudThreshold: -0.6, minVaultUsdc: 1 });

  const meanEcon = new AgentEconomy(econCfg({ dynasty: {}, conflict: econConflict(true, { feudBlend: 0 }) }), blob);
  const blendEcon = new AgentEconomy(econCfg({ dynasty: {}, conflict: econConflict(true, { feudBlend: 1 }) }), blob);

  const meanBouts = feudPairs(meanEcon.warHouses(), meanEcon.houseFeuds(), wc, 1000, {});
  const blendBouts = feudPairs(blendEcon.warHouses(), blendEcon.houseFeuds(), wc, 1000, {});

  assert.equal(meanBouts.length, 0, "pure mean dilutes the grudges above -0.6 ⇒ NO war (the deadlock the engine breaks)");
  assert.equal(blendBouts.length, 1, "weighting the deepest bonds surfaces a genuine, funded war candidate");
  assert.deepEqual(blendBouts[0], { attacker: 2, defender: 5 }, "equal capital share ⇒ the lower house id attacks up");
});

// ---------- winnerOf / warRoll: byte-for-byte with WarCoffer._deriveWinner ----------

/** An INDEPENDENT re-implementation of Solidity's `abi.encodePacked(uint256 ×5)` — hand-padded 32-byte words
 *  concatenated — so we cross-check that viem's encodePacked (which war.ts uses) equals the exact bytes the
 *  contract keccaks. If these two ever disagree, the on-chain payout and the mirror diverge. */
function pad32(x: bigint): string {
  return x.toString(16).padStart(64, "0");
}
function contractRoll(warId: bigint, attacker: bigint, defender: bigint, powerA: bigint, powerB: bigint): bigint {
  const packed = ("0x" + pad32(warId) + pad32(attacker) + pad32(defender) + pad32(powerA) + pad32(powerB)) as `0x${string}`;
  const total = powerA + powerB;
  const h = BigInt(keccak256(packed));
  return ((h % total) + total) % total; // non-negative modulo, as Solidity's unsigned % does
}

test("winnerOf is deterministic and its winner is exactly the committed power slice the roll lands in", () => {
  const warId = 1000n, attacker = 1n, defender = 2n, powerA = 300n, powerB = 100n;
  const a = winnerOf(warId, attacker, defender, powerA, powerB);
  const b = winnerOf(warId, attacker, defender, powerA, powerB);
  assert.equal(a.roll, b.roll, "same inputs ⇒ same roll (a pure function, no oracle)");
  assert.equal(a.winner, b.winner);
  assert.ok(a.roll >= 0n && a.roll < a.total, "the roll is within the total power");
  assert.equal(a.winner, a.roll < powerA ? WIN_ATTACKER : WIN_DEFENDER, "attacker wins iff roll < powerA");
});

test("LOCK-STEP: war.ts's roll equals a hand-rolled Solidity abi.encodePacked draw on every vector", () => {
  const vectors: [bigint, bigint, bigint, bigint, bigint][] = [
    [0n, 1n, 2n, 1n, 1n],
    [42n, 7n, 9n, 250n, 137n],
    [1_000n, 3n, 11n, 1_000n, 1n],
    [9_999_999n, 500n, 5n, 333n, 777n],
    [123n, 9n, 9n, 1n, 1_000_000n],
  ];
  for (const [w, a, d, pa, pb] of vectors) {
    assert.equal(warRoll(w, a, d, pa, pb), contractRoll(w, a, d, pa, pb), `roll vector ${w}/${a}/${d}/${pa}/${pb}`);
    const { winner } = winnerOf(w, a, d, pa, pb);
    const cw = contractRoll(w, a, d, pa, pb) < pa ? WIN_ATTACKER : WIN_DEFENDER;
    assert.equal(winner, cw, `winner vector ${w}`);
  }
});

test("a null total power yields WIN_NONE (the stale-refund sentinel), never a division by zero", () => {
  const { winner, total } = winnerOf(5n, 1n, 2n, 0n, 0n);
  assert.equal(total, 0n);
  assert.equal(winner, WIN_NONE);
});

// ---------- economy delegators: safe degrade when the coffer is not wired ----------

test("in simulated mode every war delegator returns null (no chain, no vault-funding wallet, zero regression)", async () => {
  const econ = new AgentEconomy(econCfg());
  assert.equal(econ.facilitatorMode, "simulated");
  assert.equal(await econ.cofferDeposit(1, "1000000"), null);
  assert.equal(await econ.declareWarOnchain({ warId: 1, attacker: 1, defender: 2, stakeAtomic: "1000000", powerA: 10, powerB: 20, deadline: 7200 }), null);
  assert.equal(await econ.resolveWarOnchain(1), null);
  assert.equal(await econ.levyTaxOnchain(1, "10000"), null);
  assert.equal(await econ.sweepTaxOnchain(1), null);
  assert.equal(await econ.warInfoOnchain(1), null);
  assert.equal(await econ.cofferVaultOnchain(1), null);
  assert.equal(await econ.cofferStatsOnchain(), null);
});

test("a delegator whose facilitator throws still returns null (a coffer fault can never abort a tick)", async () => {
  const econ = new AgentEconomy(econCfg());
  const boom = () => { throw new Error("rpc down"); };
  (econ as unknown as { facilitator: object }).facilitator = {
    mode: "onchain",
    cofferDeposit: boom, declareWar: boom, resolveWar: boom, levyTax: boom,
    sweepTax: boom, warInfo: boom, cofferVault: boom, cofferStats: boom,
  };
  assert.equal(await econ.cofferDeposit(1, "1000000"), null);
  assert.equal(await econ.resolveWarOnchain(1), null);
  assert.equal(await econ.levyTaxOnchain(1, "10000"), null);
  assert.equal(await econ.warInfoOnchain(1), null);
  assert.equal(await econ.cofferStatsOnchain(), null);
});

test("a non-numeric atomic string degrades to null (never a BigInt throw)", async () => {
  const econ = new AgentEconomy(econCfg());
  assert.equal(await econ.cofferDeposit(1, "not-a-number"), null);
  assert.equal(await econ.levyTaxOnchain(1, "1.5"), null);
});

// ---------- loadConfig: the WAR_* gates and inert-by-default guarantee ----------

test("by default the war coffer is disabled and inert (zero behaviour change for an existing deployment)", () => {
  const w = loadConfig(env()).war;
  assert.equal(w.enabled, false, "WAR_ENABLED unset ⇒ disabled");
  assert.equal(w.address, null);
  assert.equal(w.treasury, null);
  assert.equal(w.usdc, "0x3600000000000000000000000000000000000000", "the Arc USDC precompile by default");
  assert.equal(w.stakePct, 0.05);
  assert.equal(w.minVaultUsdc, 1);
  assert.equal(w.perWarCapUsdc, 5);
  assert.equal(w.maxEscrowUsdc, 50);
  assert.equal(w.warCadenceSec, 3600);
  assert.equal(w.feudThreshold, -0.6);
  assert.equal(w.taxPct, 0.01);
  assert.equal(w.taxDest, "coffer");
  assert.equal(w.bootstrap, false, "WAR_BOOTSTRAP unset ⇒ cold-start funding OFF ⇒ a vault-gated swarm can never start a war (byte-for-byte today's inert deadlock)");
});

test("enabled requires WAR_ENABLED=true; address/treasury are trimmed and empty⇒null", () => {
  const on = loadConfig(env({ WAR_ENABLED: "true", WAR_ADDRESS: "  0xabc  ", WAR_TREASURY: "0xdef" })).war;
  assert.equal(on.enabled, true);
  assert.equal(on.address, "0xabc", "whitespace trimmed");
  assert.equal(on.treasury, "0xdef");

  assert.equal(loadConfig(env({ WAR_ENABLED: "TRUE" })).war.enabled, true, "case-insensitive");
  assert.equal(loadConfig(env({ WAR_ENABLED: "false" })).war.enabled, false);
  assert.equal(loadConfig(env({ WAR_ENABLED: "1" })).war.enabled, false, "only 'true' enables");
  assert.equal(loadConfig(env({ WAR_ADDRESS: "   " })).war.address, null, "blank ⇒ null (step skipped)");
});

test("the tax destination is dominant only on an explicit 'dominant', else the coffer purse", () => {
  assert.equal(loadConfig(env({ WAR_TAX_DEST: "dominant" })).war.taxDest, "dominant");
  assert.equal(loadConfig(env({ WAR_TAX_DEST: " DOMINANT " })).war.taxDest, "dominant");
  assert.equal(loadConfig(env({ WAR_TAX_DEST: "coffer" })).war.taxDest, "coffer");
  assert.equal(loadConfig(env({ WAR_TAX_DEST: "nonsense" })).war.taxDest, "coffer", "unknown ⇒ coffer");
});

test("WAR_BOOTSTRAP + TERR_SEIZE_ON_WIN default false and arm only on an explicit 'true' (the conquest money switches)", () => {
  // These two gate the ONLY paths that move real operator USDC into an empty vault (bootstrap) or rewrite zone
  // ownership on a win (seizeOnWin). Both MUST default false so a deploy that never arms them is byte-for-byte inert.
  assert.equal(loadConfig(env()).war.bootstrap, false, "WAR_BOOTSTRAP unset ⇒ cold-start funding OFF");
  assert.equal(loadConfig(env({ WAR_BOOTSTRAP: "true" })).war.bootstrap, true);
  assert.equal(loadConfig(env({ WAR_BOOTSTRAP: "TRUE" })).war.bootstrap, true, "case-insensitive");
  assert.equal(loadConfig(env({ WAR_BOOTSTRAP: "1" })).war.bootstrap, false, "only 'true' arms it");
  assert.equal(loadConfig(env()).territory.seizeOnWin, false, "TERR_SEIZE_ON_WIN unset ⇒ no conquest");
  assert.equal(loadConfig(env({ TERR_SEIZE_ON_WIN: "true" })).territory.seizeOnWin, true);
  assert.equal(loadConfig(env({ TERR_SEIZE_ON_WIN: "yes" })).territory.seizeOnWin, false, "only 'true' arms it");
});

test("by default organic conflict is OFF with pure-mean feuds, and every knob is clamped into 0..1", () => {
  const off = loadConfig(env()).conflict;
  assert.equal(off.enabled, false, "CONFLICT_ENABLED unset ⇒ OFF ⇒ byte-for-byte today's economy");
  assert.equal(off.rivalStep, 0.06);
  assert.equal(off.envyStep, 0.1);
  assert.equal(off.embargoStep, 0.05);
  assert.equal(off.raidStep, 0.4);
  assert.equal(off.raidProb, 0.0003);
  assert.equal(off.feudBlend, 0, "FEUD_BLEND defaults to 0 ⇒ houseFeuds stays a pure mean even if armed");

  assert.equal(loadConfig(env({ CONFLICT_ENABLED: "TRUE" })).conflict.enabled, true, "case-insensitive enable");
  assert.equal(loadConfig(env({ CONFLICT_ENABLED: "1" })).conflict.enabled, false, "only 'true' enables");
  const clamped = loadConfig(env({ CONFLICT_RIVAL_STEP: "9", FEUD_BLEND: "-2" })).conflict;
  assert.equal(clamped.rivalStep, 1, "step clamped to 1");
  assert.equal(clamped.feudBlend, 0, "blend clamped up from -2 to 0");
});

test("the war cadence is clamped to 5 minutes .. 7 days and the stake/fraction bounds hold", () => {
  assert.equal(loadConfig(env({ WAR_CADENCE_SEC: "10" })).war.warCadenceSec, 300);
  assert.equal(loadConfig(env({ WAR_CADENCE_SEC: "999999999" })).war.warCadenceSec, 7 * 86400);
  assert.equal(loadConfig(env({ WAR_STAKE_PCT: "9" })).war.stakePct, 1, "clamped to 1 (100%)");
  assert.equal(loadConfig(env({ WAR_FEUD_THRESHOLD: "5" })).war.feudThreshold, 1);
  assert.equal(loadConfig(env({ WAR_FEUD_THRESHOLD: "-5" })).war.feudThreshold, -1);
});
