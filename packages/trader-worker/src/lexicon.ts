/**
 * ㉓ THE LEXICON — the words the telling makes: coinage, spread, silence (packages/trader-worker/src/lexicon.ts).
 *
 * ㉒ gave the swarm guilds; every society also grows a language. The Lexicon reads ONE fact the historian
 * already keeps: the hot annals roll (the last ANNALS_CAP chronicle lines, the swarm's LIVING MEMORY of its
 * own tellings). A kind the chronicle has spoken often enough stops being an event and becomes a WORD —
 * "feud", "golden age", "coin fever". A word whose LIFETIME tellings double is no longer new; a word nobody
 * has said for a hundred and twenty tellings falls silent and is marked remembered, not living. The
 * dictionary is written backwards out of the chronicle — nothing here invents a fact, only names what
 * naming already did.
 *
 * THE PERMANENCE LAW (task #107 — "record the invented words completely, accurately, forever; they are
 * the foundation of civilisation"):
 *   • NO FORGETTING. A held word is NEVER deleted. Silence turns it into a TOMBSTONE (status="dead") that
 *     keeps the full history (born era, lifetime tellings, who coined it, when it died). The old FIFO
 *     dead-roll (LEX_DEAD_ROLL=8) eviction is GONE — the graveyard holds every name forever, and because
 *     the tombstone itself blocks re-coinage, no dead word can ever be resurrected and re-coined with a
 *     fabricated birth (the old 8-row deadSet rebuild hole is structurally closed).
 *   • NO COLD READ-OUT. Row state (lastUses / lifetimeUses / lastTold …) is PERSISTED in the compact blob,
 *     so a freshly-evicted DO read-out shows truth BEFORE any round() runs (fixes the production
 *     "12 samples, 2 truths" empty-drawer bug — the read-out used to be transient memory).
 *   • TRUE LIFETIME COUNTS. `uses` is the ROLLING window count (can shrink as old tellings age out of the
 *     annals roll); `lifetimeUses` is the monotone since-coinage total, accumulated from the `fresh`
 *     fact (tellings new since the last round) — the number front-ends may call "told N times" honestly.
 *   • ARCHIVE QUEUE. Every COINAGE / SPREAD / SILENCE edge is queued as an immutable LexiconArchiveEvent
 *     for state.ts to drain into the D1 append-only lexicon_events table (the off-DO permanent layer).
 *     The queue is transient best-effort; the DO blob (tombstones) + D1 (event rows) are the record.
 *
 * THE THREE IRON RULES (the culture/faith/workshop/court/games/guilds law, restated):
 *   1. PURE READ-OUT. The Lexicon MOVES NO MONEY, touches no hash of brain or ledger, and rewrites no
 *     past line. Chronicle text stays English-canonical + template-localised exactly as before; a coined
 *     word changes nothing about how the historian speaks — only about what the lexicon holds.
 *   2. DETERMINISM. No RNG, no clock, no LLM. Coinage, doubling and silence are all edges over the
 *     annals roll's own kind-counts and seq numbers — re-derivable by any visitor who replays the roll.
 *   3. BOUNDED. ≤ one entry per watched word (LEX_WORDS is closed, twenty — tombstones included, so the
 *     book can never grow past the vocabulary), one pending per kind per cron. serialize() is a small
 *     compact JSON (<4KB with all twenty words held); a corrupt blob restarts an empty desk.
 *
 * REACHABILITY CALIBRATION (P2-1): a word can only be coined if the annals window can physically hold
 * LEX_COIN_AT tellings of its kind. With the roll's window W≈942 ticks and a kind's chronicle cooldown C,
 * the maximum tellings a kind can ever accumulate is floor(W/C)+1 — for GOLDEN_AGE (C=400) that is 3, so
 * a flat threshold of 25 made 8 of the 20 words (exile, amnesty, champion, golden age, dark age,
 * migration, invention, lost craft — the civilisation-weight words!) mathematically UNREACHABLE. The desk
 * therefore derives a PER-KIND threshold from the chronicler's own COOLDOWN map:
 *     threshold(kind) = clamp(floor(W_CAL / C) + 1, LEX_MIN_COIN_AT, LEX_COIN_AT)
 * with W_CAL = LEX_CALIBRATION_WINDOW = 471 (HALF the nominal window — a 2× safety margin against the
 * dynamic shrinkage when the chronicle gets noisy). Frequent kinds keep the full LEX_COIN_AT=25 gravitas;
 * rare chapter kinds get a threshold their pace can actually reach. lexicon.test.ts pins 20/20
 * reachability (and under a halved window) so a future COOLDOWN edit that starves a word fails the build.
 *
 * LEX_ENABLED=false ⇒ state.ts never constructs the membrane (ensureLexicon returns null), folds no
 * `lexicon` key into the historian's context ⇒ the three new chronicle kinds can never speak ⇒ every old
 * line is byte-for-byte the pre-Lexicon build.
 */

import { COOLDOWN } from "./chronicler.js";
import { sha256Hex } from "./provenance.js";

// ─── deterministic constants ──────────────────────────────────────────────────────────────────────────

const LEX_VERSION = 1;

/** The lexicon schema/grammar version (exported for the /lexicon contract + the grammar hash). */
export const LEX_SCHEMA_VERSION = LEX_VERSION;

/** The legacy flat coinage threshold — still the ceiling for frequent kinds (per-kind calibration below). */
export const LEX_COIN_AT = 25;

/** Tellings of silence after which a held word is marked remembered, not living (tombstoned, never deleted). */
export const LEX_DORMANT_GAP = 120;

/** Calibration window: HALF the nominal hot-roll window (W≈942), so every threshold keeps a 2× margin. */
export const LEX_CALIBRATION_WINDOW = 471;

/** Floor of the per-kind threshold — a word must be told at least twice to become common tongue. */
export const LEX_MIN_COIN_AT = 2;

/** Assumed cooldown for a watched kind missing from the chronicler's COOLDOWN map (defensive). */
const LEX_DEFAULT_COOLDOWN = 30;

/** The watched vocabulary — FIXED ORDER (the lexicographers' priority), kind → the word it made. */
export const LEX_WORDS: Record<string, string> = {
  FEUD: "feud", BETRAYAL: "betrayal", PANIC: "panic", HUDDLE: "huddle",
  FEAST: "feast", STORM: "storm", ELEGY: "elegy", VERDICT: "verdict",
  EXILE: "exile", AMNESTY: "amnesty", CHAMPION: "champion", SCHISM: "schism",
  PROPHECY: "prophecy", PILGRIMAGE: "pilgrimage", GOLDEN_AGE: "golden age",
  DARK_AGE: "dark age", MIGRATION: "migration", INVENTION: "invention",
  CRAFT_LOST: "lost craft", COIN_FEVER: "coin fever",
};
export const LEX_KINDS = Object.keys(LEX_WORDS);

/** The coinage threshold of one watched kind, calibrated against the chronicler's own cooldown. */
export function coinThresholdFor(kind: string): number {
  const c = COOLDOWN[kind as keyof typeof COOLDOWN] ?? LEX_DEFAULT_COOLDOWN;
  const reachable = Math.floor(LEX_CALIBRATION_WINDOW / c) + 1;
  return Math.max(LEX_MIN_COIN_AT, Math.min(LEX_COIN_AT, reachable));
}

/** Per-kind coinage thresholds (derived, frozen) — exported for the reachability test and the grammar hash. */
export const LEX_COIN_AT_BY_KIND: Readonly<Record<string, number>> = Object.freeze(
  Object.fromEntries(LEX_KINDS.map((k) => [k, coinThresholdFor(k)])),
);

// ─── the facts the desk may read (one scan of the hot annals roll — the swarm's living memory) ────────

export interface LexiconFacts {
  /** The historian's current era index — the age in which a word enters the tongue. */
  era: number;
  /** The current era's name (bornEra — persisted with a coinage so the record speaks in eras, not indices). */
  eraName?: string;
  /** Tellings per kind within the hot roll (ROLLING living memory, not lifetime — this can shrink). */
  uses: Record<string, number>;
  /** The seq of the roll's latest telling of each kind. */
  lastSeq: Record<string, number>;
  /** The roll's newest seq — the silence-gap's measuring stick. */
  maxSeq: number;
  /** Tellings per kind NEW since the desk's last round (seq > maxSeqSeen) — the lifetime accumulator's feed. */
  fresh?: Record<string, number>;
  /** The lead actor of each kind's latest telling (coinedBy — who was speaking when the word was made). */
  lastActor?: Record<string, string>;
}

export interface LexiconConfig {
  enabled: boolean;
}

// ─── the signals (edge events for THIS cron + the standing read-out) ──────────────────────────────────

/** The legacy read-out row (chronicler's ChronicleLexicon + the frontend drawer consume exactly this). */
export interface LexiconRow {
  word: string;
  uses: number;      // ROLLING tellings, as of the last round (lastUses on a cold read-out)
  born: number;      // the tick the word entered the lexicon
}

/** The full dictionary row — everything the /lexicon endpoint exposes per word (living or tombstoned). */
export interface LexiconWord extends LexiconRow {
  kind: string;
  bornEra: string;
  status: "living" | "dead";
  lifetimeUses: number;   // monotone tellings since coinage (the honest "told N times" number)
  coinageTick: number;
  coinedBy: string | null;
  spreads: number;        // how many doublings this word has rung
  lastTold: number;       // seq of its latest telling (0 = never / pre-history)
  deathTick: number | null;
}

/** One immutable archive event (COINAGE / SPREAD / SILENCE) queued for the D1 permanent layer. */
export interface LexiconArchiveEvent {
  tick: number;
  era: number;
  eraName: string;
  event: "COINAGE" | "SPREAD" | "SILENCE";
  kind: string;
  word: string;
  uses: number;           // rolling-window tellings at the moment of the event
  lifetimeUses: number;   // monotone lifetime tellings at the moment of the event
  gap: number;            // silence gap (SILENCE only, else 0)
  coinedBy: string | null;
  born: number;           // coinage tick of the word
}

export interface LexiconSignals {
  coinage: { word: string; uses: number; era: number } | null;
  spread: { word: string; uses: number } | null;
  dying: { word: string; gap: number } | null;
  lexicon: LexiconRow[];  // ALL living rows (the old slice(0,8) truncation is gone — no hidden words)
  dead: string[];         // ALL tombstoned words (the old FIFO roll is gone — the graveyard is forever)
  counts: { coinages: number; spreads: number; deaths: number };
}

// ─── the membrane ─────────────────────────────────────────────────────────────────────────────────────

/** One held word — living or tombstoned. NEVER deleted: silence flips status, history stays. */
interface LexEntry {
  word: string;
  born: number;               // coinage tick
  bornEra: string;            // era name at coinage
  status: "living" | "dead";
  nextMark: number;           // the lifetime-tellings mark the next doubling must reach
  lastTold: number;           // seq of the latest telling (the silence gap's anchor)
  lastUses: number;           // ROLLING tellings as of the last round (persisted → cold read-out truth)
  lifetimeUses: number;       // monotone tellings since coinage
  coinedBy: string | null;    // lead actor of the telling that was newest when the word was coined
  spreads: number;            // doublings rung
  deathTick: number | null;   // when the silence took it (null while living)
}

/** How many archive events the transient queue holds before state.ts drains it (bounded, best-effort). */
const LEX_ARCHIVE_QUEUE_CAP = 256;

export class LexiconMembrane {
  private entries: Record<string, LexEntry> = {};   // ≤ LEX_KINDS.length, closed set (tombstones included)
  private counts = { coinages: 0, spreads: 0, deaths: 0 };
  /** Highest annals seq the desk has seen — the `fresh` accumulator's watermark (persisted). */
  private maxSeqSeen = 0;
  /** Events awaiting the D1 append (transient — the DO blob + D1 rows are the permanent record). */
  private archiveQueue: LexiconArchiveEvent[] = [];
  /** Archive events already queued since construction (a read-out counter, monotone). */
  private archiveQueued = 0;

  private pending: LexiconSignals = {
    coinage: null, spread: null, dying: null,
    lexicon: [], dead: [], counts: { ...this.counts },
  };

  constructor(private readonly cfg: LexiconConfig) {}

  /** The `fresh` watermark: state.ts counts annals entries with seq > maxSeqSeen into facts.fresh. */
  get freshWatermark(): number { return this.maxSeqSeen; }

  /** One round per cron, AFTER observeChronicle's facts have settled (state.ts folds the PREVIOUS roll:
   *  the dictionary is compiled from tellings already history — a word enters after the line that made it). */
  round(tick: number, facts: LexiconFacts): void {
    if (!this.cfg.enabled) return;

    // Keep the desk's memory current BEFORE any silence is judged (a telling this roll resets the gap).
    for (const kind of LEX_KINDS) {
      const e = this.entries[kind];
      if (!e) continue;
      if (Number.isFinite(facts.lastSeq[kind])) e.lastTold = facts.lastSeq[kind];
      e.lastUses = facts.uses[kind] ?? 0;
      // Lifetime accumulator: fresh tellings (seq > last watermark) are added monotonically, so
      // lifetimeUses never shrinks even as the rolling window ages old tellings out (fix A-2).
      const f = facts.fresh?.[kind] ?? 0;
      if (f > 0) e.lifetimeUses += f;
    }
    if (facts.maxSeq > this.maxSeqSeen) this.maxSeqSeen = facts.maxSeq;

    let coinageEdge: { word: string; uses: number; era: number } | null = null;
    let spreadEdge: { word: string; uses: number } | null = null;
    let dyingEdge: { word: string; gap: number } | null = null;

    // 1) COINAGE — the first watched word the tellings have made common tongue (fixed priority order).
    //    A tombstone counts as held: entries[kind] existing (living OR dead) bars re-coinage forever —
    //    the graveyard is rebuilt from the persisted book itself, never from a truncated roll (fix C-3).
    for (const kind of LEX_KINDS) {
      const uses = facts.uses[kind] ?? 0;
      if (!this.entries[kind] && uses >= coinThresholdFor(kind)) {
        const word = LEX_WORDS[kind];
        const by = facts.lastActor?.[kind] ?? null;
        // Lifetime starts at the rolling truth (the tellings already in the window when the word was
        // made) and only grows from here — lifetimeUses ≥ uses, always, by construction.
        this.entries[kind] = {
          word, born: tick, bornEra: facts.eraName ?? String(facts.era), status: "living",
          nextMark: uses * 2, lastTold: facts.lastSeq[kind] ?? facts.maxSeq, lastUses: uses,
          lifetimeUses: uses, coinedBy: by, spreads: 0, deathTick: null,
        };
        this.counts.coinages++;
        coinageEdge = { word, uses, era: facts.era };
        this.queue(tick, facts, {
          event: "COINAGE", kind, word, uses, lifetimeUses: uses, gap: 0,
          coinedBy: by, born: tick,
        });
        break;   // one coinage per cron — the queue advances next round (gravitas, as before)
      }
    }

    // 2) SPREAD — a LIVING word whose LIFETIME tellings doubled past its last mark is no longer new.
    //    Driven by the monotone lifetime count, not the rolling window (the old `uses >= nextMark*2`
    //    test was dead code once the window shrank below the mark — fix A-3). The edge reports the
    //    lifetime number: the template's "has doubled to {uses} tellings" is now literally true.
    for (const kind of LEX_KINDS) {
      const e = this.entries[kind];
      if (!e || e.status !== "living") continue;
      if (e.lifetimeUses >= e.nextMark) {
        e.nextMark *= 2;
        e.spreads++;
        this.counts.spreads++;
        spreadEdge = { word: e.word, uses: e.lifetimeUses };
        this.queue(tick, facts, {
          event: "SPREAD", kind, word: e.word, uses: e.lastUses, lifetimeUses: e.lifetimeUses,
          gap: 0, coinedBy: e.coinedBy, born: e.born,
        });
        break;   // one spread per cron
      }
    }

    // 3) SILENCE — a LIVING word unspoken for LEX_DORMANT_GAP tellings leaves the living tongue. It is
    //    TOMBSTONED, never deleted (fix C-1/C-2): the entry keeps every number, the graveyard keeps the
    //    name forever, and the held-entry check above makes resurrection structurally impossible.
    for (const kind of LEX_KINDS) {
      const e = this.entries[kind];
      if (!e || e.status !== "living") continue;
      const gap = facts.maxSeq - e.lastTold;
      if (gap > LEX_DORMANT_GAP) {
        e.status = "dead";
        e.deathTick = tick;
        this.counts.deaths++;
        dyingEdge = { word: e.word, gap };
        this.queue(tick, facts, {
          event: "SILENCE", kind, word: e.word, uses: e.lastUses, lifetimeUses: e.lifetimeUses,
          gap, coinedBy: e.coinedBy, born: e.born,
        });
        break;   // one burial per cron
      }
    }

    // Read-out closes on the END-of-round truth (fresh tellings may have moved the rows).
    this.refreshPending();
    this.pending.coinage = coinageEdge;
    this.pending.spread = spreadEdge;
    this.pending.dying = dyingEdge;
  }

  /** Queue one immutable archive event for the D1 permanent layer (bounded; state.ts drains every cron). */
  private queue(tick: number, facts: LexiconFacts, ev: Omit<LexiconArchiveEvent, "tick" | "era" | "eraName">): void {
    if (this.archiveQueue.length >= LEX_ARCHIVE_QUEUE_CAP) return;   // pathological backlog: DO blob still holds truth
    this.archiveQueue.push({ tick, era: facts.era, eraName: facts.eraName ?? String(facts.era), ...ev });
    this.archiveQueued++;
  }

  /** Hand the queued archive events to state.ts (the D1 append). Drained events are gone from the queue. */
  drainArchive(): LexiconArchiveEvent[] {
    if (!this.archiveQueue.length) return [];
    const out = this.archiveQueue;
    this.archiveQueue = [];
    return out;
  }

  signals(): LexiconSignals { return this.pending; }

  /** The COMPLETE dictionary — every held word, living and tombstoned, full contract rows (fix C-5:
   *  no truncation anywhere; the /lexicon endpoint serves this). Fixed vocabulary order. */
  dictionary(): LexiconWord[] {
    return LEX_KINDS
      .filter((k) => this.entries[k])
      .map((k) => {
        const e = this.entries[k];
        return {
          word: e.word, kind: k, uses: e.lastUses, lifetimeUses: e.lifetimeUses,
          born: e.born, bornEra: e.bornEra, status: e.status, coinageTick: e.born,
          coinedBy: e.coinedBy, spreads: e.spreads, lastTold: e.lastTold, deathTick: e.deathTick,
        };
      });
  }

  /** A snapshot of the pending archive queue (read-out only — draining is state.ts's job). */
  archiveQueueDepth(): number { return this.archiveQueue.length; }

  /** Total events queued since construction (monotone; /lexicon reports it as `archived`). */
  archiveQueuedCount(): number { return this.archiveQueued; }

  /**
   * Rebuild the STANDING read-out fields (lexicon rows / dead roll / counts) from the membrane's own
   * PERSISTED state — pure and side-effect free: it coins no word, marks no spread and judges no silence.
   * restore() calls it so a DO reload reflects the persisted desk at once, and the /economy + /lexicon
   * read-outs call it so the public numbers never lag a cron. Rows are derived from persisted lastUses
   * (fix A-1: a cold DO now reads TRUTH before any round(), not an empty drawer); the dead roll is every
   * tombstoned word in coinage order. This cron's edge events (coinage / spread / dying) are preserved.
   */
  refreshPending(): void {
    const living: LexiconRow[] = [];
    const dead: string[] = [];
    for (const kind of LEX_KINDS) {
      const e = this.entries[kind];
      if (!e) continue;
      if (e.status === "living") living.push({ word: e.word, uses: e.lastUses, born: e.born });
      else dead.push(e.word);
    }
    living.sort((a, b) => b.uses - a.uses || (a.word < b.word ? -1 : 1));
    this.pending = { ...this.pending, lexicon: living, dead, counts: { ...this.counts } };
  }

  // ─── persistence (bounded, additive, compact — <4KB with all twenty words held) ────────────────────

  serialize(): string {
    const e: Record<string, unknown> = {};
    for (const kind of LEX_KINDS) {
      const x = this.entries[kind];
      if (!x) continue;
      // Compact per-entry keys: w=word b=born be=bornEra s=status nm=nextMark lt=lastTold lu=lastUses
      // lf=lifetimeUses ct=coinageTick cb=coinedBy sp=spreads dt=deathTick.
      e[kind] = {
        w: x.word, b: x.born, be: x.bornEra, s: x.status, nm: x.nextMark, lt: x.lastTold,
        lu: x.lastUses, lf: x.lifetimeUses, ct: x.born, cb: x.coinedBy, sp: x.spreads, dt: x.deathTick,
      };
    }
    return JSON.stringify({ v: LEX_VERSION, e, c: { ...this.counts }, mx: this.maxSeqSeen });
  }

  restore(blob: unknown): void {
    if (typeof blob !== "string" || !blob) return;
    try {
      const p = JSON.parse(blob);
      if (!p || typeof p !== "object") return;
      const num = (x: unknown, d: number) => (Number.isFinite(Number(x)) ? Math.floor(Number(x)) : d);
      const c = p.c ?? p.counts ?? {};
      this.counts = { coinages: num(c.coinages, 0), spreads: num(c.spreads, 0), deaths: num(c.deaths, 0) };
      this.maxSeqSeen = Math.max(0, num(p.mx, 0));
      const next: Record<string, LexEntry> = {};
      const src = (p.e ?? p.entries ?? {}) as Record<string, unknown>;
      const str = (x: unknown, d: string) => (typeof x === "string" && x ? x : d);
      const nullableNum = (x: unknown): number | null => (x === null || x === undefined ? null : num(x, 0));
      const nullableStr = (x: unknown): string | null => (typeof x === "string" && x ? x : null);
      for (const kind of LEX_KINDS) {
        const raw = src[kind];
        if (!raw || typeof raw !== "object") continue;
        const o = raw as Record<string, unknown>;
        const compact = typeof o.w === "string";            // new compact format
        const word = compact ? str(o.w, LEX_WORDS[kind]) : str(o.word, "");
        if (!word) continue;                                 // junk row → dropped (never a poisoned desk)
        const born = num(compact ? o.b : o.born, 0);
        const lifetime = Math.max(0, num(compact ? o.lf : o.lifetimeUses, 0));
        const lastUses = Math.max(0, num(compact ? o.lu : o.lastUses, 0));
        next[kind] = {
          word,
          born,
          bornEra: str(compact ? o.be : o.bornEra, ""),
          status: (compact ? o.s : o.status) === "dead" ? "dead" : "living",
          nextMark: Math.max(1, num(compact ? o.nm : o.nextMark, Math.max(LEX_MIN_COIN_AT, lifetime * 2 || LEX_COIN_AT))),
          lastTold: Math.max(0, num(compact ? o.lt : o.lastSeq, 0)),
          lastUses,
          // Legacy blobs kept no lifetime count: the rolling window is the best honest seed.
          lifetimeUses: Math.max(lifetime, lastUses),
          coinedBy: nullableStr(compact ? o.cb : o.coinedBy),
          spreads: Math.max(0, num(compact ? o.sp : o.spreads, 0)),
          deathTick: nullableNum(compact ? o.dt : o.deathTick),
        };
      }
      this.entries = next;
      // Legacy migration: the OLD format kept a FIFO `dead: string[]` roll (≤8 words) alongside full-key
      // entries. Any dead-roll word without a persisted entry becomes a tombstone with what is known —
      // history from before the permanence law is thin, but the NAME is kept forever and re-coinage stays
      // barred (the old deadSet is structurally replaced by the tombstone itself).
      if (Array.isArray(p.dead)) {
        for (const w of p.dead) {
          if (typeof w !== "string") continue;
          const kind = LEX_KINDS.find((k) => LEX_WORDS[k] === w);
          if (!kind || this.entries[kind]) continue;
          this.entries[kind] = {
            word: w, born: 0, bornEra: "", status: "dead", nextMark: LEX_COIN_AT,
            lastTold: 0, lastUses: 0, lifetimeUses: 0, coinedBy: null, spreads: 0, deathTick: null,
          };
        }
      }
    } catch { /* corrupt → keep defaults: an empty desk, never a poisoned ledger */ }
    // Rebuild the read-out from the just-restored state so signals() is truthful BEFORE the next round().
    this.refreshPending();
  }
}

// ─── grammar hash (the word-list + rule-set anchor, after poet.ts's poetGrammarHash) ──────────────────

/**
 * SHA-256 of the lexicon's whole rule-set: the closed vocabulary, the thresholds (flat + per-kind
 * calibration), the dormancy gap and the version. Anchored into the chronicler's CODE_COMMITMENT path so
 * a visitor can prove the desk they read against is the desk that shipped. Touches NO stateDigest /
 * PocoStateInput — zero risk to the economic canon.
 */
export async function lexiconGrammarHash(): Promise<string> {
  return sha256Hex({
    v: LEX_VERSION,
    coinAt: LEX_COIN_AT,
    dormantGap: LEX_DORMANT_GAP,
    calibWindow: LEX_CALIBRATION_WINDOW,
    minCoinAt: LEX_MIN_COIN_AT,
    words: LEX_WORDS,
    coinAtByKind: LEX_COIN_AT_BY_KIND,
  });
}
