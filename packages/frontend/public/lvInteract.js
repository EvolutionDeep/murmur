// lvInteract.js — task 29 · Phase B created this as a SEAM; task 31 · Phase D filled C22 trade-arc hit
// detection; task 32 · Phase E fills C23 (wheel-zoom + pinch + drag-pan + the LOD ladder) and C24 (the
// search box + filter groups).
// Imported by lineageView.js with ?v= cache-buster (task 75).
//
// SEAM DISCIPLINE (task 29 · Phase B/C invariant, honoured here)
//   • This module NEVER imports lineageView.js (that would close a cycle). It reaches core two ways only:
//       – the camera singleton `cam` + the LV state (both from lvState.js), which core reads every frame;
//       – `LV.hooks.select`, the one-way callback core registers so a search-locate can open the focus panel.
//   • All drawing stays in core; this module owns INPUT (pointer / wheel / touch) + the DOM search-filter
//     widgets + the per-frame camera integration (lvInteractFrame, forwarded from the TOP of lvFrame, before
//     camApply — it advances cam, it does not draw, so it cannot miss the camera transform).
//
// PERF CONTRACT
//   lvInteractWheel / the pointer handlers are pure arithmetic — no DOM reads beyond one cached
//   getBoundingClientRect per gesture start, no layout thrash. Pointer-move deltas are COALESCED into
//   pendDx/pendDy and applied once per frame in lvInteractFrame (frame-rate throttled). The search box is
//   debounced ≥150 ms. A gesture sets LV.interacting, which makes core drop to the point-cloud LOD and skip
//   the static re-bake until the gesture settles (SETTLE_MS after the last input), so a zoom/pinch never
//   reallocates the offscreen mid-flight. No shadowBlur, no backdrop-filter, no .filter =.
import {
  cam, camClamp, camToWorld, camLod, LV,
  lvFilter, lvParseQuery, lvFilterRecompute, lvNodeVisible,
  lvTouchNote, lvNarrow,
} from './lvState.js?v=164';
import { clamp, $, houseOf } from './shared.js?v=164';
import { t as T } from './i18n.js?v=115';
// task 33 · C25 — the replay clock. lvTimeReplay never imports this module, so core → lvInteract →
// lvTimeReplay → lvState stays a one-way chain (no cycle).
import { lvReplayAdvance } from './lvTimeReplay.js?v=164';

// ================= tuning constants =================
const DRAG_THRESHOLD = 4;      // css px of travel before a press becomes a pan (below it, it's a tap)
const SETTLE_MS = 140;         // idle window after the last gesture input before we allow a crisp re-bake
const INERTIA_MIN = 0.08;      // css px/frame below which flick inertia is considered stopped
const INERTIA_DECAY = 0.90;    // per-frame inertia damping
const WHEEL_SCALE = 0.0015;    // wheel deltaY → exponential zoom factor
const SEARCH_DEBOUNCE_MS = 160; // ≥150 ms per the C24 contract
const FLY_MS = 560;            // search-locate camera flight duration

// ================= gesture state (module-private) =================
const pointers = new Map();    // pointerId → {x,y} (css px, canvas-relative)
let dragging = false, dragMoved = false;
let dragStart = { x: 0, y: 0 }, lastP = { x: 0, y: 0 };
let pinch = null;              // {d, cx, cy} while two pointers are down
let pendDx = 0, pendDy = 0;    // coalesced pan delta, drained once per frame
let velX = 0, velY = 0;        // flick velocity for inertia
let fly = null;                // {k0,x0,y0,k1,x1,y1,t0,dur} camera tween
let lastInput = 0;             // performance.now() of the last gesture input

// ================= camera maths =================
// Zoom about a fixed SCREEN point: keep the world point under (sx,sy) pinned while cam.k scales by `factor`.
function zoomAt(sx, sy, factor) {
  const w = camToWorld(sx, sy);              // world point under the cursor at the CURRENT cam
  cam.k = clamp(cam.k * factor, 0.4, 6);
  cam.x = sx - LV.W / 2 - cam.k * (w.x - LV.W / 2);
  cam.y = sy - LV.H / 2 - cam.k * (w.y - LV.H / 2);
  camClamp();
}
function gesture() { lastInput = performance.now(); LV.interacting = true; }

/** Fly the camera to an absolute {k,x,y} over `dur` ms (ease-out cubic, integrated in lvInteractFrame). */
export function lvFlyTo(k, x, y, dur) {
  fly = { k0: cam.k, x0: cam.x, y0: cam.y, k1: clamp(k, 0.4, 6), x1: x, y1: y, t0: performance.now(), dur: dur || FLY_MS };
  LV.interacting = true;
}
/** Centre the viewport on a node's (possibly animating) position and fly to zoom `k`. Marks it as the search hit. */
export function lvCenterOnNode(n, k, dur) {
  if (!n) return;
  const kk = clamp(k || 2.4, 0.4, 6);
  const wx = (n.animating && n._ax != null) ? n._ax : n.x;
  const wy = (n.animating && n._ay != null) ? n._ay : n.y;
  lvFlyTo(kk, kk * (LV.W / 2 - wx), kk * (LV.H / 2 - wy), dur);
  LV.searchUid = n.uid;
}

/**
 * Wheel zoom. Bound by lvInteractBind as a passive:false listener; returning true tells the caller to
 * preventDefault() (the atlas swallows the wheel and the page does NOT scroll). Normalises deltaMode so a
 * line-based wheel (deltaMode 1) and a page-based wheel (deltaMode 2) zoom at a comparable rate to a pixel
 * wheel (deltaMode 0).
 * @param {WheelEvent} ev
 * @returns {boolean} true when the event was consumed
 */
export function lvInteractWheel(ev) {
  if (!LV.active || !cam || !LV.cv) return false;
  const r = LV.cv.getBoundingClientRect();
  const sx = ev.clientX - r.left, sy = ev.clientY - r.top;
  const dy = ev.deltaMode === 1 ? ev.deltaY * 16 : ev.deltaMode === 2 ? ev.deltaY * LV.H : ev.deltaY;
  fly = null;                                  // a wheel interrupts any in-flight search flight
  zoomAt(sx, sy, Math.exp(-dy * WHEEL_SCALE));
  gesture();
  return true;
}

/**
 * Per-frame camera integration. Forwarded from the TOP of lineageView.lvFrame — BEFORE camApply — because it
 * only mutates cam (it never draws), so it cannot miss the camera transform. Advances the fly tween, drains
 * the coalesced pan delta, runs flick inertia, and manages the interacting→settle→re-bake lifecycle.
 *
 * task 33 · C25 — this is now a two-call wrapper. The camera step keeps its original body verbatim; the
 * replay clock is appended AFTER it (and still before camApply) because it is the same class of work: it only
 * mutates state and never draws, and it must read the FINAL LV.interacting the camera step just resolved so a
 * drag/pinch/wheel freezes the playback clock instead of fighting it. Hanging it here rather than in lvFrame
 * honours the seam contract (core gains no new call point) and keeps it running at lod0, where the fly tween's
 * early return would otherwise skip a frame of playback.
 * @param {number} now  the rAF timestamp (performance.now() based)
 */
export function lvInteractFrame(now) {
  lvInteractStep(now);
  lvReplayAdvance(now);
}

function lvInteractStep(now) {
  // 1) search-locate / programmatic flight
  if (fly) {
    const p = clamp((now - fly.t0) / fly.dur, 0, 1);
    const e = 1 - Math.pow(1 - p, 3);          // ease-out cubic
    cam.k = fly.k0 + (fly.k1 - fly.k0) * e;
    cam.x = fly.x0 + (fly.x1 - fly.x0) * e;
    cam.y = fly.y0 + (fly.y1 - fly.y0) * e;
    camClamp();
    LV.interacting = true; LV.lod = 0;         // point cloud while flying
    if (p >= 1) { fly = null; LV.staticKey = ''; lastInput = now; }
    return;
  }
  // 2) coalesced pan (drag / pinch), applied once per frame
  if (pendDx || pendDy) { cam.x += pendDx; cam.y += pendDy; pendDx = 0; pendDy = 0; camClamp(); lastInput = now; }
  // 3) flick inertia after a drag release
  if (!dragging && (Math.abs(velX) > INERTIA_MIN || Math.abs(velY) > INERTIA_MIN)) {
    cam.x += velX; cam.y += velY; velX *= INERTIA_DECAY; velY *= INERTIA_DECAY; camClamp();
    LV.interacting = true; lastInput = now;
  } else if (!dragging) { velX = 0; velY = 0; }
  // 4) settle: nothing active + idle for SETTLE_MS → drop interacting and force ONE crisp re-bake at rest
  const active = dragging || pinch || fly || Math.abs(velX) > INERTIA_MIN || Math.abs(velY) > INERTIA_MIN;
  if (!active && LV.interacting && now - lastInput > SETTLE_MS) { LV.interacting = false; LV.staticKey = ''; }
  LV.lod = LV.interacting ? 0 : camLod();
}

// ================= pointer / touch binding (drag-pan + pinch-zoom + tap-select + hover) =================
/**
 * Bind every canvas input gesture. Called once from lineageView.initLineageView (the init/open path is where
 * event binding belongs — it is NOT a per-frame draw call point). Core passes the tap/hover callbacks so the
 * selection logic (hitTest → selectNode, trade-arc hit → evidence panel, empty → dismiss) stays in core.
 * @param {HTMLCanvasElement} cv
 * @param {{onTap?:(x:number,y:number)=>void, onHover?:(x:number,y:number)=>void}} opts
 */
export function lvInteractBind(cv, opts) {
  if (!cv) return;
  const onTap = opts && opts.onTap, onHover = opts && opts.onHover;
  const toLocal = (ev) => { const r = cv.getBoundingClientRect(); return { x: ev.clientX - r.left, y: ev.clientY - r.top }; };

  cv.addEventListener('pointerdown', (ev) => {
    // task 33 · C26 — a live pointer event beats any media query: a hybrid laptop with a fine primary pointer
    // reports `(pointer: coarse)` false, yet the moment a finger lands the hit-test forgiveness has to widen.
    // lvTouchNote upgrades (never downgrades) the pad used by core's hitTest from that frame on.
    lvTouchNote(ev.pointerType);
    if (ev.pointerType === 'mouse' && ev.button !== 0) return;   // ignore right/middle click
    try { cv.setPointerCapture(ev.pointerId); } catch { /* capture is a nicety */ }
    const p = toLocal(ev);
    pointers.set(ev.pointerId, p);
    if (pointers.size === 1) {
      dragging = true; dragMoved = false; dragStart = p; lastP = p; velX = 0; velY = 0; fly = null; pinch = null;
    } else if (pointers.size === 2) {
      dragging = false; startPinch();
    }
  });

  cv.addEventListener('pointermove', (ev) => {
    if (!pointers.has(ev.pointerId)) {
      // no button down → hover (only while idle, so a drag never fights the hover highlight)
      if (!dragging && pointers.size === 0 && onHover) { const p = toLocal(ev); onHover(p.x, p.y); }
      return;
    }
    const p = toLocal(ev); pointers.set(ev.pointerId, p);
    if (pointers.size >= 2) { updatePinch(); return; }
    if (dragging) {
      const dx = p.x - lastP.x, dy = p.y - lastP.y;
      if (!dragMoved && Math.hypot(p.x - dragStart.x, p.y - dragStart.y) > DRAG_THRESHOLD) dragMoved = true;
      if (dragMoved) { pendDx += dx; pendDy += dy; velX = dx; velY = dy; gesture(); }
      lastP = p;
    }
  });

  const endPointer = (ev) => {
    if (!pointers.has(ev.pointerId)) return;
    pointers.delete(ev.pointerId);
    try { cv.releasePointerCapture(ev.pointerId); } catch { /* ignore */ }
    if (pointers.size < 2) pinch = null;
    if (pointers.size === 0) {
      // a press that never crossed the drag threshold is a TAP → let core run selection
      if (dragging && !dragMoved && onTap) { const p = toLocal(ev); onTap(p.x, p.y); }
      dragging = false;                        // inertia (velX/velY) continues in lvInteractFrame
      lastInput = performance.now();
    } else if (pointers.size === 1) {
      // pinch → single finger: resume panning from the surviving pointer without a jump
      const rem = pointers.values().next().value; if (rem) { lastP = rem; dragging = true; dragMoved = true; }
    }
  };
  cv.addEventListener('pointerup', endPointer);
  cv.addEventListener('pointercancel', endPointer);
  // passive:false so lvInteractWheel can preventDefault the page scroll while zooming the atlas
  cv.addEventListener('wheel', (ev) => { if (lvInteractWheel(ev)) ev.preventDefault(); }, { passive: false });
}

function startPinch() {
  const pts = Array.from(pointers.values());
  if (pts.length < 2) return;
  const d = Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y) || 1;
  pinch = { d, cx: (pts[0].x + pts[1].x) / 2, cy: (pts[0].y + pts[1].y) / 2 };
}
function updatePinch() {
  if (!pinch) return;
  const pts = Array.from(pointers.values());
  if (pts.length < 2) return;
  const d = Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y) || 1;
  const cx = (pts[0].x + pts[1].x) / 2, cy = (pts[0].y + pts[1].y) / 2;
  zoomAt(cx, cy, d / pinch.d);                 // incremental zoom about the moving pinch centre
  pendDx += cx - pinch.cx; pendDy += cy - pinch.cy;   // two-finger pan
  pinch.d = d; pinch.cx = cx; pinch.cy = cy;
  gesture();
}

// ================= C24: search + filter widgets =================
let siEl = null, debounceT = null, filterDebounceT = null;

/** Query-only hit test (ignores the filter groups) — used to pick the search-locate target. */
function queryHit(n) {
  const f = lvFilter;
  if (!f.q || !n || n.ghost === true) return false;
  if (f.qId != null && n.id != null && n.id === f.qId) return true;
  if (f.qGen != null && (n.gen | 0) === f.qGen) return true;
  if (f.qHex) { const h = (n.hash || (n.entry && n.entry.genomeHash) || '').toLowerCase().replace(/^0x/, ''); if (h && h.indexOf(f.qHex) === 0) return true; }
  if (f.qHouse) { const hn = (n.houseName || '').toLowerCase(); if (hn && hn.indexOf(f.qHouse) >= 0) return true; }
  return false;
}
/** Best locate target: a matching LIVE node if any, else the first matching node. */
function bestMatch() {
  let first = null, firstLive = null;
  for (const n of LV.nodes.values()) {
    if (!queryHit(n)) continue;
    if (!first) first = n;
    if (n.kind === 'live') { firstLive = n; break; }
  }
  return firstLive || first;
}
function numOrNull(v) { if (v == null) return null; const s = String(v).trim(); if (!s) return null; const n = Number(s); return Number.isFinite(n) ? n : null; }

/** Recompute matchCount and paint the two status readouts (search box + filter panel footer). */
function recount() {
  let count = 0;
  for (const n of LV.nodes.values()) {
    if (n.ghost === true) continue;
    if (lvFilter.q ? queryHit(n) : lvNodeVisible(n)) count++;
  }
  lvFilter.matchCount = count;
  const sStat = $('lv-search-status'), fStat = $('lv-fl-count');
  let txt = '';
  if (lvFilter.q) txt = count > 0 ? T('lv.searchHits', { n: count }) : T('lv.searchNone');
  else if (lvFilter.active) txt = T('lv.flCount', { n: count });
  if (sStat) sStat.textContent = txt;
  if (fStat) fStat.textContent = lvFilter.active ? T('lv.flCount', { n: count }) : '';
}

/** Apply the search box: parse, recompute the dim, and (optionally) fly to the best match. */
function applySearch(locate) {
  lvParseQuery(siEl ? siEl.value : '');
  lvFilterRecompute();
  recount();
  LV.staticKey = '';                            // force a re-bake so ancestor/tomb dimming updates
  if (locate && lvFilter.q) {
    const n = bestMatch();
    if (n) lvCenterOnNode(n, Math.max(cam.k, 2.4));
    else LV.searchUid = null;
  } else if (!lvFilter.q) LV.searchUid = null;
}
/** Read every filter widget into lvFilter, then recompute + re-bake. */
function readFilters() {
  lvFilter.genMin = numOrNull(($('lv-fl-genmin') || {}).value);
  lvFilter.genMax = numOrNull(($('lv-fl-genmax') || {}).value);
  lvFilter.house = ($('lv-fl-house') || {}).value || '';
  lvFilter.life = ($('lv-fl-life') || {}).value || 'all';
  lvFilter.balMin = numOrNull(($('lv-fl-balmin') || {}).value);
  lvFilter.balMax = numOrNull(($('lv-fl-balmax') || {}).value);
  lvFilter.op = ($('lv-fl-op') || {}).value || 'all';
  lvFilter.commit = ($('lv-fl-commit') || {}).value || 'all';
  lvFilterRecompute();
  recount();
  LV.staticKey = '';
}
function scheduleFilter() {
  if (filterDebounceT) clearTimeout(filterDebounceT);
  filterDebounceT = setTimeout(() => { filterDebounceT = null; readFilters(); }, SEARCH_DEBOUNCE_MS);
}
/** Reset every widget + the filter singleton back to inert defaults. */
export function lvFilterReset() {
  const ids = ['lv-fl-genmin', 'lv-fl-genmax', 'lv-fl-balmin', 'lv-fl-balmax'];
  for (const id of ids) { const el = $(id); if (el) el.value = ''; }
  const set = (id, v) => { const el = $(id); if (el) el.value = v; };
  set('lv-fl-house', ''); set('lv-fl-life', 'all'); set('lv-fl-op', 'all'); set('lv-fl-commit', 'all');
  if (siEl) siEl.value = '';
  lvFilter.genMin = lvFilter.genMax = lvFilter.balMin = lvFilter.balMax = null;
  lvFilter.house = ''; lvFilter.life = 'all'; lvFilter.op = 'all'; lvFilter.commit = 'all';
  lvParseQuery(''); lvFilterRecompute();
  LV.searchUid = null;
  recount(); LV.staticKey = '';
}
/** (Re)populate the house <select> from the live roster + node table. Called on open and on filter-panel toggle. */
export function lvPopulateHouses() {
  const sel = $('lv-fl-house'); if (!sel) return;
  const names = new Set();
  for (const ho of houseOf.values()) if (ho && ho.name) names.add(String(ho.name));
  for (const n of LV.nodes.values()) if (n.houseName) names.add(String(n.houseName));
  const cur = sel.value;
  const sorted = Array.from(names).sort((a, b) => a.localeCompare(b));
  sel.innerHTML = `<option value="">${T('lv.flAll')}</option>` + sorted.map((h) => `<option value="${h.toLowerCase()}">${h}</option>`).join('');
  if (cur && names.has(cur)) sel.value = cur;
}
/** Toggle the filter popover; refresh the house list when it opens. Returns the new open state. */
export function lvToggleFilters() {
  const p = $('lv-filters'); if (!p) return false;
  const open = p.hidden;                         // it was hidden ⇒ we are opening it
  p.hidden = !open;
  const btn = document.querySelector('#lv-toolbar .lv-tb[data-lv="filter"]');
  if (btn) { btn.setAttribute('aria-expanded', open ? 'true' : 'false'); btn.setAttribute('aria-pressed', open ? 'true' : 'false'); }
  if (open) lvPopulateHouses();
  return open;
}

/**
 * Wire the search box + filter widgets. Called once from lineageView.initLineageView (after the DOM exists).
 * Handles the pointer-events / keydown conflicts called out in the C24 contract: the input lives in
 * #lv-toolbar (pointer-events:auto, a sibling ABOVE the canvas), so a click never reaches the canvas
 * pointerdown; and every keydown inside the input is stopPropagation'd so the document-level Escape handler
 * (which would otherwise close the whole atlas) never fires while the reader is typing.
 */
export function lvBindSearchFilter() {
  siEl = $('lv-search');
  if (siEl) {
    siEl.addEventListener('input', () => { if (debounceT) clearTimeout(debounceT); debounceT = setTimeout(() => { debounceT = null; applySearch(true); }, SEARCH_DEBOUNCE_MS); });
    siEl.addEventListener('keydown', (ev) => {
      ev.stopPropagation();                      // never leak a keystroke to a global shortcut / Escape-close
      if (ev.key === 'Escape') { ev.preventDefault(); if (debounceT) { clearTimeout(debounceT); debounceT = null; } applySearch(false); siEl.blur(); }
      else if (ev.key === 'Enter') { ev.preventDefault(); if (debounceT) { clearTimeout(debounceT); debounceT = null; } applySearch(true); const n = bestMatch(); if (n && typeof LV.hooks.select === 'function') LV.hooks.select(n); }
    });
  }
  const panel = $('lv-filters');
  if (panel) {
    panel.addEventListener('input', scheduleFilter);
    panel.addEventListener('change', scheduleFilter);
    // stop clicks/keys inside the popover from bubbling to the toolbar delegation or the canvas
    panel.addEventListener('keydown', (ev) => ev.stopPropagation());
    const reset = $('lv-fl-reset');
    if (reset) reset.addEventListener('click', (ev) => { ev.stopPropagation(); lvFilterReset(); });
  }
  lvParseQuery(''); lvFilterRecompute(); recount();
}

/** Re-localise the search/filter chrome on a language switch (called from lineageView.lvRelocalise). */
export function lvSearchRelocalise() {
  const si = $('lv-search'); if (si) si.setAttribute('placeholder', T('lv.searchPh'));
  lvPopulateHouses();
  recount();
}

// ================= C22: trade-arc hit detection (Phase D — unchanged) =================
// Coarse: bounding box of the quadratic bezier (endpoints + control point ± margin).
// Fine: sample 12 points along the bezier, return the closest within HIT_RADIUS.

const TRADE_HIT_RADIUS = 8;   // screen px forgiveness
const TRADE_HIT_SAMPLES = 12;

/**
 * Test whether a world-space point (wx, wy) hits any active trade arc.
 * Returns the trade-edge entry (with .constituents if available) or null.
 * @param {number} wx  world x
 * @param {number} wy  world y
 * @returns {object|null}  the hit trade edge, or null
 */
export function lvTradeHitTest(wx, wy) {
  if (!LV.active || !LV.showTrade) return null;
  let best = null, bestD = Infinity;
  const hr2 = TRADE_HIT_RADIUS * TRADE_HIT_RADIUS;

  for (const [, e] of LV.tradeEdges) {
    if (!e.geo) continue;
    const g = e.geo;
    // ---- coarse: bounding box of quadratic bezier ----
    const minX = Math.min(g.ax, g.bx, g.cx) - TRADE_HIT_RADIUS;
    const maxX = Math.max(g.ax, g.bx, g.cx) + TRADE_HIT_RADIUS;
    const minY = Math.min(g.ay, g.by, g.cy) - TRADE_HIT_RADIUS;
    const maxY = Math.max(g.ay, g.by, g.cy) + TRADE_HIT_RADIUS;
    if (wx < minX || wx > maxX || wy < minY || wy > maxY) continue;

    // ---- fine: sample points along the bezier ----
    for (let i = 0; i <= TRADE_HIT_SAMPLES; i++) {
      const t = i / TRADE_HIT_SAMPLES;
      const u = 1 - t;
      const px = u * u * g.ax + 2 * u * t * g.cx + t * t * g.bx;
      const py = u * u * g.ay + 2 * u * t * g.cy + t * t * g.by;
      const d = (px - wx) * (px - wx) + (py - wy) * (py - wy);
      if (d < bestD) { bestD = d; best = e; }
    }
  }
  return (best && bestD <= hr2) ? best : null;
}

/**
 * Convert a screen-space pointer event to world space and test trade arcs.
 * @param {number} sx  screen x (relative to canvas)
 * @param {number} sy  screen y (relative to canvas)
 * @returns {object|null}
 */
export function lvTradeHitScreen(sx, sy) {
  const p = camToWorld(sx, sy);
  return lvTradeHitTest(p.x, p.y);
}

// ================= task 33 · C26: mobile adaptation =================
// Three phone-sized problems, all of them DOM (nothing here draws, nothing here touches cam):
//   1. `#lv-legend` used to be `display:none` under 680px — a phone reader got NO key at all, so the coloured
//      discs and dashed rings on the canvas were unreadable. It is now a foldable chip: the title row always
//      shows and carries a chevron toggle, the rest lives in `.lv-lg-body`. styles.css keeps it on screen at
//      every width (it is simply folded by default when the viewport is narrow).
//   2. `#lv-panel` is a 54vh bottom drawer holding five header+body sections. On a phone that is a scroll
//      marathon, so each section becomes a collapsible segment; narrow viewports start with only the first
//      one open. The id line (`.lv-p-head`) and the provenance strip (`.lv-p-prov`) are NEVER folded — they
//      are the reader's bearings.
//   3. The fold choices have to survive a re-render (the panel is rebuilt from innerHTML on every selection),
//      so both fold states live in module-level maps rather than in the DOM.
let mbBound = false;           // lvBindMobile is one-shot
let lgUser = null;             // null ⇒ follow the narrow-viewport default; otherwise the reader's choice
let lgNarrow = null;           // the last lvNarrow() answer lvMobileSync saw
const segFold = new Map();     // `${hostId}:${i}` → folded?
function lgFoldNow() { return lgUser == null ? lvNarrow() : lgUser; }
function segKey(host, i) { return `${(host && host.id) || 'lv-panel'}:${i}`; }

/** Re-apply the legend fold state (class + chevron + aria) after core rewrites `#lv-legend`'s innerHTML. */
export function lvLegendSync() {
  const host = $('lv-legend'); if (!host) return;
  const f = lgFoldNow();
  host.classList.toggle('lv-fold', f);
  const b = host.querySelector('[data-lv-lg="fold"]');
  if (b) {
    b.textContent = f ? '\u25b8' : '\u25be';   // ▸ folded / ▾ open — language-neutral, keeps the chip narrow
    b.setAttribute('aria-expanded', f ? 'false' : 'true');
    b.setAttribute('aria-label', T('lv.lgFoldAria'));
    b.setAttribute('title', f ? T('lv.lgShow') : T('lv.lgHide'));
  }
}

/**
 * Group each top-level `.lv-p-sec` header with the siblings that follow it into a collapsible `.lv-p-seg`.
 * Called by core right after it writes the panel's innerHTML (buildFocusSkeleton / showEvidencePanel), so it
 * is idempotent by construction: a fresh innerHTML has no `.lv-p-seg` yet. `.lv-p-gen` (the genetics block,
 * which carries its own nested headers) is a BODY, so it gets a synthesised header of its own.
 * @param {HTMLElement} host  the panel element (`#lv-panel`)
 */
export function lvPanelSegment(host) {
  if (!host || host.querySelector('.lv-p-seg')) return;
  const kids = Array.from(host.children);
  if (!kids.length) return;
  const segs = [];                                  // [{head, body:[el]}]
  let cur = null;
  for (const el of kids) {
    const cl = el.classList;
    if (cl.contains('lv-p-head') || cl.contains('lv-p-prov')) { cur = null; continue; }   // always visible
    if (cl.contains('lv-p-sec')) { cur = { head: el, body: [] }; segs.push(cur); continue; }
    if (cl.contains('lv-p-gen')) {
      const head = document.createElement('div');
      head.className = 'lv-p-sec lv-p-seg-h';
      head.textContent = T('lv.genomeHash');        // existing 7-language key, no placeholder
      cur = { head, body: [el] }; segs.push(cur); continue;
    }
    if (cur) cur.body.push(el);
  }
  if (segs.length < 2) return;                      // nothing worth folding — leave the DOM exactly as built
  const foldDefault = lvNarrow();
  for (let i = 0; i < segs.length; i++) {
    const s = segs[i];
    const seg = document.createElement('div');
    seg.className = 'lv-p-seg';
    seg.dataset.segIx = String(i);
    s.head.classList.add('lv-p-seg-h');
    s.head.setAttribute('role', 'button');
    s.head.setAttribute('tabindex', '0');
    seg.appendChild(s.head);
    for (const b of s.body) seg.appendChild(b);      // appendChild MOVES: order is preserved by construction
    host.appendChild(seg);
    // a narrow viewport opens only the first segment; a desktop opens all of them (the drawer is roomy and
    // the reader can always fold what they do not want). segFold persists the choice across re-renders.
    if (!segFold.has(segKey(host, i))) segFold.set(segKey(host, i), foldDefault && i > 0);
    segSync(host, seg, i);
  }
}
function segSync(host, seg, i) {
  const f = !!segFold.get(segKey(host, i));
  seg.classList.toggle('lv-p-seg-fold', f);
  const h = seg.firstElementChild;
  if (!h) return;
  h.setAttribute('aria-expanded', f ? 'false' : 'true');
  h.setAttribute('title', f ? T('lv.pSegExpand') : T('lv.pSegCollapse'));
  // aria-label REPLACES the element's own text for assistive tech, so a bare "toggle section" would hide the
  // section's name. Compose it: "layers — toggle section". Rebuilt here (not only at build time) so a language
  // switch re-localises the existing segments too.
  const nm = (h.textContent || '').trim();
  h.setAttribute('aria-label', nm ? `${nm} \u2014 ${T('lv.pSegAria')}` : T('lv.pSegAria'));
}
function segToggle(host, head) {
  const seg = head && head.parentElement;
  if (!seg || !seg.classList.contains('lv-p-seg')) return;
  const i = Number(seg.dataset.segIx || 0);
  const k = segKey(host, i);
  segFold.set(k, !segFold.get(k));
  segSync(host, seg, i);
}

/**
 * One-shot wiring for the mobile chrome. Called from lineageView.initLineageView, BEFORE core registers its
 * own `#lv-panel` click delegation, so this handler runs first and yields to it: anything carrying
 * `[data-lv-p]` (close / verify) or an interactive descendant is left untouched.
 */
export function lvBindMobile() {
  if (mbBound) return;
  mbBound = true;
  const lg = $('lv-legend');
  if (lg) lg.addEventListener('click', (ev) => {
    const b = ev.target.closest && ev.target.closest('[data-lv-lg="fold"]');
    if (!b) return;
    ev.stopPropagation();                          // #lv-ui never closes the atlas on a legend tap
    lgUser = !lgFoldNow();
    lvLegendSync();
  });
  const panel = $('lv-panel');
  if (panel) {
    panel.addEventListener('click', (ev) => {
      const g = ev.target.closest && ev.target.closest.bind(ev.target);
      if (!g) return;
      if (g('[data-lv-p]') || g('.lv-crumb') || g('a, button, input, select, textarea')) return;
      const h = g('.lv-p-seg-h');
      if (h) segToggle(panel, h);
    });
    panel.addEventListener('keydown', (ev) => {
      ev.stopPropagation();                        // never leak to a global shortcut / Escape-close
      const h = ev.target.closest && ev.target.closest('.lv-p-seg-h');
      if (!h) return;
      if (ev.key === 'Enter' || ev.key === ' ' || ev.key === 'Spacebar') { ev.preventDefault(); segToggle(panel, h); }
    });
  }
  lvLegendSync();
}

/**
 * Re-read the narrow-viewport default. Called on open and on window resize (the mobile soft keyboard changes
 * innerHeight, so this genuinely moves mid-session). Crossing the breakpoint discards the reader's explicit
 * choices and re-seeds from the new default — a landscape→portrait rotation should behave like a fresh open.
 */
export function lvMobileSync() {
  const nw = lvNarrow();
  if (nw !== lgNarrow) { lgNarrow = nw; lgUser = null; segFold.clear(); }
  lvLegendSync();
  const panel = $('lv-panel');
  if (panel) for (const seg of panel.querySelectorAll('.lv-p-seg')) segSync(panel, seg, Number(seg.dataset.segIx || 0));
}
/** Re-localise the mobile chrome on a language switch (called from lineageView.lvRelocalise). */
export function lvMobileRelocalise() { lvMobileSync(); }

