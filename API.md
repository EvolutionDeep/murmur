# murmur public API

A free, keyless, CORS-enabled **read-only** JSON window into a live autonomous economy: a breeding population of
fruit-fly nervous systems (24 founders, live roster capped at 100; every fly runs the same **literal FAFB_783 FlyWire MB+CX connectome — 10,361 neurons / 467,314 neurotransmitter-signed synapses** (Eckstein et al. 2024, CC-BY 4.0), committed on-chain as manifestHash `100712db…ef9c`; each genome only parameterizes synaptic weights and neuromodulatory traits on that fixed anatomy) that decide what to buy and from whom, settling with
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
The complete per-neuron arrays for one fly. **Large** (≈0.5 MB per live fly — 10,361 FlyWire-literal neurons) — fetch sparingly.

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

### war — colony war & taxation (on-chain escrow)

#### `GET /war`
The live colony-war read-out: whether war is armed, the `WarCoffer` contract + treasury/resolver addresses, the
cadence / stake / threshold knobs, every house's on-chain vault + capital share + power, the aggregate commons
purse and escrow, and the current open/resolved war plus pairs in cooldown. Inert (`{enabled:false}`) until
`WarCoffer` is deployed and `WAR_ENABLED` is on.

Returns `{ enabled, network, chainId, usdc, cofferAddress, treasury, resolver, warCadenceSec, stakePct,
minVaultUsdc, perWarCapUsdc, maxEscrowUsdc, feudThreshold, taxPct, taxDest, armed, houses[], stats, wars[], state }`.

---

### chronicle — the deterministic annals (provably no-LLM)

#### `GET /annals`
The swarm's generated history: chronicle volumes + entries rendered from public templates and folded into a
SHA-256 hash chain, plus the chronicler rules hash ("the historian's genome") for offline verification.

#### `GET /annals/verify`
Re-walk the hash chain from genesis and re-render every entry from its tokens → PASS/FAIL, proving the annals
were produced by the deterministic chronicler, not an LLM.

---

### governance — the token-gated community forum

#### `GET /community`
Browse the off-chain weighted-voting forum free; posting / proposing / voting require a MURMUR-holding wallet
signature (EIP-712). Sub-endpoints for posts, proposals and votes live under `/community/…`.

---

### poca — Proof of Continuous Agency

The PoCA endpoints expose the live continuity chain: per-cron state digests folded into ~24h epochs, each
sealed with a Merkle root and anchored on-chain via the `ContinuityRegistry`. See [**docs/POCA.md**](./docs/POCA.md)
for the full specification.

#### `GET /poca`
The live PoCA state + continuity verdict. Free, keyless, CORS-open.

Returns:
```jsonc
{
  "enabled": true,                   // true when the on-chain registry mirror is armed (address non-zero)
  "codeCommitment": "2bd01a…",       // sha256 over src trees + FlyWire artifact + knob defaults (64-hex; git HEAD NOT included)
  "gitCommit": "ff2450a…",           // the git commit this build was generated from
  "registryAddress": "0x…",          // ContinuityRegistry address (zero ⇒ disabled)
  "currentEpoch": 3,                 // open epoch index (null before the first open)
  "epochState": {                    // live open-epoch state (null when none)
    "openTs": 1727500000000,         // Unix ms the epoch started
    "digestCount": 842,              // cron digests folded so far this epoch
    "head": "a3f1…"                  // latest cron digest in this epoch
  },
  "chainHead": "a3f1…",             // the global latest cron digest (poca:head)
  "epochCount": 4,                   // closed + open epochs
  "adminCount": 2,                   // admin-discontinuity entries recorded
  "continuity": "unbroken",          // "unbroken" | "pending" | "disabled"
  "mirror": {                        // on-chain ContinuityRegistry mirror health
    "aligned": true,                 // true when the open epoch is successfully mirrored (openTxHash present); false while a mirror open is pending/retrying
    "failures": 0,                   // cumulative mirror-call failures since worker start (monotonic, never reset)
    "paused": false,                 // true ⇒ mirror suspended; auto-cleared on next successful alignment check
    "lastMirrorTs": 1727500060000    // Unix ms of last successful on-chain call (null if never)
  },
  "commitmentInputs": {              // non-secret summary for offline recompute
    "treeHash": "f825ce3f344c51c37838e96c7eeb26e3052fe7d6c4481bf7cc642b318129036f",
    "fileCount": 115,
    "knobCount": 21,
    "artifactHash": "dc84edfc2cd6cc6a0fcba671e2bd265423cfd7905e5d0e19bd183925c4377544"
  }
}
```

#### `GET /poca/epochs`
Sealed-epoch records, most recent first. The currently-open epoch is NOT included (read it from `GET /poca`
or `GET /poca/epoch/{i}`).

| query   | type    | default | meaning                                       |
| ------- | ------- | ------- | --------------------------------------------- |
| `limit` | integer | `100`   | Max sealed epochs to return (1–500).           |

Returns `{ epochs[], count }` where each epoch is a `PocaSealedEpoch`:
```jsonc
{
  "index": 2,
  "openTs": 1727400000000,           // Unix ms opened
  "endTs": 1727486400000,            // Unix ms sealed
  "tickCount": 1440,                 // cron digests in this epoch
  "merkleRoot": "7f3a…",            // 64-hex Merkle root
  "sealedHead": "b2c4…",            // last cron digest (ZERO64 if sealed empty)
  "genesisHead": "a1f0…",           // proof-chain head at epoch open
  "codeCommitment": "2bd01a…",      // CODE_COMMITMENT this epoch opened under
  "reason": "threshold",             // "threshold" | "reset" | "code-change"
  "codeChangeAdminTs": null,          // Unix ms of the kind-7 CODE_CHANGE admin entry that triggered rotation (null when reason != "code-change")
  "openTxHash": "0x…",              // on-chain openEpoch tx (when armed)
  "txHash": "0x…"                   // on-chain sealEpoch tx (when armed)
}
```

#### `GET /poca/epoch/{i}`
One epoch (open, sealed, or unknown) by index.

| path | type    | meaning          |
| ---- | ------- | ---------------- |
| `i`  | integer | The epoch index. |

Returns a `PocaEpoch`:
```jsonc
{
  "index": 0,
  "state": "sealed",                 // "open" | "sealed" | "unknown"
  "openTs": 1727300000000,
  "endTs": 1727386400000,            // null while open
  "tickCount": 1440,
  "digestCount": 1440,               // digests currently stored
  "merkleRoot": "7f3a…",            // null until sealed
  "sealedHead": "b2c4…",            // null until sealed
  "genesisHead": "a1f0…",
  "codeCommitment": "2bd01a…",
  "reason": "threshold",             // null while open
  "txHash": "0x…",                  // openEpoch tx while open; sealEpoch tx once sealed
  "firstDigest": "c0d1…",           // sample: first cron digest in the epoch
  "lastDigest": "b2c4…"             // sample: latest cron digest in the epoch
}
```

#### `GET /poca/proof`
Merkle inclusion proof for one cron digest. Fold `digest` up through `path` and verify you land on `root`.
For a sealed epoch, `root` equals the committed `merkleRoot` (proves against the on-chain anchor).

| query   | type    | required | meaning                                    |
| ------- | ------- | -------- | ------------------------------------------ |
| `epoch` | integer | yes      | The epoch index.                           |
| `cron`  | integer | yes      | 0-based digest position within the epoch.  |

Returns a `PocaProof`:
```jsonc
{
  "epoch": 2,
  "cron": 42,
  "digest": "e5f6…",                 // the cron digest (Merkle leaf, 64-hex)
  "root": "7f3a…",                   // Merkle root over the epoch's digests
  "path": [                          // sibling hashes from leaf up to root
    { "sibling": "ab12…", "direction": 0 },  // 0 = current is LEFT child
    { "sibling": "cd34…", "direction": 1 }   // 1 = current is RIGHT child
  ],
  "sealed": true                     // true when the epoch is sealed
}
```

#### `GET /poca/admin`
The administrative-discontinuity log, most recent first. Every RESET / MANUAL_TICK / PARAM_OVERRIDE /
COMMITTER_CHANGE / GENESIS_SEED / DO_REBUILD / CODE_CHANGE appears here.

| query   | type    | default | meaning                                    |
| ------- | ------- | ------- | ------------------------------------------ |
| `limit` | integer | `100`   | Max entries to return (1–500).              |

Returns `{ admin[], count }` where each entry is a `PocaAdminEntry`:
```jsonc
{
  "kind": 7,                         // 1–7 (see AdminAction kinds below)
  "kindName": "CODE_CHANGE",         // human-readable label
  "ts": 1727450000000,               // Unix ms recorded
  "payloadHash": "9a8b…",           // sha256(canonical({kind,ts,detail})) — commits the reason
  "note": "CODE_COMMITMENT rotated", // short safe-to-expose label
  "txHash": "0x…"                   // on-chain adminAction tx (when armed + mined)
}
```

**AdminAction kinds:**

| Kind | Name | Meaning | On-chain mirror |
|---|---|---|---|
| 1 | `RESET` | `/reset` invoked — swarm state restarted. | ✔ |
| 2 | `MANUAL_TICK` | Tick driven by a human via `POST /tick` (not cron). **Local-log only**; rate-limited to one entry per 5-minute window (merged). | ✖ local only |
| 3 | `PARAM_OVERRIDE` | Runtime knob snapshot changed (wrangler params overridden). | ✔ |
| 4 | `COMMITTER_CHANGE` | Facilitator/committer wallet address changed. | ✔ |
| 5 | `GENESIS_SEED` | Receipt registry genesis anchor mined. | ✔ |
| 6 | `DO_REBUILD` | Durable Object state rebuilt / restored to defaults. | ✔ |
| 7 | `CODE_CHANGE` | `CODE_COMMITMENT` rotated — new source tree acting. | ✔ |

Kinds **1, 3, 4, 5, 6, 7** are mirrored on-chain via `ContinuityRegistry.adminAction(kind, payloadHash)`;
kind **2** (`MANUAL_TICK`) is local-log only — no on-chain transaction.

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
