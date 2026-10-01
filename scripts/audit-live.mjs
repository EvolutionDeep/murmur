#!/usr/bin/env node
// audit-live.mjs — the STANDALONE read-only OPERATIONS + MONEY-BOUNDARY auditor for murmur (task #87).
//
// WHAT IT IS. One command that pulls EVERY public read-only endpoint of the live worker and checks the
// operational + real-money invariants that no other tool gathers in one place:
//   - is the brain still deterministic at runtime?  (/manifest vs /manifest/replay)
//   - is the PoCA anchor live and unbroken?         (/poca continuity + mirror health)
//   - does the settlement ledger close on itself?   (settleOk + settleFail == settleAttempts)
//   - are the real-money CEILINGS still at their committed bounds? (wrangler.toml [vars])
// It trusts only PUBLIC data + the committed wrangler.toml. It reads NO secret, sends NO write, and touches
// NO money path — it is a pure observer. A breach of a real-money bound is a FAIL (exit 1) so this can gate a
// deploy; an unreachable endpoint is a SKIP (never a false FAIL), matching scripts/poca-verify.mjs.
//
// HOW IT DIFFERS FROM ITS NEIGHBOURS (so it is additive, not a duplicate):
//   - scripts/poca-verify.mjs  → the SEVEN PoCA continuity criteria (chain seal-chain, Merkle proofs, asset
//     continuity). Focused on "was the program swapped / the chain broken". This tool does NOT re-do those.
//   - scripts/check-knob-defaults.mjs (`check:knobs`) → that wrangler.toml and src/config.ts AGREE on each knob
//     DEFAULT. It never checks the ABSOLUTE bound. This tool checks the bound (daily ≤ 100, per-agent ≤ 10, …).
//   - this tool → live RUNTIME operating health + money-boundary closure, in one exit-coded report.
//
// DEPENDENCIES: NONE beyond Node built-ins (`fetch`, `fs`). No npm install, no wallet, no RPC.
//
// USAGE
//   node scripts/audit-live.mjs                       # audit the live worker (default https://api.muros.live)
//   node scripts/audit-live.mjs --api https://…       # audit another read-only base
//   node scripts/audit-live.mjs --offline             # check only the committed wrangler.toml bounds (no fetch)
//   node scripts/audit-live.mjs --netpending-max 20000 --success-floor 0.5 --json
// Exit code: 0 when nothing FAILs (PASS/SKIP/WARN all exit 0); 1 when any bound/invariant FAILs; 2 on fatal.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const WRANGLER_TOML = resolve(HERE, "../packages/trader-worker/wrangler.toml");
const DEFAULT_API = "https://api.muros.live";

// Committed real-money ceilings. These are the IMMUTABLE bounds — an audit FAILs if a live value EXCEEDS them.
// (Raising any of these is a deliberate, separately-approved act; the auditor exists to catch drift.)
const BOUND = {
  dailyCapUsdcMax: 100,        // ECONOMY_DAILY_CAP
  perAgentDailyCapUsdcMax: 10, // ECONOMY_PER_AGENT_DAILY_CAP
  maxDealUsdcMax: 0.05,        // ECONOMY_MAX_DEAL
  expectedChainId: 5042,       // Arc mainnet (NEVER testnet in a prod audit)
};

// ------------------------------ minimal wrangler.toml [vars] reader ------------------------------
// Returns { value, active } — active=true when the line is an ENABLED var, active=false when it is only a
// commented "# KEY = value" default, null when the key is absent entirely (then the coded default governs).
// A key often appears in several COMMENT lines before its active definition, so this PREFERS an uncommented
// [vars] line and only falls back to the first commented example when no active line exists.
function readTomlVar(toml, key) {
  const lines = toml.split(/\r?\n/);
  const valRe = new RegExp(`^\\s*#?\\s*${key}\\s*=\\s*"([^"]*)"`);
  let commented = null;
  for (const line of lines) {
    const m = line.match(valRe);
    if (!m) continue;
    const isActive = !/^\s*#/.test(line);
    if (isActive) return { value: m[1], active: true };   // the enabled definition wins
    if (commented === null) commented = m[1];             // remember the first commented default
  }
  return commented === null ? { value: null, active: null } : { value: commented, active: false };
}

// ------------------------------ HTTP JSON reader (read-only, with abort) ------------------------------
async function getJson(url, { timeoutMs = 20000 } = {}) {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: ac.signal, headers: { accept: "application/json" } });
    if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
    return await res.json();
  } finally {
    clearTimeout(t);
  }
}

// ------------------------------ verdict primitives ------------------------------
// Each check returns { id, group, status: "PASS"|"WARN"|"FAIL"|"SKIP", detail }.
const PASS = (id, group, detail) => ({ id, group, status: "PASS", detail });
const WARN = (id, group, detail) => ({ id, group, status: "WARN", detail });
const FAIL = (id, group, detail) => ({ id, group, status: "FAIL", detail });
const SKIP = (id, group, detail) => ({ id, group, status: "SKIP", detail });

// ------------------------------ group A: committed money-boundary (wrangler.toml) ------------------------------
function auditMoneyBounds() {
  const out = [];
  let toml;
  try { toml = readFileSync(WRANGLER_TOML, "utf8"); }
  catch (e) { return [FAIL("toml-readable", "money", `cannot read wrangler.toml: ${e.message}`)]; }

  const num = (v) => (v == null || v === "" ? null : Number(v));
  const boundCheck = (key, value, max, id) => {
    if (value.active === null) return SKIP(id, "money", `${key} absent in toml — coded default governs (see check:knobs)`);
    const n = num(value.value);
    if (n == null || Number.isNaN(n)) return FAIL(id, "money", `${key}="${value.value}" is not numeric`);
    const tag = value.active ? "active" : "commented-default";
    if (n > max) return FAIL(id, "money", `${key}=${n} USDC (${tag}) EXCEEDS the committed ceiling ${max}`);
    return PASS(id, "money", `${key}=${n} USDC (${tag}) within ceiling ${max}`);
  };

  out.push(boundCheck("ECONOMY_DAILY_CAP", readTomlVar(toml, "ECONOMY_DAILY_CAP"), BOUND.dailyCapUsdcMax, "daily-cap"));
  out.push(boundCheck("ECONOMY_PER_AGENT_DAILY_CAP", readTomlVar(toml, "ECONOMY_PER_AGENT_DAILY_CAP"), BOUND.perAgentDailyCapUsdcMax, "per-agent-cap"));
  out.push(boundCheck("ECONOMY_MAX_DEAL", readTomlVar(toml, "ECONOMY_MAX_DEAL"), BOUND.maxDealUsdcMax, "max-deal"));

  // Chain id: a prod audit must never find the worker pointed at testnet.
  const chain = readTomlVar(toml, "CHAIN_ID");
  if (chain.active === null) out.push(SKIP("chain-id", "money", "CHAIN_ID absent in toml — coded default governs"));
  else if (Number(chain.value) !== BOUND.expectedChainId) out.push(FAIL("chain-id", "money", `CHAIN_ID=${chain.value} ≠ ${BOUND.expectedChainId} (Arc mainnet)`));
  else out.push(PASS("chain-id", "money", `CHAIN_ID=${chain.value} (Arc mainnet)`));

  // Facilitator + shadow: report the posture (not a pass/fail — both onchain-live and simulated are valid states,
  // but a prod audit wants to KNOW which one it is looking at).
  const fac = readTomlVar(toml, "ECONOMY_FACILITATOR");
  const shadow = readTomlVar(toml, "ECONOMY_SHADOW");
  const posture = `facilitator=${fac.value ?? "?"} (${fac.active ? "active" : "default"}), shadow=${shadow.value ?? "?"} (${shadow.active ? "active" : "default"})`;
  out.push((fac.value === "onchain" && shadow.value === "false")
    ? WARN("money-posture", "money", `REAL SPEND ARMED — ${posture}`)
    : PASS("money-posture", "money", `no live real spend — ${posture}`));
  return out;
}

// ------------------------------ group B: live continuity anchor (/poca) ------------------------------
async function auditAnchor(api) {
  let poca;
  try { poca = await getJson(`${api}/poca`); } catch (e) { return [SKIP("poca", "anchor", `/poca unreachable: ${e.message}`)]; }
  const out = [];
  const cc = String(poca.codeCommitment || "");
  const ccHex = cc.replace(/^0x/i, "");
  out.push(/^[0-9a-fA-F]{64}$/.test(ccHex) && !/^0+$/.test(ccHex)
    ? PASS("code-commitment", "anchor", `codeCommitment ${ccHex.slice(0, 10)}…${ccHex.slice(-6)}`)
    : FAIL("code-commitment", "anchor", `codeCommitment missing/zero: "${cc}"`));
  out.push(poca.continuity === "unbroken"
    ? PASS("continuity", "anchor", `continuity=unbroken (epochCount ${poca.epochCount}, currentEpoch ${poca.currentEpoch})`)
    : FAIL("continuity", "anchor", `continuity="${poca.continuity}" (expected unbroken)`));
  const m = poca.mirror;
  if (m && typeof m === "object") {
    if (m.paused === true) out.push(WARN("mirror", "anchor", `on-chain mirror PAUSED (failures ${m.failures ?? 0}) — chain criteria backstop divergence`));
    else if (m.aligned === false) out.push(WARN("mirror", "anchor", `mirror aligned=false (${m.failures ?? 0} failures) — chain criteria backstop divergence`));
    else out.push(PASS("mirror", "anchor", `mirror aligned (failures ${m.failures ?? 0})`));
  } else out.push(SKIP("mirror", "anchor", "no /poca.mirror field (older worker)"));
  return out;
}

// ------------------------------ group C: brain determinism (/manifest + /manifest/replay) ------------------------------
async function auditBrain(api) {
  let man, replay;
  try { man = await getJson(`${api}/manifest`); } catch (e) { return [SKIP("manifest", "brain", `/manifest unreachable: ${e.message}`)]; }
  try { replay = await getJson(`${api}/manifest/replay`); } catch (e) { return [SKIP("replay", "brain", `/manifest/replay unreachable: ${e.message}`)]; }
  const out = [];
  out.push(replay.ok === true && (replay.mismatches || []).length === 0
    ? PASS("replay-ok", "brain", `replay ok — ${replay.checked ?? "?"} node(s) checked, 0 mismatch`)
    : FAIL("replay-ok", "brain", `replay NOT self-consistent: ok=${replay.ok} mismatches=${(replay.mismatches || []).length}`));
  out.push(man.manifestHash && replay.manifestHash && man.manifestHash === replay.manifestHash
    ? PASS("manifest-agree", "brain", `manifestHash agrees (${String(man.manifestHash).slice(0, 12)}…)`)
    : FAIL("manifest-agree", "brain", `manifestHash mismatch: /manifest=${man.manifestHash} vs /manifest/replay=${replay.manifestHash}`));
  return out;
}

// ------------------------------ group D: runtime accounting + operations (/economy + /health) ------------------------------
async function auditOperations(api, args) {
  let econ, health;
  const out = [];
  try { econ = await getJson(`${api}/economy`); } catch (e) { out.push(SKIP("economy", "ops", `/economy unreachable: ${e.message}`)); }
  try { health = await getJson(`${api}/health`); } catch (e) { out.push(SKIP("health", "ops", `/health unreachable: ${e.message}`)); }

  if (health) {
    out.push(health.ok === true
      ? PASS("health-ok", "ops", `health.ok=true (chain ${health.chain}, features ${(health.features || []).length})`)
      : FAIL("health-ok", "ops", `health.ok=${health.ok}`));
  }

  const t = econ && econ.totals;
  if (t) {
    // (1) ledger closure: the two success/failure counters must sum to the attempt count — a gap means a settle
    //     neither recorded as mined nor as failed (lost accounting).
    const attempts = Number(t.settleOk) + Number(t.settleFail);
    out.push(t.settleAttempts === attempts
      ? PASS("settle-closure", "ops", `settleOk ${t.settleOk} + settleFail ${t.settleFail} == settleAttempts ${t.settleAttempts}`)
      : FAIL("settle-closure", "ops", `settleOk+settleFail (${attempts}) != settleAttempts (${t.settleAttempts})`));
    // (2) settled volume is a finite non-negative number.
    out.push(Number.isFinite(t.volumeUsdc) && t.volumeUsdc >= 0
      ? PASS("volume-finite", "ops", `lifetime volume ${t.volumeUsdc} USDC`)
      : FAIL("volume-finite", "ops", `volumeUsdc not finite/non-negative: ${t.volumeUsdc}`));
    // (3) the pending-net accumulator must stay bounded — runaway growth signals a flush stall.
    out.push(Number(t.netPending) <= args.netPendingMax
      ? PASS("netpending-bounded", "ops", `netPending ${t.netPending} ≤ ${args.netPendingMax}`)
      : WARN("netpending-bounded", "ops", `netPending ${t.netPending} > ${args.netPendingMax} — flush may be stalling`));
    // (4) a catastrophic settle-success rate is a WARN (gas/RPC health), not a FAIL (dust debtors skew it by design).
    if (t.successRate != null) {
      out.push(t.successRate >= args.successFloor
        ? PASS("success-rate", "ops", `successRate ${(t.successRate * 100).toFixed(2)}% ≥ ${(args.successFloor * 100).toFixed(0)}%`)
        : WARN("success-rate", "ops", `successRate ${(t.successRate * 100).toFixed(2)}% < ${(args.successFloor * 100).toFixed(0)}% — check RPC/gas + dust debtors`));
    } else out.push(SKIP("success-rate", "ops", "no settle attempts yet (successRate null)"));
  }

  // (5) the live population must never exceed the declared ceiling.
  if (econ) {
    let maxPop = null;
    try { const st = await getJson(`${api}/state`); maxPop = st && st.config && st.config.maxLivePopulation; } catch { /* state optional */ }
    const live = t ? Number(t.liveAgents) : null;
    if (live != null && maxPop != null) {
      out.push(live <= maxPop
        ? PASS("population", "ops", `liveAgents ${live} ≤ maxLivePopulation ${maxPop}`)
        : FAIL("population", "ops", `liveAgents ${live} > maxLivePopulation ${maxPop}`));
    } else out.push(SKIP("population", "ops", `live=${live}, max=${maxPop} (missing field)`));
  }

  // (6) CHRONICLE FRESHNESS (liveness) — the top /history row is written once per cron, and /history is served
  //     straight from D1 by the Worker (NEVER a swarm-DO round-trip), so it stays reachable even while the DO is
  //     wedged. If its timestamp goes stale past the bound while every other read-out still looks "healthy", the
  //     world has FROZEN but the P2 heartbeat (lastCron, stamped at cron START before any advance) is masking it —
  //     the exact multi-hour production freeze this auditor previously passed. A stale chronicle is a FAIL. An
  //     unreachable /history is a SKIP (never a false FAIL). Bound is calibrated to the real ~140–200s cron
  //     period (cronRunning guard silently SKIPS intermediate beats), so only a genuine stall crosses it.
  {
    let hist;
    try { hist = await getJson(`${api}/history?limit=1`); }
    catch (e) { out.push(SKIP("chronicle-fresh", "ops", `/history unreachable: ${e.message}`)); }
    if (hist) {
      const row = Array.isArray(hist.rows) && hist.rows.length ? hist.rows[0] : null;
      const ts = row ? Number(row.ts ?? row.createdAt ?? row.time) : NaN;
      if (!row || !Number.isFinite(ts)) out.push(SKIP("chronicle-fresh", "ops", "no usable /history top-row timestamp"));
      else {
        const ageMs = Date.now() - ts;
        const ageS = Math.round(ageMs / 1000);
        const boundS = Math.round(args.chronicleMaxAge / 1000);
        out.push(ageMs <= args.chronicleMaxAge
          ? PASS("chronicle-fresh", "ops", `latest chronicle tick ${row.tick} is ${ageS}s old ≤ ${boundS}s`)
          : FAIL("chronicle-fresh", "ops", `chronicle FROZEN: latest tick ${row.tick} is ${ageS}s old > ${boundS}s (heartbeat masking a stalled /tick — the world is not advancing)`));
      }
    }
  }
  return out;
}

// ------------------------------ report rendering ------------------------------
function renderText(report) {
  const L = [];
  L.push("═".repeat(78));
  L.push("  murmur live audit — operations + money-boundary (read-only, task #87)");
  L.push("═".repeat(78));
  L.push(`  api      : ${report.api}`);
  L.push(`  mode     : ${report.offline ? "OFFLINE (committed bounds only)" : "LIVE (read-only endpoint probes)"}`);
  L.push(`  generated: ${report.generatedAt}`);
  for (const group of ["money", "anchor", "brain", "ops"]) {
    const rows = report.checks.filter((c) => c.group === group);
    if (!rows.length) continue;
    L.push("");
    L.push(`  ── ${group.toUpperCase()} ──`);
    for (const c of rows) L.push(`   [${c.status}] ${c.id} — ${c.detail}`);
  }
  L.push("");
  L.push("─".repeat(78));
  L.push(`  VERDICT: ${report.verdict}  (${report.summary.pass} PASS · ${report.summary.warn} WARN · ${report.summary.fail} FAIL · ${report.summary.skip} SKIP)`);
  L.push("─".repeat(78));
  return L.join("\n");
}

// ------------------------------ CLI ------------------------------
function parseArgs(argv) {
  const a = { api: DEFAULT_API, json: false, quiet: false, offline: false, netPendingMax: 20000, successFloor: 0.5, chronicleMaxAge: 300000 };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i]; const next = () => argv[++i];
    switch (k) {
      case "--api": a.api = String(next()).replace(/\/$/, ""); break;
      case "--json": a.json = true; break;
      case "--quiet": a.quiet = true; break;
      case "--offline": a.offline = true; break;
      case "--netpending-max": a.netPendingMax = Number(next()) || 20000; break;
      case "--success-floor": a.successFloor = Number(next()) || 0.5; break;
      case "--chronicle-max-age": a.chronicleMaxAge = Number(next()) || 300000; break;
      case "-h": case "--help": a.help = true; break;
      default: throw new Error(`unknown argument: ${k}`);
    }
  }
  return a;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log("audit-live — read-only operations + money-boundary auditor (task #87).\n" +
      "  --api <base>   live worker base (default https://api.muros.live)\n" +
      "  --offline      check only the committed wrangler.toml bounds (no network)\n" +
      "  --netpending-max N   netPending WARN threshold (default 20000)\n" +
      "  --success-floor F    successRate WARN floor 0..1 (default 0.5)\n" +
      "  --chronicle-max-age MS   latest /history row age FAIL bound (default 300000)\n" +
      "  --json         machine-readable report\n" +
      "Exit 0 unless a bound/invariant FAILs (WARN/SKIP exit 0).");
    return 0;
  }

  const checks = [];
  checks.push(...auditMoneyBounds());
  if (!args.offline) {
    checks.push(...await auditAnchor(args.api));
    checks.push(...await auditBrain(args.api));
    checks.push(...await auditOperations(args.api, args));
  } else {
    checks.push(SKIP("anchor", "anchor", "offline mode — live endpoint probes skipped"));
    checks.push(SKIP("brain", "brain", "offline mode — live endpoint probes skipped"));
    checks.push(SKIP("ops", "ops", "offline mode — live endpoint probes skipped"));
  }

  const summary = {
    pass: checks.filter((c) => c.status === "PASS").length,
    warn: checks.filter((c) => c.status === "WARN").length,
    fail: checks.filter((c) => c.status === "FAIL").length,
    skip: checks.filter((c) => c.status === "SKIP").length,
  };
  const verdict = summary.fail > 0 ? "FAIL — an invariant is breached" : "PASS — no bound breached";
  const report = { tool: "audit-live", api: args.api, offline: args.offline, generatedAt: new Date().toISOString(), checks, summary, verdict };

  if (args.json) console.log(JSON.stringify(report, null, 2));
  else if (!args.quiet) console.log(renderText(report));

  return summary.fail > 0 ? 1 : 0;
}

try { process.exit(await main()); }
catch (e) { console.error(`audit-live fatal: ${e.stack || e.message}`); process.exit(2); }
