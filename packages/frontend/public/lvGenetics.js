// lvGenetics.js — task 30 · Phase C: genetics graph completion (C9), bloodline trace (C10),
// and genotype space visualization (C11).
// Imported by lineageView.js with ?v= cache-buster (task 75).
//
// FILLED CONTENT (Phase C — C9, C10, C11)
//   C9  genetics graph: cross recombination edges (~29), operator-differentiated node shapes
//       (genesis=square, mutate=circle, cross=diamond), generation depth scale + histogram
//   C10 bloodline trace: ancestry highlight chain + descendant subtree highlight + breadcrumbs,
//       on-demand /lineage/:hash fetch (~1.5KB), in-flight mutex + cache
//   C11 genotype space: node size by genome neuronCount, hue by density × threshGain 2D mapping,
//       panel structural-spec section, graceful fallback for missing gain fields (8-11/139)
//
// PERF CONTRACT
//   lvGeneticsPass runs INSIDE rebuild(), floored at LV_REBUILD_MIN_MS (12 s). It annotates nodes but
//   MUST NOT move them. Anything O(n²) over genomes must be memoised. No shadowBlur, no backdrop-filter.
//   The per-frame draw (lvGeneticsFrame) consults LVQ.tier before drawing expensive layers.
import { LV, LVQ, LV_HUD, nodeR, ringRadius } from './lvState.js?v=159';
import { state, clamp, mix, rgb, rgba, TAU, INK, GILT, GILT_HI, fnv1a } from './shared.js?v=159';
import { t as T } from './i18n.js?v=112';
import { getJSON } from './polling.js?v=159';

// ================= C9: cross recombination edges + operator shapes =================
// After rebuild, traverse all nodes' parents to find secondary (non-paternal) edges.
// The primary edge (parents[0] → child) is already drawn by the core's lineage-edge pass.
// C9 adds the SECOND parent edge for cross operations (recombination).
let crossEdges = [];       // [{a: uid, b: uid}] — the secondary parent → child links
let genHistogram = [];     // [{gen, count}] for the depth histogram
let opShapes = new Map();  // uid → 'square'|'circle'|'diamond'

function buildCrossEdges() {
  crossEdges = [];
  const genCounts = new Map();
  for (const [uid, n] of LV.nodes) {
    if (!n.entry) continue;
    const e = n.entry;
    // generation histogram
    const g = e.generation | 0;
    genCounts.set(g, (genCounts.get(g) || 0) + 1);
    // operator shape
    const op = e.op || 'genesis';
    opShapes.set(uid, op === 'genesis' ? 'square' : op === 'mutate' ? 'circle' : 'diamond');
    // cross edges: second parent
    if (op === 'cross' && Array.isArray(e.parents) && e.parents.length >= 2) {
      const p2 = String(e.parents[1]).toLowerCase();
      if (p2 && LV.nodes.has(p2)) {
        crossEdges.push({ a: p2, b: uid });
      }
    }
  }
  // build histogram array sorted by generation
  genHistogram = [];
  const gens = Array.from(genCounts.keys()).sort((a, b) => a - b);
  for (const g of gens) genHistogram.push({ gen: g, count: genCounts.get(g) });
}

// ================= C11: genotype space attributes =================
// Compute per-node genome metrics: neuronCount (size), density×threshGain (hue)
function annotateGenotype() {
  for (const [uid, n] of LV.nodes) {
    if (!n.entry || !n.entry.genome) { n._genoSize = null; n._genoHue = null; continue; }
    const g = n.entry.genome;
    // neuronCount from genome layer sizes (motor has 5 channels)
    const nc = (g.nSensory || 0) + (g.nInterL1 || 0) + (g.nInterL2 || 0) + (g.nModulatory || 0) + (g.nMotorPerChannel || 0) * 5;
    n._genoSize = nc > 0 ? nc : null;
    // density × threshGain → hue (0..1 mapped to a warm-cool spectrum)
    const density = typeof g.density === 'number' ? g.density : 0.02;
    const threshGain = typeof g.threshGain === 'number' ? g.threshGain : 1.0;  // graceful fallback
    const weightGain = typeof g.weightGain === 'number' ? g.weightGain : 1.0;
    // 2D mapping: density (x-axis) × threshGain (y-axis) → hue angle
    const dNorm = clamp((density - 0.001) / 0.05, 0, 1);       // density range ~0.001..0.05
    const tNorm = clamp((threshGain - 0.5) / 1.5, 0, 1);        // threshGain range ~0.5..2.0
    n._genoHue = (dNorm * 0.6 + tNorm * 0.4);                  // 0..1 hue parameter
    n._genoHasGain = typeof g.threshGain === 'number';          // flag for panel display
    n._genoDensity = density;
    n._genoThreshGain = threshGain;
    n._genoWeightGain = weightGain;
    n._genoTauGain = typeof g.tauGain === 'number' ? g.tauGain : null;
    n._genoJitter = typeof g.weightJitter === 'number' ? g.weightJitter : null;
  }
}

// ================= C10: bloodline trace =================
// On-demand /lineage/:hash fetch with in-flight mutex + cache
const lineageCache = new Map();   // hash → {entry, children, fertility, spec, at}
let lineageInFlight = null;       // hash currently being fetched
let traceAncestors = [];          // [{uid, gen}] highlighted ancestry chain
let traceDescendants = new Set(); // uids in the highlighted descendant subtree
let traceActive = false;          // whether a trace is currently displayed

/** Start a bloodline trace from a node. Fetches /lineage/:hash if not cached. */
export async function lvTraceStart(uid) {
  const n = LV.nodes.get(uid);
  if (!n || !n.hash) { lvTraceClear(); return; }
  traceActive = true;
  // walk up the ancestry chain from local data
  traceAncestors = [];
  let cur = n;
  let depth = 0;
  while (cur && depth < 20) {
    traceAncestors.push({ uid: cur.uid, gen: cur.gen });
    if (!cur.entry || !Array.isArray(cur.entry.parents) || !cur.entry.parents.length) break;
    const pH = String(cur.entry.parents[0]).toLowerCase();
    cur = LV.nodes.get(pH);
    depth++;
  }
  // walk down descendants from local data
  traceDescendants = new Set();
  const stack = [uid];
  while (stack.length) {
    const u = stack.pop();
    traceDescendants.add(u);
    for (const [cuid, cn] of LV.nodes) {
      if (!cn.entry || !Array.isArray(cn.entry.parents)) continue;
      for (const p of cn.entry.parents) {
        if (String(p).toLowerCase() === u) { stack.push(cuid); break; }
      }
    }
  }
  // fetch /lineage/:hash for additional data (children, fertility, spec)
  const hash = n.hash;
  if (!lineageCache.has(hash) && lineageInFlight !== hash) {
    lineageInFlight = hash;
    try {
      const d = await getJSON('/lineage/' + hash, 6000);
      if (d) lineageCache.set(hash, { ...d, at: Date.now() });
    } catch { /* best-effort */ }
    finally { lineageInFlight = null; }
  }
}

/** Clear the bloodline trace. */
export function lvTraceClear() {
  traceActive = false;
  traceAncestors = [];
  traceDescendants = new Set();
}

/** Check if a uid is in the current trace. */
export function lvIsTraced(uid) {
  if (!traceActive) return false;
  if (traceDescendants.has(uid)) return true;
  for (const a of traceAncestors) if (a.uid === uid) return true;
  return false;
}

/** Get ancestor breadcrumbs for panel display. */
export function lvTraceBreadcrumbs() {
  return traceAncestors.map(a => {
    const n = LV.nodes.get(a.uid);
    return { uid: a.uid, gen: a.gen, hash: n && n.hash ? n.hash.slice(0, 8) : '…', kind: n ? n.kind : 'ancestor' };
  });
}

/** Get cached lineage detail for a hash. */
export function lvLineageDetail(hash) {
  return lineageCache.get(hash) || null;
}

// ================= per-frame draw (C9 cross edges + C10 highlight + C11 coloring) =================
/**
 * Per-frame genetics overlay. Called from lvNeuralFrame (or directly from lineageView if preferred).
 * Draws cross edges, bloodline highlights, and genotype-colored halos.
 * @param {CanvasRenderingContext2D} x  already in world space
 * @param {number} now  rAF timestamp
 */
export function lvGeneticsFrame(x, now) {
  if (!LV.active || LVQ.tier >= 2) return;

  // C9 note: the cross (recombination) edges are STATIC geometry and are now drawn in lineageView.bakeStatic
  // (keyed by bakeSignature), not per frame — see the `xedges` block there. This frame pass only draws the
  // things that genuinely change between bakes: the C10 bloodline highlight and the C11 genotype tint.

  // C10: bloodline trace highlight
  if (traceActive && traceAncestors.length) {
    // ancestry chain: bright gold line
    x.lineWidth = 2;
    x.strokeStyle = rgba(GILT_HI, 0.7);
    x.beginPath();
    for (let i = 0; i < traceAncestors.length; i++) {
      const n = LV.nodes.get(traceAncestors[i].uid);
      if (!n) continue;
      if (i === 0) x.moveTo(n.x, n.y); else x.lineTo(n.x, n.y);
    }
    x.stroke();
    // descendant subtree: soft glow rings
    x.lineWidth = 1.2;
    for (const uid of traceDescendants) {
      const n = LV.nodes.get(uid);
      if (!n || n.kind === 'live') continue;   // live nodes already have their own highlight
      x.strokeStyle = rgba(GILT, 0.25);
      x.beginPath(); x.arc(n.x, n.y, nodeR(n) + 3, 0, TAU); x.stroke();
    }
  }

  // C11: genotype space coloring (subtle hue tint on ancestor/tomb nodes)
  if (LVQ.tier < 2) {
    for (const n of LV.nodes.values()) {
      if (n.kind === 'live' || n.ghost === true || n._genoHue == null) continue;
      const hue = n._genoHue;
      // map 0..1 to a warm(0)→cool(1) palette
      const col = mix([180, 130, 60], [60, 120, 160], hue);
      const r = nodeR(n);
      x.fillStyle = rgba(col, 0.12);
      x.beginPath(); x.arc(n.x, n.y, r + 1.5, 0, TAU); x.fill();
    }
  }
}

// ================= C9: generation depth scale + histogram (drawn in static bake area) =================
/**
 * Draw the generation depth scale (left margin) and histogram (bottom strip).
 * Called from the static bake or per-frame at tier 0.
 * @param {CanvasRenderingContext2D} x
 */
export function lvGeneticsScale(x) {
  if (!LV.active || LVQ.tier >= 1) return;
  const maxGen = LV.maxGen;
  if (maxGen <= 0) return;
  // task 42 · P0-C — both halves of C9 used to hard-code their corner: the ruler sat at x = 25..43, i.e.
  // entirely BEHIND #command-rail (56 px wide, 16–18 kpx² of lost ink), and the histogram at (W-126, H-64)
  // landed on top of the C14 20-min ribbon (3672 px²). Both boxes now come from lvState's safe-area solve:
  // `ruler` runs down the clear left gutter between the C17 tape and the C14 readout, `brTop` is the UPPER
  // of the two vertically stacked bottom-right slots (ribbon below), so they can never intersect again.
  const S = LV_HUD.scale || 1;

  // depth scale: vertical ruler in the left gutter showing ring → generation mapping
  const ru = LV_HUD.ruler;
  if (ru && ru.h > 24) {
    const scaleX = ru.x + 3 * S, scaleTop = ru.y, scaleBot = ru.y + ru.h;
    x.strokeStyle = rgba(INK, 0.18); x.lineWidth = 0.7;
    x.beginPath(); x.moveTo(scaleX, scaleTop); x.lineTo(scaleX, scaleBot); x.stroke();
    const step = Math.max(1, Math.floor(maxGen / 8));
    x.font = (7 * S).toFixed(1) + 'px "IBM Plex Mono", monospace';
    for (let g = 0; g <= maxGen; g += step) {
      const y = scaleTop + (scaleBot - scaleTop) * (g / maxGen);
      x.strokeStyle = rgba(INK, 0.15); x.lineWidth = 0.5;
      x.beginPath(); x.moveTo(scaleX - 3 * S, y); x.lineTo(scaleX + 3 * S, y); x.stroke();
      x.fillStyle = rgba(INK, 0.35);
      x.lineWidth = 1.5; x.strokeStyle = rgba([238, 231, 214], 0.7);
      x.strokeText(String(g), scaleX + 5 * S, y + 2.5 * S);
      x.fillText(String(g), scaleX + 5 * S, y + 2.5 * S);
    }
  }

  // histogram: small bar chart in the bottom-right UPPER slot (the C14 ribbon owns the slot below it)
  if (genHistogram.length < 2) return;
  const b = LV_HUD.brTop;
  if (!b || b.w < 8 || b.h < 8) return;
  const histX = b.x + 2 * S, histY = b.y + 2 * S;
  const histW = b.w - 4 * S, histH = b.h - 12 * S;
  const maxCount = Math.max(...genHistogram.map(h => h.count), 1);
  const barW = histW / genHistogram.length;
  x.fillStyle = rgba([238, 231, 214], 0.6);
  x.fillRect(b.x, b.y, b.w, b.h);
  x.strokeStyle = rgba(INK, 0.12); x.lineWidth = 0.5;
  x.strokeRect(b.x, b.y, b.w, b.h);
  for (let i = 0; i < genHistogram.length; i++) {
    const h = genHistogram[i];
    const bh = (h.count / maxCount) * histH;
    x.fillStyle = rgba(GILT, 0.45);
    x.fillRect(histX + i * barW, histY + histH - bh, Math.max(barW - 1, 0.5), bh);
  }
  // label
  x.font = (7 * S).toFixed(1) + 'px "IBM Plex Mono", monospace'; x.lineWidth = 1.5;
  x.strokeStyle = rgba([238, 231, 214], 0.8);
  const lbl = T('lv.genHist');
  x.strokeText(lbl, histX, histY + histH + 8 * S);
  x.fillStyle = rgba(INK, 0.45); x.fillText(lbl, histX, histY + histH + 8 * S);
}

// ================= C9: operator-differentiated node shapes for the bake =================
/**
 * Get the shape for a node based on its operator. Used by the static bake.
 * @returns {'square'|'circle'|'diamond'}
 */
export function lvNodeShape(uid) {
  return opShapes.get(uid) || 'circle';
}

/**
 * Get cross edges for the static bake.
 * @returns {Array<{a:string, b:string}>}
 */
export function lvCrossEdges() { return crossEdges; }

/** Get generation histogram data. */
export function lvGenHistogram() { return genHistogram; }

// ================= C11: panel structural spec section =================
/**
 * Build HTML for the genotype structural spec panel section.
 * @param {object} n  the focused node
 * @returns {string} HTML
 */
export function lvGenotypePanel(n) {
  if (!n || !n.entry || !n.entry.genome) return '';
  const g = n.entry.genome;
  const nc = (g.nSensory || 0) + (g.nInterL1 || 0) + (g.nInterL2 || 0) + (g.nModulatory || 0) + (g.nMotorPerChannel || 0) * 5;
  let html = `<div class="lv-p-sec">${T('lv.structSpec')}</div><div class="lv-geno-spec">`;
  html += `<div class="lv-prov-r"><span>${T('lv.neuronCount')}</span><b>${nc.toLocaleString()}</b></div>`;
  html += `<div class="lv-prov-r"><span>${T('lv.density')}</span><b>${(g.density || 0).toFixed(4)}</b></div>`;
  if (typeof g.threshGain === 'number') {
    html += `<div class="lv-prov-r"><span>${T('lv.threshGain')}</span><b>${g.threshGain.toFixed(3)}</b></div>`;
  }
  if (typeof g.weightGain === 'number') {
    html += `<div class="lv-prov-r"><span>${T('lv.weightGain')}</span><b>${g.weightGain.toFixed(3)}</b></div>`;
  }
  if (typeof g.tauGain === 'number') {
    html += `<div class="lv-prov-r"><span>${T('lv.tauGain')}</span><b>${g.tauGain.toFixed(3)}</b></div>`;
  }
  if (typeof g.weightJitter === 'number') {
    html += `<div class="lv-prov-r"><span>${T('lv.weightJitter')}</span><b>${g.weightJitter.toFixed(3)}</b></div>`;
  }
  if (!n._genoHasGain) {
    html += `<div class="lv-prov-r lv-geno-note"><span></span><b>${T('lv.gainMissing')}</b></div>`;
  }
  html += '</div>';
  return html;
}

// ================= C10: panel breadcrumb section =================
/**
 * Build HTML for the bloodline breadcrumb trail.
 * @param {object} n  the focused node
 * @returns {string} HTML
 */
export function lvBloodlinePanel(n) {
  if (!n || !traceActive) return '';
  const crumbs = lvTraceBreadcrumbs();
  if (!crumbs.length) return '';
  let html = `<div class="lv-p-sec">${T('lv.bloodline')}</div><div class="lv-breadcrumbs">`;
  for (let i = crumbs.length - 1; i >= 0; i--) {
    const c = crumbs[i];
    const isCurrent = (i === 0);
    html += `<span class="lv-crumb${isCurrent ? ' lv-crumb-cur' : ''}" data-uid="${c.uid}">` +
      `${T('lv.genShort', { n: c.gen })} · ${c.hash}</span>`;
    if (i > 0) html += '<span class="lv-crumb-sep">→</span>';
  }
  html += '</div>';
  // descendant count
  const desc = traceDescendants.size - 1;
  if (desc > 0) {
    html += `<div class="lv-prov-r"><span>${T('lv.descendants')}</span><b>${desc}</b></div>`;
  }
  // cached lineage detail
  const detail = n.hash ? lvLineageDetail(n.hash) : null;
  if (detail) {
    html += `<div class="lv-prov-r"><span>${T('lv.fertility')}</span><b>${detail.fertility || 0}</b></div>`;
  }
  return html;
}

// ================= the rebuild-time pass =================
/**
 * Post-layout genetics pass. Called at the END of lineageView.rebuild(), after every node has its final
 * {x,y,gen,kind,hash,entry}. It may attach derived attributes to nodes but MUST NOT move them.
 * @returns {number} how many nodes it annotated
 */
export function lvGeneticsPass() {
  if (!LV.nodes.size) return 0;
  if (LVQ.tier >= 3) return 0;
  buildCrossEdges();
  annotateGenotype();
  let annotated = 0;
  for (const n of LV.nodes.values()) if (n._genoHue != null) annotated++;
  return annotated;
}
