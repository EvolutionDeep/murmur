// gen-codecommit.mjs — PoCA code-commitment codegen.
//
// Runs immediately BEFORE `wrangler deploy` (wired into the root package.json `deploy:worker` script).
// It derives a single sha256 "code commitment" that pins EXACTLY which source tree + which FlyWire
// artifact + which grey-release knob DEFAULTS a deployed Worker was built from, and writes it to
// packages/trader-worker/src/codeCommitment.ts so the runtime can fold it into every PoCA cron digest.
//
// The commitment answers the PoCA question "is the program that has been acting for the last 180 days the
// SAME declared program, or was its code silently swapped?": a deploy that changes any hashed source file
// rotates CODE_COMMITMENT, which forces the worker to seal the running epoch and open a new one (admin
// kind=7 CODE_CHANGE), so a code swap is a permanent, on-chain-visible break in the agency chain.
//
// Inputs (all deterministic, no clock, no randomness):
//   1. src tree hash       — sha256 over every file under packages/trader-worker/src AND
//                            packages/fly-brain/src (sorted by repo-relative path), each contributing
//                            sha256(relPath + "\0" + bytes). Files are read as raw BYTES (Buffer, no
//                            encoding) so the hash is identical across platforms regardless of line-ending
//                            or BOM handling. codeCommitment.ts itself is EXCLUDED so regenerating it never
//                            feeds back into the next hash. (*.test.ts files are INCLUDED, matching the
//                            pre-existing scope semantics.)
//   2. knob defaults        — the CODE DEFAULTS of the grey-release switches (the values that ship when no
//                            env var overrides them). Hard-listed to mirror config.ts; a change here is a
//                            behavioural-identity change and MUST rotate the commitment.
//   3. artifact hash       — sha256 of the FlyWire connectome artifact
//                            (packages/fly-brain/src/connectome-data/fafb783-mb-cx.bin.gz.b64), read as raw
//                            bytes. The behavioural substrate is part of the program's identity.
//
// NOTE: git HEAD is NOT an input to CODE_COMMITMENT (Review #24). Mixing git HEAD in caused a pure
// documentation commit (or ANY commit that touches no hashed source) to rotate the commitment and fire a
// spurious kind=7 epoch. GIT_COMMIT is still exported separately for the /poca read-out, but it is NOT
// folded into CODE_COMMITMENT and is NOT part of CODE_COMMITMENT_INPUTS.
//
// This script is pure Node (no TS, no workspace deps) so it runs in a bare `node` step with zero install.

import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync, statSync, writeFileSync, mkdirSync } from "node:fs";
import { join, relative, dirname, sep } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");
// Review #7: the commitment now covers BOTH the worker source AND the fly-brain source it links against.
const SRC_DIRS = [
  join(ROOT, "packages", "trader-worker", "src"),
  join(ROOT, "packages", "fly-brain", "src"),
];
const SRC_DIR = join(ROOT, "packages", "trader-worker", "src");
const OUT_FILE = join(SRC_DIR, "codeCommitment.ts");
const SELF_NAME = "codeCommitment.ts";
// Review #7: the FlyWire connectome artifact is hashed as a separate, first-class INPUTS field.
const ARTIFACT_FILE = join(ROOT, "packages", "fly-brain", "src", "connectome-data", "fafb783-mb-cx.bin.gz.b64");

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

/** sha256 of a string OR Buffer, as 64 lowercase hex chars. Review #23: hashing raw bytes (never a
 *  decoded string) keeps the digest byte-identical across platforms / encodings. */
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

/** Recursively collect every regular file under `dir`, as POSIX-style paths relative to ROOT, sorted. */
function walk(dir, acc = []) {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    const st = statSync(full);
    if (st.isDirectory()) {
      walk(full, acc);
    } else if (st.isFile()) {
      // Repo-relative POSIX path so files from different packages never collide and the ordering is global.
      const rel = relative(ROOT, full).split(sep).join("/");
      acc.push({ rel, full });
    }
  }
  return acc;
}

/**
 * The src-tree hash: sha256 over the sorted list of per-file sha256(relPath + "\0" + bytes), covering BOTH
 * packages/trader-worker/src and packages/fly-brain/src, excluding codeCommitment.ts itself.
 *
 * Determinism (Review #23):
 *   - files are read as raw BYTES (readFileSync with no encoding ⇒ Buffer) so line-ending / BOM /
 *     encoding differences never perturb the digest;
 *   - the relPath prefix is hashed together with the bytes, so a rename rotates the commitment even if
 *     the content is identical;
 *   - the list is sorted by an explicit total order on relPath (plain codepoint < / > comparison, NOT
 *     localeCompare — locale-dependent collation would break cross-machine reproducibility). Because
 *     relPaths are unique this is a total order, so the result is independent of readdir / walk order.
 */
function srcTreeHash() {
  const files = [];
  for (const dir of SRC_DIRS) walk(dir, files);
  files.sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0));
  const kept = files.filter((f) => relative(ROOT, f.full).split(sep).join("/") !== `packages/trader-worker/src/${SELF_NAME}`);
  const perFile = kept.map((f) => sha256(Buffer.concat([Buffer.from(f.rel + "\0", "utf8"), readFileSync(f.full)])));
  return { treeHash: sha256(perFile.join("")), fileCount: kept.length };
}

/**
 * sha256 of the FlyWire connectome artifact's raw bytes (Review #7). Missing artifact is a hard failure:
 * the substrate is part of the program's identity, so we must never silently commit without it.
 */
function artifactHash() {
  return sha256(readFileSync(ARTIFACT_FILE));
}

function main() {
  // GIT_COMMIT is still exported for the /poca read-out, but it is deliberately NOT folded into the
  // commitment (Review #24) so a source-neutral commit no longer rotates CODE_COMMITMENT / fires kind=7.
  const gitCommit = gitHead();
  const { treeHash, fileCount } = srcTreeHash();
  const artHash = artifactHash();
  const knobsCanonical = canonical(KNOB_DEFAULTS);
  // The commitment binds the three source-of-truth inputs in a fixed, labeled order so it is reproducible
  // byte-for-byte anywhere. git HEAD is intentionally absent.
  const codeCommitment = sha256(`tree:${treeHash}\nknobs:${knobsCanonical}\nartifact:${artHash}`);

  // INPUTS is a NON-SECRET summary of exactly what fed the hash. gitCommit is NOT listed because it does
  // not contribute to CODE_COMMITMENT (Review #24) — including it would mislead offline recomputation.
  const inputs = { treeHash, fileCount, knobCount: Object.keys(KNOB_DEFAULTS).length, artifactHash: artHash };
  const banner = [
    "// codeCommitment.ts — GENERATED by scripts/gen-codecommit.mjs. DO NOT EDIT BY HAND.",
    "//",
    "// The PoCA code identity: a single sha256 pinning the exact src tree (trader-worker/src + fly-brain/src)",
    "// + FlyWire connectome artifact + grey-release knob DEFAULTS this Worker was built from. Regenerated on",
    "// every deploy (the codegen step runs before wrangler). A change to ANY hashed source file or the artifact",
    "// rotates CODE_COMMITMENT, which forces the running PoCA epoch to seal and a new one to open (admin",
    "// kind=7 CODE_CHANGE) — so a silent code swap is a permanent, on-chain-visible break in the agency chain.",
    "// codeCommitment.ts is excluded from its own tree hash. git HEAD is NOT an input (see GIT_COMMIT below).",
  ].join("\n");

  const body = [
    banner,
    "",
    "/** The git commit this build was generated from (\u201cunknown\u201d when git was unavailable at codegen time).",
    " *  Informational only — NOT folded into CODE_COMMITMENT (a source-neutral commit must not rotate it). */",
    `export const GIT_COMMIT = ${JSON.stringify(gitCommit)};`,
    "",
    "/** sha256(src tree hash + canonical knob defaults + FlyWire artifact hash) — the PoCA code identity (64 lowercase hex). */",
    `export const CODE_COMMITMENT = ${JSON.stringify(codeCommitment)};`,
    "",
    "/** A non-secret summary of what fed CODE_COMMITMENT, for the /poca read-out + offline recompute. */",
    `export const CODE_COMMITMENT_INPUTS = ${JSON.stringify(inputs, null, 2)} as const;`,
    "",
  ].join("\n");

  mkdirSync(dirname(OUT_FILE), { recursive: true });
  writeFileSync(OUT_FILE, body, "utf8");
  console.log(`[gen-codecommit] wrote ${relative(ROOT, OUT_FILE).split(sep).join("/")}`);
  console.log(`[gen-codecommit]   files=${fileCount} gitCommit=${gitCommit} (informational, not hashed)`);
  console.log(`[gen-codecommit]   treeHash=${treeHash}`);
  console.log(`[gen-codecommit]   artifactHash=${artHash}`);
  console.log(`[gen-codecommit]   CODE_COMMITMENT=${codeCommitment}`);
}

main();
