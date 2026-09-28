# Security Policy

murmur's **production deployment is LIVE**: the deployed Worker holds an HD-wallet mnemonic and settles **real
USDC on Arc mainnet** (EIP-3009 `transferWithAuthorization`), bounded by a kill switch and per-day / per-deal caps.
The **repository itself ships no secret** — a fresh checkout with no `ECONOMY_MNEMONIC` runs the keyless
`SimulatedFacilitator` and moves nothing. Because the deployed system moves real money, we take security seriously.

---

## Reporting a vulnerability

**Please do NOT report security vulnerabilities through public GitHub issues.**

Use a private channel instead:

1. **Preferred:** GitHub → *Security* tab → **“Report a vulnerability”** (private vulnerability reporting).
2. **Alternatively:** email a maintainer at the public address listed on the repository's *About* / GitHub profile
   (please include “murmur security” in the subject so it isn’t missed).
3. As a last resort, reach a maintainer privately via the repository's *About* / maintainer profile.

Include as much detail as you can: the affected component (`fly-brain`, `trader-worker`, `frontend`, `x402`,
`keys`), steps or a PoC, and the impact. We will acknowledge receipt as quickly as we can and aim to give you an
initial response within **7 days**, then work toward a fix and (if you want) credit you in the release notes.

---

## Scope

The following are in scope and especially important:

- Anything that could cause **real funds to move** beyond the operator's configured rails, or that bypasses the
  safety rails (kill switch `ECONOMY_REAL_SPEND`, `ECONOMY_SHADOW`, global / per-agent / per-deal caps) in
  [`x402.ts`](./packages/trader-worker/src/x402.ts) / [`economy.ts`](./packages/trader-worker/src/economy.ts).
- **Key/secret handling** in [`keys.ts`](./packages/trader-worker/src/keys.ts) (HD derivation, EIP-3009 signing,
  the facilitator gas wallet), or any path that could leak a mnemonic/private key (logs, error messages, responses).
- **EIP-3009 / EIP-712 correctness**: signature malleability, domain-separator mismatches, replay across chains or
  agents, authorization reuse.
- Worker/DO **input validation** and any route that could corrupt the shared singleton state (`/stimulus`,
  `/tick`, `/reset`, `/snapshot`).
- Frontend issues that could exfiltrate data or misrepresent balances/settlements.

Out of scope: the simulated ledger's economics, cosmetic UI issues, and findings that require the operator to have
already committed a secret to the repo (that is a deployment mistake, not a code vulnerability — see below).

---

## Threat model & built-in safeguards

| Concern | Safeguard |
|---|---|
| Accidental real spend | The onchain facilitator is constructed **only** when a mnemonic secret is present; without it the Worker runs the keyless simulated ledger. Every real transfer is bounded by the caps + kill switch below. |
| Runaway loss | Global daily cap (`ECONOMY_DAILY_CAP` 100), per-agent daily cap (10), per-deal cap (`ECONOMY_MAX_DEAL` 0.05). |
| Need to stop fast | Kill switch `ECONOMY_REAL_SPEND="false"` → redeploy halts all real settlement. |
| Prove before risking | `ECONOMY_SHADOW="true"` signs + `eth_call`-simulates every transfer but never broadcasts. |
| Key surface | One mnemonic HD-derives all agents (`m/44'/60'/0'/0/{id}`) + facilitator (index 2,000,000); secrets live only in Cloudflare (encrypted at rest), never in the repo. |
| Stale balance | Balances are re-read from chain immediately before signing. |
| Debug-endpoint abuse | The mutating `POST /tick` and `/reset` routes can be locked with the optional `ADMIN_TOKEN` secret: when it is set, callers must present it (`x-admin-token` header or `?token=`), so a live deployment's debug endpoints can't be driven anonymously. Unset, they stay open for local development. The scheduled cron presents the token internally, so locking these endpoints never interrupts the per-minute tick. |

See [docs/AGENT-ECONOMY.md](./docs/AGENT-ECONOMY.md) for the full model.

---

## If a key is compromised (operator runbook)

1. Set `ECONOMY_REAL_SPEND="false"` and redeploy — stop all settlement immediately.
2. Move any remaining USDC out of the derived agent/facilitator addresses to a fresh wallet.
3. Rotate: generate a **new** mnemonic, `wrangler secret put ECONOMY_MNEMONIC`, re-derive/re-fund, and only then
   re-enable. Never reuse a compromised seed.

---

## Independent verification & audit status

**Honest state:** murmur has **not** yet been reviewed by an external professional auditing firm, and there is no
third-party report we can point to. We are actively seeking one. In the meantime we are building trust through
*provable transparency* rather than authority — the system is designed so **you can verify it yourself**, without
trusting us:

- **Deterministic, keyless verification.** The public read-only API ([`/openapi.json`](https://api.muros.live/openapi.json),
  docs at [muros.live/developers](https://muros.live/developers)) is a live window into the economy — no key required.
- **Provably-not-an-LLM chronicle.** Every history line is rendered from a public template and folded into a
  SHA-256 hash chain; the rule-set has a single fingerprint (`chroniclerHash`, served on `/annals`) that your browser
  re-derives. Any tampering breaks the chain or the fingerprint.
- **On-chain, non-custodial money flow.** All value movement is EIP-3009 USDC on **Arc mainnet (chainId 5042)**.
  The contracts holding/deciding funds are immutable and public — read them directly, no operator trust:

  | Contract | Address (Arc mainnet) | Role |
  |---|---|---|
  | USDC (native) | `0x3600000000000000000000000000000000000000` | settlement asset |
  | WarCoffer | `0x3d900b8d1d48b46fc18a3f57dfd15a4a28bb454b` | escrows war stakes; winner computed on-chain |
  | NeuralReceiptRegistry | `0x94d0c38bcc9957eaf8f318e6bbc6557f8cc3c815` | on-chain receipt hash-chain head |
  | NeuralManifestRegistry | `0x3412eb909252adb983aaf793f97a3754ca029a37` | commits each brain manifest |
  | ConnectomeLineage | `0x482b7a3bbef796c9627d86d5a23c67728a78096f` | on-chain family tree |

  Reproduce a balance or a settlement independently, e.g.:

  ```bash
  cast call 0x3d900b8d1d48b46fc18a3f57dfd15a4a28bb454b "warCount()(uint256)" --rpc-url https://rpc.mainnet.arc.io
  cast call 0x94d0c38bcc9957eaf8f318e6bbc6557f8cc3c815 "chainHead()(bytes32)" --rpc-url https://rpc.mainnet.arc.io
  ```

  The Worker’s `/proofs/verify` endpoint reports whether its head matches the on-chain registry head and tx.
- **In-repo assurance.** 372 unit tests (behavioural, chain-free) + Foundry unit/fuzz invariants under
  `packages/trader-worker/contracts`, run by CI on every push.

If you have run — or want to run — an independent audit or a reproduction of the on-chain flows, we would welcome
it: open a private report (above) or reach out for credit.

---

## Disclosed Centralization & Trust Assumptions

The following are **known, intentional** centralization points and trust assumptions. They are disclosed here
rather than treated as vulnerabilities because each is a deliberate design trade-off with bounded blast radius.

### 1. PredictionArena resolver as a trusted oracle for `exitTempR6`

**The assumption.** `PredictionArena.resolve(roundId, exitTempR6)` accepts the exit temperature from the
resolver (`0x2b9a…055c`, immutable). This value is computed off-chain by the Worker's cron and is **not bound
to any on-chain oracle**. A malicious or compromised resolver could theoretically feed a false temperature to
steer UP/DOWN/FLAT.

**Mitigation.**
- The **entry temperature** and **flatBand** are committed on-chain at `openRound` time — these cannot be
  altered after the fact.
- The temperature is independently recomputable from Arc's public whole-chain activity (the same blocks anyone
  can read). The `/predictions` feed publishes each round's entry + exit temperatures, so any observer can
  re-derive the expected outcome and detect manipulation.
- The resolver wallet is the Worker's own facilitator — compromising it already compromises the entire economy
  (a strictly larger attack surface than the arena alone).

**Discoverability.** A manipulated resolution is detectable by comparing the committed `exitTempR6` against an
independent recomputation from Arc block data for the round's time window.

**Why accepted.** Migrating to an on-chain oracle (or a decentralized resolver) would require redeploying
`PredictionArena` — the current contract is immutable with no rescue/withdraw, so migration would **strand all
unclaimed MURMUR bets** in the old contract permanently. The arena is MURMUR-denominated (not USDC),
non-custodial, and the total exposure is bounded by the pool size at any given round.

### 2. WarCoffer is a one-way sunk pool (~50 USDC)

**The assumption.** `WarCoffer` (`0x3d90…b454b`) has **no withdraw, no rescue, no emergency extraction**.
Once USDC enters via `deposit`, it exists only as internal `mapping` balances (vault/commonsPurse). The
contract's `maxEscrow` is 50 USDC (immutable), and `totalEscrow` has reached this cap — the pool is
permanently full.

**Mitigation.**
- The funds are the project's own (self-funded from the facilitator wallet); no third-party deposits exist.
- The exposure is bounded at 50 USDC and cannot grow (the `EscrowCap` revert is a hard on-chain ceiling).
- War outcomes are deterministic: `resolveWar` derives the winner from
  `keccak256(warId, attacker, defender, powerA, powerB)` — no external input at resolution time.

**Discoverability.** The resolver's `declareWar` parameters (powerA/powerB) are chosen off-chain and could
theoretically be manipulated to favour one side. However: (a) only the project's own bounded funds are at
stake, (b) the `previewWinner` function and the public `/war` feed expose the power values before resolution,
and (c) any manipulation is visible in the on-chain event log.

**Why accepted.** Redeploying `WarCoffer` would strand the ~50 USDC already deposited (no extraction path
exists). The amount is bounded, self-funded, and the sunk-pool design is intentional — it prevents any
operator from draining the treasury.

### 3. War-rail bypasses the economy daily cap

**The assumption.** War deposits (`economy.cofferDeposit → x402.deposit`) do **not** pass through
`spendCapReason` — the daily-cap / per-agent-cap / per-deal-cap system that bounds normal trade settlements.

**Mitigation.**
- The war track has its own stricter limits:
  `target = min(max(WAR_MIN_VAULT_USDC, WAR_PER_WAR_CAP_USDC / WAR_STAKE_PCT), WAR_MAX_ESCROW_USDC / 2)`
  — producing a single-war cap of 25 USDC and a two-house total of exactly 50 USDC.
- The on-chain `EscrowCap` (immutable `maxEscrow = 50e6 = 50 USDC`) is a **hard ceiling** that cannot be
  bypassed regardless of worker-side logic. It is already at capacity.
- Gated behind `WAR_ENABLED` + `ECONOMY_REAL_SPEND` + `!ECONOMY_SHADOW`.

**Discoverability.** The total escrowed is publicly readable:
`cast call 0x3d90…b454b "totalEscrow()(uint256)"`.

**Why accepted.** The exposure cannot grow beyond 50 USDC (the immutable cap is already saturated). The
war-rail's own formula is more restrictive than the economy's daily cap for the amounts involved.

### 4. Governance voting uses instant balance-weighting

**The assumption.** The `/community` governance forum weights votes by the voter's **current** MURMUR balance
at signature-verification time. This permits:
- Buy → vote → sell (flash-loan-style governance attack).
- Multi-wallet splitting to amplify apparent support.

**Mitigation.**
- The community layer is **read-only on-chain** — it cannot move treasury funds, alter contract parameters, or
  change the Worker's behaviour. It only produces a governance *signal*.
- MURMUR's utility is burning for intervention rights (not treasury governance), so the economic incentive to
  attack a non-binding signal is minimal.
- A snapshot-based scheme (balance at a past block) is under evaluation; the Arc public RPC has confirmed
  full archive node availability, making historical balance queries feasible.

**Discoverability.** Vote weights and voter addresses are public in the `/community` response.

**Why accepted.** The governance forum has no on-chain execution power — it is advisory. Implementing
snapshot voting requires archive-node balance queries at proposal-creation time, which adds latency and a new
failure mode for a non-critical feature. The trade-off favours simplicity until the forum gains real authority.

### 5. `ADMIN_TOKEN` fail-open semantics

**The assumption.** The `adminGate` function in `state.ts` returns `null` (pass-through) when `ADMIN_TOKEN` is
not set. This means `POST /tick` and `POST /reset` are **unauthenticated by default** in a fresh local checkout.

**Production status.** `ADMIN_TOKEN` **is set** on the production deployment (the value lives exclusively in
the operator's local `.env.local` and as a Cloudflare Workers secret — it is never committed to the repository
or disclosed in this document). The fail-open path therefore only applies to local development environments
where no secret has been configured.

**Mitigation.**
- This is intentional for local development (zero-secret checkout ⇒ full functionality).
- In production, `ADMIN_TOKEN` is set as a Cloudflare secret; when present, the gate requires
  `x-admin-token` header (header-only — the legacy `?token=` query param was removed).
- The `scheduled()` cron handler presents the token internally, so setting it never interrupts the per-minute
  tick.
- `POST /reset` triggers a PoCA admin kind-1 (RESET) + epoch seal, making any unauthorised reset permanently
  visible in the continuity chain.
- **`POST /tick` amplification risk mitigated:** previously an unauthenticated `/tick` could trigger a real-wallet
  broadcast + flush admin logs on-chain. With the token set, the endpoint is gated. Additionally, admin kind-2
  (`MANUAL_TICK`) is now **local-log only** (never mirrored on-chain) and rate-limited to one entry per 5-minute
  window — so even if the gate were bypassed, the attacker cannot spam on-chain transactions or flood the
  admin log.

**Discoverability.** `GET /poca/admin` logs every reset/manual-tick invocation with a timestamp.

**Why accepted.** The fail-open default is a deliberate developer-experience choice for local environments.
The production deployment has `ADMIN_TOKEN` set; a deployment that omits it is a misconfiguration (documented
in `docs/DEPLOYMENT.md`), not a code vulnerability. The PoCA admin log provides after-the-fact accountability
even if the gate is open.

---

## Supported versions

Security fixes target the latest `main`. The project is pre-1.0; older revisions of the legacy (pre-`murmur`)
trading system are unsupported and should not be run.
