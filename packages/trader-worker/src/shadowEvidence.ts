// Shadow-compare evidence layer (task #87) — D1 archival of shadow decision rows.
//
// PURE READ-OUT: changes no brain, wallet, digest or manifestHash. Written best-effort from
// FlyStateDO.cronInner() via ctx.waitUntil (off the cron await path); a D1 failure never blocks the
// tick. Evidence lives ONLY here (D1), NEVER in the DO blob (which is already 1.54 MB in production).
//
// Schema mirrors economy_snapshots / lexicon_events: append-only, idempotent CREATE TABLE IF NOT EXISTS,
// lazily ensured before the first insert. Served at GET /shadow from the Worker's index.ts (never a DO
// round-trip — same orthogonal-read pattern as /history and /replay/economy).

import type { ShadowDecision } from "./economy.js";

// ─── Retention ─────────────────────────────────────────────────────────────────────────────────────────
// #125: shadow_decisions is append-only (~42.7k rows/day at production volume).  Keep the most recent
// SHADOW_RETENTION_ROWS rows (default 500k ≈ ~12 days at current volume).  Older rows are GC'd best-effort
// from the cron path (gcShadowDecisions).  D1 DELETE with a sub-select is bounded by the inner LIMIT.
export const SHADOW_RETENTION_ROWS = 500_000;

/**
 * Delete the oldest rows beyond the retention cap.  Best-effort — the caller (cron) should wrap in
 * try/catch so a D1 hiccup never blocks the tick.  Safe to call every cron: when the table is under
 * the cap the inner SELECT returns zero ids and the DELETE is a no-op.
 */
export async function gcShadowDecisions(db: D1Database, retentionRows: number = SHADOW_RETENTION_ROWS): Promise<number> {
  // Find the id threshold: the row at position (total - retentionRows) from the top.
  // Rows with id < threshold are deleted.  The two-step approach (SELECT then DELETE) avoids a
  // correlated sub-query that D1's SQLite may struggle with at scale.
  const countRes = await db.prepare("SELECT COUNT(*) AS n FROM shadow_decisions").all();
  const total = Number((countRes.results ?? [])[0]?.n ?? 0);
  if (total <= retentionRows) return 0;
  const deleteCount = total - retentionRows;
  // Find the highest id to delete: the (deleteCount)-th row from the oldest end.
  const thresholdRes = await db
    .prepare("SELECT id FROM shadow_decisions ORDER BY id ASC LIMIT 1 OFFSET ?")
    .bind(deleteCount - 1)
    .all();
  const thresholdId = Number((thresholdRes.results ?? [])[0]?.id ?? 0);
  if (thresholdId <= 0) return 0;
  await db.prepare("DELETE FROM shadow_decisions WHERE id < ?").bind(thresholdId).run();
  return deleteCount;
}

// ─── DDL ────────────────────────────────────────────────────────────────────────────────────────────────

export const SHADOW_DECISIONS_DDL = `CREATE TABLE IF NOT EXISTS shadow_decisions (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  ts              INTEGER NOT NULL,
  tick            INTEGER NOT NULL,
  cron            INTEGER NOT NULL,
  buyer_id        INTEGER NOT NULL,
  seller_id_base  INTEGER NOT NULL,
  seller_id_evo   INTEGER NOT NULL,
  good_base       TEXT    NOT NULL,
  good_evo        TEXT    NOT NULL,
  want_base       REAL    NOT NULL,
  want_evo        REAL    NOT NULL,
  amount_base     TEXT    NOT NULL,
  amount_evo      TEXT    NOT NULL,
  amount_evo_cap  TEXT    NOT NULL,
  cap_reason      TEXT    NOT NULL DEFAULT '',
  tree_hash       TEXT    NOT NULL DEFAULT '',
  pb_confidence   REAL    NOT NULL DEFAULT 0.5,
  pb_amplifier    REAL    NOT NULL DEFAULT 0.75,
  pb_explore      INTEGER NOT NULL DEFAULT 0,
  regime          TEXT    NOT NULL DEFAULT 'CALM',
  temp_bucket     INTEGER NOT NULL DEFAULT 2
)`;

export const SHADOW_DECISIONS_INDEX_DDL =
  `CREATE INDEX IF NOT EXISTS idx_shadow_decisions_tick ON shadow_decisions (tick)`;
export const SHADOW_DECISIONS_TS_INDEX_DDL =
  `CREATE INDEX IF NOT EXISTS idx_shadow_decisions_ts ON shadow_decisions (ts)`;

/** Idempotent belt-and-braces DDL so a read/write landing before any cron still finds the table. */
export async function ensureShadowSchema(db: D1Database): Promise<void> {
  await db.prepare(SHADOW_DECISIONS_DDL).run();
  await db.prepare(SHADOW_DECISIONS_INDEX_DDL).run();
  await db.prepare(SHADOW_DECISIONS_TS_INDEX_DDL).run();
}

/**
 * INSERT shadow decision rows. Best-effort by contract — the caller swallows/logs any throw.
 * Bounded: the caller enforces maxRowsPerCronToD1 before calling this.
 */
export async function writeShadowRows(db: D1Database, rows: ShadowDecision[]): Promise<void> {
  if (!rows.length) return;
  await ensureShadowSchema(db);
  const stmt = db.prepare(
    `INSERT INTO shadow_decisions (ts, tick, cron, buyer_id, seller_id_base, seller_id_evo,
      good_base, good_evo, want_base, want_evo, amount_base, amount_evo, amount_evo_cap,
      cap_reason, tree_hash, pb_confidence, pb_amplifier, pb_explore, regime, temp_bucket)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const batch = rows.map((r) =>
    stmt.bind(
      r.ts, r.tick, r.cron, r.buyerId, r.sellerIdBase, r.sellerIdEvo,
      r.goodBase, r.goodEvo, r.wantBase, r.wantEvo,
      r.amountBaseAtomic, r.amountEvoAtomic, r.amountEvoAfterCapAtomic,
      r.capReason, r.treeHash, r.pbConfidence, r.pbAmplifier,
      r.pbExplore ? 1 : 0, r.regime, r.tempBucket,
    ),
  );
  await db.batch(batch);
}

/** Read the most recent shadow decisions (paginated, newest first). For GET /shadow. */
export async function readShadowDecisions(
  db: D1Database,
  opts: { limit?: number; offset?: number; fromTick?: number; toTick?: number } = {},
): Promise<{ rows: any[]; total: number }> {
  await ensureShadowSchema(db);
  const limit = Math.min(500, Math.max(1, opts.limit ?? 100));
  const offset = Math.max(0, opts.offset ?? 0);
  let where = "";
  const params: any[] = [];
  if (opts.fromTick != null) { where += " AND tick >= ?"; params.push(opts.fromTick); }
  if (opts.toTick != null) { where += " AND tick <= ?"; params.push(opts.toTick); }
  const whereClause = where ? `WHERE 1=1${where}` : "";
  const countRes = await db.prepare(`SELECT COUNT(*) AS n FROM shadow_decisions ${whereClause}`).bind(...params).all();
  const total = Number((countRes.results ?? [])[0]?.n ?? 0);
  const page = await db
    .prepare(`SELECT * FROM shadow_decisions ${whereClause} ORDER BY id DESC LIMIT ? OFFSET ?`)
    .bind(...params, limit, offset)
    .all();
  return { rows: page.results ?? [], total };
}

// ─── Worker-side HTTP handler for GET /shadow ───────────────────────────────────────────────────────────
// Served straight from D1, never a DO round-trip — the same orthogonal-read pattern as /history and
// /replay/economy, so it can't contend for the swarm DO's single-threaded input queue.

function json(obj: unknown, status = 200): Response {
  return new Response(JSON.stringify(obj), { status, headers: { "Content-Type": "application/json" } });
}

export async function serveShadow(db: D1Database | undefined, url: URL): Promise<Response> {
  if (!db) return json({ error: "D1 not configured", code: "service_unavailable", status: 503 }, 503);
  const limit = Number(url.searchParams.get("limit") ?? "100");
  const offset = Number(url.searchParams.get("offset") ?? "0");
  const fromTick = url.searchParams.has("fromTick") ? Number(url.searchParams.get("fromTick")) : undefined;
  const toTick = url.searchParams.has("toTick") ? Number(url.searchParams.get("toTick")) : undefined;
  try {
    const result = await readShadowDecisions(db, { limit, offset, fromTick, toTick });
    return json({ enabled: true, ...result });
  } catch (e) {
    return json({ error: (e as Error).message, code: "internal_error", status: 500 }, 500);
  }
}
