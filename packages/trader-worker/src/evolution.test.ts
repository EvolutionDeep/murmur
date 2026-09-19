// Autonomous-evolution tests — the PURE selection planner + the config gates that keep it inert.
//
// Autonomous evolution lets the FITTEST agents (highest realized PnL) found the next generation of
// connectomes, paying the breeding fee from their OWN wallet. Because that fee is REAL USDC on Arc
// mainnet, the two things that MUST be pinned by tests are:
//   1. ZERO REGRESSION WHEN OFF — evolution is disabled by default and every gate (config disabled, no
//      treasury, budget ceilings) must yield NO breed. A deployed Worker with no EVOLUTION_* vars must
//      behave exactly as before evolution existed.
//   2. SELECTION CORRECTNESS WHEN ON — fitness = realized PnL, losers never breed, the fittest parent
//      always pays, the per-cron / per-day / per-agent ceilings are hard stops, and the cross/mutate draw
//      is exactly rng-vs-crossBias. A wrong pick spends real money on the wrong offspring.
//
// The decision logic is a PURE function (evolution.ts planEvolution), tested here directly with stubbed
// leaderboard rows + rng; the side-effecting executor (state.ts driveEvolution / economy.payBreedingFee)
// is gated again on the real-money rails, and the config gates are tested through loadConfig.

import test from "node:test";
import assert from "node:assert/strict";

import { planEvolution, germlineResolver, resolveNovelBreed, lineageAnchorPlan, type EvolutionLimits } from "./evolution.js";
import { loadConfig, type Env } from "./config.js";
import type { LeaderRow } from "./economy.js";
import type { LineageEntry } from "./breed.js";

// ---------- helpers ----------

/** A minimal, valid Env (only the required fields matter for config parsing; the rest default). */
function env(over: Partial<Env> = {}): Env {
  return {
    FLY_STATE: {} as Env["FLY_STATE"],
    CHAIN_ID: "5042002",
    RPC_URL: "https://rpc.testnet.arc.io",
    ...over,
  } as Env;
}

/** A leaderboard row; only id/address/netUsdc drive selection, the rest are realistic filler. */
function row(id: number, netUsdc: number, over: Partial<LeaderRow> = {}): LeaderRow {
  return {
    id,
    address: `0xagent${id}`,
    netUsdc,
    earnedUsdc: Math.max(0, netUsdc),
    paidUsdc: Math.max(0, -netUsdc),
    balanceUsdc: 6,
    deals: 3,
    sales: 3,
    ...over,
  };
}

/** genomeHashById: every id resolves to a distinct, non-empty fake genome hash. */
const hashById = (id: number): string | null => `g${id}`.padEnd(64, "0");

/**
 * A minimal lineage entry. germlineResolver only reads op / breeder / genomeHash / ts, and the genome body
 * is never touched by the pure helpers, so a cast stub keeps these tests dependency-free (no crypto.subtle).
 */
function entry(over: Partial<LineageEntry> = {}): LineageEntry {
  return {
    genomeHash: "0".repeat(64),
    genome: {} as LineageEntry["genome"],
    parents: [],
    op: "genesis",
    generation: 0,
    breeder: null,
    rngSeed: null,
    ts: 0,
    commitTx: null,
    ...over,
  };
}

/** A permissive budget (1/cron, unlimited daily, mutate-by-default); tests override what they exercise. */
function lim(over: Partial<EvolutionLimits> = {}): EvolutionLimits {
  return {
    perCron: 1,
    perCronUsed: 0,
    perAgentDaily: 0,   // 0 ⇒ no per-agent limit
    globalDaily: 0,     // 0 ⇒ no global limit
    globalUsed: 0,
    perAgentUsed: {},
    crossBias: 0,       // 0 ⇒ always mutate unless a test forces a cross
    ...over,
  };
}

const SEED = 42;
const mid = () => 0.5;   // a mid-range rng draw; compared against crossBias

// ---------- planEvolution: budget gates (never overspend) ----------

test("null when the per-cron budget is zero or already used", () => {
  const rows = [row(1, 0.5), row(2, 0.3)];
  assert.equal(planEvolution(rows, hashById, lim({ perCron: 0 }), mid, SEED), null, "perCron 0 ⇒ disabled");
  assert.equal(
    planEvolution(rows, hashById, lim({ perCron: 1, perCronUsed: 1 }), mid, SEED),
    null,
    "already bred this cron ⇒ stop",
  );
});

test("null when the global daily budget is exhausted; one slot left still breeds", () => {
  const rows = [row(1, 0.5), row(2, 0.3)];
  assert.equal(
    planEvolution(rows, hashById, lim({ globalDaily: 4, globalUsed: 4 }), mid, SEED),
    null,
    "daily swarm budget spent",
  );
  assert.ok(
    planEvolution(rows, hashById, lim({ globalDaily: 4, globalUsed: 3 }), mid, SEED),
    "one slot left ⇒ breeds",
  );
});

// ---------- planEvolution: fitness selection (natural selection on realized PnL) ----------

test("null when no agent is profitable — losers never breed", () => {
  const rows = [row(1, 0), row(2, -0.4), row(3, -1)];
  assert.equal(planEvolution(rows, hashById, lim(), mid, SEED), null, "netUsdc must be > 0");
});

test("null when profitable agents have no resolvable genome", () => {
  const rows = [row(1, 0.9), row(2, 0.5)];
  assert.equal(planEvolution(rows, () => null, lim(), mid, SEED), null);
  assert.equal(planEvolution(rows, () => "", lim(), mid, SEED), null, "an empty hash is ineligible too");
});

test("mutates the single fittest profitable agent and credits it as payer/breeder", () => {
  const rows = [row(3, 0.2), row(1, 0.9), row(2, 0.5)];   // deliberately unsorted
  const plan = planEvolution(rows, hashById, lim({ crossBias: 0 }), mid, SEED)!;
  assert.equal(plan.op, "mutate");
  assert.deepEqual(plan.parents, [hashById(1)], "the champion (highest netUsdc) is the sole parent");
  assert.equal(plan.payerId, 1, "the fittest pays the fee from its own wallet");
  assert.equal(plan.payerAddress, "0xagent1", "credited as the offspring's breeder");
  assert.equal(plan.rngSeed, SEED, "the operator seed is recorded so the offspring is reproducible");
});

test("crossBias=1 with ≥2 fit parents crosses the top two; the fittest still pays", () => {
  const rows = [row(1, 0.9), row(2, 0.5), row(3, 0.2)];
  const plan = planEvolution(rows, hashById, lim({ crossBias: 1 }), mid, SEED)!;
  assert.equal(plan.op, "cross");
  assert.deepEqual(plan.parents, [hashById(1), hashById(2)], "the two fittest, in fitness order");
  assert.equal(plan.payerId, 1, "the fittest of the pair funds the cross");
  assert.equal(plan.payerAddress, "0xagent1");
});

test("crossBias=0 always mutates even with many fit parents", () => {
  const rows = [row(1, 0.9), row(2, 0.5)];
  assert.equal(planEvolution(rows, hashById, lim({ crossBias: 0 }), () => 0.0, SEED)!.op, "mutate");
});

test("the cross/mutate draw is exactly rng-vs-crossBias", () => {
  const rows = [row(1, 0.9), row(2, 0.5)];
  assert.equal(
    planEvolution(rows, hashById, lim({ crossBias: 0.5 }), () => 0.4, SEED)!.op,
    "cross",
    "rng < crossBias ⇒ cross",
  );
  assert.equal(
    planEvolution(rows, hashById, lim({ crossBias: 0.5 }), () => 0.6, SEED)!.op,
    "mutate",
    "rng ≥ crossBias ⇒ mutate",
  );
});

test("a single fit parent mutates even at crossBias=1 (a cross needs two)", () => {
  const rows = [row(1, 0.9), row(2, -0.5)];
  const plan = planEvolution(rows, hashById, lim({ crossBias: 1 }), () => 0.0, SEED)!;
  assert.equal(plan.op, "mutate");
  assert.deepEqual(plan.parents, [hashById(1)]);
});

test("fitness ranking is by netUsdc, then balance, then id (a stable, explicit order)", () => {
  // Two agents tie on netUsdc; the higher balance wins the tie, so it becomes the payer.
  const rows = [row(1, 0.5, { balanceUsdc: 2 }), row(2, 0.5, { balanceUsdc: 9 })];
  const plan = planEvolution(rows, hashById, lim({ crossBias: 0 }), mid, SEED)!;
  assert.equal(plan.payerId, 2, "tie on PnL broken by balance");
});

// ---------- planEvolution: per-agent daily budget ----------

test("an agent at its per-agent daily limit is skipped; the next fittest breeds instead", () => {
  const rows = [row(1, 0.9), row(2, 0.5)];
  const plan = planEvolution(
    rows, hashById, lim({ perAgentDaily: 1, perAgentUsed: { 1: 1 }, crossBias: 0 }), mid, SEED,
  )!;
  assert.equal(plan.payerId, 2, "the champion already bred today, so #2 is the fittest eligible");
  assert.deepEqual(plan.parents, [hashById(2)]);
});

test("null when every profitable agent is at its per-agent daily limit", () => {
  const rows = [row(1, 0.9), row(2, 0.5)];
  assert.equal(
    planEvolution(rows, hashById, lim({ perAgentDaily: 1, perAgentUsed: { 1: 1, 2: 1 }, crossBias: 0 }), mid, SEED),
    null,
  );
});

// ---------- loadConfig: the EVOLUTION_* gates and inert-by-default guarantee ----------

test("by default evolution is disabled and inert (zero behaviour change for an existing deployment)", () => {
  const ev = loadConfig(env()).evolution;
  assert.equal(ev.enabled, false, "EVOLUTION_ENABLED unset ⇒ disabled");
  assert.equal(ev.treasury, null, "no treasury ⇒ the step is skipped entirely");
  assert.equal(ev.feeUsdc, 0.002);
  assert.equal(ev.maxPerCron, 1);
  assert.equal(ev.perAgentDaily, 1);
  assert.equal(ev.globalDaily, 4);
  assert.equal(ev.crossBias, 0.5);
});

test("enabled requires EVOLUTION_ENABLED=true; treasury is trimmed and empty⇒null", () => {
  const on = loadConfig(env({ EVOLUTION_ENABLED: "true", EVOLUTION_TREASURY: "  0xtreasury  " })).evolution;
  assert.equal(on.enabled, true);
  assert.equal(on.treasury, "0xtreasury", "whitespace trimmed");

  assert.equal(loadConfig(env({ EVOLUTION_ENABLED: "TRUE" })).evolution.enabled, true, "case-insensitive");
  assert.equal(loadConfig(env({ EVOLUTION_ENABLED: "false" })).evolution.enabled, false);
  assert.equal(loadConfig(env({ EVOLUTION_ENABLED: "1" })).evolution.enabled, false, "only 'true' enables");
  assert.equal(loadConfig(env({ EVOLUTION_TREASURY: "   " })).evolution.treasury, null, "blank ⇒ null (step skipped)");
});

test("fee, budgets and crossBias are parsed and clamped to safe ranges", () => {
  assert.equal(loadConfig(env({ EVOLUTION_FEE_USDC: "0.01" })).evolution.feeUsdc, 0.01);
  assert.equal(loadConfig(env({ EVOLUTION_FEE_USDC: "0" })).evolution.feeUsdc, 0.000001, "clamped to the min");
  assert.equal(loadConfig(env({ EVOLUTION_MAX_PER_CRON: "5" })).evolution.maxPerCron, 5);
  assert.equal(loadConfig(env({ EVOLUTION_MAX_PER_CRON: "9999" })).evolution.maxPerCron, 64, "clamped to 64");
  assert.equal(loadConfig(env({ EVOLUTION_PER_AGENT_DAILY: "3" })).evolution.perAgentDaily, 3);
  assert.equal(loadConfig(env({ EVOLUTION_GLOBAL_DAILY: "10" })).evolution.globalDaily, 10);
  assert.equal(loadConfig(env({ EVOLUTION_CROSS_BIAS: "0.8" })).evolution.crossBias, 0.8);
  assert.equal(loadConfig(env({ EVOLUTION_CROSS_BIAS: "5" })).evolution.crossBias, 1, "clamped to 1");
});

// ---------- germlineResolver: agents breed from their OWN latest line, not always genesis ----------

test("germlineResolver falls back to the genesis root when an agent has not bred yet", () => {
  const rows = [row(0, 1), row(1, 0.5)];
  const entries = [
    entry({ op: "genesis", genomeHash: hashById(0)! }),   // genesis[0] ⇒ agent 0's root
    entry({ op: "genesis", genomeHash: hashById(1)! }),   // genesis[1] ⇒ agent 1's root
  ];
  const resolve = germlineResolver(rows, entries);
  assert.equal(resolve(0), hashById(0), "no offspring ⇒ its genesis root");
  assert.equal(resolve(1), hashById(1), "no offspring ⇒ its genesis root");
});

test("germlineResolver advances an agent to its own most-recent offspring (latest ts wins)", () => {
  const rows = [row(0, 1), row(1, 0.8)];
  const gen1 = hashById(1)!;
  const kid1a = "a1".padEnd(64, "0");
  const kid1b = "b1".padEnd(64, "0");
  const entries = [
    entry({ op: "genesis", genomeHash: hashById(0)! }),
    entry({ op: "genesis", genomeHash: gen1 }),
    entry({ op: "mutate", genomeHash: kid1a, parents: [gen1], generation: 1, breeder: "0xagent1", ts: 100 }),
    entry({ op: "mutate", genomeHash: kid1b, parents: [kid1a], generation: 2, breeder: "0xagent1", ts: 200 }),
  ];
  const resolve = germlineResolver(rows, entries);
  assert.equal(resolve(1), kid1b, "agent 1 breeds from its NEWEST offspring, so generations accumulate");
  assert.equal(resolve(0), hashById(0), "agent 0 has no offspring ⇒ still its genesis root");
});

test("germlineResolver matches breeder addresses case-insensitively", () => {
  const rows = [row(1, 0.8)];   // address 0xagent1
  const kid = "c1".padEnd(64, "0");
  const entries = [
    entry({ op: "genesis", genomeHash: hashById(0)! }),
    entry({ op: "genesis", genomeHash: hashById(1)! }),
    entry({ op: "mutate", genomeHash: kid, breeder: "0xAGENT1", ts: 5 }),   // checksum-y casing
  ];
  assert.equal(germlineResolver(rows, entries)(1), kid, "0xAGENT1 == row address 0xagent1");
});

test("germlineResolver returns null for an id with no row and no genesis root", () => {
  const entries = [entry({ op: "genesis", genomeHash: hashById(0)! })];
  assert.equal(germlineResolver([], entries)(5), null);
});

// ---------- resolveNovelBreed: never spend on a duplicate; downgrade cross→mutate ----------

test("resolveNovelBreed returns the child on the first attempt with the plan's own seed + op", async () => {
  const calls: Array<{ op: string; parents: string[]; seed: number }> = [];
  const res = await resolveNovelBreed(
    { op: "mutate", parents: ["p0"], rngSeed: SEED },
    async (op, parents, seed) => { calls.push({ op, parents, seed }); return { hash: "kid" }; },
  );
  assert.deepEqual(res, { child: { hash: "kid" }, op: "mutate" });
  assert.equal(calls.length, 1, "no retry when the first attempt is novel");
  assert.equal(calls[0]!.seed, SEED, "the first attempt uses the plan's recorded seed (reproducible)");
});

test("resolveNovelBreed downgrades a duplicate cross to mutate and retries with a fresh seed", async () => {
  const seen: Array<{ op: string; parents: string[]; seed: number }> = [];
  const res = await resolveNovelBreed<string>(
    { op: "cross", parents: ["pA", "pB"], rngSeed: SEED },
    async (op, parents, seed) => {
      seen.push({ op, parents, seed });
      if (op === "cross") throw new Error("offspring genome already in lineage");   // degenerate recombination
      return `mutated:${parents[0]}@${seed}`;
    },
  );
  assert.equal(res!.op, "mutate", "cross → mutate after the duplicate");
  assert.equal(res!.child, `mutated:pA@${(SEED + 2654435761) >>> 0}`, "retried with the top parent + a fresh seed");
  assert.deepEqual(seen[0], { op: "cross", parents: ["pA", "pB"], seed: SEED });
  assert.deepEqual(seen[1], { op: "mutate", parents: ["pA"], seed: (SEED + 2654435761) >>> 0 });
});

test("resolveNovelBreed retries a duplicate mutate with fresh seeds (never downgrades below mutate)", async () => {
  const seeds: number[] = [];
  const res = await resolveNovelBreed<string>(
    { op: "mutate", parents: ["pA"], rngSeed: SEED },
    async (_op, _parents, seed) => {
      seeds.push(seed);
      if (seeds.length < 3) throw new Error("offspring genome already in lineage");   // collide twice
      return `ok@${seed}`;
    },
  );
  assert.equal(res!.op, "mutate");
  assert.equal(seeds.length, 3, "two collisions then success");
  assert.equal(res!.child, `ok@${(SEED + 2 * 2654435761) >>> 0}`);
});

test("resolveNovelBreed returns null when every attempt duplicates", async () => {
  let n = 0;
  const res = await resolveNovelBreed(
    { op: "mutate", parents: ["pA"], rngSeed: SEED },
    async () => { n++; throw new Error("offspring genome already in lineage"); },
  );
  assert.equal(res, null);
  assert.equal(n, 4, "gave up after the default maxAttempts");
});

test("resolveNovelBreed re-throws a non-duplicate error without retrying", async () => {
  let n = 0;
  await assert.rejects(
    resolveNovelBreed(
      { op: "mutate", parents: ["bad"], rngSeed: SEED },
      async () => { n++; throw new Error("unknown parent genome bad"); },
    ),
    /unknown parent genome/,
  );
  assert.equal(n, 1, "a real error is fatal, not retried");
});

// ---------- lineageAnchorPlan: bootstrap the on-chain family tree (genesis first, ancestry-ordered) ----------

/** An id→address map driving the genesis positional-breeder resolution. */
function addrs(pairs: Record<number, string>): Map<number, string> {
  return new Map(Object.entries(pairs).map(([k, v]) => [Number(k), v]));
}

test("lineageAnchorPlan commits uncommitted genesis roots first, credited to their own agent by position", () => {
  const g0 = hashById(0)!;
  const g1 = hashById(1)!;
  const entries = [
    entry({ op: "genesis", genomeHash: g0 }),   // genesis[0] ⇒ agent 0
    entry({ op: "genesis", genomeHash: g1 }),   // genesis[1] ⇒ agent 1
  ];
  const plan = lineageAnchorPlan(entries, addrs({ 0: "0xAAA", 1: "0xBBB" }), 6);
  assert.equal(plan.length, 2);
  assert.deepEqual(plan[0], { genomeHash: g0, parentA: "", parentB: "", op: 0, generation: 0, breeder: "0xaaa" });
  assert.deepEqual(plan[1], { genomeHash: g1, parentA: "", parentB: "", op: 0, generation: 0, breeder: "0xbbb" });
});

test("lineageAnchorPlan skips an already-anchored entry (commitTx set) — idempotent", () => {
  const entries = [entry({ op: "genesis", genomeHash: hashById(0)!, commitTx: "0xdead" })];
  assert.deepEqual(lineageAnchorPlan(entries, addrs({ 0: "0xAAA" }), 6), []);
});

test("lineageAnchorPlan respects maxCommits, in append order (bounds work per cron)", () => {
  const entries = [0, 1, 2, 3].map((i) => entry({ op: "genesis", genomeHash: hashById(i)! }));
  const plan = lineageAnchorPlan(entries, addrs({ 0: "0xa", 1: "0xb", 2: "0xc", 3: "0xd" }), 2);
  assert.equal(plan.length, 2, "capped at maxCommits");
  assert.deepEqual(plan.map((c) => c.genomeHash), [hashById(0), hashById(1)], "append order preserved");
});

test("lineageAnchorPlan anchors a mutate child in the SAME batch once its genesis parent is planned first", () => {
  const g0 = hashById(0)!;
  const kid = "k1".padEnd(64, "0");
  const entries = [
    entry({ op: "genesis", genomeHash: g0 }),
    entry({ op: "mutate", genomeHash: kid, parents: [g0], generation: 1, breeder: "0xCCC", ts: 10 }),
  ];
  const plan = lineageAnchorPlan(entries, addrs({ 0: "0xAAA" }), 6);
  assert.deepEqual(plan.map((c) => c.genomeHash), [g0, kid], "parent committed before child within one pass");
  assert.equal(plan[1]!.op, 1, "mutate ⇒ op code 1");
  assert.equal(plan[1]!.parentA, g0);
  assert.equal(plan[1]!.breeder, "0xCCC", "a bred entry keeps its own recorded breeder (trimmed, not re-cased)");
});

test("lineageAnchorPlan excludes a child whose parent is not committed (would revert ParentNotCommitted)", () => {
  const missing = "ff".padEnd(64, "0");
  const kid = "k1".padEnd(64, "0");
  const entries = [entry({ op: "mutate", genomeHash: kid, parents: [missing], generation: 1, breeder: "0xCCC" })];
  assert.deepEqual(lineageAnchorPlan(entries, addrs({}), 6), [], "uncommitted parent ⇒ waits for a later tick");
});

test("lineageAnchorPlan skips a genesis root with no known agent address (ZeroBreeder would revert)", () => {
  const entries = [entry({ op: "genesis", genomeHash: hashById(0)! })];
  assert.deepEqual(lineageAnchorPlan(entries, addrs({}), 6), [], "no address ⇒ skipped, retried later");
});

test("lineageAnchorPlan anchors a cross child (op=2) only once BOTH parents are committed", () => {
  const gA = hashById(0)!;
  const gB = hashById(1)!;
  const kid = "cc".padEnd(64, "0");
  const entries = [
    entry({ op: "genesis", genomeHash: gA, commitTx: "0x1" }),   // already on-chain
    entry({ op: "genesis", genomeHash: gB, commitTx: "0x2" }),   // already on-chain
    entry({ op: "cross", genomeHash: kid, parents: [gA, gB], generation: 1, breeder: "0xDDD", ts: 5 }),
  ];
  const plan = lineageAnchorPlan(entries, addrs({}), 6);
  assert.equal(plan.length, 1, "only the cross child is left to anchor");
  assert.deepEqual(plan[0], { genomeHash: kid, parentA: gA, parentB: gB, op: 2, generation: 1, breeder: "0xDDD" });
});
