// ㉒ guilds.test.ts — silent boot adoption, charter crossings, pact edges, monopoly rising edges, bounding, restore, inert off.
import { test } from "node:test";
import assert from "node:assert/strict";
import { GuildsMembrane, GUILD_ROLES, type GuildsConfig, type GuildFacts } from "./guilds.js";

const CFG: GuildsConfig = { enabled: true, quorum: 4, shareP: 0.5 };

/** Build a workforce from a {prof: count} shape — ids are assigned deterministically, per role block. */
function wf(spec: Record<string, number>, startId = 1): GuildFacts["workforce"] {
  const out: GuildFacts["workforce"] = [];
  let id = startId;
  for (const role of GUILD_ROLES) {
    for (let k = 0; k < (spec[role] ?? 0); k++) out.push({ id: id++, prof: role });
  }
  return out;
}
const facts = (era: number, workforce: GuildFacts["workforce"]): GuildFacts => ({ era, workforce });
const zero = { charters: 0, pacts: 0, monopolies: 0 };

test("㉒ boot adopts silently: full guilds seal without a chronicle line", () => {
  const m = new GuildsMembrane(CFG);
  m.round(1, facts(3, wf({ forager: 2, mooder: 8 })));
  const sig = m.signals();
  assert.equal(sig.charter, null, "the boot round speaks no charter");
  assert.equal(sig.pact, null, "nor a pact");
  assert.equal(sig.monopoly, null, "nor a monopoly");
  assert.deepEqual(sig.counts, zero);
  const mooder = sig.roster.find((r) => r.role === "mooder")!;
  assert.equal(mooder.members, 8);
  assert.equal(mooder.share, 0.8);
  const blob = JSON.parse(m.serialize());
  assert.deepEqual(blob.chartered, ["mooder"], "the silent seal still lands on the roll");
});

test("㉒ a trade crossing quorum wins its charter with era and count", () => {
  const m = new GuildsMembrane(CFG);
  m.round(1, facts(3, wf({ forager: 3 })));               // boot below quorum: nothing to seal
  m.round(2, facts(4, wf({ forager: 4 })));               // the fourth hand crosses → charter (+1 pact: #4 new)
  const sig = m.signals();
  assert.ok(sig.charter);
  assert.equal(sig.charter!.role, "forager");
  assert.equal(sig.charter!.members, 4);
  assert.equal(sig.charter!.quorum, 4);
  assert.equal(sig.charter!.era, 4, "the charter names the era that seals it");
  assert.equal(sig.counts.charters, 1);
});

test("㉒ at most one charter per cron — the queue paces itself", () => {
  const m = new GuildsMembrane(CFG);
  m.round(1, facts(1, wf({ forager: 3, mooder: 3 })));
  m.round(2, facts(1, wf({ forager: 4, mooder: 4 })));     // both cross at once
  assert.equal(m.signals().charter!.role, "forager", "fixed role order breaks the tie");
  m.round(3, facts(1, wf({ forager: 4, mooder: 4 })));
  assert.equal(m.signals().charter!.role, "mooder", "the waiting seal lands next cron");
  m.round(4, facts(1, wf({ forager: 4, mooder: 4 })));
  assert.equal(m.signals().charter, null, "sealed guilds never re-charter");
});

test("㉒ a fly taking up a CHARTERED trade strikes a pact; unchartered trades stay mute", () => {
  const m = new GuildsMembrane(CFG);
  m.round(1, facts(1, wf({ forager: 4 })));                // boot: forager sealed silently
  m.round(2, facts(1, [{ id: 9, prof: "forager" }, ...wf({ forager: 4 }, 1)]));
  const p1 = m.signals().pact;
  assert.ok(p1, "fly #9 takes up a chartered trade");
  assert.equal(p1!.id, 9);
  assert.equal(p1!.role, "forager");
  assert.equal(p1!.members, 5, "the roll counts the new hand");
  m.round(3, facts(1, [{ id: 9, prof: "trader" }, ...wf({ forager: 4 }, 1)]));
  assert.equal(m.signals().pact, null, "trader is not chartered — no banner to swear under");
});

test("㉒ many newcomers, one signatory — the lowest hash strikes the pact, deterministically", () => {
  const run = () => {
    const m = new GuildsMembrane(CFG);
    m.round(1, facts(1, wf({ forager: 4, mooder: 3 })));
    m.round(7, facts(1, wf({ forager: 4, mooder: 4 })));   // mooder chartered + four fresh hands at once
    return { sig: m.signals(), blob: m.serialize() };
  };
  const a = run();
  const b = run();
  assert.ok(a.sig.pact, "the mooder newcomers strike one pact");
  assert.equal(a.sig.pact!.role, "mooder");
  assert.equal(JSON.stringify(a.sig), JSON.stringify(b.sig), "twin membranes say the same words");
  assert.equal(a.blob, b.blob, "and keep the same book");
});

test("㉒ monopoly fires on the RISE past the mark only — plateaus and falls stay mute", () => {
  const m = new GuildsMembrane(CFG);
  m.round(1, facts(1, wf({ forager: 2, mooder: 1 })));      // boot: nobody chartered, shares 2/3 and 1/3
  m.round(2, facts(1, wf({ forager: 1, mooder: 4 })));      // mooder crosses quorum AND the share mark
  const sig = m.signals();
  assert.equal(sig.charter!.role, "mooder");
  assert.ok(sig.monopoly, "the rising share claims the field");
  assert.equal(sig.monopoly!.role, "mooder");
  assert.equal(sig.monopoly!.share, 80);
  assert.equal(sig.counts.monopolies, 1);
  m.round(3, facts(1, wf({ forager: 1, mooder: 4 })));
  assert.equal(m.signals().monopoly, null, "a plateau is not a rising edge");
});

test("㉒ a boot-time plateau is pinned — the guild holds the field without a proclamation", () => {
  const m = new GuildsMembrane(CFG);
  m.round(1, facts(1, wf({ mooder: 8 })));                  // 100% at boot: sealed AND pinned, silent
  m.round(2, facts(1, wf({ forager: 2, mooder: 8 })));
  assert.equal(m.signals().monopoly, null, "no word for a height the membrane woke up on");
  m.round(3, facts(1, wf({ forager: 7, mooder: 3 })));      // the share falls under the mark
  m.round(4, facts(1, wf({ forager: 2, mooder: 8 })));      // and RISES past it — now it may speak
  assert.ok(m.signals().monopoly);
  assert.equal(m.signals().monopoly!.role, "mooder");
});

test("㉒ a hatchling born into a chartered trade signs at once", () => {
  const m = new GuildsMembrane(CFG);
  m.round(1, facts(1, wf({ forager: 4 })));
  m.round(2, facts(1, wf({ forager: 5 })));                 // #5 appears, already foraging
  assert.ok(m.signals().pact);
  assert.equal(m.signals().pact!.id, 5);
});

test("㉒ null-object (enabled=false) never speaks", () => {
  const m = new GuildsMembrane({ enabled: false, quorum: 1, shareP: 0 });
  m.round(1, facts(1, wf({ forager: 4 })));
  m.round(2, facts(1, wf({ forager: 8 })));
  const sig = m.signals();
  assert.equal(sig.charter, null);
  assert.equal(sig.pact, null);
  assert.equal(sig.monopoly, null);
  assert.deepEqual(sig.counts, zero);
});

test("㉒ restore carries the seals and counts, then re-adopts one silent round", () => {
  const m = new GuildsMembrane(CFG);
  m.round(1, facts(1, wf({ forager: 4 })));
  m.round(2, facts(1, wf({ forager: 5 })));                 // one pact
  const blob = m.serialize();
  const m2 = new GuildsMembrane(CFG);
  m2.restore(blob);
  assert.deepEqual(JSON.parse(m2.serialize()), JSON.parse(blob), "the book round-trips whole");
  // whole workforce flips trades — after a restart this must NOT burst into pacts
  m2.round(3, facts(1, wf({ mooder: 5 })));
  assert.deepEqual(m2.signals().counts, { charters: 0, pacts: 1, monopolies: 0 }, "silent adoption round adds nothing");
  assert.equal(m2.signals().pact, null);
  assert.equal(m2.signals().charter, null, "mooder's silent seal speaks no line");
});

test("㉒ corrupt blobs and junk arrays restart an empty guildhall, never a poisoned one", () => {
  const m = new GuildsMembrane(CFG);
  m.restore("{oops");
  m.restore('{"chartered":["forger","mooder",42,null,"mooder"],"counts":"nope"}');
  m.round(1, facts(1, wf({ forager: 1 })));                 // junk "forger" dropped, mooder deduped
  const sig = m.signals();
  assert.deepEqual(sig.counts, zero);
  const blob = JSON.parse(m.serialize());
  assert.deepEqual(blob.chartered, ["mooder"], "only real seals on a real roll");
});

test("㉒ bounded: 500 hands, four rows, a sub-kilobyte book", () => {
  const m = new GuildsMembrane(CFG);
  m.round(1, facts(1, wf({ forager: 500 })));
  for (let t = 2; t < 10; t++) m.round(t, facts(t, wf({ forager: 500 })));
  const sig = m.signals();
  assert.equal(sig.roster.length, 4, "exactly the four trades, always");
  assert.equal(m.serialize().length < 1024, true, "the guildhall book stays small");
});
