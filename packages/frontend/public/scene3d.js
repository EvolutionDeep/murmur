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
import { updateNations, assignNationIds, buildBorderMesh, getNationId, getNationTint, voronoiEdges, meanderEdges, getNationColor } from './nations.js';
import { cameraMode } from './camera.js';
import { DayNight } from './dayNight.js';
import { createTerrainTextures } from './terrainTex.js';
import { ParticleSystem, EVENT_MAP as PARTICLE_EVENT_MAP, WEATHER as PARTICLE_WEATHER } from './particles.js';

// ================= THREE.JS 3D SCENE =================
// Replaces the Canvas 2D render pipeline with a Three.js 3D scene:
// - Procedural terrain from CONTINENT data (parchment toon shader)
// - InstancedMesh flies (3D boids from updateSim positions)
// - KayKit village rings + Kenney castle keeps (GLB kit)
// - Fog + lighting for atmosphere

// ---- task 32「文明演化系统一期」：纪元主题渐变 — 六档氛围调色板 ----------------------
// 每档只调灯光 / 雾 / 海面色（绝不重算地形顶点色 — 性能红线）。色值全部留在羊皮纸沙盘的
// 青-砂-金家族里，使每一档读起来都是同一个沙盘世界处于其文明的不同时辰。由 setCivStage()
// 应用、_updateCivFade() 在 ≤2s 内交叉淡入；空闲时每帧只花一个布尔判断（零分配）。
const CIV_FADE_S = 2.0;   // 过渡预算（任务硬约束：≤2s，到点自停）
const CIV_PALETTES = [
  // 0 部落晨雾 — 冷青雾 + 低饱和草色光（尚未营造的蜂群）
  { hemiSky: 0xa9c6c4, hemiGround: 0x9aa88a, sun: 0xdfe8dc, fog: 0xc3d8d6, water: 0x33858f },
  // 1 城邦青铜 — 暖铜方向光 + 骨白霭（最初的城邦）
  { hemiSky: 0xcfe0dc, hemiGround: 0xb08d5a, sun: 0xe8b070, fog: 0xd8d2c0, water: 0x2f8f9c },
  // 2 王国黄金 — 金黄方向光 + 暖雾（王国的黄金时代）
  { hemiSky: 0xd9e6d2, hemiGround: 0xc9a45e, sun: 0xffd27a, fog: 0xe6d8b4, water: 0x2f97a0 },
  // 3 帝国紫 — 品紫天光压深金（鼎盛帝国）
  { hemiSky: 0xb79ad0, hemiGround: 0xa8874e, sun: 0xe9c46a, fog: 0xc9b8cc, water: 0x357f97 },
  // 4 启蒙白 — 高亮中性关键光（理性时代）
  { hemiSky: 0xeaf2f4, hemiGround: 0xd8d2c2, sun: 0xfff4e0, fog: 0xe8eef0, water: 0x3a9aa6 },
  // 5 transcend 辉光 — teal×金发光混合（已越出沙盘的蜂群）
  { hemiSky: 0xa8e0d8, hemiGround: 0xd9b96a, sun: 0xf0e6b4, fog: 0xcfe6dc, water: 0x2fa8a0 },
];

// ---- ㉙ TEMPLE — the divine-act light pillar tints, one per intervention family ----
// A burn that lands fires a golden beam from the sky; the hue leans to the act's nature
// (plague → ashen, harvest → green-gold, decree → white-hot) but stays inside the gold family.
const TEMPLE_FX_COLOR = {
  ORACLE_WHISPER: 0xd9b968, CULTURAL_SEED: 0xbfd968, DIRECTED_MUTATION: 0x9ad9b0,
  MIRACLE_HARVEST: 0xd9c468, MIRACLE_PLAGUE: 0xb0a090, MIRACLE_REVELATION: 0xf0e6a0,
  MIRACLE_MIGRATION: 0x9ac8d9, NATION_BLESSING: 0xd9b968, DIVINE_DECREE: 0xfff0c0,
  HERO_SUMMONING: 0xe0a83c, EPOCH_SHAPING: 0xf0c060, WONDER_FOUNDATION: 0xd9b968,
};

export class ThreeScene {
  constructor() {
    this.scene = null;
    this.camera = null;
    this.renderer = null;
    this.controls = null;
    this.terrain = null;
    this.water = null;              // deep-sea plane: MeshStandardMaterial + scrolling normal map (no transmission, no mirror pass)
    this.sky = null;                // three.js official Sky (Preetham model)
    this.skyUniforms = null;        // task 49: the Sky shader uniforms, driven per-frame by dayNight
    this.dayNight = null;           // task 49: tick-driven day/night cycle (sun, lights, fog, stars, glow)
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
    this._castleLib = {};           // legacy GLB kit cache (task 24: procedural castles, never filled)
    this._castleLibLoading = false;
    this._castleLibReady = false;
    this._treeGroup = null;         // task 24: clustered instanced trees (broadleaf + conifer)
    this._wallGroup = null;         // task 47: great wall + beacon towers along borders
    this._canalMask = null;         // task 24: canal proximity field, filled by _sculptTerrain
    this._nationData = null;        // last updateNations() result { nationSeeds, voronoi, … }
    this._nationSig = "";           // applied partition signature — rebuild only on change
    this._terrSig = "";             // territory signature (zone owners + top-5 house rank)
    this.clock = new THREE.Clock();
    // ---- task 7: pre-allocated pools for the ported 2D layers (built in _initOverlays) ----
    this._socLineCap = 64;                     // max bond/feud segments on the social web
    this._socLines = null; this._socGrudge = null;
    this._socSig = "";                         // task 25④/46: ribbon rebuild signature (pairs + 2-unit-quantised ends)
    this._socRibbonPts = 18;                   // max sample points per bond ribbon (≈12-unit steps)
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
    this._dayPhaseEl = null; this._dayPhaseIcon = "";   // task 49: the ☀/🌅/🌙/🌄 watch glyph riding inside #era-hud
    this._castleWindowGeo = null; this._castleWindowMats = null;   // task 49: arrow-slits split out so they can glow at night
    // ---- task 32: civ-stage atmosphere cross-fade scratch (pre-allocated, never re-created in update()) ----
    this._civStage = null;            // current applied stage (null ⇒ never set ⇒ the first setCivStage snaps, no intro fade)
    this._civFadeStart = 0;           // performance.now() origin of the armed ≤2s cross-fade
    this._civFadeDone = true;         // idle flag — _updateCivFade() returns on this one boolean when settled
    this._civFrom = { hemiSky: new THREE.Color(), hemiGround: new THREE.Color(), sun: new THREE.Color(), fog: new THREE.Color(), water: new THREE.Color() };
    this._civTo = { hemiSky: new THREE.Color(), hemiGround: new THREE.Color(), sun: new THREE.Color(), fog: new THREE.Color(), water: new THREE.Color() };
    this._legendEl = null; this._legendSig = ""; this._legendT = -1e9;   // territory legend DOM
    this._raycaster = null; this._ndc = null; this._downX = 0; this._downY = 0;
    this._fwd = new THREE.Vector3(); this._v1 = new THREE.Vector3();
    this._fxSeen = new WeakSet();              // chronFx entries already turned into particles
    this.clock = new THREE.Clock();
    this.walkMode = null;                        // task 48: assigned by main.js after construction
    this._flyPosScratch = null;                  // task 48: reused by getFlyPosition (zero allocation)
    // ---- task 50: GPU particle weather — chronicle events become visible weather ----
    this.particles = null;                       // the single Points-based ParticleSystem (built in _initOverlays)
    this._pxSeenSeq = 0;                         // high-water mark over raw /annals rows already turned into particles
    this._pxNationCursor = 0;                    // round-robin nation pick for region-agnostic events
    this._weatherNextAt = 0;                     // performance.now() when the ambient weather next re-rolls
    this._snowMin = null;                        // cached high-country height gate for the snow layer
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
    this.scene.fog = new THREE.FogExp2(0xcfe3e6, 0.00085);   // diorama: faint teal haze so the horizon melts into the sea

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
    this.camera.position.set(0, 470, 430);      // diorama: high 3/4 bird's-eye so the island fills the frame

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
    this.controls.minDistance = 90;
    this.controls.maxDistance = 1200;              // diorama island: keep it frameable but never lost
    this.controls.target.set(0, 2, 0);
    this.controls.autoRotate = false;         // diorama: hold the composed 3/4 view steady for the reader
    this.controls.autoRotateSpeed = 0.3;
    this.controls.addEventListener("start", () => { this.controls.autoRotate = false; });

    // Sun-aligned key light + sky/ground bounce — the official ocean example's lighting recipe
    this.hemiLight = new THREE.HemisphereLight(0xbfe3ea, 0xd8c08a, 0.6);   // diorama: teal sky bounce + warm sand ground
    this.scene.add(this.hemiLight);
    this.sunLight = new THREE.DirectionalLight(0xffe0b0, 1.6);             // soft warm key light
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
      [this._initOverlays, 'overlays'],       // task 7: pre-allocate every ported 2D layer (social web, necropolis, payments, …)
    ];
    for (const [fn, name] of steps) {
      try { fn.call(this); } catch (e) { console.warn('[scene3d] step failed:', name, e); }
    }
    // task 49: the tick-driven day/night cycle. Built AFTER the sky/lights exist so it can bind
    // to them; isolated so a failure leaves the (still lit) scene intact rather than blank.
    try { this.dayNight = new DayNight(this); } catch (e) { console.warn('[scene3d] dayNight init failed:', e); }
  }

  // ---- sky: three.js official Sky addon (Preetham model, the webgl_shaders_sky example recipe) ----
  _buildSky() {
    const sky = new Sky();
    sky.scale.setScalar(45000);
    this.scene.add(sky);
    this.sky = sky;                       // task 49: dayNight drives this sky's uniforms per frame
    const u = sky.material.uniforms;
    this.skyUniforms = u;
    u["turbidity"].value = 5;
    u["rayleigh"].value = 2.2;
    u["mieCoefficient"].value = 0.004;
    u["mieDirectionalG"].value = 0.85;
    // task 49: this fixed sun is only the PMREM env-bake pose (the sea's sheen). The LIVE sun —
    // its position, the key light and every sky uniform — is recomputed each frame by dayNight
    // off the simulation tick, so the elevation/azimuth here are no longer the rendered truth.
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

  // ---- sea: the original diorama recipe — a plain MeshStandardMaterial plane whose sheen comes
  // from the PMREM sky env + a slowly scrolling waternormals.jpg. Zero extra render passes,
  // depthWrite:false, renderOrder:1. (task 51's custom ShaderMaterial is REVERTED: it rendered the
  // plane as a translucent checkerboard wash and its missing .color broke the civ-palette fade.) ----
  _buildWater() {
    const geo = new THREE.PlaneGeometry(8000, 8000, 1, 1);   // oversized so edges vanish inside FogExp2 (density 0.00085 → full absorption well before 4000 units)
    const normals = new THREE.TextureLoader().load("./assets/waternormals.jpg", (t) => {
      t.wrapS = t.wrapT = THREE.RepeatWrapping;
      t.repeat.set(48, 48);
    });
    normals.wrapS = normals.wrapT = THREE.RepeatWrapping;   // sane wrap/repeat even before the texture streams in
    normals.repeat.set(48, 48);
    const mat = new THREE.MeshStandardMaterial({
      color: 0x2f93a2,             // diorama teal sea (#2e8b9a~#3a9aad), calm and saturated
      transparent: true,
      opacity: 0.92,
      roughness: 0.42,             // calm: broad soft sheen, no storm glitter
      metalness: 0.05,
      envMapIntensity: 0.8,        // the PMREM sky supplies a gentle sheen (no transmission pass)
      normalMap: normals,
      normalScale: new THREE.Vector2(0.22, 0.22),   // barely-there ripple - a still diorama sea
      side: THREE.DoubleSide,
      depthWrite: false,          // the sea never writes depth - coastal vertices that
    });                           // graze y=0 can no longer z-fight the plane (terrain draws first)
    this.water = new THREE.Mesh(geo, mat);
    this.water.rotation.x = -Math.PI / 2;
    this.water.position.y = 0.0;   // sea surface at y=0; the beach sand ring rises above it
    this.water.renderOrder = 1;    // opaque terrain -> sea(1) -> canal water(2) -> banks(3)
    this.scene.add(this.water);
  }

  // ---- the land: a model piece with a readable coastline, cliff sides and crisp painted height bands ----
  _buildTerrain() {
    const WSX = 720, WSZ = 450, N = 321;
    this._WSX = WSX; this._WSZ = WSZ;
    const geo = new THREE.PlaneGeometry(WSX, WSZ, N - 1, N - 1);

    // three.js official ImprovedNoise (Perlin)
    const perlin = new ImprovedNoise();
    const fbm = (x, z, s) => {
      let v = 0, amp = 1, freq = 1;
      for (let o = 0; o < 4; o++) { v += perlin.noise(x * freq + s, 31.7, z * freq - s) * amp; amp *= 0.5; freq *= 2.07; }
      return v / 1.875;                       // ≈ [-1, 1]
    };
    const ridge = (x, z) => 1 - Math.abs(perlin.noise(x, 7.3, z));   // ridged noise → sharp mountain crests
    const ss = (t) => t * t * (3 - 2 * t);
    const cl01 = (t) => t < 0 ? 0 : t > 1 ? 1 : t;

    // ---- diorama ISLAND mask (task 24): an organic rounded island with a wobbly coastline
    // (peninsulas & bays from angular noise), open teal sea outside. Returns signed inlandness:
    // >0 on land, <0 in the sea; the edge falls below sea level so the beach ring reads clean. ----
    const islandE = (nx, nz) => {
      const dx = (nx - 0.5) * 2, dz = (nz - 0.5) * 2;
      const ang = Math.atan2(dz, dx);
      const ca = Math.cos(ang), sa = Math.sin(ang);
      const w = 1 + 0.20 * perlin.noise(ca * 1.35 + 11.1, 4.4, sa * 1.35 - 7.7)
                  + 0.10 * perlin.noise(ca * 2.9 - 3.3, 9.1, sa * 2.9 + 2.2);
      return 0.90 * w - Math.hypot(dx, dz);
    };

    const PLATEAU = 3.0;
    const raw = new Float32Array(N * N);
    for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) {
      const x = -WSX / 2 + (i / (N - 1)) * WSX;
      const z = -WSZ / 2 + (j / (N - 1)) * WSZ;
      const e = islandE((x + WSX / 2) / WSX, (z + WSZ / 2) / WSZ);
      if (e <= 0) { raw[j * N + i] = -3.2 * ss(cl01(-e / 0.35)); continue; }   // seabed dips away from shore
      const beach = 1.5 * ss(cl01(e / 0.12));                       // sand ring at the waterline
      const inland = ss(cl01((e - 0.08) / 0.40));                   // 0 at coast → 1 well inland
      const plains = (fbm(x * 0.0071 + 11.3, z * 0.0071 - 4.1, 0) + 0.55) * 2.2;   // rolling lowland
      const rm = Math.max(0, ridge(x * 0.010 + 9.2, z * 0.010 - 3.7) - 0.45);      // crest mask
      const gate = Math.pow(cl01(0.5 + 0.5 * fbm(x * 0.0035, z * 0.0035, 77)), 1.6);   // snow-mountain clusters
      raw[j * N + i] = beach + inland * ((PLATEAU - 1.5) + plains + rm * rm * 62 * gate);
    }
    // two blur passes: soften the coastline into a readable beach, no jaggies
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
    this._hBase = h.slice();   // pristine field — _sculptTerrain() always re-cuts from this (idempotent)
    this._canalMask = new Float32Array(N * N);   // canal proximity (water core→bank), filled by _sculptTerrain
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

    // task 51 (redo): wowser-style terrain splatting on top of the FULL PBR pipeline.
    // Portions adapted from wowserhq/scene (MIT), © Wowser Contributors.
    // The land is a MeshStandardMaterial, so it keeps env-map sheen (scene.environment), the real
    // sun/hemi lights, FogExp2 and ACES tone-mapping; onBeforeCompile only injects the 4-layer
    // albedo splat + a detail-normal micro-relief. dayNight.js already drives tm.envMapIntensity
    // (1.0→0.10) so the land dims at night alongside everything else.
    const texSet = createTerrainTextures();
    const splatUniforms = {
      tGrass: { value: texSet.grass },
      tRock:  { value: texSet.rock },
      tSand:  { value: texSet.sand },
      tSnow:  { value: texSet.snow },
      tDetailNormal: { value: texSet.detailNormal },
      // 64 world units per tile → ~11×7 repeats over the 720×450 island (was 90×56 → obvious tiling)
      uTexScale: { value: new THREE.Vector2(1 / 64, 1 / 64) },
    };
    this._terrainUniforms = splatUniforms;

    const terrainMat = new THREE.MeshStandardMaterial({
      roughness: 0.86,
      metalness: 0.0,
      vertexColors: false,
      envMapIntensity: 1.0,
      dithering: true,
    });
    // unique cache key → the splat program is never shared with other MeshStandardMaterials
    terrainMat.customProgramCacheKey = () => 'murmur-terrain-splat-v2';
    terrainMat.onBeforeCompile = (shader) => {
      Object.assign(shader.uniforms, splatUniforms);

      // vertex: carry splat weights, nation colour and world position into the fragment stage
      shader.vertexShader = shader.vertexShader.replace(
        '#include <common>',
        `#include <common>
         attribute vec4 aSplat;
         attribute vec3 aNation;
         varying vec4 vSplat;
         varying vec3 vNation;
         varying vec3 vWorldPos2;`
      );
      shader.vertexShader = shader.vertexShader.replace(
        '#include <begin_vertex>',
        `#include <begin_vertex>
         vSplat = aSplat;
         vNation = aNation;
         vWorldPos2 = (modelMatrix * vec4(position, 1.0)).xyz;`
      );

      // fragment: declare the splat samplers + varyings
      shader.fragmentShader = shader.fragmentShader.replace(
        '#include <common>',
        `#include <common>
         uniform sampler2D tGrass, tRock, tSand, tSnow, tDetailNormal;
         uniform vec2 uTexScale;
         varying vec4 vSplat;
         varying vec3 vNation;
         varying vec3 vWorldPos2;`
      );
      // albedo: world-space multi-layer splat (square tiles, per-layer offsets hide repetition)
      shader.fragmentShader = shader.fragmentShader.replace(
        '#include <map_fragment>',
        `vec2 tUv = vWorldPos2.xz * uTexScale;
         vec3 cG = texture2D(tGrass, tUv).rgb;
         vec3 cR = texture2D(tRock,  tUv * 1.37 + 0.31).rgb;
         vec3 cS = texture2D(tSand,  tUv * 0.73 + 0.67).rgb;
         vec3 cN = texture2D(tSnow,  tUv * 1.13 + 0.13).rgb;
         vec3 splatAlbedo = cG * vSplat.x + cR * vSplat.y + cS * vSplat.z + cN * vSplat.w;
         splatAlbedo = mix(splatAlbedo, vNation, 0.08);
         diffuseColor.rgb = splatAlbedo;`
      );
      // roughness: snow/rock read smoother (icy / wet sheen), grass + sand stay matte
      shader.fragmentShader = shader.fragmentShader.replace(
        '#include <roughnessmap_fragment>',
        `#include <roughnessmap_fragment>
         roughnessFactor = clamp(roughnessFactor - vSplat.w * 0.30 - vSplat.y * 0.12, 0.34, 1.0);`
      );
      // detail normal: micro-relief so the ground is never flat (subtle tangent-space tilt)
      shader.fragmentShader = shader.fragmentShader.replace(
        '#include <normal_fragment_maps>',
        `#include <normal_fragment_maps>
         vec3 dn = texture2D(tDetailNormal, tUv * 3.0).xyz * 2.0 - 1.0;
         normal = normalize(normal + vec3(dn.xy, 0.0) * 0.45);`
      );
    };
    this.terrain = new THREE.Mesh(geo, terrainMat);
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
    this._buildTrees();
    this._buildBorderWalls();   // task 47: great wall + beacon towers along the meandered border lines
    this._nationSig = sig;   // mark applied only after the full rebuild: a throw above leaves it unset so the next frame retries
  }

  // ---- task 51: wowser-style splat weights + nation tint attributes.
  // Replaces the old vertex-colour RAMP with per-vertex vec4 layer weights (grass/rock/sand/snow)
  // computed from height + slope, plus a vec3 nation colour. The fragment shader blends 4
  // procedural textures by these weights — near-view texture detail, far-view natural gradients. ----
  _colorTerrain(owners) {
    const N = this._hN, h = this._hGrid;
    const geo = this.terrain.geometry;
    const pos = geo.attributes.position;
    const count = pos.count;
    const stX = this._hStepX, stZ = this._hStepZ;
    const pn = this._noise;
    const perlinJit = (i, j) => pn.noise(i * 0.31, 5.1, j * 0.31);
    const canal = this._canalMask;
    const cl01 = (t) => t < 0 ? 0 : t > 1 ? 1 : t;
    const ss = (t) => { const x = cl01(t); return x * x * (3 - 2 * x); };

    // allocate splat attribute if needed
    let splat = geo.attributes.aSplat;
    if (!splat) {
      splat = new THREE.BufferAttribute(new Float32Array(count * 4), 4);
      geo.setAttribute('aSplat', splat);
    }
    let nation = geo.attributes.aNation;
    if (!nation) {
      nation = new THREE.BufferAttribute(new Float32Array(count * 3), 3);
      geo.setAttribute('aNation', nation);
    }
    const sa = splat.array, na = nation.array;

    // normals are already computed by _sculptTerrain
    const norms = geo.attributes.normal;

    for (let k = 0; k < count; k++) {
      const i = k % N, j = (k / N) | 0;
      const y = h[k];
      const jit = perlinJit(i, j) * 1.2;   // dither layer boundaries
      const yh = y + jit;   // jittered height for band transitions

      // slope from normal Y component (normal is in local plane space, Z is up before rotation)
      const ny = norms ? Math.abs(norms.getZ(k)) : 1;   // plane local Z = world Y after rotation
      const slope = 1 - ny;

      // layer weights: sand(x→z), grass(x), rock(y), sand(z), snow(w)
      let wGrass = 0, wRock = 0, wSand = 0, wSnow = 0;

      // sand: coastal band, h ∈ [-1.5, 2.5]
      wSand = ss((2.5 - yh) / 3.0) * (1 - ss((yh - (-1.5)) / 2.0));
      wSand = yh < 2.5 ? ss((2.5 - yh) / 3.5) : 0;
      if (yh < -0.5) wSand = 1;   // seabed is all sand

      // snow: h > 14
      wSnow = ss((yh - 14) / 5);

      // rock: slope-driven + high altitude
      const slopeRock = ss((slope - 0.25) / 0.35);
      const altRock = ss((yh - 8) / 5);
      wRock = Math.max(slopeRock, altRock * 0.7);
      wRock *= (1 - wSnow);   // snow covers rock at peaks

      // grass: fills the remainder in the mid-band
      wGrass = Math.max(0, 1 - wSand - wRock - wSnow);
      if (yh > 3 && yh < 12) wGrass = Math.max(wGrass, (1 - wRock - wSnow) * 0.9);

      // canal override: water core → sand/water, bank → sand
      const cm = canal ? canal[k] : 0;
      if (cm > 0.02) {
        const bank = cl01((cm - 0.10) / 0.20);
        const water = cl01((cm - 0.45) / 0.30);
        wSand = Math.max(wSand, bank);
        wGrass *= (1 - bank);
        wRock *= (1 - bank);
        if (water > 0) { wSand = Math.max(wSand, water); wGrass *= (1 - water); wRock *= (1 - water); wSnow *= (1 - water); }
      }

      // normalize
      const sum = wGrass + wRock + wSand + wSnow;
      if (sum > 0.001) { wGrass /= sum; wRock /= sum; wSand /= sum; wSnow /= sum; }
      else { wGrass = 1; wRock = 0; wSand = 0; wSnow = 0; }

      sa[k * 4]     = wGrass;
      sa[k * 4 + 1] = wRock;
      sa[k * 4 + 2] = wSand;
      sa[k * 4 + 3] = wSnow;

      // nation colour from the Voronoi zone id
      const nid = getNationId(k);
      const nc = getNationColor(nid);
      if (nc) { na[k * 3] = nc.r; na[k * 3 + 1] = nc.g; na[k * 3 + 2] = nc.b; }
      else { na[k * 3] = 0.5; na[k * 3 + 1] = 0.5; na[k * 3 + 2] = 0.5; }
    }
    splat.needsUpdate = true;
    nation.needsUpdate = true;
  }

  // bilinear sample of the baked height field (flies ride the relief, settlements sit on the land)
  heightAt(x, z) { return this._sampleH(this._hGrid, x, z); }

  // ---- task 48: fly accessors for walkMode third-person chase ----
  flyCount() { return this._flyCount | 0; }
  flyIdAt(i) { const f = this._flyArr[i | 0]; return f ? f.id : null; }
  flyIndexOf(id) { const n = this._flyCount | 0, a = this._flyArr; for (let i = 0; i < n; i++) { const f = a[i]; if (f && f.id === id) return i; } return -1; }
  getFlyPosition(i) {
    const out = this._flyPosScratch || (this._flyPosScratch = { x: 0, y: 0, z: 0 });
    const body = this.flyBody; const n = this._flyCount | 0; const idx = i | 0;
    if (!body || !(idx >= 0) || idx >= n) return null;
    body.getMatrixAt(idx, this._m4);
    const e = this._m4.elements; out.x = e[12]; out.y = e[13]; out.z = e[14];
    return out;
  }

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
    const ss = (t) => t * t * (3 - 2 * t);

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
    // ② the nation capitals — the monochrome castle footprint (wall R13 + towers ≈16)
    const seeds = nat && Array.isArray(nat.nationSeeds) ? nat.nationSeeds : null;
    if (seeds) for (const s of seeds) if (s && isFinite(s.x) && isFinite(s.z)) press(s.x, s.z, 24, 36);

    // ③ diorama CANALS (task 24, meandered task 25②): carve the waterway groove along the SAME
    // meander runs buildBorderMesh lays its ribbon on (nations.js caches them by edge signature).
    // Inland groove floor never drops below CANAL_MIN; estuary (mouth>0) segments may dive under
    // the sea so the canal connects to the ocean naturally. canalMask feeds _colorTerrain banks.
    const mask = this._canalMask || (this._canalMask = new Float32Array(N * N));
    mask.fill(0);
    const CANAL_D = 1.6, CANAL_R = 4.0, CANAL_MIN = 0.3;
    const mRuns = meanderEdges(voronoiEdges(nat && nat.voronoi ? nat.voronoi : null), (x, z) => this._sampleH(base, x, z));
    for (const line of mRuns) for (const pt of line) {
      const cx = pt[0], cz = pt[1], mouth = pt[2];
      if (mouth <= 0 && this._sampleH(base, cx, cz) < 1.0) continue;   // never cut a land canal through beach/sea
      const R = CANAL_R + mouth * 2.6;                                 // the trumpet mouth widens the groove
      const i0 = Math.max(0, Math.floor((cx - R + WSX / 2) / stX));
      const i1 = Math.min(N - 1, Math.ceil((cx + R + WSX / 2) / stX));
      const j0 = Math.max(0, Math.floor((cz - R + WSZ / 2) / stZ));
      const j1 = Math.min(N - 1, Math.ceil((cz + R + WSZ / 2) / stZ));
      for (let j = j0; j <= j1; j++) {
        const dzc = -WSZ / 2 + j * stZ - cz;
        for (let i = i0; i <= i1; i++) {
          const dxc = -WSX / 2 + i * stX - cx;
          const dd = Math.sqrt(dxc * dxc + dzc * dzc);
          if (dd > R) continue;
          const k = j * N + i;
          if (mouth <= 0 && base[k] < 1.0) continue;
          const w = 1 - ss(dd / R);
          const floor = mouth > 0 ? -1.7 : CANAL_MIN;   // estuary floor may sit below sea level
          h[k] = Math.max(floor, h[k] - (CANAL_D + mouth * 2.2) * w);
          if (w > mask[k]) mask[k] = w;
        }
      }
    }

    // ③ (task 25) SURF STEP: the sea plane lives at y=0, so any terrain vertex grazing 0 z-fights
    // it (the flickering shoals). Push the whole coplanar band (−0.55, 0.30) out to two flat
    // shelves — a +0.34 sand step above the waterline and a −0.60 surf shelf below — with a
    // smoothstep-eased lip; the coastline contour keeps its shape, the coplanar band is gone.
    for (let k = 0; k < h.length; k++) {
      const vv = h[k];
      if (vv >= 0.30 || vv <= -0.55) continue;
      if (vv >= 0) { const t = ss(vv / 0.30); h[k] = 0.34 + t * t * 0.06; }
      else { const t = ss(-vv / 0.55); h[k] = -0.60 - t * t * 0.06; }
    }

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
    // task 49: the bodies carry a warm emissive that dayNight lifts at night — the swarm reads as
    // fireflies over the dark island. emissiveIntensity starts at 0 (invisible in daylight).
    this.flyBody = new THREE.InstancedMesh(bodyGeo,
      new THREE.MeshToonMaterial({ gradientMap: this._toonRamp(), vertexColors: true, emissive: 0xffd27a, emissiveIntensity: 0 }), 120);
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

  // ---- castle kit (legacy, task 24): the Kenney/KayKit GLB pipeline is retired — castles and
  // villages are now fully procedural (see _rebuildCastles / _rebuildVillages), so no asset is
  // ever fetched. Kept as a no-op because the field names (_castleLib*) survive in the ctor. ----
  _loadCastleAssets() {
    return;
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

  // ---- the five nation castles (task 24 diorama, task 25① detail pass, task 46 refinement): fully
  // procedural MONOCHROME castles — one palette per nation. Each kit now carries: 3-tier base steps,
  // a gatehouse (twin flanking towers + dark recessed passage + half-cylinder arch + portcullis bars),
  // crenellation teeth on the curtain wall and every flat tower top, four tall corner towers with
  // arrow-slit windows (16-seg for smooth cones), four low wall towers plus four keep turrets (cones
  // seated on cornice rings), three courtyard cottages with gabled prism roofs + windows, a stone
  // courtyard well, and triangular pennant flags on the tall towers + keep.
  // Stonework vertex colours carry a ±12% same-hue mottle so walls read as dressed masonry.
  // Merged into FOUR shared geometries (stone / roof / wood / flag) → 4 meshes per castle,
  // 5 castles = 20 draw calls. Footprint ≈32 units, embedded in its own pressed mesa. ----
  _rebuildCastles() {
    for (const child of [...this.castleGroup.children]) {
      this.castleGroup.remove(child);
      // per-nation toon materials are disposable (the shared caches live on this._castle*Geo)
      child.traverse((o) => { if (o.material) o.material.dispose(); });
    }
    this._castleWindowMats = [];   // task 49: the just-disposed window materials are gone; repopulated below
    const nat = this._nationData;
    if (!nat || !Array.isArray(nat.nationSeeds) || !nat.nationSeeds.length) return;

    if (!this._castleStoneGeo) {
      // vertex-colour fill; mottle = ±6% same-hue light/dark perturbation baked per vertex
      const solid = (g, rgb, mottle) => {
        const gi = g.index ? g.toNonIndexed() : g;
        const pos = gi.attributes.position;
        const n = pos.count;
        const arr = new Float32Array(n * 3);
        for (let i = 0; i < n; i++) {
          let m = 1;
          if (mottle) {
            const x = pos.getX(i), y = pos.getY(i), z = pos.getZ(i);
            m = 1 + mottle * (0.62 * Math.sin(x * 2.7 + y * 4.3 + z * 1.9) + 0.38 * Math.sin(x * 0.9 - z * 3.7 + y * 1.3));
          }
          arr[i * 3] = rgb[0] * m; arr[i * 3 + 1] = rgb[1] * m; arr[i * 3 + 2] = rgb[2] * m;
        }
        gi.setAttribute("color", new THREE.BufferAttribute(arr, 3));
        return gi;
      };
      const W = [1, 1, 1];              // stonework (nation palette multiplies it)
      const BASE = [0.78, 0.76, 0.72];  // plinth: a touch darker dressed stone
      const LITE = [0.97, 0.95, 0.90];  // courtyard cottage plaster
      const WOOD = [0.42, 0.30, 0.20];  // doors / flag poles
      const DARK = [0.20, 0.14, 0.10];  // the recessed gate passage
      const WIN = [0.08, 0.06, 0.12];   // window voids — near-black with a purple cast
      const stone = [], roof = [], wood = [], flag = [], windows = [];   // task 49: windows split out so they can glow
      const MOT = 0.12;  // task 46: doubled mottle (was 0.06) for visible stonework texture
      const merlonRing = (cx, cz, r, y, count, mw, mh, md) => {
        for (let i = 0; i < count; i++) {
          const a = (i / count) * Math.PI * 2;
          const b = new THREE.BoxGeometry(mw, mh, md);
          b.rotateY(-a);
          b.translate(cx + Math.cos(a) * r, y, cz + Math.sin(a) * r);
          stone.push(solid(b, W, MOT));
        }
      };
      // ---- task 46: base steps — 3 concentric rings below the plinth for a grounded feel ----
      for (let s = 0; s < 3; s++) {
        const sr = 17.2 + s * 1.4, sh = 0.55;
        const step = new THREE.CylinderGeometry(sr, sr + 0.3, sh, 36);
        step.translate(0, -2.6 - s * sh, 0);
        stone.push(solid(step, BASE, MOT * 0.6));
      }
      // plinth + curtain wall + battlement ring + crenellation teeth
      const plinth = new THREE.CylinderGeometry(15.5, 16.2, 2.0, 40); plinth.translate(0, -1.6, 0);
      stone.push(solid(plinth, BASE, MOT * 0.8));
      const wall = new THREE.CylinderGeometry(13, 14.2, 6, 28, 1, true); wall.translate(0, 2.4, 0);
      stone.push(solid(wall, W, MOT));
      const batt = new THREE.CylinderGeometry(13.5, 13.5, 1.2, 28); batt.translate(0, 6.1, 0);
      stone.push(solid(batt, W, MOT));
      merlonRing(0, 0, 13.5, 7.05, 28, 1.0, 0.9, 0.8);
      // four TALL corner towers: shaft + cornice ring + conical roof (16-seg for smoothness); windows
      const flagTops = [];
      for (let t = 0; t < 4; t++) {
        const a = Math.PI * (0.25 + 0.5 * t);
        const tx = Math.cos(a) * 13, tz = Math.sin(a) * 13;
        const tw = new THREE.CylinderGeometry(2.6, 3.0, 13, 16); tw.translate(tx, 5.9, tz);
        stone.push(solid(tw, W, MOT));
        const cor = new THREE.CylinderGeometry(3.3, 3.4, 0.55, 16); cor.translate(tx, 12.6, tz);
        stone.push(solid(cor, W, MOT));
        const tr = new THREE.ConeGeometry(3.2, 5.2, 16); tr.translate(tx, 15.5, tz);
        roof.push(solid(tr, W, MOT * 0.6));
        // task 46: arrow-slit windows on each tall tower (3 per tower, facing outward)
        for (let wi = 0; wi < 3; wi++) {
          const wy = 4.0 + wi * 3.4;
          const wa = a + (wi - 1) * 0.35;
          const wx = tx + Math.cos(wa) * 2.7, wz = tz + Math.sin(wa) * 2.7;
          const win = new THREE.BoxGeometry(0.4, 1.2, 0.7);
          win.rotateY(-wa);
          win.translate(wx, wy, wz);
          windows.push(solid(win, WIN, 0));
        }
        if (t < 3) flagTops.push([tx, 18.1, tz, a]);
      }
      // three LOW wall towers: shaft + cap + crenellation ring (the 4th low tower is the gate tower)
      for (let t = 0; t < 3; t++) {
        const a = Math.PI * (0.5 + 0.5 * t);
        const tx = Math.cos(a) * 13, tz = Math.sin(a) * 13;
        const tw = new THREE.CylinderGeometry(2.2, 2.6, 8, 12); tw.translate(tx, 3.4, tz);
        stone.push(solid(tw, W, MOT));
        const cap = new THREE.CylinderGeometry(2.5, 2.5, 0.5, 12); cap.translate(tx, 7.6, tz);
        stone.push(solid(cap, W, MOT));
        merlonRing(tx, tz, 2.2, 8.2, 8, 0.7, 0.7, 0.6);
        // task 46: single window slit on each low tower
        const wx = tx + Math.cos(a) * 2.3, wz = tz + Math.sin(a) * 2.3;
        const lwin = new THREE.BoxGeometry(0.35, 0.9, 0.6); lwin.rotateY(-a); lwin.translate(wx, 4.2, wz);
        windows.push(solid(lwin, WIN, 0));
      }
      // GATEHOUSE: twin flanking towers with conical caps + dark recessed passage + stone arch
      for (const sz of [-3.6, 3.6]) {
        const gt = new THREE.CylinderGeometry(2.0, 2.4, 9, 12); gt.translate(12.2, 3.9, sz);
        stone.push(solid(gt, W, MOT));
        const gc = new THREE.ConeGeometry(2.5, 3.2, 12); gc.translate(12.2, 9.9, sz);
        roof.push(solid(gc, W, MOT * 0.6));
      }
      // task 46: portcullis hint — vertical dark bars across the gate opening
      for (let pb = -1; pb <= 1; pb++) {
        const bar = new THREE.BoxGeometry(0.15, 3.2, 0.15); bar.translate(13.2, 1.8, pb * 0.8);
        wood.push(solid(bar, DARK, 0));
      }
      const recess = new THREE.BoxGeometry(3.4, 3.6, 2.8); recess.translate(13.2, 1.8, 0);
      wood.push(solid(recess, DARK, 0));
      const arch = new THREE.CylinderGeometry(1.7, 1.7, 4.6, 12, 1, true, 0, Math.PI);
      arch.rotateZ(Math.PI / 2);   // axis → X (gate depth); the half tube spans the passage top
      arch.translate(13.2, 3.5, 0);
      stone.push(solid(arch, W, MOT));
      // gate tower (4th low tower) crowning the arch, with its own crenellation ring
      const gtw = new THREE.CylinderGeometry(2.3, 2.6, 5.5, 12); gtw.translate(11.6, 8.2, 0);
      stone.push(solid(gtw, W, MOT));
      merlonRing(11.6, 0, 2.3, 11.2, 8, 0.7, 0.7, 0.6);
      // central keep: shaft + cornice + spire (16-seg) + four corner turrets on cornice rings
      const keep = new THREE.CylinderGeometry(4.6, 5.2, 15, 16); keep.translate(0, 6.9, 0);
      stone.push(solid(keep, W, MOT));
      const kcor = new THREE.CylinderGeometry(5.5, 5.6, 0.6, 16); kcor.translate(0, 14.5, 0);
      stone.push(solid(kcor, W, MOT));
      const keepRoof = new THREE.ConeGeometry(5.4, 7, 16); keepRoof.translate(0, 18.3, 0);
      roof.push(solid(keepRoof, W, MOT * 0.6));
      // task 46: keep windows — 4 tall arched windows facing cardinal directions
      for (let kw = 0; kw < 4; kw++) {
        const ka = kw * Math.PI * 0.5;
        const kwx = Math.cos(ka) * 4.8, kwz = Math.sin(ka) * 4.8;
        const kwin = new THREE.BoxGeometry(0.5, 2.2, 0.9); kwin.rotateY(-ka); kwin.translate(kwx, 9.5, kwz);
        windows.push(solid(kwin, WIN, 0));
        // a smaller upper window
        const kwin2 = new THREE.BoxGeometry(0.4, 1.4, 0.7); kwin2.rotateY(-ka); kwin2.translate(kwx * 0.95, 13.0, kwz * 0.95);
        windows.push(solid(kwin2, WIN, 0));
      }
      flagTops.push([0, 21.8, 0, 0]);
      for (const [qx, qz] of [[3.4, 3.4], [-3.4, 3.4], [3.4, -3.4], [-3.4, -3.4]]) {
        const ts = new THREE.CylinderGeometry(1.2, 1.4, 7, 10); ts.translate(qx, 13.2, qz);
        stone.push(solid(ts, W, MOT));
        const tc = new THREE.CylinderGeometry(1.7, 1.8, 0.35, 10); tc.translate(qx, 16.9, qz);
        stone.push(solid(tc, W, MOT));
        const tr = new THREE.ConeGeometry(1.7, 2.6, 10); tr.translate(qx, 18.4, qz);
        roof.push(solid(tr, W, MOT * 0.6));
      }
      // courtyard: three plaster cottages (box body + gabled prism roof + door + window) fill the ward
      for (let i = 0; i < 3; i++) {
        const a = 1.75 + i * 1.91;
        const hx = Math.cos(a) * 8.2, hz = Math.sin(a) * 8.2;
        const body = new THREE.BoxGeometry(3.6, 2.8, 3.0);
        body.rotateY(-a);
        body.translate(hx, 1.4, hz);
        stone.push(solid(body, LITE, MOT * 0.7));
        const rg = new THREE.CylinderGeometry(1.9, 1.9, 4.2, 3, 1);   // triangular prism = gable
        rg.rotateZ(Math.PI / 2); rg.rotateX(-Math.PI / 2); rg.scale(1, 0.8, 1);
        rg.rotateY(-a);
        rg.translate(hx, 3.7, hz);
        roof.push(solid(rg, W, MOT * 0.6));
        const door = new THREE.BoxGeometry(0.25, 1.5, 1.0);
        door.rotateY(-a);
        door.translate(hx + Math.cos(a) * 1.85, 0.75, hz + Math.sin(a) * 1.85);
        wood.push(solid(door, WOOD, 0));
        // task 46: cottage window — a small dark pane beside the door
        const cwa = a + 0.55;
        const cwx = hx + Math.cos(cwa) * 1.82, cwz = hz + Math.sin(cwa) * 1.82;
        const cw = new THREE.BoxGeometry(0.15, 0.7, 0.6); cw.rotateY(-a); cw.translate(cwx, 1.8, cwz);
        windows.push(solid(cw, WIN, 0));
      }
      // ---- task 46: courtyard WELL — stone ring + timber frame + tiny cone roof ----
      {
        const wa = 3.6, wr = 5.5;
        const wx = Math.cos(wa) * wr, wz = Math.sin(wa) * wr;
        const wellRing = new THREE.TorusGeometry(0.9, 0.3, 8, 12); wellRing.rotateX(Math.PI / 2); wellRing.translate(wx, 0.6, wz);
        stone.push(solid(wellRing, BASE, MOT));
        // two uprights
        for (const s of [-0.6, 0.6]) {
          const up = new THREE.CylinderGeometry(0.1, 0.1, 2.4, 6); up.translate(wx + s, 1.8, wz);
          wood.push(solid(up, WOOD, 0));
        }
        const wellRoof = new THREE.ConeGeometry(1.2, 0.9, 8); wellRoof.translate(wx, 3.3, wz);
        roof.push(solid(wellRoof, W, MOT * 0.5));
      }
      // FLAGS: triangular pennants (PlaneGeometry, double-sided) on poles at 3 tall towers + keep
      for (const [fx, fy, fz, fa] of flagTops) {
        const pole = new THREE.CylinderGeometry(0.14, 0.14, 3.4, 6); pole.translate(fx, fy + 1.7, fz);
        wood.push(solid(pole, WOOD, 0));
        const pg = new THREE.PlaneGeometry(2.6, 1.2, 3, 1);
        const pp = pg.attributes.position;
        for (let k = 0; k < pp.count; k++) {
          const x = pp.getX(k);
          if (x > 1.2) pp.setY(k, 0);                     // collapse the fly end → a triangle pennant
          pp.setZ(k, 0.22 * Math.sin((x + 1.3) * 1.8));   // a whisper of cloth wave
        }
        pg.computeVertexNormals();
        pg.rotateY(-fa);
        pg.translate(fx + Math.cos(fa) * 1.35, fy + 2.9, fz + Math.sin(fa) * 1.35);
        flag.push(solid(pg, W, 0));
      }
      this._castleStoneGeo = mergeGeometries(stone, false);
      this._castleRoofGeo = mergeGeometries(roof, false);
      this._castleWoodGeo = mergeGeometries(wood, false);
      this._castleFlagGeo = mergeGeometries(flag, false);
      this._castleWindowGeo = mergeGeometries(windows, false);   // task 49: every arrow-slit/pane in one shared mesh
    }

    // nation id → monochrome palette { s: stonework, r: roofs } — amber / gold / cream / grey / crimson
    const PAL = [
      { s: 0xd98a2b, r: 0xa85f14 },
      { s: 0xe0b23c, r: 0xb98a1c },
      { s: 0xece4d2, r: 0xcfc4a8 },
      { s: 0x9a9a96, r: 0x666662 },
      { s: 0xb03040, r: 0x7e1c2a },
    ];
    for (let i = 0; i < nat.nationSeeds.length; i++) {
      const seed = nat.nationSeeds[i];
      const pal = PAL[i % PAL.length];
      // _sculptTerrain has already pressed a flat mesa under every capital — groundY over the
      // plinth radius (16.2) reads the mesa top; the −0.4 embed sinks just the plinth skirt.
      const baseY = this.groundY(seed.x, seed.z, 17) - 0.4;
      const group = new THREE.Group();
      group.position.set(seed.x, baseY, seed.z);
      group.rotation.y = (i * 1.7) % (Math.PI * 2);   // vary the orientation so the five read distinct
      // 4 meshes per castle (stone / roof / wood / flag) → 5 castles = 20 draw calls
      group.add(new THREE.Mesh(this._castleStoneGeo, this._toon(pal.s, { vertexColors: true })));
      group.add(new THREE.Mesh(this._castleRoofGeo, this._toon(pal.r, { vertexColors: true })));
      group.add(new THREE.Mesh(this._castleWoodGeo, this._toon(0xffffff, { vertexColors: true })));
      group.add(new THREE.Mesh(this._castleFlagGeo, this._toon(pal.s, { vertexColors: true, side: THREE.DoubleSide })));
      // task 49: a 5th mesh carries the window voids on an emissive material. Diffuse stays the
      // near-black WIN vertex colour by day; at night dayNight lifts emissiveIntensity so every
      // arrow-slit banks like a hearth. One extra draw call per castle (25 total) — no new lights.
      const winMat = this._toon(0xffffff, { vertexColors: true, emissive: 0xff9030, emissiveIntensity: 0 });
      group.add(new THREE.Mesh(this._castleWindowGeo, winMat));
      this._castleWindowMats.push(winMat);
      this.castleGroup.add(group);
    }
  }

  // ============================ ㉙ TEMPLE — divine 3D read-outs ============================
  // A burn that lands is felt in the world: a golden pillar drops from the sky, founded wonders
  // rise beside their nation's castle, and summoned heroes wear a breathing halo. All read-only
  // off state.templeData (the GET /temple cache); every mesh is pooled/disposed, nothing per-frame
  // allocates beyond the occasional pillar.

  /** Fire a temporary golden light pillar descending onto `pos` ({x,y,z}); fades over ~3s. */
  templeEffect(kind, pos) {
    if (!this.scene || !pos) return;
    if (!this._templeFx) this._templeFx = [];
    const col = TEMPLE_FX_COLOR[kind] || 0xd9b968;
    const h = 90;
    const geo = new THREE.CylinderGeometry(0.8, 4.0, h, 12, 1, true);
    const mat = new THREE.MeshBasicMaterial({ color: col, transparent: true, opacity: 0.55, side: THREE.DoubleSide, depthWrite: false });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.position.set(pos.x, (pos.y || 0) + h / 2, pos.z);
    this.scene.add(mesh);
    this._templeFx.push({ mesh, t0: performance.now(), dur: 3000 });
    if (this._templeFx.length > 8) {   // hard cap: never let pillars pile up
      const old = this._templeFx.shift();
      this.scene.remove(old.mesh); old.mesh.geometry.dispose(); old.mesh.material.dispose();
    }
  }

  /** Fade + shrink the active pillars, disposing each as it expires. */
  _updateTempleFx(now) {
    const arr = this._templeFx; if (!arr || !arr.length) return;
    for (let i = arr.length - 1; i >= 0; i--) {
      const fx = arr[i];
      const age = (now - fx.t0) / fx.dur;
      if (age >= 1) {
        this.scene.remove(fx.mesh); fx.mesh.geometry.dispose(); fx.mesh.material.dispose();
        arr.splice(i, 1); continue;
      }
      fx.mesh.material.opacity = 0.55 * (1 - age);
      fx.mesh.scale.set(1 - age * 0.4, 1, 1 - age * 0.4);
    }
  }

  /**
   * Procedural geometry for one eternal wonder (3–6 meshes, gold family). Returns a THREE.Group
   * positioned at `position`; kept deliberately simple so five of them never crowd the frame.
   */
  _buildWonder(nationId, wonderType, position) {
    const g = new THREE.Group();
    g.position.set(position.x, position.y, position.z);
    g.rotation.y = (nationId * 1.3) % (Math.PI * 2);
    const gold = this._toon(0xd9b968);
    const deep = this._toon(0xb08a36);
    switch (wonderType) {
      case "babel": {
        const tower = new THREE.Mesh(new THREE.CylinderGeometry(1.6, 4.6, 20, 12), gold);
        tower.position.y = 10; g.add(tower);
        for (let i = 0; i < 4; i++) {
          const ring = new THREE.Mesh(new THREE.TorusGeometry(4.2 - i * 0.75, 0.4, 6, 18), deep);
          ring.rotation.x = Math.PI / 2; ring.position.y = 3.5 + i * 4.6; g.add(ring);
        }
        break;
      }
      case "library": {
        const hall = new THREE.Mesh(new THREE.BoxGeometry(11, 8, 9), gold);
        hall.position.y = 4; g.add(hall);
        const roof = new THREE.Mesh(new THREE.CylinderGeometry(0.1, 8.2, 4, 4), deep);
        roof.rotation.y = Math.PI / 4; roof.position.y = 10; g.add(roof);
        for (let i = -1; i <= 1; i++) {
          const col = new THREE.Mesh(new THREE.CylinderGeometry(0.55, 0.55, 8, 8), deep);
          col.position.set(i * 3.4, 4, 5); g.add(col);
        }
        break;
      }
      case "arena": {
        const ring = new THREE.Mesh(new THREE.TorusGeometry(6.5, 1.8, 8, 26), gold);
        ring.rotation.x = Math.PI / 2; ring.position.y = 2.5; g.add(ring);
        for (let i = 0; i < 6; i++) {
          const a = (i / 6) * Math.PI * 2;
          const arch = new THREE.Mesh(new THREE.BoxGeometry(1.1, 6, 1.1), deep);
          arch.position.set(Math.cos(a) * 6.5, 3, Math.sin(a) * 6.5); g.add(arch);
        }
        break;
      }
      case "lifetree": {
        const trunk = new THREE.Mesh(new THREE.CylinderGeometry(0.9, 1.6, 10, 8), deep);
        trunk.position.y = 5; g.add(trunk);
        const canopy = new THREE.Mesh(new THREE.SphereGeometry(5.5, 12, 10), gold);
        canopy.position.y = 12.5; g.add(canopy);
        break;
      }
      case "market": {
        const base = new THREE.Mesh(new THREE.CylinderGeometry(5.4, 5.8, 4.5, 14), deep);
        base.position.y = 2.2; g.add(base);
        const dome = new THREE.Mesh(new THREE.SphereGeometry(5.2, 14, 8, 0, Math.PI * 2, 0, Math.PI / 2), gold);
        dome.position.y = 4.5; g.add(dome);
        for (let i = 0; i < 4; i++) {
          const a = (i / 4) * Math.PI * 2 + 0.4;
          const stall = new THREE.Mesh(new THREE.BoxGeometry(2.2, 2.2, 2.2), gold);
          stall.position.set(Math.cos(a) * 8, 1.1, Math.sin(a) * 8); g.add(stall);
        }
        break;
      }
      default: {
        const obelisk = new THREE.Mesh(new THREE.ConeGeometry(2.2, 14, 6), gold);
        obelisk.position.y = 7; g.add(obelisk);
      }
    }
    // a soft golden beacon crowns every wonder so it reads as divine from afar
    const beacon = new THREE.Mesh(new THREE.SphereGeometry(1.3, 8, 8),
      new THREE.MeshBasicMaterial({ color: 0xf0d68a, transparent: true, opacity: 0.5, depthWrite: false }));
    beacon.position.y = 18; g.add(beacon);
    return g;
  }

  /** Rebuild the standing wonders when the GET /temple wonders map changes (signature-gated). */
  _rebuildWonders() {
    const td = state.templeData;
    const ro = td ? (td.readout || td) : null;
    const wonders = ro && ro.wonders && typeof ro.wonders === "object" ? ro.wonders : null;
    let sig = "";
    if (wonders) { for (const k of Object.keys(wonders).sort()) sig += k + ":" + wonders[k] + ","; }
    if (sig === this._wonderSig) return;
    this._wonderSig = sig;
    if (!this._wonderGroup) { this._wonderGroup = new THREE.Group(); this.scene.add(this._wonderGroup); }
    for (const child of [...this._wonderGroup.children]) {
      this._wonderGroup.remove(child);
      child.traverse((o) => { if (o.geometry) o.geometry.dispose(); if (o.material) o.material.dispose(); });
    }
    if (!wonders || !this._nationData || !Array.isArray(this._nationData.nationSeeds)) return;
    const seeds = this._nationData.nationSeeds;
    for (const key of Object.keys(wonders)) {
      const nid = Number(key);
      const seed = seeds[nid]; if (!seed) continue;
      const ang = (nid * 1.7 + 0.6) % (Math.PI * 2);
      const wx = seed.x + Math.cos(ang) * 24, wz = seed.z + Math.sin(ang) * 24;
      const wy = this.groundY(wx, wz, 7);
      this._wonderGroup.add(this._buildWonder(nid, wonders[key], { x: wx, y: wy, z: wz }));
    }
  }

  /** Give every summoned hero that is still alive a breathing golden halo at its sky position. */
  _updateHeroAuras(now) {
    const td = state.templeData;
    const ro = td ? (td.readout || td) : null;
    const heroes = ro && Array.isArray(ro.heroes) ? ro.heroes : null;
    if (!this._heroGroup) { this._heroGroup = new THREE.Group(); this.scene.add(this._heroGroup); }
    if (!this._heroAuras) this._heroAuras = [];
    const sim = this._simRef;
    const want = [];
    if (heroes && sim) {
      for (const h of heroes) {
        if (h == null || h.flyId == null) continue;
        const f = sim.get(h.flyId);
        if (!f || f.dying) continue;
        const x = (f.x / state.VW - 0.5) * this._WSX;
        const z = (f.y / state.VH - 0.5) * this._WSZ;
        const y = Math.max(this.groundY(x, z, 2), 0) + 14;
        want.push({ x, y, z });
      }
    }
    while (this._heroAuras.length < want.length) {
      const ring = new THREE.Mesh(new THREE.TorusGeometry(3.4, 0.4, 6, 22),
        new THREE.MeshBasicMaterial({ color: 0xf0d68a, transparent: true, opacity: 0.7, depthWrite: false }));
      ring.rotation.x = Math.PI / 2;
      this._heroGroup.add(ring); this._heroAuras.push(ring);
    }
    const pulse = 1 + Math.sin(now * 0.003) * 0.09;
    for (let i = 0; i < this._heroAuras.length; i++) {
      const ring = this._heroAuras[i];
      if (i < want.length) { ring.visible = true; ring.position.set(want[i].x, want[i].y, want[i].z); ring.scale.setScalar(pulse); }
      else ring.visible = false;
    }
  }

  /** The per-frame temple read-out: fire a pillar on a new execution, then wonders + heroes + fx. */
  _updateTemple(now, dt) {
    const td = state.templeData;
    const ro = td ? (td.readout || td) : null;
    const le = ro && ro.lastExecution;
    const leSig = le ? (le.kind + "@" + le.tick + "@" + le.address) : null;
    if (leSig && leSig !== this._lastTempleExec) {
      this._lastTempleExec = leSig;
      this.templeEffect(le.kind, { x: 0, y: 24, z: 0 });   // a beam over the island's heart
    }
    this._rebuildWonders();
    this._updateHeroAuras(now);
    this._updateTempleFx(now);
  }

  // ---- villages (task 24 diorama rework): fully procedural house clusters + windmills around
  // every town/city settlement — two InstancedMeshes total (shared vertex-coloured geometry,
  // one toon material), brown/tan diorama cottages. Deterministic per-zone layout, rebuilt only
  // when the census signature changes; the GLB kit dependency is gone. ----
  _rebuildVillages(econCities) {
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
      if (child.isInstancedMesh) child.dispose();   // geometry/material are shared caches released in dispose()
    }
    if (!sig || !sets) return;

    // shared geometry, built once: a cottage (box + pyramid roof) and a windmill (tapered tower +
    // cap + cross blades), all vertex-coloured so one toon material dresses every instance.
    if (!this._houseGeo || !this._millGeo) {
      const solid = (g, rgb) => {
        const gi = g.index ? g.toNonIndexed() : g;
        const n = gi.attributes.position.count;
        const arr = new Float32Array(n * 3);
        for (let i = 0; i < n; i++) { arr[i * 3] = rgb[0]; arr[i * 3 + 1] = rgb[1]; arr[i * 3 + 2] = rgb[2]; }
        gi.setAttribute("color", new THREE.BufferAttribute(arr, 3));
        return gi;
      };
      const hb = solid(new THREE.BoxGeometry(2.4, 1.7, 2.0), [0.62, 0.45, 0.28]);
      hb.translate(0, 0.85, 0);
      const hr = solid(new THREE.ConeGeometry(1.9, 1.3, 4), [0.42, 0.26, 0.16]);
      hr.rotateY(Math.PI / 4);
      hr.translate(0, 2.35, 0);
      this._houseGeo = mergeGeometries([hb, hr], false);
      const mt = solid(new THREE.CylinderGeometry(1.0, 1.4, 3.2, 10), [0.80, 0.68, 0.48]);
      mt.translate(0, 1.6, 0);
      const mc = solid(new THREE.ConeGeometry(1.3, 1.2, 10), [0.45, 0.28, 0.17]);
      mc.translate(0, 3.8, 0);
      const b1 = solid(new THREE.BoxGeometry(0.16, 3.4, 0.5), [0.50, 0.33, 0.20]);
      b1.translate(0, 2.6, 1.1);
      const b2 = solid(new THREE.BoxGeometry(3.4, 0.16, 0.5), [0.50, 0.33, 0.20]);
      b2.translate(0, 2.6, 1.1);
      this._millGeo = mergeGeometries([mt, mc, b1, b2], false);
    }
    if (!this._villageMat) this._villageMat = this._toon(0xffffff, { vertexColors: true });

    const buckets = { house: [], mill: [] };
    const YAX = new THREE.Vector3(0, 1, 0);
    const put = (kind, x, y, z, sc, yaw) => {
      buckets[kind].push(new THREE.Matrix4().compose(
        new THREE.Vector3(x, y, z),
        new THREE.Quaternion().setFromAxisAngle(YAX, (yaw || 0) * Math.PI * 2),
        new THREE.Vector3(sc, sc, sc)));
    };
    // every building is grounded on the MAX of a 5×5 sample spanning its own footprint and
    // embedded 0.3; a plot that lands in the sea is hauled halfway back toward the anchor, and
    // if it is still wet the building is dropped rather than built on stilts.
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
        let gy = this.groundY(bx, bz, sc * 1.2);
        if (gy < 0.4) {
          bx = wx + Math.cos(a) * rr * 0.55; bz = wz + Math.sin(a) * rr * 0.55;
          gy = this.groundY(bx, bz, sc * 1.2);
          if (gy < 0.4) return;
        }
        put(kind, bx, gy - 0.3, bz, sc, rnd());
      };
      const ring = r === "CITY" ? 15 + rnd() * 8 : 10 + rnd() * 5;
      const nH = r === "CITY" ? 6 : 4;
      for (let b = 0; b < nH; b++) {
        plot("house", rnd() * Math.PI * 2, ring + rnd() * 6, 1.6 + rnd() * 0.7);
      }
      plot("mill", rnd() * Math.PI * 2, ring * 0.7 + rnd() * 3, 1.7 + rnd() * 0.4);
    }

    for (const [kind, geo] of [["house", this._houseGeo], ["mill", this._millGeo]]) {
      const list = buckets[kind];
      if (!list.length) continue;
      const im = new THREE.InstancedMesh(geo, this._villageMat, list.length);
      for (let i = 0; i < list.length; i++) im.setMatrixAt(i, list[i]);
      im.instanceMatrix.needsUpdate = true;
      im.frustumCulled = false;   // instances spread far beyond the base geometry bounds
      this.villageGroup.add(im);
    }
  }

  // ---- trees (task 24 diorama): clustered broadleaf + conifer instanced trees — exactly two
  // InstancedMeshes (≤600 instances total, 2 draw calls). Clusters seed on dry inland grass away
  // from the canals (canalMask) and the castle mesas (nation seeds), so the land reads as a
  // model piece dotted with tree clumps, never a uniform forest. Deterministic layout; rebuilt
  // only when the nation partition changes (the canals move with it). ----
  _buildTrees() {
    if (this._treeGroup) {
      this.scene.remove(this._treeGroup);
      this._treeGroup.traverse((o) => { if (o.isInstancedMesh) o.dispose(); });
      this._treeGroup = null;
    }
    if (!this._broadGeo || !this._coniferGeo) {
      const solid = (g, rgb) => {
        const gi = g.index ? g.toNonIndexed() : g;
        const n = gi.attributes.position.count;
        const arr = new Float32Array(n * 3);
        for (let i = 0; i < n; i++) { arr[i * 3] = rgb[0]; arr[i * 3 + 1] = rgb[1]; arr[i * 3 + 2] = rgb[2]; }
        gi.setAttribute("color", new THREE.BufferAttribute(arr, 3));
        return gi;
      };
      // broadleaf: short trunk + rounded low-poly canopy
      const bt = solid(new THREE.CylinderGeometry(0.35, 0.5, 2.2, 7), [0.45, 0.32, 0.20]);
      bt.translate(0, 1.1, 0);
      const bc = solid(new THREE.IcosahedronGeometry(2.4, 0), [0.36, 0.58, 0.28]);
      bc.translate(0, 3.4, 0);
      this._broadGeo = mergeGeometries([bt, bc], false);
      // conifer: slender trunk + deep-green cone
      const ct = solid(new THREE.CylinderGeometry(0.3, 0.45, 1.8, 7), [0.40, 0.28, 0.18]);
      ct.translate(0, 0.9, 0);
      const cc = solid(new THREE.ConeGeometry(1.7, 4.6, 8), [0.16, 0.38, 0.20]);
      cc.translate(0, 4.1, 0);
      this._coniferGeo = mergeGeometries([ct, cc], false);
    }
    if (!this._treeMat) this._treeMat = this._toon(0xffffff, { vertexColors: true });

    const N = this._hN, mask = this._canalMask;
    const WSX = this._WSX, WSZ = this._WSZ;
    const seeds = this._nationData && Array.isArray(this._nationData.nationSeeds) ? this._nationData.nationSeeds : [];
    let rs = 0x5eed24 ^ (seeds.length * 2654435761);
    const rnd = () => { rs = (Math.imul(rs, 1664525) + 1013904223) >>> 0; return rs / 4294967296; };
    // a spot is plantable when it is dry inland grass (not beach, not ridge, not sea), off the
    // canal banks, and clear of every castle mesa
    const okSpot = (x, z) => {
      const y = this.heightAt(x, z);
      if (!(y > 2.0 && y < 11.0)) return false;
      if (mask) {
        const i = Math.round((x + WSX / 2) / this._hStepX), j = Math.round((z + WSZ / 2) / this._hStepZ);
        if (i < 0 || j < 0 || i >= N || j >= N || mask[j * N + i] > 0.2) return false;
      }
      for (const s of seeds) {
        const dx = s.x - x, dz = s.z - z;
        if (dx * dx + dz * dz < 26 * 26) return false;
      }
      return true;
    };
    const d = this._dummy;
    const broad = [], conifer = [];
    const CAP_B = 320, CAP_C = 280;
    for (let c = 0; c < 26 && (broad.length < CAP_B || conifer.length < CAP_C); c++) {
      const cx = (rnd() - 0.5) * WSX * 0.86, cz = (rnd() - 0.5) * WSZ * 0.86;
      if (!okSpot(cx, cz)) continue;
      const n = 8 + ((rnd() * 14) | 0);
      const spread = 9 + rnd() * 10;
      const coniferClump = rnd() < 0.45;   // a clump is one species, like the reference diorama
      for (let t = 0; t < n; t++) {
        const x = cx + (rnd() - 0.5) * 2 * spread, z = cz + (rnd() - 0.5) * 2 * spread;
        if (!okSpot(x, z)) continue;
        const y = this.heightAt(x, z);
        const sc = 0.9 + rnd() * 0.8;
        d.position.set(x, y - 0.3, z);
        d.rotation.set(0, rnd() * Math.PI * 2, 0);
        d.scale.set(sc, sc * (0.85 + rnd() * 0.35), sc);
        d.updateMatrix();
        const bucket = coniferClump ? conifer : broad;
        const cap = coniferClump ? CAP_C : CAP_B;
        if (bucket.length < cap) bucket.push(d.matrix.clone());
      }
    }
    this._treeGroup = new THREE.Group();
    const tc = new THREE.Color();
    for (const [geo, list] of [[this._broadGeo, broad], [this._coniferGeo, conifer]]) {
      if (!list.length) continue;
      const im = new THREE.InstancedMesh(geo, this._treeMat, list.length);
      for (let i = 0; i < list.length; i++) {
        im.setMatrixAt(i, list[i]);
        // task 51: per-instance ±12% colour variation so trees don't read as clones
        const hueShift = 0.88 + rnd() * 0.24;
        tc.setRGB(hueShift, 0.92 + rnd() * 0.16, 0.85 + rnd() * 0.20);
        im.setColorAt(i, tc);
      }
      im.instanceMatrix.needsUpdate = true;
      if (im.instanceColor) im.instanceColor.needsUpdate = true;
      im.frustumCulled = false;   // instances spread far beyond the base geometry bounds
      this._treeGroup.add(im);
    }
    this.scene.add(this._treeGroup);
  }

  // ---- task 47: GREAT WALL + BEACON TOWERS along the meandered border lines.
  // The wall is a continuous stone ribbon (merged into ONE BufferGeometry, single draw call)
  // with crenellations every ~7 units. Beacon towers are placed every ~50 units (InstancedMesh
  // for the stone bodies + InstancedMesh for the flames). Total ≤3 new draw calls.
  // Visibility follows state.showTerritory (controlled in update()). ----
  _buildBorderWalls() {
    if (this._wallGroup) {
      this.scene.remove(this._wallGroup);
      this._wallGroup.traverse((o) => { if (o.geometry) o.geometry.dispose(); if (o.material) o.material.dispose(); });
      this._wallGroup = null;
    }
    const nat = this._nationData;
    if (!nat || !nat.voronoi) return;

    // Get the cached meander runs (same data _sculptTerrain and buildBorderMesh use)
    const hAt = (x, z) => this.heightAt(x, z);
    const runs = meanderEdges(voronoiEdges(nat.voronoi), hAt);
    if (!runs || !runs.length) return;

    // Helper: vertex-colour a geometry with mottle
    const STONE = [0.42, 0.42, 0.42];  // #6b6b6b
    const solid = (g, rgb, mottle) => {
      const gi = g.index ? g.toNonIndexed() : g;
      const n = gi.attributes.position.count;
      const arr = new Float32Array(n * 3);
      const m = mottle || 0;
      for (let i = 0; i < n; i++) {
        const jit = m > 0 ? (Math.sin(i * 7.31 + g.id * 0.1) * 0.5 + 0.5) * m - m * 0.5 : 0;
        arr[i * 3] = Math.max(0, Math.min(1, rgb[0] + jit));
        arr[i * 3 + 1] = Math.max(0, Math.min(1, rgb[1] + jit));
        arr[i * 3 + 2] = Math.max(0, Math.min(1, rgb[2] + jit));
      }
      gi.setAttribute("color", new THREE.BufferAttribute(arr, 3));
      return gi;
    };

    const wallGeos = [];   // all wall + merlon pieces → merge into 1 geometry
    const towerPositions = [];  // [{x, y, z, angle}] for beacon towers

    const WALL_H = 3.2, WALL_W = 2.2, MERLON_H = 1.4, MERLON_W = 1.0;
    const TOWER_SPACING = 50;   // world units between towers

    for (const line of runs) {
      // Filter to inland points only (mouth=0 and above sea level)
      const pts = [];
      for (const p of line) {
        if (p[2] > 0) continue;   // estuary tail — no wall in the sea
        const h = hAt(p[0], p[1]);
        if (h < 0.5) continue;    // below land threshold
        pts.push(p);
      }
      if (pts.length < 3) continue;

      // Resample every ~8 units for wall segments
      const wallPts = [pts[0]];
      let accum = 0;
      for (let i = 1; i < pts.length; i++) {
        const dx = pts[i][0] - pts[i - 1][0], dz = pts[i][1] - pts[i - 1][1];
        accum += Math.hypot(dx, dz);
        if (accum >= 8) { wallPts.push(pts[i]); accum = 0; }
      }
      if (wallPts.length < 2) continue;

      // Build wall segments
      let distSinceTower = 0;
      for (let i = 0; i < wallPts.length - 1; i++) {
        const ax = wallPts[i][0], az = wallPts[i][1];
        const bx = wallPts[i + 1][0], bz = wallPts[i + 1][1];
        const dx = bx - ax, dz = bz - az;
        const segLen = Math.hypot(dx, dz);
        if (segLen < 1) continue;
        const angle = Math.atan2(dz, dx);
        const mx = (ax + bx) / 2, mz = (az + bz) / 2;
        const gy = this.groundY(mx, mz, 4);
        if (gy < 0.4) continue;

        // Wall body: a box stretched along the segment
        const wg = new THREE.BoxGeometry(segLen, WALL_H, WALL_W);
        wg.rotateY(-angle);
        wg.translate(mx, gy + WALL_H * 0.5 - 0.3, mz);
        wallGeos.push(solid(wg, STONE, 0.06));

        // Merlons: crenellations on top every ~7 units
        const nMerlons = Math.max(1, Math.round(segLen / 7));
        for (let m = 0; m < nMerlons; m++) {
          const t = (m + 0.5) / nMerlons;
          const px = ax + dx * t, pz = az + dz * t;
          const py = this.groundY(px, pz, 2);
          if (py < 0.4) continue;
          const mg = new THREE.BoxGeometry(MERLON_W, MERLON_H, WALL_W * 0.8);
          mg.rotateY(-angle);
          mg.translate(px, py + WALL_H + MERLON_H * 0.5 - 0.3, pz);
          wallGeos.push(solid(mg, STONE, 0.04));
        }

        // Track distance for tower placement
        distSinceTower += segLen;
        if (distSinceTower >= TOWER_SPACING) {
          distSinceTower = 0;
          towerPositions.push({ x: mx, y: gy, z: mz, angle });
        }
      }
    }

    this._wallGroup = new THREE.Group();
    this._wallGroup.name = "borderWalls";

    // Merge all wall geometry into one mesh (single draw call)
    if (wallGeos.length) {
      const merged = mergeGeometries(wallGeos, false);
      if (merged) {
        const mat = new THREE.MeshToonMaterial({ vertexColors: true, gradientMap: this._toonRamp() });
        const mesh = new THREE.Mesh(merged, mat);
        mesh.frustumCulled = false;
        mesh.castShadow = false;
        this._wallGroup.add(mesh);
      }
    }

    // Beacon towers — one InstancedMesh for the stone structure
    if (towerPositions.length) {
      const tGeos = [];
      const tBody = new THREE.CylinderGeometry(2.5, 2.8, 8, 10);
      tBody.translate(0, 4, 0);
      tGeos.push(solid(tBody, [0.40, 0.40, 0.38], 0.05));
      const tPlat = new THREE.CylinderGeometry(3.5, 3.2, 1.0, 10);
      tPlat.translate(0, 8.5, 0);
      tGeos.push(solid(tPlat, [0.44, 0.44, 0.42], 0.04));
      const tBraz = new THREE.CylinderGeometry(1.5, 1.8, 1.2, 8);
      tBraz.translate(0, 9.6, 0);
      tGeos.push(solid(tBraz, [0.36, 0.30, 0.24], 0.03));
      const towerGeo = mergeGeometries(tGeos, false);
      if (towerGeo) {
        const towerMat = new THREE.MeshToonMaterial({ vertexColors: true, gradientMap: this._toonRamp() });
        const towerIM = new THREE.InstancedMesh(towerGeo, towerMat, towerPositions.length);
        const d = new THREE.Object3D();
        for (let i = 0; i < towerPositions.length; i++) {
          const tp = towerPositions[i];
          d.position.set(tp.x, tp.y - 0.4, tp.z);
          d.rotation.set(0, tp.angle, 0);
          d.scale.setScalar(1);
          d.updateMatrix();
          towerIM.setMatrixAt(i, d.matrix);
        }
        towerIM.instanceMatrix.needsUpdate = true;
        towerIM.frustumCulled = false;
        this._wallGroup.add(towerIM);
      }

      // Flames — small orange spheres on top of each tower (InstancedMesh, basic material)
      const flameGeo = new THREE.SphereGeometry(1.2, 8, 6);
      flameGeo.translate(0, 10.6, 0);
      const flameMat = new THREE.MeshBasicMaterial({ color: 0xff6a20, transparent: true, opacity: 0.8 });
      const flameIM = new THREE.InstancedMesh(flameGeo, flameMat, towerPositions.length);
      const fd = new THREE.Object3D();
      for (let i = 0; i < towerPositions.length; i++) {
        const tp = towerPositions[i];
        fd.position.set(tp.x, tp.y - 0.4, tp.z);
        fd.rotation.set(0, 0, 0);
        fd.scale.setScalar(1);
        fd.updateMatrix();
        flameIM.setMatrixAt(i, fd.matrix);
      }
      flameIM.instanceMatrix.needsUpdate = true;
      flameIM.frustumCulled = false;
      this._wallGroup.add(flameIM);
    }

    this._wallGroup.visible = state.showTerritory !== false;
    this.scene.add(this._wallGroup);
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
    // ---- ① social web (task 25④, task 46): alliance bonds are GROUND-HUGGING RIBBONS (per-vertex crest
    // lift, nation-blended vertex colours) instead of 1px LineSegments the terrain used to swallow;
    // feuds stay dashed lines but densified to the same 12-unit sampling. Both rebuild when
    // the bond signature changes (2-unit quantisation) — near-real-time fly tracking. ----
    const RIB_B = this._socLineCap, RIB_P = this._socRibbonPts;
    const rgeo = new THREE.BufferGeometry();
    rgeo.setAttribute("position", new THREE.BufferAttribute(new Float32Array(RIB_B * RIB_P * 2 * 3), 3).setUsage(THREE.DynamicDrawUsage));
    rgeo.setAttribute("color", new THREE.BufferAttribute(new Float32Array(RIB_B * RIB_P * 2 * 3), 3).setUsage(THREE.DynamicDrawUsage));
    rgeo.setIndex(new THREE.BufferAttribute(new Uint16Array(RIB_B * (RIB_P - 1) * 6), 1).setUsage(THREE.DynamicDrawUsage));
    rgeo.setDrawRange(0, 0);
    this._socLines = new THREE.Mesh(rgeo, new THREE.MeshBasicMaterial({
      vertexColors: true, transparent: true, opacity: 0.85, depthWrite: false, side: THREE.DoubleSide,
    }));
    this._socLines.frustumCulled = false;
    this._socLines.renderOrder = 6;
    this._socLines.visible = false;   // permanently hidden: bond ribbons removed
    this.scene.add(this._socLines);
    const ggeo = new THREE.BufferGeometry();
    ggeo.setAttribute("position", new THREE.BufferAttribute(new Float32Array(RIB_B * (RIB_P - 1) * 2 * 3), 3).setUsage(THREE.DynamicDrawUsage));
    ggeo.setDrawRange(0, 0);
    this._socGrudge = new THREE.LineSegments(ggeo, new THREE.LineDashedMaterial({ color: 0xc63c2c, dashSize: 9, gapSize: 6.5, transparent: true, opacity: 0.6, depthWrite: false }));
    this._socGrudge.frustumCulled = false;
    this._socGrudge.renderOrder = 6;
    this._socGrudge.visible = false;  // permanently hidden: grudge lines removed
    this.scene.add(this._socGrudge);

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

    // ---- task 50: GPU particle weather — one Points object for every chronicle burst + the ambient
    // rain/snow layer. Built LAST so the renderer + scene already exist; isolated so a shader-compile
    // failure can never blank the diorama. maxParticles auto-halves on mobile (particles.js). ----
    try {
      this.particles = new ParticleSystem(this.scene, this.renderer);
      // resume a stored weather layer if one is still fresh (< ~12 min), else roll one soon
      const rw = this.particles.restoredWeather;
      if (rw && PARTICLE_WEATHER[rw]) { this._startWeather(rw); this._weatherNextAt = performance.now() + (5 + Math.random() * 5) * 60000; }
      else this._weatherNextAt = performance.now() + 20000;   // first live roll ~20s after load
      // debug hooks (headless verification): force a burst / a weather layer from the console
      window.__murmurBurst = (kind) => { const p = PARTICLE_EVENT_MAP[(kind || '').toUpperCase()]; if (!p || !this.particles) return false; this._emitEventBurst(p, null); return true; };
      window.__murmurWeather = (type) => { if (!this.particles) return false; if (type === 'clear') { this.particles.stopAmbient(); return true; } return !!this._startWeather(type); };
      window.__murmurParticles = () => this.particles;
    } catch (e) { console.warn('[scene3d] particle system init failed:', e); this.particles = null; }
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
    if (cameraMode() === "walk") return;   // task 48: walk mode owns the pointer, never pick
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
    this._updateCivFade(now);   // task 32: run the ≤2s civ-stage cross-fade (idle ⇒ one boolean, self-stops)

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
      const sz = (0.7 + balN * 0.6) * 2.3;   // task 24: diorama insects — the swarm shrinks to ≈1/5 of a castle so the island reads as a tabletop model
      // task 24 — the shrunken flies patrol the SKY above the island, not the grass: lift them a
      // fixed 14 units over the highest ground under the body so they read as insects buzzing over
      // the diorama (never below sea level), with the ±2 hover bob riding on top.
      const y = Math.max(this.groundY(x, z, sz * 0.8), 0) + sz * 0.5 + 14 + Math.sin(now * 0.004 + (f.phase || 0)) * 2.0;
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
    // task 47: cities toggle → villageGroup visible follows state.showCities
    this.villageGroup.visible = state.showCities !== false;
    // task 47: border walls follow territory toggle
    if (this._wallGroup) this._wallGroup.visible = state.showTerritory !== false;
    // task 12 P0: flow the ocean by scrolling the normal map — no uniforms, no mirror pass
    if (this.water && this.water.material && this.water.material.normalMap) {
      const nm = this.water.material.normalMap;
      nm.offset.x = (nm.offset.x + dt * 0.010) % 1;
      nm.offset.y = (nm.offset.y + dt * 0.016) % 1;
    }
    // task 48: walk mode drives the camera; orbit mode uses OrbitControls
    if (this.walkMode && this.walkMode.active) {
      try { this.walkMode.update(dt); } catch (e) { console.warn("walkMode", e); }
    } else {
      this.controls.update();
    }

    // ---- task 7: the ported 2D layers — each isolated so one bad layer can never veto the frame ----
    // NOTE: _updateSocialLines disabled — permanent bond ribbons / grudge lines removed for visual clarity.
    //       Payment arcs (_updatePayments) are UNAFFECTED.
    // try { this._updateSocialLines(sim); } catch (e) { console.warn("socialLines", e); }
    try { this._updateGraveyard(); } catch (e) { console.warn("graveyard", e); }
    try { this._updatePayments(sim, now); } catch (e) { console.warn("payments", e); }
    try { this._updateChronFx(now, dt); } catch (e) { console.warn("chronFx", e); }
    try { this._updateMeshLines(sim); } catch (e) { console.warn("meshLines", e); }
    try { this._updateFaith(now); } catch (e) { console.warn("faith", e); }
    try { this._updateDayNight(now); } catch (e) { console.warn("dayNight", e); }
    try { this._syncTerrainUniforms(); } catch (e) { /* non-fatal */ }
    try { this._updateEraHud(); } catch (e) { console.warn("eraHud", e); }
    try { this._updateDayPhaseHud(); } catch (e) { console.warn("dayPhaseHud", e); }   // task 49: after era-hud so an era rewrite can't drop the watch glyph
    try { this._updateSwarmAura(now); } catch (e) { console.warn("swarmAura", e); }
    try { this._updateShardRings(now); } catch (e) { console.warn("shardRings", e); }
    try { this._updateTemple(now, dt); } catch (e) { console.warn("temple", e); }
    try { this._updateLegend(sim, now); } catch (e) { console.warn("legend", e); }
    // ---- task 50: GPU particle weather — consume new chronicle rows as bursts, roll the ambient
    // weather, then advance the shader clock. Fully isolated: a particle fault never vetoes the frame.
    try { this._updateParticleWeather(now, dt); } catch (e) { console.warn("particles", e); }
  }

  // ============================ task 7 — layer implementations ============================

  // ① social web — alliance ribbons + red dashed feud rifts between live flies (task 25④, task 46).
  // Ribbons sample every ≈12 world units and lift EACH vertex onto the local ground crest +4.5
  // (grudges +6), so no ridge can swallow a thread; colours blend the two endpoint nation hues.
  // Geometry rebuilds when the signature (pairs + 2-unit-quantised endpoints) changes — near-real-time tracking.
  _nationRGBAt(x, z) {
    const nd = this._nationData;
    const vor = nd && nd.voronoi;
    let id = -1;
    if (vor) {
      if (typeof vor.find === "function") id = vor.find(x, z);
      else if (vor.delaunay && typeof vor.delaunay.find === "function") id = vor.delaunay.find(x, z);
    }
    if (id < 0 && nd && Array.isArray(nd.nationSeeds) && nd.nationSeeds.length) {
      let bd = 1e18; id = 0;
      for (let i = 0; i < nd.nationSeeds.length; i++) {
        const sdx = nd.nationSeeds[i].x - x, sdz = nd.nationSeeds[i].z - z;
        const d2 = sdx * sdx + sdz * sdz;
        if (d2 < bd) { bd = d2; id = i; }
      }
    }
    const c = id >= 0 ? getNationColor(id) : null;
    return c ? [c.r, c.g, c.b] : [0.42, 0.58, 0.88];
  }
  _updateSocialLines(sim) {
    const s = state.econSocial;
    const show = !!state.showSocieties && !!s;
    const bonds = (show && Array.isArray(s.bonds)) ? s.bonds : null;
    const grudges = (show && Array.isArray(s.grudges)) ? s.grudges : null;
    const W = this._WSX, H = this._WSZ, VW = state.VW, VH = state.VH;
    const liveB = [], liveG = [];
    let sig = "";
    if (bonds) for (const b of bonds) {
      if (liveB.length >= this._socLineCap) break;
      if (!b || b.a == null || b.b == null || b.a === b.b) continue;
      const fa = sim.get(b.a), fb = sim.get(b.b);
      if (!fa || fa.dying || !fb || fb.dying) continue;
      liveB.push([fa, fb]);
      sig += "b" + b.a + "." + b.b + "@" + ((fa.x / 2) | 0) + "," + ((fa.y / 2) | 0) + "," + ((fb.x / 2) | 0) + "," + ((fb.y / 2) | 0) + ";";
    }
    sig += "|";
    if (grudges) for (const g of grudges) {
      if (liveG.length >= this._socLineCap) break;
      if (!g || g.buyerId == null || g.sellerId == null || g.buyerId === g.sellerId) continue;
      const fa = sim.get(g.buyerId), fb = sim.get(g.sellerId);
      if (!fa || fa.dying || !fb || fb.dying) continue;
      liveG.push([fa, fb]);
      sig += "g" + g.buyerId + "." + g.sellerId + "@" + ((fa.x / 2) | 0) + "," + ((fa.y / 2) | 0) + "," + ((fb.x / 2) | 0) + "," + ((fb.y / 2) | 0) + ";";
    }
    if (sig === this._socSig) return;   // nothing moved a 2-unit cell → minimal per-frame cost
    this._socSig = sig;
    const PTS = this._socRibbonPts;
    // ---- alliance ribbons: two vertices per sample, triangle strip indices, nation-blended colour ----
    const rgeo = this._socLines.geometry;
    const P = rgeo.attributes.position.array, C = rgeo.attributes.color.array, I = rgeo.index.array;
    let vCount = 0, iCount = 0;
    for (const [fa, fb] of liveB) {
      if (vCount + PTS * 2 > P.length / 3) break;
      const ax = (fa.x / VW - 0.5) * W, az = (fa.y / VH - 0.5) * H;
      const bx = (fb.x / VW - 0.5) * W, bz = (fb.y / VH - 0.5) * H;
      const dist = Math.hypot(bx - ax, bz - az);
      const m = Math.max(2, Math.min(PTS, Math.ceil(dist / 12) + 1));
      const ca = this._nationRGBAt(ax, az), cb = this._nationRGBAt(bx, bz);
      const base = vCount;
      for (let i = 0; i < m; i++) {
        const t = m > 1 ? i / (m - 1) : 0;
        const x = ax + (bx - ax) * t, z = az + (bz - az) * t;
        const y = this.groundY(x, z, 6) + 4.5;      // per-vertex crest lift (task 25④)
        const t0 = m > 1 ? Math.max(0, i - 1) / (m - 1) : 0, t1 = m > 1 ? Math.min(m - 1, i + 1) / (m - 1) : 1;
        let tx = (bx - ax) * (t1 - t0), tz = (bz - az) * (t1 - t0);
        const tl = Math.hypot(tx, tz) || 1; tx /= tl; tz /= tl;
        const nx = -tz * 0.45, nz = tx * 0.45;      // ribbon half-width 0.45 (total 0.9)
        const k3 = vCount * 3;
        P[k3] = x - nx; P[k3 + 1] = y; P[k3 + 2] = z - nz;
        P[k3 + 3] = x + nx; P[k3 + 4] = y; P[k3 + 5] = z + nz;
        const r = ca[0] + (cb[0] - ca[0]) * t, gg = ca[1] + (cb[1] - ca[1]) * t, bb = ca[2] + (cb[2] - ca[2]) * t;
        C[k3] = r; C[k3 + 1] = gg; C[k3 + 2] = bb;
        C[k3 + 3] = r; C[k3 + 4] = gg; C[k3 + 5] = bb;
        vCount += 2;
      }
      for (let i = 0; i < m - 1; i++) {
        const a = base + i * 2;
        I[iCount++] = a; I[iCount++] = a + 2; I[iCount++] = a + 1;
        I[iCount++] = a + 1; I[iCount++] = a + 2; I[iCount++] = a + 3;
      }
    }
    rgeo.attributes.position.needsUpdate = true;
    rgeo.attributes.color.needsUpdate = true;
    rgeo.index.needsUpdate = true;
    rgeo.setDrawRange(0, iCount);
    this._socLines.visible = iCount > 0;
    // ---- feuds: red dashed rift, densified to the same 12-unit sampling, per-vertex crest +6 ----
    const ggeo = this._socGrudge.geometry;
    const G = ggeo.attributes.position.array;
    let gv = 0;
    for (const [fa, fb] of liveG) {
      const ax = (fa.x / VW - 0.5) * W, az = (fa.y / VH - 0.5) * H;
      const bx = (fb.x / VW - 0.5) * W, bz = (fb.y / VH - 0.5) * H;
      const dist = Math.hypot(bx - ax, bz - az);
      const m = Math.max(2, Math.min(PTS, Math.ceil(dist / 12) + 1));
      if (gv + (m - 1) * 2 > G.length / 3) break;
      for (let i = 0; i < m - 1; i++) {
        for (let e = 0; e < 2; e++) {
          const t = m > 1 ? (i + e) / (m - 1) : 0;
          G[gv * 3] = ax + (bx - ax) * t;
          G[gv * 3 + 1] = this.groundY(ax + (bx - ax) * t, az + (bz - az) * t, 6) + 6;
          G[gv * 3 + 2] = az + (bz - az) * t;
          gv++;
        }
      }
    }
    ggeo.attributes.position.needsUpdate = true;
    this._socGrudge.computeLineDistances();     // dash distances must follow the moved endpoints
    ggeo.setDrawRange(0, gv);
    this._socGrudge.visible = gv > 0;
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
    // task 49: a dynasty fall / era passage rides in as an "eclipse" chronFx (pushed by render2d's
    // spawnChronFx) — it carries no world position, it just forces the blood eclipse on the sky.
    if (fx.kind === "eclipse") { if (this.dayNight) this.dayNight.forceEclipse(fx.ticks || 30); return; }
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

  // ============================ task 50 — GPU particle weather ============================
  // Turn the raw /annals rows into visible weather. Each NEW chronicle event whose kind has a
  // particle preset fires ONE GPU burst anchored on the relevant nation; the ambient rain/snow
  // layer re-rolls every 5–10 min. All motion lives in the vertex shader — this method only feeds
  // it events + advances the clock, so it does zero per-particle CPU work.
  _updateParticleWeather(now, dt) {
    const ps = this.particles;
    if (!ps) return;
    // night linkage: particles glow brighter after dark (read straight off the day/night driver)
    ps.nightFactor = this.dayNight ? this.dayNight.nightFactor : 0;

    // ---- ① ambient weather scheduler: a fresh random layer every 5–10 minutes ----
    if (now >= this._weatherNextAt) {
      this._weatherNextAt = now + (5 + Math.random() * 5) * 60000;
      const roll = Math.random();
      if (roll < 0.45) this._startWeather('rain');        // ~45% rain
      else if (roll < 0.75) this._startWeather('snow');   // ~30% snow (settles only over peaks)
      else ps.stopAmbient();                              // ~25% clear
    }

    // ---- ② chronicle bursts: consume raw rows newer than the high-water mark ----
    const rows = state.chronRows;
    if (Array.isArray(rows) && rows.length) {
      const head = rows[0].seq || 0;                 // rows are desc by seq → [0] is the newest
      if (this._pxSeenSeq === 0) {
        // first sight: seed the mark WITHOUT emitting, so a reload never floods the whole backlog
        this._pxSeenSeq = head;
      } else if (head > this._pxSeenSeq) {
        let fired = 0;
        for (const e of rows) {
          const sq = e.seq || 0;
          if (sq <= this._pxSeenSeq) break;
          if (fired >= 6) break;                     // a reconnect can hand back dozens — pace them
          const preset = PARTICLE_EVENT_MAP[e.kind];
          if (preset) { this._emitEventBurst(preset, e); fired++; }
        }
        this._pxSeenSeq = head;
      }
    }

    ps.update(dt, this.camera);
  }

  // fire one event burst, resolving the world anchor + any per-event colour override
  _emitEventBurst(preset, e) {
    const anchor = this._particleAnchor(preset.region || 'field', e);
    // only a dynasty/era banner wears the falling house's colour; every other family keeps its palette
    if (!(preset.useNationColor && anchor.color)) anchor.color = null;
    this.particles.emit(preset, anchor);
  }

  // resolve a preset region (+ optional event) into a world anchor {x,y,z,radius,color}
  _particleAnchor(region, e) {
    const nd = this._nationData;
    const seeds = nd && Array.isArray(nd.nationSeeds) ? nd.nationSeeds : null;
    const colors = nd && Array.isArray(nd.nationColors) ? nd.nationColors : null;
    let x = 0, z = 0, nationIdx = -1;
    let radius = region === 'capital' ? 12 : region === 'graveyard' ? 22 : region === 'plague' ? 34 : region === 'border' ? 26 : 55;

    // ① prefer the live actor's fly when the event names one (a hero/prophet burst sits on the fly)
    const actors = e && Array.isArray(e.actors) ? e.actors : null;
    const fa = (actors && actors[0] != null && this._simRef) ? this._simRef.get(actors[0]) : null;
    if (fa && !fa.dying) {
      x = (fa.x / state.VW - 0.5) * this._WSX;
      z = (fa.y / state.VH - 0.5) * this._WSZ;
      nationIdx = this._nearestNation(x, z, seeds);
    } else if (seeds && seeds.length) {
      if (region === 'border' && seeds.length >= 2) {
        // a border clash lands halfway between two random realms
        const i = Math.floor(Math.random() * seeds.length);
        const j = (i + 1 + Math.floor(Math.random() * (seeds.length - 1))) % seeds.length;
        x = (seeds[i].x + seeds[j].x) * 0.5; z = (seeds[i].z + seeds[j].z) * 0.5;
        nationIdx = i;
      } else {
        // nation / capital / plague / graveyard / field → a realm centroid (round-robin for variety)
        nationIdx = this._pxNationCursor = (this._pxNationCursor + 1) % seeds.length;
        x = seeds[nationIdx].x; z = seeds[nationIdx].z;
        if (region === 'field') radius = 70;
      }
    }

    // vertical placement: a rising burst starts just above the crest; a falling layer starts high
    const gy = Math.max(this.heightAt(x, z), 0);
    const falling = (region === 'nation' || region === 'graveyard');
    const y = gy + (falling ? 34 : 6);

    const nc = (nationIdx >= 0 && colors && colors[nationIdx]) ? colors[nationIdx] : null;
    return { x, y, z, radius, color: nc ? [nc.r, nc.g, nc.b] : null };
  }

  _nearestNation(x, z, seeds) {
    if (!seeds || !seeds.length) return -1;
    let best = -1, bd = Infinity;
    for (let i = 0; i < seeds.length; i++) {
      const dx = seeds[i].x - x, dz = seeds[i].z - z, d = dx * dx + dz * dz;
      if (d < bd) { bd = d; best = i; }
    }
    return best;
  }

  // start an ambient rain/snow layer across the whole continent (ground sampled cheaply, once)
  _startWeather(type) {
    const ps = this.particles;
    if (!ps || !PARTICLE_WEATHER[type]) return false;
    const hx = this._WSX * 0.5, hz = this._WSZ * 0.5;
    const written = ps.startAmbient(type, {
      x0: -hx, x1: hx, z0: -hz, z1: hz,
      groundFn: (x, z) => this.heightAt(x, z),
      minGround: type === 'snow' ? this._snowMinGround() : undefined,
    });
    return written > 0;
  }

  // The task's literal ">12" snow gate assumed a taller relief than this diorama's (its mountain term
  // rm²·62·gate rarely clears 12), so snow would never find a peak and the layer stayed empty. Instead
  // crown the actual high country: the 90th-percentile LAND height, clamped to a sane band, cached once.
  _snowMinGround() {
    if (this._snowMin != null) return this._snowMin;
    const h = this._hGrid;
    let v = 8;
    if (h && h.length) {
      const vals = [];
      for (let i = 0; i < h.length; i += 7) if (h[i] > 0.5) vals.push(h[i]);
      if (vals.length) {
        vals.sort((a, b) => a - b);
        v = vals[Math.floor(vals.length * 0.90)];
      }
    }
    this._snowMin = Math.min(14, Math.max(4, v));
    return this._snowMin;
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

  // ⑧ day/night — task 49: the sun is now driven by the SIMULATION TICK, not a wall-clock sine.
  // One generation (≈42 ticks) is one full turn of the sky. All the light/fog/sky/star/glow work
  // lives in dayNight.js; this shim only feeds it the authoritative tick + generation off state and
  // repaints the watch glyph. (The old now*0.00025 time-based cycle and its tempSmoothed hue nudge
  // are retired — the tick is the single source of diurnal truth now.)
  _updateDayNight(now) {
    const dn = this.dayNight;
    if (!dn) return;
    // tick: the live on-chain tickIndex when present, else the simulated counter, else 0
    const tick = (state.lastTickIndex != null) ? state.lastTickIndex
      : (Number.isFinite(state.synthTick) ? state.synthTick : 0);
    const gen = (state.chronMeta && state.chronMeta.generation != null) ? state.chronMeta.generation : 0;
    dn.update(tick, gen, now);
  }

  // task 51 revert: the sea is a plain MeshStandardMaterial again — its day/night rides on the real
  // sun/hemi lights + scene.fog + envMapIntensity (all driven by dayNight.js), so there are no
  // water uniforms left to push. Guarded so a missing uniforms bag is a silent no-op.
  _syncTerrainUniforms() {
    const wu = this._waterUniforms;
    if (!wu || !wu.uSunDir || !wu.uSunDir.value) return;   // guard: custom ocean shader no longer present
    const dn = this.dayNight;
    const fog = this.scene.fog;
    if (dn && wu) {
      wu.uSunDir.value.copy(dn._sunDir);
      wu.uNightFactor.value = dn.nightFactor;
      if (this.sunLight) wu.uSunColor.value.copy(this.sunLight.color).multiplyScalar(this.sunLight.intensity * 0.7);
    }
    if (fog && wu) { wu.fogColor.value.copy(fog.color); wu.fogDensity.value = fog.density; }
  }

  // task 49: the current watch (☀️/🌅/🌙/🌄, 🌑 under eclipse) rides as a leading glyph INSIDE the
  // existing #era-hud pill — no new positioned element, so the bottom-centre HUD stack is untouched.
  // Mutates the DOM only when the glyph actually changes; _updateEraHud re-adds it after an era rewrite.
  _updateDayPhaseHud() {
    const el = this._eraHudEl, dn = this.dayNight;
    if (!el || !dn) return;
    const icon = dn.icon;
    if (icon === this._dayPhaseIcon && this._dayPhaseEl && this._dayPhaseEl.parentNode === el) return;
    this._dayPhaseIcon = icon;
    if (!this._dayPhaseEl || this._dayPhaseEl.parentNode !== el) {
      this._dayPhaseEl = document.createElement("span");
      this._dayPhaseEl.className = "era-hud-phase";
      this._dayPhaseEl.setAttribute("aria-hidden", "true");
      el.insertBefore(this._dayPhaseEl, el.firstChild);
    }
    this._dayPhaseEl.textContent = icon;
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

  // ---- task 32「文明演化系统一期」：纪元主题渐变 ------------------------------------
  // setCivStage() 由 civstage.js 仅在档位签名变化时调用（事件驱动）。它把当前灯光/雾/海面色
  // 捕获为淡入起点、存下目标调色板，并武装一条 ≤2s 的交叉淡入，由 update() 内的 _updateCivFade()
  // 推进。首次调用直接 snap（无淡入），所以新加载绝不会播一段做作的 intro。地形顶点色永不触碰
  // （性能红线）——只有灯光、雾、海面色移动。instant=true 可强制 snap（供调试/验证）。
  setCivStage(stage, instant) {
    const s = Math.max(0, Math.min(CIV_PALETTES.length - 1, stage | 0));
    const first = this._civStage == null;
    if (!first && this._civStage === s && this._civFadeDone) return;   // already there and settled
    this._civStage = s;
    const P = CIV_PALETTES[s];
    this._civTo.hemiSky.setHex(P.hemiSky);
    this._civTo.hemiGround.setHex(P.hemiGround);
    this._civTo.sun.setHex(P.sun);
    this._civTo.fog.setHex(P.fog);
    this._civTo.water.setHex(P.water);
    if (first || instant) {
      this.hemiLight.color.copy(this._civTo.hemiSky);
      this.hemiLight.groundColor.copy(this._civTo.hemiGround);
      this.sunLight.color.copy(this._civTo.sun);
      if (this.scene.fog) this.scene.fog.color.copy(this._civTo.fog);
      if (this.water && this.water.material) this.water.material.color.copy(this._civTo.water);
      this._civFadeDone = true;
      return;
    }
    // capture the live colours as the fade start (whatever the previous stage / transition left them at)
    this._civFrom.hemiSky.copy(this.hemiLight.color);
    this._civFrom.hemiGround.copy(this.hemiLight.groundColor);
    this._civFrom.sun.copy(this.sunLight.color);
    if (this.scene.fog) this._civFrom.fog.copy(this.scene.fog.color); else this._civFrom.fog.copy(this._civTo.fog);
    if (this.water && this.water.material) this._civFrom.water.copy(this.water.material.color); else this._civFrom.water.copy(this._civTo.water);
    this._civFadeStart = performance.now();
    this._civFadeDone = false;
  }
  _updateCivFade(now) {
    if (this._civFadeDone) return;   // idle: one boolean per frame, zero allocation
    const t = (now - this._civFadeStart) / (CIV_FADE_S * 1000);
    const e = t >= 1 ? 1 : (t <= 0 ? 0 : t * t * (3 - 2 * t));   // smoothstep ease
    this.hemiLight.color.copy(this._civFrom.hemiSky).lerp(this._civTo.hemiSky, e);
    this.hemiLight.groundColor.copy(this._civFrom.hemiGround).lerp(this._civTo.hemiGround, e);
    this.sunLight.color.copy(this._civFrom.sun).lerp(this._civTo.sun, e);
    if (this.scene.fog) this.scene.fog.color.copy(this._civFrom.fog).lerp(this._civTo.fog, e);
    if (this.water && this.water.material) this.water.material.color.copy(this._civFrom.water).lerp(this._civTo.water, e);
    if (t >= 1) this._civFadeDone = true;   // self-stop at the ≤2s budget
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
    // task 50: tear the particle system down first — it removes its Points from the scene so the
    // traverse below never double-disposes the shared geometry/material — and drop the debug hooks.
    if (this.particles) { try { this.particles.dispose(); } catch (_) { /* already gone */ } this.particles = null; }
    try { delete window.__murmurBurst; delete window.__murmurWeather; delete window.__murmurParticles; } catch (_) { /* ignore */ }
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
      const wt = this.water.material.normalMap;   // plane water — explicit normalMap release
      if (wt && wt.dispose && !seenTex.has(wt)) { seenTex.add(wt); wt.dispose(); }
    }
    if (this._terrainUniforms) {
      for (const k of ['tGrass','tRock','tSand','tSnow','tDetailNormal']) {
        const t = this._terrainUniforms[k] && this._terrainUniforms[k].value;
        if (t && t.dispose && !seenTex.has(t)) { seenTex.add(t); t.dispose(); }
      }
    }
    if (this._castleLib) for (const kk in this._castleLib) {
      const e = this._castleLib[kk];
      if (!e) continue;
      if (e.geometry && e.geometry.dispose) e.geometry.dispose();
      if (e.material) { const ms = Array.isArray(e.material) ? e.material : [e.material]; for (const m of ms) killMat(m); }
    }
    // task 24: shared procedural caches (castle stonework/roofs, plinth, cottages, mills, trees)
    for (const k of ["_castleStoneGeo", "_castleRoofGeo", "_castleWoodGeo", "_castleFlagGeo", "_castleWindowGeo", "_plinthGeo", "_houseGeo", "_millGeo", "_broadGeo", "_coniferGeo"]) {
      if (this[k] && this[k].dispose) this[k].dispose();
    }
    for (const k of ["_plinthMat", "_villageMat", "_treeMat"]) {
      if (this[k]) killMat(this[k]);
    }
    if (this.scene.environment && this.scene.environment.dispose) this.scene.environment.dispose();
    if (this._ramp && this._ramp.dispose) this._ramp.dispose();
    if (this.controls && this.controls.dispose) this.controls.dispose();
    if (this.renderer && this.renderer.dispose) this.renderer.dispose();
  }
}
