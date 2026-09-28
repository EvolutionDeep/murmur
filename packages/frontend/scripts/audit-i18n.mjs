/**
 * i18n seven-language symmetry audit.
 *
 * Imports the UI dictionary (i18n-ui.js) and the chronicle dictionary (i18n-chron.js), then checks
 * that every language carries exactly the same key set as English (the fallback). Any missing or
 * extra key is an asymmetry. Exits 0 when asym=0, 1 otherwise.
 *
 * Run from the repo root:  node packages/frontend/scripts/audit-i18n.mjs
 */
import { en, zh, fr, es, ja, ko, ar } from "../public/i18n-ui.js";
import { CHRON_TPL } from "../public/i18n-chron.js";

const LANGS = { en, zh, fr, es, ja, ko, ar };
const NAMES = Object.keys(LANGS);

/** Collect the flat key set of a dictionary object. */
function keysOf(dict) {
  return new Set(Object.keys(dict ?? {}));
}

let asym = 0;
const enKeys = keysOf(en);

// ---- UI dictionary symmetry ----
for (const lang of NAMES) {
  if (lang === "en") continue;
  const lk = keysOf(LANGS[lang]);
  const missing = [...enKeys].filter((k) => !lk.has(k));
  const extra = [...lk].filter((k) => !enKeys.has(k));
  if (missing.length || extra.length) {
    asym += missing.length + extra.length;
    console.log(`[i18n-ui] ${lang}: missing=${missing.length} extra=${extra.length}`);
    if (missing.length) console.log(`  missing: ${missing.slice(0, 8).join(", ")}${missing.length > 8 ? " …" : ""}`);
    if (extra.length) console.log(`  extra:   ${extra.slice(0, 8).join(", ")}${extra.length > 8 ? " …" : ""}`);
  }
}

// ---- Chronicle template symmetry ----
// CHRON_TPL is { zh: {...}, fr: {...}, ... } — English templates live inline in shared.js,
// so we compare the six non-English languages against each other (all must carry identical keys).
const chronLangs = Object.keys(CHRON_TPL ?? {});
const chronRef = chronLangs.length ? keysOf(CHRON_TPL[chronLangs[0]]) : new Set();
for (const lang of chronLangs.slice(1)) {
  const lk = keysOf(CHRON_TPL[lang]);
  const missing = [...chronRef].filter((k) => !lk.has(k));
  const extra = [...lk].filter((k) => !chronRef.has(k));
  if (missing.length || extra.length) {
    asym += missing.length + extra.length;
    console.log(`[i18n-chron] ${lang} vs ${chronLangs[0]}: missing=${missing.length} extra=${extra.length}`);
    if (missing.length) console.log(`  missing: ${missing.slice(0, 8).join(", ")}${missing.length > 8 ? " \u2026" : ""}`);
    if (extra.length) console.log(`  extra:   ${extra.slice(0, 8).join(", ")}${extra.length > 8 ? " \u2026" : ""}`);
  }
}

console.log(`\ni18n symmetry audit: asym=${asym}`);
if (asym > 0) {
  console.error("FAIL: language dictionaries are asymmetric");
  process.exit(1);
}
console.log("PASS: all seven languages carry identical key sets");
