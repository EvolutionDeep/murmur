/**
 * ㉘ REFORM — unit tests (node:test, mirrors guardians.test.ts's fixture style).
 *
 * Covers: the progressive estate-duty ladder (the free subsistence, the bracket boundaries and the top
 * band), the 50/50 pool↔UBI split and the estate dedup, the jubilee stabilizer (a sustained crisis fires,
 * the hysteresis band re-arms, the long cooldown blocks a churn), the dark-age catalyst multiplier and its
 * one-shot surge, inertness while disabled, and the serialize/deserialize round trip.
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  ReformLayer,
  estateDutyOf,
  catalystMultiplierOf,
  ESTATE_DUTY_THRESHOLD,
  GINI_JUBILEE_THRESHOLD,
  GINI_JUBILEE_RESET,
  JUBILEE_SUSTAIN_CRONS,
  JUBILEE_COOLDOWN_CRONS,
  JUBILEE_TOP_LEVY_RATE,
  CATALYST_GINI_FLOOR,
  CATALYST_CAP,
  type ReformStepContext,
  type ReformStepResult,
  type ReformAgent,
  type ReformIouRecord,
} from "./reform.js";

/** A float compare that survives the binary round-off of the bracket arithmetic. */
function near(actual: number, expected: number, eps = 1e-9): void {
  assert.ok(Math.abs(actual - expected) < eps, `${actual} !≈ ${expected}`);
}

const TICKS_PER_CRON = 6;

function agents(n: number, balance = 10): ReformAgent[] {
  return Array.from({ length: n }, (_, i) => ({ address: `0x${i}`, balance }));
}

function econWith(ious: ReformIouRecord[]): { creditIouRecords: () => ReformIouRecord[] } {
  return { creditIouRecords: () => ious };
}

/** A step context with sane defaults; override any facet per test. */
function ctx(over: Partial<ReformStepContext> = {}): ReformStepContext {
  return {
    gini: 0.3,
    civPhase: "golden",
    tickIndex: 0,
    ticksPerCron: TICKS_PER_CRON,
    graves: [],
    agents: [],
    economy: null,
    ...over,
  };
}

// ─── A. the progressive estate duty ─────────────────────────────────────────────────────────────────────

test("reform: estateDutyOf is exactly 0 at/below the free subsistence", () => {
  assert.equal(estateDutyOf(0), 0);
  assert.equal(estateDutyOf(ESTATE_DUTY_THRESHOLD), 0, "exactly 5 USDC passes untouched");
  assert.equal(estateDutyOf(4.99), 0);
  assert.equal(estateDutyOf(-3), 0, "a negative/garbage estate owes nothing");
  assert.equal(estateDutyOf(Number.NaN), 0, "a non-finite estate owes nothing");
});

test("reform: estateDutyOf climbs the bracket ladder at each boundary", () => {
  // 15: only the first band bites — (15−5)×0.10 = 1.0
  near(estateDutyOf(15), 1.0);
  // 40: band 1 (10×0.10=1.0) + band 2 (25×0.25=6.25) = 7.25
  near(estateDutyOf(40), 7.25);
  // 50: 7.25 + band 3 (10×0.40=4.0) = 11.25
  near(estateDutyOf(50), 11.25);
  // monotone: a bigger estate never owes less
  assert.ok(estateDutyOf(100) > estateDutyOf(50));
});

test("reform: a taxed estate splits half to the commons pool, half to a flat UBI", () => {
  const r = new ReformLayer({ enabled: true });
  const living = agents(2);
  const res = r.step(ctx({ graves: [{ address: "0xdead", balance: 40 }], agents: living }));

  const est = res.events.find((e) => e.kind === "ESTATE_LEVIED");
  assert.ok(est && est.kind === "ESTATE_LEVIED", "the duty speaks");
  near(est.tax, 7.25);
  near(est.gross, 40);
  near(est.ubiPerAgent, 3.625 / 2, 1e-9);

  // half the duty is standing public purse, half went out the door as UBI this cron
  const ro = r.readout();
  near(ro.commonsPoolBalance, 3.625);
  near(ro.estateDutyCollected, 7.25);
  assert.equal(res.ubiDistributions.length, 2, "every living citizen is paid");
  near(res.ubiDistributions[0].amount, 3.625 / 2);
});

test("reform: an estate with nobody living to pay sends the whole duty to the pool", () => {
  const r = new ReformLayer({ enabled: true });
  const res = r.step(ctx({ graves: [{ address: "0xdead", balance: 40 }], agents: [] }));
  assert.ok(res.events.some((e) => e.kind === "ESTATE_LEVIED"));
  near(r.readout().commonsPoolBalance, 7.25, 1e-9);
  assert.equal(res.ubiDistributions.length, 0);
});

test("reform: a bare-subsistence estate is silent, and one address is duty'd once per lifetime", () => {
  const r = new ReformLayer({ enabled: true });
  const living = agents(3);
  // below the threshold → no event, no pool
  const poor = r.step(ctx({ graves: [{ address: "0xpauper", balance: ESTATE_DUTY_THRESHOLD }], agents: living }));
  assert.equal(poor.events.length, 0, "a subsistence estate owes nothing");
  near(r.readout().commonsPoolBalance, 0);

  // a real estate → one event
  const first = r.step(ctx({ graves: [{ address: "0xrich", balance: 40 }], agents: living }));
  assert.equal(first.events.filter((e) => e.kind === "ESTATE_LEVIED").length, 1);
  // the SAME address replayed (the grave ring is a rolling window) → deduped, no second duty
  const again = r.step(ctx({ graves: [{ address: "0xrich", balance: 40 }], agents: living }));
  assert.equal(again.events.filter((e) => e.kind === "ESTATE_LEVIED").length, 0, "an estate is duty'd once");
  near(r.readout().estateDutyCollected, 7.25);
});

// ─── C. the jubilee stabilizer ────────────────────────────────────────────────────────────────────────────

/** Sustain `crons` over-threshold crons, one step each, ticks advancing by TICKS_PER_CRON. */
function sustain(r: ReformLayer, crons: number, gini: number, startTick: number, agentsList: ReformAgent[], econ: ReformStepContext["economy"]): ReformStepResult {
  let last = r.step(ctx({ gini, tickIndex: startTick, agents: agentsList, economy: econ }));
  for (let i = 1; i < crons; i++) {
    last = r.step(ctx({ gini, tickIndex: startTick + i * TICKS_PER_CRON, agents: agentsList, economy: econ }));
  }
  return last;
}

test("reform: a jubilee is proclaimed once the Gini holds over the threshold for the sustain run", () => {
  const r = new ReformLayer({ enabled: true });
  const living = agents(10);
  const econ = econWith([
    { id: "iou:1", debtor: 1, creditor: 2, amountUsdc: 3 },
    { id: "iou:2", debtor: 3, creditor: 4, amountUsdc: 5 },
  ]);

  // one short of the run → not yet
  sustain(r, JUBILEE_SUSTAIN_CRONS - 1, 0.8, TICKS_PER_CRON, living, econ);
  assert.equal(r.readout().jubileeCount, 0, "the run must complete");

  // the completing cron proclaims it
  const res = sustain(r, 1, 0.8, JUBILEE_SUSTAIN_CRONS * TICKS_PER_CRON, living, econ);
  const jub = res.events.find((e) => e.kind === "JUBILEE_PROCLAIMED");
  assert.ok(jub && jub.kind === "JUBILEE_PROCLAIMED", "the levitical year is news this cron");
  assert.equal(jub.debtsForgiven, 2, "every enumerable IOU is forgiven");
  assert.deepEqual(res.debtForgiveness, ["iou:1", "iou:2"]);

  const ro = r.readout();
  assert.equal(ro.jubileeCount, 1);
  assert.equal(ro.jubileeArmed, false, "a spent stabilizer must re-arm");
  assert.equal(ro.giniSustainCount, 0);

  // the wealthiest tenth is levied 5%; with 10 citizens that is the single richest wallet
  const topLevy = living[0].balance * JUBILEE_TOP_LEVY_RATE;
  assert.equal(res.levyDeductions.length, 1);
  near(res.levyDeductions[0].amount, topLevy);
  near(jub.levyCollected, topLevy);
  // the stimulus divides the levy + the (empty) pool across all ten
  near(jub.stimulusPerAgent, topLevy / 10);
});

test("reform: the hysteresis band holds the arm; only a fall to RESET re-arms a spent stabilizer", () => {
  const r = new ReformLayer({ enabled: true });
  const living = agents(10);
  const econ = econWith([]);
  sustain(r, JUBILEE_SUSTAIN_CRONS, 0.8, TICKS_PER_CRON, living, econ);
  assert.equal(r.readout().jubileeArmed, false, "disarmed after proclaiming");

  // inside the band (RESET < gini ≤ THRESHOLD) → nothing re-arms, the run does not climb
  r.step(ctx({ gini: (GINI_JUBILEE_RESET + GINI_JUBILEE_THRESHOLD) / 2, tickIndex: 100, agents: living, economy: econ }));
  assert.equal(r.readout().jubileeArmed, false, "the band changes nothing");
  assert.equal(r.readout().giniSustainCount, 0);

  // a fall to the reset line re-arms
  r.step(ctx({ gini: GINI_JUBILEE_RESET, tickIndex: 106, agents: living, economy: econ }));
  assert.equal(r.readout().jubileeArmed, true, "equal enough to deserve a reset");
});

test("reform: the cooldown blocks a second jubilee until it elapses", () => {
  const r = new ReformLayer({ enabled: true });
  const living = agents(10);
  const econ = econWith([{ id: "iou:1", debtor: 1, creditor: 2, amountUsdc: 3 }]);

  sustain(r, JUBILEE_SUSTAIN_CRONS, 0.8, TICKS_PER_CRON, living, econ);
  assert.equal(r.readout().jubileeCount, 1);
  const firstTick = r.readout().lastJubileeTick!;
  assert.equal(firstTick, JUBILEE_SUSTAIN_CRONS * TICKS_PER_CRON);

  // re-arm, then sustain again well INSIDE the cooldown window → no second jubilee
  r.step(ctx({ gini: GINI_JUBILEE_RESET, tickIndex: firstTick + TICKS_PER_CRON, agents: living, economy: econ }));
  assert.equal(r.readout().jubileeArmed, true);
  const nearTick = firstTick + 2 * TICKS_PER_CRON;
  sustain(r, JUBILEE_SUSTAIN_CRONS, 0.8, nearTick, living, econ);
  assert.equal(r.readout().jubileeCount, 1, "still cooling down");

  // re-arm, then sustain BEYOND the cooldown window → it fires again
  const farBase = firstTick + JUBILEE_COOLDOWN_CRONS * TICKS_PER_CRON + TICKS_PER_CRON;
  r.step(ctx({ gini: GINI_JUBILEE_RESET, tickIndex: farBase, agents: living, economy: econ }));
  assert.equal(r.readout().jubileeArmed, true);
  sustain(r, JUBILEE_SUSTAIN_CRONS, 0.8, farBase + TICKS_PER_CRON, living, econ);
  assert.equal(r.readout().jubileeCount, 2, "the cooldown elapsed, the year returns");
});

// ─── F. the dark-age catalyst ──────────────────────────────────────────────────────────────────────────────

test("reform: the catalyst multiplier is 1 below the floor and climbs to the cap", () => {
  assert.equal(catalystMultiplierOf(0.2, "golden"), 1, "no pressure, no surge");
  assert.equal(catalystMultiplierOf(CATALYST_GINI_FLOOR, "golden"), 1, "exactly at the floor is still silent");
  const expectedMid = 1 + CATALYST_CAP * ((0.6 - CATALYST_GINI_FLOOR) / (GINI_JUBILEE_THRESHOLD - CATALYST_GINI_FLOOR));
  near(catalystMultiplierOf(0.6, "golden"), expectedMid, 1e-9);
  near(catalystMultiplierOf(GINI_JUBILEE_THRESHOLD, "golden"), 1 + CATALYST_CAP, 1e-9);
  near(catalystMultiplierOf(0.99, "golden"), 1 + CATALYST_CAP, 1e-9); // clamped at the cap
});

test("reform: a dark age lights the catalyst even at a modest Gini, and the surge is one-shot", () => {
  const r = new ReformLayer({ enabled: true });
  // gini 0.6 in a golden age → multiplier > 1.1 → a surge is NEWSED once
  const first = r.step(ctx({ gini: 0.6, civPhase: "golden" }));
  const surge = first.events.find((e) => e.kind === "CATALYST_SURGE");
  assert.ok(surge && surge.kind === "CATALYST_SURGE");
  near(first.catalystMultiplier, 1 + CATALYST_CAP * ((0.6 - CATALYST_GINI_FLOOR) / (GINI_JUBILEE_THRESHOLD - CATALYST_GINI_FLOOR)), 1e-9);
  near(r.readout().catalystMultiplier, first.catalystMultiplier, 1e-9);

  // holding the same pressure → no second surge (it is a climate, not an event)
  const second = r.step(ctx({ gini: 0.6, civPhase: "golden", tickIndex: TICKS_PER_CRON }));
  assert.equal(second.events.filter((e) => e.kind === "CATALYST_SURGE").length, 0);
  // but the multiplier is still published for culture/invention to spend
  near(second.catalystMultiplier, first.catalystMultiplier, 1e-9);
});

// ─── inertness + persistence ──────────────────────────────────────────────────────────────────────────────

test("reform: a disabled layer is inert — no events, a neutral multiplier, no bookkeeping", () => {
  const r = new ReformLayer({ enabled: false });
  const res = r.step(ctx({ gini: 0.99, civPhase: "dark", graves: [{ address: "0xdead", balance: 40 }], agents: agents(5) }));
  assert.equal(res.events.length, 0);
  assert.equal(res.catalystMultiplier, 1);
  assert.equal(res.ubiDistributions.length, 0);
  assert.equal(res.debtForgiveness.length, 0);
  const ro = r.readout();
  assert.equal(ro.enabled, false);
  assert.equal(ro.estateDutyCollected, 0);
  assert.equal(ro.commonsPoolBalance, 0);
  assert.equal(ro.jubileeCount, 0);
});

test("reform: serialize/deserialize is a faithful round trip (and a corrupt blob restarts cold)", () => {
  const r = new ReformLayer({ enabled: true });
  const living = agents(10);
  const econ = econWith([{ id: "iou:1", debtor: 1, creditor: 2, amountUsdc: 3 }]);
  // gather a little duty, then proclaim a jubilee so several scalars are non-trivial
  r.step(ctx({ graves: [{ address: "0xdead", balance: 40 }], agents: living, economy: econ }));
  sustain(r, JUBILEE_SUSTAIN_CRONS, 0.8, TICKS_PER_CRON, living, econ);
  const before = r.readout();

  const restored = ReformLayer.deserialize(r.serialize());
  const after = restored.readout();
  assert.equal(after.enabled, true);
  near(after.estateDutyCollected, before.estateDutyCollected);
  assert.equal(after.jubileeCount, before.jubileeCount);
  assert.equal(after.jubileeArmed, before.jubileeArmed);
  assert.equal(after.giniSustainCount, before.giniSustainCount);
  assert.equal(after.lastJubileeTick, before.lastJubileeTick);
  near(after.commonsPoolBalance, before.commonsPoolBalance);

  // a legitimate 0 survives (the house-id-0 pitfall: never `Number(v) || d`)
  const zeroed = new ReformLayer({ enabled: true });
  const rt = ReformLayer.deserialize(zeroed.serialize()).readout();
  assert.equal(rt.estateDutyCollected, 0);
  assert.equal(rt.jubileeCount, 0);
  assert.equal(rt.commonsPoolBalance, 0);
  assert.equal(rt.lastJubileeTick, null);
  assert.equal(rt.jubileeArmed, true);

  // corrupt / absent → a cold layer, never a poisoned one
  const cold = ReformLayer.deserialize("{ this is not json").readout();
  assert.equal(cold.jubileeCount, 0);
  assert.equal(cold.estateDutyCollected, 0);
  assert.equal(ReformLayer.deserialize("").readout().jubileeArmed, true);
});
