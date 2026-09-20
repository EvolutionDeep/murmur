// THE COMMONS — fly self-legislation (packages/trader-worker/src/commons.ts).
//
// Layer ⑧. A society that only ever ACTS on its citizens' whims is a market; a society that can rewrite
// its OWN rules is a polity. The commons convenes a deterministic assembly the moment the historian raises
// a NEW era: the wealthiest-and-most-honoured living flies take the seats, and vote — a pure function of
// (era, each member's immutable address, hashes) with NO RNG, NO LLM, NO wall-clock — to nudge two, and
// only two, institution-layer knobs already read by the economy: the base CREDIT LINE and its INTEREST
// RATE. The bills the room's own condition generates (a bitter, indebted swarm leans toward relief; a
// creditor-heavy swarm leans hawkish), the seats then vote along that direction. A strict majority carries
// a bill; otherwise the old law stands.
//
// THE TWO IRON RULES:
//   1. PURE READ-OUT + ECONOMIC SIDE ONLY. The assembly reads state the economy/social ledgers already
//      hold (balances, reputations, addresses); it never touches a connectome, genome, fingerprint or
//      manifest hash. Its verdict only RE-PRICES credit — the two parameters the economy consults when it
//      sizes an IOU line (creditCapAtomic) and stamps a note's rate (tryIssueIou). It moves NO money: a
//      decree can never mint or transfer, only widen or narrow a line that is later honoured through the
//      exact same conservation-preserving rails. That is why the whole layer is bounded safe by construction.
//   2. HARD BANDS. Every target is clamped into the config's band at passage AND again at read, so even a
//      maximally radical room cannot legislate the ledger into a corner. The clamp is the constitution the
//      commons cannot vote itself out of.
//
// LAW_ENABLED=false (or institutions off — the commons legislates over a barter economy it has no reach
// into) ⇒ state.ts never convenes and applies a null law ⇒ the economy keeps its base config byte-for-byte.
// A null-object is not needed: ensureCommons() returns null when off, and effectiveParams() returns all
// nulls when the switch is off or no decree is live — both fall straight through to the base config.

/** The two knobs the commons may legislate. Deliberately few — a society that can rewrite everything is
 *  not legislating, it is being reprogrammed; these are the two that stay strictly economic. */
export type LawParam = "creditCap" | "iouRate";

export interface CommonsConfig {
  enabled: boolean;                       // LAW_ENABLED master switch (default ON in config.ts)
  assemblySize: number;                   // seats (config already clamped to 2..16)
  creditCapBandUsdc: [number, number];    // hard clamp on any legislated base credit line, USDC
  iouRateBand: [number, number];          // hard clamp on any legislated interest rate
}

/** One living fly, as the commons sees it — every field a pure read-out the economy already persists. */
export interface CommonsSeat {
  id: number;
  address: string;        // the fly's stable identity — the ONLY thing a ballot is keyed on (never a brain)
  balanceAtomic: string;  // its purse, atomic USDC — ranks the seat and weighs its stance; never moved here
  rep: number;            // reputation scalar −1..1 from the social ledger (0 when unlisted)
}

/** A carried law: a bounded target for one knob, stamped with the era that passed it. */
export interface Decree {
  param: LawParam;
  target: number;         // already clamped into the parameter's band at passage
  passedEra: number;
}

/** The /economy read-out of the commons (pure; nulls mean "the base config still stands"). */
export interface CommonsReadout {
  seatedEra: number;                            // the era this assembly was convened for (0 ⇒ never yet)
  seats: { id: number; address: string; balanceUsdc: number; rep: number }[];
  decrees: Decree[];
  effective: { creditCapBaseUsdc: number | null; iouRatePer10: number | null };
}

const LAW_VERSION = 1;
const SEAT_CAP = 16;          // hard bound on persisted seats (config clamps the live size lower anyway)
const DECREE_CAP = 4;         // at most one live decree per knob; a small headroom, never a growth vector

// Salts differ from culture's (0xc0de/0x1cea/…) so a commons ballot can never alias a cultural draw.
const SEAT_SALT = 0x5ea7;     // tiny jitter that breaks a rank tie between two otherwise-equal flies
const VOTE_SALT = 0x1707;     // the roll call itself, keyed on (address, era, param)

/**
 * The commons: a per-DO singleton owning the current assembly + its live decrees. state.ts drives it from
 * the cron — convene() once when a new era dawns (feeding the living roster it already snapshotted),
 * effectiveParams() at the top of every cron to hand the economy this era's law. Everything recomputes
 * from (era, addresses, hashes), so a restored DO and a fresh DO that saw the same eras agree byte-for-byte.
 */
export class CommonsAssembly {
  private seated: { id: number; address: string; balanceAtomic: string; rep: number }[] = [];
  private decrees: Decree[] = [];
  private lastConvenedEra = 0;   // 0 ⇒ never convened; the historian's era counter is 1-based

  constructor(private readonly cfg: CommonsConfig) {}

  /**
   * Convene a fresh assembly + legislate when a NEW era has dawned. A no-op (returns false) when the
   * switch is off, the era has not advanced past the last seated one, or the swarm is too small to have
   * a commons. Deterministic throughout: seat ranking, agenda stance and every ballot are functions of
   * (era, addresses, ids) plus a fixed hash — no RNG, no clock, no LLM.
   */
  convene(eraNow: number, roster: readonly CommonsSeat[]): boolean {
    if (!this.cfg.enabled) return false;
    if (eraNow <= this.lastConvenedEra) return false;                 // one assembly per era, never on the past
    const living = roster.filter((s) => s && Number.isFinite(Number(s.balanceAtomic)));
    if (living.length < 2) return false;                              // no commons without at least a pair

    // ① SEAT THE COMMONS — the wealthiest-and-most-honoured living flies. standing (reputation) and stake
    //    (share of the room's capital) are already on the ledger; a micro hash-jitter only breaks an exact
    //    tie, and the id ordering makes the whole sort order-independent. Ranking READS, it moves nothing.
    const totalCap = living.reduce((a, s) => a + Math.max(0, Number(s.balanceAtomic)), 0);
    const seatScore = (s: CommonsSeat): number => {
      const standing = clamp01((s.rep + 1) / 2);                     // −1 bitter .. +1 honourable → 0..1
      const stake = totalCap > 0 ? Math.max(0, Number(s.balanceAtomic)) / totalCap : 0;
      return 0.5 * standing + 0.5 * stake + hash01(SEAT_SALT, s.id, eraNow) * 1e-9;
    };
    const k = Math.max(2, Math.min(this.cfg.assemblySize, SEAT_CAP, living.length));
    this.seated = living
      .map((s) => ({ s, score: seatScore(s) }))
      .sort((a, b) => b.score - a.score || a.s.id - b.s.id)
      .slice(0, k)
      .map((r) => ({ id: r.s.id, address: r.s.address, balanceAtomic: r.s.balanceAtomic, rep: r.s.rep }));

    // ② THE AGENDA — one bill per legiable knob, generated by the room's own condition, then voted.
    const bills: Decree[] = [];
    for (const param of ["creditCap", "iouRate"] as LawParam[]) {
      const target = this.legislate(param, this.seated, eraNow);
      if (target != null) bills.push({ param, target, passedEra: eraNow });
    }
    this.decrees = bills.slice(0, DECREE_CAP);
    this.lastConvenedEra = eraNow;
    return true;
  }

  /**
   * One knob's law, or null to leave the base config standing. The room's aggregate stance fixes a
   * DIRECTION (hawkish ⇄ dovish); each seat then votes along that direction, its own interest nudging a
   * deterministic draw. Absent a strict majority the bill fails and the old law stands; carried, the knob
   * moves from the band midpoint toward that direction's end by the size of the winning margin — clamped.
   */
  private legislate(param: LawParam, seats: readonly CommonsSeat[], era: number): number | null {
    if (seats.length < 2) return null;
    const band = param === "creditCap" ? this.cfg.creditCapBandUsdc : this.cfg.iouRateBand;

    // stance: how creditor-class the room is — honoured seats and a concentrated purse lean hawkish
    // (tighten credit, raise the rate for scarce capital); a bitter/poor room leans dovish (relief).
    const standing = seats.reduce((a, s) => a + clamp01((s.rep + 1) / 2), 0) / seats.length;
    const total = seats.reduce((a, s) => a + Math.max(0, Number(s.balanceAtomic)), 0);
    const top = seats.reduce((a, s) => Math.max(a, Math.max(0, Number(s.balanceAtomic))), 0);
    const concentration = total > 0 ? top / total : 0;               // 1/k (even) .. 1 (one purse)
    const hawkish = clamp01(0.5 * standing + 0.5 * concentration) >= 0.5;
    const direction = hawkish ? 1 : -1;                             // +1 tighten · −1 relieve

    // roll call: a seat votes on the DIRECTION, its own material interest biasing the hash draw toward
    // compliance — debtors (low standing) fall in line behind relieving credit, creditors behind a
    // higher rate, and against the opposite bill. The ballot is a pure function of (address, era, param).
    let yea = 0;
    for (const s of seats) {
      const selfInterest = param === "creditCap"
        ? 0.5 - clamp01((s.rep + 1) / 2)                             // >0 for a low-rep debtor: wants MORE credit
        : clamp01((s.rep + 1) / 2) - 0.5;                           // >0 for a high-rep creditor: wants a HIGHER rate
      // interest × direction > 0 ⇒ this bill helps the seat ⇒ it leans yes; the 0.5 line is the honest
      // majority threshold a purely random room would sit exactly on.
      const align = direction * selfInterest;                       // hawk voting to tighten a debtor's line ⇒ <0
      const ballot = hash01(fnv32(s.address), era, VOTE_SALT) + 0.2 * align;
      if (ballot >= 0.5) yea++;
    }
    if (yea * 2 <= seats.length) return null;                       // no majority ⇒ the base stands

    // carried: step from the midpoint toward the direction's end of the band, sized by the winning margin.
    const [lo, hi] = band;
    const mid = (lo + hi) / 2;
    const conviction = (yea - (seats.length - yea)) / seats.length; // 0..1 margin
    const reach = Math.min(1, 0.25 + conviction);                   // never the raw extreme on a thin margin
    const end = direction > 0 ? hi : lo;
    return round6(clamp(mid + (end - mid) * reach, lo, hi));
  }

  /**
   * The law this era handed to the economy. Each knob is the live decree's (band-clamped) target, or null
   * ⇒ no law on it ⇒ the economy falls back to its base config. Called at the top of every cron.
   */
  effectiveParams(): { creditCapBaseUsdc: number | null; iouRatePer10: number | null } {
    const out: { creditCapBaseUsdc: number | null; iouRatePer10: number | null } =
      { creditCapBaseUsdc: null, iouRatePer10: null };
    if (!this.cfg.enabled) return out;
    for (const d of this.decrees) {
      if (d.param === "creditCap") out.creditCapBaseUsdc = round6(clamp(d.target, ...this.cfg.creditCapBandUsdc));
      else out.iouRatePer10 = round6(clamp(d.target, ...this.cfg.iouRateBand));
    }
    return out;
  }

  /** Bounded read-out for /economy (never the source of truth — a pure projection of the fields above). */
  readout(): CommonsReadout {
    const eff = this.effectiveParams();
    return {
      seatedEra: this.lastConvenedEra,
      seats: this.seated.slice(0, SEAT_CAP).map((s) => ({
        id: s.id, address: s.address, balanceUsdc: round6(Number(s.balanceAtomic) / 1e6), rep: s.rep,
      })),
      decrees: this.decrees.slice(0, DECREE_CAP),
      effective: eff,
    };
  }

  get size(): number { return this.seated.length; }

  /** Persist the commons ONLY (a version-tagged, capped blob): {version, lastConvenedEra, seated, decrees}. */
  serialize(): string {
    return JSON.stringify({
      version: LAW_VERSION,
      era: this.lastConvenedEra,
      seats: this.seated.slice(0, SEAT_CAP),
      decrees: this.decrees.slice(0, DECREE_CAP),
    });
  }

  /** Restore a stored blob; absent/corrupt/foreign-shape ⇒ an EMPTY commons (the era simply re-seats). */
  restore(data?: string): void {
    this.seated = [];
    this.decrees = [];
    this.lastConvenedEra = 0;
    if (!data) return;
    try {
      const p = JSON.parse(data);
      if (p?.version !== LAW_VERSION) return;
      if (Number.isInteger(p.era) && p.era >= 0) this.lastConvenedEra = p.era;
      if (Array.isArray(p.seats)) {
        for (const s of p.seats) {
          if (!s || typeof s.address !== "string" || !Number.isInteger(s.id)) continue;
          if (this.seated.length >= SEAT_CAP) break;
          this.seated.push({
            id: s.id, address: s.address,
            balanceAtomic: String(s.balanceAtomic ?? "0"),
            rep: Number.isFinite(Number(s.rep)) ? Number(s.rep) : 0,
          });
        }
      }
      if (Array.isArray(p.decrees)) {
        for (const d of p.decrees) {
          if (!d || (d.param !== "creditCap" && d.param !== "iouRate")) continue;
          if (!Number.isFinite(Number(d.target)) || !Number.isInteger(Number(d.passedEra))) continue;
          if (this.decrees.length >= DECREE_CAP) break;
          this.decrees.push({ param: d.param, target: Number(d.target), passedEra: Number(d.passedEra) });
        }
      }
    } catch {
      this.seated = [];
      this.decrees = [];
      this.lastConvenedEra = 0;
    }
  }
}

// ------------------------------------------------------------------------------------------------------------
// Deterministic helpers — the SAME FNV-1a + uniform-draw construction as culture.ts and the economy, the
// salts differing by design so a commons ballot can never alias a cultural or economic one. No RNG state.
// ------------------------------------------------------------------------------------------------------------
function clamp(x: number, lo: number, hi: number): number { return Math.min(hi, Math.max(lo, x)); }
function clamp01(x: number): number { return clamp(x, 0, 1); }
function round6(x: number): number { return Math.round(x * 1e6) / 1e6; }

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
/** fold an address string to a 32-bit seed — every ballot keys on the fly's own stable identity. */
function fnv32(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) { h = Math.imul(h ^ s.charCodeAt(i), 0x01000193) >>> 0; }
  return h >>> 0;
}
