// P0.3 — Economy snapshot + deterministic replay (the measurement/replay bedrock for Phase 0).
//
// WHAT THIS IS
//   A PURE, reproducible replay of the agent economy's decision kernel. Given (a) one era-boundary
//   `economy.serialize()` blob and (b) that era's recorded market-temperature pulse stream, it re-runs the
//   SAME simulated settlement loop and re-derives the economic trajectory byte-for-byte. It is the harness
//   Phase 4 will use to prove "capability ④ (cross-generation improvement)" against a frozen baseline.
//
// DETERMINISM AUDIT (why byte-identical replay holds) — see economy.ts:
//   • The deal kernel uses ZERO Math.random. Every stochastic-looking decision is a deterministic FNV-1a
//     draw: `hash01(tickIndex, agentId, 0x9e3779b9)` gates buying; `hash32(tick, buyer, seller)` derives the
//     EIP-3009 nonce; `pseudoTxHash(...)` derives the simulated tx hash. All are pure functions of the tick.
//   • In SIMULATED mode the onchain-gated `Date.now()` sites never execute: `rollSpendDay`, the x402
//     `nowSec`/nonce broadcast, the settle-latency accumulators and the evolution nonce are all behind
//     `if (onchain)` / `flush()` / `payBreedingFee()`, none of which run in a simulated replay.
//   • The ONE wall-clock value that reaches stored state is `Settlement.ts = Date.now()` — pure METADATA. It
//     never feeds a price, a counterparty choice, a balance or a counter. We therefore EXCLUDE `ts` (and the
//     onchain latency accumulators) from the replayed trajectory projection. With `ts` excluded, every field
//     of the trajectory (good, resource, fromId, toId, amount, valid, reason, txHash, and all cumulative
//     counters/balances) is a deterministic function of the inputs ⇒ the replay is byte-identical run-to-run.
//
// REPLAY BOUNDARY (stated honestly):
//   This replays the ECONOMIC decision kernel, not the connectome. The neural read-outs each tick are
//   SYNTHESIZED deterministically from (seed, tickIndex, temperature) — a pure function — so the "temperature
//   pulse stream" genuinely drives the replayed market. It does NOT re-run the spiking brains (out of scope for
//   P0.3) and it does NOT re-run dynasty mortality (noteMortality is a separate cron step, not part of step()).
//   The guarantee equals a live trade's determinism: same blob + same temperature stream + same seed ⇒ the same
//   deals, the same balances, the same counters, byte-for-byte.
//
// This module is READ-ONLY: it never writes DO state, never moves funds, never touches manifestHash. The D1
// helpers only ever CREATE TABLE IF NOT EXISTS / INSERT OR REPLACE the archival `economy_snapshots` table.

import { AgentEconomy, type EconomyConfig, type Settlement } from "./economy.js";
import type { FlyReading, CollectiveState } from "./population.js";
import { atomicToUsdc } from "./x402.js";
import { canonical, sha256Hex } from "./provenance.js";

// ─────────────────────────────────────────────────────────────────────────────────────────────────────────
// Deterministic FNV-1a (same construction as economy/culture/evolution; PRIVATE replay salt so a synthesized
// draw can never alias another layer's stream). Replaces Math.random for the input synthesis below.
// ─────────────────────────────────────────────────────────────────────────────────────────────────────────

/** Private salt for the replay input-synthesis PRNG ("rpl"). Keeps the stream disjoint from economy/evolution. */
const REPLAY_SALT = 0x72706c;

function rHash32(a: number, b: number, c: number): number {
  let h = 0x811c9dc5;
  const mix = (x: number) => {
    for (let s = 0; s < 32; s += 8) { h = Math.imul(h ^ ((x >>> s) & 0xff), 0x01000193) >>> 0; }
  };
  mix(a >>> 0); mix(b >>> 0); mix(c >>> 0);
  return h >>> 0;
}
/** Uniform 0..1 draw from (a, b, salt) — reproducible without persisted RNG state. */
function rHash01(a: number, b: number, salt: number): number {
  return rHash32(a, b, salt) / 0xffffffff;
}
const clamp01 = (x: number): number => (x < 0 ? 0 : x > 1 ? 1 : x);

/** Temperature-band thresholds — mirror the codebase's regime defaults (COLD ≤ 0.33, HOT ≥ 0.66). */
export const BAND_COLD_MAX = 0.33;
export const BAND_HOT_MIN = 0.66;
export type TempBand = "COLD" | "CALM" | "HOT";
export function tempBand(temperature: number): TempBand {
  return temperature >= BAND_HOT_MIN ? "HOT" : temperature <= BAND_COLD_MAX ? "COLD" : "CALM";
}

// ─────────────────────────────────────────────────────────────────────────────────────────────────────────
// Deterministic input synthesis — a PURE function of (seed, tick, temperature, ids).
// ─────────────────────────────────────────────────────────────────────────────────────────────────────────

const STATES: FlyReading["state"][] = ["REST", "AGGREGATE", "EXPLORE", "AGITATE"];

/**
 * Synthesize one tick's neural read-outs deterministically from the temperature pulse. The market temperature
 * biases the swarm toward agitation/exploration when HOT and toward rest/huddling when COLD, with a stable
 * per-(seed, tick, id) jitter so the population is heterogeneous but fully reproducible. Only `state`,
 * `arousal`, `cohesion` and `wingbeat` feed the economic kernel (buyProbability / pickCounterparty /
 * goodForState); the remaining fields are filled deterministically to satisfy the FlyReading shape.
 */
export function synthReadings(ids: number[], tick: number, temperature: number, seed: number): FlyReading[] {
  const T = clamp01(temperature);
  return ids.map((id) => {
    const draw = (n: number): number => rHash01((seed ^ (tick * 0x9e3779b9)) >>> 0, (id * 31 + n) >>> 0, REPLAY_SALT);
    // A temperature-driven activation with stable per-fly personality jitter.
    const drive = clamp01(0.3 + 0.6 * T + 0.25 * (draw(1) - 0.5));
    const state = STATES[Math.min(STATES.length - 1, Math.floor(drive * STATES.length))];
    return {
      id,
      state,
      arousal: clamp01(0.25 + 0.6 * T + 0.25 * (draw(2) - 0.5)),
      turnBias: draw(3) * 2 - 1,
      cohesion: clamp01(0.25 + 0.4 * draw(4) + 0.3 * (1 - T)),
      wingbeat: clamp01(0.25 + 0.55 * T + 0.2 * draw(5)),
      rest: clamp01(0.5 * (1 - T) + 0.2 * draw(6)),
      temperament: draw(7),
      fingerprint: `rpl${id}`,
      fap: "FORAGE",
      valence: draw(8) * 2 - 1,
      heading: draw(9) * Math.PI * 2,
      role: "signal-seeker",
      bouts: [],
      neuromod: { dopamine: 0, octopamine: 0, learningRateGate: 0, daHz: 0, oaHz: 0 },
    };
  });
}

/** Deterministic collective mood for one replayed tick (a pure function of temperature + roster size). */
export function synthCollective(temperature: number, size: number): CollectiveState {
  const T = clamp01(temperature);
  return {
    temperature: T,
    regime: tempBand(T),
    vitality: T,
    size,
    arousal: clamp01(0.3 + 0.5 * T),
    cohesion: 0.5,
    rest: clamp01(0.4 * (1 - T)),
    wingbeat: clamp01(0.3 + 0.4 * T),
    states: { AGITATE: 0, EXPLORE: 0, AGGREGATE: 0, REST: 0 },
    faps: {},
    valence: 0,
    meanDopamine: 0,
    meanOctopamine: 0,
    meanDaHz: 0,
    meanOaHz: 0,
  };
}

// ─────────────────────────────────────────────────────────────────────────────────────────────────────────
// The replay engine.
// ─────────────────────────────────────────────────────────────────────────────────────────────────────────

/** One deal, projected to its DETERMINISTIC fields only (the wall-clock `ts` metadata is excluded on purpose). */
export interface ReplayDeal {
  good: string;
  resource: string;
  fromId: number;
  toId: number;
  amount: string;   // atomic USDC
  valid: boolean;
  reason: string | null;
  txHash: string;   // deterministic pseudo hash in simulated mode
}

/** One replayed tick: the temperature felt, the deals cleared, and the cumulative counters afterwards. */
export interface ReplayTick {
  tick: number;
  temperature: number;
  band: TempBand;
  deals: ReplayDeal[];
  volumeAtomic: string;
  count: number;
  settleOk: number;
  settleFail: number;
}

/** The deterministic terminal state of a replay (per-agent ledger + cumulative totals). */
export interface ReplayFinalState {
  tickIndex: number;
  volumeAtomic: string;
  volumeUsdc: number;
  count: number;
  settleOk: number;
  settleFail: number;
  gini: number;
  agents: { id: number; balance: string; paid: string; earned: string; deals: number; sales: number }[];
}

export interface ReplayOptions {
  /** Deterministic PRNG seed for the synthesized read-outs (default 0x5EED). Same seed ⇒ same trajectory. */
  seed?: number;
  /** Per-tick deal budget override (default 24, matching the production cron's shared budget). */
  budget?: number;
  /** Safety cap on how many temperature pulses to consume (default 4096). */
  maxTicks?: number;
  /** Optional partial config override (the base is always a simulated, real-spend-OFF economy). */
  cfg?: Partial<EconomyConfig>;
}

export interface ReplayResult {
  seed: number;
  budget: number;
  startTick: number;
  tickCount: number;
  ticks: ReplayTick[];
  finalState: ReplayFinalState;
  /** sha256(canonical({seed, ticks, finalState})) — identical across runs for identical inputs. */
  replayHash: string;
  /** The honest replay boundary, served verbatim so a consumer knows exactly what was reproduced. */
  boundary: string;
}

const REPLAY_BOUNDARY =
  "Replays the ECONOMIC decision kernel only: neural read-outs are synthesized deterministically from " +
  "(seed, tick, temperature) and the connectome is NOT re-run; dynasty mortality (noteMortality) is a separate " +
  "cron step and is NOT replayed. The wall-clock Settlement.ts metadata and onchain latency accumulators are " +
  "EXCLUDED (they never feed a decision). Same blob + same temperature stream + same seed ⇒ byte-identical trajectory.";

/** The fixed simulated config a replay runs under (real spend OFF; all optional layers inert ⇒ plain market). */
export function replayConfig(over: Partial<EconomyConfig> = {}): EconomyConfig {
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

/** Project a Settlement to its deterministic fields (drops the wall-clock `ts`). */
function projectDeal(s: Settlement): ReplayDeal {
  return {
    good: s.good,
    resource: s.resource,
    fromId: s.fromId,
    toId: s.toId,
    amount: s.amount,
    valid: s.valid,
    reason: s.reason ?? null,
    txHash: s.txHash,
  };
}

/**
 * Replay the economy from a serialized blob along a temperature pulse stream. PURE + reproducible: the only
 * inputs are (blob, temperatures, opts). Returns the per-tick trajectory, the deterministic terminal state and
 * a `replayHash` that is identical across runs for identical inputs (the byte-identity anchor).
 */
export async function replayEconomy(blob: string, temperatures: number[], opts: ReplayOptions = {}): Promise<ReplayResult> {
  const seed = (opts.seed ?? 0x5eed) >>> 0;
  const budget = Math.max(1, Math.floor(opts.budget ?? 24));
  const maxTicks = Math.max(1, Math.floor(opts.maxTicks ?? 4096));
  const cfg = replayConfig(opts.cfg);

  // Reconstruct the starting state from the blob (the constructor's `restored` arg runs applySerialized).
  const econ = new AgentEconomy(cfg, blob);

  // The agent roster to synthesize read-outs for: exactly the ids in the blob (dead ones are skipped inside
  // step()). Fall back to the genesis cohort when the blob carries no agents (a fresh/empty snapshot).
  let ids: number[] = [];
  try {
    const parsed = JSON.parse(blob);
    if (Array.isArray(parsed?.agents)) ids = parsed.agents.map((a: any) => Number(a.id)).filter((n: number) => Number.isFinite(n));
  } catch { /* an unparseable blob simply yields the genesis cohort below */ }
  if (!ids.length) ids = Array.from({ length: cfg.populationSize }, (_, i) => i);

  let startTick = 0;
  try { startTick = Number(JSON.parse(blob)?.tickIndex ?? 0) || 0; } catch { startTick = 0; }

  const temps = temperatures.slice(0, maxTicks);
  const ticks: ReplayTick[] = [];
  for (let i = 0; i < temps.length; i++) {
    const tick = startTick + i + 1;
    const temperature = clamp01(Number(temps[i]) || 0);
    const readings = synthReadings(ids, tick, temperature, seed);
    const collective = synthCollective(temperature, ids.length);
    const made = await econ.step(readings, collective, tick, budget);
    const totals = econ.snapshot().totals;
    ticks.push({
      tick,
      temperature,
      band: tempBand(temperature),
      deals: made.map(projectDeal),
      volumeAtomic: totals.volumeAtomic,
      count: totals.count,
      settleOk: totals.settleOk,
      settleFail: totals.settleFail,
    });
  }

  const snap = econ.snapshot();
  const finalState: ReplayFinalState = {
    tickIndex: snap.tickIndex,
    volumeAtomic: snap.totals.volumeAtomic,
    volumeUsdc: snap.totals.volumeUsdc,
    count: snap.totals.count,
    settleOk: snap.totals.settleOk,
    settleFail: snap.totals.settleFail,
    gini: snap.totals.gini,
    agents: snap.agents.map((a) => ({
      id: a.id, balance: a.balance, paid: a.paid, earned: a.earned, deals: a.deals, sales: a.sales,
    })),
  };

  const replayHash = await sha256Hex(canonical({ seed, budget, startTick, ticks, finalState }));
  return { seed, budget, startTick, tickCount: ticks.length, ticks, finalState, replayHash, boundary: REPLAY_BOUNDARY };
}

// ─────────────────────────────────────────────────────────────────────────────────────────────────────────
// D1 archival: the `economy_snapshots` table (one row per closed era).
// ─────────────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * The canonical D1 DDL for the economy-snapshot archive. Mirrored in packages/trader-worker/schema.sql and
 * created lazily (CREATE TABLE IF NOT EXISTS) before the first write, exactly like the `ticks` table.
 *   era       — the era that CLOSED (PRIMARY KEY: one snapshot per era; INSERT OR REPLACE is idempotent)
 *   tick      — population tickIndex at the era boundary
 *   ts        — wall-clock ms of archival (METADATA ONLY; never an input to the replay)
 *   blob      — economy.serialize() captured at the era's OPEN (the replay seed state)
 *   blob_hash — sha256(blob), tamper-evidence for the seed state
 *   temps     — JSON number[] of the per-cron market temperatures recorded DURING the era (the pulse stream)
 */
export const ECONOMY_SNAPSHOTS_DDL =
  `CREATE TABLE IF NOT EXISTS economy_snapshots (` +
  ` era INTEGER PRIMARY KEY, tick INTEGER NOT NULL, ts INTEGER NOT NULL,` +
  ` blob TEXT NOT NULL, blob_hash TEXT NOT NULL, temps TEXT NOT NULL )`;
export const ECONOMY_SNAPSHOTS_INDEX_DDL =
  `CREATE INDEX IF NOT EXISTS idx_economy_snapshots_tick ON economy_snapshots (tick)`;

/** One archived era snapshot (the row shape served to the replay engine). */
export interface EconomySnapshotRow {
  era: number;
  tick: number;
  ts: number;
  blob: string;
  blobHash: string;
  temps: number[];
}

/** Idempotent belt-and-braces DDL so a read/write landing before any cron still finds the table. */
export async function ensureEconomySnapshotsSchema(db: D1Database): Promise<void> {
  await db.prepare(ECONOMY_SNAPSHOTS_DDL).run();
  await db.prepare(ECONOMY_SNAPSHOTS_INDEX_DDL).run();
}

/** INSERT OR REPLACE one era snapshot. Best-effort by contract — the caller swallows/logs any throw. */
export async function writeEconomySnapshot(
  db: D1Database,
  row: { era: number; tick: number; blob: string; temps: number[] },
): Promise<void> {
  await ensureEconomySnapshotsSchema(db);
  const blobHash = await sha256Hex(row.blob);
  await db
    .prepare(
      `INSERT OR REPLACE INTO economy_snapshots (era, tick, ts, blob, blob_hash, temps) VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .bind(row.era, row.tick, Date.now(), row.blob, blobHash, JSON.stringify(row.temps))
    .run();
}

function parseSnapshotRow(r: any): EconomySnapshotRow {
  let temps: number[] = [];
  try {
    const parsed = JSON.parse(r?.temps ?? "[]");
    if (Array.isArray(parsed)) temps = parsed.map((x: unknown) => Number(x)).filter((n: number) => Number.isFinite(n));
  } catch { temps = []; }
  return {
    era: Number(r?.era ?? 0),
    tick: Number(r?.tick ?? 0),
    ts: Number(r?.ts ?? 0),
    blob: String(r?.blob ?? ""),
    blobHash: String(r?.blob_hash ?? ""),
    temps,
  };
}

/** Read the archived snapshots for eras in [fromEra, toEra] (inclusive), oldest era first. */
export async function readEconomySnapshots(db: D1Database, fromEra: number, toEra: number): Promise<EconomySnapshotRow[]> {
  await ensureEconomySnapshotsSchema(db);
  const page = await db
    .prepare(`SELECT era, tick, ts, blob, blob_hash, temps FROM economy_snapshots WHERE era >= ? AND era <= ? ORDER BY era ASC`)
    .bind(fromEra, toEra)
    .all();
  return (page.results ?? []).map(parseSnapshotRow);
}

/** The newest archived era (or null when the table is empty) — the default replay target. */
export async function latestSnapshotEra(db: D1Database): Promise<number | null> {
  await ensureEconomySnapshotsSchema(db);
  const agg = await db.prepare(`SELECT MAX(era) AS maxEra, MIN(era) AS minEra, COUNT(*) AS n FROM economy_snapshots`).all();
  const a: any = (agg.results ?? [])[0] ?? {};
  return a.maxEra == null ? null : Number(a.maxEra);
}

// ─────────────────────────────────────────────────────────────────────────────────────────────────────────
// Worker-side HTTP handler for GET /replay/economy (served straight from D1, never a DO round-trip — the same
// orthogonal-read pattern as /history, so it can't contend for the swarm DO's single input gate).
// ─────────────────────────────────────────────────────────────────────────────────────────────────────────

function json(obj: unknown, status = 200): Response {
  return new Response(JSON.stringify(obj), { status, headers: { "Content-Type": "application/json" } });
}

/**
 * GET /replay/economy?fromEra=&toEra=&seed=
 *   fromEra / toEra — the inclusive era window to replay (default: the latest archived era only).
 *   seed            — optional deterministic PRNG seed for the synthesized read-outs (default 0x5EED).
 * READ-ONLY. Replays each era's blob along its recorded temperature pulse stream and returns the per-era
 * replayHash + trajectory summary. `combinedHash` chains the per-era hashes so a consumer can pin the whole
 * window with one digest. NEVER throws: a missing D1 binding or any error degrades to an honest payload.
 */
export async function serveReplayEconomy(db: D1Database | undefined, url: URL): Promise<Response> {
  if (!db) return json({ enabled: false, eras: [], note: "D1 not bound" });
  try {
    const seedRaw = url.searchParams.get("seed");
    const seed = seedRaw != null && Number.isFinite(Number(seedRaw)) ? Number(seedRaw) >>> 0 : 0x5eed;
    const latest = await latestSnapshotEra(db);
    if (latest == null) {
      return json({ enabled: true, seed, fromEra: null, toEra: null, eras: [], combinedHash: null, note: "no era snapshots archived yet" });
    }
    const fromRaw = url.searchParams.get("fromEra");
    const toRaw = url.searchParams.get("toEra");
    const fromEra = fromRaw != null && Number.isFinite(Number(fromRaw)) ? Number(fromRaw) : latest;
    const toEra = toRaw != null && Number.isFinite(Number(toRaw)) ? Number(toRaw) : latest;
    const lo = Math.min(fromEra, toEra);
    const hi = Math.max(fromEra, toEra);

    const rows = await readEconomySnapshots(db, lo, hi);
    const eras: { era: number; tick: number; blobHash: string; seedPulses: number; replayHash: string; tickCount: number; finalState: ReplayFinalState }[] = [];
    for (const row of rows) {
      const r = await replayEconomy(row.blob, row.temps, { seed });
      eras.push({
        era: row.era,
        tick: row.tick,
        blobHash: row.blobHash,
        seedPulses: row.temps.length,
        replayHash: r.replayHash,
        tickCount: r.tickCount,
        finalState: r.finalState,
      });
    }
    // Chain the per-era hashes so one digest pins the whole replayed window (order-stable: eras ascend).
    const combinedHash = eras.length ? await sha256Hex(canonical(eras.map((e) => e.replayHash))) : null;
    return json({ enabled: true, seed, fromEra: lo, toEra: hi, count: eras.length, eras, combinedHash, boundary: REPLAY_BOUNDARY });
  } catch (e) {
    return json({ enabled: true, error: (e as Error).message, eras: [], combinedHash: null }, 500);
  }
}
