// gen-codecommit.mjs — PoCA code-commitment codegen.
//
// Runs immediately BEFORE `wrangler deploy` (wired into the root package.json `deploy:worker` script).
// It derives a single sha256 "code commitment" that pins EXACTLY which source tree + which git commit +
// which grey-release knob DEFAULTS a deployed Worker was built from, and writes it to
// packages/trader-worker/src/codeCommitment.ts so the runtime can fold it into every PoCA cron digest.
//
// The commitment answers the PoCA question "is the program that has been acting for the last 180 days the
// SAME declared program, or was its code silently swapped?": a deploy that changes any hashed source file
// rotates CODE_COMMITMENT, which forces the worker to seal the running epoch and open a new one (admin
// kind=7 CODE_CHANGE), so a code swap is a permanent, on-chain-visible break in the agency chain.
//
// Inputs (all deterministic, no clock, no randomness):
//   1. git HEAD            — `git rev-parse HEAD`, or the literal "unknown" when git is unavailable.
//   2. src tree hash       — sha256 over every file under packages/trader-worker/src (sorted by relative
//                            path), each contributing sha256(relPath + "\0" + bytes); codeCommitment.ts
//                            itself is EXCLUDED so regenerating it never feeds back into the next hash.
//   3. knob defaults        — the CODE DEFAULTS of the grey-release switches (the values that ship when no
//                            env var overrides them). Hard-listed to mirror config.ts; a change here is a
//                            behavioural-identity change and MUST rotate the commitment.
//
// This script is pure Node (no TS, no workspace deps) so it runs in a bare `node` step with zero install.

import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync, statSync, writeFileSync, mkdirSync } from "node:fs";
import { join, relative, dirname, sep } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");
const SRC_DIR = join(ROOT, "packages", "trader-worker", "src");
const OUT_FILE = join(SRC_DIR, "codeCommitment.ts");
const SELF_NAME = "codeCommitment.ts";

/**
 * The CODE DEFAULTS of the grey-release switches, mirroring the `?? "…"` fallbacks in config.ts. These are
 * the values a deploy ships with when the operator sets NOTHING — i.e. the program's declared default
 * posture. Keep this list in sync with config.ts; adding/removing/flippping a default here rotates the
 * commitment exactly as a source edit would (which is the point: the default posture IS part of identity).
 */
const KNOB_DEFAULTS = {
  FLYWIRE_TOPOLOGY: "false",
  NEUROMOD_GATING: "false",
  ECONOMY_ENABLED: "true",
  ECONOMY_REAL_SPEND: "true",
  INSTITUTIONS_ENABLED: "true",
  DYNASTY_ENABLED: "true",
  CULTURE_ENABLED: "true",
  LAW_ENABLED: "true",
  PREDICT_ENABLED: "true",
  SIGNAL_ENABLED: "true",
  ARENA_ENABLED: "false",
  WAR_ENABLED: "false",
  REFORM_ENABLED: "false",
  TEMPLE_ENABLED: "true",
  LAND_ENABLED: "true",
  BOURSE_ENABLED: "false",
  TOKEN_STIMULUS_ENABLED: "false",
  SOCIAL_STIMULUS_ENABLED: "false",
  CONFLICT_ENABLED: "false",
  TERRITORY_ENABLED: "false",
  POET_ENABLED: "false",
};

/** sha256 of a string, as 64 lowercase hex chars. */
function sha256(input) {
  return createHash("sha256").update(input).digest("hex");
}

/** Deterministic JSON: object keys sorted recursively (arrays keep order). Mirrors provenance.ts canonical(). */
function canonical(value) {
  const walk = (v) => {
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === "object") {
      const out = {};
      for (const k of Object.keys(v).sort()) out[k] = walk(v[k]);
      return out;
    }
    return v;
  };
  return JSON.stringify(walk(value));
}

/** Read git HEAD; "unknown" when git is absent / not a repo / errors (never throws — codegen must not block deploy). */
function gitHead() {
  try {
    const out = execFileSync("git", ["rev-parse", "HEAD"], { cwd: ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
    const head = out.trim();
    return /^[0-9a-f]{40}$/i.test(head) ? head : "unknown";
  } catch {
    return "unknown";
  }
}

/** Recursively collect every regular file under `dir`, as POSIX-style relative paths, sorted. */
function walk(dir, base = dir, acc = []) {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    const st = statSync(full);
    if (st.isDirectory()) {
      walk(full, base, acc);
    } else if (st.isFile()) {
      const rel = relative(base, full).split(sep).join("/");
      acc.push({ rel, full });
    }
  }
  return acc;
}

/**
 * The src-tree hash: sha256 over the sorted list of per-file sha256(relPath + "\0" + bytes), excluding
 * codeCommitment.ts itself. Sorting by relative path makes it independent of readdir order; hashing the
 * relPath together with the bytes means a rename rotates the commitment even if the content is identical.
 */
function srcTreeHash() {
  const files = walk(SRC_DIR).filter((f) => f.rel !== SELF_NAME).sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0));
  const perFile = files.map((f) => sha256(f.rel + "\0" + readFileSync(f.full, "utf8")));
  return { treeHash: sha256(perFile.join("")), fileCount: files.length };
}

function main() {
  const gitCommit = gitHead();
  const { treeHash, fileCount } = srcTreeHash();
  const knobsCanonical = canonical(KNOB_DEFAULTS);
  // The commitment binds all three inputs in a fixed order so it is reproducible byte-for-byte anywhere.
  const codeCommitment = sha256(`git:${gitCommit}\ntree:${treeHash}\nknobs:${knobsCanonical}`);

  const inputs = { gitCommit, treeHash, fileCount, knobCount: Object.keys(KNOB_DEFAULTS).length };
  const banner = [
    "// codeCommitment.ts — GENERATED by scripts/gen-codecommit.mjs. DO NOT EDIT BY HAND.",
    "//",
    "// The PoCA code identity: a single sha256 pinning the exact git commit + src tree + grey-release knob",
    "// DEFAULTS this Worker was built from. Regenerated on every `npm run deploy:worker` (the codegen step",
    "// runs before wrangler). A change to ANY hashed source file rotates CODE_COMMITMENT, which forces the",
    "// running PoCA epoch to seal and a new one to open (admin kind=7 CODE_CHANGE) — so a silent code swap",
    "// is a permanent, on-chain-visible break in the continuous-agency chain. Excluded from its own tree hash.",
  ].join("\n");

  const body = [
    banner,
    "",
    "/** The git commit this build was generated from (\u201cunknown\u201d when git was unavailable at codegen time). */",
    `export const GIT_COMMIT = ${JSON.stringify(gitCommit)};`,
    "",
    "/** sha256(git HEAD + src tree hash + canonical knob defaults) — the PoCA code identity (64 lowercase hex). */",
    `export const CODE_COMMITMENT = ${JSON.stringify(codeCommitment)};`,
    "",
    "/** A non-secret summary of what fed CODE_COMMITMENT, for the /poca read-out + offline recompute. */",
    `export const CODE_COMMITMENT_INPUTS = ${JSON.stringify(inputs, null, 2)} as const;`,
    "",
  ].join("\n");

  mkdirSync(dirname(OUT_FILE), { recursive: true });
  writeFileSync(OUT_FILE, body, "utf8");
  console.log(`[gen-codecommit] wrote ${relative(ROOT, OUT_FILE).split(sep).join("/")}`);
  console.log(`[gen-codecommit]   gitCommit=${gitCommit} files=${fileCount}`);
  console.log(`[gen-codecommit]   CODE_COMMITMENT=${codeCommitment}`);
}

main();
