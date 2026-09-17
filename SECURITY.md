# Security Policy

murmur runs **simulated and keyless by default** — it holds no private key, signs nothing, and moves no funds.
Real on-chain settlement (EIP-3009 USDC transfers on Arc) is **fully implemented but inert** until an operator
explicitly enables it with secrets and funded wallets. Because that opt-in path can move real money, we take
security seriously.

---

## Reporting a vulnerability

**Please do NOT report security vulnerabilities through public GitHub issues.**

Use a private channel instead:

1. **Preferred:** GitHub → *Security* tab → **“Report a vulnerability”** (private vulnerability reporting).
2. **Alternatively:** contact a maintainer privately (see the repository's *About* / maintainer profile).

Include as much detail as you can: the affected component (`fly-brain`, `trader-worker`, `frontend`, `x402`,
`keys`), steps or a PoC, and the impact. We will acknowledge receipt as quickly as we can and aim to give you an
initial response within **7 days**, then work toward a fix and (if you want) credit you in the release notes.

---

## Scope

The following are in scope and especially important:

- Anything that could cause **real funds to move** without the operator's explicit opt-in, or that bypasses the
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
| Accidental real spend | `ECONOMY_FACILITATOR="simulated"` by default; the onchain facilitator is only constructed when a mnemonic secret is present. |
| Runaway loss | Global daily cap (`ECONOMY_DAILY_CAP` 20), per-agent daily cap (2), per-deal cap (`ECONOMY_MAX_DEAL` 0.05). |
| Need to stop fast | Kill switch `ECONOMY_REAL_SPEND="false"` → redeploy halts all real settlement. |
| Prove before risking | `ECONOMY_SHADOW="true"` signs + `eth_call`-simulates every transfer but never broadcasts. |
| Key surface | One mnemonic HD-derives all agents (`m/44'/60'/0'/0/{id}`) + facilitator (index 2,000,000); secrets live only in Cloudflare (encrypted at rest), never in the repo. |
| Stale balance | Balances are re-read from chain immediately before signing. |

See [docs/AGENT-ECONOMY.md](./docs/AGENT-ECONOMY.md) for the full model.

---

## If a key is compromised (operator runbook)

1. Set `ECONOMY_REAL_SPEND="false"` and redeploy — stop all settlement immediately.
2. Move any remaining USDC out of the derived agent/facilitator addresses to a fresh wallet.
3. Rotate: generate a **new** mnemonic, `wrangler secret put ECONOMY_MNEMONIC`, re-derive/re-fund, and only then
   re-enable. Never reuse a compromised seed.

---

## Supported versions

Security fixes target the latest `main`. The project is pre-1.0; older revisions of the legacy (pre-`murmur`)
trading system are unsupported and should not be run.
