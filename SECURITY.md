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

## Supported versions

Security fixes target the latest `main`. The project is pre-1.0; older revisions of the legacy (pre-`murmur`)
trading system are unsupported and should not be run.
