/**
 * ㉓ THE LEXICON — the words the telling makes: coinage, spread, silence (packages/trader-worker/src/lexicon.ts).
 *
 * ㉒ gave the swarm guilds; every society also grows a language. The Lexicon reads ONE fact the historian
 * already keeps: the hot annals roll (the last ANNALS_CAP chronicle lines, the swarm's LIVING MEMORY of its
 * own tellings). A kind the chronicle has spoken often enough stops being an event and becomes a WORD —
 * "feud", "golden age", "coin fever". A word whose tellings double is no longer new; a word nobody has
 * said for a hundred and twenty tellings falls silent and is marked remembered, not living. The dictionary
 * is written backwards out of the chronicle — nothing here invents a fact, only names what naming already did.
 *
 * THE THREE IRON RULES (the culture/faith/workshop/court/games/guilds law, restated):
 *   1. PURE READ-OUT. The Lexicon MOVES NO MONEY, touches no hash of brain or ledger, and rewrites no
 *     past line. Chronicle text stays English-canonical + template-localised exactly as before; a coined
 *     word changes nothing about how the historian speaks — only about what the lexicon holds.
 *   2. DETERMINISM. No RNG, no clock, no LLM. Coinage, doubling and silence are all edges over the
 *     annals roll's own kind-counts and seq numbers — re-derivable by any visitor who replays the roll.
 *   3. BOUNDED. ≤ one entry per watched word (LEX_WORDS is closed, twenty), a dead roll of ≤ 8, one
 *     pending per kind per cron. serialize() is a small JSON; a corrupt blob restarts an empty desk.
 *
 * LEX_ENABLED=false ⇒ state.ts never constructs the membrane (ensureLexicon returns null), folds no
 * `lexicon` key into the historian's context ⇒ the three new chronicle kinds can never speak ⇒ every old
 * line is byte-for-byte the pre-Lexicon build.
 */

// ─── deterministic constants ──────────────────────────────────────────────────────────────────────────

const LEX_VERSION = 1;

/** Tellings (within the hot annals roll) that turn a kind's word into common tongue. */
export const LEX_COIN_AT = 25;

/** Tellings of silence after which a held word is marked remembered, not living. */
export const LEX_DORMANT_GAP = 120;

/** How many dead words the desk keeps on the roll (FIFO). */
export const LEX_DEAD_ROLL = 8;

/** The watched vocabulary — FIXED ORDER (the lexicographers' priority), kind → the word it made. */
export const LEX_WORDS: Record<string, string> = {
  FEUD: "feud", BETRAYAL: "betrayal", PANIC: "panic", HUDDLE: "huddle",
  FEAST: "feast", STORM: "storm", ELEGY: "elegy", VERDICT: "verdict",
  EXILE: "exile", AMNESTY: "amnesty", CHAMPION: "champion", SCHISM: "schism",
  PROPHECY: "prophecy", PILGRIMAGE: "pilgrimage", GOLDEN_AGE: "golden age",
  DARK_AGE: "dark age", MIGRATION: "migration", INVENTION: "invention",
  CRAFT_LOST: "lost craft", COIN_FEVER: "coin fever",
};
const LEX_KINDS = Object.keys(LEX_WORDS);

// ─── the facts the desk may read (one scan of the hot annals roll — the swarm's living memory) ────────

export interface LexiconFacts {
  /** The historian's current era index — the age in which a word enters the tongue. */
  era: number;
  /** Tellings per kind within the hot roll (living memory, not lifetime). */
  uses: Record<string, number>;
  /** The seq of the roll's latest telling of each kind. */
  lastSeq: Record<string, number>;
  /** The roll's newest seq — the silence-gap's measuring stick. */
  maxSeq: number;
}

export interface LexiconConfig {
  enabled: boolean;
}

// ─── the signals (edge events for THIS cron + the standing read-out) ──────────────────────────────────

export interface LexiconRow {
  word: string;
  uses: number;      // tellings, as of this round's roll
  born: number;      // the era the word entered the lexicon
}

export interface LexiconSignals {
  coinage: { word: string; uses: number; era: number } | null;
  spread: { word: string; uses: number } | null;
  dying: { word: string; gap: number } | null;
  lexicon: LexiconRow[];
  dead: string[];
  counts: { coinages: number; spreads: number; deaths: number };
}

// ─── the membrane ─────────────────────────────────────────────────────────────────────────────────────

interface LexEntry { word: string; born: number; nextMark: number; lastSeq: number; }

export class LexiconMembrane {
  private entries: Record<string, LexEntry> = {};   // ≤ LEX_KINDS.length, closed set
  private dead: string[] = [];                      // ≤ LEX_DEAD_ROLL, FIFO
  private deadSet = new Set<string>();              // a dead word is never re-coined (no resurrections this cron)
  private counts = { coinages: 0, spreads: 0, deaths: 0 };

  private pending: LexiconSignals = {
    coinage: null, spread: null, dying: null,
    lexicon: [], dead: [], counts: { ...this.counts },
  };

  constructor(private readonly cfg: LexiconConfig) {}

  /** One round per cron, AFTER observeChronicle's facts have settled (state.ts folds the PREVIOUS roll:
   *  the dictionary is compiled from tellings already history — a word enters after the line that made it). */
  round(_tick: number, facts: LexiconFacts): void {
    if (!this.cfg.enabled) return;
    const rowsOf = (): LexiconRow[] => Object.entries(this.entries)
      .map(([kind, e]) => ({ word: e.word, uses: facts.uses[kind] ?? 0, born: e.born }))
      .sort((a, b) => b.uses - a.uses || (a.word < b.word ? -1 : 1))
      .slice(0, 8);
    this.pending = {
      coinage: null, spread: null, dying: null,
      lexicon: rowsOf(), dead: this.dead.slice(), counts: { ...this.counts },
    };

    // Keep the desk's memory current BEFORE any silence is judged (a telling this roll resets the gap).
    for (const kind of LEX_KINDS) {
      const e = this.entries[kind];
      if (e && Number.isFinite(facts.lastSeq[kind])) e.lastSeq = facts.lastSeq[kind];
    }

    // 1) COINAGE — the first watched word the tellings have made common tongue (fixed priority order).
    for (const kind of LEX_KINDS) {
      const uses = facts.uses[kind] ?? 0;
      if (!this.entries[kind] && !this.deadSet.has(kind) && uses >= LEX_COIN_AT) {
        const word = LEX_WORDS[kind];
        this.entries[kind] = { word, born: facts.era, nextMark: uses, lastSeq: facts.lastSeq[kind] ?? facts.maxSeq };
        this.counts.coinages++;
        this.pending.coinage = { word, uses, era: facts.era };
        break;
      }
    }

    // 2) SPREAD — a held word whose tellings DOUBLED past its last mark is no longer new.
    for (const kind of LEX_KINDS) {
      const e = this.entries[kind];
      if (!e) continue;
      const uses = facts.uses[kind] ?? 0;
      if (uses >= e.nextMark * 2) {
        e.nextMark *= 2;
        this.counts.spreads++;
        this.pending.spread = { word: e.word, uses };
        break;
      }
    }

    // 3) SILENCE — a held word unspoken for LEX_DORMANT_GAP tellings leaves the living tongue for good.
    for (const kind of LEX_KINDS) {
      const e = this.entries[kind];
      if (!e) continue;
      const gap = facts.maxSeq - e.lastSeq;
      if (gap > LEX_DORMANT_GAP) {
        delete this.entries[kind];
        this.dead.push(e.word);
        this.deadSet.add(kind);
        if (this.dead.length > LEX_DEAD_ROLL) this.dead = this.dead.slice(-LEX_DEAD_ROLL);
        this.counts.deaths++;
        this.pending.dying = { word: e.word, gap };
        break;
      }
    }

    // Read-out closes on the END-of-round truth (fresh tellings may have moved the rows).
    this.pending.lexicon = rowsOf();
    this.pending.dead = this.dead.slice();
    this.pending.counts = { ...this.counts };
  }

  signals(): LexiconSignals { return this.pending; }

  // ─── persistence (bounded, additive) ───────────────────────────────────────────────────────────────

  serialize(): string {
    return JSON.stringify({
      v: LEX_VERSION,
      entries: this.entries,
      dead: this.dead,
      counts: this.counts,
    });
  }

  restore(blob: unknown): void {
    if (typeof blob !== "string" || !blob) return;
    try {
      const p = JSON.parse(blob);
      if (!p || typeof p !== "object") return;
      const num = (x: unknown, d: number) => (Number.isFinite(Number(x)) ? Math.floor(Number(x)) : d);
      const c = p.counts ?? {};
      this.counts = { coinages: num(c.coinages, 0), spreads: num(c.spreads, 0), deaths: num(c.deaths, 0) };
      const next: Record<string, LexEntry> = {};
      this.deadSet = new Set<string>();
      if (p.entries && typeof p.entries === "object") {
        for (const kind of LEX_KINDS) {
          const e = (p.entries as Record<string, unknown>)[kind];
          if (e && typeof e === "object" && typeof (e as LexEntry).word === "string") {
            const en = e as LexEntry;
            next[kind] = {
              word: en.word,
              born: num(en.born, 0),
              nextMark: Math.max(1, num(en.nextMark, LEX_COIN_AT)),
              lastSeq: Math.max(0, num(en.lastSeq, 0)),
            };
          }
        }
      }
      this.entries = next;
      if (Array.isArray(p.dead)) {
        this.dead = p.dead.filter((w: unknown) => typeof w === "string").slice(-LEX_DEAD_ROLL);
        // rebuild the no-resurrection set from the dead roll (older deaths than the last 8 may re-earn a word —
        // acceptable: only the kept roll claims the graveyard, and a re-coinage needs 25 fresh tellings)
      }
      // deadSet must match the words themselves, not just the kept roll: kinds whose word sits in the roll
      // can never be re-coined; the reverse would contradict the templates, so key off the word map.
      for (const kind of LEX_KINDS) {
        if (this.dead.includes(LEX_WORDS[kind])) this.deadSet.add(kind);
      }
    } catch { /* corrupt → keep defaults: an empty desk, never a poisoned ledger */ }
  }
}
