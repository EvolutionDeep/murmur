// lvTimeReplay.js — task 33 · Phase F · C25: the lineage atlas TIME REPLAY (世系树生长).
// Imported by lvNeural.js + lvInteract.js + lineageView.js with ?v= cache-buster (task 75).
//
// WHAT IT DOES
//   A draggable cursor over the whole archived cron series (/history, ~9 400 rows ≈ 10.8 days in production)
//   plus a play/pause transport. The cursor drives TWO things:
//     1. the ATLAS TREE — a genome node exists only if its /lineage entry was already bred at the cursor's
//        cron (entry.ts → cron index), so dragging back prunes the tree and playing forward grows it, one
//        commit at a time (lineageView.rebuild consults lvReplayEntryBorn);
//     2. the READ-OUTS — temperature / gini / population size / deals / volumeUsdc / topStates at that cron,
//        rendered into the #lv-replay DOM panel (never onto the atlas canvas as text).
//
// SEAM DISCIPLINE (task 29 · Phase B/C invariant, honoured here)
//   • This module NEVER imports lineageView.js (that would close a cycle). It reaches core two ways only:
//       – the LV singleton + lvForceRebuild (both from lvState.js), which core reads every frame;
//       – the pure predicates core PULLS (lvReplayOn / lvReplayEntryBorn / lvReplayTimeBucket /
//         lvReplayScrubbing), so the layout + bake-gate decisions stay in core.
//   • It owns NO camera maths and NO canvas text. The per-frame integrator (lvReplayAdvance) is forwarded
//     from the END of lvInteractFrame — after the camera settles, before camApply — because it only mutates
//     replay state, never draws. The world-space overlay (lvReplayDraw) is forwarded from lvNeuralFrame, the
//     established seam→seam hop, so NO new call point is added to lvFrame.
//
// PERF CONTRACT (the C25 hard requirements)
//   • KEYFRAMES ARE PRECOMPUTED. The archived series is paged in (≤4 × 5 000 rows, the server's own cap) and
//     REDUCED IN THE SAME PASS into one snapshot per RT_STEP=100 cron rows (~94 objects for the whole
//     10.8-day span). The raw rows of a page are dropped as soon as it is reduced, so peak memory is one
//     page, and the steady-state cost of the whole feature is ~94 small objects + ~143 birth records.
//   • NOTHING SCANS THE SERIES PER FRAME. The cursor is an integer; the snapshot is an array index; the
//     "which genomes are born" answer is a Set rebuilt ONLY when the cursor crosses a keyframe boundary.
//   • DRAGGING SHOWS THE SKELETON. While the thumb is down lvReplayScrubbing() is true, core drops to lod0
//     (lvPointCloud) and skips bakeStatic — so a drag costs zero bakes. One rebuild + one re-bake happen when
//     the thumb is released (or when playback crosses a keyframe), never mid-gesture.
//   • THE TIME DIMENSION IS BUCKETED. lvReplayTimeBucket() returns the integer KEYFRAME index (or -1 when the
//     replay is off) — never the continuous cursor — so lineageView.bakeSignature can append `:rt{n}` without
//     re-baking every frame.
//   • ZERO TIMERS. Playback is integrated from the rAF clock inside lvReplayAdvance; the only async work is
//     the bounded, mutexed, abortable /history page fetch. There is nothing to leak when the atlas closes.
//   • No canvas glow, no CSS veil, no per-frame text drawn onto the atlas (the read-outs live in DOM).
import { LV, LVQ, nodeR, ringRadius, lvForceRebuild } from './lvState.js?v=164';
import {
  state, $, clamp, mix, rgb, rgba, paletteAt, TAU, INK, GILT, GILT_HI, STATE_RGB,
} from './shared.js?v=164';
import { t as T, gl } from './i18n.js?v=115';
import { getJSON } from './polling.js?v=164';

// ================= tuning constants =================
const RT_STEP = 100;            // archived cron rows per keyframe (~2.8 h of colony time in production)
const RT_PAGE_LIMIT = 5000;     // /history's own server-side cap (state.ts getHistory)
const RT_MAX_PAGES = 4;         // hard bound: 4 × 5 000 = 20 000 rows (production is ~9 400) ⇒ never unbounded
const RT_FETCH_TIMEOUT = 12000; // per-page fetch budget (getJSON also carries its own AbortController)
const RT_SPEEDS = [1, 2, 4];    // transport speeds, ×RT_CRON_PER_SEC
const RT_CRON_PER_SEC = 260;    // cron rows per second at 1× (the full ~9 400-row span in ~36 s)
const RT_PAINT_MS = 100;        // DOM read-out throttle (10 Hz) — the canvas overlay is NOT throttled
const RT_FLASH_MS = 2600;       // how long a genome keeps its birth flash after its keyframe lands
const RT_FLASH_CAP = 24;        // cap on concurrent birth-flash rings (the last N births of the bucket)
const RT_DT_CLAMP = 250;        // per-frame dt clamp, so a backgrounded tab never fast-forwards the replay
// Playback crosses a keyframe every ~385 ms at 1× and every ~96 ms at 4×, and each crossing changes the born
// set ⇒ a new structSig ⇒ a full static re-bake. Left unthrottled that is 10 layout passes + re-bakes per
// second at 4×, which is exactly the "never rebuild per frame" contract. So while PLAYING, re-layout is
// floored here; the deferred request is held in rt.pending and drained by lvReplayAdvance, and because
// rtReborn has already recomputed the born set, the deferred pass lands on the NEWEST bucket (the tree simply
// catches up in coarser steps). A manual scrub release / stop is NOT playing, so it rebuilds immediately.
const RT_REBUILD_MIN_MS = 400;

// ================= replay state (module-private) =================
const rt = {
  on: false,            // the reader has opened the replay chrome
  ready: false,         // the keyframe table is built
  loading: false,       // a /history page fetch is in flight (mutex)
  failed: false,        // the fetch could not build a usable table (status line says why)
  ctrl: null,           // AbortController for the in-flight fetch
  n: 0,                 // total archived cron rows (from /history.summary.ticks)
  i0: 0, i1: 0,         // covered cron-index range (i0 > 0 only if the series outgrew RT_MAX_PAGES)
  kf: [],               // keyframes, ASCENDING by cron index — the precomputed snapshot table
  kfMap: null,          // accumulator during rtLoad only; nulled in rtFinalise so no page stays reachable
  kBase: 0,             // rt.kf[0].k — offset between an absolute bucket number and an ARRAY index (see rtSetIdx)
  idx: 0,               // cursor, in absolute cron index (continuous while playing)
  kfi: 0,               // cursor's keyframe ARRAY index — the quantised value that gates layout + bake
  playing: false, speedIx: 0, tLast: 0,
  dragging: false,      // the scrubber thumb is down ⇒ skeleton-only, no rebuild, no re-bake
  pending: false,       // a keyframe crossing landed mid-gesture ⇒ the rebuild is deferred, not dropped
  births: [],           // [{uid, cron, gen}] ascending by cron — /lineage entries mapped onto the timeline
  birthSrc: '',         // the /lineage shape the birth table was built from (rebuild only when it moves)
  birthTotal: 0,        // total genomes in /lineage (the denominator of the "{b} / {n}" read-out)
  bornSet: null,        // Set<uid> bred at or before the cursor's keyframe
  bornN: 0, horizonGen: 0,
  flash: [], flashSet: null, flashT: -1e9,
  kfBorn: [],           // per-keyframe cumulative genome count (the growth curve in the sparkline)
  maxSize: 1, maxDeals: 1, maxVol: 1,   // table extremes, resolved ONCE in rtFinalise (never per paint)
  sparkW: 300, sparkH: 40, sparkDpr: 1, sparkKey: '',
  lastPaint: 0, bound: false, lastRebuild: 0,
};
const ST_KEYS = ['AGITATE', 'EXPLORE', 'AGGREGATE', 'REST'];
const stEls = {};

// ================= public predicates (pulled by lineageView core) =================
/**
 * True only when the replay is actually GATING the layout: chrome open, keyframe table built, and the birth
 * table resolved. Until /lineage has landed there is nothing to gate on, so the atlas keeps showing the full
 * tree rather than collapsing to an empty ring — a missing data source must never look like a broken canvas.
 */
export function lvReplayOn() { return rt.on && rt.ready && rt.births.length > 0 && !!rt.bornSet; }
/** True while the scrubber thumb is down: core drops to the lod0 skeleton and skips bakeStatic. */
export function lvReplayScrubbing() { return rt.dragging; }
/**
 * Does this /lineage entry already exist at the cursor? Called once per entry per rebuild (≤143), never per
 * frame, and answered by a Set built when the cursor last crossed a keyframe boundary.
 * @param {object} e  a LineageEntry ({genomeHash, ts, generation, …})
 */
export function lvReplayEntryBorn(e) {
  if (!lvReplayOn() || !e || !e.genomeHash) return true;
  const uid = String(e.genomeHash).toLowerCase();
  return rt.bornSet.has(uid);
}
/**
 * The quantised TIME dimension for lineageView.bakeSignature (`:rt{n}`). This is the keyframe ARRAY index, not
 * the continuous cursor: folding the raw cron index in would re-bake on every pixel of a drag, which is exactly
 * the trap tempBucket() exists to avoid. -1 when the replay is off, so the signature is byte-identical to the
 * pre-C25 one for every reader who never opens the chrome.
 */
export function lvReplayTimeBucket() { return lvReplayOn() ? rt.kfi : -1; }
/** Perf-probe extension, merged into lvPerf() by core. */
export function lvReplayPerf() {
  return {
    lvReplay: rt.on ? 1 : 0, lvRtReady: rt.ready ? 1 : 0, lvRtKf: rt.kf.length, lvRtRows: rt.n,
    lvRtIdx: Math.round(rt.idx), lvRtBucket: rt.kfi, lvRtPlaying: rt.playing ? 1 : 0,
    lvRtSpeed: RT_SPEEDS[rt.speedIx], lvRtBorn: rt.bornN, lvRtBirths: rt.births.length,
  };
}

// ================= keyframe precomputation (the C25 hard requirement) =================
/**
 * Reduce ONE /history page into the keyframe table, in the same pass that reads it — the page array is then
 * dropped by the caller, so peak memory is a single page, never the whole ~9 400-row series.
 * @param {Array} rows  the page's rows, DESCENDING by tick (the server's default order)
 * @param {number} base  the ASCENDING cron index of rows[rows.length - 1]
 */
function rtReduce(rows, base) {
  const L = rows.length;
  for (let j = L - 1; j >= 0; j--) {          // walk the page oldest→newest so "last wins" is correct
    const r = rows[j]; if (!r) continue;
    const i = base + (L - 1 - j);
    const k = Math.floor(i / RT_STEP);
    let f = rt.kfMap.get(k);
    if (!f) {
      f = {
        k, i0: i, i1: i, li: -1, n: 0, ts0: 0, ts1: 0,
        tick: 0, ts: 0, temp: 0, gini: 0, size: 0, maxSize: 0, deals: 0,
        settlements: 0, volumeUsdc: 0, regime: '', topState: '', topStates: null,
      };
      rt.kfMap.set(k, f);
    }
    const ts = +r.ts || 0;
    if (f.n === 0 || ts < f.ts0) f.ts0 = ts;
    if (ts > f.ts1) f.ts1 = ts;
    if (i < f.i0) f.i0 = i;
    if (i > f.i1) f.i1 = i;
    f.n++;
    f.temp += +r.temperature || 0;
    f.gini += +r.gini || 0;
    const sz = +r.size || 0; f.size += sz; if (sz > f.maxSize) f.maxSize = sz;
    f.deals += +r.deals || 0;
    // cumulative counters + categorical reads: keep the NEWEST row of the bucket (guards against a bucket
    // straddling a page boundary, where the older page arrives second)
    if (i >= f.li) {
      f.li = i; f.tick = +r.tick || 0; f.ts = ts;
      f.settlements = +r.settlements || 0; f.volumeUsdc = +r.volumeUsdc || 0;
      f.regime = r.regime || f.regime; f.topState = r.topState || f.topState;
      if (r.topStates) f.topStates = r.topStates;
    }
  }
}
/** Turn the accumulator into the final ascending table: averages + extremes resolved, raw rows unreachable. */
function rtFinalise(total) {
  const list = Array.from(rt.kfMap.values()).sort((a, b) => a.k - b.k);
  rt.kfMap = null;
  let ms = 1, md = 1, mv = 1;
  for (const f of list) {
    const d = f.n || 1;
    // temp / gini / size are GAUGES (temperature, inequality, headcount) ⇒ a bucket reads as their mean.
    // `deals` is the one PER-TICK INCREMENT in the row (measured over 400 live rows: 0…80, 364/400 non-zero,
    // so the bucket sum is "deals struck in this ~2.8 h window"). settlements / volumeUsdc are CUMULATIVE
    // counters, so they are taken newest-wins in rtReduce and must NOT be summed or averaged here.
    f.temp /= d; f.gini /= d; f.size /= d;
    if (f.size > ms) ms = f.size;
    if (f.deals > md) md = f.deals;
    if (f.volumeUsdc > mv) mv = f.volumeUsdc;
  }
  rt.maxSize = ms; rt.maxDeals = md; rt.maxVol = mv;
  rt.kf = list;
  // In production the archive is paged from the newest row backwards and always covers ordinal 0, so kBase is
  // 0 and bucket number === array index. Should the series ever outgrow RT_MAX_PAGES the OLDEST buckets are
  // the ones missing, and this offset keeps rtSetIdx / lvReplayTimeBucket / rtDrawSpark aligned on the array
  // instead of silently reading the wrong snapshot.
  rt.kBase = list.length ? list[0].k : 0;
  rt.n = total > 0 ? total : (list.length ? list[list.length - 1].i1 + 1 : 0);
  rt.i0 = list.length ? list[0].i0 : 0;
  rt.i1 = list.length ? list[list.length - 1].i1 : Math.max(0, rt.n - 1);
  rt.ready = list.length > 1;
  rt.sparkKey = '';
}
/**
 * Pull the archived series and reduce it to keyframes. Mutexed (one fetch at a time), abortable (the
 * AbortController is fired by lvReplayStop), and hard-bounded at RT_MAX_PAGES so a runaway series can never
 * turn into an unbounded request loop. Cached for the session: reopening the chrome costs nothing.
 */
async function rtLoad() {
  if (rt.loading || rt.ready) return;
  rt.loading = true; rt.failed = false;
  rt.kfMap = new Map();
  rt.ctrl = new AbortController();
  const signal = rt.ctrl.signal;
  let total = 0, older = 0, before = null;
  rtStatus();
  try {
    for (let p = 0; p < RT_MAX_PAGES; p++) {
      const q = `/history?order=desc&limit=${RT_PAGE_LIMIT}` + (before != null ? `&before=${before}` : '');
      const d = await getJSON(q, RT_FETCH_TIMEOUT, signal);
      if (signal.aborted) return;
      if (!d || d.enabled === false || !Array.isArray(d.rows) || !d.rows.length) break;
      const sum = d.summary || state.histSummary || {};
      if (!total && Number(sum.ticks) > 0) total = Number(sum.ticks);
      if (!total) { total = Number(state.histSummary && state.histSummary.ticks) || 0; }
      const L = d.rows.length;
      // The page holds the NEWEST `older + L` rows, so its oldest row sits at ascending index total-older-L.
      // Without `total` the absolute cron index is unknowable, so we refuse to guess rather than build a
      // keyframe table on a wrong axis. NOTE: `tick` is sparse in production (3162…59564 for 9347 rows), so the
      // axis here is the ORDINAL position in the archive, not the tick value. `total` is read once, from the
      // first page's summary; if a row lands at the head mid-pagination every ordinal shifts by that count (≤ a
      // handful out of ~9 400), which moves the sub-bucket interpolation only — never a bucket boundary.
      if (!(total > 0)) break;
      rtReduce(d.rows, total - older - L);
      older += L;
      before = +d.rows[L - 1].tick || null;      // next page: strictly older than the oldest tick we hold
      if (L < RT_PAGE_LIMIT || before == null || older >= total) break;
    }
    if (signal.aborted) return;
    rtFinalise(total);
    if (!rt.ready) { rt.failed = true; rtStatus(); return; }
    // Opening the replay must not visually change anything: park the cursor on NOW (the full tree). The
    // transport rewinds to the beginning when the reader presses play.
    rt.idx = rt.i1; rt.kfi = -1;
    rtEnsureBirths();
    lvReplaySyncRange();
    rtSetIdx(rt.i1, true);
    rtSizeSpark();
    rtPaint(true);
  } catch {
    rt.failed = true; rt.ready = false;
  } finally {
    rt.loading = false; rt.ctrl = null; rt.kfMap = null;
    rtStatus();
  }
}

// ================= the birth table: /lineage.entries[].ts → cron index =================
/** Wall-clock ts → absolute cron index, by binary search over the keyframes + a linear interpolation inside. */
function rtCronAtTs(ts) {
  const kf = rt.kf, n = kf.length;
  if (!n || !Number.isFinite(ts) || ts <= 0) return rt.i0;
  let lo = 0, hi = n - 1, at = 0;
  while (lo <= hi) { const mid = (lo + hi) >> 1; if (kf[mid].ts0 <= ts) { at = mid; lo = mid + 1; } else hi = mid - 1; }
  const f = kf[at];
  const span = (f.ts1 - f.ts0) || 1;
  const p = clamp((ts - f.ts0) / span, 0, 1);
  return clamp(Math.round(f.i0 + p * (f.i1 - f.i0)), rt.i0, rt.i1);
}
/**
 * Rebuild the birth table from state.lvLineage when (and only when) its shape moved. /lineage carries ~143
 * entries in production, 24 of them genesis roots with ts=0 (they predate the archive ⇒ born at cron i0).
 * Called at most once per keyframe crossing, never per frame.
 */
function rtEnsureBirths() {
  const lin = state.lvLineage;
  const entries = (lin && Array.isArray(lin.entries)) ? lin.entries : [];
  if (!rt.ready || !entries.length) return;
  const src = `${lin.count || 0}:${entries.length}:${rt.kf.length}:${rt.i1}`;
  if (src === rt.birthSrc) return;
  rt.birthSrc = src;
  const out = [];
  for (const e of entries) {
    if (!e || !e.genomeHash) continue;
    const ts = +e.ts || 0;
    out.push({ uid: String(e.genomeHash).toLowerCase(), cron: ts > 0 ? rtCronAtTs(ts) : rt.i0, gen: e.generation | 0 });
  }
  out.sort((a, b) => a.cron - b.cron || (a.uid < b.uid ? -1 : 1));
  rt.births = out;
  // cumulative genome count per keyframe ⇒ the growth curve in the sparkline (one pass, then array-indexed)
  const kb = new Array(rt.kf.length).fill(0);
  let j = 0;
  for (let q = 0; q < rt.kf.length; q++) {
    const cut = rt.kf[q].i1;
    while (j < out.length && out[j].cron <= cut) j++;
    kb[q] = j;
  }
  rt.kfBorn = kb;
  rt.birthTotal = out.length;
}

// ================= cursor =================
/** Ask core for ONE layout pass through the sanctioned one-way hook, deferring it when it would be wasted. */
function rtRequestRebuild() {
  LV.staticKey = '';                             // the bake is stale either way
  // Never rebuild or re-bake mid-gesture (Phase E contract), and NEVER mid-scrub: dragging the thumb across
  // 94 buckets must cost zero layouts, because the reader only cares about where the thumb STOPS.
  if (LV.interacting || rt.dragging) { rt.pending = true; return; }
  if (!rtRebuildOk()) { rt.pending = true; return; }   // playback floor — the newest bucket wins when it drains
  rt.pending = false;
  rt.lastRebuild = performance.now();
  lvForceRebuild();                              // → lvPumpData → LV.hooks.rebuild() on this same frame
}
/** May a re-layout happen right now? Only playback is floored; a manual jump is always immediate. */
function rtRebuildOk() { return !rt.playing || performance.now() - rt.lastRebuild >= RT_REBUILD_MIN_MS; }
/** Recompute the born-set (and the birth flash) for the cursor's keyframe. Only runs on a bucket crossing. */
function rtReborn() {
  rtEnsureBirths();
  const f = rt.kf[rt.kfi]; if (!f) return;
  const cut = f.i1, lo = f.i0;
  const set = new Set(); const flash = [];
  let g = 0;
  for (let j = 0; j < rt.births.length; j++) {
    const b = rt.births[j];
    if (b.cron > cut) break;
    set.add(b.uid);
    if (b.gen > g) g = b.gen;
    if (b.cron >= lo) flash.push(b.uid);         // bred inside this bucket ⇒ the growth flash
  }
  rt.bornSet = set; rt.bornN = set.size; rt.horizonGen = g;
  rt.flash = flash.slice(-RT_FLASH_CAP);
  rt.flashSet = new Set(rt.flash);
  rt.flashT = performance.now();
  rtRequestRebuild();
}
/**
 * Move the cursor. Cheap by construction: one clamp, one division, and — only when the KEYFRAME index moves
 * — one born-set rebuild. Dragging inside a bucket therefore costs nothing at all.
 * @param {number} i  absolute cron index (may be fractional while playing)
 * @param {boolean} force  rebuild the born-set even if the bucket did not move (first landing after a load)
 */
function rtSetIdx(i, force) {
  if (!rt.ready) return;
  rt.idx = clamp(Math.round(Number(i) || 0), rt.i0, rt.i1);
  const kfi = clamp(Math.floor(rt.idx / RT_STEP) - rt.kBase, 0, rt.kf.length - 1);
  if (force || kfi !== rt.kfi) { rt.kfi = kfi; rtReborn(); }
  rtPaint(false);
}
/** Rewind / fast-forward by a whole number of keyframes (the transport's step buttons + arrow keys). */
function rtNudge(keys) {
  if (!rt.ready) return;
  rtSetIdx(rt.idx + keys * RT_STEP);
  rtPaint(true);
}

// ================= per-frame integrator (forwarded from lvInteractFrame, before camApply) =================
/**
 * Advance the playback clock. Mutates replay state only — it never draws and never touches cam, which is why
 * it is safe to run at the top of lvFrame. A running gesture (pan / pinch / zoom / search flight) FREEZES the
 * clock: that both honours the Phase E "no rebuild or re-bake mid-gesture" contract and keeps the reader's
 * framing instead of yanking the tree out from under it.
 * @param {number} now  the rAF timestamp (performance.now() based)
 */
export function lvReplayAdvance(now) {
  if (!rt.on || !rt.ready) return;
  // drain a deferred re-layout: the born set it will read was recomputed when the request was made, and every
  // later crossing overwrote it, so the tree always lands on the NEWEST bucket rather than a stale one.
  if (rt.pending && !LV.interacting && !rt.dragging && rtRebuildOk()) {
    rt.pending = false; rt.lastRebuild = performance.now(); lvForceRebuild();
  }
  if (!rt.playing) { rt.tLast = now; return; }
  if (LV.interacting || rt.dragging) { rt.tLast = now; return; }   // gesture wins: hold the clock
  const dt = rt.tLast ? clamp(now - rt.tLast, 0, RT_DT_CLAMP) : 0;
  rt.tLast = now;
  const next = rt.idx + (RT_CRON_PER_SEC * RT_SPEEDS[rt.speedIx] * dt) / 1000;
  if (next >= rt.i1) { rtPlay(false); rtSetIdx(rt.i1, true); return; }
  rtSetIdx(next);
}

// ================= world-space overlay (forwarded from lvNeuralFrame) =================
/**
 * The growth overlay: a dashed horizon ring on the deepest generation bred so far, plus a birth flash on the
 * genomes that appeared inside the cursor's keyframe and the edges that just connected them. Already in world
 * space (core calls this after camApply). Shed at LVQ.tier ≥ 2 like every other heavy per-frame layer; the
 * TREE ITSELF is baked, so the replay keeps working at any tier — only the flash is dropped.
 * @param {CanvasRenderingContext2D} x
 * @param {number} now
 */
export function lvReplayDraw(x, now) {
  if (!lvReplayOn() || LVQ.tier >= 2) return;
  const f = rt.kf[rt.kfi]; if (!f) return;
  const cx = LV.W / 2, cy = LV.H / 2;
  const warm = mix([80, 140, 200], [200, 120, 40], clamp(f.temp, 0, 1));

  // ---- growth horizon: where the tree currently stops ----
  const hr = ringRadius(rt.horizonGen, LV.maxGen) + 7;
  x.setLineDash([4, 5]); x.lineWidth = 1.1;
  x.strokeStyle = rgba(mix(GILT, warm, 0.35), 0.36);
  x.beginPath(); x.arc(cx, cy, hr, 0, TAU); x.stroke();
  x.setLineDash([]);

  // ---- birth flash: the genomes bred inside this keyframe, and the edges that just appeared ----
  const p = clamp((now - rt.flashT) / RT_FLASH_MS, 0, 1);
  if (p >= 1 || !rt.flash.length) return;
  const a = (1 - p) * (1 - p);
  x.lineWidth = 1.4;
  for (const uid of rt.flash) {
    const n = LV.nodes.get(uid); if (!n) continue;
    const r = nodeR(n);
    x.strokeStyle = rgba(GILT_HI, a * 0.85);
    x.beginPath(); x.arc(n.x, n.y, r + 3 + p * 10, 0, TAU); x.stroke();
    x.fillStyle = rgba(GILT_HI, a * 0.30);
    x.beginPath(); x.arc(n.x, n.y, r + 1.5, 0, TAU); x.fill();
  }
  if (LVQ.tier === 0 && rt.flashSet) {
    x.lineWidth = 1.6; x.strokeStyle = rgba(GILT_HI, a * 0.55);
    for (const e of LV.edges) {
      if (!rt.flashSet.has(e.b)) continue;
      const pa = LV.nodes.get(e.a), pb = LV.nodes.get(e.b);
      if (!pa || !pb) continue;
      x.beginPath(); x.moveTo(pa.x, pa.y); x.lineTo(pb.x, pb.y); x.stroke();
    }
  }
}

// ================= DOM chrome =================
function el(id) { return $(id); }
function setTxt(id, s) { const e = el(id); if (e && e.textContent !== s) e.textContent = s; }
/** The transport's status line: loading / failed / ready-with-count. */
function rtStatus() {
  const e = el('lv-rt-status'); if (!e) return;
  let s;
  if (rt.loading) s = T('lv.rtLoading');
  else if (rt.failed) s = T('lv.rtFailed');
  else if (!rt.ready) s = T('lv.rtNoData');
  else s = T('lv.rtReady', { n: rt.n, k: rt.kf.length });
  if (e.textContent !== s) e.textContent = s;
}
/** Build the metric cells + state chips ONCE per localisation (never per frame, never per paint). */
function rtBuildBody() {
  const host = el('lv-rt-body'); if (!host) return;
  const cell = (id, key) =>
    `<div class="lv-rt-cell"><span class="lv-rt-k">${T(key)}</span>` +
    `<span class="lv-rt-v" id="lv-rt-v-${id}">—</span>` +
    `<span class="lv-rt-bar"><i id="lv-rt-b-${id}"></i></span></div>`;
  host.innerHTML =
    `<div class="lv-rt-grid">${cell('temp', 'lv.rtTemp')}${cell('gini', 'lv.rtGini')}${cell('size', 'lv.rtSize')}` +
    `${cell('deals', 'lv.rtDeals')}${cell('vol', 'lv.rtVol')}</div>` +
    `<div class="lv-rt-states"><span class="lv-rt-k">${T('lv.rtStates')}</span><span class="lv-rt-st">` +
    ST_KEYS.map((k) => `<b data-st="${k}"><i style="background:${rgb(STATE_RGB[k] || GILT)}"></i>` +
      `<u id="lv-rt-s-${k}">0</u><span class="lv-rt-stb"><em id="lv-rt-w-${k}"></em></span></b>`).join('') +
    `</span></div>` +
    `<div class="lv-rt-foot"><span class="lv-rt-mono" id="lv-rt-tick"></span>` +
    `<span class="lv-rt-mono" id="lv-rt-born"></span></div>` +
    `<div class="lv-rt-hint">${T('lv.rtHint')}</div>`;
  for (const k of ST_KEYS) stEls[k] = { v: el('lv-rt-s-' + k), w: el('lv-rt-w-' + k) };
  rt.sparkKey = '';
}
/** Paint the read-outs. Throttled to 10 Hz; a keyframe crossing or a thumb release paints immediately. */
function rtPaint(force) {
  const now = performance.now();
  if (!force && now - rt.lastPaint < RT_PAINT_MS) return;
  rt.lastPaint = now;
  if (!rt.ready) { rtStatus(); return; }
  const f = rt.kf[rt.kfi]; if (!f) return;
  const scrub = el('lv-rt-scrub');
  if (scrub && !rt.dragging && String(scrub.value) !== String(rt.idx)) scrub.value = String(rt.idx);
  // clock: elapsed since the first archived cron + the row's own wall time
  const t0 = rt.kf[0].ts || 0, t1 = f.ts || 0;
  const spanMs = Math.max(0, t1 - t0);
  const dd = Math.floor(spanMs / 86400000);
  const hh = Math.floor((spanMs % 86400000) / 3600000);
  const mm = Math.floor((spanMs % 3600000) / 60000);
  setTxt('lv-rt-clock', T('lv.rtElapsed', { d: dd, h: hh, m: mm }));
  const wall = t1 ? new Date(t1) : null;
  setTxt('lv-rt-when', wall ? `${String(wall.getMonth() + 1).padStart(2, '0')}-${String(wall.getDate()).padStart(2, '0')} ` +
    `${String(wall.getHours()).padStart(2, '0')}:${String(wall.getMinutes()).padStart(2, '0')}` : '—');
  setTxt('lv-rt-tick', T('lv.rtTick', { t: f.tick || 0 }));
  setTxt('lv-rt-born', T('lv.rtBorn', { b: rt.bornN, n: rt.birthTotal || rt.births.length }));
  // metric cells
  const pal = paletteAt(clamp(f.temp, 0, 1));
  const maxSize = rt.maxSize || 1;
  const setCell = (id, text, frac, col) => {
    setTxt('lv-rt-v-' + id, text);
    const b = el('lv-rt-b-' + id);
    if (b) { b.style.width = (clamp(frac, 0, 1) * 100).toFixed(1) + '%'; b.style.background = col; }
  };
  setCell('temp', f.temp.toFixed(3), f.temp, rgb(pal.accent || GILT));
  setCell('gini', f.gini.toFixed(3), f.gini, rgb(mix(INK, GILT, 0.5)));
  setCell('size', String(Math.round(f.size)), f.size / maxSize, 'rgb(63,90,58)');
  setCell('deals', String(Math.round(f.deals)), f.deals / (rt.maxDeals || 1), 'rgb(192,94,60)');
  setCell('vol', (+f.volumeUsdc || 0).toFixed(4), (+f.volumeUsdc || 0) / (rt.maxVol || 1), 'rgb(91,124,141)');
  // topStates chips
  const ts = f.topStates || null;
  let tot = 0;
  if (ts) for (const k of ST_KEYS) tot += +ts[k] || 0;
  for (const k of ST_KEYS) {
    const e = stEls[k]; if (!e) continue;
    const v = ts ? (+ts[k] || 0) : 0;
    if (e.v && e.v.textContent !== String(v)) e.v.textContent = String(v);
    if (e.w) e.w.style.width = (tot > 0 ? (v / tot) * 100 : 0).toFixed(1) + '%';
  }
  // regime chip (glossed, no new dictionary key needed — gl('regime') already carries all 7 languages)
  const rg = el('lv-rt-regime');
  if (rg) {
    const txt = f.regime ? gl('regime', String(f.regime)) : '—';
    if (rg.textContent !== txt) rg.textContent = txt;
    rg.setAttribute('data-r', String(f.regime || '').toUpperCase());
  }
  rtDrawSpark();
}
/** Size the sparkline backing store to its CSS box (called on bind / resize / language switch). */
function rtSizeSpark() {
  const c = el('lv-rt-spark'); if (!c) return;
  const dpr = clamp(Math.min(2, window.devicePixelRatio || 1), 1, 2);
  const w = Math.max(140, Math.round(c.clientWidth || 300));
  const h = 40;
  if (c.width !== Math.round(w * dpr) || c.height !== Math.round(h * dpr)) {
    c.width = Math.round(w * dpr); c.height = Math.round(h * dpr);
    rt.sparkKey = '';
  }
  rt.sparkW = w; rt.sparkH = h; rt.sparkDpr = dpr;
}
/**
 * The growth-curve sparkline: gini + population size + temperature over the whole span, the cumulative genome
 * count as a gold step, and the cursor as a vertical rule. Redrawn at most at the paint throttle, and the
 * series extremes come from rtFinalise — so a paint is ~4 × 94 lineTo calls, never a pass over the archived
 * rows (the C25 "no per-frame scan of the series" requirement).
 */
function rtDrawSpark() {
  const c = el('lv-rt-spark'); if (!c) return;
  const x = c.getContext('2d'); if (!x) return;
  const W = rt.sparkW, H = rt.sparkH, kf = rt.kf, N = kf.length;
  if (!N) return;
  x.setTransform(rt.sparkDpr, 0, 0, rt.sparkDpr, 0, 0);
  x.clearRect(0, 0, W, H);
  const pad = 3, iw = W - pad * 2, ih = H - pad * 2;
  const X = (q) => pad + (N > 1 ? (q / (N - 1)) * iw : iw / 2);
  const Y = (v) => pad + ih - clamp(v, 0, 1) * ih;
  // frame
  x.strokeStyle = rgba(INK, 0.16); x.lineWidth = 1;
  x.strokeRect(pad + 0.5, pad + 0.5, iw - 1, ih - 1);
  // population size (a filled area — the most legible "how big is the colony" channel)
  x.fillStyle = rgba([63, 90, 58], 0.16);
  x.beginPath(); x.moveTo(X(0), Y(0));
  for (let q = 0; q < N; q++) x.lineTo(X(q), Y(kf[q].size / (rt.maxSize || 1)));
  x.lineTo(X(N - 1), Y(0)); x.closePath(); x.fill();
  // cumulative genomes bred (the growth curve), a gold step
  const bt = rt.birthTotal || rt.births.length || 1;
  x.strokeStyle = rgba(GILT, 0.85); x.lineWidth = 1.3;
  x.beginPath();
  for (let q = 0; q < N; q++) { const px = X(q), py = Y((rt.kfBorn[q] || 0) / bt); if (q === 0) x.moveTo(px, py); else x.lineTo(px, py); }
  x.stroke();
  // gini
  x.strokeStyle = rgba(INK, 0.55); x.lineWidth = 1;
  x.beginPath();
  for (let q = 0; q < N; q++) { const px = X(q), py = Y(kf[q].gini); if (q === 0) x.moveTo(px, py); else x.lineTo(px, py); }
  x.stroke();
  // temperature (warm/cool, one segment per keyframe so the season reads as colour, not as a line)
  x.lineWidth = 2;
  for (let q = 1; q < N; q++) {
    const t0 = clamp(kf[q - 1].temp, 0, 1);
    x.strokeStyle = rgba(mix([80, 140, 200], [200, 120, 40], t0), 0.6);
    x.beginPath(); x.moveTo(X(q - 1), H - 1.5); x.lineTo(X(q), H - 1.5); x.stroke();
  }
  // cursor rule + the already-played region
  const cq = clamp(rt.kfi, 0, N - 1);
  x.fillStyle = rgba(GILT_HI, 0.13);
  x.fillRect(pad, pad, Math.max(0, X(cq) - pad), ih);
  x.strokeStyle = rgba(GILT_HI, 0.95); x.lineWidth = 1.4;
  x.beginPath(); x.moveTo(X(cq), pad); x.lineTo(X(cq), pad + ih); x.stroke();
}

// ================= transport =================
function rtPlay(on) {
  if (!rt.ready) return;
  if (on && !rt.playing && rt.idx >= rt.i1) rtSetIdx(rt.i0);   // pressing play at the end rewinds first
  rt.playing = !!on;
  rt.tLast = performance.now();
  const b = el('lv-rt-play');
  if (b) {
    b.textContent = rt.playing ? '❚❚' : '▶';
    b.setAttribute('aria-label', rt.playing ? T('lv.rtPause') : T('lv.rtPlay'));
    b.setAttribute('data-i18n-aria', rt.playing ? 'lv.rtPause' : 'lv.rtPlay');
    b.title = rt.playing ? T('lv.rtPause') : T('lv.rtPlay');
  }
  if (rt.playing) rtPaint(true);
}
function rtCycleSpeed() {
  rt.speedIx = (rt.speedIx + 1) % RT_SPEEDS.length;
  const b = el('lv-rt-speed');
  if (b) {
    b.textContent = `${RT_SPEEDS[rt.speedIx]}×`;
    b.title = T('lv.rtSpeed', { n: RT_SPEEDS[rt.speedIx] });
  }
}
/** Open/close the replay chrome. Opening kicks the (cached, bounded) keyframe load. */
export function lvReplayToggle(force) {
  const host = el('lv-replay');
  const want = force != null ? !!force : !rt.on;
  rt.on = want;
  if (host) host.hidden = !want;
  document.body.classList.toggle('lv-rt-open', want);
  const tb = document.querySelector('#lv-toolbar .lv-tb[data-lv="replay"]');
  if (tb) tb.setAttribute('aria-pressed', want ? 'true' : 'false');
  if (want) {
    rtBuildBody();
    rtSizeSpark();
    rtStatus();
    if (rt.ready) { lvReplaySyncRange(); rtSetIdx(rt.idx, true); rtPaint(true); }
    else rtLoad();
  } else {
    rtPlay(false);
    rt.dragging = false;
    if (rt.ready) { rt.kfi = -1; rt.bornSet = null; rtRequestRebuild(); }   // restore the full tree
  }
}
/**
 * Halt everything the replay owns. Called from lineageView.closeLineageView so a hidden atlas does ZERO work:
 * the transport stops, the in-flight page fetch is aborted, and the layout is flagged for one rebuild on the
 * next open. There are no timers to clear — playback is rAF-integrated, so it stops with the frame loop.
 */
export function lvReplayStop() {
  rtPlay(false);
  rt.on = false; rt.dragging = false; rt.pending = false;
  if (rt.ctrl) { try { rt.ctrl.abort(); } catch { /* already settled */ } rt.ctrl = null; }
  rt.loading = false; rt.kfMap = null;
  const host = el('lv-replay'); if (host) host.hidden = true;
  document.body.classList.remove('lv-rt-open');
  const tb = document.querySelector('#lv-toolbar .lv-tb[data-lv="replay"]');
  if (tb) tb.setAttribute('aria-pressed', 'false');
  if (rt.ready) { rt.kfi = -1; rt.bornSet = null; lvForceRebuild(); }
}
/**
 * Wire the replay chrome. Called once from lineageView.initLineageView. Every gesture goes through the
 * pointer/input events of the range input itself — the atlas canvas's unified pointer entry (lvInteractBind)
 * is never bypassed, because the scrubber is a DOM sibling ABOVE the canvas inside #lv-ui, exactly like the
 * Phase E search box.
 */
export function lvReplayBind() {
  if (rt.bound) return;
  const host = el('lv-replay'); if (!host) return;
  rt.bound = true;
  const scrub = el('lv-rt-scrub');
  if (scrub) {
    // pointerdown/up rather than change: the thumb must enter "skeleton" mode for the whole drag, and the
    // single rebuild + re-bake must land on release, not on every input event.
    scrub.addEventListener('pointerdown', () => { rt.dragging = true; LV.staticKey = ''; });
    const up = () => {
      if (!rt.dragging) return;
      rt.dragging = false;
      rtSetIdx(rt.idx, true);                    // one born-set rebuild ⇒ one rebuild ⇒ one re-bake
      rtPaint(true);
    };
    scrub.addEventListener('pointerup', up);
    scrub.addEventListener('pointercancel', up);
    scrub.addEventListener('lostpointercapture', up);
    scrub.addEventListener('input', () => { rtSetIdx(+scrub.value || 0); });
    // a keyboard arrow is a discrete jump, not a drag: let it rebuild immediately
    scrub.addEventListener('keydown', (ev) => { ev.stopPropagation(); });
    scrub.addEventListener('change', () => { if (!rt.dragging) { rtSetIdx(+scrub.value || 0, true); rtPaint(true); } });
  }
  host.addEventListener('keydown', (ev) => { ev.stopPropagation(); });   // never leak to a global shortcut
  host.addEventListener('click', (ev) => {
    const b = ev.target.closest('button'); if (!b) return;
    ev.stopPropagation();
    if (b.id === 'lv-rt-play') rtPlay(!rt.playing);
    else if (b.id === 'lv-rt-speed') rtCycleSpeed();
    else if (b.id === 'lv-rt-back') rtNudge(-1);
    else if (b.id === 'lv-rt-fwd') rtNudge(1);
    else if (b.id === 'lv-rt-close') lvReplayToggle(false);
  });
  // the mobile soft keyboard / an orientation change resizes the CSS box ⇒ resize the sparkline backing store
  window.addEventListener('resize', () => {
    const h = el('lv-replay');
    if (rt.on && h && !h.hidden) { rtSizeSpark(); rtPaint(true); }
  });
}
/** Re-localise the replay chrome on a language switch (called from lineageView.lvRelocalise). */
export function lvReplayRelocalise() {
  const host = el('lv-replay'); if (!host) return;
  const wasOpen = !host.hidden;
  rtBuildBody();
  const pb = el('lv-rt-play');
  if (pb) { pb.setAttribute('aria-label', rt.playing ? T('lv.rtPause') : T('lv.rtPlay')); pb.title = pb.getAttribute('aria-label'); }
  const bb = el('lv-rt-back'); if (bb) { bb.setAttribute('aria-label', T('lv.rtBack')); bb.title = T('lv.rtBack'); }
  const fb = el('lv-rt-fwd'); if (fb) { fb.setAttribute('aria-label', T('lv.rtFwd')); fb.title = T('lv.rtFwd'); }
  const sb = el('lv-rt-speed'); if (sb) { sb.title = T('lv.rtSpeed', { n: RT_SPEEDS[rt.speedIx] }); sb.setAttribute('aria-label', T('lv.rtSpeedTitle')); }
  const cb = el('lv-rt-close'); if (cb) { cb.setAttribute('aria-label', T('lv.rtClose')); cb.title = cb.getAttribute('aria-label'); }
  const sc = el('lv-rt-scrub'); if (sc) sc.setAttribute('aria-label', T('lv.rtScrubAria'));
  if (wasOpen) { rtSizeSpark(); rtStatus(); rtPaint(true); }
}
/** Sync the scrubber's range to the loaded table (called after a load and on relocalise). */
export function lvReplaySyncRange() {
  const scrub = el('lv-rt-scrub'); if (!scrub || !rt.ready) return;
  scrub.min = String(rt.i0); scrub.max = String(rt.i1); scrub.step = '1';
  scrub.value = String(clamp(rt.idx, rt.i0, rt.i1));
}
