/**
 * ㉛ EMERGENT NORMS — the institutions no hand wrote (packages/trader-worker/src/norms.ts).
 *
 * Every membrane shipped so far is a CLOSED rule-space: a hand-written FSM that can surface a STATE but never
 * a STRUCTURE. This layer is the first open one. It watches the swarm's OWN bond graph, clusters it with a
 * deterministic label-propagation, and — when a cluster holds stable across crons — MINTS a norm: a triple
 * {condition, action, strength} whose condition is drawn from an OPEN, COMPOSABLE space (a boolean expression
 * tree over the live neural-economic-social read-outs), never from a fixed enumeration. The norm then SPREADS
 * along the bonds by a hash-gated adoption, MUTATES by a bounded ±0.1 drift as it is inherited, DECAYS under a
 * TTL and a hysteresis floor, and at last DIES. Structure emerges from interaction; nobody named it.
 *
 * THE FIVE IRON RULES (the membrane contract, identical in spirit to ㉔'s and ⑬'s):
 *   1. PURE READ-OUT + ONE BOUNDED CAUSAL LEG. The drive only ever READS the bond graph and the swarm's scalar
 *      read-outs; it never writes a connectome, a genome, a fingerprint, a manifest hash, a price or a purse.
 *      Its ONE causal leg is a swarm-wide Channel-A stimulus (food/threat/light), hard-capped at
 *      cfg.maxIntensity ≤ 0.3 — the same visitor-stimulus path the civic bus ① rides. No money ever moves here.
 *   2. BOUNDED BY CONSTRUCTION. At most NORM_CAP (32) live norms; each holds ≤ ADHERENT_CAP ids; the condition
 *      tree is ≤ 5 nodes; the cluster tracker is pruned. The serialized blob can never outgrow its budget.
 *   3. DETERMINISM. No Math.random, no Date.now, no LLM, no transcendental function. Clustering, minting,
 *      spreading, mutation and death are all FNV-1a hash01/hash32 draws over (tick, ids, salts) — replayable
 *      byte-for-byte by anyone holding the same inputs.
 *   4. ONE-WAY LAW. The stimulus leg injects current through the EXISTING four channels only; it adds no
 *      sensory channel (manifestHash never rotates) and never writes back into synWeight or topology.
 *   5. HONEST PENDING (the #92 contract). pending is NEVER persisted and NEVER folded into stateDigest;
 *      restore() rebuilds the STANDING read-out at its tail via refreshPending(), and the /economy read-out
 *      calls refreshPending() before signals(), so a DO eviction can never serve a zeroed drawer.
 *
 * NORMS_ENABLED=false ⇒ state.ts never constructs the membrane (ensureNorms returns null), folds no `norms` key
 * into the historian's context, appends no stimulus and never calls round() ⇒ the four NORM_* kinds can never
 * speak and every byte of behaviour is the pre-Norms build.
 */

import type { StimulusEvent } from "@fly/fly-brain";
import { OnceGuard, STIMULUS_HARD_CAP } from "./onceGuard.js";

export const NORMS_VERSION = 1;

// ─── bounded, deterministic constants (the calibration is FROZEN IN CODE — wrangler.toml [vars] is spent) ──

/** Hard ceiling of live norms the membrane may ever hold (the storage + read-out bound). */
export const NORM_CAP = 32;
/** Adherent ids one norm keeps (the spread's bounded membership list). */
export const ADHERENT_CAP = 16;
/** A cluster must gather at least this many minds before it can mint a norm. */
export const MIN_CLUSTER = 2;
/** Label-propagation passes over the bond graph (a fixed, small bound ⇒ deterministic + cheap). */
export const LP_ITERS = 4;
/** Bonds weaker than this (|score|) are not edges of the cluster graph at all. */
export const BOND_MIN = 0.05;
/** Consecutive stable crons a cluster must hold before it mints (the anti-flicker gate). */
export const MINT_STABLE_RUN = 3;
/** Crons a cluster must wait after minting before it may mint again (one norm per cluster per cooldown). */
export const MINT_COOLDOWN = 40;
/** Strength a freshly minted norm starts at — deliberately ABOVE the death floor (hysteresis). */
export const MINT_STRENGTH = 0.5;
/** Strength at or below which a norm dies (the hysteresis floor: MINT_STRENGTH > DIE_STRENGTH ⇒ no flicker). */
export const DIE_STRENGTH = 0.1;
/** Per-cron strength decay every norm pays (an unloved norm fades on its own). */
export const DECAY = 0.01;
/** Crons a norm survives with no satisfied adherence before the TTL reaps it. */
export const TTL = 60;
/** Strength a norm GAINS when its condition is satisfied this cron (compliance reinforces). */
export const COMPLIANCE_GAIN = 0.02;
/** Spread probability scale: p = clamp(|bond| · strength · SPREAD_GAIN, 0, SPREAD_CAP). */
export const SPREAD_GAIN = 1.2;
/** Hard ceiling on any one adoption draw (a norm can never jump the whole swarm in a cron). */
export const SPREAD_CAP = 0.6;
/** Probability a spread event MUTATES into a child variant instead of a plain adoption. */
export const MUT_P = 0.25;
/** Consecutive crons a cluster may go unseen before the tracker forgets it (bounded cluster map). */
export const CLUSTER_MISS = 3;
/** Probability a convention promoted by ㉜ conventions is absorbed into a norm (hash-gated, bounded). */
export const ABSORB_P = 0.5;
/** Cluster-tracker entries kept in the serialized blob (pruned by run, descending). */
export const CLUSTER_CAP = 64;
/** OnceGuard capacity for the mutation storm fix — generous enough to cover NORM_CAP × swarm within a TTL window. */
export const MUT_GUARD_CAP = 384;

/** Private salts (duplicated by design, like every layer's — a norms draw can alias no other layer's). */
const CLUSTER_SALT = 0x4f7a;   // label-propagation tie-break
const SIG_SALT = 0x2b1d;       // the cluster signature fold
const CH_SALT = 0x6c3e;        // which read-out channel a leaf tests
const OP_SALT = 0x1a9f;        // >= or <
const THR_SALT = 0x77b2;       // the leaf's threshold
const SHAPE_SALT = 0x3e5c;     // the condition tree's shape
const ACT_SALT = 0x5d21;       // the action's stimulus channel
const GAIN_SALT = 0x0f8a;      // the action's gain
const SPREAD_SALT = 0x6a4d;    // hash-gated adoption along a bond
const MUT_SALT = 0x2e7b;       // whether an adoption mutates
const MUTSIG_SALT = 0x4c1f;    // the child variant's derivation seed
const MTTARGET_SALT = 0x7a03;  // which parameter the mutation drifts
const MUTDIR_SALT = 0x33d6;    // the mutation's sign (±0.1)
const MUTLEAF_SALT = 0x5b8e;   // which leaf the mutation drifts
const ABSORB_SALT = 0x9c37;    // ㉜←㉛ whether a promoted convention is absorbed into a norm

/** The nine read-out channels a condition leaf may test — the OPEN terminal set of the condition space. */
export const CH_NAMES = ["arousal", "cohesion", "valence", "rest", "temperature", "gini", "size", "bond", "rep"] as const;
const CH_COUNT = CH_NAMES.length;

/** The four bounded stimulus channels an action may name (the existing visitor channels — no new sense). */
const ACT_NAMES = ["food", "threat", "light", "dark"] as const;

// ─── the open condition space (a composable boolean tree, NOT an enumeration) ──────────────────────────

/** A leaf predicate: test one read-out channel against a threshold (>= when op 0, < when op 1). */
export interface CondLeaf { k: 0; ch: number; op: 0 | 1; thr: number; }
/** A branch: 1 = AND, 2 = OR, 3 = NOT (NOT reads only its first child). */
export interface CondBranch { k: 1 | 2 | 3; of: Cond[]; }
export type Cond = CondLeaf | CondBranch;

/** A norm's bounded action: name one stimulus channel and a 0..1 gain (the causal leg's shape). */
export interface NormAction { channel: number; gain: number; }

/** One emergent norm, as the ledger keeps it. */
export interface Norm {
  id: number;
  cond: Cond;
  action: NormAction;
  strength: number;          // 0..1
  depth: number;             // lineage depth (0 = minted from a cluster, +1 per mutation)
  parentId: number | null;   // the norm this variant drifted from
  adherents: number[];       // bounded membership (≤ ADHERENT_CAP)
  bornTick: number;
  lastAdherentTick: number;  // refreshed by spread + satisfied compliance (the TTL clock)
  clusterSig: number;        // the cluster signature it was minted from
  mutations: number;         // child variants this norm has spun off
}

/** The swarm-level scalar read-outs the condition tree tests — every field already 0..1. */
export interface NormsReading {
  arousal: number; cohesion: number; valence: number; rest: number;
  temperature: number; gini: number; size01: number; bond: number; rep: number;
}

/** One directed bond of the graph the membrane clusters (a pure read of economy.socialReadout().bonds). */
export interface NormBond { a: number; b: number; score: number; }

/** The facts state.ts folds in each cron — all pure read-outs, all bounded. */
export interface NormsFacts {
  tick: number;
  era: number;
  reading: NormsReading;
  bonds: NormBond[];
  ids: number[];
}

export interface NormsConfig {
  enabled: boolean;
  /** Hard ceiling (and master scale) on the causal leg's stimulus intensity, 0..0.3 (config.ts clamps it). */
  maxIntensity: number;
}

/** One norm as the public drawer sees it (a bounded projection, never the internal record). */
export interface NormView {
  id: number; norm: string; strength: number; depth: number; adherents: number; parentId: number | null; mutations: number;
}

/** The chronicle-facing edges of ONE cron + the standing read-out. */
export interface NormsSignals {
  minted: { norm: string; members: number; strength: number; era: number } | null;
  spread: { norm: string; adherents: number; strength: number } | null;
  mutated: { norm: string; depth: number; parent: number; strength: number } | null;
  died: { norm: string; lived: number; strength: number } | null;
  norms: NormView[];
  counts: { minted: number; spread: number; mutated: number; died: number };
  lineageDepth: number;
  mutationRate: number;
  compliance: number;        // 0..1 aggregate satisfied-strength share (drives the causal leg)
}

// ─── small pure helpers ──────────────────────────────────────────────────────────────────────────────────

function clamp(x: number, lo: number, hi: number): number { return x < lo ? lo : x > hi ? hi : x; }
function clamp01(x: number): number { return x < 0 ? 0 : x > 1 ? 1 : x; }
function r2(x: number): number { return Math.round(x * 100) / 100; }

/** The reading vector in the fixed channel order the leaves index into. */
function readingVector(r: NormsReading): number[] {
  const g = (x: number) => (Number.isFinite(x) ? clamp01(x) : 0);
  return [g(r.arousal), g(r.cohesion), g(r.valence), g(r.rest), g(r.temperature), g(r.gini), g(r.size01), g(r.bond), g(r.rep)];
}

/** Evaluate a condition tree against a reading vector — a pure, total, deterministic fold. */
export function evalCond(c: Cond, rv: number[]): boolean {
  if (c.k === 0) {
    const v = rv[c.ch] ?? 0;
    return c.op === 0 ? v >= c.thr : v < c.thr;
  }
  const of = c.of ?? [];
  if (c.k === 1) return of.every((x) => evalCond(x, rv));
  if (c.k === 2) return of.some((x) => evalCond(x, rv));
  return of.length ? !evalCond(of[0], rv) : false;   // NOT
}

/** A short, byte-stable ASCII label for a condition tree (the {norm} token's left half). */
export function condLabel(c: Cond): string {
  if (c.k === 0) return `${CH_NAMES[c.ch] ?? "?"}${c.op === 0 ? ">=" : "<"}${c.thr.toFixed(2)}`;
  const of = c.of ?? [];
  if (c.k === 3) return `!${of.length ? condLabel(of[0]) : "?"}`;
  const joiner = c.k === 1 ? "&" : "|";
  return `(${of.map(condLabel).join(joiner)})`;
}

/** A short, byte-stable ASCII label for an action (the {norm} token's right half). */
export function actionLabel(a: NormAction): string {
  return `${ACT_NAMES[a.channel] ?? "?"}*${clamp01(a.gain).toFixed(2)}`;
}

/** The full norm label the chronicle and drawer show: "condition->action". */
export function normLabel(n: { cond: Cond; action: NormAction }): string {
  return `${condLabel(n.cond)}->${actionLabel(n.action)}`;
}

function mkLeaf(sig: number, tick: number, i: number): CondLeaf {
  const ch = Math.floor(hash01(sig, i * 7 + 1, CH_SALT) * CH_COUNT) % CH_COUNT;
  const op: 0 | 1 = hash01(sig, i * 7 + 2, OP_SALT) < 0.5 ? 0 : 1;
  const thr = Math.round(hash01(sig, i * 7 + 3, THR_SALT) * 20) / 20;   // quantised to 0.05 steps
  return { k: 0, ch, op, thr };
}

/**
 * Derive an OPEN condition tree from a cluster signature + the minting tick. The shape (leaf / AND / OR / NOT /
 * nested) and every parameter are hash draws, so the space of expressible norms is combinatorial — far beyond any
 * enumeration a hand could write — yet fully determined by (sig, tick). Node count is bounded at 5.
 */
export function deriveCond(sig: number, tick: number): Cond {
  const shape = hash01(sig, tick, SHAPE_SALT);
  if (shape < 0.35) return mkLeaf(sig, tick, 0);
  if (shape < 0.60) { const n: Cond = { k: 1, of: [mkLeaf(sig, tick, 0), mkLeaf(sig, tick, 1)] }; return n; }
  if (shape < 0.80) { const n: Cond = { k: 2, of: [mkLeaf(sig, tick, 0), mkLeaf(sig, tick, 1)] }; return n; }
  if (shape < 0.90) { const n: Cond = { k: 3, of: [mkLeaf(sig, tick, 0)] }; return n; }
  const inner: Cond = { k: 2, of: [mkLeaf(sig, tick, 1), mkLeaf(sig, tick, 2)] };
  const n: Cond = { k: 1, of: [mkLeaf(sig, tick, 0), inner] };
  return n;
}

/** Derive a bounded action (one of four channels + a 0.2..1.0 gain in 0.05 steps) from (sig, tick). */
export function deriveAction(sig: number, tick: number): NormAction {
  const channel = Math.floor(hash01(sig, tick, ACT_SALT) * ACT_NAMES.length) % ACT_NAMES.length;
  const gain = clamp(0.2 + Math.round(hash01(sig, tick + 1, GAIN_SALT) * 16) / 20, 0, 1);
  return { channel, gain };
}

function cloneCond(c: Cond): Cond {
  if (c.k === 0) return { k: 0, ch: c.ch, op: c.op, thr: c.thr };
  return { k: c.k, of: (c.of ?? []).map(cloneCond) };
}

function collectLeaves(c: Cond, acc: CondLeaf[]): void {
  if (c.k === 0) { acc.push(c); return; }
  for (const x of c.of ?? []) collectLeaves(x, acc);
}

/**
 * The bounded ±0.1 mutation: drift exactly ONE parameter (a leaf threshold, the action gain, or the strength)
 * by ±0.1 (sign a hash draw), clamped back into [0,1] and re-quantised. This is the inheritance drift that makes
 * a spread variant a CHILD of its parent — the lineage depth and mutation rate the read-out reports.
 */
export function mutateNorm(n: Norm, sig: number, tick: number): { cond: Cond; action: NormAction; strength: number } {
  const cond = cloneCond(n.cond);
  const action: NormAction = { channel: n.action.channel, gain: n.action.gain };
  let strength = n.strength;
  const target = Math.floor(hash01(sig, tick, MTTARGET_SALT) * 3);   // 0 = a leaf thr, 1 = gain, 2 = strength
  const delta = hash01(sig, tick + 1, MUTDIR_SALT) < 0.5 ? -0.1 : 0.1;
  if (target === 0) {
    const ls: CondLeaf[] = [];
    collectLeaves(cond, ls);
    if (ls.length) {
      const li = Math.floor(hash01(sig, tick + 2, MUTLEAF_SALT) * ls.length) % ls.length;
      ls[li].thr = clamp(Math.round((ls[li].thr + delta) * 20) / 20, 0, 1);
    } else {
      strength = clamp(strength + delta, 0, 1);
    }
  } else if (target === 1) {
    action.gain = clamp(Math.round((action.gain + delta) * 20) / 20, 0, 1);
  } else {
    strength = clamp(strength + delta, 0, 1);
  }
  return { cond, action, strength };
}

/** A stable 32-bit signature over a cluster's sorted member ids. */
export function clusterSig(members: number[]): number {
  let h = 0x811c9dc5;
  for (const m of members.slice().sort((a, b) => a - b)) h = hash32(h, m, SIG_SALT);
  return h >>> 0;
}

/**
 * Deterministic label-propagation clustering of the bond graph. Each node starts labelled with its own id; over
 * LP_ITERS ascending-id passes it adopts the neighbour label carrying the most total bond weight, ties broken by
 * hash32(node, label, CLUSTER_SALT) — so the SAME graph always yields the SAME clusters, byte-for-byte.
 */
export function clusterBonds(ids: number[], bonds: NormBond[]): Map<number, number[]> {
  const nodes = ids.slice().filter((x) => Number.isFinite(x)).sort((a, b) => a - b);
  const present = new Set(nodes);
  const adj = new Map<number, { o: number; w: number }[]>();
  for (const id of nodes) adj.set(id, []);
  for (const b of bonds) {
    const w = Math.abs(Number.isFinite(b.score) ? b.score : 0);
    if (w < BOND_MIN) continue;
    if (!present.has(b.a) || !present.has(b.b) || b.a === b.b) continue;
    adj.get(b.a)!.push({ o: b.b, w });
    adj.get(b.b)!.push({ o: b.a, w });
  }
  const label = new Map<number, number>();
  for (const id of nodes) label.set(id, id);
  for (let it = 0; it < LP_ITERS; it++) {
    for (const id of nodes) {
      const nbrs = adj.get(id)!;
      if (!nbrs.length) continue;
      const tally = new Map<number, number>();
      for (const { o, w } of nbrs) { const l = label.get(o) ?? o; tally.set(l, (tally.get(l) ?? 0) + w); }
      let best = label.get(id)!;
      let bestW = -1;
      let bestH = Infinity;
      for (const [l, w] of Array.from(tally.entries()).sort((a, b) => a[0] - b[0])) {
        const h = hash32(id, l, CLUSTER_SALT);
        if (w > bestW + 1e-9 || (Math.abs(w - bestW) <= 1e-9 && h < bestH)) { bestW = w; bestH = h; best = l; }
      }
      label.set(id, best);
    }
  }
  const out = new Map<number, number[]>();
  for (const id of nodes) { const l = label.get(id)!; if (!out.has(l)) out.set(l, []); out.get(l)!.push(id); }
  return out;
}

// ─── the membrane ──────────────────────────────────────────────────────────────────────────────────────────

interface ClusterTrack { run: number; miss: number; members: number[]; lastMint: number; }

export class NormsMembrane {
  private norms = new Map<number, Norm>();
  private clusters = new Map<number, ClusterTrack>();
  private nextId = 1;
  private counts = { minted: 0, spread: 0, mutated: 0, died: 0 };
  private compliance = 0;
  /** H3 fix: "already mutated" memory — prevents the same (norm, dst) pair from spawning a child every cron. */
  private mutatedPairs = new OnceGuard(MUT_GUARD_CAP);
  private pending: NormsSignals = {
    minted: null, spread: null, mutated: null, died: null,
    norms: [], counts: { ...this.counts }, lineageDepth: 0, mutationRate: 0, compliance: 0,
  };

  constructor(private readonly cfg: NormsConfig) {}

  /** One round per cron, AFTER driveLand and BEFORE observeChronicle — pure read-out end to end. */
  round(facts: NormsFacts): void {
    if (!this.cfg.enabled) return;
    // Reset THIS cron's edges; keep the standing fields (refreshPending() rebuilds them at the tail).
    this.pending = {
      minted: null, spread: null, mutated: null, died: null,
      norms: this.view(), counts: { ...this.counts },
      lineageDepth: this.maxDepth(), mutationRate: this.mutRate(), compliance: this.compliance,
    };
    const tick = Math.max(0, Math.floor(Number.isFinite(facts.tick) ? facts.tick : 0));

    // 1) cluster the bond graph deterministically, then track each cluster's stability and mint when it holds.
    const clusters = clusterBonds(facts.ids, facts.bonds);
    this.trackClusters(clusters, tick, facts.era);

    // 2) spread every norm along the bonds (hash-gated adoption), mutating some spreads into child variants.
    this.spread(facts.bonds, tick);

    // 3) compliance: a norm whose condition the swarm's read-out satisfies this cron reinforces (and the
    //    aggregate satisfied share becomes the causal leg's climate).
    this.evaluate(facts.reading, tick);

    // 4) decay + TTL + hysteresis: every norm pays the decay; the unloved and the old die.
    this.decay(tick);

    // Read-out closes on the END-of-round truth.
    this.refreshPending();
  }

  private trackClusters(clusters: Map<number, number[]>, tick: number, era: number): void {
    const seen = new Set<number>();
    for (const [, members] of Array.from(clusters.entries()).sort((a, b) => a[0] - b[0])) {
      if (members.length < MIN_CLUSTER) continue;
      const sig = clusterSig(members);
      seen.add(sig);
      let c = this.clusters.get(sig);
      if (!c) { c = { run: 0, miss: 0, members, lastMint: -MINT_COOLDOWN }; this.clusters.set(sig, c); }
      c.run++;
      c.miss = 0;
      c.members = members.slice(0, ADHERENT_CAP);
      if (c.run >= MINT_STABLE_RUN && tick - c.lastMint >= MINT_COOLDOWN && this.norms.size < NORM_CAP) {
        this.mint(sig, members, tick, era);
        c.lastMint = tick;
        c.run = 0;                                  // must re-stabilise before the next mint
      }
    }
    for (const [sig, c] of Array.from(this.clusters.entries())) {
      if (seen.has(sig)) continue;
      c.run = 0;
      c.miss++;
      if (c.miss >= CLUSTER_MISS) this.clusters.delete(sig);
    }
  }

  private mint(sig: number, members: number[], tick: number, era: number): void {
    const cond = deriveCond(sig, tick);
    const action = deriveAction(sig, tick);
    const id = this.nextId++;
    const norm: Norm = {
      id, cond, action, strength: MINT_STRENGTH, depth: 0, parentId: null,
      adherents: members.slice(0, ADHERENT_CAP), bornTick: tick, lastAdherentTick: tick,
      clusterSig: sig, mutations: 0,
    };
    this.norms.set(id, norm);
    this.counts.minted++;
    if (!this.pending.minted) {
      this.pending.minted = { norm: normLabel(norm), members: members.length, strength: r2(MINT_STRENGTH), era };
    }
  }

  private spread(bonds: NormBond[], tick: number): void {
    for (const norm of Array.from(this.norms.values()).sort((a, b) => a.id - b.id)) {
      const adh = new Set(norm.adherents);
      for (const b of bonds) {
        const w = Math.abs(Number.isFinite(b.score) ? b.score : 0);
        if (w < BOND_MIN) continue;
        let dst = -1;
        if (adh.has(b.a) && !adh.has(b.b)) dst = b.b;
        else if (adh.has(b.b) && !adh.has(b.a)) dst = b.a;
        else continue;
        const p = clamp(w * norm.strength * SPREAD_GAIN, 0, SPREAD_CAP);
        // id-only draw ⇒ adoption is monotonic in strength: a mind that joins stays joined as p grows.
        if (hash01(norm.id, dst, SPREAD_SALT) >= p) continue;
        // H3 fix: the onceGuard prevents the same (norm, dst) from spawning a mutation every cron.
        const mutKey = `${norm.id}:${dst}`;
        if (hash01(norm.id, dst, MUT_SALT) < MUT_P && this.norms.size < NORM_CAP
            && this.mutatedPairs.claim(mutKey)) {
          this.mutateChild(norm, dst, tick);
        } else {
          if (norm.adherents.length < ADHERENT_CAP) norm.adherents.push(dst);
          adh.add(dst);
          norm.lastAdherentTick = tick;
          this.counts.spread++;
          if (!this.pending.spread) {
            this.pending.spread = { norm: normLabel(norm), adherents: norm.adherents.length, strength: r2(norm.strength) };
          }
        }
      }
    }
  }

  private mutateChild(parent: Norm, dst: number, tick: number): void {
    const sig = hash32(parent.id, dst, MUTSIG_SALT);
    const m = mutateNorm(parent, sig, tick);
    const id = this.nextId++;
    const child: Norm = {
      id, cond: m.cond, action: m.action, strength: clamp(MINT_STRENGTH * 0.8, 0, 1),
      depth: parent.depth + 1, parentId: parent.id, adherents: [dst], bornTick: tick, lastAdherentTick: tick,
      clusterSig: parent.clusterSig, mutations: 0,
    };
    this.norms.set(id, child);
    parent.mutations++;
    // H3 fix: removed `parent.lastAdherentTick = tick` — a mutation is NOT a compliance event for the parent;
    // resetting its TTL here made norms effectively immortal (the decay/TTL mechanism was dead).
    this.counts.mutated++;
    if (!this.pending.mutated) {
      this.pending.mutated = { norm: normLabel(child), depth: child.depth, parent: parent.id, strength: r2(child.strength) };
    }
  }

  private evaluate(reading: NormsReading, tick: number): void {
    if (!this.norms.size) { this.compliance = 0; return; }
    const rv = readingVector(reading);
    let satW = 0;
    let totW = 0;
    for (const n of Array.from(this.norms.values()).sort((a, b) => a.id - b.id)) {
      totW += n.strength;
      if (evalCond(n.cond, rv)) {
        satW += n.strength;
        n.strength = clamp(n.strength + COMPLIANCE_GAIN, 0, 1);
        n.lastAdherentTick = tick;                  // satisfied adherence resets the TTL clock
      }
    }
    this.compliance = totW > 0 ? clamp01(satW / totW) : 0;
  }

  private decay(tick: number): void {
    for (const [id, n] of Array.from(this.norms.entries()).sort((a, b) => a[0] - b[0])) {
      n.strength = clamp(n.strength - DECAY, 0, 1);
      if (n.strength <= DIE_STRENGTH || tick - n.lastAdherentTick > TTL) {
        this.norms.delete(id);
        this.counts.died++;
        if (!this.pending.died) {
          this.pending.died = { norm: normLabel(n), lived: Math.max(0, tick - n.bornTick), strength: r2(n.strength) };
        }
      }
    }
  }

  /**
   * THE CAUSAL LEG — a swarm-wide Channel-A stimulus, hard-capped at cfg.maxIntensity (≤ 0.3). Compliance the
   * swarm is living up to tastes of plenty and light; compliance it is violating is a bounded threat. Channel A
   * has no per-fly addressing, so the leg AGGREGATES the satisfied-strength share exactly as the civic bus ①
   * aggregates the climate — faithful to the model, and inert (empty array) with no live norm or a zero ceiling.
   */
  stimuli(cfg: { maxIntensity: number }): StimulusEvent[] {
    if (!this.cfg.enabled || !this.norms.size) return [];
    // L12 fix: apply the HARD stimulus ceiling independently of config.ts (defence in depth).
    const cap = Math.min(STIMULUS_HARD_CAP, clamp01(cfg.maxIntensity));
    // NaN-safe gate: `!(cap > 0)` is true for both 0 and NaN, so a malformed ceiling can never leak a NaN.
    if (!(cap > 0)) return [];
    const c = this.compliance;
    const out: StimulusEvent[] = [];
    if (c > 0.5) {
      const x = (c - 0.5) * 2;                                   // 0..1
      out.push({ type: "food", intensity: clamp01(0.3 + 0.7 * x) * cap, from: "norms" });
      out.push({ type: "light", intensity: clamp01(0.2 + 0.5 * x) * cap, from: "norms" });
    } else if (c < 0.5) {
      const x = (0.5 - c) * 2;                                   // 0..1
      out.push({ type: "threat", intensity: clamp01(0.3 + 0.7 * x) * cap, from: "norms" });
    }
    return out;
  }

  signals(): NormsSignals { return this.pending; }

  /**
   * ㉜←㉛ ABSORB a convention the conventions membrane promoted: when a local custom spreads wide and holds
   * stable, it is offered up and MAY be lifted into a society-wide norm. Hash-gated (ABSORB_P), bounded by
   * NORM_CAP, and fully deterministic — the absorbed norm's OPEN condition/action derive from the convention's
   * own signature exactly as a cluster-minted norm's do, so the two emergent layers compose without either
   * touching money, a cap or a settlement. Returns true iff a norm was actually minted. Inert while disabled.
   */
  absorb(seed: { sig: number; tick: number; era: number; strength: number; origin?: string }): boolean {
    if (!this.cfg.enabled) return false;
    if (this.norms.size >= NORM_CAP) return false;
    const sig = (Number.isFinite(seed.sig) ? Math.floor(seed.sig) : 0) >>> 0;
    const tick = Math.max(0, Math.floor(Number.isFinite(seed.tick) ? seed.tick : 0));
    if (!(hash01(sig, tick, ABSORB_SALT) < ABSORB_P)) return false;   // hash-gated: only some promotions take
    const cond = deriveCond(sig, tick);
    const action = deriveAction(sig, tick);
    const id = this.nextId++;
    const norm: Norm = {
      id, cond, action, strength: clamp01(seed.strength), depth: 0, parentId: null,
      adherents: [], bornTick: tick, lastAdherentTick: tick, clusterSig: sig, mutations: 0,
    };
    this.norms.set(id, norm);
    this.counts.minted++;
    if (!this.pending.minted) {
      this.pending.minted = { norm: normLabel(norm), members: 0, strength: r2(norm.strength), era: Math.floor(Number.isFinite(seed.era) ? seed.era : 0) };
    }
    this.refreshPending();
    return true;
  }

  /**
   * Rebuild the STANDING read-out fields (norm list / counts / lineage / mutation rate / compliance) from the
   * membrane's own internal state — pure and side-effect free: it clusters nothing, mints nothing, spreads
   * nothing and never fires the causal leg. restore() calls it so a DO reload reflects the persisted society at
   * once, and the /economy read-out calls it so the public numbers never lag a cron. This cron's edge events
   * (minted / spread / mutated / died) are preserved as round() left them (null after a fresh restore).
   */
  refreshPending(): void {
    this.pending = {
      ...this.pending,
      norms: this.view(),
      counts: { ...this.counts },
      lineageDepth: this.maxDepth(),
      mutationRate: this.mutRate(),
      compliance: this.compliance,
    };
  }

  private view(): NormView[] {
    return Array.from(this.norms.values())
      .sort((a, b) => b.strength - a.strength || a.id - b.id)
      .slice(0, NORM_CAP)
      .map((n) => ({
        id: n.id, norm: normLabel(n), strength: r2(n.strength), depth: n.depth,
        adherents: n.adherents.length, parentId: n.parentId, mutations: n.mutations,
      }));
  }

  private maxDepth(): number {
    let d = 0;
    for (const n of this.norms.values()) if (n.depth > d) d = n.depth;
    return d;
  }

  private mutRate(): number {
    const denom = this.counts.spread + this.counts.mutated;
    return denom > 0 ? Math.round((this.counts.mutated / denom) * 1000) / 1000 : 0;
  }

  // ─── persistence (bounded, additive; a corrupt blob restarts an empty society, never a poisoned ledger) ─

  serialize(): string {
    const norms = Array.from(this.norms.values())
      .sort((a, b) => a.id - b.id)
      .slice(0, NORM_CAP)
      .map((n) => ({
        id: n.id, cond: n.cond, action: n.action, strength: r2(n.strength), depth: n.depth,
        parentId: n.parentId, adherents: n.adherents.slice(0, ADHERENT_CAP), bornTick: n.bornTick,
        lastAdherentTick: n.lastAdherentTick, clusterSig: n.clusterSig, mutations: n.mutations,
      }));
    const clusters = Array.from(this.clusters.entries())
      .sort((a, b) => b[1].run - a[1].run || a[0] - b[0])
      .slice(0, CLUSTER_CAP)
      .map(([sig, c]) => ({ sig, run: c.run, miss: c.miss, members: c.members.slice(0, ADHERENT_CAP), lastMint: c.lastMint }));
    // mutatedPairs: undefined when empty ⇒ JSON.stringify omits the key ⇒ byte-for-byte equivalence with pre-guard blobs.
    const mutatedPairs = this.mutatedPairs.serialize();
    return JSON.stringify({ v: NORMS_VERSION, nextId: this.nextId, counts: this.counts, compliance: r2(this.compliance), norms, clusters, mutatedPairs });
  }

  restore(blob: unknown): void {
    this.norms.clear();
    this.clusters.clear();
    this.mutatedPairs.clear();
    this.nextId = 1;
    this.counts = { minted: 0, spread: 0, mutated: 0, died: 0 };
    this.compliance = 0;
    if (typeof blob !== "string" || !blob) { this.refreshPending(); return; }
    try {
      const p = JSON.parse(blob);
      if (!p || typeof p !== "object") { this.refreshPending(); return; }
      const num = (x: unknown, d: number) => (Number.isFinite(Number(x)) ? Number(x) : d);
      const c = p.counts ?? {};
      this.counts = {
        minted: Math.max(0, Math.floor(num(c.minted, 0))), spread: Math.max(0, Math.floor(num(c.spread, 0))),
        mutated: Math.max(0, Math.floor(num(c.mutated, 0))), died: Math.max(0, Math.floor(num(c.died, 0))),
      };
      this.compliance = clamp01(num(p.compliance, 0));
      this.nextId = Math.max(1, Math.floor(num(p.nextId, 1)));
      if (Array.isArray(p.norms)) {
        for (const e of p.norms) {
          if (!e || typeof e !== "object") continue;
          if (this.norms.size >= NORM_CAP) break;
          const cond = parseCond(e.cond, 0);
          if (!cond) continue;
          const id = Math.floor(num(e.id, this.nextId));
          if (!Number.isFinite(id) || id < 1) continue;
          const action = e.action && typeof e.action === "object"
            ? { channel: Math.floor(clamp(num((e.action as Record<string, unknown>).channel, 0), 0, ACT_NAMES.length - 1)), gain: clamp01(num((e.action as Record<string, unknown>).gain, 0.5)) }
            : { channel: 0, gain: 0.5 };
          const norm: Norm = {
            id, cond, action,
            strength: clamp01(num(e.strength, MINT_STRENGTH)),
            depth: Math.max(0, Math.floor(num(e.depth, 0))),
            parentId: Number.isFinite(Number(e.parentId)) && e.parentId != null ? Math.floor(Number(e.parentId)) : null,
            adherents: Array.isArray(e.adherents) ? e.adherents.filter((x: unknown) => Number.isFinite(Number(x))).slice(0, ADHERENT_CAP).map((x: unknown) => Math.floor(Number(x))) : [],
            bornTick: Math.max(0, Math.floor(num(e.bornTick, 0))),
            lastAdherentTick: Math.max(0, Math.floor(num(e.lastAdherentTick, 0))),
            clusterSig: Math.floor(num(e.clusterSig, 0)) >>> 0,
            mutations: Math.max(0, Math.floor(num(e.mutations, 0))),
          };
          this.norms.set(id, norm);
          if (id >= this.nextId) this.nextId = id + 1;
        }
      }
      if (Array.isArray(p.clusters)) {
        for (const e of p.clusters) {
          if (!e || typeof e !== "object") continue;
          if (this.clusters.size >= CLUSTER_CAP) break;
          const sig = Math.floor(num(e.sig, 0)) >>> 0;
          this.clusters.set(sig, {
            run: Math.max(0, Math.floor(num(e.run, 0))), miss: Math.max(0, Math.floor(num(e.miss, 0))),
            members: Array.isArray(e.members) ? e.members.filter((x: unknown) => Number.isFinite(Number(x))).slice(0, ADHERENT_CAP).map((x: unknown) => Math.floor(Number(x))) : [],
            lastMint: Math.floor(num(e.lastMint, 0)),
          });
        }
      }
      // H3 fix: restore the mutation once-guard (a missing/corrupt key silently degrades to empty — the CAP still binds).
      this.mutatedPairs.restore(p.mutatedPairs);
    } catch { /* corrupt → an empty society, nothing minted, nothing told */ }
    // Rebuild the read-out from the just-restored state so signals() is truthful BEFORE the next round().
    this.refreshPending();
  }
}

/** Parse + validate a stored condition tree (bounded depth, clamped params); null ⇒ the norm is dropped. */
function parseCond(x: unknown, depth: number): Cond | null {
  if (!x || typeof x !== "object" || depth > 4) return null;
  const o = x as Record<string, unknown>;
  const k = Number(o.k);
  if (k === 0) {
    const ch = Math.floor(Number(o.ch));
    const op = Number(o.op);
    const thr = Number(o.thr);
    if (!Number.isInteger(ch) || ch < 0 || ch >= CH_COUNT) return null;
    if (op !== 0 && op !== 1) return null;
    if (!Number.isFinite(thr)) return null;
    return { k: 0, ch, op: op as 0 | 1, thr: clamp(thr, 0, 1) };
  }
  if (k === 1 || k === 2 || k === 3) {
    if (!Array.isArray(o.of)) return null;
    const of: Cond[] = [];
    for (const ch of o.of.slice(0, 4)) { const p = parseCond(ch, depth + 1); if (p) of.push(p); }
    if (!of.length) return null;
    if (k === 3) of.length = 1;
    return { k: k as 1 | 2 | 3, of };
  }
  return null;
}

// FNV-1a 32-bit + a uniform 0..1 draw — the SAME construction every membrane duplicates by design (private
// salts ⇒ a norms draw can alias no culture, faith, rumor or economy draw).
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
