// CITIES — ⑭ settlements and the census (packages/trader-worker/src/cities.ts).
//
// The swarm settles. Until now a house's ground was an economic fact only — a zone on a fixed 4×4 grid that
// re-priced a deal (a home discount, a foreign toll, a tribute to whoever holds it). This layer reads the SAME
// zone map and turns it into GEOGRAPHY: a zone where enough kin live becomes a named settlement, ranked
// hamlet → town → city, and the roads between the two greatest of them are where the rot walks when burials
// come in waves. Beside the map it keeps the swarm's first DEMOGRAPHY — a census taken once a generation on
// ⑫'s fast clock, with the mean life span read off the graves the ledger already keeps.
//
// THE ONE IRON RULE (same as culture's, faith's and the ladder's): this is a PURE READ-OUT. It observes the
// zone map, the grave ring and the swarm's size, and writes only its own bounded ledger. It never moves a fly,
// never re-prices a deal, never touches a connectome, a genome, a fingerprint, a manifest hash or a purse —
// and it does NOT model contagion: a plague wave is NARRATED over the burials the economy already recorded,
// never caused. Pure function of its inputs: no Math.random, no Date.now, no LLM, no wall-clock.
// CITIES_ENABLED=false (or never calling the hooks) restores today's byte-for-byte.
//
// The rank thresholds and the urban share are LANDSCAPE detector values (they shape WHEN a line is written,
// never WHAT it says), so — exactly like the ladder's gates and the ages' thresholds — they are NOT folded
// into chroniclerRulesHash. Re-tuning them never rotates the historian's genome.

/** A settlement's rank on the ladder of urbanisation. */
export type SettlementRank = "HAMLET" | "TOWN" | "CITY";

/**
 * THE SETTLEMENT NAMES — sixteen, one per zone of the fixed 4×4 grid, indexed by zone so a place NEVER changes
 * its name and never collides with another. Public and permanent: a name is written into the chronicle's hash
 * chain the moment the settlement is founded, so this table is part of the swarm's recorded history.
 */
export const SETTLEMENT_NAMES: string[] = [
  "Ashgate", "Brambleford", "Cinderwick", "Dunmarrow",
  "Emberholt", "Fenreach", "Glimhollow", "Huskbourne",
  "Ironmoot", "Juniperrow", "Kilnstead", "Loomfare",
  "Maltreach", "Netherspill", "Ostrivey", "Pyrewick",
];

export interface CitiesConfig {
  enabled: boolean;      // CITIES_ENABLED master switch (default ON in config.ts)
  hamletMin: number;     // living kin a zone needs to become a named hamlet (default 2)
  townMin: number;       // …to grow into a town (default 5)
  cityMin: number;       // …to be counted a city (default 9)
  urbanShare: number;    // share of the live swarm in settlements that makes the swarm "urban" (default 0.35)
}

/** One named settlement, as the map keeps it. */
export interface Settlement {
  zone: number;
  name: string;
  rank: SettlementRank;
  pop: number;                 // living minds sitting in this zone
  houseId: number | null;      // the house that holds the ground, if any
  houseName: string | null;
  sigil: string | null;
}

/** The facts one cron offers the survey (all of them already computed by the economy — nothing is re-derived). */
export interface CitySurveyInput {
  tick: number;
  /** the live swarm size (the census's "minds alive"). */
  size: number;
  /** flyId → zone for every LIVING zoned fly; null while the territory layer is off ⇒ no settlements at all. */
  zones: Record<number, number> | null;
  /** zone → the house that holds it (the settlement's banner); absent while territory is off. */
  zoneOwners?: { zone: number; houseId: number; name: string; sigil: string }[] | null;
  /** the ledger's grave ring (bounded, newest first) — the demography's only honest sample of mortality. */
  graves: { tick: number; age: number; cause: string }[];
  living: number;
  dead: number;
  /** burials inside the recent tick window (the same count the historian's PLAGERA shock reads). */
  deathsRecent: number;
}

/** The chronicle-facing read-out of ONE cron (recomputed each survey; state.ts folds it into the context). */
export interface CitySignals {
  settlements: Settlement[];
  /** minds living in a named settlement, and their share of the live swarm. */
  urbanPop: number;
  urbanShare: number;
  largest: { name: string; pop: number; rank: SettlementRank } | null;
  /** the road between the two greatest settlements — the route a plague wave walks. */
  road: { a: string; b: string } | null;
  demography: {
    size: number; living: number; dead: number;
    graves: number;                 // how many burials the mean is read off (the ring, never the whole history)
    meanAge: number | null;         // mean sub-ticks lived, across those graves
    topCause: string | null;        // the commonest cause of death in the ring
    births: number;                 // hatchings since the last census
    deaths: number;                 // burials since the last census
    generation: number;
  };
  founding: Settlement | null;
  urbanization: { urban: number; size: number; settlements: number; largest: string; largestPop: number; share: number } | null;
  census: { size: number; meanAge: number; graves: number; births: number; deaths: number; gen: number } | null;
  plagueWave: { deaths: number; a: string; b: string } | null;
}

// --- bounded, deterministic constants (DO-safe: the map can never outgrow the sixteen-zone grid) ---
const URBAN_RESET_GAP = 0.1;   // the urban share must fall this far below the threshold before it is news again
const PLAGUE_DEATHS = 3;       // burials in the recent window that make a wave (mirrors the historian's PLAGERA_DEATHS)
const PLAGUE_GAP_CRONS = 8;    // crons between two wave lines, so a long dying is a chapter and not a stutter
const PLAGUE_MIN_SETTLEMENTS = 2;   // a wave needs two places to walk between
const CITY_VERSION = 1;
const NAME_COUNT = SETTLEMENT_NAMES.length;

/** The settlement name of a zone — fixed forever, indexed by the zone itself. */
export const settlementName = (zone: number): string =>
  SETTLEMENT_NAMES[((zone % NAME_COUNT) + NAME_COUNT) % NAME_COUNT];

/** The banner line for a settlement: the house that holds the ground, or nobody in particular. */
export const houseCreditOf = (houseName: string | null): string =>
  houseName ? `the House of ${houseName}` : "no house";

/**
 * The city membrane: a per-DO singleton owning the settlement map and the census. state.ts drives it from the
 * cron — survey() once per cron, turnGeneration() only on the historian's generation edge. Everything is
 * recomputed from the economy's own read-out, so a restored DO and a fresh DO that see the same inputs agree
 * byte-for-byte.
 */
export class CityMembrane {
  private settlements: Settlement[] = [];
  /** zones already announced as founded, so CITY_FOUNDED is one line per place, never a per-cron census. */
  private announced = new Set<number>();
  private urbanAnnounced = false;
  /** the two greatest settlements last survey — the road a plague wave walks. */
  private road: { a: string; b: string } | null = null;
  private lastShare = 0;
  private lastSize = 0;
  private lastCron = 0;          // crons surveyed (the wave's pacing clock; ticks alone would drift with sub-tick counts)
  private lastPlagueCron = -1e9;
  private lastCensusTick = 0;
  private lastCensusGen = -1;
  private lastSurveyTick = 0;      // the tick the last survey saw — one cron's worth of burials is (tick, lastSurveyTick]
  private sizeKnown = false;       // false until a second survey, so a fresh membrane never counts the whole swarm as born
  private lastGen = 0;
  private birthsSince = 0;
  private deathsSince = 0;
  private demography: CitySignals["demography"] = {
    size: 0, living: 0, dead: 0, graves: 0, meanAge: null, topCause: null, births: 0, deaths: 0, generation: 0,
  };
  private pending: Pick<CitySignals, "founding" | "urbanization" | "census" | "plagueWave"> = {
    founding: null, urbanization: null, census: null, plagueWave: null,
  };

  constructor(private readonly cfg: CitiesConfig) {}

  get size(): number {
    return this.settlements.length;
  }

  /** The generation of the last census this map struck (0 ⇒ none yet) — how state.ts finds the edge. */
  generation(): number {
    return this.lastGen;
  }

  /** The settlements as last surveyed, greatest first (for read-outs and tests). */
  map(): Settlement[] {
    return this.settlements.map((s) => ({ ...s }));
  }

  /**
   * ONE survey per cron: rebuild the map from the economy's zone ledger, take the demography off the grave
   * ring, and detect this cron's three map events (a founding, the swarm turning urban, a plague walking the
   * road). The census itself is the generation edge's job, so it can never stutter per cron.
   */
  survey(input: CitySurveyInput): void {
    if (!this.cfg.enabled) return;
    this.lastCron += 1;
    this.pending.founding = null;
    this.pending.urbanization = null;
    this.pending.plagueWave = null;
    const size = Math.max(0, Math.floor(input.size));
    // ① the map: living kin per zone, ranked, greatest first (zone ascends as the tie-break ⇒ stable order).
    const perZone = new Map<number, number>();
    if (input.zones) {
      for (const k of Object.keys(input.zones)) {
        const z = Number(input.zones[Number(k)]);
        if (!Number.isInteger(z) || z < 0) continue;
        perZone.set(z, (perZone.get(z) ?? 0) + 1);
      }
    }
    const ownerOf = new Map<number, { houseId: number; name: string; sigil: string }>();
    for (const o of input.zoneOwners ?? []) if (o && Number.isInteger(o.zone)) ownerOf.set(o.zone, { houseId: o.houseId, name: o.name, sigil: o.sigil });
    const hamlet = Math.max(1, Math.floor(this.cfg.hamletMin));
    const town = Math.max(hamlet, Math.floor(this.cfg.townMin));
    const city = Math.max(town, Math.floor(this.cfg.cityMin));
    const next: Settlement[] = [];
    for (const zone of Array.from(perZone.keys()).sort((a, b) => a - b)) {
      const pop = perZone.get(zone) as number;
      if (pop < hamlet) continue;
      const rank: SettlementRank = pop >= city ? "CITY" : pop >= town ? "TOWN" : "HAMLET";
      const own = ownerOf.get(zone) ?? null;
      next.push({ zone, name: settlementName(zone), rank, pop, houseId: own ? own.houseId : null, houseName: own ? own.name : null, sigil: own ? own.sigil : null });
    }
    next.sort((a, b) => b.pop - a.pop || a.zone - b.zone);
    this.settlements = next;
    // ② the road between the two greatest, and the urban share of the live swarm.
    this.road = next.length >= 2 ? { a: next[0].name, b: next[1].name } : null;
    const urbanPop = next.reduce((n, s) => n + s.pop, 0);
    this.lastShare = size > 0 ? urbanPop / size : 0;
    this.lastSize = size;
    // ③ CITY_FOUNDED — a zone that has become a place, announced ONCE per zone for good (the announced set is
    //    persisted, so a DO eviction cannot make a town be founded twice). One line a cron: if several places
    //    appear at once the greatest is told now and the rest follow on the crons after.
    for (const s of next) {
      if (this.announced.has(s.zone)) continue;
      this.announced.add(s.zone);
      this.pending.founding = { ...s };
      break;                                        // one founding a cron, so the chronicle never stutters
    }
    // ④ URBANIZATION — the share crossing the threshold, with a hysteresis so a wobbling swarm is not news twice.
    if (!this.urbanAnnounced && next.length >= 2 && this.lastShare >= this.cfg.urbanShare) {
      this.urbanAnnounced = true;
      this.pending.urbanization = {
        urban: urbanPop, size, settlements: next.length,
        largest: next[0].name, largestPop: next[0].pop, share: Math.round(this.lastShare * 1000) / 1000,
      };
    } else if (this.urbanAnnounced && this.lastShare < this.cfg.urbanShare - URBAN_RESET_GAP) {
      this.urbanAnnounced = false;                  // the towns emptied: it may become news again one day
    }
    // ⑤ the demography: the grave ring is the ONLY honest mortality sample, so the mean is always "the last N".
    const graves = input.graves ?? [];
    let meanAge: number | null = null;
    let topCause: string | null = null;
    if (graves.length > 0) {
      let sum = 0;
      const causes = new Map<string, number>();
      for (const g of graves) {
        const age = Number(g.age);
        if (Number.isFinite(age) && age >= 0) sum += age;
        const c = String(g.cause ?? "");
        if (c) causes.set(c, (causes.get(c) ?? 0) + 1);
      }
      meanAge = Math.round(sum / graves.length);
      let best = -1;
      for (const c of Array.from(causes.keys()).sort()) {
        const n = causes.get(c) as number;
        if (n > best) { best = n; topCause = c; }
      }
    }
    // Burials THIS cron, counted off the ring's own ticks (the ring holds far more than one cron ever buries);
    // hatchings follow exactly, because the swarm's size moves only by birth and burial. Both ACCUMULATE until
    // the generation's census strikes, then reset — so the census reports the whole generation, not one cron.
    let deathsCron = 0;
    for (const g of graves) if (Number(g.tick) > this.lastSurveyTick) deathsCron++;
    this.lastSurveyTick = Math.max(0, Math.floor(input.tick));
    const prevSize = this.demography.size;
    if (this.sizeKnown) {
      this.deathsSince += deathsCron;
      this.birthsSince += Math.max(0, (size - prevSize) + deathsCron);
    }
    this.sizeKnown = true;
    this.demography = {
      size, living: Math.max(0, Math.floor(input.living)), dead: Math.max(0, Math.floor(input.dead)),
      graves: graves.length, meanAge, topCause,
      births: this.birthsSince, deaths: this.deathsSince, generation: this.lastGen,
    };
    // ⑥ PLAGUE_WAVE — burials come in waves AND there is a road for them to walk. Narrated, never caused.
    if (input.deathsRecent >= PLAGUE_DEATHS && this.road && next.length >= PLAGUE_MIN_SETTLEMENTS
      && this.lastCron - this.lastPlagueCron >= PLAGUE_GAP_CRONS) {
      this.lastPlagueCron = this.lastCron;
      this.pending.plagueWave = { deaths: Math.max(0, Math.floor(input.deathsRecent)), a: this.road.a, b: this.road.b };
    }
  }

  /**
   * The generation edge: take the census. Called ONLY when the historian's generation turns, so one count is
   * struck per generation — the swarm's own Domesday, on the fast clock.
   */
  turnGeneration(tick: number, gen: number): void {
    if (!this.cfg.enabled) return;
    this.lastGen = Math.max(0, Math.floor(gen));
    const d = this.demography;
    this.pending.census = {
      size: d.size,
      meanAge: d.meanAge ?? 0,
      graves: d.graves,
      births: d.births,
      deaths: d.deaths,
      gen: this.lastGen,
    };
    this.lastCensusTick = Math.max(0, Math.floor(tick));
    this.lastCensusGen = this.lastGen;
    this.birthsSince = 0;
    this.deathsSince = 0;
  }

  /** Chronicle + endpoint read-outs, recomputed from the map just surveyed (pure, never persists). */
  signals(): CitySignals {
    const top = this.settlements[0] ?? null;
    return {
      settlements: this.map(),
      urbanPop: this.settlements.reduce((n, s) => n + s.pop, 0),
      urbanShare: Math.round(this.lastShare * 1000) / 1000,
      largest: top ? { name: top.name, pop: top.pop, rank: top.rank } : null,
      road: this.road ? { ...this.road } : null,
      demography: { ...this.demography },
      ...this.pending,
    };
  }

  /** Persist the membrane ONLY: trackers + the announced zones (never the map, which is recomputed each cron). */
  serialize(): string {
    return JSON.stringify({
      version: CITY_VERSION,
      announced: Array.from(this.announced).sort((a, b) => a - b),
      urbanAnnounced: this.urbanAnnounced,
      lastCron: this.lastCron,
      lastPlagueCron: this.lastPlagueCron,
      lastCensusTick: this.lastCensusTick,
      lastCensusGen: this.lastCensusGen,
      lastSurveyTick: this.lastSurveyTick,
      sizeKnown: this.sizeKnown,
      birthsSince: this.birthsSince,
      deathsSince: this.deathsSince,
      lastGen: this.lastGen,
      lastShare: Math.round(this.lastShare * 1000) / 1000,
      lastSize: this.lastSize,
      demography: { ...this.demography },
    });
  }

  /** Restore from a stored blob; absent/corrupt/older-shape ⇒ an empty map (the places are forgotten, the ledger untouched). */
  restore(data?: string): void {
    this.settlements = [];
    this.announced.clear();
    this.urbanAnnounced = false;
    this.road = null;
    this.lastShare = 0;
    this.lastSize = 0;
    this.lastCron = 0;
    this.lastPlagueCron = -1e9;
    this.lastCensusTick = 0;
    this.lastCensusGen = -1;
    this.lastSurveyTick = 0;
    this.sizeKnown = false;
    this.lastGen = 0;
    this.birthsSince = 0;
    this.deathsSince = 0;
    this.pending = { founding: null, urbanization: null, census: null, plagueWave: null };
    if (!data) return;
    try {
      const p = JSON.parse(data);
      if (p?.version !== CITY_VERSION) return;
      if (Array.isArray(p.announced)) for (const z of p.announced) if (Number.isInteger(Number(z)) && Number(z) >= 0) this.announced.add(Number(z));
      this.urbanAnnounced = p.urbanAnnounced === true;
      this.lastCron = Number.isFinite(Number(p.lastCron)) ? Math.max(0, Math.floor(Number(p.lastCron))) : 0;
      this.lastPlagueCron = Number.isFinite(Number(p.lastPlagueCron)) ? Number(p.lastPlagueCron) : -1e9;
      this.lastCensusTick = Number.isFinite(Number(p.lastCensusTick)) ? Math.max(0, Math.floor(Number(p.lastCensusTick))) : 0;
      this.lastCensusGen = Number.isFinite(Number(p.lastCensusGen)) ? Math.floor(Number(p.lastCensusGen)) : -1;
      this.lastSurveyTick = Number.isFinite(Number(p.lastSurveyTick)) ? Math.max(0, Math.floor(Number(p.lastSurveyTick))) : 0;
      this.sizeKnown = p.sizeKnown === true;
      this.birthsSince = Number.isFinite(Number(p.birthsSince)) ? Math.max(0, Math.floor(Number(p.birthsSince))) : 0;
      this.deathsSince = Number.isFinite(Number(p.deathsSince)) ? Math.max(0, Math.floor(Number(p.deathsSince))) : 0;
      this.lastGen = Number.isFinite(Number(p.lastGen)) ? Math.max(0, Math.floor(Number(p.lastGen))) : 0;
      this.lastShare = Number.isFinite(Number(p.lastShare)) ? Math.min(1, Math.max(0, Number(p.lastShare))) : 0;
      this.lastSize = Number.isFinite(Number(p.lastSize)) ? Math.max(0, Math.floor(Number(p.lastSize))) : 0;
      const d = p.demography;
      if (d && typeof d === "object") {
        this.demography = {
          size: Number.isFinite(Number(d.size)) ? Math.max(0, Math.floor(Number(d.size))) : 0,
          living: Number.isFinite(Number(d.living)) ? Math.max(0, Math.floor(Number(d.living))) : 0,
          dead: Number.isFinite(Number(d.dead)) ? Math.max(0, Math.floor(Number(d.dead))) : 0,
          graves: Number.isFinite(Number(d.graves)) ? Math.max(0, Math.floor(Number(d.graves))) : 0,
          meanAge: d.meanAge == null || !Number.isFinite(Number(d.meanAge)) ? null : Math.round(Number(d.meanAge)),
          topCause: typeof d.topCause === "string" ? d.topCause : null,
          births: Number.isFinite(Number(d.births)) ? Math.max(0, Math.floor(Number(d.births))) : 0,
          deaths: Number.isFinite(Number(d.deaths)) ? Math.max(0, Math.floor(Number(d.deaths))) : 0,
          generation: Number.isFinite(Number(d.generation)) ? Math.max(0, Math.floor(Number(d.generation))) : 0,
        };
      }
    } catch {
      this.announced.clear();
      this.urbanAnnounced = false;
    }
  }
}

/**
 * If CITIES_ENABLED is off, return a null-object membrane whose every method is inert — one call-site shape for
 * state.ts, so no `if (cities)` branch can ever be forgotten.
 */
export const NULL_CITIES = new CityMembrane({ enabled: false, hamletMin: 2, townMin: 5, cityMin: 9, urbanShare: 0.35 });
