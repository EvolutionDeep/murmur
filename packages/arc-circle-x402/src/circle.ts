// Circle Facilitator Service — the OFFICIAL hosted x402 facilitator (developers.circle.com/facilitator-service).
//
// WHY THIS EXISTS. x402 lets a buyer pay a seller in USDC by signing an EIP-3009 `transferWithAuthorization`
// off-chain; someone still has to submit that transfer on-chain and pay the gas. Circle hosts exactly that
// role: the buyer signs the SAME EIP-3009 authorization, but Circle's relayer screens both parties, submits
// the transfer, and pays the settlement gas — "no relayer keys, no separate gas wallet". This module is the
// thin, PURE translation layer between standard x402 wire shapes and Circle's
// `POST /v1/facilitator/x402/settle` contract, so it is fully unit-testable with no network. The network
// call itself lives in client.ts (settleViaCircle).
//
// HARD CONTRACT FACTS (verified against Circle docs + OpenAPI, 2026-09):
//   · Endpoint  : POST {baseUrl}/v1/facilitator/x402/settle   (prod baseUrl https://api.circle.com)
//   · Version   : the body's x402Version MUST be 2 (enum [2]).
//   · Network   : CAIP-2, e.g. "eip155:5042" (Arc mainnet) / "eip155:5042002" (Arc testnet) / "eip155:8453"
//                 (Base) / "eip155:137" (Polygon). The EIP-3009 signature is over the numeric chainId, so
//                 translating the network STRING never invalidates a buyer signature.
//   · Exact     : paymentRequirements.amount MUST equal the authorization.value (scheme "exact").
//   · Auth      : EXACTLY ONE of  (a) Authorization: Bearer <Circle API key>  [production]  or
//                 (b) Facilitator-Seller-Proof: <base64url EIP-712 seller proof>  [keyless trial].
//                 Mixing both is a 400. The seller proof is signed by the key controlling `payTo`.
//   · Outcome   : /settle ALWAYS returns HTTP 200 for a settlement outcome — success (transaction hash),
//                 pending (errorReason "settlement_pending" + a paymentId to reconcile via /status), or a
//                 terminal failure (errorReason). 4xx/5xx are request/policy rejections with {code,message,errors}.
//   · Finality  : Arc settlements are final (no reorg handling needed); Base/Polygon are not.

import { keccak256, toBytes, toHex, type Address, type Hex, type LocalAccount } from "viem";

/** Production base URL. Circle's /settle routes by the body's CAIP-2 network, so one host serves all networks. */
export const CIRCLE_PROD_URL = "https://api.circle.com";
export const CIRCLE_SETTLE_PATH = "/v1/facilitator/x402/settle";
export const CIRCLE_STATUS_PATH = "/v1/facilitator/x402/status"; // + "/{paymentId}"

/** x402 protocol version Circle Facilitator Service requires (the body's x402Version is the enum [2]). */
export const CIRCLE_X402_VERSION = 2 as const;

/** EIP-712 domain that anchors a seller proof to Circle Facilitator Service (chainId set per network). */
export const SELLER_PROOF_DOMAIN_NAME = "Circle Facilitator Seller Request";
export const SELLER_PROOF_DOMAIN_VERSION = "1";

/** The `SellerRequest` struct Circle reconstructs and recovers against `payTo`. Field order is load-bearing. */
export const SELLER_REQUEST_TYPES = {
  SellerRequest: [
    { name: "purpose", type: "string" },
    { name: "method", type: "string" },
    { name: "bodyHash", type: "bytes32" },
    { name: "network", type: "string" },
    { name: "payTo", type: "address" },
    { name: "nonce", type: "bytes32" },
    { name: "issuedAt", type: "uint64" },
    { name: "expiresAt", type: "uint64" },
  ],
} as const;

/** A seller proof's purpose must match the route being called. */
export type SellerProofPurpose = "verify" | "settle" | "status";

/**
 * base64url (RFC 4648 §5) of a UTF-8 string — the encoding of the Facilitator-Seller-Proof envelope.
 * Edge/Worker runtimes have no Node `Buffer`, so encode via TextEncoder→btoa (available as a global on
 * Node ≥ 16, Cloudflare Workers, Deno and browsers) then swap the two URL-unsafe chars and drop padding.
 */
export function toBase64Url(str: string): string {
  const bytes = new TextEncoder().encode(str);
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

// ============================== /settle request body ==============================

/** The EIP-3009 authorization Circle submits to the USDC contract (all strings, validAfter/validBefore unix sec). */
export interface CircleAuthorization {
  from: string;
  to: string;
  value: string;
  validAfter: string;
  validBefore: string;
  nonce: string; // bytes32, 0x-prefixed, 64 hex — MUST be exactly what the buyer signed
}

/** Circle's `exact`-scheme payment requirements (note: `amount`, where many x402 clients say `maxAmountRequired`). */
export interface CirclePaymentRequirements {
  scheme: "exact";
  network: string; // CAIP-2
  amount: string; // atomic USDC; MUST equal authorization.value
  asset: string; // USDC contract (0x3600…0000 on Arc)
  payTo: string; // seller payout address
  maxTimeoutSeconds: number; // Circle's wait window before it returns pending
  extra: { name: string; version: string; assetTransferMethod: string };
}

export interface CircleResourceInfo {
  url: string;
  description: string;
  mimeType: string;
}

export interface CircleSettleBody {
  x402Version: 2;
  paymentPayload: {
    x402Version: 2;
    resource?: CircleResourceInfo;
    accepted: CirclePaymentRequirements;
    payload: { signature: string; authorization: CircleAuthorization };
    extensions?: { "payment-identifier": { info: { required: boolean; id: string } } };
  };
  paymentRequirements: CirclePaymentRequirements;
}

export interface BuildCircleSettleArgs {
  networkCaip2: string; // eip155:5042 | eip155:5042002 | eip155:8453 | eip155:137
  asset: string; // USDC contract
  payTo: string; // == authorization.to
  amount: string; // atomic USDC; == value (exact scheme)
  maxTimeoutSeconds: number;
  signature: string; // buyer's compact 0x EIP-3009 signature (r||s||v)
  from: string;
  to: string;
  value: string;
  validAfter: string; // "0"
  validBefore: string; // unix sec, string
  nonce32: string; // bytes32 the buyer signed
  /** Optional paid-resource metadata (a paid data product sets a real URL; internal/agent deals may omit). */
  resourceUrl?: string;
  resourceDescription?: string;
  resourceMime?: string;
  /**
   * Optional seller-scoped idempotency id (16–128 chars of [A-Za-z0-9_-]). Passing the 64-hex authorization
   * nonce is a good default: a retry of the SAME authorization then converges on the SAME Circle payment
   * instead of double-charging. Omit only if you intend Circle's internal surrogate (retry-unsafe).
   */
  idempotencyId?: string;
}

/**
 * Build the exact `/settle` request body AND its canonical JSON string. The string is what you MUST both
 * (a) keccak256 into the seller proof's bodyHash and (b) send as the raw HTTP body — Circle recomputes the
 * hash over the received bytes, so the two must be byte-identical. Returns both to guarantee that.
 */
export function buildCircleSettleBody(a: BuildCircleSettleArgs): { body: CircleSettleBody; bodyStr: string } {
  const reqs: CirclePaymentRequirements = {
    scheme: "exact",
    network: a.networkCaip2,
    amount: a.amount,
    asset: a.asset,
    payTo: a.payTo,
    maxTimeoutSeconds: a.maxTimeoutSeconds,
    extra: { name: "USDC", version: "2", assetTransferMethod: "eip3009" },
  };
  const body: CircleSettleBody = {
    x402Version: CIRCLE_X402_VERSION,
    paymentPayload: {
      x402Version: CIRCLE_X402_VERSION,
      ...(a.resourceUrl
        ? {
            resource: {
              url: a.resourceUrl,
              description: a.resourceDescription ?? "",
              mimeType: a.resourceMime ?? "application/json",
            },
          }
        : {}),
      accepted: reqs,
      payload: {
        signature: a.signature,
        authorization: {
          from: a.from,
          to: a.to,
          value: a.value,
          validAfter: a.validAfter,
          validBefore: a.validBefore,
          nonce: a.nonce32,
        },
      },
      ...(a.idempotencyId
        ? { extensions: { "payment-identifier": { info: { required: true, id: a.idempotencyId } } } }
        : {}),
    },
    paymentRequirements: reqs,
  };
  return { body, bodyStr: JSON.stringify(body) };
}

// ============================== seller proof (keyless trial auth) ==============================

export interface SignSellerProofArgs {
  /** The account controlling `payTo` (an EOA key, or a deployed ERC-1271 account Circle validates on-chain). */
  account: LocalAccount;
  purpose: SellerProofPurpose;
  /** Uppercase HTTP method of the call being proven ("POST" for /settle). */
  method: string;
  /** The EXACT raw request body string (keccak256'd into bodyHash). GET/status hash the empty body. */
  bodyStr: string;
  networkCaip2: string; // MUST equal paymentRequirements.network
  payTo: Address; // MUST equal paymentRequirements.payTo
  chainId: number; // numeric EIP-155 id of the network (5042 / 5042002 / 8453 / 137) — the proof domain's chainId
  /** Injectable for deterministic tests; defaults to 32 random bytes. */
  nonceHex?: Hex;
  /** Injectable for tests; defaults to now (unix seconds). May be at most 30s ahead of Circle's clock. */
  issuedAt?: number;
  /** Proof lifetime; Circle requires expiresAt ≤ issuedAt + 300. Default 300. */
  ttlSec?: number;
}

/** The typed-data message a seller proof signs (exposed for tests / verification). */
export function sellerProofMessage(a: {
  purpose: SellerProofPurpose;
  method: string;
  bodyStr: string;
  networkCaip2: string;
  payTo: Address;
  nonceHex: Hex;
  issuedAt: number;
  expiresAt: number;
}) {
  return {
    purpose: a.purpose,
    method: a.method.toUpperCase(),
    bodyHash: keccak256(toBytes(a.bodyStr)) as Hex,
    network: a.networkCaip2,
    payTo: a.payTo,
    nonce: a.nonceHex,
    issuedAt: BigInt(a.issuedAt),
    expiresAt: BigInt(a.expiresAt),
  };
}

/**
 * Construct the `Facilitator-Seller-Proof` header value: sign the SellerRequest with the payTo key, wrap it
 * in the base64url envelope Circle reconstructs. Used for the KEYLESS trial; when a Circle API key is
 * configured you send Bearer auth instead and never build this (mixing both is a 400).
 */
export async function signSellerProof(a: SignSellerProofArgs): Promise<string> {
  const nonceHex = a.nonceHex ?? (toHex(crypto.getRandomValues(new Uint8Array(32))) as Hex);
  const issuedAt = a.issuedAt ?? Math.floor(Date.now() / 1000);
  const expiresAt = issuedAt + (a.ttlSec ?? 300);
  const message = sellerProofMessage({
    purpose: a.purpose,
    method: a.method,
    bodyStr: a.bodyStr,
    networkCaip2: a.networkCaip2,
    payTo: a.payTo,
    nonceHex,
    issuedAt,
    expiresAt,
  });
  const signature = await a.account.signTypedData({
    domain: { name: SELLER_PROOF_DOMAIN_NAME, version: SELLER_PROOF_DOMAIN_VERSION, chainId: a.chainId },
    types: SELLER_REQUEST_TYPES,
    primaryType: "SellerRequest",
    message,
  });
  const envelope = {
    version: 1,
    signature,
    network: a.networkCaip2,
    payTo: a.payTo,
    nonce: nonceHex,
    issuedAt,
    expiresAt,
  };
  return toBase64Url(JSON.stringify(envelope));
}

/** Exactly one auth mode: Bearer API key (production) OR the keyless seller proof. Mixing is a 400. */
export function circleAuthHeaders(a: { apiKey?: string | null; sellerProof?: string | null }): Record<string, string> {
  const h: Record<string, string> = { "Content-Type": "application/json" };
  if (a.apiKey) h["Authorization"] = `Bearer ${a.apiKey}`;
  else if (a.sellerProof) h["Facilitator-Seller-Proof"] = a.sellerProof;
  return h;
}

// ============================== /settle response parsing ==============================

export type CircleSettleResult =
  | { kind: "success"; txHash: string; payer?: string; network?: string; amount?: string }
  | { kind: "pending"; paymentId?: string; statusUrl?: string }
  | { kind: "failed"; reason: string }
  | { kind: "http-error"; status: number; code?: number; message: string; reasons: string[] };

/**
 * Normalise a /settle reply. HTTP 200 carries a settlement OUTCOME (success / pending / terminal failure);
 * 4xx/5xx are request or policy rejections (401 auth, 403 registration_required = trial exhausted or below
 * the amount minimum, 409 idempotency conflict, 429 rate limit). Pending is NOT failure — do not fulfil on
 * it; reconcile via /status with the paymentId.
 */
export function parseSettleResponse(status: number, json: unknown): CircleSettleResult {
  if (status !== 200 || json == null || typeof json !== "object") {
    const e = (json ?? {}) as { code?: number; message?: string; errors?: { reason?: string }[] };
    return {
      kind: "http-error",
      status,
      code: e.code,
      message: e.message ?? `http ${status}`,
      reasons: (e.errors ?? []).map((x) => x?.reason).filter((r): r is string => !!r),
    };
  }
  const r = json as {
    success?: boolean;
    transaction?: string;
    payer?: string;
    network?: string;
    amount?: string;
    errorReason?: string;
    extensions?: Record<string, { status?: string; paymentId?: string; statusUrl?: string } | undefined>;
  };
  if (r.success === true) {
    return { kind: "success", txHash: r.transaction || "0x", payer: r.payer, network: r.network, amount: r.amount };
  }
  const ss = r.extensions?.["settlement-status"];
  if (r.errorReason === "settlement_pending" || ss?.status === "pending") {
    return { kind: "pending", paymentId: ss?.paymentId, statusUrl: ss?.statusUrl };
  }
  return { kind: "failed", reason: r.errorReason ?? "unknown" };
}
