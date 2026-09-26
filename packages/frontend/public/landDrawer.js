// landDrawer.js — task 55: land parcel purchase drawer UI.
// Mirrors the Temple drawer pattern: right-edge slide-in sheet, mutually exclusive
// with other drawers. Handles image upload + Canvas compression, MetaMask burn
// transaction, and POST /land with X-Payment-Proof header.

import { state, $, API, shortHash } from './shared.js';
import { t as T } from './i18n.js?v=98';
import { getJSON } from './polling.js';

// ---- constants (mirror the backend land.ts) ----
const LAND_CHAIN_ID = 5042;
const LAND_BURN_ADDRESS = "0x000000000000000000000000000000000000dEaD";
const LAND_MURMUR_TOKEN = "0x8faae5592b9acc27a79fca745c6b872adf514a5d";
const TRANSFER_SELECTOR = "0xa9059cbb";
const IMG_SIZE = 512;
const IMG_QUALITY = 0.8;

// ---- helpers ----
const wordAddr = (a) => String(a).replace(/^0x/i, "").toLowerCase().padStart(64, "0");
const wordUint = (n) => BigInt(n).toString(16).padStart(64, "0");

/** Convert human-readable MURMUR to 18-dec atomic BigInt. */
function murToAtomic(str) {
  const s = String(str).trim().replace(/,/g, "");
  if (!/^\d*\.?\d*$/.test(s) || s === "" || s === ".") return 0n;
  const [ip, fp] = s.split(".");
  return BigInt((ip || "0") + (fp + "000000000000000000").slice(0, 18));
}

/** Format atomic string to human-readable whole MURMUR. */
function atomicToWhole(atomic) {
  try {
    const n = BigInt(atomic || "0");
    return (n / 10n ** 18n).toString();
  } catch { return "0"; }
}

// ---- drawer lifecycle ----
export function openLand(parcelId) {
  state.landOpen = true;
  state.landParcelId = parcelId;
  // close other drawers
  if (state.chronOpen) { try { closeChronDrawer(); } catch {} }
  if (state.canaryOpen) { try { closeCanaryDrawer(); } catch {} }
  if (state.templeOpen) { try { closeTempleDrawer(); } catch {} }
  if (state.walletsOpen) { try { closeWalletsDrawer(); } catch {} }

  const d = $("land-drawer");
  if (!d) return;
  d.hidden = false;
  document.body.classList.add("land-open");
  requestAnimationFrame(() => d.classList.add("open"));
  renderLandDrawer();
}

export function closeLand() {
  state.landOpen = false;
  document.body.classList.remove("land-open");
  const d = $("land-drawer");
  if (!d) return;
  d.classList.remove("open");
  setTimeout(() => { if (!state.landOpen) d.hidden = true; }, 420);
}

export function toggleLand(parcelId) {
  if (state.landOpen && state.landParcelId === parcelId) closeLand();
  else openLand(parcelId);
}

// ---- mutual-exclusion helpers (avoid circular imports) ----
function closeChronDrawer() {
  const fn = window.__closeChron; if (fn) fn();
}
function closeCanaryDrawer() {
  const fn = window.__closeCanary; if (fn) fn();
}
function closeTempleDrawer() {
  const fn = window.__closeTemple; if (fn) fn();
}
function closeWalletsDrawer() {
  const fn = window.__closeWallets; if (fn) fn();
}

// ---- render ----
export async function renderLandDrawer() {
  const body = $("land-body");
  if (!body) return;
  body.innerHTML = `<p class="ld-loading">${T("land.loading")}</p>`;

  const pid = state.landParcelId;
  let parcel = null;
  let landMeta = null;

  // use cached land data from the layer if available
  const layer = state.landLayer;
  if (layer && layer.data) {
    landMeta = layer.data;
    parcel = (layer.parcels || []).find(p => p.id === pid) || null;
  }

  if (!landMeta) {
    try {
      landMeta = await getJSON("/land", 8000);
    } catch { /* */ }
  }

  if (!state.landOpen) return;

  // compute price
  const basePrice = landMeta ? landMeta.basePrice : "10000";
  const overrideStep = landMeta ? landMeta.overrideStep : "100";
  const overrides = parcel ? (parcel.overrides || 0) : 0;
  const price = parcel && parcel.price ? parcel.price : basePrice;
  const isOverride = !!(parcel && parcel.owner);

  state.landInfo = { parcel, landMeta, price, isOverride, overrides };
  paintLandDrawer();
}

export function paintLandDrawer() {
  const body = $("land-body");
  if (!body) return;
  const info = state.landInfo || {};
  const { parcel, price, isOverride, overrides } = info;
  const pid = state.landParcelId;
  const priceWhole = atomicToWhole(price);

  let html = `<div class="ld-info">`;
  html += `<div class="ld-row"><span class="ld-label">${T("land.parcel", { id: pid })}</span></div>`;
  html += `<div class="ld-row"><span class="ld-label">${T("land.owner")}</span><span class="ld-value">${parcel && parcel.owner ? shortHash(parcel.owner) : T("land.unowned")}</span></div>`;
  html += `<div class="ld-row"><span class="ld-label">${T("land.price")}</span><span class="ld-value ld-price">${priceWhole} MURMUR</span></div>`;
  if (overrides > 0) {
    html += `<div class="ld-row"><span class="ld-label">${T("land.overrides")}</span><span class="ld-value">${overrides}</span></div>`;
  }
  html += `</div>`;

  // image preview (if owned)
  if (parcel && parcel.owner && parcel.imageUrl) {
    const imgUrl = parcel.imageUrl.startsWith("http") ? parcel.imageUrl : API + parcel.imageUrl;
    html += `<div class="ld-preview"><img src="${imgUrl}" alt="Parcel ${pid}" class="ld-img" /></div>`;
  }

  // upload area
  html += `<div class="ld-upload" id="ld-upload">
    <div class="ld-dropzone" id="ld-dropzone">
      <span class="ld-drop-text">${T("land.dragDrop")}</span>
      <input type="file" accept="image/*" id="ld-file" class="ld-file-input" />
    </div>
    <div class="ld-thumb-wrap" id="ld-thumb-wrap" hidden>
      <img id="ld-thumb" class="ld-thumb" alt="preview" />
      <span class="ld-thumb-label">${T("land.uploadImage")}</span>
    </div>
  </div>`;

  // action buttons
  const btnLabel = isOverride ? T("land.override") : T("land.buy");
  html += `<div class="ld-actions">
    <button class="ld-btn ld-btn-primary" id="ld-buy-btn" type="button">${btnLabel}</button>
    <span class="ld-cost">${T("land.confirmBurn", { amount: priceWhole })}</span>
  </div>`;

  // status line
  html += `<div class="ld-status" id="ld-status"></div>`;

  body.innerHTML = html;

  // bind upload
  bindUpload();
  // bind buy
  const buyBtn = $("ld-buy-btn");
  if (buyBtn) buyBtn.addEventListener("click", () => landBuy(buyBtn));
}

// ---- image upload + compression ----
let _compressedBase64 = null;

function bindUpload() {
  const dropzone = $("ld-dropzone");
  const fileInput = $("ld-file");
  if (!dropzone || !fileInput) return;

  dropzone.addEventListener("click", () => fileInput.click());
  dropzone.addEventListener("dragover", (e) => { e.preventDefault(); dropzone.classList.add("drag-over"); });
  dropzone.addEventListener("dragleave", () => dropzone.classList.remove("drag-over"));
  dropzone.addEventListener("drop", (e) => {
    e.preventDefault();
    dropzone.classList.remove("drag-over");
    const file = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
    if (file && file.type.startsWith("image/")) processImage(file);
  });
  fileInput.addEventListener("change", () => {
    const file = fileInput.files && fileInput.files[0];
    if (file) processImage(file);
  });
}

async function processImage(file) {
  const setMsg = landMsgFn();
  setMsg(T("land.compressing"));

  try {
    const bitmap = await createImageBitmap(file);
    const canvas = document.createElement("canvas");
    canvas.width = IMG_SIZE;
    canvas.height = IMG_SIZE;
    const ctx = canvas.getContext("2d");

    // center-crop to square, then scale to 512×512
    const side = Math.min(bitmap.width, bitmap.height);
    const sx = (bitmap.width - side) / 2;
    const sy = (bitmap.height - side) / 2;
    ctx.drawImage(bitmap, sx, sy, side, side, 0, 0, IMG_SIZE, IMG_SIZE);
    bitmap.close();

    const dataUrl = canvas.toDataURL("image/jpeg", IMG_QUALITY);
    // strip the data:image/jpeg;base64, prefix for the API
    _compressedBase64 = dataUrl.split(",")[1] || dataUrl;

    // show thumbnail
    const thumbWrap = $("ld-thumb-wrap");
    const thumb = $("ld-thumb");
    const dropzone = $("ld-dropzone");
    if (thumb) thumb.src = dataUrl;
    if (thumbWrap) thumbWrap.hidden = false;
    if (dropzone) dropzone.style.display = "none";
    setMsg("");
  } catch (e) {
    setMsg(T("land.error", { msg: e.message || "image" }), "bad");
    _compressedBase64 = null;
  }
}

// ---- status message helper ----
function landMsgFn() {
  const el = $("ld-status");
  return (m, cls) => {
    if (el) {
      el.textContent = m || "";
      el.className = "ld-status" + (cls ? " " + cls : "");
    }
  };
}

// ---- purchase flow ----
export async function landBuy(btn) {
  if (state.landBusy) return;
  const setMsg = landMsgFn();

  if (!_compressedBase64) {
    setMsg(T("land.selectImage"), "bad");
    return;
  }
  if (!window.ethereum) {
    setMsg(T("land.noWallet"), "bad");
    return;
  }

  const info = state.landInfo || {};
  const price = info.price || "10000";
  const priceAtomic = BigInt(price);
  const pid = state.landParcelId;

  state.landBusy = true;
  if (btn) btn.disabled = true;

  try {
    // 1. Connect wallet + ensure Arc chain
    setMsg(T("land.connectWallet"));
    const from = await ensureWallet(setMsg);
    if (!from) return;

    // 2. Send burn transaction (ERC-20 transfer to dead address)
    const data = TRANSFER_SELECTOR + wordAddr(LAND_BURN_ADDRESS) + wordUint(priceAtomic);
    setMsg(T("land.burning"));
    const txHash = await window.ethereum.request({
      method: "eth_sendTransaction",
      params: [{ from, to: LAND_MURMUR_TOKEN, data, value: "0x0" }],
    });

    // 3. Wait for receipt
    setMsg(T("land.txWaiting"));
    const receiptOk = await waitReceipt(txHash);
    if (!receiptOk) {
      setMsg(T("land.failed"), "bad");
      return;
    }

    // 4. POST /land with payment proof
    setMsg(T("land.transactionPending"));
    const res = await fetch(API + "/land", {
      method: "POST",
      cache: "no-store",
      headers: {
        "content-type": "application/json",
        "X-Payment-Proof": txHash,
      },
      body: JSON.stringify({
        parcelId: pid,
        address: from,
        imageBase64: _compressedBase64,
      }),
    });

    if (res.ok) {
      setMsg(T("land.success"), "ok");
      _compressedBase64 = null;
      // refresh land layer
      if (state.landLayer) state.landLayer.forceRefresh();
      setTimeout(() => closeLand(), 1800);
    } else if (res.status === 402) {
      // Server returned a payment challenge — this shouldn't happen since we sent proof,
      // but handle gracefully
      const challenge = await res.json().catch(() => null);
      if (challenge && challenge.amount) {
        setMsg(T("land.confirmBurn", { amount: atomicToWhole(challenge.amount) }));
      } else {
        setMsg(T("land.failed"), "bad");
      }
    } else {
      const err = await res.json().catch(() => ({}));
      setMsg(T("land.error", { msg: (err && err.error) || res.status }), "bad");
    }
  } catch (e) {
    const msg = (e && (e.message || e.code)) || "unknown";
    if (/user rejected|denied|reject/i.test(String(msg))) {
      setMsg(T("land.failed"), "bad");
    } else {
      setMsg(T("land.error", { msg }), "bad");
    }
  } finally {
    state.landBusy = false;
    if (btn) btn.disabled = false;
  }
}

// ---- wallet plumbing (mirrors templeEnsureWallet) ----
async function ensureWallet(setMsg) {
  if (!window.ethereum) { setMsg(T("land.noWallet"), "bad"); return null; }
  const accts = await window.ethereum.request({ method: "eth_requestAccounts" });
  const from = Array.isArray(accts) && accts[0];
  if (!from) { setMsg(T("land.connectWallet"), "bad"); return null; }

  const chainHex = "0x" + LAND_CHAIN_ID.toString(16);
  const cur = await window.ethereum.request({ method: "eth_chainId" });
  if (String(cur).toLowerCase() !== chainHex.toLowerCase()) {
    setMsg(T("land.transactionPending"));
    try {
      await window.ethereum.request({ method: "wallet_switchEthereumChain", params: [{ chainId: chainHex }] });
    } catch (swErr) {
      if (swErr && (swErr.code === 4902 || /Unrecognized chain ID/i.test(String(swErr.message)))) {
        await window.ethereum.request({
          method: "wallet_addEthereumChain",
          params: [{
            chainId: chainHex,
            chainName: "Arc",
            nativeCurrency: { name: "USDC", symbol: "USDC", decimals: 18 },
            rpcUrls: ["https://rpc.mainnet.arc.io"],
            blockExplorerUrls: ["https://explorer.arc.io"],
          }],
        });
      } else { throw swErr; }
    }
  }
  return from;
}

// ---- wait for tx receipt (polls Arc RPC) ----
async function waitReceipt(hash, tries = 40) {
  for (let i = 0; i < tries; i++) {
    await new Promise(r => setTimeout(r, 1500));
    try {
      const res = await fetch("https://rpc.mainnet.arc.io", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_getTransactionReceipt", params: [hash] }),
      });
      const j = await res.json();
      if (j.result && j.result.status) {
        return j.result.status === "0x1";
      }
    } catch { /* keep polling */ }
  }
  return false;
}

// ---- re-render on language change ----
export function paintLand() {
  if (state.landOpen && state.landInfo) paintLandDrawer();
}
