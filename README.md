<div align="center">

# murmur

**A population of fruit-fly nervous systems, adrift on the Arc market — settling with each other in real USDC over x402.**

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](./LICENSE)
[![Mode](https://img.shields.io/badge/Mode-LIVE%20%C2%B7%20Real%20USDC%20on%20Arc-success)](#-project-status-live-real-money-on-arc)
[![Chain](https://img.shields.io/badge/Chain-Arc%20Mainnet%20(5042)-7b61ff)](https://arc.io/)
[![Protocol](https://img.shields.io/badge/Payments-x402%20%C2%B7%20USDC-2775ca)](./docs/AGENT-ECONOMY.md)
[![Neurons](https://img.shields.io/badge/Neurons-%7E1%2C080%20LIF-9b59b6)](./docs/NEURAL-SIM.md)
[![Population](https://img.shields.io/badge/Population-24%20agents-e74c3c)](./docs/ARCHITECTURE.md)
[![Edge](https://img.shields.io/badge/Cloudflare-Workers%20%2B%20DO%20%2B%20Pages-f38020?logo=cloudflare&logoColor=white)](https://workers.cloudflare.com/)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.6-3178c6?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![Node](https://img.shields.io/badge/Node-%E2%89%A520-339933?logo=nodedotjs&logoColor=white)](https://nodejs.org/)
[![CI](https://img.shields.io/badge/CI-typecheck%20%2B%20test%20%2B%20build%20%2B%20smoke-2ea44f)](./.github/workflows/ci.yml)
[![Tests](https://img.shields.io/badge/tests-85%20passing-brightgreen)](./docs/ARCHITECTURE.md#testing)

</div>

---

> **murmur** reads whole-chain activity on **Arc**, reduces it to a single **market temperature**, and lets a
> population of **24 fruit-fly nervous systems** react — collectively and one fly at a time. Each fly is also an
> **autonomous economic agent**: its ~1,080-neuron **Leaky Integrate-and-Fire (LIF)** connectome decides *what to
> buy* and *from whom*, and the agents settle with each other in **real USDC on Arc mainnet** over the **x402**
> payment protocol — every settlement a genuine **EIP-3009** transfer you can verify on the Arc explorer.
>
> **No LLM decides anything.** Every choice emerges from spiking neurons, and every payment moves real money
> on-chain. This is **live**, not a simulation.

**Live frontend** · https://www.muros.live/  **Live API** · https://api.muros.live

---

## Project status — LIVE, real money on Arc

The deployed system settles in **real USDC on Arc mainnet**. The Worker reads Arc chain data to derive the market
temperature, and the agent economy runs a genuine **`OnChainFacilitator`**: each purchase is an **EIP-3009
`transferWithAuthorization`** against Arc's USDC precompile (`0x3600…0000`), signed by the buyer's own HD-derived
key and relayed on-chain. Every settlement carries a real 64-hex transaction hash that resolves on the
[Arc explorer](https://explorer.arc.io) — the frontend links each ledger line straight to it.

Real money is bounded by hard rails, all live in the deployed config: a **kill switch** (`ECONOMY_REAL_SPEND`), a
**global daily cap** and a **per-agent daily cap**, and a **facilitator per-deal cap**. Shadow mode
(`ECONOMY_SHADOW`) — sign + simulate without broadcasting — is how the path was proven against live chain state
before a single wei went out; it is now **off**, so transfers really broadcast.

> The **keyless `SimulatedFacilitator`** still exists and is what a fresh local checkout runs when no
> `ECONOMY_MNEMONIC` secret is present — a zero-risk way to develop. But the **production deployment is onchain**:
> `ECONOMY_FACILITATOR="onchain"` and `ECONOMY_SHADOW="false"` are committed in
> [`wrangler.toml`](./packages/trader-worker/wrangler.toml). See [**docs/AGENT-ECONOMY.md**](./docs/AGENT-ECONOMY.md).

---

## Features

| Feature | Description |
|---|---|
| **Market temperature** | Samples recent Arc blocks, reduces tx/gas throughput against a self-calibrating EWMA baseline, and maps the ratio through a logistic curve to a `HOT / CALM / COLD` regime — no token, no price feed. |
| **Neural population** | 24 flies, each an independent ~1,080-neuron LIF connectome grown from its own seed (its *temperament*). No breeding, no lineage, no culling — the population persists and reacts. |
| **Two-layer behaviour** | The temperature sets the collective regime; each fly's own wiring decides how strongly it expresses that regime and whether it breaks rank. Decoded *relative to its peers* every tick. |
| **Agent economy (x402)** | Each fly is an economic agent with its own USDC micro-wallet. Neural drives become an economic intent (which good, how strongly, which peer), and buyer/seller run a faithful x402 `exact` flow that settles in **real USDC**. |
| **Live on-chain settlement** | Production runs the **`OnChainFacilitator`**: real **EIP-3009** `transferWithAuthorization` against Arc's USDC precompile, signed by each buyer's HD-derived key. Every settlement yields a real tx hash, verifiable on the Arc explorer. A keyless `SimulatedFacilitator` remains for local dev — same economy code, zero changes. |
| **Settlement netting** | Real gas dwarfs a sub-cent micropayment, so on-chain trades are folded per agent-pair into one signed **net** and only the net is broadcast — at most once per cron, above a dust threshold. Reciprocal trades cancel; gas is amortised across many payments. |
| **Visitor stimulus** | Anyone can "poke the swarm" (`food / threat / light / dark`), rate-limited per visitor, riding on top of the market pulse as a secondary sensory input. |
| **Generative frontend** | A living canvas: the whole scene cools/warms with the market, flies murmur and scatter, touching one opens its drives + agent wallet, and an **all-agent wallet roster** lists every fly's on-chain address and balance. |
| **Long-term memory (D1)** | Every cron archives one row — temperature, regime, deals, cumulative settlements/volume, wealth gini, behaviour histogram — to **Cloudflare D1**; `GET /history` serves it back for the frontend's swarm-history curves and research export. |
| **Human arena (MURMUR)** | Token holders bet the project's own **MURMUR** token on the *same* Arc-temperature move the swarm bets — UP/DOWN into a **non-custodial, parimutuel** book escrowed and paid out by an on-chain `PredictionArena` contract. The Worker is only the **resolver**: it commits each round's temperature, and the contract derives UP/DOWN/FLAT from the committed entry + flat band, so no operator can steer an outcome. A live leaderboard pits the crowd's hit-rate against the flies'. |
| **Real-money safety rails** | Kill switch (`ECONOMY_REAL_SPEND`), shadow mode (sign + simulate, never broadcast), global & per-agent daily caps, and a facilitator per-deal cap — **live and bounding the production deployment**. |

---

## Architecture

```
                    Arc chain (mainnet 5042) — READ (temperature) + WRITE (EIP-3009 USDC)
                    recent blocks: tx/block, gasUsed/block
                                   │
                                   ▼
        ┌──────────────────────────────────────────────────────────────┐
        │  Cloudflare Worker "murmur"  ·  Cron every minute              │
        │                                                                │
        │   ┌──────────────── Durable Object: FlyStateDO ─────────────┐ │
        │   │  MarketMeter   ▶ temperature + regime (EWMA baseline)    │ │
        │   │  Population    ▶ 24 × FlyBrain (LIF ~1,080 n)            │ │
        │   │                  sensory encode ▶ spike ▶ motor decode   │ │
        │   │                  ▶ drives + behaviour (peer-relative)    │ │
        │   │  AgentEconomy  ▶ drives → intent → x402 "exact" flow     │ │
        │   │                  OnChainFacilitator (LIVE, production)   │ │
        │   │                  EIP-3009 → Arc USDC precompile (0x36…)  │ │
        │   │                  ┄┄ local dev ┄┄▶ SimulatedFacilitator │ │
        │   └──────────────────────────────────────────────────────────┘ │
        └───────────────────────────────┬────────────────────────────────┘
                                         │  REST (JSON)  ·  api.muros.live
                                         ▼
        ┌──────────────────────────────────────────────────────────────┐
        │  Frontend · Cloudflare Pages · www.muros.live                  │
        │   generative swarm canvas · market temperature ribbon          │
        │   per-fly inspector · all-agent wallet roster · verify hash    │
        │   visitor stimulus ("poke the swarm")                          │
        └──────────────────────────────────────────────────────────────┘
```

### How a fly decides

Market activity is encoded into the fly's **sensory channels** (a biological analogy), integrated across the LIF
network, then read back out of **motor-neuron firing rates** and decoded *relative to the population* this tick:

| Motor channel | Fly behaviour | Decoded drive |
|---|---|---|
| `leg_left` / `leg_right` | steering asymmetry | **turn** (`left − right`) → which peers to reach toward |
| `leg_*` + `wing` | locomotor + wing-beat | **arousal** → how strongly it acts / buys |
| `proboscis` | appetitive approach reflex | **cohesion** → seek the swarm centre / trade near |
| `abdomen` | abdominal stillness tone | **rest** → dampens participation |

The market **temperature** anchors the collective base (`HOT → high arousal, low cohesion`; `COLD → huddled,
restful`), while each fly's relative standing spreads individuals around that base and picks the minority that
breaks rank — yielding one of `AGITATE / EXPLORE / AGGREGATE / REST`. See
[**docs/NEURAL-SIM.md**](./docs/NEURAL-SIM.md).

### From drives to money

The economy is a strict **read-out** of the neural layer (one-directional — it never feeds back into the
connectome). Behavioural state picks *which good* to buy (`EXPLORE→signal`, `AGITATE→momentum`,
`AGGREGATE→attestation`); arousal scales *how strongly*; cohesion/turn pick *which peer*; temperature sets
*market-wide demand*. See [**docs/AGENT-ECONOMY.md**](./docs/AGENT-ECONOMY.md).

---

## Repository layout

```
packages/
  fly-brain/       LIF neural core: connectome, LIF network, motor decoder, stimuli, shared types
    src/*.test.ts  unit tests: connectome structure, LIF dynamics + SFA, motor-decoder invariants
  trader-worker/   Cloudflare Worker + Durable Object: market temperature, population, x402 agent economy
    src/           chain · market · population · economy · x402 · keys · stimulus · state · config · index
    schema.sql     D1 archival table (one row per cron) served back by GET /history
    src/*.test.ts  unit tests: the economy's one-directional read-out, conservation, determinism
    contracts/     PredictionArena.sol (MURMUR human arena) + NeuralReceiptRegistry.sol (proof anchor) + foundry tests
    scripts/       fund-agents.mjs · compile-*.mjs · deploy-registry(-auto).mjs · deploy-arena(-auto).mjs (dry-run / confirm-gated)
  frontend/        Static generative dashboard (HTML / CSS / vanilla JS) on Cloudflare Pages
docs/
  ARCHITECTURE.md    system overview: Worker, Durable Object, data flow, endpoints, design boundaries
  NEURAL-SIM.md      the fly brain: LIF network, connectome, motor decoding, backends, stimulus
  AGENT-ECONOMY.md   x402 agent economy + real-money rails + go-live runbook
  DEPLOYMENT.md      deploying the Worker + Frontend, secrets and configuration
.github/workflows/
  ci.yml           typecheck + unit tests + build + neural smoke on every push / pull request
```

---

## Testing

CI runs four gates, all keyless and chain-free (`npm run typecheck && npm test && npm run build && npm run smoke`).
The **85 unit tests** (27 in `fly-brain`, 58 in `trader-worker`) are real behavioural assertions, not a smoke stub.
Key suites:

```bash
npm test          # connectome · LIF · motor decoder · economy
```

| Suite | What it pins down |
|---|---|
| `connectome.test.ts` | The graph is the documented ~1,080-neuron laminar **downsample of FlyWire** (~138k n / ~5M syn): layer sizes + order, sparse fan-in, excitatory feedforward, **mutually-inhibitory** L2 left↔right (the winner-take-all), ipsilateral leg projections, the appetitive gustatory→proboscis reflex, and **deterministic-per-seed / distinct-across-seeds** wiring. |
| `lif.test.ts` | Resting leak, threshold→spike→reset, the refractory blackout, one-step-delayed weighted synaptic propagation (excitatory **and** inhibitory), and **spike-frequency adaptation** — the fatigue current that provably reduces sustained firing so the WTA alternates instead of hard-latching. Plus exact `toJSON`/`fromJSON` round-trip. |
| `motor-decoder.test.ts` | The two-layer read-out: HOT→aroused/dispersed vs COLD→huddled/restful collective base, population-relative individual spread, `[0,1]`/`[−1,1]` clamping, regime state selection through hysteresis, robust 10–90 percentile bands, and fingerprint determinism. |
| `economy.test.ts` | The economy is a strict **one-directional read-out** — a frozen neural input is provably bit-for-bit unchanged after a settlement round (no feedback into the connectome). Plus behaviour→good mapping, buyer/seller value transfer, **simulated money conservation**, the solvency floor, full determinism, and the per-agent wallet roster. |
| `arena.test.ts` | The human-arena resolver is **safe by construction**: temperature→r6 encoding, the round-plan cursor (open/resolve exactly once, idempotent, retries a missed resolve, handles `cur=0` and a mid-stream start), the economy's arena delegators returning `null` in simulated mode (and swallowing a facilitator throw), and `loadConfig`'s arena gating (default-off, trim/clamp, `flatBand` falling back to `PREDICT_FLAT_BAND`). |

> **Why no economic feedback into the neural layer?** It is a deliberate invariant, not a missing feature — see
> [Design boundaries](./docs/ARCHITECTURE.md#design-boundaries-honest-scale--scope). `economy.test.ts` enforces it.


---

## Quick start (local development)

```bash
# 1. Install dependencies (Node >= 20)
npm install

# 2. Run the test suite + neural smoke test (no chain interaction, no keys)
npm test
npm run smoke

# 3. Start the Worker locally (keyless simulated economy — no secrets, no real funds)
npm run dev:worker
# → http://localhost:8787/health   ·   /population   ·   /economy
```

> Local dev needs **no secrets at all**. Without `ECONOMY_MNEMONIC` the Worker runs the keyless **simulated**
> economy (a zero-risk mirror of the live one); the market-temperature path only reads public Arc RPC. The
> **production** deployment sets the mnemonic + `ECONOMY_FACILITATOR="onchain"` and settles real USDC.

---

## API endpoints

The Worker root returns a health check and endpoint navigation. The full surface is a **free, keyless,
CORS-enabled** read-only API with a machine-readable [OpenAPI 3.1 contract](https://api.muros.live/openapi.json),
living developer docs at **https://muros.live/developers**, and a written reference in [**API.md**](./API.md).
All paths also answer under a `/v1` prefix (`/v1/population` ≡ `/population`). Main endpoints (all JSON):

| Method | Path | Description |
|---|---|---|
| `GET` | `/` · `/health` | Liveness, name, chain, feature list, endpoint index |
| `GET` | `/openapi.json` | The OpenAPI 3.1 contract for this API (free, no key, CORS-open) |
| `GET` | `/state` | Global state: tick, population size, config, counters |
| `GET` | `/population` | Collective mood + per-fly drives + economy summary (the frontend feed) |
| `GET` | `/market` | Current Arc activity → temperature / regime |
| `GET` | `/economy` | Agent wallets + x402 settlement ledger + totals |
| `GET` | `/leaderboard` | Trustless per-agent PnL ranking + paid-signal revenue |
| `GET` | `/manifest` | The swarm's brain manifest + its sha256 identity + on-chain registry (trustless "prove the brain") |
| `GET` | `/manifest/replay` | Server-side offline replay: rebuild every connectome from its committed seed → PASS/FAIL |
| `GET` | `/proofs` | Neural-receipt hash chain (last 64 settlements) + `chainHead` |
| `GET` | `/proofs/verify?tx=0x…` | Verify one settlement's neural origin against its on-chain EIP-3009 nonce |
| `GET` | `/lineage` | The connectome breeding market: every genome + its on-chain ancestry (genesis roots + bred individuals) |
| `GET` | `/lineage/{hash}` | One bred brain: genome body + parents/children + re-derived structural spec + on-chain commit |
| `GET` | `/lineage/verify?hash=0x…` | Recompute a genome's hash, replay its brain, confirm its on-chain ancestry → PASS/FAIL |
| `GET` | `/predictions` | On-chain temperature prediction market: live book + parimutuel odds + hit-rate leaderboard |
| `GET` | `/predictions/verify?round=N` | Recompute a round's receipt hash + read its on-chain registry commitment |
| `GET` | `/signal/requirements` | The x402 payment requirements a browser signs to buy `/signal/pulse` |
| `GET` | `/signal/pulse` | **Paid (x402):** the machine-readable Arc-activity signal — `402` with requirements until you attach an EIP-3009 `X-PAYMENT` |
| `GET` | `/arena` | The human-vs-swarm **MURMUR** arena: current + previous round (pools, odds, entry/exit temp, countdown), the resolver/contract addresses, and the swarm's lifetime hit-rate. Inert (`{enabled:false}`) until `PredictionArena` is deployed and `ARENA_ENABLED` is on |
| `GET` | `/history` | D1 long-term archive: one row per cron (temperature, deals, cumulative volume, gini, state histogram) + a since-launch summary |
| `GET` | `/snapshot?flyId=N` | Full neural state of one fly (firing rates, spikes) + its agent wallet |
| `GET` | `/flies/:id` | A single fly's drives, behaviour and vitals |
| `GET` | `/stimuli` | Recent visitor-stimulus history |
| `POST` | `/stimulus` | Poke the swarm (walletless; `clientId` + cooldown) |
| `POST` | `/tick` | Debug: run one cron tick immediately |
| `POST` | `/reset` | Debug: fresh founding population + re-founded agent wallets |

---

## Configuration reference

Non-sensitive config lives in `[vars]` of
[`packages/trader-worker/wrangler.toml`](./packages/trader-worker/wrangler.toml); sensitive values are uploaded
out-of-band with `wrangler secret put` and **never committed**. Defaults are defined in
[`src/config.ts`](./packages/trader-worker/src/config.ts).

The **Default** column shows the committed production values in
[`wrangler.toml`](./packages/trader-worker/wrangler.toml). A fresh local checkout with no `ECONOMY_MNEMONIC`
secret transparently falls back to the keyless `simulated` facilitator (see the note below the table).

| Variable | Default | Description |
|---|---|---|
| `CHAIN_ID` | `5042` | Arc mainnet (`5042002` = Arc testnet) |
| `RPC_URL` | `https://rpc.mainnet.arc.io` | Arc RPC — market reads **and** the settlement relay |
| `MARKET_SAMPLE_BLOCKS` | `16` | Recent blocks sampled per cron |
| `MARKET_EWMA_ALPHA` | `0.08` | Baseline smoothing (slow ⇒ tracks the regime, not spikes) |
| `MARKET_GAIN` | `3.0` | Logistic sharpness, activity ratio → temperature |
| `REGIME_HOT` / `REGIME_COLD` | `0.66` / `0.33` | Temperature thresholds for `HOT` / `COLD` |
| `POPULATION_SIZE` | `24` | Number of flies (1–256) |
| `POPULATION_SEED_BASE` | `42` | Base seed; fly *i* uses `base + i·7919` |
| `TICKS_PER_CRON` | `6` | Simulation sub-ticks per cron |
| `SIM_STEPS_PER_TICK` | `500` | LIF integration steps per sub-tick |
| `STIMULUS_COOLDOWN_SEC` | `30` | One stimulus injection per visitor per N seconds |
| `ECONOMY_ENABLED` | `true` | Agent economy on/off |
| `ECONOMY_INITIAL_BALANCE` | `6` | Display-mirror float per agent; onchain the spendable balance is what the operator actually funded |
| `ECONOMY_BASE_PRICE` | `0.002` | Base price of one good (USDC) before neural/market scaling |
| `ECONOMY_MAX_DEALS` | `10` | Per-cron settlement budget, spread across the 6 sub-ticks |
| `ECONOMY_FACILITATOR` | `onchain` | **`onchain`** (real EIP-3009, production) \| `simulated` (keyless ledger, local dev) |
| `ECONOMY_SHADOW` | `false` | **`false` = LIVE broadcast**; `true` = sign + simulate each transfer, never broadcast |
| `ECONOMY_NET_MIN_BROADCAST` | `0.004` | Netting: minimum net USDC per agent-pair before it is broadcast; dust carries forward |
| `ECONOMY_NET_FLUSH_TICKS` | `30` | Netting: force-flush any nonzero pending net at least every N sub-ticks |
| `ARENA_ENABLED` | `false` | Human **MURMUR** arena on/off; inert until `PredictionArena` is deployed **and** `ARENA_ADDRESS` is set |
| `ARENA_ADDRESS` | *(unset)* | Deployed `PredictionArena` (Arc mainnet); absent ⇒ the arena step is skipped entirely (zero behaviour change) |
| `ARENA_TOKEN` | `0x8faa…4a5d` | The **MURMUR** ERC-20 the arena is denominated in (informational / frontend) |
| `ARENA_ROUND_MIN` | `60` | Minutes per arena round (== the betting window); clamped 1..1440 |
| `ARENA_FLAT_BAND` | `0.008` | \|Δtemperature\| ≤ this ⇒ FLAT ⇒ full refund (defaults to `PREDICT_FLAT_BAND`) |
| `ARENA_STALE_GRACE_SEC` | `259200` | Seconds past a round's deadline after which anyone may expire it for a refund (3 days) |

**Real-money rails — LIVE in production** (`ECONOMY_FACILITATOR="onchain"`, `ECONOMY_SHADOW="false"`); they are
inert only in the keyless local-dev fallback, where there is no real money to bound:
`ECONOMY_REAL_SPEND` (kill switch, default on), `ECONOMY_DAILY_CAP` (`100`), `ECONOMY_PER_AGENT_DAILY_CAP` (`10`),
`ECONOMY_MAX_DEAL` (`0.05`), `ECONOMY_GAS_PRICE_GWEI`, `ECONOMY_USDC_EIP712_NAME` / `_VERSION`. Secrets:
`ECONOMY_MNEMONIC`, `ECONOMY_FACILITATOR_PK`, `ALCHEMY_ARC_RPC_URL`, and `ADMIN_TOKEN` (locks the `/tick` + `/reset`
debug endpoints when set). Full go-live runbook in
[**docs/AGENT-ECONOMY.md**](./docs/AGENT-ECONOMY.md).

---

## Deployment

```bash
npx wrangler login          # or set CLOUDFLARE_API_TOKEN for CI / non-interactive
npm run deploy:worker       # Cloudflare Worker "murmur" (+ api.muros.live custom domain)
npm run deploy:frontend     # Cloudflare Pages project "murmur"
npm run deploy              # both
```

See [**docs/DEPLOYMENT.md**](./docs/DEPLOYMENT.md) for secrets, custom domains and verification.

---

## Tech stack

- **Runtime**: Node.js ≥ 20 · npm workspaces (monorepo) · TypeScript 5.6
- **Edge**: Cloudflare Workers + Durable Objects (SQLite storage) + Pages · wrangler 4.x
- **Chain**: Arc mainnet (Chain ID 5042) — reads whole-chain activity for temperature, **writes** real EIP-3009 USDC transfers · viem ^2.21
- **Payments**: x402 `exact` scheme · **real USDC** (Arc precompile `0x3600…0000`, 6 decimals) · EIP-3009 `transferWithAuthorization`
- **Neural core**: TypeScript LIF spiking network (~1,080 neurons), deterministic and dependency-free
- **Frontend**: vanilla JS + Canvas 2D (no framework, no build step)

---

## Contributing & security

Contributions are welcome — please read [**CONTRIBUTING.md**](./CONTRIBUTING.md) and our
[**Code of Conduct**](./CODE_OF_CONDUCT.md). Because this project can, when explicitly enabled by an operator,
move real funds, **please review [SECURITY.md](./SECURITY.md)** before opening a vulnerability report; use the
private disclosure channel described there rather than a public issue.

---

## License & disclaimer

Released under the [MIT License](./LICENSE).

This is an **experimental art & research project** that moves **real money**. The flies' behaviour and settlements
emerge from neural simulation and are inherently unpredictable, and the production deployment settles **real USDC on
Arc mainnet** — the funded float is genuinely at risk, bounded only by the kill switch and the daily/per-deal caps.
Gas on Arc is paid in USDC and can exceed the face value of a micropayment, so the swarm can net-burn its float over
time. Nothing here is financial advice — use at your own risk.
