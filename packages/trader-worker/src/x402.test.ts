// x402 external-payment tests — the trust anchor behind the Arc Pulse paid data product.
//
// A visitor buys a signal read by signing an EIP-3009 `transferWithAuthorization` with their OWN key in
// the browser; the murmur Worker relays it on-chain, paying gas, WITHOUT ever holding that key. That is
// only safe because the facilitator first RECOVERS the signer and requires it to equal the claimed payer
// (recoverAuthorizationSigner), so a forged / tampered / garbage payload is rejected for free — no gas is
// ever spent on a transfer the payer didn't actually sign. These tests pin that round-trip and the
// keyless simulated fallback + leaderboard read-out the frontend renders.

import test from "node:test";
import assert from "node:assert/strict";
import { privateKeyToAccount } from "viem/accounts";
import type { Hex } from "viem";

import {
  ARC_USDC,
  EIP3009_TYPES,
  SCHEME_EXACT,
  X402_VERSION,
  eip3009Message,
  pseudoTxHash,
  recoverAuthorizationSigner,
  usdcToAtomic,
  type PaymentAuthorization,
  type PaymentPayload,
  type PaymentRequirements,
} from "./x402.js";
import { AgentEconomy, type EconomyConfig } from "./economy.js";

/** The EIP-712 domain the Arc USDC precompile signs/recovers against (name/version read off-chain). */
const DOMAIN = { name: "USDC", version: "2", chainId: 5042, verifyingContract: ARC_USDC } as const;

function auth(over: Partial<PaymentAuthorization> = {}): PaymentAuthorization {
  return {
    scheme: SCHEME_EXACT,
    version: X402_VERSION,
    from: "0x" + "11".repeat(20),
    to: "0x" + "22".repeat(20),
    value: "10000",
    maxDeadline: 1893456000,
    nonce: "0x" + "ab".repeat(8),
    asset: ARC_USDC,
    extra: {},
    ...over,
  };
}

test("recoverAuthorizationSigner round-trips a genuine browser-signed EIP-3009 authorization", async () => {
  const acct = privateKeyToAccount(("0x" + "11".repeat(32)) as Hex);
  const a = auth({ from: acct.address });
  // Sign EXACTLY the message the facilitator will re-derive + broadcast (eip3009Message is shared).
  const signature = await acct.signTypedData({
    domain: DOMAIN,
    types: EIP3009_TYPES,
    primaryType: "TransferWithAuthorization",
    message: eip3009Message(a),
  });
  const recovered = await recoverAuthorizationSigner({ domain: DOMAIN, auth: a, signature });
  assert.equal(recovered?.toLowerCase(), acct.address.toLowerCase(), "signer recovers to the claimed payer");
});

test("recoverAuthorizationSigner rejects a tampered authorization (value changed after signing)", async () => {
  const acct = privateKeyToAccount(("0x" + "11".repeat(32)) as Hex);
  const signed = auth({ from: acct.address });
  const signature = await acct.signTypedData({
    domain: DOMAIN, types: EIP3009_TYPES, primaryType: "TransferWithAuthorization",
    message: eip3009Message(signed),
  });
  // Attacker inflates the value AFTER the payer signed — the recovered signer must no longer match.
  const tampered = { ...signed, value: "999999999" };
  const recovered = await recoverAuthorizationSigner({ domain: DOMAIN, auth: tampered, signature });
  assert.notEqual(recovered?.toLowerCase(), acct.address.toLowerCase(), "a tampered amount does not recover to the payer");
});

test("recoverAuthorizationSigner returns null on a garbage signature (never throws)", async () => {
  const recovered = await recoverAuthorizationSigner({
    domain: DOMAIN, auth: auth(), signature: ("0x" + "00".repeat(65)) as Hex,
  });
  assert.equal(recovered, null, "an unusable signature degrades to null, not an exception");
});

// ---------- keyless simulated fallback (local dev / simulated mode) ----------

function reqs(priceUsdc = 0.01): PaymentRequirements {
  return {
    scheme: SCHEME_EXACT,
    network: "arc",
    maxAmountRequired: usdcToAtomic(priceUsdc),
    resource: "https://api.muros.live/signal/pulse",
    description: "arc pulse",
    mimeType: "application/json",
    payTo: "0x" + "22".repeat(20),
    maxTimeoutSeconds: 300,
    asset: ARC_USDC,
    extra: {},
  };
}

function payload(a: PaymentAuthorization, signature = pseudoTxHash(a.from, a.to, a.value, a.nonce)): PaymentPayload {
  return { x402Version: X402_VERSION, scheme: SCHEME_EXACT, network: "arc", payload: { signature, authorization: a } };
}

function simCfg(over: Partial<EconomyConfig> = {}): EconomyConfig {
  return {
    enabled: true, network: "arc", initialBalanceUsdc: 6, basePriceUsdc: 0.002,
    solvencyFloorUsdc: 0.5, maxDealsPerTick: 24, facilitatorMode: "simulated",
    seedBase: 42, realSpendEnabled: false, dailyCapUsdc: 0, perAgentDailyCapUsdc: 0,
    maxDealUsdc: 0, netMinBroadcastUsdc: 0, netFlushTicks: 0,
    populationSize: 24, hatchSeedUsdc: 0.002, ...over,
  };
}

test("simulated settleExternal succeeds for a well-formed payload and mints a deterministic txHash", async () => {
  const econ = new AgentEconomy(simCfg());
  const r = reqs();
  const a = auth({ to: r.payTo, value: r.maxAmountRequired });
  const res = await econ.settleExternal(r, payload(a));
  assert.equal(res.success, true, "a valid simulated payment settles");
  assert.equal(res.simulated, true, "labelled simulated — no real funds move");
  assert.equal(res.txHash, pseudoTxHash(a.from, a.to, a.value, a.nonce), "deterministic pseudo-hash");
});

test("simulated settleExternal refuses a payment that breaks an invariant (payTo mismatch)", async () => {
  const econ = new AgentEconomy(simCfg());
  const r = reqs();
  const a = auth({ to: "0x" + "99".repeat(20), value: r.maxAmountRequired });   // pays someone else
  const res = await econ.settleExternal(r, payload(a));
  assert.equal(res.success, false, "a mismatched payee is rejected");
  assert.equal(res.txHash, "0x", "no hash is minted on failure");
});

test("simulated relayAddress is null (no gas wallet) while facilitatorMode reports 'simulated'", async () => {
  const econ = new AgentEconomy(simCfg());
  assert.equal(econ.facilitatorMode, "simulated");
  assert.equal(econ.relayAddress(), null, "no relay wallet exists in keyless mode");
});

// ---------- trustless PnL leaderboard ----------

test("leaderboard ranks agents by realized USDC flow (earned − paid), descending", async () => {
  const econ = new AgentEconomy(simCfg());
  const readings = Array.from({ length: 24 }, (_, i) => ({
    id: i, state: "AGITATE" as const, arousal: 0.9, turnBias: i % 2 ? 0.4 : -0.4, cohesion: 0.5,
    wingbeat: 0.8, rest: 0.05, temperament: ((i * 7919) % 1000) / 1000, fingerprint: `fp${i}`,
    fap: "FORAGE" as const, valence: 0, heading: 0, role: "signal-seeker", bouts: [],
  }));
  const coll = {
    temperature: 0.9, regime: "HOT" as const, vitality: 0.9, size: 24, arousal: 0.7, cohesion: 0.5,
    rest: 0.1, wingbeat: 0.6, states: { AGITATE: 0, EXPLORE: 0, AGGREGATE: 0, REST: 0 },
    faps: {}, valence: 0,
  };
  for (let tick = 0; tick < 12; tick++) await econ.step(readings, coll, tick);

  const rows = econ.leaderboard();
  assert.equal(rows.length, 24, "one row per agent");
  for (let i = 1; i < rows.length; i++) {
    assert.ok(rows[i - 1].netUsdc >= rows[i].netUsdc, "rows are sorted by net USDC, descending");
  }
  for (const row of rows) {
    assert.match(row.address, /^0x[0-9a-f]{40}$/, "each row carries its real on-chain wallet address");
    const net = row.earnedUsdc - row.paidUsdc;
    assert.ok(Math.abs(net - row.netUsdc) < 1e-9, `net == earned − paid for agent ${row.id}`);
  }
});
