// inspector.js — select/deselect + fillInspector + neural feed + bloom/raster canvas
// 由 app.js 机械拆分（任务5），行为与原文件一致；原文件保留为 app.js 备份参考。
import { state, $, FAP_GLOSS, FAP_ROLE, KIND_COL, STATE_COLOR, TAU, clamp, fapColor, houseOf, mix, paletteAt, rgba, sim } from './shared.js';
import { t as T } from './i18n.js?v=98';
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
    pushSpikes(s.spikesLastStep, N || 10800);
  } catch (e) {
    if (state.neuralFeedId !== id) return;
    synthNeural(id);
  } finally {
    state.neuralInFlight = false;
  }
}
export function pushSpikes(spikes, N) {
  let arr = Array.isArray(spikes) ? spikes : [];
  if (arr.length > 180) arr = arr.filter((_, i) => i % Math.ceil(arr.length / 180) === 0);  // subsample
  state.rasterCols.push({ t: performance.now(), spikes: arr, N: N || 10800 });
  const now = performance.now();
  while (state.rasterCols.length && now - state.rasterCols[0].t > RASTER_WINDOW_MS) state.rasterCols.shift();
  const hz = $("raster-hz");
  if (hz) hz.textContent = `${arr.length} / ${N || 10800} firing`;
}
// offline / pre-deploy: synthesise a believable spike column + bloom for this fly
export function synthNeural(id) {
  const f = sim.get(id);
  const aro = f ? f.tAro : 0.4;
  const N = 10800, rates = new Array(N), kinds = new Array(N), spikes = [];
  for (let i = 0; i < N; i++) {
    const u = i / N;
    const kind = u < 0.167 ? "sensory" : u < 0.907 ? "inter" : u < 0.944 ? "modulatory" : "motor";
    kinds[i] = kind;
    const base = kind === "motor" ? aro : kind === "sensory" ? state.tempSmoothed : 0.2 + aro * 0.6;
    const rate = clamp(base * 0.7 + Math.random() * 0.5);
    rates[i] = rate * 70;
    if (Math.random() < rate * 0.5) spikes.push(i);
  }
  state.bloomData = { rates, kinds, N };
  setNeuronCount(N, "~");
  $("ins-t").textContent = "—";
  updateWallet(synthAgentFor(id));   // offline: show this fly's local mirror wallet
  pushSpikes(spikes, N);
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
// count, so a visitor can see the ~28× difference directly instead of taking our word for it.
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
  // Perceived density scales with the REAL neuron count (bloomData.N): a live ~10,800-neuron brain (species
  // spec 30,800) blooms ~10× denser than the 1,080 launch size, so the upgrade is something you SEE, not just a
  // number you read. bloomShowBefore (the compare toggle) forces the sparse 1,080-equivalent for a side-by-side.
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
