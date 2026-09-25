// Commit-only re-anchor for murmur's brain manifest — NO contract deployment.
//
// deploy-manifest-auto.mjs deploys a BRAND-NEW NeuralManifestRegistry every run. When the connectome
// sizing changes (e.g. the 10,800 → 30,800 scale-up) the manifestHash rotates, but the registry does
// NOT need to move: NeuralManifestRegistry.commit() is an append-only log, so the SAME committer can
// commit the new hash against the EXISTING registry, which rotates `latestHash` and bumps `commitCount`.
// This script does exactly that and nothing else.
//
// SAFETY (this spends real gas on whatever CHAIN_ID selects, and a commit is irreversible):
//   • DEFAULT is Arc TESTNET (CHAIN_ID 5042002). Arc MAINNET (5042) requires MANIFEST_CONFIRM=1.
//   • The manifestHash is (re)computed by spawning the verified offline replay CLI
//     (scripts/replay-brain.ts --from-wrangler), which must report PASS (exit 0) or we abort.
//   • If APPROVED_HASH is set, the freshly computed hash MUST equal it (case-insensitive) or we abort —
//     this binds the broadcast to the exact hash a human already eyeballed. No silent drift.
//   • Read-only pre-flight: assert committer() == our address (else the tx would revert NotCommitter),
//     assert isCommitted(hash) == false (else it would revert AlreadyCommitted), and print the current
//     latestHash so the old → new rotation is explicit in the log. The secret key is NEVER printed.
//
// .env.local (packages/trader-worker/.env.local) supplies ONE of:
//   MANIFEST_DEPLOYER_PK | ECONOMY_FACILITATOR_PK | ECONOMY_MNEMONIC (facilitator wallet is derived)
// The registry address comes from MANIFEST_REGISTRY_ADDRESS (env) or contracts/MANIFEST_REGISTRY_ADDRESS.txt.
//
// Usage (mainnet re-anchor):
//   CHAIN_ID=5042 MANIFEST_CONFIRM=1 APPROVED_HASH=0x.. node scripts/commit-manifest.mjs
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createPublicClient, createWalletClient, http } from "viem";
import { mnemonicToAccount, privateKeyToAccount } from "viem/accounts";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, "..");

// Minimal ABI for the four functions we touch (source: contracts/NeuralManifestRegistry.sol). Inlined so
// this script needs NO forge build artifact — the full contract is a pure commitment log with no funds.
const ABI = [
  {
    type: "function", name: "commit", stateMutability: "nonpayable",
    inputs: [
      { name: "manifestHash", type: "bytes32" },
      { name: "schemaVersion", type: "uint32" },
      { name: "population", type: "uint32" },
    ],
    outputs: [],
  },
  { type: "function", name: "committer", stateMutability: "view", inputs: [], outputs: [{ name: "", type: "address" }] },
  { type: "function", name: "latestHash", stateMutability: "view", inputs: [], outputs: [{ name: "", type: "bytes32" }] },
  { type: "function", name: "commitCount", stateMutability: "view", inputs: [], outputs: [{ name: "", type: "uint256" }] },
  {
    type: "function", name: "isCommitted", stateMutability: "view",
    inputs: [{ name: "manifestHash", type: "bytes32" }], outputs: [{ name: "", type: "bool" }],
  },
  {
    type: "event", name: "ManifestCommitted",
    inputs: [
      { name: "manifestHash", type: "bytes32", indexed: true },
      { name: "schemaVersion", type: "uint32", indexed: false },
      { name: "population", type: "uint32", indexed: false },
      { name: "by", type: "address", indexed: false },
      { name: "ts", type: "uint256", indexed: false },
    ],
  },
];

// ---- read .env.local (KEY=VALUE, # comments, blank lines; strips one layer of matching quotes) ----
function readEnv(file) {
  const out = {};
  if (!fs.existsSync(file)) return out;
  for (const raw of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const i = line.indexOf("=");
    if (i < 0) continue;
    let val = line.slice(i + 1).trim();
    const q = val[0];
    if (val.length >= 2 && (q === '"' || q === "'") && val[val.length - 1] === q) val = val.slice(1, -1).trim();
    out[line.slice(0, i).trim()] = val;
  }
  return out;
}
const envFile = path.join(root, ".env.local");
const env = { ...readEnv(envFile) };
// An EXPLICIT process.env value WINS over .env.local (so `CHAIN_ID=5042 .. node commit-manifest.mjs`
// reliably targets mainnet even if .env.local pins something else).
for (const k of [
  "HTTPS_PROXY", "HTTP_PROXY", "RPC_URL", "CHAIN_ID", "MANIFEST_CONFIRM",
  "MANIFEST_REGISTRY_ADDRESS", "MANIFEST_HASH", "MANIFEST_SCHEMA", "MANIFEST_POPULATION", "APPROVED_HASH",
]) {
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
  console.error("\n✗ 拒绝主网 commit：CHAIN_ID=5042 需要显式设置 MANIFEST_CONFIRM=1（会花真实 gas，不可逆）。");
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

// ---- resolve the committer account (same derivation as the Worker / deploy script) ----
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

// ---- resolve the EXISTING registry address (env wins, else the persisted .txt) ----
let address = (env.MANIFEST_REGISTRY_ADDRESS || "").trim();
if (!address) {
  const addrFile = path.join(root, "contracts", "MANIFEST_REGISTRY_ADDRESS.txt");
  if (fs.existsSync(addrFile)) address = fs.readFileSync(addrFile, "utf8").trim();
}
if (!/^0x[0-9a-fA-F]{40}$/.test(address)) {
  console.error("\n✗ 没有合法的 registry 地址。设 MANIFEST_REGISTRY_ADDRESS 或填 contracts/MANIFEST_REGISTRY_ADDRESS.txt。");
  process.exit(1);
}

const publicClient = createPublicClient({ chain, transport: http(rpcUrl) });
const wallet = createWalletClient({ chain, transport: http(rpcUrl), account });

console.log("chain    :", chainId, isMainnet ? "(MAINNET — MANIFEST_CONFIRM ok)" : "(testnet)", rpcUrl);
console.log("committer:", account.address, "(pays gas)");
console.log("registry :", address, "(existing — commit-only, NO deploy)");

// ---- compute the AUTHORITATIVE production manifestHash via the verified offline replay CLI ----
let manifestHashHex = (env.MANIFEST_HASH || "").trim().replace(/^0x/i, "");
let schemaVersion = Number(env.MANIFEST_SCHEMA || 0);
let population = Number(env.MANIFEST_POPULATION || 0);
if (manifestHashHex && schemaVersion && population) {
  console.log("manifest : using MANIFEST_HASH/SCHEMA/POPULATION from env (skipping local replay)");
} else {
  const buildDir = path.join(root, "contracts", "build");
  fs.mkdirSync(buildDir, { recursive: true });
  const manifestFile = path.join(buildDir, "PRODUCTION_MANIFEST.json");
  const hashFile = path.join(buildDir, "PRODUCTION_MANIFEST_HASH.txt");
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
}
if (!/^[0-9a-fA-F]{64}$/.test(manifestHashHex)) {
  console.error("✗ 未产出合法的 manifestHash");
  process.exit(1);
}
const manifestHashBytes32 = `0x${manifestHashHex.toLowerCase()}`;
console.log("manifest : hash", manifestHashBytes32);
console.log("manifest : schemaVersion", schemaVersion, "· population", population);

// ---- pin to the human-approved hash (if provided) — binds the broadcast to what was eyeballed ----
const approved = (env.APPROVED_HASH || "").trim().replace(/^0x/i, "").toLowerCase();
if (approved) {
  if (approved !== manifestHashHex.toLowerCase()) {
    console.error(`\n✗ 计算出的 hash 与你批准的 APPROVED_HASH 不一致，拒绝上链。`);
    console.error(`  computed : 0x${manifestHashHex.toLowerCase()}`);
    console.error(`  approved : 0x${approved}`);
    process.exit(1);
  }
  console.log("manifest : APPROVED_HASH 匹配 ✓（广播的就是你核对过的那一枚）");
}

// ---- gas sanity ----
const bal = await publicClient.getBalance({ address: account.address });
console.log("gas bal  :", (Number(bal) / 1e18).toFixed(6), "USDC(native)");
if (bal === 0n) {
  console.error("\n✗ committer 余额为 0，无法支付 gas。请先给该地址充值原生 USDC。");
  process.exit(1);
}

// ---- read-only pre-flight against the EXISTING registry ----
const onchainCommitter = await publicClient.readContract({ address, abi: ABI, functionName: "committer" });
const committerOk = onchainCommitter.toLowerCase() === account.address.toLowerCase();
console.log("precheck : committer() =", onchainCommitter, committerOk ? "✓ (= our key)" : "✗ MISMATCH");
if (!committerOk) {
  console.error("\n✗ 我们的地址不是该 registry 的 committer，commit() 会 revert NotCommitter。终止。");
  process.exit(1);
}
const already = await publicClient.readContract({ address, abi: ABI, functionName: "isCommitted", args: [manifestHashBytes32] });
console.log("precheck : isCommitted(new) =", already, already ? "✗ 已提交过" : "✓ (未提交，可追加)");
if (already) {
  console.error("\n✗ 该 hash 已在链上（commit() 会 revert AlreadyCommitted）。无需重复提交，终止。");
  process.exit(1);
}
const oldLatest = await publicClient.readContract({ address, abi: ABI, functionName: "latestHash" });
const oldCount = await publicClient.readContract({ address, abi: ABI, functionName: "commitCount" });
console.log("precheck : latestHash (old) =", oldLatest);
console.log("precheck : commitCount (old) =", String(oldCount));

// ---- broadcast the commit (append-only; rotates latestHash to the new sizing) ----
console.log("\ncommitting brain manifest (commit-only, existing registry) …");
const commitTx = await wallet.writeContract({
  address,
  abi: ABI,
  functionName: "commit",
  args: [manifestHashBytes32, schemaVersion, population],
});
console.log("commit tx:", commitTx);
const receipt = await publicClient.waitForTransactionReceipt({ hash: commitTx, confirmations: 1 });
if (receipt.status !== "success") {
  console.error("✗ commit 交易 revert 了");
  process.exit(1);
}

// ---- post-verify the rotation ----
const committed = await publicClient.readContract({ address, abi: ABI, functionName: "isCommitted", args: [manifestHashBytes32] });
const latest = await publicClient.readContract({ address, abi: ABI, functionName: "latestHash" });
const newCount = await publicClient.readContract({ address, abi: ABI, functionName: "commitCount" });
console.log("verify   : isCommitted(new) =", committed, committed ? "✓" : "✗");
console.log("verify   : latestHash (new) =", latest, latest.toLowerCase() === manifestHashBytes32.toLowerCase() ? "✓" : "✗ MISMATCH");
console.log("verify   : commitCount", String(oldCount), "→", String(newCount));
console.log("receipt  : block", String(receipt.blockNumber), "· gasUsed", String(receipt.gasUsed), "· status", receipt.status);

const ok = committed && latest.toLowerCase() === manifestHashBytes32.toLowerCase();
console.log(ok ? "\n✅ 新脑清单已上链（latestHash 已旋转）。" : "\n✗ 上链后校验未通过，请人工核查。");
process.exit(ok ? 0 : 1);
