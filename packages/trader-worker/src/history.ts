// Worker-side long-term history reader — the /history endpoint, served STRAIGHT from D1 without a
// Durable Object round-trip.
//
// WHY THIS EXISTS: the coordinator DO is single-threaded at its input gate — the cron's scheduled
// handler and every public read queue behind one another there. /history runs a (paginated) D1 query,
// so serving it inside the DO held a coordinator slot for the duration of that query. That read traffic
// is exactly what starved the cron's own work in the production freeze we cured. /community already
// established the pattern (see index.ts): an orthogonal, D1-only read is served in the Worker so it never
// contends for the swarm DO's queue. /history is the same shape — pure D1, no brain/wallet/cron state.
//
// OUTPUT PARITY: this returns a byte-identical payload to FlyStateDO.getHistory(). The rows come from the
// same `ticks` table via the same column list, formatted by the same parseHistoryRow shape. The cheap
// "since launch" aggregate is the SAME COUNT/MIN/MAX the DO seeds its running cache from (ensureHistSummary),
// so a Worker read and a DO read can never disagree — the DO's cache is only an incremental view of this one
// query. The DO keeps its own getHistory untouched as the internal fallback; the Worker intercepts the public
// route, so the (now cache-free) full aggregate runs OFF the DO and only on the frontend's slow ~5-min poll.

/** Shape a raw D1 `ticks` row into clean camelCase JSON, parsing the behavioural-state histogram.
 *  Mirrors state.ts#parseHistoryRow exactly — keep the two in lockstep if the ticks schema changes. */
function parseHistoryRow(r: any) {
  let topStates: Record<string, number> | null = null;
  if (r?.top_states) {
    try { topStates = JSON.parse(r.top_states); } catch { topStates = null; }
  }
  return {
    tick: r?.tick ?? null,
    ts: r?.ts ?? null,
    temperature: r?.temperature ?? null,
    regime: r?.regime ?? null,
    size: r?.size ?? null,
    deals: r?.deals ?? null,
    settlements: r?.settlements ?? null,
    volumeUsdc: r?.volume_usdc ?? null,
    gini: r?.gini ?? null,
    topState: r?.top_state ?? null,
    topStates,
  };
}

const COLS = `tick, ts, temperature, regime, size, deals, settlements, volume_usdc, gini, top_state, top_states`;

function json(obj: unknown, status = 200): Response {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

/**
 * GET /history from D1, in the Worker. Params identical to the DO version:
 *   limit  — max rows (default 500, capped 5000)
 *   before — exclusive upper bound on tick, for backwards pagination
 *   order  — "asc" for oldest-first (default "desc", newest-first)
 * D1 unbound ⇒ { enabled:false, ... } (same as the DO's graceful path). Any D1 error ⇒ { enabled:true,
 * error, rows:[], summary:null } at 500 (same as the DO's catch). NEVER throws.
 */
export async function serveHistory(db: D1Database | undefined, url: URL): Promise<Response> {
  if (!db) return json({ enabled: false, rows: [], summary: null, note: "D1 not bound" });
  const limit = Math.min(5000, Math.max(1, Number(url.searchParams.get("limit") ?? "500") || 500));
  const order = url.searchParams.get("order") === "asc" ? "ASC" : "DESC";
  const beforeRaw = url.searchParams.get("before");
  try {
    // Idempotent, belt-and-braces DDL (identical to the DO's ensureD1Schema): correct even if a read
    // lands before any cron has archived on a freshly-provisioned database.
    await db
      .prepare(
        `CREATE TABLE IF NOT EXISTS ticks (
           tick INTEGER PRIMARY KEY, ts INTEGER NOT NULL, temperature REAL NOT NULL, regime TEXT NOT NULL,
           size INTEGER, deals INTEGER, settlements INTEGER, volume_usdc REAL, gini REAL,
           top_state TEXT, top_states TEXT )`,
      )
      .run();
    await db.prepare(`CREATE INDEX IF NOT EXISTS idx_ticks_ts ON ticks (ts)`).run();

    const hasBefore = beforeRaw != null && Number.isFinite(Number(beforeRaw));
    const page = hasBefore
      ? await db.prepare(`SELECT ${COLS} FROM ticks WHERE tick < ? ORDER BY tick ${order} LIMIT ?`).bind(Number(beforeRaw), limit).all()
      : await db.prepare(`SELECT ${COLS} FROM ticks ORDER BY tick ${order} LIMIT ?`).bind(limit).all();
    const rows = (page.results ?? []).map(parseHistoryRow);

    // The cheap "since launch" aggregate — the exact same query the DO seeds its incremental cache from.
    const agg = await db
      .prepare(
        `SELECT COUNT(*) AS n, MIN(tick) AS firstTick, MAX(tick) AS lastTick, MIN(ts) AS firstTs,
                MAX(ts) AS lastTs, MAX(settlements) AS settlements, MAX(volume_usdc) AS volumeUsdc FROM ticks`,
      )
      .all();
    const a: any = (agg.results ?? [])[0] ?? {};
    return json({
      enabled: true,
      order,
      count: rows.length,
      summary: {
        ticks: Number(a.n ?? 0),
        firstTick: a.firstTick ?? null,
        lastTick: a.lastTick ?? null,
        firstTs: a.firstTs ?? null,
        lastTs: a.lastTs ?? null,
        settlements: a.settlements ?? null,
        volumeUsdc: a.volumeUsdc ?? null,
      },
      rows,
    });
  } catch (e) {
    return json({ enabled: true, error: (e as Error).message, rows: [], summary: null }, 500);
  }
}
