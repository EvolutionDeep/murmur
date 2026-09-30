#!/usr/bin/env node
// jev-two-systems.mjs — OFFLINE research harness: murmur's neural/deterministic regime vs a "second System One".
//
// THE QUESTION. murmur decides every trade with spiking-neuron flies whose regime label (HOT/CALM/COLD) is a
// deterministic function of Arc whole-chain activity — no LLM anywhere. TypeSafe's Jev is a *different* System
// One: a fast statistical decider that, from the same read-out, returns a calibrated posture. This harness puts
// the two side by side OVER HISTORY and asks: on identical state, do they agree, and is Jev's confidence
// actually calibrated to its accuracy? It is a STUDY of two decision systems, not a dependency — it feeds
// NOTHING back into the worker, the economy, the brains, or any wallet. It only READS public endpoints.
//
// FAITHFUL INPUTS (the offline-must-match-live law). For every historical tick we rebuild the EXACT state shape
// the worker's runJevInsight sends — temperature, the recorded regime, momentum and turbulence from the SAME
// derivePulse formulas used in src/market.ts, swarm size and the top drive — so the comparison is against the
// production drive, not a hand-made plausible one.
//
// DEPENDS ON (read-only, no secrets, no new npm deps — Node built-in fetch):
//   1. murmur public GET {api}/history?limit=N   (per-tick temperature, regime, size, top_state)
//   2. the Jev HTTP API   POST https://api.typesafe.ai/v1/systemone   (Bearer JEV_API_KEY from the environment)
// It NEVER reads worker internals, DO storage, or any secret.
//
// USAGE
//   JEV_API_KEY=sk-... node scripts/jev-two-systems.mjs --limit 60
//   node scripts/jev-two-systems.mjs --api https://api.muros.live --limit 40 --model jev-latest --json
//   node scripts/jev-two-systems.mjs --dry-run         # show the states + math WITHOUT calling Jev (no key needed)
// Exit 0 always (no key / no history ⇒ a graceful DEGRADED report, not a failure). Exit 1 only on a hard crash.

const args = process.argv.slice(2);
const arg = (name, dflt) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] && !args[i + 1].startsWith("--") ? args[i + 1] : dflt;
};
const flag = (name) => args.includes(`--${name}`);

const API = (arg("api", "https://api.muros.live")).replace(/\/+$/, "");
const JEVE_URL = (arg("jev-url", "https://api.typesafe.ai")).replace(/\/+$/, "") + "/v1/systemone";
const MODEL = arg("model", "jev-latest");
const LIMIT = Math.min(2000, Math.max(2, Number(arg("limit", "60")) || 60));
const DRY = flag("dry-run");
const AS_JSON = flag("json");
const KEY = (process.env.JEV_API_KEY || "").trim();

// --- murmur's own regime<->posture bridge (the two vocabularies) --------------------------------------------
// Jev posture choices (see src/jev.ts) map onto murmur's deterministic regime tags.
const POSTURE_TO_REGIME = { dormant: "COLD", steady: "CALM", fevered: "HOT" };
const REGIMES = ["COLD", "CALM", "HOT"];

// Faithful copies of derivePulse's momentum/turbulence from src/market.ts (so offline == live drive).
const clamp = (x, lo, hi) => (x < lo ? lo : x > hi ? hi : x);
const momentumOf = (t, prevT) => clamp((t - prevT) * 10, -1, 1);
const turbulenceOf = (t) => clamp01(Math.abs(t - 0.5) * 2);
const clamp01 = (x) => clamp(x, 0, 1);

async function getJson(url) {
  const r = await fetch(url, { headers: { accept: "application/json" } });
  if (!r.ok) throw new Error(`GET ${url} -> HTTP ${r.status}`);
  return r.json();
}

// The exact 2-question batch a fair "second system" would judge on (posture + urgency), mirroring src/jev.ts.
function jevPostureRequest(state) {
  return {
    state,
    model: MODEL,
    questions: {
      posture: {
        type: "choice",
        instructions: "Given this Arc-chain market temperature and swarm state, how active is the environment?",
        criteria: {
          dormant: "temperature low, chain quiet, little flow",
          steady: "temperature middling, ordinary activity",
          fevered: "temperature high, dense chain activity and fast trading",
        },
      },
      urgent: {
        type: "noul",
        instructions: "Does this state read as a stress or pressure moment for the swarm?",
        criteria: { true: "high turbulence or a fevered environment", false: "settled, ordinary conditions" },
      },
    },
  };
}

async function callJev(state) {
  const body = jevPostureRequest(state);
  const r = await fetch(JEVE_URL, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${KEY}` },
    body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error(`Jev HTTP ${r.status}`);
  const j = await r.json();
  const a = (j && j.answers) || {};
  return {
    posture: a.posture && a.posture.type === "choice" ? a.posture : null,
    urgent: a.urgent && typeof a.urgent.noul === "number" ? a.urgent.noul : null,
  };
}

// Brier score of a probabilistic forecast against a one-hot outcome. probs: full distribution over classes.
function brier(probs, trueClass, classes) {
  let s = 0;
  for (const c of classes) {
    const p = probs[c] ?? 0;
    const o = c === trueClass ? 1 : 0;
    s += (p - o) ** 2;
  }
  return s / classes.length;
}

// Expected Calibration Error over confidence buckets, from a list of {confidence, correct:boolean}.
function ece(pairs, bins = 10) {
  if (!pairs.length) return null;
  const buck = Array.from({ length: bins }, () => ({ n: 0, conf: 0, acc: 0 }));
  for (const { confidence, correct } of pairs) {
    const b = Math.min(bins - 1, Math.floor(clamp01(confidence) * bins));
    buck[b].n++;
    buck[b].conf += confidence;
    buck[b].acc += correct ? 1 : 0;
  }
  const N = pairs.length;
  let e = 0;
  for (const b of buck) if (b.n) e += (b.n / N) * Math.abs(b.acc / b.n - b.conf / b.n);
  return e;
}

function buildState(row, prevRow) {
  const t = Number(row.temperature);
  const pt = prevRow ? Number(prevRow.temperature) : t;
  return {
    temperature: Number.isFinite(t) ? t : null,
    regime: row.regime ?? null,
    momentum: Number.isFinite(t) ? momentumOf(t, Number.isFinite(pt) ? pt : t) : null,
    turbulence: Number.isFinite(t) ? turbulenceOf(t) : null,
    swarm_size: row.size ?? null,
    top_drive: row.top_state ?? null,
    latest_record: null, // history has no chronicle line; posture/urgency do not need it
  };
}

async function main() {
  const hist = await getJson(`${API}/history?limit=${LIMIT}&order=asc`);
  const rows = (hist && hist.rows) || [];
  if (!rows.length) {
    console.log(`No history rows from ${API}/history (enabled=${hist && hist.enabled}). Nothing to compare.`);
    return;
  }
  // rows asc → row i's "previous" is row i-1.
  const states = rows.map((r, i) => buildState(r, rows[i - 1]));

  if (DRY || !KEY) {
    if (!KEY && !DRY) console.log("JEV_API_KEY not set — running in DRY mode (no Jev call, shows the faithful states + murmur's own labels).");
    const regimeTally = {};
    for (const r of rows) regimeTally[r.regime] = (regimeTally[r.regime] || 0) + 1;
    console.log(`Ticks: ${rows.length}  range ${rows[0].tick}..${rows[rows.length - 1].tick}`);
    console.log(`murmur deterministic regime distribution: ${JSON.stringify(regimeTally)}`);
    const sample = states.slice(-5);
    console.log(`Sample (last 5) of the runJevInsight-shaped states Jev would receive:\n${JSON.stringify(sample, null, 2)}`);
    if (!DRY) console.log("\nTo run the study: JEV_API_KEY=sk-... node scripts/jev-two-systems.mjs --limit " + LIMIT);
    return;
  }

  // --- LIVE STUDY -------------------------------------------------------------
  let agree = 0;
  let judged = 0;
  const briers = [];
  const confPairs = [];
  const urgBriers = [];
  const perTick = [];
  let firstErr = null;
  for (let i = 0; i < states.length; i++) {
    const row = rows[i];
    let out;
    try {
      out = await callJev(states[i]);
    } catch (e) {
      firstErr = firstErr || String(e.message || e);
      continue;
    }
    const p = out.posture;
    if (!p || !POSTURE_TO_REGIME[p.choice]) continue;
    judged++;
    const jevRegime = POSTURE_TO_REGIME[p.choice];
    const correct = jevRegime === row.regime;
    if (correct) agree++;
    confPairs.push({ confidence: p.confidence ?? 0, correct });
    briers.push(brier(p.probabilities || {}, row.regime, REGIMES));
    if (out.urgent != null) urgBriers.push(brier({ hot: out.urgent, cold: 1 - out.urgent }, row.regime === "HOT" ? "hot" : "cold", ["hot", "cold"]));
    perTick.push({
      tick: row.tick,
      temperature: states[i].temperature,
      murmur_regime: row.regime,
      jev_posture: p.choice,
      jev_regime: jevRegime,
      jev_confidence: p.confidence ?? null,
      agree: correct,
      jev_urgent: out.urgent,
    });
  }

  const report = {
    api: API,
    model: MODEL,
    ticksRequested: rows.length,
    ticksJudged: judged,
    agreement: judged ? +(agree / judged).toFixed(4) : null,
    brierPosture: briers.length ? +(briers.reduce((a, b) => a + b, 0) / briers.length).toFixed(4) : null,
    ecePosture: (() => { const e = ece(confPairs); return e == null ? null : +e.toFixed(4); })(),
    meanConfidence: confPairs.length ? +(confPairs.reduce((a, x) => a + x.confidence, 0) / confPairs.length).toFixed(4) : null,
    brierUrgencyVsHot: urgBriers.length ? +(urgBriers.reduce((a, b) => a + b, 0) / urgBriers.length).toFixed(4) : null,
    firstError: firstErr,
    note: "Read-only comparison of two System Ones. No feedback into the worker/economy/brains/money.",
  };

  if (AS_JSON) {
    console.log(JSON.stringify({ report, perTick }, null, 2));
  } else {
    console.log("=== murmur (deterministic regime)  vs  Jev (statistical posture) ===");
    console.log(`judged ${report.ticksJudged}/${report.ticksRequested} ticks`);
    console.log(`agreement          : ${report.agreement ?? "n/a"}`);
    console.log(`Brier (posture)    : ${report.brierPosture ?? "n/a"}   (lower = better; 0.5 ≈ a coin flip over 3 classes)`);
    console.log(`ECE  (posture conf): ${report.ecePosture ?? "n/a"}   (lower = better calibrated)`);
    console.log(`mean confidence    : ${report.meanConfidence ?? "n/a"}`);
    console.log(`Brier (urgency~HOT): ${report.brierUrgencyVsHot ?? "n/a"}`);
    if (report.firstError) console.log(`(first Jev error: ${report.firstError})`);
  }
}

main().catch((e) => {
  console.error("jev-two-systems failed:", e && e.stack ? e.stack : e);
  process.exit(1);
});
