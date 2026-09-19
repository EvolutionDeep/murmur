// arc-circle-x402 — a minimal, dependency-light client for Circle's hosted x402 Facilitator Service on
// Arc (and Base / Polygon).
//
// Settle EIP-3009 USDC payments through Circle's relayer — it screens both parties, submits the transfer
// on-chain, and pays the settlement gas — authenticating with either a Circle API key (Bearer) or a
// KEYLESS EIP-712 seller proof signed by your payTo key. No relayer keys, no separate gas wallet.
//
//   import { settleViaCircle, signEip3009Authorization, ARC_MAINNET } from "arc-circle-x402";
//
// Pure pieces (circle.ts, eip3009.ts, networks.ts) are unit-tested with no network; client.ts is the only
// part that touches the wire. See README.md for the full guide and examples/settle.ts for a runnable flow.

export * from "./networks.js";
export * from "./circle.js";
export * from "./eip3009.js";
export * from "./client.js";
