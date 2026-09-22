# Architecture

murmur is a monorepo (npm workspaces, Node ≥ 20) that turns whole-chain activity on **Arc** into a
**market temperature**, drives a population of **LIF-neuron fruit flies** with it, and lets those flies
settle with each other in **real USDC** over **x402**. It runs entirely on the Cloudflare edge, and the
production deployment is **LIVE** — it broadcasts genuine EIP-3009 transfers on Arc mainnet, each with a
transaction hash you can verify on the Arc explorer.

```
packages/
  fly-brain/       the neural core (no I/O, no chain): LIF network, connectome, motor decoder, stimuli
  trader-worker/   the Cloudflare Worker + Durable Object: market, population, economy, x402, keys
  frontend/        the static generative dashboard (vanilla JS + Canvas 2D) on Cloudflare Pages
```

---

## Runtime topology

```
Cloudflare Worker "murmur"  (src/index.ts)
  ├── fetch()      → CORS + /health, then forwards everything to the Durable Object
  └── scheduled()  → cron "* * * * *" → POST /tick into the DO
            │
            ▼
Durable Object  FlyStateDO  (src/state.ts, singleton id "fly-main", SQLite storage class)
  ├── MarketMeter   (src/market.ts)     Arc blocks → temperature + regime
  ├── Population     (src/population.ts) founders 24 · breeds to 48 (@fly/fly-brain)
  ├── AgentEconomy   (src/economy.ts)    drives → intent → x402 settlement → per-pair netting
  │     └── x402     (src/x402.ts)       OnChainFacilitator (LIVE, production) | SimulatedFacilitator (keyless dev)
  │           └── keys (src/keys.ts)     HD wallet derivation — ONLY used onchain
  ├── D1 archive     (schema.sql)        one row per cron → GET /history (best-effort; never blocks a tick)
  └── stimulus       (src/stimulus.ts)   visitor "poke the swarm", rate-limited
            │
            ▼  REST/JSON  (api.muros.live)
Frontend · Cloudflare Pages (www.muros.live) — generative canvas + per-fly inspector + all-agent wallet roster
```

**Why a Durable Object.** The whole population, the market baseline and the economy ledger must share one
consistent, single-threaded state that survives isolate evictions. A singleton DO (`fly-main`) with the SQLite
storage class holds that state; every HTTP request and every cron tick is funnelled through it, so there are no
races. Brains are persisted via `serialize()/deserialize()` so the swarm keeps its dynamics across restarts.

---

## The tick (once per minute)

`scheduled()` posts `/tick` into the DO, which advances the whole system `TICKS_PER_CRON` (6) sub-ticks:

1. **Observe Arc** (`market.ts`). Sample the most recent `MARKET_SAMPLE_BLOCKS` (16) blocks **by number**
   (Arc repeats timestamps, so time windows lie). Reduce them to mean transactions/block and mean gasUsed/block.
2. **Derive temperature** (`MarketMeter`). Compare the current throughput against a slow **EWMA baseline**
   (`MARKET_EWMA_ALPHA` 0.08, cold-start adaptive) that learns the chain's recent "normal"; map the
   current/baseline ratio through a **logistic curve** (`MARKET_GAIN` 3.0) to a temperature in (0,1):
   `ratio = 1 → 0.5 (CALM)`, `> 1 → →1 (HOT)`, `< 1 → →0 (COLD)`. Regime thresholds: `REGIME_HOT` 0.66,
   `REGIME_COLD` 0.33. The baseline auto-calibrates to whichever network is configured.
3. **Feel it** (`population.ts`). Build a `MarketPulse` (temperature + facets: momentum, turbulence, density,
   richness). Every fly receives the **same** pulse through its sensory channels **plus its own** stable internal
   arousal (its *temperament*, derived from its seed) so individuals keep a tempo. A pending visitor stimulus, if
   any, rides on top.
4. **Spike** (`@fly/fly-brain`). Each fly advances its **10,800-neuron** LIF network (production sizing; the
   library default is 1,080) independently for
   `SIM_STEPS_PER_TICK` (500) ms.
5. **Decode, peer-relative** (`motor-decoder.ts`). Read each fly's motor firing rates → raw drives
   (arousal / turn / cohesion / rest), compute the population bands (robust 10–90 percentiles) for this tick, and
   decode each fly **relative to its peers** with the temperature as the collective anchor → a `FlyBehavior`
   (`state` ∈ AGITATE / EXPLORE / AGGREGATE / REST + continuous drives + a neural fingerprint).
6. **Settle** (`economy.ts`, when `ECONOMY_ENABLED`). Translate drives into an economic intent and run the x402
   flow between buyer and seller. This is a strict **read-out** of the neural layer — it never feeds back into
   the connectome (see [NEURAL-SIM.md](./NEURAL-SIM.md) on the winner-take-all latch). On-chain, each trade is
   folded into its pair's running **net**; one `flush()` at the end of the cron broadcasts only the nets that
   cleared `ECONOMY_NET_MIN_BROADCAST` (or aged past `ECONOMY_NET_FLUSH_TICKS`), so real gas is amortised over
   many micropayments instead of one transaction per trade.
7. **Persist, archive + serve**. Store state in the DO, archive one summary row to **D1** (`archiveTick`,
   best-effort — a D1 failure never blocks the tick), and serve `/population`, `/market`, `/economy`, `/history`
   and `/snapshot` to the frontend.

---

## Chain access — read for temperature, write for settlement (LIVE)

`chain.ts` builds a viem `publicClient` (a rotating multi-provider RPC pool, each request timeout-bounded) that **reads** Arc for the market temperature,
and — in the production onchain economy — a `walletClient` that **writes** real EIP-3009 USDC transfers. Arc
specifics baked in:

- **Native gas token is USDC.** The *native* layer (`eth_getBalance`, `msg.value`) uses **18 decimals**, while the
  *ERC-20* USDC contract uses **6** (offset 12). Never add a native amount to an ERC-20 amount.
- **`block.prevrandao` is always `0x000…000`** on Arc → on-chain randomness is dead; anything needing entropy seeds
  from the block number + a per-fly seed.
- **Sub-second blocks with repeated timestamps** → always window by block **number**, never by timestamp.
- **Deterministic finality** → no reorg handling.

The `walletClient` at the bottom of `chain.ts` is built by the **`OnChainFacilitator`**, which is what the
production deployment runs (`ECONOMY_FACILITATOR="onchain"`, `ECONOMY_SHADOW="false"`): each buyer signs an
EIP-3009 `transferWithAuthorization` and the facilitator relays it on-chain. The keyless `SimulatedFacilitator`
(a fresh checkout with no `ECONOMY_MNEMONIC`) never constructs it. See [AGENT-ECONOMY.md](./AGENT-ECONOMY.md).

---

## HTTP endpoints

Served by the DO (the Worker adds CORS and the `/health` index). All responses are JSON.

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/` · `/health` | Liveness + name/version/chain + endpoint index |
| `GET` | `/state` | Tick, population size, config, counters |
| `GET` | `/population` | Collective mood + per-fly drives + economy summary (the frontend feed) |
| `GET` | `/market` | Latest Arc sample → temperature / regime / baselines |
| `GET` | `/economy` | Agent wallets + x402 settlement ledger + totals + facilitator mode |
| `GET` | `/history` | D1 long-term archive: one row per cron + a since-launch summary (`limit` / `before` / `order`) |
| `GET` | `/snapshot?flyId=N` | One fly's full neural state (firing rates, spikes, neuron kinds) + its wallet |
| `GET` | `/flies/:id` | One fly's drives, behaviour and vitals |
| `GET` | `/stimuli` | Recent visitor-stimulus history |
| `POST` | `/stimulus` | Poke the swarm (`food/threat/light/dark`, walletless, `clientId` + cooldown) |
| `POST` | `/tick` | Debug: run one cron tick now |
| `POST` | `/reset` | Debug: fresh founding population + re-founded agent wallets |

---

## Frontend

A dependency-free static site (`packages/frontend/public`, deployed to Cloudflare Pages). A single Canvas 2D loop
renders the swarm; the whole palette warms/cools with the market temperature. It polls `/population` (and
`/economy`) and, when a fly is selected, reads `/snapshot` at a slow guarded cadence to draw that fly's **neural
bloom** and **spike raster** and show its own USDC wallet. An **all-agent wallet roster** (the right-side drawer)
lists every fly's on-chain address and balance and opens any one of them, and the live settlement ledger links
each real transaction hash straight to the Arc explorer. The render loop is self-healing and adaptively sheds its
heaviest layers under frame-budget pressure, and pointer input is click-storm throttled, so rapid interaction can
never stall the tab. If the Worker is unreachable, an offline circuit-breaker runs the piece purely locally.

---

## Testing

Four CI gates run on every push/PR, all keyless and chain-free: `typecheck → test → build → smoke`.

```bash
npm test          # 372 unit tests across the three packages (node:test, run via tsx)
npm run smoke     # end-to-end neural smoke: grow brains, spike, decode, settle
```

| Suite | Package | What it pins down |
|---|---|---|
| `connectome.test.ts` | fly-brain | The graph is the documented ~1,080-neuron laminar **downsample of FlyWire** (~138k n / ~5M syn) at the library **default** sizing (production overrides `BRAIN_N_*` to 10,800): layer sizes + order, sparse fan-in, excitatory feedforward, **mutually-inhibitory** L2 left↔right (the winner-take-all), ipsilateral leg projections, the gustatory→proboscis reflex, and deterministic-per-seed / distinct-across-seeds wiring. |
| `lif.test.ts` | fly-brain | Resting leak, threshold→spike→reset, the refractory blackout, one-step-delayed weighted synaptic propagation (excitatory **and** inhibitory), and **spike-frequency adaptation** — the fatigue current that provably reduces sustained firing so the WTA alternates instead of hard-latching. Plus exact `toJSON`/`fromJSON` round-trip. |
| `motor-decoder.test.ts` | fly-brain | The two-layer read-out: HOT→aroused/dispersed vs COLD→huddled/restful collective base, population-relative individual spread, `[0,1]`/`[−1,1]` clamping, regime selection through hysteresis, robust 10–90 percentile bands, and fingerprint determinism. |
| `economy.test.ts` | trader-worker | The economy is a strict **one-directional read-out** — a frozen neural input is provably bit-for-bit unchanged after a settlement round (no feedback into the connectome). Plus behaviour→good mapping, buyer/seller value transfer, money conservation, the solvency floor, full determinism, and the per-agent wallet roster. |

Tests run under [`tsx`](https://github.com/privatenumber/tsx) because Node's native type-stripping does not resolve
the packages' `.js`→`.ts` import specifiers. They are excluded from the published builds (`tsconfig.build.json` /
the worker's `exclude`) so no test file ever ships to `dist`. There is **no live-chain or funded-wallet test** on
purpose: CI must stay keyless and reproducible, so real settlement is proven out-of-band in `ECONOMY_SHADOW="true"`
against live chain state (see the go-live runbook in [AGENT-ECONOMY.md](./AGENT-ECONOMY.md)).

---

## Design boundaries (honest scale & scope)

murmur is a **deliberately small, single-instance, artwork-grade system**, not a horizontally-scalable agent
runtime. The constraints below are choices, documented so nobody mistakes them for oversights:

- **One Durable Object singleton (`fly-main`), one cron tick per minute.** The entire population, market baseline
  and economy ledger share a single single-threaded state, so there are never races. That is the right shape for a
  swarm of 24–256 flies that must stay globally consistent, but it is **exhibition scale by design**: it does not
  shard and is not meant to run thousands of independent agents. Minute-granularity cron is Cloudflare's smallest,
  so the piece breathes once a minute — that cadence *is* the artwork.
- **The economy is a one-directional read-out of the neural layer — money never feeds back into the connectome.**
  A fly's spikes decide what it buys; its balance never changes how it spikes. This keeps the biology honest (the
  connectome is driven by sensory input and internal dynamics alone, not by a wallet) and the economics
  auditable. `economy.test.ts` **enforces** this as an invariant (a frozen neural input must survive a settlement
  round bit-for-bit). It is not a missing feedback loop.
- **The frontend is a dependency-free vanilla-JS Canvas 2D page — intentionally.** No framework, no build step, no
  virtual DOM: one self-healing render loop that polls the Worker and adaptively sheds its heaviest layers under
  frame-budget pressure. It is a *viewer* of the live system (swarm, per-fly inspector, all-agent wallet roster,
  explorer-linked tx hashes), not an interactive data app, and its offline mode is graceful degradation, never the
  source of truth.
- **The neural core is a hand-written TypeScript LIF network**, a ~130× downsample of FlyWire — enough to exhibit
  real winner-take-all, adaptation and reflex dynamics on the edge, not a claim to reproduce a full fly brain. It
  is pure TypeScript, with no native or WASM dependency.

Scaling any of these — sharding the DO, closing the economic→neural loop, a framework frontend, a full-resolution
connectome — would change what the piece *is*. They are out of scope on purpose.
