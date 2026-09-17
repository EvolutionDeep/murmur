#!/usr/bin/env node
// ==========================================================================
// One-time funder for the murmur on-chain agent economy (Arc mainnet).
//
// WHY THIS EXISTS: live x402 settlement uses EIP-3009 transferWithAuthorization,
// where every BUYER agent signs from its OWN key and must hold USDC, and the
// facilitator pays gas from its OWN key. A single treasury wallet therefore
// cannot settle directly — its USDC must first be spread across the HD-derived
// agent wallets + the facilitator. This script does exactly that, once.
//
// USAGE (dry-run by default — prints the 25 derived addresses + the plan, sends NOTHING):
//   MNEMONIC="<new agent seed>" SOURCE_KEY="<treasury pk>" node scripts/fund-agents.mjs
// To actually execute the 25 one-time ERC-20 transfers:
//   MNEMONIC=... SOURCE_KEY=... node scripts/fund-agents.mjs --send
//
// ENV:
//   MNEMONIC          BIP-39 seed for the 24 agents + facilitator (= ECONOMY_MNEMONIC)
//   SOURCE_KEY        private key of the funded treasury wallet (your 200 USDC one)
//   AGENTS            number of agents            (default 24)
//   AGENT_USDC        float per agent             (default 6)
//   FACILITATOR_USDC  gas budget for facilitator  (default 50)
//   RPC_URL           override RPC                (default Arc mainnet)
//
// SECURITY: keys are read from YOUR shell env only and never logged. Run this on
// your own machine; do not paste secrets into anything you don't control.
// ==========================================================================
import { createPublicClient, createWalletClient, http, parseUnits, formatUnits, erc20Abi } from "viem";
import { mnemonicToAccount, privateKeyToAccount } from "viem/accounts";

const ARC_USDC = "0x3600000000000000000000000000000000000000";   // Arc mainnet FiatTokenV2 precompile
const FACILITATOR_ACCOUNT_INDEX = 2_000_000;                      // must match src/keys.ts
const CHAIN = {
  id: 5042,
  name: "Arc Mainnet",
  nativeCurrency: { name: "USDC", symbol: "USDC", decimals: 6 },
  rpcUrls: { default: { http: [process.env.RPC_URL || "https://rpc.mainnet.arc.io"] } },
};

const mnemonic = (process.env.MNEMONIC || "").trim();
const sourceKey = (process.env.SOURCE_KEY || "").trim();
const agents = Number(process.env.AGENTS || 24);
const agentUsdc = Number(process.env.AGENT_USDC || 6);
const facUsdc = Number(process.env.FACILITATOR_USDC || 50);
const send = process.argv.includes("--send");

if (!mnemonic || !sourceKey) {
  console.error("ERROR: set MNEMONIC and SOURCE_KEY env vars");
  process.exit(1);
}

const pub = createPublicClient({ chain: CHAIN, transport: http() });
const source = privateKeyToAccount(sourceKey.startsWith("0x") ? sourceKey : "0x" + sourceKey);
const wallet = createWalletClient({ account: source, chain: CHAIN, transport: http() });

const targets = [];
for (let i = 0; i < agents; i++) {
  targets.push({ label: `agent#${i}`, account: mnemonicToAccount(mnemonic, { accountIndex: i }), usdc: agentUsdc });
}
targets.push({ label: "facilitator", account: mnemonicToAccount(mnemonic, { accountIndex: FACILITATOR_ACCOUNT_INDEX }), usdc: facUsdc });

const balOf = async (addr) =>
  Number(formatUnits(await pub.readContract({ address: ARC_USDC, abi: erc20Abi, functionName: "balanceOf", args: [addr] }), 6));

const srcBal = await balOf(source.address);
const need = targets.reduce((s, t) => s + t.usdc, 0);
console.log(`treasury  ${source.address}  balance = ${srcBal} USDC`);
console.log(`plan      ${agents} agents x ${agentUsdc} + facilitator ${facUsdc} = ${need} USDC  (leaves ${(srcBal - need).toFixed(2)} in treasury)`);
if (need > srcBal) {
  console.error("ERROR: insufficient treasury balance for this plan — lower AGENT_USDC / FACILITATOR_USDC");
  process.exit(1);
}
for (const t of targets) {
  console.log(`  ${t.label.padEnd(12)} ${t.account.address}  +${t.usdc} USDC   (now ${await balOf(t.account.address)})`);
}

if (!send) {
  console.log("\nDRY-RUN: nothing was sent. Re-run with --send to execute the transfers.");
  process.exit(0);
}

for (const t of targets) {
  const hash = await wallet.writeContract({
    address: ARC_USDC,
    abi: erc20Abi,
    functionName: "transfer",
    args: [t.account.address, parseUnits(String(t.usdc), 6)],
  });
  const rc = await pub.waitForTransactionReceipt({ hash });
  console.log(`  sent ${t.usdc} -> ${t.label} ${t.account.address}  tx=${hash} status=${rc.status}`);
}
console.log(`done. treasury now ${await balOf(source.address)} USDC`);
