// HD key management for real-money (onchain) x402 settlement.
//
// CUSTODY MODEL — one seed, many derived agents. Instead of holding 24 loose private keys, the
// Worker holds ONE BIP-39 mnemonic (an encrypted Workers Secret) and DERIVES every agent account
// deterministically via BIP-44 (m/44'/60'/0'/0/{id}) with viem's mnemonicToAccount. Agent `id` ⇄
// accountIndex `id`, so addresses are stable and reproducible from the seed alone; the gas-paying
// facilitator is a separate high accountIndex on the same seed (or a dedicated key if provided).
// This is the same "one root → many agent identities" pattern Kite's Agent Passport uses: it cuts
// the secret surface from 25 keys to 1, while each agent still has its own on-chain address and
// signs its own EIP-3009 authorization.
//
// NOTHING HERE IS USED unless facilitatorMode === "onchain" AND a mnemonic/PK secret is present.
// The default simulated economy never touches this module.

import { mnemonicToAccount, privateKeyToAccount } from "viem/accounts";
import type { Address, LocalAccount } from "viem";

/** BIP-44 accountIndex reserved for the gas-paying facilitator — kept far from the agent range. */
const FACILITATOR_ACCOUNT_INDEX = 2_000_000;

/** A derived signing account (viem's HD account satisfies LocalAccount structurally). */
export type DerivedAccount = ReturnType<typeof mnemonicToAccount>;

export interface AgentKeys {
  /** accountIndex ⇄ fly id: address + signTypedData for signing EIP-3009 authorizations. */
  account(id: number): DerivedAccount;
  address(id: number): Address;
  /** The gas-paying facilitator account (submits transferWithAuthorization on-chain). */
  facilitator(): LocalAccount;
  facilitatorAddress(): Address;
  count: number;
}

/**
 * Build the key set from a mnemonic (agents + facilitator derived on the same seed). If
 * `facilitatorPk` is supplied it is used for the gas wallet instead of a derived index — lets an
 * operator keep a dedicated, separately-funded hot wallet for settlement gas.
 */
export function deriveAgentKeys(mnemonic: string, count: number, facilitatorPk?: string): AgentKeys {
  const cache = new Map<number, DerivedAccount>();
  const at = (idx: number): DerivedAccount => {
    let a = cache.get(idx);
    if (!a) {
      a = mnemonicToAccount(mnemonic, { accountIndex: idx });
      cache.set(idx, a);
    }
    return a;
  };
  const fac: LocalAccount = facilitatorPk
    ? privateKeyToAccount(facilitatorPk as `0x${string}`)
    : at(FACILITATOR_ACCOUNT_INDEX);
  return {
    account: (id) => at(id),
    address: (id) => at(id).address,
    facilitator: () => fac,
    facilitatorAddress: () => fac.address,
    count,
  };
}

/**
 * Read-only helper: the addresses an operator must fund before going live (each agent's USDC wallet
 * + the facilitator's native-USDC gas wallet). Derives from the seed without signing anything — safe
 * to expose behind an authenticated route so the operator knows exactly where to send funds.
 */
export function listDerivedAddresses(
  mnemonic: string,
  count: number,
  facilitatorPk?: string,
): { agents: { id: number; address: Address }[]; facilitator: Address } {
  const k = deriveAgentKeys(mnemonic, count, facilitatorPk);
  const agents = Array.from({ length: count }, (_, id) => ({ id, address: k.address(id) }));
  return { agents, facilitator: k.facilitatorAddress() };
}
