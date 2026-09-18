// Deploy NeuralReceiptRegistry to Arc and (optionally) seed the pre-existing off-chain chain head.
//
//   REGISTRY_DEPLOYER_PK   (required) private key of the deployer AND default committer (gas wallet)
//   REGISTRY_COMMITTER     (optional) committer address; defaults to the deployer address
//   REGISTRY_GENESIS_HEAD  (optional) 0x…64 receipt hash to seedGenesis() after deploy. Typically the
//                          current /proofs chainHead so the first on-chain commit chains onto history.
//   RPC_URL                (optional) default https://rpc.mainnet.arc.io
//   CHAIN_ID               (optional) default 5042
//
// Run: node scripts/deploy-registry.mjs
// NOTE: this spends real gas on whichever chain CHAIN_ID points at. Point at testnet (5042002) first.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createPublicClient, createWalletClient, http, privateKeyToAccount } from "viem";

const here = path.dirname(fileURLToPath(import.meta.url));
const artifact = JSON.parse(
  fs.readFileSync(path.join(here, "..", "contracts", "build", "NeuralReceiptRegistry.json"), "utf8"),
);

const pk = process.env.REGISTRY_DEPLOYER_PK;
if (!pk) { console.error("REGISTRY_DEPLOYER_PK is required"); process.exit(1); }
const chainId = Number(process.env.CHAIN_ID || "5042");
const rpcUrl = process.env.RPC_URL || (chainId === 5042 ? "https://rpc.mainnet.arc.io" : "https://rpc.testnet.arc.io");

const chain = {
  id: chainId,
  name: chainId === 5042 ? "Arc Mainnet" : "Arc Testnet",
  nativeCurrency: { name: "USDC", symbol: "USDC", decimals: 18 },
  rpcUrls: { default: { http: [rpcUrl] } },
};

const account = privateKeyToAccount(pk.startsWith("0x") ? pk : `0x${pk}`);
const committer = (process.env.REGISTRY_COMMITTER || account.address);

const publicClient = createPublicClient({ chain, transport: http(rpcUrl) });
const wallet = createWalletClient({ chain, transport: http(rpcUrl), account });

console.log("deployer :", account.address);
console.log("committer:", committer);
console.log("chain    :", chainId, rpcUrl);

const hash = await wallet.deployContract({
  abi: artifact.abi,
  bytecode: artifact.bytecode,
  args: [committer],
});
console.log("deploy tx:", hash);
const receipt = await publicClient.waitForTransactionReceipt({ hash, confirmations: 1 });
if (receipt.status !== "success") { console.error("deploy reverted"); process.exit(1); }
const address = receipt.contractAddress;
console.log("registry :", address);

const genesis = process.env.REGISTRY_GENESIS_HEAD;
if (genesis) {
  const g = genesis.startsWith("0x") ? genesis : `0x${genesis}`;
  const seedTx = await wallet.writeContract({ address, abi: artifact.abi, functionName: "seedGenesis", args: [g] });
  console.log("seed tx  :", seedTx);
  await publicClient.waitForTransactionReceipt({ hash: seedTx, confirmations: 1 });
  console.log("seeded   :", g);
}

console.log("\nNext: set the Worker var ECONOMY_REGISTRY_ADDRESS=" + address);
