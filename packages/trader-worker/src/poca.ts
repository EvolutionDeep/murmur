// poca.ts — PROOF OF CONTINUOUS AGENCY (the worker-side off-chain engine + pure crypto).
//
// THE QUESTION IT ANSWERS. Provenance (provenance.ts) binds ONE trade to the neurons that decided it.
// PoCA answers a different, longer-horizon question: "over the last ~180 days, was the behaviour of this
// swarm produced CONTINUOUSLY by the SAME declared program — or was the code silently swapped, the state
// reset, the DO rebuilt, a parameter overridden, or the committer wallet taken over?" A sceptic should be
// able to answer it from public data alone, without trusting the operator.
//
// HOW. Every cron folds a canonical snapshot of the live state into a hash chain:
//
//   stateDigest  = sha256(canonical JSON of the tick's salient state)
//   cronDigest_i = sha256( prevDigest || u64be(i) || stateDigest || codeCommitment )   // raw byte concat
//
// `prevDigest` is the previous cron digest (genesis = 64 zero hex), so the digests form an append-only
// chain: rewriting or dropping ANY past cron invalidates every digest after it. `codeCommitment` (from
// codeCommitment.ts) is mixed into EVERY digest, so the chain is cryptographically bound to the exact
// source tree that produced it — a code swap changes the commitment and is recorded as a break.
//
// Digests accumulate into ~24h EPOCHS (SEAL_THRESHOLD crons). When an epoch fills it is sealed: its
// digests are folded into a Merkle root and the (root, sealedHead, tickCount) is mirrored on-chain via the
// PoCARegistry (best-effort — see x402.ts). Every administrative discontinuity (reset / manual tick /
// param override / committer change / genesis seed / DO rebuild / code change) is logged locally AND
// mirrored on-chain as an adminAction(kind, payloadHash), so a verifier sees not just the happy chain but
// every moment the operator intervened.
//
// DISABLED MODE. Until the PoCARegistry contract is deployed, config resolves pocaRegistryAddress to the
// zero address; the chain hooks (PocoChainHooks) then degrade to null and NO on-chain call is made. The
// off-chain epoch chain, the admin log and every /poca read-out run IDENTICALLY either way — flipping the
// address on later merely starts mirroring an already-running chain.
//
// This module is deliberately dependency-light (only provenance.sha256Hex) and fully unit-testable with an
// in-memory PocoStore + stub PocoChainHooks; it never touches DO/Wrangler/viem directly. state.ts owns the
// wiring (storage adapter, chain hooks via economy, cron entry/exit, routes).

import { sha256Hex } from "./provenance.js";

// ============================== constants ==============================

/** 64 zero hex chars — the genesis `prevDigest` and the Merkle root of an empty epoch. */
export const ZERO64 = "0".repeat(64);

/** Zero address — the DISABLED sentinel for the on-chain registry (no mirror, off-chain only). */
export const POCA_ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

/**
 * Cron digests per epoch before an automatic seal. ~1440 ≈ one per minute for 24h at the production cron
 * cadence, so an epoch is roughly a day of continuous agency. The digest blob stays tiny (~1440 × 66B ≈
 * 95KB, far under the 2MB DO value cap), so a single-key rewrite per append is cheap enough.
 */
export const SEAL_THRESHOLD = 1440;

/** Hard cap on the retained admin log (oldest dropped first) so `poca:admin` can never grow unbounded. */
export const ADMIN_LOG_CAP = 500;

// DO storage keys. Each is small except the per-epoch digest blob (`poca:e<i>:digests`).
const KEY_HEAD = "poca:head";             // string  — latest cron digest (cheap read for /poca)
const KEY_EPOCH = "poca:epoch";           // object  — the OPEN epoch's metadata (PocoEpochMeta)
const KEY_EPOCHS = "poca:epochs";         // number[]— indices of SEALED (closed) epochs, ascending
const KEY_ADMIN = "poca:admin";           // object[]— the capped admin log (PocoAdminEntry[])
const KEY_COMMITTER = "poca:committer";   // string  — last-seen committer address (kind4 detection)
const KEY_KNOBS = "poca:knobs";           // string  — last-seen runtime knob snapshot hash (kind3 detection)
const digestsKey = (i: number): string => `poca:e${i}:digests`;   // string[] — one epoch's cron digests
const sealedKey = (i: number): string => `poca:sealed:${i}`;      // object   — a sealed epoch's full record

// ============================== admin kinds (match the on-chain contract 1:1) ==============================

/**
 * The administrative-discontinuity kinds, byte-identical to the PoCARegistry `adminAction(uint8 kind, …)`
 * contract enum. A verifier reads the same numbers off-chain and on-chain.
 */
export const PocoAdminKind = {
  RESET: 1,            // /reset invoked — the swarm state (and epoch) was deliberately restarted
  MANUAL_TICK: 2,      // a tick driven by a human hitting the public /tick route, not the cron alarm
  PARAM_OVERRIDE: 3,   // the runtime knob snapshot differs from the last-seen one (wrangler params changed)
  COMMITTER_CHANGE: 4, // the facilitator/committer wallet address changed (possible takeover)
  GENESIS_SEED: 5,     // the receipt registry's lazy genesis anchor mined (on-chain chain start)
  DO_REBUILD: 6,       // the Durable Object state was rebuilt / restored to fresh defaults
  CODE_CHANGE: 7,      // CODE_COMMITMENT rotated — a new source tree is now acting
} as const;
export type PocoAdminKind = (typeof PocoAdminKind)[keyof typeof PocoAdminKind];

/** Human-readable names for the admin kinds (endpoint read-out only; never hashed). */
export const PocoAdminKindName: Record<number, string> = {
  1: "RESET",
  2: "MANUAL_TICK",
  3: "PARAM_OVERRIDE",
  4: "COMMITTER_CHANGE",
  5: "GENESIS_SEED",
  6: "DO_REBUILD",
  7: "CODE_CHANGE",
};

// ============================== byte helpers (raw sha256 over concatenated bytes) ==============================
//
// provenance.sha256Hex hashes a value's CANONICAL JSON — right for stateDigest, wrong for the cron digest,
// which must hash a fixed BYTE layout (prevDigest || u64be(i) || stateDigest || codeCommitment). These
// helpers do the raw-byte side deterministically in both the Worker runtime and Node (WebCrypto).

/** Decode an even-length hex string (with or without a 0x prefix) into bytes. */
export function hexToBytes(hex: string): Uint8Array {
  const h = hex.replace(/^0x/i, "");
  const even = h.length % 2 === 0 ? h : `0${h}`;
  const out = new Uint8Array(even.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(even.substr(i * 2, 2), 16);
  return out;
}

/** Encode bytes as lowercase hex (no 0x prefix) — the canonical form for every digest we store/compare. */
export function bytesToHex(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += b.toString(16).padStart(2, "0");
  return s;
}

/** An unsigned 64-bit big-endian encoding of a non-negative integer (the cron index domain separator). */
export function u64be(n: number): Uint8Array {
  const b = new Uint8Array(8);
  new DataView(b.buffer).setBigUint64(0, BigInt(Math.max(0, Math.floor(n))), false);
  return b;
}

/** Concatenate byte arrays into one fresh buffer (so crypto.subtle.digest sees a single contiguous view). */
export function concatBytes(...arrs: Uint8Array[]): Uint8Array {
  const total = arrs.reduce((a, b) => a + b.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const a of arrs) { out.set(a, off); off += a.length; }
  return out;
}

/** Raw sha256 of a byte buffer, returned as bytes (the Merkle fold + cron digest work in bytes, not JSON). */
export async function sha256Bytes(bytes: Uint8Array): Promise<Uint8Array> {
  const dig = await crypto.subtle.digest("SHA-256", bytes);
  return new Uint8Array(dig);
}

// ============================== pure digest / Merkle functions ==============================

/**
 * The salient state folded into each cron digest. state.ts builds this from the live swarm each tick; the
 * exact field set is the PoCA "what matters" contract, so changing it rotates every future stateDigest
 * (which is fine — the chain links via prevDigest, not via a stable field layout). Kept small and stable.
 */
export interface PocoStateInput {
  tickIndex: number;                                   // the swarm tick that produced this cron
  proofChainHead: string;                              // provenance receipt chain head ("" if none yet)
  chronicler: { headHash: string; era: number; seq: number };  // the narrative/era chronicler cursor
  arenaCursor: { openedRound: number; resolvedRound: number }; // prediction-arena progress (-1 when off)
  warCount: number;                                    // house-war progress cursor (-1 when off)
  pop: { size: number; generation: number; civLevel: number }; // population + civilisation level
  econ: { volumeAtomic: string; count: number };       // cumulative settled volume (atomic USDC) + deal count
}

/** stateDigest = sha256(canonical JSON of the state snapshot). Deterministic; same input ⇒ same 64-hex out. */
export async function stateDigest(state: PocoStateInput): Promise<string> {
  return sha256Hex(state);
}

/**
 * cronDigest_i = sha256( prevDigest || u64be(i) || stateDigest || codeCommitment ), over raw bytes.
 * `prevDigest` is the previous cron digest (ZERO64 at genesis), `i` is the digest's 0-based position WITHIN
 * its epoch (the Merkle leaf index), and `codeCommitment` binds the digest to the exact source tree. The
 * byte layout is fixed and public so any verifier can recompute a digest from its four inputs.
 */
export async function cronDigest(
  prevDigest: string,
  i: number,
  stateDigestHex: string,
  codeCommitment: string,
): Promise<string> {
  const bytes = concatBytes(
    hexToBytes(prevDigest),
    u64be(i),
    hexToBytes(stateDigestHex),
    hexToBytes(codeCommitment),
  );
  return bytesToHex(await sha256Bytes(bytes));
}

/** One Merkle inclusion step: the sibling hash + which side the current node sits on (0 = left, 1 = right). */
export interface MerkleStep {
  sibling: string;       // 64-hex sibling node
  direction: 0 | 1;      // 0 ⇒ current node is the LEFT child (hash(cur||sib)); 1 ⇒ RIGHT (hash(sib||cur))
}

/**
 * The Merkle root of a list of 64-hex digests: sha256 pairwise fold, ODD TAIL DUPLICATED (the last lone
 * node is paired with itself), until one node remains. Empty list ⇒ ZERO64; single leaf ⇒ the leaf itself
 * (the loop never runs). Matches the on-chain PoCARegistry's root so an off-chain proof verifies on-chain.
 */
export async function merkleRoot(digests: string[]): Promise<string> {
  if (digests.length === 0) return ZERO64;
  let level = digests.map(hexToBytes);
  while (level.length > 1) {
    const next: Uint8Array[] = [];
    for (let j = 0; j < level.length; j += 2) {
      const left = level[j];
      const right = j + 1 < level.length ? level[j + 1] : level[j];   // odd tail: duplicate the lone node
      next.push(await sha256Bytes(concatBytes(left, right)));
    }
    level = next;
  }
  return bytesToHex(level[0]);
}

/**
 * The inclusion proof for the digest at `index`: the sibling hashes + directions needed to recompute the
 * root, plus the root itself. null when index is out of range. Built with the SAME fold/duplicate rule as
 * merkleRoot, so merkleVerify(leaf, path, root) always closes for a well-formed proof.
 */
export async function merkleProof(
  digests: string[],
  index: number,
): Promise<{ root: string; path: MerkleStep[]; leaf: string } | null> {
  if (!Number.isInteger(index) || index < 0 || index >= digests.length) return null;
  const leaf = digests[index];
  let level = digests.map(hexToBytes);
  let idx = index;
  const path: MerkleStep[] = [];
  while (level.length > 1) {
    const next: Uint8Array[] = [];
    for (let j = 0; j < level.length; j += 2) {
      const left = level[j];
      const right = j + 1 < level.length ? level[j + 1] : level[j];
      if (idx === j) path.push({ sibling: bytesToHex(right), direction: 0 });       // node is the left child
      else if (idx === j + 1) path.push({ sibling: bytesToHex(left), direction: 1 }); // node is the right child
      next.push(await sha256Bytes(concatBytes(left, right)));
    }
    idx = Math.floor(idx / 2);
    level = next;
  }
  return { root: bytesToHex(level[0]), path, leaf };
}

/** Recompute a root from a leaf + its proof path and compare. True iff the leaf is genuinely at that index. */
export async function merkleVerify(leaf: string, path: MerkleStep[], root: string): Promise<boolean> {
  let cur = hexToBytes(leaf);
  for (const step of path) {
    const sib = hexToBytes(step.sibling);
    cur = step.direction === 0
      ? await sha256Bytes(concatBytes(cur, sib))
      : await sha256Bytes(concatBytes(sib, cur));
  }
  return bytesToHex(cur) === root.replace(/^0x/i, "").toLowerCase();
}

// ============================== persisted shapes ==============================

/** The OPEN epoch's metadata (small; rewritten each append to track the tick high-water mark). */
export interface PocoEpochMeta {
  index: number;             // monotonic epoch index (0 at first genesis)
  openTs: number;            // ms epoch opened
  codeCommitment: string;    // the CODE_COMMITMENT this epoch opened under (a mismatch forces a seal)
  genesisHead: string;       // the proof-chain head this epoch started from
  lastTick: number;          // highest tickIndex folded so far (-1 before the first append)
  openTxHash?: string;       // on-chain openEpoch tx hash (only when the registry is enabled + mined)
  rebuildLogged?: boolean;   // kind6 DO_REBUILD already recorded for this epoch (dedupe latch)
}

/** A SEALED epoch's immutable record (retained for /poca/epochs + /poca/proof). */
export interface PocoSealedEpoch {
  index: number;
  openTs: number;
  endTs: number;             // ms epoch sealed
  tickCount: number;         // = number of cron digests in the epoch
  merkleRoot: string;        // 64-hex Merkle root over the epoch's digests
  sealedHead: string;        // the epoch's last cron digest (ZERO64 if it sealed empty)
  genesisHead: string;
  codeCommitment: string;
  reason: string;            // "threshold" | "reset" | "code-change"
  openTxHash?: string;       // on-chain openEpoch tx (when enabled)
  txHash?: string;           // on-chain sealEpoch tx (when enabled)
}

/** One administrative-discontinuity log entry. */
export interface PocoAdminEntry {
  kind: number;              // PocoAdminKind (1..7)
  ts: number;                // ms
  payloadHash: string;       // sha256(canonical({kind,ts,detail})) — commits the reason without leaking it
  note: string;              // short human label (safe to expose)
  txHash?: string;           // on-chain adminAction tx (when enabled)
}

/** The /poca read-out. */
export interface PocoSnapshot {
  enabled: boolean;          // on-chain mirror wired (registry address non-zero)
  codeCommitment: string;
  gitCommit: string;
  registryAddress: string;
  currentEpoch: number | null;
  epochState: { openTs: number; digestCount: number; head: string | null } | null;
  chainHead: string | null;  // the latest cron digest (poca:head)
  epochCount: number;        // closed + open epochs
  adminCount: number;
  continuity: "unbroken" | "pending" | "disabled";
}

// ============================== injected dependencies ==============================

/**
 * The minimal durable KV the engine needs — a thin façade over DurableObjectStorage (state.ts adapts it) so
 * the engine stays testable with an in-memory map. Values are JSON-safe (strings, numbers, arrays, plain
 * objects); `get` returns undefined when absent, mirroring DO semantics.
 */
export interface PocoStore {
  get<T>(key: string): Promise<T | undefined>;
  put<T>(key: string, value: T): Promise<void>;
  delete(key: string): Promise<void | boolean>;
}

/**
 * The on-chain mirror hooks (state.ts wires these to the economy → facilitator delegators). EVERY method is
 * best-effort and returns the tx hash on a mined success or null when disabled/failed, so the engine treats
 * null as "not mirrored" and never as an error — the off-chain chain is authoritative.
 */
export interface PocoChainHooks {
  openEpoch(codeCommitment: string, genesisHead: string): Promise<string | null>;
  sealEpoch(epochIndex: number, sealedHead: string, tickCount: number, merkleRoot: string): Promise<string | null>;
  adminAction(kind: number, payloadHash: string): Promise<string | null>;
  committer(): Promise<string | null>;
}

/** Construction options for the engine. */
export interface PocoEngineOpts {
  store: PocoStore;
  chain: PocoChainHooks;
  codeCommitment: string;              // 64-hex, from codeCommitment.ts CODE_COMMITMENT
  gitCommit: string;                   // from codeCommitment.ts GIT_COMMIT (read-out only)
  registryAddress: string;             // the configured registry address (zero ⇒ disabled)
  sealThreshold?: number;              // default SEAL_THRESHOLD
  adminLogCap?: number;                // default ADMIN_LOG_CAP
  now?: () => number;                  // injectable clock (ms) for deterministic tests
  warn?: (msg: string) => void;        // non-fatal logging sink (default: console.warn)
}

/** What state.ts hands the engine at cron entry so it can detect the admin discontinuities idempotently. */
export interface PocoEnsureInfo {
  genesisHead: string;                 // current proof-chain head (the epoch's start anchor)
  committer?: string | null;           // the facilitator/committer wallet address (kind4)
  knobsHash?: string | null;           // sha256 of the runtime knob snapshot (kind3)
  rebuild?: boolean;                   // state.ts detected a fresh-default restore (kind6)
}

/** What state.ts hands the engine at cron exit to fold one digest. */
export interface PocoAppendInfo {
  state: PocoStateInput;
  tickIndex: number;
  genesisHead: string;                 // used only if an epoch must be (re)opened lazily here
  rebuild?: boolean;                   // explicit DO-rebuild hint (kind6), secondary to tick regression
}

// ============================== the engine ==============================

/**
 * PocoEngine drives the off-chain epoch lifecycle over an injected PocoStore + PocoChainHooks. It is the
 * SINGLE place PoCA state mutates; state.ts calls ensureEpoch() at cron entry, appendDigest() at cron exit,
 * and onReset()/onManualTick()/onGenesisSeeded() from the matching handlers, then reads via snapshot()/
 * listEpochs()/getEpoch()/proof()/listAdmin() for the /poca endpoints. Every on-chain step is best-effort;
 * every local step is idempotent so a re-run cron (or a DO eviction mid-cron) can never corrupt the chain.
 */
export class PocoEngine {
  private readonly store: PocoStore;
  private readonly chain: PocoChainHooks;
  private readonly codeCommitment: string;
  private readonly gitCommit: string;
  private readonly registryAddress: string;
  private readonly sealThreshold: number;
  private readonly adminLogCap: number;
  private readonly now: () => number;
  private readonly warn: (msg: string) => void;

  constructor(o: PocoEngineOpts) {
    this.store = o.store;
    this.chain = o.chain;
    this.codeCommitment = o.codeCommitment;
    this.gitCommit = o.gitCommit;
    this.registryAddress = o.registryAddress;
    this.sealThreshold = o.sealThreshold ?? SEAL_THRESHOLD;
    this.adminLogCap = o.adminLogCap ?? ADMIN_LOG_CAP;
    this.now = o.now ?? (() => Date.now());
    this.warn = o.warn ?? ((m: string) => console.warn(m));
  }

  /** True when the on-chain mirror is wired (a non-zero registry address). */
  get enabled(): boolean {
    return this.registryAddress.toLowerCase() !== POCA_ZERO_ADDRESS;
  }

  // ---------- low-level storage loaders (never throw; absent ⇒ a documented default) ----------

  private async loadHead(): Promise<string | null> {
    const v = await this.store.get<string>(KEY_HEAD);
    return typeof v === "string" && v.length > 0 ? v : null;
  }

  private async loadEpoch(): Promise<PocoEpochMeta | null> {
    const v = await this.store.get<PocoEpochMeta>(KEY_EPOCH);
    return v && typeof v.index === "number" ? v : null;
  }

  private async loadDigests(index: number): Promise<string[]> {
    const v = await this.store.get<string[]>(digestsKey(index));
    return Array.isArray(v) ? v : [];
  }

  private async loadClosed(): Promise<number[]> {
    const v = await this.store.get<number[]>(KEY_EPOCHS);
    return Array.isArray(v) ? v : [];
  }

  private async loadAdmin(): Promise<PocoAdminEntry[]> {
    const v = await this.store.get<PocoAdminEntry[]>(KEY_ADMIN);
    return Array.isArray(v) ? v : [];
  }

  // ---------- lifecycle: open / seal ----------

  /**
   * Open epoch `index`: persist fresh metadata + an empty digest list, then best-effort mirror it on-chain.
   * Does NOT touch poca:head — the hash chain continues unbroken across the epoch boundary (that continuity
   * is the whole point of PoCA); only the digest ARRAY and the Merkle scope restart per epoch.
   */
  private async openEpoch(index: number, genesisHead: string): Promise<PocoEpochMeta> {
    const meta: PocoEpochMeta = {
      index,
      openTs: this.now(),
      codeCommitment: this.codeCommitment,
      genesisHead,
      lastTick: -1,
    };
    await this.store.put(digestsKey(index), [] as string[]);
    const txHash = await this.safeChain(() => this.chain.openEpoch(this.codeCommitment, genesisHead));
    if (txHash) meta.openTxHash = txHash;
    await this.store.put(KEY_EPOCH, meta);
    return meta;
  }

  /**
   * Seal the OPEN epoch: fold its digests into a Merkle root, mirror (sealedHead, tickCount, root) on-chain,
   * persist an immutable SealedEpoch record + append its index to the closed list, then open the next epoch.
   * Best-effort throughout — a failed on-chain seal still closes the epoch off-chain (the chain is
   * authoritative). `reason` records WHY it sealed (threshold / reset / code-change) for the read-out.
   */
  private async sealAndReopen(reason: string, genesisHead: string): Promise<void> {
    const epoch = await this.loadEpoch();
    if (!epoch) return;
    const digests = await this.loadDigests(epoch.index);
    const root = await merkleRoot(digests);
    const sealedHead = digests.length > 0 ? digests[digests.length - 1] : ZERO64;
    const txHash = await this.safeChain(() =>
      this.chain.sealEpoch(epoch.index, sealedHead, digests.length, root),
    );
    const sealed: PocoSealedEpoch = {
      index: epoch.index,
      openTs: epoch.openTs,
      endTs: this.now(),
      tickCount: digests.length,
      merkleRoot: root,
      sealedHead,
      genesisHead: epoch.genesisHead,
      codeCommitment: epoch.codeCommitment,
      reason,
      ...(epoch.openTxHash ? { openTxHash: epoch.openTxHash } : {}),
      ...(txHash ? { txHash } : {}),
    };
    await this.store.put(sealedKey(epoch.index), sealed);
    const closed = await this.loadClosed();
    if (!closed.includes(epoch.index)) {
      closed.push(epoch.index);
      closed.sort((a, b) => a - b);
      await this.store.put(KEY_EPOCHS, closed);
    }
    await this.openEpoch(epoch.index + 1, genesisHead);
  }

  // ---------- admin log ----------

  /**
   * Record one administrative discontinuity: append {kind, ts, payloadHash, note} to the capped local log and
   * best-effort mirror adminAction(kind, payloadHash) on-chain. payloadHash commits the canonical detail so
   * the REASON is provable without publishing it. Oldest entries are dropped past adminLogCap.
   */
  async recordAdmin(kind: PocoAdminKind, detail: unknown, note: string): Promise<PocoAdminEntry> {
    const ts = this.now();
    const payloadHash = await sha256Hex({ kind, ts, detail });
    const txHash = await this.safeChain(() => this.chain.adminAction(kind, payloadHash));
    const entry: PocoAdminEntry = { kind, ts, payloadHash, note, ...(txHash ? { txHash } : {}) };
    const log = await this.loadAdmin();
    log.push(entry);
    while (log.length > this.adminLogCap) log.shift();   // cap: drop the oldest
    await this.store.put(KEY_ADMIN, log);
    return entry;
  }

  // ---------- cron entry ----------

  /**
   * Idempotent cron-entry hook. Guarantees an OPEN epoch exists and that every startup discontinuity is
   * logged exactly once:
   *   • no open epoch + no closed epochs            → genesis: open epoch 0.
   *   • no open epoch + closed epochs / rebuild hint → the DO was rebuilt/wiped mid-life: open the next
   *     index and record kind6 DO_REBUILD (prior epochs survived but the open one did not).
   *   • open epoch under a STALE codeCommitment     → kind7 CODE_CHANGE: seal it, then open a fresh epoch.
   *   • committer address changed since last seen    → kind4 COMMITTER_CHANGE.
   *   • runtime knob snapshot changed since last seen → kind3 PARAM_OVERRIDE.
   * Safe to call every cron: the committer/knobs checks only fire on an actual change (first run just seeds
   * the stored baseline), and the epoch checks are no-ops once an epoch is open under the current code.
   */
  async ensureEpoch(info: PocoEnsureInfo): Promise<void> {
    try {
      let epoch = await this.loadEpoch();
      if (!epoch) {
        const closed = await this.loadClosed();
        const nextIndex = closed.length > 0 ? Math.max(...closed) + 1 : 0;
        const rebuilt = info.rebuild === true || closed.length > 0;
        epoch = await this.openEpoch(nextIndex, info.genesisHead);
        if (rebuilt) {
          await this.recordAdmin(
            PocoAdminKind.DO_REBUILD,
            { nextIndex, closedCount: closed.length, genesisHead: info.genesisHead },
            "no open epoch but prior epochs exist — Durable Object state rebuilt",
          );
        }
      } else if (epoch.codeCommitment !== this.codeCommitment) {
        await this.recordAdmin(
          PocoAdminKind.CODE_CHANGE,
          { epoch: epoch.index, from: epoch.codeCommitment, to: this.codeCommitment },
          "CODE_COMMITMENT rotated — epoch sealed and a new one opened",
        );
        await this.sealAndReopen("code-change", info.genesisHead);
      }

      // Committer-change detection (kind4): compare the live facilitator wallet to the last-seen one.
      const curCommitter = info.committer ? info.committer.toLowerCase() : null;
      const prevCommitter = (await this.store.get<string>(KEY_COMMITTER)) ?? null;
      if (curCommitter && prevCommitter && curCommitter !== prevCommitter.toLowerCase()) {
        await this.recordAdmin(
          PocoAdminKind.COMMITTER_CHANGE,
          { from: prevCommitter, to: curCommitter },
          "facilitator/committer wallet address changed",
        );
      }
      if (curCommitter) await this.store.put(KEY_COMMITTER, curCommitter);

      // Param-override detection (kind3): compare the runtime knob snapshot hash to the last-seen one.
      const curKnobs = info.knobsHash ?? null;
      const prevKnobs = (await this.store.get<string>(KEY_KNOBS)) ?? null;
      if (curKnobs && prevKnobs && curKnobs !== prevKnobs) {
        await this.recordAdmin(
          PocoAdminKind.PARAM_OVERRIDE,
          { from: prevKnobs, to: curKnobs },
          "runtime knob snapshot changed since the last boot (wrangler params overridden)",
        );
      }
      if (curKnobs) await this.store.put(KEY_KNOBS, curKnobs);
    } catch (err) {
      this.warn(`[poca] ensureEpoch failed (non-fatal): ${errMsg(err)}`);
    }
  }

  // ---------- cron exit ----------

  /**
   * Fold ONE cron into the chain (cron exit, best-effort). Computes the stateDigest, links it to the running
   * head via cronDigest, appends to the open epoch's digest array, advances poca:head + the tick high-water
   * mark, and seals+reopens when the epoch reaches sealThreshold. Also the secondary DO-rebuild net: if the
   * tick index REGRESSED below the epoch's high-water mark, the swarm restarted ⇒ kind6. Returns the new
   * digest (or null on any failure — a missed digest is logged, never fatal to the tick).
   */
  async appendDigest(info: PocoAppendInfo): Promise<string | null> {
    try {
      let epoch = await this.loadEpoch();
      if (!epoch) {
        // Defensive: ensureEpoch should have opened one. Open genesis lazily so the chain never stalls.
        epoch = await this.openEpoch(0, info.genesisHead);
      }

      // DO-rebuild detection: an explicit hint, or the tick counter going backwards within a live epoch.
      const regressed = epoch.lastTick >= 0 && info.tickIndex >= 0 && info.tickIndex < epoch.lastTick;
      if ((info.rebuild === true || regressed) && !epoch.rebuildLogged) {
        await this.recordAdmin(
          PocoAdminKind.DO_REBUILD,
          { epoch: epoch.index, tickIndex: info.tickIndex, lastTick: epoch.lastTick, regressed },
          regressed ? "tick index regressed — Durable Object state rebuilt" : "fresh-default state restore detected",
        );
        epoch.rebuildLogged = true;
      }

      const digests = await this.loadDigests(epoch.index);
      const i = digests.length;                                   // 0-based position within the epoch
      const sd = await stateDigest(info.state);
      const prev = (await this.loadHead()) ?? ZERO64;             // chain continues across epochs
      const digest = await cronDigest(prev, i, sd, this.codeCommitment);

      digests.push(digest);
      await this.store.put(digestsKey(epoch.index), digests);
      await this.store.put(KEY_HEAD, digest);
      epoch.lastTick = Math.max(epoch.lastTick, info.tickIndex);
      await this.store.put(KEY_EPOCH, epoch);

      if (digests.length >= this.sealThreshold) {
        await this.sealAndReopen("threshold", info.genesisHead);
      }
      return digest;
    } catch (err) {
      this.warn(`[poca] appendDigest failed (non-fatal): ${errMsg(err)}`);
      return null;
    }
  }

  // ---------- explicit admin handlers (called by state.ts) ----------

  /**
   * /reset handler: seal the running epoch, record kind1 RESET, and open a fresh epoch anchored at the NEW
   * chain genesis. The sealed epoch stays queryable, so a reset is a visible break in the chain, not an
   * erasure — exactly what a continuous-agency proof must expose.
   */
  async onReset(genesisHead: string): Promise<void> {
    try {
      const epoch = await this.loadEpoch();
      await this.recordAdmin(
        PocoAdminKind.RESET,
        { epoch: epoch ? epoch.index : null, genesisHead },
        "/reset invoked — epoch sealed and a new one opened",
      );
      if (epoch) await this.sealAndReopen("reset", genesisHead);
      else await this.openEpoch(0, genesisHead);
    } catch (err) {
      this.warn(`[poca] onReset failed (non-fatal): ${errMsg(err)}`);
    }
  }

  /**
   * Record kind2 MANUAL_TICK when a human drives /tick through the PUBLIC route (not the internal cron
   * alarm). state.ts distinguishes the two by request host; this only logs + mirrors. The tick itself still
   * folds a digest via appendDigest, so a manual tick is both labelled AND chained.
   */
  async onManualTick(detail: unknown): Promise<void> {
    try {
      await this.recordAdmin(PocoAdminKind.MANUAL_TICK, detail, "manual /tick via the public route (not the cron alarm)");
    } catch (err) {
      this.warn(`[poca] onManualTick failed (non-fatal): ${errMsg(err)}`);
    }
  }

  /**
   * Record kind5 GENESIS_SEED — fired from the facilitator's onGenesisSeeded hook the moment the receipt
   * registry's lazy genesis anchor MINES (a once-per-registry-lifetime event). Best-effort.
   */
  async onGenesisSeeded(detail: unknown): Promise<void> {
    try {
      await this.recordAdmin(PocoAdminKind.GENESIS_SEED, detail, "receipt registry genesis anchored on-chain");
    } catch (err) {
      this.warn(`[poca] onGenesisSeeded failed (non-fatal): ${errMsg(err)}`);
    }
  }

  // ---------- read-out (the /poca endpoints) ----------

  /** The GET /poca summary: identity + the live epoch + the chain head + a coarse continuity verdict. */
  async snapshot(): Promise<PocoSnapshot> {
    const epoch = await this.loadEpoch();
    const head = await this.loadHead();
    const closed = await this.loadClosed();
    const admin = await this.loadAdmin();
    const digestCount = epoch ? (await this.loadDigests(epoch.index)).length : 0;
    let continuity: PocoSnapshot["continuity"];
    if (!this.enabled) continuity = "disabled";
    else if (!epoch || !head) continuity = "pending";
    else continuity = "unbroken";
    return {
      enabled: this.enabled,
      codeCommitment: this.codeCommitment,
      gitCommit: this.gitCommit,
      registryAddress: this.registryAddress,
      currentEpoch: epoch ? epoch.index : null,
      epochState: epoch ? { openTs: epoch.openTs, digestCount, head } : null,
      chainHead: head,
      epochCount: closed.length + (epoch ? 1 : 0),
      adminCount: admin.length,
      continuity,
    };
  }

  /** GET /poca/epochs: sealed-epoch records, most recent first, capped at `limit`. */
  async listEpochs(limit = 100): Promise<PocoSealedEpoch[]> {
    const closed = await this.loadClosed();
    const take = closed.slice().sort((a, b) => b - a).slice(0, Math.max(1, limit));
    const out: PocoSealedEpoch[] = [];
    for (const i of take) {
      const rec = await this.store.get<PocoSealedEpoch>(sealedKey(i));
      if (rec) out.push(rec);
    }
    return out;
  }

  /** One epoch's public detail (open or sealed) + digest count + first/last digest sample. */
  async getEpoch(index: number): Promise<{
    index: number;
    state: "open" | "sealed" | "unknown";
    openTs: number | null;
    endTs: number | null;
    tickCount: number;
    digestCount: number;
    merkleRoot: string | null;
    sealedHead: string | null;
    genesisHead: string | null;
    codeCommitment: string | null;
    reason: string | null;
    txHash: string | null;
    firstDigest: string | null;
    lastDigest: string | null;
  } | null> {
    const sealed = await this.store.get<PocoSealedEpoch>(sealedKey(index));
    const open = await this.loadEpoch();
    const digests = await this.loadDigests(index);
    const first = digests.length > 0 ? digests[0] : null;
    const last = digests.length > 0 ? digests[digests.length - 1] : null;
    if (sealed) {
      return {
        index, state: "sealed", openTs: sealed.openTs, endTs: sealed.endTs, tickCount: sealed.tickCount,
        digestCount: digests.length, merkleRoot: sealed.merkleRoot, sealedHead: sealed.sealedHead,
        genesisHead: sealed.genesisHead, codeCommitment: sealed.codeCommitment, reason: sealed.reason,
        txHash: sealed.txHash ?? null, firstDigest: first, lastDigest: last,
      };
    }
    if (open && open.index === index) {
      return {
        index, state: "open", openTs: open.openTs, endTs: null, tickCount: digests.length,
        digestCount: digests.length, merkleRoot: null, sealedHead: null, genesisHead: open.genesisHead,
        codeCommitment: open.codeCommitment, reason: null, txHash: open.openTxHash ?? null,
        firstDigest: first, lastDigest: last,
      };
    }
    // Neither sealed nor open, but digests may still linger — surface what we can, else null.
    if (digests.length === 0) return null;
    return {
      index, state: "unknown", openTs: null, endTs: null, tickCount: digests.length, digestCount: digests.length,
      merkleRoot: null, sealedHead: null, genesisHead: null, codeCommitment: null, reason: null, txHash: null,
      firstDigest: first, lastDigest: last,
    };
  }

  /**
   * GET /poca/proof: the Merkle inclusion proof for one cron digest. `cron` is the 0-based position within
   * the epoch's digest array. The root is recomputed live from the stored digests, so it is correct for both
   * a sealed epoch (matches its stored root) and the still-open epoch (root-over-prefix). null when the
   * epoch/cron is unknown.
   */
  async proof(epoch: number, cron: number): Promise<{
    epoch: number; cron: number; digest: string; root: string; path: MerkleStep[]; sealed: boolean;
  } | null> {
    const digests = await this.loadDigests(epoch);
    const p = await merkleProof(digests, cron);
    if (!p) return null;
    const sealedRec = await this.store.get<PocoSealedEpoch>(sealedKey(epoch));
    return { epoch, cron, digest: p.leaf, root: p.root, path: p.path, sealed: sealedRec != null };
  }

  /** GET /poca/admin: the admin log, most recent first, capped at `limit`. */
  async listAdmin(limit = 100): Promise<(PocoAdminEntry & { kindName: string })[]> {
    const log = await this.loadAdmin();
    return log
      .slice()
      .reverse()
      .slice(0, Math.max(1, limit))
      .map((e) => ({ ...e, kindName: PocoAdminKindName[e.kind] ?? `KIND_${e.kind}` }));
  }

  // ---------- internals ----------

  /** Run a best-effort on-chain hook, swallowing any throw into null so it can never break the chain. */
  private async safeChain(fn: () => Promise<string | null>): Promise<string | null> {
    if (!this.enabled) return null;             // disabled mode: skip the call entirely (no log spam here;
    try {                                       //  the facilitator logs the zero-address skip once itself)
      return await fn();
    } catch (err) {
      this.warn(`[poca] on-chain mirror failed (non-fatal): ${errMsg(err)}`);
      return null;
    }
  }
}

/** Uniform, secret-free error string for the non-fatal warn sink. */
function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
