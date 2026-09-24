/**
 * ㉕ THE TREATY — formal diplomacy between houses (packages/trader-worker/src/treaty.ts).
 *
 * The war layer (WarCoffer) lets two feuding houses settle a grudge with real stakes; the chronicle has
 * always announced ALLIANCES, but only as narrative broadcasts of high bonds — never as DOCUMENTS. A
 * society that only fights and vaguely "gets along" has no diplomacy. This membrane grows the missing
 * middle: when a feud runs deep the two houses set their SEALS on a treaty of bounded clauses; if the
 * peace outlives its probation the treaty is RATIFIED; if the grudge sinks past the war threshold again
 * the seal is BREACHED and the old feud resumes where the ink stopped. The treaty moves no coin and
 * commands no fly — it is a document written backwards out of the bond ledger the economy already keeps.
 *
 * THE THREE IRON RULES (the culture/faith/court/games/guilds/lexicon law, restated):
 *   1. PURE READ-OUT. The Treaty MOVES NO MONEY (the coffer is untouched), touches no hash of brain or
 *     ledger, and rewrites no past line. A signed seal changes nothing about how the swarm behaves —
 *     only about what the diplomatic roll holds. Unlike ㉔, there is no causal leg at all here.
 *   2. DETERMINISM. No RNG, no clock, no LLM. Signing, ratifying and breaching are all edges over the
 *     house-bond series economy.houseFeuds() already publishes — re-derivable by anyone replaying it.
 *     One event per class per cron, chosen by deepest score then pair key: a stable, speakable order.
 *   3. BOUNDED. ≤ TR_MAX_ACTIVE (6) live treaties, an archive of ≤ TR_MEMORY (12) ended seals, one
 *     per-pair signing cooldown map pruned to TR_COOL_MEM (24). serialize() is a small JSON; a corrupt
 *     blob restarts an empty chancery, never a poisoned ledger.
 *
 * TR_ENABLED=false ⇒ state.ts never constructs the membrane (ensureTreaty returns null), folds no
 * `treaty` key into the historian's context ⇒ the three new chronicle kinds can never speak ⇒ every old
 * line is byte-for-byte the pre-Treaty build.
 */

// ─── deterministic constants ──────────────────────────────────────────────────────────────────────────

const TR_VERSION = 1;

/** Cross-house bond at or below which a pair may SEAL a treaty (shallower than the war gate's −0.6:
 *  diplomacy is what runs ahead of the last resort, not after it). */
export const TR_SIGN_AT = -0.45;

/** A live treaty is BREACHED the moment the pair's bond sinks back to the war threshold itself —
 *  the same line WarCoffer would fight over, so a breach always reads as "peace failed, war spoke". */
export const TR_BREACH_AT = -0.6;

/** Ticks a treaty must survive before its peace can be RATIFIED (the probation of the seal). */
export const TR_RATIFY_AFTER = 12;

/** Ratification also requires the bond to have lifted to at least this (a cold truce counts; open spite doesn't). */
export const TR_RATIFY_BOND = -0.15;

/** Ticks a treaty lives before it lapses quietly (a peace that simply ran its term is harvest, not news). */
export const TR_TERM = 48;

/** Ticks before the SAME pair may set seals again — stops a whipsawing bond from papering treaty after treaty. */
export const TR_SIGN_COOL = 24;

/** How many treaties may sit live at once (a chancery, not a filing cabinet). */
export const TR_MAX_ACTIVE = 6;

/** How many ENDED seals the archive keeps for the read-out (FIFO). */
export const TR_MEMORY = 12;

/** The signing-cooldown map is pruned to entries newer than this many ticks (bounded blob). */
const TR_COOL_MEM = 200;

/** Clause count from the depth of the grudge that forced the pen: −0.45 ⇒ 2 clauses, −1.0 ⇒ 6.
 *  Deeper feuds need longer documents — every society's chancery has always known this. */
export function trTerms(score: number): number {
  const depth = Math.min(1, Math.max(0, -score));
  return Math.min(6, Math.max(2, 2 + Math.floor((depth - 0.45) * 8)));
}

// ─── the facts the chancery may read (the house-bond series the economy already publishes) ────────────

export interface TreatyFeud {
  a: number;      // lower house id
  b: number;      // higher house id
  score: number;  // mean cross-house bond, −1 (blood feud) .. +1
}

export interface TreatyFacts {
  /** The historian's current era index — the age the seal is set in. */
  era: number;
  /** The current house-bond table (pairs absent from it read as 0: nobody holds a grudge). */
  feuds: TreatyFeud[];
}

export interface TreatyConfig {
  enabled: boolean;
}

// ─── the signals (edge events for THIS cron + the standing diplomatic roll) ───────────────────────────

export interface TreatyRecord {
  id: number;
  a: number;
  b: number;
  nameA: string;
  nameB: string;
  terms: number;
  signedTick: number;
  signedScore: number;   // the bond depth that forced the pen
  ratified: boolean;
}

export interface TreatySignals {
  signed: (TreatyRecord & { era: number }) | null;
  ratified: TreatyRecord | null;
  breached: TreatyRecord | null;
  active: TreatyRecord[];
  archive: { a: number; b: number; nameA: string; nameB: string; terms: number; ratified: boolean; end: "lived" | "breached" }[];
  counts: { signed: number; ratified: number; breached: number; lived: number };
}

// ─── the membrane ─────────────────────────────────────────────────────────────────────────────────────

interface EndedSeal { a: number; b: number; nameA: string; nameB: string; terms: number; ratified: boolean; end: "lived" | "breached" }

/** Canonical undirected pair key — same shape the war cooldown map uses, so both read alike. */
function trKey(a: number, b: number): string {
  return a < b ? `${a}-${b}` : `${b}-${a}`;
}

export class TreatyMembrane {
  private active: TreatyRecord[] = [];                  // ≤ TR_MAX_ACTIVE
  private archive: EndedSeal[] = [];                    // ≤ TR_MEMORY, FIFO
  private lastSign: Record<string, number> = {};        // pair key → tick of its last seal (pruned)
  private counts = { signed: 0, ratified: 0, breached: 0, lived: 0 };
  private nextId = 1;

  private pending: TreatySignals = {
    signed: null, ratified: null, breached: null,
    active: [], archive: [], counts: { ...this.counts },
  };

  constructor(private readonly cfg: TreatyConfig) {}

  /** One round per cron, BEFORE observeChronicle folds the signals (state.ts drives it next to the lexicon
   *  desk): the chancery reads THIS cron's bond table and fires at most one edge per class. */
  round(tick: number, facts: TreatyFacts): void {
    if (!this.cfg.enabled) return;
    this.pending = {
      signed: null, ratified: null, breached: null,
      active: this.active.slice(), archive: this.archive.slice(), counts: { ...this.counts },
    };

    // A missing pair is nobody's grudge: bond 0. The map is built once per round.
    const bonds = new Map<string, number>();
    for (const f of facts.feuds) bonds.set(trKey(f.a, f.b), f.score);
    const bondOf = (t: TreatyRecord): number => bonds.get(trKey(t.a, t.b)) ?? 0;

    // 1) BREACH first — a seal breaks before it can be praised. Deepest fresh spite speaks first
    //    (most negative bond, then pair key): the chancery never hides the worst page.
    let breach: TreatyRecord | null = null;
    for (const t of this.active) {
      const s = bondOf(t);
      if (s <= TR_BREACH_AT && (!breach || s < bondOf(breach) || (s === bondOf(breach) && trKey(t.a, t.b) < trKey(breach.a, breach.b)))) breach = t;
    }
    if (breach) {
      this.active = this.active.filter((t) => t !== breach);
      this.archive.push({ a: breach.a, b: breach.b, nameA: breach.nameA, nameB: breach.nameB, terms: breach.terms, ratified: breach.ratified, end: "breached" });
      if (this.archive.length > TR_MEMORY) this.archive = this.archive.slice(-TR_MEMORY);
      this.counts.breached++;
      this.lastSign[trKey(breach.a, breach.b)] = tick;   // a breached pair must cool the full window before re-sealing
      this.pending.breached = breach;
      this.pending.active = this.active.slice();
      this.pending.archive = this.archive.slice();
      this.pending.counts = { ...this.counts };
      return;   // one breach is the news of this cron; ratification waits its turn
    }

    // 2) RATIFY — a live, unratified seal whose probation is over AND whose bond has lifted off open
    //    spite. Oldest seal first (the chancery works its stack by date, not by favour).
    const due = this.active
      .filter((t) => !t.ratified && tick - t.signedTick >= TR_RATIFY_AFTER && bondOf(t) >= TR_RATIFY_BOND)
      .sort((x, y) => x.signedTick - y.signedTick || trKey(x.a, x.b).localeCompare(trKey(y.a, y.b)));
    if (due.length) {
      due[0].ratified = true;
      this.counts.ratified++;
      this.pending.ratified = due[0];
    }

    // 3) LAPSE — a seal that simply ran its term leaves the roll quietly (no kind: a peace that held to
    //    its end is harvest, not news). Ratify checked first, so a term-final probation still gets spoken.
    const living: TreatyRecord[] = [];
    for (const t of this.active) {
      if (tick - t.signedTick >= TR_TERM) {
        this.archive.push({ a: t.a, b: t.b, nameA: t.nameA, nameB: t.nameB, terms: t.terms, ratified: t.ratified, end: "lived" });
        this.counts.lived++;
      } else living.push(t);
    }
    if (this.archive.length > TR_MEMORY) this.archive = this.archive.slice(-TR_MEMORY);
    this.active = living;

    // 4) SEAL — the deepest feud with no live treaty and no fresh seal, while the chancery has room.
    if (this.active.length < TR_MAX_ACTIVE) {
      const seen = new Set(this.active.map((t) => trKey(t.a, t.b)));
      let best: TreatyFeud | null = null;
      for (const f of facts.feuds) {
        if (f.a === f.b) continue;
        if (f.score > TR_SIGN_AT) continue;                        // not deep enough to force a pen
        const key = trKey(f.a, f.b);
        if (seen.has(key)) continue;                               // already under seal
        const last = this.lastSign[key];
        if (last != null && tick - last < TR_SIGN_COOL) continue;  // per-pair cooling
        if (!best || f.score < best.score || (f.score === best.score && key < trKey(best.a, best.b))) best = f;
      }
      if (best) {
        const t: TreatyRecord = {
          id: this.nextId++,
          a: Math.min(best.a, best.b), b: Math.max(best.a, best.b),
          nameA: this.nameOf(best.a), nameB: this.nameOf(best.b),
          terms: trTerms(best.score), signedTick: tick, signedScore: best.score, ratified: false,
        };
        this.active.push(t);
        this.lastSign[trKey(t.a, t.b)] = tick;
        this.counts.signed++;
        this.pending.signed = { ...t, era: facts.era };
      }
    }

    // Prune the cooldown map so the blob stays small across eras.
    for (const k of Object.keys(this.lastSign)) {
      if (tick - this.lastSign[k] > TR_COOL_MEM) delete this.lastSign[k];
    }

    // Read-out closes on the END-of-round truth (a fresh seal this cron belongs on the roll).
    this.pending.active = this.active.slice();
    this.pending.archive = this.archive.slice();
    this.pending.counts = { ...this.counts };
  }

  /** House display names come from the coordinator (economy.houseNameById) — the membrane never imports
   *  the economy; state.ts injects the resolver before the first round and it is never serialized. */
  private nameResolver: (id: number) => string = (id) => `House ${id}`;
  setNames(fn: (id: number) => string): void { this.nameResolver = fn; }
  private nameOf(id: number): string { return this.nameResolver(id); }

  signals(): TreatySignals { return this.pending; }

  // ─── persistence (bounded, additive) ───────────────────────────────────────────────────────────────

  serialize(): string {
    return JSON.stringify({
      v: TR_VERSION,
      active: this.active,
      archive: this.archive,
      lastSign: this.lastSign,
      counts: this.counts,
      nextId: this.nextId,
    });
  }

  restore(blob: unknown): void {
    if (typeof blob !== "string" || !blob) return;
    try {
      const p = JSON.parse(blob);
      if (!p || typeof p !== "object") return;
      const num = (x: unknown, d: number) => (Number.isFinite(Number(x)) ? Math.floor(Number(x)) : d);
      const str = (x: unknown, d: string) => (typeof x === "string" && x ? x : d);
      const c = p.counts ?? {};
      this.counts = { signed: num(c.signed, 0), ratified: num(c.ratified, 0), breached: num(c.breached, 0), lived: num(c.lived, 0) };
      this.nextId = Math.max(1, num(p.nextId, 1));
      if (Array.isArray(p.active)) {
        this.active = p.active.filter((t: unknown) => t && typeof t === "object").slice(-TR_MAX_ACTIVE).map((raw: any) => ({
          id: num(raw.id, this.nextId++),
          a: num(raw.a, 0), b: num(raw.b, 0),
          nameA: str(raw.nameA, `House ${num(raw.a, 0)}`), nameB: str(raw.nameB, `House ${num(raw.b, 0)}`),
          terms: num(raw.terms, 2), signedTick: Math.max(0, num(raw.signedTick, 0)),
          signedScore: Number.isFinite(Number(raw.signedScore)) ? Number(raw.signedScore) : TR_SIGN_AT,
          ratified: !!raw.ratified,
        }));
      }
      if (Array.isArray(p.archive)) {
        this.archive = p.archive.filter((t: unknown) => t && typeof t === "object").slice(-TR_MEMORY).map((raw: any) => ({
          a: num(raw.a, 0), b: num(raw.b, 0),
          nameA: str(raw.nameA, `House ${num(raw.a, 0)}`), nameB: str(raw.nameB, `House ${num(raw.b, 0)}`),
          terms: num(raw.terms, 2), ratified: !!raw.ratified,
          end: raw.end === "breached" ? "breached" as const : "lived" as const,
        }));
      }
      if (p.lastSign && typeof p.lastSign === "object") {
        const next: Record<string, number> = {};
        for (const [k, v] of Object.entries(p.lastSign)) if (Number.isFinite(Number(v))) next[k] = Math.floor(Number(v));
        this.lastSign = next;
      }
      // Refresh the read-out snapshot: a restored chancery speaks its roll even before the first round.
      this.pending = {
        signed: null, ratified: null, breached: null,
        active: this.active.slice(), archive: this.archive.slice(), counts: { ...this.counts },
      };
    } catch { /* corrupt → keep defaults: an empty chancery, never a poisoned ledger */ }
  }
}
