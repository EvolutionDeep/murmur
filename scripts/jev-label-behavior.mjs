#!/usr/bin/env node
// jev-label-behavior.mjs — OFFLINE data-labelling fuel: turn murmur's raw chronicle/population read-out into
// typed, confidence-tagged research labels using Jev as a fast annotator.
//
// WHY. murmur emits a rich deterministic chronicle (PLAGUE / WAR / GREAT_HUDDLE / first-settlement / era shifts …)
// and a per-tick behaviour tape, but the EVENTS are not tagged by theme or weighted by significance — that is
// exactly the kind of cheap, high-cardinality judgement a System One annotator is good at (classify + score +
// verify, in parallel, with a calibrated confidence). The output is a JSONL of LABELS ONLY, meant for offline
// study (feature engineering, clustering audits, a future supervised model of "what makes a milestone"). It is
// never read by the worker and moves no money — it only READS public GET endpoints and writes a file.
//
// DEPENDS ON (read-only, no new npm deps — Node built-in fetch):
//   1. murmur public GET {api}/annals?limit=N     (kind, tick, era, severity, text)
//   2. murmur public GET {api}/history?limit=N    (top_state, size, temperature — swarm context per tick)
//   3. the Jev HTTP API  POST https://api.typesafe.ai/v1/systemone  (Bearer JEV_API_KEY from the environment)
//
// USAGE
//   JEV_API_KEY=sk-... node scripts/jev-label-behavior.mjs --limit 120 --out _jev_labels.jsonl
//   node scripts/jev-label-behavior.mjs --api https://api.muros.live --limit 40 --dry-run   # no key needed
//   node scripts/jev-label-behavior.mjs --limit 20            # print the table to stdout
// Exit 0 always (no key ⇒ graceful DRY report). Exit 1 only on a hard crash.

const args = process.argv.slice(2);
const arg = (name, dflt) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] && !args[i + 1].startsWith("--") ? args[i + 1] : dflt;
};
const flag = (name) => args.includes(`--${name}`);

const API = (arg("api", "https://api.muros.live")).replace(/\/+$/, "");
const JEVE_URL = (arg("jev-url", "https://api.typesafe.ai")).replace(/\/+$/, "") + "/v1/systemone";
const MODEL = arg("model", "jev-latest");
const LIMIT = Math.min(500, Math.max(1, Number(arg("limit", "120")) || 120));
const OUT = arg("out", null);
const DRY = flag("dry-run");
const KEY = (process.env.JEV_API_KEY || "").trim();

// The closed research taxonomy every event is mapped onto (a Jev Choice). Kept small + orthogonal on purpose.
const THEMES = {
  conflict: "war, feud, exile, indictment, coercion between houses",
  exchange: "a trade, settlement, market, credit, price or debt event",
  mortality: "death, plague, famine, a grave or an estate",
  faith: "a prophet, sect, pilgrimage, prophecy or holy day",
  governance: "a law, council, treaty, reform, rule or public work",
  knowledge: "an invention, discovery, lesson, archive or lexicon/neologism",
  spectacle: "games, festival, poem, rumour or a public celebration",
  other: "none of the above clearly",
};
// Significance rubric (a Jev Score; lowest→highest).
const SIGNIFICANCE = ["footnote", "notable", "chapter-defining", "era-defining"];

async function getJson(url) {
  const r = await fetch(url, { headers: { accept: "application/json" } });
  if (!r.ok) throw new Error(`GET ${url} -> HTTP ${r.status}`);
  return r.json();
}

function labelRequest(entry) {
  const state = {
    chronicle_kind: entry.kind,
    era: entry.eraName ?? entry.era ?? null,
    severity: entry.severity ?? null,
    line: entry.text ?? null,
  };
  return {
    state,
    model: MODEL,
    questions: {
      theme: { type: "choice", instructions: "Which single theme best categorises this chronicle line?", criteria: THEMES },
      significance: {
        type: "score",
        instructions: "How historically significant is this event for the swarm?",
        criteria: SIGNIFICANCE,
      },
      is_economic: {
        type: "noul",
        instructions: "Does this event involve economic exchange (money, trade, debt, or a market)?",
        criteria: { true: "value moves or is agreed", false: "no economic content" },
      },
    },
  };
}

async function callJev(entry) {
  const r = await fetch(JEVE_URL, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${KEY}` },
    body: JSON.stringify(labelRequest(entry)),
  });
  if (!r.ok) throw new Error(`Jev HTTP ${r.status}`);
  const j = await r.json();
  const a = (j && j.answers) || {};
  return {
    theme: a.theme && a.theme.type === "choice" ? { label: a.theme.choice, confidence: a.theme.confidence ?? null } : null,
    significance: a.significance && a.significance.type === "score"
      ? { score: a.significance.score, confidence: a.significance.confidence ?? null }
      : null,
    is_economic: a.is_economic && typeof a.is_economic.noul === "number" ? a.is_economic.noul : null,
  };
}

async function main() {
  const annalsRes = await getJson(`${API}/annals?limit=${LIMIT}&order=desc`);
  const events = (annalsRes && (annalsRes.rows || annalsRes.entries || annalsRes.annals)) || [];
  if (!events.length) {
    console.log(`No chronicle rows from ${API}/annals. Nothing to label.`);
    return;
  }
  const kindTally = {};
  for (const e of events) kindTally[e.kind] = (kindTally[e.kind] || 0) + 1;

  if (DRY || !KEY) {
    if (!KEY && !DRY) console.log("JEV_API_KEY not set — DRY mode (shows the taxonomy + the raw chronicle mix, no Jev call).");
    console.log(`Chronicle events: ${events.length}   kinds: ${JSON.stringify(kindTally)}`);
    console.log(`Theme taxonomy : ${Object.keys(THEMES).join(", ")}`);
    console.log(`Significance   : ${SIGNIFICANCE.join(" < ")}`);
    const sample = events.slice(0, 3).map((e) => ({ kind: e.kind, tick: e.tick, text: e.text }));
    console.log(`Sample events Jev would label:\n${JSON.stringify(sample, null, 2)}`);
    if (!DRY) console.log("\nTo label: JEV_API_KEY=sk-... node scripts/jev-label-behavior.mjs --limit " + LIMIT + " --out _jev_labels.jsonl");
    return;
  }

  const records = [];
  let firstErr = null;
  for (const e of events) {
    let lab;
    try {
      lab = await callJev(e);
    } catch (err) {
      firstErr = firstErr || String(err.message || err);
      continue;
    }
    records.push({
      seq: e.seq ?? null,
      tick: e.tick ?? null,
      kind: e.kind ?? null,
      era: e.eraName ?? e.era ?? null,
      worker_severity: e.severity ?? null,
      jev_theme: lab.theme ? lab.theme.label : null,
      jev_theme_confidence: lab.theme ? lab.theme.confidence : null,
      jev_significance: lab.significance ? lab.significance.score : null,
      jev_significance_confidence: lab.significance ? lab.significance.confidence : null,
      jev_is_economic: lab.is_economic,
    });
  }

  const themeTally = {};
  for (const r of records) if (r.jev_theme) themeTally[r.jev_theme] = (themeTally[r.jev_theme] || 0) + 1;
  const summary = { api: API, model: MODEL, events: events.length, labelled: records.length, themeTally, firstError: firstErr };
  console.log(`Labelled ${records.length}/${events.length} events. Jev theme mix: ${JSON.stringify(themeTally)}`);
  if (firstErr) console.log(`(first Jev error, others skipped): ${firstErr}`);

  const jsonl = records.map((r) => JSON.stringify(r)).join("\n") + (records.length ? "\n" : "");
  if (OUT) {
    const { writeFileSync } = await import("node:fs");
    writeFileSync(OUT, jsonl, "utf8");
    console.log(`Wrote ${records.length} label records → ${OUT}`);
    console.log(`Summary: ${JSON.stringify(summary)}`);
  } else {
    process.stdout.write(jsonl);
  }
}

main().catch((e) => {
  console.error("FAILED:", e && e.stack ? e.stack : String(e));
  process.exit(1);
});
