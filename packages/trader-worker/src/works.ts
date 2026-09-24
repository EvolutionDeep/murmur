/**
 * ㉖ THE PUBLIC WORKS — the common goods the swarm raises for itself (packages/trader-worker/src/works.ts).
 *
 * The economy has coin, credit, houses and even treaties — but no GRANARY, no AQUEDUCT, no MONUMENT: no
 * anything the swarm builds TOGETHER and no record of those works falling down. Every society that grew
 * past the household kept a public roll: what was raised, for whose need, when it was last repaired,
 * and when the fields let it fall. This membrane grows that missing commons of things: a credit run
 * raises a granary before the hunger, a turning generation at a full swarm raises an aqueduct, a golden
 * age gets its monument — and time, unattended, dilapidates them all. No fly is ever commanded to
 * build; the works are a document written backwards out of facts the historian and the ledger already
 * keep (eraInfo's civilizational reckoning, the generation clock, the credit book's run and bad rate).
 *
 * THE THREE IRON RULES (the culture/faith/court/games/guilds/lexicon/treaty law, restated):
 *   1. PURE READ-OUT. The Works MOVE NO MONEY, tax no purse, touch no hash of brain or ledger, and
 *     rewrite no past line. A raised granary feeds nobody in the simulation — only the roll holds it.
 *     There is no causal leg at all here, as in ㉕.
 *   2. DETERMINISM. No RNG, no clock, no LLM. Raising, repairing and dilapidating are all edges over
 *     the facts series (run/badRate/generation/civLevel/size) — re-derivable by anyone replaying them.
 *     One event per class per cron; dilapidation is the news of its cron alone.
 *   3. BOUNDED. Exactly three standing slots (granary/aqueduct/monument, one live work each), an
 *     archive of ≤ WK_MEMORY (10) ended works, one per-kind raising cooldown map pruned to
 *     WK_COOL_MEM (240). serialize() is a small JSON; a corrupt blob restarts an empty works yard,
 *     never a poisoned ledger.
 *
 * WORKS_ENABLED=false ⇒ state.ts never constructs the membrane (ensureWorks returns null), folds no
 * `works` key into the historian's context ⇒ the three new chronicle kinds can never speak ⇒ every old
 * line is byte-for-byte the pre-Works build.
 */

// ─── deterministic constants ──────────────────────────────────────────────────────────────────────────

const WK_VERSION = 1;

/** The three kinds of public work, in the order the yard lists them. Names are lexicon coinages
 *  (granary/aqueduct/monument), resolved per language through the gloss layer like house names. */
export type WorkKind = "granary" | "aqueduct" | "monument";
export const WK_KINDS: readonly WorkKind[] = ["granary", "aqueduct", "monument"];

/** Ticks a standing work serves before it falls to ruin unattended (the term of mortar). */
export const WK_AGE = 60;

/** How many ended works the archive keeps for the read-out (FIFO). */
export const WK_MEMORY = 10;

/** Crons before the SAME kind may be raised again — a granary rebuilt the cron after it fell is mud, not policy. */
export const WK_RAISE_COOL = 24;

/** The raising-cooldown map is pruned to entries newer than this many ticks (bounded blob). */
const WK_COOL_MEM = 240;

/** A credit run raises the granary — BEFORE the hunger, not after (dread of the fields is the oldest
 *  public works programme history knows). */
export const WK_GRANARY_RUN = true;

/** Bad paper at or over this share REPAIRS (refreshes) a standing granary: the book of the run is
 *  remade every time the run deepens while the walls still stand. */
export const WK_BAD_REPAIR = 0.4;

/** An aqueduct is raised for a swarm of at least this many flies — water is a question of numbers. */
export const WK_AQUEDUCT_SIZE = 120;

/** …and only on the FIFTH cron of each generation once the swarm is that big (a works rhythm tied to
 *  the generation clock the historian already keeps, not to any new signal). */
export const WK_AQUEDUCT_EVERY = 5;

/** A golden age raises its monument (the phase the chronicler itself reckons from civLevel). */
export const WK_MONUMENT_PHASE = "golden";

/** civLevel at or over which a standing, aging monument is repainted — glory kept up is glory repaired. */
export const WK_MONUMENT_REPAIR_CIV = 80;

/** A monument must have stood this long before a high civLevel counts as a REPAIR (no re-tiling at once). */
export const WK_MONUMENT_REPAIR_AGE = 20;

// ─── the facts the yard may read (all already published by the historian / the credit book) ───────────

export interface WorksCredit {
  /** A run is on the swarm's credit THIS cron. */
  run: boolean;
  /** Share of live IOUs past due, 0..1. */
  badRate: number;
}

export interface WorksFacts {
  /** The historian's current era index — the age the work was raised in. */
  era: number;
  /** The fast clock's generation counter. */
  generation: number;
  /** The historian's bounded 0..100 reckoning of the swarm's civilizational fortune. */
  civLevel: number;
  /** Its named phase (golden ages raise monuments). */
  civPhase: string;
  /** The swarm's headcount this cron (aqueducts are a question of numbers). */
  size: number;
  /** The credit book's dread, when the market layer is on (absent ⇒ no granary can ever raise). */
  credit?: WorksCredit | null;
}

export interface WorksConfig {
  enabled: boolean;
}

// ─── the signals (edge events for THIS cron + the standing yard) ──────────────────────────────────────

export interface WorkRecord {
  id: number;
  kind: WorkKind;
  raisedTick: number;
  raisedEra: number;
  lastRepairTick: number;
}

/** One cron's work edge: which work, in which era, and the facts that spoke (shaped per kind). */
export interface WorkEdge {
  kind: WorkKind;
  era: number;
  /** The credit's face at the moment of need (granary edges only). */
  badPct?: number;
  /** The swarm the water was cut for (aqueduct edges only). */
  size?: number;
  /** The fortune the glory reckons (monument edges only). */
  civ?: number;
  /** Ticks the fallen work stood (dilapidation edges only). */
  lived?: number;
}

export interface WorksSignals {
  raised: WorkEdge | null;
  repaired: WorkEdge | null;
  dilapidated: WorkEdge | null;
  active: WorkRecord[];
  archive: { kind: WorkKind; raisedEra: number; end: "ruin" }[];
  counts: { raised: number; repaired: number; dilapidated: number };
}

// ─── the membrane ─────────────────────────────────────────────────────────────────────────────────────

/** The raising cause, spoken in the chronicle's own plain words (per-kind, fixed strings). */
const WK_CAUSE: Record<WorkKind, string> = {
  granary: "a credit run",
  aqueduct: "a full swarm",
  monument: "a golden age",
};
export function wkCause(kind: WorkKind): string { return WK_CAUSE[kind]; }

interface EndedWork { kind: WorkKind; raisedEra: number; end: "ruin" }

export class WorksMembrane {
  private standing: Partial<Record<WorkKind, WorkRecord>> = {};   // ≤ 3 slots, one live work per kind
  private archive: EndedWork[] = [];                              // ≤ WK_MEMORY, FIFO
  private lastRaise: Partial<Record<WorkKind, number>> = {};      // kind → tick of its last raising (pruned)
  private prevBadRate = -1;        // last cron's bad-paper share (a repair is the UP-CROSSING, not the state)
  private prevCiv = -1;            // last cron's civLevel (monument repainting is likewise an edge)
  private lastAqueductGen = -1;    // generation the aqueduct was last raised in — one cutting per generation
  private counts = { raised: 0, repaired: 0, dilapidated: 0 };
  private nextId = 1;

  private pending: WorksSignals = {
    raised: null, repaired: null, dilapidated: null,
    active: [], archive: [], counts: { ...this.counts },
  };

  constructor(private readonly cfg: WorksConfig) {}

  /** One round per cron, BEFORE observeChronicle folds the signals (state.ts drives it next to the
   *  chancery desk): the yard reads THIS cron's facts and fires at most one edge per class. */
  round(tick: number, facts: WorksFacts): void {
    if (!this.cfg.enabled) return;
    this.pending = {
      raised: null, repaired: null, dilapidated: null,
      active: this.activeList(), archive: this.archive.slice(), counts: { ...this.counts },
    };

    // 1) DILAPIDATE first — ruin outranks glory. Oldest standing work falls (the yard inspects by age,
    //    not by favour); one collapse is the news of this cron and the round ends on it.
    let fallen: WorkRecord | null = null;
    for (const k of WK_KINDS) {
      const w = this.standing[k];
      if (w && tick - w.lastRepairTick >= WK_AGE &&
        (!fallen || w.lastRepairTick < fallen.lastRepairTick ||
          (w.lastRepairTick === fallen.lastRepairTick && w.kind < fallen.kind))) fallen = w;
    }
    if (fallen) {
      delete this.standing[fallen.kind];
      this.archive.push({ kind: fallen.kind, raisedEra: fallen.raisedEra, end: "ruin" });
      if (this.archive.length > WK_MEMORY) this.archive = this.archive.slice(-WK_MEMORY);
      this.lastRaise[fallen.kind] = tick;   // the ground must lie fallow before the kind rises again
      this.counts.dilapidated++;
      this.pending.dilapidated = { kind: fallen.kind, era: facts.era, lived: tick - fallen.raisedTick };
      this.pending.active = this.activeList();
      this.pending.archive = this.archive.slice();
      this.pending.counts = { ...this.counts };
      return;
    }

    // 2) REPAIR / RAISE per kind — repair when the work already stands, raise when it doesn't.
    //    Repairs are EDGES: the fact must cross its line this cron (prev < line ≤ now), never merely
    //    sit above it — a deep run repairs the granary once, not every cron of its whole length.
    //    `raised` and `repaired` are TWO INDEPENDENT classes (the chronicler probes each on its own), so
    //    one cron may carry a granary repair AND an aqueduct raising; within a class the fixed kind
    //    priority (granary → aqueduct → monument) lets only the first matching edge speak.
    const credit = facts.credit;
    // First reading of a series (after boot/restore): no history, so the edge IS the state — later
    // crons move strictly along the series (prev < line ≤ now), never merely sitting above it.
    const badCross = credit == null ? false
      : (this.prevBadRate < 0 ? credit.badRate >= WK_BAD_REPAIR
        : this.prevBadRate < WK_BAD_REPAIR && credit.badRate >= WK_BAD_REPAIR);
    const civCross = this.prevCiv < 0 ? facts.civLevel >= WK_MONUMENT_REPAIR_CIV
      : this.prevCiv < WK_MONUMENT_REPAIR_CIV && facts.civLevel >= WK_MONUMENT_REPAIR_CIV;
    let didRepair = false;
    let didRaise = false;

    // GRANARY: dread of the fields raises it; bad paper CROSSING the line repairs it.
    if (credit) {
      const g = this.standing.granary;
      if (g && !didRepair && credit.badRate >= WK_BAD_REPAIR && badCross) {
        g.lastRepairTick = tick;
        this.counts.repaired++; didRepair = true;
        this.pending.repaired = { kind: "granary", era: facts.era, badPct: Math.round(credit.badRate * 100) };
      } else if (!g && !didRaise && credit.run === WK_GRANARY_RUN && this.cooled("granary", tick)) {
        this.raise("granary", tick, facts);
        this.pending.raised = { kind: "granary", era: facts.era, badPct: Math.round(credit.badRate * 100) };
        didRaise = true;
      }
    }

    // AQUEDUCT: a works rhythm on the generation clock (one cutting per generation), only once the
    // swarm is big enough to thirst. No repair path — water is cut, not mended.
    if (!didRaise && facts.size >= WK_AQUEDUCT_SIZE) {
      const a = this.standing.aqueduct;
      if (!a && this.cooled("aqueduct", tick) && facts.generation % WK_AQUEDUCT_EVERY === 0 && facts.generation !== this.lastAqueductGen) {
        this.raise("aqueduct", tick, facts);
        this.lastAqueductGen = facts.generation;
        this.pending.raised = { kind: "aqueduct", era: facts.era, size: facts.size };
        didRaise = true;
      }
    }

    // MONUMENT: a golden age raises it; civLevel CROSSING the glory line repainting an aging one repairs it.
    const m = this.standing.monument;
    if (m && !didRepair && facts.civLevel >= WK_MONUMENT_REPAIR_CIV && civCross && tick - m.lastRepairTick >= WK_MONUMENT_REPAIR_AGE) {
      m.lastRepairTick = tick;
      this.counts.repaired++; didRepair = true;
      this.pending.repaired = { kind: "monument", era: facts.era, civ: Math.round(facts.civLevel) };
    } else if (!m && !didRaise && facts.civPhase === WK_MONUMENT_PHASE && this.cooled("monument", tick)) {
      this.raise("monument", tick, facts);
      this.pending.raised = { kind: "monument", era: facts.era, civ: Math.round(facts.civLevel) };
      didRaise = true;
    }

    // Remember the facts series for next cron's crossing checks (after this round read the old values).
    if (credit) this.prevBadRate = credit.badRate;
    this.prevCiv = facts.civLevel;

    // Prune the cooldown map so the blob stays small across eras.
    for (const k of Object.keys(this.lastRaise) as WorkKind[]) {
      const t = this.lastRaise[k];
      if (t != null && tick - t > WK_COOL_MEM) delete this.lastRaise[k];
    }

    // Read-out closes on the END-of-round truth (a work raised this cron belongs in the yard).
    this.pending.active = this.activeList();
    this.pending.archive = this.archive.slice();
    this.pending.counts = { ...this.counts };
  }

  private cooled(kind: WorkKind, tick: number): boolean {
    const last = this.lastRaise[kind];
    return last == null || tick - last >= WK_RAISE_COOL;
  }

  private raise(kind: WorkKind, tick: number, facts: WorksFacts): void {
    this.standing[kind] = { id: this.nextId++, kind, raisedTick: tick, raisedEra: facts.era, lastRepairTick: tick };
    this.lastRaise[kind] = tick;
    this.counts.raised++;
  }

  /** The standing yard in fixed kind order (deterministic for the roll and the blob). */
  private activeList(): WorkRecord[] {
    return WK_KINDS.map((k) => this.standing[k]).filter((w): w is WorkRecord => !!w);
  }

  signals(): WorksSignals { return this.pending; }

  // ─── persistence (bounded, additive) ───────────────────────────────────────────────────────────────

  serialize(): string {
    return JSON.stringify({
      v: WK_VERSION,
      standing: this.activeList(),
      archive: this.archive,
      lastRaise: this.lastRaise,
      counts: this.counts,
      nextId: this.nextId,
      lastAqueductGen: this.lastAqueductGen,
    });
  }

  restore(blob: unknown): void {
    if (typeof blob !== "string" || !blob) return;
    try {
      const p = JSON.parse(blob);
      if (!p || typeof p !== "object") return;
      const num = (x: unknown, d: number) => (Number.isFinite(Number(x)) ? Math.floor(Number(x)) : d);
      const kindOf = (x: unknown): WorkKind | null =>
        (typeof x === "string" && (WK_KINDS as readonly string[]).includes(x)) ? (x as WorkKind) : null;
      const c = p.counts ?? {};
      this.counts = { raised: num(c.raised, 0), repaired: num(c.repaired, 0), dilapidated: num(c.dilapidated, 0) };
      this.nextId = Math.max(1, num(p.nextId, 1));
      this.lastAqueductGen = num(p.lastAqueductGen, -1);
      this.standing = {};
      if (Array.isArray(p.standing)) {
        for (const raw of p.standing) {
          const kind = kindOf(raw?.kind);
          if (!kind || this.standing[kind]) continue;
          this.standing[kind] = {
            id: num(raw.id, this.nextId++), kind,
            raisedTick: Math.max(0, num(raw.raisedTick, 0)), raisedEra: num(raw.raisedEra, 0),
            lastRepairTick: Math.max(num(raw.raisedTick, 0), num(raw.lastRepairTick, num(raw.raisedTick, 0))),
          };
        }
      }
      if (Array.isArray(p.archive)) {
        this.archive = p.archive
          .map((raw: any) => {
            const kind = kindOf(raw?.kind);
            return kind ? { kind, raisedEra: num(raw.raisedEra, 0), end: "ruin" as const } : null;
          })
          .filter((w: EndedWork | null): w is EndedWork => !!w)
          .slice(-WK_MEMORY);
      }
      if (p.lastRaise && typeof p.lastRaise === "object") {
        const next: Partial<Record<WorkKind, number>> = {};
        for (const [k, v] of Object.entries(p.lastRaise)) {
          const kind = kindOf(k);
          if (kind && Number.isFinite(Number(v))) next[kind] = Math.floor(Number(v));
        }
        this.lastRaise = next;
      }
      // Refresh the read-out snapshot: a restored yard speaks its roll even before the first round.
      this.pending = {
        raised: null, repaired: null, dilapidated: null,
        active: this.activeList(), archive: this.archive.slice(), counts: { ...this.counts },
      };
    } catch { /* corrupt → keep defaults: an empty yard, never a poisoned ledger */ }
  }
}
