// Fully-automatic PredictionArena deployment for murmur's human-vs-swarm MURMUR arena.
//
// You fill packages/trader-worker/.env.local with ONE of:
//   ECONOMY_MNEMONIC          (the same seed the Worker uses — we derive the identical facilitator wallet)
//   ECONOMY_FACILITATOR_PK    (a dedicated gas key, if the Worker was configured with one)
//   ARENA_DEPLOYER_PK         (any gas wallet key to deploy; the resolver is still read/derived separately)
// then run:  node scripts/deploy-arena-auto.mjs
//
// It deploys PredictionArena(token = MURMUR, resolver = the SAME address the Worker's facilitator signs
// from, staleGrace) so the Worker can openRound/resolve as the authorized resolver. The resolver is read
// live from the most recent murmur settlement's on-chain `from` (override with ARENA_RESOLVER), so it always
// matches the Worker even when a different key pays the deploy gas. The secret key is never printed.
//
// SAFETY: this spends REAL gas and wires a REAL token. It defaults to the chain in CHAIN_ID (5042 mainnet),
// but a MAINNET deploy is gated behind ARENA_CONFIRM=1 — drill on testnet (CHAIN_ID=5042002 + a testnet
// ARENA_TOKEN) first. Enabling the Worker's arena (ARENA_ENABLED=true) is a SEPARATE, deliberate step.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createPublicClient, createWalletClient, http } from "viem";
import { mnemonicToAccount, privateKeyToAccount } from "viem/accounts";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, "..");

/** MURMUR on Arc MAINNET (5042) — the token the arena is denominated in. Testnet needs its own ARENA_TOKEN. */
const MURMUR_MAINNET = "0x8faae5592b9acc27a79fca745c6b872adf514a5d";

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
for (const k of ["HTTPS_PROXY", "HTTP_PROXY", "CHAIN_ID", "RPC_URL", "ARENA_TOKEN", "ARENA_RESOLVER", "ARENA_STALE_GRACE_SEC", "ARENA_CONFIRM"]) {
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
if (env.ARENA_DEPLOYER_PK) {
  account = privateKeyToAccount(normPk(env.ARENA_DEPLOYER_PK.trim()));
  console.log("key src  : ARENA_DEPLOYER_PK");
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

const artifact = JSON.parse(fs.readFileSync(path.join(root, "contracts", "build", "PredictionArena.json"), "utf8"));
console.log("chain    :", chainId, rpcUrl);

// ---- resolve the TOKEN (MURMUR) ----
let token = (env.ARENA_TOKEN || "").trim();
if (!token && chainId === 5042) token = MURMUR_MAINNET;
if (!token) {
  console.error("\n✗ 没有 ARENA_TOKEN。测试网(5042002)上 MURMUR 不是主网那个地址——请先部署/指定测试网 MURMUR，");
  console.error("  并在 .env.local 里写 ARENA_TOKEN=0x…，然后重跑。");
  process.exit(1);
}

// ---- resolve the RESOLVER address (the Worker's facilitator wallet that signs openRound/resolve) ----
// Read it live from the most recent murmur settlement's on-chain `from` so the deployed resolver always
// matches the Worker even when a different key pays the deploy gas. Override with ARENA_RESOLVER.
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
let resolver = (env.ARENA_RESOLVER || "").trim();
if (!resolver) {
  const live = await liveFacilitatorAddress();
  if (live) resolver = live;
}
if (!resolver) resolver = account.address;   // fall back to the deployer

const staleGrace = BigInt(env.ARENA_STALE_GRACE_SEC || "259200");

console.log("deployer :", account.address, "(pays gas)");
console.log("token    :", token, token.toLowerCase() === MURMUR_MAINNET && chainId === 5042 ? "(MURMUR mainnet)" : "");
console.log("resolver :", resolver, resolver.toLowerCase() === account.address.toLowerCase() ? "(= deployer)" : "(Worker's wallet — read live)");
console.log("staleGrace:", staleGrace.toString(), "sec (", (Number(staleGrace) / 86400).toFixed(2), "days )");
if (resolver.toLowerCase() !== account.address.toLowerCase()) {
  console.log("note     : deployer != resolver. The Worker (resolver) must hold gas to open/resolve; the deployer only funds this deployment.");
}

// ---- sanity: the token must be a deployed contract, and the deployer must have gas ----
const code = await publicClient.getCode({ address: token });
if (!code || code === "0x") {
  console.error("\n✗ ARENA_TOKEN 在该链上没有合约代码——地址错了或代币未部署。中止(不会把 arena 接到空气上)。");
  process.exit(1);
}
const bal = await publicClient.getBalance({ address: account.address });
console.log("deployer gas bal:", (Number(bal) / 1e18).toFixed(6), "USDC(native)");
if (bal === 0n) {
  console.error("\n✗ deployer 余额为 0，无法支付部署 gas。请先给该地址充值原生 USDC。");
  process.exit(1);
}

// ---- MAINNET gate: a real-gas, real-token deploy must be explicitly confirmed ----
if (chainId === 5042 && env.ARENA_CONFIRM !== "1") {
  console.error("\n✗ 这是【主网 5042】部署：会花真 gas，并把 arena 接到真 MURMUR 上。");
  console.error("  · 想先演练：把 CHAIN_ID 设为 5042002 + 指定测试网 ARENA_TOKEN，重跑。");
  console.error("  · 确认要上主网：加 ARENA_CONFIRM=1 重跑（并与助手确认过参数）。");
  console.error("  部署后 arena 仍是【关闭】的——上线还需在 wrangler.toml 里设 ARENA_ADDRESS 并把 ARENA_ENABLED 翻成 true。");
  process.exit(1);
}

// ---- deploy ----
console.log("\ndeploying PredictionArena …");
const hash = await wallet.deployContract({ abi: artifact.abi, bytecode: artifact.bytecode, args: [token, resolver, staleGrace] });
console.log("deploy tx:", hash);
const receipt = await publicClient.waitForTransactionReceipt({ hash, confirmations: 1 });
if (receipt.status !== "success") { console.error("✗ 部署交易 revert 了"); process.exit(1); }
const address = receipt.contractAddress;
console.log("arena    :", address);

// ---- self-verify the deployed immutables ----
const onToken = await publicClient.readContract({ address, abi: artifact.abi, functionName: "token" });
const onResolver = await publicClient.readContract({ address, abi: artifact.abi, functionName: "resolver" });
const onGrace = await publicClient.readContract({ address, abi: artifact.abi, functionName: "staleGrace" });
const onCount = await publicClient.readContract({ address, abi: artifact.abi, functionName: "roundCount" });
console.log("verify   : token    =", onToken, onToken.toLowerCase() === token.toLowerCase() ? "✓" : "✗ MISMATCH");
console.log("verify   : resolver =", onResolver, onResolver.toLowerCase() === resolver.toLowerCase() ? "✓" : "✗ MISMATCH");
console.log("verify   : staleGrace=", onGrace.toString(), onGrace === staleGrace ? "✓" : "✗ MISMATCH");
console.log("verify   : roundCount=", onCount.toString(), onCount === 0n ? "(fresh) ✓" : "");

// ---- persist the address for the Worker wiring step ----
fs.writeFileSync(path.join(root, "contracts", "ARENA_ADDRESS.txt"), address + "\n");
let envTxt = fs.existsSync(envFile) ? fs.readFileSync(envFile, "utf8") : "";
if (/^\s*ARENA_ADDRESS\s*=/m.test(envTxt)) {
  envTxt = envTxt.replace(/^\s*ARENA_ADDRESS\s*=.*$/m, `ARENA_ADDRESS=${address}`);
} else {
  envTxt += `\nARENA_ADDRESS=${address}\n`;
}
fs.writeFileSync(envFile, envTxt);

console.log("\n✅ PredictionArena 已部署。地址：", address);
console.log("已写入 contracts/ARENA_ADDRESS.txt 和 .env.local(ARENA_ADDRESS)。");
console.log("下一步(需与助手确认后再做)：在 wrangler.toml 里设 ARENA_ADDRESS=" + address + "，把 ARENA_ENABLED 翻成 \"true\"，重新部署 Worker。");
