/**
 * FlyWire subgraph loader — Workers-compatible (no Node APIs).
 *
 * Loads the FAFB 783 artifact from the KV binding (FLYWIRE_ARTIFACT) and decodes it into typed
 * arrays using the DecompressionStream-based pipeline from @fly/fly-brain. The decoded subgraph
 * is cached module-level so each isolate decodes the 1.32 MB artifact exactly once.
 *
 * DARK DEPLOY: this module is only reached when FLYWIRE_TOPOLOGY=true. When the flag is OFF,
 * loadSubgraph() is never called and the KV binding may be absent.
 *
 * MEMORY: decode peak ~24.7 MB, retained ~2.6 MB (well within the 128 MB isolate budget).
 */

import { decodeFlyWireArtifact, decodePayload, type FlyWireSubgraph } from "@fly/fly-brain";

/** Module-level cache — one decode per isolate lifetime. */
let _cached: FlyWireSubgraph | null = null;

// ---------------------------------------------------------------------------
// Fix 1 (Task 64) — DO-storage subgraph cache: kill the cold-start KV stampede.
//
// WHY: on a deploy, all ~100 FlyShardDO isolates cold-boot AT ONCE and each independently
// KV-fetches the SAME 1.32 MB artifact, base64-decodes it and gunzips it into the 2.26 MB
// decoded subgraph. 100 concurrent cold KV reads of one key throttle badly (measured ~24 s/shard
// ⇒ the whole swarm froze ~40 min and blew the 55 s cron budget). The decoded subgraph is IDENTICAL
// for every shard (the FAFB 783 topology is FIXED), so we persist it ONCE per shard into that
// shard's OWN Durable Object storage (local SQLite, no cross-isolate contention) and reload it
// there on every subsequent cold boot — skipping the KV round-trip + atob + DecompressionStream
// gunzip entirely. buildFromFlyWire still runs per fly (only ~116 ms) so genome-parameterised
// weights, and therefore the on-chain manifestHash, are byte-for-byte unchanged.
//
// SIZE: the canonical payload is 9 + nNeurons*3 + nEdges*5 = 2,367,662 B (~2.26 MB) for the
// 10,361 n / 467,314 s subgraph — OVER the Durable Object 2 MB single-value wall, so it is split
// into <=1.5 MB chunks (2 here), each its own key. Lossless: decodePayload(encode(sg)) === sg.
//
// INVALIDATION: the topology never changes at runtime; the cache is keyed by a code constant
// SUBGRAPH_CACHE_VERSION, bumped only if the artifact is ever swapped (then old keys are ignored).
// ---------------------------------------------------------------------------

/** Bump this if the FAFB artifact is ever replaced, to orphan stale cached chunks. */
const SUBGRAPH_CACHE_VERSION = 1;
const CACHE_META_KEY = `flywireSubgraph:v${SUBGRAPH_CACHE_VERSION}:meta`;
const CACHE_CHUNK_PREFIX = `flywireSubgraph:v${SUBGRAPH_CACHE_VERSION}:c`;
/** Chunk size kept comfortably under the 2 MB DO single-value ceiling (key+value). */
const CACHE_CHUNK_BYTES = 1_500_000;

/**
 * Re-encode a decoded subgraph into the canonical binary layout documented in decoder.ts so it can
 * be rebuilt by decodePayload() byte-for-byte. Uint16 fields are copied as RAW BYTES (never value-
 * widened into a Uint8Array) to preserve little-endian order.
 */
function encodeSubgraphPayload(sg: FlyWireSubgraph): Uint8Array {
  const { nNeurons, nEdges, version, layers, signs, ntCodes, preIndices, postIndices, weightsQuantized } = sg;
  const total = 9 + nNeurons * 3 + nEdges * 5;
  const buf = new Uint8Array(total);
  const view = new DataView(buf.buffer);
  view.setUint32(0, nNeurons, true);
  view.setUint32(4, nEdges, true);
  view.setUint8(8, version);
  const bytesOf = (a: { buffer: ArrayBufferLike; byteOffset: number; byteLength: number }) =>
    new Uint8Array(a.buffer, a.byteOffset, a.byteLength);
  let off = 9;
  buf.set(bytesOf(layers), off); off += nNeurons;                 // uint8[nNeurons]
  buf.set(bytesOf(signs), off); off += nNeurons;                  // int8[nNeurons]
  buf.set(bytesOf(ntCodes), off); off += nNeurons;                // uint8[nNeurons]
  buf.set(bytesOf(preIndices), off); off += nEdges * 2;           // uint16[nEdges] LE
  buf.set(bytesOf(postIndices), off); off += nEdges * 2;          // uint16[nEdges] LE
  buf.set(bytesOf(weightsQuantized), off);                        // uint8[nEdges]
  return buf;
}

/** Read + reassemble the chunked subgraph from DO storage; null on any miss/short-read (⇒ KV fallback). */
async function readSubgraphCache(storage: DurableObjectStorage): Promise<FlyWireSubgraph | null> {
  const meta = await storage.get<{ chunks: number; bytes: number }>(CACHE_META_KEY);
  if (!meta || !Number.isInteger(meta.chunks) || meta.chunks < 1 || !Number.isInteger(meta.bytes) || meta.bytes < 9) {
    return null;
  }
  const keys: string[] = [];
  for (let i = 0; i < meta.chunks; i++) keys.push(`${CACHE_CHUNK_PREFIX}${i}`);
  const parts = await Promise.all(keys.map((k) => storage.get<ArrayBuffer>(k)));
  const buf = new Uint8Array(meta.bytes);
  let off = 0;
  for (const p of parts) {
    if (!p) return null;                                  // a missing chunk invalidates the whole cache
    const bytes = new Uint8Array(p);
    if (off + bytes.byteLength > meta.bytes) return null;  // torn/oversized chunk
    buf.set(bytes, off);
    off += bytes.byteLength;
  }
  if (off !== meta.bytes) return null;                    // short read
  return decodePayload(buf);
}

/** Split + persist the canonical payload into DO storage as <=1.5 MB chunks in ONE transaction. */
async function writeSubgraphCache(storage: DurableObjectStorage, raw: Uint8Array): Promise<void> {
  const chunks = Math.max(1, Math.ceil(raw.byteLength / CACHE_CHUNK_BYTES));
  const writes: Record<string, unknown> = {};
  for (let i = 0; i < chunks; i++) {
    // slice() copies into a fresh, exactly-sized buffer so each stored value is <= CACHE_CHUNK_BYTES.
    writes[`${CACHE_CHUNK_PREFIX}${i}`] = raw.slice(i * CACHE_CHUNK_BYTES, (i + 1) * CACHE_CHUNK_BYTES).buffer;
  }
  writes[CACHE_META_KEY] = { chunks, bytes: raw.byteLength };
  await storage.put(writes);
}

/**
 * Fix 1 entry point — load the FlyWire subgraph, preferring this DO's own storage cache over KV.
 *
 * Order: (1) module cache; (2) DO-storage chunk cache (no KV, no gunzip); (3) KV cold path, which
 * then WRITES the DO cache so the next cold boot of THIS shard is fast. `storage` is the calling
 * DO's own storage (a FlyShardDO's or the coordinator's); when absent it degrades to the plain KV
 * loader. Best-effort caching: any cache read/write failure falls back to KV and never throws here.
 *
 * @param storage - The calling Durable Object's storage (its private subgraph cache), or undefined.
 * @param kv      - The FLYWIRE_ARTIFACT KV namespace binding (from Env), used on a cache miss.
 */
export async function loadSubgraphCached(
  storage: DurableObjectStorage | undefined,
  kv: KVNamespace | undefined,
): Promise<FlyWireSubgraph> {
  if (_cached) return _cached;
  if (storage) {
    try {
      const hit = await readSubgraphCache(storage);
      if (hit) { _cached = hit; return hit; }
    } catch (e) {
      console.warn("[flywire] subgraph cache read failed (falling back to KV):", (e as Error).message);
    }
  }
  const sg = await loadSubgraph(kv);   // KV cold path (also sets the module cache)
  if (storage) {
    try {
      await writeSubgraphCache(storage, encodeSubgraphPayload(sg));
    } catch (e) {
      console.warn("[flywire] subgraph cache write failed (non-fatal, next boot retries):", (e as Error).message);
    }
  }
  return sg;
}

/**
 * Load + decode the FlyWire subgraph from KV. Async; cached after first call.
 *
 * @param kv - The FLYWIRE_ARTIFACT KV namespace binding (from Env).
 * @throws If the KV binding is absent or the artifact key is missing.
 */
export async function loadSubgraph(kv: KVNamespace | undefined): Promise<FlyWireSubgraph> {
  if (_cached) return _cached;
  if (!kv) {
    throw new Error(
      "FLYWIRE_TOPOLOGY is enabled but FLYWIRE_ARTIFACT KV binding is not configured. " +
      "Add the KV namespace binding to wrangler.toml before enabling the flag."
    );
  }
  const b64 = await kv.get("fafb783-mb-cx.bin.gz.b64");
  if (!b64) {
    throw new Error(
      "FlyWire artifact 'fafb783-mb-cx.bin.gz.b64' not found in KV namespace. " +
      "Upload it with: wrangler kv key put fafb783-mb-cx.bin.gz.b64 --namespace-id=<id> --remote --path=packages/fly-brain/src/connectome-data/fafb783-mb-cx.bin.gz.b64"
    );
  }
  _cached = await decodeFlyWireArtifact(b64.trim());
  return _cached;
}

/** Reset the module-level cache (for testing / memory measurement). */
export function resetSubgraphCache(): void {
  _cached = null;
}

/** Whether the subgraph is already cached (for diagnostics). */
export function isSubgraphCached(): boolean {
  return _cached !== null;
}
