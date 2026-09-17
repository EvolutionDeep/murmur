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
  createWalletClient,
  defineChain,
  fallback,
  http,
  type Chain,
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

// Public Arc RPCs tried after cfg.rpcUrl. Only endpoints we have actually reached are listed;
// append verified third-party providers (Alchemy / dRPC / QuickNode / Blockdaemon) here or via
// the RPC_URL env var when available. Arc mainnet endpoints are permissioned during the chain's
// private phase, so testnet is the default runtime for now.
const RPC_FALLBACKS_TESTNET = ["https://rpc.testnet.arc.io"];
const RPC_FALLBACKS_MAINNET = ["https://rpc.mainnet.arc.io"];

export function chainOf(cfg: RuntimeConfig): Chain {
  return CHAIN_BY_ID[cfg.chainId] ?? (cfg.isTestnet ? arcTestnet : arcMainnet);
}

/** Build a fallback transport: cfg.rpcUrl first (deduped), then the known public Arc RPCs. */
function buildTransport(cfg: RuntimeConfig, timeout: number): Transport {
  const pool = cfg.isTestnet ? RPC_FALLBACKS_TESTNET : RPC_FALLBACKS_MAINNET;
  const urls = [cfg.rpcUrl, ...pool].filter((u, i, a) => !!u && a.indexOf(u) === i);
  const transports = urls.map((u) =>
    http(u, {
      timeout,
      retryCount: 2,
      // Block data must never be served stale from Cloudflare's edge cache — the whole point is
      // to observe the chain's LIVE activity.
      fetchOptions: { cf: { cacheTtl: 0 } } as any,
    }),
  );
  return transports.length === 1
    ? transports[0]
    : fallback(transports, { rank: false, retryDelay: 200 });
}

let _publicCache: { key: string; client: PublicClient } | null = null;

/** Cached read-only public client for the configured Arc network. */
export function publicClient(cfg: RuntimeConfig): PublicClient {
  const key = `${cfg.chainId}|${cfg.rpcUrl}`;
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
