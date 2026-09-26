// Portions adapted from wowserhq/scene (MIT), © Wowser Contributors
// ============================================================================
// walkMode.js — WalkMode: first- / third-person ground exploration of the diorama
// ----------------------------------------------------------------------------
// The page normally reads the island as a tabletop model, from a bird's-eye
// OrbitControls camera parked ~500 units up. WalkMode puts the reader ON the
// land instead: a 1.6-unit eye, WASD + pointer-lock look, the coastline as a
// hard wall, a head-bob that only exists while you are actually moving, and an
// optional third-person chase on any single live fly.
//
// THE RED LINES this module is built to honour:
//   · ZERO allocation inside update() — scalar maths plus writes into the
//     camera's own position/rotation. No Vector3, no literal, no array, no
//     string. Everything that must persist is allocated once in the ctor.
//   · It never touches state.cam (the 2D view transform) and never calls
//     controls.update(). camera.js's setCameraMode() is the single authority
//     that decides which of the two camera drivers owns the frame, so the two
//     can never fight over camera.position.
//   · It never renders. scene3d.update() calls update(dt) INSTEAD of
//     controls.update(); scene3d.render() stays the only draw call.
//   · It owns no scene graph objects — no meshes, no lights, no helpers. The
//     only DOM it makes is the touch joystick, and only on a touch device.
// ============================================================================
import { state, $ } from './shared.js';
import { t as T } from './i18n.js?v=98';
import { setCameraMode } from './camera.js';

const DEG = Math.PI / 180;
const EYE_H = 1.6;        // ground → the reader's eye, in world units (a curtain wall is ~7, so the keeps still loom)
const WALK_SPD = 30;      // world units / second — 720 across the island ≈ 24s at a stroll
const SPRINT_K = 2.5;     // Shift multiplier
const WALK_FOV = 62;      // a wider lens than the 50° diorama view: first person needs the peripheral
const FOV_SPRINT = 1.09;  // sprinting widens the lens a touch more (cheap speed cue, no post-processing)
const PITCH_LIM = 80 * DEG;
const LOOK_SENS = 0.0022;   // rad per px of mouse travel
const TOUCH_SENS = 0.0052;  // rad per px of thumb travel — a thumb is coarser than a wrist
const SEA_Y = 0.38;         // the terrain's dry-sand colour step: below this you are standing in the sea
const ISLE_K = 0.44;        // hard ellipse guard, as a fraction of _WSX / _WSZ (the island mask peaks near 0.45)
const BOB_AMP = 0.16;       // peak head-bob lift, world units
const GROUND_LERP = 12;     // 1/s — how fast the eye rides the relief instead of snapping onto it
const CHASE_LERP = 6;       // 1/s — how fast the chase camera catches its fly
const FOLLOW_D = 9;         // default chase distance
const FOLLOW_DMIN = 4;
const FOLLOW_DMAX = 26;
const STICK_R = 58;         // touch joystick radius, CSS px
const MOVE_ZONE = 0.42;     // the left 42% of the screen is the walking thumb, the rest is the looking thumb
const TAU = Math.PI * 2;

/**
 * Ground-level camera driver. One instance for the life of the page, wired in
 * main.js and handed to ThreeScene as `scene.walkMode` so scene3d.update() can
 * drive it in place of OrbitControls.
 */
export class WalkMode {
  constructor(scene3d, camera, domElement) {
    this._s3 = scene3d || null;
    this._cam = camera || (scene3d && scene3d.camera) || null;
    this._dom = domElement || (scene3d && scene3d.renderer && scene3d.renderer.domElement) || null;
    this.active = false;
    this.touch = typeof window !== "undefined" &&
      (("ontouchstart" in window) || (navigator.maxTouchPoints || 0) > 0);

    // ---- pose (the only mutable per-frame state) ----
    this._px = 0; this._py = EYE_H; this._pz = 0;
    this._yaw = 0; this._pitch = -0.05;
    this._bob = 0; this._bobA = 0;

    // ---- input ----
    this._k = { f: 0, b: 0, l: 0, r: 0, run: 0 };   // held-key flags; written by keydown/keyup only
    this._tx = 0; this._tz = 0;                     // touch move-stick axes, −1..1
    this._dragLook = false;                         // mouse drag-look (the pointer-lock-denied fallback)
    this._locked = false;
    this._ptrs = new Map();                         // pointerId → {move, ox, oy, lx, ly}

    // ---- third-person chase ----
    this._follow = -1;                              // instance index (what followFly() takes)
    this._followId = null;                          // the fly's own id — the instance list is rebuilt every frame
    this._dist = FOLLOW_D;

    // ---- the orbit camera state we hand back on exit (allocated lazily, then reused) ----
    this._sp = null; this._sq = null; this._st = null;
    this._sfov = 50; this._sorder = "XYZ";

    // ---- DOM ----
    this._btn = $("walk-btn");
    this._hud = $("walk-hud");
    this._fol = $("walk-follow");
    this._cross = $("walk-cross");
    this._stick = null; this._knob = null;
    this._spawnOut = { x: 0, z: 0 };

    // ---- bound listeners (bound once, attached once, they all early-return while inactive) ----
    this._kd = (e) => this._onKeyDown(e);
    this._ku = (e) => this._onKeyUp(e);
    this._mm = (e) => this._onMouseMove(e);
    this._md = (e) => this._onMouseDown(e);
    this._mu = () => { this._dragLook = false; };
    this._plc = () => this._onLockChange();
    this._blur = () => { const k = this._k; k.f = k.b = k.l = k.r = k.run = 0; };
    this._pd = (e) => this._onTouchDown(e);
    this._pm = (e) => this._onTouchMove(e);
    this._pu = (e) => this._onTouchUp(e);
    this._bind();
  }

  // ------------------------------------------------------------------ wiring
  _bind() {
    // capture phase: our Escape must land before main.js's document-level drawer stack,
    // or leaving the island would also close whatever sheet happened to be open.
    window.addEventListener("keydown", this._kd, true);
    window.addEventListener("keyup", this._ku, true);
    window.addEventListener("blur", this._blur);
    document.addEventListener("pointerlockchange", this._plc);
    document.addEventListener("mousemove", this._mm);
    document.addEventListener("mouseup", this._mu);
    const d = this._dom;
    if (!d) return;
    d.addEventListener("mousedown", this._md);
    d.addEventListener("pointerdown", this._pd, { passive: false });
    d.addEventListener("pointermove", this._pm, { passive: false });
    d.addEventListener("pointerup", this._pu);
    d.addEventListener("pointercancel", this._pu);
  }

  dispose() {
    window.removeEventListener("keydown", this._kd, true);
    window.removeEventListener("keyup", this._ku, true);
    window.removeEventListener("blur", this._blur);
    document.removeEventListener("pointerlockchange", this._plc);
    document.removeEventListener("mousemove", this._mm);
    document.removeEventListener("mouseup", this._mu);
    const d = this._dom;
    if (d) {
      d.removeEventListener("mousedown", this._md);
      d.removeEventListener("pointerdown", this._pd);
      d.removeEventListener("pointermove", this._pm);
      d.removeEventListener("pointerup", this._pu);
      d.removeEventListener("pointercancel", this._pu);
    }
    this.disable();
    if (this._stick && this._stick.parentNode) this._stick.parentNode.removeChild(this._stick);
    this._stick = null; this._knob = null;
  }

  // ------------------------------------------------------------ mode switches
  /** Enter the island. Returns false (and changes nothing) if there is no live 3D scene. */
  enable() {
    const s3 = this._s3;
    if (this.active) return true;
    if (!s3 || !s3.camera || !s3.terrain) return false;
    this._cam = s3.camera;
    this._dom = this._dom || (s3.renderer && s3.renderer.domElement) || null;

    this._save();
    setCameraMode("walk");
    this.active = true;
    if (s3.controls) s3.controls.enabled = false;

    // Drop the reader where the swarm is, then step inland until the ground is dry.
    const c = this._spawn(this._spawnOut);
    this._px = c.x; this._pz = c.z;
    this._py = this._groundY(this._px, this._pz) + EYE_H;
    // Face the island's heart: the very first frame is a view of the civilisation, never open water.
    this._yaw = Math.atan2(this._px, this._pz);
    this._pitch = -0.05;
    this._bob = 0; this._bobA = 0;
    this._follow = -1; this._followId = null; this._dist = FOLLOW_D;

    this._cam.fov = WALK_FOV;
    this._cam.rotation.order = "YXZ";
    this._cam.updateProjectionMatrix();
    this._writePose();

    document.documentElement.classList.add("walk-active");
    document.body.classList.add("walk-active");
    document.body.classList.toggle("walk-touch", this.touch);
    document.body.classList.remove("walk-follow");
    if (this._hud) this._hud.hidden = false;
    if (this._cross) this._cross.hidden = false;
    this.paintChrome();
    if (!this.touch) this._requestLock();
    return true;
  }

  /** Hand the frame back to OrbitControls, exactly as we found it. */
  disable() {
    if (!this.active) return;
    this.active = false;
    setCameraMode("orbit");
    this.stopFollow();
    if (document.pointerLockElement) { try { document.exitPointerLock(); } catch { /* already out */ } }
    this._locked = false; this._dragLook = false;
    const k = this._k; k.f = k.b = k.l = k.r = k.run = 0;
    this._tx = 0; this._tz = 0;
    this._ptrs.clear();
    this._hideStick();
    this._restore();
    document.documentElement.classList.remove("walk-active");
    document.body.classList.remove("walk-active");
    document.body.classList.remove("walk-follow");
    if (this._hud) this._hud.hidden = true;
    if (this._cross) this._cross.hidden = true;
    this.paintChrome();
  }

  toggle() { if (this.active) this.disable(); else this.enable(); }

  // ------------------------------------------------------- orbit state save/restore
  _save() {
    const cam = this._cam, s3 = this._s3;
    if (!cam) return;
    if (!this._sp) this._sp = cam.position.clone(); else this._sp.copy(cam.position);
    if (!this._sq) this._sq = cam.quaternion.clone(); else this._sq.copy(cam.quaternion);
    const tgt = s3 && s3.controls ? s3.controls.target : null;
    if (tgt) { if (!this._st) this._st = tgt.clone(); else this._st.copy(tgt); }
    this._sfov = cam.fov || 50;
    this._sorder = cam.rotation.order || "XYZ";
  }

  _restore() {
    const cam = this._cam, s3 = this._s3;
    if (!cam) return;
    cam.rotation.order = this._sorder;
    cam.fov = this._sfov;
    cam.updateProjectionMatrix();
    if (this._sp) cam.position.copy(this._sp);
    if (this._sq) cam.quaternion.copy(this._sq);
    if (s3 && s3.controls) {
      if (this._st) s3.controls.target.copy(this._st);
      s3.controls.enabled = true;
      s3.controls.update();     // re-derives its internal spherical from position + target
    }
  }

  _requestLock() {
    const d = this._dom;
    if (!d || typeof d.requestPointerLock !== "function") return;
    try {
      const r = d.requestPointerLock();
      if (r && typeof r.catch === "function") r.catch(() => { /* denied → drag-look still works */ });
    } catch { /* denied → drag-look still works */ }
  }

  _onLockChange() {
    const el = document.pointerLockElement;
    const locked = !!(el && (el === this._dom || el === document.documentElement || el === document.body));
    const was = this._locked;
    this._locked = locked;
    // The browser releases the lock on Esc / alt-tab / a modal — and it swallows that Esc keydown,
    // so this is the ONLY signal we get. Losing the lock while walking means the reader asked to
    // leave, so leave properly rather than stranding them with a mouse that no longer looks.
    if (was && !locked && this.active) this.disable();
  }

  // ------------------------------------------------------------------- terrain
  /** The dry-land test: inside the island ellipse AND above the waterline. NaN reads as false. */
  _walkable(x, z) {
    const s3 = this._s3;
    const WX = (s3._WSX || 720) * ISLE_K, WZ = (s3._WSZ || 450) * ISLE_K;
    const ex = x / WX, ez = z / WZ;
    if (ex * ex + ez * ez > 1) return false;
    const h = s3.heightAt(x, z);
    return h === h && h > SEA_Y;
  }

  _groundY(x, z) {
    const h = this._s3.heightAt(x, z);
    return (h === h && h > SEA_Y) ? h : SEA_Y;
  }

  /** A dry spot as near the swarm's centre of mass as the coastline allows (spiral search, no allocation). */
  _spawn(out) {
    const s3 = this._s3;
    const VW = state.VW || 1, VH = state.VH || 1;
    const cx = (((state.centroidX || VW / 2) / VW) - 0.5) * (s3._WSX || 720);
    const cz = (((state.centroidY || VH / 2) / VH) - 0.5) * (s3._WSZ || 450);
    for (let ring = 0; ring < 16; ring++) {
      const rad = ring * 15, steps = ring === 0 ? 1 : 8;
      for (let i = 0; i < steps; i++) {
        const a = (i / steps) * TAU + ring * 0.7;
        const x = cx + Math.cos(a) * rad, z = cz + Math.sin(a) * rad;
        if (this._walkable(x, z)) { out.x = x; out.z = z; return out; }
      }
    }
    out.x = 0; out.z = 0;
    return out;
  }

  // --------------------------------------------------------------------- input
  _onKeyDown(e) {
    if (!this.active) return;
    const k = this._k;
    switch (e.code) {
      case "KeyW": case "ArrowUp": k.f = 1; break;
      case "KeyS": case "ArrowDown": k.b = 1; break;
      case "KeyA": case "ArrowLeft": k.l = 1; break;
      case "KeyD": case "ArrowRight": k.r = 1; break;
      case "ShiftLeft": case "ShiftRight": k.run = 1; break;
      case "KeyF": if (!e.repeat) this.cycleFollow(); break;
      case "Escape":
        if (!e.repeat) { e.stopPropagation(); this.disable(); }
        return;
      default: return;   // every other key keeps its normal meaning (browser shortcuts, text fields)
    }
    e.preventDefault();
  }

  _onKeyUp(e) {
    if (!this.active) return;
    const k = this._k;
    switch (e.code) {
      case "KeyW": case "ArrowUp": k.f = 0; break;
      case "KeyS": case "ArrowDown": k.b = 0; break;
      case "KeyA": case "ArrowLeft": k.l = 0; break;
      case "KeyD": case "ArrowRight": k.r = 0; break;
      case "ShiftLeft": case "ShiftRight": k.run = 0; break;
      default: return;
    }
    e.preventDefault();
  }

  _look(dx, dy, sens) {
    this._yaw -= dx * sens;
    this._pitch -= dy * sens;
    if (this._yaw > Math.PI) this._yaw -= TAU; else if (this._yaw < -Math.PI) this._yaw += TAU;
    if (this._pitch > PITCH_LIM) this._pitch = PITCH_LIM;
    else if (this._pitch < -PITCH_LIM) this._pitch = -PITCH_LIM;
  }

  _onMouseMove(e) {
    if (!this.active || (!this._locked && !this._dragLook)) return;
    this._look(e.movementX || 0, e.movementY || 0, LOOK_SENS);
  }

  // drag-look: the fallback for a denied / unavailable pointer lock (and for a reader who simply
  // prefers to hold the button). Only the canvas starts it, so the DOM chrome stays clickable.
  _onMouseDown(e) {
    if (!this.active || this._locked || e.button !== 0) return;
    this._dragLook = true;
  }

  // ---- touch: no PointerLock on a phone, so the screen splits into two thumb zones ----
  _onTouchDown(e) {
    if (!this.active || e.pointerType === "mouse") return;
    const w = window.innerWidth || 1;
    const move = e.clientX < w * MOVE_ZONE;
    this._ptrs.set(e.pointerId, { move, ox: e.clientX, oy: e.clientY, lx: e.clientX, ly: e.clientY });
    if (this._dom) { try { this._dom.setPointerCapture(e.pointerId); } catch { /* noop */ } }
    if (move) this._showStick(e.clientX, e.clientY);
    if (e.cancelable) e.preventDefault();
  }

  _onTouchMove(e) {
    const p = this._ptrs.get(e.pointerId);
    if (!p) return;
    if (p.move) {
      let dx = (e.clientX - p.ox) / STICK_R, dz = (e.clientY - p.oy) / STICK_R;
      const m = Math.hypot(dx, dz);
      if (m > 1) { dx /= m; dz /= m; }
      this._tx = dx; this._tz = dz;
      this._moveStick(dx * STICK_R, dz * STICK_R);
    } else {
      this._look(e.clientX - p.lx, e.clientY - p.ly, TOUCH_SENS);
    }
    p.lx = e.clientX; p.ly = e.clientY;
    if (e.cancelable) e.preventDefault();
  }

  _onTouchUp(e) {
    const p = this._ptrs.get(e.pointerId);
    if (!p) return;
    this._ptrs.delete(e.pointerId);
    if (p.move) { this._tx = 0; this._tz = 0; this._hideStick(); }
  }

  _showStick(x, y) {
    if (!this._stick) {
      const s = document.createElement("div");
      s.className = "walk-stick";
      const k = document.createElement("div");
      k.className = "walk-stick-knob";
      s.appendChild(k);
      document.body.appendChild(s);
      this._stick = s; this._knob = k;
    }
    this._stick.style.transform = "translate3d(" + (x - STICK_R) + "px," + (y - STICK_R) + "px,0)";
    this._knob.style.transform = "translate3d(0,0,0)";
    this._stick.classList.add("on");
  }

  _moveStick(dx, dy) {
    if (this._knob) this._knob.style.transform = "translate3d(" + dx + "px," + dy + "px,0)";
  }

  _hideStick() {
    if (this._stick) this._stick.classList.remove("on");
    this._moveStick(0, 0);
  }

  // ------------------------------------------------------- third-person chase
  /**
   * Chase the fly currently at instance `index`. The instance list is rebuilt from
   * `sim.values()` every frame, so an index is only stable for one frame — we remember the
   * fly's own id and re-resolve the index each update. A fly that dies simply ends the chase.
   */
  followFly(index) {
    if (!this.active) return false;
    const s3 = this._s3;
    const n = s3 && s3.flyCount ? s3.flyCount() : 0;
    const i = index | 0;
    if (!(i >= 0) || i >= n) return false;
    const id = s3.flyIdAt ? s3.flyIdAt(i) : null;
    if (id == null) return false;
    this._follow = i;
    this._followId = id;
    this._dist = FOLLOW_D;
    document.body.classList.add("walk-follow");
    this.paintFollow();
    return true;
  }

  stopFollow() {
    if (this._follow < 0) return;
    this._follow = -1; this._followId = null;
    document.body.classList.remove("walk-follow");
    // Hand the chase camera's own position back to the walker, so dropping out of third person
    // settles you on the ground beneath where you were hovering instead of teleporting you home.
    const cam = this._cam;
    if (cam && this._s3) {
      let x = cam.position.x, z = cam.position.z;
      if (!this._walkable(x, z)) { const c = this._spawn(this._spawnOut); x = c.x; z = c.z; }
      this._px = x; this._pz = z;
      this._py = this._groundY(x, z) + EYE_H;
      this._bobA = 0;
    }
    this.paintFollow();
  }

  /** F: chase the nearest fly, then walk the roster; a third press drops back to first person. */
  cycleFollow() {
    if (!this.active) return;
    const n = this._s3 && this._s3.flyCount ? this._s3.flyCount() : 0;
    if (n <= 0) { this.stopFollow(); return; }
    if (this._follow < 0) { const i = this._nearestFly(); if (i >= 0) this.followFly(i); return; }
    const next = (this._follow + 1) % n;
    if (next === 0 && n > 1 && this._followWrap) { this._followWrap = false; this.stopFollow(); return; }
    this._followWrap = next === 0;
    this.followFly(next);
  }

  _nearestFly() {
    const s3 = this._s3;
    const n = s3 && s3.flyCount ? s3.flyCount() : 0;
    let best = -1, bd = Infinity;
    for (let i = 0; i < n; i++) {
      const p = s3.getFlyPosition(i);
      if (!p) continue;
      const dx = p.x - this._px, dz = p.z - this._pz;
      const d = dx * dx + dz * dz;
      if (d < bd) { bd = d; best = i; }
    }
    return best;
  }

  // --------------------------------------------------------------- chrome text
  /** Localised tooltip + pressed state. main.js calls this from rerenderAll() on a language switch. */
  paintChrome() {
    const b = this._btn;
    if (b) {
      b.setAttribute("title", T(this.active ? "walk.exitTitle" : "walk.title"));
      b.setAttribute("aria-pressed", this.active ? "true" : "false");
      b.classList.toggle("is-on", this.active);
    }
    this.paintFollow();
  }

  paintFollow() {
    const el = this._fol;
    if (!el) return;
    if (!this.active || this._follow < 0 || this._followId == null) {
      if (!el.hidden) el.hidden = true;
      return;
    }
    el.hidden = false;
    const txt = T("walk.follow", { n: this._followId });
    if (el.textContent !== txt) el.textContent = txt;
  }

  // ------------------------------------------------------------------ per frame
  /** Called by scene3d.update() INSTEAD of controls.update(). dt is seconds. */
  update(dt) {
    if (!this.active) return;
    const cam = this._cam;
    if (!cam || !this._s3) return;
    const d = (dt > 0 && dt < 0.25) ? dt : 0.016;
    if (this._follow >= 0) this._updateChase(d, cam);
    else this._updateWalk(d, cam);
  }

  _updateWalk(dt, cam) {
    const s3 = this._s3, k = this._k;
    // keyboard and thumb-stick add; the stick's Y is screen-down, so up on the thumb is forward
    let fwd = (k.f - k.b) - this._tz;
    let str = (k.r - k.l) + this._tx;
    const m = Math.hypot(fwd, str);
    if (m > 1) { fwd /= m; str /= m; }
    const moving = m > 0.001;
    const spd = WALK_SPD * (k.run ? SPRINT_K : 1);
    const sy = Math.sin(this._yaw), cy = Math.cos(this._yaw);
    // forward = (−sin yaw, −cos yaw) and right = (cos yaw, −sin yaw) under a YXZ euler
    const dx = (-sy * fwd + cy * str) * spd * dt;
    const dz = (-cy * fwd - sy * str) * spd * dt;
    // axis-separated: a coastline or a ridge makes you SLIDE along it instead of sticking to it
    const nx = this._px + dx, nz = this._pz + dz;
    if (this._walkable(nx, this._pz)) this._px = nx;
    if (this._walkable(this._px, nz)) this._pz = nz;
    // ride the relief: glide toward the ground height so a slope never stair-steps the view
    const target = this._groundY(this._px, this._pz) + EYE_H;
    const ga = dt * GROUND_LERP;
    this._py += (target - this._py) * (ga < 1 ? ga : 1);
    // head bob: driven by ground actually covered, amplitude eased in and out so stopping is smooth
    const moved = Math.abs(dx) + Math.abs(dz);
    this._bob += moved * 0.42;
    const wantA = moving ? BOB_AMP : 0;
    const ba = dt * 9;
    this._bobA += (wantA - this._bobA) * (ba < 1 ? ba : 1);
    const half = this._bob * 0.5;
    cam.position.set(this._px, this._py + Math.sin(this._bob) * this._bobA, this._pz);
    cam.rotation.set(this._pitch + Math.sin(half) * 0.004 * (this._bobA / BOB_AMP), this._yaw,
                     Math.sin(half) * 0.006 * (this._bobA / BOB_AMP));
    // sprinting widens the lens — a speed cue that costs one projection matrix when it changes
    const wantFov = WALK_FOV * ((k.run && moving) ? FOV_SPRINT : 1);
    if (Math.abs(wantFov - cam.fov) > 0.05) {
      const fa = dt * 5;
      cam.fov += (wantFov - cam.fov) * (fa < 1 ? fa : 1);
      cam.updateProjectionMatrix();
    }
  }

  _updateChase(dt, cam) {
    const s3 = this._s3, k = this._k;
    const i = s3.flyIndexOf ? s3.flyIndexOf(this._followId) : this._follow;
    if (i < 0) { this.stopFollow(); return; }
    this._follow = i;
    const p = s3.getFlyPosition(i);
    if (!p) { this.stopFollow(); return; }
    // A/D orbit, W/S dolly — the mouse orbits too, through the same yaw/pitch the walk mode uses
    this._yaw += (k.l - k.r) * dt * 1.7;
    if (this._yaw > Math.PI) this._yaw -= TAU; else if (this._yaw < -Math.PI) this._yaw += TAU;
    this._dist += (k.b - k.f) * dt * 16;
    if (this._dist < FOLLOW_DMIN) this._dist = FOLLOW_DMIN;
    else if (this._dist > FOLLOW_DMAX) this._dist = FOLLOW_DMAX;
    const D = this._dist, cp = Math.cos(this._pitch);
    const ox = p.x + Math.sin(this._yaw) * cp * D;
    const oz = p.z + Math.cos(this._yaw) * cp * D;
    const floor = this._groundY(ox, oz) + 1.0;
    let oy = p.y + Math.sin(this._pitch) * D;
    if (oy < floor) oy = floor;
    const a = dt * CHASE_LERP, s = a < 1 ? a : 1;
    cam.position.x += (ox - cam.position.x) * s;
    cam.position.y += (oy - cam.position.y) * s;
    cam.position.z += (oz - cam.position.z) * s;
    if (cam.fov !== WALK_FOV) { cam.fov = WALK_FOV; cam.updateProjectionMatrix(); }
    cam.rotation.order = "XYZ";
    cam.lookAt(p.x, p.y, p.z);
  }

  _writePose() {
    const cam = this._cam;
    if (!cam) return;
    cam.position.set(this._px, this._py, this._pz);
    cam.rotation.set(this._pitch, this._yaw, 0);
  }
}
