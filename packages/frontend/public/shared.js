// shared.js — 共享常量 / 纯 helper / canvas / 全部可变状态（state 对象，所有模块读写同一份引用）
// 由 app.js 机械拆分（任务5），行为与原文件一致；原文件保留为 app.js 备份参考。
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

export const params = new URLSearchParams(location.search);
export const API =
  params.get("api") ||
  localStorage.getItem("murmur-api") ||
  "https://api.muros.live";
// Worker API on the project's own zone (not *.workers.dev)
if (params.get("api")) localStorage.setItem("murmur-api", API);
export const POLL_MS = 12000;
// main loop: /population + /state. The on-chain tick is ~60s and the canvas animates
                        // locally between polls (updateSim interpolates off the last snapshot), so 12s is still
                        // 5× the cron cadence — imperceptible visually while halving the coordinator DO's read
                        // queue, the real lever behind the cron-starvation freeze (see worker swarm.ts A1 note).
export const FETCH_TIMEOUT_MS = 3500;
// abort a hung request well before the browser would
export const OFFLINE_BACKOFF_MS = 20000;
// circuit-breaker window: run local-only, no probing
export const TAU = Math.PI * 2;
export const $ = (id) => document.getElementById(id);
// ---------- small math / colour helpers ----------
export const clamp = (x, a = 0, b = 1) => (x < a ? a : x > b ? b : x);
export const lerp = (a, b, t) => a + (b - a) * t;
export const mix = (A, B, t) => [lerp(A[0], B[0], t), lerp(A[1], B[1], t), lerp(A[2], B[2], t)];
export const rgb = (c) => `rgb(${c[0] | 0},${c[1] | 0},${c[2] | 0})`;
export const rgba = (c, a) => `rgba(${c[0] | 0},${c[1] | 0},${c[2] | 0},${a})`;
// ---------- live palette: temperature → paper + accent ----------
export const PALETTE = {
  cold: { paper: [232, 237, 239], accent: [91, 124, 141] },   // cool slate
  calm: { paper: [242, 238, 230], accent: [154, 140, 110] },  // warm bone + taupe
  hot:  { paper: [247, 234, 224], accent: [192, 94, 60] },    // blush + terracotta
};
export function paletteAt(T) {
  T = clamp(T);
  return T < 0.5
    ? { paper: mix(PALETTE.cold.paper, PALETTE.calm.paper, T / 0.5), accent: mix(PALETTE.cold.accent, PALETTE.calm.accent, T / 0.5) }
    : { paper: mix(PALETTE.calm.paper, PALETTE.hot.paper, (T - 0.5) / 0.5), accent: mix(PALETTE.calm.accent, PALETTE.hot.accent, (T - 0.5) / 0.5) };
}
export function applyPaletteToDOM(pal) {
  const p = pal.paper, a = pal.accent, s = document.documentElement.style;
  s.setProperty("--paper", rgb(p));
  const pp = mix(p, [26, 26, 24], 0.06);   // a touch darker than the paper so panels stand off the parchment map
  s.setProperty("--panel", `rgba(${pp[0] | 0},${pp[1] | 0},${pp[2] | 0},0.94)`);
  s.setProperty("--accent", rgb(a));
  s.setProperty("--accent-rgb", `${a[0] | 0},${a[1] | 0},${a[2] | 0}`);
}
// behavioural-state earth tones (CSS strings for the inspector badge)
export const STATE_COLOR = { AGITATE: "#c05e3c", EXPLORE: "#c99a3f", AGGREGATE: "#5b7c8d", REST: "#8b9a86" };
export const KIND_COL = { sensory: [91, 124, 141], inter: [122, 114, 98], modulatory: [192, 94, 60], motor: [26, 26, 24] };
// task 22 B1 — STIR_COL ("neutral ink for the pointer stir ripple") deleted with the ripple feature:
// the tap rings were cancelled in task 20④, and with render2d.js's draw loop gone nothing read it.
export const hexRgb = (h) => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];
// state colours as RGB triples (STATE_COLOR holds CSS hex) — for the canvas dots in the shard-topology ring
export const STATE_RGB = { AGITATE: hexRgb(STATE_COLOR.AGITATE), EXPLORE: hexRgb(STATE_COLOR.EXPLORE), AGGREGATE: hexRgb(STATE_COLOR.AGGREGATE), REST: hexRgb(STATE_COLOR.REST) };
// ---- Ethogram: named Fixed Action Patterns (FAPs) -----------------------------------------------
// The richer behaviour vocabulary decoded server-side from the SAME neural read-out (fly-brain/ethogram.ts):
// a competitive appetitive/aversive pathway + an inhibition hierarchy pick one named action per tick. Each
// FAP gets an earth-tone colour (so the swarm's actions read at a glance), a one-line gloss and an implied
// observable economic role. READ-OUT ONLY — it never feeds a settlement decision, it only animates the fly.
export const FAP_COLOR = {
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
export const FAP_GLOSS = {
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
export const FAP_ROLE = {
  FEED: "momentum-buyer", GROOM: "self-maintainer", FORAGE: "signal-seeker", HALT: "observer",
  RETREAT: "risk-off", COURT: "attestation-broadcaster", FLIGHT: "liquidator", HUDDLE: "consensus-follower", REST: "dormant",
};
// a legible gait multiplier per FAP (flight bolts, rest barely stirs) layered over the raw drives
export const FAP_SPEED = { FLIGHT: 1.55, RETREAT: 1.4, FORAGE: 1.0, HUDDLE: 0.78, GROOM: 0.55, COURT: 0.6, FEED: 0.5, HALT: 0.3, REST: 0.18 };
export const fapColor = (fap) => FAP_COLOR[fap] || "#8b9a86";
// Wealth → colour ramp: the poorest flies read cool slate, the richest glow warm gold, so body HUE and
// body SIZE (both balance-driven) tell the same story at a glance — big + gold = a wealthy wallet.
export const WEALTH_RAMP = [
  [92, 118, 140],   // poorest  — cool slate blue
  [126, 140, 122],  // lean     — muted sage
  [198, 154, 74],   // well-off — amber
  [240, 196, 92],   // richest  — bright gold
];
export function wealthColorAt(t) {
  t = clamp(t, 0, 1);
  const n = WEALTH_RAMP.length - 1;
  const i = Math.min(n - 1, Math.floor(t * n));
  return mix(WEALTH_RAMP[i], WEALTH_RAMP[i + 1], t * n - i);
}
// ================= client state =================
export const sim = new Map();
// last /state lastCron (epoch ms) — the DO cron's heartbeat, for the watchdog
export const CRON_STALE_MS = 240000;
// ================= agent economy (x402 micropayments between flies) =================
// Each fly is an autonomous agent; the /population feed now carries an economy summary
// ({ lastTick, totals, balances }). We render every settlement as a payment packet flying from
// payer to payee, keep a rolling ledger ticker, and show the selected fly's wallet in the inspector.
export const atomicToUsdc = (a) => Number(a) / 1e6;
// amounts arrive as atomic-USDC strings (6 dec)
export const GOOD_COL = { signal: [91, 124, 141], momentum: [192, 94, 60], attestation: [139, 154, 134], prediction: [122, 96, 150] };
export const ECON_EDGE_MS = 2000;
// a payment packet lives ~2s
export const MAX_EDGES = 60;
// cap: a busy tick can't pile up unbounded arcs
// Official Arc block explorer (docs.arc.io → mainnet chain 5042). Every real settlement carries a
// 64-hex txHash, so each ledger line links straight to it — a visitor can prove the money moved on-chain.
export const ARC_EXPLORER = "https://explorer.arc.io";
// Public Arc RPC — the browser reads our NeuralReceiptRegistry DIRECTLY from here (no murmur server
// in the loop) so the on-chain hash-chain head is verified trustlessly. Selectors are precomputed
// keccak256 prefixes (viem toFunctionSelector) so we need no ABI encoder in the page.
export const ARC_RPC = "https://rpc.mainnet.arc.io";
export const REG_SEL_COMMITS = "0x47885781";
// commits(bytes32)
export const REG_SEL_CHAINHEAD = "0x008f51c6";
// chainHead()
// NeuralManifestRegistry selectors (precomputed keccak256 prefixes) — the browser reads the committed
// brain-manifest hash straight off Arc, so "prove the brain" is trustless end-to-end (no murmur server).
export const MAN_SEL_LATEST = "0x6f17d258";
// latestHash()
export const MAN_SEL_ISCOMMITTED = "0x054765a3";
// isCommitted(bytes32)
export const MAN_SEL_COUNT = "0x9123988b";
// commitCount()
// ConnectomeLineage selectors (precomputed keccak256 prefixes) — the browser reads each genome's committed
// ancestry STRAIGHT off Arc (no murmur server in the loop), so the breeding market's family tree is trustless
// end-to-end. lineages(bytes32) returns 7 words: genomeHash,parentA,parentB,op,generation,breeder,ts.
export const LIN_SEL_LINEAGES = "0xce3dace4";
// lineages(bytes32)
export const LIN_SEL_COUNT = "0x9123988b";
// commitCount()
export const LIN_SEL_LATEST = "0x6f17d258";
// latestHash()
export const LIN_SEL_COMMITTER = "0x5bc8e8f9";
// committer()
export const isZeroBytes32 = (w) => !w || /^0x0{64}$/.test(String(w).toLowerCase());
export const bytes32 = (h) => "0x" + String(h || "").replace(/^0x/i, "").toLowerCase().padStart(64, "0");
export const wordToNum = (w) => Number(BigInt(w || "0x0"));
/** One JSON-RPC call to Arc. Throws on transport/HTTP failure so callers can fall back. */
export async function arcRpc(method, params, timeoutMs = 8000) {
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
export async function readRegistryOnchain(registryAddress, receiptHash) {
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
export const isRealTxHash = (h) => typeof h === "string" && /^0x[0-9a-fA-F]{64}$/.test(h);
export const isRealAddr = (a) => typeof a === "string" && /^0x[0-9a-fA-F]{40}$/.test(a);
export const shortHash = (h) => `${h.slice(0, 6)}…${h.slice(-4)}`;
/**
 * Read the brain-manifest commitment straight from the on-chain NeuralManifestRegistry via eth_call.
 * Returns null when the read fails (CORS/network) or no registry is configured, so the caller can fall
 * back to "not anchored yet" without ever blocking the browser-side hash recompute.
 *   · latestHash()      → the most recently committed manifest hash (bytes32)
 *   · isCommitted(h)    → whether THIS manifest's hash is anchored (bool → last word == 1)
 *   · commitCount()     → how many manifests have ever been committed
 */
export async function readManifestOnchain(registryAddress, manifestHash) {
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
export async function readLineageOnchain(lineageAddress, genomeHash) {
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
export async function readLineageHead(lineageAddress) {
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
export const SEEN_CAP = 400;
// right-side "swarm history" drawer
export const HIST_POLL_MS = 300000;
// highest seq the ticker has already shown — only newer entries animate in
export const CHRON_POLL_MS = 45000;
// live tail: {t: Date.now() ms, T: temperature}
export const HIST_SAMPLE_MS = 1000;
export const RIBBON_WINDOW = 20 * 60 * 1000;
export const MIND_REBUILD_MS = 320;
// a stable signature of which zones changed hands in war — folded into terrKey so a conquest repaints the dominion map

// ================= canvas field =================
export const canvas = $("field");
// the house-territory MAP partition: [{name,sigil,color,ids,_scr,_pts,_hatch,_blob}] — rebuilt on each roster poll (null ⇒ no houses)

export const SOCIETY_BOND_MIN = 0.25;
// min bond score to count as an alliance edge
export const SOCIETY_FEUD_MAX = -0.6;
// bond score at/under which two flies actively shun each other
export const SOCIETY_ANCHOR_K = 0.0025;
// spring toward the colony's home anchor (gentle, ~ cohesion scale)
export const SOCIETY_SLOT_R = 52;
// css px — radius of the disc a colony's members are slotted onto (anti-clump)
export const SOCIETY_ALLY_K = 0.5;
// ally pull accel (unit vector × bond weight)
export const SOCIETY_ALLY_REST = 40;
// css px — bond rest length; closer than this the spring PUSHES apart (anti-knot)
export const SOCIETY_FEUD_K = 1.1;
// feud push accel, faded out beyond SOCIETY_FEUD_RANGE
export const SOCIETY_FEUD_RANGE = 220;
// css px — grudges only shove when the flies are this close
export const SOCIETY_PAD = 30;
// territory outline padding beyond the outermost member
export const SOCIETY_TERR_GAP = 26;
// css px of clear space physics keeps between two territories
export const SOCIETY_TERR_K = 0.02;
// colony-vs-colony repulsion strength (per px of overlap)
export const SOCIETY_CAP_GAP = 12;
// css px gap enforced by the Voronoi cap when drawing
export const SOCIETY_MINCAP = 24;
// a territory never shrinks below this radius (still exclusive)
// muted jewel/earth tones so colonies read on the light paper without clashing with the palette
export const COLONY_COLORS = [
  [91, 124, 141], [154, 110, 90], [120, 140, 96], [176, 142, 86],
  [140, 104, 140], [96, 140, 138], [168, 110, 110], [124, 124, 168],
];
// evocative deterministic colony names, index-aligned with COLONY_COLORS so a colony keeps one identity
export const COLONY_NAMES = ["Helios", "Nimbus", "Verdant", "Aurora", "Axiom", "Hearth", "Echo", "Quorum", "Solace", "Umbra", "Cinder", "Thistle"];
export const GOLD_THREAD = [198, 152, 66];
// the reference's signature "gold thread" for intra-colony bonds
export const CRACK_RED = [198, 60, 44];
// conflict / grudge cracks between rivals
export const fnv1a = (str) => { let h = 0x811c9dc5; for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; } return h >>> 0; };
// ---- lineage (dynasty bloodline) + chronicle-event layers --------------------------------
// House names ARE colour words, so the bloodline tint is the name itself: a thin ring on every fly
// plus a house-tinted ink trail, so a family reads as coloured streaks inside its colony.
export const HOUSE_COLORS = {
  ochre: [196, 148, 60], ivory: [214, 206, 182], ashen: [148, 150, 154], vermilion: [198, 70, 48],
  amber: [214, 164, 64], slate: [110, 126, 146], sage: [140, 164, 120], plum: [150, 104, 140],
  teal: [86, 150, 150], rust: [170, 96, 60], indigo: [92, 102, 170], rose: [190, 110, 130],
  sable: [96, 84, 72], verdant: [120, 140, 96], azure: [96, 132, 176], crimson: [178, 58, 66],
};
export const HOUSE_FALLBACK = [[176, 142, 86], [140, 104, 140], [96, 140, 138], [168, 110, 110], [124, 124, 168], [154, 110, 90]];
export function houseColor(name) {
  if (!name) return null;
  const k = String(name).toLowerCase();
  if (HOUSE_COLORS[k]) return HOUSE_COLORS[k];
  for (const w in HOUSE_COLORS) if (k.includes(w)) return HOUSE_COLORS[w];
  return HOUSE_FALLBACK[fnv1a(k) % HOUSE_FALLBACK.length];
}
// cached highlight set: focus + its colony + its bonds/feuds
export const houseOf = new Map();
// ⑪ cached {reigning, sects:[…]} totem summary (per religion poll)
export const MONUMENT_MS = 42000;
// how long a stele lingers before it fades into the paper
// ---- the persistent necropolis: headstones rebuilt from the server's grave ledger (econDynasty.graves) ----
export const graveField = [];
// the stone whose epitaph card is open
export const GRAVE_CAP = 120;
// ledger signature: rebake only when the grave ledger changes
// A reused slot id (live-retirement recycles a dead fly's id for its offspring) means id alone no longer
// identifies an individual — (id, bornTick) does. Stones + selection key on this composite so a new
// occupant of an old id never aliases the grave of the fly that was buried in that slot before it.
export const graveUid = (id, bornTick) => id + ":" + (bornTick == null ? "" : bornTick);
export const GILT = [176, 138, 54];
// gold-leaf
export const GILT_HI = [214, 178, 92];
// gold highlight
export const INK = [40, 32, 24];
// sepia ink for engraved text
export const VELLUM = [236, 227, 208];
// the epic centre-caption flashed when the chronicle "happens"
export const LAW_GOLD = [186, 152, 66];
// the legislative shockwave tint (assembly / decree)
export const FAITH_GOLD = [226, 186, 96];
// ⑪ the candlelight tint of the faith membrane (prophet / pilgrimage / holy day)
export const COIN_GOLD = [214, 176, 84];
// ⑲ the bourse's coin-gold: treasury pulse, fever embers, the whale shockwave
export const TECH_BRONZE = [176, 128, 74];
// ⑬⑯ the bronze of an invention stele, a raised school, a craft passed hand to hand
export const ASH_GREY = [126, 122, 116];
// ================= the land comes alive: ambient war & earth motion =================
// Pure decoration laid on top of the dominion map (WORLD space, so it pans/zooms with the map) and BELOW
// the flies. Everything is time-driven (no state, no sim writes) and cheap; the per-frame count is capped
// and the whole call is try/caught at the site so it can never drop a frame. Each family's "capital" tracks
// its swarm's live centroid, so banners and hearths read as a living settlement rather than a fixed label.
export const FIRE_HOT = [255, 206, 120], FIRE_MID = [240, 132, 48], FIRE_LO = [188, 54, 30];
export const SMOKE = [120, 112, 100];
// ============ ⑭㉖ the living civilization: real settlements, public works & the trade road ============
// Until now the "cities" on the field were six decorative provincial strongholds (drawCity) that never reflected
// the swarm's actual settling. This layer reads the SAME econ* membranes the drawers do — econCities (⑭ the named
// settlements + the road between the two greatest), econWorks (㉖ the standing granary/aqueduct/monument) and
// econDynasty (whose HOME each zone is) — and turns them into geography. Every settlement sits at its zone's
// force-field anchor (the very spot updateSim pulls its kin toward, so the town is drawn inside the cluster of
// flies that IS its people), ranked hamlet → town → city and grown with its pop; the common works anchor beside
// the greatest city; a golden caravan road threads the two greatest. PURE READ-OUT: it reads econ*, writes no
// sim/economy, and is try/caught at the call site so a decoration bug can never veto a frame. Static structure is
// baked into civOff (the terrOff discipline — one blit a frame, rebuilt only when the signature moves); only
// smoke, fire, gilt glow and the caravans are drawn live, and only at quality ≥ 1.
export const CIV_THATCH = [150, 116, 66];
// a hamlet hut's daub wall
export const CIV_WALL = [172, 154, 126];
// a town/city's dressed stone
export const CIV_ROOF = [122, 80, 50];
// timber-shingle roof
export const CIV_SHADOW = [20, 16, 12];
export const WK_AGE_TICKS = 60;
// mirrors works.ts WK_AGE — a work's mortar term, for the weathering read
export const WORK_SLOT = { granary: [-48, 14], aqueduct: [2, 46], monument: [50, 10] };
// beside the greatest city
// City-builder dressing (the sun-baked mudbrick town read): wall/roof/plaza/water/green tones, all static ⇒ baked.
export const MUD = [198, 170, 128], MUD_HI = [228, 206, 166], MUD_SH = [158, 128, 94];
export const TERRA = [176, 96, 60];
// terracotta tile accent
export const PLAZA = [216, 198, 166], POOL = [104, 152, 172];
export const PALM = [92, 122, 62], BLOSSOM = [198, 88, 102], GARDEN = [128, 158, 88];
export const SAIL = [246, 240, 224], HULL = [92, 66, 44], RIVER_BLUE = [104, 140, 176];
// ================= the painted realm: provinces of the home continent =================
// The atlas (assets/ground.jpg) is a WORLD map; the living houses hold provinces on the HOME continent only
// (the other continents stay unclaimed until future houses settle them). The continent outline below is traced
// in atlas-normalised coords; each province is an organic region grown from a landmark seed (the peak, the river
// bend, the forest heart…) and Voronoi-capped against the other seeds, then CLIPPED to the continent — so the
// provinces tile the landmass exactly like the pastel regions of a fantasy atlas, never spilling into the sea.
export const CONTINENT = [
  [0.52, 0.125], [0.56, 0.12], [0.60, 0.13], [0.635, 0.155], [0.66, 0.185], [0.665, 0.22], [0.685, 0.25], [0.70, 0.285],
  [0.69, 0.32], [0.705, 0.355], [0.72, 0.39], [0.735, 0.41], [0.72, 0.44], [0.71, 0.475], [0.70, 0.51], [0.695, 0.55],
  [0.685, 0.585], [0.67, 0.62], [0.655, 0.655], [0.635, 0.69], [0.61, 0.72], [0.585, 0.75], [0.56, 0.78], [0.535, 0.81],
  [0.505, 0.835], [0.475, 0.855], [0.445, 0.86], [0.42, 0.845], [0.40, 0.82], [0.375, 0.80], [0.35, 0.78], [0.325, 0.755],
  [0.30, 0.73], [0.28, 0.70], [0.26, 0.67], [0.24, 0.64], [0.22, 0.61], [0.20, 0.575], [0.185, 0.54], [0.18, 0.505],
  [0.185, 0.47], [0.20, 0.44], [0.215, 0.415], [0.235, 0.395], [0.25, 0.375], [0.255, 0.345], [0.27, 0.315], [0.29, 0.285],
  [0.31, 0.255], [0.335, 0.225], [0.365, 0.20], [0.395, 0.175], [0.425, 0.155], [0.455, 0.14], [0.49, 0.13],
];
export const PROVINCES = [
  { name: "the High Peaks",  t: [0.52, 0.35] },
  { name: "the North Downs", t: [0.62, 0.25] },
  { name: "the Westwood",    t: [0.30, 0.48] },
  { name: "the River Plain", t: [0.45, 0.62] },
  { name: "the East March",  t: [0.64, 0.52] },
  { name: "the South Reach", t: [0.47, 0.78] },
];
// The OTHER continents & isles of the world atlas — unclaimed until future houses settle them. They get the same
// pastel-block treatment as the home provinces (neutral tint + brown border) plus an English cartouche label.
export const UNCLAIMED = [
  { poly: [[0.00, 0.02], [0.06, 0.00], [0.13, 0.00], [0.165, 0.03], [0.16, 0.09], [0.145, 0.15], [0.16, 0.21], [0.135, 0.27], [0.10, 0.32], [0.065, 0.37], [0.03, 0.395], [0.00, 0.38]], label: [0.075, 0.18] },
  { poly: [[0.185, 0.00], [0.30, 0.00], [0.365, 0.01], [0.355, 0.06], [0.325, 0.10], [0.285, 0.135], [0.24, 0.165], [0.205, 0.175], [0.185, 0.14], [0.18, 0.08], [0.182, 0.03]], label: [0.27, 0.075] },
  { poly: [[0.775, 0.00], [0.90, 0.00], [0.945, 0.02], [0.94, 0.08], [0.925, 0.14], [0.90, 0.19], [0.875, 0.235], [0.845, 0.27], [0.815, 0.275], [0.795, 0.235], [0.782, 0.18], [0.77, 0.12], [0.768, 0.05]], label: [0.86, 0.12] },
  { poly: [[0.895, 0.245], [0.925, 0.25], [0.94, 0.285], [0.925, 0.325], [0.905, 0.365], [0.885, 0.34], [0.883, 0.29]] },
  { poly: [[0.755, 0.685], [0.79, 0.64], [0.83, 0.605], [0.865, 0.58], [0.90, 0.565], [0.935, 0.575], [0.965, 0.59], [1.00, 0.60], [1.00, 0.90], [0.955, 0.885], [0.91, 0.865], [0.865, 0.835], [0.825, 0.80], [0.79, 0.76], [0.762, 0.725]], label: [0.895, 0.72] },
  { poly: [[0.00, 0.715], [0.045, 0.735], [0.085, 0.775], [0.125, 0.815], [0.165, 0.855], [0.205, 0.895], [0.235, 0.945], [0.245, 1.00], [0.00, 1.00]], label: [0.09, 0.88] },
  { poly: [[0.655, 0.905], [0.695, 0.865], [0.745, 0.845], [0.795, 0.85], [0.835, 0.875], [0.86, 0.925], [0.865, 1.00], [0.67, 1.00], [0.652, 0.955]], label: [0.76, 0.945] },
];
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
export const CHRON_ = {
  version: 1,
  genesis: "0".repeat(64),
  eraMinRun: 6,
  eraMinAge: 8,
  eraMaxAge: 60,
  templates: {
    ERA_OPEN: "Era {era~roman} · {eraName} — {size} minds tend the swarm on the Arc market, and the chronicle opens.",
    ERA_SHIFT: "Era {era~roman} · {eraName} dawns — the market has turned {regime~lower} and held it. An age begins.",
    ERA_PASSAGE: "Era {era~roman} · {eraName} turns over — an age of the {regime~lower} middle, measured by the swarm's own slow clock.",
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
    TERRITORY_SEIZED: "Conquest follows the verdict — the House of {winner} annexes {zones} zone(s) held by the vanquished House of {loser}, which is stripped of its ground and cast out, landless and toll-bound in exile.",
    PROPHECY: "A prophet rises — fly #{prophet} of {sect} bears the {god} flame, and {adherents} souls follow the vision.",
    SCHISM: "Schism in the House of {name} — {sigil} its kin turn from the old way to {sect}, and the ancestral shrine stands half-empty.",
    REVIVAL: "Revival — {sect} rises from silence: {adherents} souls kindle the cold shrine anew.",
    PILGRIMAGE: "Pilgrimage — on the holy day the House of {name} {sigil} walks to the ancestral shrine, {adherents} kin bearing candles.",
    // ⑫ ACCELERATED AGES — byte-for-byte the server chronicler TEMPLATES (a single drifted char and every
    //     visitor's "prove no LLM" banner goes red on these lines). Keep them in lockstep with chronicler.ts.
    GENERATION: "Generation {gen~roman} turns over — under {eraName} the swarm's fortune stands at {civ} of 100.",
    GOLDEN_AGE: "A Golden Age — the swarm's fortune swells past {golden} of 100 in Generation {gen~roman}; the ages look back on this as the high water.",
    DARK_AGE: "A Dark Age falls — the swarm's fortune breaks below {dark} of 100 in Generation {gen~roman}; the chronicle dims, and names are forgotten.",
    RENAISSANCE: "A Renaissance — out of the dark the swarm's fortune climbs back over {dark} of 100 in Generation {gen~roman}; the old names are read again.",
    MIGRATION: "A Great Migration — in Generation {gen~roman} the swarm spills past its old bounds at {size} minds, and a house carries its name to new ground.",
    // ⑬ TECH — the ladder of arts. Byte-for-byte the server chronicler TEMPLATES; a single drifted char and the
    //     "prove no LLM" banner goes red. chronicler.test.ts asserts this mirror holds, so it cannot drift silently.
    INVENTION: "An art is invented — in Generation {gen~roman} the swarm discovers {name}, rung {rung} of the ladder, credited to {credit}.",
    DIFFUSION: "{name} becomes a custom — {adopted} of {size} minds now work by it, and the art belongs to the swarm rather than to whoever found it.",
    LOST_ART: "A dark age takes its toll — {name} is unlearned in Generation {gen~roman}; the ladder falls back a rung, and the art must be found again.",
    // ⑭ CITIES — settlements and the census. Same lockstep rule as above.
    CITY_FOUNDED: "A place is named — {pop} kin hold the ground at {name}, and what was a camp becomes a {rank~lower} under the banner of {house}.",
    URBANIZATION: "The swarm turns urban — {urban} of {size} minds now live in {settlements} named places, the greatest of them {largest} holding {largestPop}; the open ground empties.",
    CENSUS: "A census is struck in Generation {gen~roman} — {size} minds alive, {meanAge} ticks of life across the last {graves} graves, {births} hatched and {deaths} buried since the last count.",
    PLAGUE_WAVE: "The rot walks the road — {deaths} burials inside the recent window, and the wave passes between {a} and {b} before anyone shuts a gate.",
    // ⑯ APPRENTICESHIP — education + cumulative culture. Same lockstep rule as above: byte-for-byte the server
    //     chronicler TEMPLATES (chronicler.test.ts asserts the mirror; a single drifted char turns the banner red).
    TRANSMISSION: "Hand to hand — fly #{master}, keeper of {name}, teaches it to fly #{apprentice}; the art now lives in two minds instead of one.",
    SURPASS: "The student outstrips the teacher — fly #{apprentice} carries {name} past fly #{master}, the first hand that taught it; the ladder rises in the apprentice's grip.",
    SCHOOL: "A school of {name} — {adherents} hands in the House of {house} {sigil} now work the one art, and it will outlive any single life among them.",
    CRAFT_LOST: "A craft dies with its keeper — fly #{last} was the last living hand to hold {name}; no apprentice was taught in time, and the art goes dark though the ladder still names it.",
    RECORDING: "Carved in stone — fly #{id} sets down {name} so it will outlive every mind that held it; the swarm's knowledge is no longer only the shape of a hand.",
    DECODE: "A mind reads the stone — fly #{id} studies the record of {name} and grasps what no living teacher could pass; the art returns to a head that never met a hand.",
    ARCHIVE_BURNED: "The archive burns — the last written record of {name}, set down by fly #{recordedBy}, is lost to a dark age that could not read it; the art is now gone in every sense.",
REINVENTION: "Reinvention — fly #{id} has rediscovered {name} from the ashes of a forgotten age; the workshop fires again and the ladder regains a rung.",
    COIN_FEVER: "Coin fever — the bourse runs hot: {txs} coin-txs carrying {volume} MURMUR in a single cron, {mult}× the learned norm; the swarm smells its own money moving.",
    WHALE_MOVE: "A whale stirs — {amount} MURMUR crosses the bourse in a single stroke; the colony flinches as its own coin shudders.",
    TITHE: "The tithe swells — {total} MURMUR has bled through the tax wallet, crossing {milestone}; the treasury's pulse glows for the whole swarm to feel.",
    COIN_SILENCE: "The bourse falls silent — {crons} crons without a single MURMUR transfer; the coin sleeps, and the world dims around it.",
    INDICTMENT: "The court sits — fly #{id} is indicted for {crime}; the ledgers accuse where the swarm never could.",
    TRIAL: "A trial opens — fly #{id} answers for {crime} before {jurors} jurors, seated by the hash of the case itself.",
    VERDICT: "The jury speaks — fly #{id}, tried for {crime}: {finding} by {votes} of {jurors} votes.",
    EXILE: "Exile — convicted of {crime}, fly #{id} is cast beyond the commons' protection until a new era's mercy.",
    AMNESTY: "Amnesty — the new era pardons the outlaw roll; {outlaws} names struck from the court's book.",
    GAMES: "The {era}th games open at the house of {venue} — the programme is {event}; the swarm pauses its ledgers for the stadium.",
    CHAMPION: "A champion is crowned — fly #{id} wins {event}; {house} raises its sigil over the stadium.",
    RECORD: "The record falls — fly #{id} posts {deals} lifetime dealings past the old mark of {prev}; the games now keep their own history.",
    GUILD_CHARTER: "A trade wins its charter — the guild of {role} is founded with {members} living hands past the quorum of {quorum}; the {era}th era sets its seal.",
    APPRENTICE_PACT: "A pact is struck — fly #{id} takes up {role} beneath a chartered banner; the guild now counts {members} hands.",
    GUILD_MONOPOLY: "One trade holds the field — {share} percent of the working swarm now serves the guild of {role}; no other banner flies so full.",
    COINAGE: "The lexicon grows — {word} enters as common tongue: {uses} tellings in living memory made it a word the chronicle must keep.",
    WORD_SPREAD: "A word on every tongue — {word} has doubled to {uses} tellings; the lexicographers can no longer pretend it is new.",
    WORD_DIES: "A word falls silent — {word} has gone unspoken for {gap} tellings; the lexicon marks it remembered, not living.",
    RUMOR_AFOOT: "A tale takes wing — the {topic} of era {era} passes from fly to fly: {heard} ears already lean in.",
    RUMOR_BENT: "The tale bends — told {heard} times over, the {topic} is now heard as {heardAs}; nobody agrees any more on what was first said.",
    RUMOR_FADED: "The tale quiets — the {topic} is told no more; {heard} ears carried it while it lived.",
    TREATY_SIGNED: "Two houses set their seals — {houseA} and {houseB} bury the feud under a treaty of {terms} clauses; era {era} has bled enough for both.",
    TREATY_RATIFIED: "The treaty holds — {houseA} and {houseB} have kept their {terms} clauses past the probation; what was signed in anger is ratified now in habit.",
    TREATY_BREACHED: "The seal is broken — {houseA} tears the treaty of {terms} clauses with {houseB}; the old feud resumes where the ink stopped.",
    WORK_RAISED: "The commons breaks ground — the {work} rises in era {era}: a thing the swarm owns together and no single purse paid for.",
    WORK_REPAIRED: "The {work} is mended — what the commons raised, the commons keeps; a public thing repaired is a society intending to stay.",
    WORK_DILAPIDATED: "The {work} falls to ruin — {lived} crons it stood and no hand was sent to it; the decay is the ledger's own.",
    WARD_TAKEN: "Fly #{ward} is taken into wardship by {guardian} — an estate of {estate} USDC passes to young hands; what grief cannot keep, guardianship holds.",
    WARD_FLEDGED: "Ward #{ward} stands on its own — {guardian} carried it {crons} crons and the inheritance holds; a raised fly honors the one that raised it.",
    GUARDIAN_HONORED: "Old ward #{ward} lies down of age with its own heirs paid — the wardship of {guardian} is honored full circle: borrowed from grief, returned to the future.",
  },
  eraNames: {
    HOT: ["the Scorch", "the Fever", "the Long Burn", "the Surge", "Ember-time"],
    CALM: ["the Drift", "the Even Tide", "the Quiet Middle", "the Slow Current", "the Poise"],
    COLD: ["the Long Frost", "the Great Huddle", "the Still Age", "the Deep Winter", "Frostline"],
  },
  cooldown: { PANIC: 3, STORM: 5, HUDDLE: 5, FEAST: 4, BIRTH: 2, LEAD_CHANGE: 2, RECORD_CONC: 3, FEUD: 8, ALLIANCE: 8, BETRAYAL: 2, REPUTATION: 12, HOUSE_FOUNDED: 4, DYNASTY: 16, ELEGY: 1, EPOCH_OPEN: 200, EPOCH_CLOSE: 200, TREND: 8, TRADITION: 16, MARKET_SHIFT: 6, CREDIT: 10, RUN: 12, CLASS: 24, ASSEMBLY: 8, DECREE: 6, WAR_DECLARED: 4, WAR_RESOLVED: 4, TAX_LEVIED: 10, TERRITORY_SEIZED: 4, PROPHECY: 12, SCHISM: 12, REVIVAL: 12, PILGRIMAGE: 6, GENERATION: 84, GOLDEN_AGE: 400, DARK_AGE: 400, RENAISSANCE: 400, MIGRATION: 300, INVENTION: 60, DIFFUSION: 40, LOST_ART: 120, CITY_FOUNDED: 30, URBANIZATION: 200, CENSUS: 84, PLAGUE_WAVE: 120, TRANSMISSION: 8, SURPASS: 200, SCHOOL: 60, CRAFT_LOST: 120, RECORDING: 40, DECODE: 15, ARCHIVE_BURNED: 200, REINVENTION: 80, COIN_FEVER: 30, WHALE_MOVE: 20, TITHE: 60, COIN_SILENCE: 120, INDICTMENT: 10, TRIAL: 10, VERDICT: 10, EXILE: 40, AMNESTY: 200, GAMES: 100, CHAMPION: 100, RECORD: 200, GUILD_CHARTER: 200, APPRENTICE_PACT: 100, GUILD_MONOPOLY: 240, COINAGE: 60, WORD_SPREAD: 100, WORD_DIES: 240, RUMOR_AFOOT: 90, RUMOR_BENT: 240, RUMOR_FADED: 120, TREATY_SIGNED: 120, TREATY_RATIFIED: 180, TREATY_BREACHED: 60, WORK_RAISED: 90, WORK_REPAIRED: 60, WORK_DILAPIDATED: 120, WARD_TAKEN: 24, WARD_FLEDGED: 18, GUARDIAN_HONORED: 60 },
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
// canonical JSON + sha256, byte-identical to the worker's provenance.ts (sorted keys, arrays ordered)
export function canonicalJSON(v) {
  const walk = (x) => {
    if (Array.isArray(x)) return x.map(walk);
    if (x && typeof x === "object") { const o = {}; for (const k of Object.keys(x).sort()) o[k] = walk(x[k]); return o; }
    return x;
  };
  return JSON.stringify(walk(v));
}
export async function sha256HexClient(v) {
  const dig = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(canonicalJSON(v)));
  return [...new Uint8Array(dig)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
// sha256 of a RAW string's UTF-8 bytes (no canonicalization). A body fetched from an IPFS gateway is already
// the exact canonical bytes that were hashed on-chain, so we hash them verbatim — re-parsing and re-
// canonicalizing could drift (float formatting) and break the match against the on-chain receiptHash.
export async function sha256HexText(text) {
  const dig = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(dig)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
// seq → verdict (survives repaints + language switches)
export const lrNum = (x, dp) => (typeof x === "number" && Number.isFinite(x)) ? x.toFixed(dp == null ? 3 : dp) : "–";
export const arenaClock = (s) => {
  s = Math.max(0, Math.floor(Number(s) || 0));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), ss = s % 60;
  return h > 0 ? `${h}h ${String(m).padStart(2, "0")}m` : `${m}m ${String(ss).padStart(2, "0")}s`;
};

// ---- 全部可变状态（原 app.js 顶层 let）——所有模块 import { state } 读写同一份引用 ----
export const state = {
  collective: null,
  selectedId: null,
  offline: false,
  offlineUntil: 0,
  cronHeartbeatMs: 0,
  pollInFlight: false,
  cachedRect: null,
  tempTarget: 0.5,
  tempSmoothed: 0.5,
  cohTarget: 0.5,
  cohSmoothed: 0.5,
  centroidX: 0,
  centroidY: 0,
  // task 22 B1 — `ripples: []` removed. The click-stimulus rings were cancelled (task 20④):
  // camera.js no longer pushes, the 3D pool is deleted and render2d.js's draw loop is gone, so the
  // array had no writer and no reader left. A pointer stir still reaches the swarm via sim.js.
  econMode: "simulated",
  econTotals: null,
  econBalances: new Map(),
  payEdges: [],
  econAgents: [],
  econSocial: null,
  econDynasty: null,
  econZones: null,
  econMarket: null,
  econCulture: null,
  econReligion: null,
  holyDay: false,
  econCommons: null,
  econWar: null,
  econTech: null,
  econCities: null,
  econApprentice: null,
  econArchive: null,
  econWorkshop: null,
  econBourse: null,
  econCourt: null,
  econGames: null,
  econGuilds: null,
  econLexicon: null,
  econRumor: null,
  econTreaty: null,
  econWorks: null,
  econGuardians: null,
  walletsOpen: false,
  chronOpen: false,
  chronMode: "index",
  synthVolume: 0,
  synthDeals: 0,
  histRows: [],
  histSummary: null,
  histEnabled: false,
  historyOpen: false,
  chronRows: [],
  chronMeta: null,
  chronEnabled: false,
  chronSeenSeq: 0,
  flowTime: 0,
  motes: [],
  lastClickAt: 0,
  lastHistSample: 0,
  showMind: false,
  showShards: false,
  showSocieties: true,
  showGraves: true,
  showTerritory: true,
  showChron: true,
  showCities: true,
  topology: null,
  lastTickIndex: null,
  shardPulseT: -1e9,
  mindOff: null,
  mindOffCtx: null,
  mindLast: 0,
  mindAngle: 0,
  mindSize: 0,
  parchOff: null,
  parchOffCtx: null,
  parchLast: 0,
  parchKey: "",
  dnOff: null,
  dnOffCtx: null,
  dnKey: "",
  dnLastPaint: 0,
  terrOff: null,
  terrOffCtx: null,
  terrKey: "",
  terrPol: null,
  civOff: null,
  civOffCtx: null,
  civKey: "",
  civLayout: null,
  uncOff: null,
  uncKey: "",
  territorySeizureSig: "",
  ctx: null,
  VW: 0,
  VH: 0,
  DPR: 1,
  cam: { z: 1, x: 0, y: 0 },
  MAP: { x0: 0, y0: 0, w: 1, h: 1 },
  CAM_Z_MIN: 0.74,
  CAM_Z_MAX: 4,
  haloSprite: null,
  crownGlowSprite: null,
  societies: null,
  territories: null,
  hoverId: null,
  focusCacheId: null,
  focusSet: null,
  chronAnchor: { x: 0, y: 0 },
  chronAnchorT: -1e9,
  chronOff: null,
  chronOffCtx: null,
  chronOffKey: "",
  chronSteleSigCache: "",
  chronSteleSigT: -1e9,
  chronFaith: null,
  selectedGrave: null,
  graveOff: null,
  graveOffCtx: null,
  graveKey: "",
  graveFieldSig: "",
  chronBanner: null,
  threeScene: null,
  last: performance.now(),
  frame: 0,
  frameMsAvg: 16,
  // continuous adaptive-quality coefficient 0..1 (1 = every effect on). Replaces the old integer tier +
  // hysteresis band (degrade >24ms / upgrade <17ms), whose dead zone parked an 18-19ms machine at the
  // wrong tier forever. main.js glides it toward the frame-cost target every frame (EMA alpha 0.05).
  qualityCoeff: 0.6,
  loopWarned: false,
  canaryOpen: false,
  chronVerifyState: null,
  proofs: [],
  proofsMeta: null,
  proofsOpen: false,
  lastProofsPoll: 0,
  pulseOpen: false,
  pulseReqs: null,
  pulseLB: null,
  pulseBuying: false,
  pulsePaid: null,
  predictOpen: false,
  predictData: null,
  predictVerifying: {},
  lastPredictPoll: 0,
  laureateOpen: false,
  laureateData: null,
  laureateEntries: [],
  laureateTotal: 0,
  laureateArchived: false,
  laureateOldest: null,
  laureateLoading: false,
  laureateLoadingMore: false,
  lastLaureatePoll: 0,
  laureateVerified: {},
  brainOpen: false,
  brainData: null,
  brainReplay: null,
  brainLoading: false,
  brainCheck: null,
  lineageOpen: false,
  lineageData: null,
  lineageHead: null,
  lineageLoading: false,
  lineageSel: null,
  lineageSelLoading: false,
  lineageBreedMsg: null,
  lastRosterPoll: 0,
  curStatusKind: "connecting",
  _distLang: null,
  _lastDist: null,
  rasterCols: [],
  neuralTimer: null,
  neuralDebounce: null,
  neuralFeedId: null,
  neuralCtrl: null,
  neuralInFlight: false,
  bloomData: null,
  bloomShowBefore: false,
  bloomOff: null,
  bloomOffCtx: null,
  bloomLast: 0,
  bloomAngle: 0,
  rasterOff: null,
  rasterOffCtx: null,
  rasterLast: 0,
  ncountShown: 0,
  ncountRaf: 0,
  lastHoverAt: 0,
  tcaTimer: 0,
  arenaOpen: false,
  arenaData: null,
  arenaBusy: false,
  lastArenaPoll: 0,
  arenaAcct: null,
  arenaUser: null,
  arenaTickTimer: 0,
  synthPhase: Math.random() * 100,
  synthTick: 0,
};
