// polling.js — 全部 pollXxx + getJSON + load* + offline 合成
// 由 app.js 机械拆分（任务5），行为与原文件一致；原文件保留为 app.js 备份参考。
import { state, API, FAP_ROLE, FETCH_TIMEOUT_MS, OFFLINE_BACKOFF_MS, clamp, readLineageHead } from './shared.js';
import { arenaReadUser, d0LineageAddr, mergeLaureateEntries, paintArena, paintLaureate, paintPredict, renderApprenticeSection, renderArchiveSection, renderBourseSection, renderBrain, renderChron, renderChronVerdict, renderCitiesSection, renderCommonsSection, renderCourtSection, renderCultureSection, renderGamesSection, renderGuardiansSection, renderGuildSection, renderHistory, renderLexSection, renderLineage, renderMarketSection, renderProofs, renderReligionSection, renderRumorSection, renderTechSection, renderTreatySection, renderWarSection, renderWorksSection, renderWorkshopSection, updateSinceLaunch, verifyBrain } from './drawers.js';
import { applyEconAgents, applyEconomy, applySnapshot, applyState, applyTopology, setStatusKind, updateCronWatchdog } from './economy.js';
import { spawnChronFx } from './render2d.js';
import { evaluateCivStage } from './civstage.js';   // task 32: civStage 选择器（事件驱动，数据到达时评估）

// two-stage codex: "index" lists the volumes, "volume" shows one full-height page
// offline: a purely client-side mirror of the agent economy so the piece still settles pre-deploy
export const synthAgents = new Map();
// ================= swarm history drawer (D1-backed, right side) =================
// The Worker archives one row per cron to D1; this drawer turns that permanent history into charts the
// session-only ribbon can't: temperature, cumulative USDC settled, wealth gini and settlements-per-cron,
// plus a since-launch summary. Everything degrades to "awaiting archive…" when D1 is unbound.
export async function pollHistory() {
  try {
    const h = await getJSON("/history?order=desc&limit=700", 6000);
    if (h && h.enabled) {
      state.histEnabled = true;
      state.histRows = Array.isArray(h.rows) ? h.rows.slice().reverse() : [];   // desc → ascending for charts
      state.histSummary = h.summary || null;
      if (state.historyOpen) renderHistory(); else updateSinceLaunch();
    } else {
      state.histEnabled = false;
    }
  } catch { /* best-effort: history is a nicety and must never block the scene */ }
}
// ================= the chronicle drawer (opened from the bottom-right button) =================
// Poll /annals — the deterministic historian's timeline. The poll runs whether or not the drawer is open,
// so the sheet is never stale when the button pulls it in: era badge, entry list, and the browser-side
// verdict if a proof has been run.
export async function pollChron() {
  try {
    const r = await getJSON("/annals?order=desc&limit=120", 6000);
    if (r && r.enabled) {
      state.chronEnabled = true;
      state.chronRows = Array.isArray(r.entries) ? r.entries.slice() : [];   // already desc by seq
      state.chronMeta = { era: r.era, eraName: r.eraName, eraRegime: r.eraRegime, seq: r.seq,
        eraShock: r.eraShock || null, eraShockWilled: !!r.eraShockWilled,
        headHash: r.headHash || null, chroniclerHash: r.chroniclerHash || null, version: r.version || null,
        // ⑫ ACCELERATED AGES: the fast civilizational clock (absent on an older worker ⇒ null, header stays as-is)
        generation: Number.isFinite(r.generation) ? r.generation : null,
        civLevel: Number.isFinite(r.civLevel) ? r.civLevel : null,
        civPhase: r.civPhase || null };
      // the chronicle made visible: hand every entry newer than the last-shown seq to the canvas FX
      if (state.chronSeenSeq > 0) for (const e of state.chronRows) { if ((e.seq || 0) <= state.chronSeenSeq) break; spawnChronFx(e); }
      renderChron();          // task 26①: the bottom ticker is gone; the drawer is the only read-out
      if (state.chronVerifyState) renderChronVerdict();
      evaluateCivStage();     // task 32: chronMeta（civLevel/era/generation/eraRegime）刚刷新 → 评估文明档位（签名去重，无变化零成本）
    } else {
      state.chronEnabled = false;
      renderChron();
    }
  } catch { /* best-effort: the chronicle is a nicety, never block the scene */ }
}
// Poll /war — the on-chain coffer read-out (vaults, live bouts, tax purse). Gated client-side on `enabled`,
// so while WAR_ENABLED=false it renders nothing and costs nothing beyond one cheap fetch. Best-effort.
export async function pollWar() {
  try {
    const r = await getJSON("/war", 6000);
    if (r && r.enabled) { state.econWar = r; renderWarSection(); }
    else { state.econWar = null; renderWarSection(); }
  } catch { state.econWar = null; renderWarSection(); }
}
// Poll /bourse — the project coin's live tape (fever, cumulative tax flow, whales, silences). Gated
// client-side on `enabled`, so while BOURSE_ENABLED=false it renders nothing and costs one cheap fetch.
export async function pollBourse() {
  try {
    const r = await getJSON("/bourse", 6000);
    if (r && r.enabled) { state.econBourse = r; renderBourseSection(); }
    else { state.econBourse = null; renderBourseSection(); }
  } catch { state.econBourse = null; renderBourseSection(); }
}
export const PROOFS_POLL_MS = 30000;
// throttle: the book only moves once a cron, so a slow poll is plenty
export const PREDICT_POLL_MS = 20000;
export async function pollProofs(force) {
  const now = Date.now();
  if (!force && now - state.lastProofsPoll < PROOFS_POLL_MS) return;
  state.lastProofsPoll = now;
  try {
    const p = await getJSON("/proofs", 6000);
    if (p && p.enabled) {
      state.proofs = Array.isArray(p.proofs) ? p.proofs : [];
      state.proofsMeta = { version: p.version, policy: p.policy, chainHead: p.chainHead, count: p.count, ipfsGateway: p.ipfsGateway || "" };
      if (state.proofsOpen) renderProofs();
    }
  } catch { /* best-effort: provenance is a nicety and must never block the scene */ }
}
export const LAUREATE_POLL_MS = 30000;
export const LAUREATE_PAGE = 100;
/** Throttled refresh of the head of the chain (latest poem + crowned laureate). Rebuilds only when the head moves. */
export async function pollLaureate(force) {
  const now = Date.now();
  if (!force && now - state.lastLaureatePoll < LAUREATE_POLL_MS) return;
  state.lastLaureatePoll = now;
  try {
    const p = await getJSON("/poem", 6000);
    if (!p) return;
    const prevHead = state.laureateData ? state.laureateData.headSeq : null;
    state.laureateData = p;
    if (p.latest && p.headSeq !== prevHead) mergeLaureateEntries([p.latest]);   // fold a fresh head in immediately
    if (state.laureateOpen && (force || p.headSeq !== prevHead)) paintLaureate();
  } catch { /* best-effort: the poem is a nicety and must never block the scene */ }
}
/** Load the permanent collection from D1 (first page). reset=true clears the accumulator (a fresh open). */
export async function loadLaureateArchive(reset) {
  if (state.laureateLoading) return;
  state.laureateLoading = true;
  if (reset) { state.laureateEntries = []; state.laureateOldest = null; state.laureateTotal = 0; }
  if (state.laureateOpen) paintLaureate();
  try {
    const a = await getJSON(`/poem/archive?limit=${LAUREATE_PAGE}&order=desc`, 9000);
    if (a) {
      state.laureateArchived = a.archived === true;
      state.laureateTotal = Number(a.total) || (Array.isArray(a.entries) ? a.entries.length : 0);
      if (Array.isArray(a.entries)) mergeLaureateEntries(a.entries);
    }
  } catch { /* best-effort */ }
  state.laureateLoading = false;
  if (state.laureateOpen) paintLaureate();
}
/** Load one older page (seq < the oldest loaded so far) and fold it into the collection. */
export async function loadLaureateMore() {
  if (state.laureateLoadingMore || state.laureateOldest == null) return;
  state.laureateLoadingMore = true;
  if (state.laureateOpen) paintLaureate();
  try {
    const a = await getJSON(`/poem/archive?limit=${LAUREATE_PAGE}&order=desc&before=${state.laureateOldest}`, 9000);
    if (a && Array.isArray(a.entries)) mergeLaureateEntries(a.entries);
  } catch { /* best-effort */ }
  state.laureateLoadingMore = false;
  if (state.laureateOpen) paintLaureate();
}
// {clientHash, bodyOk, chain, chainOk} — the in-browser verification result

export async function loadBrain() {
  state.brainLoading = true;
  renderBrain();
  const [m, r] = await Promise.all([
    getJSON("/manifest", 12000).catch(() => null),
    getJSON("/manifest/replay", 12000).catch(() => null),
  ]);
  state.brainData = m;
  state.brainReplay = r;
  state.brainLoading = false;
  if (state.brainData && state.brainData.manifest) await verifyBrain(); else renderBrain();
}
export async function loadLineage() {
  state.lineageLoading = true; renderLineage();
  state.lineageData = await getJSON("/lineage?limit=500", 12000).catch(() => null);
  state.lineageLoading = false; renderLineage();
  // Read the contract head STRAIGHT off Arc (best-effort) so the tree shows live, trustless on-chain status.
  const addr = d0LineageAddr();
  if (addr) { const head = await readLineageHead(addr); if (head) { state.lineageHead = head; renderLineage(); } }
}
/** Throttled background refresh so an open drawer tracks the book as each cron resolves it. */
export async function pollPredict(force) {
  if (!state.predictOpen) return;
  const now = Date.now();
  if (!force && now - state.lastPredictPoll < PREDICT_POLL_MS) return;
  state.lastPredictPoll = now;
  try {
    const p = await getJSON("/predictions", 8000);
    if (p && state.predictOpen) { state.predictData = p; paintPredict(); }
  } catch { /* best-effort: the market is a nicety and must never block the scene */ }
}
// ================= data layer =================
// Every request is timeout + abort guarded. When the Worker is undeployed the
// workers.dev host black-holes TCP (connect never completes), so an unguarded
// fetch hangs for tens of seconds; aborting fast is what stops rapid clicking
// from stacking up stuck requests and stalling the tab.
export async function getJSON(path, timeoutMs = FETCH_TIMEOUT_MS, outerSignal) {
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
export const ROSTER_POLL_MS = 15000;
export async function pollRoster(force) {
  const now = Date.now();
  if (!force && now - state.lastRosterPoll < ROSTER_POLL_MS) return;
  state.lastRosterPoll = now;
  try {
    const econ = await getJSON("/economy", 8000);
    if (econ && Array.isArray(econ.agents)) applyEconAgents(econ.agents);   // → rebuildHouseMap → rebuildTerritoryPolities
  } catch { /* best-effort: the map simply keeps its last roster if the feed hiccups */ }
}
export async function poll() {
  if (state.pollInFlight) return;                        // never overlap polls
  if (Date.now() < state.offlineUntil) {                 // circuit-breaker open → local only
    offlineTick();
    return;
  }
  state.pollInFlight = true;
  try {
    const [pop, st] = await Promise.all([getJSON("/population"), getJSON("/state")]);
    state.offline = false;
    setStatusKind("live");
    if (pop && pop.snapshot) applySnapshot(pop.snapshot);
    if (pop && pop.economy) applyEconomy(pop.economy);
    if (pop && pop.topology) applyTopology(pop.topology);
    applyState(st);
    evaluateCivStage();   // task 32: 种群（sim.size）+ 膜层载荷（econXxx）刚刷新 → 评估文明档位（签名去重）
    // Full agent roster (addresses + per-agent ledgers) for the wallets drawer. Best-effort and
    // non-blocking: a hiccup here must never flip the whole scene offline, so it's off Promise.all.
    // Only fetched while the drawer is actually open (it self-fetches on open too) — the canvas body
    // scale is driven by /population balances, so the roster is not needed on every poll for viewers.
    if (state.walletsOpen) getJSON("/economy").then((econ) => {
      if (!econ) return;
      if (Array.isArray(econ.agents)) applyEconAgents(econ.agents);
      if (econ.market) { state.econMarket = econ.market; renderMarketSection(); }
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
    }).catch(() => {});
    // territory map (opt-in, default off): it needs the house roster, so fetch it — but only while shown
    if (state.showTerritory && !state.walletsOpen) pollRoster();
    pollProofs();   // throttled internally (≤ once / 30s); keeps the provenance drawer fresh
    pollLaureate();  // throttled internally; keeps the Laureate drawer's head + collection fresh
    pollPredict();  // throttled internally; keeps an open prediction book tracking each cron
    pollArena();    // throttled internally; keeps an open arena book + your on-chain position fresh
  } catch (e) {
    if (!state.offline) { state.offline = true; setStatusKind("dreaming"); }
    state.offlineUntil = Date.now() + OFFLINE_BACKOFF_MS;  // stop probing; run local for a while
    offlineTick();                                    // local synthetic mirror + the offline econ badge
    updateCronWatchdog();                             // hide the stale-heartbeat bar (offline badge covers it)
  } finally {
    state.pollInFlight = false;
  }
}
export const ARENA_POLL_MS = 15000;
/** Throttled background refresh so an open drawer tracks the book + your on-chain position each cron. */
export async function pollArena(force) {
  if (!state.arenaOpen) return;
  const now = Date.now();
  if (!force && now - state.lastArenaPoll < ARENA_POLL_MS) return;
  state.lastArenaPoll = now;
  try {
    const a = await getJSON("/arena", 8000);
    if (!a || !state.arenaOpen) return;
    state.arenaData = a;
    await arenaReadUser();
    if (state.arenaOpen) paintArena();
  } catch { /* best-effort: the arena is a nicety and must never block the scene */ }
}
export function synthSnapshot() {
  state.synthPhase += 0.06;
  const target = 0.5 + 0.34 * Math.sin(state.synthPhase * 0.31) * Math.sin(state.synthPhase * 0.11 + 1.3) + 0.06 * Math.sin(state.synthPhase * 0.9);
  const T = clamp(target, 0.04, 0.96);
  const regime = T >= 0.66 ? "HOT" : T <= 0.33 ? "COLD" : "CALM";
  const N = 24, flies = [];
  const states = { AGITATE: 0, EXPLORE: 0, AGGREGATE: 0, REST: 0 };
  const faps = {};
  let sa = 0, sc = 0, sr = 0, sw = 0, sv = 0;
  const pr = (seed) => ((seed >>> 0) % 1000) / 1000;
  // offline ethogram: pick a plausible FAP per behavioural state so the anatomy animates without a Worker
  const FAP_POOL = { AGITATE: ["FLIGHT", "RETREAT", "FORAGE"], EXPLORE: ["FORAGE", "COURT", "GROOM"], AGGREGATE: ["HUDDLE", "FEED", "COURT"], REST: ["REST", "GROOM", "HALT"] };
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
    const pool = FAP_POOL[st] || ["FORAGE"];
    const fap = pool[Math.floor(pr(i * 1597 + 13) * pool.length) % pool.length];
    const valence = clamp((T - 0.5) * -0.7 + (pr(i * 40503 + 9) - 0.5) * 1.1, -1, 1);
    const heading = pr(i * 2654435761 + 17) * Math.PI * 2;
    const role = FAP_ROLE[fap] || "signal-seeker";
    const bouts = [{ fap, ticks: 2 + Math.floor(pr(i * 31 + 1) * 6) }];
    faps[fap] = (faps[fap] ?? 0) + 1; sv += valence;
    flies.push({ id: i, state: st, arousal: aro, turnBias: turn, cohesion: coh, wingbeat: wing, rest, temperament: temper, fingerprint: (0x1000000 + Math.floor(rel * 0xffffff)).toString(16).slice(1, 9), fap, valence, heading, role, bouts });
  }
  return {
    tickIndex: state.synthTick++,
    collective: { temperature: T, regime, vitality: T, size: N, arousal: sa / N, cohesion: sc / N, rest: sr / N, wingbeat: sw / N, states, faps, valence: sv / N },
    flies,
  };
}
// ================= offline synthetic agent economy =================
// A purely client-side mirror of the Worker's AgentEconomy: same goods, same neural-drive → intent
// mapping, same x402-shaped settlements — so the piece settles and shows payment packets even before
// the Worker is deployed. Amounts use plain Number math (tiny values); balances are atomic strings to
// match the live summary shape the renderer already consumes.
export function synthAddr(id) {
  let h1 = (0x811c9dc5 ^ Math.imul(id, 2654435761)) >>> 0;
  let h2 = (0x01000193 ^ 0xfeedface) >>> 0;
  const mix = (c) => { h1 = Math.imul(h1 ^ c, 0x01000193) >>> 0; h2 = Math.imul(h2 ^ c, 0x85ebca6b) >>> 0; };
  const src = "murmur:" + id;
  for (let i = 0; i < src.length; i++) mix(src.charCodeAt(i));
  let out = "", s1 = h1 >>> 0, s2 = h2 >>> 0;
  for (let i = 0; i < 10; i++) { s1 = (Math.imul(s1, 1664525) + 1013904223) >>> 0; s2 = (Math.imul(s2, 22695477) + 1) >>> 0; out += ((s1 ^ s2) >>> 0).toString(16).padStart(8, "0"); }
  return "0x" + out.slice(0, 40);
}
export function synthAgentFor(id) {
  let a = synthAgents.get(id);
  if (!a) { a = { address: synthAddr(id), balance: "10000000", paid: "0", earned: "0", deals: 0, sales: 0 }; synthAgents.set(id, a); }
  return a;
}
export function synthEconomy(snap) {
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
      state.synthVolume += Number(amount); state.synthDeals++;
      made.push({ fromId: buyer.id, toId: seller.id, amount, good, valid: true, tick: snap.tickIndex });
    }
    // keep every local agent solvent so the piece never dies
    for (const [, a] of synthAgents) if (Number(a.balance) < 500000) a.balance = "500000";
  }
  return { lastTick: made, totals: synthTotals(), balances: synthBalances() };
}
export function synthBalances() {
  const b = {};
  for (const [id, a] of synthAgents) b[id] = a.balance;
  return b;
}
export function synthTotals() {
  const bals = [...synthAgents.values()].map((a) => Number(a.balance)).sort((x, y) => x - y);
  const n = bals.length;
  let sum = 0; for (const b of bals) sum += b;
  const meanUsdc = n ? (sum / n) / 1e6 : 0;
  let gini = 0;
  if (n && sum > 0) { let cum = 0; for (let i = 0; i < n; i++) cum += (i + 1) * bals[i]; gini = clamp((2 * cum) / (n * sum) - (n + 1) / n); }
  let richestId = null, poorestId = null, hi = -1, lo = -1;
  for (const [id, a] of synthAgents) { const b = Number(a.balance); if (b > hi) { hi = b; richestId = id; } if (lo < 0 || b < lo) { lo = b; poorestId = id; } }
  return {
    volumeAtomic: String(state.synthVolume), volumeUsdc: state.synthVolume / 1e6, count: state.synthDeals,
    liveAgents: n, meanBalanceUsdc: meanUsdc, gini, treasuryOutAtomic: "0", richestId, poorestId,
  };
}
/** One offline tick: advance the synthetic population AND its mirror economy together. */
export function offlineTick() {
  const s = synthSnapshot();
  applySnapshot(s);
  applyEconomy(synthEconomy(s));
}
