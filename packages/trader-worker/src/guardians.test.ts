/**
 * ㉗ THE GUARDIANS — unit tests (node:test, mirrors works.test.ts's fixture style).
 *
 * Covers: the taking of the youngest living heir (house guardian vs "the commons"), the silence rules
 * (no estate / no living heir / no double-taking), one taking per cron and the ward cap, the fledge
 * clock, the quiet LOST closure by grave and by roster, the full-circle honor and its silence when the
 * circle breaks, inertness, and the serialize/restore round trip (the seen ring survives eviction).
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  GuardiansMembrane,
  GD_FLEDGE, GD_MAX_WARDS,
  type GuardianFacts, type GraveFact,
} from "./guardians.js";

const CFG = { enabled: true };

/** A buried house father: estate 12 USDC, heirs hatched in order 30 then 31 (31 is the youngest). */
function grave(over: Partial<GraveFact> = {}): GraveFact {
  return { id: 7, tick: 1, bornTick: 0, cause: "aged", estateUsdc: 12, heirIds: [30, 31], houseName: "Ash", ...over };
}
function facts(over: Partial<GuardianFacts> = {}): GuardianFacts {
  return { era: 4, graves: [], livingIds: [1, 2, 30, 31, 32, 33], ...over };
}

test("guardians: a new grave with estate and living heirs takes the YOUNGEST as ward", () => {
  const g = new GuardiansMembrane(CFG);
  g.round(1, facts({ graves: [grave()] }));
  const s = g.signals();
  assert.ok(s.taken, "the wardship is news this cron");
  assert.equal(s.taken!.ward, 31, "the last living heir in hatch order is the youngest");
  assert.equal(s.taken!.guardian, "Ash");
  assert.equal(s.taken!.estateUsdc, 12);
  assert.equal(s.active.length, 1);
  assert.equal(s.counts.taken, 1);
});

test("guardians: a commoner's orphan reads guardian 'the commons'", () => {
  const g = new GuardiansMembrane(CFG);
  g.round(1, facts({ graves: [grave({ houseName: null })] }));
  assert.equal(g.signals().taken!.guardian, "the commons");
});

test("guardians: silence rules — no estate, no living heir, no re-reading of the same grave", () => {
  const g = new GuardiansMembrane(CFG);
  g.round(1, facts({ graves: [grave({ estateUsdc: 0, bornTick: 0 })] }));
  assert.equal(g.signals().taken, null, "a pauper's dole leaves no ward");
  g.round(2, facts({ graves: [grave({ heirIds: [99], bornTick: 1, tick: 2 })], livingIds: [1, 2] }));
  assert.equal(g.signals().taken, null, "heirs all buried before the taking leave no ward");
  g.round(3, facts({ graves: [grave({ bornTick: 2, tick: 3 })] }));
  assert.ok(g.signals().taken, "the estate with living heirs finally speaks");
  g.round(4, facts({ graves: [grave({ bornTick: 2, tick: 3 })] }));
  assert.equal(g.signals().taken, null, "the same (id, bornTick) is walked exactly once");
  assert.equal(g.signals().counts.taken, 1, "the ring replay took no second ward");
});

test("guardians: id reuse is a NEW burial — (id, bornTick) is the key", () => {
  const g = new GuardiansMembrane(CFG);
  g.round(1, facts({ graves: [grave()] }));
  g.round(2, facts({ graves: [grave({ bornTick: 500, heirIds: [32, 33] })] }));
  const s = g.signals();
  assert.ok(s.taken, "a second life behind the same id is a second grave");
  assert.equal(s.taken!.ward, 33);
  assert.equal(s.counts.taken, 2);
});

test("guardians: one taking per cron — the oldest qualifying grave speaks first", () => {
  const g = new GuardiansMembrane(CFG);
  g.round(5, facts({ graves: [
    grave({ id: 7, tick: 4, heirIds: [30] }),
    grave({ id: 8, tick: 5, heirIds: [31] }),
  ] }));
  const s = g.signals();
  assert.ok(s.taken);
  assert.equal(s.taken!.ward, 30, "the elder burial opens the roll");
  assert.equal(s.counts.taken, 1, "the second waits for the next cron's news");
});

test("guardians: the roll caps live wardships at GD_MAX_WARDS", () => {
  const g = new GuardiansMembrane(CFG);
  const ids: number[] = [1, 2];
  for (let i = 0; i < GD_MAX_WARDS + 3; i++) {
    const ward = 30 + i;
    ids.push(ward);
    g.round(10 + i, facts({
      livingIds: ids,
      graves: [grave({ id: 7 + i, tick: 10 + i, bornTick: i, heirIds: [ward] })],
    }));
  }
  assert.equal(g.signals().active.length, GD_MAX_WARDS, "wardship past the cap is the commons' plain charge");
});

test("guardians: a ward still flying at the fledge line stands on its own", () => {
  const g = new GuardiansMembrane(CFG);
  g.round(1, facts({ graves: [grave()] }));            // takenTick = 1
  g.round(GD_FLEDGE, facts());
  assert.equal(g.signals().fledged, null, "one cron short of minority fledges nothing"); // 95 < 96
  g.round(GD_FLEDGE + 1, facts());
  const s = g.signals();
  assert.ok(s.fledged, "the fledge is news");
  assert.equal(s.fledged!.ward, 31);
  assert.equal(s.fledged!.crons, GD_FLEDGE, "carried from the taking cron to this one");
  assert.equal(s.active.length, 0, "a fledged ward leaves the live roll");
  assert.equal(s.counts.fledged, 1);
});

test("guardians: a ward that falls before fledging is closed LOST — no kind speaks", () => {
  const g = new GuardiansMembrane(CFG);
  g.round(1, facts({ graves: [grave()] }));
  // The ward itself is buried two crons later; its grave rides the ring.
  g.round(3, facts({ graves: [grave({ id: 7, tick: 1, bornTick: 0 }), grave({ id: 31, tick: 3, bornTick: 2, estateUsdc: 0, heirIds: [] })], livingIds: [1, 2, 30, 32, 33] }));
  const s = g.signals();
  assert.equal(s.taken, null);
  assert.equal(s.active.length, 0, "the roll closed the entry");
  assert.equal(s.counts.lost, 1);
  assert.equal(s.archive[s.archive.length - 1].end, "lost");
});

test("guardians: a ward that vanishes from the roster (grave never seen) is lost at the sweep", () => {
  const g = new GuardiansMembrane(CFG);
  g.round(1, facts({ graves: [grave()] }));
  g.round(GD_FLEDGE + 1, facts({ livingIds: [1, 2, 30] })); // 31 gone, no grave for it
  const s = g.signals();
  assert.equal(s.fledged, null, "the missing ward fledges nothing");
  assert.equal(s.counts.lost, 1);
  assert.equal(s.active.length, 0);
});

test("guardians: the full circle — a fledged ward falls old with its own heirs paid, and the guardian is honored", () => {
  const g = new GuardiansMembrane(CFG);
  g.round(1, facts({ graves: [grave()] }));           // ward 31 taken from Ash #7 (takenTick 1)
  g.round(GD_FLEDGE + 1, facts());                     // fledges into the roll
  // much later, ward 31 itself lies down of age, estate to its own living heir 40
  g.round(GD_FLEDGE + 51, facts({ graves: [grave({ id: 31, tick: GD_FLEDGE + 51, bornTick: 1, estateUsdc: 8, heirIds: [40] })], livingIds: [1, 2, 40] }));
  const s = g.signals();
  assert.ok(s.honored, "the rarest news speaks");
  assert.equal(s.honored!.ward, 31);
  assert.equal(s.honored!.guardian, "Ash");
  assert.equal(s.honored!.lived, GD_FLEDGE + 50, "the span of the whole circle");
  assert.equal(s.counts.honored, 1);
  assert.equal(s.archive[s.archive.length - 1].end, "honored");
});

test("guardians: a fledged ward that falls young leaves no honor — and no second chance either", () => {
  const g = new GuardiansMembrane(CFG);
  g.round(1, facts({ graves: [grave()] }));
  g.round(GD_FLEDGE + 1, facts());
  // plague death, own heirs alive: the circle broke, the roll only lets go
  g.round(GD_FLEDGE + 11, facts({ graves: [grave({ id: 31, tick: GD_FLEDGE + 11, bornTick: 1, cause: "plague", heirIds: [40] })], livingIds: [1, 2, 40] }));
  assert.equal(g.signals().honored, null, "an untimely end honors nobody");
  assert.equal(g.signals().counts.honored, 0);
  // even if the SAME id somehow lies in state again, the roll has released it
  g.round(GD_FLEDGE + 21, facts({ graves: [grave({ id: 31, tick: GD_FLEDGE + 21, bornTick: 2, estateUsdc: 4, heirIds: [40] })], livingIds: [1, 2, 40] }));
  assert.equal(g.signals().honored, null, "released from the fledged roll — no retroactive honor");
});

test("guardians: serialize/restore round-trips the roll, the counts and the seen ring", () => {
  const a = new GuardiansMembrane(CFG);
  a.round(1, facts({ graves: [grave()] }));
  a.round(2, facts({ graves: [grave({ id: 8, tick: 2, bornTick: 1, heirIds: [32] })] }));
  const b = new GuardiansMembrane(CFG);
  b.restore(a.serialize());
  let sa = a.signals();
  let sb = b.signals();
  assert.deepEqual(sb.active, sa.active);
  assert.deepEqual(sb.counts, sa.counts);
  // replaying the SAME graves onto the restored roll must take no new ward (seen ring survived)
  b.round(3, facts({ graves: [grave(), grave({ id: 8, tick: 2, bornTick: 1, heirIds: [32] })] }));
  sb = b.signals();
  assert.equal(sb.counts.taken, 2, "no double-taking after an eviction");
  assert.equal(sb.taken, null);
});

test("guardians: a corrupt blob restarts an empty roll, never a poisoned ledger", () => {
  const g = new GuardiansMembrane(CFG);
  g.restore("{not json");
  g.restore(null);
  g.restore(JSON.stringify({ wards: "garbage", counts: 7 }));
  const s = g.signals();
  assert.equal(s.active.length, 0);
  assert.deepEqual(s.counts, { taken: 0, fledged: 0, honored: 0, lost: 0 });
});

test("guardians: GUARDIANS_ENABLED=false ⇒ the round is inert", () => {
  const g = new GuardiansMembrane({ enabled: false });
  g.round(1, facts({ graves: [grave()] }));
  const s = g.signals();
  assert.equal(s.taken, null);
  assert.equal(s.counts.taken, 0);
});
