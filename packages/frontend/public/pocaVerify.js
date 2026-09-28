// pocaVerify.js — the PURE, dependency-free core of murmur's Proof-of-Continuous-Agency (PoCA) verifier.
//
// This is a BARE ESM module (no imports) so it runs identically in THREE places:
//   1. the browser  — <script type="module">, mounted on window.__pocaVerify for console/audit use;
//   2. the Node CLI — scripts/poca-verify.mjs imports THIS SAME FILE (read → data: URL → import) so the
//      browser and the CLI can never drift on the crypto contract;
//   3. the frontend syntax gate — packages/frontend/scripts/check-syntax.mjs parses it as ESM.
//
// It uses ONLY the global WebCrypto `crypto.subtle.digest` (present in every modern browser AND Node ≥ 20),
// so there is no `node:crypto` import to break the browser and no bundler step. Every function here is a
// BYTE-FOR-BYTE re-implementation of packages/trader-worker/src/poca.ts (the worker's PoCA engine) and
// provenance.ts (`canonical` / `sha256Hex`): same field order, same fold rule, same hex conventions. A
// verifier that disagreed with the worker by even one byte would be worthless, so these are kept literal.
//
// SCOPE: pure computation ONLY — digest chaining, Merkle fold/proof/verify, and the I/O-free decision core
// of the five continuity criteria. All fetching (public RPC + api.muros.live) lives in the CLI, never here.

// ============================== constants (mirror poca.ts) ==============================

/** 64 zero hex chars — the genesis `prevDigest` and the Merkle root of an empty epoch. */
export const ZERO64 = "0".repeat(64);

/** Zero address — the DISABLED sentinel for the on-chain registry (off-chain continuity only). */
export const POCA_ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

/** Cron digests per epoch before an automatic seal (~24h at the 1/min production cadence). */
export const SEAL_THRESHOLD = 1440;

/**
 * The administrative-discontinuity kinds, byte-identical to poca.ts `PocoAdminKind` and the on-chain
 * ContinuityRegistry `adminAction(uint8 kind, …)` enum. Criterion ① hunts for kind 7 (CODE_CHANGE).
 */
export const PocoAdminKind = {
  RESET: 1,
  MANUAL_TICK: 2,
  PARAM_OVERRIDE: 3,
  COMMITTER_CHANGE: 4,
  GENESIS_SEED: 5,
  DO_REBUILD: 6,
  CODE_CHANGE: 7,
};

/** Human-readable names for the admin kinds (report read-out only; never hashed). */
export const PocoAdminKindName = {
  1: "RESET",
  2: "MANUAL_TICK",
  3: "PARAM_OVERRIDE",
  4: "COMMITTER_CHANGE",
  5: "GENESIS_SEED",
  6: "DO_REBUILD",
  7: "CODE_CHANGE",
};

// ============================== byte helpers (mirror poca.ts) ==============================

/** Decode an even-length hex string (with or without a 0x prefix) into bytes. */
export function hexToBytes(hex) {
  const h = String(hex).replace(/^0x/i, "");
  const even = h.length % 2 === 0 ? h : `0${h}`;
  const out = new Uint8Array(even.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(even.substr(i * 2, 2), 16);
  return out;
}

/** Encode bytes as lowercase hex (no 0x prefix) — the canonical form for every digest we store/compare. */
export function bytesToHex(bytes) {
  let s = "";
  for (const b of bytes) s += b.toString(16).padStart(2, "0");
  return s;
}

/**
 * An unsigned 64-bit big-endian encoding of a non-negative integer (the cron index domain separator).
 * For Number inputs this is byte-for-byte poca.ts `u64be`. A BigInt fast-path is added ONLY so the golden
 * vectors can exercise the 2^64-1 boundary precisely (Number(2^64-1) rounds to 2^64); the worker's cron
 * index is always a small non-negative integer, so the Number path — the only one it ever hits — is unchanged.
 */
export function u64be(n) {
  const b = new Uint8Array(8);
  const big = typeof n === "bigint" ? n : BigInt(Math.max(0, Math.floor(Number(n))));
  new DataView(b.buffer).setBigUint64(0, big, false);
  return b;
}

/** Concatenate byte arrays into one fresh contiguous buffer. */
export function concatBytes(...arrs) {
  const total = arrs.reduce((a, b) => a + b.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const a of arrs) { out.set(a, off); off += a.length; }
  return out;
}

/** Raw sha256 of a byte buffer, returned as bytes (the Merkle fold + cron digest work in bytes). */
export async function sha256Bytes(bytes) {
  const dig = await crypto.subtle.digest("SHA-256", bytes);
  return new Uint8Array(dig);
}

// ============================== canonical JSON + sha256Hex (mirror provenance.ts) ==============================

/**
 * Deterministic JSON: object keys sorted recursively, arrays keep their (meaningful) order. Byte-identical
 * to provenance.ts `canonical` — the exact serialisation folded into every stateDigest.
 */
export function canonical(value) {
  const walk = (v) => {
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === "object") {
      const out = {};
      for (const k of Object.keys(v).sort()) out[k] = walk(v[k]);
      return out;
    }
    return v;
  };
  return JSON.stringify(walk(value));
}

/** SHA-256 of a value's canonical form, as 64 lowercase hex chars (no 0x). Mirrors provenance.sha256Hex. */
export async function sha256Hex(value) {
  const bytes = new TextEncoder().encode(canonical(value));
  const dig = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(dig)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

// ============================== digest chain (mirror poca.ts) ==============================

/** stateDigest = sha256(canonical JSON of the PocoStateInput snapshot). Deterministic. */
export async function stateDigest(state) {
  return sha256Hex(state);
}

/**
 * cronDigest_i = sha256( prevDigest || u64be(i) || stateDigest || codeCommitment ), over raw bytes.
 * `prevDigest` is the previous cron digest (ZERO64 at genesis), `i` is the 0-based position WITHIN the
 * epoch, and every input is a 64-hex string decoded to 32 bytes (u64be(i) is 8 bytes). The byte layout is
 * fixed and public so any verifier can recompute a digest from its four inputs.
 */
export async function cronDigest(prevDigest, i, stateDigestHex, codeCommitment) {
  const bytes = concatBytes(
    hexToBytes(prevDigest),
    u64be(i),
    hexToBytes(stateDigestHex),
    hexToBytes(codeCommitment),
  );
  return bytesToHex(await sha256Bytes(bytes));
}

// ============================== Merkle tree (mirror poca.ts) ==============================

/**
 * The Merkle root of a list of 64-hex digests: sha256 pairwise fold, ODD TAIL DUPLICATED (the lone last
 * node is paired with itself), until one node remains. Empty ⇒ ZERO64; single leaf ⇒ the leaf itself.
 */
export async function merkleRoot(digests) {
  if (digests.length === 0) return ZERO64;
  let level = digests.map(hexToBytes);
  while (level.length > 1) {
    const next = [];
    for (let j = 0; j < level.length; j += 2) {
      const left = level[j];
      const right = j + 1 < level.length ? level[j + 1] : level[j]; // odd tail: duplicate the lone node
      next.push(await sha256Bytes(concatBytes(left, right)));
    }
    level = next;
  }
  return bytesToHex(level[0]);
}

/**
 * The inclusion proof for the digest at `index`: sibling hashes + directions to recompute the root, plus
 * the root and the leaf. direction 0 ⇒ the node is the LEFT child (hash(cur||sib)); 1 ⇒ RIGHT (hash(sib||cur)).
 * null when index is out of range. Built with the SAME fold/duplicate rule as merkleRoot.
 */
export async function merkleProof(digests, index) {
  if (!Number.isInteger(index) || index < 0 || index >= digests.length) return null;
  const leaf = digests[index];
  let level = digests.map(hexToBytes);
  let idx = index;
  const path = [];
  while (level.length > 1) {
    const next = [];
    for (let j = 0; j < level.length; j += 2) {
      const left = level[j];
      const right = j + 1 < level.length ? level[j + 1] : level[j];
      if (idx === j) path.push({ sibling: bytesToHex(right), direction: 0 });
      else if (idx === j + 1) path.push({ sibling: bytesToHex(left), direction: 1 });
      next.push(await sha256Bytes(concatBytes(left, right)));
    }
    idx = Math.floor(idx / 2);
    level = next;
  }
  return { root: bytesToHex(level[0]), path, leaf };
}

/** Recompute a root from a leaf + its proof path and compare. True iff the leaf is genuinely at that index. */
export async function merkleVerify(leaf, path, root) {
  let cur = hexToBytes(leaf);
  for (const step of path) {
    const sib = hexToBytes(step.sibling);
    cur = step.direction === 0
      ? await sha256Bytes(concatBytes(cur, sib))
      : await sha256Bytes(concatBytes(sib, cur));
  }
  return bytesToHex(cur) === String(root).replace(/^0x/i, "").toLowerCase();
}

// ============================== small shared predicates ==============================

/** True for the all-zero 32-byte word (with or without 0x). */
export function isZeroBytes32(w) {
  return !w || /^0x0{64}$/.test(String(w).toLowerCase()) || /^0{64}$/.test(String(w).toLowerCase());
}

/** Normalise any hex-ish string to bare lowercase 64-hex (strip 0x) for set/equality comparisons. */
export function normHex(h) {
  return String(h ?? "").replace(/^0x/i, "").toLowerCase();
}

/** Normalise an address to bare lowercase (strip 0x) for set comparisons. */
export function normAddr(a) {
  return String(a ?? "").replace(/^0x/i, "").toLowerCase();
}

// ============================== criterion ① — code identity (pure) ==============================

/**
 * Criterion ① CODE IDENTITY, pure decision core.
 *
 * Every epoch carries the codeCommitment it opened under. A change between consecutive epochs MUST be
 * explained by a kind=7 CODE_CHANGE admin entry whose timestamp falls within ±1 epoch of the boundary, and
 * the live /poca.codeCommitment MUST equal the most recent epoch's commitment. An unexplained rotation is a
 * silent code swap — the exact thing PoCA exists to expose.
 *
 * @param epochs  SEALED epochs, ASCENDING by index: [{ index, codeCommitment, openTs, endTs }]
 * @param admin   admin log entries: [{ kind, ts }] (ts in ms)
 * @param currentCodeCommitment  the live /poca.codeCommitment (64-hex)
 * @param windowMs  tolerance for matching a change to an admin event (default: one epoch ≈ 24h)
 */
export function checkCodeIdentity(epochs, admin, currentCodeCommitment, windowMs = 86_400_000) {
  const evidence = [];
  const asc = (epochs || []).slice().sort((a, b) => a.index - b.index);
  const codeChanges = (admin || []).filter((e) => Number(e.kind) === PocoAdminKind.CODE_CHANGE);

  // Every change point between consecutive epochs must be explained by a nearby kind=7 event.
  const changePoints = [];
  const unexplained = [];
  for (let k = 1; k < asc.length; k++) {
    const prev = asc[k - 1];
    const cur = asc[k];
    if (normHex(prev.codeCommitment) !== normHex(cur.codeCommitment)) {
      const boundaryTs = cur.openTs ?? prev.endTs ?? null;
      const explained = boundaryTs != null && codeChanges.some((e) => Math.abs(Number(e.ts) - boundaryTs) <= windowMs);
      changePoints.push({ fromEpoch: prev.index, toEpoch: cur.index, from: prev.codeCommitment, to: cur.codeCommitment, boundaryTs, explained });
      if (!explained) unexplained.push({ fromEpoch: prev.index, toEpoch: cur.index, from: prev.codeCommitment, to: cur.codeCommitment });
    }
  }

  // The live commitment must equal the newest epoch's commitment.
  const latest = asc.length > 0 ? asc[asc.length - 1] : null;
  const latestMatchesCurrent = latest != null && currentCodeCommitment != null
    ? normHex(latest.codeCommitment) === normHex(currentCodeCommitment)
    : null; // null ⇒ nothing to compare (no epochs yet)

  const pass = unexplained.length === 0 && latestMatchesCurrent !== false;
  evidence.push(`${asc.length} epoch(s) inspected, ${changePoints.length} codeCommitment change point(s)`);
  if (unexplained.length > 0) evidence.push(`UNEXPLAINED code rotation(s) with no kind=7 admin event: ${unexplained.map((u) => `${u.fromEpoch}→${u.toEpoch}`).join(", ")}`);
  if (latestMatchesCurrent === false) evidence.push(`live codeCommitment ${currentCodeCommitment} ≠ newest epoch ${latest.codeCommitment}`);
  if (latestMatchesCurrent === null) evidence.push("no sealed epochs to compare the live codeCommitment against");
  if (pass && latestMatchesCurrent === true) evidence.push("live codeCommitment matches the newest epoch; every rotation is admin-attested");

  return { pass, changePoints, unexplained, latestMatchesCurrent, evidence };
}

// ============================== criterion ② — chain integrity (pure) ==============================

/**
 * Criterion ② CHAIN INTEGRITY, pure decision core (the on-chain half).
 *
 * The ContinuityRegistry chains epochs: epochs[i].prevEpochSeal MUST equal epochs[i-1].sealedHead, and every
 * epoch in range MUST be sealed (sealedHead ≠ 0). This mirrors the contract's isUnbroken(from,to) view so the
 * verifier recomputes the same verdict independently rather than trusting a single eth_call.
 *
 * @param onchainEpochs  [{ index, sealedHead, prevEpochSeal }] ASCENDING by index (as read from epochs(i))
 */
export function checkChainIntegrity(onchainEpochs) {
  const asc = (onchainEpochs || []).slice().sort((a, b) => a.index - b.index);
  const breaks = [];
  const evidence = [];
  for (let k = 0; k < asc.length; k++) {
    const ep = asc[k];
    if (isZeroBytes32(ep.sealedHead)) {
      breaks.push({ index: ep.index, reason: "unsealed (sealedHead == 0)" });
      continue;
    }
    if (ep.index > 0) {
      const prev = asc.find((e) => e.index === ep.index - 1);
      const expected = prev ? normHex(prev.sealedHead) : null;
      if (expected != null && normHex(ep.prevEpochSeal) !== expected) {
        breaks.push({ index: ep.index, reason: `prevEpochSeal ${ep.prevEpochSeal} ≠ epochs(${ep.index - 1}).sealedHead ${prev.sealedHead}` });
      }
    }
  }
  const pass = breaks.length === 0 && asc.length > 0;
  evidence.push(`${asc.length} on-chain epoch(s) checked; ${breaks.length} chain break(s)`);
  for (const b of breaks) evidence.push(`BREAK @ epoch ${b.index}: ${b.reason}`);
  if (asc.length === 0) evidence.push("no on-chain epochs to check");
  return { pass, breaks, evidence };
}

/**
 * Criterion ② off-chain↔on-chain agreement, pure: every SEALED epoch served by /poca/epochs must match the
 * on-chain record's sealedHead + merkleRoot byte-for-byte. A divergence means the operator's read-out and the
 * chain disagree — one of them is lying.
 *
 * @param offchain  [{ index, sealedHead, merkleRoot }] from /poca/epochs
 * @param onchain   [{ index, sealedHead, merkleRoot }] from epochs(i)
 */
export function checkOffchainOnchainAgreement(offchain, onchain) {
  const onByIndex = new Map((onchain || []).map((e) => [Number(e.index), e]));
  const mismatches = [];
  const evidence = [];
  let compared = 0;
  for (const oc of (offchain || [])) {
    const on = onByIndex.get(Number(oc.index));
    if (!on) continue; // an off-chain epoch not yet mirrored on-chain is not a mismatch (best-effort mirror)
    compared++;
    if (normHex(oc.sealedHead) !== normHex(on.sealedHead)) mismatches.push({ index: oc.index, field: "sealedHead", offchain: oc.sealedHead, onchain: on.sealedHead });
    if (normHex(oc.merkleRoot) !== normHex(on.merkleRoot)) mismatches.push({ index: oc.index, field: "merkleRoot", offchain: oc.merkleRoot, onchain: on.merkleRoot });
  }
  const pass = mismatches.length === 0;
  evidence.push(`${compared} epoch(s) present both off-chain and on-chain; ${mismatches.length} field mismatch(es)`);
  for (const m of mismatches) evidence.push(`MISMATCH epoch ${m.index}.${m.field}: off-chain ${m.offchain} ≠ on-chain ${m.onchain}`);
  return { pass, mismatches, compared, evidence };
}

// ============================== criterion ③ — time density (pure) ==============================

/**
 * Criterion ③ TIME DENSITY, pure decision core.
 *
 * An epoch seals roughly once per declared cadence (SEAL_THRESHOLD crons ≈ 24h at 1/min). A gap between
 * consecutive EpochSealed block timestamps wider than `gapHours` is a HOLE in the continuity claim: the agent
 * either stopped or stopped sealing. Cadence-relative so a re-tuned cron rate never false-positives.
 *
 * @param sealTs  ASCENDING list of seal timestamps (seconds, from EpochSealed block.timestamp)
 * @param cadenceHours  declared epoch cadence in hours (default 24)
 * @param gapHours  a gap strictly greater than this is a hole (default 36)
 */
export function checkTimeDensity(sealTs, cadenceHours = 24, gapHours = 36) {
  const ts = (sealTs || []).slice().sort((a, b) => a - b);
  const gaps = [];
  const deltas = [];
  const evidence = [];
  for (let k = 1; k < ts.length; k++) {
    const dtHours = (ts[k] - ts[k - 1]) / 3600;
    deltas.push(dtHours);
    if (dtHours > gapHours) gaps.push({ from: ts[k - 1], to: ts[k], hours: dtHours });
  }
  const maxGapHours = deltas.length > 0 ? Math.max(...deltas) : 0;
  // With fewer than two seals there is no interval to judge — SKIP, not FAIL (a single epoch is not a hole).
  const skip = ts.length < 2;
  const pass = skip ? null : gaps.length === 0;
  evidence.push(`${ts.length} seal(s); cadence ${cadenceHours}h, hole threshold ${gapHours}h; max observed gap ${maxGapHours.toFixed(2)}h`);
  for (const g of gaps) evidence.push(`HOLE ${g.hours.toFixed(2)}h between seals @ ${g.from}→${g.to}`);
  if (skip) evidence.push("fewer than two seals — nothing to measure (SKIP)");
  return { pass, skip, gaps, maxGapHours, deltas, evidence };
}

// ============================== criterion ④ — behavioural consistency (pure) ==============================

/**
 * Criterion ④ BEHAVIOURAL CONSISTENCY, pure decision core for ONE sampled cron.
 *
 * A full replay of a cron's stateDigest needs the worker's live internal state, which a public verifier can
 * never reconstruct. This is therefore a COMMITMENT-SELF-CONSISTENCY + ON-CHAIN-ANCHORING check, NOT a
 * full replay (the full replay is covered separately by `npm run replay --flywire`): we confirm the served
 * proof's Merkle path recomputes to its own root, that root equals the epoch's sealed merkleRoot, and that
 * the sampled digest sits inside the epoch's published first/last digest boundary. A forged or mis-rooted
 * proof fails here.
 *
 * @param proof   { digest, root, path } from /poca/proof
 * @param epoch   { merkleRoot, firstDigest, lastDigest, tickCount } from /poca/epoch/{i}
 * @param cron    the sampled cron index within the epoch
 * @param verified  the boolean result of merkleVerify(proof.digest, proof.path, proof.root)
 */
export function checkProofSelfConsistent(proof, epoch, cron, verified) {
  const evidence = [];
  const problems = [];
  if (!proof) { problems.push("no proof returned"); }
  if (verified !== true) { problems.push("merkleVerify(digest,path,root) === false"); }
  if (proof && epoch && normHex(proof.root) !== normHex(epoch.merkleRoot)) {
    problems.push(`proof.root ${proof.root} ≠ epoch.merkleRoot ${epoch.merkleRoot}`);
  }
  // Boundary compatibility: cron 0 must be the firstDigest; the last cron must be the lastDigest.
  if (proof && epoch) {
    if (cron === 0 && epoch.firstDigest && normHex(proof.digest) !== normHex(epoch.firstDigest)) {
      problems.push(`cron 0 digest ${proof.digest} ≠ epoch.firstDigest ${epoch.firstDigest}`);
    }
    const lastIdx = Number.isFinite(Number(epoch.tickCount)) ? Number(epoch.tickCount) - 1 : null;
    if (lastIdx != null && cron === lastIdx && epoch.lastDigest && normHex(proof.digest) !== normHex(epoch.lastDigest)) {
      problems.push(`cron ${cron} digest ${proof.digest} ≠ epoch.lastDigest ${epoch.lastDigest}`);
    }
  }
  const pass = problems.length === 0;
  if (pass) evidence.push(`cron ${cron}: path self-consistent, root matches epoch.merkleRoot, within first/last boundary`);
  for (const p of problems) evidence.push(`cron ${cron}: ${p}`);
  return { pass, problems, evidence, level: "commitment-self-consistency + on-chain anchoring (not full replay)" };
}

// ============================== criterion ⑤ — asset continuity (pure) ==============================

/**
 * Criterion ⑤ ASSET CONTINUITY, pure decision core.
 *
 * Every real USDC transfer the facilitator relayed on-chain should correspond to a published /proofs receipt,
 * and vice-versa. The check is a BIDIRECTIONAL set difference over tx hashes:
 *   · on-chain transfer with NO receipt  ⇒ an UNDECLARED transfer (possible wallet takeover / off-book spend);
 *   · receipt with NO on-chain transfer  ⇒ a published commitment the chain never saw (inconsistent submission).
 * Either direction is a FAIL. Transfer events are matched to receipts by the tx that carried them.
 *
 * @param onchainTxHashes  tx hashes of facilitator USDC Transfer events in the window (getLogs)
 * @param receiptTxHashes  tx hashes from /proofs receipts (real settlements; simulated "0x"/pseudo excluded by caller)
 */
export function checkAssetContinuity(onchainTxHashes, receiptTxHashes) {
  const onchain = new Set((onchainTxHashes || []).map(normHex).filter(Boolean));
  const receipts = new Set((receiptTxHashes || []).map(normHex).filter((h) => h && h !== "0x" && !/^0+$/.test(h)));
  const undeclared = [...onchain].filter((h) => !receipts.has(h));   // on-chain, not declared
  const unbacked = [...receipts].filter((h) => !onchain.has(h));     // declared, not on-chain
  const pass = undeclared.length === 0 && unbacked.length === 0;
  const evidence = [];
  evidence.push(`${onchain.size} on-chain facilitator USDC transfer(s) vs ${receipts.size} published receipt(s)`);
  if (undeclared.length > 0) evidence.push(`UNDECLARED on-chain transfer(s) with no receipt (takeover evidence): ${undeclared.slice(0, 8).join(", ")}${undeclared.length > 8 ? ` …(+${undeclared.length - 8})` : ""}`);
  if (unbacked.length > 0) evidence.push(`receipt(s) with no on-chain transfer (inconsistent submission): ${unbacked.slice(0, 8).join(", ")}${unbacked.length > 8 ? ` …(+${unbacked.length - 8})` : ""}`);
  if (pass) evidence.push("every on-chain transfer is declared and every declared receipt is on-chain");
  return { pass, undeclared, unbacked, evidence };
}

// ============================== browser mount ==============================

// Expose the whole pure surface on window.__pocaVerify so the audit console (and task-50 UI) can call it
// directly with no bundler. Guarded so the Node data:-URL import (no `window`) is a clean no-op.
const api = {
  ZERO64, POCA_ZERO_ADDRESS, SEAL_THRESHOLD, PocoAdminKind, PocoAdminKindName,
  hexToBytes, bytesToHex, u64be, concatBytes, sha256Bytes,
  canonical, sha256Hex, stateDigest, cronDigest,
  merkleRoot, merkleProof, merkleVerify,
  isZeroBytes32, normHex, normAddr,
  checkCodeIdentity, checkChainIntegrity, checkOffchainOnchainAgreement,
  checkTimeDensity, checkProofSelfConsistent, checkAssetContinuity,
};

if (typeof globalThis !== "undefined") {
  // In a browser this is `window`; in Node it is `globalThis` (harmless, and useful for the CLI selftest).
  globalThis.__pocaVerify = api;
}

export default api;
