// Cloudflare Worker entry — forwards HTTP requests to the Durable Object and handles Cron.

import { loadConfig, type Env } from "./config.js";
import { FlyStateDO } from "./state.js";
import { OPENAPI_SPEC } from "./openapi.js";
import { handleCommunity } from "./community.js";

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
    "Access-Control-Allow-Headers": "Content-Type, Authorization, X-PAYMENT",
    // Let the browser read the x402 settlement result + the 402 requirements.
    "Access-Control-Expose-Headers": "X-PAYMENT-RESPONSE, PAYMENT-REQUIRED, X-PAYMENT-VERSION",
    "Access-Control-Max-Age": "86400",
  };
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    const origin = request.headers.get("Origin") ?? env.FRONTEND_ORIGIN ?? "*";

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
          features: ["population", "market-temperature", "neural-sim", "stimulus", "agent-economy-x402", "prediction-market", "human-arena-murmur", "community-governance", "d1-history-archive", "brain-manifest-provenance", "connectome-breeding-lineage", "public-api-openapi"],
          endpoints: [
            "GET  /openapi.json (this API's OpenAPI 3.1 contract — free, no key, CORS-enabled; human docs at muros.live/developers)",
            "GET  /state",
            "GET  /population   (collective mood + per-fly drives + economy summary — the frontend feed)",
            "GET  /market       (current Arc activity → temperature / regime)",
            "GET  /economy      (agent wallets + x402 settlement ledger + totals)",
            "GET  /leaderboard  (trustless per-agent PnL ranking + paid-signal revenue)",
            "GET  /signal/pulse (x402 paywall: 402 → pay USDC → the machine-readable Arc-activity signal)",
            "GET  /signal/requirements (the x402 payment requirements a browser signs to buy the signal)",
            "GET  /predictions  (on-chain prediction market: live book + parimutuel odds + hit-rate leaderboard)",
            "GET  /predictions/verify?round=N (recompute a round's receipt hash + read its on-chain registry commitment)",
            "GET  /manifest      (the swarm's brain manifest + its sha256 identity — trustless 'prove the brain': real connectomes, no LLM)",
            "GET  /manifest/replay (server-side offline replay: rebuild every connectome from the committed seeds → PASS/FAIL)",
            "GET  /lineage      (the connectome breeding market: every genome + its on-chain ancestry — genesis roots + bred individuals)",
            "GET  /lineage/:hash (one bred brain: genome body + parents/children + re-derived structural spec + on-chain commit)",
            "GET  /lineage/verify?hash=0x… (recompute a genome's hash, replay its brain, confirm its on-chain ancestry → PASS/FAIL)",
            "GET  /arena        (human-vs-swarm MURMUR arena: live book + parimutuel odds + you-vs-the-swarm hit rate)",
            "GET  /community  (token-gated governance forum: browse free; post/propose/vote need a MURMUR-holding wallet signature — see /community for the sub-endpoints)",
            "GET  /history      (D1 long-term archive: one row per cron — temperature/regime/deals/volume/gini/topStates)",
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

    // Forward every other request to the DO (with the /v1 prefix already stripped)
    const stub = getDO(env);
    const doUrl = new URL(request.url);
    doUrl.pathname = path;
    const resp = await stub.fetch(new Request(doUrl.toString(), request));

    // Re-apply CORS headers (the DO already adds them once; keep it idempotent here)
    const headers = new Headers(resp.headers);
    for (const [k, v] of Object.entries(corsHeaders(origin))) headers.set(k, v);
    return new Response(resp.body, { status: resp.status, headers });
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
    await stub.fetch(new Request(url, { method: "POST", headers }));
  },
} satisfies ExportedHandler<Env>;
