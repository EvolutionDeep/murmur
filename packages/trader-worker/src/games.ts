/**
 * ㉑ THE GAMES — the era-heralded athletic festival: opening, champion, record (packages/trader-worker/src/games.ts).
 *
 * ⑳ gave the swarm a court; a society is more than its docket — it also stops to cheer. The Games read ONLY
 * facts the other membranes already recorded: the historian's era bell (every new era may OPEN a festival by
 * hash draw), the living roster (the competitor pool), the dynasty's dominant house (the venue), and each
 * fly's OWN lifetime settlements (deals+sales, the economy's ledger) as the "mark" the stadium keeps. When a
 * crowned champion beats the standing mark, the record falls — the games begin to keep their own history.
 *
 * THE THREE IRON RULES (the culture/faith/workshop/court law, restated):
 *   1. PURE READ-OUT. The Games MOVE NO MONEY and never touch a connectome, genome, fingerprint or manifest
 *      hash. The "stadium" is a line on this membrane's own bounded state; the economy prices nothing by it.
 *   2. DETERMINISM. No RNG, no clock, no LLM. The opening draw, the event, the winner and the record are all
 *      hash draws over (era, flyId, salt) plus the ledger's own deal counts — re-derivable by any visitor.
 *   3. BOUNDED. ≤ GAMES_SEEN_ERAS festival eras remembered, one live opening, one standing mark; serialize()
 *      is a small JSON, restore() clamps every array. A corrupt blob restarts an empty stadium.
 *
 * GAMES_ENABLED=false ⇒ state.ts never constructs the membrane (ensureGames returns null), folds no `games`
 * key into the historian's context ⇒ the three new chronicle kinds can never speak ⇒ every old line is
 * byte-for-byte the pre-Games build.
 */

// ─── deterministic constants ──────────────────────────────────────────────────────────────────────────

const GAMES_SALT = 0x67616d;           // "gam" — never aliases court/tech/religion/workshop salts
const GAMES_OPEN_SALT = 0x6f706e;      // "opn"
const GAMES_EVENT_SALT = 0x657674;     // "evt"
const GAMES_WIN_SALT = 0x776e6e;       // "wnn"
const GAMES_VERSION = 1;

/** Crons between the opening of the games and the crowning of the champion. */
const CROWN_DELAY = 2;

/** Hard structural bound (independent of config, so the DO blob can never grow past it). */
export const GAMES_SEEN_ERAS = 16;

/** The programme — static prose the membrane draws from by hash(era); never a new fact, only a new name. */
export const GAMES_EVENTS = [
  "the long sprint", "the wing-clap derby", "the nectar haul",
  "the aggregation drill", "the homing race", "the odour chase",
] as const;

function hash32(a: number, b: number, salt: number): number {
  let h = 0x811c9dc5 ^ salt;
  for (const v of [a, b]) {
    h ^= (v & 0xff); h = Math.imul(h, 0x01000193);
    h ^= ((v >>> 8) & 0xff); h = Math.imul(h, 0x01000193);
    h ^= ((v >>> 16) & 0xff); h = Math.imul(h, 0x01000193);
    h ^= ((v >>> 24) & 0xff); h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}
const hash01 = (a: number, b: number, salt: number): number => hash32(a, b, salt) / 0x100000000;

// ─── the facts the stadium may read (all already persisted elsewhere; this layer borrows, never owns) ──

export interface GamesFacts {
  /** The historian's current era index — the festival bell. */
  era: number;
  /** Living fly ids — the competitor pool. */
  livingIds: number[];
  /** The dominant house's name (the venue), or null when no house holds the swarm's capital. */
  venueHouse: string | null;
  /** Lifetime settlements (deals+sales) of one fly, read from the economy's own ledger. */
  dealsOf: (id: number) => number;
  /** The house name one fly was born to, for the victor's banner (null = of no house). */
  houseOf: (id: number) => string | null;
}

export interface GamesConfig {
  enabled: boolean;
  openP: number;      // per new era, P the games are proclaimed (default 0.6)
}

// ─── the signals (edge events for THIS cron + the standing read-out) ──────────────────────────────────

export interface GamesSignals {
  games: { era: number; event: string; venue: string } | null;
  champion: { id: number; event: string; house: string | null } | null;
  record: { id: number; deals: number; prev: number } | null;
  lastGames: { era: number; event: string; venue: string } | null;
  standing: { id: number; deals: number; era: number } | null;
  pendingGames: boolean;
  counts: { games: number; crowns: number; records: number };
}

// ─── the membrane ─────────────────────────────────────────────────────────────────────────────────────

export class GamesMembrane {
  private lastSeenEra = -1;            // the era bell's edge; boot mid-era adopts it silently
  private open: { era: number; event: string; venue: string; tick: number } | null = null;
  private record: { id: number; deals: number; era: number } | null = null;
  private lastGames: { era: number; event: string; venue: string } | null = null;
  private seenEras: number[] = [];     // eras that already played (never re-proclaimed; FIFO bound)
  private counts = { games: 0, crowns: 0, records: 0 };

  // this cron's edge events (one per kind per cron by construction — the era bell itself paces them)
  private pending: GamesSignals = {
    games: null, champion: null, record: null,
    lastGames: null, standing: null, pendingGames: false,
    counts: { ...this.counts },
  };

  constructor(private readonly cfg: GamesConfig) {}

  /** One round per cron, BEFORE observeChronicle so this cron's edge events fold into the same context. */
  round(tick: number, facts: GamesFacts): void {
    if (!this.cfg.enabled) return;
    this.pending = {
      games: null, champion: null, record: null,
      lastGames: this.lastGames ? { ...this.lastGames } : null,
      standing: this.record ? { ...this.record } : null,
      pendingGames: this.open != null,
      counts: { ...this.counts },
    };

    // 1) THE ERA BELL — a new age may proclaim the games; the draw is the era's own hash, never a coin.
    if (this.lastSeenEra < 0) {
      this.lastSeenEra = facts.era;                    // boot mid-era: adopt it silently, proclaim nothing
    } else if (facts.era > this.lastSeenEra) {
      this.lastSeenEra = facts.era;
      if (!this.seenEras.includes(facts.era) && !this.open
        && hash01(facts.era, GAMES_SALT, GAMES_OPEN_SALT) < this.cfg.openP) {
        const event = GAMES_EVENTS[Math.floor(hash01(facts.era, GAMES_SALT, GAMES_EVENT_SALT) * GAMES_EVENTS.length)];
        const venue = facts.venueHouse ?? "the commons";
        this.open = { era: facts.era, event, venue, tick };
        this.lastGames = { era: facts.era, event, venue };
        this.seenEras.push(facts.era);
        if (this.seenEras.length > GAMES_SEEN_ERAS) this.seenEras = this.seenEras.slice(-GAMES_SEEN_ERAS);
        this.counts.games++;
        this.pending.games = { era: facts.era, event, venue };
      }
    }

    // 2) THE CROWNING — a set span after the opening the field decides itself: the lowest hash wins.
    if (this.open && tick - this.open.tick >= CROWN_DELAY) {
      const o = this.open;
      this.open = null;
      const live = facts.livingIds.filter((id) => Number.isFinite(id));
      if (live.length) {
        let winner = live[0];
        let best = hash01(o.era, winner, GAMES_WIN_SALT);
        for (const id of live.slice(1)) {
          const h = hash01(o.era, id, GAMES_WIN_SALT);
          if (h < best) { winner = id; best = h; }
        }
        this.counts.crowns++;
        this.pending.champion = { id: winner, event: o.event, house: facts.houseOf(winner) };
        // 3) THE STAND — the stadium keeps one mark: the champion's OWN lifetime dealings vs the standing record.
        const deals = Math.max(0, facts.dealsOf(winner));
        if (this.record && deals > this.record.deals) {
          this.counts.records++;
          this.pending.record = { id: winner, deals, prev: this.record.deals };
        }
        if (!this.record || deals > this.record.deals) this.record = { id: winner, deals, era: o.era };
      }
    }

    // Read-out closes on the END-of-round truth (the historian and the drawer read signals() post-round).
    this.pending.lastGames = this.lastGames ? { ...this.lastGames } : null;
    this.pending.standing = this.record ? { ...this.record } : null;
    this.pending.pendingGames = this.open != null;
    this.pending.counts = { ...this.counts };
  }

  signals(): GamesSignals { return this.pending; }

  // ─── persistence (bounded, additive) ───────────────────────────────────────────────────────────────

  serialize(): string {
    return JSON.stringify({
      v: GAMES_VERSION,
      lastSeenEra: this.lastSeenEra,
      open: this.open,
      record: this.record,
      lastGames: this.lastGames,
      seen: this.seenEras,
      counts: this.counts,
    });
  }

  restore(blob: unknown): void {
    if (typeof blob !== "string" || !blob) return;
    try {
      const p = JSON.parse(blob);
      if (!p || typeof p !== "object") return;
      const num = (x: unknown, d: number) => (Number.isFinite(Number(x)) ? Math.floor(Number(x)) : d);
      this.lastSeenEra = num(p.lastSeenEra, -1);
      const c = p.counts ?? {};
      this.counts = { games: num(c.games, 0), crowns: num(c.crowns, 0), records: num(c.records, 0) };
      if (p.open && typeof p.open === "object" && Number.isFinite(Number(p.open.era))) {
        this.open = {
          era: num(p.open.era, 0),
          event: typeof p.open.event === "string" ? p.open.event : GAMES_EVENTS[0],
          venue: typeof p.open.venue === "string" ? p.open.venue : "the commons",
          tick: num(p.open.tick, 0),
        };
      }
      if (p.record && Number.isFinite(Number(p.record.id))) {
        this.record = { id: num(p.record.id, 0), deals: Math.max(0, num(p.record.deals, 0)), era: num(p.record.era, 0) };
      }
      if (p.lastGames && Number.isFinite(Number(p.lastGames.era))) {
        this.lastGames = {
          era: num(p.lastGames.era, 0),
          event: typeof p.lastGames.event === "string" ? p.lastGames.event : GAMES_EVENTS[0],
          venue: typeof p.lastGames.venue === "string" ? p.lastGames.venue : "the commons",
        };
      }
      if (Array.isArray(p.seen)) {
        this.seenEras = p.seen
          .filter((e: unknown) => typeof e === "number" && Number.isFinite(e))
          .map((e: number) => Math.floor(e)).slice(-GAMES_SEEN_ERAS);
      }
    } catch { /* corrupt → keep defaults: an empty stadium, never a poisoned ledger */ }
  }
}
