/**
 * ㉝ BOUNDED RULE CREATION — the statutes no authority enacted (packages/trader-worker/src/rules.ts).
 *
 * ㉛'s norms and ㉜'s conventions are emergent structures whose ONLY causal leg is a bounded Channel-A neural
 * stimulus — they can nudge the swarm's mood but never its money. This layer is the first whose causal leg
 * reaches an ECONOMIC DECISION: a fly that keeps earning (top-10% netUsdc for N consecutive crons) MINTS a rule
 * {condition, modifier, scope=self} whose modifier is a MULTIPLIER on the fly's own buyProbability and on the
 * counterparty weights it picks with. Other flies may ADOPT a rule by a hash gate; a member whose performance
 * falls below a threshold is auto-REVOKED; an unloved rule DECAYS past a TTL and DIES.
 *
 * THIS IS THE HIGHEST-RISK MEMBRANE IN THE WHOLE PLAN, so it is built in the most conservative posture possible:
 *
 *   ★ THE CONSTITUTIONAL BAND (the load-bearing safety property). Every modifier is HARD-CLAMPED into a band —
 *     buyProb× ∈ [0.5, 2.0], counterparty-weight× ∈ [0.5, 2.0] — by the pure functions clampBuy/clampCp. Those
 *     functions are TOTAL: for ANY input (a wild env band, a NaN, ±Infinity, an extreme fact, a mutation, an
 *     adoption, a corrupt restored blob) the returned multiplier is ALWAYS inside [HARD_MIN, HARD_MAX]. The band
 *     edges are code-default constants; config may only NARROW them, never widen past the hard floor/ceiling.
 *     economy.ts then re-clamps INDEPENDENTLY at each use point (defence in depth). See rules.test.ts for the
 *     property test that exhaustively asserts the band is never escaped.
 *
 *   ★ REAL MONEY IS NEVER TOUCHED. The modifier changes ONLY (a) WHETHER a fly wants to buy (buyProbability, a
 *     0..1 propensity that is clamp01'd back to [0,1] no matter how large the multiplier chain grows) and (b) WHO
 *     it buys from (a bounded, floored counterparty weight). It NEVER touches the settlement path, the deal
 *     amount, maxDealUsdc, netMinBroadcastUsdc, the daily/per-agent caps, netting, ECONOMY_MNEMONIC,
 *     ECONOMY_REAL_SPEND, x402, and it NEVER signs or broadcasts a transaction. A rule tilts a tendency; the
 *     real-spend caps independently hard-limit every actual settlement regardless of any multiplier.
 *
 * THE FIVE IRON RULES (identical in spirit to ㉛'s and ㉜'s):
 *   1. PURE READ-OUT + ONE BOUNDED CAUSAL LEG. The drive only ever READS the economy's public leaderboard
 *      (netUsdc), its settlement win-rate and the swarm's scalar read-outs; it never writes a connectome, a
 *      genome, a fingerprint, a manifest hash, a price, a purse, a cap or a settlement. Its ONE causal leg is a
 *      band-clamped economic multiplier, hard-capped at [0.5, 2.0] — never money, never a cap, never a signature.
 *   2. BOUNDED BY CONSTRUCTION. At most RULE_CAP (24) live rules; each keeps ≤ ADOPTER_CAP adopting flies; the
 *      condition tree is ≤ 5 nodes (㉛'s space); the top-tracker is pruned. The blob can never outgrow its budget
 *      (and shares the 200KB DO guard with ㉛'s norms and ㉜'s conventions — see rules.test.ts).
 *   3. DETERMINISM. No Math.random, no Date.now, no LLM, no transcendental function. Top-tracking, minting,
 *      adoption, revocation, mutation and death are all FNV-1a hash01/hash32 draws over (tick, ids, private
 *      salts) — replayable byte-for-byte from the same inputs.
 *   4. ONE-WAY LAW. The modifier leg multiplies two EXISTING bounded decision factors; it adds no sensory channel
 *      (manifestHash never rotates) and never writes back into synWeight, topology or the settlement ledger.
 *   5. HONEST PENDING (the #92 contract). pending is NEVER persisted and NEVER folded into stateDigest; the
 *      modifier map is recomputed each round and never persisted either; restore() rebuilds the STANDING read-out
 *      at its tail via refreshPending(), and the /economy read-out calls refreshPending() before signals(), so a
 *      DO eviction can never serve a zeroed drawer. Between a restore and the first drive the modifier map is
 *      EMPTY ⇒ economy.rulesTilt returns 1.0 ⇒ the layer is inert until it has honestly earned a round.
 *
 * RULES_ENABLED=false ⇒ state.ts never constructs the membrane (ensureRules returns null), folds no `rules` key
 * into the historian's context, never calls round() and never injects a modifier ⇒ the four RULE_* kinds can
 * never speak, economy.applyRuleModifiers is never called, and every byte is the pre-Rules build.
 */

import { type Cond, deriveCond, evalCond, condLabel } from "./norms.js";
import { OnceGuard } from "./onceGuard.js";

export const RULES_VERSION = 1;

// ─── the constitutional band (FROZEN IN CODE — the hard floor/ceiling no config, mutation or blob may pass) ──

/** HARD floor of the buyProbability multiplier band. No modifier is ever applied below this. */
export const HARD_BUY_MIN = 0.5;
/** HARD ceiling of the buyProbability multiplier band. No modifier is ever applied above this. */
export const HARD_BUY_MAX = 2.0;
/** HARD floor of the counterparty-weight multiplier band. */
export const HARD_CP_MIN = 0.5;
/** HARD ceiling of the counterparty-weight multiplier band. */
export const HARD_CP_MAX = 2.0;

// ─── bounded, deterministic constants (the calibration is FROZEN IN CODE — wrangler.toml [vars] is spent) ──

/** Hard ceiling of live rules the membrane may ever hold (the storage + read-out bound). */
export const RULE_CAP = 24;
/** Adopting flies one rule keeps (its spread's bounded membership). */
export const ADOPTER_CAP = 12;
/** A fly must sit in the top this fraction of netUsdc to be a mint candidate (top-10%). */
export const MINT_TOP_FRAC = 0.10;
/** Consecutive top-10% crons a fly must hold before it mints a rule (the anti-flicker gate). */
export const MINT_STABLE_RUN = 3;
/** Crons a fly must wait after minting before it may mint again. */
export const MINT_COOLDOWN = 40;
/** Strength a freshly minted rule starts at — deliberately ABOVE the death floor (hysteresis). */
export const MINT_STRENGTH = 0.5;
/** Strength at or below which a rule dies (the hysteresis floor: MINT > DIE ⇒ no flicker). */
export const DIE_STRENGTH = 0.1;
/** Per-cron strength decay every rule pays (an unloved statute fades on its own). */
export const DECAY = 0.01;
/** Crons a rule survives with no satisfied condition before the TTL reaps it. */
export const TTL = 72;
/** Strength a rule GAINS when its condition is satisfied this cron (compliance reinforces). */
export const COMPLIANCE_GAIN = 0.02;
/** A member whose netUsdc falls BELOW this is auto-revoked (the performance floor). */
export const REVOKE_NETUSDC = 0;
/** A member whose settlement win-rate falls below this is auto-revoked (0 ⇒ win-rate leg disabled). */
export const REVOKE_WINRATE = 0.34;
/** Minimum settlements before the win-rate revoke leg has any evidence (avoids revoking on 0/0). */
export const REVOKE_MIN_SETTLES = 3;
/** Adoption probability scale: p = clamp(strength · ADOPT_GAIN, 0, ADOPT_CAP). */
export const ADOPT_GAIN = 1.1;
/** Hard ceiling on any one adoption draw (a rule can never jump the whole swarm in a cron). */
export const ADOPT_CAP = 0.55;
/** Probability an adoption becomes an inherited CHILD rule (a bounded variant) instead of a plain adoption. */
export const VARY_P = 0.22;
/** Lineage depth cap — stops a variant chain from growing without bound. */
export const MAX_DEPTH = 4;
/** Consecutive crons a fly may fall out of the top-10% before the tracker forgets its run. */
export const TOP_MISS = 3;
/** Top-tracker entries kept in the serialized blob (pruned by run, descending). */
export const TRACK_CAP = 96;
/** Modifier quantisation steps (0.05 granularity ⇒ a small, bounded, byte-stable modifier space). */
export const BAND_QUANT = 20;
/** OnceGuard capacity for the variant storm fix — generous enough to cover RULE_CAP × swarm within a TTL window. */
export const VARY_GUARD_CAP = 256;

/** Private salts (duplicated by design, like every layer's — a rules draw can alias no other layer's). */
const RULESIG_SALT = 0x7b2e;   // the rule signature fold (creator id + tick)
const BUYMOD_SALT = 0x2f9a;    // the buyProbability multiplier draw
const CPMOD_SALT = 0x5c1d;     // the counterparty-weight multiplier draw
const ADOPT_SALT = 0x3e8b;     // hash-gated adoption onto a non-member fly
const VARY_SALT = 0x6a4f;      // whether an adoption becomes an inherited child
const VARSIG_SALT = 0x1d7c;    // the child variant's derivation seed
const TOP_SALT = 0x4b9e;       // top-10% selection tie-break

// ─── descriptor + record types ────────────────────────────────────────────────────────────────────────────

/** The constitutional band a modifier lives inside (config supplies it; the hard floor/ceiling always bound it). */
export interface RuleBand { buyMin: number; buyMax: number; cpMin: number; cpMax: number; }

/** One bounded economic multiplier pair a rule carries (both ALWAYS inside the constitutional band). */
export interface RuleMod { buyMult: number; cpMult: number; }

/** The swarm-level scalar read-outs the condition tree tests — the SAME nine channels ㉛ norms uses. */
export interface RulesReading {
  arousal: number; cohesion: number; valence: number; rest: number;
  temperature: number; gini: number; size01: number; bond: number; rep: number;
}

/** One fly's pure economic read-out the mint/revoke legs watch (from economy.mofitInputs / leaderboard). */
export interface RuleFly { id: number; netUsdc: number; settleOk: number; settleTotal: number; }

/** The facts state.ts folds in each cron — all pure read-outs, all bounded. */
export interface RulesFacts {
  tick: number;
  era: number;
  reading: RulesReading;
  flies: RuleFly[];
}

export interface RulesConfig extends RuleBand {
  enabled: boolean;
}

/** One emergent rule, as the ledger keeps it. */
export interface Rule {
  id: number;
  cond: Cond;                // the OPEN condition space (㉛'s composable boolean tree)
  buyMod: number;            // band-clamped buyProbability multiplier
  cpMod: number;             // band-clamped counterparty-weight multiplier
  scope: 0;                  // 0 = self+adopters (reserved for a future scope widening)
  creator: number;           // the fly that minted it
  adopters: number[];        // fly ids that adopted it (≤ ADOPTER_CAP)
  strength: number;          // 0..1
  depth: number;             // lineage depth (0 = minted, +1 per inherited variant)
  parentId: number | null;
  bornTick: number;
  lastTick: number;          // last cron its condition was satisfied (the TTL clock)
  sig: number;               // the FNV-1a signature it derived from
  revokes: number;           // lifetime member revocations
  variants: number;          // child variants spun off
}

/** One rule as the public drawer sees it (a bounded projection, never the internal record). */
export interface RuleView {
  id: number; rule: string; buyMod: number; cpMod: number; strength: number;
  depth: number; parentId: number | null; members: number; revokes: number; variants: number;
}

/** The chronicle-facing edges of ONE cron + the standing read-out. */
export interface RulesSignals {
  minted: { rule: string; buyMod: number; cpMod: number; strength: number; era: number } | null;
  adopted: { rule: string; adopters: number; strength: number } | null;
  revoked: { rule: string; strength: number } | null;
  died: { rule: string; lived: number; strength: number } | null;
  rules: RuleView[];
  counts: { minted: number; adopted: number; revoked: number; died: number };
  avgModifier: number;       // mean buyMod across live rules (observability)
  bandHits: number;          // live rules currently pinned at a band edge (observability)
  coverage: number;          // 0..1 share of flies carrying a live modifier this cron
}

// ─── small pure helpers ──────────────────────────────────────────────────────────────────────────────────

function clamp(x: number, lo: number, hi: number): number { return x < lo ? lo : x > hi ? hi : x; }
function clamp01(x: number): number { return x < 0 ? 0 : x > 1 ? 1 : x; }
function r2(x: number): number { return Math.round(x * 100) / 100; }
function quantise(x: number): number { return Math.round(x * BAND_QUANT) / BAND_QUANT; }

/**
 * ★ THE CONSTITUTIONAL BAND CLAMP (buy axis) — the load-bearing safety function. TOTAL over every input: the
 * configured band is first intersected with the HARD floor/ceiling ([0.5, 2.0]) so a wild or NaN config can never
 * widen it, the edges are ordered, and a NaN/±Infinity modifier falls back to the neutral 1.0 (itself clamped
 * inside the band). The result is ALWAYS inside [HARD_BUY_MIN, HARD_BUY_MAX] — no exception, no leak.
 */
export function clampBuy(m: number, lo: number, hi: number): number {
  // Bound BOTH effective edges into the HARD envelope first (a wild lo>CEIL or hi<FLOOR, or a NaN, can never
  // widen the range past [HARD_BUY_MIN, HARD_BUY_MAX]); then order them and clamp the modifier. TOTAL: the
  // result is ALWAYS inside the hard band for ANY (m, lo, hi), including a reversed or out-of-envelope band.
  const L = Math.min(HARD_BUY_MAX, Math.max(HARD_BUY_MIN, Number.isFinite(lo) ? lo : HARD_BUY_MIN));
  const H = Math.max(HARD_BUY_MIN, Math.min(HARD_BUY_MAX, Number.isFinite(hi) ? hi : HARD_BUY_MAX));
  const l = Math.min(L, H), h = Math.max(L, H);
  const v = Number.isFinite(m) ? m : 1.0;
  return v < l ? l : v > h ? h : v;
}

/** ★ THE CONSTITUTIONAL BAND CLAMP (counterparty axis) — identical guarantee on the [0.5, 2.0] cp band. */
export function clampCp(m: number, lo: number, hi: number): number {
  // Identical TOTAL guarantee on the counterparty axis (see clampBuy).
  const L = Math.min(HARD_CP_MAX, Math.max(HARD_CP_MIN, Number.isFinite(lo) ? lo : HARD_CP_MIN));
  const H = Math.max(HARD_CP_MIN, Math.min(HARD_CP_MAX, Number.isFinite(hi) ? hi : HARD_CP_MAX));
  const l = Math.min(L, H), h = Math.max(L, H);
  const v = Number.isFinite(m) ? m : 1.0;
  return v < l ? l : v > h ? h : v;
}

/** Order + hard-bound a config band into the constitutional envelope (used by config.ts and the membrane). */
export function normaliseBand(b: Partial<RuleBand> | null | undefined): RuleBand {
  const buyMin = clampBuy(Number.isFinite(b?.buyMin) ? (b!.buyMin as number) : HARD_BUY_MIN, HARD_BUY_MIN, HARD_BUY_MAX);
  const buyMax = clampBuy(Number.isFinite(b?.buyMax) ? (b!.buyMax as number) : HARD_BUY_MAX, HARD_BUY_MIN, HARD_BUY_MAX);
  const cpMin = clampCp(Number.isFinite(b?.cpMin) ? (b!.cpMin as number) : HARD_CP_MIN, HARD_CP_MIN, HARD_CP_MAX);
  const cpMax = clampCp(Number.isFinite(b?.cpMax) ? (b!.cpMax as number) : HARD_CP_MAX, HARD_CP_MIN, HARD_CP_MAX);
  return {
    buyMin: Math.min(buyMin, buyMax), buyMax: Math.max(buyMin, buyMax),
    cpMin: Math.min(cpMin, cpMax), cpMax: Math.max(cpMin, cpMax),
  };
}

/** The reading vector in the fixed channel order ㉛'s leaves index into (every field clamped 0..1). */
function readingVector(r: RulesReading): number[] {
  const g = (x: number) => (Number.isFinite(x) ? clamp01(x) : 0);
  return [g(r.arousal), g(r.cohesion), g(r.valence), g(r.rest), g(r.temperature), g(r.gini), g(r.size01), g(r.bond), g(r.rep)];
}

/** A stable 32-bit signature over a minting fly + tick (the rule's derivation seed). */
export function ruleSigOf(creator: number, tick: number): number {
  return hash32((Math.floor(creator) >>> 0), (Math.floor(tick) >>> 0), RULESIG_SALT) >>> 0;
}

/**
 * Derive a rule's BOUNDED modifier pair from its signature + the tick, quantised to 0.05 steps and HARD-CLAMPED
 * into the constitutional band. An OPEN draw within the band — never a hand-assigned multiplier.
 */
export function deriveModifier(sig: number, tick: number, band: RuleBand): { buyMod: number; cpMod: number } {
  const b = normaliseBand(band);
  const buyRaw = b.buyMin + hash01(sig, tick, BUYMOD_SALT) * (b.buyMax - b.buyMin);
  const cpRaw = b.cpMin + hash01(sig, tick, CPMOD_SALT) * (b.cpMax - b.cpMin);
  return {
    buyMod: clampBuy(quantise(buyRaw), b.buyMin, b.buyMax),
    cpMod: clampCp(quantise(cpRaw), b.cpMin, b.cpMax),
  };
}

/** A short, byte-stable ASCII label for a rule (the {rule} token both server and browser re-derive). */
export function ruleLabel(r: { cond: Cond; buyMod: number; cpMod: number }): string {
  return `${condLabel(r.cond)}=>buy*${r.buyMod.toFixed(2)}/cp*${r.cpMod.toFixed(2)}`;
}

// ─── the membrane ──────────────────────────────────────────────────────────────────────────────────────────

interface FlyTrack { run: number; miss: number; lastMint: number; }

export class RulesMembrane {
  private rules = new Map<number, Rule>();
  private tracks = new Map<number, FlyTrack>();
  private nextId = 1;
  private counts = { minted: 0, adopted: 0, revoked: 0, died: 0 };
  private mods = new Map<number, RuleMod>();
  private coverage = 0;
  private band: RuleBand;
  /** H2 fix: "already varied" memory — prevents the same (rule, fly) pair from spawning a variant every cron. */
  private variedPairs = new OnceGuard(VARY_GUARD_CAP);
  private pending: RulesSignals = {
    minted: null, adopted: null, revoked: null, died: null,
    rules: [], counts: { ...this.counts }, avgModifier: 0, bandHits: 0, coverage: 0,
  };

  constructor(private readonly cfg: RulesConfig) {
    // The band is normalised ONCE at construction into the constitutional envelope; every modifier is clamped
    // against it, and economy.ts re-clamps independently at each use point (defence in depth).
    this.band = normaliseBand(cfg);
  }

  /** One round per cron, alongside driveNorms/driveConventions and BEFORE observeChronicle — pure read-out. */
  round(facts: RulesFacts): void {
    if (!this.cfg.enabled) return;
    // Reset THIS cron's edges; keep the standing fields (refreshPending() rebuilds them at the tail).
    this.pending = {
      minted: null, adopted: null, revoked: null, died: null,
      rules: this.view(), counts: { ...this.counts },
      avgModifier: this.avgModifier(), bandHits: this.bandHits(), coverage: this.coverage,
    };
    const tick = Math.max(0, Math.floor(Number.isFinite(facts.tick) ? facts.tick : 0));
    const era = Math.floor(Number.isFinite(facts.era) ? facts.era : 0);
    const flies = Array.isArray(facts.flies) ? facts.flies : [];

    // 1) mint: a fly that holds the top-10% of netUsdc for MINT_STABLE_RUN crons forges a rule over itself.
    this.trackTop(flies, tick, era);
    // 2) adopt: other flies take up a live rule by a hash gate, monotonic in strength, bounded by ADOPTER_CAP.
    this.adopt(flies, tick);
    // 3) revoke: a member (creator or adopter) whose performance fell below a threshold is auto-revoked.
    this.revoke(flies);
    // 4) compliance: a rule whose condition the swarm's read-out satisfies this cron reinforces + resets its TTL.
    this.evaluate(facts.reading, tick);
    // 5) decay + TTL + hysteresis: every rule pays the decay; the unloved and the old die.
    this.decay(tick);
    // 6) fold the band-clamped modifier map this cron's satisfied rules project onto their members.
    // L1 fix: pass the TRUE population size so coverage is a share of the swarm, not of the tracked elite.
    this.computeModifiers(facts.reading, flies.length);

    // Read-out closes on the END-of-round truth.
    this.refreshPending();
  }

  private trackTop(flies: RuleFly[], tick: number, era: number): void {
    // M6 fix: require netUsdc > 0 (the hard profitability gate, matching evolution.ts L109) so a losing
    // economy never mints a rule that step 3 immediately revokes (RULE_MINTED + RULE_REVOKED noise).
    // rank by netUsdc desc, deterministic tie-break (id asc); the top ceil(n·frac) are this cron's elite
    const rows = flies
      .filter((f) => f && Number.isFinite(f.id) && Number.isFinite(f.netUsdc) && f.netUsdc > 0)
      .map((f) => ({ id: Math.floor(f.id), netUsdc: f.netUsdc }))
      .sort((a, b) => (b.netUsdc - a.netUsdc) || (a.id - b.id));
    const take = rows.length > 0 ? Math.max(1, Math.ceil(rows.length * MINT_TOP_FRAC)) : 0;
    const top = new Set<number>(rows.slice(0, take).map((r) => r.id));
    for (const id of Array.from(top).sort((a, b) => a - b)) {
      let t = this.tracks.get(id);
      if (!t) { t = { run: 0, miss: 0, lastMint: -MINT_COOLDOWN }; this.tracks.set(id, t); }
      t.run++;
      t.miss = 0;
      if (t.run >= MINT_STABLE_RUN && tick - t.lastMint >= MINT_COOLDOWN && this.rules.size < RULE_CAP) {
        this.mint(id, tick, era);
        t.lastMint = tick;
        t.run = 0;                                        // must re-stabilise before the next mint
      }
    }
    for (const [id, t] of Array.from(this.tracks.entries())) {
      if (top.has(id)) continue;
      t.run = 0;
      t.miss++;
      if (t.miss >= TOP_MISS) this.tracks.delete(id);
    }
    // bound the tracker: prune the least-established entries beyond TRACK_CAP
    if (this.tracks.size > TRACK_CAP) {
      const drop = Array.from(this.tracks.entries())
        .sort((a, b) => (a[1].run - b[1].run) || (a[1].miss - b[1].miss) || (b[0] - a[0]))
        .slice(0, this.tracks.size - TRACK_CAP);
      for (const [id] of drop) this.tracks.delete(id);
    }
  }

  private mint(creator: number, tick: number, era: number): void {
    const sig = ruleSigOf(creator, tick);
    const cond = deriveCond(sig, tick);                   // ㉛'s OPEN compositional condition space
    const mod = deriveModifier(sig, tick, this.band);     // band-clamped at birth
    const id = this.nextId++;
    const rule: Rule = {
      id, cond, buyMod: mod.buyMod, cpMod: mod.cpMod, scope: 0, creator, adopters: [],
      strength: MINT_STRENGTH, depth: 0, parentId: null, bornTick: tick, lastTick: tick,
      sig, revokes: 0, variants: 0,
    };
    this.rules.set(id, rule);
    this.counts.minted++;
    if (!this.pending.minted) {
      this.pending.minted = { rule: ruleLabel(rule), buyMod: r2(rule.buyMod), cpMod: r2(rule.cpMod), strength: r2(MINT_STRENGTH), era };
    }
  }

  private adopt(flies: RuleFly[], tick: number): void {
    if (!this.rules.size || !flies.length) return;
    const alive = flies.filter((f) => f && Number.isFinite(f.id)).map((f) => Math.floor(f.id)).sort((a, b) => a - b);
    for (const rule of Array.from(this.rules.values()).sort((a, b) => a.id - b.id)) {
      const members = new Set<number>([rule.creator, ...rule.adopters]);
      for (const id of alive) {
        if (members.has(id)) continue;
        if (rule.adopters.length >= ADOPTER_CAP) break;
        const p = clamp(rule.strength * ADOPT_GAIN, 0, ADOPT_CAP);
        // id-only draw ⇒ adoption is monotonic in strength: a fly that joins stays joined as p grows.
        if (hash01(rule.id, id, ADOPT_SALT) >= p) continue;
        // H2 fix: the onceGuard prevents the same (rule, fly) from spawning a variant every cron.
        const varyKey = `${rule.id}:${id}`;
        if (hash01(rule.id, id, VARY_SALT) < VARY_P && rule.depth < MAX_DEPTH && this.rules.size < RULE_CAP
            && this.variedPairs.claim(varyKey)) {
          this.variant(rule, id, tick);
        } else {
          rule.adopters.push(id);
          members.add(id);
          rule.lastTick = tick;
          this.counts.adopted++;
          if (!this.pending.adopted) {
            this.pending.adopted = { rule: ruleLabel(rule), adopters: rule.adopters.length + 1, strength: r2(rule.strength) };
          }
        }
      }
    }
  }

  private variant(parent: Rule, adopter: number, tick: number): void {
    // A child rule inherits the parent's condition shape but re-derives its OWN band-clamped modifier from its
    // own signature — the lineage drift, bounded by MAX_DEPTH and RULE_CAP, deterministic by (parent, adopter).
    const sig = hash32(parent.id >>> 0, adopter >>> 0, VARSIG_SALT) >>> 0;
    const mod = deriveModifier(sig, tick, this.band);
    const id = this.nextId++;
    const child: Rule = {
      id, cond: deriveCond(sig, tick), buyMod: mod.buyMod, cpMod: mod.cpMod, scope: 0,
      creator: adopter, adopters: [], strength: clamp(r2(MINT_STRENGTH * 0.85), 0, 1),
      depth: parent.depth + 1, parentId: parent.id, bornTick: tick, lastTick: tick,
      sig, revokes: 0, variants: 0,
    };
    this.rules.set(id, child);
    parent.variants++;
    // H2 fix: removed `parent.lastTick = tick` — a variant is NOT a compliance event for the parent;
    // resetting its TTL here made rules effectively immortal (the decay/TTL mechanism was dead).
    this.counts.adopted++;
    if (!this.pending.adopted) {
      this.pending.adopted = { rule: ruleLabel(child), adopters: 1, strength: r2(child.strength) };
    }
  }

  private revoke(flies: RuleFly[]): void {
    if (!this.rules.size) return;
    const byId = new Map<number, RuleFly>();
    for (const f of flies) {
      if (f && Number.isFinite(f.id)) byId.set(Math.floor(f.id), f);
    }
    const under = (f: RuleFly): boolean => {
      const net = Number.isFinite(f.netUsdc) ? f.netUsdc : 0;
      if (net < REVOKE_NETUSDC) return true;
      const tot = Number.isFinite(f.settleTotal) ? Math.max(0, Math.floor(f.settleTotal)) : 0;
      const ok = Number.isFinite(f.settleOk) ? Math.max(0, Math.floor(f.settleOk)) : 0;
      if (REVOKE_WINRATE > 0 && tot >= REVOKE_MIN_SETTLES && ok / tot < REVOKE_WINRATE) return true;
      return false;
    };
    for (const [id, rule] of Array.from(this.rules.entries()).sort((a, b) => a[0] - b[0])) {
      const creator = byId.get(rule.creator);
      if (creator && under(creator)) {
        // the founder fell below the threshold ⇒ the whole statute is revoked
        this.rules.delete(id);
        this.counts.revoked++;
        if (!this.pending.revoked) this.pending.revoked = { rule: ruleLabel(rule), strength: r2(rule.strength) };
        continue;
      }
      const keep: number[] = [];
      let dropped = false;
      for (const a of rule.adopters) {
        const f = byId.get(a);
        if (f && under(f)) { dropped = true; continue; }   // an underperforming adopter is revoked
        keep.push(a);
      }
      if (dropped) {
        rule.adopters = keep.slice(0, ADOPTER_CAP);
        rule.revokes++;
        this.counts.revoked++;
        if (!this.pending.revoked) this.pending.revoked = { rule: ruleLabel(rule), strength: r2(rule.strength) };
      }
    }
  }

  private evaluate(reading: RulesReading, tick: number): void {
    if (!this.rules.size) return;
    const rv = readingVector(reading);
    for (const rule of Array.from(this.rules.values()).sort((a, b) => a.id - b.id)) {
      if (evalCond(rule.cond, rv)) {
        rule.strength = clamp(rule.strength + COMPLIANCE_GAIN, 0, 1);
        rule.lastTick = tick;                              // a satisfied condition resets the TTL clock
      }
    }
  }

  private decay(tick: number): void {
    for (const [id, rule] of Array.from(this.rules.entries()).sort((a, b) => a[0] - b[0])) {
      rule.strength = clamp(rule.strength - DECAY, 0, 1);
      if (rule.strength <= DIE_STRENGTH || tick - rule.lastTick > TTL) {
        this.rules.delete(id);
        this.counts.died++;
        if (!this.pending.died) {
          this.pending.died = { rule: ruleLabel(rule), lived: Math.max(0, tick - rule.bornTick), strength: r2(rule.strength) };
        }
      }
    }
  }

  /**
   * Fold THIS cron's modifier map: for every live rule whose condition the swarm satisfies, project its
   * band-clamped multiplier onto each member (creator + adopters). A fly under several satisfied rules compounds
   * their multipliers, and the compound is CLAMPED BACK INTO THE BAND — so the final per-fly modifier is inside
   * [0.5, 2.0] no matter how many rules stack. The map is recomputed every round and never persisted.
   */
  private computeModifiers(reading: RulesReading, populationSize?: number): void {
    this.mods = new Map<number, RuleMod>();
    if (!this.rules.size) { this.coverage = 0; return; }
    const rv = readingVector(reading);
    const acc = new Map<number, { buy: number; cp: number }>();
    for (const rule of Array.from(this.rules.values()).sort((a, b) => a.id - b.id)) {
      if (!evalCond(rule.cond, rv)) continue;              // an unsatisfied condition projects no modifier
      const members = new Set<number>([rule.creator, ...rule.adopters]);
      for (const id of members) {
        const a = acc.get(id) ?? { buy: 1, cp: 1 };
        a.buy *= rule.buyMod;
        a.cp *= rule.cpMod;
        acc.set(id, a);
      }
    }
    let touched = 0;
    for (const [id, a] of Array.from(acc.entries()).sort((x, y) => x[0] - y[0])) {
      // ★ the compound is HARD-CLAMPED back into the band — the effective modifier can never escape [0.5, 2.0].
      this.mods.set(id, {
        buyMult: clampBuy(a.buy, this.band.buyMin, this.band.buyMax),
        cpMult: clampCp(a.cp, this.band.cpMin, this.band.cpMax),
      });
      touched++;
    }
    // L1 fix: the denominator is the TRUE population size (facts.flies.length), not the tracked-elite subset.
    const totalFlies = (Number.isFinite(populationSize) && (populationSize as number) > 0)
      ? Math.max(touched, populationSize as number)
      : touched;
    this.coverage = totalFlies > 0 ? clamp01(touched / totalFlies) : 0;
  }

  /**
   * The band-clamped modifier map for THIS cron — state.ts hands it to economy.applyRuleModifiers() AFTER
   * economy.step, so it takes honest effect on the NEXT cron (the same one-cron lag every membrane keeps). Every
   * value is inside the constitutional band; an empty map ⇒ economy.rulesTilt returns 1.0 ⇒ inert.
   */
  modifiers(): Map<number, RuleMod> { return this.mods; }

  signals(): RulesSignals { return this.pending; }

  /**
   * Rebuild the STANDING read-out fields (rule list / counts / avg modifier / band hits / coverage) from the
   * membrane's own internal state — pure and side-effect free: it tracks nothing, mints nothing, adopts nothing
   * and never recomputes the modifier map. restore() calls it so a DO reload reflects the persisted statutes at
   * once, and the /economy read-out calls it so the public numbers never lag a cron. This cron's edge events
   * (minted / adopted / revoked / died) are preserved as round() left them (null after a fresh restore).
   */
  refreshPending(): void {
    this.pending = {
      ...this.pending,
      rules: this.view(),
      counts: { ...this.counts },
      avgModifier: this.avgModifier(),
      bandHits: this.bandHits(),
      coverage: this.coverage,
    };
  }

  private view(): RuleView[] {
    return Array.from(this.rules.values())
      .sort((a, b) => b.strength - a.strength || a.id - b.id)
      .slice(0, RULE_CAP)
      .map((r) => ({
        id: r.id, rule: ruleLabel(r), buyMod: r2(r.buyMod), cpMod: r2(r.cpMod), strength: r2(r.strength),
        depth: r.depth, parentId: r.parentId, members: r.adopters.length + 1, revokes: r.revokes, variants: r.variants,
      }));
  }

  private avgModifier(): number {
    if (!this.rules.size) return 0;
    let s = 0;
    for (const r of this.rules.values()) s += r.buyMod;
    return Math.round((s / this.rules.size) * 1000) / 1000;
  }

  /** Live rules whose buyMod or cpMod sits at a band edge (the boundary-hit statistic the read-out reports). */
  private bandHits(): number {
    const eps = 1e-9;
    let n = 0;
    for (const r of this.rules.values()) {
      const b = r.buyMod <= this.band.buyMin + eps || r.buyMod >= this.band.buyMax - eps;
      const c = r.cpMod <= this.band.cpMin + eps || r.cpMod >= this.band.cpMax - eps;
      if (b || c) n++;
    }
    return n;
  }

  // ─── persistence (bounded, additive; a corrupt blob restarts an empty statute book, never a poisoned ledger) ─

  serialize(): string {
    const rules = Array.from(this.rules.values())
      .sort((a, b) => a.id - b.id)
      .slice(0, RULE_CAP)
      .map((r) => ({
        id: r.id, cond: r.cond, buyMod: r2(r.buyMod), cpMod: r2(r.cpMod), scope: r.scope, creator: r.creator,
        adopters: r.adopters.slice(0, ADOPTER_CAP), strength: r2(r.strength), depth: r.depth, parentId: r.parentId,
        bornTick: r.bornTick, lastTick: r.lastTick, sig: r.sig, revokes: r.revokes, variants: r.variants,
      }));
    const tracks = Array.from(this.tracks.entries())
      .sort((a, b) => (b[1].run - a[1].run) || (a[0] - b[0]))
      .slice(0, TRACK_CAP)
      .map(([id, t]) => ({ id, run: t.run, miss: t.miss, lastMint: t.lastMint }));
    // variedPairs: undefined when empty ⇒ JSON.stringify omits the key ⇒ byte-for-byte equivalence with pre-guard blobs.
    const variedPairs = this.variedPairs.serialize();
    return JSON.stringify({ v: RULES_VERSION, nextId: this.nextId, counts: this.counts, rules, tracks, variedPairs });
  }

  restore(blob: unknown): void {
    this.rules.clear();
    this.tracks.clear();
    this.mods.clear();
    this.variedPairs.clear();
    this.nextId = 1;
    this.counts = { minted: 0, adopted: 0, revoked: 0, died: 0 };
    this.coverage = 0;
    if (typeof blob !== "string" || !blob) { this.refreshPending(); return; }
    try {
      const p = JSON.parse(blob);
      if (!p || typeof p !== "object") { this.refreshPending(); return; }
      const num = (x: unknown, d: number) => (Number.isFinite(Number(x)) ? Number(x) : d);
      const c = p.counts ?? {};
      this.counts = {
        minted: Math.max(0, Math.floor(num(c.minted, 0))), adopted: Math.max(0, Math.floor(num(c.adopted, 0))),
        revoked: Math.max(0, Math.floor(num(c.revoked, 0))), died: Math.max(0, Math.floor(num(c.died, 0))),
      };
      this.nextId = Math.max(1, Math.floor(num(p.nextId, 1)));
      if (Array.isArray(p.rules)) {
        for (const e of p.rules) {
          if (!e || typeof e !== "object") continue;
          if (this.rules.size >= RULE_CAP) break;
          const o = e as Record<string, unknown>;
          const cond = parseCond(o.cond, 0);
          if (!cond) continue;                            // a corrupt condition tree ⇒ the rule is dropped
          const id = Math.floor(num(o.id, this.nextId));
          if (!Number.isFinite(id) || id < 1) continue;
          const rule: Rule = {
            id, cond,
            // ★ every restored modifier is re-clamped into the band — a poisoned blob can never smuggle a wild one
            buyMod: clampBuy(num(o.buyMod, 1), this.band.buyMin, this.band.buyMax),
            cpMod: clampCp(num(o.cpMod, 1), this.band.cpMin, this.band.cpMax),
            scope: 0,
            creator: Math.floor(num(o.creator, 0)),
            adopters: Array.isArray(o.adopters) ? o.adopters.filter((x: unknown) => Number.isFinite(Number(x))).slice(0, ADOPTER_CAP).map((x: unknown) => Math.floor(Number(x))) : [],
            strength: clamp01(num(o.strength, MINT_STRENGTH)),
            depth: Math.max(0, Math.floor(num(o.depth, 0))),
            parentId: Number.isFinite(Number(o.parentId)) && o.parentId != null ? Math.floor(Number(o.parentId)) : null,
            bornTick: Math.max(0, Math.floor(num(o.bornTick, 0))),
            lastTick: Math.max(0, Math.floor(num(o.lastTick, 0))),
            sig: Math.floor(num(o.sig, 0)) >>> 0,
            revokes: Math.max(0, Math.floor(num(o.revokes, 0))),
            variants: Math.max(0, Math.floor(num(o.variants, 0))),
          };
          this.rules.set(id, rule);
          if (id >= this.nextId) this.nextId = id + 1;
        }
      }
      if (Array.isArray(p.tracks)) {
        for (const e of p.tracks) {
          if (!e || typeof e !== "object") continue;
          if (this.tracks.size >= TRACK_CAP) break;
          const o = e as Record<string, unknown>;
          const id = Math.floor(num(o.id, 0));
          if (!Number.isFinite(id)) continue;
          this.tracks.set(id, {
            run: Math.max(0, Math.floor(num(o.run, 0))), miss: Math.max(0, Math.floor(num(o.miss, 0))),
            lastMint: Math.floor(num(o.lastMint, -MINT_COOLDOWN)),
          });
        }
      }
      // H2 fix: restore the variant once-guard (a missing/corrupt key silently degrades to empty — the CAP still binds).
      this.variedPairs.restore(p.variedPairs);
    } catch { /* corrupt → an empty statute book, nothing minted, nothing told */ }
    // Rebuild the read-out from the just-restored state so signals() is truthful BEFORE the next round().
    this.refreshPending();
  }
}

/** Parse + validate a stored condition tree (bounded depth, clamped params); null ⇒ the rule is dropped. */
function parseCond(x: unknown, depth: number): Cond | null {
  if (!x || typeof x !== "object" || depth > 4) return null;
  const o = x as Record<string, unknown>;
  const k = Number(o.k);
  if (k === 0) {
    const ch = Math.floor(Number(o.ch));
    const op = Number(o.op);
    const thr = Number(o.thr);
    if (!Number.isInteger(ch) || ch < 0 || ch >= 9) return null;
    if (op !== 0 && op !== 1) return null;
    if (!Number.isFinite(thr)) return null;
    return { k: 0, ch, op: op as 0 | 1, thr: clamp(thr, 0, 1) };
  }
  if (k === 1 || k === 2 || k === 3) {
    if (!Array.isArray(o.of)) return null;
    const of: Cond[] = [];
    for (const ch of o.of.slice(0, 4)) { const q = parseCond(ch, depth + 1); if (q) of.push(q); }
    if (!of.length) return null;
    if (k === 3) of.length = 1;
    return { k: k as 1 | 2 | 3, of };
  }
  return null;
}

// FNV-1a 32-bit + a uniform 0..1 draw — the SAME construction every membrane duplicates by design (private
// salts ⇒ a rules draw can alias no norm, convention, culture, faith, rumor or economy draw).
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
