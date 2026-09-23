// APPRENTICESHIP — ⑯ education and cumulative culture (packages/trader-worker/src/apprentice.ts).
//
// ⑬ TECH puts an art ON THE LADDER: the swarm discovers a rung and it becomes public property. But a ladder
// is an abstraction — no single fly carries it. This layer makes knowledge LIVE IN MINDS and PASS HAND TO HAND:
// an individual fly personally knows some rung, and one that feeds beside a cleverer mate can be TAUGHT it. So
// culture becomes genuinely CUMULATIVE (a student outstrips the teacher who first took it on) and, more
// importantly, FRAGILE — an art that no living hand was taught dies with its last keeper, even though ⑬'s
// ladder still "has" it. The gap between what the swarm invented and what it remembers is the whole story of
// this layer, and no other layer can tell it.
//
// THE ONE IRON RULE (same as culture's, faith's, the ladder's and the cities'): this is a PURE READ-OUT. It
// observes (tick, the feeding cohort, the highest rung the swarm has invented, each fly's house) and writes only
// its own bounded ledger. It never touches a connectome, a genome, a fingerprint, a manifest hash, a price or a
// purse — an apprentice learns nothing the ledger could not re-derive, and no lesson moves a coin. Pure function
// of its inputs: no Math.random, no Date.now, no LLM, no wall-clock. APPRENTICE_ENABLED=false (or never calling
// the hooks) restores today's byte-for-byte.
//
// It couples to ⑬ on purpose and only DOWNWARD: it reads the ladder's current top (inventedTop) as the ceiling
// on what any hand may learn — you cannot apprentice into an art your civilisation has not invented. If ⑬ is
// off there are no arts and this membrane simply never speaks. The learn/school rates are LANDSCAPE detector
// values (they shape WHEN a line is written, never WHAT it says), so — exactly like the ladder's gates and the
// settlements' ranks — they are NOT folded into chroniclerRulesHash: re-tuning the pace never rotates the
// historian's genome. Adding a KIND does, which is why these four events ship with the worker+frontend in one
// batch.

import { LADDER } from "./invention.js";
import type { FlyReading } from "./population.js";
import type { HouseBanner } from "./culture.js";

export interface ApprenticeConfig {
  enabled: boolean;      // APPRENTICE_ENABLED master switch (default ON in config.ts)
  learnPct: number;      // 0..1 — per contact pair per cron, P the less-skilled fly is taught its mate's art
  selfPct: number;       // 0..1 — per cron, P a cohort feeder independently grasps the highest invented art (seeds a keeper)
  schoolMin: number;     // living same-house keepers of one art that make it a SCHOOL (default 3)
}

/** Who taught a fly its current art, and how high that teacher had reached — the datum a surpass is measured against. */
interface Lineage {
  master: number;
  craftAtLesson: number;   // the rung this fly was first taught (its first teacher's ceiling)
  surpassed: boolean;      // has it since climbed above that first teacher (SURPASS already told)?
}

/** One named keeper, for the workshop read-out. */
export interface KeeperRecord {
  id: number;
  craft: number;           // the highest rung this mind personally knows (≥1)
  name: string;            // LADDER[craft].name
}

/** A school: an art held by enough kin in one house to outlive any single life. */
export interface SchoolRecord {
  rung: number;
  name: string;
  houseId: number;
  houseName: string;
  sigil: string;
  adherents: number;
}

/** The chronicle + endpoint read-out of ONE cron (recomputed each round; state.ts folds it into the context). */
export interface ApprenticeSignals {
  keepers: KeeperRecord[];      // living minds that carry at least one art, greatest craft first
  skilled: number;              // how many minds carry an art at all
  topCraft: number;             // the highest rung any living hand holds (0 ⇒ none)
  lineages: number;             // cumulative lessons taught since the membrane began (the ledger's tally)
  schools: SchoolRecord[];      // the schools standing right now
  transmission: { apprentice: number; master: number; rung: number; name: string } | null;
  surpass: { apprentice: number; master: number; rung: number; name: string } | null;
  school: SchoolRecord | null;
  craftLost: { rung: number; name: string; last: number } | null;
}

// --- bounded, deterministic constants (DO-safe: the ledger can never outgrow the live population) ---
const CONTACT_SALT = 0xa2ed;    // which cohort-mate you learn beside (culture uses 0xc0de; these never alias)
const LEARN_SALT = 0x1ea5;      // the teaching draw itself
const SELF_SALT = 0x5eed;       // the independent-grasp draw that seeds a keeper (0x5eed = "seed")
const CRAFT_CAP = 256;          // hard bound on simultaneous keepers (population cap is 256 anyway)
const LINEAGE_CAP = 256;        // hard bound on recorded first-teacher ties
const SCHOOL_CAP = 64;          // hard bound on announced (rung,house) school lines
const KEEPER_ROSTER = 32;       // how many keepers the drawer lists (bounded read-out, not the whole table)
const APPRENTICE_VERSION = 1;
const LADDER_LEN = LADDER.length;

/** The name of a rung, clamped to the ladder — the read-out must never index off the end. Rungs are 1-based (1..12). */
export const craftName = (rung: number): string => {
  const r = Number.isInteger(rung) && rung >= 1 && rung <= LADDER_LEN ? rung : 1;
  return LADDER[r - 1].name;
};

/**
 * The apprenticeship membrane: a per-DO singleton owning which mind carries which art and who taught whom.
 * state.ts drives it from the cron — round() once per cron over the first sub-tick's readings (the same cohort
 * culture reads). Everything is recomputed from (tick, cohort ids, inventedTop, houseOf), so a restored DO and
 * a fresh DO that see the same ticks agree byte-for-byte.
 */
export class ApprenticeMembrane {
  /** flyId → the highest rung this mind personally knows (≥1); a fly at 0 is simply absent. */
  private craft = new Map<number, number>();
  /** flyId → the first teacher it learned from, and that teacher's ceiling (the surpass datum). */
  private lineage = new Map<number, Lineage>();
  /** (rung:houseId) keys already announced as a school, so SCHOOL is one line per school, never a per-cron census. */
  private announced = new Set<string>();
  /** the highest rung the last round had at least one living keeper (the extinction edge is compared to this). */
  private topCraft = 0;
  /** cumulative lessons taught (the ledger's visible tally). */
  private lineages = 0;
  private lastTick = 0;
  private schools: SchoolRecord[] = [];
  private pending: Pick<ApprenticeSignals, "transmission" | "surpass" | "school" | "craftLost"> = {
    transmission: null, surpass: null, school: null, craftLost: null,
  };

  constructor(private readonly cfg: ApprenticeConfig) {}

  /** Living minds that carry at least one art (bounded; for tests + read-out). */
  get size(): number {
    return this.craft.size;
  }

  /** The highest rung any living hand carries (0 ⇒ nothing remembered). */
  top(): number {
    return this.topCraft;
  }

  /**
   * ONE round per cron over this cron's first sub-tick readings, in fixed order:
   * ① bury — drop every keeper no longer present, and if the swarm's highest remembered art has lost its last
   *    living hand, tell a CRAFT_LOST (knowledge is fragile: the ladder may still show it, no mind holds it);
   * ② learn — a feeder fed beside a cleverer mate is, behind a deterministic draw, taught that mate's art
   *    (capped at what the swarm has actually invented): a TRANSMISSION, and if it climbs past the first hand
   *    that taught it, a SURPASS; a rare feeder instead grasps the top invented art on its own, seeding a keeper;
   * ③ school — an art now held by enough kin of one house becomes a named SCHOOL, told once per (rung, house).
   * No reading is mutated and nothing is priced: this only records which minds carry which arts.
   */
  round(tick: number, readings: readonly FlyReading[], inventedTop: number, houseOf: (id: number) => HouseBanner | null): void {
    if (!this.cfg.enabled) return;
    this.lastTick = Math.max(0, Math.floor(tick));
    this.pending = { transmission: null, surpass: null, school: null, craftLost: null };
    const present = new Set<number>();
    for (const r of readings) present.add(r.id);

    // ① burial + extinction — capture the highest art any DYING keeper held, then drop the departed.
    const ceiling = Math.max(0, Math.min(LADDER_LEN, Math.floor(inventedTop)));
    let dyingTop = 0;
    let dyingTopId = -1;
    for (const [id, c] of this.craft) {
      if (!present.has(id) && c > dyingTop) { dyingTop = c; dyingTopId = id; }
    }
    for (const id of Array.from(this.craft.keys())) if (!present.has(id)) this.craft.delete(id);
    for (const id of Array.from(this.lineage.keys())) if (!present.has(id)) this.lineage.delete(id);

    // recompute the highest rung still covered by a LIVING hand (cumulative: craft ≥ r means the mind knows r too).
    let livingTop = 0;
    for (const c of this.craft.values()) if (c > livingTop) livingTop = c;
    // an art goes extinct exactly when the last living keeper of the swarm's top rung dies (and none higher lives).
    if (this.topCraft >= 1 && dyingTop >= 1 && livingTop < this.topCraft && dyingTopId >= 0) {
      this.pending.craftLost = { rung: this.topCraft, name: craftName(this.topCraft), last: dyingTopId };
    }
    this.topCraft = livingTop;

    // ② learning over the feeding cohort (identical adjacency proxy culture uses: at the food, or huddled).
    const cohort = readings.filter((r) => r.fap === "FEED" || r.fap === "FORAGE" || r.state === "AGGREGATE");
    if (cohort.length >= 1) {
      for (const b of cohort) {
        const cur = this.craft.get(b.id) ?? 0;
        if (cur >= ceiling) continue;                          // already at or above the swarm's whole ladder reach
        const src = cohort[hash32(tick, b.id, CONTACT_SALT) % cohort.length];
        const srcCraft = this.craft.get(src.id) ?? 0;
        const teachable = Math.min(srcCraft, ceiling);
        if (src.id !== b.id && teachable > cur && hash01(tick, src.id * 1000 + b.id, LEARN_SALT) < this.cfg.learnPct) {
          this.learn(b.id, src.id, teachable);
          continue;
        }
        // no teacher raised it: a rare feeder instead grasps the top invented art on its own and seeds a keeper.
        if (teachable <= cur && ceiling > cur && hash01(tick, b.id * 1000 + ceiling, SELF_SALT) < this.cfg.selfPct) {
          this.craft.set(b.id, ceiling);
        }
      }
    }

    // ③ schools — an art held by enough kin of one house to outlive a single life. Recomputed fresh each cron.
    const groups = new Map<string, SchoolRecord>();
    for (const [id, c] of this.craft) {
      if (c < 1) continue;
      const h = houseOf(id);
      if (!h) continue;                                        // a commoner carries an art, but not a school
      const key = `${c}:${h.id}`;
      const g = groups.get(key) ?? { rung: c, name: craftName(c), houseId: h.id, houseName: h.name, sigil: h.sigil, adherents: 0 };
      g.adherents++;
      groups.set(key, g);
    }
    this.schools = [];
    const minSchool = Math.max(2, Math.floor(this.cfg.schoolMin));
    // fixed ascending key order ⇒ deterministic regardless of Map insertion order
    for (const key of Array.from(groups.keys()).sort()) {
      const g = groups.get(key) as SchoolRecord;
      if (g.adherents < minSchool) continue;
      this.schools.push({ ...g });
      if (this.pending.school || this.announced.has(key)) continue;
      if (this.announced.size >= SCHOOL_CAP) continue;
      this.announced.add(key);
      this.pending.school = { ...g };                          // one school announced per cron
    }
  }

  /** One taught lesson: write the art, record the first teacher, and detect the student outstripping them. */
  private learn(pupil: number, teacher: number, rung: number): void {
    if (!this.craft.has(pupil) && this.craft.size >= CRAFT_CAP) return;   // a full ledger teaches no new minds
    this.craft.set(pupil, rung);
    this.lineages++;
    let lin = this.lineage.get(pupil);
    if (!lin) {
      if (this.lineage.size < LINEAGE_CAP) lin = { master: teacher, craftAtLesson: rung, surpassed: false }, this.lineage.set(pupil, lin);
    } else if (!lin.surpassed && rung > lin.craftAtLesson) {
      lin.surpassed = true;
      this.pending.surpass = { apprentice: pupil, master: lin.master, rung, name: craftName(rung) };
    }
    this.pending.transmission = { apprentice: pupil, master: teacher, rung, name: craftName(rung) };
  }

  /**
   * Chronicle + endpoint read-outs, recomputed from the ledger just kept (pure, never persists): the roster of
   * living keepers, the swarm's remembered peak, the standing schools, and this cron's four edge events.
   */
  signals(): ApprenticeSignals {
    const keepers: KeeperRecord[] = Array.from(this.craft.entries())
      .filter(([, c]) => c >= 1)
      .sort((x, y) => y[1] - x[1] || x[0] - y[0])
      .slice(0, KEEPER_ROSTER)
      .map(([id, c]) => ({ id, craft: c, name: craftName(c) }));
    return {
      keepers,
      skilled: this.craft.size,
      topCraft: this.topCraft,
      lineages: this.lineages,
      schools: this.schools.map((s) => ({ ...s })),
      ...this.pending,
    };
  }

  /** Persist the membrane ONLY: keepers + first-teacher ties + announced schools + tallies. Sorted + capped. */
  serialize(): string {
    return JSON.stringify({
      version: APPRENTICE_VERSION,
      craft: Array.from(this.craft.entries())
        .sort((x, y) => x[0] - y[0])
        .slice(0, CRAFT_CAP)
        .map(([id, c]) => ({ id, c })),
      lineage: Array.from(this.lineage.entries())
        .sort((x, y) => x[0] - y[0])
        .slice(0, LINEAGE_CAP)
        .map(([id, l]) => ({ id, m: l.master, k: l.craftAtLesson, s: l.surpassed ? 1 : 0 })),
      announced: Array.from(this.announced).sort().slice(0, SCHOOL_CAP),
      topCraft: this.topCraft,
      lineages: this.lineages,
      lastTick: this.lastTick,
    });
  }

  /** Restore from a stored blob; absent/corrupt/older-shape ⇒ an empty ledger (the arts are simply unwitnessed again). */
  restore(data?: string): void {
    this.craft.clear();
    this.lineage.clear();
    this.announced.clear();
    this.topCraft = 0;
    this.lineages = 0;
    this.lastTick = 0;
    this.schools = [];
    this.pending = { transmission: null, surpass: null, school: null, craftLost: null };
    if (!data) return;
    try {
      const p = JSON.parse(data);
      if (p?.version !== APPRENTICE_VERSION) return;
      if (Array.isArray(p.craft)) {
        for (const e of p.craft) {
          if (!e || typeof e !== "object") continue;
          const id = Number(e.id);
          const c = Number(e.c);
          if (!Number.isInteger(id) || !Number.isInteger(c) || c < 1 || c > LADDER_LEN) continue;
          if (this.craft.size >= CRAFT_CAP) break;
          this.craft.set(id, c);
        }
      }
      if (Array.isArray(p.lineage)) {
        for (const e of p.lineage) {
          if (!e || typeof e !== "object") continue;
          const id = Number(e.id);
          const m = Number(e.m);
          const k = Number(e.k);
          if (!Number.isInteger(id) || !Number.isInteger(m) || !Number.isInteger(k) || k < 0) continue;
          if (this.lineage.size >= LINEAGE_CAP) break;
          this.lineage.set(id, { master: m, craftAtLesson: k, surpassed: e.s === 1 });
        }
      }
      if (Array.isArray(p.announced)) {
        for (const key of p.announced) {
          if (typeof key !== "string" || this.announced.size >= SCHOOL_CAP) continue;
          this.announced.add(key);
        }
      }
      this.topCraft = Number.isFinite(Number(p.topCraft)) ? Math.max(0, Math.floor(Number(p.topCraft))) : 0;
      this.lineages = Number.isFinite(Number(p.lineages)) ? Math.max(0, Math.floor(Number(p.lineages))) : 0;
      this.lastTick = Number.isFinite(Number(p.lastTick)) ? Math.max(0, Math.floor(Number(p.lastTick))) : 0;
    } catch {
      this.craft.clear();
      this.lineage.clear();
      this.announced.clear();
    }
  }
}

/**
 * If APPRENTICE_ENABLED is off, return a null-object membrane whose every method is inert — one call-site shape
 * for state.ts, so no `if (apprentice)` branch can ever be forgotten.
 */
export const NULL_APPRENTICE = new ApprenticeMembrane({ enabled: false, learnPct: 0.22, selfPct: 0.05, schoolMin: 3 });

// FNV-1a 32-bit + a uniform 0..1 draw — the SAME construction as culture's, faith's and the ladder's private
// hash (duplicated by design: the layers stay independently testable; the salts differ, so an apprenticeship
// draw can never alias a cultural, faithful, economic or ladder one).
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
