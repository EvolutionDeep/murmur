// Buyer-side EIP-3009 signing + high-level settleViaCircle client tests.
//
// The client is the only part that touches the network, so we inject a mock fetch and assert the EXACT
// request it would send: the endpoint, the single auth mode (keyless seller proof vs Bearer), the x402v2
// body (amount == authorization.value, CAIP-2 network, default idempotency id = the nonce), and that the
// keyless seller proof in the header recovers to payTo over the very bytes that were sent. We also pin the
// buyer's EIP-3009 signature recovering to the payer, and the result normalisation for every outcome.

import test from "node:test";
import assert from "node:assert/strict";
import { privateKeyToAccount } from "viem/accounts";
import { recoverTypedDataAddress, type Address, type Hex } from "viem";

import { ARC_MAINNET } from "./networks.js";
import {
  SELLER_PROOF_DOMAIN_NAME,
  SELLER_PROOF_DOMAIN_VERSION,
  SELLER_REQUEST_TYPES,
  sellerProofMessage,
} from "./circle.js";
import { signEip3009Authorization, usdcDomain, EIP3009_TYPES } from "./eip3009.js";
import { settleViaCircle, type SettlePaymentArgs } from "./client.js";

// ---------- helpers ----------

function b64urlDecode(s: string): string {
  const b64 = s.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (s.length % 4)) % 4);
  const bin = atob(b64);
  return new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0)));
}
function fromBase64Url<T = any>(s: string): T {
  return JSON.parse(b64urlDecode(s)) as T;
}

interface MockCall { url: string; init: { method: string; headers: Record<string, string>; body: string } }
function mockFetch(response: { status: number; json: unknown }): { fetchImpl: typeof fetch; calls: MockCall[] } {
  const calls: MockCall[] = [];
  const fetchImpl = (async (url: any, init: any) => {
    calls.push({ url: String(url), init });
    return { status: response.status, json: async () => response.json } as any;
  }) as typeof fetch;
  return { fetchImpl, calls };
}

const BUYER = privateKeyToAccount(("0x" + "11".repeat(32)) as Hex);
const SELLER = privateKeyToAccount(("0x" + "22".repeat(32)) as Hex);

async function signedAuth(value = 10000n) {
  return signEip3009Authorization({
    account: BUYER,
    chainId: ARC_MAINNET.chainId,
    asset: ARC_MAINNET.usdc,
    to: SELLER.address,
    value,
  });
}

// ---------- buyer-side EIP-3009 ----------

test("signEip3009Authorization signs a TransferWithAuthorization that recovers to the buyer", async () => {
  const to = ("0x" + "22".repeat(20)) as Address;
  const { signature, authorization } = await signEip3009Authorization({
    account: BUYER, chainId: 5042, asset: ARC_MAINNET.usdc, to, value: 10000n,
    validAfter: 0n, validBefore: 1893456000n, nonce: ("0x" + "ab".repeat(32)) as Hex,
  });
  assert.equal(authorization.from, BUYER.address);
  assert.equal(authorization.to, to);
  assert.equal(authorization.value, 10000n);
  assert.equal(authorization.nonce, "0x" + "ab".repeat(32));
  assert.match(signature, /^0x[0-9a-f]{130}$/, "compact 65-byte r||s||v signature");
  const recovered = await recoverTypedDataAddress({
    domain: usdcDomain(5042, ARC_MAINNET.usdc),
    types: EIP3009_TYPES,
    primaryType: "TransferWithAuthorization",
    message: {
      from: authorization.from, to: authorization.to, value: authorization.value,
      validAfter: authorization.validAfter, validBefore: authorization.validBefore, nonce: authorization.nonce,
    },
    signature,
  });
  assert.equal(recovered.toLowerCase(), BUYER.address.toLowerCase(), "EIP-3009 signature recovers to the payer");
});

test("signEip3009Authorization defaults validAfter=0, a future validBefore, and a random bytes32 nonce", async () => {
  const { authorization } = await signEip3009Authorization({
    account: BUYER, chainId: 5042, asset: ARC_MAINNET.usdc, to: BUYER.address, value: 1n,
  });
  assert.equal(authorization.validAfter, 0n, "valid immediately by default");
  assert.ok(authorization.validBefore > BigInt(Math.floor(Date.now() / 1000)), "expires in the future");
  assert.match(authorization.nonce, /^0x[0-9a-f]{64}$/, "random bytes32 nonce");
});

// ---------- high-level client ----------

test("settleViaCircle (keyless) POSTs the exact x402v2 body and a seller proof that recovers to payTo", async () => {
  const { signature, authorization } = await signedAuth();
  const { fetchImpl, calls } = mockFetch({ status: 200, json: { success: true, transaction: "0xabc" } });

  const result = await settleViaCircle(
    { fetchImpl },
    { chainId: 5042, asset: ARC_MAINNET.usdc, payTo: SELLER.address, signature, authorization, sellerAccount: SELLER },
  );
  assert.equal(result.kind, "success");
  if (result.kind === "success") assert.equal(result.txHash, "0xabc");

  assert.equal(calls.length, 1, "exactly one request");
  assert.equal(calls[0].url, "https://api.circle.com/v1/facilitator/x402/settle");
  assert.equal(calls[0].init.method, "POST");

  const headers = calls[0].init.headers;
  assert.ok(headers["Facilitator-Seller-Proof"], "keyless uses the seller-proof header");
  assert.equal(headers["Authorization"], undefined, "no Bearer when keyless");
  assert.equal(headers["Content-Type"], "application/json");

  const body = JSON.parse(calls[0].init.body);
  assert.equal(body.x402Version, 2);
  assert.equal(body.paymentRequirements.network, "eip155:5042");
  assert.equal(body.paymentRequirements.amount, "10000");
  assert.equal(body.paymentRequirements.amount, body.paymentPayload.payload.authorization.value, "amount == value");
  assert.equal(body.paymentRequirements.payTo, SELLER.address);
  assert.equal(
    body.paymentPayload.extensions["payment-identifier"].info.id,
    authorization.nonce.slice(2),
    "default idempotency id is the 64-hex nonce",
  );

  // The seller proof authenticating the SENT bytes must recover to payTo over Circle's EIP-712 domain.
  const env = fromBase64Url<{ signature: Hex; network: string; payTo: string; nonce: Hex; issuedAt: number; expiresAt: number }>(
    headers["Facilitator-Seller-Proof"],
  );
  const message = sellerProofMessage({
    purpose: "settle", method: "POST", bodyStr: calls[0].init.body, networkCaip2: env.network,
    payTo: env.payTo as Address, nonceHex: env.nonce, issuedAt: env.issuedAt, expiresAt: env.expiresAt,
  });
  const recovered = await recoverTypedDataAddress({
    domain: { name: SELLER_PROOF_DOMAIN_NAME, version: SELLER_PROOF_DOMAIN_VERSION, chainId: 5042 },
    types: SELLER_REQUEST_TYPES, primaryType: "SellerRequest", message, signature: env.signature,
  });
  assert.equal(recovered.toLowerCase(), SELLER.address.toLowerCase(), "seller proof recovers to payTo");
});

test("settleViaCircle uses Bearer auth when an API key is set (no seller proof, no sellerAccount needed)", async () => {
  const { signature, authorization } = await signedAuth();
  const { fetchImpl, calls } = mockFetch({ status: 200, json: { success: true, transaction: "0x1" } });
  await settleViaCircle(
    { apiKey: "TEST_KEY", fetchImpl },
    { chainId: 5042, asset: ARC_MAINNET.usdc, payTo: SELLER.address, signature, authorization },
  );
  const headers = calls[0].init.headers;
  assert.equal(headers["Authorization"], "Bearer TEST_KEY");
  assert.equal(headers["Facilitator-Seller-Proof"], undefined, "never both auth modes");
});

test("settleViaCircle throws when keyless with no sellerAccount (a local programming error)", async () => {
  const { signature, authorization } = await signedAuth(1n);
  const { fetchImpl } = mockFetch({ status: 200, json: {} });
  await assert.rejects(
    () =>
      settleViaCircle(
        { fetchImpl },
        { chainId: 5042, asset: ARC_MAINNET.usdc, payTo: SELLER.address, signature, authorization },
      ),
    /sellerAccount/,
  );
});

test("settleViaCircle normalises pending / failed / http-error replies", async () => {
  const { signature, authorization } = await signedAuth();
  const args: SettlePaymentArgs = {
    chainId: 5042, asset: ARC_MAINNET.usdc, payTo: SELLER.address, signature, authorization, sellerAccount: SELLER,
  };

  const pending = mockFetch({
    status: 200,
    json: { errorReason: "settlement_pending", extensions: { "settlement-status": { status: "pending", paymentId: "pay_1" } } },
  });
  const r1 = await settleViaCircle({ fetchImpl: pending.fetchImpl }, args);
  assert.equal(r1.kind, "pending");
  if (r1.kind === "pending") assert.equal(r1.paymentId, "pay_1");

  const failed = mockFetch({ status: 200, json: { success: false, errorReason: "insufficient_funds" } });
  const r2 = await settleViaCircle({ fetchImpl: failed.fetchImpl }, args);
  assert.equal(r2.kind, "failed");
  if (r2.kind === "failed") assert.equal(r2.reason, "insufficient_funds");

  const rejected = mockFetch({
    status: 403,
    json: { code: 403, message: "registration required", errors: [{ reason: "registration_required" }] },
  });
  const r3 = await settleViaCircle({ fetchImpl: rejected.fetchImpl }, args);
  assert.equal(r3.kind, "http-error");
  if (r3.kind === "http-error") assert.deepEqual(r3.reasons, ["registration_required"]);
});
