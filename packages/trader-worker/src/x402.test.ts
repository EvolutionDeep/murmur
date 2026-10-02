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
import { encodeFunctionData, type Address, type Hex } from "viem";

import {
  ARC_USDC,
  ARC_USDC_EIP712_VERSION,
  EIP3009_TYPES,
  SCHEME_EXACT,
  X402_VERSION,
  X402_V2_VERSION,
  decodeEip3009Calldata,
  eip3009Message,
  fiatTokenV2Abi,
  makeRefundAuth,
  pseudoTxHash,
  recoverAuthorizationSigner,
  toNonce32,
  toV2PaymentRequirements,
  usdcToAtomic,
  quoteOutboundArc,
  CircleBreaker,
  NonceRing,
  OnChainFacilitator,
  type NonceRingEntry,
  type PaymentAuthorization,
  type PaymentPayload,
  type PaymentRequirements,
  type PaymentRequiredBody,
  type PinnedOutboundEndpoint,
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
    fap: "FORAGE" as const, valence: 0, heading: 0, role: "signal-seeker", bouts: [], neuromod: { dopamine: 0, octopamine: 0, learningRateGate: 0, daHz: 0, oaHz: 0 },
  }));
  const coll = {
    temperature: 0.9, regime: "HOT" as const, vitality: 0.9, size: 24, arousal: 0.7, cohesion: 0.5,
    rest: 0.1, wingbeat: 0.6, states: { AGITATE: 0, EXPLORE: 0, AGGREGATE: 0, REST: 0 },
    faps: {}, valence: 0,
    meanDopamine: 0, meanOctopamine: 0, meanDaHz: 0, meanOaHz: 0,
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

// ---------- x402 v2 discovery + Bazaar (①) ----------

test("toV2PaymentRequirements translates at the boundary: CAIP-2 network + eip3009 extra + bazaar extension", () => {
  const v1 = reqs(0.01);
  const v2 = toV2PaymentRequirements(v1, 5042);
  assert.equal(v2.scheme, SCHEME_EXACT);
  assert.equal(v2.network, "eip155:5042", "v2 speaks CAIP-2 where v1 used the short tag");
  assert.equal(v2.maxAmountRequired, v1.maxAmountRequired, "the price never moves in translation");
  assert.equal(v2.payTo, v1.payTo);
  assert.equal(v2.resource, v1.resource);
  assert.equal(v2.asset, v1.asset);
  assert.equal(v2.extra.assetTransferMethod, "eip3009");
  assert.equal(v2.extra.name, "USDC");
  assert.equal(v2.extra.version, ARC_USDC_EIP712_VERSION);
  const bazaar = v2.extensions?.bazaar as { discoverable: boolean };
  assert.equal(bazaar.discoverable, true, "the pulse resource advertises itself to Bazaar indexers");
});

// ---------- settled-nonce ring (②/⑤) ----------

test("NonceRing converges seen nonces, refreshes on re-remember, and evicts oldest past cap", () => {
  const ring = new NonceRing(3);
  assert.equal(ring.seen("0xaa"), null, "empty ring has never seen anything");
  ring.remember("0xAA", "0xtx-a", "0xfrom-a", "0xto-a", "100");
  ring.remember("0xbb", "0xtx-b", "0xfrom-b", "0xto-b", "200");
  ring.remember("0xcc", "0xtx-c", "0xfrom-c", "0xto-c", "300");
  const hit = ring.seen("0xaa");
  assert.ok(hit, "lookup is case-insensitive (nonces lower-case on the rail)");
  assert.equal(hit.txHash, "0xtx-a");
  assert.equal(hit.from, "0xfrom-a");
  assert.equal(hit.to, "0xto-a");
  assert.equal(hit.value, "100");
  ring.remember("0xaa", "0xtx-a", "0xfrom-a", "0xto-a", "100"); // refresh: a re-settled nonce moves to newest
  ring.remember("0xdd", "0xtx-d", "0xfrom-d", "0xto-d", "400"); // cap 3 exceeded ⇒ oldest (0xbb) evicted
  assert.equal(ring.size, 3);
  assert.equal(ring.seen("0xbb"), null, "the LEAST recently used nonce is the one evicted");
  assert.ok(ring.seen("0xaa"), "a refreshed nonce survives eviction");
  assert.ok(ring.seen("0xdd"));
});

// ---------- Circle breaker (②) ----------

test("CircleBreaker opens after N consecutive infra failures, recovers when the window passes", () => {
  let now = 1_000_000;
  const br = new CircleBreaker(3, 600_000, () => now);
  assert.equal(br.state, "closed");
  assert.ok(br.allow());
  br.recordFailure();
  br.recordFailure();
  br.recordSuccess();                          // a success between failures resets the streak
  br.recordFailure();
  br.recordFailure();
  assert.equal(br.state, "closed", "2+2 failures split by a success never trip the breaker");
  br.recordFailure();
  br.recordFailure();
  br.recordFailure();
  assert.equal(br.state, "open", "three consecutive failures trip it");
  assert.ok(!br.allow());
  assert.equal(br.openings, 1);
  now += 600_001;                              // window passes ⇒ half-open resolves to closed
  assert.equal(br.state, "closed");
  assert.ok(br.allow());
  br.recordSuccess();
  assert.equal(br.openings, 1, "a success never adds an opening");
});

// ---------- trustless tx decode (④) ----------

test("decodeEip3009Calldata round-trips a mined transferWithAuthorization and rejects everything else", () => {
  const from = `0x${"11".repeat(20)}` as Address;
  const to = `0x${"22".repeat(20)}` as Address;
  const nonce = `0x${"cd".repeat(32)}` as Hex;
  const data = encodeFunctionData({
    abi: fiatTokenV2Abi,
    functionName: "transferWithAuthorization",
    args: [from, to, 10_000n, 0n, 1_893_456_000n, nonce, 27, `0x${"aa".repeat(32)}`, `0x${"bb".repeat(32)}`],
  });
  const dec = decodeEip3009Calldata(data);
  assert.ok(dec, "the authorization decodes back out of the calldata");
  assert.equal(dec.from, from);
  assert.equal(dec.to, to);
  assert.equal(dec.value, "10000");
  assert.equal(dec.validAfter, "0");
  assert.equal(dec.validBefore, "1893456000");
  assert.equal(dec.nonce, nonce);
  const notAuth = encodeFunctionData({
    abi: [{ type: "function", name: "approve", stateMutability: "nonpayable", inputs: [{ type: "address" }, { type: "uint256" }], outputs: [{ type: "bool" }] }],
    functionName: "approve",
    args: [to, 1n],
  });
  assert.equal(decodeEip3009Calldata(notAuth), null, "an approve() tx is NOT an authorization");
  assert.equal(decodeEip3009Calldata("0xdeadbeef"), null, "garbage calldata decodes to null, never throws");
});

// ---------- refund auth (⑥, dark-deployed rail) ----------

test("makeRefundAuth is deterministic with an injected nonce and random (neural-free) without one", () => {
  const fixed = `0x${"ee".repeat(32)}` as Hex;
  const a = makeRefundAuth({
    from: `0x${"11".repeat(20)}` as `0x${string}`, to: `0x${"22".repeat(20)}` as `0x${string}`,
    value: 5n, nowSec: 1_700_000_000, nonce: fixed,
  });
  assert.equal(a.validAfter, 0n, "a refund is valid immediately");
  assert.equal(a.validBefore, 1_700_003_600n, "default refund lifetime is one hour");
  assert.equal(a.nonce, fixed, "an injected nonce passes through untouched (deterministic tests)");
  const r1 = makeRefundAuth({
    from: `0x${"11".repeat(20)}` as `0x${string}`, to: `0x${"22".repeat(20)}` as `0x${string}`,
    value: 5n, nowSec: 1_700_000_000,
  });
  const r2 = makeRefundAuth({
    from: `0x${"11".repeat(20)}` as `0x${string}`, to: `0x${"22".repeat(20)}` as `0x${string}`,
    value: 5n, nowSec: 1_700_000_000,
  });
  assert.match(String(r1.nonce), /^0x[0-9a-f]{64}$/, "a random refund nonce is full bytes32");
  assert.notEqual(r1.nonce, r2.nonce, "two refunds never share a nonce (and carry no receipt semantics)");
});

// ---------- C2 FIX: replay convergence requires verified signature + triple match ----------

/**
 * Minimal mock for OnChainFacilitator deps — only what settleExternal touches before the replay gate.
 * publicClient.readContract is never reached in the exploit test (sig fails first) and is a no-op stub
 * for the positive test (ring hit returns before balance read).
 */
function mockOnChainFacilitator() {
  const relayAddr = `0x${"ff".repeat(20)}` as Address;
  return new OnChainFacilitator({
    asset: ARC_USDC,
    chainId: 5042,
    publicClient: {
      readContract: async () => 999_999_999n,
      call: async () => ({ data: "0x" as Hex }),
      waitForTransactionReceipt: async () => ({ status: "success", gasUsed: 21000n, effectiveGasPrice: 1n }),
    } as any,
    wallet: {
      account: { address: relayAddr },
      writeContract: async () => `0x${"aa".repeat(32)}` as Hex,
    } as any,
    buyerAccount: () => undefined,
  });
}

test("C2 EXPLOIT: settleExternal rejects garbage signature on someone else's settled nonce (no free replay)", async () => {
  // Simulate: a legitimate payer previously settled nonce "0xbb..bb" — the ring remembers it.
  const fac = mockOnChainFacilitator();
  const victimNonce = `0x${"bb".repeat(32)}`;
  const victimFrom = `0x${"11".repeat(20)}`;
  const victimTo = `0x${"22".repeat(20)}`;
  const victimValue = "10000";
  // Pre-populate the ring (access private field for test purposes).
  (fac as any).settledNonces.remember(victimNonce, "0xvictim-tx-hash", victimFrom, victimTo, victimValue);

  // Attacker crafts a structurally-valid payload with the victim's nonce but their OWN address + garbage sig.
  const attackerFrom = `0x${"99".repeat(20)}`;
  const attackerAuth = auth({
    from: attackerFrom,
    to: victimTo,          // payTo matches requirements
    value: victimValue,    // value passes invariant
    nonce: victimNonce,    // someone else's settled nonce
  });
  const garbageSig = `0x${"de".repeat(65)}` as Hex; // well-formed hex (130 chars) but cryptographically invalid
  const attackerPayload: PaymentPayload = {
    x402Version: X402_VERSION, scheme: SCHEME_EXACT, network: "arc",
    payload: { signature: garbageSig, authorization: attackerAuth },
  };

  const res = await fac.settleExternal(reqs(), attackerPayload);
  assert.equal(res.success, false, "attacker MUST NOT get success:true from someone else's nonce");
  assert.ok(res.invalidReason?.includes("signature"), `rejection reason mentions signature: ${res.invalidReason}`);
  assert.equal(res.txHash, "0x", "no real txHash leaks to the attacker");
});

test("C2 EXPLOIT: settleExternal rejects VALID signature from a DIFFERENT payer on a settled nonce (triple mismatch)", async () => {
  // The victim settled with their key; the attacker has their OWN valid key but reuses the victim's nonce.
  const fac = mockOnChainFacilitator();
  const victimNonce = `0x${"cc".repeat(32)}`;
  const victimFrom = `0x${"11".repeat(20)}`;
  const victimTo = `0x${"22".repeat(20)}`;
  (fac as any).settledNonces.remember(victimNonce, "0xvictim-tx", victimFrom, victimTo, "10000");

  // Attacker signs a VALID authorization with their own key but the victim's nonce.
  const attackerAcct = privateKeyToAccount(("0x" + "99".repeat(32)) as Hex);
  const attackerAuth = auth({
    from: attackerAcct.address,
    to: victimTo,
    value: "10000",
    nonce: victimNonce,
  });
  const validSig = await attackerAcct.signTypedData({
    domain: DOMAIN, types: EIP3009_TYPES, primaryType: "TransferWithAuthorization",
    message: eip3009Message(attackerAuth),
  });
  const attackerPayload: PaymentPayload = {
    x402Version: X402_VERSION, scheme: SCHEME_EXACT, network: "arc",
    payload: { signature: validSig, authorization: attackerAuth },
  };

  const res = await fac.settleExternal(reqs(), attackerPayload);
  assert.equal(res.success, false, "a different payer cannot free-ride the victim's settled nonce");
  assert.ok(
    res.invalidReason?.includes("nonce already consumed") || res.invalidReason?.includes("different authorization"),
    `rejection cites nonce mismatch: ${res.invalidReason}`,
  );
});

test("C2 POSITIVE: same payer with valid signature + matching triple gets replayed:true (legitimate re-fetch)", async () => {
  const fac = mockOnChainFacilitator();
  const payerAcct = privateKeyToAccount(("0x" + "11".repeat(32)) as Hex);
  const payTo = `0x${"22".repeat(20)}`;
  const nonce = `0x${"dd".repeat(32)}`;
  const value = "10000";

  // Pre-populate ring as if this payer already settled this exact nonce.
  (fac as any).settledNonces.remember(nonce, "0xoriginal-tx-hash", payerAcct.address, payTo, value);

  // Same payer re-submits the same authorization with a valid signature.
  const payerAuth = auth({ from: payerAcct.address, to: payTo, value, nonce });
  const sig = await payerAcct.signTypedData({
    domain: DOMAIN, types: EIP3009_TYPES, primaryType: "TransferWithAuthorization",
    message: eip3009Message(payerAuth),
  });
  const replayPayload: PaymentPayload = {
    x402Version: X402_VERSION, scheme: SCHEME_EXACT, network: "arc",
    payload: { signature: sig, authorization: payerAuth },
  };

  const res = await fac.settleExternal(reqs(), replayPayload);
  assert.equal(res.success, true, "the legitimate payer gets their original result back");
  assert.equal(res.replayed, true, "flagged as a replay convergence (no gas spent)");
  assert.equal(res.txHash, "0xoriginal-tx-hash", "the original txHash is returned");
});

// ── OUTBOUND x402 CLIENT gate (quoteOutboundArc) — the security core of the swarm's ONLY money-exit path.
// A real buy signs a gasless EIP-3009 auth that moves OUR fly's USDC to an EXTERNAL payTo forever. A hostile
// seller could return a 402 whose payTo/asset/price/network differ from what we agreed; this pure gate must
// refuse BEFORE signing. These pin every refusal, and the one accepted case.
{
  const PAYTO = "0x487b28A4FbbA8Cf46eb6E1d72e6959202Bb75e90";
  const pinned: PinnedOutboundEndpoint = {
    id: "la_btc_5m",
    url: "https://api.liquidagent.ai/v1/polymarket/btc-5m",
    network: "eip155:5042",
    asset: ARC_USDC,
    payTo: PAYTO,
    maxAmountAtomic: "4000",
  };
  const arcAccept: PaymentRequirements = {
    scheme: SCHEME_EXACT, network: "eip155:5042", maxAmountRequired: "4000",
    resource: pinned.url, description: "", mimeType: "application/json",
    payTo: PAYTO, maxTimeoutSeconds: 60, asset: ARC_USDC, extra: {},
  };
  const body = (accepts: PaymentRequirements[]): PaymentRequiredBody => ({ x402Version: X402_VERSION, accepts });

  test("quoteOutboundArc accepts a pinned-exact Arc option", () => {
    const q = quoteOutboundArc(body([arcAccept]), pinned, "50000");
    assert.equal(q.ok, true, "the honest seller clears every gate");
    assert.equal(q.reqs?.payTo, PAYTO);
    assert.equal(q.reqs?.maxAmountRequired, "4000");
  });

  test("quoteOutboundArc refuses a payTo redirect (hostile 402)", () => {
    const evil = { ...arcAccept, payTo: "0x1111111111111111111111111111111111111111" };
    const q = quoteOutboundArc(body([evil]), pinned, "50000");
    assert.equal(q.ok, false);
    assert.match(q.invalidReason ?? "", /payTo mismatch/);
  });

  test("quoteOutboundArc refuses an asset swap", () => {
    const evil = { ...arcAccept, asset: "0x2222222222222222222222222222222222222222" };
    const q = quoteOutboundArc(body([evil]), pinned, "50000");
    assert.equal(q.ok, false);
    assert.match(q.invalidReason ?? "", /asset mismatch/);
  });

  test("quoteOutboundArc refuses a price above the pinned ceiling", () => {
    const over = { ...arcAccept, maxAmountRequired: "9999" };
    const q = quoteOutboundArc(body([over]), pinned, "50000");
    assert.equal(q.ok, false);
    assert.match(q.invalidReason ?? "", /exceeds pinned ceiling/);
  });

  test("quoteOutboundArc refuses a price above the per-deal cap", () => {
    // pinned ceiling is high (say the resource allows 0.05) but the facilitator per-deal cap is 0.0045:
    const widePinned = { ...pinned, maxAmountAtomic: "50000" };
    const mid = { ...arcAccept, maxAmountRequired: "4500" };
    const q = quoteOutboundArc(body([mid]), widePinned, "4000");
    assert.equal(q.ok, false);
    assert.match(q.invalidReason ?? "", /per-deal cap/);
  });

  test("quoteOutboundArc refuses when no Arc option is offered", () => {
    const baseOnly = { ...arcAccept, network: "eip155:8453" };
    const q = quoteOutboundArc(body([baseOnly]), pinned, "50000");
    assert.equal(q.ok, false);
    assert.match(q.invalidReason ?? "", /no eip155:5042 exact option/);
  });

  test("quoteOutboundArc refuses a malformed price / empty accepts (never sign garbage)", () => {
    assert.equal(quoteOutboundArc(body([]), pinned, "50000").ok, false);
    assert.equal(quoteOutboundArc(null, pinned, "50000").ok, false);
    const bad = { ...arcAccept, maxAmountRequired: "NaN" };
    const q = quoteOutboundArc(body([bad]), pinned, "50000");
    assert.equal(q.ok, false);
    assert.match(q.invalidReason ?? "", /malformed maxAmountRequired/);
  });
}

