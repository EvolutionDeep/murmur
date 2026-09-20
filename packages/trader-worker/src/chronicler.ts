// ============================================================================================================
// chronicler.ts — the deterministic historian that turns raw swarm state into STORY and HISTORY.
//
// This is the "chronicle engine": once per cron it reads the SAME read-out the economy reads (collective mood,
// the ethogram FAP distribution, per-fly valence, and the lifetime economy totals) and DETECTS history-making
// moments via pure, stateless-friendly rules — eras dawning, the first settlement, a wealth record, a panic,
// the great huddle, a feeding frenzy, births, milestones, a change of leadership. Each detected event is
// rendered into one narrative sentence FROM A PUBLIC TEMPLATE (no LLM anywhere — the whole project's identity),
// and appended to an ordered, HASH-CHRONED chronicle.
//
// WHY THIS IS PROVABLY "NOT AN LLM" (the verification model, mirrored byte-for-byte in the browser):
//   1. DETERMINISTIC RE-DERIVATION. Every sentence is renderTemplate(kind, tokens) — a pure string substitution
//      over the entry's own `tokens` (the raw numbers it cites). A visitor ships the SAME TEMPLATES table, fills
//      it with the entry's tokens, and must reproduce the served `text` exactly. An LLM cannot be re-derived
//      this way; if the words regenerate from a template + real numbers, they are the template's, not a model's.
//   2. TAMPER-EVIDENT CHAIN. Each entry carries prevHash + hash = sha256(canonical(entryCore) ‖ prevHash). Edit
//      any word and the chain breaks; the head is a single binding digest of the whole history.
//   3. RULES FINGERPRINT. chroniclerRulesHash() = sha256 of the entire deterministic rule-set (templates,
//      thresholds, cooldowns, era-names). It is the historian's "genome": match it and you know exactly WHICH
//      rule-set wrote every line — and that it contains no model, only string templates and comparisons.
//
// Iron-clad constraints this file upholds:
//   • PURE READ-OUT. It observes state; it never mutates a connectome, a drive, a wallet or a settlement
//     decision. Economy remains a one-way read of neurons; nothing here feeds back. Zero gas, zero on-chain
//     commitment, so the brain manifest hash is untouched.
//   • DETERMINISTIC & REPLAYABLE. No Math.random, no Date.now inside the logic (timestamps are passed in),
//     no locale-dependent formatting. Given the same sequence of contexts it yields the same entries + chain.
//   • BOUNDED. It keeps only a handful of monotonic trackers + one running head hash, so its serialized state
//     is tiny and DO-safe.
// ============================================================================================================

import { canonical, sha256Hex } from "./provenance.js";

export const CHRONICLE_VERSION = 1;
/** The chain's seed: the prevHash of the very first entry. A fixed, well-known constant. */
export const GENESIS_HASH = "0".repeat(64);

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
  | "LEAD_CHANGE"
  | "FEUD"
  | "ALLIANCE"
  | "BETRAYAL"
  | "REPUTATION"
  | "HOUSE_FOUNDED"
  | "DYNASTY"
  | "ELEGY";

export interface ChronicleEntry {
  seq: number;                      // monotonic ordinal within this chronicle (D1 primary key)
  tick: number;
  ts: number;                       // unix ms, supplied by the caller (never read from a clock here)
  kind: ChronicleKind;
  era: number;                      // era index when this happened
  eraName: string;                  // evocative name of that era
  severity: 1 | 2 | 3;              // visual weight (3 = chapter-defining)
  actors: number[];                 // implicated fly ids (may be empty)
  text: string;                     // the rendered narrative line == renderTemplate(kind, tokens)
  metrics: Record<string, number>;  // the raw numbers behind the sentence (for the UI / audit)
  tokens: Record<string, string | number>;  // the EXACT substitution values the template was filled with
  prevHash: string;                 // hash of the previous entry (GENESIS_HASH for the first)
  hash: string;                     // sha256(canonical({...core, prevHash})) — binds this entry to the chain
}

/** The social-memory read-out the historian narrates (computed by the ECONOMY layer from its persisted
 *  bonds/reputation/grudge book; the historian only turns it into words — pure read-out, no feedback). */
export interface ChronicleSocial {
  topFeud: { a: number; b: number; score: number } | null;        // live blacklist-deep grudge
  topAlliance: { a: number; b: number; score: number; trades: number } | null;  // seasoned partnership
  betrayal: { tick: number; buyerId: number; sellerId: number; amountUsdc: number } | null; // newest grudge-book entry
  deadbeat: { id: number; kept: number; broken: number; score: number } | null;  // worst live reputation
}

/** The dynasty read-out the historian narrates (houses, dominance, deaths — all computed by the ECONOMY
 *  layer from its persisted kinship ledger; same pure read-out law as ChronicleSocial above). */
export interface ChronicleDynasty {
  founding: { houseId: number; name: string; sigil: string; founder: number; childId: number; tick: number } | null;  // newest house
  dominance: { id: number; name: string; sigil: string; capitalShare: number; gen: number } | null;                   // house holding the swarm's capital
  death: { id: number; tick: number; cause: string; deals: number; age: number; estateUsdc: number; heirIds: number[]; houseName: string | null } | null; // newest grave
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
  /** SOCIAL read-out (optional for replay-compat: older callers simply narrate no relationships). */
  social?: ChronicleSocial | null;
  /** DYNASTY read-out (optional for replay-compat: older callers simply narrate no houses or deaths). */
  dynasty?: ChronicleDynasty | null;
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
  // --- relationship trackers: fire a social entry only when the RELATIONSHIP landscape changed, so a
  //     standing feud is announced once, not re-declared every cron (the anti-stutter rule) ---
  lastFeudKey: string | null;       // "a>b" of the last announced feud
  lastAllianceKey: string | null;   // "a>b" of the last announced alliance
  lastBetrayalTick: number;         // grudge-book tick already told
  lastDeadbeatId: number | null;    // last named deadbeat
  // --- dynasty trackers: a founding is told once per house, a dominance high once per (house,generation),
  //     an epitaph once per burial tick — landscape-change detectors, never a per-cron stutter ---
  lastHouseKey: string | null;      // houseId of the last announced founding
  lastDynastyKey: string | null;    // "id>gen" of the last announced dominance
  lastDeathTick: number;            // grave tick already told
  headHash: string;                 // hash of the most-recently-emitted entry (GENESIS_HASH until first emit)
}

// ------------------------------------------------------------------------------------------------------------
// The PUBLIC rule-set. These five tables ARE the historian. Their sha256 (chroniclerRulesHash) is the single
// value a visitor checks to know the whole rule-set is the deterministic one shipped in the open-source repo —
// no model weights, only these strings and these thresholds.
// ------------------------------------------------------------------------------------------------------------

const ERA_NAMES: Record<ChronicleContext["regime"], string[]> = {
  HOT: ["the Scorch", "the Fever", "the Long Burn", "the Surge", "Ember-time"],
  CALM: ["the Drift", "the Even Tide", "the Quiet Middle", "the Slow Current", "the Poise"],
  COLD: ["the Long Frost", "the Great Huddle", "the Still Age", "the Deep Winter", "Frostline"],
};

// Minimum crons before the same kind may repeat, so the chronicle stays a chronicle, not a stutter.
const COOLDOWN: Partial<Record<ChronicleKind, number>> = {
  PANIC: 3, STORM: 5, HUDDLE: 5, FEAST: 4, BIRTH: 2, LEAD_CHANGE: 2, RECORD_CONC: 3,
  FEUD: 8, ALLIANCE: 8, BETRAYAL: 2, REPUTATION: 12,
  HOUSE_FOUNDED: 4, DYNASTY: 16, ELEGY: 1,
};

// A regime must hold for this many crons (and the era be at least this old) before a new era dawns.
const ERA_MIN_RUN = 6;
const ERA_MIN_AGE = 8;

/** The narrative templates. `{key}` inserts tokens[key]; `{key~roman}` / `{key~kth}` / `{key~lower}` apply a
 *  tiny, fully-deterministic formatter (see renderToken). This exact map is shipped to the browser verbatim. */
export const TEMPLATES: Record<ChronicleKind, string> = {
  ERA_OPEN: "Era {era~roman} · {eraName} — {size} minds tend the swarm on the Arc market, and the chronicle opens.",
  ERA_SHIFT: "Era {era~roman} · {eraName} dawns — the market has turned {regime~lower} and held it. An age begins.",
  FIRST_TRADE: "The first exchange settles on-chain — agents trade real USDC for the first time across {liveAgents} wallets. A swarm becomes a market.",
  MILESTONE: "Milestone — the ledger records its {settlements~kth} verifiable exchange. {settlements} settlements, {volumeUsdc} USDC moved.",
  BIRTH: "A new generation hatches into the live swarm — it now numbers {size} minds, a record for the species.",
  PANIC: "Panic sweeps the hot market (T={temperature}) — {flight} flies bolt into flight and retreat at once. The swarm routs.",
  STORM: "A scorching pulse peaks the temperature at {temperature}; the whole connectome swarm convulses under the heat.",
  HUDDLE: "The Great Huddle — cold pins the swarm still; {still} flies rest and crowd together against the freeze (T={temperature}).",
  FEAST: "A feeding frenzy — {feed} flies extend their proboscides at once as the market suddenly smells of sugar.",
  RECORD_CONC: "Wealth gathers like never before — the gini climbs to {gini}, the sharpest inequality the swarm has known.",
  LEAD_CHANGE: "Fly #{newLeader} overtakes fly #{oldLeader} at the head of the ledger — the richest purse changes hands.",
  FEUD: "Fly #{a} will not trade with fly #{b} — the old score still smoulders (bond {bond}). A grudge has become market law.",
  ALLIANCE: "Fly #{a} and fly #{b} have settled {trades} dealings in good faith — the swarm's steadiest partnership (bond {bond}).",
  BETRAYAL: "Fly #{buyer} defaults on a {amountUsdc} USDC debt to fly #{seller} — the name is entered in the grudge book.",
  REPUTATION: "Word across the market: fly #{id} is known for {broken} defaults against {kept} kept settlements — the purse is public, so is the name.",
  HOUSE_FOUNDED: "Fly #{founder} founds the House of {name} — its sigil {sigil} rises as fly #{child} takes the name. A lineage begins in the ledger.",
  DYNASTY: "The House of {name} holds {share} of all the swarm's capital at generation {gen} — ledgers bend before an old name.",
  ELEGY: "Fly #{id} of {house} falls to {cause} — {deals} dealings, age {age}. An estate of {estateUsdc} USDC passes to {heirs}. The name endures.",
};

// ------------------------------------------------------------------------------------------------------------
// Pure formatters + the template renderer. The browser ships the identical logic so it can re-derive text.
// ------------------------------------------------------------------------------------------------------------

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

/** Ordinal words for a milestone count ("one thousandth", "21 thousandth", …). */
function kth(settlements: number): string {
  const k = Math.round(settlements / 1000);
  const words = ["", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten",
    "eleven", "twelve", "thirteen", "fourteen", "fifteen", "sixteen", "seventeen", "eighteen", "nineteen", "twenty"];
  const w = words[k] ?? String(k);
  return `${w} thousandth`;
}

function renderToken(value: string | number, formatter?: string): string {
  switch (formatter) {
    case "roman": return roman(Number(value));
    case "kth": return kth(Number(value));
    case "lower": return String(value).toLowerCase();
    default: return String(value);
  }
}

/** Fill a template from an entry's tokens. Deterministic, dependency-free, and mirrored in the browser. */
export function renderTemplate(kind: ChronicleKind, tokens: Record<string, string | number>): string {
  const tpl = TEMPLATES[kind];
  if (!tpl) return "";
  return tpl.replace(/\{(\w+)(?:~(\w+))?\}/g, (_m, key: string, fmt?: string) =>
    renderToken(tokens[key] ?? "", fmt));
}

/** The historian's "genome": a single digest of the entire deterministic rule-set. */
export function chroniclerRulesHash(): Promise<string> {
  return sha256Hex({
    v: CHRONICLE_VERSION,
    templates: TEMPLATES,
    eraNames: ERA_NAMES,
    cooldown: COOLDOWN,
    eraMinRun: ERA_MIN_RUN,
    eraMinAge: ERA_MIN_AGE,
  });
}

/** The canonical pre-image that an entry's hash commits to (everything except the hash itself). */
export function entryHashInput(e: ChronicleEntry): Record<string, unknown> {
  return {
    seq: e.seq, tick: e.tick, ts: e.ts, kind: e.kind, era: e.era, eraName: e.eraName,
    severity: e.severity, actors: e.actors, text: e.text, metrics: e.metrics, tokens: e.tokens,
    prevHash: e.prevHash,
  };
}

/** Recompute an entry's hash from its own fields (async: SHA-256 via WebCrypto). */
export function computeEntryHash(e: ChronicleEntry): Promise<string> {
  return sha256Hex(entryHashInput(e));
}

export interface ChainVerifyResult {
  ok: boolean;
  head: string;
  /** index of the first broken entry (-1 when ok) */
  brokenAt: number;
  reason: string;
}

/** Verify a served chronicle's hash chain end-to-end (integrity + linkage). The browser does the same. */
export async function verifyChain(entries: ChronicleEntry[]): Promise<ChainVerifyResult> {
  let prev = GENESIS_HASH;
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i];
    if (e.prevHash !== prev) return { ok: false, head: prev, brokenAt: i, reason: "prev-hash mismatch" };
    const recomputed = await computeEntryHash(e);
    if (recomputed !== e.hash) return { ok: false, head: e.hash, brokenAt: i, reason: "entry hash mismatch (text/tokens altered)" };
    // The sentence must regenerate from its own template + tokens — the direct "not an LLM" check.
    if (renderTemplate(e.kind, e.tokens) !== e.text) return { ok: false, head: e.hash, brokenAt: i, reason: "text does not match template(kind, tokens)" };
    prev = e.hash;
  }
  return { ok: true, head: prev, brokenAt: -1, reason: "chain intact · every line re-derives from a public template" };
}

function clamp01(x: number): number { return Math.min(1, Math.max(0, x)); }

export class Chronicler {
  private s: ChroniclerState = freshState();

  /** Feed one cron's read-out; returns zero or more newly-detected chronicle entries (oldest→newest).
   *  Async because each emitted line is folded into the SHA-256 chain. */
  async observe(ctx: ChronicleContext): Promise<ChronicleEntry[]> {
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
      // A FRESH historian meeting an ALREADY-MATURE swarm is a restart / re-install, not a genesis: it
      // did not witness the first trade or the milestones already passed, so seed those trackers and stay
      // silent about them. The (reworded) ERA_OPEN still opens the new record honestly at the current era.
      if (ctx.settlements > 0) {
        s.firstTradeDone = true;
        s.lastMilestone = Math.floor(ctx.settlements / 1000);
      }
      out.push(await this.emit(ctx, "ERA_OPEN", 3, [],
        { era: s.era, eraName: s.eraName, size: ctx.size, temperature: round(ctx.temperature) },
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
        out.push(await this.emit(ctx, "ERA_SHIFT", 3, [],
          { era: s.era, eraName: s.eraName, regime: ctx.regime, temperature: round(ctx.temperature) },
          { era: s.era, temperature: round(ctx.temperature) }));
      }
    }

    // --- the economy's first light ---
    if (!s.firstTradeDone && ctx.settlements > 0) {
      s.firstTradeDone = true;
      out.push(await this.emit(ctx, "FIRST_TRADE", 3, namedActors(ctx),
        { liveAgents: ctx.liveAgents, volumeUsdc: round(ctx.volumeUsdc) },
        { volumeUsdc: round(ctx.volumeUsdc), liveAgents: ctx.liveAgents }));
    }

    // --- milestones (lifetime settlements crossing each thousand) ---
    if (ctx.settlements > 0) {
      const th = Math.floor(ctx.settlements / 1000);
      if (th > s.lastMilestone) {
        s.lastMilestone = th;
        out.push(await this.emit(ctx, "MILESTONE", 2, [],
          { settlements: ctx.settlements, volumeUsdc: round(ctx.volumeUsdc) },
          { settlements: ctx.settlements, volumeUsdc: round(ctx.volumeUsdc) }));
      }
    }

    // --- births: the swarm swells past its all-time high (an offspring hatched) ---
    if (ctx.size > s.maxSize) {
      s.maxSize = ctx.size;
      if (this.ready("BIRTH", ctx)) {
        out.push(await this.emit(ctx, "BIRTH", 2, [],
          { size: ctx.size },
          { size: ctx.size }));
      }
    }

    // --- wealth chronicles ---
    if (ctx.gini > s.maxGini + 0.02 && this.ready("RECORD_CONC", ctx)) {
      s.maxGini = ctx.gini;
      out.push(await this.emit(ctx, "RECORD_CONC", 2, idList(ctx.richestId),
        { gini: round(ctx.gini) },
        { gini: round(ctx.gini) }));
    } else if (ctx.gini > s.maxGini) {
      s.maxGini = ctx.gini;
    }
    if (ctx.richestId != null && s.leaderId != null && ctx.richestId !== s.leaderId && this.ready("LEAD_CHANGE", ctx)) {
      out.push(await this.emit(ctx, "LEAD_CHANGE", 2, [s.leaderId, ctx.richestId],
        { newLeader: ctx.richestId, oldLeader: s.leaderId, gini: round(ctx.gini) },
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
      out.push(await this.emit(ctx, "PANIC", 3, [],
        { temperature: round(ctx.temperature), flight, size: ctx.size },
        { flight, size: ctx.size, temperature: round(ctx.temperature) }));
    }
    if (ctx.temperature >= 0.97 && this.ready("STORM", ctx)) {
      out.push(await this.emit(ctx, "STORM", 3, [],
        { temperature: round(ctx.temperature), arousal: round(ctx.arousal) },
        { temperature: round(ctx.temperature), arousal: round(ctx.arousal) }));
    }
    if (ctx.regime === "COLD" && still / n >= 0.6 && this.ready("HUDDLE", ctx)) {
      out.push(await this.emit(ctx, "HUDDLE", 2, [],
        { still, size: ctx.size, temperature: round(ctx.temperature) },
        { still, size: ctx.size, temperature: round(ctx.temperature) }));
    }
    if (feed / n >= 0.3 && this.ready("FEAST", ctx)) {
      out.push(await this.emit(ctx, "FEAST", 2, [],
        { feed, size: ctx.size, valence: round(ctx.valence) },
        { feed, size: ctx.size, valence: round(ctx.valence) }));
    }

    // --- SOCIAL MEMORY: feuds, partnerships, betrayals, reputations. Every signal is computed by the
    //     ECONOMY layer from its persisted bonds (a pure read-out of settled history — nothing here
    //     influences any decision). Trackers + cooldowns make each RELATIONSHIP a one-time chapter. ---
    const soc = ctx.social;
    if (soc) {
      if (soc.betrayal && soc.betrayal.tick !== s.lastBetrayalTick && this.ready("BETRAYAL", ctx)) {
        s.lastBetrayalTick = soc.betrayal.tick;
        out.push(await this.emit(ctx, "BETRAYAL", 2, [soc.betrayal.buyerId, soc.betrayal.sellerId],
          { buyer: soc.betrayal.buyerId, seller: soc.betrayal.sellerId, amountUsdc: soc.betrayal.amountUsdc },
          { amountUsdc: soc.betrayal.amountUsdc }));
      }
      if (soc.topFeud) {
        const key = `${soc.topFeud.a}>${soc.topFeud.b}`;
        if (key !== s.lastFeudKey && this.ready("FEUD", ctx)) {
          s.lastFeudKey = key;
          out.push(await this.emit(ctx, "FEUD", 2, [soc.topFeud.a, soc.topFeud.b],
            { a: soc.topFeud.a, b: soc.topFeud.b, bond: soc.topFeud.score },
            { bond: soc.topFeud.score }));
        }
      }
      if (soc.topAlliance) {
        const key = `${soc.topAlliance.a}>${soc.topAlliance.b}`;
        if (key !== s.lastAllianceKey && this.ready("ALLIANCE", ctx)) {
          s.lastAllianceKey = key;
          out.push(await this.emit(ctx, "ALLIANCE", 2, [soc.topAlliance.a, soc.topAlliance.b],
            { a: soc.topAlliance.a, b: soc.topAlliance.b, trades: soc.topAlliance.trades, bond: soc.topAlliance.score },
            { trades: soc.topAlliance.trades, bond: soc.topAlliance.score }));
        }
      }
      if (soc.deadbeat && soc.deadbeat.id !== s.lastDeadbeatId && this.ready("REPUTATION", ctx)) {
        s.lastDeadbeatId = soc.deadbeat.id;
        out.push(await this.emit(ctx, "REPUTATION", 1, [soc.deadbeat.id],
          { id: soc.deadbeat.id, kept: soc.deadbeat.kept, broken: soc.deadbeat.broken },
          { score: soc.deadbeat.score, kept: soc.deadbeat.kept, broken: soc.deadbeat.broken }));
      }
    }

    // --- DYNASTY: foundings, dominations, epitaphs. Every signal is computed by the ECONOMY layer from
    //     its persisted kinship/house/grave ledger (pure read-out again — the historian only names the
    //     moments). Trackers make each house's founding, each generational high and each burial one chapter. ---
    const dyn = ctx.dynasty;
    if (dyn) {
      if (dyn.founding) {
        const key = String(dyn.founding.houseId);
        if (key !== s.lastHouseKey && this.ready("HOUSE_FOUNDED", ctx)) {
          s.lastHouseKey = key;
          out.push(await this.emit(ctx, "HOUSE_FOUNDED", 3, [dyn.founding.founder, dyn.founding.childId],
            { founder: dyn.founding.founder, name: dyn.founding.name, sigil: dyn.founding.sigil, child: dyn.founding.childId },
            { houseId: dyn.founding.houseId, foundedTick: dyn.founding.tick }));
        }
      }
      if (dyn.dominance) {
        const key = `${dyn.dominance.id}>${dyn.dominance.gen}`;
        if (key !== s.lastDynastyKey && this.ready("DYNASTY", ctx)) {
          s.lastDynastyKey = key;
          out.push(await this.emit(ctx, "DYNASTY", 3, idList(dyn.dominance.id),
            { name: dyn.dominance.name, share: `${Math.round(dyn.dominance.capitalShare * 100)}%`, gen: dyn.dominance.gen },
            { capitalShare: dyn.dominance.capitalShare, gen: dyn.dominance.gen }));
        }
      }
      if (dyn.death && dyn.death.tick !== s.lastDeathTick && this.ready("ELEGY", ctx)) {
        s.lastDeathTick = dyn.death.tick;
        const heirs = dyn.death.heirIds.length > 0 ? dyn.death.heirIds.map((h) => `#${h}`).join(", ") : "the commons";
        const cause = dyn.death.cause === "aged" ? "old age" : dyn.death.cause === "plague" ? "the plague" : dyn.death.cause;
        out.push(await this.emit(ctx, "ELEGY", 2, idList(dyn.death.id),
          {
            id: dyn.death.id,
            house: dyn.death.houseName ? `the House of ${dyn.death.houseName}` : "no house",
            cause, deals: dyn.death.deals, age: dyn.death.age,
            estateUsdc: dyn.death.estateUsdc, heirs,
          },
          { deals: dyn.death.deals, age: dyn.death.age, estateUsdc: dyn.death.estateUsdc }));
      }
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

  /** Build an entry, render its sentence from the template, and fold it into the running hash chain. */
  private async emit(
    ctx: ChronicleContext,
    kind: ChronicleKind,
    severity: 1 | 2 | 3,
    actors: number[],
    tokens: Record<string, string | number>,
    metrics: Record<string, number>,
  ): Promise<ChronicleEntry> {
    this.s.seq += 1;
    this.s.lastKindTick[kind] = ctx.tick;
    const prevHash = this.s.headHash;
    const base: ChronicleEntry = {
      seq: this.s.seq,
      tick: ctx.tick,
      ts: ctx.ts,
      kind,
      era: this.s.era,
      eraName: this.s.eraName,
      severity,
      actors,
      text: renderTemplate(kind, tokens),   // ← the sentence IS a template fill; nothing else could produce it
      metrics,
      tokens,
      prevHash,
      hash: "",
    };
    const hash = await computeEntryHash(base);
    base.hash = hash;
    this.s.headHash = hash;
    return base;
  }

  /** The current age + chain head, for the UI header and the verifier. */
  eraInfo(): { era: number; eraName: string; eraRegime: ChronicleContext["regime"]; seq: number; headHash: string } {
    return { era: this.s.era, eraName: this.s.eraName, eraRegime: this.s.eraRegime, seq: this.s.seq, headHash: this.s.headHash };
  }

  snapshot(): ChroniclerState { return JSON.parse(JSON.stringify(this.s)); }

  restore(st: Partial<ChroniclerState> | null | undefined): void {
    if (!st) return;
    this.s = { ...freshState(), ...st, lastKindTick: { ...(st.lastKindTick ?? {}) } };
    if (typeof this.s.headHash !== "string" || this.s.headHash.length !== 64) this.s.headHash = GENESIS_HASH;
  }
}

function freshState(): ChroniclerState {
  return {
    inited: false, seq: 0, era: 1, eraName: "the Awakening", eraRegime: "COLD",
    eraStartTick: 0, prevRegime: null, regimeRun: 0, firstTradeDone: false,
    lastMilestone: 0, maxSize: 0, maxGini: 0, leaderId: null, lastKindTick: {},
    lastFeudKey: null, lastAllianceKey: null, lastBetrayalTick: 0, lastDeadbeatId: null,
    lastHouseKey: null, lastDynastyKey: null, lastDeathTick: 0,
    headHash: GENESIS_HASH,
  };
}

function idList(id: number | null): number[] { return id == null ? [] : [id]; }

/** The fly most worth naming on a founding moment: the richest, if known. */
function namedActors(ctx: ChronicleContext): number[] { return idList(ctx.richestId); }

function round(x: number): number { return Math.round(clamp100(x) * 1000) / 1000; }
// keep values readable in JSON without over-clamping real metrics (settlements can be huge)
function clamp100(x: number): number { return Number.isFinite(x) ? Math.max(-1e9, Math.min(1e9, x)) : 0; }
