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
// ContinuityRegistry (best-effort — see x402.ts). Every administrative discontinuity (reset / manual tick /
// param override / committer change / genesis seed / DO rebuild / code change) is logged locally AND
// mirrored on-chain as an adminAction(kind, payloadHash), so a verifier sees not just the happy chain but
// every moment the operator intervened.
//
// DISABLED MODE. Until the ContinuityRegistry contract is deployed, config resolves pocaRegistryAddress to
// the zero address; the chain hooks (PocoChainHooks) then degrade to null and NO on-chain call is made. The
// off-chain epoch chain, the admin log and every /poca read-out run IDENTICALLY either way — flipping the
// address on later merely starts mirroring an already-running chain.
//
// NON-BLOCKING MIRROR. Every on-chain step (openEpoch / sealEpoch / adminAction) is fired through a serial
// "mirror queue" that the host detaches from the cron's await path (state.ts wires it to
// DurableObjectState.waitUntil). The LOCAL epoch lifecycle (digests, meta, sealed records, admin buckets)
// is always persisted synchronously; only the chain mirror runs afterwards, off the hot path, so a slow or
// reverting RPC can never delay or fail a live tick. Before each open/seal mirror the queue re-checks the
// on-chain index alignment (see mirrorOpen/mirrorSeal) and pauses the mirror on any mismatch.
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

/** Per-kind cap on the bucketed admin log (oldest dropped first) — `poca:admin:k<kind>`. */
export const ADMIN_KIND_CAP = 100;

/** Aggregate cap across every kind bucket (7 × 100 = 700 by default) so the log can never grow unbounded. */
export const ADMIN_TOTAL_CAP = 700;

/**
 * MANUAL_TICK flood-merge window (ms). Multiple public /tick hits inside one window collapse into a SINGLE
 * local kind2 record whose note carries the flood count, so a bot hammering /tick cannot inflate the log.
 */
export const MANUAL_TICK_WINDOW_MS = 5 * 60 * 1000;

// DO storage keys. Each is small except the per-epoch digest blob (`poca:e<i>:digests`).
const KEY_HEAD = "poca:head";             // string  — latest cron digest (cheap read for /poca)
const KEY_EPOCH = "poca:epoch";           // object  — the OPEN epoch's metadata (PocoEpochMeta)
const KEY_EPOCHS = "poca:epochs";         // number[]— indices of SEALED (closed) epochs, ascending
const KEY_ADMIN_LEGACY = "poca:admin";    // object[]— pre-bucketing single admin log (migrated then deleted)
const KEY_MIRROR = "poca:mirror";         // object  — the on-chain mirror alignment state (PocoMirrorState)
const KEY_MANUAL_WIN = "poca:manualwin";  // object  — the live MANUAL_TICK flood-merge window {startTs,count}
const KEY_COMMITTER = "poca:committer";   // string  — last-seen committer address (kind4 detection)
const KEY_KNOBS = "poca:knobs";           // string  — last-seen runtime knob snapshot hash (kind3 detection)
const adminKey = (kind: number): string => `poca:admin:k${kind}`;   // object[] — one kind's capped bucket
const digestsKey = (i: number): string => `poca:e${i}:digests`;     // string[] — one epoch's cron digests
const sealedKey = (i: number): string => `poca:sealed:${i}`;        // object   — a sealed epoch's full record

/** Every admin kind, in enum order — the fixed set of buckets the log is sharded across. */
const ADMIN_KINDS: number[] = [1, 2, 3, 4, 5, 6, 7];

// ============================== admin kinds (match the on-chain contract 1:1) ==============================

/**
 * The administrative-discontinuity kinds, byte-identical to the ContinuityRegistry `adminAction(uint8 kind,
 * …)` contract enum. A verifier reads the same numbers off-chain and on-chain.
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

/**
 * Decode an even-length hex string (with or without a 0x prefix) into bytes. STRICT: an odd length or any
 * non-hex character throws, so a malformed digest can never be silently truncated into a wrong hash. This is
 * the SHARED CONTRACT with the browser-side verifier — the semantics must stay byte-for-byte identical.
 */
export function hexToBytes(hex: string): Uint8Array {
  const h = hex.startsWith("0x") ? hex.slice(2) : hex;
  if (h.length % 2 !== 0 || !/^[0-9a-fA-F]*$/.test(h)) throw new Error("invalid hex string");
  const out = new Uint8Array(h.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(h.slice(i * 2, i * 2 + 2), 16);
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
 * (the loop never runs). Matches the on-chain ContinuityRegistry's root so an off-chain proof verifies
 * on-chain.
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
  digestCount: number;       // cron digests folded so far (self-check + snapshot read WITHOUT the blob)
  codeChangeAdminTs?: number | null;  // ts of the kind7 CODE_CHANGE that opened THIS epoch (null if none)
  committerChecked?: boolean;         // the once-per-epoch on-chain committer boot-check has run
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
  codeChangeAdminTs: number | null;  // ts of the kind7 CODE_CHANGE that opened this epoch (null if none)
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

/**
 * The persisted on-chain mirror alignment state. `aligned` is the last check's verdict, `failures` is a
 * running count of skipped/failed mirrors, `paused` latches when a mirror was skipped for misalignment (or a
 * committer mismatch) and clears on the next successful re-alignment, `lastMirrorTs` is the last MINED
 * mirror, and `lastMirrorSealOk` gates the NEXT epoch's open (an epoch may only be opened on-chain once its
 * predecessor's on-chain seal succeeded). `onChainCount` caches the last observed registry epochCount().
 */
export interface PocoMirrorState {
  aligned: boolean;
  failures: number;
  paused: boolean;
  lastMirrorTs: number | null;
  lastMirrorSealOk: boolean;
  onChainCount: number | null;
}

/** The mirror sub-object exposed by GET /poca — the SHARED CONTRACT with the front-end / verifier. */
export interface PocoMirrorView {
  aligned: boolean;
  failures: number;
  paused: boolean;
  lastMirrorTs: number | null;
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
  mirror: PocoMirrorView;    // the on-chain mirror alignment/pause state (see PocoMirrorState)
}

// ============================== injected dependencies ==============================

/**
 * The minimal durable KV the engine needs — a thin façade over DurableObjectStorage (state.ts adapts it) so
 * the engine stays testable with an in-memory map. Values are JSON-safe (strings, numbers, arrays, plain
 * objects); `get` returns undefined when absent, mirroring DO semantics. `putBatch` writes several keys in
 * ONE atomic operation (DO storage.put(object)); `getMany` reads several keys in one round-trip.
 */
export interface PocoStore {
  get<T>(key: string): Promise<T | undefined>;
  put<T>(key: string, value: T): Promise<void>;
  putBatch(entries: Record<string, unknown>): Promise<void>;
  getMany(keys: string[]): Promise<Record<string, unknown>>;
  delete(key: string): Promise<void | boolean>;
}

/**
 * The on-chain mirror hooks (state.ts wires these to the economy → facilitator delegators). EVERY method is
 * best-effort and returns the tx hash on a mined success or null when disabled/failed, so the engine treats
 * null as "not mirrored" and never as an error — the off-chain chain is authoritative. `epochCount()` reads
 * the registry's on-chain epoch counter so the engine can verify its local index matches before mirroring.
 */
export interface PocoChainHooks {
  openEpoch(codeCommitment: string, genesisHead: string): Promise<string | null>;
  sealEpoch(epochIndex: number, sealedHead: string, tickCount: number, merkleRoot: string): Promise<string | null>;
  adminAction(kind: number, payloadHash: string): Promise<string | null>;
  committer(): Promise<string | null>;
  epochCount(): Promise<number | null>;
}

/** Construction options for the engine. */
export interface PocoEngineOpts {
  store: PocoStore;
  chain: PocoChainHooks;
  codeCommitment: string;              // 64-hex, from codeCommitment.ts CODE_COMMITMENT
  gitCommit: string;                   // from codeCommitment.ts GIT_COMMIT (read-out only)
  registryAddress: string;             // the configured registry address (zero ⇒ disabled)
  sealThreshold?: number;              // default SEAL_THRESHOLD
  adminKindCap?: number;               // default ADMIN_KIND_CAP (per-kind bucket cap)
  adminTotalCap?: number;              // default ADMIN_TOTAL_CAP (aggregate cap)
  now?: () => number;                  // injectable clock (ms) for deterministic tests
  warn?: (msg: string) => void;        // non-fatal logging sink (default: console.warn)
  detach?: (p: Promise<unknown>) => void;  // host hook to keep a detached mirror alive (DO waitUntil)
}

/** What state.ts hands the engine at cron entry so it can detect the admin discontinuities idempotently. */
export interface PocoEnsureInfo {
  genesisHead: string;                 // current proof-chain head (the epoch's start anchor)
  committer?: string | null;           // the facilitator/committer wallet address (kind4 across boots)
  relayAddress?: string | null;        // the economy's live relay wallet — the EXPECTED on-chain committer
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
 * listEpochs()/getEpoch()/proof()/listAdmin() for the /poca endpoints. Every LOCAL step is synchronous,
 * atomic (batch put) and idempotent so a re-run cron (or a DO eviction mid-cron) can never corrupt the
 * chain; every ON-CHAIN step is best-effort and detached onto the serial mirror queue.
 */
export class PocoEngine {
  private readonly store: PocoStore;
  private readonly chain: PocoChainHooks;
  private readonly codeCommitment: string;
  private readonly gitCommit: string;
  private readonly registryAddress: string;
  private readonly sealThreshold: number;
  private readonly adminKindCap: number;
  private readonly adminTotalCap: number;
  private readonly now: () => number;
  private readonly warn: (msg: string) => void;
  private readonly detach: (p: Promise<unknown>) => void;
  /** Serial tail of the fire-and-forget on-chain mirror queue (one op at a time ⇒ no self nonce races). */
  private mirrorQueue: Promise<void> = Promise.resolve();
  /** The expected on-chain committer (the economy relay wallet), captured each cron entry (issue 18). */
  private expectedCommitter: string | null = null;
  /** One-shot latch so the legacy single-key admin log is migrated into buckets at most once. */
  private adminMigrated = false;

  constructor(o: PocoEngineOpts) {
    this.store = o.store;
    this.chain = o.chain;
    this.codeCommitment = o.codeCommitment;
    this.gitCommit = o.gitCommit;
    this.registryAddress = o.registryAddress;
    this.sealThreshold = o.sealThreshold ?? SEAL_THRESHOLD;
    this.adminKindCap = o.adminKindCap ?? ADMIN_KIND_CAP;
    this.adminTotalCap = o.adminTotalCap ?? ADMIN_TOTAL_CAP;
    this.now = o.now ?? (() => Date.now());
    this.warn = o.warn ?? ((m: string) => console.warn(m));
    this.detach = o.detach ?? ((p: Promise<unknown>) => { void p.catch(() => {}); });
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

  private async loadMirror(): Promise<PocoMirrorState> {
    const v = await this.store.get<PocoMirrorState>(KEY_MIRROR);
    return {
      aligned: v?.aligned ?? true,
      failures: typeof v?.failures === "number" ? v.failures : 0,
      paused: v?.paused ?? false,
      lastMirrorTs: typeof v?.lastMirrorTs === "number" ? v.lastMirrorTs : null,
      lastMirrorSealOk: v?.lastMirrorSealOk ?? true,
      onChainCount: typeof v?.onChainCount === "number" ? v.onChainCount : null,
    };
  }

  private async saveMirror(m: PocoMirrorState): Promise<void> {
    await this.store.put(KEY_MIRROR, m);
  }

  // ---------- mirror queue (issue 5: non-blocking, serial) ----------

  /**
   * Append one on-chain mirror task to the serial queue and hand the queue tail to the host's detach hook
   * (DO waitUntil) so the isolate stays alive to finish it AFTER the cron returns. Serialization means PoCA
   * mirrors never race each other for a nonce; a race with the settlement broadcast is tolerated (the losing
   * write reverts ⇒ null ⇒ recovered by the next alignment re-check).
   */
  private enqueueMirror(op: () => Promise<void>): void {
    this.mirrorQueue = this.mirrorQueue
      .then(() => op())
      .catch((e) => this.warn(`[poca] mirror task failed (non-fatal): ${errMsg(e)}`));
    this.detach(this.mirrorQueue);
  }

  /** Await the serial mirror queue to drain (used by tests; a no-op once every detached task has settled). */
  async flushMirrors(): Promise<void> {
    await this.mirrorQueue;
  }

  // ---------- admin log (issue 1③/25: per-kind buckets + defensive legacy migration) ----------

  /** Drop the oldest entries past the per-kind cap. */
  private capBucket(bucket: PocoAdminEntry[]): PocoAdminEntry[] {
    const out = bucket.slice();
    while (out.length > this.adminKindCap) out.shift();
    return out;
  }

  private async loadAdminBucket(kind: number): Promise<PocoAdminEntry[]> {
    const v = await this.store.get<PocoAdminEntry[]>(adminKey(kind));
    return Array.isArray(v) ? v : [];
  }

  /**
   * One-shot defensive migration of the pre-bucketing single `poca:admin` key into the per-kind buckets, then
   * delete it. Production currently has count=0 there, so this is a no-op in practice; it exists so an old DO
   * that DID accumulate a single-key log keeps every entry after the bucketing upgrade.
   */
  private async migrateAdmin(): Promise<void> {
    if (this.adminMigrated) return;
    this.adminMigrated = true;
    const legacy = await this.store.get<PocoAdminEntry[]>(KEY_ADMIN_LEGACY);
    if (Array.isArray(legacy) && legacy.length > 0) {
      const entries: Record<string, unknown> = {};
      for (const kind of ADMIN_KINDS) {
        const bucket = await this.loadAdminBucket(kind);
        for (const e of legacy) if (e && e.kind === kind) bucket.push(e);
        bucket.sort((a, b) => a.ts - b.ts);
        entries[adminKey(kind)] = this.capBucket(bucket);
      }
      await this.store.putBatch(entries);
    }
    await this.store.delete(KEY_ADMIN_LEGACY);
  }

  /** Merge every kind bucket into one ts-ASCENDING list (callers reverse for most-recent-first). */
  private async loadAllAdmin(): Promise<PocoAdminEntry[]> {
    await this.migrateAdmin();
    const rec = await this.store.getMany(ADMIN_KINDS.map(adminKey));
    const out: PocoAdminEntry[] = [];
    for (const kind of ADMIN_KINDS) {
      const arr = rec[adminKey(kind)];
      if (Array.isArray(arr)) out.push(...(arr as PocoAdminEntry[]));
    }
    out.sort((a, b) => a.ts - b.ts);
    return out;
  }

  /** Append one entry to its kind bucket (per-kind cap), then enforce the aggregate cap across all buckets. */
  private async appendAdmin(entry: PocoAdminEntry): Promise<void> {
    await this.migrateAdmin();
    const bucket = await this.loadAdminBucket(entry.kind);
    bucket.push(entry);
    await this.store.put(adminKey(entry.kind), this.capBucket(bucket));
    await this.enforceTotalCap();
  }

  /** Trim the oldest entries across ALL buckets until the aggregate count is within adminTotalCap. */
  private async enforceTotalCap(): Promise<void> {
    const perKind: Record<number, PocoAdminEntry[]> = {};
    let total = 0;
    for (const kind of ADMIN_KINDS) {
      const b = await this.loadAdminBucket(kind);
      perKind[kind] = b;
      total += b.length;
    }
    if (total <= this.adminTotalCap) return;
    // Collect (kind, position) of every entry, oldest-first, and drop the surplus from the front.
    const flat: { kind: number; ts: number }[] = [];
    for (const kind of ADMIN_KINDS) for (const e of perKind[kind]) flat.push({ kind, ts: e.ts });
    flat.sort((a, b) => a.ts - b.ts);
    let toDrop = total - this.adminTotalCap;
    const dropCount: Record<number, number> = {};
    for (const f of flat) {
      if (toDrop <= 0) break;
      dropCount[f.kind] = (dropCount[f.kind] ?? 0) + 1;
      toDrop--;
    }
    const entries: Record<string, unknown> = {};
    for (const kind of ADMIN_KINDS) {
      const n = dropCount[kind] ?? 0;
      if (n > 0) entries[adminKey(kind)] = perKind[kind].slice(n);
    }
    if (Object.keys(entries).length > 0) await this.store.putBatch(entries);
  }

  // ---------- lifecycle: open / seal ----------

  /** Build fresh OPEN-epoch metadata (no writes). digestCount starts at 0; the head is NOT touched here. */
  private buildOpenMeta(index: number, genesisHead: string, codeChangeAdminTs: number | null = null): PocoEpochMeta {
    return {
      index,
      openTs: this.now(),
      codeCommitment: this.codeCommitment,
      genesisHead,
      lastTick: -1,
      digestCount: 0,
      codeChangeAdminTs,
      committerChecked: false,
    };
  }

  /**
   * Open epoch `index`: persist fresh metadata + an empty digest list atomically, then DETACH its on-chain
   * mirror. Does NOT touch poca:head — the hash chain continues unbroken across the epoch boundary (that
   * continuity is the whole point of PoCA); only the digest ARRAY and the Merkle scope restart per epoch.
   */
  private async openEpoch(index: number, genesisHead: string, codeChangeAdminTs: number | null = null): Promise<PocoEpochMeta> {
    const meta = this.buildOpenMeta(index, genesisHead, codeChangeAdminTs);
    await this.store.putBatch({ [digestsKey(index)]: [] as string[], [KEY_EPOCH]: meta });
    if (this.enabled) this.enqueueMirror(() => this.mirrorOpen(meta));
    return meta;
  }

  /**
   * Fold ONE synthetic marker digest into an EMPTY epoch so its seal has a non-zero sealedHead/merkleRoot and
   * tickCount ≥ 1 — the on-chain sealEpoch reverts on a zero root/head (ContinuityRegistry.ZeroHash). The
   * marker is a cronDigest over a canonical empty-state snapshot anchored at the epoch's own genesisHead, so
   * it is deterministic and links into the running chain exactly like a real digest. Returns the new head.
   */
  private async foldMarkerDigest(epoch: PocoEpochMeta): Promise<string | null> {
    try {
      const prev = (await this.loadHead()) ?? ZERO64;
      const tickIndex = epoch.lastTick < 0 ? 0 : epoch.lastTick;
      const markerState: PocoStateInput = {
        tickIndex,
        proofChainHead: epoch.genesisHead,
        chronicler: { headHash: "", era: 0, seq: 0 },
        arenaCursor: { openedRound: -1, resolvedRound: -1 },
        warCount: -1,
        pop: { size: 0, generation: 0, civLevel: 0 },
        econ: { volumeAtomic: "0", count: 0 },
      };
      const sd = await stateDigest(markerState);
      const digest = await cronDigest(prev, 0, sd, this.codeCommitment);
      epoch.lastTick = Math.max(epoch.lastTick, tickIndex);
      epoch.digestCount = 1;
      await this.store.putBatch({
        [digestsKey(epoch.index)]: [digest],
        [KEY_HEAD]: digest,
        [KEY_EPOCH]: epoch,
      });
      return digest;
    } catch (err) {
      this.warn(`[poca] empty-epoch marker digest failed (non-fatal): ${errMsg(err)}`);
      return null;
    }
  }

  /**
   * Seal the OPEN epoch: fold its digests into a Merkle root, persist an immutable SealedEpoch record +
   * append its index to the closed list + open the next epoch in ONE atomic batch, then DETACH the on-chain
   * seal + open mirrors (in order). Best-effort throughout — a failed/skipped on-chain seal still closes the
   * epoch off-chain (the chain is authoritative). `reason` records WHY it sealed; `nextCodeChangeTs` carries
   * the kind7 ts onto the freshly-opened epoch when the seal was forced by a code change.
   */
  private async sealAndReopen(reason: string, genesisHead: string, nextCodeChangeTs: number | null = null): Promise<void> {
    const epoch = await this.loadEpoch();
    if (!epoch) return;
    let digests = await this.loadDigests(epoch.index);
    if (digests.length === 0) {
      const marker = await this.foldMarkerDigest(epoch);
      if (marker) digests = [marker];
    }
    const root = await merkleRoot(digests);
    const sealedHead = digests.length > 0 ? digests[digests.length - 1] : ZERO64;
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
      codeChangeAdminTs: epoch.codeChangeAdminTs ?? null,
      ...(epoch.openTxHash ? { openTxHash: epoch.openTxHash } : {}),
    };
    const closed = await this.loadClosed();
    if (!closed.includes(epoch.index)) {
      closed.push(epoch.index);
      closed.sort((a, b) => a - b);
    }
    const nextMeta = this.buildOpenMeta(epoch.index + 1, genesisHead, nextCodeChangeTs);
    // ATOMIC: sealed record + closed index + the next epoch's meta + its empty digest list in one batch put.
    // The next epoch's digest array is fresh; the sealed epoch's own digests stay for /poca/proof.
    await this.store.putBatch({
      [sealedKey(epoch.index)]: sealed,
      [KEY_EPOCHS]: closed,
      [KEY_EPOCH]: nextMeta,
      [digestsKey(epoch.index + 1)]: [] as string[],
    });
    if (this.enabled) {
      this.enqueueMirror(() => this.mirrorSeal(sealed));
      this.enqueueMirror(() => this.mirrorOpen(nextMeta));
    }
  }

  // ---------- on-chain mirror ops (run inside the serial queue; never on the cron await path) ----------

  /** Read the registry's on-chain epochCount() (null when disabled / RPC error). */
  private async readChainCount(): Promise<number | null> {
    if (!this.enabled) return null;
    try {
      return await this.chain.epochCount();
    } catch (err) {
      this.warn(`[poca] epochCount read failed (non-fatal): ${errMsg(err)}`);
      return null;
    }
  }

  /** Latch the mirror paused + count a failure + record a LOCAL kind6 misalignment note. */
  private async markMisaligned(localIndex: number, chainCount: number | null): Promise<void> {
    const m = await this.loadMirror();
    m.paused = true;
    m.aligned = false;
    m.failures += 1;
    if (chainCount != null) m.onChainCount = chainCount;
    await this.saveMirror(m);
    await this.recordAdminLocal(
      PocoAdminKind.DO_REBUILD,
      { localIndex, chainCount },
      `mirror misalignment: local=${localIndex} chain=${chainCount}`,
    );
  }

  /**
   * Once-per-epoch committer boot-check (issue 18): read the registry's authorized committer and compare it
   * to the economy's live relay wallet. A mismatch means the mirror would be written by (or attributed to)
   * the wrong wallet ⇒ pause the mirror + record a LOCAL kind4. Returns false when the mirror must stop.
   */
  private async verifyCommitter(index: number): Promise<boolean> {
    const epoch = await this.loadEpoch();
    if (!epoch || epoch.index !== index || epoch.committerChecked) return true;  // stale or already checked
    const expected = this.expectedCommitter;
    const onchain = await this.safeChain(() => this.chain.committer());
    if (expected && onchain && onchain.toLowerCase() !== expected.toLowerCase()) {
      const m = await this.loadMirror();
      m.paused = true;
      m.aligned = false;
      m.failures += 1;
      await this.saveMirror(m);
      await this.recordAdminLocal(
        PocoAdminKind.COMMITTER_CHANGE,
        { expected, onchain },
        "on-chain committer != economy relay wallet — mirror paused",
      );
      return false;
    }
    epoch.committerChecked = true;
    await this.store.put(KEY_EPOCH, epoch);
    return true;
  }

  /** Detached on-chain openEpoch, gated by the committer check + the index alignment (local == chainCount). */
  private async mirrorOpen(meta: PocoEpochMeta): Promise<void> {
    if (!this.enabled) return;
    if (!(await this.verifyCommitter(meta.index))) return;
    const m = await this.loadMirror();
    const chainCount = await this.readChainCount();
    if (chainCount == null) { await this.markMisaligned(meta.index, null); return; }
    m.onChainCount = chainCount;
    // open requires localIndex == chainCount AND (epoch 0 OR the previous epoch's on-chain seal succeeded).
    const sealOk = meta.index === 0 ? true : m.lastMirrorSealOk;
    if (meta.index !== chainCount || !sealOk) { await this.markMisaligned(meta.index, chainCount); return; }
    const txHash = await this.safeChain(() => this.chain.openEpoch(this.codeCommitment, meta.genesisHead));
    if (txHash) {
      m.aligned = true;
      m.paused = false;
      m.lastMirrorTs = this.now();
      await this.saveMirror(m);
      const cur = await this.loadEpoch();
      if (cur && cur.index === meta.index && !cur.openTxHash) {
        cur.openTxHash = txHash;
        await this.store.put(KEY_EPOCH, cur);
      }
    } else {
      m.failures += 1;
      await this.saveMirror(m);
    }
  }

  /** Detached on-chain sealEpoch, gated by the index alignment (local == chainCount-1, seal in order). */
  private async mirrorSeal(rec: PocoSealedEpoch): Promise<void> {
    if (!this.enabled) return;
    const m = await this.loadMirror();
    const chainCount = await this.readChainCount();
    if (chainCount == null) { await this.markMisaligned(rec.index, null); return; }
    m.onChainCount = chainCount;
    if (rec.index !== chainCount - 1) { await this.markMisaligned(rec.index, chainCount); return; }
    const txHash = await this.safeChain(() => this.chain.sealEpoch(rec.index, rec.sealedHead, rec.tickCount, rec.merkleRoot));
    if (txHash) {
      m.aligned = true;
      m.paused = false;
      m.lastMirrorTs = this.now();
      m.lastMirrorSealOk = true;
      await this.saveMirror(m);
      const stored = await this.store.get<PocoSealedEpoch>(sealedKey(rec.index));
      if (stored && !stored.txHash) {
        stored.txHash = txHash;
        await this.store.put(sealedKey(rec.index), stored);
      }
    } else {
      m.failures += 1;
      m.lastMirrorSealOk = false;
      await this.saveMirror(m);
    }
  }

  /** Detached on-chain adminAction; skipped while the mirror is paused, writes the tx hash back on success. */
  private async mirrorAdmin(entry: PocoAdminEntry): Promise<void> {
    if (!this.enabled) return;
    const m = await this.loadMirror();
    if (m.paused) return;                       // don't pile writes while misaligned / committer-wrong
    const txHash = await this.safeChain(() => this.chain.adminAction(entry.kind, entry.payloadHash));
    if (!txHash) { m.failures += 1; await this.saveMirror(m); return; }
    m.aligned = true;
    m.lastMirrorTs = this.now();
    await this.saveMirror(m);
    const bucket = await this.loadAdminBucket(entry.kind);
    const i = bucket.findIndex((e) => e.payloadHash === entry.payloadHash && e.ts === entry.ts);
    if (i >= 0 && !bucket[i].txHash) {
      bucket[i] = { ...bucket[i], txHash };
      await this.store.put(adminKey(entry.kind), this.capBucket(bucket));
    }
  }

  /**
   * True when the on-chain committer is acceptable: no expected relay was captured (simulated / no wallet),
   * the read failed (null — treated as "cannot disprove", so mirroring proceeds and the write itself is the
   * real gate), or it matches the economy's relay wallet case-insensitively. A definitive MISMATCH is the
   * only false (issue 18).
   */
  private async committerMatches(): Promise<boolean> {
    const expected = this.expectedCommitter;
    if (!expected) return true;
    const onchain = await this.safeChain(() => this.chain.committer());
    return !onchain || onchain.toLowerCase() === expected.toLowerCase();
  }

  /**
   * Detached per-cron re-check while the mirror is PAUSED: one eth_call to see whether the local open-epoch
   * index has come back into alignment with the chain (e.g. a transient RPC failure cleared). Recovers
   * paused ⇒ false ONLY when BOTH the index re-aligns AND the on-chain committer matches again — a pause
   * raised by a committer mismatch (issue 18) must never be cleared by index alignment alone, or the mirror
   * would resume writing under the wrong wallet. A no-op (no eth_call) while the mirror is healthy.
   */
  private async recheckAlignment(): Promise<void> {
    if (!this.enabled) return;
    const m = await this.loadMirror();
    if (!m.paused) return;
    const chainCount = await this.readChainCount();
    if (chainCount == null) return;
    m.onChainCount = chainCount;
    const epoch = await this.loadEpoch();
    const localIndex = epoch ? epoch.index : 0;
    const indexOk = localIndex === chainCount;
    const committerOk = await this.committerMatches();
    if (indexOk && committerOk) {
      m.paused = false;
      m.aligned = true;
    }
    await this.saveMirror(m);
  }

  // ---------- admin recording ----------

  /**
   * Record one administrative discontinuity LOCALLY (bucketed) and DETACH its on-chain adminAction mirror.
   * payloadHash commits the canonical detail so the REASON is provable without publishing it. Returns the
   * entry synchronously (its txHash is written back later, off the cron path, once the mirror mines).
   */
  async recordAdmin(kind: PocoAdminKind, detail: unknown, note: string): Promise<PocoAdminEntry> {
    const ts = this.now();
    const payloadHash = await sha256Hex({ kind, ts, detail });
    const entry: PocoAdminEntry = { kind, ts, payloadHash, note };
    await this.appendAdmin(entry);
    if (this.enabled) this.enqueueMirror(() => this.mirrorAdmin(entry));
    return entry;
  }

  /** Record one administrative discontinuity LOCALLY ONLY — never mirrored on-chain (kind2 MANUAL_TICK, and
   *  the committer-mismatch / misalignment kind4/kind6 notes raised from inside the mirror queue itself). */
  private async recordAdminLocal(kind: PocoAdminKind, detail: unknown, note: string): Promise<PocoAdminEntry> {
    const ts = this.now();
    const payloadHash = await sha256Hex({ kind, ts, detail });
    const entry: PocoAdminEntry = { kind, ts, payloadHash, note };
    await this.appendAdmin(entry);
    return entry;
  }

  // ---------- cron entry ----------

  /**
   * Idempotent cron-entry hook. Guarantees an OPEN epoch exists and that every startup discontinuity is
   * logged exactly once:
   *   • no open epoch + no closed epochs            → genesis: open epoch 0.
   *   • no open epoch + closed epochs / rebuild hint → the DO was rebuilt/wiped mid-life: open the next
   *     index and record kind6 DO_REBUILD (prior epochs survived but the open one did not).
   *   • open epoch under a STALE codeCommitment     → kind7 CODE_CHANGE: seal it, then open a fresh epoch
   *     (carrying this kind7's ts onto the new epoch as codeChangeAdminTs).
   *   • committer address changed since last seen    → kind4 COMMITTER_CHANGE.
   *   • runtime knob snapshot changed since last seen → kind3 PARAM_OVERRIDE.
   * Also captures the expected on-chain committer (relay wallet) and, while the mirror is paused, detaches a
   * once-per-cron alignment re-check. Safe to call every cron: the committer/knobs checks only fire on an
   * actual change (first run just seeds the stored baseline), and the epoch checks are no-ops once an epoch
   * is open under the current code.
   */
  async ensureEpoch(info: PocoEnsureInfo): Promise<void> {
    try {
      this.expectedCommitter = info.relayAddress
        ? info.relayAddress.toLowerCase()
        : info.committer
          ? info.committer.toLowerCase()
          : null;

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
        const cc = await this.recordAdmin(
          PocoAdminKind.CODE_CHANGE,
          { epoch: epoch.index, from: epoch.codeCommitment, to: this.codeCommitment },
          "CODE_COMMITMENT rotated — epoch sealed and a new one opened",
        );
        await this.sealAndReopen("code-change", info.genesisHead, cc.ts);
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

      // While the mirror is paused, retry alignment once per cron (a no-op eth_call-wise when healthy).
      if (this.enabled) this.enqueueMirror(() => this.recheckAlignment());
    } catch (err) {
      this.warn(`[poca] ensureEpoch failed (non-fatal): ${errMsg(err)}`);
    }
  }

  // ---------- cron exit ----------

  /**
   * Fold ONE cron into the chain (cron exit, best-effort). Self-heals a half-landed seal, self-checks the
   * loaded digest array against meta.digestCount + the running head, computes the stateDigest, links it to
   * the head via cronDigest, and appends digests + head + meta in ONE atomic batch. Seals+reopens when the
   * epoch reaches sealThreshold. Also the secondary DO-rebuild net: if the tick index REGRESSED below the
   * epoch's high-water mark, the swarm restarted ⇒ kind6. Returns the new digest (or null on any failure — a
   * missed digest is logged, never fatal to the tick).
   */
  async appendDigest(info: PocoAppendInfo): Promise<string | null> {
    try {
      let epoch = await this.loadEpoch();
      if (!epoch) {
        // Defensive: ensureEpoch should have opened one. Open genesis lazily so the chain never stalls.
        epoch = await this.openEpoch(0, info.genesisHead);
      }

      // Seal self-heal (issue 4): a prior seal persisted the sealed record but the epoch switch never landed
      // (crash mid-batch on an older build). Detect the stale sealed key and roll forward to the next epoch.
      const alreadySealed = await this.store.get<PocoSealedEpoch>(sealedKey(epoch.index));
      if (alreadySealed) epoch = await this.openEpoch(epoch.index + 1, info.genesisHead);

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

      // Load-time self-check (issue 3): the array length must equal meta.digestCount and its tail must equal
      // the running head; a mismatch truncates to the head-compatible prefix and records a LOCAL kind6.
      await this.selfCheckEpoch(epoch);

      const digests = await this.loadDigests(epoch.index);
      const i = digests.length;                                   // 0-based position within the epoch
      const sd = await stateDigest(info.state);
      const prev = (await this.loadHead()) ?? ZERO64;             // chain continues across epochs
      const digest = await cronDigest(prev, i, sd, this.codeCommitment);

      digests.push(digest);
      epoch.lastTick = Math.max(epoch.lastTick, info.tickIndex);
      epoch.digestCount = digests.length;
      // ATOMIC: digests + head + meta in one batch put (issue 3) so a crash can never desync them.
      await this.store.putBatch({
        [digestsKey(epoch.index)]: digests,
        [KEY_HEAD]: digest,
        [KEY_EPOCH]: epoch,
      });

      if (digests.length >= this.sealThreshold) {
        await this.sealAndReopen("threshold", info.genesisHead);
      }
      return digest;
    } catch (err) {
      this.warn(`[poca] appendDigest failed (non-fatal): ${errMsg(err)}`);
      return null;
    }
  }

  /**
   * The precise self-check semantics (issue 3). `head` (poca:head) and the epoch's digest array are written
   * together in ONE atomic batch, so the AUTHORITATIVE invariant is: the array's tail equals `head`. Two
   * cases:
   *   • tail !== head (a legacy pre-atomic partial write, or a restored snapshot with an orphan tail) ⇒
   *     TRUNCATE to the last head-compatible prefix — lastIndexOf(head)+1, else min(length, digestCount) —
   *     persist atomically, and record a LOCAL kind6. This is the only path that ever drops a digest.
   *   • tail === head but meta.digestCount drifted ⇒ digestCount is a DERIVED CACHE, so silently resync it to
   *     the array length WITHOUT dropping anything (a detached mirror writeback can lag it; see below).
   * stateDigest is never stored, so this is a structural check, not a recomputation of every digest.
   */
  private async selfCheckEpoch(epoch: PocoEpochMeta): Promise<void> {
    const head = await this.loadHead();
    const digests = await this.loadDigests(epoch.index);
    const declared = typeof epoch.digestCount === "number" ? epoch.digestCount : digests.length;
    const headMismatch = digests.length > 0 && head != null && digests[digests.length - 1] !== head;
    if (headMismatch) {
      const p = head != null ? digests.lastIndexOf(head) : -1;
      const target = Math.max(0, Math.min(p >= 0 ? p + 1 : Math.min(digests.length, declared), digests.length));
      const kept = digests.slice(0, target);
      epoch.digestCount = kept.length;
      await this.store.putBatch({ [digestsKey(epoch.index)]: kept, [KEY_EPOCH]: epoch });
      await this.recordAdminLocal(
        PocoAdminKind.DO_REBUILD,
        { epoch: epoch.index, declaredCount: declared, actualCount: digests.length, head, truncatedTo: kept.length },
        "digest-array self-check failed — truncated to the head-compatible prefix",
      );
    } else if (digests.length !== declared) {
      epoch.digestCount = digests.length;   // benign cache resync — never drops a digest
      await this.store.put(KEY_EPOCH, epoch);
    }
  }

  // ---------- explicit admin handlers (called by state.ts) ----------

  /**
   * /reset handler: seal the running epoch, record kind1 RESET, and open a fresh epoch anchored at the NEW
   * chain genesis. `genesisHead` MUST be non-zero (the on-chain openEpoch reverts on a zero genesisHead), so
   * state.ts passes the new chain's real head or a non-zero reset marker. The sealed epoch stays queryable,
   * so a reset is a visible break in the chain, not an erasure — exactly what a continuous-agency proof must
   * expose.
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
   * alarm). LOCAL ONLY (issue 1②): a manual tick is an operator's own action, so it is never mirrored
   * on-chain — only the local admin bucket records it. FLOOD-MERGED (issue 1②): repeated hits inside one
   * MANUAL_TICK_WINDOW_MS collapse into a single record whose note carries the running count. The tick itself
   * still folds a digest via appendDigest, so a manual tick is both labelled AND chained.
   */
  async onManualTick(detail: unknown): Promise<void> {
    try {
      const now = this.now();
      const win = await this.store.get<{ startTs: number; count: number }>(KEY_MANUAL_WIN);
      if (win && typeof win.startTs === "number" && now - win.startTs < MANUAL_TICK_WINDOW_MS) {
        const count = (win.count ?? 1) + 1;
        await this.store.put(KEY_MANUAL_WIN, { startTs: win.startTs, count });
        await this.bumpManualNote(count);
        return;
      }
      await this.store.put(KEY_MANUAL_WIN, { startTs: now, count: 1 });
      await this.recordAdminLocal(
        PocoAdminKind.MANUAL_TICK,
        detail,
        "manual /tick via the public route (not the cron alarm)",
      );
    } catch (err) {
      this.warn(`[poca] onManualTick failed (non-fatal): ${errMsg(err)}`);
    }
  }

  /** Rewrite the newest kind2 bucket entry's note to carry the running flood count (no new record). */
  private async bumpManualNote(count: number): Promise<void> {
    const bucket = await this.loadAdminBucket(PocoAdminKind.MANUAL_TICK);
    if (bucket.length === 0) return;
    bucket[bucket.length - 1] = {
      ...bucket[bucket.length - 1],
      note: `manual /tick via the public route ×${count} (5-minute flood merge)`,
    };
    await this.store.put(adminKey(PocoAdminKind.MANUAL_TICK), this.capBucket(bucket));
  }

  /**
   * Record kind5 GENESIS_SEED — fired from the facilitator's onGenesisSeeded hook the moment the receipt
   * registry's lazy genesis anchor MINES (a once-per-registry-lifetime event). Mirrored best-effort; because
   * the mirror is detached onto the serial queue it never blocks the settlement broadcast that triggered it.
   */
  async onGenesisSeeded(detail: unknown): Promise<void> {
    try {
      await this.recordAdmin(PocoAdminKind.GENESIS_SEED, detail, "receipt registry genesis anchored on-chain");
    } catch (err) {
      this.warn(`[poca] onGenesisSeeded failed (non-fatal): ${errMsg(err)}`);
    }
  }

  // ---------- read-out (the /poca endpoints) ----------

  /** The GET /poca summary: identity + the live epoch + the chain head + continuity + mirror state. */
  async snapshot(): Promise<PocoSnapshot> {
    const epoch = await this.loadEpoch();
    const head = await this.loadHead();
    const closed = await this.loadClosed();
    const admin = await this.loadAllAdmin();
    const m = await this.loadMirror();
    const digestCount = epoch ? (epoch.digestCount ?? 0) : 0;   // from meta — no digest-array read (issue 10)
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
      mirror: { aligned: m.aligned, failures: m.failures, paused: m.paused, lastMirrorTs: m.lastMirrorTs },
    };
  }

  /** GET /poca/epochs: sealed-epoch records, most recent first, capped at `limit` (one batched read). */
  async listEpochs(limit = 100): Promise<PocoSealedEpoch[]> {
    const closed = await this.loadClosed();
    const take = closed.slice().sort((a, b) => b - a).slice(0, Math.max(1, limit));
    if (take.length === 0) return [];
    const rec = await this.store.getMany(take.map(sealedKey));   // one round-trip (issue 10)
    const out: PocoSealedEpoch[] = [];
    for (const i of take) {
      const r = rec[sealedKey(i)];
      if (r) out.push(r as PocoSealedEpoch);
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
    codeChangeAdminTs: number | null;
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
        codeChangeAdminTs: sealed.codeChangeAdminTs ?? null,
        txHash: sealed.txHash ?? null, firstDigest: first, lastDigest: last,
      };
    }
    if (open && open.index === index) {
      return {
        index, state: "open", openTs: open.openTs, endTs: null, tickCount: digests.length,
        digestCount: digests.length, merkleRoot: null, sealedHead: null, genesisHead: open.genesisHead,
        codeCommitment: open.codeCommitment, reason: null, codeChangeAdminTs: open.codeChangeAdminTs ?? null,
        txHash: open.openTxHash ?? null, firstDigest: first, lastDigest: last,
      };
    }
    // Neither sealed nor open, but digests may still linger — surface what we can, else null.
    if (digests.length === 0) return null;
    return {
      index, state: "unknown", openTs: null, endTs: null, tickCount: digests.length, digestCount: digests.length,
      merkleRoot: null, sealedHead: null, genesisHead: null, codeCommitment: null, reason: null,
      codeChangeAdminTs: null, txHash: null, firstDigest: first, lastDigest: last,
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

  /** GET /poca/admin: the merged bucketed admin log, most recent first, capped at `limit`. */
  async listAdmin(limit = 100): Promise<(PocoAdminEntry & { kindName: string })[]> {
    const log = await this.loadAllAdmin();
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
