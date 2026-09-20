// community.js — the front-end for muros.live/community (token-gated governance forum).
//
// Browsing is free and keyless: on boot we read the live config + the plaza feed + proposals and render
// them. To speak / propose / vote we connect an injected wallet (window.ethereum), switch it to Arc, sign an
// EIP-712 message and POST it. The server re-verifies the signature AND re-reads the on-chain MURMUR balance,
// so every gate check here is UX only — never a security boundary. This module is self-contained on purpose:
// it does NOT import or mutate app.js, keeping the main site's risk surface untouched.

const API = "https://api.muros.live";

// Live config from GET /community (chainId, token, thresholds). Populated in boot().
let CFG = null;
let ACCOUNT = null;   // connected wallet address (as returned by the wallet)
let GATE = null;      // last GET /community/gate result

// Feed pagination state.
let feedBefore = null;
let feedItems = [];
let propStatus = "";

// ============================== tiny helpers ==============================

const $ = (id) => document.getElementById(id);

function esc(s) {
  return String(s == null ? "" : s).replace(/[&<>"']/g, (c) => (
    { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]
  ));
}

/** Trim a decimal string (e.g. a formatUnits value) to `dp` places with thousands separators. */
function trimNum(s, dp = 2) {
  if (s == null) return "0";
  let str = String(s);
  const neg = str.startsWith("-");
  if (neg) str = str.slice(1);
  const parts = str.split(".");
  let i = parts[0].replace(/^0+(?=\d)/, "");
  let f = parts[1] || "";
  if (dp > 0 && f) { f = f.slice(0, dp); if (Number(f) === 0) f = ""; } else { f = ""; }
  const grouped = i.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return (neg ? "-" : "") + grouped + (f ? "." + f : "");
}

/** Percentage (0..100, 2dp) of `part` over `total`, both raw decimal strings — BigInt so huge values are exact. */
function pct(part, total) {
  try {
    const p = BigInt(part || "0");
    const t = BigInt(total || "0");
    if (t === 0n) return 0;
    return Number((p * 10000n) / t) / 100;
  } catch {
    return 0;
  }
}

function shortAddr(a) {
  if (typeof a !== "string" || a.length < 10) return a || "";
  return a.slice(0, 6) + "…" + a.slice(-4);
}

function timeAgo(ts) {
  const s = Math.max(0, Math.floor((Date.now() - Number(ts)) / 1000));
  if (s < 60) return s + "s ago";
  if (s < 3600) return Math.floor(s / 60) + "m ago";
  if (s < 86400) return Math.floor(s / 3600) + "h ago";
  return Math.floor(s / 86400) + "d ago";
}

function timeLeft(deadline) {
  const s = Math.floor((Number(deadline) - Date.now()) / 1000);
  if (s <= 0) return "closed";
  if (s < 3600) return Math.max(1, Math.floor(s / 60)) + "m left";
  if (s < 86400) return Math.floor(s / 3600) + "h left";
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  return d + "d " + h + "h left";
}

function setStatus(msg, cls) {
  const el = $("compose-status");
  el.textContent = msg || "";
  el.className = "status" + (cls ? " " + cls : "");
}

// ============================== HTTP ==============================

async function apiGet(path) {
  const r = await fetch(API + path);
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || "HTTP " + r.status);
  return j;
}

async function apiPost(path, body) {
  const r = await fetch(API + path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || "HTTP " + r.status);
  return j;
}

// ============================== EIP-712 (mirrors src/community.ts) ==============================

// The domain has NO verifyingContract, so EIP712Domain declares exactly name/version/chainId — the worker's
// recoverTypedDataAddress builds the identical domain separator from cfg.community.chainId.
const DOMAIN_TYPE = [
  { name: "name", type: "string" },
  { name: "version", type: "string" },
  { name: "chainId", type: "uint256" },
];
const TYPES = {
  Post: [
    { name: "author", type: "address" },
    { name: "body", type: "string" },
    { name: "proposalId", type: "uint256" },
    { name: "ts", type: "uint256" },
  ],
  Propose: [
    { name: "author", type: "address" },
    { name: "title", type: "string" },
    { name: "body", type: "string" },
    { name: "ts", type: "uint256" },
  ],
  Vote: [
    { name: "author", type: "address" },
    { name: "proposalId", type: "uint256" },
    { name: "choice", type: "uint256" },
    { name: "ts", type: "uint256" },
  ],
};

function eip712Domain() {
  return { name: "murmur community", version: "1", chainId: Number(CFG.chainId) };
}

// uint256 message fields go as decimal strings (wallets encode them by value; the worker recovers with BigInt).
const postMsg = (author, body, proposalId, ts) => ({ author, body, proposalId: String(proposalId), ts: String(ts) });
const proposeMsg = (author, title, body, ts) => ({ author, title, body, ts: String(ts) });
const voteMsg = (author, proposalId, choice, ts) => ({ author, proposalId: String(proposalId), choice: String(choice), ts: String(ts) });

async function signTyped(primaryType, message) {
  const typed = {
    types: { EIP712Domain: DOMAIN_TYPE, [primaryType]: TYPES[primaryType] },
    primaryType,
    domain: eip712Domain(),
    message,
  };
  return await window.ethereum.request({
    method: "eth_signTypedData_v4",
    params: [ACCOUNT, JSON.stringify(typed)],
  });
}

/** Connect (if needed) and make sure the wallet is on Arc — mirrors the main site's flow, self-contained. */
async function ensureWallet() {
  if (!window.ethereum) throw new Error("no wallet found — install MetaMask to participate");
  const accts = await window.ethereum.request({ method: "eth_requestAccounts" });
  const from = Array.isArray(accts) && accts[0];
  if (!from) throw new Error("no account selected");

  const chainId = Number(CFG.chainId);
  const chainHex = "0x" + chainId.toString(16);
  const cur = await window.ethereum.request({ method: "eth_chainId" });
  if (String(cur).toLowerCase() !== chainHex.toLowerCase()) {
    const testnet = chainId !== 5042;
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
      } else {
        throw swErr;
      }
    }
  }
  return from;
}

async function connect() {
  if (!CFG) { setStatus("config not loaded yet", "bad"); return; }
  try {
    setStatus("connecting wallet…");
    ACCOUNT = await ensureWallet();
    const btn = $("connect-btn");
    btn.textContent = shortAddr(ACCOUNT);
    btn.classList.add("connected");
    await loadGate();
    setStatus("");
  } catch (e) {
    ACCOUNT = null;
    GATE = null;
    renderGate();
    const msg = (e && (e.message || e.code)) ? (e.message || String(e.code)) : String(e);
    setStatus(/reject|denied/i.test(msg) ? "connection rejected in wallet" : msg, "bad");
  }
}

async function loadGate() {
  if (!ACCOUNT) return;
  try {
    GATE = await apiGet("/community/gate?address=" + encodeURIComponent(ACCOUNT));
  } catch {
    GATE = null;
  }
  renderGate();
}

/** Run a gated action: ensure wallet + the client-side threshold, then fn(). Server re-checks authoritatively. */
async function withWallet(fn, need) {
  try {
    if (!ACCOUNT) await connect();
    if (!ACCOUNT) return;
    if (need === "propose") {
      if (GATE && !GATE.canPropose) {
        setStatus(`you need ≥ ${trimNum(CFG.proposeMinFmt)} MURMUR to propose (you have ${trimNum((GATE && GATE.balanceFmt) || "0")})`, "bad");
        return;
      }
    } else {
      if (GATE && !GATE.canSpeak) {
        setStatus(`you need ≥ ${trimNum(CFG.speakMinFmt)} MURMUR to speak/vote (you have ${trimNum((GATE && GATE.balanceFmt) || "0")})`, "bad");
        return;
      }
    }
    await fn();
  } catch (e) {
    const msg = (e && (e.message || e.code)) ? (e.message || String(e.code)) : String(e);
    if (/reject|denied/i.test(msg)) setStatus("rejected in wallet", "bad");
    else setStatus(msg, "bad");
  }
}

// ============================== actions ==============================

async function doSpeak() {
  const body = $("speak-body").value.trim();
  if (!body) { setStatus("write something first", "bad"); return; }
  await withWallet(async () => {
    setStatus("sign in your wallet… (gasless)");
    const ts = Date.now();
    const sig = await signTyped("Post", postMsg(ACCOUNT, body, 0, ts));
    setStatus("posting…");
    await apiPost("/community/post", { author: ACCOUNT, body, proposalId: 0, ts, sig });
    $("speak-body").value = "";
    updateSpeakCount();
    setStatus("posted ✓", "good");
    await Promise.all([loadFeed(true), loadGate()]);
  }, "speak");
}

async function doPropose() {
  const title = $("propose-title").value.trim();
  const body = $("propose-body").value.trim();
  if (!title) { setStatus("a proposal needs a title", "bad"); return; }
  await withWallet(async () => {
    setStatus("sign in your wallet… (gasless)");
    const ts = Date.now();
    const sig = await signTyped("Propose", proposeMsg(ACCOUNT, title, body, ts));
    setStatus("opening proposal…");
    const res = await apiPost("/community/proposal", { author: ACCOUNT, title, body, ts, sig });
    $("propose-title").value = "";
    $("propose-body").value = "";
    setStatus("proposal #" + res.id + " opened ✓", "good");
    await Promise.all([loadProposals(), loadGate()]);
  }, "propose");
}

async function doVote(proposalId, choice) {
  await withWallet(async () => {
    setStatus("sign your vote… (gasless)");
    const ts = Date.now();
    const sig = await signTyped("Vote", voteMsg(ACCOUNT, proposalId, choice, ts));
    setStatus("casting vote…");
    await apiPost("/community/vote", { author: ACCOUNT, proposalId, choice, ts, sig });
    const label = choice === 1 ? "for" : choice === 0 ? "against" : "abstain";
    setStatus("voted " + label + " on #" + proposalId + " ✓", "good");
    await Promise.all([loadProposals(), loadGate()]);
  }, "speak");
}

async function doReply(proposalId, textarea) {
  const body = textarea.value.trim();
  if (!body) { setStatus("write a reply first", "bad"); return; }
  await withWallet(async () => {
    setStatus("sign your reply… (gasless)");
    const ts = Date.now();
    const sig = await signTyped("Post", postMsg(ACCOUNT, body, proposalId, ts));
    setStatus("posting reply…");
    await apiPost("/community/post", { author: ACCOUNT, body, proposalId, ts, sig });
    textarea.value = "";
    setStatus("reply posted ✓", "good");
    await loadReplies(proposalId);
    await loadGate();
  }, "speak");
}

// ============================== data loading ==============================

async function loadCfg() {
  CFG = await apiGet("/community");
  const chain = Number(CFG.chainId) === 5042 ? "arc mainnet · 5042" : "arc · " + CFG.chainId;
  const badges = [
    ["token", "MURMUR"],
    ["chain", chain],
    ["speak ≥", trimNum(CFG.speakMinFmt, 0)],
    ["propose ≥", trimNum(CFG.proposeMinFmt, 0)],
    ["window", Math.round(Number(CFG.proposalWindowMs) / 3600000) + "h"],
  ];
  $("badges").innerHTML = badges.map((b) => `<span class="badge">${esc(b[0])} <b>${esc(b[1])}</b></span>`).join("");
}

async function loadFeed(reset) {
  const host = $("feed");
  try {
    if (reset) { feedBefore = null; feedItems = []; }
    const q = "/community/feed?limit=25" + (feedBefore ? "&before=" + feedBefore : "");
    const j = await apiGet(q);
    if (reset) feedItems = j.posts || [];
    else feedItems = feedItems.concat(j.posts || []);
    feedBefore = j.nextBefore;
    renderFeed();
  } catch (e) {
    host.innerHTML = `<p class="err">could not load the plaza: ${esc(e.message)}</p>`;
  }
}

function renderFeed() {
  const host = $("feed");
  if (!feedItems.length) {
    host.innerHTML = '<p class="empty">the plaza is quiet. ' + (GATE && GATE.canSpeak ? "Say something above." : "Connect a wallet holding MURMUR to speak.") + "</p>";
  } else {
    host.innerHTML = feedItems.map((p) => `
      <div class="post">
        <div class="p-meta">
          <span class="who">${esc(shortAddr(p.author))}</span>
          <span class="wt">${esc(trimNum(p.authorBalFmt))} MURMUR</span>
          <span>${esc(timeAgo(p.ts))}</span>
        </div>
        <div class="p-text">${esc(p.body)}</div>
      </div>`).join("");
  }
  $("more-feed").classList.toggle("hidden", !feedBefore);
}

async function loadProposals() {
  const host = $("proposals");
  try {
    const q = "/community/proposals?limit=50" + (propStatus ? "&status=" + propStatus : "");
    const j = await apiGet(q);
    renderProposals(j.proposals || [], j.now || Date.now());
  } catch (e) {
    host.innerHTML = `<p class="err">could not load proposals: ${esc(e.message)}</p>`;
  }
}

function tallyBar(t) {
  const total = t.total || "0";
  const pf = pct(t.for, total), pa = pct(t.against, total), pb = pct(t.abstain, total);
  return `
    <div class="tally">
      <div class="bar">
        <i class="for" style="width:${pf}%"></i><i class="against" style="width:${pa}%"></i><i class="abstain" style="width:${pb}%"></i>
      </div>
      <div class="legend">
        <span><i class="swatch" style="background:var(--for)"></i>for <b>${esc(trimNum(t.forFmt))}</b> (${pf}%)</span>
        <span><i class="swatch" style="background:var(--against)"></i>against <b>${esc(trimNum(t.againstFmt))}</b> (${pa}%)</span>
        <span><i class="swatch" style="background:var(--abstain)"></i>abstain <b>${esc(trimNum(t.abstainFmt))}</b> (${pb}%)</span>
        <span>voters <b>${esc(t.voters)}</b></span>
      </div>
    </div>`;
}

function proposalCard(p) {
  const state = p.open
    ? `<span class="tagstate open">${esc(timeLeft(p.deadline))}</span>`
    : `<span class="tagstate closed">closed</span>`;
  const voteRow = p.open ? `
      <button class="vbtn for" data-vote="1" data-id="${p.id}" type="button">vote for</button>
      <button class="vbtn against" data-vote="0" data-id="${p.id}" type="button">vote against</button>
      <button class="vbtn" data-vote="2" data-id="${p.id}" type="button">abstain</button>` : "";
  return `
    <div class="card" data-card="${p.id}">
      <div class="p-head"><h3>${esc(p.title)}</h3>${state}</div>
      <div class="p-meta">by ${esc(shortAddr(p.author))} · ${esc(trimNum(p.authorBalFmt))} MURMUR · ${esc(timeAgo(p.ts))}</div>
      ${p.body ? `<div class="p-body">${esc(p.body)}</div>` : ""}
      ${tallyBar(p.tally || {})}
      <div class="vote-row">
        ${voteRow}
        <button class="vbtn" data-chart="${p.id}" type="button">tally graph</button>
        <button class="vbtn" data-reply="${p.id}" type="button">reply</button>
      </div>
      <div class="chart hidden" data-chartbox="${p.id}"></div>
      <div class="replies hidden" data-replies="${p.id}"></div>
    </div>`;
}

function renderProposals(list, _now) {
  const host = $("proposals");
  if (!list.length) {
    const cta = GATE && GATE.canPropose ? "Open the first one above." : "Hold ≥ propose-min MURMUR to open one.";
    host.innerHTML = `<p class="empty">no ${esc(propStatus)} proposals yet. ${esc(cta)}</p>`;
    return;
  }
  host.innerHTML = list.map(proposalCard).join("");

  host.querySelectorAll(".vbtn[data-vote]").forEach((b) => {
    b.addEventListener("click", () => doVote(Number(b.dataset.id), Number(b.dataset.vote)));
  });
  host.querySelectorAll(".vbtn[data-reply]").forEach((b) => {
    b.addEventListener("click", () => toggleReplies(Number(b.dataset.reply)));
  });
  host.querySelectorAll(".vbtn[data-chart]").forEach((b) => {
    b.addEventListener("click", () => toggleChart(Number(b.dataset.chart)));
  });
}

async function toggleReplies(id) {
  const box = document.querySelector(`[data-replies="${id}"]`);
  if (!box) return;
  if (!box.classList.contains("hidden")) { box.classList.add("hidden"); return; }
  box.classList.remove("hidden");
  await loadReplies(id);
}

async function loadReplies(id) {
  const box = document.querySelector(`[data-replies="${id}"]`);
  if (!box) return;
  box.innerHTML = '<p class="loading">loading replies…</p>';
  try {
    const j = await apiGet("/community/proposal?id=" + id);
    const replies = (j.replies || []).map((r) => `
      <div class="reply">
        <div class="r-meta">${esc(shortAddr(r.author))} · ${esc(trimNum(r.authorBalFmt))} MURMUR · ${esc(timeAgo(r.ts))}</div>
        <div class="r-body">${esc(r.body)}</div>
      </div>`).join("");
    box.innerHTML = `
      ${replies || '<p class="empty">no replies yet</p>'}
      <textarea class="reply-input" maxlength="4000" placeholder="reply… (requires ≥ speak-min MURMUR)"></textarea>
      <div class="row"><span class="hint">signed + balance-checked on submit</span>
      <button class="btn reply-submit" type="button">sign &amp; reply</button></div>`;
    const ta = box.querySelector(".reply-input");
    box.querySelector(".reply-submit").addEventListener("click", () => doReply(id, ta));
  } catch (e) {
    box.innerHTML = `<p class="err">could not load replies: ${esc(e.message)}</p>`;
  }
}

// ============================== tally graph (per-proposal vote timeline) ==============================
//
// The graph is the transparency answer to "a late whale can swing the tally": every vote and re-vote is an
// append-only event, and we draw the cumulative For/Against/Abstain weight over the voting window as a
// step-after curve. Lead flips get a dashed marker, and a flip in the final quarter of the window is called
// out explicitly, so a last-hour whale move is visible to everyone instead of silently overwriting the result.

/** Compact a number for axis labels (1.2M, 340K, …). */
function compactNum(n) {
  n = Number(n);
  if (!isFinite(n)) return "0";
  const a = Math.abs(n);
  const r = (v, s) => v.toFixed(1).replace(/\.0$/, "") + s;
  if (a >= 1e9) return r(n / 1e9, "B");
  if (a >= 1e6) return r(n / 1e6, "M");
  if (a >= 1e3) return r(n / 1e3, "K");
  return a > 0 && a < 10 ? n.toFixed(1).replace(/\.0$/, "") : String(Math.round(n));
}

/** UTC "M/D HH:MM" for axis + event timestamps. */
function fmtDate(ms) {
  const d = new Date(Number(ms));
  if (isNaN(d.getTime())) return "";
  const p = (x) => String(x).padStart(2, "0");
  return `${d.getUTCMonth() + 1}/${p(d.getUTCDate())} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}`;
}

const choiceLabel = (c) => (Number(c) === 1 ? "for" : Number(c) === 0 ? "against" : "abstain");

async function toggleChart(id) {
  const box = document.querySelector(`[data-chartbox="${id}"]`);
  if (!box) return;
  if (!box.classList.contains("hidden")) { box.classList.add("hidden"); return; }
  box.classList.remove("hidden");
  box.innerHTML = '<p class="loading">loading tally graph…</p>';
  try {
    const tl = await apiGet("/community/timeline?id=" + id);
    box.innerHTML = `<div class="chart-wrap">${renderTallyGraph(tl)}</div>`;
  } catch (e) {
    box.innerHTML = `<p class="err">could not load the tally graph: ${esc(e.message)}</p>`;
  }
}

/** Build the SVG step chart + legend + late-swing callout + recent-event list from a /community/timeline payload. */
function renderTallyGraph(tl) {
  const series = Array.isArray(tl.series) ? tl.series : [];
  if (!series.length) {
    return `<div class="chart-head">no votes yet — the curve appears the moment the first ballot lands.</div>`;
  }

  const W = 680, H = 210, padL = 46, padR = 14, padT = 14, padB = 26;
  const plotW = W - padL - padR, plotH = H - padT - padB;

  // X domain: the proposal window, expanded to include any event timestamps that fall outside it.
  let tMin = Number(tl.start), tMax = Number(tl.deadline);
  for (const p of series) {
    const t = Number(p.recordedAt);
    if (t < tMin) tMin = t;
    if (t > tMax) tMax = t;
  }
  if (!(tMax > tMin)) tMax = tMin + 1;
  const span = tMax - tMin;
  const x = (t) => padL + ((Number(t) - tMin) / span) * plotW;

  // Y domain: highest cumulative weight, with headroom so the top line isn't flush with the frame.
  let vMax = 0;
  for (const p of series) vMax = Math.max(vMax, Number(p.forFmt || 0), Number(p.againstFmt || 0), Number(p.abstainFmt || 0));
  vMax = vMax > 0 ? vMax * 1.12 : 1;
  const y = (v) => padT + plotH - (Number(v) / vMax) * plotH;

  // step-after: hold the previous cumulative value up to the event time, then jump to the new value.
  const stepPath = (key) => {
    let d = `M ${x(tMin).toFixed(1)} ${y(0).toFixed(1)}`, prev = 0;
    for (const p of series) {
      const xi = x(p.recordedAt).toFixed(1), v = Number(p[key] || 0);
      d += ` L ${xi} ${y(prev).toFixed(1)} L ${xi} ${y(v).toFixed(1)}`;
      prev = v;
    }
    return d + ` L ${x(tMax).toFixed(1)} ${y(prev).toFixed(1)}`;
  };

  let grid = "";
  const ticks = 4;
  for (let i = 0; i <= ticks; i++) {
    const val = (vMax / ticks) * i, yy = y(val);
    grid += `<line class="grid" x1="${padL}" y1="${yy.toFixed(1)}" x2="${W - padR}" y2="${yy.toFixed(1)}" />`;
    grid += `<text class="axis" x="${padL - 6}" y="${(yy + 3).toFixed(1)}" text-anchor="end">${esc(compactNum(val))}</text>`;
  }

  // Lead-flip markers: the whale-swing signal, drawn as dashed verticals so they read on any line.
  let flips = "";
  for (const p of series) {
    if (p.event && p.event.isLeadChange) {
      const xi = x(p.recordedAt).toFixed(1);
      flips += `<line class="flip" x1="${xi}" y1="${padT}" x2="${xi}" y2="${(padT + plotH).toFixed(1)}" />`;
      flips += `<circle class="flipdot" cx="${xi}" cy="${padT}" r="2.2" />`;
    }
  }

  const svg = `<svg class="chart-svg" viewBox="0 0 ${W} ${H}" role="img" aria-label="Cumulative MURMUR-weighted tally across the voting window">`
    + grid
    + `<path class="line abstain" d="${stepPath("abstainFmt")}" />`
    + `<path class="line against" d="${stepPath("againstFmt")}" />`
    + `<path class="line for" d="${stepPath("forFmt")}" />`
    + flips
    + `<text class="axis" x="${padL}" y="${H - 8}" text-anchor="start">opens ${esc(fmtDate(tl.start))}</text>`
    + `<text class="axis" x="${W - padR}" y="${H - 8}" text-anchor="end">closes ${esc(fmtDate(tl.deadline))}</text>`
    + `</svg>`;

  const legend = `<div class="chart-legend">`
    + `<span><i class="swatch" style="background:var(--for)"></i>for</span>`
    + `<span><i class="swatch" style="background:var(--against)"></i>against</span>`
    + `<span><i class="swatch" style="background:var(--abstain)"></i>abstain</span>`
    + `<span><i class="dash"></i>lead-flip</span>`
    + `</div>`;

  // Late swing: a lead-flip in the final quarter of the window — exactly the whale scenario the curve exposes.
  const lateCut = tMin + span * 0.75;
  let swing = null;
  for (const p of series) {
    if (p.event && p.event.isLeadChange && Number(p.recordedAt) >= lateCut) {
      if (!swing || Number(p.event.weightFmt || 0) > Number(swing.event.weightFmt || 0)) swing = p;
    }
  }
  let swingBox = "";
  if (swing) {
    const before = Math.max(0, Number(tl.deadline) - Number(swing.recordedAt));
    const whenTxt = before >= 3600000 ? Math.max(1, Math.round(before / 3600000)) + "h" : Math.max(1, Math.round(before / 60000)) + "m";
    swingBox = `<div class="swing"><b>late swing</b> — ${esc(shortAddr(swing.event.voter))} cast `
      + `${esc(trimNum(swing.event.weightFmt, 0))} MURMUR <b>${esc(choiceLabel(swing.event.choice))}</b> about ${esc(whenTxt)} before close, `
      + `flipping the lead to <b>${esc(swing.leader)}</b>. Every vote is on the public curve, so nobody can hide it.</div>`;
  }

  const last = series[series.length - 1];
  const voters = (tl.tally && tl.tally.voters != null) ? tl.tally.voters : last.voters;
  const head = `<div class="chart-head">append-only vote timeline · <b>${series.length}</b> event${series.length === 1 ? "" : "s"} · `
    + `<b>${esc(voters)}</b> voter${Number(voters) === 1 ? "" : "s"} · cumulative weighted tally, point-in-time correct across re-votes</div>`;

  const evRows = series.slice(-8).reverse().map((p) => {
    const e = p.event || {};
    const cl = choiceLabel(e.choice);
    const flags = (e.isRevote ? `<span class="flagml">re-vote</span>` : "")
      + (e.isLeadChange ? `<span class="flagml flip">lead-flip</span>` : "");
    return `<div class="ev">`
      + `<span class="who">${esc(shortAddr(e.voter))}</span>`
      + `<span class="ch ${esc(cl)}">${esc(cl)}</span>`
      + `<span class="wt">${esc(trimNum(e.weightFmt, 0))} MURMUR</span>`
      + `<span>${esc(fmtDate(e.recordedAt))} UTC</span>`
      + flags
      + `</div>`;
  }).join("");

  return head + svg + legend + swingBox + `<div class="chart-events">${evRows}</div>`;
}

// ============================== gate render ==============================

function renderGate() {
  const addrEl = $("gate-addr"), balEl = $("gate-bal");
  const speak = $("pill-speak"), propose = $("pill-propose");
  const speakBtn = $("speak-submit"), proposeBtn = $("propose-submit");

  if (!ACCOUNT || !GATE) {
    addrEl.textContent = "not connected";
    balEl.innerHTML = "—<small>MURMUR</small>";
    speak.className = "pill"; speak.textContent = "speak · —";
    propose.className = "pill"; propose.textContent = "propose · —";
    speakBtn.disabled = true; proposeBtn.disabled = true;
    $("gate-note").textContent = "Connect a wallet on Arc to see your balance and what you can do.";
    return;
  }
  addrEl.textContent = shortAddr(ACCOUNT) + " · " + shortAddr(GATE.address || ACCOUNT);
  balEl.innerHTML = esc(trimNum(GATE.balanceFmt)) + "<small>MURMUR</small>";
  speak.className = "pill " + (GATE.canSpeak ? "yes" : "no");
  speak.textContent = "speak · " + (GATE.canSpeak ? "ok" : "need " + trimNum(GATE.speakMinFmt, 0));
  propose.className = "pill " + (GATE.canPropose ? "yes" : "no");
  propose.textContent = "propose · " + (GATE.canPropose ? "ok" : "need " + trimNum(GATE.proposeMinFmt, 0));
  speakBtn.disabled = !GATE.canSpeak;
  proposeBtn.disabled = !GATE.canPropose;
  $("gate-note").textContent = GATE.canSpeak
    ? "Your balance is re-checked on-chain every time you act — the server never trusts this page."
    : "Below the speak threshold: you can still browse everything.";
  renderFeed(); // the empty-state CTA depends on canSpeak
}

// ============================== composer wiring ==============================

function updateSpeakCount() {
  $("speak-count").textContent = $("speak-body").value.length + " / 4000";
}

function showTab(which) {
  const speak = which === "speak";
  $("tab-speak").classList.toggle("active", speak);
  $("tab-propose").classList.toggle("active", !speak);
  $("speak-form").classList.toggle("hidden", !speak);
  $("propose-form").classList.toggle("hidden", speak);
  setStatus("");
}

function wire() {
  $("connect-btn").addEventListener("click", () => (ACCOUNT ? loadGate() : connect()));
  $("tab-speak").addEventListener("click", () => showTab("speak"));
  $("tab-propose").addEventListener("click", () => showTab("propose"));
  $("speak-body").addEventListener("input", updateSpeakCount);
  $("speak-form").addEventListener("submit", (e) => { e.preventDefault(); doSpeak(); });
  $("propose-form").addEventListener("submit", (e) => { e.preventDefault(); doPropose(); });
  $("more-feed").addEventListener("click", () => loadFeed(false));

  $("prop-filter").querySelectorAll(".tab").forEach((b) => {
    b.addEventListener("click", () => {
      $("prop-filter").querySelectorAll(".tab").forEach((x) => x.classList.remove("active"));
      b.classList.add("active");
      propStatus = b.dataset.status || "";
      loadProposals();
    });
  });

  // Reflect an already-connected wallet + account/chain changes without a reload.
  if (window.ethereum) {
    window.ethereum.on && window.ethereum.on("accountsChanged", (accts) => {
      ACCOUNT = Array.isArray(accts) && accts[0] ? accts[0] : null;
      if (!ACCOUNT) { GATE = null; $("connect-btn").textContent = "connect wallet"; $("connect-btn").classList.remove("connected"); }
      else $("connect-btn").textContent = shortAddr(ACCOUNT);
      renderGate();
      if (ACCOUNT) loadGate();
    });
    window.ethereum.on && window.ethereum.on("chainChanged", () => { if (ACCOUNT) loadGate(); });
  }
}

// ============================== boot ==============================

async function boot() {
  wire();
  updateSpeakCount();
  try {
    await loadCfg();
  } catch (e) {
    $("badges").innerHTML = `<span class="badge">status <b>unavailable</b></span>`;
    $("proposals").innerHTML = `<p class="err">${esc(e.message)} — the community API may be disabled or unreachable.</p>`;
    $("feed").innerHTML = "";
    return;
  }
  await Promise.all([loadFeed(true), loadProposals()]);
  // Refresh countdowns + relative times once a minute (no reload needed).
  setInterval(() => { if (CFG) loadProposals(); }, 60000);
}

boot();
