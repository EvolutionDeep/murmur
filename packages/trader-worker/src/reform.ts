/**
 * ㉘ REFORM — the society's self-correction (packages/trader-worker/src/reform.ts).
 *
 * A market left alone concentrates: the lucky compound, the unlucky fall, the Gini climbs until the swarm
 * is a few fat purses and a long tail of penury. Every durable society ever built answered that drift with
 * three instruments, and this membrane is the fruit-fly version of all three:
 *
 *   A. PROGRESSIVE ESTATE DUTY — when a fly is buried holding more than a bare subsistence, the estate is
 *      taxed on a rising ladder (the first 5 USDC free, then 10% / 25% / 40% through the brackets). Half the
 *      duty fills the COMMONS POOL (a standing public purse); half is returned at once as a flat UBI to every
 *      living citizen. Wealth recirculates instead of ossifying into a permanent rentier class.
 *   C. THE JUBILEE STABILIZER — when the Gini sits above the crisis line for a sustained run of crons (and the
 *      stabilizer is ARMED, i.e. the swarm has recently been equal enough to deserve the reset), the old
 *      levitical year is proclaimed: every outstanding debt is forgiven, the wealthiest tenth is levied a
 *      one-time 5%, and the whole commons pool plus that levy is divided equally among the living as a
 *      stimulus. A hysteresis band and a long cooldown keep it a rare jubilee, never a churn.
 *   F. THE DARK-AGE CATALYST — hard times sharpen minds. While the age is DARK or the Gini is high, a
 *      multiplier (1.0×..1.5×) is published for the culture / invention membranes to spend: pressure that
 *      would otherwise crush a society instead accelerates its discovery and art.
 *
 * THE THREE IRON RULES (the culture/faith/court/games/guilds/lexicon/treaty/works/guardians law, restated):
 *   1. PURE READ-OUT + INTERNAL BOOKKEEPING. Reform reads the economy's OWN published snapshot (the Gini in
 *      totals, the dynasty grave ring, the living roster's balances, the per-agent debt column) and the
 *      historian's civPhase. It moves NO real money and triggers NO chain transaction: v1 is zero-gas. The
 *      commons pool, the UBI split, the levy and the debt forgiveness are NUMERICAL ACCOUNTING carried in
 *      this layer's own bounded state and narrated to the chronicle — exactly as every other membrane only
 *      names what the ledger already implies. Nothing here re-prices a deal or writes a wallet.
 *   2. DETERMINISM. No RNG, no clock, no LLM. The duty is a fixed bracket sum; the jubilee is a sustain
 *      counter + a hysteresis arm + a cooldown over the tick series; the catalyst is a clamp of the Gini.
 *      Given the same context series, step() replays byte-identically.
 *   3. BOUNDED. serialize() is one small JSON of scalar counters (no growing rings); a corrupt blob restarts
 *      a cold reform layer, never a poisoned ledger. The transient estate-dedup ring is capped and NOT
 *      persisted (an estate is duty'd once per instance lifetime; a DO eviction at worst re-narrates a small
 *      bookkeeping line, never touching real funds).
 *
 * REFORM_ENABLED=false (the shipped default) ⇒ state.ts never constructs the layer (ensureReform returns
 * null), folds no `reform` key into the historian's context ⇒ the three new chronicle kinds can never speak
 * ⇒ every old line is byte-for-byte the pre-Reform build.
 */

// ─── deterministic constants (code-managed: wrangler.toml [vars] is at capacity, so the reform lines live
//     here as constants — the same "armed on code defaults, master switch reads an env key" shape as ㉗) ───

const RF_VERSION = 1;

/** USDC an estate may pass untouched — below this a burial owes nothing (a bare subsistence is free). */
export const ESTATE_DUTY_THRESHOLD = 5;

/** The progressive ladder: each band taxes only the slice of the estate that falls inside it. */
export const ESTATE_BRACKETS: { floor: number; ceiling: number; rate: number }[] = [
  { floor: 5, ceiling: 15, rate: 0.10 },
  { floor: 15, ceiling: 40, rate: 0.25 },
  { floor: 40, ceiling: Infinity, rate: 0.40 },
];

/** Share of the duty that fills the commons pool; the remainder is returned at once as a flat UBI. */
export const ESTATE_POOL_SHARE = 0.5;

/** Gini above which the jubilee stabilizer starts counting a sustained crisis. */
export const GINI_JUBILEE_THRESHOLD = 0.75;
/** Hysteresis lower bound: the Gini must fall back to here to RE-ARM the stabilizer after a jubilee. */
export const GINI_JUBILEE_RESET = 0.65;
/** Consecutive over-threshold crons required before the jubilee may be proclaimed. */
export const JUBILEE_SUSTAIN_CRONS = 6;
/** Crons between two jubilees (≈2h at the default 6 ticks/cron cadence) — a jubilee is rare by design. */
export const JUBILEE_COOLDOWN_CRONS = 120;
/** The wealthiest slice of the roster levied on a jubilee (top 10% by balance). */
export const JUBILEE_TOP_SHARE = 0.10;
/** The one-time rate levied on each of that wealthiest tenth's balance. */
export const JUBILEE_TOP_LEVY_RATE = 0.05;

/** Below this Gini the dark-age catalyst is silent (no pressure, no surge). */
export const CATALYST_GINI_FLOOR = 0.40;
/** The ceiling on the catalyst bonus (a surge never exceeds +50% on the culture/invention output). */
export const CATALYST_CAP = 0.50;
/** A surge is only NEWSED once it clears this multiplier (avoid narrating a barely-there drift). */
const CATALYST_SURGE_AT = 1.1;

/** The transient estate-dedup ring — an address is duty'd once per instance lifetime (NOT persisted). */
const RF_SEEN_MEM = 240;

// ─── the facts the layer may read (all already published in the economy's own snapshot) ─────────────────

/** One living citizen's published wallet (a pure read of the roster snapshot). */
export interface ReformAgent {
  address: string;
  /** Balance in USDC (a plain number — the layer is numerical accounting, never BigInt money movement). */
  balance: number;
}

/** One burial this cron, as the dynasty grave ring publishes it (address resolved by the caller). */
export interface ReformGrave {
  address: string;
  /** The estate the wallet held at death, in USDC. */
  balance: number;
}

/** One credit promise, read-only, as the caller can publish it from the economy's debt column. */
export interface ReformIouRecord {
  id: string;
  debtor: number;
  creditor: number;
  amountUsdc: number;
}

/** The read-only handle reform may use to enumerate outstanding debts (a jubilee forgives them all). */
export interface ReformEconomyRef {
  creditIouRecords(): ReformIouRecord[];
}

export interface ReformStepContext {
  /** The economy's own wealth-concentration coefficient (totals.gini), 0..1. */
  gini: number;
  /** The historian's civilizational phase this cron ("dark" | "golden" | "ascendant" | "declining"). */
  civPhase: string;
  /** The current sub-tick index (the cooldown is measured in sub-ticks = crons × ticksPerCron). */
  tickIndex: number;
  /** Sub-ticks per cron, so the jubilee cooldown can convert crons → ticks. */
  ticksPerCron: number;
  /** The burials this cron (already deduped to fresh graves by the caller's own seen-ring, plus ours). */
  graves: ReformGrave[];
  /** Every living citizen's wallet this cron. */
  agents: ReformAgent[];
  /** The read-only debt handle (null ⇒ a jubilee simply forgives nothing it cannot enumerate). */
  economy: ReformEconomyRef | null;
}

// ─── the signals (edge events for THIS cron) ─────────────────────────────────────────────────────────────

export type ReformEvent =
  | { kind: "ESTATE_LEVIED"; address: string; gross: number; tax: number; ubiPerAgent: number }
  | { kind: "JUBILEE_PROCLAIMED"; debtsForgiven: number; levyCollected: number; stimulusPerAgent: number }
  | { kind: "CATALYST_SURGE"; multiplier: number };

export interface ReformStepResult {
  /** The chronicle-narratable edges this cron raised (at most one jubilee / one surge; estates may repeat). */
  events: ReformEvent[];
  /** The catalyst multiplier (1.0..1.5) the culture/invention membranes may spend this cron. */
  catalystMultiplier: number;
  /** The flat UBI each living citizen receives this cron (numerical accounting; never a real transfer). */
  ubiDistributions: { address: string; amount: number }[];
  /** The ids of every outstanding IOU forgiven by a jubilee this cron (empty unless one proclaimed). */
  debtForgiveness: string[];
  /** The one-time levy taken off each wealthiest-tenth wallet on a jubilee (numerical accounting). */
  levyDeductions: { address: string; amount: number }[];
}

/** The standing read-out folded into /economy + /population (absent ⇒ REFORM_ENABLED=false). */
export interface ReformReadout {
  enabled: boolean;
  /** Cumulative estate duty collected (USDC, bookkeeping). */
  estateDutyCollected: number;
  /** How many times the jubilee has been proclaimed. */
  jubileeCount: number;
  /** Whether the stabilizer is currently armed (equal enough to deserve a reset). */
  jubileeArmed: boolean;
  /** The current run of consecutive over-threshold crons. */
  giniSustainCount: number;
  /** The catalyst multiplier in force (1.0..1.5). */
  catalystMultiplier: number;
  /** The sub-tick the last jubilee was proclaimed at (null ⇒ never). */
  lastJubileeTick: number | null;
  /** The commons pool balance (USDC, bookkeeping). */
  commonsPoolBalance: number;
}

/** The persisted shape (one small JSON of scalars — no growing rings, DO-safe). */
export interface ReformSerialized {
  v: 1;
  estateDutyCollected: number;
  jubileeCount: number;
  jubileeArmed: boolean;
  giniSustainCount: number;
  lastJubileeTick: number | null;
  commonsPoolBalance: number;
  catalystActive: boolean;
}

export interface ReformConfig {
  enabled: boolean;
}

// ─── pure helpers ───────────────────────────────────────────────────────────────────────────────────────

function clamp01(x: number): number { return x < 0 ? 0 : x > 1 ? 1 : x; }

/** A finite number or the default — NEVER `Number(v) || d` (that drops a legitimate 0). */
function num(v: unknown, d: number): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : d;
}

/**
 * The progressive estate duty on a gross estate (USDC). The first ESTATE_DUTY_THRESHOLD is free; each band
 * taxes only the slice of the estate inside it. Exactly 5 ⇒ 0; 15 ⇒ 1.0; 40 ⇒ 7.25; 50 ⇒ 11.25.
 */
export function estateDutyOf(gross: number): number {
  if (!Number.isFinite(gross) || gross <= ESTATE_DUTY_THRESHOLD) return 0;
  let tax = 0;
  for (const b of ESTATE_BRACKETS) {
    const slice = Math.min(gross, b.ceiling) - b.floor;
    if (slice > 0) tax += slice * b.rate;
  }
  return tax;
}

/** The catalyst multiplier for a Gini / phase (1.0 when there is no pressure, up to 1.0 + CATALYST_CAP). */
export function catalystMultiplierOf(gini: number, civPhase: string): number {
  if (civPhase !== "dark" && !(gini > CATALYST_GINI_FLOOR)) return 1;
  const raw = (gini - CATALYST_GINI_FLOOR) / (GINI_JUBILEE_THRESHOLD - CATALYST_GINI_FLOOR);
  return 1 + Math.min(CATALYST_CAP, CATALYST_CAP * clamp01(raw));
}

// ─── the membrane ───────────────────────────────────────────────────────────────────────────────────────

export class ReformLayer {
  private estateDutyCollected = 0;
  private jubileeCount = 0;
  private jubileeArmed = true;
  private giniSustainCount = 0;
  private lastJubileeTick: number | null = null;
  private commonsPoolBalance = 0;
  private catalystActive = false;
  /** The multiplier in force after the last step (1 until the first step; the read-out reports it). */
  private lastMultiplier = 1;
  /** Transient estate-dedup ring (NOT persisted): an address is duty'd once per instance lifetime. */
  private seenEstates: string[] = [];

  constructor(private readonly cfg: ReformConfig) {}

  /**
   * One round per cron, driven by state.ts AFTER the flush (it reads the cron's final snapshot) and BEFORE
   * observeChronicle (so this cron's edges fold into the SAME historian context). PURE read-out + internal
   * bookkeeping: it moves no real money and triggers no chain transaction.
   */
  step(ctx: ReformStepContext): ReformStepResult {
    const events: ReformEvent[] = [];
    const ubiDistributions: { address: string; amount: number }[] = [];
    const levyDeductions: { address: string; amount: number }[] = [];
    let debtForgiveness: string[] = [];

    if (!this.cfg.enabled) {
      this.lastMultiplier = 1;
      return { events, catalystMultiplier: 1, ubiDistributions, debtForgiveness, levyDeductions };
    }

    const agents = ctx.agents ?? [];
    const agentCount = agents.length;
    const gini = num(ctx.gini, 0);
    const tickIndex = num(ctx.tickIndex, 0);
    const ticksPerCron = Math.max(1, num(ctx.ticksPerCron, 1));

    // ── A. PROGRESSIVE ESTATE DUTY ──────────────────────────────────────────────────────────────────────
    let ubiThisCron = 0;
    for (const g of ctx.graves ?? []) {
      const addr = typeof g?.address === "string" && g.address ? g.address : null;
      if (!addr) continue;
      if (this.seenEstates.includes(addr)) continue;       // an estate is duty'd once per instance lifetime
      this.seenEstates.push(addr);
      if (this.seenEstates.length > RF_SEEN_MEM) this.seenEstates = this.seenEstates.slice(-RF_SEEN_MEM);

      const gross = num(g.balance, 0);
      const tax = estateDutyOf(gross);
      if (tax <= 0) continue;                               // a bare subsistence passes untouched

      // Half to the standing commons pool, half returned at once as a flat UBI (all to the pool if nobody
      // is living to receive it — the duty is never silently destroyed).
      const poolShare = agentCount > 0 ? ESTATE_POOL_SHARE : 1;
      const toPool = tax * poolShare;
      const toUbi = tax - toPool;
      this.commonsPoolBalance += toPool;
      ubiThisCron += toUbi;
      this.estateDutyCollected += tax;

      const ubiPerAgent = agentCount > 0 ? toUbi / agentCount : 0;
      events.push({ kind: "ESTATE_LEVIED", address: addr, gross, tax, ubiPerAgent });
    }
    if (ubiThisCron > 0 && agentCount > 0) {
      const per = ubiThisCron / agentCount;
      for (const a of agents) {
        if (typeof a?.address === "string" && a.address) ubiDistributions.push({ address: a.address, amount: per });
      }
    }

    // ── C. THE JUBILEE STABILIZER (hysteresis arm + sustain counter + cooldown) ─────────────────────────
    if (gini <= GINI_JUBILEE_RESET) {
      // Equal enough to deserve a reset: re-arm and clear the run.
      this.giniSustainCount = 0;
      this.jubileeArmed = true;
    } else if (gini > GINI_JUBILEE_THRESHOLD) {
      // In crisis: count the sustained run ONLY while armed (a spent stabilizer must re-arm first).
      if (this.jubileeArmed) this.giniSustainCount++;
    }
    // else: the hysteresis band (RESET < gini ≤ THRESHOLD) — hold the run, change nothing (no chatter).

    const cooldownTicks = JUBILEE_COOLDOWN_CRONS * ticksPerCron;
    const cooledDown = this.lastJubileeTick == null || tickIndex - this.lastJubileeTick > cooldownTicks;
    if (this.jubileeArmed && this.giniSustainCount >= JUBILEE_SUSTAIN_CRONS && cooledDown) {
      // Proclaim the levitical year: forgive every enumerable debt, levy the wealthiest tenth, and divide
      // the whole commons pool plus that levy equally among the living as a one-time stimulus.
      debtForgiveness = (ctx.economy ? ctx.economy.creditIouRecords() : []).map((r) => r.id).filter((id) => typeof id === "string" && !!id);

      let levyCollected = 0;
      if (agentCount > 0) {
        const byBalance = agents.slice().sort((x, y) => num(y?.balance, 0) - num(x?.balance, 0) || String(x?.address).localeCompare(String(y?.address)));
        const topN = Math.max(1, Math.ceil(agentCount * JUBILEE_TOP_SHARE));
        for (const a of byBalance.slice(0, topN)) {
          const bal = num(a?.balance, 0);
          const levy = bal > 0 ? bal * JUBILEE_TOP_LEVY_RATE : 0;
          if (levy > 0 && typeof a?.address === "string" && a.address) {
            levyDeductions.push({ address: a.address, amount: levy });
            levyCollected += levy;
          }
        }
      }

      const pot = levyCollected + this.commonsPoolBalance;
      const stimulusPerAgent = agentCount > 0 ? pot / agentCount : 0;
      // The jubilee spends the whole commons pool (it returns to the citizens what the duty gathered).
      this.commonsPoolBalance = 0;

      this.jubileeCount++;
      this.jubileeArmed = false;            // spent — must fall back to RESET to re-arm
      this.giniSustainCount = 0;
      this.lastJubileeTick = tickIndex;
      events.push({ kind: "JUBILEE_PROCLAIMED", debtsForgiven: debtForgiveness.length, levyCollected, stimulusPerAgent });
    }

    // ── F. THE DARK-AGE CATALYST ────────────────────────────────────────────────────────────────────────
    const wasActive = this.catalystActive;
    const multiplier = catalystMultiplierOf(gini, ctx.civPhase);
    this.lastMultiplier = multiplier;
    this.catalystActive = multiplier > 1;
    if (multiplier > CATALYST_SURGE_AT && !wasActive) {
      events.push({ kind: "CATALYST_SURGE", multiplier });
    }

    return { events, catalystMultiplier: multiplier, ubiDistributions, debtForgiveness, levyDeductions };
  }

  /** The standing read-out (folded into /economy + /population ONLY while REFORM_ENABLED). */
  readout(): ReformReadout {
    return {
      enabled: this.cfg.enabled,
      estateDutyCollected: this.estateDutyCollected,
      jubileeCount: this.jubileeCount,
      jubileeArmed: this.jubileeArmed,
      giniSustainCount: this.giniSustainCount,
      catalystMultiplier: this.lastMultiplier,
      lastJubileeTick: this.lastJubileeTick,
      commonsPoolBalance: this.commonsPoolBalance,
    };
  }

  // ─── persistence (bounded scalars, additive) ─────────────────────────────────────────────────────────

  serialize(): string {
    const body: ReformSerialized = {
      v: RF_VERSION as 1,
      estateDutyCollected: this.estateDutyCollected,
      jubileeCount: this.jubileeCount,
      jubileeArmed: this.jubileeArmed,
      giniSustainCount: this.giniSustainCount,
      lastJubileeTick: this.lastJubileeTick,
      commonsPoolBalance: this.commonsPoolBalance,
      catalystActive: this.catalystActive,
    };
    return JSON.stringify(body);
  }

  /**
   * Rebuild a layer from its persisted blob. A corrupt/absent blob yields a COLD layer (never a poisoned
   * ledger). Numeric fields are coerced with an explicit finiteness check — NEVER `Number(v) || d`, which
   * would silently drop a legitimate 0 (the house-id-0 pitfall this codebase has already paid for once).
   */
  static deserialize(json: string): ReformLayer {
    const layer = new ReformLayer({ enabled: true });
    if (typeof json !== "string" || !json) return layer;
    try {
      const p = JSON.parse(json);
      if (!p || typeof p !== "object") return layer;
      layer.estateDutyCollected = Math.max(0, num(p.estateDutyCollected, 0));
      layer.jubileeCount = Math.max(0, num(p.jubileeCount, 0));
      layer.jubileeArmed = p.jubileeArmed == null ? true : !!p.jubileeArmed;
      layer.giniSustainCount = Math.max(0, num(p.giniSustainCount, 0));
      layer.commonsPoolBalance = Math.max(0, num(p.commonsPoolBalance, 0));
      layer.catalystActive = !!p.catalystActive;
      layer.lastJubileeTick =
        p.lastJubileeTick == null || !Number.isFinite(Number(p.lastJubileeTick)) ? null : Number(p.lastJubileeTick);
      // A restored layer reports its standing multiplier as neutral until the next step re-derives it.
      layer.lastMultiplier = 1;
      return layer;
    } catch {
      return layer; // corrupt → cold: a reform layer restarts empty, never poisoned
    }
  }
}
