// Fully-automatic ContinuityRegistry (PoCA) deployment for murmur's Proof of Continuous Agency.
//
// You fill packages/trader-worker/.env.local with ONE of:
//   ECONOMY_MNEMONIC          (the same seed the Worker uses — we derive the identical facilitator wallet)
//   ECONOMY_FACILITATOR_PK    (a dedicated gas key, if the Worker was configured with one)
//   ARENA_DEPLOYER_PK         (any gas wallet key to deploy; the committer is resolved separately)
// then run:  node scripts/deploy-poca-auto.mjs            (dry-run: gas estimate only, no broadcast)
//            POCA_CONFIRM=1 node scripts/deploy-poca-auto.mjs   (real mainnet broadcast)
//
// It deploys ContinuityRegistry(committer = the SAME address the Worker's facilitator signs from) so the
// Worker can openEpoch/sealEpoch/adminAction as the authorized committer. The committer is resolved with
// TWO independent on-chain sources that must agree (mirrors deploy-arena-auto.mjs discipline):
//   1. PredictionArena.resolver()  — read live from the deployed arena (contracts/ARENA_ADDRESS.txt)
//   2. tx.from of the most recent murmur settlement proof (GET /proofs → getTransaction)
// Override with POCA_COMMITTER (must still match the live sources when they resolve). The secret key is
// never printed.
//
// SAFETY: this spends REAL gas. It defaults to the chain in CHAIN_ID (5042 mainnet) and a real deploy
// on ANY chain is gated behind POCA_CONFIRM=1 — without it the script only prints the deployer / committer /
// gas estimate and exits 0 (dry-run).
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
// Run-scoped knobs: an EXPLICIT process.env value WINS over .env.local (mirrors deploy-manifest-auto.mjs:55-58).
// This matters because a production .env.local may pin CHAIN_ID=5042 (mainnet); an explicit
// `CHAIN_ID=5042002 node deploy-poca-auto.mjs` must reliably target testnet regardless of the file. Review #12.
for (const k of ["HTTPS_PROXY", "HTTP_PROXY", "CHAIN_ID", "RPC_URL", "POCA_COMMITTER", "POCA_COMMITTER_CONFIRM"]) {
  if (process.env[k]) env[k] = process.env[k];
}
// POCA_CONFIRM is a COMMAND-LINE-ONLY gate: it must NEVER be sourced from .env.local (Review #12). Otherwise a
// stale `POCA_CONFIRM=1` left in the file would silently authorize a real-gas mainnet broadcast on every run.
delete env.POCA_CONFIRM;
if (process.env.POCA_CONFIRM) env.POCA_CONFIRM = process.env.POCA_CONFIRM;

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
  console.error("\n✗ No key. Put ECONOMY_MNEMONIC or a private key in packages/trader-worker/.env.local, then re-run.");
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

// ---- forge artifact (contracts/out/ContinuityRegistry.sol/ContinuityRegistry.json) ----
const artifact = JSON.parse(
  fs.readFileSync(path.join(root, "contracts", "out", "ContinuityRegistry.sol", "ContinuityRegistry.json"), "utf8"),
);
console.log("chain    :", chainId, rpcUrl);
console.log("artifact : forge out/ContinuityRegistry.sol (solc", artifact.metadata?.compiler?.version || "n/a", ")");

// ---- resolve the COMMITTER (the Worker's facilitator wallet that signs openEpoch/sealEpoch/adminAction) ----
// Source 1: PredictionArena.resolver() read live from the deployed arena.
// Source 2: tx.from of the most recent murmur settlement proof.
// Both must agree; POCA_COMMITTER overrides but is cross-checked against any source that resolves.
async function arenaResolverAddress() {
  try {
    const arenaFile = path.join(root, "contracts", "ARENA_ADDRESS.txt");
    const arena = (env.ARENA_ADDRESS || (fs.existsSync(arenaFile) ? fs.readFileSync(arenaFile, "utf8") : "")).trim();
    if (!/^0x[0-9a-fA-F]{40}$/.test(arena)) return null;
    return await publicClient.readContract({
      address: arena,
      abi: [{ type: "function", name: "resolver", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] }],
      functionName: "resolver",
    });
  } catch { return null; }
}
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

const fromArena = await arenaResolverAddress();
const fromProofs = await liveFacilitatorAddress();
console.log("committer src arena.resolver():", fromArena ?? "(unresolved)");
console.log("committer src proofs tx.from :", fromProofs ?? "(unresolved)");
if (fromArena && fromProofs && fromArena.toLowerCase() !== fromProofs.toLowerCase()) {
  console.error("\n✗ The two live committer sources DISAGREE — refusing to guess. Investigate before deploying.");
  process.exit(1);
}

// Review #14: an explicit POCA_COMMITTER is validated UNCONDITIONALLY as a 0x-prefixed 20-byte address,
// regardless of whether the live cross-sources resolve. A malformed override must fail fast, not deploy.
const ADDR_RE = /^0x[0-9a-fA-F]{40}$/;
const pocaCommitterArg = (env.POCA_COMMITTER || "").trim();
if (pocaCommitterArg && !ADDR_RE.test(pocaCommitterArg)) {
  console.error("\n✗ POCA_COMMITTER", JSON.stringify(pocaCommitterArg), "is not a valid 0x…(40 hex) address — refusing to deploy.");
  process.exit(1);
}

let committer = pocaCommitterArg || fromArena || fromProofs || "";
if (!committer) {
  console.error("\n✗ Could not resolve the committer from any source. Set POCA_COMMITTER=0x… in the environment.");
  process.exit(1);
}
const live = fromArena || fromProofs;
if (live && committer.toLowerCase() !== live.toLowerCase()) {
  console.error("\n✗ POCA_COMMITTER", committer, "does not match the live facilitator", live, "— refusing to deploy.");
  process.exit(1);
}

// Review #14: when BOTH independent on-chain cross-sources fail to resolve, the committer is UNVERIFIED.
// Require an explicit POCA_COMMITTER_CONFIRM=1 (command-line only) before trusting it, and warn loudly.
if (!fromArena && !fromProofs) {
  console.warn("\n⚠ Both live committer cross-sources FAILED to resolve (arena.resolver() and proofs tx.from).");
  console.warn("⚠ committer", committer, "could NOT be verified against the chain.");
  if ((env.POCA_COMMITTER_CONFIRM || "").trim() !== "1") {
    console.error("✗ Refusing to deploy with an unverified committer. Re-run with POCA_COMMITTER_CONFIRM=1 to override.");
    process.exit(1);
  }
  console.warn("⚠ POCA_COMMITTER_CONFIRM=1 set — proceeding with the UNVERIFIED committer.");
}

console.log("deployer :", account.address, "(pays gas)");
console.log("committer:", committer, committer.toLowerCase() === account.address.toLowerCase() ? "(= deployer)" : "(Worker's wallet — read live)");
if (committer.toLowerCase() !== account.address.toLowerCase()) {
  console.log("note     : deployer != committer. The Worker (committer) signs openEpoch/sealEpoch; the deployer only funds this deployment.");
}

// ---- sanity: the deployer must have gas ----
const bal = await publicClient.getBalance({ address: account.address });
console.log("deployer gas bal:", (Number(bal) / 1e18).toFixed(6), "USDC(native)");
if (bal === 0n) {
  console.error("\n✗ deployer balance is 0 — cannot pay deploy gas. Fund the address first.");
  process.exit(1);
}

// ---- dry-run: gas estimate for the deployment (constructor args = [committer]), no broadcast ----
// eth_estimateGas with a bare data param is rejected by some Arc RPC nodes, so estimate via a plain
// eth_call of the exact deployment data — the node simulates the creation and reports the gas used.
// The constructor arg is ABI-encoded (address ⇒ left-padded 32-byte word) and appended to the bytecode.
// NB: the forge artifact's bytecode.object already carries the 0x prefix — do not add another one.
const bytecode = artifact.bytecode?.object ?? artifact.bytecode;
const ctorArg = committer.toLowerCase().slice(2).padStart(64, "0");
const callRes = await publicClient
  .call({ account: account.address, data: bytecode + ctorArg })
  .catch((e) => { console.error("deploy eth_call (gas estimate) failed:", e?.shortMessage || e?.message || e); process.exit(1); });
console.log("gas est  :", callRes.gas ? BigInt(callRes.gas).toString() : "(node did not report gas; call itself succeeded)");

// ---- deploy gate: a real-gas deploy must be explicitly confirmed, on ANY chain ----
// Review WARN-4: the gate used to be mainnet-only (`chainId === 5042 && …`), which let a non-mainnet
// run broadcast without confirmation. Now POCA_CONFIRM !== "1" ALWAYS stops at dry-run.
if (env.POCA_CONFIRM !== "1") {
  console.log("\n· DRY-RUN ONLY (no POCA_CONFIRM=1): nothing was broadcast.");
  console.log(`· To deploy for real on chain ${chainId}: re-run with POCA_CONFIRM=1.`);
  process.exit(0);
}

// ---- deploy ----
console.log("\ndeploying ContinuityRegistry …");
const hash = await wallet.deployContract({ abi: artifact.abi, bytecode, args: [committer] });
console.log("deploy tx:", hash);
const receipt = await publicClient.waitForTransactionReceipt({ hash, confirmations: 1 });
if (receipt.status !== "success") { console.error("✗ deployment tx reverted"); process.exit(1); }
const address = receipt.contractAddress;
console.log("registry :", address);
console.log("gas used :", receipt.gasUsed.toString());

// ---- self-verify the deployed immutables ----
const onCommitter = await publicClient.readContract({ address, abi: artifact.abi, functionName: "committer" });
const onCount = await publicClient.readContract({ address, abi: artifact.abi, functionName: "epochCount" });
console.log("verify   : committer =", onCommitter, onCommitter.toLowerCase() === committer.toLowerCase() ? "✓" : "✗ MISMATCH");
console.log("verify   : epochCount=", onCount.toString(), onCount === 0n ? "(fresh) ✓" : "✗ NOT FRESH");
if (onCommitter.toLowerCase() !== committer.toLowerCase() || onCount !== 0n) process.exit(1);

// ---- persist the address for the Worker wiring step ----
// Review #13: NEVER rewrite .env.local. That file holds ECONOMY_MNEMONIC / private keys, and a
// read-modify-write of it risks corrupting or leaking secrets. We write ONLY the dedicated
// POCA_ADDRESS.txt artifact and print a manual instruction for the operator.
fs.writeFileSync(path.join(root, "contracts", "POCA_ADDRESS.txt"), address + "\n");

console.log("\n✅ ContinuityRegistry deployed. Address:", address);
console.log("Wrote contracts/POCA_ADDRESS.txt.");
console.log(`Next: add POCA_REGISTRY_ADDRESS=${address} to .env.local manually if needed,`);
console.log("      then backfill the address into src/config.ts (code default) and redeploy the Worker.");
