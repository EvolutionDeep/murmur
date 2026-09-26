// particles.js — GPU particle system for chronicle events and ambient weather.
// Portions adapted from wowserhq/scene (MIT), © Wowser Contributors.
//
// Design: a SINGLE THREE.Points object holds every particle (event bursts + ambient weather).
// All motion is integrated in the vertex shader — pos = p0 + v0·age + ½·a·age², plus an optional
// sinusoidal swirl — so the CPU does ZERO per-particle work each frame. update() only advances the
// uTime uniform. Dead particles (age > life) collapse to gl_PointSize 0; ambient particles LOOP via
// age = mod(uTime − birth, life) so rain/snow recycle forever without a single re-allocation.
//
// The buffer is split into two disjoint regions so a burst can never clobber the live weather:
//   [0, ambCap)          ambient weather slots (looping, rewritten only on a weather change)
//   [ambCap, max)        event-burst slots (a ring cursor recycles them as bursts die)
//
// Attributes per particle (7 packed attributes, 21 floats):
//   position vec3   spawn point
//   aVel     vec3   initial velocity (units/sec)
//   aAccel   vec3   constant acceleration (gravity / buoyancy)
//   aColor   vec3   linear colour, pre-multiplied by base intensity (additive blending)
//   aLife    vec4   (birth, life, loop, nightBoost)
//   aSize    vec4   (baseSize, sizeEndMul, shape, swirlAmp)
//   aSpin    vec2   (swirlFreq, phaseSeed)

import * as THREE from 'three';

// ---- mobile / small-screen detection: halves the budget (task perf red-line: mobile < 8k live) ----
const IS_MOBILE = (() => {
  try {
    if (typeof matchMedia === 'function' && matchMedia('(max-width: 767px), (pointer: coarse)').matches) return true;
  } catch (_) { /* matchMedia unavailable — fall through to the UA sniff */ }
  try { return /Mobi|Android|iPhone|iPad|iPod/i.test(navigator.userAgent); } catch (_) { return false; }
})();
const scaleCount = (n) => (IS_MOBILE ? Math.max(8, Math.round(n * 0.5)) : n);

// shape codes read by the fragment shader
const SHAPE_CIRCLE = 0;   // soft radial falloff — spores, embers, dust, ash, banner bits
const SHAPE_RAIN = 1;     // vertical capsule — a falling streak
const SHAPE_SNOW = 2;     // wide soft blob — a drifting flake

// ---- palette helpers (hex → linear-ish 0..1 triple) ----
const rgb = (hex) => [((hex >> 16) & 255) / 255, ((hex >> 8) & 255) / 255, (hex & 255) / 255];

// ============================ emission presets ============================
// A preset is a plain description of one burst/ambient family. scene3d resolves `region` into a
// world anchor {x,y,z,radius} from the nation data, then calls emit(preset, anchor).
//   mode: 'burst' radial+gravity · 'rise' buoyant column · 'fall' drift down · 'beam' tight up-column
//   region: where scene3d places it · nation / capital / border / plague / graveyard / field
const P = (o) => o;

export const PRESETS = {
  // PLAGUE — green spore cloud boiling up off the stricken nation
  plague: P({ count: 300, color: rgb(0x40c040), color2: rgb(0x80ff80), size: 13, sizeEnd: 0.45, life: 2.7, lifeJit: 0.9, mode: 'rise', speed: 15, spread: 5, accelY: 2.5, swirl: 3.4, swirlFreq: 1.1, shape: SHAPE_CIRCLE, radius: 34, height: 6, region: 'plague', boost: 0.25 }),
  // GOLDEN AGE / BOOM — gold motes snowing down over the whole realm (brighter at night)
  gold: P({ count: 400, color: rgb(0xffd700), color2: rgb(0xfff0a0), size: 9.5, sizeEnd: 0.4, life: 3.5, lifeJit: 1.2, mode: 'fall', speed: 3, spread: 2, accelY: -0.7, swirl: 2.8, swirlFreq: 0.8, shape: SHAPE_CIRCLE, radius: 58, height: 46, region: 'nation', boost: 0.5 }),
  // WAR / FEUD / INVASION — red sparks + black smoke tearing the border
  war: P({ count: 250, color: rgb(0xff4020), color2: rgb(0x404040), size: 12, sizeEnd: 0.55, life: 1.9, lifeJit: 0.6, mode: 'burst', speed: 26, spread: 16, accelY: -7.5, swirl: 1.2, swirlFreq: 2.0, shape: SHAPE_CIRCLE, radius: 24, height: 8, region: 'border', boost: 0.2 }),
  // DYNASTY FALL / ERA PASSAGE — banner fragments in the falling house's colours
  banner: P({ count: 350, color: rgb(0xb08e56), color2: rgb(0xe0c088), size: 10.5, sizeEnd: 0.7, life: 3.1, lifeJit: 1.0, mode: 'fall', speed: 4, spread: 3, accelY: -1.4, swirl: 4.6, swirlFreq: 1.4, shape: SHAPE_CIRCLE, radius: 58, height: 52, region: 'nation', boost: 0.15, useNationColor: true }),
  // FUNERAL / GRAVE — grey ash settling over the necropolis
  ash: P({ count: 150, color: rgb(0xa0a0a0), color2: rgb(0x606060), size: 8.5, sizeEnd: 0.5, life: 4.2, lifeJit: 1.4, mode: 'fall', speed: 2, spread: 1.5, accelY: -0.45, swirl: 3.2, swirlFreq: 0.7, shape: SHAPE_CIRCLE, radius: 22, height: 30, region: 'graveyard', boost: 0.0 }),
  // HERO SUMMONING — a white light pillar rushing up from the capital
  hero: P({ count: 200, color: rgb(0xffffff), color2: rgb(0xa0c0ff), size: 11, sizeEnd: 0.3, life: 2.3, lifeJit: 0.7, mode: 'beam', speed: 46, spread: 3, accelY: -6, swirl: 0.8, swirlFreq: 3.0, shape: SHAPE_CIRCLE, radius: 7, height: 4, region: 'capital', boost: 0.35 }),
  // WONDER FOUNDATION — gold construction dust kicked up at the capital
  wonder: P({ count: 300, color: rgb(0xd4a040), color2: rgb(0xf0d090), size: 10, sizeEnd: 0.5, life: 2.5, lifeJit: 0.8, mode: 'burst', speed: 18, spread: 9, accelY: -3.4, swirl: 1.6, swirlFreq: 1.3, shape: SHAPE_CIRCLE, radius: 15, height: 6, region: 'capital', boost: 0.3 }),
};

// ---- ambient weather presets (looping) ----
export const WEATHER = {
  rain: P({ count: 800, color: rgb(0x6090c0), color2: rgb(0x9fc4e8), size: 6.5, sizeEnd: 1.0, life: 1.15, lifeJit: 0.5, velY: -105, spreadXZ: 2.5, shape: SHAPE_RAIN, topY: 118, boost: 0.1 }),
  snow: P({ count: 500, color: rgb(0xffffff), color2: rgb(0xdfeaff), size: 13, sizeEnd: 1.0, life: 6.4, lifeJit: 2.6, velY: -9, spreadXZ: 1.0, swirl: 6.5, swirlFreq: 1.15, shape: SHAPE_SNOW, topY: 66, minGround: 12, boost: 0.2 }),
};

// ============================ EVENT_MAP: raw chronicle kind → preset ============================
// Keyed by the worker's raw event kinds (the /annals rows). Each maps onto one of the effect
// families above so a previously invisible simulation event becomes visible weather.
const plague = PRESETS.plague, gold = PRESETS.gold, war = PRESETS.war,
  banner = PRESETS.banner, ash = PRESETS.ash, hero = PRESETS.hero, wonder = PRESETS.wonder;

export const EVENT_MAP = {
  // plague / blight — green spores
  PLAGUE_WAVE: plague, PLAGERA: plague, MIRACLE_PLAGUE: plague, FAMINE: plague, SICKNESS: plague,
  // prosperity — gold dust
  GOLDEN_AGE: gold, BOOM: gold, RENAISSANCE: gold, MIRACLE_HARVEST: gold, COIN_FEVER: gold,
  TITHE: gold, WHALE_MOVE: gold, BOUNTY: gold,
  // war / conflict — red fire + smoke
  WAR: war, WAR_DECLARED: war, WAR_RESOLVED: war, TERRITORY_SEIZED: war, INVASION: war,
  FEUD: war, BETRAYAL: war, RAID: war, CONQUEST: war,
  // dynasty / era turnover — banner fragments
  DYNASTY_FALL: banner, DARK_AGE: banner, DYNASTY: banner, ERA_PASSAGE: banner, ERA_SHIFT: banner,
  REGIME_CHANGE: banner, COLLAPSE: banner,
  // death / loss — grey ash
  FUNERAL: ash, GRAVE: ash, ELEGY: ash, DEATH: ash, COIN_SILENCE: ash, LOST_ART: ash,
  CRAFT_LOST: ash, ARCHIVE_BURNED: ash, WORD_DIES: ash, RUMOR_FADED: ash, SILENCE: ash,
  // divine / hero — white pillar
  HERO_SUMMONING: hero, MIRACLE_REVELATION: hero, DIVINE_DECREE: hero, PROPHECY: hero,
  EPOCH_SHAPING: hero, REVIVAL: hero,
  // founding / building — gold construction dust
  WONDER_FOUNDATION: wonder, CITY_FOUNDED: wonder, SCHOOL: wonder, HOUSE_FOUNDED: wonder,
  WORK_RAISED: wonder, MONUMENT: wonder, INVENTION: wonder,
};

// ============================ shaders ============================
const VERT = /* glsl */`
attribute vec3 aVel;
attribute vec3 aAccel;
attribute vec3 aColor;
attribute vec4 aLife;   // birth, life, loop, nightBoost
attribute vec4 aSize;   // baseSize, sizeEndMul, shape, swirlAmp
attribute vec2 aSpin;   // swirlFreq, phaseSeed

uniform float uTime;
uniform float uPR;      // device pixel ratio
uniform float uScale;   // viewport size compensation
uniform float uNight;   // 0 day → 1 deep night

varying vec3 vColor;
varying float vAlpha;
varying float vShape;
varying float vNight;
varying float vBoost;

void main() {
  float birth = aLife.x;
  float life  = max(aLife.y, 0.0001);
  float loop  = aLife.z;
  float age   = uTime - birth;

  if (loop > 0.5) {
    age = mod(age, life);                 // ambient: recycle forever, zero CPU
  } else if (age < 0.0 || age > life) {
    gl_Position = vec4(0.0, 0.0, 2.0, 1.0);   // dead burst particle: park behind the far plane
    gl_PointSize = 0.0;
    vAlpha = 0.0; vColor = vec3(0.0); vShape = 0.0; vNight = 0.0; vBoost = 0.0;
    return;
  }

  float t = clamp(age / life, 0.0, 1.0);
  // ballistic integration
  vec3 pos = position + aVel * age + 0.5 * aAccel * age * age;
  // optional horizontal swirl (snow drift / spore wander)
  float sw = aSize.w;
  if (sw > 0.001) {
    float ph = aSpin.y + birth * 3.1;
    pos.x += sin(uTime * aSpin.x + ph) * sw;
    pos.z += cos(uTime * aSpin.x * 0.87 + ph * 1.27) * sw;
  }

  vec4 mv = modelViewMatrix * vec4(pos, 1.0);
  gl_Position = projectionMatrix * mv;

  float dist = max(1.0, -mv.z);
  float sizePx = aSize.x * mix(1.0, aSize.y, t);
  gl_PointSize = max(0.0, sizePx * uPR * uScale * (340.0 / dist));

  float fadeIn  = smoothstep(0.0, 0.07, t);
  // bursts decay from 55%; looping ambient holds bright longer, fading only at the wrap seam
  float fadeOut = mix(1.0 - smoothstep(0.55, 1.0, t), 1.0 - smoothstep(0.82, 1.0, t), loop);
  vAlpha = fadeIn * fadeOut;
  vColor = aColor;
  vShape = aSize.z;
  vNight = uNight;
  vBoost = aLife.w;
}
`;

const FRAG = /* glsl */`
precision mediump float;
varying vec3 vColor;
varying float vAlpha;
varying float vShape;
varying float vNight;
varying float vBoost;

void main() {
  if (vAlpha <= 0.002) discard;
  vec2 uv = gl_PointCoord - 0.5;
  float a;
  if (vShape > 1.5) {
    a = smoothstep(0.5, 0.02, length(uv));                 // snow: wide soft blob
  } else if (vShape > 0.5) {
    float rx = abs(uv.x) * 5.0;                            // rain: thin vertical capsule
    float ry = abs(uv.y) * 1.12;
    a = smoothstep(0.5, 0.0, max(rx, ry));
  } else {
    a = smoothstep(0.5, 0.0, length(uv));                  // circle: soft radial falloff
  }
  a *= vAlpha;
  if (a <= 0.003) discard;
  // night: emissive lift so particles glow against the dark diorama
  vec3 col = mix(vColor, vColor * 1.75 + vec3(0.10), vNight * 0.55);
  // gold dust (high boost) reads extra prominent at night
  float alpha = a * (1.0 + vNight * (0.45 + vBoost));
  gl_FragColor = vec4(col, alpha);
}
`;

// ============================ ParticleSystem ============================
export class ParticleSystem {
  /**
   * @param {THREE.Scene} scene
   * @param {THREE.WebGLRenderer} renderer  (for pixel ratio + size)
   * @param {number} maxParticles           hard cap on the single Points buffer
   */
  constructor(scene, renderer, maxParticles) {
    this.scene = scene;
    this.renderer = renderer || null;
    this.isMobile = IS_MOBILE;
    this.max = Math.max(512, maxParticles || (IS_MOBILE ? 3000 : 6000));
    // reserve enough ambient slots for the biggest weather layer (rain), +slack
    this.ambCap = IS_MOBILE ? 460 : 900;
    if (this.ambCap > this.max - 256) this.ambCap = Math.max(0, this.max - 256);
    this.burstBase = this.ambCap;             // burst ring lives in [burstBase, max)
    this.burstCap = this.max - this.ambCap;
    this._burstCursor = this.burstBase;

    this._time = 0;                           // shader clock (seconds), advanced by update()
    this.nightFactor = 0;                     // set by scene3d each frame from dayNight
    this.weather = 'clear';                   // 'clear' | 'rain' | 'snow'
    this._ambCount = 0;                       // ambient slots currently written
    this._frame = 0;

    this._buildGeometry();
    this._buildMaterial();
    this.points = new THREE.Points(this.geometry, this.material);
    this.points.frustumCulled = false;        // motion is computed on the GPU — never cull on stale bounds
    this.points.renderOrder = 6;              // above overlays, below the HUD
    this.scene.add(this.points);

    this._restoreWeather();
  }

  _buildGeometry() {
    const n = this.max;
    const g = new THREE.BufferGeometry();
    const mk = (size) => new THREE.BufferAttribute(new Float32Array(n * size), size).setUsage(THREE.DynamicDrawUsage);
    this.aPosition = mk(3);
    this.aVel = mk(3);
    this.aAccel = mk(3);
    this.aColor = mk(3);
    this.aLife = mk(4);
    this.aSize = mk(4);
    this.aSpin = mk(2);
    // park every slot dead & below the world so nothing shows before the first emit
    const pos = this.aPosition.array, life = this.aLife.array;
    for (let i = 0; i < n; i++) {
      pos[i * 3 + 1] = -9999;
      life[i * 4 + 0] = -1e6;                 // birth far in the past
      life[i * 4 + 1] = 0.0001;               // life ≈ 0 → age > life → culled
      life[i * 4 + 2] = 0;                    // loop off
    }
    g.setAttribute('position', this.aPosition);
    g.setAttribute('aVel', this.aVel);
    g.setAttribute('aAccel', this.aAccel);
    g.setAttribute('aColor', this.aColor);
    g.setAttribute('aLife', this.aLife);
    g.setAttribute('aSize', this.aSize);
    g.setAttribute('aSpin', this.aSpin);
    g.setDrawRange(0, n);
    this.geometry = g;
  }

  _buildMaterial() {
    const pr = this.renderer ? this.renderer.getPixelRatio() : (typeof devicePixelRatio === 'number' ? devicePixelRatio : 1);
    this.material = new THREE.ShaderMaterial({
      uniforms: {
        uTime: { value: 0 },
        uPR: { value: pr },
        uScale: { value: 1 },
        uNight: { value: 0 },
      },
      vertexShader: VERT,
      fragmentShader: FRAG,
      transparent: true,
      depthWrite: false,
      depthTest: true,
      blending: THREE.AdditiveBlending,
    });
    this._updateScale();
  }

  // point-size compensation for viewport height (recomputed a few times a second, never per-frame thrash)
  _updateScale() {
    let h = 900;
    try { h = (this.renderer && this.renderer.domElement && this.renderer.domElement.clientHeight) || window.innerHeight || 900; } catch (_) { /* ignore */ }
    const s = Math.min(1.7, Math.max(0.55, h / 900));
    this.material.uniforms.uScale.value = s;
    const pr = this.renderer ? this.renderer.getPixelRatio() : (typeof devicePixelRatio === 'number' ? devicePixelRatio : 1);
    this.material.uniforms.uPR.value = pr;
  }

  // ---- write ONE particle into slot i (shared by bursts + ambient) ----
  _write(i, px, py, pz, vx, vy, vz, ax, ay, az, col, size, sizeEnd, shape, birth, life, loop, boost, swirl, swirlFreq, phase) {
    const p3 = i * 3, p4 = i * 4, p2 = i * 2;
    const P = this.aPosition.array, V = this.aVel.array, A = this.aAccel.array, C = this.aColor.array;
    const L = this.aLife.array, S = this.aSize.array, SP = this.aSpin.array;
    P[p3] = px; P[p3 + 1] = py; P[p3 + 2] = pz;
    V[p3] = vx; V[p3 + 1] = vy; V[p3 + 2] = vz;
    A[p3] = ax; A[p3 + 1] = ay; A[p3 + 2] = az;
    C[p3] = col[0]; C[p3 + 1] = col[1]; C[p3 + 2] = col[2];
    L[p4] = birth; L[p4 + 1] = life; L[p4 + 2] = loop; L[p4 + 3] = boost;
    S[p4] = size; S[p4 + 1] = sizeEnd; S[p4 + 2] = shape; S[p4 + 3] = swirl;
    SP[p2] = swirlFreq; SP[p2 + 1] = phase;
  }

  _flush() {
    this.aPosition.needsUpdate = true; this.aVel.needsUpdate = true; this.aAccel.needsUpdate = true;
    this.aColor.needsUpdate = true; this.aLife.needsUpdate = true; this.aSize.needsUpdate = true;
    this.aSpin.needsUpdate = true;
  }

  /**
   * Fire a one-shot burst.
   * @param {object} preset   one of PRESETS (or an EVENT_MAP value)
   * @param {object} anchor   {x,y,z,radius, color?} resolved by scene3d from the nation data
   */
  emit(preset, anchor) {
    if (!preset || this.burstCap <= 0) return 0;
    const a = anchor || { x: 0, y: 10, z: 0, radius: preset.radius || 20 };
    const R = a.radius != null ? a.radius : (preset.radius || 20);
    const n = Math.min(scaleCount(preset.count), this.burstCap);
    const c1 = preset.color, c2 = preset.color2 || preset.color;
    const override = a.color || null;         // dynasty banner rides the falling house's colour
    const H = preset.height || 6;
    for (let k = 0; k < n; k++) {
      const i = this._burstCursor;
      this._burstCursor = this.burstBase + ((this._burstCursor - this.burstBase + 1) % this.burstCap);
      // random point in a disc of radius R, jittered vertically across the spawn height H
      const ang = Math.random() * Math.PI * 2;
      const rad = R * Math.sqrt(Math.random());
      const px = a.x + Math.cos(ang) * rad;
      const pz = a.z + Math.sin(ang) * rad;
      const py = a.y + (Math.random() - 0.5) * H;
      // colour: lerp c1→c2 (or the dynasty override)
      const m = Math.random();
      const col = override
        ? [override[0] * (0.75 + m * 0.4), override[1] * (0.75 + m * 0.4), override[2] * (0.75 + m * 0.4)]
        : [c1[0] + (c2[0] - c1[0]) * m, c1[1] + (c2[1] - c1[1]) * m, c1[2] + (c2[2] - c1[2]) * m];
      const life = Math.max(0.15, preset.life + (Math.random() - 0.5) * 2 * (preset.lifeJit || 0));
      const birth = this._time;               // all born now → they age & die together
      const speed = preset.speed || 10, spread = preset.spread || 4;
      let vx = 0, vy = 0, vz = 0;
      const dirX = Math.cos(ang), dirZ = Math.sin(ang);
      if (preset.mode === 'rise') {
        vx = dirX * spread * (0.3 + Math.random()); vz = dirZ * spread * (0.3 + Math.random());
        vy = speed * (0.6 + Math.random() * 0.7);
      } else if (preset.mode === 'fall') {
        vx = dirX * spread * (Math.random() - 0.5) * 2; vz = dirZ * spread * (Math.random() - 0.5) * 2;
        vy = -speed * (0.4 + Math.random() * 0.8);
      } else if (preset.mode === 'beam') {
        vx = dirX * spread * 0.4 * Math.random(); vz = dirZ * spread * 0.4 * Math.random();
        vy = speed * (0.8 + Math.random() * 0.5);
      } else { // 'burst' — radial shell + upward kick, then gravity
        const s = speed * (0.4 + Math.random() * 0.9);
        vx = dirX * s; vz = dirZ * s; vy = speed * 0.5 * (0.5 + Math.random());
      }
      const ay = preset.accelY != null ? preset.accelY : -3;
      this._write(i, px, py, pz, vx, vy, vz, 0, ay, 0, col,
        preset.size * (0.75 + Math.random() * 0.5), preset.sizeEnd != null ? preset.sizeEnd : 0.5,
        preset.shape || SHAPE_CIRCLE, birth, life, 0, preset.boost || 0,
        preset.swirl || 0, preset.swirlFreq || 1, Math.random() * 6.283);
    }
    this._flush();
    return n;
  }

  /**
   * Start a persistent, looping ambient weather layer. Rewrites the whole ambient region once.
   * @param {'rain'|'snow'} type
   * @param {object} opts {x0,x1,z0,z1, groundFn(x,z)->y, topY?}
   */
  startAmbient(type, opts) {
    const w = WEATHER[type];
    if (!w || this.ambCap <= 0) return 0;
    const o = opts || {};
    const x0 = o.x0 != null ? o.x0 : -300, x1 = o.x1 != null ? o.x1 : 300;
    const z0 = o.z0 != null ? o.z0 : -200, z1 = o.z1 != null ? o.z1 : 200;
    const groundFn = typeof o.groundFn === 'function' ? o.groundFn : () => 0;
    const topY = o.topY != null ? o.topY : w.topY;
    // the caller may override the preset's height gate (scene3d adapts it to the live terrain relief)
    const minGround = o.minGround != null ? o.minGround : (w.minGround != null ? w.minGround : -1e9);
    const n = Math.min(scaleCount(w.count), this.ambCap);
    const c1 = w.color, c2 = w.color2 || w.color;
    let written = 0;
    for (let k = 0; k < n; k++) {
      const i = k;                            // ambient always occupies [0, n)
      // snow only settles over high ground (mountains); reject-sample low spots
      let px = 0, pz = 0, gy = 0, ok = false;
      for (let tries = 0; tries < 12; tries++) {
        px = x0 + Math.random() * (x1 - x0);
        pz = z0 + Math.random() * (z1 - z0);
        gy = groundFn(px, pz);
        if (gy >= minGround) { ok = true; break; }
      }
      if (!ok) { // could not find high ground — park this slot dead rather than snow on the sea
        this._write(i, 0, -9999, 0, 0, 0, 0, 0, 0, 0, [0, 0, 0], 0, 0, SHAPE_CIRCLE, -1e6, 0.0001, 0, 0, 0, 0, 0);
        continue;
      }
      const m = Math.random();
      const col = [c1[0] + (c2[0] - c1[0]) * m, c1[1] + (c2[1] - c1[1]) * m, c1[2] + (c2[2] - c1[2]) * m];
      const life = Math.max(0.2, w.life + (Math.random() - 0.5) * 2 * (w.lifeJit || 0));
      // stagger the phase so the whole layer never resets on the same frame
      const birth = this._time - Math.random() * life;
      const px2 = px, pz2 = pz;
      const py = gy + topY;                   // spawn high above the local ground, fall through
      const vx = (Math.random() - 0.5) * (w.spreadXZ || 1);
      const vz = (Math.random() - 0.5) * (w.spreadXZ || 1);
      this._write(i, px2, py, pz2, vx, w.velY, vz, 0, 0, 0, col,
        w.size * (0.8 + Math.random() * 0.5), w.sizeEnd != null ? w.sizeEnd : 1.0,
        w.shape || SHAPE_CIRCLE, birth, life, 1 /*loop*/, w.boost || 0,
        w.swirl || 0, w.swirlFreq || 1, Math.random() * 6.283);
      written++;
    }
    // kill any leftover ambient slots from a previous, larger layer
    for (let i = n; i < this._ambCount; i++) {
      this._write(i, 0, -9999, 0, 0, 0, 0, 0, 0, 0, [0, 0, 0], 0, 0, SHAPE_CIRCLE, -1e6, 0.0001, 0, 0, 0, 0, 0);
    }
    this._ambCount = n;
    this.weather = type;
    this._flush();
    this._saveWeather();
    return written;
  }

  /** Stop the ambient layer (clears the ambient region). */
  stopAmbient() {
    for (let i = 0; i < this._ambCount; i++) {
      this._write(i, 0, -9999, 0, 0, 0, 0, 0, 0, 0, [0, 0, 0], 0, 0, SHAPE_CIRCLE, -1e6, 0.0001, 0, 0, 0, 0, 0);
    }
    this._ambCount = 0;
    this.weather = 'clear';
    this._flush();
    this._saveWeather();
  }

  /** Per-frame: advance the shader clock + night factor. Zero per-particle CPU work. */
  update(dt, camera) {
    this._time += Math.max(0, Math.min(dt, 0.1));
    const u = this.material.uniforms;
    u.uTime.value = this._time;
    u.uNight.value = this.nightFactor || 0;
    // refresh size/pixel-ratio compensation a couple of times a second (cheap, no layout thrash)
    if ((this._frame++ & 31) === 0) this._updateScale();
  }

  // ---- weather persistence (survives a reload) ----
  _wkey() { return 'murmur.weather.v1'; }
  _saveWeather() {
    try {
      localStorage.setItem(this._wkey(), JSON.stringify({ type: this.weather, at: Date.now() }));
    } catch (_) { /* private mode / quota — weather is a nicety */ }
  }
  _restoreWeather() {
    let rec = null;
    try { rec = JSON.parse(localStorage.getItem(this._wkey()) || 'null'); } catch (_) { rec = null; }
    // a stored layer older than ~12 min is stale — let scene3d's scheduler pick fresh weather
    this._restored = (rec && (rec.type === 'rain' || rec.type === 'snow') && (Date.now() - (rec.at || 0)) < 12 * 60 * 1000)
      ? rec.type : null;
  }
  /** The weather to resume after a reload, if any (scene3d calls this once on init). */
  get restoredWeather() { return this._restored; }

  dispose() {
    try { this.scene.remove(this.points); } catch (_) { /* already gone */ }
    if (this.geometry) this.geometry.dispose();
    if (this.material) this.material.dispose();
    this.points = null;
  }
}

export default ParticleSystem;
