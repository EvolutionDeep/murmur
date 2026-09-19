// Buyer-side EIP-3009 `transferWithAuthorization` signing — the off-chain USDC authorization Circle submits.
//
// The BUYER signs this (never sends a private key); the signature + authorization fields go into the /settle
// body. Circle recovers the signer, checks the balance, screens both parties, and submits
// `transferWithAuthorization` to the USDC contract, paying the gas itself.

import { toHex, type Address, type Hex, type LocalAccount } from "viem";

/** Circle USDC's EIP-712 domain. `version` is "2" for the FiatTokenV2 USDC deployed on Arc / Base / Polygon. */
export function usdcDomain(chainId: number, verifyingContract: Address, version = "2") {
  return { name: "USDC", version, chainId, verifyingContract };
}

/** The standard EIP-3009 TransferWithAuthorization struct (field order is load-bearing). */
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

/** The authorization fields a buyer signs — all of them go verbatim into the /settle body. */
export interface Eip3009Authorization {
  from: Address;
  to: Address;
  value: bigint; // atomic USDC (6 decimals)
  validAfter: bigint; // unix seconds (0 = valid immediately)
  validBefore: bigint; // unix seconds (expiry)
  nonce: Hex; // bytes32, unique per authorization
}

export interface SignEip3009Args {
  account: LocalAccount; // the buyer / payer key
  chainId: number;
  asset: Address; // USDC contract
  to: Address; // payTo (the seller)
  value: bigint; // atomic USDC
  validAfter?: bigint; // default 0n (valid now)
  validBefore?: bigint; // default now + 1 hour
  nonce?: Hex; // default 32 random bytes
  usdcVersion?: string; // EIP-712 domain version, default "2"
}

/**
 * Sign an EIP-3009 transferWithAuthorization with the buyer's key. Returns the compact 0x signature
 * (r||s||v, 65 bytes) plus the exact authorization fields to place in the /settle body. The nonce is
 * bytes32; reusing it as the idempotency id makes a retry converge on the same Circle payment.
 */
export async function signEip3009Authorization(
  a: SignEip3009Args,
): Promise<{ signature: Hex; authorization: Eip3009Authorization }> {
  const validAfter = a.validAfter ?? 0n;
  const validBefore = a.validBefore ?? BigInt(Math.floor(Date.now() / 1000) + 3600);
  const nonce = a.nonce ?? (toHex(crypto.getRandomValues(new Uint8Array(32))) as Hex);
  const authorization: Eip3009Authorization = {
    from: a.account.address,
    to: a.to,
    value: a.value,
    validAfter,
    validBefore,
    nonce,
  };
  const signature = await a.account.signTypedData({
    domain: usdcDomain(a.chainId, a.asset, a.usdcVersion),
    types: EIP3009_TYPES,
    primaryType: "TransferWithAuthorization",
    message: {
      from: authorization.from,
      to: authorization.to,
      value: authorization.value,
      validAfter: authorization.validAfter,
      validBefore: authorization.validBefore,
      nonce: authorization.nonce,
    },
  });
  return { signature, authorization };
}
