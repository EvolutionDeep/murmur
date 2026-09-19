# arc-circle-x402

A minimal, dependency-light client for **Circle's hosted x402 Facilitator Service** on **Arc** (and Base / Polygon). Settle EIP-3009 USDC payments through Circle's relayer — it screens both parties, submits the transfer on-chain, and **pays the settlement gas** — authenticating with either a Circle API key or a **keyless EIP-712 seller proof** signed by your `payTo` key.

> **No relayer keys. No separate gas wallet.** That is Circle's promise for the Facilitator Service they shipped on Arc; this package is the thin client that consumes it.

Only runtime dependency: [`viem`](https://viem.sh) `^2`. Every non-network function is pure and unit-tested (24 tests, no network).

---

## Why this exists

x402 lets a buyer pay a seller in USDC by signing an **EIP-3009 `transferWithAuthorization`** off-chain and handing it to the seller behind an HTTP `402 Payment Required`. Someone still has to *submit* that transfer on-chain and *pay the gas*. On a fresh chain like Arc, that meant self-hosting a facilitator: a dedicated gas wallet broadcasting every transfer, with gas eating 30–65% of each sub-cent micropayment.

Circle now hosts exactly that role. The buyer still signs the **same** EIP-3009 authorization; only the broadcast hop moves to Circle's relayer. This package wraps Circle's `POST /v1/facilitator/x402/settle` contract so you do not have to reverse-engineer the wire format, the keyless auth, or the outcome semantics.

It is battle-tested in production: [murmur](https://www.muros.live) settles its paid-signal product **Arc Pulse** through Circle on **Arc mainnet** (keyless), alongside an autonomous economy of 24 agents and 17,000+ real USDC settlements.

---

## Install

```bash
npm install arc-circle-x402 viem
```

Or use it straight from source inside the murmur monorepo (it is a npm workspace):

```bash
npm test -w arc-circle-x402      # 24 pure unit tests
npm run typecheck                # type-check the whole monorepo
```

---

## Quick start

```ts
import { privateKeyToAccount } from "viem/accounts";
import { settleViaCircle, signEip3009Authorization, ARC_MAINNET } from "arc-circle-x402";

const buyer  = privateKeyToAccount("0x…"); // the payer
const seller = privateKeyToAccount("0x…"); // the payTo (you, the seller)

// 1) Buyer signs an EIP-3009 USDC authorization — off-chain, no gas, the key never leaves the buyer.
const { signature, authorization } = await signEip3009Authorization({
  account: buyer,
  chainId: ARC_MAINNET.chainId,
  asset:    ARC_MAINNET.usdc,
  to:       seller.address,
  value:    10_000n, // 0.01 USDC (6 decimals)
});

// 2) Settle through Circle. Keyless: the payTo key signs a seller proof, Circle pays the gas.
const result = await settleViaCircle(
  { /* apiKey: process.env.CIRCLE_API_KEY  ← set this for production */ },
  {
    chainId: ARC_MAINNET.chainId,
    asset:    ARC_MAINNET.usdc,
    payTo:    seller.address,
    signature,
    authorization,
    sellerAccount: seller, // required for keyless auth (the key controlling payTo)
  },
);

switch (result.kind) {
  case "success":    console.log("settled", result.txHash); break; // Arc: final
  case "pending":    console.log("reconcile via /status", result.paymentId); break; // NOT final — do not fulfil
  case "failed":     console.log("terminal failure", result.reason); break;         // e.g. insufficient_funds
  case "http-error": console.log("rejected", result.status, result.message, result.reasons); break;
}
```

A complete, runnable version lives in [`examples/settle.ts`](./examples/settle.ts):

```bash
npx tsx examples/settle.ts          # dry run — prints the exact /settle body + seller-proof header, sends nothing
SEND=1 npx tsx examples/settle.ts   # actually POST to Circle (throwaway keys → insufficient_funds, proving the flow)
```

---

## Two auth modes (exactly one per request)

Circle accepts **exactly one** of these; sending both is a `400`.

| Mode | Header | When | Needs |
|------|--------|------|-------|
| **Keyless trial** | `Facilitator-Seller-Proof: <base64url EIP-712 proof>` | Prototyping, low volume, no signup | The private key controlling `payTo` (`sellerAccount`) |
| **API key** | `Authorization: Bearer <key>` | Production, higher limits | A Circle Console API key (`apiKey`) |

The keyless **seller proof** is an EIP-712 `SellerRequest` struct signed by the `payTo` key over `{purpose, method, bodyHash, network, payTo, nonce, issuedAt, expiresAt}`, where `bodyHash = keccak256(rawRequestBody)`. It proves *you* control the payout address without registering an account. `settleViaCircle` builds and signs it for you when `apiKey` is absent.

> Keyless trial is rate-limited **per `payTo`**. When it is exhausted (or the amount is below the minimum) Circle returns `403 registration_required` — switch to an API key for production.

---

## Networks

| Network | `chainId` | CAIP-2 | USDC | Finality |
|---------|-----------|--------|------|----------|
| **Arc mainnet** | `5042` | `eip155:5042` | `0x3600000000000000000000000000000000000000` (precompile) | **instant** |
| Arc testnet | `5042002` | `eip155:5042002` | `0x3600…0000` (confirm against Circle's list) | instant |
| Base | `8453` | `eip155:8453` | `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913` | probabilistic |
| Polygon PoS | `137` | `eip155:137` | `0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359` | probabilistic |

Exported as `ARC_MAINNET`, `ARC_TESTNET`, `BASE_MAINNET`, `POLYGON_MAINNET`, the `SUPPORTED_NETWORKS` map, and helpers `caip2(chainId)` / `networkByChainId(chainId)`. Always cross-check addresses against Circle's live network list before production.

> **Arc settles with instant finality** — a `success` is final, no reorg handling. On Base/Polygon, wait for confirmations before fulfilling.

---

## The /settle contract (hard facts)

These are the rules Circle enforces, all handled by this package:

- **Endpoint** — `POST {baseUrl}/v1/facilitator/x402/settle` (prod `https://api.circle.com`; one host routes every network by the body).
- **Version** — the body's `x402Version` **must be `2`**.
- **Network** — CAIP-2 (`eip155:<chainId>`). The EIP-3009 signature is over the *numeric* chainId, so the network string never invalidates a buyer signature.
- **Exact scheme** — `paymentRequirements.amount` **must equal** `authorization.value`.
- **Byte-identical body** — the JSON you send is the JSON whose `keccak256` becomes the seller proof's `bodyHash`. `buildCircleSettleBody` returns both the object and its canonical string to guarantee they match.
- **Outcome, not status** — `/settle` returns **HTTP 200 for every settlement outcome** (success / pending / terminal failure). Only 4xx/5xx are request or policy rejections.

---

## API

### Buyer side — `eip3009.ts`
- `signEip3009Authorization(args)` → `{ signature, authorization }` — sign a `TransferWithAuthorization` with the payer key.
- `usdcDomain(chainId, verifyingContract, version?)`, `EIP3009_TYPES`.

### Seller side / wire — `circle.ts`
- `buildCircleSettleBody(args)` → `{ body, bodyStr }` — the exact `/settle` body + its canonical string.
- `signSellerProof(args)` → base64url `Facilitator-Seller-Proof` (keyless auth).
- `sellerProofMessage(args)`, `circleAuthHeaders({ apiKey?, sellerProof? })`.
- `parseSettleResponse(status, json)` → `CircleSettleResult`.
- `toBase64Url(str)`; constants `CIRCLE_PROD_URL`, `CIRCLE_SETTLE_PATH`, `CIRCLE_STATUS_PATH`, `CIRCLE_X402_VERSION`, `SELLER_PROOF_DOMAIN_NAME`, `SELLER_PROOF_DOMAIN_VERSION`, `SELLER_REQUEST_TYPES`.

### High level — `client.ts`
- `settleViaCircle(config, args)` → `Promise<CircleSettleResult>` — build + authenticate + POST + normalise in one call. `config`: `{ baseUrl?, apiKey?, fetchImpl? }`.

---

## Handling the result

`CircleSettleResult` is a discriminated union — **never fulfil on anything but `success`**:

| `kind` | Meaning | Action |
|--------|---------|--------|
| `success` | Circle submitted the transfer; `txHash` present | Fulfil. Arc: final. Base/Polygon: wait for confirmations |
| `pending` | Circle is still working (`settlement_pending`) | **Do not fulfil.** Reconcile via `/status` with `paymentId` |
| `failed` | Terminal (`insufficient_funds`, bad signature, …) | Reject; `reason` says why |
| `http-error` | Request/policy rejection (401, 403, 409, 429, 5xx) | `403 registration_required` = trial exhausted → use an API key |

`settleViaCircle` throws **only** on a local programming error (keyless with no `sellerAccount`) or a transport failure (fetch rejects); every HTTP reply is normalised into the result.

---

## Idempotency

`buildCircleSettleBody` accepts an `idempotencyId` (16–128 chars of `[A-Za-z0-9_-]`), surfaced as Circle's `payment-identifier` extension. `settleViaCircle` defaults it to the **64-hex authorization nonce**, so retrying the *same* authorization converges on the *same* Circle payment instead of double-charging. Only omit it if you deliberately want Circle's internal surrogate (retry-unsafe).

---

## Security notes

- **Never commit a private key.** The example uses throwaway keys (`0x1111…`, `0x2222…`) with zero balance.
- The buyer's EIP-3009 signature authorises exactly one transfer of `value` to `to`, expiring at `validBefore` — it is not a blanket allowance.
- Keyless mode requires the `payTo` private key at settle time (to sign the seller proof). If you cannot hold it server-side, use an API key instead.
- Behind a corporate proxy, inject a proxied `fetchImpl` — **Node's global `fetch` does not honour `HTTPS_PROXY`**.
- USDC amounts are atomic strings (6 decimals): `0.01 USDC = "10000"`.

---

## How it fits x402

```
buyer ──GET /paid-resource──────────────▶ seller
buyer ◀─402 Payment Required (requirements)─ seller
buyer signs EIP-3009 transferWithAuthorization (off-chain)
buyer ──GET + X-PAYMENT header──────────▶ seller
                      seller ──POST /settle (this package)──▶ Circle
                      Circle: screens both parties, submits the transfer, pays gas
                      seller ◀─outcome (success/pending/failed)─ Circle
buyer ◀─200 + resource────────────────── seller
```

This package is the `seller → Circle → seller` leg. The buyer's signature and the seller's 402 challenge are standard x402; Circle replaces the self-hosted relayer that used to sit in the middle.

---

## License

MIT — see [LICENSE](./LICENSE). Built for the [Arc](https://arc.network) ecosystem; contributions welcome.
