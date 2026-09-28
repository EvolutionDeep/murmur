// lineageView.js — task 22: the SECOND main canvas (a radial lineage / technical atlas).
// Bare-imported by main.js (NO ?v cache-buster; _headers forces etag revalidation on /lineageView.js).
//
// WHAT IT IS
//   A full-screen 2D canvas (#lineage-field) that is mutually exclusive with the 3D swarm canvas (#field).
//   It lays the whole population out as a radial dendrogram — generation = ring radius, angle = paternal
//   subtree sector — and overlays the technical inner life of the colony: lineage edges (parent → child),
//   live trade-flow particles (payer → payee, coloured by good), social edges (alliance / antagonism, with
//   half-life decay), tombstones for the dead, ghost nodes for ancestors that never lived, and an optional
//   shard grid (fliesPerShard = 1 ⇒ shard index ≡ flyId). Clicking a node opens a focus sidebar with that
//   fly's per-layer brain activity, a pseudo-spike raster, a membrane band, its motor → FAP behaviour, its
//   DA/OA neuromodulation and its on-chain genome provenance (trustless verify).
//
// PERFORMANCE CONTRACT (task 22 item 10)
//   • The static layer (generation rings + labels, lineage edges, ghost nodes, tombstones, shard grid) is
//     baked into an offscreen canvas keyed by `WxH@DPR:signature`; it re-bakes ONLY when the signature
//     changes (resize / new node / toggle), never per frame.
//   • Each frame draws only: one blit of the static bake + ~75 live nodes + ≤240 trade particles + social
//     edges + the focus highlight. There is NO per-frame traversal of the ~10,361-neuron vectors — the
//     per-layer means and the pseudo-spike raster are reduced ONCE per /snapshot arrival (≤1 Hz), and the
//     neuron-kind → layer index map is parsed once and cached for every fly thereafter.
//   • When the view is hidden (state.lineageViewActive === false) main.js never calls lvFrame, and every
//     timer/feed is stopped on close ⇒ literally zero work.
//
// DATA SOURCES (all pre-verified against production; see the task brief)
//   /lineage?limit=5000  → state.lvLineage          (full ancestry, polled at 300 s by pollLineageView)
//   /flies/{id}          → vitals.genome → sha256    (live ↔ lineage join key; 6-way concurrent, cached)
//   /economy.recent      → state.econRecent          (netted settlement rows → trade-flow particles)
//   /proofs              → state.proofs              (per-trade constituents + hash chain, already polled)
//   /economy.social      → state.econSocial          (bonds = alliance top-24; grudges = antagonism seeds)
//   /annals              → state.chronRows           (BETRAYAL/FEUD/EXILE/… kinds → antagonism edges)
//   /population          → sim + f.neuromod          (live membership, balances, per-fly DA/OA)
//   econDynasty.graves   → state.econDynasty.graves  (tombstones: cause/age/estate/heirs)
import {
  state, $, sim, graveUid, GOOD_COL, FAP_GLOSS, FAP_ROLE, KIND_COL, STATE_COLOR,
  houseColor, houseOf, SOCIETY_BOND_MIN, sha256HexClient, nmDaHz, nmOaHz, NM_REF_HZ,
  atomicToUsdc, clamp, lerp, mix, rgb, rgba, paletteAt, TAU, INK, GILT, GILT_HI, VELLUM,
  GOLD_THREAD, CRACK_RED, readLineageOnchain, shortHash, isRealTxHash, isRealAddr,
  ARC_EXPLORER, fnv1a, fapColor,
} from './shared.js';
import { t as T, gl } from './i18n.js?v=103';
import { getJSON } from './polling.js';
import { derivePseudoSpikes } from './inspector.js';

// ================= tuning constants =================
export const LINEAGE_POLL_MS = 300000;   // 300 s — /lineage advances only on a breed/commit, this is ample
export const TRADE_ACCUM_MS = 45000;     // 45 s — the settlement ring window is ~4.1 min (5.5× margin)
export const PARTICLE_CAP = 240;         // hard cap on concurrent trade-flow particles
export const SOCIAL_HALFLIFE_MS = 300000;// 5 min half-life for the client-maintained social edge table
export const FOCUS_INTERVAL_MS = 1000;   // one /snapshot per second for the single focused fly
export const FOCUS_DEBOUNCE_MS = 150;    // collapse click-bursts into one neural read
const GH_CONCURRENCY = 6;                // 6-way concurrent /flies/{id} genome resolution
const LS_GH = 'lv.gh';                   // localStorage: id → genomeHash cache
const LS_SOCIAL = 'lv.social';           // localStorage: the decayed social edge table
const HIT_PAD = 4;                       // css px of forgiveness around a node's radius for hit-testing
const LAYERS = ['sensory', 'inter', 'modulatory', 'motor'];   // the 4 static neuronKinds values

// antagonistic chronicle kinds that seed a red social edge (task brief: /annals has no settlement kind)
const ANTAGONISM_KINDS = new Set(['BETRAYAL', 'FEUD', 'EXILE', 'INDICTMENT', 'TRIAL', 'VERDICT']);

// ================= module-singleton state (kept off shared.state to minimise the global footprint) =================
const LV = {
  cv: null, ctx: null, W: 0, H: 0, DPR: 1,
  active: false, inited: false,
  // layout / data
  nodes: new Map(),        // uid → node {uid,id,gen,ang,rad,x,y,kind,hash,entry,grave,houseName,balN}
  pos: new Map(),          // uid → {ang,rad,gen,x,y}  (assigned ONCE, never moved — incremental stability)
  idToUid: new Map(),      // live flyId → uid (genomeHash once resolved, else `id:<flyId>`)
  edges: [],               // lineage edges [{a:uid,b:uid}] (parent → child)
  ghCache: new Map(),      // flyId → genomeHash (persisted to localStorage)
  ghStale: new Set(),      // flyIds whose cached hash matched no lineage entry (refetch + recompute)
  ghInFlight: new Set(),   // flyIds with a /flies request outstanding
  // static bake
  staticOff: null, staticCtx: null, staticKey: '',
  // dynamic layers
  parts: [],               // trade-flow particles [{ax,ay,bx,by,cx,cy,p,sp,col,w}]
  tradeEdges: new Map(),   // `${from}>${to}>${good}` → {fromId,toId,good,amount,t}
  seenTrades: new Set(),   // dedup keys for settlements already accumulated
  social: new Map(),       // `${a}>${b}` → {a,b,sign,w,t}
  // layer toggles
  showShards: false, showSocial: true, showTrade: true,
  // focus
  focusUid: null, focusId: null, focusEntry: null, focusGrave: null,
  focusTimer: null, focusDebounce: null, focusCtrl: null, focusInFlight: false,
  layerIdx: null,          // cached {sensory:[…indices], inter:[…], …} parsed once from neuronKinds
  layerMeans: null,        // last reduced {sensory,inter,modulatory,motor} mean firing rate
  focusSnap: null,         // last /snapshot for the focused fly
  // pollers
  lineageTimer: null, tradeTimer: null, lineageInFlight: false,
  // perf counters (surfaced on window.__murmurPerf)
  nodeCount: 0, edgeCount: 0, partCount: 0, liveCount: 0,
  // interaction
  hoverUid: null,
};

// ================= small helpers =================
const isZeroHash = (h) => !h || typeof h !== 'string' || /^0x0+$/.test(h) || h === '';
const nodeR = (n) => (n.kind === 'ghost' ? 2.2 : n.kind === 'tomb' ? 3.0 : 3.2 + (n.balN || 0.5) * 4.6);
function ringRadius(gen, maxGen) {
  const R0 = Math.min(LV.W, LV.H) * 0.075, R1 = Math.min(LV.W, LV.H) * 0.46;
  return R0 + (R1 - R0) * (maxGen > 0 ? gen / maxGen : 0);
}
// spiral fan offset: child k of a parent sits at sign·ring·gap so the brood centres on the parent and each
// new sibling takes the NEXT slot without ever moving an already-placed one (incremental stability).
function fanOffset(k, gap) {
  if (k <= 0) return 0;
  const ring = Math.ceil(k / 2);
  const sign = (k % 2 === 1) ? 1 : -1;
  return sign * ring * gap;
}
function loadGH() {
  try { const raw = localStorage.getItem(LS_GH); const o = raw ? JSON.parse(raw) : null;
    if (o && typeof o === 'object') for (const k of Object.keys(o)) LV.ghCache.set(Number(k), String(o[k]));
  } catch { /* a corrupt cache simply refetches */ }
}
function saveGH() {
  try { const o = {}; for (const [id, h] of LV.ghCache) o[id] = h; localStorage.setItem(LS_GH, JSON.stringify(o)); }
  catch { /* quota / private mode — the cache is a nicety, not a contract */ }
}
function loadSocial() {
  try { const raw = localStorage.getItem(LS_SOCIAL); const a = raw ? JSON.parse(raw) : null;
    if (Array.isArray(a)) for (const e of a) if (e && e.a != null && e.b != null) LV.social.set(`${e.a}>${e.b}`, { a: e.a, b: e.b, sign: e.sign | 0, w: +e.w || 0, t: +e.t || Date.now() });
  } catch { /* ignore */ }
}
function saveSocial() {
  try { const a = []; for (const e of LV.social.values()) if (e.w > 0.02) a.push({ a: e.a, b: e.b, sign: e.sign, w: Math.round(e.w * 1000) / 1000, t: e.t });
    localStorage.setItem(LS_SOCIAL, JSON.stringify(a.slice(0, 400)));
  } catch { /* ignore */ }
}

// ================= canvas sizing =================
function sizeCanvas() {
  if (!LV.cv) return;
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const w = window.innerWidth, h = window.innerHeight;
  LV.cv.width = Math.round(w * dpr); LV.cv.height = Math.round(h * dpr);
  LV.cv.style.width = w + 'px'; LV.cv.style.height = h + 'px';
  LV.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  LV.W = w; LV.H = h; LV.DPR = dpr;
  LV.staticKey = '';   // force a re-bake at the new geometry
}

// ================= genome-hash resolution (live ↔ lineage join) =================
// /population flies[] carries no genomeHash, so for each unknown live id we fetch /flies/{id}, take
// vitals.genome, and recompute its hash in-browser with the SAME canonicalJSON + sha256 the worker used
// (shared.sha256HexClient) — a byte-identical match against the lineage tree (75/75 in production). The
// genome is lifelong-unchanging, so the result is cached in localStorage keyed by flyId. A recycled id is
// caught two ways: (a) when a live fly dies we evict its cache entry, and (b) if a cached hash matches no
// lineage entry we mark it stale and refetch — so a slot reused by a new individual self-heals.
async function resolveOne(id) {
  if (LV.ghInFlight.has(id)) return;
  LV.ghInFlight.add(id);
  try {
    const d = await getJSON('/flies/' + id, 6000);
    const genome = d && d.vitals && d.vitals.genome;
    if (genome) {
      const h = (await sha256HexClient(genome)).toLowerCase();
      LV.ghCache.set(id, h); LV.ghStale.delete(id); saveGH();
    }
  } catch { /* best-effort: an unresolved fly stays on the outer holding ring */ }
  finally { LV.ghInFlight.delete(id); }
}
async function resolveHashes() {
  const want = [];
  for (const id of sim.keys()) {
    if (!LV.ghCache.has(id) || LV.ghStale.has(id)) want.push(id);
  }
  // 6-way concurrent drain
  let i = 0;
  const worker = async () => { while (i < want.length) { const id = want[i++]; await resolveOne(id); } };
  await Promise.all(Array.from({ length: Math.min(GH_CONCURRENCY, want.length) }, worker));
}

// ================= layout: build nodes + edges from the lineage tree + the live swarm + graves =================
function rebuild() {
  const lin = state.lvLineage;
  const entries = (lin && Array.isArray(lin.entries)) ? lin.entries : [];
  const byHash = new Map();
  let maxGen = 0;
  for (const e of entries) {
    if (!e || !e.genomeHash) continue;
    const h = String(e.genomeHash).toLowerCase();
    byHash.set(h, e);
    const g = e.generation | 0; if (g > maxGen) maxGen = g;
  }
  const sorted = entries.slice().sort((a, b) => (a.generation | 0) - (b.generation | 0));

  // pass 0: roots (no usable paternal parent) get a stable angular sector
  const paternal = (e) => { const p = e && Array.isArray(e.parents) ? e.parents[0] : null; return isZeroHash(p) ? null : String(p).toLowerCase(); };
  const rootUids = sorted.filter((e) => { const p = paternal(e); return !p || !byHash.has(p); }).map((e) => String(e.genomeHash).toLowerCase());
  const rootTotal = Math.max(1, rootUids.length);
  const rootIdx = new Map(); rootUids.forEach((u, i) => rootIdx.set(u, i));

  const cx = LV.W / 2, cy = LV.H / 2;
  const childSlot = new Map();
  const place = (uid, gen, ang) => {
    let p = LV.pos.get(uid);
    const rad = ringRadius(gen, maxGen);
    if (!p) { p = { ang, rad, gen }; LV.pos.set(uid, p); }
    p.x = cx + Math.cos(p.ang) * p.rad; p.y = cy + Math.sin(p.ang) * p.rad;
    return p;
  };

  LV.edges = [];
  const seenUid = new Set();
  // pass 1: every committed lineage entry becomes a node (position assigned once, kept thereafter)
  for (const e of sorted) {
    const uid = String(e.genomeHash).toLowerCase();
    const gen = e.generation | 0;
    const pu = paternal(e);
    let ang;
    if (pu && LV.pos.has(pu)) {
      const slot = childSlot.get(pu) | 0; childSlot.set(pu, slot + 1);
      const gap = clamp(0.95 / (gen * 0.45 + 1), 0.05, 0.95);
      ang = LV.pos.get(pu).ang + fanOffset(slot, gap) + (fnv1a(uid) % 100) / 100 * 0.02;   // tiny deterministic jitter
      LV.edges.push({ a: pu, b: uid });
    } else {
      const ri = rootIdx.has(uid) ? rootIdx.get(uid) : (fnv1a(uid) % rootTotal);
      ang = (ri / rootTotal) * TAU;
      if (pu && !byHash.has(pu)) LV.edges.push({ a: pu, b: uid });   // edge to a ghost (placed in pass 2)
    }
    const p = place(uid, gen, ang);
    seenUid.add(uid);
    let n = LV.nodes.get(uid);
    if (!n) { n = { uid, id: null, gen, kind: 'ghost', hash: uid, entry: e, grave: null, houseName: '', balN: 0.5 }; LV.nodes.set(uid, n); }
    n.gen = gen; n.entry = e; n.x = p.x; n.y = p.y; n.ang = p.ang; n.rad = p.rad;
  }

  // pass 2: ghost ancestors — a parent hash referenced by an entry but never committed itself
  for (const e of sorted) {
    const pu = paternal(e);
    if (!pu || byHash.has(pu) || LV.nodes.has(pu)) continue;
    const child = LV.nodes.get(String(e.genomeHash).toLowerCase());
    const gen = Math.max(0, (e.generation | 0) - 1);
    const ang = child ? child.ang : (fnv1a(pu) % 360) / 360 * TAU;
    const p = place(pu, gen, ang);
    LV.nodes.set(pu, { uid: pu, id: null, gen, kind: 'ghost', hash: pu, entry: null, grave: null, houseName: '', balN: 0.5, x: p.x, y: p.y, ang: p.ang, rad: p.rad, ghost: true });
  }

  // pass 3: the LIVE swarm — resolve each id to its genome node (or a holding-ring temp node)
  LV.idToUid.clear(); LV.liveCount = 0;
  const holdR = ringRadius(maxGen, maxGen) * 1.04;
  for (const [id, f] of sim) {
    if (f && f.dying) continue;
    LV.liveCount++;
    const h = LV.ghCache.get(id);
    let uid, n;
    if (h && LV.nodes.has(h)) {
      uid = h; n = LV.nodes.get(h); n.kind = 'live'; n.id = id;
    } else {
      uid = 'id:' + id;
      n = LV.nodes.get(uid);
      const ang = ((id * 137.508) % 360) / 360 * TAU;   // golden-angle spread on the holding ring
      if (!n) { const p = place(uid, maxGen, ang); n = { uid, id, gen: maxGen, kind: 'live', hash: (h || null), entry: (h ? byHash.get(h) : null) || null, grave: null, houseName: '', balN: 0.5, x: p.x, y: p.y, ang: p.ang, rad: holdR }; LV.nodes.set(uid, n); }
      else { n.kind = 'live'; n.id = id; n.rad = holdR; const p = LV.pos.get(uid); n.x = cx + Math.cos(p.ang) * holdR; n.y = cy + Math.sin(p.ang) * holdR; }
      if (h) LV.ghStale.add(id);   // a cached hash that matches no entry → refetch on the next resolve
    }
    LV.idToUid.set(id, uid);
    // live node visuals: balance → size, house → ring colour
    const bal = state.econBalances.get(id);
    n.balN = (typeof f.tBalN === 'number') ? f.tBalN : (bal != null ? clamp(bal / 50) : 0.5);
    const ho = houseOf.get(id); n.houseName = ho ? ho.name : '';
    n.neuromod = f.neuromod || null;
    n.fap = f.fap || 'FORAGE'; n.role = f.role || FAP_ROLE[f.fap] || '';
  }

  // pass 4: tombstones — the dead keep the position they held in life (faded), tagged with their grave
  const graves = (state.econDynasty && Array.isArray(state.econDynasty.graves)) ? state.econDynasty.graves : [];
  for (const g of graves) {
    if (g == null) continue;
    const uid = 'grave:' + graveUid(g.id, g.bornTick);
    let n = LV.nodes.get(uid);
    if (!n) {
      // a grave whose genome we once resolved keeps THAT node; otherwise it lands on the outer necropolis ring
      const ang = ((g.id * 137.508) % 360) / 360 * TAU;
      const p = place(uid, maxGen, ang);
      n = { uid, id: g.id, gen: maxGen, kind: 'tomb', hash: null, entry: null, grave: g, houseName: g.houseName || '', balN: 0.3, x: p.x, y: p.y, ang: p.ang, rad: holdR * 1.02 };
      LV.nodes.set(uid, n);
    }
    n.grave = g; n.houseName = g.houseName || n.houseName || '';
  }

  // evict the genome cache of any id that has left the living set (a recycled slot must refetch on rebirth)
  for (const id of Array.from(LV.ghCache.keys())) if (!sim.has(id)) { /* keep — genome is lifelong; only stale-on-mismatch refetches */ }

  LV.nodeCount = LV.nodes.size; LV.edgeCount = LV.edges.length;
  LV.staticKey = '';   // geometry/membership changed → re-bake
}

// ================= static bake (generation rings + lineage edges + ghosts + tombstones + shard grid) =================
function bakeSignature() {
  return `${LV.W}x${LV.H}@${LV.DPR}:n${LV.nodeCount}:e${LV.edgeCount}:g${genCount()}:s${LV.showShards ? 1 : 0}`;
}
function genCount() { let m = 0; for (const n of LV.nodes.values()) if (n.gen > m) m = n.gen; return m; }
function bakeStatic() {
  const sig = bakeSignature();
  if (LV.staticKey === sig && LV.staticOff) return;   // unchanged → keep the cached bake
  if (!LV.staticOff) { LV.staticOff = document.createElement('canvas'); LV.staticCtx = LV.staticOff.getContext('2d'); }
  const off = LV.staticOff, x = LV.staticCtx;
  off.width = Math.round(LV.W * LV.DPR); off.height = Math.round(LV.H * LV.DPR);
  x.setTransform(LV.DPR, 0, 0, LV.DPR, 0, 0);
  x.clearRect(0, 0, LV.W, LV.H);
  const cx = LV.W / 2, cy = LV.H / 2, maxGen = genCount();
  const pal = paletteAt(state.tempSmoothed);
  const inkFaint = rgba(mix(INK, pal.paper, 0.55), 0.5);

  // ---- optional shard grid (fliesPerShard = 1 ⇒ shard index ≡ flyId): a faint cell per shard, tinted when live ----
  if (LV.showShards) {
    const cols = Math.ceil(Math.sqrt(Math.max(8, sim.size || 24)));
    const cell = Math.min(LV.W, LV.H) * 0.9 / cols;
    const ox = cx - (cols * cell) / 2, oy = cy - (cols * cell) / 2;
    x.lineWidth = 0.5;
    for (let i = 0; i < cols * cols; i++) {
      const gx = ox + (i % cols) * cell, gy = oy + Math.floor(i / cols) * cell;
      const f = sim.get(i);
      x.strokeStyle = rgba(mix(INK, pal.paper, 0.7), 0.18);
      x.strokeRect(gx, gy, cell, cell);
      if (f && !f.dying) {
        const ho = houseOf.get(i); const hc = ho ? houseColor(ho.name) : GILT;
        x.fillStyle = rgba(hc || GILT, 0.16); x.fillRect(gx + 1, gy + 1, cell - 2, cell - 2);
        if (cell > 16) { x.fillStyle = rgba(INK, 0.4); x.font = '7px monospace'; x.fillText(String(i), gx + 2, gy + 8); }
      }
    }
  }

  // ---- generation rings + labels ----
  x.lineWidth = 1;
  for (let g = 0; g <= maxGen; g++) {
    const r = ringRadius(g, maxGen);
    x.strokeStyle = g % 5 === 0 ? rgba(mix(INK, pal.paper, 0.35), 0.32) : rgba(mix(INK, pal.paper, 0.6), 0.14);
    x.beginPath(); x.arc(cx, cy, r, 0, TAU); x.stroke();
    if (g % 5 === 0 || g === maxGen) {
      x.fillStyle = rgba(INK, 0.42); x.font = '9px "IBM Plex Mono", monospace';
      x.fillText(T('lv.gen', { n: g }), cx + 3, cy - r + 10);
    }
  }

  // ---- lineage edges (parent → child): a faint gold thread up the dendrogram ----
  x.lineWidth = 0.8;
  for (const e of LV.edges) {
    const a = LV.nodes.get(e.a), b = LV.nodes.get(e.b);
    if (!a || !b) continue;
    x.strokeStyle = rgba(GOLD_THREAD, b.kind === 'ghost' || a.kind === 'ghost' ? 0.12 : 0.26);
    x.beginPath(); x.moveTo(a.x, a.y);
    const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
    x.quadraticCurveTo(mx + (cy - my) * 0.06, my + (mx - cx) * 0.06, b.x, b.y);
    x.stroke();
  }

  // ---- ghost ancestors (never lived): a small hollow ring on their generation ----
  for (const n of LV.nodes.values()) {
    if (!n.ghost) continue;
    x.strokeStyle = rgba(mix(INK, pal.paper, 0.3), 0.4); x.lineWidth = 0.9;
    x.beginPath(); x.arc(n.x, n.y, 2.2, 0, TAU); x.stroke();
  }

  // ---- tombstones: a faded刻 marker that keeps the position the individual held in life ----
  for (const n of LV.nodes.values()) {
    if (n.kind !== 'tomb') continue;
    const hc = houseColor(n.houseName) || mix(INK, pal.paper, 0.4);
    x.strokeStyle = rgba(hc, 0.34); x.lineWidth = 1;
    x.beginPath(); x.moveTo(n.x - 2.6, n.y + 2.6); x.lineTo(n.x + 2.6, n.y - 2.6);
    x.moveTo(n.x + 2.6, n.y + 2.6); x.lineTo(n.x - 2.6, n.y - 2.6); x.stroke();
    x.fillStyle = rgba(hc, 0.16); x.beginPath(); x.arc(n.x, n.y, 3.0, 0, TAU); x.fill();
  }
  LV.staticKey = sig;
}

// ================= trade flow =================
function tradeKey(s) { return `${s.tick}|${s.fromId}|${s.toId}|${s.resource || s.good || ''}|${s.amount}|${s.txHash || ''}`; }
function accumulateTrades() {
  const rows = [];
  if (Array.isArray(state.econRecent)) for (const r of state.econRecent) rows.push(r);
  // /proofs constituents give the un-netted per-trade rows + neural evidence (already polled into state.proofs)
  if (Array.isArray(state.proofs)) for (const p of state.proofs) {
    const c = p && p.receipt && p.receipt.constituents;
    if (Array.isArray(c)) for (const k of c) if (k && k.fromId != null && k.toId != null) rows.push(k);
  }
  for (const s of rows) {
    if (!s || s.fromId == null || s.toId == null) continue;
    const k = tradeKey(s);
    if (LV.seenTrades.has(k)) continue;
    LV.seenTrades.add(k);
    if (LV.seenTrades.size > 4000) { const it = LV.seenTrades.values(); for (let i = 0; i < 2000; i++) { const v = it.next().value; if (v === undefined) break; LV.seenTrades.delete(v); } }
    const good = s.good || (typeof s.resource === 'string' ? s.resource.replace(/^net:/, '') : '') || 'signal';
    const ek = `${s.fromId}>${s.toId}>${good}`;
    let e = LV.tradeEdges.get(ek);
    if (!e) { e = { fromId: s.fromId, toId: s.toId, good, amount: 0, t: performance.now() }; LV.tradeEdges.set(ek, e); }
    e.amount += atomicToUsdc(s.amount || 0); e.t = performance.now();
  }
  // age out cold edges so the particle budget tracks the LIVE flow, not all history
  const now = performance.now();
  for (const [k, e] of LV.tradeEdges) if (now - e.t > 120000) LV.tradeEdges.delete(k);
}
function spawnParticles() {
  if (!LV.showTrade) return;
  const now = performance.now();
  for (const e of LV.tradeEdges.values()) {
    if (now - e.t > 6000) continue;                       // only recently-active edges emit
    const a = nodeById(e.fromId), b = nodeById(e.toId);
    if (!a || !b || LV.parts.length >= PARTICLE_CAP) continue;
    if (Math.random() > 0.16) continue;                   // a gentle emission rate keeps ≤ cap
    const col = GOOD_COL[e.good] || GOOD_COL.signal || GILT;
    const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
    const cxp = mx + (LV.H / 2 - my) * 0.14, cyp = my + (mx - LV.W / 2) * 0.14;   // bow the arc outward
    LV.parts.push({ ax: a.x, ay: a.y, bx: b.x, by: b.y, cx: cxp, cy: cyp, p: 0, sp: 0.006 + Math.random() * 0.006, col, w: clamp(0.6 + e.amount * 0.5, 0.6, 3.4) });
  }
}
function nodeById(id) { const uid = LV.idToUid.get(id); return uid ? LV.nodes.get(uid) : null; }
function bezier(pt, t) {
  const u = 1 - t;
  return { x: u * u * pt.ax + 2 * u * t * pt.cx + t * t * pt.bx, y: u * u * pt.ay + 2 * u * t * pt.cy + t * t * pt.by };
}

// ================= social edges (alliance from bonds, antagonism from grudges + chronicle) =================
function bumpSocial(a, b, sign, weight) {
  if (a == null || b == null || a === b) return;
  const k = `${a}>${b}`;
  let e = LV.social.get(k);
  if (!e) { e = { a, b, sign, w: 0, t: Date.now() }; LV.social.set(k, e); }
  e.sign = sign; e.w = clamp(e.w + weight, 0, 1.6); e.t = Date.now();
}
function accumulateSocial() {
  const soc = state.econSocial;
  if (soc && Array.isArray(soc.bonds)) {
    for (const b of soc.bonds) {
      if (!b) continue; const sc = +b.score || 0;
      if (sc >= SOCIETY_BOND_MIN) bumpSocial(b.a ?? b.from ?? b.x, b.b ?? b.to ?? b.y, +1, clamp(sc, 0, 1) * 0.5);
    }
  }
  if (soc && Array.isArray(soc.grudges)) {
    for (const g of soc.grudges) if (g) bumpSocial(g.buyerId, g.sellerId, -1, 0.34);
  }
  // chronicle antagonism events (BETRAYAL / FEUD / EXILE / INDICTMENT / TRIAL / VERDICT)
  if (Array.isArray(state.chronRows)) {
    for (const r of state.chronRows) {
      if (!r || !ANTAGONISM_KINDS.has(String(r.kind || '').toUpperCase())) continue;
      const a = r.actorId ?? r.fromId ?? r.a ?? r.buyerId, b = r.targetId ?? r.toId ?? r.b ?? r.sellerId;
      if (a != null && b != null) bumpSocial(a, b, -1, 0.28);
    }
  }
  saveSocial();
}
function decaySocial(dtMs) {
  const f = Math.pow(0.5, dtMs / SOCIAL_HALFLIFE_MS);
  for (const [k, e] of LV.social) { e.w *= f; if (e.w < 0.02) LV.social.delete(k); }
}

// ================= per-frame draw =================
export function lvFrame(now) {
  if (!LV.active || !LV.ctx) return;
  const x = LV.ctx;
  bakeStatic();
  x.clearRect(0, 0, LV.W, LV.H);
  const pal = paletteAt(state.tempSmoothed);
  // parchment wash so the atlas sits on the same paper as the 3D field
  x.fillStyle = rgb(pal.paper); x.fillRect(0, 0, LV.W, LV.H);
  if (LV.staticOff) x.drawImage(LV.staticOff, 0, 0, LV.W, LV.H);

  // ---- social edges (dynamic: they decay) ----
  if (LV.showSocial) {
    x.lineWidth = 1;
    for (const e of LV.social.values()) {
      const a = nodeById(e.a), b = nodeById(e.b);
      if (!a || !b) continue;
      const al = clamp(e.w, 0, 1) * 0.5;
      if (al < 0.02) continue;
      x.strokeStyle = e.sign < 0 ? rgba(CRACK_RED, al) : rgba([120, 154, 96], al);
      if (e.sign < 0) x.setLineDash([3, 3]); else x.setLineDash([]);
      x.beginPath(); x.moveTo(a.x, a.y); x.lineTo(b.x, b.y); x.stroke();
    }
    x.setLineDash([]);
  }

  // ---- trade-flow arcs (underline) + particles ----
  if (LV.showTrade) {
    spawnParticles();
    for (const pt of LV.parts) {
      const a = pt.col;
      x.strokeStyle = rgba(a, 0.10); x.lineWidth = pt.w;
      x.beginPath(); x.moveTo(pt.ax, pt.ay); x.quadraticCurveTo(pt.cx, pt.cy, pt.bx, pt.by); x.stroke();
    }
    for (let i = LV.parts.length - 1; i >= 0; i--) {
      const pt = LV.parts[i]; pt.p += pt.sp;
      if (pt.p >= 1) { LV.parts.splice(i, 1); continue; }
      const q = bezier(pt, pt.p);
      x.fillStyle = rgba(pt.col, 0.85);
      x.beginPath(); x.arc(q.x, q.y, pt.w * 0.9 + 0.6, 0, TAU); x.fill();
    }
    LV.partCount = LV.parts.length;
  } else { LV.parts.length = 0; LV.partCount = 0; }

  // ---- live nodes (size ∝ balance, ring = house, ambient pulse = the fly's own DA/OA) ----
  for (const n of LV.nodes.values()) {
    if (n.kind !== 'live') continue;
    const r = nodeR(n);
    const hc = houseColor(n.houseName) || GILT;
    const da = nmDaHz(n.neuromod), oa = nmOaHz(n.neuromod);
    const pulse = 0.5 + 0.5 * Math.sin(now * 0.0022 + (n.id || 0) * 0.7);
    const glow = clamp(da / NM_REF_HZ, 0, 1);
    // neuromod halo (DA warm, OA cool) — the fly's "thinking" ambient
    if (glow > 0.02) {
      x.fillStyle = rgba(mix([200, 120, 40], [80, 140, 200], clamp(oa / NM_REF_HZ, 0, 1)), 0.10 + glow * 0.18 * pulse);
      x.beginPath(); x.arc(n.x, n.y, r + 3 + glow * 4 * pulse, 0, TAU); x.fill();
    }
    // body
    x.fillStyle = rgba(hc, 0.82);
    x.beginPath(); x.arc(n.x, n.y, r, 0, TAU); x.fill();
    // house ring
    x.strokeStyle = rgba(mix(hc, INK, 0.25), 0.9); x.lineWidth = 1.1;
    x.beginPath(); x.arc(n.x, n.y, r + 0.8, 0, TAU); x.stroke();
    // selection / hover highlight
    if (n.uid === LV.focusUid) {
      x.strokeStyle = rgba(GILT_HI, 0.95); x.lineWidth = 2;
      x.beginPath(); x.arc(n.x, n.y, r + 5, 0, TAU); x.stroke();
    } else if (n.uid === LV.hoverUid) {
      x.strokeStyle = rgba(GILT_HI, 0.5); x.lineWidth = 1.4;
      x.beginPath(); x.arc(n.x, n.y, r + 4, 0, TAU); x.stroke();
    }
  }
}

// ================= hit-testing (own canvas coords; node radius + HIT_PAD) =================
function hitTest(px, py) {
  let best = null, bestD = Infinity;
  for (const n of LV.nodes.values()) {
    if (n.kind === 'ghost') continue;                 // ghosts are decorative — not selectable
    const r = nodeR(n) + HIT_PAD;
    const d = (n.x - px) * (n.x - px) + (n.y - py) * (n.y - py);
    if (d <= r * r && d < bestD) { bestD = d; best = n; }
  }
  return best;
}

// ================= focus sidebar =================
function buildFocusSkeleton() {
  const panel = $('lv-panel'); if (!panel) return;
  panel.hidden = false;
  panel.innerHTML =
    `<div class="lv-p-head"><span class="lv-p-id" id="lv-p-id">—</span>` +
    `<button type="button" class="lv-p-x" data-lv-p="close" data-i18n-title="lv.close" aria-label="close">×</button></div>` +
    `<div class="lv-p-prov" id="lv-p-prov"></div>` +
    `<div class="lv-p-sec" id="lv-sec-layers"></div><div class="lv-layers" id="lv-layers"></div>` +
    `<div class="lv-p-sec" id="lv-sec-raster"></div><canvas id="lv-raster" width="240" height="70"></canvas>` +
    `<div class="lv-p-sec" id="lv-sec-memb"></div><canvas id="lv-memb" width="240" height="34"></canvas>` +
    `<div class="lv-p-sec" id="lv-sec-beh"></div><div class="lv-beh" id="lv-beh"></div>` +
    `<div class="lv-p-sec" id="lv-sec-nm"></div><div class="lv-nm" id="lv-nm"></div>`;
  // localise the static section headers + close button
  const setT = (id, k) => { const el = $(id); if (el) el.textContent = T(k); };
  setT('lv-sec-layers', 'lv.layers'); setT('lv-sec-raster', 'lv.raster'); setT('lv-sec-memb', 'lv.memb');
  setT('lv-sec-beh', 'lv.behavior'); setT('lv-sec-nm', 'lv.neuromod');
  const xb = panel.querySelector('[data-lv-p="close"]'); if (xb) xb.title = T('lv.close');
  // the 4 layer bars are built once, then only their fills move
  const lh = $('lv-layers');
  if (lh) lh.innerHTML = LAYERS.map((k) =>
    `<div class="lv-bar" data-k="${k}"><span class="lv-bar-n">${T('lv.layer.' + k)}</span>` +
    `<span class="lv-bar-t"><span class="lv-bar-f"></span></span><span class="lv-bar-v">—</span></div>`).join('');
}
function renderProvenance() {
  const host = $('lv-p-prov'); if (!host) return;
  const n = LV.focusUid ? LV.nodes.get(LV.focusUid) : null;
  const e = (n && n.entry) || LV.focusEntry;
  const g = LV.focusGrave || (n && n.grave);
  const idLine = $('lv-p-id');
  if (idLine) {
    const who = n && n.id != null ? '#' + n.id : (g && g.id != null ? '#' + g.id + ' †' : '—');
    idLine.textContent = e ? `${who} · ${T('lv.genShort', { n: e.generation | 0 })}` : who;
  }
  let html = '';
  const hash = (n && n.hash) || (e && e.genomeHash) || '';
  if (hash) html += `<div class="lv-prov-r"><span>${T('lv.genomeHash')}</span><b class="fp">${shortHash(String(hash).toLowerCase())}</b></div>`;
  if (e) {
    if (Array.isArray(e.parents) && e.parents.some((p) => !isZeroHash(p)))
      html += `<div class="lv-prov-r"><span>${T('lv.parents')}</span><b class="fp">${e.parents.filter((p) => !isZeroHash(p)).map((p) => shortHash(String(p).toLowerCase())).join(' · ')}</b></div>`;
    if (e.op) html += `<div class="lv-prov-r"><span>${T('lv.op')}</span><b>${gl('regime', String(e.op)) !== e.op ? gl('regime', String(e.op)) : e.op}</b></div>`;
    if (e.commitTx && isRealTxHash(e.commitTx))
      html += `<div class="lv-prov-r"><span>${T('lv.commitTx')}</span><b><a href="${ARC_EXPLORER}/tx/${e.commitTx}" target="_blank" rel="noopener noreferrer">${shortHash(e.commitTx)}</a></b></div>`;
  }
  if (g) {
    if (g.cause) html += `<div class="lv-prov-r"><span>${T('lv.cause')}</span><b>${gl('cause', String(g.cause))}</b></div>`;
    if (g.age != null) html += `<div class="lv-prov-r"><span>${T('lv.age')}</span><b>${g.age}</b></div>`;
    if (g.estateUsdc != null) html += `<div class="lv-prov-r"><span>${T('lv.estate')}</span><b>${(+g.estateUsdc).toFixed(4)}</b></div>`;
    if (Array.isArray(g.heirIds) && g.heirIds.length) html += `<div class="lv-prov-r"><span>${T('lv.heirs')}</span><b>${g.heirIds.map((h) => '#' + h).join(' ')}</b></div>`;
  }
  const addr = (state.lvLineage && state.lvLineage.lineageAddress) || '';
  if (hash && isRealAddr(addr))
    html += `<button type="button" class="lv-verify" data-lv-p="verify" data-hash="${String(hash).toLowerCase()}">${T('lv.verifyOnchain')}</button>`;
  host.innerHTML = html;
}
function updateFocusNeural() {
  const s = LV.focusSnap; if (!s) return;
  const rates = s.firingRates || [];
  // parse the neuron-kind → layer index map ONCE (it is the same FAFB_783 architecture for every fly)
  if (!LV.layerIdx && Array.isArray(s.neuronKinds) && s.neuronKinds.length) {
    const idx = { sensory: [], inter: [], modulatory: [], motor: [] };
    const kinds = s.neuronKinds;
    for (let i = 0; i < kinds.length; i++) { const b = idx[kinds[i]]; if (b) b.push(i); }
    LV.layerIdx = idx;
  }
  // per-layer mean firing rate — one reduce over ~10,361 values, ONLY on snapshot arrival (never per frame)
  if (LV.layerIdx && rates.length) {
    const means = {};
    for (const k of LAYERS) {
      const arr = LV.layerIdx[k]; let sum = 0;
      for (let j = 0; j < arr.length; j++) sum += rates[arr[j]] || 0;
      means[k] = arr.length ? sum / arr.length : 0;
    }
    LV.layerMeans = means;
    for (const k of LAYERS) {
      const row = document.querySelector(`#lv-layers .lv-bar[data-k="${k}"]`); if (!row) continue;
      const v = means[k], norm = clamp(v / 70);
      const f = row.querySelector('.lv-bar-f'); if (f) { f.style.width = (norm * 100).toFixed(1) + '%'; f.style.background = rgb(KIND_COL[k] || GILT); }
      const out = row.querySelector('.lv-bar-v'); if (out) out.textContent = v.toFixed(1) + ' Hz';
    }
  }
  drawLvRaster(rates);
  drawLvMemb(s.membrane);
  drawLvNeuromod(s.neuromod);
  drawLvBehaviour();
}
function drawLvRaster(rates) {
  const c = $('lv-raster'); if (!c || !rates || !rates.length) return;
  const x = c.getContext('2d'), W = c.width, H = c.height;
  x.clearRect(0, 0, W, H);
  const ps = derivePseudoSpikes(rates);            // thresholded firingRates → the firing index list
  const pal = paletteAt(state.tempSmoothed);
  const dot = mix(INK, pal.accent, 0.5);
  x.fillStyle = rgba(dot, 0.7);
  const N = ps.n || rates.length;
  // draw up to ~1,200 of the firing indices, newest-snapshot spread over the strip (a density read-out)
  const stride = Math.max(1, Math.floor(ps.idx.length / 1200));
  for (let i = 0; i < ps.idx.length; i += stride) {
    const idx = ps.idx[i];
    x.fillRect((idx / N) * W, ((fnv1a('r' + idx) % 100) / 100) * H, 1.4, 1.4);
  }
  x.fillStyle = rgba(INK, 0.55); x.font = '8px monospace';
  x.fillText(T('lv.rasterNote', { n: ps.idx.length, N }), 3, H - 3);
}
function drawLvMemb(memb) {
  const c = $('lv-memb'); if (!c) return;
  const x = c.getContext('2d'), W = c.width, H = c.height;
  x.clearRect(0, 0, W, H);
  if (!Array.isArray(memb) || !memb.length) { x.fillStyle = rgba(INK, 0.3); x.font = '8px monospace'; x.fillText(T('lv.membIdle'), 3, H / 2); return; }
  let mn = Infinity, mx = -Infinity;
  for (let i = 0; i < memb.length; i++) { const v = memb[i]; if (v < mn) mn = v; if (v > mx) mx = v; }
  const span = (mx - mn) || 1, N = memb.length;
  const STOPS = [[58, 110, 104], [125, 148, 160], [238, 231, 214], [214, 176, 84], [176, 74, 58]];
  const step = Math.max(1, Math.floor(N / W));      // fold the neuron-ordered vector into one column per px
  for (let px = 0, i = 0; px < W; px++, i += step) {
    const q = clamp((memb[i] - mn) / span);
    const t = q * (STOPS.length - 1), si = Math.min(STOPS.length - 2, Math.floor(t));
    const col = mix(STOPS[si], STOPS[si + 1], t - si);
    x.fillStyle = rgb(col); x.fillRect(px, 0, 1, H);
  }
  x.fillStyle = rgba(INK, 0.6); x.font = '8px monospace';
  x.fillText(mn.toFixed(0) + ' mV', 3, H - 3); x.fillText(mx.toFixed(0) + ' mV', W - 34, H - 3);
}
function drawLvNeuromod(nm) {
  const host = $('lv-nm'); if (!host) return;
  const da = nmDaHz(nm), oa = nmOaHz(nm);
  const bar = (label, hz, col) => `<div class="lv-bar"><span class="lv-bar-n">${label}</span>` +
    `<span class="lv-bar-t"><span class="lv-bar-f" style="width:${(clamp(hz / NM_REF_HZ) * 100).toFixed(1)}%;background:${col}"></span></span>` +
    `<span class="lv-bar-v">${hz.toFixed(1)} Hz</span></div>`;
  host.innerHTML = bar('DA', da, 'rgb(200,120,40)') + bar('OA', oa, 'rgb(80,140,200)');
}
function drawLvBehaviour() {
  const host = $('lv-beh'); if (!host) return;
  const n = LV.focusUid ? LV.nodes.get(LV.focusUid) : null;
  const fap = (n && n.fap) || 'FORAGE';
  const role = (n && n.role) || FAP_ROLE[fap] || '';
  host.innerHTML = `<span class="lv-fap-badge" style="background:${fapColor(fap)}">${fap.toLowerCase()}</span>` +
    `<span class="lv-fap-gloss">${FAP_GLOSS[fap] || ''}</span>` +
    (role ? `<span class="lv-fap-role">${role}</span>` : '');
}

// ---- focused-fly neural feed: 1 s poll behind the inspector's in-flight + debounce guard, ONE fly only ----
function focusLoad(id) {
  if (LV.focusId !== id) return;
  if (state.offline || Date.now() < state.offlineUntil) return;   // offline: keep the last read-out
  fetchFocusNeural(id);
}
async function fetchFocusNeural(id) {
  if (LV.focusId !== id || LV.focusInFlight) return;
  LV.focusInFlight = true;
  if (LV.focusCtrl) LV.focusCtrl.abort();
  LV.focusCtrl = new AbortController();
  try {
    const s = await getJSON(`/snapshot?flyId=${id}`, 3000, LV.focusCtrl.signal);
    if (LV.focusId !== id) return;
    LV.focusSnap = s;
    updateFocusNeural();
  } catch { /* best-effort; the panel keeps its last frame */ }
  finally { LV.focusInFlight = false; }
}
function startFocusFeed(id) {
  stopFocusFeed();
  if (id == null) return;
  LV.focusId = id;
  LV.focusDebounce = setTimeout(() => { LV.focusDebounce = null; focusLoad(id); }, FOCUS_DEBOUNCE_MS);
  LV.focusTimer = setInterval(() => { if (LV.focusId === id && !LV.focusInFlight) focusLoad(id); }, FOCUS_INTERVAL_MS);
}
function stopFocusFeed() {
  if (LV.focusDebounce) { clearTimeout(LV.focusDebounce); LV.focusDebounce = null; }
  if (LV.focusTimer) { clearInterval(LV.focusTimer); LV.focusTimer = null; }
  if (LV.focusCtrl) { LV.focusCtrl.abort(); LV.focusCtrl = null; }
  LV.focusInFlight = false; LV.focusId = null; LV.focusSnap = null;
}
function selectNode(n) {
  if (!n) { clearFocus(); return; }
  LV.focusUid = n.uid;
  LV.focusEntry = n.entry || null;
  LV.focusGrave = n.grave || null;
  buildFocusSkeleton();
  renderProvenance();
  if (n.id != null && n.kind === 'live') { startFocusFeed(n.id); }
  else { stopFocusFeed(); drawLvBehaviour(); }
}
function clearFocus() {
  LV.focusUid = null; LV.focusEntry = null; LV.focusGrave = null;
  stopFocusFeed();
  const panel = $('lv-panel'); if (panel) { panel.hidden = true; panel.innerHTML = ''; }
}
async function verifyFocus(btn) {
  const hash = btn && btn.dataset.hash; if (!hash) return;
  const addr = (state.lvLineage && state.lvLineage.lineageAddress) || '';
  btn.disabled = true; btn.textContent = T('lv.verifying');
  const oc = await readLineageOnchain(addr, hash);
  if (oc && oc.committed) { btn.textContent = T('lv.verified', { gen: oc.generation }); btn.classList.add('ok'); }
  else if (oc) { btn.textContent = T('lv.notCommitted'); btn.classList.add('fail'); }
  else { btn.textContent = T('lv.verifyFail'); btn.classList.add('fail'); }
  setTimeout(() => { btn.disabled = false; renderProvenance(); }, 2600);
}

// ================= pollers (triple guard, copied from polling.js) =================
export async function pollLineageView(force) {
  const now = Date.now();
  if (LV.lineageInFlight) return;                                  // in-flight mutex — never overlap
  if (!force && now - state.lvLastLineagePoll < LINEAGE_POLL_MS) return;   // throttle
  if (Date.now() < state.offlineUntil) return;                     // circuit breaker — offline, stay local
  LV.lineageInFlight = true; state.lvLastLineagePoll = now;
  try {
    const d = await getJSON('/lineage?limit=5000', 12000);
    if (d && Array.isArray(d.entries)) { state.lvLineage = d; await resolveHashes(); rebuild(); accumulateSocial(); }
  } catch { /* best-effort: the atlas keeps its last tree */ }
  finally { LV.lineageInFlight = false; }
}

// ================= legend =================
function renderLegend() {
  const host = $('lv-legend'); if (!host) return;
  const goods = Object.keys(GOOD_COL);
  host.innerHTML =
    `<div class="lv-lg-row"><span class="lv-lg-t">${T('lv.lgTitle')}</span></div>` +
    `<div class="lv-lg-row">${goods.map((g) => `<span class="lv-lg-chip"><i style="background:${rgb(GOOD_COL[g])}"></i>${gl('goods', g)}</span>`).join('')}</div>` +
    `<div class="lv-lg-row"><span class="lv-lg-chip"><i class="lv-lg-ally"></i>${T('lv.lgAlly')}</span>` +
    `<span class="lv-lg-chip"><i class="lv-lg-foe"></i>${T('lv.lgFoe')}</span>` +
    `<span class="lv-lg-chip"><i class="lv-lg-ghost"></i>${T('lv.lgGhost')}</span>` +
    `<span class="lv-lg-chip"><i class="lv-lg-tomb"></i>${T('lv.lgTomb')}</span></div>` +
    `<div class="lv-lg-row lv-lg-note">${T('lv.lgNote', { n: LV.liveCount, g: genCount() })}</div>`;
}

// ================= open / close / toggle =================
export function openLineageView() {
  if (LV.active) return;
  if (!LV.inited) initLineageView();
  LV.active = true; state.lineageViewActive = true;
  document.body.classList.add('lv-active');
  const ui = $('lv-ui'); if (ui) ui.hidden = false;
  sizeCanvas();
  syncRailBtn();
  // seed + start the slow pollers; the first paint uses whatever is already cached
  pollLineageView(true);
  if (!LV.lineageTimer) LV.lineageTimer = setInterval(() => pollLineageView(false), LINEAGE_POLL_MS);
  accumulateTrades(); accumulateSocial(); rebuild(); renderLegend();
  if (!LV.tradeTimer) LV.tradeTimer = setInterval(() => { if (!LV.active) return; accumulateTrades(); decaySocial(TRADE_ACCUM_MS); accumulateSocial(); rebuild(); }, TRADE_ACCUM_MS);
}
export function closeLineageView() {
  if (!LV.active) return;
  LV.active = false; state.lineageViewActive = false;
  document.body.classList.remove('lv-active');
  const ui = $('lv-ui'); if (ui) ui.hidden = true;
  if (LV.lineageTimer) { clearInterval(LV.lineageTimer); LV.lineageTimer = null; }
  if (LV.tradeTimer) { clearInterval(LV.tradeTimer); LV.tradeTimer = null; }
  clearFocus();
  syncRailBtn();
}
export function toggleLineageView() { if (LV.active) closeLineageView(); else openLineageView(); }
function syncRailBtn() {
  const b = document.querySelector('#command-rail .rail-btn[data-act="lineageview"]');
  if (b) { b.classList.toggle('is-off', !LV.active); b.setAttribute('aria-pressed', LV.active ? 'true' : 'false'); }
}

// ================= init (wiring, called once from main.js boot) =================
export function initLineageView() {
  if (LV.inited) return;
  LV.cv = $('lineage-field');
  if (!LV.cv) return;
  LV.ctx = LV.cv.getContext('2d');
  LV.inited = true;
  loadGH(); loadSocial();

  // pointer / touch selection on the lineage canvas (independent of #field — no arbitration needed)
  const toLocal = (ev) => { const r = LV.cv.getBoundingClientRect(); return { x: ev.clientX - r.left, y: ev.clientY - r.top }; };
  LV.cv.addEventListener('pointerdown', (ev) => {
    const p = toLocal(ev); const n = hitTest(p.x, p.y);
    selectNode(n);
  });
  LV.cv.addEventListener('pointermove', (ev) => {
    const p = toLocal(ev); const n = hitTest(p.x, p.y);
    LV.hoverUid = n ? n.uid : null;
    LV.cv.style.cursor = n ? 'pointer' : 'crosshair';
  });

  // toolbar toggles + panel delegation
  const tb = $('lv-toolbar');
  if (tb) tb.addEventListener('click', (ev) => {
    const b = ev.target.closest('.lv-tb'); if (!b) return;
    const k = b.dataset.lv;
    if (k === 'shards') { LV.showShards = !LV.showShards; b.setAttribute('aria-pressed', LV.showShards ? 'true' : 'false'); LV.staticKey = ''; }
    else if (k === 'social') { LV.showSocial = !LV.showSocial; b.setAttribute('aria-pressed', LV.showSocial ? 'true' : 'false'); }
    else if (k === 'trade') { LV.showTrade = !LV.showTrade; b.setAttribute('aria-pressed', LV.showTrade ? 'true' : 'false'); }
    else if (k === 'refresh') { pollLineageView(true); }
    else if (k === 'close') { closeLineageView(); }
  });
  const panel = $('lv-panel');
  if (panel) panel.addEventListener('click', (ev) => {
    const b = ev.target.closest('[data-lv-p]'); if (!b) return;
    if (b.dataset.lvP === 'close') clearFocus();
    else if (b.dataset.lvP === 'verify') verifyFocus(b);
  });
  window.addEventListener('resize', () => { if (LV.active) { sizeCanvas(); rebuild(); } });
  syncRailBtn();
}

// re-localise the dynamic chrome on a language switch (called from main.js rerenderAll)
export function lvRelocalise() {
  if (!LV.active) return;
  renderLegend();
  if (LV.focusUid) { buildFocusSkeleton(); renderProvenance(); if (LV.focusSnap) updateFocusNeural(); else drawLvBehaviour(); }
}

// perf probe extension (merged into window.__murmurPerf by main.js)
export function lvPerf() { return { lvNodes: LV.nodeCount, lvEdges: LV.edgeCount, lvParticles: LV.partCount, lvLive: LV.liveCount, lvActive: LV.active }; }
