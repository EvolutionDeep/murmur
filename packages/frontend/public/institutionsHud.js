// institutionsHud.js — Phase 7 emergent-institutions HUD drawer (task 88, capability ⑤).
//
// READ-ONLY consumer of the /economy read-out's three youngest membrane keys:
//   norms       — NormsSignals   (㉛ norms.ts:      minted/spread/mutated/died + the standing roster)
//   conventions — ConventionsSignals (㉜ conventions.ts: crystallized/spread/inherited/breached/died/absorbed)
//   rules       — RulesSignals   (㉝ rules.ts:      minted/adopted/revoked/died + buyMod/cpMod modifiers)
//
// All three keys are ABSENT from /economy while their membrane switch is off, so every
// section degrades to the honest "dormant" hint — never to an error. The condition and
// label strings inside each row are the worker's own human-readable projections
// (NormView.norm / ConvView.conv / RuleView.rule); this module only frames them.
//
// Lifecycle mirrors the PoCA drawer: open/close/toggle + render (fetch → cache → paint).
// paintInstitutions() rebuilds from the cache alone, so rerenderAll() calls it on a
// language switch with no refetch. No LLM. No writes to the worker.
import { state, $ } from './shared.js?v=164';
import { t as T, gl } from './i18n.js?v=115';
import { getJSON } from './polling.js?v=164';

// ═══════════════════════════════════════════════════════════════════════════════
// LIFECYCLE
// ═══════════════════════════════════════════════════════════════════════════════

export function openInst() {
  state.instOpen = true;
  // mutual exclusion — close the sibling read-out drawers (main.js bridges these)
  if (state.chronOpen) window.__closeChron?.();
  if (state.canaryOpen) window.__closeCanary?.();
  if (state.templeOpen) window.__closeTemple?.();
  if (state.pocaOpen) window.__closePoca?.();
  if (state.landOpen) window.__closeLand?.();
  if (state.walletsOpen) window.__closeWallets?.();
  if (state.evoOpen) window.__closeEvo?.();
  const d = $("inst-drawer"); if (!d) return;
  d.hidden = false;
  document.body.classList.add("inst-open");
  requestAnimationFrame(() => d.classList.add("open"));
  renderInstitutions();
}

export function closeInst() {
  state.instOpen = false;
  document.body.classList.remove("inst-open");
  const d = $("inst-drawer"); if (!d) return;
  d.classList.remove("open");
  setTimeout(() => { if (!state.instOpen) d.hidden = true; }, 420);
}

export function toggleInst() { if (state.instOpen) closeInst(); else openInst(); }

// ═══════════════════════════════════════════════════════════════════════════════
// DATA LAYER
// ═══════════════════════════════════════════════════════════════════════════════

let _instTab = "norms";   // active membrane sub-tab

export async function renderInstitutions() {
  const body = $("inst-body"); if (!body) return;
  state.instLoading = true;
  paintInstitutions();
  const econ = await getJSON("/economy", 10000).catch(() => null);
  // switch-off ⇒ key absent ⇒ null ⇒ the section shows the dormant hint
  state.econNorms = econ?.norms ?? null;
  state.econConventions = econ?.conventions ?? null;
  state.econRules = econ?.rules ?? null;
  state.instLoading = false;
  paintInstitutions();
}

/** Repaint from cache — no refetch (language switch / tab switch). */
export function paintInstitutions() {
  const body = $("inst-body"); if (!body) return;
  if (state.instLoading) { body.innerHTML = `<p class="evo-loading">${T("inst.loading")}</p>`; return; }
  const tabs = [
    { id: "norms", present: !!state.econNorms },
    { id: "conventions", present: !!state.econConventions },
    { id: "rules", present: !!state.econRules },
  ];
  let html = `<nav class="evo-tabs" role="tablist">`;
  for (const tb of tabs) {
    const on = tb.id === _instTab ? " is-on" : "";
    html += `<button type="button" role="tab" class="evo-tab${on}" data-itab="${tb.id}" aria-selected="${tb.id === _instTab}">${T("inst.tab." + tb.id)}${tb.present ? "" : " ·"}</button>`;
  }
  html += `</nav><div class="evo-panel">`;
  switch (_instTab) {
    case "norms": html += paintNorms(state.econNorms); break;
    case "conventions": html += paintConventions(state.econConventions); break;
    case "rules": html += paintRules(state.econRules); break;
  }
  html += `</div>`;
  body.innerHTML = html;
  body.querySelectorAll("[data-itab]").forEach((btn) => {
    btn.addEventListener("click", () => { _instTab = btn.dataset.itab; paintInstitutions(); });
  });
}

// ── shared frame helpers ───────────────────────────────────────────────────────

/** The strength bar: a 0..1 membrane strength as a filled vellum gauge (--pct drives the fill). */
function strengthBar(s) {
  const pct = Math.round(clamp01(Number(s) || 0) * 100);
  return `<span class="inst-str" title="${pct}%"><i style="--pct:${pct}%"></i><b>${pct}%</b></span>`;
}
function clamp01(v) { return v < 0 ? 0 : v > 1 ? 1 : v; }

/** One lifecycle edge chip (the latest cron's event, null ⇒ dimmed "none"). */
function edgeChip(label, ev, fmt) {
  if (!ev) return `<span class="inst-edge is-quiet"><b>${label}</b>—</span>`;
  return `<span class="inst-edge"><b>${label}</b>${fmt(ev)}</span>`;
}

/** The lifecycle counters row + the standing aggregate gauges every membrane reports. */
function countersRow(pairs) {
  return `<div class="inst-counts">` + pairs.map(([k, v]) => `<span class="inst-count"><b>${v}</b>${k}</span>`).join("") + `</div>`;
}

/** A dormant membrane (switch off ⇒ key absent) never errors — it says so honestly. */
function dormant(kind) {
  return `<p class="evo-empty">${T("inst.dormant", { kind: T("inst.tab." + kind) })}</p>`;
}

// ═══════════════════════════════════════════════════════════════════════════════
// ㉛ NORMS — condition → stimulus gain, spread by compliance, drifted by mutation
// ═══════════════════════════════════════════════════════════════════════════════

function paintNorms(n) {
  if (!n) return dormant("norms");
  let html = countersRow([
    [T("inst.count.minted"), n.counts?.minted ?? 0],
    [T("inst.count.spread"), n.counts?.spread ?? 0],
    [T("inst.count.mutated"), n.counts?.mutated ?? 0],
    [T("inst.count.died"), n.counts?.died ?? 0],
  ]);
  html += `<div class="inst-agg">`;
  html += `<span>${T("inst.compliance")}: <b>${((n.compliance ?? 0) * 100).toFixed(0)}%</b></span>`;
  html += `<span>${T("inst.lineageDepth")}: <b>${n.lineageDepth ?? 0}</b></span>`;
  html += `<span>${T("inst.mutationRate")}: <b>${((n.mutationRate ?? 0) * 100).toFixed(1)}%</b></span>`;
  html += `</div>`;
  // this cron's lifecycle edges (minted → spread → mutated → died)
  html += `<div class="inst-edges">`;
  html += edgeChip(T("inst.life.minted"), n.minted, (e) => `${e.norm} · ${e.members} ${T("inst.members")} · ${((e.strength ?? 0) * 100).toFixed(0)}%`);
  html += edgeChip(T("inst.life.spread"), n.spread, (e) => `${e.norm} · ${e.adherents} ${T("inst.adherents")}`);
  html += edgeChip(T("inst.life.mutated"), n.mutated, (e) => `${e.norm} · d${e.depth} ← #${e.parent}`);
  html += edgeChip(T("inst.life.died"), n.died, (e) => `${e.norm} · ${e.lived} ${T("inst.ticks")}`);
  html += `</div>`;
  // the standing roster: condition text, strength, depth, adopters, lineage
  const rows = Array.isArray(n.norms) ? n.norms : [];
  if (rows.length === 0) return html + `<p class="evo-empty">${T("inst.noneActive")}</p>`;
  html += `<table class="evo-table inst-table"><thead><tr><th>${T("inst.condition")}</th><th>${T("inst.strength")}</th><th>${T("inst.depth")}</th><th>${T("inst.adherents")}</th><th>${T("inst.mutations")}</th><th>${T("inst.parent")}</th></tr></thead><tbody>`;
  for (const r of rows.slice(0, 40)) {
    html += `<tr><td class="inst-cond" title="${T("inst.id")}: ${r.id}">${esc(r.norm)}</td><td>${strengthBar(r.strength)}</td><td>${r.depth ?? 0}</td><td>${r.adherents ?? 0}</td><td>${r.mutations ?? 0}</td><td>${r.parentId == null ? "—" : "#" + r.parentId}</td></tr>`;
  }
  html += `</tbody></table>`;
  return html;
}

// ═══════════════════════════════════════════════════════════════════════════════
// ㉜ CONVENTIONS — pair trading customs, honoured or breached, inheritable
// ═══════════════════════════════════════════════════════════════════════════════

function paintConventions(c) {
  if (!c) return dormant("conventions");
  let html = countersRow([
    [T("inst.count.crystallized"), c.counts?.crystallized ?? 0],
    [T("inst.count.spread"), c.counts?.spread ?? 0],
    [T("inst.count.inherited"), c.counts?.inherited ?? 0],
    [T("inst.count.breached"), c.counts?.breached ?? 0],
    [T("inst.count.died"), c.counts?.died ?? 0],
    [T("inst.count.absorbed"), c.counts?.absorbed ?? 0],
  ]);
  html += `<div class="inst-agg">`;
  html += `<span>${T("inst.concordance")}: <b>${((c.concordance ?? 0) * 100).toFixed(0)}%</b></span>`;
  html += `<span>${T("inst.breachRate")}: <b>${((c.breachRate ?? 0) * 100).toFixed(1)}%</b></span>`;
  html += `<span>${T("inst.lineageDepth")}: <b>${c.lineageDepth ?? 0}</b></span>`;
  html += `</div>`;
  html += `<div class="inst-edges">`;
  html += edgeChip(T("inst.life.crystallized"), c.crystallized, (e) => `${e.conv} · ${gl("goods", e.good)} · f${e.freq}`);
  html += edgeChip(T("inst.life.spread"), c.spread, (e) => `${e.conv} · ${e.pairs} ${T("inst.pairs")}`);
  html += edgeChip(T("inst.life.inherited"), c.inherited, (e) => `${e.conv} · d${e.depth} ← #${e.parent}`);
  html += edgeChip(T("inst.life.breached"), c.breached, (e) => `${e.conv} · −${((e.penalty ?? 0) * 100).toFixed(0)}%`);
  html += edgeChip(T("inst.life.died"), c.died, (e) => `${e.conv} · ${e.lived} ${T("inst.ticks")}`);
  html += `</div>`;
  const rows = Array.isArray(c.conventions) ? c.conventions : [];
  if (rows.length === 0) return html + `<p class="evo-empty">${T("inst.noneActive")}</p>`;
  html += `<table class="evo-table inst-table"><thead><tr><th>${T("inst.convention")}</th><th>${T("inst.good")}</th><th>${T("inst.priceBand")}</th><th>${T("inst.strength")}</th><th>${T("inst.adopters")}</th><th>${T("inst.breaches")}</th><th>${T("inst.depth")}</th></tr></thead><tbody>`;
  for (const r of rows.slice(0, 40)) {
    html += `<tr><td class="inst-cond" title="${T("inst.id")}: ${r.id} · f${r.freq}">${esc(r.conv)}</td><td>${gl("goods", r.good)}</td><td>${(r.priceLo ?? 0).toFixed(2)}–${(r.priceHi ?? 0).toFixed(2)}</td><td>${strengthBar(r.strength)}</td><td>${r.adopters ?? 0}</td><td>${r.breaches ?? 0}</td><td>${r.depth ?? 0}</td></tr>`;
  }
  html += `</tbody></table>`;
  return html;
}

// ═══════════════════════════════════════════════════════════════════════════════
// ㉝ RULES — self-minted bounded modifiers, adopted and revoked by members
// ═══════════════════════════════════════════════════════════════════════════════

function paintRules(r) {
  if (!r) return dormant("rules");
  let html = countersRow([
    [T("inst.count.minted"), r.counts?.minted ?? 0],
    [T("inst.count.adopted"), r.counts?.adopted ?? 0],
    [T("inst.count.revoked"), r.counts?.revoked ?? 0],
    [T("inst.count.died"), r.counts?.died ?? 0],
  ]);
  html += `<div class="inst-agg">`;
  html += `<span>${T("inst.avgModifier")}: <b>×${(r.avgModifier ?? 0).toFixed(3)}</b></span>`;
  html += `<span>${T("inst.bandHits")}: <b>${r.bandHits ?? 0}</b></span>`;
  html += `</div>`;
  html += `<div class="inst-edges">`;
  html += edgeChip(T("inst.life.minted"), r.minted, (e) => `${e.rule} · ×${(e.buyMod ?? 0).toFixed(3)}`);
  html += edgeChip(T("inst.life.adopted"), r.adopted, (e) => `${e.rule} · ${e.adopters} ${T("inst.adopters")}`);
  html += edgeChip(T("inst.life.revoked"), r.revoked, (e) => `${e.rule} · ${((e.strength ?? 0) * 100).toFixed(0)}%`);
  html += edgeChip(T("inst.life.died"), r.died, (e) => `${e.rule} · ${e.lived} ${T("inst.ticks")}`);
  html += `</div>`;
  const rows = Array.isArray(r.rules) ? r.rules : [];
  if (rows.length === 0) return html + `<p class="evo-empty">${T("inst.noneActive")}</p>`;
  html += `<table class="evo-table inst-table"><thead><tr><th>${T("inst.condition")}</th><th>${T("inst.buyMod")}</th><th>${T("inst.cpMod")}</th><th>${T("inst.strength")}</th><th>${T("inst.members")}</th><th>${T("inst.revokes")}</th><th>${T("inst.variants")}</th></tr></thead><tbody>`;
  for (const row of rows.slice(0, 40)) {
    html += `<tr><td class="inst-cond" title="${T("inst.id")}: ${row.id}">${esc(row.rule)}</td><td>×${(row.buyMod ?? 0).toFixed(3)}</td><td>×${(row.cpMod ?? 0).toFixed(3)}</td><td>${strengthBar(row.strength)}</td><td>${row.members ?? 0}</td><td>${row.revokes ?? 0}</td><td>${row.variants ?? 0}</td></tr>`;
  }
  html += `</tbody></table>`;
  return html;
}

// ── tiny safe-text helper (the worker's own label strings, escaped for innerHTML) ──
function esc(s) {
  return String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
