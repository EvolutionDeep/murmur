// nations.js — 五国 Voronoi 动态分区（任务6）：种子计算 / 顶点归属 / 国家 tint / 贴地边境 mesh。
// 数据权威与 2D dominion 地图一致：state.econDynasty.zoneOwners（已含征服后的胜者）。
// 对外接口：
//   updateNations(dynastyData, WSX, WSZ) → { nationSeeds, voronoi, nationColors, nationNames, sig }
//     · 从 houses 按实力/人口取前五王朝，以其 zoneOwners 全部 zone 的锚点质心为 seed，
//       投影到 3D 世界坐标后 Delaunay.voronoi 按世界矩形裁出五个 cell；
//       签名（前五王朝 id 排名序 + 领地列表）未变时直接返回缓存。
//   assignNationIds(positions, count, voronoi) → Uint8Array —— 地形顶点 → 国家 id
//   meanderEdges(edges, heightAtFn) → run[] —— 蜿蜒边境折线（含入海河口喇叭口），缓存共享
//   buildBorderMesh(voronoi, heightAtFn, WSX, WSZ) → THREE.Group —— 沿蜿蜒线的运河水面带 + 岸线轨道
//   getNationColor(id) → THREE.Color | null
//   getNationTint(baseColor, id, strength=0.28) → [r,g,b]（地貌基色混合国家色）
//   getNationId(vertexIndex) / resetNations() —— 热路径查询与复位
import * as THREE from 'three';
import { state, houseColor } from './shared.js';
import { zoneAnchor } from './render2d.js';

// C1: d3-delaunay is resolved lazily (dynamic import) so an unreachable CDN degrades to
// "no Voronoi borders" instead of failing the whole module graph — a static import here would
// reject every importer (scene3d.js → main.js) and white-screen the page. boot() awaits
// loadDelaunay() before constructing ThreeScene; until then Delaunay stays null.
let Delaunay = null;
let _d3Loaded = false;
export async function loadDelaunay() {
  if (_d3Loaded) return Delaunay;
  _d3Loaded = true;
  try { Delaunay = (await import('d3-delaunay')).Delaunay; }
  catch (e) { console.warn('[nations] d3-delaunay unavailable, borders disabled:', e); Delaunay = null; }
  return Delaunay;
}

export const NATION_COUNT = 5;

const FALLBACK_RGB = [176, 142, 86];   // 与 3D 城堡/2D 地图一致的兜底王朝色
const SEA_SKIP = 0.8;                  // 低于该高度的边境采样段不绘制（海里不画线）
const TINT_DEFAULT = 0.28;             // 默认国家 tint 强度

let nationId = null;      // Uint8Array(n) —— 顶点 → 国家 id（assignNationIds 填充）
let nationSeeds = [];     // [{ x, z, px, py, houseId, name, zones }] —— seed 的 3D 世界坐标
let nationColors = [];    // THREE.Color[] —— 每国色（源自 houseColor）
let nationNames = [];     // string[] —— 王朝名
let _colorF = [];         // [r,g,b] 0..1 —— tint 混合用
let voronoi = null;       // d3-delaunay Voronoi（bounds = 世界矩形）
let cacheSig = "";        // 分区缓存签名：前五王朝（排名序）id + 各自 zone 列表

/**
 * 重建五国分区（任务6）。
 * 前五 = 有领地王朝中 live（人口）最多者；每个王朝的 seed = 其全部领区锚点（zoneAnchor）
 * 的质心，映射 x=(anchor.x/VW−0.5)·WSX、z=(anchor.y/VH−0.5)·WSZ。签名未变不重算。
 */
export function updateNations(dynastyData, WSX, WSZ) {
  const wsx = WSX > 0 ? WSX : 480, wsz = WSZ > 0 ? WSZ : 300;
  const houses = dynastyData && Array.isArray(dynastyData.houses) ? dynastyData.houses : null;
  const owners = dynastyData && Array.isArray(dynastyData.zoneOwners) ? dynastyData.zoneOwners : null;

  // 归属权威：zoneOwners → houseId → zone 列表
  const byHouse = new Map();
  if (owners) {
    for (const o of owners) {
      if (!o || o.zone == null || o.houseId == null) continue;
      let zs = byHouse.get(o.houseId);
      if (!zs) { zs = []; byHouse.set(o.houseId, zs); }
      zs.push(o.zone | 0);
    }
  }

  // 候选：拥有领地的王朝（无领地无法定都）→ 按实力/人口排序取前五
  const cands = [];
  if (houses) {
    for (const h of houses) {
      if (!h || h.id == null) continue;
      const zs = byHouse.get(h.id);
      if (!zs || !zs.length) continue;
      cands.push({ h, zones: zs.slice().sort((a, b) => a - b) });
    }
  }
  cands.sort((a, b) =>
    ((b.h.live | 0) - (a.h.live | 0)) ||
    ((b.h.capitalShare || 0) - (a.h.capitalShare || 0)) ||
    ((a.h.id > b.h.id) ? 1 : -1));
  const top = cands.slice(0, NATION_COUNT);

  // 缓存签名：前五王朝（排名序）id + 各自领地 —— 仅排名/领地变化时重算
  let sig = wsx + "x" + wsz;
  for (const c of top) sig += "|" + c.h.id + ":" + c.zones.join(".");
  if (sig === cacheSig) return { nationSeeds, voronoi, nationColors, nationNames, sig };
  cacheSig = sig;

  // seed = 王朝全部领区锚点的质心（像素 → 3D 世界坐标）
  const VW = state.VW || 1280, VH = state.VH || 720;
  nationSeeds = []; nationColors = []; nationNames = []; _colorF = [];
  const pts = [];
  for (const c of top) {
    let px = 0, py = 0, wx = 0, wz = 0;
    for (const z of c.zones) {
      const za = zoneAnchor(z);
      px += za.x; py += za.y;
      wx += (za.x / VW - 0.5) * wsx;
      wz += (za.y / VH - 0.5) * wsz;
    }
    const n = c.zones.length || 1;
    const name = c.h.name || ("house-" + c.h.id);
    const hc = houseColor(name) || FALLBACK_RGB;
    nationSeeds.push({ x: wx / n, z: wz / n, px: px / n, py: py / n, houseId: c.h.id, name, zones: c.zones });
    nationColors.push(new THREE.Color(hc[0] / 255, hc[1] / 255, hc[2] / 255));
    _colorF.push([hc[0] / 255, hc[1] / 255, hc[2] / 255]);
    nationNames.push(name);
    pts.push([wx / n, wz / n]);
  }

  voronoi = (Delaunay && pts.length >= 2)
    ? Delaunay.from(pts).voronoi([-wsx / 2, -wsz / 2, wsx / 2, wsz / 2])
    : null;   // 0/1 个国家，或 d3-delaunay 不可用：无边界线（其余功能照常）
  return { nationSeeds, voronoi, nationColors, nationNames, sig };
}

/**
 * 地形顶点 → 国家 id（Uint8Array）。
 * 地形 PlaneGeometry 绕 X 轴旋转 -90°：局部 (x, y) 对应世界 (x, −y)，
 * 即世界 z = −pos.getY(k)；查询最近站点得到所属国家。
 * 最近站点查询按可靠性降级：Voronoi#find（npm 原版）→ Delaunay#find（jsdelivr +esm
 * 打包版把 Voronoi#find 摇掉了，实测原型上只剩 cellPolygon/contains/…，Delaunay#find 语义相同）
 * → 逐点暴力扫描（两者都缺失时的兜底，5 个站点开销可忽略）。
 */
export function assignNationIds(positions, count, v) {
  const n = count != null ? count : (positions ? positions.count : 0);
  nationId = new Uint8Array(n);
  const vor = v !== undefined ? v : voronoi;
  if (!vor || !positions) return nationId;
  const dln = vor.delaunay;
  const pts = dln && dln.points ? dln.points : null;
  const nPts = pts ? (pts.length / 2) | 0 : 0;
  let findFn = null;
  if (typeof vor.find === "function") findFn = (x, z) => vor.find(x, z);
  else if (dln && typeof dln.find === "function") findFn = (x, z) => dln.find(x, z);
  else if (nPts > 0) findFn = (x, z) => {
    let best = 0, bd = Infinity;
    for (let i = 0; i < nPts; i++) {
      const dx = pts[i * 2] - x, dz = pts[i * 2 + 1] - z;
      const d2 = dx * dx + dz * dz;
      if (d2 < bd) { bd = d2; best = i; }
    }
    return best;
  };
  if (!findFn) return nationId;
  const cnt = Math.min(n, positions.count);
  for (let k = 0; k < cnt; k++) {
    const s = findFn(positions.getX(k), -positions.getY(k));
    nationId[k] = s > 0 ? s : 0;
  }
  return nationId;
}

/**
 * Voronoi cell 边界去重后的边列表（相邻 cell 共享同一条边，只返回一次）。
 * 供 buildBorderMesh（水道视觉）与 scene3d._sculptTerrain（运河浅槽）共用同一数据链。
 */
export function voronoiEdges(v) {
  const edges = [];
  if (!v) return edges;
  const seen = new Set();
  const nCells = v.delaunay && v.delaunay.points ? ((v.delaunay.points.length / 2) | 0) : (nationSeeds.length | 0);
  for (let i = 0; i < nCells; i++) {
    const poly = v.cellPolygon(i);
    if (!poly || poly.length < 2) continue;
    for (let j = 0; j < poly.length - 1; j++) {
      const a = poly[j], b = poly[j + 1];
      const k1 = a[0].toFixed(3) + "," + a[1].toFixed(3);
      const k2 = b[0].toFixed(3) + "," + b[1].toFixed(3);
      const key = k1 < k2 ? k1 + "|" + k2 : k2 + "|" + k1;
      if (seen.has(key)) continue;
      seen.add(key);
      edges.push([a, b]);
    }
  }
  return edges;
}

// ---- task 25②: border meander post-process ----
// Every straight Voronoi edge becomes an organic waterway: resampled at ≈8-unit steps, displaced
// along the edge normal by a per-edge sine (+ a shorter harmonic) with a sin(πt) envelope so shared
// junction vertices stay welded, then Catmull-Rom resampled at ≈4 units. Edge endpoints that already
// sit near the coast (heightAt < 1.2) grow an ESTUARY tail: the line continues outward along the
// original direction until it dives under the sea (heightAt < -1.2); over the tail's last 25% the
// channel width flares 4.8 → 9 (a trumpet mouth). Point record = [x, z, mouth, width]:
//   mouth = 0 inland … 1 at the seaward tip of an estuary tail (floor may drop below sea level).
// Runs are cached by edge signature: _sculptTerrain (pristine base sampler) builds them first and
// buildBorderMesh reuses the IDENTICAL lines, so groove and water ribbon can never drift apart.
let _meanderSig = "";
let _meanderRuns = [];

const MEANDER_W_BASE = 4.8;   // inland canal width (matches the sculpt groove)
const MEANDER_W_MOUTH = 9.0;  // trumpet width at the seaward tip

function meanderHash(str) {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619) >>> 0; }
  return h / 4294967295;
}

// uniform Catmull-Rom resample of a 2D polyline; the mouth/width attributes ride along linearly
function catmullResample(pts, step) {
  const n = pts.length;
  if (n < 3) return pts.map((p) => p.slice());
  const P = (i) => pts[i < 0 ? 0 : i > n - 1 ? n - 1 : i];
  const out = [];
  for (let i = 0; i < n - 1; i++) {
    const p0 = P(i - 1), p1 = P(i), p2 = P(i + 1), p3 = P(i + 2);
    const segLen = Math.hypot(p2[0] - p1[0], p2[1] - p1[1]);
    const sub = Math.max(1, Math.round(segLen / step));
    for (let s = 0; s < sub; s++) {
      const t = s / sub, t2 = t * t, t3 = t2 * t;
      out.push([
        0.5 * (2 * p1[0] + (-p0[0] + p2[0]) * t + (2 * p0[0] - 5 * p1[0] + 4 * p2[0] - p3[0]) * t2 + (-p0[0] + 3 * p1[0] - 3 * p2[0] + p3[0]) * t3),
        0.5 * (2 * p1[1] + (-p0[1] + p2[1]) * t + (2 * p0[1] - 5 * p1[1] + 4 * p2[1] - p3[1]) * t2 + (-p0[1] + 3 * p1[1] - 3 * p2[1] + p3[1]) * t3),
        p1[2] + (p2[2] - p1[2]) * t,
        p1[3] + (p2[3] - p1[3]) * t,
      ]);
    }
  }
  out.push(pts[n - 1].slice());
  return out;
}

/**
 * 边境边 → 蜿蜒折线（task 25②）。签名未变直接返回缓存（_sculptTerrain 与 buildBorderMesh 共用）。
 */
export function meanderEdges(edges, heightAtFn) {
  const list = Array.isArray(edges) ? edges : [];
  let sig = list.length + ":";
  for (const e of list) sig += e[0][0].toFixed(1) + "," + e[0][1].toFixed(1) + ">" + e[1][0].toFixed(1) + "," + e[1][1].toFixed(1) + ";";
  if (sig === _meanderSig) return _meanderRuns;
  const hAt = typeof heightAtFn === "function" ? heightAtFn : () => 0;
  const runs = [];
  for (const [A, B] of list) {
    const dx = B[0] - A[0], dz = B[1] - A[1];
    const len = Math.hypot(dx, dz);
    if (len < 0.05) continue;
    const ux = dx / len, uz = dz / len;
    const nx = -uz, nz = ux;
    const key = A[0].toFixed(2) + "," + A[1].toFixed(2) + "|" + B[0].toFixed(2) + "," + B[1].toFixed(2);
    const h1 = meanderHash(key), h2 = meanderHash(key + "#w"), h3 = meanderHash(key + "#p");
    const amp = 5 + 4 * h1;             // 振幅 5–9
    const wl = 45 + 25 * h2;            // 波长 45–70
    const ph = h3 * Math.PI * 2;        // 每边 hash 相位
    // estuary tail: walk outward from a coastal endpoint until the seabed dips under -1.2
    const tail = (px, pz, ox, oz) => {
      if (hAt(px, pz) >= 1.2) return [];
      const pts = [];
      let x = px, z = pz;
      for (let s = 0; s < 30; s++) {
        x += ox * 3; z += oz * 3;
        pts.push([x, z]);
        if (hAt(x, z) < -1.2) break;
      }
      return pts;
    };
    const head = tail(A[0], A[1], -ux, -uz);   // seaward → junction order comes from the reverse below
    const foot = tail(B[0], B[1], ux, uz);
    const raw = [];
    for (let i = head.length - 1; i >= 0; i--) {
      const sE = (i + 1) / head.length;        // 1 at the seaward tip → 0 at the junction
      const fl = sE > 0.75 ? (sE - 0.75) / 0.25 : 0;
      raw.push([head[i][0], head[i][1], sE, MEANDER_W_BASE + (MEANDER_W_MOUTH - MEANDER_W_BASE) * fl]);
    }
    const n = Math.max(2, Math.round(len / 8));
    for (let i = 0; i <= n; i++) {
      const t = i / n, s = t * len;
      const env = Math.sin(Math.PI * t);       // weld the shared junction vertices
      const off = env * (amp * Math.sin((2 * Math.PI * s) / wl + ph) + amp * 0.38 * Math.sin((2 * Math.PI * s) / (wl * 0.41) + ph * 1.7));
      raw.push([A[0] + ux * s + nx * off, A[1] + uz * s + nz * off, 0, MEANDER_W_BASE]);
    }
    for (let i = 0; i < foot.length; i++) {
      const sE = (i + 1) / foot.length;
      const fl = sE > 0.75 ? (sE - 0.75) / 0.25 : 0;
      raw.push([foot[i][0], foot[i][1], sE, MEANDER_W_BASE + (MEANDER_W_MOUTH - MEANDER_W_BASE) * fl]);
    }
    const line = catmullResample(raw, 4);
    if (line.length >= 2) runs.push(line);
  }
  _meanderSig = sig;
  _meanderRuns = runs;
  return runs;
}
/** 内部复位用：分区清空时蜿蜒缓存一并作废。 */
export function resetMeander() { _meanderSig = ""; _meanderRuns = []; }

/**
 * 沿蜿蜒边境线生成贴地「运河」水道（task 24 桌面沙盘，task 25② 蜿蜒化）：水面带与岸线轨道都沿
 * meanderEdges 的同一份折线构建，宽度随河口喇叭口 4.8→9 展开；河口段水面不低于海平面读出的
 * 0.08 抬离量，与海自然连通。海面（< SEA_SKIP 且非河口）区段自动断开。返回 THREE.Group。
 */
export function buildBorderMesh(v, heightAtFn, WSX, WSZ) {
  const group = new THREE.Group();
  group.name = "nationBorders";
  if (!v) return group;
  const hAt = typeof heightAtFn === "function" ? heightAtFn : () => 0;
  const BANK = 1.6;     // 每侧浅色岸线轨道宽
  const WLIFT = 0.5;    // 水面高于沟底的高度（嵌入浅槽、低于两岸）
  const BLIFT = 0.45;   // 岸线轨道贴地抬离量（防 z-fight）

  const wv = [], wi = [];   // 水面带（蓝色）
  const bv = [], bi = [];   // 岸线轨道（浅沙色）
  const runs = meanderEdges(voronoiEdges(v), hAt);
  for (const line of runs) {
    let run = [];
    const flush = () => {
      if (run.length >= 2) {
        const m = run.length;
        // 水面：整行铺平在「中线沟底 + WLIFT」；河口段不低于海面上 0.08（与海自然连通）
        const wb = wv.length / 3;
        for (let i = 0; i < m; i++) {
          const p = run[i];
          const q0 = run[i > 0 ? i - 1 : 0], q1 = run[i < m - 1 ? i + 1 : m - 1];
          let tx = q1[0] - q0[0], tz = q1[1] - q0[1];
          const tl = Math.hypot(tx, tz) || 1; tx /= tl; tz /= tl;
          const nx = -tz, nz = tx;
          const hw = p[3] / 2;
          const gy = hAt(p[0], p[1]) + WLIFT;
          const y = p[2] > 0 ? Math.max(gy, 0.08) : gy;
          wv.push(p[0] - nx * hw, y, p[1] - nz * hw, p[0] + nx * hw, y, p[1] + nz * hw);
        }
        for (let i = 0; i < m - 1; i++) {
          const a = wb + i * 2;
          wi.push(a, a + 2, a + 1, a + 1, a + 2, a + 3);
        }
        // 岸线：带宽 ±(hw..hw+BANK) 的两条浅沙轨道，贴地；沉入海面的区段断开
        let b0 = 0;
        const emitBank = (s, e) => {
          if (e - s < 2) return;
          const bb = bv.length / 3;
          for (let i = s; i < e; i++) {
            const p = run[i];
            const q0 = run[i > 0 ? i - 1 : 0], q1 = run[i < m - 1 ? i + 1 : m - 1];
            let tx = q1[0] - q0[0], tz = q1[1] - q0[1];
            const tl = Math.hypot(tx, tz) || 1; tx /= tl; tz /= tl;
            const nx = -tz, nz = tx;
            const hw = p[3] / 2;
            const l0x = p[0] - nx * (hw + BANK), l0z = p[1] - nz * (hw + BANK);
            const l1x = p[0] - nx * hw, l1z = p[1] - nz * hw;
            const r1x = p[0] + nx * hw, r1z = p[1] + nz * hw;
            const r0x = p[0] + nx * (hw + BANK), r0z = p[1] + nz * (hw + BANK);
            bv.push(
              l0x, hAt(l0x, l0z) + BLIFT, l0z, l1x, hAt(l1x, l1z) + BLIFT, l1z,
              r1x, hAt(r1x, r1z) + BLIFT, r1z, r0x, hAt(r0x, r0z) + BLIFT, r0z);
          }
          for (let i = s; i < e - 1; i++) {
            const a = bb + (i - s) * 4;
            bi.push(a, a + 4, a + 1, a + 1, a + 4, a + 5);       // 左岸
            bi.push(a + 2, a + 6, a + 3, a + 3, a + 6, a + 7);   // 右岸
          }
        };
        for (let i = 0; i <= m; i++) {
          if (i < m && hAt(run[i][0], run[i][1]) >= 0.05) continue;
          emitBank(b0, i);
          b0 = i + 1;
        }
      }
      run = [];
    };
    for (const p of line) {
      if (p[2] <= 0 && hAt(p[0], p[1]) < SEA_SKIP) { flush(); continue; }   // 海岸外的陆地段不画
      run.push(p);
    }
    flush();
  }

  if (wi.length) {
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.Float32BufferAttribute(wv, 3));
    g.setIndex(wi);
    const m = new THREE.Mesh(g, new THREE.MeshBasicMaterial({
      color: 0x3f86c9, transparent: true, opacity: 0.95, depthWrite: false,
      side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: -4, polygonOffsetUnits: -4,
    }));
    m.renderOrder = 2;   // task 25③: terrain(opaque) → sea(1) → canal water(2) → bank rails(3)
    group.add(m);
  }
  if (bi.length) {
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.Float32BufferAttribute(bv, 3));
    g.setIndex(bi);
    const m = new THREE.Mesh(g, new THREE.MeshBasicMaterial({
      color: 0xe6d7a4, transparent: true, opacity: 0.9, depthWrite: false,
      side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: -5, polygonOffsetUnits: -5,
    }));
    m.renderOrder = 3;
    group.add(m);
  }
  return group;
}

/** 国家色（THREE.Color）；无分区数据或越界 → null。 */
export function getNationColor(idx) {
  return nationColors[idx | 0] || null;
}

const _tintScratch = [1, 1, 1];

/**
 * 地貌基色 × 国家色的混合 tint（任务6）：strength 越大国家色越明显。
 * 支持 [r,g,b]（0..1）数组或 THREE.Color 输入；无分区数据时原样返回基色。
 * 返回值为复用数组 —— 调用方应立即消费，勿长期持有。
 */
export function getNationTint(baseColor, idx, strength = TINT_DEFAULT) {
  let r, g, b;
  if (Array.isArray(baseColor)) { r = baseColor[0]; g = baseColor[1]; b = baseColor[2]; }
  else if (baseColor && baseColor.isColor) { r = baseColor.r; g = baseColor.g; b = baseColor.b; }
  else return baseColor;
  const nc = _colorF[idx | 0];
  if (nc) {
    const w = strength < 0 ? 0 : strength > 1 ? 1 : strength;
    r = r * (1 - w) + nc[0] * w;
    g = g * (1 - w) + nc[1] * w;
    b = b * (1 - w) + nc[2] * w;
  }
  _tintScratch[0] = r; _tintScratch[1] = g; _tintScratch[2] = b;
  return _tintScratch;
}

/** 顶点 → 国家 id（热路径：_colorTerrain 逐顶点调用）。无数据时恒 0（且 tint 表为空 → 不染色）。 */
export function getNationId(vertexIndex) {
  return nationId ? (nationId[vertexIndex] | 0) : 0;
}

/** 复位（地形重建 / 数据清空时调用）。 */
export function resetNations() {
  nationId = null; nationSeeds = []; nationColors = []; nationNames = [];
  _colorF = []; voronoi = null; cacheSig = "";
  resetMeander();
}
