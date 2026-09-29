# Proof of Continuous Agency (PoCA)

> **murmur's runtime assurance case**: not a proof that the system is autonomous or conscious — a falsifiable
> mechanism ensuring that **any rewrite, reset or takeover leaves an undeletable on-chain evidence trail**.

---

## Table of contents

1. [Naming & positioning](#naming--positioning)
2. [Problem statement](#problem-statement)
3. [Data structures](#data-structures)
4. [Contract interface](#contract-interface)
5. [Five-criterion verification algorithm](#five-criterion-verification-algorithm)
6. [Epoch semantics](#epoch-semantics)
7. [Trust boundary — honest disclosures](#trust-boundary--honest-disclosures)
8. [Verifier usage](#verifier-usage)
9. [Ecosystem relations](#ecosystem-relations)
10. [Cost model](#cost-model)

---

## Naming & positioning

### Why "Proof of Continuous Agency"

| Rejected name | Reason |
|---|---|
| Proof of Autonomy / PoA | Collides with **Arc's Proof-of-Authority** consensus mechanism — same chain, same acronym, different meaning. |
| Proof of Agency | Already occupied by ORIGIN Protocol, Chitin and ChaosChain; their semantics are the **opposite** (proving an agent *is* autonomous vs. proving *continuity of a declared program*). |
| Proof-of-Continuity | arXiv:2607.08906 uses this term for a distinct cryptographic construction (block-production continuity in PoS). |

**PoCA** is therefore positioned as a **runtime assurance case** (SSRN 6941298 §4: "a runtime assurance case
rather than an omniscient proof of autonomy"). It does not claim to prove consciousness, sentience or true
autonomy. It claims something narrower and falsifiable:

> *Over any measurement window, the observed on-chain and off-chain behaviour was produced continuously by the
> same declared program — and if it was not, the evidence of the break is permanent, public, and undeletable.*

### Supporting references

| Source | Contribution |
|---|---|
| IACR ePrint 2025/592 | Formalises deterministic state-machine replication; PoCA's digest chain is a specialisation where the state machine is the fly-brain simulation. |
| arXiv:2601.04583 | Introduces the **autonomous signing + observability** dimensions; PoCA addresses both: the worker signs EIP-3009 autonomously AND publishes a continuous observability chain. |
| SSRN 6941298 | Frames agent assurance as a "runtime assurance case rather than an omniscient proof of autonomy" — the exact epistemic posture PoCA adopts. |
| ERC-8273 §Security Considerations | Identifies the **Subject Control Change** gap: an agent registry has no mechanism to detect that the subject's controller changed. PoCA's admin-kind-4 (COMMITTER_CHANGE) and kind-7 (CODE_CHANGE) directly address this gap. |

---

## Problem statement

Given a live autonomous economic agent (the murmur swarm) operating on a public chain for 180+ days, answer:

> **Was the account's observed behaviour produced continuously by the declared program — or did an operator
> silently rewrite the code, reset the state, rebuild the Durable Object, override a parameter, or take over
> the committer wallet?**

A sceptic must be able to answer this from **public data alone**, without trusting the operator. The answer is
not a binary "proved autonomous" — it is a **falsifiable claim** backed by a chain of cryptographic commitments
that makes any discontinuity visible, permanent and attributable.

---

## Data structures

### `PocoStateInput` (the per-cron snapshot)

The salient state folded into each cron digest. Defined at `packages/trader-worker/src/poca.ts:144-152`:

```typescript
export interface PocoStateInput {
  tickIndex: number;                                   // the swarm tick that produced this cron
  proofChainHead: string;                              // provenance receipt chain head ("" if none yet)
  chronicler: { headHash: string; era: number; seq: number };  // the narrative/era chronicler cursor
  arenaCursor: { openedRound: number; resolvedRound: number }; // prediction-arena progress (-1 when off)
  warCount: number;                                    // house-war progress cursor (-1 when off)
  pop: { size: number; generation: number; civLevel: number }; // population + civilisation level
  econ: { volumeAtomic: string; count: number };       // cumulative settled volume (atomic USDC) + deal count
}
```

This field set is the PoCA "what matters" contract. Changing it rotates every future `stateDigest` (which is
fine — the chain links via `prevDigest`, not via a stable field layout).

### `stateDigest`

```
stateDigest = sha256( canonical_JSON(PocoStateInput) )
```

Canonical JSON: deterministic key ordering (alphabetical), no whitespace, UTF-8. Uses the same `sha256Hex` from
`provenance.ts` that the receipt chain uses.

### `cronDigest`

```
cronDigest_i = sha256( prevDigest || u64be(i) || stateDigest || codeCommitment )
```

| Field | Encoding | Notes |
|---|---|---|
| `prevDigest` | 32 raw bytes (hex-decoded) | Previous cron digest; `ZERO64` ("0"×64) at genesis. |
| `u64be(i)` | 8 raw bytes, big-endian unsigned | `i` = 0-based position WITHIN the current epoch (Merkle leaf index). |
| `stateDigest` | 32 raw bytes (hex-decoded) | sha256 of the canonical state snapshot. |
| `codeCommitment` | 32 raw bytes (hex-decoded) | The `CODE_COMMITMENT` from `codeCommitment.ts` — sha256(src tree hashes + FlyWire artifact + knob defaults). Git HEAD is NOT part of this hash (published separately). |

Total preimage: **104 bytes**. The hash is raw-byte SHA-256 (WebCrypto `crypto.subtle.digest`), NOT
canonical-JSON sha256. The chain continues across epoch boundaries (`prevDigest` is global, not per-epoch).

### `CODE_COMMITMENT`

Generated by `scripts/gen-codecommit.mjs` before every `wrangler deploy`. The commitment covers:

1. sha256 over every file under `packages/trader-worker/src` (sorted by relative path; each file contributes
   `sha256(relPath + "\0" + bytes)`); `codeCommitment.ts` itself is **excluded** (no self-reference).
2. sha256 over every file under `packages/fly-brain/src` (same fold method).
3. sha256 of the deployed FlyWire connectome artifact (the KV-stored FAFB 783 binary blob).
4. A canonical snapshot of knob CODE DEFAULTS (mirroring `config.ts` fallbacks for every grey-release switch).

**`git HEAD` is NOT hashed into `CODE_COMMITMENT`.** The `GIT_COMMIT` string is published separately via
`GET /poca` (the top-level `gitCommit` field) for human correlation, but it does not affect the
commitment value. This means a commit that touches only documentation, CI config or non-source files does
**not** rotate the commitment and does not trigger an epoch seal.

**Rotation trigger:** `CODE_COMMITMENT` rotates only when a real source file (in the two hashed trees), a
knob default, or the FlyWire artifact changes. Rotation forces the running PoCA epoch to seal and a new one
to open (admin kind 7 `CODE_CHANGE`).

**Freshness guarantee:** both the root `npm run deploy:worker` and the package-level
`packages/trader-worker/scripts/deploy*.mjs` prepend the codegen step, so a normal deploy always regenerates
`codeCommitment.ts` from the working tree. A bare `wrangler deploy` that bypasses the npm script would deploy
a stale commitment — this is operational discipline, not a code guarantee. CI's `check:knobs` gate catches
knob-default drift; source-tree drift is caught by the codegen step itself failing if the generated file
differs from the committed one.

### Merkle tree rules

| Rule | Specification |
|---|---|
| Fold | Pairwise: `sha256(left || right)` — raw byte concatenation, 64 bytes in, 32 bytes out. |
| Odd tail | The lone node is **duplicated** (paired with itself). |
| Empty list | Root = `ZERO64` ("0"×64). |
| Single leaf | Root = the leaf itself (loop never runs). |
| Inclusion proof | `MerkleStep { sibling: string; direction: 0|1 }` — direction 0 ⇒ current is LEFT child; 1 ⇒ RIGHT. |

These rules match the on-chain `ContinuityRegistry` so an off-chain proof verifies on-chain.

#### Merkle malleability disclosure (odd-tail duplication)

The odd-tail duplication rule introduces a **theoretical malleability**: for any leaf list `[...x]` of odd
length, `root([...x]) == root([...x, x])` — appending a duplicate of the final leaf yields the same Merkle
root. An attacker who could inject an extra cron digest equal to the last digest of an odd-length epoch would
produce a root collision.

**Why this is not exploitable in practice — compensating controls:**

1. **`cronDigest` binds `prevDigest` and `u64be(i)`.** Each digest is
   `sha256(prevDigest || u64be(i) || stateDigest || codeCommitment)`. A duplicated leaf at index `n` would
   need to encode `u64be(n)` (different from `u64be(n-1)`), so the digest values cannot actually collide —
   only a leaf with an identical byte-level preimage would duplicate, which the chained index makes
   impossible without also breaking the chain link.
2. **Verifier sampling checks path AND boundary consistency.** The CLI verifier and browser-side
   `__pocaVerify` both recompute `cronDigest` from its four inputs (including the index) and assert the
   Merkle path lands on the committed root — a spurious duplicate at position `n` would fail the
   `u64be(i)` recomputation.
3. **Epoch seal commits `tickCount` on-chain.** A root computed over `n+1` leaves with a declared
   `tickCount = n` is contradictory; the verifier asserts `len(digests) == tickCount`.

The duplication rule is retained because it matches the on-chain `ContinuityRegistry`'s Solidity Merkle
verifier (which uses the same pairwise fold + odd-tail-duplicate convention) and because the compensating
controls above make the theoretical collision unreachable in the chained-digest construction.

### `EpochRecord` (on-chain struct)

```solidity
struct EpochRecord {
    bytes32 codeCommitment;   // sha256 of declared program identity for this epoch
    bytes32 genesisHead;      // digest-chain head at epoch open
    bytes32 sealedHead;       // digest-chain head at epoch seal
    uint64  startTs;          // block.timestamp at open
    uint64  endTs;            // block.timestamp at seal
    uint64  tickCount;        // cron digests folded into this epoch
    bytes32 merkleRoot;       // Merkle root over per-cron digests
    bytes32 prevEpochSeal;    // sealedHead of previous epoch (chain of epochs)
}
```

### `PocoSealedEpoch` (off-chain persisted record)

```typescript
interface PocoSealedEpoch {
  index: number;
  openTs: number;             // ms epoch opened
  endTs: number;              // ms epoch sealed
  tickCount: number;          // = number of cron digests in the epoch
  merkleRoot: string;         // 64-hex Merkle root over the epoch's digests
  sealedHead: string;         // the epoch's last cron digest (ZERO64 if sealed empty)
  genesisHead: string;
  codeCommitment: string;
  reason: string;             // "threshold" | "reset" | "code-change"
  codeChangeAdminTs: number | null; // Unix ms of the kind-7 CODE_CHANGE admin entry that triggered this epoch's rotation (null when reason != "code-change")
  openTxHash?: string;        // on-chain openEpoch tx (when armed)
  txHash?: string;            // on-chain sealEpoch tx (when armed)
}
```

### AdminAction kinds

| Kind | Name | Meaning | On-chain mirror |
|---|---|---|---|
| 1 | `RESET` | `/reset` invoked — swarm state + epoch deliberately restarted. | ✔ `adminAction(1, …)` |
| 2 | `MANUAL_TICK` | A tick driven by a human hitting `POST /tick`. **Local-log only** (not mirrored on-chain); rate-limited to one entry per 5-minute window (repeated invocations within the window are merged). | ✖ local only |
| 3 | `PARAM_OVERRIDE` | Runtime knob snapshot differs from the last-seen one (wrangler params changed). | ✔ `adminAction(3, …)` |
| 4 | `COMMITTER_CHANGE` | Facilitator/committer wallet address changed (possible takeover). | ✔ `adminAction(4, …)` |
| 5 | `GENESIS_SEED` | Receipt registry's lazy genesis anchor mined (on-chain chain start). | ✔ `adminAction(5, …)` |
| 6 | `DO_REBUILD` | Durable Object state rebuilt / restored to fresh defaults. | ✔ `adminAction(6, …)` |
| 7 | `CODE_CHANGE` | `CODE_COMMITMENT` rotated — a new source tree is now acting. | ✔ `adminAction(7, …)` |

Kinds **1, 3, 4, 5, 6, 7** are mirrored on-chain via `ContinuityRegistry.adminAction(kind, payloadHash)`;
kind **2** (`MANUAL_TICK`) is recorded only in the local admin log — it never produces an on-chain transaction.

Each entry: `{ kind, ts, payloadHash, note, txHash? }` where
`payloadHash = sha256(canonical({kind, ts, detail}))` — commits the reason without leaking it.

### Mirror state

The PoCA engine maintains a `mirror` object reflecting the health of the on-chain `ContinuityRegistry`
mirror. It is exposed in the `GET /poca` response:

```typescript
interface PocoMirrorState {
  aligned: boolean;        // true when the current open epoch has been successfully mirrored (openTxHash present) AND no unresolved misalignment
  failures: number;        // cumulative mirror-call failures since worker start (monotonic; never reset on success)
  paused: boolean;         // true when an alignment check failed — mirror suspended; auto-cleared on the next successful alignment check (no operator intervention required)
  lastMirrorTs: number | null;  // Unix ms of the last successful on-chain mirror call (null if never)
}
```

**Self-healing semantics (task 66):**

- **Missing-open retry**: every cron, `recheckAlignment` detects when the current open epoch has no
  `openTxHash` and the on-chain `epochCount` matches the local index — it retries `mirrorOpen` inline
  (serial queue). A transient RPC failure no longer leaves an epoch permanently un-mirrored.
- **Seal enqueues open-first**: when `sealAndReopen` seals an epoch whose `openTxHash` is null, it
  enqueues `openEpoch(sealed)` → `sealEpoch(sealed)` → `openEpoch(next)` in the serial queue, so the
  chain catches up automatically from a "behind-1" state without operator intervention.
- **Honest `aligned`**: the snapshot reports `aligned=false` whenever the open epoch lacks `openTxHash`,
  giving frontends and verifiers the real mirror state rather than a stale optimistic flag.

---

## Contract interface

### `ContinuityRegistry` (Solidity ^0.8.24)

Source: `packages/trader-worker/contracts/ContinuityRegistry.sol`

**Properties:** holds NO funds, has NO upgrade path, NO owner — a pure commitment log.

| Function | Visibility | Description |
|---|---|---|
| `openEpoch(bytes32 codeCommitment_, bytes32 genesisHead_) → uint256` | external, only-committer | Opens the next sequential epoch; chains `prevEpochSeal` from the prior epoch. Reverts `ZeroHash` on zero inputs. |
| `sealEpoch(uint256 epochIndex_, bytes32 sealedHead_, uint64 tickCount_, bytes32 merkleRoot_)` | external, only-committer | Seals the most recently opened epoch (must be `epochCount - 1`). Reverts `AlreadySealed`, `EpochNotOpen`, `BadEpochIndex`, `ZeroHash`. |
| `adminAction(uint8 kind_, bytes32 payloadHash_)` | external, only-committer | Emits `AdminAction(kind, msg.sender, payloadHash, timestamp)`. |
| `currentEpoch() → uint256` | external view | Index of the most recently opened epoch. Reverts `BadEpochIndex` when none exists. |
| `isUnbroken(uint256 from, uint256 to) → bool` | external view | True iff every epoch in `[from, to]` is sealed AND each epoch's `prevEpochSeal` equals its predecessor's `sealedHead`. |
| `epochCount() → uint256` | public | Total epochs opened. |
| `epochs(uint256) → EpochRecord` | public | The record for a given epoch index. |
| `committer() → address` | public immutable | The only address that may commit (the murmur facilitator / gas wallet). |

**Events:**

```solidity
event EpochOpened(uint256 indexed epochIndex, bytes32 codeCommitment, bytes32 genesisHead, uint64 ts);
event EpochSealed(uint256 indexed epochIndex, bytes32 sealedHead, uint64 tickCount, bytes32 merkleRoot, uint64 ts);
event AdminAction(uint8 indexed kind, address actor, bytes32 payloadHash, uint64 ts);
```

**Errors:** `NotCommitter()`, `EpochNotOpen()`, `AlreadySealed()`, `BadEpochIndex()`, `ZeroHash()`.

### Deployed contract addresses (Arc mainnet 5042)

| Contract | Address | Role |
|---|---|---|
| NeuralReceiptRegistry | `0x94d0c38bcc9957eaf8f318e6bbc6557f8cc3c815` | On-chain receipt hash-chain head (provenance). |
| NeuralManifestRegistry | `0x3412eb909252adb983aaf793f97a3754ca029a37` | Brain manifest commitment. |
| ConnectomeLineage | `0x482b7a3bbef796c9627d86d5a23c67728a78096f` | On-chain family tree. |
| **ContinuityRegistry** | `0x3f67b38030f2d709bafd2f7a3ee2388c35195b33` | **PoCA epoch-chain anchor.** |

> **Deployment record:** `ContinuityRegistry` was deployed to Arc mainnet (chainId 5042) on 2026-09-29 —
> deploy tx `0xd9ef64051afe14bba8535bb8745a306189478a649b265e0e940d5250eba3dd16`, gas paid by `0x307D…3a0d`,
> committer = the Worker facilitator `0x2b9a…055c`. The address is the code default in `src/config.ts`
> (`pocaRegistryAddress`); no `wrangler.toml` var is required (`POCA_REGISTRY_ADDRESS` can still override).

---

## Five-criterion verification algorithm

A sceptic verifies continuous agency by checking five independent criteria. Each produces PASS/FAIL with a
confidence level.

### Criterion ① — Code identity

**Claim:** The program that acted is the program it declares.

| Step | Algorithm |
|---|---|
| 1 | `GET /poca` → read `codeCommitment`, `gitCommit`, `commitmentInputs`. |
| 2 | Clone the repo at `gitCommit`. Run `node scripts/gen-codecommit.mjs`. Compare the output to the served `codeCommitment`. |
| 3 | For each sealed epoch: read `epochs(i).codeCommitment` on-chain. Assert it matches the off-chain record AND the current (or a historical ancestor) `CODE_COMMITMENT`. |

**Threshold:** Exact match (sha256 collision resistance). A mismatch ⇒ FAIL ⇒ admin kind-7 was logged.

**Evidence sources:** `GET /poca`, on-chain `epochs(i).codeCommitment`, the public git repository.

### Criterion ② — Chain integrity

**Claim:** The hash chain is unbroken from genesis to the current head.

| Step | Algorithm |
|---|---|
| 1 | `GET /poca/epochs?limit=500` → retrieve all sealed epochs (most recent first). |
| 2 | For each epoch pair `(i, i-1)`: assert `epochs[i].prevEpochSeal == epochs[i-1].sealedHead`. |
| 3 | On-chain: `isUnbroken(0, epochCount-1)` → must return `true`. |
| 4 | For a random sample of crons: `GET /poca/proof?epoch=E&cron=C` → recompute the Merkle path locally; assert the root matches `epochs[E].merkleRoot`. |
| 5 | Recompute at least one cron digest from its four inputs (prevDigest, index, stateDigest, codeCommitment) and verify it matches the served leaf. |

**Threshold:** Any chain-link break ⇒ FAIL. Merkle proof failure ⇒ FAIL.

**Evidence sources:** `GET /poca/epochs`, `GET /poca/proof`, on-chain `isUnbroken()`, on-chain `epochs(i)`.

### Criterion ③ — Temporal density

**Claim:** The agent ticked continuously — no silent gap was hidden.

| Step | Algorithm |
|---|---|
| 1 | For each sealed epoch: compute `expectedTicks = (endTs - openTs) / cronCadenceMs`. At production cadence (60s), `cronCadenceMs = 60_000`. |
| 2 | Compute `density = tickCount / expectedTicks`. |
| 3 | Assert `density ≥ 0.85` (allows for Cloudflare cron jitter, cold-start delays, and the ~37s tick margin). |
| 4 | For the open epoch: assert `digestCount ≥ (now - openTs) / 120_000` (half cadence — very lenient for a live window). |

**Threshold:** `density < 0.85` for any sealed epoch ⇒ FAIL. A gap is visible even if the operator does not
log it: missing crons mean missing digests mean a lower tickCount relative to the wall-clock span.

**Evidence sources:** `GET /poca/epochs` (openTs, endTs, tickCount), `GET /poca` (epochState.digestCount, openTs).

### Criterion ④ — Behavioural consistency

**Claim:** The state digests are consistent with a single deterministic program — no external override.

| Step | Algorithm |
|---|---|
| 1 | For any cron `i`: `stateDigest_i = sha256(canonical(PocoStateInput_i))`. The input fields (`tickIndex`, `proofChainHead`, `chronicler`, `arenaCursor`, `warCount`, `pop`, `econ`) are all monotone or deterministic given the same program. |
| 2 | Assert `tickIndex` is non-decreasing across consecutive digests (a regression ⇒ kind-6 DO_REBUILD must be logged). |
| 3 | Assert `econ.volumeAtomic` is non-decreasing (cumulative). |
| 4 | Assert `pop.size` never exceeds `EVOLUTION_MAX_LIVE_POPULATION` (100). |
| 5 | Cross-validate `proofChainHead` against `GET /proofs` — the receipt chain head must advance or stay stable. |

**Threshold:** Any monotonicity violation without a corresponding admin log entry ⇒ FAIL.

**Confidence level:** This criterion operates at the **"commitment self-consistency + on-chain anchoring"** level.
Full behavioural replay (rebuilding every tick from the neural simulation) is covered by the separate
`npm run replay -- --flywire` (i.e. `scripts/replay-brain.ts` in FlyWire mode), which deterministically
reconstructs every connectome from its committed seed and verifies the structural specs match the on-chain
manifest hash.

**Evidence sources:** `GET /poca/proof` (stateDigest recomputation), `GET /proofs`, `GET /state`,
`GET /population`.

### Criterion ⑤ — Asset continuity

**Claim:** The agent's on-chain financial behaviour is continuous and attributable — no undisclosed wallet
took over.

| Step | Algorithm |
|---|---|
| 1 | Read `GET /economy` → every agent's address (HD-derived, deterministic from the mnemonic). |
| 2 | Read the committer/facilitator address from `GET /poca` (via the registry's `committer()` on-chain). Assert it has not changed without an admin kind-4 log. |
| 3 | For a sample of recent settlements: `GET /proofs/verify?tx=0x…` → the EIP-3009 nonce is `sha256(receipt)`. Since the receipt is hash-chained and already mined, **post-hoc fabrication is infeasible**. |
| 4 | Cross-reference: any on-chain USDC transfer FROM an agent address that does NOT appear in the receipt chain constitutes **takeover evidence** (an undisclosed external signer moved funds). |
| 5 | Assert `econ.volumeAtomic` (criterion ④) agrees with the on-chain cumulative volume queryable from Arc. |

**Threshold:** Any unattributed on-chain transfer from a declared agent address ⇒ FAIL (takeover detected).

**Evidence sources:** `GET /economy`, `GET /proofs`, `GET /proofs/verify`, Arc mainnet RPC
(`eth_getLogs` on the USDC precompile filtered by agent addresses), on-chain `committer()`.

---

## Epoch semantics

### Opening triggers

An epoch opens when:

| Trigger | Admin kind | Notes |
|---|---|---|
| **Genesis** (first ever cron) | — | Epoch 0; `genesisHead` = current `proofChainHead` (or ZERO64 if none). |
| **DO rebuild** (kind 6) | `DO_REBUILD` | The Durable Object was wiped/restored. Detected via: no open epoch but closed epochs exist, OR tick regression within a live epoch. |
| **Code change** (kind 7) | `CODE_CHANGE` | `CODE_COMMITMENT` differs from the open epoch's stored commitment. The old epoch seals first (reason `"code-change"`), then a new one opens. |
| **Reset** (kind 1) | `RESET` | `POST /reset` invoked. The old epoch seals (reason `"reset"`), then a new one opens anchored at the new chain head. |

### Sealing triggers

An epoch seals when:

| Trigger | `reason` field |
|---|---|
| **Threshold reached** | `"threshold"` — the epoch accumulated `SEAL_THRESHOLD` (1440) cron digests (≈24h at 1 cron/min). |
| **Code change** | `"code-change"` — forced seal before opening a new epoch under the rotated commitment. |
| **Reset** | `"reset"` — forced seal before opening a fresh epoch. |

### Epoch chain (`prevEpochSeal`)

Each epoch stores the `sealedHead` of its predecessor in `prevEpochSeal`, forming an append-only chain:

```
epoch[0].prevEpochSeal = 0x0000…0000  (genesis — no predecessor)
epoch[1].prevEpochSeal = epoch[0].sealedHead
epoch[2].prevEpochSeal = epoch[1].sealedHead
…
```

### `isUnbroken` definition

The on-chain `isUnbroken(from, to)` returns `true` iff for every epoch `i` in `[from, to]`:

1. `epochs[i].sealedHead != bytes32(0)` (the epoch is sealed), AND
2. For `i > 0`: `epochs[i].prevEpochSeal == epochs[i-1].sealedHead` (chain link intact).

If any epoch in the range is unsealed, or any link is broken, the range is NOT unbroken.

### Continuity verdict (`GET /poca`)

| `continuity` | Meaning |
|---|---|
| `"unbroken"` | On-chain mirror armed, an epoch is open, and a chain head exists. |
| `"pending"` | On-chain mirror armed, but no epoch/head yet (cold start). |
| `"disabled"` | Registry address is the zero address — off-chain chain still runs identically, no on-chain anchor. |

The `GET /poca` response additionally includes a `mirror` object (see [Mirror state](#mirror-state) above)
exposing the on-chain mirror's alignment health:

```jsonc
"mirror": {
  "aligned": true,         // local epochCount == on-chain epochCount
  "failures": 0,           // consecutive mirror-call failures
  "paused": false,         // true ⇒ mirror suspended (alignment check failed)
  "lastMirrorTs": 1727500060000  // Unix ms of last successful on-chain call (null if never)
}
```

---

## Trust boundary — honest disclosures

PoCA's guarantees are bounded by its trust assumptions. We state them explicitly:

### 1. The committer is the worker's own facilitator wallet

The `committer` (immutable, set at construction) is the same wallet that settles EIP-3009 transfers and
mirrors receipt/manifest commits. **The hash chain proves "committed data cannot be retroactively altered"**
but does NOT prove "the committer never withheld a segment of history before committing."

### 2. Withholding detection

A dishonest committer could theoretically stop committing for a period and resume — creating a gap. This is
detected by:

- **Criterion ⑤ (asset continuity):** Every real settlement uses EIP-3009 with `nonce = sha256(receipt)`. Once
  mined, the receipt is permanently on-chain. If the committer withheld a segment, the on-chain USDC transfers
  still exist and can be cross-referenced against the receipt chain. A mined transfer with no corresponding
  receipt in the chain ⇒ evidence of withholding or takeover.
- **Criterion ③ (temporal density):** A gap in committed digests relative to wall-clock time is visible:
  `tickCount / expectedTicks` drops below the threshold.
- **Non-declared transfers = takeover evidence:** Any on-chain USDC movement from a declared agent address
  that does NOT appear in the receipt chain is attributable to an external signer — proof of takeover.

### 3. Arc finality makes anchoring permanent

Arc mainnet has **deterministic sub-second finality** and no reorganisations. Once an epoch seal transaction
is mined, it cannot be reverted. The `ContinuityRegistry` is immutable (no upgrade path, no owner, no
self-destruct). This makes every committed epoch a permanent public fact.

### 4. Downtime is visible, not hidden

If the worker stops ticking (Cloudflare outage, cron wedge, DO eviction), no new digests are appended. The
temporal-density criterion (③) detects this automatically: the epoch's `tickCount` falls relative to its
wall-clock span. An operator cannot hide downtime — only explain it.

### 5. What PoCA does NOT prove

- It does not prove the agent is "truly autonomous" or "conscious" — those are philosophical claims outside
  any cryptographic system's reach.
- It does not prevent an operator from deploying a completely new system under a new identity — it only
  ensures that if they do, the old chain stops advancing (detectable) and a new epoch with a different
  `codeCommitment` opens (attributable).
- It does not prove the committer never lied in a `stateDigest` — but criterion ④ cross-validates the digest
  fields against independently observable on-chain state (balances, receipt chain, arena rounds).

### 6. Known contract limitation: `openEpoch` does not enforce prior-epoch seal

`ContinuityRegistry.openEpoch(codeCommitment_, genesisHead_)` opens the next sequential epoch without
requiring that the previous epoch has been sealed. Because the contract is immutable (no upgrade path, no
owner), this cannot be patched post-deploy.

**Worker-side discipline (the compensating control):**

Before mirroring any new epoch on-chain, the worker reads `epochCount()` from the registry and asserts it
equals the expected next index. If the on-chain count is misaligned (e.g. a prior seal failed or was
skipped), the worker:
1. Skips the on-chain mirror for this epoch.
2. Sets `mirror.paused = true` in the PoCA state.
3. Logs a local admin entry with `kind = 6` (DO_REBUILD) flagging the alignment failure.

**Consequence if discipline fails:**

If the worker were to call `openEpoch` while the prior epoch is unsealed, `prevEpochSeal` would be `bytes32(0)`
for the new epoch. The on-chain `isUnbroken(from, to)` check would then permanently return `false` for any
range spanning that boundary — the chain is provably broken and cannot be repaired.

**Recovery path:** redeploy a fresh `ContinuityRegistry` instance (new address, history restarts from epoch 0).
The old registry remains on-chain as an immutable archive — any verifier can still read its sealed epochs and
audit the break point.

**Why this limitation is acceptable:** the committer is unique (a single immutable address), the alignment
discipline is fully specified in open-source code (`poca.ts`) and auditable, and a failure mode produces a
permanently visible on-chain break rather than a silent compromise.

---

## Verifier usage

### Offline CLI verifier

The PoCA verifier script (`scripts/poca-verify.mjs`) provides four modes:

```bash
# Self-test: run the digest + Merkle algorithms against known test vectors (no network)
node scripts/poca-verify.mjs --selftest

# Registry mode: read the on-chain ContinuityRegistry and verify isUnbroken(0, epochCount-1)
node scripts/poca-verify.mjs --registry --rpc https://rpc.mainnet.arc.io

# Sample mode: fetch N random epoch proofs from the live API and verify Merkle inclusion locally
node scripts/poca-verify.mjs --sample --api https://api.muros.live --n 10

# JSON output: machine-readable result for CI integration
node scripts/poca-verify.mjs --sample --api https://api.muros.live --json
```

> **Note:** `scripts/poca-verify.mjs` is a planned artifact. Until it ships, the same checks can be performed
> manually using the API endpoints + `cast call` against the registry.

### Browser-side verification

The frontend exposes `window.__pocaVerify` (when the PoCA drawer is loaded), which:

1. Fetches `GET /poca` + `GET /poca/epochs?limit=10` from the live API.
2. Recomputes Merkle roots in-browser (WebCrypto SHA-256, no dependencies).
3. Cross-references `codeCommitment` against the served `commitmentInputs`.
4. Reports a PASS/FAIL verdict per criterion.

### Manual verification with `cast`

```bash
# Check the epoch chain is unbroken from epoch 0 to the latest
cast call <CONTINUITY_REGISTRY> "isUnbroken(uint256,uint256)(bool)" 0 $(cast call <CONTINUITY_REGISTRY> "epochCount()(uint256)") \
  --rpc-url https://rpc.mainnet.arc.io

# Read a specific epoch's record
cast call <CONTINUITY_REGISTRY> "epochs(uint256)(bytes32,bytes32,bytes32,uint64,uint64,uint64,bytes32,bytes32)" 0 \
  --rpc-url https://rpc.mainnet.arc.io

# Verify the committer has not changed
cast call <CONTINUITY_REGISTRY> "committer()(address)" --rpc-url https://rpc.mainnet.arc.io
```

---

## Ecosystem relations

### ERC-8004 — Agent Validation Registry

The [ERC-8004 Validation Registry](https://erc8004.org) singleton on Arc mainnet is deployed at
`0x8004Cc8439f36fd5F9F049D9fF86523Df6dAAB58`. PoCA integrates as follows:

| Step | Action |
|---|---|
| 1 | murmur registers as a **validator** on the ERC-8004 registry. |
| 2 | Each sealed epoch publishes a `validationResponse` containing: `{ agentId, epochIndex, merkleRoot, continuityVerdict, codeCommitment }`. |
| 3 | Third-party agents (or the same agent, self-attesting) can query the registry for murmur's continuity history without hitting murmur's API. |

**Registration file `continuity` section (recommended):**

```json
{
  "continuity": {
    "protocol": "PoCA/1.0",
    "registry": "<ContinuityRegistry address on Arc mainnet>",
    "verifier": "https://api.muros.live/poca",
    "epochs": "on-chain via isUnbroken()",
    "codeIdentity": "sha256 over src trees (trader-worker + fly-brain) + FlyWire artifact + knob defaults"
  }
}
```

### EIP draft path

PoCA is currently at the **independent specification + reference implementation** stage:

- This document (`docs/POCA.md`) is the normative specification.
- `packages/trader-worker/src/poca.ts` is the reference implementation (off-chain engine).
- `packages/trader-worker/contracts/ContinuityRegistry.sol` is the reference on-chain contract.
- `packages/trader-worker/src/poca.test.ts` is the reference test suite.

The path to an EIP draft requires: (a) at least 180 days of live epoch history on Arc mainnet, (b) a second
independent implementation (e.g. in Rust or Go), (c) an ERC-8004 integration demonstrating cross-protocol
composability. PoCA is designed to be chain-agnostic (the contract is pure Solidity, no Arc-specific
precompiles) and could be deployed on any EVM chain.

### Relationship to existing murmur proofs

| System | Question answered | Granularity |
|---|---|---|
| **NeuralReceiptRegistry** | "Was THIS specific trade decided by the declared neurons?" | Per-settlement. |
| **NeuralManifestRegistry** | "Are the brains exactly what the committed seeds generate?" | Per-deploy. |
| **ConnectomeLineage** | "Is this genome's ancestry genuine?" | Per-genome. |
| **ContinuityRegistry (PoCA)** | "Has the SAME program been acting CONTINUOUSLY for the last N days?" | Per-epoch (~24h), chained indefinitely. |

PoCA is the **longest-horizon** proof: it subsumes the others by folding `proofChainHead` into every
`stateDigest`, so the receipt chain's integrity is transitively committed into the epoch chain.

---

## Cost model

| Item | Cost |
|---|---|
| `openEpoch` (one per ~24h) | ~45,000 gas ≈ $0.001 at Arc's ~20 gwei / USDC-as-gas. |
| `sealEpoch` (one per ~24h) | ~55,000 gas ≈ $0.001. |
| `adminAction` (rare, event-only) | ~25,000 gas ≈ $0.0005. |
| **Per epoch total** | ≈ $0.002 (two transactions). |
| **180 epochs (180 days)** | < $0.40. |
| **1 year** | < $0.80. |

The `ContinuityRegistry` stores only fixed-size structs (no dynamic arrays), so storage growth is bounded at
~32 bytes × 8 fields × epochCount ≈ 256 bytes/epoch.

---

## Appendix: file map

| File | Role |
|---|---|
| `packages/trader-worker/src/poca.ts` | Off-chain engine: digest chain, Merkle tree, epoch lifecycle, admin log, read-out. |
| `packages/trader-worker/src/poca.test.ts` | Unit tests (in-memory store + stub chain hooks). |
| `packages/trader-worker/src/codeCommitment.ts` | Generated: `CODE_COMMITMENT` + `GIT_COMMIT` + `CODE_COMMITMENT_INPUTS`. |
| `scripts/gen-codecommit.mjs` | Codegen: derives the code commitment before every deploy. |
| `packages/trader-worker/contracts/ContinuityRegistry.sol` | On-chain commitment log (pure Solidity, no funds, no upgrade). |
| `packages/trader-worker/src/state.ts` | Wiring: adapts PocoStore to DO storage, hooks cron entry/exit, serves `/poca*` routes. |
| `packages/trader-worker/src/openapi.ts` | OpenAPI 3.1 schema definitions for all five `/poca*` endpoints. |
| `scripts/replay-brain.ts` | Offline FlyWire replay (criterion ④ full-replay mode). |
