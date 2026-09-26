// camera.js — cam 状态 + zoomAt/clampCam/resetView + pointer/touch + resize
// 由 app.js 机械拆分（任务5），行为与原文件一致；原文件保留为 app.js 备份参考。
import { state, $, STIR_COL, canvas, clamp, graveField, paletteAt, rgb, sim } from './shared.js';
import { deselect, select } from './inspector.js';
import { hideEpitaph, rebuildGraveField, showEpitaph } from './render2d.js';
import { initMotes } from './sim.js';

// pointer (stirs the swarm) — x/y are WORLD coords (camera-inverted), sx/sy raw SCREEN for zoom anchoring
export const pointer = { x: 0, y: 0, sx: 0, sy: 0, inside: false, down: false };
// click-storm guard: cap interaction-driven work
// drag-to-pan + wheel/pinch zoom bookkeeping (camera is a pure view transform, see render())
export const pan = { active: false, moved: false, sx0: 0, sy0: 0, camX0: 0, camY0: 0 };
export const pinch = { active: false, d0: 0, z0: 1, mx0: 0, my0: 0, camX0: 0, camY0: 0 };
export const ptrs = new Map();
export function layoutWorldMap() {
  // the home continent spans ~[0.18,0.73]x[0.12,0.86] of the atlas (bbox w=0.55 h=0.74, centre 0.455/0.49).
  // Size the atlas so the continent fills the viewport HEIGHT at z=1, and keep the world rect at the SAME
  // aspect as the viewport — that guarantees the atlas covers the screen at EVERY zoom (no letterbox bands).
  const CH = 0.74, CX = 0.455, CY = 0.49;
  const aspect = state.VW / state.VH;
  state.MAP.h = state.VH / CH; state.MAP.w = state.MAP.h * aspect;
  if (state.MAP.w < state.VW) { state.MAP.w = state.VW; state.MAP.h = state.MAP.w / aspect; }
  state.MAP.x0 = state.VW / 2 - CX * state.MAP.w; state.MAP.y0 = state.VH / 2 - CY * state.MAP.h;
  state.CAM_Z_MIN = state.VW / state.MAP.w;   // the zoom at which the whole world map exactly fills the viewport
}
export const mw = (t) => ({ x: state.MAP.x0 + t[0] * state.MAP.w, y: state.MAP.y0 + t[1] * state.MAP.h });
// min = whole world map fills the viewport; max = close inspection
export function screenToWorld(sx, sy) { return { x: (sx - state.cam.x) / state.cam.z, y: (sy - state.cam.y) / state.cam.z }; }
export function applyCam() { state.ctx.translate(state.cam.x, state.cam.y); state.ctx.scale(state.cam.z, state.cam.z); }
export function clampCam() {
  const wx0 = state.MAP.x0, wx1 = state.MAP.x0 + state.MAP.w, wy0 = state.MAP.y0, wy1 = state.MAP.y0 + state.MAP.h;
  const loX = state.VW - wx1 * state.cam.z, hiX = -wx0 * state.cam.z;
  state.cam.x = loX > hiX ? (state.VW - (wx1 - wx0) * state.cam.z) / 2 - wx0 * state.cam.z : clamp(state.cam.x, loX, hiX);
  const loY = state.VH - wy1 * state.cam.z, hiY = -wy0 * state.cam.z;
  state.cam.y = loY > hiY ? (state.VH - (wy1 - wy0) * state.cam.z) / 2 - wy0 * state.cam.z : clamp(state.cam.y, loY, hiY);
}
/** Zoom by `factor` keeping the world point under screen (sx,sy) pinned — the natural cursor-centred zoom. */
export function zoomAt(sx, sy, factor) {
  const nz = clamp(state.cam.z * factor, state.CAM_Z_MIN, state.CAM_Z_MAX);
  const w = screenToWorld(sx, sy);
  state.cam.z = nz; state.cam.x = sx - w.x * nz; state.cam.y = sy - w.y * nz; clampCam();
}
export function resetView() { state.cam.z = 1; state.cam.x = 0; state.cam.y = 0; clampCam(); }
export function resize() {
  state.VW = window.innerWidth; state.VH = window.innerHeight;
  state.DPR = Math.min(1.5, window.devicePixelRatio || 1);   // capped: full-bleed canvas fill is the main per-frame cost
  canvas.width = Math.round(state.VW * state.DPR);
  canvas.height = Math.round(state.VH * state.DPR);
  canvas.style.width = state.VW + "px";
  canvas.style.height = state.VH + "px";
  if (state.ctx) { state.ctx.setTransform(state.DPR, 0, 0, state.DPR, 0, 0); state.ctx.fillStyle = rgb(paletteAt(state.tempSmoothed).paper); state.ctx.fillRect(0, 0, state.VW, state.VH); }
  state.cachedRect = null;             // canvas box changed — drop the cached rect
  state.mindOff = null; state.mindSize = 0;  // the swarm-mind aura sprite must be rebuilt at the new field size
  state.parchOff = null; state.parchKey = "";   // parchment re-tiles at the new size (the gilt frame draws direct each frame)
  state.terrOff = null; state.terrKey = "";     // the cached territory map must re-render at the new field size
  state.uncOff = null; state.uncKey = "";       // the unclaimed continents bake is world-space ⇒ must re-bake at the new field size
  layoutWorldMap();                  // the atlas world-rect is derived from the field size
  clampCam();                        // the world/viewport relationship moved — pull the camera back in bounds
  rebuildGraveField();           // the headstone band is laid out in field coordinates → re-place on resize
  initMotes();
  if (state.threeScene) state.threeScene.resize(state.VW, state.VH);
}
window.addEventListener("resize", resize);
// ================= pointer: stir the swarm + select a fly =================
export function getRect() {
  if (!state.cachedRect) state.cachedRect = canvas.getBoundingClientRect();
  return state.cachedRect;
}
/** Throttled nearest-fly pick under the pointer — the hover half of the focus highlight. */
export function pickHover() {
  const pn = performance.now();
  if (pn - state.lastHoverAt < 90) return;      // pointermove fires far faster than the highlight needs
  state.lastHoverAt = pn;
  let best = null, bd = Infinity;
  for (const f of sim.values()) {
    if (f.dying) continue;
    const d = Math.hypot(f.x - pointer.x, f.y - pointer.y);
    if (d < bd) { bd = d; best = f; }
  }
  state.hoverId = (best && bd < 26) ? best.id : null;
  // a headstone under the pointer also reads as clickable (it opens its epitaph), independent of any fly
  let onGrave = false;
  if (state.showGraves) { for (const g of graveField) { if (Math.hypot(g.x - pointer.x, g.y - 2 - pointer.y) < 16) { onGrave = true; break; } } }
  canvas.style.cursor = (state.hoverId != null || onGrave) ? "pointer" : "";
}
export const PAN_THRESHOLD = 5;
// px of travel that turns a press into a camera-pan instead of a tap
export function bindPointer() {
  canvas.style.touchAction = "none";   // let us own pinch/drag on the field (no browser page-zoom or scroll)
  const toLocal = (e) => {
    const rect = getRect();          // cached — pointermove fires constantly; don't reflow each time
    pointer.sx = e.clientX - rect.left;
    pointer.sy = e.clientY - rect.top;
    const w = screenToWorld(pointer.sx, pointer.sy);   // picking & ripples live in WORLD space
    pointer.x = w.x; pointer.y = w.y;
  };
  // a tap (press that never travelled far) on empty ground stirs the swarm; on a fly it selects; on a stone it opens the epitaph
  const handleTap = () => {
    hideEpitaph();
    let best = null, bd = Infinity;
    for (const f of sim.values()) {
      if (f.dying) continue;
      const d = Math.hypot(f.x - pointer.x, f.y - pointer.y);
      if (d < bd) { bd = d; best = f; }
    }
    if (best && bd < 34 / state.cam.z) {
      if (best.id !== state.selectedId) select(best.id);   // debounce: never restart the feed on the same fly
    } else {
      if (state.selectedId != null) deselect();
      spawnRippleAt(pointer.x, pointer.y, STIR_COL);  // a little stir where you tapped (world coords)
    }
  };
  canvas.addEventListener("pointermove", (e) => {
    if (ptrs.has(e.pointerId)) ptrs.set(e.pointerId, { x: e.clientX - getRect().left, y: e.clientY - getRect().top });
    toLocal(e); pointer.inside = true;
    if (pinch.active) { movePinch(); return; }
    if (pan.active) {
      const dx = pointer.sx - pan.sx0, dy = pointer.sy - pan.sy0;
      if (!pan.moved && Math.hypot(dx, dy) > PAN_THRESHOLD) pan.moved = true;
      if (pan.moved) { state.cam.x = pan.camX0 + dx; state.cam.y = pan.camY0 + dy; clampCam(); canvas.style.cursor = "grabbing"; }
      return;
    }
    pickHover();
  });
  canvas.addEventListener("pointerdown", (e) => {
    const rect = getRect();
    ptrs.set(e.pointerId, { x: e.clientX - rect.left, y: e.clientY - rect.top });
    try { canvas.setPointerCapture(e.pointerId); } catch { /* noop */ }
    if (ptrs.size >= 2) { startPinch(); return; }   // second finger: switch to pinch-zoom, cancel any pan/tap
    const pn = performance.now();
    if (pn - state.lastClickAt < 90) return;               // swallow click-storms
    state.lastClickAt = pn;
    toLocal(e);
    pointer.inside = true; pointer.down = true;
    // a headstone under the press owns the gesture immediately (never pans or stirs)
    if (state.showGraves) {
      let gg = null, gd = 16 / state.cam.z;
      for (const g of graveField) { const d = Math.hypot(g.x - pointer.x, g.y - 2 - pointer.y); if (d < gd) { gd = d; gg = g; } }
      if (gg) { showEpitaph(gg); ptrs.delete(e.pointerId); return; }
    }
    pan.active = true; pan.moved = false; pan.sx0 = pointer.sx; pan.sy0 = pointer.sy; pan.camX0 = state.cam.x; pan.camY0 = state.cam.y;
  });
  const endPointer = (e) => {
    ptrs.delete(e.pointerId);
    if (pinch.active) { if (ptrs.size < 2) { pinch.active = false; } return; }
    pointer.down = false;
    if (pan.active) {
      const wasTap = !pan.moved;
      pan.active = false; canvas.style.cursor = "";
      if (wasTap) handleTap();     // a press that never moved = a tap; a drag just panned the camera
    }
  };
  canvas.addEventListener("pointerup", endPointer);
  canvas.addEventListener("pointercancel", endPointer);
  canvas.addEventListener("pointerleave", () => { if (!pan.active && !pinch.active) { pointer.inside = false; pointer.down = false; state.hoverId = null; canvas.style.cursor = ""; } });
  // wheel = cursor-centred zoom (native, no page scroll); shift-wheel nudges horizontally
  canvas.addEventListener("wheel", (e) => {
    e.preventDefault();
    const rect = getRect();
    const sx = e.clientX - rect.left, sy = e.clientY - rect.top;
    const factor = Math.exp(-e.deltaY * 0.0015);
    zoomAt(sx, sy, clamp(factor, 0.8, 1.25));
  }, { passive: false });
}
export function startPinch() {
  const p = Array.from(ptrs.values()); if (p.length < 2) return;
  pinch.d0 = Math.hypot(p[0].x - p[1].x, p[0].y - p[1].y) || 1;
  pinch.z0 = state.cam.z;
  const w = screenToWorld((p[0].x + p[1].x) / 2, (p[0].y + p[1].y) / 2);
  pinch.w0x = w.x; pinch.w0y = w.y;
  pinch.active = true; pan.active = false; pointer.down = false;
}
export function movePinch() {
  const p = Array.from(ptrs.values()); if (p.length < 2) return;
  const d = Math.hypot(p[0].x - p[1].x, p[0].y - p[1].y) || 1;
  const mx = (p[0].x + p[1].x) / 2, my = (p[0].y + p[1].y) / 2;
  state.cam.z = clamp(pinch.z0 * (d / pinch.d0), state.CAM_Z_MIN, state.CAM_Z_MAX);
  state.cam.x = mx - pinch.w0x * state.cam.z; state.cam.y = my - pinch.w0y * state.cam.z; clampCam();
}
// the +/−/reset cluster on the left edge — same zoomAt path as the wheel, anchored to the field centre
export function bindZoomControls() {
  const zi = $("zoom-in"), zo = $("zoom-out"), zr = $("zoom-reset");
  if (zi) zi.addEventListener("click", () => zoomAt(state.VW / 2, state.VH / 2, 1.28));
  if (zo) zo.addEventListener("click", () => zoomAt(state.VW / 2, state.VH / 2, 1 / 1.28));
  if (zr) zr.addEventListener("click", () => resetView());
}
export function spawnRippleAt(x, y, color) {
  if (state.ripples.length >= 10) state.ripples.shift();   // cap: rapid clicking can't pile up unbounded arcs
  state.ripples.push({ x, y, t0: performance.now(), color });
}
