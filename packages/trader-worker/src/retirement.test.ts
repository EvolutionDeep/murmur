// LIVE-RETIREMENT tests — the population/swarm layer holds ONLY the living, frees a dead fly's id/slot,
// and never resurrects it on a cold boot. These pin the three behaviours the "越养越少、到顶卡死" bug was
// missing: (1) a retired fly drops out of the roster AND its id is genuinely free (list-driven v6 blob
// round-trips the hole), (2) the vacated slot is reclaimed by the next hatch — INCLUDING a low genesis id,
// (3) a SHARDED retired founder stays dead across an eviction (the tombstone beats the config genesis
// roster), and the coordinator only ever allocates the LOWEST vacant id.

import test from "node:test";
import assert from "node:assert/strict";

import { genomeFromSeed, type Genome } from "@fly/fly-brain";
import { loadConfig, type Env } from "./config.js";
import { Population } from "./population.js";
import {
  LocalSwarm,
  ShardedSwarm,
  KEY_POPULATION,
  KEY_RETIRED,
  KEY_ROSTER,
  type SwarmBackend,
} from "./swarm.js";
import { nextVacantId } from "./state.js";

// ---------- helpers ----------

/** A tiny 4-fly swarm (cap == popSize == 4) — big enough to retire + recycle, small enough to be instant. */
function cfg(over: Partial<Env> = {}) {
  return loadConfig({
    FLY_STATE: {} as Env["FLY_STATE"],
    CHAIN_ID: "5042002",
    RPC_URL: "https://rpc.testnet.arc.io",
    POPULATION_SIZE: "4",
    EVOLUTION_MAX_LIVE_POPULATION: "4",
    ...over,
  } as Env);
}

/** In-memory stand-in for DurableObjectStorage — only get/put are exercised by the swarm layer. */
function mockStorage() {
  const m = new Map<string, unknown>();
  return {
    async get(key: string) { return m.get(key); },
    async put(key: string, value: unknown) { m.set(key, value); },
    async delete(key: string) { m.delete(key); },
    _map: m,
  };
}
type MockStorage = ReturnType<typeof mockStorage>;
// Derive the exact storage type the swarm methods expect (avoids naming the workers-types global, which
// this test file — excluded from the worker tsconfig — type-checks against the DOM lib set).
type DOStorage = Parameters<SwarmBackend["retireFly"]>[1];
const asDO = (s: MockStorage) => s as unknown as DOStorage;

/** A shard DO namespace whose every stub answers any fetch OK — the coordinator's roster bookkeeping is
 *  what these tests check, not the shard's own brain persistence (covered by the shard's ensureFlies logic). */
function mockShardEnv(): Env {
  const stub = {
    fetch: async () => new Response(JSON.stringify({ ok: true }), {
      status: 200, headers: { "content-type": "application/json" },
    }),
  };
  const ns = { idFromName: (name: string) => name, get: () => stub };
  return {
    FLY_STATE: {} as Env["FLY_STATE"],
    FLY_SHARD: ns as unknown as Env["FLY_SHARD"],
    CHAIN_ID: "5042002",
    RPC_URL: "https://rpc.testnet.arc.io",
    POPULATION_SIZE: "4",
    EVOLUTION_MAX_LIVE_POPULATION: "4",
    SHARD_COUNT: "2",
  } as unknown as Env;
}

const genomeFor = (seed: number): Genome => genomeFromSeed(seed);

// ---------- Population: retire frees the id; the v6 blob round-trips the hole ----------

test("population: retire drops a fly, the v6 serialiser preserves the id-hole, and a reload keeps it dead", () => {
  const c = cfg();
  const pop = new Population(c);
  assert.deepEqual(pop.flies.map((f) => f.id), [0, 1, 2, 3], "four genesis flies");

  assert.equal(pop.retire(2), true, "retiring a live fly reports true");
  assert.equal(pop.retire(99), false, "retiring an absent id is a no-op");
  assert.deepEqual(pop.flies.map((f) => f.id), [0, 1, 3], "the roster shrinks and leaves a hole at #2");

  const blob = JSON.parse(pop.serialize());
  assert.equal(blob.version, 6, "the roster shape is bumped to v6 (holes/recycled ids)");

  // A list-driven restore carries EXACTLY the living flies — the freed #2 is never re-derived from config.
  const restored = Population.deserialize(pop.serialize(), c);
  assert.deepEqual(restored.flies.map((f) => f.id), [0, 1, 3], "the hole survives an eviction verbatim");
});

// ---------- LocalSwarm: retire → persist → stays retired; a freed low id recycles ----------

test("local swarm: a retired founder stays retired across reload, and its freed id takes the next hatch", async () => {
  const c = cfg();
  const storage = mockStorage();
  const swarm = new LocalSwarm(c, new Population(c));
  assert.deepEqual(swarm.liveIds(), [0, 1, 2, 3]);

  assert.equal(await swarm.retireFly(1, asDO(storage)), true);
  assert.deepEqual(swarm.liveIds(), [0, 2, 3], "#1 is gone from the live set");
  assert.equal(await swarm.retireFly(1, asDO(storage)), false, "double-retire is idempotent");

  // Reload from the persisted blob: the dead #1 is NOT resurrected (list-driven roster holds only the living).
  const reloaded = await LocalSwarm.load(c, asDO(storage));
  assert.deepEqual(reloaded.liveIds(), [0, 2, 3], "a cold boot keeps #1 buried");

  // The freed LOW id is reclaimed by a new offspring — proving a dead fly no longer squats a slot.
  assert.equal(await reloaded.hatchLiveFly(1, genomeFor(777), asDO(storage)), true, "recycle freed genesis #1");
  // The local swarm is list-driven (a hatch appends), so compare the LIVE SET, not its order.
  assert.deepEqual([...reloaded.liveIds()].sort((a, b) => a - b), [0, 1, 2, 3], "the slot is live again with a newborn");

  // An id at/over the cap is refused (the cap is the hard boundary, not a vacant slot).
  assert.equal(await reloaded.hatchLiveFly(4, genomeFor(888), asDO(storage)), false, "id >= cap rejected");
});

// ---------- ShardedSwarm: tombstone beats the config genesis roster on a cold boot ----------

test("sharded swarm: a retired founder is tombstoned and never resurrected; a recycle lifts the tombstone", async () => {
  const env = mockShardEnv();
  const c = loadConfig(env);
  const storage = mockStorage();
  const swarm = new ShardedSwarm(c, env);
  assert.deepEqual(swarm.liveIds(), [0, 1, 2, 3], "genesis roster derived from config");

  assert.equal(await swarm.retireFly(0, asDO(storage)), true);
  assert.deepEqual(swarm.liveIds(), [1, 2, 3], "#0 drops from the reduce roster");
  assert.deepEqual(storage._map.get(KEY_RETIRED), [0], "#0 is tombstoned");
  assert.deepEqual(storage._map.get(KEY_ROSTER), [], "no hatched offspring recorded yet");

  // A cold boot re-derives the FULL genesis roster in the constructor, then rebuildRosterFromState() must
  // drop every tombstoned id — otherwise a buried founder #0 would silently trade again.
  const reboot = await ShardedSwarm.load(c, env, asDO(storage));
  assert.deepEqual(reboot.liveIds(), [1, 2, 3], "the tombstone keeps founder #0 dead across eviction");

  // Reclaiming the slot lifts the tombstone and records the offspring, so the NEXT boot keeps the newborn.
  assert.equal(await reboot.hatchLiveFly(0, genomeFor(555), asDO(storage)), true);
  assert.deepEqual(reboot.liveIds(), [0, 1, 2, 3], "#0 is live again — as a NEW individual");
  assert.deepEqual(storage._map.get(KEY_RETIRED), [], "the tombstone is cleared on recycle");
  const bred = storage._map.get(KEY_ROSTER) as Array<{ id: number }>;
  assert.deepEqual(bred.map((b) => b.id), [0], "the recycled slot is persisted as a hatched offspring");

  const final = await ShardedSwarm.load(c, env, asDO(storage));
  assert.deepEqual(final.liveIds(), [0, 1, 2, 3], "the reclaimed #0 survives a further reload");
});

// ---------- coordinator allocation: always the LOWEST vacant id in [0, cap) ----------

test("nextVacantId: hands back the lowest free slot, recycles a freed low id, and -1 when full", () => {
  assert.equal(nextVacantId(new Set(), 4), 0, "nothing live ⇒ the first slot");
  assert.equal(nextVacantId(new Set([0, 1, 3]), 4), 2, "lowest genuine hole wins");
  assert.equal(nextVacantId(new Set([1, 2, 3]), 4), 0, "a retired low id is reused first");
  assert.equal(nextVacantId(new Set([0, 1, 2, 3]), 4), -1, "full ⇒ no slot (the gate stops hatching)");
});

// ---------- config gate: live-retirement is ON by default, POP_LIVE_RETIRE=false opts out ----------

test("config: liveRetire defaults ON and POP_LIVE_RETIRE=false restores the legacy monotonic roster", () => {
  assert.equal(cfg().liveRetire, true, "on by default (dead flies retire)");
  assert.equal(cfg({ POP_LIVE_RETIRE: "false" }).liveRetire, false, "explicit false ⇒ rollback switch");
  assert.equal(cfg({ POP_LIVE_RETIRE: "true" }).liveRetire, true);
  void KEY_POPULATION;
});
