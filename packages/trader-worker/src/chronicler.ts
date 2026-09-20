// ============================================================================================================
// chronicler.ts — the deterministic historian that turns raw swarm state into STORY and HISTORY.
//
// This is the "chronicle engine": once per cron it reads the SAME read-out the economy reads (collective mood,
// the ethogram FAP distribution, per-fly valence, and the lifetime economy totals) and DETECTS history-making
// moments via pure, stateless-friendly rules — eras dawning, the first settlement, a wealth record, a panic,
// the great huddle, a feeding frenzy, births, milestones, a change of leadership. Each detected event is
// rendered into one narrative sentence FROM TEMPLATES (no LLM anywhere — the whole project's identity), and
// appended to an ordered chronicle.
//
// Iron-clad constraints this file upholds:
//   • PURE READ-OUT. It observes state; it never mutates a connectome, a drive, a wallet or a settlement
//     decision. Economy remains a one-way read of neurons; nothing here feeds back. Zero gas, zero on-chain
//     commitment, so the brain manifest hash is untouched.
//   • DETERMINISTIC & REPLAYABLE. No Math.random, no Date.now inside the logic (timestamps are passed in),
//     no locale-dependent formatting. Given the same sequence of contexts it yields the same entries — so the
//     chronicle can, like the receipts, one day be hash-anchored and re-derived by anyone.
//   • BOUNDED. It keeps only a handful of monotonic trackers, so its serialized state is tiny and DO-safe.
// ============================================================================================================

export type ChronicleKind =
  | "ERA_OPEN"
  | "ERA_SHIFT"
  | "FIRST_TRADE"
  | "MILESTONE"
  | "BIRTH"
  | "PANIC"
  | "STORM"
  | "HUDDLE"
  | "FEAST"
  | "RECORD_CONC"
  | "LEAD_CHANGE";

export interface ChronicleEntry {
  seq: number;                      // monotonic ordinal within this chronicle (D1 primary key)
  tick: number;
  ts: number;                       // unix ms, supplied by the caller (never read from a clock here)
  kind: ChronicleKind;
  era: number;                      // era index when this happened
  eraName: string;                  // evocative name of that era
  severity: 1 | 2 | 3;              // visual weight (3 = chapter-defining)
  actors: number[];                 // implicated fly ids (may be empty)
  text: string;                     // the rendered narrative line
  metrics: Record<string, number>;  // the raw numbers behind the sentence (for the UI / audit)
}

/** The per-cron facts the historian reads. Primitives + loose records so it stays decoupled from the
 *  population/economy types (the caller adapts its own snapshot into this shape). */
export interface ChronicleContext {
  tick: number;
  ts: number;
  temperature: number;
  regime: "HOT" | "CALM" | "COLD";
  size: number;
  states: Record<string, number>;   // AGITATE / EXPLORE / AGGREGATE / REST counts
  faps: Record<string, number>;     // FEED / GROOM / ... / HUDDLE counts this tick
  valence: number;                  // mean approach−avoid, −1..1
  arousal: number;
  cohesion: number;
  rest: number;
  settlements: number;              // lifetime successful settlements (monotonic)
  volumeUsdc: number;               // lifetime settled volume
  gini: number;                     // wealth concentration 0..1
  richestId: number | null;
  poorestId: number | null;
  liveAgents: number;
  meanBalanceUsdc: number;
}

/** The persistent monotonic memory across crons/restarts. Small and JSON-safe. */
interface ChroniclerState {
  inited: boolean;
  seq: number;
  era: number;
  eraName: string;
  eraRegime: "HOT" | "CALM" | "COLD";
  eraStartTick: number;
  prevRegime: "HOT" | "CALM" | "COLD" | null;
  regimeRun: number;                // consecutive crons felt in the current regime
  firstTradeDone: boolean;
  lastMilestone: number;            // highest 1000-settlement milestone announced
  maxSize: number;                  // largest swarm seen (a birth is a new high)
  maxGini: number;                  // all-time concentration high
  leaderId: number | null;          // last known richest agent
  lastKindTick: Record<string, number>;
}

const ERA_NAMES: Record<ChronicleContext["regime"], string[]> = {
  HOT: ["the Scorch", "the Fever", "the Long Burn", "the Surge", "Ember-time"],
  CALM: ["the Drift", "the Even Tide", "the Quiet Middle", "the Slow Current", "the Poise"],
  COLD: ["the Long Frost", "the Great Huddle", "the Still Age", "the Deep Winter", "Frostline"],
};

// Minimum crons before the same kind may repeat, so the chronicle stays a chronicle, not a stutter.
const COOLDOWN: Partial<Record<ChronicleKind, number>> = {
  PANIC: 3, STORM: 5, HUDDLE: 5, FEAST: 4, BIRTH: 2, LEAD_CHANGE: 2, RECORD_CONC: 3,
};

// A regime must hold for this many crons (and the era be at least this old) before a new era dawns.
const ERA_MIN_RUN = 6;
const ERA_MIN_AGE = 8;

function roman(n: number): string {
  if (n <= 0) return String(n);
  const map: [number, string][] = [
    [1000, "M"], [900, "CM"], [500, "D"], [400, "CD"], [100, "C"], [90, "XC"],
    [50, "L"], [40, "XL"], [10, "X"], [9, "IX"], [5, "V"], [4, "IV"], [1, "I"],
  ];
  let out = "";
  let rest = n;
  for (const [v, s] of map) { while (rest >= v) { out += s; rest -= v; } }
  return out;
}

function clamp01(x: number): number { return Math.min(1, Math.max(0, x)); }

export class Chronicler {
  private s: ChroniclerState = freshState();

  /** Feed one cron's read-out; returns zero or more newly-detected chronicle entries (oldest→newest). */
  observe(ctx: ChronicleContext): ChronicleEntry[] {
    const out: ChronicleEntry[] = [];
    const s = this.s;

    // First sight of the swarm → the founding of Era I.
    if (!s.inited) {
      s.inited = true;
      s.era = 1;
      s.eraName = "the Awakening";
      s.eraRegime = ctx.regime;
      s.eraStartTick = ctx.tick;
      s.prevRegime = ctx.regime;
      s.regimeRun = 1;
      s.maxSize = ctx.size;
      s.maxGini = ctx.gini;
      s.leaderId = ctx.richestId;
      out.push(this.emit(ctx, "ERA_OPEN", 3, [],
        `Era I · the Awakening — ${ctx.size} minds open their eyes on the Arc market and begin, for the first time, to feel the price.`,
        { size: ctx.size, temperature: round(ctx.temperature) }));
    } else {
      // --- era bookkeeping: a regime must HOLD to be remembered as an age ---
      if (ctx.regime === s.prevRegime) s.regimeRun += 1;
      else { s.regimeRun = 1; s.prevRegime = ctx.regime; }

      const eraAge = ctx.tick - s.eraStartTick;
      if (ctx.regime !== s.eraRegime && s.regimeRun >= ERA_MIN_RUN && eraAge >= ERA_MIN_AGE) {
        s.era += 1;
        s.eraRegime = ctx.regime;
        s.eraStartTick = ctx.tick;
        const pool = ERA_NAMES[ctx.regime];
        const pick = pool[(s.era - 1) % pool.length];
        // avoid ever repeating the exact same title back-to-back
        s.eraName = pick === s.eraName ? pool[s.era % pool.length] : pick;
        out.push(this.emit(ctx, "ERA_SHIFT", 3, [],
          `Era ${roman(s.era)} · ${s.eraName} dawns — the market has turned ${ctx.regime.toLowerCase()} and held it. An age begins.`,
          { era: s.era, temperature: round(ctx.temperature) }));
      }
    }

    // --- the economy's first light ---
    if (!s.firstTradeDone && ctx.settlements > 0) {
      s.firstTradeDone = true;
      out.push(this.emit(ctx, "FIRST_TRADE", 3, namedActors(ctx),
        `The first exchange settles on-chain — agents trade real USDC for the first time across ${ctx.liveAgents} wallets. A swarm becomes a market.`,
        { volumeUsdc: round(ctx.volumeUsdc), liveAgents: ctx.liveAgents }));
    }

    // --- milestones (lifetime settlements crossing each thousand) ---
    if (ctx.settlements > 0) {
      const th = Math.floor(ctx.settlements / 1000);
      if (th > s.lastMilestone) {
        s.lastMilestone = th;
        out.push(this.emit(ctx, "MILESTONE", 2, [],
          `Milestone — the ledger records its ${romanUnit(th * 1000)} verifiable exchange. ${ctx.settlements} settlements, ${round(ctx.volumeUsdc)} USDC moved.`,
          { settlements: ctx.settlements, volumeUsdc: round(ctx.volumeUsdc) }));
      }
    }

    // --- births: the swarm swells past its all-time high (an offspring hatched) ---
    if (ctx.size > s.maxSize) {
      s.maxSize = ctx.size;
      if (this.ready("BIRTH", ctx)) {
        out.push(this.emit(ctx, "BIRTH", 2, [],
          `A new generation hatches into the live swarm — it now numbers ${ctx.size} minds, a record for the species.`,
          { size: ctx.size }));
      }
    }

    // --- wealth chronicles ---
    if (ctx.gini > s.maxGini + 0.02 && this.ready("RECORD_CONC", ctx)) {
      s.maxGini = ctx.gini;
      out.push(this.emit(ctx, "RECORD_CONC", 2, idList(ctx.richestId),
        `Wealth gathers like never before — the gini climbs to ${round(ctx.gini)}, the sharpest inequality the swarm has known.`,
        { gini: round(ctx.gini) }));
    } else if (ctx.gini > s.maxGini) {
      s.maxGini = ctx.gini;
    }
    if (ctx.richestId != null && s.leaderId != null && ctx.richestId !== s.leaderId && this.ready("LEAD_CHANGE", ctx)) {
      out.push(this.emit(ctx, "LEAD_CHANGE", 2, [s.leaderId, ctx.richestId],
        `Fly #${ctx.richestId} overtakes fly #${s.leaderId} at the head of the ledger — the richest purse changes hands.`,
        { oldLeader: s.leaderId, newLeader: ctx.richestId, gini: round(ctx.gini) }));
      s.leaderId = ctx.richestId;
    } else if (ctx.richestId != null) {
      s.leaderId = ctx.richestId;
    }

    // --- behavioural weather, read from the ethogram FAP distribution ---
    const n = Math.max(1, ctx.size);
    const flight = (ctx.faps.FLIGHT ?? 0) + (ctx.faps.RETREAT ?? 0);
    const still = (ctx.faps.HUDDLE ?? 0) + (ctx.faps.REST ?? 0) + (ctx.faps.HALT ?? 0);
    const feed = ctx.faps.FEED ?? 0;

    if (ctx.regime === "HOT" && flight / n >= 0.34 && this.ready("PANIC", ctx)) {
      out.push(this.emit(ctx, "PANIC", 3, [],
        `Panic sweeps the hot market (T=${round(ctx.temperature)}) — ${flight} flies bolt into flight and retreat at once. The swarm routs.`,
        { flight, size: ctx.size, temperature: round(ctx.temperature) }));
    }
    if (ctx.temperature >= 0.97 && this.ready("STORM", ctx)) {
      out.push(this.emit(ctx, "STORM", 3, [],
        `A scorching pulse peaks the temperature at ${round(ctx.temperature)}; the whole connectome swarm convulses under the heat.`,
        { temperature: round(ctx.temperature), arousal: round(ctx.arousal) }));
    }
    if (ctx.regime === "COLD" && still / n >= 0.6 && this.ready("HUDDLE", ctx)) {
      out.push(this.emit(ctx, "HUDDLE", 2, [],
        `The Great Huddle — cold pins the swarm still; ${still} flies rest and crowd together against the freeze (T=${round(ctx.temperature)}).`,
        { still, size: ctx.size, temperature: round(ctx.temperature) }));
    }
    if (feed / n >= 0.3 && this.ready("FEAST", ctx)) {
      out.push(this.emit(ctx, "FEAST", 2, [],
        `A feeding frenzy — ${feed} flies extend their proboscides at once as the market suddenly smells of sugar.`,
        { feed, size: ctx.size, valence: round(ctx.valence) }));
    }

    return out;
  }

  /** Can this kind fire now (cooldown respected)? Records nothing; the caller marks it via emit. */
  private ready(kind: ChronicleKind, ctx: ChronicleContext): boolean {
    const gap = COOLDOWN[kind] ?? 0;
    const last = this.s.lastKindTick[kind];
    if (last != null && ctx.tick - last < gap) return false;
    return true;
  }

  private emit(
    ctx: ChronicleContext,
    kind: ChronicleKind,
    severity: 1 | 2 | 3,
    actors: number[],
    text: string,
    metrics: Record<string, number>,
  ): ChronicleEntry {
    this.s.seq += 1;
    this.s.lastKindTick[kind] = ctx.tick;
    return {
      seq: this.s.seq,
      tick: ctx.tick,
      ts: ctx.ts,
      kind,
      era: this.s.era,
      eraName: this.s.eraName,
      severity,
      actors,
      text,
      metrics,
    };
  }

  /** The current age, for the UI header. */
  eraInfo(): { era: number; eraName: string; eraRegime: ChronicleContext["regime"]; seq: number } {
    return { era: this.s.era, eraName: this.s.eraName, eraRegime: this.s.eraRegime, seq: this.s.seq };
  }

  snapshot(): ChroniclerState { return JSON.parse(JSON.stringify(this.s)); }

  restore(st: Partial<ChroniclerState> | null | undefined): void {
    if (!st) return;
    this.s = { ...freshState(), ...st, lastKindTick: { ...(st.lastKindTick ?? {}) } };
  }
}

function freshState(): ChroniclerState {
  return {
    inited: false, seq: 0, era: 1, eraName: "the Awakening", eraRegime: "COLD",
    eraStartTick: 0, prevRegime: null, regimeRun: 0, firstTradeDone: false,
    lastMilestone: 0, maxSize: 0, maxGini: 0, leaderId: null, lastKindTick: {},
  };
}

function idList(id: number | null): number[] { return id == null ? [] : [id]; }

/** The fly most worth naming on a founding moment: the richest, if known. */
function namedActors(ctx: ChronicleContext): number[] { return idList(ctx.richestId); }

function round(x: number): number { return Math.round(clamp100(x) * 1000) / 1000; }
// keep values readable in JSON without over-clamping real metrics (settlements can be huge)
function clamp100(x: number): number { return Number.isFinite(x) ? Math.max(-1e9, Math.min(1e9, x)) : 0; }

function romanUnit(n: number): string {
  // friendly ordinal words for milestone counts ("one thousandth", "twenty thousandth", …).
  // The caller treats this as a complete ordinal — it MUST already end in "th".
  const k = Math.round(n / 1000);
  const words = ["", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten",
    "eleven", "twelve", "thirteen", "fourteen", "fifteen", "sixteen", "seventeen", "eighteen", "nineteen", "twenty"];
  const w = words[k] ?? String(k);
  return `${w} thousandth`;
}
