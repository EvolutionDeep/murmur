// economy.js — applyEconomy/applySnapshot/applyState/applyTopology + HUD 更新
// 由 app.js 机械拆分（任务5），行为与原文件一致；原文件保留为 app.js 备份参考。
import { state, $, ARC_EXPLORER, CRON_STALE_MS, MAX_EDGES, SEEN_CAP, atomicToUsdc, clamp, houseColor, houseOf, isRealAddr, isRealTxHash, shortHash, sim } from './shared.js';
import { currentLang, gl, t as T } from './i18n.js?v=98';
import { renderApprenticeSection, renderArchiveSection, renderCitiesSection, renderCommonsSection, renderCourtSection, renderCultureSection, renderDynastySection, renderGamesSection, renderGuardiansSection, renderGuildSection, renderLexSection, renderReligionSection, renderRumorSection, renderSocialSection, renderTechSection, renderTreatySection, renderWallets, renderWorksSection, renderWorkshopSection, sgMarkDirty, updateNetNote } from './drawers.js';
import { fillInspectorFromSim } from './inspector.js';
import { synthAgents } from './polling.js';
import { rebuildGraveField, rebuildSocieties, rebuildTerritoryPolities } from './render2d.js';
import { spawnFly } from './sim.js';

// { fromId, toId, amount, good, valid, t0 }
// The /population poll (every POLL_MS) is far faster than the on-chain tick (cron, ~60s), so the same
// `lastTick` batch is re-delivered many times between ticks. Without dedup every settlement would be
// drawn and logged ~15×. Keyed by real txHash (or tick+parties offline) so one transaction = one entry.
export const seenSettlements = new Set();
// ⑪ faith read-out {reigning, holyIn, sects[], prophecy, schism, revival, pilgrimage} — gods, ancestor cults & holy days
export const prophetIds = new Set();
// the /history "since launch" aggregate is now a cheap DO-cached summary, but the underlying rows only add ~1×/min — a 5-min poll keeps the ribbon fresh while cutting the (paginated) history query 5×
// Client-side netting surfacing (this session): how many per-trade placeholders we saw fold into nets, and
// how many netted settlements actually reached the chain — a live read-out of the gas-amortisation upgrade.
export const netting = { folded: 0, settled: 0 };
// ---- shard topology: the FlyShardDO isolates as a ring of compute nodes, pulsing in fan-out waves ----
export function applyTopology(t) {
  if (!t || !Array.isArray(t.shards) || !t.shards.length) return;
  state.topology = t;
  const sb = document.querySelector('#layer-toggles [data-layer="shards"]');
  if (sb && t.shardCount) sb.textContent = `${t.shardCount} isolates`;   // never hardcode the count
}
// cached stele signature (recomputed ≤ every 500ms)
export const keeperIds = new Set();
// a lost art / a silent tape: cold ash where warmth was

export function rebuildHouseMap() {
  houseOf.clear();
  for (const ag of state.econAgents) {
    if (ag && ag.house) houseOf.set(ag.id, { name: ag.house, sigil: ag.sigil || "", color: houseColor(ag.house) });
  }
  rebuildTerritoryPolities();             // house membership changed → refresh the territory-map partition
  state.focusCacheId = null;                    // house tints feed the focus set; invalidate the cache
}
/** Consume the economy summary the /population feed carries (live) or the local mirror (offline). */
export function applyEconomy(econ) {
  if (!econ) return;
  // territory: stash the per-fly home-zone map (and refresh the dynasty read-out) BEFORE the social branch
  // below calls rebuildSocieties(), so the fixed 4×4 grid grouping sees fresh zone→house data on this poll.
  // Both stay null while the layer is off ⇒ rebuildSocieties keeps the byte-for-byte Louvain-on-bonds view.
  state.econZones = (econ.zones && Object.keys(econ.zones).length) ? econ.zones : null;
  if (econ.dynasty) state.econDynasty = econ.dynasty;
  if (econ.balances) {
    state.econBalances = new Map();
    for (const [id, atomic] of Object.entries(econ.balances)) state.econBalances.set(Number(id), atomicToUsdc(atomic));
  }
  refreshBalanceScale();
  if (econ.totals) { state.econTotals = econ.totals; updateEconHud(econ.totals); }
  if (econ.social) { state.econSocial = econ.social; renderSocialSection(); rebuildSocieties(); sgMarkDirty(); }
  if (econ.dynasty) { state.econDynasty = econ.dynasty; renderDynastySection(); rebuildGraveField(); }
  if (econ.culture) { state.econCulture = econ.culture; renderCultureSection(); }
  if (econ.religion) { state.econReligion = econ.religion; renderReligionSection(); }
  if (econ.commons) { state.econCommons = econ.commons; renderCommonsSection(); }
  if (econ.tech) { state.econTech = econ.tech; renderTechSection(); }
  if (econ.cities) { state.econCities = econ.cities; renderCitiesSection(); }
  if (econ.apprentice) { state.econApprentice = econ.apprentice; renderApprenticeSection(); }
  if (econ.archive) { state.econArchive = econ.archive; renderArchiveSection(); }
  if (econ.workshop) { state.econWorkshop = econ.workshop; renderWorkshopSection(); }
  if (econ.court) { state.econCourt = econ.court; renderCourtSection(); }
  if (econ.games) { state.econGames = econ.games; renderGamesSection(); }
  if (econ.guilds) { state.econGuilds = econ.guilds; renderGuildSection(); }
  if (econ.lexicon) { state.econLexicon = econ.lexicon; renderLexSection(); }
  if (econ.rumor) { state.econRumor = econ.rumor; renderRumorSection(); }
  if (econ.treaty) { state.econTreaty = econ.treaty; renderTreatySection(); }
  if (econ.works) { state.econWorks = econ.works; renderWorksSection(); }
  if (econ.guardians) { state.econGuardians = econ.guardians; renderGuardiansSection(); }
  if (Array.isArray(econ.lastTick)) spawnPaymentEdges(econ.lastTick);
  if (state.selectedId != null) {
    const bal = state.econBalances.get(state.selectedId);
    if (bal != null) { const el = $("ins-bal"); if (el) el.textContent = bal.toFixed(4); }
  }
}
/** Recompute the swarm's wallet-balance range and each fly's normalised balance (0 = poorest … 1 =
 *  richest), which drives body size ("richer = bigger"). Sources: the /population economy balances
 *  and the /economy agent roster — merged so the scale is correct whichever feed has arrived. */
export function refreshBalanceScale() {
  const map = new Map(state.econBalances);
  for (const ag of state.econAgents) { if (ag && ag.id != null) map.set(Number(ag.id), atomicToUsdc(ag.balance || "0")); }
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
export function spawnPaymentEdges(list) {
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
    state.payEdges.push({ fromId: s.fromId, toId: s.toId, amount: atomicToUsdc(s.amount), good: s.good || "signal", valid: !!s.valid, real, t0: now });
    // Netting surfacing (session counters, deduped by the seen-set above): a "net-pending" placeholder is a
    // trade folded into a pair's running net; a real "net:" settlement is that net reaching the chain.
    if (s.reason === "net-pending") netting.folded++;
    else if (s.valid && typeof s.resource === "string" && s.resource.startsWith("net:")) netting.settled++;
    updateNetNote();
    if (s.valid) pushEconFeed(s);
  }
  // Keep the dedup set bounded (Set preserves insertion order → drop the oldest half).
  if (seenSettlements.size > SEEN_CAP) {
    const it = seenSettlements.values();
    for (let i = 0; i < (SEEN_CAP >> 1); i++) { const v = it.next().value; if (v === undefined) break; seenSettlements.delete(v); }
  }
  if (state.payEdges.length > MAX_EDGES) state.payEdges.splice(0, state.payEdges.length - MAX_EDGES);
}
export function updateEconHud(t) {
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
export function updateEconMode() {
  const em = $("econ-mode");
  if (!em) return;
  em.classList.remove("is-live", "is-stale");
  if (state.offline) {
    // The API is down and the panel is showing the local synthetic mirror — never pass it off as real.
    em.textContent = T("foot.offlineLoading");
    em.classList.add("is-stale");
  } else if (state.econMode === "onchain") {
    em.innerHTML = '<span class="live-dot"></span>' + T("mode.liveOnChain");
    em.classList.add("is-live");
  } else {
    em.textContent = state.econMode + " x402";
  }
}
/** The footer must never lie about whether real money moves. In live onchain mode it says so and
 *  points at the explorer; in simulated mode it keeps the honest "no real funds move" line. */
export function updateEconFoot() {
  const f = $("econ-foot");
  if (!f) return;
  if (state.offline) {
    f.textContent = T("foot.offlineLost");
    f.classList.remove("live");
    f.classList.add("stale");
  } else if (state.econMode === "onchain") {
    // publish real settlement reliability: mined successes over total on-chain broadcast attempts
    const ok = state.econTotals ? (state.econTotals.settleOk || 0) : 0;
    const att = state.econTotals ? (state.econTotals.settleAttempts || 0) : 0;
    const sr = state.econTotals && state.econTotals.successRate != null ? state.econTotals.successRate : null;
    const rateTxt = sr != null ? " · " + T("foot.settledRate", { ok, att, pct: (sr * 100).toFixed(1) }) : "";
    f.textContent = T("foot.live") + rateTxt;
    f.classList.remove("stale");
    f.classList.add("live");
  } else {
    f.textContent = T("foot.sim");
    f.classList.remove("live", "stale");
  }
}
/** Rolling ledger ticker: the last few settlements, newest on top. Each real on-chain
 *  settlement links to the official Arc explorer so the transfer can be verified. */
export function pushEconFeed(s) {
  const host = $("econ-feed");
  if (!host) return;
  const line = document.createElement("div");
  // A netted settlement (resource "net:…") is many folded trades moving as ONE on-chain transfer — flag it
  // so the gas-amortisation upgrade is visible in the ledger, not just implied by the edge styling.
  const netted = typeof s.resource === "string" && s.resource.startsWith("net:");
  line.className = "econ-line" + (netted ? " netted" : "");

  if (netted) {
    const chip = document.createElement("span");
    chip.className = "net-chip";
    chip.textContent = T("badge.net");
    chip.title = T("badge.netTitle");
    line.appendChild(chip);
  }

  const txt = document.createElement("span");
  txt.className = "econ-line-txt";
  txt.textContent = `#${s.fromId} → #${s.toId} · ${atomicToUsdc(s.amount).toFixed(4)} · ${gl("goods", s.good)}`;
  line.appendChild(txt);

  // Only a genuinely-mined hash is linkable: real 64-hex + valid. Simulated / offline / shadow
  // settlements (txHash "0x") stay plain text so we never link to something that won't resolve.
  if (s.valid && isRealTxHash(s.txHash)) {
    const a = document.createElement("a");
    a.className = "tx-link";
    a.href = `${ARC_EXPLORER}/tx/${s.txHash}`;
    a.target = "_blank";
    a.rel = "noopener noreferrer";
    a.title = T("feed.verifyHash", { hash: s.txHash });
    a.textContent = `↗ ${shortHash(s.txHash)}`;
    line.appendChild(a);
  }

  host.prepend(line);
  while (host.children.length > 3) host.lastChild.remove();
}
/** Show one fly's x402 agent wallet in the inspector. `ag` carries atomic-string amounts. */
export function updateWallet(ag) {
  if (!ag) return;
  const set = (id, v) => { const el = $(id); if (el) el.textContent = v; };
  set("ins-bal", atomicToUsdc(ag.balance || "0").toFixed(4));
  // In live onchain mode the wallet address links to this agent's on-chain activity in the Arc
  // explorer (works on mobile too, where the ledger feed is hidden). Otherwise it stays plain text.
  const addrEl = $("ins-addr");
  if (addrEl) {
    if (state.econMode === "onchain" && isRealAddr(ag.address)) {
      addrEl.textContent = "";
      const a = document.createElement("a");
      a.href = `${ARC_EXPLORER}/address/${ag.address}`;
      a.target = "_blank";
      a.rel = "noopener noreferrer";
      a.title = T("ins.viewActivity", { addr: ag.address });
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
export function applyEconAgents(agents) {
  state.econAgents = agents;
  rebuildHouseMap();              // fresh roster → refresh the dynasty bloodline tint
  refreshBalanceScale();          // fresh roster → refresh the wealth scale that drives fly size
  if (state.walletsOpen) renderWallets();
}
/** Live: the /economy roster. Offline/pre-deploy: mirror the local synth wallets so the drawer is
 *  never empty. Both are normalised to {id, address, balance(atomic), paid, earned, deals, sales}. */
export function rosterSource() {
  if (state.econAgents.length) return state.econAgents;
  return [...synthAgents.entries()].map(([id, a]) => ({
    id: Number(id), address: a.address, balance: a.balance, paid: a.paid, earned: a.earned, deals: a.deals, sales: a.sales,
  }));
}
export function applySnapshot(snap) {
  if (!snap || !snap.collective) return;
  state.collective = snap.collective;
  state.tempTarget = clamp(snap.collective.temperature);
  state.cohTarget = clamp(snap.collective.cohesion);

  const seen = new Set();
  const now = performance.now();
  for (const r of snap.flies) {
    seen.add(r.id);
    let f = sim.get(r.id);
    if (!f) { f = spawnFly(r.id); f.born = now; sim.set(r.id, f); }
    f.dying = false; f.dieT = 0;
    f.tAro = r.arousal; f.tCoh = r.cohesion; f.tTurn = r.turnBias; f.tWing = r.wingbeat; f.tRest = r.rest;
    f.state = r.state; f.temperament = r.temperament; f.fingerprint = r.fingerprint;
    // ethogram read-out (never a settlement input): the named action pattern + its carriers drive the pose
    if (r.fap) { if (f.tFap !== r.fap) f.boutAge = 1; else f.boutAge = (f.boutAge || 1) + 1; f.fap = f.tFap = r.fap; }
    if (typeof r.valence === "number") f.tValence = r.valence;
    if (typeof r.heading === "number") f.tHeading = r.heading;
    if (r.role) f.role = r.role;
    if (Array.isArray(r.bouts)) f.bouts = r.bouts;
  }
  // retire flies that vanished from the snapshot
  for (const [id, f] of sim) if (!seen.has(id) && !f.dying) f.dying = true;

  updateHud(snap);
  renderDist(snap.collective.states, snap.collective.size);
  if (state.selectedId != null && seen.has(state.selectedId)) fillInspectorFromSim(state.selectedId);

  // a new on-chain tick → fire one shard fan-out pulse (the isolates compute in parallel each cron)
  const ti = snap.tickIndex;
  if (ti != null && (state.lastTickIndex == null || ti > state.lastTickIndex)) { state.lastTickIndex = ti; state.shardPulseT = performance.now(); }
}
export function applyState(st) {
  if (!st) return;
  const m = st.market;
  if (m) {
    $("block").textContent = m.blockNumber != null ? "#" + m.blockNumber : "–";
    $("tpb").textContent = m.txPerBlock != null ? Number(m.txPerBlock).toFixed(1) : "–";
  }
  const cfg = st.config;
  if (cfg) $("chain").textContent = `arc ${cfg.isTestnet ? "testnet " : ""}${cfg.chainId}`;
  if (st.economy && st.economy.mode) {
    state.econMode = st.economy.mode;
    updateEconMode();
    updateEconFoot();
    if (state.walletsOpen) renderWallets();   // a mode change flips the roster's explorer links + subtitle
  }
  // Record the DO cron's heartbeat and let the watchdog judge its freshness (online path only —
  // when offline the catch() hides the bar, since the offline badge already speaks).
  if (typeof st.lastCron === "number") state.cronHeartbeatMs = st.lastCron;
  updateCronWatchdog();
}
/** The cron watchdog: the DO cron writes lastCron every ~60s. If the API is up but the heartbeat has
 *  gone stale, the whole swarm has likely frozen — surface it instead of showing a still image as live. */
export function updateCronWatchdog() {
  const el = $("cron-warn");
  if (!el) return;
  if (state.offline || !state.cronHeartbeatMs) { el.hidden = true; return; }
  const ageMs = Date.now() - state.cronHeartbeatMs;
  if (ageMs > CRON_STALE_MS) {
    const mins = Math.max(1, Math.round(ageMs / 60000));
    el.textContent = T("cron.warnStale", { mins });
    el.hidden = false;
  } else {
    el.hidden = true;
  }
}
export function setStatus(text, cls) {
  $("status").textContent = text;
  const dot = $("link-dot");
  dot.className = "link-dot" + (cls ? " " + cls : "");
}
export const STATUS_KIND = { live: ["top.status.live", "live"], dreaming: ["top.status.dreaming", "off"], offline: ["top.status.offline", "off"], connecting: ["top.status.connecting", ""] };
export function setStatusKind(kind) {
  state.curStatusKind = kind;
  const [k, cls] = STATUS_KIND[kind] || STATUS_KIND.connecting;
  setStatus(T(k), cls);
}
// ================= HUD =================
export function updateHud(snap) {
  const c = snap.collective;
  $("temp").textContent = c.temperature.toFixed(2);
  $("regime").textContent = c.regime ? gl("regime", String(c.regime).toLowerCase()) : "—";
  $("meter-fill").style.width = (clamp(c.temperature) * 100).toFixed(1) + "%";
  $("vitality").textContent = c.vitality != null ? c.vitality.toFixed(2) : "–";
  $("tick").textContent = "#" + (snap.tickIndex ?? "–");
}
export const DIST_ORDER = ["AGITATE", "EXPLORE", "AGGREGATE", "REST"];
// last {states,size} so a language switch can repaint the legend instantly
export function renderDist(states, size) {
  const host = $("dist");
  const lg = currentLang();
  if (!host.children.length || state._distLang !== lg) {
    state._distLang = lg;
    host.innerHTML = DIST_ORDER.map((s) => `<span class="dist-seg ${s.toLowerCase()}"></span>`).join("");
    $("dist-legend").innerHTML = DIST_ORDER.map(
      (s) => `<li><span class="sw" style="background:var(--${s.toLowerCase()})"></span>${T("pop.state." + s.toLowerCase())}<b data-k="${s}">0</b></li>`
    ).join("");
  }
  const st = states || {};
  state._lastDist = { states: st, size };
  for (const s of DIST_ORDER) {
    const c = st[s] || 0;
    const seg = host.querySelector(".dist-seg." + s.toLowerCase());
    if (seg) { seg.style.flexGrow = c; seg.classList.toggle("zero", c === 0); }
    const b = $("dist-legend").querySelector(`b[data-k="${s}"]`);
    if (b) b.textContent = c;
  }
  // "live N/cap": the current live trading population over its hard growth ceiling. Shown ONLY once growth
  // is actually configured (cap > genesis); while the ceiling equals the founding cohort the count renders
  // exactly as before, and before the read-only topology arrives it degrades to just N.
  const cap = state.topology && state.topology.maxLivePopulation;
  const genesis = state.topology && state.topology.populationSize;
  const growing = cap != null && genesis != null && cap > genesis;
  $("size").textContent = size != null ? (growing ? `${size}/${cap}` : size) : "–";
}
