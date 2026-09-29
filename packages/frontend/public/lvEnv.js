// lvEnv.js — task 31 · Phase D: market temperature environment field (C14), wealth Gini micro-chart (C16),
// order-book price tape (C17), trust-minimised PnL colouring (C18), fulfilment reputation arcs (C19),
// and per-node on-chain anchor marks (C21).
// Imported by lineageView.js with ?v= cache-buster (task 75).
//
// PERF CONTRACT
//   lvEnvFrame is called EVERY FRAME, underneath the social edges. It blits ONE offscreen ambient bake +
//   draws at most two corner widgets (C16 histogram ≈ 75 rects, C17 sparkline ≈ 60 lineTo). Never a
//   per-node loop, never an imageData read-back, and it MUST consult LVQ.tier first.
//   lvEnvNodeOverlay is called AFTER the live-node loop (forwarded from lvNeuralFrame). It draws per-node
//   arcs (C19) + anchor ticks (C21) + optional PnL body recolour (C18). Gated by tier.
//   No shadowBlur, no backdrop-filter, no .filter =.
import { LV, LVQ, LV_HUD, nodeR, nodeById } from './lvState.js?v=162';
import {
  state, clamp, mix, rgb, rgba, paletteAt, TAU, INK, GILT, GILT_HI, GOOD_COL,
} from './shared.js?v=162';
import { ribbonSeries } from './render2d.js?v=162';
import { getJSON } from './polling.js?v=162';

// ================= C14: market temperature environment field =================
// The regime (HOT/CALM/COLD) drives a full-canvas ambient wash baked into an offscreen. Re-bakes ONLY when
// the regime bucket changes. Per-frame: blit with a slow globalAlpha pulse (breathing). Corner readout shows
// the derivation chain: txPerBlock / baselineTx → EWMA → logistic → temperature → regime.
// Background 20-min temperature ribbon via ribbonSeries(wall).

const REGIME_COLORS = {
  HOT:  { base: [180, 60, 30],  accent: [240, 140, 60] },
  CALM: { base: [100, 110, 90], accent: [160, 170, 130] },
  COLD: { base: [40, 70, 130],  accent: [80, 140, 200] },
};

let envOff = null, envCtx = null, envKey = '';
let c14Ewma = 0.5;   // EWMA of txRatio (smoothed)

// task 42 · P0-C — corner widgets no longer hard-code their offset from the raw viewport edge (that put the
// top pair under the 94 %-opaque .topbar and the bottom-right pair on top of each other). Every box comes
// from lvState's safe-area solve, which measures the real chrome (.topbar / #command-rail / #lv-toolbar /
// #lv-prov-bar / #lv-legend / #switch-to-3d / #lv-panel) and guarantees ≥8 px from the tree bbox.
// LV_HUD.scale is the "a bit bigger, a bit closer to the circle" multiplier (0.9 phone … 1.3 tall desktop);
// all internal insets and font sizes below are multiplied by it so a widget scales as a whole.
/** The resolved screen-space box for one corner widget, or null when the solve gave it no room. */
function hudBox(key) { const b = LV_HUD[key]; return (b && b.w > 4 && b.h > 4) ? b : null; }

/** Regime bucket for bakeSignature (exported to lineageView.js). */
export function lvEnvRegimeBucket() {
  const r = (state.collective && state.collective.regime) || 'CALM';
  return r === 'HOT' ? 2 : r === 'COLD' ? 0 : 1;
}

function bakeAmbient() {
  const regime = (state.collective && state.collective.regime) || 'CALM';
  const key = `${regime}|${LV.W}|${LV.H}`;
  if (envKey === key && envOff) return;
  envKey = key;
  if (!envOff) { envOff = document.createElement('canvas'); envCtx = envOff.getContext('2d'); }
  envOff.width = Math.round(LV.W * 0.5);   // half-res is enough for a gradient wash
  envOff.height = Math.round(LV.H * 0.5);
  const x = envCtx, w = envOff.width, h = envOff.height;
  x.clearRect(0, 0, w, h);
  const rc = REGIME_COLORS[regime] || REGIME_COLORS.CALM;
  const pal = paletteAt(state.tempSmoothed);
  // radial gradient from centre: regime tint fades outward
  const grd = x.createRadialGradient(w / 2, h / 2, 0, w / 2, h / 2, Math.max(w, h) * 0.7);
  grd.addColorStop(0, rgba(rc.accent, 0.10));
  grd.addColorStop(0.5, rgba(rc.base, 0.05));
  grd.addColorStop(1, rgba(mix(pal.paper, rc.base, 0.08), 0.02));
  x.fillStyle = grd;
  x.fillRect(0, 0, w, h);
}

function drawC14Ribbon(x) {
  // 20-min temperature ribbon — bottom-right, LOWER slot (the generation histogram stacks above it)
  const b = hudBox('brBot'); if (!b) return;
  const wall = Date.now();
  const series = ribbonSeries(wall);
  if (series.length < 2) return;
  const S = LV_HUD.scale;
  const rw = b.w, rh = b.h;
  const ox = b.x, oy = b.y;
  const WINDOW = 20 * 60 * 1000;
  const pal = paletteAt(state.tempSmoothed);
  // background
  x.fillStyle = rgba(pal.paper, 0.55);
  x.fillRect(ox, oy, rw, rh);
  x.strokeStyle = rgba(INK, 0.12); x.lineWidth = 0.5;
  x.strokeRect(ox, oy, rw, rh);
  // regime threshold guides
  x.strokeStyle = rgba(INK, 0.08); x.lineWidth = 0.4;
  for (const th of [0.33, 0.66]) {
    const gy = oy + rh - th * rh;
    x.beginPath(); x.moveTo(ox, gy); x.lineTo(ox + rw, gy); x.stroke();
  }
  // temperature line
  x.beginPath();
  for (let i = 0; i < series.length; i++) {
    const p = series[i];
    const px = ox + rw - ((wall - p.t) / WINDOW) * rw;
    const py = oy + rh - clamp(p.T, 0, 1) * rh;
    if (i === 0) x.moveTo(px, py); else x.lineTo(px, py);
  }
  x.strokeStyle = rgba(pal.accent, 0.75); x.lineWidth = 1.1; x.stroke();
  // label
  x.font = (7 * S).toFixed(1) + 'px monospace'; x.lineWidth = 2 * S;
  x.strokeStyle = rgba(pal.paper, 0.8); x.strokeText('20min', ox + 2 * S, oy + 8 * S);
  x.fillStyle = rgba(INK, 0.4); x.fillText('20min', ox + 2 * S, oy + 8 * S);
}

function drawC14Corner(x) {
  // derivation chain readout: bottom-left, stacked ABOVE #lv-legend and #switch-to-3d
  const m = state.arcMarket;
  if (!m) return;
  const b = hudBox('bl'); if (!b) return;
  const tpb = m.txPerBlock || 0, base = m.baselineTx || 1;
  const ratio = base > 1e-6 ? tpb / base : 1;
  // EWMA update (once per frame is fine — it converges)
  c14Ewma += (ratio - c14Ewma) * 0.02;
  // logistic → temperature (mirrors the worker's formula)
  const logistic = 1 / (1 + Math.exp(-4 * (c14Ewma - 1)));
  const temp = m.temperature != null ? m.temperature : logistic;
  const regime = (state.collective && state.collective.regime) || 'CALM';
  const S = LV_HUD.scale;
  const ox = b.x, lh = 11 * S;
  const oy = b.y + 9 * S;   // baseline of the first of the three lines
  const pal = paletteAt(state.tempSmoothed);
  x.font = (9 * S).toFixed(1) + 'px monospace'; x.lineWidth = 2.4 * S;
  const lines = [
    `tx/blk ${tpb.toFixed(1)} / base ${base.toFixed(1)}`,
    `EWMA ${c14Ewma.toFixed(3)} → σ ${(logistic * 100).toFixed(0)}%`,
    `T ${temp.toFixed(3)} · ${regime}`,
  ];
  for (let i = 0; i < lines.length; i++) {
    x.strokeStyle = rgba(pal.paper, 0.8); x.strokeText(lines[i], ox, oy + i * lh);
    x.fillStyle = rgba(INK, 0.52); x.fillText(lines[i], ox, oy + i * lh);
  }
}

// ================= C16: wealth Gini micro-chart =================
// 75-bucket log-balance histogram + Gini diagonal + long-term curve + settlement health.

const GINI_BUCKETS = 75;
let giniHist = new Float32Array(GINI_BUCKETS);
let giniLastBuild = 0;

function buildGiniHist() {
  const now = performance.now();
  if (now - giniLastBuild < 2000) return;   // rebuild at most every 2s
  giniLastBuild = now;
  giniHist.fill(0);
  const bals = state.econBalances;
  if (!bals || !bals.size) return;
  // log-scale: bucket = floor(log10(max(bal,1e-6)) * 15 + 45) clamped to [0,74]
  for (const [, usdc] of bals) {
    const v = Math.max(Number(usdc) || 0, 1e-6);
    const b = clamp(Math.floor(Math.log10(v) * 15 + 45), 0, GINI_BUCKETS - 1);
    giniHist[b]++;
  }
}

function drawC16(x) {
  buildGiniHist();
  const totals = state.econTotals;
  if (!totals) return;
  // task 42 · P0-C — top-right slot from the safe-area solve; the old `oy = 26` started 46 px UNDER the
  // 94 %-opaque .topbar, so the top third of the histogram was invisible.
  const b = hudBox('tr'); if (!b) return;
  const S = LV_HUD.scale;
  const gw = b.w, gh = b.h;
  const ox = b.x, oy = b.y;
  const base = 10 * S;            // baseline inset above the box's bottom edge
  const inner = gh - 12 * S;      // drawable bar height
  const pal = paletteAt(state.tempSmoothed);
  // background
  x.fillStyle = rgba(pal.paper, 0.55); x.fillRect(ox, oy, gw, gh);
  x.strokeStyle = rgba(INK, 0.12); x.lineWidth = 0.5; x.strokeRect(ox, oy, gw, gh);
  // histogram bars
  let maxH = 1;
  for (let i = 0; i < GINI_BUCKETS; i++) if (giniHist[i] > maxH) maxH = giniHist[i];
  const bw = gw / GINI_BUCKETS;
  x.fillStyle = rgba(GILT, 0.45);
  for (let i = 0; i < GINI_BUCKETS; i++) {
    const h = (giniHist[i] / maxH) * inner;
    if (h < 0.5) continue;
    x.fillRect(ox + i * bw, oy + gh - base - h, Math.max(bw - 0.3, 0.5), h);
  }
  // Gini diagonal (equality reference)
  x.strokeStyle = rgba(INK, 0.22); x.lineWidth = 0.7;
  x.beginPath(); x.moveTo(ox, oy + gh - base); x.lineTo(ox + gw, oy + 2 * S); x.stroke();
  // long-term gini curve from histRows (last 100 samples)
  const rows = state.histRows;
  if (rows && rows.length > 2) {
    const n = Math.min(rows.length, 100);
    const start = rows.length - n;
    x.beginPath();
    for (let i = 0; i < n; i++) {
      const g = rows[start + i].gini;
      if (g == null) continue;
      const px = ox + (i / (n - 1)) * gw;
      const py = oy + gh - base - clamp(g, 0, 1) * inner;
      if (i === 0) x.moveTo(px, py); else x.lineTo(px, py);
    }
    x.strokeStyle = rgba([160, 60, 60], 0.55); x.lineWidth = 0.9; x.stroke();
  }
  // readout
  x.font = (7 * S).toFixed(1) + 'px monospace'; x.lineWidth = 2 * S;
  const gini = totals.gini != null ? totals.gini.toFixed(3) : '—';
  const health = totals.successRate != null ? `${(totals.successRate * 100).toFixed(1)}%` : '—';
  const label = `G=${gini} H=${health}`;
  x.strokeStyle = rgba(pal.paper, 0.8); x.strokeText(label, ox + 2 * S, oy + 8 * S);
  x.fillStyle = rgba(INK, 0.55); x.fillText(label, ox + 2 * S, oy + 8 * S);
}

// ================= C17: order-book price tape =================
// books[4] × 4 levels bid/ask + mark; marks{4×60} sparkline.

function drawC17(x) {
  const mkt = state.econMarket;
  if (!mkt || !Array.isArray(mkt.books) || !mkt.books.length) return;
  // task 42 · P0-C — top-left slot from the safe-area solve (was a literal 24/26, i.e. under the topbar
  // and behind #command-rail, which is 56 px wide).
  const b = hudBox('tl'); if (!b) return;
  const S = LV_HUD.scale;
  const tw = b.w, th = b.h;
  const ox = b.x, oy = b.y;
  const pal = paletteAt(state.tempSmoothed);
  // background
  x.fillStyle = rgba(pal.paper, 0.55); x.fillRect(ox, oy, tw, th);
  x.strokeStyle = rgba(INK, 0.12); x.lineWidth = 0.5; x.strokeRect(ox, oy, tw, th);
  // sparkline from marks (4 goods × up to 60 samples)
  const marks = mkt.marks;
  if (marks) {
    const goods = ['signal', 'momentum', 'attestation', 'prediction'];
    const rowH = (th - 10 * S) / goods.length;
    for (let gi = 0; gi < goods.length; gi++) {
      const arr = marks[goods[gi]];
      if (!Array.isArray(arr) || arr.length < 2) continue;
      const col = GOOD_COL[goods[gi]] || GILT;
      let min = Infinity, max = -Infinity;
      for (const v of arr) { const n = Number(v); if (n < min) min = n; if (n > max) max = n; }
      if (max - min < 1e-9) { min -= 1; max += 1; }
      x.beginPath();
      for (let i = 0; i < arr.length; i++) {
        const px = ox + 3 * S + (i / (arr.length - 1)) * (tw - 6 * S);
        const py = oy + 6 * S + gi * rowH + rowH - 2 * S - ((Number(arr[i]) - min) / (max - min)) * (rowH - 4 * S);
        if (i === 0) x.moveTo(px, py); else x.lineTo(px, py);
      }
      x.strokeStyle = rgba(col, 0.7); x.lineWidth = 0.8; x.stroke();
    }
  }
  // best bid/ask readout from first book
  const bk = mkt.books[0];
  if (bk) {
    const bid = bk.bids && bk.bids[0] ? Number(bk.bids[0].price) / 1e6 : 0;
    const ask = bk.asks && bk.asks[0] ? Number(bk.asks[0].price) / 1e6 : 0;
    x.font = (7 * S).toFixed(1) + 'px monospace'; x.lineWidth = 2 * S;
    const lbl = `${bk.good || '—'} b${bid.toFixed(3)} a${ask.toFixed(3)}`;
    x.strokeStyle = rgba(pal.paper, 0.8); x.strokeText(lbl, ox + 2 * S, oy + th - 2 * S);
    x.fillStyle = rgba(INK, 0.5); x.fillText(lbl, ox + 2 * S, oy + th - 2 * S);
  }
}

// ================= C18: trust-minimised PnL colouring =================
// Lazy /leaderboard fetch. Mode 0=house (default, no overlay), 1=netUsdc red-green, 2=genome similarity.
// The toolbar button cycles modes.

const LB_POLL_INTERVAL = 30000;
let lbRows = null, lbMap = null, lbLastPoll = 0, lbInFlight = false, lbAbort = null;
let pnlMode = 0;   // 0=house, 1=netUsdc, 2=genome

/** Cycle PnL colour mode (called from toolbar). Returns the new mode index. */
export function lvEnvCyclePnl() { pnlMode = (pnlMode + 1) % 3; if (pnlMode === 1) pollLeaderboard(); return pnlMode; }
export function lvEnvPnlMode() { return pnlMode; }

function pollLeaderboard() {
  if (lbInFlight) return;
  const now = performance.now();
  if (now - lbLastPoll < LB_POLL_INTERVAL && lbRows) return;
  lbLastPoll = now;
  lbInFlight = true;
  lbAbort = new AbortController();
  const timer = setTimeout(() => { if (lbAbort) lbAbort.abort(); }, 8000);
  getJSON('/leaderboard', 8000, lbAbort.signal).then((res) => {
    clearTimeout(timer); lbInFlight = false;
    if (res && Array.isArray(res.rows)) {
      lbRows = res.rows;
      lbMap = new Map();
      for (const r of lbRows) if (r && r.id != null) lbMap.set(r.id, r);
    }
  }).catch(() => { clearTimeout(timer); lbInFlight = false; });
}

function pnlColor(id) {
  if (!lbMap) return null;
  const r = lbMap.get(id);
  if (!r) return null;
  const net = Number(r.netUsdc) || 0;
  // red-green divergent: negative → red, positive → green, zero → neutral
  const t = clamp(net / 10, -1, 1);   // saturate at ±10 USDC
  if (t >= 0) return mix([180, 180, 170], [40, 140, 60], t);
  return mix([180, 180, 170], [180, 40, 30], -t);
}

function genomeColor(n) {
  // use the genotype hue annotation from lvGenetics (Phase C)
  if (n._genoHue == null) return null;
  const h = n._genoHue;   // 0..360
  const s = clamp(n._genoDensity || 0.5, 0.2, 1);
  // HSL→RGB approximation (canvas has no hsl fillStyle in rgba form)
  const c = (1 - Math.abs(2 * s - 1)) * 0.6;
  const hh = h / 60;
  const xx = c * (1 - Math.abs(hh % 2 - 1));
  let r1 = 0, g1 = 0, b1 = 0;
  if (hh < 1) { r1 = c; g1 = xx; } else if (hh < 2) { r1 = xx; g1 = c; }
  else if (hh < 3) { g1 = c; b1 = xx; } else if (hh < 4) { g1 = xx; b1 = c; }
  else if (hh < 5) { r1 = xx; b1 = c; } else { r1 = c; b1 = xx; }
  const m2 = s - c / 2;
  return [Math.round((r1 + m2) * 255), Math.round((g1 + m2) * 255), Math.round((b1 + m2) * 255)];
}

// ================= C19: fulfilment reputation layer =================
// social.rep[16].kept/broken → node outer "fulfilment integrity arc" with gaps at defaults.

let repMap = null, repLastBuild = 0;

function buildRepMap() {
  const now = performance.now();
  if (now - repLastBuild < 3000) return;
  repLastBuild = now;
  const soc = state.econSocial;
  if (!soc || !Array.isArray(soc.rep)) { repMap = null; return; }
  repMap = new Map();
  for (const r of soc.rep) {
    if (r && r.id != null) repMap.set(r.id, { kept: +r.kept || 0, broken: +r.broken || 0 });
  }
}

// ================= C21: per-node on-chain anchor mark =================
// A small anchor tick at the node's top-right indicates a real commitTx (139/139 in production).

// ================= MAIN FRAME ENTRY (before nodes) =================
/**
 * Per-frame environment backdrop + widgets, drawn AFTER the static bake and BEFORE the social edges.
 * @param {CanvasRenderingContext2D} x  already in world space (camApply)
 * @param {number} now  the rAF timestamp
 */
export function lvEnvFrame(x, now) {
  if (!LV.active || LVQ.tier >= 2) return;

  // ---- C14: ambient regime wash (offscreen bake + globalAlpha pulse) ----
  bakeAmbient();
  if (envOff) {
    const pulse = 0.6 + 0.4 * Math.sin(now * 0.0004);
    const prevAlpha = x.globalAlpha;
    x.globalAlpha = prevAlpha * (LVQ.tier === 0 ? pulse * 0.7 : 0.35);
    x.drawImage(envOff, 0, 0, LV.W, LV.H);
    x.globalAlpha = prevAlpha;
  }

  // ---- C14: corner derivation chain + 20-min ribbon (tier 0 only) ----
  if (LVQ.tier === 0) {
    drawC14Corner(x);
    drawC14Ribbon(x);
  }

  // ---- C16: Gini micro-chart (tier 0 only — it's a widget, shed early) ----
  if (LVQ.tier === 0) drawC16(x);

  // ---- C17: order-book tape (tier 0 only) ----
  if (LVQ.tier === 0) drawC17(x);
}

// ================= NODE OVERLAY (after nodes, forwarded from lvNeuralFrame) =================
/**
 * Per-node overlays drawn AFTER the live-node bodies: C18 PnL recolour, C19 reputation arcs,
 * C21 anchor marks, C16 richest/poorest markers.
 * @param {CanvasRenderingContext2D} x  already in world space
 * @param {number} now  the rAF timestamp
 */
export function lvEnvNodeOverlay(x, now) {
  if (!LV.active || LVQ.tier >= 2) return;

  // ---- C18: PnL / genome colour overlay (replaces house colour at mode 1 or 2) ----
  if (pnlMode > 0) {
    if (pnlMode === 1 && !lbRows) pollLeaderboard();
    for (const n of LV.nodes.values()) {
      if (n.kind !== 'live') continue;
      const px = (n.animating && n._ax != null) ? n._ax : n.x;
      const py = (n.animating && n._ay != null) ? n._ay : n.y;
      const r = nodeR(n);
      let col = null;
      if (pnlMode === 1) col = pnlColor(n.id);
      else if (pnlMode === 2) col = genomeColor(n);
      if (!col) continue;
      x.fillStyle = rgba(col, 0.82);
      x.beginPath(); x.arc(px, py, r, 0, TAU); x.fill();
    }
  }

  // ---- C19: fulfilment reputation arcs ----
  buildRepMap();
  if (repMap && repMap.size && LVQ.tier === 0) {
    x.lineWidth = 1.8;
    for (const n of LV.nodes.values()) {
      if (n.kind !== 'live' || n.id == null) continue;
      const rep = repMap.get(n.id);
      if (!rep) continue;
      const total = rep.kept + rep.broken;
      if (total < 1) continue;
      const frac = rep.kept / total;
      const px = (n.animating && n._ax != null) ? n._ax : n.x;
      const py = (n.animating && n._ay != null) ? n._ay : n.y;
      const r = nodeR(n) + 2.4;
      // arc from -π/2 clockwise, with a GAP at each broken segment
      const startA = -Math.PI / 2;
      const sweep = frac * TAU;
      // kept portion (green)
      if (sweep > 0.01) {
        x.strokeStyle = rgba([60, 140, 70], 0.6);
        x.beginPath(); x.arc(px, py, r, startA, startA + sweep); x.stroke();
      }
      // broken portion (red gap indicator)
      const gapSweep = TAU - sweep;
      if (gapSweep > 0.04) {
        x.strokeStyle = rgba([180, 50, 40], 0.45);
        x.setLineDash([2, 2]);
        x.beginPath(); x.arc(px, py, r, startA + sweep, startA + TAU); x.stroke();
        x.setLineDash([]);
      }
    }
  }

  // ---- C21: on-chain anchor marks (small tick at top-right of committed nodes) ----
  if (LVQ.tier <= 1) {
    x.lineWidth = 1.2;
    for (const n of LV.nodes.values()) {
      if (n.kind === 'ghost' && n.ghost === true) continue;
      // ancestor nodes and live nodes with a lineage entry that has commitTx
      const hasCommit = (n.kind === 'ancestor') || (n.entry && n.entry.commitTx);
      if (!hasCommit) continue;
      const px = (n.animating && n._ax != null) ? n._ax : n.x;
      const py = (n.animating && n._ay != null) ? n._ay : n.y;
      const r = nodeR(n);
      // small anchor tick: a 3px line at 45° from top-right
      const ax = px + r * 0.7, ay = py - r * 0.7;
      x.strokeStyle = rgba(GILT_HI, 0.75);
      x.beginPath(); x.moveTo(ax, ay); x.lineTo(ax + 2.5, ay - 2.5); x.stroke();
      // tiny dot at the tip
      x.fillStyle = rgba(GILT_HI, 0.85);
      x.beginPath(); x.arc(ax + 2.5, ay - 2.5, 0.9, 0, TAU); x.fill();
    }
  }

  // ---- C16: richest / poorest node markers ----
  const totals = state.econTotals;
  if (totals && LVQ.tier === 0) {
    const markNode = (id, col) => {
      if (id == null) return;
      const n = nodeById(id);
      if (!n || n.kind !== 'live') return;
      const px = (n.animating && n._ax != null) ? n._ax : n.x;
      const py = (n.animating && n._ay != null) ? n._ay : n.y;
      const r = nodeR(n) + 5;
      x.strokeStyle = rgba(col, 0.6); x.lineWidth = 1.4;
      x.setLineDash([3, 2]);
      x.beginPath(); x.arc(px, py, r, 0, TAU); x.stroke();
      x.setLineDash([]);
    };
    markNode(totals.richestId, [200, 170, 40]);   // gold ring for richest
    markNode(totals.poorestId, [100, 100, 160]);   // cool ring for poorest
  }
}
