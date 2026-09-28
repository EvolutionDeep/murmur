// landDrawer.js — task 55: land parcel purchase drawer UI.
// Mirrors the Temple drawer pattern: right-edge slide-in sheet, mutually exclusive
// with other drawers. Handles image upload + Canvas compression, MetaMask burn
// transaction, and POST /land with X-Payment-Proof header.

import { state, $, API, shortHash } from './shared.js';
import { t as T } from './i18n.js?v=109';
import { getJSON } from './polling.js';

// ---- constants (mirror the backend land.ts) ----
const LAND_CHAIN_ID = 5042;
const LAND_BURN_ADDRESS = "0x000000000000000000000000000000000000dEaD";
const LAND_MURMUR_TOKEN = "0x8faae5592b9acc27a79fca745c6b872adf514a5d";
const TRANSFER_SELECTOR = "0xa9059cbb";
const IMG_SIZE = 512;
const IMG_QUALITY = 0.8;

// ---- NSFW filter (task: land-art porn filter -> deep mosaic) ----
// Client-side detection + client-side masking: the image stored on the backend is
// ALREADY the masked copy, so every visitor sees the safe version with no per-visitor
// model run. Model weights are self-hosted under /assets/nsfw/ (binary assets must not
// depend on a third-party CDN at runtime); only the JS libs resolve via the importmap.
// KNOWN GAP: a caller hitting POST /land directly bypasses this filter entirely.
const NSFW_THRESHOLD = 0.5;      // "obviously explicit": Porn>=0.5 or Hentai>=0.5
const NSFW_MODEL_URL = "/assets/nsfw/model.json";
const MOSAIC_GRID = 16;          // downscale target -> heavy pixel blocks
let _nsfwModel = null;           // cached across uploads (lazy-loaded once)
let _nsfwLoadFailed = false;     // don't retry a hard failure within the session

// ---- helpers ----
const wordAddr = (a) => String(a).replace(/^0x/i, "").toLowerCase().padStart(64, "0");
const wordUint = (n) => BigInt(n).toString(16).padStart(64, "0");

/** Convert human-readable MURMUR to 18-dec atomic BigInt. */
function murToAtomic(str) {
  const s = String(str).trim().replace(/,/g, "");
  if (!/^\d*\.?\d*$/.test(s) || s === "" || s === ".") return 0n;
  const [ip, fp] = s.split(".");
  return BigInt((ip || "0") + ((fp || "") + "000000000000000000").slice(0, 18));
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

  // ALWAYS fetch fresh data so the price reflects the latest override count
  // (cached layer data may be stale after someone else just overrode the parcel).
  try {
    landMeta = await getJSON("/land", 8000);
  } catch { /* fall through to cache */ }

  // Fall back to the cached layer only when the network fetch failed
  if (!landMeta) {
    const layer = state.landLayer;
    if (layer && layer.data) {
      landMeta = layer.data;
    }
  }

  // Extract the parcel from whichever source provided landMeta
  if (landMeta && landMeta.parcels) {
    parcel = landMeta.parcels.find(p => p.id === pid) || null;
  } else {
    const layer = state.landLayer;
    if (layer) parcel = (layer.parcels || []).find(p => p.id === pid) || null;
  }

  if (!state.landOpen) return;

  // compute price (API returns whole MURMUR strings, not atomic)
  const basePrice = landMeta ? landMeta.basePrice : "5000";
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
  // price from the API is already in whole MURMUR — display directly
  const priceWhole = price || "5000";

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
    html += `<div class="ld-preview"><img src="${imgUrl}" alt="${T("land.parcelAlt", { id: pid })}" class="ld-img" /></div>`;
  }

  // upload area
  html += `<div class="ld-upload" id="ld-upload">
    <div class="ld-dropzone" id="ld-dropzone">
      <span class="ld-drop-text">${T("land.dragDrop")}</span>
      <input type="file" accept="image/*" id="ld-file" class="ld-file-input" />
    </div>
    <div class="ld-thumb-wrap" id="ld-thumb-wrap" style="display:none">
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

// ---- NSFW detection + deep-mosaic (client-side, lazy-loaded) ----
/**
 * Lazily import nsfwjs (via importmap; it pulls tfjs itself) and load the
 * self-hosted model. Resolves to the cached model, or null if loading failed —
 * in which case the caller MUST NOT block the upload.
 */
async function getNsfwModel() {
  if (_nsfwModel) return _nsfwModel;
  if (_nsfwLoadFailed) return null;
  try {
    const nsfwjs = await import("nsfwjs");
    _nsfwModel = await nsfwjs.load(NSFW_MODEL_URL);
    return _nsfwModel;
  } catch (e) {
    _nsfwLoadFailed = true;
    console.warn("[nsfw] model load failed - upload not blocked:", (e && e.message) || e);
    return null;
  }
}

/**
 * Classify a canvas. Returns a { Porn, Hentai, Neutral, Sexy, Drawing } probability
 * map, or null when the model/inference is unavailable (caller must not block on null).
 */
async function classifyNsfw(canvas) {
  const model = await getNsfwModel();
  if (!model) return null;
  try {
    const preds = await model.classify(canvas);
    const out = {};
    for (const p of preds || []) out[p.className] = p.probability;
    return out;
  } catch (e) {
    console.warn("[nsfw] classify failed - upload not blocked:", (e && e.message) || e);
    return null;
  }
}

/**
 * Deep mosaic: downscale to a tiny grid, then upscale with smoothing OFF so the
 * result is heavy pixel blocks; veil it and stamp a centred "blocked" mark (pure
 * canvas, no DOM). Returns a NEW canvas; the source is left untouched.
 */
function applyDeepMosaic(src) {
  const w = src.width, h = src.height;
  const small = document.createElement("canvas");
  small.width = MOSAIC_GRID; small.height = MOSAIC_GRID;
  const sctx = small.getContext("2d");
  sctx.drawImage(src, 0, 0, MOSAIC_GRID, MOSAIC_GRID);

  const out = document.createElement("canvas");
  out.width = w; out.height = h;
  const octx = out.getContext("2d");
  octx.imageSmoothingEnabled = false;
  octx.drawImage(small, 0, 0, w, h);

  // translucent veil
  octx.fillStyle = "rgba(38,36,32,0.42)";
  octx.fillRect(0, 0, w, h);

  // centred "no" mark: ring + diagonal slash
  const cx = w / 2, cy = h / 2, r = Math.min(w, h) * 0.14;
  octx.lineWidth = Math.max(4, r * 0.22);
  octx.strokeStyle = "rgba(242,238,230,0.9)";
  octx.beginPath(); octx.arc(cx, cy, r, 0, Math.PI * 2); octx.stroke();
  const d = r * Math.SQRT1_2;
  octx.beginPath(); octx.moveTo(cx - d, cy + d); octx.lineTo(cx + d, cy - d); octx.stroke();

  return out;
}

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

    // ---- NSFW filter: classify the compressed 512x512, deep-mosaic if explicit ----
    setMsg(T("land.masking"));
    const scores = await classifyNsfw(canvas);
    let finalCanvas = canvas;
    let masked = false;
    const filterDown = scores === null;
    if (scores) {
      const porn = scores.Porn || 0;
      const hentai = scores.Hentai || 0;
      if (porn >= NSFW_THRESHOLD || hentai >= NSFW_THRESHOLD) {
        finalCanvas = applyDeepMosaic(canvas);
        masked = true;
      }
    }

    const dataUrl = finalCanvas.toDataURL("image/jpeg", IMG_QUALITY);
    // strip the data:image/jpeg;base64, prefix for the API
    _compressedBase64 = dataUrl.split(",")[1] || dataUrl;

    // show thumbnail
    const thumbWrap = $("ld-thumb-wrap");
    const thumb = $("ld-thumb");
    const dropzone = $("ld-dropzone");
    if (thumb) thumb.src = dataUrl;
    if (thumbWrap) thumbWrap.style.display = "flex";
    if (dropzone) dropzone.style.display = "none";
    if (masked) setMsg(T("land.masked"), "warn");
    else if (filterDown) setMsg(T("land.filterUnavailable"), "warn");
    else setMsg("");
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
    const isOvr = !!(state.landInfo && state.landInfo.isOverride);
    setMsg(isOvr ? T("land.selectImage") + " (override requires a new image)" : T("land.selectImage"), "bad");
    return;
  }
  if (!window.ethereum) {
    setMsg(T("land.noWallet"), "bad");
    return;
  }

  const info = state.landInfo || {};
  const price = info.price || "5000";
  // price is whole MURMUR from the API — convert to 18-decimal atomic for the burn tx
  const priceAtomic = murToAtomic(price);
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
