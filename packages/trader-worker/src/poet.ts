// ⑮ THE LAUREATE — a poet born in the swarm, writing with neurons instead of an LLM.
//
// Every era the swarm deterministically crowns ONE living fly its laureate. Each hour that fly reads its OWN
// live neural activity (the decoded drives + the neural fingerprint the motor decoder already froze) together
// with the on-chain reality (market temperature, volume, burials, equity, the age's climate) and decodes them
// through a PUBLIC grammar into a four-line English imagist poem. The poem is a neural receipt: anyone can
// recompute its sha256 and, using the published grammar in THIS file, replay every word byte-for-byte from the
// published integers — no LLM, no Math.random, no wall clock, no trust in the operator.
//
// WHAT IT DELIBERATELY DOES NOT DO (the production red lines — this is a PURE READ-OUT membrane, ⑬⑭/ethogram
// kin, on its OWN /poem hash chain):
//   • It adds NO neuron, NO sensory channel and NO decoder change, so manifestHash NEVER rotates (no gas
//     re-anchor of NeuralManifestRegistry). It reads the FlyReading the coordinator already decoded.
//   • It writes NO ChronicleKind, so chroniclerRulesHash NEVER rotates ⇒ no frontend CHRON_ mirror, worker-only.
//   • It touches NO USDC, NO genome, NO settlement, and — unlike ① the neural feedback bus — it never writes
//     BACK into the connectome. It only READS. A poem cannot move a fly or a coin.
//   • It is PURE + DETERMINISTIC + BOUNDED: the same published integers + the same grammar always yield the
//     same poem; only the last POEMS_CAP poems are kept (a ring, like PROOFS_CAP); best-effort so a throw can
//     never block the live tick; a cold cron with no historian / no live fly simply skips.
//
// THE THREE-LEVEL VERIFICATION (see /poem/verify):
//   1. Receipt self-consistency — recompute poemReceiptHash(entry) and compare to entry.hash.
//   2. Grammar determinism — re-run compose(entry.neuralInts, entry.era, entry.chain, entry.laureate) with the
//      PUBLIC grammar below and compare to entry.text byte-for-byte. THIS is the core "neurons wrote it" proof:
//      every word is a published neural integer modulo a published lexicon length.
//   3. Neural authenticity — entry.neural.fingerprint is the hash of that fly's motor output, and its connectome
//      is structurally rebuildable from the committed manifest seed (/manifest/replay), the SAME trust model as
//      a live trade's decisionHash.
// HONEST BOUNDARY: the LIF connectome is stateful, so no one can re-simulate the exact runtime membrane
// potentials from the seed alone; we claim the strength of a trade receipt, NOT a full runtime replay.

import { canonical, sha256Hex, neuralEvidence, type NeuralEvidence } from "./provenance.js";
// TYPE-ONLY imports (erased at runtime, so this module keeps ZERO runtime dependency on the chronicler /
// population and stays a pure, isolated unit — the socialStimulus.ts discipline). Binding SocShock to the
// historian's own ShockKind means the two unions can never silently diverge.
import type { ShockKind } from "./chronicler.js";
import type { FlyReading } from "./population.js";

/** Bump when the poem receipt schema changes (invalidates old hashes' comparability, not their validity). */
export const POET_VERSION = 1;
/** Mixed into every receipt + the grammar hash so a reader can tell which poet policy produced a poem. */
export const POET_POLICY = "poet-v1";

/** The historian's civilizational phase (eraInfo().civPhase). */
export type CivPhase = "golden" | "dark" | "ascendant" | "declining";
/** The shock that forced the current era (eraInfo().eraShock); null ⇒ a calm, regime-driven age. */
export type SocShock = ShockKind | null;
/** The market regime the poet reads (== market.ts Regime; inlined to keep this module dependency-free). */
export type PoemRegime = "HOT" | "CALM" | "COLD";

/** The twelve semantic domains of the imagist lexicon — a FIXED order (weighted picks walk it deterministically). */
export type Domain =
  | "LIGHT" | "DARK" | "ROT" | "COLD" | "GOLD" | "HUNGER"
  | "KIN" | "ASH" | "SONG" | "YOKE" | "WATER" | "STONE";

/** The fixed domain order every weighted pick walks (part of the grammar hash). */
export const DOMAINS: Domain[] = [
  "LIGHT", "DARK", "ROT", "COLD", "GOLD", "HUNGER",
  "KIN", "ASH", "SONG", "YOKE", "WATER", "STONE",
];

/**
 * THE LEXICON — the poet's whole vocabulary, a public const. Each domain holds article-free, mass-noun-safe
 * English image words so any frame below reads as coherent Imagism whatever fills it. 12 domains × 12 words.
 * This object is hashed into poetGrammarHash(), so adding/removing/retuning a word visibly rotates the grammar.
 */
export const LEXICON: Record<Domain, string[]> = {
  LIGHT:   ["dawn", "glint", "noon", "lamp", "flare", "gleam", "sun", "candle", "halo", "flash", "sheen", "beam"],
  DARK:    ["dusk", "shadow", "night", "black", "void", "eclipse", "murk", "shade", "midnight", "dim", "gloom", "blind"],
  ROT:     ["rot", "rust", "maggot", "blight", "mould", "decay", "canker", "mildew", "spoil", "festering", "taint", "lees"],
  COLD:    ["cold", "frost", "ice", "rime", "snow", "chill", "winter", "hail", "glacier", "shiver", "numb", "sleet"],
  GOLD:    ["gold", "brass", "amber", "honey", "coin", "treasure", "gilt", "crown", "harvest", "wealth", "ore", "candlelight"],
  HUNGER:  ["hunger", "fasting", "gnaw", "emptiness", "want", "craving", "hollow", "thirst", "famine", "appetite", "scarcity", "need"],
  KIN:     ["kin", "brother", "sister", "mother", "father", "child", "swarm", "nest", "brood", "lineage", "house", "blood"],
  ASH:     ["ash", "cinder", "smoke", "ember", "soot", "dust", "char", "remains", "urn", "smoulder", "bone", "grey"],
  SONG:    ["song", "hum", "chirp", "drone", "buzz", "melody", "chorus", "chant", "carol", "refrain", "wingsong", "ring"],
  YOKE:    ["yoke", "chain", "collar", "tax", "tithe", "debt", "bond", "burden", "ledger", "shackle", "tether", "brand"],
  WATER:   ["water", "river", "rain", "flood", "well", "tide", "dew", "stream", "marsh", "pool", "brine", "current"],
  STONE:   ["stone", "rock", "marble", "wall", "flint", "grave", "slab", "column", "pebble", "quarry", "monolith", "crag"],
};

type DomainWeights = Partial<Record<Domain, number>>;

/**
 * ERA_DOMAIN — the age's palette. civPhase sets the base weights, eraShock overlays its defining event. A
 * domain with weight 0 in BOTH is NEVER chosen, so a dark/plague age can never reach for gold or song (the
 * semantic-anchoring invariant). Hashed into poetGrammarHash().
 */
export const ERA_DOMAIN: { phase: Record<CivPhase, DomainWeights>; shock: Record<ShockKind, DomainWeights> } = {
  phase: {
    golden:    { GOLD: 3, SONG: 2, LIGHT: 3, WATER: 1, KIN: 1 },
    ascendant: { LIGHT: 2, SONG: 2, GOLD: 1, WATER: 2, KIN: 1, STONE: 1 },
    declining: { ASH: 2, COLD: 2, STONE: 2, DARK: 1, HUNGER: 1, YOKE: 1 },
    dark:      { DARK: 3, ASH: 3, COLD: 2, ROT: 2, STONE: 1, HUNGER: 1, WATER: 1 },
  },
  shock: {
    BOOM:          { GOLD: 3, SONG: 2, LIGHT: 2 },
    FAMINE:        { HUNGER: 4, ROT: 1, ASH: 1, COLD: 1 },
    PLAGERA:       { ROT: 4, ASH: 2, DARK: 1 },
    GREAT_HUDDLE:  { COLD: 3, KIN: 3, ASH: 1 },
    DYNASTIC:      { YOKE: 3, STONE: 3, GOLD: 1 },
  },
};

/**
 * GRAMMAR — the four-line skeleton. Each line position offers three fixed syntactic frames; compose picks one
 * per line by a published neural integer, then fills its two `{0}`/`{1}` image slots from era-weighted domains.
 * The frames are Imagist (bare juxtaposition, a single fixed verb in the closing line) so any lexicon words
 * read cleanly. Hashed into poetGrammarHash().
 */
export const GRAMMAR: [string[], string[], string[], string[]] = [
  ["{0} over the {1}", "{0} upon the {1}", "{0} across the {1}"],
  ["the {0} of the {1}", "the {0} in the {1}", "{0} beneath the {1}"],
  ["{0} without the {1}", "we keep the {0} and the {1}", "{0}, and the {1} waits"],
  ["the {0} remembers the {1}", "the {0} keeps the {1}", "the {0} dreams of the {1}"],
];

/** The on-chain reality folded into a poem (deltas since the last composition + the standing condition). */
export interface PoemChain {
  temperature: number;
  regime: PoemRegime;
  volumeUsdcDelta: number;
  settlementsDelta: number;
  deathsDelta: number;
  liveAgents: number;
  gini: number;
}

/** The eraInfo() subset the poet stores + reads (eraInfo() returns a structural superset, so it is assignable). */
export interface PoetEraInput {
  era: number;
  seq: number;
  eraName: string;
  eraRegime: PoemRegime;
  civPhase: CivPhase;
  civLevel: number;
  eraShock: SocShock;
  generation: number;
  headHash: string;
}

/** The crowned poet: a living fly, its house, and the era ordinal it was crowned in. */
export interface PoetLaureate {
  id: number;
  house: string | null;
  temperament: number;
  crownedEraSeq: number;
}

/** One poem + its full receipt: everything a verifier needs to recompute the hash and replay the text. */
export interface PoemEntry {
  v: number;
  policy: string;
  seq: number;                 // monotonic poem ordinal (1-based; survives ring truncation)
  prevHash: string;            // the previous poem's hash ("" for the genesis poem) → an independent chain
  hash: string;                // poemReceiptHash(entry minus hash)
  composedAtTick: number;      // the swarm tickIndex this poem was written at
  cron: number;                // the cron boundary (floor(tick / ticksPerCron))
  era: PoetEraInput;
  laureate: PoetLaureate;
  neural: NeuralEvidence;      // provenance.neuralEvidence(the laureate's FlyReading)
  neuralInts: number[];        // quantizeNeural(...) — compose's direct, published, deterministic input
  chain: PoemChain;
  grammarHash: string;         // poetGrammarHash() at composition time (a grammar change is visible)
  lines: [string, string, string, string];
  text: string;                // lines.join("\n")
}

/** Everything maybeCompose reads from the cron; the DO supplies it, so this module never touches storage/clock. */
export interface PoetContext {
  tick: number;
  cron: number;
  era: PoetEraInput;
  liveIds: number[];
  readingOf: (id: number) => FlyReading | null;
  houseOf: (id: number) => string | null;
  temperature: number;
  regime: PoemRegime;
  totals: { volumeUsdc: number; count: number; liveAgents: number; gini: number } | null;
  deathsDelta: number;
}

export interface PoetConfig {
  cap: number;        // POEMS_CAP: how many poems the ring keeps
  minCrons: number;   // POET_MIN_CRONS: the fallback cadence guaranteeing ≈ one poem per hour
}

/** The honest verification boundary, served verbatim in every /poem response (see the header comment). */
export const POET_HONESTY =
  "Each poem is a deterministic function of PUBLISHED inputs: the laureate's frozen neural read-out " +
  "(neuralInts + neural fingerprint) and the on-chain reality (era + chain), decoded through the PUBLIC grammar " +
  "in poet.ts. Recompute poemReceiptHash(entry) to confirm self-consistency; re-run compose(entry.neuralInts, " +
  "entry.era, entry.chain, entry.laureate) with the published grammar to confirm the text byte-for-byte " +
  "(replayMatch). No LLM, no Math.random, no wall clock. HONEST BOUNDARY: the LIF connectome is stateful, so a " +
  "verifier cannot re-simulate the exact runtime membrane potentials from the seed alone — the guarantee is the " +
  "SAME as a live trade's decisionHash (a published neural read-out + open auditable decoding + a connectome " +
  "structurally rebuildable from the committed manifest seed via /manifest/replay), NOT a full runtime replay. " +
  "grammarHash makes any lexicon/grammar change visible.";

// ---------- small dependency-free helpers (the socialStimulus.ts discipline: no runtime imports) ----------

function clamp01(x: number): number {
  return x < 0 ? 0 : x > 1 ? 1 : x;
}

/** Local clampInt (config.ts's is NaN-safe too, but importing it would pull viem into this pure module). */
function clampIntSafe(x: number, lo: number, hi: number): number {
  if (!Number.isFinite(x)) return lo;
  return Math.max(lo, Math.min(hi, Math.floor(x)));
}

/** Round to 6 decimals so a float survives a JSON round-trip into a stable hash input (mirrors provenance.r6). */
function round6(x: number): number {
  return Math.round((Number.isFinite(x) ? x : 0) * 1e6) / 1e6;
}

/** Quantize a normalized 0..1 scalar to a bounded 0..255 integer; any non-finite input collapses to 0. */
function q255(x: number): number {
  return Math.round(clamp01(Number.isFinite(x) ? x : 0) * 255);
}

/** Sync FNV-1a byte of a string — a deterministic 0..255 digest of the discrete behaviour (state|fap|role). */
function fnvByte(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h & 0xff;
}

/** Parse one hex char to its 0..15 nibble; anything unexpected collapses to 0 (never NaN). */
function hexNibble(ch: string): number {
  const n = parseInt(ch, 16);
  return Number.isFinite(n) && n >= 0 && n <= 15 ? n : 0;
}

// ---------- the public grammar hash ----------

/**
 * The digest of the whole public grammar (lexicon + era palette + line frames + version/policy). Anyone can
 * recompute it from THIS file and compare to a poem's stored grammarHash to confirm the decoding rules have not
 * changed since the poem was written. Selection thresholds (cap / minCrons) are deliberately NOT in the hash —
 * they cannot change a poem's text, exactly as chroniclerRulesHash excludes its detector thresholds.
 */
export async function poetGrammarHash(): Promise<string> {
  return sha256Hex({ v: POET_VERSION, policy: POET_POLICY, lexicon: LEXICON, eraDomain: ERA_DOMAIN, grammar: GRAMMAR });
}

// ---------- laureate selection ----------

/** sha256(seed) → its first 8 hex as a float in 0..1 (the deterministic draw used to crown a laureate). */
async function hash01(seed: string): Promise<number> {
  const hex = await sha256Hex(seed);
  return parseInt(hex.slice(0, 8), 16) / 0xffffffff;
}

/**
 * Crown the era's laureate: a pure, deterministic draw over the LIVING flies. The same (eraOrdinal, headHash,
 * liveIds) always crowns the same fly, so a verifier can re-derive WHO wrote a poem; a new era (or the sitting
 * laureate's death) crowns a successor. Returns null only when there is no one alive to crown.
 */
export async function selectLaureate(eraOrdinal: number, headHash: string, liveIds: number[]): Promise<number | null> {
  if (!Array.isArray(liveIds) || liveIds.length === 0) return null;
  const ids = [...liveIds].sort((a, b) => a - b);
  const h = await hash01("laureate|" + eraOrdinal + "|" + headHash);
  return ids[Math.floor(h * ids.length) % ids.length];
}

// ---------- neural quantization ----------

const TAU = Math.PI * 2;

/**
 * Freeze a fly's live neural read-out into a bounded integer vector — the poet's INK, and compose's only neural
 * input. Ten quantized scalars (the eight decoded drives + the historian's civLevel + a discrete behaviour
 * digest) followed by the first sixteen nibbles of the neural fingerprint. Pure + sync + NaN-safe (every field
 * collapses to 0 rather than leaking NaN), so it is byte-identical on every engine and safe to publish + replay.
 */
export function quantizeNeural(reading: FlyReading, civLevel: number): number[] {
  const ints: number[] = [
    q255(reading.arousal),                 // 0..1
    q255((reading.valence + 1) / 2),       // −1..1 → 0..1
    q255(reading.cohesion),                // 0..1
    q255(reading.wingbeat),                // 0..1
    q255(reading.rest),                    // 0..1
    q255((reading.turnBias + 1) / 2),      // −1..1 → 0..1
    q255(reading.heading / TAU),           // 0..2π → 0..1
    q255(reading.temperament),             // 0..1
    q255((Number.isFinite(civLevel) ? civLevel : 0) / 100), // 0..100 → 0..1
    fnvByte(`${reading.state}|${reading.fap}|${reading.role}`), // the discrete behaviour, 0..255
  ];
  const fp = typeof reading.fingerprint === "string" ? reading.fingerprint : "";
  for (let i = 0; i < 16; i++) ints.push(hexNibble(fp[i] ?? "0")); // the neural fingerprint's first 16 nibbles
  return ints;
}

// ---------- composition (the pure, offline-replayable heart) ----------

/** The era's effective domain weights: phase base + shock overlay + chain nudges that only touch admitted domains. */
function domainWeights(era: PoetEraInput, chain: PoemChain | null): Record<Domain, number> {
  const w = {} as Record<Domain, number>;
  for (const d of DOMAINS) w[d] = 0;
  const phase = ERA_DOMAIN.phase[era.civPhase] ?? {};
  const shock = era.eraShock ? ERA_DOMAIN.shock[era.eraShock] ?? {} : {};
  for (const d of DOMAINS) w[d] = (phase[d] ?? 0) + (shock[d] ?? 0);
  // Chain nudges modulate the palette but ONLY on domains the era already admits (weight > 0), so a dark age can
  // never gain gold/song/light from a hot market — the semantic anchoring holds regardless of on-chain weather.
  if (chain) {
    const nudge = (d: Domain, amt: number) => { if (w[d] > 0) w[d] += amt; };
    if (chain.regime === "COLD") nudge("COLD", 2);
    if (chain.regime === "HOT") { nudge("GOLD", 1); nudge("LIGHT", 1); }
    if (chain.gini >= 0.6) nudge("YOKE", 2);
    if (chain.deathsDelta > 0) { nudge("ROT", 1 + Math.min(3, Math.trunc(chain.deathsDelta))); nudge("ASH", 1); }
    if (chain.volumeUsdcDelta > 0) nudge("WATER", 1);
  }
  let total = 0;
  for (const d of DOMAINS) total += Math.max(0, w[d]);
  if (total <= 0) w[era.civPhase === "dark" ? "DARK" : "STONE"] = 1; // never an empty palette
  return w;
}

/** Pick a domain by weight using a published neural integer as the draw (a pure modulo over the cumulative weights). */
function weightedPick(w: Record<Domain, number>, r: number): Domain {
  let total = 0;
  for (const d of DOMAINS) total += Math.max(0, w[d]);
  if (total <= 0) return DOMAINS[0];
  let x = ((r % total) + total) % total;
  for (const d of DOMAINS) {
    const wt = Math.max(0, w[d]);
    if (x < wt) return d;
    x -= wt;
  }
  return DOMAINS[DOMAINS.length - 1];
}

/**
 * Compose the quatrain — a PURE function of (neuralInts, era, chain, laureate). Given the published integers and
 * this file's public grammar the output is unique, so anyone can replay a poem offline and compare byte-for-byte.
 * Each line: a published integer picks the frame variant (nudged by the laureate's id so two poets with identical
 * drives still open differently), then two more integers pick each slot's era-weighted domain and the word within
 * it (integer modulo the public lexicon length). No RNG, no clock, no I/O.
 */
export function compose(
  neuralInts: number[],
  era: PoetEraInput,
  chain: PoemChain | null,
  laureate: { id: number } | null,
): { lines: [string, string, string, string]; text: string } {
  const ints = Array.isArray(neuralInts) && neuralInts.length ? neuralInts : [0];
  const ni = (k: number): number => {
    const v = ints[((k % ints.length) + ints.length) % ints.length];
    return Number.isFinite(v) ? Math.abs(Math.trunc(v)) : 0;
  };
  const poetSeed = laureate && Number.isFinite(laureate.id) ? Math.abs(Math.trunc(laureate.id)) : 0;
  const w = domainWeights(era, chain);
  const lines: string[] = [];
  for (let i = 0; i < 4; i++) {
    const variants = GRAMMAR[i];
    const frame = variants[(ni(i * 5 + 0) + poetSeed) % variants.length];
    const d0 = weightedPick(w, ni(i * 5 + 1));
    const word0 = LEXICON[d0][ni(i * 5 + 2) % LEXICON[d0].length];
    const d1 = weightedPick(w, ni(i * 5 + 3));
    const word1 = LEXICON[d1][ni(i * 5 + 4) % LEXICON[d1].length];
    const line = frame.replace("{0}", () => word0).replace("{1}", () => word1);
    lines.push(line.charAt(0).toUpperCase() + line.slice(1));
  }
  return { lines: lines as [string, string, string, string], text: lines.join("\n") };
}

// ---------- the receipt hash + its replay ----------

/** Hash a poem receipt (the entry WITHOUT its hash field) — sha256Hex canonicalizes, so field order is irrelevant. */
export async function poemReceiptHash(entry: Omit<PoemEntry, "hash">): Promise<string> {
  return sha256Hex(entry);
}

/** Recompute a stored poem's hash from its own bytes (strip `hash`, re-hash) — the self-consistency check. */
export async function recomputePoemHash(entry: PoemEntry): Promise<string> {
  const { hash: _hash, ...rest } = entry;
  return sha256Hex(rest);
}

/**
 * Re-run compose() on a stored poem's OWN published inputs with the CURRENT grammar. `match` is true only when
 * the replayed text equals the stored text byte-for-byte — false means the grammar changed since composition
 * (compare grammarHash) or the entry was tampered with. Pure + sync, so a browser can do this with no server.
 */
export function replayCompose(entry: PoemEntry): { text: string; match: boolean } {
  const { lines: _lines, text } = compose(entry.neuralInts, entry.era, entry.chain, entry.laureate);
  return { text, match: text === entry.text };
}

// ---------- the poet: an independent, bounded, persisted hash chain ----------

/**
 * The Laureate — maintains its OWN poem hash chain (seq/prevHash/hash), completely independent of the chronicle,
 * so it can never rotate the genome or the historian's rules. Bounded to a ring of the last `cap` poems (like
 * PROOFS_CAP); the monotonic headSeq survives truncation. serialize()/restore() persist it under KEY_POET; a
 * corrupt blob restores an EMPTY chain (poems are forgotten, the ledger is untouched), so the poet can never
 * poison any other layer's state.
 */
export class Poet {
  private entries: PoemEntry[] = [];                       // ascending by seq, capped at cfg.cap
  private _headSeq = 0;                                    // monotonic poem ordinal (survives ring truncation)
  private _lastComposedCron = -1;                          // cron boundary of the last poem (−1 ⇒ never)
  private _lastCrownedEra: number | null = null;           // era ordinal the sitting laureate was crowned in
  private _laureate: { id: number; house: string | null; crownedEraSeq: number } | null = null;
  private _lastTotals: { volumeUsdc: number; count: number } | null = null;
  private cfg: PoetConfig;

  constructor(cfg: PoetConfig) {
    // Defence-in-depth: config.ts already NaN-guards these; clamp again so a bad restore can't unbound the ring.
    this.cfg = {
      cap: clampIntSafe(cfg?.cap ?? 64, 1, 512),
      minCrons: clampIntSafe(cfg?.minCrons ?? 60, 1, 100000),
    };
  }

  get headSeq(): number { return this._headSeq; }
  get chainHead(): string { return this.entries.length ? this.entries[this.entries.length - 1].hash : ""; }
  get lastComposedCron(): number { return this._lastComposedCron; }
  get size(): number { return this.entries.length; }

  /** The sitting laureate (id + house + the era it was crowned in), or null before the first coronation. */
  currentLaureate(): { id: number; house: string | null; crownedEraSeq: number } | null { return this._laureate; }

  latest(): PoemEntry | null { return this.entries.length ? this.entries[this.entries.length - 1] : null; }
  get(seq: number): PoemEntry | null { return this.entries.find((e) => e.seq === seq) ?? null; }
  recent(n: number): PoemEntry[] {
    const k = clampIntSafe(n, 0, this.entries.length);
    return k > 0 ? this.entries.slice(this.entries.length - k) : [];
  }

  serialize(): string {
    return JSON.stringify({
      v: POET_VERSION,
      policy: POET_POLICY,
      headSeq: this._headSeq,
      lastComposedCron: this._lastComposedCron,
      lastCrownedEra: this._lastCrownedEra,
      laureate: this._laureate,
      lastTotals: this._lastTotals,
      entries: this.entries,
    });
  }

  restore(raw: string | null | undefined): void {
    if (!raw) return;
    try {
      const s = JSON.parse(raw);
      if (Array.isArray(s.entries)) this.entries = s.entries.slice(-this.cfg.cap);
      this._headSeq = Number.isFinite(s.headSeq) ? s.headSeq : (this.entries.at(-1)?.seq ?? 0);
      this._lastComposedCron = Number.isFinite(s.lastComposedCron) ? s.lastComposedCron : -1;
      this._lastCrownedEra = Number.isFinite(s.lastCrownedEra) ? s.lastCrownedEra : null;
      this._laureate = s.laureate && Number.isFinite(s.laureate.id) ? s.laureate : null;
      this._lastTotals = s.lastTotals ?? null;
    } catch {
      // A corrupt blob restores an EMPTY chain: poems are a read-out, never ledger state, so forget them safely.
      this.entries = [];
      this._headSeq = 0;
      this._lastComposedCron = -1;
      this._lastCrownedEra = null;
      this._laureate = null;
      this._lastTotals = null;
    }
  }

  /**
   * Write a poem IF this cron is due: the era advanced (⇒ crown a new laureate) OR at least `minCrons` have
   * passed since the last poem (the ≈hourly fallback). Also re-crowns if the sitting laureate has died. Best
   * effort by contract — the caller wraps it in try/catch; here we simply return null on any missing input
   * (no live fly, no reading) so a cold or thinned cron skips gracefully instead of throwing.
   */
  async maybeCompose(ctx: PoetContext): Promise<PoemEntry | null> {
    if (!ctx || !Array.isArray(ctx.liveIds) || ctx.liveIds.length === 0) return null;

    const eraAdvanced = this._lastCrownedEra == null || ctx.era.era !== this._lastCrownedEra;
    const dueByCadence = this._lastComposedCron < 0 || (ctx.cron - this._lastComposedCron) >= this.cfg.minCrons;
    if (!eraAdvanced && !dueByCadence) return null;

    // (Re)crown on a new era, or when the sitting laureate is gone from the living roster (a successor steps up).
    let laureate = this._laureate;
    const sitting = laureate != null && ctx.liveIds.includes(laureate.id);
    if (eraAdvanced || !sitting) {
      const id = await selectLaureate(ctx.era.era, ctx.era.headHash, ctx.liveIds);
      if (id == null) return null;
      laureate = { id, house: ctx.houseOf(id), crownedEraSeq: ctx.era.era };
      this._laureate = laureate;
      this._lastCrownedEra = ctx.era.era;
    }
    if (!laureate) return null; // unreachable in practice (sitting ⇒ non-null); narrows the type for the rest

    const reading = ctx.readingOf(laureate.id);
    if (!reading) return null; // no neural ink this cron — skip; the ambient resumes next tick

    const neuralInts = quantizeNeural(reading, ctx.era.civLevel);
    const chain: PoemChain = {
      temperature: round6(ctx.temperature),
      regime: ctx.regime,
      volumeUsdcDelta: ctx.totals ? round6(ctx.totals.volumeUsdc - (this._lastTotals?.volumeUsdc ?? ctx.totals.volumeUsdc)) : 0,
      settlementsDelta: ctx.totals ? (ctx.totals.count - (this._lastTotals?.count ?? ctx.totals.count)) : 0,
      deathsDelta: Number.isFinite(ctx.deathsDelta) ? Math.max(0, Math.trunc(ctx.deathsDelta)) : 0,
      liveAgents: ctx.totals?.liveAgents ?? 0,
      gini: round6(ctx.totals?.gini ?? 0),
    };
    const composed = compose(neuralInts, ctx.era, chain, { id: laureate.id });
    const grammarHash = await poetGrammarHash();

    const base: Omit<PoemEntry, "hash"> = {
      v: POET_VERSION,
      policy: POET_POLICY,
      seq: this._headSeq + 1,
      prevHash: this.entries.length ? this.entries[this.entries.length - 1].hash : "",
      composedAtTick: ctx.tick,
      cron: ctx.cron,
      era: {
        era: ctx.era.era, seq: ctx.era.seq, eraName: ctx.era.eraName, eraRegime: ctx.era.eraRegime,
        civPhase: ctx.era.civPhase, civLevel: ctx.era.civLevel, eraShock: ctx.era.eraShock,
        generation: ctx.era.generation, headHash: ctx.era.headHash,
      },
      laureate: { id: laureate.id, house: laureate.house, temperament: round6(reading.temperament), crownedEraSeq: laureate.crownedEraSeq },
      neural: neuralEvidence(reading),
      neuralInts,
      chain,
      grammarHash,
      lines: composed.lines,
      text: composed.text,
    };
    const entry: PoemEntry = { ...base, hash: await poemReceiptHash(base) };

    this.entries.push(entry);
    if (this.entries.length > this.cfg.cap) this.entries.splice(0, this.entries.length - this.cfg.cap);
    this._headSeq = entry.seq;
    this._lastComposedCron = ctx.cron;
    if (ctx.totals) this._lastTotals = { volumeUsdc: ctx.totals.volumeUsdc, count: ctx.totals.count };
    return entry;
  }
}

// canonical is re-exported so a verifier can rebuild the exact bytes poemReceiptHash digests without importing
// provenance directly (kept as a value export; tree-shakers drop it if unused).
export { canonical };
