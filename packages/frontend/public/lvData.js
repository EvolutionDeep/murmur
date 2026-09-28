// lvData.js — task 29 · Phase B: the DATA layer of the lineage atlas, split out of lineageView.js.
// Bare-imported by lineageView.js (NO ?v cache-buster; _headers forces etag revalidation on /lvData.js).
//
// RESPONSIBILITY
//   Everything that talks to the network or accumulates a client-side table the atlas draws from:
//     • pollLineageView      — the 300 s /lineage?limit=5000 fetch (triple-guarded: mutex + throttle + breaker)
//     • resolveHashes        — the flyId → genomeHash bootstrap (the live ↔ lineage join key)
//     • retireGoneIds        — task 29 · C4: real eviction of a recycled slot's identity stamp
//     • accumulateTrades     — task 29 · C1: /economy.recent + /proofs constituents → trade edges
//     • accumulateSocial     — task 29 · C2: bonds / grudges / chronicle actors[] → social edges + marks
//     • decaySocial          — the 5-min half-life decay of both tables
//     • lvPumpData           — the per-frame drain of the arrival-event dirty flags (replaces the 45 s timer)
//
// NO CYCLES: this module imports lvState.js (the singleton) but never lineageView.js. When new data means
// "the layout must be rebuilt", it calls LV.hooks.rebuild(), which the core registers at module load.
import { state, sim, SOCIETY_BOND_MIN, atomicToUsdc, clamp, sha256HexClient } from './shared.js';
import { getJSON } from './polling.js';
import {
  LV, LINEAGE_POLL_MS, GH_CONCURRENCY, GH_RETIRED_MAX, GH_RETIRED_PER_ID, EDGE_TTL_MS,
  SOCIAL_HALFLIFE_MS, LV_REBUILD_MIN_MS, LV_DIRTY_FEED, LV_DIRTY_SOCIAL, LV_DIRTY_LAYOUT,
  isZeroHash, lvForceRebuild, saveGH, saveSocial,
} from './lvState.js';

// ================= chronicle kind taxonomy (task 29 · C2) =================
// The old reader was 100 % dead code on two independent counts, both verified against a live /annals pull
// (300 entries):
//   (a) it read `r.actorId ?? r.fromId ?? r.a ?? r.buyerId` / `r.targetId ?? …`. NO /annals entry carries
//       any of those fields. What every entry carries is `actors: number[]` (300/300) and `severity` (300/300).
//   (b) two of its six kinds (BETRAYAL, FEUD) are never emitted by the chronicler at all.
// Measured occurrence over that window — actors length histogram {0:192, 1:68, 2:40}:
//   hostile  EXILE(1) TRIAL(1) VERDICT(1) INDICTMENT(1) PANIC(7)              — all 1 or 0 actors
//   positive ALLIANCE(37, all 2 actors) REPUTATION(7) APPRENTICE_PACT(6) HUDDLE(30) FEAST(6)
//   market   MARKET_SHIFT(37) COIN_FEVER(15) WHALE_MOVE(13) TREND(13)         — all 0 actors
// So a single code path cannot serve all three shapes. Each entry is routed by what it actually carries:
//   2 actors (or tokens.a/tokens.b) → a social EDGE       (ALLIANCE today; any hostile pair when it occurs)
//   1 actor                         → a per-node MARK     (EXILE / TRIAL / VERDICT / INDICTMENT / REPUTATION /
//                                                            APPRENTICE_PACT) — drawn as a dashed ring
//   0 actors                        → a colony-wide PULSE (PANIC / HUDDLE / FEAST / all market kinds) —
//                                                            accumulated, decayed, surfaced on __murmurPerf
// Weights scale with `severity` (1…5) instead of being flat, so a chatty severity-2 kind can never out-shout
// a rare severity-4 exile.
const CHRON_HOSTILE = new Set(['EXILE', 'TRIAL', 'VERDICT', 'INDICTMENT', 'PANIC']);
const CHRON_ALLY = new Set(['ALLIANCE', 'REPUTATION', 'APPRENTICE_PACT', 'HUDDLE', 'FEAST']);
const CHRON_MARKET = new Set(['MARKET_SHIFT', 'COIN_FEVER', 'WHALE_MOVE', 'TREND']);
const sevW = (r) => clamp((Number(r && r.severity) || 2) / 5, 0.2, 1);
const CHRON_EDGE_W = 0.30;     // base weight of a 2-actor chronicle edge (× severity)
const CHRON_MARK_W = 0.34;     // base weight of a 1-actor chronicle mark (× severity)
const CHRON_PULSE_W = 0.06;    // base weight of a 0-actor colony pulse (× severity)

/** The two parties of a chronicle row, or null. `actors[]` is authoritative; tokens.a/b is the same pair. */
function chronPair(r) {
  const ac = Array.isArray(r.actors) ? r.actors : null;
  if (ac && ac.length >= 2 && ac[0] != null && ac[1] != null && ac[0] !== ac[1]) return [ac[0], ac[1]];
  const tk = r.tokens;
  if (tk && tk.a != null && tk.b != null && tk.a !== tk.b) return [tk.a, tk.b];
  return null;
}
/** The single subject of a chronicle row, or null. */
function chronSolo(r) {
  const ac = Array.isArray(r.actors) ? r.actors : null;
  if (ac && ac.length >= 1 && ac[0] != null) return ac[0];
  const tk = r.tokens;
  if (tk && tk.id != null) return tk.id;
  return null;
}

// ================= genome-hash resolution (live ↔ lineage join) =================
// /population flies[] carries no genomeHash, so for each unknown live id we fetch /flies/{id}, take
// vitals.genome, and recompute its hash in-browser with the SAME canonicalJSON + sha256 the worker used
// (shared.sha256HexClient) — a byte-identical match against the lineage tree. The genome is lifelong-
// unchanging, so the hash is cached in localStorage keyed by flyId — BUT a flyId is NOT lifelong: the worker
// recycles slots (`this.retired.delete(id); this.roster.push({id, temperament: flyTemperament(genome.seed)})`),
// so the same id can belong to a different individual after a death. task 29 · C4 therefore caches an
// IDENTITY STAMP next to every hash and validates it on each rebuild (see checkStamp).
async function resolveOne(id) {
  if (LV.ghInFlight.has(id)) return false;
  LV.ghInFlight.add(id);
  try {
    const d = await getJSON('/flies/' + id, 6000);
    const v = d && d.vitals;
    const genome = v && v.genome;
    if (genome) {
      const h = (await sha256HexClient(genome)).toLowerCase();
      LV.ghCache.set(id, h);
      LV.ghMeta.set(id, {
        seed: Number.isFinite(v.seed) ? v.seed : null,
        temper: Number.isFinite(v.temperament) ? v.temperament : null,
        at: Date.now(),
      });
      LV.ghStale.delete(id);
      return true;
    }
  } catch { /* best-effort: an unresolved fly stays on the outer holding ring */ }
  finally { LV.ghInFlight.delete(id); }
  return false;
}
export async function resolveHashes() {
  const want = [];
  for (const id of sim.keys()) {
    if (!LV.ghCache.has(id) || LV.ghStale.has(id)) want.push(id);
  }
  if (!want.length) return 0;
  // 6-way concurrent drain
  let i = 0, resolved = 0;
  const worker = async () => { while (i < want.length) { const id = want[i++]; if (await resolveOne(id)) resolved++; } };
  await Promise.all(Array.from({ length: Math.min(GH_CONCURRENCY, want.length) }, worker));
  if (resolved) { saveGH(); lvForceRebuild(); }   // one write for the whole sweep, then re-join the layout
  return resolved;
}

// ---- task 29 · C4: real eviction (the old loop body was empty, so nothing was ever evicted) ----
function retireOne(id) {
  const h = LV.ghCache.get(id);
  const m = LV.ghMeta.get(id);
  LV.ghCache.delete(id); LV.ghMeta.delete(id); LV.ghStale.delete(id);
  if (h) {
    let list = LV.ghRetired.get(id);
    if (!list) { list = []; LV.ghRetired.set(id, list); }
    list.push({ h, temper: m && m.temper != null ? m.temper : null, at: Date.now() });
    if (list.length > GH_RETIRED_PER_ID) list.splice(0, list.length - GH_RETIRED_PER_ID);
  }
}
/**
 * Move the identity stamp of every cached id that has left the living set into the retired table, so
 * (a) a recycled slot refetches instead of inheriting the dead occupant's genome node, and
 * (b) a tombstone can still be joined to the genome node of the individual that was buried in it (C3).
 * Guarded on `state.offline` because the offline synthetic mirror only ever carries 24 ids — retiring on it
 * would wrongly evict the whole live roster.
 */
export function retireGoneIds() {
  if (state.offline || !sim.size || !LV.ghCache.size) return 0;
  let touched = 0;
  for (const id of Array.from(LV.ghCache.keys())) {
    if (sim.has(id)) continue;
    retireOne(id); touched++;
  }
  if (touched) {
    // bound the retired table (FIFO by Map insertion order)
    while (LV.ghRetired.size > GH_RETIRED_MAX) {
      const k = LV.ghRetired.keys().next().value;
      if (k === undefined) break;
      LV.ghRetired.delete(k);
    }
    saveGH();
  }
  return touched;
}
/**
 * task 29 · C4 — validate a cached stamp against the live roster WITHOUT any extra request.
 * The worker derives `temperament` from the individual's genome seed (`flyTemperament(seed)`), and a recycled
 * slot is re-rostered with its offspring's seed, so a temperament mismatch is proof the occupant changed.
 * It is a one-directional test: a mismatch always means "different individual"; a match only means "probably
 * the same" (64/75 temperaments are distinct in production), which is fine because the consequence of a false
 * negative is just that we keep a hash we would have recomputed to the same value anyway.
 * Returns true when the cached hash can be trusted for this rebuild.
 */
export function checkStamp(id, f) {
  if (!LV.ghCache.has(id)) return false;
  const m = LV.ghMeta.get(id);
  if (!m) return true;
  if (m.temper == null) { LV.ghStale.add(id); return true; }        // legacy/migrated entry ⇒ verify once
  const t = f && typeof f.temperament === 'number' ? f.temperament : null;
  if (t == null) return true;                                       // no roster trait to compare against
  if (Math.abs(m.temper - t) > 1e-6) {                              // the slot was recycled
    retireOne(id); LV.ghStale.add(id);
    return false;
  }
  return true;
}
/**
 * task 29 · C4 (root fix, optional) — Phase A may start publishing lineage fields straight on the
 * /population fly row. When they are present we join directly: no /flies request, no cache, no recycling
 * hazard at all. Every field is read defensively so an older worker (or a partially rolled-out one) simply
 * falls through to the /flies/{id} bootstrap — neither shape may crash.
 */
export function adoptRosterLineage(id, f) {
  if (!f) return null;
  const gh = typeof f.genomeHash === 'string' && f.genomeHash ? f.genomeHash.toLowerCase() : null;
  const gen = Number.isFinite(f.generation) ? (f.generation | 0) : null;
  const par = Array.isArray(f.parents) ? f.parents.filter((p) => !isZeroHash(p)).map((p) => String(p).toLowerCase()) : null;
  if (!gh && gen == null && !par) return null;                       // older worker ⇒ nothing to adopt
  if (gh) {
    LV.ghCache.set(id, gh);
    LV.ghMeta.set(id, { seed: Number.isFinite(f.seed) ? f.seed : null, temper: typeof f.temperament === 'number' ? f.temperament : null, at: Date.now(), roster: true });
    LV.ghStale.delete(id);
  }
  return { gh, gen, par };
}

// ================= trade flow (task 29 · C1) =================
function tradeKey(s, tag) { return `${tag}|${s.tick}|${s.fromId}|${s.toId}|${s.resource || s.good || ''}|${s.amount}|${s.txHash || ''}`; }
/**
 * Fold the settlement feeds into the trade-edge budget.
 * task 29 · C1 root cause: the ONLY writer of `state.econRecent` was economy.js's `if (Array.isArray(econ.recent))`
 * inside applyEconomy — but applyEconomy receives `/population`'s `economy` object, whose keys are
 * {lastTick,totals,balances,social,dynasty,zones,culture,…} and contain NO `recent`. The real `recent[48]`
 * lives on the standalone `/economy` endpoint. So `state.econRecent` was permanently null and the whole
 * trade-flow layer ran on /proofs constituents alone. polling.js now writes it from pollRoster.
 */
export function accumulateTrades() {
  let added = 0;
  const feed = (rows, tag) => {
    if (!Array.isArray(rows)) return;
    for (const s of rows) {
      if (!s || s.fromId == null || s.toId == null) continue;
      const k = tradeKey(s, tag);
      if (LV.seenTrades.has(k)) continue;
      LV.seenTrades.add(k);
      if (LV.seenTrades.size > 4000) { const it = LV.seenTrades.values(); for (let i = 0; i < 2000; i++) { const v = it.next().value; if (v === undefined) break; LV.seenTrades.delete(v); } }
      const good = s.good || (typeof s.resource === 'string' ? s.resource.replace(/^net:/, '') : '') || 'signal';
      const ek = `${s.fromId}>${s.toId}>${good}`;
      let e = LV.tradeEdges.get(ek);
      if (!e) { e = { fromId: s.fromId, toId: s.toId, good, amount: 0, t: performance.now(), emitting: false, w: 0.6, col: null }; LV.tradeEdges.set(ek, e); }
      e.amount += atomicToUsdc(s.amount || 0); e.t = performance.now();
      added++;
    }
  };
  feed(state.econRecent, 'rc');
  // /proofs constituents give the un-netted per-trade rows + neural evidence (already polled into state.proofs).
  // Tagged separately from `recent` on purpose: a netted settlement and its constituents are DIFFERENT rows
  // describing the same money, and collapsing their keys would silently drop one of the two readings.
  if (Array.isArray(state.proofs)) {
    for (const p of state.proofs) {
      const c = p && p.receipt && p.receipt.constituents;
      if (!Array.isArray(c)) continue;
      const tag = 'pf' + (p.txHash ? ':' + String(p.txHash).slice(0, 10) : '');
      feed(c, tag);
    }
  }
  // age out cold edges so the particle budget tracks the LIVE flow, not all history
  const now = performance.now();
  for (const [k, e] of LV.tradeEdges) if (now - e.t > EDGE_TTL_MS) LV.tradeEdges.delete(k);
  return added;
}

// ================= social edges + chronicle marks (task 29 · C2) =================
/**
 * @param {number} sign  +1 alliance, −1 antagonism
 * @param {number} weight edge strength
 * @param {boolean} additive true for EVENT feeds (the chronicle — deduped by seq, so each row counts once);
 *   false for LEVEL feeds (bonds/grudges are a re-sent snapshot of the current top-24, so re-adding them
 *   every poll would pin every edge at the ceiling within a minute — take the max instead and let decay
 *   do the work between refreshes).
 */
function bumpSocial(a, b, sign, weight, additive) {
  if (a == null || b == null || a === b) return;
  const k = `${a}>${b}`;
  let e = LV.social.get(k);
  if (!e) { e = { a, b, sign, w: 0, t: Date.now() }; LV.social.set(k, e); }
  e.sign = sign;
  e.w = clamp(additive ? e.w + weight : Math.max(e.w, weight), 0, 1.6);
  e.t = Date.now();
}
function bumpStain(id, sign, weight) {
  if (id == null) return;
  let s = LV.stain.get(id);
  if (!s) { s = { id, sign, w: 0, t: Date.now() }; LV.stain.set(id, s); }
  s.sign = sign; s.w = clamp(s.w + weight, 0, 1.6); s.t = Date.now();
}
export function accumulateSocial() {
  const soc = state.econSocial;
  if (soc && Array.isArray(soc.bonds)) {
    for (const b of soc.bonds) {
      if (!b) continue; const sc = +b.score || 0;
      if (sc >= SOCIETY_BOND_MIN) {
        bumpSocial(b.a ?? b.from ?? b.x, b.b ?? b.to ?? b.y, +1, clamp(sc, 0, 1) * 0.5, false);
        // task 31 · C19 — store trades count for edge width modulation
        const ek = `${b.a ?? b.from ?? b.x}>${b.b ?? b.to ?? b.y}`;
        const entry = LV.social.get(ek);
        if (entry) entry.trades = +b.trades || 0;
      }
    }
  }
  if (soc && Array.isArray(soc.grudges)) {
    for (const g of soc.grudges) if (g) bumpSocial(g.buyerId ?? g.a, g.sellerId ?? g.b, -1, 0.34, false);
  }
  // ---- the chronicle: an EVENT log, so fold each seq in exactly once (state.chronRows is desc by seq) ----
  if (Array.isArray(state.chronRows)) {
    let maxSeq = LV.chronSeq;
    for (const r of state.chronRows) {
      if (!r) continue;
      const seq = Number(r.seq) || 0;
      if (seq <= LV.chronSeq) continue;                 // already folded in on an earlier poll
      if (seq > maxSeq) maxSeq = seq;
      const kind = String(r.kind || '').toUpperCase();
      let sign;
      if (CHRON_HOSTILE.has(kind)) sign = -1;
      else if (CHRON_ALLY.has(kind)) sign = +1;
      else if (CHRON_MARKET.has(kind)) sign = 0;        // colony-wide market mood: never a pair
      else continue;
      const sv = sevW(r);
      if (sign === 0) { LV.colonyPulse.market = clamp(LV.colonyPulse.market + CHRON_PULSE_W * sv, 0, 1.6); continue; }
      const pair = chronPair(r);
      if (pair) { bumpSocial(pair[0], pair[1], sign, CHRON_EDGE_W * sv, true); continue; }
      const solo = chronSolo(r);
      if (solo != null) {
        bumpStain(solo, sign, CHRON_MARK_W * sv);
        if (sign < 0) LV.colonyPulse.foe = clamp(LV.colonyPulse.foe + CHRON_PULSE_W * sv, 0, 1.6);
        else LV.colonyPulse.ally = clamp(LV.colonyPulse.ally + CHRON_PULSE_W * sv, 0, 1.6);
      }
    }
    LV.chronSeq = maxSeq;
  }
  saveSocial();
}
/** Half-life decay of the social table, the chronicle marks and the colony pulse. dtMs is REAL elapsed time. */
export function decaySocial(dtMs) {
  if (!(dtMs > 0)) return;
  const f = Math.pow(0.5, Math.min(dtMs, 60000) / SOCIAL_HALFLIFE_MS);
  for (const [k, e] of LV.social) { e.w *= f; if (e.w < 0.02) LV.social.delete(k); }
  for (const [k, s] of LV.stain) { s.w *= f; if (s.w < 0.02) LV.stain.delete(k); }
  LV.colonyPulse.foe *= f; LV.colonyPulse.ally *= f; LV.colonyPulse.market *= f;
}

// ================= the per-frame data pump (task 29 · C5) =================
/**
 * Drains the arrival-event dirty flags. Replaces the old 45 s catch-all setInterval, which meant a birth or
 * a death took up to 45 s to appear on the atlas. Now:
 *   • /population (≈5 s) and /economy (15 s) and /proofs (30 s) and /annals (25 s) each raise a flag on
 *     arrival (economy.js / polling.js call lvMarkDirty), and
 *   • the layout rebuild is floored at LV_REBUILD_MIN_MS so the placement pass can never become a per-frame
 *     cost, and it only RE-BAKES the static layer when the structural signature moved (lineageView.js).
 * Attribute-only changes (balances, neuromod, FAP) are applied by the rebuild without touching the bake.
 */
export function lvPumpData(now) {
  const d = LV.dirty; LV.dirty = 0;
  if (d & LV_DIRTY_FEED) accumulateTrades();
  if (d & LV_DIRTY_SOCIAL) accumulateSocial();
  if (LV.lastPump) decaySocial(now - LV.lastPump);
  LV.lastPump = now;
  if (d & LV_DIRTY_LAYOUT) LV.layoutDue = true;
  if (LV.layoutDue && (LV.rebuildForced || now - LV.lastRebuild >= LV_REBUILD_MIN_MS)) {
    LV.layoutDue = false; LV.rebuildForced = false; LV.lastRebuild = now;
    retireGoneIds();
    if (typeof LV.hooks.rebuild === 'function') LV.hooks.rebuild();
  }
}

// ================= pollers (triple guard, copied from polling.js) =================
export async function pollLineageView(force) {
  const now = Date.now();
  if (LV.lineageInFlight) return;                                  // in-flight mutex — never overlap
  if (!force && now - state.lvLastLineagePoll < LINEAGE_POLL_MS) return;   // throttle
  if (Date.now() < state.offlineUntil) return;                     // circuit breaker — offline, stay local
  LV.lineageInFlight = true; state.lvLastLineagePoll = now;
  try {
    const d = await getJSON('/lineage?limit=5000', 12000);
    if (d && Array.isArray(d.entries)) {
      state.lvLineage = d;
      await resolveHashes();
      accumulateSocial();
      if (typeof LV.hooks.rebuild === 'function') LV.hooks.rebuild();
      LV.lastRebuild = performance.now();
      // task 39 · A3: clear the cold-start loading indicator once /lineage lands
      const ld = document.getElementById('lv-pb-loading'); if (ld) ld.remove();
    }
  } catch { /* best-effort: the atlas keeps its last tree */ }
  finally { LV.lineageInFlight = false; }
}

/** One-shot seed when the atlas opens: fill every table from whatever is already cached, then rebuild. */
export function lvPrime() {
  LV.dirty = 0; LV.layoutDue = false; LV.rebuildForced = false;
  accumulateTrades(); accumulateSocial(); retireGoneIds();
  if (typeof LV.hooks.rebuild === 'function') LV.hooks.rebuild();
  LV.lastRebuild = performance.now();
}
