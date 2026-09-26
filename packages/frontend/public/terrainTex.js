// terrainTex.js — high-quality procedural TILEABLE terrain textures for the PBR splat material.
// Portions adapted from wowserhq/scene (MIT), © Wowser Contributors.
//
// Boot-time generator: 4 × 512² albedo CanvasTextures (grass / rock / sand / snow) plus one
// 512² detail NORMAL map (Sobel of a periodic height field). Every noise field is periodic
// (integer cell counts, coordinates wrapped) so all six faces tile seamlessly — the terrain
// shader samples them in world space and no seam or stretch is ever visible.
//
// These feed MeshStandardMaterial.onBeforeCompile (see scene3d._buildTerrain): the full PBR
// pipeline (env-map sheen, real sun/hemi lights, fog, ACES tone-map, roughness response) is
// kept intact and only the albedo + a micro-normal perturbation are injected. No external assets.

import * as THREE from 'three';

const SZ = 512;

// ── tiny maths helpers ────────────────────────────────────────────────────────
const clamp01 = (t) => (t < 0 ? 0 : t > 1 ? 1 : t);
const sstep = (a, b, t) => { const x = clamp01((t - a) / ((b - a) || 1e-6)); return x * x * (3 - 2 * x); };
const c255 = (t) => (t < 0 ? 0 : t > 255 ? 255 : t | 0);

// ── seeded PRNG (deterministic across boots) ─────────────────────────────────
function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ── periodic value noise: one seamless grid of `cells × cells` over [0,1)² ─────
function makeVNoise(cells, seed) {
  const rng = mulberry32(seed);
  const g = new Float32Array(cells * cells);
  for (let i = 0; i < g.length; i++) g[i] = rng();
  return function (u, v) {
    let x = u * cells, y = v * cells;
    x = ((x % cells) + cells) % cells;
    y = ((y % cells) + cells) % cells;
    const ix = x | 0, iy = y | 0;
    const tx = x - ix, ty = y - iy;
    const sx = tx * tx * (3 - 2 * tx), sy = ty * ty * (3 - 2 * ty);
    const x1 = (ix + 1) % cells, y1 = (iy + 1) % cells;
    const r0 = iy * cells, r1 = y1 * cells;
    const v00 = g[r0 + ix], v10 = g[r0 + x1], v01 = g[r1 + ix], v11 = g[r1 + x1];
    const a = v00 + (v10 - v00) * sx;
    const b = v01 + (v11 - v01) * sx;
    return a + (b - a) * sy;
  };
}

// ── tileable fbm: octaves at cells, 2·cells, 4·cells … (all integer → seamless) ─
function makeFbm(baseCells, octaves, seed) {
  const ns = [];
  let c = baseCells, s = seed >>> 0;
  for (let o = 0; o < octaves; o++) {
    ns.push(makeVNoise(c, s));
    c *= 2; s = (Math.imul(s, 16807) + 12345) >>> 0;
  }
  const n = ns.length;
  return function (u, v) {
    let sum = 0, amp = 1, norm = 0;
    for (let o = 0; o < n; o++) { sum += ns[o](u, v) * amp; norm += amp; amp *= 0.5; }
    return sum / norm;
  };
}

// ── periodic worley (cellular) noise → F2−F1 (≈0 at cell edges → rock facets) ──
function makeWorley(cells, seed) {
  const rng = mulberry32(seed);
  const n = cells * cells;
  const px = new Float32Array(n), py = new Float32Array(n);
  for (let i = 0; i < n; i++) { px[i] = rng(); py[i] = rng(); }
  return function (u, v) {
    const cu = Math.floor(u * cells), cv = Math.floor(v * cells);
    let f1 = 9, f2 = 9;
    for (let dj = -1; dj <= 1; dj++) {
      const gj = cv + dj, cj = ((gj % cells) + cells) % cells;
      for (let di = -1; di <= 1; di++) {
        const gi = cu + di, ci = ((gi % cells) + cells) % cells;
        const k = cj * cells + ci;
        const dx = (gi + px[k]) / cells - u;
        const dy = (gj + py[k]) / cells - v;
        const d = Math.sqrt(dx * dx + dy * dy);
        if (d < f1) { f2 = f1; f1 = d; } else if (d < f2) { f2 = d; }
      }
    }
    return f2 - f1;
  };
}

// Bake a noise function into a full SZ² field once (keeps the per-pixel combine loops cheap).
function bake(fn) {
  const f = new Float32Array(SZ * SZ);
  for (let y = 0; y < SZ; y++) {
    const v = y / SZ, row = y * SZ;
    for (let x = 0; x < SZ; x++) f[row + x] = fn(x / SZ, v);
  }
  return f;
}

// Stamp sparse discrete dots (flowers / shell chips / snow sparkle) into an RGBA buffer.
function stampDots(d, rng, count, r, g, b, add, rad) {
  for (let s = 0; s < count; s++) {
    const cx = (rng() * SZ) | 0, cy = (rng() * SZ) | 0;
    const rad2 = rad * rad;
    for (let oy = -rad; oy <= rad; oy++) {
      for (let ox = -rad; ox <= rad; ox++) {
        if (ox * ox + oy * oy > rad2) continue;
        const x = ((cx + ox) % SZ + SZ) % SZ, y = ((cy + oy) % SZ + SZ) % SZ;
        const i = (y * SZ + x) * 4;
        const fall = 1 - Math.sqrt(ox * ox + oy * oy) / (rad + 0.6);
        const k = add * fall;
        d[i]     = c255(d[i]     + (r - d[i] / 255) * k * 255);
        d[i + 1] = c255(d[i + 1] + (g - d[i + 1] / 255) * k * 255);
        d[i + 2] = c255(d[i + 2] + (b - d[i + 2] / 255) * k * 255);
      }
    }
  }
}

// ── grass: layered green fbm + directional blade streaks + shrub-shadow patches + flowers ──
function paintGrass(ctx) {
  const A = bake(makeFbm(4, 3, 1337));    // broad tone variation
  const B = bake(makeFbm(9, 2, 7331));    // mid variation
  const C = bake(makeFbm(3, 2, 24601));   // shrub-shadow patches (low freq)
  const D = bake(makeFbm(37, 2, 555));    // fine speckle
  const img = ctx.createImageData(SZ, SZ);
  const d = img.data;
  const TAU = Math.PI * 2;
  for (let y = 0; y < SZ; y++) {
    const v = y / SZ, row = y * SZ;
    for (let x = 0; x < SZ; x++) {
      const u = x / SZ, k = row + x;
      const a = A[k], b = B[k];
      // two crossing blade directions (integer freq → seamless in both axes)
      const blade = Math.sin((v * 96 + a * 6.0) * TAU) * 0.5 + 0.5;
      const blade2 = Math.sin((u * 71 + b * 5.0) * TAU) * 0.5 + 0.5;
      const patch = sstep(0.50, 0.70, C[k]);         // shrub canopy shadow
      const speck = (D[k] - 0.5) * 0.05;
      let r = 0.150 + a * 0.085 + blade * 0.020 + speck;
      let g = 0.330 + a * 0.170 + b * 0.055 + blade * 0.055 + blade2 * 0.020 + speck;
      let bl = 0.105 + b * 0.045 + speck * 0.6;
      const sh = 1 - patch * 0.42;                    // darken under shrubs
      r *= sh; g *= sh; bl *= sh;
      const i = k * 4;
      d[i] = c255(r * 255); d[i + 1] = c255(g * 255); d[i + 2] = c255(bl * 255); d[i + 3] = 255;
    }
  }
  // tiny wildflowers — pale yellow + a few white
  const rng = mulberry32(90210);
  stampDots(d, rng, 220, 0.95, 0.88, 0.35, 0.55, 1);
  stampDots(d, rng, 90, 0.96, 0.96, 0.92, 0.45, 1);
  ctx.putImageData(img, 0, 0);
}

// ── rock: grey base + large ridge cracks + worley facets + fine sand grain + mineral flecks ──
function paintRock(ctx) {
  const A = bake(makeFbm(4, 4, 4242));       // broad tone
  const RIDGE = bake(makeFbm(5, 3, 1357));   // large cracks (ridged)
  const WOR = bake(makeWorley(18, 3141));    // angular facets
  const GRAIN = bake(makeFbm(52, 1, 777));   // fine sand grain
  const FLECK = bake(makeFbm(23, 2, 9876));  // mineral specks
  const img = ctx.createImageData(SZ, SZ);
  const d = img.data;
  for (let y = 0; y < SZ; y++) {
    const row = y * SZ;
    for (let x = 0; x < SZ; x++) {
      const k = row + x;
      const ridge = 1 - Math.abs(RIDGE[k] * 2 - 1);
      const crack = sstep(0.76, 0.94, ridge);
      const facet = sstep(0.0, 0.13, WOR[k]);        // 0 at cell edge → 1 inside face
      const grain = (GRAIN[k] - 0.5) * 0.07;
      let base = 0.335 + A[k] * 0.185 + (facet - 0.5) * 0.115 + grain - crack * 0.24;
      // warm grey with a cool shadow bias in the cracks
      let r = base * 1.035 + crack * 0.01;
      let g = base * 1.000;
      let bl = base * 0.945 + crack * 0.02;
      const fl = FLECK[k];
      if (fl > 0.70) { const t = (fl - 0.70) * 1.6; r += t * 0.05; g += t * 0.055; bl += t * 0.07; }
      const i = k * 4;
      d[i] = c255(r * 255); d[i + 1] = c255(g * 255); d[i + 2] = c255(bl * 255); d[i + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
}

// ── sand: warm tan + wind ripples (two crossing directions) + shell-chip highlights ──
function paintSand(ctx) {
  const A = bake(makeFbm(6, 3, 5555));
  const B = bake(makeFbm(17, 2, 2468));
  const img = ctx.createImageData(SZ, SZ);
  const d = img.data;
  const TAU = Math.PI * 2;
  for (let y = 0; y < SZ; y++) {
    const v = y / SZ, row = y * SZ;
    for (let x = 0; x < SZ; x++) {
      const u = x / SZ, k = row + x;
      const a = A[k], b = B[k];
      // wind ripples: dominant swell + a fainter cross-set (integer freq → seamless)
      const rip1 = Math.sin((u * 44 + a * 4.0) * TAU) * 0.5 + 0.5;
      const rip2 = Math.sin((v * 31 + b * 3.0) * TAU) * 0.5 + 0.5;
      const rip = rip1 * 0.72 + rip2 * 0.28;
      const grain = (b - 0.5) * 0.05;
      let r = 0.775 + rip * 0.055 + (a - 0.5) * 0.045 + grain;
      let g = 0.672 + rip * 0.048 + (a - 0.5) * 0.040 + grain;
      let bl = 0.452 + rip * 0.030 + (b - 0.5) * 0.035 + grain * 0.7;
      const i = k * 4;
      d[i] = c255(r * 255); d[i + 1] = c255(g * 255); d[i + 2] = c255(bl * 255); d[i + 3] = 255;
    }
  }
  // shell chips + quartz grit
  const rng = mulberry32(1234);
  stampDots(d, rng, 150, 0.98, 0.96, 0.90, 0.5, 1);
  ctx.putImageData(img, 0, 0);
}

// ── snow: near-white + micro-blue concavity shadows (inverted fbm) + sparkle ──
function paintSnow(ctx) {
  const A = bake(makeFbm(5, 4, 8080));
  const B = bake(makeFbm(11, 3, 1010));
  const img = ctx.createImageData(SZ, SZ);
  const d = img.data;
  for (let y = 0; y < SZ; y++) {
    const row = y * SZ;
    for (let x = 0; x < SZ; x++) {
      const k = row + x;
      const a = A[k], b = B[k];
      // inverted fbm: low a = a hollow that holds a cold blue shadow
      const hollow = sstep(0.52, 0.24, a);
      let r = 0.905 + b * 0.045 - hollow * 0.115;
      let g = 0.930 + a * 0.035 - hollow * 0.060;
      let bl = 0.972 + b * 0.028 + hollow * 0.100;
      const i = k * 4;
      d[i] = c255(r * 255); d[i + 1] = c255(g * 255); d[i + 2] = c255(bl * 255); d[i + 3] = 255;
    }
  }
  // ice sparkle — sparse near-white glints
  const rng = mulberry32(31415);
  stampDots(d, rng, 420, 1.0, 1.0, 1.0, 0.7, 1);
  ctx.putImageData(img, 0, 0);
}

// ── detail normal map: Sobel of a periodic height field → tangent-space RGB ──
function paintDetailNormal(ctx) {
  const H = bake(makeFbm(14, 4, 99991));   // fine micro-relief
  const img = ctx.createImageData(SZ, SZ);
  const d = img.data;
  const strength = 3.2;
  for (let y = 0; y < SZ; y++) {
    const yu = ((y - 1) % SZ + SZ) % SZ, yd = (y + 1) % SZ, row = y * SZ;
    for (let x = 0; x < SZ; x++) {
      const xl = ((x - 1) % SZ + SZ) % SZ, xr = (x + 1) % SZ;
      const hL = H[row + xl], hR = H[row + xr];
      const hU = H[yu * SZ + x], hD = H[yd * SZ + x];
      let nx = (hL - hR) * strength;
      let ny = (hU - hD) * strength;
      let nz = 1.0;
      const len = Math.sqrt(nx * nx + ny * ny + nz * nz) || 1;
      nx /= len; ny /= len; nz /= len;
      const i = (row + x) * 4;
      d[i] = c255((nx * 0.5 + 0.5) * 255);
      d[i + 1] = c255((ny * 0.5 + 0.5) * 255);
      d[i + 2] = c255((nz * 0.5 + 0.5) * 255);
      d[i + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
}

// ── public API ───────────────────────────────────────────────────────────────

/**
 * Generate the terrain splat textures + detail normal map. Call once at boot.
 * @returns {{ grass: THREE.CanvasTexture, rock: THREE.CanvasTexture, sand: THREE.CanvasTexture,
 *             snow: THREE.CanvasTexture, detailNormal: THREE.CanvasTexture }}
 */
export function createTerrainTextures() {
  const out = {};
  const albedo = [
    ['grass', paintGrass], ['rock', paintRock], ['sand', paintSand], ['snow', paintSnow],
  ];
  for (const [name, painter] of albedo) {
    const canvas = document.createElement('canvas');
    canvas.width = SZ; canvas.height = SZ;
    const ctx = canvas.getContext('2d');
    painter(ctx);
    const tex = new THREE.CanvasTexture(canvas);
    tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
    tex.magFilter = THREE.LinearFilter;
    tex.minFilter = THREE.LinearMipmapLinearFilter;
    tex.generateMipmaps = true;
    tex.anisotropy = 8;
    tex.colorSpace = THREE.SRGBColorSpace;   // albedo → decoded to linear on sample
    out[name] = tex;
  }
  // detail normal: linear data, never sRGB-decoded
  const nCanvas = document.createElement('canvas');
  nCanvas.width = SZ; nCanvas.height = SZ;
  const nCtx = nCanvas.getContext('2d');
  paintDetailNormal(nCtx);
  const nTex = new THREE.CanvasTexture(nCanvas);
  nTex.wrapS = nTex.wrapT = THREE.RepeatWrapping;
  nTex.magFilter = THREE.LinearFilter;
  nTex.minFilter = THREE.LinearMipmapLinearFilter;
  nTex.generateMipmaps = true;
  nTex.anisotropy = 8;
  nTex.colorSpace = THREE.NoColorSpace;
  out.detailNormal = nTex;
  return out;
}
