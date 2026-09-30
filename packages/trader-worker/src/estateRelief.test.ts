/**
 * #143 ESTATE RELIEF (ONCHAIN, dark) — a dead house's real USDC must stop sleeping.
 *
 * Background (the honest money model): a buried fly's REAL USDC stays in its orphaned HD wallet — settlement
 * and the R5 mirror resync both SKIP the dead, and the #123 commons pool / house treasury are SCOREBOARD
 * numbers only (never spent). This layer sweeps an orphaned purse into a RESERVED escrow (its own HD index,
 * disjoint from every recyclable agent id), then drips escrow to the POOREST LIVING wallets on a cadence —
 * every leg a gasless EIP-3009 transferWithAuthorization signed by the payer, moving money ONLY on a mined
 * receipt, bounded by the per-deal cap + a daily relief budget, serialized in flush's money lane.
 *
 * Groups:
 *   OFF — master switch absent/false ⇒ estateReliefOn() false; sweep/relief transfer NOTHING; serialize() is
 *         byte-for-byte identical to a build with no estateRelief field at all (normalizeSerialize).
 *   ENQ — armed + onchain + wired escrow ⇒ a burial enqueues the orphaned id (dedup + bounded).
 *   SWEEP — estate→escrow moves a capped chunk signed by the dead wallet's own key; escrow scoreboard rises.
 *   MISFIRE — the id-reuse guard: a slot reclaimed (reopenSlot lifts the tombstone) is DROPPED, never swept.
 *   CAP — the swept/disbursed amount is clamped to the per-deal cap; a failure dequeues (no wedge); fail-open
 *         on an RPC throw.
 *   RELIEF — the cadence gate; escrow→poorest credits the recipient MIRROR by exactly the mined inflow (so
 *         mirror ≤ chain still holds) and falls the escrow scoreboard; the daily budget stops the drip.
 *
 * The only external input is an authoritative on-chain balanceOf read + a mock transfer — never RNG/clock.
 */
import test from "node:test";
import assert from "node:assert/strict";

import { AgentEconomy, type EconomyConfig } from "./economy.js";
import type { FlyReading, CollectiveState } from "./population.js";
import type { Facilitator, VerifyResponse, SettleResponse, PaymentPayload, PaymentRequirements } from "./x402.js";
import { usdcToAtomic } from "./x402.js";

// ─── Helpers ────────────────────────────────────────────────────────────────────────────────────────────

const ESCRW = "0x00000000000000000000000000000000000E5c00"; // a stand-in reserved escrow address

function cfg(over: Partial<EconomyConfig> = {}): EconomyConfig {
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
    maxDealUsdc: 0,
    netMinBroadcastUsdc: 0,
    netFlushTicks: 0,
    populationSize: 24,
    hatchSeedUsdc: 0.002,
    ...over,
  };
}

/** Onchain, real-spend-armed config — the estate-relief regime. */
function onchainCfg(over: Partial<EconomyConfig> = {}): EconomyConfig {
  return cfg({
    facilitatorMode: "onchain",
    realSpendEnabled: true,
    initialBalanceUsdc: 100,
    maxDealUsdc: 100,
    netMinBroadcastUsdc: 0.001,
    netFlushTicks: 1,
    ...over,
  });
}

const RELIEF = (over: Partial<NonNullable<EconomyConfig["estateRelief"]>> = {}) => ({
  enabled: true,
  shadow: false,            // the real-path groups exercise MINED legs; a dedicated SHDW test covers the dry-run default
  reliefEveryNCrons: 1,
  reliefChunkUsdc: 100,
  reliefDailyBudgetUsdc: 1000,
  maxSweepsPerCron: 16,
  ...over,
});

function reading(id: number, state: FlyReading["state"]): FlyReading {
  return {
    id, state,
    arousal: 0.3 + (id % 10) * 0.07,
    turnBias: id % 2 ? 0.4 : -0.4, cohesion: 0.5,
    wingbeat: 0.8, rest: 0.05, temperament: ((id * 7919) % 1000) / 1000,
    fingerprint: `fp${id}`,
    fap: "FORAGE", valence: 0, heading: 0, role: "signal-seeker", bouts: [],
    neuromod: { dopamine: 0, octopamine: 0, learningRateGate: 0, daHz: 0, oaHz: 0 },
  };
}

function collective(temperature = 0.85): CollectiveState {
  return {
    temperature, regime: "HOT", vitality: temperature, size: 24, arousal: 0.7, cohesion: 0.5, rest: 0.1, wingbeat: 0.6,
    states: { AGITATE: 0, EXPLORE: 0, AGGREGATE: 0, REST: 0 },
    faps: {}, valence: 0,
    meanDopamine: 0, meanOctopamine: 0, meanDaHz: 0, meanOaHz: 0,
  } as unknown as CollectiveState;
}

const population = (n = 12) => Array.from({ length: n }, (_, i) => reading(i, "AGITATE"));

interface TransferCall { payer: string; payee: string; value: string; shadow?: boolean }

/**
 * A mock onchain facilitator recording every treasuryTransfer leg. `balances(addr)` is the authoritative
 * on-chain balanceOf (a stranded dead purse, the escrow purse, or 0). `failTransfer` makes the leg return a
 * failed receipt; `throws` makes it throw (the caller must fail-open). `shadow` makes every leg a dry-run.
 */
function mockFac(opts: {
  balances?: (addr: string) => bigint;
  failTransfer?: boolean;
  throws?: boolean;
  shadow?: boolean;
  transferLog?: TransferCall[];
  readThrows?: boolean;
} = {}): Facilitator {
  return {
    mode: "onchain" as const,
    asset: "0xMockUSDCAddress0000000000000000000000",
    async verify(): Promise<VerifyResponse> { return { valid: true }; },
    async settle(): Promise<SettleResponse> { return { success: true, network: "arc", txHash: "0x" + "ab".repeat(32) }; },
    async readBalances(addresses: string[]): Promise<Map<string, bigint>> {
      if (opts.readThrows) throw new Error("multicall reverted");
      const m = new Map<string, bigint>();
      const f = opts.balances ?? (() => 0n);
      for (const a of addresses) m.set(a.toLowerCase(), f(a));
      return m;
    },
    async treasuryTransfer(a: { payerAddress: string; payeeAddress: string; valueAtomic: string; network: string; shadow?: boolean }): Promise<SettleResponse> {
      opts.transferLog?.push({ payer: a.payerAddress, payee: a.payeeAddress, value: a.valueAtomic, shadow: a.shadow });
      if (opts.throws) throw new Error("relay blew up");
      if (a.shadow || opts.shadow) return { success: true, network: a.network, txHash: "0x", simulated: false, shadow: true };
      if (opts.failTransfer) return { success: false, network: a.network, txHash: "", invalidReason: "mock-transfer-fail" };
      return { success: true, network: a.network, txHash: "0x" + "cd".repeat(32) };
    },
  };
}

/** Build an armed onchain economy with the given balances resolver and transfer overrides. */
function armedEcon(opts: Parameters<typeof mockFac>[0] = {}, reliefOver: Parameters<typeof RELIEF>[0] = {}) {
  const transferLog: TransferCall[] = [];
  const econ = new AgentEconomy(
    onchainCfg({ estateRelief: RELIEF(reliefOver) }),
    undefined,
    { facilitator: mockFac({ ...opts, transferLog }), escrowAddress: ESCRW },
  );
  return { econ, transferLog };
}

// Populate agent wallets (ids 0..n-1) the same way the cron does, WITHOUT flushing any net.
async function seedAgents(econ: AgentEconomy, n = 12) {
  await econ.step(population(n), collective(0.85), 1, undefined, false);
}

const WALL = new Set(["ts", "settleMsSum", "settleMsMax", "settleMsLast"]);
function normalize(blob: string): string {
  const walk = (v: any): any => {
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === "object") {
      const o: any = {};
      for (const k of Object.keys(v)) o[k] = WALL.has(k) && typeof v[k] === "number" ? 0 : walk(v[k]);
      return o;
    }
    return v;
  };
  return JSON.stringify(walk(JSON.parse(blob)));
}

// ═══════════════════════════════════════════════════════════════════════════════════════════════════════
// OFF GROUP — dark deployment is byte-for-byte today
// ═══════════════════════════════════════════════════════════════════════════════════════════════════════

test("OFF1: master switch absent ⇒ estateReliefOn() false, snapshot has no estateRelief key", async () => {
  const econ = new AgentEconomy(onchainCfg({}), undefined, { facilitator: mockFac(), escrowAddress: ESCRW });
  await seedAgents(econ);
  assert.equal((econ as any).estateReliefOn(), false, "no estateRelief config ⇒ layer off");
  assert.equal(econ.snapshot().estateRelief, undefined, "OFF ⇒ /economy omits the estateRelief block entirely");
  // Executors no-op: they never touch the facilitator.
  const swept = await econ.sweepEstatesToEscrow(2);
  const given = await econ.disburseRelief();
  assert.deepEqual(swept, { swept: 0, sweptAtomic: "0" });
  assert.deepEqual(given, { disbursed: 0, disbursedAtomic: "0" });
});

test("OFF2: enabled:false ⇒ entomb queues nothing; serialize byte-for-byte == a no-estateRelief build", async () => {
  const off = new AgentEconomy(onchainCfg({ estateRelief: { ...RELIEF(), enabled: false } }), undefined,
    { facilitator: mockFac(), escrowAddress: ESCRW });
  await seedAgents(off);
  (off as any).entomb(0, "old_age", 2);
  assert.equal((off as any).pendingEstates.length, 0, "disabled ⇒ entomb enqueues nothing");

  // Byte-equivalence: two crons on an OFF build must serialize identically to the same build with the field absent.
  const a = new AgentEconomy(onchainCfg({ estateRelief: { ...RELIEF(), enabled: false } }), undefined, { facilitator: mockFac(), escrowAddress: ESCRW });
  const b = new AgentEconomy(onchainCfg({}), undefined, { facilitator: mockFac(), escrowAddress: ESCRW });
  await seedAgents(a); await seedAgents(b);
  const sa = normalize(a.serialize());
  const sb = normalize(b.serialize());
  assert.equal(sa, sb, "enabled:false serialize == no-estateRelief serialize (dark deploy byte-for-byte)");
  assert.ok(!sa.includes("escrowPoolAtomic"), "OFF blob carries NO #143 fields at all");
});

// ═══════════════════════════════════════════════════════════════════════════════════════════════════════
// ENQUEUE GROUP — a burial queues the orphaned wallet
// ═══════════════════════════════════════════════════════════════════════════════════════════════════════

test("ENQ1: armed + onchain + escrow ⇒ entomb enqueues the id (deduped); estateReliefOn() true", async () => {
  const { econ } = armedEcon({ balances: () => 0n });
  await seedAgents(econ);
  assert.equal((econ as any).estateReliefOn(), true, "flag + onchain + escrow ⇒ armed");
  (econ as any).entomb(3, "penury", 2);
  assert.deepEqual((econ as any).pendingEstates, [3], "buried id queued for an on-chain sweep");
  (econ as any).entomb(3, "penury", 3);   // re-entomb same id ⇒ deduped
  assert.deepEqual((econ as any).pendingEstates, [3], "queue dedupes by id");
  assert.ok(econ.snapshot().estateRelief, "armed ⇒ /economy exposes the estateRelief block");
});

test("ENQ2: no escrow wired ⇒ estateReliefOn() false (simulator / unwired) even with the flag on", () => {
  const econ = new AgentEconomy(onchainCfg({ estateRelief: RELIEF() }), undefined, { facilitator: mockFac() });
  assert.equal((econ as any).estateReliefOn(), false, "escrow absent ⇒ cannot gather ⇒ inert");
});

// ═══════════════════════════════════════════════════════════════════════════════════════════════════════
// SWEEP GROUP — estate → escrow, signed by the dead wallet, capped
// ═══════════════════════════════════════════════════════════════════════════════════════════════════════

test("SWEEP1: stranded dead purse is swept to escrow; scoreboard rises; id dequeues", async () => {
  const deadAddr = AgentEconomy.addressOf(42, 3);
  const stranded = usdcToAtomic(5);   // 5 USDC physically stranded in the orphaned wallet
  const { econ, transferLog } = armedEcon({ balances: (a) => a.toLowerCase() === deadAddr.toLowerCase() ? BigInt(stranded) : 0n });
  await seedAgents(econ);
  (econ as any).entomb(3, "old_age", 2);
  const res = await econ.sweepEstatesToEscrow(3);
  assert.equal(res.swept, 1, "one estate swept");
  assert.equal(res.sweptAtomic, String(BigInt(stranded)), "swept the whole (sub-cap) purse");
  assert.equal((econ as any).pendingEstates.length, 0, "swept id dequeued");
  assert.equal((econ as any).escrowPoolAtomic, String(BigInt(stranded)), "escrow scoreboard rose by the swept amount");
  assert.equal(transferLog.length, 1, "exactly one treasuryTransfer leg");
  assert.equal(transferLog[0].payer.toLowerCase(), deadAddr.toLowerCase(), "signed FROM the dead wallet");
  assert.equal(transferLog[0].payee.toLowerCase(), ESCRW.toLowerCase(), "paid TO the escrow purse");
});

test("SWEEP2: per-deal CAP — a huge stranded purse is swept in at most maxDeal chunks", async () => {
  const deadAddr = AgentEconomy.addressOf(42, 4);
  const huge = usdcToAtomic(1_000_000);   // far above maxDealUsdc=100
  const { econ, transferLog } = armedEcon({ balances: () => BigInt(huge) });
  await seedAgents(econ);
  (econ as any).entomb(4, "old_age", 2);
  await econ.sweepEstatesToEscrow(3);
  assert.equal(transferLog.length, 1, "one chunk per sweep attempt (bounded per cron)");
  assert.equal(BigInt(transferLog[0].value), BigInt(usdcToAtomic(100)), "swept at most the per-deal cap, never more");
});

test("SWEEP3: fail-OPEN — a readBalances throw defers (queue survives, no transfer)", async () => {
  const { econ, transferLog } = armedEcon({ readThrows: true });
  await seedAgents(econ);
  (econ as any).entomb(5, "old_age", 2);
  const res = await econ.sweepEstatesToEscrow(3);
  assert.equal(res.swept, 0);
  assert.equal(transferLog.length, 0, "an RPC error must not move money or crash the cron");
  assert.equal((econ as any).pendingEstates.length, 1, "estate stays queued for the next cron");
});

test("SWEEP4: a durable transfer failure DEQUEUES (the queue cannot wedge)", async () => {
  const { econ } = armedEcon({ balances: () => BigInt(usdcToAtomic(1)), failTransfer: true });
  await seedAgents(econ);
  (econ as any).entomb(6, "old_age", 2);
  const res = await econ.sweepEstatesToEscrow(3);
  assert.equal(res.swept, 0);
  assert.equal((econ as any).pendingEstates.length, 0, "failed id dropped, escrow unchanged");
  assert.equal((econ as any).escrowPoolAtomic, "0", "no scoreboard credit on a failed leg");
});

// ═══════════════════════════════════════════════════════════════════════════════════════════════════════
// MISFIRE GROUP — the id-reuse guard
// ═══════════════════════════════════════════════════════════════════════════════════════════════════════

test("MISFIRE1: a reclaimed slot (reopenSlot lifts the tombstone) is DROPPED, never swept", async () => {
  const { econ, transferLog } = armedEcon({ balances: () => BigInt(usdcToAtomic(3)) });
  await seedAgents(econ);
  (econ as any).entomb(7, "old_age", 2);
  assert.equal((econ as any).pendingEstates.includes(7), true, "queued while dead");
  // A new hatch reclaims id 7: reopenSlot deletes the tombstone (the reborn fly now owns that purse).
  econ.reopenSlot(7, 6);
  assert.equal((econ as any).dead.has(7), false, "tombstone cleared by the reclaim");
  const res = await econ.sweepEstatesToEscrow(3);
  assert.equal(res.swept, 0, "a living wallet is NEVER swept");
  assert.equal(transferLog.length, 0, "no transfer signed against a reclaimed purse");
  assert.equal((econ as any).pendingEstates.includes(7), false, "the misfired queue entry is dropped");
});

// ═══════════════════════════════════════════════════════════════════════════════════════════════════════
// RELIEF GROUP — escrow → the poorest living wallets
// ═══════════════════════════════════════════════════════════════════════════════════════════════════

test("RELIEF1: escrow drips to the POOREST living wallet; its mirror rises by exactly the mined inflow", async () => {
  // Make one wallet clearly the poorest by draining its mirror to near zero.
  const { econ, transferLog } = armedEcon({ balances: (a) => a.toLowerCase() === ESCRW.toLowerCase() ? BigInt(usdcToAtomic(2)) : 0n },
    { reliefChunkUsdc: 1 });
  await seedAgents(econ);
  const agents = (econ as any).agents as Array<{ id: number; address: string; balance: string }>;
  const poorest = agents.reduce((x, y) => (BigInt(x.balance) <= BigInt(y.balance) ? x : y));
  (poorest as any).balance = "1";   // dust → clearly the poorest living wallet
  const before = poorest.balance;
  const res = await econ.disburseRelief();
  assert.ok(res.disbursed >= 1, "at least one relief leg fired");
  assert.equal(transferLog[0].payer.toLowerCase(), ESCRW.toLowerCase(), "signed FROM escrow");
  assert.equal(transferLog[0].payee.toLowerCase(), poorest.address.toLowerCase(), "the FIRST leg pays the poorest wallet");
  assert.ok(BigInt(poorest.balance) > BigInt(before), "recipient mirror rose by the real inflow");
  // The poorest's mirror rose by EXACTLY what was transferred to it (backed by a mined inflow ⇒ mirror ≤ chain holds).
  const toPoor = transferLog.filter((t) => t.payee.toLowerCase() === poorest.address.toLowerCase())
    .reduce((acc, t) => acc + BigInt(t.value), 0n);
  assert.equal(BigInt(poorest.balance) - BigInt(before), toPoor, "mirror rose by exactly the transferred amount (never invented)");
});

test("RELIEF2: cadence gate — reliefEveryNCrons=2 fires only every 2nd cron", async () => {
  const { econ, transferLog } = armedEcon({ balances: () => BigInt(usdcToAtomic(2)) }, { reliefEveryNCrons: 2 });
  await seedAgents(econ);
  await econ.disburseRelief();   // count 1 → not due
  assert.equal(transferLog.length, 0, "no drip on a non-cadence cron");
  await econ.disburseRelief();   // count 2 → due
  assert.ok(transferLog.length > 0, "the drip fires on the Nth cron");
});

test("RELIEF3: nothing to give — escrow on-chain balance 0 ⇒ zero legs", async () => {
  const { econ, transferLog } = armedEcon({ balances: () => 0n });
  await seedAgents(econ);
  const res = await econ.disburseRelief();
  assert.equal(res.disbursed, 0);
  assert.equal(transferLog.length, 0, "an empty escrow cannot fund anyone");
});

test("RELIEF4: DAILY BUDGET stops the drip (a ceiling below the spend caps)", async () => {
  const { econ, transferLog } = armedEcon({ balances: () => BigInt(usdcToAtomic(10)) },
    { reliefChunkUsdc: 5, reliefDailyBudgetUsdc: 3 });
  await seedAgents(econ);
  const r1 = await econ.disburseRelief();
  assert.ok(r1.disbursed >= 1, "the budget permits the first capped chunk");
  const spent = BigInt((econ as any).reliefToday.atomic);
  assert.ok(spent <= BigInt(usdcToAtomic(3)), `daily spend never exceeds the budget (${spent} ≤ 3 USDC atomic)`);
  const before = transferLog.length;
  await econ.disburseRelief();   // same day, budget already spent ⇒ stop
  assert.equal(transferLog.length, before, "no further drip once the daily relief budget is spent");
});

// ═══════════════════════════════════════════════════════════════════════════════════════════════════════
// RW GROUP — the economyCfg()→AgentEconomy real wiring (the #120/#143 desync guard)
// ═══════════════════════════════════════════════════════════════════════════════════════════════════════

test("RW1: the escrow disbursement dequeues the scoreboard down (never below zero)", async () => {
  const { econ } = armedEcon({ balances: (a) => a.toLowerCase() === ESCRW.toLowerCase() ? BigInt(usdcToAtomic(1)) : 0n },
    { reliefChunkUsdc: 10 });   // chunk bigger than escrow ⇒ give the whole escrow
  await seedAgents(econ);
  (econ as any).escrowPoolAtomic = "0";   // scoreboard starts empty (relief reads the LIVE chain, not the board)
  const agents = (econ as any).agents as Array<{ address: string; balance: string }>;
  const poorest = agents.reduce((x, y) => (BigInt(x.balance) <= BigInt(y.balance) ? x : y));
  (poorest as any).balance = "1";
  await econ.disburseRelief();
  // escrowPoolAtomic was 0; a disbursement must never drive it negative (clamped).
  assert.equal((econ as any).escrowPoolAtomic, "0", "scoreboard clamps at zero, never negative");
});

// ═══════════════════════════════════════════════════════════════════════════════════════════════════════
// SHDW GROUP — the estate-SCOPED shadow (isolated dry-run, never touches the live economy)
// ═══════════════════════════════════════════════════════════════════════════════════════════════════════

test("SHDW1: shadow:true ⇒ the sweep leg is DRY-RUNNED (signed + attempted) but moves nothing; queue preserved", async () => {
  const deadAddr = AgentEconomy.addressOf(42, 3);
  const stranded = usdcToAtomic(5);
  // armedEcon default RELIEF has shadow:false; override to shadow:true (the CODE DEFAULT when enabled).
  const { econ, transferLog } = armedEcon({ balances: (a) => a.toLowerCase() === deadAddr.toLowerCase() ? BigInt(stranded) : 0n }, { shadow: true });
  await seedAgents(econ);
  (econ as any).entomb(3, "old_age", 2);
  const res = await econ.sweepEstatesToEscrow(3);
  assert.equal(res.swept, 0, "a shadow sweep credits nothing (no money moved)");
  assert.equal((econ as any).escrowPoolAtomic, "0", "escrow scoreboard stays empty under shadow");
  assert.equal((econ as any).estateSweptCount, 0, "no lifetime sweep counted under shadow");
  assert.equal(transferLog.length, 1, "the leg WAS attempted (proves key sign + escrow reach end-to-end)");
  assert.equal(transferLog[0].shadow, true, "the leg was requested as shadow:true");
  assert.equal((econ as any).pendingEstates.includes(3), true, "shadow keeps the estate queued for the real run");
});

test("SHDW2: shadow:true ⇒ a relief leg is dry-run (recipient mirror does NOT rise) and escrow board holds", async () => {
  const { econ, transferLog } = armedEcon({ balances: (a) => a.toLowerCase() === ESCRW.toLowerCase() ? BigInt(usdcToAtomic(2)) : 0n }, { shadow: true, reliefChunkUsdc: 1 });
  await seedAgents(econ);
  const agents = (econ as any).agents as Array<{ id: number; address: string; balance: string }>;
  const poorest = agents.reduce((x, y) => (BigInt(x.balance) <= BigInt(y.balance) ? x : y));
  (poorest as any).balance = "1";
  const before = poorest.balance;
  const res = await econ.disburseRelief();
  assert.equal(res.disbursed, 0, "a shadow relief leg pays nothing");
  assert.equal(transferLog.length, 1, "the escrow→poor leg was attempted as a dry-run");
  assert.equal(transferLog[0].shadow, true, "requested shadow:true");
  assert.equal(poorest.balance, before, "recipient mirror is UNCHANGED under shadow (mirror ≤ chain never perturbed)");
  assert.equal((econ as any).reliefPaidCount, 0, "no lifetime relief counted under shadow");
});

// ═══════════════════════════════════════════════════════════════════════════════════════════════════════
// BF GROUP — the one-time RETROACTIVE backfill (recovers pre-arming orphans in this.dead; guard-protected, latches once)
// ═══════════════════════════════════════════════════════════════════════════════════════════════════════

test("BF1: backfill knob OFF (default) ⇒ runEstateBackfill is a no-op even with orphans sitting in this.dead", () => {
  const { econ } = armedEcon({ balances: () => 0n });        // RELIEF default: backfill absent
  (econ as any).dead.add(3); (econ as any).dead.add(4);
  const res = econ.runEstateBackfill();
  assert.deepEqual(res, { captured: 0, remaining: 0 }, "disabled ⇒ captures nothing, backlog empty");
  assert.equal((econ as any).estateBackfillRan, false, "not latched while the knob is off");
  assert.equal((econ as any).pendingEstates.length, 0, "nothing enqueued (byte-for-byte inert)");
});

test("BF2: backfill ON ⇒ the first call latches a ONE-TIME snapshot of this.dead into the queue (deduped), the second never re-scans", () => {
  const { econ } = armedEcon({ balances: () => 0n }, { backfill: true });
  (econ as any).dead.add(3); (econ as any).dead.add(4); (econ as any).dead.add(5);
  (econ as any).pendingEstates.push(5);                       // id 5 already forward-queued ⇒ must not duplicate
  const r1 = econ.runEstateBackfill();
  assert.equal(r1.captured, 2, "captures the two orphans not already queued (3,4)");
  assert.equal((econ as any).estateBackfillRan, true, "latched after a single snapshot");
  for (const id of [3, 4, 5]) assert.equal((econ as any).pendingEstates.includes(id), true, `orphan #${id} is enqueued`);
  assert.equal((econ as any).pendingEstates.filter((x: number) => x === 5).length, 1, "no duplicate enqueue of an already-queued id");
  const r2 = econ.runEstateBackfill();
  assert.equal(r2.captured, 0, "latched ⇒ never re-scans this.dead");
});

test("BF3: churn immunity — an already-drained orphan STILL in this.dead is not re-enqueued on a later call", () => {
  const { econ } = armedEcon({ balances: () => 0n }, { backfill: true });
  (econ as any).dead.add(3);
  econ.runEstateBackfill();                                   // captures + enqueues 3
  (econ as any).pendingEstates.length = 0;                    // simulate the sweep retiring it
  const r = econ.runEstateBackfill();                         // latched ⇒ no re-capture
  assert.equal(r.captured, 0, "no re-scan after the latch");
  assert.equal((econ as any).pendingEstates.includes(3), false, "a drained orphan is never re-fed (latch prevents churn)");
});

test("BF4: a backfilled id whose slot is reclaimed is DROPPED by the sweep guard, never swept (a reborn fly's purse is safe)", async () => {
  const deadAddr = AgentEconomy.addressOf(42, 7);
  const { econ, transferLog } = armedEcon({ balances: (a) => a.toLowerCase() === deadAddr.toLowerCase() ? BigInt(usdcToAtomic(3)) : 0n }, { backfill: true });
  await seedAgents(econ);
  (econ as any).dead.add(7);
  econ.runEstateBackfill();
  assert.equal((econ as any).pendingEstates.includes(7), true, "backfill enqueued the orphan");
  econ.reopenSlot(7, 6);                                       // a new hatch reclaims id 7 → the tombstone lifts
  const res = await econ.sweepEstatesToEscrow(3);
  assert.equal(res.swept, 0, "a reclaimed purse is NEVER swept");
  assert.equal(transferLog.length, 0, "no transfer is signed against a reclaimed purse");
  assert.equal((econ as any).pendingEstates.includes(7), false, "the backfilled entry is dropped by the guard");
});

test("BF5: backfill ON with an empty this.dead ⇒ latches immediately and captures 0 (the live dead=0 posture = a no-op)", () => {
  const { econ } = armedEcon({ balances: () => 0n }, { backfill: true });
  const r = econ.runEstateBackfill();
  assert.deepEqual(r, { captured: 0, remaining: 0 }, "nothing to recover");
  assert.equal((econ as any).estateBackfillRan, true, "latched even with zero orphans ⇒ the retroactive pass is spent forever");
});

test("BF6: the backfill latch + queue survive a serialize→restore round-trip (a DO eviction does not re-run or lose it)", () => {
  const { econ } = armedEcon({ balances: () => 0n }, { backfill: true });
  (econ as any).dead.add(3); (econ as any).dead.add(4);
  econ.runEstateBackfill();                                    // latches + enqueues 3,4
  const blob = econ.serialize();
  const econ2 = new AgentEconomy(onchainCfg({ estateRelief: RELIEF({ backfill: true }) }), blob, { facilitator: mockFac(), escrowAddress: ESCRW });
  assert.equal((econ2 as any).estateBackfillRan, true, "the latch persists across eviction ⇒ no re-scan");
  assert.equal((econ2 as any).pendingEstates.includes(3) && (econ2 as any).pendingEstates.includes(4), true, "the queued orphans persist");
  const r = econ2.runEstateBackfill();
  assert.equal(r.captured, 0, "restored + latched ⇒ the retroactive pass never re-captures");
});


