// IPFS pinning for neural receipts — the availability layer that closes murmur's trustless-provenance loop.
//
// WHY THIS EXISTS. Every real net transfer already commits, as its EIP-3009 nonce, to
// sha256(canonical(receipt)) — the neural receipt is bound on-chain and cannot be forged (see provenance.ts),
// and the NeuralReceiptRegistry mirrors the hash-chain head so the ordering is reconstructible from Arc RPC
// alone. But the receipt BODY itself was only ever served from the worker's own /proofs endpoint: to actually
// read the frozen neural drives behind a transfer you still had to trust that murmur is online AND serving you
// the honest bytes. Pinning each body to IPFS removes that last availability/trust assumption — anyone can
// fetch the exact receipt from a content-addressed network with no murmur server in the loop.
//
// THE TRUST ROOT STAYS THE HASH, NOT THE CID. IPFS is content-addressed: whatever body a CID resolves to, the
// verifier recomputes sha256(body) and compares it to the receiptHash already mined on Arc. A wrong, stale, or
// malicious CID can therefore only ever FAIL that match — it can never substitute a different receipt, because
// doing so would require a sha256 collision with an on-chain commitment. So the CID we publish is a convenience
// pointer; the guarantee is the hash. (Pinata wraps every upload in dag-pb/unixfs, so the returned CID is NOT
// itself the receiptHash — we record the CID Pinata reports and rely on the codec-agnostic body-hash match.)
//
// EVERYTHING HERE IS BEST-EFFORT. No JWT configured ⇒ the caller omits the pinner ⇒ flush skips pinning
// entirely (byte-for-byte today's behaviour). A pin failure ⇒ null ⇒ the receipt stays nonce- and registry-
// verifiable exactly as before. Pinning never blocks, delays, or invalidates a settlement that already mined.

/**
 * Pins a receipt body and returns its IPFS CID (or null). Injected into the economy as an optional dep;
 * absent ⇒ no pinning at all, so the default deployment is unchanged.
 */
export interface ReceiptPinner {
  /**
   * Pin the canonical receipt JSON — the EXACT bytes whose sha256 is the on-chain receiptHash.
   * @param canonicalBody  canonical(receipt): sha256 of these UTF-8 bytes == receiptHash (see provenance.ts)
   * @param receiptHash    64-hex sha256, used only to label the pin (filename/metadata) for later lookup
   * @returns the IPFS CID, or null on any failure. Implementations MUST NOT throw (best-effort by contract).
   */
  pin(canonicalBody: string, receiptHash: string): Promise<string | null>;
}

/** Pinata's file-pinning endpoint: multipart POST, `Authorization: Bearer <JWT>`. */
export const PINATA_ENDPOINT = "https://api.pinata.cloud/pinning/pinFileToIPFS";

/** Default public gateway the frontend uses to fetch a pinned body (CORS-enabled, content-addressed). */
export const DEFAULT_IPFS_GATEWAY = "https://ipfs.io";

export interface PinataPinnerConfig {
  /** Pinata API JWT (sent as Bearer). An empty JWT means "don't pin" — the caller should omit the pinner. */
  jwt: string;
  /** Override the pinning endpoint (default Pinata production). */
  endpoint?: string;
  /** Injectable fetch (tests + proxied environments); defaults to the global fetch. */
  fetchImpl?: typeof fetch;
  /** Milliseconds to wait for Pinata before giving up (best-effort; default 15000). */
  timeoutMs?: number;
}

/**
 * Pinata-backed pinner. Uploads the receipt body as a single JSON file with cidVersion:1 and returns the CID
 * Pinata reports. NEVER throws: any non-OK response, timeout, or network error degrades to null, so a pinning
 * hiccup can't abort or delay a settlement. The uploaded bytes are the canonical body verbatim (no re-
 * serialization), which is what keeps sha256(fetched body) == the on-chain receiptHash.
 */
export class PinataPinner implements ReceiptPinner {
  constructor(private readonly cfg: PinataPinnerConfig) {}

  async pin(canonicalBody: string, receiptHash: string): Promise<string | null> {
    if (!this.cfg.jwt) return null;
    const doFetch = this.cfg.fetchImpl ?? fetch;
    try {
      const form = new FormData();
      // Pin the EXACT canonical bytes so a verifier who fetches them back recomputes the on-chain hash.
      const file = new File([canonicalBody], `murmur-receipt-${receiptHash}.json`, {
        type: "application/json",
      });
      form.append("file", file);
      form.append("pinataOptions", JSON.stringify({ cidVersion: 1 }));
      form.append(
        "pinataMetadata",
        JSON.stringify({ name: `murmur-receipt-${receiptHash}`, keyvalues: { receiptHash } }),
      );

      const timeoutMs = this.cfg.timeoutMs ?? 15000;
      const res = await doFetch(this.cfg.endpoint ?? PINATA_ENDPOINT, {
        method: "POST",
        headers: { Authorization: `Bearer ${this.cfg.jwt}` },
        body: form,
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!res.ok) return null;
      const data = (await res.json()) as { IpfsHash?: string };
      const cid = typeof data.IpfsHash === "string" ? data.IpfsHash.trim() : "";
      return cid || null;
    } catch {
      return null;
    }
  }
}

/** Build the public gateway URL for a CID (trailing-slash tolerant; falls back to the default gateway). */
export function ipfsGatewayUrl(gateway: string, cid: string): string {
  const base = (gateway || DEFAULT_IPFS_GATEWAY).replace(/\/+$/, "");
  return `${base}/ipfs/${cid}`;
}
