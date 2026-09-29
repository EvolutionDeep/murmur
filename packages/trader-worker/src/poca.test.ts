// PoCA (Proof of Continuous Agency) tests — the off-chain hash chain + Merkle epochs + admin log + mirror.
//
// Four layers are pinned here:
//   1. The PURE crypto primitives: the fixed byte layout of a cron digest (prev || u64be(i) || state ||
//      code), the sha256 Merkle fold (odd tail duplicated), root/proof/verify self-consistency, and the
//      STRICT hexToBytes shared with the browser verifier (issue 19).
//   2. The ENGINE lifecycle over an in-memory PocoStore + stub PocoChainHooks: genesis open → append →
//      seal-at-threshold → reopen, with the hash chain staying unbroken across the epoch boundary, plus
//      every admin discontinuity (reset / code-change / do-rebuild / committer / knobs) firing exactly once.
//   3. The NON-BLOCKING, ALIGNMENT-GATED on-chain MIRROR (issues 2/4/5/18): mirrors are detached onto the
//      host hook (never awaited on the local path), an empty epoch folds a non-zero marker so the on-chain
//      seal can't revert, a half-landed seal self-heals, an index drift or a wrong committer PAUSES the
//      mirror (and recovers on re-alignment) rather than broadcasting a doomed tx.
//   4. The DISABLED mode: a zero registry address must make NOT ONE on-chain call while the off-chain
//      chain runs identically — so arming the anchor later never changes behaviour, only starts mirroring.
//
// Because every on-chain step is now DETACHED, a test that asserts on `chain.calls` (or on a mirrored tx
// hash) must first `await eng.flushMirrors()` to drain the serial mirror queue. LOCAL state (digests, meta,
// sealed records, admin buckets) is always persisted synchronously, so those assertions need no flush.
//
// Nothing here touches DO/Wrangler/viem; the engine is dependency-light by design (see poca.ts).

import test from "node:test";
import assert from "node:assert/strict";

import {
  ZERO64,
  POCA_ZERO_ADDRESS,
  PocoAdminKind,
  hexToBytes,
  bytesToHex,
  u64be,
  concatBytes,
  sha256Bytes,
  stateDigest,
  cronDigest,
  merkleRoot,
  merkleProof,
  merkleVerify,
  PocoEngine,
  type PocoStore,
  type PocoChainHooks,
  type PocoStateInput,
  type PocoEngineOpts,
} from "./poca.js";

// ============================== helpers ==============================

/** A deterministic, valid 64-hex "leaf" for index k (distinct per k, no crypto needed). */
const leaf = (k: number): string => k.toString(16).padStart(64, "0");

/** A sample salient-state snapshot for tick `t` (the PocoStateInput the engine folds each cron). */
function S(t: number): PocoStateInput {
  return {
    tickIndex: t,
    proofChainHead: `0xproof${t}`,
    chronicler: { headHash: `0xchron${t}`, era: 1, seq: t },
    arenaCursor: { openedRound: -1, resolvedRound: -1 },
    warCount: -1,
    pop: { size: 24, generation: 0, civLevel: 1 },
    econ: { volumeAtomic: "0", count: 0 },
  };
}

/** In-memory PocoStore that stores values as JSON text — mirroring DurableObjectStorage serialization. */
class MemStore implements PocoStore {
  private readonly m = new Map<string, string>();
  async get<T>(key: string): Promise<T | undefined> {
    const raw = this.m.get(key);
    return raw === undefined ? undefined : (JSON.parse(raw) as T);
  }
  async put<T>(key: string, value: T): Promise<void> {
    this.m.set(key, JSON.stringify(value));
  }
  /** Atomic multi-key write (DO storage.put(object)) — applied key-by-key here (a Map has no tx boundary). */
  async putBatch(entries: Record<string, unknown>): Promise<void> {
    for (const [k, v] of Object.entries(entries)) this.m.set(k, JSON.stringify(v));
  }
  /** Batched read (DO storage.get(keys[]) → Map); only present keys appear, exactly like the DO. */
  async getMany(keys: string[]): Promise<Record<string, unknown>> {
    const out: Record<string, unknown> = {};
    for (const k of keys) {
      const raw = this.m.get(k);
      if (raw !== undefined) out[k] = JSON.parse(raw);
    }
    return out;
  }
  async delete(key: string): Promise<void> {
    this.m.delete(key);
  }
}

/**
 * Stub on-chain hooks that RECORD every call AND simulate the registry's epoch counter, so the engine's
 * index-alignment gate (issue 2) exercises its real logic. `chainCount` mirrors the contract's epochCount():
 * a successful openEpoch assigns index=epochCount then increments it; sealEpoch leaves it unchanged. Tests
 * can poke `chainCount` / `committerAddr` / `failWrites` to drive misalignment, committer-mismatch and
 * RPC-failure paths.
 */
class StubChain implements PocoChainHooks {
  readonly calls: { fn: string; args: unknown[] }[] = [];
  private n = 0;
  /** The simulated on-chain epochCount() — advanced by each mined openEpoch, exactly like the contract. */
  chainCount = 0;
  /** The address committer() reports; a mismatch vs the engine's expected relay pauses the mirror (issue 18). */
  committerAddr = "0xcommitter";
  /** When true every WRITE returns null (an RPC/revert), while reads (committer/epochCount) still succeed. */
  failWrites = false;

  async openEpoch(cc: string, gh: string): Promise<string | null> {
    this.calls.push({ fn: "openEpoch", args: [cc, gh] });
    if (this.failWrites) return null;
    this.chainCount++;                       // the contract assigns index = epochCount, then epochCount++
    return `0xopen${this.n++}`;
  }
  async sealEpoch(i: number, sh: string, tc: number, mr: string): Promise<string | null> {
    this.calls.push({ fn: "sealEpoch", args: [i, sh, tc, mr] });
    if (this.failWrites) return null;
    return `0xseal${this.n++}`;
  }
  async adminAction(kind: number, ph: string): Promise<string | null> {
    this.calls.push({ fn: "adminAction", args: [kind, ph] });
    if (this.failWrites) return null;
    return `0xadmin${this.n++}`;
  }
  async committer(): Promise<string | null> {
    this.calls.push({ fn: "committer", args: [] });
    return this.committerAddr;
  }
  async epochCount(): Promise<number | null> {
    this.calls.push({ fn: "epochCount", args: [] });
    return this.chainCount;
  }
}

const CC = "aa".repeat(32);                 // a default 64-hex codeCommitment
const REG = "0x" + "11".repeat(20);         // a non-zero (enabled) registry address

/** Build an engine over fresh in-memory deps, enabled by default, sealing every 3 crons for fast tests. */
function makeEngine(over: Partial<PocoEngineOpts> = {}): PocoEngine {
  let clock = 1_000;
  return new PocoEngine({
    store: new MemStore(),
    chain: new StubChain(),
    codeCommitment: CC,
    gitCommit: "deadbeef",
    registryAddress: REG,
    sealThreshold: 3,
    adminKindCap: 100,
    adminTotalCap: 700,
    now: () => clock++,
    warn: () => {},                          // silence the non-fatal warn sink in tests
    ...over,
  });
}

// ============================== pure primitives ==============================

test("u64be() is an 8-byte big-endian domain separator", () => {
  assert.equal(bytesToHex(u64be(0)), "0000000000000000");
  assert.equal(bytesToHex(u64be(1)), "0000000000000001");
  assert.equal(bytesToHex(u64be(256)), "0000000000000100");
  assert.equal(u64be(1).length, 8);
});

test("hexToBytes() is STRICT: rejects odd length / non-hex, accepts 0x-prefixed + empty (issue 19)", () => {
  assert.equal(bytesToHex(hexToBytes("0xdeadbeef")), "deadbeef");
  assert.equal(bytesToHex(hexToBytes("deadbeef")), "deadbeef");
  assert.equal(bytesToHex(hexToBytes("0xDEADBEEF")), "deadbeef");   // case-insensitive
  assert.equal(hexToBytes("").length, 0);                           // empty ⇒ zero bytes (valid)
  assert.equal(hexToBytes("0x").length, 0);
  assert.throws(() => hexToBytes("abc"), /invalid hex/i);           // odd length
  assert.throws(() => hexToBytes("0xzz"), /invalid hex/i);          // non-hex character
  assert.throws(() => hexToBytes("0xdeadbee"), /invalid hex/i);     // odd length after the prefix strip
  assert.throws(() => hexToBytes("0xdead beef"), /invalid hex/i);   // embedded space
});

test("cronDigest() equals sha256 of the documented byte layout (prev || u64be(i) || state || code)", async () => {
  const prev = ZERO64;
  const i = 7;
  const sd = "ab".repeat(32);
  const cc = "cd".repeat(32);
  const manual = bytesToHex(await sha256Bytes(concatBytes(hexToBytes(prev), u64be(i), hexToBytes(sd), hexToBytes(cc))));
  assert.equal(await cronDigest(prev, i, sd, cc), manual);
  assert.equal((await cronDigest(prev, i, sd, cc)).length, 64);
});

test("cronDigest() is sensitive to every input (chain index / position / state / code)", async () => {
  const sd = "ab".repeat(32);
  const base = await cronDigest(ZERO64, 0, sd, CC);
  assert.notEqual(base, await cronDigest(leaf(9), 0, sd, CC));   // prevDigest matters (the chain link)
  assert.notEqual(base, await cronDigest(ZERO64, 1, sd, CC));   // position i matters (domain separation)
  assert.notEqual(base, await cronDigest(ZERO64, 0, "ff".repeat(32), CC)); // stateDigest matters
  assert.notEqual(base, await cronDigest(ZERO64, 0, sd, "bb".repeat(32))); // codeCommitment matters
});

test("stateDigest() is deterministic and sensitive to the salient state", async () => {
  assert.equal(await stateDigest(S(1)), await stateDigest(S(1)));       // same input ⇒ same 64-hex
  assert.notEqual(await stateDigest(S(1)), await stateDigest(S(2)));     // a different tick differs
  const bumped = { ...S(1), econ: { ...S(1).econ, count: 5 } };
  assert.notEqual(await stateDigest(S(1)), await stateDigest(bumped));   // a single field bump differs
});

test("merkleRoot(): empty ⇒ ZERO64, single ⇒ the leaf, pair ⇒ sha256(l || r)", async () => {
  assert.equal(await merkleRoot([]), ZERO64);
  assert.equal(await merkleRoot([leaf(1)]), leaf(1));
  const expect = bytesToHex(await sha256Bytes(concatBytes(hexToBytes(leaf(1)), hexToBytes(leaf(2)))));
  assert.equal(await merkleRoot([leaf(1), leaf(2)]), expect);
});

test("merkleProof() + merkleVerify() close for every leaf, including odd-tail duplication", async () => {
  for (const n of [1, 2, 3, 4, 5, 7, 16, 17]) {
    const digests = Array.from({ length: n }, (_, k) => leaf(k));
    const root = await merkleRoot(digests);
    for (let idx = 0; idx < n; idx++) {
      const p = await merkleProof(digests, idx);
      assert.ok(p, `proof exists (n=${n}, idx=${idx})`);
      assert.equal(p!.leaf, digests[idx], `leaf matches (n=${n}, idx=${idx})`);
      assert.equal(p!.root, root, `proof root == tree root (n=${n}, idx=${idx})`);
      assert.equal(await merkleVerify(p!.leaf, p!.path, p!.root), true, `verify closes (n=${n}, idx=${idx})`);
    }
  }
});

test("merkleProof() returns null for an out-of-range index", async () => {
  const digests = [leaf(0), leaf(1), leaf(2)];
  assert.equal(await merkleProof(digests, -1), null);
  assert.equal(await merkleProof(digests, 3), null);
  assert.equal(await merkleProof(digests, 1.5), null);
});

test("merkleVerify() rejects a tampered leaf or a wrong root", async () => {
  const digests = [leaf(0), leaf(1), leaf(2), leaf(3)];
  const p = await merkleProof(digests, 2);
  assert.ok(p);
  assert.equal(await merkleVerify(leaf(9), p!.path, p!.root), false);   // wrong leaf
  assert.equal(await merkleVerify(p!.leaf, p!.path, leaf(42)), false);  // wrong root
});

// ============================== engine lifecycle ==============================

test("engine: ensureEpoch opens genesis epoch 0 with no admin discontinuity", async () => {
  const chain = new StubChain();
  const eng = makeEngine({ chain });
  await eng.ensureEpoch({ genesisHead: "0xgenesis" });
  const snap = await eng.snapshot();
  assert.equal(snap.enabled, true);
  assert.equal(snap.currentEpoch, 0);
  assert.equal(snap.epochCount, 1);
  assert.equal(snap.adminCount, 0);           // a clean genesis is NOT a discontinuity
  assert.equal(snap.continuity, "pending");    // no head until the first append
  // The mirror starts healthy; assert only the STABLE fields — the detached open mirror may already have
  // mined (setting lastMirrorTs) by the time snapshot()'s awaits yield, so lastMirrorTs is timing-dependent.
  assert.equal(snap.mirror.paused, false);
  // task 66 honest aligned: false until the detached mirrorOpen actually writes back openTxHash.
  assert.equal(snap.mirror.aligned, false, "aligned=false before the mirror open lands");
  assert.equal(snap.mirror.failures, 0);
  await eng.flushMirrors();                    // the open mirror is detached — drain before asserting
  const snapAfter = await eng.snapshot();
  assert.equal(snapAfter.mirror.aligned, true, "aligned=true after the mirror open succeeds");
  assert.ok(chain.calls.some((c) => c.fn === "openEpoch"), "openEpoch mirrored on-chain");
  assert.equal(chain.chainCount, 1, "the on-chain counter advanced to 1");
});

test("engine: appendDigest folds a chain that links via prevDigest and advances the head", async () => {
  const eng = makeEngine();
  await eng.ensureEpoch({ genesisHead: "0xg" });
  const d0 = await eng.appendDigest({ state: S(0), tickIndex: 0, genesisHead: "0xg" });
  const d1 = await eng.appendDigest({ state: S(1), tickIndex: 1, genesisHead: "0xg" });
  assert.ok(d0 && d1 && d0 !== d1);
  const snap = await eng.snapshot();
  assert.equal(snap.chainHead, d1);
  assert.equal(snap.epochState?.digestCount, 2);
  assert.equal(snap.continuity, "unbroken");
  // recompute d1 by hand from d0 ⇒ proves the running head is the chain link
  const expect = await cronDigest(d0!, 1, await stateDigest(S(1)), CC);
  assert.equal(d1, expect);
});

test("engine: reaching sealThreshold seals the epoch (Merkle root on-chain) and opens the next, chain unbroken", async () => {
  const chain = new StubChain();
  const eng = makeEngine({ chain, sealThreshold: 3 });
  await eng.ensureEpoch({ genesisHead: "0xg" });
  const heads: string[] = [];
  for (let t = 0; t < 3; t++) heads.push((await eng.appendDigest({ state: S(t), tickIndex: t, genesisHead: "0xg" }))!);

  const snap = await eng.snapshot();
  assert.equal(snap.currentEpoch, 1);         // sealed 0, reopened at 1
  assert.equal(snap.epochCount, 2);           // 1 closed + 1 open
  assert.equal(snap.chainHead, heads[2]);     // the head did NOT reset at the boundary

  await eng.flushMirrors();                    // the seal/open mirrors write their tx hashes back asynchronously
  const sealed = (await eng.listEpochs(10))[0];
  assert.equal(sealed.index, 0);
  assert.equal(sealed.tickCount, 3);
  assert.equal(sealed.reason, "threshold");
  assert.equal(sealed.merkleRoot, await merkleRoot(heads));
  assert.equal(sealed.sealedHead, heads[2]);
  assert.ok(sealed.txHash, "sealEpoch tx recorded when enabled");

  const seal = chain.calls.find((c) => c.fn === "sealEpoch");
  assert.ok(seal);
  assert.deepEqual(seal!.args.slice(0, 3), [0, heads[2], 3]);
});

test("engine: proof(epoch,cron) verifies against the sealed epoch's Merkle root", async () => {
  const eng = makeEngine({ sealThreshold: 3 });
  await eng.ensureEpoch({ genesisHead: "0xg" });
  const heads: string[] = [];
  for (let t = 0; t < 3; t++) heads.push((await eng.appendDigest({ state: S(t), tickIndex: t, genesisHead: "0xg" }))!);

  const p = await eng.proof(0, 1);
  assert.ok(p);
  assert.equal(p!.digest, heads[1]);
  assert.equal(p!.root, await merkleRoot(heads));
  assert.equal(p!.sealed, true);
  assert.equal(await merkleVerify(p!.digest, p!.path, p!.root), true);
  assert.equal(await eng.proof(0, 99), null);   // out of range
});

test("engine: /reset seals the running epoch, records kind1 RESET, opens a fresh epoch", async () => {
  const chain = new StubChain();
  const eng = makeEngine({ chain });
  await eng.ensureEpoch({ genesisHead: "0xg" });
  await eng.appendDigest({ state: S(0), tickIndex: 0, genesisHead: "0xg" });
  await eng.onReset("0xnewgenesis");

  const snap = await eng.snapshot();
  assert.equal(snap.currentEpoch, 1);
  const admin = await eng.listAdmin(10);
  const reset = admin.find((a) => a.kind === PocoAdminKind.RESET);
  assert.ok(reset, "RESET recorded");
  assert.equal(reset!.kindName, "RESET");
  assert.equal((await eng.listEpochs(10))[0].reason, "reset");
  await eng.flushMirrors();
  assert.ok(chain.calls.some((c) => c.fn === "adminAction" && c.args[0] === PocoAdminKind.RESET));
});

test("engine: a rotated codeCommitment forces kind7 CODE_CHANGE (seal old + reopen new) and stamps codeChangeAdminTs", async () => {
  const store = new MemStore();
  const chain = new StubChain();
  const ccA = "aa".repeat(32);
  const ccB = "bb".repeat(32);

  const engA = makeEngine({ store, chain, codeCommitment: ccA });
  await engA.ensureEpoch({ genesisHead: "0xg" });
  await engA.appendDigest({ state: S(0), tickIndex: 0, genesisHead: "0xg" });

  // a NEW build (different CODE_COMMITMENT) boots over the SAME durable storage
  const engB = makeEngine({ store, chain, codeCommitment: ccB });
  await engB.ensureEpoch({ genesisHead: "0xg" });

  const admin = await engB.listAdmin(10);
  const cc = admin.find((a) => a.kind === PocoAdminKind.CODE_CHANGE);
  assert.ok(cc, "CODE_CHANGE recorded");
  assert.equal(cc!.kindName, "CODE_CHANGE");
  const snap = await engB.snapshot();
  assert.equal(snap.currentEpoch, 1);
  assert.equal(snap.codeCommitment, ccB);
  const sealed = (await engB.listEpochs(10))[0];
  assert.equal(sealed.reason, "code-change");
  assert.equal(sealed.codeCommitment, ccA);     // the sealed epoch keeps the OLD commitment
  // issue 1③/25: the freshly-opened epoch carries the kind7 ts; the genesis-sealed epoch does not.
  assert.equal(sealed.codeChangeAdminTs, null, "epoch 0 opened at genesis, not via a code change");
  const opened = await engB.getEpoch(1);
  assert.equal(opened?.codeChangeAdminTs, cc!.ts, "the new epoch stamps the CODE_CHANGE ts that opened it");
});

test("engine: admin log is bucketed per kind with a per-kind cap (oldest dropped first)", async () => {
  const eng = makeEngine({ adminKindCap: 5, adminTotalCap: 700 });
  for (let k = 0; k < 12; k++) await eng.recordAdmin(PocoAdminKind.MANUAL_TICK, { k }, `tick ${k}`);
  const admin = await eng.listAdmin(100);
  assert.equal(admin.length, 5);
  assert.equal(admin[0].note, "tick 11");        // most recent first
  assert.equal(admin[4].note, "tick 7");         // oldest retained (0..6 dropped)
  assert.equal((await eng.snapshot()).adminCount, 5);
});

test("engine: the aggregate cap bounds the total across every kind bucket", async () => {
  const eng = makeEngine({ adminKindCap: 100, adminTotalCap: 4 });
  for (let k = 0; k < 6; k++) await eng.recordAdmin(PocoAdminKind.RESET, { k }, `r${k}`);
  const admin = await eng.listAdmin(100);
  assert.equal(admin.length, 4, "the total never exceeds adminTotalCap");
  assert.equal(admin[0].note, "r5");             // newest retained
  assert.equal(admin[3].note, "r2");             // oldest two dropped
});

test("engine: listAdmin merges every kind bucket, most-recent-first, with kind names", async () => {
  const eng = makeEngine();
  await eng.recordAdmin(PocoAdminKind.RESET, {}, "reset-1");
  await eng.recordAdmin(PocoAdminKind.PARAM_OVERRIDE, {}, "param-1");
  await eng.recordAdmin(PocoAdminKind.GENESIS_SEED, {}, "genesis-1");
  const admin = await eng.listAdmin(100);
  assert.equal(admin.length, 3);
  assert.deepEqual(admin.map((a) => a.note), ["genesis-1", "param-1", "reset-1"]);   // ts descending
  assert.deepEqual(admin.map((a) => a.kindName), ["GENESIS_SEED", "PARAM_OVERRIDE", "RESET"]);
});

test("engine: MANUAL_TICK is flood-merged inside one window into a single local record (issue 1②)", async () => {
  let clock = 10_000;
  const eng = makeEngine({ now: () => clock });   // a FROZEN clock ⇒ every hit lands in the same window
  await eng.onManualTick({ t: 0 });
  await eng.onManualTick({ t: 1 });
  await eng.onManualTick({ t: 2 });
  const ticks = (await eng.listAdmin(100)).filter((a) => a.kind === PocoAdminKind.MANUAL_TICK);
  assert.equal(ticks.length, 1, "three hits in one window collapse into ONE record");
  assert.match(ticks[0].note, /×3/, "the note carries the running flood count");
});

test("engine: a tick regression (DO rebuild) records kind6 exactly once per epoch", async () => {
  const eng = makeEngine();
  await eng.ensureEpoch({ genesisHead: "0xg" });
  await eng.appendDigest({ state: S(10), tickIndex: 10, genesisHead: "0xg" });
  // the DO was rebuilt ⇒ the tick counter restarted below the epoch's high-water mark
  await eng.appendDigest({ state: S(0), tickIndex: 0, genesisHead: "0xg" });
  await eng.appendDigest({ state: S(1), tickIndex: 1, genesisHead: "0xg" });
  const rebuilds = (await eng.listAdmin(100)).filter((a) => a.kind === PocoAdminKind.DO_REBUILD);
  assert.equal(rebuilds.length, 1, "kind6 recorded once (deduped by the per-epoch latch)");
});

test("engine: a committer change (kind4) + knob change (kind3) are detected across boots", async () => {
  const store = new MemStore();
  const chain = new StubChain();
  const e1 = makeEngine({ store, chain });
  await e1.ensureEpoch({ genesisHead: "0xg", committer: "0xAAA", knobsHash: "k1" });
  assert.equal((await e1.listAdmin(10)).length, 0);   // the first boot only seeds the baseline

  const e2 = makeEngine({ store, chain });
  await e2.ensureEpoch({ genesisHead: "0xg", committer: "0xBBB", knobsHash: "k2" });
  const admin = await e2.listAdmin(10);
  assert.ok(admin.some((a) => a.kind === PocoAdminKind.COMMITTER_CHANGE), "kind4 on committer change");
  assert.ok(admin.some((a) => a.kind === PocoAdminKind.PARAM_OVERRIDE), "kind3 on knob change");
});

test("engine: two independent runs over identical inputs produce an identical chain", async () => {
  async function run(): Promise<string[]> {
    const eng = makeEngine();
    await eng.ensureEpoch({ genesisHead: "0xg" });
    const out: string[] = [];
    for (let t = 0; t < 5; t++) out.push((await eng.appendDigest({ state: S(t), tickIndex: t, genesisHead: "0xg" }))!);
    return out;
  }
  assert.deepEqual(await run(), await run());
});

// ============================== non-blocking / atomic mirror (issues 2/4/5/18) ==============================

test("engine: on-chain mirrors are DETACHED onto the host hook, never awaited on the local path (issue 5)", async () => {
  let detached = 0;
  const eng = makeEngine({ detach: () => { detached++; } });
  await eng.ensureEpoch({ genesisHead: "0xg" });
  await eng.appendDigest({ state: S(0), tickIndex: 0, genesisHead: "0xg" });
  assert.ok(detached >= 1, "the host detach hook received the serial mirror-queue tail");
  await eng.flushMirrors();
});

test("engine: sealing an EMPTY epoch folds a non-zero marker digest so the on-chain seal can't revert (issue 2)", async () => {
  const chain = new StubChain();
  const eng = makeEngine({ chain });
  await eng.ensureEpoch({ genesisHead: "0xg" });
  await eng.onReset("0xnewgenesis");            // seal epoch 0 with NO digests appended
  await eng.flushMirrors();

  const sealed = (await eng.listEpochs(10))[0];
  assert.equal(sealed.index, 0);
  assert.equal(sealed.reason, "reset");
  assert.equal(sealed.tickCount, 1, "one synthetic marker digest");
  assert.notEqual(sealed.merkleRoot, ZERO64, "a non-zero root (the contract reverts on ZeroHash)");
  assert.notEqual(sealed.sealedHead, ZERO64);
  const seal = chain.calls.find((c) => c.fn === "sealEpoch");
  assert.ok(seal, "the seal was mirrored");
  assert.notEqual(seal!.args[3], ZERO64, "the mirrored Merkle root is non-zero");
});

test("engine: a half-landed seal self-heals — the next append rolls forward past the stale sealed index (issue 4)", async () => {
  const store = new MemStore();
  const eng = makeEngine({ store });
  await eng.ensureEpoch({ genesisHead: "0xg" });
  // Simulate a crash that persisted the SEALED record but never switched the OPEN epoch forward.
  await store.put("poca:sealed:0", {
    index: 0, openTs: 1, endTs: 2, tickCount: 1, merkleRoot: leaf(1), sealedHead: leaf(1),
    genesisHead: "0xg", codeCommitment: CC, reason: "threshold", codeChangeAdminTs: null,
  });
  const d = await eng.appendDigest({ state: S(0), tickIndex: 0, genesisHead: "0xg" });
  assert.ok(d, "the digest still folds");
  const snap = await eng.snapshot();
  assert.equal(snap.currentEpoch, 1, "detected the stale sealed key and opened epoch 1");
  assert.equal(snap.epochState?.digestCount, 1, "the new digest landed in the rolled-forward epoch");
});

test("engine: appendDigest writes digests + head + meta atomically (issue 3)", async () => {
  const store = new MemStore();
  const eng = makeEngine({ store, sealThreshold: 100 });
  await eng.ensureEpoch({ genesisHead: "0xg" });
  const d = await eng.appendDigest({ state: S(0), tickIndex: 0, genesisHead: "0xg" });
  // All three keys reflect the SAME append — no partial-write skew.
  assert.equal(await store.get<string>("poca:head"), d);
  const digests = await store.get<string[]>("poca:e0:digests");
  const meta = await store.get<{ digestCount: number }>("poca:epoch");
  assert.deepEqual(digests, [d]);
  assert.equal(meta?.digestCount, 1, "meta.digestCount tracks the array without a separate read");
});

test("engine: a mirror index drift PAUSES the mirror + records a local kind6, and never broadcasts a doomed open (issue 2)", async () => {
  const chain = new StubChain();
  const eng = makeEngine({ chain });
  await eng.ensureEpoch({ genesisHead: "0xg" });
  chain.chainCount = 99;                        // the local index (0) drifts from the chain (99)
  await eng.flushMirrors();

  const snap = await eng.snapshot();
  assert.equal(snap.mirror.paused, true, "the mirror latched paused");
  assert.equal(snap.mirror.aligned, false);
  assert.ok(snap.mirror.failures >= 1, "a failure was counted");
  assert.ok(
    (await eng.listAdmin(50)).some((a) => a.kind === PocoAdminKind.DO_REBUILD && /misalignment/.test(a.note)),
    "a local kind6 misalignment note was recorded",
  );
  assert.ok(!chain.calls.some((c) => c.fn === "openEpoch"), "the misaligned open was SKIPPED, never sent");

  // Re-alignment: the once-per-cron recheck clears `paused` when the local index matches the chain again.
  chain.chainCount = 0;
  await eng.ensureEpoch({ genesisHead: "0xg" });
  await eng.flushMirrors();
  const recovered = await eng.snapshot();
  assert.equal(recovered.mirror.paused, false, "the mirror recovered on re-alignment");
  assert.equal(recovered.mirror.aligned, true);
});

test("engine: an on-chain committer != the relay wallet PAUSES the mirror + records a local kind4 (issue 18)", async () => {
  const chain = new StubChain();
  chain.committerAddr = "0xOnChainCommitter";
  const eng = makeEngine({ chain });
  await eng.ensureEpoch({ genesisHead: "0xg", relayAddress: "0xRelayWallet" });
  await eng.flushMirrors();

  const snap = await eng.snapshot();
  assert.equal(snap.mirror.paused, true, "the mirror paused on the committer mismatch");
  assert.ok(
    (await eng.listAdmin(50)).some((a) => a.kind === PocoAdminKind.COMMITTER_CHANGE),
    "a local kind4 COMMITTER_CHANGE was recorded",
  );
  assert.ok(!chain.calls.some((c) => c.fn === "openEpoch"), "no epoch is opened by the wrong committer");
});

test("engine: a matching committer passes the boot-check and mirrors normally (issue 18)", async () => {
  const chain = new StubChain();
  chain.committerAddr = "0xRelayWallet";
  const eng = makeEngine({ chain });
  await eng.ensureEpoch({ genesisHead: "0xg", relayAddress: "0xrelaywallet" });   // case-insensitive match
  await eng.flushMirrors();
  const snap = await eng.snapshot();
  assert.equal(snap.mirror.paused, false);
  assert.ok(chain.calls.some((c) => c.fn === "openEpoch"), "the open mirrored once the committer matched");
});

// ============================== self-healing mirror (missing-open retry) ==============================

test("engine: a failed mirrorOpen is retried on the next cron via recheckAlignment self-heal", async () => {
  const chain = new StubChain();
  const eng = makeEngine({ chain });
  // First cron: open epoch 0 but fail the mirror write.
  chain.failWrites = true;
  await eng.ensureEpoch({ genesisHead: "0xg" });
  await eng.flushMirrors();
  let snap = await eng.snapshot();
  assert.equal(snap.mirror.aligned, false, "aligned=false while openTxHash is missing");
  assert.ok(snap.mirror.failures >= 1, "a failure was counted");
  assert.equal(snap.mirror.paused, false, "not paused — just a transient write failure");

  // Second cron: writes succeed → recheckAlignment retries the open.
  chain.failWrites = false;
  await eng.ensureEpoch({ genesisHead: "0xg" });
  await eng.flushMirrors();
  snap = await eng.snapshot();
  assert.equal(snap.mirror.aligned, true, "aligned recovers after the retry succeeds");
  assert.ok(chain.calls.filter((c) => c.fn === "openEpoch").length >= 1, "openEpoch was retried");
  assert.equal(chain.chainCount, 1, "the on-chain counter advanced");
  // The epoch now carries an openTxHash.
  const ep = await eng.getEpoch(0);
  assert.ok(ep?.txHash, "openTxHash written back to the epoch record");
});

test("engine: sealAndReopen with a missing open enqueues open→seal→open and the chain catches up", async () => {
  const store = new MemStore();
  const chain = new StubChain();
  const ccA = "aa".repeat(32);
  const ccB = "bb".repeat(32);

  // Phase 1: open epoch 0 successfully, then fail the mirror open for epoch 1.
  const engA = makeEngine({ store, chain, codeCommitment: ccA, sealThreshold: 3 });
  await engA.ensureEpoch({ genesisHead: "0xg" });
  await engA.flushMirrors();
  assert.equal(chain.chainCount, 1, "epoch 0 opened on-chain");

  // Append 3 digests to trigger a threshold seal → opens epoch 1 locally.
  for (let t = 0; t < 3; t++) await engA.appendDigest({ state: S(t), tickIndex: t, genesisHead: "0xg" });
  // Fail the mirror for epoch 1's open + epoch 0's seal.
  chain.failWrites = true;
  await engA.flushMirrors();
  // The seal and open both failed on-chain.
  let snap = await engA.snapshot();
  assert.equal(snap.currentEpoch, 1);
  assert.equal(chain.chainCount, 1, "chain did not advance (writes failed)");

  // Phase 2: a NEW build (ccB) boots, sees epoch 1 open with no openTxHash.
  // sealAndReopen should enqueue open(e1) → seal(e1) → open(e2).
  chain.failWrites = false;
  // Manually fix chain state: epoch 0's seal needs to succeed for lastMirrorSealOk.
  // Simulate: the seal for e0 failed, so lastMirrorSealOk=false. We need to reset it.
  // Actually let's redo: fail only the open of e1, not the seal of e0.
  // Reset and redo with a cleaner scenario.
  const store2 = new MemStore();
  const chain2 = new StubChain();
  const eng2a = makeEngine({ store: store2, chain: chain2, codeCommitment: ccA, sealThreshold: 3 });
  await eng2a.ensureEpoch({ genesisHead: "0xg" });
  await eng2a.flushMirrors();
  for (let t = 0; t < 3; t++) await eng2a.appendDigest({ state: S(t), tickIndex: t, genesisHead: "0xg" });
  await eng2a.flushMirrors();
  // epoch 0 sealed + epoch 1 opened on-chain successfully.
  assert.equal(chain2.chainCount, 2, "epoch 0 opened + sealed, epoch 1 opened");

  // Now simulate: epoch 1's openTxHash was lost (transient failure on writeback only).
  const epochMeta = await store2.get<{ index: number; openTxHash?: string }>("poca:epoch");
  assert.equal(epochMeta?.index, 1);
  // Clear the openTxHash to simulate the gap.
  delete epochMeta!.openTxHash;
  await store2.put("poca:epoch", epochMeta);
  // Roll back chain to simulate the open never landing.
  chain2.chainCount = 1;

  // Phase 3: code change triggers seal of epoch 1 → should self-heal.
  const eng2b = makeEngine({ store: store2, chain: chain2, codeCommitment: ccB, sealThreshold: 3 });
  await eng2b.ensureEpoch({ genesisHead: "0xg" });
  await eng2b.flushMirrors();

  // Chain should now be: open(e1) → seal(e1) → open(e2) → chainCount=3.
  assert.equal(chain2.chainCount, 3, "chain caught up: open(e1)+seal(e1)+open(e2) = count 3");
  snap = await eng2b.snapshot();
  assert.equal(snap.currentEpoch, 2);
  const sealed = (await eng2b.listEpochs(10)).find((e) => e.index === 1);
  assert.ok(sealed, "epoch 1 is sealed");
  assert.equal(sealed!.reason, "code-change");
  assert.ok(sealed!.openTxHash, "openTxHash written back to the sealed record");
  assert.ok(sealed!.txHash, "sealEpoch tx recorded");
});

test("engine: recovery from chain-behind-1 state — full self-heal to epochCount=3", async () => {
  // Simulates the exact production scenario: chain has epochCount=1 (epoch 0 opened+sealed),
  // local has epoch 1 open (no openTxHash). A code change triggers seal(e1)+open(e2).
  // Expected queue: [open(e1), seal(e1), open(e2)] → chainCount=3, isUnbroken(0,2)=true.
  const store = new MemStore();
  const chain = new StubChain();
  const ccA = "aa".repeat(32);
  const ccB = "bb".repeat(32);

  // Bootstrap: epoch 0 opened and sealed on-chain successfully.
  chain.chainCount = 1;   // epoch 0 was opened
  // Seed local state: epoch 0 sealed, epoch 1 open with no openTxHash.
  await store.put("poca:epochs", [0]);
  await store.put("poca:sealed:0", {
    index: 0, openTs: 100, endTs: 200, tickCount: 3, merkleRoot: leaf(1), sealedHead: leaf(1),
    genesisHead: "0xg", codeCommitment: ccA, reason: "threshold", codeChangeAdminTs: null,
    openTxHash: "0xopen0", txHash: "0xseal0",
  });
  await store.put("poca:epoch", {
    index: 1, openTs: 200, codeCommitment: ccA, genesisHead: "0xg",
    lastTick: 5, digestCount: 6, codeChangeAdminTs: null, committerChecked: true,
    // openTxHash deliberately missing — the mirror open failed
  });
  await store.put("poca:e1:digests", Array.from({ length: 6 }, (_, i) => leaf(i + 10)));
  await store.put("poca:head", leaf(15));
  await store.put("poca:mirror", {
    aligned: true, failures: 1, paused: false,
    lastMirrorTs: 150, lastMirrorSealOk: true, onChainCount: 1,
  });

  // A new build (ccB) boots → CODE_CHANGE → seal epoch 1, open epoch 2.
  const eng = makeEngine({ store, chain, codeCommitment: ccB, sealThreshold: 1440 });
  await eng.ensureEpoch({ genesisHead: "0xg" });
  await eng.flushMirrors();

  // Verify: chain caught up to epochCount=3.
  assert.equal(chain.chainCount, 3, "open(e1)+seal(e1)+open(e2) → chainCount=3");
  const snap = await eng.snapshot();
  assert.equal(snap.currentEpoch, 2);
  assert.equal(snap.epochCount, 3);
  assert.equal(snap.mirror.aligned, true);

  // Verify the sealed epoch 1 has both openTxHash and txHash.
  const sealed1 = (await eng.listEpochs(10)).find((e) => e.index === 1);
  assert.ok(sealed1?.openTxHash, "epoch 1 openTxHash written back");
  assert.ok(sealed1?.txHash, "epoch 1 sealEpoch tx recorded");
  assert.equal(sealed1?.reason, "code-change");

  // Verify the chain call order: openEpoch, sealEpoch, openEpoch.
  const writeCalls = chain.calls.filter((c) => c.fn === "openEpoch" || c.fn === "sealEpoch");
  assert.ok(writeCalls.length >= 3, "at least 3 write calls");
  assert.equal(writeCalls[0].fn, "openEpoch", "first: open epoch 1");
  assert.equal(writeCalls[1].fn, "sealEpoch", "second: seal epoch 1");
  assert.equal(writeCalls[2].fn, "openEpoch", "third: open epoch 2");
});

test("engine: aligned=false in snapshot while openTxHash is missing (honest semantics)", async () => {
  const chain = new StubChain();
  const eng = makeEngine({ chain });
  chain.failWrites = true;
  await eng.ensureEpoch({ genesisHead: "0xg" });
  await eng.flushMirrors();
  const snap = await eng.snapshot();
  assert.equal(snap.mirror.aligned, false, "aligned=false when openTxHash is null");
  assert.equal(snap.mirror.paused, false, "not paused — just un-mirrored");
});

// ============================== disabled (zero-address) mode ==============================

test("engine: zero-address mode makes NO on-chain call but runs the off-chain chain identically", async () => {
  const chain = new StubChain();
  const eng = makeEngine({ chain, registryAddress: POCA_ZERO_ADDRESS, sealThreshold: 2 });
  assert.equal(eng.enabled, false);

  await eng.ensureEpoch({ genesisHead: "0xg" });
  const d0 = await eng.appendDigest({ state: S(0), tickIndex: 0, genesisHead: "0xg" });
  const d1 = await eng.appendDigest({ state: S(1), tickIndex: 1, genesisHead: "0xg" });
  await eng.onReset("0xg2");
  await eng.recordAdmin(PocoAdminKind.PARAM_OVERRIDE, { x: 1 }, "param");
  await eng.flushMirrors();                      // a no-op when nothing was ever enqueued

  assert.equal(chain.calls.length, 0, "disabled mode NEVER touches the chain (not even a read)");

  // …yet the off-chain chain ran exactly as it would enabled: digests folded, epochs sealed + reopened,
  // admin logged — only the on-chain mirror is skipped.
  assert.ok(d0 && d1 && d0 !== d1);
  const snap = await eng.snapshot();
  assert.equal(snap.enabled, false);
  assert.equal(snap.continuity, "disabled");
  assert.equal(snap.mirror.paused, false);
  assert.ok(snap.epochCount >= 2);
  assert.ok(snap.adminCount >= 1);
  for (const e of await eng.listEpochs(10)) {
    assert.equal(e.txHash, undefined, "no on-chain tx recorded in disabled mode");
    assert.equal(e.openTxHash, undefined);
  }
});
