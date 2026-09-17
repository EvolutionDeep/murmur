# Agent economy & x402 settlement

Every fly in murmur is an **autonomous economic agent** with its own USDC micro-wallet. Its neural drives decide
*what to buy*, *how strongly*, and *from whom*; buyer and seller then run an **x402** payment flow against each
other. **No LLM is involved** — the spiking connectome is the only decision-maker, and the economy is a strict
**one-directional read-out** of it (money never feeds back into the neurons).

Relevant code: [`economy.ts`](../packages/trader-worker/src/economy.ts) (the agent loop),
[`x402.ts`](../packages/trader-worker/src/x402.ts) (the protocol + facilitators),
[`keys.ts`](../packages/trader-worker/src/keys.ts) (HD wallet derivation, onchain only).

---

## Neural drive → economic action

| Drive / state | Economic meaning |
|---|---|
| behavioural **state** | **which good** to buy: `EXPLORE → signal`, `AGITATE → momentum`, `AGGREGATE → attestation` |
| **arousal** | **how strongly** to buy (buy probability + price tolerance scale with arousal) |
| **wingbeat** | deal-frequency spice (a buzzing fly transacts a touch more often) |
| **cohesion** | **who** to turn toward (cohesive → near neighbours; explorer → reach far) |
| **turnBias** | **which side** to reach (+ → higher ids / right half, − → lower ids / left half) |
| **rest** | dampens everything (a resting fly barely participates) |
| market **temperature** | market-wide demand (HOT → more deals at higher prices; COLD → thin & cheap) |

### The goods (machine-to-machine data)

| Good | What it is | Price multiplier |
|---|---|---|
| `signal` | a peer's live decoded drive vector (arousal/cohesion/turn) — a market-timing signal | 1.00 |
| `momentum` | a peer's read on temperature momentum — chased when the market is heating | 1.25 |
| `attestation` | a peer's neural fingerprint — a "proof-of-feel" identity attestation, bought to bond | 0.80 |

Each agent's wallet (`AgentState`) tracks `balance`, lifetime `paid`/`earned` (atomic 6-decimal USDC strings) and
`deals`/`sales` counters.

---

## The x402 flow (exact scheme)

murmur speaks x402 **version 1**, **`exact`** scheme. The reference flow is implemented faithfully at the message
level:

```
1  client GETs a resource
2  server → 402 Payment Required + PAYMENT-REQUIRED header (base64 PaymentRequirements[])
3  client picks requirements, builds a PaymentPayload (the signed authorization)
4  client re-sends with PAYMENT-SIGNATURE header (base64 PaymentPayload)
5  server POSTs { paymentPayload, paymentRequirements } to the facilitator /verify
6  facilitator → { valid }
7  server does the work, then POSTs the same to the facilitator /settle
8  facilitator settles → SettlementResponse { success, txHash }
9  server → 200 OK + PAYMENT-RESPONSE header (base64 SettlementResponse)
```

Amounts use 6-decimal **atomic USDC** string math (`usdcToAtomic` / `atomicToUsdc` / `addAtomic` / `subAtomic` /
`gteAtomic`) so there is no floating-point drift in balances.

---

## Default: simulated + keyless (zero funds at risk)

Out of the box `ECONOMY_FACILITATOR = "simulated"`. A **`SimulatedFacilitator`** keeps an internal ledger and mints
a **deterministic pseudo tx-hash** instead of touching any chain; the settled asset is the zero address
(`0x0000…0000`) to make it unmistakable that no real deployment is involved.

- Starting balance `ECONOMY_INITIAL_BALANCE` = **10 USDC** per agent (simulated).
- Base good price `ECONOMY_BASE_PRICE` = **0.002 USDC** before neural/market scaling.
- Money is **conserved** between agents, and a small protocol treasury tops an agent up to
  `ECONOMY_SOLVENCY_FLOOR` (0.5) when it runs nearly dry — so the piece runs forever with no wallet or faucet.
- `ECONOMY_MAX_DEALS` caps settlements per tick (default = population size) to bound cron CPU.

In this mode the Worker holds **no private key and signs nothing**.

---

## Opt-in: real on-chain settlement (EIP-3009 on Arc)

Real settlement is **fully implemented** but **inert** until an operator enables it. When
`ECONOMY_FACILITATOR = "onchain"` **and** the `ECONOMY_MNEMONIC` secret is present, an **`OnChainFacilitator`**
drops in **without changing a single line of economy logic**:

- **Asset**: Arc's USDC — a Circle **FiatTokenV2 precompile** at `0x3600000000000000000000000000000000000000`
  (verified on mainnet chainId 5042: `decimals()=6`, `name()="USDC"`, `version()="2"`, EIP-3009 present).
- **Signing**: the **buyer** signs an EIP-3009 `transferWithAuthorization` with its own key; the **facilitator**
  submits it on-chain and **pays the gas** (gas is USDC on Arc).
- **EIP-712 domain**: `{ name: "USDC", version: "2", chainId: 5042, verifyingContract: 0x3600…0000 }`
  (overridable via `ECONOMY_USDC_EIP712_NAME` / `_VERSION`).
- The simulated **treasury top-up is disabled** — you cannot mint real USDC, so agents spend only what they hold.

### Custody model — one seed, many agents (`keys.ts`)

Instead of 24 loose keys, the Worker holds **one BIP-39 mnemonic** (an encrypted Workers Secret) and HD-derives
every account via BIP-44:

- agent `id` → `m/44'/60'/0'/0/{id}` (accountIndex ⇄ fly id, so addresses are stable & reproducible);
- the gas-paying **facilitator** → accountIndex **2,000,000** on the same seed, **or** a dedicated
  `ECONOMY_FACILITATOR_PK` if you prefer a separately-funded hot wallet.

`listDerivedAddresses()` enumerates the addresses an operator must fund before going live.

> **EIP-3009 needs each buyer to hold its own USDC.** A single vault cannot settle on the agents' behalf, so the
> float must first be **distributed** to all 25 derived addresses (24 agents + facilitator). See
> [`scripts/fund-agents.mjs`](../packages/trader-worker/scripts/fund-agents.mjs) below.

### Safety rails (all inert in simulated mode)

| Var | Default | Effect |
|---|---|---|
| `ECONOMY_REAL_SPEND` | `true` | **Kill switch** — set `false` to halt all real settlement instantly |
| `ECONOMY_SHADOW` | `false` | `true` = sign + `eth_call`-simulate each transfer but **never broadcast** |
| `ECONOMY_DAILY_CAP` | `20` | Global real-spend ceiling per UTC day (USDC); `0` = no cap |
| `ECONOMY_PER_AGENT_DAILY_CAP` | `2` | Per-agent real-spend ceiling per UTC day (USDC); `0` = no cap |
| `ECONOMY_MAX_DEAL` | `0.05` | Facilitator hard per-deal ceiling (USDC) |
| `ECONOMY_GAS_PRICE_GWEI` | (estimate) | Pin relay gas (Arc launched ~20 gwei); omit to let viem estimate |

Balances are **re-read from chain immediately before signing**, and every rail is enforced facilitator-side.

### ⚠️ Gas economics (read before funding)

On Arc the facilitator pays roughly **65k gas × 20 gwei ≈ 0.0013 USDC per transfer**, while the default deal face
value is only **~0.0023 USDC** — gas is **57–65% of a micropayment**, and at the default cadence (~5 deals/min ≈
7,000+/day) that is **~9–10 USDC/day** of net burn. Sub-cent on-chain micropayments are gas-dominated. **Always
measure real gas in `ECONOMY_SHADOW="true"` against live chain state before funding**, and/or raise the deal face
value or slow the cadence to amortise gas.

---

## Go-live runbook (real money)

1. **Generate a fresh mnemonic** (never reuse a funded personal seed) and store it:
   `npx wrangler secret put ECONOMY_MNEMONIC` (optionally `ECONOMY_FACILITATOR_PK`).
2. **Dry-run the distribution** to see the 25 derived addresses and the plan (no transactions):
   ```bash
   cd packages/trader-worker
   MNEMONIC="…" SOURCE_KEY="0x…vault key…" node scripts/fund-agents.mjs
   ```
3. **Fund the vault**, then **send** the distribution for real (adds `--send`):
   ```bash
   MNEMONIC="…" SOURCE_KEY="0x…" AGENT_USDC=6 FACILITATOR_USDC=50 node scripts/fund-agents.mjs --send
   ```
   `fund-agents.mjs` is **dry-run by default**; `--send` is required to broadcast. It reads keys only from env and
   never prints them.
4. **Shadow mode first**: set `ECONOMY_FACILITATOR="onchain"` + `ECONOMY_SHADOW="true"` in `wrangler.toml`,
   `npm run deploy:worker`, `POST /reset`, then read `/economy` to confirm signing/domain/gas against live state
   with **no broadcasts**.
5. **Go live**: set `ECONOMY_SHADOW="false"`, redeploy. Real USDC now moves **under the caps + kill switch**.
6. **Stop instantly**: set `ECONOMY_REAL_SPEND="false"` (or `ECONOMY_FACILITATOR="simulated"`) and redeploy.

> Keys, funding and the `--send` step are **operator-only** actions. The repository and the default deployment stay
> keyless and simulated; nothing in the codebase can move real funds until an operator explicitly enables it.
