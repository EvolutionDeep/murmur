// sim.js — boids 力场 + 社交力场 + spawnFly + motes（任务8：邻居搜索已由 O(n²) 全扫描替换为 SpatialHash 空间哈希）
// 由 app.js 机械拆分（任务5），行为与原文件一致；原文件保留为 app.js 备份参考。
import { state, FAP_SPEED, SOCIETY_ALLY_K, SOCIETY_ALLY_REST, SOCIETY_ANCHOR_K, SOCIETY_FEUD_K, SOCIETY_FEUD_RANGE, SOCIETY_PAD, SOCIETY_SLOT_R, SOCIETY_TERR_GAP, SOCIETY_TERR_K, TAU, clamp, lerp, mix, rgba, sim } from './shared.js';
import { pointer } from './camera.js';

// ================= flow field =================
// A cheap curl-like field from summed sines; the whole swarm + the ambient motes
// ride it, and it speeds up as the market warms.
export function flowAngle(x, y, t) {
  const s = 0.0021;
  const a =
    Math.sin(x * s + t * 0.021) +
    Math.sin(y * s * 1.3 - t * 0.017) +
    Math.sin((x + y) * s * 0.6 + t * 0.011);
  return a * Math.PI * 0.9;
}
export function newMote() {
  const x = Math.random() * state.VW, y = Math.random() * state.VH;
  return { x, y, px: x, py: y, life: 0.6 + Math.random() * 0.6 };
}
export function initMotes() {
  const count = clamp((state.VW * state.VH) / 22000, 48, 150) | 0;
  state.motes = [];
  for (let i = 0; i < count; i++) {
    const m = newMote();
    m.life = Math.random();       // stagger respawns so the field never blinks in unison
    state.motes.push(m);
  }
}
export function updateMotes(dt) {
  const sp = 0.25 + state.tempSmoothed * 1.5;
  for (let i = 0; i < state.motes.length; i++) {
    const m = state.motes[i];
    m.px = m.x; m.py = m.y;
    const a = flowAngle(m.x, m.y, state.flowTime);
    m.x += Math.cos(a) * sp * dt;
    m.y += Math.sin(a) * sp * dt;
    m.life -= 0.0022 * dt;
    if (m.life <= 0 || m.x < -30 || m.x > state.VW + 30 || m.y < -30 || m.y > state.VH + 30) {
      state.motes[i] = newMote();
    }
  }
}
export function renderMotes(pal) {
  if (!state.motes.length) return;
  const ink = mix([26, 26, 24], pal.accent, 0.35);
  state.ctx.lineWidth = 0.7;
  state.ctx.strokeStyle = rgba(ink, 0.02 + state.tempSmoothed * 0.05);
  state.ctx.beginPath();
  for (const m of state.motes) { state.ctx.moveTo(m.px, m.py); state.ctx.lineTo(m.x, m.y); }
  state.ctx.stroke();
}
// ================= flies =================
export function spawnFly(id) {
  const ang = Math.random() * TAU, rad = Math.random() * Math.min(state.VW, state.VH) * 0.22;
  const bx = state.centroidX || state.VW / 2, by = state.centroidY || state.VH / 2;  // centre fallback on first spawn
  const x = bx + Math.cos(ang) * rad, y = by + Math.sin(ang) * rad;
  return {
    id,
    x, y, px: x, py: y,
    vx: 0, vy: 0,
    heading: Math.random() * TAU,
    wander: 0, phase: Math.random() * TAU,
    // smoothed drives (used by the sim) …
    aro: 0.3, coh: 0.5, turn: 0, wing: 0.3, rest: 0.3,
    balN: 0.5, tBalN: 0.5,   // normalised wallet balance (0 = poorest … 1 = richest) → drives body size
    // … and the latest authoritative server reading (used by the inspector)
    tAro: 0.3, tCoh: 0.5, tTurn: 0, tWing: 0.3, tRest: 0.3,
    state: "EXPLORE", temperament: 0.5, fingerprint: "",
    // ethogram read-out (never a settlement input): the named action pattern + its animation carriers
    fap: "FORAGE", tFap: "FORAGE", role: "", valence: 0, tValence: 0,
    tHeading: null, sHead: null, bouts: [], boutAge: 1,
    legPhase: Math.random() * TAU, courtSide: Math.random() < 0.5 ? -1 : 1,
    born: performance.now(), dying: false, dieT: 0,
  };
}
export const SEP = 26;
// personal-space radius (css px)

// ================= spatial hash (task 8) =================
// Uniform-grid neighbour index: rebuilt from the live positions at the top of every frame (flies move each
// frame, so incremental maintenance would cost more than the rebuild) and used to swap the O(n²) separation
// scan for a 3x3-cell query — O(n*k), k = mean neighbours per fly. With cellSize = the perception radius,
// two flies closer than SEP can straddle at most one cell boundary, so the 3x3 window around a query point
// is exhaustive.
export class SpatialHash {
  constructor(cellSize) { this.cell = cellSize; this.buckets = new Map(); }
  clear() { this.buckets.clear(); }
  _key(gx, gy) { return (gx + 4096) * 8192 + (gy + 4096); }   // collision-free for |cell coord| < 4096
  insert(id, x, y) {
    const k = this._key(Math.floor(x / this.cell), Math.floor(y / this.cell));
    let b = this.buckets.get(k);
    if (!b) { b = []; this.buckets.set(k, b); }
    b.push(id);
  }
  /** ids of the cells around (x,y) within `radius`; pass a scratch array as `out` to reuse it across calls */
  query(x, y, radius, out) {
    out = out || [];
    out.length = 0;
    const c = this.cell, R = Math.max(1, Math.ceil(radius / c));
    const gx = Math.floor(x / c), gy = Math.floor(y / c);
    for (let ix = gx - R; ix <= gx + R; ix++) {
      for (let iy = gy - R; iy <= gy + R; iy++) {
        const b = this.buckets.get(this._key(ix, iy));
        if (b) for (let i = 0; i < b.length; i++) out.push(b[i]);
      }
    }
    return out;
  }
}
const neighborHash = new SpatialHash(SEP);
const _nbrBuf = [];

export function updateSim(dt, now) {
  // centroid of the living swarm
  let cx = 0, cy = 0, n = 0;
  for (const f of sim.values()) { if (!f.dying) { cx += f.x; cy += f.y; n++; } }
  if (n) { cx /= n; cy /= n; } else { cx = state.VW / 2; cy = state.VH / 2; }
  state.centroidX = cx; state.centroidY = cy;

  const T = state.tempSmoothed;
  const flowStr = 0.04 + T * 0.20;      // the current pushes harder when it is hot
  const list = [...sim.values()];
  // rebuild the neighbour index from this frame's live positions; dying flies stay OUT so the query
  // result matches the old "skip dying neighbours" scan exactly
  neighborHash.clear();
  for (const f of list) if (!f.dying) neighborHash.insert(f.id, f.x, f.y);

  // ---- societies (MVP) social force field: pre-compute each fly's colony pull into f.sx/f.sy ----
  //      A pure read-out of econSocial — bonded flies attract, feuders repel, colony anchors spread the
  //      societies apart. socOn=false ⇒ no accumulators touched ⇒ byte-for-byte today's boids physics.
  const socOn = state.showSocieties && state.societies && state.societies.colonies.length > 0;
  if (socOn) {
    const smx = Math.max(96, Math.round(state.VW * 0.21)), smy = Math.max(88, Math.round(state.VH * 0.19));
    for (const f of list) { f.sx = 0; f.sy = 0; }
    for (const c of state.societies.colonies) {
      const axp = smx + c.ax * (state.VW - 2 * smx), ayp = smy + c.ay * (state.VH - 2 * smy);
      // spread members on a deterministic disc around the anchor (even polar packing) so a colony reads
      // as a loose cluster; a single-point spring let a calm colony pile all its flies into one blob.
      const m = Math.max(1, c.ids.length);
      for (let k = 0; k < c.ids.length; k++) {
        const f = sim.get(c.ids[k]); if (!f || f.dying) continue;
        const ang = (k / m) * TAU + (c.founder ?? 0) * 0.7;
        const rad = SOCIETY_SLOT_R * Math.sqrt((k + 0.5) / m);
        const tx = axp + Math.cos(ang) * rad, ty = ayp + Math.sin(ang) * rad;
        f.sx += (tx - f.x) * SOCIETY_ANCHOR_K; f.sy += (ty - f.y) * SOCIETY_ANCHOR_K;
      }
    }
    // territories are exclusive jurisdictions: repel whole colonies so their bodies never merge
    const cents = [];
    for (const c of state.societies.colonies) {
      let x = 0, y = 0, n = 0, r = 0;
      for (const id of c.ids) { const f = sim.get(id); if (f && !f.dying) { x += f.x; y += f.y; n++; } }
      if (n) { x /= n; y /= n; for (const id of c.ids) { const f = sim.get(id); if (f && !f.dying) { const d = Math.hypot(f.x - x, f.y - y); if (d > r) r = d; } } }
      cents.push({ x, y, n, r: r + SOCIETY_PAD });
    }
    for (let i = 0; i < cents.length; i++) for (let j = i + 1; j < cents.length; j++) {
      const A = cents[i], B = cents[j]; if (A.n < 2 || B.n < 2) continue;
      const dx = B.x - A.x, dy = B.y - A.y, d = Math.hypot(dx, dy);
      const need = A.r + B.r + SOCIETY_TERR_GAP;
      if (d < 0.001 || d >= need) continue;
      const ux = dx / d, uy = dy / d, s = (need - d) * SOCIETY_TERR_K;
      for (const id of state.societies.colonies[i].ids) { const f = sim.get(id); if (f && !f.dying) { f.sx -= ux * s; f.sy -= uy * s; } }
      for (const id of state.societies.colonies[j].ids) { const f = sim.get(id); if (f && !f.dying) { f.sx += ux * s; f.sy += uy * s; } }
    }
    for (const p of state.societies.allies) {
      const a = sim.get(p.a), b = sim.get(p.b); if (!a || a.dying || !b || b.dying) continue;
      const dx = b.x - a.x, dy = b.y - a.y, d = Math.hypot(dx, dy) || 1;
      // a spring with a REST LENGTH: a bond holds friends NEAR, not on top of each other. Without the rest
      // length the 0.5-accel pull overpowered personal-space separation and knotted bonded flies into a blob.
      const s = p.w * SOCIETY_ALLY_K * clamp((d - SOCIETY_ALLY_REST) / SOCIETY_ALLY_REST, -0.7, 1);
      a.sx += (dx / d) * s; a.sy += (dy / d) * s; b.sx -= (dx / d) * s; b.sy -= (dy / d) * s;
    }
    for (const p of state.societies.feuds) {
      const a = sim.get(p.a), b = sim.get(p.b); if (!a || a.dying || !b || b.dying) continue;
      const dx = b.x - a.x, dy = b.y - a.y, d = Math.hypot(dx, dy) || 1;
      if (d > SOCIETY_FEUD_RANGE) continue;
      const s = p.w * SOCIETY_FEUD_K * (1 - d / SOCIETY_FEUD_RANGE);
      a.sx -= (dx / d) * s; a.sy -= (dy / d) * s; b.sx += (dx / d) * s; b.sy += (dy / d) * s;
    }
  }

  for (const f of list) {
    // fade-out retired flies, then drop them
    if (f.dying) {
      if (!f.dieT) f.dieT = now;
      if (now - f.dieT > 820) { sim.delete(f.id); continue; }
    }
    // ease drives toward the latest server reading
    f.aro = lerp(f.aro, f.tAro, 0.05 * dt);
    f.coh = lerp(f.coh, f.tCoh, 0.05 * dt);
    f.turn = lerp(f.turn, f.tTurn, 0.05 * dt);
    f.wing = lerp(f.wing, f.tWing, 0.05 * dt);
    f.rest = lerp(f.rest, f.tRest, 0.05 * dt);
    f.balN = lerp(f.balN ?? 0.5, f.tBalN ?? 0.5, 0.04 * dt);   // wealth → size eases smoothly, never jumps
    f.valence = lerp(f.valence, f.tValence ?? 0, 0.05 * dt);   // approach/avoid mood glides in
    // the ring-attractor compass (a persistent internal heading) eases toward the latest server value
    if (f.tHeading != null) {
      if (f.sHead == null) f.sHead = f.tHeading;
      else { const dh = ((f.tHeading - f.sHead + Math.PI * 3) % TAU) - Math.PI; f.sHead += dh * 0.06 * dt; }
    }

    const speed = (0.22 + f.aro * 2.3) * (1 - 0.55 * f.rest) * (FAP_SPEED[f.fap] ?? 1);

    // wander + turn bias → heading drift
    f.wander = (f.wander + (Math.random() - 0.5) * 0.5) * 0.92;
    f.heading += f.turn * 0.045 * dt + f.wander * 0.035 * dt + (Math.random() - 0.5) * 0.05 * (0.3 + f.aro) * dt;
    // a real fly holds a course: the persistent compass gently steers it between tumbles (weak, so the
    // flow field / collisions still win short-term, but each individual keeps a legible heading)
    if (f.sHead != null) { const dh = ((f.sHead - f.heading + Math.PI * 3) % TAU) - Math.PI; f.heading += dh * 0.012 * dt; }

    let ax = Math.cos(f.heading) * speed;
    let ay = Math.sin(f.heading) * speed;

    // ride the ambient flow field
    const fa = flowAngle(f.x, f.y, state.flowTime);
    ax += Math.cos(fa) * flowStr;
    ay += Math.sin(fa) * flowStr;

    // cohesion pulls toward the swarm centre; hot + low cohesion scatters outward
    const dx = cx - f.x, dy = cy - f.y, d = Math.hypot(dx, dy) || 1;
    ax += (dx / d) * f.coh * 0.75;
    ay += (dy / d) * f.coh * 0.75;
    ax -= (dx / d) * (1 - f.coh) * T * 0.7;
    ay -= (dy / d) * (1 - f.coh) * T * 0.7;

    // separation from neighbours (personal space); flies of DIFFERENT colonies keep extra distance so
    // the societies stay visually distinct (only when the social layer is on). Task 8: the scan now runs
    // against the spatial hash (cells of side SEP, 3x3 window) — the radius filter and the push below are
    // unchanged, the hash only narrows the candidate set, so the force field itself stays byte-identical.
    const nbrs = neighborHash.query(f.x, f.y, SEP, _nbrBuf);
    for (let ni = 0; ni < nbrs.length; ni++) {
      const g = sim.get(nbrs[ni]);
      if (!g || g === f || g.dying) continue;
      const sx = f.x - g.x, sy = f.y - g.y, sd = Math.hypot(sx, sy);
      if (sd > 0 && sd < SEP) {
        let push = (SEP - sd) * 0.028;
        if (socOn && state.societies.colonyOf) { const ca = state.societies.colonyOf.get(f.id), cb = state.societies.colonyOf.get(g.id); if (ca != null && cb != null && ca !== cb) push *= 1.9; }
        ax += (sx / sd) * push; ay += (sy / sd) * push;
      }
    }

    // the social force field (societies MVP): colony anchor + ally pull + feud push, pre-computed above
    if (socOn) { ax += (f.sx || 0); ay += (f.sy || 0); }

    // the pointer stirs the swarm: hover draws flies in, press blows them apart
    if (pointer.inside) {
      const pdx = pointer.x - f.x, pdy = pointer.y - f.y, pd = Math.hypot(pdx, pdy) || 1;
      if (pointer.down) {
        const R = 200;
        if (pd < R) { const s = 2.8 * (1 - pd / R); ax -= (pdx / pd) * s; ay -= (pdy / pd) * s; }
      } else {
        const R = 135;
        if (pd < R) { const s = 0.55 * (1 - pd / R); ax += (pdx / pd) * s; ay += (pdy / pd) * s; }
      }
    }

    // blend velocity, integrate, keep on-canvas with a soft margin
    f.vx = lerp(f.vx, ax, 0.12 * dt);
    f.vy = lerp(f.vy, ay, 0.12 * dt);
    f.px = f.x; f.py = f.y;
    f.x += f.vx * dt; f.y += f.vy * dt;
    // confine the swarm to a centred activity region: inset so flies stay clear of the corner
    // panels and the field isn't mostly empty space, with a firmer push so they hold the region
    const mx = Math.max(96, Math.round(state.VW * 0.21));
    const my = Math.max(88, Math.round(state.VH * 0.19));
    if (f.x < mx) f.vx += (mx - f.x) * 0.017 * dt;
    if (f.x > state.VW - mx) f.vx -= (f.x - (state.VW - mx)) * 0.017 * dt;
    if (f.y < my) f.vy += (my - f.y) * 0.017 * dt;
    if (f.y > state.VH - my) f.vy -= (f.y - (state.VH - my)) * 0.017 * dt;
    f.x = clamp(f.x, 6, state.VW - 6); f.y = clamp(f.y, 6, state.VH - 6);
    if (Math.hypot(f.vx, f.vy) > 0.05) f.heading = Math.atan2(f.vy, f.vx);
    // wingbeat: the FAP sets the tempo (a bolting fly blurs, a resting one barely trembles)
    const flapRate = f.fap === "FLIGHT" ? 2.5 : f.fap === "RETREAT" ? 2.0 : f.fap === "COURT" ? 1.5
      : (f.fap === "REST" || f.fap === "HALT") ? 0.22 : 1;
    f.phase += (0.06 + f.wing * 0.55) * flapRate * dt;
    // the walking cycle advances with the gait speed (parked FAPs keep the legs nearly still)
    f.legPhase = (f.legPhase ?? 0) + (0.04 + speed * 0.55) * dt;
  }
}
