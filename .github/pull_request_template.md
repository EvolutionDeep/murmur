<!--
Thanks for contributing to murmur!

Security issue involving real funds or private keys? Do NOT open a public PR that
exposes it — read SECURITY.md at the repository root first and disclose privately.
-->

## What does this change?

<!-- A concise summary of the change and the motivation. Link related issues, e.g. "Closes #123". -->

## Type of change

- [ ] 🐛 Bug fix (non-breaking)
- [ ] ✨ New capability (non-breaking)
- [ ] 📚 Docs only
- [ ] ♻️ Refactor / chore (no behaviour change)
- [ ] ⚠️ Touches the economy / x402 / keys / safety rails — please add a note below

## Ground rules checklist

<!-- From CONTRIBUTING.md. These are load-bearing for a project that can move real funds. -->

- [ ] No secrets committed (no mnemonic, private key, or `.dev.vars`).
- [ ] Real-money spending stays **off** by default (`ECONOMY_FACILITATOR="simulated"`, `ECONOMY_REAL_SPEND` at its default); safety rails unchanged, or explicitly noted below.
- [ ] Neural invariants respected (economy is a one-way read-out; spike-frequency adaptation intact).
- [ ] Frontend stays smooth (heavy visuals offscreen-cached; no per-frame or click-driven network calls).
- [ ] `npm run typecheck`, `npm run build`, and `npm run smoke` all pass locally.

## How has this been tested?

<!-- What you ran and what you observed. For neural / economy changes, paste the smoke output. -->

## Notes for reviewers

<!-- Anything risky, subtle, or worth a second pair of eyes. Delete if not needed. -->
