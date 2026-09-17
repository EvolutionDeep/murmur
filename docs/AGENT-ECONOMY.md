# Agent economy & x402 settlement

Every fly in murmur is an **autonomous economic agent** with its own USDC micro-wallet. Its neural drives decide
*what to buy*, *how strongly*, and *from whom*; buyer and seller then run an **x402** payment flow against each
other. **This is live**: the production deployment settles **real USDC on Arc mainnet** via EIP-3009, and every
settlement carries a real transaction hash you can verify on the Arc explorer. **No LLM is involved** — the spiking
connectome is the only decision-maker, and the economy is a strict **one-directional read-out** of it (money never
feeds back into the neurons — an invariant `economy.test.ts` enforces).

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

## Production is LIVE on-chain; simulated is the local-dev fallback

The **committed production config runs `ECONOMY_FACILITATOR = "onchain"` with `ECONOMY_SHADOW = "false"`** — real
USDC moves on Arc mainnet (see the next section). A fresh checkout with **no `ECONOMY_MNEMONIC` secret** instead
falls back to the keyless **`SimulatedFacilitator`**, which is what you get during local development:

- It keeps an internal ledger and mints a **deterministic pseudo tx-hash** instead of touching any chain; the
  settled asset is the zero address (`0x0000…0000`) to make it unmistakable that no real deployment is involved.
- Starting balance `ECONOMY_INITIAL_BALANCE` = **6 USDC** per agent (a display mirror).
- Base good price `ECONOMY_BASE_PRICE` = **0.002 USDC** before neural/market scaling.
- Money is **conserved** between agents, and a small protocol treasury tops an agent up to
  `ECONOMY_SOLVENCY_FLOOR` (0.5) when it runs nearly dry — so the piece runs forever with no wallet or faucet.
- `ECONOMY_MAX_DEALS` caps settlements per cron (spread across the sub-ticks) to bound CPU + real spend.

In this fallback the Worker holds **no private key and signs nothing**. It exists so anyone can run and study the
piece at zero risk — it is **not** what is deployed.

---

## Production: real on-chain settlement (EIP-3009 on Arc) — LIVE

This is the deployed mode. With `ECONOMY_FACILITATOR = "onchain"` **and** the `ECONOMY_MNEMONIC` secret present, an
**`OnChainFacilitator`** settles real value **without changing a single line of economy logic** versus the fallback:

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

### Safety rails (LIVE in production; inert only in the keyless fallback)

| Var | Default | Effect |
|---|---|---|
| `ECONOMY_REAL_SPEND` | `true` | **Kill switch** — set `false` to halt all real settlement instantly |
| `ECONOMY_SHADOW` | `false` | `true` = sign + `eth_call`-simulate each transfer but **never broadcast** |
| `ECONOMY_DAILY_CAP` | `100` | Global real-spend ceiling per UTC day (USDC); `0` = no cap |
| `ECONOMY_PER_AGENT_DAILY_CAP` | `10` | Per-agent real-spend ceiling per UTC day (USDC); `0` = no cap |
| `ECONOMY_MAX_DEAL` | `0.05` | Facilitator hard per-deal ceiling (USDC); a larger net splits into chunks |
| `ECONOMY_NET_MIN_BROADCAST` | `0.004` | Netting: minimum net USDC per agent-pair before it is broadcast; dust carries forward |
| `ECONOMY_NET_FLUSH_TICKS` | `30` | Netting: force-flush any nonzero pending net at least every N sub-ticks |
| `ECONOMY_GAS_PRICE_GWEI` | (estimate) | Pin relay gas (Arc launched ~20 gwei); omit to let viem estimate |

Balances are **re-read from chain immediately before signing**, and every rail is enforced facilitator-side.

### Settlement netting (gas amortisation)

Sub-cent micropayments are gas-dominated, so on-chain trades are **not** broadcast one-per-trade. Each unordered
agent-pair accumulates a single **signed net** in the Durable Object (`PendingNet`): a trade adds to it and
reciprocal trades cancel inside the sum, so a pair that traded both ways may owe nothing at all. At most once per
cron, `flush()` broadcasts only the nets whose `|net|` cleared `ECONOMY_NET_MIN_BROADCAST` (dust below it carries
forward) or that have aged past `ECONOMY_NET_FLUSH_TICKS` sub-ticks; a net above `ECONOMY_MAX_DEAL` splits into
chunks, each with a unique EIP-3009 nonce. The internal ledger, volume and caps move **only on a mined receipt**,
so a failed flush never invents money. Netting is on-chain only — the simulated fallback settles each trade
directly — and the frontend flags a netted settlement (`resource: "net:…"`) so the amortisation is visible.

### Gas economics (read before funding)

On Arc the facilitator pays roughly **65k gas × 20 gwei ≈ 0.0013 USDC per broadcast transfer**. Settling one tx
per sub-cent micropayment would let gas dominate face value — which is exactly what **netting** removes: folding
each pair's trades into one net and broadcasting far less often amortises gas across many payments. The balance is
set by `ECONOMY_NET_MIN_BROADCAST` (a higher floor batches more value per tx) and `ECONOMY_NET_FLUSH_TICKS` (how
long a net may sit before it must flush). **Always measure real gas in `ECONOMY_SHADOW="true"` against live chain
state before funding**, then tune those two knobs so gas stays a small fraction of settled value.

---

## Go-live runbook (real money)

> **Status: already live.** The production Worker has completed every step below — `ECONOMY_FACILITATOR="onchain"`,
> `ECONOMY_SHADOW="false"`, wallets funded, real USDC settling on Arc mainnet. This runbook is kept so the deploy
> is reproducible and so an operator can re-fund, re-prove in shadow mode, or stand up their own instance.

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

> Keys, funding and the `--send` step are **operator-only** actions and are never committed. The repository ships no
> secret; the **deployed** Worker does hold one and moves real funds, bounded by the kill switch + caps above. To
> run keyless, omit `ECONOMY_MNEMONIC` (or set `ECONOMY_FACILITATOR="simulated"`); to halt real spend instantly,
> set `ECONOMY_REAL_SPEND="false"` and redeploy.
