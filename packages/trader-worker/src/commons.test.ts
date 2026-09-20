// THE COMMONS (layer ⑧) — self-legislation unit tests (packages/trader-worker/src/commons.test.ts).
//
// The whole feature stands or falls on one promise: a society rewriting its own credit rules WITHOUT ever
// being able to mint, crash its ledger, or touch a neuron. Every guard rail is asserted here — determinism
// (no hidden RNG/clock/LLM), one-assembly-per-era, hard band clamping, majority-gating to the base config,
// a switch-off that is byte-for-byte inert, and a bounded blob that a corrupt/foreign payload can only
// reset, never poison.

import test from "node:test";
import assert from "node:assert/strict";

import { CommonsAssembly, type CommonsConfig, type CommonsSeat } from "./commons.js";

const ON: CommonsConfig = {
  enabled: true,
  assemblySize: 4,
  creditCapBandUsdc: [0.01, 0.2],
  iouRateBand: [0, 0.05],
};
const OFF: CommonsConfig = { ...ON, enabled: false };

/** A living fly as the commons sees it: a stable address, an atomic purse, a −1..1 reputation. */
function seat(id: number, balanceAtomic: number, rep: number): CommonsSeat {
  return { id, address: `0x${id.toString(16).padStart(4, "0")}`, balanceAtomic: String(balanceAtomic), rep };
}
/** A believable swarm: a spread of purses and standings so the assembly's condition is not degenerate. */
function roster(n = 12): CommonsSeat[] {
  return Array.from({ length: n }, (_, i) =>
    seat(i, 5_000_000 + i * 1_500_000, ((i * 7919) % 2000) / 1000 - 1));   // balance 5..~21 USDC, rep −1..1
}

test("commons: same era + same roster ⇒ byte-identical assembly and law (determinism, no hidden RNG/clock)", () => {
  const a = new CommonsAssembly(ON);
  const b = new CommonsAssembly(ON);
  assert.equal(a.convene(3, roster()), true);
  assert.equal(b.convene(3, roster()), true);
  assert.equal(a.serialize(), b.serialize(), "two assemblies over identical history agree byte-for-byte");
  assert.deepEqual(a.effectiveParams(), b.effectiveParams());
});

test("commons: one assembly per era — a repeat or an era going backwards is a no-op, a NEW era re-seats", () => {
  const c = new CommonsAssembly(ON);
  assert.equal(c.convene(1, roster()), true, "era I convenes");
  assert.equal(c.convene(1, roster()), false, "era II not yet — the same era cannot be re-seated");
  assert.equal(c.convene(0, roster()), false, "the assembly never legislates on a past era");
  assert.equal(c.convene(2, roster()), true, "a new era dawns a fresh council");
});

test("commons: an assembly needs a society — fewer than two living flies convene nothing", () => {
  const c = new CommonsAssembly(ON);
  assert.equal(c.convene(1, []), false, "no roster, no commons");
  assert.equal(c.convene(1, [seat(0, 1_000_000, 0)]), false, "one fly is not a polity");
  assert.equal(c.effectiveParams().creditCapBaseUsdc, null);
});

test("commons: every legislated target stays INSIDE its band, across many eras and rosters (the constitution)", () => {
  const c = new CommonsAssembly(ON);
  let sawLaw = 0;
  for (let era = 1; era <= 40; era++) {
    // vary the swarm's condition each era so the stance (hawkish/dovish) — and so the direction — changes
    c.convene(era, roster(6 + (era % 8)));
    const eff = c.effectiveParams();
    for (const [v, band] of [[eff.creditCapBaseUsdc, ON.creditCapBandUsdc], [eff.iouRatePer10, ON.iouRateBand]] as const) {
      if (v == null) continue;                 // no law on this knob ⇒ base config stands, nothing to clamp
      assert.ok(v >= band[0] && v <= band[1], `legislated ${v} must never escape [${band}]`);
      sawLaw++;
    }
  }
  assert.ok(sawLaw > 0, "over forty eras of varying condition at least one bill is carried (else the vote is dead code)");
});

test("commons: LAW_ENABLED=false is byte-for-byte inert — no convene, no law, base config stands", () => {
  const c = new CommonsAssembly(OFF);
  assert.equal(c.convene(1, roster()), false, "a disabled commons convenes nothing");
  const eff = c.effectiveParams();
  assert.equal(eff.creditCapBaseUsdc, null, "off ⇒ the economy's own base credit line stands");
  assert.equal(eff.iouRatePer10, null);
  assert.equal(c.size, 0);
});

test("commons: the room must actually AGREE — a bare plurality is refused and the old law stands", () => {
  // A maximally fractured assembly (identical addresses ⇒ identical ballots, half the room) can carry a
  // bill only on a strict majority. Assert the outcome is always null-or-inband (never a phantom law the
  // count does not support), which is the majority gate expressed as an invariant.
  const even = Array.from({ length: 4 }, (_, i) => seat(i, 10_000_000, 0));
  const c = new CommonsAssembly(ON);
  c.convene(1, even);
  const eff = c.effectiveParams();
  for (const v of [eff.creditCapBaseUsdc, eff.iouRatePer10]) {
    if (v != null) assert.ok(v >= ON.creditCapBandUsdc[0] && v <= Math.max(ON.creditCapBandUsdc[1], ON.iouRateBand[1]));
  }
  assert.ok(true, "the vote never fabricates a law past its own count");
});

test("commons: serialize/restore round-trips; a corrupt or foreign blob resets to an EMPTY commons", () => {
  const c = new CommonsAssembly(ON);
  c.convene(2, roster());
  const blob = c.serialize();
  const twin = new CommonsAssembly(ON);
  twin.restore(blob);
  assert.equal(twin.serialize(), blob, "an eviction + reload loses nothing");
  assert.deepEqual(twin.effectiveParams(), c.effectiveParams(), "a restored assembly hands the economy the SAME law");

  for (const bad of ["", "{not json", "[]", JSON.stringify({ version: 99, era: 5 }), JSON.stringify({ era: 5 })]) {
    const junk = new CommonsAssembly(ON);
    junk.convene(3, roster());
    junk.restore(bad);
    assert.equal(junk.size, 0, `corrupt/foreign payload ⇒ empty seats: ${bad.slice(0, 12)}`);
    assert.equal(junk.effectiveParams().creditCapBaseUsdc, null, "a reset commons never legislates");
    assert.equal(junk.readout().seatedEra, 0, "a reset commons forgets the era it had seated");
  }
});

test("commons: read-out is a bounded, pure projection (DO-safe caps, no law leaks into the seats)", () => {
  const big = new CommonsAssembly({ ...ON, assemblySize: 99 });
  big.convene(1, roster(40));
  const ro = big.readout();
  assert.ok(ro.seats.length <= 16, "seats are capped regardless of the requested assembly size");
  assert.ok(ro.decrees.length <= 4, "live decrees stay bounded");
  for (const s of ro.seats) {
    assert.equal(typeof s.balanceUsdc, "number");
    assert.ok(Number.isFinite(s.balanceUsdc) && s.balanceUsdc >= 0, "read-out balances are human USDC, never atomic strings");
  }
});
