#!/usr/bin/env node
// poca-verify.mjs — the STANDALONE verifier for murmur's Proof of Continuous Agency (PoCA).
//
// WHAT IT IS. An independent auditor that answers, from PUBLIC data alone, whether the murmur swarm has been
// acting continuously under the SAME declared program — or whether the code was swapped, the chain broken, an
// epoch went missing, a proof mis-roots, or the facilitator wallet moved USDC off-book. It trusts NOTHING the
// operator says: it recomputes the crypto locally and re-reads the chain directly.
//
// WHAT IT DEPENDS ON (and ONLY these — see the task's design iron-law):
//   1. Arc public RPC            https://rpc.mainnet.arc.io  (chainId 5042) — eth_call / eth_getLogs / eth_get*
//   2. murmur public read-only   {api}/poca, /poca/epochs, /poca/epoch/{i}, /poca/proof, /poca/admin, /proofs
//   3. the on-chain ContinuityRegistry events + views
// It NEVER reads worker internals, DO storage, or any secret. There are no new npm dependencies: Node's built-in
// `fetch` + the shared WebCrypto pure core (packages/frontend/public/pocaVerify.js) do everything.
//
// SHARED CORE. The digest/Merkle/criteria-decision math lives in packages/frontend/public/pocaVerify.js — the
// SAME bare-ESM file the browser loads (window.__pocaVerify). To dodge the frontend package.json `type:commonjs`
// pitfall (a bare `.js` there is parsed as CJS by Node, choking on `export`), the CLI reads that file's bytes and
// imports them through a `data:text/javascript` URL, which Node ALWAYS parses as ESM regardless of any
// package.json. Single source of truth, zero duplicate files, zero config changes. (Rationale in the report.)
//
// DEGRADED MODE. The ContinuityRegistry is not yet deployed (the worker runs PoCA in zero-address DISABLED mode,
// so nothing is mirrored on-chain). When the registry is the zero address — or resolves to one but has opened no
// epochs — this verifier prints "no on-chain epochs yet — off-chain continuity only", SKIPs the on-chain-only
// criteria, still runs the off-chain ones best-effort, and EXITS 0. A disabled anchor is a state, not an error.
//
// USAGE
//   node scripts/poca-verify.mjs --selftest                 # run the golden vectors, then stop
//   node scripts/poca-verify.mjs --registry 0x…             # explicit registry address
//   node scripts/poca-verify.mjs --registry-from ENV_OR_URL # resolve the address from an env var name or a URL
//   node scripts/poca-verify.mjs --api https://api.muros.live --epochs 0,9 --sample 5 --json
//   node scripts/poca-verify.mjs --gap-hours 36 --facilitator 0x…
//   node scripts/poca-verify.mjs --from-block 23234000       # explicit start block (skip deploy detection)
//   node scripts/poca-verify.mjs --lookback-days 2 --pacing 800  # tune scan window + inter-chunk delay
// Exit code: 0 when nothing FAILs (PASS/SKIP/degraded all exit 0); 1 when any criterion FAILs or --selftest fails.

import { readFileSync } from "node:fs";

// ------------------------------ load the shared pure core (browser-identical) ------------------------------
const LIB_URL = new URL("../packages/frontend/public/pocaVerify.js", import.meta.url);
const lib = await import("data:text/javascript;base64," + Buffer.from(readFileSync(LIB_URL, "utf8")).toString("base64"));
const {
  ZERO64, POCA_ZERO_ADDRESS, SEAL_THRESHOLD, PocoAdminKindName,
  cronDigest, merkleRoot, merkleProof, merkleVerify, stateDigest,
  isZeroBytes32, normHex, normAddr,
  checkCodeIdentity, checkChainIntegrity, checkOffchainOnchainAgreement,
  checkTimeDensity, checkProofSelfConsistent, checkAssetContinuity,
  checkMirrorFreshness, checkSealStaleness,
} = lib;

// ------------------------------ constants: chain + precomputed ABI selectors/topics ------------------------------
// keccak256 prefixes (foundry `cast sig` / `cast sig-event`), frozen here so the CLI needs NO ABI encoder and NO
// keccak (Node's built-in crypto has sha3-256 but not Ethereum's keccak256). Same pattern as frontend/shared.js.
const DEFAULT_RPC = "https://rpc.mainnet.arc.io";
const DEFAULT_API = "https://api.muros.live";
const EXPECTED_CHAIN_ID = 5042; // Arc mainnet
const ARC_USDC = "0x3600000000000000000000000000000000000000"; // the Arc USDC FiatTokenV2 precompile

const SEL = {
  epochCount: "0x829965cc",          // epochCount() -> uint256
  currentEpoch: "0x76671808",        // currentEpoch() -> uint256 (reverts when epochCount == 0)
  committer: "0x5bc8e8f9",           // committer() -> address
  isUnbroken: "0x6ac1c91d",          // isUnbroken(uint256,uint256) -> bool
  epochs: "0xc6b61e4c",              // epochs(uint256) -> EpochRecord (8 words)
};
const TOPIC = {
  EpochOpened: "0xf64c35ac5c52f29123426e31e473262f334fb801e10b59a38cc90825a4fbadab",
  EpochSealed: "0xe30d144efc7249b28072b20fe02a9c4736d16fa1f31f8b989b5e9af5d86614e2",
  AdminAction: "0x83bd74468c329a93a7ac8dc38035bdbb90c08813aeaf42477a8191b47e52991e",
  Transfer: "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef", // ERC-20 Transfer(address,address,uint256)
};

// ------------------------------ tiny ABI helpers (hand-rolled, no deps) ------------------------------
const pad32 = (hex) => hex.replace(/^0x/i, "").padStart(64, "0");
const encUint = (n) => pad32(BigInt(n).toString(16));
const encAddrArg = (a) => pad32(normAddr(a));
/** Split an eth_call/getLogs hex blob into 32-byte words (no 0x). */
function words(hex) {
  const h = String(hex ?? "").replace(/^0x/i, "");
  const out = [];
  for (let i = 0; i + 64 <= h.length; i += 64) out.push(h.slice(i, i + 64));
  return out;
}
const wUint = (w) => BigInt("0x" + (w || "0"));
const wAddr = (w) => "0x" + (w || "").slice(24);
const wBool = (w) => wUint(w) !== 0n;
const wBytes32 = (w) => (w || ZERO64);

// ------------------------------ minimal JSON-RPC client (fetch POST) with exponential backoff + global pacing ------------------------------
let RPC_ID = 0;
let RPC_RETRY_COUNT = 5; // default retries; overridable via --retry N
let RPC_PACING_MS = 2000; // global inter-request pacing (overridable via --pacing)
let RPC_LAST_CALL_TS = 0; // timestamp of the last completed rpc() call (for global pacing)

/** Sleep helper with ±20% jitter around the base delay, capped at 30s. */
function backoffDelay(attempt) {
  // Base delays: 2s, 8s, 30s, 30s, 30s (capped)
  const base = Math.min(30000, Math.pow(4, attempt) * 2000);
  const jitter = base * 0.2 * (Math.random() * 2 - 1); // ±20%
  return Math.max(0, base + jitter);
}

/** Determine if an HTTP status or error is retryable (429 rate-limit, 5xx server, network). */
function isRetryable(status, err) {
  if (err) return true; // network error (fetch threw)
  if (status === 429) return true;
  if (status >= 500 && status < 600) return true;
  return false;
}

async function rpc(url, method, params, { quiet = false } = {}) {
  let lastErr = null;
  for (let attempt = 0; attempt <= RPC_RETRY_COUNT; attempt++) {
    // Global pacing: ensure at least RPC_PACING_MS between ANY two consecutive HTTP requests
    if (RPC_PACING_MS > 0 && RPC_LAST_CALL_TS > 0) {
      const elapsed = Date.now() - RPC_LAST_CALL_TS;
      if (elapsed < RPC_PACING_MS) await new Promise((r) => setTimeout(r, RPC_PACING_MS - elapsed));
    }
    if (attempt > 0) {
      const delay = backoffDelay(attempt - 1);
      if (!quiet) process.stderr.write(`  [rpc] ${method} retry ${attempt}/${RPC_RETRY_COUNT} after ${Math.round(delay)}ms\u2026\n`);
      await new Promise((r) => setTimeout(r, delay));
    }
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: ++RPC_ID, method, params }),
      });
      RPC_LAST_CALL_TS = Date.now();
      if (!res.ok) {
        if (isRetryable(res.status, null) && attempt < RPC_RETRY_COUNT) {
          lastErr = new Error(`RPC ${method} HTTP ${res.status}`);
          continue;
        }
        throw new Error(`RPC ${method} HTTP ${res.status}`);
      }
      const j = await res.json();
      if (j.error) {
        if (!quiet) throw new Error(`RPC ${method}: ${j.error.message || JSON.stringify(j.error)}`);
        return null;
      }
      return j.result;
    } catch (e) {
      RPC_LAST_CALL_TS = Date.now();
      // Network-level error (DNS, timeout, connection refused) — retryable
      if (isRetryable(null, e) && attempt < RPC_RETRY_COUNT) {
        lastErr = e;
        continue;
      }
      // Non-retryable or retries exhausted
      if (lastErr && attempt >= RPC_RETRY_COUNT) throw lastErr;
      throw e;
    }
  }
  throw lastErr || new Error(`RPC ${method} failed after ${RPC_RETRY_COUNT} retries`);
}
const ethCall = async (url, to, data) => rpc(url, "eth_call", [{ to, data }, "latest"]);

// ------------------------------ HTTP JSON helper (public read-only endpoints) ------------------------------
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

// ------------------------------ CLI arg parsing ------------------------------
function parseArgs(argv) {
  const a = {
    registry: null, registryFrom: null, api: DEFAULT_API, rpc: DEFAULT_RPC,
    epochs: null, sample: 3, gapHours: 36, cadenceHours: 24, facilitator: null,
    json: false, selftest: false, logChunk: 10000, maxTxs: 300, quiet: false,
    fromBlock: null, lookbackDays: 3, pacing: 2000,
  };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    const next = () => argv[++i];
    switch (k) {
      case "--registry": a.registry = next(); break;
      case "--registry-from": a.registryFrom = next(); break;
      case "--api": a.api = String(next()).replace(/\/$/, ""); break;
      case "--rpc": a.rpc = next(); break;
      case "--epochs": a.epochs = next(); break; // "from,to"
      case "--sample": a.sample = Math.max(1, Math.floor(Number(next()) || 1)); break;
      case "--gap-hours": a.gapHours = Number(next()) || 36; break;
      case "--cadence-hours": a.cadenceHours = Number(next()) || 24; break;
      case "--facilitator": a.facilitator = next(); break;
      case "--log-chunk": a.logChunk = Math.max(1, Math.floor(Number(next()) || 10000)); break;
      case "--max-txs": a.maxTxs = Math.max(1, Math.floor(Number(next()) || 300)); break;
      case "--json": a.json = true; break;
      case "--selftest": a.selftest = true; break;
      case "--retry": RPC_RETRY_COUNT = Math.max(0, Math.floor(Number(next()) || 5)); break;
      case "--from-block": a.fromBlock = Math.max(0, Math.floor(Number(next()) || 0)); break;
      case "--lookback-days": a.lookbackDays = Math.max(1, Number(next()) || 3); break;
      case "--pacing": a.pacing = Math.max(0, Math.floor(Number(next()) || 2000)); RPC_PACING_MS = a.pacing; break;
      case "--quiet": a.quiet = true; break;
      case "-h": case "--help": a.help = true; break;
      default: throw new Error(`unknown argument: ${k}`);
    }
  }
  // Apply pacing from args (may also be set by --pacing inline above)
  RPC_PACING_MS = a.pacing;
  return a;
}

function helpText() {
  return [
    "poca-verify — standalone Proof-of-Continuous-Agency verifier (public data only).",
    "",
    "  --selftest                 run the golden vectors (scripts/poca-verify.vectors.json) and exit",
    "  --registry 0x…             ContinuityRegistry address (else resolved from --registry-from or {api}/poca)",
    "  --registry-from <env|url>  resolve the registry address from an ENV VAR NAME or an HTTP(S) URL",
    "  --api <base>               murmur public API base (default https://api.muros.live)",
    "  --rpc <url>                Arc JSON-RPC (default https://rpc.mainnet.arc.io)",
    "  --epochs from,to           epoch index range to verify (default: all sealed epochs)",
    "  --sample N                 cron digests to sample per epoch for criterion ④ (default 3)",
    "  --gap-hours H              criterion ③ hole threshold in hours (default 36)",
    "  --cadence-hours H          declared epoch cadence in hours (default 24)",
    "  --facilitator 0x…          facilitator wallet for criterion ⑤ (else derived from /arena or a receipt tx)",
    "  --log-chunk N              eth_getLogs block-range shard size (default 10000; Arc max ~10K per query)",
    "  --max-txs N                cap on tx lookups when scanning USDC transfers (default 300)",
    "  --from-block N             explicit start block for eth_getLogs scans (skips deploy-block detection)",
    "  --lookback-days D          auto-detection lookback window in days (default 3; ~172800 blocks/day on Arc)",
    "  --pacing MS                global inter-request delay in ms to avoid 429 rate-limits (default 2000)",
    "  --json                     machine-readable report on stdout",
    "  --retry N                  RPC retries on 429/5xx/network (default 5; delays 2s/8s/30s/30s/30s ±20% jitter)",
    "  --quiet                    suppress the human report (still sets the exit code)",
    "",
    "Exit 0 when nothing FAILs (PASS/SKIP/degraded); 1 on any FAIL or a failed --selftest.",
  ].join("\n");
}

// ------------------------------ --selftest: the golden-vector gate ------------------------------
async function runSelfTest(machine = false) {
  const out = machine ? console.error : console.log; // keep stdout pure JSON in --json mode
  const vecUrl = new URL("./poca-verify.vectors.json", import.meta.url);
  const { meta, vectors } = JSON.parse(readFileSync(vecUrl, "utf8"));
  let pass = 0;
  const fails = [];
  for (const v of vectors) {
    let got;
    switch (v.kind) {
      case "stateDigest": got = await stateDigest(v.input); break;
      case "cronDigest": got = await cronDigest(v.input.prevDigest, v.input.i, v.input.stateDigest, v.input.codeCommitment); break;
      case "merkleRoot": got = await merkleRoot(v.input.digests); break;
      case "merkleVerify": got = await merkleVerify(v.input.leaf, v.input.path, v.input.root); break;
      case "hexToBytesThrows": {
        // review #19: the mirror must reject exactly the malformed hex the worker rejects (odd length / non-hex).
        let threw = false;
        try { lib.hexToBytes(v.input.hex); } catch { threw = true; }
        got = threw ? "throw" : "no-throw";
        break;
      }
      case "u64be": {
        const n = v.input.bigint ? BigInt(v.input.n) : v.input.n;
        got = Buffer.from(lib.u64be(n)).toString("hex");
        break;
      }
      default: fails.push(`${v.id}: unknown kind ${v.kind}`); continue;
    }
    const ok = got === v.expected;
    if (ok) pass++;
    else fails.push(`${v.id}: expected ${JSON.stringify(v.expected)} got ${JSON.stringify(got)}`);
  }
  const allOk = fails.length === 0;
  out(`poca-verify selftest: ${pass}/${vectors.length} vectors passed (contract: ${meta.contract})`);
  for (const f of fails) console.error(`  FAIL ${f}`);
  if (allOk) out("SELFTEST PASS — pure core matches the frozen golden vectors.");
  else console.error("SELFTEST FAIL — pure core diverges from the golden vectors; refusing to verify.");
  return allOk;
}

// ------------------------------ criteria self-checks (synthetic in-memory fixtures) ------------------------------
// The golden vectors above freeze the CRYPTO contract; these assertions freeze the seven criteria DECISION cores
// (packages/frontend/public/pocaVerify.js) against tiny hand-built fixtures, so a regression in any PASS/FAIL/
// SKIP rule is caught by the same --selftest gate. No network, no chain — pure logic.
async function runCriteriaSelfTest(machine = false) {
  const out = machine ? console.error : console.log;
  const hx = (n) => n.toString(16).padStart(64, "0");
  const cases = [];
  const check = (name, cond) => cases.push({ name, ok: !!cond });

  // ① code identity
  const ccSame = checkCodeIdentity([{ index: 0, codeCommitment: "aa", openTs: 0, endTs: 1000 }, { index: 1, codeCommitment: "aa", openTs: 1000, endTs: 2000 }], [], "aa");
  check("① stable commitment + live match ⇒ PASS", ccSame.pass === true);
  const ccUnexplained = checkCodeIdentity([{ index: 0, codeCommitment: "aa", openTs: 0, endTs: 1000 }, { index: 1, codeCommitment: "bb", openTs: 1000, endTs: 2000 }], [], "bb");
  check("① unexplained rotation ⇒ FAIL", ccUnexplained.pass === false && ccUnexplained.unexplained.length === 1);
  const ccExplained = checkCodeIdentity([{ index: 0, codeCommitment: "aa", openTs: 0, endTs: 1000 }, { index: 1, codeCommitment: "bb", openTs: 1000, endTs: 2000 }], [{ kind: 7, ts: 1000 }], "bb");
  check("① kind=7-attested rotation ⇒ PASS", ccExplained.pass === true && ccExplained.changePoints.length === 1);
  const ccStale = checkCodeIdentity([{ index: 0, codeCommitment: "aa", openTs: 0, endTs: 1000 }], [], "zz");
  check("① live commitment ≠ newest epoch ⇒ FAIL", ccStale.pass === false);

  // ② chain integrity
  const ciOk = checkChainIntegrity([{ index: 0, sealedHead: hx(1), prevEpochSeal: ZERO64 }, { index: 1, sealedHead: hx(2), prevEpochSeal: hx(1) }]);
  check("② linked seal chain ⇒ PASS", ciOk.pass === true);
  const ciBreak = checkChainIntegrity([{ index: 0, sealedHead: hx(1), prevEpochSeal: ZERO64 }, { index: 1, sealedHead: hx(2), prevEpochSeal: hx(999) }]);
  check("② broken prevEpochSeal ⇒ FAIL", ciBreak.pass === false && ciBreak.breaks.length === 1);
  const ciUnsealed = checkChainIntegrity([{ index: 0, sealedHead: ZERO64, prevEpochSeal: ZERO64 }]);
  check("② unsealed epoch ⇒ FAIL", ciUnsealed.pass === false);
  const agreeOk = checkOffchainOnchainAgreement([{ index: 0, sealedHead: hx(1), merkleRoot: hx(7) }], [{ index: 0, sealedHead: hx(1), merkleRoot: hx(7) }]);
  check("② off-chain↔on-chain agree ⇒ PASS", agreeOk.pass === true);
  const agreeBad = checkOffchainOnchainAgreement([{ index: 0, sealedHead: hx(1), merkleRoot: hx(7) }], [{ index: 0, sealedHead: hx(1), merkleRoot: hx(8) }]);
  check("② merkleRoot divergence ⇒ FAIL", agreeBad.pass === false && agreeBad.mismatches.length === 1);

  // ③ time density
  const tdOk = checkTimeDensity([0, 86400], 24, 36);
  check("③ 24h cadence ⇒ PASS", tdOk.pass === true);
  const tdGap = checkTimeDensity([0, 3600 * 55], 24, 36);
  check("③ 55h hole > 36h ⇒ FAIL", tdGap.pass === false && tdGap.gaps.length === 1);
  const tdSkip = checkTimeDensity([0], 24, 36);
  check("③ single seal ⇒ SKIP", tdSkip.skip === true && tdSkip.pass === null);

  // ④ behavioural consistency (real Merkle tree)
  const leaves = [hx(11), hx(22), hx(33)];
  const root = await merkleRoot(leaves);
  const proof = await merkleProof(leaves, 1);
  const verified = await merkleVerify(proof.leaf, proof.path, proof.root);
  const ep = { merkleRoot: root, firstDigest: leaves[0], lastDigest: leaves[2], tickCount: 3 };
  const bhOk = checkProofSelfConsistent(proof, ep, 1, verified);
  check("④ self-consistent proof ⇒ PASS", bhOk.pass === true);
  const bhBad = checkProofSelfConsistent({ ...proof, root: hx(999) }, ep, 1, false);
  check("④ mis-rooted proof ⇒ FAIL", bhBad.pass === false);

  // ⑤ asset continuity
  const acOk = checkAssetContinuity(["0x" + hx(5)], ["0x" + hx(5)]);
  check("⑤ transfers == receipts ⇒ PASS", acOk.pass === true);
  const acUndeclared = checkAssetContinuity(["0x" + hx(5), "0x" + hx(6)], ["0x" + hx(5)]);
  check("⑤ undeclared on-chain transfer ⇒ FAIL", acUndeclared.pass === false && acUndeclared.undeclared.length === 1);
  const acUnbacked = checkAssetContinuity(["0x" + hx(5)], ["0x" + hx(5), "0x" + hx(7)]);
  check("⑤ receipt with no transfer ⇒ FAIL", acUnbacked.pass === false && acUnbacked.unbacked.length === 1);

  // ① code identity — review #25 (worker-attested rotation ts + admin-log horizon downgrade)
  const ccField = checkCodeIdentity([{ index: 0, codeCommitment: "aa", openTs: 0, endTs: 1000 }, { index: 1, codeCommitment: "bb", openTs: 1000, endTs: 2000, codeChangeAdminTs: 1000 }], [], "bb");
  check("① codeChangeAdminTs-attested rotation ⇒ PASS", ccField.pass === true && ccField.changePoints.length === 1 && ccField.unexplained.length === 0);
  // An old rotation whose kind=7 event scrolled past the limit-500 admin cap: boundary ts (2) predates the
  // oldest visible admin entry (1e9) AND index 1 is far outside the recent-100 window (max index 200) ⇒ SKIP.
  const manyOld = Array.from({ length: 201 }, (_, i) => ({ index: i, codeCommitment: i === 0 ? "aa" : "bb", openTs: i + 1, endTs: i + 2 }));
  const ccHorizon = checkCodeIdentity(manyOld, [{ kind: 7, ts: 1_000_000_000 }], "bb");
  check("① rotation beyond admin log horizon ⇒ SKIP (not FAIL)", ccHorizon.skip === true && ccHorizon.pass === false && ccHorizon.beyondHorizon.length === 1 && ccHorizon.unexplained.length === 0);
  // The SAME horizon, but the unexplained rotation sits inside the recent-100 window (index 200 of 0..200) ⇒
  // the log is expected to be complete there, so it is a strict FAIL — the horizon never excuses a recent swap.
  const recentRot = Array.from({ length: 201 }, (_, i) => ({ index: i, codeCommitment: i < 200 ? "bb" : "cc", openTs: i + 1, endTs: i + 2 }));
  const ccRecent = checkCodeIdentity(recentRot, [{ kind: 7, ts: 1_000_000_000 }], "cc");
  check("① unexplained rotation inside recent-100 ⇒ FAIL (horizon does not excuse it)", ccRecent.pass === false && ccRecent.skip === false && ccRecent.unexplained.length === 1);

  // ① code identity — task 66 (rotation-in-progress: live ≠ newest sealed, but open epoch carries it)
  const ccRotOk = checkCodeIdentity(
    [{ index: 0, codeCommitment: "aa", openTs: 0, endTs: 1000 }],
    [{ kind: 7, ts: 1000 }],
    "bb",   // live commitment differs from the newest sealed epoch ("aa")
    86_400_000, 100,
    { index: 1, codeCommitment: "bb", openTs: 1000, codeChangeAdminTs: 1000 },  // open epoch carries live
  );
  check("① rotation-in-progress (open epoch + kind7) ⇒ PASS", ccRotOk.pass === true && ccRotOk.rotationInProgress === true);
  // Negative: open epoch carries the live commitment but NO kind7 explanation ⇒ still FAIL.
  const ccRotBad = checkCodeIdentity(
    [{ index: 0, codeCommitment: "aa", openTs: 0, endTs: 1000 }],
    [],     // no kind7 admin entries
    "bb",
    86_400_000, 100,
    { index: 1, codeCommitment: "bb", openTs: 1000, codeChangeAdminTs: null },  // no attestation
  );
  check("① rotation-in-progress without kind7 ⇒ FAIL", ccRotBad.pass === false && ccRotBad.rotationInProgress === false);

  // ⑥ mirror freshness (review #6) — off-chain epochCount must not drift ahead of the on-chain mirror
  const mfOk = checkMirrorFreshness(10, 10, true);
  check("⑥ off==on epochCount ⇒ PASS", mfOk.pass === true && mfOk.delta === 0);
  const mfWithin = checkMirrorFreshness(11, 10, true);
  check("⑥ off-chain 1 ahead (in-flight seal) ⇒ PASS", mfWithin.pass === true && mfWithin.delta === 1);
  const mfStale = checkMirrorFreshness(15, 10, true);
  check("⑥ off-chain 5 ahead (> tolerance 1) ⇒ FAIL", mfStale.pass === false && mfStale.delta === 5);
  const mfSkip = checkMirrorFreshness(15, 0, false);
  check("⑥ mirror disabled ⇒ SKIP", mfSkip.skip === true && mfSkip.pass === null);

  // ⑦ seal staleness (review #6) — age of the NEWEST seal vs the cadence window
  const NOW = 1_000_000; // seconds
  const ssOk = checkSealStaleness([NOW - 3600, NOW - 1800], NOW, 36);
  check("⑦ newest seal 0.5h ago (within 36h) ⇒ PASS", ssOk.pass === true && ssOk.skip === false);
  const ssStale = checkSealStaleness([NOW - 3600 * 50], NOW, 36);
  check("⑦ newest seal 50h ago (> 36h) ⇒ FAIL", ssStale.pass === false && ssStale.skip === false);
  const ssSkip = checkSealStaleness([], NOW, 36);
  check("⑦ zero sealed epochs ⇒ SKIP", ssSkip.skip === true && ssSkip.pass === null);

  const passed = cases.filter((c) => c.ok).length;
  const allOk = passed === cases.length;
  out(`poca-verify criteria self-checks: ${passed}/${cases.length} passed`);
  for (const c of cases) if (!c.ok) console.error(`  FAIL ${c.name}`);
  if (allOk) out("CRITERIA SELFTEST PASS — all seven decision cores behave as specified.");
  else console.error("CRITERIA SELFTEST FAIL — a decision core regressed; refusing to verify.");
  return allOk;
}

// ------------------------------ registry resolution ------------------------------
async function resolveRegistry(args) {
  // 1. explicit --registry wins.
  if (args.registry) return { address: args.registry, source: "--registry" };
  // 2. --registry-from: a URL (fetch → JSON.registryAddress | plain text) or an ENV VAR NAME.
  if (args.registryFrom) {
    const spec = args.registryFrom;
    if (/^https?:\/\//i.test(spec)) {
      const txt = await (await fetch(spec)).text();
      let addr = txt.trim();
      try { const j = JSON.parse(txt); addr = (j.registryAddress || j.address || j.pocaRegistryAddress || "").trim(); } catch { /* plain-text address */ }
      return { address: addr || POCA_ZERO_ADDRESS, source: `--registry-from ${spec}` };
    }
    const env = process.env[spec];
    return { address: (env || "").trim() || POCA_ZERO_ADDRESS, source: `--registry-from env:${spec}` };
  }
  // 3. default: read it off the public /poca snapshot.
  try {
    const poca = await getJson(`${args.api}/poca`);
    return { address: (poca.registryAddress || POCA_ZERO_ADDRESS).trim(), source: `${args.api}/poca`, poca };
  } catch (e) {
    return { address: POCA_ZERO_ADDRESS, source: `${args.api}/poca (unreachable: ${e.message})` };
  }
}
const isDisabledRegistry = (addr) => !addr || normAddr(addr) === normAddr(POCA_ZERO_ADDRESS);

// ------------------------------ on-chain readers ------------------------------
async function readChainEpochs(url, registry, from, to) {
  const out = [];
  for (let i = from; i <= to; i++) {
    const data = SEL.epochs + encUint(i);
    const res = await ethCall(url, registry, data);
    const w = words(res);
    if (w.length < 8) continue;
    out.push({
      index: i,
      codeCommitment: wBytes32(w[0]),
      genesisHead: wBytes32(w[1]),
      sealedHead: wBytes32(w[2]),
      startTs: Number(wUint(w[3])),
      endTs: Number(wUint(w[4])),
      tickCount: Number(wUint(w[5])),
      merkleRoot: wBytes32(w[6]),
      prevEpochSeal: wBytes32(w[7]),
    });
  }
  return out;
}

/** eth_getLogs sharded by block range (Arc caps ~10K blocks per query; default chunk=10000).
 *  Global pacing in rpc() already spaces requests; no additional per-chunk delay needed.
 *  Adaptive: if the RPC rejects a chunk with "max results" (e.g. USDC Transfer is very dense),
 *  automatically narrows the chunk and retries until it succeeds or hits the minimum (100 blocks). */
async function getLogsSharded(url, { address, topics, fromBlock, toBlock, chunk }) {
  const logs = [];
  const MIN_CHUNK = 100;
  let start = fromBlock;
  let currentChunk = chunk;
  while (start <= toBlock) {
    const end = Math.min(start + currentChunk - 1, toBlock);
    try {
      const res = await rpc(url, "eth_getLogs", [{ address, topics, fromBlock: "0x" + start.toString(16), toBlock: "0x" + end.toString(16) }]);
      if (Array.isArray(res)) logs.push(...res);
      start = end + 1;
      // Successfully processed — try to grow chunk back toward the original (adaptive recovery)
      if (currentChunk < chunk) currentChunk = Math.min(chunk, currentChunk * 2);
    } catch (e) {
      const msg = String(e.message || "");
      // Arc returns "exceeded max results" or "range too large" — halve the chunk and retry
      if ((msg.includes("max results") || msg.includes("range too large") || msg.includes("max allowed range")) && currentChunk > MIN_CHUNK) {
        currentChunk = Math.max(MIN_CHUNK, Math.floor(currentChunk / 4));
        continue; // retry same start with smaller chunk
      }
      throw e; // non-retryable error
    }
  }
  return logs;
}

/** Binary-search for the block at which `address` was deployed (first block with non-empty code).
 *  Uses ~18 eth_getCode calls (paced by the global rpc() throttle); returns lo0 on failure (safe fallback). */
async function detectDeployBlock(url, address, headBlock, lookbackBlocks) {
  const lo0 = Math.max(0, headBlock - lookbackBlocks);
  // Verify code exists at head (sanity)
  try {
    const code = await rpc(url, "eth_getCode", [address, "0x" + headBlock.toString(16)], { quiet: true });
    if (!code || code === "0x" || code.length <= 2) return lo0; // no code anywhere in range
  } catch { return lo0; }
  // Verify code does NOT exist at lo0 (if it does, the whole window has code — just use lo0)
  try {
    const code0 = await rpc(url, "eth_getCode", [address, "0x" + lo0.toString(16)], { quiet: true });
    if (code0 && code0.length > 2) return lo0; // deployed before our window
  } catch { /* proceed with binary search anyway */ }
  let lo = lo0, hi = headBlock;
  while (lo < hi - 1) {
    const mid = Math.floor((lo + hi) / 2);
    try {
      const code = await rpc(url, "eth_getCode", [address, "0x" + mid.toString(16)], { quiet: true });
      if (code && code.length > 2) hi = mid; else lo = mid;
    } catch { return lo0; } // on failure, fall back to conservative window
  }
  return hi;
}

// ------------------------------ the seven criteria ------------------------------

/** ① CODE IDENTITY — every codeCommitment rotation is admin-attested and the live commitment matches. */
async function criterion1(args) {
  const ev = [];
  let epochsOff = [];
  let admin = [];
  let current = null;
  let openEpoch = null;
  try {
    const ep = await getJson(`${args.api}/poca/epochs?limit=500`);
    // review #25: carry the worker-attested rotation timestamp (may be absent on an older worker ⇒ null).
    epochsOff = (ep.epochs || []).map((e) => ({ index: e.index, codeCommitment: e.codeCommitment, openTs: e.openTs, endTs: e.endTs, codeChangeAdminTs: e.codeChangeAdminTs ?? null }));
  } catch (e) { ev.push(`could not read /poca/epochs: ${e.message}`); }
  try {
    const ad = await getJson(`${args.api}/poca/admin?limit=500`);
    admin = (ad.admin || []).map((e) => ({ kind: e.kind, ts: e.ts }));
  } catch (e) { ev.push(`could not read /poca/admin: ${e.message}`); }
  try {
    const poca = await getJson(`${args.api}/poca`);
    current = poca.codeCommitment;
    // task 66: fetch the OPEN epoch so the rotation-in-progress window can be checked.
    if (poca.currentEpoch != null) {
      try {
        const oe = await getJson(`${args.api}/poca/epoch/${poca.currentEpoch}`);
        openEpoch = { index: oe.index, codeCommitment: oe.codeCommitment, openTs: oe.openTs, codeChangeAdminTs: oe.codeChangeAdminTs ?? null };
      } catch { /* tolerate — the pure core handles openEpoch=null gracefully */ }
    }
  } catch (e) { ev.push(`could not read /poca: ${e.message}`); }

  if (epochsOff.length === 0 && current == null) {
    return { id: 1, name: "code-identity", status: "SKIP", evidence: [...ev, "no off-chain epochs or /poca snapshot reachable — nothing to audit"] };
  }
  const r = checkCodeIdentity(epochsOff, admin, current, 86_400_000, 100, openEpoch);
  // review #25: r.skip ⇒ every rotation is either attested or beyond the admin log horizon (neither provable
  // nor disprovable) — report SKIP, not FAIL. A hard unexplained rotation or a live/newest mismatch still FAILs.
  const status = (epochsOff.length === 0 || r.skip) ? "SKIP" : (r.pass ? "PASS" : "FAIL");
  return { id: 1, name: "code-identity", status, evidence: [...ev, ...r.evidence], detail: { changePoints: r.changePoints, unexplained: r.unexplained, beyondHorizon: r.beyondHorizon, latestMatchesCurrent: r.latestMatchesCurrent, rotationInProgress: r.rotationInProgress } };
}

/** ② CHAIN INTEGRITY — on-chain epoch seal chain + isUnbroken + off-chain↔on-chain agreement. */
async function criterion2(args, ctx) {
  const ev = [];
  if (!ctx.onchain) return { id: 2, name: "chain-integrity", status: "SKIP", evidence: ["on-chain registry disabled / no epochs — chain integrity is off-chain-only here"] };
  const { registry, from, to } = ctx;
  // (a) recompute the seal chain locally from epochs(i).
  const chain = checkChainIntegrity(ctx.chainEpochs);
  ev.push(...chain.evidence);
  // (b) cross-check the contract's own isUnbroken(from,to) view.
  let isUnbroken = null;
  try {
    const data = SEL.isUnbroken + encUint(from) + encUint(to);
    isUnbroken = wBool(words(await ethCall(args.rpc, registry, data))[0]);
    ev.push(`isUnbroken(${from},${to}) = ${isUnbroken}`);
  } catch (e) { ev.push(`isUnbroken(${from},${to}) call failed: ${e.message}`); }
  // (c) off-chain /poca/epochs sealedHead + merkleRoot must equal the on-chain record.
  const agree = checkOffchainOnchainAgreement(ctx.epochsOff, ctx.chainEpochs);
  ev.push(...agree.evidence);

  const pass = chain.pass && agree.pass && isUnbroken !== false;
  return { id: 2, name: "chain-integrity", status: pass ? "PASS" : "FAIL", evidence: ev, detail: { breaks: chain.breaks, mismatches: agree.mismatches, isUnbroken } };
}

/** ③ TIME DENSITY — gaps between consecutive on-chain EpochSealed block timestamps vs the declared cadence. */
async function criterion3(args, ctx) {
  const ev = [];
  if (!ctx.onchain) return { id: 3, name: "time-density", status: "SKIP", evidence: ["no on-chain EpochSealed events (registry disabled) — cannot measure seal cadence"] };
  const sealTs = ctx.sealEvents.map((e) => e.ts).filter((t) => t > 0).sort((a, b) => a - b);
  const r = checkTimeDensity(sealTs, args.cadenceHours, args.gapHours);
  ev.push(...r.evidence);
  const status = r.skip ? "SKIP" : (r.pass ? "PASS" : "FAIL");
  return { id: 3, name: "time-density", status, evidence: ev, detail: { gaps: r.gaps, maxGapHours: r.maxGapHours, seals: sealTs.length } };
}

/** ④ BEHAVIOURAL CONSISTENCY — sampled cron proofs are self-consistent + anchored to the epoch root. */
async function criterion4(args, ctx) {
  const ev = [];
  const note = "level: commitment-self-consistency + on-chain anchoring (NOT full replay — full replay is covered by `npm run replay --flywire`)";
  let sealed = [];
  try {
    const ep = await getJson(`${args.api}/poca/epochs?limit=500`);
    sealed = (ep.epochs || []).slice().sort((a, b) => a.index - b.index);
  } catch (e) { ev.push(`could not read /poca/epochs: ${e.message}`); }
  // Restrict to the requested range when on-chain context is available.
  if (ctx.onchain) sealed = sealed.filter((e) => e.index >= ctx.from && e.index <= ctx.to);
  if (sealed.length === 0) {
    ev.push(note);
    return { id: 4, name: "behavioural-consistency", status: "SKIP", evidence: [...ev, "no sealed epochs in range to sample"] };
  }

  const onRootByIndex = new Map((ctx.chainEpochs || []).map((e) => [e.index, e.merkleRoot]));
  let checked = 0, failed = 0;
  const failures = [];
  for (const se of sealed) {
    let one;
    try { one = await getJson(`${args.api}/poca/epoch/${se.index}`); } catch (e) { ev.push(`epoch ${se.index}: /poca/epoch read failed: ${e.message}`); continue; }
    const tickCount = Number(one.tickCount ?? se.tickCount ?? 0);
    if (!Number.isFinite(tickCount) || tickCount <= 0) { ev.push(`epoch ${se.index}: no digests to sample`); continue; }
    // Sample N crons spread across the epoch, always including the first and last boundary.
    const idxs = sampleIndices(tickCount, args.sample);
    for (const cron of idxs) {
      let proof;
      try { proof = await getJson(`${args.api}/poca/proof?epoch=${se.index}&cron=${cron}`); } catch (e) { failures.push(`epoch ${se.index} cron ${cron}: /poca/proof failed: ${e.message}`); failed++; continue; }
      const verified = await merkleVerify(proof.digest, proof.path, proof.root);
      // Anchor: the proof root must equal the epoch's on-chain merkleRoot when the registry is live.
      const epochForCheck = { merkleRoot: one.merkleRoot ?? se.merkleRoot, firstDigest: one.firstDigest, lastDigest: one.lastDigest, tickCount };
      const r = checkProofSelfConsistent(proof, epochForCheck, cron, verified);
      if (ctx.onchain && onRootByIndex.has(se.index) && normHex(proof.root) !== normHex(onRootByIndex.get(se.index))) {
        r.problems.push(`proof.root ${proof.root} ≠ on-chain epochs(${se.index}).merkleRoot ${onRootByIndex.get(se.index)}`);
        r.pass = false;
      }
      checked++;
      if (!r.pass) { failed++; failures.push(...r.evidence); }
    }
  }
  ev.push(note);
  ev.push(`sampled ${checked} cron proof(s) across ${sealed.length} sealed epoch(s); ${failed} failed`);
  ev.push(...failures.slice(0, 20));
  const status = checked === 0 ? "SKIP" : (failed === 0 ? "PASS" : "FAIL");
  return { id: 4, name: "behavioural-consistency", status, evidence: ev, detail: { checked, failed } };
}

/** ⑤ ASSET CONTINUITY — facilitator USDC transfers ↔ /proofs receipts, bidirectionally. */
async function criterion5(args, ctx) {
  const ev = [];
  // The facilitator relays every real settlement; resolve its address (param → /arena resolver → a receipt tx's sender).
  let facilitator = args.facilitator;
  let receipts = [];
  try {
    const p = await getJson(`${args.api}/proofs`);
    receipts = (p.proofs || []).map((r) => r.txHash).filter((h) => /^0x[0-9a-fA-F]{64}$/.test(String(h)));
  } catch (e) { ev.push(`could not read /proofs: ${e.message}`); }
  if (!facilitator) {
    try { const ar = await getJson(`${args.api}/arena`); if (ar.resolver) facilitator = ar.resolver; } catch { /* ignore */ }
  }
  if (!facilitator && receipts.length > 0) {
    try { const tx = await rpc(args.rpc, "eth_getTransactionByHash", [receipts[0]], { quiet: true }); if (tx?.from) facilitator = tx.from; } catch { /* ignore */ }
  }
  if (!facilitator) {
    return { id: 5, name: "asset-continuity", status: "SKIP", evidence: [...ev, "no facilitator address resolvable (pass --facilitator) — cannot scope the USDC scan"] };
  }
  ev.push(`facilitator ${facilitator}; ${receipts.length} published real receipt tx(s)`);

  // The scan window is the on-chain seal block range; without a live registry there is no anchored window.
  if (!ctx.onchain || ctx.sealEvents.length === 0) {
    return { id: 5, name: "asset-continuity", status: "SKIP", evidence: [...ev, "no on-chain seal window (registry disabled) — asset continuity is off-chain-only here"] };
  }
  const blocks = ctx.sealEvents.map((e) => e.blockNumber).filter((b) => Number.isFinite(b));
  const fromBlock = Math.min(...blocks), toBlock = Math.max(...blocks);
  ev.push(`scanning USDC Transfer logs over blocks ${fromBlock}..${toBlock} (shard ${args.logChunk})`);

  let logs;
  try {
    logs = await getLogsSharded(args.rpc, { address: ARC_USDC, topics: [TOPIC.Transfer], fromBlock, toBlock, chunk: args.logChunk });
  } catch (e) {
    return { id: 5, name: "asset-continuity", status: "SKIP", evidence: [...ev, `USDC log scan failed: ${e.message}`] };
  }
  const uniqTx = [...new Set(logs.map((l) => l.transactionHash).filter(Boolean))];
  ev.push(`${logs.length} USDC Transfer log(s) in window across ${uniqTx.length} unique tx(s)`);
  // Keep only the transfers the facilitator actually relayed (tx.from == facilitator).
  const onchainTx = [];
  for (const tx of uniqTx.slice(0, args.maxTxs)) {
    try { const t = await rpc(args.rpc, "eth_getTransactionByHash", [tx], { quiet: true }); if (t?.from && normAddr(t.from) === normAddr(facilitator)) onchainTx.push(tx); } catch { /* skip */ }
  }
  if (uniqTx.length > args.maxTxs) ev.push(`NOTE: capped tx lookups at ${args.maxTxs} of ${uniqTx.length} (raise --max-txs for a full scan)`);

  const r = checkAssetContinuity(onchainTx, receipts);
  ev.push(...r.evidence);
  return { id: 5, name: "asset-continuity", status: r.pass ? "PASS" : "FAIL", evidence: ev, detail: { undeclared: r.undeclared, unbacked: r.unbacked, facilitator, onchainTransfers: onchainTx.length, receipts: receipts.length } };
}

/** ⑥ MIRROR FRESHNESS — the off-chain epoch count must not drift ahead of the on-chain mirror (review #6).
 *  A silently-dead mirror used to be invisible: the API looked healthy while the chain fell behind. This
 *  makes that observable. Also surfaces the worker's /poca.mirror health field as a WARN (never a FAIL — the
 *  on-chain criteria above are the real backstop); an older worker without the field is tolerated. */
async function criterion6(args, ctx) {
  const ev = [];
  let poca = null;
  try { poca = await getJson(`${args.api}/poca`); } catch (e) { ev.push(`could not read /poca: ${e.message}`); }
  // Mirror-health field (worker contract: {aligned,failures,paused,lastMirrorTs}); tolerate its absence.
  const mirror = poca && poca.mirror && typeof poca.mirror === "object" ? poca.mirror : null;
  if (mirror) {
    if (mirror.paused === true) ev.push(`WARN: on-chain mirror is PAUSED (lastMirrorTs ${mirror.lastMirrorTs ?? "?"}) — the chain criteria backstop any real divergence`);
    if (mirror.aligned === false) ev.push(`WARN: on-chain mirror reports aligned=false (${Number(mirror.failures) || 0} failure(s)) — the chain criteria backstop any real divergence`);
  } else if (poca) {
    ev.push("no /poca.mirror health field (older worker) — tolerated");
  }
  const off = poca ? poca.epochCount : null;
  const r = checkMirrorFreshness(off, ctx.epochCount, ctx.onchain);
  ev.push(...r.evidence);
  const status = r.skip ? "SKIP" : (r.pass ? "PASS" : "FAIL");
  return { id: 6, name: "mirror-freshness", status, evidence: ev, detail: { delta: r.delta, offchain: off, onchain: ctx.epochCount, mirror } };
}

/** ⑦ SEAL STALENESS — the newest on-chain seal must not be older than the cadence window (review #6).
 *  Criterion ③ measures gaps BETWEEN seals; this measures the gap from the LAST seal to NOW, so an agent that
 *  stopped anchoring hours ago is caught even though its API still serves a healthy snapshot. Zero sealed
 *  epochs ⇒ SKIP (the current production posture: one open epoch, nothing sealed yet). */
async function criterion7(args, ctx) {
  const ev = [];
  if (!ctx.onchain) return { id: 7, name: "seal-staleness", status: "SKIP", evidence: ["no on-chain EpochSealed events (registry disabled) — cannot age the newest seal"] };
  const sealTs = ctx.sealEvents.map((e) => e.ts).filter((t) => t > 0).sort((a, b) => a - b);
  const nowSec = Math.floor(Date.now() / 1000);
  const r = checkSealStaleness(sealTs, nowSec, args.gapHours);
  ev.push(...r.evidence);
  const status = r.skip ? "SKIP" : (r.pass ? "PASS" : "FAIL");
  return { id: 7, name: "seal-staleness", status, evidence: ev, detail: { ageHours: r.ageHours, latestSealTs: r.latestSealTs, seals: sealTs.length } };
}

/** Pick up to n indices across [0,count-1], always including both boundaries, de-duplicated + sorted. */
function sampleIndices(count, n) {
  if (count <= 0) return [];
  if (count <= n) return Array.from({ length: count }, (_, i) => i);
  const set = new Set([0, count - 1]);
  for (let k = 1; k < n - 1 && set.size < n; k++) set.add(Math.floor((k * (count - 1)) / (n - 1)));
  return [...set].sort((a, b) => a - b);
}

// ------------------------------ report rendering ------------------------------
const ICON = { PASS: "PASS", FAIL: "FAIL", SKIP: "SKIP" };
function renderText(report) {
  const L = [];
  L.push("═".repeat(78));
  L.push("  murmur PoCA — Proof of Continuous Agency — independent verifier");
  L.push("═".repeat(78));
  L.push(`  api          : ${report.context.api}`);
  L.push(`  rpc          : ${report.context.rpc} (chainId ${report.context.chainId ?? "?"})`);
  L.push(`  registry     : ${report.context.registry}  [${report.context.registrySource}]`);
  L.push(`  on-chain     : ${report.context.onchain ? `ENABLED, epochs ${report.context.from}..${report.context.to} (epochCount ${report.context.epochCount})` : "DISABLED / no epochs"}`);
  if (report.degraded) L.push(`\n  ⚠ ${report.degradedMessage}`);
  L.push("");
  for (const c of report.criteria) {
    L.push(`  [${ICON[c.status]}] ${c.id}. ${c.name}`);
    for (const e of c.evidence) L.push(`        · ${e}`);
    L.push("");
  }
  L.push("─".repeat(78));
  L.push(`  VERDICT: ${report.verdict}   (${report.summary.pass} PASS · ${report.summary.fail} FAIL · ${report.summary.skip} SKIP)`);
  L.push("─".repeat(78));
  return L.join("\n");
}

// ------------------------------ main ------------------------------
async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) { console.log(helpText()); return 0; }

  // The golden-vector gate always runs first; a divergent pure core must never touch live data.
  const selfOk = (await runSelfTest(args.json || args.quiet)) && (await runCriteriaSelfTest(args.json || args.quiet));
  if (!selfOk) return 1;
  if (args.selftest) return 0; // --selftest stops here (the vectors ARE the gate)

  // Resolve the registry, then decide degraded vs on-chain mode.
  const reg = await resolveRegistry(args);
  const disabled = isDisabledRegistry(reg.address);

  // Verify we are talking to the right chain (best-effort; a mismatch is loud but non-fatal in degraded mode).
  let chainId = null;
  try { chainId = Number(BigInt(await rpc(args.rpc, "eth_chainId", []))); } catch { /* ignore */ }
  if (chainId != null && chainId !== EXPECTED_CHAIN_ID && !args.quiet) {
    console.error(`WARNING: RPC chainId ${chainId} ≠ expected ${EXPECTED_CHAIN_ID} (Arc mainnet).`);
  }

  const ctx = { onchain: false, registry: reg.address, chainEpochs: [], sealEvents: [], epochsOff: [], from: 0, to: -1, epochCount: 0 };
  let degraded = disabled;
  const degradedMessage = "no on-chain epochs yet — off-chain continuity only";

  if (!disabled) {
    try {
      const count = Number(wUint(words(await ethCall(args.rpc, reg.address, SEL.epochCount))[0]));
      ctx.epochCount = count;
      if (count === 0) {
        degraded = true; // registry deployed but has opened nothing yet
      } else {
        let from = 0, to = count - 1;
        if (args.epochs) {
          const [f, t] = args.epochs.split(",").map((x) => Number(String(x).trim()));
          if (Number.isInteger(f)) from = Math.max(0, f);
          if (Number.isInteger(t)) to = Math.min(count - 1, t);
        }
        ctx.from = from; ctx.to = to; ctx.onchain = true;
        ctx.chainEpochs = await readChainEpochs(args.rpc, reg.address, from, to);
        // EpochSealed events across the same window (topic1 = indexed epochIndex).
        const head = await rpc(args.rpc, "eth_blockNumber", []);
        const headBlock = Number(BigInt(head));
        // Narrow the scan range: use --from-block if given, else binary-search for deploy block,
        // else fall back to a conservative lookback window (avoids scanning from block 0 → 23M).
        const BLOCKS_PER_DAY = 172_800; // Arc ~0.5s/block
        let scanFrom;
        if (args.fromBlock != null) {
          scanFrom = args.fromBlock;
        } else {
          const lookbackBlocks = Math.round(args.lookbackDays * BLOCKS_PER_DAY);
          if (!args.quiet) process.stderr.write(`  [scan] auto-detecting deploy block (lookback ${args.lookbackDays}d \u2248 ${lookbackBlocks} blocks)\u2026\n`);
          scanFrom = await detectDeployBlock(args.rpc, reg.address, headBlock, lookbackBlocks);
          if (!args.quiet) process.stderr.write(`  [scan] deploy block \u2248 ${scanFrom}; scanning ${headBlock - scanFrom} blocks to head (${headBlock})\n`);
          // Post-detection cooldown: the binary search consumed ~20 RPC calls; pause to let the
          // rate-limiter sliding window reset before the heavier getLogs phase.
          const cooldown = Math.max(5000, RPC_PACING_MS * 3);
          if (!args.quiet) process.stderr.write(`  [scan] cooling down ${Math.round(cooldown / 1000)}s before log scan\u2026\n`);
          await new Promise((r) => setTimeout(r, cooldown));
        }
        const sealLogs = await getLogsSharded(args.rpc, { address: reg.address, topics: [TOPIC.EpochSealed], fromBlock: scanFrom, toBlock: headBlock, chunk: args.logChunk });
        ctx.sealEvents = sealLogs.map((l) => {
          const w = words(l.data);
          return { epochIndex: Number(BigInt(l.topics[1])), sealedHead: wBytes32(w[0]), tickCount: Number(wUint(w[1])), merkleRoot: wBytes32(w[2]), ts: Number(wUint(w[3])), blockNumber: Number(BigInt(l.blockNumber)) };
        }).filter((e) => e.epochIndex >= from && e.epochIndex <= to);
      }
    } catch (e) {
      // A registry that cannot be read (not deployed at that address, RPC down) degrades rather than errors.
      degraded = true;
      ctx.onchain = false;
      if (!args.quiet) console.error(`NOTE: on-chain registry read failed after ${RPC_RETRY_COUNT} retries (${e.message}) — falling back to off-chain continuity only.`);
    }
  }

  // Off-chain epoch list (used by criteria ② agreement + ④ sampling) — best-effort in every mode.
  try {
    const ep = await getJson(`${args.api}/poca/epochs?limit=500`);
    ctx.epochsOff = (ep.epochs || []).map((e) => ({ index: e.index, sealedHead: e.sealedHead, merkleRoot: e.merkleRoot, codeCommitment: e.codeCommitment }));
  } catch { /* criteria handle their own reads too */ }

  const criteria = [];
  criteria.push(await criterion1(args));
  criteria.push(await criterion2(args, ctx));
  criteria.push(await criterion3(args, ctx));
  criteria.push(await criterion4(args, ctx));
  criteria.push(await criterion5(args, ctx));
  criteria.push(await criterion6(args, ctx));
  criteria.push(await criterion7(args, ctx));

  const summary = {
    pass: criteria.filter((c) => c.status === "PASS").length,
    fail: criteria.filter((c) => c.status === "FAIL").length,
    skip: criteria.filter((c) => c.status === "SKIP").length,
  };
  const verdict = summary.fail > 0 ? "FAIL — continuity is NOT proven" : (degraded ? "PASS (degraded) — off-chain continuity only" : "PASS — continuous agency verified");

  const report = {
    tool: "poca-verify",
    generatedAt: new Date().toISOString(),
    degraded,
    degradedMessage: degraded ? degradedMessage : null,
    context: { api: args.api, rpc: args.rpc, chainId, registry: reg.address, registrySource: reg.source, onchain: ctx.onchain, from: ctx.onchain ? ctx.from : null, to: ctx.onchain ? ctx.to : null, epochCount: ctx.epochCount },
    criteria,
    summary,
    verdict,
  };

  if (args.json) console.log(JSON.stringify(report, null, 2));
  else if (!args.quiet) console.log(renderText(report));

  return summary.fail > 0 ? 1 : 0;
}

try {
  const code = await main();
  process.exit(code);
} catch (e) {
  console.error(`poca-verify fatal: ${e.stack || e.message}`);
  process.exit(2);
}
