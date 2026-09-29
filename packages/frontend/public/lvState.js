// lvState.js — task 29 · Phase B: the shared substrate of the lineage-atlas module tree.
// Imported by lineageView.js / lvData.js / lv* feature modules with ?v= cache-buster (task 75).
//
// WHY THIS MODULE EXISTS
//   lineageView.js was split into a tree (core / lvData / lvNeural / lvGenetics / lvEnv / lvProvenance /
//   lvInteract). Every one of those modules needs the SAME singleton: the node table, the genome cache, the
//   social table, the camera, the quality gate. If each imported it from `lineageView.js` we would get an
//   import cycle (core → lvData → core). So the singleton and the pure helpers live HERE, at the bottom of
//   the tree: lvState.js imports nothing but shared.js, therefore it can never be part of a cycle.
//
// WHAT LIVES HERE
//   • LV          — the module-singleton (all atlas state, kept off shared.state to minimise the footprint)
//   • cam         — the world→screen transform (identity this phase; zoom/pan land in Phase E)
//   • LVQ         — the qualityCoeff-driven degradation gate (halo → particles → social → DPR)
//   • lvMarkDirty — the arrival-event dirty flags that replaced the old 45 s catch-all timer (task 29 · C5)
//   • geometry + localStorage helpers shared by the layout, the bake and the data layer
import { state, clamp, fnv1a } from './shared.js?v=158';

// ================= tuning constants =================
export const LINEAGE_POLL_MS = 300000;    // 300 s — /lineage advances only on a breed/commit, this is ample
export const PARTICLE_CAP = 240;          // hard cap on concurrent trade-flow particles (full-quality tier)
export const SOCIAL_HALFLIFE_MS = 300000; // 5 min half-life for the client-maintained social edge table
export const FOCUS_INTERVAL_MS = 1000;    // one /snapshot per second for the single focused fly
export const FOCUS_DEBOUNCE_MS = 150;     // collapse click-bursts into one neural read
export const GH_CONCURRENCY = 6;          // 6-way concurrent /flies/{id} genome resolution
export const LS_GH = 'lv.gh';             // localStorage: id → genome identity stamps (format __v:2)
export const LS_SOCIAL = 'lv.social';     // localStorage: the decayed social edge table
export const HIT_PAD = 4;                 // css px of forgiveness around a node's radius for hit-testing
// task 33 · C26 — a finger is not a mouse cursor. On a coarse pointer the 4 px forgiveness is far below the
// ~7 px average touch-landing error, so a tap between two adjacent generation-ring nodes picks the wrong one
// (or nothing at all). The pad is therefore RAISED to 14 px on touch devices — inside the 12–16 px band the
// mobile contract asks for, and still under the ~19 px ring spacing at cam.k = 1 so neighbours stay separable.
// HIT_PAD stays exported unchanged (it is the mouse value); readers call lvHitPad() instead of the constant.
export const HIT_PAD_TOUCH = 14;          // css px of forgiveness on a coarse (touch/pen) pointer
export const LV_TOUCH = { on: false, pad: HIT_PAD };
try { LV_TOUCH.on = !!(window.matchMedia && window.matchMedia('(pointer: coarse)').matches); } catch { /* no matchMedia */ }
LV_TOUCH.pad = LV_TOUCH.on ? HIT_PAD_TOUCH : HIT_PAD;
export const LAYERS = ['sensory', 'inter', 'modulatory', 'motor'];   // the 4 static neuronKinds values
export const GH_RETIRED_MAX = 400;        // bound on the dead-occupant identity table
export const GH_RETIRED_PER_ID = 3;       // how many successive occupants of one slot we remember

// task 29 · C1 — trade-edge emission. The old code emitted only while `now - e.t <= 6000`, i.e. a 6 s
// window refilled by a 45 s timer ⇒ a ~13 % duty cycle, so the arcs were empty most of the time. Emission
// now follows an exponential decay over the edge's whole lifetime and accumulation is arrival-driven.
export const EMIT_TAU_MS = 90000;         // e-folding time of an edge's emission probability
export const EDGE_TTL_MS = 240000;        // an edge with no traffic for 4 min leaves the budget entirely

// task 29 · C5 — layout rebuild floor. /population lands every ~5 s and marks the layout dirty; rebuilding
// on every arrival would re-run the 139-node placement 12×/min. The dirty flag is drained at most this
// often (births/deaths therefore surface within ≤12 s instead of the old ≤45 s), and a rebuild only
// RE-BAKES the static layer when the structural signature actually moved (see lineageView.bakeSignature).
export const LV_REBUILD_MIN_MS = 12000;

// ================= dirty flags (arrival events, not timers) =================
export const LV_DIRTY_FEED = 1;     // a trade feed landed: /economy.recent or /proofs
export const LV_DIRTY_SOCIAL = 2;   // a social feed landed: /economy.social or /annals
export const LV_DIRTY_LAYOUT = 4;   // membership / geometry may have moved: /population, /lineage, graves

// ================= module-singleton state =================
export const LV = {
  cv: null, ctx: null, W: 0, H: 0, DPR: 1,
  active: false, inited: false,
  // layout / data
  nodes: new Map(),        // uid → node {uid,id,gen,ang,rad,x,y,kind,hash,entry,grave,houseName,balN,…}
  pos: new Map(),          // uid → {ang,rad,gen,x,y}  (assigned ONCE, never moved — incremental stability)
  idToUid: new Map(),      // live flyId → uid (genomeHash once resolved, else `id:<flyId>`)
  edges: [],               // lineage edges [{a:uid,b:uid}] (parent → child)
  structSig: '',           // task 29 · C5: order-independent hash of {uid,kind,gen} + edges → gates the re-bake
  maxGen: 0,               // deepest generation in the current layout (drives the ring count + the legend)
  legendKey: '',           // last legend signature, so the DOM is only rewritten when a count actually moves
  // genome identity (task 29 · C4: the cache now carries an IDENTITY STAMP, not just a hash)
  ghCache: new Map(),      // flyId → genomeHash, for CURRENTLY LIVE occupants only
  ghMeta: new Map(),       // flyId → {seed, temper, at} — the stamp the hash was resolved against
  ghRetired: new Map(),    // flyId → [{h,temper,at}] — occupants that died while we were watching (grave join)
  ghStale: new Set(),      // flyIds whose stamp mismatched / matched no entry (refetch + recompute)
  ghInFlight: new Set(),   // flyIds with a /flies request outstanding
  // static bake
  staticOff: null, staticCtx: null, staticKey: '',
  // dynamic layers
  parts: [],               // trade-flow particles [{ax,ay,bx,by,cx,cy,p,sp,col,w}]
  tradeEdges: new Map(),   // `${from}>${to}>${good}` → {fromId,toId,good,amount,t,ax…cy,w,emitting}
  seenTrades: new Set(),   // dedup keys for settlements already accumulated
  social: new Map(),       // `${a}>${b}` → {a,b,sign,w,t}
  stain: new Map(),        // task 29 · C2: flyId → {id,sign,w,t} for single-actor chronicle events
  colonyPulse: { foe: 0, ally: 0, market: 0 },   // zero-actor (colony-wide) chronicle weight, decays
  chronSeq: 0,             // highest /annals seq already folded in (the chronicle is an event log)
  // layer toggles
  showShards: false, showSocial: true, showTrade: true,
  // focus
  focusUid: null, focusId: null, focusEntry: null, focusGrave: null,
  focusTimer: null, focusDebounce: null, focusCtrl: null, focusInFlight: false,
  layerIdx: null,          // cached {sensory:[…indices], inter:[…], …} parsed once from neuronKinds
  layerMeans: null,        // last reduced {sensory,inter,modulatory,motor} mean firing rate
  focusSnap: null,         // last /snapshot for the focused fly
  // pollers / pumps
  lineageTimer: null, lineageInFlight: false,
  dirty: 0, layoutDue: false, rebuildForced: false, lastRebuild: 0, lastPump: 0, qFrame: 0, dprDirty: false,
  // task 42 · P0-C — raised by lvHudObserve()'s ResizeObserver; drained in lvFrame before the bake so a
  // chrome reflow (language switch, legend fold, inspector panel) re-solves the safe area exactly once.
  hudDirty: false,
  // cross-module seams: core registers its layout entry point here so lvData can request a rebuild
  // without importing lineageView.js (which would close a cycle). task 32 · Phase E adds `select`, the
  // same one-way channel for lvInteract's search-locate to open the focus panel without importing core.
  hooks: { rebuild: null, select: null },
  // perf counters (surfaced on window.__murmurPerf)
  nodeCount: 0, edgeCount: 0, partCount: 0, liveCount: 0, ancCount: 0, tombCount: 0,
  socialCount: 0, stainCount: 0, staleCount: 0, rebakes: 0,
  // interaction
  hoverUid: null,
  // task 32 · Phase E — camera interaction state. `interacting` is true while a drag / pinch / wheel
  // gesture is live: lvFrame then drops to the point-cloud LOD and SKIPS the static re-bake (the offscreen
  // is only re-baked once the gesture settles, so a zoom never reallocates the backing store mid-flight).
  // `lod` is the resolved level-of-detail (0 far / 1 mid / 2 near); `searchUid` is the node the search box
  // last flew to (drawn with its own highlight ring, distinct from focus/hover).
  interacting: false, lod: 1, searchUid: null,
};

// ================= camera (task 29 · Phase B step 2) =================
// World coordinates ARE the atlas's own layout coordinates (the dendrogram is built around W/2,H/2), so the
// identity transform must be exactly `k=1, x=0, y=0`. cam.x/cam.y are a SCREEN-space pan offset and cam.k is
// a zoom about the viewport centre — which keeps every already-placed node coordinate valid while Phase E
// adds wheel-zoom / drag-pan without touching the layout maths.
export const cam = { k: 1, x: 0, y: 0 };
/** Put the 2D context into world space (DPR × cam). All atlas drawing happens under this transform. */
export function camApply(x) {
  const k = cam.k || 1;
  const tx = LV.W / 2 - (LV.W / 2) * k + cam.x;
  const ty = LV.H / 2 - (LV.H / 2) * k + cam.y;
  x.setTransform(LV.DPR * k, 0, 0, LV.DPR * k, LV.DPR * tx, LV.DPR * ty);
}
/** Put the 2D context back into plain screen space (DPR only) — used for the paper wash and any chrome. */
export function camIdentity(x) { x.setTransform(LV.DPR, 0, 0, LV.DPR, 0, 0); }
/** Screen (css px, relative to the canvas) → world. The inverse of camApply; used by hit-testing. */
export function camToWorld(sx, sy) {
  const k = cam.k || 1;
  return { x: (sx - cam.x - LV.W / 2) / k + LV.W / 2, y: (sy - cam.y - LV.H / 2) / k + LV.H / 2 };
}
export function camClamp() {
  if (!Number.isFinite(cam.k)) cam.k = 1;
  cam.k = clamp(cam.k, 0.4, 6);
  if (!Number.isFinite(cam.x)) cam.x = 0;
  if (!Number.isFinite(cam.y)) cam.y = 0;
}

// ================= task 32 · Phase E: level-of-detail + zoom-resolution bucket =================
// THREE LOD tiers keyed purely off cam.k (the layout is unchanged, we only shed/add detail):
//   lod 0 (k < 0.8)   far   — point cloud + generation rings only
//   lod 1 (0.8 ≤ k ≤ 2) mid  — + lineage edges, cross edges, trade arcs, house rings, social
//   lod 2 (k > 2)     near  — + node labels, neuromod halo, motor-channel rings
export function camLod() { const k = cam.k || 1; return k < 0.8 ? 0 : k <= 2 ? 1 : 2; }
// Zoom aliasing fix (Owen's known trap, resolved with option (a)): the static offscreen is baked at
// DPR × camKScale() so a zoomed-in blit is ~1:1 device pixels instead of an upscale. The scale is
// BUCKETED (steps of 0.5, then quantised to 0.25) so re-bakes are rare, and it is CAPPED by a pixel
// budget so a huge retina viewport never allocates a runaway backing store — past the cap we simply
// accept a touch of softness at extreme zoom rather than OOM the tab.
const CAM_BAKE_BUDGET = 20e6;   // max offscreen pixels (≈80 MB) before the resolution boost is capped
export function camKScale() {
  const k = cam.k || 1;
  if (k <= 1.02) return 1;
  let b = Math.min(2, Math.ceil(k * 2) / 2);            // 1.5 or 2 resolution buckets
  const base = LV.W * LV.DPR * LV.H * LV.DPR;
  if (base > 0) { const cap = Math.sqrt(CAM_BAKE_BUDGET / base); if (b > cap) b = cap; }
  return clamp(Math.round(b * 4) / 4, 1, 2);            // quantise to 0.25 so the signature is stable
}

// ================= quality gate (task 29 · Phase B step 2) =================
// main.js already glides state.qualityCoeff toward the frame-cost target every frame (EMA α=0.05, knee at
// the 16.67 ms budget) but the atlas never read it. It does now. The gate sheds the most expensive layer
// FIRST and always in the same order, so a slow machine degrades predictably instead of stuttering:
//
//   tier 0 (q > 0.70)  everything on, particle cap 240, full DPR
//   tier 1 (q > 0.46)  neuromod halos off (one extra filled arc per live node per frame), cap 120, DPR ≤1.5
//   tier 2 (q > 0.24)  social edges + chronicle marks off, cap 48, DPR ≤1.25
//   tier 3             trade underlines off, cap 16, DPR 1
//
// This is the safety gate the heavy Phase C-F layers (spike heat band, genotype space, environment field,
// replay scrubber) are required to consult before drawing anything expensive.
export const LVQ = { tier: 0, halo: true, social: true, marks: true, underlines: true, partCap: PARTICLE_CAP, dpr: 1 };
const LVQ_DPR = [0, 1.5, 1.25, 1];       // tier → DPR ceiling (tier 0 keeps the device DPR, capped at 2)
const LVQ_CAP = [PARTICLE_CAP, 120, 48, 16];
const LVQ_HYST = 20;                      // frames the coefficient must hold a new tier before we switch
let lvqPend = -1, lvqPendN = 0;
function lvqBaseDpr() { return Math.min(2, (typeof window !== 'undefined' && window.devicePixelRatio) || 1); }
LVQ.dpr = lvqBaseDpr();
export function lvUpdateQuality() {
  const q = clamp(Number.isFinite(state.qualityCoeff) ? state.qualityCoeff : 1, 0, 1);
  const want = q > 0.70 ? 0 : q > 0.46 ? 1 : q > 0.24 ? 2 : 3;
  // hysteresis: a single slow frame must not thrash the backing-store allocation
  if (want === LVQ.tier) { lvqPend = -1; lvqPendN = 0; }
  else if (want === lvqPend) { if (++lvqPendN < LVQ_HYST) return; }
  else { lvqPend = want; lvqPendN = 1; return; }
  lvqPend = -1; lvqPendN = 0;
  LVQ.tier = want;
  LVQ.halo = want === 0;
  LVQ.social = want < 2;
  LVQ.marks = want < 2;
  LVQ.underlines = want < 3;
  LVQ.partCap = LVQ_CAP[want];
  const dpr = want === 0 ? lvqBaseDpr() : Math.min(LVQ_DPR[want], lvqBaseDpr());
  if (Math.abs(dpr - LVQ.dpr) > 0.01) { LVQ.dpr = dpr; LV.dprDirty = true; }
  if (LV.parts.length > LVQ.partCap) LV.parts.length = LVQ.partCap;
}

// ================= dirty flags =================
/** Raise one or more LV_DIRTY_* bits. Called from economy.js / polling.js on DATA ARRIVAL, never on a timer. */
export function lvMarkDirty(bits) { LV.dirty |= bits | 0; }
/** Request the next layout rebuild immediately, bypassing the LV_REBUILD_MIN_MS floor (resize, refresh, open). */
export function lvForceRebuild() { LV.layoutDue = true; LV.rebuildForced = true; }

// ================= small shared helpers =================
export const isZeroHash = (h) => !h || typeof h !== 'string' || /^0x0+$/.test(h) || h === '';
/**
 * task 33 · C26 — the hit-test forgiveness for the CURRENT pointer class, in css px. A hybrid machine that
 * reports a fine primary pointer still upgrades the moment a finger actually lands (see lvTouchNote, called
 * from lvInteractBind's pointerdown), so the pad never has to guess from the media query alone.
 */
export function lvHitPad() { return LV_TOUCH.pad; }
/** Upgrade the pointer class from a live PointerEvent.pointerType ('touch' / 'pen' ⇒ coarse). Never downgrades. */
export function lvTouchNote(pointerType) {
  if (LV_TOUCH.on || (pointerType !== 'touch' && pointerType !== 'pen')) return;
  LV_TOUCH.on = true; LV_TOUCH.pad = HIT_PAD_TOUCH;
}
/**
 * task 33 · C26 — the atlas's own definition of "phone / short viewport", kept byte-identical to the
 * `@media (max-width: 680px), (max-height: 600px)` breakpoint in styles.css so the JS-driven defaults
 * (legend folded, panel segments collapsed) agree with the CSS-driven re-slotting. Read on demand: the
 * mobile soft keyboard changes innerHeight, so a cached answer would go stale mid-session.
 */
export function lvNarrow() { return (window.innerWidth || 0) <= 680 || (window.innerHeight || 0) <= 600; }
/** Node radius by kind. task 29 · A4-5 adds a committed-ancestor tier between a true ghost and a live fly. */
export function nodeR(n) {
  if (!n) return 0;
  if (n.ghost === true) return 2.2;                 // pass-2 ancestor that was never committed on chain
  if (n.kind === 'ancestor') return 2.6;            // committed genome, not currently alive
  if (n.kind === 'tomb') return 3.0;
  return 3.2 + (n.balN || 0.5) * 4.6;               // live: balance → body size
}
// ================= task 42 · P0-B / P0-C: chrome-aware HUD insets + tree safe area =================
// WHY THIS EXISTS
//   Every canvas-drawn corner widget used to hard-code its offset (24 / 26 px from the raw viewport edge),
//   which put the top pair UNDER the 94 %-opaque .topbar and the left generation ruler BEHIND #command-rail.
//   At the same time the dendrogram kept using min(W,H)*0.36 as its outer ring regardless of how much of the
//   viewport the toolbar / provenance bar / legend actually ate, so the tree bbox clipped into them.
//   This block measures the real DOM chrome once per geometry change and derives (a) the five corner widget
//   boxes + the ruler box in SCREEN space and (b) a safe outer ring radius for the tree.
//
// COORDINATE SYSTEMS
//   LV_HUD.* boxes are SCREEN space (drawn after camIdentity, they never move with the camera).
//   LV_LAYOUT.{cx,cy,r0,r1} is WORLD space (the tree). cx/cy stay pinned to the viewport centre on purpose:
//   cam (camApply/camToWorld) zooms about LV.W/2,LV.H/2, and lvTimeReplay's growth-horizon ring plus
//   lvNeural's holding-ring entry animation both re-derive the centre from LV.W/2,LV.H/2. Offsetting the
//   centre would desync all three, so the safe area is bought with r1 alone (measured cost ≤ 2 % on the
//   four tall viewports, ~22 % only on 1280×600 where the chrome stack genuinely leaves nothing else).
export const LV_HUD = {
  // measured chrome insets (screen px)
  top: 0,          // bottom edge of .topbar — the real one, NOT --topbar-total (regime E/G let it grow)
  left: 0,         // right edge of #command-rail (0 when the rail is display:none on phones)
  panelLeft: 0,    // left edge of #lv-panel (== LV.W while the inspector panel is hidden)
  pad: 14,         // resolved --pad
  x0: 10,          // left margin for the left widget column (clears the rail)
  m: 10,           // generic margin from a chrome edge
  // measured top stack
  tbH: 46,         // #lv-toolbar height (fed back into --lv-tb-h so #lv-prov-bar lands on its own row)
  tbBottom: 0,     // #lv-toolbar bottom edge
  stackBottom: 0,  // max(toolbar, prov-bar) bottom edge — nothing may start above this on the left column
  blTop: 0,        // top edge of the bottom-left DOM chrome (legend / capsule), == LV.H when none
  capH: 44,        // #switch-to-3d height (+8) so CSS can park the legend above it
  scale: 1,        // corner-widget size multiplier: bigger on tall desktops, ~0.9 on phones
  sig: '',         // measurement signature; unchanged ⇒ skip the solve (breaks the ResizeObserver loop)
  // resolved screen-space boxes (null ⇒ that widget has no room and must not be drawn)
  tl: null, tr: null, bl: null, brTop: null, brBot: null, ruler: null, pb: null, legend: null, capsule: null,
};
/** Tree safe area, world space. r0/r1 replace the old min(W,H)*0.075 / *0.36 constants. */
export const LV_LAYOUT = { cx: 0, cy: 0, r0: 0, r1: 0, top: 0, bottom: 0, left: 0, right: 0 };
export const LV_R0_K = 0.075;            // innermost ring as a fraction of min(W,H) (unchanged look)
export const LV_R1_K = 0.36;             // outermost ring as a fraction of min(W,H) (unchanged look)
const LV_GAP = 8;                        // required clearance between the tree bbox and any HUD element
const LV_R1_FLOOR = 24;                  // never collapse the dendrogram below this, whatever the chrome says
// Nominal (scale = 1) widget footprints, in screen px. Must stay in sync with the drawing code in
// lvEnv.js / lvGenetics.js, which sizes everything off these boxes.
const HUD_BOX = {
  tl:    { w: 120, h: 68 },   // C17 order-book tape        (top-left)
  tr:    { w: 110, h: 62 },   // C16 Gini histogram         (top-right)
  bl:    { w: 116, h: 36 },   // C14 derivation readout     (bottom-left, 3 × 11 px lines)
  brTop: { w: 104, h: 56 },   // C9 generation histogram    (bottom-right, upper slot)
  brBot: { w: 130, h: 36 },   // C14 20-min ribbon          (bottom-right, lower slot)
};
const HUD_KEYS = ['tl', 'tr', 'bl', 'brTop', 'brBot'];
let hudRO = null;

/** Rect of a DOM element, or null when it is not actually painted (hidden / zero-size). */
function hudRect(sel) {
  const el = typeof sel === 'string' ? document.querySelector(sel) : sel;
  if (!el || !el.getBoundingClientRect) return null;
  const cs = window.getComputedStyle(el);
  if (cs.display === 'none' || cs.visibility === 'hidden' || parseFloat(cs.opacity) < 0.02) return null;
  const r = el.getBoundingClientRect();
  if (!(r.width > 0.5) || !(r.height > 0.5)) return null;
  return r;
}
/** Resolved length of a custom property on :root, with a fallback when it is absent / unparseable. */
function hudCssPx(name, fb) {
  try {
    const v = parseFloat(window.getComputedStyle(document.documentElement).getPropertyValue(name));
    return Number.isFinite(v) ? v : fb;
  } catch { return fb; }
}

/**
 * Re-measure the DOM chrome and (when the signature moved) re-solve the safe area, re-place every node and
 * invalidate the static bake. Idempotent + cheap enough to call from sizeCanvas(), rebuild() and the
 * ResizeObserver drain in lvFrame.
 */
export function lvHudMeasure() {
  const W = LV.W || window.innerWidth || 0, H = LV.H || window.innerHeight || 0;
  if (!W || !H) return false;
  const hud = LV_HUD;

  const tb = hudRect('.topbar');
  const rail = hudRect('#command-rail');
  const panel = hudRect('#lv-panel');
  const legend = hudRect('#lv-legend');
  const caps = hudRect('#switch-to-3d');

  const top = tb ? Math.max(0, Math.round(tb.bottom)) : 0;
  const left = rail ? Math.max(0, Math.round(rail.right)) : 0;
  const panelLeft = panel ? Math.round(panel.left) : W;
  const pad = hudCssPx('--pad', 14);

  // Publish the measured insets as CSS vars FIRST so #lv-toolbar / #lv-prov-bar sit on the real topbar
  // bottom (regime E/G grow .topbar past --topbar-total, which is what caused the 9.2 px crush on 390×844).
  // Guarded writes: setProperty with an unchanged value still dirties style in some engines, and this runs
  // on every rebuild.
  const ui = document.getElementById('lv-ui');
  const setVar = (n, v) => { if (ui && ui.style && hud['_v' + n] !== v) { hud['_v' + n] = v; ui.style.setProperty('--lv-' + n, v + 'px'); } };
  setVar('top', top);
  setVar('rail-w', left);
  // One forced layout, then read the toolbar's real height and feed it back so the provenance bar can take
  // its own row underneath (P0-A). Re-read AFTER the var writes above: --lv-rail-w moves the toolbar's left
  // edge, which can change how it wraps and therefore its height. The --lv-tb-h write only moves the
  // provenance bar, never the toolbar, so this is not a feedback loop.
  const tbEl = document.getElementById('lv-toolbar');
  const tbR0 = tbEl ? tbEl.getBoundingClientRect() : null;
  const tbLive = !!(tbR0 && tbR0.height > 0.5);   // false while #lv-ui is hidden (atlas off stage)
  const tbH = tbLive ? Math.round(tbR0.height) : 46;
  setVar('tb-h', tbH);
  const tbR = tbLive ? tbEl.getBoundingClientRect() : null;
  const tbBottom = tbR ? Math.round(tbR.bottom) : top + 6 + tbH;
  const pb = hudRect('#lv-prov-bar');
  const stackBottom = Math.max(tbBottom, pb ? Math.round(pb.bottom) : 0);

  const capH = caps ? Math.round(caps.height) + 8 : 44;
  // Feed the real capsule height back so #lv-legend parks exactly one gutter above it (P1-E: at 390×844 the
  // legend and #switch-to-3d measured 2754 px² of mutual overlap and the fold button only hit 67.2 % of its
  // nine probe points). The CSS default in the #lv-ui token block is 44 px / 52 px on a coarse pointer,
  // which is what the capsule already is, so this write is normally a no-op and the setVar guard keeps it
  // from dirtying style — and from turning the legend's own bottom into a measure/resize feedback loop.
  setVar('cap-h', capH);
  const blTop = Math.min(legend ? legend.top : H, caps ? caps.top : H);
  const scale = clamp(Math.min(W, H) / 800, 0.9, 1.3);

  const sig = [W, H, top, left, panelLeft, pad, tbH, tbBottom, stackBottom, capH,
    Math.round(legend ? legend.top : -1), Math.round(legend ? legend.height : -1),
    Math.round(caps ? caps.top : -1), scale.toFixed(3)].join('|');
  if (sig === hud.sig) return false;
  hud.sig = sig;

  hud.top = top; hud.left = left; hud.panelLeft = panelLeft; hud.pad = pad;
  hud.tbH = tbH; hud.tbBottom = tbBottom; hud.stackBottom = stackBottom;
  hud.capH = capH; hud.blTop = blTop; hud.scale = scale;
  hud.m = Math.max(8, pad * 0.4);
  hud.x0 = left + Math.max(10, pad * 0.55);
  hud.legend = legend ? { x: legend.left, y: legend.top, w: legend.width, h: legend.height } : null;
  hud.capsule = caps ? { x: caps.left, y: caps.top, w: caps.width, h: caps.height } : null;
  hud.pb = pb ? { x: pb.left, y: pb.top, w: pb.width, h: pb.height } : null;

  lvLayoutSolve();
  return true;
}

/**
 * Build the five screen-space corner boxes + the ruler box, then solve the tree safe area.
 * Boxes are laid out first (they only depend on measured chrome), the radius second (it depends on them).
 */
export function lvLayoutSolve() {
  const hud = LV_HUD, L = LV_LAYOUT;
  const W = LV.W || window.innerWidth || 0, H = LV.H || window.innerHeight || 0;
  if (!W || !H) return;
  const S = hud.scale, m = hud.m, x0 = hud.x0, G = LV_GAP;
  const rightEdge = Math.min(W, hud.panelLeft || W);

  // --- top-left: C17 order-book tape, parked just under the toolbar / provenance stack ---
  hud.tl = { x: x0, y: hud.stackBottom + G, w: HUD_BOX.tl.w * S, h: HUD_BOX.tl.h * S };
  // --- top-right: C16 Gini histogram, same row, clear of the toolbar and of #lv-panel ---
  hud.tr = { x: Math.max(x0, rightEdge - m - HUD_BOX.tr.w * S), y: hud.stackBottom + G,
    w: HUD_BOX.tr.w * S, h: HUD_BOX.tr.h * S };
  // --- bottom-left: C14 derivation readout, stacked ABOVE the legend and the 3D capsule ---
  const blH = HUD_BOX.bl.h * S;
  hud.bl = { x: x0, y: Math.max(hud.tl.y + hud.tl.h + G, hud.blTop - G - blH), w: HUD_BOX.bl.w * S, h: blH };
  // --- bottom-right: generation histogram ABOVE the 20-min ribbon (they used to overlap by 3672 px²) ---
  const brRight = rightEdge - m;
  const brBotH = HUD_BOX.brBot.h * S, brTopH = HUD_BOX.brTop.h * S;
  hud.brBot = { x: brRight - HUD_BOX.brBot.w * S, y: H - m - brBotH, w: HUD_BOX.brBot.w * S, h: brBotH };
  hud.brTop = { x: brRight - HUD_BOX.brTop.w * S, y: hud.brBot.y - 10 * S - brTopH,
    w: HUD_BOX.brTop.w * S, h: brTopH };
  // --- left generation ruler: runs from under the top-left widget down to above the bottom-left one ---
  const rulerTop = Math.max(hud.stackBottom + G, hud.tl.y + hud.tl.h + G);
  const rulerBot = Math.max(rulerTop + 40, Math.min(hud.bl.y - G, H - m));
  hud.ruler = { x: x0, y: rulerTop, w: 20, h: rulerBot - rulerTop, top: rulerTop, bottom: rulerBot };

  // --- tree safe area: viewport-centred, radius clamped by the full-width bands and then by any corner
  //     box whose x-range actually reaches the bbox (monotone shrink ⇒ the loop always converges). ---
  const cx = W / 2, cy = H / 2;
  const topBand = hud.tbBottom + G;                       // toolbar spans nearly the full width
  const botBand = H - G;
  const leftBand = Math.max(hud.left + hud.pad, hud.ruler.x + hud.ruler.w) + G;
  const rightBand = rightEdge - G;
  let r1 = Math.min(Math.min(W, H) * LV_R1_K, cy - topBand, botBand - cy, cx - leftBand, rightBand - cx);
  const boxes = [hud.tl, hud.tr, hud.bl, hud.brTop, hud.brBot, hud.ruler,
    hud.pb, hud.legend, hud.capsule];
  for (let i = 0; i < 6; i++) {
    const lo = cx - r1, hi = cx + r1;
    let cap = r1;
    for (const b of boxes) {
      if (!b) continue;
      const bx2 = b.x + (b.w || 0), by2 = b.y + (b.h || 0);
      if (bx2 <= lo - G || b.x >= hi + G) continue;       // no horizontal reach ⇒ cannot clip the bbox
      if (by2 <= cy) cap = Math.min(cap, cy - by2 - G);   // box entirely above the centre
      else if (b.y >= cy) cap = Math.min(cap, b.y - G - cy);   // entirely below
      // a box straddling the centre line cannot be cleared by radius alone — left unconstrained on purpose
    }
    if (cap >= r1 - 0.5) break;
    r1 = cap;
  }
  r1 = Math.max(LV_R1_FLOOR, r1);

  L.cx = cx; L.cy = cy; L.r1 = r1; L.r0 = r1 * (LV_R0_K / LV_R1_K);
  L.top = cy - r1; L.bottom = cy + r1; L.left = cx - r1; L.right = cx + r1;
}

/**
 * task 42 · P0-B — full re-placement after a geometry change. The old place() only wrote `rad` when it
 * CREATED an LV.pos entry, so after a resize every node kept the pre-resize ring radius (and the necropolis
 * pass never re-placed an existing tomb at all), which is exactly the "17 % of nodes frozen / tree tears
 * into a horizontal band" report. Angles stay frozen — that is the incremental-stability contract.
 */
export function lvRelayoutAll() {
  const L = LV_LAYOUT;
  if (!L.r1 || !LV.maxGen) { LV.staticKey = ''; return; }
  const cx = L.cx, cy = L.cy, maxGen = LV.maxGen;
  const holdR = ringRadius(maxGen, maxGen) * 1.04;
  const radFor = (uid, p) => {
    // holding-ring occupants and unjoined necropolis tombs sit on their own two rings, not on a gen ring
    const s = typeof uid === 'string' ? uid : '';
    if (s.indexOf('id:') === 0) return holdR;
    if (s.indexOf('grave:') === 0) return holdR * 1.02;
    return ringRadius(p.gen || 0, maxGen);
  };
  for (const [uid, p] of LV.pos) {
    p.rad = radFor(uid, p);
    p.x = cx + Math.cos(p.ang) * p.rad;
    p.y = cy + Math.sin(p.ang) * p.rad;
  }
  for (const [uid, n] of LV.nodes) {
    const p = LV.pos.get(uid);
    if (!p) continue;
    n.ang = p.ang; n.rad = p.rad; n.x = p.x; n.y = p.y;
  }
  LV.staticKey = '';   // geometry moved ⇒ the baked layer is stale
}

/**
 * Zero-polling change detection for the DOM chrome: a ResizeObserver on the elements whose size/position
 * feeds lvHudMeasure() (topbar reflow on language switch, rail visibility, toolbar wrap, legend fold,
 * inspector panel open/close). The callback only raises a flag; lvFrame drains it once per frame.
 */
export function lvHudObserve() {
  if (hudRO || typeof ResizeObserver !== 'function') return;
  hudRO = new ResizeObserver(() => { LV.hudDirty = true; });
  for (const sel of ['.topbar', '#command-rail', '#lv-toolbar', '#lv-prov-bar', '#lv-legend',
    '#switch-to-3d', '#lv-panel', '#lv-filters']) {
    const el = document.querySelector(sel);
    if (el) hudRO.observe(el);
  }
}

export function ringRadius(gen, maxGen) {
  const L = LV_LAYOUT;
  const r0 = L.r0 || Math.min(LV.W, LV.H) * LV_R0_K;
  const r1 = L.r1 || Math.min(LV.W, LV.H) * LV_R1_K;
  return r0 + (r1 - r0) * (maxGen > 0 ? gen / maxGen : 0);
}
// spiral fan offset: child k of a parent sits at sign·ring·gap so the brood centres on the parent and each
// new sibling takes the NEXT slot without ever moving an already-placed one (incremental stability).
export function fanOffset(k, gap) {
  if (k <= 0) return 0;
  const ring = Math.ceil(k / 2);
  const sign = (k % 2 === 1) ? 1 : -1;
  return sign * ring * gap;
}
export function nodeById(id) { const uid = LV.idToUid.get(id); return uid ? LV.nodes.get(uid) : null; }

// ================= task 32 · Phase E · C24: search / filter =================
// The filter is a pure predicate over the node table: matching nodes keep full alpha, non-matching ones are
// dimmed to 0.06 (spatial memory is preserved — nothing is ever removed). It lives HERE (not in lvInteract)
// because BOTH the core bake (ancestors / tombs / ghosts are baked) and the per-frame live-node loop must
// consult it, and lvInteract must not be imported by the core draw path. lvInteract owns the DOM widgets and
// writes into `lvFilter`, then calls lvFilterRecompute(); the core reads lvNodeVisible() and lvFilter.sig.
export const lvFilter = {
  // search box (parsed into typed sub-queries so '#12', '0xab..', 'ochre' and 'g3' all resolve)
  q: '', qId: null, qHex: '', qHouse: '', qGen: null,
  // filter groups (defaults = inert)
  genMin: null, genMax: null,
  house: '',                       // '' = all houses
  life: 'all',                     // 'all' | 'live' | 'tomb' | 'ancestor'
  balMin: null, balMax: null,      // balN percent 0..100 (balN is balance / 50 USDC, clamped)
  op: 'all',                       // 'all' | 'genesis' | 'mutate' | 'cross'
  commit: 'all',                   // 'all' | 'yes' | 'no'
  // derived
  active: false, sig: '0', matchCount: 0,
};
/** Parse a raw search string into the typed sub-queries. Cheap, runs on the debounce edge only. */
export function lvParseQuery(raw) {
  const q = String(raw == null ? '' : raw).trim();
  lvFilter.q = q;
  lvFilter.qId = null; lvFilter.qHex = ''; lvFilter.qHouse = ''; lvFilter.qGen = null;
  if (!q) return;
  const low = q.toLowerCase();
  // explicit prefixes win
  const mGen = low.match(/^g(?:en)?[:\s]*(-?\d+)$/);
  if (mGen) { lvFilter.qGen = parseInt(mGen[1], 10); return; }
  const mId = low.match(/^(?:id|#)[:\s]*(\d+)$/);
  if (mId) { lvFilter.qId = parseInt(mId[1], 10); return; }
  const mHouse = low.match(/^house[:\s]*(.+)$/);
  if (mHouse) { lvFilter.qHouse = mHouse[1].trim(); return; }
  // bare number → id OR generation
  if (/^#?\d+$/.test(low)) { const n = parseInt(low.replace('#', ''), 10); lvFilter.qId = n; lvFilter.qGen = n; return; }
  // hex-ish (>=4 chars, optional 0x) → genomeHash prefix
  const hex = low.replace(/^0x/, '');
  if (/^[0-9a-f]{4,}$/.test(hex)) { lvFilter.qHex = hex; return; }
  // otherwise → house-name substring
  lvFilter.qHouse = low;
}
/** Recompute `active` + a short signature so the bake only re-runs when the filter actually moves. */
export function lvFilterRecompute() {
  const f = lvFilter;
  f.active = !!(f.q || f.genMin != null || f.genMax != null || f.house || f.life !== 'all'
    || f.balMin != null || f.balMax != null || f.op !== 'all' || f.commit !== 'all');
  if (!f.active) { f.sig = '0'; return; }
  let h = 2166136261;
  h = (h + fnv1a(f.q)) >>> 0;
  h = (h + (f.genMin == null ? 0 : f.genMin + 1)) >>> 0;
  h = (h + (f.genMax == null ? 0 : f.genMax + 1)) >>> 0;
  h = (h + fnv1a(f.house)) >>> 0;
  h = (h + fnv1a(f.life)) >>> 0;
  h = (h + (f.balMin == null ? 0 : f.balMin + 1) * 131) >>> 0;
  h = (h + (f.balMax == null ? 0 : f.balMax + 1)) >>> 0;
  h = (h + fnv1a(f.op)) >>> 0;
  h = (h + fnv1a(f.commit)) >>> 0;
  f.sig = h.toString(36);
}
/** True when `n` passes the search + every active filter group (⇒ full alpha). Inactive filter ⇒ always true. */
export function lvNodeVisible(n) {
  const f = lvFilter;
  if (!f.active || !n) return true;
  // search sub-queries (any hit counts)
  if (f.q) {
    let hit = false;
    if (f.qId != null && n.id != null && n.id === f.qId) hit = true;
    if (!hit && f.qGen != null && (n.gen | 0) === f.qGen) hit = true;
    if (!hit && f.qHex) { const h = (n.hash || (n.entry && n.entry.genomeHash) || '').toLowerCase().replace(/^0x/, ''); if (h && h.indexOf(f.qHex) === 0) hit = true; }
    if (!hit && f.qHouse) { const hn = (n.houseName || '').toLowerCase(); if (hn && hn.indexOf(f.qHouse) >= 0) hit = true; }
    if (!hit) return false;
  }
  // generation range
  const g = n.gen | 0;
  if (f.genMin != null && g < f.genMin) return false;
  if (f.genMax != null && g > f.genMax) return false;
  // life-state tri-mode (ghosts are decorative: only shown when life === 'all')
  if (f.life !== 'all') {
    if (n.ghost === true) return false;
    if (f.life === 'live' && n.kind !== 'live') return false;
    if (f.life === 'tomb' && n.kind !== 'tomb') return false;
    if (f.life === 'ancestor' && n.kind !== 'ancestor') return false;
  }
  // house
  if (f.house && (n.houseName || '').toLowerCase() !== f.house.toLowerCase()) return false;
  // balance (balN is 0..1; the UI edits a 0..100 percent)
  if (f.balMin != null || f.balMax != null) {
    const bp = (Number.isFinite(n.balN) ? n.balN : 0) * 100;
    if (f.balMin != null && bp < f.balMin) return false;
    if (f.balMax != null && bp > f.balMax) return false;
  }
  // breed operator (genesis / mutate / cross)
  if (f.op !== 'all') { const op = (n.entry && n.entry.op) || (n.kind === 'live' ? 'mutate' : ''); if (op !== f.op) return false; }
  // on-chain commit
  if (f.commit !== 'all') {
    const committed = !!(n.entry && (n.entry.commitTx || n.entry.genomeHash));
    if (f.commit === 'yes' && !committed) return false;
    if (f.commit === 'no' && committed) return false;
  }
  return true;
}
/** Alpha multiplier for a node under the current filter: 1 when visible, 0.06 when filtered out. */
export function lvNodeAlpha(n) { return lvNodeVisible(n) ? 1 : 0.06; }

// ================= localStorage persistence =================
// task 29 · C4 — the genome cache is now VERSIONED. Format __v:2 stores an identity stamp (seed +
// temperament + resolution time) next to every hash, plus a separate table of RETIRED occupants so a grave
// can still be joined to the genome node of the individual that was buried in a since-recycled slot.
// The legacy task-22 flat format `{id: hash}` carries no stamp, so it cannot tell whether a hash belongs to
// the current occupant of a slot or to a dead one (in production 12/12 grave ids are already recycled). We
// migrate the hash but force exactly one refetch per id so the stamp gets recorded — a bounded one-off sweep.
export function loadGH() {
  try {
    const raw = localStorage.getItem(LS_GH); const o = raw ? JSON.parse(raw) : null;
    if (!o || typeof o !== 'object') return;
    if (o.__v === 2) {
      const live = o.live || {}, ret = o.retired || {};
      for (const k of Object.keys(live)) {
        const e = live[k]; if (!e || typeof e.h !== 'string' || !e.h) continue;
        const id = Number(k);
        LV.ghCache.set(id, e.h);
        LV.ghMeta.set(id, { seed: Number.isFinite(e.seed) ? e.seed : null, temper: typeof e.temper === 'number' ? e.temper : null, at: +e.at || 0 });
      }
      for (const k of Object.keys(ret)) {
        const a = Array.isArray(ret[k]) ? ret[k] : null; if (!a || !a.length) continue;
        const list = [];
        for (const e of a) if (e && typeof e.h === 'string' && e.h) list.push({ h: e.h, temper: typeof e.temper === 'number' ? e.temper : null, at: +e.at || 0 });
        if (list.length) LV.ghRetired.set(Number(k), list.slice(-GH_RETIRED_PER_ID));
      }
    } else {
      for (const k of Object.keys(o)) {
        const h = o[k]; if (typeof h !== 'string' || !h) continue;
        const id = Number(k);
        LV.ghCache.set(id, h);
        LV.ghMeta.set(id, { seed: null, temper: null, at: 0 });
        LV.ghStale.add(id);          // no stamp ⇒ verify once against /flies/{id}
      }
    }
  } catch { /* a corrupt cache simply refetches */ }
}
export function saveGH() {
  try {
    const live = {}, retired = {};
    for (const [id, h] of LV.ghCache) {
      const m = LV.ghMeta.get(id) || {};
      live[id] = { h, seed: m.seed == null ? null : m.seed, temper: m.temper == null ? null : m.temper, at: m.at || 0 };
    }
    for (const [id, a] of LV.ghRetired) retired[id] = a.slice(-GH_RETIRED_PER_ID).map((e) => ({ h: e.h, temper: e.temper == null ? null : e.temper, at: e.at || 0 }));
    localStorage.setItem(LS_GH, JSON.stringify({ __v: 2, live, retired }));
  } catch { /* quota / private mode — the cache is a nicety, not a contract */ }
}
export function loadSocial() {
  try {
    const raw = localStorage.getItem(LS_SOCIAL); const a = raw ? JSON.parse(raw) : null;
    if (Array.isArray(a)) for (const e of a) if (e && e.a != null && e.b != null) LV.social.set(`${e.a}>${e.b}`, { a: e.a, b: e.b, sign: e.sign | 0, w: +e.w || 0, t: +e.t || Date.now() });
  } catch { /* ignore */ }
}
export function saveSocial() {
  try {
    const a = []; for (const e of LV.social.values()) if (e.w > 0.02) a.push({ a: e.a, b: e.b, sign: e.sign, w: Math.round(e.w * 1000) / 1000, t: e.t });
    localStorage.setItem(LS_SOCIAL, JSON.stringify(a.slice(0, 400)));
  } catch { /* ignore */ }
}
