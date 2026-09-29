// GP Strategy-Genome Engine (Phase 2a, capability 2) — a deterministic, bounded genetic-programming
// expression tree over the EXISTING neural read-out symbols. This module is PURE (no I/O, no crypto,
// no clock, no Math.random) and runs identically in Worker, Node, browser and offline CLI.
//
// WHY GP ON A FIXED CONNECTOME. Production uses the real FlyWire FAFB 783 subgraph (10,361 neurons /
// 467,314 synapses) whose topology is FIXED — only 4 heritable scalars per fly. New STRATEGIES therefore
// come from evolving expression trees (this module) on top of the fixed neural read-outs, NOT from
// evolving the connectome. Phase 2b will wire these trees into real USDC trading decisions.
//
// DETERMINISM CONTRACT. All stochastic operations (generate, mutate, cross) are driven exclusively by
// FNV-1a hash01(seed, counter, salt) — the SAME construction used in economy.ts (~L4019) and state.ts.
// Given identical (tree, seed, tick), every function produces byte-identical output across runs/processes.
//
// FIXED-POINT r6. All values are SCALED INTEGERS: 1.0 = R6_SCALE = 1_000_000. No floating-point enters
// any serialised/hashed state or any operator computation. Multiplication uses a safe trunc-divide that
// cannot overflow (inputs are pre-clamped so a*b < 2^53). This matches the project's provenance r6
// convention (provenance.ts L100: `Math.round(x * 1e6) / 1e6`) but stays INTEGER throughout.
//
// manifestHash INVARIANT: terminals are ONLY existing neural read-out symbols. This module adds ZERO
// sensory channels, ZERO neurons, ZERO synapses. The connectome topology and its on-chain manifest hash
// are byte-for-byte unchanged.

// ────────────────────────────────────────────────────────────────────────────────────────────────────────
// Fixed-point r6 constants
// ────────────────────────────────────────────────────────────────────────────────────────────────────────

/** One unit in r6 fixed-point (1.0). All operator arithmetic uses integer multiples of this. */
export const R6_SCALE = 1_000_000;

/** Signed clamp ceiling for operator outputs: ±4.0 in r6. */
export const R6_SIGNED_MAX = 4 * R6_SCALE;
export const R6_SIGNED_MIN = -R6_SIGNED_MAX;

/** Unit-interval clamp bounds (0.0 .. 1.0 in r6). */
export const R6_ZERO = 0;
export const R6_ONE = R6_SCALE;

// ────────────────────────────────────────────────────────────────────────────────────────────────────────
// Terminal symbols — EXISTING neural read-outs only (never add new ones without rotating manifestHash)
// ────────────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * The complete set of terminal symbols available to strategy trees. Each maps to an existing neural or
 * social read-out that Phase 2b will supply as an r6 integer at evaluation time.
 *
 *   arousal  — motor-decoder population-relative arousal drive [0,1]
 *   wingbeat — motor-decoder wing-beat intensity [0,1]
 *   rest     — motor-decoder abdominal rest tone [0,1]
 *   cohesion — motor-decoder proboscis/approach drive [0,1]
 *   turn     — motor-decoder turn bias [-1,1] (signed)
 *   T        — market temperature [0,1]
 *   bond     — social bond strength [0,1]
 *   rep      — reputation score [0,1]
 *   daHz     — DA-like neuromodulatory firing rate (Hz, raw) [0,~50]
 *   oaHz     — OA-like neuromodulatory firing rate (Hz, raw) [0,~50]
 */
export const TERMINALS = [
  "arousal",
  "wingbeat",
  "rest",
  "cohesion",
  "turn",
  "T",
  "bond",
  "rep",
  "daHz",
  "oaHz",
] as const;

export type TerminalSymbol = (typeof TERMINALS)[number];
export const TERMINAL_COUNT = TERMINALS.length;

// ────────────────────────────────────────────────────────────────────────────────────────────────────────
// Operator whitelist — 10 bounded operators (NO unbounded growth)
// ────────────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * Operator semantics (all inputs/outputs are r6 integers):
 *
 *  add(a, b)       → clampSigned(a + b)                           [-4, 4]
 *  sub(a, b)       → clampSigned(a - b)                           [-4, 4]
 *  mul(a, b)       → clampSigned(trunc(a * b / R6_SCALE))         [-4, 4]  (safe: clamped inputs ⇒ product < 2^53)
 *  clamp01(a)      → clamp(a, 0, R6_ONE)                          [0, 1]
 *  thresh(a, b)    → (a >= b) ? R6_ONE : 0                        {0, 1}
 *  lerp(a, b, c)   → clampSigned(a + trunc(clamp01(c)*(b-a)/R6))  [-4, 4]
 *  min(a, b)       → min(a, b)                                    (inherits input bounds)
 *  max(a, b)       → max(a, b)                                    (inherits input bounds)
 *  neg(a)          → clampSigned(-a)                              [-4, 4]
 *  abs(a)          → min(|a|, R6_SIGNED_MAX)                      [0, 4]
 */
export const OPERATORS = [
  "add",
  "sub",
  "mul",
  "clamp01",
  "thresh",
  "lerp",
  "min",
  "max",
  "neg",
  "abs",
] as const;

export type OperatorSymbol = (typeof OPERATORS)[number];
export const OPERATOR_COUNT = OPERATORS.length;

/** Arity table indexed by operator index. */
const OP_ARITY: readonly number[] = [2, 2, 2, 1, 2, 3, 2, 2, 1, 1];

// ────────────────────────────────────────────────────────────────────────────────────────────────────────
// Tree representation — flat pre-order array of GpNodes
// ────────────────────────────────────────────────────────────────────────────────────────────────────────

/** Node kind discriminant. */
export const enum NodeKind {
  Const = 0,
  Terminal = 1,
  Operator = 2,
}

/**
 * A single node in the GP expression tree. Trees are stored as flat pre-order arrays of GpNodes.
 * This representation enables O(1) subtree indexing and efficient mutation/crossover.
 */
export interface GpNode {
  /** Discriminant: 0=constant, 1=terminal, 2=operator */
  readonly kind: NodeKind;
  /** Const: r6 integer value; Terminal: index into TERMINALS; Operator: index into OPERATORS */
  readonly value: number;
}

/** A strategy expression tree — flat pre-order array, length ≤ MAX_NODES. */
export type StrategyTree = readonly GpNode[];

// ────────────────────────────────────────────────────────────────────────────────────────────────────────
// Tree constraints
// ────────────────────────────────────────────────────────────────────────────────────────────────────────

/** Hard upper bound on node count. */
export const MAX_NODES = 32;
/** Minimum tree depth (root at depth 0). Trees shallower than this are degenerate. */
export const MIN_DEPTH = 2;
/** Maximum tree depth to prevent stack overflow during evaluation. */
export const MAX_DEPTH = 8;

// ────────────────────────────────────────────────────────────────────────────────────────────────────────
// Deterministic FNV-1a hash — BYTE-IDENTICAL to economy.ts hash32/hash01 (L4019-4032)
// ────────────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * FNV-1a 32-bit over three uint32 inputs, processed LSB-first byte-by-byte.
 * IDENTICAL construction to economy.ts hash32 (offset basis 0x811c9dc5, prime 0x01000193).
 * Cross-package byte-stable: the same (a,b,c) always yields the same uint32.
 */
export function hash32(a: number, b: number, c: number): number {
  let h = 0x811c9dc5;
  const mix = (x: number) => {
    for (let s = 0; s < 32; s += 8) {
      h = Math.imul(h ^ ((x >>> s) & 0xff), 0x01000193) >>> 0;
    }
  };
  mix(a >>> 0);
  mix(b >>> 0);
  mix(c >>> 0);
  return h >>> 0;
}

/** Uniform [0,1) draw from (a, b, salt) — IDENTICAL to economy.ts hash01. */
export function hash01(a: number, b: number, salt: number): number {
  return hash32(a, b, salt) / 0xffffffff;
}

// Private salt constants for this module's hash streams (never alias economy/culture/faith/evolution).
const SALT_GP_GEN = 0x67706765;    // "gpge" — generate
const SALT_GP_MUT = 0x67706d74;    // "gpmt" — mutate
const SALT_GP_CRX = 0x67706378;    // "gpcx" — crossover
const SALT_GP_HASH = 0x67706873;   // "gphs" — treeHash

// ────────────────────────────────────────────────────────────────────────────────────────────────────────
// Internal helpers
// ────────────────────────────────────────────────────────────────────────────────────────────────────────

/** Clamp an r6 value to the signed range [-4.0, +4.0]. */
function clampSigned(x: number): number {
  if (!Number.isFinite(x)) return 0;
  return x > R6_SIGNED_MAX ? R6_SIGNED_MAX : x < R6_SIGNED_MIN ? R6_SIGNED_MIN : Math.trunc(x);
}

/** Clamp an r6 value to [0, 1.0]. */
function clampUnit(x: number): number {
  if (!Number.isFinite(x)) return 0;
  return x > R6_ONE ? R6_ONE : x < 0 ? 0 : Math.trunc(x);
}

/** r6 fixed-point multiply: trunc(a * b / R6_SCALE), inputs pre-clamped so product < 2^53. */
function mulR6(a: number, b: number): number {
  return clampSigned(Math.trunc((a * b) / R6_SCALE));
}

/** Compute subtree size starting at index `i` in a pre-order tree. */
export function subtreeSize(tree: StrategyTree, i: number): number {
  const node = tree[i];
  if (!node || node.kind !== NodeKind.Operator) return 1;
  let size = 1;
  const arity = OP_ARITY[node.value] ?? 0;
  for (let c = 0; c < arity; c++) {
    size += subtreeSize(tree, i + size);
  }
  return size;
}

/** Compute depth of a subtree rooted at index `i`. */
export function subtreeDepth(tree: StrategyTree, i: number): number {
  const node = tree[i];
  if (!node || node.kind !== NodeKind.Operator) return 0;
  const arity = OP_ARITY[node.value] ?? 0;
  let maxChild = 0;
  let offset = 1;
  for (let c = 0; c < arity; c++) {
    const d = subtreeDepth(tree, i + offset);
    if (d > maxChild) maxChild = d;
    offset += subtreeSize(tree, i + offset);
  }
  return 1 + maxChild;
}

/** Total depth of the tree (root = depth 0). */
export function treeDepth(tree: StrategyTree): number {
  return subtreeDepth(tree, 0);
}

/** Collect all subtree-start indices in pre-order. */
function allSubtreeIndices(tree: StrategyTree): number[] {
  const indices: number[] = [];
  const walk = (i: number): number => {
    indices.push(i);
    const node = tree[i];
    if (!node || node.kind !== NodeKind.Operator) return 1;
    let size = 1;
    const arity = OP_ARITY[node.value] ?? 0;
    for (let c = 0; c < arity; c++) {
      size += walk(i + size);
    }
    return size;
  };
  walk(0);
  return indices;
}

// ────────────────────────────────────────────────────────────────────────────────────────────────────────
// Evaluation — pure, deterministic, r6 fixed-point
// ────────────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * Evaluation context: maps terminal INDEX → r6 integer value. Phase 2b will build this from live neural
 * read-outs. A missing terminal defaults to 0 (neutral).
 */
export type StrategyCtx = ReadonlyMap<number, number>;

/**
 * Evaluate a strategy tree against a context. Returns an r6 integer in [-R6_SIGNED_MAX, +R6_SIGNED_MAX].
 * PURE + DETERMINISTIC: same (tree, ctx) ⇒ same output, always. No side-effects, no allocation beyond
 * the recursion stack (depth ≤ MAX_DEPTH = 8, safe).
 *
 * If the tree is malformed (unexpected end), returns 0 rather than throwing — callers should validate
 * trees with isLegalTree() before trusting results.
 */
export function evalStrategy(tree: StrategyTree, ctx: StrategyCtx): number {
  let pos = 0;

  const evalNode = (): number => {
    if (pos >= tree.length) return 0;
    const node = tree[pos++];

    switch (node.kind) {
      case NodeKind.Const:
        return clampSigned(node.value);

      case NodeKind.Terminal: {
        const raw = ctx.get(node.value);
        return clampSigned(raw == null ? 0 : raw);
      }

      case NodeKind.Operator: {
        const arity = OP_ARITY[node.value] ?? 0;
        // Evaluate children left-to-right (deterministic order)
        const args: number[] = [];
        for (let c = 0; c < arity; c++) args.push(evalNode());
        return applyOp(node.value, args);
      }

      default:
        return 0;
    }
  };

  return evalNode();
}

/** Apply one operator to its (already-evaluated, already-bounded) r6 arguments. */
function applyOp(opIdx: number, args: readonly number[]): number {
  switch (opIdx) {
    case 0: // add
      return clampSigned(args[0] + args[1]);
    case 1: // sub
      return clampSigned(args[0] - args[1]);
    case 2: // mul (r6 fixed-point multiply)
      return mulR6(args[0], args[1]);
    case 3: // clamp01
      return clampUnit(args[0]);
    case 4: // thresh (step function)
      return args[0] >= args[1] ? R6_ONE : R6_ZERO;
    case 5: { // lerp(a, b, t) = a + t*(b-a), t clamped to [0,1]
      const t = clampUnit(args[2]);
      const diff = clampSigned(args[1] - args[0]);
      return clampSigned(args[0] + Math.trunc((t * diff) / R6_SCALE));
    }
    case 6: // min
      return args[0] < args[1] ? args[0] : args[1];
    case 7: // max
      return args[0] > args[1] ? args[0] : args[1];
    case 8: // neg
      return clampSigned(-args[0]);
    case 9: // abs
      return clampSigned(Math.abs(args[0]));
    default:
      return 0;
  }
}

// ────────────────────────────────────────────────────────────────────────────────────────────────────────
// Tree validation
// ────────────────────────────────────────────────────────────────────────────────────────────────────────

export interface TreeValidation {
  legal: boolean;
  nodeCount: number;
  depth: number;
  /** Reason for rejection (null if legal). */
  reason: string | null;
}

/**
 * Validate a strategy tree against all structural constraints. Returns a detailed result.
 * A tree is LEGAL iff:
 *   1. Node count ∈ [3, MAX_NODES]
 *   2. Depth ∈ [MIN_DEPTH, MAX_DEPTH]
 *   3. Well-formed (every operator has exactly arity children, no dangling refs)
 *   4. Not degenerate (not a constant-fold to a single value regardless of ctx)
 */
export function validateTree(tree: StrategyTree): TreeValidation {
  const nodeCount = tree.length;
  if (nodeCount < 3) return { legal: false, nodeCount, depth: 0, reason: "too_few_nodes" };
  if (nodeCount > MAX_NODES) return { legal: false, nodeCount, depth: 0, reason: "exceeds_max_nodes" };

  // Well-formedness check
  let pos = 0;
  const check = (): boolean => {
    if (pos >= tree.length) return false;
    const node = tree[pos++];
    if (node.kind === NodeKind.Const) {
      return Number.isFinite(node.value) && node.value === Math.trunc(node.value);
    }
    if (node.kind === NodeKind.Terminal) {
      return node.value >= 0 && node.value < TERMINAL_COUNT;
    }
    if (node.kind === NodeKind.Operator) {
      if (node.value < 0 || node.value >= OPERATOR_COUNT) return false;
      const arity = OP_ARITY[node.value];
      for (let c = 0; c < arity; c++) {
        if (!check()) return false;
      }
      return true;
    }
    return false;
  };
  if (!check()) return { legal: false, nodeCount, depth: 0, reason: "malformed" };
  if (pos !== tree.length) return { legal: false, nodeCount, depth: 0, reason: "trailing_nodes" };

  const depth = treeDepth(tree);
  if (depth < MIN_DEPTH) return { legal: false, nodeCount, depth, reason: "depth_below_minimum" };
  if (depth > MAX_DEPTH) return { legal: false, nodeCount, depth, reason: "depth_exceeds_maximum" };

  // Degeneracy: tree uses at least one terminal (otherwise it is a constant expression)
  const hasTerminal = tree.some((n) => n.kind === NodeKind.Terminal);
  if (!hasTerminal) return { legal: false, nodeCount, depth, reason: "degenerate_constant" };

  return { legal: true, nodeCount, depth, reason: null };
}

/** Convenience: true if the tree passes all structural constraints. */
export function isLegalTree(tree: StrategyTree): boolean {
  return validateTree(tree).legal;
}

// ────────────────────────────────────────────────────────────────────────────────────────────────────────
// Tree hash — deterministic, cross-process stable
// ────────────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * Deterministic 128-bit hash of a strategy tree (32 lowercase hex chars). Produced by four independent
 * FNV-1a 32-bit passes over the node array with different salts. Same tree ⇒ same hash, always, on any
 * JS engine. Suitable for folding into breed.ts genomeHash and on-chain ConnectomeLineage.
 *
 * The canonical serialization is the flat pre-order node array itself: each node contributes (kind, value)
 * as two uint32s folded into the hash state. No JSON, no string allocation, no engine-dependent ordering.
 */
export function treeHash(tree: StrategyTree): string {
  // Four independent 32-bit FNV-1a passes with distinct salts → 128-bit composite
  let h0 = 0x811c9dc5;
  let h1 = 0x811c9dc5;
  let h2 = 0x811c9dc5;
  let h3 = 0x811c9dc5;

  const foldByte = (h: number, byte: number): number =>
    (Math.imul(h ^ (byte & 0xff), 0x01000193) >>> 0);

  const foldInt = (h: number, n: number): number => {
    const u = n | 0;
    let x = h;
    x = foldByte(x, u & 0xff);
    x = foldByte(x, (u >>> 8) & 0xff);
    x = foldByte(x, (u >>> 16) & 0xff);
    x = foldByte(x, (u >>> 24) & 0xff);
    return x;
  };

  // Fold tree length first (distinguishes trees of different sizes)
  h0 = foldInt(h0, tree.length);
  h1 = foldInt(h1, tree.length ^ 0x5a5a5a5a);
  h2 = foldInt(h2, tree.length ^ 0xa5a5a5a5);
  h3 = foldInt(h3, tree.length ^ 0xffffffff);

  for (let i = 0; i < tree.length; i++) {
    const node = tree[i];
    h0 = foldInt(foldInt(h0, node.kind), node.value);
    h1 = foldInt(foldInt(h1, node.value), node.kind);
    h2 = foldInt(h2, (node.kind << 28) ^ (node.value & 0x0fffffff));
    h3 = foldInt(h3, (node.value << 4) ^ node.kind);
  }

  // Final mix with module salt
  h0 = hash32(h0, h1, SALT_GP_HASH);
  h1 = hash32(h1, h2, SALT_GP_HASH ^ 0x11111111);
  h2 = hash32(h2, h3, SALT_GP_HASH ^ 0x22222222);
  h3 = hash32(h3, h0, SALT_GP_HASH ^ 0x33333333);

  return (
    (h0 >>> 0).toString(16).padStart(8, "0") +
    (h1 >>> 0).toString(16).padStart(8, "0") +
    (h2 >>> 0).toString(16).padStart(8, "0") +
    (h3 >>> 0).toString(16).padStart(8, "0")
  );
}

/**
 * Canonical byte serialization of a tree (for external sha256 if needed by 2b).
 * Format: 4-byte LE node count, then for each node 1-byte kind + 4-byte LE value.
 */
export function canonicalTreeBytes(tree: StrategyTree): Uint8Array {
  const buf = new Uint8Array(4 + tree.length * 5);
  const view = new DataView(buf.buffer);
  view.setUint32(0, tree.length, true);
  for (let i = 0; i < tree.length; i++) {
    const off = 4 + i * 5;
    buf[off] = tree[i].kind;
    view.setInt32(off + 1, tree[i].value, true);
  }
  return buf;
}

// ────────────────────────────────────────────────────────────────────────────────────────────────────────
// Random tree generation (deterministic, hash01-seeded)
// ────────────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * Generate a random legal strategy tree. DETERMINISTIC: same (seed, attempt) ⇒ same tree.
 * Uses the "grow" method: at each position, probabilistically choose operator or terminal,
 * respecting depth limits. If the result is illegal, retries with attempt+1 (up to maxAttempts).
 *
 * @param seed     uint32 PRNG seed (e.g. from tick/agentId)
 * @param attempt  retry counter (0-based); different attempts explore different trees
 * @param maxAttempts  how many retries before giving up (default 64)
 * @returns A legal StrategyTree, or null if no legal tree was found within maxAttempts.
 */
export function generateTree(
  seed: number,
  attempt: number = 0,
  maxAttempts: number = 64,
): StrategyTree | null {
  for (let att = attempt; att < attempt + maxAttempts; att++) {
    const tree = growTree(seed, att, 0, 0);
    if (tree !== null && isLegalTree(tree)) return tree;
  }
  return null;
}

/**
 * Internal recursive "grow" generator. Target depth is randomised between MIN_DEPTH and MAX_DEPTH.
 * At depths < targetDepth, may place an operator; at targetDepth, always places a terminal or const.
 * Called with targetDepth=0 to signal "first call — initialise target depth from hash".
 */
function growTree(seed: number, attempt: number, depth: number, targetDepth: number): GpNode[] | null {
  // Initialise target depth on first call (signaled by targetDepth === 0)
  if (targetDepth === 0) {
    const td = MIN_DEPTH + Math.floor(hash01(seed, attempt, SALT_GP_GEN) * (MAX_DEPTH - MIN_DEPTH + 1));
    return growTree(seed, attempt, 0, td);
  }

  let counter = depth * 1000 + attempt;
  const draw = () => hash01(seed, counter++, SALT_GP_GEN);

  // Budget check (caller tracks externally; here we just grow and validate after)
  const nodes: GpNode[] = [];

  const build = (d: number): boolean => {
    if (nodes.length >= MAX_NODES) return false;

    // At max depth or near budget, force a leaf
    if (d >= targetDepth || nodes.length >= MAX_NODES - 1) {
      // 70% terminal, 30% constant
      if (draw() < 0.7) {
        const sym = Math.floor(draw() * TERMINAL_COUNT) % TERMINAL_COUNT;
        nodes.push({ kind: NodeKind.Terminal, value: sym });
      } else {
        // Constant in [-1.0, 1.0] r6 range (most useful for strategies)
        const v = Math.trunc((draw() * 2 - 1) * R6_SCALE);
        nodes.push({ kind: NodeKind.Const, value: clampSigned(v) });
      }
      return true;
    }

    // Interior: 75% operator, 25% leaf (gives varied shapes)
    if (draw() < 0.75) {
      const opIdx = Math.floor(draw() * OPERATOR_COUNT) % OPERATOR_COUNT;
      const arity = OP_ARITY[opIdx];
      nodes.push({ kind: NodeKind.Operator, value: opIdx });
      for (let c = 0; c < arity; c++) {
        if (!build(d + 1)) return false;
      }
      return true;
    } else {
      // Leaf
      if (draw() < 0.8) {
        const sym = Math.floor(draw() * TERMINAL_COUNT) % TERMINAL_COUNT;
        nodes.push({ kind: NodeKind.Terminal, value: sym });
      } else {
        const v = Math.trunc((draw() * 2 - 1) * R6_SCALE);
        nodes.push({ kind: NodeKind.Const, value: clampSigned(v) });
      }
      return true;
    }
  };

  if (!build(0)) return null;
  return nodes;
}

// ────────────────────────────────────────────────────────────────────────────────────────────────────────
// Mutation — subtree replacement + constant perturbation (hash01-driven)
// ────────────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * Mutate a strategy tree deterministically. Two modes chosen by hash draw:
 *   1. Subtree replacement (~60%): pick a random subtree, replace with a freshly-grown one.
 *   2. Constant perturbation (~40%): pick a random constant node, jitter its value ±20%.
 *
 * If the result exceeds MAX_NODES or fails validation, falls back to the ORIGINAL tree (never returns
 * an illegal tree). Same (tree, seed, tick) ⇒ same output, always.
 *
 * @param tree  the parent tree (must be legal)
 * @param seed  uint32 deterministic seed
 * @param tick  tick counter (differentiates successive mutations of the same tree)
 */
export function mutateTree(tree: StrategyTree, seed: number, tick: number): StrategyTree {
  const mode = hash01(seed, tick, SALT_GP_MUT);

  if (mode < 0.6) {
    // Subtree replacement
    return mutateSubtree(tree, seed, tick);
  } else {
    // Constant perturbation (or subtree if no constants exist)
    const result = mutateConstant(tree, seed, tick);
    return result ?? mutateSubtree(tree, seed, tick);
  }
}

function mutateSubtree(tree: StrategyTree, seed: number, tick: number): StrategyTree {
  const indices = allSubtreeIndices(tree);
  if (indices.length === 0) return tree;

  // Pick a random subtree to replace
  const pick = Math.floor(hash01(seed, tick * 7 + 1, SALT_GP_MUT) * indices.length) % indices.length;
  const replaceAt = indices[pick];
  const oldSize = subtreeSize(tree, replaceAt);

  // Grow a replacement subtree with limited depth
  const maxNewDepth = Math.min(MAX_DEPTH - 1, 3);
  const replacement = growSubtree(seed, tick, maxNewDepth);
  if (replacement === null) return tree;

  // Splice: before + replacement + after
  const newNodes = [
    ...tree.slice(0, replaceAt),
    ...replacement,
    ...tree.slice(replaceAt + oldSize),
  ];

  // Enforce node limit
  if (newNodes.length > MAX_NODES) return tree;
  if (!isLegalTree(newNodes)) return tree;
  return newNodes;
}

function mutateConstant(tree: StrategyTree, seed: number, tick: number): StrategyTree | null {
  // Find all constant nodes
  const constIndices: number[] = [];
  for (let i = 0; i < tree.length; i++) {
    if (tree[i].kind === NodeKind.Const) constIndices.push(i);
  }
  if (constIndices.length === 0) return null;

  const pick = Math.floor(hash01(seed, tick * 13 + 3, SALT_GP_MUT) * constIndices.length) % constIndices.length;
  const idx = constIndices[pick];
  const old = tree[idx].value;

  // Jitter ±20% of R6_SCALE (up to ±0.2 in real terms)
  const jitter = Math.trunc((hash01(seed, tick * 17 + 5, SALT_GP_MUT) * 2 - 1) * 0.2 * R6_SCALE);
  const newVal = clampSigned(old + jitter);

  const mutated = tree.slice() as GpNode[];
  mutated[idx] = { kind: NodeKind.Const, value: newVal };
  if (!isLegalTree(mutated)) return null;
  return mutated;
}

/** Grow a small random subtree (≤ maxDepth, ≤ 8 nodes) for mutation replacement. */
function growSubtree(seed: number, tick: number, maxDepth: number): GpNode[] | null {
  const nodes: GpNode[] = [];
  let counter = tick * 31;
  const draw = () => hash01(seed, counter++, SALT_GP_MUT);

  const build = (d: number): boolean => {
    if (nodes.length >= 8) return false;
    if (d >= maxDepth || nodes.length >= 7) {
      // Leaf
      if (draw() < 0.75) {
        nodes.push({ kind: NodeKind.Terminal, value: Math.floor(draw() * TERMINAL_COUNT) % TERMINAL_COUNT });
      } else {
        nodes.push({ kind: NodeKind.Const, value: clampSigned(Math.trunc((draw() * 2 - 1) * R6_SCALE)) });
      }
      return true;
    }
    if (draw() < 0.65) {
      const opIdx = Math.floor(draw() * OPERATOR_COUNT) % OPERATOR_COUNT;
      const arity = OP_ARITY[opIdx];
      nodes.push({ kind: NodeKind.Operator, value: opIdx });
      for (let c = 0; c < arity; c++) {
        if (!build(d + 1)) return false;
      }
      return true;
    }
    // Leaf
    if (draw() < 0.8) {
      nodes.push({ kind: NodeKind.Terminal, value: Math.floor(draw() * TERMINAL_COUNT) % TERMINAL_COUNT });
    } else {
      nodes.push({ kind: NodeKind.Const, value: clampSigned(Math.trunc((draw() * 2 - 1) * R6_SCALE)) });
    }
    return true;
  };

  if (!build(0)) return null;
  return nodes;
}

// ────────────────────────────────────────────────────────────────────────────────────────────────────────
// Crossover — subtree swap between two parents (hash01-driven)
// ────────────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * Deterministic subtree-swap crossover between two parent trees. Picks one subtree from each parent
 * (hash01-gated) and swaps them. If the offspring exceeds MAX_NODES or fails validation, returns
 * parent A unchanged (never returns an illegal tree).
 *
 * Same (a, b, seed, tick) ⇒ same output, always.
 */
export function crossoverTrees(
  a: StrategyTree,
  b: StrategyTree,
  seed: number,
  tick: number,
): StrategyTree {
  const indicesA = allSubtreeIndices(a);
  const indicesB = allSubtreeIndices(b);
  if (indicesA.length === 0 || indicesB.length === 0) return a;

  const pickA = Math.floor(hash01(seed, tick * 23 + 7, SALT_GP_CRX) * indicesA.length) % indicesA.length;
  const pickB = Math.floor(hash01(seed, tick * 29 + 11, SALT_GP_CRX) * indicesB.length) % indicesB.length;

  const cutA = indicesA[pickA];
  const cutB = indicesB[pickB];
  const sizeA = subtreeSize(a, cutA);
  const sizeB = subtreeSize(b, cutB);

  // Offspring = a[0..cutA) + b[cutB..cutB+sizeB) + a[cutA+sizeA..)
  const offspring = [
    ...a.slice(0, cutA),
    ...b.slice(cutB, cutB + sizeB),
    ...a.slice(cutA + sizeA),
  ];

  if (offspring.length > MAX_NODES) return a;
  if (!isLegalTree(offspring)) return a;
  return offspring;
}

// ────────────────────────────────────────────────────────────────────────────────────────────────────────
// Serialization helpers (for 2b persistence / lineage)
// ────────────────────────────────────────────────────────────────────────────────────────────────────────

/** Serialize a tree to a compact JSON array [[kind, value], ...]. Deterministic, no key-order ambiguity. */
export function serializeTree(tree: StrategyTree): [number, number][] {
  return tree.map((n) => [n.kind, n.value]);
}

/** Deserialize from the compact JSON form. Returns null if the input is malformed. */
export function deserializeTree(data: unknown): StrategyTree | null {
  if (!Array.isArray(data)) return null;
  const nodes: GpNode[] = [];
  for (const item of data) {
    if (!Array.isArray(item) || item.length !== 2) return null;
    const [kind, value] = item;
    if (typeof kind !== "number" || typeof value !== "number") return null;
    if (kind !== NodeKind.Const && kind !== NodeKind.Terminal && kind !== NodeKind.Operator) return null;
    if (!Number.isFinite(value) || value !== Math.trunc(value)) return null;
    nodes.push({ kind: kind as NodeKind, value });
  }
  return nodes;
}

// ────────────────────────────────────────────────────────────────────────────────────────────────────────
// Module version (bump if the operator set, terminal set, or hash scheme changes)
// ────────────────────────────────────────────────────────────────────────────────────────────────────────

export const STRATEGY_GENOME_VERSION = 1;
