// main.js — 入口：boot() + loop() + 语言切换 + UI 接线 + TCA 复制
// 由 app.js 机械拆分（任务5），行为与原文件一致；原文件保留为 app.js 备份参考。
import { state, $, CHRON_POLL_MS, HIST_POLL_MS, POLL_MS, applyPaletteToDOM, clamp, graveField, lerp, paletteAt, shortHash, sim } from './shared.js?v=163';
import { currentLang, ENDONYMS, getLang, setLang, SUPPORTED, t as T } from './i18n.js?v=114';
import { bindPointer, bindZoomControls, resize } from './camera.js?v=163';
import { arenaApplyChip, arenaBet, arenaClaim, arenaConnect, arenaUpdatePreview, buySignal, closeArena, closeBrain, closeCanary, closeChron, closeChronVol, closeHistory, closeLaureate, closeLineage, closePoca, closePredict, closeProofs, closePulse, closeWallets, doBreed, lazyProvCheck, openChron, openChronVol, paintArena, paintLaureate, paintPoca, paintPredict, paintPulse, proveChron, refreshProvBadge, renderApprenticeSection, renderArchiveSection, renderBourseSection, renderBrain, renderChron, renderChronVerdict, renderCitiesSection, renderCommonsSection, renderCourtSection, renderCultureSection, renderDynastySection, renderGamesSection, renderGuardiansSection, renderGuildSection, renderHistory, renderLexSection, renderLineage, renderMarketSection, renderPoca, renderProofs, renderReligionSection, renderRumorSection, renderSocialSection, renderTechSection, renderTreatySection, renderWallets, renderWorksSection, renderWorkshopSection, selectLineage, toggleArena, toggleBrain, toggleCanary, toggleChron, toggleHistory, toggleLaureate, toggleLineage, togglePoca, togglePredict, toggleProofs, togglePulse, toggleWallets, closeTemple, openTemple, paintTemple, renderTemple, templeBurn, templeConnect, templeSelectKind, toggleTemple, updateNetNote, updateSinceLaunch, verifyPoem, verifyPredictRound, verifyProof } from './drawers.js?v=163';
import { applyTopology, renderDist, setStatusKind, updateEconFoot, updateEconMode } from './economy.js?v=163';
import { bindBloomScale, bindNeuralViews, deselect, fillInspectorFromSim, pushScopeCollective, renderBloom, renderNmap, renderRaster, renderScope } from './inspector.js?v=163';
import { loadLaureateMore, offlineTick, poll, pollBourse, pollChron, pollHistory, pollRoster, pollWar } from './polling.js?v=163';
import { drawTempHistory, hideEpitaph, makeCrownGlow, makeHaloSprite, render, sampleHistory, showEpitaph } from './render2d.js?v=163';
import { ThreeScene } from './scene3d.js?v=163';
import { WalkMode } from './walkMode.js?v=163';
import { LandLayer } from './landLayer.js?v=163';
import { openLand, closeLand, paintLand } from './landDrawer.js?v=163';
import { loadDelaunay } from './nations.js?v=163';
import { updateMotes, updateSim } from './sim.js?v=163';
// task 22: the second main canvas (lineage / technical atlas).
import { closeLineageView, initLineageView, lvFrame, lvPerf, lvRelocalise, openLineageView, toggleLineageView } from './lineageView.js?v=163';
// task 88: the open-ended evolution engine read-out + the emergent-institutions HUD (both read-only drawers).
import { closeEvolution, paintEvolution, toggleEvolution } from './evolution.js?v=163';
import { closeInst, paintInstitutions, toggleInst } from './institutionsHud.js?v=163';

// read-only perf probe for diagnostics (never writes anything): frame cost, adaptive quality, swarm & ledger size
window.__murmurPerf = () => Object.assign({ frameMsAvg: Math.round(state.frameMsAvg * 10) / 10, qualityCoeff: Math.round(state.qualityCoeff * 100) / 100, flies: sim.size, graves: graveField.length }, lvPerf());
// task 49: hooks for the tick-driven day/night cycle. The DayNight instance lives on the ThreeScene
// (it binds the scene's lights/sky/fog), so main.js only exposes it — it never drives a second copy.
//   __murmurDayNight()      → the live instance (phase / nightFactor / watch / icon)
//   __murmurSetPhase(p)     → pin the sky to phase p∈[0,1) for screenshots; null resumes the tick
//   __murmurEclipse(t)      → force a t-tick blood eclipse (dynasty fall / era passage)
window.__murmurDayNight = () => (state.threeScene && state.threeScene.dayNight) || null;
window.__murmurSetPhase = (p) => { const dn = window.__murmurDayNight(); if (dn) dn.forcePhase = (p == null ? null : Number(p)); return dn ? dn.forcePhase : null; };
window.__murmurEclipse = (t) => { const dn = window.__murmurDayNight(); if (dn) dn.forceEclipse(t || 30); return !!dn; };
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
    // task 22: the two main canvases are mutually exclusive. While the lineage atlas owns the stage the 3D
    // canvas is display:none, so we skip updateSim / render / every neural blit — literally zero 3D work —
    // and drive only lvFrame (which keeps its own offscreen bake + particle budget). Switching back resumes
    // the sim exactly where it paused: fly positions are simply not advanced while the atlas is on stage.
    if (state.lineageViewActive) {
      lvFrame(now);
    } else {
      updateSim(dt, now);
      if (state.qualityCoeff > 0.3) updateMotes(dt);
      render(pal, now);
      if (state.frame % 3 === 0) drawTempHistory();
      if (state.selectedId != null) {
        // task 15: only the on-stage neural view pays for a rebuild + blit; the scope is never gated (always visible).
        const nv = state.nview;
        if (nv === "bloom") renderBloom(now);
        else if (nv === "raster") renderRaster(now);
        else renderNmap(now);                 // "heat" | "memb" share the #nmap stage
        renderScope(now);
      }
      else if (state.frame % 60 === 0) { pushScopeCollective(); renderScope(now); }   // collective fallback ~1 Hz
    }
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
  btn.textContent = ok ? T("econ.copied") : shortHash(ca);
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
    if (state.topology) applyTopology(state.topology);   // repaint the shard-isolates label in the new language
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
    if (state.templeOpen && state.templeData) paintTemple();
    if (state.pocaOpen) paintPoca();   // task 50: PoCA repaints from its cache — no refetch on a language change
    if (state.evoOpen) paintEvolution();   // task 88: the evolution drawer repaints from its cache too
    if (state.instOpen) paintInstitutions();   // task 88: same for the institutions HUD
    if (state.landOpen) paintLand();
    if (state.landLayer) state.landLayer.refreshLeaderboard();   // task 56: re-localise the land leaderboard labels
    if (state.walkMode) state.walkMode.paintChrome();   // task 48: re-localise walk button tooltip
    lvRelocalise();   // task 22: re-localise the atlas legend + any open focus panel in the new language
    refreshProvBadge();   // task nm5: re-localise the provenance badge title
  } catch { /* never let a re-render break the scene */ }
}
window.__onLangChange = rerenderAll;
// task 55: expose close fns on window so landDrawer.js can call them without circular imports
window.__closeChron = closeChron;
window.__closeCanary = closeCanary;
window.__closeTemple = closeTemple;
window.__closeWallets = closeWallets;
window.__closePoca = closePoca;   // task 50: landDrawer.js closes the PoCA sheet through the same window bridge
window.__closeEvo = closeEvolution;   // task 88: evolution.js / institutionsHud.js close each other through the same bridge
window.__closeInst = closeInst;
// task 65 · Direction A: collapse a compact card to just its title row (and back). Pure DOM class
// flip — the panel keeps its id and every live binding, so the data layer is untouched.
export function toggleCardFold(which) {
  const cls = which === "pop" ? "panel-pop" : which === "temp" ? "panel-temp" : "panel-econ";
  const panel = document.querySelector("." + cls); if (!panel) return;
  const folded = panel.classList.toggle("is-folded");
  const btn = document.getElementById(which + "-fold");
  if (btn) btn.setAttribute("aria-expanded", folded ? "false" : "true");
  // the matching rail button mirrors the folded state so the rail reads as a card switch too
  const rb = document.querySelector('#command-rail .rail-btn[data-act="' + which + '"]');
  if (rb) rb.classList.toggle("is-off", folded);
}
export function bindUI() {
  // ---- task 65 · Direction A: the left command rail is the single navigation spine. It only calls
  // EXISTING toggles (mutual exclusion inside drawers.js already guarantees one drawer at a time),
  // so the rail is a thin dispatcher — no drawer/economy logic is duplicated here. ----
  const rail = $("command-rail");
  if (rail) rail.addEventListener("click", (e) => {
    const b = e.target.closest(".rail-btn"); if (!b) return;
    const act = b.dataset.act;
    switch (act) {
      case "layers": document.body.classList.toggle("layers-pop"); break;
      case "econ": toggleCardFold("econ"); break;
      case "pop": toggleCardFold("pop"); break;
      case "land": { const lb = document.querySelector('.layer-btn[data-layer="land"]'); if (lb) lb.click(); break; }
      case "chronicle": toggleChron(); break;
      case "canary": toggleCanary(); break;
      case "temple": toggleTemple(); break;
      case "poca": togglePoca(); break;   // task 50: the proof-of-continuity anchor drawer
      case "evo": toggleEvolution(); break;   // task 88: the open-ended evolution engine read-out
      case "inst": toggleInst(); break;   // task 88: the emergent-institutions HUD
      case "walk": if (state.walkMode) state.walkMode.toggle(); break;
      case "lineageview": toggleLineageView(); break;   // task 22: switch to the second main canvas
      // task 93: the rail's two canvas-mode buttons call the SAME one-way switches the capsules use
      case "home": openLineageView(); break;   // rail home = the default atlas canvas
      case "mode3d": closeLineageView(); break;   // rail 3D mode = back to the WebGL swarm
      case "wallets": toggleWallets(); break;
      case "proofs": toggleProofs(); break;
      case "history": toggleHistory(); break;
      case "brain": toggleBrain(); break;
      case "lineage": toggleLineage(); break;
      case "laureate": toggleLaureate(); break;
      case "pulse": togglePulse(); break;
      case "predict": togglePredict(); break;
      case "arena": toggleArena(); break;
    }
  });
  // the fold chevrons inside each compact card collapse it to just its title row
  for (const fid of ["econ-fold", "pop-fold", "temp-fold"]) {
    const fb = $(fid); if (fb) fb.addEventListener("click", () => toggleCardFold(fid.split("-")[0]));
  }
  $("ins-close").addEventListener("click", deselect);
  const lsel = $("lang-select");
  if (lsel) lsel.addEventListener("change", () => setLang(lsel.value));
  bindBloomScale();
  bindNeuralViews();   // task 15: the inspector's four-view neural switch (bloom / raster / heatmap / membrane)
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
    else if (b.dataset.layer === "cities") state.showCities = on;
    else if (b.dataset.layer === "land" && state.landLayer) { state.landLayer.enabled = on; state.landLayer.group.visible = on; state.landLayer.refreshLeaderboard(); }
  });
  const epc = $("epitaph-close"); if (epc) epc.addEventListener("click", hideEpitaph);
  const wb = $("wallets-btn"); if (wb) wb.addEventListener("click", toggleWallets);
  const wc = $("wallets-close"); if (wc) wc.addEventListener("click", closeWallets);
  const hb = $("hist-btn"); if (hb) hb.addEventListener("click", toggleHistory);
  const hc = $("hist-close"); if (hc) hc.addEventListener("click", closeHistory);
  const crb = $("chron-btn"); if (crb) crb.addEventListener("click", toggleChron);
  const crc = $("chron-close"); if (crc) crc.addEventListener("click", closeChron);
  // task 26①: the bottom chronicle ticker is gone — the drawer trigger (#chron-btn) is the only entry.
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
  // provenance badge: click opens the brain drawer
  const pbadge = $("prov-badge"); if (pbadge) pbadge.addEventListener("click", toggleBrain);
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
  // ㉙ THE TEMPLE — burn-to-intervene drawer: button + close + delegated body actions
  const tb = $("temple-btn"); if (tb) tb.addEventListener("click", toggleTemple);
  const tc = $("temple-close"); if (tc) tc.addEventListener("click", closeTemple);
  const tbd = $("temple-body");
  if (tbd) tbd.addEventListener("click", (e) => {
    const conn = e.target.closest(".tp-connect-btn"); if (conn) { templeConnect(conn); return; }
    const card = e.target.closest(".tp-card"); if (card && !card.classList.contains("disabled")) { templeSelectKind(card.dataset.kind); return; }
    const burn = e.target.closest(".tp-burn-btn"); if (burn) { templeBurn(burn); return; }
  });
  if (tbd) tbd.addEventListener("keydown", (e) => {
    if (e.key !== "Enter" && e.key !== " ") return;
    const card = e.target.closest(".tp-card"); if (card && !card.classList.contains("disabled")) { e.preventDefault(); templeSelectKind(card.dataset.kind); }
  });
  // task 55: land drawer close button
  const ldc = $("land-close"); if (ldc) ldc.addEventListener("click", closeLand);
  // task 50: PoCA drawer — close chip + delegated refresh (the body is rebuilt every paint, so delegate once)
  const poc = $("poca-close"); if (poc) poc.addEventListener("click", closePoca);
  // task 88: evolution + institutions drawers — close chips (tabs are delegated inside each module's paint)
  const evoC = $("evo-close"); if (evoC) evoC.addEventListener("click", closeEvolution);
  const instC = $("inst-close"); if (instC) instC.addEventListener("click", closeInst);
  const pocb = $("poca-body");
  if (pocb) pocb.addEventListener("click", (e) => {
    const rb = e.target.closest("#poca-refresh"); if (rb && !state.pocaLoading) renderPoca();
  });
  // task 48: walk mode button
  const wkb = $("walk-btn"); if (wkb) wkb.addEventListener("click", () => { if (state.walkMode) state.walkMode.toggle(); });
  // task 39 · A2: canvas-switch capsules (independent of the command-rail — works on phones where the rail is hidden)
  const swAtlas = $("switch-to-atlas"); if (swAtlas) swAtlas.addEventListener("click", openLineageView);
  const sw3d = $("switch-to-3d"); if (sw3d) sw3d.addEventListener("click", closeLineageView);
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
    if (state.chronOpen) { if (state.chronMode === "volume") closeChronVol(); else closeChron(); } else if (state.canaryOpen) closeCanary(); else if (state.landOpen) closeLand(); else if (state.pocaOpen) closePoca(); else if (state.evoOpen) closeEvolution(); else if (state.instOpen) closeInst(); else if (state.laureateOpen) closeLaureate(); else if (state.proofsOpen) closeProofs(); else if (state.brainOpen) closeBrain(); else if (state.lineageOpen) closeLineage(); else if (state.pulseOpen) closePulse(); else if (state.arenaOpen) closeArena(); else if (state.templeOpen) closeTemple(); else if (state.predictOpen) closePredict(); else if (state.historyOpen) closeHistory(); else if (state.walletsOpen) closeWallets(); else if (state.lineageViewActive) closeLineageView(); else deselect();
  });
}
// ================= task 38 · B2+B3: auto-fold panel-pop on short/narrow screens =================
// Fold to just the title row on: narrow (≤680) so the fixed chip stays compact, or short desktop (≥681 wide, ≤700 tall).
let _popAutoFolded = false;
function autoFoldPop() {
  const shouldFold = window.innerWidth <= 680 || (window.innerWidth >= 681 && window.innerHeight <= 700);
  if (shouldFold === _popAutoFolded) return;
  _popAutoFolded = shouldFold;
  const panel = document.querySelector('.panel-pop');
  if (!panel) return;
  if (shouldFold && !panel.classList.contains('is-folded')) toggleCardFold('pop');
  else if (!shouldFold && panel.classList.contains('is-folded')) toggleCardFold('pop');
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
  // task 48: walk mode — ground-level exploration driver
  if (state.threeScene) {
    try {
      state.walkMode = new WalkMode(state.threeScene, state.threeScene.camera, state.threeScene.renderer && state.threeScene.renderer.domElement);
      state.threeScene.walkMode = state.walkMode;
      // task 52: clicking a chronicle institution landmark opens the codex on that volume
      state.threeScene.onInstitutionClick = (vol) => { try { openChron(); openChronVol(vol); } catch (e) { console.warn("[murmur] openChronVol", e); } };
    } catch (e) { console.warn("[murmur] WalkMode init failed:", e); }
  }
  // task 55: land pixel layer — 3D grid visualization + purchase drawer trigger
  if (state.threeScene) {
    try {
      state.landLayer = new LandLayer(state.threeScene);
      state.landLayer.onParcelClick = (parcelId) => { try { deselect(); openLand(parcelId); } catch (e) { console.warn("[murmur] openLand", e); } };
      // hook into the scene update loop
      const origUpdate = state.threeScene.update.bind(state.threeScene);
      state.threeScene.update = function (sim, econCities, now) {
        origUpdate(sim, econCities, now);
        try { if (state.landLayer) state.landLayer.update(0, now); } catch (e) { /* non-fatal */ }
      };
    } catch (e) { console.warn("[murmur] LandLayer init failed:", e); }
  }
  resize();
  bindUI();
  populateLangSelect();
    { const tca = $("tca-copy"); if (tca) tca.title = T("econ.copyTip", { ca: tca.dataset.ca || "" }); }   // fill the {ca} param applyDom can't
  bindPointer();
    bindZoomControls();
  initLineageView();   // task 22: wire the second canvas (hit-test, toolbar, focus panel) — inert until toggled on
  openLineageView();    // task 39 · A1: the atlas is now the DEFAULT stage — 3D resumes via the switch capsule
  // task 38 · B2: auto-fold panel-pop on short screens (≥681 wide, ≤700 tall) so it stays visible but compact
  autoFoldPop();
  window.addEventListener('resize', autoFoldPop);
  offlineTick();   // seed the field + the agent economy so it is alive immediately
  applyPaletteToDOM(paletteAt(state.tempSmoothed));
  setStatusKind("connecting");
  poll();
  setInterval(poll, POLL_MS);
  lazyProvCheck();   // task nm5: one-shot provenance verify per session (never retries)
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
