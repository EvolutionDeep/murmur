/**
 * ㉗ THE GUARDIANS — wardship and inheritance (packages/trader-worker/src/guardians.ts).
 *
 * The dynasty already buries its dead and names the heirs (GraveRecord), and the chronicle already reads
 * one epitaph per burial (ELEGY). But an epitaph is about the DEAD. This membrane is about the living who
 * are left: when a fly falls with an estate and children still flying, the youngest of those children is a
 * WARD — taken into the guardianship of the house (or the commons, for a commoner's line). Given years and
 * a keeper, a ward FLEDGES: stands on its own with the inheritance intact. And the rarest, roundest news of
 * all: a fledged ward grows OLD, falls to age, and pays its own estate to its own heirs — then, and only
 * then, may the roll say the GUARDIAN was honored full circle. A society is measured not by its funerals
 * but by how it raises what the funerals leave behind.
 *
 * THE THREE IRON RULES (the culture/faith/court/games/guilds/lexicon/treaty/works law, restated):
 *   1. PURE READ-OUT. The guardians MOVE NO MONEY and command no fly: every fact here is already in the
 *     economy's own grave ring and living roster (estateUsdc, heirIds, houseName, dead flags). The
 *     wardship changes no inheritance — entomb() has already split the estate before this roll is written.
 *     There is no causal leg, as in ㉕/㉖.
 *   2. DETERMINISM. No RNG, no clock, no LLM. Taking is an edge over NEW graves (keyed (id, bornTick),
 *     the dynasty's own unique-burial key); fleging and honoring are age/series edges over the SAME
 *     re-derivable grave + living-id streams. One event per class per cron; the ward is fixed as the
 *     YOUNGEST living heir (last in hatch order), the fledge order is by takenTick then ward id.
 *   3. BOUNDED. ≤ GD_MAX_WARDS (8) live wardships, a fledged roll of ≤ GD_HONOR_MEM (64) awaiting the
 *     full circle, an archive of ≤ GD_MEMORY (10) ended wardships, a seen-grave ring of ≤ GD_SEEN_MEM
 *     (240). serialize() is a small JSON; a corrupt blob restarts an empty guardians' roll, never a
 *     poisoned ledger.
 *
 * GUARDIANS_ENABLED=false ⇒ state.ts never constructs the membrane (ensureGuardians returns null), folds
 * no `guardians` key into the historian's context ⇒ the three new chronicle kinds can never speak ⇒ every
 * old line is byte-for-byte the pre-Guardians build.
 */

// ─── deterministic constants ──────────────────────────────────────────────────────────────────────────

const GD_VERSION = 1;

/** Crons a ward must be carried before it stands on its own (the minority of the inheritance). */
export const GD_FLEDGE = 96;

/** How many live wardships the roll carries at once — guardianship past this is the commons' plain charge. */
export const GD_MAX_WARDS = 8;

/** How many ended wardships the archive keeps for the read-out (FIFO). */
export const GD_MEMORY = 10;

/** Fledged wards remembered (ward → its guardian) awaiting the full-circle honor (bounded blob). */
const GD_HONOR_MEM = 64;

/** The seen-grave ring — a (id, bornTick) key is walked exactly once, newest burial wins the edge. */
const GD_SEEN_MEM = 240;

// ─── the facts the roll may read (all already published in the economy's own snapshot) ────────────────

/** One burial as the grave ring publishes it (DynastyReadout.graves row, pure read). */
export interface GraveFact {
  id: number;
  /** The cron the fly fell. */
  tick: number;
  /** Birth sub-tick — with id this is the dynasty's unique burial key. */
  bornTick: number;
  /** "aged" | "penury" | "plague" — the dynasty's own enum, kept raw like every membrane enum. */
  cause: string;
  /** USDC the wallet held at death (what the inheritance was). */
  estateUsdc: number;
  /** Who received it, in hatch order — EMPTY ⇒ the treasury or the dole took it, no wards. */
  heirIds: number[];
  /** The dead's house name, or null for a commoner (guardian then reads "the commons"). */
  houseName: string | null;
}

export interface GuardianFacts {
  /** The historian's current era index — the age the wardship was entered in. */
  era: number;
  /** The economy's recent grave ring (≤ 12 per the dynasty read-out). */
  graves: GraveFact[];
  /** Every FLY still flying this cron (the roster's living ids). */
  livingIds: number[];
}

export interface GuardiansConfig {
  enabled: boolean;
}

// ─── the signals (edge events for THIS cron + the standing roll) ──────────────────────────────────────

export interface WardRecord {
  ward: number;
  guardian: string;
  takenTick: number;
  takenEra: number;
  /** The dead the ward was taken from (whose estate the roll memorializes). */
  from: number;
}

/** One cron's wardship edge: which ward, under whose name, and the figure that spoke. */
export interface WardEdge {
  ward: number;
  guardian: string;
  era: number;
  /** Estate passing to young hands (taking edges only). */
  estateUsdc?: number;
  /** Crons the guardian carried the ward (fledge edges only). */
  crons?: number;
  /** Crons since the ward was taken (honor edges only — the circle's whole span). */
  lived?: number;
}

export interface GuardianSignals {
  taken: WardEdge | null;
  fledged: WardEdge | null;
  honored: WardEdge | null;
  active: WardRecord[];
  archive: { ward: number; guardian: string; end: "fledged" | "honored" | "lost" }[];
  counts: { taken: number; fledged: number; honored: number; lost: number };
}

// ─── the membrane ─────────────────────────────────────────────────────────────────────────────────────

interface EndedWard { ward: number; guardian: string; end: "fledged" | "honored" | "lost" }

export class GuardiansMembrane {
  private wards = new Map<number, WardRecord & { fromBornTick?: number }>(); // ≤ GD_MAX_WARDS, key = ward id
  private fledgedRoll = new Map<number, { guardian: string; takenTick: number }>(); // ≤ GD_HONOR_MEM, FIFO
  private archive: EndedWard[] = [];                                   // ≤ GD_MEMORY, FIFO
  private seen: string[] = [];                                         // grave keys, ring ≤ GD_SEEN_MEM
  private counts = { taken: 0, fledged: 0, honored: 0, lost: 0 };

  private pending: GuardianSignals = {
    taken: null, fledged: null, honored: null,
    active: [], archive: [], counts: { ...this.counts },
  };

  constructor(private readonly cfg: GuardiansConfig) {}

  /** One round per cron, BEFORE observeChronicle folds the signals (state.ts drives it next to the
   *  works yard): the roll reads THIS cron's grave ring + living roster and fires at most one edge per class. */
  round(tick: number, facts: GuardianFacts): void {
    if (!this.cfg.enabled) return;
    this.pending = {
      taken: null, fledged: null, honored: null,
      active: this.activeList(), archive: this.archive.slice(), counts: { ...this.counts },
    };

    const living = new Set(facts.livingIds);
    // Walk the grave ring in FIXED burial order (oldest first — a tick-keyed sort, never array order, so a
    // restored ring the same size tells the same story).
    const graves = facts.graves.slice().sort((x, y) => x.tick - y.tick || x.bornTick - y.bornTick || x.id - y.id);
    let didTake = false;
    let didHonor = false;

    for (const g of graves) {
      const key = `${g.id}:${g.bornTick}`;
      if (this.seen.includes(key)) continue;
      this.seen.push(key);
      if (this.seen.length > GD_SEEN_MEM) this.seen = this.seen.slice(-GD_SEEN_MEM);

      const heirs = g.heirIds.filter((h) => living.has(h));

      // 1) THE FULL CIRCLE: a fledged ward of ours fell to AGE and paid its OWN estate to its OWN heirs —
      //    only now may the roll say the guardianship it began was honored. Rarest news; one per cron.
      const fledged = this.fledgedRoll.get(g.id);
      if (fledged) {
        // The circle closes either in honor (old age, own heirs paid) or in plain silence (a fledged ward
        // that fell young or childless — it stood on its own, so the roll simply lets it go: no kind, no
        // archive row; the wardship ENDED before this grave was ever news).
        this.fledgedRoll.delete(g.id);
        if (!didHonor && g.cause === "aged" && heirs.length > 0) {
          this.archive.push({ ward: g.id, guardian: fledged.guardian, end: "honored" });
          if (this.archive.length > GD_MEMORY) this.archive = this.archive.slice(-GD_MEMORY);
          this.counts.honored++; didHonor = true;
          // lived spans the WHOLE circle: from the day the guardian took the ward to this its closing cron.
          this.pending.honored = { ward: g.id, guardian: fledged.guardian, era: facts.era, lived: tick - fledged.takenTick };
        }
        continue;
      }

      // 2) A live ward fell before standing on its own — the roll closes the entry LOST. No kind speaks:
      //    the guardians' chronicle never narrates unlived years (the treaty's lapse has no kind either).
      if (this.wards.has(g.id)) {
        const w = this.wards.get(g.id)!;
        this.wards.delete(g.id);
        this.archive.push({ ward: w.ward, guardian: w.guardian, end: "lost" });
        if (this.archive.length > GD_MEMORY) this.archive = this.archive.slice(-GD_MEMORY);
        this.counts.lost++;
        continue;
      }

      // 3) A NEW wardship: the dead left an estate AND children still flying. The YOUNGEST living heir
      //    (last in hatch order) is the ward — the one least able to stand; one taking per cron, and a fly
      //    already standing as another line's ward is never double-taken.
      if (!didTake && g.estateUsdc > 0 && heirs.length > 0 && this.wards.size < GD_MAX_WARDS) {
        const ward = heirs[heirs.length - 1];
        if (!this.wards.has(ward)) {
          const guardian = g.houseName ?? "the commons";
          this.wards.set(ward, { ward, guardian, takenTick: tick, takenEra: facts.era, from: g.id });
          this.counts.taken++; didTake = true;
          this.pending.taken = { ward, guardian, era: facts.era, estateUsdc: g.estateUsdc };
        }
      }
    }

    // 4) FLEDGE SWEEP — oldest wardship first (takenTick, then ward id: a fixed order, never map order).
    //    A ward still flying GD_FLEDGE crons after its taking stands on its own and enters the fledged
    //    roll awaiting the full circle; a ward no longer flying is closed LOST quietly. One fledge per cron.
    const byAge = [...this.wards.values()].sort((x, y) => x.takenTick - y.takenTick || x.ward - y.ward);
    let didFledge = false;
    for (const w of byAge) {
      if (tick - w.takenTick < GD_FLEDGE) continue;
      if (!living.has(w.ward)) {
        this.wards.delete(w.ward);
        this.archive.push({ ward: w.ward, guardian: w.guardian, end: "lost" });
        if (this.archive.length > GD_MEMORY) this.archive = this.archive.slice(-GD_MEMORY);
        this.counts.lost++;
        continue;
      }
      if (didFledge) continue;
      this.wards.delete(w.ward);
      this.fledgedRoll.set(w.ward, { guardian: w.guardian, takenTick: w.takenTick });
      if (this.fledgedRoll.size > GD_HONOR_MEM) {
        const oldest = this.fledgedRoll.keys().next().value as number;
        this.fledgedRoll.delete(oldest);
      }
      this.counts.fledged++; didFledge = true;
      this.pending.fledged = { ward: w.ward, guardian: w.guardian, era: facts.era, crons: tick - w.takenTick };
    }

    // Read-out closes on the END-of-round truth (a ward taken this cron belongs in the roll).
    this.pending.active = this.activeList();
    this.pending.archive = this.archive.slice();
    this.pending.counts = { ...this.counts };
  }

  /** The standing roll in fixed order (takenTick then ward id — deterministic for the roll and the blob). */
  private activeList(): WardRecord[] {
    return [...this.wards.values()]
      .sort((x, y) => x.takenTick - y.takenTick || x.ward - y.ward)
      .map((w) => ({ ward: w.ward, guardian: w.guardian, takenTick: w.takenTick, takenEra: w.takenEra, from: w.from }));
  }

  signals(): GuardianSignals { return this.pending; }

  // ─── persistence (bounded, additive) ───────────────────────────────────────────────────────────────

  serialize(): string {
    return JSON.stringify({
      v: GD_VERSION,
      wards: this.activeList(),
      fledgedRoll: [...this.fledgedRoll.entries()].map(([ward, r]) => ({ ward, guardian: r.guardian, takenTick: r.takenTick })),
      archive: this.archive,
      seen: this.seen,
      counts: this.counts,
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
      this.counts = {
        taken: num(c.taken, 0), fledged: num(c.fledged, 0),
        honored: num(c.honored, 0), lost: num(c.lost, 0),
      };
      this.wards = new Map();
      if (Array.isArray(p.wards)) {
        for (const raw of p.wards) {
          const ward = num(raw?.ward, NaN);
          if (!Number.isFinite(ward) || this.wards.has(ward)) continue;
          this.wards.set(ward, {
            ward, guardian: str(raw.guardian, "the commons"),
            takenTick: Math.max(0, num(raw.takenTick, 0)), takenEra: num(raw.takenEra, 0),
            from: num(raw.from, 0),
          });
          if (this.wards.size >= GD_MAX_WARDS) break;
        }
      }
      this.fledgedRoll = new Map();
      if (Array.isArray(p.fledgedRoll)) {
        for (const raw of p.fledgedRoll.slice(-GD_HONOR_MEM)) {
          const ward = num(raw?.ward, NaN);
          if (!Number.isFinite(ward) || this.fledgedRoll.has(ward)) continue;
          this.fledgedRoll.set(ward, { guardian: str(raw.guardian, "the commons"), takenTick: Math.max(0, num(raw.takenTick, 0)) });
        }
      }
      if (Array.isArray(p.archive)) {
        this.archive = p.archive
          .map((raw: any) => {
            const end = raw?.end === "fledged" || raw?.end === "honored" || raw?.end === "lost" ? raw.end : null;
            const ward = num(raw?.ward, NaN);
            return end && Number.isFinite(ward) ? { ward, guardian: str(raw.guardian, "the commons"), end } : null;
          })
          .filter((w: EndedWard | null): w is EndedWard => !!w)
          .slice(-GD_MEMORY);
      }
      if (Array.isArray(p.seen)) {
        this.seen = p.seen.filter((s: unknown) => typeof s === "string" && /^[0-9]+:[0-9]+$/.test(s)).slice(-GD_SEEN_MEM);
      }
      // Refresh the read-out snapshot: a restored roll speaks its wardships even before the first round.
      this.pending = {
        taken: null, fledged: null, honored: null,
        active: this.activeList(), archive: this.archive.slice(), counts: { ...this.counts },
      };
    } catch { /* corrupt → keep defaults: an empty roll, never a poisoned ledger */ }
  }
}
