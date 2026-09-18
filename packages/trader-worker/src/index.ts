// Cloudflare Worker entry — forwards HTTP requests to the Durable Object and handles Cron.

import type { Env } from "./config.js";
import { FlyStateDO } from "./state.js";

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

    // CORS preflight
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders(origin) });
    }

    // Root path: health check + simple endpoint navigation
    if (url.pathname === "/" || url.pathname === "/health") {
      return new Response(
        JSON.stringify({
          ok: true,
          name: "murmur",
          version: "0.2.0",
          chain: "arc",
          features: ["population", "market-temperature", "neural-sim", "stimulus", "agent-economy-x402", "d1-history-archive"],
          endpoints: [
            "GET  /state",
            "GET  /population   (collective mood + per-fly drives + economy summary — the frontend feed)",
            "GET  /market       (current Arc activity → temperature / regime)",
            "GET  /economy      (agent wallets + x402 settlement ledger + totals)",
            "GET  /leaderboard  (trustless per-agent PnL ranking + paid-signal revenue)",
            "GET  /signal/pulse (x402 paywall: 402 → pay USDC → the machine-readable Arc-activity signal)",
            "GET  /signal/requirements (the x402 payment requirements a browser signs to buy the signal)",
            "GET  /history      (D1 long-term archive: one row per cron — temperature/regime/deals/volume/gini/topStates)",
            "GET  /stimuli",
            "GET  /snapshot?flyId=N   (full neural state of one fly + its agent wallet)",
            "GET  /flies/:id",
            "POST /stimulus     (poke the swarm)",
            "POST /tick         (debug: run one cron now)",
            "POST /reset        (debug: fresh founding population + funded wallets)",
          ],
        }),
        { headers: { "Content-Type": "application/json", ...corsHeaders(origin) } },
      );
    }

    // Forward every other request to the DO
    const stub = getDO(env);
    const doUrl = new URL(request.url);
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
