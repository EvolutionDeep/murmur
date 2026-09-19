// Fully-automatic ConnectomeLineage deployment for murmur's connectome BREEDING market.
//
// You fill packages/trader-worker/.env.local with ONE of:
//   ECONOMY_MNEMONIC          (the same seed the Worker uses — we derive the identical facilitator wallet)
//   ECONOMY_FACILITATOR_PK    (a dedicated gas key, if the Worker was configured with one)
//   LINEAGE_DEPLOYER_PK       (any gas wallet key to deploy; the committer is still read/derived separately)
// then run:  node scripts/deploy-lineage-auto.mjs
//
// It deploys ConnectomeLineage(committer = the SAME address the Worker's facilitator signs from) so the
// Worker can commit bred genomes as the authorized committer. The committer is read live from the most
// recent murmur settlement's on-chain `from` (override with LINEAGE_COMMITTER), so it always matches the
// Worker even when a different key pays the deploy gas. The secret key is never printed.
//
// SAFETY: this spends REAL gas. The contract holds NO funds and has NO upgrade path — it is a pure
// commitment log whose only writer is the committer. It defaults to the chain in CHAIN_ID (5042 mainnet),
// but a MAINNET deploy is gated behind LINEAGE_CONFIRM=1 — drill on testnet (CHAIN_ID=5042002) first.
// Wiring the Worker (LINEAGE_ADDRESS + redeploy) is a SEPARATE, deliberate step.
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
for (const k of ["HTTPS_PROXY", "HTTP_PROXY", "CHAIN_ID", "RPC_URL", "LINEAGE_COMMITTER", "LINEAGE_CONFIRM", "API_URL"]) {
  if (!env[k] && process.env[k]) env[k] = process.env[k];
}

// ---- proxy (Node's global fetch/undici honours the global dispatcher) ----
const proxy = env.HTTPS_PROXY || env.HTTP_PROXY;
if (proxy) {
  const { ProxyAgent, setGlobalDispatcher } = await import("undici");
  setGlobalDispatcher(new ProxyAgent(proxy));
  console.log("proxy    :", proxy);
}

// ---- resolve the deployer account (same derivation as the Worker's facilitator) ----
const FACILITATOR_ACCOUNT_INDEX = 2_000_000; // must match src/keys.ts
const normPk = (s) => (s.startsWith("0x") ? s : `0x${s}`);
const isHexKey = (s) => /^(0x)?[0-9a-fA-F]{64}$/.test(s.trim());
let account;
if (env.LINEAGE_DEPLOYER_PK) {
  account = privateKeyToAccount(normPk(env.LINEAGE_DEPLOYER_PK.trim()));
  console.log("key src  : LINEAGE_DEPLOYER_PK");
} else if (env.ECONOMY_FACILITATOR_PK) {
  account = privateKeyToAccount(normPk(env.ECONOMY_FACILITATOR_PK.trim()));
  console.log("key src  : ECONOMY_FACILITATOR_PK");
} else if (env.ECONOMY_MNEMONIC) {
  const m = env.ECONOMY_MNEMONIC.trim();
  if (isHexKey(m)) {
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

const artifactPath = path.join(root, "contracts", "build", "ConnectomeLineage.json");
if (!fs.existsSync(artifactPath)) {
  console.error("\n✗ 缺少编译产物 contracts/build/ConnectomeLineage.json。先跑：npm run compile:lineage");
  process.exit(1);
}
const artifact = JSON.parse(fs.readFileSync(artifactPath, "utf8"));
console.log("chain    :", chainId, rpcUrl);

// ---- resolve the COMMITTER address (the Worker's facilitator wallet that signs commit()) ----
// Read it live from the most recent murmur settlement's on-chain `from` so the deployed committer always
// matches the Worker even when a different key pays the deploy gas. Override with LINEAGE_COMMITTER.
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
let committer = (env.LINEAGE_COMMITTER || "").trim();
if (!committer) {
  const live = await liveFacilitatorAddress();
  if (live) committer = live;
}
if (!committer) committer = account.address;   // fall back to the deployer

console.log("deployer :", account.address, "(pays gas)");
console.log("committer:", committer, committer.toLowerCase() === account.address.toLowerCase() ? "(= deployer)" : "(Worker's wallet — read live)");
if (committer.toLowerCase() !== account.address.toLowerCase()) {
  console.log("note     : deployer != committer. Only the committer may commit() genomes; the deployer just funds this deployment.");
}

// ---- sanity: the deployer must have gas ----
const bal = await publicClient.getBalance({ address: account.address });
console.log("deployer gas bal:", (Number(bal) / 1e18).toFixed(6), "USDC(native)");
if (bal === 0n) {
  console.error("\n✗ deployer 余额为 0，无法支付部署 gas。请先给该地址充值原生 USDC。");
  process.exit(1);
}

// ---- MAINNET gate: a real-gas deploy must be explicitly confirmed ----
if (chainId === 5042 && env.LINEAGE_CONFIRM !== "1") {
  console.error("\n✗ 这是【主网 5042】部署：会花真 gas（合约本身不托管任何资金、无升级路径）。");
  console.error("  · 想先演练：把 CHAIN_ID 设为 5042002 重跑（测试网）。");
  console.error("  · 确认要上主网：加 LINEAGE_CONFIRM=1 重跑（并与助手确认过参数）。");
  console.error("  部署后链上锚定仍是【未激活】的——上线还需在 wrangler.toml 里设 LINEAGE_ADDRESS 并重新部署 Worker。");
  process.exit(1);
}

// ---- deploy ----
console.log("\ndeploying ConnectomeLineage …");
const hash = await wallet.deployContract({ abi: artifact.abi, bytecode: artifact.bytecode, args: [committer] });
console.log("deploy tx:", hash);
const receipt = await publicClient.waitForTransactionReceipt({ hash, confirmations: 1 });
if (receipt.status !== "success") { console.error("✗ 部署交易 revert 了"); process.exit(1); }
const address = receipt.contractAddress;
console.log("lineage  :", address);

// ---- self-verify the deployed immutables ----
const onCommitter = await publicClient.readContract({ address, abi: artifact.abi, functionName: "committer" });
const onCount = await publicClient.readContract({ address, abi: artifact.abi, functionName: "commitCount" });
const onLatest = await publicClient.readContract({ address, abi: artifact.abi, functionName: "latestHash" });
console.log("verify   : committer  =", onCommitter, onCommitter.toLowerCase() === committer.toLowerCase() ? "✓" : "✗ MISMATCH");
console.log("verify   : commitCount=", onCount.toString(), onCount === 0n ? "(fresh) ✓" : "");
console.log("verify   : latestHash =", onLatest, onLatest === "0x" + "00".repeat(32) ? "(empty) ✓" : "");
if (onCommitter.toLowerCase() !== committer.toLowerCase()) {
  console.error("✗ committer 不匹配——Worker 将无法 commit()。请勿接线，检查 LINEAGE_COMMITTER/部署密钥。");
  process.exit(1);
}

// ---- persist the address for the Worker wiring step ----
fs.writeFileSync(path.join(root, "contracts", "LINEAGE_ADDRESS.txt"), address + "\n");
let envTxt = fs.existsSync(envFile) ? fs.readFileSync(envFile, "utf8") : "";
if (/^\s*LINEAGE_ADDRESS\s*=/m.test(envTxt)) {
  envTxt = envTxt.replace(/^\s*LINEAGE_ADDRESS\s*=.*$/m, `LINEAGE_ADDRESS=${address}`);
} else {
  envTxt += `\nLINEAGE_ADDRESS=${address}\n`;
}
fs.writeFileSync(envFile, envTxt);

console.log("\n✅ ConnectomeLineage 已部署。地址：", address);
console.log("已写入 contracts/LINEAGE_ADDRESS.txt 和 .env.local(LINEAGE_ADDRESS)。");
console.log("下一步(需与助手确认后再做)：在 wrangler.toml 里设 LINEAGE_ADDRESS=" + address + "，重新部署 Worker 以激活链上血统锚定。");
