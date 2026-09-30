// evolution.js — Phase 7 open-ended evolution engine visualisation drawer (task 88).
//
// READ-ONLY consumer of four worker endpoints:
//   GET /lineage/stats    → cross-generation capability curve (capability ④)
//   GET /lineage          → strategy-genome family tree (capability ②)
//   GET /replay/economy   → era economic replay snapshots (capability ⑥)
//   GET /economy          → playbook rings (①) + MAP-Elites archive (③) when exposed
//
// Architecture mirrors the PoCA drawer (task 50): open/close/toggle lifecycle,
// fetch-into-cache then paint. paintEvolution() rebuilds from cache alone (no
// refetch) so rerenderAll() can call it on a language switch.
//
// The four panels are tab-switched inside a single drawer shell:
//   curve   — multi-objective fitness rising across generations (SVG line chart)
//   genome  — strategy tree lineage: mutate/cross/genesis graph (SVG DAG)
//   heatmap — MAP-Elites 4×4 niche grid coloured by elite fitness (CSS grid)
//   replay  — era-by-era economic replay digest (table + hash chain)
//
// No LLM. No writes to the worker. Pure read-out visualisation.
import { state, $, API, clamp } from './shared.js?v=164';
import { t as T, gl } from './i18n.js?v=115';
import { getJSON } from './polling.js?v=164';

// ═══════════════════════════════════════════════════════════════════════════════
// LIFECYCLE
// ═══════════════════════════════════════════════════════════════════════════════

export function openEvolution() {
  state.evoOpen = true;
  // mutual exclusion — close every other drawer
  if (state.chronOpen) window.__closeChron?.();
  if (state.canaryOpen) window.__closeCanary?.();
  if (state.templeOpen) window.__closeTemple?.();
  if (state.pocaOpen) window.__closePoca?.();
  if (state.landOpen) window.__closeLand?.();
  if (state.walletsOpen) window.__closeWallets?.();
  if (state.instOpen) window.__closeInst?.();
  const d = $("evo-drawer"); if (!d) return;
  d.hidden = false;
  document.body.classList.add("evo-open");
  requestAnimationFrame(() => d.classList.add("open"));
  renderEvolution();
}

export function closeEvolution() {
  state.evoOpen = false;
  document.body.classList.remove("evo-open");
  const d = $("evo-drawer"); if (!d) return;
  d.classList.remove("open");
  setTimeout(() => { if (!state.evoOpen) d.hidden = true; }, 420);
}

export function toggleEvolution() { if (state.evoOpen) closeEvolution(); else openEvolution(); }

// ═══════════════════════════════════════════════════════════════════════════════
// DATA LAYER
// ═══════════════════════════════════════════════════════════════════════════════

let _evoTab = "curve";   // active sub-tab

export async function renderEvolution() {
  const body = $("evo-body"); if (!body) return;
  state.evoLoading = true;
  paintEvolution();
  const [ls, lin, rep, econ] = await Promise.all([
    getJSON("/lineage/stats", 10000).catch(() => null),
    getJSON("/lineage?limit=200", 10000).catch(() => null),
    getJSON("/replay/economy", 12000).catch(() => null),
    getJSON("/economy", 10000).catch(() => null),
  ]);
  state.evoLineageStats = ls;
  state.evoLineage = lin;
  state.evoReplay = rep;
  // Extract playbook + elites from the /economy blob when the worker exposes them
  state.evoPlaybook = econ?.playbook ?? null;
  state.evoElites = econ?.elitesArchive ?? null;
  state.evoLoading = false;
  paintEvolution();
}

/** Repaint from cache — no refetch. Called by rerenderAll() on a language switch. */
export function paintEvolution() {
  const body = $("evo-body"); if (!body) return;
  if (state.evoLoading) { body.innerHTML = `<p class="evo-loading">${T("evo.loading")}</p>`; return; }
  // tab bar
  const tabs = ["curve", "genome", "heatmap", "replay", "playbook"];
  let html = `<nav class="evo-tabs" role="tablist">`;
  for (const id of tabs) {
    const on = id === _evoTab ? " is-on" : "";
    html += `<button type="button" role="tab" class="evo-tab${on}" data-etab="${id}" aria-selected="${id === _evoTab}">${T("evo.tab." + id)}</button>`;
  }
  html += `</nav><div class="evo-panel">`;
  switch (_evoTab) {
    case "curve": html += paintCurve(); break;
    case "genome": html += paintGenome(); break;
    case "heatmap": html += paintHeatmap(); break;
    case "replay": html += paintReplay(); break;
    case "playbook": html += paintPlaybook(); break;
  }
  html += `</div>`;
  body.innerHTML = html;
  // bind tab clicks
  body.querySelectorAll(".evo-tab").forEach((btn) => {
    btn.addEventListener("click", () => { _evoTab = btn.dataset.etab; paintEvolution(); });
  });
}

// ═══════════════════════════════════════════════════════════════════════════════
// PANEL: CROSS-GENERATION CAPABILITY CURVE (capability ④)
// ═══════════════════════════════════════════════════════════════════════════════

function paintCurve() {
  const ls = state.evoLineageStats;
  if (!ls || !ls.enabled) return `<p class="evo-empty">${T("evo.noData")}</p>`;
  const gens = ls.byGeneration;
  if (!gens || gens.length === 0) return `<p class="evo-empty">${T("evo.noGens")}</p>`;
  // Metrics to chart
  const metrics = [
    { key: "survivalRate", label: T("evo.metric.survival"), color: "#4caf50" },
    { key: "avgNetUsdcPer1kTick", label: T("evo.metric.pnl"), color: "#ff9800" },
    { key: "settleSuccessRate", label: T("evo.metric.settle"), color: "#2196f3" },
    { key: "predictHitRate", label: T("evo.metric.predict"), color: "#9c27b0" },
    { key: "avgLifespanTicks", label: T("evo.metric.lifespan"), color: "#f44336" },
  ];
  const W = 340, H = 160, PAD = { t: 12, r: 10, b: 24, l: 38 };
  const cw = W - PAD.l - PAD.r, ch = H - PAD.t - PAD.b;
  const n = gens.length;
  const xStep = n > 1 ? cw / (n - 1) : cw;
  let svg = `<svg class="evo-chart" viewBox="0 0 ${W} ${H}" preserveAspectRatio="xMidYMid meet" aria-label="${T("evo.curveAria")}">`;
  // axes
  svg += `<line x1="${PAD.l}" y1="${PAD.t}" x2="${PAD.l}" y2="${PAD.t + ch}" stroke="rgba(122,96,58,0.55)" stroke-width="0.5"/>`;
  svg += `<line x1="${PAD.l}" y1="${PAD.t + ch}" x2="${PAD.l + cw}" y2="${PAD.t + ch}" stroke="rgba(122,96,58,0.55)" stroke-width="0.5"/>`;
  // x labels (generation numbers)
  for (let i = 0; i < n; i++) {
    const x = PAD.l + i * xStep;
    if (n <= 10 || i % Math.ceil(n / 8) === 0) {
      svg += `<text x="${x}" y="${H - 4}" text-anchor="middle" class="evo-axis-lb">G${gens[i].generation}</text>`;
    }
  }
  // y-axis: normalise all to 0..1 range for visual comparison
  for (const m of metrics) {
    const vals = gens.map((g) => g[m.key] ?? 0);
    const max = Math.max(...vals, 0.001);
    let path = "";
    for (let i = 0; i < n; i++) {
      const x = PAD.l + i * xStep;
      const y = PAD.t + ch - (vals[i] / max) * ch;
      path += (i === 0 ? "M" : "L") + `${x.toFixed(1)},${y.toFixed(1)}`;
    }
    svg += `<path d="${path}" fill="none" stroke="${m.color}" stroke-width="1.5" stroke-linecap="round" opacity="0.85"/>`;
  }
  svg += `</svg>`;
  // legend
  let legend = `<div class="evo-legend">`;
  for (const m of metrics) legend += `<span class="evo-leg-item"><i style="background:${m.color}"></i>${m.label}</span>`;
  legend += `</div>`;
  // summary stats
  const latest = gens[gens.length - 1];
  let summary = `<div class="evo-summary">`;
  summary += `<span>${T("evo.generations")}: <b>${ls.generations}</b></span>`;
  summary += `<span>${T("evo.agents")}: <b>${ls.agents}</b></span>`;
  summary += `<span>${T("evo.mode")}: <b>${ls.mode || "—"}</b></span>`;
  if (latest) summary += `<span>${T("evo.latestSurvival")}: <b>${(latest.survivalRate * 100).toFixed(1)}%</b></span>`;
  summary += `</div>`;
  return summary + svg + legend;
}

// ═══════════════════════════════════════════════════════════════════════════════
// PANEL: STRATEGY-GENOME LINEAGE (capability ②)
// ═══════════════════════════════════════════════════════════════════════════════

function paintGenome() {
  const lin = state.evoLineage;
  if (!lin || !lin.entries || lin.entries.length === 0) return `<p class="evo-empty">${T("evo.noLineage")}</p>`;
  const entries = lin.entries.slice(0, 80);   // bounded for DOM perf
  // Group by generation
  const byGen = new Map();
  for (const e of entries) {
    const g = e.generation ?? 0;
    if (!byGen.has(g)) byGen.set(g, []);
    byGen.get(g).push(e);
  }
  const gens = [...byGen.keys()].sort((a, b) => a - b);
  // Build a horizontal generation flow: each gen is a column
  const COL_W = 90, NODE_H = 22, GAP = 4;
  const maxNodes = Math.max(...gens.map((g) => byGen.get(g).length), 1);
  const W = gens.length * COL_W + 20;
  const H = Math.min(maxNodes * (NODE_H + GAP) + 30, 400);
  let svg = `<svg class="evo-chart evo-genome" viewBox="0 0 ${W} ${H}" preserveAspectRatio="xMinYMin meet" aria-label="${T("evo.genomeAria")}">`;
  const nodePos = new Map();   // genomeHash → {x, y}
  for (let gi = 0; gi < gens.length; gi++) {
    const g = gens[gi];
    const nodes = byGen.get(g);
    const x = 10 + gi * COL_W;
    svg += `<text x="${x + 20}" y="12" class="evo-axis-lb" text-anchor="middle">G${g}</text>`;
    for (let ni = 0; ni < nodes.length && ni < 14; ni++) {
      const e = nodes[ni];
      const y = 20 + ni * (NODE_H + GAP);
      nodePos.set(e.genomeHash, { x: x + 20, y: y + NODE_H / 2 });
      const opColor = e.op === "genesis" ? "#78909c" : e.op === "mutate" ? "#66bb6a" : "#ab47bc";
      svg += `<rect x="${x}" y="${y}" width="40" height="${NODE_H}" rx="4" fill="${opColor}" opacity="0.7"/>`;
      svg += `<text x="${x + 20}" y="${y + 14}" text-anchor="middle" class="evo-node-lb">${e.genomeHash.slice(0, 6)}</text>`;
    }
    if (nodes.length > 14) svg += `<text x="${x + 20}" y="${20 + 14 * (NODE_H + GAP) + 10}" text-anchor="middle" class="evo-axis-lb">+${nodes.length - 14}</text>`;
  }
  // edges (parent → child)
  for (const e of entries) {
    if (!e.parents) continue;
      const child = nodePos.get(e.genomeHash);
      if (!child) continue;
      for (const ph of e.parents) {
        const parent = nodePos.get(ph);
        if (!parent) continue;
        svg += `<line x1="${parent.x + 20}" y1="${parent.y}" x2="${child.x - 20}" y2="${child.y}" stroke="var(--muted)" stroke-width="0.7" opacity="0.5"/>`;
      }
  }
  svg += `</svg>`;
  // legend
  let legend = `<div class="evo-legend">`;
  legend += `<span class="evo-leg-item"><i style="background:#78909c"></i>${T("evo.op.genesis")}</span>`;
  legend += `<span class="evo-leg-item"><i style="background:#66bb6a"></i>${T("evo.op.mutate")}</span>`;
  legend += `<span class="evo-leg-item"><i style="background:#ab47bc"></i>${T("evo.op.cross")}</span>`;
  legend += `</div>`;
  // stats header
  let hdr = `<div class="evo-summary">`;
  hdr += `<span>${T("evo.totalGenomes")}: <b>${lin.count}</b></span>`;
  hdr += `<span>${T("evo.generations")}: <b>${lin.generations}</b></span>`;
  hdr += `<span>${T("evo.bred")}: <b>${lin.bred}</b></span>`;
  if (lin.evolution) hdr += `<span>${T("evo.breedsToday")}: <b>${lin.evolution.breedsToday}/${lin.evolution.globalDailyMax}</b></span>`;
  hdr += `</div>`;
  return hdr + svg + legend;
}

// ═══════════════════════════════════════════════════════════════════════════════
// PANEL: MAP-ELITES ARCHIVE HEATMAP (capability ②/③)
// ═══════════════════════════════════════════════════════════════════════════════

function paintHeatmap() {
  // Primary source: /lineage/stats bins (generation × band); secondary: elitesArchive if exposed
  const ls = state.evoLineageStats;
  const elites = state.evoElites;
  if (elites && Array.isArray(elites) && elites.length > 0) return paintElitesGrid(elites);
  if (!ls || !ls.bins || ls.bins.length === 0) return `<p class="evo-empty">${T("evo.noHeatmap")}</p>`;
  return paintBinsHeatmap(ls.bins, ls.byGeneration);
}

/** Full 4×4×4 MAP-Elites archive (when the worker exposes elitesArchive in /economy). */
function paintElitesGrid(cells) {
  // cells: [{c, a, f, h, t, b:[arousal, settleRate, entropy]}]
  // Project onto 2D: arousal (x) × settleRate (y), colour by fitness; entropy as layer selector
  const BINS = 4;
  const maxFit = Math.max(...cells.map((c) => Math.abs(c.f)), 0.001);
  let html = `<div class="evo-summary"><span>${T("evo.elitesOccupied")}: <b>${cells.length}/64</b></span></div>`;
  html += `<div class="evo-hm-wrap"><table class="evo-hm"><thead><tr><th></th>`;
  for (let s = 0; s < BINS; s++) html += `<th>${T("evo.settle")}${s}</th>`;
  html += `</tr></thead><tbody>`;
  for (let a = BINS - 1; a >= 0; a--) {
    html += `<tr><th>${T("evo.arousal")}${a}</th>`;
    for (let s = 0; s < BINS; s++) {
      // find best fitness in this (a, s, *) slice
      let best = null;
      for (const c of cells) {
        if (c.b[0] === a && c.b[1] === s && (!best || c.f > best.f)) best = c;
      }
      if (best) {
        const intensity = Math.min(Math.abs(best.f) / maxFit, 1);
        const hue = best.f >= 0 ? 120 : 0;
        html += `<td class="evo-hm-cell" style="background:hsla(${hue},70%,45%,${0.2 + intensity * 0.7})" title="agent ${best.a} · fitness ${best.f.toFixed(4)} · tick ${best.t}">${best.f.toFixed(2)}</td>`;
      } else {
        html += `<td class="evo-hm-cell evo-hm-empty">·</td>`;
      }
    }
    html += `</tr>`;
  }
  html += `</tbody></table></div>`;
  return html;
}

/** Fallback: generation × temperature-band heatmap from /lineage/stats bins. */
function paintBinsHeatmap(bins, byGen) {
  const bands = ["COLD", "CALM", "HOT"];
  const gens = [...new Set(bins.map((b) => b.generation))].sort((a, b) => a - b);
  const maxAgents = Math.max(...bins.map((b) => b.agents), 1);
  let html = `<div class="evo-hm-wrap"><table class="evo-hm"><thead><tr><th>${T("evo.generation")}</th>`;
  for (const b of bands) html += `<th>${gl("regime", b)}</th>`;
  html += `</tr></thead><tbody>`;
  for (const g of gens.slice(-20)) {
    html += `<tr><th>G${g}</th>`;
    for (const band of bands) {
      const cell = bins.find((b) => b.generation === g && b.band === band);
      if (cell && cell.agents > 0) {
        const intensity = cell.agents / maxAgents;
        const survival = cell.survivalRate;
        const hue = survival > 0.6 ? 120 : survival > 0.3 ? 45 : 0;
        html += `<td class="evo-hm-cell" style="background:hsla(${hue},65%,42%,${0.15 + intensity * 0.7})" title="${cell.agents} agents · survival ${(survival * 100).toFixed(0)}% · pnl/tick ${cell.avgNetUsdcPer1kTick.toFixed(4)}">${cell.agents}</td>`;
      } else {
        html += `<td class="evo-hm-cell evo-hm-empty">·</td>`;
      }
    }
    html += `</tr>`;
  }
  html += `</tbody></table></div>`;
  return html;
}

// ═══════════════════════════════════════════════════════════════════════════════
// PANEL: REPLAY ECONOMY (capability ⑥)
// ═══════════════════════════════════════════════════════════════════════════════

function paintReplay() {
  const rep = state.evoReplay;
  if (!rep) return `<p class="evo-empty">${T("evo.noReplay")}</p>`;
  if (!rep.enabled) return `<p class="evo-empty">${T("evo.replayDisabled")}${rep.note ? " — " + rep.note : ""}</p>`;
  if (!rep.eras || rep.eras.length === 0) return `<p class="evo-empty">${T("evo.noEras")}${rep.note ? " — " + rep.note : ""}</p>`;
  let html = `<div class="evo-summary">`;
  html += `<span>${T("evo.replayEras")}: <b>${rep.count}</b></span>`;
  html += `<span>${T("evo.replaySeed")}: <b>0x${(rep.seed ?? 0).toString(16)}</b></span>`;
  html += `<span>${T("evo.replayRange")}: <b>${rep.fromEra}–${rep.toEra}</b></span>`;
  html += `</div>`;
  if (rep.combinedHash) html += `<div class="evo-hash-row"><span class="evo-hash-lb">${T("evo.combinedHash")}:</span><code class="evo-hash">${rep.combinedHash}</code></div>`;
  html += `<table class="evo-table"><thead><tr><th>${T("evo.era")}</th><th>${T("evo.tick")}</th><th>${T("evo.pulses")}</th><th>${T("evo.volume")}</th><th>${T("evo.gini")}</th><th>${T("evo.replayHash")}</th></tr></thead><tbody>`;
  for (const era of rep.eras.slice(0, 30)) {
    const fs = era.finalState;
    html += `<tr>`;
    html += `<td>${era.era}</td><td>${era.tick}</td><td>${era.seedPulses}</td>`;
    html += `<td>${fs ? Number(fs.volumeUsdc ?? 0).toFixed(2) : "—"}</td>`;
    html += `<td>${fs ? (fs.gini ?? 0).toFixed(3) : "—"}</td>`;
    html += `<td><code class="evo-hash-sm" title="${era.replayHash}">${era.replayHash.slice(0, 10)}…</code></td>`;
    html += `</tr>`;
  }
  html += `</tbody></table>`;
  if (rep.boundary) html += `<p class="evo-boundary">${T("evo.boundary")}: <em>${rep.boundary}</em></p>`;
  return html;
}

// ═══════════════════════════════════════════════════════════════════════════════
// PANEL: PLAYBOOK / CONSEQUENCE MEMORY (capability ①)
// ═══════════════════════════════════════════════════════════════════════════════

function paintPlaybook() {
  const pb = state.evoPlaybook;
  if (!pb || !Array.isArray(pb) || pb.length === 0) {
    return `<p class="evo-empty">${T("evo.noPlaybook")}</p>`;
  }
  // pb shape (from economy.serialize()): [{id, e: [[ctx, action, good, regime, outcome, valid, tick], ...]}]
  const GOODS = ["signal", "momentum", "attestation", "prediction"];
  const REGIMES = ["COLD", "CALM", "HOT"];
  let html = `<div class="evo-summary"><span>${T("evo.playbookFlies")}: <b>${pb.length}</b></span></div>`;
  html += `<div class="evo-pb-list">`;
  for (const ring of pb.slice(0, 20)) {
    const entries = ring.e ?? [];
    html += `<details class="evo-pb-fly"><summary>${T("evo.fly")} #${ring.id} · ${entries.length} ${T("evo.memories")}</summary><table class="evo-table evo-pb-table"><thead><tr><th>${T("evo.pb.action")}</th><th>${T("evo.pb.good")}</th><th>${T("evo.pb.regime")}</th><th>${T("evo.pb.outcome")}</th><th>${T("evo.pb.valid")}</th><th>${T("evo.pb.tick")}</th></tr></thead><tbody>`;
    for (const e of entries.slice(0, 16)) {
      const [ctx, action, good, regime, outcome, valid, tick] = e;
      html += `<tr><td>${action === 0 ? T("evo.pb.buy") : T("evo.pb.sell")}</td><td>${gl("goods", GOODS[good] ?? good)}</td><td>${gl("regime", REGIMES[regime] ?? regime)}</td><td class="${outcome > 0 ? "evo-pos" : outcome < 0 ? "evo-neg" : ""}">${outcome}</td><td>${valid ? "✓" : "✗"}</td><td>${tick}</td></tr>`;
    }
    html += `</tbody></table></details>`;
  }
  if (pb.length > 20) html += `<p class="evo-more">${T("evo.showingFirst", { n: 20, total: pb.length })}</p>`;
  html += `</div>`;
  return html;
}
