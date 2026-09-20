// Agent-economy tests — and specifically the ONE-DIRECTIONAL READ-OUT invariant.
//
// An external review asked for "the economic loop feeding back into the neural layer". That feedback is
// deliberately ABSENT: the economy is a strict read-out of the connectome (drives → intent → x402
// settlement) and NEVER writes back into the neurons. Feeding money into the membrane would destabilise
// the mutually-inhibitory winner-take-all that already hard-latched once in this project's history (see
// the spike-frequency-adaptation fix). These tests turn that design decision into an enforced contract:
// the neural readings the economy consumes must be bit-for-bit unchanged after a settlement round, while
// the money side stays deterministic, conserved and honestly mapped from behaviour.

import test from "node:test";
import assert from "node:assert/strict";

import { AgentEconomy, type EconomyConfig, type GoodKind } from "./economy.js";
import type { FlyReading, CollectiveState } from "./population.js";
import { usdcToAtomic, atomicToUsdc } from "./x402.js";

/** Deterministic simulated-mode config (no keys, no chain, no RPC — runs anywhere). */
function cfg(over: Partial<EconomyConfig> = {}): EconomyConfig {
  return {
    enabled: true,
    network: "arc",
    initialBalanceUsdc: 6,
    basePriceUsdc: 0.002,
    solvencyFloorUsdc: 0.5,
    maxDealsPerTick: 24,
    facilitatorMode: "simulated",
    seedBase: 42,
    realSpendEnabled: false,
    dailyCapUsdc: 0,
    perAgentDailyCapUsdc: 0,
    maxDealUsdc: 0,
    netMinBroadcastUsdc: 0,
    netFlushTicks: 0,
    populationSize: 24,
    hatchSeedUsdc: 0.002,
    ...over,
  };
}

function reading(id: number, state: FlyReading["state"], over: Partial<FlyReading> = {}): FlyReading {
  return {
    id, state,
    arousal: 0.9, turnBias: id % 2 ? 0.4 : -0.4, cohesion: 0.5,
    wingbeat: 0.8, rest: 0.05, temperament: (id * 7919) % 1000 / 1000,
    fingerprint: `fp${id}`,
    fap: "FORAGE", valence: 0, heading: 0, role: "signal-seeker", bouts: [],
    ...over,
  };
}

function collective(temperature = 0.8): CollectiveState {
  return {
    temperature, regime: temperature >= 0.66 ? "HOT" : temperature <= 0.33 ? "COLD" : "CALM",
    vitality: temperature, size: 24, arousal: 0.7, cohesion: 0.5, rest: 0.1, wingbeat: 0.6,
    states: { AGITATE: 0, EXPLORE: 0, AGGREGATE: 0, REST: 0 },
    faps: {}, valence: 0,
  };
}

const population = (state: FlyReading["state"], n = 24) =>
  Array.from({ length: n }, (_, i) => reading(i, state));

test("the economy is a strict ONE-DIRECTIONAL read-out: it never mutates the neural layer", async () => {
  const econ = new AgentEconomy(cfg());
  const readings = population("AGITATE");
  const coll = collective(0.9);

  // Freeze the neural inputs deeply. Any write-back into a drive/state would throw in strict mode.
  const before = JSON.stringify(readings);
  for (const r of readings) Object.freeze(r);
  Object.freeze(readings);
  Object.freeze(coll);

  const settled = await econ.step(readings, coll, 1);
  assert.ok(settled.length > 0, "the round actually settled something (the read-out is live, not vacuous)");
  assert.equal(JSON.stringify(readings), before, "neural readings are bit-for-bit unchanged after settling");

  // And the produced settlements are derived FROM the drives, referencing agents by id only.
  for (const s of settled) {
    assert.ok(Number.isFinite(s.fromId) && Number.isFinite(s.toId), "settlement references fly ids");
    assert.notEqual(s.fromId, s.toId, "no self-trade");
  }
});

test("behavioural state maps deterministically onto the good being bought", async () => {
  const expected: Record<string, GoodKind> = {
    EXPLORE: "signal", AGITATE: "momentum", AGGREGATE: "attestation",
  };
  for (const [state, good] of Object.entries(expected)) {
    const econ = new AgentEconomy(cfg());
    const settled = await econ.step(
      population(state as FlyReading["state"]),
      collective(0.85),
      7,
    );
    assert.ok(settled.length > 0, `${state} produced settlements`);
    for (const s of settled) assert.equal(s.good, good, `${state} ⇒ buys ${good}`);
  }
});

test("a valid settlement moves value buyer→seller and updates both ledgers", async () => {
  const econ = new AgentEconomy(cfg());
  const settled = await econ.step(population("AGITATE"), collective(0.9), 3);
  const valid = settled.find((s) => s.valid);
  assert.ok(valid, "at least one settlement cleared the x402 flow");

  const buyer = econ.getAgent(valid!.fromId)!;
  const seller = econ.getAgent(valid!.toId)!;
  assert.equal(buyer.deals >= 1, true, "buyer deal count incremented");
  assert.equal(seller.sales >= 1, true, "seller sale count incremented");
  assert.ok(atomicToUsdc(buyer.paid) >= atomicToUsdc(valid!.amount), "buyer lifetime paid covers the deal");
  assert.ok(atomicToUsdc(seller.earned) >= atomicToUsdc(valid!.amount), "seller lifetime earned covers the deal");
  assert.ok(BigInt(valid!.amount) > 0n, "a positive atomic amount moved");
});

test("simulated money is conserved: total = founding float + treasury top-ups", async () => {
  const econ = new AgentEconomy(cfg({ initialBalanceUsdc: 6, solvencyFloorUsdc: 0.5 }));
  const readings = population("AGITATE");
  for (let tick = 0; tick < 12; tick++) await econ.step(readings, collective(0.85), tick);

  const snap = econ.snapshot();
  const totalAtomic = snap.agents.reduce((sum, a) => sum + BigInt(a.balance), 0n);
  const founding = BigInt(usdcToAtomic(6)) * BigInt(snap.agents.length);
  const treasury = BigInt(snap.totals.treasuryOutAtomic);
  // Transfers are zero-sum between agents; the ONLY source of new simulated liquidity is the treasury.
  assert.equal(totalAtomic, founding + treasury, "no value created or destroyed except documented top-ups");
  assert.equal(snap.mode, "simulated");
});

test("the solvency floor keeps a drained agent alive (liveness without a faucet)", async () => {
  // Floor == founding float, so the first purchase drops a buyer below it and the treasury must refill.
  const econ = new AgentEconomy(cfg({ initialBalanceUsdc: 6, solvencyFloorUsdc: 6 }));
  const readings = population("AGITATE");
  for (let tick = 0; tick < 10; tick++) await econ.step(readings, collective(0.95), tick);

  const snap = econ.snapshot();
  const floor = BigInt(usdcToAtomic(6));
  for (const a of snap.agents) {
    assert.ok(BigInt(a.balance) >= floor, `agent ${a.id} never falls below the solvency floor`);
  }
  assert.ok(BigInt(snap.totals.treasuryOutAtomic) > 0n, "the treasury actually topped someone up");
});

test("settlement is fully deterministic for a given (config, drives, tick) — no hidden RNG", async () => {
  const run = () => {
    const econ = new AgentEconomy(cfg());
    return econ.step(population("AGITATE"), collective(0.9), 11);
  };
  const [a, b] = await Promise.all([run(), run()]);
  // Compare on everything the frontend draws (ignore the wall-clock ts only).
  const key = (s: typeof a[number]) => `${s.fromId}>${s.toId}:${s.good}:${s.amount}:${s.txHash}:${s.valid}`;
  assert.deepEqual(a.map(key), b.map(key), "identical inputs ⇒ identical settlement round");
});

test("a disabled economy, or too few flies, settles nothing", async () => {
  const off = new AgentEconomy(cfg({ enabled: false }));
  assert.deepEqual(await off.step(population("AGITATE"), collective(0.9), 1), []);

  const lonely = new AgentEconomy(cfg());
  assert.deepEqual(await lonely.step([reading(0, "AGITATE")], collective(0.9), 1), [], "a single fly cannot trade");
});

test("gini is 0 for an equal-wealth population and a valid coefficient once wealth diverges", async () => {
  // maxDealsPerTick=0 creates every wallet but settles nothing ⇒ perfectly equal wealth ⇒ gini 0.
  const equal = new AgentEconomy(cfg({ maxDealsPerTick: 0 }));
  await equal.step(population("AGITATE"), collective(0.9), 0);
  assert.equal(equal.snapshot().totals.gini, 0, "identical wallets ⇒ zero inequality");

  // After real trading the wealth distribution spreads; gini must stay a valid coefficient in [0,1).
  const traded = new AgentEconomy(cfg());
  for (let tick = 0; tick < 20; tick++) await traded.step(population("AGITATE"), collective(0.9), tick);
  const g = traded.snapshot().totals.gini;
  assert.ok(g >= 0 && g < 1, `gini ${g.toFixed(3)} is a valid concentration coefficient`);
});

test("the snapshot exposes a per-agent wallet roster for the frontend", async () => {
  const econ = new AgentEconomy(cfg());
  await econ.step(population("EXPLORE", 24), collective(0.7), 5);
  const snap = econ.snapshot();
  assert.equal(snap.agents.length, 24, "one wallet per fly");
  for (const a of snap.agents) {
    assert.match(a.address, /^0x[0-9a-f]{40}$/, "each agent has a 20-byte address");
    assert.ok(typeof a.balance === "string" && a.balance.length > 0, "atomic balance string");
  }
  // Addresses are unique and derived deterministically from (seedBase, id).
  const addrs = new Set(snap.agents.map((a) => a.address));
  assert.equal(addrs.size, 24, "no two flies share a wallet");
});

// ---------- SOCIAL MEMORY: bonds, reputation, the grudge book (economic layer only) ----------

test("settled deals accumulate positive directed bonds and lift both reputations", async () => {
  const econ = new AgentEconomy(cfg());
  for (let t = 0; t < 6; t++) await econ.step(population("AGITATE"), collective(0.9), t);
  const s = econ.socialReadout();
  assert.ok(s.bonds.length > 0, "a past formed between traders");
  assert.ok(s.bonds.every((b) => b.score > 0 && b.trades >= 1), "settled-only history is trust, positive");
  assert.ok(s.rep.some((r) => r.score > 0 && r.kept >= 1), "keep-makers earn a positive name");
  assert.equal(s.grudges.length, 0, "nothing stiffed in this prosperous round");
});

test("a stiffed buyer enters the grudge book: directed grudge for the seller, infamy for the buyer", async () => {
  // Wallets too small for any price, and the treasury floor disabled ⇒ insufficient-funds declines.
  const econ = new AgentEconomy(cfg({ initialBalanceUsdc: 0.000002, solvencyFloorUsdc: 0, basePriceUsdc: 0.05 }));
  const settled = await econ.step(population("AGITATE"), collective(0.9), 1);
  const stiff = settled.find((x) => !x.valid && x.reason === "insufficient-funds");
  assert.ok(stiff, "the buyer promised what it could not pay");

  const s = econ.socialReadout();
  assert.ok(s.grudges.length > 0, "the betrayal is written in the book");
  const g = s.grudges[0];
  assert.equal(g.reason, "insufficient-funds");
  const feud = s.bonds.find((b) => b.a === g.sellerId && b.b === g.buyerId && b.score < 0);
  assert.ok(feud, "the stiffed seller remembers the grudge (directed, not mutual)");
  // The innocent side of the ledger: the seller holds NO negative bond back at the level of trust…
  assert.ok(!s.bonds.some((b) => b.a === g.buyerId && b.b === g.sellerId && b.score < 0),
    "the buyer has no grudge — it was the one who defaulted");
  // …and the defaulting side's NAME is what sinks (the readout is capped, so check SOME marked fly).
  assert.ok(s.rep.some((r) => r.score < 0 && r.broken >= 1), "deadbeats are marked in the open");
  const sig = econ.socialSignals();
  assert.ok(sig.deadbeat && sig.deadbeat.score < 0 && sig.deadbeat.broken >= 1, "the worst name is a stiffing buyer");
});

test("a deep grudge is a hard refusal — until long silence decays it (the swarm forgets)", async () => {
  const two = [reading(0, "AGITATE"), reading(1, "AGITATE")];
  const base = new AgentEconomy(cfg());
  await base.step(two, collective(0.9), 0);            // open both wallets
  const p = JSON.parse(base.serialize());
  // #0 carries a maximal grudge against #1 (its ONLY possible counterparty in a 2-fly world).
  p.social = {
    mem: [
      { id: 0, rep: 0, repTick: 0, kept: 0, broken: 0, bonds: [{ other: 1, score: -1, trades: 0, lastTick: 0 }] },
      { id: 1, rep: 0, repTick: 0, kept: 0, broken: 0, bonds: [] },
    ],
    grudges: [],
  };
  const econ = new AgentEconomy(cfg(), JSON.stringify(p));

  for (let t = 1; t <= 3; t++) {
    const made = await econ.step(two, collective(0.9), t);
    assert.ok(!made.some((x) => x.valid && x.fromId === 0), `tick ${t}: #0 never buys from the fly it despises`);
  }
  // Ten bond half-lives of silence later the wound has faded to ~0.001 — trade resumes on its own.
  let resumed = false;
  for (let t = 300001; t <= 300020 && !resumed; t++) {
    resumed = (await econ.step(two, collective(0.9), t)).some((x) => x.valid && x.fromId === 0);
  }
  assert.ok(resumed, "after a long silence the grudge decays below the blacklist line and #0 trades again");
});

test("social memory round-trips through serialize; an OLD payload (no social) restores with an empty past", async () => {
  const a = new AgentEconomy(cfg());
  for (let t = 0; t < 6; t++) await a.step(population("AGITATE"), collective(0.9), t);

  const b = new AgentEconomy(cfg(), a.serialize());
  assert.deepEqual(b.socialReadout(), a.socialReadout(), "the past survives a DO eviction intact");

  const p = JSON.parse(a.serialize());
  delete p.social;                                     // simulate a pre-social-memory blob
  const c = new AgentEconomy(cfg(), JSON.stringify(p));
  assert.equal(c.socialReadout().bonds.length, 0, "no social field ⇒ no past, nobody is blacklisted");
  assert.equal(c.snapshot().agents.length, a.snapshot().agents.length, "the LEDGER still restores (version untouched)");
  assert.equal(c.snapshot().totals.count, a.snapshot().totals.count, "lifetime settlements survived");
});

test("social memory is BOUNDED: top-K bonds per fly, capped grudge book (DO-safe)", async () => {
  const econ = new AgentEconomy(cfg({ initialBalanceUsdc: 0.000002, solvencyFloorUsdc: 0, basePriceUsdc: 0.05 }));
  for (let t = 0; t < 60; t++) await econ.step(population("AGITATE"), collective(0.85 + 0.1 * Math.sin(t)), t);
  const p = JSON.parse(econ.serialize());
  for (const m of p.social.mem) {
    assert.ok(m.bonds.length <= 8, `agent ${m.id} keeps at most its top-K bonds`);
  }
  assert.ok(p.social.grudges.length <= 24, "the grudge book is a capped ring");
  assert.ok(econ.serialize().length < 200_000, "the whole economy blob stays far below DO limits");
});

test("social state is deterministic: identical input sequences ⇒ identical accumulated past", async () => {
  const run = async () => {
    const econ = new AgentEconomy(cfg());
    for (let t = 0; t < 15; t++) await econ.step(population("AGITATE"), collective(0.8), t);
    return JSON.stringify(JSON.parse(econ.serialize()).social);
  };
  assert.equal(await run(), await run(), "same drives + same ticks ⇒ same bonds, rep and grudges");
});

test("social signals for the historian name the live feud, alliance, betrayal and deadbeat", async () => {
  // Two poor flies repeatedly stiff each other (roles alternate) — a blood-feud with a written history.
  const two = [reading(0, "AGITATE"), reading(1, "AGITATE")];
  const econ = new AgentEconomy(cfg({ initialBalanceUsdc: 0.000002, solvencyFloorUsdc: 0, basePriceUsdc: 0.05 }));
  for (let t = 1; t <= 10; t++) await econ.step(two, collective(0.9), t);
  const sig = econ.socialSignals();
  assert.ok(sig.betrayal, "the newest grudge-book entry surfaces");
  assert.ok(sig.deadbeat && sig.deadbeat.broken >= 1, "the worst live reputation surfaces");
  assert.ok(sig.topFeud && sig.topFeud.score <= -0.6, "a blacklist-deep directed bond surfaces as the live feud");
  assert.equal(sig.topAlliance, null, "no alliance yet — nothing was ever settled in good faith");
});

// ================= DYNASTY: houses, tithes, deaths, inheritance =================
// Same one-way law as social memory: a house and a grave move LEDGERS and feed the historian's read-out;
// nothing here touches a neuron. And every collection is capped so the DO blob stays bounded.

const HASH_A = "a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90";
const HASH_B = "0f1e2d3c4b5a69788796a5b4c3d2e1f00f1e2d3c4b5a69788796a5b4c3d2e1f0";

test("dynasty: a hatch founds a house; descendants inherit the name; the seed folds from the genome hash", async () => {
  const econ = new AgentEconomy(cfg({ dynasty: {} }));
  await econ.step(population("AGITATE"), collective(0.8), 100);

  const f = econ.noteHatch(3, 24, HASH_A);
  assert.ok(f && f.founded, "a nameless parent's hatch founds a house");
  assert.ok(f!.name.length > 0 && f!.sigil.length > 0, "the house bears a deterministic name + sigil");
  const c1 = econ.noteHatch(3, 25, HASH_B);
  assert.equal(c1!.houseId, f!.houseId, "a sibling is born into the same house");
  assert.equal(c1!.founded, false);
  const c2 = econ.noteHatch(24, 26, HASH_B);
  assert.equal(c2!.houseId, f!.houseId, "a grandchild carries the same name");
  const rd = econ.dynastyReadout();
  const house = rd.houses.find((h) => h.id === 3)!;
  assert.equal(house.gen, 2, "the banner records the highest generation reached");
  assert.equal(house.members, 4, "founder + 3 inducted descendants");

  // Determinism: an identical call sequence on a fresh economy names the identical house.
  const twin = new AgentEconomy(cfg({ dynasty: {} }));
  await twin.step(population("AGITATE"), collective(0.8), 100);
  assert.deepEqual(twin.noteHatch(3, 24, HASH_A), f, "same genome hash ⇒ same name and sigil");
});

test("dynasty: the house roll is capped — past it, offspring are born commoners (DO storage bound)", async () => {
  const econ = new AgentEconomy(cfg({ dynasty: { maxHouses: 4 } }));
  await econ.step(population("AGITATE"), collective(0.8), 5);
  for (let p = 0; p < 4; p++) assert.ok(econ.noteHatch(p, 100 + p, HASH_A)?.founded, `parent #${p} founds`);
  assert.equal(econ.noteHatch(10, 110, HASH_A), null, "the 5th founder stays a commoner — the roll is full");
  assert.equal(econ.dynastyReadout().houses.length, 4);
});

test("dynasty: members' income tithes into the common treasury; commoners and thin purses pay nothing", async () => {
  const econ = new AgentEconomy(cfg({ dynasty: { tithePct: 0.02 } }));
  await econ.step(population("EXPLORE"), collective(0.5), 10);
  econ.noteHatch(5, 24, HASH_A);
  const founder = econ.getAgent(5)!;
  founder.balance = "1000000";                       // 1.0 USDC
  econ.titheHouse(5, "500000");                      // 2% of a 0.5 USDC gross income
  let rd = econ.dynastyReadout();
  const house = rd.houses.find((h) => h.id === 5)!;
  assert.equal(house.treasuryUsdc, 0.01, "exactly the per-mille tithe landed in the vault");
  assert.equal(founder.balance, "990000", "the tithe came out of the member's own wallet — never minted");
  assert.equal(house.earnedUsdc, 0.5, "lifetime gross tithed income is the prestige counter");
  // A commoner's income tithes nothing, and a member poorer than the tithe skips rather than goes negative.
  const poor = econ.getAgent(7)!;
  poor.balance = "5";
  econ.titheHouse(7, "1000000");
  econ.titheHouse(5, "999999999");                   // tithe would exceed the founder's whole balance
  assert.equal(poor.balance, "5", "a commoner pays no tithe");
  rd = econ.dynastyReadout();
  assert.equal(rd.houses.find((h) => h.id === 5)!.treasuryUsdc, 0.01, "an unaffordable tithe is skipped whole");
});

test("dynasty: the eldest is buried of old age and the estate passes to the living children — no minting", async () => {
  const econ = new AgentEconomy(cfg({ dynasty: { oldAgeTicks: 5, penuryGraceTicks: 1_000_000 } }));
  await econ.step(population("EXPLORE"), collective(0.3), 10);   // quiet: barely any settlement
  econ.noteHatch(0, 24, HASH_A);                     // #0 founds, #24 is its heir
  await econ.step([...population("EXPLORE"), reading(24, "EXPLORE")], collective(0.3), 10);  // heir gets a wallet
  const founder = econ.getAgent(0)!;
  const child = econ.getAgent(24)!;
  founder.balance = "900";
  const before = BigInt(child.balance);
  const graves = econ.noteMortality(16, 0.3);        // age 6 ≥ oldAgeTicks 5 → the eldest falls
  assert.equal(graves.length, 1);
  assert.equal(graves[0].id, 0);
  assert.equal(graves[0].cause, "aged");
  assert.deepEqual(graves[0].heirIds, [24], "the living child inherits");
  assert.equal(founder.balance, "0", "the estate left the grave");
  assert.equal(BigInt(child.balance) - before, 900n, "exactly the estate moved — the ledger neither grows nor shrinks");
  const rd = econ.dynastyReadout();
  assert.equal(rd.dead, 1);
  assert.equal(rd.graves[0].houseName, graves.length ? rd.houses[0].name : null, "the grave bears the house name");
  // A closed ledger trades no more: the buried founder cannot buy, sell, or be bailed out.
  const dead0 = econ.snapshot().agents.find((a) => a.id === 0)!;
  assert.equal(dead0.dead, true);
  for (let t = 17; t < 27; t++) await econ.step(population("AGITATE"), collective(0.9), t);
  assert.equal(econ.getAgent(0)!.balance, "0", "penury stays buried: no solvency bailout for the dead");
});

test("dynasty: penury claims a broke silent trader, and an estate with no living heir falls to the house vault", async () => {
  const econ = new AgentEconomy(cfg({ dynasty: { penuryGraceTicks: 10, oldAgeTicks: 1_000_000 } }));
  await econ.step(population("AGITATE"), collective(0.9), 100);
  const broke = econ.getAgent(2)!;
  broke.balance = "0"; broke.deals = 3; broke.lastTick = 50;   // once traded, now broke and silent
  const graves = econ.noteMortality(80, 0.5);        // 30 ticks of silence ≥ grace 10
  assert.equal(graves.length, 1, "one penury burial per cron at most");
  assert.equal(graves[0].id, 2);
  assert.equal(graves[0].cause, "penury", "a fly that once traded and sits broke in silence dies of want");
  assert.equal(graves[0].estate, "0", "the penurious leave nothing behind");
  assert.equal(econ.snapshot().agents.find((a) => a.id === 2)!.dead, true);

  // Vault inheritance: the founder outlives his line (heir predeceased — ledger shaping) and falls himself.
  const b = new AgentEconomy(cfg({ dynasty: { penuryGraceTicks: 1_000_000, oldAgeTicks: 5 } }));
  await b.step(population("EXPLORE"), collective(0.2), 60);
  b.noteHatch(1, 24, HASH_A);                        // #1 founds the house
  const p = JSON.parse(b.serialize());
  const kin1 = p.dynasty.kin.find((k: { id: number }) => k.id === 1);
  kin1.bornTick = 50;                                 // the founder is the eldest fly by a decade
  kin1.children = [];                                 // and his line is extinguished
  const v = new AgentEconomy(cfg({ dynasty: { penuryGraceTicks: 1_000_000, oldAgeTicks: 5 } }), JSON.stringify(p));
  v.getAgent(1)!.balance = "800";
  const g2 = v.noteMortality(66, 0.3);               // founder born 50 → by far the eldest
  assert.equal(g2.length, 1);
  assert.equal(g2[0].id, 1, "the eldest fly falls first — the founder himself");
  assert.equal(g2[0].cause, "aged");
  assert.deepEqual(g2[0].heirIds, [], "no living heir is named");
  assert.equal(v.dynastyReadout().houses[0].treasuryUsdc, 0.0008, "the estate fell to the common vault — the name outlives the fly");
});

test("dynasty: serialize round-trips the houses, graves and the dead; an old payload restores no dynasty", async () => {
  const a = new AgentEconomy(cfg({ dynasty: { oldAgeTicks: 5, penuryGraceTicks: 1_000_000 } }));
  await a.step(population("AGITATE"), collective(0.8), 40);
  a.noteHatch(2, 24, HASH_A);
  a.noteMortality(60, 0.4);                          // ages out the founder line slowly
  const b = new AgentEconomy(cfg({ dynasty: {} }), a.serialize());
  assert.deepEqual(b.dynastyReadout(), a.dynastyReadout(), "houses, graves and closed ledgers survive eviction");
  const p = JSON.parse(a.serialize());
  delete p.dynasty;                                  // simulate a pre-dynasty blob
  const c = new AgentEconomy(cfg({ dynasty: {} }), JSON.stringify(p));
  const rd = c.dynastyReadout();
  assert.equal(rd.houses.length, 0, "no dynasty field ⇒ no houses, nobody ever died");
  assert.equal(rd.dead, 0);
  assert.equal(c.snapshot().totals.count, a.snapshot().totals.count, "the LEDGER still restores (KEY_VERSION untouched)");
});

test("dynasty: disabled (or absent) the layer is inert — no names, no tithes, no deaths", async () => {
  const off = new AgentEconomy(cfg({ dynasty: { enabled: false } }));
  await off.step(population("AGITATE"), collective(0.9), 10);
  assert.equal(off.noteHatch(0, 24, HASH_A), null);
  assert.equal(off.noteMortality(999999, 1).length, 0, "even a million ticks of age: the switch is the switch");
  off.titheHouse(0, "1000000");
  assert.equal(off.dynastyReadout().houses.length, 0);
  assert.deepEqual(off.dynastySignals(), { founding: null, dominance: null, death: null });
  const absent = new AgentEconomy(cfg());            // no dynasty key at all ⇒ byte-for-byte the old economy
  await absent.step(population("AGITATE"), collective(0.9), 10);
  assert.equal(absent.noteHatch(0, 24, HASH_A), null);
});

test("dynasty signals name the founding, the dominant house and the newest grave for the historian", async () => {
  const econ = new AgentEconomy(cfg({ dynasty: { oldAgeTicks: 5, penuryGraceTicks: 1_000_000 } }));
  await econ.step(population("EXPLORE"), collective(0.3), 10);
  const f = econ.noteHatch(4, 24, HASH_A);
  let sig = econ.dynastySignals();
  assert.equal(sig.founding?.name, f!.name, "the newest house surfaces for the chronicle");
  assert.equal(sig.founding?.houseId, 4);
  assert.equal(sig.death, null, "nobody has died yet");
  econ.getAgent(4)!.balance = "6000000000";          // 6000 USDC: the house towers over the swarm
  sig = econ.dynastySignals();
  assert.ok(sig.dominance && sig.dominance.capitalShare >= 0.18, "a house holding the swarm's capital surfaces");
  for (let t = 16; t <= 20; t++) econ.noteMortality(t, 0.3);   // the eldest fall one per cron until the founder's turn
  sig = econ.dynastySignals();
  assert.equal(sig.death?.id, 4, "the newest grave is the house founder");
  assert.equal(sig.death?.houseName, f!.name, "the epitaph names the house");
});

// CULTURE HOOKS into the dynasty ledger: the founder's creed AT FOUNDING freezes as the house
// tradition (additive HouseRecord field), houseOf() is the read-only banner the CultureMembrane asks
// for, and the round-trip must survive eviction — while a pre-culture payload stays exactly itself.

test("culture hooks: the founding creed becomes the house tradition; houseOf reads the banner", async () => {
  const a = new AgentEconomy(cfg({ dynasty: {} }));
  await a.step(population("AGITATE"), collective(0.8), 100);
  const f = a.noteHatch(3, 24, HASH_A, "FORAGE");
  assert.ok(f?.founded);
  a.noteHatch(5, 25, HASH_B);                          // a second house, founded WITHOUT a creed
  assert.deepEqual(a.houseOf(3), { id: 3, name: f!.name, sigil: f!.sigil, tradition: "FORAGE" }, "founder bears his frozen creed");
  assert.deepEqual(a.houseOf(24)!, a.houseOf(3)!, "the heir is born under the same banner");
  assert.equal(a.houseOf(5)!.tradition, null, "a house founded without a seed has no tradition (not an error)");
  assert.equal(a.houseOf(9), null, "a commoner carries no banner");
  assert.equal(a.dynastyReadout().houses.find((h) => h.id === 3)!.tradition, "FORAGE", "the read-out surfaces it");

  // Round-trip: the additive field survives eviction; strip it and the OLD payload still restores clean.
  const b = new AgentEconomy(cfg({ dynasty: {} }), a.serialize());
  assert.deepEqual(b.dynastyReadout(), a.dynastyReadout(), "traditions ride the dynasty blob");
  const p = JSON.parse(a.serialize());
  for (const h of p.dynasty.houses) delete h.tradition;
  const c = new AgentEconomy(cfg({ dynasty: {} }), JSON.stringify(p));
  assert.equal(c.houseOf(3)!.tradition, null, "a pre-culture house record restores with NO tradition key");
  assert.ok(!("tradition" in (c as unknown as { houses: Map<number, object> }).houses.get(3)!), "never tradition:undefined — old blobs round-trip byte-identically");

  // Junk seeds are refused, not stored: tradition can only ever be a FAP-shaped token.
  const d = new AgentEconomy(cfg({ dynasty: {} }));
  await d.step(population("AGITATE"), collective(0.8), 100);
  d.noteHatch(3, 24, HASH_A, "i shall dominate the commons");
  assert.equal(d.houseOf(3)!.tradition, null, "a non-FAP-shaped fapSeed is dropped at the gate");
});

// INSTITUTIONS ⑥-A hooks into the economy: the deal price becomes a BOOK CROSSING, while the OFF
// path is provably the old economy to the atomic dust — and ON is as deterministic as everything else.
test("institutions: OFF ⇒ the old fixed formula byte-for-byte; ON ⇒ every deal crosses the limit book", async () => {
  const off = new AgentEconomy(cfg());
  const offDeals = await off.step(population("AGITATE"), collective(0.8), 7);
  assert.ok(offDeals.length > 0, "an AGITATE swarm at T=0.8 trades");
  assert.equal(off.marketSnapshot(), null, "the OFF economy does not even expose books");
  const expected = String(Math.max(1, Math.round(0.002 * (0.5 + 0.8) * (0.6 + 0.6 * 0.9) * 1.25 * 1e6)));
  assert.equal(offDeals[0].good, "momentum", "AGITATE buys momentum");
  assert.equal(offDeals[0].amount, expected, "OFF prices match the old formula atom-for-atom");

  const offExplicit = new AgentEconomy(cfg({ institutions: { enabled: false } }));
  const off2 = await offExplicit.step(population("AGITATE"), collective(0.8), 7);
  assert.deepEqual(
    off2.map((s) => `${s.fromId}>${s.toId}:${s.amount}`),
    offDeals.map((s) => `${s.fromId}>${s.toId}:${s.amount}`),
    "enabled:false ≡ absent: the old economy byte-for-byte",
  );

  const on = new AgentEconomy(cfg({ institutions: { enabled: true } }));
  const onDeals = await on.step(population("AGITATE"), collective(0.8), 7);
  assert.ok(onDeals.length > 0, "ON settles too");
  // One calm, even herd: every seller reluctant (rung +20% around center .002×1.3×1.25), nobody
  // sweeps — so the tape prints the book, not the formula.
  assert.equal(onDeals[0].amount, String(Math.round(0.002 * 1.3 * 1.25 * 1e6 * 1.2)), "ON prices come from crossing the ladder");
  assert.notEqual(onDeals[0].amount, expected, "and those prices DIFFER from the formula — discovery is live");
  const twin = await new AgentEconomy(cfg({ institutions: { enabled: true } })).step(population("AGITATE"), collective(0.8), 7);
  assert.deepEqual(twin.map((s) => s.amount), onDeals.map((s) => s.amount), "ON is deterministic too: twins print identical tapes");
  const ms = on.marketSnapshot()!;
  assert.equal(ms.marks.momentum.length, 1, "the tape holds exactly this tick's marks so far");
  assert.ok(ms.books.every((bk) => bk.bids.length === 4 && bk.asks.length === 4), "bounded 4×2 rungs per good");
});

// INSTITUTIONS ⑥-B: sticky professions, the IOU life-cycle (issue → repay → default) and the class
// read-out. The conservation law is the headline: a repayment moves wallets, a default seizes
// whatever is left and grudges the rest — and at no point does money appear from nowhere.
test("institutions: professions are sticky identities — a trade change takes sustained hysteresis", async () => {
  const econ = new AgentEconomy(cfg({ institutions: { enabled: true } }));
  const one = [reading(0, "EXPLORE"), reading(1, "EXPLORE")];
  await econ.step(one, collective(0.5), 1);
  const rowOf = (id: number) => econ.snapshot().agents.find((a) => a.id === id)!;
  assert.equal(rowOf(0).profession, "forager", "a FORAGE history opens the ledger as a forager");

  // The fly RETIRES (literally): the old trade must be held off for the full hysteresis window.
  const resting = [reading(0, "REST", { fap: "REST", arousal: 0.05 }), reading(1, "REST", { fap: "REST", arousal: 0.05 })];
  let changed = -1;
  for (let t = 2; t <= 200 && changed < 0; t++) {
    await econ.step(resting, collective(0.5), t);
    if (rowOf(0).profession !== "forager") changed = t;
  }
  assert.ok(changed >= 13, `the switch cannot come before the hysteresis window (got tick ${changed})`);
  assert.equal(rowOf(0).profession, "brooder", "and when it comes, it is to the new mode of the tally");
  assert.equal(resting[0].fap, "REST", "the readings themselves were never touched — one-way law intact");

  // OFF: no identity is ever recorded — keys absent, the old wallet row verbatim.
  const off = new AgentEconomy(cfg());
  await off.step(one, collective(0.5), 1);
  const offRow = off.snapshot().agents.find((a) => a.id === 0)!;
  assert.ok(!("profession" in offRow) && !("debtAtomic" in offRow), "OFF ⇒ no profession/debt keys at all");
  assert.equal(off.snapshot().market, undefined, "OFF exposes no market read-out");
});

test("institutions: an IOU is issued in place of a stiff, repaid from real income, and defaulted to a grudge", async () => {
  // A poor swarm priced above every wallet, credit line drawn to hold EXACTLY ONE promise per fly: the
  // first overpromise is a signature, the next one across the same line is the OLD honest stiff.
  const cLine = { institutions: { enabled: true, creditCapBaseUsdc: 0.02 }, initialBalanceUsdc: 0.007, solvencyFloorUsdc: 0, basePriceUsdc: 0.01 };
  const frozen = { ...cLine, maxDealsPerTick: 0 };   // phase 2/3 freeze the trade loop: ONLY debt service moves money
  const econ = new AgentEconomy(cfg(cLine));
  const poor = population("AGITATE");
  const settled = await econ.step(poor, collective(0.8), 1);
  const iou = settled.find((s) => s.reason === "iou-pending");
  assert.ok(iou, "a forager too thin of purse but good of name signs a promise instead of stiffing");
  assert.equal(iou!.amount, "19500", "the note bears the book-crossed price (momentum center 16250 swept to its 1.2× rung)");
  assert.equal(iou!.valid, false, "it is a promise, not a settlement");
  const buyer = econ.getAgent(iou!.fromId)!;
  // Per-agent balances have moved between OTHER pairs (real deals settled), so conservation is
  // checked on the whole ledger: wallet total + lifetime outflows == founding + lifetime inflows.
  const snap1 = econ.snapshot();
  const walletTotal = snap1.agents.reduce((s, x) => s + BigInt(x.balance), 0n);
  const paidTotal = snap1.agents.reduce((s, x) => s + BigInt(x.paid), 0n);
  const earnedTotal = snap1.agents.reduce((s, x) => s + BigInt(x.earned), 0n);
  assert.equal(walletTotal + paidTotal, BigInt(usdcToAtomic(0.007)) * 24n + earnedTotal,
    "issuing promises minted nothing — every outstanding promise is unpaid to the atomic");
  assert.ok(!settled.some((s) => s.valid && s.fromId === buyer.id && s.amount === iou!.amount),
    "the promised atomic appear in NO settled movement — the note is a promise, not a payment");
  const rd1 = snap1.market!;
  assert.ok(rd1.openIous >= 1 && BigInt(rd1.debtAtomic) > 0n, "the promises are on the book, debt counted in principal");
  assert.ok(rd1.classes.creditors >= 1 && rd1.classes.debtors >= 1, "the class read-out already sees a moneyed side and a borrowing side");

  // A credit line is not a bottomless one: next tick the borrowers already ~at their line cannot sign
  // again — the second overpromise falls back to the plain, honest insufficient-funds stiff.
  const settled2 = await econ.step(poor, collective(0.8), 2);
  assert.ok(settled2.some((s) => s.reason === "insufficient-funds"),
    "past the cap a stiff is still a stiff — the exhausted borrower is refused, not funded from thin air");

  // ONCHAIN has no offline credit at all — and onchain without injected rails REFUSES to build, so
  // the facilitator (the sole balance authority) can never be half-enabled around a IOU code path.
  assert.throws(() => new AgentEconomy(cfg({ facilitatorMode: "onchain", institutions: { enabled: true } })),
    "the onchain constructor demands injected rails: the credit branch is simulated-only by construction");

  // Phase 2 — the ledger's own repayment rails, wallets FROZEN (maxDealsPerTick 0 ⇒ the ONLY money
  // that moves is debt service): the quiet 30%-of-balance sweep bites the LARGEST (overdue) note
  // PARTIALLY, and a partial payment KEEPS the note's original issue date (crumbs must not launder an
  // overdue note into a fresh one). The once-per-cron recall is fenced off so the sweep runs alone.
  const rp = new AgentEconomy(cfg(cLine));
  await rp.step(poor, collective(0.8), 1);                 // open wallets + forager professions
  const p2 = JSON.parse(rp.serialize());
  p2.market.ious = [
    { debtor: 0, creditor: 1, amountAtomic: "12000", issuedTick: -11000, ratePer10: 0 },  // overdue, largest → the sweep bites it
    { debtor: 0, creditor: 2, amountAtomic: "3000", issuedTick: 1, ratePer10: 0 },         // fresh, left untouched
  ];
  p2.market.lastRecallTick = 2;                            // fence the recall: only the 30% sweep runs
  const rp2 = new AgentEconomy(cfg(frozen), JSON.stringify(p2));
  const d0 = rp2.getAgent(0)!, c1 = rp2.getAgent(1)!, c2 = rp2.getAgent(2)!;
  d0.balance = "10000";
  const net0 = BigInt(d0.balance) + BigInt(d0.paid) - BigInt(d0.earned);
  const before1 = BigInt(c1.balance), before2 = BigInt(c2.balance);
  const debtBefore = BigInt(rp2.snapshot().market!.debtAtomic);
  const back = await rp2.step(poor, collective(0.8), 2);
  const pays = back.filter((s) => s.valid && s.resource.startsWith("debt:"));
  assert.ok(pays.length >= 1, "the creditor is paid out of the debtor's own pocket — never from thin air");
  assert.equal(BigInt(d0.balance) + BigInt(d0.paid) - BigInt(d0.earned), net0,
    "conservation: a frozen wallet's net position moved only by real transfers — nothing was minted");
  assert.ok(BigInt(c1.balance) > before1 && BigInt(c2.balance) === before2,
    "the swept creditor grew, the untouched one did not — the 30% went to the LARGEST debt");
  const rd2 = rp2.snapshot().market!;
  assert.ok(BigInt(rd2.debtAtomic) < debtBefore, "the book of debt shrank by real repayment, not by writing");
  const live = JSON.parse(rp2.serialize()).market.ious as { debtor: number; issuedTick: number }[];
  assert.ok(live.some((i) => i.debtor === 0 && i.issuedTick === -11000),
    "a partially-paid overdue note KEEPS its issue date — the storm clock cannot be reset by crumbs");

  // Phase 3 — default: a 25,000-tick-old note is a default, not a debt. Whatever the wallet holds is
  // seized to the creditor; what cannot be paid is written in the grudge book (FEUD material).
  const dd = new AgentEconomy(cfg(cLine));
  await dd.step(poor, collective(0.8), 1);
  dd.getAgent(0)!.balance = "9000";
  const p4 = JSON.parse(dd.serialize());
  p4.market.ious = [{ debtor: 0, creditor: 1, amountAtomic: "9000", issuedTick: -25000, ratePer10: 0.002 }];
  const dd2 = new AgentEconomy(cfg(frozen), JSON.stringify(p4));
  const b1 = BigInt(dd2.getAgent(1)!.balance);
  await dd2.step(poor, collective(0.8), 2);
  const g = dd2.socialReadout().grudges.find((x) => x.reason === "debt-default");
  assert.ok(g, "the book of grudges records the broken promise for the historian's FEUD material");
  assert.ok(BigInt(dd2.getAgent(1)!.balance) - b1 >= 9000n,
    "the debtor's whole pocket was seized to the creditor — interest and all, never phantom compensation");
  assert.ok(dd2.snapshot().market!.openIous === 0, "the aged note was written off the book, seized or not");

  // Institutions OFF: the very same poor swarm goes straight back to plain insufficient-funds stiffs.
  const off = new AgentEconomy(cfg({ initialBalanceUsdc: 0.007, solvencyFloorUsdc: 0, basePriceUsdc: 0.01 }));
  const offSettled = await off.step(population("AGITATE"), collective(0.8), 1);
  assert.ok(!offSettled.some((s) => s.reason === "iou-pending"), "no credit without the switch");
  assert.ok(offSettled.some((s) => s.reason === "insufficient-funds"), "the old stiff path is untouched");
});

test("institutions: a RUN stampedes every creditor at once and doubles the panic in the spreads", async () => {
  // maxDealsPerTick 0 keeps the fixture honest: the storm is measured on the SEEDED book, not diluted by
  // a fresh wave of same-tick borrowing, so the overdue share is exactly what we put on the ledger.
  const cfgRun = () => cfg({ institutions: { enabled: true, creditCapBaseUsdc: 0.02 }, initialBalanceUsdc: 0.007, solvencyFloorUsdc: 0, basePriceUsdc: 0.005, maxDealsPerTick: 0 });
  // A DISPERSED herd of dread (half −0.9, half −0.1): mean −0.5 breaches the RUN line only once the
  // bad paper is there to stampede against; dispersion 0.4 alone (calm control) is not yet a panic.
  const terrified = population("AGITATE").map((r, i) => ({ ...r, valence: i % 2 ? -0.1 : -0.9 }));
  const seed = new AgentEconomy(cfgRun());
  await seed.step(terrified, collective(0.8), 0);      // open all 24 wallets so the restore has agents
  const p = JSON.parse(seed.serialize());
  p.market = {
    profs: [{ id: 0, role: "trader", sinceTick: -99, streak: 99 }],
    ious: [
      { debtor: 0, creditor: 1, amountAtomic: "12000", issuedTick: -11000, ratePer10: 0 },     // overdue, largest → burned off first
      { debtor: 0, creditor: 2, amountAtomic: "8000", issuedTick: 1, ratePer10: 0 },           // fresh → survives the storm
    ],
    marks: {}, lastRecallTick: -1000, runUntilTick: -1,
  };
  const run = new AgentEconomy(cfgRun(), JSON.stringify(p));
  run.getAgent(0)!.balance = "15000";
  assert.equal(run.snapshot().market!.run, false, "before the storm breaks: two notes, one bad, no RUN yet");
  await run.step(terrified, collective(0.8), 1);       // tick 1: dread + 50% bad paper ⇒ the RUN is declared + recalls start
  const boom = await run.step(terrified, collective(0.8), 2);   // tick 2: the storm still holds
  const rd = run.snapshot().market!;
  assert.equal(rd.run, true, "dread + overdue paper ⇒ the RUN is on");
  assert.ok(rd.professions.trader >= 1, "restored professions ride the market blob");
  // The ladder itself: step = 5% × (1 + 0.8×2) = 13% under the RUN vs 9% calm — a doubled panic premium.
  const book = rd.books.find((bk) => bk.good === "momentum")!;
  assert.equal(Number(book.asks[0].price), Math.round(8125 * 1.13), `RUN prints the doubled-slope ladder (got ${book.asks[0].price})`);
  const debtMoves = boom.filter((s) => s.valid && s.resource.startsWith("debt:"));
  assert.ok(debtMoves.length >= 1, "in a RUN the recall is immediate — no waiting for the quiet 30% sweep");
  const d0 = run.getAgent(0)!;
  assert.equal(BigInt(d0.balance) + BigInt(d0.paid), 15000n + BigInt(d0.earned),
    "even the stampede conserves: every seized atomic left the debtor's own wallet");
  const rdEnd = run.snapshot().market!;
  assert.equal(rdEnd.badRate, 0, "the overdue paper was burned off the book by the storm — whatever survived is fresh");
  assert.ok(rdEnd.openIous > 0, `the fresh note survives the stampede — a run burns bad paper, not good (${rdEnd.openIous} live)`);
  // control: the SAME terrified-but-dispersed swarm without bad paper feels no RUN (dread needs debt).
  const calm = new AgentEconomy(cfgRun());
  await calm.step(terrified, collective(0.8), 1);
  const calmBook = calm.snapshot().market!.books.find((bk) => bk.good === "momentum")!;
  assert.equal(calm.snapshot().market!.run, false, "dread alone (no overdue debt) is not a run");
  assert.equal(Number(calmBook.asks[0].price), Math.round(8125 * 1.09), "and the calm ladder keeps its single panic premium");
});

test("institutions: the market blob round-trips; an old payload restores the pure old economy", async () => {
  const a = new AgentEconomy(cfg({ institutions: { enabled: true } }));
  for (let t = 0; t < 4; t++) await a.step(population("EXPLORE"), collective(0.7), t);
  const pa = JSON.parse(a.serialize());
  assert.ok(pa.market, "ON writes the market block");
  assert.equal(pa.market.profs.length, 24, "one sticky profession per fly, sorted by id");
  assert.ok(a.serialize().length < 200_000, "the whole blob stays far below DO limits");

  const b = new AgentEconomy(cfg({ institutions: { enabled: true } }), a.serialize());
  assert.deepEqual(b.marketSnapshot()!.marks, a.marketSnapshot()!.marks, "mark tapes survive eviction");
  assert.deepEqual(b.marketSnapshot()!.books, [], "orders never survive — the tick-live ladder is born empty and rebuilt per step");
  assert.deepEqual(JSON.parse(b.serialize()).market, pa.market, "and re-serialize identically (profs/ious/tapes)");

  // OFF after ON: nothing is written, nothing is read — the pre-institutions byte stream verbatim.
  const off = new AgentEconomy(cfg({ institutions: { enabled: false } }), a.serialize());
  assert.ok(!("market" in JSON.parse(off.serialize())), "OFF serializes NO market key");
  assert.equal(off.marketSnapshot(), null);
  assert.equal(off.snapshot().agents.find((x) => x.id === 0)!.profession, undefined, "no job, no debts read");

  // An OLD payload (no market key at all): the plain economy restores with zero institutions state.
  delete pa.market;
  const c = new AgentEconomy(cfg({ institutions: { enabled: true } }), JSON.stringify(pa));
  assert.equal(c.snapshot().market!.openIous, 0, "no market field ⇒ nobody ever borrowed");
  assert.equal(c.snapshot().agents.find((x) => x.id === 0)!.profession, null, "or worked — the restored row reads jobless until re-read");
  assert.equal(c.snapshot().totals.count, a.snapshot().totals.count, "the LEDGER still restores (KEY_VERSION untouched)");
});
