// Deploy PredictionArena to Arc — the manual, env-var-driven counterpart to deploy-arena-auto.mjs.
//
//   ARENA_DEPLOYER_PK   (required) private key of the deployer (pays gas)
//   ARENA_TOKEN         (required) MURMUR ERC-20 the arena is denominated in (0x…40). On mainnet it is
//                      0x8faae5592b9acc27a79fca745c6b872adf514a5d; testnet needs its own deployed MURMUR.
//   ARENA_RESOLVER      (optional) the address that may open/resolve rounds — MUST be the Worker's
//                      facilitator wallet. Defaults to the deployer (only correct if the deployer IS the
//                      Worker's wallet). deploy-arena-auto.mjs reads this live instead — prefer it.
//   ARENA_STALE_GRACE_SEC (optional) seconds past a deadline before anyone may expire a round (default 259200 = 3d)
//   RPC_URL             (optional) default https://rpc.mainnet.arc.io
//   CHAIN_ID            (optional) default 5042
//   ARENA_CONFIRM       (required =1 for a MAINNET deploy — a real-gas, real-token deploy is gated)
//
// Run: node scripts/deploy-arena.mjs
// NOTE: this spends real gas on whichever chain CHAIN_ID points at. Point at testnet (5042002) first.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createPublicClient, createWalletClient, http, privateKeyToAccount } from "viem";

const here = path.dirname(fileURLToPath(import.meta.url));
const artifact = JSON.parse(
  fs.readFileSync(path.join(here, "..", "contracts", "build", "PredictionArena.json"), "utf8"),
);

const pk = process.env.ARENA_DEPLOYER_PK;
if (!pk) { console.error("ARENA_DEPLOYER_PK is required"); process.exit(1); }
const token = (process.env.ARENA_TOKEN || "").trim();
if (!token) { console.error("ARENA_TOKEN is required (MURMUR 0x…40)"); process.exit(1); }

const chainId = Number(process.env.CHAIN_ID || "5042");
const rpcUrl = process.env.RPC_URL || (chainId === 5042 ? "https://rpc.mainnet.arc.io" : "https://rpc.testnet.arc.io");
if (chainId === 5042 && process.env.ARENA_CONFIRM !== "1") {
  console.error("✗ MAINNET deploy is gated: re-run with ARENA_CONFIRM=1 (or use CHAIN_ID=5042002 for testnet).");
  process.exit(1);
}

const chain = {
  id: chainId,
  name: chainId === 5042 ? "Arc Mainnet" : "Arc Testnet",
  nativeCurrency: { name: "USDC", symbol: "USDC", decimals: 18 },
  rpcUrls: { default: { http: [rpcUrl] } },
};

const account = privateKeyToAccount(pk.startsWith("0x") ? pk : `0x${pk}`);
const resolver = (process.env.ARENA_RESOLVER || account.address).trim();
const staleGrace = BigInt(process.env.ARENA_STALE_GRACE_SEC || "259200");

const publicClient = createPublicClient({ chain, transport: http(rpcUrl) });
const wallet = createWalletClient({ chain, transport: http(rpcUrl), account });

console.log("deployer :", account.address);
console.log("token    :", token);
console.log("resolver :", resolver);
console.log("staleGrace:", staleGrace.toString());
console.log("chain    :", chainId, rpcUrl);

const code = await publicClient.getCode({ address: token });
if (!code || code === "0x") { console.error("✗ ARENA_TOKEN has no contract code on this chain"); process.exit(1); }

const hash = await wallet.deployContract({
  abi: artifact.abi,
  bytecode: artifact.bytecode,
  args: [token, resolver, staleGrace],
});
console.log("deploy tx:", hash);
const receipt = await publicClient.waitForTransactionReceipt({ hash, confirmations: 1 });
if (receipt.status !== "success") { console.error("deploy reverted"); process.exit(1); }
const address = receipt.contractAddress;
console.log("arena    :", address);

console.log("\nNext: set the Worker vars ARENA_ADDRESS=" + address + " and ARENA_TOKEN=" + token + ", then ARENA_ENABLED=true to go live.");
