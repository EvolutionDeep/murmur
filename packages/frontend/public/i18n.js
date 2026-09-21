// ============================================================================
// murmur · i18n kernel
// ----------------------------------------------------------------------------
// A tiny, dependency-free localisation core for the SPA. It is a pure READ-OUT
// layer: it never touches the simulation, the economy, the genome or the
// chronicle proof. The English chronicle sentences stay byte-frozen and are
// still re-derived and verified against canonical English; we only render a
// *display* translation from each entry's own tokens (see ct()).
//
// Public surface consumed by app.js:
//   SUPPORTED, RTL, ENDONYMS, getLang(), setLang(code), t(key, params),
//   ct(kind, tokens, lang), applyDom(root), gl(glossGroup, word)
// ============================================================================

import { en, zh, fr, es, ja, ko, ar } from "./i18n-ui.js?v=54";
import { CHRON_TPL } from "./i18n-chron.js?v=54";

export const SUPPORTED = ["en", "zh", "fr", "es", "ja", "ko", "ar"];
export const RTL = new Set(["ar"]);
// endonyms — each language's own name for itself, used in the switcher
export const ENDONYMS = {
  en: "English", zh: "中文", fr: "Français", es: "Español",
  ja: "日本語", ko: "한국어", ar: "العربية",
};

const I18N = { en, zh, fr, es, ja, ko, ar };
const STORE_KEY = "murmur:lang";

// ---- term glossaries for interpolated tokens (goods / roles / regimes / FAPs / causes)
// These feed the canvas, HUD labels, and the chronicle's inline word tokens so a
// sentence like "the market has turned {regime}" reads naturally in-language.
export const GLOSS = {
  goods: {
    en: { signal: "signal", momentum: "momentum", attestation: "attestation", prediction: "prediction" },
    zh: { signal: "信号", momentum: "动量", attestation: "认证", prediction: "预测" },
    fr: { signal: "signal", momentum: "élan", attestation: "attestation", prediction: "prédiction" },
    es: { signal: "señal", momentum: "momento", attestation: "atestación", prediction: "predicción" },
    ja: { signal: "シグナル", momentum: "モメンタム", attestation: "認証", prediction: "予測" },
    ko: { signal: "신호", momentum: "모멘텀", attestation: "인증", prediction: "예측" },
    ar: { signal: "إشارة", momentum: "زخم", attestation: "إثبات", prediction: "تنبؤ" },
  },
  role: {
    en: { forager: "forager", mooder: "mooder", trader: "trader", brooder: "brooder" },
    zh: { forager: "觅食者", mooder: "调情者", trader: "交易者", brooder: "育雏者" },
    fr: { forager: "fourrageur", mooder: "humeur", trader: "négociant", brooder: "couveur" },
    es: { forager: "recolector", mooder: "anímico", trader: "operador", brooder: "incubador" },
    ja: { forager: "採餌者", mooder: "ムード", trader: "トレーダー", brooder: "育雛" },
    ko: { forager: "채집자", mooder: "분위기", trader: "거래자", brooder: "부화자" },
    ar: { forager: "التقاط", mooder: "مزاج", trader: "متداول", brooder: "احتضان" },
  },
  regime: {
    en: { cold: "cold", calm: "calm", hot: "hot", COLD: "cold", CALM: "calm", HOT: "hot" },
    zh: { cold: "寒冷", calm: "平静", hot: "炽热", COLD: "寒冷", CALM: "平静", HOT: "炽热" },
    fr: { cold: "froid", calm: "calme", hot: "chaud", COLD: "froid", CALM: "calme", HOT: "chaud" },
    es: { cold: "frío", calm: "sereno", hot: "ardiente", COLD: "frío", CALM: "sereno", HOT: "ardiente" },
    ja: { cold: "寒冷", calm: "凪", hot: "灼熱", COLD: "寒冷", CALM: "凪", HOT: "灼熱" },
    ko: { cold: "추위", calm: "잔잔", hot: "폭염", COLD: "추위", CALM: "잔잔", HOT: "폭염" },
    ar: { cold: "بارد", calm: "هادئ", hot: "حار", COLD: "بارد", CALM: "هادئ", HOT: "حار" },
  },
  // keys are the authoritative Fap union (fly-brain/src/types.ts): FEED|GROOM|FORAGE|HALT|RETREAT|COURT|FLIGHT|HUDDLE|REST
  fap: {
    en: { FEED: "feeding", GROOM: "grooming", FORAGE: "foraging", HALT: "halting", RETREAT: "retreating", COURT: "courting", FLIGHT: "taking flight", HUDDLE: "huddling", REST: "resting" },
    zh: { FEED: "取食", GROOM: "梳理", FORAGE: "觅食", HALT: "停驻", RETREAT: "撤退", COURT: "求偶", FLIGHT: "振翅飞逃", HUDDLE: "聚拢", REST: "休憩" },
    fr: { FEED: "se nourrir", GROOM: "toiletter", FORAGE: "fourrager", HALT: "marquer l'arrêt", RETREAT: "battre en retraite", COURT: "courtiser", FLIGHT: "prendre son essor", HUDDLE: "se blottir", REST: "se reposer" },
    es: { FEED: "alimentarse", GROOM: "acicalarse", FORAGE: "rebuscar", HALT: "detenerse", RETREAT: "retirarse", COURT: "cortejar", FLIGHT: "echar a volar", HUDDLE: "apiñarse", REST: "descansar" },
    ja: { FEED: "摂食", GROOM: "清潔", FORAGE: "採餌探索", HALT: "停止", RETREAT: "退避", COURT: "求愛", FLIGHT: "飛翔", HUDDLE: "密集", REST: "休息" },
    ko: { FEED: "섭이", GROOM: "손질", FORAGE: "먹이 탐색", HALT: "정지", RETREAT: "후퇴", COURT: "구애", FLIGHT: "비행", HUDDLE: "무리짓기", REST: "휴식" },
    ar: { FEED: "التغذية", GROOM: "التنظف", FORAGE: "الالتقاط", HALT: "التوقف", RETREAT: "التراجع", COURT: "المغازلة", FLIGHT: "الإقلاع", HUDDLE: "التجمّع", REST: "الراحة" },
  },
  cause: {
    en: { plague: "plague", age: "age", predation: "predation", starvation: "starvation", cold: "cold" },
    zh: { plague: "瘟疫", age: "年老", predation: "被捕食", starvation: "饥饿", cold: "寒冷" },
    fr: { plague: "peste", age: "vieillesse", predation: "prédation", starvation: "famine", cold: "froid" },
    es: { plague: "peste", age: "vejez", predation: "depredación", starvation: "hambruna", cold: "frío" },
    ja: { plague: "疫病", age: "老い", predation: "捕食", starvation: "飢餓", cold: "寒さ" },
    ko: { plague: "역병", age: "노령", predation: "포식", starvation: "기아", cold: "추위" },
    ar: { plague: "طاعون", age: "هرم", predation: "افتراس", starvation: "مجاعة", cold: "برد" },
  },
};

let LANG = null;   // null until boot detection; t()/gl() fall back to English while null

/** Detect the initial language: persisted choice > browser locale > English. */
export function getLang() {
  try {
    const saved = localStorage.getItem(STORE_KEY);
    if (saved && I18N[saved]) return saved;
    const nav = (navigator.language || "en").slice(0, 2).toLowerCase();
    if (I18N[nav]) return nav;
  } catch { /* localStorage may be blocked */ }
  return "en";
}

/** Fill {x} placeholders (and gloss any inline word tokens) in a UI string. */
export function t(key, params) {
  const dict = I18N[LANG] || en;
  let s = dict[key];
  if (s == null) s = en[key];
  if (s == null) s = key;
  if (params) s = s.replace(/\{(\w+)(?:~(\w+))?\}/g, (_m, k, fmt) => fillToken(k, fmt, params[k]));
  return s;
}

/** Translate one glossary word (for labels built outside t()). Falls back to the word. */
export function gl(group, word) {
  if (word == null) return word;
  const g = GLOSS[group];
  if (!g) return String(word);
  const low = String(word).toLowerCase();
  return (g[LANG] && (g[LANG][word] ?? g[LANG][low])) ?? (g.en[word] ?? g.en[low]) ?? String(word);
}

// Interpolation helper shared by t() and ct(): format + optional glossing.
function fillToken(k, fmt, value) {
  if (value == null) return "";
  if (fmt === "roman") return romanNum(Number(value));
  let str = String(value);
  // gloss a known word token (goods/role/regime/fap/cause) BEFORE applying case, so a
  // template like "the market has turned {regime~lower}" reads in-language, not English.
  for (const group of ["regime", "goods", "role", "fap", "cause"]) {
    const g = GLOSS[group][LANG];
    const hit = g && (g[str] ?? g[str.toLowerCase()]);
    if (hit) { str = hit; break; }
  }
  if (fmt === "lower") return str.toLowerCase();
  return str;
}

function romanNum(n) {
  if (!n || n <= 0) return String(n ?? "");
  const m = [[1000,"M"],[900,"CM"],[500,"D"],[400,"CD"],[100,"C"],[90,"XC"],[50,"L"],[40,"XL"],[10,"X"],[9,"IX"],[5,"V"],[4,"IV"],[1,"I"]];
  let out = "", rest = n; for (const [v, s] of m) while (rest >= v) { out += s; rest -= v; } return out;
}

/**
 * Localised chronicle *display* line — rebuilt from the SAME tokens the server
 * used, into the active language's template. This never feeds verification:
 * verifyChron() re-derives against the byte-frozen English CHRON_ block. If we
 * have no localised template for the kind, return "" so the caller falls back
 * to the canonical English sentence (never a blank).
 */
export function ct(kind, tokens, lang) {
  const L = lang || LANG;
  const tpl = CHRON_TPL[L] && CHRON_TPL[L][kind];
  if (!tpl) return "";
  return tpl.replace(/\{(\w+)(?:~(\w+))?\}/g, (_m, k, fmt) => {
    if (fmt === "kth") return String(Math.round(Number((tokens || {}).settlements ?? 0) / 1000)); // ordinal thousands → bare number
    return fillToken(k, fmt, (tokens || {})[k]);
  });
}

/** Walk a subtree and apply dictionary text to any [data-i18n*] node. */
export function applyDom(root) {
  const scope = root || document;
  for (const el of scope.querySelectorAll("[data-i18n]")) el.textContent = t(el.getAttribute("data-i18n"));
  for (const el of scope.querySelectorAll("[data-i18n-title]")) el.setAttribute("title", t(el.getAttribute("data-i18n-title")));
  for (const el of scope.querySelectorAll("[data-i18n-aria]")) el.setAttribute("aria-label", t(el.getAttribute("data-i18n-aria")));
  for (const el of scope.querySelectorAll("[data-i18n-ph]")) el.setAttribute("placeholder", t(el.getAttribute("data-i18n-ph")));
  // document metadata for a worldwide audience
  document.title = t("meta.title");
  const md = document.querySelector('meta[name="description"]'); if (md) md.setAttribute("content", t("meta.desc"));
}

/**
 * Switch the active language: set <html lang/dir>, persist, re-translate the
 * static DOM + metadata, then invoke the app's live re-render hook. The canvas
 * layers read t()/gl() every frame, so they update on the next animation tick.
 */
export function setLang(code, opts) {
  if (!I18N[code]) code = "en";
  LANG = code;
  const html = document.documentElement;
  html.lang = code;
  html.dir = RTL.has(code) ? "rtl" : "ltr";
  try { localStorage.setItem(STORE_KEY, code); } catch { /* ignore */ }
  applyDom();
  if (!opts || opts.rerender !== false) {
    if (typeof window.__onLangChange === "function") { try { window.__onLangChange(code); } catch { /* never break the scene on a render error */ } }
  }
}

export function currentLang() { return LANG; }
