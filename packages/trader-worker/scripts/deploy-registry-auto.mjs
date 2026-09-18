// Fully-automatic NeuralReceiptRegistry deployment for murmur.
//
// You fill packages/trader-worker/.env.local with ONE of:
//   ECONOMY_MNEMONIC          (the same seed the Worker uses — we derive the identical gas wallet)
//   ECONOMY_FACILITATOR_PK    (a dedicated gas key, if the Worker was configured with one)
//   REGISTRY_DEPLOYER_PK      (any gas wallet key to deploy + act as committer)
// then run:  node scripts/deploy-registry-auto.mjs
//
// It deploys the contract with committer = the SAME address the Worker's facilitator signs from, so
// the Worker can commit. Genesis is NOT seeded here on purpose: the Worker lazily adopts its own
// current chain head on its first commit (see x402.ts ensureGenesisSeeded), which avoids a stale-head
// race because the swarm flushes continuously. The secret key is never printed.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createPublicClient, createWalletClient, http } from "viem";
import { mnemonicToAccount, privateKeyToAccount } from "viem/accounts";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, "..");

// ---- read .env.local (KEY=VALUE, # comments, blank lines) ----
function readEnv(file) {
  const out = {};
  if (!fs.existsSync(file)) return out;
  for (const raw of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const i = line.indexOf("=");
    if (i < 0) continue;
    out[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  }
  return out;
}
const envFile = path.join(root, ".env.local");
const env = { ...readEnv(envFile) };
for (const k of ["HTTPS_PROXY", "HTTP_PROXY", "CHAIN_ID"]) {
  if (!env[k] && process.env[k]) env[k] = process.env[k];
}

// ---- proxy (Node's global fetch/undici honours the global dispatcher) ----
const proxy = env.HTTPS_PROXY || env.HTTP_PROXY;
if (proxy) {
  const { ProxyAgent, setGlobalDispatcher } = await import("undici");
  setGlobalDispatcher(new ProxyAgent(proxy));
  console.log("proxy    :", proxy);
}

// ---- resolve the deployer / committer account (same derivation as the Worker) ----
const FACILITATOR_ACCOUNT_INDEX = 2_000_000; // must match src/keys.ts
const normPk = (s) => (s.startsWith("0x") ? s : `0x${s}`);
const isHexKey = (s) => /^(0x)?[0-9a-fA-F]{64}$/.test(s.trim());
let account;
if (env.REGISTRY_DEPLOYER_PK) {
  account = privateKeyToAccount(normPk(env.REGISTRY_DEPLOYER_PK.trim()));
  console.log("key src  : REGISTRY_DEPLOYER_PK");
} else if (env.ECONOMY_FACILITATOR_PK) {
  account = privateKeyToAccount(normPk(env.ECONOMY_FACILITATOR_PK.trim()));
  console.log("key src  : ECONOMY_FACILITATOR_PK");
} else if (env.ECONOMY_MNEMONIC) {
  const m = env.ECONOMY_MNEMONIC.trim();
  if (isHexKey(m)) {
    // The user pasted a raw private key into the mnemonic field — handle it gracefully.
    account = privateKeyToAccount(normPk(m));
    console.log("key src  : ECONOMY_MNEMONIC field held a raw hex private key (used as PK)");
  } else {
    account = mnemonicToAccount(m, { accountIndex: FACILITATOR_ACCOUNT_INDEX });
    console.log("key src  : ECONOMY_MNEMONIC (derived facilitator, accountIndex " + FACILITATOR_ACCOUNT_INDEX + ")");
  }
} else {
  console.error("\n✗ 没有密钥。请在 packages/trader-worker/.env.local 里填写 ECONOMY_MNEMONIC 或一把私钥，然后重跑。");
  process.exit(1);
}

// ---- chain ----
const chainId = Number(env.CHAIN_ID || "5042");
const rpcUrl = env.RPC_URL || (chainId === 5042 ? "https://rpc.mainnet.arc.io" : "https://rpc.testnet.arc.io");
const chain = {
  id: chainId,
  name: chainId === 5042 ? "Arc Mainnet" : "Arc Testnet",
  nativeCurrency: { name: "USDC", symbol: "USDC", decimals: 18 },
  rpcUrls: { default: { http: [rpcUrl] } },
};
const publicClient = createPublicClient({ chain, transport: http(rpcUrl) });
const wallet = createWalletClient({ chain, transport: http(rpcUrl), account });

const artifact = JSON.parse(fs.readFileSync(path.join(root, "contracts", "build", "NeuralReceiptRegistry.json"), "utf8"));

console.log("chain    :", chainId, rpcUrl);

// ---- resolve the COMMITTER address ----
// The committer is whoever signs the Worker's commit() calls, i.e. the Worker's facilitator/gas wallet
// — which is NOT necessarily the key deploying this contract. Read it live from the most recent murmur
// settlement's on-chain `from`, so the deployed committer always matches the Worker even when a
// different key pays the deploy gas. Override with REGISTRY_COMMITTER if you know it explicitly.
async function liveFacilitatorAddress() {
  try {
    const res = await fetch(env.API_URL || "https://api.muros.live/proofs", { cache: "no-store" });
    const j = await res.json();
    const txHash = (j.proofs || []).map((p) => p.txHash).find((h) => /^0x[0-9a-fA-F]{64}$/.test(h || ""));
    if (!txHash) return null;
    const tx = await publicClient.getTransaction({ hash: txHash });
    return tx?.from ?? null;
  } catch { return null; }
}
let committer = (env.REGISTRY_COMMITTER || "").trim();
if (!committer) {
  const live = await liveFacilitatorAddress();
  if (live) committer = live;
}
if (!committer) committer = account.address;   // fall back to the deployer
console.log("deployer :", account.address, "(pays gas)");
console.log("committer:", committer, committer.toLowerCase() === account.address.toLowerCase() ? "(= deployer)" : "(Worker's wallet — read live)");
if (committer.toLowerCase() !== account.address.toLowerCase()) {
  console.log("note     : deployer != committer. The Worker (committer) must hold gas to commit; the deployer only funds this deployment.");
}

// ---- gas sanity: the deployer pays for THIS deployment in native USDC (18-dec on Arc) ----
const bal = await publicClient.getBalance({ address: account.address });
console.log("deployer gas bal:", (Number(bal) / 1e18).toFixed(6), "USDC(native)");
if (bal === 0n) {
  console.error("\n✗ deployer 余额为 0，无法支付部署 gas。请先给该地址充值原生 USDC。");
  process.exit(1);
}

// ---- deploy ----
console.log("\ndeploying NeuralReceiptRegistry …");
const hash = await wallet.deployContract({ abi: artifact.abi, bytecode: artifact.bytecode, args: [committer] });
console.log("deploy tx:", hash);
const receipt = await publicClient.waitForTransactionReceipt({ hash, confirmations: 1 });
if (receipt.status !== "success") { console.error("✗ 部署交易 revert 了"); process.exit(1); }
const address = receipt.contractAddress;
console.log("registry :", address);

// ---- self-verify the deployed state ----
const onchainCommitter = await publicClient.readContract({ address, abi: artifact.abi, functionName: "committer" });
const head = await publicClient.readContract({ address, abi: artifact.abi, functionName: "chainHead" });
console.log("verify   : committer =", onchainCommitter, onchainCommitter.toLowerCase() === committer.toLowerCase() ? "✓" : "✗ MISMATCH");
console.log("verify   : chainHead =", head, head === `0x${"00".repeat(32)}` ? "(empty — Worker will lazily seed) ✓" : "(already seeded)");

// ---- persist the address for the Worker wiring step ----
fs.writeFileSync(path.join(root, "contracts", "REGISTRY_ADDRESS.txt"), address + "\n");
// Also record it back into .env.local (idempotent) so nothing is lost.
let envTxt = fs.existsSync(envFile) ? fs.readFileSync(envFile, "utf8") : "";
if (/^\s*ECONOMY_REGISTRY_ADDRESS\s*=/m.test(envTxt)) {
  envTxt = envTxt.replace(/^\s*ECONOMY_REGISTRY_ADDRESS\s*=.*$/m, `ECONOMY_REGISTRY_ADDRESS=${address}`);
} else {
  envTxt += `\nECONOMY_REGISTRY_ADDRESS=${address}\n`;
}
fs.writeFileSync(envFile, envTxt);

console.log("\n✅ 合约已部署。地址：", address);
console.log("已写入 contracts/REGISTRY_ADDRESS.txt 和 .env.local(ECONOMY_REGISTRY_ADDRESS)。");
console.log("下一步（接线 Worker + 上线前端）由助手自动完成。");
