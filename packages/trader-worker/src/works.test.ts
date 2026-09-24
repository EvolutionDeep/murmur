/**
 * ㉖ THE PUBLIC WORKS — unit tests (node:test, mirrors treaty.test.ts's fixture style).
 *
 * Covers: the granary's run-raising and crossing-repair (once per crossing, never per cron), the
 * golden-age monument and its civLevel-crossing repainting, the generation-rhythm aqueduct (one
 * cutting per generation), dilapidation priority and its fallow ground, the FIFO archive cap,
 * inertness, and the serialize/restore round trip.
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  WorksMembrane,
  WK_AGE, WK_MEMORY, WK_RAISE_COOL, WK_BAD_REPAIR, WK_AQUEDUCT_SIZE, WK_AQUEDUCT_EVERY,
  WK_MONUMENT_REPAIR_CIV, WK_MONUMENT_REPAIR_AGE,
  type WorksFacts,
} from "./works.js";

const CFG = { enabled: true };

/** A world that raises nothing: no run, clean paper, declining phase, small swarm, gen 1. */
function quiet(over: Partial<WorksFacts> = {}): WorksFacts {
  return {
    era: 4, generation: 1, civLevel: 40, civPhase: "declining", size: 60,
    credit: { run: false, badRate: 0.05 }, ...over,
  };
}

test("works: a credit run raises the granary — before the hunger", () => {
  const w = new WorksMembrane(CFG);
  w.round(1, quiet({ credit: { run: true, badRate: 0.1 } }));
  const sig = w.signals();
  assert.ok(sig.raised, "the raising is news this cron");
  assert.equal(sig.raised!.kind, "granary");
  assert.equal(sig.raised!.era, 4);
  assert.equal(sig.active.length, 1, "the yard holds the granary");
  assert.equal(sig.counts.raised, 1);
});

test("works: no live granary and no fresh raising while the kind is un-cooled", () => {
  const w = new WorksMembrane(CFG);
  w.round(1, quiet({ credit: { run: true, badRate: 0.1 } }));
  w.round(2, quiet({ credit: { run: true, badRate: 0.1 } }));
  const sig = w.signals();
  assert.equal(sig.raised, null, "the run that follows the raising raises nothing");
  assert.equal(sig.counts.raised, 1, "still exactly one granary ever raised");
});

test("works: bad paper CROSSING the line repairs the granary — once, not every cron", () => {
  const w = new WorksMembrane(CFG);
  w.round(1, quiet({ credit: { run: true, badRate: 0.1 } }));         // raises at 1
  w.round(2, quiet({ credit: { run: false, badRate: WK_BAD_REPAIR } })); // 0.1 → 0.4 crosses
  assert.equal(w.signals().repaired?.kind, "granary", "the crossing speaks a repair");
  assert.equal(w.signals().counts.repaired, 1);
  w.round(3, quiet({ credit: { run: false, badRate: 0.5 } }));        // 0.4 → 0.5 sits above: no edge
  assert.equal(w.signals().repaired, null, "deepening paper above the line repairs nothing new");
  assert.equal(w.signals().counts.repaired, 1);
});

test("works: a golden age raises the monument; a dip and a crossing repaint an aging one", () => {
  const w = new WorksMembrane(CFG);
  w.round(1, quiet({ civPhase: "golden" }));
  assert.equal(w.signals().raised?.kind, "monument");
  w.round(21, quiet({ civLevel: 70 }));                    // age 20 but no crossing (90 → 70)
  assert.equal(w.signals().repaired, null, "declining glory does not repair");
  w.round(22, quiet({ civLevel: WK_MONUMENT_REPAIR_CIV })); // 70 → 80 crosses the glory line
  assert.equal(w.signals().repaired?.kind, "monument");
  assert.equal(w.signals().counts.repaired, 1);
});

test("works: a fresh monument is not re-gloryed, and no aqueduct is cut for a small swarm", () => {
  const w = new WorksMembrane(CFG);
  w.round(1, quiet({ civPhase: "golden", civLevel: 90 }));            // monument raised, first civ read = 90
  w.round(WK_MONUMENT_REPAIR_AGE, quiet({ civPhase: "golden", civLevel: 95 })); // no crossing, age = line
  assert.equal(w.signals().repaired, null, "sustained glory repaints nothing");
  assert.equal(w.signals().raised, null);
  w.round(30, quiet({ generation: WK_AQUEDUCT_EVERY, size: WK_AQUEDUCT_SIZE - 1 }));
  assert.equal(w.signals().raised, null, "a swarm below thirst-line numbers cuts no water");
});

test("works: the aqueduct follows the generation clock — one cutting per generation", () => {
  const w = new WorksMembrane(CFG);
  const big = { generation: WK_AQUEDUCT_EVERY, size: WK_AQUEDUCT_SIZE + 10 };
  w.round(1, quiet(big));
  assert.equal(w.signals().raised?.kind, "aqueduct");
  // fall it fast: knock the water down, then the same generation must not re-cut
  w.round(1 + WK_AGE, quiet(big));
  assert.equal(w.signals().dilapidated?.kind, "aqueduct", "age outranks the rhythm");
  w.round(1 + WK_AGE + WK_RAISE_COOL, quiet(big));
  assert.equal(w.signals().raised, null, "the same generation never cuts water twice");
  w.round(1 + WK_AGE + WK_RAISE_COOL + 1, quiet({ ...big, generation: WK_AQUEDUCT_EVERY * 2 }));
  assert.equal(w.signals().raised?.kind, "aqueduct", "the next fifth generation raises it again");
});

test("works: age dilapidates the oldest standing work and the ground lies fallow", () => {
  const w = new WorksMembrane(CFG);
  w.round(1, quiet({ credit: { run: true, badRate: 0.1 } }));   // granary at 1
  w.round(2, quiet());
  assert.equal(w.signals().dilapidated, null, "one day short of ruin it still stands");
  w.round(1 + WK_AGE, quiet());
  const sig = w.signals();
  assert.equal(sig.dilapidated?.kind, "granary");
  assert.equal(sig.dilapidated?.lived, WK_AGE, "the roll records the years it stood");
  assert.equal(sig.active.length, 0, "the yard is empty");
  assert.equal(sig.archive.length, 1);
  assert.equal(sig.archive[0].end, "ruin");
  // the fallow ground: a run inside the raising cooldown raises nothing
  w.round(1 + WK_AGE + WK_RAISE_COOL - 1, quiet({ credit: { run: true, badRate: 0.1 } }));
  assert.equal(w.signals().raised, null, "mud before the ground rests");
  w.round(1 + WK_AGE + WK_RAISE_COOL, quiet({ credit: { run: true, badRate: 0.1 } }));
  assert.equal(w.signals().raised?.kind, "granary", "the cooled ground raises again");
});

test("works: ruin outranks repair in the same cron", () => {
  const w = new WorksMembrane(CFG);
  w.round(1, quiet({ credit: { run: true, badRate: 0.1 } }));              // granary at 1
  w.round(1 + WK_AGE, quiet({ credit: { run: false, badRate: 0.5 } }));    // due AND crossing
  const sig = w.signals();
  assert.equal(sig.dilapidated?.kind, "granary", "the collapse is the news of this cron");
  assert.equal(sig.repaired, null, "a falling wall is not also a repaired one");
  assert.equal(sig.counts.repaired, 0);
});

test("works: the archive is bounded FIFO and the counts are lifetime", () => {
  const w = new WorksMembrane(CFG);
  let t = 0;
  for (let i = 0; i < WK_MEMORY + 3; i++) {
    t += WK_AGE + WK_RAISE_COOL + 1;
    w.round(t, quiet({ credit: { run: true, badRate: 0.1 } }));   // raise (cooled ground)
    t += WK_AGE;
    w.round(t, quiet());                                           // dilapidate
  }
  const sig = w.signals();
  assert.equal(sig.archive.length, WK_MEMORY, "the roll keeps only the last ruin's worth");
  assert.equal(sig.counts.raised, WK_MEMORY + 3);
  assert.equal(sig.counts.dilapidated, WK_MEMORY + 3);
});

test("works: serialize/restore round-trips the yard; a restored first read may repair", () => {
  const w = new WorksMembrane(CFG);
  w.round(1, quiet({ credit: { run: true, badRate: 0.1 } }));             // granary raised at 1
  w.round(2, quiet({ credit: { run: false, badRate: WK_BAD_REPAIR } }));  // crossing repairs at 2
  const blob = w.serialize();
  const w2 = new WorksMembrane(CFG);
  w2.restore(blob);
  const snap = w2.signals();
  assert.deepEqual(snap.counts, { raised: 1, repaired: 1, dilapidated: 0 }, "lifetime counts survive");
  assert.equal(snap.active.length, 1);
  assert.equal(snap.active[0].kind, "granary");
  assert.equal(snap.active[0].lastRepairTick, 2, "the repair rode the blob");
  // the restored yard reads the series fresh: the edge IS the state, so deep paper repairs again
  w2.round(30, quiet({ generation: WK_AQUEDUCT_EVERY, size: WK_AQUEDUCT_SIZE + 10, credit: { run: false, badRate: 0.5 } }));
  const sig = w2.signals();
  assert.equal(sig.repaired?.kind, "granary", "a first deep reading on a standing work is the repair");
  assert.equal(sig.raised?.kind, "aqueduct", "the granary repair does not choke the generation's water");
});

test("works: a corrupt blob restarts an empty yard, never a poisoned ledger", () => {
  const w = new WorksMembrane(CFG);
  w.round(1, quiet({ credit: { run: true, badRate: 0.1 } }));
  const before = w.signals().counts.raised;
  w.restore("{not json");
  w.restore(42 as unknown as string);
  w.restore(null);
  assert.equal(w.signals().counts.raised, before, "garbage leaves the last good roll in place");
});

test("works: disabled ⇒ the round is inert", () => {
  const w = new WorksMembrane({ enabled: false });
  w.round(1, quiet({ credit: { run: true, badRate: 0.9 } }));
  const sig = w.signals();
  assert.equal(sig.raised, null);
  assert.equal(sig.active.length, 0);
  assert.deepEqual(sig.counts, { raised: 0, repaired: 0, dilapidated: 0 });
});
