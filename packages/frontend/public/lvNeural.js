// lvNeural.js — task 30 · Phase C: neural→behaviour causal chain, swarm brain atmosphere,
// birth/death animation, and collective neuromodulator compass.
// Bare-imported by lineageView.js (NO ?v cache-buster; _headers forces etag revalidation on /lvNeural.js).
//
// FILLED CONTENT (Phase C — C6, C7 helper, C8, C13, C15)
//   C6  neural→behaviour causal chain: motor[5] radial ring on focused node + panel rows
//   C7  helper: isRealSpikes / spike raster data (the canvas draw stays in lineageView.drawLvRaster)
//   C8  whole-swarm brain atmosphere: 6-way concurrent /flies/{id} poll (NEVER /snapshot),
//       glow pulse frequency ∝ real total motor discharge rate
//   C13 birth/death transition animation: member diffing, enter/exit interpolation, max 12 active
//   C15 collective neuromodulator compass: DA(warm)/OA(cool) dual-pointer + 20-min trail + lrGate
//
// PERF CONTRACT
//   Every per-frame entry point consults LVQ.tier before expensive work. No shadowBlur, no
//   backdrop-filter, no per-frame traversal of ~10,361-element vectors. C8 poll is bounded by
//   in-flight mutex + 20 s floor interval. C13 caps active animations at 12.
import { LV, LVQ, nodeR, nodeById } from './lvState.js';
import { state, sim, clamp, mix, rgb, rgba, nmDaHz, nmOaHz, TAU, INK, GILT, GILT_HI, fnv1a } from './shared.js';
import { t as T } from './i18n.js?v=109';
import { getJSON } from './polling.js';
import { lvGeneticsFrame, lvGeneticsScale, lvGenotypePanel, lvBloodlinePanel, lvTraceStart, lvTraceClear } from './lvGenetics.js';
import { lvEnvNodeOverlay } from './lvEnv.js';
// task 33 · C25 — the replay growth overlay (horizon ring + birth flash + fresh lineage edges). Forwarded
// from HERE, not from lvFrame: seam layers hop through an existing frame function so core gains no new draw
// call point. Carries its own lvReplayOn() + LVQ.tier gate internally.
import { lvReplayDraw } from './lvTimeReplay.js';

// ================= C8: whole-swarm brain atmosphere =================
// Poll /flies/{id} for every live node, 6-way concurrent, 20 s interval floor.
// NEVER uses /snapshot (459 KB/fly/s is not a budget).
const C8_POLL_INTERVAL = 20000;   // 20 s between full rounds
const C8_CONCURRENCY = 6;
let c8LastPoll = 0;
let c8InFlight = false;
let c8Abort = null;
// Per-node atmosphere data: motorRate (sum of 5 channels' firingRate), arousal (0..1)
// Stored on node objects as n._atmo = {motorRate, arousal, at}

// Adapted NM reference: computed from actual population percentile instead of fixed 40 Hz
let c8NmRef = 14;   // ~p75 of real population motor discharge (task spec says ~14)
let c8NmSamples = [];

async function c8PollRound() {
  if (c8InFlight || !LV.active) return;
  c8InFlight = true;
  c8Abort = new AbortController();
  const signal = c8Abort.signal;
  const ids = [];
  for (const [id] of sim) {
    const n = nodeById(id);
    if (n && n.kind === 'live') ids.push(id);
  }
  let idx = 0;
  const rates = [];
  const worker = async () => {
    while (idx < ids.length) {
      const id = ids[idx++];
      if (signal.aborted) return;
      try {
        const d = await getJSON('/flies/' + id, 6000, signal);
        if (!d || signal.aborted) continue;
        const motor = d.motor;
        let motorRate = 0;
        if (Array.isArray(motor)) {
          for (const m of motor) motorRate += (m.firingRate || 0);
          // store per-channel normalized values for C6 ring
          const n = nodeById(id);
          if (n) {
            n._atmo = { motorRate, channels: motor.map(m => m.normalized || 0), arousal: (d.behavior && d.behavior.arousal) || 0, at: Date.now() };
            rates.push(motorRate);
          }
        }
      } catch { /* best-effort */ }
    }
  };
  await Promise.all(Array.from({ length: Math.min(C8_CONCURRENCY, ids.length) }, worker));
  // Update adaptive NM reference from collected rates (p75)
  if (rates.length >= 4) {
    rates.sort((a, b) => a - b);
    const p75 = rates[Math.floor(rates.length * 0.75)] || 14;
    c8NmRef = clamp(p75, 4, 60);
    c8NmSamples.push(c8NmRef);
    if (c8NmSamples.length > 60) c8NmSamples.shift();
  }
  c8InFlight = false;
  c8Abort = null;
}

/** Stop C8 polling (called on atlas close). */
export function c8Stop() {
  if (c8Abort) { c8Abort.abort(); c8Abort = null; }
  c8InFlight = false;
  c8LastPoll = 0;
}

// ================= C13: birth/death transition animation =================
const ANIM_CAP = 12;
const ANIM_DUR_ENTER = 1200;  // ms for a newborn to fly in
const ANIM_DUR_EXIT = 900;    // ms for a death to settle
let anims = [];               // [{uid, kind:'enter'|'exit', from:{x,y}, to:{x,y}, t0, dur, node}]
let prevLiveUids = null;      // Set of uids that were 'live' last rebuild — for diffing

/** Call after rebuild to diff membership and spawn enter/exit animations. */
export function c13Diff() {
  const curLive = new Set();
  for (const [uid, n] of LV.nodes) {
    if (n.kind === 'live') curLive.add(uid);
  }
  if (!prevLiveUids) { prevLiveUids = curLive; return; }
  // entering: in curLive but not in prev
  for (const uid of curLive) {
    if (prevLiveUids.has(uid)) continue;
    if (anims.length >= ANIM_CAP) break;
    const n = LV.nodes.get(uid);
    if (!n) continue;
    // fly in from parent position along lineage edge, or from holding ring
    let fromX = n.x, fromY = n.y;
    if (n.entry && Array.isArray(n.entry.parents) && n.entry.parents.length) {
      const pH = String(n.entry.parents[0]).toLowerCase();
      const pn = LV.nodes.get(pH);
      if (pn) { fromX = pn.x; fromY = pn.y; }
    } else if (uid.indexOf('id:') === 0) {
      // holding ring node — fly in from the ring centre direction
      const cx = LV.W / 2, cy = LV.H / 2;
      const ang = Math.atan2(n.y - cy, n.x - cx);
      fromX = cx + Math.cos(ang) * (n.rad * 1.15);
      fromY = cy + Math.sin(ang) * (n.rad * 1.15);
    }
    n.animating = true;
    n._ax = fromX; n._ay = fromY; n._ap = 0;   // seed the interpolation so frame 1 draws at the source, not the target
    anims.push({ uid, kind: 'enter', from: { x: fromX, y: fromY }, to: { x: n.x, y: n.y }, t0: performance.now(), dur: ANIM_DUR_ENTER, node: n });
  }
  // exiting: in prev but not in cur (died or left)
  for (const uid of prevLiveUids) {
    if (curLive.has(uid)) continue;
    if (anims.length >= ANIM_CAP) break;
    const n = LV.nodes.get(uid);
    if (!n) continue;
    // settle toward tombstone position (same position, but kind changed) or fade
    n.animating = true;
    n._ax = n.x; n._ay = n.y; n._ap = 0;
    anims.push({ uid, kind: 'exit', from: { x: n.x, y: n.y }, to: { x: n.x, y: n.y }, t0: performance.now(), dur: ANIM_DUR_EXIT, node: n });
  }
  // holding-ring interpolation: nodes that moved (position changed)
  for (const uid of curLive) {
    if (!prevLiveUids.has(uid)) continue;
    if (anims.length >= ANIM_CAP) break;
    const n = LV.nodes.get(uid);
    if (!n || !n._prevX) continue;
    const dx = n.x - n._prevX, dy = n.y - n._prevY;
    if (dx * dx + dy * dy < 4) continue;   // less than 2px move — skip
    n.animating = true;
    n._ax = n._prevX; n._ay = n._prevY; n._ap = 0;
    anims.push({ uid, kind: 'move', from: { x: n._prevX, y: n._prevY }, to: { x: n.x, y: n.y }, t0: performance.now(), dur: 600, node: n });
  }
  prevLiveUids = curLive;
}

/** Store current positions before rebuild (called from lineageView.rebuild). */
export function c13SnapshotPositions() {
  for (const n of LV.nodes.values()) {
    if (n.kind === 'live') { n._prevX = n.x; n._prevY = n.y; }
  }
}

function c13Advance(now) {
  for (let i = anims.length - 1; i >= 0; i--) {
    const a = anims[i];
    const p = clamp((now - a.t0) / a.dur, 0, 1);
    if (p >= 1) {
      a.node.animating = false;
      anims.splice(i, 1);
      continue;
    }
    // ease-out cubic
    const e = 1 - Math.pow(1 - p, 3);
    a.node._ax = a.from.x + (a.to.x - a.from.x) * e;
    a.node._ay = a.from.y + (a.to.y - a.from.y) * e;
    a.node._ap = p;
  }
}

function c13Draw(x, now) {
  for (const a of anims) {
    const n = a.node;
    const px = n._ax != null ? n._ax : n.x;
    const py = n._ay != null ? n._ay : n.y;
    const r = nodeR(n);
    if (a.kind === 'enter') {
      // gold ring expanding + node fading in
      const p = n._ap || 0;
      const alpha = clamp(p * 1.2, 0, 1);
      x.fillStyle = rgba(GILT_HI, alpha * 0.7);
      x.beginPath(); x.arc(px, py, r * (0.5 + p * 0.5), 0, TAU); x.fill();
      // gold halo ring
      x.strokeStyle = rgba(GILT_HI, (1 - p) * 0.8);
      x.lineWidth = 1.5;
      x.beginPath(); x.arc(px, py, r + 4 + (1 - p) * 8, 0, TAU); x.stroke();
    } else if (a.kind === 'exit') {
      // fade out + sink
      const p = n._ap || 0;
      const alpha = clamp(1 - p, 0, 1);
      x.fillStyle = rgba(mix(INK, [122, 90, 50], 0.5), alpha * 0.5);
      x.beginPath(); x.arc(px, py + p * 3, r * (1 - p * 0.3), 0, TAU); x.fill();
      // cross marker fading in
      x.strokeStyle = rgba([122, 90, 50], alpha * 0.6);
      x.lineWidth = 1;
      x.beginPath();
      x.moveTo(px - 2.6, py + 2.6 + p * 3); x.lineTo(px + 2.6, py - 2.6 + p * 3);
      x.moveTo(px + 2.6, py + 2.6 + p * 3); x.lineTo(px - 2.6, py - 2.6 + p * 3);
      x.stroke();
    }
    // 'move' kind: the node is drawn at its interpolated position by the main loop
    // (we just set _ax/_ay and the main loop reads them when animating=true)
  }
}

// ================= C15: collective neuromodulator compass =================
// DA(warm) / OA(cool) dual-pointer + 20-min trail + learningRateGate
const TRAIL_LEN = 120;   // 120 samples × 10 s ≈ 20 min
let nmTrail = [];        // [{da, oa, lr, t}]
let nmTrailLast = 0;

function c15SampleTrail(now) {
  if (now - nmTrailLast < 10000) return;   // 10 s sample interval
  nmTrailLast = now;
  const nm = state.nmMean || { daHz: 0, oaHz: 0 };
  const lr = nm.learningRateGate != null ? nm.learningRateGate : null;
  nmTrail.push({ da: nm.daHz || 0, oa: nm.oaHz || 0, lr, t: now });
  if (nmTrail.length > TRAIL_LEN) nmTrail.shift();
}

function c15Draw(x) {
  // Compass widget: drawn in world-space at the top-left of the atlas (fixed screen offset)
  const cx = -LV.W * 0.38, cy = -LV.H * 0.36;
  const R = 28;
  // background disc
  x.fillStyle = rgba([238, 231, 214], 0.72);
  x.beginPath(); x.arc(cx, cy, R + 4, 0, TAU); x.fill();
  x.strokeStyle = rgba(INK, 0.25); x.lineWidth = 0.8;
  x.beginPath(); x.arc(cx, cy, R + 4, 0, TAU); x.stroke();

  // trail (20-min arc sweep)
  if (nmTrail.length > 1) {
    x.lineWidth = 1.2;
    for (let i = 1; i < nmTrail.length; i++) {
      const prev = nmTrail[i - 1], cur = nmTrail[i];
      const alpha = (i / nmTrail.length) * 0.5;
      const daA = (prev.da / c8NmRef) * TAU * 0.5 - Math.PI * 0.5;
      const oaA = (prev.oa / c8NmRef) * TAU * 0.5 - Math.PI * 0.5;
      const daA2 = (cur.da / c8NmRef) * TAU * 0.5 - Math.PI * 0.5;
      const oaA2 = (cur.oa / c8NmRef) * TAU * 0.5 - Math.PI * 0.5;
      const rr = R * 0.7;
      // DA trail (warm)
      x.strokeStyle = rgba([200, 120, 40], alpha);
      x.beginPath(); x.moveTo(cx + Math.cos(daA) * rr * 0.3, cy + Math.sin(daA) * rr * 0.3);
      x.lineTo(cx + Math.cos(daA2) * rr, cy + Math.sin(daA2) * rr); x.stroke();
      // OA trail (cool)
      x.strokeStyle = rgba([80, 140, 200], alpha);
      x.beginPath(); x.moveTo(cx + Math.cos(oaA) * rr * 0.3, cy + Math.sin(oaA) * rr * 0.3);
      x.lineTo(cx + Math.cos(oaA2) * rr, cy + Math.sin(oaA2) * rr); x.stroke();
    }
  }

  // current pointers
  const nm = state.nmMean || { daHz: 0, oaHz: 0 };
  const daN = clamp(nm.daHz / c8NmRef, 0, 1);
  const oaN = clamp(nm.oaHz / c8NmRef, 0, 1);
  const daAngle = daN * TAU * 0.5 - Math.PI * 0.5;
  const oaAngle = oaN * TAU * 0.5 - Math.PI * 0.5;

  // DA pointer (warm)
  x.strokeStyle = rgba([200, 120, 40], 0.9); x.lineWidth = 2;
  x.beginPath(); x.moveTo(cx, cy); x.lineTo(cx + Math.cos(daAngle) * R, cy + Math.sin(daAngle) * R); x.stroke();
  // OA pointer (cool)
  x.strokeStyle = rgba([80, 140, 200], 0.9); x.lineWidth = 2;
  x.beginPath(); x.moveTo(cx, cy); x.lineTo(cx + Math.cos(oaAngle) * R, cy + Math.sin(oaAngle) * R); x.stroke();

  // centre dot
  x.fillStyle = rgba(INK, 0.6);
  x.beginPath(); x.arc(cx, cy, 2, 0, TAU); x.fill();

  // labels (strokeText halo, no shadowBlur)
  x.font = '7px "IBM Plex Mono", monospace'; x.lineWidth = 2;
  x.strokeStyle = rgba([238, 231, 214], 0.9);
  x.strokeText('DA', cx + R + 5, cy - 4);
  x.fillStyle = rgba([200, 120, 40], 0.9); x.fillText('DA', cx + R + 5, cy - 4);
  x.strokeStyle = rgba([238, 231, 214], 0.9);
  x.strokeText('OA', cx + R + 5, cy + 6);
  x.fillStyle = rgba([80, 140, 200], 0.9); x.fillText('OA', cx + R + 5, cy + 6);

  // learningRateGate indicator (small arc at bottom)
  const lr = nm.learningRateGate;
  if (lr != null && Number.isFinite(lr)) {
    const lrAngle = clamp(lr, 0, 1) * Math.PI;
    x.strokeStyle = rgba(mix([200, 120, 40], [80, 140, 200], lr), 0.6);
    x.lineWidth = 2.5;
    x.beginPath(); x.arc(cx, cy + R + 8, 6, Math.PI, Math.PI + lrAngle); x.stroke();
  }
}

// ================= C6: motor radial ring on focused node =================
const MOTOR_CHANNELS = ['leg_left', 'leg_right', 'wing', 'proboscis', 'abdomen'];
const MOTOR_COL = [[180, 80, 40], [40, 120, 180], [160, 140, 60], [100, 160, 80], [140, 80, 140]];

function c6DrawMotorRing(x, n, motor) {
  if (!n || !motor || !motor.length) return;
  const r = nodeR(n) + 7;
  const segAngle = TAU / 5;
  for (let i = 0; i < Math.min(5, motor.length); i++) {
    const m = motor[i];
    const norm = clamp(m.normalized || 0, 0, 1);
    const startA = i * segAngle - Math.PI / 2;
    const endA = startA + segAngle * 0.85;
    const col = MOTOR_COL[i] || GILT;
    // arc segment proportional to normalized firing
    const arcR = r + norm * 5;
    x.strokeStyle = rgba(col, 0.3 + norm * 0.6);
    x.lineWidth = 1.5 + norm * 1.5;
    x.beginPath(); x.arc(n.x, n.y, arcR, startA, endA); x.stroke();
  }
}

// ================= C8 atmosphere glow =================
function c8DrawAtmosphere(x, now) {
  if (LVQ.tier >= 2) return;   // quality gate: skip at tier 2+
  for (const n of LV.nodes.values()) {
    if (n.kind !== 'live' || n.animating) continue;
    const atmo = n._atmo;
    if (!atmo) continue;
    const age = (Date.now() - atmo.at) / 1000;
    if (age > 90) continue;   // stale data — skip
    const rate = atmo.motorRate;
    // pulse frequency proportional to real total discharge rate (replacing decorative sine)
    const freq = clamp(rate / c8NmRef, 0.1, 3);
    const phase = (fnv1a(n.uid) % 1000) / 1000 * TAU;   // deterministic per-node phase offset
    const pulse = 0.5 + 0.5 * Math.sin(now * 0.001 * freq * TAU + phase);
    const intensity = clamp(rate / (c8NmRef * 2), 0, 1);
    if (intensity < 0.02) continue;
    // warm/cool mix based on arousal
    const arousal = atmo.arousal || 0;
    const col = mix([200, 120, 40], [80, 140, 200], clamp(arousal, 0, 1));
    const r = nodeR(n);
    x.fillStyle = rgba(col, intensity * 0.12 * pulse);
    x.beginPath(); x.arc(n.x, n.y, r + 2 + intensity * 5 * pulse, 0, TAU); x.fill();
  }
}

// ================= main frame entry point =================
/**
 * Per-frame neural overlay, drawn AFTER the live nodes (so it can sit on top of them).
 * @param {CanvasRenderingContext2D} x  already in world space (see lvState.camApply)
 * @param {number} now  the rAF timestamp
 */
export function lvNeuralFrame(x, now) {
  if (!LV.active || LVQ.tier >= 2) return;

  // C8: trigger poll round if interval elapsed
  if (!c8InFlight && now - c8LastPoll >= C8_POLL_INTERVAL && !state.offline) {
    c8LastPoll = now;
    c8PollRound();
  }

  // C13: advance animations
  c13Advance(now);

  // C8: atmosphere glow (replaces decorative sine with real motor rates)
  if (LVQ.halo) c8DrawAtmosphere(x, now);

  // C6: motor radial ring on focused node
  if (LV.focusUid) {
    const fn = LV.nodes.get(LV.focusUid);
    if (fn && fn.kind === 'live') {
      // Use snapshot motor data if available (1 Hz focused poll), else atmosphere data
      const motor = (LV.focusSnap && LV.focusSnap.motor) || (fn._atmo && fn._atmo.channels
        ? fn._atmo.channels.map((v, i) => ({ channel: MOTOR_CHANNELS[i], normalized: v, firingRate: v * 50, spikes: 0 }))
        : null);
      if (motor) c6DrawMotorRing(x, fn, motor);
    }
  }

  // C13: draw enter/exit animations
  if (anims.length) c13Draw(x, now);

  // C15: collective neuromodulator compass (tier 0 only)
  if (LVQ.tier === 0) {
    c15SampleTrail(now);
    c15Draw(x);
  }

  // C9/C10/C11: genetics overlay (cross edges, bloodline highlight, genotype coloring)
  lvGeneticsFrame(x, now);
  // C9: generation depth scale + histogram (tier 0 only)
  if (LVQ.tier === 0) lvGeneticsScale(x);

  // task 31 · C18/C19/C21: environment node overlay (PnL recolour, reputation arcs, anchor marks)
  lvEnvNodeOverlay(x, now);

  // task 33 · C25 — the time-replay growth overlay: a dashed gold "horizon ring" at the outermost born
  // generation, birth-flash arcs on the ≤24 nodes born in the current key-frame bucket, and (at tier 0)
  // golden lineage edges for those fresh nodes. Self-gated: lvReplayOn() + LVQ.tier < 2.
  lvReplayDraw(x, now);
}

// ================= C6+C7: panel rows =================
/**
 * Extra rows for the focus sidebar's neural block, called once per /snapshot arrival (≤1 Hz, one fly only).
 * C6: motor[5] discharge bars + FAP/role
 * C7: label distinguishing real vs derived spikes
 * @returns {string} HTML to append inside #lv-panel (must be empty-string safe)
 */
export function lvNeuralPanelRows(snap) {
  if (!snap) return '';
  let html = '';

  // C6: motor channel bars
  const motor = snap.motor;
  if (Array.isArray(motor) && motor.length) {
    html += `<div class="lv-p-sec">${T('lv.motorTitle')}</div><div class="lv-motor-bars">`;
    for (const m of motor) {
      const norm = clamp(m.normalized || 0, 0, 1);
      const ch = m.channel || '?';
      const col = rgb(MOTOR_COL[MOTOR_CHANNELS.indexOf(ch)] || GILT);
      html += `<div class="lv-bar"><span class="lv-bar-n">${ch.replace('_', ' ')}</span>` +
        `<span class="lv-bar-t"><span class="lv-bar-f" style="width:${(norm * 100).toFixed(1)}%;background:${col}"></span></span>` +
        `<span class="lv-bar-v">${(m.firingRate || 0).toFixed(1)} Hz</span></div>`;
    }
    html += '</div>';
  }

  // C6: FAP/role is already rendered by the pre-existing drawLvBehaviour() into #lv-beh,
  // sourced from the node cache (n.fap / n.role, populated by lvData from /population).
  // /snapshot carries NO behavior object (only motor + neuromod + agent wallet), so this
  // seam contributes only the motor bars above and the spike-source label below.

  // C7: spike source indicator
  const spikes = snap.spikesLastStep;
  const isReal = hasRealSpikesLocal(spikes);
  const label = isReal ? T('lv.rasterReal') : T('lv.rasterDerived');
  html += `<div class="lv-spike-src">${label}</div>`;

  return html;
}

// C7 helper: check if spikesLastStep has any real (non-zero) spikes
function hasRealSpikesLocal(sp) {
  if (!sp || !sp.length) return false;
  for (let i = 0; i < sp.length; i++) if (sp[i]) return true;
  return false;
}
/** Exported for lineageView.js C7 raster upgrade. */
export { hasRealSpikesLocal as lvHasRealSpikes };

// ================= C10: bloodline trace trigger =================
/** Trigger a bloodline trace for the focused node. Called from lineageView.selectNode. */
export { lvTraceStart, lvTraceClear };

// ================= C11+C10: extra panel sections =================
/**
 * Build the genetics + bloodline panel sections for the focus sidebar.
 * Called from lineageView.updateFocusNeural after lvNeuralPanelRows.
 * @param {object} n  the focused node
 * @returns {string} HTML
 */
export function lvGeneticsPanelHTML(n) {
  let html = '';
  html += lvGenotypePanel(n);
  html += lvBloodlinePanel(n);
  return html;
}

// ================= C15: export compass trail for external read =================
export function lvNmTrail() { return nmTrail; }
export function lvC8NmRef() { return c8NmRef; }
