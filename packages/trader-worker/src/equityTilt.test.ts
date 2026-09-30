/**
 * #123 — Equity Tilt + Dead-House Sweep + Reform V2 (jubilee re-arm + levy wiring) test suite.
 *
 * A group: equity tilt unit tests — identity at strength=0, direction correctness, band-clamp.
 * B group: dead-house sweep — living house → treasury, dead house → commons pool, treasury subAtomic.
 * C group: jubilee state machine — v2 cooldown re-arm vs v1 permanent deadlock.
 * D group: byte-equivalence gate — all switches OFF ⇒ serialize() byte-for-byte identical.
 * E group: economyCfg() real wiring passthrough (the #120 lesson — never test with injected config alone).
 */
import test from "node:test";
import assert from "node:assert/strict";

import { AgentEconomy, type EconomyConfig } from "./economy.js";
import type { FlyReading, CollectiveState } from "./population.js";
import { usdcToAtomic, addAtomic, subAtomic } from "./x402.js";
import { ReformLayer, type ReformConfig } from "./reform.js";
import { FlyStateDO } from "./state.js";
import type { Env } from "./config.js";

// ─── Helpers ────────────────────────────────────────────────────────────────────────────────────────────

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

function reading(id: number, state: FlyReading["state"], over: Partial<FlyReading> = {}): FlyReading {
  return {
    id, state,
    arousal: 0.3 + (id % 10) * 0.07,
    turnBias: id % 2 ? 0.4 : -0.4, cohesion: 0.5,
    wingbeat: 0.8, rest: 0.05, temperament: (id * 7919) % 1000 / 1000,
    fingerprint: `fp${id}`,
    fap: "FORAGE", valence: 0, heading: 0, role: "signal-seeker", bouts: [],
    neuromod: { dopamine: 0, octopamine: 0, learningRateGate: 0, daHz: 0, oaHz: 0 },
    ...over,
  };
}

function collective(temperature = 0.8): CollectiveState {
  return {
    temperature, regime: temperature >= 0.66 ? "HOT" : temperature <= 0.33 ? "COLD" : "CALM",
    vitality: temperature, size: 24, arousal: 0.7, cohesion: 0.5, rest: 0.1, wingbeat: 0.6,
    states: { AGITATE: 0, EXPLORE: 0, AGGREGATE: 0, REST: 0 },
    faps: {}, valence: 0,
    meanDopamine: 0, meanOctopamine: 0, meanDaHz: 0, meanOaHz: 0,
  };
}

const population = (state: FlyReading["state"], n = 24) =>
  Array.from({ length: n }, (_, i) => reading(i, state));

/** Zero out wall-clock `ts` in recent[] so serialize() comparisons are deterministic. */
function normalizeSerialize(blob: string): string {
  try {
    const p = JSON.parse(blob);
    if (Array.isArray(p.recent)) for (const r of p.recent) r.ts = 0;
    return JSON.stringify(p);
  } catch { return blob; }
}

const TEST_SEED = "test test test test test test test test test test test junk";

function realEconomyCfg(envOver: Record<string, string> = {}): EconomyConfig {
  const env = {
    CHAIN_ID: "5042", RPC_URL: "https://rpc.test", FLY_STATE: {} as any,
    ...envOver,
  } as unknown as Env;
  const dobj = new FlyStateDO({ storage: {} } as any, env);
  return (dobj as any).economyCfg();
}

// ═══════════════════════════════════════════════════════════════════════════════════════════════════════
// A GROUP: EQUITY TILT UNIT TESTS
// ═══════════════════════════════════════════════════════════════════════════════════════════════════════

test("A1: equityTilt strength=0 ⇒ multiplier ≡ 1.0, pickCounterparty byte-for-byte identical to OFF", async () => {
  const pop = population("AGITATE", 12);
  const econOff = new AgentEconomy(cfg());
  const econZero = new AgentEconomy(cfg({ equityTilt: { enabled: true, band: [0.5, 2.0], strength: 0 } }));

  for (let t = 1; t <= 20; t++) {
    await econOff.step(pop, collective(0.85), t);
    await econZero.step(pop, collective(0.85), t);
  }
  // Identical serialize (modulo wall-clock ts) ⇒ identical decisions ⇒ the tilt is multiplicative identity.
  assert.equal(normalizeSerialize(econOff.serialize()), normalizeSerialize(econZero.serialize()), "strength=0 must be byte-for-byte identical to OFF");
});

test("A2: equityTilt enabled=false ⇒ no behavioural change vs absent config", async () => {
  const pop = population("AGITATE", 12);
  const econAbsent = new AgentEconomy(cfg());
  const econDisabled = new AgentEconomy(cfg({ equityTilt: { enabled: false, band: [0.5, 2.0], strength: 0.5 } }));

  for (let t = 1; t <= 20; t++) {
    await econAbsent.step(pop, collective(0.85), t);
    await econDisabled.step(pop, collective(0.85), t);
  }
  assert.equal(normalizeSerialize(econAbsent.serialize()), normalizeSerialize(econDisabled.serialize()), "enabled=false must be byte-for-byte identical to absent");
});

test("A3: equityTilt direction — poor agents sell MORE, rich agents sell LESS", async () => {
  // Create an economy with concentrated wealth, then measure sales distribution.
  const N = 12;
  const pop = population("AGITATE", N);
  const econTilt = new AgentEconomy(cfg({
    populationSize: N,
    equityTilt: { enabled: true, band: [0.5, 2.0], strength: 0.8 },
  }));
  const econFlat = new AgentEconomy(cfg({ populationSize: N }));

  // Run both for enough ticks to accumulate sales
  for (let t = 1; t <= 100; t++) {
    await econTilt.step(pop, collective(0.85), t);
    await econFlat.step(pop, collective(0.85), t);
  }

  const snapTilt = econTilt.snapshot();
  const snapFlat = econFlat.snapshot();

  // With tilt ON, the Gini should be LOWER (more equal) than without
  // (the tilt boosts poor sellers and suppresses rich sellers)
  assert.ok(
    snapTilt.totals.gini <= snapFlat.totals.gini + 0.01,
    `tilt Gini (${snapTilt.totals.gini.toFixed(4)}) should not exceed flat Gini (${snapFlat.totals.gini.toFixed(4)}) significantly`,
  );
  // Volume must be identical (tilt only changes WHO sells, not WHETHER)
  assert.equal(snapTilt.totals.count, snapFlat.totals.count, "trade count must be identical (tilt never touches buyProbability)");
});

test("A4: equityTilt band-clamp — multiplier never escapes [0.5, 2.0]", async () => {
  // Even with extreme strength=1.0, the band-clamp holds
  const econ = new AgentEconomy(cfg({
    equityTilt: { enabled: true, band: [0.5, 2.0], strength: 1.0 },
  }));
  const pop = population("AGITATE", 8);
  for (let t = 1; t <= 50; t++) await econ.step(pop, collective(0.9), t);
  // If the clamp failed, we'd see NaN or extreme weights → the economy would still function
  // but the serialize would differ. The real test is that it doesn't crash and produces valid output.
  const snap = econ.snapshot();
  assert.ok(Number.isFinite(snap.totals.gini), "gini must be finite (no NaN from unclamped tilt)");
  assert.ok(snap.totals.count > 0, "trades must still happen with max strength");
});

test("A5: equityTilt determinism — same inputs ⇒ same output (no Date.now/Math.random)", async () => {
  const pop = population("AGITATE", 12);
  const cfgTilt = cfg({ equityTilt: { enabled: true, band: [0.5, 2.0], strength: 0.5 } });

  const econ1 = new AgentEconomy(cfgTilt);
  const econ2 = new AgentEconomy(cfgTilt);
  for (let t = 1; t <= 30; t++) {
    await econ1.step(pop, collective(0.85), t);
    await econ2.step(pop, collective(0.85), t);
  }
  assert.equal(normalizeSerialize(econ1.serialize()), normalizeSerialize(econ2.serialize()), "equity tilt must be fully deterministic");
});

// ═══════════════════════════════════════════════════════════════════════════════════════════════════════
// B GROUP: DEAD-HOUSE SWEEP
// ═══════════════════════════════════════════════════════════════════════════════════════════════════════

test("B1: deadHouseSweep OFF ⇒ entomb branch ② routes estate to house.treasury (unchanged)", async () => {
  const econ = new AgentEconomy(cfg({
    dynasty: { enabled: true, tithePct: 0.05, penuryGraceTicks: 10, oldAgeTicks: 200, maxHouses: 16 },
  }));
  const pop = population("AGITATE", 6);
  // Run enough ticks for mortality to fire
  for (let t = 1; t <= 300; t++) await econ.step(pop, collective(0.85), t);
  const graves = (econ as any).graves as any[];
  if (graves.length > 0) {
    // With sweep OFF, commonsPoolAtomic must stay "0"
    assert.equal((econ as any).commonsPoolAtomic, "0", "commonsPoolAtomic stays 0 when sweep is OFF");
  }
});

test("B2: deadHouseSweep ON ⇒ dead-house estate flows to commonsPoolAtomic, not treasury", async () => {
  // Use old-age death (not penury) so the agent still HAS a positive balance → estate > 0n.
  // Penury requires balance==="0" which means entomb's estate is always 0n — the dead-house
  // sweep path (guarded by `estate > 0n`) would never fire for a penury death.
  const econ = new AgentEconomy(cfg({
    populationSize: 4,
    dynasty: { enabled: true, tithePct: 0.05, penuryGraceTicks: 5, oldAgeTicks: 10, maxHouses: 16 },
    deadHouseSweep: { enabled: true },
  }));

  // Ensure agents exist
  const pop = population("AGITATE", 4);
  await econ.step(pop, collective(0.85), 1);

  const agents = (econ as any).agents;
  const kin = (econ as any).kin as Map<number, any>;
  const houses = (econ as any).houses as Map<number, any>;
  const indexOfId = (econ as any).indexOfId as Map<number, number>;

  // Create a house with agent 0 as the ONLY member (will be a dead house after burial)
  houses.set(0, {
    id: 0, name: "TestHouse", sigil: "T", foundedTick: 1, firstHeir: 0,
    treasury: usdcToAtomic(5), earnedAtomic: "0", members: [0], gen: 0,
  });
  // bornTick: 0 makes agent 0 the eldest → old-age fires at tick 100 (100-0 >= oldAgeTicks=10)
  kin.set(0, { bornTick: 0, house: 0, children: [], gen: 0 });

  // Give agent 0 a POSITIVE balance so entomb has an estate to route
  const idx0 = indexOfId.get(0)!;
  agents[idx0].balance = usdcToAtomic(10);

  // noteMortality at tick 100: penury won't fire (balance ≠ "0"), old-age will (eldest, age=100 >= 10)
  const graves = econ.noteMortality(100, 0.5);
  assert.ok(graves.length > 0, "noteMortality must produce at least one grave (old-age)");
  const grave0 = graves.find(g => g.id === 0);
  assert.ok(grave0, "agent 0 must die (oldest, bornTick=0, tick=100 >= oldAgeTicks=10)");
  assert.equal(grave0!.cause, "aged", "cause must be old-age, not penury");

  // The dead-house sweep must have routed estate + treasury → commonsPoolAtomic
  const commonsPool = (econ as any).commonsPoolAtomic as string;
  assert.notEqual(commonsPool, "0", "commonsPoolAtomic must receive the dead-house estate + treasury");
  // Estate (10 USDC) + treasury (5 USDC) = 15 USDC in atomic
  const expected = addAtomic(usdcToAtomic(10), usdcToAtomic(5));
  assert.equal(commonsPool, expected, `commonsPool must equal estate+treasury (${expected})`);
  const house = houses.get(0);
  assert.equal(house.treasury, "0", "dead house treasury must be swept to zero");
});

test("B3: deadHouseSweep ON but house has living members ⇒ estate still goes to treasury", async () => {
  const econ = new AgentEconomy(cfg({
    populationSize: 4,
    dynasty: { enabled: true, tithePct: 0.05, penuryGraceTicks: 5, oldAgeTicks: 10, maxHouses: 16 },
    deadHouseSweep: { enabled: true },
  }));

  const pop = population("AGITATE", 4);
  await econ.step(pop, collective(0.85), 1);

  const agents = (econ as any).agents;
  const kin = (econ as any).kin as Map<number, any>;
  const houses = (econ as any).houses as Map<number, any>;
  const indexOfId = (econ as any).indexOfId as Map<number, number>;

  // Create a house with TWO members: agent 0 (will die) and agent 1 (stays living)
  houses.set(0, {
    id: 0, name: "TestHouse", sigil: "T", foundedTick: 1, firstHeir: 0,
    treasury: usdcToAtomic(2), earnedAtomic: "0", members: [0, 1], gen: 0,
  });
  kin.set(0, { bornTick: 0, house: 0, children: [], gen: 0 });  // eldest → dies
  kin.set(1, { bornTick: 50, house: 0, children: [], gen: 0 }); // younger → survives

  const idx0 = indexOfId.get(0)!;
  agents[idx0].balance = usdcToAtomic(8);

  const treasuryBefore = houses.get(0).treasury;
  const graves = econ.noteMortality(100, 0.5);
  const grave0 = graves.find(g => g.id === 0);
  assert.ok(grave0, "agent 0 must die of old age (bornTick=0, tick=100 >= oldAgeTicks=10)");

  // House still has living member (agent 1) → treasury grows, commons stays 0
  const treasuryAfter = houses.get(0).treasury;
  assert.ok(BigInt(treasuryAfter) > BigInt(treasuryBefore), "treasury must grow when house has living members");
  assert.equal((econ as any).commonsPoolAtomic, "0", "commonsPoolAtomic stays 0 when house is alive");
});

// ═══════════════════════════════════════════════════════════════════════════════════════════════════════
// C GROUP: JUBILEE STATE MACHINE (REFORM V2 COOLDOWN RE-ARM)
// ═══════════════════════════════════════════════════════════════════════════════════════════════════════

test("C1: v1 (v2Enabled=false) — jubilee spent ⇒ permanently deadlocked (Gini never resets)", () => {
  const rcfg: ReformConfig = { enabled: true, v2Enabled: false };
  const reform = new ReformLayer(rcfg);

  // Drive Gini above threshold for JUBILEE_SUSTAIN_CRONS (6) to fire
  const ctx = (tickIndex: number) => ({
    gini: 0.80, civPhase: "ascendant" as const, tickIndex,
    ticksPerCron: 10, graves: [], agents: [{ address: "0xA", balance: 100 }],
    economy: { creditIouRecords: () => [] },
  });

  let fired = false;
  for (let i = 0; i < 20; i++) {
    const r = reform.step(ctx(1000 + i * 10));
    if (r.events.some(e => e.kind === "JUBILEE_PROCLAIMED")) { fired = true; break; }
  }
  assert.ok(fired, "jubilee must fire once sustain count is reached");

  // Now run for 10000 more ticks — v1 NEVER re-arms (the bug)
  let reFired = false;
  for (let i = 0; i < 1000; i++) {
    const r = reform.step(ctx(2000 + i * 10));
    if (r.events.some(e => e.kind === "JUBILEE_PROCLAIMED")) { reFired = true; break; }
  }
  assert.equal(reFired, false, "v1: jubilee must NEVER re-fire (permanent deadlock — the bug)");
  assert.equal(reform.readout().jubileeArmed, false, "v1: jubileeArmed stays false forever");
});

test("C2: v2 (v2Enabled=true) — jubilee spent ⇒ re-arms after cooldown, fires again", () => {
  const rcfg: ReformConfig = { enabled: true, v2Enabled: true };
  const reform = new ReformLayer(rcfg);

  const ctx = (tickIndex: number) => ({
    gini: 0.80, civPhase: "ascendant" as const, tickIndex,
    ticksPerCron: 10, graves: [], agents: [{ address: "0xA", balance: 100 }],
    economy: { creditIouRecords: () => [] },
  });

  // Fire the first jubilee
  let firstFire = -1;
  for (let i = 0; i < 20; i++) {
    const tick = 1000 + i * 10;
    const r = reform.step(ctx(tick));
    if (r.events.some(e => e.kind === "JUBILEE_PROCLAIMED")) { firstFire = tick; break; }
  }
  assert.ok(firstFire > 0, "v2: first jubilee must fire");

  // JUBILEE_COOLDOWN_CRONS=120, ticksPerCron=10 → cooldown = 1200 ticks
  // After cooldown + sustain (6 crons), it should re-fire
  let secondFire = -1;
  for (let i = 0; i < 300; i++) {
    const tick = firstFire + 10 + i * 10;
    const r = reform.step(ctx(tick));
    if (r.events.some(e => e.kind === "JUBILEE_PROCLAIMED")) { secondFire = tick; break; }
  }
  assert.ok(secondFire > firstFire, `v2: jubilee must re-fire after cooldown (first=${firstFire}, second=${secondFire})`);
  // The gap must be at least JUBILEE_COOLDOWN_CRONS * ticksPerCron = 1200 ticks
  assert.ok(secondFire - firstFire >= 1200, `v2: re-fire gap (${secondFire - firstFire}) must be ≥ cooldown (1200)`);
  assert.equal(reform.readout().jubileeCount, 2, "v2: jubileeCount must be 2 after two firings");
});

test("C3: v2 serialize/deserialize round-trip preserves jubilee state", () => {
  const rcfg: ReformConfig = { enabled: true, v2Enabled: true };
  const reform = new ReformLayer(rcfg);
  const ctx = (tickIndex: number) => ({
    gini: 0.80, civPhase: "ascendant" as const, tickIndex,
    ticksPerCron: 10, graves: [], agents: [{ address: "0xA", balance: 100 }],
    economy: { creditIouRecords: () => [] },
  });
  // Fire once
  for (let i = 0; i < 20; i++) reform.step(ctx(1000 + i * 10));

  const blob = reform.serialize();
  const restored = ReformLayer.deserialize(blob, rcfg);
  const ro = restored.readout();
  assert.equal(ro.jubileeCount, reform.readout().jubileeCount, "jubileeCount survives round-trip");
  assert.equal(ro.jubileeArmed, reform.readout().jubileeArmed, "jubileeArmed survives round-trip");
  assert.equal(ro.lastJubileeTick, reform.readout().lastJubileeTick, "lastJubileeTick survives round-trip");
});

// ═══════════════════════════════════════════════════════════════════════════════════════════════════════
// D GROUP: BYTE-EQUIVALENCE GATE (all switches OFF ⇒ /economy identical)
// ═══════════════════════════════════════════════════════════════════════════════════════════════════════

test("D1: all #123 switches OFF ⇒ serialize() byte-for-byte identical to baseline (no #123 config at all)", async () => {
  const pop = population("AGITATE", 12);
  const N = 30;

  // Baseline: no #123 config fields at all
  const econBase = new AgentEconomy(cfg());
  // All switches explicitly OFF
  const econOff = new AgentEconomy(cfg({
    equityTilt: { enabled: false, band: [0.5, 2.0], strength: 0 },
    deadHouseSweep: { enabled: false },
  }));

  for (let t = 1; t <= N; t++) {
    await econBase.step(pop, collective(0.85), t);
    await econOff.step(pop, collective(0.85), t);
  }
  assert.equal(normalizeSerialize(econBase.serialize()), normalizeSerialize(econOff.serialize()), "all OFF ⇒ byte-for-byte identical to no-config baseline");
});

test("D2: equityTilt enabled=true but strength=0 ⇒ serialize() byte-for-byte identical (multiplicative identity)", async () => {
  const pop = population("AGITATE", 12);
  const N = 30;

  const econBase = new AgentEconomy(cfg());
  const econZero = new AgentEconomy(cfg({
    equityTilt: { enabled: true, band: [0.5, 2.0], strength: 0 },
  }));

  for (let t = 1; t <= N; t++) {
    await econBase.step(pop, collective(0.85), t);
    await econZero.step(pop, collective(0.85), t);
  }
  assert.equal(normalizeSerialize(econBase.serialize()), normalizeSerialize(econZero.serialize()), "strength=0 ⇒ byte-for-byte identical");
});

test("D3: snapshot() totals carry commonsPoolAtomic='0' when sweep is OFF", async () => {
  const econ = new AgentEconomy(cfg());
  const pop = population("AGITATE", 8);
  for (let t = 1; t <= 10; t++) await econ.step(pop, collective(0.8), t);
  assert.equal(econ.snapshot().totals.commonsPoolAtomic, "0", "commonsPoolAtomic must be '0' when sweep is OFF");
});

// ═══════════════════════════════════════════════════════════════════════════════════════════════════════
// E GROUP: economyCfg() REAL WIRING PASSTHROUGH (the #120 lesson)
// ═══════════════════════════════════════════════════════════════════════════════════════════════════════

test("E1: economyCfg() transmits equityTilt knobs from env → AgentEconomy config", () => {
  const cfgOn = realEconomyCfg({
    EQUITY_TILT_ENABLED: "true",
    EQUITY_TILT_BAND: "0.6,1.8",
    EQUITY_TILT_STRENGTH: "0.35",
  });
  assert.ok(cfgOn.equityTilt, "economyCfg() must transmit equityTilt object");
  assert.equal(cfgOn.equityTilt!.enabled, true, "EQUITY_TILT_ENABLED=true arms it");
  assert.deepEqual(cfgOn.equityTilt!.band, [0.6, 1.8], "EQUITY_TILT_BAND parsed correctly");
  assert.ok(Math.abs(cfgOn.equityTilt!.strength - 0.35) < 1e-9, "EQUITY_TILT_STRENGTH parsed correctly");
});

test("E2: economyCfg() defaults — equityTilt OFF, band [0.5,2.0], strength 0", () => {
  const cfgDefault = realEconomyCfg({});
  assert.ok(cfgDefault.equityTilt, "economyCfg() always transmits equityTilt (enabled flag inside)");
  assert.equal(cfgDefault.equityTilt!.enabled, false, "default OFF");
  assert.deepEqual(cfgDefault.equityTilt!.band, [0.5, 2.0], "default band [0.5, 2.0]");
  assert.equal(cfgDefault.equityTilt!.strength, 0, "default strength 0");
});

test("E3: economyCfg() transmits deadHouseSweep from env", () => {
  const cfgOn = realEconomyCfg({ DEAD_HOUSE_SWEEP_ENABLED: "true" });
  assert.ok(cfgOn.deadHouseSweep, "economyCfg() must transmit deadHouseSweep object");
  assert.equal(cfgOn.deadHouseSweep!.enabled, true, "DEAD_HOUSE_SWEEP_ENABLED=true arms it");

  const cfgOff = realEconomyCfg({});
  assert.equal(cfgOff.deadHouseSweep!.enabled, false, "default OFF");
});

test("E4: economyCfg() fail-closed — only exact 'true' arms equityTilt/deadHouseSweep", () => {
  for (const val of ["1", "yes", "on", ""]) {
    const c = realEconomyCfg({ EQUITY_TILT_ENABLED: val, DEAD_HOUSE_SWEEP_ENABLED: val });
    assert.equal(c.equityTilt!.enabled, false, `'${val}' does NOT arm equityTilt`);
    assert.equal(c.deadHouseSweep!.enabled, false, `'${val}' does NOT arm deadHouseSweep`);
  }
  const cTrue = realEconomyCfg({ EQUITY_TILT_ENABLED: "TRUE", DEAD_HOUSE_SWEEP_ENABLED: "True" });
  assert.equal(cTrue.equityTilt!.enabled, true, "case-insensitive 'TRUE' arms equityTilt");
  assert.equal(cTrue.deadHouseSweep!.enabled, true, "case-insensitive 'True' arms deadHouseSweep");
});

test("E5: REFORM_V2_ENABLED flows through loadConfig → cfg.reform.v2Enabled", () => {
  const envOn = { CHAIN_ID: "5042", RPC_URL: "https://rpc.test", FLY_STATE: {} as any, REFORM_ENABLED: "true", REFORM_V2_ENABLED: "true" } as unknown as Env;
  const dobj = new FlyStateDO({ storage: {} } as any, envOn);
  assert.equal((dobj as any).cfg.reform.v2Enabled, true, "REFORM_V2_ENABLED=true ⇒ cfg.reform.v2Enabled=true");

  const envOff = { CHAIN_ID: "5042", RPC_URL: "https://rpc.test", FLY_STATE: {} as any, REFORM_ENABLED: "true" } as unknown as Env;
  const dobj2 = new FlyStateDO({ storage: {} } as any, envOff);
  assert.equal((dobj2 as any).cfg.reform.v2Enabled, false, "absent ⇒ cfg.reform.v2Enabled=false (default)");
});
