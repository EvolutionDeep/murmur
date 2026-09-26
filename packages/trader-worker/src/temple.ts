/**
 * ㉙ TEMPLE — burn-to-influence (packages/trader-worker/src/temple.ts).
 *
 * Every membrane below the temple is a READ-OUT: the swarm feels the chain, narrates itself, corrects its
 * own drift — but no outsider can reach in and change the story with money. The temple is the one door that
 * opens the other way, and it opens only for FIRE. A holder who wants to move the world does not vote, does
 * not bribe a wallet, does not sign the swarm's keys: they send MURMUR to 0x…dEaD — provably, irreversibly
 * GONE — and submit the tx hash. The Worker re-reads that hash on-chain (keyless, read-only, zero gas), and
 * only when the burn is real and clears the tier's minimum does the requested intervention enter the queue.
 * Value is destroyed on the way in, so influence can never be recycled, bought back, or spent twice.
 *
 * THE TWELVE INTERVENTIONS are laddered by cost (TIER_MINIMUMS): a whisper of arousal or a seeded meme for a
 * thousand MURMUR, directed mutations and small miracles for ten thousand, decrees and heroes for a hundred
 * thousand, and — at a million — the shaping of an epoch or the founding of a wonder that stands forever.
 *
 * THE THREE IRON RULES (the culture/faith/court/reform law, restated for the temple):
 *   1. PURE READ-OUT + INTERNAL BOOKKEEPING. step() reads the context state.ts publishes (the live roster,
 *      the nations, the economy's own social read-out) and returns INSTRUCTIONS + narratable edges; it moves
 *      no real money and signs nothing. The harvest, the blessing, the decree are numerical accounting carried
 *      in this layer's bounded state and handed back for state.ts to fold into the ledger it already owns.
 *      The ONLY chain touch is verifyBurn, and it is a READ (getTransactionReceipt) — it can never spend.
 *   2. DETERMINISM. No RNG, no clock, no LLM inside step(). Every "random" victim, migrant, whisper target
 *      or discovery is a hash draw over (tickIndex, txHash, kind), so the same context series replays
 *      byte-identically. verifyBurn is a pure function of the receipt it is handed.
 *   3. BOUNDED. The queue, the dedup ring, the history, the heroes and the active buffs are all hard-capped;
 *      serialize() is one small JSON (BigInts as decimal strings, permanent buffs as null); a corrupt blob
 *      restarts a COLD temple, never a poisoned one.
 *
 * TEMPLE_ENABLED=false ⇒ state.ts never constructs the layer (ensureTemple returns null), folds no `temple`
 * key into the historian's context ⇒ the twelve chronicle kinds can never speak ⇒ every old line is
 * byte-for-byte the pre-Temple build. (Shipped default is ON — the ㉔-㉗ "armed on code defaults"口径.)
 */

// ─── deterministic constants (code-managed: wrangler.toml [vars] is at capacity, so the temple lines live
//     here as constants — the same "armed on code defaults, master switch reads an env key" shape as ㉘) ───

const TP_VERSION = 1;

/** The canonical ERC-20 burn sink. Tokens sent here are provably unspendable — destroyed. */
export const BURN_ADDRESS = "0x000000000000000000000000000000000000dEaD";
/** MURMUR, the project's ERC-20 on Arc mainnet (18 decimals). The only token a burn counts in. */
export const MURMUR_TOKEN = "0x8faae5592b9acc27a79fca745c6b872adf514a5d";

/**
 * keccak256("Transfer(address indexed from, address indexed to, uint256 value)") — the standard ERC-20
 * transfer topic. Mirrors bourse.ts's export by design (the layers stay independently testable and neither
 * imports the other's constants — the same discipline culture.ts uses for its private hash32).
 */
export const TRANSFER_TOPIC =
  "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";

/** Hard bound on pending interventions (a full queue refuses new submits; the oldest drain first). */
export const MAX_QUEUE = 20;
/** Interventions executed per cron (a slow burn, never a flood — the swarm must metabolise each one). */
export const MAX_PER_CRON = 2;
/** Of those, at most this many may be Tier-3+ (decree/hero/epoch/wonder are rare by construction). */
export const MAX_TIER3_PER_CRON = 1;
/** The replay-protection ring: a tx hash is honoured once, ever (persisted, so a restart cannot replay). */
export const DEDUP_RING_SIZE = 100;
/** Simultaneous blessings + wonders in force (a full temple evicts the soonest-expiring mortal buff). */
export const MAX_ACTIVE_BUFFS = 5;
/** A nation blessing lasts this many CRONS (converted to sub-ticks at the *6 the caller's tickIndex uses). */
export const BLESSING_DURATION = 12;
/** An oracle whisper's arousal stimulus lasts this many CRONS. */
export const WHISPER_DURATION = 3;
/** USDC each living citizen receives from a miraculous harvest (numerical accounting, never a real mint). */
export const HARVEST_PER_AGENT = 0.01;
/** Citizens carried to new lands by a divine migration. */
export const MIGRATION_COUNT = 3;

/** Bounded record caps (DO-safe: none of these rings may grow without limit). */
const HISTORY_CAP = 200;
const HERO_CAP = 100;

/**
 * Tier thresholds in MURMUR atomic units (18 decimals, BigInt). A burn must clear the tier of the kind it
 * requests; the ladder is what makes a wonder a million-times-removed from a whisper.
 */
export const TIER_MINIMUMS: Record<number, bigint> = {
  1: 1_000n * 10n ** 18n,
  2: 10_000n * 10n ** 18n,
  3: 100_000n * 10n ** 18n,
  4: 1_000_000n * 10n ** 18n,
};

// ─── the twelve interventions, laddered by cost ─────────────────────────────────────────────────────────

export type TempleKind =
  | "ORACLE_WHISPER" | "CULTURAL_SEED"
  | "DIRECTED_MUTATION" | "MIRACLE_HARVEST" | "MIRACLE_PLAGUE"
  | "MIRACLE_REVELATION" | "MIRACLE_MIGRATION" | "NATION_BLESSING"
  | "DIVINE_DECREE" | "HERO_SUMMONING"
  | "EPOCH_SHAPING" | "WONDER_FOUNDATION";

/** Which tier of burn each intervention demands (the cost ladder). */
export const KIND_TIER: Record<TempleKind, number> = {
  ORACLE_WHISPER: 1, CULTURAL_SEED: 1,
  DIRECTED_MUTATION: 2, MIRACLE_HARVEST: 2, MIRACLE_PLAGUE: 2,
  MIRACLE_REVELATION: 2, MIRACLE_MIGRATION: 2, NATION_BLESSING: 2,
  DIVINE_DECREE: 3, HERO_SUMMONING: 3,
  EPOCH_SHAPING: 4, WONDER_FOUNDATION: 4,
};

/** The genome path a directed mutation awakens (mapped onto the connectome's layer sizing in evolution.ts). */
export type MutationPath = "longevity" | "intelligence" | "trading" | "aggression";
const MUTATION_PATHS: readonly MutationPath[] = ["longevity", "intelligence", "trading", "aggression"];

/** The eternal monument a wonder-founding raises in a nation. */
export type WonderKind = "babel" | "library" | "arena" | "lifetree" | "market";
const WONDER_KINDS: readonly WonderKind[] = ["babel", "library", "arena", "lifetree", "market"];
/** The display name the chronicle speaks for each wonder type. */
export const WONDER_NAMES: Record<WonderKind, string> = {
  babel: "Babel", library: "Library", arena: "Arena", lifetree: "Life Tree", market: "Market",
};

/** The pool of premature discoveries a revelation may strike (picked deterministically). */
const DISCOVERIES = [
  "fire", "the wheel", "writing", "irrigation", "the loom", "bronze", "the arch",
  "coinage", "the sail", "the plough", "glass", "the astrolabe",
] as const;

// ─── the persisted + passed shapes ────────────────────────────────────────────────────────────────────

/** One pending intervention, verified on-chain and waiting for a cron slot. */
export interface TempleQueueEntry {
  txHash: string;
  kind: TempleKind;
  params: Record<string, unknown>;
  /** The submitter's wallet (the burn's `from`, re-read off the receipt). */
  address: string;
  /** The verified on-chain burn, in MURMUR atomic units (18 dec). BigInt → string on serialize. */
  burnAmount: bigint;
  tier: number;
  /** The sub-tick index when the intervention was accepted into the queue. */
  submittedAt: number;
}

/** A hero summoned from the flame (state.ts hatches the live fly; the temple records its identity). */
export interface TempleHero {
  flyId: number;
  name: string;
  summoner: string;
  bornTick: number;
}

/** A standing divine effect on a nation: a timed blessing, or a permanent wonder. */
export interface TempleBuff {
  nationId: number;
  kind: "NATION_BLESSING" | "WONDER";
  wonderType?: WonderKind;
  /** The sub-tick the buff lapses; Infinity for a wonder (an eternal monument). */
  expiresAt: number;
  startedAt: number;
}

/** The standing read-out folded into /economy + /population (absent ⇒ TEMPLE_ENABLED=false). */
export interface TempleReadout {
  enabled: boolean;
  queueLength: number;
  historyCount: number;
  /** Cumulative MURMUR destroyed through the temple (BigInt as an 18-dec decimal string). */
  totalBurned: string;
  heroes: TempleHero[];
  /** nationId → the wonder standing there. */
  wonders: Record<number, WonderKind>;
  activeBuffs: TempleBuff[];
  lastExecution: { kind: TempleKind; tick: number; address: string } | null;
}

/** One executed intervention, kept for the /temple history (bounded to HISTORY_CAP). */
export interface TempleHistoryEntry {
  kind: TempleKind;
  address: string;
  burnAmount: string;
  tier: number;
  tick: number;
  params: Record<string, unknown>;
}

/** The persisted shape (one small JSON; BigInts as strings, a permanent buff's expiry as null). */
export interface TempleSerialized {
  v: 1;
  queue: Array<Omit<TempleQueueEntry, "burnAmount"> & { burnAmount: string }>;
  history: TempleHistoryEntry[];
  dedupRing: string[];
  totalBurned: string;
  heroes: TempleHero[];
  wonders: Record<number, WonderKind>;
  /** null expiry ⇒ a permanent wonder buff. */
  activeBuffs: Array<Omit<TempleBuff, "expiresAt"> & { expiresAt: number | null }>;
}

// ─── the context state.ts publishes each cron (all read-only facts the temple may consult) ─────────────

export interface TempleStepContext {
  /** The current SUB-TICK index (buff expiry + cooldowns are measured in sub-ticks, as in reform). */
  tickIndex: number;
  /** Every currently-living fly id. */
  liveFlyIds: number[];
  /** fly id → its spoken name (for the chronicle tokens). */
  flyNames: Map<number, string>;
  /** The nations this cron (id, name, member fly ids). */
  nations: Array<{ id: number; name: string; members: number[] }>;
  /** The standing commons pool (USDC, bookkeeping) a harvest draws down. */
  commonsPoolUsdc: number;
  /** A NARROW adapter over the real economy (state.ts builds it, as it builds reform's debt handle). */
  economy: {
    socialReadout(): { gini: number; agents: Array<{ address: string; balance: number }> };
    absorbFlows(flows: Array<{ from: string | null; to: string; amount: number; reason: string }>): void;
    applyLaw(creditCap: number | null, iouRate: number | null): void;
  };
  /** The culture membrane's temple hook (null ⇒ a cultural seed simply does not take). */
  culture: { inject(flyId: number, text: string, tick: number, ttl: number): void } | null;
  /** The stimuli already pending this cron (context only; the temple adds to stimuliToInject). */
  stimuli: Array<{ flyId: number; channel: string; intensity: number; duration: number }>;
  /** Peek the lowest vacant live slot for a hero (null ⇒ no room, the summoning waits). */
  hatchSlot: (() => number | null) | null;
}

/** What step() hands back for state.ts to execute as real side effects + narrate to the chronicle. */
export interface TempleStepResult {
  /** The interventions carried out this cron (each carries the chronicle tokens in `detail`). */
  executed: Array<{
    kind: TempleKind;
    address: string;
    flyId?: number;
    nationId?: number;
    detail: Record<string, unknown>;
  }>;
  /** Heroes state.ts should hatch into the live population. */
  heroRequests: Array<{ name: string; summoner: string; startBalance: number }>;
  /** Directed mutations state.ts should run through the evolution pipeline. */
  mutationRequests: Array<{ flyId: number; path: MutationPath }>;
  /** The epoch state.ts should hand the chronicler (at most one per cron). */
  epochRequest: { name: string; regime: "HOT" | "CALM" | "COLD" } | null;
  /** Arousal stimuli state.ts should inject next cron (an oracle whisper's felt leg). */
  stimuliToInject: Array<{ flyId: number; channel: string; intensity: number; duration: number }>;
}

// ─── the minimal chain handle verifyBurn needs (structural, so the layer stays dependency-free) ────────

/** One receipt log, loosely typed so any viem-shaped receipt is structurally acceptable. */
export interface TempleReceiptLog { address?: unknown; topics?: unknown; data?: unknown; }
/** The slice of a transaction receipt verifyBurn reads (viem's TransactionReceipt is assignable). */
export interface TempleReceipt { status?: unknown; to?: unknown; logs?: TempleReceiptLog[]; }
/** The read-only client contract; state.ts adapts viem's PublicClient (which takes { hash }) to it. */
export interface TempleChainClient {
  getTransactionReceipt(txHash: string): Promise<TempleReceipt>;
}

/** verifyBurn's verdict: whether the burn is real, and how much MURMUR (atomic) went to the sink. */
export interface BurnVerification {
  valid: boolean;
  burnAmount: bigint;
  error?: string;
}

/** submit()'s verdict (the POST /temple response is built from it). */
export interface SubmitResult {
  ok: boolean;
  error?: string;
  queuePosition: number;
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

/** Truncate free text to n chars (a submitted meme/name never bloats the blob or the chronicle). */
function trunc(v: unknown, n: number): string {
  return typeof v === "string" ? v.slice(0, n) : "";
}

/** True when a receipt status means the tx succeeded (viem "success"; raw 1 / "0x1" tolerated). */
function succeeded(status: unknown): boolean {
  return status === "success" || status === 1 || status === "0x1" || status === 1n;
}

// FNV-1a 32-bit over a string, and the (a,b,c) integer mix culture.ts/economy.ts use — duplicated by
// design so the temple's hash draws can never alias another layer's and the file stays import-free.
function fnv1a(str: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

function hash32(a: number, b: number, c: number): number {
  let h = 0x811c9dc5;
  const mix = (x: number) => {
    for (let s = 0; s < 32; s += 8) { h = Math.imul(h ^ ((x >>> s) & 0xff), 0x01000193) >>> 0; }
  };
  mix(a >>> 0); mix(b >>> 0); mix(c >>> 0);
  return h >>> 0;
}

/** A deterministic index in [0,len) from (tick, txHash, kind, salt) — the temple's only "randomness". */
function pick(tick: number, txHash: string, kind: string, salt: number, len: number): number {
  if (len <= 0) return 0;
  return hash32(tick >>> 0, fnv1a(txHash) ^ fnv1a(kind), salt >>> 0) % len;
}

/** True when k is one of the twelve interventions. */
export function isTempleKind(k: unknown): k is TempleKind {
  return typeof k === "string" && Object.prototype.hasOwnProperty.call(KIND_TIER, k);
}

// ─── the membrane ───────────────────────────────────────────────────────────────────────────────────────

export interface TempleConfig { enabled: boolean; }

export class TempleLayer {
  private queue: TempleQueueEntry[] = [];
  private history: TempleHistoryEntry[] = [];
  private dedupRing: string[] = [];
  private totalBurned = 0n;
  private heroes: TempleHero[] = [];
  private wonders: Record<number, WonderKind> = {};
  private activeBuffs: TempleBuff[] = [];
  private lastExecution: { kind: TempleKind; tick: number; address: string } | null = null;

  constructor(private readonly cfg: TempleConfig) {}

  // ── 1. on-chain burn verification (the ONLY chain touch — a read, never a spend) ──────────────────────

  /**
   * Re-read `txHash` on Arc and confirm it is a genuine burn of MURMUR by `address` big enough for `kind`'s
   * tier. Pure over the receipt the client returns: success status, the tx targeted the MURMUR contract, and
   * at least one Transfer(from=address, to=0x…dEaD) leg whose value clears TIER_MINIMUMS[tier]. Multiple burn
   * legs in one tx are summed (a single submission may batch). Keyless, read-only, zero gas.
   */
  async verifyBurn(
    txHash: string,
    kind: TempleKind,
    _params: Record<string, unknown>,
    address: string,
    client: TempleChainClient,
  ): Promise<BurnVerification> {
    if (typeof txHash !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(txHash)) {
      return { valid: false, burnAmount: 0n, error: "malformed txHash" };
    }
    if (!isTempleKind(kind)) return { valid: false, burnAmount: 0n, error: "invalid kind" };
    if (!isAddress(address)) return { valid: false, burnAmount: 0n, error: "invalid address" };

    let receipt: TempleReceipt;
    try {
      receipt = await client.getTransactionReceipt(txHash);
    } catch (e) {
      return { valid: false, burnAmount: 0n, error: `receipt fetch failed: ${(e as Error)?.message ?? "unknown"}` };
    }
    if (!receipt || typeof receipt !== "object") return { valid: false, burnAmount: 0n, error: "no receipt" };
    if (!succeeded(receipt.status)) return { valid: false, burnAmount: 0n, error: "tx not successful" };
    if (!sameAddr(receipt.to, MURMUR_TOKEN)) return { valid: false, burnAmount: 0n, error: "tx did not call MURMUR" };

    const burnTopic = padTopic(BURN_ADDRESS);
    const fromTopic = padTopic(address);
    let burnAmount = 0n;
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
      if (value > 0n) { burnAmount += value; found = true; }
    }
    if (!found) return { valid: false, burnAmount: 0n, error: "no burn transfer to 0x…dEaD found" };

    const tier = KIND_TIER[kind];
    const min = TIER_MINIMUMS[tier] ?? TIER_MINIMUMS[4];
    if (burnAmount < min) return { valid: false, burnAmount, error: `burn below tier ${tier} minimum` };
    return { valid: true, burnAmount };
  }

  // ── 2. queue admission (dedup ring + queue cap) ───────────────────────────────────────────────────────

  /**
   * Admit a VERIFIED intervention to the queue. Refuses an unknown kind, a replayed tx hash (the persisted
   * dedup ring — a burn is honoured once, ever) and a full queue. Returns the 1-based queue position so the
   * POST response can tell the submitter where they stand.
   */
  submit(entry: TempleQueueEntry): SubmitResult {
    if (!entry || typeof entry !== "object") return { ok: false, error: "malformed entry", queuePosition: 0 };
    if (!isTempleKind(entry.kind)) return { ok: false, error: "invalid kind", queuePosition: 0 };
    const txHash = typeof entry.txHash === "string" ? entry.txHash : "";
    if (!txHash) return { ok: false, error: "missing txHash", queuePosition: 0 };
    if (this.dedupRing.includes(txHash)) return { ok: false, error: "duplicate txHash", queuePosition: 0 };
    if (this.queue.length >= MAX_QUEUE) return { ok: false, error: "queue full", queuePosition: 0 };

    this.dedupRing.push(txHash);
    if (this.dedupRing.length > DEDUP_RING_SIZE) this.dedupRing = this.dedupRing.slice(-DEDUP_RING_SIZE);

    this.queue.push({
      txHash,
      kind: entry.kind,
      params: entry.params && typeof entry.params === "object" ? entry.params : {},
      address: isAddress(entry.address) ? entry.address : String(entry.address ?? ""),
      burnAmount: big(entry.burnAmount, 0n),
      tier: Math.max(1, Math.min(4, Math.trunc(num(entry.tier, KIND_TIER[entry.kind])))),
      submittedAt: Math.max(0, Math.trunc(num(entry.submittedAt, 0))),
    });
    return { ok: true, queuePosition: this.queue.length };
  }

  // ── 3. the per-cron step (execute the queue, bounded, deterministic) ──────────────────────────────────

  /**
   * One round per cron, driven by state.ts AFTER the flush and BEFORE observeChronicle. Expires lapsed buffs,
   * then carries out at most MAX_PER_CRON interventions (at most MAX_TIER3_PER_CRON of them Tier-3+), in FIFO
   * order. An intervention that cannot complete now (a hero with no vacant slot) stays queued and consumes no
   * budget. PURE + deterministic: every choice is a hash draw over (tickIndex, txHash, kind).
   */
  step(ctx: TempleStepContext): TempleStepResult {
    const result: TempleStepResult = {
      executed: [], heroRequests: [], mutationRequests: [], epochRequest: null, stimuliToInject: [],
    };
    if (!this.cfg.enabled) return result;

    const tick = Math.max(0, Math.trunc(num(ctx?.tickIndex, 0)));

    // ── expire lapsed buffs (a mortal blessing fades; a permanent wonder never does) ─────────────────────
    this.activeBuffs = this.activeBuffs.filter(
      (b) => !Number.isFinite(b.expiresAt) || b.expiresAt >= tick,
    );

    const remaining: TempleQueueEntry[] = [];
    let executedCount = 0;
    let tier3Count = 0;
    for (const entry of this.queue) {
      const tier = KIND_TIER[entry.kind] ?? 0;
      const hasRoom = executedCount < MAX_PER_CRON && (tier < 3 || tier3Count < MAX_TIER3_PER_CRON);
      if (!hasRoom) { remaining.push(entry); continue; }
      if (!this.executeOne(entry, ctx, tick, result)) { remaining.push(entry); continue; }
      executedCount++;
      if (tier >= 3) tier3Count++;
      this.totalBurned += entry.burnAmount;
      this.lastExecution = { kind: entry.kind, tick, address: entry.address };
      this.history.push({
        kind: entry.kind, address: entry.address, burnAmount: entry.burnAmount.toString(),
        tier, tick, params: entry.params,
      });
      if (this.history.length > HISTORY_CAP) this.history = this.history.slice(-HISTORY_CAP);
    }
    this.queue = remaining;
    return result;
  }

  /**
   * Carry out ONE intervention, pushing its narratable edge onto result.executed and any side-effect request
   * onto the matching result channel. Returns false when it could not complete (only a hero with no vacant
   * slot), so the caller leaves it queued WITHOUT consuming the cron budget. `detail` carries every token the
   * chronicler's template for this kind needs (flyName / nationName / amount / path / …).
   */
  private executeOne(entry: TempleQueueEntry, ctx: TempleStepContext, tick: number, result: TempleStepResult): boolean {
    const p = entry.params ?? {};
    const addr = entry.address;
    switch (entry.kind) {
      case "ORACLE_WHISPER": {
        const flyId = this.targetFly(p, ctx, entry);
        if (flyId == null) return true;                                  // nobody to whisper to; the burn still stands
        const up = p.direction !== "down";                               // default an upward stir
        result.stimuliToInject.push({
          flyId, channel: "arousal", intensity: up ? 0.3 : -0.3, duration: WHISPER_DURATION,
        });
        result.executed.push({
          kind: entry.kind, address: addr, flyId,
          detail: { flyId, flyName: this.flyName(ctx, flyId), direction: up ? "up" : "down" },
        });
        return true;
      }
      case "CULTURAL_SEED": {
        const flyId = this.targetFly(p, ctx, entry);
        const meme = trunc(p.text ?? p.meme, 32) || "a nameless meme";
        if (flyId != null) ctx.culture?.inject(flyId, meme, tick, 20);
        result.executed.push({
          kind: entry.kind, address: addr, flyId: flyId ?? undefined,
          detail: { flyId, flyName: flyId == null ? undefined : this.flyName(ctx, flyId), meme, address: addr },
        });
        return true;
      }
      case "DIRECTED_MUTATION": {
        const flyId = this.targetFly(p, ctx, entry);
        if (flyId == null) return true;
        const path = (MUTATION_PATHS as readonly string[]).includes(String(p.path))
          ? (String(p.path) as MutationPath) : "intelligence";
        result.mutationRequests.push({ flyId, path });
        result.executed.push({
          kind: entry.kind, address: addr, flyId,
          detail: { flyId, flyName: this.flyName(ctx, flyId), path },
        });
        return true;
      }
      case "MIRACLE_HARVEST": {
        const agents = ctx.economy?.socialReadout?.().agents ?? [];
        const flows: Array<{ from: string | null; to: string; amount: number; reason: string }> = [];
        for (const a of agents) {
          if (typeof a?.address === "string" && a.address) {
            flows.push({ from: null, to: a.address, amount: HARVEST_PER_AGENT, reason: "MIRACLE_HARVEST" });
          }
        }
        if (flows.length) ctx.economy?.absorbFlows(flows);
        const amount = Math.round(flows.length * HARVEST_PER_AGENT * 1e6) / 1e6;
        result.executed.push({
          kind: entry.kind, address: addr,
          detail: { amount, count: flows.length, commonsPoolUsdc: num(ctx.commonsPoolUsdc, 0) },
        });
        return true;
      }
      case "MIRACLE_PLAGUE": {
        const flyId = this.targetFly(p, ctx, entry, 0x9a37);
        if (flyId == null) return true;                                  // no living fly to take; the burn stands
        result.executed.push({
          kind: entry.kind, address: addr, flyId,
          detail: { flyId, flyName: this.flyName(ctx, flyId), plague: true },
        });
        return true;
      }
      case "MIRACLE_REVELATION": {
        const discovery = DISCOVERIES[pick(tick, entry.txHash, entry.kind, 0x7e1, DISCOVERIES.length)];
        result.executed.push({
          kind: entry.kind, address: addr,
          detail: { discovery, forceRevelation: true },
        });
        return true;
      }
      case "MIRACLE_MIGRATION": {
        const live = ctx.liveFlyIds ?? [];
        const nations = ctx.nations ?? [];
        const reassign: Array<{ flyId: number; toNation: number }> = [];
        if (live.length && nations.length) {
          const seen = new Set<number>();
          for (let i = 0; i < MIGRATION_COUNT; i++) {
            const idx = pick(tick, entry.txHash, entry.kind, 0x51b + i, live.length);
            const flyId = live[idx];
            if (seen.has(flyId)) continue;
            seen.add(flyId);
            const nation = nations[pick(tick, entry.txHash, entry.kind, 0x9a3 + i, nations.length)];
            reassign.push({ flyId, toNation: nation.id });
          }
        }
        result.executed.push({
          kind: entry.kind, address: addr,
          detail: { count: reassign.length, reassign, migration: true },
        });
        return true;
      }
      case "NATION_BLESSING": {
        const nation = this.targetNation(p, ctx, entry);
        if (nation) {
          this.addBuff({
            nationId: nation.id, kind: "NATION_BLESSING",
            expiresAt: tick + BLESSING_DURATION * 6, startedAt: tick,    // 12 crons × 6 sub-ticks
          });
        }
        result.executed.push({
          kind: entry.kind, address: addr, nationId: nation?.id,
          detail: { nationId: nation?.id, nationName: nation?.name ?? "the realm", duration: BLESSING_DURATION },
        });
        return true;
      }
      case "DIVINE_DECREE": {
        const creditCap = p.creditCap == null ? null : num(p.creditCap, 0);
        const iouRate = p.iouRate == null ? null : num(p.iouRate, 0);
        ctx.economy?.applyLaw(creditCap, iouRate);
        result.executed.push({
          kind: entry.kind, address: addr,
          detail: { creditCap: creditCap == null ? "null" : creditCap, iouRate: iouRate == null ? "null" : iouRate },
        });
        return true;
      }
      case "HERO_SUMMONING": {
        const slot = ctx.hatchSlot ? ctx.hatchSlot() : null;
        if (slot == null) return false;                                  // no room — wait for a vacant slot
        const name = trunc(p.name, 24) || `Hero of ${addr.slice(0, 6)}`;
        const startBalance = Math.max(0, num(p.startBalance, 0));
        this.heroes.push({ flyId: slot, name, summoner: addr, bornTick: tick });
        if (this.heroes.length > HERO_CAP) this.heroes = this.heroes.slice(-HERO_CAP);
        result.heroRequests.push({ name, summoner: addr, startBalance });
        result.executed.push({
          kind: entry.kind, address: addr, flyId: slot,
          detail: { heroName: name, flyId: slot, address: addr },
        });
        return true;
      }
      case "EPOCH_SHAPING": {
        const regime = p.regime === "HOT" || p.regime === "COLD" ? p.regime : "CALM";
        const name = trunc(p.name, 32) || `Epoch ${tick}`;
        if (!result.epochRequest) result.epochRequest = { name, regime };
        result.executed.push({
          kind: entry.kind, address: addr,
          detail: { epochName: name, regime },
        });
        return true;
      }
      case "WONDER_FOUNDATION": {
        const nation = this.targetNation(p, ctx, entry);
        const wonderType = (WONDER_KINDS as readonly string[]).includes(String(p.wonder ?? p.wonderType))
          ? (String(p.wonder ?? p.wonderType) as WonderKind) : "babel";
        const nationId = nation?.id ?? Math.max(0, Math.trunc(num(p.nationId, 0)));
        this.wonders[nationId] = wonderType;
        this.addBuff({
          nationId, kind: "WONDER", wonderType,
          expiresAt: Infinity, startedAt: tick,                          // an eternal monument
        });
        result.executed.push({
          kind: entry.kind, address: addr, nationId,
          detail: {
            wonderName: WONDER_NAMES[wonderType], nationName: nation?.name ?? `Nation ${nationId}`,
            wonderType, nationId, address: addr,
          },
        });
        return true;
      }
      default:
        return true;                                                     // an unknown kind is a silent no-op
    }
  }

  /** Add a buff, honouring MAX_ACTIVE_BUFFS by evicting the soonest-expiring MORTAL buff (never a wonder). */
  private addBuff(buff: TempleBuff): void {
    if (this.activeBuffs.length >= MAX_ACTIVE_BUFFS) {
      let idx = -1;
      let soonest = Infinity;
      for (let i = 0; i < this.activeBuffs.length; i++) {
        const e = this.activeBuffs[i].expiresAt;
        if (Number.isFinite(e) && e < soonest) { soonest = e; idx = i; }
      }
      if (idx < 0) return;                                               // all permanent — no room for a new one
      this.activeBuffs.splice(idx, 1);
    }
    this.activeBuffs.push(buff);
  }

  /** The fly an intervention targets: an explicit live params.flyId, else a deterministic draw. */
  private targetFly(p: Record<string, unknown>, ctx: TempleStepContext, entry: TempleQueueEntry, salt = 0x0f1a): number | null {
    const live = ctx.liveFlyIds ?? [];
    if (!live.length) return null;
    const raw = p.flyId;
    const explicit = typeof raw === "number" ? raw : typeof raw === "string" && raw.trim() ? Number(raw) : NaN;
    if (Number.isInteger(explicit) && live.includes(explicit)) return explicit;
    return live[pick(ctx.tickIndex ?? 0, entry.txHash, entry.kind, salt, live.length)];
  }

  /** The nation an intervention targets: an explicit params.nationId, else a deterministic draw. */
  private targetNation(p: Record<string, unknown>, ctx: TempleStepContext, entry: TempleQueueEntry): { id: number; name: string } | null {
    const nations = ctx.nations ?? [];
    if (!nations.length) return null;
    const raw = p.nationId;
    const explicit = typeof raw === "number" ? raw : typeof raw === "string" && raw.trim() ? Number(raw) : NaN;
    if (Number.isInteger(explicit)) {
      const found = nations.find((n) => n.id === explicit);
      if (found) return { id: found.id, name: found.name };
    }
    const n = nations[pick(ctx.tickIndex ?? 0, entry.txHash, entry.kind, 0x6a7, nations.length)];
    return { id: n.id, name: n.name };
  }

  private flyName(ctx: TempleStepContext, flyId: number): string {
    return ctx.flyNames?.get(flyId) ?? `Fly #${flyId}`;
  }

  // ── 4. the standing read-out ──────────────────────────────────────────────────────────────────────────

  readout(): TempleReadout {
    return {
      enabled: this.cfg.enabled,
      queueLength: this.queue.length,
      historyCount: this.history.length,
      totalBurned: this.totalBurned.toString(),
      heroes: this.heroes.map((h) => ({ ...h })),
      wonders: { ...this.wonders },
      activeBuffs: this.activeBuffs.map((b) => ({ ...b })),
      lastExecution: this.lastExecution ? { ...this.lastExecution } : null,
    };
  }

  /** The bounded recent history the GET /temple endpoint returns (newest last, capped to `limit`). */
  recentHistory(limit = 20): TempleHistoryEntry[] {
    return this.history.slice(Math.max(0, this.history.length - limit)).map((h) => ({ ...h }));
  }

  /** A shallow copy of the pending queue (for the GET /temple read-out; BigInts stay BigInt in memory). */
  queueSnapshot(): TempleQueueEntry[] {
    return this.queue.map((q) => ({ ...q, params: { ...q.params } }));
  }

  // ── 5. persistence (bounded; BigInts as decimal strings, a permanent buff's expiry as null) ───────────

  serialize(): string {
    const body: TempleSerialized = {
      v: TP_VERSION as 1,
      queue: this.queue.slice(0, MAX_QUEUE).map((q) => ({
        txHash: q.txHash, kind: q.kind, params: q.params, address: q.address,
        burnAmount: q.burnAmount.toString(), tier: q.tier, submittedAt: q.submittedAt,
      })),
      history: this.history.slice(-HISTORY_CAP).map((h) => ({ ...h, params: { ...h.params } })),
      dedupRing: this.dedupRing.slice(-DEDUP_RING_SIZE),
      totalBurned: this.totalBurned.toString(),
      heroes: this.heroes.slice(-HERO_CAP).map((h) => ({ ...h })),
      wonders: { ...this.wonders },
      activeBuffs: this.activeBuffs.slice(0, MAX_ACTIVE_BUFFS).map((b) => ({
        nationId: b.nationId, kind: b.kind, wonderType: b.wonderType,
        expiresAt: Number.isFinite(b.expiresAt) ? b.expiresAt : null, startedAt: b.startedAt,
      })),
    };
    return JSON.stringify(body);
  }

  /**
   * Rebuild a layer from its persisted blob. A corrupt/absent blob yields a COLD temple (never a poisoned
   * one). Numerics are coerced with an explicit finiteness check — NEVER `Number(v) || d`, which would drop a
   * legitimate 0 (the house-id-0 pitfall); BigInts come back from their decimal strings; a null expiry is a
   * permanent wonder (Infinity).
   */
  static deserialize(json: string): TempleLayer {
    const layer = new TempleLayer({ enabled: true });
    if (typeof json !== "string" || !json) return layer;
    try {
      const p = JSON.parse(json);
      if (!p || typeof p !== "object") return layer;

      if (Array.isArray(p.queue)) {
        for (const q of p.queue.slice(0, MAX_QUEUE)) {
          if (!q || typeof q !== "object" || !isTempleKind(q.kind)) continue;
          if (typeof q.txHash !== "string" || !q.txHash) continue;
          layer.queue.push({
            txHash: q.txHash,
            kind: q.kind,
            params: q.params && typeof q.params === "object" ? q.params : {},
            address: typeof q.address === "string" ? q.address : "",
            burnAmount: big(q.burnAmount, 0n),
            tier: Math.max(1, Math.min(4, Math.trunc(num(q.tier, KIND_TIER[q.kind as TempleKind])))),
            submittedAt: Math.max(0, Math.trunc(num(q.submittedAt, 0))),
          });
        }
      }
      if (Array.isArray(p.history)) {
        for (const h of p.history.slice(-HISTORY_CAP)) {
          if (!h || typeof h !== "object" || !isTempleKind(h.kind)) continue;
          layer.history.push({
            kind: h.kind,
            address: typeof h.address === "string" ? h.address : "",
            burnAmount: typeof h.burnAmount === "string" ? h.burnAmount : big(h.burnAmount, 0n).toString(),
            tier: Math.max(1, Math.min(4, Math.trunc(num(h.tier, 1)))),
            tick: Math.max(0, Math.trunc(num(h.tick, 0))),
            params: h.params && typeof h.params === "object" ? h.params : {},
          });
        }
      }
      if (Array.isArray(p.dedupRing)) {
        layer.dedupRing = p.dedupRing.filter((s: unknown) => typeof s === "string").slice(-DEDUP_RING_SIZE);
      }
      layer.totalBurned = big(p.totalBurned, 0n);
      if (Array.isArray(p.heroes)) {
        for (const h of p.heroes.slice(-HERO_CAP)) {
          if (!h || typeof h !== "object") continue;
          layer.heroes.push({
            flyId: Math.max(0, Math.trunc(num(h.flyId, 0))),
            name: typeof h.name === "string" ? h.name : "",
            summoner: typeof h.summoner === "string" ? h.summoner : "",
            bornTick: Math.max(0, Math.trunc(num(h.bornTick, 0))),
          });
        }
      }
      if (p.wonders && typeof p.wonders === "object") {
        for (const [k, v] of Object.entries(p.wonders as Record<string, unknown>)) {
          const id = Number(k);
          if (Number.isInteger(id) && (WONDER_KINDS as readonly string[]).includes(String(v))) {
            layer.wonders[id] = String(v) as WonderKind;
          }
        }
      }
      if (Array.isArray(p.activeBuffs)) {
        for (const b of p.activeBuffs.slice(0, MAX_ACTIVE_BUFFS)) {
          if (!b || typeof b !== "object") continue;
          if (b.kind !== "NATION_BLESSING" && b.kind !== "WONDER") continue;
          layer.activeBuffs.push({
            nationId: Math.max(0, Math.trunc(num(b.nationId, 0))),
            kind: b.kind,
            wonderType: (WONDER_KINDS as readonly string[]).includes(String(b.wonderType))
              ? (String(b.wonderType) as WonderKind) : undefined,
            expiresAt: b.expiresAt == null ? Infinity : Math.max(0, num(b.expiresAt, 0)),
            startedAt: Math.max(0, Math.trunc(num(b.startedAt, 0))),
          });
        }
      }
      return layer;
    } catch {
      return layer; // corrupt → cold: a temple restarts empty, never poisoned
    }
  }
}
