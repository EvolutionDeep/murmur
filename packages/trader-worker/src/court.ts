/**
 * ⑳ THE COURT — law, verdicts, exile, amnesty (packages/trader-worker/src/court.ts).
 *
 * ⑧ The Commons LEGISLATES — but a polity that writes laws and never tries a case has a parliament, not
 * a society. The Court completes the hinge: it reads ONLY matters the ledgers already recorded — a deadbeat
 * whose IOUs broke (economy.socialSignals().deadbeat), a betrayal fresh in the grudge book, the deepest live
 * feud — and turns them into docketed cases: indictment, a seated jury, a verdict, and (for the gravest,
 * convicted, and guiltiest) exile from the commons' protection, until the turn of an era brings amnesty.
 *
 * THE THREE IRON RULES (the culture/faith/workshop law, restated):
 *   1. PURE READ-OUT. The court MOVES NO MONEY and never touches a connectome, genome, fingerprint or
 *      manifest hash. An "outlaw" is a line on the court's OWN bounded roll, narrated by the historian —
 *      the economy does not see it, prices nothing by it, and would run byte-for-byte identical without it.
 *   2. DETERMINISM. No RNG, no clock, no LLM. Jury seats and verdicts are hash draws over (caseKey, flyId,
 *      salt) — a visitor with the repo and the entry's tokens can re-derive every verdict (the chronicle's
 *      prove-no-LLM chain does exactly that for the sentence; this makes the SHAPE of the trial provable too).
 *   3. BOUNDED. ≤ COURT_CASES live cases, ≤ COURT_OUTLAWS exiles, ≤ COURT_KEYS adjudicated matter keys;
 *      serialize() is a small JSON under the DO value wall, restore() merges additively. A corrupt blob
 *      restarts an empty docket — it can never poison the ledger.
 *
 * COURTS_ENABLED=false ⇒ state.ts never constructs the membrane (ensureCourt returns null), folds no
 * `court` key into the historian's context ⇒ the five new chronicle kinds can never speak ⇒ every old
 * line is byte-for-byte the pre-court build.
 */

// ─── deterministic constants ──────────────────────────────────────────────────────────────────────────

const COURT_SALT = 0x636f75;           // "cou" — never aliases culture/tech/apprentice/archive/workshop salts
const COURT_FILE_SALT = 0x66696c;      // "fil"
const COURT_JURY_SALT = 0x6a7572;      // "jur"
const COURT_VOTE_SALT = 0x766f74;      // "vot"
const COURT_VERSION = 1;

/** Crons between the indictment and the seating of the jury; and between the trial and the verdict. */
const TRIAL_DELAY = 3;
const VERDICT_DELAY = 2;
/** Evidence at or above this turns a guilty verdict into exile, not just a conviction. */
const EXILE_EVIDENCE = 0.6;

// Hard structural bounds (independent of config, so the DO blob can never grow past them).
export const COURT_CASES = 8;
export const COURT_OUTLAWS = 16;
export const COURT_KEYS = 64;

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
const clamp01 = (x: number): number => Math.max(0, Math.min(1, x));
/** Fold a string matter-key into a stable uint for the draws (no 64-bit ints in this runtime contract). */
function keyNum(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193); }
  return h >>> 0;
}

// ─── the facts the court may read (all already persisted elsewhere; this layer borrows, never owns) ───

export type CourtCrime = "debt" | "treason" | "feud";

export interface CourtFacts {
  /** economy.socialSignals().deadbeat — the worst live reputation: kept vs broken IOUs. */
  deadbeat: { id: number; kept: number; broken: number; score: number } | null;
  /** economy.socialSignals().betrayal — the newest grudge-book entry (a partner undercut). */
  betrayal: { tick: number; buyerId: number; sellerId: number; amountUsdc: number } | null;
  /** economy.socialSignals().topFeud — the deepest live grudge pair. */
  feud: { a: number; b: number; score: number } | null;
  /** The historian's current era index — the amnesty bell. */
  era: number;
  /** Living fly ids — the jury pool and the defendant sanity check. */
  livingIds: number[];
}

export interface CourtConfig {
  enabled: boolean;
  fileP: number;      // per eligible matter per cron, P the court opens a case (default 0.25)
  jurySize: number;   // seated jurors, odd preferred (clamped 3..9 by config)
}

// ─── docket records (all bounded) ─────────────────────────────────────────────────────────────────────

interface CourtCase {
  key: string;            // crime:defendant:filedTick — stable matter identity
  crime: CourtCrime;
  defendantId: number;
  prosecutorId: number;   // the wronged party (feud: the other half; debt: the crown-as-ledger → defendant id 0-side)
  filedTick: number;
  evidence: number;       // 0..1 — how heavy the ledger fact weighs
  convenedTick: number;   // 0 = not yet seated
  jurors: number[];
  verdict: "guilty" | "cleared" | null;
  votesGuilty: number;
}

export interface CourtSignals {
  indictment: { id: number; crime: CourtCrime } | null;
  trial: { id: number; crime: CourtCrime; jurors: number } | null;
  verdict: { id: number; crime: CourtCrime; guilty: boolean; votes: number; jurors: number } | null;
  exile: { id: number; crime: CourtCrime } | null;
  amnesty: { outlaws: number } | null;
  outlaws: { id: number; crime: CourtCrime; since: number }[];
  openCases: number;
  counts: { indicted: number; convicted: number; cleared: number; exiles: number; amnesties: number };
}

// ─── the membrane ─────────────────────────────────────────────────────────────────────────────────────

export class CourtMembrane {
  private cases: CourtCase[] = [];
  private outlaws: { id: number; crime: CourtCrime; since: number }[] = [];
  private seenKeys: string[] = [];           // matters already adjudicated — never re-indicted (FIFO bound)
  private counts = { indicted: 0, convicted: 0, cleared: 0, exiles: 0, amnesties: 0 };
  private lastAmnestyEra = -1;

  // this cron's edge events (one per kind per cron by construction — the docket itself paces them)
  private pending: CourtSignals = {
    indictment: null, trial: null, verdict: null, exile: null, amnesty: null,
    outlaws: [], openCases: 0,
    counts: { ...this.counts },
  };

  constructor(private readonly cfg: CourtConfig) {}

  /** One round per cron, BEFORE observeChronicle so this cron's edge events fold into the same context. */
  round(tick: number, facts: CourtFacts): void {
    if (!this.cfg.enabled) return;
    this.pending = {
      indictment: null, trial: null, verdict: null, exile: null, amnesty: null,
      outlaws: this.outlaws.slice(), openCases: this.cases.length,
      counts: { ...this.counts },
    };

    // 1) THE AMNESTY BELL — the turn of an era pardons the whole roll (a society renewing its own past).
    if (this.lastAmnestyEra < 0) {
      this.lastAmnestyEra = facts.era;               // boot mid-era: adopt it silently, pardon nothing
    } else if (facts.era > this.lastAmnestyEra) {
      this.lastAmnestyEra = facts.era;
      if (this.outlaws.length) {
        this.pending.amnesty = { outlaws: this.outlaws.length };
        this.counts.amnesties++;
        this.outlaws = [];
        this.pending.outlaws = [];                     // the read-out must show the pardoned roll empty
      }
    }

    // 2) SITTING CASES — convene, then decide, on the court's own calendar.
    for (const c of this.cases.slice()) {
      if (!c.convenedTick && tick - c.filedTick >= TRIAL_DELAY) {
        c.convenedTick = tick;
        c.jurors = this.pickJurors(c, facts);
        this.pending.trial = { id: c.defendantId, crime: c.crime, jurors: c.jurors.length };
      } else if (c.convenedTick && tick - c.convenedTick >= VERDICT_DELAY) {
        this.decide(c);
        this.cases = this.cases.filter((x) => x !== c);
      }
    }
    this.pending.openCases = this.cases.length;

    // 3) NEW INDICTMENTS — at most one per cron, gravest matter first, gated by the court's own patience.
    if (this.cases.length < COURT_CASES) {
      const m = this.grievance(facts);
      if (m && !this.seenKeys.includes(m.key) && !this.isOutlaw(m.defendantId) && !this.isOnDocket(m.defendantId)
        && hash01(tick, m.defendantId, COURT_FILE_SALT) < this.cfg.fileP) {
        const c: CourtCase = {
          key: m.key, crime: m.crime, defendantId: m.defendantId, prosecutorId: m.prosecutorId,
          filedTick: tick, evidence: m.evidence, convenedTick: 0, jurors: [], verdict: null, votesGuilty: 0,
        };
        this.cases.push(c);
        if (this.cases.length > COURT_CASES) this.cases = this.cases.slice(-COURT_CASES);
        this.seenKeys.push(m.key);
        if (this.seenKeys.length > COURT_KEYS) this.seenKeys = this.seenKeys.slice(-COURT_KEYS);
        this.counts.indicted++;
        this.pending.indictment = { id: c.defendantId, crime: c.crime };
      }
    }

    // Read-out closes on the END-of-round truth: counts/openCases snapshotted at the top would miss this
    // cron's own indictment/verdict/amnesty deltas (the historian and the drawer read signals() post-round).
    this.pending.openCases = this.cases.length;
    this.pending.counts = { ...this.counts };
  }

  /** The three ledger facts, ranked by gravity, reduced to a candidate matter (or null if none is triable). */
  private grievance(f: CourtFacts): { key: string; crime: CourtCrime; defendantId: number; prosecutorId: number; evidence: number } | null {
    const pool: { key: string; crime: CourtCrime; defendantId: number; prosecutorId: number; evidence: number }[] = [];
    if (f.deadbeat && f.deadbeat.broken > 0) {
      pool.push({
        key: `debt:${f.deadbeat.id}`, crime: "debt", defendantId: f.deadbeat.id, prosecutorId: f.deadbeat.id,
        evidence: clamp01(f.deadbeat.broken / 5),           // five broken notes is the fullest charge
      });
    }
    if (f.betrayal) {
      const { buyerId, sellerId, amountUsdc, tick } = f.betrayal;
      pool.push({
        key: `treason:${tick}:${buyerId}:${sellerId}`, crime: "treason",
        defendantId: sellerId, prosecutorId: buyerId,       // the seller took the trust the deal broke
        evidence: clamp01(amountUsdc / 5),                  // a 5-USDC betrayal is the deepest cut on this rail
      });
    }
    if (f.feud && f.feud.score > 0) {
      pool.push({
        key: `feud:${Math.min(f.feud.a, f.feud.b)}:${Math.max(f.feud.a, f.feud.b)}`, crime: "feud",
        defendantId: f.feud.a, prosecutorId: f.feud.b,      // the feud's named aggressor side (ledger order)
        evidence: clamp01(f.feud.score / 10),
      });
    }
    if (!pool.length) return null;
    pool.sort((a, b) => b.evidence - a.evidence || keyNum(a.key) - keyNum(b.key));
    return pool[0];
  }

  /** Jurors: living flies, neither party, seated by a stable hash ranking of the case key. */
  private pickJurors(c: CourtCase, f: CourtFacts): number[] {
    const kn = keyNum(c.key);
    const size = Math.max(1, this.cfg.jurySize);
    return f.livingIds
      .filter((id) => id !== c.defendantId && id !== c.prosecutorId && !this.isOutlaw(id))
      .sort((a, b) => hash01(kn, a, COURT_JURY_SALT) - hash01(kn, b, COURT_JURY_SALT))
      .slice(0, size);
  }

  /** Each juror votes guilty with P that rises with the evidence; a strict majority convicts. */
  private decide(c: CourtCase): void {
    const kn = keyNum(c.key);
    const pGuilty = clamp01(0.5 + 0.4 * c.evidence);
    let guilty = 0;
    for (const j of c.jurors) if (hash01(kn, j, COURT_VOTE_SALT) < pGuilty) guilty++;
    const isGuilty = c.jurors.length > 0 && guilty * 2 > c.jurors.length;
    c.verdict = isGuilty ? "guilty" : "cleared";
    c.votesGuilty = guilty;
    if (isGuilty) {
      this.counts.convicted++;
      this.pending.verdict = { id: c.defendantId, crime: c.crime, guilty: true, votes: guilty, jurors: c.jurors.length };
      if (c.evidence >= EXILE_EVIDENCE && !this.isOutlaw(c.defendantId)) {
        this.outlaws.push({ id: c.defendantId, crime: c.crime, since: c.convenedTick + VERDICT_DELAY });
        if (this.outlaws.length > COURT_OUTLAWS) this.outlaws = this.outlaws.slice(-COURT_OUTLAWS);
        this.counts.exiles++;
        this.pending.exile = { id: c.defendantId, crime: c.crime };
      }
    } else {
      this.counts.cleared++;
      this.pending.verdict = { id: c.defendantId, crime: c.crime, guilty: false, votes: guilty, jurors: c.jurors.length };
    }
    this.pending.outlaws = this.outlaws.slice();
  }

  private isOutlaw(id: number): boolean { return this.outlaws.some((o) => o.id === id); }
  private isOnDocket(id: number): boolean { return this.cases.some((c) => c.defendantId === id); }

  signals(): CourtSignals { return this.pending; }

  // ─── persistence (bounded, additive) ───────────────────────────────────────────────────────────────

  serialize(): string {
    return JSON.stringify({
      v: COURT_VERSION,
      cases: this.cases,
      outlaws: this.outlaws,
      seen: this.seenKeys,
      counts: this.counts,
      amnestyEra: this.lastAmnestyEra,
    });
  }

  restore(blob: unknown): void {
    if (typeof blob !== "string" || !blob) return;
    try {
      const p = JSON.parse(blob);
      if (!p || typeof p !== "object") return;
      const num = (x: unknown, d: number) => (Number.isFinite(Number(x)) ? Math.floor(Number(x)) : d);
      this.lastAmnestyEra = num(p.amnestyEra, -1);
      const c = p.counts ?? {};
      this.counts = {
        indicted: num(c.indicted, 0), convicted: num(c.convicted, 0), cleared: num(c.cleared, 0),
        exiles: num(c.exiles, 0), amnesties: num(c.amnesties, 0),
      };
      if (Array.isArray(p.cases)) {
        this.cases = p.cases
          .filter((x: CourtCase) => x && typeof x.key === "string" && Number.isFinite(Number(x.defendantId)))
          .slice(-COURT_CASES)
          .map((x: CourtCase) => ({
            ...x, jurors: Array.isArray(x.jurors) ? x.jurors : [],
            evidence: clamp01(Number(x.evidence) || 0), convenedTick: num(x.convenedTick, 0), filedTick: num(x.filedTick, 0),
          }));
      }
      if (Array.isArray(p.outlaws)) {
        this.outlaws = p.outlaws
          .filter((x: { id?: number }) => x && Number.isFinite(Number(x.id)))
          .slice(-COURT_OUTLAWS)
          .map((x: { id: number; crime: CourtCrime; since: number }) => ({ id: Number(x.id), crime: x.crime ?? "debt", since: num(x.since, 0) }));
      }
      if (Array.isArray(p.seen)) this.seenKeys = p.seen.filter((s: unknown) => typeof s === "string").slice(-COURT_KEYS);
    } catch { /* corrupt → keep defaults: an empty docket, never a poisoned ledger */ }
  }
}
