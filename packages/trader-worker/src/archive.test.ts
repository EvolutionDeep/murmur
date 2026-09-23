// ⑰ archive.test.ts — determinism, bounding, restore-safety, and the three edge events.
import { test } from "node:test";
import assert from "node:assert/strict";
import { ArchiveMembrane, type ArchiveConfig } from "./archive.js";
import { LADDER } from "./invention.js";

const CFG: ArchiveConfig = { enabled: true, recordP: 0.5, decodeP: 0.5, burnCivMax: 15 };
const TOP = LADDER.length; // 12

function make(tick: number, keepers: Map<number, number>, civ: number, flies: number[]) {
  const m = new ArchiveMembrane(CFG);
  m.round(tick, keepers, TOP, civ, flies);
  return m;
}

test("⑰ recording fires when a keeper is lucky (high recordP)", () => {
  const keepers = new Map([[5, 3], [7, 8]]);
  // try enough ticks that at least one fires
  let fired = false;
  for (let t = 1; t <= 200; t++) {
    const m = new ArchiveMembrane(CFG);
    m.round(t, keepers, TOP, 80, [5, 7, 9]);
    if (m.signals().recording) { fired = true; break; }
  }
  assert.ok(fired, "recording should fire within 200 crons at p=0.5");
});

test("⑰ decode fires only when records exist and fly is NOT a keeper", () => {
  const m = new ArchiveMembrane(CFG);
  // first: get a recording by brute-force
  const keepers = new Map([[42, 2]]);
  for (let t = 1; t <= 200; t++) {
    m.round(t, keepers, TOP, 80, [42, 99]);
    if (m.signals().recording) break;
  }
  assert.ok(m.signals().records.length > 0, "should have at least one record");
  // now try decode with a non-keeper
  let decoded = false;
  for (let t = 201; t <= 500; t++) {
    m.round(t, keepers, TOP, 80, [42, 99]);
    if (m.signals().decode) { decoded = true; assert.equal(m.signals().decode!.id, 99); break; }
  }
  assert.ok(decoded, "decode should fire for non-keeper");
});

test("⑰ archive_burned fires when civLevel ≤ burnCivMax", () => {
  const m = new ArchiveMembrane({ ...CFG, recordP: 1.0 }); // force recording
  const keepers = new Map([[10, 5]]);
  m.round(1, keepers, TOP, 80, [10]); // record something
  assert.equal(m.signals().records.length, 1);
  // now set burn to always fire
  const m2 = new ArchiveMembrane({ ...CFG, recordP: 1.0, burnCivMax: 50 });
  m2.restore(m.serialize()); // carry the record over
  let burned = false;
  for (let t = 2; t <= 200; t++) {
    m2.round(t, keepers, TOP, 10, [10]); // civLevel 10 ≤ 50
    if (m2.signals().archiveBurned) { burned = true; break; }
  }
  assert.ok(burned, "archive_burned should fire at low civLevel");
});

test("⑰ null-object (enabled=false) never fires any event", () => {
  const m = new ArchiveMembrane({ enabled: false, recordP: 1, decodeP: 1, burnCivMax: 100 });
  const keepers = new Map([[1, 6]]);
  for (let t = 1; t <= 100; t++) m.round(t, keepers, TOP, 0, [1, 2, 3]);
  const sig = m.signals();
  assert.equal(sig.recording, null);
  assert.equal(sig.decode, null);
  assert.equal(sig.archiveBurned, null);
  assert.equal(sig.records.length, 0);
});

test("⑰ determinism: same inputs produce same outputs across two instances", () => {
  const keepers = new Map([[3, 7], [11, 4]]);
  const flies = [3, 11, 15, 22];
  const a = new ArchiveMembrane(CFG);
  const b = new ArchiveMembrane(CFG);
  for (let t = 1; t <= 50; t++) {
    a.round(t, keepers, TOP, 60, flies);
    b.round(t, keepers, TOP, 60, flies);
  }
  assert.equal(a.serialize(), b.serialize());
});

test("⑰ records are bounded at 2 per rung", () => {
  const m = new ArchiveMembrane({ ...CFG, recordP: 1.0 }); // always record
  const keepers = new Map([[1, 3], [2, 3], [3, 3], [4, 3], [5, 3]]);
  for (let t = 1; t <= 20; t++) m.round(t, keepers, TOP, 80, [1, 2, 3, 4, 5]);
  const rung3 = m.signals().records.filter(r => r.rung === 3);
  assert.ok(rung3.length <= 2, `rung 3 should have at most 2 records, got ${rung3.length}`);
});

test("⑰ serialize/restore round-trips", () => {
  const m = new ArchiveMembrane({ ...CFG, recordP: 1.0 });
  m.round(1, new Map([[7, 4]]), TOP, 80, [7, 8]);
  const blob = m.serialize();
  const m2 = new ArchiveMembrane(CFG);
  m2.restore(blob);
  assert.deepEqual(m2.signals().records, m.signals().records);
  assert.equal(m2.signals().recorded, m.signals().recorded);
});

test("⑰ corrupt blob is safely ignored", () => {
  const m = new ArchiveMembrane(CFG);
  m.restore("not json{{{");
  assert.equal(m.signals().records.length, 0);
  m.restore(JSON.stringify({ version: 999, records: [] }));
  assert.equal(m.signals().records.length, 0);
});

test("⑰ blob size stays under 4KB at cap", () => {
  const m = new ArchiveMembrane({ ...CFG, recordP: 1.0 });
  // fill all 12 rungs × 2 = 24 records
  for (let rung = 1; rung <= 12; rung++) {
    m.round(rung * 100, new Map([[rung, rung]]), TOP, 80, [rung]);
    m.round(rung * 100 + 1, new Map([[rung + 20, rung]]), TOP, 80, [rung + 20]);
  }
  const blob = m.serialize();
  assert.ok(blob.length < 4096, `blob is ${blob.length} bytes, should be < 4096`);
});
