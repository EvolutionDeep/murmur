/**
 * ㉚ LAND — unit tests (node:test, mirrors temple.test.ts's fixture style).
 *
 * Covers: the price ratchet at every override boundary (the 5,000 floor, +100 per seizure), a successful
 * claim, an override that changes hands and ratchets the count, the PERMANENT storage-backed dedup (a burn
 * is honoured once, ever, surviving eviction and never bounded by a ring size), an insufficient burn, an
 * out-of-range parcelId, an oversized image, the serialize/deserialize round trip (BigInt as a decimal
 * string), and a corrupt blob restarting a COLD grid.
 *
 * The chain touch (verifyBurn) is exercised through a mock LandChainClient that hands back a viem-shaped
 * receipt, so the tests never leave the process — the layer's only I/O is a pure function of that receipt.
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  LandLayer,
  LAND_GRID_X,
  LAND_GRID_Z,
  LAND_PARCEL_COUNT,
  LAND_BASE_PRICE,
  LAND_OVERRIDE_STEP,
  BURN_ADDRESS,
  MURMUR_TOKEN,
  TRANSFER_TOPIC,
  DEDUP_RING_SIZE,
  MAX_IMAGE_BYTES,
  wholeMurmur,
  landBytesToBase64,
  type LandChainClient,
  type LandReceipt,
  type LandImageStore,
  type BurnDedupStore,
} from "./land.js";

/** A valid 0x + 40-hex submitter wallet. */
const ADDR = "0x" + "ab".repeat(20);
/** A second valid wallet (so an override genuinely changes hands). */
const ADDR2 = "0x" + "cd".repeat(20);
/** A valid 0x + 64-hex tx hash. */
const TX = "0x" + "ef".repeat(32);
const SCALE = 10n ** 18n; // MURMUR has 18 decimals

/** A distinct valid tx hash per index (so multi-submit tests never trip the dedup ring). */
function txAt(i: number): string {
  return "0x" + i.toString(16).padStart(64, "0");
}

/** Left-pad an address to a 32-byte indexed-topic word (lowercase) — mirrors land's private padTopic. */
function pad(addr: string): string {
  return "0x" + addr.toLowerCase().slice(2).padStart(64, "0");
}

/** A mock chain client whose receipt is a genuine Transfer(from → 0x…dEaD) of `value` atomic MURMUR. */
function burnClient(value: bigint, from = ADDR, over: Partial<LandReceipt> = {}): LandChainClient {
  const receipt: LandReceipt = {
    status: "success",
    to: MURMUR_TOKEN,
    logs: [
      {
        address: MURMUR_TOKEN,
        topics: [TRANSFER_TOPIC, pad(from), pad(BURN_ADDRESS)],
        data: "0x" + value.toString(16),
      },
    ],
    ...over,
  };
  return { getTransactionReceipt: async () => receipt };
}

/** An in-memory image store (the DO-backed store state.ts wires up, minus the Durable Object). */
function memStore(): LandImageStore & { map: Map<string, string> } {
  const map = new Map<string, string>();
  return {
    map,
    put: async (key, data) => {
      map.set(key, typeof data === "string" ? data : landBytesToBase64(new Uint8Array(data)));
    },
    url: (key) => `/land-img/${key.startsWith("do:") ? key.slice(3) : key}`,
  };
}

/** A tiny valid base64 image body (a JPEG-ish header — non-empty, far under the ceiling). */
const IMG = landBytesToBase64(new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46]));

/** A fresh, enabled layer. */
function layer(): LandLayer {
  return new LandLayer({ enabled: true });
}

/** An in-memory permanent dedup store (mirrors the DO-storage-backed store state.ts wires up). */
function memDedup(): BurnDedupStore & { seen: Set<string> } {
  const seen = new Set<string>();
  return {
    seen,
    has: async (txHash) => seen.has(txHash),
    add: async (txHash) => { seen.add(txHash); },
  };
}

// ─── 1-3. the price ratchet (a pure function of the stored override count) ──────────────────────────────

test("land: priceOf an unclaimed parcel is the 5,000 MURMUR floor", () => {
  const l = layer();
  assert.equal(LAND_BASE_PRICE, 5_000n * SCALE);
  assert.equal(l.priceOf(0), LAND_BASE_PRICE, "no parcel ⇒ the floor");
  assert.equal(wholeMurmur(l.priceOf(0)), "5000");
});

test("land: priceOf a claimed parcel (overrides=0) is 5100 — the first override premium", () => {
  const l = layer();
  l.parcels.set(5, { owner: ADDR, imageKey: "do:5", overrides: 0, purchasedAt: 0, txHash: TX });
  assert.equal(LAND_OVERRIDE_STEP, 100n * SCALE);
  // Claimed parcel: BASE + STEP*(overrides+1) = 5000 + 100*1 = 5100
  assert.equal(l.priceOf(5), LAND_BASE_PRICE + LAND_OVERRIDE_STEP);
  assert.equal(l.priceOf(5), 5_100n * SCALE);
  assert.equal(wholeMurmur(l.priceOf(5)), "5100");
});

test("land: priceOf ratchets +100 MURMUR for one prior override", () => {
  const l = layer();
  l.parcels.set(5, { owner: ADDR, imageKey: "do:5", overrides: 1, purchasedAt: 0, txHash: TX });
  // overrides=1: BASE + STEP*(1+1) = 5000 + 200 = 5200
  assert.equal(l.priceOf(5), LAND_BASE_PRICE + LAND_OVERRIDE_STEP * 2n);
  assert.equal(l.priceOf(5), 5_200n * SCALE);
  assert.equal(wholeMurmur(l.priceOf(5)), "5200");
});

test("land: priceOf ratchets +100 MURMUR for three prior overrides", () => {
  const l = layer();
  l.parcels.set(7, { owner: ADDR, imageKey: "do:7", overrides: 3, purchasedAt: 0, txHash: TX });
  // overrides=3: BASE + STEP*(3+1) = 5000 + 400 = 5400
  assert.equal(l.priceOf(7), LAND_BASE_PRICE + LAND_OVERRIDE_STEP * 4n);
  assert.equal(l.priceOf(7), 5_400n * SCALE);
  assert.equal(wholeMurmur(l.priceOf(7)), "5400");
});

// ─── 4. a successful claim ───────────────────────────────────────────────────────────────────────────────

test("land: submit writes the parcel when the burn clears the floor price", async () => {
  const l = layer();
  l.setChainClient(burnClient(LAND_BASE_PRICE));
  const store = memStore();
  const res = await l.submit(0, TX, ADDR, IMG, store);
  assert.equal(res.ok, true);

  const p = l.parcels.get(0);
  assert.ok(p, "the parcel is claimed");
  assert.equal(p!.owner, ADDR.toLowerCase());
  assert.equal(p!.overrides, 0, "a fresh claim is not an override");
  assert.equal(p!.imageKey, "do:0");
  assert.equal(p!.txHash, TX.toLowerCase());
  assert.equal(l.totalBurned, LAND_BASE_PRICE);
  assert.equal(store.map.get("do:0"), IMG, "the image is stored under its parcel key");

  const ev = l.drainEvents();
  assert.equal(ev.length, 1, "a LAND_SOLD edge is queued for the historian");
  assert.equal(ev[0].kind, "LAND_SOLD");
  assert.equal(ev[0].price, "5000");
  assert.equal(ev[0].n, 0);
});

// ─── 5. an override changes hands and ratchets ───────────────────────────────────────────────────────────

test("land: submit seizes an existing parcel — overrides++ and the owner changes", async () => {
  const l = layer();
  const store = memStore();
  // A fresh claim by ADDR (unclaimed parcel → price = BASE = 5000).
  l.setChainClient(burnClient(LAND_BASE_PRICE, ADDR));
  assert.equal((await l.submit(3, txAt(1), ADDR, IMG, store)).ok, true);
  assert.equal(l.parcels.get(3)!.overrides, 0);
  // A seizure by ADDR2 — the parcel is claimed with overrides=0 → price = BASE + STEP*(0+1) = 5100.
  const overridePrice = LAND_BASE_PRICE + LAND_OVERRIDE_STEP;
  l.setChainClient(burnClient(overridePrice, ADDR2));
  const res = await l.submit(3, txAt(2), ADDR2, IMG, store);
  assert.equal(res.ok, true);

  const p = l.parcels.get(3)!;
  assert.equal(p.overrides, 1, "the seizure ratchets the override count");
  assert.equal(p.owner, ADDR2.toLowerCase(), "the parcel changed hands");
  assert.equal(l.totalBurned, LAND_BASE_PRICE + overridePrice, "cumulative burn = 5000 + 5100");
  // After override (overrides=1): next price = BASE + STEP*(1+1) = 5200
  assert.equal(l.priceOf(3), LAND_BASE_PRICE + LAND_OVERRIDE_STEP * 2n, "the next seizure is dearer");
  assert.equal(wholeMurmur(l.priceOf(3)), "5200");

  const ev = l.drainEvents();
  assert.equal(ev.length, 2);
  assert.equal(ev[1].kind, "LAND_OVERRIDDEN");
  assert.equal(ev[1].n, 1);
  assert.equal(ev[1].price, "5100", "the event records the override price paid");
});

// ─── 5b. override replaces the image in the store ────────────────────────────────────────────────────────

test("land: override replaces the stored image, increments overrides, changes owner", async () => {
  const l = layer();
  const store = memStore();
  // Fresh claim by ADDR with IMG_A
  const IMG_A = landBytesToBase64(new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0xAA, 0xAA, 0xAA, 0xAA]));
  const IMG_B = landBytesToBase64(new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0xBB, 0xBB, 0xBB, 0xBB]));
  l.setChainClient(burnClient(LAND_BASE_PRICE, ADDR));
  assert.equal((await l.submit(42, txAt(10), ADDR, IMG_A, store)).ok, true);
  assert.equal(store.map.get("do:42"), IMG_A, "initial image stored");
  assert.equal(l.parcels.get(42)!.owner, ADDR.toLowerCase());
  assert.equal(l.parcels.get(42)!.overrides, 0);

  // Override by ADDR2 with a DIFFERENT image (IMG_B) at the override price (5100)
  const overridePrice = LAND_BASE_PRICE + LAND_OVERRIDE_STEP;
  l.setChainClient(burnClient(overridePrice, ADDR2));
  const res = await l.submit(42, txAt(11), ADDR2, IMG_B, store);
  assert.equal(res.ok, true, "override succeeds");

  // Image is REPLACED
  assert.equal(store.map.get("do:42"), IMG_B, "the store now holds the new image");
  assert.notEqual(store.map.get("do:42"), IMG_A, "the old image is gone");
  // Owner changed
  assert.equal(l.parcels.get(42)!.owner, ADDR2.toLowerCase(), "owner is the overrider");
  // Overrides incremented
  assert.equal(l.parcels.get(42)!.overrides, 1, "overrides ratcheted to 1");
  // totalBurned accumulates both
  assert.equal(l.totalBurned, LAND_BASE_PRICE + overridePrice);
  // Event is LAND_OVERRIDDEN
  const ev = l.drainEvents();
  assert.equal(ev.length, 2);
  assert.equal(ev[1].kind, "LAND_OVERRIDDEN");
  assert.equal(ev[1].parcel, 42);
  assert.equal(ev[1].owner, ADDR2.toLowerCase());
  assert.equal(ev[1].n, 1);
  assert.equal(ev[1].price, "5100");
});

// ─── 6. the persisted dedup ring ─────────────────────────────────────────────────────────────────────────

test("land: the dedup ring honours a burn tx hash once, ever", async () => {
  const l = layer();
  l.setChainClient(burnClient(LAND_BASE_PRICE));
  const store = memStore();
  assert.equal((await l.submit(0, TX, ADDR, IMG, store)).ok, true);

  const replay = await l.submit(1, TX, ADDR, IMG, store); // same hash, a different parcel
  assert.equal(replay.ok, false, "a replayed hash is refused");
  assert.match(replay.reason ?? "", /duplicate/i);

  // The ring survives persistence, so an eviction cannot let a burn be honoured twice.
  const restored = LandLayer.deserialize(l.serialize());
  assert.equal(restored.dedupRing.includes(TX.toLowerCase()), true, "the dedup ring is persisted");
});

// ─── 7. an insufficient burn ─────────────────────────────────────────────────────────────────────────────

test("land: submit refuses a burn one atom below the parcel price", async () => {
  const l = layer();
  l.setChainClient(burnClient(LAND_BASE_PRICE - 1n));
  const res = await l.submit(0, TX, ADDR, IMG, memStore());
  assert.equal(res.ok, false);
  assert.equal(res.code, "payment_required");
  assert.equal(l.parcels.size, 0, "no parcel is written");
  assert.equal(l.totalBurned, 0n, "nothing is counted as burned");
});

test("land: submit refuses an override that burns only BASE (must burn BASE+STEP for a claimed parcel)", async () => {
  const l = layer();
  const store = memStore();
  // Fresh claim by ADDR at BASE.
  l.setChainClient(burnClient(LAND_BASE_PRICE, ADDR));
  assert.equal((await l.submit(10, txAt(1), ADDR, IMG, store)).ok, true);
  // ADDR2 tries to override burning only BASE (5000) — but price is now 5100.
  l.setChainClient(burnClient(LAND_BASE_PRICE, ADDR2));
  const res = await l.submit(10, txAt(2), ADDR2, IMG, store);
  assert.equal(res.ok, false, "override at BASE is rejected — must clear the premium");
  assert.equal(res.code, "payment_required");
  // The parcel is untouched.
  assert.equal(l.parcels.get(10)!.owner, ADDR.toLowerCase());
  assert.equal(l.parcels.get(10)!.overrides, 0);
});

// ─── 8. an out-of-range parcelId ─────────────────────────────────────────────────────────────────────────

test("land: submit refuses a parcelId outside the 24×15 grid", async () => {
  const l = layer();
  l.setChainClient(burnClient(LAND_BASE_PRICE));
  const store = memStore();
  assert.equal(LAND_PARCEL_COUNT, LAND_GRID_X * LAND_GRID_Z);

  const lo = await l.submit(-1, txAt(1), ADDR, IMG, store);
  assert.equal(lo.ok, false);
  assert.equal(lo.code, "bad_request");

  const hi = await l.submit(LAND_PARCEL_COUNT, txAt(2), ADDR, IMG, store);
  assert.equal(hi.ok, false);
  assert.equal(hi.code, "bad_request");
  assert.match(hi.reason ?? "", /out of range/i);
  assert.equal(l.parcels.size, 0);
});

// ─── 9. an oversized image ───────────────────────────────────────────────────────────────────────────────

test("land: submit refuses an image larger than 256KB after decode", async () => {
  const l = layer();
  l.setChainClient(burnClient(LAND_BASE_PRICE));
  const big = landBytesToBase64(new Uint8Array(MAX_IMAGE_BYTES + 1024).fill(7));
  const res = await l.submit(0, TX, ADDR, big, memStore());
  assert.equal(res.ok, false);
  assert.equal(res.code, "bad_request");
  assert.match(res.reason ?? "", /256KB|exceeds/i);
  assert.equal(l.parcels.size, 0);
});

// ─── 10. the serialize/deserialize round trip ────────────────────────────────────────────────────────────

test("land: serialize/deserialize is a byte-identical round trip (BigInt as a decimal string)", async () => {
  const l = layer();
  const store = memStore();
  // Two fresh claims at BASE (5000 each).
  l.setChainClient(burnClient(LAND_BASE_PRICE, ADDR));
  await l.submit(0, txAt(1), ADDR, IMG, store);
  await l.submit(1, txAt(2), ADDR, IMG, store);
  // Override parcel 0 (overrides=0 → price = BASE + STEP = 5100).
  const overridePrice = LAND_BASE_PRICE + LAND_OVERRIDE_STEP;
  l.setChainClient(burnClient(overridePrice, ADDR2));
  await l.submit(0, txAt(3), ADDR2, IMG, store); // override parcel 0

  const json1 = l.serialize();
  assert.doesNotThrow(() => JSON.parse(json1), "the blob is plain JSON (no BigInt leaks)");
  const l2 = LandLayer.deserialize(json1);
  assert.equal(l2.serialize(), json1, "re-serializing the rebuild is byte-identical");

  // totalBurned = 5000 + 5000 + 5100 = 15100
  const expectedBurned = LAND_BASE_PRICE * 2n + overridePrice;
  assert.equal(l2.totalBurned, l.totalBurned, "the cumulative burn survives");
  assert.equal(l2.totalBurned, expectedBurned);
  assert.equal(l2.parcels.get(0)!.overrides, 1);
  assert.equal(l2.parcels.get(0)!.owner, ADDR2.toLowerCase());
  assert.equal(l2.readout().parcelsSold, 2);
  assert.equal(l2.readout().totalBurned, wholeMurmur(expectedBurned));
  // After override (overrides=1): priceOf(0) = BASE + STEP*(1+1) = 5200
  assert.equal(wholeMurmur(l2.priceOf(0)), "5200");
});

// ─── 11. a corrupt blob restarts cold ────────────────────────────────────────────────────────────────────

test("land: deserialize of a corrupt blob yields a cold, empty grid", () => {
  const l = LandLayer.deserialize("{ this is not json");
  const ro = l.readout();
  assert.equal(ro.parcelsSold, 0);
  assert.equal(ro.totalBurned, "0");
  assert.deepEqual(ro.parcels, []);
  assert.equal(l.dedupRing.length, 0);
  // An empty/absent blob is likewise cold (never poisoned).
  assert.equal(LandLayer.deserialize("").readout().parcelsSold, 0);
});

// ─── 12. the permanent dedup (storage-backed, never bounded by a ring size) ─────────────────────────────

test("land: the storage-backed dedup honours a burn once, ever — even past DEDUP_RING_SIZE", async () => {
  const l = layer();
  const dedup = memDedup();
  l.setDedupStore(dedup);
  l.setChainClient(burnClient(LAND_BASE_PRICE));
  const store = memStore();

  // Submit more than DEDUP_RING_SIZE distinct burns; the in-memory ring evicts the oldest, but the
  // storage-backed dedup remembers EVERY hash permanently.
  const total = DEDUP_RING_SIZE + 20;
  for (let i = 0; i < total; i++) {
    const res = await l.submit(i % LAND_PARCEL_COUNT, txAt(i), ADDR, IMG, store);
    assert.equal(res.ok, true, `burn ${i} honoured`);
  }

  // The in-memory ring is still bounded (hot cache only).
  assert.equal(l.dedupRing.length, DEDUP_RING_SIZE, "the in-memory ring stays bounded");
  // But the storage-backed dedup remembers ALL hashes — the oldest are still rejected.
  assert.equal(dedup.seen.size, total, "the permanent dedup remembers every hash");
  const replayOldest = await l.submit(0, txAt(0), ADDR, IMG, store);
  assert.equal(replayOldest.ok, false, "the oldest hash (evicted from the ring) is STILL refused");
  assert.match(replayOldest.reason ?? "", /duplicate/i);
  const replayNewest = await l.submit(0, txAt(total - 1), ADDR, IMG, store);
  assert.equal(replayNewest.ok, false, "the newest hash is refused too");
  assert.match(replayNewest.reason ?? "", /duplicate/i);
});

test("land: the dedup falls back to the in-memory ring when no store is wired", async () => {
  const l = layer();
  // No dedupStore wired — the legacy bounded ring is the only guard.
  l.setChainClient(burnClient(LAND_BASE_PRICE));
  const store = memStore();
  assert.equal((await l.submit(0, TX, ADDR, IMG, store)).ok, true);
  const replay = await l.submit(1, TX, ADDR, IMG, store);
  assert.equal(replay.ok, false, "a replayed hash is refused by the in-memory ring");
  assert.match(replay.reason ?? "", /duplicate/i);
});
