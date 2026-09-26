// dayNight.js — the diurnal heart of the murmur diorama.
// ─────────────────────────────────────────────────────────────────────────────
// The sun is now on a WALL-CLOCK: one full day/night cycle = 1 real hour.
// This prevents the "strobe" effect of the old tick-driven cycle (~7 min)
// while preserving the narrative that the world has earned dawns.
//
// A low-pass delta filter ensures the displayed phase never jumps, even at
// the 0.99→0.01 wrap boundary or if the tab was backgrounded.
//
// Design notes:
//  · update() is pure scalar maths + uniform/light writes — ZERO per-frame
//    allocation. Every THREE.Color / Vector3 it touches is either a module
//    constant (read-only source) or a pre-allocated scratch on the instance.
//  · Night is when the world glows from within: castle arrow-slits light like
//    banked hearths, the swarm reads as fireflies, and 500 stars fade in on a
//    camera-following shell. No new Light objects are ever created.
//  · A dynasty fall / era passage forces a blood eclipse (forceEclipse) that
//    overrides the sky for 120 real seconds, then smoothsteps back over 60s.

import * as THREE from 'three';

// Kept for backwards compatibility — other modules may import it.
export const TICKS_PER_GEN = 42;

// ── wall-clock cycle constant ──
const DAY_MS = 3600000; // 1 hour = 1 full day/night cycle

const TAU = Math.PI * 2;
const clamp01 = (t) => (t < 0 ? 0 : t > 1 ? 1 : t);
const lerp = (a, b, t) => a + (b - a) * t;
// smoothstep between two edges — the only easing we need for buttery boundaries
const sstep = (a, b, t) => { const x = clamp01((t - a) / ((b - a) || 1e-6)); return x * x * (3 - 2 * x); };
const frac = (t) => t - Math.floor(t);

// ── the fixed palette the cycle interpolates between (read-only sources) ──────
const C = {
  sunDay:    new THREE.Color(0xfff5e0),   // high noon — near-white warm
  sunDusk:   new THREE.Color(0xff8040),   // low sun — ember orange
  sunNight:  new THREE.Color(0x304060),   // moonless cold fill
  hemiSkyD:  new THREE.Color(0x87ceeb),   // day sky bounce
  hemiSkyN:  new THREE.Color(0x0a0a20),   // night sky bounce
  hemiGndD:  new THREE.Color(0x8b7355),   // day earth bounce
  hemiGndN:  new THREE.Color(0x101010),   // night earth bounce
  fogDay:    new THREE.Color(0xcfe3e6),   // matches the diorama's teal haze
  fogDusk:   new THREE.Color(0xcf7a48),   // horizon fire
  fogNight:  new THREE.Color(0x080814),   // deep night haze
  eclSun:    new THREE.Color(0x800000),   // blood-red eclipsed sun
  eclFog:    new THREE.Color(0x1a0000),   // blood haze
  winGlow:   new THREE.Color(0xff9030),   // hearth-orange window emissive
  flyGlow:   new THREE.Color(0xffd27a),   // firefly warm
};

// the four named watches of the day, and the glyph the era-HUD wears for each
const WATCHES = [
  { to: 0.25, name: 'morning',   icon: '\u{1F305}' },  // 🌅 sunrise → noon
  { to: 0.50, name: 'afternoon', icon: '\u2600\uFE0F' },// ☀️ noon → sunset
  { to: 0.75, name: 'night',     icon: '\u{1F319}' },  // 🌙 sunset → midnight
  { to: 1.01, name: 'dawn',      icon: '\u{1F304}' },  // 🌄 midnight → sunrise
];

export class DayNight {
  /** @param {import('./scene3d.js').ThreeScene} scene3d */
  constructor(scene3d) {
    this.s3 = scene3d;

    // ── wall-clock phase state ──
    this._displayPhase = frac(Date.now() / DAY_MS); // start at current real phase
    this._lastRaw = this._displayPhase;
    this._lastMs = 0;

    // ── published read-outs ──
    this.phase = this._displayPhase;
    this.nightFactor = 0;        // 0 day → 1 deep night (drives glow + stars)
    this.dayFactor = 1;
    this.watch = 'morning';
    this.icon = WATCHES[0].icon;
    this.forcePhase = null;      // console hook: pin the phase for screenshots

    // ── eclipse state (in real-time ms) ──
    this._eclActive = false;
    this._eclStartMs = 0;
    this._eclDurMs = 120000;    // 120 seconds of full eclipse
    this._eclFadeMs = 60000;    // 60 seconds fade-out
    this._eclAmt = 0;

    // ── zero-alloc scratch ──
    this._sunDir = new THREE.Vector3();

    // ── star shell (built once, 500 verts, opacity-animated) ──
    this._stars = null;
    this._starMat = null;
    this._buildStars();
  }

  // 500 random points on a large shell; they follow the camera so the sky is
  // always star-filled in both orbit and walk mode. PointsMaterial (not Mesh)
  // because these are GL points; fog:false keeps them crisp above the haze.
  _buildStars() {
    const s3 = this.s3;
    if (!s3 || !s3.scene) return;
    const N = 500, R = 2600;
    const pos = new Float32Array(N * 3);
    for (let i = 0; i < N; i++) {
      const u = Math.random() * 2 - 1;            // cos(polar)
      const th = Math.acos(u);
      const ph = Math.random() * TAU;
      const r = R * (0.82 + Math.random() * 0.18);
      const st = Math.sin(th);
      pos[i * 3]     = r * st * Math.cos(ph);
      pos[i * 3 + 1] = Math.abs(r * Math.cos(th)) + r * 0.06;  // bias above the horizon
      pos[i * 3 + 2] = r * st * Math.sin(ph);
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    this._starMat = new THREE.PointsMaterial({
      color: 0xf6f2e6, size: 3.0, sizeAttenuation: false,
      transparent: true, opacity: 0, depthWrite: false, fog: false,
    });
    this._stars = new THREE.Points(geo, this._starMat);
    this._stars.frustumCulled = false;
    this._stars.renderOrder = 999;
    this._stars.visible = false;
    s3.scene.add(this._stars);
  }

  // ── special events ───────────────────────────────────────────────────────
  /**
   * Dynasty fall / era passage: a blood eclipse.
   * @param {number} [durSec=120] duration of the full-eclipse plateau in SECONDS.
   */
  forceEclipse(durSec) {
    if (this._eclActive) return;              // one eclipse at a time — never stack to perpetual red
    this._eclActive = true;
    this._eclStartMs = Date.now();
    this._eclDurMs = Math.max(120000, (durSec || 120) * 1000); // min 120s (scene3d passes old tick-count 30)
    this._eclFadeMs = 60000; // always 60s recovery
  }
  /** Release any forced event and let the natural cycle resume. */
  clearEvent() { this._eclActive = false; this._eclAmt = 0; }

  /**
   * Advance the sky one frame.
   * @param {number} tick   authoritative simulation tick (kept for API compat, no longer drives phase)
   * @param {number} generation current generation (informational)
   * @param {number} now    performance.now() ms
   */
  update(tick, generation, now) {
    const s3 = this.s3;
    if (!s3 || !s3.scene) return;

    // ── 1. wall-clock phase with low-pass delta filter ──
    if (!this._lastMs) this._lastMs = now;
    let dt = now - this._lastMs; this._lastMs = now;
    if (!(dt > 0)) dt = 0; else if (dt > 250) dt = 250; // clamp backgrounded-tab jump

    // Raw phase from real time: 1 hour = 1 full cycle
    const rawPhase = frac(Date.now() / DAY_MS);

    // Advance displayPhase at the constant expected rate (smooth, no jumps)
    this._displayPhase = frac(this._displayPhase + dt / DAY_MS);

    // Gentle drift correction: handles tab-backgrounding, clock adjustments.
    // Wrap-aware: shortest arc between raw and display.
    let drift = rawPhase - this._displayPhase;
    if (drift < -0.5) drift += 1;
    if (drift > 0.5) drift -= 1;
    // Absorb drift slowly (0.001/ms → a 0.5 jump takes ~8s to fully smooth out)
    this._displayPhase = frac(this._displayPhase + drift * Math.min(0.001 * dt, 0.15));
    this._lastRaw = rawPhase;

    let phase = this._displayPhase;
    if (this.forcePhase != null) phase = frac(this.forcePhase);
    this.phase = phase;

    const sunElev = Math.sin(phase * TAU);        // −1 (midnight) … +1 (noon)
    const elevDeg = sunElev * 70;                 // noon peaks at 70°, midnight at −70°
    const azimDeg = phase * 360;                  // the sun walks a full compass turn
    const phi = THREE.MathUtils.degToRad(90 - elevDeg);
    const theta = THREE.MathUtils.degToRad(azimDeg);
    this._sunDir.setFromSphericalCoords(1, phi, theta);
    if (s3.sun) s3.sun.copy(this._sunDir);
    if (s3.sunLight) s3.sunLight.position.copy(this._sunDir).multiplyScalar(1000);

    // ── 3. day / dusk / night envelopes — WIDER smoothstep windows (±0.15 vs old ±0.05) ──
    //    Night→day transition now spans ~9 minutes of real time (0.15/1.0 × 60min × 2 edges)
    const dayAmt  = sstep(-0.25, 0.35, sunElev);              // 0 below horizon → 1 high sun
    const duskAmt = 1 - sstep(0.05, 0.50, Math.abs(sunElev)); // wider dusk bump
    const night   = 1 - sstep(-0.30, 0.15, sunElev);          // 1 deep night → 0 day
    this.dayFactor = dayAmt;

    // ── 4. eclipse envelope (real-time: 120s plateau + 60s fade) ──
    let ecl = 0;
    if (this._eclActive) {
      const elapsed = Date.now() - this._eclStartMs;
      const attackMs = this._eclDurMs * 0.15;   // 15% of duration = attack ramp
      if (elapsed < attackMs) {
        ecl = sstep(0, attackMs, elapsed);
      } else if (elapsed < this._eclDurMs) {
        ecl = 1; // full plateau
      } else if (elapsed < this._eclDurMs + this._eclFadeMs) {
        ecl = 1 - sstep(this._eclDurMs, this._eclDurMs + this._eclFadeMs, elapsed);
      } else {
        this._eclActive = false; ecl = 0;
      }
    }
    this._eclAmt = ecl;
    const nf = Math.max(night, ecl);             // glow + stars answer to night OR eclipse
    this.nightFactor = nf;

    // ── 5. key light: intensity + colour ──
    if (s3.sunLight) {
      let sunI = lerp(0.08, 1.2, dayAmt);
      sunI = lerp(sunI, 0.4, duskAmt * 0.75);
      sunI = lerp(sunI, 0.05, ecl);
      s3.sunLight.intensity = sunI;
      s3.sunLight.color.copy(C.sunNight).lerp(C.sunDay, dayAmt).lerp(C.sunDusk, duskAmt * 0.85).lerp(C.eclSun, ecl);
    }

    // ── 6. hemisphere bounce ──
    if (s3.hemiLight) {
      s3.hemiLight.color.copy(C.hemiSkyN).lerp(C.hemiSkyD, dayAmt);
      s3.hemiLight.groundColor.copy(C.hemiGndN).lerp(C.hemiGndD, dayAmt);
      s3.hemiLight.intensity = lerp(lerp(0.34, 0.78, dayAmt), 0.16, ecl);
    }

    // ── 7. fog follows the sky ──
    const fog = s3.scene.fog;
    if (fog) {
      fog.color.copy(C.fogNight).lerp(C.fogDay, dayAmt).lerp(C.fogDusk, duskAmt * 0.8).lerp(C.eclFog, ecl);
      fog.density = lerp(0.00095, 0.00078, dayAmt) + ecl * 0.0004;
    }

    // ── 8. Preetham sky uniforms ──
    const u = s3.skyUniforms;
    if (u) {
      if (u.sunPosition) u.sunPosition.value.copy(this._sunDir);
      if (u.turbidity)      u.turbidity.value      = lerp(2.0, 5.0, dayAmt) + duskAmt * 3.0;
      if (u.rayleigh)       u.rayleigh.value       = lerp(lerp(0.35, 2.2, dayAmt) + duskAmt * 1.1, 0.1, ecl);
      if (u.mieCoefficient) u.mieCoefficient.value = lerp(0.002, 0.005, dayAmt) + duskAmt * 0.004;
    }

    // ── 9. the noon-baked PMREM env (scene.environment) keeps lighting the world even at
    //    midnight, so dim its IBL contribution on every standard-material surface as night falls.
    const wm = s3.water && s3.water.material;
    if (wm && wm.envMapIntensity !== undefined) wm.envMapIntensity = lerp(0.8, 0.12, nf);
    const tm = s3.terrain && s3.terrain.material;
    if (tm && tm.envMapIntensity !== undefined) tm.envMapIntensity = lerp(1.0, 0.10, nf);

    // ── 10. night life: castle hearth-windows + firefly swarm ──
    const winMats = s3._castleWindowMats;
    if (winMats) for (let i = 0; i < winMats.length; i++) winMats[i].emissiveIntensity = nf * 0.85;
    if (s3.flyBody && s3.flyBody.material) s3.flyBody.material.emissiveIntensity = nf * 0.6;

    // ── 11. stars ──
    if (this._starMat) {
      this._starMat.opacity = nf * 0.95;
      if (this._stars) {
        this._stars.visible = nf > 0.02;
        if (s3.camera) this._stars.position.copy(s3.camera.position);
      }
    }

    // ── 12. the named watch + HUD glyph ──
    if (ecl > 0.5) { this.watch = 'eclipse'; this.icon = '\u{1F311}'; }   // 🌑
    else {
      for (let i = 0; i < WATCHES.length; i++) if (phase < WATCHES[i].to) { this.watch = WATCHES[i].name; this.icon = WATCHES[i].icon; break; }
    }
  }
}

// Debug hooks (__murmurSetPhase, __murmurEclipse, __murmurDayNight) are
// registered in main.js and access this instance via state.threeScene.dayNight.
