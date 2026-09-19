// Runnable end-to-end example: a BUYER signs an EIP-3009 USDC authorization, the SELLER signs a keyless
// EIP-712 proof over the /settle body, and we POST it to Circle's hosted Facilitator Service.
//
//   npx tsx examples/settle.ts            # dry run — build + sign, print the exact wire format, send nothing
//   SEND=1 npx tsx examples/settle.ts     # actually POST to Circle (uses the global fetch)
//
// The demo keys below are THROWAWAY test keys holding zero USDC, so a real send returns HTTP 200 with
// errorReason "insufficient_funds" — which still proves Circle accepted the body + both signatures and
// reached the balance check. Replace BUYER_PK / SELLER_PK and fund the buyer to move real USDC.
// NEVER commit a real private key. Behind a corporate proxy, pass a proxied `fetchImpl` to settleViaCircle
// (Node's global fetch does not honour HTTPS_PROXY).

import { privateKeyToAccount } from "viem/accounts";
import type { Hex } from "viem";
import {
  ARC_MAINNET,
  caip2,
  signEip3009Authorization,
  buildCircleSettleBody,
  signSellerProof,
  circleAuthHeaders,
  settleViaCircle,
} from "../src/index.js";

// ---- throwaway demo keys (zero balance; replace + fund to move real USDC) ----
const BUYER_PK = ("0x" + "11".repeat(32)) as Hex; // pays
const SELLER_PK = ("0x" + "22".repeat(32)) as Hex; // receives (payTo) + signs the keyless seller proof

const buyer = privateKeyToAccount(BUYER_PK);
const seller = privateKeyToAccount(SELLER_PK);

const network = ARC_MAINNET; // swap for ARC_TESTNET / BASE_MAINNET / POLYGON_MAINNET
const amount = 10_000n; // 0.01 USDC (6 decimals)

async function main() {
  // 1) Buyer signs the EIP-3009 transferWithAuthorization off-chain — no gas, no private key leaves the buyer.
  const { signature, authorization } = await signEip3009Authorization({
    account: buyer,
    chainId: network.chainId,
    asset: network.usdc,
    to: seller.address,
    value: amount,
  });

  console.log("buyer   :", buyer.address);
  console.log("seller  :", seller.address, "(payTo)");
  console.log("network :", network.caip2, `(${network.name})`);
  console.log("asset   :", network.usdc);
  console.log("amount  :", amount.toString(), "atomic USDC");
  console.log("nonce   :", authorization.nonce);

  const send = process.env.SEND === "1";

  // 2a) Dry run — show exactly what would go over the wire, without touching the network.
  if (!send) {
    const networkCaip2 = caip2(network.chainId);
    const { bodyStr } = buildCircleSettleBody({
      networkCaip2,
      asset: network.usdc,
      payTo: seller.address,
      amount: amount.toString(),
      maxTimeoutSeconds: 12,
      signature,
      from: authorization.from,
      to: authorization.to,
      value: amount.toString(),
      validAfter: String(authorization.validAfter),
      validBefore: String(authorization.validBefore),
      nonce32: authorization.nonce,
      idempotencyId: authorization.nonce.slice(2),
    });
    const proof = await signSellerProof({
      account: seller,
      purpose: "settle",
      method: "POST",
      bodyStr,
      networkCaip2,
      payTo: seller.address,
      chainId: network.chainId,
    });
    console.log("\n-- dry run (set SEND=1 to actually POST) --");
    console.log("POST https://api.circle.com/v1/facilitator/x402/settle");
    console.log("headers:", JSON.stringify(circleAuthHeaders({ sellerProof: proof }), null, 2));
    console.log("body   :", bodyStr);
    return;
  }

  // 2b) Real send — one call builds the body, signs the keyless seller proof, POSTs, and normalises the reply.
  const result = await settleViaCircle(
    { apiKey: process.env.CIRCLE_API_KEY ?? null }, // no key → keyless seller proof from the payTo key
    {
      chainId: network.chainId,
      asset: network.usdc,
      payTo: seller.address,
      signature,
      authorization,
      sellerAccount: seller,
    },
  );

  console.log("\n-- Circle result --");
  console.log(JSON.stringify(result, null, 2));
  if (result.kind === "success") console.log("settled:", result.txHash);
  else if (result.kind === "pending") console.log("pending — reconcile via /status:", result.paymentId);
  else if (result.kind === "failed") console.log("terminal failure:", result.reason, "(expected with a zero-balance demo buyer)");
  else console.log("http rejection:", result.status, result.message, result.reasons.join(","));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
