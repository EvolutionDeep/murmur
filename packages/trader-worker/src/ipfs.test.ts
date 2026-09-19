// IPFS-pinning tests. Two things are pinned down here:
//   1. THE TRUST ROOT: sha256 of the canonical body we hand to the pinner equals netReceiptHash(receipt) —
//      i.e. the exact bytes a verifier fetches back from IPFS recompute to the on-chain receiptHash. Without
//      this, pinning would prove nothing.
//   2. The Pinata pinner's request shape + its best-effort contract (every failure path degrades to null and
//      never throws), so a pinning hiccup can't abort a settlement.

import test from "node:test";
import assert from "node:assert/strict";

import {
  PinataPinner,
  PINATA_ENDPOINT,
  DEFAULT_IPFS_GATEWAY,
  ipfsGatewayUrl,
  type ReceiptPinner,
} from "./ipfs.js";
import {
  canonical,
  netReceiptHash,
  type NetReceipt,
  type NeuralEvidence,
} from "./provenance.js";

// ---------- helpers ----------

/** sha256 of raw UTF-8 bytes as 64-hex — exactly what the browser does to a body fetched from a gateway. */
async function sha256Raw(text: string): Promise<string> {
  const dig = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(dig)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** A fetch mock that records each call and returns a canned response. */
function mockFetch(res: { ok: boolean; status: number; body: unknown }) {
  const calls: { url: string; init: RequestInit }[] = [];
  const impl = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return { ok: res.ok, status: res.status, json: async () => res.body } as unknown as Response;
  }) as typeof fetch;
  return { impl, calls };
}

const ev = (id: number, state: string): NeuralEvidence => ({
  id, state, arousal: 0.5, turnBias: 0.125, cohesion: 0.25, wingbeat: 0.375,
  rest: 0.4, temperament: 0.6, fingerprint: `fp-${id}`,
});

const sampleReceipt: NetReceipt = {
  v: 1, policy: "econ-v1", chain: "arc", pair: [0, 1], debtor: 0, creditor: 1,
  netAmount: "2000", trades: 3, good: "signal", tickIndex: 7, flushSeq: 2, chunk: 0,
  constituents: [{
    tick: 7, fromId: 0, toId: 1, good: "signal", amount: "2000",
    buyer: ev(0, "EXPLORE"), seller: ev(1, "AGITATE"),
    decisionHash: "aa".repeat(32),
  }],
  prevChain: "bb".repeat(32),
};

// ---------- the trust root ----------

test("sha256 of the canonical body == netReceiptHash: a body fetched from IPFS recomputes to the on-chain hash", async () => {
  const body = canonical(sampleReceipt);
  const expected = await netReceiptHash(sampleReceipt);
  assert.equal(await sha256Raw(body), expected);
  assert.match(expected, /^[0-9a-f]{64}$/);
});

// ---------- PinataPinner request shape ----------

test("pin() POSTs the canonical bytes as multipart with cidVersion:1 + Bearer JWT and returns the CID", async () => {
  const { impl, calls } = mockFetch({ ok: true, status: 200, body: { IpfsHash: "bafkreiabc123", PinSize: 42 } });
  const pinner = new PinataPinner({ jwt: "test-jwt", fetchImpl: impl, timeoutMs: 100 });
  const body = canonical(sampleReceipt);
  const cid = await pinner.pin(body, "deadbeef");

  assert.equal(cid, "bafkreiabc123");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, PINATA_ENDPOINT);
  const init = calls[0].init;
  assert.equal(init.method, "POST");
  assert.equal((init.headers as Record<string, string>).Authorization, "Bearer test-jwt");

  const form = init.body as FormData;
  assert.ok(form instanceof FormData);
  assert.equal(form.get("pinataOptions"), JSON.stringify({ cidVersion: 1 }));
  const meta = JSON.parse(String(form.get("pinataMetadata")));
  assert.equal(meta.keyvalues.receiptHash, "deadbeef");

  // The pinned file's bytes are EXACTLY the canonical body, so sha256(fetched) == receiptHash holds.
  const file = form.get("file") as File;
  assert.ok(file instanceof File);
  assert.equal(await file.text(), body);
});

test("a custom endpoint is honoured", async () => {
  const { impl, calls } = mockFetch({ ok: true, status: 200, body: { IpfsHash: "cid" } });
  const pinner = new PinataPinner({ jwt: "j", endpoint: "https://example.test/pin", fetchImpl: impl, timeoutMs: 100 });
  await pinner.pin("{}", "h");
  assert.equal(calls[0].url, "https://example.test/pin");
});

// ---------- best-effort contract: every failure degrades to null, never throws ----------

test("pin() returns null on a non-OK response", async () => {
  const { impl } = mockFetch({ ok: false, status: 403, body: { error: "registration_required" } });
  const pinner = new PinataPinner({ jwt: "test-jwt", fetchImpl: impl, timeoutMs: 100 });
  assert.equal(await pinner.pin(canonical(sampleReceipt), "h"), null);
});

test("pin() returns null when fetch rejects (network blip)", async () => {
  const impl = (async () => { throw new Error("boom"); }) as unknown as typeof fetch;
  const pinner = new PinataPinner({ jwt: "test-jwt", fetchImpl: impl, timeoutMs: 100 });
  assert.equal(await pinner.pin(canonical(sampleReceipt), "h"), null);
});

test("pin() returns null when the response carries no IpfsHash", async () => {
  const { impl } = mockFetch({ ok: true, status: 200, body: { PinSize: 1 } });
  const pinner = new PinataPinner({ jwt: "test-jwt", fetchImpl: impl, timeoutMs: 100 });
  assert.equal(await pinner.pin(canonical(sampleReceipt), "h"), null);
});

test("pin() short-circuits to null with an empty JWT (no request sent)", async () => {
  const { impl, calls } = mockFetch({ ok: true, status: 200, body: { IpfsHash: "x" } });
  const pinner = new PinataPinner({ jwt: "", fetchImpl: impl, timeoutMs: 100 });
  assert.equal(await pinner.pin(canonical(sampleReceipt), "h"), null);
  assert.equal(calls.length, 0);
});

// ---------- gateway URL ----------

test("ipfsGatewayUrl builds a /ipfs/<cid> URL, tolerates trailing slashes, and falls back to the default", () => {
  assert.equal(ipfsGatewayUrl("https://ipfs.io", "cid123"), "https://ipfs.io/ipfs/cid123");
  assert.equal(ipfsGatewayUrl("https://gateway.test/", "cid123"), "https://gateway.test/ipfs/cid123");
  assert.equal(ipfsGatewayUrl("", "cid123"), `${DEFAULT_IPFS_GATEWAY}/ipfs/cid123`);
});

// ---------- interface shape ----------

test("ReceiptPinner is satisfiable by a trivial stub (the economy only needs .pin)", async () => {
  const stub: ReceiptPinner = { pin: async () => "stub-cid" };
  assert.equal(await stub.pin("body", "hash"), "stub-cid");
});
