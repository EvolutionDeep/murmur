// Fully-automatic WarCoffer deployment for murmur's on-chain house-war + taxation coffer.
//
// You fill packages/trader-worker/.env.local with ONE of:
//   ECONOMY_MNEMONIC          (the same seed the Worker uses — we derive the identical facilitator wallet)
//   ECONOMY_FACILITATOR_PK    (a dedicated gas key, if the Worker was configured with one)
//   WAR_DEPLOYER_PK           (any gas wallet key to deploy; the resolver is still read/derived separately)
// then run:  node scripts/deploy-war-auto.mjs
//
// It deploys WarCoffer(usdc = Arc USDC, resolver = the SAME address the Worker's facilitator signs from,
// maxEscrow, staleGrace) so the Worker can deposit/declareWar/resolveWar/levyTax as the authorized resolver.
// The resolver is read live from the most recent murmur settlement's on-chain `from` (override WAR_RESOLVER),
// so it always matches the Worker even when a different key pays the deploy gas. The secret key is never printed.
//
// SAFETY: this spends REAL gas and wires a REAL USDC escrow capped at WAR_MAX_ESCROW_USDC. A MAINNET deploy is
// gated behind WAR_CONFIRM=1 — drill on testnet (CHAIN_ID=5042002) first. Enabling the Worker's war layer
// (WAR_ENABLED=true) is a SEPARATE, deliberate step, and the coffer starts EMPTY (no escrow until the Worker
// deposits against its hard cap).
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createPublicClient, createWalletClient, http } from "viem";
import { mnemonicToAccount, privateKeyToAccount } from "viem/accounts";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, "..");

/** USDC on Arc MAINNET (5042) — the FiatTokenV2 precompile the coffer escrows. Testnet needs its own WAR_USDC. */
const ARC_USDC_MAINNET = "0x3600000000000000000000000000000000000000";

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
for (const k of ["HTTPS_PROXY", "HTTP_PROXY", "CHAIN_ID", "RPC_URL", "WAR_USDC", "WAR_RESOLVER", "WAR_MAX_ESCROW_USDC", "WAR_STALE_GRACE_SEC", "WAR_CONFIRM"]) {
  if (!env[k] && process.env[k]) env[k] = process.env[k];
}

const proxy = env.HTTPS_PROXY || env.HTTP_PROXY;
if (proxy) {
  const { ProxyAgent, setGlobalDispatcher } = await import("undici");
  setGlobalDispatcher(new ProxyAgent(proxy));
  console.log("proxy    :", proxy);
}

const FACILITATOR_ACCOUNT_INDEX = 2_000_000; // must match src/keys.ts
const normPk = (s) => (s.startsWith("0x") ? s : `0x${s}`);
const isHexKey = (s) => /^(0x)?[0-9a-fA-F]{64}$/.test(s.trim());
let account;
if (env.WAR_DEPLOYER_PK) {
  account = privateKeyToAccount(normPk(env.WAR_DEPLOYER_PK.trim()));
  console.log("key src  : WAR_DEPLOYER_PK");
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

const artifact = JSON.parse(fs.readFileSync(path.join(root, "contracts", "build", "WarCoffer.json"), "utf8"));
console.log("chain    :", chainId, rpcUrl);

// ---- resolve the USDC asset ----
let usdc = (env.WAR_USDC || "").trim();
if (!usdc && chainId === 5042) usdc = ARC_USDC_MAINNET;
if (!usdc) {
  console.error("\n✗ 没有 WAR_USDC。测试网(5042002)上 USDC 不是主网那个地址——请指定测试网 USDC，");
  console.error("  并在 .env.local 里写 WAR_USDC=0x…，然后重跑。");
  process.exit(1);
}

// ---- resolve the RESOLVER (the Worker's facilitator wallet that signs the war calls) ----
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
let resolver = (env.WAR_RESOLVER || "").trim();
if (!resolver) {
  const live = await liveFacilitatorAddress();
  if (live) resolver = live;
}
if (!resolver) resolver = account.address;

// ---- escrow cap (USDC, 6-dec) + stale grace ----
const escrowUsdc = Number(env.WAR_MAX_ESCROW_USDC || "50");
if (!Number.isFinite(escrowUsdc) || escrowUsdc <= 0) {
  console.error("\n✗ WAR_MAX_ESCROW_USDC 必须是正数（USDC）。这是 coffer 能托管的真钱硬上限。");
  process.exit(1);
}
const maxEscrow = BigInt(Math.round(escrowUsdc * 1e6));   // USDC is 6-dec
const staleGrace = BigInt(env.WAR_STALE_GRACE_SEC || "259200");

console.log("deployer :", account.address, "(pays gas)");
console.log("usdc     :", usdc, usdc.toLowerCase() === ARC_USDC_MAINNET && chainId === 5042 ? "(Arc USDC mainnet)" : "");
console.log("resolver :", resolver, resolver.toLowerCase() === account.address.toLowerCase() ? "(= deployer)" : "(Worker's wallet — read live)");
console.log("maxEscrow:", escrowUsdc, "USDC (hard cap on real money held)");
console.log("staleGrace:", staleGrace.toString(), "sec (", (Number(staleGrace) / 86400).toFixed(2), "days )");

// ---- sanity: the asset must be a deployed contract, and the deployer must have gas ----
const code = await publicClient.getCode({ address: usdc });
if (!code || code === "0x") {
  console.error("\n✗ WAR_USDC 在该链上没有合约代码——地址错了或代币未部署。中止(不会把 coffer 接到空气上)。");
  process.exit(1);
}
const bal = await publicClient.getBalance({ address: account.address });
console.log("deployer gas bal:", (Number(bal) / 1e18).toFixed(6), "USDC(native)");
if (bal === 0n) {
  console.error("\n✗ deployer 余额为 0，无法支付部署 gas。请先给该地址充值原生 USDC。");
  process.exit(1);
}

// ---- MAINNET gate ----
if (chainId === 5042 && env.WAR_CONFIRM !== "1") {
  console.error("\n✗ 这是【主网 5042】部署：会花真 gas，并把一个托管真 USDC 的战库接到链上（上限 " + escrowUsdc + " USDC）。");
  console.error("  · 想先演练：把 CHAIN_ID 设为 5042002 + 指定测试网 WAR_USDC，重跑。");
  console.error("  · 确认要上主网：加 WAR_CONFIRM=1 重跑（并与助手确认过参数）。");
  console.error("  部署后战库是空的、且 Worker 的 war 层仍是【关闭】的——上线还需设 WAR_ADDRESS 并把 WAR_ENABLED 翻成 true。");
  process.exit(1);
}

// ---- deploy ----
console.log("\ndeploying WarCoffer …");
const hash = await wallet.deployContract({ abi: artifact.abi, bytecode: artifact.bytecode, args: [usdc, resolver, maxEscrow, staleGrace] });
console.log("deploy tx:", hash);
const receipt = await publicClient.waitForTransactionReceipt({ hash, confirmations: 1 });
if (receipt.status !== "success") { console.error("✗ 部署交易 revert 了"); process.exit(1); }
const address = receipt.contractAddress;
console.log("coffer   :", address);

// ---- self-verify the deployed immutables ----
const onUsdc = await publicClient.readContract({ address, abi: artifact.abi, functionName: "usdc" });
const onResolver = await publicClient.readContract({ address, abi: artifact.abi, functionName: "resolver" });
const onCap = await publicClient.readContract({ address, abi: artifact.abi, functionName: "maxEscrow" });
const onGrace = await publicClient.readContract({ address, abi: artifact.abi, functionName: "staleGrace" });
const onCount = await publicClient.readContract({ address, abi: artifact.abi, functionName: "warCount" });
console.log("verify   : usdc      =", onUsdc, onUsdc.toLowerCase() === usdc.toLowerCase() ? "✓" : "✗ MISMATCH");
console.log("verify   : resolver  =", onResolver, onResolver.toLowerCase() === resolver.toLowerCase() ? "✓" : "✗ MISMATCH");
console.log("verify   : maxEscrow =", onCap.toString(), onCap === maxEscrow ? "✓" : "✗ MISMATCH");
console.log("verify   : staleGrace=", onGrace.toString(), onGrace === staleGrace ? "✓" : "✗ MISMATCH");
console.log("verify   : warCount  =", onCount.toString(), onCount === 0n ? "(fresh) ✓" : "");

// ---- persist the address for the Worker wiring step ----
fs.writeFileSync(path.join(root, "contracts", "WAR_ADDRESS.txt"), address + "\n");
let envTxt = fs.existsSync(envFile) ? fs.readFileSync(envFile, "utf8") : "";
if (/^\s*WAR_ADDRESS\s*=/m.test(envTxt)) {
  envTxt = envTxt.replace(/^\s*WAR_ADDRESS\s*=.*$/m, `WAR_ADDRESS=${address}`);
} else {
  envTxt += `\nWAR_ADDRESS=${address}\n`;
}
fs.writeFileSync(envFile, envTxt);

console.log("\n✅ WarCoffer 已部署。地址：", address);
console.log("已写入 contracts/WAR_ADDRESS.txt 和 .env.local(WAR_ADDRESS)。");
console.log("下一步(需与助手确认后再做)：在 wrangler.toml 里设 WAR_ADDRESS=" + address + "、WAR_TREASURY、WAR_MAX_ESCROW_USDC，把 WAR_ENABLED 翻成 \"true\"，重新部署 Worker。");
