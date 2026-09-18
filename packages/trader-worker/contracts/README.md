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

> ⚠️ This spends **real gas**. Point at Arc **testnet** (`CHAIN_ID=5042002`) first, then mainnet
> (`CHAIN_ID=5042`). The deployer key is a plain env var — never commit it.

```bash
cd packages/trader-worker
# testnet dry run
CHAIN_ID=5042002 REGISTRY_DEPLOYER_PK=0x… node scripts/deploy-registry.mjs
# mainnet, seeding the CURRENT /proofs chain head so the first commit chains onto history
CHAIN_ID=5042 \
REGISTRY_DEPLOYER_PK=0x… \
REGISTRY_GENESIS_HEAD=$(curl -s https://api.muros.live/proofs | jq -r .chainHead) \
node scripts/deploy-registry.mjs
```

Env:

| var | required | meaning |
| --- | --- | --- |
| `REGISTRY_DEPLOYER_PK` | yes | deployer **and** default `committer` (the gas wallet) |
| `REGISTRY_COMMITTER` | no | committer address if different from the deployer |
| `REGISTRY_GENESIS_HEAD` | no | `0x…64` head to `seedGenesis()` after deploy (adopt the pre-existing off-chain chain so the first on-chain commit chains onto it) |
| `RPC_URL` / `CHAIN_ID` | no | default to Arc mainnet `5042` / `https://rpc.mainnet.arc.io` |

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
