// P0.4 — Generation statistics read-out (the "capability ④" measurement lens).
//
// A PURE function over data the system ALREADY keeps: the breeding lineage (which generation each fly
// embodies), the economy leaderboard (per-agent realized PnL + deal counts), the prediction leaderboard
// (per-agent hit rate) and each fly's lifespan + the market temperature it lived through. It adds ZERO new
// persisted state — it is a read-time aggregation, so it can never perturb the simulation, the manifestHash or
// the PoCA digest. Phase 4 will diff a post-playbook run against the frozen pre-Phase-1 baseline this produces.
//
// For each generation g, binned by the market-temperature band the agents lived in (COLD / CALM / HOT), it
// reports: survival rate, average netUsdc per 1000 ticks, settlement success rate (settleOk / total attempts),
// prediction hit rate, and average lifespan. NO LLM, NO RNG, NO wall clock — a deterministic fold.

/** One roster agent's generation + lifespan + temperature linkage (assembled read-time from existing data). */
export interface GenAgentEntry {
  id: number;
  /** Genome generation this agent embodies (0 = genesis founder). */
  generation: number;
  /** Sub-tick the agent was founded/hatched. */
  bornTick: number;
  /** Sub-tick the agent was buried; null while still alive. */
  deathTick: number | null;
  /** Whether the agent is still flying. */
  alive: boolean;
  /** Representative market temperature over the agent's life (0..1) — drives the band binning. */
  temperature: number;
  /** This agent's successful settlements (deals closed). */
  settleOk: number;
  /** This agent's total settlement attempts (successes + declines/failures). */
  settleTotal: number;
}

/** Per-agent economic performance (a structural subset of the economy leaderboard row). */
export interface GenLeaderRow {
  id: number;
  netUsdc: number;
  deals: number;
  sales: number;
}

/** Per-agent prediction record (a structural subset of the prediction leaderboard row). */
export interface GenPredictRow {
  id: number;
  rounds: number;
  hits: number;
}

export type TempBand = "COLD" | "CALM" | "HOT";

/** One (generation × temperature-band) cell of the report. */
export interface GenerationBin {
  generation: number;
  band: TempBand;
  /** Agents in this cell. */
  agents: number;
  /** alive / agents (0..1). */
  survivalRate: number;
  /** Mean over agents of (netUsdc per 1000 ticks of life); 0 when the bin is empty. */
  avgNetUsdcPer1kTick: number;
  /** sum(settleOk) / sum(settleTotal) across the bin; null when no attempts were made. */
  settleSuccessRate: number | null;
  /** sum(hits) / sum(rounds) across the bin; null when no decisive rounds were bet. */
  predictHitRate: number | null;
  /** Mean lifespan in sub-ticks (alive agents measured up to `asOfTick`). */
  avgLifespanTicks: number;
}

/** The per-generation rollup across all temperature bands (the headline "capability curve"). */
export interface GenerationRollup {
  generation: number;
  agents: number;
  survivalRate: number;
  avgNetUsdcPer1kTick: number;
  settleSuccessRate: number | null;
  predictHitRate: number | null;
  avgLifespanTicks: number;
  /** The band breakdown for this generation (same cells, filtered). */
  bands: GenerationBin[];
}

export interface GenerationReportResult {
  /** The tick the lifespan of still-alive agents is measured up to. */
  asOfTick: number;
  /** Highest generation present (0 when there are no entries). */
  generations: number;
  /** Total agents folded. */
  agents: number;
  /** Per-generation headline curve, ascending by generation. */
  byGeneration: GenerationRollup[];
  /** Every (generation × band) cell, ascending by generation then band order COLD<CALM<HOT. */
  bins: GenerationBin[];
}

export interface GenerationReportOptions {
  /** The tick still-alive agents are measured up to (default: max(deathTick ?? bornTick) + 1 over entries). */
  asOfTick?: number;
  /** Override the COLD upper threshold (default 0.33). */
  coldMax?: number;
  /** Override the HOT lower threshold (default 0.66). */
  hotMin?: number;
}

const BAND_ORDER: Record<TempBand, number> = { COLD: 0, CALM: 1, HOT: 2 };
const BANDS: TempBand[] = ["COLD", "CALM", "HOT"];

function bandOf(temperature: number, coldMax: number, hotMin: number): TempBand {
  return temperature >= hotMin ? "HOT" : temperature <= coldMax ? "COLD" : "CALM";
}

interface Acc {
  agents: number;
  alive: number;
  lifespanSum: number;
  netPer1kSum: number;
  settleOk: number;
  settleTotal: number;
  hits: number;
  rounds: number;
}
const emptyAcc = (): Acc => ({
  agents: 0, alive: 0, lifespanSum: 0, netPer1kSum: 0, settleOk: 0, settleTotal: 0, hits: 0, rounds: 0,
});

function finalizeAcc(generation: number, band: TempBand, a: Acc): GenerationBin {
  const n = a.agents;
  return {
    generation,
    band,
    agents: n,
    survivalRate: n ? a.alive / n : 0,
    avgNetUsdcPer1kTick: n ? a.netPer1kSum / n : 0,
    settleSuccessRate: a.settleTotal > 0 ? a.settleOk / a.settleTotal : null,
    predictHitRate: a.rounds > 0 ? a.hits / a.rounds : null,
    avgLifespanTicks: n ? a.lifespanSum / n : 0,
  };
}

/**
 * Fold the roster into a per-generation, per-temperature-band capability report. PURE: no state, no RNG, no
 * clock (the only time reference is `asOfTick`, derived from the entries themselves unless overridden).
 *
 * @param entries      per-agent generation + lifespan + temperature linkage (existing lineage/dynasty/history data)
 * @param leaderboard  per-agent realized PnL (existing economy leaderboard)
 * @param predictStats per-agent prediction record (existing prediction leaderboard)
 */
export function generationReport(
  entries: GenAgentEntry[],
  leaderboard: GenLeaderRow[],
  predictStats: GenPredictRow[],
  opts: GenerationReportOptions = {},
): GenerationReportResult {
  const coldMax = opts.coldMax ?? 0.33;
  const hotMin = opts.hotMin ?? 0.66;

  // Index the performance tables by agent id (a read-time join; missing rows ⇒ zeros).
  const netById = new Map<number, number>();
  for (const r of leaderboard) netById.set(r.id, Number(r.netUsdc) || 0);
  const predictById = new Map<number, { rounds: number; hits: number }>();
  for (const p of predictStats) predictById.set(p.id, { rounds: Math.max(0, p.rounds | 0), hits: Math.max(0, p.hits | 0) });

  // asOfTick: the horizon still-alive agents are measured up to. Default = one past the latest known event.
  let asOfTick = opts.asOfTick ?? 0;
  if (opts.asOfTick == null) {
    for (const e of entries) {
      const end = e.deathTick != null ? e.deathTick : e.bornTick;
      if (end + 1 > asOfTick) asOfTick = end + 1;
    }
  }

  // One accumulator per (generation, band) cell + one per generation (the rollup).
  const cells = new Map<string, Acc>();
  const gens = new Map<number, Acc>();
  const cellKey = (g: number, b: TempBand): string => `${g}|${b}`;

  let maxGen = 0;
  for (const e of entries) {
    const generation = Math.max(0, Math.floor(e.generation) || 0);
    if (generation > maxGen) maxGen = generation;
    const band = bandOf(typeof e.temperature === "number" ? e.temperature : 0, coldMax, hotMin);
    const lifespan = Math.max(0, (e.deathTick != null ? e.deathTick : asOfTick) - e.bornTick);
    const netUsdc = netById.get(e.id) ?? 0;
    // netUsdc per 1000 ticks of life; a zero-tick life contributes its raw net (no division blow-up).
    const netPer1k = lifespan > 0 ? (netUsdc / lifespan) * 1000 : netUsdc;
    const pred = predictById.get(e.id);
    const alive = e.alive ? 1 : 0;

    const ck = cellKey(generation, band);
    let cell = cells.get(ck);
    if (!cell) { cell = emptyAcc(); cells.set(ck, cell); }
    let gen = gens.get(generation);
    if (!gen) { gen = emptyAcc(); gens.set(generation, gen); }

    for (const a of [cell, gen]) {
      a.agents++;
      a.alive += alive;
      a.lifespanSum += lifespan;
      a.netPer1kSum += netPer1k;
      a.settleOk += Math.max(0, e.settleOk | 0);
      a.settleTotal += Math.max(0, e.settleTotal | 0);
      if (pred) { a.hits += pred.hits; a.rounds += pred.rounds; }
    }
  }

  // Build the per-generation rollups (ascending), each carrying its band breakdown (COLD<CALM<HOT).
  const byGeneration: GenerationRollup[] = [];
  const bins: GenerationBin[] = [];
  const sortedGens = Array.from(gens.keys()).sort((x, y) => x - y);
  for (const g of sortedGens) {
    const bandCells: GenerationBin[] = [];
    for (const b of BANDS) {
      const acc = cells.get(cellKey(g, b));
      if (acc && acc.agents > 0) {
        const bin = finalizeAcc(g, b, acc);
        bandCells.push(bin);
        bins.push(bin);
      }
    }
    byGeneration.push({ ...finalizeAcc(g, "CALM", gens.get(g)!), bands: bandCells } as GenerationRollup);
  }
  // The rollup's own `band` field is meaningless (it spans all bands); normalize it out of the headline.
  for (const r of byGeneration) (r as unknown as { band: undefined }).band = undefined;

  return { asOfTick, generations: maxGen, agents: entries.length, byGeneration, bins };
}
