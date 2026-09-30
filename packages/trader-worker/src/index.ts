// Cloudflare Worker entry — forwards HTTP requests to the Durable Object and handles Cron.

import { loadConfig, type Env } from "./config.js";
import { FlyStateDO } from "./state.js";
import { OPENAPI_SPEC } from "./openapi.js";
import { handleCommunity } from "./community.js";
import { serveHistory } from "./history.js";
import { serveReplayEconomy } from "./economyReplay.js";
import { serveShadow } from "./shadowEvidence.js";

// FlyStateDO is the coordinator (public fetch + cron route here). FlyShardDO holds one slice of the
// swarm and is reachable ONLY from the coordinator over the FLY_SHARD binding when SHARD_COUNT > 1
// (see swarm.ts / shard.ts). Both must be exported so wrangler registers the DO classes; with the
// default SHARD_COUNT = "1" no shard is ever instantiated and the piece runs exactly as before.
export { FlyStateDO };
export { FlyShardDO } from "./shard.js";

const DO_NAME = "fly-main";   // Singleton DO: the whole swarm shares one state store

function getDO(env: Env) {
  const id = env.FLY_STATE.idFromName(DO_NAME);
  return env.FLY_STATE.get(id);
}

function corsHeaders(origin: string) {
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
    // X-PAYMENT carries the browser-signed x402 payload for the paid /signal/pulse product.
    // X-PAYMENT-PROOF carries the burn tx hash for the ㉚ land grid's burn-verification 402 flow.
    "Access-Control-Allow-Headers": "Content-Type, Authorization, X-PAYMENT, X-Payment-Proof",
    // Let the browser read the x402 settlement result + the 402 requirements + the free-replay marker, plus the
    // ㉚ land grid's burn challenge (X-Payment-Required).
    "Access-Control-Expose-Headers": "X-PAYMENT-RESPONSE, PAYMENT-REQUIRED, X-PAYMENT-VERSION, X-PAYMENT-REPLAYED, X-Payment-Required",
    "Access-Control-Max-Age": "86400",
    // The ACAO above ECHOES the request Origin, so any edge-cached response (e.g. /openapi.json max-age=300,
    // /land-img max-age=86400) would otherwise freeze the FIRST requester's Origin and serve it to every other
    // origin — a CORS cache-poisoning hole that blanked the production land grid. Vary: Origin forces a
    // per-Origin cache key. Harmless on no-store responses, correct on every cacheable one.
    "Vary": "Origin",
  };
}

/**
 * Task #135 Fix 1 — resolve the echoed Origin BEFORE anything that can throw, and never let the resolution
 * itself throw. `fetch()` below runs this as its very first statement, outside the try, so the CORS headers are
 * available even when the failure is a malformed URL or an unusable Headers object. Degrading to "*" keeps the
 * public read API reachable (it is public by design — every route here is CORS-open) instead of silently
 * stripping ACAO, which is precisely the blackout this fix exists to prevent.
 */
function safeOrigin(request: Request, env: Env): string {
  try {
    return request.headers.get("Origin") ?? env.FRONTEND_ORIGIN ?? "*";
  } catch {
    return "*";
  }
}

/**
 * Every request path, in one place, so `fetch()` can wrap it wholesale. Unchanged behaviour — this is the old
 * `fetch()` body verbatim, minus the Origin line which the caller now computes and passes in.
 */
async function route(request: Request, env: Env, ctx: ExecutionContext, origin: string): Promise<Response> {
  const url = new URL(request.url);

  // Non-breaking versioning: an optional /v1 prefix serves the identical surface
  // (/v1/population === /population). Strip it once here so neither the root handler nor the
  // DO router needs to know about it.
  const rawPath = url.pathname;
  const path = rawPath === "/v1" ? "/" : rawPath.startsWith("/v1/") ? rawPath.slice(3) : rawPath;

  // CORS preflight
  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders(origin) });
  }

  // The OpenAPI 3.1 contract — served straight from the worker (no DO round-trip), free + CORS-open.
  if (path === "/openapi.json") {
    return new Response(JSON.stringify(OPENAPI_SPEC), {
      headers: { "Content-Type": "application/json", "Cache-Control": "public, max-age=300", ...corsHeaders(origin) },
    });
  }

  // Root path: health check + simple endpoint navigation
  if (path === "/" || path === "/health") {
    return new Response(
      JSON.stringify({
        ok: true,
        name: "murmur",
        version: "0.2.0",
        chain: "arc",
        apiVersion: "v1",
        openapi: "/openapi.json",
        docs: "https://muros.live/developers",
        features: ["population", "market-temperature", "neural-sim", "stimulus", "agent-economy-x402", "prediction-market", "human-arena-murmur", "community-governance", "d1-history-archive", "brain-manifest-provenance", "connectome-breeding-lineage", "neural-laureate-poem", "public-api-openapi"],
        endpoints: [
          "GET  /openapi.json (this API's OpenAPI 3.1 contract — free, no key, CORS-enabled; human docs at muros.live/developers)",
          "GET  /state",
          "GET  /population   (collective mood + per-fly drives + economy summary — the frontend feed)",
          "GET  /market       (current Arc activity → temperature / regime)",
          "GET  /economy      (agent wallets + x402 settlement ledger + totals)",
          "GET  /leaderboard  (trustless per-agent PnL ranking + paid-signal revenue)",
          "GET  /signal/pulse (x402 paywall: 402 → pay USDC → the machine-readable Arc-activity signal)",
          "GET  /signal/requirements (the x402 payment requirements a browser signs to buy the signal)",
          "GET  /http/signal/pulse/GET (x402 v2 discovery: the same requirements in the v2/CAIP-2 wire shape + Bazaar schema extension)",
          "GET  /x402/verify?tx=0x… (trustless: decode the EIP-3009 authorization ANY mined tx executed — payer/payee/value/nonce/gas; neural echo when it's one of ours)",
          "GET  /pulse/refunds (⑥ refund-rail state: enabled switch + bounded refund ledger; dark-deployed, switch off by default)",
          "GET  /predictions  (on-chain prediction market: live book + parimutuel odds + hit-rate leaderboard)",
          "GET  /predictions/verify?round=N (recompute a round's receipt hash + read its on-chain registry commitment)",
          "GET  /manifest      (the swarm's brain manifest + its sha256 identity — trustless 'prove the brain': real connectomes, no LLM)",
          "GET  /manifest/replay (server-side offline replay: rebuild every connectome from the committed seeds → PASS/FAIL)",
          "GET  /poem           (⑮ the Laureate: the swarm's own poet — one living fly's neural activity + the on-chain reality, decoded into a verifiable four-line poem; no LLM)",
          "GET  /poem/verify?seq=N (recompute a poem's receipt hash + replay its text from the published neural integers + open grammar → selfConsistent / replayMatch)",
          "GET  /poem/archive (⑮ the permanent Laureate collection from D1 — every poem ever composed, paginated; each a full receipt for offline recompute + replay)",
          "GET  /lineage      (the connectome breeding market: every genome + its on-chain ancestry — genesis roots + bred individuals)",
          "GET  /lineage/:hash (one bred brain: genome body + parents/children + re-derived structural spec + on-chain commit)",
          "GET  /lineage/verify?hash=0x… (recompute a genome's hash, replay its brain, confirm its on-chain ancestry → PASS/FAIL)",
          "GET  /lineage/stats (④ cross-generation capability report: survival / netUsdc-per-1k-tick / settle success / predict hit-rate / lifespan, per generation × temperature band — read-only, zero new state)",
          "GET  /arena        (human-vs-swarm MURMUR arena: live book + parimutuel odds + you-vs-the-swarm hit rate)",
          "GET  /bourse       (⑲ the MURMUR coin tape as the swarm feels it: fever/whales/argus-tithe flow/silences — read-only, inert until BOURSE_ENABLED)",
          "GET  /community  (token-gated governance forum: browse free; post/propose/vote need a MURMUR-holding wallet signature — see /community for the sub-endpoints)",
          "GET  /history      (D1 long-term archive: one row per cron — temperature/regime/deals/volume/gini/topStates)",
          "GET  /replay/economy?fromEra&toEra (deterministic economy replay: re-run an archived era's serialize() blob along its recorded temperature pulse stream → byte-identical trajectory + replayHash; read-only, served from D1)",
          "GET  /stimuli",
          "GET  /snapshot?flyId=N   (full neural state of one fly + its agent wallet)",
          "GET  /flies/:id",
          "POST /stimulus     (poke the swarm)",
          "POST /breed        (apply a genetic operator to committed parents → record the offspring; ADMIN_TOKEN gated)",
          "POST /tick         (debug: run one cron now)",
          "POST /reset        (debug: fresh founding population + funded wallets)",
        ],
      }),
      { headers: { "Content-Type": "application/json", ...corsHeaders(origin) } },
    );
  }

  // Community governance page API — handled in the Worker (never a DO round-trip): it is orthogonal to the
  // tick/swarm and only reads the chain (balanceOf) + writes D1, so it must NOT contend for the swarm DO's
  // single-threaded input queue. Inert (501) unless cfg.community.enabled; CORS re-applied like the DO path.
  if (path === "/community" || path.startsWith("/community/")) {
    const cfg = loadConfig(env);
    const communityResp = await handleCommunity({ path, url, request, env, cfg });
    const communityHeaders = new Headers(communityResp.headers);
    for (const [k, v] of Object.entries(corsHeaders(origin))) communityHeaders.set(k, v);
    return new Response(communityResp.body, { status: communityResp.status, headers: communityHeaders });
  }

  // Long-term history — served in the Worker straight from D1 (see history.ts), never a DO round-trip. Like
  // /community this is an orthogonal, read-only D1 query; keeping it off the coordinator's single input gate
  // removes a queued invocation per poll so it can't delay the cron. Byte-identical output to the DO's
  // getHistory (which stays as the internal fallback); the frontend only reaches it via this public route.
  if (path === "/history" && request.method === "GET") {
    const histResp = await serveHistory(env.DB, url);
    const histHeaders = new Headers(histResp.headers);
    for (const [k, v] of Object.entries(corsHeaders(origin))) histHeaders.set(k, v);
    return new Response(histResp.body, { status: histResp.status, headers: histHeaders });
  }

  // P0.3 — deterministic economy replay, served in the Worker straight from D1 (see economyReplay.ts), never
  // a DO round-trip. Like /history this is an orthogonal, READ-ONLY D1 query: it replays each archived era's
  // serialize() blob along its recorded temperature pulse stream and returns the byte-reproducible trajectory
  // + replayHash. Keeping it off the coordinator's single input gate means a replay can't delay the cron.
  if (path === "/replay/economy" && request.method === "GET") {
    const replayResp = await serveReplayEconomy(env.DB, url);
    const replayHeaders = new Headers(replayResp.headers);
    for (const [k, v] of Object.entries(corsHeaders(origin))) replayHeaders.set(k, v);
    return new Response(replayResp.body, { status: replayResp.status, headers: replayHeaders });
  }

  // Shadow-compare (#87 Phase 0) — served in the Worker straight from D1, never a DO round-trip.
  // Same orthogonal-read pattern as /history and /replay/economy: it can't contend for the swarm DO's
  // single-threaded input queue. Returns { enabled, rows, total } or 503 when D1 is unbound.
  if (path === "/shadow" && request.method === "GET") {
    const shadowResp = await serveShadow(env.DB, url);
    const shadowHeaders = new Headers(shadowResp.headers);
    for (const [k, v] of Object.entries(corsHeaders(origin))) shadowHeaders.set(k, v);
    return new Response(shadowResp.body, { status: shadowResp.status, headers: shadowHeaders });
  }

  // Forward every other request to the DO (with the /v1 prefix already stripped)
  const stub = getDO(env);
  const doUrl = new URL(request.url);
  doUrl.pathname = path;
  const resp = await stub.fetch(new Request(doUrl.toString(), request));

  // Re-apply CORS headers (the DO already adds them once; keep it idempotent here)
  const headers = new Headers(resp.headers);
  for (const [k, v] of Object.entries(corsHeaders(origin))) headers.set(k, v);
  return new Response(resp.body, { status: resp.status, headers });
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    // Task #135 Fix 1 — CORS ALWAYS-ON. Before this, `fetch()` had no try/catch: any throw (a wedged or
    // overloaded DO making `stub.fetch()` REJECT, an unbound D1/KV binding, a DO reset mid-request, an isolate
    // cold-start race) escaped the handler and Cloudflare synthesized the platform's own error response, which
    // carries NO custom headers — so no Access-Control-Allow-Origin. The browser then reported a CORS error
    // rather than a 5xx, and www.muros.live's fetch layer flipped to state.offline=true + "dreaming" synthetic
    // data behind a 20s breaker. Every blocked endpoint was DO-backed (/population /state /economy /annals
    // /war /bourse /lineage /lexicon /proofs) while the Worker-served D1 routes (/history /shadow
    // /replay/economy) stayed up — the exact signature of a rejected `stub.fetch()`. Measured trigger: a cron
    // hitting its 90s abort (3 of 11 beats) blocks the DO's single-threaded input queue for 90s, so queued
    // requests reject. Fix 2b/2c' remove that trigger; this is the safety net so NO backend stall can ever
    // again present as a total CORS blackout. `no-store` because a per-Origin 500 must never be edge-cached.
    const origin = safeOrigin(request, env);
    try {
      return await route(request, env, ctx, origin);
    } catch (e) {
      const detail = e instanceof Error ? e.message : String(e);
      console.error("[worker] unhandled in fetch — returning a CORS-safe 500:", detail);
      return new Response(JSON.stringify({ ok: false, error: "internal", detail }), {
        status: 500,
        headers: { "Content-Type": "application/json", "Cache-Control": "no-store", ...corsHeaders(origin) },
      });
    }
  },

  async scheduled(controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    const stub = getDO(env);
    // Trigger the cron via the internal /tick path (DOs have no direct scheduled hook). Present
    // ADMIN_TOKEN when configured so this trusted internal tick clears the same guard that blocks
    // anonymous callers from the public POST /tick + /reset endpoints — otherwise arming the token
    // would 403 the cron and freeze the live swarm.
    const token = (env.ADMIN_TOKEN ?? "").trim();
    const headers: Record<string, string> = token ? { "x-admin-token": token } : {};
    const url = `https://do.internal/tick`;
    // Backstop ceiling on the cron's own /tick call. A1 already bounds every coordinator→shard RPC
    // inside the DO's step(), and the cron persists the clock even when its body throws — so a healthy
    // /tick finishes well under the 60s cadence (Task 64 bench: ~21s @66 alive, ~33s @100 cap warm).
    // This signal ONLY fires if the whole DO handler wedges on some OTHER unbounded await; it stops ONE
    // scheduled invocation from sitting at the ~900s wall (the freeze we caught) so the NEXT minute's cron
    // isn't queued behind a corpse. Fix 2 (Task 64): raised 55s→90s. A single cron may now legitimately
    // span >60s (a cold shard's first KV load, or a full 100-fly roster) without being aborted mid-fan-out
    // — Cloudflare lets a scheduled handler run up to 15 min, and the DO reentrancy guard + P2 heartbeat
    // already make an over-running cron SKIP (not double-drive) the next beat while keeping lastCron fresh.
    // 90s stays well under the DO wall and under CRON_WEDGE_MS (180s) so the watchdog never false-fires.
    //
    // Task #135: this abort is NOT free — while it fires, the DO's single-threaded input queue is blocked, so
    // every DO-backed HTTP request for those 90s rejects (see the CORS note in fetch()). The 90s ceiling stays
    // (it is the watchdog's contract), so the real fix is upstream: Fix 2b pins the paid Alchemy RPC first so a
    // single logical call costs one round-trip instead of up to 5×6s of ordered public-RPC failover, and Fix 2c'
    // puts a 45s wall-clock ceiling on the netting flush so the 40-chunk count budget can't out-run the beat.
    try {
      await stub.fetch(new Request(url, { method: "POST", headers, signal: AbortSignal.timeout(90000) }));
    } catch (e) {
      console.error("[worker] scheduled /tick failed or timed out (next cron retries):", (e as Error).message);
    }
  },
} satisfies ExportedHandler<Env>;
