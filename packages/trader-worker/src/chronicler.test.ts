// Chronicler tests — the deterministic historian is a PURE READ-OUT, so its contract is:
//   1. It emits history-making moments ONLY when the input crosses a stated threshold.
//   2. It is fully DETERMINISTIC: same sequence of ChronicleContext in → same sequence of entries out.
//   3. It has NO side effects beyond its own monotonic state — snapshot/restore round-trips cleanly, so
//      the DO can evict / reload without rewriting history or duplicating seq.
//   4. It respects per-kind COOLDOWN so a sustained condition writes a chronicle line, not a stutter.
//
// These tests pin the invariants above. They do NOT reach into population / economy / D1 — the historian
// is intentionally decoupled via the ChronicleContext shape, so it can be reasoned about in isolation.

import test from "node:test";
import assert from "node:assert/strict";

import { Chronicler, type ChronicleContext, type ChronicleEntry } from "./chronicler.js";

/** A calm, empty baseline: a small COLD swarm with no economy yet. */
function ctx(over: Partial<ChronicleContext> = {}): ChronicleContext {
  return {
    tick: 0, ts: 1_700_000_000_000, temperature: 0.3, regime: "COLD",
    size: 24, states: {}, faps: {}, valence: 0, arousal: 0.2, cohesion: 0.5, rest: 0.6,
    settlements: 0, volumeUsdc: 0, gini: 0, richestId: null, poorestId: null,
    liveAgents: 24, meanBalanceUsdc: 0,
    ...over,
  };
}

function kinds(entries: ChronicleEntry[]): string[] { return entries.map((e) => e.kind); }

test("first observation writes Era I · the Awakening", () => {
  const c = new Chronicler();
  const out = c.observe(ctx({ tick: 1 }));
  assert.equal(out.length, 1);
  assert.equal(out[0].kind, "ERA_OPEN");
  assert.equal(out[0].era, 1);
  assert.equal(out[0].eraName, "the Awakening");
  assert.equal(out[0].severity, 3);
  assert.match(out[0].text, /Era I/);
  assert.match(out[0].text, /Awakening/);
});

test("a held regime shift eventually dawns a new era (ERA_MIN_RUN + ERA_MIN_AGE)", () => {
  const c = new Chronicler();
  // Era 1 opens on COLD. Then a sustained HOT regime must hold ≥6 crons AND the era must be ≥8 ticks old
  // before it becomes Era II. Feed a plausible HOT sequence and check that ERA_SHIFT actually fires.
  c.observe(ctx({ tick: 1, regime: "COLD" }));
  const all: ChronicleEntry[] = [];
  for (let t = 2; t <= 15; t++) {
    all.push(...c.observe(ctx({ tick: t, regime: "HOT", temperature: 0.8 })));
  }
  const shift = all.find((e) => e.kind === "ERA_SHIFT");
  assert.ok(shift, "expected an ERA_SHIFT after a sustained HOT regime");
  assert.equal(shift!.era, 2);
  assert.match(shift!.text, /Era II/);
});

test("FIRST_TRADE fires exactly once, on the transition from zero to non-zero settlements", () => {
  const c = new Chronicler();
  c.observe(ctx({ tick: 1 }));
  const a = c.observe(ctx({ tick: 2, settlements: 1, volumeUsdc: 0.02 }));
  assert.ok(kinds(a).includes("FIRST_TRADE"));
  const b = c.observe(ctx({ tick: 3, settlements: 2, volumeUsdc: 0.04 }));
  assert.ok(!kinds(b).includes("FIRST_TRADE"), "FIRST_TRADE must not repeat");
});

test("MILESTONE fires when lifetime settlements cross a 1000x multiple", () => {
  const c = new Chronicler();
  c.observe(ctx({ tick: 1 }));
  const out = c.observe(ctx({ tick: 2, settlements: 1000, volumeUsdc: 12 }));
  assert.ok(kinds(out).includes("MILESTONE"));
  const again = c.observe(ctx({ tick: 3, settlements: 1500, volumeUsdc: 18 }));
  assert.ok(!kinds(again).includes("MILESTONE"), "no new milestone until we cross 2000");
  const next = c.observe(ctx({ tick: 4, settlements: 2000, volumeUsdc: 25 }));
  assert.ok(kinds(next).includes("MILESTONE"));
});

test("BIRTH records a new all-time swarm size, respecting the two-cron cooldown", () => {
  const c = new Chronicler();
  c.observe(ctx({ tick: 1, size: 24 }));
  const b1 = c.observe(ctx({ tick: 2, size: 25 }));
  assert.ok(kinds(b1).includes("BIRTH"));
  // immediate next cron → cooldown blocks even though size grows again
  const b2 = c.observe(ctx({ tick: 3, size: 26 }));
  assert.ok(!kinds(b2).includes("BIRTH"), "BIRTH must respect 2-cron cooldown");
  const b3 = c.observe(ctx({ tick: 4, size: 27 }));
  assert.ok(kinds(b3).includes("BIRTH"), "BIRTH resumes after cooldown");
});

test("PANIC only fires in HOT with a high flight+retreat share, and is rate-limited", () => {
  const c = new Chronicler();
  c.observe(ctx({ tick: 1 }));
  // CALM with a lot of flight: should NOT fire (regime gate).
  const calm = c.observe(ctx({ tick: 2, regime: "CALM", temperature: 0.55, size: 20, faps: { FLIGHT: 8, RETREAT: 2 } }));
  assert.ok(!kinds(calm).includes("PANIC"));
  // HOT with 12/20 = 0.6 flight+retreat ratio: SHOULD fire.
  const hot = c.observe(ctx({ tick: 3, regime: "HOT", temperature: 0.85, size: 20, faps: { FLIGHT: 8, RETREAT: 4 } }));
  assert.ok(kinds(hot).includes("PANIC"));
  // Next cron same shape: cooldown (3) blocks it.
  const next1 = c.observe(ctx({ tick: 4, regime: "HOT", temperature: 0.85, size: 20, faps: { FLIGHT: 8, RETREAT: 4 } }));
  assert.ok(!kinds(next1).includes("PANIC"));
  const next2 = c.observe(ctx({ tick: 5, regime: "HOT", temperature: 0.85, size: 20, faps: { FLIGHT: 8, RETREAT: 4 } }));
  assert.ok(!kinds(next2).includes("PANIC"));
  const next3 = c.observe(ctx({ tick: 6, regime: "HOT", temperature: 0.85, size: 20, faps: { FLIGHT: 8, RETREAT: 4 } }));
  assert.ok(kinds(next3).includes("PANIC"), "PANIC may re-fire after 3-cron gap");
});

test("HUDDLE fires on a sustained COLD with most flies still; STORM on an extreme temperature peak", () => {
  const c = new Chronicler();
  c.observe(ctx({ tick: 1 }));
  const h = c.observe(ctx({ tick: 2, regime: "COLD", temperature: 0.15, size: 20, faps: { HUDDLE: 8, REST: 5, HALT: 1 } }));
  assert.ok(kinds(h).includes("HUDDLE"));
  const s = c.observe(ctx({ tick: 3, regime: "COLD", temperature: 0.98, size: 20 }));
  assert.ok(kinds(s).includes("STORM"));
});

test("RECORD_CONC requires a new all-time gini high of at least +0.02", () => {
  const c = new Chronicler();
  c.observe(ctx({ tick: 1 }));
  const r1 = c.observe(ctx({ tick: 2, gini: 0.5, richestId: 3 }));
  assert.ok(kinds(r1).includes("RECORD_CONC"), "0.5 > 0 is a new high");
  const r2 = c.observe(ctx({ tick: 3, gini: 0.51, richestId: 3 }));
  assert.ok(!kinds(r2).includes("RECORD_CONC"), "delta < 0.02 does not count");
  // RECORD_CONC has a 3-cron cooldown, so we must wait until tick ≥ 5 (2 + 3) for it to re-fire.
  c.observe(ctx({ tick: 4, gini: 0.55, richestId: 3 }));
  const r3 = c.observe(ctx({ tick: 5, gini: 0.62, richestId: 3 }));
  assert.ok(kinds(r3).includes("RECORD_CONC"));
});

test("LEAD_CHANGE fires only when richestId actually flips, and names both flies", () => {
  const c = new Chronicler();
  c.observe(ctx({ tick: 1 }));
  const a = c.observe(ctx({ tick: 2, richestId: 7 }));
  // first time we've seen a non-null leader (was null): sets leaderId without firing.
  assert.ok(!kinds(a).includes("LEAD_CHANGE"), "null→7 is a seed, not a flip");
  const b = c.observe(ctx({ tick: 3, richestId: 9 }));
  assert.ok(kinds(b).includes("LEAD_CHANGE"));
  const entry = b.find((e) => e.kind === "LEAD_CHANGE")!;
  assert.deepEqual(entry.actors.sort((x, y) => x - y), [7, 9]);
  assert.match(entry.text, /#9/);
  assert.match(entry.text, /#7/);
});

test("the historian is deterministic: the same context sequence yields byte-identical entries", () => {
  const seq: ChronicleContext[] = [
    ctx({ tick: 1 }),
    ctx({ tick: 2, regime: "HOT", temperature: 0.82, settlements: 1, volumeUsdc: 0.02, size: 20, faps: { FLIGHT: 10, RETREAT: 2 } }),
    ctx({ tick: 3, regime: "HOT", temperature: 0.83, settlements: 3, volumeUsdc: 0.06 }),
    ctx({ tick: 4, regime: "HOT", temperature: 0.98, settlements: 4, volumeUsdc: 0.08 }),
  ];
  const a = new Chronicler();
  const b = new Chronicler();
  const outA: ChronicleEntry[] = [];
  const outB: ChronicleEntry[] = [];
  for (const x of seq) { outA.push(...a.observe(x)); }
  for (const x of seq) { outB.push(...b.observe(x)); }
  assert.deepEqual(outA, outB);
  // sanity: at least one event fired (era_open is guaranteed)
  assert.ok(outA.length >= 2, "expected multiple deterministic entries for the same input");
});

test("snapshot + restore preserves seq and every monotonic tracker (no history rewrite on eviction)", () => {
  const a = new Chronicler();
  a.observe(ctx({ tick: 1 }));
  a.observe(ctx({ tick: 2, settlements: 1, volumeUsdc: 0.01, richestId: 5, size: 30 }));
  a.observe(ctx({ tick: 3, settlements: 1000, volumeUsdc: 12, gini: 0.5, richestId: 8, size: 32 }));
  const snap = a.snapshot();
  const b = new Chronicler();
  b.restore(snap as any);
  // continuing on `b` must not re-emit FIRST_TRADE, must continue seq, must respect maxGini / maxSize
  const cont = b.observe(ctx({ tick: 4, settlements: 1001, volumeUsdc: 13, gini: 0.5, size: 32, richestId: 8 }));
  assert.ok(!kinds(cont).includes("FIRST_TRADE"), "restored state knows first-trade already happened");
  assert.ok(!kinds(cont).includes("MILESTONE"), "no new 1000x milestone crossed");
  assert.ok(!kinds(cont).includes("BIRTH"), "size 32 is not above max 32");
  // RECORD_CONC last fired at tick 3 in `a` (restored). Cooldown = 3, so we must wait until tick ≥ 6 to
  // re-fire. Tick 7 gives every cooldown room, and crosses the 2000 milestone + a size high.
  const bigJump = b.observe(ctx({ tick: 7, settlements: 2001, volumeUsdc: 25, size: 40, gini: 0.6 }));
  assert.ok(kinds(bigJump).includes("MILESTONE"));
  assert.ok(kinds(bigJump).includes("BIRTH"));
  assert.ok(kinds(bigJump).includes("RECORD_CONC"));
  assert.ok(bigJump.every((e) => e.seq > 3), "seq kept monotonic across restore");
});
