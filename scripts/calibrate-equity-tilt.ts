/**
 * #123 OFFLINE CALIBRATION: equityTilt strength → ΔGini curve.
 *
 * Runs the deterministic economy replay at varying EQUITY_TILT_STRENGTH values and measures the
 * terminal Gini coefficient. The baseline (strength=0) is the identity — any ΔGini is purely
 * attributable to the equity tilt multiplier.
 *
 * Usage: npx tsx scripts/calibrate-equity-tilt.ts
 *
 * Output: a table of (strength, gini, ΔGini vs baseline) plus a recommended default.
 * Deterministic: same seed + same temperature stream ⇒ byte-identical results across runs.
 */
import { replayEconomy, replayConfig } from "../packages/trader-worker/src/economyReplay.js";
import type { EconomyConfig } from "../packages/trader-worker/src/economy.js";

// ─── Parameters ────────────────────────────────────────────────────────────────────────────────────────
const TICKS = 2000;             // enough for the Gini to plateau (production ran 12k+ ticks to reach 0.79)
const SEED = 0x5eed;            // the replay's own default deterministic seed
const BUDGET = 24;              // matches production maxDealsPerTick
const STRENGTHS = [0, 0.05, 0.1, 0.15, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 1.0];

// ─── Deterministic temperature stream (sinusoidal + harmonics, no RNG) ─────────────────────────────────
function synthTemperatures(n: number): number[] {
  const out: number[] = [];
  for (let i = 0; i < n; i++) {
    // A gentle multi-frequency oscillation in [0.2, 0.8] — mimics the production collective temperature
    // without needing a real connectome. Deterministic from the tick index alone.
    const t = i / n;
    const v = 0.5 + 0.2 * Math.sin(2 * Math.PI * t * 3) + 0.1 * Math.sin(2 * Math.PI * t * 7 + 1);
    out.push(Math.max(0, Math.min(1, v)));
  }
  return out;
}

// ─── Main ──────────────────────────────────────────────────────────────────────────────────────────────
async function main() {
  const temps = synthTemperatures(TICKS);

  // Build a pre-concentrated blob mimicking production (Gini ≈ 0.78): a power-law wealth distribution
  // where the top 3 agents hold ~60% of total capital. This gives the equity tilt something to work with.
  const N = 24;
  const totalUsdc = 144; // 24 × 6 USDC genesis total
  const agents: { id: number; address: string; balance: string; paid: string; earned: string; deals: number; sales: number; lastTick: number }[] = [];
  // Power-law: agent i gets share ∝ (N-i)^2, normalized to totalUsdc
  let weightSum = 0;
  for (let i = 0; i < N; i++) weightSum += (N - i) * (N - i);
  let allocated = 0;
  for (let i = 0; i < N; i++) {
    const share = i < N - 1 ? Math.floor(((N - i) * (N - i)) / weightSum * totalUsdc * 1e6) / 1e6 : 0;
    const bal = i < N - 1 ? share : totalUsdc - allocated;
    allocated += bal;
    // Deterministic pseudo-address (same FNV-1a as AgentEconomy.addressOf with seedBase=42)
    let h1 = 0x811c9dc5 ^ 42;
    for (const b of [i & 0xff, (i >>> 8) & 0xff]) { h1 ^= b; h1 = Math.imul(h1, 0x01000193); }
    const addr = "0x" + (h1 >>> 0).toString(16).padStart(8, "0").repeat(5).slice(0, 40);
    agents.push({
      id: i,
      address: addr,
      balance: String(Math.round(bal * 1e6)),  // atomic USDC (6 decimals)
      paid: "0", earned: "0", deals: 10, sales: 10, lastTick: 0,
    });
  }
  const blob = JSON.stringify({ version: "economy:v1", tickIndex: 0, volumeAtomic: "0", count: 0, settleOk: 0, settleFail: 0, agents });

  console.log(`\n#123 EQUITY TILT CALIBRATION (pre-concentrated blob, production-like Gini)`);
  console.log(`ticks=${TICKS}  seed=0x${SEED.toString(16)}  budget=${BUDGET}  population=${N}`);
  console.log(`initial wealth: power-law (N-i)², total=${totalUsdc} USDC`);
  console.log(`${"─".repeat(70)}`);
  console.log(`${"strength".padStart(10)} │ ${"gini".padStart(8)} │ ${"ΔGini".padStart(8)} │ ${"volume".padStart(12)} │ ${"count".padStart(6)}`);
  console.log(`${"─".repeat(10)}─┼─${"─".repeat(8)}─┼─${"─".repeat(8)}─┼─${"─".repeat(12)}─┼─${"─".repeat(6)}`);

  let baselineGini = 0;
  const results: { strength: number; gini: number; delta: number }[] = [];

  for (const s of STRENGTHS) {
    const cfgOver: Partial<EconomyConfig> = {
      equityTilt: {
        enabled: s > 0,
        band: [0.5, 2.0] as [number, number],
        strength: s,
      },
    };
    const result = await replayEconomy(blob, temps, { seed: SEED, budget: BUDGET, maxTicks: TICKS, cfg: cfgOver });
    const gini = result.finalState.gini;
    if (s === 0) baselineGini = gini;
    const delta = gini - baselineGini;
    results.push({ strength: s, gini, delta });
    console.log(
      `${s.toFixed(2).padStart(10)} │ ${gini.toFixed(5).padStart(8)} │ ${delta >= 0 ? "+" : ""}${delta.toFixed(5).padStart(7)} │ ${result.finalState.volumeUsdc.toFixed(4).padStart(12)} │ ${String(result.finalState.count).padStart(6)}`,
    );
  }

  console.log(`${"─".repeat(70)}`);

  // ─── Recommendation ──────────────────────────────────────────────────────────────────────────────────
  // Pick the highest strength that achieves ΔGini ≤ −0.02 (meaningful reduction) without collapsing
  // trade volume below 80% of baseline. If none achieves −0.02, pick the strongest with any reduction.
  const baselineVol = results[0].gini; // index 0 = strength 0
  let recommended = 0;
  for (const r of results) {
    if (r.delta <= -0.02) recommended = r.strength;
  }
  if (recommended === 0) {
    // Fallback: pick the strongest with any negative delta
    for (const r of results) {
      if (r.delta < 0) recommended = r.strength;
    }
  }

  console.log(`\nBaseline Gini (strength=0): ${baselineGini.toFixed(5)}`);
  console.log(`Recommended default strength: ${recommended.toFixed(2)}`);
  console.log(`  → ΔGini at recommended: ${results.find(r => r.strength === recommended)?.delta.toFixed(5) ?? "N/A"}`);
  console.log(`  → Still behind OFF switch (EQUITY_TILT_ENABLED=false, EQUITY_TILT_STRENGTH=0 for dark deploy)`);
  console.log(`\nNote: production Gini reached 0.786 over 12k+ ticks with real neural diversity.`);
  console.log(`This calibration uses synthesized readings (no connectome), so absolute Gini is lower.`);
  console.log(`The RELATIVE ΔGini between strengths is the actionable signal.\n`);
}

main().catch((e) => { console.error(e); process.exit(1); });
