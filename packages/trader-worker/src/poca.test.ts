// PoCA (Proof of Continuous Agency) tests — the off-chain hash chain + Merkle epochs + admin log.
//
// Three layers are pinned here:
//   1. The PURE crypto primitives: the fixed byte layout of a cron digest (prev || u64be(i) || state ||
//      code), the sha256 Merkle fold (odd tail duplicated), and root/proof/verify self-consistency.
//   2. The ENGINE lifecycle over an in-memory PocoStore + stub PocoChainHooks: genesis open → append →
//      seal-at-threshold → reopen, with the hash chain staying unbroken across the epoch boundary, plus
//      every admin discontinuity (reset / code-change / do-rebuild / committer / knobs) firing exactly once.
//   3. The DISABLED mode: a zero registry address must make NOT ONE on-chain call while the off-chain
//      chain runs identically — so arming the anchor later never changes behaviour, only starts mirroring.
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
  async delete(key: string): Promise<void> {
    this.m.delete(key);
  }
}

/** Stub on-chain hooks that RECORD every call, so a test can assert what was (or was never) mirrored. */
class StubChain implements PocoChainHooks {
  readonly calls: { fn: string; args: unknown[] }[] = [];
  private n = 0;
  constructor(private readonly mined = true) {}
  async openEpoch(cc: string, gh: string): Promise<string | null> {
    this.calls.push({ fn: "openEpoch", args: [cc, gh] });
    return this.mined ? `0xopen${this.n++}` : null;
  }
  async sealEpoch(i: number, sh: string, tc: number, mr: string): Promise<string | null> {
    this.calls.push({ fn: "sealEpoch", args: [i, sh, tc, mr] });
    return this.mined ? `0xseal${this.n++}` : null;
  }
  async adminAction(kind: number, ph: string): Promise<string | null> {
    this.calls.push({ fn: "adminAction", args: [kind, ph] });
    return this.mined ? `0xadmin${this.n++}` : null;
  }
  async committer(): Promise<string | null> {
    this.calls.push({ fn: "committer", args: [] });
    return this.mined ? "0xcommitter" : null;
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
  assert.ok(chain.calls.some((c) => c.fn === "openEpoch"), "openEpoch mirrored on-chain");
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
  assert.ok(chain.calls.some((c) => c.fn === "adminAction" && c.args[0] === PocoAdminKind.RESET));
});

test("engine: a rotated codeCommitment forces kind7 CODE_CHANGE (seal old + reopen new)", async () => {
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
});

test("engine: admin log is capped — the oldest entries are dropped first", async () => {
  const eng = makeEngine({ adminLogCap: 5 });
  for (let k = 0; k < 12; k++) await eng.recordAdmin(PocoAdminKind.MANUAL_TICK, { k }, `tick ${k}`);
  const admin = await eng.listAdmin(100);
  assert.equal(admin.length, 5);
  assert.equal(admin[0].note, "tick 11");        // most recent first
  assert.equal(admin[4].note, "tick 7");         // oldest retained (0..6 dropped)
  assert.equal((await eng.snapshot()).adminCount, 5);
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

  assert.equal(chain.calls.length, 0, "disabled mode NEVER touches the chain");

  // …yet the off-chain chain ran exactly as it would enabled: digests folded, epochs sealed + reopened,
  // admin logged — only the on-chain mirror is skipped.
  assert.ok(d0 && d1 && d0 !== d1);
  const snap = await eng.snapshot();
  assert.equal(snap.enabled, false);
  assert.equal(snap.continuity, "disabled");
  assert.ok(snap.epochCount >= 2);
  assert.ok(snap.adminCount >= 1);
  for (const e of await eng.listEpochs(10)) {
    assert.equal(e.txHash, undefined, "no on-chain tx recorded in disabled mode");
    assert.equal(e.openTxHash, undefined);
  }
});
