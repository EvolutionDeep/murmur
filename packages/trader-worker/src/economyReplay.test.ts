// P0.3 — economy replay tests: the BYTE-IDENTICAL guarantee + additive snapshot compatibility.
//
// The core contract this pins: replayEconomy(blob, temps, opts) is a PURE function of its inputs — the same
// (blob, temperature stream, seed) reproduces the exact same trajectory and the exact same replayHash, run
// after run, with no wall-clock and no RNG leaking in. It also proves the archived blob stays additive (an
// OLD payload missing social/dynasty/market/latency fields still restores + replays) and that the D1 helpers
// round-trip a snapshot faithfully.

import test from "node:test";
import assert from "node:assert/strict";

import { AgentEconomy } from "./economy.js";
import {
  replayEconomy,
  replayConfig,
  synthReadings,
  synthCollective,
  tempBand,
  writeEconomySnapshot,
  readEconomySnapshots,
  latestSnapshotEra,
  serveReplayEconomy,
} from "./economyReplay.js";

// ─────────────────────────────────────────────────────────────────────────────────────────────────────────
// A minimal in-memory stand-in for the D1 binding: it understands exactly the economy_snapshots statements
// the helpers issue (CREATE …, INSERT OR REPLACE …, the range SELECT and the MAX(era) aggregate) and stores
// rows by era. Enough to exercise write → read → latestEra and the HTTP handler without miniflare.
// ─────────────────────────────────────────────────────────────────────────────────────────────────────────
function makeFakeD1() {
  const store = new Map<number, any>();
  const db = {
    prepare(sql: string) {
      let args: any[] = [];
      const stmt = {
        bind(...a: any[]) { args = a; return stmt; },
        async run() {
          if (sql.includes("INSERT OR REPLACE INTO economy_snapshots")) {
            const [era, tick, ts, blob, blobHash, temps] = args;
            store.set(Number(era), { era, tick, ts, blob, blob_hash: blobHash, temps });
          }
          return { success: true };
        },
        async all() {
          if (sql.includes("MAX(era)")) {
            const eras = [...store.keys()];
            return {
              results: [{
                maxEra: eras.length ? Math.max(...eras) : null,
                minEra: eras.length ? Math.min(...eras) : null,
                n: eras.length,
              }],
            };
          }
          if (sql.includes("SELECT era") && sql.includes("WHERE era")) {
            const [from, to] = args;
            const results = [...store.values()]
              .filter((r) => Number(r.era) >= Number(from) && Number(r.era) <= Number(to))
              .sort((a, b) => Number(a.era) - Number(b.era));
            return { results };
          }
          return { results: [] };
        },
      };
      return stmt;
    },
    __store: store,
  };
  return db as unknown as D1Database & { __store: Map<number, any> };
}

/** Drive a small simulated economy for a few ticks so the blob carries real agent + social state. */
async function makeBlob(ticks: number, temps: number[], pop = 12): Promise<string> {
  const econ = new AgentEconomy(replayConfig({ populationSize: pop }));
  const ids = Array.from({ length: pop }, (_, i) => i);
  for (let i = 0; i < ticks; i++) {
    const t = temps[i % temps.length];
    await econ.step(synthReadings(ids, i + 1, t, 0xabc), synthCollective(t, ids.length), i + 1, 24);
  }
  return econ.serialize();
}

// A temperature stream that keeps the market HOT so deals actually clear (exercises the deal projection).
const HOT_STREAM = [0.9, 0.85, 0.8, 0.95, 0.7, 0.88];

test("synthReadings / synthCollective are deterministic pure functions of (ids, tick, temperature, seed)", () => {
  const ids = [0, 1, 2, 3, 4];
  const a = JSON.stringify(synthReadings(ids, 7, 0.8, 0x5eed));
  const b = JSON.stringify(synthReadings(ids, 7, 0.8, 0x5eed));
  assert.equal(a, b);
  // A different seed yields a different (but still valid) read-out set.
  const c = JSON.stringify(synthReadings(ids, 7, 0.8, 0x1234));
  assert.notEqual(a, c);
  assert.equal(JSON.stringify(synthCollective(0.8, 5)), JSON.stringify(synthCollective(0.8, 5)));
});

test("tempBand matches the regime thresholds (COLD ≤ 0.33, HOT ≥ 0.66)", () => {
  assert.equal(tempBand(0.0), "COLD");
  assert.equal(tempBand(0.33), "COLD");
  assert.equal(tempBand(0.34), "CALM");
  assert.equal(tempBand(0.65), "CALM");
  assert.equal(tempBand(0.66), "HOT");
  assert.equal(tempBand(1.0), "HOT");
});

test("replayEconomy is byte-identical run-to-run for the same (blob, temps, seed)", async () => {
  const blob = await makeBlob(8, HOT_STREAM);
  const r1 = await replayEconomy(blob, HOT_STREAM, { seed: 0x5eed });
  const r2 = await replayEconomy(blob, HOT_STREAM, { seed: 0x5eed });

  assert.equal(r1.replayHash, r2.replayHash, "the replayHash must be identical across runs");
  assert.equal(JSON.stringify(r1.ticks), JSON.stringify(r2.ticks), "the per-tick trajectory must be byte-identical");
  assert.equal(JSON.stringify(r1.finalState), JSON.stringify(r2.finalState), "the terminal ledger must be byte-identical");
  assert.equal(r1.tickCount, HOT_STREAM.length);
  assert.match(r1.replayHash, /^[0-9a-f]{64}$/);

  // The wall-clock `ts` metadata is EXCLUDED from every projected deal (the determinism boundary).
  for (const t of r1.ticks) for (const d of t.deals) assert.equal((d as any).ts, undefined);
});

test("replayEconomy actually clears deals on a HOT stream (the trajectory is non-trivial)", async () => {
  const blob = await makeBlob(8, HOT_STREAM);
  const r = await replayEconomy(blob, HOT_STREAM, { seed: 0x5eed });
  const totalDeals = r.ticks.reduce((n, t) => n + t.deals.length, 0);
  assert.ok(totalDeals > 0, "a HOT stream over a funded roster should clear at least one deal");
  assert.ok(r.finalState.count > 0);
});

test("the seed is a genuine replay input: a different seed ⇒ a different replayHash", async () => {
  const blob = await makeBlob(8, HOT_STREAM);
  const a = await replayEconomy(blob, HOT_STREAM, { seed: 0x5eed });
  const b = await replayEconomy(blob, HOT_STREAM, { seed: 0x1234 });
  // `seed` is folded into the replayHash preimage, so this holds even if two trajectories happened to coincide.
  assert.notEqual(a.replayHash, b.replayHash);
});

test("a different temperature stream drives a different economic trajectory", async () => {
  const blob = await makeBlob(8, HOT_STREAM);
  const hot = await replayEconomy(blob, [0.95, 0.9, 0.92], { seed: 0x5eed });
  const cold = await replayEconomy(blob, [0.02, 0.05, 0.03], { seed: 0x5eed });
  const hotDeals = hot.ticks.reduce((n, t) => n + t.deals.length, 0);
  const coldDeals = cold.ticks.reduce((n, t) => n + t.deals.length, 0);
  assert.notEqual(hot.replayHash, cold.replayHash);
  assert.ok(hotDeals > coldDeals, "a COLD stream suppresses demand, so it clears fewer deals than a HOT one");
});

test("an OLD additive blob (missing social/dynasty/market/latency fields) still restores + replays", async () => {
  const blob = await makeBlob(8, HOT_STREAM);
  const stripped: any = JSON.parse(blob);
  // Remove every ADDITIVE layer to simulate a pre-social / pre-dynasty / pre-institutions payload. KEY_VERSION
  // is untouched, so applySerialized must default the missing fields rather than discard the ledger.
  delete stripped.social;
  delete stripped.dynasty;
  delete stripped.market;
  delete stripped.zoneControl;
  delete stripped.settleMsSum;
  delete stripped.settleMsN;
  delete stripped.warTaxAtomic;
  delete stripped.pendingNets;
  delete stripped.proofs;
  delete stripped.proofChainHead;
  const oldBlob = JSON.stringify(stripped);

  const r1 = await replayEconomy(oldBlob, HOT_STREAM, { seed: 0x5eed });
  const r2 = await replayEconomy(oldBlob, HOT_STREAM, { seed: 0x5eed });
  assert.equal(r1.tickCount, HOT_STREAM.length);
  assert.match(r1.replayHash, /^[0-9a-f]{64}$/);
  assert.equal(r1.replayHash, r2.replayHash, "the stripped blob replays byte-identically too");
  // The agents survived the restore (the ledger was NOT discarded by a version mismatch).
  assert.ok(r1.finalState.agents.length > 0);
});

test("an unknown future field on the blob is ignored (forward-compatible additive restore)", async () => {
  const blob = await makeBlob(6, HOT_STREAM);
  const weird: any = JSON.parse(blob);
  weird.someFutureLayer = { anything: [1, 2, 3] };
  const r = await replayEconomy(JSON.stringify(weird), HOT_STREAM, { seed: 0x5eed });
  assert.equal(r.tickCount, HOT_STREAM.length);
  assert.match(r.replayHash, /^[0-9a-f]{64}$/);
});

test("a garbage / empty blob degrades to the genesis cohort instead of throwing", async () => {
  const r = await replayEconomy("{}", [0.5, 0.6], { seed: 1 });
  assert.equal(r.tickCount, 2);
  assert.equal(r.startTick, 0);
  assert.match(r.replayHash, /^[0-9a-f]{64}$/);
});

test("the D1 helpers round-trip a snapshot faithfully (write → read → latestEra)", async () => {
  const db = makeFakeD1();
  const blob = await makeBlob(4, HOT_STREAM);
  const temps = [0.1, 0.5, 0.9];
  await writeEconomySnapshot(db, { era: 3, tick: 100, blob, temps });

  const rows = await readEconomySnapshots(db, 1, 5);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].era, 3);
  assert.equal(rows[0].tick, 100);
  assert.equal(rows[0].blob, blob);
  assert.deepEqual(rows[0].temps, temps);
  assert.match(rows[0].blobHash, /^[0-9a-f]{64}$/);
  assert.equal(await latestSnapshotEra(db), 3);

  // A range that excludes the era returns nothing (the WHERE clause is honoured).
  assert.equal((await readEconomySnapshots(db, 10, 20)).length, 0);
});

test("readEconomySnapshots defaults a malformed row's temps to [] (additive parse)", async () => {
  const db = makeFakeD1();
  // Inject a raw row with a null temps column straight into the store (simulating an older/corrupt write).
  db.__store.set(9, { era: 9, tick: 0, ts: 0, blob: "{}", blob_hash: "", temps: null });
  const rows = await readEconomySnapshots(db, 9, 9);
  assert.equal(rows.length, 1);
  assert.deepEqual(rows[0].temps, []);
});

test("serveReplayEconomy replays the archive byte-identically and degrades honestly without D1", async () => {
  // No D1 binding ⇒ an honest disabled payload (never a throw).
  const off = await serveReplayEconomy(undefined, new URL("https://x/replay/economy"));
  const offBody: any = await off.json();
  assert.equal(offBody.enabled, false);

  const db = makeFakeD1();
  const empty = await serveReplayEconomy(db, new URL("https://x/replay/economy"));
  const emptyBody: any = await empty.json();
  assert.equal(emptyBody.enabled, true);
  assert.deepEqual(emptyBody.eras, []);
  assert.equal(emptyBody.combinedHash, null);

  const blob = await makeBlob(6, HOT_STREAM);
  await writeEconomySnapshot(db, { era: 1, tick: 50, blob, temps: HOT_STREAM });

  const url = new URL("https://x/replay/economy?fromEra=1&toEra=1");
  const a: any = await (await serveReplayEconomy(db, url)).json();
  const b: any = await (await serveReplayEconomy(db, url)).json();
  assert.equal(a.enabled, true);
  assert.equal(a.count, 1);
  assert.equal(a.eras[0].era, 1);
  assert.equal(a.eras[0].seedPulses, HOT_STREAM.length);
  assert.match(a.eras[0].replayHash, /^[0-9a-f]{64}$/);
  // The endpoint is reproducible: two calls over the same archive yield the same per-era + combined digests.
  assert.equal(a.eras[0].replayHash, b.eras[0].replayHash);
  assert.equal(a.combinedHash, b.combinedHash);
  assert.match(a.combinedHash, /^[0-9a-f]{64}$/);
  assert.equal(typeof a.boundary, "string");
});
