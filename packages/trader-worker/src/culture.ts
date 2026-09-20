// CULTURE — a Lamarckian layer above the Darwinian genome (packages/trader-worker/src/culture.ts).
//
// Flies that FEED side by side (the deterministic translation of "eating next to each other": same
// feeding cohort this tick — a FEED/FORAGE FAP or the AGGREGATE state, since the swarm has no spatial
// coordinates) briefly transmit their current FAP preference to each other. A adopted creed overrides
// the decoded reading for a bounded TTL, then decays back to the innate FAP — so fashions (fast,
// contact-borne) emerge orthogonal to genetic evolution (slow, selection-borne), and HOUSES, holding the
// founder's creed as TRADITION, act as breakwaters: a home-bred fly hit by a contrary fashion may
// "hold to the old way" and adopt its house's tradition instead.
//
// THE ONE IRON RULE: this layer touches the READ-OUT line AFTER the neural decode — the same layer
// computeBands already occupies — and runs BEFORE every consumer (frontend snapshot, economy,
// prediction). It never writes a connectome, a genome, a fingerprint or a manifest hash: the brain
// cannot be conditioned, only observed. Pure function of (tick, ids, hashes) — no RNG, no LLM, no
// wall-clock; CULTURE_ENABLED=false (or never calling the hooks) restores today's byte-for-byte.
//
// Money never moves here: culture overrides WHICH good a fly wants; settlement stays the economy's.

import { FAP_LIST, FAP_ROLE, type Fap } from "@fly/fly-brain";
import type { FlyReading } from "./population.js";

/** A fly's house banner, as culture needs to see it (economy.houseOf's shape; null ⇒ commoner). */
export interface HouseBanner {
  id: number;
  name: string;
  sigil: string;
  /** the founder's creed FAP frozen at founding — the house's old way, or null when unknown. */
  tradition: string | null;
}

/** One fly's adopted creed: which FAP it currently believes in, and how many crons it will keep. */
export interface MemeRecord {
  fap: Fap;
  /** remaining sub-ticks of belief; ≤0 ⇒ the meme dies and the fly reverts to its innate FAP. */
  ttl: number;
}

export interface CultureConfig {
  enabled: boolean; // CULTURE_ENABLED master switch (default ON in config.ts)
}

/** The trend signal for the chronicle: one FAP carrying the swarm right now. */
export interface TrendSignal {
  fap: Fap;
  adherents: number;      // flies whose current creed is this FAP
  share: number;          // adherents / population
}

/** The tradition signal: a house that has HELD its old way against the fashion for K crons. */
export interface TraditionSignal {
  houseId: number;
  name: string;
  sigil: string;
  fap: Fap;
  streak: number;         // consecutive crons the house's members held majority-tradition
}

// --- bounded, deterministic constants (DO-safe: the meme table can never outgrow the population) ---
const ADOPT_PCT = 0.18;            // per contact pair per cron: P(the fed-to fly catches the creed)
const TTL_MIN = 18;                // crons a caught creed persists (TTL burns once per cron, in contagion)
const TTL_MAX = 42;                // upper bound; the exact hold is a hash draw in [MIN, MAX] crons
const TRADITION_HOLD_PCT = 0.35;   // P a house fly rebuffs a contrary fashion and keeps the old way
const MEME_CAP = 64;               // hard bound on simultaneous creeds (population cap is 256 anyway)
const TRADITION_MIN_STREAK = 8;    // crons of majority-held tradition before the chronicle calls it one
const CONTACT_SALT = 0xc0de;       // which cohort-mate you eat beside this tick
const ADOPT_SALT = 0x1cea;         // the contagion draw itself
const HOLD_SALT = 0x7aad;          // the tradition-hold draw
const TTL_SALT = 0x777c;           // how long the caught creed burns

const MEME_VERSION = 1;

/**
 * The culture membrane: a per-DO singleton owning the swarm's adopted creeds. state.ts drives it from
 * the cron — contagion() once per cron (st === 0, after the first sub-tick's readings exist), apply()
 * every sub-tick before the readings reach the economy/snapshot. Everything is recomputed from
 * (tick, fly ids, hashes), so a restored DO and a fresh DO that see the same ticks agree byte-for-byte.
 */
export class CultureMembrane {
  private memes = new Map<number, MemeRecord>();
  /** per-house streak of consecutive crons the present members held majority tradition. */
  private streaks = new Map<number, { fap: Fap; streak: number }>();
  /** crons observed since birth — diagnostic only, never an input (tick is the real clock). */
  private crons = 0;

  constructor(private readonly cfg: CultureConfig) {}

  /** The FAP fly `id` currently acts on: its adopted creed while alive, else the innate decode. */
  creedOf(id: number, innate: Fap): Fap {
    const m = this.memes.get(id);
    return m && m.ttl > 0 ? m.fap : innate;
  }

  /** Live creeds (bounded; for /status-style read-outs and tests). */
  get size(): number {
    return this.memes.size;
  }

  /**
   * ONE contagion round per cron over this cron's first sub-tick readings. Order is fixed and
   * deterministic: ① every creed burns one cron-worth of TTL (expired memes die first, so a fly
   * that is no longer believing can still be a carrier again from its own innate FAP — handled by
   * ②, which reads creeds AFTER decay, exactly like a real fashion that already faded cannot
   * infect); ② each feeder catches, from the single cohort-mate it deterministically eats beside,
   * that mate's current creed — unless the feeder belongs to a house whose tradition forbids the
   * new way, in which case the hold draw converts the adoption into a reaffirmation of the old;
   * ③ houses score their tradition-streak for the chronicle. No reading is mutated here; the
   * override is apply()'s job.
   */
  contagion(tick: number, readings: readonly FlyReading[], houseOf: (id: number) => HouseBanner | null): void {
    if (!this.cfg.enabled) return;
    this.crons++;
    // ① TTL burn — once per cron; apply() re-reads the same meme on every sub-tick in between.
    for (const [id, m] of this.memes) {
      m.ttl--;
      if (m.ttl <= 0) this.memes.delete(id);
    }
    // ② contact + infection. The cohort: flies at the food — FEED/FORAGE faps, or the huddle state
    // (AGGREGATE gathers at one feeder). Sorted by id via the readings' own order (population order).
    const cohort = readings.filter((r) => r.fap === "FEED" || r.fap === "FORAGE" || r.state === "AGGREGATE");
    if (cohort.length < 2) { this.streakTick(readings, houseOf); return; }
    for (const b of cohort) {
      const src = cohort[hash32(tick, b.id, CONTACT_SALT) % cohort.length];
      if (src.id === b.id) continue;                       // ate alone beside oneself: no contact
      if (hash01(tick, src.id * 1000 + b.id, ADOPT_SALT) >= ADOPT_PCT) continue;
      const caught = this.creedOf(src.id, src.fap);         // infection after decay: faded creeds don't spread
      if (caught === b.fap) continue;                       // already believes it: nothing new caught
      const house = houseOf(b.id);
      const trad = house?.tradition && FAP_LIST.includes(house.tradition as Fap)
        ? (house.tradition as Fap)
        : null;
      // The house as breakwater: a contrary fashion meets the old way — hold, or convert to the old.
      if (trad && caught !== trad && hash01(tick, b.id, HOLD_SALT) < TRADITION_HOLD_PCT) {
        this.adopt(b.id, trad, tick);
        continue;
      }
      this.adopt(b.id, caught, tick);
    }
    // ③ tradition streaks for the chronicle's TRADITION signal.
    this.streakTick(readings, houseOf);
  }

  /** One adoption: write the creed with a hash-drawn TTL; bounded — a full membrane takes no new beliefs. */
  private adopt(id: number, fap: Fap, tick: number): void {
    const cur = this.memes.get(id);
    if (!cur && this.memes.size >= MEME_CAP) return;
    const span = TTL_MAX - TTL_MIN + 1;
    const ttl = TTL_MIN + Math.floor(hash01(tick, id, TTL_SALT) * span);
    this.memes.set(id, { fap, ttl });
  }

  /**
   * Override each reading to its adopted creed (role recomputed through FAP_ROLE, the same decode
   * table the brain's own output uses — bouts stay untouched: they are neural history, and history
   * is not rewritten by fashion). Returns how many readings were overridden; 0 while disabled —
   * so this is safe to call unconditionally and byte-for-byte inert when the switch is off.
   */
  apply(readings: FlyReading[]): number {
    if (!this.cfg.enabled) return 0;
    let n = 0;
    for (const r of readings) {
      const m = this.memes.get(r.id);
      if (!m || m.ttl <= 0 || m.fap === r.fap) continue;
      r.fap = m.fap;
      r.role = FAP_ROLE[m.fap];
      n++;
    }
    return n;
  }

  /**
   * Chronicle read-outs, recomputed from THIS cron's readings (pure, never persists):
   * TREND — a strict majority creed (≥3 adherents and >25% of the swarm: a habit is not a fashion);
   * TRADITION — the first house whose old way has held majority support TRADITION_MIN_STREAK crons on.
   */
  signals(readings: readonly FlyReading[]): { trend: TrendSignal | null; tradition: TraditionSignal | null } {
    const counts = new Map<Fap, number>();
    for (const r of readings) {
      const creed = this.creedOf(r.id, r.fap);
      counts.set(creed, (counts.get(creed) ?? 0) + 1);
    }
    let trend: TrendSignal | null = null;
    const total = readings.length;
    if (total > 0) {
      // FAP_LIST order breaks count ties: deterministic regardless of reading order.
      for (const fap of FAP_LIST) {
        const c = counts.get(fap) ?? 0;
        if (c >= 3 && c / total > 0.25 && (!trend || c > trend.adherents)) {
          trend = { fap, adherents: c, share: c / total };
        }
      }
    }
    let tradition: TraditionSignal | null = null;
    for (const houseId of Array.from(this.streaks.keys()).sort((x, y) => x - y)) {
      const st = this.streaks.get(houseId);
      const banner = this.streakBanner(houseId);
      if (!st || !banner || st.streak < TRADITION_MIN_STREAK) continue;
      tradition = { houseId, name: banner.name, sigil: banner.sigil, fap: st.fap, streak: st.streak };
      break;
    }
    return { trend, tradition };
  }

  /** banner cache for signals(): streakTick stores the house it saw, so no houseOf re-call per read. */
  private banners = new Map<number, HouseBanner>();
  private streakBanner(id: number): HouseBanner | null {
    return this.banners.get(id) ?? null;
  }

  /** ③ — for every house with a tradition, did the members present THIS cron hold it by majority? */
  private streakTick(readings: readonly FlyReading[], houseOf: (id: number) => HouseBanner | null): void {
    const seen = new Map<number, { trad: Fap; present: number; holding: number }>();
    this.banners.clear();
    for (const r of readings) {
      const h = houseOf(r.id);
      if (!h || !h.tradition || !FAP_LIST.includes(h.tradition as Fap)) continue;
      this.banners.set(h.id, h);
      const e = seen.get(h.id) ?? { trad: h.tradition as Fap, present: 0, holding: 0 };
      e.present++;
      if (this.creedOf(r.id, r.fap) === e.trad) e.holding++;
      seen.set(h.id, e);
    }
    for (const id of Array.from(this.streaks.keys())) if (!seen.has(id)) this.streaks.delete(id);
    for (const [id, e] of seen) {
      const held = e.present >= 2 && e.holding * 2 >= e.present;   // a majority of a real crowd, not one loyalist
      const prev = this.streaks.get(id);
      this.streaks.set(id, { fap: e.trad, streak: held ? (prev?.streak ?? 0) + 1 : 0 });
    }
  }

  /** Persist the membrane ONLY (streaks are recomputed each cron): {version, memes[]} sorted + capped. */
  serialize(): string {
    return JSON.stringify({
      version: MEME_VERSION,
      memes: Array.from(this.memes.entries())
        .sort((x, y) => x[0] - y[0])
        .slice(0, MEME_CAP)
        .map(([id, m]) => ({ id, fap: m.fap, ttl: m.ttl })),
    });
  }

  /** Restore from a stored blob; absent/corrupt/older-shape ⇒ an empty membrane (culture just restarts). */
  restore(data?: string): void {
    this.memes.clear();
    this.streaks.clear();
    if (!data) return;
    try {
      const p = JSON.parse(data);
      if (p?.version !== MEME_VERSION || !Array.isArray(p.memes)) return;
      for (const e of p.memes) {
        if (!e || typeof e !== "object") continue;
        const id = Number(e.id);
        const ttl = Number(e.ttl);
        if (!Number.isInteger(id) || !Number.isInteger(ttl) || ttl <= 0) continue;
        if (typeof e.fap !== "string" || !FAP_LIST.includes(e.fap as Fap)) continue;
        if (this.memes.size >= MEME_CAP) break;
        this.memes.set(id, { fap: e.fap as Fap, ttl });
      }
    } catch {
      this.memes.clear();
    }
  }
}

/**
 * If CULTURE_ENABLED is off, return a null-object membrane whose every method is inert — one call
 * site shape for state.ts, so no `if (culture)` branch can ever be forgotten.
 */
export const NULL_CULTURE = new CultureMembrane({ enabled: false });

// FNV-1a 32-bit + uniform 0..1 draw — the SAME construction as the economy's private hash32/hash01
// (duplicated by design: the layers stay independently testable and neither imports the other's RNG
// discipline; the salts differ, so culture's draws can never alias an economic draw).
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
