// Phase 3, capability ③ — INTERGENERATIONAL KNOWLEDGE TRANSFER (cultural + Lamarckian).
//
// Three transmission channels are pinned here:
//   (a) vertical strategy-tree inheritance  — a真亲子 hatch seeds the child's GP tree by mutating the parent's;
//   (b) vertical cultural transmission      — a真亲子 hatch copies a DISCOUNTED parent bond/rep prior + a
//                                             COMPRESSED playbook summary into the child (bounded, deterministic);
//   (c) Lamarckian genome imprinting        — a parent's lifetime performance biases the child's 4 heritable
//                                             genome scalars ±5% (clamped) on top of mutate/cross, before hashing.
//
// The two invariants that MUST hold (and are the reason these tests exist):
//   1. DOUBLE-INHERITANCE GUARD: an id-reuse hatch (reopenSlot recolonises a dead fly's id) must NEVER inherit
//      the dead fly's residual social/playbook/tree — only the TRUE parent's discounted prior. Since the M4 fix
//      reopenSlot performs that erasure UNCONDITIONALLY (independent of CULTURAL_ENABLED), so the guard holds
//      even on a cultural-OFF deployment; transmitCulture's own wipe is now defence in depth.
//   2. DEFAULT-OFF INERTNESS: with CULTURAL/LAMARCK unset the child hatches blank — no memory copied,
//      lamarckVector() null, the genome exactly the mutate/cross output. On a BRAND-NEW id this is byte-for-byte
//      the Phase 2b build; on an id-reuse hatch the residue is now erased (the deliberate M4 behaviour change —
//      it only fires when the dynasty layer recycles a retired id, never on the dark-deployment normal path).
//
// Everything is deterministic (FNV-1a hash-derived seeds; zero Math.random / Date.now in any inherited state)
// and additive (KEY_VERSION stays "economy:v1"; an old blob with no parent memory simply yields no prior).

import test from "node:test";
import assert from "node:assert/strict";

import { AgentEconomy, type EconomyConfig, type PlaybookEntry } from "./economy.js";
import type { FlyReading, CollectiveState } from "./population.js";
import { applyBreed, genomeHash, type LineageEntry, type GenomeImprint } from "./breed.js";
import { loadConfig, type Env } from "./config.js";
import {
  FLYWIRE_GENOME_BOUNDS,
  treeHash,
  isLegalTree,
  type Genome,
} from "@fly/fly-brain";

// ---------- helpers ----------

const HASH_A = "a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90";
const HASH_B = "0f1e2d3c4b5a69788796a5b4c3d2e1f00f1e2d3c4b5a69788796a5b4c3d2e1f0";

/** Deterministic simulated-mode config; the Phase 3 layers are OFF unless the caller arms them. */
function cfg(over: Partial<EconomyConfig> = {}): EconomyConfig {
  return {
    enabled: true,
    network: "arc",
    initialBalanceUsdc: 6,
    basePriceUsdc: 0.002,
    solvencyFloorUsdc: 0.5,
    maxDealsPerTick: 24,
    facilitatorMode: "simulated",
    seedBase: 42,
    realSpendEnabled: false,
    dailyCapUsdc: 0,
    perAgentDailyCapUsdc: 0,
    maxDealUsdc: 0,
    netMinBroadcastUsdc: 0,
    netFlushTicks: 0,
    populationSize: 24,
    hatchSeedUsdc: 0.002,
    ...over,
  };
}

function reading(id: number, state: FlyReading["state"], over: Partial<FlyReading> = {}): FlyReading {
  return {
    id, state,
    arousal: 0.9, turnBias: id % 2 ? 0.4 : -0.4, cohesion: 0.5,
    wingbeat: 0.8, rest: 0.05, temperament: (id * 7919) % 1000 / 1000,
    fingerprint: `fp${id}`,
    fap: "FORAGE", valence: 0, heading: 0, role: "signal-seeker", bouts: [],
    neuromod: { dopamine: 0, octopamine: 0, learningRateGate: 0, daHz: 0, oaHz: 0 },
    ...over,
  };
}

function collective(temperature = 0.5): CollectiveState {
  return {
    temperature, regime: temperature >= 0.66 ? "HOT" : temperature <= 0.33 ? "COLD" : "CALM",
    vitality: temperature, size: 24, arousal: 0.7, cohesion: 0.5, rest: 0.1, wingbeat: 0.6,
    states: { AGITATE: 0, EXPLORE: 0, AGGREGATE: 0, REST: 0 },
    faps: {}, valence: 0,
    meanDopamine: 0, meanOctopamine: 0, meanDaHz: 0, meanOaHz: 0,
  };
}

const population = (state: FlyReading["state"], n = 24) =>
  Array.from({ length: n }, (_, i) => reading(i, state));

/** A minimal valid Env for loadConfig (only the required fields matter; the rest default). */
function env(over: Partial<Env> = {}): Env {
  return {
    FLY_STATE: {} as Env["FLY_STATE"],
    CHAIN_ID: "5042002",
    RPC_URL: "https://rpc.testnet.arc.io",
    ...over,
  } as Env;
}

/**
 * Serialize → mutate the blob → reconstruct: the only way to inject an EXACT parent memory (bonds/playbook/
 * goodCounts/dead-set) so the discount, compression and imprint arithmetic can be asserted to the digit.
 */
function reseed(econ: AgentEconomy, config: EconomyConfig, mutate: (blob: any) => void): AgentEconomy {
  const blob = JSON.parse(econ.serialize());
  mutate(blob);
  return new AgentEconomy(config, JSON.stringify(blob));
}

/** A FlyWire-mode genome literal (fixed topology + the 4 heritable scalars at their calibrated defaults). */
function flywireGenome(over: Partial<Genome> = {}): Genome {
  return {
    v: 1, seed: 4242, nSensory: 24, nInterL1: 40, nInterL2: 40,
    nModulatory: 12, nMotorPerChannel: 10, density: 0.5,
    weightGain: 0.22, threshGain: 1.0, tauGain: 1.0, weightJitter: 0.30,
    ...over,
  };
}

const near = (a: number, b: number, tol = 1e-6) => Math.abs(a - b) <= tol;

// ============================================================ CONFIG GATES (default OFF)

test("config: CULTURAL/LAMARCK gates default OFF and arm only on the exact string 'true'", () => {
  const off = loadConfig(env({}));
  assert.equal(off.cultural.enabled, false, "CULTURAL_TRANSMISSION_ENABLED unset ⇒ OFF (dark deploy)");
  assert.equal(off.lamarck.enabled, false, "LAMARCK_ENABLED unset ⇒ OFF (dark deploy)");

  const on = loadConfig(env({ CULTURAL_TRANSMISSION_ENABLED: "true", LAMARCK_ENABLED: "TRUE" }));
  assert.equal(on.cultural.enabled, true, "case-insensitive 'true'/'TRUE' arms cultural");
  assert.equal(on.lamarck.enabled, true, "case-insensitive arms lamarck");

  assert.equal(loadConfig(env({ CULTURAL_TRANSMISSION_ENABLED: "1" })).cultural.enabled, false, "only 'true' arms");
  assert.equal(loadConfig(env({ LAMARCK_ENABLED: "false" })).lamarck.enabled, false, "'false' ⇒ OFF");
});

// ============================================================ (b) CULTURAL: bond/rep discount

test("cultural: a真亲子 hatch copies the parent's bonds at +50%/−25% and rep at +50% (discounted prior)", async () => {
  const config = cfg({ dynasty: {}, playbook: { enabled: true }, cultural: { enabled: true } });
  const base = new AgentEconomy(config);
  await base.step(population("AGITATE"), collective(0.5), 10);   // tickIndex = 10

  // Inject an EXACT parent memory for #3: a trusted partner (+0.8), a grudge (−0.6), a good name (+0.9).
  // lastTick = 10 = the current tick ⇒ fadeBond is a no-op, so the discount is the only transform.
  const econ = reseed(base, config, (blob) => {
    blob.social.mem = [{
      id: 3, rep: 0.9, repTick: 10, kept: 5, broken: 1,
      bonds: [
        { other: 5, score: 0.8, trades: 4, lastTick: 10 },
        { other: 7, score: -0.6, trades: 2, lastTick: 10 },
      ],
    }];
  });

  econ.noteHatch(3, 24, HASH_A);
  const child = econ.getSocial(24);
  assert.ok(child, "the child is born with a social record");
  assert.ok(near(child!.rep, 0.45), `rep inherited at 50% ⇒ 0.45, got ${child!.rep}`);
  assert.equal(child!.bonds.length, 2, "both parent bonds are inherited (discounted)");

  const trust = child!.bonds.find((b) => b.other === 5)!;
  const grudge = child!.bonds.find((b) => b.other === 7)!;
  assert.ok(near(trust.score, 0.4), `POSITIVE bond ×50% ⇒ +0.4, got ${trust.score}`);
  assert.ok(near(grudge.score, -0.15), `NEGATIVE bond ×25% ⇒ −0.15, got ${grudge.score}`);
  assert.equal(trust.trades, 0, "an inherited prior carries no lived dealings of its own");
  assert.equal(trust.lastTick, 10, "the inherited bond ages on the hatch clock");
});

test("cultural: the inherited prior can never exceed the parent's own lived memory (clamp + prune to top-K)", async () => {
  const config = cfg({ dynasty: {}, cultural: { enabled: true } });
  const base = new AgentEconomy(config);
  await base.step(population("AGITATE"), collective(0.5), 5);

  // A parent with a saturated bond (+1.0) and MORE than BOND_TOP_K(8) bonds: the child's prior must stay
  // clamped to [−1,1] and pruned to ≤8 (so it never grows DO storage beyond the parent's own budget).
  const manyBonds = Array.from({ length: 12 }, (_, i) => ({ other: 100 + i, score: 1.0, trades: i, lastTick: 5 }));
  const econ = reseed(base, config, (blob) => {
    blob.social.mem = [{ id: 2, rep: 1.0, repTick: 5, kept: 9, broken: 0, bonds: manyBonds }];
  });

  econ.noteHatch(2, 24, HASH_A);
  const child = econ.getSocial(24)!;
  assert.ok(child.bonds.length <= 8, `pruned to BOND_TOP_K, got ${child.bonds.length}`);
  for (const b of child.bonds) {
    assert.ok(b.score >= -1 && b.score <= 1, `inherited score clamped to [−1,1], got ${b.score}`);
    assert.ok(b.score <= 0.5 + 1e-9, "a +1.0 parent bond inherits at most +0.5 (never exceeds the parent)");
  }
  assert.ok(child.rep <= 0.5 + 1e-9, "a +1.0 parent rep inherits at most +0.5");
});

// ============================================================ (b) CULTURAL: double-inheritance guard

test("cultural: an id-reuse hatch inherits ONLY the true parent — NEVER the dead fly's residue (double-inheritance guard)", async () => {
  const config = cfg({ dynasty: { oldAgeTicks: 5, penuryGraceTicks: 1_000_000 }, playbook: { enabled: true }, cultural: { enabled: true } });
  const base = new AgentEconomy(config);
  await base.step(population("EXPLORE"), collective(0.3), 10);   // tickIndex = 10

  // #0 is a DEAD fly whose slot will be recycled; it leaves a distinctive residue (a +0.9 bond to #9 and a
  // playbook ring full of good=3/regime=2 losses). #1 is the TRUE parent (a −0.8 bond to #9, a good=0 ring).
  const econ = reseed(base, config, (blob) => {
    blob.social.mem = [
      { id: 0, rep: 0.7, repTick: 10, kept: 3, broken: 0, bonds: [{ other: 9, score: 0.9, trades: 3, lastTick: 10 }] },
      { id: 1, rep: -0.4, repTick: 10, kept: 1, broken: 2, bonds: [{ other: 9, score: -0.8, trades: 2, lastTick: 10 }] },
    ];
    blob.dynasty.dead = [0];                                    // #0 is tombstoned ⇒ its id is a recycled slot
    blob.playbook = [
      { id: 0, e: [[0, 0, 3, 2, -5000, 0, 9], [0, 0, 3, 2, -4000, 0, 9]] },   // dead fly's residue
      { id: 1, e: [[0, 0, 0, 0, 1000, 1, 9], [0, 0, 0, 0, 600, 1, 9]] },      // true parent's ring
    ];
  });

  // Sanity: before the recycled hatch, the dead fly's residue is still keyed to id 0 (the erasure happens IN the hatch).
  assert.ok(econ.getSocial(0)?.bonds.some((b) => b.other === 9 && b.score > 0), "the dead fly's residue is present pre-hatch");

  econ.noteHatch(1, 0, HASH_B);                                 // #1 hatches a newborn INTO retired id 0
  assert.equal(econ.isDead(0), false, "the slot reopened — #0 lives again as a NEW individual");

  const reborn = econ.getSocial(0)!;
  assert.equal(reborn.bonds.length, 1, "exactly one bond — the true parent's, not the dead fly's");
  const b = reborn.bonds[0];
  assert.equal(b.other, 9);
  assert.ok(near(b.score, -0.2), `inherits #1's −0.8 ×25% ⇒ −0.2, got ${b.score} (the dead fly's +0.9 must NOT leak)`);
  assert.ok(b.score < 0, "the rebond is the parent's GRUDGE, never the dead fly's trust");
  assert.ok(near(reborn.rep, -0.2), `rep inherits #1's −0.4 ×50% ⇒ −0.2, got ${reborn.rep}`);

  // The playbook residue is wiped too: the child carries a compressed summary of #1's ring (good=0), never #0's (good=3).
  const ring = econ.getPlaybook(0)!;
  assert.ok(ring, "the reborn fly has a playbook prior");
  assert.ok(ring.every((e) => e.good !== 3), "the dead fly's good=3 residue is gone");
  assert.ok(ring.some((e) => e.good === 0 && e.regime === 0), "the true parent's good=0 bucket is inherited");
});

test("cultural OFF: an id-reuse hatch ERASES the residue (M4 hygiene) and copies nothing", async () => {
  // Same scenario, cultural NOT armed ⇒ transmitCulture is a no-op, but reopenSlot's UNCONDITIONAL id-reuse
  // hygiene (M4 fix) wipes the dead fly's social/playbook residue anyway: a reborn individual must never
  // inherit a stranger's bonds/grudges/episodic memory. No parent prior is copied either (that stays gated
  // behind culturalOn()). Dark-deployment note: reopenSlot only runs on an id-reuse hatch (dynasty layer
  // live), so a CULTURAL=OFF, dynasty=OFF deployment stays byte-for-byte the Phase 2b path.
  const config = cfg({ dynasty: { oldAgeTicks: 5, penuryGraceTicks: 1_000_000 }, playbook: { enabled: true } });
  const base = new AgentEconomy(config);
  await base.step(population("EXPLORE"), collective(0.3), 10);

  const econ = reseed(base, config, (blob) => {
    blob.social.mem = [
      { id: 0, rep: 0.7, repTick: 10, kept: 3, broken: 0, bonds: [{ other: 9, score: 0.9, trades: 3, lastTick: 10 }] },
      { id: 1, rep: -0.4, repTick: 10, kept: 1, broken: 2, bonds: [{ other: 9, score: -0.8, trades: 2, lastTick: 10 }] },
    ];
    blob.dynasty.dead = [0];
  });

  econ.noteHatch(1, 0, HASH_B);
  // M4: the dead fly's residue is erased on slot reuse even with cultural OFF — no bond survives at all.
  assert.equal(econ.getSocial(0), undefined, "cultural OFF: reopenSlot still wipes the dead fly's social residue (M4)");
  assert.equal(econ.getPlaybook(0), undefined, "cultural OFF: the dead fly's playbook ring is wiped too (M4)");
});

// ============================================================ (b) CULTURAL: playbook compression

test("cultural: the playbook prior is a COMPRESSED (good,regime) summary — mean outcome ×50% + valid rate, ring ≤ 16", async () => {
  const config = cfg({ dynasty: {}, playbook: { enabled: true }, cultural: { enabled: true } });
  const base = new AgentEconomy(config);
  await base.step(population("EXPLORE"), collective(0.5), 10);

  // Parent #2's ring: bucket (good0,regime0) = [+100,+300,−50] valid[1,1,0]; bucket (good1,regime2) = [−200] valid[0].
  const econ = reseed(base, config, (blob) => {
    blob.playbook = [{
      id: 2, e: [
        [7, 0, 0, 0, 100, 1, 9], [7, 0, 0, 0, 300, 1, 9], [7, 0, 0, 0, -50, 0, 9],
        [7, 0, 1, 2, -200, 0, 9],
      ],
    }];
  });

  econ.noteHatch(2, 25, HASH_A);
  const ring = econ.getPlaybook(25)!;
  assert.ok(ring, "the child is born with a compressed playbook prior");
  assert.equal(ring.length, 2, "two occupied (good,regime) buckets ⇒ two summary entries (not a 4-entry copy)");
  assert.ok(ring.length <= 16, "the ring never exceeds PLAYBOOK_CAP");

  // Emitted in fixed (good asc, regime asc) order ⇒ [0] = (0,0), [1] = (1,2).
  const b00 = ring[0];
  assert.equal(b00.good, 0); assert.equal(b00.regime, 0);
  // mean(100,300,−50) = 116.667; ×0.5 = 58.33 ⇒ round 58. validRate 2/3 ≥ 0.5 ⇒ 1.
  assert.equal(b00.outcome, 58, `mean outcome ×50% rounded ⇒ 58, got ${b00.outcome}`);
  assert.equal(b00.valid, 1, "a ≥50%-valid bucket inherits as valid");

  const b12 = ring[1];
  assert.equal(b12.good, 1); assert.equal(b12.regime, 2);
  assert.equal(b12.outcome, -100, "mean(−200) ×50% ⇒ −100");
  assert.equal(b12.valid, 0, "a 0%-valid bucket inherits as invalid");
});

test("cultural: a full 16-entry parent ring compresses to ≤12 buckets — the child ring stays under PLAYBOOK_CAP", async () => {
  const config = cfg({ dynasty: {}, playbook: { enabled: true }, cultural: { enabled: true } });
  const base = new AgentEconomy(config);
  await base.step(population("EXPLORE"), collective(0.5), 4);

  // Fill all 4 goods × 3 regimes = 12 buckets (16 entries, some buckets repeated) — the widest possible ring.
  const e: number[][] = [];
  for (let good = 0; good < 4; good++) {
    for (let regime = 0; regime < 3; regime++) {
      e.push([1, 0, good, regime, 100 + good * 10 + regime, 1, 3]);
    }
  }
  while (e.length < 16) e.push([1, 0, 0, 0, 50, 1, 3]);   // pad bucket (0,0) to reach the 16-entry cap
  const econ = reseed(base, config, (blob) => { blob.playbook = [{ id: 6, e: e.slice(0, 16) }]; });

  econ.noteHatch(6, 24, HASH_A);
  const ring = econ.getPlaybook(24)!;
  assert.equal(ring.length, 12, "12 distinct (good,regime) buckets ⇒ 12 summary entries");
  assert.ok(ring.length <= 16, "hard PLAYBOOK_CAP bound respected even from a maximal parent ring");
});

// ============================================================ (c) LAMARCK: performance vector

test("lamarck: lamarckVector derives a deterministic, bounded [−1,1]^4 performance signal from the parent's record", async () => {
  const config = cfg({ dynasty: {}, playbook: { enabled: true }, elites: { enabled: true }, lamarck: { enabled: true } });
  const base = new AgentEconomy(config);
  await base.step(population("EXPLORE"), collective(0.5), 8);

  // Parent #4: net +1200 atomic, best regime COLD(0), valid rate 2/3, two distinct goods traded.
  const econ = reseed(base, config, (blob) => {
    blob.playbook = [{
      id: 4, e: [
        [1, 0, 0, 0, 1000, 1, 7],   // good0, COLD, +1000, valid
        [1, 0, 1, 0, 500, 1, 7],    // good1, COLD, +500, valid
        [1, 0, 0, 2, -300, 0, 7],   // good0, HOT, −300, invalid
      ],
    }];
    blob.goodCounts = [{ id: 4, g: [1, 1, 0, 0] }];   // two distinct goods ⇒ diversity bias 0
  });

  const v = econ.lamarckVector(4, 8)!;
  assert.ok(v, "lamarck ON ⇒ a vector is produced");
  // profit: 1200 / (1200 + 1e6) = 0.0011986 ⇒ r6 0.001199
  assert.ok(near(v.weightGain, 0.001199, 1e-6), `weightGain ← soft-signed net P&L, got ${v.weightGain}`);
  // best regime COLD(0) ⇒ 1 − 0 = +1
  assert.ok(near(v.threshGain, 1, 1e-9), `threshGain ← best-regime bias, got ${v.threshGain}`);
  // reliability: (2/3 − 0.5) × 2 = 0.333333
  assert.ok(near(v.tauGain, 0.333333, 1e-6), `tauGain ← valid-rate bias, got ${v.tauGain}`);
  // diversity: (2/4 − 0.5) × 2 = 0
  assert.ok(near(v.weightJitter, 0, 1e-9), `weightJitter ← good-diversity bias, got ${v.weightJitter}`);

  for (const x of [v.weightGain, v.threshGain, v.tauGain, v.weightJitter]) {
    assert.ok(x >= -1 && x <= 1, `every component is bounded to [−1,1], got ${x}`);
  }
  // Determinism: the same parent record ⇒ the identical vector, digit for digit.
  assert.deepEqual(econ.lamarckVector(4, 8), v, "lamarckVector is deterministic (no Math.random / Date.now)");
  assert.deepEqual(econ.lamarckVector(4, 999), v, "the vector is tick-independent (a lifetime record, not a moment)");
});

test("lamarck OFF: lamarckVector returns null (the child genome stays exactly the mutate/cross output)", async () => {
  const config = cfg({ dynasty: {}, playbook: { enabled: true } });   // lamarck NOT armed
  const econ = new AgentEconomy(config);
  await econ.step(population("EXPLORE"), collective(0.5), 3);
  assert.equal(econ.lamarckVector(0, 3), null, "lamarck OFF ⇒ null (breed.ts leaves the genome untouched)");
});

// ============================================================ (c) LAMARCK: genome imprint via applyBreed

test("imprint: a ±1 performance vector biases each genome scalar by +5%/−5% (±1% jitter) on top of mutate", async () => {
  const parent = flywireGenome();
  const parentHash = await genomeHash(parent);
  const entries: LineageEntry[] = [{
    genomeHash: parentHash, genome: parent, parents: [], op: "genesis",
    generation: 0, breeder: null, rngSeed: null, ts: 0, commitTx: null,
  }];
  const S = 987654321;
  const req = { op: "mutate" as const, parents: [parentHash], rngSeed: S };

  const plain = await applyBreed(entries, req, { flywireTopology: true, tickIndex: 1 });
  const up: GenomeImprint = { weightGain: 1, threshGain: 1, tauGain: 1, weightJitter: 1 };
  const down: GenomeImprint = { weightGain: -1, threshGain: -1, tauGain: -1, weightJitter: -1 };
  const impUp = await applyBreed(entries, req, { flywireTopology: true, tickIndex: 1, imprint: { vector: up, rngSeed: S } });
  const impDown = await applyBreed(entries, req, { flywireTopology: true, tickIndex: 1, imprint: { vector: down, rngSeed: S } });

  const fields = ["weightGain", "threshGain", "tauGain", "weightJitter"] as const;
  for (const f of fields) {
    const b = plain.genome[f]!;
    // mutate/cross is identical (same seed) ⇒ the ONLY difference is the imprint multiplier 1 + 0.05·signed + jitter.
    const rUp = impUp.genome[f]! / b;
    const rDown = impDown.genome[f]! / b;
    assert.ok(rUp >= 1.04 - 1e-3 && rUp <= 1.06 + 1e-3, `${f}: +1 vector ⇒ ×[1.04,1.06], got ${rUp.toFixed(4)}`);
    assert.ok(rDown >= 0.94 - 1e-3 && rDown <= 0.96 + 1e-3, `${f}: −1 vector ⇒ ×[0.94,0.96], got ${rDown.toFixed(4)}`);
  }
  assert.notEqual(impUp.genomeHash, plain.genomeHash, "the imprint folds into genomeHash (identity reflects it)");
  assert.equal(impUp.generation, 1, "generation is parent+1 (imprint does not disturb lineage depth)");
});

test("imprint: the bias is CLAMPED back into legal bounds — an extreme parent+vector can never escape the range", async () => {
  const fields = ["weightGain", "threshGain", "tauGain", "weightJitter"] as const;

  // A genome pinned just under every UPPER bound + a full +1 vector ⇒ the imprint must clamp, never overshoot.
  const hi = flywireGenome({ weightGain: 0.595, threshGain: 2.48, tauGain: 2.97, weightJitter: 0.595 });
  const hiHash = await genomeHash(hi);
  const hiEntries: LineageEntry[] = [{
    genomeHash: hiHash, genome: hi, parents: [], op: "genesis", generation: 0, breeder: null, rngSeed: null, ts: 0, commitTx: null,
  }];
  const up: GenomeImprint = { weightGain: 1, threshGain: 1, tauGain: 1, weightJitter: 1 };
  const impHi = await applyBreed(hiEntries, { op: "mutate", parents: [hiHash], rngSeed: 55 }, {
    flywireTopology: true, tickIndex: 1, imprint: { vector: up, rngSeed: 55 },
  });
  let clampedHi = 0;
  for (const f of fields) {
    const [lo, hiB] = FLYWIRE_GENOME_BOUNDS[f];
    const val = impHi.genome[f]!;
    assert.ok(val >= lo - 1e-9 && val <= hiB + 1e-9, `${f}=${val} stays within [${lo},${hiB}]`);
    if (near(val, hiB, 1e-9)) clampedHi++;
  }
  assert.ok(clampedHi >= 3, `at least the 3 unmutated scalars hit the upper bound (got ${clampedHi}) — the clamp engaged`);

  // Mirror: a genome pinned just over every LOWER bound + a full −1 vector.
  const loG = flywireGenome({ weightGain: 0.085, threshGain: 0.52, tauGain: 0.42, weightJitter: 0.055 });
  const loHash = await genomeHash(loG);
  const loEntries: LineageEntry[] = [{
    genomeHash: loHash, genome: loG, parents: [], op: "genesis", generation: 0, breeder: null, rngSeed: null, ts: 0, commitTx: null,
  }];
  const dn: GenomeImprint = { weightGain: -1, threshGain: -1, tauGain: -1, weightJitter: -1 };
  const impLo = await applyBreed(loEntries, { op: "mutate", parents: [loHash], rngSeed: 77 }, {
    flywireTopology: true, tickIndex: 1, imprint: { vector: dn, rngSeed: 77 },
  });
  let clampedLo = 0;
  for (const f of fields) {
    const [lo, hiB] = FLYWIRE_GENOME_BOUNDS[f];
    const val = impLo.genome[f]!;
    assert.ok(val >= lo - 1e-9 && val <= hiB + 1e-9, `${f}=${val} stays within [${lo},${hiB}]`);
    if (near(val, lo, 1e-9)) clampedLo++;
  }
  assert.ok(clampedLo >= 3, `at least the 3 unmutated scalars hit the lower bound (got ${clampedLo}) — the clamp engaged`);
});

test("imprint: identical (genome, vector, rngSeed) ⇒ identical child genome + genomeHash (reproducible identity)", async () => {
  const parent = flywireGenome({ seed: 13579 });
  const h = await genomeHash(parent);
  const entries: LineageEntry[] = [{
    genomeHash: h, genome: parent, parents: [], op: "genesis", generation: 0, breeder: null, rngSeed: null, ts: 0, commitTx: null,
  }];
  const vec: GenomeImprint = { weightGain: 0.6, threshGain: -0.3, tauGain: 0.9, weightJitter: -0.7 };
  const opts = { flywireTopology: true, tickIndex: 3, imprint: { vector: vec, rngSeed: 24680 } };
  const a = await applyBreed(entries, { op: "mutate", parents: [h], rngSeed: 24680 }, opts);
  const b = await applyBreed(entries, { op: "mutate", parents: [h], rngSeed: 24680 }, opts);
  assert.equal(a.genomeHash, b.genomeHash, "the imprinted genomeHash is reproducible");
  assert.deepEqual(a.genome, b.genome, "the imprinted genome is bit-identical across re-runs");
  // A different jitter seed ⇒ a different (but still bounded) child: siblings are not clones.
  const c = await applyBreed(entries, { op: "mutate", parents: [h], rngSeed: 11111 }, {
    flywireTopology: true, tickIndex: 3, imprint: { vector: vec, rngSeed: 11111 },
  });
  assert.notEqual(a.genomeHash, c.genomeHash, "a different rngSeed jitters the imprint ⇒ a distinct sibling");
});

// ============================================================ OFF inertness + additive compat

test("cultural OFF: a真亲子 hatch leaves the child BLANK — no bond, no playbook prior (default-OFF inertness)", async () => {
  const config = cfg({ dynasty: {}, playbook: { enabled: true } });   // cultural NOT armed
  const base = new AgentEconomy(config);
  await base.step(population("AGITATE"), collective(0.5), 10);

  const econ = reseed(base, config, (blob) => {
    blob.social.mem = [{ id: 3, rep: 0.9, repTick: 10, kept: 5, broken: 0, bonds: [{ other: 5, score: 0.8, trades: 4, lastTick: 10 }] }];
    blob.playbook = [{ id: 3, e: [[1, 0, 0, 0, 500, 1, 9]] }];
  });

  econ.noteHatch(3, 24, HASH_A);
  const child = econ.getSocial(24);
  assert.ok(!child || child.bonds.length === 0, "cultural OFF ⇒ the child inherits NO bond prior (blank start)");
  assert.ok(near(child?.rep ?? 0, 0), "cultural OFF ⇒ no inherited reputation");
  assert.equal(econ.getPlaybook(24), undefined, "cultural OFF ⇒ no playbook prior injected");
});

test("additive: an OLD blob with no parent memory restores cleanly and yields a blank child (KEY_VERSION unchanged)", async () => {
  const config = cfg({ dynasty: {}, playbook: { enabled: true }, cultural: { enabled: true }, lamarck: { enabled: true } });
  const base = new AgentEconomy(config);
  await base.step(population("EXPLORE"), collective(0.5), 6);

  // Strip the social + playbook blocks entirely — a pre-Phase-1/2 payload. applySerialized must default them to
  // empty (never crash), and a hatch then has no parent prior to copy ⇒ a blank child. KEY_VERSION stays v1.
  const econ = reseed(base, config, (blob) => { delete blob.social; delete blob.playbook; });
  assert.equal(JSON.parse(econ.serialize()).version, "economy:v1", "KEY_VERSION is NOT bumped (purely additive)");

  econ.noteHatch(3, 24, HASH_A);                                // no crash on a memory-less parent
  const child = econ.getSocial(24);
  assert.ok(!child || child.bonds.length === 0, "no parent memory ⇒ no prior (the additive default)");
  assert.equal(econ.getPlaybook(24), undefined, "no parent ring ⇒ no compressed prior");
  assert.equal(econ.lamarckVector(3, 6) !== undefined, true, "lamarckVector still runs (falls back to the ledger)");
});

// ============================================================ (a) strategy-tree inheritance + depth

test("cultural: a真亲子 hatch seeds the child's GP tree by mutating the parent's (vertical strategy inheritance)", async () => {
  const config = cfg({ dynasty: {}, strategy: { enabled: true }, cultural: { enabled: true } });
  const econ = new AgentEconomy(config);
  await econ.step(population("EXPLORE"), collective(0.5), 2);

  const parentTree = econ.getStrategyTree(3)!;
  assert.ok(parentTree, "the parent has a deterministic id-seeded tree");
  econ.noteHatch(3, 24, HASH_A);
  const childTree = econ.getStrategyTree(24)!;
  assert.ok(childTree, "the child inherits a strategy tree");
  assert.ok(isLegalTree(childTree), "the inherited tree is legal (degenerate mutations are filtered)");
  assert.notEqual(treeHash(childTree), treeHash(parentTree), "the child's tree is a MUTATION, not a clone (diversity)");

  // Determinism: an identical hatch on a twin economy yields the identical inherited tree.
  const twin = new AgentEconomy(config);
  await twin.step(population("EXPLORE"), collective(0.5), 2);
  twin.noteHatch(3, 24, HASH_A);
  assert.equal(treeHash(twin.getStrategyTree(24)!), treeHash(childTree), "vertical tree inheritance is deterministic");
});

test("lineage depth: chained真亲子 hatches increment generation and link parent→child (inheritance is traceable)", async () => {
  const config = cfg({ dynasty: {}, cultural: { enabled: true } });
  const econ = new AgentEconomy(config);
  await econ.step(population("AGITATE"), collective(0.8), 100);

  const g1 = econ.noteHatch(3, 24, HASH_A);       // #3 (gen 0) founds a house, #24 is gen 1
  assert.ok(g1?.founded, "the first hatch founds the house");
  const g2 = econ.noteHatch(24, 25, HASH_B);      // #25 is gen 2
  const g3 = econ.noteHatch(25, 26, HASH_A);      // #26 is gen 3
  assert.equal(g2?.founded, false, "a descendant is born into the existing house");
  assert.equal(g3?.houseId, g1!.houseId, "the whole chain shares one house banner");

  const house = econ.dynastyReadout().houses.find((h) => h.id === 3)!;
  assert.equal(house.gen, 3, "the banner records the deepest generation reached (0→1→2→3) — depth is traceable");
  assert.equal(house.members, 4, "founder + 3 descendants");
});

// ============================================================ A/B EVIDENCE

test("A/B: inherited-prior children vs blank-start children — prior effect, depth, and diversity NOT collapsed", async () => {
  const onCfg = cfg({
    dynasty: {}, playbook: { enabled: true }, strategy: { enabled: true }, elites: { enabled: true },
    cultural: { enabled: true }, lamarck: { enabled: true },
  });
  const offCfg = cfg({
    dynasty: {}, playbook: { enabled: true }, strategy: { enabled: true }, elites: { enabled: true },
  });
  const econA = new AgentEconomy(onCfg);    // inheritance ARMED
  const econB = new AgentEconomy(offCfg);   // blank-start baseline (Phase 2b)

  // Warm up both identically so genesis flies trade and form social memory + populate the archive.
  for (let t = 1; t <= 5; t++) {
    await econA.step(population("EXPLORE"), collective(0.5), t);
    await econB.step(population("EXPLORE"), collective(0.5), t);
  }

  // --- (i) PRIOR EFFECT: find a genesis parent with lived memory, hatch its child in both economies. ---
  let parentWithMem = -1;
  for (let i = 0; i < 24; i++) {
    const s = econA.getSocial(i);
    if (s && s.bonds.length > 0) { parentWithMem = i; break; }
  }
  assert.ok(parentWithMem >= 0, "the warmup produced at least one parent with a lived bond");
  econA.noteHatch(parentWithMem, 200, HASH_A);
  econB.noteHatch(parentWithMem, 200, HASH_A);
  const childA = econA.getSocial(200);
  const childB = econB.getSocial(200);
  assert.ok(childA && childA.bonds.length > 0, "ARMED: the child is born with an inherited (discounted) social prior");
  assert.ok(!childB || childB.bonds.length === 0, "BASELINE: the child starts blank (no cultural transmission)");

  // --- (ii) DIVERSITY NOT COLLAPSED: breed G×K children in the ARMED economy; every inherited tree is novel. ---
  const G = 6, K = 4;
  const archiveBaseline = econA.getElitesArchive()?.occupied ?? 0;
  const childTreeHashes = new Set<string>();
  let childId = 24;
  for (let g = 0; g < G; g++) {
    for (let k = 0; k < K; k++) {
      const parent = (g * K + k) % 24;                 // spread parents across the genesis stock
      econA.noteHatch(parent, childId, HASH_A);
      const t = econA.getStrategyTree(childId);
      if (t) childTreeHashes.add(treeHash(t));
      childId++;
    }
    const n = childId;                                  // population has grown to `n` live ids
    await econA.step(population("EXPLORE", n), collective(0.5), 6 + g);
  }

  const children = G * K;
  const archiveFinal = econA.getElitesArchive()?.occupied ?? 0;

  console.log(`\n=== A/B EVIDENCE: intergenerational transfer (${children} bred children) ===`);
  console.log(`(i)  prior effect: ARMED child bonds=${childA?.bonds.length ?? 0}, BASELINE child bonds=${childB?.bonds.length ?? 0}`);
  console.log(`(ii) unique inherited treeHashes: ${childTreeHashes.size}/${children} children`);
  console.log(`(iii) MAP-Elites archive coverage: baseline ${archiveBaseline} → final ${archiveFinal} cells`);
  console.log(`=========================================================\n`);

  // Diversity: inheritance-with-mutation must NOT clone one strategy across the population.
  assert.ok(childTreeHashes.size >= Math.ceil(children * 0.8),
    `unique inherited trees ≥ 80% of children (diversity preserved), got ${childTreeHashes.size}/${children}`);
  // Archive coverage is monotonic non-decreasing (a cell once occupied stays occupied) ⇒ cultural never collapses it.
  assert.ok(archiveFinal >= archiveBaseline, `archive coverage does not drop (${archiveBaseline}→${archiveFinal})`);
  assert.ok(archiveFinal > 0, "the archive is non-empty after breeding");
});

// ============================================================ STORAGE ACCOUNTING

test("storage: a SATURATED 100-fly blob (every cultural-affected structure at its cap) stays < 200KB", async () => {
  // Cultural transmission adds NO new serialized field: it fills the SAME bounded per-fly structures Phase 1/2b
  // already budgeted — social bonds ≤ BOND_TOP_K(8), playbook ring ≤ PLAYBOOK_CAP(16), one strategy tree per fly.
  // The Lamarckian imprint is baked into the genome (a separate KEY_LINEAGE record; only 4 scalar VALUES change).
  // So the worst case cultural can EVER produce is 100 flies each at those caps. Saturate them and measure.
  const config = cfg({
    populationSize: 100, maxDealsPerTick: 100,
    dynasty: {}, playbook: { enabled: true }, strategy: { enabled: true }, elites: { enabled: true },
    cultural: { enabled: true }, lamarck: { enabled: true },
  });
  const base = new AgentEconomy(config);
  const readings100 = Array.from({ length: 100 }, (_, i) => reading(i, "AGITATE"));
  for (let t = 1; t <= 6; t++) await base.step(readings100, collective(0.9), t);   // populate trees/elites/goodCounts

  // Overwrite social + playbook with the WORST CASE: all 100 flies at the bond cap (8) and the ring cap (16).
  const econ = reseed(base, config, (blob) => {
    blob.social.mem = Array.from({ length: 100 }, (_, id) => ({
      id, rep: 0.9, repTick: 6, kept: 99, broken: 9,
      bonds: Array.from({ length: 8 }, (_, j) => ({ other: (id + j + 1) % 100, score: j % 2 ? -0.8 : 0.8, trades: 9, lastTick: 6 })),
    }));
    blob.playbook = Array.from({ length: 100 }, (_, id) => ({
      id,
      e: Array.from({ length: 16 }, (_, j) => [123456 + j, j % 2, j % 4, j % 3, -1000000 + j, j % 2, 6]),
    }));
  });

  const bytes = new TextEncoder().encode(econ.serialize()).length;
  const kb = bytes / 1024;
  const GUARD_KB = 200;
  const pctOfGuard = (kb / GUARD_KB) * 100;
  const pctOfDO = (bytes / (128 * 1024 * 1024)) * 100;

  console.log(`\n=== STORAGE ACCOUNTING (100 flies, ALL layers ON, cultural structures SATURATED) ===`);
  console.log(`  Blob size:      ${bytes.toLocaleString()} bytes (${kb.toFixed(1)} KB)`);
  console.log(`  200KB guard:    ${pctOfGuard.toFixed(1)}%  (headroom ${(100 - pctOfGuard).toFixed(1)}%)`);
  console.log(`  128MB DO limit: ${pctOfDO.toFixed(4)}%`);
  console.log(`  Per-fly avg:    ${(bytes / 100).toFixed(0)} bytes`);
  console.log(`===================================================================================\n`);

  assert.ok(kb < GUARD_KB, `saturated 100-fly blob ${kb.toFixed(1)}KB must stay < ${GUARD_KB}KB guard`);
  // Sanity: the cultural-affected structures are actually present + saturated in the measured blob.
  const reparsed = JSON.parse(econ.serialize());
  assert.equal(reparsed.social.mem.length, 100, "all 100 flies carry a social record");
  assert.equal(reparsed.social.mem[0].bonds.length, 8, "bonds saturated to BOND_TOP_K");
  assert.equal(reparsed.playbook[0].e.length, 16, "playbook rings saturated to PLAYBOOK_CAP");
  assert.ok(reparsed.strategyTrees && reparsed.strategyTrees.length > 0, "strategy trees present");
});
