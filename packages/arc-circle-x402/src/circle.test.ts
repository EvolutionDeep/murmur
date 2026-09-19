// Core adapter + network registry tests for Circle's hosted x402 Facilitator Service.
//
// circle.ts / networks.ts are PURE (no network), so every rule Circle enforces is pinned here: the
// x402Version=2 body (accepted mirrors paymentRequirements, amount == authorization.value), the
// byte-identical bodyStr whose keccak256 becomes the seller proof's bodyHash, the keyless EIP-712 seller
// proof (which MUST recover to the payTo key Circle validates against), the exactly-one auth mode, the
// CAIP-2 / USDC / finality network registry, and the response normalisation (a 200 carries an OUTCOME —
// success/pending/failed — while 4xx/5xx are rejections; pending is NOT success).

import test from "node:test";
import assert from "node:assert/strict";
import { privateKeyToAccount } from "viem/accounts";
import { keccak256, toBytes, recoverTypedDataAddress, type Address, type Hex } from "viem";

import {
  ARC_MAINNET,
  BASE_MAINNET,
  SUPPORTED_NETWORKS,
  caip2,
  networkByChainId,
} from "./networks.js";
import {
  CIRCLE_PROD_URL,
  CIRCLE_SETTLE_PATH,
  CIRCLE_X402_VERSION,
  SELLER_PROOF_DOMAIN_NAME,
  SELLER_PROOF_DOMAIN_VERSION,
  SELLER_REQUEST_TYPES,
  toBase64Url,
  buildCircleSettleBody,
  sellerProofMessage,
  signSellerProof,
  circleAuthHeaders,
  parseSettleResponse,
  type BuildCircleSettleArgs,
} from "./circle.js";

// ---------- helpers ----------

/** Reverse of toBase64Url: base64url → UTF-8 string (Node has atob + TextDecoder globally). */
function b64urlDecode(s: string): string {
  const b64 = s.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (s.length % 4)) % 4);
  const bin = atob(b64);
  const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}
function fromBase64Url<T = any>(s: string): T {
  return JSON.parse(b64urlDecode(s)) as T;
}

const PAYTO_ACCT = privateKeyToAccount(("0x" + "22".repeat(32)) as Hex);
const PAYTO = PAYTO_ACCT.address;

function settleArgs(over: Partial<BuildCircleSettleArgs> = {}): BuildCircleSettleArgs {
  return {
    networkCaip2: "eip155:5042",
    asset: ARC_MAINNET.usdc,
    payTo: PAYTO,
    amount: "10000",
    maxTimeoutSeconds: 12,
    signature: ("0x" + "cc".repeat(65)) as Hex,
    from: "0x" + "11".repeat(20),
    to: PAYTO,
    value: "10000",
    validAfter: "0",
    validBefore: "1893456000",
    nonce32: "0x" + "ab".repeat(32),
    ...over,
  };
}

// ---------- constants + network registry ----------

test("Circle endpoints + protocol version match the documented contract", () => {
  assert.equal(CIRCLE_PROD_URL, "https://api.circle.com");
  assert.equal(CIRCLE_SETTLE_PATH, "/v1/facilitator/x402/settle");
  assert.equal(CIRCLE_X402_VERSION, 2, "Circle requires x402Version 2");
});

test("caip2 renders the EVM chain id Circle routes by (Arc mainnet + testnet)", () => {
  assert.equal(caip2(5042), "eip155:5042", "Arc mainnet");
  assert.equal(caip2(5042002), "eip155:5042002", "Arc testnet");
});

test("network registry maps chain ids to CAIP-2 + canonical USDC + finality", () => {
  assert.equal(caip2(8453), "eip155:8453", "Base");
  assert.equal(caip2(137), "eip155:137", "Polygon PoS");
  assert.equal(ARC_MAINNET.usdc, "0x3600000000000000000000000000000000000000", "Arc USDC is the precompile");
  assert.equal(ARC_MAINNET.instantFinality, true, "Arc settlements are final on arrival");
  assert.equal(BASE_MAINNET.instantFinality, false, "Base is probabilistic — wait for confirmations");
  assert.equal(networkByChainId(5042), ARC_MAINNET, "lookup by numeric chain id");
  assert.equal(networkByChainId(1), undefined, "a chain Circle does not settle on → undefined");
  assert.deepEqual(
    Object.keys(SUPPORTED_NETWORKS).sort(),
    ["eip155:137", "eip155:5042", "eip155:5042002", "eip155:8453"],
    "Arc mainnet/testnet + Base + Polygon",
  );
});

// ---------- toBase64Url ----------

test("toBase64Url is URL-safe (no +, / or padding) and round-trips UTF-8", () => {
  assert.equal(toBase64Url("a"), "YQ", "known vector: base64('a')='YQ==' minus padding");
  for (const s of ["", "hello world", '{"x":1,"y":[2,3]}', "µnicode ✓ 中文 emoji 🎉"]) {
    const enc = toBase64Url(s);
    assert.ok(!/[+/=]/.test(enc), `no URL-unsafe chars in ${JSON.stringify(enc)}`);
    assert.equal(b64urlDecode(enc), s, `round-trips ${JSON.stringify(s)}`);
  }
});

// ---------- buildCircleSettleBody ----------

test("builds an x402 v2 body where accepted mirrors paymentRequirements and amount == value", () => {
  const { body } = buildCircleSettleBody(settleArgs());
  assert.equal(body.x402Version, 2);
  assert.equal(body.paymentPayload.x402Version, 2);
  // Circle's exact scheme: the accepted requirements ARE the top-level ones (same object), amount == value.
  assert.equal(body.paymentPayload.accepted, body.paymentRequirements, "accepted is the same object as paymentRequirements");
  assert.equal(body.paymentRequirements.scheme, "exact");
  assert.equal(body.paymentRequirements.amount, "10000");
  assert.equal(body.paymentRequirements.amount, body.paymentPayload.payload.authorization.value, "amount == authorization.value");
  assert.equal(body.paymentRequirements.network, "eip155:5042");
  assert.equal(body.paymentRequirements.asset, ARC_MAINNET.usdc);
  assert.equal(body.paymentRequirements.payTo, PAYTO);
  assert.equal(body.paymentRequirements.maxTimeoutSeconds, 12);
  assert.deepEqual(body.paymentRequirements.extra, { name: "USDC", version: "2", assetTransferMethod: "eip3009" });
  // The EIP-3009 authorization Circle submits to the token contract.
  const a = body.paymentPayload.payload.authorization;
  assert.equal(a.from, "0x" + "11".repeat(20));
  assert.equal(a.to, PAYTO);
  assert.equal(a.value, "10000");
  assert.equal(a.validAfter, "0");
  assert.equal(a.validBefore, "1893456000");
  assert.equal(a.nonce, "0x" + "ab".repeat(32));
  assert.equal(body.paymentPayload.payload.signature, "0x" + "cc".repeat(65));
});

test("bodyStr is byte-identical to JSON.stringify(body) — the bodyHash Circle recomputes must match", () => {
  const { body, bodyStr } = buildCircleSettleBody(settleArgs());
  assert.equal(bodyStr, JSON.stringify(body), "the sent bytes equal the hashed bytes");
  const h = keccak256(toBytes(bodyStr));
  assert.match(h, /^0x[0-9a-f]{64}$/, "bodyHash is a 32-byte keccak");
});

test("includes the paid resource only when a URL is supplied (internal deals omit it)", () => {
  const withRes = buildCircleSettleBody(
    settleArgs({ resourceUrl: "https://example.com/paid-data", resourceDescription: "a paid resource", resourceMime: "application/json" }),
  ).body;
  assert.deepEqual(withRes.paymentPayload.resource, {
    url: "https://example.com/paid-data", description: "a paid resource", mimeType: "application/json",
  });
  const noRes = buildCircleSettleBody(settleArgs()).body;
  assert.equal(noRes.paymentPayload.resource, undefined, "no resource key when none is supplied");
});

test("adds the payment-identifier idempotency extension only when an id is given", () => {
  const withId = buildCircleSettleBody(settleArgs({ idempotencyId: "ab".repeat(32) })).body;
  assert.deepEqual(withId.paymentPayload.extensions?.["payment-identifier"].info, { required: true, id: "ab".repeat(32) });
  const noId = buildCircleSettleBody(settleArgs()).body;
  assert.equal(noId.paymentPayload.extensions, undefined, "no extensions when no idempotency id");
});

// ---------- seller proof (keyless trial auth) ----------

test("sellerProofMessage uppercases the method and hashes the exact body bytes", () => {
  const bodyStr = '{"x":1}';
  const msg = sellerProofMessage({
    purpose: "settle", method: "post", bodyStr, networkCaip2: "eip155:5042",
    payTo: PAYTO, nonceHex: ("0x" + "ab".repeat(32)) as Hex, issuedAt: 1_800_000_000, expiresAt: 1_800_000_300,
  });
  assert.equal(msg.method, "POST", "method is uppercased");
  assert.equal(msg.bodyHash, keccak256(toBytes(bodyStr)), "bodyHash == keccak256(rawBody)");
  assert.equal(msg.network, "eip155:5042");
  assert.equal(msg.payTo, PAYTO);
  assert.equal(typeof msg.issuedAt, "bigint");
  assert.equal(msg.issuedAt, 1_800_000_000n);
  assert.equal(msg.expiresAt, 1_800_000_300n);
});

test("signSellerProof produces an envelope whose EIP-712 signature recovers to the payTo key", async () => {
  const { bodyStr } = buildCircleSettleBody(settleArgs());
  const nonceHex = ("0x" + "ab".repeat(32)) as Hex;
  const issuedAt = 1_800_000_000;
  const proof = await signSellerProof({
    account: PAYTO_ACCT, purpose: "settle", method: "POST", bodyStr,
    networkCaip2: "eip155:5042", payTo: PAYTO, chainId: 5042, nonceHex, issuedAt,
  });
  const env = fromBase64Url<{
    version: number; signature: Hex; network: string; payTo: string; nonce: Hex; issuedAt: number; expiresAt: number;
  }>(proof);
  assert.equal(env.version, 1);
  assert.equal(env.network, "eip155:5042");
  assert.equal(env.payTo.toLowerCase(), PAYTO.toLowerCase());
  assert.equal(env.nonce, nonceHex);
  assert.equal(env.issuedAt, issuedAt);
  assert.equal(env.expiresAt, issuedAt + 300, "default TTL is 300s (Circle requires ≤ issuedAt + 300)");
  // Rebuild exactly what Circle rebuilds and recover — it must be the payTo key.
  const message = sellerProofMessage({
    purpose: "settle", method: "POST", bodyStr, networkCaip2: env.network,
    payTo: env.payTo as Address, nonceHex: env.nonce, issuedAt: env.issuedAt, expiresAt: env.expiresAt,
  });
  const recovered = await recoverTypedDataAddress({
    domain: { name: SELLER_PROOF_DOMAIN_NAME, version: SELLER_PROOF_DOMAIN_VERSION, chainId: 5042 },
    types: SELLER_REQUEST_TYPES, primaryType: "SellerRequest", message, signature: env.signature,
  });
  assert.equal(recovered.toLowerCase(), PAYTO.toLowerCase(), "seller proof recovers to the payTo address");
});

test("signSellerProof honours a custom TTL and a default random nonce (still recoverable)", async () => {
  const { bodyStr } = buildCircleSettleBody(settleArgs());
  const issuedAt = 1_800_000_000;
  const proof = await signSellerProof({
    account: PAYTO_ACCT, purpose: "settle", method: "POST", bodyStr,
    networkCaip2: "eip155:5042", payTo: PAYTO, chainId: 5042, issuedAt, ttlSec: 60,
  });
  const env = fromBase64Url<{ signature: Hex; network: string; payTo: string; nonce: Hex; issuedAt: number; expiresAt: number }>(proof);
  assert.equal(env.expiresAt, issuedAt + 60, "custom TTL honoured");
  assert.match(env.nonce, /^0x[0-9a-f]{64}$/, "default nonce is 32 random bytes");
  const message = sellerProofMessage({
    purpose: "settle", method: "POST", bodyStr, networkCaip2: env.network,
    payTo: env.payTo as Address, nonceHex: env.nonce, issuedAt: env.issuedAt, expiresAt: env.expiresAt,
  });
  const recovered = await recoverTypedDataAddress({
    domain: { name: SELLER_PROOF_DOMAIN_NAME, version: SELLER_PROOF_DOMAIN_VERSION, chainId: 5042 },
    types: SELLER_REQUEST_TYPES, primaryType: "SellerRequest", message, signature: env.signature,
  });
  assert.equal(recovered.toLowerCase(), PAYTO.toLowerCase());
});

// ---------- auth headers (exactly one mode) ----------

test("circleAuthHeaders sends EXACTLY ONE auth mode (mixing Bearer + seller-proof is a 400)", () => {
  const key = circleAuthHeaders({ apiKey: "TEST_KEY" });
  assert.equal(key["Content-Type"], "application/json");
  assert.equal(key["Authorization"], "Bearer TEST_KEY");
  assert.equal(key["Facilitator-Seller-Proof"], undefined);

  const proof = circleAuthHeaders({ sellerProof: "PROOF_B64" });
  assert.equal(proof["Facilitator-Seller-Proof"], "PROOF_B64");
  assert.equal(proof["Authorization"], undefined, "no Bearer when keyless");

  const both = circleAuthHeaders({ apiKey: "TEST_KEY", sellerProof: "PROOF_B64" });
  assert.equal(both["Authorization"], "Bearer TEST_KEY", "API key wins");
  assert.equal(both["Facilitator-Seller-Proof"], undefined, "never both headers on one request");

  const neither = circleAuthHeaders({});
  assert.deepEqual(neither, { "Content-Type": "application/json" }, "no auth header at all");
});

// ---------- response normalisation ----------

test("parseSettleResponse: 200 success carries the transaction hash", () => {
  const r = parseSettleResponse(200, { success: true, transaction: "0xdead", payer: "0x1", network: "eip155:5042", amount: "10000" });
  assert.equal(r.kind, "success");
  if (r.kind === "success") {
    assert.equal(r.txHash, "0xdead");
    assert.equal(r.payer, "0x1");
    assert.equal(r.amount, "10000");
  }
});

test("parseSettleResponse: 200 success without a hash degrades to 0x (never undefined)", () => {
  const r = parseSettleResponse(200, { success: true });
  assert.equal(r.kind, "success");
  if (r.kind === "success") assert.equal(r.txHash, "0x");
});

test("parseSettleResponse: settlement_pending is PENDING, not success (carries the paymentId)", () => {
  const byReason = parseSettleResponse(200, {
    errorReason: "settlement_pending",
    extensions: { "settlement-status": { status: "pending", paymentId: "pay_123", statusUrl: "https://api.circle.com/x" } },
  });
  assert.equal(byReason.kind, "pending");
  if (byReason.kind === "pending") {
    assert.equal(byReason.paymentId, "pay_123");
    assert.equal(byReason.statusUrl, "https://api.circle.com/x");
  }
  const byStatus = parseSettleResponse(200, { extensions: { "settlement-status": { status: "pending" } } });
  assert.equal(byStatus.kind, "pending", "an extension status of pending is also pending");
});

test("parseSettleResponse: a terminal 200 failure surfaces its errorReason", () => {
  const r = parseSettleResponse(200, { success: false, errorReason: "insufficient_funds" });
  assert.equal(r.kind, "failed");
  if (r.kind === "failed") assert.equal(r.reason, "insufficient_funds");
  const unknown = parseSettleResponse(200, { success: false });
  assert.equal(unknown.kind, "failed");
  if (unknown.kind === "failed") assert.equal(unknown.reason, "unknown");
});

test("parseSettleResponse: 4xx/5xx are rejections carrying code + per-error reasons", () => {
  const r = parseSettleResponse(403, { code: 403, message: "registration required", errors: [{ reason: "registration_required" }] });
  assert.equal(r.kind, "http-error");
  if (r.kind === "http-error") {
    assert.equal(r.status, 403);
    assert.equal(r.code, 403);
    assert.deepEqual(r.reasons, ["registration_required"], "trial exhausted / below minimum");
  }
});

test("parseSettleResponse: a non-200 with an unparseable body still yields an http-error", () => {
  const r = parseSettleResponse(500, null);
  assert.equal(r.kind, "http-error");
  if (r.kind === "http-error") {
    assert.equal(r.status, 500);
    assert.equal(r.message, "http 500");
    assert.deepEqual(r.reasons, []);
  }
});
