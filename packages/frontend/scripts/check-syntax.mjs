/**
 * Syntax-check every public/*.js with `node --check`.
 * Files are piped via STDIN with --input-type=module (Node ≥ 20 forbids that
 * flag with a file-path argument, but allows it for STDIN input).
 * Exits 0 when all files parse, 1 on the first syntax error.
 *
 * Run from the repo root:  node packages/frontend/scripts/check-syntax.mjs
 */
import { readdirSync, readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const publicDir = join(here, "..", "public");

const files = readdirSync(publicDir).filter((f) => f.endsWith(".js")).sort();
let failed = 0;

for (const f of files) {
  const full = join(publicDir, f);
  try {
    // Pipe file content via STDIN; --input-type=module makes --check parse as ESM.
    execFileSync(process.execPath, ["--check", "--input-type=module"], {
      input: readFileSync(full),
      stdio: ["pipe", "pipe", "pipe"],
    });
    process.stdout.write(`  \u2713 ${f}\n`);
  } catch (e) {
    failed++;
    process.stdout.write(`  \u2717 ${f}\n`);
    process.stderr.write(e.stderr?.toString() || e.message);
  }
}

console.log(`\nnode --check: ${files.length - failed}/${files.length} passed`);
if (failed > 0) {
  console.error(`FAIL: ${failed} file(s) have syntax errors`);
  process.exit(1);
}
console.log("PASS: all public/*.js parse cleanly");
