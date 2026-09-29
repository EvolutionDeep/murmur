// Evolution determinism tests — proves that the evolution path is a PURE function of (tickIndex, state).
//
// Task #74 (Phase 0 / P0.1): the former Math.random + Date.now sources in state.ts driveEvolution have been
// replaced with FNV-1a hash01(tickIndex, counter, EVOLUTION_SALT) draws. These tests pin:
//   1. planEvolution produces IDENTICAL output when called twice with the same deterministic rng + seed.
//   2. The config correctly parses EVOLUTION_SALT (code-default and env-override).
//   3. The driveEvolution source in state.ts contains NO residual Math.random / Date.now in its body.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { planEvolution, type EvolutionLimits } from "./evolution.js";
import { loadConfig, type Env } from "./config.js";
import type { LeaderRow } from "./economy.js";

// ─── helpers (mirroring evolution.test.ts conventions) ───────────────────────────────────────────────────

function env(over: Partial<Env> = {}): Env {
  return {
    FLY_STATE: {} as Env["FLY_STATE"],
    CHAIN_ID: "5042002",
    RPC_URL: "https://rpc.testnet.arc.io",
    ...over,
  } as Env;
}

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

const hashById = (id: number): string | null => `g${id}`.padEnd(64, "0");

function lim(over: Partial<EvolutionLimits> = {}): EvolutionLimits {
  return {
    perCron: 1,
    perCronUsed: 0,
    perAgentDaily: 0,
    globalDaily: 0,
    globalUsed: 0,
    perAgentUsed: {},
    crossBias: 0.5,
    ...over,
  };
}

// ─── The SAME FNV-1a construction now used in state.ts driveEvolution (duplicated here for test isolation) ─

function evoHash32(a: number, b: number, c: number): number {
  let h = 0x811c9dc5;
  const mix = (x: number) => {
    for (let s = 0; s < 32; s += 8) { h = Math.imul(h ^ ((x >>> s) & 0xff), 0x01000193) >>> 0; }
  };
  mix(a >>> 0); mix(b >>> 0); mix(c >>> 0);
  return h >>> 0;
}
function evoHash01(a: number, b: number, salt: number): number {
  return evoHash32(a, b, salt) / 0xffffffff;
}

const DEFAULT_SALT = 0x65766f; // "evo"

// ─── 1. planEvolution determinism: same (tick, rows, limits, salt) → identical plan ──────────────────────

test("planEvolution is deterministic: identical inputs produce identical output across calls", () => {
  const rows = [row(1, 0.9), row(2, 0.5), row(3, 0.2)];
  const tickIndex = 7500;
  const limits = lim({ crossBias: 0.5 });

  // Simulate the deterministic rng closure exactly as driveEvolution now constructs it.
  function makePlan(tick: number): ReturnType<typeof planEvolution> {
    let counter = 0;
    const rng = () => evoHash01(tick, counter++, DEFAULT_SALT);
    const seed = evoHash32(tick, 0, DEFAULT_SALT);
    return planEvolution(rows, hashById, limits, rng, seed);
  }

  const a = makePlan(tickIndex);
  const b = makePlan(tickIndex);
  assert.deepEqual(a, b, "two calls with the same tick must produce byte-identical plans");
  assert.ok(a !== null, "the plan should be non-null (profitable agents exist)");
});

test("planEvolution determinism holds across 100 distinct ticks (no accidental collision)", () => {
  const rows = [row(1, 0.9), row(2, 0.5), row(3, 0.2)];
  const limits = lim({ crossBias: 0.5 });
  const plans: string[] = [];

  for (let tick = 0; tick < 100; tick++) {
    let counter = 0;
    const rng = () => evoHash01(tick, counter++, DEFAULT_SALT);
    const seed = evoHash32(tick, 0, DEFAULT_SALT);
    const p = planEvolution(rows, hashById, limits, rng, seed);
    plans.push(JSON.stringify(p));
  }

  // Every plan must be reproducible: re-run and compare.
  for (let tick = 0; tick < 100; tick++) {
    let counter = 0;
    const rng = () => evoHash01(tick, counter++, DEFAULT_SALT);
    const seed = evoHash32(tick, 0, DEFAULT_SALT);
    const p = planEvolution(rows, hashById, limits, rng, seed);
    assert.equal(JSON.stringify(p), plans[tick], `tick ${tick} must replay identically`);
  }
});

test("different ticks can produce different cross/mutate decisions (rng is not constant)", () => {
  const rows = [row(1, 0.9), row(2, 0.5)];
  const limits = lim({ crossBias: 0.5 });
  const ops = new Set<string>();

  for (let tick = 0; tick < 200; tick++) {
    let counter = 0;
    const rng = () => evoHash01(tick, counter++, DEFAULT_SALT);
    const seed = evoHash32(tick, 0, DEFAULT_SALT);
    const p = planEvolution(rows, hashById, limits, rng, seed);
    if (p) ops.add(p.op);
  }

  // With crossBias=0.5 over 200 ticks, both "mutate" and "cross" should appear.
  assert.ok(ops.has("mutate"), "mutate must occur for some ticks");
  assert.ok(ops.has("cross"), "cross must occur for some ticks");
});

test("rngSeed is deterministic and varies by tick", () => {
  const seeds = new Set<number>();
  for (let tick = 0; tick < 50; tick++) {
    const seed = evoHash32(tick, 0, DEFAULT_SALT);
    // Same tick → same seed (idempotent)
    assert.equal(seed, evoHash32(tick, 0, DEFAULT_SALT));
    seeds.add(seed);
  }
  // All 50 ticks should produce distinct seeds (no collision in a 32-bit space over 50 draws).
  assert.equal(seeds.size, 50, "each tick must yield a unique rngSeed");
});

// ─── 2. Config: EVOLUTION_SALT parsing ───────────────────────────────────────────────────────────────────

test("loadConfig defaults EVOLUTION_SALT to 0x65766f", () => {
  const cfg = loadConfig(env());
  assert.equal(cfg.evolution.salt, 0x65766f);
});

test("loadConfig reads EVOLUTION_SALT from env override", () => {
  const cfg = loadConfig(env({ EVOLUTION_SALT: "0x1234" }));
  assert.equal(cfg.evolution.salt, 0x1234);
});

test("loadConfig clamps EVOLUTION_SALT to valid uint32 range", () => {
  const cfg = loadConfig(env({ EVOLUTION_SALT: "999999999999" }));
  assert.ok(cfg.evolution.salt <= 0x7fffffff, "salt must be clamped to 0x7fffffff");
  assert.ok(cfg.evolution.salt >= 0, "salt must be non-negative");
});

// ─── 3. Source audit: driveEvolution body has no Math.random / Date.now ──────────────────────────────────

test("state.ts driveEvolution contains no Math.random or Date.now in its body", () => {
  const src = readFileSync(resolve(import.meta.dirname, "state.ts"), "utf-8");

  // Extract the driveEvolution method body (from its signature to the next method or end-of-class marker).
  const start = src.indexOf("private async driveEvolution(");
  assert.ok(start >= 0, "driveEvolution must exist in state.ts");

  // Find the method's closing brace by counting brace depth.
  let depth = 0;
  let bodyStart = -1;
  let bodyEnd = -1;
  for (let i = start; i < src.length; i++) {
    if (src[i] === "{") { depth++; if (depth === 1) bodyStart = i; }
    if (src[i] === "}") { depth--; if (depth === 0) { bodyEnd = i; break; } }
  }
  assert.ok(bodyStart > 0 && bodyEnd > bodyStart, "driveEvolution body must be parseable");

  const body = src.slice(bodyStart, bodyEnd + 1);

  // Strip comments (single-line and multi-line) to avoid false positives from explanatory text.
  const stripped = body
    .replace(/\/\/[^\n]*/g, "")
    .replace(/\/\*[\s\S]*?\*\//g, "");

  assert.ok(
    !stripped.includes("Math.random"),
    "driveEvolution body must NOT contain Math.random (non-deterministic)",
  );
  assert.ok(
    !stripped.includes("Date.now"),
    "driveEvolution body must NOT contain Date.now (non-deterministic)",
  );
});

test("state.ts rollEvolutionDay uses tickIndex, not wall-clock", () => {
  const src = readFileSync(resolve(import.meta.dirname, "state.ts"), "utf-8");
  const start = src.indexOf("private rollEvolutionDay(");
  assert.ok(start >= 0, "rollEvolutionDay must exist");

  let depth = 0;
  let bodyStart = -1;
  let bodyEnd = -1;
  for (let i = start; i < src.length; i++) {
    if (src[i] === "{") { depth++; if (depth === 1) bodyStart = i; }
    if (src[i] === "}") { depth--; if (depth === 0) { bodyEnd = i; break; } }
  }
  const body = src.slice(bodyStart, bodyEnd + 1);
  const stripped = body.replace(/\/\/[^\n]*/g, "").replace(/\/\*[\s\S]*?\*\//g, "");

  assert.ok(!stripped.includes("Date.now"), "rollEvolutionDay must not use Date.now");
  assert.ok(!stripped.includes("new Date("), "rollEvolutionDay must not construct a Date from wall-clock");
  assert.ok(stripped.includes("tickIndex") || stripped.includes("EVO_TICKS_PER_DAY"),
    "rollEvolutionDay must derive day key from tickIndex");
});
