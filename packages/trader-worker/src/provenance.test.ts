// Neural-provenance tests — the cryptographic "the neurons decided this, not a human/LLM" chain.
//
// Two layers are pinned here:
//   1. The pure hashing primitives (canonical ordering, sha256 stability, calldata nonce extraction).
//   2. The end-to-end commitment: in onchain mode, flush() must set the EIP-3009 nonce to exactly
//      sha256(netReceipt), the receipt must bundle a decisionHash per folded trade that recomputes from
//      the frozen neural drives, and successive receipts must chain (prevChain == previous receiptHash).
// A stub onchain facilitator records the nonce it was asked to sign, so we can assert the value that
// would be mined on-chain equals the published receipt hash — without touching a real chain.

import test from "node:test";
import assert from "node:assert/strict";

import {
  AgentEconomy,
  type EconomyConfig,
  type EconomyDeps,
} from "./economy.js";
import type { Facilitator, PaymentPayload, PaymentRequirements, VerifyResponse, SettleResponse } from "./x402.js";
import type { FlyReading, CollectiveState } from "./population.js";
import {
  canonical,
  sha256Hex,
  decisionHash,
  netReceiptHash,
  nonceFromCalldata,
  nonceFromReceiptHash,
  neuralEvidence,
  recomputeDecisionHash,
} from "./provenance.js";

// ============================== pure primitives ==============================

test("canonical() is insensitive to object key insertion order", () => {
  assert.equal(canonical({ b: 1, a: 2, nested: { z: 3, y: 4 } }), canonical({ a: 2, b: 1, nested: { y: 4, z: 3 } }));
  // …but array order IS meaningful and must be preserved.
  assert.notEqual(canonical([1, 2]), canonical([2, 1]));
});

test("sha256Hex() is deterministic and 64 lowercase hex chars", async () => {
  const a = await sha256Hex({ v: 1, x: [1, 2, 3] });
  const b = await sha256Hex({ x: [1, 2, 3], v: 1 });
  assert.match(a, /^[0-9a-f]{64}$/);
  assert.equal(a, b);
  assert.notEqual(a, await sha256Hex({ v: 1, x: [1, 2, 4] }));
});

test("nonceFromCalldata() pulls the 6th EIP-3009 word (the bytes32 nonce)", () => {
  const nonce = "ab".repeat(32);
  const selector = "deadbeef";
  const words = ["11".repeat(32), "22".repeat(32), "33".repeat(32), "44".repeat(32), "55".repeat(32), nonce, "66".repeat(32), "77".repeat(32), "88".repeat(32)];
  const input = "0x" + selector + words.join("");
  assert.equal(nonceFromCalldata(input), nonce);
  // Too-short / malformed calldata yields null rather than a wrong value.
  assert.equal(nonceFromCalldata("0xdead"), null);
});

test("neuralEvidence() rounds drives so floats survive a JSON round-trip into the hash", () => {
  const r = reading(3, "EXPLORE", { arousal: 0.123456789 });
  const e = neuralEvidence(r);
  assert.equal(e.arousal, 0.123457);
  assert.equal(e.id, 3);
});

// ============================== on-chain nonce commitment ==============================

/** A stub onchain facilitator that records the nonce it signs and returns a mined-looking receipt. */
class StubOnchainFacilitator implements Facilitator {
  readonly mode = "onchain" as const;
  readonly asset = "0x3600000000000000000000000000000000000000";
  signedNonces: string[] = [];
  private seq = 0;
  async verify(_p: PaymentPayload, _r: PaymentRequirements): Promise<VerifyResponse> {
    return { valid: true };
  }
  async settle(p: PaymentPayload, r: PaymentRequirements): Promise<SettleResponse> {
    this.signedNonces.push(p.payload.authorization.nonce);
    this.seq++;
    return { success: true, network: r.network, txHash: "0x" + String(this.seq).padStart(64, "0"), simulated: false };
  }
}

function cfg(over: Partial<EconomyConfig> = {}): EconomyConfig {
  return {
    enabled: true,
    network: "arc",
    initialBalanceUsdc: 6,
    basePriceUsdc: 0.002,
    solvencyFloorUsdc: 0.5,
    maxDealsPerTick: 24,
    facilitatorMode: "onchain",
    seedBase: 42,
    realSpendEnabled: true,
    dailyCapUsdc: 0,
    perAgentDailyCapUsdc: 0,
    maxDealUsdc: 1,
    netMinBroadcastUsdc: 0,   // broadcast every nonzero net immediately (no dust waiting)
    netFlushTicks: 0,
    ...over,
  };
}

function reading(id: number, state: FlyReading["state"], over: Partial<FlyReading> = {}): FlyReading {
  return {
    id, state,
    arousal: 0.9, turnBias: id % 2 ? 0.4 : -0.4, cohesion: 0.5,
    wingbeat: 0.8, rest: 0.05, temperament: (id * 7919) % 1000 / 1000,
    fingerprint: `fp${id}`, ...over,
  };
}

function collective(temperature = 0.9): CollectiveState {
  return {
    temperature, regime: "HOT", vitality: temperature, size: 24,
    arousal: 0.7, cohesion: 0.5, rest: 0.1, wingbeat: 0.6,
    states: { AGITATE: 24, EXPLORE: 0, AGGREGATE: 0, REST: 0 },
  };
}

const population = (state: FlyReading["state"], n = 24) => Array.from({ length: n }, (_, i) => reading(i, state));

/** Drive step+flush until at least one real (valid) net settlement is produced. */
async function mineOneProof(econ: AgentEconomy, fac: StubOnchainFacilitator) {
  const readings = population("AGITATE");
  for (let tick = 1; tick <= 8; tick++) {
    await econ.step(readings, collective(), tick);
    const flushed = await econ.flush(tick);
    const hit = flushed.find((s) => s.valid && s.proofHash);
    if (hit) return { hit, flushed, tick };
  }
  return null;
}

test("flush() sets the EIP-3009 nonce to sha256(netReceipt) and publishes a matching proof", async () => {
  const fac = new StubOnchainFacilitator();
  const deps: EconomyDeps = { facilitator: fac };
  const econ = new AgentEconomy(cfg(), undefined, deps);

  const mined = await mineOneProof(econ, fac);
  assert.ok(mined, "expected at least one net settlement to flush");
  const { hit } = mined;

  // The nonce the buyer signed (=> what would be mined) for THIS proof is among the signed nonces.
  // (A flush can broadcast several pair-nets, so compare membership, not "last".)
  assert.ok(fac.signedNonces.length >= 1);
  assert.ok(
    fac.signedNonces.includes(nonceFromReceiptHash(hit.proofHash!)),
    "the mined settlement's nonce was signed by the buyer",
  );

  // The published proof recomputes to its own hash and matches the settlement's proofHash + chain head.
  const snap = econ.proofsSnapshot();
  const proof = econ.proofForTx(hit.txHash);
  assert.ok(proof, "proofForTx finds the mined settlement");
  assert.equal(proof!.receiptHash, hit.proofHash);
  // chainHead is the NEWEST broadcast; a flush may mine several pair-nets, so hit need not be the head.
  assert.ok(snap.proofs.some((p) => p.receiptHash === hit.proofHash), "hit's proof is in the log");
  assert.equal(snap.chainHead, snap.proofs[0].receiptHash);
  assert.equal(await netReceiptHash(proof!.receipt), proof!.receiptHash);

  // The receipt bundles >=1 constituent, each carrying a 64-hex decisionHash over frozen neural drives.
  assert.ok(proof!.receipt.constituents.length >= 1);
  for (const c of proof!.receipt.constituents) assert.match(c.decisionHash, /^[0-9a-f]{64}$/);
});

test("a constituent's decisionHash recomputes from the frozen neural drives of both sides", async () => {
  const fac = new StubOnchainFacilitator();
  const econ = new AgentEconomy(cfg(), undefined, { facilitator: fac });
  const readings = population("AGITATE");
  const byId = new Map(readings.map((r) => [r.id, r]));

  const mined = await mineOneProof(econ, fac);
  assert.ok(mined);
  const proof = econ.proofsSnapshot().proofs[0];
  const c = proof.receipt.constituents[0];

  // Self-contained: recompute from the evidence carried INSIDE the published receipt.
  assert.equal(await recomputeDecisionHash(c), c.decisionHash);
  // …and it equals hashing the live neural readings of both sides directly.
  const buyer = byId.get(c.fromId)!;
  const seller = byId.get(c.toId)!;
  assert.equal(c.decisionHash, await decisionHash(buyer, seller, c.good, c.amount, c.tick));
  // The published evidence matches the live drives (rounded), and tampering changes the digest.
  assert.equal(c.buyer.arousal, neuralEvidence(buyer).arousal);
  const tampered = { ...c, buyer: { ...c.buyer, arousal: c.buyer.arousal + 0.01 } };
  assert.notEqual(await recomputeDecisionHash(tampered), c.decisionHash);
});

test("successive receipts chain: each prevChain equals the previous receiptHash", async () => {
  const fac = new StubOnchainFacilitator();
  const econ = new AgentEconomy(cfg(), undefined, { facilitator: fac });
  const readings = population("AGITATE");

  // Accumulate several broadcasts across ticks (a flush may broadcast multiple pair-nets per tick).
  for (let tick = 1; tick <= 12; tick++) {
    await econ.step(readings, collective(), tick);
    await econ.flush(tick);
    if (econ.proofsSnapshot().count >= 3) break;
  }
  const proofs = econ.proofsSnapshot().proofs;   // newest first
  assert.ok(proofs.length >= 2, "expected >=2 broadcasts to chain");

  // Consecutive chaining: each receipt's prevChain is exactly the next-older receipt's hash.
  for (let i = 0; i + 1 < proofs.length; i++) {
    assert.equal(proofs[i].receipt.prevChain, proofs[i + 1].receiptHash, `proof[${i}] chains to proof[${i + 1}]`);
  }
  // The oldest retained receipt in a fresh economy starts the chain.
  assert.equal(proofs[proofs.length - 1].receipt.prevChain, "");
  // The chain head is the newest receipt.
  assert.equal(econ.proofsSnapshot().chainHead, proofs[0].receiptHash);
});

test("serialize/applySerialized round-trips the proof log + chain head", async () => {
  const fac = new StubOnchainFacilitator();
  const econ = new AgentEconomy(cfg(), undefined, { facilitator: fac });
  const mined = await mineOneProof(econ, fac);
  assert.ok(mined);
  const blob = econ.serialize();

  const restored = new AgentEconomy(cfg(), blob, { facilitator: fac });
  const a = econ.proofsSnapshot();
  const b = restored.proofsSnapshot();
  assert.equal(b.chainHead, a.chainHead);
  assert.equal(b.count, a.count);
  assert.equal(b.proofs[0].receiptHash, a.proofs[0].receiptHash);
});
