// TECH — ⑬ the ladder of arts (packages/trader-worker/src/invention.ts).
//
// The swarm invents. `civLevel` and `generation` already exist (⑫ ACCELERATED AGES turns a generation every
// GEN_CRONS crons and reckons the swarm's fortune 0..100) but until now they were an EMPTY number: nothing
// came of a Golden Age except a sentence. This layer gives the fast clock its CONTENT — a fixed, public
// ladder of twelve arts (the Knotted Cord → the Difference Engine), each rung gated on a generation and a
// level of fortune. A rung is DISCOVERED on a generation turn, DIFFUSES through the swarm over the crons
// that follow, and — because a Dark Age is not only a mood — the top rung can be UNLEARNED when fortune
// breaks, to be rediscovered later. So the ladder rises and falls with the civilisation that carries it.
//
// THE ONE IRON RULE (same as culture's and faith's): this is a PURE READ-OUT. It observes (tick, generation,
// civLevel, size, the dominant house) and writes only its own bounded ledger; it never touches a connectome,
// a genome, a fingerprint, a manifest hash, a price or a purse. An invention re-prices NOTHING — it is a
// chapter in the chronicle and a row in the workshop. Pure function of its inputs: no Math.random, no
// Date.now, no LLM, no wall-clock. TECH_ENABLED=false (or never calling the hooks) restores today's
// byte-for-byte.
//
// The ladder table and its thresholds are LANDSCAPE detector values (they shape WHEN a rung is discovered,
// never WHAT the sentence says), so — exactly like culture's, the epochs' and the ages' thresholds — they are
// NOT folded into chroniclerRulesHash. Re-tuning the pace therefore never rotates the historian's genome.

/** One rung of the ladder: a public, permanent name plus the two gates it sits behind. */
export interface LadderRung {
  name: string;
  /** the swarm-generation the art cannot precede (⑫'s fast clock, ~1 generation per GEN_CRONS crons). */
  minGen: number;
  /** the civilisation fortune (0..100) the art cannot precede. */
  minCiv: number;
}

/**
 * THE LADDER — twelve arts in a fixed order, from a knotted counting cord to a brass difference engine.
 * Public and permanent: a rung's name is written into the chronicle's hash chain the moment it is invented,
 * so this table is part of the swarm's recorded history. The gates are deliberately front-loaded (rung 12 at
 * generation 16, ≈4 hours at one cron a minute) so a visitor watching for an afternoon sees the ladder climb.
 */
export const LADDER: LadderRung[] = [
  { name: "the Knotted Cord", minGen: 1, minCiv: 0 },
  { name: "the Clay Tally", minGen: 2, minCiv: 10 },
  { name: "the Reed Pen", minGen: 3, minCiv: 15 },
  { name: "the Scribed Tablet", minGen: 4, minCiv: 20 },
  { name: "the Water Clock", minGen: 5, minCiv: 25 },
  { name: "the Bronze Edge", minGen: 6, minCiv: 30 },
  { name: "the Iron Share", minGen: 8, minCiv: 35 },
  { name: "the Bound Codex", minGen: 9, minCiv: 45 },
  { name: "the Lens", minGen: 11, minCiv: 50 },
  { name: "the Screw Press", minGen: 12, minCiv: 60 },
  { name: "the Double Ledger", minGen: 14, minCiv: 70 },
  { name: "the Difference Engine", minGen: 16, minCiv: 80 },
];

export interface TechConfig {
  enabled: boolean;      // TECH_ENABLED master switch (default ON in config.ts)
  discoverP: number;     // 0..1 — the draw a gated rung must pass to be discovered on a generation turn
  adoptPct: number;      // per-cron fraction of the swarm that takes up a discovered art
}

/** One invented art, as the ledger keeps it. */
export interface InventionRecord {
  rung: number;              // index into LADDER (1-based in the read-out, 0-based internally)
  name: string;
  gen: number;               // the generation that invented it
  tick: number;              // sub-tick of the discovery
  adopted: number;           // minds now working by it (diffusion; capped at the live size)
  houseId: number | null;    // the house credited, if the swarm had a dominant one
  houseName: string | null;
}

/** The chronicle-facing events of ONE cron (recomputed each round; state.ts folds them into the context). */
export interface TechSignals {
  /** discovered arts, lowest rung first. */
  rungs: { rung: number; name: string; gen: number; adopted: number; houseId: number | null; houseName: string | null }[];
  /** arts unlearned in a dark age (kept as history; a rung may be rediscovered later). */
  lost: { rung: number; name: string }[];
  /** the next rung and what it is waiting for — the ladder's visible horizon. */
  next: { name: string; needGen: number; needCiv: number } | null;
  discovery: { rung: number; name: string; gen: number; civ: number; credit: string; houseId: number | null } | null;
  diffusion: { rung: number; name: string; adopted: number; size: number } | null;
  lostArt: { rung: number; name: string; gen: number } | null;
}

// --- bounded, deterministic constants (DO-safe: the ledger can never outgrow the twelve-rung ladder) ---
const LOST_CIV = 25;             // fortune at or below this unlearns the top art (mirrors the historian's CIV_DARK)
const KEEP_RUNGS = 2;            // the ladder's floor: a dark age may unlearn down to this many arts, never past it
const DIFFUSE_HALF = 0.5;        // an art becomes a custom once half the swarm works by it (one DIFFUSION per rung)
const TECH_SALT = 0x7c3f;        // the discovery draw's salt — distinct from culture's/faith's, so it never aliases
const TECH_VERSION = 1;
const LADDER_LEN = LADDER.length;

/** The credit line for a discovery: the dominant house if the swarm had one, else nobody in particular. */
export const creditOf = (houseName: string | null): string =>
  houseName ? `the House of ${houseName}` : "no house in particular";

/**
 * The tech membrane: a per-DO singleton owning the swarm's ladder. state.ts drives it from the cron —
 * diffuse() every cron, turnGeneration() only on the historian's generation edge. Everything is recomputed
 * from (tick, generation, civLevel, size, the dominant house), so a restored DO and a fresh DO that see the
 * same inputs agree byte-for-byte.
 */
export class TechMembrane {
  /** rung index (0-based) → the invention. */
  private arts = new Map<number, InventionRecord>();
  /** rung indexes unlearned in a dark age (history only; they may be reinvented). */
  private lost = new Set<number>();
  /** rungs already announced as a custom, so DIFFUSION is one line per art, never a per-cron census. */
  private diffused = new Set<number>();
  private lastGen = 0;
  private lastTick = 0;
  private lastSize = 0;
  private pending: Pick<TechSignals, "discovery" | "diffusion" | "lostArt"> = { discovery: null, diffusion: null, lostArt: null };

  constructor(private readonly cfg: TechConfig) {}

  get size(): number {
    return this.arts.size;
  }

  /** The generation this membrane last saw (0 ⇒ nothing turned yet). */
  generation(): number {
    return this.lastGen;
  }

  /** The lowest rung not yet invented, or null once the ladder is complete. */
  private nextRung(): number | null {
    for (let i = 0; i < LADDER_LEN; i++) if (!this.arts.has(i)) return i;
    return null;
  }

  /**
   * ONE round per cron: every discovered art spreads by a fixed fraction of the live swarm, and the first
   * art to reach half the swarm is announced as a custom (once per rung). Pure, bounded, no draws.
   */
  diffuse(tick: number, size: number): void {
    if (!this.cfg.enabled) return;
    this.lastTick = tick;
    this.lastSize = Math.max(0, Math.floor(size));
    this.pending.diffusion = null;
    if (this.lastSize <= 0 || this.arts.size === 0) return;
    const step = Math.max(1, Math.round(this.lastSize * this.cfg.adoptPct));
    // fixed ascending rung order ⇒ the first art to cross half is always the same one, run to run
    for (const rung of Array.from(this.arts.keys()).sort((a, b) => a - b)) {
      const a = this.arts.get(rung) as InventionRecord;
      a.adopted = Math.min(this.lastSize, a.adopted + step);
      if (this.diffused.has(rung)) continue;
      if (a.adopted >= this.lastSize * DIFFUSE_HALF) {
        this.diffused.add(rung);
        this.pending.diffusion = { rung: rung + 1, name: a.name, adopted: a.adopted, size: this.lastSize };
        break;                                    // one custom announced per cron, so the chronicle never stutters
      }
    }
  }

  /**
   * The generation edge: invent at most one gated rung (behind a deterministic draw), then — if fortune has
   * broken into a dark age — unlearn at most the top one. Called ONLY when the historian's generation turns,
   * so the ladder's pace is the civilisation's pace and never a per-cron stutter.
   */
  turnGeneration(tick: number, gen: number, civ: number, size: number, house: { id: number; name: string } | null): void {
    if (!this.cfg.enabled) return;
    const g = Math.max(0, Math.floor(gen));
    // Idempotent per generation: a caller that turns twice on the same generation (or a DO restored mid-turn)
    // invents nothing the second time, so the ladder can never climb two rungs in one generation.
    const fresh = g !== this.lastGen;
    this.lastGen = g;
    this.lastTick = tick;
    this.lastSize = Math.max(0, Math.floor(size));
    this.pending.discovery = null;
    this.pending.lostArt = null;
    if (!fresh) return;
    // ① discovery — the lowest rung not yet invented, if both its gates are met and the draw passes.
    const rung = this.nextRung();
    if (rung != null) {
      const r = LADDER[rung];
      const gated = this.lastGen >= r.minGen && civ >= r.minCiv;
      if (gated && hash01(tick, this.lastGen * 100 + rung, TECH_SALT) < this.cfg.discoverP) {
        const rec: InventionRecord = {
          rung, name: r.name, gen: this.lastGen, tick,
          adopted: Math.min(Math.max(1, this.lastSize), Math.max(1, Math.round(this.lastSize * this.cfg.adoptPct))),
          houseId: house ? house.id : null, houseName: house ? house.name : null,
        };
        this.arts.set(rung, rec);
        this.lost.delete(rung);                    // a reinvention ends the forgetting
        this.diffused.delete(rung);
        this.pending.discovery = {
          rung: rung + 1, name: r.name, gen: this.lastGen, civ: Math.round(civ),
          credit: creditOf(rec.houseName), houseId: rec.houseId,
        };
      }
    }
    // ② forgetting — a dark age unlearns the highest art, but never strips the ladder past its floor.
    if (civ <= LOST_CIV && this.arts.size > KEEP_RUNGS) {
      const top = Math.max(...Array.from(this.arts.keys()));
      const a = this.arts.get(top) as InventionRecord;
      this.arts.delete(top);
      this.diffused.delete(top);
      this.lost.add(top);
      this.pending.lostArt = { rung: top + 1, name: a.name, gen: this.lastGen };
    }
  }

  /**
   * Chronicle + endpoint read-outs, recomputed from the ledger just kept (pure, never persists): the arts in
   * force, what was lost, the next rung's horizon, and this cron's three events.
   */
  signals(): TechSignals {
    const rungs = Array.from(this.arts.values())
      .sort((a, b) => a.rung - b.rung)
      .map((a) => ({ rung: a.rung + 1, name: a.name, gen: a.gen, adopted: a.adopted, houseId: a.houseId, houseName: a.houseName }));
    const lost = Array.from(this.lost)
      .filter((rung) => !this.arts.has(rung))
      .sort((a, b) => a - b)
      .map((rung) => ({ rung: rung + 1, name: LADDER[rung].name }));
    const nx = this.nextRung();
    return {
      rungs,
      lost,
      next: nx == null ? null : { name: LADDER[nx].name, needGen: LADDER[nx].minGen, needCiv: LADDER[nx].minCiv },
      ...this.pending,
    };
  }

  /** Persist the membrane ONLY: {version, arts[], lost[], diffused[], lastGen, lastTick, lastSize} sorted + capped. */
  serialize(): string {
    return JSON.stringify({
      version: TECH_VERSION,
      arts: Array.from(this.arts.values())
        .sort((a, b) => a.rung - b.rung)
        .slice(0, LADDER_LEN)
        .map((a) => ({
          rung: a.rung, name: a.name, gen: a.gen, tick: a.tick,
          adopted: Math.max(0, Math.floor(a.adopted)), houseId: a.houseId, houseName: a.houseName,
        })),
      lost: Array.from(this.lost).sort((a, b) => a - b),
      diffused: Array.from(this.diffused).sort((a, b) => a - b),
      lastGen: this.lastGen,
      lastTick: this.lastTick,
      lastSize: this.lastSize,
    });
  }

  /** Restore from a stored blob; absent/corrupt/older-shape ⇒ an empty ladder (the arts are forgotten, the ledger untouched). */
  restore(data?: string): void {
    this.arts.clear();
    this.lost.clear();
    this.diffused.clear();
    this.lastGen = 0;
    this.lastTick = 0;
    this.lastSize = 0;
    if (!data) return;
    try {
      const p = JSON.parse(data);
      if (p?.version !== TECH_VERSION || !Array.isArray(p.arts)) return;
      for (const e of p.arts) {
        if (!e || typeof e !== "object") continue;
        const rung = Number(e.rung);
        if (!Number.isInteger(rung) || rung < 0 || rung >= LADDER_LEN) continue;
        if (typeof e.name !== "string" || e.name !== LADDER[rung].name) continue;   // the ladder is public and fixed
        if (this.arts.size >= LADDER_LEN) break;
        this.arts.set(rung, {
          rung,
          name: e.name,
          gen: Number.isFinite(Number(e.gen)) ? Math.max(0, Math.floor(Number(e.gen))) : 0,
          tick: Number.isFinite(Number(e.tick)) ? Math.max(0, Math.floor(Number(e.tick))) : 0,
          adopted: Number.isFinite(Number(e.adopted)) ? Math.max(0, Math.floor(Number(e.adopted))) : 1,
          houseId: Number.isInteger(Number(e.houseId)) && e.houseId != null ? Number(e.houseId) : null,
          houseName: typeof e.houseName === "string" ? e.houseName : null,
        });
      }
      if (Array.isArray(p.lost)) for (const r of p.lost) if (Number.isInteger(Number(r)) && Number(r) >= 0 && Number(r) < LADDER_LEN) this.lost.add(Number(r));
      if (Array.isArray(p.diffused)) for (const r of p.diffused) if (Number.isInteger(Number(r)) && Number(r) >= 0 && Number(r) < LADDER_LEN) this.diffused.add(Number(r));
      this.lastGen = Number.isFinite(Number(p.lastGen)) ? Math.max(0, Math.floor(Number(p.lastGen))) : 0;
      this.lastTick = Number.isFinite(Number(p.lastTick)) ? Math.max(0, Math.floor(Number(p.lastTick))) : 0;
      this.lastSize = Number.isFinite(Number(p.lastSize)) ? Math.max(0, Math.floor(Number(p.lastSize))) : 0;
    } catch {
      this.arts.clear();
      this.lost.clear();
      this.diffused.clear();
    }
  }
}

/**
 * If TECH_ENABLED is off, return a null-object membrane whose every method is inert — one call-site shape for
 * state.ts, so no `if (tech)` branch can ever be forgotten.
 */
export const NULL_TECH = new TechMembrane({ enabled: false, discoverP: 0.75, adoptPct: 0.1 });

// FNV-1a 32-bit + a uniform 0..1 draw — the SAME construction as culture's and faith's private hash (duplicated
// by design: the layers stay independently testable; the salts differ, so the ladder's draws can never alias a
// cultural, faithful or economic one).
function hash32(a: number, b: number, c: number): number {
  let h = 0x811c9dc5;
  const mix = (x: number) => {
    for (let s = 0; s < 32; s += 8) { h = Math.imul(h ^ ((x >>> s) & 0xff), 0x01000193) >>> 0; }
  };
  mix(a >>> 0); mix(b >>> 0); mix(c >>> 0);
  return h >>> 0;
}

function hash01(a: number, b: number, salt: number): number {
  return hash32(a, b, salt) / 0xffffffff;
}
