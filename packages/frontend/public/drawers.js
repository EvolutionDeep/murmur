// drawers.js — 全部抽屉 open/close/render（chron 19卷册、wallets、arena 等；inspector 除外）
// 由 app.js 机械拆分（任务5），行为与原文件一致；原文件保留为 app.js 备份参考。
import { state, $, API, ARC_EXPLORER, CHRON_, TAU, arcRpc, arenaClock, atomicToUsdc, clamp, houseOf, isRealAddr, isRealTxHash, isZeroBytes32, lrNum, paletteAt, params, readLineageOnchain, readManifestOnchain, readRegistryOnchain, rgba, sha256HexClient, sha256HexText, shortHash } from './shared.js';
import { ct, currentLang, gl, t as T } from './i18n.js?v=96';
import { applyEconAgents, keeperIds, netting, prophetIds, rosterSource } from './economy.js';
import { select } from './inspector.js';
import { getJSON, loadBrain, loadLaureateArchive, loadLineage, pollArena, pollChron, pollHistory, pollLaureate, pollProofs } from './polling.js';

// ⑥ Professions a fly settles into (specialisation, economic side only) — one glyph each for the wallet row.
export const PROF_ICON = { forager: "❍", mooder: "❂", trader: "⇅", brooder: "❄" };
// The four goods the tape marks, in book order, for the price-line block.
export const MARKET_GOODS = ["signal", "momentum", "attestation", "prediction"];
export function renderWallets() {
  const host = $("wallets-list");
  if (!host) return;
  const list = rosterSource().slice().sort((a, b) => (a.id ?? 0) - (b.id ?? 0));
  const live = state.econMode === "onchain";
  const repOf = new Map(((state.econSocial && state.econSocial.rep) || []).map((r) => [r.id, r]));
  host.textContent = "";
  for (const ag of list) {
    const row = document.createElement("div");
    row.className = "wallet-row" + (ag.id === state.selectedId ? " sel" : "") + (ag.dead ? " gone" : "");
    row.tabIndex = 0;
    row.setAttribute("role", "button");
    row.setAttribute("aria-label", T("wallets.ariaRow", { id: ag.id, bal: atomicToUsdc(ag.balance || "0").toFixed(4) }));

    const idEl = document.createElement("span"); idEl.className = "wr-id"; idEl.textContent = "#" + ag.id;
    // Dynasty: the house name a fly bears (sigil + colour), inherited at birth from its parent's line.
    if (ag.house) {
      const nm = document.createElement("span"); nm.className = "wr-house";
      nm.textContent = `${ag.sigil || ""} ${ag.house}`;
      nm.title = T("social.houseOf", { name: ag.house });
      idEl.append(" ", nm);
    }
    // ⑥ Institutions: the sticky profession a fly has fallen into (its line of work, economic side only).
    if (ag.profession) {
      const prof = document.createElement("span"); prof.className = "wr-prof " + ag.profession;
      prof.textContent = (PROF_ICON[ag.profession] ? PROF_ICON[ag.profession] + " " : "") + gl("role", ag.profession);
      prof.title = T("social.profession", { prof: gl("role", ag.profession) });
      idEl.append(" ", prof);
    }
    const balEl = document.createElement("span"); balEl.className = "wr-bal";
    balEl.innerHTML = `${atomicToUsdc(ag.balance || "0").toFixed(4)} <em>usdc</em>`;
    // ⑥ Institutions: a debt column — the wallet's net worth is balance minus outstanding principal.
    const debtAtomic = BigInt(ag.debtAtomic || "0");
    if (debtAtomic > 0n) {
      const debtUsdc = Number(debtAtomic) / 1e6;
      const net = atomicToUsdc(ag.balance || "0") - debtUsdc;
      const dv = document.createElement("span"); dv.className = "wr-debt";
      dv.textContent = T("badge.debt", { amt: debtUsdc.toFixed(4) });
      dv.title = T("wallets.debtTitle", { amt: debtUsdc.toFixed(4), net: net.toFixed(4) });
      balEl.append(" ", dv);
    }
    // Reputation badge: the fly's NAME, earned from settled history (kept promises vs defaults).
    const rp = repOf.get(Number(ag.id));
    if (rp && (rp.score <= -0.15 || rp.score >= 0.15)) {
      const badge = document.createElement("span");
      const dead = rp.score <= -0.15;
      badge.className = "wr-rep " + (dead ? "dead" : "good");
      badge.textContent = dead ? T("badge.deadbeat") : T("badge.honour");
      badge.title = T("wallets.repTitle", { score: rp.score.toFixed(2), kept: rp.kept, broken: rp.broken });
      balEl.append(" ", badge);
    }
    // Dynasty: a closed ledger — the wallet was buried and its estate inherited (see the monuments).
    if (ag.dead) {
      const grave = document.createElement("span");
      grave.className = "wr-grave";
      grave.textContent = T("badge.buried");
      grave.title = T("wallets.graveTitle");
      balEl.append(" ", grave);
    }
    const addrEl = document.createElement("span"); addrEl.className = "wr-addr";
    addrEl.textContent = isRealAddr(ag.address) ? shortHash(ag.address) : (ag.address || "–");
    row.append(idEl, balEl, addrEl);

    if (live && isRealAddr(ag.address)) {
      const link = document.createElement("a");
      link.className = "wr-link";
      link.href = `${ARC_EXPLORER}/address/${ag.address}`;
      link.target = "_blank"; link.rel = "noopener noreferrer";
      link.title = T("wallets.verifyWallet", { addr: ag.address });
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
  if (sub) sub.textContent = live ? T("wallets.live", { n: list.length }) : T("wallets.sim", { n: list.length, mode: state.econMode });
  renderSocialSection();
}
// ================= social memory section (in the chronicle panel) =================
// The ledger of relationships: who trusts whom, who shuns whom, and the grudge book. Pure read-out of
// the economy's persisted bonds — the same memory that steers counterparty choice on-chain-adjacent.
export function renderSocialSection() {
  const host = $("wallets-social");
  if (!host) return;
  const s = state.econSocial;
  if (!s || ((!s.bonds || !s.bonds.length) && (!s.grudges || !s.grudges.length))) { host.hidden = true; return; }
  host.hidden = false;
  const body = $("wallets-social-body");
  if (!body) return;
  body.textContent = "";
  // show every bond the worker returns (up to its 24-cap) — the swarm's memory is fuller than the old 8-row slice revealed
  for (const b of (s.bonds || []).slice(0, 24)) {
    const row = document.createElement("div");
    const shun = b.score <= -0.6;
    row.className = "wsoc-row " + (b.score < 0 ? (shun ? "shun" : "grudge") : "trust");
    const mark = shun ? T("social.shuns") : b.score < 0 ? T("social.grudge") : T("social.trust");
    row.textContent = `#${b.a} ${mark} #${b.b} · ${b.score > 0 ? "+" : ""}${b.score.toFixed(2)}${b.trades ? ` · ${b.trades} ${T("social.deals")}` : ""}`;
    body.appendChild(row);
  }
  const gr = (s.grudges || []).slice(0, 24);
  if (gr.length) {
    const head = document.createElement("div");
    head.className = "wsoc-head-grudge"; head.textContent = T("social.grudgeBook");
    body.appendChild(head);
    for (const g of gr) {
      const row = document.createElement("div");
      row.className = "wsoc-row grudge-entry";
      row.textContent = T("social.grudgeEntry", { buyer: g.buyerId, seller: g.sellerId, amt: (Number(g.amount) / 1e6).toFixed(4), tick: g.tick });
      body.appendChild(row);
    }
  }
}
// ================= dynasty section (in the chronicle panel) =================
// The houses with names, treasuries and generations — and the monuments carved for the dead. Pure
// read-out of the economy's kinship ledger; the same memory the HOUSE_FOUNDED / DYNASTY / ELEGY lines tell.
export function renderDynastySection() {
  const host = $("chron-dynasty");
  if (!host) return;
  const d = state.econDynasty;
  const houses = (d && d.houses) || [];
  const graves = (d && d.graves) || [];
  if (!houses.length && !graves.length) { host.hidden = true; return; }
  host.hidden = false;
  const hh = $("dyn-houses");
  if (hh) {
    hh.textContent = "";
    for (const h of houses.slice(0, 16)) {
      const row = document.createElement("div");
      row.className = "dyn-row";
      row.textContent = T("dyn.house", { sigil: h.sigil, name: h.name, gen: h.gen, live: h.live, members: h.members, share: (h.capitalShare * 100).toFixed(1), vault: Number(h.treasuryUsdc).toFixed(4) });
      row.title = T("dyn.houseTitle", { tick: h.foundedTick, id: h.id, deaths: h.deaths, earned: Number(h.earnedUsdc).toFixed(4) });
      hh.appendChild(row);
    }
  }
  const head = $("dyn-graves-head");
  const gb = $("dyn-graves");
  if (head && gb) {
    gb.textContent = "";
    head.hidden = graves.length === 0;
    for (const g of graves.slice(0, 12)) {
      const row = document.createElement("div");
      row.className = "dyn-grave";
      row.textContent = T("dyn.grave", { id: g.id, house: g.houseName ? " · " + g.houseName : " · " + T("dyn.noHouse"), cause: gl("cause", g.cause), deals: g.deals });
      row.title = T("dyn.graveTitle", { estate: Number(g.estateUsdc).toFixed(4), heirs: g.heirIds && g.heirIds.length ? g.heirIds.map((x) => "#" + x).join(", ") : T("dyn.theCommons"), age: g.age, tick: g.tick });
      gb.appendChild(row);
    }
  }
}
// ================= institutions section (in the wallets drawer) =================
// The tape: what the deterministic order-book marked each good at over the last crons, who does what for
// a living, and the state of credit. Pure read-out of the economy's market block — nothing here feeds back
// into behaviour; it is the market's own moods made visible. Degrades to hidden while institutions are off.
export function sparkline(values) {
  // A tiny SVG polyline: values (USDC numbers) left→right, vertically fit to their own min..max.
  const w = 104, h = 24, pad = 2;
  const ns = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(ns, "svg");
  svg.setAttribute("class", "wmk-spark");
  svg.setAttribute("viewBox", `0 0 ${w} ${h}`);
  svg.setAttribute("width", w); svg.setAttribute("height", h);
  svg.setAttribute("preserveAspectRatio", "none");
  if (!values || values.length < 2) return svg;
  let lo = Infinity, hi = -Infinity;
  for (const v of values) { if (v < lo) lo = v; if (v > hi) hi = v; }
  const span = hi - lo || 1;
  const step = (w - pad * 2) / (values.length - 1);
  const pts = values.map((v, i) => `${(pad + i * step).toFixed(1)},${(h - pad - ((v - lo) / span) * (h - pad * 2)).toFixed(1)}`).join(" ");
  const line = document.createElementNS(ns, "polyline");
  line.setAttribute("points", pts);
  line.setAttribute("fill", "none");
  line.setAttribute("stroke", "currentColor");
  line.setAttribute("stroke-width", "1.3");
  svg.appendChild(line);
  return svg;
}
export function renderMarketSection() {
  const host = $("wallets-market");
  const body = $("wallets-market-body");
  if (!host || !body) return;
  const m = state.econMarket;
  if (!m || !m.marks) { host.hidden = true; return; }
  host.hidden = false;
  body.textContent = "";
  // One row per good: a sparkline of its mark history, its latest mark, and the move across the tape.
  for (const good of MARKET_GOODS) {
    const tape = m.marks[good];
    if (!Array.isArray(tape) || !tape.length) continue;
    const usdc = tape.map((a) => Number(a) / 1e6);
    const last = usdc[usdc.length - 1];
    const first = usdc[0];
    const chg = first > 0 ? (last / first - 1) : 0;
    const row = document.createElement("div");
    row.className = "wmk-row" + (chg >= 0 ? " up" : " down");
    row.appendChild(sparkline(usdc));
    const nm = document.createElement("span"); nm.className = "wmk-good"; nm.textContent = gl("goods", good);
    const mk = document.createElement("span"); mk.className = "wmk-mark";
    mk.textContent = `${last.toFixed(4)} usdc`;
    const pc = document.createElement("span"); pc.className = "wmk-chg";
    pc.textContent = `${chg >= 0 ? "+" : ""}${(chg * 100).toFixed(1)}%`;
    row.append(nm, mk, pc);
    row.title = T("mkt.rowTitle", { good: gl("goods", good), last: last.toFixed(4), dir: chg >= 0 ? T("mkt.up") : T("mkt.down"), pct: (chg * 100).toFixed(1), n: usdc.length });
    body.appendChild(row);
  }
  // A one-line ledger of credit and class beneath the tape.
  const foot = document.createElement("div");
  foot.className = "wmk-foot";
  const cls = m.classes || {};
  const bits = [];
  const profs = m.professions || {};
  bits.push(T("mkt.profs", { trader: profs.trader || 0, forager: profs.forager || 0, mooder: profs.mooder || 0, brooder: profs.brooder || 0 }));
  bits.push(T("mkt.notes", { n: m.openIous || 0, owed: (Number(m.debtAtomic || "0") / 1e6).toFixed(4) }));
  if (cls.creditors || cls.debtors) bits.push(T("mkt.classes", { creditors: cls.creditors || 0, debtors: cls.debtors || 0 }));
  foot.textContent = bits.join(" · ");
  if (m.run) {
    const badge = document.createElement("span"); badge.className = "wmk-run"; badge.textContent = T("mkt.run");
    badge.title = T("mkt.runTitle");
    foot.append(" ", badge);
  }
  body.appendChild(foot);
}
// ================= culture section (in the chronicle panel) =================
// The commons in custom: the fashion sweeping the swarm and the house holding its old way against it. A
// pure read-out of the culture membrane — beliefs decoded after the neurons, never written back to them.
export function renderCultureSection() {
  const host = $("chron-culture");
  const body = $("cult-body");
  if (!host || !body) return;
  const c = state.econCulture;
  const trend = c && c.trend, trad = c && c.tradition;
  if (!trend && !trad) { host.hidden = true; return; }
  host.hidden = false;
  body.textContent = "";
  if (trend) {
    const row = document.createElement("div");
    row.className = "cult-row cult-trend";
    row.textContent = T("cult.trend", { n: trend.adherents, fap: gl("fap", trend.fap), share: (trend.share * 100).toFixed(0) });
    row.title = T("cult.trendTitle");
    body.appendChild(row);
  }
  if (trad) {
    const row = document.createElement("div");
    row.className = "cult-row cult-trad";
    row.textContent = T("cult.trad", { name: trad.name, sigil: trad.sigil, fap: gl("fap", trad.fap), streak: trad.streak });
    row.title = T("cult.tradTitle");
    body.appendChild(row);
  }
}
// ================= the faith section (in the chronicle panel) =================
// ⑪ The faith membrane made legible: the god reigning over the tape this cron, the holy-day countdown, and
// the ancestor cults with their living flock and prophets. A pure read-out of religion.ts — it converts no
// brain and moves no money; on a holy day the devout simply rest. Hidden while RELIGION_ENABLED is off.
export function renderReligionSection() {
  const c = state.econReligion;
  // keep the canvas read-out in sync whether or not the drawer is open (prophet halos + the holy-day wash)
  state.holyDay = !!(c && c.holyIn === 0);
  prophetIds.clear();
  if (c && Array.isArray(c.sects)) for (const s of c.sects) if (s && s.prophetId != null) prophetIds.add(s.prophetId);
  // cache a light summary for the canvas totem (the reigning god + the sects' sizes) so the frame loop never
  // re-walks econReligion — refreshed here on every religion poll, whether or not the drawer is open.
  state.chronFaith = c ? { reigning: c.reigning, sects: (Array.isArray(c.sects) ? c.sects : []).map((s) => ({ name: s.name, adherents: s.adherents || 0, prophetId: s.prophetId != null ? s.prophetId : null })) } : null;
  const host = $("chron-religion");
  const body = $("rel-body");
  if (!host || !body) return;
  if (!c) { host.hidden = true; return; }
  host.hidden = false;
  body.textContent = "";
  const head = document.createElement("div");
  head.className = "rel-row rel-reign";
  head.textContent = T("rel.reigning", { god: gl("god", c.reigning) }) + " · " +
    (c.holyIn === 0 ? T("rel.holyNow") : T("rel.holyIn", { n: c.holyIn }));
  head.title = T("rel.reigningTitle");
  body.appendChild(head);
  for (const s of (c.sects || [])) {
    const row = document.createElement("div");
    row.className = "rel-row rel-sect";
    row.textContent = T("rel.sect", { name: s.name, n: s.adherents }) +
      (s.prophetId != null ? " " + T("rel.prophet", { id: s.prophetId }) : "");
    row.title = T("rel.sectTitle");
    body.appendChild(row);
  }
}
// ================= the commons section (in the chronicle panel) =================
// The commons in law: the assembly the swarm seats when a new era dawns, the two knobs it re-prices, and
// the law now in force. A pure read-out of commons.ts — it moves no money, only re-prices the credit line
// and its rate through the same rails. Hidden while LAW is off or no council is seated yet.
export function renderCommonsSection() {
  const host = $("chron-commons");
  const body = $("com-body");
  if (!host || !body) return;
  const c = state.econCommons;
  if (!c || !(c.seatedEra > 0)) { host.hidden = true; return; }
  host.hidden = false;
  body.textContent = "";
  const roman = (n) => {
    if (!n || n <= 0) return String(n ?? "");
    const m = [[1000,"M"],[900,"CM"],[500,"D"],[400,"CD"],[100,"C"],[90,"XC"],[50,"L"],[40,"XL"],[10,"X"],[9,"IX"],[5,"V"],[4,"IV"],[1,"I"]];
    let out = "", rest = n; for (const [v, s] of m) while (rest >= v) { out += s; rest -= v; } return out;
  };
  const seats = Array.isArray(c.seats) ? c.seats : [];
  const asb = document.createElement("div");
  asb.className = "com-row com-assembly";
  asb.textContent = T("com.assembly", { era: roman(c.seatedEra), n: seats.length });
  asb.title = T("com.assemblyTitle");
  body.appendChild(asb);
  if (seats.length) {
    const roster = document.createElement("div");
    roster.className = "com-row com-roster";
    roster.textContent = seats.slice(0, 8).map((s) => `#${s.id}·${Number(s.balanceUsdc).toFixed(3)}ᵁ·${(Number(s.rep) * 100).toFixed(0)}r`).join("  ");
    roster.title = T("com.rosterTitle");
    body.appendChild(roster);
  }
  const decrees = Array.isArray(c.decrees) ? c.decrees : [];
  const label = (p) => (p === "creditCap" ? T("com.creditLine") : T("com.rate"));
  for (const d of decrees) {
    const row = document.createElement("div");
    row.className = "com-row com-decree";
    row.textContent = T("com.decree", { param: label(d.param), val: Number(d.target).toFixed(4), era: roman(d.passedEra) });
    row.title = T("com.decreeTitle");
    body.appendChild(row);
  }
  const eff = c.effective || {};
  const line = eff.creditCapBaseUsdc != null ? Number(eff.creditCapBaseUsdc).toFixed(4) : T("com.base");
  const rate = eff.iouRatePer10 != null ? Number(eff.iouRatePer10).toFixed(4) : T("com.base");
  const eRow = document.createElement("div");
  eRow.className = "com-row com-eff";
  eRow.textContent = T("com.eff", { line, rate });
  eRow.title = T("com.effTitle");
  body.appendChild(eRow);
  // every past assembly, newest first: the law they made was superseded when a newer room took the seats,
  // so each is shown voided but kept complete — its full roster and its decrees, as memory (bounded to 24).
  const hist = Array.isArray(c.history) ? c.history : [];
  if (hist.length) {
    const hHead = document.createElement("div");
    hHead.className = "com-row com-void-head";
    hHead.textContent = T("com.voidHead");
    body.appendChild(hHead);
    for (const a of hist) {
      const hs = Array.isArray(a.seats) ? a.seats : [];
      const hd = Array.isArray(a.decrees) ? a.decrees : [];
      const row = document.createElement("div");
      row.className = "com-row com-voided";
      row.textContent = T("com.voided", { era: roman(a.era), n: hs.length, d: hd.length });
      row.title = T("com.voidedTitle");
      body.appendChild(row);
      if (hs.length) {
        const r2 = document.createElement("div");
        r2.className = "com-row com-roster com-voided";
        r2.textContent = hs.map((s) => `#${s.id}·${Number(s.balanceUsdc).toFixed(3)}ᵁ·${(Number(s.rep) * 100).toFixed(0)}r`).join("  ");
        r2.title = T("com.rosterTitle");
        body.appendChild(r2);
      }
      for (const d of hd) {
        const dr = document.createElement("div");
        dr.className = "com-row com-decree com-voided";
        dr.textContent = T("com.decree", { param: label(d.param), val: Number(d.target).toFixed(4), era: roman(d.passedEra) });
        dr.title = T("com.decreeTitle");
        body.appendChild(dr);
      }
    }
  }
}
// ================= ⑬ the ladder of arts section (in the chronicle panel) =================
// The swarm's technology, read off invention.ts: every art it has found, greatest rung first, with the minds
// that now work by it, the arts a dark age unlearned, and the rung it is waiting on next. A pure read-out —
// no art is ever granted to a fly, and none of it touches the connectome or the purse. Hidden while TECH is off.
export function renderTechSection() {
  const host = $("chron-tech");
  const body = $("tech-body");
  if (!host || !body) return;
  const c = state.econTech;
  const rungs = (c && Array.isArray(c.rungs)) ? c.rungs : [];
  if (!c || !rungs.length) { host.hidden = true; return; }
  host.hidden = false;
  body.textContent = "";
  const lost = Array.isArray(c.lost) ? c.lost : [];
  const head = document.createElement("div");
  head.className = "tech-row tech-head";
  head.textContent = T("tech.head", { n: rungs.length, total: rungs.length + lost.length });
  head.title = T("tech.headTitle");
  body.appendChild(head);
  for (const r of rungs.slice().sort((a, b) => b.rung - a.rung)) {
    const row = document.createElement("div");
    row.className = "tech-row tech-rung";
    row.textContent = T("tech.rung", { rung: r.rung, name: r.name, adopted: r.adopted, gen: r.gen });
    row.title = r.houseName ? T("tech.rungCredited", { house: r.houseName }) : T("tech.rungTitle");
    body.appendChild(row);
  }
  for (const l of lost.slice().sort((a, b) => b.rung - a.rung)) {
    const row = document.createElement("div");
    row.className = "tech-row tech-lost";
    row.textContent = T("tech.lost", { rung: l.rung, name: l.name });
    row.title = T("tech.lostTitle");
    body.appendChild(row);
  }
  if (c.next) {
    const row = document.createElement("div");
    row.className = "tech-row tech-next";
    row.textContent = T("tech.next", { name: c.next.name, gen: c.next.needGen, civ: c.next.needCiv });
    row.title = T("tech.nextTitle");
    body.appendChild(row);
  }
}
// ================= ⑭ the settlements section (in the chronicle panel) =================
// The zone grid read as GEOGRAPHY: the same home zones that re-price a deal, aggregated into named places
// ranked hamlet → town → city, the road between the two greatest, and the census the membrane strikes once a
// generation off the grave ring. A pure read-out of cities.ts — it moves no fly and models no contagion.
export function renderCitiesSection() {
  const host = $("chron-cities");
  const body = $("cities-body");
  if (!host || !body) return;
  const c = state.econCities;
  const places = (c && Array.isArray(c.settlements)) ? c.settlements : [];
  const demo = (c && c.demography) || null;
  if (!c || (!places.length && !demo)) { host.hidden = true; return; }
  host.hidden = false;
  body.textContent = "";
  if (places.length) {
    const head = document.createElement("div");
    head.className = "city-row city-head";
    head.textContent = T("cities.head", { n: places.length, urban: c.urbanPop, pct: Math.round((c.urbanShare || 0) * 100) });
    head.title = T("cities.headTitle");
    body.appendChild(head);
    for (const s of places.slice(0, 16)) {
      const row = document.createElement("div");
      row.className = "city-row city-place city-" + String(s.rank || "hamlet").toLowerCase();
      row.textContent = T("cities.place", {
        name: s.name, rank: T("rank." + String(s.rank || "").toLowerCase()), pop: s.pop,
        house: s.houseName ? T("cities.heldBy", { sigil: s.sigil || "", name: s.houseName }) : T("cities.unheld"),
      });
      row.title = T("cities.placeTitle");
      body.appendChild(row);
    }
    if (c.road) {
      const row = document.createElement("div");
      row.className = "city-row city-road";
      row.textContent = T("cities.road", { a: c.road.a, b: c.road.b });
      row.title = T("cities.roadTitle");
      body.appendChild(row);
    }
  }
  if (demo && (demo.size > 0 || demo.graves > 0)) {
    const row = document.createElement("div");
    row.className = "city-row city-census";
    row.textContent = T("cities.census", {
      size: demo.size, living: demo.living, dead: demo.dead,
      births: demo.births, deaths: demo.deaths, gen: demo.generation,
    });
    row.title = T("cities.censusTitle");
    body.appendChild(row);
    if (demo.graves > 0 && demo.meanAge != null) {
      const m = document.createElement("div");
      m.className = "city-row city-mort";
      m.textContent = T("cities.mortality", { graves: demo.graves, age: demo.meanAge, cause: demo.topCause ? gl("cause", demo.topCause) : T("cities.unknownCause") });
      m.title = T("cities.mortalityTitle");
      body.appendChild(m);
    }
  }
}
// ================= ⑯ the apprenticeship section (in the chronicle panel) =================
// Education + cumulative culture, read off apprentice.ts: who among the living carries which rung of ⑬'s public
// ladder, which hands have surpassed their first teacher, which house-families have raised a school, and the
// fragile-knowledge count (the last keeper of an art dying untaught). A pure read-out — it teaches nothing new
// to any fly and moves no neuron. Hidden while APPRENTICE is off, or while TECH withholds the ladder.
export function renderApprenticeSection() {
  const a = state.econApprentice;
  const keepers = (a && Array.isArray(a.keepers)) ? a.keepers : [];
  const schools = (a && Array.isArray(a.schools)) ? a.schools : [];
  // keep the canvas read-out in sync whether or not the drawer is open: mark the flies that are the LAST living
  // keeper of their craft (a sole hand on an art) so the frame loop can halo them as fragile knowledge. Cheap,
  // recomputed only on an apprentice poll; the render loop reads the Set, never re-derives it.
  keeperIds.clear();
  {
    const byCraft = new Map();
    for (const k of keepers) { if (!k || k.id == null) continue; const c = String(k.craft || ""); byCraft.set(c, (byCraft.get(c) || 0) + 1); }
    for (const k of keepers) { if (!k || k.id == null) continue; if ((byCraft.get(String(k.craft || "")) || 0) === 1) keeperIds.add(k.id); }
  }
  const host = $("chron-apprentice");
  const body = $("appr-body");
  if (!host || !body) return;
  if (!a || (!keepers.length && !schools.length && !a.lineages)) { host.hidden = true; return; }
  host.hidden = false;
  body.textContent = "";
  // header: skilled / swarm top / cumulative lessons taught.
  const head = document.createElement("div");
  head.className = "appr-row appr-head";
  head.textContent = T("appr.head", { skilled: a.skilled, top: a.topCraft, lineages: a.lineages });
  head.title = T("appr.headTitle");
  body.appendChild(head);
  // the top keepers (already sorted greatest-craft-first server-side).
  for (const k of keepers.slice(0, 12)) {
    const row = document.createElement("div");
    row.className = "appr-row appr-keeper";
    row.textContent = T("appr.keeper", { id: k.id, craft: k.craft, name: k.name || "" });
    row.title = T("appr.keeperTitle", { craft: k.craft });
    body.appendChild(row);
  }
  // standing schools (art + house + adherents).
  for (const s of schools.slice(0, 6)) {
    const row = document.createElement("div");
    row.className = "appr-row appr-school";
    row.textContent = T("appr.school", {
      name: s.name || "", adherents: s.adherents,
      house: s.houseName || "—", sigil: s.sigil || "",
    });
    row.title = T("appr.schoolTitle");
    body.appendChild(row);
  }
}
// ⑰ ARCHIVE section — the records carved in stone, the minds that read them, the fires that took them.
export function renderArchiveSection() {
  const host = $("chron-archive");
  const body = $("arch-body");
  if (!host || !body) return;
  const a = state.econArchive;
  const records = (a && Array.isArray(a.records)) ? a.records : [];
  if (!a || (!records.length && !a.recorded && !a.decodes)) { host.hidden = true; return; }
  host.hidden = false;
  body.textContent = "";
  // header: records surviving / cumulative inscriptions / cumulative decodes.
  const head = document.createElement("div");
  head.className = "arch-row arch-head";
  head.textContent = T("arch.head", { records: records.length, recorded: a.recorded, decodes: a.decodes });
  head.title = T("arch.headTitle");
  body.appendChild(head);
  // each surviving record: rung, name, who carved it.
  for (const r of records.slice(0, 16)) {
    const row = document.createElement("div");
    row.className = "arch-row arch-record";
    row.textContent = T("arch.record", { id: r.recordedBy, rung: r.rung, name: r.name || "" });
    row.title = T("arch.recordTitle", { tick: r.tick });
    body.appendChild(row);
  }
}
// ================= ⑱ the workshop section (knowledge rebirth) =================
export function renderWorkshopSection() {
  const host = $("chron-workshop");
  const body = $("wrk-body");
  if (!host || !body) return;
  const w = state.econWorkshop;
  if (!w || !w.reinventions) { host.hidden = true; return; }
  host.hidden = false;
  body.textContent = "";
  const head = document.createElement("div");
  head.className = "wrk-row wrk-head";
  head.textContent = T("wrk.head", { n: w.reinventions });
  head.title = T("wrk.headTitle");
  body.appendChild(head);
  if (w.reinvention) {
    const row = document.createElement("div");
    row.className = "wrk-row wrk-event";
    row.textContent = T("wrk.event", { id: w.reinvention.id, rung: w.reinvention.rung, name: w.reinvention.name || "" });
    body.appendChild(row);
  }
}
// ================= ⑳ the court section (verdicts, exile, amnesty) =================
// A plain-language docket read-out of court.ts: how many cases the court has sat and how they ended,
// who stands exiled beyond the commons' protection right now. PURE READ-OUT — the court moves no money;
// its roll is its own bounded book. The whole volume (tab included) hides while /economy ships no court key.
export function renderCourtSection() {
  const host = $("chron-court");
  const body = $("crt-body");
  if (!host || !body) return;
  const tab = document.querySelector('#chron-tabs .chron-tab[data-vol="court"]');
  const c = state.econCourt;
  if (!c || !c.counts) {
    host.hidden = true;
    if (tab) { tab.hidden = true; if (tab.classList.contains("is-on")) setChronVol("annals"); }
    return;
  }
  if (tab) tab.hidden = false;
  host.hidden = false;
  body.textContent = "";
  const n = c.counts;
  const head = document.createElement("div");
  head.className = "crt-row crt-head";
  head.textContent = T("crt.head", { indicted: n.indicted, convicted: n.convicted, cleared: n.cleared });
  head.title = T("crt.headTitle");
  body.appendChild(head);
  const toll = document.createElement("div");
  toll.className = "crt-row crt-toll";
  toll.textContent = T("crt.toll", { exiles: n.exiles, amnesties: n.amnesties, open: c.openCases || 0 });
  body.appendChild(toll);
  const roll = (c.outlaws || []).slice(-6).reverse();
  for (const o of roll) {
    const row = document.createElement("div");
    row.className = "crt-row crt-outlaw";
    row.textContent = T("crt.outlaw", { id: o.id, crime: T("crt.crime." + (o.crime || "debt")), since: o.since });
    body.appendChild(row);
  }
  if (!roll.length) {
    const none = document.createElement("div");
    none.className = "crt-row crt-none";
    none.textContent = T("crt.none");
    body.appendChild(none);
  }
}
// ================= ㉑ the games section (festivals, champions, records) =================
// A plain-language stadium read-out of games.ts: how many festivals the era bell has proclaimed, the last
// one's programme, and the champion whose lifetime dealings hold the standing mark. PURE READ-OUT — the
// games move no money; the stadium keeps only its own bounded roll. The volume (tab included) hides while
// /economy ships no games key.
export const GM_EVENTS = ["the long sprint", "the wing-clap derby", "the nectar haul", "the aggregation drill", "the homing race", "the odour chase"];
export function gmEventName(ev) {
  const i = GM_EVENTS.indexOf(ev);
  return i >= 0 ? T("gm.ev." + i) : ev;
}
export function renderGamesSection() {
  const host = $("chron-games");
  const body = $("gm-body");
  if (!host || !body) return;
  const tab = document.querySelector('#chron-tabs .chron-tab[data-vol="games"]');
  const g = state.econGames;
  if (!g || !g.counts) {
    host.hidden = true;
    if (tab) { tab.hidden = true; if (tab.classList.contains("is-on")) setChronVol("annals"); }
    return;
  }
  if (tab) tab.hidden = false;
  host.hidden = false;
  body.textContent = "";
  const n = g.counts;
  const head = document.createElement("div");
  head.className = "gm-row gm-head";
  head.textContent = T("gm.head", { games: n.games, crowns: n.crowns, records: n.records });
  head.title = T("gm.headTitle");
  body.appendChild(head);
  const lg = g.lastGames;
  if (lg) {
    const last = document.createElement("div");
    last.className = "gm-row gm-last";
    last.textContent = T(g.pendingGames ? "gm.ongoing" : "gm.last", { era: lg.era, event: gmEventName(lg.event), venue: lg.venue });
    body.appendChild(last);
  }
  const st = g.standing;
  if (st) {
    const row = document.createElement("div");
    row.className = "gm-row gm-stand";
    row.textContent = T("gm.stand", { id: st.id, deals: st.deals, era: st.era });
    body.appendChild(row);
  }
  if (!lg && !st) {
    const none = document.createElement("div");
    none.className = "gm-row gm-none";
    none.textContent = T("gm.none");
    body.appendChild(none);
  }
}
// ================= ㉒ the guilds section (charters, pacts, monopolies) =================
// A plain-language guildhall read-out of guilds.ts: how many seals, pacts and monopolies the roll has
// witnessed, and the living strength of each of the four trades (hands and share of the works). PURE
// READ-OUT — no charter moves money and no seal tilts a price; the roster is the profession ledger,
// counted socially. The whole volume (tab included) hides while /economy ships no guilds key.
export function gdRoleName(role) {
  return gl("role", role);   // the shared profession glossary (i18n.js GLOSS.role)
}
export function renderGuildSection() {
  const host = $("chron-guilds");
  const body = $("gd-body");
  if (!host || !body) return;
  const tab = document.querySelector('#chron-tabs .chron-tab[data-vol="guilds"]');
  const u = state.econGuilds;
  if (!u || !u.counts) {
    host.hidden = true;
    if (tab) { tab.hidden = true; if (tab.classList.contains("is-on")) setChronVol("annals"); }
    return;
  }
  if (tab) tab.hidden = false;
  host.hidden = false;
  body.textContent = "";
  const n = u.counts;
  const head = document.createElement("div");
  head.className = "gd-row gd-head";
  head.textContent = T("gd.head", { charters: n.charters, pacts: n.pacts, monopolies: n.monopolies });
  head.title = T("gd.headTitle");
  body.appendChild(head);
  const rows = (u.roster || []).filter((r) => r.members > 0);
  for (const r of rows) {
    const row = document.createElement("div");
    row.className = "gd-row gd-trade";
    row.textContent = T("gd.row", { role: gdRoleName(r.role), members: r.members, share: Math.round((r.share || 0) * 100) });
    body.appendChild(row);
  }
  const mono = (u.roster || []).find((r) => r.share >= 0.5);
  if (mono) {
    const row = document.createElement("div");
    row.className = "gd-row gd-monopoly";
    row.textContent = T("gd.holds", { role: gdRoleName(mono.role), share: Math.round(mono.share * 100) });
    body.appendChild(row);
  }
  if (!rows.length) {
    const none = document.createElement("div");
    none.className = "gd-row gd-none";
    none.textContent = T("gd.none");
    body.appendChild(none);
  }
}
// ================= ㉓ the lexicon section (coinages, spreads, silences) =================
// A plain-language desk read-out of lexicon.ts: how many words the tellings have made, how many have
// doubled, how many the silence has buried — the living rows (word, tellings, the era it entered) and the
// dead roll. PURE READ-OUT — the dictionary is compiled backwards out of the chronicle itself; naming
// changes no line, moves no coin. The whole volume (tab included) hides while /economy ships no lexicon key.
export function renderLexSection() {
  const host = $("chron-lexicon");
  const body = $("lx-body");
  if (!host || !body) return;
  const tab = document.querySelector('#chron-tabs .chron-tab[data-vol="lexicon"]');
  const u = state.econLexicon;
  if (!u || !u.counts) {
    host.hidden = true;
    if (tab) { tab.hidden = true; if (tab.classList.contains("is-on")) setChronVol("annals"); }
    return;
  }
  if (tab) tab.hidden = false;
  host.hidden = false;
  body.textContent = "";
  const n = u.counts;
  const head = document.createElement("div");
  head.className = "lx-row lx-head";
  head.textContent = T("lx.head", { coinages: n.coinages, spreads: n.spreads, deaths: n.deaths });
  head.title = T("lx.headTitle");
  body.appendChild(head);
  const rows = u.lexicon || [];
  for (const r of rows) {
    const row = document.createElement("div");
    row.className = "lx-row lx-word";
    row.textContent = T("lx.row", { word: r.word, uses: r.uses, born: r.born });
    body.appendChild(row);
  }
  if ((u.dead || []).length) {
    const grave = document.createElement("div");
    grave.className = "lx-row lx-dead";
    grave.textContent = T("lx.dead", { words: u.dead.join(" · ") });
    body.appendChild(grave);
  }
  if (!rows.length) {
    const none = document.createElement("div");
    none.className = "lx-row lx-none";
    none.textContent = T("lx.none");
    body.appendChild(none);
  }
}
// ================= ㉔ the rumor mill section (a tale afoot, its bend, its quiet) =================
// A plain-language read-out of rumor.ts: how many tales took wing, how many bent in the retelling, how
// many went quiet — the LIVE tale (topic, ears, how it is heard now vs how it happened) and the shape of
// the telling-day echo (which act hearers are read as, and what fraction of the swarm has heard).
// THE SECOND CAUSAL MEMBRANE, shown honestly: the override is a read-out-line event on religion's holy-
// rest contract — rare, bounded, never money. The whole volume (tab included) hides while /economy ships
// no rumor key.
export function renderRumorSection() {
  const host = $("chron-rumor");
  const body = $("rm-body");
  if (!host || !body) return;
  const tab = document.querySelector('#chron-tabs .chron-tab[data-vol="rumor"]');
  const u = state.econRumor;
  if (!u || !u.counts) {
    host.hidden = true;
    if (tab) { tab.hidden = true; if (tab.classList.contains("is-on")) setChronVol("annals"); }
    return;
  }
  if (tab) tab.hidden = false;
  host.hidden = false;
  body.textContent = "";
  const n = u.counts;
  const head = document.createElement("div");
  head.className = "rm-row rm-head";
  head.textContent = T("rm.head", { afoot: n.afoot, bends: n.bends, faded: n.faded });
  head.title = T("rm.headTitle");
  body.appendChild(head);
  const a = u.active;
  if (a) {
    const row = document.createElement("div");
    row.className = "rm-row rm-live";
    row.textContent = T("rm.active", { topic: a.topic, heard: a.heard, sev0: a.sev0, sevHeard: a.sevHeard });
    body.appendChild(row);
    if (a.bent) {
      const bt = document.createElement("div");
      bt.className = "rm-row rm-bent";
      bt.textContent = T("rm.bent");
      body.appendChild(bt);
    }
  } else {
    const none = document.createElement("div");
    none.className = "rm-row rm-none";
    none.textContent = T("rm.none");
    body.appendChild(none);
  }
  if (u.echo) {
    const ec = document.createElement("div");
    ec.className = "rm-row rm-echo";
    ec.textContent = T("rm.echo", { act: u.echo.act, pct: Math.round((u.echo.ratio || 0) * 100) });
    ec.title = T("rm.echoTitle");
    body.appendChild(ec);
  }
}
// ================= ㉕ the treaty section (seals set, ratified, broken — the roll of formal peace) =================
// A plain-language read-out of treaty.ts: the lifetime tally (seals set, ratified, broken, lapsed), the
// LIVE roll of treaties (which houses, how many clauses, whether the probation has passed) and the ended
// seals. PURE read-out end to end — a seal moves no bond, commands no fly and touches no coin; the honesty
// note lives in the head title. The whole volume (tab included) hides while /economy ships no treaty key.
// {status}/{end} are membrane enums and stay English raw, the project's standing convention for tokens.
export function renderTreatySection() {
  const host = $("chron-treaty");
  const body = $("ty-body");
  if (!host || !body) return;
  const tab = document.querySelector('#chron-tabs .chron-tab[data-vol="treaty"]');
  const u = state.econTreaty;
  if (!u || !u.counts) {
    host.hidden = true;
    if (tab) { tab.hidden = true; if (tab.classList.contains("is-on")) setChronVol("annals"); }
    return;
  }
  if (tab) tab.hidden = false;
  host.hidden = false;
  body.textContent = "";
  const n = u.counts;
  const head = document.createElement("div");
  head.className = "ty-row ty-head";
  head.textContent = T("ty.head", { signed: n.signed, ratified: n.ratified, breached: n.breached, lived: n.lived });
  head.title = T("ty.headTitle");
  body.appendChild(head);
  const rows = u.active || [];
  for (const r of rows) {
    const row = document.createElement("div");
    row.className = "ty-row ty-live";
    row.textContent = T("ty.row", { nameA: r.nameA, nameB: r.nameB, terms: r.terms, status: r.ratified ? "ratified" : "signed" });
    body.appendChild(row);
  }
  const ended = (u.archive || []).filter((s) => s && s.nameA && s.nameB);
  if (ended.length) {
    const old = document.createElement("div");
    old.className = "ty-row ty-old";
    old.textContent = T("ty.old", { seals: ended.map((s) => `${s.nameA} \u2194 ${s.nameB}: ${s.end}`).join(" \u00b7 ") });
    body.appendChild(old);
  }
  if (!rows.length) {
    const none = document.createElement("div");
    none.className = "ty-row ty-none";
    none.textContent = T("ty.none");
    body.appendChild(none);
  }
}
// ================= ㉖ the public works section (raised, mended, fallen — the roll of common goods) =================
// A plain-language read-out of works.ts: the lifetime tally (works raised, mended, lost to ruin), the
// STANDING yard (which work, raised in which era) and the ruins. PURE read-out end to end — no work is
// built by a fly or paid by a purse; the honesty note lives in the head title. {work} is a membrane enum
// (granary/aqueduct/monument) and stays English raw, the project's convention. The volume hides while /economy ships no works key.
export function renderWorksSection() {
  const host = $("chron-works");
  const body = $("wk-body");
  if (!host || !body) return;
  const tab = document.querySelector('#chron-tabs .chron-tab[data-vol="works"]');
  const u = state.econWorks;
  if (!u || !u.counts) {
    host.hidden = true;
    if (tab) { tab.hidden = true; if (tab.classList.contains("is-on")) setChronVol("annals"); }
    return;
  }
  if (tab) tab.hidden = false;
  host.hidden = false;
  body.textContent = "";
  const n = u.counts;
  const head = document.createElement("div");
  head.className = "wk-row wk-head";
  head.textContent = T("wk.head", { raised: n.raised, repaired: n.repaired, dilapidated: n.dilapidated });
  head.title = T("wk.headTitle");
  body.appendChild(head);
  const rows = u.active || [];
  for (const r of rows) {
    const row = document.createElement("div");
    row.className = "wk-row wk-live";
    row.textContent = T("wk.row", { work: r.kind, era: r.raisedEra });
    body.appendChild(row);
  }
  const ended = (u.archive || []).filter((s) => s && s.kind);
  if (ended.length) {
    const old = document.createElement("div");
    old.className = "wk-row wk-old";
    old.textContent = T("wk.old", { works: ended.map((s) => `${s.kind} \u00b7 era ${s.raisedEra} \u00b7 ${s.end}`).join("  \u2023  ") });
    body.appendChild(old);
  }
  if (!rows.length) {
    const none = document.createElement("div");
    none.className = "wk-row wk-none";
    none.textContent = T("wk.none");
    body.appendChild(none);
  }
}
// ================= ㉗ the guardians section (wards taken, fledged, honored — the roll of wardship) =================
// A plain-language read-out of guardians.ts: the lifetime tally (wards taken, fledged, honored, lost), the
// LIVE roll of wardships (which ward, whose guardian, since which era) and the ended ones. PURE read-out
// end to end — a wardship re-writes no inheritance; the honesty note lives in the head title. {end} is a
// membrane enum (fledged/honored/lost) and stays English raw, the project's standing convention. The whole
// volume (tab included) hides while /economy ships no guardians key.
export function renderGuardiansSection() {
  const host = $("chron-guardians");
  const body = $("wd-body");
  if (!host || !body) return;
  const tab = document.querySelector('#chron-tabs .chron-tab[data-vol="guardians"]');
  const u = state.econGuardians;
  if (!u || !u.counts) {
    host.hidden = true;
    if (tab) { tab.hidden = true; if (tab.classList.contains("is-on")) setChronVol("annals"); }
    return;
  }
  if (tab) tab.hidden = false;
  host.hidden = false;
  body.textContent = "";
  const n = u.counts;
  const head = document.createElement("div");
  head.className = "wd-row wd-head";
  head.textContent = T("wd.head", { taken: n.taken, fledged: n.fledged, honored: n.honored, lost: n.lost });
  head.title = T("wd.headTitle");
  body.appendChild(head);
  const rows = u.active || [];
  for (const r of rows) {
    const row = document.createElement("div");
    row.className = "wd-row wd-live";
    row.textContent = T("wd.row", { ward: r.ward, guardian: r.guardian, era: r.takenEra });
    body.appendChild(row);
  }
  const ended = (u.archive || []).filter((s) => s && Number.isFinite(s.ward));
  if (ended.length) {
    const old = document.createElement("div");
    old.className = "wd-row wd-old";
    old.textContent = T("wd.old", { wards: ended.map((s) => `#${s.ward} \u00b7 ${s.guardian} \u00b7 ${s.end}`).join("  \u2023  ") });
    body.appendChild(old);
  }
  if (!rows.length) {
    const none = document.createElement("div");
    none.className = "wd-row wd-none";
    none.textContent = T("wd.none");
    body.appendChild(none);
  }
}
// Compact whole-MURMUR formatter for the bourse panel — layperson-friendly (5.10M, not 5104666.83).
export function fmtMurCompact(n) {
  n = Number(n) || 0;
  const a = Math.abs(n);
  if (a >= 1e9) return (n / 1e9).toFixed(2) + "B";
  if (a >= 1e6) return (n / 1e6).toFixed(2) + "M";
  if (a >= 1e3) return (n / 1e3).toFixed(1) + "K";
  return a >= 10 ? String(Math.round(n)) : n.toFixed(1);
}
// ================= ⑲ the bourse section (the project coin's tape, felt + narrated) =================
// A plain-language read-out of GET /bourse for laypeople: how hot the MURMUR tape runs, the cumulative 2%
// argus tax that has bled to the treasury, whale stirs and long silences — and, crucially, HOW that climate
// reaches the swarm (the SAME four visitor channels, hard-capped at TOKEN_STIMULUS_MAX). Pure read-out: it
// moves no money, holds no key and reflects no decision. Hidden while BOURSE_ENABLED=false (the tab is gated
// too, so the codex rail never strands on an empty volume).
export function renderBourseSection() {
  const host = $("chron-bourse");
  const body = $("bou-body");
  if (!host || !body) return;
  const tab = document.querySelector('#chron-tabs .chron-tab[data-vol="bourse"]');
  const b = state.econBourse;
  if (!b || !b.enabled) {
    host.hidden = true;
    if (tab) { tab.hidden = true; if (tab.classList.contains("is-on")) setChronVol("annals"); }
    return;
  }
  if (tab) tab.hidden = false;
  host.hidden = false;
  body.textContent = "";

  const sig = b.signals || {};
  const cli = b.climate || {};
  const fever = clamp(Number(cli.feverLevel) || 0);
  const txs = Number(sig.txs) || 0;
  const vol = Number(sig.volumeMurmur) || 0;
  const baseVol = Number(sig.baselineVolumeMurmur) || 0;
  const mult = baseVol > 0 ? vol / baseVol : (vol > 0 ? 1 : 0);
  const tax = Number(sig.taxTotalMurmur) || 0;
  const milestone = Number(b.titheMilestoneMurmur) || 0;
  const whaleN = Number(sig.whaleTotal) || 0;
  const whaleExcess = (cli.whaleExcess == null) ? null : clamp(Number(cli.whaleExcess) || 0);
  const whaleThr = Number(b.whaleThresholdMurmur) || 0;
  const quiet = Number(cli.quietCrons) || 0;
  const cap = Number(b.maxIntensity) || 0;

  const gauge = (labelText, frac, valueText, cls, titleText) => {
    const row = document.createElement("div");
    row.className = "bou-row bou-gauge " + cls;
    if (titleText) row.title = titleText;
    const lab = document.createElement("span"); lab.className = "bou-lab"; lab.textContent = labelText;
    const track = document.createElement("span"); track.className = "bou-track";
    const fill = document.createElement("i"); fill.className = "bou-fill";
    fill.style.width = (clamp(frac) * 100).toFixed(1) + "%";
    track.appendChild(fill);
    const val = document.createElement("span"); val.className = "bou-val"; val.textContent = valueText;
    row.appendChild(lab); row.appendChild(track); row.appendChild(val);
    return row;
  };
  const line = (cls, text, titleText) => {
    const row = document.createElement("div");
    row.className = "bou-row " + cls;
    row.textContent = text;
    if (titleText) row.title = titleText;
    return row;
  };

  // 1) fever gauge — how hot the tape runs against its own learned norm.
  const st = fever >= 0.75 ? T("bourse.state.hot") : fever >= 0.55 ? T("bourse.state.warm") : fever >= 0.3 ? T("bourse.state.steady") : T("bourse.state.cool");
  body.appendChild(gauge(T("bourse.fever"), fever, `${st} · ${Math.round(fever * 100)}%`, "bou-fever", T("bourse.feverTitle")));
  // 2) the tape this last cron.
  body.appendChild(line("bou-tape", T("bourse.tape", { txs: txs, vol: fmtMurCompact(vol), mult: mult.toFixed(1) }), T("bourse.tapeTitle")));
  // 3) treasury pulse — cumulative 2% tax, bar fills toward the next spoken milestone.
  const taxFrac = milestone > 0 ? (tax % milestone) / milestone : 0;
  body.appendChild(gauge(T("bourse.tithe"), taxFrac, T("bourse.titheVal", { tax: fmtMurCompact(tax) }), "bou-tithe", T("bourse.titheTitle", { milestone: fmtMurCompact(milestone) })));
  // 4) whale — did a single stroke cross the whale line this cron?
  if (whaleExcess != null && whaleExcess > 0) body.appendChild(line("bou-whale is-on", T("bourse.whaleNow", { thr: fmtMurCompact(whaleThr) }), T("bourse.whaleTitle")));
  else body.appendChild(line("bou-whale", T("bourse.whaleNone", { thr: fmtMurCompact(whaleThr), n: whaleN }), T("bourse.whaleTitle")));
  // 5) silence — how many crons since a single transfer.
  body.appendChild(line(quiet > 0 ? "bou-silence is-on" : "bou-silence", quiet > 0 ? T("bourse.silence", { crons: quiet }) : T("bourse.silenceNone"), T("bourse.silenceTitle")));
  // 6) what the swarm feels — the plain-language bridge to the four channels.
  body.appendChild(line("bou-subhead", T("bourse.feelHead")));
  let feelKey;
  if (!b.stimulus) feelKey = "bourse.feelOff";
  else if (fever >= 0.55) feelKey = "bourse.feelFood";
  else if (whaleExcess != null && whaleExcess > 0) feelKey = "bourse.feelThreat";
  else if (cli.titheCrossed) feelKey = "bourse.feelLight";
  else if (quiet >= 45) feelKey = "bourse.feelDark";
  else feelKey = "bourse.feelCalm";
  body.appendChild(line("bou-feel", T(feelKey), T("bourse.feelTitle", { cap: cap })));
  body.appendChild(line("bou-legend", T("bourse.legend", { cap: cap })));
  // 7) meta — chain, block, feeling switch.
  const tok = b.token ? (String(b.token).slice(0, 6) + "…" + String(b.token).slice(-4)) : "";
  const stim = b.stimulus ? T("bourse.stimOn", { cap: cap }) : T("bourse.stimOff");
  body.appendChild(line("bou-meta", T("bourse.meta", { chain: b.chainId, block: (Number(b.lastBlock) || 0).toLocaleString(), stim: stim }), T("bourse.metaTitle", { token: tok })));
}
// ================= ⑨ the war coffer section (in the chronicle panel) =================
// The on-chain WarCoffer: which houses hold a real-USDC vault, the live + just-closed bouts (winner derived
// inside the contract, cross-checked independently here), and the extra tax purse. A pure read-out of /war —
// it moves no money and reflects no decision; it only makes the coffer's ledger visible. Hidden while WAR is off.
export function renderWarSection() {
  const host = $("chron-war");
  if (!host) return;
  const w = state.econWar;
  // the volume owns a tab in the codex rail: show it only while the coffer is live, and never strand
  // the rail on a hidden volume when war is off (byte-for-byte rollback ⇒ no war UI footprint).
  const tab = document.querySelector('#chron-tabs .chron-tab[data-vol="war"]');
  if (!w || !w.enabled) {
    host.hidden = true;
    if (tab) { tab.hidden = true; if (tab.classList.contains("is-on")) setChronVol("annals"); }
    return;
  }
  if (tab) tab.hidden = false;
  const houses = (w.houses || []).filter((h) => Number(h.vaultOnchainUsdc) > 0);
  const wars = w.wars || [];
  if (!houses.length && !wars.length && !w.stats) { host.hidden = true; return; }
  host.hidden = false;
  // header: escrow / cap · the tax purse · wars settled on-chain.
  const head = $("war-head");
  if (head) {
    const s = w.stats || {};
    const escrow = atomicToUsdc(s.totalEscrow || "0");
    const cap = Number(w.maxEscrowUsdc || 0);
    const purse = atomicToUsdc(s.commonsPurse || "0");
    const count = Number(s.warCount || 0);
    head.textContent = `${T("war.escrow", { escrow: escrow.toFixed(4), cap: cap.toFixed(2) })} · ${T("war.purse", { purse: purse.toFixed(4) })} · ${T("war.wars", { n: count })}`;
    head.title = T("war.headTitle");
  }
  // live + just-closed bouts.
  const wb = $("war-wars");
  if (wb) {
    wb.textContent = "";
    for (const war of wars.slice(0, 6)) {
      const row = document.createElement("div");
      row.className = "war-row" + (war.resolved ? " resolved" : " open");
      const an = war.attackerName || ("#" + war.attacker);
      const dn = war.defenderName || ("#" + war.defender);
      let line = T("war.bout", { atk: an, def: dn, pot: Number(war.potUsdc).toFixed(4) });
      if (war.resolved) {
        const win = Number(war.onChainWinner);   // 0 none/refund, 1 attacker, 2 defender
        line += win === 1 ? T("war.take", { winner: an }) : win === 2 ? T("war.take", { winner: dn }) : T("war.refund");
      } else {
        line += T("war.in", { secs: Math.round(Number(war.secondsToDeadline) || 0) });
      }
      row.textContent = line;
      row.title = T("war.boutTitle", { powerA: war.powerA, powerB: war.powerB, stake: Number(war.stakeUsdc).toFixed(4) });
      wb.appendChild(row);
    }
    if (!wars.length) {
      const row = document.createElement("div");
      row.className = "war-empty";
      row.textContent = T("war.noBouts");
      wb.appendChild(row);
    }
  }
  // houses holding an on-chain vault, richest vault first.
  const vhead = $("war-vaults-head");
  const vb = $("war-vaults");
  if (vhead && vb) {
    vb.textContent = "";
    vhead.hidden = houses.length === 0;
    const sorted = houses.slice().sort((a, b) => Number(b.vaultOnchainUsdc) - Number(a.vaultOnchainUsdc));
    for (const h of sorted.slice(0, 8)) {
      const row = document.createElement("div");
      row.className = "war-vault";
      row.textContent = T("war.vault", { name: h.name || ("House " + h.id), vault: Number(h.vaultOnchainUsdc).toFixed(4), power: h.power });
      row.title = T("war.vaultTitle", { share: (Number(h.capitalShare) * 100).toFixed(1), gen: h.gen, live: h.live });
      vb.appendChild(row);
    }
  }
}
export function openWallets() {
  state.walletsOpen = true;
  if (state.templeOpen) closeTemple();
  if (state.canaryOpen) closeCanary();
  if (state.laureateOpen) closeLaureate();
  if (state.brainOpen) closeBrain();
  if (state.historyOpen) closeHistory();   // the right-side drawers are mutually exclusive
  if (state.proofsOpen) closeProofs();
  if (state.pulseOpen) closePulse();
  if (state.predictOpen) closePredict();
  if (state.lineageOpen) closeLineage();
  if (state.chronOpen) closeChron();
  const w = $("wallets");
  if (!w) return;
  w.hidden = false;
  document.body.classList.add("wallets-open");
  requestAnimationFrame(() => w.classList.add("open"));
  renderWallets();
  renderSocialSection();
  renderMarketSection();
  // pull a fresh roster immediately so the drawer is never stale on first open
  getJSON("/economy").then((e) => {
    if (!e) return;
    if (Array.isArray(e.agents)) applyEconAgents(e.agents);
    if (e.social) { state.econSocial = e.social; renderSocialSection(); renderWallets(); sgMarkDirty(); }
    if (e.dynasty) { state.econDynasty = e.dynasty; renderDynastySection(); renderWallets(); }
    if (e.market) { state.econMarket = e.market; renderMarketSection(); }
    if (e.culture) { state.econCulture = e.culture; renderCultureSection(); }
    if (e.religion) { state.econReligion = e.religion; renderReligionSection(); }
    if (e.commons) { state.econCommons = e.commons; renderCommonsSection(); }
    if (e.tech) { state.econTech = e.tech; renderTechSection(); }
    if (e.cities) { state.econCities = e.cities; renderCitiesSection(); }
    if (e.apprentice) { state.econApprentice = e.apprentice; renderApprenticeSection(); }
  if (e.archive) { state.econArchive = e.archive; renderArchiveSection(); }
  if (e.workshop) { state.econWorkshop = e.workshop; renderWorkshopSection(); }
      if (e.court) { state.econCourt = e.court; renderCourtSection(); }
      if (e.games) { state.econGames = e.games; renderGamesSection(); }
      if (e.guilds) { state.econGuilds = e.guilds; renderGuildSection(); }
      if (e.lexicon) { state.econLexicon = e.lexicon; renderLexSection(); }
  if (e.rumor) { state.econRumor = e.rumor; renderRumorSection(); }
  if (e.treaty) { state.econTreaty = e.treaty; renderTreatySection(); }
  if (e.works) { state.econWorks = e.works; renderWorksSection(); }
  if (e.guardians) { state.econGuardians = e.guardians; renderGuardiansSection(); }
  }).catch(() => {});
}
export function closeWallets() {
  state.walletsOpen = false;
  document.body.classList.remove("wallets-open");
  const w = $("wallets");
  if (!w) return;
  w.classList.remove("open");
  setTimeout(() => { if (!state.walletsOpen) w.hidden = true; }, 420);
}
export function toggleWallets() { if (state.walletsOpen) closeWallets(); else openWallets(); }
// ================= netting read-out (economy panel) =================
/** Live one-liner under the ledger showing the netting upgrade at work this session. */
export function updateNetNote() {
  const el = $("net-note");
  if (!el) return;
  if (netting.folded || netting.settled) {
    el.textContent = T("net.note", { folded: netting.folded, settled: netting.settled });
    el.classList.add("active");
  }
}
export function fmtSince(ts) {
  const d = new Date(ts);
  if (isNaN(d.getTime())) return "–";
  const loc = currentLang();
  return d.toLocaleDateString(loc, { month: "short", day: "numeric" }) + " · " +
    d.toLocaleTimeString(loc, { hour: "2-digit", minute: "2-digit" });
}
export function updateSinceLaunch() {
  const set = (id, v) => { const el = $(id); if (el) el.textContent = v; };
  const s = state.histSummary;
  if (!state.histEnabled || !s) {
    set("hs-ticks", "–"); set("hs-since", "–"); set("hs-sett", "–"); set("hs-vol", "–");
    const sub0 = $("hist-sub"); if (sub0) sub0.textContent = T("hist.offline");
    return;
  }
  set("hs-ticks", s.ticks != null ? Number(s.ticks).toLocaleString() : "–");
  set("hs-since", s.firstTs != null ? fmtSince(s.firstTs) : "–");
  set("hs-sett", s.settlements != null ? Number(s.settlements).toLocaleString() : "–");
  set("hs-vol", s.volumeUsdc != null ? Number(s.volumeUsdc).toFixed(3) : "–");
  const sub = $("hist-sub");
  if (sub) sub.textContent = s.ticks ? T("hist.rows", { n: Number(s.ticks).toLocaleString(), from: s.firstTick, to: s.lastTick }) : T("hist.noRows");
  const foot = $("hist-foot");
  if (foot) foot.textContent = state.histRows.length
    ? T("hist.showing", { n: state.histRows.length })
    : T("hist.foot");
}
/** Generic mini time-series chart. vals = numbers oldest→newest; mode "line"|"area"|"bars". */
export function drawSpark(canvas, vals, opts = {}) {
  if (!canvas) return;
  const ctx = canvas.getContext("2d");
  const W = canvas.width, H = canvas.height;
  const pal = paletteAt(state.tempSmoothed);
  ctx.clearRect(0, 0, W, H);
  if (!vals || vals.length < 2) {
    ctx.fillStyle = "rgba(26,26,24,0.32)";
    ctx.font = "11px ui-monospace, SFMono-Regular, Menlo, monospace";
    ctx.fillText("awaiting archive…", 8, H / 2);
    return;
  }
  const mode = opts.mode || "line";
  const lo = opts.min != null ? opts.min : Math.min(...vals);
  let hi = opts.max != null ? opts.max : Math.max(...vals);
  if (hi - lo < 1e-9) hi = lo + 1;
  const pad = 5;
  const col = opts.color || pal.accent;
  const xOf = (i) => (i / (vals.length - 1)) * (W - pad * 2) + pad;
  const yOf = (v) => H - pad - ((v - lo) / (hi - lo)) * (H - pad * 2);

  if (mode === "bars") {
    const bw = Math.max(1, (W - pad * 2) / vals.length - 1);
    ctx.fillStyle = rgba(col, 0.5);
    for (let i = 0; i < vals.length; i++) {
      const h = Math.max(0.5, ((vals[i] - lo) / (hi - lo)) * (H - pad * 2));
      ctx.fillRect(xOf(i) - bw / 2, H - pad - h, bw, h);
    }
    return;
  }

  ctx.beginPath();
  ctx.moveTo(xOf(0), H - pad);
  for (let i = 0; i < vals.length; i++) ctx.lineTo(xOf(i), yOf(vals[i]));
  ctx.lineTo(xOf(vals.length - 1), H - pad);
  ctx.closePath();
  const grad = ctx.createLinearGradient(0, 0, 0, H);
  grad.addColorStop(0, rgba(col, mode === "area" ? 0.30 : 0.16));
  grad.addColorStop(1, rgba(col, 0.02));
  ctx.fillStyle = grad;
  ctx.fill();

  ctx.beginPath();
  for (let i = 0; i < vals.length; i++) { const x = xOf(i), y = yOf(vals[i]); if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y); }
  ctx.strokeStyle = rgba(col, 0.9);
  ctx.lineWidth = 1.4;
  ctx.stroke();

  ctx.fillStyle = rgba(col, 0.95);
  ctx.beginPath(); ctx.arc(xOf(vals.length - 1), yOf(vals[vals.length - 1]), 2, 0, TAU); ctx.fill();
}
export function renderHistory() {
  const temps = state.histRows.map((r) => r.temperature).filter((v) => v != null);
  const vols = state.histRows.map((r) => r.volumeUsdc).filter((v) => v != null);
  const ginis = state.histRows.map((r) => r.gini).filter((v) => v != null);
  const deals = state.histRows.map((r) => (r.deals != null ? r.deals : 0));
  drawSpark($("hc-temp"), temps, { mode: "line", min: 0, max: 1 });
  drawSpark($("hc-vol"), vols, { mode: "area" });
  drawSpark($("hc-gini"), ginis, { mode: "line", min: 0, max: 1 });
  drawSpark($("hc-deals"), deals, { mode: "bars", min: 0 });
  const setNow = (id, v) => { const el = $(id); if (el) el.textContent = v; };
  setNow("hc-temp-now", temps.length ? temps[temps.length - 1].toFixed(3) : "");
  setNow("hc-vol-now", vols.length ? vols[vols.length - 1].toFixed(3) + " usdc" : "");
  setNow("hc-gini-now", ginis.length ? ginis[ginis.length - 1].toFixed(3) : "");
  setNow("hc-deals-now", deals.length ? "last " + deals[deals.length - 1] : "");
  updateSinceLaunch();
}
export function openHistory() {
  state.historyOpen = true;
  if (state.templeOpen) closeTemple();
  if (state.canaryOpen) closeCanary();
  if (state.laureateOpen) closeLaureate();
  if (state.brainOpen) closeBrain();
  if (state.walletsOpen) closeWallets();
  if (state.proofsOpen) closeProofs();
  if (state.pulseOpen) closePulse();
  if (state.predictOpen) closePredict();
  if (state.lineageOpen) closeLineage();
  if (state.chronOpen) closeChron();
  const d = $("history");
  if (!d) return;
  d.hidden = false;
  document.body.classList.add("history-open");
  requestAnimationFrame(() => d.classList.add("open"));
  renderHistory();
  pollHistory();   // refresh immediately on open so it's never stale
}
export function closeHistory() {
  state.historyOpen = false;
  document.body.classList.remove("history-open");
  const d = $("history");
  if (!d) return;
  d.classList.remove("open");
  setTimeout(() => { if (!state.historyOpen) d.hidden = true; }, 420);
}
export function toggleHistory() { if (state.historyOpen) closeHistory(); else openHistory(); }
// ---- chronicle drawer lifecycle (button in the bottom-right corner; mutually exclusive like the others) ----
export function openChron() {
  state.chronOpen = true;
  if (state.templeOpen) closeTemple();
  if (state.canaryOpen) closeCanary();
  if (state.laureateOpen) closeLaureate();
  if (state.walletsOpen) closeWallets();
  if (state.historyOpen) closeHistory();
  if (state.proofsOpen) closeProofs();
  if (state.brainOpen) closeBrain();
  if (state.lineageOpen) closeLineage();
  if (state.pulseOpen) closePulse();
  if (state.predictOpen) closePredict();
  if (state.arenaOpen) closeArena();
  const d = $("panel-chron"); if (!d) return;
  d.hidden = false;
  document.body.classList.add("chron-open");
  requestAnimationFrame(() => d.classList.add("open"));
}
export function closeChron() {
  state.chronOpen = false;
  document.body.classList.remove("chron-open");
  sgStop();   // never leave the graph loop spinning behind a closed drawer
  const d = $("panel-chron"); if (!d) return;
  d.classList.remove("open");
  setTimeout(() => { if (!state.chronOpen) d.hidden = true; }, 420);
}
export function toggleChron() { if (state.chronOpen) closeChron(); else openChron(); }
export function openCanary() {
  state.canaryOpen = true;
  if (state.templeOpen) closeTemple();
  if (state.chronOpen) closeChron();
  if (state.walletsOpen) closeWallets();
  if (state.historyOpen) closeHistory();
  if (state.proofsOpen) closeProofs();
  if (state.brainOpen) closeBrain();
  if (state.lineageOpen) closeLineage();
  if (state.pulseOpen) closePulse();
  if (state.predictOpen) closePredict();
  if (state.arenaOpen) closeArena();
  if (state.laureateOpen) closeLaureate();
  const d = $("canary-panel"); if (!d) return;
  d.hidden = false;
  document.body.classList.add("canary-open");
  const f = $("canary-frame"); if (f) f.src = "/canary";   // (re)load the board fresh on every open
  requestAnimationFrame(() => d.classList.add("open"));
}
export function closeCanary() {
  state.canaryOpen = false;
  document.body.classList.remove("canary-open");
  const d = $("canary-panel"); if (!d) return;
  d.classList.remove("open");
  setTimeout(() => {
    if (state.canaryOpen) return;
    d.hidden = true;
    const f = $("canary-frame"); if (f) f.src = "about:blank";   // stop the board polling while off-stage
  }, 420);
}
export function toggleCanary() { if (state.canaryOpen) closeCanary(); else openCanary(); }
/** Open one volume of the chronicle codex: flip the epic tab rail + show only that volume's body. */
export function setChronVol(vol) {
  for (const t of document.querySelectorAll("#chron-tabs .chron-tab")) {
    const on = t.dataset.vol === vol;
    t.classList.toggle("is-on", on);
    t.setAttribute("aria-selected", on ? "true" : "false");
  }
  for (const v of document.querySelectorAll("#panel-chron .chron-vol")) v.classList.toggle("is-on", v.dataset.vol === vol);
  // keep the back bar's title in lockstep with the open volume (also re-translated on language switches)
  const tt = $("chron-back-title");
  if (tt) { tt.setAttribute("data-i18n", "tab." + vol + ".name"); tt.textContent = T("tab." + vol + ".name"); }
  // the social graph owns a live force loop: run it ONLY while its volume is on stage, stop otherwise
  if (vol === "graph" && state.chronMode === "volume") sgStart(); else sgStop();
}
/** Two-stage codex: picking a volume on the rail opens it as a full-height page of its own, so the
    whole column belongs to the information instead of sharing it with the rail. */
export function openChronVol(vol) {
  state.chronMode = "volume";
  const d = $("panel-chron"); if (d) d.classList.add("chron-volmode");
  const bb = $("chron-backbar"); if (bb) bb.hidden = false;
  setChronVol(vol);
}
/** Back to the rail: the index lists every volume again and the page yields the column. */
export function closeChronVol() {
  state.chronMode = "index";
  const d = $("panel-chron"); if (d) d.classList.remove("chron-volmode");
  const bb = $("chron-backbar"); if (bb) bb.hidden = true;
  sgStop();   // the graph volume stays "is-on" underneath but hidden: never leave its loop spinning
}
// ================= ⑤ the social graph (force-directed node-link, lives in the chronicle drawer) =========
// A standalone "prove this is a real society" view: the SAME econSocial bonds the economy trades on, laid
// out by a tiny DETERMINISTIC force sim on its own canvas. Pure read-out — it never touches the sim, the
// drives, or the economy. The loop runs ONLY while this volume is on screen and idles to a stop once the
// layout cools, so it costs nothing when hidden or settled (the perf lesson of the whole frontend).
export const SG = {
  canvas: null, ctx: null, wrap: null, tip: null, raf: 0,
  running: false, open: false, dirty: true, bound: false,
  nodes: [], edges: [], byId: new Map(),
  colorMode: "colony", alpha: 0, hover: null, drag: null, dpr: 1, w: 0, h: 0,
};
export const SG_GREEN = [92, 158, 96];
// trust
export const SG_RED = [198, 60, 44];
// grudge
export const SG_NEUTRAL = [150, 150, 154];
// no colony / no house
export const SG_REP = 0.0016, SG_SPRING = 0.02, SG_GRAV = 0.006, SG_COH = 0.01;
export const SG_DAMP = 0.82, SG_COOL = 0.985, SG_MINSIM = 0.02;
/** Mark the graph stale; if it's on screen right now, rebuild (preserving positions) + gentle reheat. */
export function sgMarkDirty() { SG.dirty = true; if (SG.open) { sgBuild(true); sgReheat(0.5); } }
export function sgReheat(a) { SG.alpha = Math.max(SG.alpha, a == null ? 1 : a); if (SG.open && !SG.running) { SG.running = true; SG.raf = requestAnimationFrame(sgTick); } }
/** Build nodes/edges from the latest social + agent read-outs. preserve=true keeps live node positions so
 *  a background poll doesn't re-scramble the picture; seeds are a deterministic golden-angle spiral. */
export function sgBuild(preserve) {
  const prev = SG.byId;
  SG.byId = new Map(); SG.nodes = []; SG.edges = [];
  SG.dirty = false;
  const s = state.econSocial;
  if (!s) return;
  const ids = new Set();
  for (const b of (s.bonds || [])) if (b && b.a != null && b.b != null && b.a !== b.b) { ids.add(b.a); ids.add(b.b); }
  for (const r of (s.rep || [])) if (r && r.id != null) ids.add(r.id);
  if (!ids.size) return;
  const bal = new Map(), rep = new Map();
  for (const ag of state.econAgents) if (ag && ag.id != null) bal.set(Number(ag.id), atomicToUsdc(ag.balance || "0"));
  for (const r of (s.rep || [])) if (r && r.id != null) rep.set(r.id, r.score || 0);
  let maxBal = 1e-6; for (const v of bal.values()) if (v > maxBal) maxBal = v;
  for (const id of [...ids].sort((a, b) => a - b)) {
    const b0 = bal.get(id) || 0, rp = rep.get(id) || 0;
    const ci = state.societies ? state.societies.colonyOf.get(id) : undefined;
    const colony = ci != null && state.societies.colonies[ci] ? state.societies.colonies[ci] : null;
    const house = houseOf.get(id) || null;
    const rad = Math.min(20, 5 + 9 * Math.sqrt(Math.min(1, b0 / maxBal)) + 4 * Math.abs(rp));
    const ang = (id * 2.39996323) % (Math.PI * 2), rr = 0.1 + 0.32 * Math.sqrt((id % 13) / 13);
    const old = preserve ? prev.get(id) : null;
    const node = { id, x: old ? old.x : 0.5 + Math.cos(ang) * rr, y: old ? old.y : 0.5 + Math.sin(ang) * rr,
      vx: 0, vy: 0, r: rad, bal: b0, rep: rp, colony, house };
    SG.nodes.push(node); SG.byId.set(id, node);
  }
  const em = new Map();
  for (const bd of (s.bonds || [])) {
    if (!bd || bd.a == null || bd.b == null || bd.a === bd.b) continue;
    const sc = typeof bd.score === "number" ? bd.score : 0;
    if (Math.abs(sc) < 0.05) continue;
    const key = Math.min(bd.a, bd.b) + ":" + Math.max(bd.a, bd.b);
    const cur = em.get(key);
    if (!cur || Math.abs(sc) > Math.abs(cur.score)) em.set(key, { a: bd.a, b: bd.b, score: sc, trades: bd.trades || 0 });
  }
  for (const g of (s.grudges || [])) {
    if (!g || g.buyerId == null || g.sellerId == null || g.buyerId === g.sellerId) continue;
    const key = Math.min(g.buyerId, g.sellerId) + ":" + Math.max(g.buyerId, g.sellerId);
    if (!em.has(key)) em.set(key, { a: g.buyerId, b: g.sellerId, score: -0.8, trades: 0 });
  }
  for (const e of em.values()) { e.neg = e.score < 0; SG.edges.push(e); }
  SG.alpha = prev.size ? Math.max(SG.alpha, 0.25) : 1;
}
export function sgColorOf(n) {
  if (SG.colorMode === "house") return n.house ? n.house.color : (n.colony ? n.colony.color : SG_NEUTRAL);
  return n.colony ? n.colony.color : (n.house ? n.house.color : SG_NEUTRAL);
}
/** One force integration step (O(n²) charge — trivial for a few dozen nodes). */
export function sgStep() {
  const n = SG.nodes, e = SG.edges; if (!n.length) return;
  const a = SG.alpha;
  const cent = new Map();
  for (const nd of n) { if (nd.colony) { let c = cent.get(nd.colony); if (!c) { c = { x: 0, y: 0, n: 0 }; cent.set(nd.colony, c); } c.x += nd.x; c.y += nd.y; c.n++; } }
  for (const c of cent.values()) { c.x /= c.n; c.y /= c.n; }
  for (let i = 0; i < n.length; i++) {
    const A = n[i];
    for (let j = i + 1; j < n.length; j++) {
      const B = n[j]; let dx = B.x - A.x, dy = B.y - A.y, d2 = dx * dx + dy * dy;
      if (d2 < 1e-5) { dx = 0.017 + (i - j) * 1e-4; dy = 0.013; d2 = dx * dx + dy * dy; }
      const d = Math.sqrt(d2), rep = SG_REP / d2, fx = (dx / d) * rep, fy = (dy / d) * rep;
      A.vx -= fx * a; A.vy -= fy * a; B.vx += fx * a; B.vy += fy * a;
    }
  }
  for (const ed of e) {
    const A = SG.byId.get(ed.a), B = SG.byId.get(ed.b); if (!A || !B) continue;
    let dx = B.x - A.x, dy = B.y - A.y; const d = Math.hypot(dx, dy) || 1e-6;
    const target = ed.neg ? 0.34 : 0.13;
    const k = SG_SPRING * (0.4 + Math.min(1, Math.abs(ed.score)));
    const f = (d - target) * k, fx = (dx / d) * f, fy = (dy / d) * f;
    A.vx += fx * a; A.vy += fy * a; B.vx -= fx * a; B.vy -= fy * a;
  }
  for (const nd of n) {
    nd.vx += (0.5 - nd.x) * SG_GRAV * a; nd.vy += (0.5 - nd.y) * SG_GRAV * a;
    if (nd.colony) { const c = cent.get(nd.colony); if (c) { nd.vx += (c.x - nd.x) * SG_COH * a; nd.vy += (c.y - nd.y) * SG_COH * a; } }
  }
  const pad = 0.08;
  for (const nd of n) {
    if (SG.drag && SG.drag.id === nd.id) { nd.vx = 0; nd.vy = 0; continue; }
    nd.vx *= SG_DAMP; nd.vy *= SG_DAMP;
    nd.x = clamp(nd.x + nd.vx, pad, 1 - pad); nd.y = clamp(nd.y + nd.vy, pad, 1 - pad);
  }
  SG.alpha *= SG_COOL;
}
export function sgDraw() {
  const ctx = SG.ctx; if (!ctx || !SG.w) return;
  const { w, h, dpr } = SG;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0); ctx.clearRect(0, 0, w, h);
  for (const ed of SG.edges) {
    const A = SG.byId.get(ed.a), B = SG.byId.get(ed.b); if (!A || !B) continue;
    const col = ed.neg ? SG_RED : SG_GREEN, st = Math.min(1, Math.abs(ed.score));
    ctx.strokeStyle = `rgba(${col[0]},${col[1]},${col[2]},${(0.16 + 0.5 * st).toFixed(3)})`;
    ctx.lineWidth = 0.6 + 2.2 * st + Math.min(2, (ed.trades || 0) * 0.05);
    ctx.beginPath(); ctx.moveTo(A.x * w, A.y * h); ctx.lineTo(B.x * w, B.y * h); ctx.stroke();
  }
  for (const nd of SG.nodes) {
    const x = nd.x * w, y = nd.y * h, c = sgColorOf(nd);
    if (nd.house) { ctx.beginPath(); ctx.arc(x, y, nd.r + 2.6, 0, TAU); ctx.strokeStyle = rgba(nd.house.color, 0.7); ctx.lineWidth = 1.2; ctx.stroke(); }
    ctx.beginPath(); ctx.arc(x, y, nd.r, 0, TAU);
    ctx.fillStyle = rgba(c, nd === SG.hover ? 1 : 0.9); ctx.fill();
    ctx.lineWidth = 1; ctx.strokeStyle = "rgba(40,40,44,0.5)"; ctx.stroke();
    if (nd === SG.hover || nd.r > 12) { ctx.fillStyle = "rgba(40,40,44,0.82)"; ctx.font = "600 9px ui-monospace, SFMono-Regular, Menlo, monospace"; ctx.textAlign = "center"; ctx.textBaseline = "top"; ctx.fillText("#" + nd.id, x, y + nd.r + 3); }
  }
}
export function sgTick() {
  if (!SG.running) return;
  sgStep(); sgDraw();
  if (SG.alpha <= SG_MINSIM && !SG.drag) { SG.running = false; sgDraw(); return; }   // settled → idle, free the CPU
  SG.raf = requestAnimationFrame(sgTick);
}
export function sgMeasure() {
  if (!SG.canvas || !SG.wrap) return;
  const r = SG.wrap.getBoundingClientRect();
  SG.dpr = Math.min(2, window.devicePixelRatio || 1);
  SG.w = Math.max(0, r.width); SG.h = Math.max(0, r.height);
  SG.canvas.width = Math.round(SG.w * SG.dpr); SG.canvas.height = Math.round(SG.h * SG.dpr);
}
export function sgTip(nd, mx, my) {
  if (!SG.tip) return;
  if (!nd) { SG.tip.hidden = true; return; }
  const col = nd.colony ? nd.colony.name : "unaffiliated";
  const hs = nd.house ? `${nd.house.sigil} ${nd.house.name}` : "commoner";
  const rel = [];
  for (const ed of SG.edges) { if (ed.a === nd.id || ed.b === nd.id) { const o = ed.a === nd.id ? ed.b : ed.a; rel.push(`${ed.neg ? "⚔" : "❖"}#${o}`); } }
  SG.tip.innerHTML = `<b>#${nd.id}</b> · ${col} · ${hs}<br>bal ${nd.bal.toFixed(4)} · rep ${nd.rep >= 0 ? "+" : ""}${nd.rep.toFixed(2)}${rel.length ? "<br>" + rel.slice(0, 8).join(" ") : ""}`;
  SG.tip.hidden = false;
  const tw = SG.tip.offsetWidth, th = SG.tip.offsetHeight;
  SG.tip.style.left = clamp(mx + 12, 4, Math.max(4, SG.w - tw - 4)) + "px";
  SG.tip.style.top = clamp(my + 12, 4, Math.max(4, SG.h - th - 4)) + "px";
}
export function sgBindDom() {
  if (SG.bound) return;
  SG.canvas = $("social-graph"); SG.tip = $("sg-tip");
  if (!SG.canvas) return;
  SG.wrap = SG.canvas.parentElement;
  SG.ctx = SG.canvas.getContext("2d");
  SG.bound = true;
  const bar = document.querySelector(".sg-tools");
  if (bar) bar.addEventListener("click", (ev) => {
    const b = ev.target.closest(".sg-btn"); if (!b) return;
    if (b.dataset.color) { SG.colorMode = b.dataset.color; for (const x of bar.querySelectorAll(".sg-btn")) if (x.dataset.color) x.classList.toggle("is-on", x === b); sgBuild(true); sgReheat(0.6); }
    else if (b.dataset.act === "reheat") { sgBuild(false); sgReheat(1); }
  });
  const pick = (ev) => {
    const r = SG.canvas.getBoundingClientRect();
    const mx = ev.clientX - r.left, my = ev.clientY - r.top;
    let best = null, bd = 1e9;
    for (const nd of SG.nodes) { const dx = nd.x * SG.w - mx, dy = nd.y * SG.h - my, d = Math.hypot(dx, dy); if (d < nd.r + 4 && d < bd) { bd = d; best = nd; } }
    return { best, mx, my };
  };
  SG.canvas.addEventListener("pointermove", (ev) => {
    const { best, mx, my } = pick(ev);
    if (SG.drag) { const nd = SG.byId.get(SG.drag.id); if (nd) { nd.x = clamp(mx / SG.w, 0.04, 0.96); nd.y = clamp(my / SG.h, 0.04, 0.96); nd.vx = 0; nd.vy = 0; } sgReheat(0.5); }
    SG.hover = best; SG.canvas.style.cursor = best ? "pointer" : "grab";
    sgTip(best, mx, my);
    if (!SG.running) sgDraw();
  });
  SG.canvas.addEventListener("pointerdown", (ev) => { const { best } = pick(ev); if (best) { SG.drag = { id: best.id }; SG.canvas.classList.add("dragging"); try { SG.canvas.setPointerCapture(ev.pointerId); } catch { /* noop */ } sgReheat(0.4); } });
  const endDrag = () => { SG.drag = null; SG.canvas.classList.remove("dragging"); };
  SG.canvas.addEventListener("pointerup", endDrag);
  SG.canvas.addEventListener("pointercancel", endDrag);
  SG.canvas.addEventListener("pointerleave", () => { SG.hover = null; if (SG.tip) SG.tip.hidden = true; if (!SG.running) sgDraw(); });
}
export function sgStart() {
  sgBindDom();
  if (!SG.canvas) return;
  SG.open = true;
  if (SG.dirty || !SG.nodes.length) sgBuild(false);
  sgMeasure();
  sgReheat(SG.alpha > SG_MINSIM ? SG.alpha : 0.9);
}
export function sgStop() {
  SG.open = false; SG.running = false;
  if (SG.raf) cancelAnimationFrame(SG.raf); SG.raf = 0;
  if (SG.tip) SG.tip.hidden = true;
}
window.addEventListener("resize", () => { if (SG.open) { sgMeasure(); sgDraw(); } });
export function chronTimeAgo(ts) {
  const s = Math.max(0, Math.floor((Date.now() - ts) / 1000));
  if (s < 60) return s + "s";
  const m = Math.floor(s / 60); if (m < 60) return m + "m";
  const h = Math.floor(m / 60); if (h < 48) return h + "h";
  return Math.floor(h / 24) + "d";
}
export const CHRON_ICONS = {
  ERA_OPEN: "✦", ERA_SHIFT: "✧", ERA_PASSAGE: "⧖", FIRST_TRADE: "⚡", MILESTONE: "◆",
  BIRTH: "✿", PANIC: "⚡", STORM: "☀", HUDDLE: "❄", FEAST: "✿",
  RECORD_CONC: "⚖", LEAD_CHANGE: "♛",
  FEUD: "⚔", ALLIANCE: "❖", BETRAYAL: "✕", REPUTATION: "☠",
  HOUSE_FOUNDED: "⌂", DYNASTY: "♜", ELEGY: "†",
  EPOCH_OPEN: "✷", EPOCH_CLOSE: "✥", TREND: "≈", TRADITION: "⚜",
  MARKET_SHIFT: "↕", CREDIT: "⛁", RUN: "⇊", CLASS: "☰",
  ASSEMBLY: "⛬", DECREE: "✎",
  WAR_DECLARED: "⚔", WAR_RESOLVED: "⚑", TAX_LEVIED: "⛃", TERRITORY_SEIZED: "♜",
  PROPHECY: "✶", SCHISM: "⚡", REVIVAL: "❋", PILGRIMAGE: "⚘",
  GENERATION: "∞", GOLDEN_AGE: "❂", DARK_AGE: "☾", RENAISSANCE: "✹", MIGRATION: "➤",
  INVENTION: "✵", DIFFUSION: "≋", LOST_ART: "☒",
  CITY_FOUNDED: "⌂", URBANIZATION: "♜", CENSUS: "⌗", PLAGUE_WAVE: "☠",
  TRANSMISSION: "✋", SURPASS: "▲", SCHOOL: "⛫", CRAFT_LOST: "☠",
  RECORDING: "✒", DECODE: "◉", ARCHIVE_BURNED: "▲", REINVENTION: "⚒",
  COIN_FEVER: "¤", WHALE_MOVE: "〰", TITHE: "◇", COIN_SILENCE: "◌",
  INDICTMENT: "§", TRIAL: "⚖", VERDICT: "☰", EXILE: "➤", AMNESTY: "✹",
  GAMES: "⚑", CHAMPION: "★", RECORD: "✦",
  GUILD_CHARTER: "⛨", APPRENTICE_PACT: "✋", GUILD_MONOPOLY: "◈",
  COINAGE: "✍", WORD_SPREAD: "❈", WORD_DIES: "✒",
  RUMOR_AFOOT: "🪶", RUMOR_BENT: "🌀", RUMOR_FADED: "🤫",
  TREATY_SIGNED: "📜", TREATY_RATIFIED: "🕊", TREATY_BREACHED: "⚔",
  WORK_RAISED: "🏛", WORK_REPAIRED: "🔧", WORK_DILAPIDATED: "🏚",
  WARD_TAKEN: "🛡", WARD_FLEDGED: "🐣", GUARDIAN_HONORED: "🏺",
  ESTATE_LEVIED: "⚖", JUBILEE_PROCLAIMED: "🕊", CATALYST_SURGE: "✨",
  // ㉙ TEMPLE — burn-to-intervene divine acts
  ORACLE_WHISPER: "👁", CULTURAL_SEED: "🌱", DIRECTED_MUTATION: "🧬", MIRACLE_HARVEST: "🌾",
  MIRACLE_PLAGUE: "💀", MIRACLE_REVELATION: "💡", MIRACLE_MIGRATION: "🌊", NATION_BLESSING: "✨",
  DIVINE_DECREE: "⚡", HERO_SUMMONING: "🦸", EPOCH_SHAPING: "🌅", WONDER_FOUNDATION: "🏛",
};
export function renderChron() {
  const list = $("chron-list");
  if (!list) return;
  // The corner stele carries a live count — an inscription line beneath the title, not a notification chip.
  const cbadge = $("chron-badge");
  if (cbadge) {
    cbadge.hidden = state.chronRows.length === 0;
    cbadge.textContent = `${state.chronRows.length > 99 ? "99+" : state.chronRows.length} ${T("chron.badge")}`;
  }
  // Header (era badge + name + regime).
  const badge = $("chron-era-badge"); const name = $("chron-era-name"); const reg = $("chron-era-regime");
  const shock = $("chron-era-shock");
  const sub = $("chron-sub"); const foot = $("chron-foot");
  if (state.chronMeta) {
    const roman = (n) => {
      if (!n || n <= 0) return String(n ?? "");
      const m = [[1000,"M"],[900,"CM"],[500,"D"],[400,"CD"],[100,"C"],[90,"XC"],[50,"L"],[40,"XL"],[10,"X"],[9,"IX"],[5,"V"],[4,"IV"],[1,"I"]];
      let out = "", rest = n; for (const [v, s] of m) while (rest >= v) { out += s; rest -= v; } return out;
    };
    if (badge) badge.textContent = T("chron.eraBadge") + " " + roman(state.chronMeta.era).toLowerCase();
    if (name) name.textContent = state.chronMeta.eraName || "—";
    if (reg)  reg.textContent = state.chronMeta.eraRegime ? gl("regime", String(state.chronMeta.eraRegime).toLowerCase()) : "";
    // ⑦ EPOCHS: if this era was forced open by a shock, badge the shock's name (⚖ when the commons willed it).
    if (shock) {
      const kind = state.chronMeta.eraShock;
      if (kind) {
        shock.hidden = false;
        shock.textContent = `✷ ${CHRON_.shockNames[kind] || kind}${state.chronMeta.eraShockWilled ? " ⚖" : ""}`;
        shock.title = state.chronMeta.eraShockWilled
          ? T("chron.shockWilled", { kind })
          : T("chron.shockNatural", { kind });
      } else {
        shock.hidden = true; shock.textContent = "";
      }
    }
    if (sub)  sub.textContent = state.chronRows.length ? T("chron.subEntries", { n: state.chronRows.length, seq: state.chronMeta.seq }) : T("chron.subAwaiting");
    // ⑫ append the fast clock's reading when the worker exposes it (undefined on an older worker ⇒ no change)
    if (sub && state.chronMeta.generation != null && state.chronMeta.civLevel != null) {
      const phase = state.chronMeta.civPhase ? T("chron.phase." + state.chronMeta.civPhase) : "";
      sub.textContent += ` · ${T("chron.gen", { gen: chronRoman(state.chronMeta.generation).toLowerCase() })} · ${phase} ${state.chronMeta.civLevel}/100`;
    }
    // ⑬⑭ append the ladder's and the map's own tallies (absent while TECH_/CITIES_ are off ⇒ no change)
    if (sub && state.econTech && Array.isArray(state.econTech.rungs) && state.econTech.rungs.length) {
      sub.textContent += ` · ${T("chron.arts", { n: state.econTech.rungs.length })}`;
    }
    if (sub && state.econCities && Array.isArray(state.econCities.settlements) && state.econCities.settlements.length) {
      sub.textContent += ` · ${T("chron.places", { n: state.econCities.settlements.length })}`;
    }
    // ⑯ append the ladder's own memory (skilled minds / top craft carried), absent while APPRENTICE is off
    if (sub && state.econApprentice && state.econApprentice.skilled > 0) {
      sub.textContent += ` · ${T("chron.crafts", { n: state.econApprentice.skilled, top: state.econApprentice.topCraft })}`;
    }
    // ⑰ append the archive tally (records surviving), absent while ARCHIVE is off
    if (sub && state.econArchive && state.econArchive.records && state.econArchive.records.length > 0) {
      sub.textContent += ` · ${T("chron.records", { n: state.econArchive.records.length })}`;
    }
  } else if (sub) sub.textContent = T("chron.subOffline");
  if (!state.chronRows.length) {
    list.innerHTML = `<li class="chron-empty">${escapeHtml(T("chron.empty"))}</li>`;
    if (foot) foot.textContent = T("chron.footThreshold");
    return;
  }
  const html = state.chronRows.map((e) => {
    const icon = CHRON_ICONS[e.kind] || "·";
    const ago = e.ts ? chronTimeAgo(e.ts) : "";
    const actors = Array.isArray(e.actors) && e.actors.length ? ` · #${e.actors.join(" #")}` : "";
    const sev = e.severity || 1;
    // DISPLAY localisation only: rebuild the line from the entry's OWN tokens into the reader's
    // language. Verification (verifyChron) still re-derives the byte-frozen English template, so
    // the "prove no LLM" trust is untouched. Fall back to the canonical English when unavailable.
    const L = currentLang();
    const disp = L !== "en" ? (ct(e.kind, e.tokens, L) || e.text) : e.text;
    return `<li class="chron-item sev-${sev} kind-${(e.kind || "").toLowerCase()}">
      <span class="chron-icon" aria-hidden="true">${icon}</span>
      <div class="chron-main">
        <div class="chron-line">${escapeHtml(disp || "")}</div>
        <div class="chron-meta">${T("chron.tick")} ${e.tick ?? "–"} · ${ago} · ${e.kind}${actors}</div>
      </div>
    </li>`;
  }).join("");
  list.innerHTML = html;
  if (foot) foot.textContent = T("chron.footRecent", { n: state.chronRows.length });
  // Track the highest seq we've rendered, so a future ticker can diff against this.
  if (state.chronRows.length) state.chronSeenSeq = Math.max(state.chronSeenSeq, state.chronRows[0].seq || 0);
}
export function escapeHtml(s) {
  return String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;" }[c]));
}
// ================= chronicle ticker: REMOVED (task 26①) =================
// The persistent bottom marquee (#chron-ticker) is gone from index.html, styles.css and every wiring
// point (main.js bindUI, polling.js pollChron). renderChronTicker() is deliberately deleted rather than
// left as a no-op so no caller can silently resurrect it. The chronicle itself is untouched: pollChron()
// still fills state.chronRows / state.chronMeta and renderChron() still paints the #panel-chron drawer.
export function chronRoman(n) {
  if (n <= 0) return String(n);
  const m = [[1000,"M"],[900,"CM"],[500,"D"],[400,"CD"],[100,"C"],[90,"XC"],[50,"L"],[40,"XL"],[10,"X"],[9,"IX"],[5,"V"],[4,"IV"],[1,"I"]];
  let out = "", rest = n; for (const [v, s] of m) while (rest >= v) { out += s; rest -= v; } return out;
}
export function chronKth(settlements) {
  const k = Math.round(settlements / 1000);
  const words = ["","one","two","three","four","five","six","seven","eight","nine","ten","eleven","twelve","thirteen","fourteen","fifteen","sixteen","seventeen","eighteen","nineteen","twenty"];
  return `${words[k] ?? String(k)} thousandth`;
}
export function chronRenderToken(value, fmt) {
  if (fmt === "roman") return chronRoman(Number(value));
  if (fmt === "kth") return chronKth(Number(value));
  if (fmt === "lower") return String(value).toLowerCase();
  return String(value);
}
export function chronRenderTemplate(kind, tokens) {
  const tpl = CHRON_.templates[kind];
  if (!tpl) return "";
  return tpl.replace(/\{(\w+)(?:~(\w+))?\}/g, (_m, key, fmt) => chronRenderToken((tokens || {})[key] ?? "", fmt));
}
export function chronEntryHashInput(e) {
  return {
    seq: e.seq, tick: e.tick, ts: e.ts, kind: e.kind, era: e.era, eraName: e.eraName,
    severity: e.severity, actors: e.actors, text: e.text, metrics: e.metrics, tokens: e.tokens,
    prevHash: e.prevHash,
  };
}
export async function chronRulesHash() {
  return sha256HexClient({
    v: CHRON_.version, templates: CHRON_.templates, eraNames: CHRON_.eraNames,
    cooldown: CHRON_.cooldown, eraMinRun: CHRON_.eraMinRun, eraMinAge: CHRON_.eraMinAge,
    eraMaxAge: CHRON_.eraMaxAge,
    shockNames: CHRON_.shockNames, shockCooldown: CHRON_.shockCooldown,
    famineCrons: CHRON_.famineCrons, famineRichness: CHRON_.famineRichness,
    plageraDeaths: CHRON_.plageraDeaths, greatHuddleCrons: CHRON_.greatHuddleCrons,
    dynasticShare: CHRON_.dynasticShare,
  });
}
// last verdict, so a re-poll can refresh the same card

/** Verify the served chronicle entirely in-browser. Returns a verdict object; never throws. */
export async function verifyChron() {
  const asc = state.chronRows.slice().sort((a, b) => a.seq - b.seq);
  const v = { at: Date.now(), running: true, lines: asc.length, rederived: 0,
    chainOk: true, rulesMatch: null, headMatch: null, brokenAt: null, badText: null, reason: "", ok: false };
  // (1) rules fingerprint — our open-source copy vs the server's published chroniclerHash.
  const localRules = await chronRulesHash();
  v.localRules = localRules;
  v.serverRules = state.chronMeta?.chroniclerHash || null;
  v.rulesMatch = v.serverRules ? localRules === v.serverRules : null;
  // (2)+(3) per-line re-derivation + chain linkage (hash chain may start mid-buffer after an eviction).
  let prev = asc.length ? asc[0].prevHash : CHRON_.genesis;
  for (let i = 0; i < asc.length; i++) {
    const e = asc[i];
    if (chronRenderTemplate(e.kind, e.tokens) !== e.text) { v.badText = e.seq; v.chainOk = false; break; }
    v.rederived += 1;
    if (v.chainOk) {
      if (e.prevHash !== prev) { v.brokenAt = e.seq; v.chainOk = false; }
      else {
        const h = await sha256HexClient(chronEntryHashInput(e));
        if (h !== e.hash) { v.brokenAt = e.seq; v.chainOk = false; }
        else prev = e.hash;
      }
    }
  }
  // head binding: the newest line's hash must equal the published chain head.
  if (asc.length && state.chronMeta?.headHash) v.headMatch = String(asc[asc.length - 1].hash) === String(state.chronMeta.headHash);
  v.reason = !v.chainOk
    ? (v.badText != null ? T("chron.reasonBadLine", { n: v.badText }) : T("chron.reasonChainBreak", { n: v.brokenAt }))
    : v.rulesMatch === false
      ? T("chron.reasonRulesDiff")
      : T("chron.reasonOk", { r: v.rederived, l: v.lines });
  v.ok = v.chainOk && v.rederived === v.lines && v.lines > 0 && v.rulesMatch !== false;
  v.running = false;
  state.chronVerifyState = v;
  return v;
}
export async function proveChron() {
  const btn = $("chron-prove");
  if (btn) { btn.disabled = true; btn.textContent = T("chron.verifying"); }
  try {
    if (!state.chronRows.length) await pollChron();
    await verifyChron();
  } catch (e) {
    state.chronVerifyState = { ok: false, running: false, reason: T("chron.verifyError") + ": " + (e && e.message ? e.message : e), lines: state.chronRows.length };
  }
  renderChronVerdict();
  if (btn) { btn.disabled = false; btn.textContent = T("chron.reverify"); }
}
export function renderChronVerdict() {
  const box = $("chron-verify");
  if (!box || !state.chronVerifyState) return;
  const v = state.chronVerifyState;
  const mark = (b) => b === true ? `<span class="cv-yes">✓</span>` : b === false ? `<span class="cv-no">✗</span>` : `<span class="cv-na">·</span>`;
  const short = (h) => h ? String(h).slice(0, 10) + "…" + String(h).slice(-8) : "—";
  const head = `<div class="cv-head ${v.ok ? "pass" : "fail"}">${v.ok ? T("chron.proven") : T("chron.notProven") + escapeHtml(v.reason || T("chron.checkFailed"))}</div>`;
  const rulesVal = v.rulesMatch == null ? T("chron.rulesNone") : (v.rulesMatch ? T("chron.rulesMatch") : T("chron.rulesMismatch"));
  const rows = [
    [mark(v.rulesMatch), `<b>${T("chron.vRules")}</b><span>${escapeHtml(rulesVal)}</span><code>${escapeHtml(short(v.localRules))}</code>`],
    [mark(v.chainOk && v.lines > 0), `<b>${T("chron.vRederive")}</b><span>${T("chron.vRederiveDesc", { r: v.rederived, l: v.lines })}</span>`],
    [mark(v.chainOk && v.lines > 0), `<b>${T("chron.vChain")}</b><span>${T("chron.vChainDesc")}</span>${v.headMatch === true ? `<em>${T("chron.vHead")} ${escapeHtml(short(state.chronMeta && state.chronMeta.headHash))} ${T("chron.vHeadMatch")}</em>` : ""}`],
  ];
  box.innerHTML = head + `<ul class="cv-rows">` + rows.map((r) => `<li>${r[0]}<div class="cv-t">${r[1]}</div></li>`).join("") + `</ul>` +
    `<div class="cv-note">${T("chron.vNote")}</div>`;
  box.hidden = false;
}
export function openProofs() {
  state.proofsOpen = true;
  if (state.templeOpen) closeTemple();
  if (state.canaryOpen) closeCanary();
  if (state.laureateOpen) closeLaureate();
  if (state.brainOpen) closeBrain();
  if (state.walletsOpen) closeWallets();
  if (state.historyOpen) closeHistory();
  if (state.pulseOpen) closePulse();
  if (state.predictOpen) closePredict();
  if (state.lineageOpen) closeLineage();
  if (state.chronOpen) closeChron();
  const d = $("proofs"); if (!d) return;
  d.hidden = false;
  document.body.classList.add("proofs-open");
  requestAnimationFrame(() => d.classList.add("open"));
  renderProofs();
  pollProofs(true);   // refresh immediately on open so it's never stale
}
export function closeProofs() {
  state.proofsOpen = false;
  document.body.classList.remove("proofs-open");
  const d = $("proofs"); if (!d) return;
  d.classList.remove("open");
  setTimeout(() => { if (!state.proofsOpen) d.hidden = true; }, 420);
}
export function toggleProofs() { if (state.proofsOpen) closeProofs(); else openProofs(); }
export function renderProofs() {
  const body = $("proofs-body"); if (!body) return;
  const sub = $("proofs-sub");
  if (sub) sub.textContent = state.proofsMeta ? T("pf.subMeta", { count: state.proofsMeta.count, head: shortHash(state.proofsMeta.chainHead || "") }) : T("pf.subEmpty");
  body.innerHTML = "";

  // autonomy attestation header
  const auto = document.createElement("div"); auto.className = "pf-auto";
  auto.innerHTML =
    `<div class="pf-auto-title">${T("pf.autoTitle")}</div>` +
    `<p class="pf-auto-body">${T("pf.autoBody")}</p>` +
    `<dl class="pf-auto-meta">` +
    `<div><dt>${T("pf.metaPolicy")}</dt><dd>${state.proofsMeta ? state.proofsMeta.policy : "–"}</dd></div>` +
    `<div><dt>${T("pf.metaSchema")}</dt><dd>v${state.proofsMeta ? state.proofsMeta.version : "–"}</dd></div>` +
    `<div><dt>${T("pf.metaChainHead")}</dt><dd class="fp">${shortHash(state.proofsMeta ? state.proofsMeta.chainHead : "")}</dd></div>` +
    `<div><dt>${T("pf.metaReceipts")}</dt><dd>${state.proofs.length}</dd></div>` +
    `</dl>`;
  body.appendChild(auto);

  if (!state.proofs.length) {
    const empty = document.createElement("p"); empty.className = "pf-empty";
    empty.textContent = T("pf.empty");
    body.appendChild(empty);
    return;
  }
  for (const p of state.proofs) body.appendChild(proofCard(p));
}
export function proofCard(p) {
  const r = p.receipt;
  const card = document.createElement("div"); card.className = "pf-card"; card.dataset.tx = p.txHash;
  const head = document.createElement("div"); head.className = "pf-head";
  const tick = document.createElement("span"); tick.className = "pf-tick"; tick.textContent = T("pf.tick", { n: r.tickIndex });
  const amt = document.createElement("span"); amt.className = "pf-amt"; amt.textContent = T("pf.usdc", { amt: atomicToUsdc(r.netAmount).toFixed(4) });
  const tr = document.createElement("span"); tr.className = "pf-trades"; tr.textContent = T(r.trades === 1 ? "pf.tradeOne" : "pf.tradeMany", { n: r.trades, pinned: r.constituents.length });
  const link = document.createElement("a"); link.className = "tx-link"; link.href = `${ARC_EXPLORER}/tx/${p.txHash}`;
  link.target = "_blank"; link.rel = "noopener noreferrer"; link.textContent = `↗ ${shortHash(p.txHash)}`;
  const vbtn = document.createElement("button"); vbtn.type = "button"; vbtn.className = "pf-verify"; vbtn.dataset.tx = p.txHash; vbtn.textContent = T("pf.verify");
  const ebtn = document.createElement("button"); ebtn.type = "button"; ebtn.className = "pf-expand"; ebtn.dataset.tx = p.txHash; ebtn.textContent = "+";
  head.append(tick, amt, tr, link, vbtn, ebtn);
  const vout = document.createElement("div"); vout.className = "pf-verifyout"; vout.hidden = true;
  const pbody = document.createElement("div"); pbody.className = "pf-body"; pbody.hidden = true;
  pbody.appendChild(proofDetail(p));
  card.append(head, vout, pbody);
  return card;
}
export function proofDetail(p) {
  const r = p.receipt;
  const wrap = document.createElement("div");
  const meta = document.createElement("dl"); meta.className = "pf-meta";
  meta.innerHTML =
    `<div><dt>${T("pf.dPair")}</dt><dd>${r.pair[0]} ⇄ ${r.pair[1]}</dd></div>` +
    `<div><dt>${T("pf.dNet")}</dt><dd>${r.debtor} → ${r.creditor}</dd></div>` +
    `<div><dt>${T("pf.dGood")}</dt><dd>${gl("goods", r.good)}</dd></div>` +
    `<div><dt>${T("pf.dFlush")}</dt><dd>#${r.flushSeq}·c${r.chunk}</dd></div>` +
    `<div><dt>${T("pf.dReceipt")}</dt><dd class="fp">${shortHash(p.receiptHash)}</dd></div>` +
    `<div><dt>${T("pf.dPrev")}</dt><dd class="fp">${r.prevChain ? shortHash(r.prevChain) : T("pf.dGenesis")}</dd></div>` +
    (p.ipfsCid ? `<div><dt>${T("pf.dIpfsCid")}</dt><dd class="fp">${shortHash(p.ipfsCid)}</dd></div>` : "");
  wrap.appendChild(meta);
  const ct = document.createElement("div"); ct.className = "pf-ct-title"; ct.textContent = T("pf.ctTitle");
  wrap.appendChild(ct);
  for (const c of r.constituents) {
    const row = document.createElement("div"); row.className = "pf-ct";
    row.innerHTML =
      `<div class="pf-ct-head"><b>${c.fromId} → ${c.toId}</b><span>${gl("goods", c.good)}</span><span>${atomicToUsdc(c.amount).toFixed(4)}</span><span class="fp">${shortHash(c.decisionHash)}</span></div>` +
      `<div class="pf-ct-ev">${T("pf.ctEv", { bs: c.buyer.state, ba: c.buyer.arousal, bc: c.buyer.cohesion, ss: c.seller.state, sa: c.seller.arousal, sc: c.seller.cohesion })}</div>`;
    ct.appendChild(row);
  }
  if (!r.constituents.length) {
    const note = document.createElement("div"); note.className = "pf-ct-ev";
    note.textContent = T("pf.ctNone");
    ct.appendChild(note);
  }
  wrap.appendChild(ct);
  return wrap;
}
export async function verifyProof(tx, card) {
  const out = card.querySelector(".pf-verifyout"); if (!out) return;
  out.hidden = false; out.textContent = T("pf.vChecking");
  const stored = state.proofs.find((x) => x.txHash === tx);
  let clientHash = null;
  if (stored) { try { clientHash = await sha256HexClient(stored.receipt); } catch { clientHash = null; } }
  try {
    const v = await getJSON(`/proofs/verify?tx=${encodeURIComponent(tx)}`, 9000);
    if (!v.found) { out.textContent = T("pf.vNotFound"); return; }
    const selfOk = clientHash == null || clientHash === v.receiptHash;
    const onchainOk = v.match === true;
    // Trustless chain-ordering: read our NeuralReceiptRegistry DIRECTLY from Arc RPC in the browser
    // (no murmur server in the loop). Fall back to the server-reported registry fields if the direct
    // read fails (CORS/network) or no registry is configured yet.
    let reg = null, regSource = "";
    if (v.registryAddress) {
      reg = await readRegistryOnchain(v.registryAddress, v.receiptHash);
      regSource = reg ? T("pf.vDirectRpc") : "";
    }
    if (!reg && v.registry) { reg = v.registry; regSource = T("pf.vViaApi"); }
    const regOk = !!reg && reg.committed === true;
    // Trustless body retrieval: if this receipt was pinned to IPFS, fetch the body from a PUBLIC gateway (no
    // murmur server in the loop) and confirm sha256(body) == the on-chain receiptHash. The CID is only a
    // convenience pointer — a wrong/malicious CID can never fake a receipt, because whatever body it resolves
    // to must still hash to the nonce already mined on Arc. Best-effort: any failure leaves ipfsOk=null and
    // the nonce+registry verification is unchanged (never a regression).
    let ipfsOk = null;
    const ipfsCid = stored && stored.ipfsCid ? stored.ipfsCid : "";
    const ipfsGw = ((state.proofsMeta && state.proofsMeta.ipfsGateway) || "https://ipfs.io").replace(/\/+$/, "");
    if (ipfsCid) {
      try {
        const ctl = new AbortController();
        const to = setTimeout(() => ctl.abort(), 12000);
        const r = await fetch(`${ipfsGw}/ipfs/${ipfsCid}?format=raw`, { signal: ctl.signal });
        clearTimeout(to);
        if (r.ok) ipfsOk = (await sha256HexText(await r.text())) === v.receiptHash;
      } catch { ipfsOk = null; }
    }
    out.innerHTML = "";
    const badge = document.createElement("span");
    badge.className = "pf-badge " + (selfOk && onchainOk ? "ok" : "bad");
    badge.textContent = (selfOk && onchainOk)
      ? (ipfsOk ? T("pf.vBadgeOkIpfs") : T("pf.vBadgeOk"))
      : T("pf.vBadgeBad");
    const dl = document.createElement("dl"); dl.className = "pf-vmeta";
    dl.innerHTML =
      `<div><dt>${T("pf.vShaBrowser")}</dt><dd class="fp">${clientHash ? shortHash(clientHash) : "–"}</dd></div>` +
      `<div><dt>${T("pf.vPublished")}</dt><dd class="fp">${shortHash(v.receiptHash || "")}</dd></div>` +
      `<div><dt>${T("pf.vNonceArc")}</dt><dd class="fp">${shortHash(v.onchainNonce || "–")}</dd></div>`;
    // 4th row: the on-chain registry link. Shows the committed chain head + whether THIS receipt is a
    // registered link (and whether the registry's txHash matches the transfer) — read trustlessly.
    const regDiv = document.createElement("div");
    if (reg) {
      const headTxt = reg.chainHead ? shortHash(reg.chainHead) : "–";
      const isHead = reg.chainHead && v.receiptHash &&
        reg.chainHead.toLowerCase() === ("0x" + v.receiptHash).toLowerCase();
      const txMatch = reg.txHash && v.txHash &&
        reg.txHash.toLowerCase() === v.txHash.toLowerCase();
      const stateTxt = !reg.committed ? T("pf.vNotCommitted") : (isHead ? T("pf.vChainHeadOk") : (txMatch ? T("pf.vCommittedOk") : T("pf.vCommitted")));
      regDiv.innerHTML =
        `<div><dt>${T("pf.vRegistry", { src: regSource })}</dt>` +
        `<dd class="fp${regOk ? " ok" : ""}">${stateTxt} · ${T("pf.vHeadLabel")} ${headTxt}</dd></div>` +
        (v.registryAddress ? `<div><dt>${T("pf.vRegistryContract")}</dt><dd class="fp">${shortHash(v.registryAddress)}</dd></div>` : "");
    } else {
      regDiv.innerHTML = `<div><dt>${T("pf.vRegistryNone")}</dt><dd class="fp">${T("pf.vNotConfigured")}</dd></div>`;
    }
    dl.append(...regDiv.children);
    // IPFS row: the pinned CID (linked to a gateway) + whether the fetched body hashed to the on-chain value.
    if (ipfsCid) {
      const ipfsState = ipfsOk === true ? T("pf.vIpfsOk")
        : (ipfsOk === false ? T("pf.vIpfsBad") : T("pf.vIpfsPending"));
      const ipfsDiv = document.createElement("div");
      ipfsDiv.innerHTML =
        `<div><dt>${T("pf.vIpfsOn")}</dt>` +
        `<dd class="fp${ipfsOk ? " ok" : ""}"><a href="${ipfsGw}/ipfs/${ipfsCid}" target="_blank" rel="noopener noreferrer">${shortHash(ipfsCid)}</a> · ${ipfsState}</dd></div>`;
      dl.append(...ipfsDiv.children);
    }
    out.append(badge, dl);
  } catch {
    out.textContent = T("pf.vFailed");
  }
}
/** Fold a page of poems into the accumulated collection (dedupe by seq, keep newest-first, track the oldest). */
export function mergeLaureateEntries(list) {
  const seen = new Set(state.laureateEntries.map((e) => e.seq));
  for (const e of list) {
    if (e && typeof e.seq === "number" && !seen.has(e.seq)) { state.laureateEntries.push(e); seen.add(e.seq); }
  }
  state.laureateEntries.sort((a, b) => b.seq - a.seq);
  state.laureateOldest = state.laureateEntries.length ? state.laureateEntries[state.laureateEntries.length - 1].seq : null;
}
export function findLaureateEntry(seq) {
  const n = Number(seq);
  if (state.laureateData && state.laureateData.latest && state.laureateData.latest.seq === n) return state.laureateData.latest;
  const inList = state.laureateEntries.find((e) => e.seq === n); if (inList) return inList;
  if (state.laureateData && Array.isArray(state.laureateData.entries)) { const r = state.laureateData.entries.find((e) => e.seq === n); if (r) return r; }
  return null;
}
export function openLaureate() {
  state.laureateOpen = true;
  if (state.templeOpen) closeTemple();
  if (state.canaryOpen) closeCanary();
  if (state.brainOpen) closeBrain();
  if (state.walletsOpen) closeWallets();
  if (state.historyOpen) closeHistory();
  if (state.proofsOpen) closeProofs();
  if (state.pulseOpen) closePulse();
  if (state.predictOpen) closePredict();
  if (state.lineageOpen) closeLineage();
  if (state.arenaOpen) closeArena();
  if (state.chronOpen) closeChron();
  const d = $("laureate"); if (!d) return;
  d.hidden = false;
  document.body.classList.add("laureate-open");
  requestAnimationFrame(() => d.classList.add("open"));
  paintLaureate();
  pollLaureate(true);                              // refresh the head immediately so it's never stale
  if (!state.laureateEntries.length) loadLaureateArchive(true);   // first open: pull the permanent collection
}
export function closeLaureate() {
  state.laureateOpen = false;
  document.body.classList.remove("laureate-open");
  const d = $("laureate"); if (!d) return;
  d.classList.remove("open");
  setTimeout(() => { if (!state.laureateOpen) d.hidden = true; }, 420);
}
export function toggleLaureate() { if (state.laureateOpen) closeLaureate(); else openLaureate(); }
/** Rebuild the whole drawer from cached data (no refetch) — safe to call on a language switch. */
export function paintLaureate() {
  const body = $("laureate-body"); if (!body) return;
  const d = state.laureateData;
  const sub = $("laureate-sub");
  if (sub) sub.textContent = (d && d.headSeq) ? T("laureate.subMeta", { count: state.laureateTotal || d.headSeq, head: shortHash(d.chainHead || "") }) : T("laureate.subEmpty");
  body.innerHTML = "";

  // --- autonomy attestation: what this is, and the receipts that make it checkable ---
  const auto = document.createElement("div"); auto.className = "lr-auto";
  auto.innerHTML =
    `<div class="lr-auto-title">${T("laureate.autoTitle")}</div>` +
    `<p class="lr-auto-body">${T("laureate.autoBody")}</p>` +
    `<dl class="lr-auto-meta">` +
    `<div><dt>${T("laureate.metaPolicy")}</dt><dd>${d ? d.policy : "–"}</dd></div>` +
    `<div><dt>${T("laureate.metaGrammar")}</dt><dd class="fp">${shortHash(d ? d.grammarHash : "")}</dd></div>` +
    `<div><dt>${T("laureate.metaChainHead")}</dt><dd class="fp">${shortHash(d ? d.chainHead : "")}</dd></div>` +
    `<div><dt>${T("laureate.metaArchive")}</dt><dd>${state.laureateArchived ? T("laureate.archivedYes", { n: state.laureateTotal }) : T("laureate.archivedNo")}</dd></div>` +
    `</dl>`;
  body.appendChild(auto);

  if (d && d.enabled === false) {
    const off = document.createElement("p"); off.className = "lr-empty"; off.textContent = T("laureate.disabled");
    body.appendChild(off); return;
  }

  const latest = d ? d.latest : null;
  // Identity comes from the CURRENT sitting laureate (top-level). The top-level object deliberately carries no
  // temperament, so borrow that snapshot from the latest poem ONLY when the same fly composed it (temperament is
  // a per-seed constant) — this fills the "气质" field without ever showing one poet's identity with another's
  // trait during the brief coronation gap before the new laureate's first poem.
  const curLaur = (d && d.laureate) || null;
  const latLaur = (latest && latest.laureate) || null;
  const laureate = curLaur
    ? (latLaur && latLaur.id === curLaur.id ? Object.assign({}, latLaur, curLaur) : curLaur)
    : latLaur;

  // --- the crowned poet ---
  body.appendChild(laureateCard(laureate, latest));

  // --- the latest poem ---
  if (latest) {
    const lh = document.createElement("div"); lh.className = "lr-sec-head"; lh.textContent = T("laureate.latestHead");
    body.appendChild(lh);
    body.appendChild(poemCard(latest, true));
  } else if (!state.laureateEntries.length) {
    const empty = document.createElement("p"); empty.className = "lr-empty"; empty.textContent = T("laureate.empty");
    body.appendChild(empty);
  }

  // --- the permanent collection ---
  const chh = document.createElement("div"); chh.className = "lr-sec-head";
  chh.innerHTML = `<span>${T("laureate.collectionHead")}</span> <em>${T("laureate.collectionSub")}</em>`;
  body.appendChild(chh);

  if (state.laureateLoading && !state.laureateEntries.length) {
    const ld = document.createElement("p"); ld.className = "lr-loading"; ld.textContent = T("laureate.loading"); body.appendChild(ld);
  } else if (!state.laureateEntries.length) {
    const none = document.createElement("p"); none.className = "lr-empty"; none.textContent = T("laureate.collectionEmpty"); body.appendChild(none);
  } else {
    const list = document.createElement("div"); list.className = "lr-list";
    const headSeq = latest ? latest.seq : null;   // the head is already featured above as "latest"
    // List everything BUT the head to avoid repeating the featured poem. When the head is the ONLY poem (a fresh
    // chain, total=1) fall back to showing it here too, so the permanent collection is never spuriously empty.
    let shown = state.laureateEntries.filter((e) => headSeq == null || e.seq !== headSeq);
    if (!shown.length) shown = state.laureateEntries;
    for (const e of shown) list.appendChild(poemCard(e, false));
    body.appendChild(list);
    if (state.laureateArchived && state.laureateEntries.length < state.laureateTotal) {
      const more = document.createElement("button"); more.type = "button"; more.className = "lr-more"; more.id = "lr-more";
      more.textContent = state.laureateLoadingMore ? T("laureate.loading") : T("laureate.loadMore", { loaded: state.laureateEntries.length, total: state.laureateTotal });
      body.appendChild(more);
    } else if (state.laureateArchived && state.laureateTotal) {
      const all = document.createElement("div"); all.className = "lr-all"; all.textContent = T("laureate.allLoaded", { n: state.laureateTotal });
      body.appendChild(all);
    }
  }

  // --- the honest verification boundary ---
  const hon = document.createElement("p"); hon.className = "lr-honesty"; hon.textContent = T("laureate.honesty");
  body.appendChild(hon);
}
/** The crowned poet's identity: which living fly wears the laurel, its house, temperament and coronation era. */
export function laureateCard(laureate, latest) {
  const wrap = document.createElement("div"); wrap.className = "lr-laureate";
  const title = `<div class="lr-laur-title"><span class="lr-laur-orn" aria-hidden="true">✦</span>${T("laureate.laureateHead")}</div>`;
  if (!laureate) { wrap.innerHTML = title + `<p class="lr-empty">${T("laureate.noLaureate")}</p>`; return wrap; }
  const era = latest && latest.era ? latest.era : null;
  const phaseKey = "laureate.phase." + ((era && era.civPhase) || "golden");
  wrap.innerHTML =
    title +
    `<div class="lr-laur-id">${T("laureate.flyId", { id: laureate.id })}</div>` +
    `<dl class="lr-laur-meta">` +
    `<div><dt>${T("laureate.house")}</dt><dd>${laureate.house ? laureate.house : T("laureate.houseless")}</dd></div>` +
    `<div><dt>${T("laureate.temperament")}</dt><dd>${lrNum(laureate.temperament, 2)}</dd></div>` +
    `<div><dt>${T("laureate.crownedEra")}</dt><dd>${era ? T("laureate.eraName", { n: era.era, name: era.eraName }) : ("#" + (laureate.crownedEraSeq ?? "–"))}</dd></div>` +
    `<div><dt>${T("laureate.climate")}</dt><dd>${T(phaseKey)}</dd></div>` +
    `</dl>`;
  return wrap;
}
/** One poem: the four lines, its meta (seq · era · by which fly), a verify bar and an expandable receipt. */
export function poemCard(e, featured) {
  const card = document.createElement("div"); card.className = "lr-card" + (featured ? " featured" : ""); card.dataset.seq = e.seq;
  const verse = document.createElement("div"); verse.className = "lr-verse";
  const lines = Array.isArray(e.lines) && e.lines.length ? e.lines : String(e.text || "").split("\n");
  for (const ln of lines) { const l = document.createElement("div"); l.className = "lr-line"; l.textContent = ln; verse.appendChild(l); }
  card.appendChild(verse);
  const era = e.era || {};
  const meta = document.createElement("div"); meta.className = "lr-meta";
  meta.innerHTML =
    `<span class="lr-seq">${T("laureate.seq", { n: e.seq })}</span>` +
    `<span class="lr-era">${T("laureate.eraName", { n: era.era ?? "–", name: era.eraName || "–" })}</span>` +
    `<span class="lr-by">${T("laureate.byFly", { id: e.laureate ? e.laureate.id : "–" })}</span>`;
  card.appendChild(meta);
  const vbar = document.createElement("div"); vbar.className = "lr-vbar";
  const vbtn = document.createElement("button"); vbtn.type = "button"; vbtn.className = "lr-verify"; vbtn.dataset.seq = e.seq; vbtn.textContent = T("laureate.verify");
  const ebtn = document.createElement("button"); ebtn.type = "button"; ebtn.className = "lr-expand"; ebtn.dataset.seq = e.seq; ebtn.textContent = "+";
  vbar.append(vbtn, ebtn);
  card.appendChild(vbar);
  const vout = document.createElement("div"); vout.className = "lr-verifyout"; vout.hidden = true;
  card.appendChild(vout);
  if (state.laureateVerified[e.seq]) paintPoemVerdict(vout, e.seq);   // restore a prior verdict across repaints
  const pbody = document.createElement("div"); pbody.className = "lr-body"; pbody.hidden = true;
  pbody.appendChild(poemDetail(e));
  card.appendChild(pbody);
  return card;
}
/** The expandable receipt: the neural ink, the on-chain reality folded in, and the chain hashes. */
export function poemDetail(e) {
  const wrap = document.createElement("div");
  const era = e.era || {}, chn = e.chain || {}, nrl = e.neural || {};
  const meta = document.createElement("dl"); meta.className = "lr-detail";
  meta.innerHTML =
    `<div><dt>${T("laureate.dReceipt")}</dt><dd class="fp">${shortHash(e.hash || "")}</dd></div>` +
    `<div><dt>${T("laureate.dPrev")}</dt><dd class="fp">${e.prevHash ? shortHash(e.prevHash) : T("laureate.dGenesis")}</dd></div>` +
    `<div><dt>${T("laureate.dGrammar")}</dt><dd class="fp">${shortHash(e.grammarHash || "")}</dd></div>` +
    `<div><dt>${T("laureate.dTick")}</dt><dd>${e.composedAtTick ?? "–"}</dd></div>` +
    `<div><dt>${T("laureate.dState")}</dt><dd>${nrl.state || "–"}</dd></div>` +
    `<div><dt>${T("laureate.dClimate")}</dt><dd>${T("laureate.phase." + (era.civPhase || "golden"))} · ${era.eraRegime || "–"}</dd></div>` +
    `<div><dt>${T("laureate.dTemp")}</dt><dd>${lrNum(chn.temperature)}</dd></div>` +
    `<div><dt>${T("laureate.dVol")}</dt><dd>${lrNum(chn.volumeUsdcDelta)} USDC</dd></div>` +
    `<div><dt>${T("laureate.dDeals")}</dt><dd>${chn.settlementsDelta ?? "–"}</dd></div>` +
    `<div><dt>${T("laureate.dDeaths")}</dt><dd>${chn.deathsDelta ?? "–"}</dd></div>` +
    `<div><dt>${T("laureate.dLive")}</dt><dd>${chn.liveAgents ?? "–"}</dd></div>` +
    `<div><dt>${T("laureate.dGini")}</dt><dd>${lrNum(chn.gini)}</dd></div>` +
    `<div><dt>${T("laureate.dArousal")}</dt><dd>${lrNum(nrl.arousal)}</dd></div>` +
    `<div><dt>${T("laureate.dCohesion")}</dt><dd>${lrNum(nrl.cohesion)}</dd></div>` +
    `<div><dt>${T("laureate.dWingbeat")}</dt><dd>${lrNum(nrl.wingbeat)}</dd></div>` +
    `<div><dt>${T("laureate.dFingerprint")}</dt><dd class="fp">${shortHash(nrl.fingerprint || "")}</dd></div>`;
  wrap.appendChild(meta);
  const ints = Array.isArray(e.neuralInts) ? e.neuralInts : [];
  if (ints.length) {
    const ink = document.createElement("div"); ink.className = "lr-ink";
    ink.innerHTML = `<div class="lr-ink-title">${T("laureate.inkTitle")}</div><div class="lr-ink-vals fp">${ints.join(" · ")}</div>`;
    wrap.appendChild(ink);
  }
  return wrap;
}
/** Verify one poem in-browser: recompute its receipt hash here, then ask /poem/verify to replay the grammar. */
export async function verifyPoem(seq, card) {
  if (!card) return;
  const out = card.querySelector(".lr-verifyout"); if (!out) return;
  const e = findLaureateEntry(seq);
  out.hidden = false; out.textContent = T("laureate.vChecking");
  // 1. browser-side receipt recompute (trustless self-consistency): sha256(entry minus hash) == entry.hash
  let clientHash = null;
  if (e) { try { const rest = Object.assign({}, e); delete rest.hash; clientHash = await sha256HexClient(rest); } catch { clientHash = null; } }
  try {
    const v = await getJSON(`/poem/verify?seq=${encodeURIComponent(seq)}`, 9000);
    const selfOk = (clientHash != null && e) ? (clientHash === e.hash) : (v.selfConsistent === true);
    const replayOk = v.replayMatch === true;
    const grammarOk = v.grammarMatches === true;
    state.laureateVerified[seq] = { ok: selfOk && replayOk && grammarOk, selfOk, replayOk, grammarOk, clientHash, published: (e && e.hash) || v.recomputedHash || "" };
    paintPoemVerdict(out, seq);
  } catch {
    out.textContent = T("laureate.vFailed");
  }
}
export function paintPoemVerdict(out, seq) {
  const r = state.laureateVerified[seq]; if (!r || !out) return;
  out.hidden = false; out.innerHTML = "";
  const badge = document.createElement("span");
  badge.className = "lr-badge " + (r.ok ? "ok" : "bad");
  badge.textContent = r.ok ? T("laureate.vBadgeOk") : T("laureate.vBadgeBad");
  const dl = document.createElement("dl"); dl.className = "lr-vmeta";
  dl.innerHTML =
    `<div><dt>${T("laureate.vShaBrowser")}</dt><dd class="fp">${r.clientHash ? shortHash(r.clientHash) : "–"}</dd></div>` +
    `<div><dt>${T("laureate.vPublished")}</dt><dd class="fp">${shortHash(r.published || "")}</dd></div>` +
    `<div><dt>${T("laureate.vSelf")}</dt><dd class="${r.selfOk ? "ok" : "bad"}">${r.selfOk ? T("laureate.vYes") : T("laureate.vNo")}</dd></div>` +
    `<div><dt>${T("laureate.vReplay")}</dt><dd class="${r.replayOk ? "ok" : "bad"}">${r.replayOk ? T("laureate.vYes") : T("laureate.vNo")}</dd></div>` +
    `<div><dt>${T("laureate.vGrammar")}</dt><dd class="${r.grammarOk ? "ok" : "bad"}">${r.grammarOk ? T("laureate.vYes") : T("laureate.vNo")}</dd></div>`;
  out.append(badge, dl);
}
// Recompute the manifest hash in-browser and read the on-chain anchor; store the result and re-render.
export async function verifyBrain() {
  const m = state.brainData;
  if (!m || !m.manifest) { renderBrain(); return; }
  let clientHash = null;
  try { clientHash = await sha256HexClient(m.manifest); } catch { clientHash = null; }
  const bodyOk = clientHash != null && clientHash === String(m.manifestHash || "").toLowerCase();
  let chain = null;
  if (m.registryAddress) chain = await readManifestOnchain(m.registryAddress, clientHash || m.manifestHash);
  const chainOk = !!chain && chain.committed === true;
  state.brainCheck = { clientHash, bodyOk, chain, chainOk };
  renderBrain();
}
export function openBrain() {
  state.brainOpen = true;
  if (state.templeOpen) closeTemple();
  if (state.canaryOpen) closeCanary();
  if (state.laureateOpen) closeLaureate();
  if (state.walletsOpen) closeWallets();
  if (state.historyOpen) closeHistory();
  if (state.proofsOpen) closeProofs();
  if (state.pulseOpen) closePulse();
  if (state.predictOpen) closePredict();
  if (state.arenaOpen) closeArena();
  if (state.lineageOpen) closeLineage();
  if (state.chronOpen) closeChron();
  const d = $("brain"); if (!d) return;
  d.hidden = false;
  document.body.classList.add("brain-open");
  requestAnimationFrame(() => d.classList.add("open"));
  if (!state.brainData && !state.brainLoading) loadBrain(); else renderBrain();
}
export function closeBrain() {
  state.brainOpen = false;
  document.body.classList.remove("brain-open");
  const d = $("brain"); if (!d) return;
  d.classList.remove("open");
  setTimeout(() => { if (!state.brainOpen) d.hidden = true; }, 420);
}
export function toggleBrain() { if (state.brainOpen) closeBrain(); else openBrain(); }
export function renderBrain() {
  const body = $("brain-body"); if (!body) return;
  const sub = $("brain-sub");
  body.innerHTML = "";
  if (state.brainLoading || !state.brainData) {
    if (sub) sub.textContent = state.brainLoading ? T("brain.loadingShort") : "–";
    const p = document.createElement("p"); p.className = "pf-empty";
    p.textContent = state.brainLoading ? T("brain.loadingBody") : T("brain.unavailable");
    body.appendChild(p);
    return;
  }
  const m = state.brainData.manifest || {};
  const c = m.connectome || {};
  const pop = m.population || {};
  const flies = Array.isArray(m.flies) ? m.flies : [];
  const nEach = flies.length && flies[0].structural ? flies[0].structural.neuronCount : null;
  if (sub) sub.textContent = T("brain.subFlies", { n: pop.size ?? flies.length }) + (nEach ? T("brain.subNeurons", { n: Number(nEach).toLocaleString() }) : "");

  // attestation header
  const auto = document.createElement("div"); auto.className = "pf-auto";
  auto.innerHTML =
    `<div class="pf-auto-title">${T("brain.title")}</div>` +
    `<p class="pf-auto-body">${T("brain.body")}</p>` +
    `<dl class="pf-auto-meta">` +
    `<div><dt>${T("brain.metaSchema")}</dt><dd>${m.schema || "–"} v${m.v ?? "–"}</dd></div>` +
    `<div><dt>${T("brain.metaChain")}</dt><dd>${m.chainTag || "–"} (${m.chainId ?? "–"})</dd></div>` +
    `<div><dt>${T("brain.metaPopulation")}</dt><dd>${pop.size ?? "–"} · ${T("brain.metaBase")} ${pop.seedBase ?? "–"}</dd></div>` +
    `<div><dt>${T("brain.metaSeedRule")}</dt><dd class="fp">${pop.seedFormula || "–"}</dd></div>` +
    `<div><dt>${T("brain.metaConnectome")}</dt><dd>${c.nSensory ?? "–"}/${c.nInterL1 ?? "–"}/${c.nInterL2 ?? "–"} · ρ${c.density ?? "–"}</dd></div>` +
    `<div><dt>${T("brain.metaPolicyProof")}</dt><dd>${m.policy || "–"} · v${m.proofV ?? "–"}</dd></div>` +
    `</dl>`;
  body.appendChild(auto);

  // verification result (auto-computed in-browser)
  body.appendChild(brainVerifyCard());

  // provenance + the explicit no-LLM statement
  const prov = m.provenance || {};
  const llm = m.llm || {};
  const provBox = document.createElement("div"); provBox.className = "pf-card"; provBox.style.padding = "10px 12px";
  provBox.innerHTML =
    `<div class="pf-ct-title">${T("brain.provenance")}</div>` +
    `<div class="pf-ct-ev">${T("brain.architecture", { a: prov.architecture || "–" })}</div>` +
    `<div class="pf-ct-ev">${T("brain.provenanceLine", { a: String(prov.flywireLiteral), b: String(prov.generatedDeterministically), c: String(prov.reproducibleFromSeed), d: String(prov.llmInvolved) })}</div>` +
    (llm.statement ? `<div class="pf-ct-ev" style="margin-top:6px">${llm.statement}</div>` : "");
  body.appendChild(provBox);

  // per-fly committed structural identity
  const t = document.createElement("div"); t.className = "pf-card"; t.style.padding = "10px 12px";
  t.innerHTML = `<div class="pf-ct-title">${T("brain.perFly", { n: flies.length })}</div>`;
  const tbl = document.createElement("div"); tbl.className = "br-table";
  const head = document.createElement("div"); head.className = "br-row br-head";
  head.innerHTML = `<span>#</span><span>${T("brain.colSeed")}</span><span>${T("brain.colNeuronSyn")}</span><span>${T("brain.colEdgeHash")}</span>`;
  tbl.appendChild(head);
  for (const f of flies) {
    const s = f.structural || {};
    const row = document.createElement("div"); row.className = "br-row";
    row.innerHTML = `<span>${f.id}</span><span>${f.seed}</span><span>${Number(s.neuronCount || 0).toLocaleString()}/${Number(s.synapseCount || 0).toLocaleString()}</span><span class="fp">${s.edgeHash || "–"}</span>`;
    tbl.appendChild(row);
  }
  t.appendChild(tbl);
  body.appendChild(t);
}
export function brainVerifyCard() {
  const m = state.brainData || {};
  const card = document.createElement("div"); card.className = "pf-card"; card.style.padding = "10px 12px";
  const chk = state.brainCheck;
  const cHash = chk && chk.clientHash ? chk.clientHash : null;
  const sHash = String(m.manifestHash || "").toLowerCase();
  const bodyOk = chk ? chk.bodyOk : null;
  const chain = chk ? chk.chain : null;
  const chainOk = chk ? chk.chainOk : null;
  const replay = state.brainReplay;
  const replayOk = replay ? replay.ok === true : null;
  // The hard trustless checks are the body hash + the replay; the on-chain anchor is a bonus that only
  // lights up once the hash is committed on the chain the browser reads (Arc mainnet).
  const hardOk = bodyOk === true && replayOk !== false;

  const badge = document.createElement("div");
  if (!chk) { badge.className = "pf-badge"; badge.textContent = T("brain.verifying"); }
  else if (!hardOk) { badge.className = "pf-badge bad"; badge.textContent = T("brain.badFail"); }
  else {
    badge.className = "pf-badge ok";
    badge.textContent = chainOk ? T("brain.badOkFull") : T("brain.badOkNoAnchor");
  }
  card.appendChild(badge);

  const dl = document.createElement("dl"); dl.className = "pf-vmeta";
  dl.innerHTML =
    `<div><dt>${T("brain.shaBrowser")}</dt><dd class="fp">${cHash ? shortHash(cHash) : "–"}</dd></div>` +
    `<div><dt>${T("brain.reported")}</dt><dd class="fp${bodyOk ? " ok" : ""}">${sHash ? shortHash(sHash) : "–"} ${bodyOk == null ? "" : (bodyOk ? "✓" : "✗")}</dd></div>`;
  if (m.registryAddress) {
    if (chain) {
      const stateTxt = chain.committed ? (chain.isLatest ? T("brain.registryCommittedLatest") : T("brain.registryCommittedOk")) : T("brain.registryNotCommitted");
      dl.innerHTML +=
        `<div><dt>${T("brain.registryDirect")}</dt><dd class="fp${chainOk ? " ok" : ""}">${stateTxt}</dd></div>` +
        `<div><dt>${T("brain.registryLatest")}</dt><dd class="fp">${chain.latest ? shortHash(chain.latest) : "–"} · ${chain.count}</dd></div>` +
        `<div><dt>${T("brain.registryContract")}</dt><dd class="fp"><a href="${ARC_EXPLORER}/address/${m.registryAddress}" target="_blank" rel="noopener noreferrer">${shortHash(m.registryAddress)}</a></dd></div>`;
    } else {
      dl.innerHTML +=
        `<div><dt>${T("brain.registryReadFail")}</dt><dd class="fp">${T("brain.registryReadFailNote")}</dd></div>` +
        `<div><dt>${T("brain.registryContract")}</dt><dd class="fp">${shortHash(m.registryAddress)}</dd></div>`;
    }
  } else {
    dl.innerHTML += `<div><dt>${T("brain.registryNone")}</dt><dd class="fp">${T("brain.registryNoneNote")}</dd></div>`;
  }
  dl.innerHTML += replay
    ? `<div><dt>${T("brain.replayLabel")}</dt><dd class="fp${replayOk ? " ok" : ""}">${T(replayOk ? "brain.replayPass" : "brain.replayFail", { n: replay.checked ?? 0 })}</dd></div>`
    : `<div><dt>${T("brain.replayUnavailable")}</dt><dd class="fp">${T("brain.replayNA")}</dd></div>`;
  card.appendChild(dl);

  const note = document.createElement("div"); note.className = "pf-ct-ev"; note.style.marginTop = "7px";
  note.textContent = T("brain.replayCmd", { hash: cHash || sHash || "<hash>" });
  card.appendChild(note);
  return card;
}
// last breed result/error text (operator panel)
export const LIN_ADMIN_TOKEN = params.get("token") || "";
export const LIN_OP = { genesis: "◦ genesis", mutate: "↻ mutate", cross: "⤫ cross" };
export function openLineage() {
  state.lineageOpen = true;
  if (state.templeOpen) closeTemple();
  if (state.canaryOpen) closeCanary();
  if (state.laureateOpen) closeLaureate();
  if (state.brainOpen) closeBrain();
  if (state.walletsOpen) closeWallets();
  if (state.historyOpen) closeHistory();
  if (state.proofsOpen) closeProofs();
  if (state.pulseOpen) closePulse();
  if (state.predictOpen) closePredict();
  if (state.arenaOpen) closeArena();
  if (state.chronOpen) closeChron();
  const d = $("lineage"); if (!d) return;
  d.hidden = false;
  document.body.classList.add("lineage-open");
  requestAnimationFrame(() => d.classList.add("open"));
  if (!state.lineageData && !state.lineageLoading) loadLineage(); else renderLineage();
}
export function closeLineage() {
  state.lineageOpen = false;
  document.body.classList.remove("lineage-open");
  const d = $("lineage"); if (!d) return;
  d.classList.remove("open");
  setTimeout(() => { if (!state.lineageOpen) d.hidden = true; }, 420);
}
export function toggleLineage() { if (state.lineageOpen) closeLineage(); else openLineage(); }
// Load one individual's full detail + server verify, and recompute its genome hash in-browser (the trustless bit).
export async function selectLineage(hash) {
  state.lineageSelLoading = true; state.lineageSel = { hash }; renderLineage();
  const [detail, verify, onchainDirect] = await Promise.all([
    getJSON("/lineage/" + hash, 12000).catch(() => null),
    getJSON("/lineage/verify?hash=" + hash, 12000).catch(() => null),
    readLineageOnchain(d0LineageAddr(), hash),           // read the committed ancestry off Arc IN THE BROWSER (trustless)
  ]);
  let clientHash = null;
  const genome = detail && detail.entry ? detail.entry.genome : null;
  if (genome) { try { clientHash = await sha256HexClient(genome); } catch { clientHash = null; } }
  const bodyOk = clientHash != null && detail && detail.entry
    && clientHash === String(detail.entry.genomeHash || "").toLowerCase();
  // Cross-check the DIRECT Arc read against the served entry — trusts no murmur server. (Genesis rows carry an
  // empty served breeder, so only compare breeder when the server actually has one.)
  const e = (detail && detail.entry) || {};
  const opCode = e.op === "genesis" ? 0 : e.op === "mutate" ? 1 : 2;
  let chainMatch = null;
  if (onchainDirect && onchainDirect.committed && detail && detail.entry) {
    const norm = (p) => String(p || "").toLowerCase().replace(/^0x/, "");   // served parents are bare 64-hex; chain words keep 0x
    const servedParents = (Array.isArray(e.parents) ? e.parents : []).map(norm).sort();
    const chainParents = [onchainDirect.parentA, onchainDirect.parentB]
      .filter((p) => !isZeroBytes32(p)).map(norm).sort();
    chainMatch = onchainDirect.op === opCode
      && onchainDirect.generation === (e.generation ?? 0)
      && chainParents.join(",") === servedParents.join(",")
      && (!isRealAddr(e.breeder || "") || onchainDirect.breeder.toLowerCase() === String(e.breeder).toLowerCase());
  }
  state.lineageSel = { hash, detail, verify, clientHash, bodyOk, onchainDirect, chainMatch };
  state.lineageSelLoading = false; renderLineage();
}
// Operator-only: apply a genetic operator to committed parents and record the offspring.
export async function doBreed() {
  if (!LIN_ADMIN_TOKEN) return;
  const op = ($("lin-op") || {}).value || "mutate";
  const a = ($("lin-pa") || {}).value || "";
  const b = ($("lin-pb") || {}).value || "";
  const parents = [a.trim(), op === "cross" ? b.trim() : ""].filter(Boolean);
  const seedRaw = ($("lin-seed") || {}).value || "";
  const breeder = ($("lin-breeder") || {}).value || "";
  const body = { op, parents };
  if (seedRaw.trim() !== "" && Number.isFinite(Number(seedRaw))) body.rngSeed = Number(seedRaw) >>> 0;
  if (breeder.trim()) body.breeder = breeder.trim();
  state.lineageBreedMsg = "breeding …"; renderLineage();
  try {
    const r = await fetch(API + "/breed?token=" + encodeURIComponent(LIN_ADMIN_TOKEN), {
      method: "POST", cache: "no-store", headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    const j = await r.json().catch(() => null);
    if (!r.ok || !j || j.ok !== true) {
      state.lineageBreedMsg = "✗ " + ((j && (j.error || j.code)) || ("HTTP " + r.status));
    } else {
      state.lineageBreedMsg = "✓ bred " + shortHash(j.entry.genomeHash) + " · gen " + j.entry.generation + (j.entry.commitTx ? " · on-chain " + shortHash(j.entry.commitTx) : "");
      state.lineageData = null; await loadLineage(); await selectLineage(j.entry.genomeHash); return;
    }
  } catch (e) {
    state.lineageBreedMsg = "✗ " + (e && e.message ? e.message : "network error");
  }
  renderLineage();
}
export function renderLineage() {
  const body = $("lineage-body"); if (!body) return;
  const sub = $("lineage-sub");
  body.innerHTML = "";
  if (state.lineageLoading || !state.lineageData) {
    if (sub) sub.textContent = state.lineageLoading ? T("lin.loadingShort") : "–";
    const p = document.createElement("p"); p.className = "pf-empty";
    p.textContent = state.lineageLoading ? T("lin.loadingBody") : T("lin.unavailable");
    body.appendChild(p);
    return;
  }
  const d = state.lineageData;
  const entries = Array.isArray(d.entries) ? d.entries : [];
  if (sub) sub.textContent = T("lin.sub", { n: d.count ?? entries.length, bred: d.bred ?? 0, gen: d.generations ?? 0 });

  // header / attestation
  const auto = document.createElement("div"); auto.className = "pf-auto";
  const anchored = isRealAddr(d.lineageAddress || "");
  const anchoredCount = entries.filter((e) => e.commitTx).length;   // genomes carrying a real on-chain commit tx
  const head = state.lineageHead;                                        // live head read DIRECTLY from Arc (may be null)
  auto.innerHTML =
    `<div class="pf-auto-title">${T("lin.title")}</div>` +
    `<p class="pf-auto-body">${T("lin.body")}</p>` +
    `<dl class="pf-auto-meta">` +
    `<div><dt>${T("lin.metaGenomes")}</dt><dd>${d.count ?? entries.length}</dd></div>` +
    `<div><dt>${T("lin.metaGenesisBred")}</dt><dd>${d.genesis ?? 0} · ${d.bred ?? 0}</dd></div>` +
    `<div><dt>${T("lin.metaGenerations")}</dt><dd>${d.generations ?? 0}</dd></div>` +
    `<div><dt>${T("lin.metaChain")}</dt><dd>arc (${d.chainId ?? "–"})</dd></div>` +
    `<div><dt>${T("lin.metaAnchor")}</dt><dd class="fp">${anchored ? `<a href="${ARC_EXPLORER}/address/${d.lineageAddress}" target="_blank" rel="noopener noreferrer">${shortHash(d.lineageAddress)}</a>` : T("lin.notConfigured")}</dd></div>` +
    `<div><dt>${T("lin.metaCommitted")}</dt><dd>${head ? head.commitCount : anchoredCount + "*"} · ${anchoredCount}/${entries.length} ${T("lin.shownSuffix")}</dd></div>` +
    `<div><dt>${T("lin.metaCommitter")}</dt><dd class="fp">${head && head.committer ? `<a href="${ARC_EXPLORER}/address/${head.committer}" target="_blank" rel="noopener noreferrer">${shortHash(head.committer)}</a>` : T("lin.readingArc")}</dd></div>` +
    `</dl>`;
  body.appendChild(auto);

  if (LIN_ADMIN_TOKEN) body.appendChild(lineageBreedPanel());

  // family tree, grouped by generation (roots first)
  const byGen = new Map();
  for (const e of entries) {
    const g = e.generation ?? 0;
    if (!byGen.has(g)) byGen.set(g, []);
    byGen.get(g).push(e);
  }
  const gens = [...byGen.keys()].sort((a, b) => a - b);
  const tree = document.createElement("div"); tree.className = "pf-card lin-tree";
  tree.innerHTML = `<div class="pf-ct-title">${T("lin.familyTree", { n: entries.length })}</div>`;
  for (const g of gens) {
    const gEl = document.createElement("div"); gEl.className = "lin-gen";
    gEl.innerHTML = `<span class="lin-gen-label">${T("lin.genLabel", { g })}</span>`;
    const rows = document.createElement("div"); rows.className = "lin-rows";
    for (const e of byGen.get(g)) {
      const sel = state.lineageSel && state.lineageSel.hash === e.genomeHash;
      const row = document.createElement("button");
      row.type = "button"; row.className = "lin-row" + (sel ? " is-sel" : "");
      row.dataset.linHash = e.genomeHash;
      const opCls = "lin-op lin-op-" + (e.op || "genesis");
      const tip = e.commitTx ? T("lin.tipAnchored", { tx: e.commitTx }) : T("lin.tipNotAnchored");
      row.innerHTML =
        `<span class="${opCls}">${linOpLabel(e.op)}</span>` +
        `<span class="fp lin-hash">${shortHash(e.genomeHash)}</span>` +
        `<span class="lin-breeder">${isRealAddr(e.breeder || "") ? shortHash(e.breeder) : (e.breeder ? e.breeder : "–")}</span>` +
        `<span class="lin-commit" title="${tip}">${e.commitTx ? "⛓" : ""}</span>`;
      rows.appendChild(row);
    }
    gEl.appendChild(rows);
    tree.appendChild(gEl);
  }
  body.appendChild(tree);

  if (state.lineageSel) body.appendChild(lineageDetailCard());
}
// Localise the three genetic-operator badges; the raw uppercase keys (genesis/mutate/cross) stay
// in the DOM dataset for logic, only the visible label goes through the dictionary.
export function linOpLabel(op) {
  const k = op || "genesis";
  const key = "lin.op." + k;
  const s = T(key);
  return s === key ? (k.toUpperCase ? k : String(k)) : s;
}
export function lineageBreedPanel() {
  const p = document.createElement("div"); p.className = "pf-card lin-breed";
  p.innerHTML =
    `<div class="pf-ct-title">${T("lin.breedTitle")}</div>` +
    `<div class="lin-breed-row">` +
    `<select id="lin-op" class="lin-in"><option value="mutate">${T("lin.opMutate")}</option><option value="cross">${T("lin.opCross")}</option></select>` +
    `<input id="lin-pa" class="lin-in fp" placeholder="${T("lin.paPh")}" />` +
    `<input id="lin-pb" class="lin-in fp" placeholder="${T("lin.pbPh")}" />` +
    `</div>` +
    `<div class="lin-breed-row">` +
    `<input id="lin-seed" class="lin-in" placeholder="${T("lin.seedPh")}" />` +
    `<input id="lin-breeder" class="lin-in fp" placeholder="${T("lin.breederPh")}" />` +
    `<button id="lin-breed-go" type="button" class="lin-breed-btn">${T("lin.breedBtn")}</button>` +
    `</div>` +
    (state.lineageBreedMsg ? `<div class="lin-breed-msg">${state.lineageBreedMsg}</div>` : "");
  return p;
}
export function lineageDetailCard() {
  const card = document.createElement("div"); card.className = "pf-card lin-detail";
  if (state.lineageSelLoading || !state.lineageSel.detail) {
    card.innerHTML = `<div class="pf-ct-title">${T("lin.detailIndividual")}</div><div class="pf-ct-ev">${state.lineageSelLoading ? T("lin.detailLoading") : T("lin.detailUnavail")}</div>`;
    return card;
  }
  const det = state.lineageSel.detail, e = det.entry || {}, s = det.spec || {}, v = state.lineageSel.verify || {};
  const g = e.genome || {};
  const clientHash = state.lineageSel.clientHash;
  const bodyOk = state.lineageSel.bodyOk;
  const chainOk = v.checks ? v.checks.chainOk : null;
  const specOk = v.checks ? v.checks.specOk : null;
  const hardOk = bodyOk === true && specOk !== false;
  const parents = Array.isArray(e.parents) ? e.parents : [];
  const children = Array.isArray(det.children) ? det.children : [];

  const chainProvenBrowser = state.lineageSel.chainMatch === true;   // ancestry matched via a DIRECT Arc read in-browser
  const badge = document.createElement("div");
  if (hardOk && (chainProvenBrowser || chainOk === true)) {
    badge.className = "pf-badge ok";
    badge.textContent = chainProvenBrowser ? T("lin.badOkBrowser") : T("lin.badOkChain");
  }
  else if (hardOk) { badge.className = "pf-badge ok"; badge.textContent = T("lin.badOkNoAnchor"); }
  else { badge.className = "pf-badge bad"; badge.textContent = T("lin.badFail"); }
  card.appendChild(badge);

  const dl = document.createElement("dl"); dl.className = "pf-vmeta";
  dl.innerHTML =
    `<div><dt>${T("lin.metaGenomeHash")}</dt><dd class="fp">${shortHash(e.genomeHash || "")}</dd></div>` +
    `<div><dt>${T("lin.metaShaBrowser")}</dt><dd class="fp${bodyOk ? " ok" : ""}">${clientHash ? shortHash(clientHash) : "–"} ${bodyOk == null ? "" : (bodyOk ? "✓" : "✗")}</dd></div>` +
    `<div><dt>${T("lin.metaOpGen")}</dt><dd>${linOpLabel(e.op)} · ${T("lin.genLabel", { g: e.generation ?? 0 })}</dd></div>` +
    `<div><dt>${T("lin.metaRngSeed")}</dt><dd class="fp">${e.rngSeed == null ? T("lin.metaRngGenesis") : e.rngSeed}</dd></div>` +
    `<div><dt>${T("lin.metaBreeder")}</dt><dd class="fp">${isRealAddr(e.breeder || "") ? `<a href="${ARC_EXPLORER}/address/${e.breeder}" target="_blank" rel="noopener noreferrer">${shortHash(e.breeder)}</a>` : (e.breeder || "–")}</dd></div>` +
    `<div><dt>${T("lin.metaNeuronSyn")}</dt><dd>${Number(s.neuronCount || 0).toLocaleString()} · ${Number(s.synapseCount || 0).toLocaleString()}</dd></div>` +
    `<div><dt>${T("lin.metaEdgeHash")}</dt><dd class="fp">${s.edgeHash || "–"}</dd></div>` +
    `<div><dt>${T("lin.metaParents")}</dt><dd class="fp">${parents.length ? parents.map((h) => `<a href="#" data-lin-hash="${h}" class="lin-plink">${shortHash(h)}</a>`).join(" · ") : T("lin.metaGenesisRoot")}</dd></div>` +
    `<div><dt>${T("lin.metaChildren")}</dt><dd class="fp">${children.length ? children.map((h) => `<a href="#" data-lin-hash="${h}" class="lin-plink">${shortHash(h)}</a>`).join(" · ") : T("lin.metaNone")} · ${det.fertility ?? children.length}</dd></div>`;
  if (e.commitTx) {
    dl.innerHTML += `<div><dt>${T("lin.metaOnchainCommit")}</dt><dd class="fp"><a href="${ARC_EXPLORER}/tx/${e.commitTx}" target="_blank" rel="noopener noreferrer">↗ ${shortHash(e.commitTx)}</a></dd></div>`;
  }
  const oc = state.lineageSel.onchainDirect;                    // read off Arc in YOUR browser — no murmur server in the loop
  if (oc && oc.committed) {
    const when = oc.ts ? new Date(oc.ts * 1000).toISOString().slice(0, 19).replace("T", " ") + "Z" : "–";
    const m = state.lineageSel.chainMatch;
    const ocParents = [oc.parentA, oc.parentB].filter((p) => !isZeroBytes32(p));
    dl.innerHTML +=
      `<div><dt>${T("lin.onchainAncestry")}</dt><dd class="fp${m ? " ok" : ""}">${T("lin.opVerb")} ${oc.op} · ${T("lin.generation")} ${oc.generation} · ${T("lin.committed")} ${when} ${m ? T("lin.matchOk") : T("lin.matchBad")}</dd></div>` +
      `<div><dt>${T("lin.onchainBreeder")}</dt><dd class="fp">${isRealAddr(oc.breeder) ? `<a href="${ARC_EXPLORER}/address/${oc.breeder}" target="_blank" rel="noopener noreferrer">${shortHash(oc.breeder)}</a>` : "–"}</dd></div>` +
      (ocParents.length ? `<div><dt>${T("lin.onchainParents")}</dt><dd class="fp">${ocParents.map((p) => `<a href="#" data-lin-hash="${p.slice(2)}" class="lin-plink">${shortHash(p)}</a>`).join(" · ")}</dd></div>` : "");
  } else if (isRealAddr(d0LineageAddr())) {
    dl.innerHTML += `<div><dt>${T("lin.onchainNotCommitted")}</dt><dd class="fp">${oc ? T("lin.onchainNotCommittedNote") : T("lin.onchainReadFail")}</dd></div>`;
  }
  card.appendChild(dl);

  const genomeBox = document.createElement("div"); genomeBox.className = "lin-genome";
  genomeBox.innerHTML = `<div class="pf-ct-ev" style="margin-top:8px">${T("lin.genomeRebuild")}</div>` +
    `<pre class="lin-genome-json">${JSON.stringify(g, null, 0)}</pre>`;
  card.appendChild(genomeBox);
  return card;
}
// The configured lineage contract address (from the loaded /lineage payload), for the detail card's fallback.
export function d0LineageAddr() { return (state.lineageData && state.lineageData.lineageAddress) || ""; }
// ================= arc pulse drawer (x402 data product + trustless leaderboard) =================
export function openPulse() {
  state.pulseOpen = true;
  if (state.templeOpen) closeTemple();
  if (state.canaryOpen) closeCanary();
  if (state.laureateOpen) closeLaureate();
  if (state.brainOpen) closeBrain();
  if (state.walletsOpen) closeWallets();
  if (state.historyOpen) closeHistory();
  if (state.proofsOpen) closeProofs();
  if (state.predictOpen) closePredict();
  if (state.lineageOpen) closeLineage();
  if (state.chronOpen) closeChron();
  const d = $("pulse"); if (!d) return;
  d.hidden = false;
  document.body.classList.add("pulse-open");
  requestAnimationFrame(() => d.classList.add("open"));
  renderPulse();
}
export function closePulse() {
  state.pulseOpen = false;
  document.body.classList.remove("pulse-open");
  const d = $("pulse"); if (!d) return;
  d.classList.remove("open");
  setTimeout(() => { if (!state.pulseOpen) d.hidden = true; }, 420);
}
export function togglePulse() { if (state.pulseOpen) closePulse(); else openPulse(); }
export async function renderPulse() {
  const body = $("pulse-body"); if (!body) return;
  body.innerHTML = `<p class="pulse-loading">${T("pulse.loading")}</p>`;
  const [reqRes, lbRes] = await Promise.all([
    getJSON("/signal/requirements", 8000).catch(() => null),
    getJSON("/leaderboard", 8000).catch(() => null),
  ]);
  if (!state.pulseOpen) return;                 // closed while fetching
  state.pulseReqs = reqRes || null;
  state.pulseLB = lbRes || null;
  paintPulse();
}
/** (Re)build the drawer body from cached state — used on open and after a purchase. */
export function paintPulse() {
  const body = $("pulse-body"); if (!body) return;
  const sub = $("pulse-sub");
  if (sub) sub.textContent = state.pulseReqs && state.pulseReqs.enabled
    ? T("pulse.subEnabled", { price: state.pulseReqs.priceUsdc, mode: state.pulseReqs.mode })
    : T("pulse.subDisabled");
  body.innerHTML = "";
  body.appendChild(pulseSignalCard());
  if (state.pulsePaid) body.appendChild(pulsePaidCard(state.pulsePaid));
  body.appendChild(pulseLeaderCard());
}
/** Free live gauge + the locked machine-readable bundle + price/buy row. */
export function pulseSignalCard() {
  const card = document.createElement("div"); card.className = "pulse-card signal";
  const temp = state.collective ? clamp(state.collective.temperature) : state.tempSmoothed;
  const regime = (state.collective && state.collective.regime) ? String(state.collective.regime)
    : (temp >= 0.66 ? "HOT" : temp <= 0.33 ? "COLD" : "CALM");
  const r = state.pulseReqs;
  const enabled = !!(r && r.enabled);
  const regimeLabel = gl("regime", regime.toLowerCase());
  card.innerHTML =
    `<div class="pulse-title">${T("pulse.cardTitle")} <span class="pulse-regime ${regime.toLowerCase()}">${regimeLabel}</span></div>` +
    `<p class="pulse-blurb">${T("pulse.blurb")}</p>` +
    `<div class="pulse-gauge"><div class="pulse-gauge-fill" style="width:${(clamp(temp) * 100).toFixed(1)}%"></div></div>` +
    `<div class="pulse-gauge-meta"><span>${T("pulse.gaugeT", { v: temp.toFixed(2) })}</span><span>${T("pulse.freeLive")}</span></div>` +
    `<div class="pulse-lock">${T("pulse.lockedBundle")}</div>` +
    (enabled
      ? `<div class="pulse-buyrow"><button type="button" class="pulse-buy">${T("pulse.buyBtn", { price: r.priceUsdc })}</button>` +
        `<span class="pulse-mode">${r.mode === "onchain" ? T("pulse.modeOnchain") : T("pulse.modeSim")}</span></div>`
      : `<div class="pulse-buyrow"><span class="pulse-mode">${T("pulse.unavailable")}</span></div>`) +
    `<div class="pulse-status"></div>`;
  return card;
}
/** The purchased read: trader-facing sentence + machine-readable JSON + settlement proof link. */
export function pulsePaidCard(j) {
  const card = document.createElement("div"); card.className = "pulse-card paid";
  const s = (j && j.signal) || {};
  const st = (j && j.settlement) || {};
  const txOk = st.txHash && isRealTxHash(st.txHash);
  card.innerHTML =
    `<div class="pulse-title">${T("pulse.paidTitle")}</div>` +
    `<div class="pulse-read">${s.read || ""}</div>` +
    `<dl class="pulse-meta">` +
      `<div><dt>${T("pulse.metaRegime")}</dt><dd>${s.regime ? gl("regime", s.regime) : "\u2013"}</dd></div>` +
      `<div><dt>${T("pulse.metaTemp")}</dt><dd>${typeof s.temperature === "number" ? s.temperature.toFixed(3) : "\u2013"}</dd></div>` +
      `<div><dt>${T("pulse.metaBlock")}</dt><dd>${s.chain && s.chain.blockNumber != null ? "#" + s.chain.blockNumber : "\u2013"}</dd></div>` +
      `<div><dt>${T("pulse.metaTick")}</dt><dd>#${s.tickIndex != null ? s.tickIndex : "\u2013"}</dd></div>` +
    `</dl>` +
    `<pre class="pulse-json">${JSON.stringify(s, null, 2)}</pre>` +
    (txOk
      ? `<a class="tx-link" href="${ARC_EXPLORER}/tx/${st.txHash}" target="_blank" rel="noopener noreferrer">${T("pulse.verifyPayment", { hash: shortHash(st.txHash) })}</a>`
      : `<div class="pulse-simnote">${st.shadow ? T("pulse.shadowNote") : T("pulse.simNote")}</div>`);
  return card;
}
/** Trustless PnL leaderboard + paid-signal revenue counter. */
export function pulseLeaderCard() {
  const card = document.createElement("div"); card.className = "pulse-card leader";
  const lb = state.pulseLB;
  const rows = (lb && Array.isArray(lb.rows)) ? lb.rows : [];
  const p = (lb && lb.pulse) || null;
  let html =
    `<div class="pulse-title">${T("pulse.leaderTitle")}</div>` +
    `<p class="pulse-blurb">${T("pulse.leaderBlurb")}</p>`;
  if (p && p.enabled) {
    const txOk = p.lastTx && isRealTxHash(p.lastTx);
    html += `<div class="lb-pulse">` +
      `<span><b>${p.sales || 0}</b> ${T("pulse.salesLabel")}</span>` +
      `<span><b>${Number(p.grossUsdc || 0).toFixed(4)}</b> ${T("pulse.grossLabel")}</span>` +
      (txOk ? `<a class="tx-link" href="${ARC_EXPLORER}/tx/${p.lastTx}" target="_blank" rel="noopener noreferrer">${T("pulse.lastLink", { hash: shortHash(p.lastTx) })}</a>` : "") +
      `</div>`;
  }
  if (!rows.length) {
    html += `<p class="pulse-empty">${T("pulse.leaderEmpty")}</p>`;
  } else {
    const live = lb && lb.mode === "onchain";
    html += `<div class="lb-head"><span>#</span><span>${T("pulse.colAgent")}</span><span>${T("pulse.colNet")}</span><span>${T("pulse.colBal")}</span><span>${T("pulse.colDS")}</span></div>`;
    html += rows.slice(0, 25).map((r, i) => {
      const addr = isRealAddr(r.address)
        ? (live
          ? `<a class="lb-addr" href="${ARC_EXPLORER}/address/${r.address}" target="_blank" rel="noopener noreferrer" title="${r.address}">${shortHash(r.address)}</a>`
          : `<span class="lb-addr" title="${r.address}">${shortHash(r.address)}</span>`)
        : `<span class="lb-addr">\u2013</span>`;
      const net = Number(r.netUsdc || 0);
      return `<div class="lb-row"><span class="lb-rank">${i + 1}</span>` +
        `<span class="lb-agent">#${r.id} ${addr}</span>` +
        `<span class="lb-net ${net > 0 ? "pos" : net < 0 ? "neg" : ""}">${net >= 0 ? "+" : ""}${net.toFixed(4)}</span>` +
        `<span class="lb-bal">${Number(r.balanceUsdc || 0).toFixed(4)}</span>` +
        `<span class="lb-deals">${r.deals || 0}/${r.sales || 0}</span></div>`;
    }).join("");
  }
  const regAddr = lb && isRealAddr(lb.registryAddress) ? lb.registryAddress : null;
  if (regAddr) html += `<div class="lb-reg">${T("pulse.registry")} <span class="fp">${shortHash(regAddr)}</span></div>`;
  card.innerHTML = html;
  return card;
}
/**
 * The browser-side x402 purchase. The VISITOR is the payer: they sign an EIP-3009
 * `transferWithAuthorization` with their OWN key in MetaMask (gasless), and the murmur Worker relays it
 * on-chain, paying gas — the canonical facilitator role. We never touch their private key.
 */
export async function buySignal(btn) {
  if (state.pulseBuying) return;
  const card = btn ? btn.closest(".pulse-card") : null;
  const status = card ? card.querySelector(".pulse-status") : null;
  const setMsg = (m, cls) => { if (status) { status.textContent = m; status.className = "pulse-status" + (cls ? " " + cls : ""); } };
  const r = state.pulseReqs;
  if (!r || !r.enabled) { setMsg(T("pulse.unavailable"), "bad"); return; }
  if (!window.ethereum) { setMsg(T("pulse.noWallet"), "bad"); return; }
  state.pulseBuying = true;
  if (btn) btn.disabled = true;
  try {
    setMsg(T("pulse.connectingWallet"));
    const accts = await window.ethereum.request({ method: "eth_requestAccounts" });
    const from = Array.isArray(accts) && accts[0];
    if (!from) { setMsg(T("pulse.noAccount"), "bad"); return; }

    // Make sure the wallet is on Arc (add the chain if MetaMask has never seen it).
    const chainHex = "0x" + Number(r.chainId).toString(16);
    const cur = await window.ethereum.request({ method: "eth_chainId" });
    if (String(cur).toLowerCase() !== chainHex.toLowerCase()) {
      setMsg(T("pulse.switchingArc"));
      const testnet = Number(r.chainId) !== 5042;
      try {
        await window.ethereum.request({ method: "wallet_switchEthereumChain", params: [{ chainId: chainHex }] });
      } catch (swErr) {
        if (swErr && (swErr.code === 4902 || /Unrecognized chain ID/i.test(String(swErr.message)))) {
          await window.ethereum.request({
            method: "wallet_addEthereumChain",
            params: [{
              chainId: chainHex,
              chainName: testnet ? "Arc Testnet" : "Arc",
              nativeCurrency: { name: "USDC", symbol: "USDC", decimals: 18 },
              rpcUrls: testnet ? ["https://rpc.testnet.arc.io"] : ["https://rpc.mainnet.arc.io"],
              blockExplorerUrls: ["https://explorer.arc.io"],
            }],
          });
        } else { throw swErr; }
      }
    }

    // Build the EIP-3009 authorization the payer signs. uint256/bytes32 fields go as strings.
    const deadline = Math.floor(Date.now() / 1000) + (r.maxTimeoutSeconds || 300);
    const nonce = "0x" + [...crypto.getRandomValues(new Uint8Array(32))].map((b) => b.toString(16).padStart(2, "0")).join("");
    const domain = { name: r.eip712.name, version: r.eip712.version, chainId: Number(r.chainId), verifyingContract: r.asset };
    const message = { from, to: r.payTo, value: String(r.priceAtomic), validAfter: "0", validBefore: String(deadline), nonce };
    const typed = {
      types: {
        EIP712Domain: [
          { name: "name", type: "string" }, { name: "version", type: "string" },
          { name: "chainId", type: "uint256" }, { name: "verifyingContract", type: "address" },
        ],
        TransferWithAuthorization: [
          { name: "from", type: "address" }, { name: "to", type: "address" },
          { name: "value", type: "uint256" }, { name: "validAfter", type: "uint256" },
          { name: "validBefore", type: "uint256" }, { name: "nonce", type: "bytes32" },
        ],
      },
      primaryType: "TransferWithAuthorization",
      domain, message,
    };
    setMsg(T("pulse.sign"));
    const signature = await window.ethereum.request({
      method: "eth_signTypedData_v4", params: [from, JSON.stringify(typed)],
    });

    const payload = {
      x402Version: 1, scheme: "exact", network: r.network,
      payload: {
        signature,
        authorization: {
          scheme: "exact", version: 1, from, to: r.payTo, value: String(r.priceAtomic),
          maxDeadline: deadline, nonce, asset: r.asset, extra: {},
        },
      },
    };
    setMsg(T("pulse.relaying"));
    const res = await fetch(API + "/signal/pulse", {
      method: "GET", cache: "no-store",
      headers: { "X-PAYMENT": btoa(JSON.stringify(payload)) },
    });
    if (res.status === 200) {
      const j = await res.json();
      state.pulsePaid = j;
      setMsg(T("pulse.paid"), "ok");
      paintPulse();
      // a sale bumps the revenue counter — refresh the leaderboard once, quietly
      getJSON("/leaderboard", 8000).then((lb) => { if (lb && state.pulseOpen) { state.pulseLB = lb; paintPulse(); } }).catch(() => {});
    } else {
      let why = T("pulse.rejected");
      try { const b = await res.json(); if (b && b.error) why = b.error; } catch { /* keep default */ }
      setMsg(why, "bad");
    }
  } catch (e) {
    const m = (e && (e.message || e.code)) || "failed";
    setMsg(/user rejected|denied|reject/i.test(String(m)) ? T("pulse.cancelled") : T("pulse.error", { msg: m }), "bad");
  } finally {
    state.pulseBuying = false;
    if (btn) btn.disabled = false;
  }
}
// ================= prediction market drawer (neural stakes + trustless hit-rate leaderboard) =================
export function openPredict() {
  state.predictOpen = true;
  if (state.templeOpen) closeTemple();
  if (state.canaryOpen) closeCanary();
  if (state.laureateOpen) closeLaureate();
  if (state.brainOpen) closeBrain();
  if (state.walletsOpen) closeWallets();
  if (state.historyOpen) closeHistory();
  if (state.proofsOpen) closeProofs();
  if (state.pulseOpen) closePulse();
  if (state.arenaOpen) closeArena();
  if (state.lineageOpen) closeLineage();
  if (state.chronOpen) closeChron();
  const d = $("predict"); if (!d) return;
  d.hidden = false;
  document.body.classList.add("predict-open");
  requestAnimationFrame(() => d.classList.add("open"));
  renderPredict();
}
export function closePredict() {
  state.predictOpen = false;
  document.body.classList.remove("predict-open");
  const d = $("predict"); if (!d) return;
  d.classList.remove("open");
  setTimeout(() => { if (!state.predictOpen) d.hidden = true; }, 420);
}
export function togglePredict() { if (state.predictOpen) closePredict(); else openPredict(); }
export async function renderPredict() {
  const body = $("predict-body"); if (!body) return;
  body.innerHTML = `<p class="predict-loading">${T("pred.loading")}</p>`;
  const res = await getJSON("/predictions", 8000).catch(() => null);
  if (!state.predictOpen) return;                 // closed while fetching
  state.predictData = res || null;
  paintPredict();
}
/** (Re)build the drawer body from cached state — used on open, on poll, and after a verify. */
export function paintPredict() {
  const body = $("predict-body"); if (!body) return;
  const sub = $("predict-sub");
  const d = state.predictData;
  if (sub) sub.textContent = d && d.enabled
    ? `${d.open ? T("pred.subOpen", { n: d.open.round }) : T("pred.subBetween")} · ${T("pred.subSettled", { n: d.totals ? d.totals.roundsResolved : 0 })}`
    : T("pred.subDefault");
  body.innerHTML = "";
  if (!d || !d.enabled) {
    body.innerHTML = `<p class="predict-empty">${T("pred.disabled")}</p>`;
    return;
  }
  body.appendChild(predictBookCard(d));
  body.appendChild(predictRecentCard(d));
  body.appendChild(predictLeaderCard(d));
}
/** The live book: parimutuel UP/DOWN pools, implied odds, and every fly's neural stake. */
export function predictBookCard(d) {
  const card = document.createElement("div"); card.className = "predict-card book";
  const o = d.open;
  const mode = d.mode === "onchain" ? T("pred.modeOnchain") : T("pred.modeSim");
  let html =
    `<div class="predict-title">${T("pred.bookTitle")} <span class="predict-mode">${mode}</span></div>` +
    `<p class="predict-blurb">${T("pred.blurb")}</p>`;
  if (!o) {
    html += `<p class="predict-empty">${T("pred.noRound")}</p>`;
    card.innerHTML = html;
    return card;
  }
  const upUsdc = Number(o.poolUpUsdc || 0), downUsdc = Number(o.poolDownUsdc || 0);
  const tot = upUsdc + downUsdc;
  const upPct = tot > 0 ? (upUsdc / tot) * 100 : 50;
  const downPct = tot > 0 ? 100 - upPct : 50;
  const band = Number((d.config && d.config.flatBand) || 0);
  html +=
    `<div class="pb-round">${T("pred.roundLine", { r: o.round, t: o.entryTick })}</div>` +
    `<div class="pb-pools">` +
      `<div class="pb-pool up"><span class="pb-side">${T("pred.upSide")}</span><span class="pb-amt">${upUsdc.toFixed(4)}</span></div>` +
      `<div class="pb-pool down"><span class="pb-side">${T("pred.downSide")}</span><span class="pb-amt">${downUsdc.toFixed(4)}</span></div>` +
    `</div>` +
    `<div class="pb-bar"><div class="pb-bar-up" style="width:${upPct.toFixed(1)}%"></div><div class="pb-bar-down" style="width:${downPct.toFixed(1)}%"></div></div>` +
    `<div class="pb-odds">` +
      `<div><dt>${T("pred.oddsUp")}</dt><dd>${Number(o.oddsUp || 0).toFixed(2)}×</dd><dd class="pb-prob">${(Number(o.probUp || 0) * 100).toFixed(0)}%</dd></div>` +
      `<div><dt>${T("pred.oddsDown")}</dt><dd>${Number(o.oddsDown || 0).toFixed(2)}×</dd><dd class="pb-prob">${(Number(o.probDown || 0) * 100).toFixed(0)}%</dd></div>` +
    `</div>` +
    `<dl class="pb-meta">` +
      `<div><dt>${T("pred.metaEntry")}</dt><dd>${Number(o.entryTemp || 0).toFixed(3)}</dd></div>` +
      `<div><dt>${T("pred.metaMomentum")}</dt><dd>${(Number(o.momentum || 0) >= 0 ? "+" : "") + Number(o.momentum || 0).toFixed(3)}</dd></div>` +
      `<div><dt>${T("pred.metaBets")}</dt><dd>${o.betCount || 0}</dd></div>` +
      `<div><dt>${T("pred.metaFlatBand")}</dt><dd>±${band.toFixed(3)}</dd></div>` +
    `</dl>`;
  const bets = Array.isArray(o.bets) ? o.bets : [];
  if (bets.length) {
    html += `<div class="pb-bets-title">${T("pred.stakesTitle")}</div><div class="pb-bets">` +
      bets.slice(0, 48).map((b) =>
        `<span class="pb-bet ${b.side === "UP" ? "up" : "down"}">#${b.id} ${b.side === "UP" ? "▲" : "▼"} ${Number(b.stakeUsdc || 0).toFixed(4)}</span>`
      ).join("") + `</div>`;
  }
  card.innerHTML = html;
  return card;
}
/** Recent resolutions, each with a one-click trustless verify (browser recompute + direct Arc read). */
export function predictRecentCard(d) {
  const card = document.createElement("div"); card.className = "predict-card recent";
  const rows = Array.isArray(d.recent) ? d.recent : [];
  let html =
    `<div class="predict-title">${T("pred.recentTitle")}</div>` +
    `<p class="predict-blurb">${T("pred.recentBlurb")}</p>`;
  if (!rows.length) {
    html += `<p class="predict-empty">${T("pred.recentEmpty")}</p>`;
    card.innerHTML = html; return card;
  }
  html += rows.slice(0, 12).map((r) => {
    const oc = String(r.outcome || "FLAT").toLowerCase();
    const delta = Number(r.delta || 0);
    const committed = !!r.commitTx && isRealTxHash(r.commitTx);
    return `<div class="pr-round" data-round="${r.round}">` +
      `<div class="pr-head">` +
        `<span class="pr-num">#${r.round}</span>` +
        `<span class="pr-outcome ${oc}">${r.outcome}</span>` +
        `<span class="pr-delta ${delta > 0 ? "pos" : delta < 0 ? "neg" : ""}">${delta >= 0 ? "+" : ""}${delta.toFixed(4)}</span>` +
        `<span class="pr-temp">${Number(r.entryTemp || 0).toFixed(3)} → ${Number(r.exitTemp || 0).toFixed(3)}</span>` +
      `</div>` +
      `<div class="pr-sub">` +
        `<span>${T("pred.betsUsdcLine", { n: r.betCount || 0, amt: Number(r.totalStakedUsdc || 0).toFixed(4) })}</span>` +
        `<span class="pr-hash fp">${shortHash(r.receiptHash || "")}</span>` +
      `</div>` +
      `<div class="pr-actions">` +
        `<button type="button" class="pr-verify" data-round="${r.round}">${T("pred.verifyBtn")}</button>` +
        (committed
          ? `<a class="tx-link" href="${ARC_EXPLORER}/tx/${r.commitTx}" target="_blank" rel="noopener noreferrer">${T("pred.registryLink", { hash: shortHash(r.commitTx) })}</a>`
          : `<span class="pr-simnote">${r.outcome === "FLAT" ? T("pred.flatNote") : T("pred.notCommitted")}</span>`) +
      `</div>` +
      `<div class="pr-verifyout" hidden></div>` +
    `</div>`;
  }).join("");
  card.innerHTML = html;
  return card;
}
/** Trustless hit-rate leaderboard: agents ranked by how often their neural read called the move. */
export function predictLeaderCard(d) {
  const card = document.createElement("div"); card.className = "predict-card leader";
  const rows = Array.isArray(d.leaderboard) ? d.leaderboard : [];
  const t = d.totals || {};
  let html =
    `<div class="predict-title">${T("pred.leaderTitle")}</div>` +
    `<p class="predict-blurb">${T("pred.leaderBlurb")}</p>`;
  if (t.roundsResolved != null) {
    html += `<div class="pl-totals">` +
      `<span><b>${t.roundsResolved || 0}</b> ${T("pred.totRounds")}</span>` +
      `<span><b>${t.committed || 0}</b> ${T("pred.totOnchain")}</span>` +
      `<span><b>${Number(t.volumeUsdc || 0).toFixed(4)}</b> ${T("pred.totUsdc")}</span>` +
      `<span><b>${t.activeBettors || 0}</b> ${T("pred.totBettors")}</span>` +
    `</div>`;
  }
  if (!rows.length) {
    html += `<p class="predict-empty">${T("pred.leaderEmpty")}</p>`;
    card.innerHTML = html; return card;
  }
  const live = d.mode === "onchain";
  const addrOf = (id) => { const a = state.econAgents.find((x) => x.id === id); return a && isRealAddr(a.address) ? a.address : null; };
  html += `<div class="pl-head"><span>#</span><span>${T("pred.colAgent")}</span><span>${T("pred.colHit")}</span><span>${T("pred.colNet")}</span><span>${T("pred.colRnd")}</span></div>`;
  html += rows.slice(0, 25).map((r, i) => {
    const addr = addrOf(r.id);
    const agent = addr
      ? (live
        ? `<a class="pl-addr" href="${ARC_EXPLORER}/address/${addr}" target="_blank" rel="noopener noreferrer" title="${addr}">${shortHash(addr)}</a>`
        : `<span class="pl-addr" title="${addr}">${shortHash(addr)}</span>`)
      : `<span class="pl-addr">–</span>`;
    const net = Number(r.pnlUsdc || 0);
    const hr = Number(r.hitRate || 0) * 100;
    return `<div class="pl-row"><span class="pl-rank">${i + 1}</span>` +
      `<span class="pl-agent">#${r.id} ${agent}</span>` +
      `<span class="pl-hit">${hr.toFixed(0)}%</span>` +
      `<span class="pl-net ${net > 0 ? "pos" : net < 0 ? "neg" : ""}">${net >= 0 ? "+" : ""}${net.toFixed(4)}</span>` +
      `<span class="pl-rounds">${r.hits || 0}/${r.rounds || 0}</span></div>`;
  }).join("");
  const regAddr = isRealAddr(d.registryAddress) ? d.registryAddress : null;
  if (regAddr) html += `<div class="pl-reg">${T("pred.registry")} <span class="fp">${shortHash(regAddr)}</span></div>`;
  card.innerHTML = html;
  return card;
}
/**
 * One-click trustless verification of a resolved round. Recomputes sha256(roundReceipt) in THIS browser
 * (byte-identical canonical JSON), then reads the commitment straight off the on-chain NeuralReceiptRegistry
 * via Arc RPC — no murmur server trusted. FLAT / one-sided rounds are refunded and never committed, so a
 * missing commitment there is expected, not a failure.
 */
export async function verifyPredictRound(round, wrap) {
  if (state.predictVerifying[round]) return;
  const out = wrap ? wrap.querySelector(".pr-verifyout") : null;
  if (out) { out.hidden = false; out.textContent = T("pred.vChecking"); }
  state.predictVerifying[round] = true;
  try {
    const v = await getJSON(`/predictions/verify?round=${encodeURIComponent(round)}`, 9000);
    if (!v.found) { if (out) out.textContent = T("pred.vNotFound"); return; }
    let clientHash = null;
    if (v.receipt) { try { clientHash = await sha256HexClient(v.receipt); } catch { clientHash = null; } }
    const selfOk = clientHash == null || clientHash === v.receiptHash;
    const serverOk = v.selfConsistent === true;
    let reg = null, regSource = "";
    if (v.registryAddress) { reg = await readRegistryOnchain(v.registryAddress, v.receiptHash); regSource = reg ? T("pred.vDirectRpc") : ""; }
    if (!reg && v.registry) { reg = v.registry; regSource = T("pred.vViaApi"); }
    const regOk = !!reg && reg.committed === true;
    const expectCommit = v.outcome !== "FLAT";
    const ok = selfOk && serverOk && (!expectCommit || regOk);
    if (!out) return;
    out.innerHTML = "";
    const badge = document.createElement("span");
    badge.className = "pr-badge " + (ok ? "ok" : "bad");
    badge.textContent = ok
      ? (expectCommit ? T("pred.vOkCommit") : T("pred.vOkFlat"))
      : T("pred.vBad");
    const dl = document.createElement("dl"); dl.className = "pr-vmeta";
    dl.innerHTML =
      `<div><dt>${T("pred.vOutcome")}</dt><dd>${v.outcome} · Δ ${(Number(v.delta || 0) >= 0 ? "+" : "") + Number(v.delta || 0).toFixed(4)} (${T("pred.vBand")} ±${Number(v.flatBand || 0).toFixed(3)})</dd></div>` +
      `<div><dt>${T("pred.vShaBrowser")}</dt><dd class="fp">${clientHash ? shortHash(clientHash) : "–"}</dd></div>` +
      `<div><dt>${T("pred.vPublishedHash")}</dt><dd class="fp">${shortHash(v.receiptHash || "")}</dd></div>`;
    const regDiv = document.createElement("div");
    if (reg) {
      const headTxt = reg.chainHead ? shortHash(reg.chainHead) : "–";
      const isHead = reg.chainHead && v.receiptHash && reg.chainHead.toLowerCase() === ("0x" + v.receiptHash).toLowerCase();
      const stateTxt = !reg.committed ? (expectCommit ? T("pred.vNotCommitted") : T("pred.vRefundedNotCommit")) : (isHead ? T("pred.vChainHeadOk") : T("pred.vCommittedOk"));
      regDiv.innerHTML =
        `<div><dt>${T("pred.vRegistry", { src: regSource })}</dt><dd class="fp${regOk || !expectCommit ? " ok" : ""}">${stateTxt} · ${T("pred.vHeadLabel")} ${headTxt}</dd></div>` +
        (v.registryAddress ? `<div><dt>${T("pred.vRegistryContract")}</dt><dd class="fp">${shortHash(v.registryAddress)}</dd></div>` : "");
    } else {
      regDiv.innerHTML = `<div><dt>${T("pred.vRegistryLabel")}</dt><dd class="fp">${expectCommit ? T("pred.vNotConfigured") : T("pred.vFlatNoCommit")}</dd></div>`;
    }
    dl.append(...regDiv.children);
    out.append(badge, dl);
  } catch {
    if (out) out.textContent = T("pred.vFailed");
  } finally {
    state.predictVerifying[round] = false;
  }
}
// 1s countdown refresher while the drawer is open

// Precomputed function selectors (keccak256 prefixes) — the page carries no ABI encoder, matching readRegistryOnchain.
export const MUR_SEL_BALANCE = "0x70a08231";
// balanceOf(address)
export const MUR_SEL_ALLOWANCE = "0xdd62ed3e";
// allowance(address,address)
export const MUR_SEL_APPROVE = "0x095ea7b3";
// approve(address,uint256)
export const ARENA_SEL_BET = "0xcf87935c";
// bet(uint256,uint8,uint256)
export const ARENA_SEL_CLAIM = "0x379607f5";
// claim(uint256)
export const ARENA_SEL_PAYOUT = "0x0523f1c3";
// payoutFor(uint256,address)
export const ARENA_SEL_BETS = "0xf644b3bb";
// bets(uint256,address)
export const ARENA_SIDE_UP = 1, ARENA_SIDE_DOWN = 2;
export const ARENA_OUTCOME = { 0: "pending", 1: "UP \u25b2", 2: "DOWN \u25bc", 3: "FLAT", 4: "REFUND" };
// ---- ABI word helpers: 32-byte big-endian hex (no 0x) + 18-dec MURMUR conversions ----
export const wordAddr = (a) => String(a).replace(/^0x/i, "").toLowerCase().padStart(64, "0");
export const wordUint = (n) => BigInt(n).toString(16).padStart(64, "0");
export const wordAt = (hex, i) => "0x" + String(hex || "").replace(/^0x/, "").slice(i * 64, (i + 1) * 64);
export const atomicToMur = (a) => Number(BigInt(a || "0x0")) / 1e18;
/** Parse a human MURMUR amount ("12.5") into an 18-dec atomic BigInt with no float drift. */
export function murToAtomic(str) {
  const s = String(str).trim().replace(/,/g, "");
  if (!/^\d*\.?\d*$/.test(s) || s === "" || s === ".") return 0n;
  const [ip, fp = ""] = s.split(".");
  return BigInt((ip || "0") + (fp + "000000000000000000").slice(0, 18));
}
export const fmtMur = (n, dp = 2) => Number(n || 0).toLocaleString("en-US", { minimumFractionDigits: dp, maximumFractionDigits: dp });
// ---- drawer lifecycle (mirrors the predict drawer; mutually exclusive with the others) ----
export function openArena() {
  state.arenaOpen = true;
  if (state.templeOpen) closeTemple();
  if (state.canaryOpen) closeCanary();
  if (state.laureateOpen) closeLaureate();
  if (state.brainOpen) closeBrain();
  if (state.walletsOpen) closeWallets();
  if (state.historyOpen) closeHistory();
  if (state.proofsOpen) closeProofs();
  if (state.pulseOpen) closePulse();
  if (state.predictOpen) closePredict();
  if (state.lineageOpen) closeLineage();
  if (state.chronOpen) closeChron();
  const d = $("arena"); if (!d) return;
  d.hidden = false;
  document.body.classList.add("arena-open");
  requestAnimationFrame(() => d.classList.add("open"));
  renderArena();
  if (!state.arenaTickTimer) state.arenaTickTimer = setInterval(arenaCountdownTick, 1000);
}
export function closeArena() {
  state.arenaOpen = false;
  document.body.classList.remove("arena-open");
  if (state.arenaTickTimer) { clearInterval(state.arenaTickTimer); state.arenaTickTimer = 0; }
  const d = $("arena"); if (!d) return;
  d.classList.remove("open");
  setTimeout(() => { if (!state.arenaOpen) d.hidden = true; }, 420);
}
export function toggleArena() { if (state.arenaOpen) closeArena(); else openArena(); }
export async function renderArena() {
  const body = $("arena-body"); if (!body) return;
  body.innerHTML = `<p class="ar-loading">${T("arena.loading")}</p>`;
  const res = await getJSON("/arena", 8000).catch(() => null);
  if (!state.arenaOpen) return;                 // closed while fetching
  state.arenaData = res || null;
  await arenaReadUser();
  if (!state.arenaOpen) return;
  paintArena();
}
/** Refresh just the countdown each second (no full re-render) so the betting window visibly ticks down. */
export function arenaCountdownTick() {
  const el = $("ar-countdown"); if (!el || !state.arenaData || !state.arenaData.current) return;
  const secs = Math.max(0, Number(state.arenaData.current.betDeadline || 0) - Math.floor(Date.now() / 1000));
  el.textContent = arenaClock(secs);
  if (secs <= 0) { state.lastArenaPoll = 0; pollArena(true); }   // window closed ⇒ pull the fresh (resolving) book
}
// ---- on-chain reads of the connected wallet's MURMUR + this/last round's position (browser → Arc, no server) ----
export async function arenaReadUser() {
  const d = state.arenaData;
  if (!d || !d.enabled || !state.arenaAcct || !isRealAddr(d.arenaAddress) || !isRealAddr(d.token)) { state.arenaUser = null; return; }
  const curId = d.current ? d.current.roundId : null;
  const prevId = d.previous ? d.previous.roundId : null;
  try {
    const [bal, allow, betsRes, curPay, prevPay] = await Promise.all([
      arcRpc("eth_call", [{ to: d.token, data: MUR_SEL_BALANCE + wordAddr(state.arenaAcct) }, "latest"]),
      arcRpc("eth_call", [{ to: d.token, data: MUR_SEL_ALLOWANCE + wordAddr(state.arenaAcct) + wordAddr(d.arenaAddress) }, "latest"]),
      curId != null ? arcRpc("eth_call", [{ to: d.arenaAddress, data: ARENA_SEL_BETS + wordUint(curId) + wordAddr(state.arenaAcct) }, "latest"]) : Promise.resolve(null),
      curId != null ? arcRpc("eth_call", [{ to: d.arenaAddress, data: ARENA_SEL_PAYOUT + wordUint(curId) + wordAddr(state.arenaAcct) }, "latest"]) : Promise.resolve(null),
      prevId != null ? arcRpc("eth_call", [{ to: d.arenaAddress, data: ARENA_SEL_PAYOUT + wordUint(prevId) + wordAddr(state.arenaAcct) }, "latest"]) : Promise.resolve(null),
    ]);
    const claims = [];
    if (curPay && BigInt(wordAt(curPay, 2)) !== 0n) claims.push({ roundId: curId, payout: atomicToMur(wordAt(curPay, 1)) });
    if (prevPay && BigInt(wordAt(prevPay, 2)) !== 0n) claims.push({ roundId: prevId, payout: atomicToMur(wordAt(prevPay, 1)) });
    state.arenaUser = {
      balance: atomicToMur(bal), balanceRaw: BigInt(bal || "0x0"),
      allowance: atomicToMur(allow), allowanceRaw: BigInt(allow || "0x0"),
      side: betsRes ? Number(BigInt(wordAt(betsRes, 0))) : 0,
      amount: betsRes ? atomicToMur(wordAt(betsRes, 1)) : 0,
      claims,
    };
  } catch { /* a failed read just leaves the last-known state; never break the drawer */ }
}
// ---- wallet plumbing: connect + ensure Arc, then send a tx and wait for its receipt ----
export async function arenaEnsureWallet(setMsg) {
  if (!window.ethereum) { setMsg(T("arena.noWallet"), "bad"); return null; }
  const d = state.arenaData;
  if (!d || !d.enabled) { setMsg(T("arena.unavailableEnv"), "bad"); return null; }
  const accts = await window.ethereum.request({ method: "eth_requestAccounts" });
  const from = Array.isArray(accts) && accts[0];
  if (!from) { setMsg(T("arena.noAccount"), "bad"); return null; }
  const chainHex = "0x" + Number(d.chainId).toString(16);
  const cur = await window.ethereum.request({ method: "eth_chainId" });
  if (String(cur).toLowerCase() !== chainHex.toLowerCase()) {
    setMsg(T("arena.switchingArc"));
    const testnet = Number(d.chainId) !== 5042;
    try {
      await window.ethereum.request({ method: "wallet_switchEthereumChain", params: [{ chainId: chainHex }] });
    } catch (swErr) {
      if (swErr && (swErr.code === 4902 || /Unrecognized chain ID/i.test(String(swErr.message)))) {
        await window.ethereum.request({
          method: "wallet_addEthereumChain",
          params: [{
            chainId: chainHex, chainName: testnet ? "Arc Testnet" : "Arc",
            nativeCurrency: { name: "USDC", symbol: "USDC", decimals: 18 },
            rpcUrls: testnet ? ["https://rpc.testnet.arc.io"] : ["https://rpc.mainnet.arc.io"],
            blockExplorerUrls: ["https://explorer.arc.io"],
          }],
        });
      } else { throw swErr; }
    }
  }
  state.arenaAcct = from.toLowerCase();
  return from;
}
export const arenaSendTx = (to, data) =>
  window.ethereum.request({ method: "eth_sendTransaction", params: [{ from: state.arenaAcct, to, data, value: "0x0" }] });
export async function arenaWaitReceipt(hash, tries = 40) {
  for (let i = 0; i < tries; i++) {
    await new Promise((r) => setTimeout(r, 1500));
    try {
      const rc = await arcRpc("eth_getTransactionReceipt", [hash], 8000);
      if (rc && rc.status) return rc.status === "0x1";
    } catch { /* keep polling */ }
  }
  return null;
}
export function arenaMsgFn(btn) {
  const card = btn ? btn.closest(".ar-card") : null;
  const status = (card && card.querySelector(".ar-status")) || document.querySelector("#arena-body .ar-status");
  return (m, cls) => { if (status) { status.textContent = m || ""; status.className = "ar-status" + (cls ? " " + cls : ""); } };
}
export function arenaErr(e) {
  const m = (e && (e.message || e.code)) || T("arena.failed");
  return /user rejected|denied|reject/i.test(String(m)) ? T("arena.cancelled") : T("arena.error", { msg: m });
}
// ---- actions ----
export async function arenaConnect(btn) {
  if (state.arenaBusy) return;
  const setMsg = arenaMsgFn(btn);
  state.arenaBusy = true; if (btn) btn.disabled = true;
  try {
    setMsg(T("arena.connecting"));
    const from = await arenaEnsureWallet(setMsg);
    if (!from) return;
    await arenaReadUser();
    if (!state.arenaOpen) return;
    paintArena();
    arenaMsgFn(null)(T("arena.connected", { hash: shortHash(from) }), "ok");
  } catch (e) { setMsg(arenaErr(e), "bad"); }
  finally { state.arenaBusy = false; if (btn) btn.disabled = false; }
}
export async function arenaBet(side, btn) {
  if (state.arenaBusy) return;
  const setMsg = arenaMsgFn(btn);
  const d = state.arenaData;
  if (!d || !d.enabled || !d.current) { setMsg(T("arena.noLiveRound"), "bad"); return; }
  const c = d.current;
  if (c.resolved || Number(c.secondsToDeadline || 0) <= 0) { setMsg(T("arena.closedRound", { n: c.roundId }), "bad"); return; }
  const amtEl = $("ar-amount");
  const amt = murToAtomic(amtEl ? amtEl.value : "");
  if (amt <= 0n) { setMsg(T("arena.enterAmount"), "bad"); return; }
  state.arenaBusy = true; if (btn) btn.disabled = true;
  let finalMsg = "", finalCls = "";
  try {
    const from = await arenaEnsureWallet(setMsg);
    if (!from) return;
    await arenaReadUser();
    if (state.arenaUser && amt > state.arenaUser.balanceRaw) { setMsg(T("arena.exceedsBalance"), "bad"); return; }
    // approve the arena to move this stake first if the allowance doesn't already cover it
    if (!state.arenaUser || state.arenaUser.allowanceRaw < amt) {
      setMsg(T("arena.approve1of2"));
      const ah = await arenaSendTx(d.token, MUR_SEL_APPROVE + wordAddr(d.arenaAddress) + wordUint(amt));
      setMsg(T("arena.approvalSent"));
      const okA = await arenaWaitReceipt(ah);
      if (okA !== true) { setMsg(okA === false ? T("arena.approvalRevert") : T("arena.approvalNotConf"), "bad"); return; }
      await arenaReadUser();
    }
    setMsg(T("arena.betInWallet", { dir: side === ARENA_SIDE_UP ? T("arena.betDirUp") : T("arena.betDirDown") }));
    const bh = await arenaSendTx(d.arenaAddress, ARENA_SEL_BET + wordUint(c.roundId) + wordUint(side) + wordUint(amt));
    setMsg(T("arena.betSentConfirm"));
    const okB = await arenaWaitReceipt(bh);
    if (okB === true) { finalMsg = T("arena.betPlaced", { hash: shortHash(bh) }); finalCls = "ok"; }
    else if (okB === false) { finalMsg = T("arena.betReverted"); finalCls = "bad"; }
    else { finalMsg = T("arena.betSentPending", { hash: shortHash(bh) }); finalCls = ""; }
    setMsg(finalMsg, finalCls);
    state.lastArenaPoll = 0; await pollArena(true);
    if (state.arenaOpen) arenaMsgFn(null)(finalMsg, finalCls);
  } catch (e) { setMsg(arenaErr(e), "bad"); }
  finally { state.arenaBusy = false; if (btn) btn.disabled = false; }
}
export async function arenaClaim(roundId, btn) {
  if (state.arenaBusy) return;
  const setMsg = arenaMsgFn(btn);
  const d = state.arenaData;
  if (!d || !d.enabled || !isRealAddr(d.arenaAddress)) { setMsg(T("arena.unavailableShort"), "bad"); return; }
  state.arenaBusy = true; if (btn) btn.disabled = true;
  let finalMsg = "", finalCls = "";
  try {
    const from = await arenaEnsureWallet(setMsg);
    if (!from) return;
    setMsg(T("arena.claimInWallet"));
    const ch = await arenaSendTx(d.arenaAddress, ARENA_SEL_CLAIM + wordUint(roundId));
    setMsg(T("arena.claimSent"));
    const ok = await arenaWaitReceipt(ch);
    if (ok === true) { finalMsg = T("arena.claimed", { hash: shortHash(ch) }); finalCls = "ok"; }
    else if (ok === false) { finalMsg = T("arena.claimReverted"); finalCls = "bad"; }
    else { finalMsg = T("arena.claimSentPending", { hash: shortHash(ch) }); finalCls = ""; }
    setMsg(finalMsg, finalCls);
    state.lastArenaPoll = 0; await pollArena(true);
    if (state.arenaOpen) arenaMsgFn(null)(finalMsg, finalCls);
  } catch (e) { setMsg(arenaErr(e), "bad"); }
  finally { state.arenaBusy = false; if (btn) btn.disabled = false; }
}
// ---- live payout preview (pure client-side parimutuel math; mirrors PredictionArena._payout) ----
/**
 * Estimate a WINNER's payout for a hypothetical `amtAtomic` on `side`, folding that stake into its own
 * pool first — exactly the contract's integer math: payout = amt + amt*losePool/winPool (floor). Returns
 * atomic MURMUR as a BigInt, or null for a zero/invalid stake or a missing round. Preview only: nothing
 * here is ever sent on-chain, and it drifts as other bettors move the pools between crons.
 */
export function arenaEstPayout(c, side, amtAtomic) {
  if (!c || !(amtAtomic > 0n)) return null;
  const up = BigInt(c.poolUp || "0"), down = BigInt(c.poolDown || "0");
  const amt = amtAtomic;
  const winPool = side === ARENA_SIDE_UP ? up + amt : down + amt;
  const losePool = side === ARENA_SIDE_UP ? down : up;
  if (winPool <= 0n) return null;
  return amt + (amt * losePool) / winPool;
}
/** Fill the bet box from a percentage-of-balance chip (25% / 50% / max), then refresh the preview. */
export function arenaApplyChip(btn) {
  const frac = Number(btn && btn.dataset ? btn.dataset.frac : 0) || 0;
  const bal = Number((state.arenaUser && state.arenaUser.balance) || 0);
  const amtEl = $("ar-amount"); if (!amtEl) return;
  const v = bal * frac;
  amtEl.value = v > 0 ? String(Math.floor(v * 1e4) / 1e4) : "";
  arenaUpdatePreview();
}
/** Repaint the "if you win" line under the bet box from the current amount + the live pools. */
export function arenaUpdatePreview() {
  const el = $("ar-preview"); if (!el) return;
  const c = state.arenaData && state.arenaData.current;
  if (!c || c.resolved || Number(c.secondsToDeadline || 0) <= 0) { el.textContent = ""; return; }
  const amtEl = $("ar-amount");
  const amt = murToAtomic(amtEl ? amtEl.value : "");
  if (amt <= 0n) { el.innerHTML = `<span class="ar-pv-hint">${T("arena.enterAmountHint")}</span>`; return; }
  const staked = Number(amt) / 1e18;
  const cell = (side, cls, arrow) => {
    const pay = arenaEstPayout(c, side, amt);
    if (pay == null) return `<span class="ar-pv ${cls}">${arrow} ${T("arena.pvWin")} <b>\u2013</b></span>`;
    const payMur = Number(pay) / 1e18;
    const mult = staked > 0 ? payMur / staked : 0;
    return `<span class="ar-pv ${cls}">${arrow} ${T("arena.pvWin")} <b>${fmtMur(payMur)}</b> <em>${mult.toFixed(2)}\u00d7 \u00b7 +${fmtMur(payMur - staked)}</em></span>`;
  };
  el.innerHTML = cell(ARENA_SIDE_UP, "up", "\u25b2") + cell(ARENA_SIDE_DOWN, "down", "\u25bc") +
    `<span class="ar-pv-note">${T("arena.pvNote")}</span>`;
}
// ---- render ----
export function paintArena() {
  const body = $("arena-body"); if (!body) return;
  const sub = $("arena-sub");
  const d = state.arenaData;
  if (sub) sub.textContent = d && d.enabled
    ? (d.current ? T("arena.subRound", { n: d.current.roundId, suffix: d.current.resolved ? T("arena.suffixClosed") : T("arena.suffixLive") }) : T("arena.subBetween"))
    : T("arena.subDefault");
  body.innerHTML = "";
  if (!d || !d.enabled) {
    body.innerHTML = `<p class="ar-empty">${T("arena.disabled")}</p>`;
    return;
  }
  body.appendChild(arenaBookCard(d));
  body.appendChild(arenaYouCard(d));
  body.appendChild(arenaVsSwarmCard(d));
  arenaUpdatePreview();
}
/** The live human book: parimutuel UP/DOWN MURMUR pools, implied payout, countdown, entry temp + flat band. */
export function arenaBookCard(d) {
  const card = document.createElement("div"); card.className = "ar-card book";
  const c = d.current;
  const mode = d.armed ? T("arena.modeArmed") : T("arena.modeNotArmed");
  let html =
    `<div class="ar-title">${T("arena.bookTitle")} <span class="ar-mode">${mode}</span></div>` +
    `<p class="ar-blurb">${T("arena.blurb")}</p>`;
  if (!c) {
    html += `<p class="ar-empty">${T("arena.noRound")} ${d.armed ? T("arena.noRoundArmed") : T("arena.noRoundNotArmed")}</p>`;
    card.innerHTML = html; return card;
  }
  const up = Number(c.poolUpMur || 0), down = Number(c.poolDownMur || 0), tot = up + down;
  const upPct = tot > 0 ? (up / tot) * 100 : 50, downPct = tot > 0 ? 100 - upPct : 50;
  const oc = ARENA_OUTCOME[c.outcome] || "";
  const ocLabel = c.outcome ? (T("arena.outcome." + c.outcome) || oc) : "";
  html +=
    `<div class="ar-round">${T("arena.roundLabel")} <b>#${c.roundId}</b> \u00b7 ` +
      (c.resolved
        ? `<span class="ar-outcome ${String(oc).toLowerCase().replace(/[^a-z]/g, "")}">${ocLabel}</span>`
        : `${T("arena.closesIn")} <b id="ar-countdown">${arenaClock(c.secondsToDeadline)}</b>`) +
    `</div>` +
    `<div class="ar-pools">` +
      `<div class="ar-pool up"><span class="ar-side">${T("arena.upSide")}</span><span class="ar-amt">${fmtMur(up)}</span></div>` +
      `<div class="ar-pool down"><span class="ar-side">${T("arena.downSide")}</span><span class="ar-amt">${fmtMur(down)}</span></div>` +
    `</div>` +
    `<div class="ar-bar"><div class="ar-bar-up" style="width:${upPct.toFixed(1)}%"></div><div class="ar-bar-down" style="width:${downPct.toFixed(1)}%"></div></div>` +
    `<div class="ar-odds">` +
      `<div><dt>${T("arena.upPays")}</dt><dd>${Number(c.oddsUp || 0).toFixed(2)}\u00d7</dd><dd class="ar-prob">${(Number(c.probUp || 0) * 100).toFixed(0)}${T("arena.ofPool")}</dd></div>` +
      `<div><dt>${T("arena.downPays")}</dt><dd>${Number(c.oddsDown || 0).toFixed(2)}\u00d7</dd><dd class="ar-prob">${(Number(c.probDown || 0) * 100).toFixed(0)}${T("arena.ofPool")}</dd></div>` +
    `</div>` +
    `<dl class="ar-meta">` +
      `<div><dt>${T("arena.entryTemp")}</dt><dd>${Number(c.entryTemp || 0).toFixed(3)}</dd></div>` +
      `<div><dt>${c.resolved ? T("arena.exitTemp") : T("arena.window")}</dt><dd>${c.resolved ? Number(c.exitTemp || 0).toFixed(3) : arenaClock(c.secondsToDeadline)}</dd></div>` +
      `<div><dt>${T("arena.flatBand")}</dt><dd>\u00b1${Number(c.flatBand || 0).toFixed(3)}</dd></div>` +
      `<div><dt>${T("arena.bettors")}</dt><dd>${c.bettorCount || 0}</dd></div>` +
    `</dl>`;
  if (isRealAddr(d.arenaAddress)) {
    html += `<div class="ar-contract">${T("arena.contract")} <a class="fp" href="${ARC_EXPLORER}/address/${d.arenaAddress}" target="_blank" rel="noopener noreferrer">${shortHash(d.arenaAddress)}</a></div>`;
  }
  card.innerHTML = html;
  return card;
}
/** Your position: connect, see your MURMUR + allowance, bet UP/DOWN, and claim any winnings. */
export function arenaYouCard(d) {
  const card = document.createElement("div"); card.className = "ar-card you";
  const c = d.current;
  let html =
    `<div class="ar-title">${T("arena.youTitle")}</div>` +
    `<p class="ar-blurb">${T("arena.youBlurb")}</p>`;
  if (!state.arenaAcct) {
    html += `<div class="ar-actions"><button type="button" class="ar-btn connect">${T("arena.connectBtn")}</button></div><div class="ar-status"></div>`;
    card.innerHTML = html; return card;
  }
  const u = state.arenaUser || {};
  const live = c && !c.resolved && Number(c.secondsToDeadline || 0) > 0;
  const yourSide = u.side === ARENA_SIDE_UP ? T("arena.yourSideUp") : u.side === ARENA_SIDE_DOWN ? T("arena.yourSideDown") : null;
  html +=
    `<dl class="ar-you-meta">` +
      `<div><dt>${T("arena.wallet")}</dt><dd class="fp">${shortHash(state.arenaAcct)}</dd></div>` +
      `<div><dt>MURMUR</dt><dd>${fmtMur(u.balance || 0, 4)}</dd></div>` +
      `<div><dt>${T("arena.approved")}</dt><dd>${fmtMur(u.allowance || 0, 2)}</dd></div>` +
    `</dl>`;
  if (yourSide) {
    html += `<div class="ar-yourbet">${T("arena.thisRoundYou", { cls: u.side === ARENA_SIDE_UP ? "up" : "down", side: yourSide, amt: fmtMur(u.amount || 0, 2) })}</div>`;
  }
  if (live) {
    html +=
      `<div class="ar-betrow">` +
        `<input class="ar-amount" id="ar-amount" type="number" min="0" step="any" placeholder="${T("arena.amountPh")}" inputmode="decimal" />` +
        `<span class="ar-unit">MURMUR</span>` +
      `</div>` +
      `<div class="ar-chips">` +
        `<button type="button" class="ar-chip" data-frac="0.25">25%</button>` +
        `<button type="button" class="ar-chip" data-frac="0.5">50%</button>` +
        `<button type="button" class="ar-chip" data-frac="1">${T("arena.chipMax")}</button>` +
      `</div>` +
      `<div class="ar-preview" id="ar-preview"></div>` +
      `<div class="ar-actions">` +
        `<button type="button" class="ar-btn up" data-side="${ARENA_SIDE_UP}">${T("arena.betUp")}</button>` +
        `<button type="button" class="ar-btn down" data-side="${ARENA_SIDE_DOWN}">${T("arena.betDown")}</button>` +
      `</div>` +
      `<div class="ar-fine">${T("arena.fine")}</div>`;
  } else if (c && c.resolved) {
    const outLabel = (ARENA_OUTCOME[c.outcome] && T("arena.outcome." + c.outcome)) || T("arena.flatDefault");
    html += `<div class="ar-closed">${T("arena.roundClosed", { n: c.roundId, outcome: outLabel })}</div>`;
  } else {
    html += `<div class="ar-closed">${T("arena.noLiveWindow")}</div>`;
  }
  if (Array.isArray(u.claims) && u.claims.length) {
    html += `<div class="ar-actions">` + u.claims.map((cl) =>
      `<button type="button" class="ar-btn claim" data-claim="${cl.roundId}">${T("arena.claimBtn", { n: cl.roundId, amt: fmtMur(cl.payout, 2) })}</button>`
    ).join("") + `</div>`;
  }
  html += `<div class="ar-status"></div>`;
  card.innerHTML = html;
  return card;
}
/** You vs the swarm: the flies' lifetime hit-rate against the human crowd's lean + last-round result. */
export function arenaVsSwarmCard(d) {
  const card = document.createElement("div"); card.className = "ar-card vs";
  const s = d.swarm, c = d.current, prev = d.previous;
  let html =
    `<div class="ar-title">${T("arena.vsTitle")}</div>` +
    `<p class="ar-blurb">${T("arena.vsBlurb")}</p>`;
  const hr = s ? Number(s.hitRate) * 100 : null;
  const crowdHasBets = c && (Number(c.probUp || 0) + Number(c.probDown || 0)) > 0;
  const lean = crowdHasBets
    ? (Number(c.probUp) >= Number(c.probDown)
        ? T("arena.leanUp", { pct: Math.round(Number(c.probUp) * 100) })
        : T("arena.leanDown", { pct: Math.round(Number(c.probDown) * 100) }))
    : T("arena.noBets");
  html += `<div class="ar-vs-row">` +
    `<div class="ar-vs swarm"><span class="ar-vs-label">${T("arena.swarmLabel")}</span><span class="ar-vs-big">${hr == null ? "\u2013" : hr.toFixed(0) + "%"}</span><span class="ar-vs-sub">${s ? T("arena.swarmSub", { hits: s.hits, rounds: s.rounds, n: s.bettors }) : T("arena.accruing")}</span></div>` +
    `<div class="ar-vs human"><span class="ar-vs-label">${T("arena.humansLabel")}</span><span class="ar-vs-big">${lean}</span><span class="ar-vs-sub">${c ? T("arena.humansSub", { amt: fmtMur(Number(c.totalMur || 0), 0), n: c.bettorCount || 0 }) : "\u2013"}</span></div>` +
  `</div>`;
  if (prev && prev.resolved) {
    const oc = ARENA_OUTCOME[prev.outcome] || "?";
    const ocLabel = T("arena.outcome." + prev.outcome) || oc;
    const crowdUp = Number(prev.probUp || 0) >= Number(prev.probDown || 0);
    const flat = prev.outcome === 3 || prev.outcome === 4;
    const crowdWon = (prev.outcome === 1 && crowdUp) || (prev.outcome === 2 && !crowdUp);
    const suffix = flat ? T("arena.everyoneRefunded") : crowdWon ? T("arena.crowdCalledIt") : T("arena.crowdMissed");
    html += `<div class="ar-last">${T("arena.lastRound", { n: prev.roundId, cls: String(oc).toLowerCase().replace(/[^a-z]/g, ""), outcome: ocLabel })} ${suffix}</div>`;
  }
  card.innerHTML = html;
  return card;
}

// ══════════════════════════════════════════════════════════════════════════════
// ㉙ THE TEMPLE — burn MURMUR to intervene in the swarm's fate.
//
// Every other membrane is a read-out; the temple is the one door that opens the
// other way, and it opens only for FIRE. A holder sends MURMUR to 0x…dEaD —
// provably, irreversibly GONE — and submits the tx hash; the Worker re-reads that
// hash on-chain (keyless, read-only) and only a real burn clearing the tier minimum
// enters the queue. This drawer mirrors the arena's wallet plumbing but BURNS instead
// of betting: a plain ERC-20 transfer to the sink (no approve, no contract call),
// then POST /temple with the hash. All state lives in `state.temple*` (shared.js).
// ══════════════════════════════════════════════════════════════════════════════

/** The canonical ERC-20 burn sink — tokens sent here are provably unspendable (mirrors temple.ts). */
export const TEMPLE_BURN_ADDRESS = "0x000000000000000000000000000000000000dEaD";
/** MURMUR on Arc mainnet (18 dec) — the only token a temple burn counts in (mirrors temple.ts). */
export const TEMPLE_MURMUR = "0x8faae5592b9acc27a79fca745c6b872adf514a5d";
/** transfer(address,uint256) — a burn is a plain transfer to the sink. */
export const TEMPLE_SEL_TRANSFER = "0xa9059cbb";
/** Arc mainnet chain id (the temple burns on mainnet). */
export const TEMPLE_CHAIN_ID = 5042;
/** tier → the minimum MURMUR (whole units) a burn must clear (mirrors temple.ts TIER_MINIMUMS). */
export const TEMPLE_TIER_MIN = [0, 1000, 10000, 100000, 1000000];

/**
 * The twelve interventions, laddered by cost (mirrors temple.ts KIND_TIER). `params` drives the
 * input rows the drawer renders; `cost`/`desc`/`name` are display-only English labels.
 */
export const TEMPLE_KINDS = [
  { kind: "ORACLE_WHISPER",     tier: 1, name: "Oracle Whisper",       cost: "1,000+",     desc: "Send a divine whisper to a specific fly",                 params: ["flyId", "direction"] },
  { kind: "CULTURAL_SEED",      tier: 1, name: "Cultural Seed",        cost: "1,000+",     desc: "Plant a sacred meme in the collective mind",              params: ["flyId", "text"] },
  { kind: "DIRECTED_MUTATION",  tier: 2, name: "Directed Mutation",    cost: "10,000+",    desc: "Rewrite a fly's genome along a chosen path",              params: ["flyId", "path"] },
  { kind: "MIRACLE_HARVEST",    tier: 2, name: "Miracle: Harvest",     cost: "10,000+",    desc: "Bless all citizens with a small windfall",                params: [] },
  { kind: "MIRACLE_PLAGUE",     tier: 2, name: "Miracle: Plague",      cost: "10,000+",    desc: "Strike down a random citizen by divine will",             params: [] },
  { kind: "MIRACLE_REVELATION", tier: 2, name: "Miracle: Revelation",  cost: "10,000+",    desc: "Grant an immediate technological discovery",              params: [] },
  { kind: "MIRACLE_MIGRATION",  tier: 2, name: "Miracle: Migration",   cost: "10,000+",    desc: "Carry 3 citizens to new lands",                           params: [] },
  { kind: "NATION_BLESSING",    tier: 2, name: "Nation's Blessing",    cost: "10,000+",    desc: "Bless a nation with divine productivity (12 cycles)",     params: ["nationId"] },
  { kind: "DIVINE_DECREE",      tier: 3, name: "Divine Decree",        cost: "100,000+",   desc: "Override the assembly with celestial law",                params: ["creditCap", "iouRate"] },
  { kind: "HERO_SUMMONING",     tier: 3, name: "Hero Summoning",       cost: "100,000+",   desc: "Summon a named hero into the world",                      params: ["heroName"] },
  { kind: "EPOCH_SHAPING",      tier: 4, name: "Epoch Shaping",        cost: "1,000,000+", desc: "Forge a new epoch with your chosen name and regime",      params: ["epochName", "regime"] },
  { kind: "WONDER_FOUNDATION",  tier: 4, name: "Wonder Foundation",    cost: "1,000,000+", desc: "Erect an eternal wonder in a nation",                     params: ["nationId", "wonderType"] },
];

/** Per-param input metadata (label, control type, options). Technical field labels stay English. */
export const TEMPLE_PARAMS = {
  flyId:      { label: "Fly ID",        type: "number", ph: "e.g. 7" },
  direction:  { label: "Direction",     type: "select", opts: [["up", "Up \u25b2"], ["down", "Down \u25bc"]] },
  text:       { label: "Meme",          type: "text",   ph: "a sacred meme (\u2264 32)" },
  path:       { label: "Mutation path", type: "select", opts: [["longevity", "Longevity"], ["intelligence", "Intelligence"], ["trading", "Trading"], ["aggression", "Aggression"]] },
  nationId:   { label: "Nation ID",     type: "number", ph: "e.g. 2" },
  creditCap:  { label: "Credit cap",    type: "number", ph: "USDC" },
  iouRate:    { label: "IOU rate",      type: "number", ph: "e.g. 0.05" },
  heroName:   { label: "Hero name",     type: "text",   ph: "a name (\u2264 24)" },
  epochName:  { label: "Epoch name",    type: "text",   ph: "a name (\u2264 32)" },
  regime:     { label: "Regime",        type: "select", opts: [["HOT", "Hot"], ["CALM", "Calm"], ["COLD", "Cold"]] },
  wonderType: { label: "Wonder",        type: "select", opts: [["babel", "Babel"], ["library", "Library"], ["arena", "Arena"], ["lifetree", "Life Tree"], ["market", "Market"]] },
};

// ---- drawer lifecycle (mutually exclusive with the other eleven right-edge sheets) ----
export function openTemple() {
  state.templeOpen = true;
  if (state.chronOpen) closeChron();
  if (state.canaryOpen) closeCanary();
  if (state.laureateOpen) closeLaureate();
  if (state.walletsOpen) closeWallets();
  if (state.historyOpen) closeHistory();
  if (state.proofsOpen) closeProofs();
  if (state.brainOpen) closeBrain();
  if (state.lineageOpen) closeLineage();
  if (state.pulseOpen) closePulse();
  if (state.predictOpen) closePredict();
  if (state.arenaOpen) closeArena();
  const d = $("temple"); if (!d) return;
  d.hidden = false;
  document.body.classList.add("temple-open");
  requestAnimationFrame(() => d.classList.add("open"));
  renderTemple();
}
export function closeTemple() {
  state.templeOpen = false;
  document.body.classList.remove("temple-open");
  const d = $("temple"); if (!d) return;
  d.classList.remove("open");
  setTimeout(() => { if (!state.templeOpen) d.hidden = true; }, 420);
}
export function toggleTemple() { if (state.templeOpen) closeTemple(); else openTemple(); }

export async function renderTemple() {
  const body = $("temple-body"); if (!body) return;
  body.innerHTML = `<p class="tp-empty">${T("temple.loading")}</p>`;
  const res = await getJSON("/temple", 8000).catch(() => null);
  if (!state.templeOpen) return;                 // closed while fetching
  state.templeData = res || null;
  await templeReadBalance();
  if (!state.templeOpen) return;
  paintTemple();
}

/** Read the connected wallet's MURMUR balance straight off Arc (browser → RPC, no server). */
export async function templeReadBalance() {
  const d = state.templeData || {};
  const token = isRealAddr(d.token) ? d.token : TEMPLE_MURMUR;
  if (!state.templeAcct || !isRealAddr(token)) { state.templeBal = null; return; }
  try {
    const bal = await arcRpc("eth_call", [{ to: token, data: MUR_SEL_BALANCE + wordAddr(state.templeAcct) }, "latest"]);
    state.templeBal = BigInt(bal || "0x0");
  } catch { state.templeBal = null; }
}

// ---- wallet plumbing (mirrors arenaEnsureWallet, but the temple only needs the right chain) ----
export async function templeEnsureWallet(setMsg, chainId) {
  if (!window.ethereum) { setMsg(T("temple.noWallet"), "bad"); return null; }
  const accts = await window.ethereum.request({ method: "eth_requestAccounts" });
  const from = Array.isArray(accts) && accts[0];
  if (!from) { setMsg(T("temple.walletFailed"), "bad"); return null; }
  const cid = Number(chainId || TEMPLE_CHAIN_ID);
  const chainHex = "0x" + cid.toString(16);
  const cur = await window.ethereum.request({ method: "eth_chainId" });
  if (String(cur).toLowerCase() !== chainHex.toLowerCase()) {
    setMsg(T("temple.switchArc"));
    const testnet = cid !== 5042;
    try {
      await window.ethereum.request({ method: "wallet_switchEthereumChain", params: [{ chainId: chainHex }] });
    } catch (swErr) {
      if (swErr && (swErr.code === 4902 || /Unrecognized chain ID/i.test(String(swErr.message)))) {
        await window.ethereum.request({
          method: "wallet_addEthereumChain",
          params: [{
            chainId: chainHex, chainName: testnet ? "Arc Testnet" : "Arc",
            nativeCurrency: { name: "USDC", symbol: "USDC", decimals: 18 },
            rpcUrls: testnet ? ["https://rpc.testnet.arc.io"] : ["https://rpc.mainnet.arc.io"],
            blockExplorerUrls: ["https://explorer.arc.io"],
          }],
        });
      } else { throw swErr; }
    }
  }
  state.templeAcct = from.toLowerCase();
  return from;
}

/** The status writer for the temple body (single .tp-status line, mirrors arenaMsgFn). */
export function templeMsgFn() {
  const status = document.querySelector("#temple-body .tp-status");
  return (m, cls) => { if (status) { status.textContent = m || ""; status.className = "tp-status" + (cls ? " " + cls : ""); } };
}

// ---- actions ----
export async function templeConnect(btn) {
  if (state.templeBusy) return;
  const setMsg = templeMsgFn();
  state.templeBusy = true; if (btn) btn.disabled = true;
  try {
    setMsg(T("temple.connecting"));
    const d = state.templeData || {};
    const from = await templeEnsureWallet(setMsg, Number(d.chainId || TEMPLE_CHAIN_ID));
    if (!from) return;
    await templeReadBalance();
    if (!state.templeOpen) return;
    paintTemple();
    templeMsgFn()(T("temple.connected") + " \u00b7 " + shortHash(from), "ok");
  } catch (e) { setMsg(arenaErr(e), "bad"); }
  finally { state.templeBusy = false; if (btn) btn.disabled = false; }
}

export function templeSelectKind(kind) {
  const spec = TEMPLE_KINDS.find((k) => k.kind === kind);
  if (!spec) return;
  state.templeSelected = { kind: spec.kind, tier: spec.tier };
  paintTemple();
}

/** Gather the param inputs for the selected kind, adding the alias keys temple.ts reads. */
function templeCollectParams(kind) {
  const spec = TEMPLE_KINDS.find((k) => k.kind === kind);
  const out = {};
  if (!spec) return out;
  for (const p of spec.params) {
    const el = document.querySelector(`#temple-body [data-param="${p}"]`);
    if (!el) continue;
    const v = String(el.value == null ? "" : el.value).trim();
    if (!v) continue;
    const meta = TEMPLE_PARAMS[p];
    out[p] = meta && meta.type === "number" ? Number(v) : v;
  }
  // temple.ts reads p.name for hero/epoch and p.wonder for a wonder — mirror the aliases
  if (out.heroName != null) out.name = out.heroName;
  if (out.epochName != null) out.name = out.epochName;
  if (out.wonderType != null) out.wonder = out.wonderType;
  return out;
}

/**
 * The burn: send the tier-minimum MURMUR to 0x…dEaD (a plain transfer — the tokens are gone the
 * moment the tx lands), wait for the receipt, then POST the hash to /temple for on-chain verify.
 */
export async function templeBurn(btn) {
  if (state.templeBusy) return;
  const setMsg = templeMsgFn();
  const sel = state.templeSelected;
  if (!sel) { setMsg(T("temple.selectKind"), "bad"); return; }
  if (!state.templeAcct) { setMsg(T("temple.noWalletHint"), "bad"); return; }
  const d = state.templeData || {};
  const token = isRealAddr(d.token) ? d.token : TEMPLE_MURMUR;
  const sink = isRealAddr(d.burnAddress) ? d.burnAddress : TEMPLE_BURN_ADDRESS;
  const chainId = Number(d.chainId || TEMPLE_CHAIN_ID);
  const minBurn = TEMPLE_TIER_MIN[sel.tier] || 1000;
  const burnAtomic = murToAtomic(String(minBurn));
  if (state.templeBal != null && burnAtomic > state.templeBal) { setMsg(T("temple.insufficient"), "bad"); return; }
  state.templeBusy = true; if (btn) btn.disabled = true;
  let finalMsg = "", finalCls = "";
  try {
    const from = await templeEnsureWallet(setMsg, chainId);
    if (!from) return;
    const params = templeCollectParams(sel.kind);
    const data = TEMPLE_SEL_TRANSFER + wordAddr(sink) + wordUint(burnAtomic);
    setMsg(T("temple.burnConfirm"));
    const txHash = await window.ethereum.request({
      method: "eth_sendTransaction",
      params: [{ from: state.templeAcct, to: token, data, value: "0x0" }],
    });
    setMsg(T("temple.txWaiting"));
    const ok = await arenaWaitReceipt(txHash);
    if (ok !== true) {
      setMsg(ok === false ? T("temple.txFailed") : T("temple.failed", { msg: shortHash(txHash) + " \u2026" }), "bad");
      return;
    }
    setMsg(T("temple.verifying"));
    const r = await fetch(API + "/temple", {
      method: "POST", cache: "no-store", headers: { "content-type": "application/json" },
      body: JSON.stringify({ txHash, kind: sel.kind, params, address: state.templeAcct }),
    });
    const result = await r.json().catch(() => ({}));
    if (result && result.ok) {
      finalMsg = T("temple.queued", { pos: result.queuePosition, tier: result.tier || sel.tier, burned: fmtMur(minBurn, 0) });
      finalCls = "ok";
      state.templeSelected = null;
      state.lastTemplePoll = 0;
      const fresh = await getJSON("/temple", 8000).catch(() => null);
      if (fresh) state.templeData = fresh;
      await templeReadBalance();
      if (state.templeOpen) paintTemple();
    } else {
      finalMsg = T("temple.failed", { msg: (result && result.error) || "unknown" });
      finalCls = "bad";
    }
    setMsg(finalMsg, finalCls);
  } catch (e) { setMsg(arenaErr(e), "bad"); }
  finally { state.templeBusy = false; if (btn) btn.disabled = false; }
}

// ---- render ----
export function paintTemple() {
  const body = $("temple-body"); if (!body) return;
  const sub = $("temple-sub"); if (sub) sub.textContent = T("temple.sub");
  const d = state.templeData || {};
  const canBurn = !!state.templeAcct && !!state.templeSelected && !state.templeBusy;
  let html = "";
  html += templeWalletRow(d);
  html += templeKindGrid();
  html += templeParamsArea();
  html += `<button type="button" class="tp-burn-btn"${canBurn ? "" : " disabled"}>${T("temple.burn")}</button>`;
  html += `<div class="tp-status"></div>`;
  html += templeQueueCard(d);
  html += templeHistoryCard(d);
  html += templeWondersHeroes(d);
  body.innerHTML = html;
}

function templeTotalBurned(d) {
  const ro = d.readout || d;
  if (ro.totalBurned == null) return null;
  try { return Number(BigInt(String(ro.totalBurned))) / 1e18; } catch { return null; }
}

function templeWalletRow(d) {
  const total = templeTotalBurned(d);
  let html = `<div class="tp-section"><div class="tp-wallet-row">`;
  if (!state.templeAcct) {
    html += `<button type="button" class="tp-connect-btn">${T("temple.connect")}</button>` +
      `<span class="tp-wallet-bal">${T("temple.noWalletHint")}</span>`;
  } else {
    const bal = state.templeBal != null ? fmtMur(Number(state.templeBal) / 1e18, 2) : "\u2013";
    html += `<span class="tp-wallet-addr fp">${shortHash(state.templeAcct)}</span>` +
      `<span class="tp-wallet-bal">${T("temple.balance")}: ${bal} MURMUR</span>` +
      `<button type="button" class="tp-connect-btn">${T("temple.connected")}</button>`;
  }
  html += `</div>`;
  if (total != null) html += `<div class="tp-wallet-bal">\ud83d\udd25 ${fmtMur(total, 0)} MURMUR</div>`;
  return html + `</div>`;
}

function templeKindGrid() {
  let html = "";
  for (let tier = 1; tier <= 4; tier++) {
    const kinds = TEMPLE_KINDS.filter((k) => k.tier === tier);
    if (!kinds.length) continue;
    html += `<div class="tp-tier-label">${T("temple.tier" + tier)} \u00b7 ${T("temple.minBurn", { n: fmtMur(TEMPLE_TIER_MIN[tier], 0) })}</div>`;
    html += `<div class="tp-tier-grid">`;
    for (const k of kinds) {
      const selected = state.templeSelected && state.templeSelected.kind === k.kind;
      const icon = CHRON_ICONS[k.kind] || "\u2726";
      html += `<div class="tp-card${selected ? " selected" : ""}" data-kind="${k.kind}" role="button" tabindex="0">` +
        `<div class="tp-card-name">${icon} ${escapeHtml(k.name)}</div>` +
        `<div class="tp-card-cost">${escapeHtml(k.cost)} MURMUR</div>` +
        `<div class="tp-card-desc">${escapeHtml(k.desc)}</div>` +
      `</div>`;
    }
    html += `</div>`;
  }
  return html;
}

function templeParamsArea() {
  const sel = state.templeSelected;
  if (!sel) return `<div class="tp-section"><p class="tp-empty">${T("temple.selectKind")}</p></div>`;
  const spec = TEMPLE_KINDS.find((k) => k.kind === sel.kind);
  if (!spec || !spec.params.length) return "";
  let html = `<div class="tp-section"><div class="tp-section-title">${escapeHtml(spec.name)}</div><div class="tp-params">`;
  for (const p of spec.params) {
    const meta = TEMPLE_PARAMS[p] || { label: p, type: "text" };
    html += `<div class="tp-param-row"><label class="tp-param-label">${escapeHtml(meta.label)}</label>`;
    if (meta.type === "select") {
      html += `<select class="tp-param-select" data-param="${p}">` +
        meta.opts.map((o) => `<option value="${escapeHtml(o[0])}">${escapeHtml(o[1])}</option>`).join("") + `</select>`;
    } else {
      html += `<input class="tp-param-input" data-param="${p}" type="${meta.type === "number" ? "number" : "text"}" step="any" placeholder="${escapeHtml(meta.ph || "")}" />`;
    }
    html += `</div>`;
  }
  return html + `</div></div>`;
}

function templeQueueCard(d) {
  const q = Array.isArray(d.queue) ? d.queue : [];
  let html = `<div class="tp-section"><div class="tp-section-title">${T("temple.queue")} (${q.length})</div>`;
  if (!q.length) return html + `<p class="tp-empty">${T("temple.emptyQueue")}</p></div>`;
  html += `<div class="tp-history">` + q.map((e, i) => templeQueueRow(e, i)).join("") + `</div>`;
  return html + `</div>`;
}

function templeQueueRow(e, i) {
  const icon = CHRON_ICONS[e.kind] || "\u2726";
  return `<div class="tp-queue-row"><span class="tp-queue-pos">${i + 1}</span>` +
    `<span class="tp-ico">${icon}</span><span class="tp-hist-kind">${escapeHtml(String(e.kind))}</span>` +
    `<span class="tp-hist-addr fp">${e.address ? shortHash(e.address) : ""}</span></div>`;
}

function templeHistoryCard(d) {
  const ro = d.readout || d;
  const h = Array.isArray(d.history) ? d.history : (Array.isArray(ro.history) ? ro.history : []);
  let html = `<div class="tp-section"><div class="tp-section-title">${T("temple.history")}</div>`;
  if (!h.length) return html + `<p class="tp-empty">${T("temple.emptyHistory")}</p></div>`;
  html += `<div class="tp-history">` + h.slice().reverse().slice(0, 20).map(templeHistItem).join("") + `</div>`;
  return html + `</div>`;
}

function templeHistItem(e) {
  const icon = CHRON_ICONS[e.kind] || "\u2726";
  let burned = "";
  if (e.burnAmount != null) { try { burned = fmtMur(Number(BigInt(String(e.burnAmount))) / 1e18, 0); } catch { burned = ""; } }
  return `<div class="tp-hist-item">` +
    `<span class="tp-hist-kind">${icon} ${escapeHtml(String(e.kind))}</span>` +
    (burned ? ` <span class="tp-hist-addr">\ud83d\udd25 ${burned}</span>` : "") +
    (e.tier ? ` <span class="tp-hist-addr">T${e.tier}</span>` : "") +
    `<div class="tp-hist-addr fp">${e.address ? shortHash(e.address) : ""}</div>` +
  `</div>`;
}

function templeWondersHeroes(d) {
  const ro = d.readout || d;
  const heroes = Array.isArray(ro.heroes) ? ro.heroes : [];
  const wonders = ro.wonders && typeof ro.wonders === "object" ? ro.wonders : {};
  const wKeys = Object.keys(wonders);
  if (!heroes.length && !wKeys.length) return "";
  let html = "";
  if (wKeys.length) {
    html += `<div class="tp-section"><div class="tp-section-title">${T("temple.wonders")}</div>`;
    for (const nid of wKeys) {
      html += `<div class="tp-wonder-row"><span class="tp-ico">\ud83c\udfdb</span>` +
        `<span>${escapeHtml(String(wonders[nid]))}</span>` +
        `<span class="tp-hist-addr">nation ${escapeHtml(nid)}</span></div>`;
    }
    html += `</div>`;
  }
  if (heroes.length) {
    html += `<div class="tp-section"><div class="tp-section-title">${T("temple.heroes")}</div>`;
    for (const h of heroes.slice(-20).reverse()) {
      html += `<div class="tp-hero-row"><span class="tp-ico">\ud83e\uddb8</span>` +
        `<span>${escapeHtml(h.name || ("#" + h.flyId))}</span>` +
        `<span class="tp-hist-addr fp">${h.summoner ? shortHash(h.summoner) : ""}</span></div>`;
    }
    html += `</div>`;
  }
  return html;
}
