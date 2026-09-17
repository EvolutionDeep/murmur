# Deployment

murmur deploys to two Cloudflare targets from one monorepo:

- **Worker** `murmur` — the API + cron + Durable Object, on the custom domain **`api.muros.live`**.
- **Pages** project `murmur` — the static frontend, alias **`murmur-4sx.pages.dev`**.

The **committed production config is LIVE**: it settles **real USDC on Arc mainnet** (`ECONOMY_FACILITATOR="onchain"`,
`ECONOMY_SHADOW="false"`), so a real deployment **requires secrets** and **moves real funds**. A fresh checkout with
**no `ECONOMY_MNEMONIC`** transparently falls back to the keyless simulated economy (no secrets, no funds) — that
fallback is for local development, not production.

---

## Prerequisites

- **Node.js ≥ 20** and npm (the repo uses npm workspaces).
- A **Cloudflare account** with the `muros.live` zone (for the Worker custom domain) — or change the route/project
  names in `wrangler.toml` / the frontend `deploy` script to your own.
- Arc RPC reachable from the Worker. Public `https://rpc.mainnet.arc.io` serves the **reads** (market temperature);
  the production settlement relay also **writes**, so set the `ALCHEMY_ARC_RPC_URL` secret (see below).

```bash
npm install
```

---

## Authenticate wrangler

Interactive (opens a browser):

```bash
npx wrangler login
```

Non-interactive / CI — export an API token instead (avoid the OAuth refresh flow):

```bash
export CLOUDFLARE_API_TOKEN="…"      # PowerShell: $env:CLOUDFLARE_API_TOKEN="…"
```

> The token needs Workers + Pages deploy rights. It provisions the **Worker** custom domain automatically
> (`workers_routes:write`). It typically does **not** carry DNS-write for the zone, so the **Pages** custom domain
> must be activated in the Dashboard (see below).

---

## Local development

```bash
npm run dev:worker
# → http://localhost:8787/health   ·   /population   ·   /market   ·   /economy
```

No `.dev.vars` and no keys are required. To serve the frontend locally:

```bash
npx serve packages/frontend/public -l 8788
```

---

## Deploy

```bash
npm run deploy:worker       # wrangler deploy  (Worker "murmur" + api.muros.live + cron + DO migration)
npm run deploy:frontend     # wrangler pages deploy public --project-name=murmur --branch=main
npm run deploy              # both
```

The Worker config lives in [`packages/trader-worker/wrangler.toml`](../packages/trader-worker/wrangler.toml):
`compatibility_date`, `nodejs_compat`, the `api.muros.live` custom-domain route, the `* * * * *` cron, the
`FlyStateDO` Durable Object binding with a `v1` **SQLite** storage migration, `[vars]`, and observability.

---

## Verify

```bash
curl https://api.muros.live/health
# {"ok":true,"name":"murmur","chain":"arc", ...}

curl https://api.muros.live/economy
# → facilitator mode "onchain", asset 0x3600…0000 (Arc USDC), liveAgents 24, real settlement txHashes
```

> **Dev-machine note:** some networks DNS-sinkhole `*.workers.dev`. Use the custom domain (`api.muros.live`) or
> verify from a normal browser. With `curl` on Windows use `curl.exe` for external hosts.

---

## Custom domains

| Target | Domain | How it's provisioned |
|---|---|---|
| Worker | `api.muros.live` | Automatic on `wrangler deploy` (route `custom_domain = true`) |
| Pages | `murmur-4sx.pages.dev` | Automatic alias for the `main` branch |
| Pages | `muros.live` / `www.muros.live` | **Manual**: Dashboard → Workers & Pages → `murmur` → Custom domains → *Activate* (adds the CNAME → `murmur-4sx.pages.dev`), or add the CNAME yourself. Pages custom-domain activation is a Dashboard step — there is no CLI equivalent. |

---

## Secrets (required for the LIVE production deployment)

The committed config settles **real USDC**, so the deployed Worker **needs** these secrets (set out-of-band, never
committed). Omit them and the Worker falls back to the keyless simulated economy — fine for local dev, **not** for
production:

```bash
npx wrangler secret put ECONOMY_MNEMONIC          # one BIP-39 seed → all agent wallets + gas wallet
npx wrangler secret put ECONOMY_FACILITATOR_PK    # optional dedicated gas-wallet key (else derived from the seed)
npx wrangler secret put ALCHEMY_ARC_RPC_URL       # private Arc mainnet endpoint used to relay the real transfers
```

For local dev, copy [`packages/trader-worker/.dev.vars.example`](../packages/trader-worker/.dev.vars.example) to
`.dev.vars` (gitignored). Then follow the **go-live runbook** and safety rails in
[**AGENT-ECONOMY.md**](./AGENT-ECONOMY.md) — including funding the derived wallets with
[`scripts/fund-agents.mjs`](../packages/trader-worker/scripts/fund-agents.mjs) and proving the path in
`ECONOMY_SHADOW="true"` before any real USDC moves.

---

## Configuration

All non-sensitive config is in `wrangler.toml` `[vars]`, with authoritative defaults + clamping in
[`src/config.ts`](../packages/trader-worker/src/config.ts). The full variable table is in the
[README](../README.md#configuration-reference).

---

## Quality gates & rollback

```bash
npm run typecheck     # tsc --noEmit for fly-brain + trader-worker
npm test              # 36 unit tests (connectome · LIF · motor decoder · economy)
npm run smoke         # neural smoke test (no chain, no keys)
npm run build         # workspace builds (where present)
```

CI runs these on every push/PR — see [`.github/workflows/ci.yml`](../.github/workflows/ci.yml).

**Rollback / kill switch** (the production deployment moves real money):

- Halt all real settlement instantly: set `ECONOMY_REAL_SPEND="false"` → `npm run deploy:worker`.
- Revert to the keyless simulated economy: set `ECONOMY_FACILITATOR="simulated"` → redeploy.
- Redeploy a previous Worker version from the Cloudflare Dashboard (Workers → murmur → Deployments → Rollback).
