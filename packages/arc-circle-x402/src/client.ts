// High-level Circle Facilitator client: one call to settle a signed EIP-3009 USDC payment.
//
// Composes the pure pieces in circle.ts — build the /settle body, authenticate (Bearer API key OR a keyless
// EIP-712 seller proof signed by the payTo key), POST to Circle, and normalise the reply. This is the ONLY
// part that touches the network; everything else is pure and unit-tested.

import type { Address, Hex, LocalAccount } from "viem";
import {
  CIRCLE_PROD_URL,
  CIRCLE_SETTLE_PATH,
  buildCircleSettleBody,
  signSellerProof,
  circleAuthHeaders,
  parseSettleResponse,
  type CircleSettleResult,
} from "./circle.js";
import { caip2 } from "./networks.js";

export interface CircleClientConfig {
  /** Circle API base URL. Default https://api.circle.com (one host routes every network by the body). */
  baseUrl?: string;
  /** Circle API key → Bearer auth (production). If omitted, a keyless seller proof is used instead. */
  apiKey?: string | null;
  /** Injectable fetch (proxy/agent, mocks). Defaults to the global fetch. */
  fetchImpl?: typeof fetch;
}

export interface SettlePaymentArgs {
  /** Numeric chain id of the settlement network (5042 Arc, 8453 Base, 137 Polygon, …). */
  chainId: number;
  /** USDC contract on that network. */
  asset: Address;
  /** Seller payout address (== authorization.to). For keyless auth you must hold this key. */
  payTo: Address;
  /** Buyer's compact 0x EIP-3009 signature (r||s||v, 65 bytes). */
  signature: Hex;
  /** The exact authorization fields the buyer signed (see signEip3009Authorization). */
  authorization: {
    from: Address;
    to: Address;
    value: bigint | string; // atomic USDC; == amount (exact scheme)
    validAfter: bigint | string; // unix seconds
    validBefore: bigint | string; // unix seconds
    nonce: Hex; // bytes32
  };
  /** Circle's wait window before it returns `pending`. Default 12. */
  maxTimeoutSeconds?: number;
  /** Optional paid-resource metadata (a paid data product sets a real URL). */
  resource?: { url: string; description?: string; mimeType?: string };
  /**
   * Idempotency id (16–128 chars of [A-Za-z0-9_-]). Defaults to the 64-hex authorization nonce so a retry
   * converges on the same Circle payment instead of double-charging.
   */
  idempotencyId?: string;
  /** The account controlling payTo — REQUIRED for keyless auth (ignored when apiKey is set). */
  sellerAccount?: LocalAccount;
}

/**
 * Settle a signed EIP-3009 USDC payment through Circle's hosted facilitator. Circle screens both parties,
 * submits transferWithAuthorization on-chain, and pays the gas. Returns a normalised result:
 *   · success    → txHash (Arc: final; Base/Polygon: wait for confirmations before fulfilling)
 *   · pending    → NOT final; reconcile via /status with the paymentId. Do not fulfil.
 *   · failed     → terminal (e.g. insufficient_funds, bad_signature)
 *   · http-error → request/policy rejection (401 auth, 403 registration_required = trial exhausted, 429 …)
 *
 * Throws only on a local programming error (keyless auth with no sellerAccount) or a transport failure
 * (fetch rejects); every HTTP reply Circle sends — including 4xx/5xx — is normalised into the result.
 */
export async function settleViaCircle(
  config: CircleClientConfig,
  args: SettlePaymentArgs,
): Promise<CircleSettleResult> {
  const baseUrl = config.baseUrl ?? CIRCLE_PROD_URL;
  const networkCaip2 = caip2(args.chainId);
  const value = String(args.authorization.value);
  const nonce32 = args.authorization.nonce;

  const { bodyStr } = buildCircleSettleBody({
    networkCaip2,
    asset: args.asset,
    payTo: args.payTo,
    amount: value, // exact scheme: amount == authorization.value
    maxTimeoutSeconds: args.maxTimeoutSeconds ?? 12,
    signature: args.signature,
    from: args.authorization.from,
    to: args.authorization.to,
    value,
    validAfter: String(args.authorization.validAfter),
    validBefore: String(args.authorization.validBefore),
    nonce32,
    resourceUrl: args.resource?.url,
    resourceDescription: args.resource?.description,
    resourceMime: args.resource?.mimeType,
    idempotencyId: args.idempotencyId ?? nonce32.slice(2),
  });

  // Exactly one auth mode: Bearer when an API key is set; else a keyless seller proof from the payTo key.
  let headers: Record<string, string>;
  if (config.apiKey) {
    headers = circleAuthHeaders({ apiKey: config.apiKey });
  } else {
    if (!args.sellerAccount) {
      throw new Error("keyless settle requires sellerAccount (the key controlling payTo); pass one or set apiKey");
    }
    const proof = await signSellerProof({
      account: args.sellerAccount,
      purpose: "settle",
      method: "POST",
      bodyStr,
      networkCaip2,
      payTo: args.payTo,
      chainId: args.chainId,
    });
    headers = circleAuthHeaders({ sellerProof: proof });
  }

  const doFetch = config.fetchImpl ?? fetch;
  const resp = await doFetch(`${baseUrl}${CIRCLE_SETTLE_PATH}`, {
    method: "POST",
    headers,
    body: bodyStr,
  });
  const json = await resp.json().catch(() => null);
  return parseSettleResponse(resp.status, json);
}
