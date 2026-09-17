# Architecture

murmur is a monorepo (npm workspaces, Node ≥ 20) that turns whole-chain activity on **Arc** into a
**market temperature**, drives a population of **LIF-neuron fruit flies** with it, and lets those flies
settle with each other in **USDC** over **x402**. It runs entirely on the Cloudflare edge.

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
  ├── Population     (src/population.ts) 24 × FlyBrain (@fly/fly-brain)
  ├── AgentEconomy   (src/economy.ts)    drives → intent → x402 settlement
  │     └── x402     (src/x402.ts)       SimulatedFacilitator (default) | OnChainFacilitator (opt-in)
  │           └── keys (src/keys.ts)     HD wallet derivation — ONLY used onchain
  └── stimulus       (src/stimulus.ts)   visitor "poke the swarm", rate-limited
            │
            ▼  REST/JSON  (api.muros.live)
Frontend · Cloudflare Pages (murmur-4sx.pages.dev) — generative canvas + per-fly inspector
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
4. **Spike** (`@fly/fly-brain`). Each fly advances its ~1,080-neuron LIF network independently for
   `SIM_STEPS_PER_TICK` (500) ms.
5. **Decode, peer-relative** (`motor-decoder.ts`). Read each fly's motor firing rates → raw drives
   (arousal / turn / cohesion / rest), compute the population bands (robust 10–90 percentiles) for this tick, and
   decode each fly **relative to its peers** with the temperature as the collective anchor → a `FlyBehavior`
   (`state` ∈ AGITATE / EXPLORE / AGGREGATE / REST + continuous drives + a neural fingerprint).
6. **Settle** (`economy.ts`, when `ECONOMY_ENABLED`). Translate drives into an economic intent and run the x402
   flow between buyer and seller. This is a strict **read-out** of the neural layer — it never feeds back into
   the connectome (see [NEURAL-SIM.md](./NEURAL-SIM.md) on the winner-take-all latch).
7. **Persist + serve**. Store state; `/population`, `/market`, `/economy`, `/snapshot` expose it to the frontend.

---

## Chain access is read-only by default

`chain.ts` builds a viem `publicClient` (with fallback transport) that only **reads** Arc. Arc specifics baked in:

- **Native gas token is USDC.** The *native* layer (`eth_getBalance`, `msg.value`) uses **18 decimals**, while the
  *ERC-20* USDC contract uses **6** (offset 12). Never add a native amount to an ERC-20 amount.
- **`block.prevrandao` is always `0x000…000`** on Arc → on-chain randomness is dead; anything needing entropy seeds
  from the block number + a per-fly seed.
- **Sub-second blocks with repeated timestamps** → always window by block **number**, never by timestamp.
- **Deterministic finality** → no reorg handling.

A `walletClient` exists at the bottom of `chain.ts` but is **only** built by the opt-in onchain x402 facilitator;
the default simulated economy never constructs it. See [AGENT-ECONOMY.md](./AGENT-ECONOMY.md).

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
| `GET` | `/snapshot?flyId=N` | One fly's full neural state (firing rates, spikes, neuron kinds) + its wallet |
| `GET` | `/flies/:id` | One fly's drives, behaviour and vitals |
| `GET` | `/stimuli` | Recent visitor-stimulus history |
| `POST` | `/stimulus` | Poke the swarm (`food/threat/light/dark`, walletless, `clientId` + cooldown) |
| `POST` | `/tick` | Debug: run one cron tick now |
| `POST` | `/reset` | Debug: fresh founding population + re-funded simulated wallets |

---

## Frontend

A dependency-free static site (`packages/frontend/public`, deployed to Cloudflare Pages). A single Canvas 2D loop
renders the swarm; the whole palette warms/cools with the market temperature. It polls `/population` (and
`/economy`) and, when a fly is selected, reads `/snapshot` at a slow guarded cadence to draw that fly's **neural
bloom** and **spike raster** and show its x402 wallet. The render loop is self-healing and adaptively sheds its
heaviest layers under frame-budget pressure, and pointer input is click-storm throttled, so rapid interaction can
never stall the tab. If the Worker is unreachable, an offline circuit-breaker runs the piece purely locally.
