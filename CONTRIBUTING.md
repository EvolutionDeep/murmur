# Contributing to murmur

Thanks for your interest! murmur is an experimental art & research piece: a population of fruit-fly nervous
systems that feel the Arc market and settle with each other in USDC over x402. Contributions of any size are
welcome.

Please also read our [Code of Conduct](./CODE_OF_CONDUCT.md) and, because this project can move real funds when an
operator enables it, [SECURITY.md](./SECURITY.md).

---

## Getting set up

```bash
npm install                 # Node >= 20, npm workspaces
npm run smoke               # neural smoke test — no chain, no keys
npm run dev:worker          # local Worker → http://localhost:8787/health
```

The default configuration is **simulated and keyless**: you do not need any secret, wallet or funded account to
develop, run tests, or deploy the piece. See [docs/DEPLOYMENT.md](./docs/DEPLOYMENT.md).

---

## Where things live

| Area | Path | Start here |
|---|---|---|
| Neural core (LIF, connectome, decoding) | `packages/fly-brain` | [docs/NEURAL-SIM.md](./docs/NEURAL-SIM.md) |
| Worker, Durable Object, market, economy, x402 | `packages/trader-worker` | [docs/ARCHITECTURE.md](./docs/ARCHITECTURE.md) |
| Agent economy & settlement | `packages/trader-worker/src/economy.ts`, `x402.ts`, `keys.ts` | [docs/AGENT-ECONOMY.md](./docs/AGENT-ECONOMY.md) |
| Frontend (canvas, inspector) | `packages/frontend/public` | [docs/ARCHITECTURE.md](./docs/ARCHITECTURE.md#frontend) |

---

## Making a change

1. Create a branch off `main`.
2. Keep the change focused. Match the surrounding code's style and comment density — the codebase is
   deliberately comment-heavy because the *why* (biology, calibration, Arc quirks, safety) matters as much as the
   *what*.
3. Before opening a PR, run the gates:

   ```bash
   npm run typecheck     # tsc --noEmit for fly-brain + trader-worker (must be clean)
   npm run smoke         # neural smoke test (must pass)
   npm run build         # workspace builds where present
   ```

4. Open a PR against `main` using the template. CI (`.github/workflows/ci.yml`) re-runs these gates.

We use [Conventional Commits](https://www.conventionalcommits.org/) (`feat:`, `fix:`, `docs:`, `chore:`, …).

---

## Ground rules (please respect these)

- **Never commit secrets.** No mnemonics, private keys, `.dev.vars`, or funded addresses. Secrets are set with
  `wrangler secret put` and stay out of the repo. `.gitignore` already blocks the obvious paths — do not weaken it.
- **Never enable real spending in a PR.** `ECONOMY_FACILITATOR` stays `"simulated"` and `ECONOMY_REAL_SPEND` stays
  its default in committed config. Real-money go-live is an operator action, not a code change (see
  [docs/AGENT-ECONOMY.md](./docs/AGENT-ECONOMY.md#go-live-runbook-real-money)).
- **Don't break the safety rails.** The kill switch, shadow mode, and the global / per-agent / per-deal caps are
  load-bearing. Any change touching `x402.ts`, `keys.ts`, or the economy's onchain path needs an explicit note in
  the PR description.
- **Respect the neural invariants.** The economy is a one-directional read-out of the connectome, and spike-frequency
  adaptation (SFA) is what prevents the winner-take-all latch. Don't feed money back into the neurons or remove SFA
  without understanding [docs/NEURAL-SIM.md](./docs/NEURAL-SIM.md#the-lif-network-and-the-winner-take-all-latch).
- **Keep the frontend smooth.** Per-frame canvas work and click-driven network calls are the historic source of
  jank; heavy visuals are offscreen-cached and polled behind guards. Follow that pattern.

---

## Reporting issues

- **Bugs / features**: use the issue templates.
- **Security vulnerabilities (especially anything touching real funds or keys)**: do **not** open a public issue —
  follow the private disclosure process in [SECURITY.md](./SECURITY.md).

---

## License

By contributing, you agree your contributions will be licensed under the [MIT License](./LICENSE).
