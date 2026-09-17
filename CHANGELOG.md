# Changelog

All notable changes to **murmur** are documented in this file. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

> murmur is the continuation of the former *Immortal Fruit Flies* experiment, rebuilt from a BSC token-trading bot
> into an **agent economy on Arc** that now settles **real USDC on mainnet**. The legacy trading stack was removed
> wholesale; see `0.2.0` below, and `[Unreleased]` for the go-live.

## [Unreleased]

### Added
- **Real unit-test suite (36 tests)** replacing the smoke-only gap: `connectome.test.ts` (laminar FlyWire
  downsample, mutually-inhibitory L2 winner-take-all, per-seed determinism), `lif.test.ts` (leak / spike /
  refractory / synaptic propagation and the spike-frequency-adaptation fatigue that breaks the WTA latch),
  `motor-decoder.test.ts` (two-layer regime + population-relative read-out, hysteresis), and
  `economy.test.ts` (the economy is a strict **one-directional read-out** — a frozen neural input is provably
  unchanged after settling — plus money conservation, determinism and the wallet roster). `npm test` runs them;
  CI gained a `test` gate. `@types/node` added as a dev dependency.
- **Frontend "all agent wallets" drawer**: every fly's own x402 wallet (address, balance, paid/earned, deals) is
  now browsable from the economy panel, alongside the existing per-fly inspector.
- Each real settlement in the ledger links to its transaction on the official **Arc explorer**, so any visitor can
  verify the money moved on-chain.

### Changed
- **GONE LIVE WITH REAL MONEY.** The production Worker now runs `ECONOMY_FACILITATOR = "onchain"` with
  `ECONOMY_SHADOW = "false"`: agents settle **real USDC on Arc mainnet** via EIP-3009 `transferWithAuthorization`,
  broadcast under the kill switch + daily/per-agent/per-deal caps. The keyless `SimulatedFacilitator` remains only
  as the zero-secret local-dev fallback.
- **De-simulated the messaging everywhere** — README (status, features, architecture, config, disclaimer),
  `package.json` description, `wrangler.toml` comments and the frontend meta/copy now state plainly that these are
  real on-chain transactions, not a simulation.
- Arc RPC transport replaced the naive `fallback` with a **rotating multi-provider pool** (public mainnet endpoints
  plus an optional private `ALCHEMY_ARC_RPC_URL`), per-request timeout-bounded, so a single slow RPC can no longer
  stall the market-temperature read.
- Frontend ledger **de-duplicates settlements by `txHash`**: the fast `/population` poll re-delivers the same cron
  tick many times, so one transaction is now drawn and logged exactly once instead of ~15×.
- Documentation rewritten to describe the actual system (`README.md`, `docs/ARCHITECTURE.md`,
  `docs/NEURAL-SIM.md`, `docs/AGENT-ECONOMY.md`, `docs/DEPLOYMENT.md`).
- Frontend inspector: neural bloom + spike raster are now offscreen-cached and rebuilt a few times per second
  (one `drawImage` blit per frame); the render loop is self-healing with adaptive quality, and pointer input is
  click-storm throttled, so rapid clicking can no longer stall the tab.

### Security
- **Real funds now move on Arc mainnet.** The rails are live and bounding production: kill switch
  (`ECONOMY_REAL_SPEND`), global + per-agent daily caps, a facilitator per-deal cap, and shadow mode as the
  proven-before-broadcast dry run. Note that Arc gas is paid in USDC and can exceed a micropayment's face value,
  so the funded float can net-burn over time.
- Dev-toolchain bump: `wrangler` 3.x → **4.133.0**, clearing all 6 `npm audit` advisories (they lived in the
  `miniflare` → `undici` / `ws` chain — dev/deploy-only, never shipped in the Worker bundle). Re-verified green
  afterwards: typecheck, build, unit tests, neural smoke, and a `wrangler deploy --dry-run` bundle.

## [0.2.0] - 2026-09-17

The **murmur** restart: a population of neural agents settling on Arc, replacing the legacy trading bot.

### Added
- **Market temperature** from Arc whole-chain activity: recent-block tx/gas throughput vs. a self-calibrating EWMA
  baseline, mapped through a logistic curve to a `HOT / CALM / COLD` regime (`market.ts`).
- **Neural population** of 24 flies, each an independent ~1,080-neuron LIF connectome grown from its own seed;
  behaviour decoded *relative to the population* each tick (`population.ts`, `@fly/fly-brain`).
- **x402 agent economy**: drives → economic intent → a faithful x402 `exact` flow between agents, with three data
  goods (`signal` / `momentum` / `attestation`) and atomic 6-decimal USDC accounting (`economy.ts`, `x402.ts`).
- **Keyless `SimulatedFacilitator`** by default (internal ledger, deterministic pseudo tx-hash, zero-address asset)
  plus a documented **`OnChainFacilitator`** seam for real EIP-3009 settlement on Arc's USDC precompile
  (`0x3600…0000`).
- **HD custody** (`keys.ts`): one BIP-39 mnemonic derives all agent wallets (`m/44'/60'/0'/0/{id}`) and the
  facilitator (index 2,000,000).
- **Real-money safety rails**: kill switch (`ECONOMY_REAL_SPEND`), shadow mode (`ECONOMY_SHADOW`), global daily cap,
  per-agent daily cap, and per-deal cap — all inert in simulated mode.
- **Wallet distribution tool** (`packages/trader-worker/scripts/fund-agents.mjs`): dry-run by default, `--send` to
  broadcast; funds the 25 derived addresses from a single vault.
- **Generative frontend** (`murmur`): a living Canvas 2D swarm that warms/cools with the market, with a per-fly
  inspector (neural bloom, spike raster, drives, x402 wallet) and visitor stimulus.
- Deployment on Cloudflare: Worker `murmur` at `api.muros.live` (cron `* * * * *`, `FlyStateDO` SQLite storage) and
  Pages `murmur` (`murmur-4sx.pages.dev`).

### Changed
- Chain target migrated from **BSC (56)** to **Arc mainnet (5042)**, read-only for market data.
- Settlement migrated from a single trading treasury to **per-agent USDC micro-wallets** over x402.
- `FlyBrain` archives bumped to **version 3** with tuned spike-frequency adaptation (`adaptIncrement 0.05`);
  pre-v3 archives wake fresh to escape the winner-take-all latch.

### Removed
- The entire legacy on-chain trading stack: DEX execution (`trader.ts`), swarm cull/reproduce & lineage
  (`swarm.ts`), token selection (`token-select.ts`), the on-chain `NeuralLog.sol` contract and `packages/contracts`,
  the neural-log module, and all `$IFF` / PancakeSwap / BSC configuration, secrets and docs.

### Security
- The project is **keyless and simulated by default**; real settlement requires an explicit operator opt-in
  (`ECONOMY_FACILITATOR="onchain"` + `ECONOMY_MNEMONIC` secret + funded wallets) and is bounded by the rails above.
