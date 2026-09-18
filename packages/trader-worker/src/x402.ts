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
  type Address,
  type Chain,
  type Hex,
  type LocalAccount,
  type PublicClient,
  type Transport,
  type WalletClient,
} from "viem";
import { nonceFromCalldata } from "./provenance.js";

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

/** True when atomic string `a` <= `b` (cap checks). */
export function lteAtomic(a: string, b: string): boolean {
  return BigInt(a) <= BigInt(b);
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
      });
      return { success: receipt.status === "success", network: net, txHash: hash, simulated: false };
    } catch (err) {
      // A cron tick must never crash on one bad deal. If a throw happens after broadcast the tx MAY have
      // mined; we report failure and rely on the next deal's authoritative balance read to stay honest.
      const msg = err instanceof Error ? err.message : String(err);
      return fail(`onchain settle error: ${msg}`);
    }
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
