// x402 — the internet-native payment protocol, reduced to the shapes murmur actually uses.
//
// WHY THIS FILE EXISTS. murmur is turning its fly population into a small AGENT ECONOMY: every fly
// is an autonomous economic agent whose 1,080-neuron connectome decides WHAT to buy and FROM WHOM,
// and the agents settle with each other using x402 micropayments (USDC) — machine-to-machine, no
// LLM in the loop. x402 is the right rail for that: it is exactly the "agentic commerce" flow Circle
// names in its 2026 vision (Gateway + Arc + CCTP + x402 for USDC micropayments / M2M settlement).
//
// THE HARD CONSTRAINT. This Worker holds NO private key and signs NOTHING (see chain.ts). Real x402
// settlement needs the payer to sign an EIP-3009 `transferWithAuthorization` and a facilitator to
// submit it on-chain. We therefore implement the protocol FAITHFULLY AT THE MESSAGE LEVEL — the same
// PaymentRequirements / PaymentPayload / verify / settle / SettlementResponse shapes the real `exact`
// scheme uses — but run it against a keyless `SimulatedFacilitator` that keeps an internal ledger and
// mints a deterministic pseudo txHash instead of touching the chain. A documented `OnChainFacilitator`
// seam is provided so that, the moment testnet USDC + a signer are supplied, real settlement can be
// dropped in WITHOUT changing a single line of the economy logic. Everything simulated is labelled as
// such; nothing here can move real funds.
//
// Reference flow (x402 "exact" scheme):
//   1. client GETs a resource
//   2. resource server → 402 Payment Required + PAYMENT-REQUIRED header (b64 PaymentRequirements[])
//   3. client picks requirements, builds a PaymentPayload (the signed authorization)
//   4. client re-sends with PAYMENT-SIGNATURE header (b64 PaymentPayload)
//   5. server POSTs {paymentPayload, paymentRequirements} to facilitator /verify
//   6. facilitator → { valid }
//   7. server does the work, then POSTs the same to facilitator /settle
//   8. facilitator submits on-chain, waits for confirmation → SettlementResponse { success, txHash }
//   9. server → 200 OK + PAYMENT-RESPONSE header (b64 SettlementResponse)

import {
  erc20Abi,
  encodeFunctionData,
  parseAbi,
  parseSignature,
  recoverTypedDataAddress,
  type Address,
  type Chain,
  type Hex,
  type LocalAccount,
  type PublicClient,
  type Transport,
  type WalletClient,
} from "viem";
import { nonceFromCalldata } from "./provenance.js";
import {
  CIRCLE_SETTLE_PATH,
  buildCircleSettleBody,
  signSellerProof,
  circleAuthHeaders,
  parseSettleResponse,
} from "./circle.js";

/** Protocol version we speak. The reference `exact` scheme ships at version 1. */
export const X402_VERSION = 1;

/** The first (and only) x402 scheme we implement: transfer an exact amount. */
export const SCHEME_EXACT = "exact" as const;

/** USDC has 6 decimals as an ERC-20 (Arc's native gas layer uses 18 — never mix them; see chain.ts). */
export const USDC_DECIMALS = 6;

/**
 * Zero-address placeholder the KEYLESS SIMULATOR settles against. Keeping the simulated asset at 0x0
 * makes it unmistakable that no real deployment is touched, and preserves the exact payloads the live
 * (simulated) economy already produces.
 */
export const ARC_USDC_SIMULATED = "0x0000000000000000000000000000000000000000";

/**
 * Canonical USDC on Arc — a Circle FiatTokenV2 PRECOMPILE at 0x3600..0000. Verified live against
 * mainnet (chainId 5042): decimals()=6, name()="USDC" (NOT "USD Coin"), symbol()="USDC",
 * version()="2", totalSupply ≈ 648M, and transferWithAuthorization(bad-sig) reverts with
 * "FiatTokenV2: invalid signature" — i.e. EIP-3009 is present. Used ONLY by the onchain facilitator;
 * the default simulated economy keeps ARC_USDC_SIMULATED.
 */
export const ARC_USDC = "0x3600000000000000000000000000000000000000";

/** The network tag carried in every payload. Mirrors how x402 names networks ("base", "solana", …). */
export function arcNetworkTag(isTestnet: boolean): string {
  return isTestnet ? "arc-testnet" : "arc";
}

/**
 * Bounded receipt waits. viem's waitForTransactionReceipt polls forever by default: when the Arc RPC
 * degrades (or a tx stalls), a single unbounded wait can hold the DO's serial input queue and freeze
 * EVERY later cron — the whole site stops ticking. Every wait here is therefore time-boxed:
 *  · money path (settle / external settle): the tx is already broadcast, so timing out only reports
 *    failure — the netting ledger never moves without a mined receipt, and the next cron re-reads the
 *    authoritative on-chain balance before signing, so no double-spend is possible.
 *  · registry commits (best-effort mirrors): a shorter bound; they must never eat the cron budget.
 */
export const RECEIPT_TIMEOUT_MS = 45_000;
export const REGISTRY_RECEIPT_TIMEOUT_MS = 30_000;

// ============================== EIP-3009 (real settlement) ==============================
//
// The Arc USDC precompile is a Circle FiatTokenV2, so gasless transfers use EIP-3009
// `transferWithAuthorization`: the PAYER signs an EIP-712 message (no gas, no tx) and ANY relayer —
// here the gas-paying facilitator — submits it on-chain. The domain below was reconstructed from the
// live probe (name/version read off the contract; chainId + verifyingContract from config). name and
// version are OVERRIDABLE via env because Arc is a day-old chain and the EIP-712 domain string is the
// single most likely thing to differ from a canonical Circle deployment — if a signed authorization
// reverts with "invalid signature", the domain (not the key) is the first suspect.

/** Default EIP-712 domain name for Arc USDC (probe returned name()="USDC"). */
export const ARC_USDC_EIP712_NAME = "USDC";
/** Default EIP-712 domain version (probe returned version()="2"). */
export const ARC_USDC_EIP712_VERSION = "2";

/** EIP-712 primary type the payer signs for a gasless USDC transfer. */
export const EIP3009_TYPES = {
  TransferWithAuthorization: [
    { name: "from", type: "address" },
    { name: "to", type: "address" },
    { name: "value", type: "uint256" },
    { name: "validAfter", type: "uint256" },
    { name: "validBefore", type: "uint256" },
    { name: "nonce", type: "bytes32" },
  ],
} as const;

/**
 * Circle FiatTokenV2 `transferWithAuthorization` — the ORIGINAL split-signature (v, r, s) overload,
 * which every FiatTokenV2 exposes (the compact `bytes signature` overload is V2_1+ only, so we avoid
 * depending on it on a fresh chain). The relayer calls this with the payer's recovered signature.
 */
export const fiatTokenV2Abi = parseAbi([
  "function transferWithAuthorization(address from, address to, uint256 value, uint256 validAfter, uint256 validBefore, bytes32 nonce, uint8 v, bytes32 r, bytes32 s)",
]);

/**
 * Coerce the economy's short pseudo-nonce (0x + ≥8 hex) into the bytes32 EIP-3009 expects by
 * left-padding. The payer signs THIS value and the relayer submits THIS value, so uniqueness only has
 * to hold across the economy's own nonces (it does — each deal draws a fresh random nonce).
 */
export function toNonce32(nonce: string): Hex {
  const hex = nonce.replace(/^0x/i, "").toLowerCase();
  if (hex.length === 0 || hex.length > 64) throw new Error(`nonce not encodable as bytes32: ${nonce}`);
  return `0x${hex.padStart(64, "0")}` as Hex;
}

/**
 * Left-pad any short hex (a 64-char sha256 receipt hash, or an empty "" genesis head) into a bytes32
 * for the NeuralReceiptRegistry. Mirrors toNonce32 but is named for the registry's bytes32 args so the
 * intent reads clearly at the call site.
 */
export function toBytes32(hex: string): Hex {
  const h = hex.replace(/^0x/i, "").toLowerCase();
  if (h.length > 64) throw new Error(`not encodable as bytes32: ${hex}`);
  return `0x${h.padStart(64, "0")}` as Hex;
}

/**
 * murmur's OWN on-chain commitment log (contracts/NeuralReceiptRegistry.sol). It moves the neural
 * receipt HASH-CHAIN HEAD on-chain: after each transfer mines, the facilitator commits the receipt
 * hash + its predecessor, and the contract enforces prevHead == chainHead so the ordered chain is
 * reconstructible purely from Arc RPC events — no murmur server, no trust in the operator. Pure
 * commitment log: holds no funds, no upgrade path.
 */
export const neuralReceiptRegistryAbi = parseAbi([
  "function commit(bytes32 receiptHash, bytes32 prevHead, uint64 tickIndex, uint32 constituents, bytes32 txHash)",
  "function commits(bytes32) view returns (bytes32 prevHead, uint64 tickIndex, uint32 constituents, bytes32 txHash, uint64 ts)",
  "function chainHead() view returns (bytes32)",
  "function commitCount() view returns (uint256)",
  "function committer() view returns (address)",
  "function isCommitted(bytes32) view returns (bool)",
  "function seedGenesis(bytes32 head)",
]);

/** One committed link, decoded from the registry's `commits` mapping (ts == 0 ⇒ not committed). */
export interface RegistryCommit {
  prevHead: string;      // 0x…64 chainHead before this receipt
  tickIndex: number;
  constituents: number;
  txHash: string;        // 0x…64 the EIP-3009 transfer whose nonce == receiptHash
  ts: number;            // 0 ⇒ never committed
}

/**
 * murmur's human-vs-swarm prediction arena (contracts/PredictionArena.sol). Holders bet MURMUR on the
 * same Arc-temperature move the fly swarm does; the contract escrows the stakes and pays winners
 * parimutuel, and IT — not the Worker — derives UP/DOWN/FLAT from the entry temperature + flat band the
 * resolver committed at open. The Worker only ever calls openRound/resolve as the authorized resolver.
 */
export const predictionArenaAbi = parseAbi([
  "function openRound(uint256 roundId, int64 entryTempR6, int64 flatBandR6, uint64 betDeadline)",
  "function resolve(uint256 roundId, int64 exitTempR6)",
  "function roundInfo(uint256 roundId) view returns (bool opened, bool resolved, uint8 outcome, int64 entryTemp, int64 exitTemp, int64 flatBand, uint64 betDeadline, uint64 openedAt, uint64 resolvedAt, uint256 poolUp, uint256 poolDown, uint256 bettorCount)",
  "function payoutFor(uint256 roundId, address who) view returns (uint256 stake, uint256 payout, bool claimable)",
  "function resolver() view returns (address)",
  "function token() view returns (address)",
  "function roundCount() view returns (uint256)",
  "function escrow() view returns (uint256)",
]);

/** A decoded arena round: temperatures unscaled from r6 (÷1e6), pools as atomic MURMUR (18-dec) strings. */
export interface ArenaRoundInfo {
  opened: boolean;
  resolved: boolean;
  outcome: number;         // 0 pending, 1 UP, 2 DOWN, 3 FLAT, 4 REFUND (stale)
  entryTemp: number;
  exitTemp: number;
  flatBand: number;
  betDeadline: number;     // unix seconds
  openedAt: number;
  resolvedAt: number;
  poolUp: string;          // atomic MURMUR (18-dec) as a decimal string
  poolDown: string;
  bettorCount: number;
}

/**
 * murmur's on-chain house WAR + TAXATION coffer (contracts/WarCoffer.sol). It escrows REAL USDC per house
 * vault and settles BOTH the war payout and the extra on-chain tax ITSELF: a war commits each house's power
 * at declare, and the winner is derived IN-CONTRACT from those committed inputs, so the resolver (the
 * Worker's facilitator wallet) cannot steer a result — it only triggers declare/resolve/levy and funds the
 * vaults. Every amount crossing this boundary is 6-dec USDC (atomic); the Worker sizes each under the
 * coffer's on-chain hard cap, and each call degrades to null so a war can never block or fail a live tick.
 */
export const warCofferAbi = parseAbi([
  "function deposit(uint256 houseId, uint256 amount)",
  "function declareWar(uint256 warId, uint256 attacker, uint256 defender, uint256 stake, uint256 powerA, uint256 powerB, uint64 deadline)",
  "function resolveWar(uint256 warId)",
  "function expireStaleWar(uint256 warId)",
  "function levyTax(uint256 houseId, uint256 amount)",
  "function sweepTo(uint256 houseId)",
  "function vault(uint256 houseId) view returns (uint256)",
  "function previewWinner(uint256 warId) view returns (uint8 winner, uint256 roll, uint256 total)",
  "function warInfo(uint256 warId) view returns (bool opened, bool resolved, uint8 winner, uint256 attacker, uint256 defender, uint256 stake, uint256 powerA, uint256 powerB, uint256 pot, uint64 deadline, uint64 openedAt, uint64 resolvedAt)",
  "function commonsPurse() view returns (uint256)",
  "function totalEscrow() view returns (uint256)",
  "function warCount() view returns (uint256)",
  "function escrow() view returns (uint256)",
  "function maxEscrow() view returns (uint256)",
  "function resolver() view returns (address)",
]);

/** The minimal ERC-20 surface the coffer needs the facilitator to drive (approve before each deposit pull). */
export const usdcErc20Abi = parseAbi([
  "function approve(address spender, uint256 value) returns (bool)",
  "function allowance(address owner, address spender) view returns (uint256)",
]);

/** A decoded war: ids/pot/stake as decimal strings (uint256 / atomic 6-dec USDC); winner 0 none / 1 att / 2 def. */
export interface WarInfo {
  opened: boolean;
  resolved: boolean;
  winner: number;        // 0 none/refund, 1 attacker, 2 defender
  attacker: string;      // house id (decimal string)
  defender: string;
  stake: string;         // atomic USDC posted by EACH side (pot == 2*stake)
  powerA: string;        // attacker power committed at declare
  powerB: string;        // defender power committed at declare
  pot: string;           // atomic USDC escrowed for this war (0 after resolve/expire)
  deadline: number;      // unix seconds at/after which the war may be resolved
  openedAt: number;
  resolvedAt: number;
}

/** The coffer's aggregate on-chain totals for the /war read-out (all atomic 6-dec USDC strings). */
export interface WarCofferStats {
  commonsPurse: string;   // tax collected and held for the swarm
  totalEscrow: string;    // total USDC ever deposited (== the coffer's real balance)
  warCount: string;       // number of wars declared (liveness counter)
  escrow: string;         // USDC the coffer currently holds (balanceOf)
  maxEscrow: string;      // the coffer's hard cap
}


/**
 * murmur's connectome BREEDING-market ancestry log (contracts/ConnectomeLineage.sol). Each bred genome
 * (sha256 of its canonical Genome body) is committed here with its parents, operator and generation, so
 * "who bred whom, from whom" is a public, tamper-evident fact re-derivable from Arc RPC events alone —
 * the same trustless-commitment discipline as NeuralReceiptRegistry. Pure log: holds no funds, no upgrade.
 */
export const connectomeLineageAbi = parseAbi([
  "function commit(bytes32 genomeHash, bytes32 parentA, bytes32 parentB, uint8 op, uint32 generation, address breeder)",
  "function lineages(bytes32) view returns (bytes32 genomeHash, bytes32 parentA, bytes32 parentB, uint8 op, uint32 generation, address breeder, uint64 ts)",
  "function isCommitted(bytes32) view returns (bool)",
  "function generationOf(bytes32) view returns (uint32)",
  "function breederOf(bytes32) view returns (address)",
  "function childCount(bytes32) view returns (uint32)",
  "function latestHash() view returns (bytes32)",
  "function commitCount() view returns (uint256)",
  "function committer() view returns (address)",
]);

/** True when atomic string `a` <= `b` (cap checks). */
export function lteAtomic(a: string, b: string): boolean {
  return BigInt(a) <= BigInt(b);
}

/**
 * The EIP-712 message an authorization commits to, derived from its wire fields. Shared by BOTH the
 * internal signing path (settle) and the external relay path (settleExternal) so a browser-signed
 * authorization recovers to exactly the message we re-broadcast — validAfter is always 0 (immediately
 * valid) and validBefore is the authorization's maxDeadline.
 */
export function eip3009Message(auth: PaymentAuthorization): {
  from: Address; to: Address; value: bigint; validAfter: bigint; validBefore: bigint; nonce: Hex;
} {
  return {
    from: auth.from as Address,
    to: auth.to as Address,
    value: BigInt(auth.value),
    validAfter: 0n,
    validBefore: BigInt(auth.maxDeadline),
    nonce: toNonce32(auth.nonce),
  };
}

/**
 * Recover the signer of an EIP-3009 `transferWithAuthorization` (null on any failure). This is what
 * makes an EXTERNAL, browser-signed x402 payment safe to relay: before spending a wei of gas we recover
 * the address that actually signed and require it to equal the claimed payer, so a forged or garbage
 * payload is rejected for free and the relay wallet only ever broadcasts a transfer its payer signed.
 */
export async function recoverAuthorizationSigner(a: {
  domain: { name: string; version: string; chainId: number; verifyingContract: Address };
  auth: PaymentAuthorization;
  signature: Hex;
}): Promise<string | null> {
  try {
    return await recoverTypedDataAddress({
      domain: a.domain,
      types: EIP3009_TYPES,
      primaryType: "TransferWithAuthorization",
      message: eip3009Message(a.auth),
      signature: a.signature,
    });
  } catch {
    return null;
  }
}

// ============================== message shapes ==============================

/** What a resource server advertises when it demands payment (the body of a 402). */
export interface PaymentRequirements {
  scheme: typeof SCHEME_EXACT;
  network: string;
  /** Price in atomic USDC (6-decimal), as a decimal string — x402 amounts are always strings. */
  maxAmountRequired: string;
  /** The paid resource identifier (an HTTP(S) URL in real x402; here a good id like "signal:7"). */
  resource: string;
  description: string;
  mimeType: string;
  /** Recipient (seller) address. */
  payTo: string;
  maxTimeoutSeconds: number;
  /** The asset contract address (USDC). */
  asset: string;
  extra: Record<string, unknown>;
}

/** The EIP-3009-style authorization a client signs (here: simulated, unsigned). */
export interface PaymentAuthorization {
  scheme: typeof SCHEME_EXACT;
  version: number;
  /** Payer (buyer) address. */
  from: string;
  /** Recipient (seller) address — must equal the requirements' payTo. */
  to: string;
  /** Amount authorized, atomic USDC string — must be >= maxAmountRequired. */
  value: string;
  /** Unix seconds after which the authorization is void. */
  maxDeadline: number;
  /** 0x-prefixed unique nonce (replay protection). */
  nonce: string;
  asset: string;
  extra: Record<string, unknown>;
}

/** The full payment a client attaches in the PAYMENT-SIGNATURE header. */
export interface PaymentPayload {
  x402Version: number;
  scheme: typeof SCHEME_EXACT;
  network: string;
  payload: {
    /** 0x-prefixed signature. SIMULATED: a deterministic pseudo-signature, not a real key. */
    signature: string;
    authorization: PaymentAuthorization;
  };
}

/** The 402 response body (also what the PAYMENT-REQUIRED header carries, base64-encoded). */
export interface PaymentRequiredBody {
  x402Version: number;
  accepts: PaymentRequirements[];
  error?: string;
}

export interface VerifyResponse {
  valid: boolean;
  invalidReason?: string;
}

export interface SettleResponse {
  success: boolean;
  network: string;
  /** On-chain tx hash when real; a deterministic pseudo-hash (0x…) when simulated. */
  txHash: string;
  rawTransaction?: string;
  /** True when the settlement was executed by the keyless simulator (no chain state changed). */
  simulated?: boolean;
  /** True when the onchain facilitator signed + simulated but deliberately did NOT broadcast. */
  shadow?: boolean;
  /** Why a settlement failed (cap hit, insufficient balance, revert, …). Diagnostics only. */
  invalidReason?: string;
}

/**
 * A facilitator verifies and settles payments. Swap implementations to go from sim → real chain.
 * verify/settle are ASYNC: the simulated facilitator resolves immediately (same output as before),
 * while the onchain facilitator performs real RPC (balance reads, signing, submission, receipt wait).
 */
export interface Facilitator {
  readonly mode: "simulated" | "onchain";
  /** The USDC asset this facilitator settles against (0x0 placeholder when simulated). */
  readonly asset: string;
  verify(payload: PaymentPayload, reqs: PaymentRequirements): Promise<VerifyResponse>;
  settle(payload: PaymentPayload, reqs: PaymentRequirements): Promise<SettleResponse>;
}

// ============================== small helpers ==============================

/** Convert an atomic-USDC string to a human number (6 decimals). Display only. */
export function atomicToUsdc(atomic: string): number {
  return Number(atomic) / 1e6;
}

/** Convert a human USDC number to an atomic string (6 decimals), clamped at 0. */
export function usdcToAtomic(usdc: number): string {
  const a = Math.round(Math.max(0, usdc) * 1e6);
  return String(a);
}

/** BigInt add on atomic strings (balances/amounts are stored as strings so they JSON-serialize). */
export function addAtomic(a: string, b: string): string {
  return (BigInt(a) + BigInt(b)).toString();
}

/** BigInt subtract on atomic strings; floors at zero so a balance can never go negative. */
export function subAtomic(a: string, b: string): string {
  const d = BigInt(a) - BigInt(b);
  return (d < 0n ? 0n : d).toString();
}

/** True when atomic string `a` >= `b`. */
export function gteAtomic(a: string, b: string): boolean {
  return BigInt(a) >= BigInt(b);
}

/** base64 of a JSON value — the wire encoding x402 uses for its headers. */
export function b64json(value: unknown): string {
  const json = JSON.stringify(value);
  // btoa is present in the Workers runtime; encode UTF-8 safely for any non-ASCII description text.
  const bytes = new TextEncoder().encode(json);
  let bin = "";
  for (const byte of bytes) bin += String.fromCharCode(byte);
  return btoa(bin);
}

// ============================== payload builders ==============================

/** Build the 402 body a seller would return for a priced resource. */
export function buildPaymentRequired(reqs: PaymentRequirements, error?: string): PaymentRequiredBody {
  return { x402Version: X402_VERSION, accepts: [reqs], error };
}

export interface BuildPaymentArgs {
  reqs: PaymentRequirements;
  from: string;          // buyer address
  value: string;         // atomic amount the buyer authorizes (>= reqs.maxAmountRequired)
  nonce: string;         // 0x… unique per settlement
  nowSec: number;        // unix seconds
}

/**
 * Build the PaymentPayload a buyer attaches to its retried request. In real x402 the authorization is
 * EIP-3009-signed by the buyer's key; here we synthesize a DETERMINISTIC pseudo-signature from the
 * authorization fields so the flow is reproducible and — crucially — needs no private key.
 */
export function buildPaymentPayload(a: BuildPaymentArgs): PaymentPayload {
  const deadline = a.nowSec + a.reqs.maxTimeoutSeconds;
  const authorization: PaymentAuthorization = {
    scheme: SCHEME_EXACT,
    version: X402_VERSION,
    from: a.from,
    to: a.reqs.payTo,
    value: a.value,
    maxDeadline: deadline,
    nonce: a.nonce,
    asset: a.reqs.asset,
    extra: {},
  };
  return {
    x402Version: X402_VERSION,
    scheme: SCHEME_EXACT,
    network: a.reqs.network,
    payload: { signature: pseudoSignature(authorization), authorization },
  };
}

/**
 * Deterministic 65-byte-shaped pseudo-signature (0x + 130 hex) over the authorization. NOT a real
 * ECDSA signature and NOT verifiable on-chain — it exists so the simulated payload is byte-shaped like
 * a genuine one and reproducible from (from, to, value, nonce). FNV-1a doubled, padded.
 */
export function pseudoSignature(auth: PaymentAuthorization): string {
  const src = `${auth.from}|${auth.to}|${auth.value}|${auth.nonce}|${auth.maxDeadline}`;
  let h1 = 0x811c9dc5;
  let h2 = 0x01000193;
  const mix = (c: number) => {
    h1 = Math.imul(h1 ^ c, 0x01000193) >>> 0;
    h2 = Math.imul(h2 ^ c, 0x85ebca6b) >>> 0;
  };
  for (let i = 0; i < src.length; i++) mix(src.charCodeAt(i));
  // Stretch the two 32-bit hashes into a 130-hex-char body so it reads like r||s||v.
  let out = "";
  let s1 = h1 >>> 0;
  let s2 = h2 >>> 0;
  for (let i = 0; i < 32; i++) {
    s1 = (Math.imul(s1, 1664525) + 1013904223) >>> 0;
    s2 = (Math.imul(s2, 22695477) + 1) >>> 0;
    out += ((s1 ^ s2) >>> 0).toString(16).padStart(8, "0");
  }
  return "0x" + out.slice(0, 128) + "1b";
}

/** Deterministic pseudo tx-hash (0x + 64 hex) for a simulated settlement. */
export function pseudoTxHash(from: string, to: string, value: string, nonce: string): string {
  const src = `tx|${from}|${to}|${value}|${nonce}`;
  let h1 = 0x811c9dc5;
  let h2 = 0xc2b2ae35;
  const mix = (c: number) => {
    h1 = Math.imul(h1 ^ c, 0x01000193) >>> 0;
    h2 = Math.imul(h2 ^ c, 0x27d4eb2f) >>> 0;
  };
  for (let i = 0; i < src.length; i++) mix(src.charCodeAt(i));
  let out = "";
  let s1 = h1 >>> 0;
  let s2 = h2 >>> 0;
  for (let i = 0; i < 16; i++) {
    s1 = (Math.imul(s1, 1664525) + 1013904223) >>> 0;
    s2 = (Math.imul(s2, 22695477) + 1) >>> 0;
    out += ((s1 ^ s2) >>> 0).toString(16).padStart(8, "0");
  }
  return "0x" + out.slice(0, 64);
}

// ============================== facilitators ==============================

/**
 * The structural invariants BOTH facilitators enforce, in the same order with the same reasons, so a
 * payload rejected by the simulator is rejected identically on-chain. Pure and synchronous — no RPC.
 * (The wall-clock deadline is deliberately NOT checked here: the DO drives ticks, not request latency,
 * so a cron may run after the payload's nominal nowSec. On-chain the contract's own validBefore is the
 * authority; the onchain facilitator additionally guards value and balance.)
 */
export function checkPaymentInvariants(payload: PaymentPayload, reqs: PaymentRequirements): VerifyResponse {
  if (payload.x402Version !== X402_VERSION) return { valid: false, invalidReason: "unsupported x402Version" };
  if (payload.scheme !== SCHEME_EXACT) return { valid: false, invalidReason: `unsupported scheme ${payload.scheme}` };
  if (payload.network !== reqs.network) return { valid: false, invalidReason: "network mismatch" };
  const auth = payload.payload?.authorization;
  if (!auth) return { valid: false, invalidReason: "missing authorization" };
  if (auth.to.toLowerCase() !== reqs.payTo.toLowerCase()) return { valid: false, invalidReason: "payTo mismatch" };
  if (auth.asset.toLowerCase() !== reqs.asset.toLowerCase()) return { valid: false, invalidReason: "asset mismatch" };
  if (!gteAtomic(auth.value, reqs.maxAmountRequired)) return { valid: false, invalidReason: "value below maxAmountRequired" };
  if (auth.from.toLowerCase() === auth.to.toLowerCase()) return { valid: false, invalidReason: "payer equals payee" };
  if (!/^0x[0-9a-fA-F]{8,}$/.test(auth.nonce)) return { valid: false, invalidReason: "malformed nonce" };
  return { valid: true };
}

/**
 * The default, keyless facilitator. It enforces the SAME invariants a real one would (amount covers
 * the price, payer != payee, well-formed nonce) and, on settle, returns a deterministic pseudo txHash
 * WITHOUT touching any chain. It cannot move funds — there are none. verify/settle are async only to
 * satisfy the shared Facilitator interface; they resolve synchronously, so the simulated economy's
 * output is byte-for-byte what it has always been.
 */
export class SimulatedFacilitator implements Facilitator {
  readonly mode = "simulated" as const;
  readonly asset = ARC_USDC_SIMULATED;

  async verify(payload: PaymentPayload, reqs: PaymentRequirements): Promise<VerifyResponse> {
    return checkPaymentInvariants(payload, reqs);
  }

  async settle(payload: PaymentPayload, reqs: PaymentRequirements): Promise<SettleResponse> {
    const v = await this.verify(payload, reqs);
    if (!v.valid) return { success: false, network: reqs.network, txHash: "0x", simulated: true, invalidReason: v.invalidReason };
    const auth = payload.payload.authorization;
    return {
      success: true,
      network: reqs.network,
      txHash: pseudoTxHash(auth.from, auth.to, auth.value, auth.nonce),
      simulated: true,
    };
  }
}

/**
 * REAL Arc settlement via EIP-3009 `transferWithAuthorization`. The buyer agent signs an EIP-712
 * authorization with its own HD-derived key (no gas, no tx); this facilitator — holding ONLY the
 * gas-paying relay wallet — submits that signature to the Arc USDC precompile and pays gas in native
 * USDC. It never custodies buyer funds and can only ever move an amount the buyer explicitly signed.
 *
 * Safety rails (all injected from config):
 *   · maxAmountAtomic — hard per-deal ceiling; anything above is refused no matter what was signed.
 *   · shadowOnly — sign + eth_call the EXACT transfer to prove the key/domain/gas path works against
 *     live chain state, then stop. Nothing is broadcast, no funds move, no tx exists. This is how an
 *     operator validates real settlement at zero cost before letting a single wei go out.
 *   · The buyer's on-chain USDC balance is re-read immediately before signing, so a stale internal
 *     ledger can never spend USDC the wallet doesn't actually hold — the chain is the authority.
 *
 * Only ever constructed by makeFacilitator when mode==="onchain" AND full wiring is supplied; the
 * default simulated economy never touches this class.
 */
/**
 * Config for delegating USDC settlement to Circle's hosted Facilitator Service (see circle.ts). When
 * wired into OnChainFacilitator, the per-deal USDC broadcast is handed to Circle's relayer (which screens
 * both parties and pays the settlement gas) instead of this wallet — killing the self-funded gas wallet's
 * per-transfer cost on the hot path. Registry commits + arena open/resolve are NOT USDC transfers, so they
 * always still use this wallet. Absent ⇒ self-broadcast, byte-for-byte today's behaviour.
 */
export interface CircleBackendOpts {
  /** Circle API base URL (CIRCLE_PROD_URL = https://api.circle.com). */
  baseUrl: string;
  /** CAIP-2 network id Circle routes by: eip155:5042 (mainnet) / eip155:5042002 (testnet). */
  networkCaip2: string;
  /** Numeric chain id — the seller-proof EIP-712 domain's chainId. */
  chainId: number;
  /** Circle API key (Bearer, production). Null/absent ⇒ keyless trial via a payTo-signed seller proof. */
  apiKey?: string | null;
  /** Seconds Circle may wait for terminal settlement before returning pending (default 12). */
  maxTimeoutSeconds: number;
  /** Which settle paths route through Circle: "external" = the Arc Pulse seller side; "all" = + the internal agent economy. */
  scope: "external" | "all";
  /** Injectable fetch (tests). Defaults to the runtime global fetch. */
  fetchImpl?: typeof fetch;
}

export interface OnChainFacilitatorOpts {
  /** Real USDC precompile this settles against (ARC_USDC). */
  asset: Address;
  /** chainId for the EIP-712 domain (security-critical — must match the deployed token). */
  chainId: number;
  /** Read client: balanceOf, shadow eth_call, waitForTransactionReceipt. */
  publicClient: PublicClient;
  /** Gas-paying relay client (account + chain bound); submits the signed authorization. */
  wallet: WalletClient<Transport, Chain, LocalAccount>;
  /** Resolve a buyer's signing account from its address (the Worker derives all agents from one seed). */
  buyerAccount(address: Address): LocalAccount | undefined;
  /** EIP-712 domain overrides — Arc is a day-old chain; if signatures revert, tune these first. */
  domainName?: string;
  domainVersion?: string;
  /** Per-deal hard cap in atomic USDC; unset = no cap. */
  maxAmountAtomic?: string;
  /** Sign + simulate but never broadcast. */
  shadowOnly?: boolean;
  /** Pin gas price (Arc launched ~20 gwei); unset = let viem estimate. */
  gasPrice?: bigint;
  /** Receipt confirmations to await (default 1). */
  confirmations?: number;
  /**
   * Deployed NeuralReceiptRegistry to mirror each mined receipt onto (moves the hash-chain head
   * on-chain). Absent ⇒ no registry step; commits are silently skipped (zero behaviour change).
   */
  registryAddress?: Address;
  /**
   * Deployed PredictionArena to drive as the authorized resolver (open/resolve rounds). Absent ⇒ no
   * arena step; the resolver calls are silently skipped (zero behaviour change).
   */
  arenaAddress?: Address;
  /**
   * Deployed WarCoffer to drive as the authorized resolver (fund vaults, declare/resolve wars, levy the
   * extra on-chain tax). Absent ⇒ no war step; every coffer call is silently skipped (zero behaviour change).
   */
  warAddress?: Address;
  /**
   * Deployed ConnectomeLineage to mirror each bred genome onto (makes breeding ancestry a public,
   * tamper-evident on-chain fact). Absent ⇒ no lineage step; commits are silently skipped (zero change).
   */
  lineageAddress?: Address;
  /**
   * Optional Circle Facilitator Service backend. When set (and not shadowOnly), the USDC broadcast in
   * settle()/settleExternal() is delegated to Circle per `circle.scope`; everything else is unchanged.
   */
  circle?: CircleBackendOpts;
}

export class OnChainFacilitator implements Facilitator {
  readonly mode = "onchain" as const;
  readonly asset: string;
  private readonly o: OnChainFacilitatorOpts;
  private readonly domainName: string;
  private readonly domainVersion: string;

  constructor(o: OnChainFacilitatorOpts) {
    this.o = o;
    this.asset = o.asset;
    this.domainName = o.domainName ?? ARC_USDC_EIP712_NAME;
    this.domainVersion = o.domainVersion ?? ARC_USDC_EIP712_VERSION;
  }

  async verify(payload: PaymentPayload, reqs: PaymentRequirements): Promise<VerifyResponse> {
    // Fast structural gate (identical invariants to the simulator). The authoritative on-chain balance
    // check and the per-deal cap live in settle(), right before signing — the only point they can't be
    // stale. A "valid" here means "well-formed", not "funds confirmed".
    return checkPaymentInvariants(payload, reqs);
  }

  async settle(payload: PaymentPayload, reqs: PaymentRequirements): Promise<SettleResponse> {
    const net = reqs.network;
    const fail = (invalidReason: string): SettleResponse =>
      ({ success: false, network: net, txHash: "0x", invalidReason });
    try {
      const v = checkPaymentInvariants(payload, reqs);
      if (!v.valid) return fail(v.invalidReason ?? "invalid payload");
      const auth = payload.payload.authorization;

      const from = auth.from as Address;
      const to = auth.to as Address;
      const value = BigInt(auth.value);

      // Per-deal hard cap — defense-in-depth regardless of what the economy priced or the buyer signed.
      if (this.o.maxAmountAtomic != null && !lteAtomic(auth.value, this.o.maxAmountAtomic)) {
        return fail(`value ${auth.value} exceeds facilitator per-deal cap ${this.o.maxAmountAtomic}`);
      }

      // Resolve the buyer's signing key. If the payer address doesn't map to a derived signer we CANNOT
      // produce a real authorization — refuse outright (never fall back to the pseudo-signature here).
      const buyer = this.o.buyerAccount(from);
      if (!buyer) return fail(`no signer for payer ${from}`);

      // Authoritative on-chain balance read: the buyer must actually hold the USDC right now.
      const bal = await this.o.publicClient.readContract({
        address: this.o.asset,
        abi: erc20Abi,
        functionName: "balanceOf",
        args: [from],
      });
      if (bal < value) return fail(`insufficient on-chain USDC: have ${bal}, need ${value}`);

      // Sign the EIP-3009 authorization (gasless — only a signature is produced here, by the buyer).
      const validAfter = 0n;
      const validBefore = BigInt(auth.maxDeadline);
      const nonce32 = toNonce32(auth.nonce);
      const signature = await buyer.signTypedData({
        domain: {
          name: this.domainName,
          version: this.domainVersion,
          chainId: this.o.chainId,
          verifyingContract: this.o.asset,
        },
        types: EIP3009_TYPES,
        primaryType: "TransferWithAuthorization",
        message: { from, to, value, validAfter, validBefore, nonce: nonce32 },
      });
      const { r, s, v: vByte } = parseSignature(signature);
      const args: [Address, Address, bigint, bigint, bigint, Hex, number, Hex, Hex] =
        [from, to, value, validAfter, validBefore, nonce32, Number(vByte), r, s];

      // Shadow mode: eth_call the EXACT relay to prove signature + domain + gas path work, then stop.
      if (this.o.shadowOnly) {
        const data = encodeFunctionData({
          abi: fiatTokenV2Abi,
          functionName: "transferWithAuthorization",
          args,
        });
        await this.o.publicClient.call({
          account: this.o.wallet.account.address,
          to: this.o.asset,
          data,
        });
        return { success: true, network: net, txHash: "0x", simulated: true, shadow: true };
      }

      // Circle Facilitator Service (scope "all"): delegate the USDC broadcast to Circle's relayer, which
      // screens both parties and pays the settlement gas. Our wallet is untouched for this transfer.
      if (this.o.circle && this.o.circle.scope === "all") return this.settleViaCircle(signature, auth, reqs);

      // Broadcast. writeContract runs eth_estimateGas first — an implicit shadow-verify that throws if
      // the transfer would revert (bad signature / domain / reused nonce), so nothing is sent on a
      // would-be failure. Arc has deterministic finality, so a mined receipt needs no reorg handling.
      const hash = await this.o.wallet.writeContract({
        address: this.o.asset,
        abi: fiatTokenV2Abi,
        functionName: "transferWithAuthorization",
        args,
        ...(this.o.gasPrice != null ? { gasPrice: this.o.gasPrice } : {}),
      });

      const receipt = await this.o.publicClient.waitForTransactionReceipt({
        hash,
        confirmations: this.o.confirmations ?? 1,
        timeout: RECEIPT_TIMEOUT_MS,
      });
      return { success: receipt.status === "success", network: net, txHash: hash, simulated: false };
    } catch (err) {
      // A cron tick must never crash on one bad deal. If a throw happens after broadcast the tx MAY have
      // mined; we report failure and rely on the next deal's authoritative balance read to stay honest.
      const msg = err instanceof Error ? err.message : String(err);
      return fail(`onchain settle error: ${msg}`);
    }
  }

  /** The EIP-712 domain this facilitator signs/recovers against (name+version overridable for Arc). */
  private eip3009Domain() {
    return {
      name: this.domainName,
      version: this.domainVersion,
      chainId: this.o.chainId,
      verifyingContract: this.o.asset,
    };
  }

  /**
   * Settle an EXTERNAL x402 payment — the canonical facilitator role for a paid data product. Unlike
   * settle() (which re-signs with a Worker-derived agent key), here the PAYER is an outside wallet
   * (a browser) that signed the EIP-3009 authorization with its OWN key, delivered in
   * payload.payload.signature. We NEVER hold that key: we only recover the signer, require it to equal
   * the claimed payer, re-read the payer's real on-chain balance, then relay the exact authorization and
   * pay gas. Safety: structural invariants + per-deal cap + signature recovery + balance all gate the
   * broadcast, so a forged/underfunded/oversized payload is rejected for free (no gas spent).
   */
  async settleExternal(reqs: PaymentRequirements, payload: PaymentPayload): Promise<SettleResponse> {
    const net = reqs.network;
    const fail = (invalidReason: string): SettleResponse =>
      ({ success: false, network: net, txHash: "0x", invalidReason });
    try {
      const v = checkPaymentInvariants(payload, reqs);
      if (!v.valid) return fail(v.invalidReason ?? "invalid payload");
      const auth = payload.payload.authorization;
      const signature = (payload.payload.signature ?? "") as Hex;
      if (!/^0x[0-9a-fA-F]{130}$/.test(signature)) return fail("malformed signature");

      const from = auth.from as Address;
      const to = auth.to as Address;
      const value = BigInt(auth.value);

      // Per-deal hard cap — an outside caller can never make the relay move more than this.
      if (this.o.maxAmountAtomic != null && !lteAtomic(auth.value, this.o.maxAmountAtomic)) {
        return fail(`value ${auth.value} exceeds per-deal cap ${this.o.maxAmountAtomic}`);
      }

      // Recover the signer; it MUST be the claimed payer. This is the trust anchor for external payments.
      const recovered = await recoverAuthorizationSigner({ domain: this.eip3009Domain(), auth, signature });
      if (!recovered || recovered.toLowerCase() !== from.toLowerCase()) {
        return fail("signature does not match payer");
      }

      // Authoritative on-chain balance read: the payer must actually hold the USDC right now.
      const bal = await this.o.publicClient.readContract({
        address: this.o.asset, abi: erc20Abi, functionName: "balanceOf", args: [from],
      });
      if (bal < value) return fail(`insufficient on-chain USDC: have ${bal}, need ${value}`);

      const { r, s, v: vByte } = parseSignature(signature);
      const msg = eip3009Message(auth);
      const args: [Address, Address, bigint, bigint, bigint, Hex, number, Hex, Hex] =
        [from, to, value, msg.validAfter, msg.validBefore, msg.nonce, Number(vByte), r, s];

      if (this.o.shadowOnly) {
        const data = encodeFunctionData({ abi: fiatTokenV2Abi, functionName: "transferWithAuthorization", args });
        await this.o.publicClient.call({ account: this.o.wallet.account.address, to: this.o.asset, data });
        return { success: true, network: net, txHash: "0x", simulated: true, shadow: true };
      }

      // Circle Facilitator Service (scope "external" or "all"): an OUTSIDE wallet signed this with its own
      // key; hand the authorization to Circle's relayer to screen + broadcast + pay gas (we never relay it).
      if (this.o.circle) return this.settleViaCircle(signature, auth, reqs);

      const hash = await this.o.wallet.writeContract({
        address: this.o.asset,
        abi: fiatTokenV2Abi,
        functionName: "transferWithAuthorization",
        args,
        ...(this.o.gasPrice != null ? { gasPrice: this.o.gasPrice } : {}),
      });
      const receipt = await this.o.publicClient.waitForTransactionReceipt({
        hash, confirmations: this.o.confirmations ?? 1, timeout: RECEIPT_TIMEOUT_MS,
      });
      return { success: receipt.status === "success", network: net, txHash: hash, simulated: false };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return fail(`external settle error: ${msg}`);
    }
  }

  /**
   * Delegate the USDC transfer to Circle's hosted Facilitator Service (POST /v1/facilitator/x402/settle).
   * Circle's relayer validates the buyer's EIP-3009 signature + balance, screens both parties, submits the
   * transfer on-chain, and pays the settlement gas — so THIS wallet never broadcasts or funds the payment.
   * We sign the buyer authorization exactly as before (settle) or forward the browser's signature
   * (settleExternal); only the broadcast hop changes. Auth is exactly one mode: Bearer when a Circle API
   * key is configured, else a keyless seller proof signed by the payTo key we hold. Arc settlements are
   * final, so a 200 success needs no reorg handling; a pending outcome is reported as a soft failure so the
   * netting ledger never moves without a mined receipt, and the payment-identifier (= the authorization
   * nonce) makes a retry converge on the same Circle payment instead of double-charging.
   */
  private async settleViaCircle(
    signature: Hex,
    auth: PaymentAuthorization,
    reqs: PaymentRequirements,
  ): Promise<SettleResponse> {
    const c = this.o.circle!;
    const net = reqs.network;
    const fail = (invalidReason: string): SettleResponse =>
      ({ success: false, network: net, txHash: "0x", invalidReason });
    try {
      const nonce32 = toNonce32(auth.nonce);
      const payTo = auth.to as Address;
      const { bodyStr } = buildCircleSettleBody({
        networkCaip2: c.networkCaip2,
        asset: this.o.asset,
        payTo: auth.to,
        amount: auth.value,                 // exact scheme: amount == authorization.value
        maxTimeoutSeconds: c.maxTimeoutSeconds,
        signature,
        from: auth.from,
        to: auth.to,
        value: auth.value,
        validAfter: "0",
        validBefore: String(auth.maxDeadline),
        nonce32,
        resourceUrl: typeof reqs.resource === "string" && /^https?:\/\//i.test(reqs.resource) ? reqs.resource : undefined,
        resourceDescription: reqs.description,
        resourceMime: reqs.mimeType,
        idempotencyId: nonce32.slice(2),     // 64 hex chars ⊂ [A-Za-z0-9_-], within Circle's 16–128 bound
      });

      // Exactly one auth mode. Bearer when an API key is set; else a keyless seller proof from the payTo key.
      let headers: Record<string, string>;
      if (c.apiKey) {
        headers = circleAuthHeaders({ apiKey: c.apiKey });
      } else {
        const seller =
          payTo.toLowerCase() === this.o.wallet.account.address.toLowerCase()
            ? this.o.wallet.account
            : this.o.buyerAccount(payTo);
        if (!seller) return fail(`keyless Circle settle needs the payTo key; none for ${auth.to}`);
        const proof = await signSellerProof({
          account: seller,
          purpose: "settle",
          method: "POST",
          bodyStr,
          networkCaip2: c.networkCaip2,
          payTo,
          chainId: c.chainId,
        });
        headers = circleAuthHeaders({ sellerProof: proof });
      }

      const resp = await (c.fetchImpl ?? fetch)(`${c.baseUrl}${CIRCLE_SETTLE_PATH}`, {
        method: "POST",
        headers,
        body: bodyStr,
      });
      const json = await resp.json().catch(() => null);
      const parsed = parseSettleResponse(resp.status, json);
      if (parsed.kind === "success") {
        return { success: true, network: net, txHash: parsed.txHash, simulated: false };
      }
      if (parsed.kind === "pending") {
        return fail(`circle settlement_pending${parsed.paymentId ? ` id=${parsed.paymentId}` : ""}`);
      }
      if (parsed.kind === "failed") return fail(`circle: ${parsed.reason}`);
      return fail(
        `circle http ${parsed.status}${parsed.reasons.length ? ` ${parsed.reasons.join(",")}` : ` ${parsed.message}`}`,
      );
    } catch (err) {
      return fail(`circle settle error: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /**
   * The gas-paying relay wallet address. Doubles as the default `payTo` for paid data products, since it
   * is the address the operator controls and already funds for gas.
   */
  get relayAddress(): string {
    return this.o.wallet.account.address;
  }

  /**
   * Read the EIP-3009 `nonce` actually mined on-chain for a transfer (the neural-provenance commitment),
   * straight from the calldata. Returns 64 lowercase hex chars (no 0x), or null if the tx is missing or
   * isn't a transferWithAuthorization. Used by /proofs/verify to confirm a published receiptHash matches
   * what the chain recorded — the crux of "the neurons, not a human, signed this".
   */
  async authorizationNonceOf(txHash: string): Promise<string | null> {
    try {
      const tx = await this.o.publicClient.getTransaction({ hash: txHash as Hex });
      if (!tx) return null;
      return nonceFromCalldata(tx.input);
    } catch {
      return null;
    }
  }

  // ============================== on-chain receipt registry ==============================
  //
  // These mirror the neural receipt hash-chain onto our OWN NeuralReceiptRegistry contract, so a
  // verifier can rebuild the ordered chain from Arc RPC events alone. Every call is BEST-EFFORT: a
  // registry hiccup must never fail or delay a settlement that already mined — the authoritative
  // on-chain commitment is the transfer's EIP-3009 nonce (see authorizationNonceOf), and the registry
  // only adds chain-ordering on top. All failures degrade to null.

  /** True when a registry is wired for this facilitator. */
  get hasRegistry(): boolean {
    return this.o.registryAddress != null;
  }

  /**
   * Register one mined receipt as the new on-chain chain head. Enforced by the contract to satisfy
   * prevHead == chainHead, so out-of-order or duplicate commits revert and simply return null here.
   * Returns the commit tx hash on success, or null when there is no registry / the commit failed.
   */
  async commitReceipt(a: {
    receiptHash: string;   // 64-hex sha256 (no 0x) — becomes the new chainHead
    prevHead: string;      // 64-hex predecessor, or "" for the very first (genesis-seeded) link
    tickIndex: number;
    constituents: number;
    txHash: string;        // 0x…64 EIP-3009 transfer whose nonce == receiptHash
  }): Promise<string | null> {
    if (!this.o.registryAddress) return null;
    try {
      // Lazy genesis: the worker flushes continuously, so its off-chain head moves between deploy and
      // first commit. Rather than seed a head that would already be stale (breaking continuity forever),
      // the worker — which IS the committer — adopts its OWN current prevHead the instant the registry
      // is still empty. No race, no gap: the on-chain chain starts exactly where the off-chain one is.
      await this.ensureGenesisSeeded(a.prevHead);
      const hash = await this.o.wallet.writeContract({
        address: this.o.registryAddress,
        abi: neuralReceiptRegistryAbi,
        functionName: "commit",
        args: [
          toBytes32(a.receiptHash),
          toBytes32(a.prevHead),
          BigInt(Math.max(0, Math.floor(a.tickIndex))),
          Math.max(0, Math.floor(a.constituents)),
          toBytes32(a.txHash),
        ],
        ...(this.o.gasPrice != null ? { gasPrice: this.o.gasPrice } : {}),
      });
      const receipt = await this.o.publicClient.waitForTransactionReceipt({
        hash,
        confirmations: this.o.confirmations ?? 1,
        timeout: REGISTRY_RECEIPT_TIMEOUT_MS,
      });
      return receipt.status === "success" ? hash : null;
    } catch {
      return null;
    }
  }

  /**
   * One-shot lazy genesis: if the registry's chainHead is still bytes32(0), adopt `prevHead` as the
   * starting anchor so the first commit chains onto the worker's existing off-chain history. Best-
   * effort — any failure just means the following commit reverts (BadPrevHead) and returns null.
   */
  private async ensureGenesisSeeded(prevHead: string): Promise<void> {
    const addr = this.o.registryAddress;
    if (!addr) return;
    const ZERO32 = `0x${"00".repeat(32)}`;
    try {
      const head = (await this.o.publicClient.readContract({
        address: addr, abi: neuralReceiptRegistryAbi, functionName: "chainHead",
      })) as string;
      if (head.toLowerCase() !== ZERO32) return;         // already seeded or committed
      const anchor = toBytes32(prevHead);
      if (anchor.toLowerCase() === ZERO32) return;        // nothing to adopt; chain legitimately starts at 0
      const h = await this.o.wallet.writeContract({
        address: addr, abi: neuralReceiptRegistryAbi, functionName: "seedGenesis", args: [anchor],
        ...(this.o.gasPrice != null ? { gasPrice: this.o.gasPrice } : {}),
      });
      await this.o.publicClient.waitForTransactionReceipt({
        hash: h, confirmations: this.o.confirmations ?? 1, timeout: REGISTRY_RECEIPT_TIMEOUT_MS,
      });
    } catch {
      /* best-effort */
    }
  }

  /** Read one committed link from the registry (null when no registry / not committed / RPC error). */
  async registryCommitOf(receiptHash: string): Promise<RegistryCommit | null> {
    if (!this.o.registryAddress) return null;
    try {
      const c = await this.o.publicClient.readContract({
        address: this.o.registryAddress,
        abi: neuralReceiptRegistryAbi,
        functionName: "commits",
        args: [toBytes32(receiptHash)],
      });
      const [prevHead, tickIndex, constituents, txHash, ts] = c as [Hex, bigint, number, Hex, bigint];
      const commit: RegistryCommit = {
        prevHead,
        tickIndex: Number(tickIndex),
        constituents: Number(constituents),
        txHash,
        ts: Number(ts),
      };
      return commit.ts === 0 ? null : commit;
    } catch {
      return null;
    }
  }

  /** Read the registry's current chain head (0x…64), or null when no registry / RPC error. */
  async registryChainHead(): Promise<string | null> {
    if (!this.o.registryAddress) return null;
    try {
      const head = await this.o.publicClient.readContract({
        address: this.o.registryAddress,
        abi: neuralReceiptRegistryAbi,
        functionName: "chainHead",
      });
      return head as string;
    } catch {
      return null;
    }
  }

  // ============================== on-chain prediction arena ==============================
  //
  // The human side of the prediction market (contracts/PredictionArena.sol), denominated in MURMUR and
  // non-custodial: the contract escrows bets and pays winners; the Worker only acts as the authorized
  // resolver that commits each round's baseline temperature and later its exit. Every call is BEST-EFFORT
  // and degrades to null — an arena hiccup must never delay or fail the live tick (mirrors commitReceipt).

  /** True when a PredictionArena is wired for this facilitator. */
  get hasArena(): boolean {
    return this.o.arenaAddress != null;
  }

  /**
   * Open an arena round, committing its baseline temperature + flat band on-chain BEFORE anyone can bet
   * on the exit (so the outcome is pinned to numbers fixed in advance). Returns the tx hash, or null when
   * no arena is wired / the call failed — a round that fails to open simply never accepts bets.
   */
  async arenaOpen(roundId: number, entryTempR6: number, flatBandR6: number, betDeadline: number): Promise<string | null> {
    const addr = this.o.arenaAddress;
    if (!addr) return null;
    try {
      const hash = await this.o.wallet.writeContract({
        address: addr,
        abi: predictionArenaAbi,
        functionName: "openRound",
        args: [BigInt(roundId), BigInt(entryTempR6), BigInt(flatBandR6), BigInt(betDeadline)],
        ...(this.o.gasPrice != null ? { gasPrice: this.o.gasPrice } : {}),
      });
      const receipt = await this.o.publicClient.waitForTransactionReceipt({
        hash, confirmations: this.o.confirmations ?? 1, timeout: REGISTRY_RECEIPT_TIMEOUT_MS,
      });
      return receipt.status === "success" ? hash : null;
    } catch {
      return null;
    }
  }

  /**
   * Resolve an arena round by supplying ONLY the exit temperature; the contract derives UP/DOWN/FLAT from
   * the entry + flat band committed at open, so the resolver cannot fudge the outcome. Returns the tx hash,
   * or null on any failure (the round stays open and, if never resolved, is refundable after the grace).
   */
  async arenaResolve(roundId: number, exitTempR6: number): Promise<string | null> {
    const addr = this.o.arenaAddress;
    if (!addr) return null;
    try {
      const hash = await this.o.wallet.writeContract({
        address: addr, abi: predictionArenaAbi, functionName: "resolve",
        args: [BigInt(roundId), BigInt(exitTempR6)],
        ...(this.o.gasPrice != null ? { gasPrice: this.o.gasPrice } : {}),
      });
      const receipt = await this.o.publicClient.waitForTransactionReceipt({
        hash, confirmations: this.o.confirmations ?? 1, timeout: REGISTRY_RECEIPT_TIMEOUT_MS,
      });
      return receipt.status === "success" ? hash : null;
    } catch {
      return null;
    }
  }

  /** Read an arena round's live state (pools/outcome/timing) for the /arena endpoint; null when unwired. */
  async arenaRoundInfo(roundId: number): Promise<ArenaRoundInfo | null> {
    const addr = this.o.arenaAddress;
    if (!addr) return null;
    try {
      const r = (await this.o.publicClient.readContract({
        address: addr, abi: predictionArenaAbi, functionName: "roundInfo", args: [BigInt(roundId)],
      })) as readonly [boolean, boolean, number, bigint, bigint, bigint, bigint, bigint, bigint, bigint, bigint, bigint];
      return {
        opened: r[0],
        resolved: r[1],
        outcome: Number(r[2]),
        entryTemp: Number(r[3]) / 1e6,
        exitTemp: Number(r[4]) / 1e6,
        flatBand: Number(r[5]) / 1e6,
        betDeadline: Number(r[6]),
        openedAt: Number(r[7]),
        resolvedAt: Number(r[8]),
        poolUp: r[9].toString(),
        poolDown: r[10].toString(),
        bettorCount: Number(r[11]),
      };
    } catch {
      return null;
    }
  }

  // ---------- on-chain house WAR + TAXATION (real-USDC escrow; the coffer derives the winner) ----------
  //
  // Thin, best-effort delegators to the facilitator's WarCoffer wiring. The Worker is only the authorized
  // resolver that funds vaults, triggers declare/resolve and posts the tax levy — the coffer escrows the
  // stakes, derives the winner from the committed powers and moves the money itself. Every call returns the
  // tx hash on a MINED success or null (unwired / reverted / shadow), so a move that never lands changes
  // nothing on the ledger mirror (mirrors fundOffspring's degrade-to-null discipline).

  /**
   * Back a house's on-chain vault with real USDC, up to the coffer's hard cap. The facilitator wallet must
   * first grant the coffer an allowance, so this best-effort ensures it (one approve tx when short) then
   * calls deposit(). Returns the deposit tx hash on success, or null when unwired / capped / failed.
   */
  async cofferDeposit(houseId: number, amountAtomic: bigint): Promise<string | null> {
    const addr = this.o.warAddress;
    if (!addr || amountAtomic <= 0n) return null;
    try {
      const owner = this.o.wallet.account.address;
      const gas = this.o.gasPrice != null ? { gasPrice: this.o.gasPrice } : {};
      const allow = (await this.o.publicClient.readContract({
        address: this.o.asset, abi: usdcErc20Abi, functionName: "allowance", args: [owner, addr],
      })) as bigint;
      if (allow < amountAtomic) {
        const ah = await this.o.wallet.writeContract({
          address: this.o.asset, abi: usdcErc20Abi, functionName: "approve", args: [addr, amountAtomic], ...gas,
        });
        const ar = await this.o.publicClient.waitForTransactionReceipt({
          hash: ah, confirmations: this.o.confirmations ?? 1, timeout: REGISTRY_RECEIPT_TIMEOUT_MS,
        });
        if (ar.status !== "success") return null;
      }
      const hash = await this.o.wallet.writeContract({
        address: addr, abi: warCofferAbi, functionName: "deposit",
        args: [BigInt(houseId), amountAtomic], ...gas,
      });
      const receipt = await this.o.publicClient.waitForTransactionReceipt({
        hash, confirmations: this.o.confirmations ?? 1, timeout: REGISTRY_RECEIPT_TIMEOUT_MS,
      });
      return receipt.status === "success" ? hash : null;
    } catch {
      return null;
    }
  }

  /**
   * Declare a war: escrow both stakes and COMMIT the two houses' powers + a resolve deadline on-chain, before
   * any outcome exists. The winner is later derived by the coffer purely from these inputs, so this is the
   * one moment the resolver influences a war — and only by reporting public read-outs, never a choice. All
   * amounts are atomic 6-dec USDC; powers are the integers from war.ts housePower. Returns the tx hash or null.
   */
  async declareWar(a: {
    warId: number; attacker: number; defender: number;
    stakeAtomic: bigint; powerA: number; powerB: number; deadline: number;
  }): Promise<string | null> {
    const addr = this.o.warAddress;
    if (!addr) return null;
    try {
      const hash = await this.o.wallet.writeContract({
        address: addr, abi: warCofferAbi, functionName: "declareWar",
        args: [BigInt(a.warId), BigInt(a.attacker), BigInt(a.defender), a.stakeAtomic, BigInt(a.powerA), BigInt(a.powerB), BigInt(a.deadline)],
        ...(this.o.gasPrice != null ? { gasPrice: this.o.gasPrice } : {}),
      });
      const receipt = await this.o.publicClient.waitForTransactionReceipt({
        hash, confirmations: this.o.confirmations ?? 1, timeout: REGISTRY_RECEIPT_TIMEOUT_MS,
      });
      return receipt.status === "success" ? hash : null;
    } catch {
      return null;
    }
  }

  /** Resolve a declared war once its deadline passed — supplies NOTHING, the coffer derives the winner. */
  async resolveWar(warId: number): Promise<string | null> {
    const addr = this.o.warAddress;
    if (!addr) return null;
    try {
      const hash = await this.o.wallet.writeContract({
        address: addr, abi: warCofferAbi, functionName: "resolveWar", args: [BigInt(warId)],
        ...(this.o.gasPrice != null ? { gasPrice: this.o.gasPrice } : {}),
      });
      const receipt = await this.o.publicClient.waitForTransactionReceipt({
        hash, confirmations: this.o.confirmations ?? 1, timeout: REGISTRY_RECEIPT_TIMEOUT_MS,
      });
      return receipt.status === "success" ? hash : null;
    } catch {
      return null;
    }
  }

  /** Levy an extra on-chain tax from a house vault into the commons purse (internal move; no USDC crosses). */
  async levyTax(houseId: number, amountAtomic: bigint): Promise<string | null> {
    const addr = this.o.warAddress;
    if (!addr || amountAtomic <= 0n) return null;
    try {
      const hash = await this.o.wallet.writeContract({
        address: addr, abi: warCofferAbi, functionName: "levyTax", args: [BigInt(houseId), amountAtomic],
        ...(this.o.gasPrice != null ? { gasPrice: this.o.gasPrice } : {}),
      });
      const receipt = await this.o.publicClient.waitForTransactionReceipt({
        hash, confirmations: this.o.confirmations ?? 1, timeout: REGISTRY_RECEIPT_TIMEOUT_MS,
      });
      return receipt.status === "success" ? hash : null;
    } catch {
      return null;
    }
  }

  /** Sweep the accumulated commons purse into a house vault (used when taxDest === "dominant"). */
  async sweepTax(houseId: number): Promise<string | null> {
    const addr = this.o.warAddress;
    if (!addr) return null;
    try {
      const hash = await this.o.wallet.writeContract({
        address: addr, abi: warCofferAbi, functionName: "sweepTo", args: [BigInt(houseId)],
        ...(this.o.gasPrice != null ? { gasPrice: this.o.gasPrice } : {}),
      });
      const receipt = await this.o.publicClient.waitForTransactionReceipt({
        hash, confirmations: this.o.confirmations ?? 1, timeout: REGISTRY_RECEIPT_TIMEOUT_MS,
      });
      return receipt.status === "success" ? hash : null;
    } catch {
      return null;
    }
  }

  /** Read one war's live on-chain state (committed powers / pot / winner) for the /war endpoint; null if unwired. */
  async warInfo(warId: number): Promise<WarInfo | null> {
    const addr = this.o.warAddress;
    if (!addr) return null;
    try {
      const r = (await this.o.publicClient.readContract({
        address: addr, abi: warCofferAbi, functionName: "warInfo", args: [BigInt(warId)],
      })) as readonly [boolean, boolean, number, bigint, bigint, bigint, bigint, bigint, bigint, bigint, bigint, bigint];
      return {
        opened: r[0],
        resolved: r[1],
        winner: Number(r[2]),
        attacker: r[3].toString(),
        defender: r[4].toString(),
        stake: r[5].toString(),
        powerA: r[6].toString(),
        powerB: r[7].toString(),
        pot: r[8].toString(),
        deadline: Number(r[9]),
        openedAt: Number(r[10]),
        resolvedAt: Number(r[11]),
      };
    } catch {
      return null;
    }
  }

  /** Read a house's on-chain vault (atomic USDC string) for the /war endpoint; null when unwired/unreadable. */
  async cofferVault(houseId: number): Promise<string | null> {
    const addr = this.o.warAddress;
    if (!addr) return null;
    try {
      const v = (await this.o.publicClient.readContract({
        address: addr, abi: warCofferAbi, functionName: "vault", args: [BigInt(houseId)],
      })) as bigint;
      return v.toString();
    } catch {
      return null;
    }
  }

  /** Read the coffer's aggregate totals (purse / escrow / cap / counter) for the /war endpoint; null if unwired. */
  async cofferStats(): Promise<WarCofferStats | null> {
    const addr = this.o.warAddress;
    if (!addr) return null;
    try {
      const read = async (fn: "commonsPurse" | "totalEscrow" | "warCount" | "escrow" | "maxEscrow") =>
        ((await this.o.publicClient.readContract({
          address: addr, abi: warCofferAbi, functionName: fn,
        })) as bigint).toString();
      return {
        commonsPurse: await read("commonsPurse"),
        totalEscrow: await read("totalEscrow"),
        warCount: await read("warCount"),
        escrow: await read("escrow"),
        maxEscrow: await read("maxEscrow"),
      };
    } catch {
      return null;
    }
  }


  /**
   * Commit one bred connectome genome + its ancestry to the ConnectomeLineage log. Mirrors commitReceipt:
   * BEST-EFFORT — a lineage hiccup must never fail the breed that produced the genome (the authoritative
   * identity is the genome hash itself, reproducible offline; the contract only makes ancestry public and
   * tamper-evident). op is 0 genesis / 1 mutate / 2 cross; parentB is "" unless op === 2. The contract
   * enforces that both parents are already committed and that generation == max(parents)+1, so a forged or
   * generation-skipping child simply reverts and returns null here. Returns the commit tx hash, or null.
   */
  async commitLineage(a: {
    genomeHash: string;   // 64-hex sha256(canonical(genome)), no 0x
    parentA: string;      // 64-hex, or "" for genesis
    parentB: string;      // 64-hex, or "" unless op === 2
    op: 0 | 1 | 2;        // genesis | mutate | cross
    generation: number;
    breeder: string;      // 0x…40 credited breeder (the contract rejects address(0))
  }): Promise<string | null> {
    const addr = this.o.lineageAddress;
    if (!addr) return null;
    try {
      const hash = await this.o.wallet.writeContract({
        address: addr,
        abi: connectomeLineageAbi,
        functionName: "commit",
        args: [
          toBytes32(a.genomeHash),
          toBytes32(a.parentA || ""),
          toBytes32(a.parentB || ""),
          a.op,
          Math.max(0, Math.floor(a.generation)),
          a.breeder as Address,
        ],
        ...(this.o.gasPrice != null ? { gasPrice: this.o.gasPrice } : {}),
      });
      const receipt = await this.o.publicClient.waitForTransactionReceipt({
        hash, confirmations: this.o.confirmations ?? 1, timeout: REGISTRY_RECEIPT_TIMEOUT_MS,
      });
      return receipt.status === "success" ? hash : null;
    } catch {
      return null;
    }
  }

  /** Read one committed genome's on-chain ancestry (null when no lineage contract / not committed / RPC error). */
  async lineageOf(genomeHash: string): Promise<{
    parentA: string; parentB: string; op: number; generation: number; breeder: string; ts: number;
  } | null> {
    const addr = this.o.lineageAddress;
    if (!addr) return null;
    try {
      const r = (await this.o.publicClient.readContract({
        address: addr, abi: connectomeLineageAbi, functionName: "lineages", args: [toBytes32(genomeHash)],
      })) as readonly [Hex, Hex, Hex, number, number, Address, bigint];
      const ts = Number(r[6]);
      if (ts === 0) return null;   // never committed
      return {
        parentA: r[1], parentB: r[2], op: Number(r[3]),
        generation: Number(r[4]), breeder: r[5], ts,
      };
    } catch {
      return null;
    }
  }
}

/**
 * Build a facilitator. "simulated" (default) needs nothing and moves no funds. "onchain" REQUIRES full
 * wiring (publicClient + gas wallet + buyer signers); asked for without it, this throws at construction
 * rather than silently degrading — real money can never be half-enabled by accident.
 */
export function makeFacilitator(
  mode: "simulated" | "onchain" = "simulated",
  onchain?: OnChainFacilitatorOpts,
): Facilitator {
  if (mode === "onchain") {
    if (!onchain) {
      throw new Error(
        "makeFacilitator(onchain) requires wiring (asset, chainId, publicClient, wallet, buyerAccount). Refusing to start keyless.",
      );
    }
    return new OnChainFacilitator(onchain);
  }
  return new SimulatedFacilitator();
}
