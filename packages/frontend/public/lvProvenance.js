// lvProvenance.js — task 29 · Phase B created this as a SEAM; task 31 · Phase D fills C20 status bar data
// helpers and C22 trade-level neural evidence panel.
// Imported by lineageView.js with ?v= cache-buster (task 75).
//
// PERF CONTRACT
//   lvProvenanceRows builds an innerHTML string for ONE focused node on selection / on a language switch —
//   never per frame. lvEvidencePanelHTML builds the C22 trade-evidence panel on click — never per frame.
//   No shadowBlur, no backdrop-filter, no synchronous chain reads in the paint path.
import { LV } from './lvState.js?v=158';
import { state, shortHash, isRealTxHash, ARC_EXPLORER, clamp } from './shared.js?v=158';
import { t as T } from './i18n.js?v=111';

/**
 * Extra provenance rows for the focus sidebar, appended after the genome-hash / parents / commitTx block.
 * task 31 · C21: shows the on-chain anchor status for committed nodes.
 * @param {object|null} n      the focused node
 * @param {object|null} entry  its /lineage entry, if it has one
 * @param {object|null} grave  its econDynasty.graves row, if it is deceased
 * @returns {string} HTML to append inside #lv-p-prov
 */
export function lvProvenanceRows(n, entry, grave) {
  if (!n && !entry && !grave) return '';
  if (!LV.active) return '';
  let html = '';
  // C21: on-chain anchor status
  if (entry && entry.commitTx && isRealTxHash(entry.commitTx)) {
    const href = `${ARC_EXPLORER}/tx/${entry.commitTx}`;
    html += `<div class="lv-prov-r"><span>${T('lv.anchorTitle')}</span>` +
      `<b><a href="${href}" target="_blank" rel="noopener">${shortHash(entry.commitTx)}</a></b></div>`;
  }
  // C20: matching count from /lineage
  const lin = state.lvLineage;
  if (lin && lin.matching != null && lin.count != null) {
    html += `<div class="lv-prov-r"><span>${T('lv.provMatching')}</span>` +
      `<b>${lin.matching}/${lin.count}</b></div>`;
  }
  return html;
}

// ================= C22: trade-level neural evidence =================
// When a trade arc is clicked, find the matching constituent from state.proofs and build the evidence panel.

/**
 * Find the constituent matching a trade edge (fromId, toId, good) from the cached proofs.
 * Returns { constituent, proof } or null.
 */
export function lvFindConstituent(fromId, toId, good) {
  const proofs = state.proofs;
  if (!Array.isArray(proofs)) return null;
  for (const p of proofs) {
    const c = p && p.receipt && p.receipt.receipt
      ? p.receipt.receipt.constituents
      : (p && p.receipt ? p.receipt.constituents : null);
    if (!Array.isArray(c)) continue;
    for (const con of c) {
      if (con && con.fromId === fromId && con.toId === toId && (con.good === good || !good)) {
        return { constituent: con, proof: p };
      }
    }
  }
  return null;
}

/**
 * Build the C22 neural evidence panel HTML for a matched trade.
 * Shows: buyer/seller arousal, turnBias, state, fingerprint + decisionHash +
 * prevChain → receiptHash → commitTx three-level hash chain band.
 * @param {object} tradeEdge  the hit trade edge {fromId, toId, good, amount}
 * @returns {string} HTML for the evidence panel
 */
export function lvEvidencePanelHTML(tradeEdge) {
  if (!tradeEdge) return '';
  const match = lvFindConstituent(tradeEdge.fromId, tradeEdge.toId, tradeEdge.good);
  if (!match) {
    return `<div class="lv-p-sec">${T('lv.evidTitle')}</div>` +
      `<div class="lv-evid-empty">${T('lv.evidNoMatch')}</div>`;
  }
  const { constituent: con, proof } = match;
  let html = `<div class="lv-p-sec">${T('lv.evidTitle')}</div>`;
  html += `<div class="lv-evid-grid">`;
  // buyer
  if (con.buyer) {
    html += `<div class="lv-evid-col"><div class="lv-evid-role">${T('lv.evidBuyer')} #${con.buyer.id ?? con.fromId}</div>`;
    html += evidRows(con.buyer);
    html += `</div>`;
  }
  // seller
  if (con.seller) {
    html += `<div class="lv-evid-col"><div class="lv-evid-role">${T('lv.evidSeller')} #${con.seller.id ?? con.toId}</div>`;
    html += evidRows(con.seller);
    html += `</div>`;
  }
  html += `</div>`;
  // decision hash
  if (con.decisionHash) {
    html += `<div class="lv-prov-r"><span>${T('lv.evidDecision')}</span><b class="fp">${shortHash(con.decisionHash)}</b></div>`;
  }
  // three-level hash chain band: prevChain → receiptHash → commitTx
  html += `<div class="lv-evid-chain">`;
  const receipt = proof.receipt || proof;
  const prevChain = receipt.prevChain || null;
  const receiptHash = proof.receiptHash || null;
  const commitTx = proof.commitTx || null;
  html += chainLink(T('lv.evidPrev'), prevChain);
  html += `<span class="lv-crumb-sep">→</span>`;
  html += chainLink(T('lv.evidReceipt'), receiptHash);
  html += `<span class="lv-crumb-sep">→</span>`;
  html += chainLink(T('lv.evidCommit'), commitTx, true);
  html += `</div>`;
  return html;
}

function evidRows(neural) {
  let h = '';
  if (neural.state != null) h += `<div class="lv-prov-r"><span>${T('lv.evidState')}</span><b>${neural.state}</b></div>`;
  if (neural.arousal != null) h += `<div class="lv-prov-r"><span>${T('lv.evidArousal')}</span><b>${Number(neural.arousal).toFixed(3)}</b></div>`;
  if (neural.turnBias != null) h += `<div class="lv-prov-r"><span>${T('lv.evidTurn')}</span><b>${Number(neural.turnBias).toFixed(3)}</b></div>`;
  if (neural.fingerprint) h += `<div class="lv-prov-r"><span>${T('lv.evidPrint')}</span><b class="fp">${String(neural.fingerprint).slice(0, 16)}</b></div>`;
  return h;
}

function chainLink(label, hash, isTx) {
  if (!hash) return `<span class="lv-crumb">${label}: —</span>`;
  const short = shortHash(hash);
  if (isTx && isRealTxHash(hash)) {
    return `<a class="lv-crumb" href="${ARC_EXPLORER}/tx/${hash}" target="_blank" rel="noopener">${label}: ${short}</a>`;
  }
  return `<span class="lv-crumb">${label}: ${short}</span>`;
}

// ================= C20: status bar data helpers =================
/**
 * Fetch and cache the provenance status data for the C20 top bar.
 * Returns a promise that resolves to the status object.
 */
let provCache = null, provLastFetch = 0, provInFlight = false;
const PROV_FETCH_INTERVAL = 60000;

export async function lvProvFetchStatus() {
  const now = Date.now();
  if (provCache && now - provLastFetch < PROV_FETCH_INTERVAL) return provCache;
  if (provInFlight) return provCache;
  provInFlight = true;
  provLastFetch = now;
  // C8/C10 paradigm: an AbortController caps a hung fetch so provInFlight can never latch true forever.
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 8000);
  try {
    const [manifest, lineage] = await Promise.all([
      fetchJSON('/manifest', ac.signal),
      fetchJSON('/lineage?limit=1', ac.signal),
    ]);
    provCache = { manifest, lineage };
  } catch { /* best-effort */ }
  clearTimeout(timer);
  provInFlight = false;
  return provCache;
}

async function fetchJSON(path, signal) {
  try {
    const r = await fetch(path, { cache: 'no-store', signal });
    if (!r.ok) return null;
    return await r.json();
  } catch { return null; }
}
