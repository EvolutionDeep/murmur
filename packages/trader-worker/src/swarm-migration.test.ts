// LAYOUT-MIGRATION tests — pin the one-time offspring re-seed that keeps live brains from being ORPHANED
// when a clamp / SHARD_COUNT change alters flies-per-shard (and therefore the id→shard map).
//
// A fly id's owning shard is floor(id / fliesPerShard(cap, shardCount)). The 2-flies/shard → 1-fly/shard
// fix (config.ts dropping the `Math.min(64, …)` shard clamp) REMAPS every id to a different isolate, and a
// persisted brain can NOT follow — each shard is its own Durable Object storage. Genesis ids self-heal (a
// shard rebuilds them from the config seed), but a bred offspring's genome lives ONLY in the coordinator's
// KEY_ROSTER, so without the migration every live offspring would wake as a GHOST: present in the roster,
// brain absent in its new shard, fed zero drives by reduceReadOuts forever. These tests prove the re-seed
// (a) ships each offspring to its NEW shard on a per-change, (b) records the layout so it never re-runs, and
// (c) is a no-op when the layout already matches — so a routine cold boot does no redundant shard work.

import test from "node:test";
import assert from "node:assert/strict";

import { genomeFromSeed, type Genome } from "@fly/fly-brain";
import { fliesPerShard, loadConfig, shardOf, type Env } from "./config.js";
import { KEY_LAYOUT, KEY_ROSTER, ShardedSwarm } from "./swarm.js";

// ---------- helpers ----------

/** Every /hatch a coordinator sends, recorded as {shard index, fly id} so routing can be asserted. */
type HatchRecorder = Array<{ shard: number; id: number }>;

/**
 * A shard DO namespace that RECORDS which shard index received each /hatch. The coordinator builds stubs via
 * `ns.get(ns.idFromName("fly-shard-K"))`, so parsing K back out of the name gives the stub its shard index —
 * exactly what the real `shardOf` routing must land on. Every fetch answers `{ ok: true }` (a shard that
 * hosts the id would answer `already: true`; both count as a confirmed re-seed).
 */
function recordingShardEnv(shardCount: number, recorder: HatchRecorder): Env {
  const ns = {
    idFromName: (name: string) => name,
    get: (name: string) => {
      const shard = Number(/(\d+)\s*$/.exec(name)?.[1] ?? -1);
      return {
        fetch: async (req: Request) => {
          const url = new URL(req.url);
          if (url.pathname === "/hatch") {
            const body = (await req.json()) as { id: number };
            recorder.push({ shard, id: Number(body.id) });
          }
          return new Response(JSON.stringify({ ok: true }), {
            status: 200,
            headers: { "content-type": "application/json" },
          });
        },
      };
    },
  };
  return {
    FLY_STATE: {} as Env["FLY_STATE"],
    FLY_SHARD: ns as unknown as Env["FLY_SHARD"],
    CHAIN_ID: "5042002",
    RPC_URL: "https://rpc.testnet.arc.io",
    POPULATION_SIZE: "4",                    // genesis ids 0..3
    EVOLUTION_MAX_LIVE_POPULATION: "8",      // cap 8 ⇒ growth slots 4..7 for offspring
    SHARD_COUNT: String(shardCount),
  } as unknown as Env;
}

/**
 * Like recordingShardEnv, but the FIRST /hatch for each id in `failFirst` answers HTTP 500 (a transient shard
 * failure — the real case is a /hatch that times out because its shard is still loading an orphaned blob).
 * Later attempts for the same id succeed, so a retry re-drives the re-seed to completion. Every /hatch attempt
 * (failed or not) is recorded, so a test can assert both the failed first pass and the successful retry.
 */
function flakyShardEnv(shardCount: number, recorder: HatchRecorder, failFirst: Set<number>): Env {
  const failed = new Set<number>();
  const ns = {
    idFromName: (name: string) => name,
    get: (name: string) => {
      const shard = Number(/(\d+)\s*$/.exec(name)?.[1] ?? -1);
      return {
        fetch: async (req: Request) => {
          const url = new URL(req.url);
          if (url.pathname === "/hatch") {
            const body = (await req.json()) as { id: number };
            const id = Number(body.id);
            recorder.push({ shard, id });
            if (failFirst.has(id) && !failed.has(id)) {
              failed.add(id);
              return new Response(JSON.stringify({ error: "transient" }), { status: 500 });
            }
          }
          return new Response(JSON.stringify({ ok: true }), {
            status: 200,
            headers: { "content-type": "application/json" },
          });
        },
      };
    },
  };
  return {
    FLY_STATE: {} as Env["FLY_STATE"],
    FLY_SHARD: ns as unknown as Env["FLY_SHARD"],
    CHAIN_ID: "5042002",
    RPC_URL: "https://rpc.testnet.arc.io",
    POPULATION_SIZE: "4",
    EVOLUTION_MAX_LIVE_POPULATION: "8",
    SHARD_COUNT: String(shardCount),
  } as unknown as Env;
}

/** In-memory stand-in for DurableObjectStorage — only get/put/delete are exercised by the swarm layer. */
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
// Derive the exact storage type the swarm methods expect (this test file is excluded from the worker
// tsconfig, so it type-checks against the DOM lib set — naming the workers-types global would not resolve).
type DOStorage = Parameters<ShardedSwarm["retireFly"]>[1];
const asDO = (s: MockStorage) => s as unknown as DOStorage;

const genomeFor = (seed: number): Genome => genomeFromSeed(seed);

// ---------- the migration ----------

test("layout migration: a flies/shard change re-seeds every offspring into its NEW shard, records the layout, then is a no-op", async () => {
  const storage = mockStorage();   // shared across all three phases — the persisted roster must survive the remap

  // ---- Phase 1: establish a persisted state under per = 2 (cap 8, 4 shards). This mirrors production
  // before the clamp fix: shardCount was pinned below the cap so two flies shared every isolate. ----
  const rec1: HatchRecorder = [];
  const envA = recordingShardEnv(4, rec1);
  const cfgA = loadConfig(envA);
  assert.equal(fliesPerShard(cfgA.maxLivePopulation, cfgA.shardCount), 2, "baseline layout is 2 flies/shard");

  const swarmA = await ShardedSwarm.load(cfgA, envA, asDO(storage));
  assert.deepEqual(swarmA.liveIds(), [0, 1, 2, 3], "genesis-only roster before any hatch");
  // Hatch two offspring into the growth slots. Under per=2 both map to shard floor(id/2) = 2.
  assert.equal(await swarmA.hatchLiveFly(4, genomeFor(901), asDO(storage)), true);
  assert.equal(await swarmA.hatchLiveFly(5, genomeFor(902), asDO(storage)), true);
  assert.deepEqual(rec1, [{ shard: 2, id: 4 }, { shard: 2, id: 5 }], "per=2: both offspring hatch into shard 2");
  assert.equal(shardOf(cfgA.maxLivePopulation, cfgA.shardCount, 4), 2, "id 4 → shard 2 under per=2");
  // The roster now holds both offspring; KEY_LAYOUT is still absent (hatchLiveFly never writes it, and the
  // phase-1 load had an empty `bred` so migrateLayoutIfNeeded returned before recording a baseline).
  assert.equal((storage._map.get(KEY_ROSTER) as unknown[]).length, 2, "both offspring persisted to KEY_ROSTER");
  assert.equal(storage._map.get(KEY_LAYOUT), undefined, "no layout recorded yet");

  // ---- Phase 2: reload under per = 1 (cap 8, 8 shards) — the clamp fix. The migration MUST fire and
  // re-ship each offspring to shardOf(8,8,id) = id (its own new isolate), NOT the old shared shard 2. ----
  const rec2: HatchRecorder = [];
  const envB = recordingShardEnv(8, rec2);
  const cfgB = loadConfig(envB);
  assert.equal(fliesPerShard(cfgB.maxLivePopulation, cfgB.shardCount), 1, "new layout is 1 fly/shard");

  const swarmB = await ShardedSwarm.load(cfgB, envB, asDO(storage));
  const routed = [...rec2].sort((a, b) => a.id - b.id);
  assert.deepEqual(
    routed,
    [{ shard: 4, id: 4 }, { shard: 5, id: 5 }],
    "per=1: each offspring re-seeded to its OWN new shard (id→shard identity), not the old shared shard",
  );
  assert.deepEqual(swarmB.liveIds(), [0, 1, 2, 3, 4, 5], "no offspring lost — both still live after the remap");
  assert.deepEqual(
    storage._map.get(KEY_LAYOUT),
    { per: 1, shardCount: 8, cap: 8 },
    "the new layout is recorded so the migration never re-runs",
  );

  // ---- Phase 3: reload again under the SAME per = 1. The stored layout matches, so the migration is a
  // no-op — a routine cold boot must NOT re-fan-out /hatch to every shard on every eviction. ----
  const rec3: HatchRecorder = [];
  const envC = recordingShardEnv(8, rec3);
  const cfgC = loadConfig(envC);
  const swarmC = await ShardedSwarm.load(cfgC, envC, asDO(storage));
  assert.deepEqual(rec3, [], "matching layout ⇒ no re-seed (idempotent, no per-boot churn)");
  assert.deepEqual(swarmC.liveIds(), [0, 1, 2, 3, 4, 5], "the live set is stable across the no-op reload");
});

test("layout migration: a first run with no offspring records nothing and re-seeds nothing", async () => {
  // A fresh install (or a swarm where every offspring has died) has an empty `bred`. The migration must be
  // inert: no /hatch fan-out, and NO layout recorded — so a later hatch (which always routes by the CURRENT
  // config) still lands correctly, and a genuine future per-change is still detected against a real baseline.
  const storage = mockStorage();
  const rec: HatchRecorder = [];
  const env = recordingShardEnv(8, rec);
  const cfg = loadConfig(env);

  const swarm = await ShardedSwarm.load(cfg, env, asDO(storage));
  assert.deepEqual(rec, [], "no offspring ⇒ no re-seed fan-out");
  assert.equal(storage._map.get(KEY_LAYOUT), undefined, "no baseline recorded when there is nothing to migrate");
  assert.deepEqual(swarm.liveIds(), [0, 1, 2, 3], "genesis roster intact");

  // A subsequent hatch under the same config routes by the live mapping (shardOf(8,8,4) = 4) with no layout
  // record needed — proving the empty-bred early return never strands a future offspring.
  assert.equal(await swarm.hatchLiveFly(4, genomeFor(777), asDO(storage)), true);
  assert.deepEqual(rec, [{ shard: 4, id: 4 }], "a later hatch still lands on the correct current shard");
});

test("layout migration: a PARTIAL re-seed is retried by the next persist() until every offspring lands (warm-DO ghost fix)", async () => {
  // The production bug this pins: a per-change re-seed where ONE offspring's /hatch transiently failed. load()
  // records KEY_LAYOUT only on a FULL re-seed, so its "retry next cold boot" never fires on a coordinator kept
  // warm by the frontend's per-second polling (it never evicts ⇒ load() never re-runs) — the un-landed offspring
  // would stay a GHOST forever. persist() runs on every committing cron WITH storage, so it must re-drive the
  // idempotent migration until it completes and records the layout.
  const storage = mockStorage();

  // ---- Phase 1: establish two offspring under per = 2 (cap 8, 4 shards). ----
  const rec1: HatchRecorder = [];
  const envA = recordingShardEnv(4, rec1);
  const swarmA = await ShardedSwarm.load(loadConfig(envA), envA, asDO(storage));
  assert.equal(await swarmA.hatchLiveFly(4, genomeFor(901), asDO(storage)), true);
  assert.equal(await swarmA.hatchLiveFly(5, genomeFor(902), asDO(storage)), true);
  assert.equal((storage._map.get(KEY_ROSTER) as unknown[]).length, 2, "both offspring persisted");

  // ---- Phase 2: reload under per = 1 with id 5's first /hatch failing. The migration must land id 4, fail
  // id 5, and therefore NOT record KEY_LAYOUT (so the retry stays armed). ----
  const rec2: HatchRecorder = [];
  const envB = flakyShardEnv(8, rec2, new Set([5]));
  const swarmB = await ShardedSwarm.load(loadConfig(envB), envB, asDO(storage));
  assert.deepEqual(
    [...rec2].sort((a, b) => a.id - b.id),
    [{ shard: 4, id: 4 }, { shard: 5, id: 5 }],
    "both offspring attempted into their NEW per=1 shards",
  );
  assert.equal(storage._map.get(KEY_LAYOUT), undefined, "partial re-seed ⇒ layout NOT recorded (retry stays armed)");
  assert.deepEqual(swarmB.liveIds(), [0, 1, 2, 3, 4, 5], "no offspring dropped from the roster by a failed re-seed");

  // ---- Phase 3: the next committing cron calls persist(). It must re-drive the migration; id 5's retry now
  // succeeds, so KEY_LAYOUT is finally recorded and the ghost is healed. ----
  await swarmB.persist(asDO(storage));
  assert.deepEqual(
    storage._map.get(KEY_LAYOUT),
    { per: 1, shardCount: 8, cap: 8 },
    "persist() retried the re-seed to completion and recorded the layout",
  );
  assert.ok(
    rec2.filter((r) => r.id === 5).length >= 2,
    "id 5 was re-shipped on the persist retry (first attempt failed, retry landed)",
  );

  // ---- Phase 4: once the layout is recorded, a further persist() is a no-op — no per-cron re-seed churn. ----
  const before = rec2.length;
  await swarmB.persist(asDO(storage));
  assert.equal(rec2.length, before, "layout recorded ⇒ persist() no longer re-fans-out /hatch (idempotent)");
});
