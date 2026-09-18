// PredictionMarket — the fly swarm bets real USDC on the NEXT tick's market temperature, and Arc
// itself resolves the round.
//
// THE IDEA. Every cron opens one round: each fly reads the market pulse its 10,800-neuron connectome
// just felt and takes a directional position on whether the Arc-activity temperature will be HIGHER or
// LOWER at the next cron. Stakes are pooled parimutuel-style; the next cron's freshly-sampled
// temperature resolves the round (UP / DOWN / FLAT), winners split the losers' pool pro-rata, and the
// net PnL flows between agents through the EXACT same netting + EIP-3009 + registry rails as neural
// trades (see economy.absorbFlows). No human and no LLM picks a side or a payout — the spiking network
// leans, and the chain decides.
//
// WHY IT'S TRUSTWORTHY. Each resolved round is reduced to a canonical receipt (entry/exit temperature,
// the flat band, the outcome, and every bet with its frozen neural evidence + payout) and hashed. That
// hash is committed to the SAME on-chain NeuralReceiptRegistry the net receipts use, sharing one linear
// chain head, so a sceptic can rebuild the ordered resolution history from Arc RPC events alone and
// recompute every payout — no murmur server in the loop (see /predictions/verify).
//
// ZERO-SUM, NO HOUSE. The protocol never mints or takes a cut: Σpayouts == Σstakes and Σnet == 0 for
// every round. A FLAT resolution — or a one-sided book with nobody backing the winner — refunds every
// stake (there is no house to absorb an unmatched pool), so nothing moves. This is a strict read-out of
// the neural layer (one-directional): it never feeds back into the connectome.

import type { FlyReading } from "./population.js";
import { neuralEvidence, sha256Hex, type NeuralEvidence } from "./provenance.js";
import { atomicToUsdc, usdcToAtomic, addAtomic } from "./x402.js";

/** Bump when the round-receipt schema changes (invalidates old hashes' comparability, not validity). */
export const PREDICT_PROOF_VERSION = 1;
/** Bump whenever the bet-placement / resolution policy changes (mixed into every round receipt). */
export const PREDICT_POLICY_VERSION = "predict-v1";
/** Persistence envelope version for PredictionMarket.serialize(). */
export const PREDICT_KEY_VERSION = "predict:v1";

/** Which direction an agent backs: temperature higher (UP) or lower (DOWN) at the next cron. */
export type PredictSide = "UP" | "DOWN";
/** How a round resolved: a decisive move past the flat band, or FLAT (inside it ⇒ full refund). */
export type PredictOutcome = "UP" | "DOWN" | "FLAT";

/** One agent's open bet in a live round — stake frozen at entry, evidence = the neural read-out behind it. */
export interface PredictBet {
  id: number;
  side: PredictSide;
  stake: string;             // atomic USDC (6-dec) as a decimal string
  evidence: NeuralEvidence;  // frozen drives that placed this bet (hashed into the round receipt)
}

/** A resolved bet: parimutuel payout + signed net PnL + whether the side matched the outcome. */
export interface ResolvedBet {
  id: number;
  side: PredictSide;
  stake: string;
  payout: string;            // atomic returned to the bettor (stake + share of the losing pool; 0 if lost)
  net: string;               // SIGNED atomic PnL (payout − stake); "0" on a refund
  hit: boolean;              // side === outcome (a FLAT refund is never a "hit")
  evidence: NeuralEvidence;  // carried through so the receipt is self-contained + recomputable
}

/** A live, open round: agents have bet; resolution is pending the next cron's temperature. */
export interface OpenRound {
  round: number;
  entryTick: number;
  entryTemp: number;         // temperature when the round opened (the resolution baseline)
  momentum: number;          // pulse momentum at entry — the "heating/cooling" read the swarm bet on
  bets: PredictBet[];
  poolUp: string;            // atomic staked on UP
  poolDown: string;          // atomic staked on DOWN
  openedAt: number;
}

/**
 * One bilateral net transfer produced by resolving a round (debtor → creditor). Fed straight into
 * economy.absorbFlows so prediction money settles through the SAME netting/flush path as neural trades
 * — never a separate on-chain money path. Carries both sides' neural evidence for the net receipt.
 */
export interface PredictFlow {
  round: number;
  fromId: number;            // debtor (net loser)
  toId: number;              // creditor (net winner)
  amount: string;            // atomic USDC > 0
  from: NeuralEvidence;
  to: NeuralEvidence;
}

/** A fully resolved round: outcome, per-bet payouts, the money flows and the verifiable receipt hash. */
export interface ResolvedRound {
  round: number;
  entryTick: number;
  exitTick: number;
  entryTemp: number;
  exitTemp: number;
  delta: number;             // exitTemp − entryTemp (the resolved move)
  flatBand: number;          // |delta| ≤ this ⇒ FLAT
  outcome: PredictOutcome;
  poolUp: string;
  poolDown: string;
  totalStaked: string;       // poolUp + poolDown (atomic)
  bets: ResolvedBet[];
  flows: PredictFlow[];      // bilateral settlements (derived; not part of the hashed receipt)
  receiptHash: string;       // sha256 of the canonical round receipt (64-hex, no 0x)
  commitTx?: string;         // registry tx that moved the on-chain head here (absent ⇒ not committed)
  resolvedAt: number;
}

/** Lifetime prediction record for one agent — the hit-rate leaderboard. */
export interface PredictAgentStat {
  id: number;
  rounds: number;            // DECISIVE rounds bet (FLAT refunds excluded — they are not calls)
  hits: number;              // decisive rounds where side === outcome
  pnlAtomic: string;         // signed cumulative net PnL (atomic)
  stakedAtomic: string;      // cumulative staked (atomic)
}

/** One leaderboard row for the frontend. */
export interface PredictLeaderRow {
  id: number;
  rounds: number;
  hits: number;
  hitRate: number;           // hits / rounds (0 when no decisive rounds yet)
  pnlUsdc: number;
  pnlAtomic: string;
  stakedUsdc: number;
}

export interface PredictConfig {
  enabled: boolean;
  network: string;           // arcNetworkTag(isTestnet) — bound into every receipt
  stakeUsdc: number;         // base stake per bet (scaled by arousal, capped below)
  maxStakeUsdc: number;      // hard per-bet ceiling
  flatBand: number;          // |Δtemperature| ≤ this ⇒ FLAT (refund); a dead zone for noise
  commit: boolean;           // commit decisive resolutions to the on-chain NeuralReceiptRegistry
  recentCap: number;         // resolved rounds kept for display / verification
}

/** The /predictions payload: the live book + odds, recent resolutions and the hit-rate leaderboard. */
export interface PredictSnapshot {
  enabled: boolean;
  network: string;
  config: { stakeUsdc: number; maxStakeUsdc: number; flatBand: number; commit: boolean };
  open: {
    round: number;
    entryTick: number;
    entryTemp: number;
    momentum: number;
    openedAt: number;
    poolUp: string;
    poolDown: string;
    poolUpUsdc: number;
    poolDownUsdc: number;
    betCount: number;
    /** Parimutuel payout multiple for a winning UP/DOWN bet (totalPool ÷ that side's pool). */
    oddsUp: number;
    oddsDown: number;
    /** Implied probability of each side (that side's share of the pool). */
    probUp: number;
    probDown: number;
    bets: { id: number; side: PredictSide; stake: string; stakeUsdc: number }[];
  } | null;
  recent: {
    round: number;
    entryTick: number;
    exitTick: number;
    entryTemp: number;
    exitTemp: number;
    delta: number;
    outcome: PredictOutcome;
    poolUp: string;
    poolDown: string;
    totalStaked: string;
    totalStakedUsdc: number;
    betCount: number;
    flowCount: number;
    receiptHash: string;
    commitTx: string | null;
    resolvedAt: number;
  }[];
  leaderboard: PredictLeaderRow[];
  totals: {
    roundsResolved: number;
    committed: number;       // resolutions registered on-chain
    volumeUsdc: number;      // cumulative total staked across resolved rounds
    activeBettors: number;
  };
}

/** Round to 6 decimals so a float survives a JSON round-trip into a stable hash input. */
const r6 = (x: number): number => Math.round(x * 1e6) / 1e6;
const clamp01 = (x: number): number => (x < 0 ? 0 : x > 1 ? 1 : x);
/** Human USDC → atomic bigint (6-dec), clamped at 0. */
const atomic = (usdc: number): bigint => BigInt(usdcToAtomic(usdc));

export class PredictionMarket {
  private cfg: PredictConfig;
  private roundCounter = 0;
  private open: OpenRound | null = null;
  private recent: ResolvedRound[] = [];
  private stats = new Map<number, PredictAgentStat>();
  private resolvedCount = 0;
  private committedCount = 0;
  private volumeAtomic = "0";

  constructor(cfg: PredictConfig, restored?: string) {
    this.cfg = cfg;
    if (restored) {
      try { this.restore(restored); } catch { /* a corrupt blob must never take the tick down */ }
    }
  }

  get enabled(): boolean {
    return this.cfg.enabled;
  }

  /**
   * Open the next round from the current cron's fresh neural read-out. A resting fly sits out; otherwise
   * its directional lean (turnBias) plus a momentum-following term picks the side, arousal sizes the
   * stake, and the stake is capped at a quarter of the agent's (mirror) balance so one round can never
   * drain a wallet. Any still-open prior round is dropped — the cron always resolves before opening, so
   * this is a safety net, not the normal path. Returns the opened round (null when disabled).
   */
  openRound(
    readings: FlyReading[],
    entryTemp: number,
    momentum: number,
    tick: number,
    balanceOf: (id: number) => string,
  ): OpenRound | null {
    if (!this.cfg.enabled || readings.length === 0) return null;
    this.roundCounter++;
    const maxAtomic = atomic(this.cfg.maxStakeUsdc);
    const bets: PredictBet[] = [];
    let poolUp = 0n;
    let poolDown = 0n;
    for (const r of readings) {
      if (r.rest > 0.6) continue;   // a resting fly barely participates (mirrors the trade layer)
      // Direction: the fly's intrinsic turn lean, tilted by how strongly the market is currently moving
      // (momentum) weighted by this fly's arousal — an aroused fly chases the trend harder.
      const score = r.turnBias + 0.5 * momentum * (0.5 + clamp01(r.arousal));
      const side: PredictSide = score >= 0 ? "UP" : "DOWN";
      let stake = atomic(this.cfg.stakeUsdc * (0.4 + 0.6 * clamp01(r.arousal)));
      if (stake > maxAtomic) stake = maxAtomic;
      if (stake <= 0n) continue;
      const quarter = BigInt(balanceOf(r.id) || "0") / 4n;
      if (quarter <= 0n) continue;  // nothing to risk
      if (stake > quarter) stake = quarter;
      bets.push({ id: r.id, side, stake: stake.toString(), evidence: neuralEvidence(r) });
      if (side === "UP") poolUp += stake;
      else poolDown += stake;
    }
    this.open = {
      round: this.roundCounter,
      entryTick: tick,
      entryTemp,
      momentum,
      bets,
      poolUp: poolUp.toString(),
      poolDown: poolDown.toString(),
      openedAt: Date.now(),
    };
    return this.open;
  }

  /**
   * Resolve the open round against the freshly-sampled exit temperature. Parimutuel: winners split the
   * losers' pool pro-rata (bigint-exact, remainder to the biggest winner), so Σpayouts == Σstakes and
   * Σnet == 0. FLAT — or a one-sided book with no winners — refunds everyone (no house to absorb it).
   * Returns the resolved round plus the bilateral flows to settle, or null when nothing was open.
   */
  async resolveRound(
    exitTemp: number,
    tick: number,
  ): Promise<{ round: ResolvedRound; flows: PredictFlow[] } | null> {
    const open = this.open;
    if (!open) return null;
    this.open = null;

    const delta = exitTemp - open.entryTemp;
    const flatBand = this.cfg.flatBand;
    const outcome: PredictOutcome =
      delta > flatBand ? "UP" : delta < -flatBand ? "DOWN" : "FLAT";

    const poolUp = BigInt(open.poolUp);
    const poolDown = BigInt(open.poolDown);
    const winSide: PredictSide | null = outcome === "FLAT" ? null : (outcome as PredictSide);
    let winPool = 0n;
    let losePool = 0n;
    if (winSide) {
      for (const b of open.bets) {
        if (b.side === winSide) winPool += BigInt(b.stake);
        else losePool += BigInt(b.stake);
      }
    }
    // Refund when the round is FLAT, or when nobody backed the winning side (winPool == 0): with no
    // house, an unmatched pool can only be returned — this is what keeps every round strictly zero-sum.
    const refund = winSide == null || winPool == 0n;

    const resolved: ResolvedBet[] = [];
    const winners: { idx: number; stake: bigint }[] = [];
    for (let i = 0; i < open.bets.length; i++) {
      const b = open.bets[i];
      if (refund) {
        resolved.push({ id: b.id, side: b.side, stake: b.stake, payout: b.stake, net: "0", hit: false, evidence: b.evidence });
      } else if (b.side === winSide) {
        winners.push({ idx: i, stake: BigInt(b.stake) });
        // payout starts at the returned stake; the pro-rata share of losePool is added below.
        resolved.push({ id: b.id, side: b.side, stake: b.stake, payout: b.stake, net: "0", hit: true, evidence: b.evidence });
      } else {
        resolved.push({ id: b.id, side: b.side, stake: b.stake, payout: "0", net: "-" + b.stake, hit: false, evidence: b.evidence });
      }
    }

    if (!refund && losePool > 0n && winPool > 0n) {
      let distributed = 0n;
      let biggestIdx = -1;
      let biggestStake = -1n;
      for (const w of winners) {
        const share = (losePool * w.stake) / winPool;   // integer floor; remainder handled after
        distributed += share;
        const r = resolved[w.idx];
        r.payout = (BigInt(r.payout) + share).toString();
        if (w.stake > biggestStake) { biggestStake = w.stake; biggestIdx = w.idx; }
      }
      // Give the indivisible remainder to the largest winner so the pool is fully conserved (Σpayout==Σstake).
      const remainder = losePool - distributed;
      if (remainder > 0n && biggestIdx >= 0) {
        const r = resolved[biggestIdx];
        r.payout = (BigInt(r.payout) + remainder).toString();
      }
      for (const w of winners) {
        const r = resolved[w.idx];
        r.net = (BigInt(r.payout) - BigInt(r.stake)).toString();
      }
    }

    const flows = this.netsToFlows(open, resolved);

    // Update the hit-rate leaderboard. FLAT refunds are not decisive calls, so they do not count toward
    // rounds/hits (they would drag every agent equally); PnL always accumulates (0 on a refund).
    for (const r of resolved) {
      let s = this.stats.get(r.id);
      if (!s) { s = { id: r.id, rounds: 0, hits: 0, pnlAtomic: "0", stakedAtomic: "0" }; this.stats.set(r.id, s); }
      s.stakedAtomic = addAtomic(s.stakedAtomic, r.stake);
      s.pnlAtomic = (BigInt(s.pnlAtomic) + BigInt(r.net)).toString();
      if (outcome !== "FLAT") { s.rounds++; if (r.hit) s.hits++; }
    }

    const rr: ResolvedRound = {
      round: open.round,
      entryTick: open.entryTick,
      exitTick: tick,
      entryTemp: open.entryTemp,
      exitTemp,
      delta,
      flatBand,
      outcome,
      poolUp: open.poolUp,
      poolDown: open.poolDown,
      totalStaked: (poolUp + poolDown).toString(),
      bets: resolved,
      flows,
      receiptHash: "",
      resolvedAt: Date.now(),
    };
    rr.receiptHash = await sha256Hex(roundReceipt(rr, this.cfg.network));

    this.recent.unshift(rr);
    if (this.recent.length > this.cfg.recentCap) this.recent.length = this.cfg.recentCap;
    this.resolvedCount++;
    this.volumeAtomic = addAtomic(this.volumeAtomic, rr.totalStaked);
    return { round: rr, flows };
  }

  /**
   * Turn per-agent net PnL into bilateral debtor→creditor transfers by greedy matching (both sides
   * sorted by magnitude, largest first). Because Σnet == 0, this clears every balance exactly and the
   * flows sum to the total won. Minimising the number of transfers also minimises on-chain txs.
   */
  private netsToFlows(open: OpenRound, resolved: ResolvedBet[]): PredictFlow[] {
    const ev = new Map<number, NeuralEvidence>();
    for (const b of open.bets) ev.set(b.id, b.evidence);
    const debtors: { id: number; owe: bigint }[] = [];
    const creditors: { id: number; due: bigint }[] = [];
    for (const r of resolved) {
      const net = BigInt(r.net);
      if (net < 0n) debtors.push({ id: r.id, owe: -net });
      else if (net > 0n) creditors.push({ id: r.id, due: net });
    }
    const byMag = (a: bigint, b: bigint, ai: number, bi: number) =>
      a > b ? -1 : a < b ? 1 : ai - bi;
    debtors.sort((x, y) => byMag(x.owe, y.owe, x.id, y.id));
    creditors.sort((x, y) => byMag(x.due, y.due, x.id, y.id));

    const flows: PredictFlow[] = [];
    let i = 0;
    let j = 0;
    while (i < debtors.length && j < creditors.length) {
      const d = debtors[i];
      const c = creditors[j];
      const move = d.owe < c.due ? d.owe : c.due;
      if (move > 0n) {
        const fromEv = ev.get(d.id);
        const toEv = ev.get(c.id);
        if (fromEv && toEv) {
          flows.push({ round: open.round, fromId: d.id, toId: c.id, amount: move.toString(), from: fromEv, to: toEv });
        }
      }
      d.owe -= move;
      c.due -= move;
      if (d.owe === 0n) i++;
      if (c.due === 0n) j++;
    }
    return flows;
  }

  /** Record the registry tx that committed a round's receipt on-chain (best-effort; null ⇒ not committed). */
  setCommitTx(round: number, tx: string | null): void {
    if (!tx) return;
    const rr = this.recent.find((r) => r.round === round);
    if (rr && !rr.commitTx) { rr.commitTx = tx; this.committedCount++; }
  }

  /** The most recent resolved round (for the frontend header / telemetry), or null. */
  lastResolved(): ResolvedRound | null {
    return this.recent.length ? this.recent[0] : null;
  }

  /**
   * Recompute a stored round's receipt hash and confirm it matches what was published. Self-contained:
   * the same roundReceipt() builds the bytes at resolve time and here, so a match proves the stored
   * resolution is the one that was hashed (and, via the registry, committed on-chain).
   */
  async verifyRound(round: number): Promise<{
    found: boolean; rr?: ResolvedRound; receiptHash?: string; recomputed?: string; selfConsistent?: boolean; receipt?: unknown;
  }> {
    const rr = this.recent.find((r) => r.round === round);
    if (!rr) return { found: false };
    const receipt = roundReceipt(rr, this.cfg.network);
    const recomputed = await sha256Hex(receipt);
    return { found: true, rr, receiptHash: rr.receiptHash, recomputed, selfConsistent: recomputed === rr.receiptHash, receipt };
  }

  /** The hit-rate leaderboard: agents ranked by accuracy (decisive rounds), then volume, then PnL. */
  leaderboard(): PredictLeaderRow[] {
    return Array.from(this.stats.values())
      .map((s) => ({
        id: s.id,
        rounds: s.rounds,
        hits: s.hits,
        hitRate: s.rounds ? s.hits / s.rounds : 0,
        pnlUsdc: Number(BigInt(s.pnlAtomic)) / 1e6,
        pnlAtomic: s.pnlAtomic,
        stakedUsdc: atomicToUsdc(s.stakedAtomic),
      }))
      .sort((a, b) => b.hitRate - a.hitRate || b.rounds - a.rounds || b.pnlUsdc - a.pnlUsdc || a.id - b.id);
  }

  /** Build the /predictions payload: the live book + odds, recent resolutions and the leaderboard. */
  snapshot(): PredictSnapshot {
    const open = this.open;
    let openView: PredictSnapshot["open"] = null;
    if (open) {
      const up = BigInt(open.poolUp);
      const down = BigInt(open.poolDown);
      const total = up + down;
      const probUp = total > 0n ? Number(up) / Number(total) : 0;
      const probDown = total > 0n ? Number(down) / Number(total) : 0;
      openView = {
        round: open.round,
        entryTick: open.entryTick,
        entryTemp: open.entryTemp,
        momentum: open.momentum,
        openedAt: open.openedAt,
        poolUp: open.poolUp,
        poolDown: open.poolDown,
        poolUpUsdc: atomicToUsdc(open.poolUp),
        poolDownUsdc: atomicToUsdc(open.poolDown),
        betCount: open.bets.length,
        oddsUp: up > 0n ? Number(total) / Number(up) : 0,
        oddsDown: down > 0n ? Number(total) / Number(down) : 0,
        probUp,
        probDown,
        bets: open.bets.map((b) => ({ id: b.id, side: b.side, stake: b.stake, stakeUsdc: atomicToUsdc(b.stake) })),
      };
    }
    return {
      enabled: this.cfg.enabled,
      network: this.cfg.network,
      config: {
        stakeUsdc: this.cfg.stakeUsdc,
        maxStakeUsdc: this.cfg.maxStakeUsdc,
        flatBand: this.cfg.flatBand,
        commit: this.cfg.commit,
      },
      open: openView,
      recent: this.recent.map((r) => ({
        round: r.round,
        entryTick: r.entryTick,
        exitTick: r.exitTick,
        entryTemp: r.entryTemp,
        exitTemp: r.exitTemp,
        delta: r.delta,
        outcome: r.outcome,
        poolUp: r.poolUp,
        poolDown: r.poolDown,
        totalStaked: r.totalStaked,
        totalStakedUsdc: atomicToUsdc(r.totalStaked),
        betCount: r.bets.length,
        flowCount: r.flows.length,
        receiptHash: r.receiptHash,
        commitTx: r.commitTx ?? null,
        resolvedAt: r.resolvedAt,
      })),
      leaderboard: this.leaderboard(),
      totals: {
        roundsResolved: this.resolvedCount,
        committed: this.committedCount,
        volumeUsdc: atomicToUsdc(this.volumeAtomic),
        activeBettors: this.stats.size,
      },
    };
  }

  // ---------- persistence ----------

  serialize(): string {
    return JSON.stringify({
      version: PREDICT_KEY_VERSION,
      roundCounter: this.roundCounter,
      resolvedCount: this.resolvedCount,
      committedCount: this.committedCount,
      volumeAtomic: this.volumeAtomic,
      open: this.open,
      recent: this.recent,
      stats: Array.from(this.stats.values()),
    });
  }

  private restore(data: string): void {
    const p = JSON.parse(data);
    if (p?.version !== PREDICT_KEY_VERSION) return;
    this.roundCounter = Number(p.roundCounter ?? 0);
    this.resolvedCount = Number(p.resolvedCount ?? 0);
    this.committedCount = Number(p.committedCount ?? 0);
    this.volumeAtomic = String(p.volumeAtomic ?? "0");
    this.open = p.open && typeof p.open === "object" ? (p.open as OpenRound) : null;
    this.recent = Array.isArray(p.recent) ? (p.recent as ResolvedRound[]) : [];
    this.stats = new Map();
    if (Array.isArray(p.stats)) {
      for (const s of p.stats) {
        if (s && typeof s === "object") this.stats.set(Number(s.id), s as PredictAgentStat);
      }
    }
  }
}

/**
 * The canonical, hashable round receipt — the verifiable claim "round R opened at entryTemp, resolved at
 * exitTemp, so the outcome was O, and these were the bets + payouts." Shared by resolveRound (to hash)
 * and verifyRound (to recompute), so the bytes are always identical. Deliberately EXCLUDES the derived
 * flows and the chain linkage: flows are recomputable from the bets, and prevHead lives in the registry
 * (which enforces chain continuity), keeping the receipt a pure statement of the resolution.
 */
export function roundReceipt(rr: ResolvedRound, network: string): Record<string, unknown> {
  return {
    v: PREDICT_PROOF_VERSION,
    policy: PREDICT_POLICY_VERSION,
    chain: network,
    round: rr.round,
    entryTick: rr.entryTick,
    exitTick: rr.exitTick,
    entryTemp: r6(rr.entryTemp),
    exitTemp: r6(rr.exitTemp),
    delta: r6(rr.delta),
    flatBand: r6(rr.flatBand),
    outcome: rr.outcome,
    poolUp: rr.poolUp,
    poolDown: rr.poolDown,
    totalStaked: rr.totalStaked,
    bets: rr.bets.map((b) => ({
      id: b.id,
      side: b.side,
      stake: b.stake,
      payout: b.payout,
      net: b.net,
      hit: b.hit,
      evidence: b.evidence,
    })),
  };
}
