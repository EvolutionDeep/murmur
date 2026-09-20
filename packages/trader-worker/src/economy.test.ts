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
