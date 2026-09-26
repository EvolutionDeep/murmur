// main.js — 入口：boot() + loop() + 语言切换 + UI 接线 + TCA 复制
// 由 app.js 机械拆分（任务5），行为与原文件一致；原文件保留为 app.js 备份参考。
import { state, $, CHRON_POLL_MS, HIST_POLL_MS, POLL_MS, applyPaletteToDOM, clamp, graveField, lerp, paletteAt, shortHash, sim } from './shared.js';
import { currentLang, ENDONYMS, getLang, setLang, SUPPORTED, t as T } from './i18n.js?v=96';
import { bindPointer, bindZoomControls, resize } from './camera.js';
import { arenaApplyChip, arenaBet, arenaClaim, arenaConnect, arenaUpdatePreview, buySignal, closeArena, closeBrain, closeCanary, closeChron, closeChronVol, closeHistory, closeLaureate, closeLineage, closePredict, closeProofs, closePulse, closeWallets, doBreed, openChron, openChronVol, paintArena, paintLaureate, paintPredict, paintPulse, proveChron, renderApprenticeSection, renderArchiveSection, renderBourseSection, renderBrain, renderChron, renderChronVerdict, renderCitiesSection, renderCommonsSection, renderCourtSection, renderCultureSection, renderDynastySection, renderGamesSection, renderGuardiansSection, renderGuildSection, renderHistory, renderLexSection, renderLineage, renderMarketSection, renderProofs, renderReligionSection, renderRumorSection, renderSocialSection, renderTechSection, renderTreatySection, renderWallets, renderWorksSection, renderWorkshopSection, selectLineage, toggleArena, toggleBrain, toggleCanary, toggleChron, toggleHistory, toggleLaureate, toggleLineage, togglePredict, toggleProofs, togglePulse, toggleWallets, updateNetNote, updateSinceLaunch, verifyPoem, verifyPredictRound, verifyProof } from './drawers.js';
import { renderDist, setStatusKind, updateEconFoot, updateEconMode } from './economy.js';
import { bindBloomScale, deselect, fillInspectorFromSim, renderBloom, renderRaster } from './inspector.js';
import { loadLaureateMore, offlineTick, poll, pollBourse, pollChron, pollHistory, pollRoster, pollWar } from './polling.js';
import { drawTempHistory, hideEpitaph, makeCrownGlow, makeHaloSprite, render, sampleHistory, showEpitaph } from './render2d.js';
import { ThreeScene } from './scene3d.js';
import { loadDelaunay } from './nations.js';
import { updateMotes, updateSim } from './sim.js';

// read-only perf probe for diagnostics (never writes anything): frame cost, adaptive quality, swarm & ledger size
window.__murmurPerf = () => ({ frameMsAvg: Math.round(state.frameMsAvg * 10) / 10, qualityCoeff: Math.round(state.qualityCoeff * 100) / 100, flies: sim.size, graves: graveField.length });
export function loop(now) {
  try {
    const ms = now - state.last;
    const dt = clamp(ms / 16.667, 0.2, 2.4);
    state.last = now; state.frame++;
    state.frameMsAvg = lerp(state.frameMsAvg, ms, 0.06);
    // continuous adaptive quality (task 8): glide a 0..1 coefficient toward the frame-cost target instead of
    // stepping integer tiers through a hysteresis band (whose dead zone parked a machine idling at 18-19ms
    // at the wrong tier forever). C3: the knee sits at the 16.67ms 60fps budget so a healthy 60Hz frame holds
    // 1.0 (full detail) instead of the old 10ms knee that made qTarget>0.6 structurally unreachable on 60Hz
    // and permanently killed every high-detail layer. 24ms → ~0.48, >=30.7ms fades to 0. The EMA (alpha 0.05)
    // rides out single-frame spikes; sub-768px viewports scale it to 0.85.
    const qTarget = clamp(1 - (state.frameMsAvg - 16.7) / 14, 0, 1) * (state.VW < 768 ? 0.85 : 1);
    state.qualityCoeff = lerp(state.qualityCoeff, qTarget, 0.05);
    state.tempSmoothed = lerp(state.tempSmoothed, state.tempTarget, 0.02 * dt);
    state.cohSmoothed = lerp(state.cohSmoothed, state.cohTarget, 0.03 * dt);
    state.flowTime += dt * (0.35 + state.tempSmoothed * 1.1);   // the current races when the market is hot
    const pal = paletteAt(state.tempSmoothed);
    if (state.frame % 6 === 0) applyPaletteToDOM(pal);
    sampleHistory();
    updateSim(dt, now);
    if (state.qualityCoeff > 0.3) updateMotes(dt);
    render(pal, now);
    if (state.frame % 3 === 0) drawTempHistory();
    if (state.selectedId != null) { renderBloom(now); renderRaster(now); }
  } catch (e) {
    if (!state.loopWarned) { state.loopWarned = true; console.warn("[murmur] loop error (self-healed):", e); }
  } finally {
    requestAnimationFrame(loop);
  }
}
// ================= token contract address (copy-to-clipboard) =================
// The project token CA is shown truncated in the economy panel; clicking copies the FULL address.
// navigator.clipboard works on our HTTPS origin; the hidden-textarea fallback covers older browsers
// and non-secure contexts so the copy never silently fails.
export async function copyToClipboard(text) {
  try {
    if (navigator.clipboard && window.isSecureContext) { await navigator.clipboard.writeText(text); return true; }
  } catch (_) { /* fall through to the legacy path */ }
  try {
    const ta = document.createElement("textarea");
    ta.value = text; ta.setAttribute("readonly", "");
    ta.style.position = "fixed"; ta.style.top = "-1000px"; ta.style.opacity = "0";
    document.body.appendChild(ta); ta.select();
    const ok = document.execCommand("copy");
    document.body.removeChild(ta);
    return ok;
  } catch (_) { return false; }
}
export async function copyTokenCA(btn) {
  const ca = btn.dataset.ca; if (!ca) return;
  const ok = await copyToClipboard(ca);
  btn.textContent = ok ? "copied ✓" : shortHash(ca);
  btn.classList.toggle("copied", ok);
  clearTimeout(state.tcaTimer);
  state.tcaTimer = setTimeout(() => { btn.textContent = shortHash(ca); btn.classList.remove("copied"); }, 1400);
}
// ================= misc UI bindings =================
// ================= language switcher + live re-render =================
// On a language change we re-translate the static DOM (applyDom, done inside setLang) and then
// rebuild whatever is currently on stage. The canvas layers read T()/gl() every frame, so they
// refresh on the next animation tick without any help from us.
export function populateLangSelect() {
  const sel = $("lang-select");
  if (!sel) return;
  sel.textContent = "";
  for (const code of SUPPORTED) {
    const o = document.createElement("option");
    o.value = code; o.textContent = ENDONYMS[code] || code;
    sel.appendChild(o);
  }
  sel.value = currentLang();
}
export function rerenderAll() {
  try {
    setStatusKind(state.curStatusKind);
    updateEconMode(); updateEconFoot();
    updateNetNote();
    const tca = $("tca-copy"); if (tca) tca.title = T("econ.copyTip", { ca: tca.dataset.ca || "" });
    if (state._lastDist) renderDist(state._lastDist.states, state._lastDist.size);   // repaint behaviour legend in the new language
    updateSinceLaunch();
    const dv = $("ins-drives"); if (dv) dv.innerHTML = "";   // force the cached drive labels to rebuild in the new language
    if (state.selectedId != null) fillInspectorFromSim(state.selectedId);
    if (state.selectedGrave) showEpitaph(state.selectedGrave);   // an open epitaph re-localises in the new language
    if (state.walletsOpen) { renderWallets(); renderMarketSection(); }
    if (state.historyOpen) renderHistory();
    if (state.chronOpen) { renderChron(); if (state.chronVerifyState) renderChronVerdict(); renderDynastySection(); renderCultureSection(); renderReligionSection(); renderCommonsSection(); renderTechSection(); renderCitiesSection(); renderApprenticeSection(); renderArchiveSection(); renderWorkshopSection(); renderCourtSection(); renderGamesSection(); renderGuildSection(); renderLexSection(); renderRumorSection(); renderTreatySection(); renderWorksSection(); renderGuardiansSection(); renderBourseSection(); renderSocialSection(); }
    // The remaining drawers rebuild themselves from cached data — repaint only, no refetch (a refetch would
    // flash the "loading…" skeleton and drop any in-flight verify state the user was looking at).
    if (state.proofsOpen) renderProofs();
    if (state.laureateOpen) paintLaureate();
    if (state.brainOpen && !state.brainLoading && state.brainData) renderBrain();
    if (state.lineageOpen && !state.lineageLoading && state.lineageData) renderLineage();
    if (state.pulseOpen && (state.pulseReqs || state.pulseLB)) paintPulse();
    if (state.predictOpen && state.predictData) paintPredict();
    if (state.arenaOpen && state.arenaData) paintArena();
  } catch { /* never let a re-render break the scene */ }
}
window.__onLangChange = rerenderAll;
export function bindUI() {
  $("ins-close").addEventListener("click", deselect);
  const lsel = $("lang-select");
  if (lsel) lsel.addEventListener("change", () => setLang(lsel.value));
  bindBloomScale();
  const lt = $("layer-toggles");
  if (lt) lt.addEventListener("click", (e) => {
    const b = e.target.closest(".layer-btn"); if (!b) return;
    const on = !b.classList.contains("is-on");
    b.classList.toggle("is-on", on);
    if (b.dataset.layer === "mind") state.showMind = on;
    else if (b.dataset.layer === "shards") state.showShards = on;
    else if (b.dataset.layer === "societies") state.showSocieties = on;
    else if (b.dataset.layer === "territory") { state.showTerritory = on; if (on) pollRoster(true); }
    else if (b.dataset.layer === "graves") { state.showGraves = on; if (!on) hideEpitaph(); }
    else if (b.dataset.layer === "chronicle") state.showChron = on;
    else if (b.dataset.layer === "cities") state.showCities = on;
  });
  const epc = $("epitaph-close"); if (epc) epc.addEventListener("click", hideEpitaph);
  const wb = $("wallets-btn"); if (wb) wb.addEventListener("click", toggleWallets);
  const wc = $("wallets-close"); if (wc) wc.addEventListener("click", closeWallets);
  const hb = $("hist-btn"); if (hb) hb.addEventListener("click", toggleHistory);
  const hc = $("hist-close"); if (hc) hc.addEventListener("click", closeHistory);
  const crb = $("chron-btn"); if (crb) crb.addEventListener("click", toggleChron);
  const crc = $("chron-close"); if (crc) crc.addEventListener("click", closeChron);
  const ctk = $("chron-ticker"); if (ctk) ctk.addEventListener("click", () => { if (!state.chronOpen) openChron(); });
  const cnb = $("canary-btn"); if (cnb) cnb.addEventListener("click", toggleCanary);
  const cnc = $("canary-close"); if (cnc) cnc.addEventListener("click", closeCanary);
  const cp = $("chron-prove"); if (cp) cp.addEventListener("click", proveChron);
    const ctabs = $("chron-tabs");
    if (ctabs) ctabs.addEventListener("click", (e) => { const b = e.target.closest(".chron-tab"); if (b) openChronVol(b.dataset.vol); });
    const cbk = $("chron-back"); if (cbk) cbk.addEventListener("click", closeChronVol);
  const pb = $("proofs-btn"); if (pb) pb.addEventListener("click", toggleProofs);
  const pc = $("proofs-close"); if (pc) pc.addEventListener("click", closeProofs);
  const lrb = $("laureate-btn"); if (lrb) lrb.addEventListener("click", toggleLaureate);
  const lrc = $("laureate-close"); if (lrc) lrc.addEventListener("click", closeLaureate);
  // the Laureate drawer rebuilds its cards each render, so bind verify/expand/load-older by delegation once
  const lrbd = $("laureate-body");
  if (lrbd) lrbd.addEventListener("click", (e) => {
    const vb = e.target.closest(".lr-verify");
    if (vb) { verifyPoem(Number(vb.dataset.seq), vb.closest(".lr-card")); return; }
    const eb = e.target.closest(".lr-expand");
    if (eb) {
      const card = eb.closest(".lr-card"); if (!card) return;
      const b = card.querySelector(".lr-body"); if (!b) return;
      const nowHidden = b.hidden; b.hidden = !nowHidden; eb.textContent = nowHidden ? "\u2013" : "+";
      return;
    }
    const mb = e.target.closest("#lr-more");
    if (mb) { loadLaureateMore(); return; }
  });
  const bb = $("brain-btn"); if (bb) bb.addEventListener("click", toggleBrain);
  const bc = $("brain-close"); if (bc) bc.addEventListener("click", closeBrain);
  const lb = $("lineage-btn"); if (lb) lb.addEventListener("click", toggleLineage);
  const lc = $("lineage-close"); if (lc) lc.addEventListener("click", closeLineage);
  // the lineage drawer rebuilds each render, so bind row/parent-select + breed by delegation once
  const lbody = $("lineage-body");
  if (lbody) lbody.addEventListener("click", (e) => {
    const go = e.target.closest("#lin-breed-go");
    if (go) { e.preventDefault(); doBreed(); return; }
    const row = e.target.closest("[data-lin-hash]");
    if (row) { e.preventDefault(); selectLineage(row.dataset.linHash); }
  });
  const tca = $("tca-copy"); if (tca) tca.addEventListener("click", () => copyTokenCA(tca));
  const ulb = $("pulse-btn"); if (ulb) ulb.addEventListener("click", togglePulse);
  const ulc = $("pulse-close"); if (ulc) ulc.addEventListener("click", closePulse);
  // the pulse drawer rebuilds each render, so bind the buy button by delegation once
  const ulbd = $("pulse-body");
  if (ulbd) ulbd.addEventListener("click", (e) => {
    const b = e.target.closest(".pulse-buy"); if (b) { buySignal(b); return; }
  });
  const prb = $("predict-btn"); if (prb) prb.addEventListener("click", togglePredict);
  const prc = $("predict-close"); if (prc) prc.addEventListener("click", closePredict);
  // the predict drawer rebuilds each render, so bind verify by delegation once
  const prbd = $("predict-body");
  if (prbd) prbd.addEventListener("click", (e) => {
    const vb = e.target.closest(".pr-verify");
    if (vb) verifyPredictRound(vb.dataset.round, vb.closest(".pr-round"));
  });
  const ab = $("arena-btn"); if (ab) ab.addEventListener("click", toggleArena);
  const ac = $("arena-close"); if (ac) ac.addEventListener("click", closeArena);
  // the arena drawer rebuilds each render, so bind connect/bet/claim by delegation once
  const abd = $("arena-body");
  if (abd) abd.addEventListener("click", (e) => {
    const chip = e.target.closest(".ar-chip"); if (chip) { arenaApplyChip(chip); return; }
    const conn = e.target.closest(".ar-btn.connect"); if (conn) { arenaConnect(conn); return; }
    const bet = e.target.closest(".ar-btn[data-side]"); if (bet) { arenaBet(Number(bet.dataset.side), bet); return; }
    const claim = e.target.closest(".ar-btn[data-claim]"); if (claim) { arenaClaim(Number(claim.dataset.claim), claim); return; }
  });
  // the payout preview tracks the bet box as the trader types (delegated: the card rebuilds each render)
  if (abd) abd.addEventListener("input", (e) => {
    if (e.target && e.target.id === "ar-amount") arenaUpdatePreview();
  });
  // the proofs drawer rebuilds its cards each render, so bind verify/expand by delegation once
  const pbd = $("proofs-body");
  if (pbd) pbd.addEventListener("click", (e) => {
    const vb = e.target.closest(".pf-verify");
    if (vb) { verifyProof(vb.dataset.tx, vb.closest(".pf-card")); return; }
    const eb = e.target.closest(".pf-expand");
    if (eb) {
      const card = eb.closest(".pf-card"); if (!card) return;
      const body = card.querySelector(".pf-body"); if (!body) return;
      const nowHidden = body.hidden;
      body.hidden = !nowHidden;
      eb.textContent = nowHidden ? "\u2013" : "+";
    }
  });
  // Escape closes the topmost overlay first: chronicle drawer, then proofs, history, wallets, the inspector.
  document.addEventListener("keydown", (e) => {
    if (e.key !== "Escape") return;
    if (state.chronOpen) { if (state.chronMode === "volume") closeChronVol(); else closeChron(); } else if (state.canaryOpen) closeCanary(); else if (state.laureateOpen) closeLaureate(); else if (state.proofsOpen) closeProofs(); else if (state.brainOpen) closeBrain(); else if (state.lineageOpen) closeLineage(); else if (state.pulseOpen) closePulse(); else if (state.arenaOpen) closeArena(); else if (state.predictOpen) closePredict(); else if (state.historyOpen) closeHistory(); else if (state.walletsOpen) closeWallets(); else deselect();
  });
}
// ================= boot =================
export async function boot() {
  // resolve the reader's language first (persisted > browser > en) so the very first paints are localized
  setLang(getLang(), { rerender: false });
  state.haloSprite = makeHaloSprite();
  state.crownGlowSprite = makeCrownGlow();
  // C1: resolve d3-delaunay BEFORE ThreeScene is constructed — _init() → _buildTerrain() → _applyNations()
  // runs updateNations() synchronously, so Delaunay must already be loaded (or definitively null) by then.
  // A failed/unreachable CDN leaves it null and simply disables the Voronoi borders (no white screen).
  await loadDelaunay();
  try { state.threeScene = new ThreeScene(); } catch (e) { console.warn("[murmur] Three.js init failed, falling back to 2D:", e); }
  resize();
  bindUI();
  populateLangSelect();
    { const tca = $("tca-copy"); if (tca) tca.title = T("econ.copyTip", { ca: tca.dataset.ca || "" }); }   // fill the {ca} param applyDom can't
  bindPointer();
    bindZoomControls();
  offlineTick();   // seed the field + the agent economy so it is alive immediately
  applyPaletteToDOM(paletteAt(state.tempSmoothed));
  setStatusKind("connecting");
  poll();
  setInterval(poll, POLL_MS);
  pollHistory();                              // seed the ribbon + since-launch summary from D1 on load
  setInterval(pollHistory, HIST_POLL_MS);     // the archive advances ~1×/min; a slow poll keeps it fresh
  pollChron();                                // seed the chronicle panel so it is live on load
  setInterval(pollChron, CHRON_POLL_MS);      // chronicle advances on threshold events; 25s keeps it fresh
  pollWar();                                  // seed the on-chain war coffer section (inert while WAR off)
  setInterval(pollWar, CHRON_POLL_MS);        // coffer vaults/bouts/purse refresh on the same slow cadence
  pollBourse();                               // seed the bourse panel (inert while BOURSE off)
  setInterval(pollBourse, CHRON_POLL_MS);     // the coin tape refreshes on the same slow cadence
  requestAnimationFrame(loop);
}
boot();
