/**
 * ㉚ LAND — burn-to-claim pixel parcels (packages/trader-worker/src/land.ts).
 *
 * The continent the swarm lives on is divided into a fixed 24×15 = 360 parcel grid. A holder who wants to
 * plant their image on a parcel does not vote and does not bribe a wallet: they send MURMUR to 0x…dEaD —
 * provably, irreversibly GONE — and submit the tx hash with the image. The Worker re-reads that hash
 * on-chain (keyless, read-only, zero gas), and only when the burn is real and clears the parcel's price does
 * the parcel change hands. Every parcel has a floor price (LAND_BASE_PRICE); each time a parcel is SEIZED
 * (overridden) its price ratchets up by LAND_OVERRIDE_STEP, so holding contested ground gets ever dearer and
 * the destroyed value only ever grows. Value is burned on the way in, so a parcel can never be recycled,
 * bought back, or spent twice.
 *
 * THE THREE IRON RULES (the culture/faith/court/reform/temple law, restated for the land grid):
 *   1. PURE READ-OUT + INTERNAL BOOKKEEPING. submit() reads the receipt the chain client returns and keeps a
 *      bounded parcel ledger; it moves no real money and signs nothing. The ONLY chain touch is verifyBurn,
 *      and it is a READ (getTransactionReceipt) — it can never spend.
 *   2. DETERMINISM. No RNG, no clock, no LLM inside the layer. verifyBurn is a pure function of the receipt
 *      it is handed; priceOf is a pure function of the stored override count; serialize/deserialize round-trips
 *      byte-identically (BigInts as decimal strings).
 *   3. BOUNDED. The parcel ledger is capped at 360 entries, the dedup ring at 100, the pending chronicle
 *      events at EVENTS_CAP, and every image at MAX_IMAGE_BYTES; a corrupt blob restarts a COLD grid, never a
 *      poisoned one.
 *
 * LAND_ENABLED=false ⇒ state.ts never constructs the layer (ensureLand returns null), folds no `land` key into
 * the historian's context ⇒ the two land chronicle kinds can never speak ⇒ every old line is byte-for-byte the
 * pre-Land build. (Shipped default is ON — the ㉔-㉙ "armed on code defaults" 口径; wrangler.toml [vars] is at
 * the 128-binding wall, so the master switch reads an env key only and is NOT added to [vars].)
 */

// ─── deterministic constants (code-managed: wrangler.toml [vars] is at capacity, so the land lines live
//     here as constants — the same "armed on code defaults, master switch reads an env key" shape as ㉘/㉙) ───

const LD_VERSION = 1;

/** The fixed parcel grid: 24 columns (world X) × 15 rows (world Z) = 360 claimable parcels. */
export const LAND_GRID_X = 24;
export const LAND_GRID_Z = 15;
/** The total number of parcels (LAND_GRID_X × LAND_GRID_Z). A parcelId lives in [0, LAND_PARCEL_COUNT). */
export const LAND_PARCEL_COUNT = LAND_GRID_X * LAND_GRID_Z;

/** The floor price of a fresh parcel, in MURMUR atomic units (18 decimals): 10,000 MURMUR. */
export const LAND_BASE_PRICE = 10_000n * 10n ** 18n;
/** The ratchet added to a parcel's price for every prior override: +100 MURMUR per seizure. */
export const LAND_OVERRIDE_STEP = 100n * 10n ** 18n;

/** The canonical ERC-20 burn sink. Tokens sent here are provably unspendable — destroyed. */
export const BURN_ADDRESS = "0x000000000000000000000000000000000000dEaD";
/** MURMUR, the project's ERC-20 on Arc mainnet (18 decimals). The only token a land burn counts in. */
export const MURMUR_TOKEN = "0x8faae5592b9acc27a79fca745c6b872adf514a5d";

/**
 * keccak256("Transfer(address indexed from, address indexed to, uint256 value)") — the standard ERC-20
 * transfer topic. Mirrors temple.ts's / bourse.ts's export by design (the layers stay independently testable
 * and none imports another's constants — the same discipline temple.ts uses).
 */
export const TRANSFER_TOPIC =
  "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";

/** The replay-protection ring: a tx hash is honoured once, ever (persisted, so a restart cannot replay). */
export const DEDUP_RING_SIZE = 100;
/** The hard ceiling on one parcel image, AFTER base64 decode (256 KB). A larger upload is rejected. */
export const MAX_IMAGE_BYTES = 256 * 1024;
/** The pending-chronicle-event ring (bounded; drained once per cron by state.ts's driveLand). */
export const EVENTS_CAP = 64;

/** The cheap pre-decode guard: the longest base64 string that can decode to ≤ MAX_IMAGE_BYTES (+ padding slack). */
const MAX_IMAGE_B64_LEN = Math.ceil(MAX_IMAGE_BYTES / 3) * 4 + 4;

// ─── the persisted + passed shapes ────────────────────────────────────────────────────────────────────

/** One claimed parcel. `owner` is lowercased; `imageKey` locates the picture ("do:<id>" for DO storage). */
export interface LandParcel {
  owner: string;        // address, lowercase
  imageKey: string;     // storage key discriminator — "do:<parcelId>" for the DO-backed image store
  overrides: number;    // how many times this parcel has been seized (0 = only ever freshly claimed)
  purchasedAt: number;  // the sub-tick index the LAST purchase settled at
  txHash: string;       // the last purchase's burn tx hash (lowercase)
}

/** A narratable land edge, drained once per cron into the historian's context (bounded to EVENTS_CAP). */
export interface LandEvent {
  kind: "LAND_SOLD" | "LAND_OVERRIDDEN";
  parcel: number;
  owner: string;   // lowercase address
  price: string;   // whole MURMUR the claim/seizure cost (a decimal string, never a BigInt)
  n: number;       // the override count AFTER the event (0 for a fresh sale)
}

/** The public GET /land parcel row (imageUrl is derived from imageKey by state.ts's image store). */
export interface LandParcelView {
  id: number;
  owner: string;
  imageKey: string;
  overrides: number;
  price: string;   // whole MURMUR to (re)acquire this parcel right now = priceOf(id) / 1e18
}

/** The standing read-out folded into GET /land (absent ⇒ LAND_ENABLED=false). */
export interface LandReadout {
  enabled: boolean;
  gridX: number;
  gridZ: number;
  basePrice: string;     // whole MURMUR ("10000")
  overrideStep: string;  // whole MURMUR ("100")
  parcelsSold: number;
  totalBurned: string;   // whole MURMUR destroyed through the land grid
  parcels: LandParcelView[];
}

/** The persisted shape (one small JSON; the totalBurned BigInt is a decimal string, images live elsewhere). */
export interface LandSerialized {
  v: 1;
  parcels: Array<{ id: number; owner: string; imageKey: string; overrides: number; purchasedAt: number; txHash: string }>;
  dedupRing: string[];
  totalBurned: string;
  events: LandEvent[];
}

/** submit()'s verdict (the POST /land response is built from it). `code` maps to the HTTP status. */
export interface LandSubmitResult {
  ok: boolean;
  reason?: string;
  code?: "bad_request" | "payment_required";
}

/**
 * Where a parcel's picture lives. state.ts implements a DO-backed store (base64 under a per-parcel key, kept
 * OUT of the serialize blob); an R2-backed store would decode `data` to bytes and PUT it to a bucket. `url`
 * returns the public path the frontend resolves against the API origin.
 */
export interface LandImageStore {
  put(key: string, data: ArrayBuffer | string): Promise<void>;
  url(key: string): string;  // public URL / path
}

// ─── the minimal chain handle verifyBurn needs (structural, so the layer stays dependency-free) ────────

/** One receipt log, loosely typed so any viem-shaped receipt is structurally acceptable. */
export interface LandReceiptLog { address?: unknown; topics?: unknown; data?: unknown; }
/** The slice of a transaction receipt verifyBurn reads (viem's TransactionReceipt is assignable). */
export interface LandReceipt { status?: unknown; to?: unknown; logs?: LandReceiptLog[]; }
/** The read-only client contract; state.ts adapts viem's PublicClient (which takes { hash }) to it. */
export interface LandChainClient {
  getTransactionReceipt(txHash: string): Promise<LandReceipt>;
}

// ─── pure helpers (the house discipline: finiteness-checked coercion, never `Number(v) || d`) ──────────

/** A finite number or the default — NEVER `Number(v) || d` (that silently drops a legitimate 0). */
function num(v: unknown, d: number): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : d;
}

/** A non-negative BigInt or the default (JSON gives decimal strings; BigInt(null/"") would throw). */
function big(v: unknown, d: bigint): bigint {
  if (v == null) return d;
  try {
    const b = typeof v === "bigint" ? v : BigInt(typeof v === "string" ? v.trim() : String(v));
    return b >= 0n ? b : d;
  } catch {
    return d;
  }
}

/** True for a 0x-prefixed 40-hex-char EVM address. */
function isAddress(a: unknown): a is string {
  return typeof a === "string" && /^0x[0-9a-fA-F]{40}$/.test(a);
}

/** Case-insensitive address equality (both sides may be checksum- or lower-cased). */
function sameAddr(a: unknown, b: string): boolean {
  return typeof a === "string" && a.toLowerCase() === b.toLowerCase();
}

/** Left-pad an address to a 32-byte indexed-topic hex word (lowercase). */
function padTopic(addr: string): string {
  return "0x" + addr.toLowerCase().slice(2).padStart(64, "0");
}

/** A hex/decimal string → BigInt, or 0n on garbage (a log's `data` word is the transfer value). */
function hexToBig(v: unknown): bigint {
  if (typeof v !== "string" || !v) return 0n;
  try { return BigInt(v); } catch { return 0n; }
}

/** True when a receipt status means the tx succeeded (viem "success"; raw 1 / "0x1" tolerated). */
function succeeded(status: unknown): boolean {
  return status === "success" || status === 1 || status === "0x1" || status === 1n;
}

/** An atomic MURMUR amount → the whole-token decimal string the templates + read-out speak ("10000"). */
export function wholeMurmur(atomic: bigint): string {
  return (atomic / 10n ** 18n).toString();
}

/** Strip an optional `data:…;base64,` prefix + all whitespace, so atob() sees a clean base64 body. */
export function cleanBase64(input: unknown): string {
  if (typeof input !== "string") return "";
  let s = input.trim();
  if (s.startsWith("data:")) {
    const comma = s.indexOf(",");
    if (comma > 0) s = s.slice(comma + 1);
  }
  return s.replace(/\s+/g, "");
}

/** base64 → bytes, or null on invalid base64 (atob throws). Exported for state.ts's GET /land-img. */
export function landBase64ToBytes(b64: string): Uint8Array | null {
  try {
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return bytes;
  } catch {
    return null;
  }
}

/** bytes → base64 (a plain loop, so a 256 KB image never blows the call stack). Exported for the DO store. */
export function landBytesToBase64(bytes: Uint8Array | ArrayBuffer): string {
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let bin = "";
  for (let i = 0; i < view.length; i++) bin += String.fromCharCode(view[i]);
  return btoa(bin);
}

// ─── the membrane ───────────────────────────────────────────────────────────────────────────────────────

export interface LandConfig { enabled: boolean; }

export class LandLayer {
  /** parcelId → the claimed parcel. Public so tests + state.ts can read the ledger directly. */
  parcels: Map<number, LandParcel> = new Map();
  /** The persisted tx-hash replay guard (a burn is honoured once, ever). */
  dedupRing: string[] = [];
  /** Cumulative MURMUR (atomic) destroyed through the land grid. BigInt → string on serialize. */
  totalBurned = 0n;

  /** The pending chronicle edges (bounded ring), drained once per cron by state.ts's driveLand. */
  private events: LandEvent[] = [];
  /** The read-only chain handle verifyBurn uses; state.ts injects it before each submit. */
  private client: LandChainClient | null = null;
  /** The sub-tick the next purchase stamps as purchasedAt; state.ts sets it from the last snapshot. */
  private tick = 0;

  constructor(private readonly cfg: LandConfig) {}

  /** Inject the read-only chain client (viem's PublicClient, adapted). Null ⇒ verifyBurn always fails. */
  setChainClient(client: LandChainClient | null): void { this.client = client; }

  /** Stamp the sub-tick the next purchase records as purchasedAt (informational; never a clock read here). */
  setTick(t: number): void { this.tick = Math.max(0, Math.trunc(num(t, 0))); }

  // ── 1. pricing (a pure function of the stored override count) ─────────────────────────────────────────

  /** The price to acquire `parcelId` right now: BASE + STEP × (its current override count). */
  priceOf(parcelId: number): bigint {
    const p = this.parcels.get(parcelId);
    const overrides = p ? Math.max(0, p.overrides) : 0;
    return LAND_BASE_PRICE + LAND_OVERRIDE_STEP * BigInt(overrides);
  }

  // ── 2. on-chain burn verification (the ONLY chain touch — a read, never a spend) ──────────────────────

  /**
   * Re-read `txHash` on Arc and confirm it is a genuine burn of MURMUR by `address` of at least `minAmount`.
   * Pure over the receipt the client returns: success status, the tx targeted the MURMUR contract, and at
   * least one Transfer(from=address, to=0x…dEaD) leg. Multiple burn legs in one tx are summed (a single
   * submission may batch). Keyless, read-only, zero gas.
   */
  async verifyBurn(txHash: string, address: string, minAmount: bigint): Promise<boolean> {
    if (!this.client) return false;
    if (typeof txHash !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(txHash)) return false;
    if (!isAddress(address)) return false;

    let receipt: LandReceipt;
    try {
      receipt = await this.client.getTransactionReceipt(txHash);
    } catch {
      return false;
    }
    if (!receipt || typeof receipt !== "object") return false;
    if (!succeeded(receipt.status)) return false;
    if (!sameAddr(receipt.to, MURMUR_TOKEN)) return false;

    const burnTopic = padTopic(BURN_ADDRESS);
    const fromTopic = padTopic(address);
    let burned = 0n;
    let found = false;
    for (const log of Array.isArray(receipt.logs) ? receipt.logs : []) {
      if (!sameAddr(log?.address, MURMUR_TOKEN)) continue;
      const topics = Array.isArray(log?.topics) ? (log.topics as unknown[]) : [];
      const t0 = typeof topics[0] === "string" ? (topics[0] as string).toLowerCase() : "";
      const t1 = typeof topics[1] === "string" ? (topics[1] as string).toLowerCase() : "";
      const t2 = typeof topics[2] === "string" ? (topics[2] as string).toLowerCase() : "";
      if (t0 !== TRANSFER_TOPIC) continue;
      if (t2 !== burnTopic) continue;      // to == the burn sink
      if (t1 !== fromTopic) continue;      // from == the submitter (they burned THEIR OWN tokens)
      const value = hexToBig(log?.data);
      if (value > 0n) { burned += value; found = true; }
    }
    if (!found) return false;
    return burned >= minAmount;
  }

  // ── 3. submission (verify the burn, store the image, write/override the parcel) ───────────────────────

  /**
   * Claim (or seize) one parcel. Order matters: cheap validation FIRST (parcelId range, address, txHash
   * shape, dedup, image decode + size), then the ONE chain read (verifyBurn against priceOf), then commit
   * (dedup ring, image store, parcel write, totalBurned, a narratable event). A fresh parcel is a LAND_SOLD
   * (overrides 0); seizing an existing one is a LAND_OVERRIDDEN (overrides++). Never spends, never signs.
   */
  async submit(
    parcelId: number,
    txHash: string,
    address: string,
    imageBase64: string,
    store: LandImageStore,
  ): Promise<LandSubmitResult> {
    // 1. parcelId range
    const id = Number(parcelId);
    if (!Number.isInteger(id) || id < 0 || id >= LAND_PARCEL_COUNT) {
      return { ok: false, reason: "parcelId out of range", code: "bad_request" };
    }
    // 2. address
    if (!isAddress(address)) return { ok: false, reason: "invalid address", code: "bad_request" };
    // 3. txHash shape
    if (typeof txHash !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(txHash)) {
      return { ok: false, reason: "malformed txHash", code: "bad_request" };
    }
    const tx = txHash.toLowerCase();
    // 4. dedup (a burn is honoured once, ever)
    if (this.dedupRing.includes(tx)) return { ok: false, reason: "duplicate txHash", code: "bad_request" };
    // 5. image decode + size ceiling
    const cleaned = cleanBase64(imageBase64);
    if (!cleaned) return { ok: false, reason: "missing image", code: "bad_request" };
    if (cleaned.length > MAX_IMAGE_B64_LEN) return { ok: false, reason: "image exceeds 256KB", code: "bad_request" };
    const bytes = landBase64ToBytes(cleaned);
    if (!bytes) return { ok: false, reason: "invalid image base64", code: "bad_request" };
    if (bytes.length === 0) return { ok: false, reason: "empty image", code: "bad_request" };
    if (bytes.length > MAX_IMAGE_BYTES) return { ok: false, reason: "image exceeds 256KB", code: "bad_request" };

    // 6. the ONE chain read: a genuine MURMUR burn by `address` of at least this parcel's price
    const price = this.priceOf(id);
    const verified = await this.verifyBurn(tx, address, price);
    if (!verified) return { ok: false, reason: "burn verification failed", code: "payment_required" };

    // 7. commit — dedup ring, image store, parcel write, cumulative burn, narratable edge
    this.dedupRing.push(tx);
    if (this.dedupRing.length > DEDUP_RING_SIZE) this.dedupRing = this.dedupRing.slice(-DEDUP_RING_SIZE);

    const existing = this.parcels.get(id);
    const overrides = existing ? existing.overrides + 1 : 0;
    const imageKey = `do:${id}`;
    try {
      await store.put(imageKey, cleaned);   // the DO store persists the base64 body under a per-parcel key
    } catch (e) {
      return { ok: false, reason: `image store failed: ${(e as Error)?.message ?? "unknown"}`, code: "bad_request" };
    }
    const owner = address.toLowerCase();
    this.parcels.set(id, { owner, imageKey, overrides, purchasedAt: this.tick, txHash: tx });
    this.totalBurned += price;
    this.pushEvent(existing
      ? { kind: "LAND_OVERRIDDEN", parcel: id, owner, price: wholeMurmur(price), n: overrides }
      : { kind: "LAND_SOLD", parcel: id, owner, price: wholeMurmur(price), n: 0 });
    return { ok: true };
  }

  /** Append one narratable edge, honouring EVENTS_CAP (the oldest drain first). */
  private pushEvent(ev: LandEvent): void {
    this.events.push(ev);
    if (this.events.length > EVENTS_CAP) this.events = this.events.slice(-EVENTS_CAP);
  }

  /** Hand the pending chronicle edges to state.ts and clear them (told once, from the cron that saw them). */
  drainEvents(): LandEvent[] {
    const ev = this.events;
    this.events = [];
    return ev;
  }

  // ── 4. the standing read-out ──────────────────────────────────────────────────────────────────────────

  /** The sorted parcel rows (id ascending) — deterministic, so the read-out replays byte-identically. */
  parcelsList(): LandParcelView[] {
    const out: LandParcelView[] = [];
    for (const [id, p] of this.parcels) {
      out.push({ id, owner: p.owner, imageKey: p.imageKey, overrides: p.overrides, price: wholeMurmur(this.priceOf(id)) });
    }
    out.sort((a, b) => a.id - b.id);
    return out;
  }

  readout(): LandReadout {
    return {
      enabled: this.cfg.enabled,
      gridX: LAND_GRID_X,
      gridZ: LAND_GRID_Z,
      basePrice: wholeMurmur(LAND_BASE_PRICE),
      overrideStep: wholeMurmur(LAND_OVERRIDE_STEP),
      parcelsSold: this.parcels.size,
      totalBurned: wholeMurmur(this.totalBurned),
      parcels: this.parcelsList(),
    };
  }

  // ── 5. persistence (bounded; the totalBurned BigInt is a decimal string, images live in their own keys) ──

  serialize(): string {
    const parcels: LandSerialized["parcels"] = [];
    for (const [id, p] of this.parcels) {
      parcels.push({
        id, owner: p.owner, imageKey: p.imageKey,
        overrides: p.overrides, purchasedAt: p.purchasedAt, txHash: p.txHash,
      });
    }
    parcels.sort((a, b) => a.id - b.id);
    const body: LandSerialized = {
      v: LD_VERSION as 1,
      parcels,
      dedupRing: this.dedupRing.slice(-DEDUP_RING_SIZE),
      totalBurned: this.totalBurned.toString(),
      events: this.events.slice(-EVENTS_CAP).map((e) => ({ ...e })),
    };
    return JSON.stringify(body);
  }

  /**
   * Rebuild a layer from its persisted blob. A corrupt/absent blob yields a COLD grid (never a poisoned one):
   * no parcel is back-dated and no burn is replayed, because the persisted dedup ring is the replay guard.
   * Numerics are coerced with an explicit finiteness check — NEVER `Number(v) || d` (the house-id-0 pitfall);
   * totalBurned comes back from its decimal string; out-of-range parcel ids are dropped.
   */
  static deserialize(jsonBlob: string): LandLayer {
    const layer = new LandLayer({ enabled: true });
    if (typeof jsonBlob !== "string" || !jsonBlob) return layer;
    try {
      const p = JSON.parse(jsonBlob);
      if (!p || typeof p !== "object") return layer;

      if (Array.isArray(p.parcels)) {
        for (const q of p.parcels) {
          if (!q || typeof q !== "object") continue;
          const id = Math.trunc(num(q.id, -1));
          if (!Number.isInteger(id) || id < 0 || id >= LAND_PARCEL_COUNT) continue;
          layer.parcels.set(id, {
            owner: typeof q.owner === "string" ? q.owner : "",
            imageKey: typeof q.imageKey === "string" && q.imageKey ? q.imageKey : `do:${id}`,
            overrides: Math.max(0, Math.trunc(num(q.overrides, 0))),
            purchasedAt: Math.max(0, Math.trunc(num(q.purchasedAt, 0))),
            txHash: typeof q.txHash === "string" ? q.txHash : "",
          });
        }
      }
      if (Array.isArray(p.dedupRing)) {
        layer.dedupRing = p.dedupRing.filter((s: unknown) => typeof s === "string").slice(-DEDUP_RING_SIZE);
      }
      layer.totalBurned = big(p.totalBurned, 0n);
      if (Array.isArray(p.events)) {
        for (const e of p.events.slice(-EVENTS_CAP)) {
          if (!e || typeof e !== "object") continue;
          if (e.kind !== "LAND_SOLD" && e.kind !== "LAND_OVERRIDDEN") continue;
          layer.events.push({
            kind: e.kind,
            parcel: Math.max(0, Math.trunc(num(e.parcel, 0))),
            owner: typeof e.owner === "string" ? e.owner : "",
            price: typeof e.price === "string" ? e.price : "",
            n: Math.max(0, Math.trunc(num(e.n, 0))),
          });
        }
      }
      return layer;
    } catch {
      return layer; // corrupt → cold: a grid restarts empty, never poisoned
    }
  }
}
