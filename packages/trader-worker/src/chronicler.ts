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
  | "ERA_PASSAGE"
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
  | "TAX_LEVIED"
  // ⑩ TERRITORY CONQUEST narrative kind (a ledger-only zone seizure folded in off the war read-out, only while
  //     TERRITORY_ENABLED + TERR_SEIZE_ON_WIN are armed — so it never fires on the default dark deployment):
  | "TERRITORY_SEIZED"
  // ⑪ RELIGION narrative kinds (faith-membrane detectors off the religion read-out — a prophet rising, a
  //     house schism, a sect revived from silence, a holy-day pilgrimage; only ever folded into the context
  //     while RELIGION_ENABLED):
  | "PROPHECY"
  | "SCHISM"
  | "REVIVAL"
  | "PILGRIMAGE"
  // ⑫ ACCELERATED AGES — the historian's own fast civilizational clock (a "generation" turns over every
  //     GEN_CRONS crons, decoupled from the slow ~hourly era). A pure narrative layer over real prosperity
  //     signals (volume/gini/size/feud/run/shock): it never mutates the economy, only RECKONS the swarm's
  //     fortune up and down and names the ages that rise and fall on that clock.
  | "GENERATION"
  | "GOLDEN_AGE"
  | "DARK_AGE"
  | "RENAISSANCE"
  | "MIGRATION"
  // ⑬ TECH — the ladder of arts (invention.ts): a rung discovered on a generation turn, an art diffusing past
  //     half the swarm, the top rung unlearned when fortune breaks. Folded in only while TECH_ENABLED, so the
  //     chronicle stays byte-for-byte the pre-ladder build when the layer is off.
  | "INVENTION"
  | "DIFFUSION"
  | "LOST_ART"
  // ⑭ CITIES — settlements and the census (cities.ts): a zone becoming a named place, the swarm turning urban,
  //     a census struck once a generation off the grave ring, and the rot walking the road between the two
  //     greatest places. NARRATED over burials the ledger already recorded — never a contagion model. Folded in
  //     only while CITIES_ENABLED.
  | "CITY_FOUNDED"
  | "URBANIZATION"
  | "CENSUS"
  | "PLAGUE_WAVE"
    // ⑯ APPRENTICESHIP — education + cumulative culture (apprentice.ts): an art passing master→apprentice, a
    //     student outstripping the first hand that taught it, a house's school of one art, and the fragility
    //     payoff — the last living keeper of an art dying untaught even though ⑬'s ladder still names it. Fire
    //     ONLY while APPRENTICE_ENABLED (state.ts folds no `apprentice` into the context otherwise).
    | "TRANSMISSION"
    | "SURPASS"
    | "SCHOOL"
    | "CRAFT_LOST"
    | "RECORDING"
    | "DECODE"
    | "ARCHIVE_BURNED"
    | "REINVENTION"
  // ⑲ THE BOURSE — MURMUR's own on-chain life, read-only (bourse.ts): a fever breaking out over the
  //     learned baseline, a whale stirring, the cumulative argus tithe crossing a milestone, and a long
  //     silence of the tape. Folded into the context ONLY while BOURSE_ENABLED (state.ts ships no `bourse`
  //     key otherwise), so the chronicle stays byte-for-byte the pre-bourse build when the membrane is off.
  | "COIN_FEVER"
  | "WHALE_MOVE"
  | "TITHE"
  | "COIN_SILENCE"
  // ⑳ THE COURT — the docket's whole life, read-only (court.ts): a case indicted from the ledgers'
  //     own facts, a jury seated by the hash of the case, the verdict vote, an exile from the commons'
  //     protection, and the amnesty that turns of an era bring. Folded into the context ONLY while
  //     COURTS_ENABLED (state.ts ships no `court` key otherwise), so an off membrane leaves every old
  //     line byte-for-byte the pre-court build.
  | "INDICTMENT"
  | "TRIAL"
  | "VERDICT"
  | "EXILE"
  | "AMNESTY"
  | "GAMES"
  | "CHAMPION"
  | "RECORD"
  // ㉒ GUILDS: the chartered trades (guilds.ts) — a trade past quorum wins its seal, a fly taking up a
  //     chartered trade strikes a pact, and one guild rising past half the working swarm claims the field.
  | "GUILD_CHARTER"
  | "APPRENTICE_PACT"
  | "GUILD_MONOPOLY"
  // ㉓ THE LEXICON: the words the telling makes (lexicon.ts) — a kind told often enough becomes a word,
  //     a word whose tellings doubles has spread, a word unspoken for a long memory falls silent.
  | "COINAGE"
  | "WORD_SPREAD"
  | "WORD_DIES"
  // ㉔ THE RUMOR MILL: the tale that carries itself (rumor.ts) — a telling takes wing, bends in the
  //     retelling until nobody agrees on what was first said, and at last goes quiet.
  | "RUMOR_AFOOT"
  | "RUMOR_BENT"
  | "RUMOR_FADED"
  // ㉕ THE TREATY: formal diplomacy between houses (treaty.ts) — a deep feud sets seals, a peace that
  //     outlives its probation is ratified, a grudge that sinks back to the war line breaks the seal.
  | "TREATY_SIGNED"
  | "TREATY_RATIFIED"
  | "TREATY_BREACHED"
  // ㉖ THE PUBLIC WORKS: the common goods the swarm raises for itself (works.ts) — a credit run raises a
  //     granary, a golden age a monument, a full swarm's generation clock an aqueduct; time dilapidates them.
  | "WORK_RAISED"
  | "WORK_REPAIRED"
  | "WORK_DILAPIDATED"
  // ㉗ THE GUARDIANS: wardship and inheritance (guardians.ts) — a burial leaves an estate and children still
  //     flying, the youngest is taken as a ward; a carried ward fledges; a fledged ward falling old with its own
  //     heirs paid closes the circle and honors the guardian.
  | "WARD_TAKEN"
  | "WARD_FLEDGED"
  | "GUARDIAN_HONORED";

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
  /** ⑪ RELIGION read-out (religion.ts signals): the reigning god, the sect table with prophets, and this
   *  cron's four faith events. Absent ⇒ no PROPHECY/SCHISM/REVIVAL/PILGRIMAGE (RELIGION_ENABLED=false never
   *  folds these into the context). Pure read-out, never feeds back. */
  religion?: ChronicleReligion | null;
  /** ⑬ TECH read-out (invention.ts signals): the rung discovered / diffused / unlearned this cron. Absent ⇒
   *  no INVENTION/DIFFUSION/LOST_ART (TECH_ENABLED=false never folds these into the context). */
  tech?: ChronicleTech | null;
  /** ⑭ CITIES read-out (cities.ts signals): the place founded / the urban turn / the census / the wave. Absent
   *  ⇒ no CITY_FOUNDED/URBANIZATION/CENSUS/PLAGUE_WAVE (CITIES_ENABLED=false never folds them in). */
  cities?: ChronicleCities | null;
  /** ⑯ APPRENTICESHIP read-out (apprentice.ts signals): the lesson taught / the surpass / the school / the lost
   *  craft this cron, plus how much the swarm actually REMEMBERS. Absent ⇒ no TRANSMISSION/SURPASS/SCHOOL/
   *  CRAFT_LOST (APPRENTICE_ENABLED=false never folds these in). */
  apprentice?: ChronicleApprentice | null;
  archive?: ChronicleArchive | null;
  /** ⑱ WORKSHOP read-out (workshop.ts signals): the reinvention event this cron. Absent ⇒
   *  no REINVENTION (WORKSHOP_ENABLED=false never folds these in). */
  workshop?: ChronicleWorkshop | null;
  /** ⑲ THE BOURSE read-out (bourse.ts signals): MURMUR's on-chain climate this cron. Absent ⇒
   *  no COIN_FEVER/WHALE_MOVE/TITHE/COIN_SILENCE (BOURSE_ENABLED=false never folds these in). */
  bourse?: ChronicleBourse | null;
  /** ⑳ THE COURT read-out (court.ts signals): this cron's docket edge events. Absent ⇒ no
   *  INDICTMENT/TRIAL/VERDICT/EXILE/AMNESTY (COURTS_ENABLED=false never folds these in). */
  court?: ChronicleCourt | null;
  /** ㉑ THE GAMES read-out (games.ts signals): this cron's festival edge events. Absent ⇒ no
   *  GAMES/CHAMPION/RECORD (GAMES_ENABLED=false never folds these in). */
  games?: ChronicleGames | null;
  /** ㉒ THE GUILDS read-out (guilds.ts signals): this cron's charter, pact and monopoly edges. Absent ⇒
   *  no GUILD_CHARTER/APPRENTICE_PACT/GUILD_MONOPOLY (GUILD_ENABLED=false never folds these in). */
  guilds?: ChronicleGuilds | null;
  /** ㉓ THE LEXICON read-out (lexicon.ts signals): this cron's coinage, spread and silence edges. Absent ⇒
   *  no COINAGE/WORD_SPREAD/WORD_DIES (LEX_ENABLED=false never folds these in). */
  lexicon?: ChronicleLexicon | null;
  /** ㉔ THE RUMOR MILL read-out (rumor.ts signals): this cron's afoot, bend and quiet edges. Absent ⇒
   *  no RUMOR_AFOOT/RUMOR_BENT/RUMOR_FADED (RM_ENABLED=false never folds these in). */
  rumor?: ChronicleRumor | null;
  /** ㉕ THE TREATY read-out (treaty.ts signals): this cron's seal, ratification and breach edges. Absent ⇒
   *  no TREATY_SIGNED/TREATY_RATIFIED/TREATY_BREACHED (TR_ENABLED=false never folds these in). */
  treaty?: ChronicleTreaty | null;
  /** ㉖ THE PUBLIC WORKS read-out (works.ts signals): this cron's raising, repair and dilapidation edges. Absent ⇒
   *  no WORK_RAISED/WORK_REPAIRED/WORK_DILAPIDATED (WORKS_ENABLED=false never folds these in). */
  works?: ChronicleWorks | null;
  /** ㉗ THE GUARDIANS read-out (guardians.ts signals): this cron's taking, fledge and full-circle edges. Absent ⇒
   *  no WARD_TAKEN/WARD_FLEDGED/GUARDIAN_HONORED (GUARDIANS_ENABLED=false never folds these in). */
  guardians?: ChronicleGuardians | null;
}

/** ⑤ the culture membrane's chronicle signals — a majority creed, or a tradition that has held. */
export interface ChronicleCulture {
  trend: { fap: string; adherents: number; share: number } | null;
  tradition: { houseId: number; name: string; sigil: string; fap: string; streak: number } | null;
}

/** ⑪ the faith membrane's chronicle signals — the reigning god, the sects, and this cron's four events. */
export interface ChronicleReligion {
  reigning: string;
  holyIn: number;
  sects: { name: string; god: string; adherents: number; prophetId: number | null; houseId: number | null }[];
  prophecy: { prophetId: number; sect: string; god: string; adherents: number } | null;
  schism: { houseId: number; name: string; sigil: string; sect: string } | null;
  revival: { sect: string; adherents: number } | null;
  pilgrimage: { houseId: number; name: string; sigil: string; adherents: number } | null;
}

/** ⑬ the tech membrane's chronicle signals — this cron's three arts events, plus how far the ladder has
 *  climbed (a metric, never a sentence of its own). invention.ts edge-detects them; the historian only names
 *  them, so a standing art is never re-invented in print. */
export interface ChronicleTech {
  discovery: { rung: number; name: string; gen: number; civ: number; credit: string } | null;
  diffusion: { rung: number; name: string; adopted: number; size: number } | null;
  lostArt: { rung: number; name: string; gen: number } | null;
  rungCount: number;                 // rungs in force (0..12)
  lostCount: number;                 // rungs currently unlearned
}

/** ⑭ the city membrane's chronicle signals — this cron's four map events, plus the map's own extent. The
 *  `house` field is already the credit phrase ("the House of X" / "no house"), so the template needs no join. */
export interface ChronicleCities {
  founding: { zone: number; name: string; rank: string; pop: number; house: string } | null;
  urbanization: { urban: number; size: number; settlements: number; largest: string; largestPop: number } | null;
  census: { size: number; meanAge: number; graves: number; births: number; deaths: number; gen: number } | null;
  plagueWave: { deaths: number; a: string; b: string } | null;
  settlementCount: number;           // named places on the map
  urbanShare: number;                // share of the live swarm living in them, 0..1
}

/** ⑯ the apprenticeship membrane's chronicle signals — this cron's four education events, plus how much the
 *  swarm remembers as against what ⑬ invented. `name` is the art's ladder-rung name, `house`/`sigil` a school's
 *  banner; apprentice.ts edge-detects each, so the historian only names them and never re-tells a standing fact. */
export interface ChronicleApprentice {
  transmission: { apprentice: number; master: number; rung: number; name: string } | null;
  surpass: { apprentice: number; master: number; rung: number; name: string } | null;
  school: { rung: number; name: string; houseName: string; sigil: string; adherents: number } | null;
  craftLost: { rung: number; name: string; last: number } | null;
  skilled: number;                 // living minds that carry at least one art
  topCraft: number;                // the highest rung any living hand holds (0..12)
}

/** ⑰ the Archive's chronicle signals — externalized knowledge surviving individual death. */
export interface ChronicleArchive {
  recording: { id: number; rung: number; name: string } | null;
  decode: { id: number; rung: number; name: string } | null;
  archiveBurned: { rung: number; name: string; recordedBy: number } | null;
  records: number;                 // surviving records at this cron
  recorded: number;                // cumulative inscriptions ever made
  decodes: number;                 // cumulative decode observations
}

/** ⑱ The Workshop: knowledge rebirth signals folded into the chronicle context. */
export interface ChronicleWorkshop {
  reinvention: { id: number; rung: number; name: string } | null;
  reinventions: number;            // cumulative reinventions since inception
}

/** ⑲ THE BOURSE: MURMUR's on-chain climate this cron (bourse.ts edge signals; all null on a quiet cron). */
export interface ChronicleBourse {
  /** A coin-fever spell breaking out: this cron's tx count, main-leg volume and the multiple of the norm. */
  fever: { txs: number; volumeMurmur: number; mult: number } | null;
  /** The largest single whale leg seen this cron (whole MURMUR). */
  whale: { amountMurmur: number } | null;
  /** The cumulative argus tithe crossing a milestone this cron (flow through the tax wallet, never a balance). */
  tithe: { milestoneMurmur: number; totalMurmur: number } | null;
  /** A long silence of the tape, spoken once per still spell. */
  silence: { crons: number } | null;
}

/** ⑳ THE COURT: one cron's docket edge events (court.ts; every facet null on a quiet cron — the membrane
 *  resets its pending signals each round, so a non-null facet IS news THIS cron and cannot replay). */
export interface ChronicleCourt {
  /** A case filed this cron: the accused fly and the crime the ledger fact names. */
  indictment: { id: number; crime: string } | null;
  /** A jury seated this cron for that defendant (jurors = seats actually filled). */
  trial: { id: number; crime: string; jurors: number } | null;
  /** A verdict rendered this cron: how many of the seated jurors voted guilty. */
  verdict: { id: number; crime: string; guilty: boolean; votes: number; jurors: number } | null;
  /** A convicted fly whose evidence crossed the exile bar, cast beyond the commons' protection. */
  exile: { id: number; crime: string } | null;
  /** The outlaw roll pardoned at the turn of an era (outlaws = names struck from the book). */
  amnesty: { outlaws: number } | null;
  /** The court's own bounded roll and docket counts, surfaced for the drawer (never re-derived here). */
  outlaws: { id: number; crime: string; since: number }[];
  openCases: number;
  counts: { indicted: number; convicted: number; cleared: number; exiles: number; amnesties: number };
}

/** ㉑ THE GAMES: one cron's festival edge events (games.ts; the membrane resets its pending each round and
 *  spends each era's bell once, so a non-null facet IS news THIS cron and cannot replay). */
export interface ChronicleGames {
  /** A new era proclaimed the games: the era, the day's event, the presiding house ("the commons" if none). */
  games: { era: number; event: string; venue: string } | null;
  /** A champion crowned from the living field by the era's own hash draw. */
  champion: { id: number; event: string; house: string | null } | null;
  /** The crowned fly's lifetime dealings passed the standing mark (prev = the mark that fell). */
  record: { id: number; deals: number; prev: number } | null;
  /** The stadium's standing truth for the drawer (never re-derived here). */
  lastGames: { era: number; event: string; venue: string } | null;
  standing: { id: number; deals: number; era: number } | null;
  pendingGames: boolean;
  counts: { games: number; crowns: number; records: number };
}

/** ㉒ THE GUILDS: one cron's guild edge events (guilds.ts; the membrane adopts its first round silently
 *  and speaks only crossings after that, so a non-null facet IS news THIS cron and cannot replay). */
export interface ChronicleGuilds {
  /** A trade passed quorum and won its seal: the roll, the hands, the quorum, the sealing era. */
  charter: { role: string; members: number; quorum: number; era: number } | null;
  /** A fly took up a chartered trade: the signatory, the trade, the guild's headcount now. */
  pact: { id: number; role: string; members: number } | null;
  /** A chartered guild's share of the working swarm ROSE past the mark (whole percents). */
  monopoly: { role: string; share: number } | null;
  /** The guildhall's standing roster for the drawer (never re-derived here). */
  roster: { role: string; members: number; share: number }[];
  counts: { charters: number; pacts: number; monopolies: number };
}

/** ㉓ THE LEXICON: one cron's word edges (lexicon.ts; pure count-edges over the hot annals roll — the
 *  membrane coins at most one word, doubles at most one, buries at most one per cron, so a non-null
 *  facet IS news THIS cron and cannot replay). */
export interface ChronicleLexicon {
  /** A watched kind told LEX_COIN_AT times in living memory enters the tongue: the word, the tellings, the era. */
  coinage: { word: string; uses: number; era: number } | null;
  /** A held word whose tellings DOUBLED past its last mark: no longer new. */
  spread: { word: string; uses: number } | null;
  /** A held word unspoken for the dormancy gap — marked remembered, not living. */
  dying: { word: string; gap: number } | null;
  /** The desk's standing rows for the drawer (never re-derived here). */
  lexicon: { word: string; uses: number; born: number }[];
  dead: string[];
  counts: { coinages: number; spreads: number; deaths: number };
}

/** ㉔ THE RUMOR MILL: one cron's tale edges (rumor.ts; edges over the annals roll already history — the
 *  mill carries at most one active tale and fires each edge at most once per tale, so a non-null facet
 *  IS news THIS cron and cannot replay). */
export interface ChronicleRumor {
  /** A new telling has gathered its first ears: the market noun, the ear-count, the era, the original mouths. */
  afoot: { topic: string; heard: number; era: number; holders: number[] } | null;
  /** The telling has bent past the halfway mark — heard graver or lighter than it happened. */
  bent: { topic: string; heard: number; heardAs: string } | null;
  /** The tale is told no more (displaced by graver news or outlived its life). */
  faded: { topic: string; heard: number } | null;
  /** The mill's standing tale for the drawer (never re-derived here). */
  active: { topic: string; seq: number; sev0: number; sevHeard: number; heard: number; era: number; bent: boolean } | null;
  counts: { afoot: number; bends: number; faded: number };
  /** The live override's shape: the act hearers are read as on a telling-day, and the heard fraction. */
  echo: { act: string; ratio: number } | null;
}

/** ㉕ THE TREATY: one cron's diplomatic edges (treaty.ts; edges over the house-bond series the economy
 *  already publishes — the membrane fires at most one edge per class per cron, so a non-null facet IS
 *  news THIS cron and cannot replay). */
export interface ChronicleTreaty {
  /** Two houses set their seals: the pair, their names, the clause count, the era the pen moved in. */
  signed: { a: number; b: number; nameA: string; nameB: string; terms: number; era: number } | null;
  /** A seal outlived its probation with the spite genuinely lifted — what anger signed, habit ratified. */
  ratified: { a: number; b: number; nameA: string; nameB: string; terms: number } | null;
  /** The bond sank back to the war threshold under a live seal — the feud resumes where the ink stopped. */
  breached: { a: number; b: number; nameA: string; nameB: string; terms: number } | null;
  counts: { signed: number; ratified: number; breached: number; lived: number };
}

/** ㉖ THE PUBLIC WORKS: one cron's construction edges (works.ts; edges over the eraInfo reckoning and the
 *  credit book the market already publishes — the membrane fires at most one edge per class per cron, so a
 *  non-null facet IS news THIS cron and cannot replay). The `work` token is the kind as a bare enum noun
 *  (granary/aqueduct/monument), like {status}/{regime} stay English. */
export interface ChronicleWorkEdge {
  kind: string;
  era: number;
  lived?: number;
}
export interface ChronicleWorks {
  /** The commons breaks ground: a work raised this cron, and the age it was raised in. */
  raised: ChronicleWorkEdge | null;
  /** A standing work mended — the run deepening or the glory returning refreshed it. */
  repaired: ChronicleWorkEdge | null;
  /** A work fell to ruin unattended — the roll records how long it stood. */
  dilapidated: ChronicleWorkEdge | null;
  counts: { raised: number; repaired: number; dilapidated: number };
}

/** ㉗ THE GUARDIANS: one cron's wardship edges (guardians.ts; every fact re-derived from the dynasty's own
 *  grave ring and living roster — the membrane fires at most one edge per class per cron, so a non-null
 *  facet IS news THIS cron and cannot replay). {guardian} is the house name or the fixed phrase "the commons". */
export interface ChronicleWardEdge {
  ward: number;
  guardian: string;
  era: number;
  estate?: number;
  crons?: number;
  lived?: number;
}
export interface ChronicleGuardians {
  /** A burial left an estate and living children: the youngest is taken into wardship. */
  taken: ChronicleWardEdge | null;
  /** A ward carried past its minority stands on its own with the inheritance intact. */
  fledged: ChronicleWardEdge | null;
  /** The full circle: a fledged ward fell to age with its own heirs paid — the guardian is honored. */
  honored: ChronicleWardEdge | null;
  counts: { taken: number; fledged: number; honored: number; lost: number };
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
  /** TERRITORY CONQUEST (additive): the zones a resolved war's winner annexed from the loser this cron. Null
   *  unless a seizure actually mined (needs TERR_SEIZE_ON_WIN + TERRITORY_ENABLED armed), so the chronicle stays
   *  byte-for-byte the pre-conquest build. Ledger-only — no money moved; the historian narrates it. */
  seized: { winnerId: number | null; loserId: number | null; winnerName: string; loserName: string; zones: number[] } | null;
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
  lastProphetKey: string | null;    // "sect>prophetId" of the last announced PROPHECY (a new prophet is news)
  lastSchismKey: string | null;     // "houseId>sect" of the last announced SCHISM
  lastRevivalKey: string | null;    // sect of the last announced REVIVAL
  lastPilgrimKey: string | null;    // "houseId>holyIndex" of the last announced PILGRIMAGE (one per holy day)
  lastMarks: Record<string, number>;// last cron's mark per good (a MARKET_SHIFT is a one-cron move off this)
  lastCreditCount: number;          // openIous seen last cron (an increase is a fresh issuance)
  lastRunActive: boolean;           // was a RUN live last cron? (RUN is told on the false→true edge)
  classAnnounced: boolean;          // the creditor CLASS has been counted once — history, not a per-cron census
  // --- ⑧ commons trackers: a council is one chapter per era, each knob's law one decree per era ---
  lastAssemblyEra: number;          // era the last ASSEMBLY line told (0 ⇒ never)
  lastDecreeEra: Record<string, number>; // param → era of its last DECREE
  // --- ⑫ ACCELERATED AGES: the fast generational clock + the running civilizational-fortune reckoning. All
  //     additive: an older stored blob lacks them ⇒ restore's {...freshState(),...st} seeds the defaults, so
  //     the existing hash chain (headHash) and era counters are untouched by this upgrade. ---
  generation: number;               // swarm-generations counted on the fast clock (0 ⇒ not yet turned)
  genStartCron: number;             // cronSeen the current generation began (0 ⇒ prime on first sight)
  civLevel: number;                 // the historian's bounded 0..100 reckoning of the swarm's fortune
  prevCivVolume: number;            // lifetime volume at the last generation (a generation's rise/fall)
  civGolden: boolean;               // a GOLDEN_AGE is currently lit (edge-tracked, never re-spammed)
  civDark: boolean;                 // a DARK_AGE is lit (a climb back past the band is a RENAISSANCE)
  // --- ⑬⑭ tech/cities trackers: the membranes edge-detect their OWN events, so these only stop the same
  //     rung / place / generation being told twice. All additive: an older stored blob lacks them ⇒ restore's
  //     {...freshState(),...st} seeds the defaults, leaving headHash and the era counters untouched. ---
  lastInventionKey: string | null;  // rung of the last announced INVENTION
  lastDiffusionKey: string | null;  // rung of the last announced DIFFUSION
  lastLostArtKey: string | null;    // rung of the last announced LOST_ART (a reinvention may tell it again)
  lastFoundingKey: string | null;   // zone of the last announced CITY_FOUNDED
  lastCensusGen: number;            // generation of the last CENSUS — one count per generation, ever
lastTransmissionKey: string | null; // apprentice>rung of the last announced TRANSMISSION (a pupil learning higher is new again)
lastSurpassKey: string | null;      // apprentice of the last announced SURPASS (the membrane gates it one-shot per fly)
lastSchoolKey: string | null;       // rung:houseId of the last announced SCHOOL
lastCraftLostKey: string | null;    // the dying keeper id of the last announced CRAFT_LOST
  lastRecordingKey: string | null;      // the keeper id of the last announced RECORDING
  lastDecodeKey: string | null;         // the fly id of the last announced DECODE
  lastArchiveBurnedKey: string | null;  // the rung+recorder of the last announced ARCHIVE_BURNED
  lastReinventionKey: string | null;     // the fly id of the last announced REINVENTION
  lastAmnestyEra: number;               // the era an AMNESTY line was last written for (one per era, ever)
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
// Exported (like TEMPLATES) so the browser-mirror guard test can prove the shipped CHRON_ cooldown map is the
// hashed one — a drifted number there rotates the genome just as a drifted sentence does.
export const COOLDOWN: Partial<Record<ChronicleKind, number>> = {
  PANIC: 3, STORM: 5, HUDDLE: 5, FEAST: 4, BIRTH: 2, LEAD_CHANGE: 2, RECORD_CONC: 3,
  FEUD: 8, ALLIANCE: 8, BETRAYAL: 2, REPUTATION: 12,
  HOUSE_FOUNDED: 4, DYNASTY: 16, ELEGY: 1,
  EPOCH_OPEN: 200, EPOCH_CLOSE: 200,
  TREND: 8, TRADITION: 16, MARKET_SHIFT: 6, CREDIT: 10, RUN: 12, CLASS: 24,
  ASSEMBLY: 8, DECREE: 6,
  WAR_DECLARED: 4, WAR_RESOLVED: 4, TAX_LEVIED: 10,
  TERRITORY_SEIZED: 4,
  PROPHECY: 12, SCHISM: 12, REVIVAL: 12, PILGRIMAGE: 6,
  // ⑫ AGES: GENERATION is the clock itself (one line per generation, ~84 ticks); the age-phase lines are rare
  //     chapters (a golden/dark/renaissance age should not stutter), a migration rarer still.
  GENERATION: 84, GOLDEN_AGE: 400, DARK_AGE: 400, RENAISSANCE: 400, MIGRATION: 300,
  // ⑬⑭ TECH + CITIES: an invention and its diffusion are chapters (the ladder is twelve rungs long, so the
  //     chronicle can afford one line each); a lost art rarer still. A founding is a small event but happens at
  //     most sixteen times ever; URBANIZATION is a once-in-a-civilisation turn; a census is one line per
  //     generation (the membrane gates it, the cooldown only stops a same-tick duplicate); a plague wave is
  //     paced by cities.ts's own cron gap and this cooldown together.
  INVENTION: 60, DIFFUSION: 40, LOST_ART: 120,
  CITY_FOUNDED: 30, URBANIZATION: 200, CENSUS: 84, PLAGUE_WAVE: 120,
  // ⑯ APPRENTICESHIP — a lesson can be news often, so TRANSMISSION runs short; a SURPASS is a civilisational
  //     hinge (the student passing the master) and is deliberately rare; a SCHOOL is one chapter per (art,house);
  //     a CRAFT_LOST is mourned like a dark age's toll. The membrane already gates each to one pending per cron.
  TRANSMISSION: 8, SURPASS: 200, SCHOOL: 60, CRAFT_LOST: 120,
  // ⑰ Archive: a RECORDING is rare (a keeper chooses to inscribe); DECODE is one-per-cohort; ARCHIVE_BURNED
  //     is mourned like a dark age's toll on the written word.
  RECORDING: 40, DECODE: 15, ARCHIVE_BURNED: 200, REINVENTION: 80,
  // ⑲ BOURSE: the membrane already edge-detects fever/silence/tithe (one pending per spell), so these
  //     cooldowns only pace a persistent whale stir and a stuttering fever. A tithe milestone is rare by
  //     construction (millions of MURMUR of flow); a silence is one line per still spell.
  COIN_FEVER: 30, WHALE_MOVE: 20, TITHE: 60, COIN_SILENCE: 120,
  // ⑳ COURT: the membrane paces its own docket calendar (≤ one indictment, one convening and one verdict
  //     per cron; exile rides a verdict, amnesty rings at most once per era). These cooldowns only guard
  //     against a stuttering roll of the same kind — gravitas kept: an exile and an amnesty are rare words.
  INDICTMENT: 10, TRIAL: 10, VERDICT: 10, EXILE: 40, AMNESTY: 200,
  // ㉑ GAMES: the membrane rings its own era bell (≤ one opening and one crowning per era, spent once);
  //     these cooldowns only guard the gravitas — a festival proclamation should not stutter.
  GAMES: 100, CHAMPION: 100, RECORD: 200,
  // ㉒ GUILDS: the membrane itself only speaks crossings (one seal per trade ever, one pact per change,
  //     monopoly on the rising edge) — these cooldowns guard the gravitas of a proclamation. Mirrored in CHRON_.
  GUILD_CHARTER: 200, APPRENTICE_PACT: 100, GUILD_MONOPOLY: 240,
  // ㉓ LEXICON: the desk itself only speaks edges (one coinage per word ever, one per doubling, one burial),
  //     so these cooldowns are pure gravitas — a burial word especially should land slowly. Mirrored in CHRON_.
  COINAGE: 60, WORD_SPREAD: 100, WORD_DIES: 240,
  // ㉔ RUMOR MILL: the mill itself only speaks edges (one afoot per tale, one bend per tale, one quiet),
  //     so these cooldowns are pure gravitas — a tale taking wing should feel spontaneous, its bending
  //     rare, its quiet slow. Mirrored in CHRON_.
  RUMOR_AFOOT: 90, RUMOR_BENT: 240, RUMOR_FADED: 120,
  // ㉕ TREATY: the chancery only speaks edges (one seal per pair per cooldown, one ratification per seal,
  //     one breach per seal) — a breach must land fast (war is near), a ratification may savor the peace.
  TREATY_SIGNED: 120, TREATY_RATIFIED: 180, TREATY_BREACHED: 60,
  WORK_RAISED: 90, WORK_REPAIRED: 60, WORK_DILAPIDATED: 120,
  // ㉗ GUARDIANS: wardships are rare news by construction (the membrane itself one-edges per class), so these
  //     cooldowns are gravitas: a taking may speak often, a fledge savors the years, an honor is once an age.
  WARD_TAKEN: 24, WARD_FLEDGED: 18, GUARDIAN_HONORED: 60,
};

// A regime must hold for this many crons (and the era be at least this old) before a new era dawns.
const ERA_MIN_RUN = 6;
const ERA_MIN_AGE = 8;
// The swarm's own slow calendar: even with no regime turn, an age is remembered as PASSING once it has run
// this many crons (60 = ~1h at 1 cron/min). Time-slice turnover — keeps the era (and the commons that convenes
// per era) moving on a human clock without faking a season change (a distinct, honest ERA_PASSAGE line).
const ERA_MAX_AGE_CRONS = 60;

// ⑫ ACCELERATED AGES — the historian's OWN fast calendar, measured in crons and decoupled from the slow
// regime-driven era. A "generation" turns over every GEN_CRONS crons (~7 min at 1 cron/min), and on each
// turn the historian RECKONS the swarm's civilizational fortune (`civLevel`, 0..100) up or down from the real
// prosperity signals already in the context (a volume trend, equity, growth, a live feud/run, a shock age).
// Crossing a band lights a Golden/Dark/Renaissance age; a boom-time growth sparks a Great Migration. These are
// landscape DETECTOR thresholds (they shape WHEN a line is written, never its text), so — exactly like the
// culture/institution ones above — they are NOT folded into chroniclerRulesHash; only the templates + cooldowns
// these kinds add rotate the genome.
const GEN_CRONS = 7;         // crons per swarm-generation (~7 min): the fast civilizational heartbeat
const CIV_START = 40;        // a mid-history seed for a fresh/restore'd historian
const CIV_MAX = 100;
const CIV_GOLDEN = 75;       // fortune swelling to ≥ this dawns a GOLDEN_AGE
const CIV_DARK = 25;         // fortune breaking to ≤ this falls a DARK_AGE

/** The narrative templates. `{key}` inserts tokens[key]; `{key~roman}` / `{key~kth}` / `{key~lower}` apply a
 *  tiny, fully-deterministic formatter (see renderToken). This exact map is shipped to the browser verbatim. */
export const TEMPLATES: Record<ChronicleKind, string> = {
  ERA_OPEN: "Era {era~roman} · {eraName} — {size} minds tend the swarm on the Arc market, and the chronicle opens.",
  ERA_SHIFT: "Era {era~roman} · {eraName} dawns — the market has turned {regime~lower} and held it. An age begins.",
  ERA_PASSAGE: "Era {era~roman} · {eraName} turns over — an age of the {regime~lower} middle, measured by the swarm's own slow clock.",
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
  // ⑩ TERRITORY CONQUEST — the ledger-only annexation that follows a resolved war (no money moves; the ground
  //     does). Mirrored byte-for-byte in CHRON_. Fires only while TERRITORY_ENABLED + TERR_SEIZE_ON_WIN are armed.
  TERRITORY_SEIZED: "Conquest follows the verdict — the House of {winner} annexes {zones} zone(s) held by the vanquished House of {loser}, which is stripped of its ground and cast out, landless and toll-bound in exile.",
  // ⑪ RELIGION — the faith membrane's four events. Mirrored byte-for-byte in CHRON_. Fires only while
  //     RELIGION_ENABLED is on (state.ts folds no `religion` into the context otherwise).
  PROPHECY: "A prophet rises — fly #{prophet} of {sect} bears the {god} flame, and {adherents} souls follow the vision.",
  SCHISM: "Schism in the House of {name} — {sigil} its kin turn from the old way to {sect}, and the ancestral shrine stands half-empty.",
  REVIVAL: "Revival — {sect} rises from silence: {adherents} souls kindle the cold shrine anew.",
  PILGRIMAGE: "Pilgrimage — on the holy day the House of {name} {sigil} walks to the ancestral shrine, {adherents} kin bearing candles.",
  // ⑫ ACCELERATED AGES — the fast civilizational clock's five moments. Mirrored byte-for-byte in the browser
  //     CHRON_ map. Every number they cite (gen, civ, size) is a real read-out value the caller passed as tokens.
  GENERATION: "Generation {gen~roman} turns over — under {eraName} the swarm's fortune stands at {civ} of 100.",
  GOLDEN_AGE: "A Golden Age — the swarm's fortune swells past {golden} of 100 in Generation {gen~roman}; the ages look back on this as the high water.",
  DARK_AGE: "A Dark Age falls — the swarm's fortune breaks below {dark} of 100 in Generation {gen~roman}; the chronicle dims, and names are forgotten.",
  RENAISSANCE: "A Renaissance — out of the dark the swarm's fortune climbs back over {dark} of 100 in Generation {gen~roman}; the old names are read again.",
  MIGRATION: "A Great Migration — in Generation {gen~roman} the swarm spills past its old bounds at {size} minds, and a house carries its name to new ground.",
  // ⑬ TECH — the ladder of arts' three moments. Mirrored byte-for-byte in the browser CHRON_ map. Every number
  //     they cite (rung, gen, adopted, size) is a real read-out value the caller passed as tokens; the credit
  //     phrase is built by invention.ts from the dominant house, never composed here.
  INVENTION: "An art is invented — in Generation {gen~roman} the swarm discovers {name}, rung {rung} of the ladder, credited to {credit}.",
  DIFFUSION: "{name} becomes a custom — {adopted} of {size} minds now work by it, and the art belongs to the swarm rather than to whoever found it.",
  LOST_ART: "A dark age takes its toll — {name} is unlearned in Generation {gen~roman}; the ladder falls back a rung, and the art must be found again.",
  // ⑭ CITIES — the settlement map's four moments. Mirrored byte-for-byte in the browser CHRON_ map. The census
  //     cites the grave ring it was read off ("the last {graves} graves") rather than claiming a life expectancy
  //     for flies it never saw; a plague wave is NARRATED over burials the ledger already recorded.
  CITY_FOUNDED: "A place is named — {pop} kin hold the ground at {name}, and what was a camp becomes a {rank~lower} under the banner of {house}.",
  URBANIZATION: "The swarm turns urban — {urban} of {size} minds now live in {settlements} named places, the greatest of them {largest} holding {largestPop}; the open ground empties.",
  CENSUS: "A census is struck in Generation {gen~roman} — {size} minds alive, {meanAge} ticks of life across the last {graves} graves, {births} hatched and {deaths} buried since the last count.",
  PLAGUE_WAVE: "The rot walks the road — {deaths} burials inside the recent window, and the wave passes between {a} and {b} before anyone shuts a gate.",
  // ⑯ APPRENTICESHIP — the education membrane's four moments. Mirrored byte-for-byte in the browser CHRON_ map.
  //     Every id and art name is a real read-out value the caller passed as tokens; the fragile-knowledge line
  //     (CRAFT_LOST) is the layer's whole point — ⑬'s ladder still lists the art, but no living hand remembers it.
  TRANSMISSION: "Hand to hand — fly #{master}, keeper of {name}, teaches it to fly #{apprentice}; the art now lives in two minds instead of one.",
  SURPASS: "The student outstrips the teacher — fly #{apprentice} carries {name} past fly #{master}, the first hand that taught it; the ladder rises in the apprentice's grip.",
  SCHOOL: "A school of {name} — {adherents} hands in the House of {house} {sigil} now work the one art, and it will outlive any single life among them.",
  CRAFT_LOST: "A craft dies with its keeper — fly #{last} was the last living hand to hold {name}; no apprentice was taught in time, and the art goes dark though the ladder still names it.",
  RECORDING: "Carved in stone — fly #{id} sets down {name} so it will outlive every mind that held it; the swarm's knowledge is no longer only the shape of a hand.",
  DECODE: "A mind reads the stone — fly #{id} studies the record of {name} and grasps what no living teacher could pass; the art returns to a head that never met a hand.",
  ARCHIVE_BURNED: "The archive burns — the last written record of {name}, set down by fly #{recordedBy}, is lost to a dark age that could not read it; the art is now gone in every sense.",
REINVENTION: "Reinvention — fly #{id} has rediscovered {name} from the ashes of a forgotten age; the workshop fires again and the ladder regains a rung.",
  // ⑲ THE BOURSE — MURMUR's own on-chain life. Every number is a real read-out of the token's Transfer
  //     log this cron (bourse.ts): unique txs, main-leg volume, the multiple of the learned EWMA norm, the
  //     largest whale leg, the cumulative tithe FLOW through the argus tax wallet (never a balance), the
  //     length of a silent spell. Mirrored byte-for-byte in CHRON_. Fires only while BOURSE_ENABLED.
  COIN_FEVER: "Coin fever — the bourse runs hot: {txs} coin-txs carrying {volume} MURMUR in a single cron, {mult}× the learned norm; the swarm smells its own money moving.",
  WHALE_MOVE: "A whale stirs — {amount} MURMUR crosses the bourse in a single stroke; the colony flinches as its own coin shudders.",
  TITHE: "The tithe swells — {total} MURMUR has bled through the tax wallet, crossing {milestone}; the treasury's pulse glows for the whole swarm to feel.",
  COIN_SILENCE: "The bourse falls silent — {crons} crons without a single MURMUR transfer; the coin sleeps, and the world dims around it.",
  // ⑳ THE COURT — the docket speaks for the ledgers. {crime} is debt/treason/feud, {finding} guilty/cleared;
  //     every number is a real read-out of the membranes that already recorded it (economy socialSignals,
  //     the court's own bounded roll). Mirrored byte-for-byte in CHRON_. Fires only while COURTS_ENABLED.
  INDICTMENT: "The court sits — fly #{id} is indicted for {crime}; the ledgers accuse where the swarm never could.",
  TRIAL: "A trial opens — fly #{id} answers for {crime} before {jurors} jurors, seated by the hash of the case itself.",
  VERDICT: "The jury speaks — fly #{id}, tried for {crime}: {finding} by {votes} of {jurors} votes.",
  EXILE: "Exile — convicted of {crime}, fly #{id} is cast beyond the commons' protection until a new era's mercy.",
  AMNESTY: "Amnesty — the new era pardons the outlaw roll; {outlaws} names struck from the court's book.",
  // ㉑ THE GAMES — the era bell's festivals. {event} is the day's drawn race, {venue}/{house} the presiding
  //     house ("the commons"/"no house" when the dynasty names none); {deals}/{prev} are the champion's and
  //     the fallen mark's OWN lifetime settlements — every number re-derivable from the ledgers. Mirrored in CHRON_.
  GAMES: "The {era}th games open at the house of {venue} — the programme is {event}; the swarm pauses its ledgers for the stadium.",
  CHAMPION: "A champion is crowned — fly #{id} wins {event}; {house} raises its sigil over the stadium.",
  RECORD: "The record falls — fly #{id} posts {deals} lifetime dealings past the old mark of {prev}; the games now keep their own history.",
  // ㉒ THE GUILDS — the chartered trades. {role} is the economy's own profession name (forager/mooder/
  //     trader/brooder), {members}/{quorum} and {share} are live headcounts of the working swarm —
  //     every number re-derivable from the profession ledger. Mirrored verbatim in the frontend CHRON_.
  GUILD_CHARTER: "A trade wins its charter — the guild of {role} is founded with {members} living hands past the quorum of {quorum}; the {era}th era sets its seal.",
  APPRENTICE_PACT: "A pact is struck — fly #{id} takes up {role} beneath a chartered banner; the guild now counts {members} hands.",
  GUILD_MONOPOLY: "One trade holds the field — {share} percent of the working swarm now serves the guild of {role}; no other banner flies so full.",
  // ㉓ THE LEXICON — the words the telling makes. {word} is the coined noun itself (a canonical English
  //     word from lexicon.ts's closed vocabulary), {uses}/{gap} are tellings counted over the hot annals
  //     roll — every number re-derivable by replaying the roll. Mirrored verbatim in the frontend CHRON_.
  COINAGE: "The lexicon grows — {word} enters as common tongue: {uses} tellings in living memory made it a word the chronicle must keep.",
  WORD_SPREAD: "A word on every tongue — {word} has doubled to {uses} tellings; the lexicographers can no longer pretend it is new.",
  WORD_DIES: "A word falls silent — {word} has gone unspoken for {gap} tellings; the lexicon marks it remembered, not living.",
  // ㉔ THE RUMOR MILL — the tale that carries itself. {topic} is the market noun the kind is talked as
  //     (rumor.ts's own map), {heard} counts ears the mill has tallied, {heardAs} is the bend's direction
  //     (graver/lighter). Every number is re-derivable by replaying the annals roll. Mirrored verbatim in
  //     the frontend CHRON_.
  RUMOR_AFOOT: "A tale takes wing — the {topic} of era {era} passes from fly to fly: {heard} ears already lean in.",
  RUMOR_BENT: "The tale bends — told {heard} times over, the {topic} is now heard as {heardAs}; nobody agrees any more on what was first said.",
  RUMOR_FADED: "The tale quiets — the {topic} is told no more; {heard} ears carried it while it lived.",
  // ㉕ THE TREATY — formal diplomacy between houses. {houseA}/{houseB} are the houses' own names, {terms}
  //     counts the clauses the depth of the grudge forced (treaty.ts), {era} the age the pen moved in.
  //     Every edge is re-derivable by replaying the house-bond series. Mirrored verbatim in the frontend CHRON_.
  TREATY_SIGNED: "Two houses set their seals — {houseA} and {houseB} bury the feud under a treaty of {terms} clauses; era {era} has bled enough for both.",
  TREATY_RATIFIED: "The treaty holds — {houseA} and {houseB} have kept their {terms} clauses past the probation; what was signed in anger is ratified now in habit.",
  TREATY_BREACHED: "The seal is broken — {houseA} tears the treaty of {terms} clauses with {houseB}; the old feud resumes where the ink stopped.",
WORK_RAISED: "The commons breaks ground — the {work} rises in era {era}: a thing the swarm owns together and no single purse paid for.",
WORK_REPAIRED: "The {work} is mended — what the commons raised, the commons keeps; a public thing repaired is a society intending to stay.",
WORK_DILAPIDATED: "The {work} falls to ruin — {lived} crons it stood and no hand was sent to it; the decay is the ledger's own.",
  // ㉗ THE GUARDIANS — wardship and inheritance. {ward} is a fly id, {guardian} a house name or "the commons",
  //     {estate} the USDC that passed to young hands, {crons} the carried minority, {lived} the whole circle's
  //     span. Every edge is re-derivable by replaying the grave ring and the living roster. Mirrored verbatim.
  WARD_TAKEN: "Fly #{ward} is taken into wardship by {guardian} — an estate of {estate} USDC passes to young hands; what grief cannot keep, guardianship holds.",
  WARD_FLEDGED: "Ward #{ward} stands on its own — {guardian} carried it {crons} crons and the inheritance holds; a raised fly honors the one that raised it.",
  GUARDIAN_HONORED: "Old ward #{ward} lies down of age with its own heirs paid — the wardship of {guardian} is honored full circle: borrowed from grief, returned to the future.",
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
    eraMaxAge: ERA_MAX_AGE_CRONS,
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
        const cronAge = s.cronSeen - s.eraStartCron;
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
        } else if (cronAge >= ERA_MAX_AGE_CRONS && !s.eraShock) {
          // TIME-SLICE ERA: the season never turned and no shock forced it, but the age has simply run its
          // course on the swarm's own clock — the calendar rolls one hour older. Honest passage of time.
          s.era += 1;
          s.eraRegime = ctx.regime;
          s.eraStartTick = ctx.tick;
          s.eraStartCron = s.cronSeen;
          const pool = ERA_NAMES[ctx.regime];
          const pick = pool[(s.era - 1) % pool.length];
          s.eraName = pick === s.eraName ? pool[s.era % pool.length] : pick;
          out.push(await this.emit(ctx, "ERA_PASSAGE", 2, [],
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
      // ⑩ TERRITORY CONQUEST: a resolved war's winner annexed the loser's zones THIS cron (ledger-only; folded
      //     in by state.ts only while TERRITORY_ENABLED + TERR_SEIZE_ON_WIN are armed, so war.seized is null on
      //     the default deployment and no line is told — the chronicle stays byte-for-byte the pre-conquest build).
      if (war.seized && war.seized.zones.length && this.ready("TERRITORY_SEIZED", ctx)) {
        const s = war.seized;
        out.push(await this.emit(ctx, "TERRITORY_SEIZED", 4, s.winnerId != null ? [s.winnerId] : [],
          { winner: s.winnerName, loser: s.loserName, zones: s.zones.length },
          { winnerId: s.winnerId ?? 0, loserId: s.loserId ?? 0, zones: s.zones.length }));
      }
    }

    // --- ⑪ RELIGION: the faith membrane's four moments this cron — a prophet rising, a house schism, a sect
    //     revived from silence, a holy-day pilgrimage. Each is a pure read-out of religion.ts's OWN edge-detected
    //     signals (never a per-cron census); RELIGION_ENABLED=false ⇒ state.ts folds no `religion` into the
    //     context ⇒ this whole block is inert and the chronicle stays byte-for-byte the pre-faith build. Trackers
    //     + cooldowns keep each event a one-time chapter. ---
    const rel = ctx.religion;
    if (rel) {
      if (rel.prophecy) {
        const key = `${rel.prophecy.sect}>${rel.prophecy.prophetId}`;
        if (key !== s.lastProphetKey && this.ready("PROPHECY", ctx)) {
          s.lastProphetKey = key;
          out.push(await this.emit(ctx, "PROPHECY", 2, [rel.prophecy.prophetId],
            { prophet: rel.prophecy.prophetId, sect: rel.prophecy.sect, god: rel.prophecy.god, adherents: rel.prophecy.adherents },
            { prophetId: rel.prophecy.prophetId, adherents: rel.prophecy.adherents }));
        }
      }
      if (rel.schism) {
        const key = `${rel.schism.houseId}>${rel.schism.sect}`;
        if (key !== s.lastSchismKey && this.ready("SCHISM", ctx)) {
          s.lastSchismKey = key;
          out.push(await this.emit(ctx, "SCHISM", 2, [],
            { name: rel.schism.name, sigil: rel.schism.sigil, sect: rel.schism.sect },
            { houseId: rel.schism.houseId }));
        }
      }
      if (rel.revival) {
        const key = rel.revival.sect;
        if (key !== s.lastRevivalKey && this.ready("REVIVAL", ctx)) {
          s.lastRevivalKey = key;
          out.push(await this.emit(ctx, "REVIVAL", 2, [],
            { sect: rel.revival.sect, adherents: rel.revival.adherents },
            { adherents: rel.revival.adherents }));
        }
      }
      if (rel.pilgrimage) {
        const holyIndex = ctx.tick;   // a holy day's own tick — distinct per holy day, so one pilgrimage a day
        const key = `${rel.pilgrimage.houseId}>${holyIndex}`;
        if (key !== s.lastPilgrimKey && this.ready("PILGRIMAGE", ctx)) {
          s.lastPilgrimKey = key;
          out.push(await this.emit(ctx, "PILGRIMAGE", 2, [],
            { name: rel.pilgrimage.name, sigil: rel.pilgrimage.sigil, adherents: rel.pilgrimage.adherents },
            { houseId: rel.pilgrimage.houseId, adherents: rel.pilgrimage.adherents }));
        }
      }
    }

    // --- ⑫ ACCELERATED AGES: the swarm's OWN fast civilizational clock. Independent of the slow era, a
    //     "generation" turns over every GEN_CRONS crons; the historian RECKONS the swarm's fortune (civLevel)
    //     up or down from the real prosperity signals already in the context, and names the ages that rise
    //     (Golden), fall (Dark), recover (Renaissance) or spill outward (a Great Migration). PURE READ-OUT:
    //     it reads only the context + its own trackers, mutates nothing, and never feeds back into any
    //     decision. Gated on epochsOn ⇒ EPOCHS_ENABLED=false returns the chronicle byte-for-byte pre-ages. ---
    if (this.epochsOn) {
      if (s.genStartCron === 0) s.genStartCron = s.cronSeen;   // prime, so a mid-history start doesn't jump
      if (s.cronSeen - s.genStartCron >= GEN_CRONS) {
        s.genStartCron = s.cronSeen;
        s.generation += 1;
        // a bounded, deterministic step taken on the swarm's real condition this generation
        let d = 0;
        if (s.prevCivVolume > 0) d += ctx.volumeUsdc > s.prevCivVolume ? 3 : -2;
        d += ctx.gini <= 0.4 ? 2 : (ctx.gini >= 0.6 ? -3 : 0);
        if (ctx.size > 0 && ctx.size >= s.maxSize) d += 1;
        if (ctx.social?.topFeud) d -= 1;
        if (ctx.market?.run) d -= 4;
        if (s.eraShock) d -= 5;                                // an age of famine/plague/war dims the spirit
        const wasDark = s.civDark, wasGolden = s.civGolden;
        s.civLevel = Math.max(0, Math.min(CIV_MAX, s.civLevel + d));
        s.prevCivVolume = ctx.volumeUsdc;
        const civ = Math.round(s.civLevel);
        // age-phase EDGES — each a chapter, guarded by its long cooldown so a standing age never re-spams
        if (!wasGolden && s.civLevel >= CIV_GOLDEN) {
          s.civGolden = true; s.civDark = false;
          out.push(await this.emit(ctx, "GOLDEN_AGE", 4, [],
            { gen: s.generation, golden: CIV_GOLDEN, civ }, { civLevel: s.civLevel }));
        } else if (!wasDark && s.civLevel <= CIV_DARK) {
          s.civDark = true; s.civGolden = false;
          out.push(await this.emit(ctx, "DARK_AGE", 4, [],
            { gen: s.generation, dark: CIV_DARK, civ }, { civLevel: s.civLevel }));
        } else if (wasDark && s.civLevel > CIV_DARK + 10) {
          s.civDark = false;
          out.push(await this.emit(ctx, "RENAISSANCE", 3, [],
            { gen: s.generation, dark: CIV_DARK, civ }, { civLevel: s.civLevel }));
        } else if (wasGolden && s.civLevel < CIV_GOLDEN - 10) {
          s.civGolden = false;                                 // the high water recedes quietly, no line
        }
        // a Great Migration: outward expansion on a rising, record-size swarm with a house bold enough to lead
        if (d > 0 && ctx.size > 0 && ctx.size >= s.maxSize && ctx.dynasty?.dominance && this.ready("MIGRATION", ctx)) {
          out.push(await this.emit(ctx, "MIGRATION", 3, [],
            { gen: s.generation, size: ctx.size }, { size: ctx.size, civLevel: s.civLevel }));
        }
        // the generation itself always turns over — the fast clock's heartbeat, one honest line per turn
        if (this.ready("GENERATION", ctx)) {
          out.push(await this.emit(ctx, "GENERATION", 2, [],
            { gen: s.generation, eraName: s.eraName, civ }, { civLevel: s.civLevel }));
        }
      }
    }

    // --- ⑬ TECH: the ladder of arts. invention.ts edge-detects its own three moments on the historian's own
    //     clocks (a rung discovered when a generation turns and both its gates are open, an art diffusing past
    //     half the swarm, the top rung unlearned when fortune breaks into a dark age), so this block only NAMES
    //     them and keeps the anti-stutter keys. TECH_ENABLED=false ⇒ state.ts folds no `tech` into the context
    //     ⇒ this whole block is inert and the chronicle stays byte-for-byte the pre-ladder build. ---
    const tech = ctx.tech;
    if (tech) {
      if (tech.discovery) {
        const key = String(tech.discovery.rung);
        if (key !== s.lastInventionKey && this.ready("INVENTION", ctx)) {
          const d = tech.discovery;
          s.lastInventionKey = key;
          out.push(await this.emit(ctx, "INVENTION", 3, [],
            { name: d.name, rung: d.rung, gen: d.gen, credit: d.credit },
            { rung: d.rung, gen: d.gen, civ: d.civ }));
        }
      }
      if (tech.diffusion) {
        const key = String(tech.diffusion.rung);
        if (key !== s.lastDiffusionKey && this.ready("DIFFUSION", ctx)) {
          const d = tech.diffusion;
          s.lastDiffusionKey = key;
          out.push(await this.emit(ctx, "DIFFUSION", 2, [],
            { name: d.name, adopted: d.adopted, size: d.size },
            { rung: d.rung, adopted: d.adopted, size: d.size }));
        }
      }
      if (tech.lostArt) {
        const key = String(tech.lostArt.rung);
        if (key !== s.lastLostArtKey && this.ready("LOST_ART", ctx)) {
          const d = tech.lostArt;
          s.lastLostArtKey = key;
          out.push(await this.emit(ctx, "LOST_ART", 3, [],
            { name: d.name, gen: d.gen }, { rung: d.rung, gen: d.gen }));
        }
      }
    }

    // --- ⑭ CITIES: the settlement map's four moments. cities.ts reads the economy's OWN zone ledger and grave
    //     ring and edge-detects them (a place named once per zone for good, the urban turn behind a hysteresis,
    //     one census per generation, a plague wave paced by its own cron gap), so once again this block only
    //     names what the map already decided. PLAGUE_WAVE deliberately leans on the membrane's cron gap plus
    //     this cooldown rather than a key, because a long dying on the SAME road is several chapters, not one.
    //     NARRATION ONLY — no death was caused here; the burials were already in the ledger. CITIES_ENABLED=false
    //     ⇒ no `cities` in the context ⇒ inert, byte-for-byte the pre-map build. ---
    const city = ctx.cities;
    if (city) {
      if (city.founding) {
        const key = String(city.founding.zone);
        if (key !== s.lastFoundingKey && this.ready("CITY_FOUNDED", ctx)) {
          const f = city.founding;
          s.lastFoundingKey = key;
          out.push(await this.emit(ctx, "CITY_FOUNDED", 2, [],
            { name: f.name, pop: f.pop, rank: f.rank, house: f.house },
            { zone: f.zone, pop: f.pop }));
        }
      }
      if (city.urbanization && this.ready("URBANIZATION", ctx)) {
        const u = city.urbanization;
        out.push(await this.emit(ctx, "URBANIZATION", 3, [],
          { urban: u.urban, size: u.size, settlements: u.settlements, largest: u.largest, largestPop: u.largestPop },
          { urban: u.urban, size: u.size, settlements: u.settlements }));
      }
      if (city.census && city.census.gen !== s.lastCensusGen && this.ready("CENSUS", ctx)) {
        const c = city.census;
        s.lastCensusGen = c.gen;
        out.push(await this.emit(ctx, "CENSUS", 2, [],
          { gen: c.gen, size: c.size, meanAge: c.meanAge, graves: c.graves, births: c.births, deaths: c.deaths },
          { size: c.size, meanAge: c.meanAge, graves: c.graves, births: c.births, deaths: c.deaths, gen: c.gen }));
      }
      if (city.plagueWave && this.ready("PLAGUE_WAVE", ctx)) {
        const p = city.plagueWave;
        out.push(await this.emit(ctx, "PLAGUE_WAVE", 3, [],
          { deaths: p.deaths, a: p.a, b: p.b }, { deaths: p.deaths }));
      }
    }

    // --- ⑯ APPRENTICESHIP: education + cumulative culture's four moments. apprentice.ts edge-detects them on the
    //     swarm's own cohort (an art taught hand to hand, a student climbing past its first teacher, a house's
    //     school, and the last living keeper of an art dying untaught), so this block only names what the membrane
    //     already decided. The ledger-vs-ladder gap is the story: a CRAFT_LOST can fire while ⑬'s rungCount still
    //     shows the art, because the ladder records what was invented and this records what is remembered.
    //     APPRENTICE_ENABLED=false ⇒ no `apprentice` in the context ⇒ inert, byte-for-byte the pre-education build. ---
    const appr = ctx.apprentice;
    if (appr) {
      if (appr.transmission) {
        const key = `${appr.transmission.apprentice}>${appr.transmission.rung}`;
        if (key !== s.lastTransmissionKey && this.ready("TRANSMISSION", ctx)) {
          const t = appr.transmission;
          s.lastTransmissionKey = key;
          out.push(await this.emit(ctx, "TRANSMISSION", 2, [t.master, t.apprentice],
            { master: t.master, apprentice: t.apprentice, name: t.name },
            { rung: t.rung, apprentice: t.apprentice, master: t.master }));
        }
      }
      if (appr.surpass) {
        const key = String(appr.surpass.apprentice);
        if (key !== s.lastSurpassKey && this.ready("SURPASS", ctx)) {
          const u = appr.surpass;
          s.lastSurpassKey = key;
          out.push(await this.emit(ctx, "SURPASS", 4, [u.apprentice, u.master],
            { apprentice: u.apprentice, master: u.master, name: u.name },
            { rung: u.rung, apprentice: u.apprentice, master: u.master }));
        }
      }
      if (appr.school) {
        const key = `${appr.school.rung}:${appr.school.houseName}`;
        if (key !== s.lastSchoolKey && this.ready("SCHOOL", ctx)) {
          const g = appr.school;
          s.lastSchoolKey = key;
          out.push(await this.emit(ctx, "SCHOOL", 3, [],
            { name: g.name, house: g.houseName, sigil: g.sigil, adherents: g.adherents },
            { rung: g.rung, adherents: g.adherents }));
        }
      }
      if (appr.craftLost) {
        const key = String(appr.craftLost.last);
        if (key !== s.lastCraftLostKey && this.ready("CRAFT_LOST", ctx)) {
          const l = appr.craftLost;
          s.lastCraftLostKey = key;
          out.push(await this.emit(ctx, "CRAFT_LOST", 3, [l.last],
            { last: l.last, name: l.name },
            { rung: l.rung, last: l.last }));
        }
      }
    }

    // ⑰ ARCHIVE — externalized knowledge: a keeper inscribes, a mind decodes, a dark age burns.
    const arch = ctx.archive;
    if (arch) {
      if (arch.recording) {
        const key = String(arch.recording.id);
        if (key !== s.lastRecordingKey && this.ready("RECORDING", ctx)) {
          const r = arch.recording;
          s.lastRecordingKey = key;
          out.push(await this.emit(ctx, "RECORDING", 2, [r.id],
            { id: r.id, rung: r.rung, name: r.name },
            { rung: r.rung, id: r.id }));
        }
      }
      if (arch.decode) {
        const key = String(arch.decode.id);
        if (key !== s.lastDecodeKey && this.ready("DECODE", ctx)) {
          const d = arch.decode;
          s.lastDecodeKey = key;
          out.push(await this.emit(ctx, "DECODE", 2, [d.id],
            { id: d.id, rung: d.rung, name: d.name },
            { rung: d.rung, id: d.id }));
        }
      }
      if (arch.archiveBurned) {
        const key = `${arch.archiveBurned.rung}:${arch.archiveBurned.recordedBy}`;
        if (key !== s.lastArchiveBurnedKey && this.ready("ARCHIVE_BURNED", ctx)) {
          const b = arch.archiveBurned;
          s.lastArchiveBurnedKey = key;
          out.push(await this.emit(ctx, "ARCHIVE_BURNED", 4, [b.recordedBy],
            { rung: b.rung, name: b.name, recordedBy: b.recordedBy },
            { rung: b.rung, recordedBy: b.recordedBy }));
        }
      }
    }

    // ⑱ Workshop: REINVENTION
    const wrk = ctx.workshop;
    if (wrk?.reinvention) {
      const key = `${wrk.reinvention.id}`;
      if (key !== s.lastReinventionKey && this.ready("REINVENTION", ctx)) {
        const r = wrk.reinvention;
        s.lastReinventionKey = key;
        out.push(await this.emit(ctx, "REINVENTION", 3, [r.id],
          { id: r.id, rung: r.rung, name: r.name },
          { rung: r.rung, id: r.id }));
      }
    }

    // ⑲ The Bourse: MURMUR's on-chain climate (read-only; folded in ONLY while BOURSE_ENABLED — off ⇒ no
    //     `bourse` key ⇒ these four detectors never speak). The membrane edge-detects its own spells, so
    //     every non-null facet is news THIS cron; the cooldowns above only pace a persistent whale stir.
    const bou = ctx.bourse;
    if (bou) {
      if (bou.fever && this.ready("COIN_FEVER", ctx)) {
        const f = bou.fever;
        out.push(await this.emit(ctx, "COIN_FEVER", 2, [],
          { txs: f.txs, volume: round(f.volumeMurmur), mult: round(f.mult) },
          { txs: f.txs, volumeMurmur: round(f.volumeMurmur), mult: round(f.mult) }));
      }
      if (bou.whale && this.ready("WHALE_MOVE", ctx)) {
        const w = bou.whale;
        out.push(await this.emit(ctx, "WHALE_MOVE", 2, [],
          { amount: round(w.amountMurmur) },
          { amountMurmur: round(w.amountMurmur) }));
      }
      if (bou.tithe && this.ready("TITHE", ctx)) {
        const t = bou.tithe;
        out.push(await this.emit(ctx, "TITHE", 2, [],
          { total: round(t.totalMurmur), milestone: round(t.milestoneMurmur) },
          { totalMurmur: round(t.totalMurmur), milestoneMurmur: round(t.milestoneMurmur) }));
      }
      if (bou.silence && this.ready("COIN_SILENCE", ctx)) {
        out.push(await this.emit(ctx, "COIN_SILENCE", 2, [],
          { crons: bou.silence.crons },
          { crons: bou.silence.crons }));
      }
    }

    // ⑳ The Court: the docket's edge events (court.ts signals, folded in ONLY while COURTS_ENABLED — off ⇒
    //     no `court` key ⇒ these five detectors never speak). The membrane's calendar already paces the
    //     lifecycle (one stage per cron, pending reset every round), so each non-null facet is news; the
    //     era-tracker below is the one hard guard — an amnesty may be written once per era, ever.
    const crt = ctx.court;
    if (crt) {
      if (crt.indictment && this.ready("INDICTMENT", ctx)) {
        const i = crt.indictment;
        out.push(await this.emit(ctx, "INDICTMENT", 2, [i.id],
          { id: i.id, crime: i.crime }, { id: i.id }));
      }
      if (crt.trial && this.ready("TRIAL", ctx)) {
        const t = crt.trial;
        out.push(await this.emit(ctx, "TRIAL", 2, [t.id],
          { id: t.id, crime: t.crime, jurors: t.jurors }, { id: t.id, jurors: t.jurors }));
      }
      if (crt.verdict && this.ready("VERDICT", ctx)) {
        const v = crt.verdict;
        out.push(await this.emit(ctx, "VERDICT", v.guilty ? 3 : 2, [v.id],
          { id: v.id, crime: v.crime, finding: v.guilty ? "guilty" : "cleared", votes: v.votes, jurors: v.jurors },
          { id: v.id, guilty: v.guilty ? 1 : 0, votes: v.votes, jurors: v.jurors }));
      }
      if (crt.exile && this.ready("EXILE", ctx)) {
        const x = crt.exile;
        out.push(await this.emit(ctx, "EXILE", 4, [x.id],
          { id: x.id, crime: x.crime }, { id: x.id }));
      }
      if (crt.amnesty && this.ready("AMNESTY", ctx) && s.era !== s.lastAmnestyEra) {
        s.lastAmnestyEra = s.era;
        out.push(await this.emit(ctx, "AMNESTY", 2, [],
          { outlaws: crt.amnesty.outlaws }, { outlaws: crt.amnesty.outlaws }));
      }
    }

    // ㉑ The Games: the era bell's festivals (games.ts signals, folded in ONLY while GAMES_ENABLED — off ⇒
    //     no `games` key ⇒ these three detectors never speak). The membrane spends each era's bell itself
    //     (seen-eras roll) and resets its pending every round, so every non-null facet is news this cron.
    const gms = ctx.games;
    if (gms) {
      if (gms.games && this.ready("GAMES", ctx)) {
        const g = gms.games;
        out.push(await this.emit(ctx, "GAMES", 2, [],
          { era: g.era, event: g.event, venue: g.venue }, { era: g.era }));
      }
      if (gms.champion && this.ready("CHAMPION", ctx)) {
        const c = gms.champion;
        out.push(await this.emit(ctx, "CHAMPION", 3, [c.id],
          { id: c.id, event: c.event, house: c.house ?? "no house" }, { id: c.id }));
      }
      if (gms.record && this.ready("RECORD", ctx)) {
        const r = gms.record;
        out.push(await this.emit(ctx, "RECORD", 3, [r.id],
          { id: r.id, deals: r.deals, prev: r.prev }, { id: r.id, deals: r.deals, prev: r.prev }));
      }
    }

    // ㉒ The Guilds: the chartered trades (guilds.ts signals, folded in ONLY while GUILD_ENABLED — off ⇒
    //     no `guilds` key ⇒ these three detectors never speak). The membrane adopts its first round
    //     silently and speaks only crossings after that, so every non-null facet is news this cron.
    const gld = ctx.guilds;
    if (gld) {
      if (gld.charter && this.ready("GUILD_CHARTER", ctx)) {
        const ch = gld.charter;
        out.push(await this.emit(ctx, "GUILD_CHARTER", 2, [],
          { role: ch.role, members: ch.members, quorum: ch.quorum, era: ch.era },
          { members: ch.members, quorum: ch.quorum, era: ch.era }));
      }
      if (gld.pact && this.ready("APPRENTICE_PACT", ctx)) {
        const pc = gld.pact;
        out.push(await this.emit(ctx, "APPRENTICE_PACT", 2, [pc.id],
          { id: pc.id, role: pc.role, members: pc.members }, { id: pc.id, members: pc.members }));
      }
      if (gld.monopoly && this.ready("GUILD_MONOPOLY", ctx)) {
        const mo = gld.monopoly;
        out.push(await this.emit(ctx, "GUILD_MONOPOLY", 3, [],
          { role: mo.role, share: mo.share }, { share: mo.share }));
      }
    }

    // ㉓ The Lexicon: the words the telling makes (lexicon.ts signals, folded in ONLY while LEX_ENABLED —
    //     off ⇒ no `lexicon` key ⇒ these three detectors never speak). Every facet is a pure count-edge
    //     over the annals roll already history, so a non-null facet is news this cron and cannot replay.
    const lx = ctx.lexicon;
    if (lx) {
      if (lx.coinage && this.ready("COINAGE", ctx)) {
        const cn = lx.coinage;
        out.push(await this.emit(ctx, "COINAGE", 2, [],
          { word: cn.word, uses: cn.uses, era: cn.era }, { uses: cn.uses, era: cn.era }));
      }
      if (lx.spread && this.ready("WORD_SPREAD", ctx)) {
        const sp = lx.spread;
        out.push(await this.emit(ctx, "WORD_SPREAD", 2, [],
          { word: sp.word, uses: sp.uses }, { uses: sp.uses }));
      }
      if (lx.dying && this.ready("WORD_DIES", ctx)) {
        const dd = lx.dying;
        out.push(await this.emit(ctx, "WORD_DIES", 3, [],
          { word: dd.word, gap: dd.gap }, { gap: dd.gap }));
      }
    }

    // ㉔ The Rumor Mill: the tale that carries itself (rumor.ts signals, folded in ONLY while RM_ENABLED —
    //     off ⇒ no `rumor` key ⇒ these three detectors never speak). Each facet is an edge the mill fires
    //     at most once per tale, so a non-null facet is news this cron and cannot replay. The actors are
    //     the ORIGINAL telling's own mouths — a tale is always told about someone.
    const rm = ctx.rumor;
    if (rm) {
      if (rm.afoot && this.ready("RUMOR_AFOOT", ctx)) {
        const af = rm.afoot;
        out.push(await this.emit(ctx, "RUMOR_AFOOT", 2, af.holders,
          { topic: af.topic, heard: af.heard, era: af.era }, { heard: af.heard, era: af.era }));
      }
      if (rm.bent && this.ready("RUMOR_BENT", ctx)) {
        const bn = rm.bent;
        out.push(await this.emit(ctx, "RUMOR_BENT", 3, [],
          { topic: bn.topic, heard: bn.heard, heardAs: bn.heardAs }, { heard: bn.heard }));
      }
      if (rm.faded && this.ready("RUMOR_FADED", ctx)) {
        const fd = rm.faded;
        out.push(await this.emit(ctx, "RUMOR_FADED", 2, [],
          { topic: fd.topic, heard: fd.heard }, { heard: fd.heard }));
      }
    }

    // ㉕ The Treaty: formal diplomacy (treaty.ts signals, folded in ONLY while TR_ENABLED — off ⇒ no
    //     `treaty` key ⇒ these three detectors never speak). The membrane fires at most one edge per class
    //     per cron, so a non-null facet is news this cron. The actors are the two houses themselves —
    //     a seal always has two signatories, a breach always has two sides.
    const tr = ctx.treaty;
    if (tr) {
      if (tr.signed && this.ready("TREATY_SIGNED", ctx)) {
        const sg = tr.signed;
        out.push(await this.emit(ctx, "TREATY_SIGNED", 3, [sg.a, sg.b],
          { houseA: sg.nameA, houseB: sg.nameB, terms: sg.terms, era: sg.era }, { terms: sg.terms, era: sg.era }));
      }
      if (tr.ratified && this.ready("TREATY_RATIFIED", ctx)) {
        const rt = tr.ratified;
        out.push(await this.emit(ctx, "TREATY_RATIFIED", 2, [rt.a, rt.b],
          { houseA: rt.nameA, houseB: rt.nameB, terms: rt.terms }, { terms: rt.terms }));
      }
      if (tr.breached && this.ready("TREATY_BREACHED", ctx)) {
        const br = tr.breached;
        out.push(await this.emit(ctx, "TREATY_BREACHED", 4, [br.a, br.b],
          { houseA: br.nameA, houseB: br.nameB, terms: br.terms }, { terms: br.terms }));
      }
    }

    // ㉖ The Public Works: the common goods (works.ts signals, folded in ONLY while WORKS_ENABLED — off ⇒ no
    //     `works` key ⇒ these three detectors never speak). The membrane fires at most one edge per class per
    //     cron, so a non-null facet is news this cron. NO actors: a public work belongs to nobody and everybody.
    const wk = ctx.works;
    if (wk) {
      if (wk.raised && this.ready("WORK_RAISED", ctx)) {
        const r = wk.raised;
        out.push(await this.emit(ctx, "WORK_RAISED", 3, [], { work: r.kind, era: r.era }, { era: r.era }));
      }
      if (wk.repaired && this.ready("WORK_REPAIRED", ctx)) {
        const rp = wk.repaired;
        out.push(await this.emit(ctx, "WORK_REPAIRED", 2, [], { work: rp.kind }, {}));
      }
      if (wk.dilapidated && this.ready("WORK_DILAPIDATED", ctx)) {
        const d = wk.dilapidated;
        out.push(await this.emit(ctx, "WORK_DILAPIDATED", 3, [], { work: d.kind, lived: d.lived ?? 0 }, { lived: d.lived ?? 0 }));
      }
    }

    // ㉗ The Guardians: wardship and inheritance (guardians.ts signals, folded in ONLY while GUARDIANS_ENABLED —
    //     off ⇒ no `guardians` key ⇒ these three detectors never speak). One edge per class per cron by the
    //     membrane itself; the single actor is the WARD — the living fly the news is about, not the buried one.
    const gd = ctx.guardians;
    if (gd) {
      if (gd.taken && this.ready("WARD_TAKEN", ctx)) {
        const t = gd.taken;
        out.push(await this.emit(ctx, "WARD_TAKEN", 3, idList(t.ward),
          { ward: t.ward, guardian: t.guardian, estate: t.estate ?? 0, era: t.era },
          { era: t.era, estate: t.estate ?? 0 }));
      }
      if (gd.fledged && this.ready("WARD_FLEDGED", ctx)) {
        const f = gd.fledged;
        out.push(await this.emit(ctx, "WARD_FLEDGED", 2, idList(f.ward),
          { ward: f.ward, guardian: f.guardian, crons: f.crons ?? 0 },
          { crons: f.crons ?? 0 }));
      }
      if (gd.honored && this.ready("GUARDIAN_HONORED", ctx)) {
        const h = gd.honored;
        out.push(await this.emit(ctx, "GUARDIAN_HONORED", 4, idList(h.ward),
          { ward: h.ward, guardian: h.guardian, lived: h.lived ?? 0 },
          { lived: h.lived ?? 0 }));
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
    // ⑫ ACCELERATED AGES (additive): the fast clock's state, for the /annals header read-out. Pure projection
    //     of the trackers above — a new field on an existing object, so every older caller still compiles.
    generation: number; civLevel: number; civPhase: "golden" | "dark" | "ascendant" | "declining";
  } {
    const phase: "golden" | "dark" | "ascendant" | "declining" =
      this.s.civDark ? "dark" : this.s.civGolden ? "golden" : (this.s.civLevel >= 50 ? "ascendant" : "declining");
    return {
      era: this.s.era, eraName: this.s.eraName, eraRegime: this.s.eraRegime, seq: this.s.seq, headHash: this.s.headHash,
      eraShock: this.s.eraShock, eraShockWilled: this.s.eraShockWilled,
      generation: this.s.generation, civLevel: Math.round(this.s.civLevel), civPhase: phase,
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
    lastProphetKey: null, lastSchismKey: null, lastRevivalKey: null, lastPilgrimKey: null,
    lastAssemblyEra: 0, lastDecreeEra: {},
    generation: 0, genStartCron: 0, civLevel: CIV_START, prevCivVolume: 0, civGolden: false, civDark: false,
    lastInventionKey: null, lastDiffusionKey: null, lastLostArtKey: null, lastFoundingKey: null, lastCensusGen: -1,
lastTransmissionKey: null, lastSurpassKey: null, lastSchoolKey: null, lastCraftLostKey: null,
    lastRecordingKey: null, lastDecodeKey: null, lastArchiveBurnedKey: null, lastReinventionKey: null,
    lastAmnestyEra: -1,
    headHash: GENESIS_HASH,
  };
}

function idList(id: number | null): number[] { return id == null ? [] : [id]; }

/** The fly most worth naming on a founding moment: the richest, if known. */
function namedActors(ctx: ChronicleContext): number[] { return idList(ctx.richestId); }

function round(x: number): number { return Math.round(clamp100(x) * 1000) / 1000; }
// keep values readable in JSON without over-clamping real metrics (settlements can be huge)
function clamp100(x: number): number { return Number.isFinite(x) ? Math.max(-1e9, Math.min(1e9, x)) : 0; }
