// Compile contracts/WarCoffer.sol with the npm `solc` (JS) compiler and emit a single artifact
// { abi, bytecode } that the deploy script and the worker's viem integration consume.
// Run: node scripts/compile-war.mjs
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import solc from "solc";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const solPath = path.join(root, "contracts", "WarCoffer.sol");
const outDir = path.join(root, "contracts", "build");
const outPath = path.join(outDir, "WarCoffer.json");

const source = fs.readFileSync(solPath, "utf8");
const input = {
  language: "Solidity",
  sources: { "WarCoffer.sol": { content: source } },
  settings: {
    optimizer: { enabled: true, runs: 200 },
    outputSelection: { "*": { "*": ["abi", "evm.bytecode.object"] } },
  },
};

const out = JSON.parse(solc.compile(JSON.stringify(input)));
const errors = (out.errors || []).filter((e) => e.severity === "error");
if (errors.length) {
  for (const e of errors) console.error(e.formattedMessage || e.message);
  process.exit(1);
}
for (const w of (out.errors || []).filter((e) => e.severity === "warning")) {
  console.warn("warn:", w.formattedMessage);
}

const unit = out.contracts["WarCoffer.sol"]["WarCoffer"];
if (!unit) { console.error("no contract output"); process.exit(1); }
const artifact = {
  contract: "WarCoffer",
  compiler: solc.version(),
  abi: unit.abi,
  bytecode: "0x" + unit.evm.bytecode.object,
};
fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(outPath, JSON.stringify(artifact, null, 2));
console.log("compiled with solc", solc.version());
console.log("abi entries:", artifact.abi.length, "| bytecode bytes:", (artifact.bytecode.length - 2) / 2);
console.log("artifact:", outPath);
