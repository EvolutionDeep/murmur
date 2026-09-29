#!/usr/bin/env node
/**
 * bump-frontend-version.mjs
 *
 * Stamps a uniform ?v=N cache-buster onto every bare local ESM import in
 * packages/frontend/public, ensuring Cloudflare CDN never serves stale bytes
 * (the custom domain overrides _headers no-cache with max-age=14400).
 *
 * Usage:
 *   node scripts/bump-frontend-version.mjs          # auto-increment from index.html
 *   node scripts/bump-frontend-version.mjs 160      # set explicit version
 *   node scripts/bump-frontend-version.mjs --dry    # preview without writing
 *
 * Convention:
 *   - ALL local module imports (from './x.js') use the SAME global version.
 *   - i18n dictionary modules (i18n.js, i18n-ui.js, i18n-chron.js) retain their
 *     own independent ?v= since they are already protected by no-store in _headers
 *     and change on a different cadence.
 *   - index.html entry (main.js?v=N, styles.css?v=M) is bumped in lockstep.
 *   - The ESM module map keys on the full resolved URL; as long as every importer
 *     of a given module uses the same ?v=N, there is no duplicate instantiation.
 */

import { readFileSync, writeFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '..');
const PUB = join(ROOT, 'packages', 'frontend', 'public');

// ─── Config ───────────────────────────────────────────────────────────────────
// Modules that manage their own ?v= independently (already have no-store in _headers).
const SKIP_MODULES = new Set(['i18n.js', 'i18n-ui.js', 'i18n-chron.js']);

// Files to scan (all .js in public/ except the legacy monolith backup).
const SKIP_FILES = new Set(['app.js']);

// ─── Helpers ──────────────────────────────────────────────────────────────────
function localJsFiles() {
  return readdirSync(PUB)
    .filter(f => f.endsWith('.js') && !SKIP_FILES.has(f))
    .map(f => join(PUB, f));
}

/**
 * Rewrite bare local import specifiers to carry ?v=VERSION.
 * Handles:
 *   - Static: from './mod.js'  /  from "./mod.js"
 *   - Dynamic: import('./mod.js')  /  import("./mod.js")
 * Preserves existing ?v= on SKIP_MODULES (i18n family).
 */
function stampImports(src, version) {
  let changes = 0;

  // Static imports: from './x.js' or from './x.js?v=OLD'
  const staticRe = /(from\s+['"])(\.\/[^'"]+?\.js)(\?v=\d+)?(['"])/g;
  src = src.replace(staticRe, (match, pre, path, existingV, post) => {
    const basename = path.replace('./', '');
    if (SKIP_MODULES.has(basename)) return match; // leave i18n family alone
    const newV = `?v=${version}`;
    if (existingV === newV) return match; // already correct
    changes++;
    return `${pre}${path}${newV}${post}`;
  });

  // Dynamic imports: import('./x.js') or import('./x.js?v=OLD')
  // Negative lookahead (?!\.) excludes JSDoc type annotations like import('./x.js').TypeName
  const dynRe = /(import\(\s*['"])(\.\/[^'"]+?\.js)(\?v=\d+)?(['"]\s*\))(?!\.)/g;
  src = src.replace(dynRe, (match, pre, path, existingV, post) => {
    const basename = path.replace('./', '');
    if (SKIP_MODULES.has(basename)) return match;
    const newV = `?v=${version}`;
    if (existingV === newV) return match;
    changes++;
    return `${pre}${path}${newV}${post}`;
  });

  return { src, changes };
}

/**
 * Bump the entry-point versions in index.html:
 *   main.js?v=N  →  main.js?v=VERSION
 *   styles.css?v=M  →  styles.css?v=VERSION  (unified for simplicity)
 */
function stampIndexHtml(src, version) {
  let changes = 0;
  src = src.replace(/(main\.js)\?v=(\d+)/g, (match, name, oldVer) => {
    if (oldVer === String(version)) return match;
    changes++; return `${name}?v=${version}`;
  });
  src = src.replace(/(styles\.css)\?v=(\d+)/g, (match, name, oldVer) => {
    if (oldVer === String(version)) return match;
    changes++; return `${name}?v=${version}`;
  });
  return { src, changes };
}

/** Read the current main.js version from index.html */
function currentVersion() {
  const html = readFileSync(join(PUB, 'index.html'), 'utf8');
  const m = html.match(/main\.js\?v=(\d+)/);
  return m ? parseInt(m[1], 10) : 0;
}

// ─── Main ─────────────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
const dryRun = args.includes('--dry') || args.includes('-n');
const explicitVer = args.find(a => /^\d+$/.test(a));

const curVer = currentVersion();
const newVer = explicitVer ? parseInt(explicitVer, 10) : curVer + 1;

console.log(`Current version: ${curVer}`);
console.log(`Target version:  ${newVer}`);
console.log(`Mode: ${dryRun ? 'DRY RUN' : 'WRITE'}`);
console.log('');

let totalChanges = 0;

// 1. Stamp all .js files
for (const file of localJsFiles()) {
  const orig = readFileSync(file, 'utf8');
  const { src, changes } = stampImports(orig, newVer);
  if (changes > 0) {
    const name = file.replace(PUB + '\\', '').replace(PUB + '/', '');
    console.log(`  ${name}: ${changes} import(s) stamped`);
    totalChanges += changes;
    if (!dryRun) writeFileSync(file, src, 'utf8');
  }
}

// 2. Stamp index.html
const indexPath = join(PUB, 'index.html');
const origHtml = readFileSync(indexPath, 'utf8');
const { src: newHtml, changes: htmlChanges } = stampIndexHtml(origHtml, newVer);
if (htmlChanges > 0) {
  console.log(`  index.html: ${htmlChanges} entry-point(s) bumped`);
  totalChanges += htmlChanges;
  if (!dryRun) writeFileSync(indexPath, newHtml, 'utf8');
}

console.log('');
console.log(`Total: ${totalChanges} change(s) across ${localJsFiles().length + 1} files.`);
if (dryRun) console.log('(dry run — no files written)');
else console.log(`✓ All local imports now carry ?v=${newVer}`);
