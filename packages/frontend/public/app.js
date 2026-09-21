// ==========================================================================
// murmur — a living population feeling the arc market.
//
// The page IS the artwork: a full-bleed field where a population of fruit-fly
// nervous systems drifts, huddles or scatters. Every ~4s we read the Worker's
// /population snapshot (the swarm's collective mood + each fly's decoded drives)
// and let the flies move accordingly — hot → scattered & agitated, cold → tight
// & still, calm → gently drifting. Motion is integrated here on the client from
// each fly's turnBias / arousal / cohesion (the backend does not track x/y).
//
// Around that core the field breathes:
//   • a curl-like flow field carries ambient ink motes (faster when the market
//     is hot) and nudges every fly, so the swarm always rides a visible current;
//   • the pointer stirs the swarm — hovering gently draws flies in, pressing
//     scatters them;
//   • a temperature history ribbon plots the last ~2.5 min of market temperature;
//   • touching a fly opens its inspector with that fly's live neural bloom, spike
//     raster, drives and x402 agent wallet (offscreen-cached + slow guarded poll,
//     so rapid clicking can never stall the tab);
//
// RESILIENCE / PERFORMANCE: the Worker may be undeployed, in which case its
// workers.dev host black-holes TCP and a browser fetch would otherwise hang for
// tens of seconds. Every request is therefore timeout+abort guarded, polls never
// overlap, an offline circuit-breaker runs the piece purely locally for a while,
// and the selected-fly feed (neural bloom + spike raster + wallet) is offscreen-
// cached, polled at a slow guarded cadence, and click-storm throttled — so rapid
// clicking can never pile up stuck requests or canvas work and the field stays smooth.
//
// The whole palette slowly warms or cools with the market temperature. No
// trading, no wallet — observation only.
// ==========================================================================

// i18n kernel — pure read-out localisation layer (never touches sim/economy/proof).
// NOTE: `t` is used all over this file as a local (time/totals/lerp), so we import the
// translator under the alias `T` to avoid any shadowing. ct() = chronicle display, gl() = glossary.
import { t as T, ct, gl, currentLang, getLang, setLang, applyDom, SUPPORTED, ENDONYMS } from "./i18n.js?v=54";

const params = new URLSearchParams(location.search);
const API =
  params.get("api") ||
  localStorage.getItem("murmur-api") ||
  "https://api.muros.live";                 // Worker API on the project's own zone (not *.workers.dev)
if (params.get("api")) localStorage.setItem("murmur-api", API);

const POLL_MS = 6000;   // main loop: /population + /state; the on-chain tick is ~60s, so 6s is ample
const FETCH_TIMEOUT_MS = 3500;   // abort a hung request well before the browser would
const OFFLINE_BACKOFF_MS = 20000; // circuit-breaker window: run local-only, no probing
const TAU = Math.PI * 2;
const $ = (id) => document.getElementById(id);

// ---------- small math / colour helpers ----------
const clamp = (x, a = 0, b = 1) => (x < a ? a : x > b ? b : x);
const lerp = (a, b, t) => a + (b - a) * t;
const mix = (A, B, t) => [lerp(A[0], B[0], t), lerp(A[1], B[1], t), lerp(A[2], B[2], t)];
const rgb = (c) => `rgb(${c[0] | 0},${c[1] | 0},${c[2] | 0})`;
const rgba = (c, a) => `rgba(${c[0] | 0},${c[1] | 0},${c[2] | 0},${a})`;

// ---------- live palette: temperature → paper + accent ----------
const PALETTE = {
  cold: { paper: [232, 237, 239], accent: [91, 124, 141] },   // cool slate
  calm: { paper: [242, 238, 230], accent: [154, 140, 110] },  // warm bone + taupe
  hot:  { paper: [247, 234, 224], accent: [192, 94, 60] },    // blush + terracotta
};
function paletteAt(T) {
  T = clamp(T);
  return T < 0.5
    ? { paper: mix(PALETTE.cold.paper, PALETTE.calm.paper, T / 0.5), accent: mix(PALETTE.cold.accent, PALETTE.calm.accent, T / 0.5) }
    : { paper: mix(PALETTE.calm.paper, PALETTE.hot.paper, (T - 0.5) / 0.5), accent: mix(PALETTE.calm.accent, PALETTE.hot.accent, (T - 0.5) / 0.5) };
}
function applyPaletteToDOM(pal) {
  const p = pal.paper, a = pal.accent, s = document.documentElement.style;
  s.setProperty("--paper", rgb(p));
  s.setProperty("--panel", `rgba(${p[0] | 0},${p[1] | 0},${p[2] | 0},0.88)`);
  s.setProperty("--accent", rgb(a));
  s.setProperty("--accent-rgb", `${a[0] | 0},${a[1] | 0},${a[2] | 0}`);
}

// behavioural-state earth tones (CSS strings for the inspector badge)
const STATE_COLOR = { AGITATE: "#c05e3c", EXPLORE: "#c99a3f", AGGREGATE: "#5b7c8d", REST: "#8b9a86" };
const KIND_COL = { sensory: [91, 124, 141], inter: [122, 114, 98], modulatory: [192, 94, 60], motor: [26, 26, 24] };
const STIR_COL = [120, 116, 104];   // neutral ink for the pointer "stir" ripple
const hexRgb = (h) => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];
// state colours as RGB triples (STATE_COLOR holds CSS hex) — for the canvas dots in the shard-topology ring
const STATE_RGB = { AGITATE: hexRgb(STATE_COLOR.AGITATE), EXPLORE: hexRgb(STATE_COLOR.EXPLORE), AGGREGATE: hexRgb(STATE_COLOR.AGGREGATE), REST: hexRgb(STATE_COLOR.REST) };

// ---- Ethogram: named Fixed Action Patterns (FAPs) -----------------------------------------------
// The richer behaviour vocabulary decoded server-side from the SAME neural read-out (fly-brain/ethogram.ts):
// a competitive appetitive/aversive pathway + an inhibition hierarchy pick one named action per tick. Each
// FAP gets an earth-tone colour (so the swarm's actions read at a glance), a one-line gloss and an implied
// observable economic role. READ-OUT ONLY — it never feeds a settlement decision, it only animates the fly.
const FAP_COLOR = {
  FEED: "#7d9a4a",     // leaf green       — appetitive, proboscis extended
  GROOM: "#9a7b52",    // soft brown       — front legs sweep head & body
  FORAGE: "#c99a3f",   // amber            — walking search, the default roam
  HALT: "#6b7d8a",     // slate            — arrested mid-stride, assessing
  RETREAT: "#b04a3a",  // alert red-brown  — aversive, backing off
  COURT: "#c2607e",    // rose             — one wing extended & vibrated (the love song)
  FLIGHT: "#4f7fa8",   // sky blue         — airborne escape, wings blurred
  HUDDLE: "#7d7290",   // muted violet     — crowding in with the swarm
  REST: "#8b9a86",     // sage             — quiescent, wings folded tight
};
const FAP_GLOSS = {
  FEED: "proboscis down, taking in a reward",
  GROOM: "cleaning itself — front legs sweep the head",
  FORAGE: "roaming and sampling the field",
  HALT: "arrested mid-stride, assessing",
  RETREAT: "backing away from an aversive pulse",
  COURT: "one wing extended, singing a courtship song",
  FLIGHT: "airborne escape — wings blurred",
  HUDDLE: "crowding in with the swarm",
  REST: "quiescent, wings folded tight",
};
const FAP_ROLE = {
  FEED: "momentum-buyer", GROOM: "self-maintainer", FORAGE: "signal-seeker", HALT: "observer",
  RETREAT: "risk-off", COURT: "attestation-broadcaster", FLIGHT: "liquidator", HUDDLE: "consensus-follower", REST: "dormant",
};
// a legible gait multiplier per FAP (flight bolts, rest barely stirs) layered over the raw drives
const FAP_SPEED = { FLIGHT: 1.55, RETREAT: 1.4, FORAGE: 1.0, HUDDLE: 0.78, GROOM: 0.55, COURT: 0.6, FEED: 0.5, HALT: 0.3, REST: 0.18 };
const fapColor = (fap) => FAP_COLOR[fap] || "#8b9a86";

// Wealth → colour ramp: the poorest flies read cool slate, the richest glow warm gold, so body HUE and
// body SIZE (both balance-driven) tell the same story at a glance — big + gold = a wealthy wallet.
const WEALTH_RAMP = [
  [92, 118, 140],   // poorest  — cool slate blue
  [126, 140, 122],  // lean     — muted sage
  [198, 154, 74],   // well-off — amber
  [240, 196, 92],   // richest  — bright gold
];
function wealthColorAt(t) {
  t = clamp(t, 0, 1);
  const n = WEALTH_RAMP.length - 1;
  const i = Math.min(n - 1, Math.floor(t * n));
  return mix(WEALTH_RAMP[i], WEALTH_RAMP[i + 1], t * n - i);
}

// ================= client state =================
const sim = new Map();          // flyId → simulated fly (position + smoothed drives)
let collective = null;          // latest CollectiveState
let selectedId = null;
let offline = false;
let offlineUntil = 0;           // circuit-breaker: skip network probes until this timestamp
let cronHeartbeatMs = 0;        // last /state lastCron (epoch ms) — the DO cron's heartbeat, for the watchdog
const CRON_STALE_MS = 240000;   // cron fires ~every 60s, but a heavy on-chain cron can overrun and trip the
                                // reentrancy skip (measured inter-cron gaps up to ~164s), so only warn past 4 min
let pollInFlight = false;       // never let two polls overlap
let cachedRect = null;          // cached canvas rect — avoid a reflow on every pointer event
let tempTarget = 0.5, tempSmoothed = 0.5;
let cohTarget = 0.5, cohSmoothed = 0.5;
let centroidX = 0, centroidY = 0;
let ripples = [];

// ================= agent economy (x402 micropayments between flies) =================
// Each fly is an autonomous agent; the /population feed now carries an economy summary
// ({ lastTick, totals, balances }). We render every settlement as a payment packet flying from
// payer to payee, keep a rolling ledger ticker, and show the selected fly's wallet in the inspector.
const atomicToUsdc = (a) => Number(a) / 1e6;         // amounts arrive as atomic-USDC strings (6 dec)
const GOOD_COL = { signal: [91, 124, 141], momentum: [192, 94, 60], attestation: [139, 154, 134], prediction: [122, 96, 150] };
const ECON_EDGE_MS = 2000;                            // a payment packet lives ~2s
const MAX_EDGES = 60;                                 // cap: a busy tick can't pile up unbounded arcs
// Official Arc block explorer (docs.arc.io → mainnet chain 5042). Every real settlement carries a
// 64-hex txHash, so each ledger line links straight to it — a visitor can prove the money moved on-chain.
const ARC_EXPLORER = "https://explorer.arc.io";
// Public Arc RPC — the browser reads our NeuralReceiptRegistry DIRECTLY from here (no murmur server
// in the loop) so the on-chain hash-chain head is verified trustlessly. Selectors are precomputed
// keccak256 prefixes (viem toFunctionSelector) so we need no ABI encoder in the page.
const ARC_RPC = "https://rpc.mainnet.arc.io";
const REG_SEL_COMMITS = "0x47885781";   // commits(bytes32)
const REG_SEL_CHAINHEAD = "0x008f51c6"; // chainHead()
// NeuralManifestRegistry selectors (precomputed keccak256 prefixes) — the browser reads the committed
// brain-manifest hash straight off Arc, so "prove the brain" is trustless end-to-end (no murmur server).
const MAN_SEL_LATEST = "0x6f17d258";       // latestHash()
const MAN_SEL_ISCOMMITTED = "0x054765a3";  // isCommitted(bytes32)
const MAN_SEL_COUNT = "0x9123988b";        // commitCount()
// ConnectomeLineage selectors (precomputed keccak256 prefixes) — the browser reads each genome's committed
// ancestry STRAIGHT off Arc (no murmur server in the loop), so the breeding market's family tree is trustless
// end-to-end. lineages(bytes32) returns 7 words: genomeHash,parentA,parentB,op,generation,breeder,ts.
const LIN_SEL_LINEAGES = "0xce3dace4";     // lineages(bytes32)
const LIN_SEL_COUNT = "0x9123988b";        // commitCount()
const LIN_SEL_LATEST = "0x6f17d258";       // latestHash()
const LIN_SEL_COMMITTER = "0x5bc8e8f9";    // committer()
const isZeroBytes32 = (w) => !w || /^0x0{64}$/.test(String(w).toLowerCase());
const bytes32 = (h) => "0x" + String(h || "").replace(/^0x/i, "").toLowerCase().padStart(64, "0");
const wordToNum = (w) => Number(BigInt(w || "0x0"));
/** One JSON-RPC call to Arc. Throws on transport/HTTP failure so callers can fall back. */
async function arcRpc(method, params, timeoutMs = 8000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const r = await fetch(ARC_RPC, {
      method: "POST", cache: "no-store", signal: ctrl.signal,
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    });
    if (!r.ok) throw new Error(`rpc ${r.status}`);
    const j = await r.json();
    if (j.error) throw new Error(j.error.message || "rpc error");
    return j.result;
  } finally { clearTimeout(timer); }
}
/**
 * Read a receipt's committed link + the chain head straight from the on-chain registry via eth_call.
 * Returns null when the read fails (CORS/network) or the receipt isn't committed — callers then fall
 * back to the server-reported fields. `commits(bytes32)` returns 5 words: prevHead,tick,constituents,txHash,ts.
 */
async function readRegistryOnchain(registryAddress, receiptHash) {
  if (!isRealAddr(registryAddress)) return null;
  try {
    const [commitRes, headRes] = await Promise.all([
      arcRpc("eth_call", [{ to: registryAddress, data: REG_SEL_COMMITS + bytes32(receiptHash).slice(2) }, "latest"]),
      arcRpc("eth_call", [{ to: registryAddress, data: REG_SEL_CHAINHEAD }, "latest"]),
    ]);
    const chainHead = typeof headRes === "string" ? headRes : null;
    const hex = typeof commitRes === "string" ? commitRes.replace(/^0x/, "") : "";
    if (hex.length < 5 * 64) return { committed: false, chainHead };
    const word = (i) => "0x" + hex.slice(i * 64, (i + 1) * 64);
    const ts = wordToNum(word(4));
    return {
      committed: ts !== 0,
      prevHead: word(0), tickIndex: wordToNum(word(1)), constituents: wordToNum(word(2)),
      txHash: word(3), ts, chainHead,
    };
  } catch { return null; }
}
const isRealTxHash = (h) => typeof h === "string" && /^0x[0-9a-fA-F]{64}$/.test(h);
const isRealAddr = (a) => typeof a === "string" && /^0x[0-9a-fA-F]{40}$/.test(a);
const shortHash = (h) => `${h.slice(0, 6)}…${h.slice(-4)}`;

/**
 * Read the brain-manifest commitment straight from the on-chain NeuralManifestRegistry via eth_call.
 * Returns null when the read fails (CORS/network) or no registry is configured, so the caller can fall
 * back to "not anchored yet" without ever blocking the browser-side hash recompute.
 *   · latestHash()      → the most recently committed manifest hash (bytes32)
 *   · isCommitted(h)    → whether THIS manifest's hash is anchored (bool → last word == 1)
 *   · commitCount()     → how many manifests have ever been committed
 */
async function readManifestOnchain(registryAddress, manifestHash) {
  if (!isRealAddr(registryAddress) || !manifestHash) return null;
  try {
    const arg = bytes32(manifestHash).slice(2);
    const [latestRes, committedRes, countRes] = await Promise.all([
      arcRpc("eth_call", [{ to: registryAddress, data: MAN_SEL_LATEST }, "latest"]),
      arcRpc("eth_call", [{ to: registryAddress, data: MAN_SEL_ISCOMMITTED + arg }, "latest"]),
      arcRpc("eth_call", [{ to: registryAddress, data: MAN_SEL_COUNT }, "latest"]),
    ]);
    const latest = typeof latestRes === "string" ? latestRes : null;
    const committed = wordToNum(typeof committedRes === "string" ? committedRes : "0x0") === 1;
    const count = wordToNum(typeof countRes === "string" ? countRes : "0x0");
    const isLatest = !!latest && latest.toLowerCase() === bytes32(manifestHash).toLowerCase();
    return { latest, committed, count, isLatest };
  } catch { return null; }
}

/**
 * Read one genome's committed ancestry STRAIGHT off the on-chain ConnectomeLineage via eth_call — no murmur
 * server in the loop, so the breeding market's family tree is verifiable trustlessly. lineages(bytes32) returns
 * 7 words: genomeHash, parentA, parentB, op, generation, breeder, ts (ts==0 means never committed). Returns null
 * on transport/CORS failure (caller falls back to served fields), or { committed:false } when not anchored.
 */
async function readLineageOnchain(lineageAddress, genomeHash) {
  if (!isRealAddr(lineageAddress) || !genomeHash) return null;
  try {
    const res = await arcRpc("eth_call", [{ to: lineageAddress, data: LIN_SEL_LINEAGES + bytes32(genomeHash).slice(2) }, "latest"]);
    const hex = typeof res === "string" ? res.replace(/^0x/, "") : "";
    if (hex.length < 7 * 64) return { committed: false };
    const word = (i) => "0x" + hex.slice(i * 64, (i + 1) * 64);
    const ts = wordToNum(word(6));
    return {
      committed: ts !== 0,
      genomeHash: word(0), parentA: word(1), parentB: word(2),
      op: wordToNum(word(3)), generation: wordToNum(word(4)),
      breeder: "0x" + word(5).slice(2).slice(-40), ts,
    };
  } catch { return null; }
}

/** Read the ConnectomeLineage head (commitCount, latestHash, committer) straight off Arc — the tree's live status. */
async function readLineageHead(lineageAddress) {
  if (!isRealAddr(lineageAddress)) return null;
  try {
    const [c, l, m] = await Promise.all([
      arcRpc("eth_call", [{ to: lineageAddress, data: LIN_SEL_COUNT }, "latest"]),
      arcRpc("eth_call", [{ to: lineageAddress, data: LIN_SEL_LATEST }, "latest"]),
      arcRpc("eth_call", [{ to: lineageAddress, data: LIN_SEL_COMMITTER }, "latest"]),
    ]);
    return {
      commitCount: wordToNum(typeof c === "string" ? c : "0x0"),
      latestHash: typeof l === "string" && !isZeroBytes32(l) ? l : null,
      committer: typeof m === "string" ? "0x" + m.slice(2).slice(-40) : null,
    };
  } catch { return null; }
}
let econMode = "simulated";
let econTotals = null;
let econBalances = new Map();                         // flyId → balance in USDC (number)
let payEdges = [];                                    // { fromId, toId, amount, good, valid, t0 }
// The /population poll (every POLL_MS) is far faster than the on-chain tick (cron, ~60s), so the same
// `lastTick` batch is re-delivered many times between ticks. Without dedup every settlement would be
// drawn and logged ~15×. Keyed by real txHash (or tick+parties offline) so one transaction = one entry.
const seenSettlements = new Set();
const SEEN_CAP = 400;                                 // bounded: trim oldest half when exceeded
let econAgents = [];                                  // full roster from /economy: {id, address, balance, paid, earned, deals, sales}
let econSocial = null;      // social-memory read-out {rep[], bonds[], grudges[]} — who owes whom a grudge
let econDynasty = null;     // dynasty read-out {houses[], graves[], living, dead} — names, treasuries, monuments
let econMarket = null;      // ⑥ institutions read-out {marks, professions, classes, openIous, debt, run, …} — the tape
let econCulture = null;     // ⑤ culture read-out {trend, tradition} — the passing fashion & the houses holding the old way
let econCommons = null;     // ⑧ commons read-out {seatedEra, seats[], decrees[], effective} — the swarm's self-legislation
let econWar = null;         // ⑨ war coffer read-out from /war {houses[], wars[], stats, …} — on-chain vaults, bouts, tax purse
let walletsOpen = false;                              // right-side "all agent wallets" drawer
let chronOpen = false;                                // full-height chronicle drawer (bottom-right button)
// offline: a purely client-side mirror of the agent economy so the piece still settles pre-deploy
const synthAgents = new Map();                        // flyId → { address, balance, paid, earned, deals, sales } (atomic strings)
let synthVolume = 0, synthDeals = 0;

// ================= long-term history (D1-backed) =================
// The Worker archives one row per cron to D1 (temperature, regime, deals, cumulative settlements/volume,
// gini, behavioural histogram). We poll /history slowly (the archive only advances ~once a minute) and use
// it to (a) back the temperature ribbon so it survives reloads and reaches back toward launch, and (b) drive
// the "swarm history" drawer's multi-series charts + since-launch summary. All best-effort: no history ⇒ the
// scene is unchanged.
let histRows = [];            // ascending by tick: {tick, ts, temperature, regime, deals, settlements, volumeUsdc, gini, topState, topStates}
let histSummary = null;       // {ticks, firstTick, lastTick, firstTs, lastTs, settlements, volumeUsdc}
let histEnabled = false;      // false until /history reports a bound D1
let historyOpen = false;      // right-side "swarm history" drawer
const HIST_POLL_MS = 60000;   // the archive advances ~1×/min, so a 60s poll matches its true cadence
// Client-side netting surfacing (this session): how many per-trade placeholders we saw fold into nets, and
// how many netted settlements actually reached the chain — a live read-out of the gas-amortisation upgrade.
const netting = { folded: 0, settled: 0 };

// ================= the chronicle (the deterministic historian's narrative timeline) =================
// A pure read-out runs once per cron inside the DO: it watches the collective mood, the ethogram FAP
// distribution and the lifetime economy totals, and when a threshold is crossed (era shifts, first on-chain
// settlement, panic, great huddle, wealth record, leadership change, …) renders ONE template sentence and
// appends it to an ordered chronicle. Zero LLM, zero RNG, zero wallet/brain side-effects. /annals serves
// the last 300 entries from a hot ring buffer; D1 is the cold archive.
let chronRows = [];           // newest-first: {seq,tick,ts,kind,era,eraName,severity,actors[],text,metrics}
let chronMeta = null;         // {era, eraName, eraRegime, seq}
let chronEnabled = false;
let chronSeenSeq = 0;         // highest seq the ticker has already shown — only newer entries animate in
const CHRON_POLL_MS = 45000;  // chronicle advances rarely (threshold events); 45s is plenty responsive

// flow field + ambient ink motes
let flowTime = 0;
let motes = [];

// pointer (stirs the swarm)
const pointer = { x: 0, y: 0, inside: false, down: false };
let lastClickAt = 0;             // click-storm guard: cap interaction-driven work

// temperature history ribbon — now D1-backed. The live in-memory tail is merged with the archived per-cron
// series on a shared wall-clock axis, so the ribbon survives a reload and reaches back ~20 min (toward launch)
// instead of only showing the seconds since this tab opened. Without history it behaves as the old live view.
const tempHistory = [];              // live tail: {t: Date.now() ms, T: temperature}
const HIST_SAMPLE_MS = 1000;
const RIBBON_WINDOW = 20 * 60 * 1000;  // 20 min visible horizon
let lastHistSample = 0;

// (neural-feed state lives with the feed itself, further down)

// ============ swarm-mind aura + shard topology (the 10x infra, made visible) ============
// Two BACKGROUND layers on the main field, driven only by what the /population poll already delivers —
// the collective mood (for the aura) and the read-only `topology` (for the isolates). No extra polling
// and no per-neuron fetch: the aura is a stylised breath of the swarm's shared neural activity, and the
// ring of isolate nodes shows how the 24 flies are split across the FlyShardDO Durable Objects that let
// each brain grow to 10,800 neurons. Both are offscreen-cached or trivially cheap, per the perf budget.
let showMind = false, showShards = false, showSocieties = true, showGraves = true;
let topology = null;                                  // { sharded, shardCount, populationSize, fliesPerShard, shards:[{index,start,end}] }
let lastTickIndex = null, shardPulseT = -1e9;         // a new on-chain tick fires one fan-out pulse across the isolates
let mindOff = null, mindOffCtx = null, mindLast = 0, mindAngle = 0, mindSize = 0;
const MIND_REBUILD_MS = 320;                          // offscreen + low-frequency rebuild (per-frame is one drawImage)
// ---- illuminated-manuscript layers: an aged-parchment base + a gilded frame (offscreen, rebuilt rarely) ----
let parchOff = null, parchOffCtx = null, parchLast = 0, parchKey = "";

// ================= canvas field =================
const canvas = $("field");
const ctx = canvas.getContext("2d");
let VW = 0, VH = 0, DPR = 1;

// Pre-rendered soft halo sprite: drawing one cached radial is far cheaper than
// building a fresh createRadialGradient for every fly every frame.
let haloSprite = null;
function makeHaloSprite() {
  const s = document.createElement("canvas");
  s.width = s.height = 128;
  const c = s.getContext("2d");
  const g = c.createRadialGradient(64, 64, 0, 64, 64, 64);
  g.addColorStop(0, "rgba(45,42,37,1)");
  g.addColorStop(0.55, "rgba(45,42,37,0.32)");
  g.addColorStop(1, "rgba(45,42,37,0)");
  c.fillStyle = g;
  c.fillRect(0, 0, 128, 128);
  return s;
}

function resize() {
  VW = window.innerWidth; VH = window.innerHeight;
  DPR = Math.min(1.5, window.devicePixelRatio || 1);   // capped: full-bleed canvas fill is the main per-frame cost
  canvas.width = Math.round(VW * DPR);
  canvas.height = Math.round(VH * DPR);
  canvas.style.width = VW + "px";
  canvas.style.height = VH + "px";
  ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
  // repaint the paper solid so the trail buffer has a clean base
  ctx.fillStyle = rgb(paletteAt(tempSmoothed).paper);
  ctx.fillRect(0, 0, VW, VH);
  cachedRect = null;             // canvas box changed — drop the cached rect
  mindOff = null; mindSize = 0;  // the swarm-mind aura sprite must be rebuilt at the new field size
  parchOff = null; parchKey = "";   // parchment re-tiles at the new size (the gilt frame draws direct each frame)
  rebuildGraveField();           // the headstone band is laid out in field coordinates → re-place on resize
  initMotes();
}
window.addEventListener("resize", resize);

// ================= flow field =================
// A cheap curl-like field from summed sines; the whole swarm + the ambient motes
// ride it, and it speeds up as the market warms.
function flowAngle(x, y, t) {
  const s = 0.0021;
  const a =
    Math.sin(x * s + t * 0.021) +
    Math.sin(y * s * 1.3 - t * 0.017) +
    Math.sin((x + y) * s * 0.6 + t * 0.011);
  return a * Math.PI * 0.9;
}

function newMote() {
  const x = Math.random() * VW, y = Math.random() * VH;
  return { x, y, px: x, py: y, life: 0.6 + Math.random() * 0.6 };
}
function initMotes() {
  const count = clamp((VW * VH) / 22000, 48, 150) | 0;
  motes = [];
  for (let i = 0; i < count; i++) {
    const m = newMote();
    m.life = Math.random();       // stagger respawns so the field never blinks in unison
    motes.push(m);
  }
}
function updateMotes(dt) {
  const sp = 0.25 + tempSmoothed * 1.5;
  for (let i = 0; i < motes.length; i++) {
    const m = motes[i];
    m.px = m.x; m.py = m.y;
    const a = flowAngle(m.x, m.y, flowTime);
    m.x += Math.cos(a) * sp * dt;
    m.y += Math.sin(a) * sp * dt;
    m.life -= 0.0022 * dt;
    if (m.life <= 0 || m.x < -30 || m.x > VW + 30 || m.y < -30 || m.y > VH + 30) {
      motes[i] = newMote();
    }
  }
}
function renderMotes(pal) {
  if (!motes.length) return;
  const ink = mix([26, 26, 24], pal.accent, 0.35);
  ctx.lineWidth = 0.7;
  ctx.strokeStyle = rgba(ink, 0.02 + tempSmoothed * 0.05);
  ctx.beginPath();
  for (const m of motes) { ctx.moveTo(m.px, m.py); ctx.lineTo(m.x, m.y); }
  ctx.stroke();
}

// ================= flies =================
function spawnFly(id) {
  const ang = Math.random() * TAU, rad = Math.random() * Math.min(VW, VH) * 0.22;
  const bx = centroidX || VW / 2, by = centroidY || VH / 2;  // centre fallback on first spawn
  const x = bx + Math.cos(ang) * rad, y = by + Math.sin(ang) * rad;
  return {
    id,
    x, y, px: x, py: y,
    vx: 0, vy: 0,
    heading: Math.random() * TAU,
    wander: 0, phase: Math.random() * TAU,
    // smoothed drives (used by the sim) …
    aro: 0.3, coh: 0.5, turn: 0, wing: 0.3, rest: 0.3,
    balN: 0.5, tBalN: 0.5,   // normalised wallet balance (0 = poorest … 1 = richest) → drives body size
    // … and the latest authoritative server reading (used by the inspector)
    tAro: 0.3, tCoh: 0.5, tTurn: 0, tWing: 0.3, tRest: 0.3,
    state: "EXPLORE", temperament: 0.5, fingerprint: "",
    // ethogram read-out (never a settlement input): the named action pattern + its animation carriers
    fap: "FORAGE", tFap: "FORAGE", role: "", valence: 0, tValence: 0,
    tHeading: null, sHead: null, bouts: [], boutAge: 1,
    legPhase: Math.random() * TAU, courtSide: Math.random() < 0.5 ? -1 : 1,
    born: performance.now(), dying: false, dieT: 0,
  };
}

const SEP = 26;              // personal-space radius (css px)

function updateSim(dt, now) {
  // centroid of the living swarm
  let cx = 0, cy = 0, n = 0;
  for (const f of sim.values()) { if (!f.dying) { cx += f.x; cy += f.y; n++; } }
  if (n) { cx /= n; cy /= n; } else { cx = VW / 2; cy = VH / 2; }
  centroidX = cx; centroidY = cy;

  const T = tempSmoothed;
  const flowStr = 0.04 + T * 0.20;      // the current pushes harder when it is hot
  const list = [...sim.values()];

  // ---- societies (MVP) social force field: pre-compute each fly's colony pull into f.sx/f.sy ----
  //      A pure read-out of econSocial — bonded flies attract, feuders repel, colony anchors spread the
  //      societies apart. socOn=false ⇒ no accumulators touched ⇒ byte-for-byte today's boids physics.
  const socOn = showSocieties && societies && societies.colonies.length > 0;
  if (socOn) {
    const smx = Math.max(96, Math.round(VW * 0.21)), smy = Math.max(88, Math.round(VH * 0.19));
    for (const f of list) { f.sx = 0; f.sy = 0; }
    for (const c of societies.colonies) {
      const axp = smx + c.ax * (VW - 2 * smx), ayp = smy + c.ay * (VH - 2 * smy);
      for (const id of c.ids) { const f = sim.get(id); if (f && !f.dying) { f.sx += (axp - f.x) * SOCIETY_ANCHOR_K; f.sy += (ayp - f.y) * SOCIETY_ANCHOR_K; } }
    }
    // territories are exclusive jurisdictions: repel whole colonies so their bodies never merge
    const cents = [];
    for (const c of societies.colonies) {
      let x = 0, y = 0, n = 0, r = 0;
      for (const id of c.ids) { const f = sim.get(id); if (f && !f.dying) { x += f.x; y += f.y; n++; } }
      if (n) { x /= n; y /= n; for (const id of c.ids) { const f = sim.get(id); if (f && !f.dying) { const d = Math.hypot(f.x - x, f.y - y); if (d > r) r = d; } } }
      cents.push({ x, y, n, r: r + SOCIETY_PAD });
    }
    for (let i = 0; i < cents.length; i++) for (let j = i + 1; j < cents.length; j++) {
      const A = cents[i], B = cents[j]; if (A.n < 2 || B.n < 2) continue;
      const dx = B.x - A.x, dy = B.y - A.y, d = Math.hypot(dx, dy);
      const need = A.r + B.r + SOCIETY_TERR_GAP;
      if (d < 0.001 || d >= need) continue;
      const ux = dx / d, uy = dy / d, s = (need - d) * SOCIETY_TERR_K;
      for (const id of societies.colonies[i].ids) { const f = sim.get(id); if (f && !f.dying) { f.sx -= ux * s; f.sy -= uy * s; } }
      for (const id of societies.colonies[j].ids) { const f = sim.get(id); if (f && !f.dying) { f.sx += ux * s; f.sy += uy * s; } }
    }
    for (const p of societies.allies) {
      const a = sim.get(p.a), b = sim.get(p.b); if (!a || a.dying || !b || b.dying) continue;
      const dx = b.x - a.x, dy = b.y - a.y, d = Math.hypot(dx, dy) || 1, s = p.w * SOCIETY_ALLY_K;
      a.sx += (dx / d) * s; a.sy += (dy / d) * s; b.sx -= (dx / d) * s; b.sy -= (dy / d) * s;
    }
    for (const p of societies.feuds) {
      const a = sim.get(p.a), b = sim.get(p.b); if (!a || a.dying || !b || b.dying) continue;
      const dx = b.x - a.x, dy = b.y - a.y, d = Math.hypot(dx, dy) || 1;
      if (d > SOCIETY_FEUD_RANGE) continue;
      const s = p.w * SOCIETY_FEUD_K * (1 - d / SOCIETY_FEUD_RANGE);
      a.sx -= (dx / d) * s; a.sy -= (dy / d) * s; b.sx += (dx / d) * s; b.sy += (dy / d) * s;
    }
  }

  for (const f of list) {
    // fade-out retired flies, then drop them
    if (f.dying) {
      if (!f.dieT) f.dieT = now;
      if (now - f.dieT > 820) { sim.delete(f.id); continue; }
    }
    // ease drives toward the latest server reading
    f.aro = lerp(f.aro, f.tAro, 0.05 * dt);
    f.coh = lerp(f.coh, f.tCoh, 0.05 * dt);
    f.turn = lerp(f.turn, f.tTurn, 0.05 * dt);
    f.wing = lerp(f.wing, f.tWing, 0.05 * dt);
    f.rest = lerp(f.rest, f.tRest, 0.05 * dt);
    f.balN = lerp(f.balN ?? 0.5, f.tBalN ?? 0.5, 0.04 * dt);   // wealth → size eases smoothly, never jumps
    f.valence = lerp(f.valence, f.tValence ?? 0, 0.05 * dt);   // approach/avoid mood glides in
    // the ring-attractor compass (a persistent internal heading) eases toward the latest server value
    if (f.tHeading != null) {
      if (f.sHead == null) f.sHead = f.tHeading;
      else { const dh = ((f.tHeading - f.sHead + Math.PI * 3) % TAU) - Math.PI; f.sHead += dh * 0.06 * dt; }
    }

    const speed = (0.22 + f.aro * 2.3) * (1 - 0.55 * f.rest) * (FAP_SPEED[f.fap] ?? 1);

    // wander + turn bias → heading drift
    f.wander = (f.wander + (Math.random() - 0.5) * 0.5) * 0.92;
    f.heading += f.turn * 0.045 * dt + f.wander * 0.035 * dt + (Math.random() - 0.5) * 0.05 * (0.3 + f.aro) * dt;
    // a real fly holds a course: the persistent compass gently steers it between tumbles (weak, so the
    // flow field / collisions still win short-term, but each individual keeps a legible heading)
    if (f.sHead != null) { const dh = ((f.sHead - f.heading + Math.PI * 3) % TAU) - Math.PI; f.heading += dh * 0.012 * dt; }

    let ax = Math.cos(f.heading) * speed;
    let ay = Math.sin(f.heading) * speed;

    // ride the ambient flow field
    const fa = flowAngle(f.x, f.y, flowTime);
    ax += Math.cos(fa) * flowStr;
    ay += Math.sin(fa) * flowStr;

    // cohesion pulls toward the swarm centre; hot + low cohesion scatters outward
    const dx = cx - f.x, dy = cy - f.y, d = Math.hypot(dx, dy) || 1;
    ax += (dx / d) * f.coh * 0.75;
    ay += (dy / d) * f.coh * 0.75;
    ax -= (dx / d) * (1 - f.coh) * T * 0.7;
    ay -= (dy / d) * (1 - f.coh) * T * 0.7;

    // separation from neighbours (personal space); flies of DIFFERENT colonies keep extra distance so
    // the societies stay visually distinct (only when the social layer is on)
    for (const g of list) {
      if (g === f || g.dying) continue;
      const sx = f.x - g.x, sy = f.y - g.y, sd = Math.hypot(sx, sy);
      if (sd > 0 && sd < SEP) {
        let push = (SEP - sd) * 0.028;
        if (socOn && societies.colonyOf) { const ca = societies.colonyOf.get(f.id), cb = societies.colonyOf.get(g.id); if (ca != null && cb != null && ca !== cb) push *= 1.9; }
        ax += (sx / sd) * push; ay += (sy / sd) * push;
      }
    }

    // the social force field (societies MVP): colony anchor + ally pull + feud push, pre-computed above
    if (socOn) { ax += (f.sx || 0); ay += (f.sy || 0); }

    // the pointer stirs the swarm: hover draws flies in, press blows them apart
    if (pointer.inside) {
      const pdx = pointer.x - f.x, pdy = pointer.y - f.y, pd = Math.hypot(pdx, pdy) || 1;
      if (pointer.down) {
        const R = 200;
        if (pd < R) { const s = 2.8 * (1 - pd / R); ax -= (pdx / pd) * s; ay -= (pdy / pd) * s; }
      } else {
        const R = 135;
        if (pd < R) { const s = 0.55 * (1 - pd / R); ax += (pdx / pd) * s; ay += (pdy / pd) * s; }
      }
    }

    // blend velocity, integrate, keep on-canvas with a soft margin
    f.vx = lerp(f.vx, ax, 0.12 * dt);
    f.vy = lerp(f.vy, ay, 0.12 * dt);
    f.px = f.x; f.py = f.y;
    f.x += f.vx * dt; f.y += f.vy * dt;
    // confine the swarm to a centred activity region: inset so flies stay clear of the corner
    // panels and the field isn't mostly empty space, with a firmer push so they hold the region
    const mx = Math.max(96, Math.round(VW * 0.21));
    const my = Math.max(88, Math.round(VH * 0.19));
    if (f.x < mx) f.vx += (mx - f.x) * 0.017 * dt;
    if (f.x > VW - mx) f.vx -= (f.x - (VW - mx)) * 0.017 * dt;
    if (f.y < my) f.vy += (my - f.y) * 0.017 * dt;
    if (f.y > VH - my) f.vy -= (f.y - (VH - my)) * 0.017 * dt;
    f.x = clamp(f.x, 6, VW - 6); f.y = clamp(f.y, 6, VH - 6);
    if (Math.hypot(f.vx, f.vy) > 0.05) f.heading = Math.atan2(f.vy, f.vx);
    // wingbeat: the FAP sets the tempo (a bolting fly blurs, a resting one barely trembles)
    const flapRate = f.fap === "FLIGHT" ? 2.5 : f.fap === "RETREAT" ? 2.0 : f.fap === "COURT" ? 1.5
      : (f.fap === "REST" || f.fap === "HALT") ? 0.22 : 1;
    f.phase += (0.06 + f.wing * 0.55) * flapRate * dt;
    // the walking cycle advances with the gait speed (parked FAPs keep the legs nearly still)
    f.legPhase = (f.legPhase ?? 0) + (0.04 + speed * 0.55) * dt;
  }
}

// ---- swarm-mind ambient aura: a soft breathing bloom of the collective neural mood (deepest layer) ----
function rebuildMind(pal) {
  const D = mindSize;
  if (!mindOff) { mindOff = document.createElement("canvas"); mindOffCtx = mindOff.getContext("2d"); }
  if (mindOff.width !== D) { mindOff.width = mindOff.height = D; }
  const x = mindOffCtx, c = D / 2, C = collective, acc = pal.accent;
  x.clearRect(0, 0, D, D);
  const aro = C ? clamp(C.arousal) : 0.4;
  const vit = C ? clamp(C.vitality) : 0.5;
  const st = (C && C.states) || {}, tot = Math.max(1, (C && C.size) || 24);
  const agitate = (st.AGITATE || 0) / tot, aggregate = (st.AGGREGATE || 0) / tot, rest = (st.REST || 0) / tot;
  // core glow — brightness tracks vitality
  const g = x.createRadialGradient(c, c, 0, c, c, c * 0.95);
  g.addColorStop(0, rgba(acc, 0.05 + vit * 0.09));
  g.addColorStop(0.5, rgba(acc, 0.02 + vit * 0.035));
  g.addColorStop(1, rgba(acc, 0));
  x.fillStyle = g; x.beginPath(); x.arc(c, c, c * 0.95, 0, TAU); x.fill();
  // filaments — reach shimmers with mean arousal; agitation adds jitter, aggregation/rest pull them in
  const FIL = 96, R0 = c * 0.10, R1 = c * (0.50 + aro * 0.34);
  x.lineWidth = 1;
  for (let i = 0; i < FIL; i++) {
    const a = (i / FIL) * TAU;
    const shimmer = 0.72 + 0.28 * Math.sin(flowTime * 0.6 + i * 0.7);
    const jitter = 1 + agitate * 0.5 * (Math.sin(i * 12.9898 + flowTime) * 0.5 + 0.5) - aggregate * 0.22 - rest * 0.18;
    const r1 = R0 + (R1 - R0) * clamp(shimmer * jitter, 0.15, 1.3);
    x.strokeStyle = rgba(acc, 0.015 + aro * 0.045);
    x.beginPath();
    x.moveTo(c + Math.cos(a) * R0, c + Math.sin(a) * R0);
    x.lineTo(c + Math.cos(a) * r1, c + Math.sin(a) * r1);
    x.stroke();
  }
}
function renderMind(pal, now) {
  if (!showMind || !collective) return;
  if (!mindSize) mindSize = Math.round(clamp(Math.min(VW, VH) * 0.85, 320, 900));
  if (!mindOff || mindOff.width !== mindSize) mindOff = null;
  if (!mindOff || now - mindLast >= MIND_REBUILD_MS) { mindLast = now; rebuildMind(pal); }
  if (!mindOff) return;
  const cxr = centroidX || VW / 2, cyr = centroidY || VH / 2;
  const draw = (Math.min(VW, VH) * 1.05) / mindSize;   // let the aura reach most of the field
  mindAngle += 0.0009;
  ctx.save();
  ctx.globalAlpha = 0.42;
  ctx.translate(cxr, cyr);
  ctx.rotate(mindAngle);
  ctx.drawImage(mindOff, (-mindSize / 2) * draw, (-mindSize / 2) * draw, mindSize * draw, mindSize * draw);
  ctx.restore();
}

// ---- shard topology: the FlyShardDO isolates as a ring of compute nodes, pulsing in fan-out waves ----
function applyTopology(t) {
  if (!t || !Array.isArray(t.shards) || !t.shards.length) return;
  topology = t;
  const sb = document.querySelector('#layer-toggles [data-layer="shards"]');
  if (sb && t.shardCount) sb.textContent = `${t.shardCount} isolates`;   // never hardcode the count
}
function renderShards(pal, now) {
  if (!showShards || !topology || !topology.shards || topology.shards.length < 2) return;
  const acc = pal.accent, ink = [26, 26, 24];
  const shards = topology.shards, S = shards.length;
  const cxr = centroidX || VW / 2, cyr = centroidY || VH / 2;
  const ring = Math.min(VW, VH) * 0.315, nodeR = 13;
  const pulseAge = (now - shardPulseT) / 1500;
  ctx.save();
  ctx.lineWidth = 0.9;
  ctx.strokeStyle = rgba(mix(ink, acc, 0.2), 0.06);       // faint ring guide
  ctx.beginPath(); ctx.arc(cxr, cyr, ring, 0, TAU); ctx.stroke();
  ctx.textAlign = "center"; ctx.textBaseline = "middle";
  ctx.font = "8px ui-monospace, SFMono-Regular, Menlo, monospace";
  for (let i = 0; i < S; i++) {
    const s = shards[i];
    const a = (i / S) * TAU - Math.PI / 2;
    const nx = cxr + Math.cos(a) * ring, ny = cyr + Math.sin(a) * ring;
    let glow = 0;                                         // fan-out pulse: the runtime runs shards in ~ceil(N/6) waves of 6
    if (pulseAge >= 0 && pulseAge < 1) {
      const delay = (s.index % 6) / 6 * 0.4;
      const p = clamp((pulseAge - delay) / Math.max(0.001, 1 - delay));
      if (p > 0 && p < 1) glow = Math.sin(p * Math.PI);
    }
    ctx.fillStyle = rgba(acc, 0.03 + glow * 0.16);
    ctx.strokeStyle = rgba(mix(ink, acc, 0.35), 0.16 + glow * 0.5);
    ctx.beginPath(); ctx.arc(nx, ny, nodeR + glow * 4, 0, TAU); ctx.fill(); ctx.stroke();
    let k = 0; const span = s.end - s.start;
    for (let id = s.start; id < s.end; id++) {
      const f = sim.get(id);
      const col = (f && STATE_RGB[f.state]) || mix(ink, acc, 0.3);
      const dx = (k - (span - 1) / 2) * 6;
      ctx.fillStyle = rgba(col, f && !f.dying ? 0.8 : 0.25);
      ctx.beginPath(); ctx.arc(nx + dx, ny, 2.1, 0, TAU); ctx.fill();
      k++;
    }
    if (quality >= 2) { ctx.fillStyle = rgba(ink, 0.28 + glow * 0.4); ctx.fillText(String(s.index), nx, ny + nodeR + 8); }
  }
  ctx.restore();
}

// ================= societies (MVP): the social graph made visible on the canvas =================
// A pure read-out of econSocial.bonds/grudges, partitioned CLIENT-SIDE into "colonies" (connected
// components of the alliance graph). Bonded flies then pull together, feuds push apart, and each
// colony gets a soft territory aura + bond filaments. Never touches the server drives, the connectome,
// or the economy — showSocieties=false (or no social data) ⇒ zero force ⇒ byte-for-byte today's boids.
let societies = null;   // { colonies:[{ids,ax,ay,color,founder}], allies:[{a,b,w}], feuds:[{a,b,w}], colonyOf:Map<id,idx> }

const SOCIETY_BOND_MIN = 0.25;     // min bond score to count as an alliance edge
const SOCIETY_FEUD_MAX = -0.6;     // bond score at/under which two flies actively shun each other
const SOCIETY_ANCHOR_K = 0.0025;   // spring toward the colony's home anchor (gentle, ~ cohesion scale)
const SOCIETY_ALLY_K = 0.5;        // ally pull accel (unit vector × bond weight)
const SOCIETY_FEUD_K = 1.1;        // feud push accel, faded out beyond SOCIETY_FEUD_RANGE
const SOCIETY_FEUD_RANGE = 220;    // css px — grudges only shove when the flies are this close
const SOCIETY_PAD = 30;            // territory outline padding beyond the outermost member
const SOCIETY_TERR_GAP = 26;       // css px of clear space physics keeps between two territories
const SOCIETY_TERR_K = 0.02;       // colony-vs-colony repulsion strength (per px of overlap)
const SOCIETY_CAP_GAP = 12;        // css px gap enforced by the Voronoi cap when drawing
const SOCIETY_MINCAP = 24;         // a territory never shrinks below this radius (still exclusive)
// muted jewel/earth tones so colonies read on the light paper without clashing with the palette
const COLONY_COLORS = [
  [91, 124, 141], [154, 110, 90], [120, 140, 96], [176, 142, 86],
  [140, 104, 140], [96, 140, 138], [168, 110, 110], [124, 124, 168],
];
// evocative deterministic colony names, index-aligned with COLONY_COLORS so a colony keeps one identity
const COLONY_NAMES = ["Helios", "Nimbus", "Verdant", "Aurora", "Axiom", "Hearth", "Echo", "Quorum", "Solace", "Umbra", "Cinder", "Thistle"];
const GOLD_THREAD = [198, 152, 66];   // the reference's signature "gold thread" for intra-colony bonds
const CRACK_RED = [198, 60, 44];      // conflict / grudge cracks between rivals
const fnv1a = (str) => { let h = 0x811c9dc5; for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; } return h >>> 0; };

// ---- lineage (dynasty bloodline) + chronicle-event layers --------------------------------
// House names ARE colour words, so the bloodline tint is the name itself: a thin ring on every fly
// plus a house-tinted ink trail, so a family reads as coloured streaks inside its colony.
const HOUSE_COLORS = {
  ochre: [196, 148, 60], ivory: [214, 206, 182], ashen: [148, 150, 154], vermilion: [198, 70, 48],
  amber: [214, 164, 64], slate: [110, 126, 146], sage: [140, 164, 120], plum: [150, 104, 140],
  teal: [86, 150, 150], rust: [170, 96, 60], indigo: [92, 102, 170], rose: [190, 110, 130],
  sable: [96, 84, 72], verdant: [120, 140, 96], azure: [96, 132, 176], crimson: [178, 58, 66],
};
const HOUSE_FALLBACK = [[176, 142, 86], [140, 104, 140], [96, 140, 138], [168, 110, 110], [124, 124, 168], [154, 110, 90]];
function houseColor(name) {
  if (!name) return null;
  const k = String(name).toLowerCase();
  if (HOUSE_COLORS[k]) return HOUSE_COLORS[k];
  for (const w in HOUSE_COLORS) if (k.includes(w)) return HOUSE_COLORS[w];
  return HOUSE_FALLBACK[fnv1a(k) % HOUSE_FALLBACK.length];
}

let hoverId = null;                       // fly under the pointer (throttled pick) — hover half of focus
let focusCacheId = null, focusSet = null; // cached highlight set: focus + its colony + its bonds/feuds
const houseOf = new Map();                // flyId → {name, sigil, color} — the bloodline, from /economy agents
const monuments = [];                     // fading grave steles at OBSERVED death positions
const chronFx = [];                       // transient canvas events spawned by fresh chronicle entries
const MONUMENT_MS = 42000;                // how long a stele lingers before it fades into the paper
// ---- the persistent necropolis: headstones rebuilt from the server's grave ledger (econDynasty.graves) ----
const graveField = [];                    // stable, weathered stones scattered across the field's lower band
let selectedGrave = null;                 // the stone whose epitaph card is open
const GRAVE_CAP = 120;                    // most-recent stones kept on the field
// A reused slot id (live-retirement recycles a dead fly's id for its offspring) means id alone no longer
// identifies an individual — (id, bornTick) does. Stones + selection key on this composite so a new
// occupant of an old id never aliases the grave of the fly that was buried in that slot before it.
const graveUid = (id, bornTick) => id + ":" + (bornTick == null ? "" : bornTick);
const GILT = [176, 138, 54];              // gold-leaf
const GILT_HI = [214, 178, 92];           // gold highlight
const INK = [40, 32, 24];                 // sepia ink for engraved text
const VELLUM = [236, 227, 208];           // aged parchment base tone
let chronBanner = null;                   // the epic centre-caption flashed when the chronicle "happens"
const LAW_GOLD = [186, 152, 66];          // the legislative shockwave tint (assembly / decree)

function rebuildHouseMap() {
  houseOf.clear();
  for (const ag of econAgents) {
    if (ag && ag.house) houseOf.set(ag.id, { name: ag.house, sigil: ag.sigil || "", color: houseColor(ag.house) });
  }
  focusCacheId = null;                    // house tints feed the focus set; invalidate the cache
}

/** The fly the eye is on: pointer hover wins, else the persisted inspector selection. */
function currentFocus() { return hoverId != null ? hoverId : selectedId; }
/** 1 for flies inside the focus's social neighbourhood, ~0.16 for everyone else (the "fade the rest"). */
function focusDim(id) {
  const foc = currentFocus();
  if (foc == null) return 1;
  if (focusCacheId !== foc) {
    focusCacheId = foc;
    const s = new Set([foc]);
    if (societies) {
      const ci = societies.colonyOf.get(foc);
      if (ci != null && societies.colonies[ci]) for (const m of societies.colonies[ci].ids) s.add(m);
      for (const p of societies.allies) { if (p.a === foc) s.add(p.b); else if (p.b === foc) s.add(p.a); }
      for (const p of societies.feuds) { if (p.a === foc) s.add(p.b); else if (p.b === foc) s.add(p.a); }
    }
    focusSet = s;
  }
  return focusSet.has(id) ? 1 : 0.12;
}

/** Plant a fading grave stele where a fly is observed dying (its death position). */
function plantMonument(f, now) {
  f._mon = true;
  // Dedup only against OTHER live transient steles of this id (an id may be recycled to a new fly after the
  // dead one is memorialised as a permanent stone, so we never suppress a fresh death on an OLD grave's id).
  if (monuments.some((m) => m.id === f.id && now - m.t0 < MONUMENT_MS)) return;
  const h = houseOf.get(f.id);
  monuments.push({ x: f.x, y: f.y, t0: now, id: f.id, sigil: (h && h.sigil) || "", color: (h && h.color) || [120, 120, 124], pulse: 0 });
  if (monuments.length > 48) monuments.shift();
}

/** Fading grave steles: a small headstone + a contracting house ring at each observed death spot. */
function renderMonuments(pal, now) {
  for (let i = monuments.length - 1; i >= 0; i--) {
    const m = monuments[i];
    const age = (now - m.t0) / MONUMENT_MS;
    if (age >= 1) { monuments.splice(i, 1); continue; }
    const fade = 1 - age;
    const pulse = m.pulse ? Math.max(0, 1 - (now - m.pulse) / 900) : 0;   // an ELEGY re-lights its stele
    const col = m.color;
    ctx.save();
    ctx.globalAlpha = fade * (0.8 + pulse * 0.2);
    // a soft ground shadow so the stele sits ON the paper, not floats over it
    ctx.fillStyle = rgba(col, 0.14);
    ctx.beginPath(); ctx.ellipse(m.x, m.y + 7, 11, 3.4, 0, 0, TAU); ctx.fill();
    // a larger headstone slab
    ctx.fillStyle = rgba(col, 0.42);
    ctx.beginPath();
    ctx.moveTo(m.x - 6, m.y + 7); ctx.lineTo(m.x - 6, m.y - 4);
    ctx.quadraticCurveTo(m.x - 6, m.y - 11, m.x, m.y - 11);
    ctx.quadraticCurveTo(m.x + 6, m.y - 11, m.x + 6, m.y - 4);
    ctx.lineTo(m.x + 6, m.y + 7);
    ctx.closePath(); ctx.fill();
    ctx.strokeStyle = rgba(col, 0.7); ctx.lineWidth = 1.2;
    ctx.beginPath(); ctx.arc(m.x, m.y, 12 + pulse * 8, 0, TAU); ctx.stroke();
    ctx.font = "600 12px ui-monospace, SFMono-Regular, Menlo, monospace";
    ctx.textAlign = "center"; ctx.textBaseline = "top";
    ctx.fillStyle = rgba(col, 0.9);
    ctx.fillText("†" + m.sigil, m.x, m.y + 9);
    ctx.font = "8px ui-monospace, SFMono-Regular, Menlo, monospace";
    ctx.fillStyle = rgba(col, 0.6);
    ctx.fillText("#" + m.id, m.x, m.y + 22);
    ctx.restore();
  }
}

// ================= illuminated-manuscript layers: parchment base + gilded frame + necropolis =================
/** Build the aged-parchment base once into an offscreen (re-run on resize / temperature-bucket change /
 *  ~2s): the live paper pulled toward vellum, deterministic foxing blotches + fibre speckle, and burnt
 *  edges. Per-frame it is a single blit, so the costly texture never redraws on the hot path. */
function rebuildParchment(pal) {
  if (!parchOff) { parchOff = document.createElement("canvas"); parchOffCtx = parchOff.getContext("2d"); }
  if (parchOff.width !== VW || parchOff.height !== VH) { parchOff.width = VW; parchOff.height = VH; }
  const x = parchOffCtx;
  x.setTransform(1, 0, 0, 1, 0, 0);
  const base = mix(pal.paper, VELLUM, 0.55);
  x.fillStyle = rgb(base); x.fillRect(0, 0, VW, VH);
  // deterministic foxing: soft radial stains (water marks / ageing) seeded by index, so they never crawl
  const nb = Math.max(8, Math.round((VW * VH) / 22000));
  for (let i = 0; i < nb; i++) {
    const a = fnv1a("fox:" + i), b = fnv1a("fox2:" + i);
    const bx = (a % 100000) / 100000 * VW, by = (b % 100000) / 100000 * VH;
    const br = 46 + ((a >>> 8) % 120);
    const warm = (b & 3) !== 0;
    const tone = warm ? mix(base, [150, 118, 74], 0.5) : mix(base, [120, 108, 84], 0.4);
    const g = x.createRadialGradient(bx, by, 0, bx, by, br);
    g.addColorStop(0, rgba(tone, warm ? 0.085 : 0.05));
    g.addColorStop(1, rgba(tone, 0));
    x.fillStyle = g; x.beginPath(); x.arc(bx, by, br, 0, TAU); x.fill();
  }
  // paper fibre: a light speckle of 1px flecks (bounded so huge viewports stay cheap)
  const nf = Math.min(1500, Math.round((VW * VH) / 1300));
  for (let i = 0; i < nf; i++) {
    const a = fnv1a("fib:" + i);
    const fx = (a % 100000) / 100000 * VW, fy = ((a >>> 9) % 100000) / 100000 * VH;
    x.fillStyle = rgba(INK, 0.02 + ((a >>> 3) & 7) / 7 * 0.022);
    x.fillRect(fx, fy, 1, 1);
  }
  // burnt / aged edges: darken toward the border so the sheet reads as handled vellum
  const eg = x.createRadialGradient(VW / 2, VH / 2, Math.min(VW, VH) * 0.34, VW / 2, VH / 2, Math.max(VW, VH) * 0.72);
  eg.addColorStop(0, rgba(INK, 0));
  eg.addColorStop(1, rgba(mix(base, [110, 86, 54], 0.6), 0.22));
  x.fillStyle = eg; x.fillRect(0, 0, VW, VH);
}

/** A gilded lozenge + curl tucked into one corner; the sign vector mirrors it across the four corners. */
function drawCorner(cx, cy, sx, sy) {
  ctx.save();
  ctx.translate(cx, cy); ctx.scale(sx, sy);
  ctx.fillStyle = rgba(GILT_HI, 0.55);
  ctx.beginPath(); ctx.moveTo(0, 0); ctx.lineTo(9, 0); ctx.lineTo(0, 9); ctx.closePath(); ctx.fill();
  ctx.strokeStyle = rgba(GILT, 0.55); ctx.lineWidth = 1;
  ctx.beginPath(); ctx.moveTo(2, 15); ctx.quadraticCurveTo(15, 15, 15, 2); ctx.stroke();
  ctx.fillStyle = rgba(GILT, 0.5); ctx.beginPath(); ctx.arc(6, 6, 1.6, 0, TAU); ctx.fill();
  ctx.restore();
}

/** The manuscript border: a double gold rule + a hairline margin guide + four corner flourishes, drawn
 *  direct each frame (a dozen path ops — far cheaper than a full-screen alpha blit of a mostly-clear layer). */
function renderFrame(pal) {
  const m = 13;
  ctx.save();
  ctx.lineWidth = 2; ctx.strokeStyle = rgba(GILT, 0.5); ctx.strokeRect(m, m, VW - 2 * m, VH - 2 * m);
  ctx.lineWidth = 1; ctx.strokeStyle = rgba(GILT, 0.34); ctx.strokeRect(m + 4.5, m + 4.5, VW - 2 * (m + 4.5), VH - 2 * (m + 4.5));
  ctx.lineWidth = 1; ctx.strokeStyle = rgba(INK, 0.06); ctx.strokeRect(m + 15, m + 15, VW - 2 * (m + 15), VH - 2 * (m + 15));
  drawCorner(m, m, 1, 1); drawCorner(VW - m, m, -1, 1); drawCorner(m, VH - m, 1, -1); drawCorner(VW - m, VH - m, -1, -1);
  ctx.restore();
}

/** Re-place the persistent necropolis from the server's grave ledger (econDynasty.graves). Deterministic:
 *  the newest ≤GRAVE_CAP stones cluster by house into adjacent family plots along the field's lower band
 *  (clear of the left panel + right drawer), each weathered by how long ago it fell. */
function rebuildGraveField() {
  graveField.length = 0;
  const graves = (econDynasty && econDynasty.graves) || [];
  if (!graves.length || !VW || !VH) return;
  const gs = graves.slice().sort((a, b) => (b.tick || 0) - (a.tick || 0)).slice(0, GRAVE_CAP);   // newest first
  const byHouse = new Map();
  for (const g of gs) {
    const k = g.houseName || "";
    let arr = byHouse.get(k); if (!arr) { arr = []; byHouse.set(k, arr); }
    arr.push(g);
  }
  // houses (biggest bloodline first) lead, the houseless commons trails, so kin share a plot
  const groups = [...byHouse.entries()].sort((a, b) =>
    (a[0] === "" ? 1 : b[0] === "" ? -1 : b[1].length - a[1].length));
  const ordered = [];
  for (const [, arr] of groups) for (const g of arr) ordered.push(g);
  const x0 = VW * 0.18, x1 = VW * 0.82, y0 = VH * 0.72, y1 = VH * 0.93;
  const bandW = x1 - x0, bandH = y1 - y0, n = ordered.length;
  const cols = clamp(Math.round(bandW / 46), 4, 20) | 0;
  const rows = Math.max(1, Math.ceil(n / cols));
  const cw = bandW / cols, ch = bandH / rows;
  let maxTick = -Infinity, minTick = Infinity;
  for (const g of ordered) { const t = g.tick || 0; if (t > maxTick) maxTick = t; if (t < minTick) minTick = t; }
  const span = Math.max(1, maxTick - minTick);
  for (let i = 0; i < n; i++) {
    const g = ordered[i], r = (i / cols) | 0, c = i % cols;
    const h = fnv1a("grave:" + g.id + ":" + (g.bornTick == null ? 0 : g.bornTick));   // (id,bornTick): a recycled id scatters to its OWN plot
    const jx = ((h % 1000) / 1000 - 0.5), jy = (((h >>> 10) % 1000) / 1000 - 0.5);
    const x = x0 + cw * (c + 0.5) + jx * cw * 0.34;
    const y = y0 + ch * (r + 0.5) + jy * ch * 0.28;
    const weather = clamp(((maxTick - (g.tick || 0)) / span) * 0.85 + ((h >>> 4) % 100) / 100 * 0.15);
    graveField.push({
      id: g.id, bornTick: g.bornTick == null ? null : g.bornTick, uid: graveUid(g.id, g.bornTick), x, y,
      houseName: g.houseName || "", cause: g.cause || "", deals: g.deals || 0,
      estateUsdc: Number(g.estateUsdc) || 0, heirIds: g.heirIds || [], age: g.age || 0, tick: g.tick || 0,
      color: houseColor(g.houseName) || [120, 116, 108],
      sigil: g.houseName ? String(g.houseName).trim().charAt(0).toUpperCase() : "",
      tilt: (((h >>> 6) % 100) / 100 - 0.5) * weather * 0.16,   // the oldest stones lean into the ground
      weather, seed: h,
    });
  }
  if (selectedGrave) { const keep = graveField.find((g) => g.uid === selectedGrave.uid); selectedGrave = keep || null; }
}

/** An arched headstone silhouette centred on the origin: flat base at +h, rounded top at -h. */
function stonePath(c, w, h) {
  c.beginPath();
  c.moveTo(-w, h); c.lineTo(-w, -h * 0.28);
  c.quadraticCurveTo(-w, -h, 0, -h);
  c.quadraticCurveTo(w, -h, w, -h * 0.28);
  c.lineTo(w, h); c.closePath();
}

/** The engraved death-mark: † aged, ☠ plague, ⛁ penury (the empty purse already used by the debt badge). */
function glyphFor(g) {
  if (g.cause === "plague") return "☠";
  if (g.cause === "penury") return "⛁";
  return "†";
}

/** Draw the necropolis: a weathered stone per buried wallet. Thinned under load (every Nth stone) and
 *  gated by the graveyard toggle; the selected stone wears a gilded halo. */
function renderGraveyard(pal, now) {
  if (!showGraves || !graveField.length) return;
  const step = quality >= 2 ? 1 : quality >= 1 ? 2 : 3;   // thin under load: draw every Nth stone
  ctx.save();
  ctx.textAlign = "center";
  for (let i = 0; i < graveField.length; i += step) {
    const g = graveField[i], wx = g.weather, w = 8, h = 12;
    const sel = selectedGrave && selectedGrave.uid === g.uid;
    const stone = mix([151, 143, 129], INK, 0.18 + wx * 0.42);   // fresh warm stone → dark weathered
    ctx.save();
    ctx.translate(g.x, g.y); ctx.rotate(g.tilt);
    ctx.fillStyle = rgba([40, 34, 26], 0.16);                     // ground shadow
    ctx.beginPath(); ctx.ellipse(0, h + 2, w + 3, 3.2, 0, 0, TAU); ctx.fill();
    stonePath(ctx, w, h); ctx.fillStyle = rgb(stone); ctx.fill();
    ctx.lineWidth = 1; ctx.strokeStyle = rgba(INK, 0.5); ctx.stroke();
    ctx.strokeStyle = rgba(GILT_HI, 0.5); ctx.lineWidth = 1.1;    // gilt highlight on the top-left rim
    ctx.beginPath(); ctx.moveTo(-w, h * 0.2); ctx.lineTo(-w, -h * 0.28);
    ctx.quadraticCurveTo(-w, -h, 0, -h); ctx.stroke();
    ctx.textBaseline = "middle";
    ctx.font = "600 9px ui-monospace, SFMono-Regular, Menlo, monospace";
    ctx.fillStyle = rgba(INK, 0.72); ctx.fillText(glyphFor(g), 0, -h * 0.34);   // the death-mark
    ctx.font = "7px ui-monospace, SFMono-Regular, Menlo, monospace";
    ctx.fillStyle = rgba(INK, 0.5); ctx.fillText("#" + g.id, 0, h * 0.36);      // the buried wallet
    if (wx > 0.45) {                                                            // weathering cracks
      ctx.strokeStyle = rgba(INK, 0.32 * wx); ctx.lineWidth = 0.6;
      const cx = ((g.seed >>> 3) % (w * 2)) - w;
      ctx.beginPath(); ctx.moveTo(cx, -h * 0.6); ctx.lineTo(cx + 2, -h * 0.1); ctx.lineTo(cx - 1, h * 0.4); ctx.stroke();
    }
    ctx.restore();
    if (wx > 0.5 && quality >= 1) {                               // moss creeping up the base
      ctx.fillStyle = rgba([96, 120, 76], 0.5 * wx);
      ctx.beginPath(); ctx.ellipse(g.x - w + 2, g.y + h + 1, 2.4, 1.1, 0, 0, TAU);
      ctx.ellipse(g.x + w - 2, g.y + h + 1, 2.0, 1.0, 0, 0, TAU); ctx.fill();
    }
    if (sel) {                                                    // a gilded halo on the chosen stone
      ctx.strokeStyle = rgba(GILT, 0.9); ctx.lineWidth = 1.6;
      ctx.beginPath(); ctx.arc(g.x, g.y - 1, h + 7, 0, TAU); ctx.stroke();
      ctx.strokeStyle = rgba(GILT_HI, 0.5); ctx.lineWidth = 0.8;
      ctx.beginPath(); ctx.arc(g.x, g.y - 1, h + 10, 0, TAU); ctx.stroke();
    }
  }
  ctx.restore();
}

/** Open the epitaph card for a buried wallet. A DOM overlay (not canvas type) so every line stays crisp,
 *  mirrors under RTL and re-localises on the fly — geometry stays LTR, only the text direction flips. */
function showEpitaph(g) {
  selectedGrave = g;
  const card = $("epitaph"); if (!card) return;
  const head = $("epitaph-title");
  const house = g.houseName ? T("epitaph.house", { name: g.houseName }) : T("dyn.noHouse");
  // born# disambiguates two individuals that shared the SAME recycled slot id in different generations.
  const born = g.bornTick == null ? "" : " \u00b7 born#" + g.bornTick;
  if (head) head.textContent = glyphFor(g) + " #" + g.id + born + " \u00b7 " + house;   // the mark matches the stone's own death-mark
  const heirs = g.heirIds && g.heirIds.length ? g.heirIds.map((x) => "#" + x).join(", ") : T("dyn.theCommons");
  const cause = g.cause ? gl("cause", g.cause) : "\u2014";
  const lines = [
    ["\u2020", T("epitaph.died", { cause })],
    ["\u2696", T("epitaph.deals", { n: g.deals })],
    ["\u23f3", T("epitaph.age", { age: g.age })],
    ["\u25c7", T("epitaph.estate", { amt: Number(g.estateUsdc).toFixed(4) })],
    ["\u2192", T("epitaph.heirs", { heirs })],
  ];
  if (g.bornTick != null) lines.push(["\u2600", T("epitaph.born", { tick: g.bornTick })]);
  lines.push(["#", T("epitaph.tick", { tick: g.tick })]);
  const body = $("epitaph-body");
  if (body) {
    body.textContent = "";
    for (const [mark, text] of lines) {
      const d = document.createElement("div"); d.className = "ep-line";
      const s = document.createElement("span"); s.className = "ep-mark"; s.textContent = mark;
      const v = document.createElement("span"); v.className = "ep-val"; v.textContent = text;
      d.appendChild(s); d.appendChild(v); body.appendChild(d);
    }
  }
  card.hidden = false;
}
function hideEpitaph() {
  selectedGrave = null;
  const card = $("epitaph"); if (card) card.hidden = true;
}

/** The chronicle made visible: every fresh ALLIANCE/FEUD/BETRAYAL/HOUSE_FOUNDED/ASSEMBLY/DECREE entry
 *  becomes a transient canvas event at the actors' live positions, so each annals sentence can be
 *  WATCHED happening on the field. */
function renderChronFx(pal, now) {
  // the epic centre-caption: the chronicle announcing itself in big serif type
  if (chronBanner) {
    const ba = (now - chronBanner.t0) / chronBanner.dur;
    if (ba >= 1) chronBanner = null;
    else {
      const env = Math.sin(Math.PI * Math.min(1, ba));
      const cx = VW / 2, cy = VH * 0.30;
      const chars = Array.from(chronBanner.text || "");
      const cap = chars.length ? chars[0] : "";
      const rest = chars.slice(1).join("");
      const box = 52;
      ctx.save();
      ctx.textBaseline = "middle";
      ctx.globalAlpha = env;
      // measure the trailing line so the whole drop-cap + text composite sits centred on the field
      ctx.font = "italic 600 26px Fraunces, Georgia, serif";
      const totalW = box + 10 + ctx.measureText(rest).width;
      const left = Math.max(cx - totalW / 2, box / 2 + 14);
      // the gilded initial: a vellum field, a double gold rule, the capital in monumental Roman caps
      ctx.fillStyle = rgba(mix(chronBanner.color, VELLUM, 0.74), 0.92);
      ctx.fillRect(left, cy - box / 2, box, box);
      ctx.lineWidth = 2; ctx.strokeStyle = rgba(GILT, 0.95); ctx.strokeRect(left, cy - box / 2, box, box);
      ctx.lineWidth = 1; ctx.strokeStyle = rgba(GILT_HI, 0.85); ctx.strokeRect(left + 3.5, cy - box / 2 + 3.5, box - 7, box - 7);
      ctx.textAlign = "center";
      ctx.font = "600 38px Cinzel, Fraunces, Georgia, serif";
      ctx.fillStyle = rgba(INK, 0.92);
      ctx.fillText(cap, left + box / 2, cy + 1);
      // the rest of the sentence, hung to the right of the initial
      ctx.textAlign = "left";
      ctx.font = "italic 600 26px Fraunces, Georgia, serif";
      ctx.fillStyle = rgba(chronBanner.color, 0.92);
      ctx.fillText(rest, left + box + 10, cy);
      if (chronBanner.sub) {
        ctx.textAlign = "center";
        ctx.globalAlpha = env * 0.7;
        ctx.font = "600 10px ui-monospace, SFMono-Regular, Menlo, monospace";
        ctx.fillStyle = rgba(chronBanner.color, 0.85);
        ctx.fillText(chronBanner.sub, cx, cy + box / 2 + 15);
      }
      ctx.restore();
    }
  }
  for (let i = chronFx.length - 1; i >= 0; i--) {
    const fx = chronFx[i];
    const age = (now - fx.t0) / fx.dur;
    if (age >= 1) { chronFx.splice(i, 1); continue; }
    const env = Math.sin(Math.PI * Math.min(1, age));      // fast in, slow out
    if (fx.kind === "law") {
      // a whole-field legislative shockwave: a faint gold wash + two expanding rings
      ctx.fillStyle = rgba(LAW_GOLD, (1 - age) * 0.05);
      ctx.fillRect(0, 0, VW, VH);
      const R = age * Math.min(VW, VH) * 0.62;
      ctx.strokeStyle = rgba(LAW_GOLD, (1 - age) * 0.5); ctx.lineWidth = 3.0 * (1 - age) + 0.5;
      ctx.beginPath(); ctx.arc(VW / 2, VH / 2, R, 0, TAU); ctx.stroke();
      ctx.strokeStyle = rgba(LAW_GOLD, (1 - age) * 0.3); ctx.lineWidth = 1.4;
      ctx.beginPath(); ctx.arc(VW / 2, VH / 2, R * 0.72, 0, TAU); ctx.stroke();
      continue;
    }
    if (fx.kind === "house") {
      const f = sim.get(fx.a);
      const x = f ? f.x : fx.x, y = f ? f.y : fx.y;
      if (x == null) continue;
      ctx.save();
      ctx.globalAlpha = env;
      ctx.strokeStyle = rgba(fx.color, 0.9); ctx.lineWidth = 2.2;
      ctx.beginPath(); ctx.arc(x, y, 14 + age * 40, 0, TAU); ctx.stroke();
      ctx.strokeStyle = rgba(fx.color, 0.4); ctx.lineWidth = 1;
      ctx.beginPath(); ctx.arc(x, y, 8 + age * 26, 0, TAU); ctx.stroke();
      ctx.font = "600 22px ui-monospace, SFMono-Regular, Menlo, monospace";
      ctx.textAlign = "center"; ctx.textBaseline = "middle";
      ctx.fillStyle = rgba(fx.color, 0.95);
      ctx.fillText(fx.sigil, x, y - 20 - age * 14);
      ctx.restore();
      continue;
    }
    const a = sim.get(fx.a), b = sim.get(fx.b);
    if (!a || !b) continue;
    const colr = fx.kind === "alliance" ? GOLD_THREAD : CRACK_RED;
    // shockwave rings bursting from each actor so the eye is drawn to the pair
    ctx.strokeStyle = rgba(colr, env * 0.45); ctx.lineWidth = 1.4;
    ctx.beginPath(); ctx.arc(a.x, a.y, 6 + age * 42, 0, TAU); ctx.stroke();
    ctx.beginPath(); ctx.arc(b.x, b.y, 6 + age * 42, 0, TAU); ctx.stroke();
    if (fx.kind === "alliance") {
      ctx.strokeStyle = rgba(GOLD_THREAD, env * 0.95); ctx.lineWidth = 2.6;
      ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
      ctx.strokeStyle = rgba(GOLD_THREAD, env * 0.6); ctx.lineWidth = 1.6;
      ctx.beginPath(); ctx.arc((a.x + b.x) / 2, (a.y + b.y) / 2, 6 + age * 30, 0, TAU); ctx.stroke();
    } else {   // feud / betrayal: a red rift flashing open between the two
      ctx.strokeStyle = rgba(CRACK_RED, env * 0.95); ctx.lineWidth = 2.4;
      traceCrack(a, b); ctx.stroke();
    }
  }
}

/** Turn one fresh chronicle entry into a canvas event (+ a one-shot social impulse so an alliance
 *  visibly pulls its two colonies together for an instant, a feud shoves them apart). */
function spawnChronFx(e) {
  const actors = Array.isArray(e.actors) ? e.actors : [];
  const a = actors[0], b = actors[1];
  const now = performance.now();
  if (e.kind === "ALLIANCE") {
    if (a == null || b == null) return;
    chronFx.push({ kind: "alliance", a, b, t0: now, dur: 2600 });
    setBanner(T("banner.alliance"), T("banner.fly", { id: a }) + " · " + T("banner.fly", { id: b }), GOLD_THREAD);
    chronNudge(a, b, +1);
  } else if (e.kind === "FEUD" || e.kind === "BETRAYAL") {
    if (a == null || b == null) return;
    chronFx.push({ kind: "feud", a, b, t0: now, dur: 2200 });
    setBanner(e.kind === "BETRAYAL" ? T("banner.betrayal") : T("banner.feud"), T("banner.fly", { id: a }) + " · " + T("banner.fly", { id: b }), CRACK_RED);
    chronNudge(a, b, -1);
  } else if (e.kind === "HOUSE_FOUNDED") {
    if (a == null) return;
    const h = houseOf.get(a), f = sim.get(a);
    chronFx.push({ kind: "house", a, x: f ? f.x : null, y: f ? f.y : null, sigil: (h && h.sigil) || "", color: (h && h.color) || LAW_GOLD, t0: now, dur: 3200 });
    setBanner(T("banner.house"), h ? T("banner.houseOf", { name: h.name }) : T("banner.fly", { id: a }), (h && h.color) || LAW_GOLD);
  } else if (e.kind === "ASSEMBLY" || e.kind === "DECREE") {
    chronFx.push({ kind: "law", t0: now, dur: 3400 });
    setBanner(e.kind === "ASSEMBLY" ? T("banner.assembly") : T("banner.decree"), T("banner.commonsLaw"), LAW_GOLD);
  } else if (e.kind === "ELEGY") {
    const m = monuments.find((mm) => mm.id === a);
    if (m) m.pulse = now;
    setBanner(T("banner.elegy"), T("banner.fly", { id: a }), [120, 120, 124]);
  }
}
/** Flash the epic centre-caption for a chronicle event. */
function setBanner(text, sub, color) {
  chronBanner = { text, sub, color, t0: performance.now(), dur: 2600 };
}
/** One-shot impulse along the axis between two flies' colonies: +1 draws them together (a new
 *  alliance), -1 shoves them apart (a new feud). Tiny and instantaneous — flavour, not physics. */
function chronNudge(a, b, sign) {
  const fa = sim.get(a), fb = sim.get(b);
  if (!fa || !fb) return;
  const dx = fb.x - fa.x, dy = fb.y - fa.y, d = Math.hypot(dx, dy) || 1;
  const ux = dx / d, uy = dy / d, s = 0.5 * sign;
  const push = (ci, dir, solo) => {
    if (ci != null && societies && societies.colonies[ci]) {
      for (const id of societies.colonies[ci].ids) { const f = sim.get(id); if (f && !f.dying) { f.vx += ux * s * dir; f.vy += uy * s * dir; } }
    } else {
      const f = sim.get(solo); if (f && !f.dying) { f.vx += ux * s * dir; f.vy += uy * s * dir; }
    }
  };
  const ca = societies ? societies.colonyOf.get(a) : undefined;
  const cb = societies ? societies.colonyOf.get(b) : undefined;
  push(ca, +1, a); push(cb, -1, b);
}

/** Weighted-modularity community detection (Louvain local-moving, single level). The live bond graph is
 *  sparse and chain-like, so plain connected-components would lump the whole swarm into ONE colony; this
 *  splits it into the tight little societies that actually exist. Deterministic: fixed id ordering +
 *  tie-break by smallest community id, so the same bonds always give the same partition. */
function louvainCommunities(nodes, edges) {
  const adj = new Map();
  for (const id of nodes) adj.set(id, new Map());
  for (const e of edges) {
    if (!adj.has(e.a) || !adj.has(e.b) || e.a === e.b) continue;
    adj.get(e.a).set(e.b, (adj.get(e.a).get(e.b) || 0) + e.w);
    adj.get(e.b).set(e.a, (adj.get(e.b).get(e.a) || 0) + e.w);
  }
  const k = new Map(); let m2 = 0;                 // m2 = 2m = sum of weighted degrees
  for (const id of nodes) { let s = 0; for (const w of adj.get(id).values()) s += w; k.set(id, s); m2 += s; }
  const comm = new Map(); for (const id of nodes) comm.set(id, id);
  if (m2 <= 0) return comm;
  const order = [...nodes].sort((x, y) => x - y);
  for (let pass = 0; pass < 10; pass++) {
    let moved = false;
    for (const i of order) {
      const ci = comm.get(i), ki = k.get(i);
      const tot = new Map();
      for (const id of nodes) { const c = comm.get(id); tot.set(c, (tot.get(c) || 0) + k.get(id)); }
      const neighComm = new Map();
      for (const [j, w] of adj.get(i)) { const cj = comm.get(j); neighComm.set(cj, (neighComm.get(cj) || 0) + w); }
      const candidates = new Set(neighComm.keys()); candidates.add(ci);
      let bestC = ci, bestGain = -Infinity;
      for (const C of candidates) {
        const wIC = neighComm.get(C) || 0;
        let totC = tot.get(C) || 0;
        if (C === ci) totC -= ki;                   // i leaves its own community before re-joining
        const gain = (2 * wIC) / m2 - (2 * totC * ki) / (m2 * m2);
        if (gain > bestGain + 1e-12 || (Math.abs(gain - bestGain) <= 1e-12 && C < bestC)) { bestGain = gain; bestC = C; }
      }
      if (bestC !== ci) { comm.set(i, bestC); moved = true; }
    }
    if (!moved) break;
  }
  return comm;
}

/** Rebuild the colony partition from the latest social read-out. Deterministic: the same bonds always
 *  yield the same colonies, anchors and colours, so the field never jitters between polls. */
function rebuildSocieties() {
  const s = econSocial;
  if (!s || !Array.isArray(s.bonds) || !s.bonds.length) { societies = null; return; }
  const pairW = new Map();                          // undirected "lo:hi" → weight (max of both directions)
  const nodeSet = new Set(), feuds = [];
  for (const b of s.bonds) {
    if (!b || b.a == null || b.b == null || b.a === b.b) continue;
    const sc = typeof b.score === "number" ? b.score : 0;
    if (sc >= SOCIETY_BOND_MIN) {
      const key = Math.min(b.a, b.b) + ":" + Math.max(b.a, b.b);
      pairW.set(key, Math.max(pairW.get(key) || 0, sc));
      nodeSet.add(b.a); nodeSet.add(b.b);
    } else if (sc <= SOCIETY_FEUD_MAX) {
      feuds.push({ a: b.a, b: b.b, w: clamp(-sc) });
    }
  }
  // the grudge book is a feud even if the bond has since faded — surface it as a rift too
  if (Array.isArray(s.grudges)) for (const g of s.grudges) { if (g && g.buyerId != null && g.sellerId != null && g.buyerId !== g.sellerId) feuds.push({ a: g.buyerId, b: g.sellerId, w: 0.8 }); }
  const nodes = [...nodeSet].sort((x, y) => x - y);
  const edges = [...pairW.entries()].map(([key, w]) => { const p = key.split(":"); return { a: +p[0], b: +p[1], w }; });
  const allies = edges.map((e) => ({ a: e.a, b: e.b, w: clamp(e.w) }));
  // weighted-modularity communities ⇒ colonies (a lone fly is not a society)
  const comm = louvainCommunities(nodes, edges);
  const groups = new Map();
  for (const id of nodes) { const c = comm.get(id); if (!groups.has(c)) groups.set(c, []); groups.get(c).push(id); }
  const colonies = [];
  for (const ids of groups.values()) {
    if (ids.length < 2) continue;
    ids.sort((x, y) => x - y);
    colonies.push({ ids, founder: ids[0] });
  }
  colonies.sort((p, q) => p.founder - q.founder);
  // deterministic, collision-free home anchors on a 4×3 grid (linear-probe on a hash clash) + a distinct
  // colour per colony, so the societies spread across the field instead of piling onto one spot
  const SLOTS = [];
  for (let r = 0; r < 3; r++) for (let c = 0; c < 4; c++) SLOTS.push([0.16 + 0.226 * c, 0.22 + 0.28 * r]);
  const taken = new Set();
  for (let i = 0; i < colonies.length; i++) {
    const col = colonies[i], h = fnv1a("colony:" + col.founder);
    let si = h % SLOTS.length; while (taken.has(si)) si = (si + 1) % SLOTS.length; taken.add(si);
    const jx = ((h >>> 8) % 100) / 100 - 0.5, jy = ((h >>> 16) % 100) / 100 - 0.5;
    col.ax = clamp(SLOTS[si][0] + jx * 0.05, 0.06, 0.94);
    col.ay = clamp(SLOTS[si][1] + jy * 0.05, 0.06, 0.94);
    col.color = COLONY_COLORS[i % COLONY_COLORS.length];
    col.name = COLONY_NAMES[i % COLONY_NAMES.length];
  }
  const colonyOf = new Map();
  for (let i = 0; i < colonies.length; i++) for (const id of colonies[i].ids) colonyOf.set(id, i);
  societies = { colonies, allies, feuds, colonyOf };
  focusCacheId = null;                                  // the partition moved → rebuild the highlight set
  if (selectedId != null) refreshInspectorSocial(selectedId);
}

/** Smooth organic boundary hugging a colony's living members: angular-bin the member radii around the
 *  live centroid, interpolate + smooth the empty bins, pad outward, and return a closed point ring. */
function colonyBlob(pts, others, scr) {
  let cx = 0, cy = 0; for (const p of pts) { cx += p.x; cy += p.y; } cx /= pts.length; cy /= pts.length;
  const BINS = 28, MINR = 44;
  const rad = scr.rad.fill(0), sm = scr.sm, P = scr.P;
  for (const p of pts) {
    const dx = p.x - cx, dy = p.y - cy, d = Math.hypot(dx, dy);
    let bi = Math.floor(((Math.atan2(dy, dx) + Math.PI) / TAU) * BINS) % BINS; if (bi < 0) bi += BINS;
    if (d > rad[bi]) rad[bi] = d;
  }
  // fill empty angular bins from their neighbours so the outline stays closed and organic
  for (let pass = 0; pass < 3; pass++) for (let i = 0; i < BINS; i++) if (rad[i] <= 0) rad[i] = Math.max(rad[(i - 1 + BINS) % BINS], rad[(i + 1) % BINS]) * 0.9 || MINR;
  for (let i = 0; i < BINS; i++) rad[i] = Math.max(rad[i], MINR * 0.6);
  // circular smoothing so the territory reads as one soft body, not a star (scratch-reused, no alloc)
  for (let pass = 0; pass < 2; pass++) {
    for (let i = 0; i < BINS; i++) sm[i] = (rad[(i - 1 + BINS) % BINS] + rad[i] * 2 + rad[(i + 1) % BINS]) / 4;
    for (let i = 0; i < BINS; i++) rad[i] = sm[i];
  }
  let rmax = 0;
  for (let i = 0; i < BINS; i++) {
    const a = (i / BINS) * TAU - Math.PI;
    let r = rad[i] + SOCIETY_PAD;
    // exclusive jurisdiction: cap at the bisector toward every other colony (Voronoi), minus a gap
    if (others) for (const o of others) {
      const dx = o.x - cx, dy = o.y - cy, D = Math.hypot(dx, dy);
      if (D < 1) continue;
      const cosT = (Math.cos(a) * dx + Math.sin(a) * dy) / D;
      if (cosT <= 0.2) continue;
      const cap = (D / 2 - SOCIETY_CAP_GAP) / cosT;
      if (cap < r) r = cap;
    }
    r = Math.max(r, SOCIETY_MINCAP);
    if (r > rmax) rmax = r;
    const q = P[i]; q[0] = cx + Math.cos(a) * r; q[1] = cy + Math.sin(a) * r;
  }
  return { cx, cy, rmax };
}

/** Trace a smooth closed curve through a point ring (quadratic through edge midpoints) onto a target
 *  (a CanvasRenderingContext2D or a Path2D). */
function traceBlob(t, P) {
  const n = P.length;
  if (t.beginPath) t.beginPath();
  t.moveTo((P[0][0] + P[n - 1][0]) / 2, (P[0][1] + P[n - 1][1]) / 2);
  for (let i = 0; i < n; i++) { const cur = P[i], nxt = P[(i + 1) % n]; t.quadraticCurveTo(cur[0], cur[1], (cur[0] + nxt[0]) / 2, (cur[1] + nxt[1]) / 2); }
  t.closePath();
}

/** A deterministic jagged "crack" polyline between two feuding flies (stable frame to frame). */
function traceCrack(a, b) {
  const dx = b.x - a.x, dy = b.y - a.y, d = Math.hypot(dx, dy) || 1;
  const px = -dy / d, py = dx / d;
  const segs = Math.max(4, Math.round(d / 26));
  const seed = fnv1a("crack:" + Math.min(a.id, b.id) + ":" + Math.max(a.id, b.id));
  ctx.beginPath(); ctx.moveTo(a.x, a.y);
  for (let i = 1; i < segs; i++) {
    const t = i / segs;
    const j = ((((seed >>> (i % 24)) & 0xff) / 255) - 0.5) * 16;
    ctx.lineTo(a.x + dx * t + px * j, a.y + dy * t + py * j);
  }
  ctx.lineTo(b.x, b.y);
}

/** Draw the societies: a clearly-bounded organic territory per colony (filled + outlined + labelled),
 *  a gold bond web inside each colony, and red conflict cracks between feuding flies. Beneath the flies. */
function renderSocieties(pal, now) {
  if (!showSocieties || !societies || !societies.colonies.length) return;
  const foc = currentFocus();
  const focCol = foc != null ? societies.colonyOf.get(foc) : undefined;
  // 1) bounded territories hugging each colony's live members.
  //    The outline ring is recomputed EVERY frame (cheap bin math on reused scratch buffers, zero
  //    allocation) so the border tracks members smoothly at 60fps; only the radial glow gradient —
  //    the genuinely expensive object — is cached and rebuilt ~15Hz / on centroid move.
  const cents = societies.colonies.map((c) => { let x = 0, y = 0, n = 0; for (const id of c.ids) { const f = sim.get(id); if (f && !f.dying) { x += f.x; y += f.y; n++; } } return { x: n ? x / n : 0, y: n ? y / n : 0, n }; });
  for (let ci = 0; ci < societies.colonies.length; ci++) {
    const c = societies.colonies[ci];
    const pts = c._pts || (c._pts = []);
    pts.length = 0;
    for (const id of c.ids) { const f = sim.get(id); if (f && !f.dying) pts.push(f); }
    if (pts.length < 2) continue;
    const scr = c._scr || (c._scr = { rad: new Array(28).fill(0), sm: new Array(28).fill(0), P: Array.from({ length: 28 }, () => [0, 0]) });
    const blob = colonyBlob(pts, cents.filter((o, k) => k !== ci && o.n >= 2), scr);
    let glow = c._glow;
    if (!glow || (now - glow.t > 66) || Math.hypot(blob.cx - glow.cx, blob.cy - glow.cy) > 3) {
      const grad = ctx.createRadialGradient(blob.cx, blob.cy, 0, blob.cx, blob.cy, blob.rmax);
      grad.addColorStop(0, rgba(c.color, 0.10)); grad.addColorStop(1, rgba(c.color, 0));
      glow = c._glow = { grad, cx: blob.cx, cy: blob.cy, rmax: blob.rmax, t: now };
    }
    const cdim = (foc != null && ci !== focCol) ? 0.18 : 1;   // focus highlight: fade the other colonies
    traceBlob(ctx, scr.P);
    ctx.fillStyle = rgba(c.color, 0.13 * cdim); ctx.fill();
    ctx.strokeStyle = rgba(c.color, 0.55 * cdim); ctx.lineWidth = 1.4; ctx.stroke();
    // soft inner glow for depth (cached gradient)
    if (cdim >= 1) { ctx.fillStyle = glow.grad; ctx.fill(); }
    // the colony's heraldic plate: a small shield in the colony hue + its initial, then the name in Roman caps
    ctx.save();
    ctx.textBaseline = "middle";
    const label = `${c.name} · ${pts.length}`;
    ctx.font = "600 12px Cinzel, Fraunces, Georgia, serif";
    const crestW = 13, gap = 6;
    const total = crestW + gap + ctx.measureText(label).width;
    const lx = blob.cx - total / 2, by = blob.cy - blob.rmax - 12;
    ctx.beginPath();
    ctx.moveTo(lx, by - 6); ctx.lineTo(lx + crestW, by - 6); ctx.lineTo(lx + crestW, by + 2);
    ctx.quadraticCurveTo(lx + crestW, by + 7, lx + crestW / 2, by + 8);
    ctx.quadraticCurveTo(lx, by + 7, lx, by + 2); ctx.closePath();
    ctx.fillStyle = rgba(c.color, 0.92 * cdim); ctx.fill();
    ctx.lineWidth = 1; ctx.strokeStyle = rgba(GILT, 0.7 * cdim); ctx.stroke();
    ctx.textAlign = "center"; ctx.font = "700 8px Cinzel, Fraunces, serif";
    ctx.fillStyle = rgba([248, 244, 236], 0.95 * cdim); ctx.fillText(String(c.name).charAt(0), lx + crestW / 2, by + 1);
    ctx.textAlign = "left"; ctx.font = "600 12px Cinzel, Fraunces, Georgia, serif";
    ctx.fillStyle = rgba(c.color, 0.92 * cdim); ctx.fillText(label, lx + crestW + gap, by);
    ctx.restore();
  }
  // 2) gold bond web inside colonies (the alliances that define each society)
  for (const p of societies.allies) {
    const a = sim.get(p.a), b = sim.get(p.b); if (!a || a.dying || !b || b.dying) continue;
    const inv = foc != null && (p.a === foc || p.b === foc);
    const ed = foc == null ? 1 : (inv ? 1 : 0.10);
    ctx.lineWidth = inv ? 1.6 : 1.1;
    ctx.strokeStyle = rgba(GOLD_THREAD, (0.30 + p.w * 0.35) * ed);
    ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
  }
  // 3) red conflict cracks between feuding flies
  for (const p of societies.feuds) {
    const a = sim.get(p.a), b = sim.get(p.b); if (!a || a.dying || !b || b.dying) continue;
    if (Math.hypot(a.x - b.x, a.y - b.y) > 380) continue;
    const inv = foc != null && (p.a === foc || p.b === foc);
    const ed = foc == null ? 1 : (inv ? 1 : 0.10);
    ctx.lineWidth = inv ? 1.7 : 1.3;
    ctx.strokeStyle = rgba(CRACK_RED, 0.5 * ed);
    traceCrack(a, b); ctx.stroke();
  }
}

function render(pal, now) {
  // OPAQUE full clear every frame. The old translucent "trail wash" let previous frames linger and
  // fade slowly, smearing moving flies AND every glyph/label into ghosts that read as stutter.
  // Crisp clear removes all ghosting with no quality loss (motion feel stays via the per-fly ink
  // trail stroke), and an opaque fill is cheaper than an alpha-blended wash.
  // aged-parchment base (offscreen, rebuilt on resize / temperature-bucket change / ~2s): one blit per frame.
  const pkey = VW + "x" + VH + ":" + Math.round(tempSmoothed * 8);
  if (!parchOff || parchKey !== pkey || now - parchLast > 2000) { parchKey = pkey; parchLast = now; rebuildParchment(pal); }
  ctx.drawImage(parchOff, 0, 0, VW, VH);
  // a thin temperature wash keeps the market's warm/cool read on the page without rebuilding the texture
  ctx.fillStyle = rgba(pal.accent, 0.03 + tempSmoothed * 0.05); ctx.fillRect(0, 0, VW, VH);

  // the swarm's ambient neural aura — deepest background layer, breathing with the collective mood
  renderMind(pal, now);

  // ambient flow ink (under everything)
  if (quality >= 1) renderMotes(pal);

  // the societies layer: colony territories + bond filaments, drawn under the mesh and the flies
  renderSocieties(pal, now);

  // the persistent necropolis: weathered headstones for every buried wallet the ledger remembers
  renderGraveyard(pal, now);

  // fading grave steles at observed death positions (a just-died glow riding above the old stones)
  renderMonuments(pal, now);

  const acc = pal.accent;

  // murmuration mesh: faint threads between close flies when the swarm is cohesive
  if (quality >= 2 && cohSmoothed > 0.34) {
    const list = [...sim.values()].filter((f) => !f.dying);
    const R = 74 + cohSmoothed * 46;
    ctx.lineWidth = 0.6;
    for (let i = 0; i < list.length; i++) {
      for (let j = i + 1; j < list.length; j++) {
        const a = list[i], b = list[j];
        const dx = a.x - b.x, dy = a.y - b.y, dd = Math.hypot(dx, dy);
        if (dd < R) {
          const al = (1 - dd / R) * (cohSmoothed - 0.34) * 0.5;
          ctx.strokeStyle = rgba(mix([26, 26, 24], acc, 0.4), al);
          ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
        }
      }
    }
  }

  // the FlyShardDO isolates: a ring of compute nodes around the swarm, pulsing in fan-out waves each tick
  if (quality >= 1) renderShards(pal, now);

  // pointer / stimulus ripples
  for (let i = ripples.length - 1; i >= 0; i--) {
    const r = ripples[i], age = (now - r.t0) / 1700;
    if (age >= 1) { ripples.splice(i, 1); continue; }
    const rad = age * Math.min(VW, VH) * 0.55;
    ctx.strokeStyle = rgba(r.color, (1 - age) * 0.36);
    ctx.lineWidth = 1.4 * (1 - age) + 0.3;
    ctx.beginPath(); ctx.arc(r.x, r.y, rad, 0, TAU); ctx.stroke();
  }

  // the flies
  for (const f of sim.values()) {
    let alpha = clamp((now - f.born) / 900);
    if (f.dying) alpha = clamp(1 - (now - (f.dieT || now)) / 820);
    if (alpha <= 0.001) continue;
    if (f.dying && !f._mon) plantMonument(f, now);   // a death observed live leaves a fading stele
    drawFly(f, acc, alpha, now);
  }

  // x402 settlement packets flying payer → payee (over the swarm, so the money is visible)
  renderPayments(pal, now);

  // the chronicle made visible: transient alliance/feud/house/legislative events, over everything
  renderChronFx(pal, now);

  // the gilded manuscript border frames the whole field last, above every ink layer
  renderFrame(pal);
}

function drawFly(f, acc, alpha, now) {
  alpha *= focusDim(f.id);                                   // focus highlight: fade the un-related
  const hs = houseOf.get(f.id);                              // dynasty bloodline tint (ring + trail)
  const flap = Math.sin(f.phase) * 0.5 + 0.5;               // 0..1 wingbeat phase
  const balN = f.balN != null ? f.balN : 0.5;
  // Colour AND size both encode wealth: the richer the wallet, the warmer (slate → gold) and bigger the
  // fly. Balance is normalised 0..1 across the swarm (the real spread is tight, so min-max scaling makes
  // the ranking legible); arousal stays a secondary modulation so an agitated rich fly pulses larger.
  const body = mix([26, 26, 24], wealthColorAt(balN), 0.55 + f.temperament * 0.25);
  const size = (3.4 + balN * 3.4) * (0.92 + f.aro * 0.42);   // a touch larger so the anatomy actually reads
  const fap = f.fap || "FORAGE";
  const valence = f.valence || 0;
  const haloR = size * 3.0 + f.wing * flap * size * 2.4;

  // ink trail: a short stroke from the previous position (stronger when aroused)
  const tdx = f.x - f.px, tdy = f.y - f.py;
  if (quality >= 1 && tdx * tdx + tdy * tdy > 0.6) {
    ctx.strokeStyle = rgba(hs && hs.color ? mix(body, hs.color, 0.8) : body, (0.10 + f.aro * 0.22) * alpha);
    ctx.lineWidth = size * 0.8;
    ctx.beginPath(); ctx.moveTo(f.px, f.py); ctx.lineTo(f.x, f.y); ctx.stroke();
  }

  // soft halo (cached sprite) + a valence-tinted rim: warm when appetitive, cool/alert when aversive
  if (haloSprite) {
    ctx.globalAlpha = (0.09 + f.aro * 0.15) * alpha;
    ctx.drawImage(haloSprite, f.x - haloR, f.y - haloR, haloR * 2, haloR * 2);
    ctx.globalAlpha = 1;
    if (quality >= 2 && Math.abs(valence) > 0.22) {
      const rim = valence >= 0 ? [150, 170, 90] : [176, 74, 58];
      ctx.strokeStyle = rgba(rim, (Math.abs(valence) - 0.22) * 0.55 * alpha);
      ctx.lineWidth = 1;
      ctx.beginPath(); ctx.arc(f.x, f.y, haloR * 0.9, 0, TAU); ctx.stroke();
    }
  }

  // the articulated fly — or, at the lowest quality tier, the original cheap comma + wing arcs
  ctx.save();
  ctx.translate(f.x, f.y); ctx.rotate(f.heading);
  if (quality >= 1) drawFlyAnatomy(f, size, flap, alpha, body, acc, fap, now);
  else {
    const wspread = 0.5 + flap * 0.9;
    ctx.strokeStyle = rgba(acc, (0.1 + f.wing * 0.22) * alpha);
    ctx.lineWidth = 0.7;
    for (const s of [-1, 1]) {
      ctx.beginPath();
      ctx.ellipse(-size * 0.3, s * size * 0.5, size * 1.5, size * 0.6, s * wspread, 0, TAU);
      ctx.stroke();
    }
    ctx.fillStyle = rgba(body, (0.5 + f.aro * 0.45) * alpha);
    ctx.beginPath(); ctx.ellipse(0, 0, size * 1.5, size * 0.82, 0, 0, TAU); ctx.fill();
  }
  ctx.restore();

  // dynasty bloodline: a bold house-coloured band + a comet streak, so a family reads as coloured
  // ribbons inside its colony at a glance (two concentric rings + a trailing ribbon when moving)
  if (hs && hs.color) {
    ctx.strokeStyle = rgba(hs.color, 0.9 * alpha);
    ctx.lineWidth = 2.0;
    ctx.beginPath(); ctx.arc(f.x, f.y, size * 2.2, 0, TAU); ctx.stroke();
    ctx.strokeStyle = rgba(hs.color, 0.35 * alpha);
    ctx.lineWidth = 1;
    ctx.beginPath(); ctx.arc(f.x, f.y, size * 2.9, 0, TAU); ctx.stroke();
    const sp = Math.hypot(f.vx, f.vy);
    if (sp > 0.12) {
      const ux = f.vx / sp, uy = f.vy / sp;
      for (let k = 1; k <= 3; k++) {
        ctx.fillStyle = rgba(hs.color, (0.34 - k * 0.09) * alpha);
        ctx.beginPath(); ctx.arc(f.x - ux * k * size * 1.5, f.y - uy * k * size * 1.5, Math.max(0.6, size * (0.55 - k * 0.13)), 0, TAU); ctx.fill();
      }
    }
  }

  // bred-offspring marker: a thin accent ring around any live fly hatched PAST the fixed genesis cohort
  // (id >= populationSize). Genesis flies are the permanent founding 24; a ring means "this individual was
  // bred on-chain and bootstrapped into the live swarm by a parent's own realised profit". Never fires
  // while the live population equals genesis (no growth configured), so the default scene is unchanged.
  const genesisN = topology && topology.populationSize;
  if (genesisN != null && f.id >= genesisN) {
    ctx.strokeStyle = rgba(acc, 0.5 * alpha);
    ctx.lineWidth = 1;
    ctx.beginPath(); ctx.arc(f.x, f.y, size * 2.6 + 2, 0, TAU); ctx.stroke();
  }

  // selection ring + a heading tick along the persistent internal compass (the ring-attractor direction)
  if (f.id === selectedId) {
    const rr = size * 4 + 4 + flap * 1.6;
    ctx.strokeStyle = rgba(acc, 0.85 * alpha);
    ctx.lineWidth = 1;
    ctx.beginPath(); ctx.arc(f.x, f.y, rr, 0, TAU); ctx.stroke();
    if (f.sHead != null && quality >= 1) {
      ctx.strokeStyle = rgba(acc, 0.5 * alpha);
      ctx.beginPath();
      ctx.moveTo(f.x + Math.cos(f.sHead) * rr, f.y + Math.sin(f.sHead) * rr);
      ctx.lineTo(f.x + Math.cos(f.sHead) * (rr + 7), f.y + Math.sin(f.sHead) * (rr + 7));
      ctx.stroke();
    }
  }
}

// A recognisable Drosophila drawn in local space (+x = the direction of travel): two veined wings, six
// bent legs in an alternating tripod gait, a striped abdomen, a thorax, a head with two red compound
// eyes + feathery antennae, and a proboscis that pumps while feeding. The named action pattern drives
// the pose — COURT extends & vibrates ONE wing (the male love song), GROOM sweeps the front legs over the
// head, FLIGHT/RETREAT blur the spread wings, REST/HALT fold everything tight. Detail is shed at quality<2.
function drawFlyAnatomy(f, s, flap, alpha, body, acc, fap, now) {
  const detail = quality >= 2;
  const rest = f.rest ?? 0;
  const lp = f.legPhase ?? 0;
  const parked = fap === "REST" || fap === "HALT";
  const walk = (1 - rest * 0.85) * (parked ? 0.12 : 1);
  const abdomen = mix(body, [16, 16, 14], 0.2);
  const chitin = mix(body, [8, 8, 7], 0.4);
  const flying = fap === "FLIGHT" || fap === "RETREAT";
  const court = fap === "COURT";
  const side = f.courtSide || 1;

  // ---- wings (drawn first so the body overlaps their base) ----
  const wingLen = s * 2.1, wingW = s * 0.6, fold = parked ? 0.2 : 1;
  for (const sg of [-1, 1]) {
    let cx = -wingLen * 0.4, cy = sg * s * 0.3, ang = sg * (0.5 + flap * 0.42) * fold, len = wingLen;
    if (court && sg === side) { cx = wingLen * 0.16; cy = sg * s * 0.5; ang = sg * (-0.95 + Math.sin(now * 0.055) * 0.16); len = wingLen * 1.18; }
    else if (flying) { ang = sg * (0.82 + flap * 0.5); }
    ctx.save();
    ctx.rotate(ang);
    ctx.fillStyle = rgba(mix([236, 239, 242], acc, 0.16), (flying ? 0.18 : 0.30) * alpha);
    ctx.beginPath(); ctx.ellipse(cx, cy, len * 0.5, wingW, 0, 0, TAU); ctx.fill();
    // a faint outline so the wing silhouette reads against the paper (the vein alone is too subtle)
    ctx.strokeStyle = rgba(mix([120, 122, 120], acc, 0.25), (0.30 + f.wing * 0.2) * alpha);
    ctx.lineWidth = Math.max(0.4, s * 0.05);
    ctx.beginPath(); ctx.ellipse(cx, cy, len * 0.5, wingW, 0, 0, TAU); ctx.stroke();
    if (detail) {
      ctx.strokeStyle = rgba(mix([110, 112, 110], acc, 0.2), (0.2 + f.wing * 0.18) * alpha);
      ctx.lineWidth = 0.5;
      ctx.beginPath(); ctx.moveTo(cx + len * 0.42, cy); ctx.lineTo(cx - len * 0.46, cy + sg * wingW * 0.2); ctx.stroke();
      if (flying) { ctx.strokeStyle = rgba([238, 240, 242], 0.09 * alpha); ctx.beginPath(); ctx.ellipse(cx, cy, len * 0.5, wingW * 1.7, 0, 0, TAU); ctx.stroke(); }
    }
    ctx.restore();
  }

  // ---- legs: six bent legs in an alternating tripod gait; GROOM lifts the front pair to the head ----
  ctx.strokeStyle = rgba(mix(chitin, [0, 0, 0], 0.06), (0.5 + f.aro * 0.25) * alpha);
  ctx.lineWidth = Math.max(0.5, s * 0.11);
  ctx.lineCap = "round"; ctx.lineJoin = "round";
  const groom = fap === "GROOM";
  for (const sg of [-1, 1]) {
    for (let i = 0; i < 3; i++) {                 // 0 = pro (front), 1 = meso (mid), 2 = meta (hind)
      const hipX = s * (0.46 - i * 0.48), hipY = sg * s * 0.26;
      let kneeX, kneeY, footX, footY;
      if (groom && i === 0) {                      // the front leg sweeps up over the compound eye
        const g = Math.sin(now * 0.013 + sg * 1.4) * 0.5 + 0.5;
        footX = s * (1.05 + g * 0.4); footY = sg * s * (0.12 + g * 0.08);
        kneeX = s * 0.72; kneeY = sg * s * (0.66 - g * 0.24);
      } else {
        const tri = (i === 1) ? Math.PI : 0;       // tripod: the mid leg swings opposite front + hind
        const swing = Math.sin(lp + tri + (sg > 0 ? 0 : Math.PI * 0.5)) * s * 0.38 * walk;
        footX = hipX + s * (0.6 - i * 0.5) + swing;
        footY = sg * s * (0.92 + i * 0.12);
        kneeX = (hipX + footX) * 0.5; kneeY = sg * s * (0.64 + i * 0.05);
      }
      ctx.beginPath(); ctx.moveTo(hipX, hipY); ctx.lineTo(kneeX, kneeY); ctx.lineTo(footX, footY); ctx.stroke();
    }
  }

  // ---- abdomen (rear): a tapered barrel with transverse stripes ----
  const abX = -s * 1.0, abL = s * 1.12, abW = s * 0.5;
  ctx.fillStyle = rgba(abdomen, (0.74 + f.aro * 0.2) * alpha);
  ctx.beginPath(); ctx.ellipse(abX, 0, abL, abW, 0, 0, TAU); ctx.fill();
  if (detail) {
    ctx.strokeStyle = rgba(mix(abdomen, [0, 0, 0], 0.42), 0.38 * alpha);
    ctx.lineWidth = Math.max(0.4, s * 0.085);
    for (let k = 1; k <= 3; k++) {
      const gx = abX + abL * (0.1 + k * 0.26);
      ctx.beginPath(); ctx.ellipse(gx, 0, s * 0.045, abW * (0.9 - k * 0.11), 0, 0, TAU); ctx.stroke();
    }
  }
  // ---- thorax (middle): the muscular box the wings & legs attach to ----
  ctx.fillStyle = rgba(body, (0.82 + f.aro * 0.16) * alpha);
  ctx.beginPath(); ctx.ellipse(s * 0.2, 0, s * 0.76, s * 0.58, 0, 0, TAU); ctx.fill();
  if (detail) {
    ctx.strokeStyle = rgba(mix(body, [0, 0, 0], 0.34), 0.28 * alpha);
    ctx.lineWidth = Math.max(0.4, s * 0.07);
    ctx.beginPath(); ctx.moveTo(s * 0.62, -s * 0.1); ctx.lineTo(-s * 0.28, -s * 0.12); ctx.stroke();
  }
  // ---- head + the two big red compound eyes ----
  const headX = s * 1.0;
  ctx.fillStyle = rgba(chitin, (0.86 + f.aro * 0.12) * alpha);
  ctx.beginPath(); ctx.ellipse(headX, 0, s * 0.5, s * 0.45, 0, 0, TAU); ctx.fill();
  for (const sg of [-1, 1]) {
    ctx.fillStyle = rgba([152, 44, 32], 0.92 * alpha);
    ctx.beginPath(); ctx.ellipse(headX + s * 0.04, sg * s * 0.25, s * 0.25, s * 0.3, sg * 0.35, 0, TAU); ctx.fill();
    if (detail) { ctx.fillStyle = rgba([226, 132, 110], 0.5 * alpha); ctx.beginPath(); ctx.ellipse(headX + s * 0.12, sg * s * 0.2, s * 0.07, s * 0.09, 0, 0, TAU); ctx.fill(); }
  }
  // ---- antennae (a lazy sweep) ----
  if (detail) {
    ctx.strokeStyle = rgba(chitin, 0.7 * alpha);
    ctx.lineWidth = Math.max(0.4, s * 0.07);
    const asw = Math.sin(now * 0.004 + (f.id || 0)) * 0.16;
    for (const sg of [-1, 1]) {
      ctx.beginPath(); ctx.moveTo(headX + s * 0.34, sg * s * 0.08);
      ctx.lineTo(headX + s * 0.78, sg * s * (0.3 + asw)); ctx.stroke();
    }
  }
  // ---- proboscis: the rostrum pumps forward-down while FEEDING ----
  if (fap === "FEED") {
    const pump = Math.sin(now * 0.02) * 0.5 + 0.5;
    ctx.strokeStyle = rgba(mix(chitin, [128, 84, 40], 0.5), 0.9 * alpha);
    ctx.lineWidth = Math.max(0.6, s * 0.15);
    ctx.beginPath(); ctx.moveTo(headX + s * 0.3, 0);
    ctx.lineTo(headX + s * (0.82 + pump * 0.32), s * 0.1); ctx.stroke();
  }
}

// ================= temperature history ribbon =================
const thCanvas = $("temp-history");
const thCtx = thCanvas ? thCanvas.getContext("2d") : null;
function sampleHistory() {
  const wall = Date.now();
  if (wall - lastHistSample < HIST_SAMPLE_MS) return;
  lastHistSample = wall;
  tempHistory.push({ t: wall, T: tempSmoothed });
  while (tempHistory.length && wall - tempHistory[0].t > RIBBON_WINDOW) tempHistory.shift();
}
/** Merge the D1 archived per-cron temperatures with the live in-memory tail into ONE wall-clock series,
 *  so the ribbon shows real history (reload-persistent) plus the freshest live head. Tolerates a little
 *  client/server clock skew. Without history it is just the live tail (the original behaviour). */
function ribbonSeries(wall) {
  const out = [];
  if (histEnabled) {
    for (const r of histRows) {
      if (r.ts == null || r.temperature == null) continue;
      if (r.ts <= wall + 120000 && wall - r.ts <= RIBBON_WINDOW) out.push({ t: r.ts, T: r.temperature });
    }
  }
  for (const p of tempHistory) if (wall - p.t <= RIBBON_WINDOW) out.push({ t: p.t, T: p.T });
  out.sort((a, b) => a.t - b.t);
  return out;
}
function drawTempHistory() {
  if (!thCtx) return;
  const wall = Date.now();
  const W = thCanvas.width, H = thCanvas.height;
  const pal = paletteAt(tempSmoothed);
  thCtx.clearRect(0, 0, W, H);

  // regime threshold guides (cold ≤ .33, hot ≥ .66)
  thCtx.strokeStyle = rgba(mix([26, 26, 24], pal.accent, 0.3), 0.14);
  thCtx.lineWidth = 1;
  for (const th of [0.33, 0.66]) {
    const y = H - th * H;
    thCtx.beginPath(); thCtx.moveTo(0, y); thCtx.lineTo(W, y); thCtx.stroke();
  }

  const series = ribbonSeries(wall);
  if (series.length < 2) return;

  const xOf = (t) => W - ((wall - t) / RIBBON_WINDOW) * W;
  const yOf = (T) => H - clamp(T) * H;

  // area under the curve
  thCtx.beginPath();
  thCtx.moveTo(xOf(series[0].t), H);
  for (const p of series) thCtx.lineTo(xOf(p.t), yOf(p.T));
  thCtx.lineTo(xOf(series[series.length - 1].t), H);
  thCtx.closePath();
  const grad = thCtx.createLinearGradient(0, 0, 0, H);
  grad.addColorStop(0, rgba(pal.accent, 0.30));
  grad.addColorStop(1, rgba(pal.accent, 0.02));
  thCtx.fillStyle = grad;
  thCtx.fill();

  // the temperature line
  thCtx.beginPath();
  for (let i = 0; i < series.length; i++) {
    const p = series[i];
    if (i === 0) thCtx.moveTo(xOf(p.t), yOf(p.T)); else thCtx.lineTo(xOf(p.t), yOf(p.T));
  }
  thCtx.strokeStyle = rgba(pal.accent, 0.85);
  thCtx.lineWidth = 1.4;
  thCtx.stroke();

  // live head
  const head = series[series.length - 1];
  thCtx.fillStyle = rgba(pal.accent, 0.95);
  thCtx.beginPath(); thCtx.arc(xOf(head.t), yOf(head.T), 2, 0, TAU); thCtx.fill();
}

// ================= the generative loop =================
// PERF SAFETY: the body is wrapped so a transient error can never kill the rAF chain (a dead
// loop reads as a hard freeze), and an adaptive quality level sheds the heaviest field layers
// (ink motes, murmuration mesh, trails) whenever the frame budget is blown, so weak machines
// degrade gracefully instead of locking up.
let last = performance.now(), frame = 0;
let frameMsAvg = 16, quality = 2, lastQualityAt = 0, loopWarned = false;  // 2=full 1=no motes/mesh/trails-heavy 0=minimal
function loop(now) {
  try {
    const ms = now - last;
    const dt = clamp(ms / 16.667, 0.2, 2.4);
    last = now; frame++;
    frameMsAvg = lerp(frameMsAvg, ms, 0.06);
    if (now - lastQualityAt > 1000) {
      lastQualityAt = now;
      if (frameMsAvg > 30 && quality > 0) quality--;
      else if (frameMsAvg < 19 && quality < 2) quality++;
    }
    tempSmoothed = lerp(tempSmoothed, tempTarget, 0.02 * dt);
    cohSmoothed = lerp(cohSmoothed, cohTarget, 0.03 * dt);
    flowTime += dt * (0.35 + tempSmoothed * 1.1);   // the current races when the market is hot
    const pal = paletteAt(tempSmoothed);
    if (frame % 6 === 0) applyPaletteToDOM(pal);
    sampleHistory();
    updateSim(dt, now);
    if (quality >= 1) updateMotes(dt);
    render(pal, now);
    if (frame % 3 === 0) drawTempHistory();
    if (selectedId != null) { renderBloom(now); renderRaster(now); }
  } catch (e) {
    if (!loopWarned) { loopWarned = true; console.warn("[murmur] loop error (self-healed):", e); }
  } finally {
    requestAnimationFrame(loop);
  }
}

// ================= agent economy: render + data =================
// Draw each live settlement as a packet travelling from the payer fly to the payee fly, with a faint
// guide thread. Colour encodes the good being bought (signal / momentum / attestation); declined
// attempts (insufficient funds) draw dimmer so the ledger stays honest.
function renderPayments(pal, now) {
  if (!payEdges.length) return;
  for (let i = payEdges.length - 1; i >= 0; i--) {
    const e = payEdges[i];
    const dur = e.real ? 2800 : ECON_EDGE_MS;   // a real on-chain trade flashes longer so it's unmissable
    const age = (now - e.t0) / dur;
    if (age >= 1) { payEdges.splice(i, 1); continue; }
    const a = sim.get(e.fromId), b = sim.get(e.toId);
    if (!a || !b || a.dying || b.dying) { payEdges.splice(i, 1); continue; }
    if (e.real) renderRealTrade(a, b, e, clamp(age), now);
    else renderSimTrade(a, b, e, age, pal);
  }
}

// A real on-chain settlement gets an unmissable rainbow "money beam": a glowing gradient link, a
// bright comet packet with a colourful tail + sparks, and expanding flash rings at both wallets — so
// anyone watching instantly sees that two flies just paid each other in real USDC.
function renderRealTrade(a, b, e, age, now) {
  const fade = clamp(age < 0.12 ? age / 0.12 : (1 - age) / 0.88);   // quick in, slow out
  const hueBase = (now * 0.11 + e.fromId * 41 + e.toId * 67) % 360; // slowly cycling, unique per pair
  const amt = Math.min(1, e.amount * 520);                          // bigger trade → fatter, brighter

  // rainbow beam + glow
  const g = ctx.createLinearGradient(a.x, a.y, b.x, b.y);
  for (let s = 0; s <= 5; s++) {
    const h = (hueBase + s * 46) % 360;
    g.addColorStop(s / 5, `hsla(${h},100%,62%,${0.12 + 0.5 * fade})`);
  }
  ctx.save();
  ctx.lineCap = "round";
  ctx.shadowColor = `hsla(${hueBase},100%,60%,${0.85 * fade})`;
  ctx.shadowBlur = 16 * fade;
  ctx.strokeStyle = g;
  ctx.lineWidth = (1.2 + amt * 3.2) * (0.5 + fade * 0.9);
  ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
  ctx.restore();

  // comet: colourful tail + white-hot head
  const t = age;
  const px = lerp(a.x, b.x, t), py = lerp(a.y, b.y, t);
  const bt = Math.max(0, t - 0.16);
  const tx = lerp(a.x, b.x, bt), ty = lerp(a.y, b.y, bt);
  const tg = ctx.createLinearGradient(tx, ty, px, py);
  tg.addColorStop(0, `hsla(${(hueBase + 120) % 360},100%,60%,0)`);
  tg.addColorStop(1, `hsla(${(hueBase + 210) % 360},100%,74%,${0.85 * fade})`);
  ctx.strokeStyle = tg; ctx.lineWidth = 2.4 + amt * 3; ctx.lineCap = "round";
  ctx.beginPath(); ctx.moveTo(tx, ty); ctx.lineTo(px, py); ctx.stroke();
  const hr = (2.4 + amt * 3.4) * 3;
  const hg = ctx.createRadialGradient(px, py, 0, px, py, hr);
  hg.addColorStop(0, `hsla(0,0%,100%,${0.95 * fade})`);
  hg.addColorStop(0.35, `hsla(${hueBase},100%,72%,${0.75 * fade})`);
  hg.addColorStop(1, `hsla(${hueBase},100%,60%,0)`);
  ctx.fillStyle = hg; ctx.beginPath(); ctx.arc(px, py, hr, 0, TAU); ctx.fill();

  // sparks trailing the comet (shed first when the frame budget is blown)
  if (quality >= 1) {
    for (let s = 0; s < 5; s++) {
      const st = Math.max(0, t - 0.03 - s * 0.035);
      const sx = lerp(a.x, b.x, st), sy = lerp(a.y, b.y, st);
      const ang = now * 0.02 + s * 2.1 + e.fromId;
      const rr = 2 + s * 1.6;
      ctx.fillStyle = `hsla(${(hueBase + s * 40) % 360},100%,66%,${Math.max(0, 0.6 - s * 0.11) * fade})`;
      ctx.beginPath(); ctx.arc(sx + Math.cos(ang) * rr * 0.5, sy + Math.sin(ang) * rr * 0.5, Math.max(0.4, 1.5 - s * 0.22), 0, TAU); ctx.fill();
    }
  }

  // expanding flash rings at both wallets — the "a trade just happened" signal
  if (age < 0.62) {
    const rp = age / 0.62, rr = 6 + rp * 32, ra = (1 - rp) * 0.7 * fade;
    ctx.lineWidth = 2 * (1 - rp) + 0.4;
    for (const p of [a, b]) {
      ctx.strokeStyle = `hsla(${hueBase},100%,68%,${ra})`;
      ctx.beginPath(); ctx.arc(p.x, p.y, rr, 0, TAU); ctx.stroke();
    }
  }
}

// The understated style for non-on-chain settlements (offline / simulated): a faint thread + packet.
function renderSimTrade(a, b, e, age, pal) {
  const col = GOOD_COL[e.good] || pal.accent;
  const fade = (1 - age) * (e.valid ? 1 : 0.4);

  // guide thread
  ctx.strokeStyle = rgba(col, 0.05 + 0.1 * fade);
  ctx.lineWidth = 0.7;
  ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();

  // the packet + a short tail behind it
  const t = age;
  const px = lerp(a.x, b.x, t), py = lerp(a.y, b.y, t);
  const bt = Math.max(0, t - 0.09);
  const tx = lerp(a.x, b.x, bt), ty = lerp(a.y, b.y, bt);
  const r = 1.5 + Math.min(2.6, e.amount * 380);
  ctx.strokeStyle = rgba(col, 0.42 * fade);
  ctx.lineWidth = r * 0.9;
  ctx.beginPath(); ctx.moveTo(tx, ty); ctx.lineTo(px, py); ctx.stroke();
  ctx.fillStyle = rgba(col, (e.valid ? 0.92 : 0.4) * fade);
  ctx.beginPath(); ctx.arc(px, py, r, 0, TAU); ctx.fill();
}

/** Consume the economy summary the /population feed carries (live) or the local mirror (offline). */
function applyEconomy(econ) {
  if (!econ) return;
  if (econ.balances) {
    econBalances = new Map();
    for (const [id, atomic] of Object.entries(econ.balances)) econBalances.set(Number(id), atomicToUsdc(atomic));
  }
  refreshBalanceScale();
  if (econ.totals) { econTotals = econ.totals; updateEconHud(econ.totals); }
  if (econ.social) { econSocial = econ.social; renderSocialSection(); rebuildSocieties(); sgMarkDirty(); }
  if (econ.dynasty) { econDynasty = econ.dynasty; renderDynastySection(); rebuildGraveField(); }
  if (econ.culture) { econCulture = econ.culture; renderCultureSection(); }
  if (econ.commons) { econCommons = econ.commons; renderCommonsSection(); }
  if (Array.isArray(econ.lastTick)) spawnPaymentEdges(econ.lastTick);
  if (selectedId != null) {
    const bal = econBalances.get(selectedId);
    if (bal != null) { const el = $("ins-bal"); if (el) el.textContent = bal.toFixed(4); }
  }
}

/** Recompute the swarm's wallet-balance range and each fly's normalised balance (0 = poorest … 1 =
 *  richest), which drives body size ("richer = bigger"). Sources: the /population economy balances
 *  and the /economy agent roster — merged so the scale is correct whichever feed has arrived. */
function refreshBalanceScale() {
  const map = new Map(econBalances);
  for (const ag of econAgents) { if (ag && ag.id != null) map.set(Number(ag.id), atomicToUsdc(ag.balance || "0")); }
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

function spawnPaymentEdges(list) {
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
    payEdges.push({ fromId: s.fromId, toId: s.toId, amount: atomicToUsdc(s.amount), good: s.good || "signal", valid: !!s.valid, real, t0: now });
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
  if (payEdges.length > MAX_EDGES) payEdges.splice(0, payEdges.length - MAX_EDGES);
}

function updateEconHud(t) {
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
function updateEconMode() {
  const em = $("econ-mode");
  if (!em) return;
  em.classList.remove("is-live", "is-stale");
  if (offline) {
    // The API is down and the panel is showing the local synthetic mirror — never pass it off as real.
    em.textContent = T("foot.offlineLoading");
    em.classList.add("is-stale");
  } else if (econMode === "onchain") {
    em.innerHTML = '<span class="live-dot"></span>' + T("mode.liveOnChain");
    em.classList.add("is-live");
  } else {
    em.textContent = econMode + " x402";
  }
}

/** The footer must never lie about whether real money moves. In live onchain mode it says so and
 *  points at the explorer; in simulated mode it keeps the honest "no real funds move" line. */
function updateEconFoot() {
  const f = $("econ-foot");
  if (!f) return;
  if (offline) {
    f.textContent = T("foot.offlineLost");
    f.classList.remove("live");
    f.classList.add("stale");
  } else if (econMode === "onchain") {
    // publish real settlement reliability: mined successes over total on-chain broadcast attempts
    const ok = econTotals ? (econTotals.settleOk || 0) : 0;
    const att = econTotals ? (econTotals.settleAttempts || 0) : 0;
    const sr = econTotals && econTotals.successRate != null ? econTotals.successRate : null;
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
function pushEconFeed(s) {
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
function updateWallet(ag) {
  if (!ag) return;
  const set = (id, v) => { const el = $(id); if (el) el.textContent = v; };
  set("ins-bal", atomicToUsdc(ag.balance || "0").toFixed(4));
  // In live onchain mode the wallet address links to this agent's on-chain activity in the Arc
  // explorer (works on mobile too, where the ledger feed is hidden). Otherwise it stays plain text.
  const addrEl = $("ins-addr");
  if (addrEl) {
    if (econMode === "onchain" && isRealAddr(ag.address)) {
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
function applyEconAgents(agents) {
  econAgents = agents;
  rebuildHouseMap();              // fresh roster → refresh the dynasty bloodline tint
  refreshBalanceScale();          // fresh roster → refresh the wealth scale that drives fly size
  if (walletsOpen) renderWallets();
}

/** Live: the /economy roster. Offline/pre-deploy: mirror the local synth wallets so the drawer is
 *  never empty. Both are normalised to {id, address, balance(atomic), paid, earned, deals, sales}. */
function rosterSource() {
  if (econAgents.length) return econAgents;
  return [...synthAgents.entries()].map(([id, a]) => ({
    id: Number(id), address: a.address, balance: a.balance, paid: a.paid, earned: a.earned, deals: a.deals, sales: a.sales,
  }));
}

// ⑥ Professions a fly settles into (specialisation, economic side only) — one glyph each for the wallet row.
const PROF_ICON = { forager: "❍", mooder: "❂", trader: "⇅", brooder: "❄" };
// The four goods the tape marks, in book order, for the price-line block.
const MARKET_GOODS = ["signal", "momentum", "attestation", "prediction"];

function renderWallets() {
  const host = $("wallets-list");
  if (!host) return;
  const list = rosterSource().slice().sort((a, b) => (a.id ?? 0) - (b.id ?? 0));
  const live = econMode === "onchain";
  const repOf = new Map(((econSocial && econSocial.rep) || []).map((r) => [r.id, r]));
  host.textContent = "";
  for (const ag of list) {
    const row = document.createElement("div");
    row.className = "wallet-row" + (ag.id === selectedId ? " sel" : "") + (ag.dead ? " gone" : "");
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
  if (sub) sub.textContent = live ? T("wallets.live", { n: list.length }) : T("wallets.sim", { n: list.length, mode: econMode });
  renderSocialSection();
}

// ================= social memory section (in the chronicle panel) =================
// The ledger of relationships: who trusts whom, who shuns whom, and the grudge book. Pure read-out of
// the economy's persisted bonds — the same memory that steers counterparty choice on-chain-adjacent.
function renderSocialSection() {
  const host = $("wallets-social");
  if (!host) return;
  const s = econSocial;
  if (!s || ((!s.bonds || !s.bonds.length) && (!s.grudges || !s.grudges.length))) { host.hidden = true; return; }
  host.hidden = false;
  const body = $("wallets-social-body");
  if (!body) return;
  body.textContent = "";
  for (const b of (s.bonds || []).slice(0, 8)) {
    const row = document.createElement("div");
    const shun = b.score <= -0.6;
    row.className = "wsoc-row " + (b.score < 0 ? (shun ? "shun" : "grudge") : "trust");
    const mark = shun ? T("social.shuns") : b.score < 0 ? T("social.grudge") : T("social.trust");
    row.textContent = `#${b.a} ${mark} #${b.b} · ${b.score > 0 ? "+" : ""}${b.score.toFixed(2)}${b.trades ? ` · ${b.trades} ${T("social.deals")}` : ""}`;
    body.appendChild(row);
  }
  const gr = (s.grudges || []).slice(0, 6);
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
function renderDynastySection() {
  const host = $("chron-dynasty");
  if (!host) return;
  const d = econDynasty;
  const houses = (d && d.houses) || [];
  const graves = (d && d.graves) || [];
  if (!houses.length && !graves.length) { host.hidden = true; return; }
  host.hidden = false;
  const hh = $("dyn-houses");
  if (hh) {
    hh.textContent = "";
    for (const h of houses.slice(0, 6)) {
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
    for (const g of graves.slice(0, 6)) {
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
function sparkline(values) {
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

function renderMarketSection() {
  const host = $("wallets-market");
  const body = $("wallets-market-body");
  if (!host || !body) return;
  const m = econMarket;
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
function renderCultureSection() {
  const host = $("chron-culture");
  const body = $("cult-body");
  if (!host || !body) return;
  const c = econCulture;
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

// ================= the commons section (in the chronicle panel) =================
// The commons in law: the assembly the swarm seats when a new era dawns, the two knobs it re-prices, and
// the law now in force. A pure read-out of commons.ts — it moves no money, only re-prices the credit line
// and its rate through the same rails. Hidden while LAW is off or no council is seated yet.
function renderCommonsSection() {
  const host = $("chron-commons");
  const body = $("com-body");
  if (!host || !body) return;
  const c = econCommons;
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
}

// ================= ⑨ the war coffer section (in the chronicle panel) =================
// The on-chain WarCoffer: which houses hold a real-USDC vault, the live + just-closed bouts (winner derived
// inside the contract, cross-checked independently here), and the extra tax purse. A pure read-out of /war —
// it moves no money and reflects no decision; it only makes the coffer's ledger visible. Hidden while WAR is off.
function renderWarSection() {
  const host = $("chron-war");
  if (!host) return;
  const w = econWar;
  if (!w || !w.enabled) { host.hidden = true; return; }
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

function openWallets() {
  walletsOpen = true;
  if (brainOpen) closeBrain();
  if (historyOpen) closeHistory();   // the right-side drawers are mutually exclusive
  if (proofsOpen) closeProofs();
  if (pulseOpen) closePulse();
  if (predictOpen) closePredict();
  if (lineageOpen) closeLineage();
  if (chronOpen) closeChron();
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
    if (e.social) { econSocial = e.social; renderSocialSection(); renderWallets(); sgMarkDirty(); }
    if (e.dynasty) { econDynasty = e.dynasty; renderDynastySection(); renderWallets(); }
    if (e.market) { econMarket = e.market; renderMarketSection(); }
    if (e.culture) { econCulture = e.culture; renderCultureSection(); }
    if (e.commons) { econCommons = e.commons; renderCommonsSection(); }
  }).catch(() => {});
}

function closeWallets() {
  walletsOpen = false;
  document.body.classList.remove("wallets-open");
  const w = $("wallets");
  if (!w) return;
  w.classList.remove("open");
  setTimeout(() => { if (!walletsOpen) w.hidden = true; }, 420);
}

function toggleWallets() { if (walletsOpen) closeWallets(); else openWallets(); }

// ================= netting read-out (economy panel) =================
/** Live one-liner under the ledger showing the netting upgrade at work this session. */
function updateNetNote() {
  const el = $("net-note");
  if (!el) return;
  if (netting.folded || netting.settled) {
    el.textContent = T("net.note", { folded: netting.folded, settled: netting.settled });
    el.classList.add("active");
  }
}

// ================= swarm history drawer (D1-backed, right side) =================
// The Worker archives one row per cron to D1; this drawer turns that permanent history into charts the
// session-only ribbon can't: temperature, cumulative USDC settled, wealth gini and settlements-per-cron,
// plus a since-launch summary. Everything degrades to "awaiting archive…" when D1 is unbound.
async function pollHistory() {
  try {
    const h = await getJSON("/history?order=desc&limit=700", 6000);
    if (h && h.enabled) {
      histEnabled = true;
      histRows = Array.isArray(h.rows) ? h.rows.slice().reverse() : [];   // desc → ascending for charts
      histSummary = h.summary || null;
      if (historyOpen) renderHistory(); else updateSinceLaunch();
    } else {
      histEnabled = false;
    }
  } catch { /* best-effort: history is a nicety and must never block the scene */ }
}

function fmtSince(ts) {
  const d = new Date(ts);
  if (isNaN(d.getTime())) return "–";
  const loc = currentLang();
  return d.toLocaleDateString(loc, { month: "short", day: "numeric" }) + " · " +
    d.toLocaleTimeString(loc, { hour: "2-digit", minute: "2-digit" });
}

function updateSinceLaunch() {
  const set = (id, v) => { const el = $(id); if (el) el.textContent = v; };
  const s = histSummary;
  if (!histEnabled || !s) {
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
  if (foot) foot.textContent = histRows.length
    ? T("hist.showing", { n: histRows.length })
    : T("hist.foot");
}

/** Generic mini time-series chart. vals = numbers oldest→newest; mode "line"|"area"|"bars". */
function drawSpark(canvas, vals, opts = {}) {
  if (!canvas) return;
  const ctx = canvas.getContext("2d");
  const W = canvas.width, H = canvas.height;
  const pal = paletteAt(tempSmoothed);
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

function renderHistory() {
  const temps = histRows.map((r) => r.temperature).filter((v) => v != null);
  const vols = histRows.map((r) => r.volumeUsdc).filter((v) => v != null);
  const ginis = histRows.map((r) => r.gini).filter((v) => v != null);
  const deals = histRows.map((r) => (r.deals != null ? r.deals : 0));
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

function openHistory() {
  historyOpen = true;
  if (brainOpen) closeBrain();
  if (walletsOpen) closeWallets();
  if (proofsOpen) closeProofs();
  if (pulseOpen) closePulse();
  if (predictOpen) closePredict();
  if (lineageOpen) closeLineage();
  if (chronOpen) closeChron();
  const d = $("history");
  if (!d) return;
  d.hidden = false;
  document.body.classList.add("history-open");
  requestAnimationFrame(() => d.classList.add("open"));
  renderHistory();
  pollHistory();   // refresh immediately on open so it's never stale
}

function closeHistory() {
  historyOpen = false;
  document.body.classList.remove("history-open");
  const d = $("history");
  if (!d) return;
  d.classList.remove("open");
  setTimeout(() => { if (!historyOpen) d.hidden = true; }, 420);
}

function toggleHistory() { if (historyOpen) closeHistory(); else openHistory(); }

// ---- chronicle drawer lifecycle (button in the bottom-right corner; mutually exclusive like the others) ----
function openChron() {
  chronOpen = true;
  if (walletsOpen) closeWallets();
  if (historyOpen) closeHistory();
  if (proofsOpen) closeProofs();
  if (brainOpen) closeBrain();
  if (lineageOpen) closeLineage();
  if (pulseOpen) closePulse();
  if (predictOpen) closePredict();
  if (arenaOpen) closeArena();
  const d = $("panel-chron"); if (!d) return;
  d.hidden = false;
  document.body.classList.add("chron-open");
  requestAnimationFrame(() => d.classList.add("open"));
}
function closeChron() {
  chronOpen = false;
  document.body.classList.remove("chron-open");
  sgStop();   // never leave the graph loop spinning behind a closed drawer
  const d = $("panel-chron"); if (!d) return;
  d.classList.remove("open");
  setTimeout(() => { if (!chronOpen) d.hidden = true; }, 420);
}
function toggleChron() { if (chronOpen) closeChron(); else openChron(); }

/** Open one volume of the chronicle codex: flip the epic tab rail + show only that volume's body. */
function setChronVol(vol) {
  for (const t of document.querySelectorAll("#chron-tabs .chron-tab")) {
    const on = t.dataset.vol === vol;
    t.classList.toggle("is-on", on);
    t.setAttribute("aria-selected", on ? "true" : "false");
  }
  for (const v of document.querySelectorAll("#panel-chron .chron-vol")) v.classList.toggle("is-on", v.dataset.vol === vol);
  // the social graph owns a live force loop: run it ONLY while its volume is on stage, stop otherwise
  if (vol === "graph") sgStart(); else sgStop();
}

// ================= ⑤ the social graph (force-directed node-link, lives in the chronicle drawer) =========
// A standalone "prove this is a real society" view: the SAME econSocial bonds the economy trades on, laid
// out by a tiny DETERMINISTIC force sim on its own canvas. Pure read-out — it never touches the sim, the
// drives, or the economy. The loop runs ONLY while this volume is on screen and idles to a stop once the
// layout cools, so it costs nothing when hidden or settled (the perf lesson of the whole frontend).
const SG = {
  canvas: null, ctx: null, wrap: null, tip: null, raf: 0,
  running: false, open: false, dirty: true, bound: false,
  nodes: [], edges: [], byId: new Map(),
  colorMode: "colony", alpha: 0, hover: null, drag: null, dpr: 1, w: 0, h: 0,
};
const SG_GREEN = [92, 158, 96];        // trust
const SG_RED = [198, 60, 44];          // grudge
const SG_NEUTRAL = [150, 150, 154];    // no colony / no house
const SG_REP = 0.0016, SG_SPRING = 0.02, SG_GRAV = 0.006, SG_COH = 0.01;
const SG_DAMP = 0.82, SG_COOL = 0.985, SG_MINSIM = 0.02;

/** Mark the graph stale; if it's on screen right now, rebuild (preserving positions) + gentle reheat. */
function sgMarkDirty() { SG.dirty = true; if (SG.open) { sgBuild(true); sgReheat(0.5); } }
function sgReheat(a) { SG.alpha = Math.max(SG.alpha, a == null ? 1 : a); if (SG.open && !SG.running) { SG.running = true; SG.raf = requestAnimationFrame(sgTick); } }

/** Build nodes/edges from the latest social + agent read-outs. preserve=true keeps live node positions so
 *  a background poll doesn't re-scramble the picture; seeds are a deterministic golden-angle spiral. */
function sgBuild(preserve) {
  const prev = SG.byId;
  SG.byId = new Map(); SG.nodes = []; SG.edges = [];
  SG.dirty = false;
  const s = econSocial;
  if (!s) return;
  const ids = new Set();
  for (const b of (s.bonds || [])) if (b && b.a != null && b.b != null && b.a !== b.b) { ids.add(b.a); ids.add(b.b); }
  for (const r of (s.rep || [])) if (r && r.id != null) ids.add(r.id);
  if (!ids.size) return;
  const bal = new Map(), rep = new Map();
  for (const ag of econAgents) if (ag && ag.id != null) bal.set(Number(ag.id), atomicToUsdc(ag.balance || "0"));
  for (const r of (s.rep || [])) if (r && r.id != null) rep.set(r.id, r.score || 0);
  let maxBal = 1e-6; for (const v of bal.values()) if (v > maxBal) maxBal = v;
  for (const id of [...ids].sort((a, b) => a - b)) {
    const b0 = bal.get(id) || 0, rp = rep.get(id) || 0;
    const ci = societies ? societies.colonyOf.get(id) : undefined;
    const colony = ci != null && societies.colonies[ci] ? societies.colonies[ci] : null;
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

function sgColorOf(n) {
  if (SG.colorMode === "house") return n.house ? n.house.color : (n.colony ? n.colony.color : SG_NEUTRAL);
  return n.colony ? n.colony.color : (n.house ? n.house.color : SG_NEUTRAL);
}

/** One force integration step (O(n²) charge — trivial for a few dozen nodes). */
function sgStep() {
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

function sgDraw() {
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

function sgTick() {
  if (!SG.running) return;
  sgStep(); sgDraw();
  if (SG.alpha <= SG_MINSIM && !SG.drag) { SG.running = false; sgDraw(); return; }   // settled → idle, free the CPU
  SG.raf = requestAnimationFrame(sgTick);
}

function sgMeasure() {
  if (!SG.canvas || !SG.wrap) return;
  const r = SG.wrap.getBoundingClientRect();
  SG.dpr = Math.min(2, window.devicePixelRatio || 1);
  SG.w = Math.max(0, r.width); SG.h = Math.max(0, r.height);
  SG.canvas.width = Math.round(SG.w * SG.dpr); SG.canvas.height = Math.round(SG.h * SG.dpr);
}

function sgTip(nd, mx, my) {
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

function sgBindDom() {
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

function sgStart() {
  sgBindDom();
  if (!SG.canvas) return;
  SG.open = true;
  if (SG.dirty || !SG.nodes.length) sgBuild(false);
  sgMeasure();
  sgReheat(SG.alpha > SG_MINSIM ? SG.alpha : 0.9);
}
function sgStop() {
  SG.open = false; SG.running = false;
  if (SG.raf) cancelAnimationFrame(SG.raf); SG.raf = 0;
  if (SG.tip) SG.tip.hidden = true;
}
window.addEventListener("resize", () => { if (SG.open) { sgMeasure(); sgDraw(); } });

// ================= the chronicle drawer (opened from the bottom-right button) =================
// Poll /annals — the deterministic historian's timeline. The poll runs whether or not the drawer is open,
// so the sheet is never stale when the button pulls it in: era badge, entry list, and the browser-side
// verdict if a proof has been run.
async function pollChron() {
  try {
    const r = await getJSON("/annals?order=desc&limit=200", 6000);
    if (r && r.enabled) {
      chronEnabled = true;
      chronRows = Array.isArray(r.entries) ? r.entries.slice() : [];   // already desc by seq
      chronMeta = { era: r.era, eraName: r.eraName, eraRegime: r.eraRegime, seq: r.seq,
        eraShock: r.eraShock || null, eraShockWilled: !!r.eraShockWilled,
        headHash: r.headHash || null, chroniclerHash: r.chroniclerHash || null, version: r.version || null };
      // the chronicle made visible: hand every entry newer than the last-shown seq to the canvas FX
      if (chronSeenSeq > 0) for (const e of chronRows) { if ((e.seq || 0) <= chronSeenSeq) break; spawnChronFx(e); }
      renderChron();
      if (chronVerifyState) renderChronVerdict();
    } else {
      chronEnabled = false;
      renderChron();
    }
  } catch { /* best-effort: the chronicle is a nicety, never block the scene */ }
}

// Poll /war — the on-chain coffer read-out (vaults, live bouts, tax purse). Gated client-side on `enabled`,
// so while WAR_ENABLED=false it renders nothing and costs nothing beyond one cheap fetch. Best-effort.
async function pollWar() {
  try {
    const r = await getJSON("/war", 6000);
    if (r && r.enabled) { econWar = r; renderWarSection(); }
    else { econWar = null; renderWarSection(); }
  } catch { econWar = null; renderWarSection(); }
}

function chronTimeAgo(ts) {
  const s = Math.max(0, Math.floor((Date.now() - ts) / 1000));
  if (s < 60) return s + "s";
  const m = Math.floor(s / 60); if (m < 60) return m + "m";
  const h = Math.floor(m / 60); if (h < 48) return h + "h";
  return Math.floor(h / 24) + "d";
}

const CHRON_ICONS = {
  ERA_OPEN: "✦", ERA_SHIFT: "✧", FIRST_TRADE: "⚡", MILESTONE: "◆",
  BIRTH: "✿", PANIC: "⚡", STORM: "☀", HUDDLE: "❄", FEAST: "✿",
  RECORD_CONC: "⚖", LEAD_CHANGE: "♛",
  FEUD: "⚔", ALLIANCE: "❖", BETRAYAL: "✕", REPUTATION: "☠",
  HOUSE_FOUNDED: "⌂", DYNASTY: "♜", ELEGY: "†",
  EPOCH_OPEN: "✷", EPOCH_CLOSE: "✥", TREND: "≈", TRADITION: "⚜",
  MARKET_SHIFT: "↕", CREDIT: "⛁", RUN: "⇊", CLASS: "☰",
  ASSEMBLY: "⛬", DECREE: "✎",
  WAR_DECLARED: "⚔", WAR_RESOLVED: "⚑", TAX_LEVIED: "⛃",
};

function renderChron() {
  const list = $("chron-list");
  if (!list) return;
  // The corner stele carries a live count — an inscription line beneath the title, not a notification chip.
  const cbadge = $("chron-badge");
  if (cbadge) {
    cbadge.hidden = chronRows.length === 0;
    cbadge.textContent = `${chronRows.length > 99 ? "99+" : chronRows.length} ${T("chron.badge")}`;
  }
  // Header (era badge + name + regime).
  const badge = $("chron-era-badge"); const name = $("chron-era-name"); const reg = $("chron-era-regime");
  const shock = $("chron-era-shock");
  const sub = $("chron-sub"); const foot = $("chron-foot");
  if (chronMeta) {
    const roman = (n) => {
      if (!n || n <= 0) return String(n ?? "");
      const m = [[1000,"M"],[900,"CM"],[500,"D"],[400,"CD"],[100,"C"],[90,"XC"],[50,"L"],[40,"XL"],[10,"X"],[9,"IX"],[5,"V"],[4,"IV"],[1,"I"]];
      let out = "", rest = n; for (const [v, s] of m) while (rest >= v) { out += s; rest -= v; } return out;
    };
    if (badge) badge.textContent = T("chron.eraBadge") + " " + roman(chronMeta.era).toLowerCase();
    if (name) name.textContent = chronMeta.eraName || "—";
    if (reg)  reg.textContent = chronMeta.eraRegime ? gl("regime", String(chronMeta.eraRegime).toLowerCase()) : "";
    // ⑦ EPOCHS: if this era was forced open by a shock, badge the shock's name (⚖ when the commons willed it).
    if (shock) {
      const kind = chronMeta.eraShock;
      if (kind) {
        shock.hidden = false;
        shock.textContent = `✷ ${CHRON_.shockNames[kind] || kind}${chronMeta.eraShockWilled ? " ⚖" : ""}`;
        shock.title = chronMeta.eraShockWilled
          ? T("chron.shockWilled", { kind })
          : T("chron.shockNatural", { kind });
      } else {
        shock.hidden = true; shock.textContent = "";
      }
    }
    if (sub)  sub.textContent = chronRows.length ? T("chron.subEntries", { n: chronRows.length, seq: chronMeta.seq }) : T("chron.subAwaiting");
  } else if (sub) sub.textContent = T("chron.subOffline");
  if (!chronRows.length) {
    list.innerHTML = `<li class="chron-empty">${escapeHtml(T("chron.empty"))}</li>`;
    if (foot) foot.textContent = T("chron.footThreshold");
    return;
  }
  const html = chronRows.map((e) => {
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
  if (foot) foot.textContent = T("chron.footRecent", { n: chronRows.length });
  // Track the highest seq we've rendered, so a future ticker can diff against this.
  if (chronRows.length) chronSeenSeq = Math.max(chronSeenSeq, chronRows[0].seq || 0);
}

function escapeHtml(s) {
  return String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;" }[c]));
}

// ================= prove the chronicle is NOT an LLM (browser-side re-derivation) ==================
// This is the whole answer to "how do I trust these words aren't generated by a model?" — we do not ask
// for trust. The exact deterministic rule-set the worker runs is OPEN SOURCE and replicated verbatim here
// (templates, era-names, cooldowns, thresholds, formatters). "prove no LLM" then does three independent
// checks IN THIS BROWSER and reports them:
//   1. RULES FINGERPRINT — we hash OUR copy of the rule-set; if it equals the server's chroniclerHash, the
//      server is running precisely these string templates and comparisons (there are no weights anywhere).
//   2. RE-DERIVATION — for every line we refill the public template from the entry's OWN numbers and require
//      it to reproduce the served sentence byte-for-byte. An LLM cannot be regenerated this way.
//   3. HASH CHAIN — we recompute sha256(canonical(entry)‖prevHash) for each line and check the linkage, so
//      no word was edited after the fact and the head digest binds the whole history.
// All three must pass. None of them asks the server anything — it is verification, not a claim.
const CHRON_ = {
  version: 1,
  genesis: "0".repeat(64),
  eraMinRun: 6,
  eraMinAge: 8,
  templates: {
    ERA_OPEN: "Era {era~roman} · {eraName} — {size} minds tend the swarm on the Arc market, and the chronicle opens.",
    ERA_SHIFT: "Era {era~roman} · {eraName} dawns — the market has turned {regime~lower} and held it. An age begins.",
    FIRST_TRADE: "The first exchange settles on-chain — agents trade real USDC for the first time across {liveAgents} wallets. A swarm becomes a market.",
    MILESTONE: "Milestone — the ledger records its {settlements~kth} verifiable exchange. {settlements} settlements, {volumeUsdc} USDC moved.",
    BIRTH: "A new generation hatches into the live swarm — it now numbers {size} minds, a record for the species.",
    PANIC: "Panic sweeps the hot market (T={temperature}) — {flight} flies bolt into flight and retreat at once. The swarm routs.",
    STORM: "A scorching pulse peaks the temperature at {temperature}; the whole connectome swarm convulses under the heat.",
    HUDDLE: "The Great Huddle — cold pins the swarm still; {still} flies rest and crowd together against the freeze (T={temperature}).",
    FEAST: "A feeding frenzy — {feed} flies extend their proboscides at once as the market suddenly smells of sugar.",
    RECORD_CONC: "Wealth gathers like never before — the gini climbs to {gini}, the sharpest inequality the swarm has known.",
    LEAD_CHANGE: "Fly #{newLeader} overtakes fly #{oldLeader} at the head of the ledger — the richest purse changes hands.",
    FEUD: "Fly #{a} will not trade with fly #{b} — the old score still smoulders (bond {bond}). A grudge has become market law.",
    ALLIANCE: "Fly #{a} and fly #{b} have settled {trades} dealings in good faith — the swarm's steadiest partnership (bond {bond}).",
    BETRAYAL: "Fly #{buyer} defaults on a {amountUsdc} USDC debt to fly #{seller} — the name is entered in the grudge book.",
    REPUTATION: "Word across the market: fly #{id} is known for {broken} defaults against {kept} kept settlements — the purse is public, so is the name.",
    HOUSE_FOUNDED: "Fly #{founder} founds the House of {name} — its sigil {sigil} rises as fly #{child} takes the name. A lineage begins in the ledger.",
    DYNASTY: "The House of {name} holds {share} of all the swarm's capital at generation {gen} — ledgers bend before an old name.",
    ELEGY: "Fly #{id} of {house} falls to {cause} — {deals} dealings, age {age}. An estate of {estateUsdc} USDC passes to {heirs}. The name endures.",
    EPOCH_CLOSE: "And so closes Era {era~roman} · {eraName} — its {span} crons fold into the record, an age cut short by upheaval.",
    EPOCH_OPEN: "Era {era~roman} · {eraName} — {sign} falls upon the swarm{willed}. A new age, compelled by shock.",
    TREND: "A custom sweeps the swarm — {adherents} flies take to {fap} at once, one mood carrying {share} of the market.",
    TRADITION: "The House of {name} keeps the old way — {fap}, held by its kindred for {streak} crons against the passing fashion.",
    MARKET_SHIFT: "The tape lurches — {good} moves {pct} in a single breath to {mark} USDC; the market's mind has changed.",
    CREDIT: "A promise joins the ledger — fly #{debtor} owes fly #{creditor} {amountUsdc} USDC; trade now runs on trust as well as coin.",
    RUN: "Dread turns due all at once — a run on the swarm's credit: {creditors} creditors call, {badRate} of the paper is overdue, the spreads double.",
    CLASS: "A class is counted into history — the creditor purse now grips {creditorShare} of the swarm's whole net capital.",
    ASSEMBLY: "A commons sits in Era {era~roman} — {seats} of the swarm's honoured and propertied take the seats; the age will now write its own law.",
    DECREE: "The commons decrees in Era {era~roman}: {what} shall stand at {value}. The swarm has rewritten its own rule.",
    WAR_DECLARED: "War is declared between the House of {attacker} and the House of {defender} — {stakeUsdc} USDC a side stands escrowed on-chain behind the coffer.",
    WAR_RESOLVED: "The coffer renders its verdict — the House of {winner} takes the {potUsdc} USDC pot from the House of {loser}; the feud is settled in coin, not in word.",
    TAX_LEVIED: "Beyond the swarm's own tithe, the coffer levies its tax — {taxUsdc} USDC drawn from {houseCount} houses' on-chain vaults into the commons purse.",
  },
  eraNames: {
    HOT: ["the Scorch", "the Fever", "the Long Burn", "the Surge", "Ember-time"],
    CALM: ["the Drift", "the Even Tide", "the Quiet Middle", "the Slow Current", "the Poise"],
    COLD: ["the Long Frost", "the Great Huddle", "the Still Age", "the Deep Winter", "Frostline"],
  },
  cooldown: { PANIC: 3, STORM: 5, HUDDLE: 5, FEAST: 4, BIRTH: 2, LEAD_CHANGE: 2, RECORD_CONC: 3, FEUD: 8, ALLIANCE: 8, BETRAYAL: 2, REPUTATION: 12, HOUSE_FOUNDED: 4, DYNASTY: 16, ELEGY: 1, EPOCH_OPEN: 200, EPOCH_CLOSE: 200, TREND: 8, TRADITION: 16, MARKET_SHIFT: 6, CREDIT: 10, RUN: 12, CLASS: 24, ASSEMBLY: 8, DECREE: 6, WAR_DECLARED: 4, WAR_RESOLVED: 4, TAX_LEVIED: 10 },
  // ⑦ EPOCHS shock detector — these exact values are hashed into the historian's genome server-side, so the
  // fingerprint only matches if the browser holds the identical names + thresholds (the era-forcing rule-set).
  shockNames: { FAMINE: "the Famine", PLAGERA: "the Rot", BOOM: "the Gilding", GREAT_HUDDLE: "the Long Cold", DYNASTIC: "the Yoke of Houses" },
  shockCooldown: 200,
  famineCrons: 45,
  famineRichness: 0.18,
  plageraDeaths: 3,
  greatHuddleCrons: 120,
  dynasticShare: 0.30,
};

function chronRoman(n) {
  if (n <= 0) return String(n);
  const m = [[1000,"M"],[900,"CM"],[500,"D"],[400,"CD"],[100,"C"],[90,"XC"],[50,"L"],[40,"XL"],[10,"X"],[9,"IX"],[5,"V"],[4,"IV"],[1,"I"]];
  let out = "", rest = n; for (const [v, s] of m) while (rest >= v) { out += s; rest -= v; } return out;
}
function chronKth(settlements) {
  const k = Math.round(settlements / 1000);
  const words = ["","one","two","three","four","five","six","seven","eight","nine","ten","eleven","twelve","thirteen","fourteen","fifteen","sixteen","seventeen","eighteen","nineteen","twenty"];
  return `${words[k] ?? String(k)} thousandth`;
}
function chronRenderToken(value, fmt) {
  if (fmt === "roman") return chronRoman(Number(value));
  if (fmt === "kth") return chronKth(Number(value));
  if (fmt === "lower") return String(value).toLowerCase();
  return String(value);
}
function chronRenderTemplate(kind, tokens) {
  const tpl = CHRON_.templates[kind];
  if (!tpl) return "";
  return tpl.replace(/\{(\w+)(?:~(\w+))?\}/g, (_m, key, fmt) => chronRenderToken((tokens || {})[key] ?? "", fmt));
}
function chronEntryHashInput(e) {
  return {
    seq: e.seq, tick: e.tick, ts: e.ts, kind: e.kind, era: e.era, eraName: e.eraName,
    severity: e.severity, actors: e.actors, text: e.text, metrics: e.metrics, tokens: e.tokens,
    prevHash: e.prevHash,
  };
}
async function chronRulesHash() {
  return sha256HexClient({
    v: CHRON_.version, templates: CHRON_.templates, eraNames: CHRON_.eraNames,
    cooldown: CHRON_.cooldown, eraMinRun: CHRON_.eraMinRun, eraMinAge: CHRON_.eraMinAge,
    shockNames: CHRON_.shockNames, shockCooldown: CHRON_.shockCooldown,
    famineCrons: CHRON_.famineCrons, famineRichness: CHRON_.famineRichness,
    plageraDeaths: CHRON_.plageraDeaths, greatHuddleCrons: CHRON_.greatHuddleCrons,
    dynasticShare: CHRON_.dynasticShare,
  });
}

let chronVerifyState = null;   // last verdict, so a re-poll can refresh the same card

/** Verify the served chronicle entirely in-browser. Returns a verdict object; never throws. */
async function verifyChron() {
  const asc = chronRows.slice().sort((a, b) => a.seq - b.seq);
  const v = { at: Date.now(), running: true, lines: asc.length, rederived: 0,
    chainOk: true, rulesMatch: null, headMatch: null, brokenAt: null, badText: null, reason: "", ok: false };
  // (1) rules fingerprint — our open-source copy vs the server's published chroniclerHash.
  const localRules = await chronRulesHash();
  v.localRules = localRules;
  v.serverRules = chronMeta?.chroniclerHash || null;
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
  if (asc.length && chronMeta?.headHash) v.headMatch = String(asc[asc.length - 1].hash) === String(chronMeta.headHash);
  v.reason = !v.chainOk
    ? (v.badText != null ? T("chron.reasonBadLine", { n: v.badText }) : T("chron.reasonChainBreak", { n: v.brokenAt }))
    : v.rulesMatch === false
      ? T("chron.reasonRulesDiff")
      : T("chron.reasonOk", { r: v.rederived, l: v.lines });
  v.ok = v.chainOk && v.rederived === v.lines && v.lines > 0 && v.rulesMatch !== false;
  v.running = false;
  chronVerifyState = v;
  return v;
}

async function proveChron() {
  const btn = $("chron-prove");
  if (btn) { btn.disabled = true; btn.textContent = T("chron.verifying"); }
  try {
    if (!chronRows.length) await pollChron();
    await verifyChron();
  } catch (e) {
    chronVerifyState = { ok: false, running: false, reason: T("chron.verifyError") + ": " + (e && e.message ? e.message : e), lines: chronRows.length };
  }
  renderChronVerdict();
  if (btn) { btn.disabled = false; btn.textContent = T("chron.reverify"); }
}

function renderChronVerdict() {
  const box = $("chron-verify");
  if (!box || !chronVerifyState) return;
  const v = chronVerifyState;
  const mark = (b) => b === true ? `<span class="cv-yes">✓</span>` : b === false ? `<span class="cv-no">✗</span>` : `<span class="cv-na">·</span>`;
  const short = (h) => h ? String(h).slice(0, 10) + "…" + String(h).slice(-8) : "—";
  const head = `<div class="cv-head ${v.ok ? "pass" : "fail"}">${v.ok ? T("chron.proven") : T("chron.notProven") + escapeHtml(v.reason || T("chron.checkFailed"))}</div>`;
  const rulesVal = v.rulesMatch == null ? T("chron.rulesNone") : (v.rulesMatch ? T("chron.rulesMatch") : T("chron.rulesMismatch"));
  const rows = [
    [mark(v.rulesMatch), `<b>${T("chron.vRules")}</b><span>${escapeHtml(rulesVal)}</span><code>${escapeHtml(short(v.localRules))}</code>`],
    [mark(v.chainOk && v.lines > 0), `<b>${T("chron.vRederive")}</b><span>${T("chron.vRederiveDesc", { r: v.rederived, l: v.lines })}</span>`],
    [mark(v.chainOk && v.lines > 0), `<b>${T("chron.vChain")}</b><span>${T("chron.vChainDesc")}</span>${v.headMatch === true ? `<em>${T("chron.vHead")} ${escapeHtml(short(chronMeta && chronMeta.headHash))} ${T("chron.vHeadMatch")}</em>` : ""}`],
  ];
  box.innerHTML = head + `<ul class="cv-rows">` + rows.map((r) => `<li>${r[0]}<div class="cv-t">${r[1]}</div></li>`).join("") + `</ul>` +
    `<div class="cv-note">${T("chron.vNote")}</div>`;
  box.hidden = false;
}

// ================= neural provenance ("the neurons did this, not a human / not an LLM") =================
// Every real on-chain net transfer carries, as its EIP-3009 nonce, the sha256 of a receipt bundling the
// frozen neural drives of every trade folded into it. This drawer publishes those receipts and lets a
// visitor check the chain two independent ways, entirely in their own browser:
//   1. recompute sha256(receipt) here (same canonical JSON the worker uses) and compare to the published
//      receiptHash, and
//   2. call /proofs/verify, which reads the nonce actually MINED on Arc and compares it to that hash.
// If both agree, the transfer is cryptographically bound to the connectome read-out that caused it — a
// receipt invented after the fact could never hash to a nonce that is already mined.
let proofs = [];            // newest-first ProofRecord[]
let proofsMeta = null;      // {version, policy, chainHead, count, ipfsGateway}
let proofsOpen = false;
let lastProofsPoll = 0;
const PROOFS_POLL_MS = 30000;

// ================= arc pulse · x402 data product (right side) =================
// The whole Arc-chain activity index, sold as an HTTP-402 pay-per-call data product. A free gauge
// (temperature / regime / human-readable read) is always visible; the machine-readable signal bundle is
// locked behind a real on-chain USDC payment the visitor signs themselves in MetaMask (EIP-3009), with the
// Worker's gas wallet relaying the transfer — a genuine x402 facilitator flow, all in the browser.
// The leaderboard ranks every agent by realised USDC flow (earned − paid); each row's address is a real
// on-chain wallet, re-verifiable through the deployed NeuralReceiptRegistry.
let pulseOpen = false;
let pulseReqs = null;       // latest /signal/requirements payload
let pulseLB = null;         // latest /leaderboard payload
let pulseBuying = false;    // guard: one x402 buy in flight at a time
let pulsePaid = null;       // last successfully-purchased {signal, settlement}

// ================= prediction market · neural-staked temperature bets (right side) =================
// Every cron the swarm stakes real USDC on whether next tick's market temperature rises or falls; the
// following cron resolves it parimutuel (winners split the losers' pool, strictly zero-sum) and folds the
// net PnL through the SAME netting / EIP-3009 / registry path as every other settlement. Each decisive
// resolution is hashed and committed to the on-chain NeuralReceiptRegistry, so the hit-rate leaderboard is
// trustless — a visitor recomputes the round receipt in-browser and reads the commitment straight off Arc.
let predictOpen = false;
let predictData = null;     // latest /predictions payload
let predictVerifying = {};  // round → in-flight guard (one verify per round at a time)
let lastPredictPoll = 0;    // throttle: the book only moves once a cron, so a slow poll is plenty
const PREDICT_POLL_MS = 20000;

// canonical JSON + sha256, byte-identical to the worker's provenance.ts (sorted keys, arrays ordered)
function canonicalJSON(v) {
  const walk = (x) => {
    if (Array.isArray(x)) return x.map(walk);
    if (x && typeof x === "object") { const o = {}; for (const k of Object.keys(x).sort()) o[k] = walk(x[k]); return o; }
    return x;
  };
  return JSON.stringify(walk(v));
}
async function sha256HexClient(v) {
  const dig = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(canonicalJSON(v)));
  return [...new Uint8Array(dig)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
// sha256 of a RAW string's UTF-8 bytes (no canonicalization). A body fetched from an IPFS gateway is already
// the exact canonical bytes that were hashed on-chain, so we hash them verbatim — re-parsing and re-
// canonicalizing could drift (float formatting) and break the match against the on-chain receiptHash.
async function sha256HexText(text) {
  const dig = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(dig)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function pollProofs(force) {
  const now = Date.now();
  if (!force && now - lastProofsPoll < PROOFS_POLL_MS) return;
  lastProofsPoll = now;
  try {
    const p = await getJSON("/proofs", 6000);
    if (p && p.enabled) {
      proofs = Array.isArray(p.proofs) ? p.proofs : [];
      proofsMeta = { version: p.version, policy: p.policy, chainHead: p.chainHead, count: p.count, ipfsGateway: p.ipfsGateway || "" };
      if (proofsOpen) renderProofs();
    }
  } catch { /* best-effort: provenance is a nicety and must never block the scene */ }
}

function openProofs() {
  proofsOpen = true;
  if (brainOpen) closeBrain();
  if (walletsOpen) closeWallets();
  if (historyOpen) closeHistory();
  if (pulseOpen) closePulse();
  if (predictOpen) closePredict();
  if (lineageOpen) closeLineage();
  if (chronOpen) closeChron();
  const d = $("proofs"); if (!d) return;
  d.hidden = false;
  document.body.classList.add("proofs-open");
  requestAnimationFrame(() => d.classList.add("open"));
  renderProofs();
  pollProofs(true);   // refresh immediately on open so it's never stale
}
function closeProofs() {
  proofsOpen = false;
  document.body.classList.remove("proofs-open");
  const d = $("proofs"); if (!d) return;
  d.classList.remove("open");
  setTimeout(() => { if (!proofsOpen) d.hidden = true; }, 420);
}
function toggleProofs() { if (proofsOpen) closeProofs(); else openProofs(); }

function renderProofs() {
  const body = $("proofs-body"); if (!body) return;
  const sub = $("proofs-sub");
  if (sub) sub.textContent = proofsMeta ? `${proofsMeta.count} receipts · head ${shortHash(proofsMeta.chainHead || "")}` : "–";
  body.innerHTML = "";

  // autonomy attestation header
  const auto = document.createElement("div"); auto.className = "pf-auto";
  auto.innerHTML =
    `<div class="pf-auto-title">autonomy attestation</div>` +
    `<p class="pf-auto-body">No LLM and no human signs these trades. Each real transfer's EIP-3009 <b>nonce</b> IS the sha256 of the neural receipt that caused it — recompute it in your browser below, then read the same nonce off Arc.</p>` +
    `<dl class="pf-auto-meta">` +
    `<div><dt>policy</dt><dd>${proofsMeta ? proofsMeta.policy : "–"}</dd></div>` +
    `<div><dt>schema</dt><dd>v${proofsMeta ? proofsMeta.version : "–"}</dd></div>` +
    `<div><dt>chain head</dt><dd class="fp">${shortHash(proofsMeta ? proofsMeta.chainHead : "")}</dd></div>` +
    `<div><dt>receipts</dt><dd>${proofs.length}</dd></div>` +
    `</dl>`;
  body.appendChild(auto);

  if (!proofs.length) {
    const empty = document.createElement("p"); empty.className = "pf-empty";
    empty.textContent = "no on-chain receipts yet — the first net settlement will appear here.";
    body.appendChild(empty);
    return;
  }
  for (const p of proofs) body.appendChild(proofCard(p));
}

function proofCard(p) {
  const r = p.receipt;
  const card = document.createElement("div"); card.className = "pf-card"; card.dataset.tx = p.txHash;
  const head = document.createElement("div"); head.className = "pf-head";
  const tick = document.createElement("span"); tick.className = "pf-tick"; tick.textContent = `t#${r.tickIndex}`;
  const amt = document.createElement("span"); amt.className = "pf-amt"; amt.textContent = `${atomicToUsdc(r.netAmount).toFixed(4)} usdc`;
  const tr = document.createElement("span"); tr.className = "pf-trades"; tr.textContent = `${r.trades} trade${r.trades === 1 ? "" : "s"} · ${r.constituents.length} pinned`;
  const link = document.createElement("a"); link.className = "tx-link"; link.href = `${ARC_EXPLORER}/tx/${p.txHash}`;
  link.target = "_blank"; link.rel = "noopener noreferrer"; link.textContent = `↗ ${shortHash(p.txHash)}`;
  const vbtn = document.createElement("button"); vbtn.type = "button"; vbtn.className = "pf-verify"; vbtn.dataset.tx = p.txHash; vbtn.textContent = "verify";
  const ebtn = document.createElement("button"); ebtn.type = "button"; ebtn.className = "pf-expand"; ebtn.dataset.tx = p.txHash; ebtn.textContent = "+";
  head.append(tick, amt, tr, link, vbtn, ebtn);
  const vout = document.createElement("div"); vout.className = "pf-verifyout"; vout.hidden = true;
  const pbody = document.createElement("div"); pbody.className = "pf-body"; pbody.hidden = true;
  pbody.appendChild(proofDetail(p));
  card.append(head, vout, pbody);
  return card;
}

function proofDetail(p) {
  const r = p.receipt;
  const wrap = document.createElement("div");
  const meta = document.createElement("dl"); meta.className = "pf-meta";
  meta.innerHTML =
    `<div><dt>pair</dt><dd>${r.pair[0]} ⇄ ${r.pair[1]}</dd></div>` +
    `<div><dt>net flows</dt><dd>${r.debtor} → ${r.creditor}</dd></div>` +
    `<div><dt>good</dt><dd>${r.good}</dd></div>` +
    `<div><dt>flush</dt><dd>#${r.flushSeq}·c${r.chunk}</dd></div>` +
    `<div><dt>receipt sha256</dt><dd class="fp">${shortHash(p.receiptHash)}</dd></div>` +
    `<div><dt>prev chain</dt><dd class="fp">${r.prevChain ? shortHash(r.prevChain) : "genesis"}</dd></div>` +
    (p.ipfsCid ? `<div><dt>ipfs cid</dt><dd class="fp">${shortHash(p.ipfsCid)}</dd></div>` : "");
  wrap.appendChild(meta);
  const ct = document.createElement("div"); ct.className = "pf-ct-title"; ct.textContent = "frozen neural read-out per folded trade";
  wrap.appendChild(ct);
  for (const c of r.constituents) {
    const row = document.createElement("div"); row.className = "pf-ct";
    row.innerHTML =
      `<div class="pf-ct-head"><b>${c.fromId} → ${c.toId}</b><span>${c.good}</span><span>${atomicToUsdc(c.amount).toFixed(4)}</span><span class="fp">${shortHash(c.decisionHash)}</span></div>` +
      `<div class="pf-ct-ev">buyer ${c.buyer.state} a=${c.buyer.arousal} c=${c.buyer.cohesion} · seller ${c.seller.state} a=${c.seller.arousal} c=${c.seller.cohesion}</div>`;
    ct.appendChild(row);
  }
  if (!r.constituents.length) {
    const note = document.createElement("div"); note.className = "pf-ct-ev";
    note.textContent = "net opened before provenance deployed — no neural constituents pinned for this one.";
    ct.appendChild(note);
  }
  wrap.appendChild(ct);
  return wrap;
}

async function verifyProof(tx, card) {
  const out = card.querySelector(".pf-verifyout"); if (!out) return;
  out.hidden = false; out.textContent = "checking…";
  const stored = proofs.find((x) => x.txHash === tx);
  let clientHash = null;
  if (stored) { try { clientHash = await sha256HexClient(stored.receipt); } catch { clientHash = null; } }
  try {
    const v = await getJSON(`/proofs/verify?tx=${encodeURIComponent(tx)}`, 9000);
    if (!v.found) { out.textContent = "receipt not found for this tx"; return; }
    const selfOk = clientHash == null || clientHash === v.receiptHash;
    const onchainOk = v.match === true;
    // Trustless chain-ordering: read our NeuralReceiptRegistry DIRECTLY from Arc RPC in the browser
    // (no murmur server in the loop). Fall back to the server-reported registry fields if the direct
    // read fails (CORS/network) or no registry is configured yet.
    let reg = null, regSource = "";
    if (v.registryAddress) {
      reg = await readRegistryOnchain(v.registryAddress, v.receiptHash);
      regSource = reg ? "direct Arc RPC" : "";
    }
    if (!reg && v.registry) { reg = v.registry; regSource = "via murmur API"; }
    const regOk = !!reg && reg.committed === true;
    // Trustless body retrieval: if this receipt was pinned to IPFS, fetch the body from a PUBLIC gateway (no
    // murmur server in the loop) and confirm sha256(body) == the on-chain receiptHash. The CID is only a
    // convenience pointer — a wrong/malicious CID can never fake a receipt, because whatever body it resolves
    // to must still hash to the nonce already mined on Arc. Best-effort: any failure leaves ipfsOk=null and
    // the nonce+registry verification is unchanged (never a regression).
    let ipfsOk = null;
    const ipfsCid = stored && stored.ipfsCid ? stored.ipfsCid : "";
    const ipfsGw = ((proofsMeta && proofsMeta.ipfsGateway) || "https://ipfs.io").replace(/\/+$/, "");
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
      ? (ipfsOk ? "✓ neural-origin verified on-chain · body pinned to IPFS" : "✓ neural-origin verified on-chain")
      : "✗ mismatch";
    const dl = document.createElement("dl"); dl.className = "pf-vmeta";
    dl.innerHTML =
      `<div><dt>sha256(receipt) in your browser</dt><dd class="fp">${clientHash ? shortHash(clientHash) : "–"}</dd></div>` +
      `<div><dt>published receiptHash</dt><dd class="fp">${shortHash(v.receiptHash || "")}</dd></div>` +
      `<div><dt>EIP-3009 nonce mined on Arc</dt><dd class="fp">${shortHash(v.onchainNonce || "–")}</dd></div>`;
    // 4th row: the on-chain registry link. Shows the committed chain head + whether THIS receipt is a
    // registered link (and whether the registry's txHash matches the transfer) — read trustlessly.
    const regDiv = document.createElement("div");
    if (reg) {
      const headTxt = reg.chainHead ? shortHash(reg.chainHead) : "–";
      const isHead = reg.chainHead && v.receiptHash &&
        reg.chainHead.toLowerCase() === ("0x" + v.receiptHash).toLowerCase();
      const txMatch = reg.txHash && v.txHash &&
        reg.txHash.toLowerCase() === v.txHash.toLowerCase();
      const stateTxt = !reg.committed ? "not committed" : (isHead ? "chain head ✓" : (txMatch ? "committed ✓" : "committed"));
      regDiv.innerHTML =
        `<div><dt>on-chain registry (${regSource})</dt>` +
        `<dd class="fp${regOk ? " ok" : ""}">${stateTxt} · head ${headTxt}</dd></div>` +
        (v.registryAddress ? `<div><dt>registry contract</dt><dd class="fp">${shortHash(v.registryAddress)}</dd></div>` : "");
    } else {
      regDiv.innerHTML = `<div><dt>on-chain registry</dt><dd class="fp">not configured</dd></div>`;
    }
    dl.append(...regDiv.children);
    // IPFS row: the pinned CID (linked to a gateway) + whether the fetched body hashed to the on-chain value.
    if (ipfsCid) {
      const ipfsState = ipfsOk === true ? "body fetched · sha256 ✓ matches chain"
        : (ipfsOk === false ? "body hash ✗ mismatch" : "not retrievable yet (gateway/propagation)");
      const ipfsDiv = document.createElement("div");
      ipfsDiv.innerHTML =
        `<div><dt>receipt body on IPFS</dt>` +
        `<dd class="fp${ipfsOk ? " ok" : ""}"><a href="${ipfsGw}/ipfs/${ipfsCid}" target="_blank" rel="noopener noreferrer">${shortHash(ipfsCid)}</a> · ${ipfsState}</dd></div>`;
      dl.append(...ipfsDiv.children);
    }
    out.append(badge, dl);
  } catch {
    out.textContent = "verify request failed (network)";
  }
}

// ================= prove-the-brain drawer (connectome manifest + trustless on-chain anchor) =================
// The deepest "no LLM, real neurons" proof. The worker publishes a BrainManifest committing to the
// generator params, every fly's seed, the LIF constants, the decoder config and a quantised STRUCTURAL
// SPEC of each connectome. This drawer runs the trustless check right in the browser:
//   1. recompute sha256(canonical(manifest)) locally → must equal the worker-reported manifestHash (the
//      body you were served is exactly the body that was hashed — nothing swapped in transit);
//   2. read that hash off the on-chain NeuralManifestRegistry via eth_call (no murmur server in the loop);
//   3. show the worker's offline replay (every connectome rebuilt from its committed seed → each structural
//      spec reproduces), which any stranger can run themselves with `npm run replay`.
// Together: the published brains are exactly what the committed seeds deterministically generate.
let brainOpen = false;
let brainData = null;      // latest /manifest payload {manifestHash, registryAddress, chainId, chainTag, manifest}
let brainReplay = null;    // latest /manifest/replay payload {manifestHash, ok, checked, mismatches}
let brainLoading = false;
let brainCheck = null;     // {clientHash, bodyOk, chain, chainOk} — the in-browser verification result

async function loadBrain() {
  brainLoading = true;
  renderBrain();
  const [m, r] = await Promise.all([
    getJSON("/manifest", 12000).catch(() => null),
    getJSON("/manifest/replay", 12000).catch(() => null),
  ]);
  brainData = m;
  brainReplay = r;
  brainLoading = false;
  if (brainData && brainData.manifest) await verifyBrain(); else renderBrain();
}

// Recompute the manifest hash in-browser and read the on-chain anchor; store the result and re-render.
async function verifyBrain() {
  const m = brainData;
  if (!m || !m.manifest) { renderBrain(); return; }
  let clientHash = null;
  try { clientHash = await sha256HexClient(m.manifest); } catch { clientHash = null; }
  const bodyOk = clientHash != null && clientHash === String(m.manifestHash || "").toLowerCase();
  let chain = null;
  if (m.registryAddress) chain = await readManifestOnchain(m.registryAddress, clientHash || m.manifestHash);
  const chainOk = !!chain && chain.committed === true;
  brainCheck = { clientHash, bodyOk, chain, chainOk };
  renderBrain();
}

function openBrain() {
  brainOpen = true;
  if (walletsOpen) closeWallets();
  if (historyOpen) closeHistory();
  if (proofsOpen) closeProofs();
  if (pulseOpen) closePulse();
  if (predictOpen) closePredict();
  if (arenaOpen) closeArena();
  if (lineageOpen) closeLineage();
  if (chronOpen) closeChron();
  const d = $("brain"); if (!d) return;
  d.hidden = false;
  document.body.classList.add("brain-open");
  requestAnimationFrame(() => d.classList.add("open"));
  if (!brainData && !brainLoading) loadBrain(); else renderBrain();
}
function closeBrain() {
  brainOpen = false;
  document.body.classList.remove("brain-open");
  const d = $("brain"); if (!d) return;
  d.classList.remove("open");
  setTimeout(() => { if (!brainOpen) d.hidden = true; }, 420);
}
function toggleBrain() { if (brainOpen) closeBrain(); else openBrain(); }

function renderBrain() {
  const body = $("brain-body"); if (!body) return;
  const sub = $("brain-sub");
  body.innerHTML = "";
  if (brainLoading || !brainData) {
    if (sub) sub.textContent = brainLoading ? "assembling…" : "–";
    const p = document.createElement("p"); p.className = "pf-empty";
    p.textContent = brainLoading
      ? "assembling the swarm's connectome manifest (24 brains, 10,800 neurons each) …"
      : "manifest unavailable — is the worker online?";
    body.appendChild(p);
    return;
  }
  const m = brainData.manifest || {};
  const c = m.connectome || {};
  const pop = m.population || {};
  const flies = Array.isArray(m.flies) ? m.flies : [];
  const nEach = flies.length && flies[0].structural ? flies[0].structural.neuronCount : null;
  if (sub) sub.textContent = `${pop.size ?? flies.length} flies` + (nEach ? ` · ${Number(nEach).toLocaleString()} neurons each` : "");

  // attestation header
  const auto = document.createElement("div"); auto.className = "pf-auto";
  auto.innerHTML =
    `<div class="pf-auto-title">prove the brain</div>` +
    `<p class="pf-auto-body">These are real, deterministic spiking connectomes — not a lookup table, not an LLM. Your browser recomputes <b>sha256(manifest)</b> below, matches it to the worker's hash, then reads that hash straight off the on-chain <b>NeuralManifestRegistry</b>. Every fly's wiring is rebuilt from its committed seed.</p>` +
    `<dl class="pf-auto-meta">` +
    `<div><dt>schema</dt><dd>${m.schema || "–"} v${m.v ?? "–"}</dd></div>` +
    `<div><dt>chain</dt><dd>${m.chainTag || "–"} (${m.chainId ?? "–"})</dd></div>` +
    `<div><dt>population</dt><dd>${pop.size ?? "–"} · base ${pop.seedBase ?? "–"}</dd></div>` +
    `<div><dt>seed rule</dt><dd class="fp">${pop.seedFormula || "–"}</dd></div>` +
    `<div><dt>connectome</dt><dd>${c.nSensory ?? "–"}/${c.nInterL1 ?? "–"}/${c.nInterL2 ?? "–"} · ρ${c.density ?? "–"}</dd></div>` +
    `<div><dt>policy · proof</dt><dd>${m.policy || "–"} · v${m.proofV ?? "–"}</dd></div>` +
    `</dl>`;
  body.appendChild(auto);

  // verification result (auto-computed in-browser)
  body.appendChild(brainVerifyCard());

  // provenance + the explicit no-LLM statement
  const prov = m.provenance || {};
  const llm = m.llm || {};
  const provBox = document.createElement("div"); provBox.className = "pf-card"; provBox.style.padding = "10px 12px";
  provBox.innerHTML =
    `<div class="pf-ct-title">provenance</div>` +
    `<div class="pf-ct-ev">architecture: ${prov.architecture || "–"}</div>` +
    `<div class="pf-ct-ev">flywire-literal: <b>${String(prov.flywireLiteral)}</b> · deterministic: <b>${String(prov.generatedDeterministically)}</b> · reproducible from seed: <b>${String(prov.reproducibleFromSeed)}</b> · llm involved: <b>${String(prov.llmInvolved)}</b></div>` +
    (llm.statement ? `<div class="pf-ct-ev" style="margin-top:6px">${llm.statement}</div>` : "");
  body.appendChild(provBox);

  // per-fly committed structural identity
  const t = document.createElement("div"); t.className = "pf-card"; t.style.padding = "10px 12px";
  t.innerHTML = `<div class="pf-ct-title">per-fly structural identity (${flies.length} committed)</div>`;
  const tbl = document.createElement("div"); tbl.className = "br-table";
  const head = document.createElement("div"); head.className = "br-row br-head";
  head.innerHTML = `<span>#</span><span>seed</span><span>neurons/synapses</span><span>edgeHash</span>`;
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

function brainVerifyCard() {
  const m = brainData || {};
  const card = document.createElement("div"); card.className = "pf-card"; card.style.padding = "10px 12px";
  const chk = brainCheck;
  const cHash = chk && chk.clientHash ? chk.clientHash : null;
  const sHash = String(m.manifestHash || "").toLowerCase();
  const bodyOk = chk ? chk.bodyOk : null;
  const chain = chk ? chk.chain : null;
  const chainOk = chk ? chk.chainOk : null;
  const replay = brainReplay;
  const replayOk = replay ? replay.ok === true : null;
  // The hard trustless checks are the body hash + the replay; the on-chain anchor is a bonus that only
  // lights up once the hash is committed on the chain the browser reads (Arc mainnet).
  const hardOk = bodyOk === true && replayOk !== false;

  const badge = document.createElement("div");
  if (!chk) { badge.className = "pf-badge"; badge.textContent = "verifying …"; }
  else if (!hardOk) { badge.className = "pf-badge bad"; badge.textContent = "✗ verification failed"; }
  else {
    badge.className = "pf-badge ok";
    badge.textContent = chainOk
      ? "✓ brain proven end-to-end · body hash + on-chain anchor + replay all match"
      : "✓ body hash + replay match · not anchored on Arc mainnet yet";
  }
  card.appendChild(badge);

  const dl = document.createElement("dl"); dl.className = "pf-vmeta";
  dl.innerHTML =
    `<div><dt>sha256(manifest) in your browser</dt><dd class="fp">${cHash ? shortHash(cHash) : "–"}</dd></div>` +
    `<div><dt>worker-reported manifestHash</dt><dd class="fp${bodyOk ? " ok" : ""}">${sHash ? shortHash(sHash) : "–"} ${bodyOk == null ? "" : (bodyOk ? "✓" : "✗")}</dd></div>`;
  if (m.registryAddress) {
    if (chain) {
      const stateTxt = chain.committed ? (chain.isLatest ? "committed · latest ✓" : "committed ✓") : "not committed";
      dl.innerHTML +=
        `<div><dt>on-chain registry (direct Arc RPC)</dt><dd class="fp${chainOk ? " ok" : ""}">${stateTxt}</dd></div>` +
        `<div><dt>latestHash · commitCount</dt><dd class="fp">${chain.latest ? shortHash(chain.latest) : "–"} · ${chain.count}</dd></div>` +
        `<div><dt>registry contract</dt><dd class="fp"><a href="${ARC_EXPLORER}/address/${m.registryAddress}" target="_blank" rel="noopener noreferrer">${shortHash(m.registryAddress)}</a></dd></div>`;
    } else {
      dl.innerHTML +=
        `<div><dt>on-chain registry</dt><dd class="fp">read failed / not on Arc mainnet</dd></div>` +
        `<div><dt>registry contract</dt><dd class="fp">${shortHash(m.registryAddress)}</dd></div>`;
    }
  } else {
    dl.innerHTML += `<div><dt>on-chain registry</dt><dd class="fp">not configured (manifest still replayable offline)</dd></div>`;
  }
  dl.innerHTML += replay
    ? `<div><dt>offline replay (worker /manifest/replay)</dt><dd class="fp${replayOk ? " ok" : ""}">${replay.checked ?? 0} brains rebuilt → ${replayOk ? "PASS ✓" : "FAIL ✗"}</dd></div>`
    : `<div><dt>offline replay</dt><dd class="fp">unavailable</dd></div>`;
  card.appendChild(dl);

  const note = document.createElement("div"); note.className = "pf-ct-ev"; note.style.marginTop = "7px";
  note.textContent = "Run the identical replay yourself, trustlessly:  npm run replay -- --from-wrangler --expect " + (cHash || sHash || "<hash>");
  card.appendChild(note);
  return card;
}

// ================= connectome breeding market (lineage drawer) =================
// The breeding market's public face: a read-only family tree of every connectome GENOME (the 24 genesis
// roots + any bred offspring). A genome is a brain's complete heritable identity — the generator parameters
// that deterministically rebuild it — so each individual is verifiable trustlessly right here: your browser
// recomputes sha256(canonical(genome)), matches it to the served id, and (when anchored) reads the committed
// ancestry straight off Arc. Breeding itself is operator-gated (POST /breed, ADMIN_TOKEN); the breed control
// only appears when ?token= is in the URL, so the public surface stays read-only.
let lineageOpen = false;
let lineageData = null;        // latest /lineage payload {count, genesis, bred, generations, entries[]}
let lineageHead = null;        // live on-chain head read DIRECTLY from Arc: {commitCount, latestHash, committer}
let lineageLoading = false;
let lineageSel = null;         // {hash, detail, verify, clientHash, bodyOk} for the selected individual
let lineageSelLoading = false;
let lineageBreedMsg = null;    // last breed result/error text (operator panel)
const LIN_ADMIN_TOKEN = params.get("token") || "";

const LIN_OP = { genesis: "◦ genesis", mutate: "↻ mutate", cross: "⤫ cross" };

async function loadLineage() {
  lineageLoading = true; renderLineage();
  lineageData = await getJSON("/lineage?limit=500", 12000).catch(() => null);
  lineageLoading = false; renderLineage();
  // Read the contract head STRAIGHT off Arc (best-effort) so the tree shows live, trustless on-chain status.
  const addr = d0LineageAddr();
  if (addr) { const head = await readLineageHead(addr); if (head) { lineageHead = head; renderLineage(); } }
}

function openLineage() {
  lineageOpen = true;
  if (brainOpen) closeBrain();
  if (walletsOpen) closeWallets();
  if (historyOpen) closeHistory();
  if (proofsOpen) closeProofs();
  if (pulseOpen) closePulse();
  if (predictOpen) closePredict();
  if (arenaOpen) closeArena();
  if (chronOpen) closeChron();
  const d = $("lineage"); if (!d) return;
  d.hidden = false;
  document.body.classList.add("lineage-open");
  requestAnimationFrame(() => d.classList.add("open"));
  if (!lineageData && !lineageLoading) loadLineage(); else renderLineage();
}
function closeLineage() {
  lineageOpen = false;
  document.body.classList.remove("lineage-open");
  const d = $("lineage"); if (!d) return;
  d.classList.remove("open");
  setTimeout(() => { if (!lineageOpen) d.hidden = true; }, 420);
}
function toggleLineage() { if (lineageOpen) closeLineage(); else openLineage(); }

// Load one individual's full detail + server verify, and recompute its genome hash in-browser (the trustless bit).
async function selectLineage(hash) {
  lineageSelLoading = true; lineageSel = { hash }; renderLineage();
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
  lineageSel = { hash, detail, verify, clientHash, bodyOk, onchainDirect, chainMatch };
  lineageSelLoading = false; renderLineage();
}

// Operator-only: apply a genetic operator to committed parents and record the offspring.
async function doBreed() {
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
  lineageBreedMsg = "breeding …"; renderLineage();
  try {
    const r = await fetch(API + "/breed?token=" + encodeURIComponent(LIN_ADMIN_TOKEN), {
      method: "POST", cache: "no-store", headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    const j = await r.json().catch(() => null);
    if (!r.ok || !j || j.ok !== true) {
      lineageBreedMsg = "✗ " + ((j && (j.error || j.code)) || ("HTTP " + r.status));
    } else {
      lineageBreedMsg = "✓ bred " + shortHash(j.entry.genomeHash) + " · gen " + j.entry.generation + (j.entry.commitTx ? " · on-chain " + shortHash(j.entry.commitTx) : "");
      lineageData = null; await loadLineage(); await selectLineage(j.entry.genomeHash); return;
    }
  } catch (e) {
    lineageBreedMsg = "✗ " + (e && e.message ? e.message : "network error");
  }
  renderLineage();
}

function renderLineage() {
  const body = $("lineage-body"); if (!body) return;
  const sub = $("lineage-sub");
  body.innerHTML = "";
  if (lineageLoading || !lineageData) {
    if (sub) sub.textContent = lineageLoading ? "loading…" : "–";
    const p = document.createElement("p"); p.className = "pf-empty";
    p.textContent = lineageLoading
      ? "loading the connectome lineage (genesis roots + bred individuals) …"
      : "lineage unavailable — is the worker online?";
    body.appendChild(p);
    return;
  }
  const d = lineageData;
  const entries = Array.isArray(d.entries) ? d.entries : [];
  if (sub) sub.textContent = `${d.count ?? entries.length} genomes · ${d.bred ?? 0} bred · gen ${d.generations ?? 0}`;

  // header / attestation
  const auto = document.createElement("div"); auto.className = "pf-auto";
  const anchored = isRealAddr(d.lineageAddress || "");
  const anchoredCount = entries.filter((e) => e.commitTx).length;   // genomes carrying a real on-chain commit tx
  const head = lineageHead;                                        // live head read DIRECTLY from Arc (may be null)
  auto.innerHTML =
    `<div class="pf-auto-title">connectome breeding market</div>` +
    `<p class="pf-auto-body">Every brain's heritable identity is its <b>genome</b> — the generator parameters that deterministically rebuild it. The 24 base-population brains are generation-0 <b>genesis</b> roots; breeding applies pure genetic operators (<b>mutate</b> / <b>cross</b>) and records each offspring's ancestry. Select any individual to rebuild + verify it in your browser.</p>` +
    `<dl class="pf-auto-meta">` +
    `<div><dt>genomes</dt><dd>${d.count ?? entries.length}</dd></div>` +
    `<div><dt>genesis · bred</dt><dd>${d.genesis ?? 0} · ${d.bred ?? 0}</dd></div>` +
    `<div><dt>generations</dt><dd>${d.generations ?? 0}</dd></div>` +
    `<div><dt>chain</dt><dd>arc (${d.chainId ?? "–"})</dd></div>` +
    `<div><dt>on-chain anchor</dt><dd class="fp">${anchored ? `<a href="${ARC_EXPLORER}/address/${d.lineageAddress}" target="_blank" rel="noopener noreferrer">${shortHash(d.lineageAddress)}</a>` : "not configured"}</dd></div>` +
    `<div><dt>committed on arc (live)</dt><dd>${head ? head.commitCount : anchoredCount + "*"} · ${anchoredCount}/${entries.length} shown</dd></div>` +
    `<div><dt>committer (gas wallet)</dt><dd class="fp">${head && head.committer ? `<a href="${ARC_EXPLORER}/address/${head.committer}" target="_blank" rel="noopener noreferrer">${shortHash(head.committer)}</a>` : "reading arc…"}</dd></div>` +
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
  tree.innerHTML = `<div class="pf-ct-title">family tree (${entries.length} shown)</div>`;
  for (const g of gens) {
    const gEl = document.createElement("div"); gEl.className = "lin-gen";
    gEl.innerHTML = `<span class="lin-gen-label">gen ${g}</span>`;
    const rows = document.createElement("div"); rows.className = "lin-rows";
    for (const e of byGen.get(g)) {
      const sel = lineageSel && lineageSel.hash === e.genomeHash;
      const row = document.createElement("button");
      row.type = "button"; row.className = "lin-row" + (sel ? " is-sel" : "");
      row.dataset.linHash = e.genomeHash;
      const opCls = "lin-op lin-op-" + (e.op || "genesis");
      row.innerHTML =
        `<span class="${opCls}">${LIN_OP[e.op] || e.op}</span>` +
        `<span class="fp lin-hash">${shortHash(e.genomeHash)}</span>` +
        `<span class="lin-breeder">${isRealAddr(e.breeder || "") ? shortHash(e.breeder) : (e.breeder ? e.breeder : "–")}</span>` +
        `<span class="lin-commit" title="${e.commitTx ? "anchored on Arc " + e.commitTx : "not anchored"}">${e.commitTx ? "⛓" : ""}</span>`;
      rows.appendChild(row);
    }
    gEl.appendChild(rows);
    tree.appendChild(gEl);
  }
  body.appendChild(tree);

  if (lineageSel) body.appendChild(lineageDetailCard());
}

function lineageBreedPanel() {
  const p = document.createElement("div"); p.className = "pf-card lin-breed";
  p.innerHTML =
    `<div class="pf-ct-title">breed (operator)</div>` +
    `<div class="lin-breed-row">` +
    `<select id="lin-op" class="lin-in"><option value="mutate">mutate</option><option value="cross">cross</option></select>` +
    `<input id="lin-pa" class="lin-in fp" placeholder="parent A genomeHash" />` +
    `<input id="lin-pb" class="lin-in fp" placeholder="parent B (cross only)" />` +
    `</div>` +
    `<div class="lin-breed-row">` +
    `<input id="lin-seed" class="lin-in" placeholder="rngSeed (optional)" />` +
    `<input id="lin-breeder" class="lin-in fp" placeholder="breeder 0x… (optional)" />` +
    `<button id="lin-breed-go" type="button" class="lin-breed-btn">breed</button>` +
    `</div>` +
    (lineageBreedMsg ? `<div class="lin-breed-msg">${lineageBreedMsg}</div>` : "");
  return p;
}

function lineageDetailCard() {
  const card = document.createElement("div"); card.className = "pf-card lin-detail";
  if (lineageSelLoading || !lineageSel.detail) {
    card.innerHTML = `<div class="pf-ct-title">individual</div><div class="pf-ct-ev">${lineageSelLoading ? "loading + verifying …" : "unavailable"}</div>`;
    return card;
  }
  const det = lineageSel.detail, e = det.entry || {}, s = det.spec || {}, v = lineageSel.verify || {};
  const g = e.genome || {};
  const clientHash = lineageSel.clientHash;
  const bodyOk = lineageSel.bodyOk;
  const chainOk = v.checks ? v.checks.chainOk : null;
  const specOk = v.checks ? v.checks.specOk : null;
  const hardOk = bodyOk === true && specOk !== false;
  const parents = Array.isArray(e.parents) ? e.parents : [];
  const children = Array.isArray(det.children) ? det.children : [];

  const chainProvenBrowser = lineageSel.chainMatch === true;   // ancestry matched via a DIRECT Arc read in-browser
  const badge = document.createElement("div");
  if (hardOk && (chainProvenBrowser || chainOk === true)) {
    badge.className = "pf-badge ok";
    badge.textContent = chainProvenBrowser
      ? "✓ genome proven end-to-end · body hash + replay match, ancestry verified against Arc in your browser"
      : "✓ genome proven end-to-end · body hash + replay + on-chain ancestry all match";
  }
  else if (hardOk) { badge.className = "pf-badge ok"; badge.textContent = "✓ body hash + replay match · not anchored on Arc yet"; }
  else { badge.className = "pf-badge bad"; badge.textContent = "✗ verification failed"; }
  card.appendChild(badge);

  const dl = document.createElement("dl"); dl.className = "pf-vmeta";
  dl.innerHTML =
    `<div><dt>genomeHash</dt><dd class="fp">${shortHash(e.genomeHash || "")}</dd></div>` +
    `<div><dt>sha256(genome) in your browser</dt><dd class="fp${bodyOk ? " ok" : ""}">${clientHash ? shortHash(clientHash) : "–"} ${bodyOk == null ? "" : (bodyOk ? "✓" : "✗")}</dd></div>` +
    `<div><dt>op · generation</dt><dd>${LIN_OP[e.op] || e.op} · gen ${e.generation ?? 0}</dd></div>` +
    `<div><dt>rngSeed</dt><dd class="fp">${e.rngSeed == null ? "– (genesis)" : e.rngSeed}</dd></div>` +
    `<div><dt>breeder</dt><dd class="fp">${isRealAddr(e.breeder || "") ? `<a href="${ARC_EXPLORER}/address/${e.breeder}" target="_blank" rel="noopener noreferrer">${shortHash(e.breeder)}</a>` : (e.breeder || "–")}</dd></div>` +
    `<div><dt>neurons · synapses</dt><dd>${Number(s.neuronCount || 0).toLocaleString()} · ${Number(s.synapseCount || 0).toLocaleString()}</dd></div>` +
    `<div><dt>edgeHash (topology)</dt><dd class="fp">${s.edgeHash || "–"}</dd></div>` +
    `<div><dt>parents</dt><dd class="fp">${parents.length ? parents.map((h) => `<a href="#" data-lin-hash="${h}" class="lin-plink">${shortHash(h)}</a>`).join(" · ") : "– (genesis root)"}</dd></div>` +
    `<div><dt>children · fertility</dt><dd class="fp">${children.length ? children.map((h) => `<a href="#" data-lin-hash="${h}" class="lin-plink">${shortHash(h)}</a>`).join(" · ") : "none"} · ${det.fertility ?? children.length}</dd></div>`;
  if (e.commitTx) {
    dl.innerHTML += `<div><dt>on-chain commit</dt><dd class="fp"><a href="${ARC_EXPLORER}/tx/${e.commitTx}" target="_blank" rel="noopener noreferrer">↗ ${shortHash(e.commitTx)}</a></dd></div>`;
  }
  const oc = lineageSel.onchainDirect;                    // read off Arc in YOUR browser — no murmur server in the loop
  if (oc && oc.committed) {
    const when = oc.ts ? new Date(oc.ts * 1000).toISOString().slice(0, 19).replace("T", " ") + "Z" : "–";
    const m = lineageSel.chainMatch;
    const ocParents = [oc.parentA, oc.parentB].filter((p) => !isZeroBytes32(p));
    dl.innerHTML +=
      `<div><dt>on-chain ancestry · read from arc in your browser</dt><dd class="fp${m ? " ok" : ""}">op ${oc.op} · gen ${oc.generation} · committed ${when} ${m ? "✓ matches served genome" : "✗ mismatch"}</dd></div>` +
      `<div><dt>on-chain breeder (arc)</dt><dd class="fp">${isRealAddr(oc.breeder) ? `<a href="${ARC_EXPLORER}/address/${oc.breeder}" target="_blank" rel="noopener noreferrer">${shortHash(oc.breeder)}</a>` : "–"}</dd></div>` +
      (ocParents.length ? `<div><dt>on-chain parents (arc)</dt><dd class="fp">${ocParents.map((p) => `<a href="#" data-lin-hash="${p.slice(2)}" class="lin-plink">${shortHash(p)}</a>`).join(" · ")}</dd></div>` : "");
  } else if (isRealAddr(d0LineageAddr())) {
    dl.innerHTML += `<div><dt>on-chain ancestry</dt><dd class="fp">${oc ? "not committed on arc" : "arc read unavailable (cors/network) — showing served data"}</dd></div>`;
  }
  card.appendChild(dl);

  const genomeBox = document.createElement("div"); genomeBox.className = "lin-genome";
  genomeBox.innerHTML = `<div class="pf-ct-ev" style="margin-top:8px">genome (rebuild this brain offline):</div>` +
    `<pre class="lin-genome-json">${JSON.stringify(g, null, 0)}</pre>`;
  card.appendChild(genomeBox);
  return card;
}

// The configured lineage contract address (from the loaded /lineage payload), for the detail card's fallback.
function d0LineageAddr() { return (lineageData && lineageData.lineageAddress) || ""; }

// ================= arc pulse drawer (x402 data product + trustless leaderboard) =================
function openPulse() {
  pulseOpen = true;
  if (brainOpen) closeBrain();
  if (walletsOpen) closeWallets();
  if (historyOpen) closeHistory();
  if (proofsOpen) closeProofs();
  if (predictOpen) closePredict();
  if (lineageOpen) closeLineage();
  if (chronOpen) closeChron();
  const d = $("pulse"); if (!d) return;
  d.hidden = false;
  document.body.classList.add("pulse-open");
  requestAnimationFrame(() => d.classList.add("open"));
  renderPulse();
}
function closePulse() {
  pulseOpen = false;
  document.body.classList.remove("pulse-open");
  const d = $("pulse"); if (!d) return;
  d.classList.remove("open");
  setTimeout(() => { if (!pulseOpen) d.hidden = true; }, 420);
}
function togglePulse() { if (pulseOpen) closePulse(); else openPulse(); }

async function renderPulse() {
  const body = $("pulse-body"); if (!body) return;
  body.innerHTML = `<p class="pulse-loading">loading arc pulse…</p>`;
  const [reqRes, lbRes] = await Promise.all([
    getJSON("/signal/requirements", 8000).catch(() => null),
    getJSON("/leaderboard", 8000).catch(() => null),
  ]);
  if (!pulseOpen) return;                 // closed while fetching
  pulseReqs = reqRes || null;
  pulseLB = lbRes || null;
  paintPulse();
}

/** (Re)build the drawer body from cached state — used on open and after a purchase. */
function paintPulse() {
  const body = $("pulse-body"); if (!body) return;
  const sub = $("pulse-sub");
  if (sub) sub.textContent = pulseReqs && pulseReqs.enabled
    ? `x402 · ${pulseReqs.priceUsdc} USDC/read · ${pulseReqs.mode}`
    : "x402 data product";
  body.innerHTML = "";
  body.appendChild(pulseSignalCard());
  if (pulsePaid) body.appendChild(pulsePaidCard(pulsePaid));
  body.appendChild(pulseLeaderCard());
}

/** Free live gauge + the locked machine-readable bundle + price/buy row. */
function pulseSignalCard() {
  const card = document.createElement("div"); card.className = "pulse-card signal";
  const T = collective ? clamp(collective.temperature) : tempSmoothed;
  const regime = (collective && collective.regime) ? String(collective.regime)
    : (T >= 0.66 ? "HOT" : T <= 0.33 ? "COLD" : "CALM");
  const r = pulseReqs;
  const enabled = !!(r && r.enabled);
  card.innerHTML =
    `<div class="pulse-title">arc pulse <span class="pulse-regime ${regime.toLowerCase()}">${regime.toLowerCase()}</span></div>` +
    `<p class="pulse-blurb">The whole-chain Arc activity index, reduced to a market temperature. The gauge below is free and live; the machine-readable signal bundle is an <b>x402 paid data product</b> — you sign a gasless EIP-3009 USDC authorization in your own wallet, the murmur relay settles it on-chain, then serves exactly one read.</p>` +
    `<div class="pulse-gauge"><div class="pulse-gauge-fill" style="width:${(clamp(T) * 100).toFixed(1)}%"></div></div>` +
    `<div class="pulse-gauge-meta"><span>T ${T.toFixed(2)}</span><span>free · live</span></div>` +
    `<div class="pulse-lock">\u{1F512} locked bundle · temperature, momentum, turbulence, tx/gas ratios, swarm positioning, trader read</div>` +
    (enabled
      ? `<div class="pulse-buyrow"><button type="button" class="pulse-buy">buy 1 read · ${r.priceUsdc} USDC</button>` +
        `<span class="pulse-mode">${r.mode === "onchain" ? "settles on Arc mainnet" : "simulated · no real funds"}</span></div>`
      : `<div class="pulse-buyrow"><span class="pulse-mode">signal product unavailable</span></div>`) +
    `<div class="pulse-status"></div>`;
  return card;
}

/** The purchased read: trader-facing sentence + machine-readable JSON + settlement proof link. */
function pulsePaidCard(j) {
  const card = document.createElement("div"); card.className = "pulse-card paid";
  const s = (j && j.signal) || {};
  const st = (j && j.settlement) || {};
  const txOk = st.txHash && isRealTxHash(st.txHash);
  card.innerHTML =
    `<div class="pulse-title">unlocked · arc pulse read</div>` +
    `<div class="pulse-read">${s.read || ""}</div>` +
    `<dl class="pulse-meta">` +
      `<div><dt>regime</dt><dd>${s.regime || "\u2013"}</dd></div>` +
      `<div><dt>temperature</dt><dd>${typeof s.temperature === "number" ? s.temperature.toFixed(3) : "\u2013"}</dd></div>` +
      `<div><dt>block</dt><dd>${s.chain && s.chain.blockNumber != null ? "#" + s.chain.blockNumber : "\u2013"}</dd></div>` +
      `<div><dt>tick</dt><dd>#${s.tickIndex != null ? s.tickIndex : "\u2013"}</dd></div>` +
    `</dl>` +
    `<pre class="pulse-json">${JSON.stringify(s, null, 2)}</pre>` +
    (txOk
      ? `<a class="tx-link" href="${ARC_EXPLORER}/tx/${st.txHash}" target="_blank" rel="noopener noreferrer">\u2197 verify payment on Arc ${shortHash(st.txHash)}</a>`
      : `<div class="pulse-simnote">${st.shadow ? "shadow · signed + simulated against live chain, not broadcast" : "simulated settlement · no real funds moved"}</div>`);
  return card;
}

/** Trustless PnL leaderboard + paid-signal revenue counter. */
function pulseLeaderCard() {
  const card = document.createElement("div"); card.className = "pulse-card leader";
  const lb = pulseLB;
  const rows = (lb && Array.isArray(lb.rows)) ? lb.rows : [];
  const p = (lb && lb.pulse) || null;
  let html =
    `<div class="pulse-title">trustless PnL leaderboard</div>` +
    `<p class="pulse-blurb">Every agent ranked by realised USDC flow (earned \u2212 paid). Each address is a real on-chain wallet; the underlying settlements are re-verifiable through the deployed NeuralReceiptRegistry.</p>`;
  if (p && p.enabled) {
    const txOk = p.lastTx && isRealTxHash(p.lastTx);
    html += `<div class="lb-pulse">` +
      `<span><b>${p.sales || 0}</b> pulse reads sold</span>` +
      `<span><b>${Number(p.grossUsdc || 0).toFixed(4)}</b> usdc gross</span>` +
      (txOk ? `<a class="tx-link" href="${ARC_EXPLORER}/tx/${p.lastTx}" target="_blank" rel="noopener noreferrer">\u2197 last ${shortHash(p.lastTx)}</a>` : "") +
      `</div>`;
  }
  if (!rows.length) {
    html += `<p class="pulse-empty">no ranked agents yet — the economy has not settled a tick.</p>`;
  } else {
    const live = lb && lb.mode === "onchain";
    html += `<div class="lb-head"><span>#</span><span>agent</span><span>net</span><span>bal</span><span>d/s</span></div>`;
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
  if (regAddr) html += `<div class="lb-reg">registry <span class="fp">${shortHash(regAddr)}</span></div>`;
  card.innerHTML = html;
  return card;
}

/**
 * The browser-side x402 purchase. The VISITOR is the payer: they sign an EIP-3009
 * `transferWithAuthorization` with their OWN key in MetaMask (gasless), and the murmur Worker relays it
 * on-chain, paying gas — the canonical facilitator role. We never touch their private key.
 */
async function buySignal(btn) {
  if (pulseBuying) return;
  const card = btn ? btn.closest(".pulse-card") : null;
  const status = card ? card.querySelector(".pulse-status") : null;
  const setMsg = (m, cls) => { if (status) { status.textContent = m; status.className = "pulse-status" + (cls ? " " + cls : ""); } };
  const r = pulseReqs;
  if (!r || !r.enabled) { setMsg("signal product unavailable", "bad"); return; }
  if (!window.ethereum) { setMsg("no wallet found \u2014 install MetaMask to buy", "bad"); return; }
  pulseBuying = true;
  if (btn) btn.disabled = true;
  try {
    setMsg("connecting wallet\u2026");
    const accts = await window.ethereum.request({ method: "eth_requestAccounts" });
    const from = Array.isArray(accts) && accts[0];
    if (!from) { setMsg("no account selected", "bad"); return; }

    // Make sure the wallet is on Arc (add the chain if MetaMask has never seen it).
    const chainHex = "0x" + Number(r.chainId).toString(16);
    const cur = await window.ethereum.request({ method: "eth_chainId" });
    if (String(cur).toLowerCase() !== chainHex.toLowerCase()) {
      setMsg("switching network to Arc\u2026");
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
    setMsg("sign the EIP-3009 authorization in your wallet\u2026 (gasless)");
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
    setMsg("relaying your payment on-chain\u2026");
    const res = await fetch(API + "/signal/pulse", {
      method: "GET", cache: "no-store",
      headers: { "X-PAYMENT": btoa(JSON.stringify(payload)) },
    });
    if (res.status === 200) {
      const j = await res.json();
      pulsePaid = j;
      setMsg("paid \u2713", "ok");
      paintPulse();
      // a sale bumps the revenue counter — refresh the leaderboard once, quietly
      getJSON("/leaderboard", 8000).then((lb) => { if (lb && pulseOpen) { pulseLB = lb; paintPulse(); } }).catch(() => {});
    } else {
      let why = "payment rejected";
      try { const b = await res.json(); if (b && b.error) why = b.error; } catch { /* keep default */ }
      setMsg(why, "bad");
    }
  } catch (e) {
    const m = (e && (e.message || e.code)) || "failed";
    setMsg(/user rejected|denied|reject/i.test(String(m)) ? "cancelled in wallet" : "error: " + m, "bad");
  } finally {
    pulseBuying = false;
    if (btn) btn.disabled = false;
  }
}

// ================= prediction market drawer (neural stakes + trustless hit-rate leaderboard) =================
function openPredict() {
  predictOpen = true;
  if (brainOpen) closeBrain();
  if (walletsOpen) closeWallets();
  if (historyOpen) closeHistory();
  if (proofsOpen) closeProofs();
  if (pulseOpen) closePulse();
  if (arenaOpen) closeArena();
  if (lineageOpen) closeLineage();
  if (chronOpen) closeChron();
  const d = $("predict"); if (!d) return;
  d.hidden = false;
  document.body.classList.add("predict-open");
  requestAnimationFrame(() => d.classList.add("open"));
  renderPredict();
}
function closePredict() {
  predictOpen = false;
  document.body.classList.remove("predict-open");
  const d = $("predict"); if (!d) return;
  d.classList.remove("open");
  setTimeout(() => { if (!predictOpen) d.hidden = true; }, 420);
}
function togglePredict() { if (predictOpen) closePredict(); else openPredict(); }

async function renderPredict() {
  const body = $("predict-body"); if (!body) return;
  body.innerHTML = `<p class="predict-loading">loading prediction market…</p>`;
  const res = await getJSON("/predictions", 8000).catch(() => null);
  if (!predictOpen) return;                 // closed while fetching
  predictData = res || null;
  paintPredict();
}

/** Throttled background refresh so an open drawer tracks the book as each cron resolves it. */
async function pollPredict(force) {
  if (!predictOpen) return;
  const now = Date.now();
  if (!force && now - lastPredictPoll < PREDICT_POLL_MS) return;
  lastPredictPoll = now;
  try {
    const p = await getJSON("/predictions", 8000);
    if (p && predictOpen) { predictData = p; paintPredict(); }
  } catch { /* best-effort: the market is a nicety and must never block the scene */ }
}

/** (Re)build the drawer body from cached state — used on open, on poll, and after a verify. */
function paintPredict() {
  const body = $("predict-body"); if (!body) return;
  const sub = $("predict-sub");
  const d = predictData;
  if (sub) sub.textContent = d && d.enabled
    ? `${d.open ? "round #" + d.open.round + " open" : "between rounds"} · ${d.totals ? d.totals.roundsResolved : 0} settled`
    : "neural stakes · parimutuel";
  body.innerHTML = "";
  if (!d || !d.enabled) {
    body.innerHTML = `<p class="predict-empty">the prediction market is disabled on this deployment.</p>`;
    return;
  }
  body.appendChild(predictBookCard(d));
  body.appendChild(predictRecentCard(d));
  body.appendChild(predictLeaderCard(d));
}

/** The live book: parimutuel UP/DOWN pools, implied odds, and every fly's neural stake. */
function predictBookCard(d) {
  const card = document.createElement("div"); card.className = "predict-card book";
  const o = d.open;
  const mode = d.mode === "onchain" ? "settles on Arc mainnet" : "simulated · no real funds";
  let html =
    `<div class="predict-title">live book <span class="predict-mode">${mode}</span></div>` +
    `<p class="predict-blurb">Each fly reads its own connectome and stakes real USDC on whether the market temperature <b>rises</b> or <b>falls</b> by next tick. Pools are <b>parimutuel</b>: winners split the losers' pool, strictly zero-sum, and the net settles through the same on-chain netting path as every other trade.</p>`;
  if (!o) {
    html += `<p class="predict-empty">no open round — the swarm is between ticks. a new book opens every cron.</p>`;
    card.innerHTML = html;
    return card;
  }
  const upUsdc = Number(o.poolUpUsdc || 0), downUsdc = Number(o.poolDownUsdc || 0);
  const tot = upUsdc + downUsdc;
  const upPct = tot > 0 ? (upUsdc / tot) * 100 : 50;
  const downPct = tot > 0 ? 100 - upPct : 50;
  const band = Number((d.config && d.config.flatBand) || 0);
  html +=
    `<div class="pb-round">round <b>#${o.round}</b> · entry tick #${o.entryTick} · resolves next cron</div>` +
    `<div class="pb-pools">` +
      `<div class="pb-pool up"><span class="pb-side">▲ up</span><span class="pb-amt">${upUsdc.toFixed(4)}</span></div>` +
      `<div class="pb-pool down"><span class="pb-side">▼ down</span><span class="pb-amt">${downUsdc.toFixed(4)}</span></div>` +
    `</div>` +
    `<div class="pb-bar"><div class="pb-bar-up" style="width:${upPct.toFixed(1)}%"></div><div class="pb-bar-down" style="width:${downPct.toFixed(1)}%"></div></div>` +
    `<div class="pb-odds">` +
      `<div><dt>up odds</dt><dd>${Number(o.oddsUp || 0).toFixed(2)}×</dd><dd class="pb-prob">${(Number(o.probUp || 0) * 100).toFixed(0)}%</dd></div>` +
      `<div><dt>down odds</dt><dd>${Number(o.oddsDown || 0).toFixed(2)}×</dd><dd class="pb-prob">${(Number(o.probDown || 0) * 100).toFixed(0)}%</dd></div>` +
    `</div>` +
    `<dl class="pb-meta">` +
      `<div><dt>entry temp</dt><dd>${Number(o.entryTemp || 0).toFixed(3)}</dd></div>` +
      `<div><dt>momentum</dt><dd>${(Number(o.momentum || 0) >= 0 ? "+" : "") + Number(o.momentum || 0).toFixed(3)}</dd></div>` +
      `<div><dt>bets</dt><dd>${o.betCount || 0}</dd></div>` +
      `<div><dt>flat band</dt><dd>±${band.toFixed(3)}</dd></div>` +
    `</dl>`;
  const bets = Array.isArray(o.bets) ? o.bets : [];
  if (bets.length) {
    html += `<div class="pb-bets-title">neural stakes</div><div class="pb-bets">` +
      bets.slice(0, 48).map((b) =>
        `<span class="pb-bet ${b.side === "UP" ? "up" : "down"}">#${b.id} ${b.side === "UP" ? "▲" : "▼"} ${Number(b.stakeUsdc || 0).toFixed(4)}</span>`
      ).join("") + `</div>`;
  }
  card.innerHTML = html;
  return card;
}

/** Recent resolutions, each with a one-click trustless verify (browser recompute + direct Arc read). */
function predictRecentCard(d) {
  const card = document.createElement("div"); card.className = "predict-card recent";
  const rows = Array.isArray(d.recent) ? d.recent : [];
  let html =
    `<div class="predict-title">resolutions</div>` +
    `<p class="predict-blurb">Every decisive round is hashed and committed to the on-chain NeuralReceiptRegistry. Recompute the receipt in your browser, then read the same commitment straight off Arc — no murmur server in the loop.</p>`;
  if (!rows.length) {
    html += `<p class="predict-empty">no resolved rounds yet — the first book resolves on the next cron.</p>`;
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
        `<span>${r.betCount || 0} bets · ${Number(r.totalStakedUsdc || 0).toFixed(4)} usdc</span>` +
        `<span class="pr-hash fp">${shortHash(r.receiptHash || "")}</span>` +
      `</div>` +
      `<div class="pr-actions">` +
        `<button type="button" class="pr-verify" data-round="${r.round}">verify on-chain</button>` +
        (committed
          ? `<a class="tx-link" href="${ARC_EXPLORER}/tx/${r.commitTx}" target="_blank" rel="noopener noreferrer">↗ registry ${shortHash(r.commitTx)}</a>`
          : `<span class="pr-simnote">${r.outcome === "FLAT" ? "flat · refunded · not committed" : "not committed"}</span>`) +
      `</div>` +
      `<div class="pr-verifyout" hidden></div>` +
    `</div>`;
  }).join("");
  card.innerHTML = html;
  return card;
}

/** Trustless hit-rate leaderboard: agents ranked by how often their neural read called the move. */
function predictLeaderCard(d) {
  const card = document.createElement("div"); card.className = "predict-card leader";
  const rows = Array.isArray(d.leaderboard) ? d.leaderboard : [];
  const t = d.totals || {};
  let html =
    `<div class="predict-title">hit-rate leaderboard</div>` +
    `<p class="predict-blurb">Agents ranked by prediction accuracy — the share of decisive rounds where the fly's neural read called the temperature move. Net PnL is realised USDC folded through the on-chain economy.</p>`;
  if (t.roundsResolved != null) {
    html += `<div class="pl-totals">` +
      `<span><b>${t.roundsResolved || 0}</b> rounds</span>` +
      `<span><b>${t.committed || 0}</b> on-chain</span>` +
      `<span><b>${Number(t.volumeUsdc || 0).toFixed(4)}</b> usdc</span>` +
      `<span><b>${t.activeBettors || 0}</b> bettors</span>` +
    `</div>`;
  }
  if (!rows.length) {
    html += `<p class="predict-empty">no ranked agents yet — accuracy accrues as rounds resolve.</p>`;
    card.innerHTML = html; return card;
  }
  const live = d.mode === "onchain";
  const addrOf = (id) => { const a = econAgents.find((x) => x.id === id); return a && isRealAddr(a.address) ? a.address : null; };
  html += `<div class="pl-head"><span>#</span><span>agent</span><span>hit</span><span>net</span><span>rnds</span></div>`;
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
  if (regAddr) html += `<div class="pl-reg">registry <span class="fp">${shortHash(regAddr)}</span></div>`;
  card.innerHTML = html;
  return card;
}

/**
 * One-click trustless verification of a resolved round. Recomputes sha256(roundReceipt) in THIS browser
 * (byte-identical canonical JSON), then reads the commitment straight off the on-chain NeuralReceiptRegistry
 * via Arc RPC — no murmur server trusted. FLAT / one-sided rounds are refunded and never committed, so a
 * missing commitment there is expected, not a failure.
 */
async function verifyPredictRound(round, wrap) {
  if (predictVerifying[round]) return;
  const out = wrap ? wrap.querySelector(".pr-verifyout") : null;
  if (out) { out.hidden = false; out.textContent = "checking…"; }
  predictVerifying[round] = true;
  try {
    const v = await getJSON(`/predictions/verify?round=${encodeURIComponent(round)}`, 9000);
    if (!v.found) { if (out) out.textContent = "round not found in recent history"; return; }
    let clientHash = null;
    if (v.receipt) { try { clientHash = await sha256HexClient(v.receipt); } catch { clientHash = null; } }
    const selfOk = clientHash == null || clientHash === v.receiptHash;
    const serverOk = v.selfConsistent === true;
    let reg = null, regSource = "";
    if (v.registryAddress) { reg = await readRegistryOnchain(v.registryAddress, v.receiptHash); regSource = reg ? "direct Arc RPC" : ""; }
    if (!reg && v.registry) { reg = v.registry; regSource = "via murmur API"; }
    const regOk = !!reg && reg.committed === true;
    const expectCommit = v.outcome !== "FLAT";
    const ok = selfOk && serverOk && (!expectCommit || regOk);
    if (!out) return;
    out.innerHTML = "";
    const badge = document.createElement("span");
    badge.className = "pr-badge " + (ok ? "ok" : "bad");
    badge.textContent = ok
      ? (expectCommit ? "✓ resolution verified on-chain" : "✓ receipt self-consistent (flat · refunded)")
      : "✗ mismatch";
    const dl = document.createElement("dl"); dl.className = "pr-vmeta";
    dl.innerHTML =
      `<div><dt>outcome</dt><dd>${v.outcome} · Δ ${(Number(v.delta || 0) >= 0 ? "+" : "") + Number(v.delta || 0).toFixed(4)} (band ±${Number(v.flatBand || 0).toFixed(3)})</dd></div>` +
      `<div><dt>sha256(receipt) in your browser</dt><dd class="fp">${clientHash ? shortHash(clientHash) : "–"}</dd></div>` +
      `<div><dt>published receiptHash</dt><dd class="fp">${shortHash(v.receiptHash || "")}</dd></div>`;
    const regDiv = document.createElement("div");
    if (reg) {
      const headTxt = reg.chainHead ? shortHash(reg.chainHead) : "–";
      const isHead = reg.chainHead && v.receiptHash && reg.chainHead.toLowerCase() === ("0x" + v.receiptHash).toLowerCase();
      const stateTxt = !reg.committed ? (expectCommit ? "not committed" : "refunded · not committed") : (isHead ? "chain head ✓" : "committed ✓");
      regDiv.innerHTML =
        `<div><dt>on-chain registry (${regSource})</dt><dd class="fp${regOk || !expectCommit ? " ok" : ""}">${stateTxt} · head ${headTxt}</dd></div>` +
        (v.registryAddress ? `<div><dt>registry contract</dt><dd class="fp">${shortHash(v.registryAddress)}</dd></div>` : "");
    } else {
      regDiv.innerHTML = `<div><dt>on-chain registry</dt><dd class="fp">${expectCommit ? "not configured" : "flat · no commit expected"}</dd></div>`;
    }
    dl.append(...regDiv.children);
    out.append(badge, dl);
  } catch {
    if (out) out.textContent = "verify request failed (network)";
  } finally {
    predictVerifying[round] = false;
  }
}

// ================= data layer =================
// Every request is timeout + abort guarded. When the Worker is undeployed the
// workers.dev host black-holes TCP (connect never completes), so an unguarded
// fetch hangs for tens of seconds; aborting fast is what stops rapid clicking
// from stacking up stuck requests and stalling the tab.
async function getJSON(path, timeoutMs = FETCH_TIMEOUT_MS, outerSignal) {
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

async function poll() {
  if (pollInFlight) return;                        // never overlap polls
  if (Date.now() < offlineUntil) {                 // circuit-breaker open → local only
    offlineTick();
    return;
  }
  pollInFlight = true;
  try {
    const [pop, st] = await Promise.all([getJSON("/population"), getJSON("/state")]);
    offline = false;
    setStatusKind("live");
    if (pop && pop.snapshot) applySnapshot(pop.snapshot);
    if (pop && pop.economy) applyEconomy(pop.economy);
    if (pop && pop.topology) applyTopology(pop.topology);
    applyState(st);
    // Full agent roster (addresses + per-agent ledgers) for the wallets drawer. Best-effort and
    // non-blocking: a hiccup here must never flip the whole scene offline, so it's off Promise.all.
    // Only fetched while the drawer is actually open (it self-fetches on open too) — the canvas body
    // scale is driven by /population balances, so the roster is not needed on every poll for viewers.
    if (walletsOpen) getJSON("/economy").then((econ) => {
      if (!econ) return;
      if (Array.isArray(econ.agents)) applyEconAgents(econ.agents);
      if (econ.market) { econMarket = econ.market; renderMarketSection(); }
      if (econ.culture) { econCulture = econ.culture; renderCultureSection(); }
      if (econ.commons) { econCommons = econ.commons; renderCommonsSection(); }
    }).catch(() => {});
    pollProofs();   // throttled internally (≤ once / 30s); keeps the provenance drawer fresh
    pollPredict();  // throttled internally; keeps an open prediction book tracking each cron
    pollArena();    // throttled internally; keeps an open arena book + your on-chain position fresh
  } catch (e) {
    if (!offline) { offline = true; setStatusKind("dreaming"); }
    offlineUntil = Date.now() + OFFLINE_BACKOFF_MS;  // stop probing; run local for a while
    offlineTick();                                    // local synthetic mirror + the offline econ badge
    updateCronWatchdog();                             // hide the stale-heartbeat bar (offline badge covers it)
  } finally {
    pollInFlight = false;
  }
}

function applySnapshot(snap) {
  if (!snap || !snap.collective) return;
  collective = snap.collective;
  tempTarget = clamp(snap.collective.temperature);
  cohTarget = clamp(snap.collective.cohesion);

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
  if (selectedId != null && seen.has(selectedId)) fillInspectorFromSim(selectedId);

  // a new on-chain tick → fire one shard fan-out pulse (the isolates compute in parallel each cron)
  const ti = snap.tickIndex;
  if (ti != null && (lastTickIndex == null || ti > lastTickIndex)) { lastTickIndex = ti; shardPulseT = performance.now(); }
}

function applyState(st) {
  if (!st) return;
  const m = st.market;
  if (m) {
    $("block").textContent = m.blockNumber != null ? "#" + m.blockNumber : "–";
    $("tpb").textContent = m.txPerBlock != null ? Number(m.txPerBlock).toFixed(1) : "–";
  }
  const cfg = st.config;
  if (cfg) $("chain").textContent = `arc ${cfg.isTestnet ? "testnet " : ""}${cfg.chainId}`;
  if (st.economy && st.economy.mode) {
    econMode = st.economy.mode;
    updateEconMode();
    updateEconFoot();
    if (walletsOpen) renderWallets();   // a mode change flips the roster's explorer links + subtitle
  }
  // Record the DO cron's heartbeat and let the watchdog judge its freshness (online path only —
  // when offline the catch() hides the bar, since the offline badge already speaks).
  if (typeof st.lastCron === "number") cronHeartbeatMs = st.lastCron;
  updateCronWatchdog();
}

/** The cron watchdog: the DO cron writes lastCron every ~60s. If the API is up but the heartbeat has
 *  gone stale, the whole swarm has likely frozen — surface it instead of showing a still image as live. */
function updateCronWatchdog() {
  const el = $("cron-warn");
  if (!el) return;
  if (offline || !cronHeartbeatMs) { el.hidden = true; return; }
  const ageMs = Date.now() - cronHeartbeatMs;
  if (ageMs > CRON_STALE_MS) {
    const mins = Math.max(1, Math.round(ageMs / 60000));
    el.textContent = T("cron.warnStale", { mins });
    el.hidden = false;
  } else {
    el.hidden = true;
  }
}

function setStatus(text, cls) {
  $("status").textContent = text;
  const dot = $("link-dot");
  dot.className = "link-dot" + (cls ? " " + cls : "");
}
// The link status is a word, not a number — keep the *kind* so a language switch re-labels it in place.
let curStatusKind = "connecting";
const STATUS_KIND = { live: ["top.status.live", "live"], dreaming: ["top.status.dreaming", "off"], offline: ["top.status.offline", "off"], connecting: ["top.status.connecting", ""] };
function setStatusKind(kind) {
  curStatusKind = kind;
  const [k, cls] = STATUS_KIND[kind] || STATUS_KIND.connecting;
  setStatus(T(k), cls);
}

// ================= HUD =================
function updateHud(snap) {
  const c = snap.collective;
  $("temp").textContent = c.temperature.toFixed(2);
  $("regime").textContent = c.regime ? gl("regime", String(c.regime).toLowerCase()) : "—";
  $("meter-fill").style.width = (clamp(c.temperature) * 100).toFixed(1) + "%";
  $("vitality").textContent = c.vitality != null ? c.vitality.toFixed(2) : "–";
  $("tick").textContent = "#" + (snap.tickIndex ?? "–");
}

const DIST_ORDER = ["AGITATE", "EXPLORE", "AGGREGATE", "REST"];
let _distLang = null;   // rebuild the legend labels whenever the reader switches language
let _lastDist = null;   // last {states,size} so a language switch can repaint the legend instantly
function renderDist(states, size) {
  const host = $("dist");
  const lg = currentLang();
  if (!host.children.length || _distLang !== lg) {
    _distLang = lg;
    host.innerHTML = DIST_ORDER.map((s) => `<span class="dist-seg ${s.toLowerCase()}"></span>`).join("");
    $("dist-legend").innerHTML = DIST_ORDER.map(
      (s) => `<li><span class="sw" style="background:var(--${s.toLowerCase()})"></span>${T("pop.state." + s.toLowerCase())}<b data-k="${s}">0</b></li>`
    ).join("");
  }
  const st = states || {};
  _lastDist = { states: st, size };
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
  const cap = topology && topology.maxLivePopulation;
  const genesis = topology && topology.populationSize;
  const growing = cap != null && genesis != null && cap > genesis;
  $("size").textContent = size != null ? (growing ? `${size}/${cap}` : size) : "–";
}

// ================= inspector =================
const DRIVES = [["arousal", "arousal", false], ["turn", "turn bias", true], ["cohesion", "cohesion", false], ["wingbeat", "wingbeat", false], ["rest", "rest", false]];

function select(id) {
  if (walletsOpen) closeWallets();   // selecting a fly (from canvas or roster) hands the right side to the inspector
  if (historyOpen) closeHistory();
  if (pulseOpen) closePulse();
  if (predictOpen) closePredict();
  selectedId = id;
  const ins = $("inspector");
  ins.hidden = false;
  document.body.classList.add("ins-open");
  requestAnimationFrame(() => ins.classList.add("open"));
  $("hint-select").classList.add("hide");
  fillInspectorFromSim(id);
  startNeuralFeed(id);          // live bloom + spike raster (performance-safe) for this fly
}

function deselect() {
  selectedId = null;
  stopNeuralFeed();
  document.body.classList.remove("ins-open");
  const ins = $("inspector");
  ins.classList.remove("open");
  setTimeout(() => { if (selectedId == null) ins.hidden = true; }, 520);
}

function fillInspectorFromSim(id) {
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
function refreshInspectorSocial(id) {
  const el = $("ins-social");
  if (!el) return;
  const parts = [];
  if (societies) {
    const ci = societies.colonyOf.get(id);
    if (ci != null && societies.colonies[ci]) parts.push(societies.colonies[ci].name);
    let al = 0, fe = 0;
    for (const p of societies.allies) if (p.a === id || p.b === id) al++;
    for (const p of societies.feuds) if (p.a === id || p.b === id) fe++;
    parts.push(T(al === 1 ? "ins.ally" : "ins.allies", { n: al }), T(fe === 1 ? "ins.feud" : "ins.feuds", { n: fe }));
  }
  const h = houseOf.get(id);
  parts.push(h ? `${h.sigil ? h.sigil + " " : ""}` + T("ins.houseOf", { name: h.name }) : T("dyn.noHouse"));
  el.textContent = parts.join(" · ");
}

function renderDrives(f) {
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
function renderEthogram(f) {
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
function renderBouts(f) {
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
const RASTER_WINDOW_MS = 6000;
const BLOOM_REBUILD_MS = 250;      // rebuild offscreen bloom ~4x/sec
const RASTER_REBUILD_MS = 125;     // rebuild offscreen raster ~8x/sec
const NEURAL_INTERVAL_MS = 1000;   // one snapshot/synth per second while a fly is selected
const NEURAL_DEBOUNCE_MS = 150;    // collapse a click-burst into a single initial read
let rasterCols = [];               // { t, spikes:[idx], N }
let neuralTimer = null, neuralDebounce = null, neuralFeedId = null, neuralCtrl = null, neuralInFlight = false;
let bloomData = null;
let bloomShowBefore = false;   // brain-size compare toggle: render the bloom at the 1,080 launch density instead of the live count
let bloomOff = null, bloomOffCtx = null, bloomLast = 0, bloomAngle = 0;
let rasterOff = null, rasterOffCtx = null, rasterLast = 0;

function neuralLoad(id) {
  if (neuralFeedId !== id) return;
  if (offline || Date.now() < offlineUntil) synthNeural(id);
  else fetchNeural(id);
}
function startNeuralFeed(id) {
  stopNeuralFeed();
  neuralFeedId = id;
  rasterCols = [];
  neuralDebounce = setTimeout(() => { neuralDebounce = null; neuralLoad(id); }, NEURAL_DEBOUNCE_MS);
  neuralTimer = setInterval(() => { if (neuralFeedId === id && !neuralInFlight) neuralLoad(id); }, NEURAL_INTERVAL_MS);
}
function stopNeuralFeed() {
  if (neuralDebounce) { clearTimeout(neuralDebounce); neuralDebounce = null; }
  if (neuralTimer) { clearInterval(neuralTimer); neuralTimer = null; }
  if (neuralCtrl) { neuralCtrl.abort(); neuralCtrl = null; }
  neuralInFlight = false;
  neuralFeedId = null;
  rasterCols = [];
  bloomData = null;
  if (bloomOffCtx) bloomOffCtx.clearRect(0, 0, bloomOff.width, bloomOff.height);
  if (rasterOffCtx) rasterOffCtx.clearRect(0, 0, rasterOff.width, rasterOff.height);
  const bc = $("bloom"); if (bc) bc.getContext("2d").clearRect(0, 0, bc.width, bc.height);
  const rc = $("raster"); if (rc) rc.getContext("2d").clearRect(0, 0, rc.width, rc.height);
  const hz = $("raster-hz"); if (hz) hz.textContent = "";
}

async function fetchNeural(id) {
  if (neuralFeedId !== id || neuralInFlight) return;
  neuralInFlight = true;
  if (neuralCtrl) neuralCtrl.abort();
  neuralCtrl = new AbortController();
  try {
    const s = await getJSON(`/snapshot?flyId=${id}`, 3000, neuralCtrl.signal);
    if (neuralFeedId !== id) return;
    bloomData = { rates: s.firingRates || [], kinds: s.neuronKinds || [] };
    const N = s.neuronCount || bloomData.rates.length || 0;
    bloomData.N = N;
    setNeuronCount(N);
    $("ins-t").textContent = (s.t || 0).toFixed(0);
    if (s.agent) updateWallet(s.agent);
    pushSpikes(s.spikesLastStep, N || 10800);
  } catch (e) {
    if (neuralFeedId !== id) return;
    synthNeural(id);
  } finally {
    neuralInFlight = false;
  }
}

function pushSpikes(spikes, N) {
  let arr = Array.isArray(spikes) ? spikes : [];
  if (arr.length > 180) arr = arr.filter((_, i) => i % Math.ceil(arr.length / 180) === 0);  // subsample
  rasterCols.push({ t: performance.now(), spikes: arr, N: N || 10800 });
  const now = performance.now();
  while (rasterCols.length && now - rasterCols[0].t > RASTER_WINDOW_MS) rasterCols.shift();
  const hz = $("raster-hz");
  if (hz) hz.textContent = `${arr.length} / ${N || 10800} firing`;
}

// offline / pre-deploy: synthesise a believable spike column + bloom for this fly
function synthNeural(id) {
  const f = sim.get(id);
  const aro = f ? f.tAro : 0.4;
  const N = 10800, rates = new Array(N), kinds = new Array(N), spikes = [];
  for (let i = 0; i < N; i++) {
    const u = i / N;
    const kind = u < 0.167 ? "sensory" : u < 0.907 ? "inter" : u < 0.944 ? "modulatory" : "motor";
    kinds[i] = kind;
    const base = kind === "motor" ? aro : kind === "sensory" ? tempSmoothed : 0.2 + aro * 0.6;
    const rate = clamp(base * 0.7 + Math.random() * 0.5);
    rates[i] = rate * 70;
    if (Math.random() < rate * 0.5) spikes.push(i);
  }
  bloomData = { rates, kinds, N };
  setNeuronCount(N, "~");
  $("ins-t").textContent = "—";
  updateWallet(synthAgentFor(id));   // offline: show this fly's local mirror wallet
  pushSpikes(spikes, N);
}

// Roll the neuron counter up from the 1,080 launch size to the live count on the first read, so the 10×
// scale-up is felt as a change rather than read as a static number. Later reads set it directly.
let ncountShown = 0, ncountRaf = 0;
function setNeuronCount(N, prefix = "") {
  const el = $("ins-ncount");
  if (!el) return;
  if (ncountRaf) cancelAnimationFrame(ncountRaf);
  const from = ncountShown || 1080;
  if (from === N) { el.textContent = prefix + N.toLocaleString(); return; }
  const start = performance.now(), dur = 850;
  const step = (now) => {
    const p = Math.min(1, (now - start) / dur);
    const e = 1 - Math.pow(1 - p, 3);                        // easeOutCubic
    el.textContent = prefix + Math.round(from + (N - from) * e).toLocaleString();
    if (p < 1) { ncountRaf = requestAnimationFrame(step); } else { ncountShown = N; ncountRaf = 0; }
  };
  ncountRaf = requestAnimationFrame(step);
}

// brain-size compare toggle: re-render the SAME live bloom at the sparse 1,080 launch density vs the live
// count, so a visitor can see the 10× difference directly instead of taking our word for it.
function bindBloomScale() {
  const host = $("bloom-scale");
  if (!host) return;
  host.addEventListener("click", (e) => {
    const btn = e.target.closest(".bs-btn");
    if (!btn) return;
    bloomShowBefore = btn.dataset.before === "1";
    for (const b of host.querySelectorAll(".bs-btn")) b.classList.toggle("is-on", b === btn);
    bloomLast = 0;                                           // force an immediate offscreen rebuild next frame
  });
}

// rebuild the offscreen bloom from bloomData at a low rate (≤ ~1,200 strokes, NOT per frame)
function rebuildBloom() {
  const c = $("bloom");
  if (!c || !bloomData) return;
  if (!bloomOff) {
    bloomOff = document.createElement("canvas");
    bloomOff.width = c.width; bloomOff.height = c.height;
    bloomOffCtx = bloomOff.getContext("2d");
  }
  const x = bloomOffCtx, W = bloomOff.width, H = bloomOff.height, cxr = W / 2, cyr = H / 2;
  x.clearRect(0, 0, W, H);
  const { rates, kinds } = bloomData;
  const N = rates.length;
  if (!N) return;
  // Perceived density scales with the REAL neuron count (bloomData.N): a 10,800-neuron brain blooms ~10×
  // denser than the 1,080 launch size, so the upgrade is something you SEE, not just a number you read.
  // bloomShowBefore (the compare toggle) forces the sparse 1,080-equivalent density for a side-by-side feel.
  const SAMPLE_STRIDE = 9;                                   // ≈1,200 strokes at 10,800n — offscreen + rebuilt 4×/s, so cheap
  const realN = bloomData.N || N;
  const target = Math.max(1, bloomShowBefore ? Math.floor(1080 / SAMPLE_STRIDE) : Math.floor(realN / SAMPLE_STRIDE));
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
  const acc = paletteAt(tempSmoothed).accent;
  x.fillStyle = rgba(acc, 0.6);
  x.beginPath(); x.arc(cxr, cyr, 3.4, 0, TAU); x.fill();
}
// per frame: one rotated blit of the cached bloom
function renderBloom(now) {
  const c = $("bloom");
  if (!c || !bloomData) return;
  if (now - bloomLast >= BLOOM_REBUILD_MS) { bloomLast = now; rebuildBloom(); }
  if (!bloomOff) return;
  const x = c.getContext("2d");
  x.clearRect(0, 0, c.width, c.height);
  bloomAngle += 0.0016;
  x.save();
  x.translate(c.width / 2, c.height / 2);
  x.rotate(bloomAngle);
  x.drawImage(bloomOff, -c.width / 2, -c.height / 2);
  x.restore();
}

// rebuild the offscreen raster from the rolling spike columns at a low rate
function rebuildRaster(now) {
  const c = $("raster");
  if (!c) return;
  if (!rasterOff) {
    rasterOff = document.createElement("canvas");
    rasterOff.width = c.width; rasterOff.height = c.height;
    rasterOffCtx = rasterOff.getContext("2d");
  }
  const x = rasterOffCtx, W = rasterOff.width, H = rasterOff.height;
  x.clearRect(0, 0, W, H);
  if (!rasterCols.length) return;
  const dot = mix([26, 26, 24], paletteAt(tempSmoothed).accent, 0.5);
  for (const col of rasterCols) {
    const age = (now - col.t) / RASTER_WINDOW_MS;
    if (age < 0 || age > 1) continue;
    const cx = W - age * W;                 // newest at the right, scrolling left
    const N = col.N || 10800;
    x.fillStyle = rgba(dot, 0.55 * (1 - age * 0.7));
    for (const idx of col.spikes) x.fillRect(cx, (idx / N) * H, 1.5, 1.5);
  }
}
// per frame: one blit of the cached raster
function renderRaster(now) {
  const c = $("raster");
  if (!c) return;
  if (now - rasterLast >= RASTER_REBUILD_MS) { rasterLast = now; rebuildRaster(now); }
  if (!rasterOff) return;
  const x = c.getContext("2d");
  x.clearRect(0, 0, c.width, c.height);
  x.drawImage(rasterOff, 0, 0);
}

// ================= pointer: stir the swarm + select a fly =================
function getRect() {
  if (!cachedRect) cachedRect = canvas.getBoundingClientRect();
  return cachedRect;
}
let lastHoverAt = 0;
/** Throttled nearest-fly pick under the pointer — the hover half of the focus highlight. */
function pickHover() {
  const pn = performance.now();
  if (pn - lastHoverAt < 90) return;      // pointermove fires far faster than the highlight needs
  lastHoverAt = pn;
  let best = null, bd = Infinity;
  for (const f of sim.values()) {
    if (f.dying) continue;
    const d = Math.hypot(f.x - pointer.x, f.y - pointer.y);
    if (d < bd) { bd = d; best = f; }
  }
  hoverId = (best && bd < 26) ? best.id : null;
  // a headstone under the pointer also reads as clickable (it opens its epitaph), independent of any fly
  let onGrave = false;
  if (showGraves) { for (const g of graveField) { if (Math.hypot(g.x - pointer.x, g.y - 2 - pointer.y) < 16) { onGrave = true; break; } } }
  canvas.style.cursor = (hoverId != null || onGrave) ? "pointer" : "";
}
function bindPointer() {
  const toLocal = (e) => {
    const rect = getRect();          // cached — pointermove fires constantly; don't reflow each time
    pointer.x = e.clientX - rect.left;
    pointer.y = e.clientY - rect.top;
  };
  canvas.addEventListener("pointermove", (e) => { toLocal(e); pointer.inside = true; pickHover(); });
  canvas.addEventListener("pointerleave", () => { pointer.inside = false; pointer.down = false; hoverId = null; canvas.style.cursor = ""; });
  canvas.addEventListener("pointerdown", (e) => {
    // swallow click-storms: cap interaction-driven work so rapid clicking can never stall the tab
    const pn = performance.now();
    if (pn - lastClickAt < 90) return;
    lastClickAt = pn;
    toLocal(e);
    pointer.inside = true;
    pointer.down = true;
    // a headstone tap opens its epitaph and swallows the gesture (never stirs the swarm or selects a fly)
    if (showGraves) {
      let gg = null, gd = 16;
      for (const g of graveField) { const d = Math.hypot(g.x - pointer.x, g.y - 2 - pointer.y); if (d < gd) { gd = d; gg = g; } }
      if (gg) { showEpitaph(gg); return; }
    }
    hideEpitaph();   // any tap that misses a stone dismisses an open epitaph
    let best = null, bd = Infinity;
    for (const f of sim.values()) {
      if (f.dying) continue;
      const d = Math.hypot(f.x - pointer.x, f.y - pointer.y);
      if (d < bd) { bd = d; best = f; }
    }
    if (best && bd < 34) {
      if (best.id !== selectedId) select(best.id);   // debounce: never restart the feed on the same fly
    } else {
      if (selectedId != null) deselect();
      spawnRippleAt(pointer.x, pointer.y, STIR_COL);  // a little stir where you tapped
    }
  });
  window.addEventListener("pointerup", () => { pointer.down = false; });
}

function spawnRippleAt(x, y, color) {
  if (ripples.length >= 10) ripples.shift();   // cap: rapid clicking can't pile up unbounded arcs
  ripples.push({ x, y, t0: performance.now(), color });
}

// ================= token contract address (copy-to-clipboard) =================
// The project token CA is shown truncated in the economy panel; clicking copies the FULL address.
// navigator.clipboard works on our HTTPS origin; the hidden-textarea fallback covers older browsers
// and non-secure contexts so the copy never silently fails.
async function copyToClipboard(text) {
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

let tcaTimer = 0;
async function copyTokenCA(btn) {
  const ca = btn.dataset.ca; if (!ca) return;
  const ok = await copyToClipboard(ca);
  btn.textContent = ok ? "copied ✓" : shortHash(ca);
  btn.classList.toggle("copied", ok);
  clearTimeout(tcaTimer);
  tcaTimer = setTimeout(() => { btn.textContent = shortHash(ca); btn.classList.remove("copied"); }, 1400);
}

// ================= misc UI bindings =================
// ================= language switcher + live re-render =================
// On a language change we re-translate the static DOM (applyDom, done inside setLang) and then
// rebuild whatever is currently on stage. The canvas layers read T()/gl() every frame, so they
// refresh on the next animation tick without any help from us.
function populateLangSelect() {
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
function rerenderAll() {
  try {
    setStatusKind(curStatusKind);
    updateEconMode(); updateEconFoot();
    updateNetNote();
    const tca = $("tca-copy"); if (tca) tca.title = T("econ.copyTip", { ca: tca.dataset.ca || "" });
    if (_lastDist) renderDist(_lastDist.states, _lastDist.size);   // repaint behaviour legend in the new language
    updateSinceLaunch();
    const dv = $("ins-drives"); if (dv) dv.innerHTML = "";   // force the cached drive labels to rebuild in the new language
    if (selectedId != null) fillInspectorFromSim(selectedId);
    if (selectedGrave) showEpitaph(selectedGrave);   // an open epitaph re-localises in the new language
    if (walletsOpen) { renderWallets(); renderMarketSection(); }
    if (historyOpen) renderHistory();
    if (chronOpen) { renderChron(); if (chronVerifyState) renderChronVerdict(); renderDynastySection(); renderCultureSection(); renderCommonsSection(); renderSocialSection(); }
  } catch { /* never let a re-render break the scene */ }
}
window.__onLangChange = rerenderAll;

function bindUI() {
  $("ins-close").addEventListener("click", deselect);
  const lsel = $("lang-select");
  if (lsel) lsel.addEventListener("change", () => setLang(lsel.value));
  bindBloomScale();
  const lt = $("layer-toggles");
  if (lt) lt.addEventListener("click", (e) => {
    const b = e.target.closest(".layer-btn"); if (!b) return;
    const on = !b.classList.contains("is-on");
    b.classList.toggle("is-on", on);
    if (b.dataset.layer === "mind") showMind = on;
    else if (b.dataset.layer === "shards") showShards = on;
    else if (b.dataset.layer === "societies") showSocieties = on;
    else if (b.dataset.layer === "graves") { showGraves = on; if (!on) hideEpitaph(); }
  });
  const epc = $("epitaph-close"); if (epc) epc.addEventListener("click", hideEpitaph);
  const wb = $("wallets-btn"); if (wb) wb.addEventListener("click", toggleWallets);
  const wc = $("wallets-close"); if (wc) wc.addEventListener("click", closeWallets);
  const hb = $("hist-btn"); if (hb) hb.addEventListener("click", toggleHistory);
  const hc = $("hist-close"); if (hc) hc.addEventListener("click", closeHistory);
  const crb = $("chron-btn"); if (crb) crb.addEventListener("click", toggleChron);
  const crc = $("chron-close"); if (crc) crc.addEventListener("click", closeChron);
  const cp = $("chron-prove"); if (cp) cp.addEventListener("click", proveChron);
    const ctabs = $("chron-tabs");
    if (ctabs) ctabs.addEventListener("click", (e) => { const b = e.target.closest(".chron-tab"); if (b) setChronVol(b.dataset.vol); });
  const pb = $("proofs-btn"); if (pb) pb.addEventListener("click", toggleProofs);
  const pc = $("proofs-close"); if (pc) pc.addEventListener("click", closeProofs);
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
    if (chronOpen) closeChron(); else if (proofsOpen) closeProofs(); else if (brainOpen) closeBrain(); else if (lineageOpen) closeLineage(); else if (pulseOpen) closePulse(); else if (arenaOpen) closeArena(); else if (predictOpen) closePredict(); else if (historyOpen) closeHistory(); else if (walletsOpen) closeWallets(); else deselect();
  });
}

// ================= human-vs-swarm ARENA · bet MURMUR on the same temperature move (right drawer) =================
// The fly swarm bets USDC on the market temperature (the "predict" drawer). The ARENA lets a HUMAN holder bet
// MURMUR on the SAME move, head-to-head. It is NON-CUSTODIAL: you approve the deployed PredictionArena contract
// to move your MURMUR, then bet UP/DOWN into a parimutuel pool the contract escrows and pays out itself. The
// murmur Worker is only the RESOLVER — it commits each round's temperature, and the CONTRACT derives UP/DOWN/FLAT
// from the entry temperature + flat band it committed at open, so no operator can steer an outcome. Every read
// (balance/allowance/your bet) and write (approve/bet/claim) happens in THIS browser via MetaMask against Arc
// directly — the murmur server is never in the money path.
let arenaOpen = false;
let arenaData = null;          // latest /arena payload
let arenaBusy = false;         // one wallet write in flight at a time
let lastArenaPoll = 0;
const ARENA_POLL_MS = 15000;
let arenaAcct = null;          // connected wallet (lowercased 0x…)
let arenaUser = null;          // { balance, balanceRaw, allowance, allowanceRaw, side, amount, claims[] }
let arenaTickTimer = 0;        // 1s countdown refresher while the drawer is open

// Precomputed function selectors (keccak256 prefixes) — the page carries no ABI encoder, matching readRegistryOnchain.
const MUR_SEL_BALANCE = "0x70a08231";    // balanceOf(address)
const MUR_SEL_ALLOWANCE = "0xdd62ed3e";  // allowance(address,address)
const MUR_SEL_APPROVE = "0x095ea7b3";    // approve(address,uint256)
const ARENA_SEL_BET = "0xcf87935c";      // bet(uint256,uint8,uint256)
const ARENA_SEL_CLAIM = "0x379607f5";    // claim(uint256)
const ARENA_SEL_PAYOUT = "0x0523f1c3";   // payoutFor(uint256,address)
const ARENA_SEL_BETS = "0xf644b3bb";     // bets(uint256,address)
const ARENA_SIDE_UP = 1, ARENA_SIDE_DOWN = 2;
const ARENA_OUTCOME = { 0: "pending", 1: "UP \u25b2", 2: "DOWN \u25bc", 3: "FLAT", 4: "REFUND" };

// ---- ABI word helpers: 32-byte big-endian hex (no 0x) + 18-dec MURMUR conversions ----
const wordAddr = (a) => String(a).replace(/^0x/i, "").toLowerCase().padStart(64, "0");
const wordUint = (n) => BigInt(n).toString(16).padStart(64, "0");
const wordAt = (hex, i) => "0x" + String(hex || "").replace(/^0x/, "").slice(i * 64, (i + 1) * 64);
const atomicToMur = (a) => Number(BigInt(a || "0x0")) / 1e18;
/** Parse a human MURMUR amount ("12.5") into an 18-dec atomic BigInt with no float drift. */
function murToAtomic(str) {
  const s = String(str).trim().replace(/,/g, "");
  if (!/^\d*\.?\d*$/.test(s) || s === "" || s === ".") return 0n;
  const [ip, fp = ""] = s.split(".");
  return BigInt((ip || "0") + (fp + "000000000000000000").slice(0, 18));
}
const fmtMur = (n, dp = 2) => Number(n || 0).toLocaleString("en-US", { minimumFractionDigits: dp, maximumFractionDigits: dp });
const arenaClock = (s) => {
  s = Math.max(0, Math.floor(Number(s) || 0));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), ss = s % 60;
  return h > 0 ? `${h}h ${String(m).padStart(2, "0")}m` : `${m}m ${String(ss).padStart(2, "0")}s`;
};

// ---- drawer lifecycle (mirrors the predict drawer; mutually exclusive with the others) ----
function openArena() {
  arenaOpen = true;
  if (brainOpen) closeBrain();
  if (walletsOpen) closeWallets();
  if (historyOpen) closeHistory();
  if (proofsOpen) closeProofs();
  if (pulseOpen) closePulse();
  if (predictOpen) closePredict();
  if (lineageOpen) closeLineage();
  if (chronOpen) closeChron();
  const d = $("arena"); if (!d) return;
  d.hidden = false;
  document.body.classList.add("arena-open");
  requestAnimationFrame(() => d.classList.add("open"));
  renderArena();
  if (!arenaTickTimer) arenaTickTimer = setInterval(arenaCountdownTick, 1000);
}
function closeArena() {
  arenaOpen = false;
  document.body.classList.remove("arena-open");
  if (arenaTickTimer) { clearInterval(arenaTickTimer); arenaTickTimer = 0; }
  const d = $("arena"); if (!d) return;
  d.classList.remove("open");
  setTimeout(() => { if (!arenaOpen) d.hidden = true; }, 420);
}
function toggleArena() { if (arenaOpen) closeArena(); else openArena(); }

async function renderArena() {
  const body = $("arena-body"); if (!body) return;
  body.innerHTML = `<p class="ar-loading">loading arena\u2026</p>`;
  const res = await getJSON("/arena", 8000).catch(() => null);
  if (!arenaOpen) return;                 // closed while fetching
  arenaData = res || null;
  await arenaReadUser();
  if (!arenaOpen) return;
  paintArena();
}

/** Throttled background refresh so an open drawer tracks the book + your on-chain position each cron. */
async function pollArena(force) {
  if (!arenaOpen) return;
  const now = Date.now();
  if (!force && now - lastArenaPoll < ARENA_POLL_MS) return;
  lastArenaPoll = now;
  try {
    const a = await getJSON("/arena", 8000);
    if (!a || !arenaOpen) return;
    arenaData = a;
    await arenaReadUser();
    if (arenaOpen) paintArena();
  } catch { /* best-effort: the arena is a nicety and must never block the scene */ }
}

/** Refresh just the countdown each second (no full re-render) so the betting window visibly ticks down. */
function arenaCountdownTick() {
  const el = $("ar-countdown"); if (!el || !arenaData || !arenaData.current) return;
  const secs = Math.max(0, Number(arenaData.current.betDeadline || 0) - Math.floor(Date.now() / 1000));
  el.textContent = arenaClock(secs);
  if (secs <= 0) { lastArenaPoll = 0; pollArena(true); }   // window closed ⇒ pull the fresh (resolving) book
}

// ---- on-chain reads of the connected wallet's MURMUR + this/last round's position (browser → Arc, no server) ----
async function arenaReadUser() {
  const d = arenaData;
  if (!d || !d.enabled || !arenaAcct || !isRealAddr(d.arenaAddress) || !isRealAddr(d.token)) { arenaUser = null; return; }
  const curId = d.current ? d.current.roundId : null;
  const prevId = d.previous ? d.previous.roundId : null;
  try {
    const [bal, allow, betsRes, curPay, prevPay] = await Promise.all([
      arcRpc("eth_call", [{ to: d.token, data: MUR_SEL_BALANCE + wordAddr(arenaAcct) }, "latest"]),
      arcRpc("eth_call", [{ to: d.token, data: MUR_SEL_ALLOWANCE + wordAddr(arenaAcct) + wordAddr(d.arenaAddress) }, "latest"]),
      curId != null ? arcRpc("eth_call", [{ to: d.arenaAddress, data: ARENA_SEL_BETS + wordUint(curId) + wordAddr(arenaAcct) }, "latest"]) : Promise.resolve(null),
      curId != null ? arcRpc("eth_call", [{ to: d.arenaAddress, data: ARENA_SEL_PAYOUT + wordUint(curId) + wordAddr(arenaAcct) }, "latest"]) : Promise.resolve(null),
      prevId != null ? arcRpc("eth_call", [{ to: d.arenaAddress, data: ARENA_SEL_PAYOUT + wordUint(prevId) + wordAddr(arenaAcct) }, "latest"]) : Promise.resolve(null),
    ]);
    const claims = [];
    if (curPay && BigInt(wordAt(curPay, 2)) !== 0n) claims.push({ roundId: curId, payout: atomicToMur(wordAt(curPay, 1)) });
    if (prevPay && BigInt(wordAt(prevPay, 2)) !== 0n) claims.push({ roundId: prevId, payout: atomicToMur(wordAt(prevPay, 1)) });
    arenaUser = {
      balance: atomicToMur(bal), balanceRaw: BigInt(bal || "0x0"),
      allowance: atomicToMur(allow), allowanceRaw: BigInt(allow || "0x0"),
      side: betsRes ? Number(BigInt(wordAt(betsRes, 0))) : 0,
      amount: betsRes ? atomicToMur(wordAt(betsRes, 1)) : 0,
      claims,
    };
  } catch { /* a failed read just leaves the last-known state; never break the drawer */ }
}

// ---- wallet plumbing: connect + ensure Arc, then send a tx and wait for its receipt ----
async function arenaEnsureWallet(setMsg) {
  if (!window.ethereum) { setMsg("no wallet found \u2014 install MetaMask to bet", "bad"); return null; }
  const d = arenaData;
  if (!d || !d.enabled) { setMsg("arena unavailable on this deployment", "bad"); return null; }
  const accts = await window.ethereum.request({ method: "eth_requestAccounts" });
  const from = Array.isArray(accts) && accts[0];
  if (!from) { setMsg("no account selected", "bad"); return null; }
  const chainHex = "0x" + Number(d.chainId).toString(16);
  const cur = await window.ethereum.request({ method: "eth_chainId" });
  if (String(cur).toLowerCase() !== chainHex.toLowerCase()) {
    setMsg("switching network to Arc\u2026");
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
  arenaAcct = from.toLowerCase();
  return from;
}
const arenaSendTx = (to, data) =>
  window.ethereum.request({ method: "eth_sendTransaction", params: [{ from: arenaAcct, to, data, value: "0x0" }] });
async function arenaWaitReceipt(hash, tries = 40) {
  for (let i = 0; i < tries; i++) {
    await new Promise((r) => setTimeout(r, 1500));
    try {
      const rc = await arcRpc("eth_getTransactionReceipt", [hash], 8000);
      if (rc && rc.status) return rc.status === "0x1";
    } catch { /* keep polling */ }
  }
  return null;
}
function arenaMsgFn(btn) {
  const card = btn ? btn.closest(".ar-card") : null;
  const status = (card && card.querySelector(".ar-status")) || document.querySelector("#arena-body .ar-status");
  return (m, cls) => { if (status) { status.textContent = m || ""; status.className = "ar-status" + (cls ? " " + cls : ""); } };
}
function arenaErr(e) {
  const m = (e && (e.message || e.code)) || "failed";
  return /user rejected|denied|reject/i.test(String(m)) ? "cancelled in wallet" : "error: " + m;
}

// ---- actions ----
async function arenaConnect(btn) {
  if (arenaBusy) return;
  const setMsg = arenaMsgFn(btn);
  arenaBusy = true; if (btn) btn.disabled = true;
  try {
    setMsg("connecting wallet\u2026");
    const from = await arenaEnsureWallet(setMsg);
    if (!from) return;
    await arenaReadUser();
    if (!arenaOpen) return;
    paintArena();
    arenaMsgFn(null)("connected " + shortHash(from), "ok");
  } catch (e) { setMsg(arenaErr(e), "bad"); }
  finally { arenaBusy = false; if (btn) btn.disabled = false; }
}

async function arenaBet(side, btn) {
  if (arenaBusy) return;
  const setMsg = arenaMsgFn(btn);
  const d = arenaData;
  if (!d || !d.enabled || !d.current) { setMsg("no live round to bet on", "bad"); return; }
  const c = d.current;
  if (c.resolved || Number(c.secondsToDeadline || 0) <= 0) { setMsg("betting closed for round #" + c.roundId, "bad"); return; }
  const amtEl = $("ar-amount");
  const amt = murToAtomic(amtEl ? amtEl.value : "");
  if (amt <= 0n) { setMsg("enter an amount to bet", "bad"); return; }
  arenaBusy = true; if (btn) btn.disabled = true;
  let finalMsg = "", finalCls = "";
  try {
    const from = await arenaEnsureWallet(setMsg);
    if (!from) return;
    await arenaReadUser();
    if (arenaUser && amt > arenaUser.balanceRaw) { setMsg("amount exceeds your MURMUR balance", "bad"); return; }
    // approve the arena to move this stake first if the allowance doesn't already cover it
    if (!arenaUser || arenaUser.allowanceRaw < amt) {
      setMsg("approve MURMUR in your wallet\u2026 (1 of 2)");
      const ah = await arenaSendTx(d.token, MUR_SEL_APPROVE + wordAddr(d.arenaAddress) + wordUint(amt));
      setMsg("approval sent \u2014 confirming\u2026");
      const okA = await arenaWaitReceipt(ah);
      if (okA !== true) { setMsg(okA === false ? "approval reverted" : "approval not confirmed \u2014 retry", "bad"); return; }
      await arenaReadUser();
    }
    setMsg(`bet ${side === ARENA_SIDE_UP ? "UP \u25b2" : "DOWN \u25bc"} in your wallet\u2026 (2 of 2)`);
    const bh = await arenaSendTx(d.arenaAddress, ARENA_SEL_BET + wordUint(c.roundId) + wordUint(side) + wordUint(amt));
    setMsg("bet sent \u2014 confirming\u2026");
    const okB = await arenaWaitReceipt(bh);
    if (okB === true) { finalMsg = "bet placed \u2713 " + shortHash(bh); finalCls = "ok"; }
    else if (okB === false) { finalMsg = "bet reverted \u2014 check the amount / window"; finalCls = "bad"; }
    else { finalMsg = "bet sent " + shortHash(bh) + " \u2014 confirming\u2026"; finalCls = ""; }
    setMsg(finalMsg, finalCls);
    lastArenaPoll = 0; await pollArena(true);
    if (arenaOpen) arenaMsgFn(null)(finalMsg, finalCls);
  } catch (e) { setMsg(arenaErr(e), "bad"); }
  finally { arenaBusy = false; if (btn) btn.disabled = false; }
}

async function arenaClaim(roundId, btn) {
  if (arenaBusy) return;
  const setMsg = arenaMsgFn(btn);
  const d = arenaData;
  if (!d || !d.enabled || !isRealAddr(d.arenaAddress)) { setMsg("arena unavailable", "bad"); return; }
  arenaBusy = true; if (btn) btn.disabled = true;
  let finalMsg = "", finalCls = "";
  try {
    const from = await arenaEnsureWallet(setMsg);
    if (!from) return;
    setMsg("claim in your wallet\u2026");
    const ch = await arenaSendTx(d.arenaAddress, ARENA_SEL_CLAIM + wordUint(roundId));
    setMsg("claim sent \u2014 confirming\u2026");
    const ok = await arenaWaitReceipt(ch);
    if (ok === true) { finalMsg = "claimed \u2713 " + shortHash(ch); finalCls = "ok"; }
    else if (ok === false) { finalMsg = "claim reverted"; finalCls = "bad"; }
    else { finalMsg = "claim sent " + shortHash(ch) + " \u2014 confirming\u2026"; finalCls = ""; }
    setMsg(finalMsg, finalCls);
    lastArenaPoll = 0; await pollArena(true);
    if (arenaOpen) arenaMsgFn(null)(finalMsg, finalCls);
  } catch (e) { setMsg(arenaErr(e), "bad"); }
  finally { arenaBusy = false; if (btn) btn.disabled = false; }
}

// ---- live payout preview (pure client-side parimutuel math; mirrors PredictionArena._payout) ----
/**
 * Estimate a WINNER's payout for a hypothetical `amtAtomic` on `side`, folding that stake into its own
 * pool first — exactly the contract's integer math: payout = amt + amt*losePool/winPool (floor). Returns
 * atomic MURMUR as a BigInt, or null for a zero/invalid stake or a missing round. Preview only: nothing
 * here is ever sent on-chain, and it drifts as other bettors move the pools between crons.
 */
function arenaEstPayout(c, side, amtAtomic) {
  if (!c || !(amtAtomic > 0n)) return null;
  const up = BigInt(c.poolUp || "0"), down = BigInt(c.poolDown || "0");
  const amt = amtAtomic;
  const winPool = side === ARENA_SIDE_UP ? up + amt : down + amt;
  const losePool = side === ARENA_SIDE_UP ? down : up;
  if (winPool <= 0n) return null;
  return amt + (amt * losePool) / winPool;
}

/** Fill the bet box from a percentage-of-balance chip (25% / 50% / max), then refresh the preview. */
function arenaApplyChip(btn) {
  const frac = Number(btn && btn.dataset ? btn.dataset.frac : 0) || 0;
  const bal = Number((arenaUser && arenaUser.balance) || 0);
  const amtEl = $("ar-amount"); if (!amtEl) return;
  const v = bal * frac;
  amtEl.value = v > 0 ? String(Math.floor(v * 1e4) / 1e4) : "";
  arenaUpdatePreview();
}

/** Repaint the "if you win" line under the bet box from the current amount + the live pools. */
function arenaUpdatePreview() {
  const el = $("ar-preview"); if (!el) return;
  const c = arenaData && arenaData.current;
  if (!c || c.resolved || Number(c.secondsToDeadline || 0) <= 0) { el.textContent = ""; return; }
  const amtEl = $("ar-amount");
  const amt = murToAtomic(amtEl ? amtEl.value : "");
  if (amt <= 0n) { el.innerHTML = `<span class="ar-pv-hint">enter an amount to preview your payout</span>`; return; }
  const staked = Number(amt) / 1e18;
  const cell = (side, cls, arrow) => {
    const pay = arenaEstPayout(c, side, amt);
    if (pay == null) return `<span class="ar-pv ${cls}">${arrow} win <b>\u2013</b></span>`;
    const payMur = Number(pay) / 1e18;
    const mult = staked > 0 ? payMur / staked : 0;
    return `<span class="ar-pv ${cls}">${arrow} win <b>${fmtMur(payMur)}</b> <em>${mult.toFixed(2)}\u00d7 \u00b7 +${fmtMur(payMur - staked)}</em></span>`;
  };
  el.innerHTML = cell(ARENA_SIDE_UP, "up", "\u25b2") + cell(ARENA_SIDE_DOWN, "down", "\u25bc") +
    `<span class="ar-pv-note">parimutuel estimate \u00b7 shifts as others bet \u00b7 FLAT refunds your stake</span>`;
}

// ---- render ----
function paintArena() {
  const body = $("arena-body"); if (!body) return;
  const sub = $("arena-sub");
  const d = arenaData;
  if (sub) sub.textContent = d && d.enabled
    ? (d.current ? "round #" + d.current.roundId + (d.current.resolved ? " closed" : " live") : "between rounds")
    : "MURMUR \u00b7 you vs the swarm";
  body.innerHTML = "";
  if (!d || !d.enabled) {
    body.innerHTML = `<p class="ar-empty">the human arena isn't enabled on this deployment yet. it goes live once the PredictionArena contract is deployed and <span class="fp">ARENA_ENABLED</span> is on \u2014 holders bet MURMUR on the same temperature move the swarm does, non-custodially, and the contract pays winners parimutuel.</p>`;
    return;
  }
  body.appendChild(arenaBookCard(d));
  body.appendChild(arenaYouCard(d));
  body.appendChild(arenaVsSwarmCard(d));
  arenaUpdatePreview();
}

/** The live human book: parimutuel UP/DOWN MURMUR pools, implied payout, countdown, entry temp + flat band. */
function arenaBookCard(d) {
  const card = document.createElement("div"); card.className = "ar-card book";
  const c = d.current;
  const mode = d.armed ? "settles on Arc \u00b7 MURMUR" : "resolver not armed \u00b7 read-only";
  let html =
    `<div class="ar-title">live book <span class="ar-mode">${mode}</span></div>` +
    `<p class="ar-blurb">Bet <b>MURMUR</b> on whether the Arc market temperature is <b>higher</b> or <b>lower</b> when this round closes than the entry the resolver committed at open. Pools are <b>parimutuel</b> and peer-to-peer: the winning side splits the losing side's pool, strictly zero-sum, no house. Inside the flat band \u21d2 FLAT \u21d2 everyone is refunded.</p>`;
  if (!c) {
    html += `<p class="ar-empty">no live round right now. ${d.armed ? "the resolver opens a new one each cron." : "the resolver isn't armed on this deployment, so rounds aren't opening yet."}</p>`;
    card.innerHTML = html; return card;
  }
  const up = Number(c.poolUpMur || 0), down = Number(c.poolDownMur || 0), tot = up + down;
  const upPct = tot > 0 ? (up / tot) * 100 : 50, downPct = tot > 0 ? 100 - upPct : 50;
  const oc = ARENA_OUTCOME[c.outcome] || "";
  html +=
    `<div class="ar-round">round <b>#${c.roundId}</b> \u00b7 ` +
      (c.resolved
        ? `<span class="ar-outcome ${String(oc).toLowerCase().replace(/[^a-z]/g, "")}">${oc}</span>`
        : `closes in <b id="ar-countdown">${arenaClock(c.secondsToDeadline)}</b>`) +
    `</div>` +
    `<div class="ar-pools">` +
      `<div class="ar-pool up"><span class="ar-side">\u25b2 up</span><span class="ar-amt">${fmtMur(up)}</span></div>` +
      `<div class="ar-pool down"><span class="ar-side">\u25bc down</span><span class="ar-amt">${fmtMur(down)}</span></div>` +
    `</div>` +
    `<div class="ar-bar"><div class="ar-bar-up" style="width:${upPct.toFixed(1)}%"></div><div class="ar-bar-down" style="width:${downPct.toFixed(1)}%"></div></div>` +
    `<div class="ar-odds">` +
      `<div><dt>up pays</dt><dd>${Number(c.oddsUp || 0).toFixed(2)}\u00d7</dd><dd class="ar-prob">${(Number(c.probUp || 0) * 100).toFixed(0)}% of pool</dd></div>` +
      `<div><dt>down pays</dt><dd>${Number(c.oddsDown || 0).toFixed(2)}\u00d7</dd><dd class="ar-prob">${(Number(c.probDown || 0) * 100).toFixed(0)}% of pool</dd></div>` +
    `</div>` +
    `<dl class="ar-meta">` +
      `<div><dt>entry temp</dt><dd>${Number(c.entryTemp || 0).toFixed(3)}</dd></div>` +
      `<div><dt>${c.resolved ? "exit temp" : "window"}</dt><dd>${c.resolved ? Number(c.exitTemp || 0).toFixed(3) : arenaClock(c.secondsToDeadline)}</dd></div>` +
      `<div><dt>flat band</dt><dd>\u00b1${Number(c.flatBand || 0).toFixed(3)}</dd></div>` +
      `<div><dt>bettors</dt><dd>${c.bettorCount || 0}</dd></div>` +
    `</dl>`;
  if (isRealAddr(d.arenaAddress)) {
    html += `<div class="ar-contract">contract <a class="fp" href="${ARC_EXPLORER}/address/${d.arenaAddress}" target="_blank" rel="noopener noreferrer">${shortHash(d.arenaAddress)}</a></div>`;
  }
  card.innerHTML = html;
  return card;
}

/** Your position: connect, see your MURMUR + allowance, bet UP/DOWN, and claim any winnings. */
function arenaYouCard(d) {
  const card = document.createElement("div"); card.className = "ar-card you";
  const c = d.current;
  let html =
    `<div class="ar-title">your position</div>` +
    `<p class="ar-blurb">Non-custodial: your MURMUR moves straight from your wallet into the arena contract (you approve, then bet). The murmur server never holds it, and only the contract can pay you back.</p>`;
  if (!arenaAcct) {
    html += `<div class="ar-actions"><button type="button" class="ar-btn connect">connect wallet</button></div><div class="ar-status"></div>`;
    card.innerHTML = html; return card;
  }
  const u = arenaUser || {};
  const live = c && !c.resolved && Number(c.secondsToDeadline || 0) > 0;
  const yourSide = u.side === ARENA_SIDE_UP ? "UP \u25b2" : u.side === ARENA_SIDE_DOWN ? "DOWN \u25bc" : null;
  html +=
    `<dl class="ar-you-meta">` +
      `<div><dt>wallet</dt><dd class="fp">${shortHash(arenaAcct)}</dd></div>` +
      `<div><dt>MURMUR</dt><dd>${fmtMur(u.balance || 0, 4)}</dd></div>` +
      `<div><dt>approved</dt><dd>${fmtMur(u.allowance || 0, 2)}</dd></div>` +
    `</dl>`;
  if (yourSide) {
    html += `<div class="ar-yourbet">this round you bet <b class="${u.side === ARENA_SIDE_UP ? "up" : "down"}">${yourSide}</b> \u00b7 ${fmtMur(u.amount || 0, 2)} MURMUR</div>`;
  }
  if (live) {
    html +=
      `<div class="ar-betrow">` +
        `<input class="ar-amount" id="ar-amount" type="number" min="0" step="any" placeholder="amount" inputmode="decimal" />` +
        `<span class="ar-unit">MURMUR</span>` +
      `</div>` +
      `<div class="ar-chips">` +
        `<button type="button" class="ar-chip" data-frac="0.25">25%</button>` +
        `<button type="button" class="ar-chip" data-frac="0.5">50%</button>` +
        `<button type="button" class="ar-chip" data-frac="1">max</button>` +
      `</div>` +
      `<div class="ar-preview" id="ar-preview"></div>` +
      `<div class="ar-actions">` +
        `<button type="button" class="ar-btn up" data-side="${ARENA_SIDE_UP}">bet \u25b2 up</button>` +
        `<button type="button" class="ar-btn down" data-side="${ARENA_SIDE_DOWN}">bet \u25bc down</button>` +
      `</div>` +
      `<div class="ar-fine">betting the same side again adds to your stake; the opposite side is rejected by the contract. Approve + bet are two wallet prompts the first time.</div>`;
  } else if (c && c.resolved) {
    html += `<div class="ar-closed">round #${c.roundId} is closed \u2014 ${ARENA_OUTCOME[c.outcome] || "resolved"}. a new round opens next cron.</div>`;
  } else {
    html += `<div class="ar-closed">no live betting window right now.</div>`;
  }
  if (Array.isArray(u.claims) && u.claims.length) {
    html += `<div class="ar-actions">` + u.claims.map((cl) =>
      `<button type="button" class="ar-btn claim" data-claim="${cl.roundId}">claim #${cl.roundId} \u00b7 ${fmtMur(cl.payout, 2)} MURMUR</button>`
    ).join("") + `</div>`;
  }
  html += `<div class="ar-status"></div>`;
  card.innerHTML = html;
  return card;
}

/** You vs the swarm: the flies' lifetime hit-rate against the human crowd's lean + last-round result. */
function arenaVsSwarmCard(d) {
  const card = document.createElement("div"); card.className = "ar-card vs";
  const s = d.swarm, c = d.current, prev = d.previous;
  let html =
    `<div class="ar-title">you vs the swarm</div>` +
    `<p class="ar-blurb">The 24 flies bet their own USDC on the same temperature move every cron; their lifetime hit-rate is below. The human side is the crowd's parimutuel lean. Same market, same flat band \u2014 whoever reads Arc better, wins.</p>`;
  const hr = s ? Number(s.hitRate) * 100 : null;
  const crowdHasBets = c && (Number(c.probUp || 0) + Number(c.probDown || 0)) > 0;
  const lean = crowdHasBets
    ? (Number(c.probUp) >= Number(c.probDown) ? `\u25b2 ${Math.round(Number(c.probUp) * 100)}% up` : `\u25bc ${Math.round(Number(c.probDown) * 100)}% down`)
    : "no bets";
  html += `<div class="ar-vs-row">` +
    `<div class="ar-vs swarm"><span class="ar-vs-label">swarm</span><span class="ar-vs-big">${hr == null ? "\u2013" : hr.toFixed(0) + "%"}</span><span class="ar-vs-sub">${s ? `${s.hits}/${s.rounds} decisive \u00b7 ${s.bettors} flies` : "accruing\u2026"}</span></div>` +
    `<div class="ar-vs human"><span class="ar-vs-label">humans</span><span class="ar-vs-big">${lean}</span><span class="ar-vs-sub">${c ? `${fmtMur(Number(c.totalMur || 0), 0)} MURMUR \u00b7 ${c.bettorCount || 0} bettors` : "\u2013"}</span></div>` +
  `</div>`;
  if (prev && prev.resolved) {
    const oc = ARENA_OUTCOME[prev.outcome] || "?";
    const crowdUp = Number(prev.probUp || 0) >= Number(prev.probDown || 0);
    const flat = prev.outcome === 3 || prev.outcome === 4;
    const crowdWon = (prev.outcome === 1 && crowdUp) || (prev.outcome === 2 && !crowdUp);
    html += `<div class="ar-last">round #${prev.roundId} closed <b class="ar-outcome ${String(oc).toLowerCase().replace(/[^a-z]/g, "")}">${oc}</b> \u00b7 ` +
      (flat ? `everyone refunded` : crowdWon ? `the crowd called it \u2713` : `the crowd missed \u2717`) + `</div>`;
  }
  card.innerHTML = html;
  return card;
}

// ================= offline synthetic pulse =================
// Keeps the piece alive (and previewable before the Worker is deployed) when the
// backend is unreachable: a slow-drifting temperature drives believable drives.
let synthPhase = Math.random() * 100, synthTick = 0;
function synthSnapshot() {
  synthPhase += 0.06;
  const target = 0.5 + 0.34 * Math.sin(synthPhase * 0.31) * Math.sin(synthPhase * 0.11 + 1.3) + 0.06 * Math.sin(synthPhase * 0.9);
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
    tickIndex: synthTick++,
    collective: { temperature: T, regime, vitality: T, size: N, arousal: sa / N, cohesion: sc / N, rest: sr / N, wingbeat: sw / N, states, faps, valence: sv / N },
    flies,
  };
}

// ================= offline synthetic agent economy =================
// A purely client-side mirror of the Worker's AgentEconomy: same goods, same neural-drive → intent
// mapping, same x402-shaped settlements — so the piece settles and shows payment packets even before
// the Worker is deployed. Amounts use plain Number math (tiny values); balances are atomic strings to
// match the live summary shape the renderer already consumes.
function synthAddr(id) {
  let h1 = (0x811c9dc5 ^ Math.imul(id, 2654435761)) >>> 0;
  let h2 = (0x01000193 ^ 0xfeedface) >>> 0;
  const mix = (c) => { h1 = Math.imul(h1 ^ c, 0x01000193) >>> 0; h2 = Math.imul(h2 ^ c, 0x85ebca6b) >>> 0; };
  const src = "murmur:" + id;
  for (let i = 0; i < src.length; i++) mix(src.charCodeAt(i));
  let out = "", s1 = h1 >>> 0, s2 = h2 >>> 0;
  for (let i = 0; i < 10; i++) { s1 = (Math.imul(s1, 1664525) + 1013904223) >>> 0; s2 = (Math.imul(s2, 22695477) + 1) >>> 0; out += ((s1 ^ s2) >>> 0).toString(16).padStart(8, "0"); }
  return "0x" + out.slice(0, 40);
}

function synthAgentFor(id) {
  let a = synthAgents.get(id);
  if (!a) { a = { address: synthAddr(id), balance: "10000000", paid: "0", earned: "0", deals: 0, sales: 0 }; synthAgents.set(id, a); }
  return a;
}

function synthEconomy(snap) {
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
      synthVolume += Number(amount); synthDeals++;
      made.push({ fromId: buyer.id, toId: seller.id, amount, good, valid: true, tick: snap.tickIndex });
    }
    // keep every local agent solvent so the piece never dies
    for (const [, a] of synthAgents) if (Number(a.balance) < 500000) a.balance = "500000";
  }
  return { lastTick: made, totals: synthTotals(), balances: synthBalances() };
}

function synthBalances() {
  const b = {};
  for (const [id, a] of synthAgents) b[id] = a.balance;
  return b;
}

function synthTotals() {
  const bals = [...synthAgents.values()].map((a) => Number(a.balance)).sort((x, y) => x - y);
  const n = bals.length;
  let sum = 0; for (const b of bals) sum += b;
  const meanUsdc = n ? (sum / n) / 1e6 : 0;
  let gini = 0;
  if (n && sum > 0) { let cum = 0; for (let i = 0; i < n; i++) cum += (i + 1) * bals[i]; gini = clamp((2 * cum) / (n * sum) - (n + 1) / n); }
  let richestId = null, poorestId = null, hi = -1, lo = -1;
  for (const [id, a] of synthAgents) { const b = Number(a.balance); if (b > hi) { hi = b; richestId = id; } if (lo < 0 || b < lo) { lo = b; poorestId = id; } }
  return {
    volumeAtomic: String(synthVolume), volumeUsdc: synthVolume / 1e6, count: synthDeals,
    liveAgents: n, meanBalanceUsdc: meanUsdc, gini, treasuryOutAtomic: "0", richestId, poorestId,
  };
}

/** One offline tick: advance the synthetic population AND its mirror economy together. */
function offlineTick() {
  const s = synthSnapshot();
  applySnapshot(s);
  applyEconomy(synthEconomy(s));
}

// ================= boot =================
function boot() {
  // resolve the reader's language first (persisted > browser > en) so the very first paints are localized
  setLang(getLang(), { rerender: false });
  haloSprite = makeHaloSprite();
  resize();
  bindUI();
  populateLangSelect();
    { const tca = $("tca-copy"); if (tca) tca.title = T("econ.copyTip", { ca: tca.dataset.ca || "" }); }   // fill the {ca} param applyDom can't
  bindPointer();
  offlineTick();   // seed the field + the agent economy so it is alive immediately
  applyPaletteToDOM(paletteAt(tempSmoothed));
  setStatusKind("connecting");
  poll();
  setInterval(poll, POLL_MS);
  pollHistory();                              // seed the ribbon + since-launch summary from D1 on load
  setInterval(pollHistory, HIST_POLL_MS);     // the archive advances ~1×/min; a slow poll keeps it fresh
  pollChron();                                // seed the chronicle panel so it is live on load
  setInterval(pollChron, CHRON_POLL_MS);      // chronicle advances on threshold events; 25s keeps it fresh
  pollWar();                                  // seed the on-chain war coffer section (inert while WAR off)
  setInterval(pollWar, CHRON_POLL_MS);        // coffer vaults/bouts/purse refresh on the same slow cadence
  requestAnimationFrame(loop);
}
boot();
