// lineageView.js — task 22: the SECOND main canvas (a radial lineage / technical atlas).
// Imported by main.js with ?v= cache-buster (task 75: all local ESM imports now carry ?v=N).
//
// task 29 · Phase B split this file into a bare-ESM module tree. THIS FILE IS NOW THE CORE ONLY:
//   lvState.js       the shared singleton (LV), the camera, the qualityCoeff gate, geometry + localStorage
//   lvData.js        every network fetch and every client-side accumulation table (trades / social / graves
//                    identity stamps), plus lvPumpData — the per-frame drain of the arrival-event dirty flags
//   lvNeural.js      SEAM — Phase C (spike heat band, causal spine, birth/death animation)
//   lvGenetics.js    SEAM — Phase D (genotype space, allele strips, heritability)
//   lvEnv.js         SEAM — Phase E (environment / economy field)
//   lvInteract.js    SEAM — Phase E (wheel-zoom, drag-pan, LOD ladder)
//   lvProvenance.js  SEAM — Phase F (replay scrubber, full chain trail)
// What is left here: the layout (rebuild), the static bake, the frame loop, hit-testing, the focus sidebar
// and the open/close/init lifecycle. The seam modules are wired but inert, so a later phase can add a heavy
// layer WITHOUT touching this file — and without ever risking an import cycle (they all import lvState.js,
// never lineageView.js; lvData reaches the layout through LV.hooks.rebuild).
//
// WHAT IT IS
//   A full-screen 2D canvas (#lineage-field) that is mutually exclusive with the 3D swarm canvas (#field).
//   It lays the whole population out as a radial dendrogram — generation = ring radius, angle = paternal
//   subtree sector — and overlays the technical inner life of the colony: lineage edges (parent → child),
//   live trade-flow particles (payer → payee, coloured by good), social edges (alliance / antagonism, with
//   half-life decay), tombstones for the dead, ancestor nodes for committed genomes that are no longer
//   alive, and an optional shard grid (fliesPerShard = 1 ⇒ shard index ≡ flyId). Clicking a node opens a
//   focus sidebar with that fly's per-layer brain activity, a pseudo-spike raster, a membrane band, its
//   motor → FAP behaviour, its DA/OA neuromodulation and its on-chain genome provenance (trustless verify).
//
// HARD INVARIANT (do not break)
//   #lineage-field is a 2D canvas and #field is the WebGL canvas. They are TWO SEPARATE ELEMENTS: never take
//   a 2D context on #field, never let both be visible (body.lv-active flips the display).
//
// PERFORMANCE CONTRACT (task 22 item 10, extended by task 29 · Phase B step 2)
//   • The static layer (generation rings + labels, lineage edges, ancestor nodes, ghosts, tombstones, shard
//     grid) is baked into an offscreen canvas keyed by `WxH@DPR:structSig:toggles:tempBucket`; it re-bakes
//     ONLY when that signature changes, never per frame. task 29 · C5 made the signature structural rather
//     than a bare node/edge COUNT, because a 12 s rebuild cadence must not imply a 12 s re-bake cadence:
//     attribute-only churn (balances, neuromod, FAP, house) leaves the signature untouched.
//   • Every frame now runs through lvState.LVQ, the qualityCoeff gate main.js has been computing all along.
//     Degradation order is fixed and monotone: halos → particle cap → social edges/marks → trade underlines
//     → DPR. Heavy Phase C-F layers must consult LVQ.tier before drawing.
//   • Each frame draws only: one blit of the static bake + one stroke per EMITTING trade edge (not per
//     particle — task 29 · C1) + ≤240 particle dots + ~75 live nodes + the social table + the highlight.
//     There is NO per-frame traversal of the ~10,361-neuron vectors — the per-layer means and the
//     pseudo-spike raster are reduced ONCE per /snapshot arrival (≤1 Hz), and the neuron-kind → layer index
//     map is parsed once and cached for every fly thereafter.
//   • NO shadowBlur and NO backdrop-filter anywhere in this tree (styles.css is explicit: no glass no blur;
//     shadowBlur was a measured stutter root cause). Text always uses a strokeText halo.
//   • When the view is hidden (state.lineageViewActive === false) main.js never calls lvFrame, and the one
//     remaining timer is stopped on close ⇒ literally zero work.
//
// DATA SOURCES (all re-verified against production for task 29; the notes below are the MEASURED shape)
//   /lineage?limit=5000  → state.lvLineage          139 committed entries, 24 roots, 0 uncommitted parents
//   /flies/{id}          → vitals.genome → sha256    live ↔ lineage join key; 6-way concurrent, cached+stamped
//   /economy             → state.econRecent          recent[48] — NETTED settlement rows (task 29 · C1: this
//                                                   endpoint, NOT /population.economy, which has no `recent`)
//   /proofs              → state.proofs              receipt.constituents — the un-netted per-trade rows
//   /economy.social      → state.econSocial          bonds = alliance top-24; grudges = [] in production
//   /annals              → state.chronRows           actors[] (300/300) + severity (300/300); NO actorId/
//                                                   targetId field exists at all (task 29 · C2)
//   /population          → sim + f.neuromod + f.temperament   membership, balances, DA/OA, identity stamp
//   econDynasty.graves   → state.econDynasty.graves  tombstones; in production 12/12 grave ids are ALREADY
//                                                   recycled, i.e. currently held by a living, unrelated fly
import {
  state, $, sim, graveUid, GOOD_COL, FAP_GLOSS, FAP_ROLE, KIND_COL,
  houseColor, houseOf, nmDaHz, nmOaHz, NM_REF_HZ,
  clamp, mix, rgb, rgba, paletteAt, TAU, INK, GILT, GILT_HI,
  GOLD_THREAD, CRACK_RED, readLineageOnchain, shortHash, isRealAddr, isRealTxHash,
  ARC_EXPLORER, fnv1a, fapColor,
} from './shared.js?v=159';
import { t as T, gl } from './i18n.js?v=112';
import { getJSON } from './polling.js?v=159';
import { derivePseudoSpikes } from './inspector.js?v=159';
import { closeActiveDrawer } from './drawers.js?v=159';
import {
  LV, LVQ, cam, camApply, camIdentity, camToWorld, camLod, camKScale, lvUpdateQuality, lvForceRebuild, lvMarkDirty,
  isZeroHash, nodeR, ringRadius, fanOffset, nodeById, loadGH, loadSocial, lvNodeAlpha, lvFilter,
  LINEAGE_POLL_MS, FOCUS_INTERVAL_MS, FOCUS_DEBOUNCE_MS, lvHitPad, LAYERS,
  EMIT_TAU_MS, EDGE_TTL_MS, LV_DIRTY_FEED, LV_DIRTY_SOCIAL, LV_DIRTY_LAYOUT,
  LV_LAYOUT, LV_HUD, lvHudMeasure, lvRelayoutAll, lvHudObserve,
} from './lvState.js?v=159';
import {
  pollLineageView, lvPumpData, lvPrime, checkStamp, adoptRosterLineage,
} from './lvData.js?v=159';
import {
  lvNeuralFrame, lvNeuralPanelRows, lvGeneticsPanelHTML, lvHasRealSpikes,
  lvTraceStart, lvTraceClear, c8Stop, c13Diff, c13SnapshotPositions,
} from './lvNeural.js?v=159';
import { lvGeneticsPass, lvNodeShape, lvCrossEdges } from './lvGenetics.js?v=159';
import { lvEnvFrame, lvEnvRegimeBucket, lvEnvCyclePnl, lvEnvPnlMode } from './lvEnv.js?v=159';
import { lvProvenanceRows, lvEvidencePanelHTML, lvProvFetchStatus } from './lvProvenance.js?v=159';
import {
  lvInteractFrame, lvInteractBind, lvTradeHitScreen,
  lvBindSearchFilter, lvSearchRelocalise, lvToggleFilters, lvPopulateHouses,
  lvBindMobile, lvMobileSync, lvMobileRelocalise, lvPanelSegment, lvLegendSync,
} from './lvInteract.js?v=159';
// task 33 · C25 — the time-replay seam. All lv* modules carry ?v= (task 75).
// lvTimeReplay only ever imports lvState.js / shared.js / i18n.js / polling.js, never this file, so the edge
// core → lvTimeReplay stays one-way and the module tree stays acyclic.
import {
  lvReplayOn, lvReplayScrubbing, lvReplayEntryBorn, lvReplayTimeBucket,
  lvReplayToggle, lvReplayStop, lvReplayBind, lvReplayRelocalise, lvReplayPerf,
} from './lvTimeReplay.js?v=159';

// ================= canvas sizing =================
function sizeCanvas() {
  if (!LV.cv) return;
  // task 29 · Phase B step 2 — the backing store follows the quality gate's DPR ceiling instead of the raw
  // device DPR, so a machine that cannot hold 60 fps sheds PIXELS (the cheapest thing to give up) before it
  // sheds content. LVQ.dpr is initialised to min(2, devicePixelRatio) and only ever moves on a tier change,
  // which reallocates exactly once (LV.dprDirty), not per frame.
  const dpr = clamp(LVQ.dpr || Math.min(2, window.devicePixelRatio || 1), 0.5, 2);
  const w = window.innerWidth, h = window.innerHeight;
  LV.cv.width = Math.round(w * dpr); LV.cv.height = Math.round(h * dpr);
  LV.cv.style.width = w + 'px'; LV.cv.style.height = h + 'px';
  LV.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  LV.W = w; LV.H = h; LV.DPR = dpr;
  LV.staticKey = '';   // force a re-bake at the new geometry
  // task 42 · P0-B — a viewport change moves BOTH the safe-area solve (r1 depends on W/H and on the measured
  // chrome) and every already-placed node. Re-measure, re-solve and re-place the whole table here so a
  // window drag can never leave a node drawing on its pre-resize ring radius (the old "tree tears into a
  // horizontal band, 30/173 nodes frozen" report).
  lvHudMeasure();
  lvRelayoutAll();
}

// ================= layout: build nodes + edges from the lineage tree + the live swarm + graves =================
// NODE KINDS (task 29 · A4-5 made this taxonomy explicit — three of the four used to collapse into one)
//   'live'      a genome node currently occupied by a living fly, OR a holding-ring node for an unresolved id
//   'ancestor'  a COMMITTED genome (it exists in /lineage) that nobody alive occupies — the real bloodline
//   'tomb'      a committed genome joined to a graves row (C3), or an unjoinable grave on the outer ring
//   'ghost'     + `ghost: true` — a parent hash referenced by an entry but NEVER committed on chain. Purely
//               decorative: nothing to verify, so it is the ONLY kind hit-testing skips.
function rebuild() {
  // task 42 · P0-C — refresh the measured chrome insets + the tree safe area BEFORE anything below reads
  // ringRadius(); a no-op when the signature has not moved (see lvHudMeasure).
  lvHudMeasure();
  c13SnapshotPositions();   // task 30 · C13 — capture pre-rebuild live positions for move interpolation
  const lin = state.lvLineage;
  const entries = (lin && Array.isArray(lin.entries)) ? lin.entries : [];
  const byHash = new Map();
  let maxGen = 0;
  for (const e of entries) {
    if (!e || !e.genomeHash) continue;
    const h = String(e.genomeHash).toLowerCase();
    byHash.set(h, e);
    const g = e.generation | 0; if (g > maxGen) maxGen = g;
  }
  // task 33 · C25 — when the time replay is running the atlas shows the tree AS IT WAS at the cursor, not as
  // it is today: only the genomes born at or before the cursor become nodes. Two deliberate details:
  //   • maxGen still comes from the FULL entry set, so ringRadius(gen, maxGen) is constant while scrubbing.
  //     Existing nodes therefore never move — dragging the cursor is pure growth/shrink, not a re-layout.
  //   • byHash stays full too: pass 0's root test and pass 2's ghost test both need to know that a PARENT
  //     exists in the tree even when that parent has not been born at the cursor yet.
  // A breed always commits the parent before the child, so the born subset can never contain an orphan.
  const rtOn = lvReplayOn();
  const grown = rtOn ? entries.filter((e) => e && e.genomeHash && lvReplayEntryBorn(e)) : entries;
  const sorted = grown.slice().sort((a, b) => (a.generation | 0) - (b.generation | 0));

  // pass 0: roots (no usable paternal parent) get a stable angular sector
  const paternal = (e) => { const p = e && Array.isArray(e.parents) ? e.parents[0] : null; return isZeroHash(p) ? null : String(p).toLowerCase(); };
  // task 33 · C25 — PRUNE what the cursor has un-born. LV.nodes is persistent across rebuilds, so without this
  // a genome node created while the reader was looking at TODAY's full tree would survive every later replay
  // pass: pass 1 only walks `sorted` (so it never resets the node's kind) and pass 3's `LV.nodes.has(h)` guard
  // would then happily re-promote it to 'live' — the replay would keep showing the present population.
  // LV.pos is deliberately KEPT: place() reuses the stored {ang,rad,gen}, so a genome that grows back when the
  // cursor moves forward lands on the exact angle it held before, and childSlot re-counting cannot jitter it.
  // Holding-ring ('id:') nodes are left to pass 3's own GC, and necropolis ('grave:') nodes to pass 4's.
  if (rtOn) {
    const keep = new Set();
    for (const e of grown) {
      keep.add(String(e.genomeHash).toLowerCase());
      const pu = paternal(e);
      if (pu && !byHash.has(pu)) keep.add(pu);   // an uncommitted parent stays a ghost — pass 2's own test
    }
    for (const [uid, n] of LV.nodes) {
      if (!n || (typeof uid === 'string' && (uid.indexOf('id:') === 0 || uid.indexOf('grave:') === 0))) continue;
      if (!keep.has(uid)) LV.nodes.delete(uid);
    }
  }
  const rootUids = sorted.filter((e) => { const p = paternal(e); return !p || !byHash.has(p); }).map((e) => String(e.genomeHash).toLowerCase());
  const rootTotal = Math.max(1, rootUids.length);
  const rootIdx = new Map(); rootUids.forEach((u, i) => rootIdx.set(u, i));

  const cx = LV_LAYOUT.cx || LV.W / 2, cy = LV_LAYOUT.cy || LV.H / 2;
  const childSlot = new Map();
  const place = (uid, gen, ang) => {
    let p = LV.pos.get(uid);
    const rad = ringRadius(gen, maxGen);
    // task 42 · P0-B — only the ANGLE is frozen (that is the incremental-stability contract). rad/gen are
    // pure functions of the viewport and the tree depth, so they are refreshed on EVERY pass: the old code
    // wrote them once at creation, so after a resize ringRadius() returned new values while every stored
    // entry kept the old one and the tree tore into a band of stale radii.
    if (!p) { p = { ang, rad, gen }; LV.pos.set(uid, p); }
    else { p.rad = rad; p.gen = gen; }
    p.x = cx + Math.cos(p.ang) * p.rad; p.y = cy + Math.sin(p.ang) * p.rad;
    return p;
  };

  LV.edges = [];
  // pass 1: every committed lineage entry becomes a node (position assigned once, kept thereafter)
  for (const e of sorted) {
    const uid = String(e.genomeHash).toLowerCase();
    const gen = e.generation | 0;
    const pu = paternal(e);
    let ang;
    if (pu && LV.pos.has(pu)) {
      const slot = childSlot.get(pu) | 0; childSlot.set(pu, slot + 1);
      const gap = clamp(0.95 / (gen * 0.45 + 1), 0.05, 0.95);
      ang = LV.pos.get(pu).ang + fanOffset(slot, gap) + (fnv1a(uid) % 100) / 100 * 0.02;   // tiny deterministic jitter
      LV.edges.push({ a: pu, b: uid });
    } else {
      const ri = rootIdx.has(uid) ? rootIdx.get(uid) : (fnv1a(uid) % rootTotal);
      ang = (ri / rootTotal) * TAU;
      if (pu && !byHash.has(pu)) LV.edges.push({ a: pu, b: uid });   // edge to a ghost (placed in pass 2)
    }
    const p = place(uid, gen, ang);
    let n = LV.nodes.get(uid);
    if (!n) { n = { uid, id: null, gen, kind: 'ancestor', hash: uid, entry: e, grave: null, houseName: '', balN: 0.5, stale: false }; LV.nodes.set(uid, n); }
    // task 29 · A4-5 — a committed genome starts life as an ANCESTOR, not a 'ghost'. The old code labelled it
    // 'ghost' WITHOUT setting the `ghost: true` flag (only pass 2 set that), and then every consumer filtered
    // on one test or the other: the bake's ghost loop checked the flag, the live loop checked the kind. The
    // 64 committed genomes that no living fly occupies therefore rendered as NOTHING and were unclickable.
    // Resetting kind/id/grave every pass also fixes the mirror-image bug: a fly that died since the last
    // rebuild used to keep kind:'live' forever and stayed lit up next to its own tombstone.
    n.kind = 'ancestor'; n.id = null; n.grave = null; n.stale = false;
    n.gen = gen; n.entry = e; n.x = p.x; n.y = p.y; n.ang = p.ang; n.rad = p.rad;
  }

  // pass 2: ghost ancestors — a parent hash referenced by an entry but never committed itself
  for (const e of sorted) {
    const pu = paternal(e);
    if (!pu || byHash.has(pu) || LV.nodes.has(pu)) continue;
    const child = LV.nodes.get(String(e.genomeHash).toLowerCase());
    const gen = Math.max(0, (e.generation | 0) - 1);
    const ang = child ? child.ang : (fnv1a(pu) % 360) / 360 * TAU;
    const p = place(pu, gen, ang);
    LV.nodes.set(pu, { uid: pu, id: null, gen, kind: 'ghost', hash: pu, entry: null, grave: null, houseName: '', balN: 0.5, x: p.x, y: p.y, ang: p.ang, rad: p.rad, ghost: true, stale: false });
  }

  // pass 3: the LIVE swarm — resolve each id to its genome node (or a holding-ring temp node)
  LV.idToUid.clear(); LV.liveCount = 0;
  const holdR = ringRadius(maxGen, maxGen) * 1.04;
  const liveUid = new Set();
  for (const [id, f] of sim) {
    if (f && f.dying) continue;
    // ---- task 29 · C4: identity, in strict preference order ----
    // (1) If the worker publishes lineage fields straight on the roster row (Phase A), join on those: no
    //     request, no cache, and NO recycling hazard at all, because the hash arrives with the individual.
    // (2) Otherwise validate the cached identity stamp against the roster's own `temperament` — the worker
    //     derives it as flyTemperament(genome.seed) and re-rosters a recycled slot with the OFFSPRING's seed,
    //     so a mismatch is proof the occupant changed. Zero extra requests.
    // (3) Otherwise fall through to the /flies/{id} bootstrap (lvData.resolveHashes, run on arrival/poll).
    const adopted = adoptRosterLineage(id, f);
    let h = adopted && adopted.gh ? adopted.gh : null;
    if (!h && checkStamp(id, f)) h = LV.ghCache.get(id) || null;
    // task 33 · C25 — under the replay the atlas is a HISTORICAL tree, not today's swarm: a genome that had
    // not been bred yet at the cursor has no node to occupy, and minting a holding-ring node for it would
    // redraw the whole present population on the outer ring at every cursor position. Skip it instead (and
    // do NOT count it toward liveCount, which the legend prints). The identity work above is unchanged, so
    // the ghCache / ghStale bookkeeping keeps running exactly as before.
    if (rtOn && !(h && LV.nodes.has(h))) continue;
    LV.liveCount++;
    let uid, n;
    if (h && LV.nodes.has(h)) {
      uid = h; n = LV.nodes.get(h); n.kind = 'live'; n.id = id; n.stale = false;
      if (adopted && adopted.gen != null) { n.gen = adopted.gen; const p = LV.pos.get(uid); if (p) { p.gen = n.gen; p.rad = ringRadius(n.gen, maxGen); n.rad = p.rad; n.x = cx + Math.cos(p.ang) * p.rad; n.y = cy + Math.sin(p.ang) * p.rad; } }
    } else {
      uid = 'id:' + id;
      n = LV.nodes.get(uid);
      const ang = ((id * 137.508) % 360) / 360 * TAU;   // golden-angle spread on the holding ring
      if (!n) { const p = place(uid, maxGen, ang); n = { uid, id, gen: maxGen, kind: 'live', hash: (h || null), entry: (h ? byHash.get(h) : null) || null, grave: null, houseName: '', balN: 0.5, x: p.x, y: p.y, ang: p.ang, rad: holdR, stale: false }; LV.nodes.set(uid, n); }
      else { n.kind = 'live'; n.id = id; n.rad = holdR; const p = LV.pos.get(uid); n.x = cx + Math.cos(p.ang) * holdR; n.y = cy + Math.sin(p.ang) * holdR; }
      if (h) LV.ghStale.add(id);   // a cached hash that matches no entry → refetch on the next resolve
    }
    n.stale = LV.ghStale.has(id);
    LV.idToUid.set(id, uid);
    liveUid.add(uid);
    // live node visuals: balance → size, house → ring colour
    const bal = state.econBalances.get(id);
    n.balN = (typeof f.tBalN === 'number') ? f.tBalN : (bal != null ? clamp(bal / 50) : 0.5);
    const ho = houseOf.get(id); n.houseName = ho ? ho.name : '';
    n.neuromod = f.neuromod || null;
    n.fap = f.fap || 'FORAGE'; n.role = f.role || FAP_ROLE[f.fap] || '';
  }
  // garbage-collect holding-ring nodes whose fly is gone: they carry no entry and no ghost flag, so nothing
  // else would ever demote them, and a stale 'live' node is indistinguishable from a real one on screen.
  for (const [uid, n] of LV.nodes) {
    if (!n || n.entry || n.ghost === true) continue;
    if (typeof uid === 'string' && uid.indexOf('id:') === 0 && !liveUid.has(uid)) { LV.nodes.delete(uid); LV.pos.delete(uid); }
  }

  // pass 4: tombstones — the dead keep the position they held in life (faded), tagged with their grave
  // task 29 · C3 — root cause: the old code minted `'grave:' + graveUid(g.id, g.bornTick)` for EVERY grave.
  // That uid namespace can never intersect a genomeHash uid, so the two passes built two disjoint nodes for
  // the same individual and each deceased fly appeared twice: once as an inert genome node inside the tree
  // and again as a cross on the outer necropolis ring. We now join the grave BACK to its genome node and
  // mark that node kind:'tomb', keeping the position it held in life; only a grave we cannot join falls out
  // to the ring.
  //
  // The join is deliberately two-tier, because in production 12/12 grave ids are ALREADY RECYCLED: the id on
  // a grave row is currently held by a living, unrelated fly, and ghCache holds the CURRENT occupant. Reading
  // ghCache unconditionally would erect a tombstone on a living fly — so when the slot is occupied we only
  // consider RETIRED hashes (lvData.retireOne moves an occupant's stamp there the moment it leaves the sim).
  const graves = (state.econDynasty && Array.isArray(state.econDynasty.graves)) ? state.econDynasty.graves : [];
  const seenGrave = new Set();
  LV.tombCount = 0;
  if (rtOn) {
    // task 33 · C25 — a tombstone is a statement about TODAY ("this grave is in the dynasty roll"), which the
    // replay timeline cannot express: a genome that was alive at the cursor but is buried now would wear a
    // cross, and a fly that had not been born yet would occupy an unjoinable necropolis ring node. So under
    // the replay pass 4 is skipped wholesale and any necropolis node left over from a previous pass is
    // dropped; every surviving node keeps the kind pass 1/3 gave it ('ancestor' / 'live').
    for (const [uid] of LV.nodes) {
      if (typeof uid === 'string' && uid.indexOf('grave:') === 0) { LV.nodes.delete(uid); LV.pos.delete(uid); }
    }
  } else {
  for (const g of graves) {
    if (g == null) continue;
    seenGrave.add(g);
    const liveNow = LV.idToUid.has(g.id);
    const cands = [];
    const ret = LV.ghRetired.get(g.id);
    if (Array.isArray(ret)) for (const r of ret) if (r && typeof r.h === 'string' && r.h) cands.push(r.h);
    if (!liveNow) { const hc = LV.ghCache.get(g.id); if (hc) cands.unshift(hc); }
    let n = null;
    for (const hc of cands) {
      const c = LV.nodes.get(hc);
      if (!c || c.ghost === true || c.kind === 'live') continue;   // never bury a living fly
      n = c; break;
    }
    if (n) {
      n.kind = 'tomb'; n.grave = g; n.id = null; n.stale = false;
      n.houseName = g.houseName || n.houseName || '';
      LV.tombCount++;
      continue;
    }
    // unjoinable ⇒ outer necropolis ring (the task-22 behaviour, now the exception rather than the rule)
    const uid = 'grave:' + graveUid(g.id, g.bornTick);
    let t = LV.nodes.get(uid);
    if (!t) {
      const ang = ((g.id * 137.508) % 360) / 360 * TAU;
      const p = place(uid, maxGen, ang);
      p.rad = holdR * 1.02;   // the necropolis ring, not the deepest generation ring
      p.x = cx + Math.cos(p.ang) * p.rad; p.y = cy + Math.sin(p.ang) * p.rad;
      t = { uid, id: g.id, gen: maxGen, kind: 'tomb', hash: null, entry: null, grave: g, houseName: g.houseName || '', balN: 0.3, x: p.x, y: p.y, ang: p.ang, rad: holdR * 1.02, stale: false };
      LV.nodes.set(uid, t);
    } else {
      // task 42 · P0-B — an already-minted necropolis node used to keep the x/y/rad it was born with, so it
      // never followed a resize (this is the second half of the "17 % of nodes do not re-place" report).
      const p = LV.pos.get(uid);
      if (p) {
        p.gen = maxGen; p.rad = holdR * 1.02;
        p.x = cx + Math.cos(p.ang) * p.rad; p.y = cy + Math.sin(p.ang) * p.rad;
        t.ang = p.ang; t.rad = p.rad; t.x = p.x; t.y = p.y;
      }
    }
    t.grave = g; t.houseName = g.houseName || t.houseName || '';
    LV.tombCount++;
  }
  // drop necropolis nodes whose grave has left the dynasty roll (the roll is capped, so old graves rotate out)
  for (const [uid, n] of LV.nodes) {
    if (typeof uid === 'string' && uid.indexOf('grave:') === 0 && (!n.grave || !seenGrave.has(n.grave))) { LV.nodes.delete(uid); LV.pos.delete(uid); }
  }
  }   // task 33 · C25 — end of the !rtOn branch (see the tombstone note above)

  // ---- counters + the structural signature (task 29 · C3 / C5) ----
  let anc = 0;
  for (const n of LV.nodes.values()) if (n.kind === 'ancestor') anc++;
  LV.ancCount = anc;
  LV.maxGen = maxGen;
  LV.nodeCount = LV.nodes.size; LV.edgeCount = LV.edges.length;
  LV.staleCount = LV.ghStale.size;
  // task 30 · Phase C — the genetics pass now runs BEFORE the signature so the operator shape (C9) and the
  // cross-edge set are folded into structSig. It annotates nodes but never moves them.
  lvGeneticsPass();

  // The bake gate must be STRUCTURAL, not a count. With the rebuild now arrival-driven and floored at 12 s,
  // a count-only signature would (a) re-bake 139 bezier edges + 24 rings on every balance tick if it were
  // loosened, or (b) keep serving a stale bake when a node's KIND flips (ancestor → live → tomb) without its
  // count changing — which is exactly the C3 failure mode. fnv1a is folded ADDITIVELY so the signature is
  // independent of Map insertion order (a re-insert must not look like a structural change).
  // task 30 · C9 — the operator shape and the cross-edge set are now bake geometry, so both fold in too
  // (still additive fnv1a, still order-independent).
  let sig = 0;
  for (const n of LV.nodes.values()) {
    const extra = n.kind === 'tomb' ? (n.houseName || '') : '';   // the tomb glyph is house-tinted IN the bake
    const shp = lvNodeShape(n.uid);
    sig = (sig + fnv1a(`${n.uid}|${n.kind}|${n.gen}|${n.ghost === true ? 1 : 0}|${shp}|${extra}`)) >>> 0;
  }
  for (const e of LV.edges) sig = (sig + fnv1a(`${e.a}>${e.b}`)) >>> 0;
  for (const e of lvCrossEdges()) sig = (sig + fnv1a(`x${e.a}>${e.b}`)) >>> 0;
  LV.structSig = sig.toString(36);

  c13Diff();   // task 30 · C13 — diff membership → spawn enter/exit/move transitions (final positions set)
}
// lvData reaches the layout through this hook instead of importing this module (which would close a cycle).
LV.hooks.rebuild = rebuild;

// ================= static bake (generation rings + lineage edges + ancestors + ghosts + tombstones + shards) =================
// The palette follows state.tempSmoothed, which glides continuously. Folding the raw value into the signature
// would re-bake every frame, and folding nothing would freeze the tint forever (the old code got away with it
// only because it re-baked unconditionally on a 45 s timer). A 10-step bucket is the compromise: the paper and
// accent tint visibly track the season, and the bake still runs a handful of times per minute at most.
function tempBucket() { return Math.round(clamp(state.tempSmoothed, 0, 1) * 10); }
function bakeSignature() {
  // task 32 · Phase E — the camera and the filter are bake GEOMETRY now, so both fold into the signature as
  // APPENDED buckets (the string-concat body above is untouched, per the seam contract). `:k` is the zoom
  // resolution bucket (camKScale, quantised to 0.25 so it only moves on a real bucket crossing), `:lod` is the
  // level-of-detail tier (which baked layers are present), `:flt` is the search/filter signature (dimming).
  // task 33 · C25 — the replay timeline folds in as ONE MORE APPENDED bucket, per the Phase E seam contract
  // (the body of the concat above is untouched). `:rt` is the KEY-FRAME INDEX the cursor currently sits in,
  // or -1 when the replay is off. Membership is gated by that same quantised index, so dragging inside one
  // 100-cron bucket leaves the signature byte-identical: no re-bake. Folding the CONTINUOUS cursor value in
  // would re-bake on every rAF frame — exactly the failure mode tempBucket() exists to avoid.
  return `${LV.W}x${LV.H}@${LV.DPR.toFixed(2)}:${LV.structSig}:s${LV.showShards ? 1 : 0}:t${tempBucket()}:r${lvEnvRegimeBucket()}`
    + `:k${camKScale().toFixed(2)}:lod${camLod()}:flt${lvFilter.sig}`
    + `:rt${lvReplayTimeBucket()}`
    // task 42 · P0-C — ONE MORE APPENDED bucket, per the Phase E seam contract. The safe-area radius now
    // depends on the measured chrome (toolbar wrap, provenance-bar height, legend fold, inspector panel),
    // none of which changes W×H: without this bucket a legend fold would leave the rings baked at the old
    // radius. Quantised to whole px so a sub-pixel wobble cannot re-bake.
    + `:c${LV_LAYOUT.cx | 0},${LV_LAYOUT.cy | 0},${LV_LAYOUT.r1 | 0}`;
}
// task 30 · C9 — draw a committed node in the shape its breed operator dictates: genesis = square (a fresh
// root), mutate = circle (the default), cross = diamond (a recombination of two parents). Falls back to a
// circle when lvGeneticsPass has not populated the shape map (e.g. LVQ tier 3, where the pass is skipped).
function bakeNodeShape(x, n, r, fill, stroke, lw) {
  const shp = lvNodeShape(n.uid);
  x.fillStyle = fill; x.strokeStyle = stroke; x.lineWidth = lw;
  if (shp === 'square') {
    x.beginPath(); x.rect(n.x - r, n.y - r, r * 2, r * 2); x.fill(); x.stroke();
  } else if (shp === 'diamond') {
    const d = r * 1.25;
    x.beginPath(); x.moveTo(n.x, n.y - d); x.lineTo(n.x + d, n.y); x.lineTo(n.x, n.y + d); x.lineTo(n.x - d, n.y); x.closePath(); x.fill(); x.stroke();
  } else {
    x.beginPath(); x.arc(n.x, n.y, r, 0, TAU); x.fill();
    x.beginPath(); x.arc(n.x, n.y, r + 0.4, 0, TAU); x.stroke();
  }
}
function bakeStatic() {
  const sig = bakeSignature();
  if (LV.staticKey === sig && LV.staticOff) return;   // unchanged → keep the cached bake
  if (!LV.staticOff) { LV.staticOff = document.createElement('canvas'); LV.staticCtx = LV.staticOff.getContext('2d'); }
  const off = LV.staticOff, x = LV.staticCtx;
  // task 32 · Phase E — bake at DPR × camKScale() (option (a) for the zoom-aliasing trap): a zoomed-in blit
  // is then ~1:1 device pixels instead of an upscale of a 1× backing store. The scale is bucketed + capped by
  // a pixel budget (see lvState.camKScale). The offscreen is in WORLD units (0..W, 0..H) so a pan needs no
  // re-bake — camApply's translate slides it for free; only a zoom bucket crossing or an LOD/filter change does.
  const ks = camKScale(), lod = camLod();
  off.width = Math.round(LV.W * LV.DPR * ks); off.height = Math.round(LV.H * LV.DPR * ks);
  x.setTransform(LV.DPR * ks, 0, 0, LV.DPR * ks, 0, 0);
  x.clearRect(0, 0, LV.W, LV.H);
  const cx = LV.W / 2, cy = LV.H / 2, maxGen = LV.maxGen;
  const pal = paletteAt(state.tempSmoothed);

  // ---- optional shard grid (fliesPerShard = 1 ⇒ shard index ≡ flyId): a faint cell per shard, tinted when live ----
  if (LV.showShards) {
    const cols = Math.ceil(Math.sqrt(Math.max(8, sim.size || 24)));
    const cell = Math.min(LV.W, LV.H) * 0.9 / cols;
    const ox = cx - (cols * cell) / 2, oy = cy - (cols * cell) / 2;
    x.lineWidth = 0.5;
    for (let i = 0; i < cols * cols; i++) {
      const gx = ox + (i % cols) * cell, gy = oy + Math.floor(i / cols) * cell;
      const f = sim.get(i);
      x.strokeStyle = rgba(mix(INK, pal.paper, 0.7), 0.18);
      x.strokeRect(gx, gy, cell, cell);
      if (f && !f.dying) {
        const ho = houseOf.get(i); const hc = ho ? houseColor(ho.name) : GILT;
        x.fillStyle = rgba(hc || GILT, 0.16); x.fillRect(gx + 1, gy + 1, cell - 2, cell - 2);
        // label with a strokeText halo — shadowBlur is banned across this tree
        if (cell > 16) {
          x.font = '7px monospace'; x.lineWidth = 2;
          x.strokeStyle = rgba(pal.paper, 0.85); x.strokeText(String(i), gx + 2, gy + 8);
          x.fillStyle = rgba(INK, 0.4); x.fillText(String(i), gx + 2, gy + 8);
        }
      }
    }
  }

  // ---- generation rings + labels ----
  x.lineWidth = 1;
  for (let g = 0; g <= maxGen; g++) {
    const r = ringRadius(g, maxGen);
    x.strokeStyle = g % 5 === 0 ? rgba(mix(INK, pal.paper, 0.35), 0.32) : rgba(mix(INK, pal.paper, 0.6), 0.14);
    x.beginPath(); x.arc(cx, cy, r, 0, TAU); x.stroke();
    if (g % 5 === 0 || g === maxGen) {
      const lb = T('lv.gen', { n: g });
      x.font = '9px "IBM Plex Mono", monospace'; x.lineWidth = 2.5;
      x.strokeStyle = rgba(pal.paper, 0.8); x.strokeText(lb, cx + 3, cy - r + 10);
      x.fillStyle = rgba(INK, 0.42); x.fillText(lb, cx + 3, cy - r + 10);
    }
  }

  // ---- lineage edges (parent → child): a faint gold thread up the dendrogram ----
  // task 32 · Phase E LOD: shed at lod0 (far / point-cloud) — the threads only read from the mid view in.
  if (lod >= 1) {
  x.lineWidth = 0.8;
  for (const e of LV.edges) {
    const a = LV.nodes.get(e.a), b = LV.nodes.get(e.b);
    if (!a || !b) continue;
    // three tiers, not two: an edge into a never-committed hash is the faintest, an edge into a committed but
    // deceased ancestor is mid, and an edge between two nodes that are (or were) real flies is the strongest.
    const al = (a.ghost === true || b.ghost === true) ? 0.10
      : (a.kind === 'ancestor' || b.kind === 'ancestor') ? 0.18 : 0.28;
    x.strokeStyle = rgba(GOLD_THREAD, al);
    x.beginPath(); x.moveTo(a.x, a.y);
    const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
    x.quadraticCurveTo(mx + (cy - my) * 0.06, my + (mx - cx) * 0.06, b.x, b.y);
    x.stroke();
  }
  }

  // ---- task 30 · C9: cross (recombination) edges — the SECOND parent link of a `cross` offspring. Dashed and
  //      violet so it reads apart from the paternal gold thread. Baked (static), never re-stroked per frame. ----
  const xedges = lvCrossEdges();
  if (lod >= 1 && xedges.length) {
    x.lineWidth = 0.9; x.setLineDash([4, 3]);
    x.strokeStyle = rgba([160, 100, 180], 0.30);
    for (const e of xedges) {
      const a = LV.nodes.get(e.a), b = LV.nodes.get(e.b);
      if (!a || !b) continue;
      const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
      x.beginPath(); x.moveTo(a.x, a.y);
      x.quadraticCurveTo(mx + (b.y - a.y) * 0.1, my - (b.x - a.x) * 0.1, b.x, b.y);
      x.stroke();
    }
    x.setLineDash([]);
  }

  // ---- committed ancestors (task 29 · A4-5): a dim GOLD DISC on their own generation ----
  // These 64 of 139 committed genomes used to be drawn by nobody at all. A solid disc (not the hollow ring
  // below) says "this is a real individual that was committed on chain and has since died", which is exactly
  // the distinction a hollow ring cannot carry — and it keeps them visually separate from both the house-
  // coloured live bodies and the never-committed ghosts.
  for (const n of LV.nodes.values()) {
    if (n.kind !== 'ancestor') continue;
    const fa = lvNodeAlpha(n); if (fa < 1) x.globalAlpha = fa;   // task 32 · C24 — filtered-out ancestors dim to 0.06
    if (lod === 0) { x.fillStyle = rgba(GILT, 0.4); x.beginPath(); x.arc(n.x, n.y, 1.4, 0, TAU); x.fill(); }
    // task 30 · C9 — operator-differentiated shape (genesis=square / mutate=circle / cross=diamond)
    else bakeNodeShape(x, n, nodeR(n), rgba(GILT, 0.30), rgba(mix(GILT, INK, 0.35), 0.34), 0.7);
    if (fa < 1) x.globalAlpha = 1;
  }

  // ---- true ghosts (a parent hash never committed itself): a small hollow ring ----
  // Measured at 0 occurrences in production today (every referenced parent is itself a committed entry), but
  // the shape is reachable the moment a breed commits a child before its parent, so the glyph stays. It is no
  // longer in the LEGEND — see renderLegend / task 29 · A4-6.
  for (const n of LV.nodes.values()) {
    if (n.ghost !== true) continue;
    if (lod === 0) continue;   // task 32 · Phase E LOD: ghosts are decorative — shed at the far point-cloud view
    const fa = lvNodeAlpha(n); if (fa < 1) x.globalAlpha = fa;
    x.strokeStyle = rgba(mix(INK, pal.paper, 0.3), 0.4); x.lineWidth = 0.9;
    x.beginPath(); x.arc(n.x, n.y, nodeR(n), 0, TAU); x.stroke();
    if (fa < 1) x.globalAlpha = 1;
  }

  // ---- tombstones: a faded marker that keeps the position the individual held in life ----
  for (const n of LV.nodes.values()) {
    if (n.kind !== 'tomb') continue;
    const hc = houseColor(n.houseName) || mix(INK, pal.paper, 0.4);
    const fa = lvNodeAlpha(n); if (fa < 1) x.globalAlpha = fa;
    if (lod === 0) { x.fillStyle = rgba(hc, 0.3); x.beginPath(); x.arc(n.x, n.y, 1.4, 0, TAU); x.fill(); }
    else {
      x.strokeStyle = rgba(hc, 0.34); x.lineWidth = 1;
      x.beginPath(); x.moveTo(n.x - 2.6, n.y + 2.6); x.lineTo(n.x + 2.6, n.y - 2.6);
      x.moveTo(n.x + 2.6, n.y + 2.6); x.lineTo(n.x - 2.6, n.y - 2.6); x.stroke();
      x.fillStyle = rgba(hc, 0.16); x.beginPath(); x.arc(n.x, n.y, nodeR(n), 0, TAU); x.fill();
    }
    if (fa < 1) x.globalAlpha = 1;
  }
  LV.staticKey = sig;
  LV.rebakes++;
}

// ================= trade flow (task 29 · C1) =================
// Accumulation itself lives in lvData.accumulateTrades and is now ARRIVAL-DRIVEN: polling.js raises
// LV_DIRTY_FEED when /economy (15 s) or /proofs (30 s) lands, and lvPumpData folds it in on the next frame.
// The old 45 s setInterval is gone — it both delayed a settlement by up to 45 s and, worse, refilled the
// edge table only once per 45 s while emission was gated to a 6 s window after each refill (≈13 % duty).
function spawnParticles(now) {
  if (!LV.showTrade) return;
  const cap = LVQ.partCap;
  let budget = cap - LV.parts.length;
  if (budget <= 0) return;
  // Normalise the per-edge probability by the number of routes still inside the emission envelope, so the
  // frame spawns ≈1.1 particles in total whether there are 3 live routes or 60 — the cap becomes a real
  // budget instead of a coin flip. Emission then decays exponentially with the edge's age over the whole
  // EDGE_TTL_MS lifetime rather than cutting off at 6 s: a route keeps visibly flowing for minutes and fades
  // out instead of popping, and the duty cycle goes from ~13 % to 100 %.
  let live = 0;
  for (const e of LV.tradeEdges.values()) if (now - e.t <= EDGE_TTL_MS) live++;
  if (!live) return;
  const base = clamp(1.1 / live, 0.015, 0.45);
  for (const e of LV.tradeEdges.values()) {
    if (budget <= 0) return;
    const age = now - e.t;
    if (age > EDGE_TTL_MS) continue;
    if (Math.random() > base * Math.exp(-age / EMIT_TAU_MS)) continue;
    const a = nodeById(e.fromId), b = nodeById(e.toId);
    if (!a || !b) continue;
    // Arc geometry is computed ONCE per edge and cached on it. Nodes only move on a rebuild, so the key is
    // just the two endpoints; this is what lets the frame loop stop re-stroking the same bezier per particle.
    const gk = a.x + ',' + a.y + ',' + b.x + ',' + b.y;
    if (!e.geo || e.geoKey !== gk) {
      const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
      e.geo = { ax: a.x, ay: a.y, bx: b.x, by: b.y, cx: mx + (LV.H / 2 - my) * 0.14, cy: my + (mx - LV.W / 2) * 0.14 };
      e.geoKey = gk;
    }
    LV.parts.push({
      g: e.geo, p: 0, sp: 0.006 + Math.random() * 0.006,
      col: GOOD_COL[e.good] || GOOD_COL.signal || GILT,
      w: clamp(0.6 + e.amount * 0.5, 0.6, 3.4),
    });
    budget--;
  }
}
function bezier(g, t) {
  const u = 1 - t;
  return { x: u * u * g.ax + 2 * u * t * g.cx + t * t * g.bx, y: u * u * g.ay + 2 * u * t * g.cy + t * t * g.by };
}

// ================= per-frame draw =================
export function lvFrame(now) {
  if (!LV.active || !LV.ctx) return;
  const x = LV.ctx;

  // ---- task 32 · Phase E: advance the camera FIRST (gestures, flick inertia, search flight, settle) ----
  // lvInteractFrame only MUTATES cam + resolves LV.lod / LV.interacting; it never draws, so running it here
  // (before camApply) cannot miss the camera transform. Everything below reads the settled LV.lod for the
  // frame. When the view is hidden main.js never calls lvFrame, so the camera does zero work off-stage.
  lvInteractFrame(now);
  // task 33 · C25 — dragging the replay scrubber IS a gesture, in every sense that matters to the bake: the
  // offscreen was baked for the pre-drag membership set, so blitting it mid-drag would show a tree that no
  // longer matches the cursor. Forcing lod0 drops the frame to the point-cloud skeleton (which is exactly
  // what lvInteractFrame does for a pan/pinch) and switches off every `lod >= 1` heavy layer below without
  // having to touch a single one of their guards. Releasing the scrubber restores lod from camLod() and the
  // next frame re-bakes crisp ONCE at the target time bucket.
  const rtScrub = lvReplayScrubbing();
  const lod = rtScrub ? 0 : LV.lod;
  if (rtScrub) LV.lod = 0;

  // ---- quality gate (task 29 · Phase B step 2) ----
  // Re-evaluated every 12 frames: the coefficient is an EMA, so it cannot move meaningfully faster than that,
  // and lvUpdateQuality carries its own 20-frame hysteresis so a single slow frame never reallocates the
  // backing store. When the DPR ceiling DOES move we resize exactly once, on the next frame.
  LV.qFrame = (LV.qFrame + 1) % 12;
  if (LV.qFrame === 0) lvUpdateQuality();
  if (LV.dprDirty) { LV.dprDirty = false; sizeCanvas(); }

  // ---- task 42 · P0-C: drain the chrome ResizeObserver flag BEFORE the pump/bake ----
  // A legend fold, a language switch (the toolbar re-wraps and the provenance bar changes height) or an
  // inspector-panel open all move the safe area without moving W/H. lvHudMeasure() is signature-gated, so
  // this is a no-op on the frames where nothing actually changed; when it does change, lvRelayoutAll()
  // re-places every node and drops the static key so the very next bakeStatic() below redraws the rings.
  if (LV.hudDirty) { LV.hudDirty = false; if (lvHudMeasure()) lvRelayoutAll(); }

  // ---- data pump: drains the arrival flags, decays the social table, runs the throttled rebuild ----
  lvPumpData(now);
  // task 32 · Phase E — never re-bake mid-gesture: the offscreen is only reallocated once the drag/pinch/zoom
  // settles (lvInteractFrame clears LV.staticKey then), so a zoom never reallocates the backing store in flight.
  if (!LV.interacting && !rtScrub) bakeStatic();

  // ---- screen space: clear + parchment wash so the atlas sits on the same paper as the 3D field ----
  camIdentity(x);
  x.clearRect(0, 0, LV.W, LV.H);
  const pal = paletteAt(state.tempSmoothed);
  x.fillStyle = rgb(pal.paper); x.fillRect(0, 0, LV.W, LV.H);

  // ---- world space: one transform for EVERY draw call from here on (task 29 · Phase B step 2) ----
  // task 32 · Phase E — cam is live now (wheel/pinch/drag write it). Mid-gesture we SKIP the static blit and
  // draw a cheap point cloud instead: the cached offscreen was baked at the pre-gesture zoom bucket, so
  // blitting it under a changed cam.k would upscale it into exactly the aliasing Owen flagged. On settle
  // (lvInteractFrame clears LV.interacting + LV.staticKey) the next frame re-bakes crisp at the new bucket.
  camApply(x);
  if (LV.interacting || rtScrub) lvPointCloud(x, pal);
  else if (LV.staticOff) x.drawImage(LV.staticOff, 0, 0, LV.W, LV.H);

  // task 32 · Phase E — the environment field is a heavy per-frame layer: only from the mid view in, never
  // mid-gesture (it carries its own LVQ.tier gate inside lvEnvFrame too).
  if (!LV.interacting && lod >= 1) lvEnvFrame(x, now);

  // ---- social edges (dynamic: they decay) — shed at tier ≥ 2, and at lod0 / mid-gesture (task 32 · Phase E) ----
  if (!LV.interacting && lod >= 1 && LV.showSocial && LVQ.social) {
    let drawn = 0;
    for (const e of LV.social.values()) {
      const a = nodeById(e.a), b = nodeById(e.b);
      if (!a || !b) continue;
      const al = clamp(e.w, 0, 1) * 0.5;
      if (al < 0.02) continue;
      // task 31 · C19 — edge width modulated by bonds.trades (log scale, 1–3.5px)
      x.lineWidth = e.trades ? clamp(1 + Math.log10(1 + e.trades) * 0.9, 1, 3.5) : 1;
      x.strokeStyle = e.sign < 0 ? rgba(CRACK_RED, al) : rgba([120, 154, 96], al);
      if (e.sign < 0) x.setLineDash([3, 3]); else x.setLineDash([]);
      x.beginPath(); x.moveTo(a.x, a.y); x.lineTo(b.x, b.y); x.stroke();
      drawn++;
    }
    x.setLineDash([]);
    LV.socialCount = drawn;
  } else LV.socialCount = 0;

  // ---- chronicle marks (task 29 · C2) — a single-actor event leaves a dashed ring on the node ----
  // /annals measured over 300 rows: actors length {0:192, 1:68, 2:40}. Only ALLIANCE reliably carries a
  // PAIR, so a pair-only reader would still leave every hostile kind (EXILE / TRIAL / VERDICT / INDICTMENT /
  // PANIC) as dead code — the exact bug class C2 exists to fix. One-actor rows therefore land here instead.
  if (!LV.interacting && lod >= 1 && LV.showSocial && LVQ.marks && LV.stain.size) {
    x.lineWidth = 1;
    let m = 0;
    for (const s of LV.stain.values()) {
      const n = nodeById(s.id);
      if (!n) continue;
      const al = clamp(s.w, 0, 1) * 0.55;
      if (al < 0.03) continue;
      x.strokeStyle = s.sign < 0 ? rgba(CRACK_RED, al) : rgba(GILT_HI, al);
      x.setLineDash([2, 2.5]);
      x.beginPath(); x.arc(n.x, n.y, nodeR(n) + 3.2, 0, TAU); x.stroke();
      m++;
    }
    x.setLineDash([]);
    LV.stainCount = m;
  } else LV.stainCount = 0;

  // ---- colony pulse: the ZERO-actor chronicle weight (PANIC / HUDDLE / FEAST / all market kinds) has no
  // pair to draw an edge between and no subject to mark, so it is rendered as one faint rim stroke outside
  // the last generation ring. One arc per frame; the colour is whichever mood currently dominates. ----
  if (!LV.interacting && lod >= 1 && LV.showSocial && LVQ.social) {
    const cp = LV.colonyPulse;
    const pulse = Math.max(cp.foe, cp.ally, cp.market);
    if (pulse > 0.02) {
      const col = (cp.foe >= cp.ally && cp.foe >= cp.market) ? CRACK_RED
        : (cp.ally >= cp.market ? [120, 154, 96] : GILT);
      x.strokeStyle = rgba(col, clamp(pulse, 0, 1) * 0.30); x.lineWidth = 2;
      x.beginPath(); x.arc(LV.W / 2, LV.H / 2, ringRadius(LV.maxGen, LV.maxGen) * 1.10, 0, TAU); x.stroke();
    }
  }

  // ---- trade-flow arcs (underline) + particles — task 32 · Phase E: shed wholesale at lod0 / mid-gesture ----
  if (!LV.interacting && lod >= 1) {
  if (LV.showTrade) {
    // task 29 · C1 (perf): the old loop re-stroked the SAME bezier once per particle per frame — with a full
    // 240-particle budget that is 240 identical path builds for maybe 20 distinct routes, the single largest
    // per-frame cost in the file. The underline is now drawn once per EMITTING edge, skipped entirely below
    // a visible-alpha threshold, and shed wholesale at tier 3.
    if (LVQ.underlines) {
      for (const e of LV.tradeEdges.values()) {
        if (!e.geo) continue;
        const age = now - e.t;
        if (age > EDGE_TTL_MS) continue;
        const al = 0.13 * Math.exp(-age / EMIT_TAU_MS);
        if (al < 0.012) continue;                 // under the visible floor — do not build the path at all
        x.strokeStyle = rgba(GOOD_COL[e.good] || GOOD_COL.signal || GILT, al);
        x.lineWidth = clamp(0.6 + e.amount * 0.5, 0.6, 3.4);
        x.beginPath(); x.moveTo(e.geo.ax, e.geo.ay); x.quadraticCurveTo(e.geo.cx, e.geo.cy, e.geo.bx, e.geo.by); x.stroke();
      }
    }
    spawnParticles(now);
    for (let i = LV.parts.length - 1; i >= 0; i--) {
      const pt = LV.parts[i]; pt.p += pt.sp;
      if (pt.p >= 1) { LV.parts.splice(i, 1); continue; }
      const q = bezier(pt.g, pt.p);
      x.fillStyle = rgba(pt.col, 0.85);
      x.beginPath(); x.arc(q.x, q.y, pt.w * 0.9 + 0.6, 0, TAU); x.fill();
    }
    LV.partCount = LV.parts.length;
  } else { LV.parts.length = 0; LV.partCount = 0; }
  }

  // ---- live nodes (size ∝ balance, ring = house, ambient pulse = the fly's own DA/OA) ----
  // task 32 · Phase E LOD ladder: lod0 = a plain dot (the point-cloud view, also the mid-gesture path); lod1 =
  // body + house ring; lod2 = + neuromod halo + a FAP-tinted motor-channel ring + a #id/house/gen/FAP label.
  // The search/filter dim (lvNodeAlpha) is applied at EVERY level so a filtered-out fly keeps its place at 0.06α.
  for (const n of LV.nodes.values()) {
    if (n.kind !== 'live') continue;
    // task 30 · C13 — while a birth/death/move transition is running, draw at the interpolated position so the
    // node glides instead of teleporting. _ax/_ay are advanced once per frame by lvNeuralFrame → c13Advance.
    const px = (n.animating && n._ax != null) ? n._ax : n.x;
    const py = (n.animating && n._ay != null) ? n._ay : n.y;
    const r = nodeR(n);
    const hc = houseColor(n.houseName) || GILT;
    const fa = lvNodeAlpha(n);
    if (fa < 1) x.globalAlpha = fa;
    if (lod === 0) {
      // far / mid-gesture point cloud: a single house-tinted dot, no ring, no halo, no label
      x.fillStyle = rgba(hc, 0.7);
      x.beginPath(); x.arc(px, py, Math.max(1.3, r * 0.5), 0, TAU); x.fill();
    } else {
      const da = nmDaHz(n.neuromod), oa = nmOaHz(n.neuromod);
      const pulse = 0.5 + 0.5 * Math.sin(now * 0.0022 + (n.id || 0) * 0.7);
      const glow = clamp(da / NM_REF_HZ, 0, 1);
      // neuromod halo (DA warm, OA cool) — the fly's "thinking" ambient. Near-view only (lod2) AND the first
      // thing the quality gate sheds (LVQ.halo, tier ≥ 1): one extra filled arc per live node per frame.
      if (lod >= 2 && LVQ.halo && glow > 0.02) {
        x.fillStyle = rgba(mix([200, 120, 40], [80, 140, 200], clamp(oa / NM_REF_HZ, 0, 1)), 0.10 + glow * 0.18 * pulse);
        x.beginPath(); x.arc(px, py, r + 3 + glow * 4 * pulse, 0, TAU); x.fill();
      }
      // body
      x.fillStyle = rgba(hc, 0.82);
      x.beginPath(); x.arc(px, py, r, 0, TAU); x.fill();
      // house ring
      x.strokeStyle = rgba(mix(hc, INK, 0.25), 0.9); x.lineWidth = 1.1;
      x.beginPath(); x.arc(px, py, r + 0.8, 0, TAU); x.stroke();
      if (lod >= 2) {
        // motor-channel ring: a dashed FAP-tinted ring (the near-view “运动通道环”)
        x.strokeStyle = rgba(fapColor(n.fap) || GILT, 0.55); x.lineWidth = 1; x.setLineDash([2, 2]);
        x.beginPath(); x.arc(px, py, r + 3.4, 0, TAU); x.stroke(); x.setLineDash([]);
        // node label: #id · house · generation · FAP — strokeText halo (shadowBlur is banned tree-wide)
        const lbl = `#${n.id != null ? n.id : '?'}${n.houseName ? ' ' + n.houseName : ''} ${T('lv.genShort', { n: n.gen | 0 })} ${String(n.fap || '').toLowerCase()}`;
        x.font = '8px "IBM Plex Mono", monospace'; x.lineWidth = 2.4;
        x.strokeStyle = rgba(pal.paper, 0.85); x.strokeText(lbl, px + r + 3, py + 3);
        x.fillStyle = rgba(INK, 0.72); x.fillText(lbl, px + r + 3, py + 3);
      }
    }
    if (fa < 1) x.globalAlpha = 1;
  }

  // ---- selection / hover highlight: ANY selectable node, not just the living ones ----
  // task 29 · A4-5 — committed ancestors and tombstones are now clickable (they carry a real genomeHash and
  // a real on-chain verify), so the highlight can no longer live inside the live-node loop.
  lvHighlight(x, LV.focusUid, true);
  lvHighlight(x, LV.hoverUid, false);
  // task 32 · C24 — the search-locate target gets its own cool ring so it reads apart from focus/hover
  if (LV.searchUid) {
    const sn = LV.nodes.get(LV.searchUid);
    if (sn && sn.ghost !== true) {
      x.strokeStyle = rgba([70, 160, 190], 0.9); x.lineWidth = 1.6;
      x.beginPath(); x.arc(sn.x, sn.y, nodeR(sn) + 7, 0, TAU); x.stroke();
    }
  }

  // task 32 · Phase E — the neural overlay (atmosphere, compass, C13 animation advance, genetics) is a heavy
  // per-frame layer: mid view and in only, never mid-gesture. It carries its own LVQ.tier gate internally.
  if (!LV.interacting && lod >= 1) lvNeuralFrame(x, now);

  camIdentity(x);

  // ---- legend: rewritten only when a count actually moves (it used to be frozen at open-time values) ----
  const lg = `${LV.liveCount}|${LV.ancCount}|${LV.tombCount}|${LV.maxGen}|${LV.staleCount}`;
  if (lg !== LV.legendKey) { LV.legendKey = lg; renderLegend(); }
}
// task 32 · Phase E — the mid-gesture / far-view point cloud: generation rings + one dot per static node
// (ancestors / tombs; the live nodes draw their own dots in the per-frame loop's lod0 branch). This is the
// cheap path that replaces the static blit while LV.interacting, so a drag/pinch/zoom never upscales a stale
// bake. ~200 arcs + a handful of rings per frame, no text, no beziers, no per-node glyph work.
function lvPointCloud(x, pal) {
  const cx = LV.W / 2, cy = LV.H / 2, maxGen = LV.maxGen;
  x.lineWidth = 1;
  for (let g = 0; g <= maxGen; g++) {
    const r = ringRadius(g, maxGen);
    x.strokeStyle = g % 5 === 0 ? rgba(mix(INK, pal.paper, 0.35), 0.20) : rgba(mix(INK, pal.paper, 0.6), 0.09);
    x.beginPath(); x.arc(cx, cy, r, 0, TAU); x.stroke();
  }
  for (const n of LV.nodes.values()) {
    if (n.kind === 'live' || n.ghost === true) continue;
    const fa = lvNodeAlpha(n); if (fa < 1) x.globalAlpha = fa;
    const col = n.kind === 'tomb' ? (houseColor(n.houseName) || mix(INK, pal.paper, 0.4)) : GILT;
    x.fillStyle = rgba(col, n.kind === 'tomb' ? 0.3 : 0.4);
    x.beginPath(); x.arc(n.x, n.y, 1.4, 0, TAU); x.fill();
    if (fa < 1) x.globalAlpha = 1;
  }
}
function lvHighlight(x, uid, isFocus) {
  if (!uid) return;
  const n = LV.nodes.get(uid);
  if (!n || n.ghost === true) return;
  x.strokeStyle = rgba(GILT_HI, isFocus ? 0.95 : 0.5); x.lineWidth = isFocus ? 2 : 1.4;
  x.beginPath(); x.arc(n.x, n.y, nodeR(n) + (isFocus ? 5 : 4), 0, TAU); x.stroke();
}

// ================= hit-testing (screen px → world via the camera; node radius + HIT_PAD) =================
function hitTest(sx, sy) {
  // task 29 · Phase B step 2 — the pointer arrives in SCREEN space and the nodes live in WORLD space, so the
  // test goes through the camera inverse. At cam = {k:1,x:0,y:0} that is exactly the identity.
  const p = camToWorld(sx, sy);
  const pad = lvHitPad() / (cam.k || 1);   // keep the forgiveness constant in SCREEN pixels at any zoom
  // task 33 · C26 — lvHitPad() is the POINTER-CLASS pad (14 css px on touch/pen, 4 on mouse) rather than the
  // exported HIT_PAD constant, so a finger gets the 12–16 px hot-zone the mobile contract asks for while a
  // cursor keeps the tight forgiveness that lets adjacent ring nodes stay separable.
  let best = null, bestD = Infinity;
  for (const n of LV.nodes.values()) {
    // task 29 · A4-5 — this used to read `n.kind === 'ghost'`, which skipped BOTH the decorative pass-2
    // ghosts AND the 64 committed ancestors pass 1 had mislabelled 'ghost'. Only a pass-2 node carries the
    // `ghost: true` flag, and only that one has nothing on chain to verify — so it is the sole exclusion.
    if (n.ghost === true) continue;
    const r = nodeR(n) + pad;
    const d = (n.x - p.x) * (n.x - p.x) + (n.y - p.y) * (n.y - p.y);
    if (d <= r * r && d < bestD) { bestD = d; best = n; }
  }
  return best;
}

// ================= focus sidebar =================
function buildFocusSkeleton() {
  const panel = $('lv-panel'); if (!panel) return;
  panel.hidden = false;
  panel.innerHTML =
    `<div class="lv-p-head"><span class="lv-p-id" id="lv-p-id">—</span>` +
    `<button type="button" class="lv-p-x" data-lv-p="close" data-i18n-title="lv.close" aria-label="close">×</button></div>` +
    `<div class="lv-p-prov" id="lv-p-prov"></div>` +
    `<div class="lv-p-sec" id="lv-sec-layers"></div><div class="lv-layers" id="lv-layers"></div>` +
    `<div class="lv-p-sec" id="lv-sec-raster"></div><canvas id="lv-raster" width="240" height="70"></canvas>` +
    `<div class="lv-p-sec" id="lv-sec-memb"></div><canvas id="lv-memb" width="240" height="34"></canvas>` +
    `<div class="lv-p-sec" id="lv-sec-beh"></div><div class="lv-beh" id="lv-beh"></div>` +
    `<div class="lv-p-sec" id="lv-sec-nm"></div><div class="lv-nm" id="lv-nm"></div>` +
    `<div class="lv-p-gen" id="lv-genetics"></div>`;
  // localise the static section headers + close button
  const setT = (id, k) => { const el = $(id); if (el) el.textContent = T(k); };
  setT('lv-sec-layers', 'lv.layers'); setT('lv-sec-raster', 'lv.raster'); setT('lv-sec-memb', 'lv.memb');
  setT('lv-sec-beh', 'lv.behavior'); setT('lv-sec-nm', 'lv.neuromod');
  const xb = panel.querySelector('[data-lv-p="close"]'); if (xb) xb.title = T('lv.close');
  // the 4 layer bars are built once, then only their fills move
  const lh = $('lv-layers');
  if (lh) lh.innerHTML = LAYERS.map((k) =>
    `<div class="lv-bar" data-k="${k}"><span class="lv-bar-n">${T('lv.layer.' + k)}</span>` +
    `<span class="lv-bar-t"><span class="lv-bar-f"></span></span><span class="lv-bar-v">—</span></div>`).join('');
  // task 33 · C26 — group each `.lv-p-sec` header with the block that follows it into a collapsible segment.
  // On a phone the 54vh drawer cannot show five sections at once, so the reader folds what they do not need.
  lvPanelSegment(panel);
}
function renderProvenance() {
  const host = $('lv-p-prov'); if (!host) return;
  const n = LV.focusUid ? LV.nodes.get(LV.focusUid) : null;
  const e = (n && n.entry) || LV.focusEntry;
  const g = LV.focusGrave || (n && n.grave);
  const idLine = $('lv-p-id');
  if (idLine) {
    // task 29 · C3/C4 — a grave wins over the node id. A joined tombstone sits on the genome node of the
    // DEAD individual while its former slot id may already belong to a living, unrelated fly, so printing
    // `n.id` there would be actively wrong. The dagger is the honest label.
    const who = g && g.id != null ? '#' + g.id + ' †' : (n && n.id != null ? '#' + n.id : '—');
    idLine.textContent = e ? `${who} · ${T('lv.genShort', { n: e.generation | 0 })}` : who;
  }
  let html = '';
  const hash = (n && n.hash) || (e && e.genomeHash) || '';
  if (hash) html += `<div class="lv-prov-r"><span>${T('lv.genomeHash')}</span><b class="fp">${shortHash(String(hash).toLowerCase())}</b></div>`;
  if (e) {
    if (Array.isArray(e.parents) && e.parents.some((p) => !isZeroHash(p)))
      html += `<div class="lv-prov-r"><span>${T('lv.parents')}</span><b class="fp">${e.parents.filter((p) => !isZeroHash(p)).map((p) => shortHash(String(p).toLowerCase())).join(' · ')}</b></div>`;
    if (e.op) html += `<div class="lv-prov-r"><span>${T('lv.op')}</span><b>${gl('regime', String(e.op)) !== e.op ? gl('regime', String(e.op)) : e.op}</b></div>`;
    if (e.commitTx && isRealTxHash(e.commitTx))
      html += `<div class="lv-prov-r"><span>${T('lv.commitTx')}</span><b><a href="${ARC_EXPLORER}/tx/${e.commitTx}" target="_blank" rel="noopener noreferrer">${shortHash(e.commitTx)}</a></b></div>`;
  }
  if (g) {
    if (g.cause) html += `<div class="lv-prov-r"><span>${T('lv.cause')}</span><b>${gl('cause', String(g.cause))}</b></div>`;
    if (g.age != null) html += `<div class="lv-prov-r"><span>${T('lv.age')}</span><b>${g.age}</b></div>`;
    if (g.estateUsdc != null) html += `<div class="lv-prov-r"><span>${T('lv.estate')}</span><b>${(+g.estateUsdc).toFixed(4)}</b></div>`;
    if (Array.isArray(g.heirIds) && g.heirIds.length) html += `<div class="lv-prov-r"><span>${T('lv.heirs')}</span><b>${g.heirIds.map((h) => '#' + h).join(' ')}</b></div>`;
  }
  // task 29 · C4 — the node is on the holding ring because its cached identity stamp was invalidated (the slot
  // was recycled, or the hash matched no committed entry). Say so instead of silently showing nothing.
  if (n && n.stale) html += `<div class="lv-prov-r lv-stale"><span>${T('lv.staleRow')}</span><b>${n.id != null ? '#' + n.id : '·'}</b></div>`;
  html += lvProvenanceRows(n, e, g);   // Phase F seam (empty string today)
  const addr = (state.lvLineage && state.lvLineage.lineageAddress) || '';
  if (hash && isRealAddr(addr))
    html += `<button type="button" class="lv-verify" data-lv-p="verify" data-hash="${String(hash).toLowerCase()}">${T('lv.verifyOnchain')}</button>`;
  host.innerHTML = html;
}
function updateFocusNeural() {
  const s = LV.focusSnap; if (!s) return;
  const rates = s.firingRates || [];
  // parse the neuron-kind → layer index map ONCE (it is the same FAFB_783 architecture for every fly)
  if (!LV.layerIdx && Array.isArray(s.neuronKinds) && s.neuronKinds.length) {
    const idx = { sensory: [], inter: [], modulatory: [], motor: [] };
    const kinds = s.neuronKinds;
    const rev = new Int8Array(kinds.length);   // task 30 · C7 neuron index → swimlane (0..3)
    for (let i = 0; i < kinds.length; i++) {
      const li = LAYERS.indexOf(kinds[i]); rev[i] = li >= 0 ? li : 0;
      const b = idx[kinds[i]]; if (b) b.push(i);
    }
    LV.layerIdx = idx; LV.neuronLayer = rev;
  }
  // per-layer mean firing rate — one reduce over ~10,361 values, ONLY on snapshot arrival (never per frame)
  if (LV.layerIdx && rates.length) {
    const means = {};
    for (const k of LAYERS) {
      const arr = LV.layerIdx[k]; let sum = 0;
      for (let j = 0; j < arr.length; j++) sum += rates[arr[j]] || 0;
      means[k] = arr.length ? sum / arr.length : 0;
    }
    LV.layerMeans = means;
    for (const k of LAYERS) {
      const row = document.querySelector(`#lv-layers .lv-bar[data-k="${k}"]`); if (!row) continue;
      const v = means[k], norm = clamp(v / 70);
      const f = row.querySelector('.lv-bar-f'); if (f) { f.style.width = (norm * 100).toFixed(1) + '%'; f.style.background = rgb(KIND_COL[k] || GILT); }
      const out = row.querySelector('.lv-bar-v'); if (out) out.textContent = v.toFixed(1) + ' Hz';
    }
  }
  drawLvRaster(s);
  drawLvMemb(s.membrane);
  drawLvNeuromod(s.neuromod);
  drawLvBehaviour();
  const extra = lvNeuralPanelRows(s);   // Phase C seam: C6 motor bars + FAP, C7 spike-source label
  if (extra) { const nm = $('lv-nm'); if (nm) nm.insertAdjacentHTML('beforeend', extra); }
  renderGeneticsPanel();   // task 30 · C10/C11 refresh bloodline + genotype (picks up async fertility)
}
// task 30 · C7 — the spike raster, upgraded from a single pseudo-spike scatter to FOUR neuron-kind swimlanes.
// When the snapshot carries real spikesLastStep[10361] we plot the actual fired neurons; otherwise we fall back
// to the thresholded pseudo-spikes and the panel says so (lv.rasterDerived vs lv.rasterReal). Reduced ONCE per
// snapshot arrival (≤1 Hz, one fly) — never per frame, never a full 10,361-vector traversal per frame.
function drawLvRaster(s) {
  const c = $('lv-raster'); if (!c || !s) return;
  const x = c.getContext('2d'), W = c.width, H = c.height;
  x.clearRect(0, 0, W, H);
  const pal = paletteAt(state.tempSmoothed);
  const real = lvHasRealSpikes(s.spikesLastStep);
  // gather the firing neuron indices + the vector length N
  let fire = [], N = 0;
  if (real && Array.isArray(s.spikesLastStep)) {
    const sp = s.spikesLastStep; N = sp.length;
    for (let i = 0; i < sp.length; i++) if (sp[i]) fire.push(i);
  } else {
    const rates = s.firingRates || []; N = rates.length;
    fire = derivePseudoSpikes(rates).idx || [];
  }
  const lanes = LAYERS.length, laneH = H / lanes;
  // lane bands (a faint tint per neuron kind)
  for (let L = 0; L < lanes; L++) {
    x.fillStyle = rgba(KIND_COL[LAYERS[L]] || INK, 0.05);
    x.fillRect(0, L * laneH, W, laneH - 1);
  }
  // plot the firing neurons into their swimlane
  const nl = LV.neuronLayer;
  const stride = Math.max(1, Math.floor(fire.length / 1200));
  for (let i = 0; i < fire.length; i += stride) {
    const idx = fire[i];
    const lane = (nl && idx < nl.length) ? nl[idx] : (fnv1a('r' + idx) % lanes);
    x.fillStyle = rgba(KIND_COL[LAYERS[lane]] || pal.accent, 0.78);
    const lx = (idx / Math.max(1, N)) * W;
    const ly = lane * laneH + (laneH - 3) * ((fnv1a('q' + idx) % 100) / 100);
    x.fillRect(lx, ly, 1.4, 1.4);
  }
  // lane labels (strokeText halo, no shadowBlur)
  x.font = '7px monospace'; x.lineWidth = 2; x.strokeStyle = rgba(pal.paper, 0.85);
  for (let L = 0; L < lanes; L++) {
    const tag = LAYERS[L].slice(0, 3);
    x.strokeText(tag, 2, L * laneH + 7); x.fillStyle = rgba(KIND_COL[LAYERS[L]] || INK, 0.7); x.fillText(tag, 2, L * laneH + 7);
  }
  const note = T('lv.rasterNote', { n: fire.length, N });
  x.font = '8px monospace'; x.lineWidth = 2;
  x.strokeStyle = rgba(pal.paper, 0.85); x.strokeText(note, 26, H - 3);
  x.fillStyle = rgba(INK, 0.55); x.fillText(note, 26, H - 3);
}
function drawLvMemb(memb) {
  const c = $('lv-memb'); if (!c) return;
  const x = c.getContext('2d'), W = c.width, H = c.height;
  x.clearRect(0, 0, W, H);
  if (!Array.isArray(memb) || !memb.length) {
    const idle = T('lv.membIdle');
    x.font = '8px monospace'; x.lineWidth = 2;
    x.strokeStyle = 'rgba(238,231,214,0.85)'; x.strokeText(idle, 3, H / 2);
    x.fillStyle = rgba(INK, 0.3); x.fillText(idle, 3, H / 2);
    return;
  }
  let mn = Infinity, mx = -Infinity;
  for (let i = 0; i < memb.length; i++) { const v = memb[i]; if (v < mn) mn = v; if (v > mx) mx = v; }
  const span = (mx - mn) || 1, N = memb.length;
  const STOPS = [[58, 110, 104], [125, 148, 160], [238, 231, 214], [214, 176, 84], [176, 74, 58]];
  const step = Math.max(1, Math.floor(N / W));      // fold the neuron-ordered vector into one column per px
  for (let px = 0, i = 0; px < W; px++, i += step) {
    const q = clamp((memb[i] - mn) / span);
    const t = q * (STOPS.length - 1), si = Math.min(STOPS.length - 2, Math.floor(t));
    const col = mix(STOPS[si], STOPS[si + 1], t - si);
    x.fillStyle = rgb(col); x.fillRect(px, 0, 1, H);
  }
  const lo = mn.toFixed(0) + ' mV', hi = mx.toFixed(0) + ' mV';
  x.font = '8px monospace'; x.lineWidth = 2; x.strokeStyle = 'rgba(238,231,214,0.85)';
  x.strokeText(lo, 3, H - 3); x.strokeText(hi, W - 34, H - 3);
  x.fillStyle = rgba(INK, 0.6);
  x.fillText(lo, 3, H - 3); x.fillText(hi, W - 34, H - 3);
}
function drawLvNeuromod(nm) {
  const host = $('lv-nm'); if (!host) return;
  const da = nmDaHz(nm), oa = nmOaHz(nm);
  const bar = (label, hz, col) => `<div class="lv-bar"><span class="lv-bar-n">${label}</span>` +
    `<span class="lv-bar-t"><span class="lv-bar-f" style="width:${(clamp(hz / NM_REF_HZ) * 100).toFixed(1)}%;background:${col}"></span></span>` +
    `<span class="lv-bar-v">${hz.toFixed(1)} Hz</span></div>`;
  host.innerHTML = bar('DA', da, 'rgb(200,120,40)') + bar('OA', oa, 'rgb(80,140,200)');
}
function drawLvBehaviour() {
  const host = $('lv-beh'); if (!host) return;
  const n = LV.focusUid ? LV.nodes.get(LV.focusUid) : null;
  const fap = (n && n.fap) || 'FORAGE';
  const role = (n && n.role) || FAP_ROLE[fap] || '';
  host.innerHTML = `<span class="lv-fap-badge" style="background:${fapColor(fap)}">${fap.toLowerCase()}</span>` +
    `<span class="lv-fap-gloss">${FAP_GLOSS[fap] || ''}</span>` +
    (role ? `<span class="lv-fap-role">${role}</span>` : '');
}

// ---- focused-fly neural feed: 1 s poll behind the inspector's in-flight + debounce guard, ONE fly only ----
// NOTE FOR LATER PHASES: /snapshot is fine HERE because it is scoped to a single flyId the reader clicked.
// The whole-swarm brain atmosphere must NEVER use it — 459 KB per fly per second is not a budget.
function focusLoad(id) {
  if (LV.focusId !== id) return;
  if (state.offline || Date.now() < state.offlineUntil) return;   // offline: keep the last read-out
  fetchFocusNeural(id);
}
async function fetchFocusNeural(id) {
  if (LV.focusId !== id || LV.focusInFlight) return;
  LV.focusInFlight = true;
  if (LV.focusCtrl) LV.focusCtrl.abort();
  LV.focusCtrl = new AbortController();
  try {
    const s = await getJSON(`/snapshot?flyId=${id}`, 3000, LV.focusCtrl.signal);
    if (LV.focusId !== id) return;
    LV.focusSnap = s;
    updateFocusNeural();
  } catch { /* best-effort; the panel keeps its last frame */ }
  finally { LV.focusInFlight = false; }
}
function startFocusFeed(id) {
  stopFocusFeed();
  if (id == null) return;
  LV.focusId = id;
  LV.focusDebounce = setTimeout(() => { LV.focusDebounce = null; focusLoad(id); }, FOCUS_DEBOUNCE_MS);
  LV.focusTimer = setInterval(() => { if (LV.focusId === id && !LV.focusInFlight) focusLoad(id); }, FOCUS_INTERVAL_MS);
}
function stopFocusFeed() {
  if (LV.focusDebounce) { clearTimeout(LV.focusDebounce); LV.focusDebounce = null; }
  if (LV.focusTimer) { clearInterval(LV.focusTimer); LV.focusTimer = null; }
  if (LV.focusCtrl) { LV.focusCtrl.abort(); LV.focusCtrl = null; }
  LV.focusInFlight = false; LV.focusId = null; LV.focusSnap = null;
}
function selectNode(n) {
  if (!n) { clearFocus(); return; }
  LV.focusUid = n.uid;
  LV.focusEntry = n.entry || null;
  LV.focusGrave = n.grave || null;
  // task 30 · C10 — kick off the bloodline trace. Its synchronous part (ancestry walk + descendant subtree +
  // traceActive flag) runs during the call, so renderGeneticsPanel below already sees the breadcrumbs; the
  // async /lineage/:hash fetch only adds the fertility figure, so re-render once it lands.
  lvTraceStart(n.uid).then(() => renderGeneticsPanel()).catch(() => {});
  buildFocusSkeleton();
  renderProvenance();
  renderGeneticsPanel();
  if (n.id != null && n.kind === 'live') { startFocusFeed(n.id); }
  else { stopFocusFeed(); drawLvBehaviour(); }
}
// task 30 · C10/C11 — the genetics block (genotype structural spec + bloodline breadcrumbs) lives in its own
// host so it can be refreshed independently of the ≤1 Hz neural feed (an ancestor has no snapshot at all).
function renderGeneticsPanel() {
  const host = $('lv-genetics'); if (!host) return;
  const n = LV.focusUid ? LV.nodes.get(LV.focusUid) : null;
  host.innerHTML = lvGeneticsPanelHTML(n);
}
function clearFocus() {
  lvTraceClear();   // task 30 · C10 — drop the bloodline highlight
  LV.focusUid = null; LV.focusEntry = null; LV.focusGrave = null;
  stopFocusFeed();
  const panel = $('lv-panel'); if (panel) { panel.hidden = true; panel.innerHTML = ''; }
}
// task 31 · C22 — show the neural evidence panel for a clicked trade arc
function showEvidencePanel(tradeEdge) {
  clearFocus();
  const panel = $('lv-panel'); if (!panel) return;
  panel.hidden = false;
  panel.innerHTML =
    `<div class="lv-p-head"><span class="lv-p-id">${T('lv.evidTitle')}</span>` +
    `<button type="button" class="lv-p-x" data-lv-p="close" aria-label="close">×</button></div>` +
    lvEvidencePanelHTML(tradeEdge);
  lvPanelSegment(panel);   // task 33 · C26 — the evidence panel gets the same collapsible segments
}
// task 31 · C20 — build and populate the provenance status bar
function initProvBar() {
  const bar = $('lv-prov-bar'); if (!bar) return;
  bar.innerHTML = `<span class="lv-prov-item" id="lv-pb-manifest">—</span>` +
    `<span class="lv-prov-item" id="lv-pb-registry">—</span>` +
    `<span class="lv-prov-item" id="lv-pb-lineage">—</span>` +
    `<span class="lv-prov-item" id="lv-pb-chain">—</span>` +
    `<span class="lv-prov-item" id="lv-pb-commits">—</span>` +
    `<span class="lv-prov-item" id="lv-pb-matching">—</span>` +
    `<span class="lv-prov-badge" id="lv-pb-llm">llm: off</span>` +
    `<span class="lv-prov-item" id="lv-pb-tier">—</span>` +
    `<button type="button" class="lv-prov-btn" id="lv-pb-replay" data-i18n-title="lv.provReplay">${T('lv.provReplay')}</button>` +
    `<button type="button" class="lv-prov-btn" id="lv-pb-verify" data-i18n-title="lv.provVerifyLineage">${T('lv.provVerifyLineage')}</button>`;
  refreshProvBar();
}
async function refreshProvBar() {
  const data = await lvProvFetchStatus();
  const mf = data && data.manifest;
  const lin = data && data.lineage;
  const set = (id, txt) => { const el = $(id); if (el) el.textContent = txt; };
  if (mf) {
    set('lv-pb-manifest', `${T('lv.provManifest')}: ${shortHash(mf.manifestHash || '')}`);
    const reg = (mf.manifest && mf.manifest.registryAddress) || mf.registryAddress || '';
    set('lv-pb-registry', `${T('lv.provRegistry')}: ${shortHash(reg)}`);
    set('lv-pb-chain', `${T('lv.provChain')}: ${mf.chainId || '—'}`);
    const llm = mf.manifest && mf.manifest.llm;
    const llmEl = $('lv-pb-llm');
    if (llmEl) llmEl.textContent = `llm.used: ${llm && llm.used === false ? 'false' : '—'}`;
  }
  if (lin) {
    set('lv-pb-lineage', `${T('lv.provLineage')}: ${shortHash(lin.lineageAddress || '')}`);
    set('lv-pb-matching', `${T('lv.provMatching')}: ${lin.matching ?? '—'}/${lin.count ?? '—'}`);
  }
  // on-chain commitCount via readLineageHead (async, best-effort)
  const addr = (lin && lin.lineageAddress) || (state.lvLineage && state.lvLineage.lineageAddress) || '';
  if (addr) {
    try {
      const { readLineageHead } = await import('./shared.js?v=159');
      const head = await readLineageHead(addr);
      if (head) set('lv-pb-commits', `${T('lv.provCommits')}: ${head.commitCount}`);
    } catch { /* best-effort */ }
  }
  set('lv-pb-tier', `${T('lv.provQuality')}: T${LVQ.tier}`);
}
async function verifyFocus(btn) {
  const hash = btn && btn.dataset.hash; if (!hash) return;
  const addr = (state.lvLineage && state.lvLineage.lineageAddress) || '';
  btn.disabled = true; btn.textContent = T('lv.verifying');
  const oc = await readLineageOnchain(addr, hash);
  if (oc && oc.committed) { btn.textContent = T('lv.verified', { gen: oc.generation }); btn.classList.add('ok'); }
  else if (oc) { btn.textContent = T('lv.notCommitted'); btn.classList.add('fail'); }
  else { btn.textContent = T('lv.verifyFail'); btn.classList.add('fail'); }
  setTimeout(() => { btn.disabled = false; renderProvenance(); }, 2600);
}

// ================= legend =================
// task 29 · A4-6 — two of the five chips described things that can never be seen:
//   • the "unborn ancestor" hollow ring had ZERO occurrences in production (all 139 entries' parents are
//     themselves committed entries), so the chip documented an empty set. The glyph stays in the bake for the
//     day a child is committed before its parent, but it is no longer advertised.
//   • the red "grudge" edge was 100 % dead code (C2) — it is reachable now, so the chip stays and is joined
//     by the chronicle MARK chip that carries the one-actor hostile events.
// Added instead: the committed-ancestor disc (A4-5), which is 64 of 139 nodes — the largest population on the
// canvas and previously the only one with no legend entry at all.
function renderLegend() {
  const host = $('lv-legend'); if (!host) return;
  const goods = Object.keys(GOOD_COL);
  // task 33 · C26 — the legend used to be `display:none` below 680px, i.e. a phone reader got NO key at all.
  // It is now a foldable chip: the title row is always visible and carries a toggle, everything else lives in
  // `.lv-lg-body` which lvLegendSync hides when folded. The fold state is owned by lvInteract (it also owns the
  // narrow-viewport default), so rendering only rebuilds the markup and then re-applies that state.
  let html =
    `<div class="lv-lg-row lv-lg-head"><span class="lv-lg-t">${T('lv.lgTitle')}</span>` +
    `<button type="button" class="lv-lg-tog" data-lv-lg="fold" aria-expanded="true"></button></div>` +
    `<div class="lv-lg-body">` +
    `<div class="lv-lg-row">${goods.map((g) => `<span class="lv-lg-chip"><i style="background:${rgb(GOOD_COL[g])}"></i>${gl('goods', g)}</span>`).join('')}</div>` +
    `<div class="lv-lg-row"><span class="lv-lg-chip"><i class="lv-lg-ally"></i>${T('lv.lgAlly')}</span>` +
    `<span class="lv-lg-chip"><i class="lv-lg-foe"></i>${T('lv.lgFoe')}</span>` +
    `<span class="lv-lg-chip"><i class="lv-lg-mark"></i>${T('lv.lgMark')}</span>` +
    `<span class="lv-lg-chip"><i class="lv-lg-anc"></i>${T('lv.lgAnc')}</span>` +
    `<span class="lv-lg-chip"><i class="lv-lg-tomb"></i>${T('lv.lgTomb')}</span></div>` +
    `<div class="lv-lg-row lv-lg-note">${T('lv.lgNote', { n: LV.liveCount, a: LV.ancCount, g: LV.maxGen })}</div>`;
  if (LV.staleCount > 0) html += `<div class="lv-lg-row lv-lg-note lv-stale">${T('lv.staleNote', { n: LV.staleCount })}</div>`;
  html += `</div>`;
  host.innerHTML = html;
  lvLegendSync();
}

// ================= open / close / toggle =================
export function openLineageView() {
  if (LV.active) return;
  if (!LV.inited) initLineageView();
  LV.active = true; state.lineageViewActive = true;
  document.body.classList.add('lv-active');
  const ui = $('lv-ui'); if (ui) ui.hidden = false;
  cam.k = 1; cam.x = 0; cam.y = 0;    // every open starts at the identity view (Phase E owns persistence)
  LV.interacting = false; LV.searchUid = null; LV.lod = 1;   // task 32 · Phase E — a clean camera/gesture state
  sizeCanvas();
  syncRailBtn();
  // seed + start the slow poller; the first paint uses whatever is already cached
  pollLineageView(true);
  if (!LV.lineageTimer) LV.lineageTimer = setInterval(() => pollLineageView(false), LINEAGE_POLL_MS);
  // task 29 · C1/C5 — the 45 s catch-all setInterval is GONE. Everything the atlas accumulates is now driven
  // by DATA ARRIVAL: polling.js / economy.js raise LV_DIRTY_* bits and lvPumpData (called from lvFrame, so
  // only while the atlas is actually on stage) drains them. lvPrime does the one-shot seed from cache.
  lvPrime();
  renderLegend();
  initProvBar();   // task 31 · C20 — populate the provenance status bar on open
  // task 39 · A3: show a loading indicator until /lineage data lands (cold start has an empty canvas)
  { const pb = $('lv-prov-bar'); if (pb && LV.nodeCount === 0) { const s = document.createElement('span'); s.id = 'lv-pb-loading'; s.className = 'lv-prov-item'; s.textContent = T('lv.loading'); pb.prepend(s); } }
  lvPopulateHouses();   // task 32 · C24 — refresh the filter's house <select> from the current roster
  lvMobileSync();  // task 33 · C26 — re-read the narrow-viewport default for the legend fold / panel segments
  // task 42 · P0-C — renderLegend() / initProvBar() / lvMobileSync() above all rewrite chrome that
  // sizeCanvas() had already measured (it ran while #lv-legend and #lv-prov-bar were still empty). Ask for
  // one more measure on the next frame so the safe area is solved against the REAL toolbar/legend geometry.
  LV.hudDirty = true;
}
export function closeLineageView() {
  if (!LV.active) return;
  LV.active = false; state.lineageViewActive = false;
  document.body.classList.remove('lv-active');
  const ui = $('lv-ui'); if (ui) ui.hidden = true;
  if (LV.lineageTimer) { clearInterval(LV.lineageTimer); LV.lineageTimer = null; }
  c8Stop();   // task 30 · C8 — halt the whole-swarm brain-atmosphere poll (zero work while hidden)
  clearFocus();
  LV.parts.length = 0; LV.partCount = 0;
  LV.interacting = false; LV.searchUid = null;   // task 32 · Phase E — drop any gesture/search highlight on close
  // task 33 · C25 — the replay must do ZERO work while the atlas is off stage: stop the clock, abort any
  // in-flight /history page fetch, hide the chrome and drop the body class. There is no timer to clear (the
  // playback clock is integrated from rAF, which main.js stops calling for a hidden view) — but the
  // AbortController and the born-set gate both have to be released, and the layout restored to the full tree.
  lvReplayStop();
  syncRailBtn();
}
export function toggleLineageView() { if (LV.active) closeLineageView(); else openLineageView(); }
function syncRailBtn() {
  const b = document.querySelector('#command-rail .rail-btn[data-act="lineageview"]');
  if (b) { b.classList.toggle('is-off', !LV.active); b.setAttribute('aria-pressed', LV.active ? 'true' : 'false'); }
  // task 93: the rail's two canvas-mode buttons mirror whichever canvas owns the stage —
  // home is lit while the atlas runs, mode3d is lit while the WebGL swarm runs.
  const h = document.querySelector('#command-rail .rail-btn[data-act="home"]');
  if (h) { h.classList.toggle('is-off', !LV.active); h.setAttribute('aria-pressed', LV.active ? 'true' : 'false'); }
  const m = document.querySelector('#command-rail .rail-btn[data-act="mode3d"]');
  if (m) { m.classList.toggle('is-off', LV.active); m.setAttribute('aria-pressed', LV.active ? 'false' : 'true'); }
}

// ================= init (wiring, called once from main.js boot) =================
export function initLineageView() {
  if (LV.inited) return;
  LV.cv = $('lineage-field');
  if (!LV.cv) return;
  // 2D on #lineage-field ONLY. #field is the WebGL canvas — never ask it for a 2D context.
  LV.ctx = LV.cv.getContext('2d');
  LV.inited = true;
  loadGH(); loadSocial();

  // task 32 · Phase E — ALL canvas input (drag-pan / pinch-zoom / wheel-zoom / tap-select / hover) is bound by
  // lvInteract.lvInteractBind. Core keeps the SELECTION semantics (hitTest → selectNode, trade-arc → evidence
  // panel, empty → dismiss) and hands them to the seam as the tap/hover callbacks, so the gesture maths lives in
  // lvInteract while the draw/pick logic stays here. This replaces the old direct pointerdown/move/wheel
  // listeners, which predated the camera and would have fought the drag/pinch handlers for the same pointer.
  lvInteractBind(LV.cv, {
    onTap: (sx, sy) => {
      const n = hitTest(sx, sy);
      if (n) { selectNode(n); return; }
      const tradeHit = lvTradeHitScreen(sx, sy);   // task 31 · C22 — coarse bbox + fine nearest-point on bezier
      if (tradeHit) { showEvidencePanel(tradeHit); return; }
      closeActiveDrawer();   // task 26: empty click dismisses any open drawer — KEEP THIS WIRING
      clearFocus();
    },
    onHover: (sx, sy) => {
      const n = hitTest(sx, sy);
      LV.hoverUid = n ? n.uid : null;
      if (LV.cv) LV.cv.style.cursor = n ? 'pointer' : 'crosshair';
    },
  });
  // task 32 · C24 — a search-locate opens the focus panel through the one-way hook (lvInteract never imports core).
  LV.hooks.select = selectNode;
  // task 32 · C24 — wire the search box + filter popover (DOM lives in #lv-toolbar / #lv-filters).
  lvBindSearchFilter();
  // task 33 · C25 — bind the replay chrome (scrubber, transport buttons, sparkline). One-shot, DOM-only:
  // the scrubber lives in #lv-ui as a sibling ABOVE the canvas with pointer-events:auto, so a drag on it
  // never reaches #lineage-field and lvInteractBind's pointercapture gesture stack is not bypassed.
  lvReplayBind();
  // task 33 · C26 — bind the mobile chrome (legend fold toggle + the collapsible panel segment headers).
  lvBindMobile();

  // toolbar toggles + panel delegation
  const tb = $('lv-toolbar');
  if (tb) tb.addEventListener('click', (ev) => {
    const b = ev.target.closest('.lv-tb'); if (!b) return;
    const k = b.dataset.lv;
    if (k === 'shards') { LV.showShards = !LV.showShards; b.setAttribute('aria-pressed', LV.showShards ? 'true' : 'false'); LV.staticKey = ''; }
    else if (k === 'social') { LV.showSocial = !LV.showSocial; b.setAttribute('aria-pressed', LV.showSocial ? 'true' : 'false'); }
    else if (k === 'trade') { LV.showTrade = !LV.showTrade; b.setAttribute('aria-pressed', LV.showTrade ? 'true' : 'false'); }
    else if (k === 'pnl') { const m = lvEnvCyclePnl(); b.textContent = ['house', 'pnl', 'geno'][m]; }
    else if (k === 'refresh') {
      pollLineageView(true);
      lvMarkDirty(LV_DIRTY_FEED | LV_DIRTY_SOCIAL | LV_DIRTY_LAYOUT);
      lvForceRebuild();
      refreshProvBar();   // task 31 · C20 — refresh provenance status on manual refresh
    }
    else if (k === 'filter') { lvToggleFilters(); }   // task 32 · C24 — open/close the filter popover
    else if (k === 'replay') { lvReplayToggle(); }   // task 33 · C25 — open/close the time-replay drawer
    else if (k === 'close') { closeLineageView(); }
  });
  const panel = $('lv-panel');
  if (panel) panel.addEventListener('click', (ev) => {
    const b = ev.target.closest('[data-lv-p]'); if (!b) return;
    if (b.dataset.lvP === 'close') clearFocus();
    else if (b.dataset.lvP === 'verify') verifyFocus(b);
  });
  // task 31 · C20 — provenance status bar button delegation
  const provBar = $('lv-prov-bar');
  if (provBar) provBar.addEventListener('click', (ev) => {
    const btn = ev.target.closest('.lv-prov-btn'); if (!btn) return;
    if (btn.id === 'lv-pb-replay') {
      btn.disabled = true; btn.textContent = '…';
      getJSON('/manifest/replay', 8000).then((r) => {
        btn.textContent = r && r.ok ? `✓ ${r.checked}` : '✗';
        btn.disabled = false;
        setTimeout(() => { btn.textContent = T('lv.provReplay'); }, 3000);
      }).catch(() => { btn.textContent = '✗'; btn.disabled = false; setTimeout(() => { btn.textContent = T('lv.provReplay'); }, 3000); });
    } else if (btn.id === 'lv-pb-verify') {
      btn.disabled = true; btn.textContent = '…';
      getJSON('/lineage/verify', 8000).then((r) => {
        btn.textContent = r && r.ok ? `✓ ${r.checked || ''}` : '✗';
        btn.disabled = false;
        setTimeout(() => { btn.textContent = T('lv.provVerifyLineage'); }, 3000);
      }).catch(() => { btn.textContent = '✗'; btn.disabled = false; setTimeout(() => { btn.textContent = T('lv.provVerifyLineage'); }, 3000); });
    }
  });
  // A resize changes W/H, so the layout AND the bake are invalid. Go through the forced-rebuild path rather
  // than calling rebuild() inline: a drag-resize fires dozens of events, and lvPumpData drains at most once
  // per frame.
  window.addEventListener('resize', () => { if (LV.active) { sizeCanvas(); lvForceRebuild(); lvMobileSync(); LV.hudDirty = true; } });
  // task 42 · P0-C — zero-polling chrome tracking: the topbar grows on a language switch, the rail disappears
  // on a phone, the toolbar re-wraps, the legend folds, the inspector panel opens. All of them move the tree
  // safe area without moving W/H, so observe them instead of polling.
  lvHudObserve();
  syncRailBtn();
}

// re-localise the dynamic chrome on a language switch (called from main.js rerenderAll)
export function lvRelocalise() {
  if (!LV.active) return;
  renderLegend();
  lvSearchRelocalise();   // task 32 · C24 — re-localise the search placeholder + filter widgets + status counts
  lvReplayRelocalise();   // task 33 · C25 — re-localise the replay chrome + rebuild the metric-cell labels
  lvMobileRelocalise();   // task 33 · C26 — re-localise the legend fold button + the panel segment headers
  LV.hudDirty = true;     // task 42 · P0-C — every label just changed width: re-measure the chrome next frame
  LV.staticKey = '';   // the generation-ring labels are baked with T('lv.gen') — a language switch must re-bake
  if (LV.focusUid) { buildFocusSkeleton(); renderProvenance(); renderGeneticsPanel(); if (LV.focusSnap) updateFocusNeural(); else drawLvBehaviour(); }
}

// perf probe extension (merged into window.__murmurPerf by main.js)
export function lvPerf() {
  return Object.assign({
    lvActive: LV.active, lvTier: LVQ.tier, lvDpr: Math.round(LV.DPR * 100) / 100, lvCamK: Math.round(cam.k * 100) / 100,
    lvLod: LV.lod, lvInteracting: LV.interacting, lvKScale: camKScale(),
    lvFilterActive: lvFilter.active, lvFilterMatches: lvFilter.active ? lvFilter.matchCount : -1, lvSearchUid: LV.searchUid ? 1 : 0,
    lvNodes: LV.nodeCount, lvEdges: LV.edgeCount, lvParticles: LV.partCount, lvRebakes: LV.rebakes,
    lvLive: LV.liveCount, lvAnc: LV.ancCount, lvTombs: LV.tombCount,
    lvTradeRoutes: LV.tradeEdges.size, lvSocial: LV.socialCount, lvMarks: LV.stainCount,
    lvStale: LV.staleCount, lvGh: LV.ghCache.size, lvRetired: LV.ghRetired.size,
    lvPulse: Math.round(Math.max(LV.colonyPulse.foe, LV.colonyPulse.ally, LV.colonyPulse.market) * 100) / 100,
    // task 42 · P0-C probe — the resolved tree safe area (world space) and the corner-widget boxes (screen
    // space) the overlap audit reads. Rounded to 0.1 px so the JSON stays readable.
    lvSafe: { cx: R1(LV_LAYOUT.cx), cy: R1(LV_LAYOUT.cy), r1: R1(LV_LAYOUT.r1), top: R1(LV_LAYOUT.top), bottom: R1(LV_LAYOUT.bottom), left: R1(LV_LAYOUT.left), right: R1(LV_LAYOUT.right) },
    lvChrome: {
      topbar: LV_HUD.top, rail: LV_HUD.left, panelLeft: LV_HUD.panelLeft, pad: LV_HUD.pad,
      tbH: LV_HUD.tbH, tbBottom: LV_HUD.tbBottom, stackBottom: LV_HUD.stackBottom,
      blTop: R1(LV_HUD.blTop), capH: LV_HUD.capH, scale: R1(LV_HUD.scale),
      tl: LB(LV_HUD.tl), tr: LB(LV_HUD.tr), bl: LB(LV_HUD.bl),
      brTop: LB(LV_HUD.brTop), brBot: LB(LV_HUD.brBot), ruler: LB(LV_HUD.ruler),
      legend: LB(LV_HUD.legend), capsule: LB(LV_HUD.capsule), prov: LB(LV_HUD.pb),
    },
  }, lvReplayPerf());   // task 33 · C25 — lvRt* probe fields (key-frame count, cursor, bucket, born set size)
}
const R1 = (v) => Math.round((v || 0) * 10) / 10;
/** Flatten one HUD box to {x,y,w,h,r,b} (r = right edge, b = bottom edge) for the overlap audit. */
function LB(b) {
  if (!b) return null;
  const w = b.w || 0, h = b.h || 0;
  return { x: R1(b.x), y: R1(b.y), w: R1(w), h: R1(h), r: R1(b.x + w), b: R1(b.y + h) };
}
