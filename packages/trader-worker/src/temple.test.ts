/**
 * ㉙ TEMPLE — unit tests (node:test, mirrors reform.test.ts's fixture style).
 *
 * Covers: the tier cost ladder at every boundary (999/1000 … 999999/1000000), the persisted dedup ring (a
 * burn is honoured once, ever), the queue cap, the per-cron execution budget (MAX_PER_CRON + MAX_TIER3_PER_CRON),
 * an oracle whisper's arousal stimulus, a nation blessing's sub-tick expiry, a wonder's permanence, the
 * serialize/deserialize round trip, invalid-kind rejection, and the standing read-out's shape.
 *
 * The chain touch (verifyBurn) is exercised through a mock TempleChainClient that hands back a viem-shaped
 * receipt, so the tests never leave the process — the layer's only I/O is a pure function of that receipt.
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  TempleLayer,
  isTempleKind,
  KIND_TIER,
  TIER_MINIMUMS,
  MAX_QUEUE,
  MAX_PER_CRON,
  MAX_TIER3_PER_CRON,
  DEDUP_RING_SIZE,
  BLESSING_DURATION,
  WHISPER_DURATION,
  BURN_ADDRESS,
  MURMUR_TOKEN,
  TRANSFER_TOPIC,
  type TempleKind,
  type TempleQueueEntry,
  type TempleStepContext,
  type TempleChainClient,
  type TempleReceipt,
} from "./temple.js";

/** A valid 0x + 40-hex submitter wallet. */
const ADDR = "0x" + "ab".repeat(20);
/** A valid 0x + 64-hex tx hash. */
const TX = "0x" + "cd".repeat(32);
const SCALE = 10n ** 18n; // MURMUR has 18 decimals

/** A distinct valid tx hash per index (so multi-submit tests never trip the dedup ring). */
function txAt(i: number): string {
  return "0x" + i.toString(16).padStart(64, "0");
}

/** Left-pad an address to a 32-byte indexed-topic word (lowercase) — mirrors temple's private padTopic. */
function pad(addr: string): string {
  return "0x" + addr.toLowerCase().slice(2).padStart(64, "0");
}

/** A mock chain client whose receipt is a genuine Transfer(ADDR → 0x…dEaD) of `value` atomic MURMUR. */
function burnClient(value: bigint, over: Partial<TempleReceipt> = {}): TempleChainClient {
  const receipt: TempleReceipt = {
    status: "success",
    to: MURMUR_TOKEN,
    logs: [
      {
        address: MURMUR_TOKEN,
        topics: [TRANSFER_TOPIC, pad(ADDR), pad(BURN_ADDRESS)],
        data: "0x" + value.toString(16),
      },
    ],
    ...over,
  };
  return { getTransactionReceipt: async () => receipt };
}

/** A queue entry with sane defaults; override any facet per test. */
function entry(over: Partial<TempleQueueEntry> = {}): TempleQueueEntry {
  return {
    txHash: TX,
    kind: "ORACLE_WHISPER",
    params: {},
    address: ADDR,
    burnAmount: 1_000n * SCALE,
    tier: 1,
    submittedAt: 0,
    ...over,
  };
}

/** A step context with sane defaults; override any facet per test. */
function ctx(over: Partial<TempleStepContext> = {}): TempleStepContext {
  return {
    tickIndex: 0,
    liveFlyIds: [0, 1, 2, 3, 4],
    flyNames: new Map<number, string>([[0, "Ada"], [1, "Bram"], [2, "Cato"], [3, "Dido"], [4, "Egon"]]),
    nations: [
      { id: 0, name: "Ur", members: [0, 1] },
      { id: 1, name: "Kish", members: [2, 3] },
    ],
    commonsPoolUsdc: 5,
    economy: {
      socialReadout: () => ({ gini: 0.3, agents: [{ address: "0xaaa", balance: 10 }] }),
      absorbFlows: () => {},
      applyLaw: () => {},
    },
    culture: null,
    stimuli: [],
    hatchSlot: () => 5,
    ...over,
  };
}

// ─── 1. the tier cost ladder at every boundary ──────────────────────────────────────────────────────────

test("temple: verifyBurn clears each tier exactly at its minimum and refuses one atom below", async () => {
  const layer = new TempleLayer({ enabled: true });
  const cases: Array<{ kind: TempleKind; tier: number; below: bigint; at: bigint }> = [
    { kind: "ORACLE_WHISPER", tier: 1, below: 999n, at: 1_000n },
    { kind: "DIRECTED_MUTATION", tier: 2, below: 9_999n, at: 10_000n },
    { kind: "DIVINE_DECREE", tier: 3, below: 99_999n, at: 100_000n },
    { kind: "EPOCH_SHAPING", tier: 4, below: 999_999n, at: 1_000_000n },
  ];
  for (const c of cases) {
    assert.equal(KIND_TIER[c.kind], c.tier, `${c.kind} sits on tier ${c.tier}`);
    assert.equal(TIER_MINIMUMS[c.tier], c.at * SCALE, `tier ${c.tier} minimum is ${c.at} MURMUR`);

    const low = await layer.verifyBurn(TX, c.kind, {}, ADDR, burnClient(c.below * SCALE));
    assert.equal(low.valid, false, `${c.kind} one atom below its minimum must be refused`);

    const ok = await layer.verifyBurn(TX, c.kind, {}, ADDR, burnClient(c.at * SCALE));
    assert.equal(ok.valid, true, `${c.kind} exactly at its minimum must pass`);
    assert.equal(ok.burnAmount, c.at * SCALE, "the verified amount is the burned amount");
  }
});

test("temple: verifyBurn rejects a non-burn, a failed tx and a wrong contract", async () => {
  const layer = new TempleLayer({ enabled: true });
  // A Transfer to somewhere that is NOT the burn sink is not a burn.
  const notBurn = burnClient(1_000n * SCALE, {
    logs: [{ address: MURMUR_TOKEN, topics: [TRANSFER_TOPIC, pad(ADDR), pad(ADDR)], data: "0x" + (1_000n * SCALE).toString(16) }],
  });
  assert.equal((await layer.verifyBurn(TX, "ORACLE_WHISPER", {}, ADDR, notBurn)).valid, false);
  // A reverted tx burns nothing.
  const reverted = burnClient(1_000n * SCALE, { status: "reverted" });
  assert.equal((await layer.verifyBurn(TX, "ORACLE_WHISPER", {}, ADDR, reverted)).valid, false);
  // A tx that never called the MURMUR contract is irrelevant.
  const wrongTo = burnClient(1_000n * SCALE, { to: "0x" + "ee".repeat(20) });
  assert.equal((await layer.verifyBurn(TX, "ORACLE_WHISPER", {}, ADDR, wrongTo)).valid, false);
});

// ─── 2. the persisted dedup ring ────────────────────────────────────────────────────────────────────────

test("temple: the dedup ring honours a tx hash once, ever (even across a round trip)", () => {
  const layer = new TempleLayer({ enabled: true });
  const first = layer.submit(entry({ txHash: txAt(1) }));
  assert.equal(first.ok, true);
  assert.equal(first.queuePosition, 1);

  const replay = layer.submit(entry({ txHash: txAt(1), kind: "CULTURAL_SEED" }));
  assert.equal(replay.ok, false, "a replayed hash is refused");
  assert.match(replay.error ?? "", /duplicate/i);

  // The ring survives persistence, so an eviction cannot let a burn be honoured twice.
  const restored = TempleLayer.deserialize(layer.serialize());
  assert.equal(restored.submit(entry({ txHash: txAt(1) })).ok, false, "the dedup ring is persisted");
});

test("temple: the dedup ring is bounded to DEDUP_RING_SIZE", () => {
  const layer = new TempleLayer({ enabled: true });
  // The queue cap would block submits long before the ring fills, so drain a cron each round: +1 admitted,
  // up to MAX_PER_CRON executed, so the queue stays low and every distinct hash reaches the ring.
  for (let i = 0; i < DEDUP_RING_SIZE + 40; i++) {
    layer.submit(entry({ txHash: txAt(i) }));
    layer.step(ctx({ tickIndex: i }));
  }
  const ring = JSON.parse(layer.serialize()).dedupRing as string[];
  assert.equal(ring.length, DEDUP_RING_SIZE, "the ring never grows past its cap");
});

// ─── 3. the queue cap ───────────────────────────────────────────────────────────────────────────────────

test("temple: the queue refuses a submit past MAX_QUEUE", () => {
  const layer = new TempleLayer({ enabled: true });
  for (let i = 0; i < MAX_QUEUE; i++) {
    assert.equal(layer.submit(entry({ txHash: txAt(i) })).ok, true, `slot ${i} admitted`);
  }
  const overflow = layer.submit(entry({ txHash: txAt(MAX_QUEUE) }));
  assert.equal(overflow.ok, false, "the 21st submit is refused");
  assert.match(overflow.error ?? "", /full/i);
  assert.equal(layer.readout().queueLength, MAX_QUEUE);
});

// ─── 4. the per-cron execution budget ───────────────────────────────────────────────────────────────────

test("temple: step executes at most MAX_PER_CRON interventions per cron", () => {
  const layer = new TempleLayer({ enabled: true });
  for (let i = 0; i < 5; i++) layer.submit(entry({ txHash: txAt(i), kind: "ORACLE_WHISPER", tier: 1 }));
  const res = layer.step(ctx({ tickIndex: 0 }));
  assert.equal(res.executed.length, MAX_PER_CRON, "a slow burn, never a flood");
  assert.equal(layer.readout().queueLength, 5 - MAX_PER_CRON, "the rest stay queued");
});

test("temple: step executes at most MAX_TIER3_PER_CRON Tier-3+ interventions per cron", () => {
  const layer = new TempleLayer({ enabled: true });
  // Two decrees (Tier 3) queued back to back: only one may fire this cron.
  layer.submit(entry({ txHash: txAt(1), kind: "DIVINE_DECREE", tier: 3, burnAmount: 100_000n * SCALE }));
  layer.submit(entry({ txHash: txAt(2), kind: "DIVINE_DECREE", tier: 3, burnAmount: 100_000n * SCALE }));
  const res = layer.step(ctx({ tickIndex: 0 }));
  const decrees = res.executed.filter((e) => e.kind === "DIVINE_DECREE");
  assert.equal(decrees.length, MAX_TIER3_PER_CRON, "at most one Tier-3+ per cron");
  assert.equal(layer.readout().queueLength, 1, "the second decree waits for the next cron");
});

// ─── 5. an oracle whisper's arousal stimulus ────────────────────────────────────────────────────────────

test("temple: ORACLE_WHISPER emits an arousal stimulus of the right sign and duration", () => {
  const layer = new TempleLayer({ enabled: true });
  layer.submit(entry({ txHash: txAt(1), kind: "ORACLE_WHISPER", tier: 1, params: { flyId: 2, direction: "down" } }));
  const down = layer.step(ctx({ tickIndex: 0 }));
  assert.equal(down.stimuliToInject.length, 1);
  assert.deepEqual(down.stimuliToInject[0], {
    flyId: 2, channel: "arousal", intensity: -0.3, duration: WHISPER_DURATION,
  });
  assert.equal(down.executed[0].detail.flyName, "Cato", "the chronicle token carries the fly's name");

  const layer2 = new TempleLayer({ enabled: true });
  layer2.submit(entry({ txHash: txAt(2), kind: "ORACLE_WHISPER", tier: 1, params: { flyId: 3, direction: "up" } }));
  const up = layer2.step(ctx({ tickIndex: 0 }));
  assert.equal(up.stimuliToInject[0].intensity, 0.3, "an upward stir is positive");
});

// ─── 6. a nation blessing's sub-tick expiry ─────────────────────────────────────────────────────────────

test("temple: NATION_BLESSING expires after BLESSING_DURATION crons (×6 sub-ticks)", () => {
  const layer = new TempleLayer({ enabled: true });
  layer.submit(entry({ txHash: txAt(1), kind: "NATION_BLESSING", tier: 2, burnAmount: 10_000n * SCALE, params: { nationId: 0 } }));
  layer.step(ctx({ tickIndex: 0 }));
  assert.equal(layer.readout().activeBuffs.length, 1, "the blessing is in force");
  assert.equal(layer.readout().activeBuffs[0].expiresAt, BLESSING_DURATION * 6);

  // Still alive at the last sub-tick before expiry…
  layer.step(ctx({ tickIndex: BLESSING_DURATION * 6 - 1 }));
  assert.equal(layer.readout().activeBuffs.length, 1, "alive just before lapse");
  // …and gone once the tick passes its expiry.
  layer.step(ctx({ tickIndex: BLESSING_DURATION * 6 + 1 }));
  assert.equal(layer.readout().activeBuffs.length, 0, "a mortal blessing fades");
});

// ─── 7. a wonder's permanence ───────────────────────────────────────────────────────────────────────────

test("temple: WONDER_FOUNDATION raises a permanent buff that never expires", () => {
  const layer = new TempleLayer({ enabled: true });
  layer.submit(entry({
    txHash: txAt(1), kind: "WONDER_FOUNDATION", tier: 4, burnAmount: 1_000_000n * SCALE,
    params: { nationId: 1, wonder: "library" },
  }));
  layer.step(ctx({ tickIndex: 0 }));
  const ro = layer.readout();
  assert.equal(ro.wonders[1], "library", "the wonder is recorded against its nation");
  assert.equal(ro.activeBuffs.length, 1);
  assert.equal(ro.activeBuffs[0].kind, "WONDER");
  assert.equal(ro.activeBuffs[0].expiresAt, Infinity, "an eternal monument");

  // A very old tick must not reap a permanent wonder.
  layer.step(ctx({ tickIndex: 10_000_000 }));
  assert.equal(layer.readout().activeBuffs.length, 1, "a wonder never lapses");
  assert.equal(layer.readout().wonders[1], "library");
});

// ─── 8. the serialize/deserialize round trip ────────────────────────────────────────────────────────────

test("temple: serialize/deserialize is a byte-identical round trip", () => {
  const layer = new TempleLayer({ enabled: true });
  layer.submit(entry({ txHash: txAt(1), kind: "ORACLE_WHISPER", tier: 1, params: { flyId: 2 } }));
  layer.submit(entry({ txHash: txAt(2), kind: "WONDER_FOUNDATION", tier: 4, burnAmount: 1_000_000n * SCALE, params: { nationId: 1, wonder: "library" } }));
  layer.submit(entry({ txHash: txAt(3), kind: "HERO_SUMMONING", tier: 3, burnAmount: 100_000n * SCALE, params: { name: "Gilgamesh" } }));
  layer.submit(entry({ txHash: txAt(4), kind: "NATION_BLESSING", tier: 2, burnAmount: 10_000n * SCALE, params: { nationId: 0 } }));
  layer.step(ctx({ tickIndex: 10 }));
  layer.step(ctx({ tickIndex: 16 }));

  const json1 = layer.serialize();
  assert.doesNotThrow(() => JSON.parse(json1), "the blob is plain JSON (no BigInt leaks)");
  const layer2 = TempleLayer.deserialize(json1);
  assert.equal(layer2.serialize(), json1, "re-serializing the rebuild is byte-identical");

  const r1 = layer.readout();
  const r2 = layer2.readout();
  assert.equal(r2.totalBurned, r1.totalBurned, "cumulative burn survives");
  assert.equal(r2.queueLength, r1.queueLength);
  assert.equal(r2.historyCount, r1.historyCount);
  assert.deepEqual(r2.wonders, r1.wonders);
  assert.equal(r2.heroes.length, r1.heroes.length);
  assert.equal(r2.activeBuffs.length, r1.activeBuffs.length);
});

test("temple: deserialize of a corrupt blob yields a cold, empty layer", () => {
  const layer = TempleLayer.deserialize("{ this is not json");
  const ro = layer.readout();
  assert.equal(ro.queueLength, 0);
  assert.equal(ro.historyCount, 0);
  assert.equal(ro.totalBurned, "0");
  assert.deepEqual(ro.activeBuffs, []);
});

// ─── 9. invalid-kind rejection ──────────────────────────────────────────────────────────────────────────

test("temple: an invalid kind is refused by isTempleKind, submit and verifyBurn", async () => {
  assert.equal(isTempleKind("ORACLE_WHISPER"), true);
  assert.equal(isTempleKind("BOGUS_RITE"), false);
  assert.equal(isTempleKind(undefined), false);

  const layer = new TempleLayer({ enabled: true });
  const bad = layer.submit(entry({ kind: "BOGUS_RITE" as unknown as TempleKind }));
  assert.equal(bad.ok, false);
  assert.match(bad.error ?? "", /invalid kind/i);

  const verdict = await layer.verifyBurn(TX, "BOGUS_RITE" as unknown as TempleKind, {}, ADDR, burnClient(1_000n * SCALE));
  assert.equal(verdict.valid, false);
  assert.match(verdict.error ?? "", /invalid kind/i);
});

// ─── 10. the standing read-out's shape ──────────────────────────────────────────────────────────────────

test("temple: readout exposes the full standing summary and tracks the last execution", () => {
  const layer = new TempleLayer({ enabled: true });
  const cold = layer.readout();
  assert.deepEqual(Object.keys(cold).sort(), [
    "activeBuffs", "enabled", "heroes", "historyCount", "lastExecution", "queueLength", "totalBurned", "wonders",
  ]);
  assert.equal(cold.enabled, true);
  assert.equal(cold.queueLength, 0);
  assert.equal(cold.historyCount, 0);
  assert.equal(cold.totalBurned, "0");
  assert.deepEqual(cold.heroes, []);
  assert.deepEqual(cold.wonders, {});
  assert.deepEqual(cold.activeBuffs, []);
  assert.equal(cold.lastExecution, null);

  layer.submit(entry({ txHash: txAt(1), kind: "ORACLE_WHISPER", tier: 1, params: { flyId: 1 } }));
  layer.step(ctx({ tickIndex: 7 }));
  const warm = layer.readout();
  assert.equal(warm.historyCount, 1);
  assert.equal(warm.totalBurned, (1_000n * SCALE).toString());
  assert.deepEqual(warm.lastExecution, { kind: "ORACLE_WHISPER", tick: 7, address: ADDR });
});

test("temple: a disabled layer executes nothing", () => {
  const layer = new TempleLayer({ enabled: false });
  layer.submit(entry({ txHash: txAt(1), kind: "ORACLE_WHISPER", tier: 1, params: { flyId: 1 } }));
  const res = layer.step(ctx({ tickIndex: 0 }));
  assert.equal(res.executed.length, 0, "TEMPLE_ENABLED=false ⇒ the layer is inert");
  assert.equal(res.stimuliToInject.length, 0);
  assert.equal(layer.readout().enabled, false);
});
