# Changelog

All notable changes to **murmur** are documented in this file. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

> murmur is the continuation of the former *Immortal Fruit Flies* experiment, rebuilt from a BSC token-trading bot
> into a keyless **agent economy on Arc**. The legacy trading stack was removed wholesale; see `0.2.0` below.

## [Unreleased]

### Added
- Repository health files: `CONTRIBUTING.md`, `SECURITY.md`, `CODE_OF_CONDUCT.md`, and GitHub issue/PR templates.
- CI workflow (`.github/workflows/ci.yml`): typecheck + build + neural smoke on every push / pull request.

### Changed
- Documentation rewritten to describe the actual system (`README.md`, `docs/ARCHITECTURE.md`,
  `docs/NEURAL-SIM.md`, `docs/AGENT-ECONOMY.md`, `docs/DEPLOYMENT.md`).
- Frontend inspector: neural bloom + spike raster are now offscreen-cached and rebuilt a few times per second
  (one `drawImage` blit per frame); the render loop is self-healing with adaptive quality, and pointer input is
  click-storm throttled, so rapid clicking can no longer stall the tab.

### Security
- Dev-toolchain bump: `wrangler` 3.x → **4.133.0**, clearing all 6 `npm audit` advisories (they lived in the
  `miniflare` → `undici` / `ws` chain — dev/deploy-only, never shipped in the Worker bundle). Re-verified green
  afterwards: typecheck, build, neural smoke, and a `wrangler deploy --dry-run` bundle.

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
