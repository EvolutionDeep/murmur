/**
 * ㉚ LAND — unit tests (node:test, mirrors temple.test.ts's fixture style).
 *
 * Covers: the price ratchet at every override boundary (the 10,000 floor, +100 per seizure), a successful
 * claim, an override that changes hands and ratchets the count, the persisted dedup ring (a burn is honoured
 * once, ever), an insufficient burn, an out-of-range parcelId, an oversized image, the serialize/deserialize
 * round trip (BigInt as a decimal string), a corrupt blob restarting a COLD grid, and the dedup ring's cap.
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

// ─── 1-3. the price ratchet (a pure function of the stored override count) ──────────────────────────────

test("land: priceOf an unclaimed parcel is the 10,000 MURMUR floor", () => {
  const l = layer();
  assert.equal(LAND_BASE_PRICE, 10_000n * SCALE);
  assert.equal(l.priceOf(0), LAND_BASE_PRICE, "no parcel ⇒ the floor");
  assert.equal(wholeMurmur(l.priceOf(0)), "10000");
});

test("land: priceOf ratchets +100 MURMUR for one prior override", () => {
  const l = layer();
  l.parcels.set(5, { owner: ADDR, imageKey: "do:5", overrides: 1, purchasedAt: 0, txHash: TX });
  assert.equal(LAND_OVERRIDE_STEP, 100n * SCALE);
  assert.equal(l.priceOf(5), LAND_BASE_PRICE + LAND_OVERRIDE_STEP);
  assert.equal(l.priceOf(5), 10_100n * SCALE);
  assert.equal(wholeMurmur(l.priceOf(5)), "10100");
});

test("land: priceOf ratchets +100 MURMUR for three prior overrides", () => {
  const l = layer();
  l.parcels.set(7, { owner: ADDR, imageKey: "do:7", overrides: 3, purchasedAt: 0, txHash: TX });
  assert.equal(l.priceOf(7), LAND_BASE_PRICE + LAND_OVERRIDE_STEP * 3n);
  assert.equal(l.priceOf(7), 10_300n * SCALE);
  assert.equal(wholeMurmur(l.priceOf(7)), "10300");
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
  assert.equal(ev[0].price, "10000");
  assert.equal(ev[0].n, 0);
});

// ─── 5. an override changes hands and ratchets ───────────────────────────────────────────────────────────

test("land: submit seizes an existing parcel — overrides++ and the owner changes", async () => {
  const l = layer();
  const store = memStore();
  // A fresh claim by ADDR.
  l.setChainClient(burnClient(LAND_BASE_PRICE, ADDR));
  assert.equal((await l.submit(3, txAt(1), ADDR, IMG, store)).ok, true);
  assert.equal(l.parcels.get(3)!.overrides, 0);
  // A seizure by ADDR2 — the price is still the floor (overrides was 0), so the same burn clears it.
  l.setChainClient(burnClient(LAND_BASE_PRICE, ADDR2));
  const res = await l.submit(3, txAt(2), ADDR2, IMG, store);
  assert.equal(res.ok, true);

  const p = l.parcels.get(3)!;
  assert.equal(p.overrides, 1, "the seizure ratchets the override count");
  assert.equal(p.owner, ADDR2.toLowerCase(), "the parcel changed hands");
  assert.equal(l.totalBurned, LAND_BASE_PRICE * 2n);
  assert.equal(l.priceOf(3), LAND_BASE_PRICE + LAND_OVERRIDE_STEP, "the next seizure is dearer");

  const ev = l.drainEvents();
  assert.equal(ev.length, 2);
  assert.equal(ev[1].kind, "LAND_OVERRIDDEN");
  assert.equal(ev[1].n, 1);
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
  l.setChainClient(burnClient(LAND_BASE_PRICE, ADDR));
  await l.submit(0, txAt(1), ADDR, IMG, store);
  await l.submit(1, txAt(2), ADDR, IMG, store);
  l.setChainClient(burnClient(LAND_BASE_PRICE, ADDR2));
  await l.submit(0, txAt(3), ADDR2, IMG, store); // override parcel 0

  const json1 = l.serialize();
  assert.doesNotThrow(() => JSON.parse(json1), "the blob is plain JSON (no BigInt leaks)");
  const l2 = LandLayer.deserialize(json1);
  assert.equal(l2.serialize(), json1, "re-serializing the rebuild is byte-identical");

  assert.equal(l2.totalBurned, l.totalBurned, "the cumulative burn survives");
  assert.equal(l2.totalBurned, LAND_BASE_PRICE * 3n);
  assert.equal(l2.parcels.get(0)!.overrides, 1);
  assert.equal(l2.parcels.get(0)!.owner, ADDR2.toLowerCase());
  assert.equal(l2.readout().parcelsSold, 2);
  assert.equal(l2.readout().totalBurned, wholeMurmur(LAND_BASE_PRICE * 3n));
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

// ─── 12. the dedup ring is bounded ───────────────────────────────────────────────────────────────────────

test("land: the dedup ring is bounded to DEDUP_RING_SIZE", async () => {
  const l = layer();
  l.setChainClient(burnClient(LAND_BASE_PRICE));
  const store = memStore();
  for (let i = 0; i < DEDUP_RING_SIZE + 20; i++) {
    const res = await l.submit(i, txAt(i), ADDR, IMG, store); // distinct parcel + distinct hash, all fresh
    assert.equal(res.ok, true, `parcel ${i} claimed`);
  }
  assert.equal(l.dedupRing.length, DEDUP_RING_SIZE, "the ring never grows past its cap");
  const ring = JSON.parse(l.serialize()).dedupRing as string[];
  assert.equal(ring.length, DEDUP_RING_SIZE);
  // The oldest hashes have been evicted; the newest is still honoured-once.
  assert.equal(ring.includes(txAt(DEDUP_RING_SIZE + 19)), true);
  assert.equal(ring.includes(txAt(0)), false);
});
