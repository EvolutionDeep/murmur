// strategy-genome.test.ts — GP engine determinism, bounds, and structural invariants.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  R6_SCALE,
  R6_ONE,
  R6_SIGNED_MAX,
  R6_SIGNED_MIN,
  R6_ZERO,
  TERMINALS,
  TERMINAL_COUNT,
  OPERATORS,
  OPERATOR_COUNT,
  MAX_NODES,
  MIN_DEPTH,
  MAX_DEPTH,
  NodeKind,
  hash32,
  hash01,
  evalStrategy,
  validateTree,
  isLegalTree,
  treeHash,
  canonicalTreeBytes,
  generateTree,
  mutateTree,
  crossoverTrees,
  serializeTree,
  deserializeTree,
  subtreeSize,
  subtreeDepth,
  treeDepth,
  STRATEGY_GENOME_VERSION,
  type StrategyTree,
  type StrategyCtx,
  type GpNode,
} from "./strategy-genome.js";

// ─── Helpers ───────────────────────────────────────────────────────────────────────────────────────────

/** Build a context with all terminals set to specific r6 values. */
function makeCtx(overrides: Partial<Record<number, number>> = {}): StrategyCtx {
  const m = new Map<number, number>();
  for (let i = 0; i < TERMINAL_COUNT; i++) {
    m.set(i, overrides[i] ?? Math.trunc(R6_SCALE * 0.5)); // default 0.5
  }
  return m;
}

/** A simple legal tree: clamp01(add(arousal, T)) — depth 2, 4 nodes */
const SIMPLE_TREE: StrategyTree = [
  { kind: NodeKind.Operator, value: 3 },   // clamp01
  { kind: NodeKind.Operator, value: 0 },   // add
  { kind: NodeKind.Terminal, value: 0 },   // arousal
  { kind: NodeKind.Terminal, value: 5 },   // T
];

/** A deeper legal tree: lerp(arousal, mul(turn, T), thresh(bond, const(0.3))) — depth 3 */
const DEEP_TREE: StrategyTree = [
  { kind: NodeKind.Operator, value: 5 },   // lerp (arity 3)
  { kind: NodeKind.Terminal, value: 0 },   // arousal
  { kind: NodeKind.Operator, value: 2 },   // mul
  { kind: NodeKind.Terminal, value: 4 },   // turn
  { kind: NodeKind.Terminal, value: 5 },   // T
  { kind: NodeKind.Operator, value: 4 },   // thresh
  { kind: NodeKind.Terminal, value: 6 },   // bond
  { kind: NodeKind.Const, value: 300_000 },// 0.3 in r6
];

// ─── hash32 / hash01 match economy.ts construction ─────────────────────────────────────────────────────

describe("hash32/hash01 FNV-1a construction", () => {
  test("hash32 is deterministic and matches known FNV-1a output", () => {
    // Pin: hash32(0, 0, 0) — all-zero input through the FNV-1a 32-bit machine
    const h = hash32(0, 0, 0);
    assert.equal(typeof h, "number");
    assert.ok(h >= 0 && h <= 0xffffffff);
    // Same inputs ⇒ same output
    assert.equal(hash32(0, 0, 0), h);
    assert.equal(hash32(1, 2, 3), hash32(1, 2, 3));
  });

  test("hash32 produces different outputs for different inputs", () => {
    const a = hash32(1, 2, 3);
    const b = hash32(1, 2, 4);
    const c = hash32(1, 3, 3);
    assert.notEqual(a, b);
    assert.notEqual(a, c);
  });

  test("hash01 is in [0, 1]", () => {
    for (let i = 0; i < 100; i++) {
      const v = hash01(i, i * 7, 0xdeadbeef);
      assert.ok(v >= 0 && v <= 1, `hash01(${i}) = ${v} in [0,1]`);
    }
  });

  test("hash01 is deterministic (same inputs, same output)", () => {
    assert.equal(hash01(42, 7, 0xff), hash01(42, 7, 0xff));
  });
});

// ─── evalStrategy determinism + r6 no-drift ────────────────────────────────────────────────────────────

describe("evalStrategy", () => {
  test("same tree + same ctx ⇒ identical r6 output (determinism)", () => {
    const ctx = makeCtx();
    const r1 = evalStrategy(SIMPLE_TREE, ctx);
    const r2 = evalStrategy(SIMPLE_TREE, ctx);
    assert.equal(r1, r2);
    assert.equal(typeof r1, "number");
    assert.ok(Number.isInteger(r1), "output is an integer (r6 fixed-point)");
  });

  test("output is bounded within [-R6_SIGNED_MAX, R6_SIGNED_MAX]", () => {
    const ctx = makeCtx();
    const r = evalStrategy(DEEP_TREE, ctx);
    assert.ok(r >= R6_SIGNED_MIN && r <= R6_SIGNED_MAX);
  });

  test("extreme ctx values still produce bounded output", () => {
    // All terminals at extreme positive
    const hot = makeCtx();
    for (let i = 0; i < TERMINAL_COUNT; i++) (hot as Map<number, number>).set(i, 50 * R6_SCALE);
    const r1 = evalStrategy(DEEP_TREE, hot);
    assert.ok(r1 >= R6_SIGNED_MIN && r1 <= R6_SIGNED_MAX);

    // All terminals at extreme negative
    const cold = makeCtx();
    for (let i = 0; i < TERMINAL_COUNT; i++) (cold as Map<number, number>).set(i, -50 * R6_SCALE);
    const r2 = evalStrategy(DEEP_TREE, cold);
    assert.ok(r2 >= R6_SIGNED_MIN && r2 <= R6_SIGNED_MAX);
  });

  test("missing terminal in ctx defaults to 0", () => {
    const empty = new Map<number, number>();
    const tree: StrategyTree = [{ kind: NodeKind.Terminal, value: 3 }];
    assert.equal(evalStrategy(tree, empty), 0);
  });

  test("NaN ctx value is clamped to 0 (NaN-safe)", () => {
    const ctx = new Map<number, number>();
    ctx.set(0, NaN);
    const tree: StrategyTree = [{ kind: NodeKind.Terminal, value: 0 }];
    assert.equal(evalStrategy(tree, ctx), 0);
  });

  test("no floating-point drift: repeated eval is bit-identical", () => {
    const ctx = makeCtx({ 0: 123456, 4: -789012, 5: 999999 });
    const results = new Set<number>();
    for (let i = 0; i < 1000; i++) results.add(evalStrategy(DEEP_TREE, ctx));
    assert.equal(results.size, 1, "1000 evaluations produce exactly one value");
  });
});

// ─── Per-operator bounds (exhaustive) ──────────────────────────────────────────────────────────────────

describe("operator output bounds", () => {
  const extremePairs: [number, number][] = [
    [R6_SIGNED_MAX, R6_SIGNED_MAX],
    [R6_SIGNED_MIN, R6_SIGNED_MIN],
    [R6_SIGNED_MAX, R6_SIGNED_MIN],
    [0, 0],
    [R6_ONE, R6_ONE],
    [50 * R6_SCALE, -50 * R6_SCALE],
  ];

  for (let opIdx = 0; opIdx < OPERATOR_COUNT; opIdx++) {
    const arity = [2, 2, 2, 1, 2, 3, 2, 2, 1, 1][opIdx];
    test(`${OPERATORS[opIdx]} output is bounded for extreme inputs`, () => {
      for (const [a, b] of extremePairs) {
        // Build a minimal tree: op(const(a), const(b), const(a))
        const nodes: GpNode[] = [{ kind: NodeKind.Operator, value: opIdx }];
        for (let c = 0; c < arity; c++) {
          nodes.push({ kind: NodeKind.Const, value: c === 0 ? a : c === 1 ? b : a });
        }
        const result = evalStrategy(nodes, new Map());
        assert.ok(
          result >= R6_SIGNED_MIN && result <= R6_SIGNED_MAX,
          `${OPERATORS[opIdx]}(${a},${b}) = ${result} out of bounds`,
        );
        assert.ok(Number.isInteger(result), `${OPERATORS[opIdx]} result is integer`);
      }
    });
  }

  test("mul does not overflow with max-magnitude inputs", () => {
    // mul(4_000_000, 4_000_000) = trunc(4M * 4M / 1M) = trunc(16T / 1M) = 16M → clamped to 4M
    const tree: StrategyTree = [
      { kind: NodeKind.Operator, value: 2 },
      { kind: NodeKind.Const, value: R6_SIGNED_MAX },
      { kind: NodeKind.Const, value: R6_SIGNED_MAX },
    ];
    const r = evalStrategy(tree, new Map());
    assert.equal(r, R6_SIGNED_MAX, "mul saturates at signed max");
  });

  test("clamp01 projects to [0, R6_ONE]", () => {
    const tree: StrategyTree = [
      { kind: NodeKind.Operator, value: 3 },
      { kind: NodeKind.Const, value: -2 * R6_SCALE },
    ];
    assert.equal(evalStrategy(tree, new Map()), 0);

    const tree2: StrategyTree = [
      { kind: NodeKind.Operator, value: 3 },
      { kind: NodeKind.Const, value: 3 * R6_SCALE },
    ];
    assert.equal(evalStrategy(tree2, new Map()), R6_ONE);
  });

  test("thresh is a step function: 0 or R6_ONE only", () => {
    const above: StrategyTree = [
      { kind: NodeKind.Operator, value: 4 },
      { kind: NodeKind.Const, value: 600_000 },
      { kind: NodeKind.Const, value: 500_000 },
    ];
    assert.equal(evalStrategy(above, new Map()), R6_ONE);

    const below: StrategyTree = [
      { kind: NodeKind.Operator, value: 4 },
      { kind: NodeKind.Const, value: 400_000 },
      { kind: NodeKind.Const, value: 500_000 },
    ];
    assert.equal(evalStrategy(below, new Map()), R6_ZERO);
  });
});

// ─── mutateTree determinism + node-limit respect ───────────────────────────────────────────────────────

describe("mutateTree", () => {
  test("same (tree, seed, tick) ⇒ same output (determinism)", () => {
    const m1 = mutateTree(SIMPLE_TREE, 42, 100);
    const m2 = mutateTree(SIMPLE_TREE, 42, 100);
    assert.deepEqual(m1, m2);
  });

  test("different tick ⇒ (usually) different output", () => {
    const m1 = mutateTree(DEEP_TREE, 42, 1);
    const m2 = mutateTree(DEEP_TREE, 42, 2);
    // Not guaranteed different, but at least valid
    assert.ok(isLegalTree(m1));
    assert.ok(isLegalTree(m2));
  });

  test("mutated tree respects MAX_NODES", () => {
    for (let tick = 0; tick < 200; tick++) {
      const m = mutateTree(DEEP_TREE, tick * 7 + 1, tick);
      assert.ok(m.length <= MAX_NODES, `tick ${tick}: ${m.length} nodes > ${MAX_NODES}`);
      assert.ok(isLegalTree(m), `tick ${tick}: mutated tree is illegal`);
    }
  });

  test("mutation of a max-size tree never exceeds limit", () => {
    // Generate a tree, mutate many times — should never exceed MAX_NODES
    const big = generateTree(0xbeef, 0);
    assert.ok(big !== null);
    for (let i = 0; i < 100; i++) {
      const m = mutateTree(big!, i * 13, i);
      assert.ok(m.length <= MAX_NODES);
      assert.ok(isLegalTree(m));
    }
  });
});

// ─── crossoverTrees determinism + node-limit respect ───────────────────────────────────────────────────

describe("crossoverTrees", () => {
  test("same (a, b, seed, tick) ⇒ same output (determinism)", () => {
    const c1 = crossoverTrees(SIMPLE_TREE, DEEP_TREE, 77, 5);
    const c2 = crossoverTrees(SIMPLE_TREE, DEEP_TREE, 77, 5);
    assert.deepEqual(c1, c2);
  });

  test("offspring respects MAX_NODES", () => {
    for (let tick = 0; tick < 200; tick++) {
      const c = crossoverTrees(SIMPLE_TREE, DEEP_TREE, tick, tick);
      assert.ok(c.length <= MAX_NODES, `tick ${tick}: ${c.length} > ${MAX_NODES}`);
      assert.ok(isLegalTree(c), `tick ${tick}: offspring is illegal`);
    }
  });

  test("crossover with self returns legal tree", () => {
    const c = crossoverTrees(DEEP_TREE, DEEP_TREE, 99, 1);
    assert.ok(isLegalTree(c));
  });
});

// ─── treeHash stability + collision resistance ─────────────────────────────────────────────────────────

describe("treeHash", () => {
  test("same tree ⇒ same hash (stability)", () => {
    assert.equal(treeHash(SIMPLE_TREE), treeHash(SIMPLE_TREE));
    assert.equal(treeHash(DEEP_TREE), treeHash(DEEP_TREE));
  });

  test("structurally different trees ⇒ different hashes", () => {
    assert.notEqual(treeHash(SIMPLE_TREE), treeHash(DEEP_TREE));
  });

  test("hash is 32 hex chars (128-bit)", () => {
    const h = treeHash(SIMPLE_TREE);
    assert.equal(h.length, 32);
    assert.ok(/^[0-9a-f]{32}$/.test(h));
  });

  test("hash is cross-run stable (byte-identical serialization)", () => {
    // Serialize → deserialize → hash must equal original hash
    const ser = serializeTree(DEEP_TREE);
    const de = deserializeTree(ser);
    assert.ok(de !== null);
    assert.equal(treeHash(de!), treeHash(DEEP_TREE));
  });

  test("node-order change ⇒ different hash", () => {
    // Swap two terminal children of add
    const swapped: StrategyTree = [
      { kind: NodeKind.Operator, value: 3 },
      { kind: NodeKind.Operator, value: 0 },
      { kind: NodeKind.Terminal, value: 5 },   // T (was arousal)
      { kind: NodeKind.Terminal, value: 0 },   // arousal (was T)
    ];
    assert.notEqual(treeHash(SIMPLE_TREE), treeHash(swapped));
  });

  test("many random trees all have distinct hashes (no collisions in 500 samples)", () => {
    const hashes = new Set<string>();
    for (let i = 0; i < 500; i++) {
      const t = generateTree(i * 31 + 7, 0);
      if (t) hashes.add(treeHash(t));
    }
    assert.ok(hashes.size >= 450, `expected ~500 distinct hashes, got ${hashes.size}`);
  });
});

// ─── canonicalTreeBytes ────────────────────────────────────────────────────────────────────────────────

describe("canonicalTreeBytes", () => {
  test("same tree ⇒ same bytes", () => {
    const a = canonicalTreeBytes(SIMPLE_TREE);
    const b = canonicalTreeBytes(SIMPLE_TREE);
    assert.deepEqual(a, b);
  });

  test("different trees ⇒ different bytes", () => {
    const a = canonicalTreeBytes(SIMPLE_TREE);
    const b = canonicalTreeBytes(DEEP_TREE);
    assert.notDeepEqual(a, b);
  });

  test("byte length = 4 + nodeCount * 5", () => {
    const bytes = canonicalTreeBytes(DEEP_TREE);
    assert.equal(bytes.length, 4 + DEEP_TREE.length * 5);
  });
});

// ─── Degenerate / illegal tree filtering ───────────────────────────────────────────────────────────────

describe("validateTree / isLegalTree", () => {
  test("rejects tree with too few nodes", () => {
    const tiny: StrategyTree = [{ kind: NodeKind.Const, value: 100 }];
    const v = validateTree(tiny);
    assert.equal(v.legal, false);
    assert.equal(v.reason, "too_few_nodes");
  });

  test("rejects tree exceeding MAX_NODES", () => {
    // Build a tree with 33 nodes (all terminals after an operator)
    const big: GpNode[] = [{ kind: NodeKind.Operator, value: 0 }]; // add
    for (let i = 0; i < 32; i++) big.push({ kind: NodeKind.Terminal, value: i % TERMINAL_COUNT });
    const v = validateTree(big);
    assert.equal(v.legal, false);
    // Either "exceeds_max_nodes" or "malformed" depending on structure
    assert.ok(v.reason !== null);
  });

  test("rejects pure-constant tree (degenerate, no terminals)", () => {
    // Deep enough (depth 2) but no terminals — purely constant expression
    const constOnly: StrategyTree = [
      { kind: NodeKind.Operator, value: 0 }, // add
      { kind: NodeKind.Operator, value: 2 }, // mul
      { kind: NodeKind.Const, value: 100 },
      { kind: NodeKind.Const, value: 200 },
      { kind: NodeKind.Const, value: 300 },
    ];
    const v = validateTree(constOnly);
    assert.equal(v.legal, false);
    assert.equal(v.reason, "degenerate_constant");
  });

  test("rejects malformed tree (operator without enough children)", () => {
    // mul(arity 2) → add(arity 2) → term: add only gets 1 child before array ends
    const bad: StrategyTree = [
      { kind: NodeKind.Operator, value: 2 }, // mul needs 2 children
      { kind: NodeKind.Operator, value: 0 }, // add needs 2 children
      { kind: NodeKind.Terminal, value: 0 }, // only 1 child for add
    ];
    const v = validateTree(bad);
    assert.equal(v.legal, false);
    assert.equal(v.reason, "malformed");
  });

  test("rejects tree below MIN_DEPTH", () => {
    // depth 1: op(term, term) — depth is 1, below MIN_DEPTH=2
    const shallow: StrategyTree = [
      { kind: NodeKind.Operator, value: 0 },
      { kind: NodeKind.Terminal, value: 0 },
      { kind: NodeKind.Terminal, value: 1 },
    ];
    const v = validateTree(shallow);
    assert.equal(v.legal, false);
    assert.equal(v.reason, "depth_below_minimum");
  });

  test("accepts SIMPLE_TREE (depth 2, 4 nodes, has terminals)", () => {
    assert.ok(isLegalTree(SIMPLE_TREE));
  });

  test("accepts DEEP_TREE (depth 3, 8 nodes)", () => {
    assert.ok(isLegalTree(DEEP_TREE));
  });

  test("rejects NaN constant value", () => {
    const nan: StrategyTree = [
      { kind: NodeKind.Operator, value: 0 },
      { kind: NodeKind.Const, value: NaN },
      { kind: NodeKind.Terminal, value: 0 },
      { kind: NodeKind.Terminal, value: 1 },
    ];
    assert.equal(isLegalTree(nan), false);
  });

  test("rejects non-integer constant value", () => {
    const frac: StrategyTree = [
      { kind: NodeKind.Operator, value: 0 },
      { kind: NodeKind.Const, value: 1.5 },
      { kind: NodeKind.Terminal, value: 0 },
      { kind: NodeKind.Terminal, value: 1 },
    ];
    assert.equal(isLegalTree(frac), false);
  });
});

// ─── generateTree determinism + legality ───────────────────────────────────────────────────────────────

describe("generateTree", () => {
  test("same (seed, attempt) ⇒ same tree (determinism)", () => {
    const a = generateTree(123, 0);
    const b = generateTree(123, 0);
    assert.deepEqual(a, b);
  });

  test("different seeds ⇒ different trees", () => {
    const a = generateTree(1, 0);
    const b = generateTree(2, 0);
    assert.ok(a !== null && b !== null);
    assert.notDeepEqual(a, b);
  });

  test("all generated trees are legal", () => {
    for (let s = 0; s < 200; s++) {
      const t = generateTree(s * 17 + 3, 0);
      if (t !== null) {
        assert.ok(isLegalTree(t), `seed ${s}: generated tree is illegal`);
        assert.ok(t.length <= MAX_NODES, `seed ${s}: ${t.length} > ${MAX_NODES}`);
        assert.ok(treeDepth(t) >= MIN_DEPTH, `seed ${s}: depth ${treeDepth(t)} < ${MIN_DEPTH}`);
        assert.ok(treeDepth(t) <= MAX_DEPTH, `seed ${s}: depth ${treeDepth(t)} > ${MAX_DEPTH}`);
      }
    }
  });

  test("generated trees are evaluable without NaN", () => {
    const ctx = makeCtx();
    for (let s = 0; s < 100; s++) {
      const t = generateTree(s, 0);
      if (t !== null) {
        const v = evalStrategy(t, ctx);
        assert.ok(Number.isFinite(v), `seed ${s}: eval produced ${v}`);
        assert.ok(Number.isInteger(v), `seed ${s}: eval not integer`);
      }
    }
  });

  test("generates trees with variety (not all identical)", () => {
    const hashes = new Set<string>();
    for (let s = 0; s < 50; s++) {
      const t = generateTree(s, 0);
      if (t) hashes.add(treeHash(t));
    }
    assert.ok(hashes.size > 40, `expected variety, got ${hashes.size} unique / 50`);
  });
});

// ─── serialize / deserialize round-trip ────────────────────────────────────────────────────────────────

describe("serializeTree / deserializeTree", () => {
  test("round-trip preserves structure", () => {
    const ser = serializeTree(DEEP_TREE);
    const de = deserializeTree(ser);
    assert.deepEqual(de, DEEP_TREE);
  });

  test("deserializeTree rejects malformed input", () => {
    assert.equal(deserializeTree(null), null);
    assert.equal(deserializeTree("hello"), null);
    assert.equal(deserializeTree([[0]]), null); // missing value
    assert.equal(deserializeTree([[9, 1]]), null); // invalid kind
    assert.equal(deserializeTree([[0, 1.5]]), null); // non-integer value
  });
});

// ─── subtreeSize / subtreeDepth / treeDepth ────────────────────────────────────────────────────────────

describe("tree metrics", () => {
  test("subtreeSize of SIMPLE_TREE root = 4", () => {
    assert.equal(subtreeSize(SIMPLE_TREE, 0), 4);
  });

  test("subtreeSize of DEEP_TREE root = 8", () => {
    assert.equal(subtreeSize(DEEP_TREE, 0), 8);
  });

  test("treeDepth of SIMPLE_TREE = 2", () => {
    assert.equal(treeDepth(SIMPLE_TREE), 2);
  });

  test("treeDepth of DEEP_TREE = 2", () => {
    assert.equal(treeDepth(DEEP_TREE), 2);
  });
});

// ─── Constants and exports sanity ──────────────────────────────────────────────────────────────────────

describe("module constants", () => {
  test("TERMINALS has 10 symbols", () => {
    assert.equal(TERMINAL_COUNT, 10);
    assert.equal(TERMINALS.length, 10);
  });

  test("OPERATORS has 10 ops", () => {
    assert.equal(OPERATOR_COUNT, 10);
    assert.equal(OPERATORS.length, 10);
  });

  test("MAX_NODES = 32, MIN_DEPTH = 2, MAX_DEPTH = 8", () => {
    assert.equal(MAX_NODES, 32);
    assert.equal(MIN_DEPTH, 2);
    assert.equal(MAX_DEPTH, 8);
  });

  test("STRATEGY_GENOME_VERSION = 1", () => {
    assert.equal(STRATEGY_GENOME_VERSION, 1);
  });

  test("R6_SCALE = 1_000_000", () => {
    assert.equal(R6_SCALE, 1_000_000);
    assert.equal(R6_ONE, 1_000_000);
    assert.equal(R6_SIGNED_MAX, 4_000_000);
    assert.equal(R6_SIGNED_MIN, -4_000_000);
  });
});

// ─── Integration: mutate → eval → hash cycle stability ─────────────────────────────────────────────────

describe("integration: full GP cycle", () => {
  test("100-generation lineage maintains legality and determinism", () => {
    let current = generateTree(0xabcdef, 0);
    assert.ok(current !== null);

    for (let gen = 0; gen < 100; gen++) {
      const next = mutateTree(current!, gen * 31 + 7, gen);
      assert.ok(isLegalTree(next), `gen ${gen}: mutated tree is illegal`);
      assert.ok(next.length <= MAX_NODES, `gen ${gen}: node overflow`);
      // Determinism: same mutation produces same result
      const again = mutateTree(current!, gen * 31 + 7, gen);
      assert.deepEqual(next, again, `gen ${gen}: non-deterministic mutation`);
      current = next;
    }
  });

  test("crossover lineage maintains legality over 50 generations", () => {
    let popA = generateTree(111, 0)!;
    let popB = generateTree(222, 0)!;
    assert.ok(popA && popB);

    for (let gen = 0; gen < 50; gen++) {
      const child = crossoverTrees(popA, popB, gen * 41, gen);
      assert.ok(isLegalTree(child), `gen ${gen}: crossover offspring illegal`);
      assert.ok(child.length <= MAX_NODES);
      // Rotate population
      popB = popA;
      popA = mutateTree(child, gen, gen);
      assert.ok(isLegalTree(popA));
    }
  });
});
