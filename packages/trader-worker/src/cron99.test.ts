/**
 * #99 — Mark #85 review fixes: CRASH-SAFE persistence fault injection.
 *
 * #98 shipped a generation-double-buffered sharded economy persist. Mark's review found the crash safety
 * was nominal: C1 advanced the generation counter BEFORE the atomic commit point, and H1's GC deleted both
 * fallback targets on the first successful commit, so the documented three-tier read degraded to one tier.
 * Stacked, a single torn write zeroed the whole economy (balances, ledger, proof chain, flushSeq, pendingNets)
 * while the mined EIP-3009 transfers stayed live on-chain — a real-money divergence.
 *
 * These tests inject the exact failures #98's suite could not express:
 *   C1  — storage.put(batch) throws; the generation must NOT advance and the next persist must recover.
 *   H1  — a corrupt / torn live generation must fall back to gen^1 (tier 2), then to legacy (tier 3).
 *   M7  — a corrupt partCount must never drive an unbounded allocation; the GC bound must be dynamic.
 *   LEX — the lexicon (KEY_LEXICON, "the membrane of coined words") rides the SAME atomic batch and must
 *         survive every failure mode below, and must NEVER appear in a GC delete set.
 *   M8  — a Lamarck-imprinted breed must be re-derivable from the recorded LineageEntry fields alone.
 *   M9  — the config code-defaults must equal the live wrangler [vars], so the two can never drift again.
 *
 * Everything runs against a stub DurableObjectStorage; the REAL FlyStateDO.persist() / readEconomyBlob() /
 * readShardedEconomyBlob() are under test, not a reimplementation of them.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import type { Genome } from "@fly/fly-brain";

import {
  FlyStateDO,
  readShardedEconomyBlob,
  shardSnapshotOf,
  maxShardParts,
  splitBlob,
  blobFNV1a,
  GC_PART_SCAN_FLOOR,
  PERSIST_MAX_BLOB,
  type EconBlobStore,
  type EconShardManifest,
} from "./state.js";
import { applyBreed, genomeHash, LINEAGE_SCHEMA_VERSION, type LineageEntry, type GenomeImprint } from "./breed.js";
import { loadConfig, type Env } from "./config.js";

// The storage keys are part of the locked KEY_VERSION contract ('economy:v1'), so asserting on the literals
// is asserting on the invariant itself.
const K_ECON = "economy:v1";
const K_MANIFEST = "economy:v1:manifest";
const K_PART = "economy:v1:part:";
const K_LEXICON = "lexicon:v1";

const partKey = (gen: number, i: number) => `${K_PART}${gen}:${i}`;

// ─── A stub DurableObjectStorage with injectable failures ────────────────────────────────────────────────

class StubStorage {
  readonly map = new Map<string, unknown>();
  /** Throw on the NEXT batch put (the atomic commit point). Single-key puts are unaffected. */
  failNextBatchPut = false;
  /** Throw while writing shard part index N of the next sharded persist (a mid-write crash). */
  failPartPutAt: number | null = null;
  /** Every key array that reached delete(), in order — the GC audit trail. */
  readonly deleted: string[][] = [];
  /** Every key array passed to a MULTI-key get(), in order — proves no unbounded allocation. */
  readonly multiGets: number[] = [];
  /** Every batch that reached put(), in order. */
  readonly batches: Record<string, unknown>[] = [];

  async get<T = unknown>(keyOrKeys: string | string[]): Promise<any> {
    if (Array.isArray(keyOrKeys)) {
      this.multiGets.push(keyOrKeys.length);
      const out = new Map<string, T>();
      for (const k of keyOrKeys) if (this.map.has(k)) out.set(k, this.map.get(k) as T);
      return out;
    }
    return this.map.get(keyOrKeys) as T | undefined;
  }

  async put(keyOrBatch: string | Record<string, unknown>, value?: unknown): Promise<void> {
    if (typeof keyOrBatch === "string") {
      // Shard-part writes carry an index in the key: "economy:v1:part:<gen>:<i>"
      if (this.failPartPutAt != null && keyOrBatch.startsWith(K_PART)) {
        const idx = Number(keyOrBatch.slice(keyOrBatch.lastIndexOf(":") + 1));
        if (idx === this.failPartPutAt) {
          this.failPartPutAt = null;
          throw new Error("injected shard-part write failure");
        }
      }
      this.map.set(keyOrBatch, value);
      return;
    }
    if (this.failNextBatchPut) {
      this.failNextBatchPut = false;
      throw new Error("injected DO commit failure");
    }
    this.batches.push(keyOrBatch);
    for (const [k, v] of Object.entries(keyOrBatch)) this.map.set(k, v);
  }

  async delete(keyOrKeys: string | string[]): Promise<number> {
    const keys = Array.isArray(keyOrKeys) ? keyOrKeys : [keyOrKeys];
    this.deleted.push(keys);
    let n = 0;
    for (const k of keys) if (this.map.delete(k)) n++;
    return n;
  }
}

/** A real FlyStateDO wired to the stub, with a tiny shard threshold so a test-sized blob takes the LARGE path. */
function makeDO(opts: { threshold?: number; chunkSize?: number } = {}) {
  const storage = new StubStorage();
  const env = { CHAIN_ID: "5042", RPC_URL: "https://rpc.test", FLY_STATE: {} as any } as unknown as Env;
  const dobj = new FlyStateDO({ storage } as any, env);
  const anyDo = dobj as any;
  anyDo.cfg.cron.persistShardThreshold = opts.threshold ?? 100;
  anyDo.cfg.cron.persistChunkSize = opts.chunkSize ?? 10;
  assert.equal(anyDo.cfg.cron.persistShardThreshold, opts.threshold ?? 100, "the cron knobs are mutable in-test");
  return { dobj, anyDo, storage, chunkSize: opts.chunkSize ?? 10 };
}

function setEconBlob(anyDo: any, blob: string) { anyDo.economy = { serialize: () => blob }; }
function setLexicon(anyDo: any, blob: string) { anyDo.lexicon = { serialize: () => blob }; }

const persist = (anyDo: any) => anyDo.persist(null, null) as Promise<void>;
const read = (storage: StubStorage, chunkSize: number) =>
  readShardedEconomyBlob(storage as unknown as EconBlobStore, chunkSize);
const manifestOf = (storage: StubStorage) => storage.map.get(K_MANIFEST) as EconShardManifest | undefined;
const gen = (anyDo: any): number | null => anyDo.econPersistGen as number | null;

/** A deterministic filler blob of exactly n chars (never parsed by these tests, only hashed + compared). */
const filler = (tag: string, n: number) => (tag + "|").repeat(Math.ceil(n / (tag.length + 1))).slice(0, n);

// ═══════════════════════════════════════════════════════════════════════ C1 — the commit point is atomic

test("C1: a failed batch commit does NOT advance econPersistGen (the live generation is never overwritten)", async () => {
  const { anyDo, storage } = makeDO();
  const blob1 = filler("A", 250);
  setEconBlob(anyDo, blob1);

  await persist(anyDo);                                    // commit #1 → gen 1 is live
  const liveGen = gen(anyDo);
  assert.equal(liveGen, 1, "the first sharded commit lands on gen 1");
  const livePart0 = storage.map.get(partKey(1, 0));
  assert.ok(livePart0 != null, "gen 1's parts exist after commit #1");

  // Commit #2 targets gen 0 and FAILS at the atomic put.
  setEconBlob(anyDo, filler("B", 300));
  storage.failNextBatchPut = true;
  await assert.rejects(() => persist(anyDo), /injected DO commit failure/);

  // ★ THE FIX: gen did not move. Under #98 it was already 0 here, so commit #3 would have targeted gen 1 —
  // the generation the LIVE manifest still points at — and torn the only readable copy.
  assert.equal(gen(anyDo), liveGen, "econPersistGen is unchanged by a failed commit");
  assert.equal(manifestOf(storage)?.gen, liveGen, "the stored manifest still names gen 1");
  assert.equal(storage.map.get(partKey(1, 0)), livePart0, "gen 1's parts were never written over");
});

test("C1: recovery — the persist after a failed commit re-uses the non-live generation and commits cleanly", async () => {
  const { anyDo, storage, chunkSize } = makeDO();
  setEconBlob(anyDo, filler("A", 250));
  await persist(anyDo);
  const blob1 = filler("A", 250);

  setEconBlob(anyDo, filler("B", 300));
  storage.failNextBatchPut = true;
  await assert.rejects(() => persist(anyDo));
  assert.equal(gen(anyDo), 1);

  // Commit #3: still currentGen=1 ⇒ newGen=0 again, fully overwriting the orphaned gen-0 parts.
  const blob3 = filler("C", 180);
  setEconBlob(anyDo, blob3);
  await persist(anyDo);
  assert.equal(gen(anyDo), 0, "the generation advances only on a successful commit");

  const r = await read(storage, chunkSize);
  assert.equal(r.tier, "manifest");
  assert.equal(r.gen, 0);
  assert.equal(r.blob, blob3, "commit #3 is the readable state — no data was lost by the failed commit #2");
});

test("C1: after a failed commit the previously committed blob is still readable at tier 1", async () => {
  const { anyDo, storage, chunkSize } = makeDO();
  const blob1 = filler("A", 250);
  setEconBlob(anyDo, blob1);
  await persist(anyDo);

  setEconBlob(anyDo, filler("B", 400));
  storage.failNextBatchPut = true;
  await assert.rejects(() => persist(anyDo));

  const r = await read(storage, chunkSize);
  assert.equal(r.tier, "manifest", "the live manifest still verifies");
  assert.equal(r.blob, blob1, "commit #1 survived the failed commit #2 byte-for-byte");
  assert.equal(await anyDo.readEconomyBlob(), blob1, "the DO's own read path agrees");
});

test("C1: a mid-shard-write crash leaves a torn generation that is never readable, and the live one intact", async () => {
  const { anyDo, storage, chunkSize } = makeDO();
  const blob1 = filler("A", 250);
  setEconBlob(anyDo, blob1);
  await persist(anyDo);

  setEconBlob(anyDo, filler("B", 300));
  storage.failPartPutAt = 1;                               // part 0 lands, part 1 throws
  await assert.rejects(() => persist(anyDo), /injected shard-part write failure/);
  assert.equal(gen(anyDo), 1, "a crash before the commit point moves nothing");
  assert.ok(storage.map.has(partKey(0, 0)), "gen 0's part 0 was written (the torn remnant)");
  assert.ok(!storage.map.has(partKey(0, 1)), "gen 0's part 1 never landed");

  const r = await read(storage, chunkSize);
  assert.equal(r.tier, "manifest");
  assert.equal(r.blob, blob1, "the torn gen-0 remnant is invisible; gen 1 still verifies");
});

// ═══════════════════════════════════════════════════════════════ H1 — a real double buffer + three tiers

test("H1: GC never deletes gen^1's parts — the double buffer survives every successful commit", async () => {
  const { anyDo, storage } = makeDO();
  setEconBlob(anyDo, filler("A", 250));
  await persist(anyDo);                                    // gen 1 live
  setEconBlob(anyDo, filler("B", 300));
  await persist(anyDo);                                    // gen 0 live, gen 1 becomes the buffer
  setEconBlob(anyDo, filler("C", 180));
  await persist(anyDo);                                    // gen 1 live, gen 0 becomes the buffer

  // The generation the LIVE manifest does not point at must still be fully present.
  const live = manifestOf(storage)!;
  const bufferGen = 1 - live.gen;
  const bufSnap = shardSnapshotOf(live.prev);
  assert.equal(bufSnap?.gen, bufferGen, "manifest.prev names the buffer generation");
  for (let i = 0; i < bufSnap!.partCount; i++) {
    assert.ok(storage.map.has(partKey(bufferGen, i)), `buffer part ${bufferGen}:${i} survived GC`);
  }
  // And #98's regression, spelled out: no delete batch ever contained a part of the buffer generation
  // within its live range [0, partCount).
  for (const batch of storage.deleted) {
    for (const k of batch) {
      if (!k.startsWith(`${K_PART}${bufferGen}:`)) continue;
      const idx = Number(k.slice(k.lastIndexOf(":") + 1));
      assert.ok(idx >= bufSnap!.partCount, `GC deleted buffer part index ${idx} < partCount ${bufSnap!.partCount}`);
    }
  }
});

test("H1: the legacy single key is retired ONE GENERATION late, not on the first sharded commit", async () => {
  const { anyDo, storage } = makeDO();
  storage.map.set(K_ECON, "PRE-98-LEGACY-BLOB");            // a pre-#98 DO upgrading to sharding

  setEconBlob(anyDo, filler("A", 250));
  await persist(anyDo);                                    // first sharded commit
  assert.equal(storage.map.get(K_ECON), "PRE-98-LEGACY-BLOB", "legacy is still there after commit #1");
  assert.equal(manifestOf(storage)?.prev, undefined, "commit #1 has no previous sharded generation");

  setEconBlob(anyDo, filler("B", 300));
  await persist(anyDo);                                    // second sharded commit
  assert.ok(!storage.map.has(K_ECON), "legacy is retired only once a sharded generation was already durable");
  assert.ok(manifestOf(storage)?.prev != null, "commit #2 records commit #1 as its double buffer");
});

test("H1: a corrupt live generation falls back to gen^1 (tier 2) and returns the PREVIOUS blob, not null", async () => {
  const { anyDo, storage, chunkSize } = makeDO();
  const blob1 = filler("A", 250);
  const blob2 = filler("B", 300);
  setEconBlob(anyDo, blob1);
  await persist(anyDo);                                    // gen 1 = blob1
  setEconBlob(anyDo, blob2);
  await persist(anyDo);                                    // gen 0 = blob2, prev = gen 1

  const live = manifestOf(storage)!;
  assert.equal(live.gen, 0);
  // Corrupt the live generation's first part (a bit flip the FNV check must catch).
  storage.map.set(partKey(live.gen, 0), "CORRUPTED" + String(storage.map.get(partKey(live.gen, 0))));

  const r = await read(storage, chunkSize);
  assert.equal(r.tier, "gen-xor", "tier 2 engaged");
  assert.equal(r.gen, 1);
  assert.equal(r.blob, blob1, "recovered the previous generation byte-for-byte — the economy is stale, not zeroed");
});

test("H1: a TORN live generation (a missing part) falls back to gen^1", async () => {
  const { anyDo, storage, chunkSize } = makeDO();
  const blob1 = filler("A", 250);
  setEconBlob(anyDo, blob1);
  await persist(anyDo);
  setEconBlob(anyDo, filler("B", 300));
  await persist(anyDo);

  const live = manifestOf(storage)!;
  storage.map.delete(partKey(live.gen, live.partCount - 1));   // the last shard never made it

  const r = await read(storage, chunkSize);
  assert.equal(r.tier, "gen-xor");
  assert.equal(r.blob, blob1, "the length check caught the truncation and tier 2 recovered gen^1");
});

test("H1: both generations corrupt → tier 3 recovers the legacy key", async () => {
  const { anyDo, storage, chunkSize } = makeDO();
  storage.map.set(K_ECON, "LEGACY-FALLBACK");
  setEconBlob(anyDo, filler("A", 250));
  await persist(anyDo);
  setEconBlob(anyDo, filler("B", 300));
  await persist(anyDo);

  // Commit #2 legitimately retired the legacy key (H1's one-generation delay had elapsed), so re-arm it to
  // isolate the tail of the cascade: with BOTH shard generations destroyed, tier 3 is the last resort.
  storage.map.set(K_ECON, "LEGACY-FALLBACK");
  const live = manifestOf(storage)!;
  storage.map.delete(partKey(live.gen, 0));
  storage.map.delete(partKey(1 - live.gen, 0));

  const r = await read(storage, chunkSize);
  assert.equal(r.tier, "legacy", "with both shard generations gone, the legacy key is the last resort");
  assert.equal(r.blob, "LEGACY-FALLBACK");
  assert.equal(r.gen, null);
});

test("H1: all three tiers gone → null (a fresh economy), and only then", async () => {
  const { storage, chunkSize } = makeDO();
  const r = await read(storage, chunkSize);
  assert.equal(r.tier, "none");
  assert.equal(r.blob, null);
  assert.equal(r.gen, null);
});

test("H1: a pre-#99 manifest with no `prev` still reads (tier 1) — the format change is additive", async () => {
  const { storage, chunkSize } = makeDO();
  const blob = filler("Z", 250);
  const parts = splitBlob(blob, chunkSize);
  parts.forEach((p, i) => storage.map.set(partKey(1, i), p));
  storage.map.set(K_MANIFEST, { gen: 1, partCount: parts.length, totalBytes: blob.length, fnv: blobFNV1a(blob) });

  const r = await read(storage, chunkSize);
  assert.equal(r.tier, "manifest");
  assert.equal(r.blob, blob, "an old manifest (no prev key) is read exactly as before");
});

// ═══════════════════════════════════════════════════════════════ M7 — bounded parts, dynamic GC index

test("M7: maxShardParts = ceil(PERSIST_MAX_BLOB / chunkSize); the 256 KB default gives 128", () => {
  assert.equal(maxShardParts(262_144), 128);
  assert.equal(maxShardParts(PERSIST_MAX_BLOB), 1);
  assert.equal(maxShardParts(1), PERSIST_MAX_BLOB);
  // A nonsense chunkSize can never produce 0 / NaN / Infinity.
  for (const bad of [0, -1, NaN, Infinity]) {
    const n = maxShardParts(bad);
    assert.ok(Number.isFinite(n) && n >= 1, `chunkSize=${bad} ⇒ ${n}`);
  }
});

test("M7: a corrupt partCount above MAX_PARTS is refused BEFORE any multi-key get (no unbounded allocation)", async () => {
  const { storage, chunkSize } = makeDO({ threshold: 100, chunkSize: 10 });
  const maxParts = maxShardParts(chunkSize);
  storage.map.set(K_MANIFEST, {
    gen: 1, partCount: maxParts + 1_000_000, totalBytes: 1, fnv: 0,
  } satisfies EconShardManifest);

  const r = await read(storage, chunkSize);
  assert.equal(r.tier, "none", "the corrupt manifest is ignored, nothing else exists");
  assert.equal(storage.multiGets.length, 0, "Array.from({length}) was NEVER reached");
});

test("M7: partCount exactly at MAX_PARTS is still attempted (the guard is >, not >=)", async () => {
  // A chunk of PERSIST_MAX_BLOB/4 makes MAX_PARTS exactly 4, so the boundary is exercisable without
  // allocating a multi-million-element key array.
  const chunkSize = Math.ceil(PERSIST_MAX_BLOB / 4);
  const { storage } = makeDO({ threshold: 100, chunkSize });
  const maxParts = maxShardParts(chunkSize);
  assert.equal(maxParts, 4);

  const blob = filler("Q", 40);
  const parts = splitBlob(blob, 10);                       // exactly 4 parts of 10 chars
  assert.equal(parts.length, maxParts);
  parts.forEach((p, i) => storage.map.set(partKey(1, i), p));
  storage.map.set(K_MANIFEST, { gen: 1, partCount: parts.length, totalBytes: blob.length, fnv: blobFNV1a(blob) });

  const r = await read(storage, chunkSize);
  assert.equal(r.tier, "manifest", "a legal partCount at the ceiling is read, not refused");
  assert.equal(r.blob, blob);
  assert.deepEqual(storage.multiGets, [maxParts], "exactly one key array, of exactly MAX_PARTS keys");
});

test("M7: the GC index bound is DYNAMIC — a >64-part history is swept past the old hardcoded ceiling", async () => {
  // chunkSize 10, threshold 100: a 700-char blob is 70 parts, so the sweep bound must exceed #98's bare 64.
  const { anyDo, storage } = makeDO({ threshold: 100, chunkSize: 10 });
  setEconBlob(anyDo, filler("A", 700));
  await persist(anyDo);                                    // gen 1, 70 parts
  assert.equal(manifestOf(storage)!.partCount, 70);

  setEconBlob(anyDo, filler("B", 200));
  await persist(anyDo);                                    // gen 0, 20 parts, prev = {gen:1, partCount:70}
  assert.equal(manifestOf(storage)!.prev?.partCount, 70);

  setEconBlob(anyDo, filler("C", 150));
  await persist(anyDo);                                    // gen 1 again, 15 parts ⇒ sweep gen1 [15, 70)
  assert.equal(manifestOf(storage)!.gen, 1);
  assert.equal(manifestOf(storage)!.partCount, 15, "the blob shrank, so 55 of gen 1's old indices are orphans");

  const swept: number[] = [];
  for (const batch of storage.deleted) {
    for (const k of batch) {
      if (k.startsWith(`${K_PART}1:`)) swept.push(Number(k.slice(k.lastIndexOf(":") + 1)));
    }
  }
  assert.ok(swept.includes(69), `index 69 was swept (the dynamic bound reached past 64): max=${Math.max(...swept)}`);
  assert.ok(swept.includes(GC_PART_SCAN_FLOOR), "index 64 was swept too");
  assert.ok(!swept.includes(70), "the sweep stops at the recorded partCount, never beyond");
  for (let i = 15; i < 70; i++) assert.ok(!storage.map.has(partKey(1, i)), `orphan gen1:${i} is gone`);
  for (let i = 0; i < 15; i++) assert.ok(storage.map.has(partKey(1, i)), `live gen1:${i} is kept`);
});

test("M7: shardSnapshotOf rejects every corrupt manifest shape", () => {
  const ok = { gen: 0, partCount: 4, totalBytes: 100, fnv: 7 };
  assert.deepEqual(shardSnapshotOf(ok), ok);
  assert.equal(shardSnapshotOf(undefined), undefined);
  assert.equal(shardSnapshotOf(null), undefined);
  assert.equal(shardSnapshotOf({ ...ok, partCount: 0 }), undefined, "partCount 0 ⇒ the small-blob sentinel");
  assert.equal(shardSnapshotOf({ ...ok, partCount: -1 }), undefined);
  assert.equal(shardSnapshotOf({ ...ok, gen: 1.5 }), undefined, "a non-integer gen is corrupt");
  assert.equal(shardSnapshotOf({ ...ok, gen: "1" as any }), undefined);
  assert.equal(shardSnapshotOf({ ...ok, totalBytes: -5 }), undefined);
  assert.equal(shardSnapshotOf({ ...ok, fnv: "x" as any }), undefined);
  // A snapshot is a COPY, so a caller mutating the stored manifest cannot retro-change a plan.
  const s = shardSnapshotOf(ok)!;
  assert.notEqual(s, ok);
});

// ══════════════════════════════════════════════════ LEXICON — the membrane of coined words is never lost

test("lexicon: KEY_LEXICON rides in the SAME atomic batch as the economy manifest", async () => {
  const { anyDo, storage } = makeDO();
  setEconBlob(anyDo, filler("A", 250));
  setLexicon(anyDo, "LEXICON-COINAGE-DESK");

  await persist(anyDo);
  const batch = storage.batches[storage.batches.length - 1];
  assert.ok(K_LEXICON in batch, "the lexicon is in the commit batch");
  assert.ok(K_MANIFEST in batch, "so is the economy commit point");
  assert.equal(storage.map.get(K_LEXICON), "LEXICON-COINAGE-DESK");
});

test("lexicon: a failed economy commit never loses or corrupts the lexicon", async () => {
  const { anyDo, storage } = makeDO();
  setEconBlob(anyDo, filler("A", 250));
  setLexicon(anyDo, "LEXICON-V1");
  await persist(anyDo);

  setEconBlob(anyDo, filler("B", 300));
  setLexicon(anyDo, "LEXICON-V2");
  storage.failNextBatchPut = true;
  await assert.rejects(() => persist(anyDo));

  // Atomicity: the batch is all-or-nothing, so the lexicon stays at the last committed value — never half-updated.
  assert.equal(storage.map.get(K_LEXICON), "LEXICON-V1", "the lexicon rolled back with the rest of the batch");

  setLexicon(anyDo, "LEXICON-V2");
  await persist(anyDo);
  assert.equal(storage.map.get(K_LEXICON), "LEXICON-V2", "and it commits on the retry");
});

test("lexicon: a torn shard generation + full fallback cascade still leaves the lexicon untouched", async () => {
  const { anyDo, storage, chunkSize } = makeDO();
  storage.map.set(K_ECON, "LEGACY");
  setLexicon(anyDo, "LEXICON-PERMANENT");
  setEconBlob(anyDo, filler("A", 250));
  await persist(anyDo);
  setEconBlob(anyDo, filler("B", 300));
  await persist(anyDo);                                    // legacy now retired by GC

  const live = manifestOf(storage)!;
  storage.map.delete(partKey(live.gen, 0));
  storage.map.delete(partKey(1 - live.gen, 0));            // both shard generations destroyed

  const r = await read(storage, chunkSize);
  assert.equal(r.tier, "none", "the economy has genuinely lost both generations");
  assert.equal(storage.map.get(K_LEXICON), "LEXICON-PERMANENT", "the lexicon is on its OWN key: it is unharmed");
});

test("lexicon: no GC delete set EVER contains lexicon:v1 (large-blob, small-blob and legacy-retire paths)", async () => {
  const { anyDo, storage } = makeDO();
  setLexicon(anyDo, "LEXICON-PERMANENT");

  setEconBlob(anyDo, filler("A", 250));
  await persist(anyDo);                                    // large #1 (legacy kept)
  setEconBlob(anyDo, filler("B", 300));
  await persist(anyDo);                                    // large #2 (legacy retired)
  setEconBlob(anyDo, filler("C", 400));
  await persist(anyDo);                                    // large #3
  setEconBlob(anyDo, "tiny");
  await persist(anyDo);                                    // back under the threshold ⇒ sweeps both generations

  assert.ok(storage.deleted.length > 0, "GC actually ran");
  for (const batch of storage.deleted) {
    assert.ok(!batch.includes(K_LEXICON), `a GC batch contained ${K_LEXICON}: ${batch.join(",")}`);
    assert.ok(
      batch.every((k) => k === K_ECON || k.startsWith(K_PART)),
      `GC touched a non-economy key: ${batch.filter((k) => k !== K_ECON && !k.startsWith(K_PART)).join(",")}`,
    );
  }
  assert.equal(storage.map.get(K_LEXICON), "LEXICON-PERMANENT", "the lexicon survived every GC path");
});

// ══════════════════════════════════════════════════════ M8 — a Lamarck breed is re-derivable, not just verifiable

function flywireGenome(over: Partial<Genome> = {}): Genome {
  return {
    v: 1, seed: 4242, nSensory: 24, nInterL1: 40, nInterL2: 40,
    nModulatory: 12, nMotorPerChannel: 10, density: 0.5,
    weightGain: 0.22, threshGain: 1.0, tauGain: 1.0, weightJitter: 0.30,
    ...over,
  } as Genome;
}

test("M8: an imprinted breed records imprint{vector,rngSeed} and its genomeHash is RE-DERIVABLE from the entry", async () => {
  const parent = flywireGenome();
  const parentHash = await genomeHash(parent);
  const entries: LineageEntry[] = [{
    genomeHash: parentHash, genome: parent, parents: [], op: "genesis",
    generation: 0, breeder: null, rngSeed: null, ts: 0, commitTx: null,
  }];
  const vec: GenomeImprint = { weightGain: 0.6, threshGain: -0.3, tauGain: 0.9, weightJitter: -0.7 };
  const S = 24680;

  const child = await applyBreed(
    entries,
    { op: "mutate", parents: [parentHash], rngSeed: S, breeder: "0xabc" },
    { flywireTopology: true, tickIndex: 3, imprint: { vector: vec, rngSeed: S } },
  );

  assert.ok(child.imprint, "the imprint inputs are recorded");
  assert.deepEqual(child.imprint!.vector, vec, "the vector is recorded verbatim");
  assert.equal(child.imprint!.rngSeed, S >>> 0);

  // ★ THE FIX: a third party holding ONLY the lineage entry can re-run the breed and land on the same hash.
  // Under #98 they had (op, parents, rngSeed) but not the vector, and lamarckVector is mutable ledger state,
  // so the re-run produced a different genomeHash and breed.ts's reproducibility claim was false.
  const rederived = await applyBreed(
    entries,
    { op: child.op as "mutate", parents: child.parents, rngSeed: child.rngSeed! },
    { flywireTopology: true, tickIndex: 3, imprint: child.imprint },
  );
  assert.equal(rederived.genomeHash, child.genomeHash, "the recorded fields fully determine the offspring");
  assert.deepEqual(rederived.genome, child.genome);
});

test("M8: no imprint ⇒ the key is ABSENT (byte-identical to pre-M8) and LINEAGE_SCHEMA_VERSION stays 1", async () => {
  const parent = flywireGenome({ seed: 999 });
  const parentHash = await genomeHash(parent);
  const entries: LineageEntry[] = [{
    genomeHash: parentHash, genome: parent, parents: [], op: "genesis",
    generation: 0, breeder: null, rngSeed: null, ts: 0, commitTx: null,
  }];

  const plain = await applyBreed(entries, { op: "mutate", parents: [parentHash], rngSeed: 7 }, { flywireTopology: true });
  assert.ok(!("imprint" in plain), "an unimprinted entry carries no imprint key at all");
  assert.equal(JSON.stringify(plain).includes("imprint"), false, "and it is absent from the serialized form");

  // LAMARCK off ⇒ state.ts passes no imprint even in FlyWire mode; PRNG mode ignores it. Both stay keyless.
  const prng = await applyBreed(entries, { op: "mutate", parents: [parentHash], rngSeed: 8 }, {
    flywireTopology: false,
    imprint: { vector: { weightGain: 1, threshGain: 1, tauGain: 1, weightJitter: 1 }, rngSeed: 8 },
  });
  assert.ok(!("imprint" in prng), "a non-FlyWire breed records no imprint (it shaped nothing)");

  assert.equal(LINEAGE_SCHEMA_VERSION, 1, "an optional field is backward-compatible ⇒ the version does not move");
});

test("M8: the recorded vector's SHAPE is locked to the 4 heritable fields (extra input keys are dropped)", async () => {
  const parent = flywireGenome({ seed: 31337 });
  const parentHash = await genomeHash(parent);
  const entries: LineageEntry[] = [{
    genomeHash: parentHash, genome: parent, parents: [], op: "genesis",
    generation: 0, breeder: null, rngSeed: null, ts: 0, commitTx: null,
  }];
  const dirty = { weightGain: 0.5, threshGain: 0.5, tauGain: 0.5, weightJitter: 0.5, divBias: -1 } as unknown as GenomeImprint;

  const child = await applyBreed(entries, { op: "mutate", parents: [parentHash], rngSeed: 11 }, {
    flywireTopology: true, tickIndex: 1, imprint: { vector: dirty, rngSeed: 11 },
  });
  assert.deepEqual(Object.keys(child.imprint!.vector).sort(), ["tauGain", "threshGain", "weightGain", "weightJitter"],
    "exactly IMPRINT_FIELDS — a future economy-side field can never silently enter the lineage record");
  assert.deepEqual(Object.keys(child.imprint!).sort(), ["rngSeed", "vector"]);
});

// ═══════════════════════════════════════════════════════ M9 — code-defaults equal the live wrangler [vars]

test("M9: the code-defaults are the production values 0.01 / 360 when no env var is set", () => {
  const cfg = loadConfig({ CHAIN_ID: "5042", RPC_URL: "https://rpc.test", FLY_STATE: {} as any } as unknown as Env);
  assert.equal(cfg.economy.netMinBroadcastUsdc, 0.01, "was 0.004 — drifted from wrangler.toml L128");
  assert.equal(cfg.economy.netFlushTicks, 360, "was 30 — drifted from wrangler.toml L129");
  // #98's knobs are untouched by M9.
  assert.equal(cfg.economy.netFlushBudgetPerCron, 40);
  assert.equal(cfg.cron.persistChunkSize, 262_144);
});

test("M9: an explicit env var still overrides the code-default (the knob is not hardcoded)", () => {
  const cfg = loadConfig({
    CHAIN_ID: "5042", RPC_URL: "https://rpc.test", FLY_STATE: {} as any,
    ECONOMY_NET_MIN_BROADCAST: "0.004", ECONOMY_NET_FLUSH_TICKS: "30",
  } as unknown as Env);
  assert.equal(cfg.economy.netMinBroadcastUsdc, 0.004);
  assert.equal(cfg.economy.netFlushTicks, 30);
});

test("M9: drift guard — the code-defaults EQUAL wrangler.toml's live [vars], so they can never diverge again", () => {
  const toml = readFileSync(new URL("../wrangler.toml", import.meta.url), "utf8");
  const grab = (name: string): string | null => {
    const m = toml.match(new RegExp(`^\\s*${name}\\s*=\\s*"([^"]*)"`, "m"));
    return m ? m[1] : null;
  };
  const minBc = grab("ECONOMY_NET_MIN_BROADCAST");
  const flushTicks = grab("ECONOMY_NET_FLUSH_TICKS");
  assert.ok(minBc != null && flushTicks != null, "both [vars] keys are present and uncommented");

  const cfg = loadConfig({ CHAIN_ID: "5042", RPC_URL: "https://rpc.test", FLY_STATE: {} as any } as unknown as Env);
  assert.equal(cfg.economy.netMinBroadcastUsdc, Number(minBc), `code-default vs wrangler ${minBc}`);
  assert.equal(cfg.economy.netFlushTicks, Number(flushTicks), `code-default vs wrangler ${flushTicks}`);
});

// ═══════════════════════════════════════════════════════ N1 (#113) — GC sweepTo upper-bounded by maxShardParts

test("N1: a corrupt prev.partCount of 1e9 is clamped by maxShardParts — GC never constructs an unbounded array", async () => {
  // chunkSize 10 ⇒ maxShardParts(10) = ceil(32 MB / 10) = 3_355_444. A prev.partCount of 1e9 exceeds that.
  const { anyDo, storage, chunkSize } = makeDO({ threshold: 100, chunkSize: 10 });
  const maxParts = maxShardParts(chunkSize);

  // Seed a first successful persist so econPersistGen is set.
  setEconBlob(anyDo, filler("A", 250));
  await persist(anyDo);
  assert.equal(gen(anyDo), 1, "first persist commits gen 1");

  // Corrupt the stored manifest's prev to an absurdly large partCount (simulating bit-rot or a hostile write).
  const m = manifestOf(storage)!;
  storage.map.set(K_MANIFEST, { ...m, prev: { gen: 0, partCount: 1_000_000_000, totalBytes: 1, fnv: 0 } });

  // Clear the delete audit trail so we only observe the NEXT persist's GC.
  storage.deleted.length = 0;

  // Run persist again — the large-blob path reads oldPrev.partCount = 1e9 for sameGenBefore when gen matches.
  // The gen alternates: econPersistGen is 1, so newGen = 0. prev.gen is 0, so sameGenBefore = 1e9.
  setEconBlob(anyDo, filler("B", 200));
  await persist(anyDo);

  // The GC delete set must be bounded by maxParts, NOT by the corrupt 1e9.
  let totalGcKeys = 0;
  for (const batch of storage.deleted) totalGcKeys += batch.length;
  assert.ok(
    totalGcKeys <= maxParts * 2,
    `GC deleted ${totalGcKeys} keys — must be ≤ 2×maxParts (${maxParts * 2}); the corrupt 1e9 was clamped`,
  );
});

test("N1: small-blob path — a corrupt oldSnap.partCount of 1e9 is clamped by maxShardParts", async () => {
  // Use a threshold that keeps the blob SMALL (below shard threshold) while a corrupt manifest exists.
  const { anyDo, storage, chunkSize } = makeDO({ threshold: 10_000, chunkSize: 10 });
  const maxParts = maxShardParts(chunkSize);

  // Simulate: a previous sharded generation existed, now the blob fell below threshold.
  // Plant a corrupt manifest with partCount = 1e9 (as if the last shard write recorded garbage).
  storage.map.set(K_MANIFEST, { gen: 1, partCount: 1_000_000_000, totalBytes: 9999, fnv: 42 });
  anyDo.econPersistGen = 1;   // memory thinks shards are live

  storage.deleted.length = 0;

  // Persist a SMALL blob (below threshold 10000) — takes the small-blob path.
  setEconBlob(anyDo, filler("S", 50));
  await persist(anyDo);

  // The GC sweep for the small-blob path generates keys for gen 0 and gen 1.
  // Each sweep is bounded by maxParts, so total keys ≤ 2 × maxParts.
  let totalGcKeys = 0;
  for (const batch of storage.deleted) totalGcKeys += batch.length;
  assert.ok(
    totalGcKeys <= maxParts * 2,
    `GC deleted ${totalGcKeys} keys — must be ≤ 2×maxParts (${maxParts * 2}); the corrupt 1e9 was clamped`,
  );
});
