/**
 * Binary payload decoder for the FlyWire/FAFB subgraph artifact.
 *
 * Decodes the gzip-compressed base64 payload into typed arrays.
 * Uses the DecompressionStream API (available in Cloudflare Workers, Node 18+, browsers).
 * For synchronous contexts (tests, CLI), provides a sync fallback using raw base64 decode
 * when the payload is pre-decompressed.
 *
 * Binary layout (all little-endian):
 *   uint32  n_neurons
 *   uint32  n_edges
 *   uint8   version
 *   uint8[n_neurons]   layer_codes
 *   int8[n_neurons]    signs
 *   uint8[n_neurons]   nt_codes
 *   uint16[n_edges]    pre_indices
 *   uint16[n_edges]    post_indices
 *   uint8[n_edges]     weights_quantized
 */

import type { FlyWireSubgraph } from "./types.js";

/** Header size: 4 + 4 + 1 = 9 bytes */
const HEADER_SIZE = 9;

/**
 * Decode a raw (already decompressed) binary payload into a FlyWireSubgraph.
 * This is the core decoder — synchronous, pure, no I/O.
 */
export function decodePayload(raw: Uint8Array): FlyWireSubgraph {
  if (raw.length < HEADER_SIZE) {
    throw new Error(`Payload too small: ${raw.length} bytes (need >= ${HEADER_SIZE})`);
  }

  const view = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);

  const nNeurons = view.getUint32(0, true);  // little-endian
  const nEdges = view.getUint32(4, true);
  const version = view.getUint8(8);

  const expectedSize =
    HEADER_SIZE +
    nNeurons * 3 +   // layers(1) + signs(1) + ntCodes(1)
    nEdges * 5;      // pre(2) + post(2) + weight(1)

  if (raw.length < expectedSize) {
    throw new Error(
      `Payload size mismatch: got ${raw.length}, expected ${expectedSize} ` +
      `(nNeurons=${nNeurons}, nEdges=${nEdges})`
    );
  }

  let offset = HEADER_SIZE;

  const layers = new Uint8Array(raw.buffer, raw.byteOffset + offset, nNeurons);
  offset += nNeurons;

  const signs = new Int8Array(raw.buffer, raw.byteOffset + offset, nNeurons);
  offset += nNeurons;

  const ntCodes = new Uint8Array(raw.buffer, raw.byteOffset + offset, nNeurons);
  offset += nNeurons;

  const preIndices = new Uint16Array(raw.buffer, raw.byteOffset + offset, nEdges);
  offset += nEdges * 2;

  const postIndices = new Uint16Array(raw.buffer, raw.byteOffset + offset, nEdges);
  offset += nEdges * 2;

  const weightsQuantized = new Uint8Array(raw.buffer, raw.byteOffset + offset, nEdges);

  return {
    nNeurons,
    nEdges,
    version,
    layers,
    signs,
    ntCodes,
    preIndices,
    postIndices,
    weightsQuantized,
  };
}

/**
 * Decode a base64 string (of gzip-compressed payload) into raw bytes.
 * Uses DecompressionStream (async) — works in Workers, Node 18+, browsers.
 */
export async function decompressBase64Gzip(b64: string): Promise<Uint8Array> {
  // Base64 → Uint8Array
  const binaryStr = atob(b64);
  const compressed = new Uint8Array(binaryStr.length);
  for (let i = 0; i < binaryStr.length; i++) {
    compressed[i] = binaryStr.charCodeAt(i);
  }

  // Gzip decompress via DecompressionStream
  const ds = new DecompressionStream("gzip");
  const writer = ds.writable.getWriter();
  const reader = ds.readable.getReader();

  writer.write(compressed);
  writer.close();

  const chunks: Uint8Array[] = [];
  let totalLen = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    totalLen += value.length;
  }

  // Concatenate
  const result = new Uint8Array(totalLen);
  let pos = 0;
  for (const chunk of chunks) {
    result.set(chunk, pos);
    pos += chunk.length;
  }
  return result;
}

/**
 * Full async pipeline: base64 gzip string → FlyWireSubgraph.
 */
export async function decodeFlyWireArtifact(b64Gzip: string): Promise<FlyWireSubgraph> {
  const raw = await decompressBase64Gzip(b64Gzip);
  return decodePayload(raw);
}

/**
 * Synchronous decode from a pre-decompressed base64 string (no gzip).
 * Useful for tests where the payload is already decompressed.
 */
export function decodeBase64Raw(b64: string): FlyWireSubgraph {
  const binaryStr = atob(b64);
  const raw = new Uint8Array(binaryStr.length);
  for (let i = 0; i < binaryStr.length; i++) {
    raw[i] = binaryStr.charCodeAt(i);
  }
  return decodePayload(raw);
}
