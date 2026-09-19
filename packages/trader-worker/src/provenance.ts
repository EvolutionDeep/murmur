// Neural provenance — the cryptographic link between "a spiking connectome decided this" and
// "this exact USDC moved on Arc".
//
// THE PROBLEM IT SOLVES. A sceptic can always ask: "how do I know a human or an LLM didn't place
// these trades, and the neurons are theatre?" Open source alone doesn't answer it, because the
// operator could in principle run different code than what is published. Provenance closes that gap
// with a commitment that lives ON-CHAIN and therefore cannot be retrofitted after the fact:
//
//   1. At the instant a trade is queued we freeze the neural read-out that produced it (the buyer's
//      and seller's decoded drives + neural fingerprints) into a `NeuralConstituent` and hash it
//      (decisionHash). The decision policy version is mixed in, so a policy change is visible.
//   2. When netting flushes a pair's accumulated net as ONE real EIP-3009 transfer, we bundle every
//      folded constituent into a `NetReceipt`, hash it (receiptHash), and use that hash AS THE
//      EIP-3009 `nonce`. The nonce is signed by the buyer and recorded on-chain (in the calldata and
//      the AuthorizationUsed event), so the transaction itself now commits to the neural state that
//      caused it. Receipts cannot be invented later: they must hash to a nonce that is already mined.
//   3. Each receipt also chains to the previous one (prevChain), forming a tamper-evident log, and is
//      published via /proofs so anyone can recompute receiptHash and compare it to the on-chain nonce.
//
// Verifying a trade is therefore: fetch /proofs, recompute sha256(receipt) yourself, read the tx's
// nonce off Arc, and check they match. If they do, the transfer is cryptographically bound to the
// published neural read-out — no human signature and no LLM is in that path.

import type { FlyReading } from "./population.js";

/** Bump when the receipt schema changes (invalidates old hashes' comparability, not their validity). */
export const PROOF_VERSION = 1;
/**
 * Bump whenever the neural-drive → economic-decision policy changes (pricing / counterparty pick /
 * good mapping). Mixed into every hash so a reader can tell which policy produced a given receipt.
 */
export const POLICY_VERSION = "econ-v1";

/** The frozen neural read-out of one side of a trade — the evidence that neurons, not a human, decided. */
export interface NeuralEvidence {
  id: number;
  state: string;
  arousal: number;
  turnBias: number;
  cohesion: number;
  wingbeat: number;
  rest: number;
  temperament: number;
  fingerprint: string;
}

/** One trade folded into a net, bound to the neural read-out that produced it. */
export interface NeuralConstituent {
  tick: number;
  fromId: number;
  toId: number;
  good: string;
  amount: string;          // atomic USDC of this single trade
  /** The frozen neural drives of each side, published so a third party can recompute decisionHash. */
  buyer: NeuralEvidence;
  seller: NeuralEvidence;
  decisionHash: string;    // sha256 of the frozen neural inputs (see decisionHash())
}

/** The full receipt committed to on-chain as the EIP-3009 nonce of one net transfer. */
export interface NetReceipt {
  v: number;
  policy: string;
  chain: string;           // network tag, e.g. "arc"
  pair: [number, number];  // [lo, hi] agent ids
  debtor: number;          // who actually pays the net on-chain
  creditor: number;        // who receives it
  netAmount: string;       // atomic USDC moved by this transfer
  trades: number;          // gross trades folded in
  good: string;
  tickIndex: number;
  flushSeq: number;        // monotonic per-economy counter (guarantees nonce uniqueness)
  chunk: number;           // which cap-split chunk of an oversized net this is
  constituents: NeuralConstituent[];
  prevChain: string;       // receiptHash of the previous broadcast ("" for the first) → hash chain
}

/** A stored proof: the receipt + its hash + the tx that committed to it. */
export interface ProofRecord {
  txHash: string;
  receiptHash: string;     // == the on-chain EIP-3009 nonce (hex, no 0x)
  receipt: NetReceipt;
  ts: number;
  /**
   * Tx that registered this receipt on our own NeuralReceiptRegistry (moves the hash-chain head
   * on-chain). Present only when a registry is configured AND the best-effort commit mined; absent
   * means "not yet / not registered" — it never blocks or invalidates the settlement itself.
   */
  commitTx?: string;
  /**
   * IPFS CID of the pinned canonical receipt body, when a pinner is configured AND the best-effort pin
   * landed. A convenience pointer for trustless retrieval: a verifier fetches this CID from any public
   * gateway and confirms sha256(body) == receiptHash (the on-chain nonce), so a correct CID is NOT a trust
   * assumption — the hash match is. Absent means "not pinned"; nonce/registry verification is unchanged.
   */
  ipfsCid?: string;
}

/** Round to 6 decimals so a float can survive a JSON round-trip into a stable hash input. */
const r6 = (x: number): number => Math.round(x * 1e6) / 1e6;

/** Freeze a fly's decoded neural drives into hashable evidence. */
export function neuralEvidence(r: FlyReading): NeuralEvidence {
  return {
    id: r.id,
    state: r.state,
    arousal: r6(r.arousal),
    turnBias: r6(r.turnBias),
    cohesion: r6(r.cohesion),
    wingbeat: r6(r.wingbeat),
    rest: r6(r.rest),
    temperament: r6(r.temperament),
    fingerprint: r.fingerprint,
  };
}

/**
 * Deterministic JSON: object keys sorted recursively, so the same logical value always serialises to
 * the same bytes regardless of insertion order. Arrays keep their order (it is meaningful).
 */
export function canonical(value: unknown): string {
  const walk = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === "object") {
      const out: Record<string, unknown> = {};
      for (const k of Object.keys(v as object).sort()) out[k] = walk((v as Record<string, unknown>)[k]);
      return out;
    }
    return v;
  };
  return JSON.stringify(walk(value));
}

/** SHA-256 of a value's canonical form, as 64 lowercase hex chars (no 0x). */
export async function sha256Hex(value: unknown): Promise<string> {
  const bytes = new TextEncoder().encode(canonical(value));
  const dig = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(dig)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Hash the frozen neural inputs of one trade — the per-trade "the neurons decided this" digest. */
export async function decisionHash(
  buyer: FlyReading,
  seller: FlyReading,
  good: string,
  amount: string,
  tick: number,
): Promise<string> {
  return sha256Hex({
    v: PROOF_VERSION,
    policy: POLICY_VERSION,
    kind: "decision",
    tick,
    good,
    amount,
    buyer: neuralEvidence(buyer),
    seller: neuralEvidence(seller),
  });
}

/**
 * Recompute a published constituent's decisionHash from the neural evidence carried INSIDE the receipt.
 * Self-contained: a third party needs only the receipt bytes, not our word, to confirm the digest.
 */
export async function recomputeDecisionHash(c: NeuralConstituent): Promise<string> {
  return sha256Hex({
    v: PROOF_VERSION,
    policy: POLICY_VERSION,
    kind: "decision",
    tick: c.tick,
    good: c.good,
    amount: c.amount,
    buyer: c.buyer,
    seller: c.seller,
  });
}

/** Hash a full net receipt — this value becomes the on-chain EIP-3009 nonce. */
export async function netReceiptHash(receipt: NetReceipt): Promise<string> {
  return sha256Hex(receipt);
}

/** The EIP-3009 nonce for a receipt hash: the hash itself, as a 0x-prefixed 32-byte hex string. */
export function nonceFromReceiptHash(receiptHash: string): string {
  return "0x" + receiptHash;
}

/**
 * Pull the EIP-3009 `nonce` (the 6th argument, a bytes32) out of a transferWithAuthorization calldata
 * blob, so a verifier can read the on-chain commitment without a full ABI decode. Layout:
 * 4-byte selector then nine 32-byte words: from,to,value,validAfter,validBefore,nonce,v,r,s.
 * Returns 64 lowercase hex chars (no 0x), or null if the calldata isn't the expected shape.
 */
export function nonceFromCalldata(input: string): string | null {
  const hex = input.replace(/^0x/i, "");
  if (hex.length < 8 + 6 * 64) return null;
  const word = hex.slice(8 + 5 * 64, 8 + 6 * 64);
  return word.toLowerCase();
}
