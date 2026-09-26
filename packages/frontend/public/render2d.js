// render2d.js — 2D fallback 渲染：render 主循环 + drawFly + parchment/frame + 全部世界层绘制
// 由 app.js 机械拆分（任务5），行为与原文件一致；原文件保留为 app.js 备份参考。
import { state, $, ASH_GREY, BLOSSOM, CIV_SHADOW, COIN_GOLD, COLONY_COLORS, COLONY_NAMES, CONTINENT, CRACK_RED, ECON_EDGE_MS, FAITH_GOLD, FIRE_HOT, FIRE_LO, FIRE_MID, GARDEN, GILT, GILT_HI, GOLD_THREAD, GOOD_COL, GRAVE_CAP, HIST_SAMPLE_MS, HULL, INK, LAW_GOLD, MIND_REBUILD_MS, MONUMENT_MS, MUD, MUD_HI, MUD_SH, PALM, PLAZA, POOL, PROVINCES, RIBBON_WINDOW, RIVER_BLUE, SAIL, SMOKE, SOCIETY_BOND_MIN, SOCIETY_CAP_GAP, SOCIETY_FEUD_MAX, SOCIETY_MINCAP, SOCIETY_PAD, STATE_RGB, TAU, TECH_BRONZE, TERRA, UNCLAIMED, VELLUM, WK_AGE_TICKS, WORK_SLOT, canvas, clamp, fnv1a, graveField, graveUid, houseColor, houseOf, lerp, mix, paletteAt, rgb, rgba, sim, wealthColorAt } from './shared.js';
import { ct, gl, t as T } from './i18n.js?v=97';
import { applyCam, mw } from './camera.js';
import { keeperIds, prophetIds } from './economy.js';
import { refreshInspectorSocial } from './inspector.js';
import { renderMotes } from './sim.js';

// active pointerId → {x,y} screen, for two-finger pinch detection

// temperature history ribbon — now D1-backed. The live in-memory tail is merged with the archived per-cron
// series on a shared wall-clock axis, so the ribbon survives a reload and reaches back ~20 min (toward launch)
// instead of only showing the seconds since this tab opened. Without history it behaves as the old live view.
export const tempHistory = [];
// back to the framed home continent

// ================= painterly backdrop textures (golden-hour war-plain) =================
// Three pre-rendered textures give the field its cinematic depth: an earth base, a god-ray light shaft and a
// rolling ground fog. They load async and NEVER block a frame — until (or unless) an image is ready the layer
// falls back to the procedural parchment / gradients, so a slow or failed fetch just reverts to the old look.
export function mkTex(src) {
  const im = new Image(); im.decoding = "async"; let ok = false;
  im.onload = () => { ok = im.naturalWidth > 0; }; im.onerror = () => { ok = false; };
  im.src = src;
  return { im, get ready() { return ok; } };
}
export const TEX = { ground: mkTex("./assets/ground.jpg"), rays: mkTex("./assets/rays.jpg"), mist: mkTex("./assets/mist.jpg") };
export function makeHaloSprite() {
  const s = document.createElement("canvas");
  s.width = s.height = 128;
  const c = s.getContext("2d");
  const g = c.createRadialGradient(64, 64, 0, 64, 64, 64);
  g.addColorStop(0, "rgba(45,42,37,1)");
  g.addColorStop(0.55, "rgba(45,42,37,0.32)");
  g.addColorStop(1, "rgba(45,42,37,0)");
  c.fillStyle = g;
  c.fillRect(0, 0, 128, 128);
  return s;
}
export function makeCrownGlow() {
  const s = document.createElement("canvas");
  s.width = s.height = 64;
  const c = s.getContext("2d");
  const g = c.createRadialGradient(32, 32, 0, 32, 32, 32);
  g.addColorStop(0, rgba(GILT_HI, 0.34));
  g.addColorStop(1, rgba(GILT_HI, 0));
  c.fillStyle = g;
  c.fillRect(0, 0, 64, 64);
  return s;
}
// ---- swarm-mind ambient aura: a soft breathing bloom of the collective neural mood (deepest layer) ----
export function rebuildMind(pal) {
  const D = state.mindSize;
  if (!state.mindOff) { state.mindOff = document.createElement("canvas"); state.mindOffCtx = state.mindOff.getContext("2d"); }
  if (state.mindOff.width !== D) { state.mindOff.width = state.mindOff.height = D; }
  const x = state.mindOffCtx, c = D / 2, C = state.collective, acc = pal.accent;
  x.clearRect(0, 0, D, D);
  const aro = C ? clamp(C.arousal) : 0.4;
  const vit = C ? clamp(C.vitality) : 0.5;
  const st = (C && C.states) || {}, tot = Math.max(1, (C && C.size) || 24);
  const agitate = (st.AGITATE || 0) / tot, aggregate = (st.AGGREGATE || 0) / tot, rest = (st.REST || 0) / tot;
  // core glow — brightness tracks vitality
  const g = x.createRadialGradient(c, c, 0, c, c, c * 0.95);
  g.addColorStop(0, rgba(acc, 0.05 + vit * 0.09));
  g.addColorStop(0.5, rgba(acc, 0.02 + vit * 0.035));
  g.addColorStop(1, rgba(acc, 0));
  x.fillStyle = g; x.beginPath(); x.arc(c, c, c * 0.95, 0, TAU); x.fill();
  // filaments — reach shimmers with mean arousal; agitation adds jitter, aggregation/rest pull them in
  const FIL = 96, R0 = c * 0.10, R1 = c * (0.50 + aro * 0.34);
  x.lineWidth = 1;
  for (let i = 0; i < FIL; i++) {
    const a = (i / FIL) * TAU;
    const shimmer = 0.72 + 0.28 * Math.sin(state.flowTime * 0.6 + i * 0.7);
    const jitter = 1 + agitate * 0.5 * (Math.sin(i * 12.9898 + state.flowTime) * 0.5 + 0.5) - aggregate * 0.22 - rest * 0.18;
    const r1 = R0 + (R1 - R0) * clamp(shimmer * jitter, 0.15, 1.3);
    x.strokeStyle = rgba(acc, 0.015 + aro * 0.045);
    x.beginPath();
    x.moveTo(c + Math.cos(a) * R0, c + Math.sin(a) * R0);
    x.lineTo(c + Math.cos(a) * r1, c + Math.sin(a) * r1);
    x.stroke();
  }
}
export function renderMind(pal, now) {
  if (!state.showMind || !state.collective) return;
  if (!state.mindSize) state.mindSize = Math.round(clamp(Math.min(state.VW, state.VH) * 0.85, 320, 900));
  if (!state.mindOff || state.mindOff.width !== state.mindSize) state.mindOff = null;
  if (!state.mindOff || now - state.mindLast >= MIND_REBUILD_MS) { state.mindLast = now; rebuildMind(pal); }
  if (!state.mindOff) return;
  const cxr = state.centroidX || state.VW / 2, cyr = state.centroidY || state.VH / 2;
  const draw = (Math.min(state.VW, state.VH) * 1.05) / state.mindSize;   // let the aura reach most of the field
  state.mindAngle += 0.0009;
  state.ctx.save();
  state.ctx.globalAlpha = 0.42;
  state.ctx.translate(cxr, cyr);
  state.ctx.rotate(state.mindAngle);
  state.ctx.drawImage(state.mindOff, (-state.mindSize / 2) * draw, (-state.mindSize / 2) * draw, state.mindSize * draw, state.mindSize * draw);
  state.ctx.restore();
}
export function renderShards(pal, now) {
  if (!state.showShards || !state.topology || !state.topology.shards || state.topology.shards.length < 2) return;
  const acc = pal.accent, ink = [26, 26, 24];
  const shards = state.topology.shards, S = shards.length;
  const cxr = state.centroidX || state.VW / 2, cyr = state.centroidY || state.VH / 2;
  const ring = Math.min(state.VW, state.VH) * 0.315, nodeR = 13;
  const pulseAge = (now - state.shardPulseT) / 1500;
  state.ctx.save();
  state.ctx.lineWidth = 0.9;
  state.ctx.strokeStyle = rgba(mix(ink, acc, 0.2), 0.06);       // faint ring guide
  state.ctx.beginPath(); state.ctx.arc(cxr, cyr, ring, 0, TAU); state.ctx.stroke();
  state.ctx.textAlign = "center"; state.ctx.textBaseline = "middle";
  state.ctx.font = "8px ui-monospace, SFMono-Regular, Menlo, monospace";
  for (let i = 0; i < S; i++) {
    const s = shards[i];
    const a = (i / S) * TAU - Math.PI / 2;
    const nx = cxr + Math.cos(a) * ring, ny = cyr + Math.sin(a) * ring;
    let glow = 0;                                         // fan-out pulse: the runtime runs shards in ~ceil(N/6) waves of 6
    if (pulseAge >= 0 && pulseAge < 1) {
      const delay = (s.index % 6) / 6 * 0.4;
      const p = clamp((pulseAge - delay) / Math.max(0.001, 1 - delay));
      if (p > 0 && p < 1) glow = Math.sin(p * Math.PI);
    }
    state.ctx.fillStyle = rgba(acc, 0.03 + glow * 0.16);
    state.ctx.strokeStyle = rgba(mix(ink, acc, 0.35), 0.16 + glow * 0.5);
    state.ctx.beginPath(); state.ctx.arc(nx, ny, nodeR + glow * 4, 0, TAU); state.ctx.fill(); state.ctx.stroke();
    let k = 0; const span = s.end - s.start;
    for (let id = s.start; id < s.end; id++) {
      const f = sim.get(id);
      const col = (f && STATE_RGB[f.state]) || mix(ink, acc, 0.3);
      const dx = (k - (span - 1) / 2) * 6;
      state.ctx.fillStyle = rgba(col, f && !f.dying ? 0.8 : 0.25);
      state.ctx.beginPath(); state.ctx.arc(nx + dx, ny, 2.1, 0, TAU); state.ctx.fill();
      k++;
    }
    if (state.qualityCoeff > 0.6) { state.ctx.fillStyle = rgba(ink, 0.28 + glow * 0.4); state.ctx.fillText(String(s.index), nx, ny + nodeR + 8); }
  }
  state.ctx.restore();
}
// flyId → {name, sigil, color} — the bloodline, from /economy agents
export const monuments = [];
// fading grave steles at OBSERVED death positions
export const chronFx = [];
/** The fly the eye is on: pointer hover wins, else the persisted inspector selection. */
export function currentFocus() { return state.hoverId != null ? state.hoverId : state.selectedId; }
/** 1 for flies inside the focus's social neighbourhood, ~0.16 for everyone else (the "fade the rest"). */
export function focusDim(id) {
  const foc = currentFocus();
  if (foc == null) return 1;
  if (state.focusCacheId !== foc) {
    state.focusCacheId = foc;
    const s = new Set([foc]);
    if (state.societies) {
      const ci = state.societies.colonyOf.get(foc);
      if (ci != null && state.societies.colonies[ci]) for (const m of state.societies.colonies[ci].ids) s.add(m);
      for (const p of state.societies.allies) { if (p.a === foc) s.add(p.b); else if (p.b === foc) s.add(p.a); }
      for (const p of state.societies.feuds) { if (p.a === foc) s.add(p.b); else if (p.b === foc) s.add(p.a); }
    }
    state.focusSet = s;
  }
  return state.focusSet.has(id) ? 1 : 0.12;
}
/** Plant a fading grave stele where a fly is observed dying (its death position). */
export function plantMonument(f, now) {
  f._mon = true;
  // Dedup only against OTHER live transient steles of this id (an id may be recycled to a new fly after the
  // dead one is memorialised as a permanent stone, so we never suppress a fresh death on an OLD grave's id).
  if (monuments.some((m) => m.id === f.id && now - m.t0 < MONUMENT_MS)) return;
  const h = houseOf.get(f.id);
  monuments.push({ x: f.x, y: f.y, t0: now, id: f.id, sigil: (h && h.sigil) || "", color: (h && h.color) || [120, 120, 124], pulse: 0 });
  if (monuments.length > 48) monuments.shift();
}
/** Fading grave steles: a small headstone + a contracting house ring at each observed death spot. */
export function renderMonuments(pal, now) {
  for (let i = monuments.length - 1; i >= 0; i--) {
    const m = monuments[i];
    const age = (now - m.t0) / MONUMENT_MS;
    if (age >= 1) { monuments.splice(i, 1); continue; }
    const fade = 1 - age;
    const pulse = m.pulse ? Math.max(0, 1 - (now - m.pulse) / 900) : 0;   // an ELEGY re-lights its stele
    const col = m.color;
    state.ctx.save();
    state.ctx.globalAlpha = fade * (0.8 + pulse * 0.2);
    // a soft ground shadow so the stele sits ON the paper, not floats over it
    state.ctx.fillStyle = rgba(col, 0.14);
    state.ctx.beginPath(); state.ctx.ellipse(m.x, m.y + 7, 11, 3.4, 0, 0, TAU); state.ctx.fill();
    // a larger headstone slab
    state.ctx.fillStyle = rgba(col, 0.42);
    state.ctx.beginPath();
    state.ctx.moveTo(m.x - 6, m.y + 7); state.ctx.lineTo(m.x - 6, m.y - 4);
    state.ctx.quadraticCurveTo(m.x - 6, m.y - 11, m.x, m.y - 11);
    state.ctx.quadraticCurveTo(m.x + 6, m.y - 11, m.x + 6, m.y - 4);
    state.ctx.lineTo(m.x + 6, m.y + 7);
    state.ctx.closePath(); state.ctx.fill();
    state.ctx.strokeStyle = rgba(col, 0.7); state.ctx.lineWidth = 1.2;
    state.ctx.beginPath(); state.ctx.arc(m.x, m.y, 12 + pulse * 8, 0, TAU); state.ctx.stroke();
    state.ctx.font = "600 12px ui-monospace, SFMono-Regular, Menlo, monospace";
    state.ctx.textAlign = "center"; state.ctx.textBaseline = "top";
    state.ctx.fillStyle = rgba(col, 0.9);
    state.ctx.fillText("†" + m.sigil, m.x, m.y + 9);
    state.ctx.font = "8px ui-monospace, SFMono-Regular, Menlo, monospace";
    state.ctx.fillStyle = rgba(col, 0.6);
    state.ctx.fillText("#" + m.id, m.x, m.y + 22);
    state.ctx.restore();
  }
}
// ================= illuminated-manuscript layers: parchment base + gilded frame + necropolis =================
/** Build the aged-parchment base once into an offscreen (re-run on resize / temperature-bucket change /
 *  ~2s): the live paper pulled toward vellum, deterministic foxing blotches + fibre speckle, and burnt
 *  edges. Per-frame it is a single blit, so the costly texture never redraws on the hot path. */
export function rebuildParchment(pal) {
  if (!state.parchOff) { state.parchOff = document.createElement("canvas"); state.parchOffCtx = state.parchOff.getContext("2d"); }
  if (state.parchOff.width !== state.VW || state.parchOff.height !== state.VH) { state.parchOff.width = state.VW; state.parchOff.height = state.VH; }
  const x = state.parchOffCtx;
  x.setTransform(1, 0, 0, 1, 0, 0);
  const base = mix(pal.paper, VELLUM, 0.55);
  x.fillStyle = rgb(base); x.fillRect(0, 0, state.VW, state.VH);
  // deterministic foxing: soft radial stains (water marks / ageing) seeded by index, so they never crawl
  const nb = Math.max(8, Math.round((state.VW * state.VH) / 22000));
  for (let i = 0; i < nb; i++) {
    const a = fnv1a("fox:" + i), b = fnv1a("fox2:" + i);
    const bx = (a % 100000) / 100000 * state.VW, by = (b % 100000) / 100000 * state.VH;
    const br = 46 + ((a >>> 8) % 120);
    const warm = (b & 3) !== 0;
    const tone = warm ? mix(base, [150, 118, 74], 0.5) : mix(base, [120, 108, 84], 0.4);
    const g = x.createRadialGradient(bx, by, 0, bx, by, br);
    g.addColorStop(0, rgba(tone, warm ? 0.085 : 0.05));
    g.addColorStop(1, rgba(tone, 0));
    x.fillStyle = g; x.beginPath(); x.arc(bx, by, br, 0, TAU); x.fill();
  }
  // paper fibre: a light speckle of 1px flecks (bounded so huge viewports stay cheap)
  const nf = Math.min(1500, Math.round((state.VW * state.VH) / 1300));
  for (let i = 0; i < nf; i++) {
    const a = fnv1a("fib:" + i);
    const fx = (a % 100000) / 100000 * state.VW, fy = ((a >>> 9) % 100000) / 100000 * state.VH;
    x.fillStyle = rgba(INK, 0.02 + ((a >>> 3) & 7) / 7 * 0.022);
    x.fillRect(fx, fy, 1, 1);
  }
  // burnt / aged edges: darken toward the border so the sheet reads as handled vellum
  const eg = x.createRadialGradient(state.VW / 2, state.VH / 2, Math.min(state.VW, state.VH) * 0.34, state.VW / 2, state.VH / 2, Math.max(state.VW, state.VH) * 0.72);
  eg.addColorStop(0, rgba(INK, 0));
  eg.addColorStop(1, rgba(mix(base, [110, 86, 54], 0.6), 0.22));
  x.fillStyle = eg; x.fillRect(0, 0, state.VW, state.VH);
}
/** A gilded lozenge + curl tucked into one corner; the sign vector mirrors it across the four corners. */
export function drawCorner(cx, cy, sx, sy) {
  state.ctx.save();
  state.ctx.translate(cx, cy); state.ctx.scale(sx, sy);
  state.ctx.fillStyle = rgba(GILT_HI, 0.55);
  state.ctx.beginPath(); state.ctx.moveTo(0, 0); state.ctx.lineTo(9, 0); state.ctx.lineTo(0, 9); state.ctx.closePath(); state.ctx.fill();
  state.ctx.strokeStyle = rgba(GILT, 0.55); state.ctx.lineWidth = 1;
  state.ctx.beginPath(); state.ctx.moveTo(2, 15); state.ctx.quadraticCurveTo(15, 15, 15, 2); state.ctx.stroke();
  state.ctx.fillStyle = rgba(GILT, 0.5); state.ctx.beginPath(); state.ctx.arc(6, 6, 1.6, 0, TAU); state.ctx.fill();
  state.ctx.restore();
}
/** The manuscript border: a double gold rule + a hairline margin guide + four corner flourishes, drawn
 *  direct each frame (a dozen path ops — far cheaper than a full-screen alpha blit of a mostly-clear layer). */
export function renderFrame(pal) {
  const m = 13;
  state.ctx.save();
  state.ctx.lineWidth = 2; state.ctx.strokeStyle = rgba(GILT, 0.5); state.ctx.strokeRect(m, m, state.VW - 2 * m, state.VH - 2 * m);
  state.ctx.lineWidth = 1; state.ctx.strokeStyle = rgba(GILT, 0.34); state.ctx.strokeRect(m + 4.5, m + 4.5, state.VW - 2 * (m + 4.5), state.VH - 2 * (m + 4.5));
  state.ctx.lineWidth = 1; state.ctx.strokeStyle = rgba(INK, 0.06); state.ctx.strokeRect(m + 15, m + 15, state.VW - 2 * (m + 15), state.VH - 2 * (m + 15));
  drawCorner(m, m, 1, 1); drawCorner(state.VW - m, m, -1, 1); drawCorner(m, state.VH - m, 1, -1); drawCorner(state.VW - m, state.VH - m, -1, -1);
  state.ctx.restore();
}
/** Re-place the persistent necropolis from the server's grave ledger (econDynasty.graves). Deterministic:
 *  the newest ≤GRAVE_CAP stones cluster by house into adjacent family plots along the field's lower band
 *  (clear of the left panel + right drawer), each weathered by how long ago it fell. */
export function rebuildGraveField() {
  graveField.length = 0;
  const graves = (state.econDynasty && state.econDynasty.graves) || [];
  if (!graves.length || !state.VW || !state.VH) return;
  const gs = graves.slice().sort((a, b) => (b.tick || 0) - (a.tick || 0)).slice(0, GRAVE_CAP);   // newest first
  const byHouse = new Map();
  for (const g of gs) {
    const k = g.houseName || "";
    let arr = byHouse.get(k); if (!arr) { arr = []; byHouse.set(k, arr); }
    arr.push(g);
  }
  // houses (biggest bloodline first) lead, the houseless commons trails, so kin share a plot
  const groups = [...byHouse.entries()].sort((a, b) =>
    (a[0] === "" ? 1 : b[0] === "" ? -1 : b[1].length - a[1].length));
  const ordered = [];
  for (const [, arr] of groups) for (const g of arr) ordered.push(g);
  const x0 = state.VW * 0.18, x1 = state.VW * 0.82, y0 = state.VH * 0.72, y1 = state.VH * 0.93;
  const bandW = x1 - x0, bandH = y1 - y0, n = ordered.length;
  const cols = clamp(Math.round(bandW / 46), 4, 20) | 0;
  const rows = Math.max(1, Math.ceil(n / cols));
  const cw = bandW / cols, ch = bandH / rows;
  let maxTick = -Infinity, minTick = Infinity;
  for (const g of ordered) { const t = g.tick || 0; if (t > maxTick) maxTick = t; if (t < minTick) minTick = t; }
  const span = Math.max(1, maxTick - minTick);
  for (let i = 0; i < n; i++) {
    const g = ordered[i], r = (i / cols) | 0, c = i % cols;
    const h = fnv1a("grave:" + g.id + ":" + (g.bornTick == null ? 0 : g.bornTick));   // (id,bornTick): a recycled id scatters to its OWN plot
    const jx = ((h % 1000) / 1000 - 0.5), jy = (((h >>> 10) % 1000) / 1000 - 0.5);
    const x = x0 + cw * (c + 0.5) + jx * cw * 0.34;
    const y = y0 + ch * (r + 0.5) + jy * ch * 0.28;
    const weather = clamp(((maxTick - (g.tick || 0)) / span) * 0.85 + ((h >>> 4) % 100) / 100 * 0.15);
    graveField.push({
      id: g.id, bornTick: g.bornTick == null ? null : g.bornTick, uid: graveUid(g.id, g.bornTick), x, y,
      houseName: g.houseName || "", cause: g.cause || "", deals: g.deals || 0,
      estateUsdc: Number(g.estateUsdc) || 0, heirIds: g.heirIds || [], age: g.age || 0, tick: g.tick || 0,
      color: houseColor(g.houseName) || [120, 116, 108],
      sigil: g.houseName ? String(g.houseName).trim().charAt(0).toUpperCase() : "",
      tilt: (((h >>> 6) % 100) / 100 - 0.5) * weather * 0.16,   // the oldest stones lean into the ground
      weather, seed: h,
    });
  }
  if (state.selectedGrave) { const keep = graveField.find((g) => g.uid === state.selectedGrave.uid); state.selectedGrave = keep || null; }
  state.graveFieldSig = graveField.length + ":" + (graveField.length ? graveField[0].uid : "");
}
/** An arched headstone silhouette centred on the origin: flat base at +h, rounded top at -h. */
export function stonePath(c, w, h) {
  c.beginPath();
  c.moveTo(-w, h); c.lineTo(-w, -h * 0.28);
  c.quadraticCurveTo(-w, -h, 0, -h);
  c.quadraticCurveTo(w, -h, w, -h * 0.28);
  c.lineTo(w, h); c.closePath();
}
/** The engraved death-mark: † aged, ☠ plague, ⛁ penury (the empty purse already used by the debt badge). */
export function glyphFor(g) {
  if (g.cause === "plague") return "☠";
  if (g.cause === "penury") return "⛁";
  return "†";
}
/** Draw the necropolis: the stones are STATIC (plots, tilts, weathering and glyphs all derive from the
 *  closed grave ledger), so the whole field is baked into a world-space offscreen and blitted ONCE per
 *  frame — per-stone per-frame fillText used to grow with the death ledger and drag frameMsAvg over the
 *  budget as the colony aged. Only the gilded halo on the selected stone is drawn live. */
export function renderGraveyard(pal, now) {
  if (!state.showGraves || !graveField.length) return;
  const key = state.VW + "x" + state.VH + "@" + state.DPR + ":" + state.graveFieldSig;
  if (!state.graveOff || state.graveKey !== key) {
    if (!state.graveOff) { state.graveOff = document.createElement("canvas"); state.graveOffCtx = state.graveOff.getContext("2d"); }
    const w = Math.round(state.VW * state.DPR), h = Math.round(state.VH * state.DPR);
    if (state.graveOff.width !== w || state.graveOff.height !== h) { state.graveOff.width = w; state.graveOff.height = h; }
    state.graveKey = key;
    const g = state.graveOffCtx; g.setTransform(state.DPR, 0, 0, state.DPR, 0, 0); g.clearRect(0, 0, state.VW, state.VH);
    paintGraveyard(g);
  }
  state.ctx.drawImage(state.graveOff, 0, 0, state.VW, state.VH);
  if (state.selectedGrave) {                                            // a gilded halo on the chosen stone
    const h = 12;
    state.ctx.strokeStyle = rgba(GILT, 0.9); state.ctx.lineWidth = 1.6;
    state.ctx.beginPath(); state.ctx.arc(state.selectedGrave.x, state.selectedGrave.y - 1, h + 7, 0, TAU); state.ctx.stroke();
    state.ctx.strokeStyle = rgba(GILT_HI, 0.5); state.ctx.lineWidth = 0.8;
    state.ctx.beginPath(); state.ctx.arc(state.selectedGrave.x, state.selectedGrave.y - 1, h + 10, 0, TAU); state.ctx.stroke();
  }
}
/** Bake every weathered headstone onto a target context (the necropolis offscreen). */
export function paintGraveyard(g) {
  g.textAlign = "center";
  for (const gr of graveField) {
    const wx = gr.weather, w = 8, h = 12;
    const stone = mix([151, 143, 129], INK, 0.18 + wx * 0.42);   // fresh warm stone → dark weathered
    g.save();
    g.translate(gr.x, gr.y); g.rotate(gr.tilt);
    g.fillStyle = rgba([40, 34, 26], 0.16);                     // ground shadow
    g.beginPath(); g.ellipse(0, h + 2, w + 3, 3.2, 0, 0, TAU); g.fill();
    stonePath(g, w, h); g.fillStyle = rgb(stone); g.fill();
    g.lineWidth = 1; g.strokeStyle = rgba(INK, 0.5); g.stroke();
    g.strokeStyle = rgba(GILT_HI, 0.5); g.lineWidth = 1.1;    // gilt highlight on the top-left rim
    g.beginPath(); g.moveTo(-w, h * 0.2); g.lineTo(-w, -h * 0.28);
    g.quadraticCurveTo(-w, -h, 0, -h); g.stroke();
    g.textBaseline = "middle";
    g.font = "600 9px ui-monospace, SFMono-Regular, Menlo, monospace";
    g.fillStyle = rgba(INK, 0.72); g.fillText(glyphFor(gr), 0, -h * 0.34);   // the death-mark
    g.font = "7px ui-monospace, SFMono-Regular, Menlo, monospace";
    g.fillStyle = rgba(INK, 0.5); g.fillText("#" + gr.id, 0, h * 0.36);      // the buried wallet
    if (wx > 0.45) {                                                            // weathering cracks
      g.strokeStyle = rgba(INK, 0.32 * wx); g.lineWidth = 0.6;
      const cx = ((gr.seed >>> 3) % (w * 2)) - w;
      g.beginPath(); g.moveTo(cx, -h * 0.6); g.lineTo(cx + 2, -h * 0.1); g.lineTo(cx - 1, h * 0.4); g.stroke();
    }
    g.restore();
    if (wx > 0.5) {                                               // moss creeping up the base
      g.fillStyle = rgba([96, 120, 76], 0.5 * wx);
      g.beginPath(); g.ellipse(gr.x - w + 2, gr.y + h + 1, 2.4, 1.1, 0, 0, TAU);
      g.ellipse(gr.x + w - 2, gr.y + h + 1, 2.0, 1.0, 0, 0, TAU); g.fill();
    }
  }
}
/** Open the epitaph card for a buried wallet. A DOM overlay (not canvas type) so every line stays crisp,
 *  mirrors under RTL and re-localises on the fly — geometry stays LTR, only the text direction flips. */
export function showEpitaph(g) {
  state.selectedGrave = g;
  const card = $("epitaph"); if (!card) return;
  const head = $("epitaph-title");
  const house = g.houseName ? T("epitaph.house", { name: g.houseName }) : T("dyn.noHouse");
  // born# disambiguates two individuals that shared the SAME recycled slot id in different generations.
  const born = g.bornTick == null ? "" : " \u00b7 born#" + g.bornTick;
  if (head) head.textContent = glyphFor(g) + " #" + g.id + born + " \u00b7 " + house;   // the mark matches the stone's own death-mark
  const heirs = g.heirIds && g.heirIds.length ? g.heirIds.map((x) => "#" + x).join(", ") : T("dyn.theCommons");
  const cause = g.cause ? gl("cause", g.cause) : "\u2014";
  const lines = [
    ["\u2020", T("epitaph.died", { cause })],
    ["\u2696", T("epitaph.deals", { n: g.deals })],
    ["\u23f3", T("epitaph.age", { age: g.age })],
    ["\u25c7", T("epitaph.estate", { amt: Number(g.estateUsdc).toFixed(4) })],
    ["\u2192", T("epitaph.heirs", { heirs })],
  ];
  if (g.bornTick != null) lines.push(["\u2600", T("epitaph.born", { tick: g.bornTick })]);
  lines.push(["#", T("epitaph.tick", { tick: g.tick })]);
  const body = $("epitaph-body");
  if (body) {
    body.textContent = "";
    for (const [mark, text] of lines) {
      const d = document.createElement("div"); d.className = "ep-line";
      const s = document.createElement("span"); s.className = "ep-mark"; s.textContent = mark;
      const v = document.createElement("span"); v.className = "ep-val"; v.textContent = text;
      d.appendChild(s); d.appendChild(v); body.appendChild(d);
    }
  }
  card.hidden = false;
}
export function hideEpitaph() {
  state.selectedGrave = null;
  const card = $("epitaph"); if (card) card.hidden = true;
}
/** Persistent BOTTOM-CENTRE HUD: the current chronicle era as a monumental gilded banner (vellum plate, double
 *  gilt rule, side flourishes with diamond terminals and fleurons), so the age of the swarm crowns the foot of
 *  the map like an atlas cartouche. Read-only from chronMeta (the /annals poll); never touches sim / money. */
export function drawEraHeader(pal) {
  if (!state.chronMeta || (state.chronMeta.era == null && !state.chronMeta.eraName)) return;
  const rn = (n) => {
    if (!n || n <= 0) return String(n == null ? "" : n);
    const m = [[1000,"M"],[900,"CM"],[500,"D"],[400,"CD"],[100,"C"],[90,"XC"],[50,"L"],[40,"XL"],[10,"X"],[9,"IX"],[5,"V"],[4,"IV"],[1,"I"]];
    let out = "", rest = n; for (const [v, s] of m) while (rest >= v) { out += s; rest -= v; } return out;
  };
  const name = String(state.chronMeta.eraName || "").trim().toUpperCase();
  const label = name ? `ERA ${rn(state.chronMeta.era)} · ${name}` : `ERA ${rn(state.chronMeta.era)}`;
  const cx = state.VW / 2, cy = state.VH - 96;   // bottom-centre, well clear of the hint line and the corner panels / chron button
  state.ctx.save();
  state.ctx.textAlign = "center"; state.ctx.textBaseline = "middle";
  state.ctx.font = "700 21px Cinzel, Fraunces, Georgia, serif";
  try { state.ctx.letterSpacing = "3px"; } catch { /* older engines */ }
  const tw = state.ctx.measureText(label).width, pad = 40, bw = tw + pad * 2, bh = 46;
  const bx = cx - bw / 2, by = cy - bh / 2;
  // the vellum plate + a double gilt rule (monumental cartouche)
  state.ctx.beginPath();
  if (state.ctx.roundRect) state.ctx.roundRect(bx, by, bw, bh, 4);
  else state.ctx.rect(bx, by, bw, bh);
  state.ctx.fillStyle = rgba([248, 244, 236], 0.74); state.ctx.fill();
  state.ctx.lineWidth = 1.5; state.ctx.strokeStyle = rgba(GILT, 0.8); state.ctx.stroke();
  state.ctx.lineWidth = 1; state.ctx.strokeStyle = rgba(GILT_HI, 0.55); state.ctx.strokeRect(bx + 4, by + 4, bw - 8, bh - 8);
  // side flourishes: gilt rules reaching out of the plate, closed by diamond terminals
  state.ctx.strokeStyle = rgba(GILT, 0.65); state.ctx.lineWidth = 1.2; state.ctx.fillStyle = rgba(GILT, 0.75);
  for (const s of [-1, 1]) {
    const x0 = cx + s * (bw / 2 + 10), x1 = cx + s * (bw / 2 + 62);
    state.ctx.beginPath(); state.ctx.moveTo(x0, cy); state.ctx.lineTo(x1, cy); state.ctx.stroke();
    state.ctx.beginPath(); state.ctx.moveTo(x1 + s * 6, cy); state.ctx.lineTo(x1, cy - 4.5); state.ctx.lineTo(x1 - s * 6, cy); state.ctx.lineTo(x1, cy + 4.5); state.ctx.closePath(); state.ctx.fill();
  }
  // fleurons guarding the titulus inside the plate
  state.ctx.font = "600 13px Georgia, serif"; state.ctx.fillStyle = rgba(GILT, 0.85);
  state.ctx.fillText("❦", bx + 18, cy + 1); state.ctx.fillText("❦", bx + bw - 18, cy + 1);
  // the titulus itself: deep ink warmed with gilt, haloed in gold — epic, legible over any province
  state.ctx.font = "700 21px Cinzel, Fraunces, Georgia, serif";
  // a painted stroke halo instead of a text shadow: the same gilt lift, but no per-text Gaussian blur each frame
  state.ctx.lineJoin = "round"; state.ctx.miterLimit = 2;
  state.ctx.strokeStyle = rgba(GILT_HI, 0.8); state.ctx.lineWidth = 3.4;
  state.ctx.strokeText(label, cx, cy + 1);
  state.ctx.fillStyle = rgba(mix(INK, [122, 92, 40], 0.35), 0.97);
  state.ctx.fillText(label, cx, cy + 1);
  state.ctx.restore();
}
/** The chronicle made visible: every fresh ALLIANCE/FEUD/BETRAYAL/HOUSE_FOUNDED/ASSEMBLY/DECREE entry
 *  becomes a transient canvas event at the actors' live positions, so each annals sentence can be
 *  WATCHED happening on the field. */
export function renderChronBanner(pal, now) {
  // the epic centre-caption: the chronicle announcing itself in big serif type (SCREEN space)
  if (state.chronBanner) {
    const ba = (now - state.chronBanner.t0) / state.chronBanner.dur;
    if (ba >= 1) state.chronBanner = null;
    else {
      const env = Math.sin(Math.PI * Math.min(1, ba));
      const cx = state.VW / 2, cy = state.VH * 0.30;
      const chars = Array.from(state.chronBanner.text || "");
      const cap = chars.length ? chars[0] : "";
      const rest = chars.slice(1).join("");
      const box = 52;
      state.ctx.save();
      state.ctx.textBaseline = "middle";
      state.ctx.globalAlpha = env;
      // measure the trailing line so the whole drop-cap + text composite sits centred on the field
      state.ctx.font = "italic 600 26px Fraunces, Georgia, serif";
      const totalW = box + 10 + state.ctx.measureText(rest).width;
      const left = Math.max(cx - totalW / 2, box / 2 + 14);
      // the gilded initial: a vellum field, a double gold rule, the capital in monumental Roman caps
      state.ctx.fillStyle = rgba(mix(state.chronBanner.color, VELLUM, 0.74), 0.92);
      state.ctx.fillRect(left, cy - box / 2, box, box);
      state.ctx.lineWidth = 2; state.ctx.strokeStyle = rgba(GILT, 0.95); state.ctx.strokeRect(left, cy - box / 2, box, box);
      state.ctx.lineWidth = 1; state.ctx.strokeStyle = rgba(GILT_HI, 0.85); state.ctx.strokeRect(left + 3.5, cy - box / 2 + 3.5, box - 7, box - 7);
      state.ctx.textAlign = "center";
      state.ctx.font = "600 38px Cinzel, Fraunces, Georgia, serif";
      state.ctx.fillStyle = rgba(INK, 0.92);
      state.ctx.fillText(cap, left + box / 2, cy + 1);
      // the rest of the sentence, hung to the right of the initial
      state.ctx.textAlign = "left";
      state.ctx.font = "italic 600 26px Fraunces, Georgia, serif";
      state.ctx.fillStyle = rgba(state.chronBanner.color, 0.92);
      state.ctx.fillText(rest, left + box + 10, cy);
      if (state.chronBanner.sub) {
        state.ctx.textAlign = "center";
        state.ctx.globalAlpha = env * 0.7;
        state.ctx.font = "600 10px ui-monospace, SFMono-Regular, Menlo, monospace";
        state.ctx.fillStyle = rgba(state.chronBanner.color, 0.85);
        state.ctx.fillText(state.chronBanner.sub, cx, cy + box / 2 + 15);
      }
      state.ctx.restore();
    }
  }
}
export function renderChronFx(pal, now) {
  for (let i = chronFx.length - 1; i >= 0; i--) {
    const fx = chronFx[i];
    const age = (now - fx.t0) / fx.dur;
    if (age >= 1) { chronFx.splice(i, 1); continue; }
    const env = Math.sin(Math.PI * Math.min(1, age));      // fast in, slow out
    if (fx.kind === "law") {
      // a whole-field legislative shockwave: a faint gold wash + two expanding rings
      state.ctx.fillStyle = rgba(LAW_GOLD, (1 - age) * 0.05);
      state.ctx.fillRect(0, 0, state.VW, state.VH);
      const R = age * Math.min(state.VW, state.VH) * 0.62;
      state.ctx.strokeStyle = rgba(LAW_GOLD, (1 - age) * 0.5); state.ctx.lineWidth = 3.0 * (1 - age) + 0.5;
      state.ctx.beginPath(); state.ctx.arc(state.VW / 2, state.VH / 2, R, 0, TAU); state.ctx.stroke();
      state.ctx.strokeStyle = rgba(LAW_GOLD, (1 - age) * 0.3); state.ctx.lineWidth = 1.4;
      state.ctx.beginPath(); state.ctx.arc(state.VW / 2, state.VH / 2, R * 0.72, 0, TAU); state.ctx.stroke();
      continue;
    }
    if (fx.kind === "house") {
      const f = sim.get(fx.a);
      const x = f ? f.x : fx.x, y = f ? f.y : fx.y;
      if (x == null) continue;
      state.ctx.save();
      state.ctx.globalAlpha = env;
      state.ctx.strokeStyle = rgba(fx.color, 0.9); state.ctx.lineWidth = 2.2;
      state.ctx.beginPath(); state.ctx.arc(x, y, 14 + age * 40, 0, TAU); state.ctx.stroke();
      state.ctx.strokeStyle = rgba(fx.color, 0.4); state.ctx.lineWidth = 1;
      state.ctx.beginPath(); state.ctx.arc(x, y, 8 + age * 26, 0, TAU); state.ctx.stroke();
      state.ctx.font = "600 22px ui-monospace, SFMono-Regular, Menlo, monospace";
      state.ctx.textAlign = "center"; state.ctx.textBaseline = "middle";
      state.ctx.fillStyle = rgba(fx.color, 0.95);
      state.ctx.fillText(fx.sigil, x, y - 20 - age * 14);
      state.ctx.restore();
      continue;
    }
    if (fx.kind === "prophet") {
      // ⑪ a prophet is heard: a candle-gold ring bursts from the fly and a ✶ rises over it
      const f = sim.get(fx.a);
      const x = f ? f.x : fx.x, y = f ? f.y : fx.y;
      if (x == null) continue;
      state.ctx.save();
      state.ctx.globalAlpha = env;
      state.ctx.strokeStyle = rgba(FAITH_GOLD, 0.85); state.ctx.lineWidth = 2;
      state.ctx.beginPath(); state.ctx.arc(x, y, 12 + age * 40, 0, TAU); state.ctx.stroke();
      state.ctx.font = "600 24px ui-monospace, SFMono-Regular, Menlo, monospace";
      state.ctx.textAlign = "center"; state.ctx.textBaseline = "middle";
      state.ctx.fillStyle = rgba(FAITH_GOLD, 0.95);
      state.ctx.fillText("✶", x, y - 20 - age * 16);
      state.ctx.restore();
      continue;
    }
    if (fx.kind === "holy") {
      // ⑪ a pilgrimage walks on the holy day: a warm candle wash + one slow ring from the field's heart
      state.ctx.fillStyle = rgba(FAITH_GOLD, (1 - age) * 0.05);
      state.ctx.fillRect(0, 0, state.VW, state.VH);
      const R = age * Math.min(state.VW, state.VH) * 0.6;
      state.ctx.strokeStyle = rgba(FAITH_GOLD, (1 - age) * 0.4); state.ctx.lineWidth = 2.2 * (1 - age) + 0.4;
      state.ctx.beginPath(); state.ctx.arc(state.VW / 2, state.VH / 2, R, 0, TAU); state.ctx.stroke();
      continue;
    }
    if (fx.kind === "invent") {
      // ⑬⑱ an art found / rekindled: a bronze ✵ (⚒ for rebirth, over a warm core) rises inside widening rings
      const f = fx.a != null ? sim.get(fx.a) : null;
      const x = f ? f.x : fx.x, y = f ? f.y : fx.y;
      if (x == null || y == null) continue;
      state.ctx.save();
      state.ctx.globalAlpha = env;
      state.ctx.strokeStyle = rgba(TECH_BRONZE, 0.8); state.ctx.lineWidth = 2;
      state.ctx.beginPath(); state.ctx.arc(x, y, 10 + age * 40, 0, TAU); state.ctx.stroke();
      state.ctx.strokeStyle = rgba(TECH_BRONZE, 0.35); state.ctx.lineWidth = 1;
      state.ctx.beginPath(); state.ctx.arc(x, y, 5 + age * 24, 0, TAU); state.ctx.stroke();
      if (fx.rekindle) { state.ctx.fillStyle = rgba(FIRE_MID, (1 - age) * 0.22); state.ctx.beginPath(); state.ctx.arc(x, y, 8 + age * 10, 0, TAU); state.ctx.fill(); }
      state.ctx.font = "600 22px ui-monospace, SFMono-Regular, Menlo, monospace";
      state.ctx.textAlign = "center"; state.ctx.textBaseline = "middle";
      state.ctx.fillStyle = rgba(TECH_BRONZE, 0.95);
      state.ctx.fillText(fx.glyph || "✵", x, y - 18 - age * 16);
      state.ctx.restore();
      continue;
    }
    if (fx.kind === "lostart") {
      // ⑬⑯⑰ an art gone dark: the point dims, a cold ☒ sinks, ash motes fall away (the reverse of an invention)
      const f = fx.a != null ? sim.get(fx.a) : null;
      const x = f ? f.x : fx.x, y = f ? f.y : fx.y;
      if (x == null || y == null) continue;
      state.ctx.save();
      state.ctx.globalAlpha = env;
      state.ctx.fillStyle = rgba([30, 26, 22], (1 - age) * 0.16);
      state.ctx.beginPath(); state.ctx.arc(x, y, 16 + age * 8, 0, TAU); state.ctx.fill();
      state.ctx.font = "600 20px ui-monospace, SFMono-Regular, Menlo, monospace";
      state.ctx.textAlign = "center"; state.ctx.textBaseline = "middle";
      state.ctx.fillStyle = rgba(ASH_GREY, 0.9);
      state.ctx.fillText("☒", x, y - 6 + age * 14);
      for (let k = 0; k < 5; k++) {
        const ph = (fnv1a("ash:" + k) % 100) / 100;
        const ax = x + Math.sin(ph * TAU + age * 3) * (6 + age * 16), ay = y + age * (18 + ph * 20);
        state.ctx.fillStyle = rgba(ASH_GREY, (1 - age) * 0.4);
        state.ctx.beginPath(); state.ctx.arc(ax, ay, 1.1, 0, TAU); state.ctx.fill();
      }
      state.ctx.restore();
      continue;
    }
    if (fx.kind === "school") {
      // ⑯ a school is raised: a ⛫ settles onto the capital as a soft founding ring contracts around it
      const x = fx.x, y = fx.y;
      if (x == null || y == null) continue;
      state.ctx.save();
      state.ctx.globalAlpha = env;
      state.ctx.strokeStyle = rgba(TECH_BRONZE, 0.5); state.ctx.lineWidth = 1.6;
      state.ctx.beginPath(); state.ctx.arc(x, y, 8 + (1 - age) * 26, 0, TAU); state.ctx.stroke();
      state.ctx.font = "600 20px ui-monospace, SFMono-Regular, Menlo, monospace";
      state.ctx.textAlign = "center"; state.ctx.textBaseline = "middle";
      state.ctx.fillStyle = rgba(TECH_BRONZE, 0.92);
      state.ctx.fillText("⛫", x, y - 12 - (1 - age) * 8);
      state.ctx.restore();
      continue;
    }
    if (fx.kind === "transmit") {
      // ⑯ a craft passes hand to hand: a bronze ✋ thread (tool-coloured, unlike the gold alliance thread);
      // a SURPASS additionally crowns the apprentice with a rising ▲.
      const ma = sim.get(fx.a), mb = sim.get(fx.b);
      if (!ma || !mb) continue;
      state.ctx.save();
      state.ctx.globalAlpha = env;
      state.ctx.strokeStyle = rgba(TECH_BRONZE, 0.9); state.ctx.lineWidth = 2.2;
      state.ctx.beginPath(); state.ctx.moveTo(ma.x, ma.y); state.ctx.lineTo(mb.x, mb.y); state.ctx.stroke();
      state.ctx.font = "600 15px ui-monospace, SFMono-Regular, Menlo, monospace";
      state.ctx.textAlign = "center"; state.ctx.textBaseline = "middle";
      state.ctx.fillStyle = rgba(TECH_BRONZE, 0.95);
      state.ctx.fillText("✋", (ma.x + mb.x) / 2, (ma.y + mb.y) / 2 - 8);
      if (fx.surpass) { const c = sim.get(fx.crown); if (c) { state.ctx.fillStyle = rgba(GILT_HI, 0.95); state.ctx.fillText("▲", c.x, c.y - 18 - age * 12); } }
      state.ctx.restore();
      continue;
    }
    if (fx.kind === "coin") {
      // ⑲ the treasury swells: a coin-gold ¤ (fever) / ◇ (tithe) pulse at the coffer, ringed by motes flowing IN
      const x = fx.x, y = fx.y;
      if (x == null || y == null) continue;
      state.ctx.save();
      state.ctx.globalAlpha = env;
      if (fx.fever) { state.ctx.fillStyle = rgba(COIN_GOLD, (1 - age) * 0.04 * clamp((fx.mult || 1) / 3)); state.ctx.fillRect(0, 0, state.VW, state.VH); }
      const R = 12 + age * 34;
      state.ctx.strokeStyle = rgba(COIN_GOLD, 0.75); state.ctx.lineWidth = 2;
      state.ctx.beginPath(); state.ctx.arc(x, y, R, 0, TAU); state.ctx.stroke();
      for (let k = 0; k < 6; k++) {
        const ph = (k / 6) * TAU + age * 2, rr = R + (1 - age) * 22;
        state.ctx.fillStyle = rgba(COIN_GOLD, (1 - age) * 0.6);
        state.ctx.beginPath(); state.ctx.arc(x + Math.cos(ph) * rr, y + Math.sin(ph) * rr, 1.4, 0, TAU); state.ctx.fill();
      }
      state.ctx.font = "600 20px ui-monospace, SFMono-Regular, Menlo, monospace";
      state.ctx.textAlign = "center"; state.ctx.textBaseline = "middle";
      state.ctx.fillStyle = rgba(COIN_GOLD, 0.95);
      state.ctx.fillText(fx.fever ? "¤" : "◇", x, y);
      state.ctx.restore();
      continue;
    }
    if (fx.kind === "whale") {
      // ⑲ a whale strokes the tape: one wide, slow coin-gold shockwave rolls out from the coffer (broader than law)
      const x = fx.x, y = fx.y;
      if (x == null || y == null) continue;
      const R = age * Math.min(state.VW, state.VH) * 0.7;
      if (R <= 0) continue;
      state.ctx.strokeStyle = rgba(COIN_GOLD, (1 - age) * 0.4); state.ctx.lineWidth = 4 * (1 - age) + 0.6;
      state.ctx.beginPath(); state.ctx.arc(x, y, R, 0, TAU); state.ctx.stroke();
      state.ctx.strokeStyle = rgba(COIN_GOLD, (1 - age) * 0.2); state.ctx.lineWidth = 1.6;
      state.ctx.beginPath(); state.ctx.arc(x, y, R * 0.66, 0, TAU); state.ctx.stroke();
      continue;
    }
    if (fx.kind === "silence") {
      // ⑲ the tape goes quiet: a grey ◌ hush-ring closes over the coffer as the coin-embers thin (see ambient)
      const x = fx.x, y = fx.y;
      if (x == null || y == null) continue;
      state.ctx.save();
      state.ctx.globalAlpha = env;
      state.ctx.strokeStyle = rgba(ASH_GREY, 0.6); state.ctx.lineWidth = 1.6;
      state.ctx.beginPath(); state.ctx.arc(x, y, 30 - age * 16, 0, TAU); state.ctx.stroke();
      state.ctx.font = "600 20px ui-monospace, SFMono-Regular, Menlo, monospace";
      state.ctx.textAlign = "center"; state.ctx.textBaseline = "middle";
      state.ctx.fillStyle = rgba(ASH_GREY, 0.8);
      state.ctx.fillText("◌", x, y);
      state.ctx.restore();
      continue;
    }
    const a = sim.get(fx.a), b = sim.get(fx.b);
    if (!a || !b) continue;
    const colr = fx.kind === "alliance" ? GOLD_THREAD : CRACK_RED;
    // shockwave rings bursting from each actor so the eye is drawn to the pair
    state.ctx.strokeStyle = rgba(colr, env * 0.45); state.ctx.lineWidth = 1.4;
    state.ctx.beginPath(); state.ctx.arc(a.x, a.y, 6 + age * 42, 0, TAU); state.ctx.stroke();
    state.ctx.beginPath(); state.ctx.arc(b.x, b.y, 6 + age * 42, 0, TAU); state.ctx.stroke();
    if (fx.kind === "alliance") {
      state.ctx.strokeStyle = rgba(GOLD_THREAD, env * 0.95); state.ctx.lineWidth = 2.6;
      state.ctx.beginPath(); state.ctx.moveTo(a.x, a.y); state.ctx.lineTo(b.x, b.y); state.ctx.stroke();
      state.ctx.strokeStyle = rgba(GOLD_THREAD, env * 0.6); state.ctx.lineWidth = 1.6;
      state.ctx.beginPath(); state.ctx.arc((a.x + b.x) / 2, (a.y + b.y) / 2, 6 + age * 30, 0, TAU); state.ctx.stroke();
    } else {   // feud / betrayal: a red rift flashing open between the two
      state.ctx.strokeStyle = rgba(CRACK_RED, env * 0.95); state.ctx.lineWidth = 2.4;
      traceCrack(a, b); state.ctx.stroke();
    }
  }
}
/** ⑪ The faith membrane made visible: a soft ✶ halo over every prophet's fly, and on a holy day a warm
 *  candle wash over the whole field. A pure read-out of econReligion (prophetIds / holyDay, refreshed in
 *  renderReligionSection) — it simulates nothing and moves nothing; drawn in WORLD space beside the swarm. */
export function renderFaithFx(now) {
  const pulse = 0.5 + 0.5 * Math.sin(now / 620);
  if (state.holyDay) {
    state.ctx.fillStyle = "rgba(214,168,86," + (0.035 + 0.02 * pulse).toFixed(3) + ")";
    state.ctx.fillRect(0, 0, state.VW, state.VH);
  }
  if (!prophetIds.size) return;
  state.ctx.save();
  state.ctx.textAlign = "center"; state.ctx.textBaseline = "middle";
  state.ctx.font = "600 15px ui-monospace, SFMono-Regular, Menlo, monospace";
  for (const id of prophetIds) {
    const f = sim.get(id);
    if (!f || f.dying) continue;
    state.ctx.strokeStyle = "rgba(226,186,96," + (0.16 + 0.12 * pulse).toFixed(3) + ")";
    state.ctx.lineWidth = 1;
    state.ctx.beginPath(); state.ctx.arc(f.x, f.y, 11 + pulse * 2.5, 0, TAU); state.ctx.stroke();
    state.ctx.fillStyle = "rgba(226,186,96," + (0.55 + 0.35 * pulse).toFixed(3) + ")";
    state.ctx.fillText("✶", f.x, f.y - 16 - pulse * 2.5);
  }
  state.ctx.restore();
}
/** The bourse's "coffer anchor": the centroid of the live capitals (so the treasury sits ON the continent,
 *  never adrift), else the field's heart. A pure read-out of the territory seats — recomputed on demand. */
export function cofferAnchor() {
  if (state.territories && state.territories.length) {
    let cx = 0, cy = 0, n = 0;
    for (const p of state.territories) { const s = politySeat(p); if (s) { cx += s.x; cy += s.y; n++; } }
    if (n) return { x: cx / n, y: cy / n };
  }
  return { x: state.VW / 2, y: state.VH / 2 };
}
/** A named house's capital seat (case-insensitive), or null when that house holds no live dominion — used to
 *  anchor an invention / a school to the family the chronicle credits. */
export function houseSeat(name) {
  if (!name || !state.territories) return null;
  const k = String(name).toLowerCase();
  for (const p of state.territories) { if (p.name && p.name.toLowerCase() === k) { const s = politySeat(p); if (s) return { x: s.x, y: s.y }; } }
  return null;
}
/** The cached coffer anchor, recomputed at most every 400ms (politySeat walks each capital's swarm, so we
 *  never want it per-frame). */
export function chronCofferNow(now) {
  if (now - state.chronAnchorT > 400) { state.chronAnchor = cofferAnchor(); state.chronAnchorT = now; }
  return state.chronAnchor;
}
/** A coarse signature of the stele grove, recomputed at most every 500ms, so the offscreen rebakes ONLY when the
 *  ladder/schools change or a credited capital genuinely relocates (>40px) — never per frame (graveFieldSig discipline). */
export function chronSteleSigNow(now) {
  if (now - state.chronSteleSigT > 500) {
    let s = "";
    const t = state.econTech;
    if (t && Array.isArray(t.rungs)) for (const r of t.rungs) s += "r" + r.rung + (r.houseName || "") + "|";
    if (t && Array.isArray(t.lost)) for (const l of t.lost) s += "l" + l.rung + "|";
    const a = state.econApprentice;
    if (a && Array.isArray(a.schools)) for (const sc of a.schools) s += "s" + (sc.houseName || sc.name || "") + "|";
    if (state.territories) for (const p of state.territories) { const st = politySeat(p); if (st) s += p.name + "@" + Math.round(st.x / 40) + "," + Math.round(st.y / 40) + ";"; }
    state.chronSteleSigCache = s; state.chronSteleSigT = now;
  }
  return state.chronSteleSigCache;
}
/** Carve the stele grove onto the offscreen: a small bronze ✵ for each adopted rung near its credited capital, a
 *  cold ☒ scar for each lost art, a ⛫ for each standing school. Static between rebakes (capped at 24 marks). */
export function paintChronSteles(g) {
  g.textAlign = "center"; g.textBaseline = "middle";
  const cof = cofferAnchor();
  let budget = 24;
  const seatFor = (houseName, seed) => {
    const s = houseSeat(houseName);
    if (s) return s;
    const px = (fnv1a(seed) % 1000) / 1000, py = (fnv1a(seed + ":y") % 1000) / 1000;
    return { x: cof.x + (px - 0.5) * 96, y: cof.y + (py - 0.5) * 72 };
  };
  const t = state.econTech;
  if (t && Array.isArray(t.rungs)) for (const r of t.rungs) {
    if (budget-- <= 0) break;
    const s = seatFor(r.houseName, "rung:" + r.rung + ":" + (r.name || ""));
    const jx = s.x + ((fnv1a("j" + r.rung) % 40) - 20), jy = s.y + 20 + ((fnv1a("k" + r.rung) % 26) - 13);
    g.save();
    g.strokeStyle = rgba(TECH_BRONZE, 0.4); g.lineWidth = 1;
    g.beginPath(); g.moveTo(jx, jy + 5); g.lineTo(jx, jy - 5); g.stroke();
    g.font = "600 13px ui-monospace, SFMono-Regular, Menlo, monospace";
    g.fillStyle = rgba(TECH_BRONZE, 0.62);
    g.fillText("✵", jx, jy - 8);
    g.restore();
  }
  if (t && Array.isArray(t.lost)) for (const l of t.lost) {
    if (budget-- <= 0) break;
    const s = seatFor(null, "lost:" + l.rung + ":" + (l.name || ""));
    const jx = s.x + ((fnv1a("lj" + l.rung) % 40) - 20), jy = s.y + 20 + ((fnv1a("lk" + l.rung) % 26) - 13);
    g.save();
    g.font = "600 12px ui-monospace, SFMono-Regular, Menlo, monospace";
    g.fillStyle = rgba(ASH_GREY, 0.42);
    g.fillText("☒", jx, jy - 6);
    g.restore();
  }
  const a = state.econApprentice;
  if (a && Array.isArray(a.schools)) for (const sc of a.schools) {
    if (budget-- <= 0) break;
    const s = seatFor(sc.houseName || sc.name, "school:" + (sc.name || ""));
    const jx = s.x, jy = s.y - 26;
    g.save();
    g.strokeStyle = rgba(TECH_BRONZE, 0.3); g.lineWidth = 1;
    g.beginPath(); g.arc(jx, jy + 2, 9, 0, TAU); g.stroke();
    g.font = "600 14px ui-monospace, SFMono-Regular, Menlo, monospace";
    g.fillStyle = rgba(TECH_BRONZE, 0.6);
    g.fillText("⛫", jx, jy);
    g.restore();
  }
}
/** The chronicle made PERSISTENT: three world-space read-outs of the econ* module vars, drawn every frame beside
 *  renderFaithFx — ⑪ the reigning-god totem over the coffer, ⑬⑯ the ladder/school stele grove (baked, blit once)
 *  + a fragile ✋ halo on every last-living keeper, ⑲ the bourse coffer ◇ with its tithe-pulse ring, coin-embers
 *  and a faint fever wash. Purely decorative: it reads state, simulates nothing, moves no fly, holds no key.
 *  Gated by the #chronicle toggle; the whole call is try/caught at the site so it can never veto a frame. */
export function renderChronAmbient(pal, now) {
  if (!state.showChron) return;
  const q = state.qualityCoeff;
  const anchor = chronCofferNow(now);

  // ---- ⑲ the Bourse: a treasury ◇ at the coffer, its tithe-pulse ring, coin-embers drifting in, a fever wash ----
  const b = state.econBourse;
  if (b && b.enabled) {
    const cli = b.climate || {}, sig = b.signals || {};
    const fever = clamp(Number(cli.feverLevel) || 0);
    const quiet = Number(cli.quietCrons) || 0;
    const whaleExcess = Number(cli.whaleExcess) || 0;
    const tax = Number(sig.taxTotalMurmur) || 0;
    const milestone = Number(b.titheMilestoneMurmur) || 0;
    const taxFrac = milestone > 0 ? clamp((tax % milestone) / milestone) : 0;
    const pulse = 0.5 + 0.5 * Math.sin(now / 700);
    const dim = quiet > 0;                       // a silent tape: the coffer cools to ash
    const coinCol = dim ? ASH_GREY : COIN_GOLD;
    if (fever > 0.02 && !dim) { state.ctx.fillStyle = rgba(COIN_GOLD, fever * 0.03); state.ctx.fillRect(0, 0, state.VW, state.VH); }
    const R = 15 + pulse * 2;
    state.ctx.save();
    state.ctx.strokeStyle = rgba(coinCol, 0.5 + 0.2 * pulse); state.ctx.lineWidth = 1.6;
    state.ctx.beginPath(); state.ctx.arc(anchor.x, anchor.y, R, 0, TAU); state.ctx.stroke();
    if (milestone > 0) {                          // the milestone arc fills clockwise from 12 o'clock (the treasury's pulse)
      state.ctx.strokeStyle = rgba(coinCol, 0.85); state.ctx.lineWidth = 2.6;
      state.ctx.beginPath(); state.ctx.arc(anchor.x, anchor.y, R + 3.5, -Math.PI / 2, -Math.PI / 2 + TAU * taxFrac); state.ctx.stroke();
    }
    if (whaleExcess > 0) {                        // a whale just crossed the line: a brief red rim (echoes the whale FX)
      state.ctx.strokeStyle = rgba(CRACK_RED, 0.5 + 0.3 * pulse); state.ctx.lineWidth = 1.4;
      state.ctx.beginPath(); state.ctx.arc(anchor.x, anchor.y, R + 7, 0, TAU); state.ctx.stroke();
    }
    state.ctx.font = "600 16px ui-monospace, SFMono-Regular, Menlo, monospace";
    state.ctx.textAlign = "center"; state.ctx.textBaseline = "middle";
    state.ctx.fillStyle = rgba(coinCol, 0.7 + 0.25 * pulse);
    state.ctx.fillText("◇", anchor.x, anchor.y);
    state.ctx.restore();
    if (q > 0.3 && fever > 0.02) {                // coin-embers drifting toward the coffer; density/alpha rise with fever, thin in silence
      const n = Math.min(18, Math.round(4 + fever * (dim ? 6 : 16)));
      state.ctx.save();
      for (let i = 0; i < n; i++) {
        const ph = (fnv1a("ember:" + i) % 1000) / 1000;
        const tt = ((now * 0.00012 + ph) % 1);
        const ang = ph * TAU + Math.sin(now * 0.0004 + i) * 0.4;
        const rad = (1 - tt) * (46 + ph * 40);
        const ex = anchor.x + Math.cos(ang) * rad, ey = anchor.y + Math.sin(ang) * rad;
        const al = (dim ? 0.18 : 0.4) * Math.sin(Math.PI * tt) * (0.4 + 0.6 * fever);
        state.ctx.fillStyle = rgba(coinCol, al);
        state.ctx.beginPath(); state.ctx.arc(ex, ey, 1.2 + ph, 0, TAU); state.ctx.fill();
      }
      state.ctx.restore();
    }
  }

  // ---- ⑬⑯ the ladder + the schools: a static grove of steles near each credited capital (baked, blit once) ----
  if (state.econTech || state.econApprentice) {
    const key = state.VW + "x" + state.VH + "@" + state.DPR + ":" + chronSteleSigNow(now);
    if (!state.chronOff || state.chronOffKey !== key) {
      if (!state.chronOff) { state.chronOff = document.createElement("canvas"); state.chronOffCtx = state.chronOff.getContext("2d"); }
      const w = Math.round(state.VW * state.DPR), h = Math.round(state.VH * state.DPR);
      if (state.chronOff.width !== w || state.chronOff.height !== h) { state.chronOff.width = w; state.chronOff.height = h; }
      state.chronOffKey = key;
      const g = state.chronOffCtx; g.setTransform(state.DPR, 0, 0, state.DPR, 0, 0); g.clearRect(0, 0, state.VW, state.VH);
      paintChronSteles(g);
    }
    state.ctx.drawImage(state.chronOff, 0, 0, state.VW, state.VH);
  }

  // ---- ⑯ the last keepers: a fragile ✋ tool-halo over each fly that is the sole living hand on its craft ----
  if (q > 0.3 && keeperIds.size) {
    const pulse = 0.5 + 0.5 * Math.sin(now / 540);
    state.ctx.save();
    state.ctx.textAlign = "center"; state.ctx.textBaseline = "middle";
    state.ctx.font = "600 13px ui-monospace, SFMono-Regular, Menlo, monospace";
    for (const id of keeperIds) {
      const f = sim.get(id);
      if (!f || f.dying) continue;
      state.ctx.strokeStyle = rgba(TECH_BRONZE, 0.14 + 0.1 * pulse); state.ctx.lineWidth = 1;
      state.ctx.beginPath(); state.ctx.arc(f.x, f.y, 10 + pulse * 2, 0, TAU); state.ctx.stroke();
      state.ctx.fillStyle = rgba(TECH_BRONZE, 0.4 + 0.28 * pulse);
      state.ctx.fillText("✋", f.x, f.y - 15 - pulse * 2);
    }
    state.ctx.restore();
  }

  // ---- ⑪ the reigning-god totem: a gilded celestial glyph above the coffer, ringed by the sects' sigils ----
  if (state.chronFaith && q > 0.3) {
    const pulse = 0.5 + 0.5 * Math.sin(now / 900);
    const gx = anchor.x, gy = anchor.y - 54 - pulse * 3;
    const reign = state.chronFaith.reigning;
    const godGlyph = reign === "SCORCH" ? "☀" : reign === "FROST" ? "❄" : "☾";
    const godCol = reign === "FROST" ? mix(FAITH_GOLD, [150, 190, 220], 0.4) : reign === "SCORCH" ? mix(FAITH_GOLD, [240, 150, 80], 0.3) : FAITH_GOLD;
    state.ctx.save();
    state.ctx.textAlign = "center"; state.ctx.textBaseline = "middle";
    const halo = state.ctx.createRadialGradient(gx, gy, 0, gx, gy, 26);
    halo.addColorStop(0, rgba(godCol, 0.22 + 0.1 * pulse)); halo.addColorStop(1, rgba(godCol, 0));
    state.ctx.fillStyle = halo; state.ctx.beginPath(); state.ctx.arc(gx, gy, 26, 0, TAU); state.ctx.fill();
    state.ctx.font = "600 22px ui-monospace, SFMono-Regular, Menlo, monospace";
    state.ctx.fillStyle = rgba(godCol, 0.8 + 0.15 * pulse);
    state.ctx.fillText(godGlyph, gx, gy);
    const sects = state.chronFaith.sects || [];
    const maxAdh = Math.max(1, ...sects.map((s) => s.adherents || 0));
    state.ctx.font = "600 12px ui-monospace, SFMono-Regular, Menlo, monospace";
    for (let i = 0; i < sects.length && i < 6; i++) {
      const s = sects[i];
      const ang = Math.PI * (0.15 + 0.7 * (sects.length === 1 ? 0.5 : i / (sects.length - 1)));
      const rx = gx + Math.cos(ang) * 34, ry = gy + Math.sin(ang) * 20 + 8;
      const sz = 0.5 + 0.5 * ((s.adherents || 0) / maxAdh);
      state.ctx.fillStyle = rgba(godCol, 0.3 + 0.4 * sz);
      state.ctx.fillText(s.prophetId != null ? "✶" : "†", rx, ry);
    }
    state.ctx.restore();
  }
}
/** Turn one fresh chronicle entry into a canvas event (+ a one-shot social impulse so an alliance
 *  visibly pulls its two colonies together for an instant, a feud shoves them apart). */
export function spawnChronFx(e) {
  const actors = Array.isArray(e.actors) ? e.actors : [];
  const a = actors[0], b = actors[1];
  const now = performance.now();
  // a reconnect can hand us a whole batch of entries at once — bound the live FX list so it can never grow
  // without limit (drop the oldest; each entry self-clears on age anyway, this is only a flood guard).
  if (chronFx.length > 48) chronFx.splice(0, chronFx.length - 48);
  if (e.kind === "ALLIANCE") {
    if (a == null || b == null) return;
    chronFx.push({ kind: "alliance", a, b, t0: now, dur: 2600 });
    setBanner(T("banner.alliance"), T("banner.fly", { id: a }) + " · " + T("banner.fly", { id: b }), GOLD_THREAD);
    chronNudge(a, b, +1);
  } else if (e.kind === "FEUD" || e.kind === "BETRAYAL") {
    if (a == null || b == null) return;
    chronFx.push({ kind: "feud", a, b, t0: now, dur: 2200 });
    setBanner(e.kind === "BETRAYAL" ? T("banner.betrayal") : T("banner.feud"), T("banner.fly", { id: a }) + " · " + T("banner.fly", { id: b }), CRACK_RED);
    chronNudge(a, b, -1);
  } else if (e.kind === "HOUSE_FOUNDED") {
    if (a == null) return;
    const h = houseOf.get(a), f = sim.get(a);
    chronFx.push({ kind: "house", a, x: f ? f.x : null, y: f ? f.y : null, sigil: (h && h.sigil) || "", color: (h && h.color) || LAW_GOLD, t0: now, dur: 3200 });
    setBanner(T("banner.house"), h ? T("banner.houseOf", { name: h.name }) : T("banner.fly", { id: a }), (h && h.color) || LAW_GOLD);
  } else if (e.kind === "ASSEMBLY" || e.kind === "DECREE") {
    chronFx.push({ kind: "law", t0: now, dur: 3400 });
    setBanner(e.kind === "ASSEMBLY" ? T("banner.assembly") : T("banner.decree"), T("banner.commonsLaw"), LAW_GOLD);
  } else if (e.kind === "ELEGY") {
    const m = monuments.find((mm) => mm.id === a);
    if (m) m.pulse = now;
    setBanner(T("banner.elegy"), T("banner.fly", { id: a }), [120, 120, 124]);
  } else if (e.kind === "WAR_DECLARED") {
    // the two houses tear a red rift open between their colonies and are shoved apart
    const t = e.tokens || {};
    if (a != null && b != null) { chronFx.push({ kind: "feud", a, b, t0: now, dur: 2600 }); chronNudge(a, b, -1); }
    setBanner(T("banner.warDeclared"), T("banner.warBetween", {
      attacker: t.attacker || (a != null ? T("banner.fly", { id: a }) : "?"),
      defender: t.defender || (b != null ? T("banner.fly", { id: b }) : "?"),
    }), CRACK_RED);
  } else if (e.kind === "WAR_RESOLVED") {
    // the coffer's verdict: name the victor and the vanquished across the whole field
    const t = e.tokens || {};
    setBanner(T("banner.warResolved"), T("banner.defeats", {
      winner: t.winner || "?", loser: t.loser || "?", potUsdc: t.potUsdc != null ? t.potUsdc : "",
    }), CRACK_RED);
    invalidateTerritory();
  } else if (e.kind === "TERRITORY_SEIZED") {
    // conquest repaints the map: drop the cached dominions + colony partition so the seized zone recolours
    const t = e.tokens || {};
    setBanner(T("banner.territorySeized"), T("banner.seizes", {
      winner: t.winner || "?", loser: t.loser || "?", zones: t.zones != null ? t.zones : "",
    }), [196, 62, 48]);
    invalidateTerritory();
  } else if (e.kind === "PROPHECY") {
    // ⑪ a prophet is heard: burst a candle-gold ✶ over the fly that bears the flame
    const t = e.tokens || {};
    if (a != null) { const f = sim.get(a); chronFx.push({ kind: "prophet", a, x: f ? f.x : null, y: f ? f.y : null, t0: now, dur: 3200 }); }
    setBanner(T("banner.prophecy"), T("banner.prophecyOf", { sect: t.sect || "?", id: a != null ? a : "?" }), FAITH_GOLD);
  } else if (e.kind === "SCHISM") {
    // ⑪ a house tears from its ancestor cult: name the house and the foreign sect it turned to
    const t = e.tokens || {};
    setBanner(T("banner.schism"), T("banner.schismOf", { name: t.name || "?", sect: t.sect || "?" }), CRACK_RED);
  } else if (e.kind === "REVIVAL") {
    // ⑪ a silent shrine rekindles
    const t = e.tokens || {};
    setBanner(T("banner.revival"), T("banner.revivalOf", { sect: t.sect || "?", n: t.adherents != null ? t.adherents : "" }), FAITH_GOLD);
  } else if (e.kind === "PILGRIMAGE") {
    // ⑪ the holy day: the faithful walk — a warm candle wash over the whole field
    const t = e.tokens || {};
    chronFx.push({ kind: "holy", t0: now, dur: 3600 });
    setBanner(T("banner.pilgrimage"), T("banner.pilgrimageOf", { name: t.name || "?", n: t.adherents != null ? t.adherents : "" }), FAITH_GOLD);
  } else if (e.kind === "INVENTION" || e.kind === "DIFFUSION" || e.kind === "REINVENTION") {
    // ⑬⑱ an art is found / spreads / is rekindled: a bronze ✵ (⚒ for a rebirth) bursts up over the discoverer.
    // INVENTION/DIFFUSION name no single hand (actors empty) → anchor the credited house's capital, else the coffer.
    const t = e.tokens || {};
    const live = a != null ? sim.get(a) : null;
    const anchor = live ? null : (houseSeat(t.credit) || cofferAnchor());
    chronFx.push({ kind: "invent", a: live ? a : null, x: anchor ? anchor.x : null, y: anchor ? anchor.y : null,
      glyph: e.kind === "REINVENTION" ? "⚒" : "✵", rekindle: e.kind === "REINVENTION", t0: now, dur: 3000 });
    setBanner(T("banner.tech"), ct(e.kind, t), TECH_BRONZE);
  } else if (e.kind === "LOST_ART" || e.kind === "CRAFT_LOST" || e.kind === "ARCHIVE_BURNED") {
    // ⑬⑯⑰ an art goes dark: a cold ☒ sinks over the last hand that held it (or the coffer) with falling ash.
    const t = e.tokens || {};
    const live = a != null ? sim.get(a) : null;
    const anchor = live ? null : cofferAnchor();
    chronFx.push({ kind: "lostart", a: live ? a : null, x: anchor ? anchor.x : null, y: anchor ? anchor.y : null, t0: now, dur: 3000 });
    setBanner(T("banner.craft"), ct(e.kind, t), ASH_GREY);
  } else if (e.kind === "SCHOOL") {
    // ⑯ a house raises a school: a ⛫ settles onto its capital inside a soft founding ring.
    const t = e.tokens || {};
    const anchor = houseSeat(t.house) || cofferAnchor();
    chronFx.push({ kind: "school", x: anchor.x, y: anchor.y, sigil: t.sigil || "", t0: now, dur: 3200 });
    setBanner(T("banner.craft"), ct(e.kind, t), TECH_BRONZE);
  } else if (e.kind === "TRANSMISSION" || e.kind === "SURPASS") {
    // ⑯ a craft passes hand to hand: a bronze ✋ thread master↔apprentice; SURPASS crowns the climbing student.
    if (a == null || b == null) return;
    const crown = e.kind === "SURPASS" ? a : b;   // the apprentice: SURPASS lists the student first, TRANSMISSION second
    chronFx.push({ kind: "transmit", a, b, crown, surpass: e.kind === "SURPASS", t0: now, dur: 2800 });
    setBanner(T("banner.craft"), ct(e.kind, e.tokens || {}), TECH_BRONZE);
  } else if (e.kind === "COIN_FEVER" || e.kind === "TITHE") {
    // ⑲ the treasury swells: a coin-gold ¤/◇ pulse at the coffer, ringed by motes flowing in; a fever warms the field.
    const t = e.tokens || {};
    const anchor = cofferAnchor();
    chronFx.push({ kind: "coin", x: anchor.x, y: anchor.y, fever: e.kind === "COIN_FEVER", mult: Number(t.mult) || 1, t0: now, dur: 3000 });
    setBanner(T("banner.coin"), ct(e.kind, t), COIN_GOLD);
  } else if (e.kind === "WHALE_MOVE") {
    // ⑲ a whale strokes the tape: a wide, slow coin-gold 〰 shockwave rolls out from the coffer.
    const anchor = cofferAnchor();
    chronFx.push({ kind: "whale", x: anchor.x, y: anchor.y, t0: now, dur: 3400 });
    setBanner(T("banner.coin"), ct(e.kind, e.tokens || {}), COIN_GOLD);
  } else if (e.kind === "COIN_SILENCE") {
    // ⑲ the tape goes quiet: a grey ◌ hush-ring closes over the coffer.
    const anchor = cofferAnchor();
    chronFx.push({ kind: "silence", x: anchor.x, y: anchor.y, t0: now, dur: 3200 });
    setBanner(T("banner.coin"), ct(e.kind, e.tokens || {}), ASH_GREY);
  } else if (e.kind === "INDICTMENT" || e.kind === "TRIAL" || e.kind === "VERDICT" || e.kind === "EXILE" || e.kind === "AMNESTY") {
    // ⑳ the court sits: a law-gold ripple for the docket's stages; an exile cracks judgement-red.
    // Reuses the existing "law" fx (assembly/decree) — no new canvas pass, no new render branch.
    const t = e.tokens || {};
    if (e.kind === "EXILE" || e.kind === "AMNESTY") chronFx.push({ kind: "law", t0: now, dur: 3000 });
    setBanner(T("banner.court"), ct(e.kind, t), e.kind === "EXILE" ? CRACK_RED : LAW_GOLD);
  } else if (e.kind === "GAMES" || e.kind === "CHAMPION" || e.kind === "RECORD") {
    // ㉑ the games: an opening washes the field in festival warmth (the holy-day wash again); a crowning or
    // a fallen record ripples law-gold from the coffer. Reuses existing fx — no new canvas pass, no new render branch.
    const t = e.tokens || {};
    if (e.kind === "GAMES") chronFx.push({ kind: "holy", t0: now, dur: 3600 });
    else chronFx.push({ kind: "law", t0: now, dur: 3000 });
    setBanner(T("banner.games"), ct(e.kind, t), LAW_GOLD);
  } else if (e.kind === "GUILD_CHARTER" || e.kind === "APPRENTICE_PACT" || e.kind === "GUILD_MONOPOLY") {
    // ㉒ the guilds: a charter or a pact ripples law-gold (a seal is a civic act); a monopoly rolls the
    // warm holy wash over the field — one trade shading the whole works. Reuses existing fx, no new pass.
    const t = e.tokens || {};
    if (e.kind === "GUILD_MONOPOLY") chronFx.push({ kind: "holy", t0: now, dur: 3600 });
    else chronFx.push({ kind: "law", t0: now, dur: 3000 });
    setBanner(T("banner.guilds"), ct(e.kind, t), LAW_GOLD);
  } else if (e.kind === "COINAGE" || e.kind === "WORD_SPREAD" || e.kind === "WORD_DIES") {
    // ㉓ the lexicon: a coinage ripples law-gold (the desk's entry is a civic act); a word on every tongue
    // washes the field in the warm holy tint; a burial falls back to a quiet law ripple. Reuses existing fx.
    const t = e.tokens || {};
    if (e.kind === "WORD_SPREAD") chronFx.push({ kind: "holy", t0: now, dur: 3600 });
    else chronFx.push({ kind: "law", t0: now, dur: 3000 });
    setBanner(T("banner.lexicon"), ct(e.kind, t), LAW_GOLD);
  } else if (e.kind === "RUMOR_AFOOT" || e.kind === "RUMOR_BENT" || e.kind === "RUMOR_FADED") {
    // ㉔ the rumor mill: a tale taking wing or going quiet ripples law-gold (the market square is a civic
    // place); a tale that BENDS in the retelling washes the field in the warm holy tint — the distortion
    // reads uncanny on purpose. Reuses existing fx, no new pass.
    const t = e.tokens || {};
    if (e.kind === "RUMOR_BENT") chronFx.push({ kind: "holy", t0: now, dur: 3600 });
    else chronFx.push({ kind: "law", t0: now, dur: 3000 });
    setBanner(T("banner.rumor"), ct(e.kind, t), LAW_GOLD);
  } else if (e.kind === "TREATY_SIGNED" || e.kind === "TREATY_RATIFIED" || e.kind === "TREATY_BREACHED") {
    // ㉕ the treaty: a seal set or broken ripples law-gold (a treaty is the most legal thing two houses
    // do); a RATIFIED peace washes the field in the warm holy tint — a habit grown from anger deserves
    // the same glow a harvest gets. Reuses existing fx, no new pass.
    const t = e.tokens || {};
    if (e.kind === "TREATY_RATIFIED") chronFx.push({ kind: "holy", t0: now, dur: 3600 });
    else chronFx.push({ kind: "law", t0: now, dur: 3000 });
    setBanner(T("banner.treaty"), ct(e.kind, t), LAW_GOLD);
  } else if (e.kind === "WORK_RAISED" || e.kind === "WORK_REPAIRED" || e.kind === "WORK_DILAPIDATED") {
    // ㉖ the public works: breaking ground washes the field in the warm holy tint (a commons raising a thing
    // nobody owns alone is the closest the swarm gets to a harvest); a mending or a fall ripples law-gold.
    const t = e.tokens || {};
    if (e.kind === "WORK_RAISED") chronFx.push({ kind: "holy", t0: now, dur: 3600 });
    else chronFx.push({ kind: "law", t0: now, dur: 3000 });
    setBanner(T("banner.works"), ct(e.kind, t), LAW_GOLD);
  } else if (e.kind === "WARD_TAKEN" || e.kind === "WARD_FLEDGED" || e.kind === "GUARDIAN_HONORED") {
    // ㉗ the guardians: a ward taken ripples law-gold (a wardship is the most legal act a society makes);
    // a fledge and a full-circle honor wash the field in the warm holy tint — raising what grief left
    // behind is the harvest the roll measures itself by. Reuses existing fx, no new pass.
    const t = e.tokens || {};
    if (e.kind === "WARD_TAKEN") chronFx.push({ kind: "law", t0: now, dur: 3000 });
    else chronFx.push({ kind: "holy", t0: now, dur: 3600 });
    setBanner(T("banner.guardians"), ct(e.kind, t), LAW_GOLD);
  }
}
/** Drop every cached territory visual so the next frame repaints from the fresh server zone owners
 *  (the big dominion map + the offscreen blit + the focus highlight). Cheap; only fired on a war beat. */
export function invalidateTerritory() {
  state.terrKey = "";                       // renderTerritoryMap rebuilds the offscreen map on the next paint
  state.focusCacheId = null;                // the colony/house tints feeding a focused fly's set are now stale
  rebuildSocieties();                 // regroup colonies from the latest zoneOwners so a seizure recolours
}
/** Flash the epic centre-caption for a chronicle event. */
export function setBanner(text, sub, color) {
  state.chronBanner = { text, sub, color, t0: performance.now(), dur: 2600 };
}
/** One-shot impulse along the axis between two flies' colonies: +1 draws them together (a new
 *  alliance), -1 shoves them apart (a new feud). Tiny and instantaneous — flavour, not physics. */
export function chronNudge(a, b, sign) {
  const fa = sim.get(a), fb = sim.get(b);
  if (!fa || !fb) return;
  const dx = fb.x - fa.x, dy = fb.y - fa.y, d = Math.hypot(dx, dy) || 1;
  const ux = dx / d, uy = dy / d, s = 0.5 * sign;
  const push = (ci, dir, solo) => {
    if (ci != null && state.societies && state.societies.colonies[ci]) {
      for (const id of state.societies.colonies[ci].ids) { const f = sim.get(id); if (f && !f.dying) { f.vx += ux * s * dir; f.vy += uy * s * dir; } }
    } else {
      const f = sim.get(solo); if (f && !f.dying) { f.vx += ux * s * dir; f.vy += uy * s * dir; }
    }
  };
  const ca = state.societies ? state.societies.colonyOf.get(a) : undefined;
  const cb = state.societies ? state.societies.colonyOf.get(b) : undefined;
  push(ca, +1, a); push(cb, -1, b);
}
/** Weighted-modularity community detection (Louvain local-moving, single level). The live bond graph is
 *  sparse and chain-like, so plain connected-components would lump the whole swarm into ONE colony; this
 *  splits it into the tight little societies that actually exist. Deterministic: fixed id ordering +
 *  tie-break by smallest community id, so the same bonds always give the same partition. */
export function louvainCommunities(nodes, edges) {
  const adj = new Map();
  for (const id of nodes) adj.set(id, new Map());
  for (const e of edges) {
    if (!adj.has(e.a) || !adj.has(e.b) || e.a === e.b) continue;
    adj.get(e.a).set(e.b, (adj.get(e.a).get(e.b) || 0) + e.w);
    adj.get(e.b).set(e.a, (adj.get(e.b).get(e.a) || 0) + e.w);
  }
  const k = new Map(); let m2 = 0;                 // m2 = 2m = sum of weighted degrees
  for (const id of nodes) { let s = 0; for (const w of adj.get(id).values()) s += w; k.set(id, s); m2 += s; }
  const comm = new Map(); for (const id of nodes) comm.set(id, id);
  if (m2 <= 0) return comm;
  const order = [...nodes].sort((x, y) => x - y);
  for (let pass = 0; pass < 10; pass++) {
    let moved = false;
    for (const i of order) {
      const ci = comm.get(i), ki = k.get(i);
      const tot = new Map();
      for (const id of nodes) { const c = comm.get(id); tot.set(c, (tot.get(c) || 0) + k.get(id)); }
      const neighComm = new Map();
      for (const [j, w] of adj.get(i)) { const cj = comm.get(j); neighComm.set(cj, (neighComm.get(cj) || 0) + w); }
      const candidates = new Set(neighComm.keys()); candidates.add(ci);
      let bestC = ci, bestGain = -Infinity;
      for (const C of candidates) {
        const wIC = neighComm.get(C) || 0;
        let totC = tot.get(C) || 0;
        if (C === ci) totC -= ki;                   // i leaves its own community before re-joining
        const gain = (2 * wIC) / m2 - (2 * totC * ki) / (m2 * m2);
        if (gain > bestGain + 1e-12 || (Math.abs(gain - bestGain) <= 1e-12 && C < bestC)) { bestGain = gain; bestC = C; }
      }
      if (bestC !== ci) { comm.set(i, bestC); moved = true; }
    }
    if (!moved) break;
  }
  return comm;
}
/** TERRITORY (server-authoritative): the fixed 4×4 zone grid that REPLACES the client-side Louvain guess
 *  while the territory layer is on. Groups the living swarm by the home zone each fly sits in (the
 *  /population `zones` map: flyId → zone) and anchors every zone deterministically — zone z at column
 *  z mod 4, row ⌊z/4⌋ — so each house holds ONE fixed territory. Zone→house name/sigil/colour comes from
 *  the dynasty read-out (authoritative, every poll); a zone whose controller differs from the house whose
 *  members sit in it has been SEIZED (contested — only ever true after a Phase-2 conquest). Returns null
 *  when the layer is off (no zone map) so rebuildSocieties falls through to the byte-for-byte old path. */
export function territoryColonies() {
  if (!state.econZones) return null;
  const byZone = new Map();
  for (const key of Object.keys(state.econZones)) {
    const z = state.econZones[key];
    if (z == null || !Number.isFinite(z)) continue;
    const id = Number(key);
    if (!Number.isFinite(id)) continue;
    const zi = z | 0;
    let arr = byZone.get(zi); if (!arr) { arr = []; byZone.set(zi, arr); }
    arr.push(id);
  }
  if (!byZone.size) return null;
  // zone → the house that CONTROLS it, and zone → the house whose HOME it is, from the dynasty read-out
  const ctrl = new Map(), home = new Map();
  if (state.econDynasty && Array.isArray(state.econDynasty.houses)) {
    for (const h of state.econDynasty.houses) {
      if (!h) continue;
      if (Array.isArray(h.controlsZones)) for (const z of h.controlsZones) if (z != null) ctrl.set(z | 0, h);
      if (h.homeZone != null) home.set(h.homeZone | 0, h);
    }
  }
  // Authoritative zone→controller map from the server (bounded, ≤ zoneCount). This is what lets a zone seized
  // by a house OUTSIDE the prestige top-8 still recolour + read as contested: the trimmed `houses[]` never
  // carries that victor, so its `controlsZones` alone would leave the conquest invisible on the field.
  if (state.econDynasty && Array.isArray(state.econDynasty.zoneOwners)) {
    const byId = new Map();
    if (Array.isArray(state.econDynasty.houses)) for (const h of state.econDynasty.houses) if (h && h.id != null) byId.set(h.id, h);
    for (const zo of state.econDynasty.zoneOwners) {
      if (!zo || zo.zone == null) continue;
      ctrl.set(zo.zone | 0, byId.get(zo.houseId) || { id: zo.houseId, name: zo.name, sigil: zo.sigil });
    }
  }
  const zoneKeys = [...byZone.keys()].sort((a, b) => a - b);
  const COLS = 4, ROWS = Math.max(4, Math.ceil((zoneKeys[zoneKeys.length - 1] + 1) / COLS));   // 4×4 for ZONE_COUNT=16
  const dx = 0.72 / (COLS - 1), dy = ROWS > 1 ? 0.72 / (ROWS - 1) : 0;
  const colonies = [];
  for (const z of zoneKeys) {
    const ids = byZone.get(z).sort((a, b) => a - b);
    if (!ids.length) continue;
    const controller = ctrl.get(z) || null;                        // who OWNS the zone now (authoritative)
    const sitters = home.get(z) || houseOf.get(ids[0]) || null;    // whose members physically sit here
    const src = controller || sitters;
    const name = (src && src.name) ? src.name : ("Zone " + z);
    const sigil = (src && src.sigil) ? src.sigil : "";
    const color = (src && src.name ? houseColor(src.name) : null) || COLONY_COLORS[z % COLONY_COLORS.length];
    const contested = !!(controller && sitters && controller.name && controller.name !== sitters.name);
    colonies.push({
      ids, founder: ids[0], zone: z,
      ax: clamp(0.14 + dx * (z % COLS), 0.06, 0.94),
      ay: clamp(0.14 + dy * Math.floor(z / COLS), 0.06, 0.94),
      color, name: sigil ? (sigil + " " + name) : name, contested,
    });
  }
  const colonyOf = new Map();
  for (let i = 0; i < colonies.length; i++) for (const id of colonies[i].ids) colonyOf.set(id, i);
  return { colonies, colonyOf };
}
/** Rebuild the colony partition from the latest social read-out. Deterministic: the same bonds always
 *  yield the same colonies, anchors and colours, so the field never jitters between polls. */
export function rebuildSocieties() {
  const s = state.econSocial;
  if (!s || !Array.isArray(s.bonds) || !s.bonds.length) { state.societies = null; return; }
  const pairW = new Map();                          // undirected "lo:hi" → weight (max of both directions)
  const nodeSet = new Set(), feuds = [];
  for (const b of s.bonds) {
    if (!b || b.a == null || b.b == null || b.a === b.b) continue;
    const sc = typeof b.score === "number" ? b.score : 0;
    if (sc >= SOCIETY_BOND_MIN) {
      const key = Math.min(b.a, b.b) + ":" + Math.max(b.a, b.b);
      pairW.set(key, Math.max(pairW.get(key) || 0, sc));
      nodeSet.add(b.a); nodeSet.add(b.b);
    } else if (sc <= SOCIETY_FEUD_MAX) {
      feuds.push({ a: b.a, b: b.b, w: clamp(-sc) });
    }
  }
  // the grudge book is a feud even if the bond has since faded — surface it as a rift too
  if (Array.isArray(s.grudges)) for (const g of s.grudges) { if (g && g.buyerId != null && g.sellerId != null && g.buyerId !== g.sellerId) feuds.push({ a: g.buyerId, b: g.sellerId, w: 0.8 }); }
  const nodes = [...nodeSet].sort((x, y) => x - y);
  const edges = [...pairW.entries()].map(([key, w]) => { const p = key.split(":"); return { a: +p[0], b: +p[1], w }; });
  const allies = edges.map((e) => ({ a: e.a, b: e.b, w: clamp(e.w) }));
  // ---- TERRITORY (server-authoritative): a fixed 4×4 zone grid replaces the Louvain-on-bonds partition
  //      below whenever the /population feed carries per-fly home zones. allies/feuds (the relationship
  //      lines) are shared by both paths. Zone map absent (layer off) ⇒ fall through, byte-for-byte. ----
  const terr = territoryColonies();
  if (terr) {
    state.societies = { colonies: terr.colonies, allies, feuds, colonyOf: terr.colonyOf };
    state.focusCacheId = null;
    if (state.selectedId != null) refreshInspectorSocial(state.selectedId);
    return;
  }
  // weighted-modularity communities ⇒ colonies (a lone fly is not a society)
  const comm = louvainCommunities(nodes, edges);
  const groups = new Map();
  for (const id of nodes) { const c = comm.get(id); if (!groups.has(c)) groups.set(c, []); groups.get(c).push(id); }
  const colonies = [];
  for (const ids of groups.values()) {
    if (ids.length < 2) continue;
    ids.sort((x, y) => x - y);
    colonies.push({ ids, founder: ids[0] });
  }
  colonies.sort((p, q) => p.founder - q.founder);
  // deterministic, collision-free home anchors on a 4×3 grid (linear-probe on a hash clash) + a distinct
  // colour per colony, so the societies spread across the field instead of piling onto one spot
  const SLOTS = [];
  for (let r = 0; r < 3; r++) for (let c = 0; c < 4; c++) SLOTS.push([0.16 + 0.226 * c, 0.22 + 0.28 * r]);
  const taken = new Set();
  for (let i = 0; i < colonies.length; i++) {
    const col = colonies[i], h = fnv1a("colony:" + col.founder);
    let si = h % SLOTS.length; while (taken.has(si)) si = (si + 1) % SLOTS.length; taken.add(si);
    const jx = ((h >>> 8) % 100) / 100 - 0.5, jy = ((h >>> 16) % 100) / 100 - 0.5;
    col.ax = clamp(SLOTS[si][0] + jx * 0.05, 0.06, 0.94);
    col.ay = clamp(SLOTS[si][1] + jy * 0.05, 0.06, 0.94);
    col.color = COLONY_COLORS[i % COLONY_COLORS.length];
    col.name = COLONY_NAMES[i % COLONY_NAMES.length];
  }
  const colonyOf = new Map();
  for (let i = 0; i < colonies.length; i++) for (const id of colonies[i].ids) colonyOf.set(id, i);
  state.societies = { colonies, allies, feuds, colonyOf };
  state.focusCacheId = null;                                  // the partition moved → rebuild the highlight set
  if (state.selectedId != null) refreshInspectorSocial(state.selectedId);
}
/** Smooth organic boundary hugging a colony's living members: angular-bin the member radii around the
 *  live centroid, interpolate + smooth the empty bins, pad outward, and return a closed point ring. */
export function colonyBlob(pts, others, scr) {
  let cx = 0, cy = 0; for (const p of pts) { cx += p.x; cy += p.y; } cx /= pts.length; cy /= pts.length;
  const BINS = 28, MINR = 44;
  const rad = scr.rad.fill(0), sm = scr.sm, P = scr.P;
  for (const p of pts) {
    const dx = p.x - cx, dy = p.y - cy, d = Math.hypot(dx, dy);
    let bi = Math.floor(((Math.atan2(dy, dx) + Math.PI) / TAU) * BINS) % BINS; if (bi < 0) bi += BINS;
    if (d > rad[bi]) rad[bi] = d;
  }
  // fill empty angular bins from their neighbours so the outline stays closed and organic
  for (let pass = 0; pass < 3; pass++) for (let i = 0; i < BINS; i++) if (rad[i] <= 0) rad[i] = Math.max(rad[(i - 1 + BINS) % BINS], rad[(i + 1) % BINS]) * 0.9 || MINR;
  for (let i = 0; i < BINS; i++) rad[i] = Math.max(rad[i], MINR * 0.6);
  // circular smoothing so the territory reads as one soft body, not a star (scratch-reused, no alloc)
  for (let pass = 0; pass < 2; pass++) {
    for (let i = 0; i < BINS; i++) sm[i] = (rad[(i - 1 + BINS) % BINS] + rad[i] * 2 + rad[(i + 1) % BINS]) / 4;
    for (let i = 0; i < BINS; i++) rad[i] = sm[i];
  }
  let rmax = 0;
  for (let i = 0; i < BINS; i++) {
    const a = (i / BINS) * TAU - Math.PI;
    let r = rad[i] + SOCIETY_PAD;
    // exclusive jurisdiction: cap at the bisector toward every other colony (Voronoi), minus a gap
    if (others) for (const o of others) {
      const dx = o.x - cx, dy = o.y - cy, D = Math.hypot(dx, dy);
      if (D < 1) continue;
      const cosT = (Math.cos(a) * dx + Math.sin(a) * dy) / D;
      if (cosT <= 0.2) continue;
      const cap = (D / 2 - SOCIETY_CAP_GAP) / cosT;
      if (cap < r) r = cap;
    }
    r = Math.max(r, SOCIETY_MINCAP);
    if (r > rmax) rmax = r;
    const q = P[i]; q[0] = cx + Math.cos(a) * r; q[1] = cy + Math.sin(a) * r;
  }
  return { cx, cy, rmax };
}
/** Trace a smooth closed curve through a point ring (quadratic through edge midpoints) onto a target
 *  (a CanvasRenderingContext2D or a Path2D). */
export function traceBlob(t, P) {
  const n = P.length;
  if (t.beginPath) t.beginPath();
  t.moveTo((P[0][0] + P[n - 1][0]) / 2, (P[0][1] + P[n - 1][1]) / 2);
  for (let i = 0; i < n; i++) { const cur = P[i], nxt = P[(i + 1) % n]; t.quadraticCurveTo(cur[0], cur[1], (cur[0] + nxt[0]) / 2, (cur[1] + nxt[1]) / 2); }
  t.closePath();
}
/** A deterministic jagged "crack" polyline between two feuding flies (stable frame to frame). */
export function traceCrack(a, b) {
  const dx = b.x - a.x, dy = b.y - a.y, d = Math.hypot(dx, dy) || 1;
  const px = -dy / d, py = dx / d;
  const segs = Math.max(4, Math.round(d / 26));
  const seed = fnv1a("crack:" + Math.min(a.id, b.id) + ":" + Math.max(a.id, b.id));
  state.ctx.beginPath(); state.ctx.moveTo(a.x, a.y);
  for (let i = 1; i < segs; i++) {
    const t = i / segs;
    const j = ((((seed >>> (i % 24)) & 0xff) / 255) - 0.5) * 16;
    state.ctx.lineTo(a.x + dx * t + px * j, a.y + dy * t + py * j);
  }
  state.ctx.lineTo(b.x, b.y);
}
/** Draw the societies: a clearly-bounded organic territory per colony (filled + outlined + labelled),
 *  a gold bond web inside each colony, and red conflict cracks between feuding flies. Beneath the flies. */
export function renderSocieties(pal, now) {
  if (!state.showSocieties || !state.societies || !state.societies.colonies.length) return;
  const foc = currentFocus();
  const focCol = foc != null ? state.societies.colonyOf.get(foc) : undefined;
  // 1) bounded territories hugging each colony's live members.
  //    The outline ring is recomputed EVERY frame (cheap bin math on reused scratch buffers, zero
  //    allocation) so the border tracks members smoothly at 60fps; only the radial glow gradient —
  //    the genuinely expensive object — is cached and rebuilt ~15Hz / on centroid move.
  //    PERF: when the static TERRITORY MAP is on (the default), it already paints every house's dominion
  //    with a richer hatched map, so these live-tracking blobs are redundant AND were the last uncached
  //    per-frame cost (colonyBlob + Voronoi + gradient + measureText + shield labels) able to nudge
  //    frameMsAvg over the 30ms budget and collapse fly anatomy to comma-blobs. Skip them while
  //    the map is shown; keep the bond/feud lines below (which the map doesn't carry). Turn the map off to
  //    restore the classic live-societies view.
  const cents = state.societies.colonies.map((c) => { let x = 0, y = 0, n = 0; for (const id of c.ids) { const f = sim.get(id); if (f && !f.dying) { x += f.x; y += f.y; n++; } } return { x: n ? x / n : 0, y: n ? y / n : 0, n }; });
  for (let ci = 0; !state.showTerritory && ci < state.societies.colonies.length; ci++) {
    const c = state.societies.colonies[ci];
    const pts = c._pts || (c._pts = []);
    pts.length = 0;
    for (const id of c.ids) { const f = sim.get(id); if (f && !f.dying) pts.push(f); }
    if (pts.length < 2) continue;
    const scr = c._scr || (c._scr = { rad: new Array(28).fill(0), sm: new Array(28).fill(0), P: Array.from({ length: 28 }, () => [0, 0]) });
    const blob = colonyBlob(pts, cents.filter((o, k) => k !== ci && o.n >= 2), scr);
    let glow = c._glow;
    if (!glow || (now - glow.t > 66) || Math.hypot(blob.cx - glow.cx, blob.cy - glow.cy) > 3) {
      const grad = state.ctx.createRadialGradient(blob.cx, blob.cy, 0, blob.cx, blob.cy, blob.rmax);
      grad.addColorStop(0, rgba(c.color, 0.10)); grad.addColorStop(1, rgba(c.color, 0));
      glow = c._glow = { grad, cx: blob.cx, cy: blob.cy, rmax: blob.rmax, t: now };
    }
    const cdim = (foc != null && ci !== focCol) ? 0.18 : 1;   // focus highlight: fade the other colonies
    traceBlob(state.ctx, scr.P);
    state.ctx.fillStyle = rgba(c.color, 0.13 * cdim); state.ctx.fill();
    state.ctx.strokeStyle = rgba(c.color, 0.55 * cdim); state.ctx.lineWidth = 1.4; state.ctx.stroke();
    // a SEIZED zone (territory conquered in war): the members sitting here no longer control it — ring the
    // territory in dashed crimson over the owner's hue so the occupation reads at a glance. Guarded by
    // c.contested, which is always false until a Phase-2 conquest flips a zone's controller.
    if (c.contested) {
      state.ctx.save(); state.ctx.setLineDash([5, 4]); state.ctx.lineWidth = 2;
      state.ctx.strokeStyle = rgba([196, 62, 48], 0.85 * cdim); traceBlob(state.ctx, scr.P); state.ctx.stroke(); state.ctx.restore();
    }
    // soft inner glow for depth (cached gradient)
    if (cdim >= 1) { state.ctx.fillStyle = glow.grad; state.ctx.fill(); }
    // the colony's heraldic plate: a small shield in the colony hue + its initial, then the name in Roman caps
    state.ctx.save();
    state.ctx.textBaseline = "middle";
    const label = `${c.name} · ${pts.length}`;
    state.ctx.font = "600 12px Cinzel, Fraunces, Georgia, serif";
    const crestW = 13, gap = 6;
    const total = crestW + gap + state.ctx.measureText(label).width;
    const lx = blob.cx - total / 2, by = blob.cy - blob.rmax - 12;
    state.ctx.beginPath();
    state.ctx.moveTo(lx, by - 6); state.ctx.lineTo(lx + crestW, by - 6); state.ctx.lineTo(lx + crestW, by + 2);
    state.ctx.quadraticCurveTo(lx + crestW, by + 7, lx + crestW / 2, by + 8);
    state.ctx.quadraticCurveTo(lx, by + 7, lx, by + 2); state.ctx.closePath();
    state.ctx.fillStyle = rgba(c.color, 0.92 * cdim); state.ctx.fill();
    state.ctx.lineWidth = 1; state.ctx.strokeStyle = rgba(GILT, 0.7 * cdim); state.ctx.stroke();
    state.ctx.textAlign = "center"; state.ctx.font = "700 8px Cinzel, Fraunces, serif";
    state.ctx.fillStyle = rgba([248, 244, 236], 0.95 * cdim); state.ctx.fillText(String(c.name).charAt(0), lx + crestW / 2, by + 1);
    state.ctx.textAlign = "left"; state.ctx.font = "600 12px Cinzel, Fraunces, Georgia, serif";
    state.ctx.fillStyle = rgba(c.color, 0.92 * cdim); state.ctx.fillText(label, lx + crestW + gap, by);
    state.ctx.restore();
  }
  // 2) gold bond web inside colonies (the alliances that define each society)
  for (const p of state.societies.allies) {
    const a = sim.get(p.a), b = sim.get(p.b); if (!a || a.dying || !b || b.dying) continue;
    const inv = foc != null && (p.a === foc || p.b === foc);
    const ed = foc == null ? 1 : (inv ? 1 : 0.10);
    state.ctx.lineWidth = inv ? 1.6 : 1.1;
    state.ctx.strokeStyle = rgba(GOLD_THREAD, (0.30 + p.w * 0.35) * ed);
    state.ctx.beginPath(); state.ctx.moveTo(a.x, a.y); state.ctx.lineTo(b.x, b.y); state.ctx.stroke();
  }
  // 3) red conflict cracks between feuding flies
  for (const p of state.societies.feuds) {
    const a = sim.get(p.a), b = sim.get(p.b); if (!a || a.dying || !b || b.dying) continue;
    if (Math.hypot(a.x - b.x, a.y - b.y) > 380) continue;
    const inv = foc != null && (p.a === foc || p.b === foc);
    const ed = foc == null ? 1 : (inv ? 1 : 0.10);
    state.ctx.lineWidth = inv ? 1.7 : 1.3;
    state.ctx.strokeStyle = rgba(CRACK_RED, 0.5 * ed);
    traceCrack(a, b); state.ctx.stroke();
  }
}
// ================= TERRITORY MAP: every house a dominion on the field (a Three-Kingdoms-style partition) ======
// A pure client-side VISUALISATION of the LIVE dynasty membership (houseOf: flyId → {name,sigil,color}), so it
// renders WITHOUT arming the economic territory switch — it draws no server zone state, moves no money and never
// touches the sim. Each house's living members are hugged by an organic blob, Voronoi-capped against every other
// house (colonyBlob) so the dominions are mutually exclusive, then painted map-style: a saturated fill + a cached
// diagonal hatch + a double ink border, a big engraved serif name, a capital glyph, two rivers and a map key.
// Toggle #territory (default OFF ⇒ the field is byte-for-byte today's). When the server zone grid IS armed the two
// agree, because both key a territory to the same house.
export function rebuildTerritoryPolities() {
  const byName = new Map();
  for (const [id, h] of houseOf) {
    if (!h || !h.name) continue;
    let a = byName.get(h.name);
    if (!a) { a = { name: h.name, sigil: h.sigil || "", color: h.color || houseColor(h.name) || COLONY_COLORS[0], ids: [] }; byName.set(h.name, a); }
    a.ids.push(id);
  }
  const polities = [...byName.values()].sort((x, y) => (x.name < y.name ? -1 : x.name > y.name ? 1 : 0));
  for (const p of polities) {
    p.ids.sort((a, b) => a - b);
    p._scr = { rad: new Array(28).fill(0), sm: new Array(28).fill(0), P: Array.from({ length: 28 }, () => [0, 0]) };
    p._pts = []; p._hatch = null;
    p.occupied = false; p.occupiedBy = "";
  }
  // WAR SEIZURE (server-authoritative): a polity reads as OCCUPIED when another house CONTROLS a zone its own
  // members physically sit in. econZones (flyId→homeZone) × houseOf (flyId→name) say who sits where; the
  // dynasty read-out's zoneOwners (zone→controller) says who HOLDS it. Differ ⇒ conquest. This is what lets the
  // dominion map change after a war even though membership itself never moves, and — unlike the live-societies
  // contested ring (skipped whenever the map is on) — it is the seizure visual the default deployment actually shows.
  state.territorySeizureSig = "";
  const owners = (state.econDynasty && Array.isArray(state.econDynasty.zoneOwners)) ? state.econDynasty.zoneOwners : null;
  if (owners && state.econZones) {
    const zoneCtrl = new Map();
    for (const zo of owners) if (zo && zo.zone != null) zoneCtrl.set(zo.zone | 0, zo.name);
    const sit = new Map();                                   // zone → the set of house names sitting there
    for (const key of Object.keys(state.econZones)) {
      const z = state.econZones[key];
      if (z == null || !Number.isFinite(z)) continue;
      const ho = houseOf.get(Number(key));
      if (!ho || !ho.name) continue;
      let s = sit.get(z | 0); if (!s) { s = new Set(); sit.set(z | 0, s); }
      s.add(ho.name);
    }
    for (const [z, names] of sit) {
      const ctrl = zoneCtrl.get(z);
      if (!ctrl) continue;
      for (const n of names) if (n !== ctrl) { const pol = byName.get(n); if (pol) { pol.occupied = true; pol.occupiedBy = ctrl; } }
    }
    state.territorySeizureSig = polities.filter((p) => p.occupied).map((p) => p.name + "<" + p.occupiedBy).sort().join(",");
  }
  state.territories = polities.length ? polities : null;
}
/** A cached diagonal-line pattern in the polity's hue, laid over the fill for the map's engraved texture.
 *  Built on the target context `g` (the offscreen map canvas) so the pattern is valid where it's used. */
export function makeHatch(g, color) {
  const c = document.createElement("canvas"); c.width = c.height = 8;
  const hg = c.getContext("2d");
  hg.strokeStyle = rgba(mix(color, [255, 255, 255], 0.22), 0.15); hg.lineWidth = 1.3;
  hg.beginPath(); hg.moveTo(-2, 10); hg.lineTo(10, -2); hg.moveTo(2, 14); hg.lineTo(14, 2); hg.stroke();
  return g.createPattern(c, "repeat");
}
/** Two deterministic meandering "rivers" across the field — pure parchment decoration, seeded once. */
export function drawRivers(g) {
  g.save(); g.lineCap = "round";
  const RIVER = [104, 140, 176];
  for (let r = 0; r < 2; r++) {
    const ph = (fnv1a("river:" + r) % 360) * Math.PI / 180;
    const yb = state.VH * (r ? 0.66 : 0.34), amp = state.VH * 0.07;
    g.beginPath();
    for (let i = 0; i <= 44; i++) {
      const t = i / 44, x = t * state.VW, y = yb + Math.sin(t * 5 + ph + r) * amp + Math.sin(t * 13 + ph) * amp * 0.28;
      if (i === 0) g.moveTo(x, y); else g.lineTo(x, y);
    }
    g.strokeStyle = rgba(RIVER, 0.15); g.lineWidth = 4.2; g.stroke();
    g.strokeStyle = rgba(mix(RIVER, [255, 255, 255], 0.4), 0.22); g.lineWidth = 1.3; g.stroke();
  }
  g.restore();
}
/** A deterministic 0..1 flicker in [lo,hi] from a time + seed — cheap stand-in for real noise. */
export function flick(now, ph, hz, lo, hi) {
  const v = 0.5 + 0.5 * Math.sin(now * hz + ph) * Math.sin(now * hz * 0.63 + ph * 1.7);
  return lo + (hi - lo) * clamp(v);
}
/** A polity's capital position: the map's FIXED seat when present (so the stronghold aligns with the baked
 *  name label), else the live swarm centroid as a fallback (e.g. the very first frames before a map rebuild). */
export function politySeat(p) {
  if (p.seat) return { x: p.seat.x, y: p.seat.y, n: p.ids.length };
  let sx = 0, sy = 0, n = 0;
  for (const id of p.ids) { const f = sim.get(id); if (f && !f.dying) { sx += f.x; sy += f.y; n++; } }
  return n ? { x: sx / n, y: sy / n, n } : null;
}
export function renderLandLife(pal, now) {
  if (!state.showTerritory || !state.territories || !state.territories.length) return;   // the living diorama belongs to the dominion map
  const q = state.qualityCoeff;
  if (!TEX.ground.ready) riverShimmer(now, q);   // procedural river glints only until the painted plain loads
  // gather the live capitals once — reused by the march roads and the stronghold/landmark pass
  const seats = [];
  for (const p of state.territories) { if (seats.length >= 10) break; const s = politySeat(p); if (s) seats.push({ p, s }); }
  if (!seats.length) return;
  if (q > 0.3) drawMarchRoutes(seats, now, q);    // torch-lit columns marching between the capitals
  // The decorative stronghold, banner, beacon and hearth were RETIRED here: the real settlements now carry the
  // town visual, and each house's seat markers ride its home settlement in renderCivilization (⑭, showCities).
  if (q > 0.3) drawFlock(now);
}
/** Rolling ground fog drifting low across the plain — a screen-blended band of the mist texture, tiled to wrap.
 *  Screen-space (it layers over the static backdrop), and only near full quality (a full-width
 *  screen-blend is expensive, so weak machines skip it rather than let it collapse the swarm's detail). */
export function drawGroundFog(now, q) {
  if (q <= 0.6 || !TEX.mist.ready) return;
  const im = TEX.mist.im;
  state.ctx.save();
  state.ctx.globalCompositeOperation = "screen";
  const off = (now * 0.006) % state.VW;
  const y = state.VH * 0.52, h = state.VH * 0.5;
  state.ctx.globalAlpha = 0.075;
  state.ctx.drawImage(im, -off, y, state.VW, h);
  state.ctx.drawImage(im, state.VW - off, y, state.VW, h);
  state.ctx.restore();
}
/** Golden-hour light shafts raking down over the whole field — a screen-blended, slowly swaying god-ray plate.
 *  Near-full-quality only, kept faint so it grades the scene without washing out the swarm. */
export function drawGodRays(now, q) {
  if (q <= 0.6 || !TEX.rays.ready) return;
  const im = TEX.rays.im;
  state.ctx.save();
  state.ctx.globalCompositeOperation = "screen";
  const sway = Math.sin(now * 0.00007) * 0.04;
  state.ctx.globalAlpha = 0.10 + 0.04 * Math.sin(now * 0.0004);
  state.ctx.drawImage(im, -state.VW * 0.08 + sway * state.VW, -state.VH * 0.06, state.VW * 1.16, state.VH * 1.12);
  state.ctx.restore();
}
// drawCity (the decorative provincial stronghold) was RETIRED — the real econCities settlements now carry the
// town visual, and the house seat markers ride them in renderCivilization. See that layer for the replacement.
/** A closed march network between the capitals: a faint road each, with a column of torch glints marching along it. */
export function drawMarchRoutes(seats, now, q) {
  if (seats.length < 2) return;
  let cx = 0, cy = 0; for (const o of seats) { cx += o.s.x; cy += o.s.y; } cx /= seats.length; cy /= seats.length;
  const ord = seats.slice().sort((a, b) => Math.atan2(a.s.y - cy, a.s.x - cx) - Math.atan2(b.s.y - cy, b.s.x - cx));
  const n = ord.length, dots = q > 0.6 ? 8 : 5;
  state.ctx.save(); state.ctx.lineCap = "round";
  for (let i = 0; i < n; i++) {
    const a = ord[i].s, b = ord[(i + 1) % n].s;
    const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2, dx = b.x - a.x, dy = b.y - a.y, len = Math.hypot(dx, dy) || 1;
    const ctrlx = mx - dy / len * len * 0.12, ctrly = my + dx / len * len * 0.12;   // a gentle bow
    state.ctx.strokeStyle = rgba([120, 96, 64], 0.12); state.ctx.lineWidth = 2;
    state.ctx.beginPath(); state.ctx.moveTo(a.x, a.y); state.ctx.quadraticCurveTo(ctrlx, ctrly, b.x, b.y); state.ctx.stroke();
    const ph = (fnv1a("march:" + i) % 1000) / 1000;
    for (let k = 0; k < dots; k++) {
      const t = ((now * 0.00006 + k / dots + ph) % 1), it = 1 - t;
      const px = it * it * a.x + 2 * it * t * ctrlx + t * t * b.x, py = it * it * a.y + 2 * it * t * ctrly + t * t * b.y;
      const fl = 0.7 + 0.3 * Math.sin(now * 0.02 + k * 1.7);
      state.ctx.fillStyle = rgba(FIRE_MID, 0.07 * fl); state.ctx.beginPath(); state.ctx.arc(px, py, 3, 0, TAU); state.ctx.fill();
      state.ctx.fillStyle = rgba(FIRE_HOT, 0.55 * fl); state.ctx.beginPath(); state.ctx.arc(px, py, 0.9, 0, TAU); state.ctx.fill();
    }
  }
  state.ctx.restore();
}
/** A compact pennant flying off the keep — a short pole with a small cloth rippling in the wind, in house colours. */
export function drawBanner(p, s, now) {
  const ph = (fnv1a("banner:" + p.name) % 1000) / 1000 * TAU;
  const px = s.x + 6, py = s.y - 18, pole = 13, w = 13, h = 8;   // perched on the stronghold, not a lone tall pole
  state.ctx.save();
  state.ctx.lineCap = "round";
  state.ctx.strokeStyle = rgba(mix(INK, [70, 52, 30], 0.5), 0.7); state.ctx.lineWidth = 1.4;
  state.ctx.beginPath(); state.ctx.moveTo(px, py); state.ctx.lineTo(px, py - pole); state.ctx.stroke();
  // the cloth: a quad whose right edge flutters; we stroke a few vertical ribs so the wave reads as fabric
  const topY = py - pole + 1;
  state.ctx.beginPath(); state.ctx.moveTo(px, topY);
  const steps = 6, pts = [];
  for (let i = 0; i <= steps; i++) {
    const t = i / steps, cx = px + t * w;
    const cy = topY + Math.sin(now * 0.006 + ph + t * 4.2) * (1.6 + t * 2.6);
    pts.push([cx, cy]);
  }
  for (const [cx, cy] of pts) state.ctx.lineTo(cx, cy);
  for (let i = steps; i >= 0; i--) {
    const t = i / steps, cx = px + t * w;
    const cy = topY + h + Math.sin(now * 0.006 + ph + t * 4.2) * (1.6 + t * 2.6);
    state.ctx.lineTo(cx, cy);
  }
  state.ctx.closePath();
  state.ctx.fillStyle = rgba(mix(p.color, [250, 246, 236], 0.28), 0.82); state.ctx.fill();
  state.ctx.strokeStyle = rgba(mix(p.color, INK, 0.5), 0.6); state.ctx.lineWidth = 0.8; state.ctx.stroke();
  if (p.sigil) {
    state.ctx.fillStyle = rgba(INK, 0.85); state.ctx.textAlign = "center"; state.ctx.textBaseline = "middle";
    state.ctx.font = "700 9px 'Fraunces', Georgia, serif";
    state.ctx.fillText(String(p.sigil).slice(0, 1), px + w * 0.5, topY + h * 0.5 + 1);
  }
  state.ctx.restore();
}
/** A thin column of hearth-smoke rising and dissipating above a peaceful capital. */
export function drawHearth(p, s, now, q) {
  const ph = (fnv1a("hearth:" + p.name) % 1000) / 1000 * 100;
  const puffs = q > 0.6 ? 4 : 2;
  state.ctx.save();
  for (let i = 0; i < puffs; i++) {
    const life = ((now * 0.00012 + i / puffs + ph) % 1);
    const ry = s.y - 6 - life * 26;                        // rises
    const rx = s.x + Math.sin(life * 5 + i + ph) * (2 + life * 5);   // drifts sideways
    const rr = 1.5 + life * 5;
    state.ctx.fillStyle = rgba(SMOKE, (1 - life) * 0.16);        // fades as it climbs
    state.ctx.beginPath(); state.ctx.arc(rx, ry, rr, 0, TAU); state.ctx.fill();
  }
  state.ctx.restore();
}
/** A beacon tower with a flickering fire + smoke on SEIZED ground, plus a pulsing signal ring — the war front made visible. */
export function drawBeacon(p, s, now, q) {
  const bx = s.x, by = s.y - 8;
  state.ctx.save();
  // the stone tower
  state.ctx.fillStyle = rgba(mix(INK, [92, 74, 54], 0.55), 0.8);
  state.ctx.beginPath(); state.ctx.moveTo(bx - 5, by); state.ctx.lineTo(bx + 5, by); state.ctx.lineTo(bx + 3.4, by - 12); state.ctx.lineTo(bx - 3.4, by - 12); state.ctx.closePath(); state.ctx.fill();
  const ftop = by - 12;
  const flame = flick(now, (fnv1a("fire:" + p.name) % 100) / 10, 0.02, 0.75, 1.25);
  if (q > 0.3) {
    // warm glow halo
    const gr = state.ctx.createRadialGradient(bx, ftop, 0, bx, ftop, 20 * flame);
    gr.addColorStop(0, rgba(FIRE_HOT, 0.5)); gr.addColorStop(0.4, rgba(FIRE_MID, 0.26)); gr.addColorStop(1, rgba(FIRE_LO, 0));
    state.ctx.fillStyle = gr; state.ctx.beginPath(); state.ctx.arc(bx, ftop, 20 * flame, 0, TAU); state.ctx.fill();
  }
  // the fire tongue (a tapered flame stretched by the flicker)
  state.ctx.fillStyle = rgba(FIRE_MID, 0.9);
  state.ctx.beginPath(); state.ctx.moveTo(bx - 3, ftop);
  state.ctx.quadraticCurveTo(bx - 1.2, ftop - 8 * flame, bx, ftop - 13 * flame);
  state.ctx.quadraticCurveTo(bx + 1.2, ftop - 8 * flame, bx + 3, ftop); state.ctx.closePath(); state.ctx.fill();
  state.ctx.fillStyle = rgba(FIRE_HOT, 0.95);
  state.ctx.beginPath(); state.ctx.moveTo(bx - 1.4, ftop);
  state.ctx.quadraticCurveTo(bx, ftop - 5 * flame, bx + 1.4, ftop); state.ctx.closePath(); state.ctx.fill();
  // black smoke above the flame
  const puffs = q > 0.6 ? 4 : 2;
  for (let i = 0; i < puffs; i++) {
    const life = ((now * 0.00016 + i / puffs) % 1);
    state.ctx.fillStyle = rgba([70, 64, 58], (1 - life) * 0.34);
    state.ctx.beginPath(); state.ctx.arc(bx + Math.sin(life * 6 + i) * (2 + life * 6), ftop - 12 - life * 30, 1.6 + life * 5, 0, TAU); state.ctx.fill();
  }
  // a slow pulse ring announcing the hot front line (expands + fades every ~3.2s)
  const pulse = (now % 3200) / 3200;
  state.ctx.strokeStyle = rgba(FIRE_LO, (1 - pulse) * 0.4); state.ctx.lineWidth = 1.6 * (1 - pulse) + 0.3;
  state.ctx.beginPath(); state.ctx.arc(bx, ftop, 6 + pulse * 46, 0, TAU); state.ctx.stroke();
  state.ctx.restore();
}
/** A handful of white glints drifting along the two deterministic rivers — the water catching the light. */
export function riverShimmer(now, q) {
  const RIVER = [104, 140, 176];
  const n = q > 0.6 ? 7 : 4;
  state.ctx.save();
  for (let r = 0; r < 2; r++) {
    const ph = (fnv1a("river:" + r) % 360) * Math.PI / 180;
    const yb = state.VH * (r ? 0.66 : 0.34), amp = state.VH * 0.07;
    for (let i = 0; i < n; i++) {
      const t = ((now * 0.00003 + (i / n) + r * 0.13) % 1);
      const x = t * state.VW, y = yb + Math.sin(t * 5 + ph + r) * amp + Math.sin(t * 13 + ph) * amp * 0.28;
      const tw = 0.4 + 0.6 * Math.abs(Math.sin(now * 0.004 + i * 1.7 + r));
      state.ctx.fillStyle = rgba(mix(RIVER, [255, 255, 255], 0.7), 0.16 * tw);
      state.ctx.beginPath(); state.ctx.ellipse(x, y, 3.2 * tw + 0.6, 0.9, 0, 0, TAU); state.ctx.fill();
    }
  }
  state.ctx.restore();
}
/** A lone V-shaped flock drifting across the top of the map, wrapping off-screen — pure slow ambience. */
export function drawFlock(now) {
  const span = state.VW + 320;
  const lead = ((now * 0.012) % span) - 160;             // left→right, re-enters from the left
  const baseY = state.VH * 0.22 + Math.sin(now * 0.0006) * state.VH * 0.05;
  const bob = Math.sin(now * 0.012) * 2;
  state.ctx.save();
  state.ctx.strokeStyle = rgba(mix(INK, [90, 84, 74], 0.4), 0.4); state.ctx.lineWidth = 1.1; state.ctx.lineCap = "round";
  for (let i = 0; i < 7; i++) {
    const row = i - 3;
    const bx = lead - Math.abs(row) * 13, by = baseY + row * 6 + Math.sin(now * 0.012 + i) * 2;
    const w = 5, flap = 2 + bob * (i % 2 ? 1 : -1) * 0.4;
    state.ctx.beginPath(); state.ctx.moveTo(bx - w, by); state.ctx.quadraticCurveTo(bx, by - flap, bx, by);
    state.ctx.quadraticCurveTo(bx, by - flap, bx + w, by); state.ctx.stroke();
  }
  state.ctx.restore();
}
/** A zone's world anchor — the SAME force-field spot updateSim pulls that zone's kin toward (smx + ax·(VW−2smx),
 *  ax/ay the territoryColonies grid), so a settlement is drawn inside the swarm that is its people, never adrift
 *  in the sea or on another continent the way a raw mw() of the abstract grid would drop it. */
export function zoneAnchor(z) {
  const smx = Math.max(96, Math.round(state.VW * 0.21)), smy = Math.max(88, Math.round(state.VH * 0.19));
  const ax = clamp(0.14 + 0.24 * (z % 4), 0.06, 0.94);
  const ay = clamp(0.14 + 0.24 * Math.floor(z / 4), 0.06, 0.94);
  return { x: smx + ax * (state.VW - 2 * smx), y: smy + ay * (state.VH - 2 * smy) };
}
/** The bake key: viewport + DPR, then one token per settlement (zone:rank:pop-bucket:house), per standing work
 *  (kind:era:age-bucket) and the road's two names — so routine ±1 pop jitter never forces a heavy repaint, but a
 *  founding, a rank step, a conquest, a new work or its weathering does. */
export function civSignature(C) {
  // quality enters the bake key DISCRETISED (a single flip at 0.6): the coefficient is a continuous EMA, so
  // keying on the raw value would invalidate the offscreen bake on nearly every frame and re-render it.
  let s = state.VW + "x" + state.VH + "@" + state.DPR + ":q" + (state.qualityCoeff > 0.6 ? 1 : 0) + ":c" + Math.round(((state.chronMeta && state.chronMeta.civLevel) || 50) / 25) + ":t" + (state.showTerritory ? 1 : 0);
  for (const st of C.settlements) s += "|" + st.zone + ":" + st.rank + ":" + Math.min(14, st.pop | 0) + ":" + (st.houseName || "");
  const W = state.econWorks;
  if (W && Array.isArray(W.active)) for (const w of W.active) {
    const age = clamp(((state.lastTickIndex ?? 0) - Math.max(w.raisedTick | 0, w.lastRepairTick | 0)) / WK_AGE_TICKS, 0, 1);
    s += "|" + w.kind + ":" + (w.raisedEra | 0) + ":" + (age * 4 | 0);
  }
  if (C.road) s += "|" + C.road.a + "-" + C.road.b;
  return s;
}
/** One house in the offscreen, city-builder read: a sun-baked mudbrick block with an oblique side face and a
 *  sunlit roof terrace (pseudo-3D depth), tinted at the wall with the holding house's colour so a town reads as
 *  its family's. A deterministic variant crowns it — whitewashed dome, terracotta awning, pitched tile or parapet. */
export function civBuilding(g, x, y, w, h, color, city) {
  g.fillStyle = rgba(CIV_SHADOW, 0.18);
  g.beginPath(); g.ellipse(x - w * 0.2, y + h * 0.16, w * 0.85, h * 0.34, 0, 0, TAU); g.fill();
  const wall = mix(MUD, color, 0.16);
  const ox = w * 0.22, oy = h * 0.2;                       // the oblique depth offset (bird's-eye pseudo-3D)
  g.fillStyle = rgba(mix(wall, INK, 0.3), 0.95);           // the shaded side face
  g.beginPath(); g.moveTo(x + w / 2, y - h); g.lineTo(x + w / 2 + ox, y - h - oy); g.lineTo(x + w / 2 + ox, y - oy); g.lineTo(x + w / 2, y); g.closePath(); g.fill();
  g.fillStyle = rgba(wall, 0.97); g.fillRect(x - w / 2, y - h, w, h);   // the sunlit front face
  g.fillStyle = rgba(mix(MUD_HI, color, 0.1), 0.97);       // the roof terrace, lit from above
  g.beginPath(); g.moveTo(x - w / 2, y - h); g.lineTo(x - w / 2 + ox, y - h - oy); g.lineTo(x + w / 2 + ox, y - h - oy); g.lineTo(x + w / 2, y - h); g.closePath(); g.fill();
  g.fillStyle = rgba(mix(wall, [255, 246, 224], 0.5), 0.5); g.fillRect(x - w / 2, y - h, w, 0.9);   // parapet light
  const v = fnv1a((x | 0) + ":" + (y | 0)) % 4;            // one deterministic crown per plot
  if (v === 0) {   // a whitewashed dome
    g.fillStyle = rgba(mix(MUD_HI, [255, 252, 244], 0.35), 0.95);
    g.beginPath(); g.arc(x + ox * 0.4, y - h - oy * 0.7, w * 0.3, Math.PI, 0); g.closePath(); g.fill();
  } else if (v === 1) {   // a terracotta awning over the street
    g.fillStyle = rgba(TERRA, 0.85); g.fillRect(x - w / 2 - 1, y - h * 0.62, w * 0.62, 1.6);
  } else if (v === 2) {   // a pitched tile roof
    g.fillStyle = rgba(TERRA, 0.9);
    g.beginPath(); g.moveTo(x - w / 2 - 1, y - h); g.lineTo(x + ox * 0.5, y - h - oy - w * 0.34); g.lineTo(x + w / 2 + ox, y - h - oy); g.lineTo(x + w / 2, y - h); g.closePath(); g.fill();
  }
  g.fillStyle = rgba(INK, 0.32); g.fillRect(x - w * 0.14, y - h * 0.5, w * 0.26, h * 0.5);   // the doorway
  if (city) { g.fillStyle = rgba(INK, 0.22); g.fillRect(x + w * 0.16, y - h * 0.72, w * 0.16, h * 0.16); }   // a window
}
/** Bake every settlement as a lived-in mudbrick town: a cast shadow, the rank's defences (a city's curtain wall
 *  with square bastions, a town's low mud wall with gate towers), a paved plaza under the keep, houses grown from
 *  pop packed on a deterministic disc, dirt lanes out to the fields, and a grove of palms & blossom trees beyond
 *  the wall. A CITY also raises an amphitheatre ring outside its gates. Records the spread on the node. */
export function renderSettlements(g, nodes) {
  for (const nd of nodes) {
    const st = nd.s, rank = st.rank;
    const scale = clamp(0.82 + (st.pop | 0) * 0.045, 0.82, 1.7);
    const houses = rank === "CITY" ? 14 + (fnv1a(st.name) % 6) : rank === "TOWN" ? 9 + (fnv1a(st.name) % 4) : 3 + (fnv1a(st.name) % 2);
    const spread = (rank === "CITY" ? 26 : rank === "TOWN" ? 18 : 11) * scale;
    nd.r = spread;
    g.fillStyle = rgba(CIV_SHADOW, 0.16);   // the town's cast shadow (the low sun sits upper-right)
    g.beginPath(); g.ellipse(nd.x - spread * 0.28, nd.y + spread * 0.42, spread * 1.25, spread * 0.6, 0, 0, TAU); g.fill();
    g.strokeStyle = rgba([150, 120, 84], 0.35); g.lineWidth = 1.6; g.lineCap = "round";   // dirt lanes from the gates
    for (let i = 0; i < 4; i++) {
      const a = (i / 4) * TAU + 0.5 + (fnv1a(st.name + "lane") % 100) / 100 * 0.4;
      g.beginPath(); g.moveTo(nd.x + Math.cos(a) * spread * 0.9, nd.y + Math.sin(a) * spread * 0.58);
      g.lineTo(nd.x + Math.cos(a) * spread * 1.55, nd.y + Math.sin(a) * spread * 1.0); g.stroke();
    }
    if (rank === "CITY") {   // a mudbrick curtain wall with square bastion towers, squashed for the bird's-eye read
      const R = spread * 1.05;
      g.lineWidth = Math.max(2.4, R * 0.17); g.strokeStyle = rgba(mix(MUD_SH, INK, 0.22), 0.92);
      g.beginPath(); g.ellipse(nd.x, nd.y, R, R * 0.66, 0, 0, TAU); g.stroke();
      g.lineWidth = Math.max(1, R * 0.06); g.strokeStyle = rgba(mix(MUD_HI, [255, 246, 224], 0.4), 0.5);
      g.beginPath(); g.ellipse(nd.x, nd.y - R * 0.05, R, R * 0.66, 0, Math.PI * 1.05, Math.PI * 1.95); g.stroke();
      for (let i = 0; i < 8; i++) {
        const a = (i / 8) * TAU + 0.22, cx = nd.x + Math.cos(a) * R, cy = nd.y + Math.sin(a) * R * 0.66;
        g.fillStyle = rgba(mix(MUD_SH, INK, 0.3), 0.95); g.fillRect(cx - 2.6, cy - 5.4, 5.2, 6.4);
        g.fillStyle = rgba(MUD_HI, 0.8); g.fillRect(cx - 2.6, cy - 5.4, 5.2, 1.2);
      }
    } else if (rank === "TOWN") {   // a low mud wall with two gate towers
      const R = spread * 1.02;
      g.strokeStyle = rgba(mix(MUD_SH, INK, 0.15), 0.75); g.lineWidth = 1.8;
      g.beginPath(); g.ellipse(nd.x, nd.y, R, R * 0.6, 0, 0, TAU); g.stroke();
      for (const a of [0.4, Math.PI + 0.4]) {
        const cx = nd.x + Math.cos(a) * R, cy = nd.y + Math.sin(a) * R * 0.6;
        g.fillStyle = rgba(mix(MUD_SH, INK, 0.25), 0.9); g.fillRect(cx - 2, cy - 4.4, 4, 5.2);
      }
    }
    if (rank === "CITY") {   // the paved plaza at the town's heart, under the keep
      g.fillStyle = rgba(PLAZA, 0.5);
      g.beginPath(); g.ellipse(nd.x, nd.y, spread * 0.34, spread * 0.22, 0, 0, TAU); g.fill();
    }
    for (let i = 0; i < houses; i++) {   // the mudbrick blocks, packed on a deterministic disc
      const a = (i / houses) * TAU + (fnv1a(st.name) % 100) / 100 * 0.9;
      const rad = spread * (0.3 + 0.58 * Math.sqrt((i + 0.5) / houses));
      const hx = nd.x + Math.cos(a) * rad, hy = nd.y + Math.sin(a) * rad * 0.62;
      const w = (rank === "CITY" ? 6.4 : rank === "TOWN" ? 5.8 : 5.2) * scale * (0.86 + (fnv1a(st.name + i) % 30) / 100);
      const h = w * (0.95 + (fnv1a(st.name + ":" + i) % 30) / 100);
      civBuilding(g, hx, hy, w, h, nd.color, rank === "CITY");
    }
    if (rank === "CITY") {   // the central citadel — the tall mudbrick heart the curtain rings
      const kw = 9 * scale, kh = 15 * scale;
      g.fillStyle = rgba(mix(MUD_SH, INK, 0.34), 0.96); g.fillRect(nd.x - kw / 2, nd.y - kh, kw, kh);
      g.fillStyle = rgba(mix(MUD_SH, INK, 0.46), 0.96); g.fillRect(nd.x + kw / 2, nd.y - kh, kw * 0.22, kh);
      g.fillStyle = rgba(MUD_HI, 0.9); g.fillRect(nd.x - kw / 2, nd.y - kh, kw, 1.4);
      g.fillStyle = rgba(mix(MUD_SH, INK, 0.3), 0.96);   // corner turrets
      g.fillRect(nd.x - kw / 2 - 2.2, nd.y - kh - 4, 2.6, kh + 4); g.fillRect(nd.x + kw / 2 + kw * 0.22 - 0.4, nd.y - kh - 4, 2.6, kh + 4);
      g.fillStyle = rgba(TERRA, 0.9);
      g.beginPath(); g.moveTo(nd.x - kw / 2 - 1.5, nd.y - kh - 4); g.lineTo(nd.x, nd.y - kh - 4 - kw * 0.5); g.lineTo(nd.x + kw / 2 + 1.5, nd.y - kh - 4); g.closePath(); g.fill();
    }
    if (rank === "CITY") drawAmphitheatre(g, nd, spread);   // the arena ring just outside the gates
    const trees = rank === "CITY" ? 7 : rank === "TOWN" ? 5 : 3;   // a grove beyond the wall
    for (let i = 0; i < trees; i++) {
      const a = (fnv1a(st.name + "tree" + i) % 1000) / 1000 * TAU;
      const rr = spread * (1.28 + (fnv1a(st.name + "tr" + i) % 100) / 100 * 0.42);
      const tx = nd.x + Math.cos(a) * rr, ty = nd.y + Math.sin(a) * rr * 0.62;
      if (i % 2) drawBlossom(g, tx, ty, 4 + (fnv1a(st.name + "ts" + i) % 3));
      else drawPalm(g, tx, ty, 5 + (fnv1a(st.name + "ts" + i) % 4));
    }
    const label = (nd.sigil ? nd.sigil + " " : "") + st.name;   // the name cartouche, lifted clear of the roofs
    g.save();
    g.textAlign = "center"; g.textBaseline = "middle";
    g.font = "700 " + Math.round(rank === "CITY" ? 13 : rank === "TOWN" ? 11 : 10) + "px Fraunces, Cinzel, Georgia, serif";
    g.lineJoin = "round"; g.miterLimit = 2;
    g.strokeStyle = rgba([250, 246, 238], 0.85); g.lineWidth = 3.4;
    g.strokeText(label, nd.x, nd.y - spread - 18);   // a painted stroke halo (cheaper than a per-text blur)
    g.fillStyle = rgba(mix(nd.color, INK, 0.6), 0.95);
    g.fillText(label, nd.x, nd.y - spread - 18);
    g.restore();
  }
}
/** One public work baked into the offscreen, city-builder read: a domed mudbrick granary, a water deck on stone
 *  arches (the aqueduct), or a gilded obelisk raised over a paved plaza with a reflecting pool, kitchen gardens
 *  and blossom trees (the golden age's wonder). `age` (0 new → 1 at its WK_AGE mortar term) weathers the stone. */
export function drawWorkStatic(g, kind, x, y, age) {
  const wear = clamp(age, 0, 1);
  const stone = mix(MUD_SH, ASH_GREY, wear * 0.5);
  g.save();
  g.fillStyle = rgba(CIV_SHADOW, 0.2);
  g.beginPath(); g.ellipse(x - 5, y + 5, 20, 8, 0, 0, TAU); g.fill();
  if (kind === "granary") {   // a round mudbrick storehouse under a whitewashed dome
    g.fillStyle = rgba(mix(MUD, ASH_GREY, wear * 0.4), 0.96); g.fillRect(x - 11, y - 12, 22, 14);
    g.fillStyle = rgba(mix(MUD, INK, 0.3), 0.9); g.fillRect(x + 11, y - 12, 3.4, 14);   // side shade
    g.fillStyle = rgba(mix(MUD_HI, [255, 252, 244], 0.3), 0.96);
    g.beginPath(); g.arc(x, y - 12, 11, Math.PI, 0); g.closePath(); g.fill();
    g.strokeStyle = rgba(mix(MUD_SH, INK, 0.3), 0.5); g.lineWidth = 0.8;
    g.beginPath(); g.arc(x, y - 12, 11, Math.PI * 1.15, Math.PI * 1.85); g.stroke();
    g.fillStyle = rgba(INK, 0.4); g.fillRect(x - 3, y - 7, 6, 9);
  } else if (kind === "aqueduct") {   // a water deck on four piers, three arches beneath
    const top = y - 26, deckH = 5, span = 40, piers = 4;
    g.fillStyle = rgba(mix(stone, INK, 0.18), 0.96); g.fillRect(x - span / 2, top, span, deckH);
    g.fillStyle = rgba(mix([120, 160, 180], INK, 0.2), 0.5); g.fillRect(x - span / 2 + 1, top + 1, span - 2, 1.6);
    for (let i = 0; i < piers; i++) {
      const px = x - span / 2 + (i + 0.5) * (span / piers);
      g.fillStyle = rgba(mix(stone, INK, 0.3), 0.96); g.fillRect(px - 2.6, top + deckH, 5.2, y - top - deckH);
    }
    g.strokeStyle = rgba(mix(stone, INK, 0.35), 0.9); g.lineWidth = 2.4;
    for (let i = 0; i < piers - 1; i++) {
      const ax0 = x - span / 2 + (i + 1) * (span / piers);
      g.beginPath(); g.arc(ax0, top + deckH + 6, span / piers * 0.42, Math.PI, 0); g.stroke();
    }
  } else {   // monument: a gilded obelisk over a paved plaza with pool, gardens & blossom trees
    g.fillStyle = rgba(PLAZA, 0.55);
    g.beginPath(); g.ellipse(x, y + 2, 34, 19, 0, 0, TAU); g.fill();
    g.strokeStyle = rgba(mix(MUD_SH, INK, 0.2), 0.5); g.lineWidth = 1;
    g.beginPath(); g.ellipse(x, y + 2, 34, 19, 0, 0, TAU); g.stroke();
    g.fillStyle = rgba(POOL, 0.8); g.fillRect(x - 26, y + 4, 16, 7);   // the reflecting pool
    g.strokeStyle = rgba(mix(POOL, [255, 255, 255], 0.5), 0.6); g.lineWidth = 0.8; g.strokeRect(x - 26, y + 4, 16, 7);
    drawGardenBed(g, x + 12, y + 3, 15, 8);
    drawGardenBed(g, x + 14, y - 8, 12, 7);
    drawBlossom(g, x - 30, y - 6, 5); drawBlossom(g, x + 30, y - 4, 5);
    drawPalm(g, x - 22, y - 10, 6);
    g.fillStyle = rgba(mix(stone, INK, 0.25), 0.96); g.fillRect(x - 9, y - 5, 18, 7);
    g.fillStyle = rgba(mix(stone, INK, 0.05), 0.97);
    g.beginPath(); g.moveTo(x - 5.5, y - 5); g.lineTo(x - 3.4, y - 40); g.lineTo(x + 3.4, y - 40); g.lineTo(x + 5.5, y - 5); g.closePath(); g.fill();
    g.fillStyle = rgba(GILT_HI, 0.95);
    g.beginPath(); g.moveTo(x - 3.4, y - 40); g.lineTo(x, y - 47); g.lineTo(x + 3.4, y - 40); g.closePath(); g.fill();
    g.strokeStyle = rgba(mix(stone, INK, 0.4), 0.4); g.lineWidth = 0.7;
    for (let i = 1; i <= 3; i++) { const yy = y - 5 - i * 8; g.beginPath(); g.moveTo(x - 5, yy); g.lineTo(x + 5, yy); g.stroke(); }
  }
  if (wear > 0.55) {   // weathering: cracks creep over a work nearing the end of its mortar term
    g.strokeStyle = rgba(INK, 0.28 * ((wear - 0.55) / 0.45)); g.lineWidth = 0.8;
    for (let i = 0; i < 3; i++) {
      const cx = x - 8 + (fnv1a(kind + i) % 16), cyy = y - 6 - (fnv1a(kind + ":" + i) % 20);
      g.beginPath(); g.moveTo(cx, cyy); g.lineTo(cx + 3, cyy + 5); g.lineTo(cx + 1, cyy + 9); g.stroke();
    }
  }
  g.restore();
}
export function renderWorks(g, works) { for (const w of works) drawWorkStatic(g, w.kind, w.x, w.y, w.age); }
/** The arena ring a great city raises just outside its gates: two tiered mudbrick ellipses, radial aisle ticks
 *  and a sanded floor — the colosseum read, squashed for the bird's-eye. */
export function drawAmphitheatre(g, nd, spread) {
  const a0 = (fnv1a(nd.s.name + "arena") % 1000) / 1000 * TAU;
  const x = nd.x + Math.cos(a0) * spread * 1.5, y = nd.y + Math.sin(a0) * spread * 1.5 * 0.62;
  const rx = spread * 0.36, ry = rx * 0.62;
  g.fillStyle = rgba(PLAZA, 0.45);
  g.beginPath(); g.ellipse(x, y, rx, ry, 0, 0, TAU); g.fill();
  g.strokeStyle = rgba(mix(MUD_SH, INK, 0.2), 0.9); g.lineWidth = 2.6;
  g.beginPath(); g.ellipse(x, y, rx, ry, 0, 0, TAU); g.stroke();
  g.strokeStyle = rgba(mix(MUD_SH, INK, 0.1), 0.8); g.lineWidth = 1.4;
  g.beginPath(); g.ellipse(x, y, rx * 0.72, ry * 0.72, 0, 0, TAU); g.stroke();
  g.fillStyle = rgba([186, 158, 116], 0.5);
  g.beginPath(); g.ellipse(x, y, rx * 0.42, ry * 0.42, 0, 0, TAU); g.fill();   // the sanded arena floor
  g.strokeStyle = rgba(mix(MUD_SH, INK, 0.25), 0.5); g.lineWidth = 0.8;
  for (let i = 0; i < 8; i++) {   // the radial aisles between the tiers
    const a = (i / 8) * TAU + 0.3;
    g.beginPath(); g.moveTo(x + Math.cos(a) * rx * 0.72, y + Math.sin(a) * ry * 0.72);
    g.lineTo(x + Math.cos(a) * rx, y + Math.sin(a) * ry); g.stroke();
  }
}
/** A palm: a curved trunk and a star of fronds — the riverine green of a settled land. */
export function drawPalm(g, x, y, s) {
  g.strokeStyle = rgba([122, 96, 62], 0.8); g.lineWidth = 1.1;
  g.beginPath(); g.moveTo(x, y); g.quadraticCurveTo(x + s * 0.18, y - s * 0.6, x + s * 0.1, y - s); g.stroke();
  g.strokeStyle = rgba(PALM, 0.85); g.lineWidth = 1.2;
  for (let i = 0; i < 6; i++) {
    const a = -Math.PI / 2 + (i - 2.5) * 0.52;
    g.beginPath(); g.moveTo(x + s * 0.1, y - s);
    g.quadraticCurveTo(x + s * 0.1 + Math.cos(a) * s * 0.5, y - s + Math.sin(a) * s * 0.5 - s * 0.16, x + s * 0.1 + Math.cos(a) * s * 0.82, y - s + Math.sin(a) * s * 0.62); g.stroke();
  }
}
/** A blossom tree: a dark trunk under a three-lobe canopy of rose — the garden colour of a lived-in town. */
export function drawBlossom(g, x, y, s) {
  g.strokeStyle = rgba([96, 72, 48], 0.8); g.lineWidth = 1;
  g.beginPath(); g.moveTo(x, y); g.lineTo(x, y - s * 0.8); g.stroke();
  g.fillStyle = rgba(BLOSSOM, 0.75);
  for (const [dx, dy, r] of [[-s * 0.4, -s, s * 0.55], [s * 0.4, -s * 1.05, s * 0.5], [0, -s * 1.35, s * 0.55]]) {
    g.beginPath(); g.arc(x + dx, y + dy, r, 0, TAU); g.fill();
  }
  g.fillStyle = rgba(mix(BLOSSOM, [255, 236, 240], 0.5), 0.6);
  g.beginPath(); g.arc(x - s * 0.2, y - s * 1.3, s * 0.28, 0, TAU); g.fill();
}
/** A walled kitchen garden: a green bed with ploughed rows, set beside a plaza or a work. */
export function drawGardenBed(g, x, y, w, h) {
  g.fillStyle = rgba(GARDEN, 0.5); g.fillRect(x, y, w, h);
  g.strokeStyle = rgba(mix(GARDEN, INK, 0.45), 0.5); g.lineWidth = 0.7;
  for (let i = 1; i < 4; i++) { const yy = y + (h * i) / 4; g.beginPath(); g.moveTo(x + 1, yy); g.lineTo(x + w - 1, yy); g.stroke(); }
  g.strokeStyle = rgba([120, 96, 62], 0.5); g.lineWidth = 0.8; g.strokeRect(x, y, w, h);
}
/** A river sailboat: a dark hull, one mast and a cream lateen sail, with a faint wake — goods & folk in motion. */
export function drawSailboat(g, x, y, s, flip) {
  g.save(); g.translate(x, y); if (flip) g.scale(-1, 1);
  g.strokeStyle = rgba(RIVER_BLUE, 0.35); g.lineWidth = 0.9;
  g.beginPath(); g.moveTo(-s * 1.5, s * 0.5); g.lineTo(-s * 0.7, s * 0.5); g.stroke();   // the wake
  g.fillStyle = rgba(HULL, 0.9);
  g.beginPath(); g.moveTo(-s, 0); g.quadraticCurveTo(0, s * 0.75, s, 0); g.lineTo(s * 0.7, -s * 0.28); g.lineTo(-s * 0.7, -s * 0.28); g.closePath(); g.fill();
  g.strokeStyle = rgba([70, 50, 34], 0.9); g.lineWidth = 0.8;
  g.beginPath(); g.moveTo(0, -s * 0.28); g.lineTo(0, -s * 1.7); g.stroke();
  g.fillStyle = rgba(SAIL, 0.92);
  g.beginPath(); g.moveTo(0, -s * 1.7); g.lineTo(s * 0.85, -s * 0.42); g.lineTo(0, -s * 0.42); g.closePath(); g.fill();
  g.restore();
}
/** Sailboats riding the two parchment rivers (the same deterministic sine the territory bake inks), so the water
 *  reads as traffic rather than paint. Gated with the rivers themselves (showTerritory) via the bake signature. */
export function renderRiverBoats(g) {
  for (let r = 0; r < 2; r++) {
    const ph = (fnv1a("river:" + r) % 360) * Math.PI / 180;
    const yb = state.VH * (r ? 0.66 : 0.34), amp = state.VH * 0.07;
    for (let k = 0; k < 3; k++) {
      const t = 0.2 + k * 0.26 + ((fnv1a("boat:" + r + ":" + k) % 100) / 100) * 0.08;
      const x = t * state.VW, y = yb + Math.sin(t * 5 + ph + r) * amp + Math.sin(t * 13 + ph) * amp * 0.28;
      drawSailboat(g, x, y - 1.5, 4.5 + (fnv1a("bs:" + r + ":" + k) % 3), k % 2 === 1);
    }
  }
}
/** The trade road between the two greatest settlements, baked as a double-stroked arc (a sunken dirt track with a
 *  lit centre). The golden caravan glints themselves ride it live in drawCivAnim. */
export function renderTradeRoads(g, road) {
  if (!road) return;
  const a = road.a, b = road.b;
  g.save(); g.lineCap = "round";
  g.strokeStyle = rgba([120, 96, 64], 0.2); g.lineWidth = 3.4;
  g.beginPath(); g.moveTo(a.x, a.y); g.quadraticCurveTo(road.ctrlx, road.ctrly, b.x, b.y); g.stroke();
  g.strokeStyle = rgba([196, 168, 116], 0.32); g.lineWidth = 1.4;
  g.beginPath(); g.moveTo(a.x, a.y); g.quadraticCurveTo(road.ctrlx, road.ctrly, b.x, b.y); g.stroke();
  g.restore();
}
/** Recompute the civilization layout and bake its static structure into civOff. Settlements take their zone's
 *  force-field anchor; each is flagged a capital when it sits in a house's HOME zone (and seized when that ground
 *  is now held by another house). The road threads the two greatest; the standing works anchor beside the first. */
/** Strip farmland fanned around each CITY — the founding step from foraging to farming, drawn as ploughed furrow
 *  plots just outside the wall, their number growing with the civilization's level and thinned by the live quality coefficient. Static ⇒ baked. */
export function renderFarmland(g, nodes, civLvl) {
  const plots = Math.max(2, Math.round((3 + clamp(civLvl / 100, 0, 1) * 4) * (0.55 + 0.45 * state.qualityCoeff)));   // 3..7 strips as fortune grows, thinned continuously by quality
  const cropA = [126, 146, 82], cropB = [178, 158, 92];          // green shoot / ripe gold
  for (const nd of nodes) {
    if (nd.s.rank !== "CITY") continue;
    const R = nd.r * 1.12 + 8;
    for (let i = 0; i < plots; i++) {
      const a = Math.PI * (0.18 + 0.64 * (i / Math.max(1, plots - 1))) + Math.PI * 0.5;   // a fan on the lower arc
      const px = nd.x + Math.cos(a) * R, py = nd.y + Math.sin(a) * R * 0.62;
      g.save();
      g.translate(px, py); g.rotate(a - Math.PI / 2);
      const w = 15, h = 9;
      g.fillStyle = rgba(i % 2 ? cropB : cropA, 0.42);
      g.fillRect(-w / 2, -h / 2, w, h);
      g.strokeStyle = rgba(mix(INK, [70, 52, 30], 0.4), 0.35); g.lineWidth = 0.7;
      for (let f = 1; f < 4; f++) { const yy = -h / 2 + (h * f / 4); g.beginPath(); g.moveTo(-w / 2, yy); g.lineTo(w / 2, yy); g.stroke(); }
      g.restore();
    }
  }
}
export function rebuildCiv(C) {
  if (!state.civOff) { state.civOff = document.createElement("canvas"); state.civOffCtx = state.civOff.getContext("2d"); }
  const w = Math.round(state.VW * state.DPR), h = Math.round(state.VH * state.DPR);
  if (state.civOff.width !== w || state.civOff.height !== h) { state.civOff.width = w; state.civOff.height = h; }
  const g = state.civOffCtx; g.setTransform(state.DPR, 0, 0, state.DPR, 0, 0); g.clearRect(0, 0, state.VW, state.VH);
  const homeByZone = new Map();   // whose HOME each zone is (the seat), from the dynasty read-out
  if (state.econDynasty && Array.isArray(state.econDynasty.houses))
    for (const ho of state.econDynasty.houses) if (ho && ho.homeZone != null) homeByZone.set(ho.homeZone | 0, ho);
  const nodes = [];
  for (const st of C.settlements) {
    if (!st || st.zone == null) continue;
    const a = zoneAnchor(st.zone | 0);
    const home = homeByZone.get(st.zone | 0) || null;
    const color = (st.houseName ? houseColor(st.houseName) : null) || (home ? houseColor(home.name) : null)
      || COLONY_COLORS[(st.zone | 0) % COLONY_COLORS.length];
    const seized = !!(home && st.houseName && home.name && st.houseName.toLowerCase() !== home.name.toLowerCase());
    nodes.push({
      s: st, x: a.x, y: a.y, r: 12, color, sigil: st.sigil || (home && home.sigil) || "",
      capital: home ? { name: home.name, color: houseColor(home.name) || color, sigil: home.sigil || st.sigil || "", occupied: seized } : null,
    });
  }
  if (!nodes.length) { state.civLayout = null; return; }
  let road = null;   // the caravan road between the two greatest, resolved by name to their anchors
  if (C.road && C.road.a && C.road.b) {
    const na = nodes.find((n) => n.s.name === C.road.a), nb = nodes.find((n) => n.s.name === C.road.b);
    if (na && nb) {
      const mx = (na.x + nb.x) / 2, my = (na.y + nb.y) / 2, dx = nb.x - na.x, dy = nb.y - na.y, len = Math.hypot(dx, dy) || 1;
      road = { a: { x: na.x, y: na.y }, b: { x: nb.x, y: nb.y }, ctrlx: mx - dy / len * len * 0.14, ctrly: my + dx / len * len * 0.14 };
    }
  }
  if (state.showTerritory) renderRiverBoats(g);   // sailboats ride the rivers the territory bake inks, under the towns
  renderTradeRoads(g, road);       // the road sinks under the towns it connects
  renderSettlements(g, nodes);
  if (state.qualityCoeff > 0.6) renderFarmland(g, nodes, (state.chronMeta && state.chronMeta.civLevel) || 50);   // ⑥ the fields beside each city
  const works = [];                // the standing public works, anchored beside the greatest city (or the coffer)
  const W = state.econWorks;
  if (W && Array.isArray(W.active) && W.active.length) {
    const hub = nodes[0];
    const base = hub ? { x: hub.x, y: hub.y } : cofferAnchor();
    const k = clamp((hub ? hub.r : 16) / 26, 0.7, 1.5);
    for (const wk of W.active) {
      if (!wk || !WORK_SLOT[wk.kind]) continue;
      const off = WORK_SLOT[wk.kind];
      const raised = Math.max(wk.raisedTick | 0, wk.lastRepairTick | 0);
      works.push({ kind: wk.kind, x: base.x + off[0] * k, y: base.y + off[1] * k, age: clamp(((state.lastTickIndex ?? 0) - raised) / WK_AGE_TICKS, 0, 1) });
    }
  }
  renderWorks(g, works);
  state.civLayout = { nodes, works, road };
}
/** The live civilization animation, per frame in world space over the baked structure (qualityCoeff > 0.3): a city's
 *  cooking smoke, a hamlet/town's campfire, a freshly-raised work's gilt glow, and the golden caravan glints
 *  threading the trade road (warm gold — trade, unlike the torch-red march). All time-driven, cheap, capped. */
export function drawCivAnim(now, q) {
  if (!state.civLayout) return;
  const cg = civGrade();   // the age's fortune modulates every fire & glow below
  state.ctx.save();
  for (const nd of state.civLayout.nodes) {
    const st = nd.s;
    if (st.rank === "CITY") {
      for (let c = 0; c < 2; c++) {   // two columns of cooking smoke over the keep
        const ph = (fnv1a(st.name + ":" + c) % 1000) / 1000;
        for (let i = 0; i < 3; i++) {
          const life = ((now * 0.00013 + i / 3 + ph) % 1);
          const sx = nd.x + (c ? 5 : -5) + Math.sin(life * 5 + c + ph * 6) * (1.5 + life * 4);
          state.ctx.fillStyle = rgba(SMOKE, (1 - life) * 0.14);
          state.ctx.beginPath(); state.ctx.arc(sx, nd.y - 16 - life * 26, 1.4 + life * 4.5, 0, TAU); state.ctx.fill();
        }
      }
    } else {   // a campfire at the settlement's heart — burning bright in fortune, low in a dark age
      const fx = nd.x, fy = nd.y + 1, fl = flick(now, (fnv1a(st.name) % 100) / 10, 0.02, 0.7, 1.2);
      const gr = state.ctx.createRadialGradient(fx, fy, 0, fx, fy, 11 * fl);
      gr.addColorStop(0, rgba(FIRE_HOT, clamp(0.3 * cg.light, 0, 1))); gr.addColorStop(0.5, rgba(FIRE_MID, clamp(0.14 * cg.light, 0, 1))); gr.addColorStop(1, rgba(FIRE_LO, 0));
      state.ctx.fillStyle = gr; state.ctx.beginPath(); state.ctx.arc(fx, fy, 11 * fl, 0, TAU); state.ctx.fill();
      state.ctx.fillStyle = rgba(FIRE_MID, clamp(0.85 * cg.light, 0, 1));
      state.ctx.beginPath(); state.ctx.moveTo(fx - 2, fy); state.ctx.quadraticCurveTo(fx - 0.8, fy - 5 * fl, fx, fy - 8 * fl);
      state.ctx.quadraticCurveTo(fx + 0.8, fy - 5 * fl, fx + 2, fy); state.ctx.closePath(); state.ctx.fill();
      state.ctx.fillStyle = rgba(FIRE_HOT, clamp(0.9 * cg.light, 0, 1));
      state.ctx.beginPath(); state.ctx.moveTo(fx - 1, fy); state.ctx.quadraticCurveTo(fx, fy - 3 * fl, fx + 1, fy); state.ctx.closePath(); state.ctx.fill();
    }
  }
  for (const wk of state.civLayout.works) {   // a freshly-raised work glows gilt until its mortar sets
    if (wk.age < 0.3) {
      const pulse = 0.5 + 0.5 * Math.sin(now * 0.003);
      const gr = state.ctx.createRadialGradient(wk.x, wk.y - 16, 0, wk.x, wk.y - 16, 26);
      gr.addColorStop(0, rgba(GILT_HI, 0.22 * (1 - wk.age / 0.3) * (0.6 + 0.4 * pulse)));
      gr.addColorStop(1, rgba(GILT_HI, 0));
      state.ctx.fillStyle = gr; state.ctx.beginPath(); state.ctx.arc(wk.x, wk.y - 16, 26, 0, TAU); state.ctx.fill();
    } else if (wk.kind === "monument" && cg.golden) {   // a golden age keeps its monument shining
      const pulse = 0.5 + 0.5 * Math.sin(now * 0.0016);
      const gr = state.ctx.createRadialGradient(wk.x, wk.y - 24, 0, wk.x, wk.y - 24, 34);
      gr.addColorStop(0, rgba(GILT_HI, 0.16 * (0.6 + 0.4 * pulse)));
      gr.addColorStop(1, rgba(GILT_HI, 0));
      state.ctx.fillStyle = gr; state.ctx.beginPath(); state.ctx.arc(wk.x, wk.y - 24, 34, 0, TAU); state.ctx.fill();
    }
  }
  const road = state.civLayout.road;   // the golden caravan threading the trade road (goods in transit)
  if (road) {
    const dots = q > 0.6 ? 7 : 4, a = road.a, b = road.b;
    for (let k = 0; k < dots; k++) {
      const t = ((now * 0.00005 + k / dots) % 1), it = 1 - t;
      const px = it * it * a.x + 2 * it * t * road.ctrlx + t * t * b.x;
      const py = it * it * a.y + 2 * it * t * road.ctrly + t * t * b.y;
      const fl = 0.7 + 0.3 * Math.sin(now * 0.02 + k * 1.9);
      state.ctx.fillStyle = rgba(COIN_GOLD, 0.1 * fl); state.ctx.beginPath(); state.ctx.arc(px, py, 3.2, 0, TAU); state.ctx.fill();
      state.ctx.fillStyle = rgba(GILT_HI, 0.6 * fl); state.ctx.beginPath(); state.ctx.arc(px, py, 1.1, 0, TAU); state.ctx.fill();
    }
  }
  state.ctx.restore();
}
/** A house seat's crown — the marker that says "this settlement is a family's home": a small gilt coronet that
 *  bobs gently over a soft halo, above the place name. */
export function drawCrown(x, y, color, now) {
  const cy = y + Math.sin(now * 0.0016 + x * 0.01) * 1.6;
  state.ctx.save();
  if (state.crownGlowSprite) state.ctx.drawImage(state.crownGlowSprite, x - 15, cy - 15, 30, 30);   // pre-baked radial halo
  state.ctx.fillStyle = rgba(GILT, 0.96);
  state.ctx.beginPath();
  state.ctx.moveTo(x - 7, cy + 3); state.ctx.lineTo(x - 7, cy - 1); state.ctx.lineTo(x - 3.5, cy + 1.5); state.ctx.lineTo(x, cy - 5);
  state.ctx.lineTo(x + 3.5, cy + 1.5); state.ctx.lineTo(x + 7, cy - 1); state.ctx.lineTo(x + 7, cy + 3); state.ctx.closePath(); state.ctx.fill();
  state.ctx.strokeStyle = rgba(mix(GILT, INK, 0.4), 0.7); state.ctx.lineWidth = 0.7; state.ctx.stroke();
  state.ctx.fillStyle = rgba(mix(color, [255, 255, 255], 0.3), 0.95);
  state.ctx.beginPath(); state.ctx.arc(x, cy + 1.4, 1.3, 0, TAU); state.ctx.fill();
  state.ctx.restore();
}
/** The live seat markers over each CAPITAL settlement: the house's beacon (seized ground) or hearth-smoke
 *  (peaceful), its banner off the keep, and the gilt crown that names it a family seat. These are the retired
 *  renderLandLife decorations, re-pointed from the six provincial strongholds onto the real home settlements. */
export function drawCivSeats(now, q) {
  if (!state.civLayout) return;
  for (const nd of state.civLayout.nodes) {
    const cap = nd.capital; if (!cap) continue;
    const p = { name: cap.name, color: cap.color, sigil: cap.sigil, occupied: cap.occupied };
    if (cap.occupied) drawBeacon(p, { x: nd.x, y: nd.y - 2, n: nd.s.pop | 0 }, now, q);
    else drawHearth(p, { x: nd.x, y: nd.y - 2, n: nd.s.pop | 0 }, now, q);
    drawBanner(p, { x: nd.x + nd.r * 0.6, y: nd.y - nd.r * 0.15 }, now);
    drawCrown(nd.x, nd.y - nd.r - 36, cap.color, now);
  }
}
/** The civilization layer's entry point (world space, under the flies, over the dominion map): blit the baked
 *  settlements/works/road, then the live smoke/fire/glow/caravans and the seat markers. Gated by showCities; the
 *  bake is rebuilt only when the settlement/works signature moves (the terrOff discipline). */
export function renderCivilization(now) {
  if (!state.showCities) { state.civKey = ""; return; }
  const C = state.econCities;
  if (!C || !Array.isArray(C.settlements) || !C.settlements.length) { state.civKey = ""; return; }
  const q = state.qualityCoeff;
  const sig = civSignature(C);
  if (!state.civOff || state.civKey !== sig) { state.civKey = sig; rebuildCiv(C); }
  if (!state.civLayout) return;
  state.ctx.drawImage(state.civOff, 0, 0, state.VW, state.VH);
  if (q > 0.3) { drawCivAnim(now, q); drawCivSeats(now, q); }
}
/** The civilization's fortune as a light grade, read off chronMeta.civLevel (0..100): a golden age gilds the whole
 *  field from its heart outward and burns every hearth bright; a dark age drains it cold from the edges in and lets
 *  the fires sink low; ascendant/declining cross-fade gently between. Continuous in civLevel so an age never pops. */
export function civGrade() {
  const raw = state.chronMeta ? state.chronMeta.civLevel : null;
  const lvl = clamp((raw == null ? 50 : raw) / 100, 0, 1);
  const wash = mix([104, 122, 148], [255, 210, 128], lvl);      // cold ruin → gilded age
  const alpha = 0.045 + 0.075 * Math.abs(lvl - 0.5) * 2;        // strongest at the extremes, neutral mid-fortune
  return {
    wash, alpha,
    centerA: alpha * (0.4 + 1.2 * lvl),                          // golden glows from the heart …
    edgeA: alpha * (1.6 - 1.2 * lvl),                            // … dark ages close in from the edges
    light: 0.62 + 0.76 * lvl,                                    // hearth/fire brightness multiplier
    golden: lvl >= 0.75,
  };
}
/** A cinematic golden-hour grade laid over the whole field: warm sunlit sky up top, cool shadow below, a slow
 *  warm↔cool breathe cross-faded with the market temperature, and a strong corner vignette for the diorama depth. */
export function renderDayNight(pal, now) {
  // Baked offscreen + 250ms throttle: the light cycle is ≈7 min and the temperature grade drifts slowly, so a
  // 4fps repaint is imperceptible — this removes the last per-frame FULL-SCREEN gradient fills (two of them)
  // from the hot path, leaving one blit per frame (the parchOff/terrOff discipline).
  const key = state.VW + "x" + state.VH + "@" + state.DPR;
  if (!state.dnOff || state.dnKey !== key || now - state.dnLastPaint > 250) {
    if (!state.dnOff) { state.dnOff = document.createElement("canvas"); state.dnOffCtx = state.dnOff.getContext("2d"); }
    const w = Math.round(state.VW * state.DPR), h = Math.round(state.VH * state.DPR);
    if (state.dnOff.width !== w || state.dnOff.height !== h) { state.dnOff.width = w; state.dnOff.height = h; }
    state.dnKey = key; state.dnLastPaint = now;
    const g = state.dnOffCtx;
    g.setTransform(state.DPR, 0, 0, state.DPR, 0, 0); g.clearRect(0, 0, state.VW, state.VH);
    const cyc = 0.5 + 0.5 * Math.sin(now * 0.00025);            // very slow (≈7-min) light cycle
    // a LIGHT parchment grade: a warm sunlit wash up top, a faint cool sea-shadow below, and a soft brown vignette
    // at the corners — aged-atlas depth without ever darkening the land into murk.
    const warm = mix([255, 246, 224], pal.accent, 0.18);
    const cool = mix([126, 156, 150], INK, 0.12);
    const lg = g.createLinearGradient(0, 0, 0, state.VH);
    lg.addColorStop(0, rgba(warm, 0.06 + 0.04 * cyc));
    lg.addColorStop(0.5, rgba(mix(warm, cool, 0.6), 0.015));
    lg.addColorStop(1, rgba(cool, 0.06 + 0.04 * (1 - cyc)));
    g.fillStyle = lg; g.fillRect(0, 0, state.VW, state.VH);
    const r = g.createRadialGradient(state.VW / 2, state.VH * 0.46, Math.min(state.VW, state.VH) * 0.42, state.VW / 2, state.VH / 2, Math.max(state.VW, state.VH) * 0.75);
    r.addColorStop(0, rgba([0, 0, 0], 0)); r.addColorStop(1, rgba([96, 74, 52], 0.14));
    g.fillStyle = r; g.fillRect(0, 0, state.VW, state.VH);
    // the civilization's fortune over the land (⑫ civLevel): one extra radial fill inside the SAME 250ms bake, so
    // the field itself reads gilded in a golden age and cold-drained in a dark age at zero added per-frame cost.
    const cg = civGrade();
    const fg = g.createRadialGradient(state.VW / 2, state.VH * 0.46, Math.min(state.VW, state.VH) * 0.12, state.VW / 2, state.VH / 2, Math.max(state.VW, state.VH) * 0.78);
    fg.addColorStop(0, rgba(cg.wash, cg.centerA)); fg.addColorStop(1, rgba(cg.wash, cg.edgeA));
    g.fillStyle = fg; g.fillRect(0, 0, state.VW, state.VH);
  }
  state.ctx.drawImage(state.dnOff, 0, 0, state.VW, state.VH);
}
/** Trace the home-continent coastline (atlas-normalised → world) onto context `g`. */
export function traceContinent(g) {
  g.beginPath();
  for (let i = 0; i < CONTINENT.length; i++) {
    const w = mw(CONTINENT[i]);
    if (i === 0) g.moveTo(w.x, w.y); else g.lineTo(w.x, w.y);
  }
  g.closePath();
}
/** Province layout: the biggest living house claims the first landmark seed and so on; each province is grown
 *  as an organic Voronoi-capped region around its seed and clipped to the continent at paint time. Houses beyond
 *  the six provinces are landless (no seat, no tint) — matching the economy's exile concept. */
export function layoutTerritoryMap(pol) {
  const R = Math.max(state.VW, state.VH) * 0.6;      // big seed ring: the Voronoi capping (not the ring) carves the province
  for (let i = 0; i < pol.length; i++) {
    const o = pol[i];
    const prov = i < PROVINCES.length ? PROVINCES[i] : null;
    o.region = prov;
    o.p.region = prov;
    const w = prov ? mw(prov.t) : null;
    o.seat = w ? { x: w.x, y: w.y } : null;
    o.p.seat = o.seat;   // publish the landmark so the animated land-life (cities/torches/beacons) sits on the province
    if (w) {
      const ring = o.ring || (o.ring = []); ring.length = 0;
      for (let k = 0; k < 28; k++) { const a = (k / 28) * TAU; ring.push({ x: w.x + Math.cos(a) * R, y: w.y + Math.sin(a) * R }); }
    }
  }
}
/** Blit the cached territory map. The map is fully STATIC (deterministic seats — unlike the societies
 *  layer, nothing here tracks moving flies), so the expensive work (per-polity colonyBlob, clipped hatch
 *  fills, haloed labels) runs only when the living house partition / era / field size changes; every
 *  other frame is a single drawImage. This keeps the default-on map off the hot path so it can never
 *  nudge frameMsAvg over the 30ms budget and collapse fly detail to blobs. */
export function renderTerritoryMap() {
  if (!state.showTerritory || !state.territories || !state.territories.length) { state.terrKey = ""; state.terrPol = null; return; }
  const pol = [];
  for (const p of state.territories) {
    let cnt = 0; for (const id of p.ids) { const f = sim.get(id); if (f && !f.dying) cnt++; }
    if (cnt > 0) pol.push({ p, n: cnt });
  }
  if (!pol.length) { state.terrKey = ""; return; }
  pol.sort((a, b) => b.n - a.n || (a.p.name < b.p.name ? -1 : 1));   // biggest houses first ⇒ central seats
  // structural-only key: field size / DPR / era / which houses are present — NOT the volatile living-member
  // tally, so routine births & deaths never force a full (heavy) map repaint. Seats are name-deterministic;
  // the small per-capital tally just reflects the last structural composition.
  const key = state.VW + "x" + state.VH + "@" + state.DPR + ":" + ((state.chronMeta && state.chronMeta.eraName) || "") + ":" + pol.map((o) => o.p.name).join(",") + ":" + state.territorySeizureSig;
  if (!state.terrOff || state.terrKey !== key) {
    if (!state.terrOff) { state.terrOff = document.createElement("canvas"); state.terrOffCtx = state.terrOff.getContext("2d"); }
    const w = Math.round(state.VW * state.DPR), h = Math.round(state.VH * state.DPR);
    if (state.terrOff.width !== w || state.terrOff.height !== h) { state.terrOff.width = w; state.terrOff.height = h; }
    state.terrKey = key;
    layoutTerritoryMap(pol);
    const g = state.terrOffCtx; g.setTransform(state.DPR, 0, 0, state.DPR, 0, 0); g.clearRect(0, 0, state.VW, state.VH);
    paintTerritoryMap(g, pol);
  }
  state.terrPol = pol;
  state.ctx.drawImage(state.terrOff, 0, 0, state.VW, state.VH);
}
/** Actually draw the dominions onto a target context `g` (the offscreen): each house's province is an organic
 *  Voronoi region grown from its landmark seed, CLIPPED to the home continent, filled with a soft pastel of the
 *  house colour (fantasy-atlas style), bordered, then labelled in dark serif at the landmark → the map key. */
export function paintTerritoryMap(g, pol) {
  const land = pol.filter((o) => o.region);
  const seats = land.map((o) => o.seat);
  // 1) pastel province fills, clipped to the continent so they never spill into the sea
  g.save();
  traceContinent(g); g.clip();
  for (let i = 0; i < land.length; i++) {
    const o = land[i], p = o.p;
    colonyBlob(o.ring, seats.filter((_, k) => k !== i), p._scr);
    traceBlob(g, p._scr.P);
    g.fillStyle = rgba(mix(p.color, [250, 246, 238], 0.45), 0.55); g.fill();   // soft pastel region
  }
  // 2) province borders (the Voronoi seams) + a dashed crimson ring on seized ground
  g.lineJoin = "round";
  for (let i = 0; i < land.length; i++) {
    const o = land[i], p = o.p;
    colonyBlob(o.ring, seats.filter((_, k) => k !== i), p._scr);
    g.strokeStyle = rgba([120, 96, 70], 0.5); g.lineWidth = 1.6; traceBlob(g, p._scr.P); g.stroke();
    if (p.occupied) {
      g.save(); g.setLineDash([7, 5]); g.lineWidth = 2.4; g.strokeStyle = rgba([176, 42, 32], 0.9);
      traceBlob(g, p._scr.P); g.stroke(); g.restore();
    }
  }
  g.restore();
  // 2½) the two parchment rivers, clipped to the landmass so they never run out into the sea
  g.save(); traceContinent(g); g.clip(); drawRivers(g); g.restore();
  // 3) the continent coastline, inked over the province seams so the landmass reads as one bounded realm
  traceContinent(g);
  g.strokeStyle = rgba([110, 86, 62], 0.6); g.lineWidth = 2.2; g.stroke();
  // 4) a small capital pin at the landmark + the dark serif house name + the province's terrain name
  for (const o of land) {
    const p = o.p, s = o.seat;
    const capR = 2.2 + Math.min(2.5, o.n * 0.4);
    g.beginPath(); g.arc(s.x, s.y, capR, 0, TAU);
    g.fillStyle = rgba(INK, 0.85); g.fill();
    g.lineWidth = 1; g.strokeStyle = rgba([250, 246, 238], 0.8); g.stroke();
    g.save();
    g.textAlign = "center"; g.textBaseline = "middle";
    g.font = "700 " + Math.round(Math.min(30, 17 + o.n * 1.7)) + "px Fraunces, Cinzel, Georgia, serif";
    // the halo is painted as a stroke under the ink — a text shadow costs a Gaussian blur pass per label frame
    const nameLabel = (p.sigil ? p.sigil + " " : "") + p.name;
    g.lineJoin = "round"; g.miterLimit = 2;
    g.strokeStyle = rgba([250, 246, 238], 0.85); g.lineWidth = 3.4;
    g.strokeText(nameLabel, s.x, s.y - 54);   // lifted clear of the stronghold + pennant
    g.fillStyle = rgba(mix(p.color, INK, 0.55), 0.96);
    g.fillText(nameLabel, s.x, s.y - 54);
    // the province's terrain name, small and muted, so the map reads "House X holds the High Peaks"
    g.font = "600 11px Georgia, serif"; g.fillStyle = rgba([92, 74, 56], 0.75);
    g.fillText(o.region.name, s.x, s.y - 38);
    // the conqueror's banner flying over a seized province: ♜ + the house that now holds the ground
    if (p.occupied) {
      g.font = "700 12px Fraunces, Cinzel, Georgia, serif"; g.fillStyle = rgba([176, 42, 32], 0.95);
      g.fillText("♜ " + p.occupiedBy, s.x, s.y - 70);
    }
    g.restore();
  }
}
/** The UNCLAIMED lands: every other continent / isle of the world atlas wears the same pastel-block template as
 *  the home provinces (neutral tint + brown border) plus an English "UNCLAIMED TERRITORY" cartouche. The polygons
 *  and labels are STATIC in world space, so the whole read is baked into a world-sized offscreen (uncOff) at the
 *  field's current size; each frame is a single drawImage — no per-frame polygon fill, stroke or fillText. */
export function bakeUnc() {
  const w = Math.round(state.MAP.w), h = Math.round(state.MAP.h);
  if (!state.uncOff) state.uncOff = document.createElement("canvas");
  if (state.uncOff.width !== w || state.uncOff.height !== h) { state.uncOff.width = w; state.uncOff.height = h; }
  const g = state.uncOff.getContext("2d");
  g.setTransform(1, 0, 0, 1, 0, 0); g.clearRect(0, 0, w, h);
  g.lineJoin = "round";
  for (const u of UNCLAIMED) {
    g.beginPath();
    for (let i = 0; i < u.poly.length; i++) { const p = mw(u.poly[i]); i ? g.lineTo(p.x, p.y) : g.moveTo(p.x, p.y); }
    g.closePath();
    g.fillStyle = rgba([214, 206, 186], 0.42); g.fill();
    g.strokeStyle = rgba([120, 96, 70], 0.45); g.lineWidth = 1.4; g.stroke();
    if (u.label) {
      const c = mw(u.label);
      g.save();
      g.textAlign = "center"; g.textBaseline = "middle";
      try { g.letterSpacing = "2px"; } catch { /* older engines */ }
      g.font = "600 12px Cinzel, Fraunces, Georgia, serif";
      g.lineJoin = "round"; g.miterLimit = 2;
      g.strokeStyle = rgba([250, 246, 238], 0.85); g.lineWidth = 3.4;
      g.strokeText("UNCLAIMED TERRITORY", c.x, c.y);   // a painted stroke halo (cheaper than a per-text blur)
      g.fillStyle = rgba([92, 74, 56], 0.72);
      g.fillText("UNCLAIMED TERRITORY", c.x, c.y);
      g.restore();
    }
  }
  state.uncKey = state.VW + "x" + state.VH + "@" + state.DPR;
}
export function renderUnclaimed() {
  if (!state.uncOff || state.uncKey !== state.VW + "x" + state.VH + "@" + state.DPR) bakeUnc();
  state.ctx.drawImage(state.uncOff, 0, 0);
}
/** The map key, pinned to the RIGHT EDGE of the SCREEN (screen space, so it never zooms or pans with the map):
 *  the era title + the largest dominions with their colour swatches (the ref's legend). */
export function drawTerritoryLegend(g, pol) {
  const ranked = pol.slice(0, 6);
  const era = (state.chronMeta && state.chronMeta.eraName) ? state.chronMeta.eraName : "the swarm's dominions";
  const pad = 12, lh = 16, w = 180, h = pad * 2 + lh * (ranked.length + 1);
  // the bottom-left is claimed by the temperature DOM panel and the bottom-right by the chronicle button,
  // so the map key lives in the clear band on the right flank, vertically centred (never under a panel).
  const bx = state.VW - w - 14, by = Math.round((state.VH - h) / 2);
  g.save();
  g.fillStyle = rgba([248, 244, 236], 0.88); g.strokeStyle = rgba([96, 74, 52], 0.45); g.lineWidth = 1;
  if (g.roundRect) { g.beginPath(); g.roundRect(bx, by, w, h, 6); g.fill(); g.stroke(); }
  else { g.fillRect(bx, by, w, h); g.strokeRect(bx, by, w, h); }
  g.textBaseline = "middle"; g.textAlign = "left";
  g.font = "700 12px Fraunces, Cinzel, Georgia, serif"; g.fillStyle = rgba(INK, 0.9);
  g.fillText(era, bx + pad, by + pad + lh * 0.5);
  for (let i = 0; i < ranked.length; i++) {
    const y = by + pad + lh * (i + 1.5);
    g.fillStyle = rgba(ranked[i].p.color, 0.95); g.fillRect(bx + pad, y - 5, 10, 10);
    g.strokeStyle = rgba(INK, 0.5); g.lineWidth = 0.8; g.strokeRect(bx + pad + 0.5, y - 4.5, 9, 9);
    g.font = "600 11px Georgia, serif"; g.fillStyle = rgba(INK, 0.85);
    g.fillText(ranked[i].p.name + "  ·  " + ranked[i].n, bx + pad + 16, y);
  }
  g.restore();
}
export function render(pal, now) {
  // 3D scene mode: Three.js owns the canvas, DOM panels float above
  if (state.threeScene) {
    state.threeScene.update(sim, state.econCities, now);
    state.threeScene.render();
    return;
  }
  // ── 2D fallback: lazily create the 2D context (only if Three.js failed to init) ──
  if (!state.ctx) state.ctx = canvas.getContext("2d");
  // C2: if the WebGLRenderer already claimed this canvas, getContext("2d") returns null — a 2D fallback is
  // then impossible. Bail out loudly instead of throwing a TypeError on the very next state.ctx.fillStyle.
  if (!state.ctx) { console.error('[murmur] canvas bound to WebGL, 2D fallback impossible'); return; }
  state.ctx.fillStyle = "rgb(238, 232, 219)"; state.ctx.fillRect(0, 0, state.VW, state.VH);
  state.ctx.save(); applyCam();     // ---- WORLD space: the atlas, its provinces, the swarm and ambient life move as one ----
  if (TEX.ground.ready) {
    // The parchment WORLD atlas drawn over its full world rect (bigger than the viewport): the home continent
    // lands exactly on world [0,VW]x[0,VH] (framed at z=1, where the flies live) and the other continents lie
    // beyond it, revealed as you zoom out. Provinces are clipped to the continent, so the dominions ARE the land.
    // 70% opacity: the engraved atlas recedes into a backdrop and never competes with the living swarm.
    state.ctx.globalAlpha = 0.7;
    state.ctx.drawImage(TEX.ground.im, state.MAP.x0, state.MAP.y0, state.MAP.w, state.MAP.h);
    state.ctx.globalAlpha = 1;
  } else {
    // aged-parchment base (offscreen, rebuilt on resize / temperature-bucket change / ~2s): one blit per frame.
    const pkey = state.VW + "x" + state.VH + ":" + Math.round(state.tempSmoothed * 8);
    if (!state.parchOff || state.parchKey !== pkey || now - state.parchLast > 2000) { state.parchKey = pkey; state.parchLast = now; rebuildParchment(pal); }
    state.ctx.drawImage(state.parchOff, 0, 0, state.VW, state.VH);
    state.ctx.fillStyle = rgba(pal.accent, 0.03 + state.tempSmoothed * 0.05); state.ctx.fillRect(0, 0, state.VW, state.VH);
  }

  // the swarm's ambient neural aura — deepest background layer, breathing with the collective mood
  renderMind(pal, now);

  // ambient flow ink (under everything)
  if (state.qualityCoeff > 0.3) renderMotes(pal);

  // the UNCLAIMED continents & isles of the world atlas, tinted + labelled in world space (never clipped)
  if (state.showTerritory) renderUnclaimed();

  // the TERRITORY map: each house a coloured dominion (rivers + hatched regions + names), beneath the societies web
  renderTerritoryMap();

  // the LAND COMES ALIVE: beacon fires over seized ground, waving house banners, capital hearth-smoke,
  // river shimmer and a passing flock — all world-locked to the map, drawn over it but under the flies.
  // Wrapped so a decoration bug can never veto the rest of the frame (the flies must still be drawn).
  try { renderLandLife(pal, now); } catch { /* ambient only — never break the frame */ }

  // ⑭㉖ THE LAND IS SETTLED: real named towns grown from the swarm's own zones, their public works and the
  // golden caravan road between the two greatest — world-locked over the dominion map, under the flies.
  try { renderCivilization(now); } catch { /* ambient only — never break the frame */ }

  // the societies layer: colony territories + bond filaments, drawn under the mesh and the flies
  renderSocieties(pal, now);

  // the persistent necropolis: weathered headstones for every buried wallet the ledger remembers
  renderGraveyard(pal, now);

  // fading grave steles at observed death positions (a just-died glow riding above the old stones)
  renderMonuments(pal, now);

  const acc = pal.accent;

  // murmuration mesh: faint threads between close flies when the swarm is cohesive
  if (state.qualityCoeff > 0.6 && state.cohSmoothed > 0.34) {
    const list = [...sim.values()].filter((f) => !f.dying);
    const R = 74 + state.cohSmoothed * 46;
    state.ctx.lineWidth = 0.6;
    for (let i = 0; i < list.length; i++) {
      for (let j = i + 1; j < list.length; j++) {
        const a = list[i], b = list[j];
        const dx = a.x - b.x, dy = a.y - b.y, dd2 = dx * dx + dy * dy;   // squared first: sqrt only for pairs that actually link
        if (dd2 < R * R) {
          const dd = Math.sqrt(dd2);
          const al = (1 - dd / R) * (state.cohSmoothed - 0.34) * 0.5;
          state.ctx.strokeStyle = rgba(mix([26, 26, 24], acc, 0.4), al);
          state.ctx.beginPath(); state.ctx.moveTo(a.x, a.y); state.ctx.lineTo(b.x, b.y); state.ctx.stroke();
        }
      }
    }
  }

  // the FlyShardDO isolates: a ring of compute nodes around the swarm, pulsing in fan-out waves each tick
  if (state.qualityCoeff > 0.3) renderShards(pal, now);

  // task 22 B1 — the pointer/stimulus ripple loop is GONE. The user asked for the click rings to be
  // cancelled outright (task 20④), camera.js stopped pushing to state.ripples and the 3D pool was
  // deleted; this draw loop was the last reader, iterating an array that could only ever be empty.
  // state.ripples itself has been removed from shared.js — grep for `ripples` now only finds prose
  // in the chronicle-law comments and the app.js backup (which index.html never loads).

  // the flies (viewport-culled: once zoomed in, only the visible subset is drawn at all — the swarm
  // spans the whole world rect, so at high zoom most bodies used to be painted straight off-screen)
  const fx0 = -state.cam.x / state.cam.z - 48, fy0 = -state.cam.y / state.cam.z - 48;
  const fx1 = (state.VW - state.cam.x) / state.cam.z + 48, fy1 = (state.VH - state.cam.y) / state.cam.z + 48;
  for (const f of sim.values()) {
    let alpha = clamp((now - f.born) / 900);
    if (f.dying) alpha = clamp(1 - (now - (f.dieT || now)) / 820);
    if (alpha <= 0.001) continue;
    if (f.dying && !f._mon) plantMonument(f, now);   // a death observed live leaves a fading stele
    if (f.x < fx0 || f.x > fx1 || f.y < fy0 || f.y > fy1) continue;   // off-screen: nothing to paint
    drawFly(f, acc, alpha, now);
  }

  // x402 settlement packets flying payer → payee (over the swarm, so the money is visible)
  renderPayments(pal, now);

  // the chronicle made visible: transient alliance/feud/house/legislative events, over the swarm
  renderChronFx(pal, now);

  // ⑪ the faith membrane made visible: prophet halos + the holy-day candle wash (a pure read-out)
  renderFaithFx(now);

  // the chronicle made PERSISTENT: ⑪ the reigning-god totem, ⑬⑯ the ladder/school stele grove + last-keeper
  // halos, ⑲ the bourse coffer + coin-embers — world-space read-outs of the econ* vars, gated by #chronicle.
  // Wrapped so a decoration bug can never veto the rest of the frame (the flies are already drawn above).
  try { renderChronAmbient(pal, now); } catch { /* ambient only — never break the frame */ }
  state.ctx.restore();               // ---- back to SCREEN space: the manuscript chrome and captions never move ----

  // a slow day/night + temperature tone drift laid over the whole field (kept LIGHT: this is a parchment atlas)
  try { renderDayNight(pal, now); } catch { /* ambient only */ }

  // the current era, announced at the BOTTOM-CENTRE of the field as a monumental gilded banner
  drawEraHeader(pal);

  // the map key (era + house swatches) pinned to the RIGHT EDGE of the SCREEN — screen space, never zooms
  if (state.terrPol) drawTerritoryLegend(state.ctx, state.terrPol);

  // the epic centre-caption (chronicle banner) — pinned to the screen centre, independent of the camera
  renderChronBanner(pal, now);

  // the gilded manuscript border frames the whole field last, above every ink layer
  renderFrame(pal);
}
export function drawFly(f, acc, alpha, now) {
  alpha *= focusDim(f.id);                                   // focus highlight: fade the un-related
  const hs = houseOf.get(f.id);                              // dynasty bloodline tint (ring + trail)
  const flap = Math.sin(f.phase) * 0.5 + 0.5;               // 0..1 wingbeat phase
  const balN = f.balN != null ? f.balN : 0.5;
  // Colour AND size both encode wealth: the richer the wallet, the warmer (slate → gold) and bigger the
  // fly. Balance is normalised 0..1 across the swarm (the real spread is tight, so min-max scaling makes
  // the ranking legible); arousal stays a secondary modulation so an agitated rich fly pulses larger.
  const body = mix([26, 26, 24], wealthColorAt(balN), 0.55 + f.temperament * 0.25);
  const size = (3.4 + balN * 3.4) * (0.92 + f.aro * 0.42);   // a touch larger so the anatomy actually reads
  const fap = f.fap || "FORAGE";
  const valence = f.valence || 0;
  const haloR = size * 3.0 + f.wing * flap * size * 2.4;

  // ink trail: a short stroke from the previous position (stronger when aroused)
  const tdx = f.x - f.px, tdy = f.y - f.py;
  if (state.qualityCoeff > 0.3 && tdx * tdx + tdy * tdy > 0.6) {
    state.ctx.strokeStyle = rgba(hs && hs.color ? mix(body, hs.color, 0.8) : body, (0.10 + f.aro * 0.22) * alpha);
    state.ctx.lineWidth = size * 0.8;
    state.ctx.beginPath(); state.ctx.moveTo(f.px, f.py); state.ctx.lineTo(f.x, f.y); state.ctx.stroke();
  }

  // soft halo (cached sprite) + a valence-tinted rim: warm when appetitive, cool/alert when aversive
  if (state.haloSprite) {
    state.ctx.globalAlpha = (0.10 + f.aro * 0.14) * alpha;   // a soft lift so each fly separates from the parchment
    state.ctx.drawImage(state.haloSprite, f.x - haloR, f.y - haloR, haloR * 2, haloR * 2);
    state.ctx.globalAlpha = 1;
    if (state.qualityCoeff > 0.6 && Math.abs(valence) > 0.22) {
      const rim = valence >= 0 ? [150, 170, 90] : [176, 74, 58];
      state.ctx.strokeStyle = rgba(rim, (Math.abs(valence) - 0.22) * 0.55 * alpha);
      state.ctx.lineWidth = 1;
      state.ctx.beginPath(); state.ctx.arc(f.x, f.y, haloR * 0.9, 0, TAU); state.ctx.stroke();
    }
  }

  // the articulated fly — or, at low quality, the original cheap comma + wing arcs.
  // A fly the eye is actually ON (selected, hovered, or zoomed in on) keeps its full anatomy even when
  // adaptive quality has shed it for the swarm: one articulated body is cheap, and the individual the
  // reader is studying must never collapse to a comma-blob.
  // LOD (Level of Detail): full anatomy is expensive (~20-30 canvas ops per fly). At swarm scale
  // (cam.z≈1.0), the leg/antenna/proboscis details are invisible, so we only draw full anatomy when:
  //   - the fly is inspected (selected/hovered/zoomed>=1.5), OR
  //   - qualityCoeff>0.6 AND zoom>=0.9× (high-end machine, almost always at default zoom), OR
  //   - qualityCoeff>0.3 AND zoom>=1.4× (moderately zoomed in, details become visible)
  // Otherwise, a simplified ellipse + wing blur preserves the color/size encoding at 1/10th the cost.
  const inspected = f.id === state.selectedId || f.id === state.hoverId || state.cam.z >= 1.5;
  state.ctx.save();
  state.ctx.translate(f.x, f.y); state.ctx.rotate(f.heading);
  if (inspected || (state.qualityCoeff > 0.6 && state.cam.z >= 0.9) || (state.qualityCoeff > 0.3 && state.cam.z >= 1.4)) drawFlyAnatomy(f, size, flap, alpha, body, acc, fap, now, inspected);
  else {
    // simplified fly: body ellipse + wing blur, preserving wealth color/size encoding
    // a subtle wing blur (two faint arcs) suggests motion without the full anatomy cost
    const wspread = 0.5 + flap * 0.9;
    state.ctx.strokeStyle = rgba(acc, (0.08 + f.wing * 0.18) * alpha);
    state.ctx.lineWidth = 0.6;
    for (const s of [-1, 1]) {
      state.ctx.beginPath();
      state.ctx.ellipse(-size * 0.25, s * size * 0.45, size * 1.4, size * 0.55, s * wspread, 0, TAU);
      state.ctx.stroke();
    }
    state.ctx.fillStyle = rgba(body, (0.55 + f.aro * 0.4) * alpha);
    state.ctx.beginPath(); state.ctx.ellipse(0, 0, size * 1.4, size * 0.78, 0, 0, TAU); state.ctx.fill();
    // a faint dorsal stripe so the body reads as three-dimensional even at low LOD
    if (state.qualityCoeff > 0.3) {
      state.ctx.strokeStyle = rgba(mix(body, [0, 0, 0], 0.3), 0.15 * alpha);
      state.ctx.lineWidth = 0.4;
      state.ctx.beginPath(); state.ctx.moveTo(-size * 0.8, 0); state.ctx.lineTo(size * 0.8, 0); state.ctx.stroke();
    }
  }
  state.ctx.restore();

  // dynasty bloodline: a bold house-coloured band + a comet streak, so a family reads as coloured
  // ribbons inside its colony at a glance (two concentric rings + a trailing ribbon when moving)
  if (hs && hs.color) {
    state.ctx.strokeStyle = rgba(hs.color, 0.9 * alpha);
    state.ctx.lineWidth = 2.0;
    state.ctx.beginPath(); state.ctx.arc(f.x, f.y, size * 2.2, 0, TAU); state.ctx.stroke();
    state.ctx.strokeStyle = rgba(hs.color, 0.35 * alpha);
    state.ctx.lineWidth = 1;
    state.ctx.beginPath(); state.ctx.arc(f.x, f.y, size * 2.9, 0, TAU); state.ctx.stroke();
    const sp = Math.hypot(f.vx, f.vy);
    if (sp > 0.12) {
      const ux = f.vx / sp, uy = f.vy / sp;
      for (let k = 1; k <= 3; k++) {
        state.ctx.fillStyle = rgba(hs.color, (0.34 - k * 0.09) * alpha);
        state.ctx.beginPath(); state.ctx.arc(f.x - ux * k * size * 1.5, f.y - uy * k * size * 1.5, Math.max(0.6, size * (0.55 - k * 0.13)), 0, TAU); state.ctx.fill();
      }
    }
  }

  // bred-offspring marker: a thin accent ring around any live fly hatched PAST the fixed genesis cohort
  // (id >= populationSize). Genesis flies are the permanent founding 24; a ring means "this individual was
  // bred on-chain and bootstrapped into the live swarm by a parent's own realised profit". Never fires
  // while the live population equals genesis (no growth configured), so the default scene is unchanged.
  const genesisN = state.topology && state.topology.populationSize;
  if (genesisN != null && f.id >= genesisN) {
    state.ctx.strokeStyle = rgba(acc, 0.5 * alpha);
    state.ctx.lineWidth = 1;
    state.ctx.beginPath(); state.ctx.arc(f.x, f.y, size * 2.6 + 2, 0, TAU); state.ctx.stroke();
  }

  // selection ring + a heading tick along the persistent internal compass (the ring-attractor direction)
  if (f.id === state.selectedId) {
    const rr = size * 4 + 4 + flap * 1.6;
    state.ctx.strokeStyle = rgba(acc, 0.85 * alpha);
    state.ctx.lineWidth = 1;
    state.ctx.beginPath(); state.ctx.arc(f.x, f.y, rr, 0, TAU); state.ctx.stroke();
    if (f.sHead != null && state.qualityCoeff > 0.3) {
      state.ctx.strokeStyle = rgba(acc, 0.5 * alpha);
      state.ctx.beginPath();
      state.ctx.moveTo(f.x + Math.cos(f.sHead) * rr, f.y + Math.sin(f.sHead) * rr);
      state.ctx.lineTo(f.x + Math.cos(f.sHead) * (rr + 7), f.y + Math.sin(f.sHead) * (rr + 7));
      state.ctx.stroke();
    }
  }
}
// A recognisable Drosophila drawn in local space (+x = the direction of travel): two veined wings, six
// bent legs in an alternating tripod gait, a striped abdomen, a thorax, a head with two red compound
// eyes + feathery antennae, and a proboscis that pumps while feeding. The named action pattern drives
// the pose — COURT extends & vibrates ONE wing (the male love song), GROOM sweeps the front legs over the
// head, FLIGHT/RETREAT blur the spread wings, REST/HALT fold everything tight. Detail is shed as qualityCoeff falls.
export function drawFlyAnatomy(f, s, flap, alpha, body, acc, fap, now, forceDetail) {
  const detail = state.qualityCoeff > 0.6 || forceDetail;
  const rest = f.rest ?? 0;
  const lp = f.legPhase ?? 0;
  const parked = fap === "REST" || fap === "HALT";
  const walk = (1 - rest * 0.85) * (parked ? 0.12 : 1);
  const abdomen = mix(body, [16, 16, 14], 0.2);
  const chitin = mix(body, [8, 8, 7], 0.4);
  const flying = fap === "FLIGHT" || fap === "RETREAT";
  const court = fap === "COURT";
  const side = f.courtSide || 1;

  // ---- wings (drawn first so the body overlaps their base) ----
  const wingLen = s * 2.1, wingW = s * 0.6, fold = parked ? 0.2 : 1;
  for (const sg of [-1, 1]) {
    let cx = -wingLen * 0.4, cy = sg * s * 0.3, ang = sg * (0.5 + flap * 0.42) * fold, len = wingLen;
    if (court && sg === side) { cx = wingLen * 0.16; cy = sg * s * 0.5; ang = sg * (-0.95 + Math.sin(now * 0.055) * 0.16); len = wingLen * 1.18; }
    else if (flying) { ang = sg * (0.82 + flap * 0.5); }
    state.ctx.save();
    state.ctx.rotate(ang);
    state.ctx.fillStyle = rgba(mix([236, 239, 242], acc, 0.16), (flying ? 0.18 : 0.30) * alpha);
    state.ctx.beginPath(); state.ctx.ellipse(cx, cy, len * 0.5, wingW, 0, 0, TAU); state.ctx.fill();
    // a faint outline so the wing silhouette reads against the paper (the vein alone is too subtle)
    state.ctx.strokeStyle = rgba(mix([120, 122, 120], acc, 0.25), (0.30 + f.wing * 0.2) * alpha);
    state.ctx.lineWidth = Math.max(0.4, s * 0.05);
    state.ctx.beginPath(); state.ctx.ellipse(cx, cy, len * 0.5, wingW, 0, 0, TAU); state.ctx.stroke();
    if (detail) {
      state.ctx.strokeStyle = rgba(mix([110, 112, 110], acc, 0.2), (0.2 + f.wing * 0.18) * alpha);
      state.ctx.lineWidth = 0.5;
      state.ctx.beginPath(); state.ctx.moveTo(cx + len * 0.42, cy); state.ctx.lineTo(cx - len * 0.46, cy + sg * wingW * 0.2); state.ctx.stroke();
      if (flying) { state.ctx.strokeStyle = rgba([238, 240, 242], 0.09 * alpha); state.ctx.beginPath(); state.ctx.ellipse(cx, cy, len * 0.5, wingW * 1.7, 0, 0, TAU); state.ctx.stroke(); }
    }
    state.ctx.restore();
  }

  // ---- legs: six bent legs in an alternating tripod gait; GROOM lifts the front pair to the head ----
  state.ctx.strokeStyle = rgba(mix(chitin, [0, 0, 0], 0.06), (0.5 + f.aro * 0.25) * alpha);
  state.ctx.lineWidth = Math.max(0.5, s * 0.11);
  state.ctx.lineCap = "round"; state.ctx.lineJoin = "round";
  const groom = fap === "GROOM";
  for (const sg of [-1, 1]) {
    for (let i = 0; i < 3; i++) {                 // 0 = pro (front), 1 = meso (mid), 2 = meta (hind)
      const hipX = s * (0.46 - i * 0.48), hipY = sg * s * 0.26;
      let kneeX, kneeY, footX, footY;
      if (groom && i === 0) {                      // the front leg sweeps up over the compound eye
        const g = Math.sin(now * 0.013 + sg * 1.4) * 0.5 + 0.5;
        footX = s * (1.05 + g * 0.4); footY = sg * s * (0.12 + g * 0.08);
        kneeX = s * 0.72; kneeY = sg * s * (0.66 - g * 0.24);
      } else {
        const tri = (i === 1) ? Math.PI : 0;       // tripod: the mid leg swings opposite front + hind
        const swing = Math.sin(lp + tri + (sg > 0 ? 0 : Math.PI * 0.5)) * s * 0.38 * walk;
        footX = hipX + s * (0.6 - i * 0.5) + swing;
        footY = sg * s * (0.92 + i * 0.12);
        kneeX = (hipX + footX) * 0.5; kneeY = sg * s * (0.64 + i * 0.05);
      }
      state.ctx.beginPath(); state.ctx.moveTo(hipX, hipY); state.ctx.lineTo(kneeX, kneeY); state.ctx.lineTo(footX, footY); state.ctx.stroke();
    }
  }

  // ---- abdomen (rear): a tapered barrel with transverse stripes ----
  const abX = -s * 1.0, abL = s * 1.12, abW = s * 0.5;
  state.ctx.fillStyle = rgba(abdomen, (0.74 + f.aro * 0.2) * alpha);
  state.ctx.beginPath(); state.ctx.ellipse(abX, 0, abL, abW, 0, 0, TAU); state.ctx.fill();
  if (detail) {
    state.ctx.strokeStyle = rgba(mix(abdomen, [0, 0, 0], 0.42), 0.38 * alpha);
    state.ctx.lineWidth = Math.max(0.4, s * 0.085);
    // stripe count scales continuously with the quality coefficient: 1 at the detail threshold → 3 at full
    const stripeN = 1 + Math.round(2 * clamp((state.qualityCoeff - 0.6) / 0.4, 0, 1));
    for (let k = 1; k <= stripeN; k++) {
      const gx = abX + abL * (0.1 + (k / stripeN) * 0.78);
      state.ctx.beginPath(); state.ctx.ellipse(gx, 0, s * 0.045, abW * (0.9 - (k / stripeN) * 0.33), 0, 0, TAU); state.ctx.stroke();
    }
  }
  // ---- thorax (middle): the muscular box the wings & legs attach to ----
  state.ctx.fillStyle = rgba(body, (0.82 + f.aro * 0.16) * alpha);
  state.ctx.beginPath(); state.ctx.ellipse(s * 0.2, 0, s * 0.76, s * 0.58, 0, 0, TAU); state.ctx.fill();
  if (detail) {
    state.ctx.strokeStyle = rgba(mix(body, [0, 0, 0], 0.34), 0.28 * alpha);
    state.ctx.lineWidth = Math.max(0.4, s * 0.07);
    state.ctx.beginPath(); state.ctx.moveTo(s * 0.62, -s * 0.1); state.ctx.lineTo(-s * 0.28, -s * 0.12); state.ctx.stroke();
  }
  // ---- head + the two big red compound eyes ----
  const headX = s * 1.0;
  state.ctx.fillStyle = rgba(chitin, (0.86 + f.aro * 0.12) * alpha);
  state.ctx.beginPath(); state.ctx.ellipse(headX, 0, s * 0.5, s * 0.45, 0, 0, TAU); state.ctx.fill();
  for (const sg of [-1, 1]) {
    state.ctx.fillStyle = rgba([152, 44, 32], 0.92 * alpha);
    state.ctx.beginPath(); state.ctx.ellipse(headX + s * 0.04, sg * s * 0.25, s * 0.25, s * 0.3, sg * 0.35, 0, TAU); state.ctx.fill();
    if (detail) { state.ctx.fillStyle = rgba([226, 132, 110], 0.5 * alpha); state.ctx.beginPath(); state.ctx.ellipse(headX + s * 0.12, sg * s * 0.2, s * 0.07, s * 0.09, 0, 0, TAU); state.ctx.fill(); }
  }
  // ---- antennae (a lazy sweep) ----
  if (detail) {
    state.ctx.strokeStyle = rgba(chitin, 0.7 * alpha);
    state.ctx.lineWidth = Math.max(0.4, s * 0.07);
    const asw = Math.sin(now * 0.004 + (f.id || 0)) * 0.16;
    for (const sg of [-1, 1]) {
      state.ctx.beginPath(); state.ctx.moveTo(headX + s * 0.34, sg * s * 0.08);
      state.ctx.lineTo(headX + s * 0.78, sg * s * (0.3 + asw)); state.ctx.stroke();
    }
  }
  // ---- proboscis: the rostrum pumps forward-down while FEEDING ----
  if (fap === "FEED") {
    const pump = Math.sin(now * 0.02) * 0.5 + 0.5;
    state.ctx.strokeStyle = rgba(mix(chitin, [128, 84, 40], 0.5), 0.9 * alpha);
    state.ctx.lineWidth = Math.max(0.6, s * 0.15);
    state.ctx.beginPath(); state.ctx.moveTo(headX + s * 0.3, 0);
    state.ctx.lineTo(headX + s * (0.82 + pump * 0.32), s * 0.1); state.ctx.stroke();
  }
}
// ================= temperature history ribbon =================
export const thCanvas = $("temp-history");
export const thCtx = thCanvas ? thCanvas.getContext("2d") : null;
export function sampleHistory() {
  const wall = Date.now();
  if (wall - state.lastHistSample < HIST_SAMPLE_MS) return;
  state.lastHistSample = wall;
  tempHistory.push({ t: wall, T: state.tempSmoothed });
  while (tempHistory.length && wall - tempHistory[0].t > RIBBON_WINDOW) tempHistory.shift();
}
/** Merge the D1 archived per-cron temperatures with the live in-memory tail into ONE wall-clock series,
 *  so the ribbon shows real history (reload-persistent) plus the freshest live head. Tolerates a little
 *  client/server clock skew. Without history it is just the live tail (the original behaviour). */
export function ribbonSeries(wall) {
  const out = [];
  if (state.histEnabled) {
    for (const r of state.histRows) {
      if (r.ts == null || r.temperature == null) continue;
      if (r.ts <= wall + 120000 && wall - r.ts <= RIBBON_WINDOW) out.push({ t: r.ts, T: r.temperature });
    }
  }
  for (const p of tempHistory) if (wall - p.t <= RIBBON_WINDOW) out.push({ t: p.t, T: p.T });
  out.sort((a, b) => a.t - b.t);
  return out;
}
export function drawTempHistory() {
  if (!thCtx) return;
  const wall = Date.now();
  const W = thCanvas.width, H = thCanvas.height;
  const pal = paletteAt(state.tempSmoothed);
  thCtx.clearRect(0, 0, W, H);

  // regime threshold guides (cold ≤ .33, hot ≥ .66)
  thCtx.strokeStyle = rgba(mix([26, 26, 24], pal.accent, 0.3), 0.14);
  thCtx.lineWidth = 1;
  for (const th of [0.33, 0.66]) {
    const y = H - th * H;
    thCtx.beginPath(); thCtx.moveTo(0, y); thCtx.lineTo(W, y); thCtx.stroke();
  }

  const series = ribbonSeries(wall);
  if (series.length < 2) return;

  const xOf = (t) => W - ((wall - t) / RIBBON_WINDOW) * W;
  const yOf = (T) => H - clamp(T) * H;

  // area under the curve
  thCtx.beginPath();
  thCtx.moveTo(xOf(series[0].t), H);
  for (const p of series) thCtx.lineTo(xOf(p.t), yOf(p.T));
  thCtx.lineTo(xOf(series[series.length - 1].t), H);
  thCtx.closePath();
  const grad = thCtx.createLinearGradient(0, 0, 0, H);
  grad.addColorStop(0, rgba(pal.accent, 0.30));
  grad.addColorStop(1, rgba(pal.accent, 0.02));
  thCtx.fillStyle = grad;
  thCtx.fill();

  // the temperature line
  thCtx.beginPath();
  for (let i = 0; i < series.length; i++) {
    const p = series[i];
    if (i === 0) thCtx.moveTo(xOf(p.t), yOf(p.T)); else thCtx.lineTo(xOf(p.t), yOf(p.T));
  }
  thCtx.strokeStyle = rgba(pal.accent, 0.85);
  thCtx.lineWidth = 1.4;
  thCtx.stroke();

  // live head
  const head = series[series.length - 1];
  thCtx.fillStyle = rgba(pal.accent, 0.95);
  thCtx.beginPath(); thCtx.arc(xOf(head.t), yOf(head.T), 2, 0, TAU); thCtx.fill();
}
// ================= agent economy: render + data =================
// Draw each live settlement as a packet travelling from the payer fly to the payee fly, with a faint
// guide thread. Colour encodes the good being bought (signal / momentum / attestation); declined
// attempts (insufficient funds) draw dimmer so the ledger stays honest.
export function renderPayments(pal, now) {
  if (!state.payEdges.length) return;
  for (let i = state.payEdges.length - 1; i >= 0; i--) {
    const e = state.payEdges[i];
    const dur = e.real ? 2800 : ECON_EDGE_MS;   // a real on-chain trade flashes longer so it's unmissable
    const age = (now - e.t0) / dur;
    if (age >= 1) { state.payEdges.splice(i, 1); continue; }
    const a = sim.get(e.fromId), b = sim.get(e.toId);
    if (!a || !b || a.dying || b.dying) { state.payEdges.splice(i, 1); continue; }
    if (e.real) renderRealTrade(a, b, e, clamp(age), now);
    else renderSimTrade(a, b, e, age, pal);
  }
}
// A real on-chain settlement gets an unmissable rainbow "money beam": a glowing gradient link, a
// bright comet packet with a colourful tail + sparks, and expanding flash rings at both wallets — so
// anyone watching instantly sees that two flies just paid each other in real USDC.
export function renderRealTrade(a, b, e, age, now) {
  const fade = clamp(age < 0.12 ? age / 0.12 : (1 - age) / 0.88);   // quick in, slow out
  const hueBase = (now * 0.11 + e.fromId * 41 + e.toId * 67) % 360; // slowly cycling, unique per pair
  const amt = Math.min(1, e.amount * 520);                          // bigger trade → fatter, brighter

  // rainbow beam + glow
  const g = state.ctx.createLinearGradient(a.x, a.y, b.x, b.y);
  for (let s = 0; s <= 5; s++) {
    const h = (hueBase + s * 46) % 360;
    g.addColorStop(s / 5, `hsla(${h},100%,62%,${0.12 + 0.5 * fade})`);
  }
  state.ctx.save();
  state.ctx.lineCap = "round";
  // the glow is painted as stacked strokes on one path (wide faint halo → gradient body → thin bright core)
  // instead of a shadow — a shadow-blur costs a full offscreen pass per frame, three strokes cost almost nothing
  const bw = (1.2 + amt * 3.2) * (0.5 + fade * 0.9);
  state.ctx.beginPath(); state.ctx.moveTo(a.x, a.y); state.ctx.lineTo(b.x, b.y);
  state.ctx.strokeStyle = `hsla(${hueBase},100%,60%,${0.35 * fade})`;
  state.ctx.lineWidth = bw * 3.4; state.ctx.stroke();
  state.ctx.strokeStyle = g; state.ctx.lineWidth = bw; state.ctx.stroke();
  state.ctx.strokeStyle = `hsla(${(hueBase + 30) % 360},100%,78%,${0.7 * fade})`;
  state.ctx.lineWidth = Math.max(0.6, bw * 0.34); state.ctx.stroke();
  state.ctx.restore();

  // comet: colourful tail + white-hot head
  const t = age;
  const px = lerp(a.x, b.x, t), py = lerp(a.y, b.y, t);
  const bt = Math.max(0, t - 0.16);
  const tx = lerp(a.x, b.x, bt), ty = lerp(a.y, b.y, bt);
  const tg = state.ctx.createLinearGradient(tx, ty, px, py);
  tg.addColorStop(0, `hsla(${(hueBase + 120) % 360},100%,60%,0)`);
  tg.addColorStop(1, `hsla(${(hueBase + 210) % 360},100%,74%,${0.85 * fade})`);
  state.ctx.strokeStyle = tg; state.ctx.lineWidth = 2.4 + amt * 3; state.ctx.lineCap = "round";
  state.ctx.beginPath(); state.ctx.moveTo(tx, ty); state.ctx.lineTo(px, py); state.ctx.stroke();
  const hr = (2.4 + amt * 3.4) * 3;
  const hg = state.ctx.createRadialGradient(px, py, 0, px, py, hr);
  hg.addColorStop(0, `hsla(0,0%,100%,${0.95 * fade})`);
  hg.addColorStop(0.35, `hsla(${hueBase},100%,72%,${0.75 * fade})`);
  hg.addColorStop(1, `hsla(${hueBase},100%,60%,0)`);
  state.ctx.fillStyle = hg; state.ctx.beginPath(); state.ctx.arc(px, py, hr, 0, TAU); state.ctx.fill();

  // sparks trailing the comet (shed first when the frame budget is blown)
  if (state.qualityCoeff > 0.3) {
    for (let s = 0; s < 5; s++) {
      const st = Math.max(0, t - 0.03 - s * 0.035);
      const sx = lerp(a.x, b.x, st), sy = lerp(a.y, b.y, st);
      const ang = now * 0.02 + s * 2.1 + e.fromId;
      const rr = 2 + s * 1.6;
      state.ctx.fillStyle = `hsla(${(hueBase + s * 40) % 360},100%,66%,${Math.max(0, 0.6 - s * 0.11) * fade})`;
      state.ctx.beginPath(); state.ctx.arc(sx + Math.cos(ang) * rr * 0.5, sy + Math.sin(ang) * rr * 0.5, Math.max(0.4, 1.5 - s * 0.22), 0, TAU); state.ctx.fill();
    }
  }

  // expanding flash rings at both wallets — the "a trade just happened" signal
  if (age < 0.62) {
    const rp = age / 0.62, rr = 6 + rp * 32, ra = (1 - rp) * 0.7 * fade;
    state.ctx.lineWidth = 2 * (1 - rp) + 0.4;
    for (const p of [a, b]) {
      state.ctx.strokeStyle = `hsla(${hueBase},100%,68%,${ra})`;
      state.ctx.beginPath(); state.ctx.arc(p.x, p.y, rr, 0, TAU); state.ctx.stroke();
    }
  }
}
// The understated style for non-on-chain settlements (offline / simulated): a faint thread + packet.
export function renderSimTrade(a, b, e, age, pal) {
  const col = GOOD_COL[e.good] || pal.accent;
  const fade = (1 - age) * (e.valid ? 1 : 0.4);

  // guide thread
  state.ctx.strokeStyle = rgba(col, 0.05 + 0.1 * fade);
  state.ctx.lineWidth = 0.7;
  state.ctx.beginPath(); state.ctx.moveTo(a.x, a.y); state.ctx.lineTo(b.x, b.y); state.ctx.stroke();

  // the packet + a short tail behind it
  const t = age;
  const px = lerp(a.x, b.x, t), py = lerp(a.y, b.y, t);
  const bt = Math.max(0, t - 0.09);
  const tx = lerp(a.x, b.x, bt), ty = lerp(a.y, b.y, bt);
  const r = 1.5 + Math.min(2.6, e.amount * 380);
  state.ctx.strokeStyle = rgba(col, 0.42 * fade);
  state.ctx.lineWidth = r * 0.9;
  state.ctx.beginPath(); state.ctx.moveTo(tx, ty); state.ctx.lineTo(px, py); state.ctx.stroke();
  state.ctx.fillStyle = rgba(col, (e.valid ? 0.92 : 0.4) * fade);
  state.ctx.beginPath(); state.ctx.arc(px, py, r, 0, TAU); state.ctx.fill();
}
