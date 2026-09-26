// landLayer.js — task 55: 3D land pixel grid visualization layer.
// Renders a 24×15 parcel grid over the continent, with purchased parcels showing
// their uploaded image and unpurchased parcels showing a translucent nation-tinted fill.
// Raycast hover highlights; click opens the land purchase drawer.
// Performance target: <2ms per frame (instanced geometry, no per-frame allocation).

import { state, API } from './shared.js';
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
    this._onPointerMove = null;
    this._onClick = null;
    this.onParcelClick = null;      // callback: (parcelId) => void

    this._build();
    this._bindEvents();

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

    // grid lines — LineSegments, semi-transparent white
    const pts = [];
    const hw = GRID_W / 2, hh = GRID_H / 2;
    // vertical lines
    for (let i = 0; i <= GRID_X; i++) {
      const x = -hw + i * PARCEL_SIZE;
      pts.push(x, 0, -hh, x, 0, hh);
    }
    // horizontal lines
    for (let j = 0; j <= GRID_Z; j++) {
      const z = -hh + j * PARCEL_SIZE;
      pts.push(-hw, 0, z, hw, 0, z);
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
    this._gridLines.position.y = 0.6;   // float slightly above terrain
    this.group.add(this._gridLines);

    // hover highlight — a single plane that moves to the hovered parcel
    this._hoverMat = new THREE.MeshBasicMaterial({
      color: 0xffd700,
      transparent: true,
      opacity: 0.35,
      side: THREE.DoubleSide,
      depthWrite: false,
    });
    this._hoverMesh = new THREE.Mesh(this._planeGeo, this._hoverMat);
    this._hoverMesh.rotation.x = -Math.PI / 2;
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
    this._emptyMesh.count = 0;
    this._emptyMesh.frustumCulled = false;
    this.group.add(this._emptyMesh);
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
      if (m.material && m.material.map) {
        // don't dispose shared textures
      }
      m.geometry !== this._planeGeo && m.geometry.dispose();
      m.material.dispose();
    }
    this._filledMeshes = [];

    const owned = new Set();
    const dummy = new THREE.Object3D();
    let emptyIdx = 0;

    for (const p of this.parcels) {
      if (p.owner) {
        owned.add(p.id);
        // purchased parcel — textured plane
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

    // reposition grid lines to average terrain height
    this._gridLines.position.y = 0.6;
  }

  // ---- add a textured plane for a purchased parcel ----
  _addFilledParcel(parcel) {
    const { x, z } = this.parcelWorldPos(parcel.id);
    const y = this._groundY(x, z) + 0.7;

    const mat = new THREE.MeshBasicMaterial({
      color: 0xffffff,
      side: THREE.DoubleSide,
      transparent: true,
      opacity: 0.92,
      depthWrite: false,
    });

    const mesh = new THREE.Mesh(this._planeGeo, mat);
    mesh.rotation.x = -Math.PI / 2;
    mesh.position.set(x, y, z);
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

    this._onPointerMove = (e) => this._handleMove(e);
    this._onClick = (e) => this._handleClick(e);
    cvEl.addEventListener('pointermove', this._onPointerMove, { passive: true });
    cvEl.addEventListener('click', this._onClick);
  }

  _handleMove(e) {
    if (!this.enabled || !this.group.visible) return;
    if (state.walkMode && state.walkMode.active) return;

    const cvEl = this.ts.renderer.domElement;
    const rect = cvEl.getBoundingClientRect();
    if (!rect.width || !rect.height) return;

    this._ndc.set(
      ((e.clientX - rect.left) / rect.width) * 2 - 1,
      -((e.clientY - rect.top) / rect.height) * 2 + 1
    );
    this._raycaster.setFromCamera(this._ndc, this.ts.camera);

    // intersect the land group children (filled meshes + empty instanced mesh)
    const targets = [...this._filledMeshes];
    if (this._emptyMesh.count > 0) targets.push(this._emptyMesh);

    const hits = this._raycaster.intersectObjects(targets, false);
    let parcelId = -1;

    if (hits.length > 0) {
      const hit = hits[0];
      if (hit.object.userData && hit.object.userData.parcelId != null) {
        parcelId = hit.object.userData.parcelId;
      } else if (hit.object === this._emptyMesh && hit.instanceId != null) {
        // map instance index back to parcel id
        parcelId = this._instanceToParcelId(hit.instanceId);
      }
    }

    if (parcelId !== this.hoveredId) {
      this.hoveredId = parcelId;
      this._updateHover();
      cvEl.style.cursor = parcelId >= 0 ? 'pointer' : '';
    }
  }

  _handleClick(e) {
    if (this.hoveredId < 0) return;
    if (typeof this.onParcelClick === 'function') {
      this.onParcelClick(this.hoveredId);
    }
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
    const y = this._groundY(x, z) + 0.9;
    this._hoverMesh.position.set(x, y, z);
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

  // ---- dispose ----
  dispose() {
    const cvEl = this.ts && this.ts.renderer && this.ts.renderer.domElement;
    if (cvEl) {
      if (this._onPointerMove) cvEl.removeEventListener('pointermove', this._onPointerMove);
      if (this._onClick) cvEl.removeEventListener('click', this._onClick);
    }
    if (this.ts && this.ts.scene) this.ts.scene.remove(this.group);
    this._planeGeo.dispose();
    this._hoverMat.dispose();
    this._emptyMat.dispose();
    for (const tex of this._textures.values()) tex.dispose();
    this._textures.clear();
  }
}
