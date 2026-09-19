// Network registry for Circle's x402 Facilitator Service.
//
// Circle routes a /settle by the body's CAIP-2 `network` string, while the buyer's EIP-3009 authorization
// is signed over the NUMERIC chainId — so choosing a network here never invalidates an existing buyer
// signature. USDC addresses below are the canonical native USDC contracts; Arc's is the precompile every
// Arc node exposes at 0x3600…0000. Always cross-check against Circle's live network list before production.

import type { Address } from "viem";

export interface NetworkInfo {
  /** Human label. */
  name: string;
  /** Numeric EIP-155 chain id — what the EIP-3009 signature and the EIP-712 seller-proof domain commit to. */
  chainId: number;
  /** CAIP-2 network id Circle's /settle routes by. */
  caip2: string;
  /** Canonical native USDC contract on that network. */
  usdc: Address;
  /** Whether settlements are final on arrival (Arc: yes; Base/Polygon: probabilistic — watch confirmations). */
  instantFinality: boolean;
}

/** Arc mainnet — USDC is the precompile at 0x3600…0000; settlements are instantly final. */
export const ARC_MAINNET: NetworkInfo = {
  name: "arc-mainnet",
  chainId: 5042,
  caip2: "eip155:5042",
  usdc: "0x3600000000000000000000000000000000000000",
  instantFinality: true,
};

/**
 * Arc testnet. The USDC precompile address mirrors mainnet (precompiles are protocol-fixed), but confirm
 * it against Circle's network list before relying on it for a real integration.
 */
export const ARC_TESTNET: NetworkInfo = {
  name: "arc-testnet",
  chainId: 5042002,
  caip2: "eip155:5042002",
  usdc: "0x3600000000000000000000000000000000000000",
  instantFinality: true,
};

/** Base mainnet (native USDC). Settlements are probabilistic — wait for confirmations before fulfilling. */
export const BASE_MAINNET: NetworkInfo = {
  name: "base",
  chainId: 8453,
  caip2: "eip155:8453",
  usdc: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
  instantFinality: false,
};

/** Polygon PoS mainnet (native USDC). Settlements are probabilistic. */
export const POLYGON_MAINNET: NetworkInfo = {
  name: "polygon",
  chainId: 137,
  caip2: "eip155:137",
  usdc: "0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359",
  instantFinality: false,
};

/** Every network Circle's Facilitator Service settles on, keyed by CAIP-2 id. */
export const SUPPORTED_NETWORKS: Record<string, NetworkInfo> = {
  [ARC_MAINNET.caip2]: ARC_MAINNET,
  [ARC_TESTNET.caip2]: ARC_TESTNET,
  [BASE_MAINNET.caip2]: BASE_MAINNET,
  [POLYGON_MAINNET.caip2]: POLYGON_MAINNET,
};

/** CAIP-2 network id (`eip155:<chainId>`) Circle expects for an EVM chain. */
export function caip2(chainId: number): string {
  return `eip155:${chainId}`;
}

/** Look up a network by numeric chain id, or undefined if Circle does not settle there. */
export function networkByChainId(chainId: number): NetworkInfo | undefined {
  return SUPPORTED_NETWORKS[caip2(chainId)];
}
