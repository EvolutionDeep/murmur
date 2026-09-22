// RELIGION — ⑪ the faith membrane, a Lamarckian sister to culture.ts (packages/trader-worker/src/religion.ts).
//
// The swarm worships. Three faces of the Tape (SCORCH / DRIFT / FROST — the market regime personified) reign
// over the commoners, whose god turns with the market; every HOUSE keeps an ancestor cult — "the Old Way of
// {house}" — that does NOT follow the tape. Flies that WORSHIP side by side (the deterministic translation of
// "gathered at the shrine": the AGGREGATE state or the REST fap, since the swarm has no spatial coordinates)
// transmit their faith to each other; devotion kindles in the gathering and cools in silence. A fly whose
// devotion burns high enough while its sect holds a flock becomes a PROPHET; a house whose kin turn from the
// Old Way to a foreign sect is a SCHISM; a sect returning from zero souls is a REVIVAL; and every HOLY_EVERY
// crons a holy day falls, when the devoted lay down their trading (read-out fap → REST) and the houses that
// kept the Old Way walk a PILGRIMAGE to the ancestral shrine.
//
// THE ONE IRON RULE (same as culture's): this layer touches the READ-OUT line AFTER the neural decode and
// BEFORE every consumer (snapshot, economy, prediction) — and ONLY on a holy day, ONLY for the devoted. It
// never writes a connectome, a genome, a fingerprint or a manifest hash: the brain cannot be converted, only
// observed. Pure function of (tick, ids, hashes, regime) — no RNG, no LLM, no wall-clock. RELIGION_ENABLED=
// false (or never calling the hooks) restores today's byte-for-byte. Money never moves here: faith overrides
// WHICH rest a fly keeps; settlement stays the economy's.

import { FAP_ROLE, type Fap } from "@fly/fly-brain";
import type { FlyReading } from "./population.js";

/** The three faces of the Tape: the market regime personified as a god. */
export type God = "SCORCH" | "DRIFT" | "FROST";
export const GOD_LIST: God[] = ["SCORCH", "DRIFT", "FROST"];

/** Which god reigns over a market regime — the commoners' faith turns with the tape. */
export function reigningGod(regime: string): God {
  return regime === "HOT" ? "SCORCH" : regime === "COLD" ? "FROST" : "DRIFT";
}

/** A fly's house banner, as faith needs to see it (same shape culture receives). */
export interface HouseBanner {
  id: number;
  name: string;
  sigil: string;
  /** the founder's creed FAP frozen at founding — unused by faith, kept for banner-shape parity. */
  tradition: string | null;
}

/** The ancestor cult's sect name for a house — the shrine its kin are born to. */
export const oldWayOf = (h: HouseBanner): string => `the Old Way of ${h.name}`;

/** One fly's faith: which god, which sect (null ⇒ only the reigning god), and how devout (0..1). */
export interface FaithRecord {
  god: God;
  sect: string | null;
  /** 0..1; kindled by worshiping together, cooled by silence. Below devotionMin a fly skips the holy rest. */
  devotion: number;
}

export interface ReligionConfig {
  enabled: boolean;      // RELIGION_ENABLED master switch (default ON in config.ts)
  holyEvery: number;     // crons between holy days (default 48)
  devotionMin: number;   // devotion a fly needs to keep the holy rest / count on a pilgrimage (default 0.5)
  sectCap: number;       // hard bound on simultaneous sects (default 8)
}

/** A sect census row for the read-outs: name, god, souls, its prophet (if any), its house (if ancestral). */
export interface SectRow {
  name: string;
  god: God;
  adherents: number;
  prophetId: number | null;
  houseId: number | null;
}

/** The chronicle-facing events of ONE cron (recomputed every ritual; state.ts folds them into the context). */
export interface FaithSignals {
  reigning: God;
  /** crons until the next holy day (0 ⇒ this cron IS the holy day). */
  holyIn: number;
  sects: SectRow[];
  prophecy: { prophetId: number; sect: string; god: God; adherents: number } | null;
  schism: { houseId: number; name: string; sigil: string; sect: string } | null;
  revival: { sect: string; adherents: number } | null;
  pilgrimage: { houseId: number; name: string; sigil: string; adherents: number } | null;
}

// --- bounded, deterministic constants (DO-safe: the faith table can never outgrow the population) ---
const ADOPT_PCT = 0.22;            // per worship-pair per cron: P(the gathered fly catches the faith)
const DEVOTION_START = 0.6;        // devotion a caught faith begins with
const DEVOTION_GAIN = 0.12;        // kindled per cron spent worshiping in the cohort
const DEVOTION_DECAY = 0.05;       // cooled per cron away from the shrine
const PROPHET_DEVOTION = 0.8;      // devotion a fly needs to be heard as a prophet
const PROPHET_MIN_FLOCK = 3;       // souls a sect needs before its most devout is called a prophet
const REVIVE_MIN = 3;              // souls a silent sect must regain to be a REVIVAL
const FAITH_CAP = 64;              // hard bound on simultaneous faiths (population cap is 256 anyway)
const CONTACT_SALT = 0x9a17;       // which cohort-mate you worship beside this tick
const ADOPT_SALT = 0x2bde;         // the contagion draw itself

const FAITH_VERSION = 1;

/**
 * The faith membrane: a per-DO singleton owning the swarm's faiths. state.ts drives it from the cron —
 * ritual() once per cron (st === 0, after the first sub-tick's readings exist), apply() every sub-tick
 * before the readings reach the economy/snapshot (inert except on holy days). Everything is recomputed
 * from (tick, fly ids, hashes, regime), so a restored DO and a fresh DO that see the same ticks agree
 * byte-for-byte.
 */
export class FaithMembrane {
  private faiths = new Map<number, FaithRecord>();
  /** last cron's sect census — the silence a REVIVAL returns from, and the majority a SCHISM leaves. */
  private prevSects = new Map<string, number>();
  /** last cron's per-house majority sect (null ⇒ the reigning god, no sect) — the schism edge detector. */
  private prevHouseMajor = new Map<number, string | null>();
  /** the sect each currently-announced prophet leads; sect ⇒ prophet id (one voice per sect). */
  private prophets = new Map<string, number>();
  private pending: Omit<FaithSignals, "reigning" | "holyIn" | "sects"> = { prophecy: null, schism: null, revival: null, pilgrimage: null };
  private lastTick = 0;
  private banners = new Map<number, HouseBanner>();

  constructor(private readonly cfg: ReligionConfig) {}

  /** The faith fly `id` currently holds, or null ⇒ the fly keeps only the reigning god, unrecorded. */
  faithOf(id: number): FaithRecord | null {
    return this.faiths.get(id) ?? null;
  }

  /** Live faiths (bounded; for read-outs and tests). */
  get size(): number {
    return this.faiths.size;
  }

  /** Is this cron a holy day? (the devoted lay down their trading for one cron) */
  isHoly(tick: number): boolean {
    const every = Math.max(2, Math.floor(this.cfg.holyEvery));
    return tick % every === 0;
  }

  /**
   * ONE ritual round per cron over this cron's first sub-tick readings. Fixed deterministic order:
   * ① devotion cools everywhere; ② the worship cohort (AGGREGATE state or REST fap) gathers — each
   * gathered fly catches, from the single cohort-mate it deterministically worships beside, that mate's
   * (god, sect), and everyone in the cohort kindles; ③ the regime turn: unsected commoners follow the
   * tape to the new reigning god; ④ the census — sects, prophets, and the four chronicle events
   * (PROPHECY / SCHISM / REVIVAL / PILGRIMAGE) against last cron's census. No reading is mutated here;
   * the holy-day override is apply()'s job.
   */
  ritual(tick: number, readings: readonly FlyReading[], houseOf: (id: number) => HouseBanner | null, regime: string): void {
    if (!this.cfg.enabled) return;
    this.lastTick = tick;
    this.banners.clear();
    const reign = reigningGod(regime);
    // ① the cooling of silence — every faith loses devotion once per cron.
    for (const [id, f] of this.faiths) {
      f.devotion = Math.max(0, f.devotion - DEVOTION_DECAY);
      if (f.devotion <= 0 && f.sect === null) this.faiths.delete(id);   // a commoner's lapse ends the record
    }
    // ② the gathering: contact + contagion + kindling.
    const cohort = readings.filter((r) => r.state === "AGGREGATE" || r.fap === "REST");
    for (const b of cohort) {
      const hb = houseOf(b.id);
      if (hb) this.banners.set(hb.id, hb);
      const cur = this.faiths.get(b.id);
      if (cur) cur.devotion = Math.min(1, cur.devotion + DEVOTION_GAIN);
      if (cohort.length < 2) continue;
      const src = cohort[hash32(tick, b.id, CONTACT_SALT) % cohort.length];
      if (src.id === b.id) continue;                        // worshiped alone beside oneself: no contact
      if (hash01(tick, src.id * 1000 + b.id, ADOPT_SALT) >= ADOPT_PCT) continue;
      const sf = this.faiths.get(src.id);
      const caughtGod = sf ? sf.god : reign;
      const caughtSect = sf ? sf.sect : hb ? oldWayOf(hb) : null;
      if (cur && cur.god === caughtGod && cur.sect === caughtSect) continue;   // already of this faith
      if (!sf && !hb) continue;                           // nothing to catch: an unsected commoner source
      this.adopt(b.id, caughtGod, caughtSect ?? (hb ? oldWayOf(hb) : null));
    }
    // a house fly with no recorded faith yet, gathered at the shrine, remembers its ancestral cult
    for (const b of cohort) {
      if (this.faiths.has(b.id)) continue;
      const hb = houseOf(b.id);
      if (!hb) continue;
      this.banners.set(hb.id, hb);
      this.adopt(b.id, reign, oldWayOf(hb));
    }
    // ③ the tape turns: unsected recorded commoners follow the reigning god (houses never do).
    for (const f of this.faiths.values()) if (f.sect === null) f.god = reign;
    // ④ the census and its four events.
    this.census(tick, readings, houseOf, reign);
  }

  /** One conversion: write the faith with a fresh devotion; bounded — a full membrane takes no new souls. */
  private adopt(id: number, god: God, sect: string | null): void {
    const cur = this.faiths.get(id);
    if (!cur && this.faiths.size >= FAITH_CAP) return;
    const kept = cur && cur.sect === sect ? cur.devotion : DEVOTION_START;
    this.faiths.set(id, { god, sect, devotion: Math.min(1, Math.max(kept, DEVOTION_START)) });
  }

  /**
   * Override each reading to the holy rest on a holy day (role recomputed through FAP_ROLE, the same
   * decode table the brain's own output uses). Inert on every other cron and for the lukewarm — so this
   * is safe to call unconditionally and byte-for-byte inert when the switch is off or the day is plain.
   */
  apply(readings: FlyReading[], tick: number): number {
    if (!this.cfg.enabled || !this.isHoly(tick)) return 0;
    let n = 0;
    for (const r of readings) {
      const f = this.faiths.get(r.id);
      if (!f || f.devotion < this.cfg.devotionMin) continue;
      if (r.fap === "REST") continue;
      r.fap = "REST" as Fap;
      r.role = FAP_ROLE.REST;
      n++;
    }
    return n;
  }

  /**
   * The census: sect adherent counts, one prophet per qualifying sect, and the four chronicle events
   * measured against LAST cron's census (a landscape detector — each event is an EDGE, never a census).
   */
  private census(tick: number, readings: readonly FlyReading[], houseOf: (id: number) => HouseBanner | null, reign: God): void {
    void tick;
    const counts = new Map<string, { god: God; houseId: number | null; n: number; best: number; bestId: number | null }>();
    const houseMajor = new Map<number, Map<string, number>>();
    for (const r of readings) {
      const f = this.faiths.get(r.id);
      const hb = houseOf(r.id);
      if (hb) this.banners.set(hb.id, hb);
      const sect = f?.sect ?? null;
      const god = f?.god ?? reign;
      if (sect) {
        const e = counts.get(sect) ?? { god, houseId: null, n: 0, best: -1, bestId: null };
        e.n++;
        const dev = f?.devotion ?? 0;
        if (dev > e.best) { e.best = dev; e.bestId = r.id; }
        counts.set(sect, e);
      }
      if (hb) {
        const m = houseMajor.get(hb.id) ?? new Map<string, number>();
        const key = sect ?? "";
        m.set(key, (m.get(key) ?? 0) + 1);
        houseMajor.set(hb.id, m);
      }
    }
    // bind each sect to the house whose ancestral cult it is (name match), else null
    for (const [name, e] of counts) {
      for (const hb of this.banners.values()) if (oldWayOf(hb) === name) e.houseId = hb.id;
    }
    // prophets: the most devout soul of a sect with a flock, burning above PROPHET_DEVOTION
    const prophets = new Map<string, number>();
    for (const [name, e] of counts) {
      if (e.n >= PROPHET_MIN_FLOCK && e.best >= PROPHET_DEVOTION && e.bestId != null) prophets.set(name, e.bestId);
    }
    this.prophets = prophets;
    // --- the four events, each an edge against last cron's census ---
    this.pending = { prophecy: null, schism: null, revival: null, pilgrimage: null };
    // PROPHECY — a sect that had no prophet last cron now has one (first by sect name for determinism).
    for (const name of Array.from(prophets.keys()).sort()) {
      const e = counts.get(name);
      if (!e) continue;
      const had = this.prevProphetSects.has(name);
      if (!had) {
        this.pending.prophecy = { prophetId: prophets.get(name) as number, sect: name, god: e.god, adherents: e.n };
        break;
      }
    }
    // REVIVAL — a sect at zero souls last cron, back with a flock (first by name).
    for (const name of Array.from(counts.keys()).sort()) {
      const e = counts.get(name);
      if (!e || e.n < REVIVE_MIN) continue;
      if ((this.prevSects.get(name) ?? 0) === 0 && this.prevSects.size > 0 && this.seenOnce) {
        this.pending.revival = { sect: name, adherents: e.n };
        break;
      }
    }
    // SCHISM — a house whose present majority sect is foreign though last cron's majority was the Old Way.
    for (const houseId of Array.from(houseMajor.keys()).sort((x, y) => x - y)) {
      const m = houseMajor.get(houseId);
      const hb = this.banners.get(houseId);
      if (!m || !hb) continue;
      let total = 0, topKey = "", top = 0;
      for (const [k, v] of m) { total += v; if (v > top) { top = v; topKey = k; } }
      if (total < 2 || top * 2 < total) continue;
      const majority = topKey === "" ? null : topKey;
      const prev = this.prevHouseMajor.get(houseId);
      if (prev === oldWayOf(hb) && majority !== null && majority !== oldWayOf(hb)) {
        this.pending.schism = { houseId, name: hb.name, sigil: hb.sigil, sect: majority };
      }
      this.prevHouseMajor.set(houseId, majority);
      if (this.pending.schism) break;
    }
    for (const id of Array.from(this.prevHouseMajor.keys())) if (!houseMajor.has(id)) this.prevHouseMajor.delete(id);
    // PILGRIMAGE — on a holy day, the first house (by id) whose devoted majority kept the Old Way.
    if (this.isHoly(this.lastTick)) {
      for (const houseId of Array.from(houseMajor.keys()).sort((x, y) => x - y)) {
        const m = houseMajor.get(houseId);
        const hb = this.banners.get(houseId);
        if (!m || !hb) continue;
        const kept = m.get(oldWayOf(hb)) ?? 0;
        let total = 0; for (const v of m.values()) total += v;
        if (total >= 2 && kept * 2 >= total && kept >= 2) {
          this.pending.pilgrimage = { houseId, name: hb.name, sigil: hb.sigil, adherents: kept };
          break;
        }
      }
    }
    // roll the census forward
    this.prevSects = new Map();
    for (const [name, e] of counts) this.prevSects.set(name, e.n);
    this.prevProphetSects = new Set(prophets.keys());
    this.seenOnce = true;
    this.lastCounts = counts;
  }

  private prevProphetSects = new Set<string>();
  private seenOnce = false;
  private lastCounts = new Map<string, { god: God; houseId: number | null; n: number; best: number; bestId: number | null }>();

  /**
   * Chronicle + endpoint read-outs, recomputed from the census just taken (pure, never persists):
   * the reigning god, the holy-day countdown, the sect table with prophets, and this cron's four events.
   */
  signals(readings: readonly FlyReading[], regime: string): FaithSignals {
    void readings;
    const every = Math.max(2, Math.floor(this.cfg.holyEvery));
    const sects: SectRow[] = Array.from(this.lastCounts.entries())
      .sort((x, y) => y[1].n - x[1].n || (x[0] < y[0] ? -1 : 1))
      .slice(0, Math.max(1, Math.floor(this.cfg.sectCap)))
      .map(([name, e]) => ({
        name, god: e.god, adherents: e.n,
        prophetId: this.prophets.get(name) ?? null,
        houseId: e.houseId,
      }));
    return {
      reigning: reigningGod(regime),
      holyIn: this.isHoly(this.lastTick) ? 0 : every - (this.lastTick % every),
      sects,
      ...this.pending,
    };
  }

  /** Persist the membrane ONLY: {version, faiths[], prevSects[], prevHouseMajor[]} sorted + capped. */
  serialize(): string {
    return JSON.stringify({
      version: FAITH_VERSION,
      faiths: Array.from(this.faiths.entries())
        .sort((x, y) => x[0] - y[0])
        .slice(0, FAITH_CAP)
        .map(([id, f]) => ({ id, god: f.god, sect: f.sect, devotion: Math.round(f.devotion * 1000) / 1000 })),
      prevSects: Array.from(this.prevSects.entries()).sort((x, y) => (x[0] < y[0] ? -1 : 1)),
      prevHouseMajor: Array.from(this.prevHouseMajor.entries()).sort((x, y) => x[0] - y[0]),
      lastTick: this.lastTick,
    });
  }

  /** Restore from a stored blob; absent/corrupt/older-shape ⇒ an empty membrane (faith restarts, ledger untouched). */
  restore(data?: string): void {
    this.faiths.clear();
    this.prevSects.clear();
    this.prevHouseMajor.clear();
    this.prophets.clear();
    this.seenOnce = false;
    if (!data) return;
    try {
      const p = JSON.parse(data);
      if (p?.version !== FAITH_VERSION || !Array.isArray(p.faiths)) return;
      for (const e of p.faiths) {
        if (!e || typeof e !== "object") continue;
        const id = Number(e.id);
        const dev = Number(e.devotion);
        if (!Number.isInteger(id) || !Number.isFinite(dev)) continue;
        if (typeof e.god !== "string" || !GOD_LIST.includes(e.god as God)) continue;
        if (e.sect !== null && typeof e.sect !== "string") continue;
        if (this.faiths.size >= FAITH_CAP) break;
        this.faiths.set(id, { god: e.god as God, sect: e.sect as string | null, devotion: Math.min(1, Math.max(0, dev)) });
      }
      if (Array.isArray(p.prevSects)) for (const [k, v] of p.prevSects) if (typeof k === "string" && Number.isFinite(Number(v))) this.prevSects.set(k, Number(v));
      if (Array.isArray(p.prevHouseMajor)) for (const [k, v] of p.prevHouseMajor) if (Number.isInteger(Number(k))) this.prevHouseMajor.set(Number(k), v === null ? null : String(v));
      this.lastTick = Number.isInteger(Number(p.lastTick)) ? Number(p.lastTick) : 0;
      this.seenOnce = this.prevSects.size > 0;
    } catch {
      this.faiths.clear();
      this.prevSects.clear();
      this.prevHouseMajor.clear();
    }
  }
}

/**
 * If RELIGION_ENABLED is off, return a null-object membrane whose every method is inert — one call
 * site shape for state.ts, so no `if (religion)` branch can ever be forgotten.
 */
export const NULL_RELIGION = new FaithMembrane({ enabled: false, holyEvery: 48, devotionMin: 0.5, sectCap: 8 });

// FNV-1a 32-bit + uniform 0..1 draw — the SAME construction as culture's private hash32/hash01 (duplicated
// by design: the layers stay independently testable; the salts differ, so faith's draws can never alias
// a cultural or economic draw).
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
