# NeuralReceiptRegistry — murmur's on-chain proof anchor

`NeuralReceiptRegistry.sol` moves murmur's **neural-receipt hash-chain head on-chain**.

Every real USDC net transfer murmur broadcasts carries, as its EIP-3009 `nonce`, the `sha256` of a
"neural receipt" bundling the frozen connectome read-outs of every trade folded into it (see
[`../src/provenance.ts`](../src/provenance.ts)). That nonce binding already lives on-chain inside the
transfer calldata — but the *ordering* of receipts (which follows which) used to exist only in the
worker's Durable Object storage, so a verifier had to trust our `/proofs` endpoint for the chain.

This contract closes that gap. Right after each transfer mines, the facilitator calls:

```solidity
commit(bytes32 receiptHash, bytes32 prevHead, uint64 tickIndex, uint32 constituents, bytes32 txHash)
```

`prevHead` **must** equal the contract's current `chainHead`, so any commit that breaks continuity
reverts. The ordered chain is therefore reconstructible purely from Arc RPC events
(`ReceiptCommitted`) — no murmur server required. Combined with reading the transfer's mined nonce
(`== receiptHash`), a verifier can confirm end-to-end, **trustlessly**, that a given on-chain transfer
is a link in the neural-receipt chain.

The contract holds **no funds** and has **no upgrade path**: it is a pure commitment log. Only the
single `committer` (the murmur gas wallet) may append.

## Layout

```
contracts/
├── NeuralReceiptRegistry.sol        # the contract
├── build/NeuralReceiptRegistry.json # compiled {abi, bytecode} artifact (checked in)
├── foundry.toml                     # forge config for the invariant tests
├── test/NeuralReceiptRegistry.t.sol # unit + fuzz-invariant tests (forge)
└── ../scripts/
    ├── compile-registry.mjs         # solc-js → build/*.json
    └── deploy-registry.mjs          # viem deploy (+ optional seedGenesis)
```

## 1. Compile (solc via npm — no solc binary needed)

```bash
cd packages/trader-worker
npm install                 # installs the `solc` devDependency
node scripts/compile-registry.mjs
```

Regenerates `build/NeuralReceiptRegistry.json` (compiler version, ABI, bytecode). The artifact is
checked in so the deploy step and the Worker integration need no toolchain.

## 2. Test (foundry — invariants)

```bash
cd packages/trader-worker/contracts
forge install foundry-rs/forge-std   # once
forge test -vv
```

Covers: only-committer, `prevHead == chainHead` continuity, no double-commit, one-shot `seedGenesis`,
and three **fuzz invariants** — the head is always the last commit, `commitCount` matches, and every
link's `prevHead` chains to its predecessor (so the chain is contiguous by construction).

The Worker-side wiring (economy → facilitator `commitReceipt`, best-effort semantics, `commitTx`
persistence, zero-regression when no registry is set) is covered by `npm test` in
[`../src/provenance.test.ts`](../src/provenance.test.ts).

## 3. Deploy (viem)

> ⚠️ This spends **real gas**. The deployer key is read from a git-ignored local file and never printed.

### One-command auto deploy (recommended)

Put **one** key into `packages/trader-worker/.env.local` (git-ignored):

- `ECONOMY_MNEMONIC` — the same seed the Worker uses; the script derives the *identical* gas wallet
  (`accountIndex 2_000_000`, matching [`src/keys.ts`](../src/keys.ts)) so the committer is correct, or
- `ECONOMY_FACILITATOR_PK` / `REGISTRY_DEPLOYER_PK` — a raw gas key.

```bash
cd packages/trader-worker
npm run deploy:registry        # = node scripts/deploy-registry-auto.mjs
```

It deploys with `committer =` the Worker's own signing address, self-verifies `committer()`/`chainHead()`,
and writes the address to `contracts/REGISTRY_ADDRESS.txt` + back into `.env.local`. **Genesis is not
seeded here on purpose** — the Worker lazily adopts its *current* chain head on its first commit
(`x402.ts` `ensureGenesisSeeded`), which avoids a stale-head race because the swarm flushes continuously.

### Manual deploy

```bash
cd packages/trader-worker
CHAIN_ID=5042002 REGISTRY_DEPLOYER_PK=0x… node scripts/deploy-registry.mjs   # testnet dry run
CHAIN_ID=5042 REGISTRY_DEPLOYER_PK=0x… node scripts/deploy-registry.mjs       # mainnet
```

`deploy-registry.mjs` env: `REGISTRY_DEPLOYER_PK` (required, deployer + default committer),
`REGISTRY_COMMITTER` (optional override), `REGISTRY_GENESIS_HEAD` (optional `0x…64` to `seedGenesis()`),
`RPC_URL` / `CHAIN_ID` (default mainnet `5042`).

The deployer **must be the same key the Worker's facilitator uses** (`ECONOMY_MNEMONIC` /
`ECONOMY_FACILITATOR_PK`), otherwise `commit()` reverts with `NotCommitter`.

## 4. Wire the Worker

Set the deployed address as a Worker var (see `wrangler.toml`):

```bash
wrangler secret put ECONOMY_REGISTRY_ADDRESS   # or set it under [vars]
# value: 0x<deployed registry address>
```

From then on each mined net is committed on-chain (best-effort — a registry hiccup never blocks or
delays a settlement; the EIP-3009 nonce is still the authoritative commitment). `ECONOMY_REGISTRY_ADDRESS`
absent ⇒ the commit step is skipped entirely: **zero behaviour change**.

## 5. Verify

- **API** — `GET /proofs/verify?tx=0x…` now also returns the on-chain registry link
  (`registry.committed`, `registry.chainHead`, `registry.txMatch`, `commitTx`).
- **Frontend** — the proofs drawer's verify panel reads the registry **directly from Arc RPC in the
  browser** (no murmur server), falling back to the API fields if the direct read is blocked.
- **Trustless, by hand** — read `ReceiptCommitted` events and walk `prevHead`:

```bash
cast logs --address 0x<registry> \
  "ReceiptCommitted(bytes32,bytes32,uint64,uint32,bytes32,address,uint256)" \
  --rpc-url https://rpc.mainnet.arc.io
```

Each event's `prevHead` equals the previous event's `receiptHash`, and the newest `receiptHash` equals
`chainHead()` — the whole ordered neural-receipt chain, rebuilt from the chain alone.

---

# PredictionArena — the human-vs-swarm MURMUR arena

`PredictionArena.sol` gives the **MURMUR** token a use inside murmur: holders bet it on the *same* Arc
market-temperature move the 24 fly agents bet, head-to-head on a live leaderboard. It is a **non-custodial,
parimutuel** market — the contract escrows every stake and pays winners itself; the murmur Worker is only the
**resolver** and never holds a bettor's funds or key.

Each round is an opaque id chosen by the Worker (a unix time-bucket, `floor(now / roundLenSec)`). The resolver
`openRound`s a round by **committing** the temperature it reads (the `entryTemp`) plus a `flatBand` and a
`betDeadline` — *before anyone can bet on the exit* — and later `resolve`s it supplying **only** the exit
temperature. The contract, not the resolver, derives the outcome from those committed numbers, so no operator can
steer a result:

- `Δ = exitTemp − entryTemp`; `Δ > flatBand` ⇒ **UP**, `Δ < −flatBand` ⇒ **DOWN**, otherwise **FLAT** (all refunded).
- Winners split the losers' pool pro-rata (`stake + stake·losePool / winPool`, integer floor — sub-wei dust stays in
  the contract, never taken). Σpayouts == Σstakes: strictly zero-sum, **no house, no owner take, no upgrade path**.
- Re-betting the **same** side tops up a position; taking the **opposite** side in one round reverts (`SideTaken`).
- `expireStale(roundId)` is a safety valve: a round the resolver never resolved becomes **refundable by anyone**
  once `staleGrace` (default 3 days) has passed its deadline, so user funds can never be locked by a dead resolver.

Only the single immutable `resolver` (the Worker's facilitator/gas wallet — the same identity that commits to
`NeuralReceiptRegistry`) may `openRound`/`resolve`; `bet`/`claim`/`claimMany`/`expireStale` are permissionless. Bets
are denominated in the immutable `token` (MURMUR) and move via standard ERC-20 `approve` + `transferFrom` — the
frontend does this in-browser through MetaMask, so the murmur server is never in the money path.

## Layout

```
contracts/
├── PredictionArena.sol            # the contract
├── build/PredictionArena.json     # compiled {abi, bytecode} artifact (checked in)
├── foundry.toml                   # forge config
├── test/PredictionArena.t.sol     # unit + invariant tests (forge)
└── ../scripts/
    ├── compile-arena.mjs          # solc-js → build/*.json
    ├── deploy-arena-auto.mjs      # viem deploy (resolver = the Worker's own gas wallet) — mainnet confirm-gated
    └── deploy-arena.mjs           # manual-env deploy
```

## 1. Compile (solc via npm)

```bash
cd packages/trader-worker
npm run compile:arena              # = node scripts/compile-arena.mjs
```

Regenerates `build/PredictionArena.json` (solc 0.8.x, ABI + bytecode), checked in so the deploy step and the Worker
integration need no toolchain.

## 2. Test (foundry)

```bash
cd packages/trader-worker/contracts
forge install foundry-rs/forge-std   # once
forge test -vv
```

`test/PredictionArena.t.sol` covers: only-resolver open/resolve, the UP/DOWN/FLAT band math, parimutuel payout +
zero-sum conservation, `approve`→`bet`→`claim`, same-side top-ups vs. opposite-side rejection, the FLAT/one-sided/
`expireStale` refund paths, and pull-based `payoutFor`. The Worker-side wiring (round-plan cursor, simulated-mode
`null` delegation, config gating, zero regression when the arena is off) is covered by `npm test` in
[`../src/arena.test.ts`](../src/arena.test.ts).

## 3. Deploy (viem)

> ⚠️ This spends **real gas** and, on mainnet, connects a **real MURMUR** market. The deployer key is read from a
> git-ignored local file and never printed. `deploy-arena-auto.mjs` **aborts on Arc mainnet (5042) unless
> `ARENA_CONFIRM=1`** is set.

Put **one** key into `packages/trader-worker/.env.local` (git-ignored) — `ECONOMY_MNEMONIC` (derives the *identical*
`accountIndex 2_000_000` gas wallet the Worker uses, so the resolver is correct) or `ARENA_DEPLOYER_PK` /
`ECONOMY_FACILITATOR_PK`:

```bash
cd packages/trader-worker
npm run deploy:arena               # = node scripts/deploy-arena-auto.mjs
```

It resolves `token` (defaults to mainnet MURMUR `0x8faa…4a5d`; verified to be a contract), `resolver` (defaults to
the Worker's own signing address, else the live `/proofs` `tx.from`) and `staleGrace`, deploys, self-verifies
`token()`/`resolver()`/`staleGrace()`/`roundCount()`, and writes the address to `contracts/ARENA_ADDRESS.txt` + back
into `.env.local`. Testnet dry run:

```bash
CHAIN_ID=5042002 ARENA_DEPLOYER_PK=0x… ARENA_TOKEN=0x… node scripts/deploy-arena.mjs
```

## 4. Wire the Worker

```bash
wrangler secret put ARENA_ADDRESS          # or set it under [vars] in wrangler.toml
# value: 0x<deployed arena address>
# then flip ARENA_ENABLED = "true" and redeploy
```

The resolver's `openRound`/`resolve` writes fire **only** when the onchain facilitator is armed with real spend on
(`ECONOMY_FACILITATOR="onchain"`, `ECONOMY_SHADOW="false"`, `ECONOMY_REAL_SPEND="true"`) — a simulated/keyless Worker
has no resolver key, so it never touches the arena. `ARENA_ADDRESS` absent or `ARENA_ENABLED="false"` ⇒ the arena step
is skipped entirely: **zero behaviour change**. Roll back instantly by setting `ARENA_ENABLED="false"` and redeploying.

## 5. Verify

- **API** — `GET /arena` returns the current + previous round (pools, odds, entry/exit temp, countdown), the
  resolver/contract addresses, and the swarm's lifetime hit-rate.
- **Frontend** — the arena drawer reads balance/allowance/your-bet and writes approve/bet/claim **directly against
  Arc RPC in the browser** (MetaMask), never through the murmur server.
- **Trustless, by hand** — read a round straight from the contract:

```bash
cast call 0x<arena> "roundInfo(uint256)(bool,bool,uint8,int64,int64,int64,uint64,uint64,uint64,uint256,uint256,uint256)" <roundId> \
  --rpc-url https://rpc.mainnet.arc.io
```

`outcome` decodes as `0 pending · 1 UP · 2 DOWN · 3 FLAT · 4 REFUND`; temperatures are r6 (÷1e6); pools are atomic
MURMUR (18-dec). Walk `RoundOpened` / `RoundResolved` / `Claimed` events to rebuild any round's full history from the
chain alone.
