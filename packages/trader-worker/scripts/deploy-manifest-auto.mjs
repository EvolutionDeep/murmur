// Fully-automatic NeuralManifestRegistry deployment + brain-manifest commitment for murmur.
//
// This is the "prove the brain, trustlessly" anchor. It does TWO irreversible-ish things in one run:
//   1. deploys contracts/NeuralManifestRegistry.sol (a pure commitment log — holds NO funds, no upgrade),
//   2. commits the AUTHORITATIVE production manifestHash to it, after re-running the offline replay so a
//      manifest that does not reproduce from its committed seeds is NEVER anchored.
//
// The manifestHash is computed by spawning the verified offline CLI (scripts/replay-brain.ts --from-wrangler),
// which reads the DEPLOYED sizing from wrangler.toml (production is 10x) — so this script always commits the
// brain the Worker actually runs, not the coded default. The CLI must report PASS (exit 0) or we abort.
//
// SAFETY / CHAIN SELECTION (this spends gas, so mainnet is gated):
//   • DEFAULT is Arc TESTNET (CHAIN_ID 5042002) — a zero-real-money dry run of the whole flow.
//   • Deploying to Arc MAINNET (5042) additionally requires MANIFEST_CONFIRM=1 in the environment.
//
// You fill packages/trader-worker/.env.local with ONE of (the SAME shape deploy-registry-auto.mjs uses):
//   MANIFEST_DEPLOYER_PK   (any gas wallet key — deploys AND is the committer, so it can commit)
//   ECONOMY_FACILITATOR_PK (a dedicated gas key)
//   ECONOMY_MNEMONIC       (the Worker seed — we derive the identical facilitator wallet)
// then run:  node scripts/deploy-manifest-auto.mjs
//
// The committer defaults to the deployer so THIS script can commit; override with MANIFEST_COMMITTER (then
// the deploy-only path runs and the commit is skipped, since only the committer may commit). The secret key
// is never printed.
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
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
    // Strip one layer of matching surrounding quotes (standard .env convention): KEY="0x.." or KEY='0x..'.
    // Without this, a quoted value would be fed to normPk as `"0x.."` -> `0x"0x.."` -> invalid private key.
    let val = line.slice(i + 1).trim();
    const q = val[0];
    if (val.length >= 2 && (q === '"' || q === "'") && val[val.length - 1] === q) val = val.slice(1, -1).trim();
    out[line.slice(0, i).trim()] = val;
  }
  return out;
}
const envFile = path.join(root, ".env.local");
const env = { ...readEnv(envFile) };
// Run-scoped knobs: an EXPLICIT process.env value WINS over .env.local. This matters because production
// .env.local may pin CHAIN_ID=5042 (mainnet); an explicit `CHAIN_ID=5042002 npm run deploy:manifest` must
// reliably target testnet regardless. Absent a process.env value we fall back to .env.local (or the default).
for (const k of ["HTTPS_PROXY", "HTTP_PROXY", "CHAIN_ID", "MANIFEST_CONFIRM", "MANIFEST_COMMITTER", "MANIFEST_HASH"]) {
  if (process.env[k]) env[k] = process.env[k];
}

// ---- proxy (Node's global fetch/undici honours the global dispatcher) ----
const proxy = env.HTTPS_PROXY || env.HTTP_PROXY;
if (proxy) {
  const { ProxyAgent, setGlobalDispatcher } = await import("undici");
  setGlobalDispatcher(new ProxyAgent(proxy));
  console.log("proxy    :", proxy);
}

// ---- chain: DEFAULT TESTNET; mainnet requires an explicit MANIFEST_CONFIRM=1 ----
const chainId = Number(env.CHAIN_ID || "5042002");
const isMainnet = chainId === 5042;
if (isMainnet && (env.MANIFEST_CONFIRM || "").trim() !== "1") {
  console.error("\n✗ 拒绝主网部署：CHAIN_ID=5042 需要显式设置 MANIFEST_CONFIRM=1（部署合约会花真实 gas，不可逆）。");
  console.error("  先跑测试网（CHAIN_ID=5042002，默认）验证全链路，再考虑主网。");
  process.exit(1);
}
const rpcUrl = env.RPC_URL || (isMainnet ? "https://rpc.mainnet.arc.io" : "https://rpc.testnet.arc.io");
const chain = {
  id: chainId,
  name: isMainnet ? "Arc Mainnet" : "Arc Testnet",
  nativeCurrency: { name: "USDC", symbol: "USDC", decimals: 18 },
  rpcUrls: { default: { http: [rpcUrl] } },
};

// ---- resolve the deployer / committer account (same derivation as the Worker) ----
const FACILITATOR_ACCOUNT_INDEX = 2_000_000; // must match src/keys.ts
const normPk = (s) => (s.startsWith("0x") ? s : `0x${s}`);
const isHexKey = (s) => /^(0x)?[0-9a-fA-F]{64}$/.test(s.trim());
let account;
if (env.MANIFEST_DEPLOYER_PK) {
  account = privateKeyToAccount(normPk(env.MANIFEST_DEPLOYER_PK.trim()));
  console.log("key src  : MANIFEST_DEPLOYER_PK");
} else if (env.ECONOMY_FACILITATOR_PK) {
  account = privateKeyToAccount(normPk(env.ECONOMY_FACILITATOR_PK.trim()));
  console.log("key src  : ECONOMY_FACILITATOR_PK");
} else if (env.ECONOMY_MNEMONIC) {
  const m = env.ECONOMY_MNEMONIC.trim();
  if (isHexKey(m)) {
    account = privateKeyToAccount(normPk(m)); // a raw PK was pasted into the mnemonic field
    console.log("key src  : ECONOMY_MNEMONIC field held a raw hex private key (used as PK)");
  } else {
    account = mnemonicToAccount(m, { accountIndex: FACILITATOR_ACCOUNT_INDEX });
    console.log("key src  : ECONOMY_MNEMONIC (derived facilitator, accountIndex " + FACILITATOR_ACCOUNT_INDEX + ")");
  }
} else {
  console.error("\n✗ 没有密钥。请在 packages/trader-worker/.env.local 里填写 ECONOMY_MNEMONIC 或一把私钥，然后重跑。");
  process.exit(1);
}

// committer defaults to the deployer (so this script can commit). An explicit override ⇒ deploy-only.
const committerOverride = (env.MANIFEST_COMMITTER || "").trim();
const committer = committerOverride || account.address;
const canCommit = committer.toLowerCase() === account.address.toLowerCase();

const publicClient = createPublicClient({ chain, transport: http(rpcUrl) });
const wallet = createWalletClient({ chain, transport: http(rpcUrl), account });
const artifact = JSON.parse(fs.readFileSync(path.join(root, "contracts", "build", "NeuralManifestRegistry.json"), "utf8"));

console.log("chain    :", chainId, isMainnet ? "(MAINNET — MANIFEST_CONFIRM ok)" : "(testnet)", rpcUrl);
console.log("deployer :", account.address, "(pays gas)");
console.log("committer:", committer, canCommit ? "(= deployer)" : "(override — deploy-only, commit skipped)");

// ---- gas sanity ----
const bal = await publicClient.getBalance({ address: account.address });
console.log("deployer gas bal:", (Number(bal) / 1e18).toFixed(6), "USDC(native)");
if (bal === 0n) {
  console.error("\n✗ deployer 余额为 0，无法支付部署 gas。请先给该地址充值原生 USDC。");
  process.exit(1);
}

// ---- compute the AUTHORITATIVE production manifestHash via the verified offline replay CLI ----
// Spawns scripts/replay-brain.ts --from-wrangler so the hash reflects the DEPLOYED 10x sizing, and refuses
// to continue unless the replay PASSES (exit 0) — an unreproducible brain is never anchored on-chain.
let manifestHashHex = (env.MANIFEST_HASH || "").trim().replace(/^0x/i, "");
let schemaVersion = 1;
let population = 0;
if (manifestHashHex) {
  console.log("manifest : using MANIFEST_HASH from env (skipping local replay)");
} else {
  const manifestFile = path.join(root, "contracts", "build", "PRODUCTION_MANIFEST.json");
  const hashFile = path.join(root, "contracts", "build", "PRODUCTION_MANIFEST_HASH.txt");
  console.log("manifest : assembling + replaying the production brain (offline, from wrangler.toml) …");
  try {
    execFileSync("npx", ["tsx", "scripts/replay-brain.ts", "--from-wrangler", "--out", manifestFile, "--out-hash", hashFile], {
      cwd: root,
      stdio: "inherit",
      shell: process.platform === "win32", // npx is a .cmd shim on Windows
    });
  } catch (e) {
    console.error("\n✗ replay CLI 未通过（退出码非 0）——生产脑无法从承诺种子重建，拒绝上链。");
    process.exit(1);
  }
  manifestHashHex = fs.readFileSync(hashFile, "utf8").trim().replace(/^0x/i, "");
  const body = JSON.parse(fs.readFileSync(manifestFile, "utf8"));
  schemaVersion = Number(body.v ?? 1);
  population = Number(body.population?.size ?? 0);
  if (!/^[0-9a-fA-F]{64}$/.test(manifestHashHex)) {
    console.error("✗ replay CLI 未产出合法的 manifestHash");
    process.exit(1);
  }
  console.log("manifest : hash 0x" + manifestHashHex);
  console.log("manifest : schemaVersion", schemaVersion, "· population", population);
}
const manifestHashBytes32 = `0x${manifestHashHex}`;

// ---- deploy ----
console.log("\ndeploying NeuralManifestRegistry …");
const deployTx = await wallet.deployContract({ abi: artifact.abi, bytecode: artifact.bytecode, args: [committer] });
console.log("deploy tx:", deployTx);
const receipt = await publicClient.waitForTransactionReceipt({ hash: deployTx, confirmations: 1 });
if (receipt.status !== "success") { console.error("✗ 部署交易 revert 了"); process.exit(1); }
const address = receipt.contractAddress;
console.log("registry :", address);

// ---- self-verify the deployed immutables ----
const onchainCommitter = await publicClient.readContract({ address, abi: artifact.abi, functionName: "committer" });
console.log("verify   : committer =", onchainCommitter, onchainCommitter.toLowerCase() === committer.toLowerCase() ? "✓" : "✗ MISMATCH");

// ---- commit the production manifestHash (only if this key is the committer) ----
if (canCommit) {
  console.log("\ncommitting brain manifest …");
  const commitTx = await wallet.writeContract({
    address,
    abi: artifact.abi,
    functionName: "commit",
    args: [manifestHashBytes32, schemaVersion, population],
  });
  console.log("commit tx:", commitTx);
  const commitReceipt = await publicClient.waitForTransactionReceipt({ hash: commitTx, confirmations: 1 });
  if (commitReceipt.status !== "success") { console.error("✗ commit 交易 revert 了"); process.exit(1); }
  const committed = await publicClient.readContract({ address, abi: artifact.abi, functionName: "isCommitted", args: [manifestHashBytes32] });
  const latest = await publicClient.readContract({ address, abi: artifact.abi, functionName: "latestHash" });
  console.log("verify   : isCommitted =", committed, committed ? "✓" : "✗");
  console.log("verify   : latestHash  =", latest, latest.toLowerCase() === manifestHashBytes32.toLowerCase() ? "✓" : "✗ MISMATCH");
} else {
  console.log("\n⚠ MANIFEST_COMMITTER != deployer：仅部署，未提交。请让 committer 自行调用 commit(" + manifestHashBytes32 + ", " + schemaVersion + ", " + population + ")。");
}

// ---- persist the address for the Worker wiring step ----
fs.writeFileSync(path.join(root, "contracts", "MANIFEST_REGISTRY_ADDRESS.txt"), address + "\n");
let envTxt = fs.existsSync(envFile) ? fs.readFileSync(envFile, "utf8") : "";
if (/^\s*MANIFEST_REGISTRY_ADDRESS\s*=/m.test(envTxt)) {
  envTxt = envTxt.replace(/^\s*MANIFEST_REGISTRY_ADDRESS\s*=.*$/m, `MANIFEST_REGISTRY_ADDRESS=${address}`);
} else {
  envTxt += `\nMANIFEST_REGISTRY_ADDRESS=${address}\n`;
}
fs.writeFileSync(envFile, envTxt);

console.log("\n✅ NeuralManifestRegistry 已部署" + (canCommit ? " 且已提交生产脑清单。" : "（未提交）。"));
console.log("地址：", address, "· chain", chainId);
console.log("已写入 contracts/MANIFEST_REGISTRY_ADDRESS.txt 和 .env.local(MANIFEST_REGISTRY_ADDRESS)。");
console.log("下一步：把该地址填进 wrangler.toml 的 MANIFEST_REGISTRY_ADDRESS 并重部署 Worker（由助手在你签字后进行）。");
