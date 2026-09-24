// ⑱ workshop.test.ts — determinism, bounding, restore-safety, reinvention mechanics, and null-object inert.
import { test } from "node:test";
import assert from "node:assert/strict";
import { WorkshopMembrane, type WorkshopConfig } from "./workshop.js";
import { LADDER } from "./invention.js";

const CFG: WorkshopConfig = { enabled: true, reinventP: 0.5 };
const LOST = [{ rung: 5, name: LADDER[4].name }, { rung: 9, name: LADDER[8].name }];

test("⑱ reinvention fires when an explorer is lucky (high reinventP)", () => {
  let fired = false;
  for (let t = 1; t <= 200; t++) {
    const m = new WorkshopMembrane(CFG);
    m.round(t, LOST, [10, 20, 30]);
    if (m.signals().reinvention) { fired = true; break; }
  }
  assert.ok(fired, "reinvention should fire within 200 crons at p=0.5");
});

test("⑱ reinvention targets the HIGHEST lost rung", () => {
  const m = new WorkshopMembrane({ enabled: true, reinventP: 1.0 }); // always fires
  m.round(42, LOST, [7]);
  const sig = m.signals();
  assert.ok(sig.reinvention);
  assert.equal(sig.reinvention!.rung, 9, "should pick the highest lost rung");
  assert.equal(sig.reinvention!.name, LADDER[8].name);
  assert.equal(sig.reinvention!.id, 7);
});

test("⑱ at most one reinvention per cron", () => {
  const m = new WorkshopMembrane({ enabled: true, reinventP: 1.0 });
  m.round(1, LOST, [1, 2, 3, 4, 5]);
  assert.ok(m.signals().reinvention, "one fires");
  // cumulative counter should be exactly 1
  assert.equal(m.signals().reinventions, 1);
});

test("⑱ no reinvention when lostArts is empty", () => {
  const m = new WorkshopMembrane({ enabled: true, reinventP: 1.0 });
  for (let t = 1; t <= 50; t++) m.round(t, [], [1, 2, 3]);
  assert.equal(m.signals().reinvention, null);
  assert.equal(m.signals().reinventions, 0);
});

test("⑱ no reinvention when no explorers", () => {
  const m = new WorkshopMembrane({ enabled: true, reinventP: 1.0 });
  for (let t = 1; t <= 50; t++) m.round(t, LOST, []);
  assert.equal(m.signals().reinvention, null);
  assert.equal(m.signals().reinventions, 0);
});

test("⑱ null-object (enabled=false) never fires", () => {
  const m = new WorkshopMembrane({ enabled: false, reinventP: 1.0 });
  for (let t = 1; t <= 100; t++) m.round(t, LOST, [1, 2, 3]);
  assert.equal(m.signals().reinvention, null);
  assert.equal(m.signals().reinventions, 0);
});

test("⑱ determinism: same inputs produce same outputs", () => {
  const a = new WorkshopMembrane(CFG);
  const b = new WorkshopMembrane(CFG);
  for (let t = 1; t <= 100; t++) {
    a.round(t, LOST, [5, 10, 15, 20]);
    b.round(t, LOST, [5, 10, 15, 20]);
  }
  assert.equal(a.serialize(), b.serialize());
  assert.equal(a.signals().reinventions, b.signals().reinventions);
});

test("⑱ serialize/restore round-trips cumulative count", () => {
  const m = new WorkshopMembrane({ enabled: true, reinventP: 1.0 });
  m.round(1, LOST, [3]);
  m.round(2, LOST, [4]);
  const blob = m.serialize();
  const m2 = new WorkshopMembrane(CFG);
  m2.restore(blob);
  assert.equal(m2.signals().reinventions, m.signals().reinventions);
});

test("⑱ corrupt blob is safely ignored", () => {
  const m = new WorkshopMembrane(CFG);
  m.restore("not json{{{");
  assert.equal(m.signals().reinventions, 0);
  m.restore(JSON.stringify({ v: 999 }));
  assert.equal(m.signals().reinventions, 0);
});

test("⑱ blob size stays tiny (<512 bytes)", () => {
  const m = new WorkshopMembrane({ enabled: true, reinventP: 1.0 });
  for (let t = 1; t <= 1000; t++) m.round(t, LOST, [1, 2, 3]);
  assert.ok(m.serialize().length < 512, `blob is ${m.serialize().length} bytes`);
});
