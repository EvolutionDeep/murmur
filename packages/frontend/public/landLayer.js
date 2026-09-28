// landLayer.js — task 55: 3D land pixel grid visualization layer.
// Renders a 24×15 parcel grid over the continent, with purchased parcels showing
// their uploaded image and unpurchased parcels showing a translucent nation-tinted fill.
// Raycast hover highlights; click opens the land purchase drawer.
// Performance target: <2ms per frame (instanced geometry, no per-frame allocation).

import { state, API, shortHash } from './shared.js';
import { t as T } from './i18n.js?v=103';
import * as THREE from 'three';

// ---- constants ----
const GRID_X = 24;
const GRID_Z = 15;
const PARCEL_SIZE = 30;          // each parcel is 30×30 world units
const GRID_W = GRID_X * PARCEL_SIZE;  // 720 — matches _WSX
const GRID_H = GRID_Z * PARCEL_SIZE;  // 450 — matches _WSZ
const POLL_INTERVAL = 60000;     // refresh land data every 60s

/**
 * LandLayer — manages the 3D grid visualization for the land parcel system.
 * Instantiate after ThreeScene is ready; call update() each frame.
 */
export class LandLayer {
  constructor(threeScene) {
    this.ts = threeScene;           // reference to ThreeScene for scene/heightAt
    this.group = new THREE.Group();
    this.group.name = 'landLayer';
    this.group.renderOrder = 2;

    // state
    this.data = null;               // last GET /land response
    this.parcels = [];              // parcel array from API
    this.lastPoll = 0;
    this.hoveredId = -1;
    this.enabled = true;

    // geometry containers
    this._gridLines = null;         // LineSegments for the grid
    this._filledMeshes = [];        // individual meshes for purchased parcels (with textures)
    this._emptyMesh = null;         // InstancedMesh for unpurchased parcels
    this._hoverMesh = null;         // single highlight plane
    this._textures = new Map();     // parcelId → THREE.Texture (cached)

    // raycaster (reuse from scene or create own)
    this._raycaster = new THREE.Raycaster();
    this._ndc = new THREE.Vector2();
    this._hoverMat = null;
    this._emptyMat = null;
    this._planeGeo = null;

    // event binding
    this._onPointerDown = null;
    this._onPointerMove = null;
    this._onClick = null;
    this._downPos = null;           // { x, y } for drag guard
    this.onParcelClick = null;      // callback: (parcelId) => void

    this._build();
    this._bindEvents();
    this._initLeaderboard();

    // add to scene
    if (this.ts && this.ts.scene) {
      this.ts.scene.add(this.group);
    }

    // initial fetch
    this.refresh();
  }

  // ---- build the static grid lines ----
  _build() {
    this._planeGeo = new THREE.PlaneGeometry(PARCEL_SIZE - 0.5, PARCEL_SIZE - 0.5);

    // grid lines — LineSegments conforming to terrain
    this._buildGridLines();

    // hover highlight — a subdivided plane that conforms to terrain
    this._hoverMat = new THREE.MeshBasicMaterial({
      color: 0xffd700,
      transparent: true,
      opacity: 0.35,
      side: THREE.DoubleSide,
      depthWrite: false,
    });
    this._hoverGeo = this._createTerrainPlane(0, 0, 8);
    this._hoverMesh = new THREE.Mesh(this._hoverGeo, this._hoverMat);
    this._hoverMesh.renderOrder = 4;
    this._hoverMesh.visible = false;
    this.group.add(this._hoverMesh);

    // unpurchased parcels — InstancedMesh with translucent fill
    this._emptyMat = new THREE.MeshBasicMaterial({
      color: 0x88ccaa,
      transparent: true,
      opacity: 0.12,
      side: THREE.DoubleSide,
      depthWrite: false,
    });
    const maxEmpty = GRID_X * GRID_Z;
    this._emptyMesh = new THREE.InstancedMesh(this._planeGeo, this._emptyMat, maxEmpty);
    this._emptyMesh.rotation.x = 0;  // we'll set per-instance matrices
    this._emptyMesh.renderOrder = 3;
    this._emptyMesh.frustumCulled = false;
    this.group.add(this._emptyMesh);

    // Synchronously populate all 360 instances so parcels are clickable
    // immediately — don't wait for the async API response.
    this._populateDefaultGrid();
  }

  // ---- build grid lines conforming to terrain ----
  _buildGridLines() {
    const pts = [];
    const hw = GRID_W / 2, hh = GRID_H / 2;
    const SAMPLE_STEP = 10; // sample terrain every 10 units along each line
    const Y_OFF = 0.45;     // slight offset above terrain

    // vertical lines (along Z axis)
    for (let i = 0; i <= GRID_X; i++) {
      const x = -hw + i * PARCEL_SIZE;
      for (let s = -hh; s < hh; s += SAMPLE_STEP) {
        const s2 = Math.min(s + SAMPLE_STEP, hh);
        const y1 = this._heightAt(x, s) + Y_OFF;
        const y2 = this._heightAt(x, s2) + Y_OFF;
        pts.push(x, y1, s, x, y2, s2);
      }
    }
    // horizontal lines (along X axis)
    for (let j = 0; j <= GRID_Z; j++) {
      const z = -hh + j * PARCEL_SIZE;
      for (let s = -hw; s < hw; s += SAMPLE_STEP) {
        const s2 = Math.min(s + SAMPLE_STEP, hw);
        const y1 = this._heightAt(s, z) + Y_OFF;
        const y2 = this._heightAt(s2, z) + Y_OFF;
        pts.push(s, y1, z, s2, y2, z);
      }
    }
    const lineGeo = new THREE.BufferGeometry();
    lineGeo.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3));
    const lineMat = new THREE.LineBasicMaterial({
      color: 0xffffff,
      transparent: true,
      opacity: 0.18,
      depthWrite: false,
    });
    this._gridLines = new THREE.LineSegments(lineGeo, lineMat);
    this._gridLines.renderOrder = 2;
    this.group.add(this._gridLines);
  }

  // ---- fill _emptyMesh with all parcels at default height (sync, no API needed) ----
  _populateDefaultGrid() {
    const dummy = new THREE.Object3D();
    const col = new THREE.Color(0x88ccaa);
    let idx = 0;
    for (let id = 0; id < GRID_X * GRID_Z; id++) {
      const { x, z } = this.parcelWorldPos(id);
      dummy.position.set(x, 0.5, z);
      dummy.rotation.set(-Math.PI / 2, 0, 0);
      dummy.scale.set(1, 1, 1);
      dummy.updateMatrix();
      this._emptyMesh.setMatrixAt(idx, dummy.matrix);
      this._emptyMesh.setColorAt(idx, col);
      idx++;
    }
    this._emptyMesh.count = idx;
    this._emptyMesh.instanceMatrix.needsUpdate = true;
    if (this._emptyMesh.instanceColor) this._emptyMesh.instanceColor.needsUpdate = true;
    this._emptyMesh.computeBoundingSphere();
  }

  // ---- world position of a parcel by id ----
  parcelWorldPos(id) {
    const col = id % GRID_X;
    const row = Math.floor(id / GRID_X);
    const x = -GRID_W / 2 + col * PARCEL_SIZE + PARCEL_SIZE / 2;
    const z = -GRID_H / 2 + row * PARCEL_SIZE + PARCEL_SIZE / 2;
    return { x, z };
  }

  // ---- parcel id from world position ----
  parcelIdAt(x, z) {
    const col = Math.floor((x + GRID_W / 2) / PARCEL_SIZE);
    const row = Math.floor((z + GRID_H / 2) / PARCEL_SIZE);
    if (col < 0 || col >= GRID_X || row < 0 || row >= GRID_Z) return -1;
    return row * GRID_X + col;
  }

  // ---- fetch land data from API ----
  async refresh() {
    const now = Date.now();
    if (now - this.lastPoll < POLL_INTERVAL && this.data) return;
    this.lastPoll = now;
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 8000);
      const r = await fetch(API + '/land', { cache: 'no-store', signal: ctrl.signal });
      clearTimeout(timer);
      if (!r.ok) return;
      const json = await r.json();
      if (json && json.enabled !== false) {
        this.data = json;
        this.parcels = json.parcels || [];
        this._rebuildParcels();
      } else {
        this.enabled = false;
        this.group.visible = false;
      }
    } catch (e) {
      // silent — land layer is non-critical
    }
  }

  // ---- rebuild parcel meshes after data refresh ----
  _rebuildParcels() {
    // remove old filled meshes
    for (const m of this._filledMeshes) {
      this.group.remove(m);
      m.geometry.dispose();
      m.material.dispose();
    }
    this._filledMeshes = [];

    const owned = new Set();
    const dummy = new THREE.Object3D();
    let emptyIdx = 0;

    for (const p of this.parcels) {
      if (p.owner) {
        owned.add(p.id);
        // purchased parcel — terrain-conforming textured mesh
        this._addFilledParcel(p);
      }
    }

    // fill instanced mesh for unowned parcels
    const total = GRID_X * GRID_Z;
    for (let id = 0; id < total; id++) {
      if (owned.has(id)) continue;
      const { x, z } = this.parcelWorldPos(id);
      const y = this._groundY(x, z) + 0.5;
      dummy.position.set(x, y, z);
      dummy.rotation.set(-Math.PI / 2, 0, 0);
      dummy.scale.set(1, 1, 1);
      dummy.updateMatrix();
      this._emptyMesh.setMatrixAt(emptyIdx, dummy.matrix);
      // tint by nation zone
      const col = this._nationColorFor(x, z);
      this._emptyMesh.setColorAt(emptyIdx, col);
      emptyIdx++;
    }
    this._emptyMesh.count = emptyIdx;
    this._emptyMesh.instanceMatrix.needsUpdate = true;
    if (this._emptyMesh.instanceColor) this._emptyMesh.instanceColor.needsUpdate = true;
    this._emptyMesh.computeBoundingSphere();

    // rebuild grid lines to conform to (possibly sculpted) terrain
    if (this._gridLines) {
      this.group.remove(this._gridLines);
      this._gridLines.geometry.dispose();
      this._gridLines.material.dispose();
    }
    this._buildGridLines();

    // task 56: refresh the on-canvas wallet-parcel leaderboard whenever data changes
    this._renderLeaderboard();
  }

  // ---- create a terrain-conforming subdivided plane geometry ----
  // Returns a PlaneGeometry(PARCEL_SIZE, PARCEL_SIZE, segs, segs) rotated horizontal
  // with each vertex displaced to terrain height + yOffset.
  _createTerrainPlane(centerX, centerZ, segs, yOffset) {
    const yOff = yOffset != null ? yOffset : 0.35;
    const size = PARCEL_SIZE - 0.5;
    const geo = new THREE.PlaneGeometry(size, size, segs, segs);
    geo.rotateX(-Math.PI / 2); // lay flat: local Y becomes world Y
    const pos = geo.attributes.position;
    for (let i = 0; i < pos.count; i++) {
      const lx = pos.getX(i);
      const lz = pos.getZ(i);
      const wx = centerX + lx;
      const wz = centerZ + lz;
      pos.setY(i, this._heightAt(wx, wz) + yOff);
    }
    pos.needsUpdate = true;
    geo.computeVertexNormals();
    geo.computeBoundingSphere();
    return geo;
  }

  // ---- add a terrain-conforming textured mesh for a purchased parcel ----
  _addFilledParcel(parcel) {
    const { x, z } = this.parcelWorldPos(parcel.id);

    const mat = new THREE.MeshBasicMaterial({
      color: 0xffffff,
      side: THREE.DoubleSide,
      transparent: true,
      opacity: 0.92,
      depthWrite: false,
    });

    // 8×8 subdivision conforms to terrain undulations within the parcel
    const geo = this._createTerrainPlane(x, z, 8, 0.35);
    const mesh = new THREE.Mesh(geo, mat);
    mesh.position.set(x, 0, z); // vertices already in world-space Y
    mesh.renderOrder = 3;
    mesh.userData = { parcelId: parcel.id };
    this.group.add(mesh);
    this._filledMeshes.push(mesh);

    // load texture from imageUrl
    if (parcel.imageUrl) {
      const url = parcel.imageUrl.startsWith('http')
        ? parcel.imageUrl
        : API + parcel.imageUrl;
      this._loadTexture(url, parcel.id, mat);
    }
  }

  // ---- async texture loader with cache ----
  _loadTexture(url, parcelId, material) {
    if (this._textures.has(parcelId)) {
      material.map = this._textures.get(parcelId);
      material.needsUpdate = true;
      return;
    }
    const loader = new THREE.TextureLoader();
    loader.load(url, (tex) => {
      tex.colorSpace = THREE.SRGBColorSpace;
      tex.minFilter = THREE.LinearFilter;
      tex.magFilter = THREE.LinearFilter;
      this._textures.set(parcelId, tex);
      material.map = tex;
      material.needsUpdate = true;
    }, undefined, () => {
      // load failed — leave plain white
    });
  }

  // ---- terrain height sampling ----
  _groundY(x, z) {
    if (this.ts && typeof this.ts.groundY === 'function') {
      return this.ts.groundY(x, z, PARCEL_SIZE * 0.4);
    }
    return 0;
  }

  // ---- single-point terrain height (bilinear sample) ----
  _heightAt(x, z) {
    if (this.ts && typeof this.ts.heightAt === 'function') {
      return this.ts.heightAt(x, z);
    }
    return 0;
  }

  // ---- nation color for a world position (used for empty parcel tinting) ----
  _nationColorFor(x, z) {
    const col = new THREE.Color();
    if (this.ts && this.ts._nationData && this.ts._nationData.voronoi) {
      try {
        const nat = this.ts._nationData;
        const idx = nat.voronoi.find(x, z);
        if (idx >= 0 && nat.nationColors && nat.nationColors[idx]) {
          col.copy(nat.nationColors[idx]);
          col.lerp(new THREE.Color(0xffffff), 0.5);  // lighten
          return col;
        }
      } catch (e) { /* fall through */ }
    }
    // default: soft sage green
    col.setHex(0x88ccaa);
    return col;
  }

  // ---- pointer events ----
  _bindEvents() {
    const cvEl = this.ts && this.ts.renderer && this.ts.renderer.domElement;
    if (!cvEl) return;

    this._onPointerDown = (e) => { this._downPos = { x: e.clientX, y: e.clientY }; };
    this._onPointerMove = (e) => this._handleMove(e);
    this._onClick = (e) => this._handleClick(e);
    cvEl.addEventListener('pointerdown', this._onPointerDown, { passive: true });
    cvEl.addEventListener('pointermove', this._onPointerMove, { passive: true });
    cvEl.addEventListener('click', this._onClick);
  }

  _handleMove(e) {
    if (!this.enabled || !this.group.visible) return;
    if (state.walkMode && state.walkMode.active) return;

    const parcelId = this._parcelAtEvent(e);

    if (parcelId !== this.hoveredId) {
      this.hoveredId = parcelId;
      this._updateHover();
      const cvEl = this.ts.renderer.domElement;
      cvEl.style.cursor = parcelId >= 0 ? 'pointer' : '';
    }
  }

  _handleClick(e) {
    if (!this.enabled || !this.group.visible) return;
    if (state.walkMode && state.walkMode.active) return;

    // Drag guard: ignore clicks where the pointer moved significantly (camera orbit)
    if (this._downPos && Math.hypot(e.clientX - this._downPos.x, e.clientY - this._downPos.y) > 8) return;

    // Perform a fresh raycast at the click position — don't rely on hover state,
    // which never fires on touch devices (no pointermove before click during a tap).
    const parcelId = this._parcelAtEvent(e);
    if (parcelId >= 0 && typeof this.onParcelClick === 'function') {
      this.onParcelClick(parcelId);
    }
  }

  // ---- shared raycast logic: resolve a parcel id from a pointer/click event ----
  _parcelAtEvent(e) {
    const cvEl = this.ts.renderer.domElement;
    const rect = cvEl.getBoundingClientRect();
    if (!rect.width || !rect.height) return -1;

    // Ensure camera world matrix is fresh — OrbitControls damping may have
    // moved the camera after the last render, leaving matrixWorldNeedsUpdate
    // true.  Without this, setFromCamera produces a stale/zero-direction ray.
    this.ts.camera.updateMatrixWorld();

    this._ndc.set(
      ((e.clientX - rect.left) / rect.width) * 2 - 1,
      -((e.clientY - rect.top) / rect.height) * 2 + 1
    );
    this._raycaster.setFromCamera(this._ndc, this.ts.camera);

    // 1) Try precise mesh raycast first
    const targets = [...this._filledMeshes];
    if (this._emptyMesh.count > 0) targets.push(this._emptyMesh);

    const hits = this._raycaster.intersectObjects(targets, false);
    if (hits.length > 0) {
      const hit = hits[0];
      if (hit.object.userData && hit.object.userData.parcelId != null) {
        return hit.object.userData.parcelId;
      } else if (hit.object === this._emptyMesh && hit.instanceId != null) {
        return this._instanceToParcelId(hit.instanceId);
      }
    }

    // 2) Mathematical fallback: intersect ray with ground plane (y≈0) and
    //    determine the parcel cell from the world XZ coordinate.  This ensures
    //    clicks always resolve even when the instanced planes are too small on
    //    screen or slightly below terrain.
    const ray = this._raycaster.ray;
    if (Math.abs(ray.direction.y) > 1e-6) {
      const t = (0 - ray.origin.y) / ray.direction.y;
      if (t > 0) {
        const px = ray.origin.x + ray.direction.x * t;
        const pz = ray.origin.z + ray.direction.z * t;
        const id = this.parcelIdAt(px, pz);
        if (id >= 0) return id;
      }
    }
    return -1;
  }

  // ---- map an instanceId of _emptyMesh back to a parcel id ----
  _instanceToParcelId(instanceIdx) {
    const owned = new Set();
    for (const p of this.parcels) {
      if (p.owner) owned.add(p.id);
    }
    let count = 0;
    const total = GRID_X * GRID_Z;
    for (let id = 0; id < total; id++) {
      if (owned.has(id)) continue;
      if (count === instanceIdx) return id;
      count++;
    }
    return -1;
  }

  // ---- move the hover highlight to the hovered parcel ----
  _updateHover() {
    if (this.hoveredId < 0) {
      this._hoverMesh.visible = false;
      return;
    }
    const { x, z } = this.parcelWorldPos(this.hoveredId);
    // Rebuild hover geometry to conform to terrain at the hovered position
    this._hoverMesh.geometry.dispose();
    this._hoverMesh.geometry = this._createTerrainPlane(x, z, 6, 0.55);
    this._hoverMesh.position.set(x, 0, z);
    this._hoverMesh.visible = true;
  }

  // ---- per-frame update (called from scene update loop) ----
  update(dt, now) {
    if (!this.enabled) return;
    // poll for fresh data periodically
    this.refresh();
    // subtle hover pulse
    if (this._hoverMesh.visible) {
      const pulse = 0.25 + Math.sin(now * 0.004) * 0.1;
      this._hoverMat.opacity = pulse;
    }
  }

  // ---- force a data refresh (called after purchase) ----
  forceRefresh() {
    this.lastPoll = 0;
    this._textures.clear();
    this.refresh();
  }

  // ============ task 56: on-canvas land leaderboard (wallet → parcel count) ============
  // A pure-DOM HUD leaf floated over the canvas; it ranks wallets by how many parcels
  // they own. Zero 3D cost, rebuilt only when GET /land data changes.

  // ---- wire up the leaderboard shell (collapse toggle + resize reposition) ----
  _initLeaderboard() {
    this._lbEl = document.getElementById('land-leaderboard');
    this._onResize = null;
    this._lbUserToggled = false;   // set the first time a visitor taps the header; see _autoCollapse
    this._lbRaf = 0;
    this._lbRO = null;
    if (!this._lbEl) return;

    // tight viewports start collapsed so the leaf never crowds the field
    if (this._isFlowLayout()) {
      this._lbEl.classList.add('is-collapsed');
      const h0 = this._lbEl.querySelector('#land-lb-head');
      if (h0) h0.setAttribute('aria-expanded', 'false');
    }

    const head = this._lbEl.querySelector('#land-lb-head');
    if (head) {
      head.addEventListener('click', () => {
        // an explicit tap wins over the automatic collapse for the rest of the session
        this._lbUserToggled = true;
        const collapsed = this._lbEl.classList.toggle('is-collapsed');
        head.setAttribute('aria-expanded', collapsed ? 'false' : 'true');
      });
    }

    // rAF-coalesced: a desktop window drag fires resize on every frame, and each call reads
    // getBoundingClientRect on three elements (a forced layout). One read per frame is enough.
    this._onResize = () => {
      if (this._lbRaf) return;
      this._lbRaf = requestAnimationFrame(() => {
        this._lbRaf = 0;
        this._positionLeaderboard();
      });
    };
    window.addEventListener('resize', this._onResize);

    // A window resize is only HALF of what moves this leaf. It is seated against .panel-pop's
    // bottom edge and the dock's top edge, and .panel-pop grows on its own: it renders 223px tall
    // from the cached snapshot and then reaches its 272px cap once the population poll lands,
    // seconds after load and with no resize in sight. Measured at 768x1024, that left the leaf
    // parked at top:375 while the panel's bottom edge had already moved to 412 — a 200x37 overlap
    // that no amount of resize handling could ever catch. So observe the two neighbours directly.
    // _lbEl is deliberately NOT in the list: _positionLeaderboard() writes its own maxHeight,
    // which would make the observer self-triggering.
    if (typeof ResizeObserver === 'function') {
      this._lbRO = new ResizeObserver(() => { if (this._onResize) this._onResize(); });
      for (const sel of ['.panel-pop', '#walk-btn', '.temple-btn']) {
        const n = document.querySelector(sel);
        if (n) this._lbRO.observe(n);
      }
    }
  }

  // ---- aggregate parcels by owner and paint the top-10 list ----
  _renderLeaderboard() {
    if (!this._lbEl) this._lbEl = document.getElementById('land-leaderboard');
    if (!this._lbEl) return;
    const list = this._lbEl.querySelector('#land-lb-list');
    if (!list) return;

    // owner(lowercase) → { addr, n, first } ; `first` = index of first parcel bought (tie-break)
    const byOwner = new Map();
    const parcels = this.parcels || [];
    for (let i = 0; i < parcels.length; i++) {
      const p = parcels[i];
      if (!p || !p.owner) continue;
      const key = String(p.owner).toLowerCase();
      let e = byOwner.get(key);
      if (!e) { e = { addr: String(p.owner), n: 0, first: i }; byOwner.set(key, e); }
      e.n++;
    }

    const rows = [...byOwner.values()]
      .sort((a, b) => (b.n - a.n) || (a.first - b.first))
      .slice(0, 10);

    const unit = T('land.parcels');
    if (rows.length === 0) {
      list.innerHTML = `<li class="land-lb-empty">${T('land.leaderboardEmpty')}</li>`;
    } else {
      let html = '';
      for (let i = 0; i < rows.length; i++) {
        const r = rows[i];
        const rank = i + 1;
        const medal = rank === 1 ? ' is-gold' : rank === 2 ? ' is-silver' : rank === 3 ? ' is-bronze' : '';
        const short = shortHash(r.addr);
        html += `<li class="land-lb-row${medal}">`
          + `<span class="land-lb-rank">${rank}</span>`
          + `<span class="land-lb-addr" title="${r.addr}">${short}</span>`
          + `<span class="land-lb-count">${r.n}<i>${unit}</i></span>`
          + `</li>`;
      }
      list.innerHTML = html;
    }

    this._syncLeaderboardVisibility();
  }

  // ---- which layout regime is the stylesheet in? ----
  // Must agree with styles.css, or the JS positions a leaf the CSS has already put in the flow.
  //   FLOW   regimes E + G: (max-width:680px) OR (max-height:480px) — the leaf is
  //          position:relative inside the scrolling column; there is nothing to position.
  //   FIXED  regimes B/C/D/F: 681px+ wide and 481px+ tall — the leaf hangs off the right edge.
  // This is deliberately NOT the CSS's own `(max-width:680px), (max-height:600px)` test: regime F
  // pulls 681px+-wide, ≤600px-tall laptops (1280x600, 1366x600) back into the fixed corner layout,
  // so those windows still need JS positioning even though they match the flow media query.
  _isFlowLayout() {
    return window.innerWidth <= 680 || window.innerHeight <= 480;
  }

  // ---- seat the leaf just below the top-right population panel ----
  // The old code carried a "GUARANTEE: maxHeight is always ≥ 160px" floor. That guarantee was
  // exactly the bug: at 1280x720 there is only ~50px of room between .panel-pop and .walk-btn, so
  // enforcing 160px drove the leaf 17px into the walk button. The contract is now the honest one —
  // never taller than the space that actually exists, and when that space cannot hold the list,
  // collapse to the header row instead of spilling over the dock.
  _positionLeaderboard() {
    if (!this._lbEl) return;
    if (this._isFlowLayout()) {
      this._lbEl.style.top = '';
      this._lbEl.style.maxHeight = '';
      return;
    }

    // WHERE IT STARTS: 12px below .panel-pop. Progressive disclosure hides .panel-pop under 700px
    // of height, so fall back to the second rail (--band-2 = topbar + tray + 20), measured from the
    // live DOM rather than from the hard-coded `topbar-h + 44` that stopped being true the day the
    // layer tray grew from 28px to 48px under a coarse pointer.
    let top = 0;
    const pop = document.querySelector('.panel-pop');
    if (pop) {
      const r = pop.getBoundingClientRect();
      if (r.height > 0 && r.bottom > 0) top = Math.round(r.bottom + 12);
    }
    if (top <= 0) {
      const tb = document.querySelector('.topbar');
      const tray = document.querySelector('.layer-toggles');
      const tbH = tb && tb.offsetHeight > 0 ? tb.offsetHeight : 56;
      // Only count the tray when it is parked under the topbar. In the tablet regime (≤820px) the
      // tray lives on the BOTTOM edge, and adding its height here would push the leaf off-screen.
      let trayH = 0;
      if (tray) {
        const tr = tray.getBoundingClientRect();
        if (tr.height > 0 && tr.top < window.innerHeight / 2) trayH = tr.height;
      }
      top = Math.round(tbH + trayH + 20);
    }
    this._lbEl.style.top = `${top}px`;

    // WHERE IT STOPS: 12px above .walk-btn, the topmost rung of the right-edge dock ladder.
    // offsetParent is ALWAYS null for a position:fixed element, so the previous
    // `walkBtn.offsetParent !== null` visibility guard could never fire — dockTop fell through to
    // the `innerHeight - 378` guess on every single viewport. Measure the rect instead.
    let dockTop = 0;
    const walkBtn = document.getElementById('walk-btn');
    if (walkBtn) {
      const w = walkBtn.getBoundingClientRect();
      if (w.width > 0 && w.height > 0) dockTop = w.top;
    }
    if (!(dockTop > 0)) {
      // walk mode off / button not on stage: the rung below it is the real ceiling
      const temple = document.querySelector('.temple-btn');
      if (temple) {
        const t = temple.getBoundingClientRect();
        if (t.width > 0 && t.height > 0) dockTop = t.top;
      }
    }
    if (!(dockTop > 0)) dockTop = window.innerHeight - 12;

    const avail = Math.round(dockTop - 12 - top);
    const maxH = Math.max(44, Math.min(avail, 320));
    this._lbEl.style.maxHeight = `${maxH}px`;
    this._autoCollapseLeaderboard(avail);
  }

  // ---- fold the list away when the right flank genuinely has no room for it ----
  // 44px is the header row on its own; 320px is the CSS ceiling. Under 120px of room the ten rows
  // would be clipped to an unreadable stub, so the leaf collapses to its header instead. Latches
  // off the moment the visitor taps the header (_lbUserToggled) — a resize must never fight an
  // explicit choice.
  _autoCollapseLeaderboard(avail) {
    if (!this._lbEl || this._lbUserToggled) return;
    const head = this._lbEl.querySelector('#land-lb-head');
    const collapsed = this._lbEl.classList.toggle('is-collapsed', avail < 120);
    if (head) head.setAttribute('aria-expanded', collapsed ? 'false' : 'true');
  }

  // ---- show the leaf only while the land layer is live ----
  _syncLeaderboardVisibility() {
    if (!this._lbEl) return;
    const show = !!(this.enabled && this.group && this.group.visible && this.data);
    this._lbEl.hidden = !show;
    if (show) this._positionLeaderboard();
  }

  // ---- public: re-sync the leaderboard after the layer toggle flips (called from main.js) ----
  refreshLeaderboard() {
    if (this.data) this._renderLeaderboard();
    else this._syncLeaderboardVisibility();
  }

  // ---- dispose ----
  dispose() {
    const cvEl = this.ts && this.ts.renderer && this.ts.renderer.domElement;
    if (cvEl) {
      if (this._onPointerDown) cvEl.removeEventListener('pointerdown', this._onPointerDown);
      if (this._onPointerMove) cvEl.removeEventListener('pointermove', this._onPointerMove);
      if (this._onClick) cvEl.removeEventListener('click', this._onClick);
    }
    if (this._onResize) window.removeEventListener('resize', this._onResize);
    if (this._lbRO) { this._lbRO.disconnect(); this._lbRO = null; }
    if (this._lbRaf) { cancelAnimationFrame(this._lbRaf); this._lbRaf = 0; }
    if (this.ts && this.ts.scene) this.ts.scene.remove(this.group);
    this._planeGeo.dispose();
    if (this._hoverGeo) this._hoverGeo.dispose();
    if (this._hoverMesh && this._hoverMesh.geometry !== this._hoverGeo) this._hoverMesh.geometry.dispose();
    this._hoverMat.dispose();
    this._emptyMat.dispose();
    if (this._gridLines) {
      this._gridLines.geometry.dispose();
      this._gridLines.material.dispose();
    }
    for (const tex of this._textures.values()) tex.dispose();
    this._textures.clear();
  }
}
