// institutions.js — task 52: eight chronicle INSTITUTION LANDMARKS on the 3D diorama.
//
// Each of the eight read-out membranes of the chronicle gets a physical building on the map, with a
// silhouette drawn from its function (a colonnaded marble court, a sandstone colosseum, a half-timber
// guildhall, an octagonal library tower, a sealed granite archive vault, a brick workshop with a turning
// gear, a colonnaded bourse, a domed rotunda assembly). Clicking a building opens the chronicle drawer
// on the matching volume; hovering lifts a warm emissive + a pointer cursor.
//
// Rendering contract (mirrors the castles/villages in scene3d.js):
//   · every opaque part of a building is vertex-coloured and mergeGeometries'd into ONE mesh on ONE
//     toon material → 1 draw call per building (the workshop adds a turning gear + a smoke puff = 3).
//   · grounding is the caller's job: scene3d presses a build terrace per spot and this module seats each
//     building on groundY(x, z, footprint) — the multi-point sampler (never a single centre sample).
//   · pure read-out: this file only ever OPENS a drawer volume; it touches no sim / economy / connectome.
//
// The volume mapping is the real one (some membranes share a codex volume):
//   court→court · games→games · guilds→guilds · lexicon→lexicon · bourse→bourse
//   archive→tech  (the "written word" section lives in the Ladder-of-Arts volume)
//   workshop→tech (the "workshop" section lives in the same volume)
//   commons→law   (the assembly/commons-in-law section lives in the Assembly volume)
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';


// ---------------------------------------------------------------------------
// vertex-colour helpers — raw 0..1 floats (NOT THREE.Color) so the buildings sit in the exact same
// colour space as the existing castles/villages, which paint [r,g,b] floats straight into the attribute.
// ---------------------------------------------------------------------------
function rgb(hex) { return [((hex >> 16) & 255) / 255, ((hex >> 8) & 255) / 255, (hex & 255) / 255]; }

/** Force a geometry to non-indexed and paint every vertex a flat colour, so mergeGeometries is happy. */
function solid(geo, hex) {
  const gi = geo.index ? geo.toNonIndexed() : geo;
  const c = rgb(hex);
  const n = gi.attributes.position.count;
  const arr = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) { arr[i * 3] = c[0]; arr[i * 3 + 1] = c[1]; arr[i * 3 + 2] = c[2]; }
  gi.setAttribute('color', new THREE.BufferAttribute(arr, 3));
  return gi;
}

/**
 * Tiny geometry assembler: every call bakes a primitive's transform into its vertices, paints it, and
 * accumulates it. merge() fuses the lot into one non-indexed vertex-coloured BufferGeometry.
 * `m` = { x,y,z, rx,ry,rz, sx,sy,sz } — scale is applied first, then rotation, then translation.
 */
class B {
  constructor() { this.parts = []; }
  _add(geo, hex, m) {
    m = m || {};
    if (m.sx != null) geo.scale(m.sx, m.sy == null ? 1 : m.sy, m.sz == null ? 1 : m.sz);
    if (m.rx) geo.rotateX(m.rx);
    if (m.ry) geo.rotateY(m.ry);
    if (m.rz) geo.rotateZ(m.rz);
    geo.translate(m.x || 0, m.y || 0, m.z || 0);
    this.parts.push(solid(geo, hex));
    return this;
  }
  box(w, h, d, hex, m) { return this._add(new THREE.BoxGeometry(w, h, d), hex, m); }
  cyl(rt, rb, h, seg, hex, m, open) { return this._add(new THREE.CylinderGeometry(rt, rb, h, seg, 1, !!open), hex, m); }
  cone(r, h, seg, hex, m) { return this._add(new THREE.ConeGeometry(r, h, seg), hex, m); }
  sph(r, hex, m, ws, hs) { return this._add(new THREE.SphereGeometry(r, ws || 14, hs || 12), hex, m); }
  hemi(r, hex, m, ws, hs) { return this._add(new THREE.SphereGeometry(r, ws || 20, hs || 12, 0, Math.PI * 2, 0, Math.PI / 2), hex, m); }
  torus(r, tube, hex, m, rs, ts) { return this._add(new THREE.TorusGeometry(r, tube, ts || 8, rs || 24), hex, m); }
  ring(ri, ro, seg, hex, m) { return this._add(new THREE.RingGeometry(ri, ro, seg || 24), hex, m); }
  circle(r, seg, hex, m) { return this._add(new THREE.CircleGeometry(r, seg || 24), hex, m); }
  /** an extruded triangle (base w, apex h, depth d) centred on the origin — a clean front-facing pediment. */
  tri(w, h, d, hex, m) {
    const s = new THREE.Shape();
    s.moveTo(-w / 2, 0); s.lineTo(w / 2, 0); s.lineTo(0, h); s.closePath();
    const g = new THREE.ExtrudeGeometry(s, { depth: d, bevelEnabled: false });
    g.translate(0, 0, -d / 2);
    return this._add(g, hex, m);
  }
  merge() {
    const g = mergeGeometries(this.parts, false);
    for (const p of this.parts) if (p !== g) p.dispose();
    this.parts.length = 0;
    return g;
  }
}

// ---------------------------------------------------------------------------
// palettes — dominant material + sharp accents per institution (no timid even splits)
// ---------------------------------------------------------------------------
const MARBLE = 0xe8e4dc, MARBLE_SH = 0xcdc7ba, GOLD = 0xd9b968, IRON = 0x4a4640;
const SAND = 0xc8a870, SAND_DK = 0xa8885a, ARENA = 0xd4b06a, ARCH_DK = 0x4a3a28;
const WOOD = 0x6b4a2f, CREAM = 0xd4c4a0, TILE = 0x7a3b2e, TIMBER = 0x3a2a1a, BRASS = 0xc8a24a;
const BLUE_ST = 0x4a5a6a, BLUE_LT = 0x5f7284, SLATE = 0x2a323c;
const GRANITE = 0x7a7a78, GRAN_DK = 0x5c5c5a, VAULT = 0x2e2e2c;
const BRICK = 0x8b4a3a, BRICK_DK = 0x6e382c, METAL = 0x6d6d76, SMOKE = 0xc4c4c4;
const BOURSE = 0xddd0b8, BOURSE_DK = 0xc0b298;
const WARM = 0xc8b898, WARM_DK = 0xa89878, ROT_DK = 0x4a4438;

// ===========================================================================
// ① THE COURT — a classical marble courthouse: stepped stylobate, six-column portico,
//    triangular pediment, low gable roof, and a golden scale-of-justice standing before the door.
// ===========================================================================
function buildCourt(g, rec, sc) {
  const b = new B();
  // three receding steps
  b.box(17, 0.7, 13, MARBLE, { y: 0.35 });
  b.box(15, 0.7, 11.5, MARBLE, { y: 1.05 });
  b.box(13, 0.7, 10, MARBLE_SH, { y: 1.75 });
  // cella (the walled chamber behind the portico)
  b.box(11, 6.8, 7.6, MARBLE_SH, { y: 5.5, z: -0.9 });
  // six columns + bases + capitals across the front
  for (let i = 0; i < 6; i++) {
    const x = -5 + i * 2;
    b.cyl(1.0, 1.05, 0.4, 12, MARBLE_SH, { x, y: 2.3, z: 3.6 });
    b.cyl(0.72, 0.85, 7.0, 14, MARBLE, { x, y: 5.6, z: 3.6 });
    b.cyl(1.05, 0.74, 0.55, 12, MARBLE, { x, y: 9.35, z: 3.6 });
  }
  // entablature + frieze the pediment crowns
  b.box(14.6, 1.1, 2.5, MARBLE, { y: 9.95, z: 3.4 });
  b.box(14.8, 0.5, 2.6, MARBLE_SH, { y: 10.7, z: 3.4 });
  // triangular pediment (front gable) + low double-pitch roof over the cella
  b.tri(13.6, 3.0, 2.2, MARBLE, { y: 10.95, z: 3.4 });
  b.box(8.4, 0.45, 8.2, MARBLE_SH, { x: -3.2, y: 12.2, z: -0.9, rz: 0.30 });
  b.box(8.4, 0.45, 8.2, MARBLE_SH, { x: 3.2, y: 12.2, z: -0.9, rz: -0.30 });
  b.box(0.6, 0.6, 8.2, MARBLE, { y: 13.35, z: -0.9 });
  // the scales of justice before the steps — a slim post, a cross-bar, two hanging pans
  b.cyl(0.75, 0.85, 0.3, 12, IRON, { y: 0.15, z: 6.6 });
  b.cyl(0.12, 0.14, 4.4, 8, GOLD, { y: 2.3, z: 6.6 });
  b.box(3.0, 0.14, 0.14, GOLD, { y: 4.35, z: 6.6 });
  b.box(0.05, 0.65, 0.05, GOLD, { x: -1.4, y: 4.0, z: 6.6 });
  b.box(0.05, 0.65, 0.05, GOLD, { x: 1.4, y: 4.0, z: 6.6 });
  b.cyl(0.55, 0.55, 0.1, 12, GOLD, { x: -1.4, y: 3.62, z: 6.6 });
  b.cyl(0.55, 0.55, 0.1, 12, GOLD, { x: 1.4, y: 3.62, z: 6.6 });
  b.sph(0.22, GOLD, { y: 4.65, z: 6.6 }, 10, 8);
  _mesh(g, rec, sc, b);
}

// ===========================================================================
// ② THE GAMES — a sandstone colosseum: open ring wall + cornice, eight dark arches, three
//    stepped seating tiers descending to a sand floor. DoubleSided so the bowl reads from above.
// ===========================================================================
function buildGames(g, rec, sc) {
  const b = new B();
  b.cyl(12, 12, 6, 30, SAND, { y: 3 }, true);                 // open outer wall
  b.torus(12, 0.55, SAND_DK, { y: 6.0, rx: Math.PI / 2 }, 30, 8);   // top cornice
  b.torus(12.2, 0.5, SAND_DK, { y: 0.35, rx: Math.PI / 2 }, 30, 8); // footing ring
  for (let i = 0; i < 8; i++) {                               // eight arched voids in the wall
    const a = (i / 8) * Math.PI * 2, x = Math.cos(a) * 11.7, z = Math.sin(a) * 11.7;
    b.box(1.7, 3.4, 1.1, ARCH_DK, { x, y: 2.6, z, ry: Math.atan2(x, z) });
    b.cyl(0.85, 0.85, 1.1, 10, ARCH_DK, { x, y: 4.3, z, rx: Math.PI / 2, ry: Math.atan2(x, z) });
  }
  // three concentric seating tiers — treads (flat annuli) + risers (open drums) — stepping down inward
  b.ring(9.6, 12, 30, SAND, { y: 5.0, rx: -Math.PI / 2 });
  b.cyl(9.6, 9.6, 1.0, 30, SAND_DK, { y: 4.5 }, true);
  b.ring(8.0, 9.6, 30, SAND_DK, { y: 4.0, rx: -Math.PI / 2 });
  b.cyl(8.0, 8.0, 1.0, 30, SAND, { y: 3.5 }, true);
  b.ring(6.6, 8.0, 30, SAND, { y: 3.0, rx: -Math.PI / 2 });
  b.cyl(6.6, 6.6, 1.0, 30, SAND_DK, { y: 2.5 }, true);
  b.circle(6.6, 30, ARENA, { y: 2.05, rx: -Math.PI / 2 });    // the sand
  b.circle(2.2, 18, SAND_DK, { y: 2.07, rx: -Math.PI / 2 });  // centre emblem
  _mesh(g, rec, sc, b, true);
}

// ===========================================================================
// ③ THE GUILDHALL — a medieval half-timber hall: steep double gable, a corner bell tower with a
//    brass clock face + hands, timber striping on the front gable, a deep doorway.
// ===========================================================================
function buildGuilds(g, rec, sc) {
  const b = new B();
  b.box(9, 7, 12, CREAM, { y: 3.5 });                          // the long hall
  // steep roof (two slabs meeting at a high ridge)
  b.box(7.0, 0.4, 12.6, TILE, { x: -2.2, y: 8.6, rz: 0.9 });
  b.box(7.0, 0.4, 12.6, TILE, { x: 2.2, y: 8.6, rz: -0.9 });
  b.box(0.6, 0.6, 12.6, TIMBER, { y: 11.2 });
  // front gable wall + half-timber striping
  b.tri(9, 4.3, 0.6, CREAM, { y: 7.0, z: 6.02 });
  b.box(8.6, 0.28, 0.16, TIMBER, { y: 8.4, z: 6.36 });
  b.box(0.26, 4.0, 0.16, TIMBER, { x: -2.1, y: 9.0, z: 6.36 });
  b.box(0.26, 4.0, 0.16, TIMBER, { x: 2.1, y: 9.0, z: 6.36 });
  b.box(0.24, 4.4, 0.16, TIMBER, { x: -1.1, y: 9.0, z: 6.36, rz: 0.5 });
  b.box(0.24, 4.4, 0.16, TIMBER, { x: 1.1, y: 9.0, z: 6.36, rz: -0.5 });
  // corner bell tower
  b.box(3.6, 13, 3.6, CREAM, { x: -6.6, y: 6.5, z: -3.2 });
  b.box(4.0, 0.5, 4.0, TIMBER, { x: -6.6, y: 13.1, z: -3.2 });
  b.cone(2.9, 4.2, 4, TILE, { x: -6.6, y: 15.4, z: -3.2, ry: Math.PI / 4 });
  b.sph(0.3, BRASS, { x: -6.6, y: 17.7, z: -3.2 }, 8, 6);
  // clock face (front of the tower) + two hands
  b.cyl(1.3, 1.3, 0.22, 18, BRASS, { x: -6.6, y: 11.0, z: -1.32, rx: Math.PI / 2 });
  b.torus(1.32, 0.12, TIMBER, { x: -6.6, y: 11.0, z: -1.24, rx: Math.PI / 2 }, 18, 6);
  b.box(0.12, 1.0, 0.08, TIMBER, { x: -6.6, y: 11.42, z: -1.16 });
  b.box(0.72, 0.1, 0.08, TIMBER, { x: -6.28, y: 11.0, z: -1.16 });
  // doorway + hall windows
  b.box(1.9, 3.2, 0.3, TIMBER, { y: 1.6, z: 6.1 });
  for (let i = -1; i <= 1; i += 2) {
    b.box(1.0, 1.6, 0.24, SLATE, { x: i * 2.6, y: 4.4, z: 6.05 });
    b.box(1.0, 1.6, 0.24, SLATE, { x: 4.55, y: 4.4, z: i * 3.0, ry: Math.PI / 2 });
  }
  _mesh(g, rec, sc, b);
}

// ===========================================================================
// ④ THE LEXICON — an octagonal library tower: low ringed skirt, eight slit windows, a corbelled
//    cornice, an octagonal spire and a golden "pearl of knowledge" at the very top.
// ===========================================================================
function buildLexicon(g, rec, sc) {
  const b = new B();
  const O = Math.PI / 8;                                       // octagon face alignment
  b.cyl(8.2, 8.4, 0.6, 8, BLUE_LT, { y: 0.3, ry: O });         // base step
  b.cyl(7.4, 7.6, 2.6, 8, BLUE_LT, { y: 1.6, ry: O });         // skirt colonnade drum
  b.ring(5.2, 7.7, 8, BLUE_ST, { y: 2.95, rx: -Math.PI / 2, ry: O }); // skirt ledge (open-scroll feel)
  b.cyl(5, 5, 14, 8, BLUE_ST, { y: 9.9, ry: O });              // the tower shaft
  for (let i = 0; i < 8; i++) {                                // a narrow dark window on every face
    const a = O + (i / 8) * Math.PI * 2, x = Math.cos(a) * 4.66, z = Math.sin(a) * 4.66;
    b.box(0.85, 5.0, 0.3, SLATE, { x, y: 10.4, z, ry: Math.atan2(x, z) });
    b.box(1.15, 0.3, 0.34, BLUE_LT, { x: Math.cos(a) * 4.7, y: 13.1, z: Math.sin(a) * 4.7, ry: Math.atan2(x, z) });
  }
  b.cyl(5.5, 5.5, 0.7, 8, BLUE_LT, { y: 17.1, ry: O });        // corbelled cornice
  b.cone(4.7, 5.6, 8, BLUE_LT, { y: 20.2, ry: O });            // octagonal spire
  b.sph(1.0, GOLD, { y: 23.4 }, 14, 12);                       // the pearl of knowledge
  b.cone(0.32, 1.0, 6, GOLD, { y: 24.6 });
  _mesh(g, rec, sc, b);
}

// ===========================================================================
// ⑤ THE ARCHIVE — a sealed granite vault: windowless drum, ribbed hemispherical dome, one narrow
//    door under a golden seal disc. Reads as an impregnable record-keep.
// ===========================================================================
function buildArchive(g, rec, sc) {
  const b = new B();
  b.cyl(9, 9.4, 1.2, 20, GRAN_DK, { y: 0.6 });                 // plinth
  b.cyl(8, 8, 6, 22, GRANITE, { y: 4.2 });                     // windowless drum
  b.torus(8.15, 0.5, GRAN_DK, { y: 7.2, rx: Math.PI / 2 }, 22, 8);   // cornice
  b.hemi(8, GRANITE, { y: 7.2 }, 22, 12);                      // the dome
  for (let i = 0; i < 4; i++)                                  // eight stone ribs (4 great circles)
    b.torus(8.06, 0.26, GRAN_DK, { y: 7.2, ry: i * Math.PI / 4 }, 22, 6);
  b.sph(0.75, GRAN_DK, { y: 15.1 }, 12, 10);                   // keystone
  // the single narrow door + its golden seal
  b.box(2.1, 3.8, 0.7, VAULT, { y: 2.0, z: 7.75 });
  b.cyl(1.05, 1.05, 0.7, 14, VAULT, { y: 3.9, z: 7.75, rx: Math.PI / 2 });
  b.cyl(0.95, 0.95, 0.3, 18, GOLD, { y: 5.5, z: 8.05, rx: Math.PI / 2 });
  b.torus(1.0, 0.12, GRAN_DK, { y: 5.5, z: 8.1, rx: Math.PI / 2 }, 18, 6);
  _mesh(g, rec, sc, b);
}

// ===========================================================================
// ⑥ THE WORKSHOP — a brick manufactory: gabled hall + lower annex, two banded chimneys, a slow
//    turning iron gear on the annex wall, and a drifting translucent smoke puff. (3 draw calls)
// ===========================================================================
function buildWorkshop(g, rec, sc) {
  const b = new B();
  b.box(13, 6, 9, BRICK, { y: 3 });                            // main hall
  b.box(7.8, 0.4, 9.6, WOOD, { x: -3.1, y: 7.0, rz: 0.5 });    // low gable roof
  b.box(7.8, 0.4, 9.6, WOOD, { x: 3.1, y: 7.0, rz: -0.5 });
  b.box(0.5, 0.5, 9.6, BRICK_DK, { y: 8.65 });
  b.box(6, 4, 7, BRICK_DK, { x: 9.2, y: 2, z: 0 });            // lower annex
  b.box(6.4, 0.35, 7.4, WOOD, { x: 9.2, y: 4.15, z: 0 });
  // two chimneys with caps + bands
  b.box(1.7, 10.5, 1.7, BRICK, { x: -3.6, y: 5.25, z: -2.2 });
  b.box(2.1, 0.5, 2.1, BRICK_DK, { x: -3.6, y: 10.6, z: -2.2 });
  b.box(1.9, 0.35, 1.9, BRICK_DK, { x: -3.6, y: 8.4, z: -2.2 });
  b.box(1.4, 8.2, 1.4, BRICK, { x: -0.4, y: 4.1, z: -2.2 });
  b.box(1.8, 0.45, 1.8, BRICK_DK, { x: -0.4, y: 8.35, z: -2.2 });
  // door + windows
  b.box(2.3, 3.3, 0.3, WOOD, { y: 1.65, z: 4.6 });
  for (let i = -1; i <= 1; i += 2) b.box(1.5, 1.5, 0.24, SLATE, { x: i * 3.6, y: 4.0, z: 4.55 });
  b.box(1.3, 1.3, 0.24, SLATE, { x: 9.2, y: 2.4, z: 3.55 });
  _mesh(g, rec, sc, b);

  // ---- the turning gear: its own pivot (faces +X off the annex) so update() can spin rotation.z ----
  const gb = new B();
  gb.cyl(1.5, 1.5, 0.5, 14, METAL, { rx: Math.PI / 2 });       // hub disc in the XY plane
  gb.torus(1.5, 0.16, BRASS, { rx: 0 }, 16, 6);
  for (let i = 0; i < 8; i++) {                                // eight radial teeth
    const a = (i / 8) * Math.PI * 2;
    gb.box(0.5, 0.95, 0.5, METAL, { x: Math.cos(a) * 1.85, y: Math.sin(a) * 1.85, z: 0, rz: a });
  }
  for (let k = 0; k < 4; k++) gb.box(3.1, 0.28, 0.28, METAL, { rz: k * Math.PI / 4 }); // spokes
  gb.cyl(0.4, 0.4, 0.9, 10, BRASS, { rx: Math.PI / 2 });       // axle boss
  const gear = new THREE.Mesh(gb.merge(), sc._toon(0xffffff, { vertexColors: true, emissive: 0xffa63a, emissiveIntensity: 0 }));
  const pivot = new THREE.Group();
  pivot.position.set(12.35, 4.6, 0);
  pivot.rotation.y = Math.PI / 2;                              // gear face points outward (+X)
  pivot.add(gear);
  g.add(pivot);
  rec.gears.push(gear); rec.mats.push(gear.material);

  // ---- translucent smoke puff over the tall chimney (bobs + breathes in update) ----
  const sb = new B();
  sb.sph(0.95, SMOKE, { x: 0, y: 0, z: 0 }, 8, 6);
  sb.sph(1.25, SMOKE, { x: 0.55, y: 1.5, z: 0.2 }, 8, 6);
  sb.sph(1.55, SMOKE, { x: -0.35, y: 3.1, z: -0.25 }, 8, 6);
  const smoke = new THREE.Mesh(sb.merge(), new THREE.MeshBasicMaterial({ color: 0xbdbdbd, transparent: true, opacity: 0.3, depthWrite: false }));
  smoke.position.set(-3.6, 11.2, -2.2);
  g.add(smoke);
  rec.smoke = smoke; rec.smokeBaseY = smoke.position.y;
}

// ===========================================================================
// ⑦ THE BOURSE — a colonnaded exchange: two broad steps, eight slim columns under a flat entablature,
//    three gold coin reliefs on the frieze, a low roof over a wide flat body.
// ===========================================================================
function buildBourse(g, rec, sc) {
  const b = new B();
  b.box(18, 0.6, 13, BOURSE_DK, { y: 0.3 });                   // two broad steps
  b.box(16, 0.6, 11.6, BOURSE, { y: 0.9 });
  b.box(13, 5.6, 9, BOURSE, { y: 4.0, z: -0.6 });              // wide flat body
  for (let i = 0; i < 8; i++) {                                // eight slim columns
    const x = -5.25 + i * 1.5;
    b.cyl(0.6, 0.62, 0.3, 10, BOURSE_DK, { x, y: 1.35, z: 4.2 });
    b.cyl(0.42, 0.46, 5.2, 12, BOURSE, { x, y: 4.1, z: 4.2 });
    b.cyl(0.6, 0.44, 0.35, 10, BOURSE, { x, y: 6.85, z: 4.2 });
  }
  b.box(15.4, 1.0, 2.3, BOURSE, { y: 7.4, z: 4.0 });           // entablature
  for (let i = -1; i <= 1; i++) {                              // three coin reliefs on the frieze
    b.cyl(0.9, 0.9, 0.22, 18, GOLD, { x: i * 3.6, y: 7.4, z: 5.2, rx: Math.PI / 2 });
    b.torus(0.92, 0.1, BRASS, { x: i * 3.6, y: 7.4, z: 5.24, rx: Math.PI / 2 }, 18, 6);
  }
  b.box(14.4, 0.5, 10.2, BOURSE_DK, { y: 8.1, z: -0.4 });      // low roof
  b.box(8.2, 0.4, 10.2, BOURSE, { x: -3.0, y: 8.7, z: -0.4, rz: 0.24 });
  b.box(8.2, 0.4, 10.2, BOURSE, { x: 3.0, y: 8.7, z: -0.4, rz: -0.24 });
  b.sph(0.42, GOLD, { y: 9.4, z: -0.4 }, 10, 8);
  b.box(2.4, 3.4, 0.3, IRON, { y: 2.9, z: 3.95 });             // door
  _mesh(g, rec, sc, b);
}

// ===========================================================================
// ⑧ THE COMMONS — a domed rotunda: round hall under a hemisphere + lantern, ringed by twelve slim
//    peristyle columns, with a frontal stepped portico and pediment. The assembly made stone.
// ===========================================================================
function buildCommons(g, rec, sc) {
  const b = new B();
  b.cyl(11, 11.4, 0.6, 24, WARM_DK, { y: 0.3 });               // round stepped base
  b.cyl(10.4, 10.6, 0.6, 24, WARM, { y: 0.9 });
  b.cyl(9, 9, 5, 26, WARM, { y: 3.7 });                        // circular hall
  for (let i = 0; i < 12; i++) {                               // twelve-column peristyle
    const a = (i / 12) * Math.PI * 2, x = Math.cos(a) * 10.1, z = Math.sin(a) * 10.1;
    b.cyl(0.5, 0.54, 5.0, 10, WARM, { x, y: 3.7, z });
    b.cyl(0.66, 0.68, 0.3, 10, WARM_DK, { x, y: 1.3, z });
    b.cyl(0.64, 0.5, 0.3, 10, WARM, { x, y: 6.3, z });
  }
  b.torus(10.1, 0.45, WARM_DK, { y: 6.5, rx: Math.PI / 2 }, 26, 8); // peristyle entablature ring
  b.hemi(9, WARM, { y: 6.2 }, 26, 14);                         // the dome
  b.torus(9.05, 0.35, WARM_DK, { y: 6.25, rx: Math.PI / 2 }, 26, 8);
  b.cyl(1.5, 1.7, 1.9, 12, WARM_DK, { y: 15.4 });              // lantern pavilion
  b.cone(1.9, 1.7, 12, WARM, { y: 17.1 });
  b.sph(0.5, GOLD, { y: 18.2 }, 12, 10);                       // finial
  // frontal portico: steps, two columns, lintel + pediment
  b.box(6.4, 0.6, 3.4, WARM_DK, { y: 0.5, z: 10.6 });
  b.cyl(0.5, 0.54, 5.0, 10, WARM, { x: -2.3, y: 3.7, z: 10.4 });
  b.cyl(0.5, 0.54, 5.0, 10, WARM, { x: 2.3, y: 3.7, z: 10.4 });
  b.box(6.2, 0.8, 1.7, WARM, { y: 6.5, z: 10.4 });
  b.tri(6.2, 1.7, 1.3, WARM, { y: 6.9, z: 10.4 });
  b.box(2.3, 3.8, 0.4, ROT_DK, { y: 2.5, z: 8.95 });           // door
  _mesh(g, rec, sc, b);
}

/** Fuse a builder's parts into one vertex-coloured mesh on one toon material, tagged for picking. */
function _mesh(g, rec, sc, b, doubleSide) {
  const geo = b.merge();
  const mat = sc._toon(0xffffff, { vertexColors: true, emissive: 0xffa63a, emissiveIntensity: 0, side: doubleSide ? THREE.DoubleSide : THREE.FrontSide });
  const mesh = new THREE.Mesh(geo, mat);
  g.add(mesh);
  rec.mats.push(mat);
}

// ---------------------------------------------------------------------------
// the eight institutions, in build order. `foot` doubles as the sculpt-terrace inner radius and the
// groundY sampling radius.
// ---------------------------------------------------------------------------
export const INSTITUTIONS = [
  { key: 'court',    vol: 'court',   foot: 11, build: buildCourt },
  { key: 'games',    vol: 'games',   foot: 14, build: buildGames },
  { key: 'guilds',   vol: 'guilds',  foot: 11, build: buildGuilds },
  { key: 'lexicon',  vol: 'lexicon', foot: 10, build: buildLexicon },
  { key: 'archive',  vol: 'tech',    foot: 11, build: buildArchive },
  { key: 'workshop', vol: 'tech',    foot: 12, build: buildWorkshop },
  { key: 'bourse',   vol: 'bourse',  foot: 12, build: buildBourse },
  { key: 'commons',  vol: 'law',     foot: 13, build: buildCommons },
];

// ---------------------------------------------------------------------------
// placement — deterministic, land-snapping, castle/village/canal-aware
// ---------------------------------------------------------------------------
const GOLDEN = 2.399963229728653;   // π(3−√5): spreads same-nation institutions around the seed

/**
 * Compute the eight landmark anchors from the live nation partition. Institution i orbits nation
 * (i mod N) on a golden-angle fan, pushed 20-42 units out from the capital seed so it stays inside
 * the nation's own cell (away from the border canals) and clear of the keep. Each candidate must be
 * solid land, clear of every castle seed, every village anchor and every sibling landmark. A relaxed
 * second pass (then a hard fallback) guarantees all eight are placed even on a crowded continent.
 *
 * @param nationSeeds [{x,z,...}] live nation capital seeds (world units)
 * @param sampleH     (x,z)=>height  pristine relief sampler (scene._sampleH over _hBase)
 * @param WSX,WSZ     world size
 * @param avoid       [{x,z}] village anchors to keep clear of
 * @returns [{x,z,defIndex,rot,rIn,rOut}]
 */
export function computeInstitutionSpots(nationSeeds, sampleH, WSX, WSZ, avoid) {
  const seeds = (nationSeeds && nationSeeds.length) ? nationSeeds : null;
  if (!seeds) return [];
  avoid = avoid || [];
  const N = seeds.length;
  const HX = WSX / 2 - 26, HZ = WSZ / 2 - 26;
  const spots = [];
  const land = (x, z, min) => sampleH(x, z) >= min;
  const clear = (x, z, castleMin, villageMin, sepMin) => {
    for (const s of seeds) if (Math.hypot(s.x - x, s.z - z) < castleMin) return false;
    for (const a of avoid) if (Math.hypot(a.x - x, a.z - z) < villageMin) return false;
    for (const p of spots) if (Math.hypot(p.x - x, p.z - z) < sepMin) return false;
    return true;
  };
  for (let i = 0; i < INSTITUTIONS.length; i++) {
    const def = INSTITUTIONS[i];
    const seed = seeds[i % N];
    const base = i * GOLDEN;
    let c = null;
    for (let t = 0; t < 44 && !c; t++) {                    // tier 1 — strict
      const ang = base + t * 0.53, dist = 26 + (t % 5) * 4;
      const x = seed.x + Math.cos(ang) * dist, z = seed.z + Math.sin(ang) * dist;
      if (Math.abs(x) > HX || Math.abs(z) > HZ) continue;
      if (!land(x, z, 1.0) || !clear(x, z, 24, 18, 34)) continue;
      c = { x, z };
    }
    for (let t = 0; t < 72 && !c; t++) {                    // tier 2 — relaxed
      const ang = base + t * 0.37, dist = 20 + (t % 6) * 4;
      const x = seed.x + Math.cos(ang) * dist, z = seed.z + Math.sin(ang) * dist;
      if (Math.abs(x) > HX || Math.abs(z) > HZ) continue;
      if (!land(x, z, 0.6) || !clear(x, z, 18, 0, 24)) continue;
      c = { x, z };
    }
    if (!c) { const ang = base; c = { x: seed.x + Math.cos(ang) * 22, z: seed.z + Math.sin(ang) * 22 }; }
    spots.push({ x: c.x, z: c.z, defIndex: i, rot: Math.atan2(-c.x, -c.z), rIn: def.foot, rOut: def.foot + 12 });
  }
  return spots;
}



// ===========================================================================
// Institutions — owns the group of eight landmarks; built once, spun/hovered/picked thereafter.
// ===========================================================================
export class Institutions {
  /**
   * @param scene the THREE.Scene
   * @param sc    the ThreeScene (for groundY + the shared _toon ramp material)
   */
  constructor(scene, sc) {
    this.scene = scene;
    this.sc = sc;
    this.group = new THREE.Group();
    this.group.name = 'institutions';
    this.built = false;
    this.entries = [];          // [{ def, group, mats, gears, smoke, smokeBaseY }]
    this._pickMeshes = [];      // flat list of building meshes (no label sprites) for raycasting
    this._hover = null;
    scene.add(this.group);
  }

  /** Seat all eight buildings on their (already terrace-pressed) spots. Idempotent via `built`. */
  build(spots) {
    if (this.built || !spots || !spots.length) return;
    this.built = true;
    for (const sp of spots) {
      const def = INSTITUTIONS[sp.defIndex];
      if (!def) continue;
      const gy = this.sc.groundY(sp.x, sp.z, Math.min(def.foot, 15));
      const g = new THREE.Group();
      g.position.set(sp.x, gy - 0.35, sp.z);   // a shallow embed so the floor never gaps off the mesa
      g.rotation.y = sp.rot || 0;
      const rec = { def, group: g, mats: [], gears: [], smoke: null, smokeBaseY: 0 };
      try { def.build(g, rec, this.sc); } catch (e) { console.warn('[institutions] build failed:', def.key, e); }
      g.traverse((o) => { if (o.isMesh) { o.userData.instRec = rec; this._pickMeshes.push(o); } });
      this.group.add(g);
      this.entries.push(rec);
    }
  }

  /** Per-frame: the workshop gear turns, its smoke drifts. Nothing else animates (cheap). */
  update(dt, now) {
    for (const rec of this.entries) {
      for (const gear of rec.gears) gear.rotation.z += dt * 0.2;
      if (rec.smoke) {
        const t = now || 0;
        rec.smoke.position.y = rec.smokeBaseY + Math.sin(t * 0.0006) * 0.7;
        rec.smoke.material.opacity = 0.26 + 0.12 * (0.5 + 0.5 * Math.sin(t * 0.0009));
      }
    }
  }

  /** Raycast the building meshes; return the owning record (nearest) or null. */
  pick(raycaster) {
    if (!this._pickMeshes.length) return null;
    this.group.updateMatrixWorld(true);
    const hits = raycaster.intersectObjects(this._pickMeshes, false);
    for (const h of hits) { const r = h.object && h.object.userData.instRec; if (r) return r; }
    return null;
  }

  /** Toggle the warm hover glow; returns the newly-hovered record (or null) for cursor wiring. */
  setHover(rec) {
    if (this._hover === rec) return rec;
    if (this._hover) for (const m of this._hover.mats) m.emissiveIntensity = 0;
    this._hover = rec;
    if (rec) for (const m of rec.mats) m.emissiveIntensity = 0.22;
    return rec;
  }
}
