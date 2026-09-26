// terrainTex.js — procedural tileable terrain textures for the splat shader
// Portions adapted from wowserhq/scene (MIT), © Wowser Contributors
// Generates 4 × 256×256 CanvasTextures at boot: grass, rock, sand, snow.
// No external assets — all noise is value/fbm computed per-pixel.

import * as THREE from 'three';

const SZ = 256;

// ── seeded PRNG (deterministic across boots) ─────────────────────────────────
function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ── tileable value noise ─────────────────────────────────────────────────────
function makeNoiseGrid(seed, gridSize) {
  const rng = mulberry32(seed);
  const g = new Float32Array(gridSize * gridSize);
  for (let i = 0; i < g.length; i++) g[i] = rng();
  return g;
}

function sampleNoiseGrid(grid, gridSize, x, y) {
  // x, y in [0,1) wrapping
  const fx = ((x % 1) + 1) % 1 * gridSize;
  const fy = ((y % 1) + 1) % 1 * gridSize;
  const ix = fx | 0, iy = fy | 0;
  const tx = fx - ix, ty = fy - iy;
  const sx = tx * tx * (3 - 2 * tx), sy = ty * ty * (3 - 2 * ty);
  const x0 = ix % gridSize, x1 = (ix + 1) % gridSize;
  const y0 = iy % gridSize, y1 = (iy + 1) % gridSize;
  const v00 = grid[y0 * gridSize + x0], v10 = grid[y0 * gridSize + x1];
  const v01 = grid[y1 * gridSize + x0], v11 = grid[y1 * gridSize + x1];
  return (v00 * (1 - sx) + v10 * sx) * (1 - sy) + (v01 * (1 - sx) + v11 * sx) * sy;
}

function fbm(grids, octaves, x, y, freq) {
  let v = 0, amp = 1, f = freq, total = 0;
  for (let o = 0; o < octaves; o++) {
    v += sampleNoiseGrid(grids[o % grids.length], grids[o % grids.length].length === 16 ? 16 : 32, x * f, y * f) * amp;
    total += amp; amp *= 0.5; f *= 2.03;
  }
  return v / total;
}

// ── texture painters ─────────────────────────────────────────────────────────

function paintGrass(ctx) {
  const g8 = makeNoiseGrid(1337, 16), g16 = makeNoiseGrid(7331, 32);
  const grids = [g8, g16];
  const img = ctx.createImageData(SZ, SZ);
  const d = img.data;
  for (let y = 0; y < SZ; y++) {
    for (let x = 0; x < SZ; x++) {
      const u = x / SZ, v = y / SZ;
      const n1 = fbm(grids, 4, u, v, 6);
      const n2 = fbm(grids, 3, u + 3.7, v + 1.2, 12);
      // blade streaks
      const blade = Math.sin((v * 80 + n1 * 12) * Math.PI) * 0.5 + 0.5;
      const base_r = 0.24 + n1 * 0.14 + blade * 0.04;
      const base_g = 0.44 + n1 * 0.20 + n2 * 0.08 + blade * 0.06;
      const base_b = 0.14 + n2 * 0.08;
      const i = (y * SZ + x) * 4;
      d[i]     = (base_r * 255) | 0;
      d[i + 1] = (base_g * 255) | 0;
      d[i + 2] = (base_b * 255) | 0;
      d[i + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
}

function paintRock(ctx) {
  const g8 = makeNoiseGrid(4242, 16), g16 = makeNoiseGrid(9876, 32);
  const grids = [g8, g16];
  const img = ctx.createImageData(SZ, SZ);
  const d = img.data;
  for (let y = 0; y < SZ; y++) {
    for (let x = 0; x < SZ; x++) {
      const u = x / SZ, v = y / SZ;
      const n1 = fbm(grids, 5, u, v, 5);
      const n2 = fbm(grids, 3, u + 7.1, v + 2.9, 14);
      // crack lines from ridged noise
      const ridge = 1 - Math.abs(fbm(grids, 4, u + 1.3, v + 5.7, 8) * 2 - 1);
      const crack = ridge > 0.82 ? (ridge - 0.82) * 4 : 0;
      const base = 0.38 + n1 * 0.22 - crack * 0.18;
      const highlight = n2 > 0.65 ? (n2 - 0.65) * 0.4 : 0;
      const r = base + highlight * 0.8;
      const g = base * 0.97 + highlight * 0.6;
      const b = base * 0.92 + highlight * 0.5;
      const i = (y * SZ + x) * 4;
      d[i]     = (Math.min(1, r) * 255) | 0;
      d[i + 1] = (Math.min(1, g) * 255) | 0;
      d[i + 2] = (Math.min(1, b) * 255) | 0;
      d[i + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
}

function paintSand(ctx) {
  const g8 = makeNoiseGrid(5555, 16), g16 = makeNoiseGrid(2468, 32);
  const grids = [g8, g16];
  const img = ctx.createImageData(SZ, SZ);
  const d = img.data;
  for (let y = 0; y < SZ; y++) {
    for (let x = 0; x < SZ; x++) {
      const u = x / SZ, v = y / SZ;
      const n1 = fbm(grids, 3, u, v, 8);
      // fine ripple: directional sine modulated by noise
      const ripple = Math.sin((u * 40 + n1 * 6) * Math.PI) * 0.5 + 0.5;
      const n2 = fbm(grids, 4, u + 2.2, v + 8.1, 16);
      const base_r = 0.82 + ripple * 0.06 + n2 * 0.04;
      const base_g = 0.72 + ripple * 0.05 + n1 * 0.04;
      const base_b = 0.48 + ripple * 0.03 + n2 * 0.03;
      const i = (y * SZ + x) * 4;
      d[i]     = (Math.min(1, base_r) * 255) | 0;
      d[i + 1] = (Math.min(1, base_g) * 255) | 0;
      d[i + 2] = (Math.min(1, base_b) * 255) | 0;
      d[i + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
}

function paintSnow(ctx) {
  const g8 = makeNoiseGrid(8080, 16), g16 = makeNoiseGrid(1010, 32);
  const grids = [g8, g16];
  const rng = mulberry32(31415);
  const img = ctx.createImageData(SZ, SZ);
  const d = img.data;
  // sparkle points
  const sparkles = [];
  for (let s = 0; s < 200; s++) sparkles.push([rng() * SZ | 0, rng() * SZ | 0, 0.5 + rng() * 0.5]);
  for (let y = 0; y < SZ; y++) {
    for (let x = 0; x < SZ; x++) {
      const u = x / SZ, v = y / SZ;
      const n1 = fbm(grids, 4, u, v, 6);
      const n2 = fbm(grids, 3, u + 4.4, v + 9.9, 10);
      // blue shadow in concavities
      const shadow = n1 < 0.4 ? (0.4 - n1) * 0.3 : 0;
      let r = 0.92 + n2 * 0.06 - shadow * 0.1;
      let g = 0.94 + n1 * 0.04 - shadow * 0.04;
      let b = 0.97 + n2 * 0.03 + shadow * 0.15;
      const i = (y * SZ + x) * 4;
      d[i]     = (Math.min(1, r) * 255) | 0;
      d[i + 1] = (Math.min(1, g) * 255) | 0;
      d[i + 2] = (Math.min(1, b) * 255) | 0;
      d[i + 3] = 255;
    }
  }
  // stamp sparkles
  for (const [sx, sy, bright] of sparkles) {
    const i = (sy * SZ + sx) * 4;
    d[i] = Math.min(255, d[i] + bright * 60) | 0;
    d[i + 1] = Math.min(255, d[i + 1] + bright * 60) | 0;
    d[i + 2] = Math.min(255, d[i + 2] + bright * 50) | 0;
  }
  ctx.putImageData(img, 0, 0);
}

// ── public API ───────────────────────────────────────────────────────────────

/**
 * Generate the 4 terrain splat textures. Call once at boot.
 * @returns {{ grass: THREE.CanvasTexture, rock: THREE.CanvasTexture, sand: THREE.CanvasTexture, snow: THREE.CanvasTexture }}
 */
export function createTerrainTextures() {
  const painters = [paintGrass, paintRock, paintSand, paintSnow];
  const names = ['grass', 'rock', 'sand', 'snow'];
  const out = {};
  for (let n = 0; n < 4; n++) {
    const canvas = document.createElement('canvas');
    canvas.width = SZ; canvas.height = SZ;
    const ctx = canvas.getContext('2d');
    painters[n](ctx);
    const tex = new THREE.CanvasTexture(canvas);
    tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
    tex.magFilter = THREE.LinearFilter;
    tex.minFilter = THREE.LinearMipmapLinearFilter;
    tex.generateMipmaps = true;
    tex.anisotropy = 4;
    tex.colorSpace = THREE.SRGBColorSpace;
    out[names[n]] = tex;
  }
  return out;
}
