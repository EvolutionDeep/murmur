// nations.js — 五国 Voronoi 动态分区（任务6）：种子计算 / 顶点归属 / 国家 tint / 贴地边境 mesh。
// 数据权威与 2D dominion 地图一致：state.econDynasty.zoneOwners（已含征服后的胜者）。
// 对外接口：
//   updateNations(dynastyData, WSX, WSZ) → { nationSeeds, voronoi, nationColors, nationNames, sig }
//     · 从 houses 按实力/人口取前五王朝，以其 zoneOwners 全部 zone 的锚点质心为 seed，
//       投影到 3D 世界坐标后 Delaunay.voronoi 按世界矩形裁出五个 cell；
//       签名（前五王朝 id 排名序 + 领地列表）未变时直接返回缓存。
//   assignNationIds(positions, count, voronoi) → Uint8Array —— 地形顶点 → 国家 id
//   buildBorderMesh(voronoi, heightAtFn, WSX, WSZ) → THREE.Group —— 深色描边 + 半透明内带的贴地边境
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
 * 沿 Voronoi cell 边界生成贴地边境 ribbon（任务6）：总宽 1.5 的半透明内带
 * + 两侧 0.14 宽的深色描边轨道。每个采样点按 heightAtFn 投影到地形高度，
 * 海面（< SEA_SKIP）区段自动断开。返回 THREE.Group。
 */
export function buildBorderMesh(v, heightAtFn, WSX, WSZ) {
  const group = new THREE.Group();
  group.name = "nationBorders";
  if (!v) return group;
  const hAt = typeof heightAtFn === "function" ? heightAtFn : () => 0;
  const HALF = 0.75;    // 内带半宽（总宽 1.5）
  const RAIL = 0.14;    // 描边宽
  const LIFT = 0.5;     // 抬离地形高度，避免 z-fight

  // Voronoi 边去重：相邻 cell 共享同一条边，只画一次
  const seen = new Set();
  const edges = [];
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

  const fv = [], fi = [];   // 内带（半透明填充）
  const rv = [], ri = [];   // 描边轨道（深色细线）
  for (const [A, B] of edges) {
    const dx = B[0] - A[0], dz = B[1] - A[1];
    const len = Math.hypot(dx, dz);
    if (len < 0.05) continue;
    const nx = -dz / len, nz = dx / len;    // 水平法线
    const seg = Math.max(2, Math.ceil(len / 2.6));
    let run = [];
    const flush = () => {
      if (run.length >= 2) {
        // 内带：每行左右两点，各自贴地
        const fb = fv.length / 3;
        for (const p of run) {
          const lx = p[0] - nx * HALF, lz = p[1] - nz * HALF;
          const rx = p[0] + nx * HALF, rz = p[1] + nz * HALF;
          fv.push(lx, hAt(lx, lz) + LIFT, lz, rx, hAt(rx, rz) + LIFT, rz);
        }
        for (let i = 0; i < run.length - 1; i++) {
          const a = fb + i * 2;
          fi.push(a, a + 2, a + 1, a + 1, a + 2, a + 3);
        }
        // 描边：带宽 ±(HALF..HALF+RAIL) 的两条轨道
        const rb = rv.length / 3;
        for (const p of run) {
          const l0x = p[0] - nx * (HALF + RAIL), l0z = p[1] - nz * (HALF + RAIL);
          const l1x = p[0] - nx * HALF, l1z = p[1] - nz * HALF;
          const r1x = p[0] + nx * HALF, r1z = p[1] + nz * HALF;
          const r0x = p[0] + nx * (HALF + RAIL), r0z = p[1] + nz * (HALF + RAIL);
          rv.push(
            l0x, hAt(l0x, l0z) + LIFT, l0z, l1x, hAt(l1x, l1z) + LIFT, l1z,
            r1x, hAt(r1x, r1z) + LIFT, r1z, r0x, hAt(r0x, r0z) + LIFT, r0z);
        }
        for (let i = 0; i < run.length - 1; i++) {
          const a = rb + i * 4;
          ri.push(a, a + 4, a + 1, a + 1, a + 4, a + 5);       // 左轨
          ri.push(a + 2, a + 6, a + 3, a + 3, a + 6, a + 7);   // 右轨
        }
      }
      run = [];
    };
    for (let i = 0; i <= seg; i++) {
      const t = i / seg;
      const x = A[0] + dx * t, z = A[1] + dz * t;
      if (hAt(x, z) < SEA_SKIP) { flush(); continue; }   // 海岸外的段不画
      run.push([x, z]);
    }
    flush();
  }

  if (fi.length) {
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.Float32BufferAttribute(fv, 3));
    g.setIndex(fi);
    group.add(new THREE.Mesh(g, new THREE.MeshBasicMaterial({
      color: 0x2b1d10, transparent: true, opacity: 0.34, depthWrite: false,
      side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2,
    })));
  }
  if (ri.length) {
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.Float32BufferAttribute(rv, 3));
    g.setIndex(ri);
    group.add(new THREE.Mesh(g, new THREE.MeshBasicMaterial({
      color: 0x140d05, transparent: true, opacity: 0.9, depthWrite: false,
      side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: -3, polygonOffsetUnits: -3,
    })));
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
}
