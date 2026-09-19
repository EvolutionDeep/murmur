# murmur public API

A free, keyless, CORS-enabled **read-only** JSON window into a live autonomous economy: 24 fruit-fly
nervous systems (~10,800 spiking LIF neurons each) that decide what to buy and from whom, settling with
each other in **real USDC on Arc mainnet** over **x402 / EIP-3009**. No LLM anywhere in the loop.

- **Base URL:** `https://api.muros.live`
- **Chain:** Arc mainnet (`chainId 5042`)
- **Auth:** none — no API key, no account, no signing (except the one paid x402 endpoint)
- **CORS:** `Access-Control-Allow-Origin: *` on every response — call it straight from a browser
- **Format:** JSON (`application/json; charset=utf-8`)
- **Machine-readable contract:** [`GET /openapi.json`](https://api.muros.live/openapi.json) (OpenAPI 3.1)
- **Human docs (rendered live):** <https://muros.live/developers>

> This file mirrors the OpenAPI contract in [`packages/trader-worker/src/openapi.ts`](packages/trader-worker/src/openapi.ts),
> which is served verbatim at `/openapi.json` and rendered by the `/developers` page — so the deployed docs
> never drift from a hand-maintained copy. Treat `/openapi.json` as the source of truth for exact schemas.

---

## Quickstart

```bash
# what is murmur doing right now?
curl "https://api.muros.live/state"

# every fly's neural drives + the deal feed (the frontend feed)
curl "https://api.muros.live/population"

# the x402 agent economy: wallets, deals, totals
curl "https://api.muros.live/economy"

# the machine-readable API contract itself
curl "https://api.muros.live/openapi.json"
```

From the browser:

```js
const { snapshot } = await fetch("https://api.muros.live/population").then((r) => r.json());
console.log(snapshot.collective.regime, snapshot.flies.length); // e.g. "CALM" 24
```

---

## Conventions

- **Versioning.** Every path also answers under an optional `/v1` prefix — `/v1/population` is identical to
  `/population`. The prefix is the stable versioned surface; pin it if you want forward-compatibility guarantees.
- **Money.** `*Atomic`, `amount`, and `balance` fields are exact **integer strings** in the asset base unit
  (USDC has 6 decimals). `*Usdc` fields are convenience floats. **Do maths on the atomic strings**, not the floats.
- **Timestamps.** `ts` and `*At` are Unix **milliseconds** unless noted.
- **Ids.** Fly ids are stable, 0-based population indices `0..23`.
- **Caching.** Most live endpoints send `Cache-Control: no-store`; `/openapi.json` is cached `max-age=300`.
  Poll at a sensible cadence (a tick is ~1 minute, driven by the Worker cron).
- **Errors.** Every error uses one unified envelope (see below).

### Error envelope

```json
{ "error": "tx required", "code": "bad_request", "status": 400 }
```

| field    | type    | meaning                                                        |
| -------- | ------- | -------------------------------------------------------------- |
| `error`  | string  | Human-readable message (kept as a plain string for compatibility). |
| `code`   | string  | Stable machine-readable slug — branch on this, not the message. |
| `status` | integer | Mirrors the HTTP status code.                                   |

`code` is one of:

| `code`                 | typical status | when                                             |
| ---------------------- | -------------- | ------------------------------------------------ |
| `not_found`            | 404            | Unknown path, unknown fly id, or a disabled feature. |
| `bad_request`          | 400            | Missing/invalid required parameter (e.g. no `tx`). |
| `payment_required`     | 402            | The x402 paid endpoint was called without payment. |
| `forbidden`            | 403            | Admin-gated action without a valid token.         |
| `service_unavailable`  | 503            | A feature is not configured in this deployment.   |
| `internal_error`       | 500            | Unexpected server error.                          |

---

## Endpoints

### meta — service discovery

#### `GET /`
Service metadata + health + a navigation index of every endpoint.

Returns `{ ok, name, version, chain, apiVersion, openapi, docs, features[], endpoints[] }`.

#### `GET /openapi.json`
The OpenAPI 3.1 contract you are reading about. Fetch it to generate clients or render docs.
Cached `max-age=300`.

---

### swarm — the population's live neural state

#### `GET /state`
The cheapest "what is murmur doing right now" call: tick index, population vitality, the collective
neural mood, an economy summary, the current market temperature, and the resolved runtime config.

Returns `{ name, tickIndex, aliveCount, totalCount, vitality, collective, economy, market, lastCron, config }`.

#### `GET /market`
The last Arc whole-chain activity sample (tx/gas per block over a window), the EWMA baseline, and the
reduced **market temperature + regime** that drives the swarm's arousal.

Returns `{ market: { sample, temperature, regime, baselineTx, baselineGas }, meter, prevTemperature }`.
`regime` is one of `HOT | CALM | COLD`.

#### `GET /population`
The full per-tick snapshot the dashboard renders. This is the richest free endpoint.

Returns:
```jsonc
{
  "snapshot": {
    "tickIndex": 1234,
    "collective": { "temperature": 0.42, "regime": "CALM", "vitality": 1, "size": 24,
                    "arousal": 0.3, "cohesion": 0.5, "rest": 0.2, "wingbeat": 0.6,
                    "states": { "AGITATE": 2, "EXPLORE": 9, "AGGREGATE": 8, "REST": 5 } },
    "flies": [ { "id": 0, "state": "EXPLORE", "arousal": 0.3, "turnBias": 0.1,
                 "cohesion": 0.5, "wingbeat": 0.6, "rest": 0.2,
                 "temperament": 0.44, "fingerprint": "a1b2c3" } /* …24 total */ ]
  },
  "economy":  { "lastTick": [ /* Trade[] */ ], "totals": { /* EconTotals */ },
                "balances": { "0": "1500000", "1": "980000" /* flyId → atomic USDC */ } },
  "topology": { "sharded": true, "shardCount": 12, "populationSize": 24,
                "fliesPerShard": 2, "shards": [ { "index": 0, "start": 0, "end": 1 } /* … */ ] }
}
```

#### `GET /history`
The D1 long-term archive — one row per cron tick. Use for time-series analysis.

| query   | type    | default | meaning                                   |
| ------- | ------- | ------- | ----------------------------------------- |
| `limit` | integer | `100`   | Max rows to return (≥ 1).                 |
| `before`| integer | —       | Return rows with `tick < before` (cursor).|
| `order` | string  | `desc`  | `asc` or `desc` by tick.                  |

Returns `{ enabled, order, count, summary, rows[] }`; each row is
`{ tick, ts, temperature, regime, size, deals, settlements, volumeUsdc, gini, topState, topStates }`.

```bash
curl "https://api.muros.live/history?limit=50&order=desc"
```

#### `GET /snapshot?flyId=N`
The complete per-neuron arrays for one fly. **Large** (~600 KB in production, 10,800 neurons) — fetch sparingly.

| query   | type    | required | meaning                    |
| ------- | ------- | -------- | -------------------------- |
| `flyId` | integer | yes      | The 0-based fly index `0..23`. |

Returns `{ flyId, seed, temperament, t, step, firingRates[], membrane[], spikesLastStep[],
motor[], neuronKinds[], neuronChannels[], neuronCount, agent }`.

#### `GET /flies/{id}`
A lightweight per-fly view (vitals + decoded behaviour + motor channels + agent wallet).

| path | type    | meaning                    |
| ---- | ------- | -------------------------- |
| `id` | integer | The 0-based fly index `0..23`. |

Returns `{ vitals: { id, seed, temperament }, behavior: { state, arousal, turnBias, cohesion,
wingbeat, rest, fingerprint }, motor[], agent, t, step }`.

```bash
curl "https://api.muros.live/flies/7"
```

---

### economy — the x402 agent economy

#### `GET /economy`
The authoritative economy view: every agent wallet, the recent + last-tick deal feeds, the settlement
scheme/network/asset, and cumulative totals.

Returns `{ tickIndex, mode, scheme, network, asset, x402Version, agents[], lastTick[], recent[], totals }`
where each **agent** is `{ id, address, balance, balanceUsdc, paid, earned, deals, sales }` and each
**trade** is `{ tick, ts, good, resource, fromId, toId, from, to, amount, txHash, valid, reason, simulated }`.

**`totals` (EconTotals):** `{ volumeAtomic, volumeUsdc, count, liveAgents, meanBalanceUsdc, gini,
treasuryOutAtomic, richestId, poorestId }` — only mined, on-chain settlements count.

#### `GET /leaderboard`
Agents ranked by net PnL (`earned − paid`) in USDC, plus cumulative totals and the paid `/signal/pulse`
revenue summary.

Returns `{ enabled, mode, network, asset, registryAddress, rows[], totals, pulse }`; each row is
`{ id, address, netUsdc, earnedUsdc, paidUsdc, balanceUsdc, deals, sales }`.

---

### provenance — trustless on-chain proof

Two independent anchors let you verify murmur **without trusting us**. Both are live on Arc mainnet.

#### `GET /manifest`
The swarm's **brain manifest** + its sha256 identity + the on-chain registry it is committed to.

Returns `{ manifestHash, registryAddress, chainId, chainTag, manifest }`.

The `manifest` commits everything needed to reproduce all 24 connectomes offline: the generator sizing,
the seed formula (`seed[i] = (seedBase + i * seedStride) >>> 0`), the LIF constants, the motor-decoder
config, honest FlyWire provenance, the no-LLM declaration, and each fly's quantised **structural spec**
(`neuronCount`, `synapseCount`, `byKind`, `edgeHash`, integer checksums…).

**Verify trustlessly — all three must agree:**
1. Recompute `sha256(canonical(manifest))` yourself → compare to `manifestHash`.
2. `eth_call latestHash()` on `registryAddress` (Arc mainnet) → compare to `manifestHash`.
3. Rebuild every connectome from the committed seeds (see `/manifest/replay`, or `npm run replay`).

Production anchor (schema v1, population 24):
```
manifestHash    0x403551bb4ed89402632e2e3c9c3abec3883e84b27931be78928e2f100f6efc02
registry        0x3412eb909252adb983aaf793f97a3754ca029a37   (NeuralManifestRegistry, Arc mainnet)
```

#### `GET /manifest/replay`
Server-side offline replay: rebuilds all 24 connectomes from the manifest's committed seeds and re-derives
each structural spec. `ok: true` with empty `mismatches` proves the brains are exactly what those seeds
deterministically generate. This is the same check the offline CLI and the frontend run independently.

Returns `{ manifestHash, ok, checked, mismatches[] }`.

#### `GET /proofs`
The **neural-receipt hash chain** — the last 64 settlement receipts. Each real net settlement freezes the
buyer/seller neural read-outs into a receipt; `receiptHash = sha256(canonical(receipt))` is used as the
EIP-3009 nonce and hash-chained via `prevChain`. `chainHead` is the latest link, mirrored on-chain in the
NeuralReceiptRegistry.

Returns `{ enabled, ipfsGateway, version, policy, chainHead, count, proofs[] }`; each proof is
`{ txHash, receiptHash, receipt, ts }`.

#### `GET /proofs/verify?tx=0x…`
Verify one settlement's neural origin on-chain: reads its EIP-3009 nonce, recomputes the receipt hash, and
reports whether they match plus whether the receipt is committed / is-head in the registry.

| query | type   | required | meaning                        |
| ----- | ------ | -------- | ------------------------------ |
| `tx`  | string | yes      | The settlement tx hash (`0x…`).|

Returns `{ found, txHash, selfConsistent, match, registry }`.

---

### lineage — the connectome breeding market

Every connectome's complete heritable identity is its **genome**: the effective generator parameters
(`seed` + per-layer neuron counts + `density`) that deterministically rebuild the exact brain offline.
`genomeHash = sha256(canonical(genome))`. The 24 base-population brains are generation-0 **genesis** roots;
breeding applies pure genetic operators — **mutate** (one parent) or **cross** (two parents) — and records
each offspring's ancestry. Because the operators are pure in `(parents, rngSeed)`, anyone can re-derive an
offspring from its recorded fields, and when the `ConnectomeLineage` contract is deployed the ancestry is a
public, tamper-evident fact on Arc.

#### `GET /lineage`
The whole family tree: every committed genome + its ancestry. Read-only, keyless, CORS-open.

| query     | type    | required | meaning                                              |
| --------- | ------- | -------- | ---------------------------------------------------- |
| `gen`     | integer | no       | Only this generation (`0` = genesis roots).          |
| `op`      | string  | no       | Only this operator: `genesis` \| `mutate` \| `cross`. |
| `breeder` | string  | no       | Only offspring credited to this address (`0x…`).     |
| `limit`   | integer | no       | Max entries returned, newest first (default `500`).  |

Returns `{ lineageAddress, chainId, count, genesis, bred, generations, matching, returned, entries[] }`,
where each entry is a `LineageEntry`:
`{ genomeHash, genome, parents[], op, generation, breeder, rngSeed, ts, commitTx }`.

#### `GET /lineage/{hash}`
One individual: its full **genome body** (rebuild the exact connectome offline), its parents + children (the
local family tree), the `StructuralSpec` re-derived from that genome, and — when the contract is wired — its
committed ancestry read straight off Arc.

Returns `{ lineageAddress, chainId, entry, children[], fertility, spec, onchain }`.

#### `GET /lineage/verify?hash=0x…`
The trustless check, run server-side for convenience: recompute `sha256(canonical(genome))` from the served
genome body (`hashOk`), rebuild the connectome and re-derive its spec (`specOk`), and — when wired — confirm
the ancestry is committed on Arc and agrees with the served `op`/`generation` (`chainOk`).

| query  | type   | required | meaning                                  |
| ------ | ------ | -------- | ---------------------------------------- |
| `hash` | string | yes      | The `genomeHash` to verify (`0x…`).      |

Returns `{ genomeHash, pass, checks: { hashOk, specOk, chainOk, committed }, generation, op, spec, onchain }`.
You can run the identical check offline from `GET /lineage/{hash}` alone — no murmur server in the trust path.

---

### predictions — the on-chain prediction market + arena

#### `GET /predictions`
The open temperature-prediction round (entry temperature, momentum, parimutuel up/down pools + odds),
recently resolved rounds (with receipt hashes), and the per-agent hit-rate/PnL leaderboard.

Returns `{ mode, registryAddress, enabled, network, config, open, recent[], leaderboard[], totals }`.

#### `GET /predictions/verify?round=N`
Recompute a resolved round's receipt hash + read its on-chain commitment.

| query   | type    | required | meaning             |
| ------- | ------- | -------- | ------------------- |
| `round` | integer | yes      | The round id.       |

Returns `{ round, receiptHash, registry: { committed, isHead }, selfConsistent, match }`.

#### `GET /arena`
The human-vs-swarm **MURMUR arena**: current + previous hourly rounds (pools denominated in MURMUR, odds,
deadlines), the swarm's own betting record, and the resolver/contract addresses. Humans and the swarm bet
on the same temperature outcome.

Returns `{ enabled, network, chainId, token, arenaAddress, resolver, roundLenSec, flatBand, staleGraceSec,
armed, current, previous, swarm, state }`.

---

### signal — the one paid endpoint (x402)

Everything above is **free**. The single exception is the machine-readable Arc-activity signal, sold over
**x402**.

#### `GET /signal/requirements` (free)
The EIP-712 domain + x402 requirements a caller signs to purchase the pulse: `payTo`, price (atomic + USDC),
asset, resource, timeout.

Returns `{ enabled, mode, network, chainId, asset, payTo, priceUsdc, priceAtomic, maxUsdc,
maxTimeoutSeconds, eip712, requirements }`.

#### `GET /signal/pulse` (paid)
- **Without payment:** answers `402 Payment Required` with a `PAYMENT-REQUIRED` header carrying the x402
  requirements (also readable free at `/signal/requirements`); the body mirrors them.
- **With payment:** attach a browser-signed EIP-3009 `X-PAYMENT` header to settle in USDC and receive the
  signal. The Worker acts as a **relay facilitator and never holds your keys**.

```bash
# 1. read the requirements (free)
curl "https://api.muros.live/signal/requirements"

# 2. call unpaid → 402 with the requirements echoed
curl -i "https://api.muros.live/signal/pulse"

# 3. sign an EIP-3009 X-PAYMENT in your wallet, then:
curl "https://api.muros.live/signal/pulse" -H "X-PAYMENT: <base64-payment>"
```

---

## Shared schemas

- **Collective** — `{ temperature, regime, vitality, size, arousal, cohesion, rest, wingbeat, states }`.
- **Fly** — `{ id, state, arousal, turnBias, cohesion, wingbeat, rest, temperament, fingerprint }`.
- **Agent** — `{ id, address, balance, balanceUsdc, paid, earned, deals, sales }`.
- **Trade** — `{ tick, ts, good, resource, fromId, toId, from, to, amount, txHash, valid, reason, simulated }`.
- **EconTotals** — `{ volumeAtomic, volumeUsdc, count, liveAgents, meanBalanceUsdc, gini, treasuryOutAtomic, richestId, poorestId }`.
- **StructuralSpec** — `{ neuronCount, synapseCount, byKind, motorChannels, sensoryChannels, tauMicro,
  threshMicro, weightMilli, fanInMeanMilli, fanInMax, edgeHash }`.
- **BrainManifest** — the committed generator + seeds + LIF + decoder + provenance + per-fly StructuralSpec.

Full field-level definitions live in [`/openapi.json`](https://api.muros.live/openapi.json) under
`components.schemas`.

---

## Not part of the public surface

These exist but are intentionally **undocumented / gated** — do not build on them:

- `POST /stimulus` — poke the swarm (public but not a read endpoint; behaviour may change).
- `POST /breed` — apply a genetic operator to committed parents and record the offspring in the lineage;
  `ADMIN_TOKEN`-gated (`403 forbidden` without it). Breeding mutates the store, so it is operator-only for now
  (a future x402 paywall may front it). Body: `{ op: "mutate"|"cross", parents: [hash(,hash)], rngSeed?, breeder? }`.
- `POST /tick`, `POST /reset` — debug, `ADMIN_TOKEN`-gated (`403 forbidden` without it).

---

## Links

- Live docs: <https://muros.live/developers>
- OpenAPI contract: <https://api.muros.live/openapi.json>
- Source: <https://github.com/EvolutionDeep/murmur>
- X: [@murmur_arc](https://x.com/murmur_arc)
