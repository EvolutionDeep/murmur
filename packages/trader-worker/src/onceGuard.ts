/**
 * SHARED ONCE-GUARD — the "already-processed" memory every membrane needs (packages/trader-worker/src/onceGuard.ts).
 *
 * Three membrane layers (rules / norms / conventions) independently shipped the SAME structural defect: a
 * hash-gated variant/mutate/inherit draw that is id-only (no tick, no strength) and has NO MEMORY of which
 * (entity, target) pairs have already been processed. Because the draw is deterministic and id-only, the same
 * pair re-fires every cron, flooding the CAP with duplicates until no genuine emergent entity can be born.
 *
 * OnceGuard is the ONE fix for all three (and any future membrane that needs bounded "process once"
 * semantics). Each layer instantiates its OWN private guard with its OWN capacity bound — no shared state,
 * no cross-layer coupling.
 *
 * NOT FOR THE LEXICON (task #107): the ㉓ lexicon deliberately does NOT use OnceGuard. Its oldest-first
 * eviction is exactly the wrong tool for a PERMANENT civilisation record — a full guard evicting the oldest
 * key would let a long-dead word be re-coined with a fabricated history. The lexicon's once-semantics is
 * structural instead: entries[kind] (a living row OR a never-deleted tombstone) persists forever, so its mere
 * existence bars re-coinage with no cap and no eviction. Use OnceGuard only where a bounded, evicting memory
 * is correct; use a persisted tombstone where the record must be permanent.
 *
 * DESIGN CONSTRAINTS (matching the membranes' five iron rules):
 *   • DETERMINISTIC: keys are opaque strings the caller composes (e.g. `${ruleId}:${flyId}`). The guard itself
 *     never uses Math.random, Date.now, or any transcendental — it is a pure insertion-ordered Set with a
 *     capacity bound and an oldest-first eviction policy.
 *   • NOT FOLDED INTO stateDigest: the guard is an INTERNAL bookkeeping structure; it never contributes to the
 *     membrane's hash-chain identity.
 *   • SERIALIZABLE: serialize() emits a bounded JSON array; restore() rehydrates it. A corrupt/oversized blob
 *     silently degrades to an empty guard (restart = re-allow, worst case a few extra variants before the guard
 *     refills — NEVER a storm, because the CAP still binds).
 *   • BOUNDED: the Set never exceeds `cap` entries. When full, the OLDEST entry (insertion-order) is evicted to
 *     make room. The cap should be generous enough that legitimate pairs are never evicted within a TTL window
 *     but tight enough that the serialized blob stays small (the membranes share a 200 KB DO budget).
 *   • DARK-DEPLOYMENT SAFE: when a membrane's ENABLED flag is OFF, the guard is never written to (round() returns
 *     early) and serialize() on the membrane omits the guard key entirely ⇒ byte-for-byte equivalence with the
 *     pre-guard build.
 */

/**
 * A bounded insertion-ordered Set of opaque string keys with oldest-first eviction.
 *
 * Usage (inside a membrane):
 * ```ts
 * private variedPairs = new OnceGuard(VARY_GUARD_CAP);
 * // in the draw branch:
 * const key = `${rule.id}:${flyId}`;
 * if (!this.variedPairs.claim(key)) { /* already processed — skip *\/ }
 * // in serialize():
 * variedPairs: this.variedPairs.serialize()
 * // in restore():
 * this.variedPairs.restore(blob.variedPairs)
 * ```
 */
export class OnceGuard {
  private keys: Set<string>;
  private readonly cap: number;

  constructor(cap: number) {
    this.cap = Math.max(1, Math.floor(Number.isFinite(cap) ? cap : 256));
    this.keys = new Set<string>();
  }

  /** Current entry count (observability). */
  get size(): number { return this.keys.size; }

  /** The configured capacity. */
  get capacity(): number { return this.cap; }

  /**
   * Attempt to claim a key. Returns TRUE if the key was NOT present (and is now recorded).
   * Returns FALSE if the key was ALREADY present (the caller should skip the action).
   * When at capacity, the oldest entry is evicted to make room.
   */
  claim(key: string): boolean {
    if (this.keys.has(key)) return false;
    // Evict oldest when at capacity (insertion-order iteration gives us the oldest first).
    if (this.keys.size >= this.cap) {
      const oldest = this.keys.values().next();
      if (!oldest.done) this.keys.delete(oldest.value);
    }
    this.keys.add(key);
    return true;
  }

  /** Check whether a key is already recorded WITHOUT claiming it (read-only probe). */
  has(key: string): boolean { return this.keys.has(key); }

  /** Clear all entries (used when the membrane resets). */
  clear(): void { this.keys.clear(); }

  /**
   * Serialize to a bounded JSON-friendly array of strings.
   * Returns undefined (key omitted) when empty — so the serialized blob is byte-for-byte identical to the
   * pre-guard build when the guard has never been written to (dark-deployment equivalence).
   */
  serialize(): string[] | undefined {
    if (this.keys.size === 0) return undefined;
    return Array.from(this.keys);
  }

  /**
   * Restore from a previously serialized array. Tolerates null, undefined, non-arrays, and non-string entries.
   * Silently truncates to capacity (never overflows).
   */
  restore(data: unknown): void {
    this.keys.clear();
    if (!Array.isArray(data)) return;
    for (const item of data) {
      if (typeof item !== "string" || !item) continue;
      if (this.keys.size >= this.cap) break;
      this.keys.add(item);
    }
  }
}

/**
 * The HARD stimulus intensity ceiling (0.3). Config.ts clamps maxIntensity to this, but the membrane modules
 * themselves had NO internal defence — if a caller passed a rogue maxIntensity > 0.3, the stimulus would exceed
 * the one-way law's bound. This constant lets each membrane's stimuli() apply its OWN hard cap independently
 * (defence in depth, mirroring the rules membrane's four independent clamp stages).
 *
 * Exported from onceGuard.ts (the shared membrane utility) so all three causal-leg membranes reference ONE
 * definition — if the ceiling ever moves, it moves in exactly one place.
 */
export const STIMULUS_HARD_CAP = 0.3;
