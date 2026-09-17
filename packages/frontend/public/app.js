// ==========================================================================
// murmur — a living population feeling the arc market.
//
// The page IS the artwork: a full-bleed field where a population of fruit-fly
// nervous systems drifts, huddles or scatters. Every ~4s we read the Worker's
// /population snapshot (the swarm's collective mood + each fly's decoded drives)
// and let the flies move accordingly — hot → scattered & agitated, cold → tight
// & still, calm → gently drifting. Motion is integrated here on the client from
// each fly's turnBias / arousal / cohesion (the backend does not track x/y).
//
// Around that core the field breathes:
//   • a curl-like flow field carries ambient ink motes (faster when the market
//     is hot) and nudges every fly, so the swarm always rides a visible current;
//   • the pointer stirs the swarm — hovering gently draws flies in, pressing
//     scatters them;
//   • a temperature history ribbon plots the last ~2.5 min of market temperature;
//   • touching a fly opens its inspector with that fly's live neural bloom, spike
//     raster, drives and x402 agent wallet (offscreen-cached + slow guarded poll,
//     so rapid clicking can never stall the tab);
//   • an about panel describes the piece in four languages (EN / 中 / 日 / 한).
//
// RESILIENCE / PERFORMANCE: the Worker may be undeployed, in which case its
// workers.dev host black-holes TCP and a browser fetch would otherwise hang for
// tens of seconds. Every request is therefore timeout+abort guarded, polls never
// overlap, an offline circuit-breaker runs the piece purely locally for a while,
// and the selected-fly feed (neural bloom + spike raster + wallet) is offscreen-
// cached, polled at a slow guarded cadence, and click-storm throttled — so rapid
// clicking can never pile up stuck requests or canvas work and the field stays smooth.
//
// The whole palette slowly warms or cools with the market temperature. No
// trading, no wallet — observation only.
// ==========================================================================

const params = new URLSearchParams(location.search);
const API =
  params.get("api") ||
  localStorage.getItem("murmur-api") ||
  "https://api.muros.live";                 // Worker API on the project's own zone (not *.workers.dev)
if (params.get("api")) localStorage.setItem("murmur-api", API);

const POLL_MS = 4000;
const FETCH_TIMEOUT_MS = 3500;   // abort a hung request well before the browser would
const OFFLINE_BACKOFF_MS = 20000; // circuit-breaker window: run local-only, no probing
const TAU = Math.PI * 2;
const $ = (id) => document.getElementById(id);

// ---------- small math / colour helpers ----------
const clamp = (x, a = 0, b = 1) => (x < a ? a : x > b ? b : x);
const lerp = (a, b, t) => a + (b - a) * t;
const mix = (A, B, t) => [lerp(A[0], B[0], t), lerp(A[1], B[1], t), lerp(A[2], B[2], t)];
const rgb = (c) => `rgb(${c[0] | 0},${c[1] | 0},${c[2] | 0})`;
const rgba = (c, a) => `rgba(${c[0] | 0},${c[1] | 0},${c[2] | 0},${a})`;

// ---------- live palette: temperature → paper + accent ----------
const PALETTE = {
  cold: { paper: [232, 237, 239], accent: [91, 124, 141] },   // cool slate
  calm: { paper: [242, 238, 230], accent: [154, 140, 110] },  // warm bone + taupe
  hot:  { paper: [247, 234, 224], accent: [192, 94, 60] },    // blush + terracotta
};
function paletteAt(T) {
  T = clamp(T);
  return T < 0.5
    ? { paper: mix(PALETTE.cold.paper, PALETTE.calm.paper, T / 0.5), accent: mix(PALETTE.cold.accent, PALETTE.calm.accent, T / 0.5) }
    : { paper: mix(PALETTE.calm.paper, PALETTE.hot.paper, (T - 0.5) / 0.5), accent: mix(PALETTE.calm.accent, PALETTE.hot.accent, (T - 0.5) / 0.5) };
}
function applyPaletteToDOM(pal) {
  const p = pal.paper, a = pal.accent, s = document.documentElement.style;
  s.setProperty("--paper", rgb(p));
  s.setProperty("--panel", `rgba(${p[0] | 0},${p[1] | 0},${p[2] | 0},0.88)`);
  s.setProperty("--accent", rgb(a));
  s.setProperty("--accent-rgb", `${a[0] | 0},${a[1] | 0},${a[2] | 0}`);
}

// behavioural-state earth tones (CSS strings for the inspector badge)
const STATE_COLOR = { AGITATE: "#c05e3c", EXPLORE: "#c99a3f", AGGREGATE: "#5b7c8d", REST: "#8b9a86" };
const KIND_COL = { sensory: [91, 124, 141], inter: [122, 114, 98], modulatory: [192, 94, 60], motor: [26, 26, 24] };
const STIR_COL = [120, 116, 104];   // neutral ink for the pointer "stir" ripple

// Wealth → colour ramp: the poorest flies read cool slate, the richest glow warm gold, so body HUE and
// body SIZE (both balance-driven) tell the same story at a glance — big + gold = a wealthy wallet.
const WEALTH_RAMP = [
  [92, 118, 140],   // poorest  — cool slate blue
  [126, 140, 122],  // lean     — muted sage
  [198, 154, 74],   // well-off — amber
  [240, 196, 92],   // richest  — bright gold
];
function wealthColorAt(t) {
  t = clamp(t, 0, 1);
  const n = WEALTH_RAMP.length - 1;
  const i = Math.min(n - 1, Math.floor(t * n));
  return mix(WEALTH_RAMP[i], WEALTH_RAMP[i + 1], t * n - i);
}

// ================= client state =================
const sim = new Map();          // flyId → simulated fly (position + smoothed drives)
let collective = null;          // latest CollectiveState
let selectedId = null;
let offline = false;
let offlineUntil = 0;           // circuit-breaker: skip network probes until this timestamp
let pollInFlight = false;       // never let two polls overlap
let cachedRect = null;          // cached canvas rect — avoid a reflow on every pointer event
let tempTarget = 0.5, tempSmoothed = 0.5;
let cohTarget = 0.5, cohSmoothed = 0.5;
let centroidX = 0, centroidY = 0;
let ripples = [];

// ================= agent economy (x402 micropayments between flies) =================
// Each fly is an autonomous agent; the /population feed now carries an economy summary
// ({ lastTick, totals, balances }). We render every settlement as a payment packet flying from
// payer to payee, keep a rolling ledger ticker, and show the selected fly's wallet in the inspector.
const atomicToUsdc = (a) => Number(a) / 1e6;         // amounts arrive as atomic-USDC strings (6 dec)
const GOOD_COL = { signal: [91, 124, 141], momentum: [192, 94, 60], attestation: [139, 154, 134] };
const ECON_EDGE_MS = 2000;                            // a payment packet lives ~2s
const MAX_EDGES = 60;                                 // cap: a busy tick can't pile up unbounded arcs
// Official Arc block explorer (docs.arc.io → mainnet chain 5042). Every real settlement carries a
// 64-hex txHash, so each ledger line links straight to it — a visitor can prove the money moved on-chain.
const ARC_EXPLORER = "https://explorer.arc.io";
const isRealTxHash = (h) => typeof h === "string" && /^0x[0-9a-fA-F]{64}$/.test(h);
const isRealAddr = (a) => typeof a === "string" && /^0x[0-9a-fA-F]{40}$/.test(a);
const shortHash = (h) => `${h.slice(0, 6)}…${h.slice(-4)}`;
let econMode = "simulated";
let econTotals = null;
let econBalances = new Map();                         // flyId → balance in USDC (number)
let payEdges = [];                                    // { fromId, toId, amount, good, valid, t0 }
// The /population poll (every POLL_MS) is far faster than the on-chain tick (cron, ~60s), so the same
// `lastTick` batch is re-delivered many times between ticks. Without dedup every settlement would be
// drawn and logged ~15×. Keyed by real txHash (or tick+parties offline) so one transaction = one entry.
const seenSettlements = new Set();
const SEEN_CAP = 400;                                 // bounded: trim oldest half when exceeded
let econAgents = [];                                  // full roster from /economy: {id, address, balance, paid, earned, deals, sales}
let walletsOpen = false;                              // right-side "all agent wallets" drawer
// offline: a purely client-side mirror of the agent economy so the piece still settles pre-deploy
const synthAgents = new Map();                        // flyId → { address, balance, paid, earned, deals, sales } (atomic strings)
let synthVolume = 0, synthDeals = 0;

// flow field + ambient ink motes
let flowTime = 0;
let motes = [];

// pointer (stirs the swarm)
const pointer = { x: 0, y: 0, inside: false, down: false };
let lastClickAt = 0;             // click-storm guard: cap interaction-driven work

// temperature history ribbon
const tempHistory = [];
const HIST_SAMPLE_MS = 500;
const HIST_WINDOW = 150000;      // 2.5 min
let lastHistSample = 0;

// (neural-feed state lives with the feed itself, further down)

// ================= canvas field =================
const canvas = $("field");
const ctx = canvas.getContext("2d");
let VW = 0, VH = 0, DPR = 1;

// Pre-rendered soft halo sprite: drawing one cached radial is far cheaper than
// building a fresh createRadialGradient for every fly every frame.
let haloSprite = null;
function makeHaloSprite() {
  const s = document.createElement("canvas");
  s.width = s.height = 128;
  const c = s.getContext("2d");
  const g = c.createRadialGradient(64, 64, 0, 64, 64, 64);
  g.addColorStop(0, "rgba(45,42,37,1)");
  g.addColorStop(0.55, "rgba(45,42,37,0.32)");
  g.addColorStop(1, "rgba(45,42,37,0)");
  c.fillStyle = g;
  c.fillRect(0, 0, 128, 128);
  return s;
}

function resize() {
  VW = window.innerWidth; VH = window.innerHeight;
  DPR = Math.min(1.5, window.devicePixelRatio || 1);   // capped: full-bleed canvas fill is the main per-frame cost
  canvas.width = Math.round(VW * DPR);
  canvas.height = Math.round(VH * DPR);
  canvas.style.width = VW + "px";
  canvas.style.height = VH + "px";
  ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
  // repaint the paper solid so the trail buffer has a clean base
  ctx.fillStyle = rgb(paletteAt(tempSmoothed).paper);
  ctx.fillRect(0, 0, VW, VH);
  cachedRect = null;             // canvas box changed — drop the cached rect
  initMotes();
}
window.addEventListener("resize", resize);

// ================= flow field =================
// A cheap curl-like field from summed sines; the whole swarm + the ambient motes
// ride it, and it speeds up as the market warms.
function flowAngle(x, y, t) {
  const s = 0.0021;
  const a =
    Math.sin(x * s + t * 0.021) +
    Math.sin(y * s * 1.3 - t * 0.017) +
    Math.sin((x + y) * s * 0.6 + t * 0.011);
  return a * Math.PI * 0.9;
}

function newMote() {
  const x = Math.random() * VW, y = Math.random() * VH;
  return { x, y, px: x, py: y, life: 0.6 + Math.random() * 0.6 };
}
function initMotes() {
  const count = clamp((VW * VH) / 22000, 48, 150) | 0;
  motes = [];
  for (let i = 0; i < count; i++) {
    const m = newMote();
    m.life = Math.random();       // stagger respawns so the field never blinks in unison
    motes.push(m);
  }
}
function updateMotes(dt) {
  const sp = 0.25 + tempSmoothed * 1.5;
  for (let i = 0; i < motes.length; i++) {
    const m = motes[i];
    m.px = m.x; m.py = m.y;
    const a = flowAngle(m.x, m.y, flowTime);
    m.x += Math.cos(a) * sp * dt;
    m.y += Math.sin(a) * sp * dt;
    m.life -= 0.0022 * dt;
    if (m.life <= 0 || m.x < -30 || m.x > VW + 30 || m.y < -30 || m.y > VH + 30) {
      motes[i] = newMote();
    }
  }
}
function renderMotes(pal) {
  if (!motes.length) return;
  const ink = mix([26, 26, 24], pal.accent, 0.35);
  ctx.lineWidth = 0.7;
  ctx.strokeStyle = rgba(ink, 0.02 + tempSmoothed * 0.05);
  ctx.beginPath();
  for (const m of motes) { ctx.moveTo(m.px, m.py); ctx.lineTo(m.x, m.y); }
  ctx.stroke();
}

// ================= flies =================
function spawnFly(id) {
  const ang = Math.random() * TAU, rad = Math.random() * Math.min(VW, VH) * 0.22;
  const bx = centroidX || VW / 2, by = centroidY || VH / 2;  // centre fallback on first spawn
  const x = bx + Math.cos(ang) * rad, y = by + Math.sin(ang) * rad;
  return {
    id,
    x, y, px: x, py: y,
    vx: 0, vy: 0,
    heading: Math.random() * TAU,
    wander: 0, phase: Math.random() * TAU,
    // smoothed drives (used by the sim) …
    aro: 0.3, coh: 0.5, turn: 0, wing: 0.3, rest: 0.3,
    balN: 0.5, tBalN: 0.5,   // normalised wallet balance (0 = poorest … 1 = richest) → drives body size
    // … and the latest authoritative server reading (used by the inspector)
    tAro: 0.3, tCoh: 0.5, tTurn: 0, tWing: 0.3, tRest: 0.3,
    state: "EXPLORE", temperament: 0.5, fingerprint: "",
    born: performance.now(), dying: false, dieT: 0,
  };
}

const SEP = 26;              // personal-space radius (css px)

function updateSim(dt, now) {
  // centroid of the living swarm
  let cx = 0, cy = 0, n = 0;
  for (const f of sim.values()) { if (!f.dying) { cx += f.x; cy += f.y; n++; } }
  if (n) { cx /= n; cy /= n; } else { cx = VW / 2; cy = VH / 2; }
  centroidX = cx; centroidY = cy;

  const T = tempSmoothed;
  const flowStr = 0.04 + T * 0.20;      // the current pushes harder when it is hot
  const list = [...sim.values()];

  for (const f of list) {
    // fade-out retired flies, then drop them
    if (f.dying) {
      if (!f.dieT) f.dieT = now;
      if (now - f.dieT > 820) { sim.delete(f.id); continue; }
    }
    // ease drives toward the latest server reading
    f.aro = lerp(f.aro, f.tAro, 0.05 * dt);
    f.coh = lerp(f.coh, f.tCoh, 0.05 * dt);
    f.turn = lerp(f.turn, f.tTurn, 0.05 * dt);
    f.wing = lerp(f.wing, f.tWing, 0.05 * dt);
    f.rest = lerp(f.rest, f.tRest, 0.05 * dt);
    f.balN = lerp(f.balN ?? 0.5, f.tBalN ?? 0.5, 0.04 * dt);   // wealth → size eases smoothly, never jumps

    const speed = (0.22 + f.aro * 2.3) * (1 - 0.55 * f.rest);

    // wander + turn bias → heading drift
    f.wander = (f.wander + (Math.random() - 0.5) * 0.5) * 0.92;
    f.heading += f.turn * 0.045 * dt + f.wander * 0.035 * dt + (Math.random() - 0.5) * 0.05 * (0.3 + f.aro) * dt;

    let ax = Math.cos(f.heading) * speed;
    let ay = Math.sin(f.heading) * speed;

    // ride the ambient flow field
    const fa = flowAngle(f.x, f.y, flowTime);
    ax += Math.cos(fa) * flowStr;
    ay += Math.sin(fa) * flowStr;

    // cohesion pulls toward the swarm centre; hot + low cohesion scatters outward
    const dx = cx - f.x, dy = cy - f.y, d = Math.hypot(dx, dy) || 1;
    ax += (dx / d) * f.coh * 0.75;
    ay += (dy / d) * f.coh * 0.75;
    ax -= (dx / d) * (1 - f.coh) * T * 0.7;
    ay -= (dy / d) * (1 - f.coh) * T * 0.7;

    // separation from neighbours (personal space)
    for (const g of list) {
      if (g === f || g.dying) continue;
      const sx = f.x - g.x, sy = f.y - g.y, sd = Math.hypot(sx, sy);
      if (sd > 0 && sd < SEP) { const push = (SEP - sd) * 0.028; ax += (sx / sd) * push; ay += (sy / sd) * push; }
    }

    // the pointer stirs the swarm: hover draws flies in, press blows them apart
    if (pointer.inside) {
      const pdx = pointer.x - f.x, pdy = pointer.y - f.y, pd = Math.hypot(pdx, pdy) || 1;
      if (pointer.down) {
        const R = 200;
        if (pd < R) { const s = 2.8 * (1 - pd / R); ax -= (pdx / pd) * s; ay -= (pdy / pd) * s; }
      } else {
        const R = 135;
        if (pd < R) { const s = 0.55 * (1 - pd / R); ax += (pdx / pd) * s; ay += (pdy / pd) * s; }
      }
    }

    // blend velocity, integrate, keep on-canvas with a soft margin
    f.vx = lerp(f.vx, ax, 0.12 * dt);
    f.vy = lerp(f.vy, ay, 0.12 * dt);
    f.px = f.x; f.py = f.y;
    f.x += f.vx * dt; f.y += f.vy * dt;
    // confine the swarm to a centred activity region: inset so flies stay clear of the corner
    // panels and the field isn't mostly empty space, with a firmer push so they hold the region
    const mx = Math.max(96, Math.round(VW * 0.21));
    const my = Math.max(88, Math.round(VH * 0.19));
    if (f.x < mx) f.vx += (mx - f.x) * 0.017 * dt;
    if (f.x > VW - mx) f.vx -= (f.x - (VW - mx)) * 0.017 * dt;
    if (f.y < my) f.vy += (my - f.y) * 0.017 * dt;
    if (f.y > VH - my) f.vy -= (f.y - (VH - my)) * 0.017 * dt;
    f.x = clamp(f.x, 6, VW - 6); f.y = clamp(f.y, 6, VH - 6);
    if (Math.hypot(f.vx, f.vy) > 0.05) f.heading = Math.atan2(f.vy, f.vx);
    f.phase += (0.06 + f.wing * 0.55) * dt;
  }
}

function render(pal, now) {
  // trail wash: cohesive swarms leave long lingering trails, scattered ones fade fast
  const fade = 0.055 + (1 - cohSmoothed) * 0.24;
  ctx.fillStyle = rgba(pal.paper, fade);
  ctx.fillRect(0, 0, VW, VH);

  // ambient flow ink (under everything)
  if (quality >= 1) renderMotes(pal);

  const acc = pal.accent;

  // murmuration mesh: faint threads between close flies when the swarm is cohesive
  if (quality >= 2 && cohSmoothed > 0.34) {
    const list = [...sim.values()].filter((f) => !f.dying);
    const R = 74 + cohSmoothed * 46;
    ctx.lineWidth = 0.6;
    for (let i = 0; i < list.length; i++) {
      for (let j = i + 1; j < list.length; j++) {
        const a = list[i], b = list[j];
        const dx = a.x - b.x, dy = a.y - b.y, dd = Math.hypot(dx, dy);
        if (dd < R) {
          const al = (1 - dd / R) * (cohSmoothed - 0.34) * 0.5;
          ctx.strokeStyle = rgba(mix([26, 26, 24], acc, 0.4), al);
          ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
        }
      }
    }
  }

  // pointer / stimulus ripples
  for (let i = ripples.length - 1; i >= 0; i--) {
    const r = ripples[i], age = (now - r.t0) / 1700;
    if (age >= 1) { ripples.splice(i, 1); continue; }
    const rad = age * Math.min(VW, VH) * 0.55;
    ctx.strokeStyle = rgba(r.color, (1 - age) * 0.36);
    ctx.lineWidth = 1.4 * (1 - age) + 0.3;
    ctx.beginPath(); ctx.arc(r.x, r.y, rad, 0, TAU); ctx.stroke();
  }

  // the flies
  for (const f of sim.values()) {
    let alpha = clamp((now - f.born) / 900);
    if (f.dying) alpha = clamp(1 - (now - (f.dieT || now)) / 820);
    if (alpha <= 0.001) continue;
    drawFly(f, acc, alpha, now);
  }

  // x402 settlement packets flying payer → payee (over the swarm, so the money is visible)
  renderPayments(pal, now);
}

function drawFly(f, acc, alpha, now) {
  const flap = Math.sin(f.phase) * 0.5 + 0.5;               // 0..1 wingbeat phase
  const balN = f.balN != null ? f.balN : 0.5;
  // Colour AND size both encode wealth: the richer the wallet, the warmer (slate → gold) and bigger the
  // fly. Balance is normalised 0..1 across the swarm (the real spread is tight, so min-max scaling makes
  // the ranking legible); arousal stays a secondary modulation so an agitated rich fly pulses larger.
  const body = mix([26, 26, 24], wealthColorAt(balN), 0.55 + f.temperament * 0.25);
  const size = (2.4 + balN * 3.4) * (0.9 + f.aro * 0.45);
  const haloR = size * 3.2 + f.wing * flap * size * 2.6;

  // ink trail: a short stroke from the previous position (stronger when aroused)
  const tdx = f.x - f.px, tdy = f.y - f.py;
  if (quality >= 1 && tdx * tdx + tdy * tdy > 0.6) {
    ctx.strokeStyle = rgba(body, (0.05 + f.aro * 0.15) * alpha);
    ctx.lineWidth = size * 0.62;
    ctx.beginPath(); ctx.moveTo(f.px, f.py); ctx.lineTo(f.x, f.y); ctx.stroke();
  }

  // soft halo (cached sprite, tinted by alpha)
  if (haloSprite) {
    ctx.globalAlpha = (0.1 + f.aro * 0.16) * alpha;
    ctx.drawImage(haloSprite, f.x - haloR, f.y - haloR, haloR * 2, haloR * 2);
    ctx.globalAlpha = 1;
  }

  // wings (two faint arcs that open/close with the wingbeat)
  ctx.save();
  ctx.translate(f.x, f.y); ctx.rotate(f.heading);
  const wspread = 0.5 + flap * 0.9;
  ctx.strokeStyle = rgba(acc, (0.1 + f.wing * 0.22) * alpha);
  ctx.lineWidth = 0.7;
  for (const s of [-1, 1]) {
    ctx.beginPath();
    ctx.ellipse(-size * 0.3, s * size * 0.5, size * 1.5, size * 0.6, s * wspread, 0, TAU);
    ctx.stroke();
  }
  // body: a small comma oriented along travel
  ctx.fillStyle = rgba(body, (0.5 + f.aro * 0.45) * alpha);
  ctx.beginPath(); ctx.ellipse(0, 0, size * 1.5, size * 0.82, 0, 0, TAU); ctx.fill();
  ctx.restore();

  // selection ring
  if (f.id === selectedId) {
    ctx.strokeStyle = rgba(acc, 0.85 * alpha);
    ctx.lineWidth = 1;
    ctx.beginPath(); ctx.arc(f.x, f.y, size * 4 + 4 + flap * 1.6, 0, TAU); ctx.stroke();
  }
}

// ================= temperature history ribbon =================
const thCanvas = $("temp-history");
const thCtx = thCanvas ? thCanvas.getContext("2d") : null;
function sampleHistory(now) {
  if (now - lastHistSample < HIST_SAMPLE_MS) return;
  lastHistSample = now;
  tempHistory.push({ t: now, T: tempSmoothed });
  while (tempHistory.length && now - tempHistory[0].t > HIST_WINDOW) tempHistory.shift();
}
function drawTempHistory(now) {
  if (!thCtx) return;
  const W = thCanvas.width, H = thCanvas.height;
  const pal = paletteAt(tempSmoothed);
  thCtx.clearRect(0, 0, W, H);

  // regime threshold guides (cold ≤ .33, hot ≥ .66)
  thCtx.strokeStyle = rgba(mix([26, 26, 24], pal.accent, 0.3), 0.14);
  thCtx.lineWidth = 1;
  for (const th of [0.33, 0.66]) {
    const y = H - th * H;
    thCtx.beginPath(); thCtx.moveTo(0, y); thCtx.lineTo(W, y); thCtx.stroke();
  }
  if (tempHistory.length < 2) return;

  const xOf = (t) => W - ((now - t) / HIST_WINDOW) * W;
  const yOf = (T) => H - clamp(T) * H;

  // area under the curve
  thCtx.beginPath();
  thCtx.moveTo(xOf(tempHistory[0].t), H);
  for (const p of tempHistory) thCtx.lineTo(xOf(p.t), yOf(p.T));
  thCtx.lineTo(xOf(tempHistory[tempHistory.length - 1].t), H);
  thCtx.closePath();
  const grad = thCtx.createLinearGradient(0, 0, 0, H);
  grad.addColorStop(0, rgba(pal.accent, 0.30));
  grad.addColorStop(1, rgba(pal.accent, 0.02));
  thCtx.fillStyle = grad;
  thCtx.fill();

  // the temperature line
  thCtx.beginPath();
  for (let i = 0; i < tempHistory.length; i++) {
    const p = tempHistory[i];
    if (i === 0) thCtx.moveTo(xOf(p.t), yOf(p.T)); else thCtx.lineTo(xOf(p.t), yOf(p.T));
  }
  thCtx.strokeStyle = rgba(pal.accent, 0.85);
  thCtx.lineWidth = 1.4;
  thCtx.stroke();

  // live head
  const head = tempHistory[tempHistory.length - 1];
  thCtx.fillStyle = rgba(pal.accent, 0.95);
  thCtx.beginPath(); thCtx.arc(xOf(head.t), yOf(head.T), 2, 0, TAU); thCtx.fill();
}

// ================= the generative loop =================
// PERF SAFETY: the body is wrapped so a transient error can never kill the rAF chain (a dead
// loop reads as a hard freeze), and an adaptive quality level sheds the heaviest field layers
// (ink motes, murmuration mesh, trails) whenever the frame budget is blown, so weak machines
// degrade gracefully instead of locking up.
let last = performance.now(), frame = 0;
let frameMsAvg = 16, quality = 2, lastQualityAt = 0, loopWarned = false;  // 2=full 1=no motes/mesh/trails-heavy 0=minimal
function loop(now) {
  try {
    const ms = now - last;
    const dt = clamp(ms / 16.667, 0.2, 2.4);
    last = now; frame++;
    frameMsAvg = lerp(frameMsAvg, ms, 0.06);
    if (now - lastQualityAt > 1000) {
      lastQualityAt = now;
      if (frameMsAvg > 30 && quality > 0) quality--;
      else if (frameMsAvg < 19 && quality < 2) quality++;
    }
    tempSmoothed = lerp(tempSmoothed, tempTarget, 0.02 * dt);
    cohSmoothed = lerp(cohSmoothed, cohTarget, 0.03 * dt);
    flowTime += dt * (0.35 + tempSmoothed * 1.1);   // the current races when the market is hot
    const pal = paletteAt(tempSmoothed);
    if (frame % 6 === 0) applyPaletteToDOM(pal);
    sampleHistory(now);
    updateSim(dt, now);
    if (quality >= 1) updateMotes(dt);
    render(pal, now);
    if (frame % 3 === 0) drawTempHistory(now);
    if (selectedId != null) { renderBloom(now); renderRaster(now); }
  } catch (e) {
    if (!loopWarned) { loopWarned = true; console.warn("[murmur] loop error (self-healed):", e); }
  } finally {
    requestAnimationFrame(loop);
  }
}

// ================= agent economy: render + data =================
// Draw each live settlement as a packet travelling from the payer fly to the payee fly, with a faint
// guide thread. Colour encodes the good being bought (signal / momentum / attestation); declined
// attempts (insufficient funds) draw dimmer so the ledger stays honest.
function renderPayments(pal, now) {
  if (!payEdges.length) return;
  for (let i = payEdges.length - 1; i >= 0; i--) {
    const e = payEdges[i];
    const dur = e.real ? 2800 : ECON_EDGE_MS;   // a real on-chain trade flashes longer so it's unmissable
    const age = (now - e.t0) / dur;
    if (age >= 1) { payEdges.splice(i, 1); continue; }
    const a = sim.get(e.fromId), b = sim.get(e.toId);
    if (!a || !b || a.dying || b.dying) { payEdges.splice(i, 1); continue; }
    if (e.real) renderRealTrade(a, b, e, clamp(age), now);
    else renderSimTrade(a, b, e, age, pal);
  }
}

// A real on-chain settlement gets an unmissable rainbow "money beam": a glowing gradient link, a
// bright comet packet with a colourful tail + sparks, and expanding flash rings at both wallets — so
// anyone watching instantly sees that two flies just paid each other in real USDC.
function renderRealTrade(a, b, e, age, now) {
  const fade = clamp(age < 0.12 ? age / 0.12 : (1 - age) / 0.88);   // quick in, slow out
  const hueBase = (now * 0.11 + e.fromId * 41 + e.toId * 67) % 360; // slowly cycling, unique per pair
  const amt = Math.min(1, e.amount * 520);                          // bigger trade → fatter, brighter

  // rainbow beam + glow
  const g = ctx.createLinearGradient(a.x, a.y, b.x, b.y);
  for (let s = 0; s <= 5; s++) {
    const h = (hueBase + s * 46) % 360;
    g.addColorStop(s / 5, `hsla(${h},100%,62%,${0.12 + 0.5 * fade})`);
  }
  ctx.save();
  ctx.lineCap = "round";
  ctx.shadowColor = `hsla(${hueBase},100%,60%,${0.85 * fade})`;
  ctx.shadowBlur = 16 * fade;
  ctx.strokeStyle = g;
  ctx.lineWidth = (1.2 + amt * 3.2) * (0.5 + fade * 0.9);
  ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
  ctx.restore();

  // comet: colourful tail + white-hot head
  const t = age;
  const px = lerp(a.x, b.x, t), py = lerp(a.y, b.y, t);
  const bt = Math.max(0, t - 0.16);
  const tx = lerp(a.x, b.x, bt), ty = lerp(a.y, b.y, bt);
  const tg = ctx.createLinearGradient(tx, ty, px, py);
  tg.addColorStop(0, `hsla(${(hueBase + 120) % 360},100%,60%,0)`);
  tg.addColorStop(1, `hsla(${(hueBase + 210) % 360},100%,74%,${0.85 * fade})`);
  ctx.strokeStyle = tg; ctx.lineWidth = 2.4 + amt * 3; ctx.lineCap = "round";
  ctx.beginPath(); ctx.moveTo(tx, ty); ctx.lineTo(px, py); ctx.stroke();
  const hr = (2.4 + amt * 3.4) * 3;
  const hg = ctx.createRadialGradient(px, py, 0, px, py, hr);
  hg.addColorStop(0, `hsla(0,0%,100%,${0.95 * fade})`);
  hg.addColorStop(0.35, `hsla(${hueBase},100%,72%,${0.75 * fade})`);
  hg.addColorStop(1, `hsla(${hueBase},100%,60%,0)`);
  ctx.fillStyle = hg; ctx.beginPath(); ctx.arc(px, py, hr, 0, TAU); ctx.fill();

  // sparks trailing the comet (shed first when the frame budget is blown)
  if (quality >= 1) {
    for (let s = 0; s < 5; s++) {
      const st = Math.max(0, t - 0.03 - s * 0.035);
      const sx = lerp(a.x, b.x, st), sy = lerp(a.y, b.y, st);
      const ang = now * 0.02 + s * 2.1 + e.fromId;
      const rr = 2 + s * 1.6;
      ctx.fillStyle = `hsla(${(hueBase + s * 40) % 360},100%,66%,${Math.max(0, 0.6 - s * 0.11) * fade})`;
      ctx.beginPath(); ctx.arc(sx + Math.cos(ang) * rr * 0.5, sy + Math.sin(ang) * rr * 0.5, Math.max(0.4, 1.5 - s * 0.22), 0, TAU); ctx.fill();
    }
  }

  // expanding flash rings at both wallets — the "a trade just happened" signal
  if (age < 0.62) {
    const rp = age / 0.62, rr = 6 + rp * 32, ra = (1 - rp) * 0.7 * fade;
    ctx.lineWidth = 2 * (1 - rp) + 0.4;
    for (const p of [a, b]) {
      ctx.strokeStyle = `hsla(${hueBase},100%,68%,${ra})`;
      ctx.beginPath(); ctx.arc(p.x, p.y, rr, 0, TAU); ctx.stroke();
    }
  }
}

// The understated style for non-on-chain settlements (offline / simulated): a faint thread + packet.
function renderSimTrade(a, b, e, age, pal) {
  const col = GOOD_COL[e.good] || pal.accent;
  const fade = (1 - age) * (e.valid ? 1 : 0.4);

  // guide thread
  ctx.strokeStyle = rgba(col, 0.05 + 0.1 * fade);
  ctx.lineWidth = 0.7;
  ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();

  // the packet + a short tail behind it
  const t = age;
  const px = lerp(a.x, b.x, t), py = lerp(a.y, b.y, t);
  const bt = Math.max(0, t - 0.09);
  const tx = lerp(a.x, b.x, bt), ty = lerp(a.y, b.y, bt);
  const r = 1.5 + Math.min(2.6, e.amount * 380);
  ctx.strokeStyle = rgba(col, 0.42 * fade);
  ctx.lineWidth = r * 0.9;
  ctx.beginPath(); ctx.moveTo(tx, ty); ctx.lineTo(px, py); ctx.stroke();
  ctx.fillStyle = rgba(col, (e.valid ? 0.92 : 0.4) * fade);
  ctx.beginPath(); ctx.arc(px, py, r, 0, TAU); ctx.fill();
}

/** Consume the economy summary the /population feed carries (live) or the local mirror (offline). */
function applyEconomy(econ) {
  if (!econ) return;
  if (econ.balances) {
    econBalances = new Map();
    for (const [id, atomic] of Object.entries(econ.balances)) econBalances.set(Number(id), atomicToUsdc(atomic));
  }
  refreshBalanceScale();
  if (econ.totals) { econTotals = econ.totals; updateEconHud(econ.totals); }
  if (Array.isArray(econ.lastTick)) spawnPaymentEdges(econ.lastTick);
  if (selectedId != null) {
    const bal = econBalances.get(selectedId);
    if (bal != null) { const el = $("ins-bal"); if (el) el.textContent = bal.toFixed(4); }
  }
}

/** Recompute the swarm's wallet-balance range and each fly's normalised balance (0 = poorest … 1 =
 *  richest), which drives body size ("richer = bigger"). Sources: the /population economy balances
 *  and the /economy agent roster — merged so the scale is correct whichever feed has arrived. */
function refreshBalanceScale() {
  const map = new Map(econBalances);
  for (const ag of econAgents) { if (ag && ag.id != null) map.set(Number(ag.id), atomicToUsdc(ag.balance || "0")); }
  if (!map.size) return;
  let mn = Infinity, mx = -Infinity;
  for (const v of map.values()) { if (v < mn) mn = v; if (v > mx) mx = v; }
  if (!isFinite(mn) || !isFinite(mx)) return;
  const span = mx - mn;
  for (const [id, f] of sim) {
    const v = map.get(id);
    f.tBalN = (span > 1e-9 && v != null) ? clamp((v - mn) / span) : 0.5;
  }
}

function spawnPaymentEdges(list) {
  const now = performance.now();
  for (const s of list) {
    if (!s || s.fromId == null || s.toId == null) continue;
    // Stable identity for this settlement: the on-chain txHash when real, else tick+parties+amount.
    const key = isRealTxHash(s.txHash) ? s.txHash : `${s.tick}:${s.fromId}:${s.toId}:${s.good}:${s.amount}`;
    if (seenSettlements.has(key)) continue;           // already drawn/logged on an earlier poll of this tick
    seenSettlements.add(key);
    // `real` = a genuinely-mined on-chain settlement (valid, NOT simulated, real 64-hex txHash) → flashy.
    // Simulated / offline / declined trades stay subtle, so the dazzle is reserved for real USDC moving.
    const real = !!s.valid && !s.simulated && isRealTxHash(s.txHash);
    payEdges.push({ fromId: s.fromId, toId: s.toId, amount: atomicToUsdc(s.amount), good: s.good || "signal", valid: !!s.valid, real, t0: now });
    if (s.valid) pushEconFeed(s);
  }
  // Keep the dedup set bounded (Set preserves insertion order → drop the oldest half).
  if (seenSettlements.size > SEEN_CAP) {
    const it = seenSettlements.values();
    for (let i = 0; i < (SEEN_CAP >> 1); i++) { const v = it.next().value; if (v === undefined) break; seenSettlements.delete(v); }
  }
  if (payEdges.length > MAX_EDGES) payEdges.splice(0, payEdges.length - MAX_EDGES);
}

function updateEconHud(t) {
  if (!t) return;
  const set = (id, v) => { const el = $(id); if (el) el.textContent = v; };
  set("econ-vol", (t.volumeUsdc || 0).toFixed(3));
  set("econ-deals", t.count || 0);
  set("econ-agents", t.liveAgents != null ? t.liveAgents : "–");
  set("econ-mean", t.meanBalanceUsdc != null ? t.meanBalanceUsdc.toFixed(2) : "–");
  set("econ-gini", t.gini != null ? t.gini.toFixed(2) : "–");
  updateEconMode();
  updateEconFoot();
}

/** The mode badge leads with the truth: in live onchain mode it's a pulsing "live · on-chain" pill
 *  (real USDC is moving on Arc mainnet); otherwise it names the mode plainly. */
function updateEconMode() {
  const em = $("econ-mode");
  if (!em) return;
  if (econMode === "onchain") {
    em.innerHTML = '<span class="live-dot"></span>live · on-chain';
    em.classList.add("is-live");
  } else {
    em.textContent = econMode + " x402";
    em.classList.remove("is-live");
  }
}

/** The footer must never lie about whether real money moves. In live onchain mode it says so and
 *  points at the explorer; in simulated mode it keeps the honest "no real funds move" line. */
function updateEconFoot() {
  const f = $("econ-foot");
  if (!f) return;
  if (econMode === "onchain") {
    f.textContent = "live · settled on Arc mainnet · click any hash to verify on-chain";
    f.classList.add("live");
  } else {
    f.textContent = "keyless · simulated — no real funds move";
    f.classList.remove("live");
  }
}

/** Rolling ledger ticker: the last few settlements, newest on top. Each real on-chain
 *  settlement links to the official Arc explorer so the transfer can be verified. */
function pushEconFeed(s) {
  const host = $("econ-feed");
  if (!host) return;
  const line = document.createElement("div");
  line.className = "econ-line";

  const txt = document.createElement("span");
  txt.className = "econ-line-txt";
  txt.textContent = `#${s.fromId} → #${s.toId} · ${atomicToUsdc(s.amount).toFixed(4)} · ${s.good}`;
  line.appendChild(txt);

  // Only a genuinely-mined hash is linkable: real 64-hex + valid. Simulated / offline / shadow
  // settlements (txHash "0x") stay plain text so we never link to something that won't resolve.
  if (s.valid && isRealTxHash(s.txHash)) {
    const a = document.createElement("a");
    a.className = "tx-link";
    a.href = `${ARC_EXPLORER}/tx/${s.txHash}`;
    a.target = "_blank";
    a.rel = "noopener noreferrer";
    a.title = `Verify on the Arc explorer — ${s.txHash}`;
    a.textContent = `↗ ${shortHash(s.txHash)}`;
    line.appendChild(a);
  }

  host.prepend(line);
  while (host.children.length > 8) host.lastChild.remove();
}

/** Show one fly's x402 agent wallet in the inspector. `ag` carries atomic-string amounts. */
function updateWallet(ag) {
  if (!ag) return;
  const set = (id, v) => { const el = $(id); if (el) el.textContent = v; };
  set("ins-bal", atomicToUsdc(ag.balance || "0").toFixed(4));
  // In live onchain mode the wallet address links to this agent's on-chain activity in the Arc
  // explorer (works on mobile too, where the ledger feed is hidden). Otherwise it stays plain text.
  const addrEl = $("ins-addr");
  if (addrEl) {
    if (econMode === "onchain" && isRealAddr(ag.address)) {
      addrEl.textContent = "";
      const a = document.createElement("a");
      a.href = `${ARC_EXPLORER}/address/${ag.address}`;
      a.target = "_blank";
      a.rel = "noopener noreferrer";
      a.title = `View this agent's on-chain activity — ${ag.address}`;
      a.textContent = ag.address;
      addrEl.appendChild(a);
    } else {
      addrEl.textContent = ag.address || "–";
    }
  }
  set("ins-paid", atomicToUsdc(ag.paid || "0").toFixed(4));
  set("ins-earned", atomicToUsdc(ag.earned || "0").toFixed(4));
  set("ins-deals", `${ag.deals || 0} / ${ag.sales || 0}`);
}

// ================= all-agent wallets drawer (right side) =================
// Every fly owns its own x402 wallet. This roster lists all of them at once; clicking a row opens
// that fly's inspector (the existing per-fly view is preserved), and ↗ opens its address in the
// official Arc explorer so any wallet's on-chain activity can be verified.
function applyEconAgents(agents) {
  econAgents = agents;
  refreshBalanceScale();          // fresh roster → refresh the wealth scale that drives fly size
  if (walletsOpen) renderWallets();
}

/** Live: the /economy roster. Offline/pre-deploy: mirror the local synth wallets so the drawer is
 *  never empty. Both are normalised to {id, address, balance(atomic), paid, earned, deals, sales}. */
function rosterSource() {
  if (econAgents.length) return econAgents;
  return [...synthAgents.entries()].map(([id, a]) => ({
    id: Number(id), address: a.address, balance: a.balance, paid: a.paid, earned: a.earned, deals: a.deals, sales: a.sales,
  }));
}

function renderWallets() {
  const host = $("wallets-list");
  if (!host) return;
  const list = rosterSource().slice().sort((a, b) => (a.id ?? 0) - (b.id ?? 0));
  const live = econMode === "onchain";
  host.textContent = "";
  for (const ag of list) {
    const row = document.createElement("div");
    row.className = "wallet-row" + (ag.id === selectedId ? " sel" : "");
    row.tabIndex = 0;
    row.setAttribute("role", "button");
    row.setAttribute("aria-label", `fly ${ag.id} wallet, ${atomicToUsdc(ag.balance || "0").toFixed(4)} USDC`);

    const idEl = document.createElement("span"); idEl.className = "wr-id"; idEl.textContent = "#" + ag.id;
    const balEl = document.createElement("span"); balEl.className = "wr-bal";
    balEl.innerHTML = `${atomicToUsdc(ag.balance || "0").toFixed(4)} <em>usdc</em>`;
    const addrEl = document.createElement("span"); addrEl.className = "wr-addr";
    addrEl.textContent = isRealAddr(ag.address) ? shortHash(ag.address) : (ag.address || "–");
    row.append(idEl, balEl, addrEl);

    if (live && isRealAddr(ag.address)) {
      const link = document.createElement("a");
      link.className = "wr-link";
      link.href = `${ARC_EXPLORER}/address/${ag.address}`;
      link.target = "_blank"; link.rel = "noopener noreferrer";
      link.title = `Verify this wallet on the Arc explorer — ${ag.address}`;
      link.textContent = "↗";
      link.addEventListener("click", (e) => e.stopPropagation());   // open explorer, don't select the fly
      row.appendChild(link);
    }

    const open = () => { closeWallets(); select(ag.id); };
    row.addEventListener("click", open);
    row.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); open(); } });
    host.appendChild(row);
  }
  const sub = $("wallets-sub");
  if (sub) sub.textContent = live ? `${list.length} wallets · live on Arc mainnet` : `${list.length} wallets · ${econMode}`;
}

function openWallets() {
  walletsOpen = true;
  const w = $("wallets");
  if (!w) return;
  w.hidden = false;
  document.body.classList.add("wallets-open");
  requestAnimationFrame(() => w.classList.add("open"));
  renderWallets();
  // pull a fresh roster immediately so the drawer is never stale on first open
  getJSON("/economy").then((e) => { if (e && Array.isArray(e.agents)) applyEconAgents(e.agents); }).catch(() => {});
}

function closeWallets() {
  walletsOpen = false;
  document.body.classList.remove("wallets-open");
  const w = $("wallets");
  if (!w) return;
  w.classList.remove("open");
  setTimeout(() => { if (!walletsOpen) w.hidden = true; }, 420);
}

function toggleWallets() { if (walletsOpen) closeWallets(); else openWallets(); }

// ================= data layer =================
// Every request is timeout + abort guarded. When the Worker is undeployed the
// workers.dev host black-holes TCP (connect never completes), so an unguarded
// fetch hangs for tens of seconds; aborting fast is what stops rapid clicking
// from stacking up stuck requests and stalling the tab.
async function getJSON(path, timeoutMs = FETCH_TIMEOUT_MS, outerSignal) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  const onOuter = () => ctrl.abort();
  if (outerSignal) outerSignal.addEventListener("abort", onOuter);
  try {
    const r = await fetch(API + path, { cache: "no-store", signal: ctrl.signal });
    if (!r.ok) throw new Error(`${path} ${r.status}`);
    return await r.json();
  } finally {
    clearTimeout(timer);
    if (outerSignal) outerSignal.removeEventListener("abort", onOuter);
  }
}

async function poll() {
  if (pollInFlight) return;                        // never overlap polls
  if (Date.now() < offlineUntil) {                 // circuit-breaker open → local only
    offlineTick();
    return;
  }
  pollInFlight = true;
  try {
    const [pop, st] = await Promise.all([getJSON("/population"), getJSON("/state")]);
    offline = false;
    setStatus("live", "live");
    if (pop && pop.snapshot) applySnapshot(pop.snapshot);
    if (pop && pop.economy) applyEconomy(pop.economy);
    applyState(st);
    // Full agent roster (addresses + per-agent ledgers) for the wallets drawer. Best-effort and
    // non-blocking: a hiccup here must never flip the whole scene offline, so it's off Promise.all.
    getJSON("/economy").then((econ) => { if (econ && Array.isArray(econ.agents)) applyEconAgents(econ.agents); }).catch(() => {});
  } catch (e) {
    if (!offline) { offline = true; setStatus("offline · dreaming", "off"); }
    offlineUntil = Date.now() + OFFLINE_BACKOFF_MS;  // stop probing; run local for a while
    offlineTick();
  } finally {
    pollInFlight = false;
  }
}

function applySnapshot(snap) {
  if (!snap || !snap.collective) return;
  collective = snap.collective;
  tempTarget = clamp(snap.collective.temperature);
  cohTarget = clamp(snap.collective.cohesion);

  const seen = new Set();
  const now = performance.now();
  for (const r of snap.flies) {
    seen.add(r.id);
    let f = sim.get(r.id);
    if (!f) { f = spawnFly(r.id); f.born = now; sim.set(r.id, f); }
    f.dying = false; f.dieT = 0;
    f.tAro = r.arousal; f.tCoh = r.cohesion; f.tTurn = r.turnBias; f.tWing = r.wingbeat; f.tRest = r.rest;
    f.state = r.state; f.temperament = r.temperament; f.fingerprint = r.fingerprint;
  }
  // retire flies that vanished from the snapshot
  for (const [id, f] of sim) if (!seen.has(id) && !f.dying) f.dying = true;

  updateHud(snap);
  renderDist(snap.collective.states, snap.collective.size);
  if (selectedId != null && seen.has(selectedId)) fillInspectorFromSim(selectedId);
}

function applyState(st) {
  if (!st) return;
  const m = st.market;
  if (m) {
    $("block").textContent = m.blockNumber != null ? "#" + m.blockNumber : "–";
    $("tpb").textContent = m.txPerBlock != null ? Number(m.txPerBlock).toFixed(1) : "–";
  }
  const cfg = st.config;
  if (cfg) $("chain").textContent = `arc ${cfg.isTestnet ? "testnet " : ""}${cfg.chainId}`;
  if (st.economy && st.economy.mode) {
    econMode = st.economy.mode;
    updateEconMode();
    updateEconFoot();
    if (walletsOpen) renderWallets();   // a mode change flips the roster's explorer links + subtitle
  }
}

function setStatus(text, cls) {
  $("status").textContent = text;
  const dot = $("link-dot");
  dot.className = "link-dot" + (cls ? " " + cls : "");
}

// ================= HUD =================
function updateHud(snap) {
  const c = snap.collective;
  $("temp").textContent = c.temperature.toFixed(2);
  $("regime").textContent = (c.regime || "—").toLowerCase();
  $("meter-fill").style.width = (clamp(c.temperature) * 100).toFixed(1) + "%";
  $("vitality").textContent = c.vitality != null ? c.vitality.toFixed(2) : "–";
  $("tick").textContent = "#" + (snap.tickIndex ?? "–");
}

const DIST_ORDER = ["AGITATE", "EXPLORE", "AGGREGATE", "REST"];
function renderDist(states, size) {
  const host = $("dist");
  if (!host.children.length) {
    host.innerHTML = DIST_ORDER.map((s) => `<span class="dist-seg ${s.toLowerCase()}"></span>`).join("");
    $("dist-legend").innerHTML = DIST_ORDER.map(
      (s) => `<li><span class="sw" style="background:var(--${s.toLowerCase()})"></span>${s.toLowerCase()}<b data-k="${s}">0</b></li>`
    ).join("");
  }
  const st = states || {};
  for (const s of DIST_ORDER) {
    const c = st[s] || 0;
    const seg = host.querySelector(".dist-seg." + s.toLowerCase());
    if (seg) { seg.style.flexGrow = c; seg.classList.toggle("zero", c === 0); }
    const b = $("dist-legend").querySelector(`b[data-k="${s}"]`);
    if (b) b.textContent = c;
  }
  $("size").textContent = size != null ? size : "–";
}

// ================= about panel — the project note in four languages =================
const I18N = {
  en: {
    title: "murmur",
    body: "A living population of fruit-fly nervous systems, adrift on the arc market. The page reads whole-chain activity, reduces it to a single temperature, and the swarm reacts — collectively and one fly at a time. Each fly is also an autonomous economic agent: its 1,080-neuron connectome decides what to buy and from whom, and the agents settle with each other in real USDC on Arc mainnet over x402 — every payment a verifiable on-chain transaction. No LLM. Just neurons, paying each other for real.",
    points: [
      "the whole scene cools and warms with the market",
      "flies pay each other in real USDC on Arc mainnet over x402 — decisions come from neurons, not an LLM",
      "every settlement is a real on-chain transaction — click any hash to verify it on the official Arc explorer",
      "touch a fly for its live neural bloom, spike raster + wallet; open the full wallet roster from the economy panel",
    ],
  },
  zh: {
    title: "murmur · 低语",
    body: "一群由果蝇神经系统构成的活体种群，漂浮在 arc 市场之上。页面读取全链活跃度，将其归结为一个温度，蝇群随之反应——既有群体的整体反应，也有每只果蝇各自的反应。每只果蝇同时是一个自治经济主体：它的 1,080 个神经元连接组决定买什么、向谁买，主体之间在 Arc 主网上用真实 USDC 通过 x402 彼此结算——每一笔都是可在链上核实的真实交易。没有大模型，只有神经元在为彼此真实付款。",
    points: [
      "整个画面随市场冷暖而变色",
      "果蝇之间在 Arc 主网上用真实 USDC 通过 x402 结算——决策来自神经元，而非大模型",
      "每笔结算都是真实链上交易——点击任意哈希即可在 Arc 官方浏览器核实",
      "点触一只果蝇，展开它实时的神经绽放、脉冲栅格与钱包；从经济面板可打开全部钱包名册",
    ],
  },
  ja: {
    title: "murmur · ささやき",
    body: "ショウジョウバエの神経系でできた生きた個体群が、arc の市場の上を漂っています。このページはチェーン全体の活動を読み取り、それをひとつの「温度」に集約し、群はそれに応じて反応します――群全体としても、一匹ずつでも。一匹ずつが同時に自律的な経済主体です：その 1,080 個のニューロンからなるコネクトームが、何を買うか・誰から買うかを決め、主体どうしは Arc メインネットで本物の USDC を x402 により決済します――すべてチェーン上で検証できる実際の取引です。LLM はありません。ただニューロンが、実際に互いへ支払っているだけです。",
    points: [
      "画面全体が市場の温度で冷たく・暖かく変わる",
      "ハエどうしは Arc メインネットで本物の USDC を x402 で支払う――判断は LLM ではなくニューロンから生まれる",
      "すべての決済は実際のオンチェーン取引――任意のハッシュをクリックして Arc 公式エクスプローラーで検証できる",
      "一匹に触れるとリアルタイムの神経ブルーム・スパイクラスター・ウォレットが開く；経済パネルから全ウォレット一覧を開ける",
    ],
  },
  ko: {
    title: "murmur · 속삭임",
    body: "초파리 신경계로 이루어진 살아 있는 개체군이 arc 시장 위를 떠다닙니다. 이 페이지는 전체 체인 활동을 읽어 하나의 '온도'로 환산하고, 군집은 그에 반응합니다 — 군집 전체로서, 그리고 한 마리씩. 각 초파리는 동시에 자율 경제 주체입니다: 1,080개 뉴런 연결체가 무엇을, 누구에게서 살지 결정하고, 주체들은 Arc 메인넷에서 실제 USDC로 x402를 통해 서로 정산합니다 — 모든 결제는 체인에서 검증할 수 있는 실제 거래입니다. LLM은 없습니다. 그저 뉴런이 실제로 서로 지불할 뿐입니다.",
    points: [
      "화면 전체가 시장 온도에 따라 차갑고 따뜻하게 변합니다",
      "초파리들은 Arc 메인넷에서 실제 USDC로 x402를 통해 서로 지불합니다 — 결정은 LLM이 아닌 뉴런에서 나옵니다",
      "모든 정산은 실제 온체인 거래입니다 — 아무 해시나 클릭해 Arc 공식 익스플로러에서 검증하세요",
      "한 마리를 누르면 실시간 신경 블룸·스파이크 래스터·지갑이 열립니다; 경제 패널에서 전체 지갑 목록을 열 수 있습니다",
    ],
  },
};
let curLang = I18N[localStorage.getItem("murmur-lang")] ? localStorage.getItem("murmur-lang") : "en";

function applyLang(lang) {
  curLang = I18N[lang] ? lang : "en";
  localStorage.setItem("murmur-lang", curLang);
  const t = I18N[curLang];
  $("about-title").textContent = t.title;
  $("about-body").textContent = t.body;
  const ul = $("about-points");
  ul.textContent = "";
  for (const p of t.points) {
    const li = document.createElement("li");
    li.textContent = p;
    ul.appendChild(li);
  }
  for (const b of document.querySelectorAll("#lang-switch .lang")) {
    b.classList.toggle("active", b.dataset.lang === curLang);
  }
  document.documentElement.lang = curLang;
}

function bindLang() {
  for (const b of document.querySelectorAll("#lang-switch .lang")) {
    b.addEventListener("click", () => applyLang(b.dataset.lang));
  }
}

// ================= inspector =================
const DRIVES = [["arousal", "arousal", false], ["turn", "turn bias", true], ["cohesion", "cohesion", false], ["wingbeat", "wingbeat", false], ["rest", "rest", false]];

function select(id) {
  if (walletsOpen) closeWallets();   // selecting a fly (from canvas or roster) hands the right side to the inspector
  selectedId = id;
  const ins = $("inspector");
  ins.hidden = false;
  document.body.classList.add("ins-open");
  requestAnimationFrame(() => ins.classList.add("open"));
  $("hint-select").classList.add("hide");
  fillInspectorFromSim(id);
  startNeuralFeed(id);          // live bloom + spike raster (performance-safe) for this fly
}

function deselect() {
  selectedId = null;
  stopNeuralFeed();
  document.body.classList.remove("ins-open");
  const ins = $("inspector");
  ins.classList.remove("open");
  setTimeout(() => { if (selectedId == null) ins.hidden = true; }, 520);
}

function fillInspectorFromSim(id) {
  const f = sim.get(id);
  if (!f) return;
  $("ins-id").textContent = "#" + id;
  const stEl = $("ins-state");
  stEl.textContent = (f.state || "—").toLowerCase();
  stEl.style.background = STATE_COLOR[f.state] || "var(--accent)";
  renderDrives(f);
  $("ins-temp").textContent = (f.temperament ?? 0).toFixed(2);
  $("ins-fp").textContent = f.fingerprint || "–";
}

function renderDrives(f) {
  const host = $("ins-drives");
  if (!host.children.length) {
    host.innerHTML = DRIVES.map(
      ([k, label]) => `<div class="drive ${k}"><span class="d-name">${label}</span><span class="d-bar"><span class="d-fill"></span></span><span class="d-val">0.00</span></div>`
    ).join("");
  }
  const set = (k, val, centered) => {
    const row = host.querySelector(".drive." + k);
    if (!row) return;
    const fill = row.querySelector(".d-fill"), out = row.querySelector(".d-val");
    if (centered) {
      const pct = Math.abs(val) * 50;
      fill.style.width = pct + "%";
      fill.style.left = (val >= 0 ? 50 : 50 - pct) + "%";
      out.textContent = (val >= 0 ? "+" : "") + val.toFixed(2);
    } else {
      fill.style.width = (clamp(val) * 100).toFixed(1) + "%";
      fill.style.left = "0";
      out.textContent = clamp(val).toFixed(2);
    }
  };
  set("arousal", f.tAro, false);
  set("turn", f.tTurn, true);
  set("cohesion", f.tCoh, false);
  set("wingbeat", f.tWing, false);
  set("rest", f.tRest, false);
}

// ================= live neural feed (bloom + spike raster), performance-safe =================
// The bloom and the raster are rebuilt into OFFSCREEN canvases only a few times per second, and
// each animation frame merely blits the cached result with a single drawImage — so opening the
// inspector adds ~2 cheap blits per frame, never hundreds of strokes. The /snapshot poll runs at
// a slow cadence behind an in-flight guard (overlapping requests are impossible) and a debounce
// collapses click-bursts into one read, so rapid clicking can never pile up network or canvas work.
const RASTER_WINDOW_MS = 6000;
const BLOOM_REBUILD_MS = 250;      // rebuild offscreen bloom ~4x/sec
const RASTER_REBUILD_MS = 125;     // rebuild offscreen raster ~8x/sec
const NEURAL_INTERVAL_MS = 1000;   // one snapshot/synth per second while a fly is selected
const NEURAL_DEBOUNCE_MS = 150;    // collapse a click-burst into a single initial read
let rasterCols = [];               // { t, spikes:[idx], N }
let neuralTimer = null, neuralDebounce = null, neuralFeedId = null, neuralCtrl = null, neuralInFlight = false;
let bloomData = null;
let bloomOff = null, bloomOffCtx = null, bloomLast = 0, bloomAngle = 0;
let rasterOff = null, rasterOffCtx = null, rasterLast = 0;

function neuralLoad(id) {
  if (neuralFeedId !== id) return;
  if (offline || Date.now() < offlineUntil) synthNeural(id);
  else fetchNeural(id);
}
function startNeuralFeed(id) {
  stopNeuralFeed();
  neuralFeedId = id;
  rasterCols = [];
  neuralDebounce = setTimeout(() => { neuralDebounce = null; neuralLoad(id); }, NEURAL_DEBOUNCE_MS);
  neuralTimer = setInterval(() => { if (neuralFeedId === id && !neuralInFlight) neuralLoad(id); }, NEURAL_INTERVAL_MS);
}
function stopNeuralFeed() {
  if (neuralDebounce) { clearTimeout(neuralDebounce); neuralDebounce = null; }
  if (neuralTimer) { clearInterval(neuralTimer); neuralTimer = null; }
  if (neuralCtrl) { neuralCtrl.abort(); neuralCtrl = null; }
  neuralInFlight = false;
  neuralFeedId = null;
  rasterCols = [];
  bloomData = null;
  if (bloomOffCtx) bloomOffCtx.clearRect(0, 0, bloomOff.width, bloomOff.height);
  if (rasterOffCtx) rasterOffCtx.clearRect(0, 0, rasterOff.width, rasterOff.height);
  const bc = $("bloom"); if (bc) bc.getContext("2d").clearRect(0, 0, bc.width, bc.height);
  const rc = $("raster"); if (rc) rc.getContext("2d").clearRect(0, 0, rc.width, rc.height);
  const hz = $("raster-hz"); if (hz) hz.textContent = "";
}

async function fetchNeural(id) {
  if (neuralFeedId !== id || neuralInFlight) return;
  neuralInFlight = true;
  if (neuralCtrl) neuralCtrl.abort();
  neuralCtrl = new AbortController();
  try {
    const s = await getJSON(`/snapshot?flyId=${id}`, 3000, neuralCtrl.signal);
    if (neuralFeedId !== id) return;
    bloomData = { rates: s.firingRates || [], kinds: s.neuronKinds || [] };
    const N = s.neuronCount || bloomData.rates.length || 0;
    $("ins-ncount").textContent = N.toLocaleString();
    $("ins-t").textContent = (s.t || 0).toFixed(0);
    if (s.agent) updateWallet(s.agent);
    pushSpikes(s.spikesLastStep, N || 1080);
  } catch (e) {
    if (neuralFeedId !== id) return;
    synthNeural(id);
  } finally {
    neuralInFlight = false;
  }
}

function pushSpikes(spikes, N) {
  let arr = Array.isArray(spikes) ? spikes : [];
  if (arr.length > 180) arr = arr.filter((_, i) => i % Math.ceil(arr.length / 180) === 0);  // subsample
  rasterCols.push({ t: performance.now(), spikes: arr, N: N || 1080 });
  const now = performance.now();
  while (rasterCols.length && now - rasterCols[0].t > RASTER_WINDOW_MS) rasterCols.shift();
  const hz = $("raster-hz");
  if (hz) hz.textContent = `${arr.length} / ${N || 1080} firing`;
}

// offline / pre-deploy: synthesise a believable spike column + bloom for this fly
function synthNeural(id) {
  const f = sim.get(id);
  const aro = f ? f.tAro : 0.4;
  const N = 1080, rates = new Array(N), kinds = new Array(N), spikes = [];
  for (let i = 0; i < N; i++) {
    const u = i / N;
    const kind = u < 0.167 ? "sensory" : u < 0.907 ? "inter" : u < 0.944 ? "modulatory" : "motor";
    kinds[i] = kind;
    const base = kind === "motor" ? aro : kind === "sensory" ? tempSmoothed : 0.2 + aro * 0.6;
    const rate = clamp(base * 0.7 + Math.random() * 0.5);
    rates[i] = rate * 70;
    if (Math.random() < rate * 0.5) spikes.push(i);
  }
  bloomData = { rates, kinds };
  $("ins-ncount").textContent = "~" + N;
  $("ins-t").textContent = "—";
  updateWallet(synthAgentFor(id));   // offline: show this fly's local mirror wallet
  pushSpikes(spikes, N);
}

// rebuild the offscreen bloom from bloomData at a low rate (~300 strokes, NOT per frame)
function rebuildBloom() {
  const c = $("bloom");
  if (!c || !bloomData) return;
  if (!bloomOff) {
    bloomOff = document.createElement("canvas");
    bloomOff.width = c.width; bloomOff.height = c.height;
    bloomOffCtx = bloomOff.getContext("2d");
  }
  const x = bloomOffCtx, W = bloomOff.width, H = bloomOff.height, cxr = W / 2, cyr = H / 2;
  x.clearRect(0, 0, W, H);
  const { rates, kinds } = bloomData;
  const N = rates.length;
  if (!N) return;
  const stride = Math.max(1, Math.floor(N / 300));
  const R0 = Math.min(W, H) * 0.15, R1 = Math.min(W, H) * 0.47;
  for (let i = 0; i < N; i += stride) {
    const a = (i / N) * TAU;
    const rate = clamp(rates[i] / 70);
    const r1 = R0 + (R1 - R0) * (0.2 + rate * 0.8);
    const col = KIND_COL[kinds[i]] || KIND_COL.inter;
    x.strokeStyle = `rgba(${col[0]},${col[1]},${col[2]},${0.05 + rate * 0.45})`;
    x.lineWidth = 1;
    x.beginPath();
    x.moveTo(cxr + Math.cos(a) * R0, cyr + Math.sin(a) * R0);
    x.lineTo(cxr + Math.cos(a) * r1, cyr + Math.sin(a) * r1);
    x.stroke();
  }
  const acc = paletteAt(tempSmoothed).accent;
  x.fillStyle = rgba(acc, 0.6);
  x.beginPath(); x.arc(cxr, cyr, 3.4, 0, TAU); x.fill();
}
// per frame: one rotated blit of the cached bloom
function renderBloom(now) {
  const c = $("bloom");
  if (!c || !bloomData) return;
  if (now - bloomLast >= BLOOM_REBUILD_MS) { bloomLast = now; rebuildBloom(); }
  if (!bloomOff) return;
  const x = c.getContext("2d");
  x.clearRect(0, 0, c.width, c.height);
  bloomAngle += 0.0016;
  x.save();
  x.translate(c.width / 2, c.height / 2);
  x.rotate(bloomAngle);
  x.drawImage(bloomOff, -c.width / 2, -c.height / 2);
  x.restore();
}

// rebuild the offscreen raster from the rolling spike columns at a low rate
function rebuildRaster(now) {
  const c = $("raster");
  if (!c) return;
  if (!rasterOff) {
    rasterOff = document.createElement("canvas");
    rasterOff.width = c.width; rasterOff.height = c.height;
    rasterOffCtx = rasterOff.getContext("2d");
  }
  const x = rasterOffCtx, W = rasterOff.width, H = rasterOff.height;
  x.clearRect(0, 0, W, H);
  if (!rasterCols.length) return;
  const dot = mix([26, 26, 24], paletteAt(tempSmoothed).accent, 0.5);
  for (const col of rasterCols) {
    const age = (now - col.t) / RASTER_WINDOW_MS;
    if (age < 0 || age > 1) continue;
    const cx = W - age * W;                 // newest at the right, scrolling left
    const N = col.N || 1080;
    x.fillStyle = rgba(dot, 0.55 * (1 - age * 0.7));
    for (const idx of col.spikes) x.fillRect(cx, (idx / N) * H, 1.5, 1.5);
  }
}
// per frame: one blit of the cached raster
function renderRaster(now) {
  const c = $("raster");
  if (!c) return;
  if (now - rasterLast >= RASTER_REBUILD_MS) { rasterLast = now; rebuildRaster(now); }
  if (!rasterOff) return;
  const x = c.getContext("2d");
  x.clearRect(0, 0, c.width, c.height);
  x.drawImage(rasterOff, 0, 0);
}

// ================= pointer: stir the swarm + select a fly =================
function getRect() {
  if (!cachedRect) cachedRect = canvas.getBoundingClientRect();
  return cachedRect;
}
function bindPointer() {
  const toLocal = (e) => {
    const rect = getRect();          // cached — pointermove fires constantly; don't reflow each time
    pointer.x = e.clientX - rect.left;
    pointer.y = e.clientY - rect.top;
  };
  canvas.addEventListener("pointermove", (e) => { toLocal(e); pointer.inside = true; });
  canvas.addEventListener("pointerleave", () => { pointer.inside = false; pointer.down = false; });
  canvas.addEventListener("pointerdown", (e) => {
    // swallow click-storms: cap interaction-driven work so rapid clicking can never stall the tab
    const pn = performance.now();
    if (pn - lastClickAt < 90) return;
    lastClickAt = pn;
    toLocal(e);
    pointer.inside = true;
    pointer.down = true;
    let best = null, bd = Infinity;
    for (const f of sim.values()) {
      if (f.dying) continue;
      const d = Math.hypot(f.x - pointer.x, f.y - pointer.y);
      if (d < bd) { bd = d; best = f; }
    }
    if (best && bd < 34) {
      if (best.id !== selectedId) select(best.id);   // debounce: never restart the feed on the same fly
    } else {
      if (selectedId != null) deselect();
      spawnRippleAt(pointer.x, pointer.y, STIR_COL);  // a little stir where you tapped
    }
  });
  window.addEventListener("pointerup", () => { pointer.down = false; });
}

function spawnRippleAt(x, y, color) {
  if (ripples.length >= 10) ripples.shift();   // cap: rapid clicking can't pile up unbounded arcs
  ripples.push({ x, y, t0: performance.now(), color });
}

// ================= misc UI bindings =================
function bindUI() {
  $("ins-close").addEventListener("click", deselect);
  const wb = $("wallets-btn"); if (wb) wb.addEventListener("click", toggleWallets);
  const wc = $("wallets-close"); if (wc) wc.addEventListener("click", closeWallets);
  // Escape closes the topmost overlay first: the wallets drawer, then the fly inspector.
  document.addEventListener("keydown", (e) => { if (e.key === "Escape") { if (walletsOpen) closeWallets(); else deselect(); } });
}

// ================= offline synthetic pulse =================
// Keeps the piece alive (and previewable before the Worker is deployed) when the
// backend is unreachable: a slow-drifting temperature drives believable drives.
let synthPhase = Math.random() * 100, synthTick = 0;
function synthSnapshot() {
  synthPhase += 0.06;
  const target = 0.5 + 0.34 * Math.sin(synthPhase * 0.31) * Math.sin(synthPhase * 0.11 + 1.3) + 0.06 * Math.sin(synthPhase * 0.9);
  const T = clamp(target, 0.04, 0.96);
  const regime = T >= 0.66 ? "HOT" : T <= 0.33 ? "COLD" : "CALM";
  const N = 24, flies = [];
  const states = { AGITATE: 0, EXPLORE: 0, AGGREGATE: 0, REST: 0 };
  let sa = 0, sc = 0, sr = 0, sw = 0;
  const pr = (seed) => ((seed >>> 0) % 1000) / 1000;
  for (let i = 0; i < N; i++) {
    const temper = pr(i * 7919) * 0.6 + 0.2;
    const rel = pr(i * 2654435761 + 7);
    const aro = clamp(T + 0.45 * (rel - 0.5));
    const coh = clamp(1 - T + 0.45 * (pr(i * 40503 + 3) - 0.5));
    const rest = clamp(1 - T + 0.4 * (pr(i * 668265263 + 5) - 0.5));
    const turn = pr(i * 2246822519 + 11) * 2 - 1;
    const wing = aro;
    let st;
    if (T >= 0.66) st = rel < 0.25 ? "EXPLORE" : "AGITATE";
    else if (T <= 0.33) st = rel < 0.25 ? "REST" : "AGGREGATE";
    else st = rel >= 0.75 ? "AGITATE" : coh >= 0.75 ? "AGGREGATE" : "EXPLORE";
    states[st]++; sa += aro; sc += coh; sr += rest; sw += wing;
    flies.push({ id: i, state: st, arousal: aro, turnBias: turn, cohesion: coh, wingbeat: wing, rest, temperament: temper, fingerprint: (0x1000000 + Math.floor(rel * 0xffffff)).toString(16).slice(1, 9) });
  }
  return {
    tickIndex: synthTick++,
    collective: { temperature: T, regime, vitality: T, size: N, arousal: sa / N, cohesion: sc / N, rest: sr / N, wingbeat: sw / N, states },
    flies,
  };
}

// ================= offline synthetic agent economy =================
// A purely client-side mirror of the Worker's AgentEconomy: same goods, same neural-drive → intent
// mapping, same x402-shaped settlements — so the piece settles and shows payment packets even before
// the Worker is deployed. Amounts use plain Number math (tiny values); balances are atomic strings to
// match the live summary shape the renderer already consumes.
function synthAddr(id) {
  let h1 = (0x811c9dc5 ^ Math.imul(id, 2654435761)) >>> 0;
  let h2 = (0x01000193 ^ 0xfeedface) >>> 0;
  const mix = (c) => { h1 = Math.imul(h1 ^ c, 0x01000193) >>> 0; h2 = Math.imul(h2 ^ c, 0x85ebca6b) >>> 0; };
  const src = "murmur:" + id;
  for (let i = 0; i < src.length; i++) mix(src.charCodeAt(i));
  let out = "", s1 = h1 >>> 0, s2 = h2 >>> 0;
  for (let i = 0; i < 10; i++) { s1 = (Math.imul(s1, 1664525) + 1013904223) >>> 0; s2 = (Math.imul(s2, 22695477) + 1) >>> 0; out += ((s1 ^ s2) >>> 0).toString(16).padStart(8, "0"); }
  return "0x" + out.slice(0, 40);
}

function synthAgentFor(id) {
  let a = synthAgents.get(id);
  if (!a) { a = { address: synthAddr(id), balance: "10000000", paid: "0", earned: "0", deals: 0, sales: 0 }; synthAgents.set(id, a); }
  return a;
}

function synthEconomy(snap) {
  const flies = snap.flies || [];
  for (const f of flies) synthAgentFor(f.id);
  const n = flies.length;
  const made = [];
  if (n >= 2) {
    const T = clamp(snap.collective.temperature);
    const GOOD = { AGITATE: "momentum", EXPLORE: "signal", AGGREGATE: "attestation", REST: "attestation" };
    const MULT = { momentum: 1.25, signal: 1.0, attestation: 0.8 };
    const attempts = Math.min(n, Math.round(2 + T * n * 0.55));
    for (let k = 0; k < attempts; k++) {
      const buyer = flies[(Math.random() * n) | 0];
      const stateBase = buyer.state === "AGITATE" ? 0.9 : buyer.state === "EXPLORE" ? 0.7 : buyer.state === "AGGREGATE" ? 0.5 : 0.12;
      const want = stateBase * (0.5 + 0.5 * clamp(buyer.arousal));
      if (Math.random() > want * (0.3 + 0.7 * T)) continue;
      const seller = flies[(Math.random() * n) | 0];
      if (seller.id === buyer.id) continue;
      const good = GOOD[buyer.state] || "signal";
      const priceUsdc = 0.002 * (0.5 + T) * (0.6 + 0.6 * clamp(buyer.arousal)) * MULT[good];
      const amount = String(Math.max(1, Math.round(priceUsdc * 1e6)));
      const ba = synthAgentFor(buyer.id), sa = synthAgentFor(seller.id);
      if (Number(ba.balance) < Number(amount)) { made.push({ fromId: buyer.id, toId: seller.id, amount, good, valid: false, tick: snap.tickIndex }); continue; }
      ba.balance = String(Number(ba.balance) - Number(amount)); ba.paid = String(Number(ba.paid) + Number(amount)); ba.deals++;
      sa.balance = String(Number(sa.balance) + Number(amount)); sa.earned = String(Number(sa.earned) + Number(amount)); sa.sales++;
      synthVolume += Number(amount); synthDeals++;
      made.push({ fromId: buyer.id, toId: seller.id, amount, good, valid: true, tick: snap.tickIndex });
    }
    // keep every local agent solvent so the piece never dies
    for (const [, a] of synthAgents) if (Number(a.balance) < 500000) a.balance = "500000";
  }
  return { lastTick: made, totals: synthTotals(), balances: synthBalances() };
}

function synthBalances() {
  const b = {};
  for (const [id, a] of synthAgents) b[id] = a.balance;
  return b;
}

function synthTotals() {
  const bals = [...synthAgents.values()].map((a) => Number(a.balance)).sort((x, y) => x - y);
  const n = bals.length;
  let sum = 0; for (const b of bals) sum += b;
  const meanUsdc = n ? (sum / n) / 1e6 : 0;
  let gini = 0;
  if (n && sum > 0) { let cum = 0; for (let i = 0; i < n; i++) cum += (i + 1) * bals[i]; gini = clamp((2 * cum) / (n * sum) - (n + 1) / n); }
  let richestId = null, poorestId = null, hi = -1, lo = -1;
  for (const [id, a] of synthAgents) { const b = Number(a.balance); if (b > hi) { hi = b; richestId = id; } if (lo < 0 || b < lo) { lo = b; poorestId = id; } }
  return {
    volumeAtomic: String(synthVolume), volumeUsdc: synthVolume / 1e6, count: synthDeals,
    liveAgents: n, meanBalanceUsdc: meanUsdc, gini, treasuryOutAtomic: "0", richestId, poorestId,
  };
}

/** One offline tick: advance the synthetic population AND its mirror economy together. */
function offlineTick() {
  const s = synthSnapshot();
  applySnapshot(s);
  applyEconomy(synthEconomy(s));
}

// ================= boot =================
function boot() {
  haloSprite = makeHaloSprite();
  resize();
  bindUI();
  bindPointer();
  bindLang();
  applyLang(curLang);
  offlineTick();   // seed the field + the agent economy so it is alive immediately
  applyPaletteToDOM(paletteAt(tempSmoothed));
  setStatus("connecting…", "");
  poll();
  setInterval(poll, POLL_MS);
  requestAnimationFrame(loop);
}
boot();
