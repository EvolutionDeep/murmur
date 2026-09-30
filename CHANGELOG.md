# Changelog

All notable changes to **murmur** are documented in this file. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

> murmur is the continuation of the former *Immortal Fruit Flies* experiment, rebuilt from a BSC token-trading bot
> into an **agent economy on Arc** that now settles **real USDC on mainnet**. The legacy trading stack was removed
> wholesale; see `0.2.0` below, and `[Unreleased]` for the go-live.

> **Current live numbers — single source of truth.** The production topology is the **literal FAFB_783 FlyWire MB+CX
> subgraph** — **10,361 neurons / 467,314 neurotransmitter-signed synapses** (Eckstein et al. 2024, CC-BY 4.0) —
> committed on-chain (**manifestHash `100712db…ef9c`**, `NeuralManifestRegistry`, Arc mainnet `5042`). **Every live fly
> (genesis and bred alike) instantiates the same literal connectome**; each genome parameterizes only the synaptic
> weights and neuromodulatory traits on that fixed anatomy — so neuron count no longer varies per fly. Flies are sharded
> **one per isolate** across 100 `FlyShardDO` shards. The population **founds at 24 and breeds live toward a 100 cap**
> (`EVOLUTION_MAX_LIVE_POPULATION`) — 24 is genesis, not a fixed cast. **642 unit tests** pass
> (53 `fly-brain` + 565 `trader-worker` + 24 `arc-circle-x402`). The previous **30,800-neuron procedural PRNG species
> spec is superseded**; `BRAIN_N_*` sizing remains only as a **legacy procedural fallback** and hatch memory-budget
> estimator. The dated entries below are historical snapshots and legitimately reflect the values of their own release.

## [Unreleased]

### Fixed — shadow-compare wiring gap: `economyCfg()` never passed `shadowCompare` through (task #118, #87)
- **Root cause (latent since the #116 gate)**: `FlyStateDO.economyCfg()` built the `EconomyConfig` handed to
  `new AgentEconomy(...)` but omitted the `shadowCompare` block, so `AgentEconomy.shadowCompareOn()` evaluated
  `!!undefined && …` → permanently `false`. Flipping the `ECONOMY_EVOLUTION_SHADOW` secret therefore armed
  nothing: `shadowStep()` returned `[]` on its first line and `GET /economy` never carried a `shadowCompare`
  key. The DO's own `this.cfg.shadowCompare` *was* live — which is exactly why `pocaKnobsHash()` still saw the
  flip and logged a `kind=3 PARAM_OVERRIDE` — so the two config objects had silently diverged. The gate could
  not catch it: every shadow test injected the config directly (`cfg({ shadowCompare: SHADOW_ON })`),
  bypassing the `economyCfg()` → `AgentEconomy` wiring path that production actually takes.
- **Fix (`state.ts`, purely additive +11/-0)**: `economyCfg()` now passes the whole block through (`enabled` /
  `everyNCrons` / `maxDecisionsPerCron` / `maxRowsPerCronToD1`), so the SAME object `pocaKnobsHash()`
  snapshots is the one the economy sees. No other config field was touched; `serialize()` stays byte-identical
  with the switch OFF.
- **Regression guard (`shadowCompare.test.ts`, +140)**: F1–F4 exercise the REAL wiring path
  (`economyCfg()` → `AgentEconomy`) rather than an injected config, so a dropped pass-through can never ship
  dark again. Gate: **1147 pass / 0 fail** + `typecheck` ×3 green, A2 zero-increment on every real field, A1
  (`facilitator` / `settle` / `flush` / `absorbFlows` / `payBreedingFee` / `payHatchFee`) structurally
  unreachable from `shadowStep`, E16 identity, deterministic double-run byte-for-byte.
- **Deployed + sealed on-chain**: `CODE_COMMITMENT` rotated `75a7a554…` → `3c605f6d…` (treeHash `cc2f509e…` →
  `1231694e…`; artifactHash `dc84edfc…`, fileCount 142 and knobCount 22 unchanged), sealing PoCA **epoch 6**
  (58 ticks, merkleRoot `a4407cb4…`, `prevEpochSeal` = epoch 5's `dcc71479…`) and opening **epoch 7** pinned to
  the new commitment. One `kind=7 CODE_CHANGE`, `epochCount` **7→8**, on-chain `isUnbroken(0,6)=true`,
  continuity `unbroken`, mirror aligned, committer unchanged.

### Added — shadow-compare Phase 1 live: the evolution decision mirror is recording (still zero real money)
- `ECONOMY_EVOLUTION_SHADOW=true` is now effective. Every cron mirrors the decision loop (64 decisions/cron)
  and appends up to **32 rows/cron** to the append-only D1 `shadow_decisions` table (`GET /shadow`), while
  `GET /economy` exposes the full **19-field** `shadowCompare` aggregate. The D1 write rides `ctx.waitUntil`,
  off the cron await path — measured cron cadence did **not** degrade (epoch 6 ≈ 91 s/digest, 58 ticks over
  5296 s, with the mirror inert vs epoch 7 ≈ 78 s/digest, 39 digests over 3060 s, with it live).
- **Real money is untouched**: the mirror is a pure read-out and every divergence counter it publishes is a
  *proposal*, never a mutation. `volumeUsdc` / `count` / `settleOk` / `settleFail` / `successRate` /
  `netPending` continue on their pre-existing trajectory, and no cap, kill switch or netting knob was changed
  (`ECONOMY_SHADOW` stays `"false"`, i.e. settlement behaviour is byte-for-byte what it was).
- **Read-out semantics worth knowing**: the `shadowCompare` aggregate and the `cron` column are **per-DO-
  instance in-memory** counters — they reset whenever Cloudflare evicts the Durable Object between crons
  (observed roughly every ~10 min at production cadence). The **durable, monotonic** evidence is the D1 table,
  where `tick` is the reliable global key; no duplicate `(tick, buyer_id)` row was observed. The shadow-only
  playbook ring is in-memory for the same reason — it must never enter the DO blob. `shadow_decisions` has no
  retention policy yet (~1.5 k rows/h ⇒ ~36 k rows/day), so a bounded GC is a follow-up, not part of #118.
- **Current divergence is zero by construction, not by failure**: every modulator the mirror composes
  (`strategyTilt`, the playbook good-override + counterparty amplifier, `rulesTilt`, MAP-Elites novelty)
  short-circuits to the identity while `STRATEGY_ENABLED` / `PLAYBOOK_ENABLED` / `RULES_ENABLED` /
  `ELITES_ENABLED` remain dark (all default `false`, none set in `wrangler.toml`). Observed:
  `avgAmplifier=1`, `exploreCount=0`, `gateFlipsToBuy=gateFlipsToHold=goodSwitches=sellerChanges=0`,
  `amountDeltaSumAtomic=0`, `evolvedAmountSumAtomic == baselineAmountSumAtomic`, all caps 0. The channel is
  armed and recording; it starts producing a non-trivial counterfactual from the moment a capability is armed.
  Evidence it is genuinely alive: `treeHashDistinct=64` (the GP substrate is being observed), the recorded
  regime / temperature bucket / good kind vary with the swarm, and the shadow playbook confidence moved off
  its `0.5` cold start (rows carrying `0` and `1`) within a single instance lifetime.

### Added — Lexicon word-hoard visualization (task #108, frontend)
- **`drawers.js`** `renderLexSection` rewritten to consume the COMPLETE `GET /lexicon` contract (the word-hoard's
  own endpoint), not the truncated read-out folded into `/economy`: the full permanent dictionary (every living
  word + every tombstone — dead words are shown permanently in a graveyard style, never hidden), each word's
  honest **monotone `lifetimeUses`** (never the shrinking rolling `uses`), `bornEra`, `coinedBy`, `spreads`,
  `lastTold`; the `counts` overview; this cron's three lifecycle `edges` (coinage/spread/dying); and the
  **permanent append-only D1 archive** with `?limit`/`?before`/`?order` pagination (load-older + asc/desc toggle).
  The `grammarHash` / `archiveCount` / `archived` / `archiveErrors` / `queueDepth` meta is surfaced so a reader
  can see the word-hoard is **complete · accurate · permanent**. `enabled:false` degrades to an honest empty
  state, never an error. New `loadLexicon` fetch (20 s throttle) is force-pulled on volume open and kept fresh by
  `polling.js` only while the lexicon volume is on stage.
- **Fixed — A-2 (`i18n-ui.js`)**: the lexicon row rendered "told `{uses}` times" from the ROLLING window count,
  which SHRINKS as the annals roll ages — so a word's "told N times" could go DOWN between polls (self-contradicting
  a permanent record). All 7 languages now render from the **monotone `lifetimeUses`** (`{told}`) + `bornEra`
  (`{bornEra}`), which never decreases.
- **i18n**: 30 new lexicon keys × **all 7 languages** (en/zh/fr/es/ja/ko/ar), fully symmetric — dictionary/graveyard
  rows, living/dead status, coiner, edges (coinage/spread/dying), archive events (COINAGE/SPREAD/SILENCE),
  permanence/grammar-hash/archive-meta labels, disabled/loading/order/pagination controls.
- **`styles.css`**: new `lx-*` classes (permanence line, meta, dictionary/edges/archive heads, tombstone gradient,
  lifecycle-edge + event-type color marks, vellum pill buttons) using logical properties for RTL safety.
- **`?v` cascade**: `main.js?v=162` / `styles.css?v=162` / `i18n.js?v=114` / `i18n-ui.js?v=107` (app-cascade
  161→162, i18n chain 113→114 and 106→107) to break the 4-hour stale-cache window across the whole import cascade.
- **Docs**: `API.md` documents the full `GET /lexicon` contract (query params + every `words`/`edges`/`archive`
  field, `grammarHash`/`archiveCount` semantics); `README.md` adds the endpoint + a Word-hoard feature note;
  `docs/POCA.md` documents `lexiconGrammarHash` as an independent anchor that does NOT perturb the PoCA chain.

### Added — Phase 7 evolution-engine visualizations (task 88, frontend)
- **`evolution.js`** (new bare ESM module + command-rail drawer): the read-only **Evolution Engine** sheet —
  five tabs over the Phase-7 worker surface: the cross-generation **capability curve** (`GET /lineage/stats`
  `byGeneration`, five normalized metrics), the **strategy-genome lineage DAG** (`GET /lineage` entries,
  genesis/mutate/cross colored, parent→child edges), the **niche heatmap** (MAP-Elites archive when exposed,
  otherwise the generation×temperature-band bins from `/lineage/stats`), the **era replay table**
  (`GET /replay/economy`: seed, per-era volume/gini/replayHash, combined hash chain), and the **playbook
  memory rings** (capability ① — ships in an honest dark state until the worker exposes the rings; the
  consumer is already wired to `economy.playbook`).
- **`institutionsHud.js`** (new bare ESM module + command-rail drawer): the **Emergent Institutions** HUD
  (capability ⑤) — norms / conventions / rules membranes from `GET /economy`: lifecycle counters
  (minted/spread/mutated/died · crystallized/inherited/breached/absorbed · adopted/revoked), aggregate
  gauges (compliance / concordance / breach rate / avg modifier), this-cron lifecycle edges, and the
  standing roster tables (condition text, strength gauge, depth, adherents/adopters/members). A membrane
  switch being off means the key is absent → the tab degrades to a dormant hint, never an error.
- **Wiring**: two rail buttons (`data-act="evo"/"inst"`, glyphs `#i-dna` / `#i-pillars`), two drawer shells
  in `index.html`, `main.js` rail/Escape/`rerenderAll`/`window.__close*` integration, `_headers` no-cache
  entries, 119 new i18n keys symmetric across all 7 languages, and a rail-height re-budget for 13 buttons
  (new 601–720px and 721–800px compaction tiers). `main.js?v=161` / `styles.css?v=161` /
  `i18n.js?v=113` / `i18n-ui.js?v=106`.
- **Docs**: `API.md` documents `GET /replay/economy`, `GET /lineage/stats` and the `/economy` membrane keys;
  `docs/ARCHITECTURE.md` + `docs/POCA.md` describe the new read-out drawer family.
- Known worker-side follow-up (deliberately untouched here): `playbook` / `strategyTrees` / `elitesArchive`
  exist in `economy.serialize()` but have no HTTP exposure — the Playbook and full 64-cell elites panels
  light up automatically once a read-out key lands.

### Added — Proof of Continuous Agency (PoCA)
- **`ContinuityRegistry.sol`** (Solidity ^0.8.24, `packages/trader-worker/contracts/`): pure commitment log —
  `openEpoch(codeCommitment, genesisHead)`, `sealEpoch(index, sealedHead, tickCount, merkleRoot)`,
  `adminAction(kind, payloadHash)`, `isUnbroken(from, to)`. Immutable committer, no funds, no upgrade path.
  Epochs chain via `prevEpochSeal`. Events: `EpochOpened`, `EpochSealed`, `AdminAction`.
- **`poca.ts`** (off-chain engine): `PocoEngine` class over injected `PocoStore` + `PocoChainHooks`.
  Digest chain: `cronDigest_i = sha256(prevDigest || u64be(i) || stateDigest || codeCommitment)`;
  `stateDigest = sha256(canonical(PocoStateInput))` where `PocoStateInput` = `{tickIndex, proofChainHead,
  chronicler{headHash,era,seq}, arenaCursor{openedRound,resolvedRound}, warCount, pop{size,generation,civLevel},
  econ{volumeAtomic,count}}`. Epoch seal threshold `SEAL_THRESHOLD = 1440` crons (~24h). Merkle: pairwise
  sha256 fold, odd-tail duplicated, empty = `ZERO64`, single-leaf = itself.
- **`codeCommitment.ts`** + **`scripts/gen-codecommit.mjs`**: codegen step producing `CODE_COMMITMENT` =
  `sha256(srcTreeHash_traderWorker + srcTreeHash_flyBrain + flywireArtifactSha256 + canonicalKnobDefaults)`.
  Git HEAD is NOT hashed (published separately via `GET /poca`). Runs before every `wrangler deploy`; a source
  change rotates the commitment and forces an epoch seal (admin kind 7 `CODE_CHANGE`).
- **Admin-discontinuity log**: kinds 1–7 (`RESET`, `MANUAL_TICK`, `PARAM_OVERRIDE`, `COMMITTER_CHANGE`,
  `GENESIS_SEED`, `DO_REBUILD`, `CODE_CHANGE`). Each entry: `{kind, ts, payloadHash, note, txHash?}`;
  capped at `ADMIN_LOG_CAP = 500`; best-effort on-chain mirror via `adminAction(kind, payloadHash)`.
- **`state.ts` wiring**: `ensurePoca()` lazy-constructs the engine; `ensureEpoch()` at cron entry;
  `appendDigest()` at cron exit; `onReset()` / `onManualTick()` / `onGenesisSeeded()` from matching handlers.
  DO storage adapter (`PocoStore` over `storage.get/put/delete`); chain hooks delegate to `economy.ts` →
  `x402.ts` facilitator delegators.
- **Five `/poca*` REST endpoints** (all free, keyless, CORS-open):
  `GET /poca` (snapshot + verdict), `GET /poca/epochs?limit=N`, `GET /poca/epoch/{i}`,
  `GET /poca/proof?epoch=&cron=`, `GET /poca/admin?limit=N`.
- **OpenAPI 3.1 schemas** (`openapi.ts`): `PocaSealedEpoch`, `PocaEpoch`, `PocaProof`, `PocaMerkleStep`,
  `PocaAdminEntry` — served verbatim at `/openapi.json`.
- **`poca.test.ts`** (+26 tests): in-memory `PocoStore` + stub `PocoChainHooks`; covers digest determinism,
  Merkle root/proof/verify round-trip, epoch open/seal lifecycle, admin-kind detection, DO-rebuild via tick
  regression, chain-across-epoch continuity, code-change forced seal.
- **`scripts/deploy-poca-auto.mjs`**: confirm-gated (`POCA_CONFIRM=1`) mainnet deploy of `ContinuityRegistry`;
  resolves the committer from TWO independent on-chain sources that must agree (`PredictionArena.resolver()` +
  the latest settlement proof's `tx.from`), dry-runs a gas estimate without it, and self-verifies the deployed
  immutables. **`scripts/poca-verify.mjs`** (`npm run verify:poca`): the standalone five-criterion CLI verifier
  (`--registry` / `--sample` / `--json` / `--selftest`).
  **Live on Arc mainnet**: `ContinuityRegistry` at `0x3f67b38030f2d709bafd2f7a3ee2388c35195b33` (deploy tx
  `0xd9ef64…dd16`, gas paid by `0x307D…3a0d`), committer = the Worker facilitator `0x2b9a…055c`; the address is
  the code default in `config.ts` (`pocaRegistryAddress`), so the on-chain epoch mirror arms on the next Worker
  deploy without any `wrangler.toml` var.
- **`MANIFEST_HASH` bypass hard gate** (`deploy-manifest-auto.mjs`): setting `MANIFEST_HASH` alone is no longer
  sufficient — also requires `MANIFEST_HASH_BYPASS_APPROVED=1`. Prevents accidental production deploys with a
  stale/incorrect manifest hash that would desync the on-chain commitment.
- **`npm run replay -- --flywire`** (`scripts/replay-brain.ts` FlyWire mode): offline full-behavioural replay
  that deterministically rebuilds every connectome from the committed FlyWire subgraph + seeds and verifies
  structural specs against the on-chain `manifestHash`. Covers PoCA criterion ④ at full-replay depth.
- **`docs/POCA.md`**: complete specification — naming rationale, problem statement, byte-level data structures,
  contract ABI, five-criterion verification algorithm, epoch semantics, trust-boundary disclosures, verifier
  usage, ERC-8004 integration path, cost model.
- **`SECURITY.md` §“Disclosed Centralization & Trust Assumptions”**: five items — PredictionArena resolver as
  trusted exitTemp oracle, WarCoffer one-way sunk pool, war-rail cap bypass, governance instant-balance
  weighting, ADMIN_TOKEN fail-open. Each with mitigation / discoverability / why-accepted.

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
- **Settlement netting (onchain)**: trades are folded per agent-pair into one signed **net** and only the net is
  broadcast — at most once per cron, above `ECONOMY_NET_MIN_BROADCAST`, with a forced flush every
  `ECONOMY_NET_FLUSH_TICKS`. Reciprocal trades cancel and dust carries forward, so real gas is amortised across
  many micropayments instead of one transaction per trade.
- **Long-term memory (Cloudflare D1)**: `FlyStateDO.archiveTick()` writes one row per cron (temperature, regime,
  deals, cumulative settlements/volume, gini, behaviour histogram) to the `murmur-db` D1 database, and a new
  `GET /history` endpoint serves the series plus a since-launch summary — backing the frontend's **swarm-history**
  drawer and research export.
- **Responsive frontend layout**: the four floating panels collapse into a single scrollable column on phones and
  narrow tablets, so the piece no longer crowds or overlaps on small screens.
- **`ADMIN_TOKEN` guard (optional secret)**: when set, the mutating `POST /tick` and `/reset` debug endpoints
  require it, so they can be locked down on a live deployment. The per-minute cron presents the token
  internally, so arming it never interrupts the scheduled tick.
- **Human-vs-swarm prediction ARENA (`MURMUR` token utility)**: a new `PredictionArena.sol` contract + `GET /arena`
  endpoint + frontend arena drawer let **MURMUR** holders bet the project's own token on the *same* Arc-temperature
  move the fly swarm bets — UP/DOWN into a **non-custodial, parimutuel** book the contract escrows and pays out
  itself. The Worker acts only as the **resolver**, committing each round's entry/exit temperature; the contract
  derives UP/DOWN/FLAT from the committed entry + flat band, so no operator can steer an outcome, and a live
  leaderboard compares the crowd's hit-rate against the flies'. Ships inert-by-default (`ARENA_ENABLED="false"`, no
  `ARENA_ADDRESS`) and in the keyless/simulated fallback; `arena.test.ts` (+19 tests, suite now **89**) pins the
  resolver's round-plan cursor — including the `cursorAfterOpen()` fresh-start baseline that stops a mid-stream first
  open from re-chasing an un-opened `prev` (which the contract reverts `NotOpened`, wasting gas each cron) — and the
  zero-regression gating. Deploy scripts `deploy-arena(-auto).mjs` are confirm-gated for mainnet (`ARENA_CONFIRM=1`).
  **Live on Arc mainnet**: `PredictionArena` at `0xaf1ae61e12c101d179a2f65a5f2e02e690968525` (deploy tx
  `0x187779a2…3f8c`, gas paid by `0x307D…3a0d`), resolver = the Worker facilitator `0x2b9a…055c` opening/resolving each
  hourly bucket; the production Worker runs `ARENA_ENABLED="true"`, first live round `497162` opened on-chain.

### Changed
- **Settlement batching parameters tuned** (first shipped in commit `c7b53f8`): `ECONOMY_NET_MIN_BROADCAST`
  raised `0.004 → 0.01` USDC and `ECONOMY_NET_FLUSH_TICKS` raised `30 → 360` sub-ticks (60 crons ≈ 1 h).
  **Motivation:** at the previous 0.004 threshold a broadcast's gas could exceed 50 % of face value; the new
  0.01 floor keeps gas a minority of every settlement. The flush window was extended so small reciprocal nets
  have time to cancel before a forced broadcast — reducing on-chain receipt density and total gas burn.
  **Impact:** (1) small-amount net broadcasts occur less frequently (dust accumulates longer before clearing the
  threshold); (2) on-chain receipt density decreases — expected and intentional; (3) any nonzero pending net is
  force-flushed after at most ≈1 h, bounding settlement latency.
- **Connectome scaled 10,800 → 30,800 neurons/fly** (`BRAIN_N_*` = `5200/11400/11400/1100/340×5`, `BRAIN_DENSITY`
  `0.002 → 0.0007` to hold fan-in linear at ~404k synapses/fly). Sharding moved to **one fly per isolate**
  (`SHARD_COUNT` `50 → 100`): a 30,800-neuron brain's deserialize peak is ~72 MB of the 128 MB isolate, so two
  per shard would leave no headroom for a bred offspring. The hatch budget's synapse factor was tightened
  (`state.ts` `HATCH_BUDGET_FACTORS` = 1.2× neurons / **1.4×** synapses, from the library default 2.0×) so no legal
  offspring can build a connectome that OOMs its isolate, and `GENOME_BOUNDS` were widened to let breeding reach
  the new genesis sizing. The on-chain brain-manifest identity rotates with the sizing, so the new `manifestHash`
  is re-committed to the existing `NeuralManifestRegistry`. Every persisted brain **fresh-wakes** on the first cron
  (the old 10,800-archive no longer matches the new layout) — on-chain lineage, genome and HD wallets are untouched.
- **Compact `v4` brain archive (base64 float32)**: `FlyBrain.serialize()` now packs the six per-neuron `Float32Array`s
  into one base64 blob instead of spelling every float out in decimal. It is **lossless** (the runtime state is
  already float32) and ~2.9× smaller — a 30,800-neuron brain serialises to ~963 KB, under the Durable Object 2 MB
  single-value cap that the `v3` text form (~2.1 MB) would breach. `deserialize()` reads both `v4` and legacy `v3`
  archives, and a size-mismatched archive still wakes the brain fresh. (+6 `fly-brain` tests.)
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
- **Raised the real-money caps to match the faster trade rate**: `ECONOMY_DAILY_CAP` 20 → **100** and
  `ECONOMY_PER_AGENT_DAILY_CAP` 2 → **10** (the kill switch and the per-deal cap are unchanged).
- **Removed the dead `fly.ai` WASM backend** — `wasm-backend.ts`, the `BRAIN_BACKEND` / `WASM_*` config and the
  `createFlyBrain` factory. It was never invoked at runtime (the population always builds the TypeScript LIF
  connectome) and its `wasm-mock` fabricated a 166,700-neuron count from random noise. `ts-lif` is now the single
  backend.
- **Repository audit**: docs reconciled with the deployed code (netting, D1 `/history`, the corrected cap values),
  a stale "read-only, no wallet" file-header comment corrected, and emoji stripped from the smoke test output.
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

### Hotfix batch — PoCA hardening & documentation alignment

Engineering-disclosure corrections applied after internal code review (issues 7, 9, 15, 20, 22, 24):

- **Mirror alignment check**: worker now reads on-chain `epochCount()` before every mirror call; misalignment
  pauses the mirror (`mirror.paused = true`) rather than risking a broken `prevEpochSeal` chain.
- **Atomic write discipline**: PoCA state mutations batched into single `storage.transaction` calls to prevent
  partial-write corruption on DO eviction.
- **Non-blocking mirror**: on-chain mirror calls moved off the critical cron path — failures are counted
  (`mirror.failures`) but never block the tick.
- **Admin kind bucketing**: kind-2 (`MANUAL_TICK`) demoted to local-log-only with 5-minute rate-limit merge;
  eliminates the unauthenticated `POST /tick` → on-chain spam amplification vector.
- **Verifier hardening**: CLI + browser verifiers now assert `tickCount == len(digests)` alongside the Merkle
  path check, closing the odd-tail duplication malleability (disclosed in `docs/POCA.md`).
- **`CODE_COMMITMENT` scope expanded**: now hashes `packages/trader-worker/src` + `packages/fly-brain/src` +
  FlyWire artifact sha256 + knob-default snapshot. Git HEAD removed from the hash (published separately via
  `GET /poca` for human correlation only).
- **Deploy-script safety**: `deploy-poca-auto.mjs` and `deploy-manifest-auto.mjs` enforce codegen-before-deploy
  and confirm-gate mainnet writes; `MANIFEST_HASH` bypass now requires a second explicit approval env var.
- **Documentation disclosures**: Merkle malleability + compensating controls, `openEpoch` prior-seal limitation
  + recovery path, settlement batching parameter rationale (`c7b53f8`), `SECURITY.md` ADMIN_TOKEN production
  status, naming alignment (`ContinuityRegistry` everywhere).

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
