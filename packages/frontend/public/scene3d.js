// scene3d.js — ThreeScene：3D 场景（地形/海面/Sky/果蝇/KayKit村庄/城堡/省标签）
// 由 app.js 机械拆分（任务5），行为与原文件一致；原文件保留为 app.js 备份参考。
// 任务18：删程序化泥砖定居点/河流/森林/草丛（方块感 + 性能），海面改轻量材质，
// 大陆 480×300 → 720×450，城堡重装为完整主堡+角塔+城墙+城门+吊桥+旗帜。
import { state, CONTINENT, PROVINCES, houseColor, wealthColorAt, clamp, lerp, mix, fnv1a, GOLD_THREAD, CRACK_RED, LAW_GOLD, FAITH_GOLD, COIN_GOLD, TECH_BRONZE, ASH_GREY, GOOD_COL, ECON_EDGE_MS, GRAVE_CAP, graveUid } from './shared.js';
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { Sky } from 'three/addons/objects/Sky.js';
import { ImprovedNoise } from 'three/addons/math/ImprovedNoise.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { zoneAnchor, chronFx, showEpitaph, hideEpitaph, glyphFor } from './render2d.js';
import { select as selectFly, deselect as deselectFly } from './inspector.js';
import { updateNations, assignNationIds, buildBorderMesh, getNationId, getNationTint } from './nations.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';

// ================= THREE.JS 3D SCENE =================
// Replaces the Canvas 2D render pipeline with a Three.js 3D scene:
// - Procedural terrain from CONTINENT data (parchment toon shader)
// - InstancedMesh flies (3D boids from updateSim positions)
// - KayKit village rings + Kenney castle keeps (GLB kit)
// - Fog + lighting for atmosphere

export class ThreeScene {
  constructor() {
    this.scene = null;
    this.camera = null;
    this.renderer = null;
    this.controls = null;
    this.terrain = null;
    this.water = null;              // deep-sea plane: MeshStandardMaterial + scrolling normal map (no transmission, no mirror pass)
    this.sky = null;                // three.js official Sky (Preetham model)
    this.sun = new THREE.Vector3();
    this.flyBody = null;            // instanced drosophila bodies (striped, wealth-tinted)
    this.flyEye = null;             // instanced red eyes (two per fly)
    this.flyWingL = null; this.flyWingR = null;   // instanced translucent flapping wings
    this._m4 = new THREE.Matrix4(); this._m5 = new THREE.Matrix4();
    this._eyeL = new THREE.Matrix4().makeTranslation(0.92, 0.06, 0.24);
    this._eyeR = new THREE.Matrix4().makeTranslation(0.92, 0.06, -0.24);
    this._hingeL = new THREE.Matrix4().makeTranslation(0.42, 0.30, 0.16);
    this._hingeR = new THREE.Matrix4().makeTranslation(0.42, 0.30, -0.16);
    this._hGrid = null; this._hN = 0; this._hStepX = 1; this._hStepZ = 1;   // height field for terrain sampling
    this._hBase = null;         // task 22: the PRISTINE noise field, before the build terraces are pressed in
    this._WSX = 720; this._WSZ = 450;   // task 18: continent enlarged 480×300 → 720×450 (+50%)
    this._pickA = []; this._pickB = [];   // task 22 B4: preallocated pick candidate lists (never `new` per click)
    this._ramp = null;
    this._dummy = new THREE.Object3D();
    this._color = new THREE.Color();
    // task 18: per-frame scratch containers — allocated once, never re-created inside update()
    this._ownerMap = new Map(); this._ownerPairs = []; this._rankArr = []; this._flyArr = [];
    this._flyCount = 0;                            // task 20⑤: live fly instance count (for picking)
    this._meshList = []; this._faithSeen = new Set(); this._terrParts = [];
    this.nationBorderGroup = null;  // nations border mesh group (mounted by _applyNations — task 6)
    this.villageGroup = new THREE.Group();   // KayKit village buildings (task 6, _rebuildVillages)
    this._villageSig = "";
    this._castleLib = {};           // name → { geometry, material } GLB kit cache (task 6)
    this._castleLibLoading = false;
    this._castleLibReady = false;
    this._nationData = null;        // last updateNations() result { nationSeeds, voronoi, … }
    this._nationSig = "";           // applied partition signature — rebuild only on change
    this._terrSig = "";             // territory signature (zone owners + top-5 house rank)
    this.clock = new THREE.Clock();
    // ---- task 7: pre-allocated pools for the ported 2D layers (built in _initOverlays) ----
    this._socLineCap = 64;                     // max bond/feud segments on the social web
    this._socLines = null; this._socGrudge = null;
    this._graveGroup = null; this._graveSprites = []; this._graveSig = "";   // necropolis (one Sprite per stone)
    this._payPool = [];                        // 20 pre-built gold payment arcs (tube + comet head)
    this._parts = []; this._partMesh = null; this._partCursor = 0;   // 200 instanced chron-fx particles
    this._fxRings = []; this._ringCursor = 0;  // 8 pooled expanding rings (law/holy/coin shockwaves)
    this._meshLines = null; this._meshLineCap = 2000;   // murmuration mesh (LineSegments, drawRange)
    this._faithGroup = null; this._prophetSprites = []; this._holySprites = [];
    this._auraMesh = null;                     // swarm neural aura (one breathing sphere)
    this._shardRings = []; this._shardGuide = null;
    this._graveHits = [];                      // task 20②: invisible ×3 hit proxies, one per necropolis sprite
    this._eraHudEl = null; this._eraSig = "";  // task 20⑥: era label is a fixed DOM HUD, not a camera-riding Sprite
    this._legendEl = null; this._legendSig = ""; this._legendT = -1e9;   // territory legend DOM
    this._raycaster = null; this._ndc = null; this._downX = 0; this._downY = 0;
    this._fwd = new THREE.Vector3(); this._v1 = new THREE.Vector3();
    this._fxSeen = new WeakSet();              // chronFx entries already turned into particles
    this.clock = new THREE.Clock();
    this._init();
  }

  // 4-step crisp toon ramp shared by every material — the clean light bands the first pass lacked
  _toonRamp() {
    if (this._ramp) return this._ramp;
    const v = [110, 152, 205, 255];
    const data = new Uint8Array(16);
    for (let i = 0; i < 4; i++) { data[i * 4] = v[i]; data[i * 4 + 1] = v[i]; data[i * 4 + 2] = v[i]; data[i * 4 + 3] = 255; }
    const tex = new THREE.DataTexture(data, 4, 1, THREE.RGBAFormat);
    tex.minFilter = THREE.NearestFilter; tex.magFilter = THREE.NearestFilter;
    tex.needsUpdate = true;
    this._ramp = tex;
    return tex;
  }
  _toon(color, extra) {
    return new THREE.MeshToonMaterial(Object.assign({ color, gradientMap: this._toonRamp() }, extra || {}));
  }

  _init() {
    this.scene = new THREE.Scene();
    this.scene.fog = new THREE.FogExp2(0xdfe8ef, 0.0010);   // faint haze so the horizon melts into the sky (denser: the world rect grew 1.5×)

    // H1: ThreeScene is constructed in boot() BEFORE resize() runs, so state.VW/state.VH are still
    // their 0 init here. Seed them from the viewport so the camera aspect (VW/VH), renderer.setSize
    // and _buildTerrain's zone-anchor projection (÷ VW/VH) never divide by zero → NaN geometry.
    // resize() re-affirms these exact values on the very next line of boot().
    if (!state.VW || !state.VH) {
      state.VW = window.innerWidth || document.documentElement.clientWidth || 1280;
      state.VH = window.innerHeight || document.documentElement.clientHeight || 720;
    }
    const aspect = state.VW / state.VH;
    this.camera = new THREE.PerspectiveCamera(50, aspect, 0.5, 12000);
    this.camera.position.set(0, 320, 440);      // the whole (enlarged) landmass framed edge-to-edge, sea only a margin

    this.renderer = new THREE.WebGLRenderer({ canvas: document.getElementById('field'), antialias: true, alpha: true });
    this.renderer.setSize(state.VW, state.VH);
    // task 18: full-bleed fill is the main per-frame cost — cap the backing-store resolution
    // (desktop ≤1.5, small-screen/mobile ≤1.25) instead of the old devicePixelRatio cap of 2.
    this._dprCap = state.VW < 768 ? 1.25 : 1.5;
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, this._dprCap));
    this.renderer.setClearColor(0x000000, 0);
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 0.8;

    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.06;
    this.controls.maxPolarAngle = Math.PI / 2.15;   // never dip below the sea plane
    this.controls.minDistance = 60;
    this.controls.maxDistance = 1500;               // task 18: the enlarged continent must stay fully frameable
    this.controls.target.set(0, 4, 0);
    this.controls.autoRotate = true;          // slow turntable until the reader touches the model
    this.controls.autoRotateSpeed = 0.3;
    this.controls.addEventListener("start", () => { this.controls.autoRotate = false; });

    // Sun-aligned key light + sky/ground bounce — the official ocean example's lighting recipe
    this.hemiLight = new THREE.HemisphereLight(0xbfd9ec, 0xc9b18c, 0.5);
    this.scene.add(this.hemiLight);
    this.sunLight = new THREE.DirectionalLight(0xfff0d6, 1.5);
    this.scene.add(this.sunLight);
    this.castleGroup = new THREE.Group();
    this.scene.add(this.castleGroup);

    // C2: isolate each build step in its own try/catch. The WebGLRenderer above has already claimed the
    // #field canvas, so a throw anywhere in this sequence can no longer fall back to 2D — without isolation
    // one failing step (e.g. a missing asset) would abort the rest and leave a blank scene. Now every step
    // that succeeds still renders; a failure is logged and skipped.
    // task 18: rivers / forest / grass / procedural mud-brick settlements all REMOVED —
    // the user read them as "莫名其妙的方块", they crowded the continent and the river +
    // sea transmission materials were the last hidden extra-render cost. The land now
    // carries only: terrain, nation borders, KayKit villages, Kenney castles, flies, overlays.
    const steps = [
      [this._buildSky, 'sky'],
      [this._buildWater, 'water'],
      [this._buildTerrain, 'terrain'],
      [this._buildLabels, 'labels'],
      [this._buildFlies, 'flies'],
      [() => this.scene.add(this.villageGroup), 'villageGroup'],
      [this._loadCastleAssets, 'castles'],   // GLB kit loads async → _rebuildCastles() once ready (task 6)
      [this._initOverlays, 'overlays'],       // task 7: pre-allocate every ported 2D layer (social web, necropolis, payments, …)
    ];
    for (const [fn, name] of steps) {
      try { fn.call(this); } catch (e) { console.warn('[scene3d] step failed:', name, e); }
    }
  }

  // ---- sky: three.js official Sky addon (Preetham model, the webgl_shaders_sky example recipe) ----
  _buildSky() {
    const sky = new Sky();
    sky.scale.setScalar(45000);
    this.scene.add(sky);
    const u = sky.material.uniforms;
    u["turbidity"].value = 5;
    u["rayleigh"].value = 2.2;
    u["mieCoefficient"].value = 0.004;
    u["mieDirectionalG"].value = 0.85;
    const elevation = 34, azimuth = 122;
    const phi = THREE.MathUtils.degToRad(90 - elevation);
    const theta = THREE.MathUtils.degToRad(azimuth);
    this.sun.setFromSphericalCoords(1, phi, theta);
    u["sunPosition"].value.copy(this.sun);
    this.sunLight.position.copy(this.sun).multiplyScalar(1000);
    // PMREM bake of the sky → scene.environment: the MeshStandardMaterial sea takes its
    // sheen from this (the webgl_shaders_ocean recipe). fromScene detaches the sky, so re-add it.
    const pmrem = new THREE.PMREMGenerator(this.renderer);
    const envScene = new THREE.Scene();
    envScene.add(sky);
    const envRT = pmrem.fromScene(envScene);
    this.scene.add(sky);
    this.scene.environment = envRT.texture;
    pmrem.dispose();
  }

  // ---- sea: task 18 P0 — one MeshStandardMaterial plane. The Water addon's mirror pass was
  // already gone, but MeshPhysicalMaterial with transmission>0 still triggers Three.js's extra
  // transmission render pass (frameMsAvg stayed 36–40ms after the Water removal). Standard
  // material + scene.environment (the PMREM sky) + a scrolling normal map keeps the living
  // glitter at ZERO extra passes: transmission is not a Standard property, clearcoat is gone. ----
  _buildWater() {
    const geo = new THREE.PlaneGeometry(2600, 2600, 1, 1);   // covers the enlarged 720×450 world even at maxDistance 1500
    const normals = new THREE.TextureLoader().load("./assets/waternormals.jpg", (t) => {
      t.wrapS = t.wrapT = THREE.RepeatWrapping;
      t.repeat.set(16, 16);
    });
    normals.wrapS = normals.wrapT = THREE.RepeatWrapping;   // sane wrap/repeat even before the texture streams in
    normals.repeat.set(16, 16);
    const mat = new THREE.MeshStandardMaterial({
      color: 0x2e7186,             // deep blue-green, a touch lighter than the old 0x1a5060 so it never reads as a dead slab
      transparent: true,
      opacity: 0.85,
      roughness: 0.22,             // crisp sun glitter from scene.environment without mirror sharpness
      metalness: 0.08,
      envMapIntensity: 1.1,        // the PMREM sky supplies the sheen the transmission pass used to fake
      normalMap: normals,
      normalScale: new THREE.Vector2(0.5, 0.5),   // gentle ripple relief, not a storm
      side: THREE.DoubleSide,
    });
    this.water = new THREE.Mesh(geo, mat);
    this.water.rotation.x = -Math.PI / 2;
    this.water.position.y = -1.1;
    this.scene.add(this.water);
  }

  // ---- the land: a model piece with a readable coastline, cliff sides and crisp painted height bands ----
  _buildTerrain() {
    const WSX = 720, WSZ = 450, N = 321;   // task 18: continent enlarged 480×300 → 720×450 (+50%) — same vertex count, open land instead of crowded clutter
    this._WSX = WSX; this._WSZ = WSZ;
    const geo = new THREE.PlaneGeometry(WSX, WSZ, N - 1, N - 1);

    // three.js official ImprovedNoise (Perlin) — the exact noise of the webgl_terrain example
    const perlin = new ImprovedNoise();
    const fbm = (x, z, s) => {
      let v = 0, amp = 1, freq = 1;
      for (let o = 0; o < 4; o++) { v += perlin.noise(x * freq + s, 31.7, z * freq - s) * amp; amp *= 0.5; freq *= 2.07; }
      return v / 1.875;                       // ≈ [-1, 1]
    };
    const ridge = (x, z) => 1 - Math.abs(perlin.noise(x, 7.3, z));   // ridged noise → sharp mountain crests
    const inContinent = (nx0, nz0) => {
      // stretch the coastline polygon until the continent fills the whole world rectangle —
      // the sea survives only as a thin margin, this is a landmass, not an island dot
      const nx = (nx0 - 0.5) * 0.66 + 0.5, nz = (nz0 - 0.5) * 0.84 + 0.5;
      if (nx < 0.14 || nx > 0.76 || nz < 0.09 || nz > 0.91) return false;
      let inside = false;
      for (let i = 0, j = CONTINENT.length - 1; i < CONTINENT.length; j = i++) {
        const xi = CONTINENT[i][0], zi = CONTINENT[i][1];
        const xj = CONTINENT[j][0], zj = CONTINENT[j][1];
        if ((zi > nz) !== (zj > nz) && nx < (xj - xi) * (nz - zi) / (zj - zi) + xi) inside = !inside;
      }
      return inside;
    };

    // raw height field: a land plateau inside the coastline, seabed outside
    const raw = new Float32Array(N * N);
    for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) {
      const x = -WSX / 2 + (i / (N - 1)) * WSX;
      const z = -WSZ / 2 + (j / (N - 1)) * WSZ;
      const inside = inContinent((x + WSX / 2) / WSX, (z + WSZ / 2) / WSZ);
      if (!inside) { raw[j * N + i] = -5.7; continue; }
      const plains = (fbm(x * 0.0071 + 11.3, z * 0.0071 - 4.1, 0) + 0.55) * 5.7;   // rolling lowland
      const rm = Math.max(0, ridge(x * 0.0094 + 9.2, z * 0.0094 - 3.7) - 0.52);    // crest mask
      const range = 0.35 + 0.65 * (0.5 + 0.5 * fbm(x * 0.0033, z * 0.0033, 77));   // where the ranges live
      raw[j * N + i] = 2.9 + plains + rm * rm * 78 * range;                       // peaks up to ~30
    }
    // two blur passes: the 0/1 coastline becomes a steep cliff band (readable shore, no jaggies)
    let h = raw.slice();
    for (let p = 0; p < 2; p++) {
      const out = h.slice();
      for (let j = 1; j < N - 1; j++) for (let i = 1; i < N - 1; i++) {
        const c = h[j * N + i];
        out[j * N + i] = c * 0.36 +
          (h[j * N + i + 1] + h[j * N + i - 1] + h[(j + 1) * N + i] + h[(j - 1) * N + i]) * 0.11 +
          (h[(j - 1) * N + i + 1] + h[(j - 1) * N + i - 1] + h[(j + 1) * N + i + 1] + h[(j + 1) * N + i - 1]) * 0.05;
      }
      h = out;
    }
    this._hGrid = h; this._hN = N; this._hStepX = WSX / (N - 1); this._hStepZ = WSZ / (N - 1);
    this._hBase = h.slice();   // task 22: keep an untouched copy — _sculptTerrain() always re-cuts
    //                            the terraces from this, so a dynasty reshuffle can never grind the
    //                            land progressively flatter.

    // task 18: the two rivers are gone (user: “两条河太丑”). Their valley carving ran an
    // O(N²·82) distance sweep at build time and fed _colorTerrain / forest / grass placement —
    // all removed with them.
    this._noise = perlin;

    // territory cells: every vertex belongs to its nearest zone anchor (the same 4×4 grid the
    // 2D dominion map and the settlement anchors use) — conquests recolour the land itself
    const anchors = [];
    for (let z = 0; z < 16; z++) {
      const za = zoneAnchor(z);
      anchors.push([(za.x / state.VW - 0.5) * WSX, (za.y / state.VH - 0.5) * WSZ]);
    }
    const vZone = new Int16Array(N * N);
    for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) {
      const x = -WSX / 2 + (i / (N - 1)) * WSX, zc = -WSZ / 2 + (j / (N - 1)) * WSZ;
      let best = 0, bd = 1e18;
      for (let a = 0; a < anchors.length; a++) {
        const dx = x - anchors[a][0], dz = zc - anchors[a][1];
        const dd = dx * dx + dz * dz;
        if (dd < bd) { bd = dd; best = a; }
      }
      vZone[j * N + i] = best;
    }
    this._vZone = vZone;

    const pos = geo.attributes.position;
    for (let k = 0; k < pos.count; k++) pos.setZ(k, h[k]);   // plane local Z becomes world Y after the -90° X rotation
    geo.computeVertexNormals();

    this.terrain = new THREE.Mesh(geo, this._toon(0xffffff, { vertexColors: true }));
    this.terrain.rotation.x = -Math.PI / 2;
    this.scene.add(this.terrain);
    // nations partition hook (task 6): five-nation Voronoi, ground border ribbons and the nation
    // castles. update() re-runs it whenever the dynasty signature changes.
    this._applyNations();
    this._colorTerrain(null);
  }

  // (re)run the five-nation partition off the live dynasty data (task 6): seeds → Voronoi →
  // per-vertex nation ids → ground border ribbons → the five castle capitals. Rebuilds only
  // when the partition signature actually changes; repainting the terrain is the caller's job.
  _applyNations() {
    const nat = updateNations(state.econDynasty, this._WSX, this._WSZ);
    this._nationData = nat;
    const sig = (nat && nat.sig) || "";
    if (sig === this._nationSig) return;   // partition unchanged → keep borders + castles

    // task 22: cut the build terraces BEFORE anything samples the relief — the border ribbons below
    // and the castle/village grounding both read heightAt(), so sculpting last would leave them
    // floating over freshly flattened mesas.
    this._sculptTerrain(nat);

    const pos = this.terrain && this.terrain.geometry ? this.terrain.geometry.attributes.position : null;
    if (pos) assignNationIds(pos, pos.count, nat && nat.voronoi ? nat.voronoi : null);

    if (this.nationBorderGroup) {
      this.scene.remove(this.nationBorderGroup);
      this.nationBorderGroup.traverse((o) => { if (o.geometry) o.geometry.dispose(); if (o.material) o.material.dispose(); });
      this.nationBorderGroup = null;
    }
    if (nat && nat.voronoi) {
      this.nationBorderGroup = buildBorderMesh(nat.voronoi, (x, z) => this.heightAt(x, z), this._WSX, this._WSZ);
      this.scene.add(this.nationBorderGroup);
    }
    this._rebuildCastles();
    this._nationSig = sig;   // mark applied only after the full rebuild: a throw above leaves it unset so the next frame retries
  }

  // ---- the painted land: height bands + slope rock (rivers removed — task 18), then the dominion overlay —
  // house tints and border lines straight from econDynasty.zoneOwners, the same authority the
  // 2D dominion map obeys. Repainted only when the ownership signature changes. ----
  _colorTerrain(owners) {
    const N = this._hN, h = this._hGrid, vZone = this._vZone;
    const geo = this.terrain.geometry;
    const pos = geo.attributes.position;
    let colors = geo.attributes.color;
    if (!colors) {
      colors = new THREE.BufferAttribute(new Float32Array(pos.count * 3), 3);
      geo.setAttribute("color", colors);
    }
    const arr = colors.array;
    const stX = this._hStepX, stZ = this._hStepZ;
    const pn = this._noise;
    const perlinJit = (i, j) => pn.noise(i * 0.31, 5.1, j * 0.31);
    const mottleN = (i, j) => pn.noise(i * 0.13, 9.4, j * 0.13) + 1;
    // task 5 colour ramp — smooth interpolation between stops (no hard band edges), with a golden
    // sand ring around the waterline: wet gold nearest the water → dry gold → blend into grass.
    // Then grass lowland → dark meadow → ochre foothills → grey bare rock → snow caps.
    const RAMP = [
      [-5.70, [0.13, 0.28, 0.36]],   // deep seabed
      [-1.30, [0.16, 0.32, 0.40]],   // seabed shelf
      [-0.45, [0.80, 0.66, 0.37]],   // wet golden sand — the ring closest to the waterline
      [ 0.60, [0.91, 0.82, 0.60]],   // dry golden sand ring
      [ 2.80, [0.54, 0.65, 0.34]],   // sand → grass blend
      [ 7.00, [0.44, 0.62, 0.30]],   // grass lowland — the kingdom's green
      [10.60, [0.34, 0.51, 0.26]],   // dark meadow / forest floor
      [14.50, [0.57, 0.48, 0.30]],   // ochre foothill scrub
      [19.40, [0.50, 0.45, 0.41]],   // grey bare mountain rock
      [24.00, [0.96, 0.97, 0.98]],   // snow caps
    ];
    const band = (y) => {
      if (y <= RAMP[0][0]) return RAMP[0][1];
      for (let s = 1; s < RAMP.length; s++) {
        if (y < RAMP[s][0]) {
          const h0 = RAMP[s - 1][0], c0 = RAMP[s - 1][1], h1 = RAMP[s][0], c1 = RAMP[s][1];
          const t = (y - h0) / (h1 - h0);
          return [c0[0] + (c1[0] - c0[0]) * t, c0[1] + (c1[1] - c0[1]) * t, c0[2] + (c1[2] - c0[2]) * t];
        }
      }
      return RAMP[RAMP.length - 1][1];
    };
    for (let k = 0; k < pos.count; k++) {
      const y = h[k];
      let c;
      {
        const i = k % N, j = (k / N) | 0;
        const jit = perlinJit(i, j) * 0.88;   // dither the band edges — stronger now: the ramp interpolates smoothly, the jitter keeps the transitions from reading as contour lines
        c = band(y + jit);
        if (i > 0 && i < N - 1 && j > 0 && j < N - 1) {
          const gx = (h[j * N + i + 1] - h[j * N + i - 1]) / (2 * stX);
          const gz = (h[(j + 1) * N + i] - h[(j - 1) * N + i]) / (2 * stZ);
          if (Math.hypot(gx, gz) > 0.6 && y > 0.9) c = [0.47, 0.42, 0.38];   // steep slopes read as bare rock
        }
        const m = 0.96 + 0.05 * mottleN(i, j);  // mottle so plains aren't flat paint
        c = [c[0] * m, c[1] * m, c[2] * m];
        // dominion overlay: tint each zone toward its holding house, line the borders
        const z = vZone[k];
        if (owners && z >= 0) {
          const o = owners.get(z);
          if (o) {
            const hc = houseColor(o.name);
            if (hc) c = [c[0] * 0.72 + (hc[0] / 255) * 0.28, c[1] * 0.72 + (hc[1] / 255) * 0.28, c[2] * 0.72 + (hc[2] / 255) * 0.28];
          }
          if (i > 0 && i < N - 1 && j > 0 && j < N - 1 &&
              (vZone[k + 1] !== z || vZone[k - 1] !== z || vZone[k + N] !== z || vZone[k - N] !== z)) {
            c = [c[0] * 0.55, c[1] * 0.52, c[2] * 0.50];   // border line between zones
          }
        }
        // five-nation tint (task 6): blend the biome colour toward the holding nation's colour
        c = getNationTint(c, getNationId(k));
      }
      arr[k * 3] = c[0]; arr[k * 3 + 1] = c[1]; arr[k * 3 + 2] = c[2];
    }
    colors.needsUpdate = true;
  }

  // bilinear sample of the baked height field (flies ride the relief, settlements sit on the land)
  heightAt(x, z) { return this._sampleH(this._hGrid, x, z); }

  // task 22: the sampler is shared so _sculptTerrain() can read the PRISTINE _hBase while
  // heightAt() keeps reading the live (terraced) grid.
  _sampleH(g, x, z) {
    if (!g) return 0;
    const N = this._hN;
    const u = Math.max(0, Math.min(N - 1.001, (x + this._WSX / 2) / this._hStepX));
    const v = Math.max(0, Math.min(N - 1.001, (z + this._WSZ / 2) / this._hStepZ));
    const i0 = u | 0, j0 = v | 0, fu = u - i0, fv = v - j0;
    const i1 = Math.min(N - 1, i0 + 1), j1 = Math.min(N - 1, j0 + 1);
    const a = g[j0 * N + i0], b = g[j0 * N + i1], c = g[j1 * N + i0], d = g[j1 * N + i1];
    const top = a + (b - a) * fu, bot = c + (d - c) * fu;
    return top + (bot - top) * fv;
  }

  // task 22 — THE grounding rule for anything that sits on the land. Every kit piece used to be
  // parked on a SINGLE heightAt() sample at its centre, so any relief inside its own footprint (a
  // ridge, a slope, a terrace lip) punched straight up through walls, roofs, headstones and fly
  // bellies — that is the "地形会遮盖建筑" report. Sample a 5×5 grid spanning ±r and take the MAX:
  // the object's floor then clears every point it covers. Callers add their own embed/lift on top.
  // A seabed spot still returns its negative height, so the existing "walk inland" guards survive.
  groundY(x, z, r) {
    const s = r > 0 ? r : 4;
    let m = this.heightAt(x, z);
    for (let i = 0; i < 5; i++) {
      const ox = -s + i * (s * 0.5);        // −s, −s/2, 0, +s/2, +s
      for (let j = 0; j < 5; j++) {
        const y = this.heightAt(x + ox, z - s + j * (s * 0.5));
        if (y > m) m = y;
      }
    }
    return m;
  }

  // task 22 — highest ground ALONG a span. A straight segment whose ends each ride their own
  // ground height still buries itself mid-span wherever a ridge runs between the two endpoints
  // (social threads, feud rifts, murmuration mesh, payment arcs). Both ends are lifted onto this
  // crest instead, so the whole segment clears the relief.
  spanY(ax, az, bx, bz, steps) {
    const n = steps > 0 ? steps : 8;
    let m = 0;
    for (let i = 0; i <= n; i++) {
      const t = i / n;
      const y = this.heightAt(ax + (bx - ax) * t, az + (bz - az) * t);
      if (y > m) m = y;
    }
    return m;
  }

  // ---- task 22: BUILD TERRACES. The land gets sculpted rather than the buildings getting taller
  // plinths: a smoothstep plateau is pressed into the height field around every settlement anchor
  // (the 16 zone anchors the KayKit village rings orbit) and every nation capital seed (the Kenney
  // keep + curtain wall + drawbridge). That yields the tabletop-sandbox read — a dressed stone
  // terrace in a mountain country — and it is the ONLY fix that also clears the courtyard: the old
  // min-of-a-ring grounding sank the plinth into every dip and left each ridge INSIDE the walls
  // free to rise up through the keep. Always re-cut from _hBase, so it is idempotent. A terrace
  // whose centre is under the waterline is skipped — we never raise artificial islands. ----
  _sculptTerrain(nat) {
    const base = this._hBase, h = this._hGrid;
    if (!base || !h || !this.terrain || !this.terrain.geometry) return;
    const N = this._hN, WSX = this._WSX, WSZ = this._WSZ;
    const stX = this._hStepX, stZ = this._hStepZ;
    h.set(base);
    const LAND = 0.2;      // below this the vertex is seabed/surf and must not be dragged up

    const press = (cx, cz, rIn, rOut) => {
      if (!isFinite(cx) || !isFinite(cz)) return;           // a NaN seed must never poison the grid
      if (this._sampleH(base, cx, cz) < LAND) return;      // a capital/anchor at sea → leave the coast alone
      // mesa top = the mean base height over the flat core (a mesa reads far better than a spike cut)
      let sum = this._sampleH(base, cx, cz), cnt = 1;
      for (let a = 0; a < 8; a++) {
        const ang = (a / 8) * Math.PI * 2, ca = Math.cos(ang), sa = Math.sin(ang);
        sum += this._sampleH(base, cx + ca * rIn * 0.66, cz + sa * rIn * 0.66);
        sum += this._sampleH(base, cx + ca * rIn, cz + sa * rIn);
        cnt += 2;
      }
      const ty = Math.max(1.4, sum / cnt);   // never below the wet-sand band, never in the surf
      const i0 = Math.max(0, Math.floor((cx - rOut + WSX / 2) / stX));
      const i1 = Math.min(N - 1, Math.ceil((cx + rOut + WSX / 2) / stX));
      const j0 = Math.max(0, Math.floor((cz - rOut + WSZ / 2) / stZ));
      const j1 = Math.min(N - 1, Math.ceil((cz + rOut + WSZ / 2) / stZ));
      for (let j = j0; j <= j1; j++) {
        const dz = -WSZ / 2 + j * stZ - cz;
        for (let i = i0; i <= i1; i++) {
          const k = j * N + i;
          if (base[k] < LAND) continue;                     // the shoreline is the terrace's natural stop
          const dx = -WSX / 2 + i * stX - cx;
          const d = Math.sqrt(dx * dx + dz * dz);
          if (d > rOut) continue;
          let w = 1;
          if (d > rIn) { const t = (d - rIn) / (rOut - rIn); w = 1 - t * t * (3 - 2 * t); }   // smoothstep
          h[k] += (ty - h[k]) * w;
        }
      }
    };

    // ① the 16 zone anchors — a city's building ring runs out to ≈33 units, town rings to ≈18
    const VW = state.VW || 1280, VH = state.VH || 720;
    for (let z = 0; z < 16; z++) {
      const za = zoneAnchor(z);
      press((za.x / VW - 0.5) * WSX, (za.y / VH - 0.5) * WSZ, 26, 40);
    }
    // ② the nation capitals — plinth 19.7 + drawbridge ≈26 units out at S=4.8
    const seeds = nat && Array.isArray(nat.nationSeeds) ? nat.nationSeeds : null;
    if (seeds) for (const s of seeds) if (s && isFinite(s.x) && isFinite(s.z)) press(s.x, s.z, 24, 36);

    // commit: geometry Z (plane-local Z becomes world Y after the −90° X rotation), then the
    // normals the toon ramp reads and the sphere the frustum culls with.
    const pos = this.terrain.geometry.attributes.position;
    const cnt = Math.min(pos.count, h.length);
    for (let k = 0; k < cnt; k++) pos.setZ(k, h[k]);
    pos.needsUpdate = true;
    this.terrain.geometry.computeVertexNormals();
    this.terrain.geometry.computeBoundingSphere();
  }

  // task 18: _riverZ + _buildRivers removed with the rivers (user: “两条河太丑，可以不要”).
  // The valley carving in _buildTerrain is gone too — no channel, no ribbon, no MeshPhysicalMaterial.

  // ---- flies: procedural drosophila. Striped abdomen + thorax + head merged into one
  // vertex-coloured geometry, instanced once for the whole swarm and tinted per fly by the
  // wealth ramp; instanced red eyes and translucent flapping wings ride the same base
  // matrix. Four draw calls for the entire swarm. ----
  _buildFlies() {
    const flat = (geo, col) => {
      const n = geo.attributes.position.count;
      const arr = new Float32Array(n * 3);
      for (let i = 0; i < n; i++) { arr[i * 3] = col[0]; arr[i * 3 + 1] = col[1]; arr[i * 3 + 2] = col[2]; }
      geo.setAttribute("color", new THREE.BufferAttribute(arr, 3));
      return geo;
    };
    // abdomen: ellipsoid with the melanogaster banding baked in as vertex colours
    const abd = new THREE.SphereGeometry(0.5, 14, 10);
    abd.scale(1.5, 0.62, 0.55); abd.translate(-0.45, 0, 0);
    const pa = abd.attributes.position, ca = new Float32Array(pa.count * 3);
    for (let i = 0; i < pa.count; i++) {
      const stripe = Math.sin((pa.getX(i) + 1.2) * 7.5) > 0.2;
      const col = stripe ? [0.34, 0.21, 0.10] : [0.85, 0.62, 0.30];
      ca[i * 3] = col[0]; ca[i * 3 + 1] = col[1]; ca[i * 3 + 2] = col[2];
    }
    abd.setAttribute("color", new THREE.BufferAttribute(ca, 3));
    const thorax = flat(new THREE.SphereGeometry(0.44, 12, 10), [0.46, 0.33, 0.19]);
    thorax.translate(0.42, 0.06, 0);
    const head = flat(new THREE.SphereGeometry(0.30, 12, 10), [0.31, 0.21, 0.12]);
    head.translate(0.92, 0.02, 0);
    const bodyGeo = mergeGeometries([abd, thorax, head], false);
    this.flyBody = new THREE.InstancedMesh(bodyGeo,
      new THREE.MeshToonMaterial({ gradientMap: this._toonRamp(), vertexColors: true }), 120);
    this.flyBody.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.flyBody.count = 0;
    // task 20③: instances scatter across the whole 720×450 continent, far beyond the base geometry's
    // tiny origin-centred bounds — exactly like the building InstancedMeshes. Without this the swarm's
    // lazily-cached boundingSphere can frustum-cull EVERY fly at once (the social lines, which set
    // frustumCulled=false, stayed visible at the same coordinates — the tell that culling was the bug).
    this.flyBody.frustumCulled = false;
    this.scene.add(this.flyBody);

    // eyes: the signature red of drosophila — fixed colour, two instances per fly
    this.flyEye = new THREE.InstancedMesh(new THREE.SphereGeometry(0.16, 8, 8), this._toon(0xc22a1e), 240);
    this.flyEye.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.flyEye.count = 0;
    this.flyEye.frustumCulled = false;   // task 20③
    this.scene.add(this.flyEye);

    // wings: narrow translucent blades, hinge at the origin, swept back; mirrored per side
    const mkWing = (side) => {
      const g = new THREE.CircleGeometry(0.5, 14);
      g.rotateX(-Math.PI / 2);
      g.scale(1.9, 1, 0.62);
      g.translate(-0.85, 0, 0);
      g.rotateY(side * 0.55);
      return g;
    };
    const wingMat = new THREE.MeshToonMaterial({ color: 0xf4efe2, gradientMap: this._toonRamp(), transparent: true, opacity: 0.42, side: THREE.DoubleSide, depthWrite: false });
    this.flyWingL = new THREE.InstancedMesh(mkWing(1), wingMat, 120);
    this.flyWingR = new THREE.InstancedMesh(mkWing(-1), wingMat, 120);
    for (const w of [this.flyWingL, this.flyWingR]) {
      w.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      w.count = 0;
      w.frustumCulled = false;   // task 20③
      this.scene.add(w);
    }
  }

  // ---- task 18: _rDistAt / _buildForest / _buildGrass all removed. The 800 merged-geometry
  // trees (~100k verts) and 6000 grass tufts (~108k verts) were the user's prime suspect for
  // both the frame cost and the "block" clutter; the enlarged continent reads as open
  // painted land instead — relief bands, nation tints and borders carry the detail. ----

  // ---- castle kit (task 6): load the Kenney castle + KayKit building GLBs once, merging each
  // part into a single non-indexed geometry (position/normal/uv) cached by name in _castleLib.
  // All castle pieces share one colormap atlas and all buildings share hexagons_medieval —
  // so one cloned material per nation tint group can dress a whole castle. ----
  _loadCastleAssets() {
    if (this._castleLibLoading || this._castleLibReady) return;
    this._castleLibLoading = true;
    const PARTS = [
      "tower-square-base", "tower-square-mid", "tower-square-top", "tower-square-roof",
      "tower-hexagon-base", "tower-hexagon-mid", "tower-hexagon-top", "tower-hexagon-roof",
      "wall", "wall-half", "gate", "metal-gate", "bridge-straight", "flag", "flag-pennant",
      "building_home_A_blue", "building_market_blue", "building_tower_A_blue",
      "building_windmill_blue", "building_well_blue",
    ];
    const loader = new GLTFLoader();
    let left = PARTS.length;
    const done = () => {
      if (--left > 0) return;
      this._castleLibLoading = false;
      this._castleLibReady = true;
      this._villageSig = "";      // let _rebuildVillages() re-evaluate on the next frame
      this._rebuildCastles();     // castles requested before the kit finished loading
    };
    for (const name of PARTS) {
      loader.load("./assets/castles/" + name + ".glb",
        (gltf) => { this._castleLib[name] = this._extractCastlePart(gltf.scene); done(); },
        undefined,
        (err) => { console.warn("[scene3d] castle part failed to load:", name, err); done(); });
    }
  }

  // merge every mesh of one GLB part into a single non-indexed geometry with just
  // position/normal/uv — the kits are single-material single-atlas, so this is lossless
  _extractCastlePart(root) {
    root.updateMatrixWorld(true);
    const geos = [];
    let mat = null;
    root.traverse((o) => {
      if (!o.isMesh || !o.geometry) return;
      if (!mat && o.material) mat = Array.isArray(o.material) ? o.material[0] : o.material;
      const src = o.geometry.index ? o.geometry.toNonIndexed() : o.geometry.clone();
      src.applyMatrix4(o.matrixWorld);
      if (!src.attributes.normal) src.computeVertexNormals();
      const cnt = src.attributes.position.count;
      const g = new THREE.BufferGeometry();
      g.setAttribute("position", src.attributes.position);
      g.setAttribute("normal", src.attributes.normal);
      g.setAttribute("uv", src.attributes.uv || new THREE.BufferAttribute(new Float32Array(cnt * 2), 2));
      geos.push(g);
    });
    if (!geos.length) return { geometry: new THREE.BufferGeometry(), material: mat };
    return { geometry: geos.length === 1 ? geos[0] : mergeGeometries(geos, false), material: mat };
  }

  // ---- the five nation castles (task 18 rework): one grand keep per nation seed, assembled
  // from the Kenney kit on a strict 1-unit grid — a five-storey square citadel, four TALL hex
  // corner towers (base + three mid rings + battlement + spire + pennant), five un-scaled
  // curtain wall segments per side (the old 1.1×/1.3× stretch left gaps at the towers), a
  // timber gate + iron portcullis, a two-span drawbridge and banners. The whole kit merges
  // ONCE into a shared geometry (all five castles instance it); only roofs/banners carry the
  // nation colour — the stonework stays a clean limestone so the castles never read as dirty
  // colour blocks. A two-tier round plinth buries the footprint so nothing floats or clips
  // into sloped terrain. ----
  _rebuildCastles() {
    for (const child of [...this.castleGroup.children]) {
      this.castleGroup.remove(child);
      // per-nation roof materials are clones; stone geo/mat + plinth are shared caches released in dispose()
      child.traverse((o) => { if (o.material && o.material !== this._castleStoneMat && o.material !== this._plinthMat) o.material.dispose(); });
    }
    const lib = this._castleLib;
    const nat = this._nationData;
    if (!this._castleLibReady || !nat || !Array.isArray(nat.nationSeeds) || !nat.nationSeeds.length) return;
    const srcMat = lib["tower-square-base"] && lib["tower-square-base"].material;
    if (!srcMat) return;

    const S = 4.8;              // castle scale: ~30 world units across the walls, ~33 to the banner tip
    const PI2 = Math.PI / 2;

    if (!this._castleStoneGeo || !this._castleStrongGeo) {
      const YAX = new THREE.Vector3(0, 1, 0);
      // local placement transform for one kit instance (position + yaw + scale)
      const at = (x, y, z, ry, sx, sy, sz) => new THREE.Matrix4().compose(
        new THREE.Vector3(x, y, z),
        new THREE.Quaternion().setFromAxisAngle(YAX, ry || 0),
        new THREE.Vector3(sx || 1, sy || 1, sz || 1));
      // merge a set of placed kit instances into one geometry
      const assemble = (parts) => {
        const geos = [];
        for (const p of parts) {
          const rec = lib[p.name];
          if (!rec || !rec.geometry || !rec.geometry.attributes.position) continue;
          const g = rec.geometry.clone();
          g.applyMatrix4(p.m);
          geos.push(g);
        }
        return geos.length ? mergeGeometries(geos, false) : null;
      };

      // castle plan in kit units (wall pitch 1.0, corner towers at ±2.5, gate on +z):
      // the keep stacks base + two mid rings + battlement + spire + flag (top ≈ 5.2);
      // corner towers stack base + three mid rings + battlement + spire + pennant (top ≈ 4.1).
      const C = 2.5;
      const stone = [];
      const accent = [];   // roofs + banners — the only nation-tinted pieces
      // central keep
      stone.push({ name: "tower-square-base", m: at(0, 0, 0) });
      stone.push({ name: "tower-square-mid", m: at(0, 1.01, 0) });
      stone.push({ name: "tower-square-mid", m: at(0, 2.02, 0) });
      stone.push({ name: "tower-square-top", m: at(0, 3.03, 0) });
      accent.push({ name: "tower-square-roof", m: at(0, 3.33, 0) });
      accent.push({ name: "flag", m: at(0, 5.2, 0, PI2) });
      // four corner towers
      for (const cx of [-C, C]) for (const cz of [-C, C]) {
        stone.push({ name: "tower-hexagon-base", m: at(cx, 0, cz) });
        stone.push({ name: "tower-hexagon-mid", m: at(cx, 1.31, cz) });
        stone.push({ name: "tower-hexagon-mid", m: at(cx, 1.77, cz) });
        stone.push({ name: "tower-hexagon-mid", m: at(cx, 2.23, cz) });
        stone.push({ name: "tower-hexagon-top", m: at(cx, 2.69, cz) });
        accent.push({ name: "tower-hexagon-roof", m: at(cx, 2.82, cz) });
        accent.push({ name: "flag-pennant", m: at(cx, 3.55, cz, PI2) });
      }
      // curtain walls — five full 1-unit segments per side, ends meeting the corner towers
      for (const t of [-2, -1, 0, 1, 2]) {
        stone.push({ name: "wall", m: at(t, 0, -C) });         // north run
        stone.push({ name: "wall", m: at(C, 0, t, PI2) });     // east run
        stone.push({ name: "wall", m: at(-C, 0, t, PI2) });    // west run
      }
      for (const t of [-2, -1, 1, 2]) stone.push({ name: "wall", m: at(t, 0, C) });   // south run, gate bay at x=0
      stone.push({ name: "gate", m: at(0, 0, C, PI2) });                  // closed timber gate leaves
      stone.push({ name: "metal-gate", m: at(0, 0.02, C + 0.11, PI2) });  // iron portcullis
      stone.push({ name: "bridge-straight", m: at(0, 0.14, C + 0.97, PI2) });  // drawbridge span 1 (rides the terrace top)
      stone.push({ name: "bridge-straight", m: at(0, 0.14, C + 1.9, PI2) });   // drawbridge span 2

      this._castleStoneGeo = assemble(stone);
      this._castleStrongGeo = assemble(accent);
      if (!this._castleStoneMat) {
        // clean pale limestone — identical for every nation, the tint lives only on roofs/banners
        this._castleStoneMat = srcMat.clone();
        this._castleStoneMat.color.setRGB(1.0, 0.98, 0.93);
        this._plinthMat = this._toon(0xcfc3a8);   // the foundation terrace reads as dressed stone
      }
    }
    if (!this._castleStoneGeo || !this._castleStrongGeo) return;

    // shared two-tier plinth (kit units): the inner disc's top ends 0.25 above the floor line
    // (y=0) — wall/tower bases stand ON the dressed-stone terrace instead of floating or
    // sinking; the outer, deeper tier shoulders into the slope side of the site.
    // Smooth 44-gon drums, not boxes.
    if (!this._plinthGeo) {
      const t1 = new THREE.CylinderGeometry(3.95, 4.1, 1.4, 44);
      t1.translate(0, -1.35, 0);
      const t2 = new THREE.CylinderGeometry(3.35, 3.5, 0.8, 44);
      t2.translate(0, -0.55, 0);
      this._plinthGeo = mergeGeometries([t1.toNonIndexed(), t2.toNonIndexed()], false);
    }

    for (let i = 0; i < nat.nationSeeds.length; i++) {
      const seed = nat.nationSeeds[i];
      const col = nat.nationColors[i] || new THREE.Color(0.7, 0.58, 0.34);
      // task 22 — ground the keep on the HIGHEST point of its own footprint, not the lowest. The
      // old min-of-a-ring sank the plinth into every dip and left each ridge INSIDE the curtain
      // wall free to rise up through the courtyard and the towers. _sculptTerrain() has already
      // pressed a flat mesa under every capital, so this max over the plinth radius (4.1·S ≈ 19.7)
      // is just the mesa top; the −0.95 embed still buries the deep outer tier (kit-local −2.05
      // ≈ −9.8 world) and lands the dressed-stone terrace ≈0.25 above the ground line.
      const baseY = this.groundY(seed.x, seed.z, 4.1 * S) - 0.95;

      const group = new THREE.Group();
      group.position.set(seed.x, baseY, seed.z);
      group.scale.setScalar(S);
      group.add(new THREE.Mesh(this._plinthGeo, this._plinthMat));
      group.add(new THREE.Mesh(this._castleStoneGeo, this._castleStoneMat));
      // roofs + banners in the nation colour (full saturation, no mud-dirty wash)
      const strongMat = srcMat.clone();
      strongMat.color.setRGB(0.35 + 0.65 * col.r, 0.35 + 0.65 * col.g, 0.35 + 0.65 * col.b);
      group.add(new THREE.Mesh(this._castleStrongGeo, strongMat));
      this.castleGroup.add(group);
    }
  }

  // ---- villages (task 6): a KayKit building ring around every town/city settlement, one
  // InstancedMesh per building type (shared geometry + atlas material). Deterministic per-zone
  // layout, rebuilt only when the census signature changes; the ring clears the mud town. ----
  _rebuildVillages(econCities) {
    if (!this._castleLibReady) return;
    const sets = econCities && Array.isArray(econCities.settlements) ? econCities.settlements : null;
    let sig = "";
    if (sets) {
      for (const s of sets) {
        const r = String(s.rank || "").toUpperCase();
        if (r !== "TOWN" && r !== "CITY") continue;
        sig += s.zone + ":" + r + ":" + ((s.pop | 0) >> 4) + ":" + (s.houseName || "") + ",";
      }
    }
    if (sig === this._villageSig) return;
    this._villageSig = sig;

    for (const child of [...this.villageGroup.children]) {
      this.villageGroup.remove(child);
      if (child.isInstancedMesh) child.dispose();   // geometry/material are shared kit resources
    }
    if (!sig || !sets) return;

    const lib = this._castleLib;
    const TYPES = [
      // task 18: the world rect grew 1.5× and the camera sits further back — buildings scale
      // up ~12% to hold their presence, and with the mud-brick town gone the village ring moves
      // in and grows (cities 6+2, towns 4+1) so the continent reads open, not empty.
      { key: "home", name: "building_home_A_blue", sc: 5.0 },
      { key: "windmill", name: "building_windmill_blue", sc: 4.1 },
      { key: "tower", name: "building_tower_A_blue", sc: 4.5 },
      { key: "market", name: "building_market_blue", sc: 3.7 },
      { key: "well", name: "building_well_blue", sc: 4.3 },
    ];
    const buckets = {};
    for (const t of TYPES) buckets[t.key] = [];
    const YAX = new THREE.Vector3(0, 1, 0);
    const put = (kind, x, y, z, sc, yaw) => {
      buckets[kind].push(new THREE.Matrix4().compose(
        new THREE.Vector3(x, y, z),
        new THREE.Quaternion().setFromAxisAngle(YAX, (yaw || 0) * Math.PI * 2),
        new THREE.Vector3(sc, sc, sc)));
    };
    // task 22 — every building is grounded on the MAX of a 5×5 sample spanning its own footprint
    // (±0.8·scale ≈ its half-width) and embedded 0.4, so the terrace lip or any slope can no longer
    // slice through a roof. A plot that lands in the sea is hauled halfway back toward the anchor;
    // if it is still wet the building is dropped rather than built on stilts.
    // (Declared per-zone below: it closes over that zone's wx/wz and its deterministic rnd stream.)
    for (const s of sets) {
      const r = String(s.rank || "").toUpperCase();
      if (r !== "TOWN" && r !== "CITY") continue;
      const za = zoneAnchor(s.zone);
      const wx = (za.x / state.VW - 0.5) * this._WSX;
      const wz = (za.y / state.VH - 0.5) * this._WSZ;
      // deterministic per-zone layout: a rebuild paints the same village again
      let rs = (Math.imul((s.zone | 0) + 1, 2654435761) ^ 0x9e3779b9) >>> 0;
      const rnd = () => { rs = (Math.imul(rs, 1664525) + 1013904223) >>> 0; return rs / 4294967296; };
      const plot = (kind, a, rr, sc) => {
        let bx = wx + Math.cos(a) * rr, bz = wz + Math.sin(a) * rr;
        let gy = this.groundY(bx, bz, sc * 0.8);
        if (gy < 0.2) {
          bx = wx + Math.cos(a) * rr * 0.55; bz = wz + Math.sin(a) * rr * 0.55;
          gy = this.groundY(bx, bz, sc * 0.8);
          if (gy < 0.2) return;
        }
        put(kind, bx, gy - 0.4, bz, sc, rnd());
      };
      const ring = r === "CITY" ? 17 + rnd() * 9 : 12 + rnd() * 6;
      const nB = r === "CITY" ? 6 : 4;   // plus the civic anchors below
      const kinds = ["home", "windmill", "tower", "home"];
      for (let b = 0; b < nB; b++) {
        const a = rnd() * Math.PI * 2;
        const rr = ring + rnd() * 7;
        const kind = kinds[(rnd() * kinds.length) | 0];
        const sc = TYPES.find((t) => t.key === kind).sc * (0.85 + rnd() * 0.3);
        plot(kind, a, rr, sc);
      }
      const nCivic = r === "CITY" ? 2 : 1;
      for (let q = 0; q < nCivic; q++) {
        const civic = rnd() < 0.55 ? "well" : "market";
        const ca = rnd() * Math.PI * 2;
        const cr = Math.max(ring - 5.5, 8) + rnd() * 3;
        const csc = (civic === "well" ? 4.3 : 3.7) * (0.9 + rnd() * 0.2);
        plot(civic, ca, cr, csc);
      }
    }

    for (const t of TYPES) {
      const list = buckets[t.key];
      const rec = lib[t.name];
      if (!list.length || !rec || !rec.geometry.attributes.position || !rec.material) continue;
      const im = new THREE.InstancedMesh(rec.geometry, rec.material, list.length);
      for (let i = 0; i < list.length; i++) im.setMatrixAt(i, list[i]);
      im.instanceMatrix.needsUpdate = true;
      im.frustumCulled = false;   // instances spread far beyond the base geometry bounds
      this.villageGroup.add(im);
    }
  }

  // ---- province names floating over the land — the atlas's own labels ----
  _buildLabels() {
    const mk = (text) => {
      const cv = document.createElement("canvas");
      cv.width = 512; cv.height = 128;
      const c = cv.getContext("2d");
      c.font = "italic 54px Georgia, serif";
      c.textAlign = "center"; c.textBaseline = "middle";
      c.fillStyle = "rgba(58,42,26,0.82)";
      c.fillText(text, 256, 64);
      const tex = new THREE.CanvasTexture(cv);
      const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true, depthWrite: false }));
      sp.scale.set(58, 14.5, 1);
      return sp;
    };
    for (const p of PROVINCES) {
      const x = (p.t[0] - 0.5) * this._WSX, z = (p.t[1] - 0.5) * this._WSZ;
      const sp = mk(p.name);
      // task 22 — the plate is 58 units wide: clear the highest ground anywhere under it, not just
      // the one point it is centred on, or a ridge eats the descenders.
      sp.position.set(x, this.groundY(x, z, 29) + 22, z);
      this.scene.add(sp);
    }
  }

  // =====================================================================================
  // task 7 — the ported 2D visualization layers as pre-allocated 3D pools. The 2D render()
  // returns early in 3D mode, so every canvas-only layer (social web, necropolis, payment
  // arcs, chron-fx, faith, day/night, era banner, aura, ripples, shard rings, legend) is
  // rebuilt here. Every object is allocated ONCE in _initOverlays(); the _update* methods
  // only rewrite buffers / matrices / opacities — never `new`.
  // =====================================================================================
  _initOverlays() {
    // ---- ① social web: alliance lines + grudge dashed lines (LineSegments, drawRange) ----
    const mkSeg = (color, dashed, opacity) => {
      const geo = new THREE.BufferGeometry();
      geo.setAttribute("position", new THREE.BufferAttribute(new Float32Array(this._socLineCap * 2 * 3), 3).setUsage(THREE.DynamicDrawUsage));
      const mat = dashed
        ? new THREE.LineDashedMaterial({ color, dashSize: 9, gapSize: 6.5, transparent: true, opacity, depthWrite: false })
        : new THREE.LineBasicMaterial({ color, transparent: true, opacity, depthWrite: false });
      const line = new THREE.LineSegments(geo, mat);
      line.frustumCulled = false;
      line.renderOrder = 6;
      this.scene.add(line);
      return line;
    };
    this._socLines = mkSeg(0x6a94e0, false, 0.55);    // ① alliance — blue thread (matches the blue alliance particles)
    this._socGrudge = mkSeg(0xc63c2c, true, 0.6);     // ① feud — red dashed rift

    // ---- ② necropolis: one Sprite per stone, GRAVE_CAP slots, canvas texture each ----
    this._graveGroup = new THREE.Group();
    for (let i = 0; i < GRAVE_CAP; i++) {
      const cv = document.createElement("canvas");
      cv.width = 96; cv.height = 128;
      const tex = new THREE.CanvasTexture(cv);
      const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true, depthWrite: false }));
      sp.visible = false;
      sp.scale.set(0, 0, 0);
      this._graveSprites.push(sp);
      this._graveGroup.add(sp);
      // task 20②: an invisible ×3 hit proxy rides each stone — the 7.2×9.6 sprite is a hair-thin
      // target at continent scale, so picking raycasts this fatter billboard instead (three r160
      // raycasts invisible objects; a screen-space fallback in _pickGrave covers the rest).
      const hit = new THREE.Sprite(new THREE.SpriteMaterial({ transparent: true, opacity: 0, depthWrite: false, colorWrite: false }));
      hit.visible = false;
      hit.scale.set(0, 0, 0);
      hit.userData.grave = null;
      this._graveHits.push(hit);
      this._graveGroup.add(hit);
    }
    this.scene.add(this._graveGroup);
    // 3D stone picking — see _onCanvasClick (the click event fires after camera.js's tap)
    this._raycaster = new THREE.Raycaster();
    this._ndc = new THREE.Vector2();
    const cvEl = this.renderer.domElement;
    this._cvEl = cvEl;                                     // kept for dispose(): the listeners must come off again
    this._onDown = (e) => { this._downX = e.clientX; this._downY = e.clientY; };
    this._onClick = (e) => this._onCanvasClick(e);
    cvEl.addEventListener("pointerdown", this._onDown);
    cvEl.addEventListener("click", this._onClick);

    // ---- ③ x402 payment arcs: 20 pooled quad-bezier tubes + comet heads ----
    this._payHeadGeo = new THREE.SphereGeometry(1, 8, 6);
    for (let i = 0; i < 20; i++) {
      const geo = this._makeArcGeometry(12, 6);
      const tMat = new THREE.MeshBasicMaterial({ color: 0xd6b04e, transparent: true, opacity: 0, depthWrite: false });
      const hMat = new THREE.MeshBasicMaterial({ color: 0xffe6a8, transparent: true, opacity: 0, depthWrite: false, blending: THREE.AdditiveBlending });
      const tube = new THREE.Mesh(geo, tMat);
      tube.frustumCulled = false; tube.visible = false; tube.renderOrder = 7;
      const head = new THREE.Mesh(this._payHeadGeo, hMat);
      head.frustumCulled = false; head.visible = false; head.renderOrder = 7;
      this.scene.add(tube, head);
      this._payPool.push({ tube, head, tMat, hMat, active: false });
    }

    // ---- ④ chron-fx: 200 instanced particles (rise / burst / drop) ----
    for (let i = 0; i < 200; i++) this._parts.push({ active: false, x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0, age: 0, dur: 1, s0: 1, s1: 1, r: 1, g: 1, b: 1 });
    this._partMesh = new THREE.InstancedMesh(new THREE.SphereGeometry(0.6, 6, 5),
      new THREE.MeshBasicMaterial({ transparent: true, blending: THREE.AdditiveBlending, depthWrite: false }), 200);
    this._partMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this._partMesh.count = 0; this._partMesh.frustumCulled = false; this._partMesh.renderOrder = 8;
    this.scene.add(this._partMesh);

    // ---- ④b shockwave rings: 8 pooled expanding (or contracting) ground rings ----
    const ringGeo = new THREE.RingGeometry(0.94, 1, 44);
    ringGeo.rotateX(-Math.PI / 2);
    for (let i = 0; i < 8; i++) {
      const mat = new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0, depthWrite: false, side: THREE.DoubleSide });
      const m = new THREE.Mesh(ringGeo, mat);
      m.visible = false; m.frustumCulled = false; m.renderOrder = 5;
      this.scene.add(m);
      this._fxRings.push({ mesh: m, mat, active: false, x: 0, z: 0, age: 0, dur: 1, r0: 1, r1: 1, a0: 0.5 });
    }

    // ---- ⑤ murmuration mesh: LineSegments with drawRange ----
    const mgeo = new THREE.BufferGeometry();
    mgeo.setAttribute("position", new THREE.BufferAttribute(new Float32Array(this._meshLineCap * 2 * 3), 3).setUsage(THREE.DynamicDrawUsage));
    mgeo.setDrawRange(0, 0);
    this._meshLines = new THREE.LineSegments(mgeo, new THREE.LineBasicMaterial({ color: 0x2a2a28, transparent: true, opacity: 0.16, depthWrite: false }));
    this._meshLines.frustumCulled = false; this._meshLines.renderOrder = 5;
    this.scene.add(this._meshLines);

    // ---- ⑥ faith: prophet halos + holy-day candle points (shared gradient textures) ----
    this._faithGroup = new THREE.Group();
    const pTex = this._mkGlowTexture("rgba(255,228,160,0.9)");
    for (let i = 0; i < 8; i++) {
      const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: pTex, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, opacity: 0.75 }));
      sp.visible = false; sp.scale.set(16, 16, 1);
      this._faithGroup.add(sp); this._prophetSprites.push(sp);
    }
    const hTex = this._mkGlowTexture("rgba(255,214,130,0.85)");
    for (let i = 0; i < 12; i++) {
      const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: hTex, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, opacity: 0.5 }));
      sp.visible = false; sp.scale.set(9, 9, 1);
      this._faithGroup.add(sp); this._holySprites.push(sp);
    }
    this.scene.add(this._faithGroup);

    // ---- ⑦ chronicle ambient: REMOVED (task 20①). The totem steles + school/lost-art/coffer
    // plaques read as "莫名其妙的方块" scattered over the terrain. The chronicle drawer (#panel-chron)
    // and the bottom ticker are DOM read-outs and stay — only the map decoration is gone. ----

    // ---- ⑨ era label: task 20⑥ moved it off the camera-riding Sprite (which floated over the
    // terrain and drifted with every orbit) onto a fixed DOM HUD (#era-hud in index.html). We only
    // cache the element here; _updateEraHud() rewrites its text when chronMeta.era/eraName changes.
    this._eraHudEl = document.getElementById("era-hud");

    // ---- ⑩ swarm neural aura: one breathing sphere over the swarm centroid ----
    this._auraMesh = new THREE.Mesh(new THREE.SphereGeometry(1, 20, 14),
      new THREE.MeshBasicMaterial({ color: 0x6a94e0, transparent: true, opacity: 0.06, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.BackSide }));
    this._auraMesh.frustumCulled = false;
    this._auraMesh.visible = false;
    this.scene.add(this._auraMesh);

    // ---- ⑬ pointer ripples: REMOVED (task 20④). The tap stimulus rings are gone; camera.js no
    // longer pushes to state.ripples either. Drag / zoom / tap-select all survive. ----

    // ---- ⑭ shard topology ring: guide circle + up to 32 node rings ----
    const guideGeo = new THREE.TorusGeometry(1, 0.008, 6, 96);
    guideGeo.rotateX(-Math.PI / 2);
    this._shardGuide = new THREE.Mesh(guideGeo, new THREE.MeshBasicMaterial({ color: 0x9aa4b4, transparent: true, opacity: 0, depthWrite: false }));
    this._shardGuide.frustumCulled = false; this._shardGuide.renderOrder = 5;
    this.scene.add(this._shardGuide);
    for (let i = 0; i < 32; i++) {
      const rgeo = new THREE.TorusGeometry(2.2, 0.55, 6, 18);
      rgeo.rotateX(-Math.PI / 2);
      const m = new THREE.Mesh(rgeo, new THREE.MeshBasicMaterial({ color: 0x8b98ad, transparent: true, opacity: 0.35, depthWrite: false }));
      m.visible = false; m.frustumCulled = false; m.renderOrder = 5;
      this.scene.add(m);
      this._shardRings.push(m);
    }

    // ---- ⑪ territory legend DOM (3D mode has no canvas overlay: render2d's render() returns early) ----
    const el = document.createElement("div");
    el.id = "terr-legend-3d";
    el.setAttribute("aria-hidden", "true");
    el.style.cssText = "position:fixed;right:14px;top:50%;transform:translateY(-50%);display:none;z-index:3;" +
      "padding:10px 12px;border:1px solid rgba(96,74,52,0.45);border-radius:6px;background:rgba(248,244,236,0.88);" +
      "font:600 11px Georgia,serif;color:#28201a;pointer-events:none;max-width:210px;line-height:16px;";
    document.body.appendChild(el);
    this._legendEl = el;
  }

  // one shared radial-gradient canvas texture for every glow sprite (prophet halo / candle point)
  _mkGlowTexture(color) {
    const cv = document.createElement("canvas");
    cv.width = cv.height = 128;
    const c = cv.getContext("2d");
    const gr = c.createRadialGradient(64, 64, 0, 64, 64, 64);
    gr.addColorStop(0, color);
    gr.addColorStop(1, "rgba(255,228,160,0)");
    c.fillStyle = gr;
    c.fillRect(0, 0, 128, 128);
    return new THREE.CanvasTexture(cv);
  }

  // a unit arc tube: (SEG+1)×(RAD+1) vertices, rebuilt every frame by _updateArcGeometry
  _makeArcGeometry(SEG, RAD) {
    const verts = (SEG + 1) * (RAD + 1);
    const idx = [];
    for (let i = 0; i < SEG; i++) for (let j = 0; j < RAD; j++) {
      const a = i * (RAD + 1) + j, b = a + RAD + 1;
      idx.push(a, b, a + 1, a + 1, b, b + 1);
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.BufferAttribute(new Float32Array(verts * 3), 3).setUsage(THREE.DynamicDrawUsage));
    geo.setIndex(idx);
    return geo;
  }

  // rewrite one arc tube so its centreline runs A → B lifted by a sine hump of height H (radius r)
  _updateArcGeometry(geo, ax, ay, az, bx, by, bz, H, r) {
    const SEG = 12, RAD = 6;
    const pos = geo.attributes.position.array;
    const dx = bx - ax, dy = by - ay, dz = bz - az;
    let k = 0;
    for (let i = 0; i <= SEG; i++) {
      const t = i / SEG;
      const s = Math.sin(Math.PI * t);
      const cx = ax + dx * t, cy = ay + dy * t + s * H, cz = az + dz * t;
      // analytic tangent of the lifted centreline
      let tx = dx, ty = dy + Math.PI * Math.cos(Math.PI * t) * H, tz = dz;
      const tl = Math.sqrt(tx * tx + ty * ty + tz * tz) || 1;
      tx /= tl; ty /= tl; tz /= tl;
      // frame: n1 = normalize(up × T), n2 = T × n1
      let n1x = tz, n1z = -tx;
      const n1l = Math.hypot(n1x, n1z) || 1;
      n1x /= n1l; n1z /= n1l;
      const n2x = ty * n1z, n2y = tz * n1x - tx * n1z, n2z = -ty * n1x;
      for (let j = 0; j <= RAD; j++) {
        const a = (j / RAD) * Math.PI * 2;
        const ca = Math.cos(a) * r, sa = Math.sin(a) * r;
        pos[k++] = cx + n1x * ca + n2x * sa;
        pos[k++] = cy + n2y * sa;
        pos[k++] = cz + n1z * ca + n2z * sa;
      }
    }
    geo.attributes.position.needsUpdate = true;
  }

  // paint one headstone onto its own 96×128 canvas (the 2D paintGraveyard stone, single-stone)
  _paintGrave(cv, g, weather) {
    const c = cv.getContext("2d");
    c.clearRect(0, 0, 96, 128);
    const w = 20, h = 30;
    c.save();
    c.translate(48, 60);
    c.fillStyle = "rgba(40,34,26,0.16)";
    c.beginPath(); c.ellipse(0, h + 14, w + 8, 6, 0, 0, Math.PI * 2); c.fill();
    const st0 = [151, 143, 129], st1 = [40, 32, 24];
    const stone = mix(st0, st1, 0.18 + weather * 0.42);
    c.beginPath();
    c.moveTo(-w, h); c.lineTo(-w, -h * 0.28);
    c.quadraticCurveTo(-w, -h, 0, -h);
    c.quadraticCurveTo(w, -h, w, -h * 0.28);
    c.lineTo(w, h); c.closePath();
    c.fillStyle = "rgb(" + (stone[0] | 0) + "," + (stone[1] | 0) + "," + (stone[2] | 0) + ")";
    c.fill();
    c.lineWidth = 2; c.strokeStyle = "rgba(40,32,26,0.5)"; c.stroke();
    c.strokeStyle = "rgba(214,178,92,0.5)"; c.lineWidth = 2.2;
    c.beginPath(); c.moveTo(-w, h * 0.2); c.lineTo(-w, -h * 0.28); c.quadraticCurveTo(-w, -h, 0, -h); c.stroke();
    c.textAlign = "center"; c.textBaseline = "middle";
    c.font = "600 22px ui-monospace, SFMono-Regular, Menlo, monospace";
    c.fillStyle = "rgba(40,32,26,0.72)";
    c.fillText(glyphFor(g), 0, -h * 0.34);
    c.font = "16px ui-monospace, SFMono-Regular, Menlo, monospace";
    c.fillStyle = "rgba(40,32,26,0.5)";
    c.fillText("#" + g.id, 0, h * 0.42);
    if (weather > 0.45) {
      const hh = fnv1a("grave:" + g.id + ":" + (g.bornTick == null ? 0 : g.bornTick));
      const cxp = ((hh >>> 3) % (w * 2)) - w;
      c.strokeStyle = "rgba(40,32,26," + (0.32 * weather).toFixed(2) + ")"; c.lineWidth = 1.2;
      c.beginPath(); c.moveTo(cxp, -h * 0.6); c.lineTo(cxp + 3, -h * 0.1); c.lineTo(cxp - 2, h * 0.4); c.stroke();
    }
    if (weather > 0.5) {
      c.fillStyle = "rgba(96,120,76,0.5)";
      c.beginPath(); c.ellipse(-w + 4, h + 2, 6, 2.6, 0, 0, Math.PI * 2);
      c.ellipse(w - 4, h + 2, 5, 2.2, 0, 0, Math.PI * 2); c.fill();
    }
    c.restore();
  }

  // 3D picking (task 20②+⑤). The canvas `click` fires AFTER camera.js's pointerup tap; camera.js now
  // bows out in 3D mode (state.threeScene guard), so this handler owns every click semantic here.
  // Order: flies first (primary target), then headstones (only while the necropolis layer is on),
  // then an empty click clears both. A near-stationary pointerup only — a camera drag is not a tap.
  _onCanvasClick(e) {
    if (!this.renderer || !this.camera) return;
    if (Math.hypot(e.clientX - this._downX, e.clientY - this._downY) > 8) return;
    const rect = this.renderer.domElement.getBoundingClientRect();
    if (!rect.width || !rect.height) return;
    const px = e.clientX - rect.left, py = e.clientY - rect.top;   // screen px, canvas-relative
    this._ndc.set((px / rect.width) * 2 - 1, -(py / rect.height) * 2 + 1);
    this._raycaster.setFromCamera(this._ndc, this.camera);

    // ① flies — double insurance (raycast InstancedMesh, then <28px screen-space nearest)
    const fly = this._pickFly(px, py, rect);
    if (fly != null) { selectFly(fly); return; }

    // ② a headstone, but only while the necropolis layer is showing
    if (state.showGraves && this._graveGroup && this._graveGroup.visible) {
      const g = this._pickGrave(px, py, rect);
      if (g) { showEpitaph({ ...g, uid: graveUid(g.id, g.bornTick) }); return; }
    }

    // ③ empty click — clear both selections
    deselectFly();
    hideEpitaph();
  }

  // task 20⑤ — pick a live fly. ① standard raycast against the flyBody InstancedMesh, using NDC from
  // the canvas boundingRect (not window — the renderer need not fill the viewport). ② screen-space
  // fallback: project every live fly and take the nearest within 28px. Returns a fly id or null.
  // task 22 B3 audit — the fallback used to RE-DERIVE each fly's world position from f.x/f.y with a
  // single heightAt() + a fixed 7. That drifted from what was actually on screen in two ways: it
  // dropped the ±2 hover bob, and it ignored the relief sampling now used to place the instances.
  // At close zoom a couple of world units is several pixels, so a fly the reader aimed at could lose
  // to a neighbour. It now reads the position straight back out of the instance matrix — the exact
  // rendered transform — and the NDC→px conversion (x·0.5+0.5, −y·0.5+0.5) is verified against the
  // same rect the raycaster's NDC came from. Only instances < this._flyCount are walked, and
  // _flyArr is rebuilt from `!f.dying` flies every frame, so dying flies can never be picked.
  _pickFly(px, py, rect) {
    const body = this.flyBody;
    const n = this._flyCount | 0;
    if (!body || n <= 0) return null;
    // ① raycast — refresh the instance bounds first. The swarm moves every frame but an InstancedMesh's
    // boundingSphere is cached on first raycast, so a stale sphere can reject live flies outright.
    body.computeBoundingSphere();
    const hits = this._raycaster.intersectObject(body, false);
    if (hits.length && hits[0].instanceId != null) {
      const f = this._flyArr[hits[0].instanceId];
      if (f && f.id != null) return f.id;
    }
    // ② screen-space fallback — nearest live fly within 28px of the click
    const v = this._v1, m = this._m4;
    let best = null, bestD = 28;
    for (let i = 0; i < n; i++) {
      const f = this._flyArr[i];
      if (!f || f.id == null) continue;
      body.getMatrixAt(i, m);
      v.setFromMatrixPosition(m).project(this.camera);
      if (v.z < -1 || v.z > 1) continue;                 // behind camera / outside depth range
      const sx = (v.x * 0.5 + 0.5) * rect.width;
      const sy = (-v.y * 0.5 + 0.5) * rect.height;
      const dd = Math.hypot(sx - px, sy - py);
      if (dd < bestD) { bestD = dd; best = f.id; }
    }
    return best;
  }

  // task 20② — pick a headstone. task 22 B4 audit: three r160's Raycaster.intersectObject only
  // tests `object.layers.test(raycaster.layers)` — it never looks at `visible` — so the invisible
  // proxies ARE hittable, and Sprite.raycast only needs `raycaster.camera` (set by setFromCamera)
  // plus a non-zero matrixWorld scale and an up-to-date matrixWorld (we force it below). Layers are
  // the default mask on both sides. The real bug was PRECISION: a ×3 proxy is 21.6 units wide while
  // the necropolis plots are ≈26 units apart, so neighbouring proxies overlapped and a tilted camera
  // happily handed back the stone in FRONT of the one that was clicked. Proxies are now ×1.8 and the
  // actual billboards are raycast first, with the fat proxies only as the near-miss fallback.
  _pickGrave(px, py, rect) {
    const sprites = this._graveSprites;
    if (!sprites || !sprites.length) return null;
    this._graveGroup.updateMatrixWorld(true);            // proxies must be current before raycasting
    // ① the real 7.2×9.6 billboards — exact, so a neighbour can never steal the hit
    const live = this._pickA;
    live.length = 0;
    for (const sp of sprites) if (sp.visible && sp.userData.grave) live.push(sp);
    if (live.length) {
      const hits = this._raycaster.intersectObjects(live, false);
      if (hits.length && hits[0].object.userData.grave) return hits[0].object.userData.grave;
    }
    // ② the ×1.8 invisible proxies — a colourWrite:false billboard is a legitimate fat target
    const proxies = this._pickB;
    proxies.length = 0;
    for (const h of this._graveHits) if (h && h.userData.grave) proxies.push(h);
    if (proxies.length) {
      const hits = this._raycaster.intersectObjects(proxies, false);
      if (hits.length && hits[0].object.userData.grave) return hits[0].object.userData.grave;
    }
    // ③ screen-space last resort — nearest stone centre within 28px
    const v = this._v1;
    let best = null, bestD = 28;
    for (const sp of live) {
      v.setFromMatrixPosition(sp.matrixWorld).project(this.camera);
      if (v.z < -1 || v.z > 1) continue;
      const sx = (v.x * 0.5 + 0.5) * rect.width;
      const sy = (-v.y * 0.5 + 0.5) * rect.height;
      const dd = Math.hypot(sx - px, sy - py);
      if (dd < bestD) { bestD = dd; best = sp.userData.grave; }
    }
    return best;
  }

  update(sim, econCities, now) {
    const dt = Math.min(this.clock.getDelta(), 0.05);
    this._simRef = sim;   // task 7: chron-fx spawns read the live swarm

    // the dominion overlay obeys econDynasty.zoneOwners — the same authority the 2D map uses;
    // a conquest recolours the land and raises the new house's castle on the next frame.
    // task 18: every scratch container here is preallocated in the constructor — update() never
    // creates a Map/Array/Set per frame any more.
    const owners = this._ownerMap;
    owners.clear();
    if (state.econDynasty && Array.isArray(state.econDynasty.zoneOwners)) {
      for (const zo of state.econDynasty.zoneOwners) if (zo && zo.zone != null) owners.set(zo.zone | 0, zo);
    }
    const pairs = this._ownerPairs;
    pairs.length = 0;
    for (const e of owners) pairs.push(e);
    pairs.sort((a, b) => a[0] - b[0]);
    const tp = this._terrParts;
    tp.length = 0;
    for (const pr of pairs) tp.push(pr[0], ":", pr[1].name || "", ",");
    // dynasty rank signature (top-5 houses by live population): a reshuffle re-partitions too
    if (state.econDynasty && Array.isArray(state.econDynasty.houses)) {
      const rank = this._rankArr;
      rank.length = 0;
      for (const h of state.econDynasty.houses) if (h && h.id != null) rank.push(h);
      rank.sort((a, b) => ((b.live | 0) - (a.live | 0)) || ((b.capitalShare || 0) - (a.capitalShare || 0)) || ((a.id > b.id) ? 1 : -1));
      const top = rank.length < 5 ? rank.length : 5;
      for (let i = 0; i < top; i++) tp.push("#", rank[i].id);
    }
    const tsig = tp.join("");
    if (tsig !== this._terrSig) {
      this._terrSig = tsig;
      this._applyNations();      // five-nation partition first — _colorTerrain reads the new nation ids
      this._colorTerrain(owners);
    }

    const flies = this._flyArr;
    flies.length = 0;
    for (const f of sim.values()) if (!f.dying) flies.push(f);
    const d = this._dummy, c = this._color;
    const n = Math.min(flies.length, 120);
    for (let i = 0; i < n; i++) {
      const f = flies[i];
      const x = (f.x / state.VW - 0.5) * this._WSX;
      const z = (f.y / state.VH - 0.5) * this._WSZ;
      const balN = f.balN != null ? f.balN : 0.5;
      const sz = (0.7 + balN * 0.6) * 7.2;   // task 20③: ×1.8 for the 480×300→720×450 continent so the swarm reads at a glance
      // task 22 — a fly is NOT a point: at instance scale sz its belly hangs 0.5·sz below the origin
      // and its nose reaches 0.75·sz ahead, so the old single centre sample + a flat 7 left the
      // fatter flies (sz up to 9.4 → a 4.7-unit half-height) belly-down in any slope, i.e. the
      // terrain ate half the swarm. Ride the MAX ground under the whole body, then lift by its own
      // half-height + 2.6 — never below sea level, and the ±2 hover bob rides on top of that.
      const y = Math.max(this.groundY(x, z, sz * 0.8), 0) + sz * 0.5 + 2.6 + Math.sin(now * 0.004 + (f.phase || 0)) * 2.0;
      d.position.set(x, y, z);
      d.rotation.set(Math.sin(now * 0.002 + (f.phase || 0)) * 0.12, -(f.heading || 0), 0, "YXZ");
      d.scale.setScalar(sz);
      d.updateMatrix();
      this.flyBody.setMatrixAt(i, d.matrix);
      const wc = wealthColorAt(balN);          // the same wealth ramp the 2D field uses (slate → sage → amber → gold)
      c.setRGB(wc[0] / 255, wc[1] / 255, wc[2] / 255);
      this.flyBody.setColorAt(i, c);
      // eyes ride the head
      this._m4.copy(d.matrix).multiply(this._eyeL); this.flyEye.setMatrixAt(i * 2, this._m4);
      this._m4.copy(d.matrix).multiply(this._eyeR); this.flyEye.setMatrixAt(i * 2 + 1, this._m4);
      // wings: symmetric flap around the hinge axis
      const flap = Math.sin(now * 0.05 + (f.phase || 0) * 3) * 0.5 + 0.12;
      this._m4.copy(d.matrix).multiply(this._hingeL);
      this._m5.makeRotationX(-flap);
      this.flyWingL.setMatrixAt(i, this._m4.multiply(this._m5));
      this._m4.copy(d.matrix).multiply(this._hingeR);
      this._m5.makeRotationX(flap);
      this.flyWingR.setMatrixAt(i, this._m4.multiply(this._m5));
    }
    this.flyBody.count = n;
    this._flyCount = n;   // task 20⑤: live instance count for _pickFly (instanceId → this._flyArr[id])
    this.flyEye.count = n * 2;
    this.flyWingL.count = n;
    this.flyWingR.count = n;
    this.flyBody.instanceMatrix.needsUpdate = true;
    this.flyEye.instanceMatrix.needsUpdate = true;
    this.flyWingL.instanceMatrix.needsUpdate = true;
    this.flyWingR.instanceMatrix.needsUpdate = true;
    if (this.flyBody.instanceColor) this.flyBody.instanceColor.needsUpdate = true;

    this._rebuildVillages(econCities);   // KayKit village ring per town/city (task 6; the mud-brick town is gone — task 18)
    // task 12 P0: flow the ocean by scrolling the normal map — no uniforms, no mirror pass
    if (this.water && this.water.material && this.water.material.normalMap) {
      const nm = this.water.material.normalMap;
      nm.offset.x = (nm.offset.x + dt * 0.010) % 1;
      nm.offset.y = (nm.offset.y + dt * 0.016) % 1;
    }
    this.controls.update();

    // ---- task 7: the ported 2D layers — each isolated so one bad layer can never veto the frame ----
    try { this._updateSocialLines(sim); } catch (e) { console.warn("socialLines", e); }
    try { this._updateGraveyard(); } catch (e) { console.warn("graveyard", e); }
    try { this._updatePayments(sim, now); } catch (e) { console.warn("payments", e); }
    try { this._updateChronFx(now, dt); } catch (e) { console.warn("chronFx", e); }
    try { this._updateMeshLines(sim); } catch (e) { console.warn("meshLines", e); }
    try { this._updateFaith(now); } catch (e) { console.warn("faith", e); }
    try { this._updateDayNight(now); } catch (e) { console.warn("dayNight", e); }
    try { this._updateEraHud(); } catch (e) { console.warn("eraHud", e); }
    try { this._updateSwarmAura(now); } catch (e) { console.warn("swarmAura", e); }
    try { this._updateShardRings(now); } catch (e) { console.warn("shardRings", e); }
    try { this._updateLegend(sim, now); } catch (e) { console.warn("legend", e); }
  }

  // ============================ task 7 — layer implementations ============================

  // ① social web — blue alliance threads + red dashed feud rifts between live flies
  _updateSocialLines(sim) {
    const s = state.econSocial;
    const show = !!state.showSocieties && !!s;
    const bonds = (show && Array.isArray(s.bonds)) ? s.bonds : null;
    const grudges = (show && Array.isArray(s.grudges)) ? s.grudges : null;
    const W = this._WSX, H = this._WSZ, VW = state.VW, VH = state.VH;
    // task 22 — a thread is ONE straight segment, so lifting each end by its own ground height still
    // buried the middle wherever a ridge ran between the two flies. Both ends now ride the highest
    // ground along the whole span (+5 clears the bodies), so the thread never dives into the land.
    const span = (fa, fb, arr, k) => {
      const ax = (fa.x / VW - 0.5) * W, az = (fa.y / VH - 0.5) * H;
      const bx = (fb.x / VW - 0.5) * W, bz = (fb.y / VH - 0.5) * H;
      const y = this.spanY(ax, az, bx, bz) + 5;
      arr[k] = ax; arr[k + 1] = y; arr[k + 2] = az;
      arr[k + 3] = bx; arr[k + 4] = y; arr[k + 5] = bz;
    };
    // alliances — a single blue segment per bond
    let nl = 0;
    const la = this._socLines.geometry.attributes.position.array;
    if (bonds) for (const b of bonds) {
      if (nl >= this._socLineCap) break;
      if (!b || b.a == null || b.b == null || b.a === b.b) continue;
      const fa = sim.get(b.a), fb = sim.get(b.b);
      if (!fa || fa.dying || !fb || fb.dying) continue;
      span(fa, fb, la, nl * 6);
      nl++;
    }
    if (nl) this._socLines.geometry.attributes.position.needsUpdate = true;
    this._socLines.geometry.setDrawRange(0, nl * 2);
    this._socLines.visible = nl > 0;
    // feuds — a red dashed rift per grudge
    let nf = 0;
    const ga = this._socGrudge.geometry.attributes.position.array;
    if (grudges) for (const g of grudges) {
      if (nf >= this._socLineCap) break;
      if (!g || g.buyerId == null || g.sellerId == null || g.buyerId === g.sellerId) continue;
      const fa = sim.get(g.buyerId), fb = sim.get(g.sellerId);
      if (!fa || fa.dying || !fb || fb.dying) continue;
      span(fa, fb, ga, nf * 6);
      nf++;
    }
    if (nf) {
      this._socGrudge.geometry.attributes.position.needsUpdate = true;
      this._socGrudge.computeLineDistances();     // dash distances must follow the moved endpoints
    }
    this._socGrudge.geometry.setDrawRange(0, nf * 2);
    this._socGrudge.visible = nf > 0;
  }

  // ② necropolis — one sprite per grave, laid out deterministically in the atlas's southern band
  _updateGraveyard() {
    const grp = this._graveGroup;
    grp.visible = !!state.showGraves;
    if (!grp.visible) return;
    const graves = (state.econDynasty && Array.isArray(state.econDynasty.graves)) ? state.econDynasty.graves : null;
    if (!graves || !graves.length) {
      if (this._graveSig !== "") { this._graveSig = ""; for (const sp of this._graveSprites) { sp.visible = false; sp.userData.grave = null; } }
      return;
    }
    const gs = graves.slice().sort((a, b) => (b.tick || 0) - (a.tick || 0)).slice(0, GRAVE_CAP);   // newest first
    let sig = gs.length + ":";
    for (let i = 0; i < gs.length && i < 4; i++) sig += (gs[i].id == null ? "?" : gs[i].id) + "." + (gs[i].bornTick == null ? "" : gs[i].bornTick) + ",";
    if (gs[gs.length - 1]) sig += ":" + (gs[gs.length - 1].tick || 0);
    if (sig === this._graveSig) return;
    this._graveSig = sig;
    this._rebuildGraves(gs);
  }

  // the deterministic necropolis layout (2D rebuildGraveField logic mapped onto the 3D southern band)
  _rebuildGraves(gs) {
    const VW = state.VW, VH = state.VH;
    if (!VW || !VH) return;
    // houses (biggest bloodline first) lead, the houseless commons trails — kin share a plot
    const byHouse = new Map();
    for (const g of gs) {
      const k = g.houseName || "";
      let arr = byHouse.get(k); if (!arr) { arr = []; byHouse.set(k, arr); }
      arr.push(g);
    }
    const groups = [...byHouse.entries()].sort((a, b) => (a[0] === "" ? 1 : b[0] === "" ? -1 : b[1].length - a[1].length));
    const ordered = [];
    for (const [, arr] of groups) for (const g of arr) ordered.push(g);
    const x0 = VW * 0.18, x1 = VW * 0.82, y0 = VH * 0.72, y1 = VH * 0.93;
    const bandW = x1 - x0, bandH = y1 - y0, n = Math.min(ordered.length, GRAVE_CAP);
    const cols = clamp(Math.round(bandW / 46), 4, 20) | 0;
    const rows = Math.max(1, Math.ceil(n / cols));
    const cw = bandW / cols, ch = bandH / rows;
    let maxTick = -Infinity, minTick = Infinity;
    for (const g of ordered) { const t = g.tick || 0; if (t > maxTick) maxTick = t; if (t < minTick) minTick = t; }
    const span = Math.max(1, maxTick - minTick);
    for (let i = 0; i < GRAVE_CAP; i++) {
      const sp = this._graveSprites[i];
      const hit = this._graveHits[i];                       // task 20②: the invisible ×3 pick proxy
      if (i >= n) {
        sp.visible = false; sp.scale.set(0, 0, 0); sp.userData.grave = null;
        if (hit) { hit.visible = false; hit.scale.set(0, 0, 0); hit.userData.grave = null; }
        continue;
      }
      const g = ordered[i], r = (i / cols) | 0, cI = i % cols;
      const hh = fnv1a("grave:" + g.id + ":" + (g.bornTick == null ? 0 : g.bornTick));   // a recycled id scatters to its OWN plot
      const jx = ((hh % 1000) / 1000 - 0.5), jy = (((hh >>> 10) % 1000) / 1000 - 0.5);
      const fx = x0 + cw * (cI + 0.5) + jx * cw * 0.34;
      const fy = y0 + ch * (r + 0.5) + jy * ch * 0.28;
      const weather = clamp(((maxTick - (g.tick || 0)) / span) * 0.85 + ((hh >>> 4) % 100) / 100 * 0.15);
      this._paintGrave(sp.material.map.image, g, weather);
      sp.material.map.needsUpdate = true;
      const x = (fx / VW - 0.5) * this._WSX;
      let z = (fy / VH - 0.5) * this._WSZ;
      let y = this.heightAt(x, z);
      for (let k = 0; k < 10 && y < -0.6; k++) { z -= this._WSZ * 0.05; y = this.heightAt(x, z); }   // walk inland off the sea floor
      if (y < -0.6) y = 0.6;    // a far-south straggler stays visible just above the waterline
      // task 22 — the stone is a 7.2×9.6 billboard: ground it on the HIGHEST point of its own plot
      // (±3.6) and lift it 5.4, so its foot sits +0.6 clear of every bump it covers. A ridge beside
      // the grave can no longer swallow the epitaph.
      const gy = Math.max(y, this.groundY(x, z, 3.6));
      sp.position.set(x, gy + 5.4, z);
      sp.scale.set(7.2, 9.6, 1);
      sp.visible = true;
      sp.userData.grave = g;
      // task 20②/22 B4: park the invisible billboard on the same stone so picking has a fat target.
      // ×1.8, not ×3 — at ×3 (21.6 wide) neighbours on ≈26-unit plots overlapped and the raycast
      // returned whichever stone was physically NEAREST rather than the one aimed at. It stays
      // visible=false (three r160's Raycaster never tests `visible`) so it only receives hits.
      if (hit) {
        hit.position.copy(sp.position);
        hit.scale.set(7.2 * 1.8, 9.6 * 1.8, 1);
        hit.visible = false;
        hit.userData.grave = g;
      }
    }
    // matrixWorld must be current before the pick raycast walks these proxies (task 20②)
    this._graveGroup.updateMatrixWorld(true);
  }

  // ③ x402 payment arcs — pooled gold quad-bezier tubes + comet heads, fading with age
  _updatePayments(sim, now) {
    const edges = state.payEdges;
    let used = 0;
    if (Array.isArray(edges) && edges.length) {
      const W = this._WSX, H = this._WSZ, VW = state.VW, VH = state.VH;
      for (let i = edges.length - 1; i >= 0; i--) {
        const e = edges[i];
        const dur = e.real ? 2800 : ECON_EDGE_MS;
        const age = (now - e.t0) / dur;
        if (age >= 1) { edges.splice(i, 1); continue; }            // expired — same cleanup the 2D path does
        const fa = sim.get(e.fromId), fb = sim.get(e.toId);
        if (!fa || fa.dying || !fb || fb.dying) { edges.splice(i, 1); continue; }
        if (used >= this._payPool.length) continue;
        const agec = age < 0 ? 0 : age;                            // sub-frame clock skew
        const fade = e.real ? (agec < 0.12 ? agec / 0.12 : (1 - agec) / 0.88) : (1 - agec) * (e.valid ? 1 : 0.4);
        const ax = (fa.x / VW - 0.5) * W, az = (fa.y / VH - 0.5) * H;
        const bx = (fb.x / VW - 0.5) * W, bz = (fb.y / VH - 0.5) * H;
        // task 22 — the chord's middle used to clip straight through any ridge between the payer and
        // the payee even though both ends were clear. spanY() samples the ends too (and floors at 0),
        // so this crest is ≥ either endpoint's own ground + 5: both ends ride it and the arc's belly
        // stays above every point of relief it crosses.
        const ay = this.spanY(ax, az, bx, bz) + 5;
        const by = ay;
        const dist = Math.hypot(bx - ax, by - ay, bz - az);
        const Hump = dist * 0.22 + 5;
        const amt = Math.min(1, (Number(e.amount) || 0) * 520);    // bigger trade → fatter arc
        const p = this._payPool[used++];
        this._updateArcGeometry(p.tube.geometry, ax, ay, az, bx, by, bz, Hump, 0.55 + amt * 1.1);
        const t = agec;
        p.head.position.set(ax + (bx - ax) * t, ay + (by - ay) * t + Math.sin(Math.PI * t) * Hump, az + (bz - az) * t);
        p.head.scale.setScalar(1.1 + amt * 1.3);
        const op = Math.max(0, fade);
        p.tMat.opacity = (e.real ? 0.85 : 0.5) * op;
        p.hMat.opacity = 0.9 * op;
        p.tube.visible = true; p.head.visible = true;
      }
    }
    for (let i = used; i < this._payPool.length; i++) { const p = this._payPool[i]; p.tube.visible = false; p.head.visible = false; }
  }

  // ④ chron-fx — particles + shockwave rings for the live chronicle events (alliance / feud / law / …)
  _updateChronFx(now, dt) {
    // consume render2d's chronFx: clean expired entries exactly like the 2D path, fire one burst per NEW entry
    for (let i = chronFx.length - 1; i >= 0; i--) {
      const fx = chronFx[i];
      const age = (now - fx.t0) / (fx.dur || 1);
      if (age >= 1) { chronFx.splice(i, 1); continue; }
      if (age < 0) continue;                       // a rAF stamp can lag the event clock a hair
      if (this._fxSeen.has(fx)) continue;
      this._fxSeen.add(fx);
      this._chronFxSpawn(fx);
    }
    // advance + upload the particle pool
    const P = this._parts, mesh = this._partMesh, d = this._dummy, col = this._color;
    let count = 0;
    for (let i = 0; i < P.length; i++) {
      const p = P[i];
      if (!p.active) continue;
      p.age += dt / p.dur;
      if (p.age >= 1) { p.active = false; continue; }
      p.x += p.vx * dt; p.z += p.vz * dt; p.y += p.vy * dt;
      if (p.mode === 1) p.vy -= 26 * dt;           // burst: heavy gravity
      else if (p.mode === 0) p.vy -= 2.5 * dt;     // rise: a gentle halt
      else p.vy += 1.5 * dt;                       // ash: the sink slows
      const k = p.age;
      d.position.set(p.x, p.y, p.z);
      d.scale.setScalar(p.s0 + (p.s1 - p.s0) * k);
      d.rotation.set(0, 0, 0);
      d.updateMatrix();
      mesh.setMatrixAt(count, d.matrix);
      const br = Math.pow(1 - k, 1.4);             // additive blending ⇒ brightness reads as fade
      col.setRGB(p.r * br, p.g * br, p.b * br);
      mesh.setColorAt(count, col);
      count++;
    }
    mesh.count = count;
    if (count) { mesh.instanceMatrix.needsUpdate = true; if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true; }
    // advance the pooled shockwave rings
    for (const rg of this._fxRings) {
      if (!rg.active) continue;
      rg.age += dt / rg.dur;
      if (rg.age >= 1) { rg.active = false; rg.mesh.visible = false; continue; }
      const rr = rg.r0 + (rg.r1 - rg.r0) * rg.age, rad = Math.abs(rr);
      // task 22 — a shockwave is a FLAT ground disc: +1.2 let any bump under it cut a hole in the
      // ring. Sample the crest near the burst (capped — sampling the whole 120-unit radius would
      // find a distant peak and hang the ring in mid-air) and add a little altitude as it spreads.
      const y = Math.max(this.groundY(rg.x, rg.z, Math.min(rad, 12)), 0) + 2.4 + rad * 0.05;
      rg.mesh.position.set(rg.x, y, rg.z);
      rg.mesh.scale.set(Math.abs(rr), 1, Math.abs(rr));
      rg.mat.opacity = rg.a0 * (1 - rg.age);
      rg.mesh.visible = true;
    }
  }

  _chronFxSpawn(fx) {
    // world position: the live actor's fly if present, else the entry's atlas coords, else the field's heart
    let wx = null, wz = null;
    const fa = (fx.a != null && this._simRef) ? this._simRef.get(fx.a) : null;
    if (fa && !fa.dying) { wx = (fa.x / state.VW - 0.5) * this._WSX; wz = (fa.y / state.VH - 0.5) * this._WSZ; }
    else if (fx.x != null && fx.y != null) { wx = (fx.x / state.VW - 0.5) * this._WSX; wz = (fx.y / state.VH - 0.5) * this._WSZ; }
    if (wx == null) { wx = 0; wz = 0; }   // law / holy / whale — the field's heart
    const y = Math.max(this.groundY(wx, wz, 6), 0) + 6;   // task 22: spawn above the local crest, not the centre point
    const kind = fx.kind;
    if (kind === "alliance") {
      this._spawnParts(wx, y, wz, [96, 148, 224], 14, 0, 16, 1.6);
      this._spawnRing(wx, wz, [96, 148, 224], 4, 34, 1.4, 0.42);
    } else if (kind === "feud") {
      this._spawnParts(wx, y, wz, CRACK_RED, 18, 1, 30, 1.1);
      this._spawnRing(wx, wz, CRACK_RED, 6, 40, 1.2, 0.5);
    } else if (kind === "law" || kind === "holy" || kind === "whale") {
      this._spawnRing(0, 0, GOLD_THREAD, 3, 120, 1.6, 0.4);
      this._spawnRing(0, 0, GOLD_THREAD, 1, 86, 1.6, 0.3);
      this._spawnParts(wx, y, wz, COIN_GOLD, 8, 0, 22, 1.5);
    } else if (kind === "prophet") {
      this._spawnParts(wx, y, wz, FAITH_GOLD, 12, 0, 14, 1.7);
      this._spawnRing(wx, wz, FAITH_GOLD, 3, 30, 1.6, 0.4);
    } else if (kind === "invent" || kind === "school" || kind === "transmit") {
      this._spawnParts(wx, y, wz, TECH_BRONZE, 10, 0, 16, 1.5);
      this._spawnRing(wx, wz, TECH_BRONZE, 3, 28, 1.5, 0.35);
    } else if (kind === "lostart" || kind === "silence") {
      this._spawnParts(wx, y, wz, ASH_GREY, 8, 2, 16, 1.8);
      this._spawnRing(wx, wz, ASH_GREY, 26, 8, 1.3, 0.34);   // the hush-ring contracts
    } else if (kind === "coin") {
      this._spawnParts(wx, y, wz, COIN_GOLD, 10, 0, 18, 1.4);
      this._spawnRing(wx, wz, COIN_GOLD, 3, 36, 1.2, 0.42);
    } else if (kind === "house") {
      const colr = Array.isArray(fx.color) ? fx.color : LAW_GOLD;
      this._spawnParts(wx, y, wz, colr, 12, 0, 16, 1.6);
      this._spawnRing(wx, wz, colr, 3, 32, 1.6, 0.4);
    }
  }

  _spawnRing(x, z, col, r0, r1, dur, a0) {
    const ring = this._fxRings[this._ringCursor = (this._ringCursor + 1) % this._fxRings.length];
    ring.active = true; ring.x = x; ring.z = z; ring.age = 0; ring.dur = dur; ring.r0 = r0; ring.r1 = r1; ring.a0 = a0;
    ring.mat.color.setRGB(col[0] / 255, col[1] / 255, col[2] / 255);
  }

  // take `n` particles from the free pool (ring cursor keeps the search amortised)
  _spawnParts(x, y, z, col, n, mode, spread, dur) {
    const P = this._parts, L = P.length;
    let made = 0;
    for (let tries = 0; tries < L && made < n; tries++) {
      const p = P[this._partCursor = (this._partCursor + 1) % L];
      if (p.active) continue;
      p.active = true; made++;
      p.x = x; p.y = y; p.z = z;
      p.age = 0; p.dur = dur * (0.75 + Math.random() * 0.5);
      p.r = col[0] / 255; p.g = col[1] / 255; p.b = col[2] / 255;
      const a = Math.random() * Math.PI * 2;
      const sp = spread * (0.4 + Math.random() * 0.8);
      if (mode === 0) {          // rise — a slow upward column
        p.vx = Math.cos(a) * sp * 0.25; p.vz = Math.sin(a) * sp * 0.25; p.vy = 7 + Math.random() * 9;
        p.s0 = 0.9 + Math.random() * 0.9;
      } else if (mode === 1) {   // burst — radial, then gravity
        p.vx = Math.cos(a) * sp; p.vz = Math.sin(a) * sp; p.vy = 6 + Math.random() * 10;
        p.s0 = 1.0 + Math.random();
      } else {                   // drop — ash sinking
        p.vx = Math.cos(a) * sp * 0.3; p.vz = Math.sin(a) * sp * 0.3; p.vy = -3 - Math.random() * 3;
        p.s0 = 0.8 + Math.random() * 0.6;
      }
      p.s1 = p.s0 * 0.35;
      p.mode = mode;
    }
  }

  // ⑤ murmuration mesh — faint threads between close flies while the swarm is cohesive
  _updateMeshLines(sim) {
    const ok = state.qualityCoeff > 0.6 && state.cohSmoothed > 0.34;
    if (!ok) {
      if (this._meshLines.visible) { this._meshLines.visible = false; this._meshLines.geometry.setDrawRange(0, 0); }
      return;
    }
    const list = this._meshList;
    list.length = 0;
    for (const f of sim.values()) if (!f.dying) list.push(f);
    const n = Math.min(list.length, 120);
    const R = (74 + state.cohSmoothed * 46) * (this._WSX / state.VW);   // the 2D capture radius, in world units
    const R2 = R * R;
    const arr = this._meshLines.geometry.attributes.position.array;
    const W = this._WSX, H = this._WSZ, VW = state.VW, VH = state.VH;
    let seg = 0;
    outer:
    for (let i = 0; i < n; i++) {
      const a = list[i];
      for (let j = i + 1; j < n; j++) {
        if (seg >= this._meshLineCap) break outer;
        const b = list[j];
        const dx = a.x - b.x, dy = a.y - b.y, dd2 = dx * dx + dy * dy;
        if (dd2 < R2) {
          const k = seg * 6;
          const x = (a.x / VW - 0.5) * W, z = (a.y / VH - 0.5) * H;
          const x2 = (b.x / VW - 0.5) * W, z2 = (b.y / VH - 0.5) * H;
          // task 22 — the crest of the WHOLE span, not each end's own ground: a 4-step sample keeps
          // this cheap at up to 2000 threads while no ridge can swallow the middle of a thread.
          const y = this.spanY(x, z, x2, z2, 4) + 5.2;
          arr[k] = x; arr[k + 1] = y; arr[k + 2] = z;
          arr[k + 3] = x2; arr[k + 4] = y; arr[k + 5] = z2;
          seg++;
        }
      }
    }
    if (seg) this._meshLines.geometry.attributes.position.needsUpdate = true;
    this._meshLines.geometry.setDrawRange(0, seg * 2);
    this._meshLines.visible = seg > 0;
  }

  // ⑥ faith membrane — warm halos over every prophet's fly, a candle-point wash over the field on holy days
  _updateFaith(now) {
    const sim = this._simRef;
    const rel = state.econReligion;
    const pulse = 0.5 + 0.5 * Math.sin(now / 620);
    const k = this._WSX / (state.VW || 1);
    const W = this._WSX, H = this._WSZ, VW = state.VW, VH = state.VH;
    // prophet halos — live prophet ids collected from the sects (the same set renderFaithFx walks)
    let np = 0;
    if (rel && Array.isArray(rel.sects) && sim) {
      const seen = this._faithSeen;
      seen.clear();
      for (const s of rel.sects) {
        if (np >= this._prophetSprites.length) break;
        const id = s && s.prophetId;
        if (id == null || seen.has(id)) continue;
        seen.add(id);
        const f = sim.get(id);
        if (!f || f.dying) continue;
        const sp = this._prophetSprites[np++];
        const x = (f.x / VW - 0.5) * W, z = (f.y / VH - 0.5) * H;
        // task 22: the halo is a 13-16 unit sprite, so on a slope the crest beside the prophet can be
        // higher than its own centre point — sample the footprint (small radius: the halo must stay
        // visually attached to its fly) instead of the single centre sample.
        sp.position.set(x, Math.max(this.groundY(x, z, 5), 0) + 13 + pulse * 2, z);
        const sc = (23 + pulse * 6) * k;
        sp.scale.set(sc, sc, 1);
        sp.material.opacity = 0.5 + 0.3 * pulse;
        sp.visible = true;
      }
    }
    for (let i = np; i < this._prophetSprites.length; i++) this._prophetSprites[i].visible = false;
    // holy day — a yellow candle-point array drifting over the field's heart (the 2D full-field gilt wash, in 3D)
    const holy = !!state.holyDay;
    for (let i = 0; i < this._holySprites.length; i++) {
      const sp = this._holySprites[i];
      if (!holy) { sp.visible = false; continue; }
      const px = (fnv1a("candle:" + i) % 1000) / 1000, py = (fnv1a("candle:y" + i) % 1000) / 1000;
      const x = (0.28 + 0.44 * px - 0.5) * W, z = (0.28 + 0.44 * py - 0.5) * H;
      const fl = 0.5 + 0.5 * Math.sin(now * 0.004 + i * 2.1) * Math.sin(now * 0.0017 + i);
      sp.position.set(x, Math.max(this.groundY(x, z, 7), 0) + 10 + 4 * fl, z);   // task 22: crest, not centre
      const sc = (16 + 8 * fl) * k;
      sp.scale.set(sc, sc, 1);
      sp.material.opacity = 0.22 + 0.3 * fl;
      sp.visible = true;
    }
  }

  // ⑦ chronicle ambient — REMOVED (task 20①). The totem steles / school / lost-art / coffer map
  // decoration read as scattered grey blocks; the chronicle drawer + bottom ticker (DOM) remain.

  // ⑧ day/night — the ≈7-min light cycle drives the key light's colour & level; tempSmoothed grades the hue
  _updateDayNight(now) {
    const cyc = 0.5 + 0.5 * Math.sin(now * 0.00025);       // 0 night → 0.5 noon → 1 night (the 2D light cycle)
    // key-light colour: cold night → warm dawn → white day → amber dusk
    let rr, gg, bb;
    if (cyc < 0.12) { const t = cyc / 0.12; rr = 148 + 107 * t; gg = 176 + 20 * t; bb = 216 - 96 * t; }
    else if (cyc < 0.30) { const t = (cyc - 0.12) / 0.18; rr = 255; gg = 196 + 44 * t; bb = 120 + 94 * t; }
    else if (cyc < 0.70) { rr = 255; gg = 240; bb = 214; }
    else if (cyc < 0.88) { const t = (cyc - 0.70) / 0.18; rr = 255; gg = 240 - 90 * t; bb = 214 - 126 * t; }
    else { const t = (cyc - 0.88) / 0.12; rr = 255 - 107 * t; gg = 150 + 26 * t; bb = 88 + 128 * t; }
    const temp = state.tempSmoothed == null ? 0.5 : clamp(state.tempSmoothed);
    const warm = (temp - 0.5) * 2;                          // hot market → warmer hue, cold → cooler
    rr = clamp(rr + warm * 14, 0, 255); gg = clamp(gg + warm * 6, 0, 255); bb = clamp(bb - warm * 12, 0, 255);
    this.sunLight.color.setRGB(rr / 255, gg / 255, bb / 255, THREE.SRGBColorSpace);
    const dayness = clamp(Math.sin(Math.PI * cyc));         // 0 at midnight, 1 at noon
    this.sunLight.intensity = 0.35 + 1.15 * dayness;
    this.hemiLight.intensity = 0.2 + 0.4 * dayness;         // the 2D ambient: 0.2 night → 0.6 day
  }

  // ⑨ era label — task 20⑥: a FIXED DOM HUD (#era-hud), no longer a Sprite riding the camera (which
  // floated over the terrain and drifted with every orbit). It pins to the screen and rewrites its text
  // only when chronMeta.era/eraName changes — the same source the chronicle panel + 2D HUD read.
  _updateEraHud() {
    const el = this._eraHudEl;
    if (!el) return;
    const m = state.chronMeta;
    if (!m || (m.era == null && !m.eraName)) { el.style.display = "none"; return; }
    const sig = String(m.era == null ? "" : m.era) + "|" + String(m.eraName || "");
    if (sig === this._eraSig) { el.style.display = ""; return; }
    this._eraSig = sig;
    const rn = (n) => {
      if (!n || n <= 0) return String(n == null ? "" : n);
      const rom = [[1000, "M"], [900, "CM"], [500, "D"], [400, "CD"], [100, "C"], [90, "XC"], [50, "L"], [40, "XL"], [10, "X"], [9, "IX"], [5, "V"], [4, "IV"], [1, "I"]];
      let out = "", rest = n; for (const [v, s] of rom) while (rest >= v) { out += s; rest -= v; } return out;
    };
    const name = String(m.eraName || "").trim();
    el.textContent = "";
    const num = document.createElement("span");
    num.className = "era-hud-num";
    num.textContent = "ERA " + rn(m.era);
    el.appendChild(num);
    if (name) {
      const sep = document.createElement("span");
      sep.className = "era-hud-sep"; sep.textContent = "\u00b7";
      const nm = document.createElement("span");
      nm.className = "era-hud-name"; nm.textContent = name;
      el.appendChild(sep); el.appendChild(nm);
    }
    el.style.display = "";
  }

  // ⑩ swarm neural aura — one breathing sphere over the collective's centroid (cohesion sizes it, arousal reddens it)
  _updateSwarmAura(now) {
    const C = state.collective;
    const mesh = this._auraMesh;
    if (!C) { mesh.visible = false; return; }
    const aro = clamp(Number(C.arousal) || 0);
    const coh = clamp(Number(C.cohesion) || 0);
    const VW = state.VW, VH = state.VH, W = this._WSX, H = this._WSZ;
    const cfx = state.centroidX || VW / 2, cfy = state.centroidY || VH / 2;
    const x = (cfx / VW - 0.5) * W, z = (cfy / VH - 0.5) * H;
    const R = (55 + coh * 95) * (W / (VW || 1)) * (1 + 0.05 * Math.sin(now / 700));
    mesh.position.set(x, Math.max(this.heightAt(x, z), 0) + R * 0.45, z);
    mesh.scale.setScalar(Math.max(R, 2));
    mesh.material.opacity = clamp(0.03 + aro * 0.10, 0.02, 0.2);
    mesh.material.color.setRGB(
      (106 + 92 * aro) / 255,
      (148 - 88 * aro) / 255,
      (224 - 180 * aro) / 255, THREE.SRGBColorSpace);
    mesh.visible = true;
  }

  // ⑬ pointer ripples — REMOVED (task 20④). camera.js no longer pushes to state.ripples, so the pool
  // and this per-frame update are gone; drag / zoom / tap-select are untouched.

  // ⑭ shard topology ring — the compute-ring read-out (societies layer, per the port spec)
  _updateShardRings(now) {
    const tp = state.topology;
    const ok = !!state.showSocieties && !!tp && Array.isArray(tp.shards) && tp.shards.length >= 2;
    const guide = this._shardGuide;
    if (!ok) {
      if (guide.visible) guide.visible = false;
      for (const m of this._shardRings) m.visible = false;
      return;
    }
    const VW = state.VW, VH = state.VH;
    const shards = tp.shards, S = Math.min(shards.length, this._shardRings.length);
    const cfx = state.centroidX || VW / 2, cfy = state.centroidY || VH / 2;
    const x0 = (cfx / VW - 0.5) * this._WSX, z0 = (cfy / VH - 0.5) * this._WSZ;
    const ring = Math.min(VW, VH) * 0.315 * (this._WSX / (VW || 1));
    const pAge = (now - state.shardPulseT) / 1500;
    guide.position.set(x0, Math.max(this.groundY(x0, z0, 24), 0) + 2.6, z0);   // task 22: clear the local crest (sampling the whole ≈128-unit radius would hang the guide in mid-air)
    guide.scale.set(ring, 1, ring);
    guide.material.opacity = 0.05 + 0.03 * (0.5 + 0.5 * Math.sin(now / 900));
    guide.visible = true;
    for (let i = 0; i < this._shardRings.length; i++) {
      const mesh = this._shardRings[i];
      if (i >= S) { mesh.visible = false; continue; }
      const s = shards[i];
      const ang = (i / shards.length) * Math.PI * 2 - Math.PI / 2;
      const x = x0 + Math.cos(ang) * ring, z = z0 + Math.sin(ang) * ring;
      let glow = 0;                                       // fan-out pulse: the runtime runs shards in ~ceil(N/6) waves of 6
      if (pAge >= 0 && pAge < 1) {
        const delay = ((s.index % 6) / 6) * 0.4;
        const p = clamp((pAge - delay) / Math.max(0.001, 1 - delay));
        if (p > 0 && p < 1) glow = Math.sin(p * Math.PI);
      }
      mesh.position.set(x, Math.max(this.groundY(x, z, 5), 0) + 2.6, z);   // task 22: same flat-ring rule as the guide
      const sc = 4.4 + glow * 1.2;
      mesh.scale.set(sc, 1, sc);
      mesh.material.opacity = 0.14 + glow * 0.5;
      mesh.visible = true;
    }
  }

  // ⑪ territory legend — the 2D map key as a DOM overlay (render2d's render() never runs in 3D mode)
  _updateLegend(sim, now) {
    const el = this._legendEl;
    if (!el) return;
    if (now - this._legendT < 320) return;                 // ~3Hz: the tally is a read-out, not a hot path
    this._legendT = now;
    const pol = [];
    if (state.showTerritory && Array.isArray(state.territories)) {
      for (const p of state.territories) {
        let cnt = 0;
        if (Array.isArray(p.ids)) for (const id of p.ids) { const f = sim.get(id); if (f && !f.dying) cnt++; }
        if (cnt > 0) pol.push({ p, n: cnt });
      }
      pol.sort((a, b) => b.n - a.n || (a.p.name < b.p.name ? -1 : 1));   // biggest houses first (the 2D ranking)
    }
    if (!pol.length) { if (el.style.display !== "none") el.style.display = "none"; this._legendSig = ""; return; }
    const ranked = pol.slice(0, 6);
    const era = (state.chronMeta && state.chronMeta.eraName) ? state.chronMeta.eraName : "the swarm's dominions";
    let sig = era + "|";
    for (const o of ranked) sig += o.p.name + ":" + o.n + ":" + (Array.isArray(o.p.color) ? o.p.color.join(",") : "") + ";";
    if (sig !== this._legendSig) {
      this._legendSig = sig;
      el.textContent = "";
      const title = document.createElement("div");
      title.style.cssText = "font:700 12px Fraunces, Cinzel, Georgia, serif;color:rgba(40,32,26,0.9);margin-bottom:4px;";
      title.textContent = era;
      el.appendChild(title);
      for (const o of ranked) {
        const cc = Array.isArray(o.p.color) ? o.p.color : [120, 116, 108];
        const row = document.createElement("div");
        row.style.cssText = "display:flex;align-items:center;gap:6px;margin-top:2px;";
        const sw = document.createElement("span");
        sw.style.cssText = "width:10px;height:10px;border:1px solid rgba(40,32,26,0.5);flex:0 0 auto;background:rgb(" +
          (cc[0] | 0) + "," + (cc[1] | 0) + "," + (cc[2] | 0) + ");";
        const tx = document.createElement("span");
        tx.textContent = o.p.name + "  \u00b7  " + o.n;
        row.appendChild(sw); row.appendChild(tx);
        el.appendChild(row);
      }
    }
    if (el.style.display !== "block") el.style.display = "block";
  }

  render() {
    this.renderer.render(this.scene, this.camera);
  }

  resize(w, h) {
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(w, h);
    // task 18: re-apply the resolution cap on every resize (window moves between screens/DPRs)
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, this._dprCap || 1.5));
  }

  // release every GPU resource and DOM hook this scene owns (teardown / hot-reload)
  dispose() {
    if (this._cvEl) {
      if (this._onDown) this._cvEl.removeEventListener("pointerdown", this._onDown);
      if (this._onClick) this._cvEl.removeEventListener("click", this._onClick);
    }
    if (this._legendEl && this._legendEl.parentNode) this._legendEl.parentNode.removeChild(this._legendEl);
    const seenTex = new Set();
    const killMat = (m) => {
      for (const kk of ["map", "alphaMap", "normalMap", "roughnessMap", "metalnessMap", "emissiveMap", "gradientMap", "envMap"]) {
        const tx = m[kk];
        if (tx && tx.dispose && !seenTex.has(tx)) { seenTex.add(tx); tx.dispose(); }
      }
      if (m.dispose) m.dispose();
    };
    this.scene.traverse((o) => {
      if (o.geometry && o.geometry.dispose) o.geometry.dispose();
      if (Array.isArray(o.material)) for (const m of o.material) killMat(m);
      else if (o.material) killMat(o.material);
      if (o.isInstancedMesh && o.dispose) o.dispose();
    });
    if (this.water && this.water.material && this.water.material.normalMap) {
      const wt = this.water.material.normalMap;   // task 12: plane water — explicit normalMap release
      if (wt && wt.dispose && !seenTex.has(wt)) { seenTex.add(wt); wt.dispose(); }
    }
    if (this._castleLib) for (const kk in this._castleLib) {
      const e = this._castleLib[kk];
      if (!e) continue;
      if (e.geometry && e.geometry.dispose) e.geometry.dispose();
      if (e.material) { const ms = Array.isArray(e.material) ? e.material : [e.material]; for (const m of ms) killMat(m); }
    }
    // task 18: shared castle caches (merged kit geometry, limestone, plinth)
    for (const k of ["_castleStoneGeo", "_castleStrongGeo", "_plinthGeo"]) {
      if (this[k] && this[k].dispose) this[k].dispose();
    }
    for (const k of ["_castleStoneMat", "_plinthMat"]) {
      if (this[k]) killMat(this[k]);
    }
    if (this.scene.environment && this.scene.environment.dispose) this.scene.environment.dispose();
    if (this._ramp && this._ramp.dispose) this._ramp.dispose();
    if (this.controls && this.controls.dispose) this.controls.dispose();
    if (this.renderer && this.renderer.dispose) this.renderer.dispose();
  }
}
