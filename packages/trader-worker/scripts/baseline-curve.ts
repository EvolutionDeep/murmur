#!/usr/bin/env -S npx tsx
// P0.4 — Pre-Phase-1 cross-generation BASELINE curve (the frozen "capability ④ before" snapshot).
//
// WHY THIS EXISTS
//   Phase 4 must prove the playbook (Phase 1) lifted cross-generation capability. To prove a lift you need a
//   BEFORE. This script drives the CURRENT economy logic (post-P0.1 determinism fix, pre-Phase-1 playbook) in
//   SIMULATED mode for a multi-generation lineage and folds it through the SAME pure `generationReport()` the
//   /lineage/stats endpoint serves — then freezes the curve as a JSON artifact Phase 4 diffs against.
//
// DETERMINISM (this baseline is itself reproducible byte-for-byte)
//   • NO Math.random, NO Date.now anywhere in the driver. The temperature pulse is a pure sinusoid of the tick;
//     the neural read-outs come from economyReplay's `synthReadings/synthCollective` (FNV-1a, private salt);
//     every dynasty death (old age / penury / plague) is a deterministic hash01 draw inside the economy.
//   • The script runs the WHOLE simulation twice and asserts the two reports are byte-identical before writing
//     the artifact (`reproducibleRunToRun`). A baseline you cannot reproduce is not a baseline.
//   • NO LLM. NO network. NO chain. NO DO. Pure in-process AgentEconomy.
//
// READ-ONLY / ADDITIVE
//   It touches nothing on disk but its own evidence file, mutates no brain/wallet/digest, and reads only the
//   economy's own serialize()/leaderboard() out. The generation lineage is built by calling the SAME public
//   ledger hooks production uses (noteHatch / noteMortality) — no private access, no config written anywhere.
//
// DOCUMENTED BASELINE BOUNDARIES (stated honestly, mirrored in the artifact)
//   1. The PREDICTION layer is not exercised by a pure-economy local run, so `predictStats` is empty and every
//      `predictHitRate` is null. The capability signal carried by this baseline is survival / netUsdc-per-1k-tick
//      / settlement success / lifespan across generations. Phase 4 must compare like-for-like.
//   2. Per-agent band temperature = the market temperature at the agent's BIRTH tick (a reproducible per-agent
//      representative). The live /lineage/stats endpoint instead bins every agent by the single last-felt
//      temperature (a documented read-time proxy); the baseline uses the richer per-agent value so all three
//      temperature bands are populated and the band breakdown is meaningful.
//   3. Dynasty mortality thresholds are TIGHTENED via config overrides (oldAgeTicks / plagueTemp) purely so
//      deaths occur inside a ~1200-tick offline window; production defaults (OLD_AGE_DEFAULT≈150k) are untouched.
//
// Usage:
//   npx tsx scripts/baseline-curve.ts
//   npx tsx scripts/baseline-curve.ts --out ./baseline-evidence/pre-p1-generation-baseline.json --ticks 1200

import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { AgentEconomy, type EconomyConfig } from "../src/economy.js";
import { replayConfig, synthReadings, synthCollective } from "../src/economyReplay.js";
import { generationReport, type GenAgentEntry, type GenLeaderRow, type GenerationReportResult } from "../src/generationStats.js";

const here = path.dirname(fileURLToPath(import.meta.url));

// ── simulation knobs (all deterministic; none written to config.ts / wrangler.toml) ────────────────────────
const SEED = 0x5eed;
const POP = 24;                       // genesis cohort size
const BUDGET = 24;                    // per-tick deal budget (matches production cron)
const HATCH_TICKS = [100, 300, 550, 850]; // waves → gen1, gen2, gen3, gen4 (each descends from the prior)
const CHILDREN_PER_WAVE = 6;
const HATCH_SPREAD = 7;             // ticks between siblings, so one generation spans several temperature bands

interface Args { out?: string; ticks?: number; }
function parseArgs(argv: string[]): Args {
  const a: Args = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--out") a.out = argv[++i];
    else if (argv[i] === "--ticks") a.ticks = Number(argv[++i]);
  }
  return a;
}

/** Deterministic market-temperature pulse: a smooth sinusoid sweeping the COLD/CALM/HOT bands. Pure math. */
function temperatureAt(tick: number): number {
  const t = 0.5 + 0.45 * Math.sin(tick * 0.11);
  return t < 0 ? 0 : t > 1 ? 1 : t;
}

/** The simulated economy config for the baseline: plain market + dynasty ON with tightened mortality bounds. */
function baselineConfig(): EconomyConfig {
  return replayConfig({
    populationSize: POP,
    maxDealsPerTick: BUDGET,
    dynasty: {
      enabled: true,
      oldAgeTicks: 600,       // gen0 (born tick 0) ages out from tick 600; younger gens survive the window
      penuryGraceTicks: 50,   // a dealt fly silent on an empty wallet for 50 ticks is claimed by penury
      plagueTemp: 0.86,       // heat-plague draw may run at/above this (the sinusoid peaks at 0.95)
      plaguePct: 0.1,
    },
  });
}

/** Parse the economy's own serialize() into generationReport inputs (mirrors state.ts getLineageStats exactly). */
function foldLineage(econ: AgentEconomy, bornTempById: Map<number, number>, asOfTick: number): GenerationReportResult {
  let parsed: any = {};
  try { parsed = JSON.parse(econ.serialize()); } catch { parsed = {}; }
  const kin: any[] = Array.isArray(parsed?.dynasty?.kin) ? parsed.dynasty.kin : [];
  const agents: any[] = Array.isArray(parsed?.agents) ? parsed.agents : [];
  const deadSet = new Set<number>(Array.isArray(parsed?.dynasty?.dead) ? parsed.dynasty.dead.map(Number) : []);
  const graves: any[] = Array.isArray(parsed?.dynasty?.graves) ? parsed.dynasty.graves : [];
  const graveTickById = new Map<number, number>();
  for (const g of graves) { const id = Number(g?.id); if (!graveTickById.has(id)) graveTickById.set(id, Number(g?.tick) || 0); }
  const socialMem: any[] = Array.isArray(parsed?.social?.mem) ? parsed.social.mem : [];
  const socialById = new Map<number, { kept: number; broken: number }>();
  for (const m of socialMem) socialById.set(Number(m?.id), { kept: Number(m?.kept) || 0, broken: Number(m?.broken) || 0 });

  const entries: GenAgentEntry[] = [];
  const seen = new Set<number>();
  const push = (id: number, generation: number, bornTick: number): void => {
    if (!Number.isFinite(id) || seen.has(id)) return;
    seen.add(id);
    const alive = !deadSet.has(id);
    const soc = socialById.get(id);
    const settleOk = soc ? soc.kept : 0;
    const settleTotal = soc ? soc.kept + soc.broken : 0;
    // Per-agent representative temperature = the market temperature at its birth tick (see boundary note #2).
    const temperature = bornTempById.get(id) ?? temperatureAt(bornTick);
    entries.push({
      id, generation, bornTick,
      deathTick: alive ? null : (graveTickById.get(id) ?? null),
      alive, temperature, settleOk, settleTotal,
    });
  };
  for (const k of kin) push(Number(k?.id), Number(k?.gen) || 0, Number(k?.bornTick) || 0);
  for (const a of agents) push(Number(a?.id), 0, 0);

  const leaderboard: GenLeaderRow[] = econ.leaderboard().map((r) => ({ id: r.id, netUsdc: r.netUsdc, deals: r.deals, sales: r.sales }));
  // Boundary note #1: the prediction layer is not run in a pure-economy offline baseline ⇒ empty predictStats.
  return generationReport(entries, leaderboard, [], { asOfTick });
}

/** Drive one full multi-generation simulated run and fold it into the generation report. Deterministic. */
async function runBaseline(totalTicks: number): Promise<{ report: GenerationReportResult; deaths: number; hatched: number }> {
  const econ = new AgentEconomy(baselineConfig());
  const byGen: number[][] = [Array.from({ length: POP }, (_, i) => i)];
  let roster: number[] = [...byGen[0]];
  let nextId = POP;
  let hatched = 0;
  let deaths = 0;

  // Pre-compute the hatch plan: each wave's siblings are spread HATCH_SPREAD ticks apart so a single
  // generation is born across a range of market temperatures and lands in several bands (not one).
  const hatchPlan: { tick: number; parentGen: number; childIndex: number }[] = [];
  HATCH_TICKS.forEach((start, wave) => {
    for (let c = 0; c < CHILDREN_PER_WAVE; c++) hatchPlan.push({ tick: start + c * HATCH_SPREAD, parentGen: wave, childIndex: c });
  });
  hatchPlan.sort((x, y) => x.tick - y.tick);
  let planPtr = 0;

  const bornTempById = new Map<number, number>();
  for (const id of byGen[0]) bornTempById.set(id, temperatureAt(0));

  for (let tick = 1; tick <= totalTicks; tick++) {
    const temperature = temperatureAt(tick);
    const readings = synthReadings(roster, tick, temperature, SEED);
    const collective = synthCollective(temperature, roster.length);
    await econ.step(readings, collective, tick, BUDGET);

    // Hatch every child scheduled for this tick: it descends from its wave's generation (gen → gen+1).
    while (planPtr < hatchPlan.length && hatchPlan[planPtr].tick === tick) {
      const h = hatchPlan[planPtr++];
      const parents = byGen[h.parentGen] ?? [];
      if (!parents.length) continue;
      const parentId = parents[h.childIndex % parents.length];
      const childId = nextId++;
      econ.noteHatch(parentId, childId);          // child.gen = parent.gen + 1; bornTick = tick
      bornTempById.set(childId, temperature);
      byGen[h.parentGen + 1] = [...(byGen[h.parentGen + 1] ?? []), childId];
      roster.push(childId);
      hatched++;
    }

    // Deterministic mortality (old age / penury / plague); the dead leave the trading roster.
    const graves = econ.noteMortality(tick, temperature);
    for (const g of graves) {
      deaths++;
      const id = Number(g.id);
      const idx = roster.indexOf(id);
      if (idx >= 0) roster.splice(idx, 1);
    }
  }

  const report = foldLineage(econ, bornTempById, totalTicks + 1);
  return { report, deaths, hatched };
}

// A compact, human-diffable projection of the headline curve (what Phase 4 plots against the after-run).
function curveOf(report: GenerationReportResult) {
  return report.byGeneration.map((g) => ({
    generation: g.generation,
    agents: g.agents,
    survivalRate: Number(g.survivalRate.toFixed(4)),
    avgNetUsdcPer1kTick: Number(g.avgNetUsdcPer1kTick.toFixed(6)),
    settleSuccessRate: g.settleSuccessRate == null ? null : Number(g.settleSuccessRate.toFixed(4)),
    predictHitRate: g.predictHitRate == null ? null : Number(g.predictHitRate.toFixed(4)),
    avgLifespanTicks: Number(g.avgLifespanTicks.toFixed(2)),
  }));
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const totalTicks = Number.isFinite(args.ticks) && (args.ticks as number) > 0 ? (args.ticks as number) : 1200;
  const outPath = path.resolve(here, "..", args.out ?? "baseline-evidence/pre-p1-generation-baseline.json");

  // Run the whole simulation TWICE and require byte-identical reports (the reproducibility guarantee).
  const a = await runBaseline(totalTicks);
  const b = await runBaseline(totalTicks);
  const aJson = JSON.stringify(a.report);
  const bJson = JSON.stringify(b.report);
  const reproducible = aJson === bJson;

  const artifact = {
    artifact: "pre-p1-cross-generation-baseline",
    phase: "P0.4",
    generatedBy: "scripts/baseline-curve.ts",
    mode: "simulated",
    deterministic: true,
    reproducibleRunToRun: reproducible,
    llmCalls: 0,
    params: {
      seed: SEED,
      populationSize: POP,
      budget: BUDGET,
      totalTicks,
      hatchTicks: HATCH_TICKS,
      childrenPerWave: CHILDREN_PER_WAVE,
      hatchSpreadTicks: HATCH_SPREAD,
      temperatureFn: "0.5 + 0.45*sin(tick*0.11)",
      dynasty: { enabled: true, oldAgeTicks: 600, penuryGraceTicks: 50, plagueTemp: 0.86, plaguePct: 0.1 },
    },
    sim: { hatched: a.hatched, deaths: a.deaths },
    boundaries: [
      "Prediction layer not exercised by a pure-economy offline run => predictStats empty, predictHitRate null.",
      "Per-agent band temperature = market temperature at the agent's birth tick (reproducible representative).",
      "Dynasty mortality thresholds tightened via config overrides so deaths occur within the offline window; production defaults untouched.",
    ],
    curve: curveOf(a.report),
    report: a.report,
  };

  if (!reproducible) {
    console.error("[baseline] FATAL: two identical runs diverged — the baseline is NOT reproducible.");
    process.exit(1);
  }

  mkdirSync(path.dirname(outPath), { recursive: true });
  writeFileSync(outPath, JSON.stringify(artifact, null, 2), "utf8");

  // Human-readable summary.
  console.log(`[baseline] pre-Phase-1 cross-generation baseline (simulated, deterministic, reproducible=${reproducible})`);
  console.log(`[baseline] ticks=${totalTicks} pop=${POP} hatched=${a.hatched} deaths=${a.deaths} agents=${a.report.agents} generations=${a.report.generations}`);
  console.log("[baseline] capability curve (per generation):");
  console.log("  gen | agents | survival | netUsdc/1k | settleOk | lifespan");
  for (const c of artifact.curve) {
    const pad = (s: string, n: number) => s.padStart(n);
    console.log(
      `  ${pad(String(c.generation), 3)} | ${pad(String(c.agents), 6)} | ${pad(c.survivalRate.toFixed(3), 8)} | ` +
      `${pad(c.avgNetUsdcPer1kTick.toFixed(5), 10)} | ${pad(c.settleSuccessRate == null ? "n/a" : c.settleSuccessRate.toFixed(3), 8)} | ` +
      `${pad(c.avgLifespanTicks.toFixed(1), 8)}`,
    );
  }
  console.log(`[baseline] wrote ${outPath}`);
}

await main();
