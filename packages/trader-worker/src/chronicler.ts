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
  | "EPOCH_OPEN"
  | "EPOCH_CLOSE"
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
  | "ELEGY"
  // ⑤ culture + ⑥ institutions narrative kinds (landscape detectors off the culture/market read-outs):
  | "TREND"
  | "TRADITION"
  | "MARKET_SHIFT"
  | "CREDIT"
  | "RUN"
  | "CLASS"
  // ⑧ THE COMMONS narrative kinds (self-legislation detectors off the commons read-out):
  | "ASSEMBLY"
  | "DECREE"
  // ⑨ WAR + TAXATION narrative kinds (on-chain coffer detectors off the war read-out — real USDC escrowed
  //     and moved inside WarCoffer.sol; only ever folded into the context while WAR_ENABLED):
  | "WAR_DECLARED"
  | "WAR_RESOLVED"
  | "TAX_LEVIED";

export interface ChronicleEntry {
  seq: number;                      // monotonic ordinal within this chronicle (D1 primary key)
  tick: number;
  ts: number;                       // unix ms, supplied by the caller (never read from a clock here)
  kind: ChronicleKind;
  era: number;                      // era index when this happened
  eraName: string;                  // evocative name of that era
  severity: 1 | 2 | 3 | 4 | 5;            // visual weight (3 = chapter-defining, 5 = a new epoch dawns)
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
  /** ⑦ EPOCHS — the pulse's signal-food richness (0..1); a sustained drought is a FAMINE shock era. Absent ⇒ no famine detector. */
  richness?: number | null;
  /** ⑦ EPOCHS — burials within the recent tick window (the economy counts its own graves); ≥3 is a PLAGERA. */
  deathsRecent?: number | null;
  /** ⑦ EPOCHS — a governance-injected shock (a passed miracle/cataclysm of intensity ≥0.75): the SAME
   *  era-forcing entry as the spontaneous detector, only source-labelled "willed by the commons". */
  governanceShock?: { kind: ShockKind; actor?: number } | null;
  /** ⑤ CULTURE read-out (culture.ts signals): a sweeping fashion or a house holding its old way. Absent ⇒
   *  no TREND/TRADITION (byte-for-byte: CULTURE_ENABLED=false never folds these into the context). */
  culture?: ChronicleCulture | null;
  /** ⑥ INSTITUTIONS read-out (economy marketReadout): the tape, the credit, the classes. Absent ⇒ no
   *  MARKET_SHIFT/CREDIT/RUN/CLASS (INSTITUTIONS_ENABLED=false keeps them out of the context). */
  market?: ChronicleMarket | null;
  /** ⑧ THE COMMONS read-out (commons.ts readout): the seated assembly and the law it passes. Absent ⇒ no
   *  ASSEMBLY/DECREE (LAW_ENABLED=false, or institutions/economy off, keeps it out of the context). */
  commons?: ChronicleCommons | null;
  /** ⑨ WAR + TAXATION read-out (state.ts driveWar's transient cron events): a war declared/resolved on-chain
   *  and the extra tax levied. Absent ⇒ no WAR/TAX line (WAR_ENABLED=false never folds it in — the events
   *  array stays empty, so the chronicle is byte-for-byte the pre-war build). Pure read-out, never feeds back. */
  war?: ChronicleWar | null;
}

/** ⑤ the culture membrane's chronicle signals — a majority creed, or a tradition that has held. */
export interface ChronicleCulture {
  trend: { fap: string; adherents: number; share: number } | null;
  tradition: { houseId: number; name: string; sigil: string; fap: string; streak: number } | null;
}

/** ⑥ the market's chronicle signals — current marks (USDC/good), the credit ledger, the class counts. */
export interface ChronicleMarket {
  marks: Record<string, number>;   // latest mark per good, in USDC
  openIous: number;
  topIou: { debtor: number; creditor: number; amountUsdc: number } | null;
  run: boolean;
  badRate: number;
  creditors: number;               // creditor-class headcount
  creditorNetShare: number;        // creditors' share of the swarm's positive net worth, 0..1
}

/** ⑧ the commons' chronicle signals — the era a council was seated for, its headcount, its live decrees. */
export interface ChronicleCommons {
  seatedEra: number;
  seats: number;
  decrees: { param: string; target: number }[];
}

/** ⑨ the war coffer's chronicle signals — the bouts this cron saw settle on-chain and the tax it drew. Each
 *  facet is present only when that event actually mined THIS cron (state.ts's transient warEvents), so a
 *  standing war is never re-declared; the historian just writes the line the coffer already made real. */
export interface ChronicleWar {
  declared: { attackerId: number; defenderId: number; attackerName: string; defenderName: string; stakeUsdc: number; potUsdc: number } | null;
  resolved: { attackerId: number; defenderId: number; attackerName: string; defenderName: string; winnerId: number | null; potUsdc: number; stakeUsdc: number } | null;
  tax: { houseCount: number; taxUsdc: number } | null;
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
  // --- ⑦ EPOCH shock detectors: monotonic per-cron running stats (a one-cron volume delta, a famine
  //     run) + the last forced epoch, so the detector is stateless-friendly and cooldown-honest ---
  cronSeen: number;                 // crons observed since genesis (the epoch clock)
  lastShockCron: number;            // cronSeen of the last forced epoch (SHOCK_COOLDOWN anchor)
  prevVolume: number;               // last cron's lifetime volume (to take a one-cron delta)
  maxCronVolume: number;            // largest single-cron volume increment ever (a BOOM beats it)
  prevGini: number;                 // last cron's gini (a BOOM also needs it rising)
  famineRun: number;                // consecutive crons of richness < FAMINE_RICHNESS
  eraStartCron: number;             // cronSeen when the current era dawned (the CLOSE line's span)
  eraShock: ShockKind | null;       // the shock that forced the CURRENT era (null ⇒ a calm regime age)
  eraShockWilled: boolean;          // was that shock governance-injected ("willed by the commons")?
  // --- ⑤⑥ culture/institution trackers: landscape detectors that announce a fashion, a held tradition, a
  //     price break, a first credit, a run and a class ONCE each (per key / per transition), never a stutter ---
  lastTrendFap: string | null;      // the FAP of the last announced TREND (a new majority creed is news)
  lastTraditionKey: string | null;  // "houseId>creed" of the last announced TRADITION
  lastMarks: Record<string, number>;// last cron's mark per good (a MARKET_SHIFT is a one-cron move off this)
  lastCreditCount: number;          // openIous seen last cron (an increase is a fresh issuance)
  lastRunActive: boolean;           // was a RUN live last cron? (RUN is told on the false→true edge)
  classAnnounced: boolean;          // the creditor CLASS has been counted once — history, not a per-cron census
  // --- ⑧ commons trackers: a council is one chapter per era, each knob's law one decree per era ---
  lastAssemblyEra: number;          // era the last ASSEMBLY line told (0 ⇒ never)
  lastDecreeEra: Record<string, number>; // param → era of its last DECREE
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

// ⑦ EPOCHS — a SHOCK is an age forced open by an event, not by a slow regime drift. The kind picks the
// era's name; every threshold below is a pure read-out of state the historian already sees (or of a new
// optional context facet the caller folds in). No detector here feeds back — it only names the moment.
export type ShockKind = "FAMINE" | "PLAGERA" | "BOOM" | "GREAT_HUDDLE" | "DYNASTIC";
const SHOCK_NAMES: Record<ShockKind, string> = {
  FAMINE: "the Famine",          // signal-food drought: pulse richness flatlined for a long run
  PLAGERA: "the Rot",            // burials come in waves (a dynasty dying off)
  BOOM: "the Gilding",           // a one-cron volume record while wealth still concentrates
  GREAT_HUDDLE: "the Long Cold", // the freeze will not lift
  DYNASTIC: "the Yoke of Houses", // one house grips >30% of the swarm's capital
};
// Crons between forced epochs, so a shock cannot spam the calendar (anti epoch-inflation).
const SHOCK_COOLDOWN = 200;
const FAMINE_CRONS = 45;         // consecutive crons of richness < FAMINE_RICHNESS
const FAMINE_RICHNESS = 0.18;
const PLAGERA_DEATHS = 3;        // burials within the recent window (state.ts folds the 30-tick count in)
const GREAT_HUDDLE_CRONS = 120;  // a COLD regime HELD this long is less a weather than an age
const DYNASTIC_SHARE = 0.30;     // one house's capital share that dawns a dynastic epoch

// ⑤⑥ narrative detectors — thresholds on the culture/market read-outs. These shape WHEN a line is written,
// not its text (the browser re-derives sentences from templates + tokens only), so they are NOT part of the
// hashed rule-set; a landscape detector, exactly like the social/dynasty ones.
const MARKET_SHIFT_PCT = 0.25;   // a good's mark moving ≥25% in ONE cron is a MARKET_SHIFT
const CREDIT_MIN_USDC = 0.01;    // only a note of real consequence is announced as the swarm's first CREDIT
const CLASS_SHARE = 0.15;        // creditors gripping >15% of net capital is a CLASS in history

// Minimum crons before the same kind may repeat, so the chronicle stays a chronicle, not a stutter.
const COOLDOWN: Partial<Record<ChronicleKind, number>> = {
  PANIC: 3, STORM: 5, HUDDLE: 5, FEAST: 4, BIRTH: 2, LEAD_CHANGE: 2, RECORD_CONC: 3,
  FEUD: 8, ALLIANCE: 8, BETRAYAL: 2, REPUTATION: 12,
  HOUSE_FOUNDED: 4, DYNASTY: 16, ELEGY: 1,
  EPOCH_OPEN: 200, EPOCH_CLOSE: 200,
  TREND: 8, TRADITION: 16, MARKET_SHIFT: 6, CREDIT: 10, RUN: 12, CLASS: 24,
  ASSEMBLY: 8, DECREE: 6,
  WAR_DECLARED: 4, WAR_RESOLVED: 4, TAX_LEVIED: 10,
};

// A regime must hold for this many crons (and the era be at least this old) before a new era dawns.
const ERA_MIN_RUN = 6;
const ERA_MIN_AGE = 8;

/** The narrative templates. `{key}` inserts tokens[key]; `{key~roman}` / `{key~kth}` / `{key~lower}` apply a
 *  tiny, fully-deterministic formatter (see renderToken). This exact map is shipped to the browser verbatim. */
export const TEMPLATES: Record<ChronicleKind, string> = {
  ERA_OPEN: "Era {era~roman} · {eraName} — {size} minds tend the swarm on the Arc market, and the chronicle opens.",
  ERA_SHIFT: "Era {era~roman} · {eraName} dawns — the market has turned {regime~lower} and held it. An age begins.",
  EPOCH_CLOSE: "And so closes Era {era~roman} · {eraName} — its {span} crons fold into the record, an age cut short by upheaval.",
  EPOCH_OPEN: "Era {era~roman} · {eraName} — {sign} falls upon the swarm{willed}. A new age, compelled by shock.",
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
  TREND: "A custom sweeps the swarm — {adherents} flies take to {fap} at once, one mood carrying {share} of the market.",
  TRADITION: "The House of {name} keeps the old way — {fap}, held by its kindred for {streak} crons against the passing fashion.",
  MARKET_SHIFT: "The tape lurches — {good} moves {pct} in a single breath to {mark} USDC; the market's mind has changed.",
  CREDIT: "A promise joins the ledger — fly #{debtor} owes fly #{creditor} {amountUsdc} USDC; trade now runs on trust as well as coin.",
  RUN: "Dread turns due all at once — a run on the swarm's credit: {creditors} creditors call, {badRate} of the paper is overdue, the spreads double.",
  CLASS: "A class is counted into history — the creditor purse now grips {creditorShare} of the swarm's whole net capital.",
  ASSEMBLY: "A commons sits in Era {era~roman} — {seats} of the swarm's honoured and propertied take the seats; the age will now write its own law.",
  DECREE: "The commons decrees in Era {era~roman}: {what} shall stand at {value}. The swarm has rewritten its own rule.",
  // ⑨ WAR + TAXATION — the on-chain coffer's three moments. Real USDC is escrowed per house vault and moved
  //     only inside WarCoffer.sol (never minted); the winner is derived in-contract from powers committed at
  //     declare, so the Worker only narrates what the ledger mirror saw. Mirrored byte-for-byte in CHRON_.
  WAR_DECLARED: "War is declared between the House of {attacker} and the House of {defender} — {stakeUsdc} USDC a side stands escrowed on-chain behind the coffer.",
  WAR_RESOLVED: "The coffer renders its verdict — the House of {winner} takes the {potUsdc} USDC pot from the House of {loser}; the feud is settled in coin, not in word.",
  TAX_LEVIED: "Beyond the swarm's own tithe, the coffer levies its tax — {taxUsdc} USDC drawn from {houseCount} houses' on-chain vaults into the commons purse.",
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
    shockNames: SHOCK_NAMES,
    shockCooldown: SHOCK_COOLDOWN,
    famineCrons: FAMINE_CRONS,
    famineRichness: FAMINE_RICHNESS,
    plageraDeaths: PLAGERA_DEATHS,
    greatHuddleCrons: GREAT_HUDDLE_CRONS,
    dynasticShare: DYNASTIC_SHARE,
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
  /** ⑦ EPOCHS kill-switch. FALSE ⇒ the whole shock detector is inert (not even its running stats fold),
   *  so era behaviour is byte-for-byte today's slow regime drift. Defaults TRUE for standalone/replay use. */
  private readonly epochsOn: boolean;
  constructor(epochsEnabled = true) { this.epochsOn = epochsEnabled; }

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
      // Seed the ⑦ EPOCH detectors from the CURRENT state too: a re-install meeting an already-trading
      // swarm must not read the WHOLE pre-existing volume/gini as a single-cron record and cry "BOOM".
      // Baselines start at what is on the tape now, so the first forced epoch can only come from a genuine
      // one-cron delta observed AFTER this opening line.
      s.prevVolume = ctx.volumeUsdc;
      s.prevGini = ctx.gini;
      s.cronSeen = 1;
      s.eraStartCron = 1;
      out.push(await this.emit(ctx, "ERA_OPEN", 3, [],
        { era: s.era, eraName: s.eraName, size: ctx.size, temperature: round(ctx.temperature) },
        { size: ctx.size, temperature: round(ctx.temperature) }));
    } else {
      // --- era bookkeeping: a regime must HOLD to be remembered as an age ---
      if (ctx.regime === s.prevRegime) s.regimeRun += 1;
      else { s.regimeRun = 1; s.prevRegime = ctx.regime; }
      s.cronSeen += 1;

      // ⑦ EPOCHS: a SHOCK outranks a slow regime drift. Both the fly-side (spontaneous) and the human-side
      // (governance-injected) paths resolve to ONE kind and go through ONE forcing entry (applyShock) — no
      // second implementation. A governance shock simply overrides the detected kind and carries a source tag.
      // With epochs OFF, neither detector runs (no stats even fold), so the era falls straight to today's drift.
      const spontaneous = this.epochsOn ? this.pickShock(ctx) : null;
      const shock = this.epochsOn ? (ctx.governanceShock?.kind ?? spontaneous) : null;
      if (shock && s.cronSeen - s.lastShockCron >= SHOCK_COOLDOWN) {
        await this.applyShock(ctx, shock, !!ctx.governanceShock, out);
      } else {
        const eraAge = ctx.tick - s.eraStartTick;
        if (ctx.regime !== s.eraRegime && s.regimeRun >= ERA_MIN_RUN && eraAge >= ERA_MIN_AGE) {
          s.era += 1;
          s.eraRegime = ctx.regime;
          s.eraStartTick = ctx.tick;
          s.eraStartCron = s.cronSeen;
          s.eraShock = null; s.eraShockWilled = false;   // a calm regime age — no shock forced this era
          const pool = ERA_NAMES[ctx.regime];
          const pick = pool[(s.era - 1) % pool.length];
          // avoid ever repeating the exact same title back-to-back
          s.eraName = pick === s.eraName ? pool[s.era % pool.length] : pick;
          out.push(await this.emit(ctx, "ERA_SHIFT", 3, [],
            { era: s.era, eraName: s.eraName, regime: ctx.regime, temperature: round(ctx.temperature) },
            { era: s.era, temperature: round(ctx.temperature) }));
        }
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

    // --- ⑤ CULTURE: a fashion sweeping the swarm, and a house holding its old way against it. Both are pure
    //     read-outs of the culture membrane's OWN signals; when CULTURE_ENABLED=false state.ts folds no
    //     `culture` into the context, so this whole block is inert and the chronicle stays byte-for-byte older. ---
    const cul = ctx.culture;
    if (cul) {
      if (cul.trend && cul.trend.fap !== s.lastTrendFap && this.ready("TREND", ctx)) {
        s.lastTrendFap = cul.trend.fap;
        out.push(await this.emit(ctx, "TREND", 2, [],
          { fap: cul.trend.fap, adherents: cul.trend.adherents, share: `${Math.round(cul.trend.share * 100)}%` },
          { adherents: cul.trend.adherents, share: cul.trend.share }));
      }
      if (cul.tradition) {
        const key = `${cul.tradition.houseId}>${cul.tradition.fap}`;
        if (key !== s.lastTraditionKey && this.ready("TRADITION", ctx)) {
          s.lastTraditionKey = key;
          out.push(await this.emit(ctx, "TRADITION", 2, [],
            { name: cul.tradition.name, sigil: cul.tradition.sigil, fap: cul.tradition.fap, streak: cul.tradition.streak },
            { houseId: cul.tradition.houseId, streak: cul.tradition.streak }));
        }
      }
    }

    // --- ⑥ INSTITUTIONS: the market's own drama — a price break on the tape, a first consequential promise,
    //     a run on credit, a class gripping the swarm's net capital — all read from the economy's market
    //     read-out. INSTITUTIONS_ENABLED=false ⇒ no `market` in the context ⇒ this block never speaks. ---
    const mkt = ctx.market;
    if (mkt) {
      // MARKET_SHIFT: a good's mark moving ≥25% off LAST cron's mark (the first cron a mark is seen only primes).
      for (const good of Object.keys(mkt.marks).sort()) {
        const cur = mkt.marks[good];
        const prev = s.lastMarks[good];
        if (prev != null && prev > 0 && Math.abs(cur / prev - 1) >= MARKET_SHIFT_PCT && this.ready("MARKET_SHIFT", ctx)) {
          const pct = Math.round((cur / prev - 1) * 100);
          out.push(await this.emit(ctx, "MARKET_SHIFT", 3, [],
            { good, pct: `${pct > 0 ? "+" : ""}${pct}%`, mark: Math.round(cur * 1e6) / 1e6 },
            { pct, mark: cur }));
          break;
        }
      }
      s.lastMarks = { ...mkt.marks };

      // CREDIT: the open-IOU count grew (a fresh issuance) and the largest note carries real weight.
      const issued = mkt.openIous > s.lastCreditCount;
      s.lastCreditCount = mkt.openIous;
      if (issued && mkt.topIou && mkt.topIou.amountUsdc >= CREDIT_MIN_USDC && this.ready("CREDIT", ctx)) {
        out.push(await this.emit(ctx, "CREDIT", 2, [mkt.topIou.debtor, mkt.topIou.creditor],
          { debtor: mkt.topIou.debtor, creditor: mkt.topIou.creditor, amountUsdc: mkt.topIou.amountUsdc },
          { amountUsdc: mkt.topIou.amountUsdc, openIous: mkt.openIous }));
      }

      // RUN: told on the false→true edge of a live credit panic (severity 4 — the economy's loudest event).
      if (mkt.run && !s.lastRunActive && this.ready("RUN", ctx)) {
        out.push(await this.emit(ctx, "RUN", 4, [],
          { creditors: mkt.creditors, badRate: `${Math.round(mkt.badRate * 100)}%` },
          { creditors: mkt.creditors, badRate: mkt.badRate }));
      }
      s.lastRunActive = mkt.run;

      // CLASS: once the creditor purse grips >15% of net capital — a chapter, never a per-cron census.
      if (!s.classAnnounced && mkt.creditorNetShare >= CLASS_SHARE && this.ready("CLASS", ctx)) {
        s.classAnnounced = true;
        out.push(await this.emit(ctx, "CLASS", 3, [],
          { creditorShare: `${Math.round(mkt.creditorNetShare * 100)}%` },
          { creditorNetShare: mkt.creditorNetShare }));
      }
    }

    // --- ⑧ THE COMMONS: a council seated at a new era, and the law it passes for that era. Both are pure
    //     read-outs of the commons' own signals; LAW_ENABLED=false ⇒ state.ts folds no `commons` into the
    //     context ⇒ this block never speaks and the chronicle stays byte-for-byte the pre-law build. ---
    const com = ctx.commons;
    if (com && com.seatedEra > 0) {
      if (com.seatedEra !== s.lastAssemblyEra && this.ready("ASSEMBLY", ctx)) {
        s.lastAssemblyEra = com.seatedEra;
        out.push(await this.emit(ctx, "ASSEMBLY", 2, [],
          { era: com.seatedEra, seats: com.seats },
          { seats: com.seats }));
      }
      for (const d of com.decrees) {
        if ((s.lastDecreeEra[d.param] ?? -1) !== com.seatedEra && this.ready("DECREE", ctx)) {
          s.lastDecreeEra[d.param] = com.seatedEra;
          const what = d.param === "creditCap" ? "the base credit line" : "the rate of interest";
          out.push(await this.emit(ctx, "DECREE", 3, [],
            { era: com.seatedEra, what, value: `${round(d.target)}` },
            { target: d.target }));
        }
      }
    }

    // --- ⑨ WAR + TAXATION: the on-chain coffer's moments this cron. Each facet is present ONLY when that
    //     op actually mined (state.ts folds its transient warEvents in, empty while WAR_ENABLED=false), so a
    //     standing war is never re-told and the chronicle stays byte-for-byte the pre-war build when off. A
    //     pure read-out of the ledger mirror — the winner was already derived inside the contract, not here. ---
    const war = ctx.war;
    if (war) {
      if (war.declared && this.ready("WAR_DECLARED", ctx)) {
        const d = war.declared;
        out.push(await this.emit(ctx, "WAR_DECLARED", 3, [d.attackerId, d.defenderId],
          { attacker: d.attackerName, defender: d.defenderName, stakeUsdc: round(d.stakeUsdc), potUsdc: round(d.potUsdc) },
          { attackerId: d.attackerId, defenderId: d.defenderId, stakeUsdc: d.stakeUsdc, potUsdc: d.potUsdc }));
      }
      if (war.resolved && this.ready("WAR_RESOLVED", ctx)) {
        const r = war.resolved;
        const winnerIsAttacker = r.winnerId == null ? true : r.winnerId === r.attackerId;
        const winnerName = r.winnerId == null ? "no one" : winnerIsAttacker ? r.attackerName : r.defenderName;
        const loserName = winnerIsAttacker ? r.defenderName : r.attackerName;
        out.push(await this.emit(ctx, "WAR_RESOLVED", 4, r.winnerId != null ? [r.winnerId] : [r.attackerId, r.defenderId],
          { winner: winnerName, loser: loserName, potUsdc: round(r.potUsdc), stakeUsdc: round(r.stakeUsdc) },
          { winnerId: r.winnerId ?? 0, attackerId: r.attackerId, defenderId: r.defenderId, potUsdc: r.potUsdc }));
      }
      if (war.tax && war.tax.houseCount > 0 && war.tax.taxUsdc > 0 && this.ready("TAX_LEVIED", ctx)) {
        out.push(await this.emit(ctx, "TAX_LEVIED", 2, [],
          { taxUsdc: round(war.tax.taxUsdc), houseCount: war.tax.houseCount },
          { taxUsdc: war.tax.taxUsdc, houseCount: war.tax.houseCount }));
      }
    }

    return out;
  }

  /**
   * The fly-side (spontaneous) SHOCK detector — a PURE read-out of the state one cron offers, with a few
   * monotonic running stats folded in (a one-cron volume delta needs the previous cron's volume). Always
   * updates those stats so a delta stays one-cron wide even on crons that force nothing. Returns the kind
   * in a fixed priority order, or null. This is the ONLY spontaneous detector; governance reuses applyShock.
   */
  private pickShock(ctx: ChronicleContext): ShockKind | null {
    const s = this.s;
    const dVol = Math.max(0, ctx.volumeUsdc - s.prevVolume);
    const volumeRecord = dVol > s.maxCronVolume;
    const giniUp = ctx.gini > s.prevGini;
    s.prevVolume = ctx.volumeUsdc;
    s.prevGini = ctx.gini;
    if (dVol > s.maxCronVolume) s.maxCronVolume = dVol;
    if (ctx.richness != null && ctx.richness < FAMINE_RICHNESS) s.famineRun += 1; else s.famineRun = 0;

    if (s.famineRun >= FAMINE_CRONS) return "FAMINE";
    if ((ctx.deathsRecent ?? 0) >= PLAGERA_DEATHS) return "PLAGERA";
    if (volumeRecord && dVol > 0 && giniUp) return "BOOM";
    if (ctx.regime === "COLD" && s.regimeRun >= GREAT_HUDDLE_CRONS) return "GREAT_HUDDLE";
    if ((ctx.dynasty?.dominance?.capitalShare ?? 0) >= DYNASTIC_SHARE) return "DYNASTIC";
    return null;
  }

  /**
   * Force a new epoch: close the outgoing era with a retrospective line, then dawn a shock era named for
   * the kind. After this, era behaviour reverts to the ordinary regime logic (the shock just jumped the
   * clock ahead). SHOCK_COOLDOWN crons must pass before another may dawn. Shared by BOTH the spontaneous
   * detector and the governance-injection path — one implementation, differing only in the source tag.
   */
  private async applyShock(
    ctx: ChronicleContext, kind: ShockKind, willed: boolean, out: ChronicleEntry[],
  ): Promise<void> {
    const s = this.s;
    const span = s.cronSeen - s.eraStartCron;
    out.push(await this.emit(ctx, "EPOCH_CLOSE", 3, [],
      { era: s.era, eraName: s.eraName, span },
      { closedEra: s.era, span }));
    s.era += 1;
    s.eraRegime = ctx.regime;          // keep the felt regime; only the NAME/cause is forced
    s.eraStartTick = ctx.tick;
    s.eraStartCron = s.cronSeen;
    s.eraName = SHOCK_NAMES[kind];
    s.eraShock = kind;
    s.eraShockWilled = willed;
    s.lastShockCron = s.cronSeen;
    s.regimeRun = 1;                   // the epoch clock restarts under the new age
    s.prevRegime = ctx.regime;
    const actor = ctx.governanceShock?.actor;
    out.push(await this.emit(ctx, "EPOCH_OPEN", 5, actor != null ? [actor] : [],
      { era: s.era, eraName: s.eraName, sign: kind, willed: willed ? ", willed by the commons" : "" },
      { era: s.era, willed: willed ? 1 : 0 }));
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
    severity: 1 | 2 | 3 | 4 | 5,
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
  eraInfo(): {
    era: number; eraName: string; eraRegime: ChronicleContext["regime"]; seq: number; headHash: string;
    eraShock: ShockKind | null; eraShockWilled: boolean;
  } {
    return {
      era: this.s.era, eraName: this.s.eraName, eraRegime: this.s.eraRegime, seq: this.s.seq, headHash: this.s.headHash,
      eraShock: this.s.eraShock, eraShockWilled: this.s.eraShockWilled,
    };
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
    cronSeen: 0, lastShockCron: -1000, prevVolume: 0, maxCronVolume: 0, prevGini: 0, famineRun: 0,
    eraStartCron: 0, eraShock: null, eraShockWilled: false,
    lastTrendFap: null, lastTraditionKey: null, lastMarks: {}, lastCreditCount: 0, lastRunActive: false, classAnnounced: false,
    lastAssemblyEra: 0, lastDecreeEra: {},
    headHash: GENESIS_HASH,
  };
}

function idList(id: number | null): number[] { return id == null ? [] : [id]; }

/** The fly most worth naming on a founding moment: the richest, if known. */
function namedActors(ctx: ChronicleContext): number[] { return idList(ctx.richestId); }

function round(x: number): number { return Math.round(clamp100(x) * 1000) / 1000; }
// keep values readable in JSON without over-clamping real metrics (settlements can be huge)
function clamp100(x: number): number { return Number.isFinite(x) ? Math.max(-1e9, Math.min(1e9, x)) : 0; }
