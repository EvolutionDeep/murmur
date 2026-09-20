// INSTITUTIONS ① — deterministic aggregate LIMIT BOOKS (the market-structure half of layer ⑥).
//
// Today's pricing is a formula: every deal pays basePrice×(0.5+T)×(0.6+0.6·arousal)×mult. A formula is
// a walrasian auctioneer, not a market. This file replaces it with the machinery real venues have: a
// per-good LADDER OF resting limit interest — sellers stack offers around the fair center, buyers
// stack bids under it, the tape prints where a buyer crosses the book, and the mark is the midpoint.
// Spreads widen when the swarm's valence disperses (panic = thinner, wider book) — the mechanism that
// turns a nervous herd into a price collapse without a single line of neural code changing.
//
// WHAT THIS IS NOT: a persistent matching engine. Orders never survive the tick — each cron sub-tick
// rebuilds the book from that tick's readings, and only the resulting MARK SEQUENCE persists (cap 60).
// This is price DISCOVERY as an institution (spread, depth, crossing), not HFT; DO state stays bounded.
//
// THE ONE-WAY LAW HOLDS: the book is a pure downstream read of (valence, arousal, rest) — behaviour
// decodes into intent, intent stacks into interest, interest prices into deals. Money still moves
// ONLY through the existing x402/netting rails between two flies; the book never touches a wallet,
// and INSTITUTIONS_ENABLED=false leaves dealAmount byte-for-byte on the old fixed formula.

import type { FlyReading } from "./population.js";

/** Ladder rungs per side — a bounded 4×2 book per good (DO-safe by construction). */
export const BOOK_LEVELS = 4;
/** How many marks per good the tape keeps (the frontend's price line). */
export const MARK_CAP = 60;
/** Base rung spacing: 5% of center per level, widened by the panic factor below. */
export const LADDER_STEP = 0.05;

export interface BookLevelView {
  price: string;   // atomic USDC
  qty: number;     // resting orders (fly count), drains as buyers cross this tick
}

/** One good's full book view (chronicle + frontend read-out; prices, never money). */
export interface GoodBookView {
  good: string;
  centerAtomic: string;      // the formula fair value the ladder is built around
  bids: BookLevelView[];     // best (nearest center) first
  asks: BookLevelView[];     // best first
  markAtomic: string;        // midpoint of the best resting prices
  spreadBoost: number;       // 0..1 — how far the |valence| dispersion pushed rung spacing above 5%
}

interface LiveBook {
  center: number;
  step: number;              // per-rung spacing already boosted for this tick's dispersion
  asks: { price: number; qty: number }[];
  bids: { price: number; qty: number }[];
  askIdx: number;            // first ask rung with depth left (the tape walks up as buyers cross)
  mark: number;
  spreadBoost: number;
}

/**
 * The tick-live order books. Owned by AgentEconomy; rebuilt per sub-tick via build(), consulted per
 * deal via eatAsk(). Every number is a deterministic function of the readings fed in — no RNG, no
 * clock — so a replay of the same reading sequence reproduces the same tape exactly.
 */
export class MarketBooks {
  private books = new Map<string, LiveBook>();
  private marks = new Map<string, string[]>();

  /**
   * Rebuild `good`'s book from THIS tick's readings around the formula center (atomic USDC).
   * Seller will w = clamp01(−valence/2 + (1−arousal)·0.4 + rest·0.3): a negative-valence, calm,
   * rested fly parts with goods gladly; the mirror formula stacks bids. The strongest willings rest
   * nearest the center (best prices), the reluctant ones stack rungs out — so depth AND slope are
   * behavioural facts. Rung spacing = 5% × (1 + spreadBoost); spreadBoost is the swarm's |valence|
   * dispersion, i.e. panic widens every spread at once, exactly like a real flight to safety.
   * `boostMul` lets the credit-RUN double the whole panic bonus in one sweep (⑥-B).
   */
  build(good: string, centerAtomic: number, readings: readonly FlyReading[], boostMul = 1): GoodBookView {
    const av = readings.map((r) => Math.abs(r.valence));
    let disp = 0;
    if (av.length > 1) {
      const mean = av.reduce((s, x) => s + x, 0) / av.length;
      disp = Math.sqrt(av.reduce((s, x) => s + (x - mean) * (x - mean), 0) / av.length);
    }
    const spreadBoost = clamp01(disp * 2);
    const step = LADDER_STEP * (1 + spreadBoost * Math.max(1, boostMul));
    const asks = Array.from({ length: BOOK_LEVELS }, (_, k) => ({
      price: Math.max(1, Math.round(centerAtomic * (1 + step * (k + 1)))), qty: 0,
    }));
    const bids = Array.from({ length: BOOK_LEVELS }, (_, k) => ({
      price: Math.max(1, Math.round(centerAtomic * (1 - step * (k + 1)))), qty: 0,
    }));
    for (const r of readings) {
      const sellW = clamp01(-r.valence * 0.5 + (1 - clamp01(r.arousal)) * 0.4 + clamp01(r.rest) * 0.3);
      const buyW = clamp01(r.valence * 0.5 + clamp01(r.arousal) * 0.4 + (1 - clamp01(r.rest)) * 0.3);
      // Willingness bucket 3 (eagerest) rests at rung 0 (the best price); reluctant orders sit out the ladder.
      const aRung = BOOK_LEVELS - 1 - bucket(sellW);
      const bRung = BOOK_LEVELS - 1 - bucket(buyW);
      asks[aRung].qty++;
      bids[bRung].qty++;
    }
    // Mark: midpoint of the best RESTING prices (empty side falls back to its rung 0 quote — the
    // ladder's edge is still a price even with nobody on it).
    const bestAsk = asks.find((l) => l.qty > 0)?.price ?? asks[0].price;
    const bestBid = bids.find((l) => l.qty > 0)?.price ?? bids[0].price;
    const mark = Math.max(1, Math.round((bestAsk + bestBid) / 2));
    this.books.set(good, { center: centerAtomic, step, asks, bids, askIdx: 0, mark, spreadBoost });
    const tape = this.marks.get(good) ?? [];
    tape.push(String(mark));
    if (tape.length > MARK_CAP) tape.shift();
    this.marks.set(good, tape);
    return this.viewOf(good)!;
  }

  /**
   * A buyer crosses the book: pays the first ask rung still holding depth (and drains one order
   * from it — the next crossing buyer pushes to the next rung UP, the tape walking the ladder).
   * A fully-drained book prints a sweep: one rung beyond the top, the price a real market shows
   * when the herd eats everything offered. Returns null when no book was built this tick ⇒ the
   * caller falls back to the fixed formula (the OFF path, unchanged).
   */
  eatAsk(good: string): string | null {
    const b = this.books.get(good);
    if (!b) return null;
    while (b.askIdx < BOOK_LEVELS && b.asks[b.askIdx].qty <= 0) b.askIdx++;
    if (b.askIdx < BOOK_LEVELS) {
      const rung = b.asks[b.askIdx];
      rung.qty--;
      return String(rung.price);
    }
    return String(Math.max(1, Math.round(b.center * (1 + b.step * (BOOK_LEVELS + 1)))));
  }

  /** The mark tape for a good (oldest → newest, ≤ MARK_CAP) — the frontend's price line. */
  marksOf(good: string): string[] {
    return this.marks.get(good) ?? [];
  }

  /** This tick's full book views for every built good (read-out only). */
  views(): GoodBookView[] {
    return Array.from(this.books.keys()).sort().map((g) => this.viewOf(g)!);
  }

  /** Reload the persisted mark tapes after a DO eviction (prices only — orders never survive). */
  restoreMarks(data: Record<string, unknown>): void {
    this.marks.clear();
    for (const [good, tape] of Object.entries(data)) {
      if (!Array.isArray(tape)) continue;
      const clean = tape.map((x) => String(x)).filter((x) => /^[0-9]+$/.test(x)).slice(-MARK_CAP);
      if (clean.length) this.marks.set(good, clean);
    }
  }

  private viewOf(good: string): GoodBookView | null {
    const b = this.books.get(good);
    if (!b) return null;
    return {
      good,
      centerAtomic: String(b.center),
      bids: b.bids.map((l) => ({ price: String(l.price), qty: l.qty })),
      asks: b.asks.map((l) => ({ price: String(l.price), qty: l.qty })),
      markAtomic: String(b.mark),
      spreadBoost: b.spreadBoost,
    };
  }
}

/** Willingness 0..1 → rung 0..3 (3 = the eagerest, which build() mirrors onto the BEST price). */
function bucket(w: number): number {
  return Math.min(BOOK_LEVELS - 1, Math.floor(w * BOOK_LEVELS));
}

function clamp01(x: number): number {
  return x < 0 ? 0 : x > 1 ? 1 : x;
}
