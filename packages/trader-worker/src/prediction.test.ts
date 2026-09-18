// Prediction-market tests — the invariants that make an on-chain betting round trustworthy with real money.
//
// The whole point of the market is that it is STRICTLY ZERO-SUM with NO HOUSE: whatever the agents stake
// is exactly what comes back out (Σpayout == Σstake, Σnet == 0), a FLAT or unmatched round refunds
// everyone rather than silently keeping funds, and the bilateral settlement flows reproduce each agent's
// net PnL exactly (so folding them into the economy's netting moves precisely the right USDC). These tests
// also pin direction determinism (the neural read-out, not RNG, picks the side), the receipt-hash
// self-consistency behind /predictions/verify, and serialize/restore so a DO eviction can't lose a round.

import test from "node:test";
import assert from "node:assert/strict";

import { PredictionMarket, type PredictConfig } from "./prediction.js";
import type { FlyReading } from "./population.js";

function cfg(over: Partial<PredictConfig> = {}): PredictConfig {
  return {
    enabled: true, network: "arc", stakeUsdc: 0.002, maxStakeUsdc: 0.01,
    flatBand: 0.008, commit: true, recentCap: 16, ...over,
  };
}

function fly(id: number, over: Partial<FlyReading> = {}): FlyReading {
  return {
    id, state: "EXPLORE", arousal: 0.6, turnBias: 0.3, cohesion: 0.5,
    wingbeat: 0.5, rest: 0.05, temperament: (id % 10) / 10, fingerprint: `fp${id}`,
    ...over,
  };
}

/** A balanced book: three UP (ids 0,2,4) and three DOWN (ids 1,3,5), with varied arousal ⇒ varied stakes. */
function mixedReadings(): FlyReading[] {
  return [
    fly(0, { turnBias: 0.8, arousal: 0.9 }),
    fly(1, { turnBias: -0.7, arousal: 0.5 }),
    fly(2, { turnBias: 0.4, arousal: 0.3 }),
    fly(3, { turnBias: -0.9, arousal: 0.8 }),
    fly(4, { turnBias: 0.2, arousal: 0.6 }),
    fly(5, { turnBias: -0.3, arousal: 0.4 }),
  ];
}

/** A balance far above any stake so the balance/4 cap never binds (except where a test says otherwise). */
const richBalance = () => "6000000";

test("a decisive round is zero-sum: Σpayout == Σstake and Σnet == 0", async () => {
  const pm = new PredictionMarket(cfg());
  pm.openRound(mixedReadings(), 0.5, 0, 1, richBalance);
  const res = await pm.resolveRound(0.62, 2);   // Δ +0.12 > flatBand ⇒ UP
  assert.ok(res);
  const round = res!.round;
  assert.equal(round.outcome, "UP");
  let stake = 0n, payout = 0n, net = 0n;
  for (const b of round.bets) {
    stake += BigInt(b.stake);
    payout += BigInt(b.payout);
    net += BigInt(b.net);
    assert.equal(BigInt(b.payout) - BigInt(b.stake), BigInt(b.net), `net == payout − stake for ${b.id}`);
  }
  assert.equal(payout, stake, "parimutuel conserves value: total payout == total staked");
  assert.equal(net, 0n, "zero-sum: the signed nets cancel exactly");
  assert.equal(BigInt(round.totalStaked), stake, "totalStaked == Σstakes");
  assert.ok(round.flows.length > 0, "a decisive round with both sides produces settlement flows");
});

test("a FLAT resolution refunds every stake and moves no money", async () => {
  const pm = new PredictionMarket(cfg());
  pm.openRound(mixedReadings(), 0.5, 0, 1, richBalance);
  const res = await pm.resolveRound(0.502, 2);  // Δ +0.002 ≤ flatBand ⇒ FLAT
  assert.equal(res!.round.outcome, "FLAT");
  assert.equal(res!.flows.length, 0, "no settlement flows on a refund");
  for (const b of res!.round.bets) {
    assert.equal(b.payout, b.stake, "stake fully returned");
    assert.equal(b.net, "0");
    assert.equal(b.hit, false, "a FLAT round is nobody's hit");
  }
});

test("a one-sided book with no winners refunds everyone (there is no house to absorb it)", async () => {
  const pm = new PredictionMarket(cfg());
  const readings = [fly(0, { turnBias: 0.5 }), fly(1, { turnBias: 0.6 }), fly(2, { turnBias: 0.7 })];
  pm.openRound(readings, 0.5, 0, 1, richBalance);   // all UP
  const res = await pm.resolveRound(0.3, 2);          // Δ −0.2 ⇒ DOWN, but nobody backed DOWN
  assert.equal(res!.round.outcome, "DOWN");
  assert.equal(res!.flows.length, 0, "no winners ⇒ nothing moves");
  for (const b of res!.round.bets) {
    assert.equal(b.payout, b.stake, "unmatched stakes are returned");
    assert.equal(b.net, "0");
  }
});

test("settlement flows reproduce each bettor's net PnL exactly (zero-sum matching)", async () => {
  const pm = new PredictionMarket(cfg());
  pm.openRound(mixedReadings(), 0.5, 0, 1, richBalance);
  const res = await pm.resolveRound(0.62, 2);
  const perAgent = new Map<number, bigint>();
  let moved = 0n;
  for (const f of res!.flows) {
    const amt = BigInt(f.amount);
    assert.ok(amt > 0n, "every flow moves a positive amount");
    moved += amt;
    perAgent.set(f.fromId, (perAgent.get(f.fromId) ?? 0n) - amt);
    perAgent.set(f.toId, (perAgent.get(f.toId) ?? 0n) + amt);
  }
  for (const b of res!.round.bets) {
    assert.equal(perAgent.get(b.id) ?? 0n, BigInt(b.net), `flows reproduce agent ${b.id}'s net`);
  }
  // Total moved == total won == the losing pool.
  const lost = res!.round.bets.filter((b) => BigInt(b.net) < 0n).reduce((s, b) => s - BigInt(b.net), 0n);
  assert.equal(moved, lost, "gross flow == total losses (== total winnings)");
});

test("bet direction is deterministic from the neural read-out (turnBias sign at zero momentum)", async () => {
  const pm = new PredictionMarket(cfg());
  const readings = [
    fly(0, { turnBias: 0.8 }), fly(1, { turnBias: -0.8 }),
    fly(2, { turnBias: 0.2 }), fly(3, { turnBias: -0.2 }),
  ];
  const r1 = pm.openRound(readings, 0.5, 0, 1, richBalance)!;
  assert.deepEqual(r1.bets.map((b) => b.side), ["UP", "DOWN", "UP", "DOWN"]);
  const r2 = pm.openRound(readings, 0.5, 0, 2, richBalance)!;   // identical inputs, next round
  assert.deepEqual(r2.bets.map((b) => b.side), r1.bets.map((b) => b.side), "same read-out ⇒ same sides");
});

test("a resting fly sits out the round", async () => {
  const pm = new PredictionMarket(cfg());
  const readings = [fly(0, { turnBias: 0.5, rest: 0.05 }), fly(1, { turnBias: -0.5, rest: 0.9 })];
  const open = pm.openRound(readings, 0.5, 0, 1, richBalance)!;
  assert.deepEqual(open.bets.map((b) => b.id), [0], "rest > 0.6 excludes the fly");
});

test("a stake is capped at a quarter of the agent's balance", async () => {
  const pm = new PredictionMarket(cfg({ stakeUsdc: 5, maxStakeUsdc: 100 }));
  pm.openRound([fly(0, { turnBias: 0.5, arousal: 1 })], 0.5, 0, 1, () => "6000000");
  const open = pm.snapshot().open!;
  assert.equal(open.bets[0].stake, "1500000", "stake clamped to balance/4 (1.5 USDC of a 6 USDC wallet)");
});

test("hit-rate leaderboard credits winners, penalises losers, and ranks by accuracy", async () => {
  const pm = new PredictionMarket(cfg());
  pm.openRound(mixedReadings(), 0.5, 0, 1, richBalance);
  await pm.resolveRound(0.62, 2);   // UP wins
  const lb = pm.leaderboard();
  assert.equal(lb.length, 6, "one row per bettor");
  for (let i = 1; i < lb.length; i++) {
    assert.ok(lb[i - 1].hitRate >= lb[i].hitRate, "rows sorted by hit-rate, descending");
  }
  const winner = lb.find((r) => r.id === 0)!;   // bet UP ⇒ hit
  const loser = lb.find((r) => r.id === 1)!;    // bet DOWN ⇒ miss
  assert.equal(winner.hits, 1);
  assert.equal(winner.rounds, 1);
  assert.ok(winner.pnlUsdc > 0, "a winner's realized PnL is positive");
  assert.equal(loser.hits, 0);
  assert.ok(loser.pnlUsdc < 0, "a loser's realized PnL is negative");
});

test("verifyRound recomputes the stored receipt hash (self-consistent, 64-hex)", async () => {
  const pm = new PredictionMarket(cfg());
  pm.openRound(mixedReadings(), 0.5, 0, 1, richBalance);
  const res = await pm.resolveRound(0.62, 2);
  assert.match(res!.round.receiptHash, /^[0-9a-f]{64}$/, "receipt hash is 64 lowercase hex");
  const v = await pm.verifyRound(res!.round.round);
  assert.equal(v.found, true);
  assert.equal(v.selfConsistent, true, "recomputed hash == published receiptHash");
  assert.equal(v.recomputed, res!.round.receiptHash);
  const missing = await pm.verifyRound(999999);
  assert.equal(missing.found, false, "an unknown round is reported not-found");
});

test("a tampered resolution would not verify (hash binds temps + outcome + payouts)", async () => {
  const pm = new PredictionMarket(cfg());
  pm.openRound(mixedReadings(), 0.5, 0, 1, richBalance);
  const res = await pm.resolveRound(0.62, 2);
  const rr = res!.round;
  const original = rr.receiptHash;
  rr.exitTemp = 0.99;   // an operator tries to rewrite the resolved temperature after the fact
  const v = await pm.verifyRound(rr.round);
  assert.equal(v.selfConsistent, false, "mutating a resolved field breaks the recomputed hash");
  assert.notEqual(v.recomputed, original);
});

test("serialize/restore preserves the open round, resolved history and stats", async () => {
  const pm = new PredictionMarket(cfg());
  pm.openRound(mixedReadings(), 0.5, 0, 1, richBalance);
  await pm.resolveRound(0.62, 2);
  pm.openRound(mixedReadings(), 0.62, 0, 3, richBalance);
  const before = pm.snapshot();
  const pm2 = new PredictionMarket(cfg(), pm.serialize());
  const after = pm2.snapshot();
  assert.deepEqual(after, before, "the snapshot is byte-identical across a restore");
  assert.equal(after.open?.round, before.open?.round, "the live round survives eviction");
  assert.equal(after.recent.length, before.recent.length, "resolved history survives");
  assert.equal(after.totals.roundsResolved, before.totals.roundsResolved);
});

test("resolve with no open round is a safe no-op (returns null)", async () => {
  const pm = new PredictionMarket(cfg());
  assert.equal(await pm.resolveRound(0.7, 1), null, "nothing to resolve ⇒ null, never a throw");
});
