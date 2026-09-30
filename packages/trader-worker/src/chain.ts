// Arc chain clients (read-only by default; a gated wallet client for real-money settlement).
//
// The market-temperature path only READS Arc block data: no wallet, no private key, no signing.
// The ONLY signing client is walletClient() at the bottom, which the onchain x402 facilitator uses
// to submit a buyer's EIP-3009 authorization. It is never built in the default simulated economy —
// see keys.ts / x402.ts. The whole always-on live-trading stack from the previous BSC project is
// gone; what remains is opt-in, key-gated and inert unless ECONOMY_FACILITATOR="onchain" AND a
// mnemonic/PK secret is present.
//
// Arc specifics baked into this module (all verified against live testnet blocks):
//   · Native gas token is USDC. The NATIVE layer (eth_getBalance / msg.value / block rewards)
//     uses 18 decimals, while the ERC-20 USDC contract uses 6 (OFFSET = 12; native / 1e12 =
//     erc20). We never move value, so this only affects display — nativeCurrency.decimals = 18
//     matches the native layer. Never add a native amount to an ERC-20 amount.
//   · block.prevrandao (a.k.a. mixHash) is ALWAYS 0x000..000 on Arc → on-chain randomness is
//     dead. Anything needing entropy MUST seed from the block number + a per-fly seed.
//   · Sub-second blocks with REPEATED timestamps → window by block NUMBER, never by timestamp.
//   · Deterministic finality → no reorg handling is needed.
//
// viem's http transport uses global fetch, which is available in the Workers runtime.

import {
  createPublicClient,
  createTransport,
  createWalletClient,
  defineChain,
  http,
  type Chain,
  type EIP1193RequestFn,
  type LocalAccount,
  type PublicClient,
  type Transport,
} from "viem";
import type { RuntimeConfig } from "./config.js";

// USDC is Arc's native gas token; the NATIVE representation uses 18 decimals (the ERC-20 uses 6).
const usdcNative = { name: "USDC", symbol: "USDC", decimals: 18 } as const;

export const arcTestnet = defineChain({
  id: 5_042_002,
  name: "Arc Testnet",
  nativeCurrency: usdcNative,
  rpcUrls: { default: { http: ["https://rpc.testnet.arc.io"] } },
  blockExplorers: {
    default: { name: "Arc Explorer", url: "https://explorer.testnet.arc.io" },
  },
  testnet: true,
});

export const arcMainnet = defineChain({
  id: 5042,
  name: "Arc",
  nativeCurrency: usdcNative,
  rpcUrls: { default: { http: ["https://rpc.mainnet.arc.io"] } },
  blockExplorers: {
    default: { name: "Arc Explorer", url: "https://explorer.arc.io" },
  },
  testnet: false,
});

const CHAIN_BY_ID: Record<number, Chain> = {
  [arcTestnet.id]: arcTestnet,
  [arcMainnet.id]: arcMainnet,
};

const RPC_FALLBACKS_TESTNET = ["https://rpc.testnet.arc.io"];
const RPC_FALLBACKS_MAINNET = [
  "https://rpc.drpc.mainnet.arc.io",
  "https://rpc.quicknode.mainnet.arc.io",
  "https://rpc.blockdaemon.mainnet.arc.io",
  "https://rpc.mainnet.arc.io",
];
const MAX_PROVIDER_TIMEOUT_MS = 6_000;
let nextRpcStart = 0;

export function chainOf(cfg: RuntimeConfig): Chain {
  return CHAIN_BY_ID[cfg.chainId] ?? (cfg.isTestnet ? arcTestnet : arcMainnet);
}

/**
 * Round-robin each request through the configured pool, then fail over through every other endpoint.
 *
 * `preferFirst` pins the start index to 0 instead of rotating (Task #135 Fix 2b). The pool's [0] is the PAID,
 * low-latency Alchemy Arc endpoint whenever ALCHEMY_ARC_RPC_URL is set, and the public endpoints behind it are
 * a failover, not peers. Rotating treated all 5 as peers, so only 20% of calls ever reached the paid URL — and
 * because each endpoint carries a 6s timeout with retryCount:0 and failures fall through IN ORDER, a single
 * logical RPC could cost up to 5×6s = 30s whenever it started on a slow public node. That is how the cron blew
 * its 90s abort budget (measured: 3 of 11 beats at 89998ms), which blocked the DO's single-threaded input queue
 * for 90s and took every DO-backed endpoint offline for the frontend. Pinning first caps a healthy call at one
 * Alchemy round-trip; the public pool still provides the FULL failover sweep when Alchemy itself errors or
 * times out, so resilience is unchanged. Only the happy-path latency changes.
 */
function rotatingTransport(transports: Transport[], preferFirst: boolean): Transport {
  return ({ chain, pollingInterval, retryCount, timeout, ...rest }) => {
    const clients = transports.map((transport) =>
      transport({ chain, pollingInterval, retryCount: 0, timeout, ...rest }),
    );
    const request: EIP1193RequestFn = async (args) => {
      const start = preferFirst ? 0 : nextRpcStart++ % clients.length;
      let lastError: unknown;

      for (let offset = 0; offset < clients.length; offset++) {
        const client = clients[(start + offset) % clients.length];
        try {
          return await (client.request as EIP1193RequestFn)(args);
        } catch (error) {
          lastError = error;
        }
      }

      throw lastError;
    };

    return createTransport({
      key: "arc-rpc-rotation",
      name: "Arc RPC rotation",
      type: "arc-rpc-rotation",
      retryCount: 0,
      request,
    });
  };
}

/**
 * Prefer the private (paid) endpoint when configured, else rotate the public pool; either way fail over
 * through every remaining endpoint.
 */
function buildTransport(cfg: RuntimeConfig, timeout: number): Transport {
  const publicPool = cfg.isTestnet ? RPC_FALLBACKS_TESTNET : RPC_FALLBACKS_MAINNET;
  const hasPrivate = !cfg.isTestnet && !!cfg.alchemyArcRpcUrl;
  const urls = [
    ...(hasPrivate ? [cfg.alchemyArcRpcUrl as string] : []),
    cfg.rpcUrl,
    ...publicPool,
  ].filter((url, index, all) => !!url && all.indexOf(url) === index);
  const providerTimeout = Math.min(timeout, MAX_PROVIDER_TIMEOUT_MS);
  const transports = urls.map((url) =>
    http(url, {
      timeout: providerTimeout,
      retryCount: 0,
      fetchOptions: { cf: { cacheTtl: 0 } } as any,
    }),
  );

  // Task #135 Fix 2b: strict Alchemy-first whenever the private URL is configured (it is urls[0] by construction).
  return transports.length === 1 ? transports[0] : rotatingTransport(transports, hasPrivate);
}

let _publicCache: { key: string; client: PublicClient } | null = null;

/** Cached read-only public client for the configured Arc network. */
export function publicClient(cfg: RuntimeConfig): PublicClient {
  const key = `${cfg.chainId}|${cfg.rpcUrl}|${cfg.alchemyArcRpcUrl ? "private" : "public"}`;
  if (_publicCache && _publicCache.key === key) return _publicCache.client as PublicClient;
  const client = createPublicClient({
    chain: chainOf(cfg),
    transport: buildTransport(cfg, 15_000),
  }) as PublicClient;
  _publicCache = { key, client };
  return client;
}

// --- Real-money settlement (ONCHAIN facilitator ONLY) --------------------------------
// The default simulated economy never calls this: it moves no value and holds no keys. This builds
// a wallet client bound to the gas-paying facilitator account, used to submit the buyer's signed
// EIP-3009 transferWithAuthorization to the Arc USDC precompile (0x3600..0000) and pay gas in
// native USDC. Signing the authorization itself needs NO wallet client — the buyer signs typed data
// directly on its HD LocalAccount (see x402.ts). The client is intentionally NOT cached: onchain
// settlement is rare and key-gated, and createWalletClient's transport is lazy (no eager connect).
export function walletClient(cfg: RuntimeConfig, account: LocalAccount) {
  return createWalletClient({
    account,
    chain: chainOf(cfg),
    transport: buildTransport(cfg, 20_000),
  });
}
