<div align="center">

# murmur

**A population of fruit-fly nervous systems, adrift on the Arc market — settling with each other in USDC over x402.**

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](./LICENSE)
[![Mode](https://img.shields.io/badge/Mode-Simulated%20%2B%20Keyless-informational)](#-project-status-honest-by-default)
[![Chain](https://img.shields.io/badge/Chain-Arc%20Mainnet%20(5042)-7b61ff)](https://arc.io/)
[![Protocol](https://img.shields.io/badge/Payments-x402%20%C2%B7%20USDC-2775ca)](./docs/AGENT-ECONOMY.md)
[![Neurons](https://img.shields.io/badge/Neurons-%7E1%2C080%20LIF-9b59b6)](./docs/NEURAL-SIM.md)
[![Population](https://img.shields.io/badge/Population-24%20agents-e74c3c)](./docs/ARCHITECTURE.md)
[![Edge](https://img.shields.io/badge/Cloudflare-Workers%20%2B%20DO%20%2B%20Pages-f38020?logo=cloudflare&logoColor=white)](https://workers.cloudflare.com/)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.6-3178c6?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![Node](https://img.shields.io/badge/Node-%E2%89%A520-339933?logo=nodedotjs&logoColor=white)](https://nodejs.org/)
[![CI](https://img.shields.io/badge/CI-typecheck%20%2B%20build%20%2B%20smoke-2ea44f)](./.github/workflows/ci.yml)
[![PRs Welcome](https://img.shields.io/badge/PRs-welcome-brightgreen.svg)](./CONTRIBUTING.md)

</div>

---

> **murmur** reads whole-chain activity on **Arc**, reduces it to a single **market temperature**, and lets a
> population of **24 fruit-fly nervous systems** react — collectively and one fly at a time. Each fly is also an
> **autonomous economic agent**: its ~1,080-neuron **Leaky Integrate-and-Fire (LIF)** connectome decides *what to
> buy* and *from whom*, and the agents settle with each other in **USDC** over the **x402** payment protocol.
>
> **No LLM decides anything. No private key is held by default.** Every choice emerges from spiking neurons.

**Live frontend** · https://murmur-4sx.pages.dev  **Live API** · https://api.muros.live

---

## ✨ Project status — honest by default

The deployed system runs in **simulated, keyless mode**: the Worker only **reads** Arc chain data to derive the
market temperature, and the agent economy settles against an in-memory **`SimulatedFacilitator`** ledger. There is
**no wallet, no private key, no signing and no real funds at risk** in the default configuration.

Real on-chain settlement (**EIP-3009 `transferWithAuthorization`** against Arc's USDC precompile) is **fully
implemented** in [`packages/trader-worker/src/x402.ts`](./packages/trader-worker/src/x402.ts) but stays **inert**
until an operator explicitly flips `ECONOMY_FACILITATOR="onchain"`, sets the `ECONOMY_MNEMONIC` secret, and funds
the derived wallets — under a kill switch, shadow mode, and daily/per-deal spend caps. See
[**docs/AGENT-ECONOMY.md**](./docs/AGENT-ECONOMY.md).

---

## Features

| Feature | Description |
|---|---|
| **Market temperature** | Samples recent Arc blocks, reduces tx/gas throughput against a self-calibrating EWMA baseline, and maps the ratio through a logistic curve to a `HOT / CALM / COLD` regime — no token, no price feed. |
| **Neural population** | 24 flies, each an independent ~1,080-neuron LIF connectome grown from its own seed (its *temperament*). No breeding, no lineage, no culling — the population persists and reacts. |
| **Two-layer behaviour** | The temperature sets the collective regime; each fly's own wiring decides how strongly it expresses that regime and whether it breaks rank. Decoded *relative to its peers* every tick. |
| **Agent economy (x402)** | Each fly is an economic agent with a USDC micro-wallet. Neural drives become an economic intent (which good, how strongly, which peer), and buyer/seller run a faithful x402 `exact` flow. |
| **Keyless by default** | A `SimulatedFacilitator` keeps the ledger and mints deterministic pseudo tx-hashes; a documented `OnChainFacilitator` seam drops in real EIP-3009 settlement with **zero** changes to the economy logic. |
| **Visitor stimulus** | Anyone can "poke the swarm" (`food / threat / light / dark`), rate-limited per visitor, riding on top of the market pulse as a secondary sensory input. |
| **Generative frontend** | A living canvas: the whole scene cools/warms with the market, flies murmur and scatter, and touching one opens its live neural bloom, spike raster, drives and agent wallet. |
| **Real-money safety rails** | Kill switch, shadow-only mode (sign + simulate, never broadcast), global & per-agent daily caps, and a facilitator per-deal cap — all inert in simulated mode. |

---

## Architecture

```
                    Arc chain (mainnet 5042) — READ ONLY
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
        │   │                  simulated facilitator (keyless ledger)  │ │
        │   │                  ┄┄ opt-in ┄┄▶ OnChainFacilitator        │ │
        │   │                              EIP-3009 → Arc USDC (0x36…) │ │
        │   └──────────────────────────────────────────────────────────┘ │
        └───────────────────────────────┬────────────────────────────────┘
                                         │  REST (JSON)  ·  api.muros.live
                                         ▼
        ┌──────────────────────────────────────────────────────────────┐
        │  Frontend · Cloudflare Pages · murmur-4sx.pages.dev            │
        │   generative swarm canvas · market temperature ribbon          │
        │   per-fly inspector: neural bloom + spike raster + x402 wallet │
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
  fly-brain/       LIF neural core: connectome, network, motor decoder, stimuli, WASM backend adapter
  trader-worker/   Cloudflare Worker + Durable Object: market temperature, population, x402 agent economy
    src/           chain · market · population · economy · x402 · keys · stimulus · state · config · index
    scripts/       fund-agents.mjs (one-off, opt-in real-money wallet distribution — dry-run by default)
  frontend/        Static generative dashboard (HTML / CSS / vanilla JS) on Cloudflare Pages
docs/
  ARCHITECTURE.md    system overview: Worker, Durable Object, data flow, endpoints
  NEURAL-SIM.md      the fly brain: LIF network, connectome, motor decoding, backends, stimulus
  AGENT-ECONOMY.md   x402 agent economy + real-money rails + go-live runbook
  DEPLOYMENT.md      deploying the Worker + Frontend, secrets and configuration
.github/workflows/
  ci.yml           typecheck + build + neural smoke on every push / pull request
```

---

## Quick start (local development)

```bash
# 1. Install dependencies (Node >= 20)
npm install

# 2. Run the neural smoke test (no chain interaction, no keys)
npx tsx packages/fly-brain/smoke.ts

# 3. Start the Worker locally (simulated, keyless — safe by default)
npm run dev:worker
# → http://localhost:8787/health   ·   /population   ·   /economy
```

> Local dev needs **no secrets at all**. Without `ECONOMY_MNEMONIC` the Worker runs the keyless simulated
> economy; the market-temperature path only reads public Arc RPC.

---

## API endpoints

The Worker root returns a health check and endpoint navigation. Main endpoints (all JSON):

| Method | Path | Description |
|---|---|---|
| `GET` | `/` · `/health` | Liveness, name, chain, feature list, endpoint index |
| `GET` | `/state` | Global state: tick, population size, config, counters |
| `GET` | `/population` | Collective mood + per-fly drives + economy summary (the frontend feed) |
| `GET` | `/market` | Current Arc activity → temperature / regime |
| `GET` | `/economy` | Agent wallets + x402 settlement ledger + totals |
| `GET` | `/snapshot?flyId=N` | Full neural state of one fly (firing rates, spikes) + its agent wallet |
| `GET` | `/flies/:id` | A single fly's drives, behaviour and vitals |
| `GET` | `/stimuli` | Recent visitor-stimulus history |
| `POST` | `/stimulus` | Poke the swarm (walletless; `clientId` + cooldown) |
| `POST` | `/tick` | Debug: run one cron tick immediately |
| `POST` | `/reset` | Debug: fresh founding population + re-funded simulated wallets |

---

## Configuration reference

Non-sensitive config lives in `[vars]` of
[`packages/trader-worker/wrangler.toml`](./packages/trader-worker/wrangler.toml); sensitive values are uploaded
out-of-band with `wrangler secret put` and **never committed**. Defaults are defined in
[`src/config.ts`](./packages/trader-worker/src/config.ts).

| Variable | Default | Description |
|---|---|---|
| `CHAIN_ID` | `5042` | Arc mainnet (`5042002` = Arc testnet) |
| `RPC_URL` | `https://rpc.mainnet.arc.io` | Arc RPC (read-only) |
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
| `ECONOMY_INITIAL_BALANCE` | `10` | Starting simulated USDC per agent |
| `ECONOMY_BASE_PRICE` | `0.002` | Base price of one good (USDC) before neural/market scaling |
| `ECONOMY_FACILITATOR` | `simulated` | `simulated` (keyless ledger) \| `onchain` (real EIP-3009) |
| `BRAIN_BACKEND` | `ts-lif` | `ts-lif` \| `wasm-flyai` \| `wasm-mock` |

**Real-money rails** (all inert unless `ECONOMY_FACILITATOR="onchain"` **and** `ECONOMY_MNEMONIC` is set):
`ECONOMY_REAL_SPEND` (kill switch), `ECONOMY_SHADOW` (sign + simulate, never broadcast),
`ECONOMY_DAILY_CAP` (`20`), `ECONOMY_PER_AGENT_DAILY_CAP` (`2`), `ECONOMY_MAX_DEAL` (`0.05`),
`ECONOMY_GAS_PRICE_GWEI`, `ECONOMY_USDC_EIP712_NAME` / `_VERSION`. Secrets: `ECONOMY_MNEMONIC`,
`ECONOMY_FACILITATOR_PK`. Full go-live runbook in [**docs/AGENT-ECONOMY.md**](./docs/AGENT-ECONOMY.md).

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
- **Chain**: Arc mainnet (Chain ID 5042), read-only for market temperature · viem ^2.21
- **Payments**: x402 `exact` scheme · USDC (Arc precompile `0x3600…0000`, 6 decimals) · EIP-3009
- **Simulation**: TypeScript LIF spiking network (~1,080 neurons; optional fly.ai WASM backend)
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

This is an **experimental art & research project**. The flies' behaviour and settlements emerge from neural
simulation and are inherently unpredictable. It runs **simulated and keyless by default**; enabling real-money
settlement is an explicit, operator-gated action that could lose the funded float. Gas on Arc is paid in USDC and
can exceed the face value of a micropayment. Nothing here is financial advice — use at your own risk.
