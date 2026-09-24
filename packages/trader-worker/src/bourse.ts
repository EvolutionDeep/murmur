// ⑲ THE BOURSE — the swarm smells its own money.
//
// MURMUR (the project's ERC-20 on Arc mainnet) already lives BESIDE the colony: it denominates the
// human-vs-swarm arena and weights the community forum's votes. The Bourse brings it INSIDE the felt
// world — as a pure read-out membrane in the exact house style of ⑨ war / ⑬ tech / ⑭ cities:
//
//   · Each cron, ONE eth_getLogs reads the token's Transfer events since the last seen block
//     (read-only, keyless, zero gas — no wallet, no custody, no spend; the argus-issued contract is
//     never written to and its tax wallet is only ever OBSERVED).
//   · The legs are split: transfers INTO the configured tax wallet are the TITHE flow (argus auto-sweeps
//     that wallet, so the pulse is a FLOW, not a balance); every other leg is main activity. A main leg
//     above the whale threshold is a WHALE stir.
//   · A BourseMeter folds per-cron (txCount, volume) against slow EWMA baselines — the market.ts pattern —
//     into a coin FEVER 0..1, and edge-detects the four narratable moments: a fever breaking out, a whale
//     stirring, the cumulative tithe crossing a milestone, and a long silence.
//   · TWO output legs, both gated:
//       NARRATION — chronicler kinds COIN_FEVER / WHALE_MOVE / TITHE / COIN_SILENCE (folded into the
//                   context only while BOURSE_ENABLED; off ⇒ the chronicle is byte-for-byte the pre-bourse
//                   build).
//       FEELING — coinStimuli() maps the climate onto the SAME four visitor stimulus channels the ① neural
//                   feedback bus uses (food / threat / light / dark), riding the identical injection path
//                   (advanceFlies → encodeStimulus). Gated by TOKEN_STIMULUS_ENABLED (default OFF) and a
//                   master ceiling lower than the civic bus's, because unlike the civilizational climate
//                   THIS input is adversarially controllable: anyone with tokens can transfer. The defence
//                   is structural — unique-tx counting (a 100-leg airdrop is ONE tx), EWMA smoothing (a
//                   single spike cannot move the baseline), per-cron aggregation and the hard cap. A whale
//                   can whisper to the swarm; no fortune can command it.
//
// PRODUCTION RED LINES (same discipline as socialStimulus.ts):
//   • NO sensory channel is added — the four existing stimulus_* channels are reused, so the connectome's
//     structural spec and manifestHash NEVER rotate. No genome, no wiring, no ledger, no settlement touched.
//   • PURE + DETERMINISTIC cores: reduceTransferLogs / BourseMeter.update / coinStimuli take plain data in
//     and give bounded floats out — no RNG, no clock reads inside the math, unit-testable without an RPC.
//   • The on-chain read is RECORDED (lastBlock + meter state persist in the DO under bourse:v1) before any
//     narrative is derived, so the chronicle stays a function of stored state; an RPC failure simply skips
//     the cron (best-effort, never blocks the live tick) and the next cron resumes from the stored block.
//   • Cold start seeds the baselines with the first observation (fever 0.5 = calm by definition) exactly
//     like MarketMeter, and the sampled range is clamped to lookbackBlocks so a long outage can never ask
//     the RPC for an unbounded log range.

import type { RuntimeConfig } from "./config.js";
import { publicClient } from "./chain.js";
import { parseAbiItem } from "viem";
import type { StimulusEvent } from "@fly/fly-brain";

/** keccak256("Transfer(address,address,uint256)") — the standard ERC-20 transfer topic. */
export const TRANSFER_TOPIC =
  "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";

/** The same event as a viem ABI item (getLogs decodes args for us; the topic hash above documents it). */
const TRANSFER_EVENT = parseAbiItem(
  "event Transfer(address indexed from, address indexed to, uint256 value)",
);

/** One decoded ERC-20 Transfer leg (lowercased addresses; value in raw 18-dec units). */
export interface TransferLeg {
  from: string;
  to: string;
  value: bigint;
  txHash: string;
  blockNumber: number;
}

/** One cron's reduction of the token's on-chain life. All raw values are decimal strings (JSON-safe). */
export interface BourseSample {
  fromBlock: number;          // first block included (exclusive-low continuation from meter.lastBlock)
  toBlock: number;            // chain head at sample time (becomes the new lastBlock)
  txCount: number;            // UNIQUE tx hashes touching the token (burst-resistant activity count)
  transferCount: number;      // main legs (everything NOT going to the tax wallet)
  volumeRaw: string;          // Σ main-leg values, raw 18-dec
  taxRaw: string;             // Σ legs INTO the tax wallet this cron (the tithe flow)
  whaleCount: number;         // main legs ≥ the whale threshold
  whaleMaxRaw: string;        // largest single main leg (0 when none)
  addresses: number;          // unique addresses touched
  fetchedAt: number;          // wall-clock ms (informational only — never fed to the math)
}

/** The felt climate coinStimuli() reads — a narrow structural subset, unit-testable without a meter. */
export interface CoinClimate {
  /** Coin fever 0..1 (0.5 = in line with the learned baseline). */
  feverLevel: number;
  /** Consecutive crons with zero main-leg transfers. */
  quietCrons: number;
  /** Whale stir scaled 0..1 by log10(leg/threshold)/2, or null when no whale moved this cron. */
  whaleExcess: number | null;
  /** True ONLY on the cron the cumulative tithe crossed a milestone. */
  titheCrossed: boolean;
}

/** Everything the cron's consumers (stimulus fold, chronicler ctx, /bourse read-out) need. */
export interface BourseSignals {
  climate: CoinClimate;
  // --- edge events for the historian (at most one per kind per cron; null ⇒ the detector never speaks) ---
  fever: { txs: number; volumeMurmur: number; mult: number } | null;
  whale: { amountMurmur: number } | null;
  tithe: { milestoneMurmur: number; totalMurmur: number } | null;
  silence: { crons: number } | null;
  // --- steady read-outs for /bourse ---
  txs: number;
  volumeMurmur: number;
  taxTotalMurmur: number;
  whaleTotal: number;
  baselineTxs: number;
  baselineVolumeMurmur: number;
  lastBlock: number;
  quietCrons: number;
  sampledAt: number;
}

// --- deterministic constants (the calibration, frozen in code like socialStimulus.ts's mapping shape) ---

const EPS = 1e-9;
/** Consecutive silent crons before the dark edge fires (~45 min of a dead tape). */
export const QUIET_CRONS = 45;
/** Fever bands with hysteresis: the hot edge fires once per spell, never re-spoken while fever holds. */
const FEVER_HOT = 0.75;
const FEVER_HOT_RESET = 0.65;
/** Logistic sharpness for the activity ratio → fever (market.ts proved k≈3 against live Arc data). */
const FEVER_GAIN = 3.0;
/** Stimulus climate units (master-ceiling-scaled by the caller, exactly like the civic bus). */
const FOOD_MAX = 0.7;         // a full-blown fever tastes of plenty
const FOOD_ONSET = 0.55;        // fever above which the tape starts to smell appetitive
const THREAT_BASE = 0.35;       // any whale stir startles
const THREAT_WHALE_MAX = 0.35;  // …and a 100×-threshold leviathan doubles it
const LIGHT_TITHE = 0.45;       // a tithe milestone glows
const DARK_BASE = 0.25;         // a silent tape dims the world
const DARK_MAX = 0.5;           // …four hours of silence is the deepest dusk it can reach
const DARK_FULL_CRONS = 240;

function clamp01(x: number): number {
  return !Number.isFinite(x) ? 0 : x < 0 ? 0 : x > 1 ? 1 : x;
}

function logistic(ratio: number, k: number): number {
  if (!Number.isFinite(ratio)) return 0.5;
  return 1 / (1 + Math.exp(-k * (ratio - 1)));
}

/** raw 18-dec string → whole MURMUR as a double (supply is 1e9 ≪ 2^53/1e18, so display math is exact-safe). */
function toMurmur(raw: bigint | string): number {
  const v = typeof raw === "bigint" ? raw : safeBig(raw);
  return Number(v) / 1e18;
}

function safeBig(s: string): bigint {
  try { return BigInt(s); } catch { return 0n; }
}

// --- the pure reducer (unit-testable without any RPC) ---

/**
 * Split decoded Transfer legs into the cron's sample. The tax wallet's legs are the TITHE flow and are
 * excluded from volume/whale math (argus skims ~2% of every transfer into it and auto-sweeps the wallet,
 * so watching the FLOW — not the balance — is the honest pulse). A null taxWallet simply means no leg is
 * classified as tithe. Deterministic: same legs in ⇒ same sample out.
 */
export function reduceTransferLogs(
  legs: TransferLeg[],
  opts: { taxWallet: string | null; whaleRaw: bigint; fromBlock: number; toBlock: number; fetchedAt: number },
): BourseSample {
  const txs = new Set<string>();
  const addrs = new Set<string>();
  let volume = 0n;
  let tax = 0n;
  let whaleCount = 0;
  let whaleMax = 0n;
  let mainLegs = 0;
  for (const leg of legs) {
    txs.add(leg.txHash);
    addrs.add(leg.from);
    addrs.add(leg.to);
    if (opts.taxWallet && leg.to === opts.taxWallet) {
      tax += leg.value;
      continue; // the skim is not "activity" — it is the treasury's inflow
    }
    mainLegs++;
    volume += leg.value;
    if (leg.value >= opts.whaleRaw) {
      whaleCount++;
      if (leg.value > whaleMax) whaleMax = leg.value;
    }
  }
  return {
    fromBlock: opts.fromBlock,
    toBlock: opts.toBlock,
    txCount: txs.size,
    transferCount: mainLegs,
    volumeRaw: volume.toString(),
    taxRaw: tax.toString(),
    whaleCount,
    whaleMaxRaw: whaleMax.toString(),
    addresses: addrs.size,
    fetchedAt: opts.fetchedAt,
  };
}

// --- the meter (persisted; EWMA baselines + edge detection, the MarketMeter discipline) ---

const BOURSE_VERSION = 1;

export class BourseMeter {
  private baselineTx = 0;
  private baselineVol = 0n;
  private sampleCount = 0;
  private primed = false;
  private _lastBlock = 0;          // highest block already folded in (0 ⇒ cold start)
  private _quietCrons = 0;
  private taxTotalRaw = 0n;
  private lastMilestone = 0n;      // tithe milestones already spoken (index = totalRaw / milestoneRaw)
  private _whaleTotal = 0;
  private wasHot = false;          // fever hysteresis (a hot SPELL is announced once)
  private silenceAnnounced = false;
  private last: BourseSignals | null = null;

  /** Highest block already folded in; the sampler continues from lastBlock + 1. */
  get lastBlock(): number {
    return this._lastBlock;
  }

  /**
   * Fold one cron's sample in and return the signals. PURE: no I/O, no clock (sample.fetchedAt is carried
   * through informationally only). Deterministic given the same stored state + sample.
   */
  update(sample: BourseSample, cfg: { titheMilestoneRaw: bigint }): BourseSignals {
    this.sampleCount++;
    if (!this.primed) {
      // Cold start: seed with the first observation; fever is calm (0.5) by definition until a norm exists.
      this.baselineTx = sample.txCount;
      this.baselineVol = safeBig(sample.volumeRaw);
      this.primed = true;
    }

    const vol = safeBig(sample.volumeRaw);
    const txRatio = this.baselineTx > 1e-6 ? sample.txCount / this.baselineTx : 1;
    const volRatio = this.baselineVol > 0n ? Number((vol * 1000n) / this.baselineVol) / 1000 : 1;
    // Breadth over heaviness (market.ts's weighting): HOW MANY coin-txs happened matters more than size.
    const ratio = 0.6 * txRatio + 0.4 * volRatio;
    const feverLevel = logistic(ratio, FEVER_GAIN);

    // Adaptive alpha, fast at cold start so the seed cannot bias the run (MarketMeter's lesson).
    const aEff = Math.max(0.08, 1 / this.sampleCount);
    this.baselineTx += aEff * (sample.txCount - this.baselineTx);
    this.baselineVol += BigInt(Math.round(aEff * Number(vol - this.baselineVol)));
    if (this.baselineVol < 0n) this.baselineVol = 0n;

    // Tithe accumulation + milestone edge.
    this.taxTotalRaw += safeBig(sample.taxRaw);
    let tithe: BourseSignals["tithe"] = null;
    if (cfg.titheMilestoneRaw > 0n) {
      const idx = this.taxTotalRaw / cfg.titheMilestoneRaw;
      if (idx > this.lastMilestone) {
        this.lastMilestone = idx;
        tithe = {
          milestoneMurmur: toMurmur(idx * cfg.titheMilestoneRaw),
          totalMurmur: toMurmur(this.taxTotalRaw),
        };
      }
    }

    // Whale edge (per-cron; the historian's cooldown paces the lines).
    this._whaleTotal += sample.whaleCount;
    const whaleMax = safeBig(sample.whaleMaxRaw);
    const whale: BourseSignals["whale"] =
      sample.whaleCount > 0 && whaleMax > 0n ? { amountMurmur: toMurmur(whaleMax) } : null;

    // Fever hot-spell edge (hysteresis: announced on the way up, re-armed below FEVER_HOT_RESET).
    let fever: BourseSignals["fever"] = null;
    if (feverLevel >= FEVER_HOT && !this.wasHot) {
      fever = { txs: sample.txCount, volumeMurmur: toMurmur(vol), mult: Math.round(ratio * 100) / 100 };
    }
    if (feverLevel >= FEVER_HOT) this.wasHot = true;
    else if (feverLevel < FEVER_HOT_RESET) this.wasHot = false;

    // Silence edge (announced once per still spell; any activity re-arms it).
    this._quietCrons = sample.txCount === 0 ? this._quietCrons + 1 : 0;
    let silence: BourseSignals["silence"] = null;
    if (this._quietCrons >= QUIET_CRONS && !this.silenceAnnounced) {
      silence = { crons: this._quietCrons };
      this.silenceAnnounced = true;
    }
    if (this._quietCrons === 0) this.silenceAnnounced = false;

    this._lastBlock = sample.toBlock;

    // Whale stimulus scaling: log10(leg/threshold)/2 saturates at a 100× leviathan.
    let whaleExcess: number | null = null;
    if (sample.whaleCount > 0 && whaleMax > 0n) {
      // whaleRaw threshold is cfg-driven at the sampler; recompute the excess from the reported max by
      // storing the threshold used — simplest honest route: the sampler passes whaleRaw via update cfg.
      whaleExcess = clamp01(Math.log10(Math.max(1, toMurmur(whaleMax) / Math.max(1, this.whaleHint))) / 2);
    }

    this.last = {
      climate: {
        feverLevel,
        quietCrons: this._quietCrons,
        whaleExcess,
        titheCrossed: tithe !== null,
      },
      fever,
      whale,
      tithe,
      silence,
      txs: sample.txCount,
      volumeMurmur: toMurmur(vol),
      taxTotalMurmur: toMurmur(this.taxTotalRaw),
      whaleTotal: this._whaleTotal,
      baselineTxs: Math.round(this.baselineTx * 1000) / 1000,
      baselineVolumeMurmur: toMurmur(this.baselineVol),
      lastBlock: this._lastBlock,
      quietCrons: this._quietCrons,
      sampledAt: sample.fetchedAt,
    };
    return this.last;
  }

  /** The whale threshold (whole MURMUR) the meter scales whale stirs against — set by the caller each cron. */
  private whaleHint = 1_000_000;
  setWhaleHint(murmur: number): void {
    if (Number.isFinite(murmur) && murmur > 0) this.whaleHint = murmur;
  }

  /** The last computed signals (null before the first successful update) — for the /bourse read-out. */
  signals(): BourseSignals | null {
    return this.last;
  }

  // --- persistence (DO key bourse:v1; a corrupt/absent blob restarts cold, never poisons anything) ---

  serialize(): string {
    return JSON.stringify({
      v: BOURSE_VERSION,
      baselineTx: this.baselineTx,
      baselineVol: this.baselineVol.toString(),
      sampleCount: this.sampleCount,
      primed: this.primed,
      lastBlock: this._lastBlock,
      quietCrons: this._quietCrons,
      taxTotalRaw: this.taxTotalRaw.toString(),
      lastMilestone: this.lastMilestone.toString(),
      whaleTotal: this._whaleTotal,
      wasHot: this.wasHot,
      silenceAnnounced: this.silenceAnnounced,
      whaleHint: this.whaleHint,
    });
  }

  restore(blob: unknown): void {
    if (typeof blob !== "string" || !blob) return;
    try {
      const p = JSON.parse(blob);
      if (!p || typeof p !== "object") return;
      const n = (v: unknown, d: number) => (Number.isFinite(Number(v)) ? Number(v) : d);
      this.baselineTx = Math.max(0, n(p.baselineTx, 0));
      this.baselineVol = safeBig(String(p.baselineVol ?? "0"));
      if (this.baselineVol < 0n) this.baselineVol = 0n;
      this.sampleCount = Math.max(0, Math.floor(n(p.sampleCount, 0)));
      this.primed = !!p.primed;
      this._lastBlock = Math.max(0, Math.floor(n(p.lastBlock, 0)));
      this._quietCrons = Math.max(0, Math.floor(n(p.quietCrons, 0)));
      this.taxTotalRaw = safeBig(String(p.taxTotalRaw ?? "0"));
      if (this.taxTotalRaw < 0n) this.taxTotalRaw = 0n;
      this.lastMilestone = safeBig(String(p.lastMilestone ?? "0"));
      if (this.lastMilestone < 0n) this.lastMilestone = 0n;
      this._whaleTotal = Math.max(0, Math.floor(n(p.whaleTotal, 0)));
      this.wasHot = !!p.wasHot;
      this.silenceAnnounced = !!p.silenceAnnounced;
      this.whaleHint = n(p.whaleHint, 1_000_000) > 0 ? n(p.whaleHint, 1_000_000) : 1_000_000;
    } catch { /* corrupt → keep defaults (a cold restart, never a poison) */ }
  }
}

// --- the async sampler (the ONLY I/O in this module) ---

/**
 * Read the token's Transfer legs from `lastBlock + 1` to the chain head and reduce them to one sample.
 * The range is clamped to cfg.bourse.lookbackBlocks (a long outage resumes from head−lookback, never an
 * unbounded query). A zero-block window is a valid silent sample. Throws on RPC failure — the caller is
 * best-effort and simply skips the cron (lastBlock does not advance, so no block is ever skipped twice).
 */
export async function sampleBourseActivity(cfg: RuntimeConfig, lastBlock: number): Promise<BourseSample> {
  const b = cfg.bourse;
  if (!b.token) throw new Error("bourse: no token configured");
  const client = publicClient(cfg);
  const head = await client.getBlockNumber();
  const lookback = BigInt(Math.max(1, b.lookbackBlocks));
  let from = head > lookback ? head - lookback + 1n : 0n;
  if (lastBlock > 0) {
    const cont = BigInt(lastBlock) + 1n;
    if (cont > from) from = cont; // continue where the meter left off …
    if (from > head) from = head > lookback ? head - lookback + 1n : 0n; // … unless it is AHEAD (reorg/eviction): fall back
  }
  const whaleRaw = safeBig(b.whaleRaw);
  if (from > head) {
    return reduceTransferLogs([], {
      taxWallet: b.taxWallet, whaleRaw, fromBlock: Number(head), toBlock: Number(head), fetchedAt: Date.now(),
    });
  }
  const logs = await client.getLogs({
    address: b.token as `0x${string}`,
    event: TRANSFER_EVENT,
    fromBlock: from,
    toBlock: head,
  });
  const legs: TransferLeg[] = [];
  for (const log of logs) {
    const a = log.args;
    if (!a || typeof a.from !== "string" || typeof a.to !== "string" || typeof a.value !== "bigint") continue;
    legs.push({
      from: a.from.toLowerCase(),
      to: a.to.toLowerCase(),
      value: a.value,
      txHash: log.transactionHash ?? "",
      blockNumber: Number(log.blockNumber ?? from),
    });
  }
  return reduceTransferLogs(legs, {
    taxWallet: b.taxWallet,
    whaleRaw,
    fromBlock: Number(from),
    toBlock: Number(head),
    fetchedAt: Date.now(),
  });
}

// --- the felt leg (pure; mirrors socialStimuli's discipline exactly) ---

export interface CoinStimulusConfig {
  /** Hard ceiling on ANY one emitted channel's intensity, 0..1 (master scale; 0 ⇒ nothing is ever felt). */
  maxIntensity: number;
}

/**
 * Turn the coin climate into bounded visitor-channel stimuli. PURE + DETERMINISTIC: the same climate +
 * ceiling always yields the same events, in the civic bus's stable order (light/dark, then threat, then
 * food). Null climate (bourse off, or a cron the sampler skipped) ⇒ an empty array ⇒ the injected stimulus
 * array is byte-for-byte today's. At most THREE events; every intensity in [0, maxIntensity]; a NaN ceiling
 * can NEVER leak a NaN intensity into injectCurrent (the ① defence-in-depth).
 *
 * The mapping (climate units, frozen here like the civic bus's):
 *   fever > 0.55       → food   (a busy tape smells of plenty; scales to 0.7 at fever 1.0)
 *   whale stir         → threat (0.35 base + up to 0.35 more for a 100×-threshold leviathan)
 *   tithe milestone    → light  (0.45 — the treasury's pulse glows on the cron it crosses)
 *   silence ≥ 45 crons → dark   (0.25 base, deepening to 0.5 by ~4 silent hours)
 * Light and dark are mutually exclusive by construction (a tithe cross cannot coincide with a 45-cron
 * silence — crossing requires transfers — but the dominance rule holds regardless).
 */
export function coinStimuli(climate: CoinClimate | null, cfg: CoinStimulusConfig): StimulusEvent[] {
  if (!climate) return [];
  const cap = clamp01(cfg.maxIntensity);
  // NaN-safe gate: `!(cap > 0)` is true for both 0 and NaN (the socialStimulus.ts lesson).
  if (!(cap > 0)) return [];

  const food = climate.feverLevel > FOOD_ONSET
    ? FOOD_MAX * clamp01((climate.feverLevel - FOOD_ONSET) / (1 - FOOD_ONSET))
    : 0;
  const threat = climate.whaleExcess != null && Number.isFinite(climate.whaleExcess)
    ? Math.min(THREAT_BASE + THREAT_WHALE_MAX * clamp01(climate.whaleExcess), THREAT_BASE + THREAT_WHALE_MAX)
    : 0;
  let bright = 0;
  if (climate.titheCrossed) bright += LIGHT_TITHE;
  if (climate.quietCrons >= QUIET_CRONS) {
    bright -= DARK_BASE + (DARK_MAX - DARK_BASE) *
      clamp01((climate.quietCrons - QUIET_CRONS) / (DARK_FULL_CRONS - QUIET_CRONS));
  }

  const out: StimulusEvent[] = [];
  if (bright > EPS) out.push({ type: "light", intensity: clamp01(bright) * cap, from: "coin-climate" });
  else if (bright < -EPS) out.push({ type: "dark", intensity: clamp01(-bright) * cap, from: "coin-climate" });
  if (threat > EPS) out.push({ type: "threat", intensity: clamp01(threat) * cap, from: "coin-climate" });
  if (food > EPS) out.push({ type: "food", intensity: clamp01(food) * cap, from: "coin-climate" });
  return out;
}
