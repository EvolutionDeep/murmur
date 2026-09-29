/**
 * ㉜ EMERGENT CONVENTIONS — the customs no contract wrote (packages/trader-worker/src/conventions.ts).
 *
 * ㉛'s norms cluster the WHOLE bond graph and mint a society-wide rule. This layer works one relationship at
 * a time: it watches each PAIR of agents and, when a pair keeps trading the same way for long enough — a steady
 * frequency at a low variance, with no betrayal in the bond — the repeated pattern CRYSTALLIZES into a
 * convention {pair, good, priceRange, freq, strength}. A convention can SPREAD to a neighbouring relationship,
 * be INHERITED by a new pair (lineage depth, double-guarded so a reused slot id never auto-duplicates), be
 * BREACHED (a sharp collapse in the bond scores a bounded 1.5× penalty — a Channel-A threat, never money),
 * DECAY under a TTL and hysteresis floor, and at last DIE. When a convention spreads wide and holds stable it
 * is offered UP to the norms membrane, which may ABSORB it into a society-wide norm (the two emergent layers
 * compose). Structure emerges from repeated interaction; nobody drafted it.
 *
 * THE FIVE IRON RULES (identical in spirit to ㉛'s and ㉔'s):
 *   1. PURE READ-OUT + ONE BOUNDED CAUSAL LEG. The drive only ever READS the economy's public bond read-out
 *      (economy.socialReadout().bonds — {a,b,score,trades}); it never writes a connectome, a genome, a
 *      fingerprint, a manifest hash, a price, a purse, a cap or a settlement. Its ONE causal leg is a
 *      swarm-wide Channel-A stimulus (food/threat/light) hard-capped at cfg.maxIntensity ≤ 0.3, plus the
 *      breach penalty which is min(BREACH_BASE × 1.5, cap) — the 1.5× can NEVER exceed the bounded ceiling.
 *      No money ever moves here; no economic multiplier, no real-spend cap, no x402 path is touched.
 *   2. BOUNDED BY CONSTRUCTION. At most CONV_CAP (24) live conventions; each keeps ≤ ADOPTER_CAP adopting
 *      pairs; the pair tracker is pruned and capped; the descriptor is a few numbers. The blob can never
 *      outgrow its budget (and shares the 200KB DO guard with ㉛'s norms — see conventions.test.ts).
 *   3. DETERMINISM. No Math.random, no Date.now, no LLM, no transcendental function. Pair tracking, the
 *      variance gate, crystallisation, spread, inheritance, breach and absorption are all FNV-1a hash01/hash32
 *      draws over (tick, pairSig, private salts) — replayable byte-for-byte from the same inputs.
 *   4. ONE-WAY LAW. The stimulus leg injects current through the EXISTING four channels only; it adds no
 *      sensory channel (manifestHash never rotates) and never writes back into synWeight or topology.
 *   5. HONEST PENDING (the #92 contract). pending is NEVER persisted and NEVER folded into stateDigest;
 *      restore() rebuilds the STANDING read-out at its tail via refreshPending(), and the /economy read-out
 *      calls refreshPending() before signals(), so a DO eviction can never serve a zeroed drawer.
 *
 * CONVENTIONS_ENABLED=false ⇒ state.ts never constructs the membrane (ensureConventions returns null), folds
 * no `conventions` key into the historian's context, appends no stimulus, never calls round() and never offers
 * an absorption to norms ⇒ the five CONVENTION_* kinds can never speak and every byte is the pre-Conventions build.
 */

import type { StimulusEvent } from "@fly/fly-brain";
import { OnceGuard, STIMULUS_HARD_CAP } from "./onceGuard.js";

export const CONVENTIONS_VERSION = 1;

// ─── bounded, deterministic constants (the calibration is FROZEN IN CODE — wrangler.toml [vars] is spent) ──

/** Hard ceiling of live conventions the membrane may ever hold (the storage + read-out bound). */
export const CONV_CAP = 24;
/** Adopting pairs one convention keeps (its spread's bounded membership). */
export const ADOPTER_CAP = 12;
/** Cumulative trades a pair must have settled before it can crystallise a convention at all. */
export const MIN_TRADES = 2;
/** Mean per-cron trade frequency a pair must sustain (≈ a trade every 3 crons) to count as "repeated". */
export const MIN_FREQ = 0.34;
/** Consecutive stable crons a pair must hold before its pattern crystallises (the anti-flicker gate). */
export const CRYSTAL_STABLE_RUN = 4;
/** Normalised variance ceiling on the pair's trade cadence — above it the pattern is too erratic to harden. */
export const VARIANCE_MAX = 0.35;
/** Crons a pair must wait after crystallising before it may crystallise again. */
export const CRYSTAL_COOLDOWN = 48;
/** Strength a freshly crystallised convention starts at — deliberately ABOVE the death floor (hysteresis). */
export const CRYSTAL_STRENGTH = 0.55;
/** Strength at or below which a convention dies (the hysteresis floor: CRYSTAL > DIE ⇒ no flicker). */
export const DIE_STRENGTH = 0.1;
/** Per-cron strength decay every convention pays (an unkept custom fades on its own). */
export const DECAY = 0.01;
/** Crons a convention survives with no honoured adherence before the TTL reaps it. */
export const TTL = 72;
/** Strength a convention GAINS when its pair honoured it this cron (compliance reinforces). */
export const COMPLIANCE_GAIN = 0.02;
/** A drop in the bond score larger than this (a betrayal / a stiffed deal) counts as a breach. */
export const BREACH_DROP = 0.5;
/** Strength a convention LOSES when it is breached (bounded; a breach badly damages but rarely kills outright). */
export const BREACH_STRENGTH_DROP = 0.25;
/** THE 1.5× BREACH PENALTY MULTIPLIER — applied to BREACH_BASE, then HARD-CLAMPED to cfg.maxIntensity, so the
 *  penalty can never exceed the bounded Channel-A ceiling (≤ 0.3). It is a neural/social threat, never money. */
export const BREACH_PENALTY = 1.5;
/** Base breach intensity before the 1.5× multiplier (0.2 × 1.5 = 0.3, i.e. exactly the ceiling at cap 0.3). */
export const BREACH_BASE = 0.2;
/** Spread probability scale: p = clamp(|bond| · strength · SPREAD_GAIN, 0, SPREAD_CAP). */
export const SPREAD_GAIN = 1.1;
/** Hard ceiling on any one adoption draw (a convention can never jump the whole swarm in a cron). */
export const SPREAD_CAP = 0.55;
/** Probability a spread event becomes an INHERITED child convention instead of a plain adoption. */
export const INHERIT_P = 0.22;
/** Lineage depth cap — the double-guard that stops an inheritance chain from growing without bound. */
export const MAX_DEPTH = 4;
/** Bonds weaker than this (|score|) carry no spread (the same floor ㉛ uses). */
export const BOND_MIN = 0.05;
/** Consecutive crons a pair may go unseen before the tracker forgets it (bounded pair map). */
export const PAIR_MISS = 3;
/** Pair-tracker entries kept in the serialized blob (pruned by run, descending). */
export const PAIR_TRACK_CAP = 96;
/** Strength at/above which a convention becomes a norm-absorption candidate. */
export const ABSORB_STRENGTH = 0.7;
/** Consecutive honoured crons a convention must hold ≥ ABSORB_STRENGTH before it is offered up to norms. */
export const ABSORB_RUN = 5;
/** Crons a convention waits after one absorption offer before it may offer again. */
export const ABSORB_COOLDOWN = 120;
/** OnceGuard capacity for the inheritance storm fix — generous enough to cover CONV_CAP × pairs within a TTL window. */
export const INHERIT_GUARD_CAP = 256;
/** The four tradeable goods — the descriptor's good axis (mirrors economy.ts GOOD_IDX order). */
export const GOOD_COUNT = 4;
export const GOOD_NAMES = ["signal", "momentum", "attestation", "prediction"] as const;

/** Private salts (duplicated by design, like every layer's — a conventions draw can alias no other layer's). */
const PAIRSIG_SALT = 0x51c7;   // the pair signature fold
const GOOD_SALT = 0x3aa1;      // which good the descriptor names
const PRICELO_SALT = 0x6e2b;   // the price band's lower edge
const PRICEHI_SALT = 0x17d4;   // the price band's width
const SPREAD_SALT = 0x4b8f;    // hash-gated adoption onto a neighbouring pair
const INHERIT_SALT = 0x2c9e;   // whether an adoption becomes an inherited child
const ABSORBSEED_SALT = 0x7f31;// the seed a promoted convention hands to norms
const SIG_SALT = 0x0d6a;       // (reserved) descriptor fold

// ─── descriptor + record types ────────────────────────────────────────────────────────────────────────────

/** One directed bond of the graph the membrane watches (a pure read of economy.socialReadout().bonds). */
export interface ConvBond { a: number; b: number; score: number; trades: number; }

/** The facts state.ts folds in each cron — all pure read-outs, all bounded. */
export interface ConventionsFacts {
  tick: number;
  era: number;
  bonds: ConvBond[];
  ids: number[];
}

export interface ConventionsConfig {
  enabled: boolean;
  /** Hard ceiling (and master scale) on the causal leg's stimulus intensity, 0..0.3 (config.ts clamps it). */
  maxIntensity: number;
}

/** One emergent convention, as the ledger keeps it. */
export interface Convention {
  id: number;
  a: number;                 // founding pair, lower id
  b: number;                 // founding pair, higher id
  pairSig: number;           // hash32 of the founding pair
  good: number;              // 0..GOOD_COUNT-1 — the descriptor's good axis (derived, see deriveDescriptor)
  priceLo: number;           // 0..1 price-band lower edge (derived)
  priceHi: number;           // 0..1 price-band upper edge (derived)
  freq: number;              // observed quantised trade cadence at crystallisation
  strength: number;          // 0..1
  depth: number;             // lineage depth (0 = crystallised from a pair, +1 per inheritance)
  parentId: number | null;   // the convention this one was inherited from
  adopters: number[];        // pairSigs of neighbouring pairs that adopted it (≤ ADOPTER_CAP)
  bornTick: number;
  lastTick: number;          // last cron the pair honoured it (the TTL clock)
  lastScore: number;         // last observed bond score of the founding pair (the breach baseline)
  holdRun: number;           // consecutive honoured crons held ≥ ABSORB_STRENGTH (the absorption gate)
  lastAbsorb: number;        // tick of the last absorption offer (the offer cooldown)
  breaches: number;          // lifetime breaches
  inherited: number;         // child conventions spun off
}

/** One convention as the public drawer sees it (a bounded projection, never the internal record). */
export interface ConvView {
  id: number; conv: string; good: string; freq: number; priceLo: number; priceHi: number;
  strength: number; depth: number; parentId: number | null; adopters: number; breaches: number; inherited: number;
}

/** The seed handed to NormsMembrane.absorb() when a convention is offered up (state.ts mediates the call). */
export interface PromoteSeed { sig: number; strength: number; label: string; era: number; }

/** The chronicle-facing edges of ONE cron + the standing read-out. */
export interface ConventionsSignals {
  crystallized: { conv: string; good: string; freq: number; strength: number; era: number } | null;
  spread: { conv: string; pairs: number; strength: number } | null;
  inherited: { conv: string; depth: number; parent: number; strength: number } | null;
  breached: { conv: string; penalty: number; strength: number } | null;
  died: { conv: string; lived: number; strength: number } | null;
  conventions: ConvView[];
  counts: { crystallized: number; spread: number; inherited: number; breached: number; died: number; absorbed: number };
  lineageDepth: number;
  breachRate: number;
  concordance: number;       // 0..1 aggregate honoured-strength share (drives the causal leg)
  promote: PromoteSeed | null;   // this cron's absorption candidate (state.ts feeds it to norms)
}

// ─── small pure helpers ──────────────────────────────────────────────────────────────────────────────────

function clamp(x: number, lo: number, hi: number): number { return x < lo ? lo : x > hi ? hi : x; }
function clamp01(x: number): number { return x < 0 ? 0 : x > 1 ? 1 : x; }
function r2(x: number): number { return Math.round(x * 100) / 100; }

/** The canonical unordered pair key (lo~hi) — a stable tracker map key. */
function pairKey(a: number, b: number): string {
  const lo = Math.min(a, b), hi = Math.max(a, b);
  return `${lo}~${hi}`;
}

/** A stable 32-bit signature over an unordered pair (the descriptor + absorption seed). */
export function pairSigOf(a: number, b: number): number {
  const lo = Math.min(a, b) >>> 0, hi = Math.max(a, b) >>> 0;
  return hash32(lo, hi, PAIRSIG_SALT) >>> 0;
}

/**
 * Derive the convention's DESCRIPTOR — its good and its price band — from the pair signature + the tick. The
 * bounded social read-out exposes a pair's frequency and trust but NOT which good or price it traded, so the
 * membrane NAMES the stable band deterministically from the pair's own signature: an OPEN combinatorial
 * descriptor space (4 goods × quantised price bands), never a hand-assigned label per pair. freq is observed.
 */
export function deriveDescriptor(sig: number, tick: number): { good: number; priceLo: number; priceHi: number } {
  const good = Math.floor(hash01(sig, tick, GOOD_SALT) * GOOD_COUNT) % GOOD_COUNT;
  const priceLo = Math.round(hash01(sig, tick + 1, PRICELO_SALT) * 18) / 20;          // 0..0.90 in 0.05 steps
  const width = 0.05 + Math.round(hash01(sig, tick + 2, PRICEHI_SALT) * 6) / 20;      // 0.05..0.20
  const priceHi = clamp(r2(priceLo + width), 0, 1);
  return { good, priceLo: r2(priceLo), priceHi };
}

/** A short, byte-stable ASCII label for a convention (the {conv} token both sides re-derive). */
export function convLabel(c: { good: number; priceLo: number; priceHi: number; freq: number; a: number; b: number }): string {
  const g = GOOD_NAMES[c.good] ?? "?";
  return `${g}[${c.priceLo.toFixed(2)}-${c.priceHi.toFixed(2)}]f${c.freq}(${c.a}~${c.b})`;
}

// ─── the membrane ──────────────────────────────────────────────────────────────────────────────────────────

interface PairTrack {
  run: number; miss: number;
  lastTrades: number; lastScore: number;
  mean: number; m2: number; n: number;    // Welford's online variance of the per-cron trade delta
  lastCrystal: number;
  a: number; b: number;
}

export class ConventionsMembrane {
  private convs = new Map<number, Convention>();
  private pairs = new Map<string, PairTrack>();
  private nextId = 1;
  private counts = { crystallized: 0, spread: 0, inherited: 0, breached: 0, died: 0, absorbed: 0 };
  private concordance = 0;
  private breachThisCron = false;
  /** H4 fix: "already inherited" memory — prevents the same (conv, pairSig) from spawning a child every cron. */
  private inheritedPairs = new OnceGuard(INHERIT_GUARD_CAP);
  private pending: ConventionsSignals = {
    crystallized: null, spread: null, inherited: null, breached: null, died: null,
    conventions: [], counts: { ...this.counts }, lineageDepth: 0, breachRate: 0, concordance: 0, promote: null,
  };

  constructor(private readonly cfg: ConventionsConfig) {}

  /** One round per cron, alongside driveNorms and BEFORE observeChronicle — pure read-out end to end. */
  round(facts: ConventionsFacts): void {
    if (!this.cfg.enabled) return;
    // Reset THIS cron's edges; keep the standing fields (refreshPending() rebuilds them at the tail).
    this.pending = {
      crystallized: null, spread: null, inherited: null, breached: null, died: null,
      conventions: this.view(), counts: { ...this.counts },
      lineageDepth: this.maxDepth(), breachRate: this.breachRate(), concordance: this.concordance, promote: null,
    };
    this.breachThisCron = false;
    const tick = Math.max(0, Math.floor(Number.isFinite(facts.tick) ? facts.tick : 0));
    const era = Math.floor(Number.isFinite(facts.era) ? facts.era : 0);

    // 1) watch each pair: a steady, low-variance, repeated pattern hardens into a convention.
    this.trackPairs(facts.bonds, tick, era);
    // 2) breach: a founding pair whose bond collapsed this cron violates the custom (a bounded 1.5× penalty).
    this.detectBreaches(facts.bonds, tick);
    // 3) spread + inherit: a convention reaches neighbouring pairs along real bonds (hash-gated, depth-capped).
    this.spread(facts.bonds, tick);
    // 4) concordance: a convention whose pair honoured it this cron reinforces; the aggregate share is the climate.
    this.evaluate(facts.bonds, tick);
    // 5) decay + TTL + hysteresis: every convention pays the decay; the unkept and the old die.
    this.decay(tick);
    // 6) offer the widest, steadiest convention up to the norms membrane for absorption.
    this.offerAbsorb(tick, era);

    // Read-out closes on the END-of-round truth.
    this.refreshPending();
  }

  private trackPairs(bonds: ConvBond[], tick: number, era: number): void {
    const seen = new Set<string>();
    const rows = bonds
      .filter((b) => Number.isFinite(b.a) && Number.isFinite(b.b) && b.a !== b.b)
      .map((b) => ({ a: Math.floor(b.a), b: Math.floor(b.b), score: Number.isFinite(b.score) ? b.score : 0, trades: Number.isFinite(b.trades) ? Math.max(0, Math.floor(b.trades)) : 0 }))
      .sort((x, y) => (Math.min(x.a, x.b) - Math.min(y.a, y.b)) || (Math.max(x.a, x.b) - Math.max(y.a, y.b)));
    for (const b of rows) {
      const key = pairKey(b.a, b.b);
      seen.add(key);
      let t = this.pairs.get(key);
      if (!t) {
        // first sighting: seed the baseline, no cadence yet (a delta needs two crons)
        t = { run: 0, miss: 0, lastTrades: b.trades, lastScore: b.score, mean: 0, m2: 0, n: 0, lastCrystal: -CRYSTAL_COOLDOWN, a: Math.min(b.a, b.b), b: Math.max(b.a, b.b) };
        this.pairs.set(key, t);
        continue;
      }
      const delta = Math.max(0, b.trades - t.lastTrades);
      const prevScore = t.lastScore;
      t.lastTrades = b.trades;
      t.lastScore = b.score;
      // Welford's online variance over the per-cron trade cadence.
      t.n++;
      const dMean = delta - t.mean;
      t.mean += dMean / t.n;
      t.m2 += dMean * (delta - t.mean);
      const variance = t.n > 1 ? t.m2 / (t.n - 1) : 0;
      const normVar = variance / (t.mean * t.mean + 1);       // bounded, scale-free steadiness measure
      // stable = the bond did not collapse this cron (a betrayal resets the run)
      if (prevScore - b.score <= BREACH_DROP) { t.run++; t.miss = 0; } else { t.run = 0; }
      if (
        t.run >= CRYSTAL_STABLE_RUN && normVar <= VARIANCE_MAX && t.mean >= MIN_FREQ &&
        t.lastTrades >= MIN_TRADES && tick - t.lastCrystal >= CRYSTAL_COOLDOWN && this.convs.size < CONV_CAP
      ) {
        this.crystallize(t, tick, era);
        t.lastCrystal = tick;
        t.run = 0;                                             // must re-stabilise before the next crystallise
      }
    }
    for (const [key, t] of Array.from(this.pairs.entries())) {
      if (seen.has(key)) continue;
      t.run = 0;
      t.miss++;
      if (t.miss >= PAIR_MISS) this.pairs.delete(key);
    }
    // bound the tracker: prune the least-established entries beyond PAIR_TRACK_CAP
    if (this.pairs.size > PAIR_TRACK_CAP) {
      const drop = Array.from(this.pairs.entries())
        .sort((x, y) => (x[1].run - y[1].run) || (x[1].miss - y[1].miss) || (x[0] < y[0] ? -1 : 1))
        .slice(0, this.pairs.size - PAIR_TRACK_CAP);
      for (const [key] of drop) this.pairs.delete(key);
    }
  }

  private crystallize(t: PairTrack, tick: number, era: number): void {
    const sig = pairSigOf(t.a, t.b);
    const d = deriveDescriptor(sig, tick);
    const freq = clamp(Math.round(t.mean), 1, 99);
    const id = this.nextId++;
    const conv: Convention = {
      id, a: t.a, b: t.b, pairSig: sig, good: d.good, priceLo: d.priceLo, priceHi: d.priceHi, freq,
      strength: CRYSTAL_STRENGTH, depth: 0, parentId: null, adopters: [], bornTick: tick, lastTick: tick,
      lastScore: t.lastScore, holdRun: 0, lastAbsorb: -ABSORB_COOLDOWN, breaches: 0, inherited: 0,
    };
    this.convs.set(id, conv);
    this.counts.crystallized++;
    if (!this.pending.crystallized) {
      this.pending.crystallized = { conv: convLabel(conv), good: GOOD_NAMES[conv.good] ?? "?", freq: conv.freq, strength: r2(CRYSTAL_STRENGTH), era };
    }
  }

  private detectBreaches(bonds: ConvBond[], tick: number): void {
    if (!this.convs.size) return;
    // index this cron's bonds by pair key for O(1) founding-pair lookup
    const byPair = new Map<string, ConvBond>();
    for (const b of bonds) {
      if (!Number.isFinite(b.a) || !Number.isFinite(b.b) || b.a === b.b) continue;
      byPair.set(pairKey(b.a, b.b), b);
    }
    for (const c of Array.from(this.convs.values()).sort((x, y) => x.id - y.id)) {
      const b = byPair.get(pairKey(c.a, c.b));
      if (!b) continue;                                        // no read on the founding pair this cron ⇒ no evidence
      const score = Number.isFinite(b.score) ? b.score : 0;
      if (c.lastScore - score > BREACH_DROP) {                 // the bond collapsed ⇒ the custom was violated
        c.strength = clamp(c.strength - BREACH_STRENGTH_DROP, 0, 1);
        c.breaches++;
        this.breachThisCron = true;
        this.counts.breached++;
        if (!this.pending.breached) {
          // the bounded penalty actually applied this cron: min(base × 1.5, ceiling) — never money, never > cap
          const penalty = r2(clamp(BREACH_BASE * BREACH_PENALTY, 0, clamp01(this.cfg.maxIntensity)));
          this.pending.breached = { conv: convLabel(c), penalty, strength: r2(c.strength) };
        }
      }
      c.lastScore = score;
      void tick;
    }
  }

  private spread(bonds: ConvBond[], tick: number): void {
    if (!this.convs.size) return;
    // adjacency: for each agent, the neighbours it holds a strong-enough bond with
    const adj = new Map<number, { o: number; w: number }[]>();
    for (const b of bonds) {
      const w = Math.abs(Number.isFinite(b.score) ? b.score : 0);
      if (w < BOND_MIN || !Number.isFinite(b.a) || !Number.isFinite(b.b) || b.a === b.b) continue;
      const a = Math.floor(b.a), o = Math.floor(b.b);
      if (!adj.has(a)) adj.set(a, []);
      adj.get(a)!.push({ o, w });
      if (!adj.has(o)) adj.set(o, []);
      adj.get(o)!.push({ o: a, w });
    }
    for (const c of Array.from(this.convs.values()).sort((x, y) => x.id - y.id)) {
      const adopted = new Set(c.adopters);
      // candidate neighbouring pairs sharing exactly one founding member
      const cands: { lo: number; hi: number; w: number }[] = [];
      for (const anchor of [c.a, c.b]) {
        for (const { o, w } of adj.get(anchor) ?? []) {
          if (o === c.a || o === c.b) continue;
          const lo = Math.min(anchor, o), hi = Math.max(anchor, o);
          const sig = pairSigOf(lo, hi);
          if (adopted.has(sig)) continue;
          cands.push({ lo, hi, w });
        }
      }
      cands.sort((x, y) => (x.lo - y.lo) || (x.hi - y.hi));
      for (const cand of cands) {
        const sig = pairSigOf(cand.lo, cand.hi);
        if (adopted.has(sig)) continue;
        const p = clamp(cand.w * c.strength * SPREAD_GAIN, 0, SPREAD_CAP);
        if (hash01(c.id, sig, SPREAD_SALT) >= p) continue;      // hash-gated adoption
        // H4 fix: the onceGuard prevents the same (conv, pairSig) from spawning an inheritance every cron.
        const inheritKey = `${c.id}:${sig}`;
        if (hash01(c.id, sig, INHERIT_SALT) < INHERIT_P && c.depth < MAX_DEPTH && this.convs.size < CONV_CAP
            && this.inheritedPairs.claim(inheritKey)) {
          this.inheritChild(c, cand.lo, cand.hi, sig, tick);
        } else {
          if (c.adopters.length < ADOPTER_CAP) c.adopters.push(sig);
          adopted.add(sig);
          c.lastTick = tick;
          this.counts.spread++;
          if (!this.pending.spread) {
            this.pending.spread = { conv: convLabel(c), pairs: c.adopters.length + 1, strength: r2(c.strength) };
          }
        }
      }
    }
  }

  private inheritChild(parent: Convention, lo: number, hi: number, sig: number, tick: number): void {
    // DOUBLE GUARD: (1) depth < MAX_DEPTH (checked at the call site) and (2) the child pair must be a REAL bond
    // the parent actually touches (it came from `adj`), so a reused slot id with no live interaction can never
    // auto-duplicate a convention. The child inherits the descriptor but earns its own identity + lineage.
    const id = this.nextId++;
    const child: Convention = {
      id, a: lo, b: hi, pairSig: sig, good: parent.good, priceLo: parent.priceLo, priceHi: parent.priceHi,
      freq: parent.freq, strength: clamp(CRYSTAL_STRENGTH * 0.85, 0, 1), depth: parent.depth + 1, parentId: parent.id,
      adopters: [], bornTick: tick, lastTick: tick, lastScore: 0, holdRun: 0, lastAbsorb: -ABSORB_COOLDOWN,
      breaches: 0, inherited: 0,
    };
    this.convs.set(id, child);
    parent.inherited++;
    // H4 fix: removed `parent.lastTick = tick` — an inheritance is NOT an honour event for the parent;
    // resetting its TTL here made conventions effectively immortal (the decay/TTL mechanism was dead).
    this.counts.inherited++;
    if (!this.pending.inherited) {
      this.pending.inherited = { conv: convLabel(child), depth: child.depth, parent: parent.id, strength: r2(child.strength) };
    }
  }

  private evaluate(bonds: ConvBond[], tick: number): void {
    if (!this.convs.size) { this.concordance = 0; return; }
    const byPair = new Map<string, ConvBond>();
    for (const b of bonds) {
      if (!Number.isFinite(b.a) || !Number.isFinite(b.b) || b.a === b.b) continue;
      byPair.set(pairKey(b.a, b.b), b);
    }
    let honW = 0;
    let totW = 0;
    for (const c of Array.from(this.convs.values()).sort((x, y) => x.id - y.id)) {
      totW += c.strength;
      const b = byPair.get(pairKey(c.a, c.b));
      const traded = b ? (Number.isFinite(b.trades) ? b.trades : 0) : 0;
      // honoured = the founding pair shows a live, non-collapsed bond this cron
      if (b && traded > 0) {
        honW += c.strength;
        c.strength = clamp(c.strength + COMPLIANCE_GAIN, 0, 1);
        c.lastTick = tick;
        if (c.strength >= ABSORB_STRENGTH) c.holdRun++; else c.holdRun = 0;
      } else {
        c.holdRun = 0;
      }
    }
    this.concordance = totW > 0 ? clamp01(honW / totW) : 0;
  }

  private decay(tick: number): void {
    for (const [id, c] of Array.from(this.convs.entries()).sort((x, y) => x[0] - y[0])) {
      c.strength = clamp(c.strength - DECAY, 0, 1);
      if (c.strength <= DIE_STRENGTH || tick - c.lastTick > TTL) {
        this.convs.delete(id);
        this.counts.died++;
        if (!this.pending.died) {
          this.pending.died = { conv: convLabel(c), lived: Math.max(0, tick - c.bornTick), strength: r2(c.strength) };
        }
      }
    }
  }

  private offerAbsorb(tick: number, era: number): void {
    // the single widest-and-steadiest convention that has held ≥ ABSORB_STRENGTH for ABSORB_RUN crons
    let best: Convention | null = null;
    for (const c of Array.from(this.convs.values()).sort((x, y) => (y.strength - x.strength) || (y.adopters.length - x.adopters.length) || (x.id - y.id))) {
      if (c.strength < ABSORB_STRENGTH || c.holdRun < ABSORB_RUN) continue;
      if (tick - c.lastAbsorb < ABSORB_COOLDOWN) continue;
      best = c;
      break;
    }
    if (!best) return;
    best.lastAbsorb = tick;
    best.holdRun = 0;
    const sig = hash32(best.id >>> 0, best.pairSig >>> 0, ABSORBSEED_SALT) >>> 0;
    this.pending.promote = { sig, strength: r2(best.strength), label: convLabel(best), era };
  }

  /**
   * state.ts calls this after handing pending.promote to NormsMembrane.absorb(). A successful absorption is
   * counted (observable) and the convention keeps living as a local custom; a failed one simply re-offers later.
   */
  confirmAbsorb(ok: boolean): void {
    if (ok) this.counts.absorbed++;
    this.refreshPending();
  }

  /**
   * THE CAUSAL LEG — a swarm-wide Channel-A stimulus, hard-capped at cfg.maxIntensity (≤ 0.3). Concordance the
   * swarm is living up to tastes of plenty and light; friction is a bounded threat; a BREACH this cron adds one
   * extra bounded threat at min(BREACH_BASE × 1.5, cap) — the 1.5× penalty can never exceed the ceiling, and is
   * a neural/social signal only, never money, never an economic multiplier, never a real-spend cap. Channel A has
   * no per-fly addressing, so the leg AGGREGATES the honoured-strength share exactly as ㉛ does. Inert with no
   * live convention or a zero/NaN ceiling.
   */
  stimuli(cfg: { maxIntensity: number }): StimulusEvent[] {
    if (!this.cfg.enabled || !this.convs.size) return [];
    // L12 fix: apply the HARD stimulus ceiling independently of config.ts (defence in depth).
    const cap = Math.min(STIMULUS_HARD_CAP, clamp01(cfg.maxIntensity));
    // NaN-safe gate: `!(cap > 0)` is true for both 0 and NaN, so a malformed ceiling can never leak a NaN.
    if (!(cap > 0)) return [];
    const c = this.concordance;
    const out: StimulusEvent[] = [];
    if (c > 0.5) {
      const x = (c - 0.5) * 2;                                   // 0..1
      out.push({ type: "food", intensity: clamp01(0.3 + 0.7 * x) * cap, from: "conventions" });
      out.push({ type: "light", intensity: clamp01(0.2 + 0.5 * x) * cap, from: "conventions" });
    } else if (c < 0.5) {
      const x = (0.5 - c) * 2;                                   // 0..1
      out.push({ type: "threat", intensity: clamp01(0.3 + 0.7 * x) * cap, from: "conventions" });
    }
    // the breach penalty leg: a bounded 1.5× threat, HARD-CLAMPED to the ceiling (never money)
    if (this.breachThisCron) {
      const penalty = clamp(BREACH_BASE * BREACH_PENALTY, 0, cap);
      out.push({ type: "threat", intensity: r2(penalty), from: "conventions:breach" });
    }
    return out;
  }

  signals(): ConventionsSignals { return this.pending; }

  /**
   * Rebuild the STANDING read-out fields (convention list / counts / lineage / breach rate / concordance) from
   * the membrane's own internal state — pure and side-effect free: it tracks nothing, crystallises nothing,
   * spreads nothing and never fires the causal leg. restore() calls it so a DO reload reflects the persisted
   * society at once, and the /economy read-out calls it so the public numbers never lag a cron. This cron's edge
   * events (crystallized / spread / inherited / breached / died / promote) are preserved as round() left them.
   */
  refreshPending(): void {
    this.pending = {
      ...this.pending,
      conventions: this.view(),
      counts: { ...this.counts },
      lineageDepth: this.maxDepth(),
      breachRate: this.breachRate(),
      concordance: this.concordance,
    };
  }

  private view(): ConvView[] {
    return Array.from(this.convs.values())
      .sort((a, b) => b.strength - a.strength || a.id - b.id)
      .slice(0, CONV_CAP)
      .map((c) => ({
        id: c.id, conv: convLabel(c), good: GOOD_NAMES[c.good] ?? "?", freq: c.freq, priceLo: c.priceLo, priceHi: c.priceHi,
        strength: r2(c.strength), depth: c.depth, parentId: c.parentId, adopters: c.adopters.length, breaches: c.breaches, inherited: c.inherited,
      }));
  }

  private maxDepth(): number {
    let d = 0;
    for (const c of this.convs.values()) if (c.depth > d) d = c.depth;
    return d;
  }

  private breachRate(): number {
    const made = this.counts.crystallized + this.counts.inherited;
    return made > 0 ? Math.round((this.counts.breached / made) * 1000) / 1000 : 0;
  }

  // ─── persistence (bounded, additive; a corrupt blob restarts an empty society, never a poisoned ledger) ─

  serialize(): string {
    const convs = Array.from(this.convs.values())
      .sort((a, b) => a.id - b.id)
      .slice(0, CONV_CAP)
      .map((c) => ({
        id: c.id, a: c.a, b: c.b, pairSig: c.pairSig, good: c.good, priceLo: c.priceLo, priceHi: c.priceHi,
        freq: c.freq, strength: r2(c.strength), depth: c.depth, parentId: c.parentId,
        adopters: c.adopters.slice(0, ADOPTER_CAP), bornTick: c.bornTick, lastTick: c.lastTick,
        lastScore: r2(c.lastScore), holdRun: c.holdRun, lastAbsorb: c.lastAbsorb, breaches: c.breaches, inherited: c.inherited,
      }));
    const pairs = Array.from(this.pairs.entries())
      .sort((a, b) => (b[1].run - a[1].run) || (a[0] < b[0] ? -1 : 1))
      .slice(0, PAIR_TRACK_CAP)
      .map(([key, t]) => ({ key, run: t.run, miss: t.miss, lastTrades: t.lastTrades, lastScore: r2(t.lastScore), mean: r2(t.mean), m2: r2(t.m2), n: t.n, lastCrystal: t.lastCrystal, a: t.a, b: t.b }));
    // inheritedPairs: undefined when empty ⇒ JSON.stringify omits the key ⇒ byte-for-byte equivalence with pre-guard blobs.
    const inheritedPairs = this.inheritedPairs.serialize();
    return JSON.stringify({ v: CONVENTIONS_VERSION, nextId: this.nextId, counts: this.counts, concordance: r2(this.concordance), convs, pairs, inheritedPairs });
  }

  restore(blob: unknown): void {
    this.convs.clear();
    this.pairs.clear();
    this.inheritedPairs.clear();
    this.nextId = 1;
    this.counts = { crystallized: 0, spread: 0, inherited: 0, breached: 0, died: 0, absorbed: 0 };
    this.concordance = 0;
    this.breachThisCron = false;
    if (typeof blob !== "string" || !blob) { this.refreshPending(); return; }
    try {
      const p = JSON.parse(blob);
      if (!p || typeof p !== "object") { this.refreshPending(); return; }
      const num = (x: unknown, d: number) => (Number.isFinite(Number(x)) ? Number(x) : d);
      const c = p.counts ?? {};
      this.counts = {
        crystallized: Math.max(0, Math.floor(num(c.crystallized, 0))), spread: Math.max(0, Math.floor(num(c.spread, 0))),
        inherited: Math.max(0, Math.floor(num(c.inherited, 0))), breached: Math.max(0, Math.floor(num(c.breached, 0))),
        died: Math.max(0, Math.floor(num(c.died, 0))), absorbed: Math.max(0, Math.floor(num(c.absorbed, 0))),
      };
      this.concordance = clamp01(num(p.concordance, 0));
      this.nextId = Math.max(1, Math.floor(num(p.nextId, 1)));
      if (Array.isArray(p.convs)) {
        for (const e of p.convs) {
          if (!e || typeof e !== "object") continue;
          if (this.convs.size >= CONV_CAP) break;
          const o = e as Record<string, unknown>;
          const id = Math.floor(num(o.id, this.nextId));
          if (!Number.isFinite(id) || id < 1) continue;
          const a = Math.floor(num(o.a, 0));
          const b = Math.floor(num(o.b, 0));
          if (!Number.isFinite(a) || !Number.isFinite(b) || a === b) continue;
          const conv: Convention = {
            id, a: Math.min(a, b), b: Math.max(a, b), pairSig: Math.floor(num(o.pairSig, 0)) >>> 0,
            good: Math.floor(clamp(num(o.good, 0), 0, GOOD_COUNT - 1)),
            priceLo: clamp01(num(o.priceLo, 0)), priceHi: clamp01(num(o.priceHi, 0.05)),
            freq: Math.floor(clamp(num(o.freq, 1), 1, 99)),
            strength: clamp01(num(o.strength, CRYSTAL_STRENGTH)),
            depth: Math.max(0, Math.floor(num(o.depth, 0))),
            parentId: Number.isFinite(Number(o.parentId)) && o.parentId != null ? Math.floor(Number(o.parentId)) : null,
            adopters: Array.isArray(o.adopters) ? o.adopters.filter((x: unknown) => Number.isFinite(Number(x))).slice(0, ADOPTER_CAP).map((x: unknown) => Math.floor(Number(x))) : [],
            bornTick: Math.max(0, Math.floor(num(o.bornTick, 0))),
            lastTick: Math.max(0, Math.floor(num(o.lastTick, 0))),
            lastScore: clamp(num(o.lastScore, 0), -1, 1),
            holdRun: Math.max(0, Math.floor(num(o.holdRun, 0))),
            lastAbsorb: Math.floor(num(o.lastAbsorb, -ABSORB_COOLDOWN)),
            breaches: Math.max(0, Math.floor(num(o.breaches, 0))),
            inherited: Math.max(0, Math.floor(num(o.inherited, 0))),
          };
          this.convs.set(id, conv);
          if (id >= this.nextId) this.nextId = id + 1;
        }
      }
      if (Array.isArray(p.pairs)) {
        for (const e of p.pairs) {
          if (!e || typeof e !== "object") continue;
          if (this.pairs.size >= PAIR_TRACK_CAP) break;
          const o = e as Record<string, unknown>;
          const key = typeof o.key === "string" ? o.key : "";
          if (!key) continue;
          this.pairs.set(key, {
            run: Math.max(0, Math.floor(num(o.run, 0))), miss: Math.max(0, Math.floor(num(o.miss, 0))),
            lastTrades: Math.max(0, Math.floor(num(o.lastTrades, 0))), lastScore: clamp(num(o.lastScore, 0), -1, 1),
            mean: Math.max(0, num(o.mean, 0)), m2: Math.max(0, num(o.m2, 0)), n: Math.max(0, Math.floor(num(o.n, 0))),
            lastCrystal: Math.floor(num(o.lastCrystal, -CRYSTAL_COOLDOWN)), a: Math.floor(num(o.a, 0)), b: Math.floor(num(o.b, 0)),
          });
        }
      }
      // H4 fix: restore the inheritance once-guard (a missing/corrupt key silently degrades to empty — the CAP still binds).
      this.inheritedPairs.restore(p.inheritedPairs);
    } catch { /* corrupt → an empty society, nothing crystallised, nothing told */ }
    // Rebuild the read-out from the just-restored state so signals() is truthful BEFORE the next round().
    this.refreshPending();
  }
}

// FNV-1a 32-bit + a uniform 0..1 draw — the SAME construction every membrane duplicates by design (private
// salts ⇒ a conventions draw can alias no norm, culture, faith, rumor or economy draw).
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

// L2 fix: removed dead `void SIG_SALT;` — the constant is declared but never used in any computation;
// folding it into a tie-break would change existing deterministic output (not recommended).
