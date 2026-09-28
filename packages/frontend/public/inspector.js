// inspector.js — select/deselect + fillInspector + neural feed + bloom/raster canvas
// 由 app.js 机械拆分（任务5），行为与原文件一致；原文件保留为 app.js 备份参考。
import { state, $, FAP_GLOSS, FAP_ROLE, KIND_COL, NM_REF_HZ, STATE_COLOR, TAU, clamp, fapColor, houseOf, mix, nmDaHz, nmHzIsReal, nmOaHz, paletteAt, rgba, sim } from './shared.js';
import { t as T } from './i18n.js?v=110';
import { closeHistory, closePredict, closePulse, closeWallets } from './drawers.js';
import { updateWallet } from './economy.js';
import { getJSON, synthAgentFor } from './polling.js';

// ================= inspector =================
export const DRIVES = [["arousal", "arousal", false], ["turn", "turn bias", true], ["cohesion", "cohesion", false], ["wingbeat", "wingbeat", false], ["rest", "rest", false]];
export function select(id) {
  if (state.walletsOpen) closeWallets();   // selecting a fly (from canvas or roster) hands the right side to the inspector
  if (state.historyOpen) closeHistory();
  if (state.pulseOpen) closePulse();
  if (state.predictOpen) closePredict();
  state.selectedId = id;
  const ins = $("inspector");
  ins.hidden = false;
  document.body.classList.add("ins-open");
  requestAnimationFrame(() => ins.classList.add("open"));
  $("hint-select").classList.add("hide");
  fillInspectorFromSim(id);
  startNeuralFeed(id);          // live bloom + spike raster (performance-safe) for this fly
}
export function deselect() {
  state.selectedId = null;
  stopNeuralFeed();
  document.body.classList.remove("ins-open");
  const ins = $("inspector");
  ins.classList.remove("open");
  setTimeout(() => { if (state.selectedId == null) ins.hidden = true; }, 520);
}
export function fillInspectorFromSim(id) {
  const f = sim.get(id);
  if (!f) return;
  $("ins-id").textContent = "#" + id;
  const stEl = $("ins-state");
  stEl.textContent = (f.state || "—").toLowerCase();
  stEl.style.background = STATE_COLOR[f.state] || "var(--accent)";
  renderDrives(f);
  renderEthogram(f);
  $("ins-temp").textContent = (f.temperament ?? 0).toFixed(2);
  $("ins-fp").textContent = f.fingerprint || "–";
  refreshInspectorSocial(id);
}
/** The inspector's social line: colony · allies · feuds · house (the lineage + society read-out). */
export function refreshInspectorSocial(id) {
  const el = $("ins-social");
  if (!el) return;
  const parts = [];
  if (state.societies) {
    const ci = state.societies.colonyOf.get(id);
    if (ci != null && state.societies.colonies[ci]) parts.push(state.societies.colonies[ci].name);
    let al = 0, fe = 0;
    for (const p of state.societies.allies) if (p.a === id || p.b === id) al++;
    for (const p of state.societies.feuds) if (p.a === id || p.b === id) fe++;
    parts.push(T(al === 1 ? "ins.ally" : "ins.allies", { n: al }), T(fe === 1 ? "ins.feud" : "ins.feuds", { n: fe }));
  }
  const h = houseOf.get(id);
  parts.push(h ? `${h.sigil ? h.sigil + " " : ""}` + T("ins.houseOf", { name: h.name }) : T("dyn.noHouse"));
  el.textContent = parts.join(" · ");
}
export function renderDrives(f) {
  const host = $("ins-drives");
  if (!host.children.length) {
    host.innerHTML = DRIVES.map(
      ([k, label]) => `<div class="drive ${k}"><span class="d-name">${T("drive." + k)}</span><span class="d-bar"><span class="d-fill"></span></span><span class="d-val">0.00</span></div>`
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
// Ethogram panel: the named action pattern (FAP) badge + gloss, the implied economic role, the
// approach/avoid valence bar and the persistent ring-attractor compass. All read-out — none of it
// is a settlement input; it only makes the fly's inner state legible.
export function renderEthogram(f) {
  const fap = f.fap || "FORAGE";
  const badge = $("ins-fap");
  if (badge) { badge.textContent = fap.toLowerCase(); badge.style.background = fapColor(fap); }
  const gl = $("ins-fap-gloss"); if (gl) gl.textContent = FAP_GLOSS[fap] || "";
  const role = $("ins-role"); if (role) role.textContent = f.role || FAP_ROLE[fap] || "—";
  // valence: a centred −1..1 bar (appetitive fills right, aversive fills left)
  const v = clamp(f.valence || 0, -1, 1);
  const vFill = $("ins-val-fill");
  if (vFill) {
    const pct = Math.abs(v) * 50;
    vFill.style.width = pct + "%";
    vFill.style.left = (v >= 0 ? 50 : 50 - pct) + "%";
    vFill.style.background = v >= 0 ? "#7d9a4a" : "#b04a3a";
  }
  const vVal = $("ins-val"); if (vVal) vVal.textContent = (v >= 0 ? "+" : "") + v.toFixed(2);
  // heading: the persistent internal compass in degrees
  const h = f.tHeading != null ? f.tHeading : (f.sHead != null ? f.sHead : 0);
  const deg = ((h * 180 / Math.PI) % 360 + 360) % 360;
  const hEl = $("ins-heading"); if (hEl) hEl.textContent = deg.toFixed(0) + "°";
  const nd = $("ins-heading-needle"); if (nd) nd.style.transform = "rotate(" + deg + "deg)";
  renderBouts(f);
}
// The behaviour ribbon: the recent bout sequence (oldest → newest) the server's inhibition hierarchy
// committed, plus the action still running. Each segment is a FAP, its width ∝ how many ticks it held —
// so you watch one fly's behaviour unfold as a timeline of named actions.
export function renderBouts(f) {
  const host = $("ins-ribbon");
  if (!host) return;
  const bouts = Array.isArray(f.bouts) ? f.bouts : [];
  const segs = bouts.map((b) => ({ fap: b.fap || "FORAGE", ticks: Math.max(1, b.ticks | 0), live: false }));
  segs.push({ fap: f.fap || "FORAGE", ticks: Math.max(1, f.boutAge || 1), live: true });
  const tail = segs.slice(-9);                       // keep the ribbon to the most recent handful
  const total = tail.reduce((a, b) => a + b.ticks, 0) || 1;
  host.innerHTML = tail.map((sg) => {
    const wide = sg.ticks / total > 0.13;
    return `<span class="rb-seg${sg.live ? " live" : ""}" style="flex:${sg.ticks};background:${fapColor(sg.fap)}" ` +
      `title="${sg.fap.toLowerCase()} · ${sg.ticks} tick${sg.ticks === 1 ? "" : "s"}${sg.live ? " · now" : ""}">${wide ? sg.fap.toLowerCase() : ""}</span>`;
  }).join("");
}
// ================= live neural feed (bloom + spike raster), performance-safe =================
// The bloom and the raster are rebuilt into OFFSCREEN canvases only a few times per second, and
// each animation frame merely blits the cached result with a single drawImage — so opening the
// inspector adds ~2 cheap blits per frame, never hundreds of strokes. The /snapshot poll runs at
// a slow cadence behind an in-flight guard (overlapping requests are impossible) and a debounce
// collapses click-bursts into one read, so rapid clicking can never pile up network or canvas work.
export const RASTER_WINDOW_MS = 6000;
export const BLOOM_REBUILD_MS = 250;
// rebuild offscreen bloom ~4x/sec
export const RASTER_REBUILD_MS = 125;
// rebuild offscreen raster ~8x/sec
export const NEURAL_INTERVAL_MS = 1000;
// one snapshot/synth per second while a fly is selected
export const NEURAL_DEBOUNCE_MS = 150;
export function neuralLoad(id) {
  if (state.neuralFeedId !== id) return;
  if (state.offline || Date.now() < state.offlineUntil) synthNeural(id);
  else fetchNeural(id);
}
export function startNeuralFeed(id) {
  stopNeuralFeed();
  state.neuralFeedId = id;
  state.rasterCols = [];
  state.neuralDebounce = setTimeout(() => { state.neuralDebounce = null; neuralLoad(id); }, NEURAL_DEBOUNCE_MS);
  state.neuralTimer = setInterval(() => { if (state.neuralFeedId === id && !state.neuralInFlight) neuralLoad(id); }, NEURAL_INTERVAL_MS);
}
export function stopNeuralFeed() {
  if (state.neuralDebounce) { clearTimeout(state.neuralDebounce); state.neuralDebounce = null; }
  if (state.neuralTimer) { clearInterval(state.neuralTimer); state.neuralTimer = null; }
  if (state.neuralCtrl) { state.neuralCtrl.abort(); state.neuralCtrl = null; }
  state.neuralInFlight = false;
  state.neuralFeedId = null;
  state.rasterCols = [];
  state.bloomData = null;
  if (state.bloomOffCtx) state.bloomOffCtx.clearRect(0, 0, state.bloomOff.width, state.bloomOff.height);
  if (state.rasterOffCtx) state.rasterOffCtx.clearRect(0, 0, state.rasterOff.width, state.rasterOff.height);
  // task 15: drop the shared pixel stage's buffers too, so a re-select never shows the last fly's heat/membrane
  state.heatCols = [];
  state.membData = null; state.membRange = null;
  if (state.heatOffCtx) state.heatOffCtx.clearRect(0, 0, state.heatOff.width, state.heatOff.height);
  if (state.nmapOffCtx) state.nmapOffCtx.clearRect(0, 0, state.nmapOff.width, state.nmapOff.height);
  const nm = $("nmap"); if (nm) nm.getContext("2d").clearRect(0, 0, nm.width, nm.height);
  const bc = $("bloom"); if (bc) bc.getContext("2d").clearRect(0, 0, bc.width, bc.height);
  const rc = $("raster"); if (rc) rc.getContext("2d").clearRect(0, 0, rc.width, rc.height);
  const hz = $("raster-hz"); if (hz) hz.textContent = "";
}
export async function fetchNeural(id) {
  if (state.neuralFeedId !== id || state.neuralInFlight) return;
  state.neuralInFlight = true;
  if (state.neuralCtrl) state.neuralCtrl.abort();
  state.neuralCtrl = new AbortController();
  try {
    const s = await getJSON(`/snapshot?flyId=${id}`, 3000, state.neuralCtrl.signal);
    if (state.neuralFeedId !== id) return;
    state.bloomData = { rates: s.firingRates || [], kinds: s.neuronKinds || [] };
    const N = s.neuronCount || state.bloomData.rates.length || 0;
    state.bloomData.N = N;
    setNeuronCount(N);
    $("ins-t").textContent = (s.t || 0).toFixed(0);
    if (s.agent) updateWallet(s.agent);
    // task 22 ①: the worker's toCompact() never packs the per-neuron spiking array, so /snapshot.spikesLastStep
    // is all-zero in production and the raster + heatmap starve. firingRates IS real (33–47 % non-zero), so we
    // derive a pseudo-spike vector from it. The raster wants the list of FIRING INDICES; the heatmap wants the
    // 0/1 DENSITY VECTOR — pass each its correct representation (matching synthNeural's offline contract).
    const rates = s.firingRates || [];
    const ps = rates.length ? derivePseudoSpikes(rates) : { vec: new Uint8Array(0), idx: [], n: 0 };
    pushSpikes(ps.idx, N || 10800);
    pushHeat(ps.vec, N || 10800);
    setMembrane(s.membrane);
    // push neuromod sample into the scope ring buffer
    if (s.neuromod) pushScopeSample(s.neuromod);
  } catch (e) {
    if (state.neuralFeedId !== id) return;
    synthNeural(id);
  } finally {
    state.neuralInFlight = false;
  }
}
// ================= task 22: pseudo-spike derivation =================
// Production reality: /snapshot.spikesLastStep is always all-zero (the worker's toCompact() does not pack the
// spiking array), yet the raster + spike-density heatmap both need a 0/1 spike vector. We DERIVE one from
// firingRates — the only real per-neuron activity the snapshot ships. A neuron counts as having spiked in the
// last step when its instantaneous rate clears PSEUDO_SPIKE_HZ.
//   Threshold rationale: the live brain keeps ~33–47 % of neurons above ~1 Hz, but "merely excitable" is not
//   "fired this step". A rate of ~12 Hz means one spike per ~83 ms — the order of a single sim step — so 12 Hz
//   cleanly separates actually-firing from background tonic activity without collapsing the raster to nothing.
//   Semantics: these are DERIVED pseudo-spikes, not recorded ones (the read-outs are labelled accordingly).
export const PSEUDO_SPIKE_HZ = 12;
/** True when a spikesLastStep vector carries at least one real spike, so a future worker that ships it wins. */
export function hasRealSpikes(sp) {
  if (!sp || !sp.length) return false;
  for (let i = 0; i < sp.length; i++) if (sp[i]) return true;
  return false;
}
/** Derive {vec:Uint8Array 0/1, idx:firing indices, n} from a firingRates (Hz) array by thresholding. */
export function derivePseudoSpikes(rates, thresh = PSEUDO_SPIKE_HZ) {
  const n = rates && rates.length ? rates.length : 0;
  const vec = new Uint8Array(n);
  const idx = [];
  for (let i = 0; i < n; i++) { if (rates[i] >= thresh) { vec[i] = 1; idx.push(i); } }
  return { vec, idx, n };
}
export function pushSpikes(spikes, N) {
  const raw = Array.isArray(spikes) ? spikes : (spikes && spikes.length ? Array.from(spikes) : []);
  // task 22 ②: the HUD numerator must be the REAL firing count. The old code reported the POST-subsample
  // arr.length (capped at 180), so it always read "180 / 10361 firing". Count truthfully BEFORE subsampling:
  // an index list's length IS the spike count; a 0/1 density vector reduces (sums) to it.
  const isVec = raw.length > 180 && raw.length === (N || 0);
  const firing = isVec ? raw.reduce((a, v) => a + (v ? 1 : 0), 0) : raw.length;
  let arr = raw;
  if (arr.length > 180) arr = arr.filter((_, i) => i % Math.ceil(arr.length / 180) === 0);  // subsample for drawing only
  state.rasterCols.push({ t: performance.now(), spikes: arr, N: N || 10800 });
  const now = performance.now();
  while (state.rasterCols.length && now - state.rasterCols[0].t > RASTER_WINDOW_MS) state.rasterCols.shift();
  const hz = $("raster-hz");
  if (hz) hz.textContent = `${firing} / ${N || 10800} firing`;
}
// offline / pre-deploy: synthesise a believable spike column + bloom for this fly
export function synthNeural(id) {
  const f = sim.get(id);
  const aro = f ? f.tAro : 0.4;
  const N = 10800, rates = new Array(N), kinds = new Array(N), spikes = [], spikeVec = new Uint8Array(N), memb = new Array(N);
  for (let i = 0; i < N; i++) {
    const u = i / N;
    const kind = u < 0.167 ? "sensory" : u < 0.907 ? "inter" : u < 0.944 ? "modulatory" : "motor";
    kinds[i] = kind;
    const base = kind === "motor" ? aro : kind === "sensory" ? state.tempSmoothed : 0.2 + aro * 0.6;
    const rate = clamp(base * 0.7 + Math.random() * 0.5);
    rates[i] = rate * 70;
    if (Math.random() < rate * 0.5) { spikes.push(i); spikeVec[i] = 1; }
    memb[i] = -68 + rate * 22 + (Math.random() - 0.5) * 6;   // a plausible mV swing around rest
  }
  state.bloomData = { rates, kinds, N };
  setNeuronCount(N, "~");
  $("ins-t").textContent = "—";
  updateWallet(synthAgentFor(id));   // offline: show this fly's local mirror wallet
  pushSpikes(spikes, N);
  // task 15: offline heat + membrane so both new views have something honest to show pre-deploy
  pushHeat(spikeVec, N);
  setMembrane(memb);
  // offline scope: synthesise a plausible neuromod sample from arousal
  pushScopeSample({ dopamine: aro * 0.4 + Math.random() * 0.15, octopamine: aro * 0.3 + Math.random() * 0.1 });
}
export function setNeuronCount(N, prefix = "") {
  const el = $("ins-ncount");
  if (!el) return;
  if (state.ncountRaf) cancelAnimationFrame(state.ncountRaf);
  const from = state.ncountShown || 1080;
  if (from === N) { el.textContent = prefix + N.toLocaleString(); return; }
  const start = performance.now(), dur = 850;
  const step = (now) => {
    const p = Math.min(1, (now - start) / dur);
    const e = 1 - Math.pow(1 - p, 3);                        // easeOutCubic
    el.textContent = prefix + Math.round(from + (N - from) * e).toLocaleString();
    if (p < 1) { state.ncountRaf = requestAnimationFrame(step); } else { state.ncountShown = N; state.ncountRaf = 0; }
  };
  state.ncountRaf = requestAnimationFrame(step);
}
// brain-size compare toggle: re-render the SAME live bloom at the sparse 1,080 launch density vs the live
// count, so a visitor can see the ~9.6× difference directly instead of taking our word for it.
export function bindBloomScale() {
  const host = $("bloom-scale");
  if (!host) return;
  host.addEventListener("click", (e) => {
    const btn = e.target.closest(".bs-btn");
    if (!btn) return;
    state.bloomShowBefore = btn.dataset.before === "1";
    for (const b of host.querySelectorAll(".bs-btn")) b.classList.toggle("is-on", b === btn);
    state.bloomLast = 0;                                           // force an immediate offscreen rebuild next frame
  });
}
// rebuild the offscreen bloom from bloomData at a low rate (≤ ~1,200 strokes, NOT per frame)
export function rebuildBloom() {
  const c = $("bloom");
  if (!c || !state.bloomData) return;
  if (!state.bloomOff) {
    state.bloomOff = document.createElement("canvas");
    state.bloomOff.width = c.width; state.bloomOff.height = c.height;
    state.bloomOffCtx = state.bloomOff.getContext("2d");
  }
  const x = state.bloomOffCtx, W = state.bloomOff.width, H = state.bloomOff.height, cxr = W / 2, cyr = H / 2;
  x.clearRect(0, 0, W, H);
  const { rates, kinds } = state.bloomData;
  const N = rates.length;
  if (!N) return;
  // Perceived density scales with the REAL neuron count (bloomData.N): a live ~10,361-neuron brain (FlyWire
  // literal FAFB_783) blooms ~9.6× denser than the 1,080 launch size, so the upgrade is something you SEE, not
  // just a number you read. bloomShowBefore (the compare toggle) forces the sparse 1,080-equivalent for a side-by-side.
  const SAMPLE_STRIDE = 9;                                   // ≈1,200 strokes at ~10,800n — offscreen + rebuilt 4×/s, so cheap
  const realN = state.bloomData.N || N;
  const target = Math.max(1, state.bloomShowBefore ? Math.floor(1080 / SAMPLE_STRIDE) : Math.floor(realN / SAMPLE_STRIDE));
  const stride = Math.max(1, Math.floor(N / target));
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
  const acc = paletteAt(state.tempSmoothed).accent;
  x.fillStyle = rgba(acc, 0.6);
  x.beginPath(); x.arc(cxr, cyr, 3.4, 0, TAU); x.fill();
}
// per frame: one rotated blit of the cached bloom
export function renderBloom(now) {
  const c = $("bloom");
  if (!c || !state.bloomData) return;
  if (now - state.bloomLast >= BLOOM_REBUILD_MS) { state.bloomLast = now; rebuildBloom(); }
  if (!state.bloomOff) return;
  const x = c.getContext("2d");
  x.clearRect(0, 0, c.width, c.height);
  state.bloomAngle += 0.0016;
  x.save();
  x.translate(c.width / 2, c.height / 2);
  x.rotate(state.bloomAngle);
  x.drawImage(state.bloomOff, -c.width / 2, -c.height / 2);
  x.restore();
}
// rebuild the offscreen raster from the rolling spike columns at a low rate
export function rebuildRaster(now) {
  const c = $("raster");
  if (!c) return;
  if (!state.rasterOff) {
    state.rasterOff = document.createElement("canvas");
    state.rasterOff.width = c.width; state.rasterOff.height = c.height;
    state.rasterOffCtx = state.rasterOff.getContext("2d");
  }
  const x = state.rasterOffCtx, W = state.rasterOff.width, H = state.rasterOff.height;
  x.clearRect(0, 0, W, H);
  if (!state.rasterCols.length) return;
  const dot = mix([26, 26, 24], paletteAt(state.tempSmoothed).accent, 0.5);
  for (const col of state.rasterCols) {
    const age = (now - col.t) / RASTER_WINDOW_MS;
    if (age < 0 || age > 1) continue;
    const cx = W - age * W;                 // newest at the right, scrolling left
    const N = col.N || 10800;
    x.fillStyle = rgba(dot, 0.55 * (1 - age * 0.7));
    for (const idx of col.spikes) x.fillRect(cx, (idx / N) * H, 1.5, 1.5);
  }
}
// per frame: one blit of the cached raster
export function renderRaster(now) {
  const c = $("raster");
  if (!c) return;
  if (now - state.rasterLast >= RASTER_REBUILD_MS) { state.rasterLast = now; rebuildRaster(now); }
  if (!state.rasterOff) return;
  const x = c.getContext("2d");
  x.clearRect(0, 0, c.width, c.height);
  x.drawImage(state.rasterOff, 0, 0);
}

// ================= neuromodulator scope (task nm4): dual-trace DA/OA oscilloscope =================
// Ring buffer ~120 points; offscreen rebuild ≤4 Hz + single blit per frame.
// Data source: /snapshot neuromod (1 s) when a fly is selected; otherwise collective mean from /population.
export const SCOPE_MAX_POINTS = 120;
export const SCOPE_REBUILD_MS = 250;   // ≤4 Hz offscreen rebuild

/** Push one neuromod sample into the ring buffer (called from fetchNeural / synthNeural / poll). */
export function pushScopeSample(nm) {
  const da = nmDaHz(nm), oa = nmOaHz(nm);
  state.scopeHzReal = nmHzIsReal(nm);
  state.scopeRing.push({ t: performance.now(), daHz: da, oaHz: oa });
  if (state.scopeRing.length > SCOPE_MAX_POINTS) state.scopeRing.shift();
}

/** Push the collective mean as a scope sample (called from the /population poll when no fly is selected). */
export function pushScopeCollective() {
  const m = state.nmMean;
  if (!m || !m.n) return;
  state.scopeRing.push({ t: performance.now(), daHz: m.daHz, oaHz: m.oaHz });
  if (state.scopeRing.length > SCOPE_MAX_POINTS) state.scopeRing.shift();
}

/** Rebuild the offscreen scope canvas from the ring buffer (low frequency, ≤4 Hz). */
export function rebuildScope() {
  const c = $("scope");
  if (!c) return;
  if (!state.scopeOff) {
    state.scopeOff = document.createElement("canvas");
    state.scopeOff.width = c.width; state.scopeOff.height = c.height;
    state.scopeOffCtx = state.scopeOff.getContext("2d");
  }
  const x = state.scopeOffCtx, W = state.scopeOff.width, H = state.scopeOff.height;
  x.clearRect(0, 0, W, H);
  const ring = state.scopeRing;
  if (ring.length < 2) return;
  const refHz = NM_REF_HZ;   // full-scale axis
  const padL = 4, padR = 4, padT = 10, padB = 14;
  const gW = W - padL - padR, gH = H - padT - padB;
  // grid lines: 0, 25%, 50%, 75%, 100% of refHz
  x.strokeStyle = "rgba(128,128,128,0.12)"; x.lineWidth = 0.5;
  for (let i = 0; i <= 4; i++) {
    const y = padT + gH - (i / 4) * gH;
    x.beginPath(); x.moveTo(padL, y); x.lineTo(padL + gW, y); x.stroke();
  }
  // draw traces
  const drawTrace = (key, color) => {
    x.strokeStyle = color; x.lineWidth = 1.2;
    x.beginPath();
    for (let i = 0; i < ring.length; i++) {
      const px = padL + (i / (SCOPE_MAX_POINTS - 1)) * gW;
      const py = padT + gH - clamp(ring[i][key] / refHz) * gH;
      if (i === 0) x.moveTo(px, py); else x.lineTo(px, py);
    }
    x.stroke();
  };
  drawTrace("daHz", "rgba(200,120,40,0.85)");   // DA: warm amber
  drawTrace("oaHz", "rgba(80,140,200,0.85)");   // OA: cool blue
  // axis labels
  const approx = state.scopeHzReal ? "" : "\u2248";
  x.font = "8px monospace"; x.fillStyle = "rgba(128,128,128,0.7)";
  x.fillText(approx + refHz + " Hz", padL, padT - 2);
  x.fillText("0", padL, H - 3);
  // legend
  x.fillStyle = "rgba(200,120,40,0.9)"; x.fillText("DA", W - 46, padT - 2);
  x.fillStyle = "rgba(80,140,200,0.9)"; x.fillText("OA", W - 24, padT - 2);
  // current values
  const last = ring[ring.length - 1];
  x.fillStyle = "rgba(200,120,40,0.9)";
  x.fillText((last.daHz).toFixed(1) + " Hz", padL + 2, H - 3);
  x.fillStyle = "rgba(80,140,200,0.9)";
  x.fillText((last.oaHz).toFixed(1) + " Hz", padL + 46, H - 3);
}

/** Per frame: rebuild offscreen at ≤4 Hz then blit once. */
export function renderScope(now) {
  const c = $("scope");
  if (!c) return;
  if (now - state.scopeLast >= SCOPE_REBUILD_MS) { state.scopeLast = now; rebuildScope(); }
  if (!state.scopeOff) return;
  const x = c.getContext("2d");
  x.clearRect(0, 0, c.width, c.height);
  x.drawImage(state.scopeOff, 0, 0);
}

// ================= task 15: spike-density heatmap + membrane-potential map (the shared #nmap stage) =================
// Both new views paint into ONE canvas (#nmap); state.nview decides which offscreen rebuild runs. Exactly like
// #bloom / #raster / #scope above, each is rebuilt into an offscreen canvas at ≤4 Hz and reaches the screen as a
// single drawImage per frame — the per-frame cost is one blit, never a per-neuron traversal. The one heavy pass
// over the ~10,361-neuron spike vector happens in pushHeat, once per /snapshot poll (≤1 Hz), NOT per frame.
export const HEAT_ROWS = 140;        // neuron strata on y — the ~10,361-neuron spike vector is banded down to this
export const HEAT_COLS = 180;        // poll columns on x — a ring buffer, one column per /snapshot (~3 min at 1/s)
export const NMAP_REBUILD_MS = 250;  // ≤4 Hz offscreen rebuild for the shared pixel stage

// density ramp (vellum → gold → rust) for the spike heatmap; mirrors .nmap-ramp in styles.css
const HEAT_STOPS = [[245, 240, 229], [214, 176, 84], [176, 74, 58]];
// diverging ramp (verdigris → slate → vellum → gold → rust) for membrane potential; mirrors [data-nvmap="memb"]
const MEMB_STOPS = [[58, 110, 104], [125, 148, 160], [238, 231, 214], [214, 176, 84], [176, 74, 58]];
function rampAt(stops, p) {
  const t = clamp(p) * (stops.length - 1);
  const i = Math.min(stops.length - 2, Math.floor(t));
  return mix(stops[i], stops[i + 1], t - i);
}
// 256-entry RGB look-up tables so the ≤4 Hz rebuild is a table read per cell, never a per-cell colour mix
function buildLut(stops) {
  const a = new Uint8Array(256 * 3);
  for (let i = 0; i < 256; i++) { const c = rampAt(stops, i / 255); a[i * 3] = c[0] | 0; a[i * 3 + 1] = c[1] | 0; a[i * 3 + 2] = c[2] | 0; }
  return a;
}
const HEAT_LUT = buildLut(HEAT_STOPS);
const MEMB_LUT = buildLut(MEMB_STOPS);

/** Fold one poll's per-neuron 0/1 spike vector into HEAT_ROWS strata (mean firing per band, 0..255) and push a column. */
export function pushHeat(spikes, N) {
  const rows = new Uint8Array(HEAT_ROWS);
  if (spikes && spikes.length) {
    const n = spikes.length, band = n / HEAT_ROWS;
    for (let r = 0; r < HEAT_ROWS; r++) {
      const i0 = Math.floor(r * band), i1 = Math.min(n, Math.floor((r + 1) * band));
      let sum = 0, cnt = 0;
      for (let i = i0; i < i1; i++) { if (spikes[i]) sum++; cnt++; }
      rows[r] = cnt ? Math.round((sum / cnt) * 255) : 0;
    }
  }
  state.heatCols.push({ t: performance.now(), rows });
  if (state.heatCols.length > HEAT_COLS) state.heatCols.shift();   // ring buffer: oldest poll scrolls off
}

/** Cache the latest membrane[] read-out and its min/max (drives the diverging legend). null when the field is absent. */
export function setMembrane(memb) {
  if (!Array.isArray(memb) || !memb.length) { state.membData = null; state.membRange = null; return; }
  let mn = Infinity, mx = -Infinity;
  for (let i = 0; i < memb.length; i++) { const v = memb[i]; if (v < mn) mn = v; if (v > mx) mx = v; }
  if (!isFinite(mn) || !isFinite(mx)) { state.membData = null; state.membRange = null; return; }
  state.membData = memb;
  state.membRange = { min: mn, max: mx };
}

/** Rebuild the offscreen spike-density heatmap (HEAT_COLS × HEAT_ROWS) from the column ring. Called ≤4 Hz. */
export function rebuildHeat() {
  if (!state.heatOff) {
    state.heatOff = document.createElement("canvas");
    state.heatOff.width = HEAT_COLS; state.heatOff.height = HEAT_ROWS;
    state.heatOffCtx = state.heatOff.getContext("2d");
    state.heatImg = state.heatOffCtx.createImageData(HEAT_COLS, HEAT_ROWS);
  }
  const data = state.heatImg.data, cols = state.heatCols, len = cols.length, x0 = HEAT_COLS - len;
  for (let c = 0; c < HEAT_COLS; c++) {
    const col = c >= x0 ? cols[c - x0] : null;                 // right-align: the newest poll sits at the far right
    for (let r = 0; r < HEAT_ROWS; r++) {
      const o = (r * HEAT_COLS + c) * 4;
      if (!col) { data[o] = 0; data[o + 1] = 0; data[o + 2] = 0; data[o + 3] = 0; continue; }  // empty (future) cell
      const v = col.rows[r], o3 = v * 3;                        // 0..255 density → LUT
      data[o] = HEAT_LUT[o3]; data[o + 1] = HEAT_LUT[o3 + 1]; data[o + 2] = HEAT_LUT[o3 + 2];
      data[o + 3] = v ? 255 : 0;                                // a silent stratum stays transparent (vellum shows through)
    }
  }
  state.heatOffCtx.putImageData(state.heatImg, 0, 0);
}

/** Rebuild the offscreen membrane map: the neuron-ordered potential vector folded row-major into HEAT_ROWS strata. ≤4 Hz. */
export function rebuildMemb() {
  const memb = state.membData;
  if (!memb) return;
  const N = memb.length, rows = HEAT_ROWS, cols = Math.max(1, Math.ceil(N / rows));
  if (!state.nmapOff || state.nmapOff.width !== cols || state.nmapOff.height !== rows) {
    state.nmapOff = document.createElement("canvas");
    state.nmapOff.width = cols; state.nmapOff.height = rows;
    state.nmapOffCtx = state.nmapOff.getContext("2d");
    state.nmapImg = state.nmapOffCtx.createImageData(cols, rows);
  }
  const data = state.nmapImg.data, rng = state.membRange || { min: -1, max: 1 }, span = (rng.max - rng.min) || 1;
  for (let i = 0; i < N; i++) {
    let q = Math.round(((memb[i] - rng.min) / span) * 255);
    if (q < 0) q = 0; else if (q > 255) q = 255;
    const o3 = q * 3, o = i * 4;                                // neuron i → pixel i (row-major fold: y = i/cols, x = i%cols)
    data[o] = MEMB_LUT[o3]; data[o + 1] = MEMB_LUT[o3 + 1]; data[o + 2] = MEMB_LUT[o3 + 2]; data[o + 3] = 255;
  }
  for (let i = N; i < cols * rows; i++) data[i * 4 + 3] = 0;    // blank the last partial row's tail cells
  state.nmapOffCtx.putImageData(state.nmapImg, 0, 0);
}

/** Sync the #nmap chrome (title / sub-caption / legend ends / idle overlay) to the active view + latest data. */
export function updateNmapChrome() {
  const wrap = $("nmap-wrap"); if (!wrap) return;
  const memb = state.nview === "memb";
  wrap.dataset.nvmap = memb ? "memb" : "heat";
  const title = $("nmap-title"), sub = $("nmap-sub"), idle = $("nmap-idle"), lo = $("nmap-lo"), hi = $("nmap-hi"), cv = $("nmap");
  if (cv) cv.setAttribute("aria-label", T(memb ? "ins.nvMembAria" : "ins.nvHeatAria"));
  if (memb) {
    const has = !!state.membData, rg = state.membRange;
    if (title) title.textContent = T("ins.membLabel");
    if (idle) { idle.textContent = T("ins.membIdle"); idle.hidden = has; }
    if (sub) sub.textContent = has && rg ? T("ins.membSub", { min: rg.min.toFixed(1), max: rg.max.toFixed(1) }) : "";
    if (lo) lo.textContent = has && rg ? rg.min.toFixed(0) : "\u2212";
    if (hi) hi.textContent = has && rg ? rg.max.toFixed(0) : "+";
  } else {
    const cols = state.heatCols.length;
    if (title) title.textContent = T("ins.heatLabel");
    if (idle) { idle.textContent = T("ins.heatIdle"); idle.hidden = cols > 0; }
    if (sub) sub.textContent = cols ? T("ins.heatSub", { rows: HEAT_ROWS, cols }) : "";
    if (lo) lo.textContent = "0";
    if (hi) hi.textContent = "1";
  }
}

/** Per frame: rebuild the active view's offscreen at ≤4 Hz, refresh the chrome, then blit once (hard-edged). */
export function renderNmap(now) {
  const c = $("nmap");
  if (!c) return;
  const memb = state.nview === "memb";
  if (now - state.nmapLast >= NMAP_REBUILD_MS) {
    state.nmapLast = now;
    if (memb) rebuildMemb(); else rebuildHeat();
    updateNmapChrome();
  }
  const off = memb ? state.nmapOff : state.heatOff;
  const x = c.getContext("2d");
  x.clearRect(0, 0, c.width, c.height);
  if (!off) return;
  x.imageSmoothingEnabled = false;                              // the cells are data — keep them crisp when scaled up
  x.drawImage(off, 0, 0, c.width, c.height);
}

const NVIEWS = ["bloom", "raster", "heat", "memb"];
/** Put one neural view on stage: mirror to #inspector[data-nview] (CSS gating) + the switch's aria-pressed state. */
export function setNview(nv) {
  if (!NVIEWS.includes(nv)) nv = "bloom";
  state.nview = nv;
  const ins = $("inspector"); if (ins) ins.dataset.nview = nv;
  const host = $("nview");
  if (host) for (const b of host.querySelectorAll(".nv-btn")) {
    const on = b.dataset.nv === nv;
    b.classList.toggle("is-on", on);
    b.setAttribute("aria-pressed", on ? "true" : "false");
  }
  state.nmapLast = 0;                                           // force an immediate offscreen rebuild of the shared stage
  updateNmapChrome();
}
/** Wire the segmented view switch (bloom / raster / heatmap / membrane). Called once from main.js init. */
export function bindNeuralViews() {
  const host = $("nview");
  if (host) host.addEventListener("click", (e) => {
    const btn = e.target.closest(".nv-btn");
    if (btn) setNview(btn.dataset.nv);
  });
  setNview(state.nview || "bloom");                            // sync the initial on-stage view
}
