// AgentEconomy — the fly population as a small autonomous economy settling on x402.
//
// THE IDEA. Every fly is an economic agent with its own USDC micro-wallet. Each tick we read the
// drives its 1,080-neuron connectome produced (arousal / turnBias / cohesion / wingbeat / rest +
// behavioural state) and translate them into an ECONOMIC INTENT: what good it wants, how strongly it
// wants to buy, and which peer it turns toward. Buyer and seller then run a real x402 "exact" flow
// against each other (402 requirements → signed payload → facilitator verify → settle → receipt) and
// the swarm's USDC circulates. No LLM decides anything; the spiking network does. See x402.ts for the
// keyless-but-faithful protocol layer.
//
// NEURAL DRIVE → ECONOMIC ACTION (the mapping is the whole point — every knob is a neuron read-out):
//   state        → WHICH good to buy      (EXPLORE→signal, AGITATE→momentum, AGGREGATE→attestation)
//   arousal      → HOW strongly to buy    (buy probability + price tolerance scale with arousal)
//   wingbeat     → deal frequency spice   (a buzzing fly transacts a touch more often)
//   cohesion     → WHO to turn toward     (cohesive → trade with NEAR neighbours; explorer → reach FAR)
//   turnBias     → WHICH side to reach    (+ → higher ids / right half, − → lower ids / left half)
//   rest         → damp everything        (a resting fly barely participates)
//   temperature  → market-wide demand     (HOT → more deals at higher prices; COLD → thin & cheap)
//
// SAFETY / LIVENESS. In the DEFAULT simulated mode money is conserved between agents and a small
// "protocol treasury" tops up any agent that runs nearly dry, so the piece runs forever without a
// wallet or faucet; deals per tick are capped to bound cron CPU. The economy is a strict READ-OUT of
// the neural layer (one-directional) — it never feeds back into the connectome, so it cannot
// destabilise the winner-take-all dynamics (see the fly-brain WTA latch lesson).
//
// REAL MONEY (opt-in, OFF by default). When facilitatorMode==="onchain" AND a facilitator + addressOf
// are injected (see state.ts / keys.ts), agents become real HD wallets with real addresses, the treasury
// top-up is DISABLED (you cannot mint real USDC), and settlement goes through EIP-3009 on the Arc USDC
// precompile. Onchain adds hard rails the keyless path never needed: a kill switch, a global daily spend
// cap, a per-agent daily cap, plus a facilitator-level per-deal cap and shadow-only mode. EVERY rail is
// inert in simulated mode, so the default deployment's behaviour and byte output are unchanged.

import {
  X402_VERSION,
  SCHEME_EXACT,
  arcNetworkTag,
  buildPaymentRequired,
  buildPaymentPayload,
  checkPaymentInvariants,
  pseudoTxHash,
  makeFacilitator,
  addAtomic,
  subAtomic,
  gteAtomic,
  usdcToAtomic,
  atomicToUsdc,
  type Facilitator,
  type PaymentRequirements,
  type PaymentPayload,
  type SettleResponse,
  type RegistryCommit,
} from "./x402.js";
import type { FlyReading, CollectiveState } from "./population.js";
import {
  PROOF_VERSION,
  POLICY_VERSION,
  neuralEvidence,
  sha256Hex,
  netReceiptHash,
  nonceFromReceiptHash,
  type NetReceipt,
  type NeuralConstituent,
  type ProofRecord,
} from "./provenance.js";

/** The machine-to-machine data goods agents buy from one another. */
export type GoodKind = "signal" | "momentum" | "attestation";

const GOOD_META: Record<GoodKind, { description: string; mimeType: string; priceMult: number }> = {
  // A peer's live decoded drive vector — a market-timing signal.
  signal: { description: "peer decoded drive vector (arousal/cohesion/turn)", mimeType: "application/json", priceMult: 1.0 },
  // A peer's read on temperature momentum — chased when the market is heating.
  momentum: { description: "peer temperature-momentum read", mimeType: "application/json", priceMult: 1.25 },
  // A peer's neural fingerprint — a "proof-of-feel" identity attestation, bought to bond with the swarm.
  attestation: { description: "peer neural-fingerprint attestation", mimeType: "application/json", priceMult: 0.8 },
};

/** Persistent per-agent wallet + lifetime counters. */
export interface AgentState {
  id: number;
  address: string;
  balance: string;   // atomic USDC (6-dec) as a decimal string
  paid: string;      // lifetime atomic outflow (as buyer)
  earned: string;    // lifetime atomic inflow (as seller)
  deals: number;     // settlements completed as buyer
  sales: number;     // settlements completed as seller
  lastTick: number;  // last tick this agent settled anything (-1 = never)
}

/** One completed (or declined) x402 settlement between two agents. */
export interface Settlement {
  tick: number;
  ts: number;
  good: GoodKind;
  resource: string;
  fromId: number;
  toId: number;
  from: string;      // buyer address
  to: string;        // seller address
  amount: string;    // atomic USDC
  txHash: string;    // deterministic pseudo hash (simulated)
  valid: boolean;    // facilitator verify+settle succeeded AND buyer had funds
  reason?: string;   // why it failed, when valid=false
  simulated: boolean;
  proofHash?: string; // net receipts only: the sha256 committed on-chain as the EIP-3009 nonce
}

/**
 * An accumulated bilateral NET between one unordered pair of agents, pending on-chain broadcast.
 * `net` is SIGNED: positive ⇒ the lower id pays the higher id; negative ⇒ the reverse. Reciprocal
 * trades cancel inside the sum automatically, so a pair that traded both ways may need no tx at all.
 * ONCHAIN netting only; simulated mode never creates these.
 */
export interface PendingNet {
  lo: number;            // lower agent id of the pair
  hi: number;            // higher agent id of the pair
  net: bigint;           // signed accumulated net (atomic USDC); |net| = what must actually move
  trades: number;        // gross trades folded into this net (for labelling / telemetry)
  good: GoodKind;        // last good traded (label for the net settlement)
  firstTick: number;     // sub-tick the net opened (drives the forced-flush age bound)
  constituents: Settlement[]; // the per-trade records folded in (informational; linked to the net tx)
  proofs: NeuralConstituent[]; // neural provenance per folded trade (hashed into the on-chain nonce)
}

/** Per-agent read-out for the frontend. */
export interface AgentReading {
  id: number;
  address: string;
  balance: string;
  balanceUsdc: number;
  paid: string;
  earned: string;
  deals: number;
  sales: number;
}

/**
 * One row of the trustless PnL leaderboard: an agent's realized USDC flow (earned − paid) plus its
 * balance and activity. Every figure is recomputable from on-chain settlements (each linked, via the
 * NeuralReceiptRegistry, to the neural receipt that caused it), so the ranking is verifiable, not asserted.
 */
export interface LeaderRow {
  id: number;
  address: string;
  netUsdc: number;       // earned − paid (realized flow); the ranking key
  earnedUsdc: number;
  paidUsdc: number;
  balanceUsdc: number;
  deals: number;         // settlements as buyer
  sales: number;         // settlements as seller
}

export interface EconomyTotals {
  volumeAtomic: string;   // lifetime settled volume
  volumeUsdc: number;
  count: number;          // lifetime successful settlements
  liveAgents: number;
  meanBalanceUsdc: number;
  gini: number;           // 0 = equal wealth, →1 = concentrated (emergent from neural diversity)
  treasuryOutAtomic: string; // simulated liquidity injected to keep agents solvent
  richestId: number | null;
  poorestId: number | null;
}

export interface EconomySnapshot {
  tickIndex: number;
  mode: "simulated" | "onchain";
  scheme: typeof SCHEME_EXACT;
  network: string;
  asset: string;
  x402Version: number;
  agents: AgentReading[];
  /** Settlements produced on the most recent tick — the frontend draws these as payment edges. */
  lastTick: Settlement[];
  /** A rolling window of recent settlements for the ledger HUD. */
  recent: Settlement[];
  totals: EconomyTotals;
}

export interface EconomyConfig {
  enabled: boolean;
  network: string;             // arcNetworkTag(...)
  initialBalanceUsdc: number;  // starting wallet per agent
  basePriceUsdc: number;       // base price of one good before neural/market scaling
  solvencyFloorUsdc: number;   // treasury tops an agent up to this when it falls below
  maxDealsPerTick: number;     // CPU budget cap
  facilitatorMode: "simulated" | "onchain";
  seedBase: number;            // for deterministic agent addresses
  // --- real-money rails (ONCHAIN ONLY; never read in simulated mode, so default output is unchanged) ---
  realSpendEnabled: boolean;       // kill switch: false ⇒ onchain settlements are refused, no funds move
  dailyCapUsdc: number;            // global real-spend ceiling per UTC day (0 ⇒ no global cap)
  perAgentDailyCapUsdc: number;    // per-agent real-spend ceiling per UTC day (0 ⇒ no per-agent cap)
  maxDealUsdc: number;             // facilitator hard per-deal ceiling; net flushes split above this
  // --- settlement NETTING (ONCHAIN ONLY): accumulate bilateral nets per pair and broadcast only the
  //     net, far less often, so real gas is amortised over more value instead of one tx per micropay. ---
  netMinBroadcastUsdc: number;     // min |net| per pair before it is broadcast (below ⇒ dust carries forward)
  netFlushTicks: number;           // force-flush any nonzero pending net at least every N sub-ticks (0 = never)
}

/**
 * Injected dependencies that turn the keyless economy into a real-money one. BOTH are optional: absent
 * ⇒ the simulated defaults (makeFacilitator(mode) + the deterministic pseudo-address), so the default
 * deployment constructs exactly as before. state.ts supplies them only once keys + clients are wired.
 */
export interface EconomyDeps {
  /** Facilitator to settle through (SimulatedFacilitator, or a fully-wired OnChainFacilitator). */
  facilitator?: Facilitator;
  /** Real on-chain address for an agent id (HD-derived). Absent ⇒ deterministic pseudo-address. */
  addressOf?(id: number): string;
}

const KEY_VERSION = "economy:v1";
const RECENT_CAP = 48;
/** How many neural-provenance receipts to keep published (newest first) for /proofs + the chain. */
const PROOFS_CAP = 64;

export class AgentEconomy {
  private cfg: EconomyConfig;
  private facilitator: Facilitator;
  /** Real address resolver: injected HD derivation onchain, else the deterministic pseudo-address. */
  private addressOf: (id: number) => string;
  private agents: AgentState[] = [];
  private indexOfId = new Map<number, number>();
  private recent: Settlement[] = [];
  private lastTick: Settlement[] = [];
  private tickIndex = 0;
  private volumeAtomic = "0";
  private count = 0;
  private treasuryOutAtomic = "0";
  /**
   * Real-spend guardrails, persisted so a mid-day DO eviction can't reset the daily budget. ONCHAIN
   * ONLY — never mutated in simulated mode (stays empty), so it can't affect the default deployment.
   */
  private spendGuard: { dayKey: string; globalAtomic: string; perAgent: Record<number, string> } = {
    dayKey: "", globalAtomic: "0", perAgent: {},
  };
  /**
   * Settlement-NETTING accumulator (ONCHAIN ONLY). Keyed by unordered pair "lo>hi"; each entry holds the
   * signed net still owed between the two agents plus the per-trade records folded into it. Trades update
   * this instead of broadcasting immediately; flush() later moves only the NET on-chain, far less often,
   * so real gas is amortised over more value. Empty in simulated mode (never written).
   */
  private pendingNets = new Map<string, PendingNet>();
  /** Monotonic counter mixed into net nonces so two flushes can never reuse an EIP-3009 nonce. */
  private flushSeq = 0;
  /** Published neural-provenance receipts, newest first (each hashed into an on-chain nonce). */
  private proofs: ProofRecord[] = [];
  /** receiptHash of the most recent broadcast — the head of the tamper-evident proof chain. */
  private proofChainHead = "";

  constructor(cfg: EconomyConfig, restored?: string, deps?: EconomyDeps) {
    this.cfg = cfg;
    // Injected facilitator wins; otherwise derive from mode. makeFacilitator("onchain") without wiring
    // THROWS by design, so real money can never be half-enabled — onchain MUST be injected from state.ts.
    this.facilitator = deps?.facilitator ?? makeFacilitator(cfg.facilitatorMode);
    this.addressOf = deps?.addressOf ?? ((id) => AgentEconomy.addressOf(cfg.seedBase, id));
    if (restored) {
      try { this.applySerialized(restored); } catch { this.agents = []; }
    }
  }

  /** Deterministic 20-byte pseudo-address for an agent. SIMULATED identity, not a funded EOA. */
  static addressOf(seedBase: number, id: number): string {
    let h1 = 0x811c9dc5 ^ seedBase;
    let h2 = 0x1000193 ^ (id * 2654435761);
    const mix = (c: number) => {
      h1 = Math.imul(h1 ^ c, 0x01000193) >>> 0;
      h2 = Math.imul(h2 ^ c, 0x85ebca6b) >>> 0;
    };
    const src = `${seedBase}:${id}`;
    for (let i = 0; i < src.length; i++) mix(src.charCodeAt(i));
    let out = "";
    let s1 = h1 >>> 0, s2 = h2 >>> 0;
    for (let i = 0; i < 10; i++) {
      s1 = (Math.imul(s1, 1664525) + 1013904223) >>> 0;
      s2 = (Math.imul(s2, 22695477) + 1) >>> 0;
      out += ((s1 ^ s2) >>> 0).toString(16).padStart(8, "0");
    }
    return "0x" + out.slice(0, 40);
  }

  /**
   * Make sure an agent wallet exists for every fly in the reading set (idempotent). In SIMULATED mode a
   * new agent is credited initialBalance from the protocol treasury; existing agents keep their balance.
   * In ONCHAIN mode initialBalance is only the seed of the internal DISPLAY mirror — the real spendable
   * balance is whatever USDC the operator actually funded that HD address with, and the facilitator
   * re-reads it on-chain before every transfer (the mirror never authorises a real spend).
   */
  private ensureAgents(readings: FlyReading[]): void {
    for (const r of readings) {
      if (this.indexOfId.has(r.id)) continue;
      const idx = this.agents.length;
      this.agents.push({
        id: r.id,
        address: this.addressOf(r.id),
        balance: usdcToAtomic(this.cfg.initialBalanceUsdc),
        paid: "0",
        earned: "0",
        deals: 0,
        sales: 0,
        lastTick: -1,
      });
      this.indexOfId.set(r.id, idx);
    }
  }

  /**
   * Advance one economic tick. Reads the neural drives the connectome just produced and lets the
   * agents transact. Returns the settlements made this tick (also kept on the snapshot). ASYNC because
   * onchain settlement does real RPC; the simulated facilitator resolves immediately with identical
   * results, so awaiting changes nothing about the default economy's output.
   */
  async step(readings: FlyReading[], collective: CollectiveState, tickIndex: number, budgetOverride?: number): Promise<Settlement[]> {
    this.tickIndex = tickIndex;
    if (!this.cfg.enabled || readings.length < 2) { this.lastTick = []; return this.lastTick; }

    const onchain = this.facilitator.mode === "onchain";
    // KILL SWITCH: in onchain mode realSpendEnabled=false halts ALL settlement so no funds can move.
    // Inert in simulated mode — there is no real money to halt, so the piece keeps running as always.
    if (onchain && !this.cfg.realSpendEnabled) { this.lastTick = []; return this.lastTick; }
    if (onchain) this.rollSpendDay(Date.now());

    this.ensureAgents(readings);
    const readingById = new Map<number, FlyReading>();
    for (const r of readings) readingById.set(r.id, r);
    const n = readings.length;
    const T = clamp01(collective.temperature);
    const made: Settlement[] = [];
    const budget = Math.max(0, budgetOverride ?? this.cfg.maxDealsPerTick);

    // Market-wide demand: a HOT chain means more agents want to buy, at higher prices.
    const demand = 0.3 + 0.7 * T;

    for (let i = 0; i < n && made.length < budget; i++) {
      const r = readings[i];
      const buyerIdx = this.indexOfId.get(r.id);
      if (buyerIdx == null) continue;

      // --- decode economic intent from the neural drives ---
      const want = this.buyProbability(r, T);
      // Deterministic per-(tick,agent) draw so the flow is reproducible without persisted RNG state.
      const draw = hash01(tickIndex, r.id, 0x9e3779b9);
      if (draw > want * demand) continue;   // this agent holds this tick

      const good = goodForState(r.state);
      const sellerIdx = this.pickCounterparty(r, i, n, tickIndex);
      if (sellerIdx < 0 || sellerIdx === buyerIdx) continue;

      // ONCHAIN: fold the trade into the pair's pending NET instead of broadcasting now — flush() moves
      // only nets, far less often (gas amortisation). The returned record is a "net-pending" placeholder
      // (valid=false) so the frontend still shows the activity live without counting un-mined value.
      // SIMULATED: settle immediately as always (the internal ledger is the authority).
      if (onchain) {
        made.push(await this.queueNet(buyerIdx, sellerIdx, good, r, T, tickIndex, readingById));
      } else {
        // Awaited sequentially: keeps relay submissions serialised through the one gas wallet
        // (no concurrent-nonce races on the facilitator).
        const settlement = await this.settle(buyerIdx, sellerIdx, good, r, T, tickIndex);
        made.push(settlement);
      }
    }

    // Keep every agent solvent so the piece never dies — SIMULATED ONLY. Onchain we must never mint: an
    // agent that runs dry simply stops buying until the operator refills its real wallet.
    if (!onchain) this.solvencyTopUp();

    this.lastTick = made;
    for (const s of made) {
      // net-pending placeholders are NOT ledger/recent material: they only become real (volume, count,
      // recent, balances) when flush() actually moves the net on-chain. Simulated deals land as before.
      if (s.reason === "net-pending") continue;
      this.recent.unshift(s);
      if (s.valid) {
        this.volumeAtomic = addAtomic(this.volumeAtomic, s.amount);
        this.count++;
      }
    }
    if (this.recent.length > RECENT_CAP) this.recent.length = RECENT_CAP;
    return made;
  }

  /**
   * Override the "last tick" settlement batch the frontend draws as payment edges. The DO now drives
   * several economy sub-steps per cron (one per neural sub-tick) to raise trade frequency; this lets it
   * publish the WHOLE cron's settlements as one batch instead of only the final sub-tick's, so every
   * trade the cron made is visible on the canvas.
   */
  setLastTick(settlements: Settlement[]): void {
    this.lastTick = settlements;
  }

  /**
   * ONCHAIN netting: fold a trade into its pair's pending NET WITHOUT broadcasting and WITHOUT touching the
   * internal ledger (balances move only when flush() mines the net, so a failed broadcast can never leave
   * fictional money). Returns a "net-pending" placeholder so the frontend still shows the trade live.
   */
  private async queueNet(
    buyerIdx: number, sellerIdx: number, good: GoodKind, r: FlyReading, T: number, tick: number,
    readingById: Map<number, FlyReading>,
  ): Promise<Settlement> {
    const buyer = this.agents[buyerIdx];
    const seller = this.agents[sellerIdx];
    const amount = this.dealAmount(r, T, good);
    const lo = Math.min(buyer.id, seller.id);
    const hi = Math.max(buyer.id, seller.id);
    const key = `${lo}>${hi}`;
    // Signed net: positive ⇒ lo pays hi. buyer===lo adds, buyer===hi subtracts, so reciprocal trades cancel.
    const signed = BigInt(amount) * (buyer.id === lo ? 1n : -1n);
    let pn = this.pendingNets.get(key);
    if (!pn) {
      pn = { lo, hi, net: 0n, trades: 0, good, firstTick: tick, constituents: [], proofs: [] };
      this.pendingNets.set(key, pn);
    }
    pn.net += signed;
    pn.trades++;
    pn.good = good;
    // Freeze the neural read-out that produced THIS trade and hash it. Bundled into the net receipt at
    // flush time, this is what binds the eventual on-chain nonce to the connectome's decision.
    const sellerReading = readingById.get(seller.id) ?? r;
    if (pn.proofs.length < 64) {
      const buyerEv = neuralEvidence(r);
      const sellerEv = neuralEvidence(sellerReading);
      pn.proofs.push({
        tick, fromId: buyer.id, toId: seller.id, good, amount,
        buyer: buyerEv, seller: sellerEv,
        decisionHash: await sha256Hex({
          v: PROOF_VERSION, policy: POLICY_VERSION, kind: "decision",
          tick, good, amount, buyer: buyerEv, seller: sellerEv,
        }),
      });
    }
    const rec: Settlement = {
      tick, ts: Date.now(), good, resource: `${good}:${seller.id}`,
      fromId: buyer.id, toId: seller.id, from: buyer.address, to: seller.address,
      amount, txHash: "0x", valid: false, reason: "net-pending", simulated: false,
    };
    if (pn.constituents.length < 64) pn.constituents.push(rec);
    return rec;
  }

  /**
   * ONCHAIN netting flush — called once per cron after the sub-tick loop. Moves only accumulated NETS
   * on-chain: a pair broadcasts when |net| ≥ netMinBroadcastUsdc, or once older than netFlushTicks (so dust
   * can't sit forever); pairs that cancelled to zero broadcast nothing. Nets above the facilitator per-deal
   * cap are split into ≤cap chunks. Internal balances / volume / count / daily caps move ONLY here on a
   * mined receipt, so a failed broadcast never leaves fictional money. SIMULATED: no-op (returns []).
   */
  async flush(tickIndex: number): Promise<Settlement[]> {
    const out: Settlement[] = [];
    if (this.facilitator.mode !== "onchain") return out;
    if (!this.cfg.realSpendEnabled) return out;   // kill switch: never broadcast
    this.rollSpendDay(Date.now());
    const minBroadcast = BigInt(usdcToAtomic(this.cfg.netMinBroadcastUsdc));
    const maxDeal = BigInt(usdcToAtomic(this.cfg.maxDealUsdc));
    const CONSTITUENT = new Set(["net-pending", "netted", "net-declined", "netted-to-zero"]);

    for (const [key, pn] of Array.from(this.pendingNets.entries())) {
      const abs = pn.net < 0n ? -pn.net : pn.net;
      if (abs === 0n) {
        // Perfectly reciprocal within the window: nothing ever needs to move on-chain. Close the pair.
        // Constituents stay exactly as published (net-pending, txHash "0x"): the frontend dedups them on a
        // stable tick+parties key, so mutating txHash here would change the key and double-draw the trade.
        this.pendingNets.delete(key);
        continue;
      }
      const aged = this.cfg.netFlushTicks > 0 && tickIndex - pn.firstTick >= this.cfg.netFlushTicks;
      if (abs < minBroadcast && !aged) continue;   // dust carries forward to a later flush

      const debtorId = pn.net > 0n ? pn.lo : pn.hi;
      const creditorId = pn.net > 0n ? pn.hi : pn.lo;
      const debtor = this.agents[this.indexOfId.get(debtorId)!];
      const creditor = this.agents[this.indexOfId.get(creditorId)!];
      const good = pn.good;
      let remaining = abs;
      let primaryHash = "0x";
      let chunk = 0;
      while (remaining > 0n) {
        const value = maxDeal > 0n && remaining > maxDeal ? maxDeal : remaining;
        remaining -= value;
        const amountStr = String(value);
        const base = {
          tick: tickIndex, ts: Date.now(), good, resource: `net:${good}:${creditor.id}`,
          fromId: debtor.id, toId: creditor.id, from: debtor.address, to: creditor.address,
          amount: amountStr, simulated: false,
        } as const;
        const capReason = this.spendCapReason(debtor.id, amountStr);
        if (capReason) { out.push({ ...base, txHash: "0x", valid: false, reason: capReason }); break; }
        // NEURAL PROVENANCE: the EIP-3009 nonce IS the sha256 of the net receipt (every folded trade's
        // frozen neural drives + this net's terms + the previous chain head). The buyer signs it and it is
        // mined into the calldata / AuthorizationUsed event, so the transfer cryptographically commits to
        // the connectome read-out that caused it. flushSeq + chunk keep nonces unique across flushes.
        const netReceipt: NetReceipt = {
          v: PROOF_VERSION, policy: POLICY_VERSION, chain: this.cfg.network,
          pair: [pn.lo, pn.hi], debtor: debtorId, creditor: creditorId,
          netAmount: amountStr, trades: pn.trades, good,
          tickIndex, flushSeq: this.flushSeq, chunk,
          constituents: pn.proofs, prevChain: this.proofChainHead,
        };
        const receiptHash = await netReceiptHash(netReceipt);
        const nonce = nonceFromReceiptHash(receiptHash);
        const reqs: PaymentRequirements = {
          scheme: SCHEME_EXACT, network: this.cfg.network, maxAmountRequired: amountStr,
          resource: base.resource, description: GOOD_META[good].description, mimeType: GOOD_META[good].mimeType,
          payTo: creditor.address, maxTimeoutSeconds: 60, asset: this.facilitator.asset,
          extra: { netted: true, trades: pn.trades, sellerId: creditor.id, good },
        };
        const payload = buildPaymentPayload({
          reqs, from: debtor.address, value: amountStr, nonce, nowSec: Math.floor(Date.now() / 1000),
        });
        const verified = await this.facilitator.verify(payload, reqs);
        if (!verified.valid) { out.push({ ...base, txHash: "0x", valid: false, reason: verified.invalidReason ?? "verify-failed" }); break; }
        const receipt = await this.facilitator.settle(payload, reqs);
        if (receipt.shadow) { out.push({ ...base, txHash: "0x", valid: false, reason: "shadow-dry-run" }); break; }
        if (!receipt.success) { out.push({ ...base, txHash: receipt.txHash || "0x", valid: false, reason: receipt.invalidReason ?? "settle-failed" }); break; }
        // Mined: commit this chunk on the internal ledger, meter the daily caps, count real volume.
        debtor.balance = subAtomic(debtor.balance, amountStr);
        debtor.paid = addAtomic(debtor.paid, amountStr);
        debtor.deals++;
        debtor.lastTick = tickIndex;
        creditor.balance = addAtomic(creditor.balance, amountStr);
        creditor.earned = addAtomic(creditor.earned, amountStr);
        creditor.sales++;
        creditor.lastTick = tickIndex;
        this.recordSpend(debtor.id, amountStr);
        this.volumeAtomic = addAtomic(this.volumeAtomic, amountStr);
        this.count++;
        if (primaryHash === "0x") primaryHash = receipt.txHash;
        // Mirror this receipt onto our own NeuralReceiptRegistry so the hash-chain head lives ON-CHAIN,
        // not just in DO storage. BEST-EFFORT: prevHead is the chain head BEFORE this receipt (exactly
        // what the contract enforces continuity against). A failure only means "not registered yet" —
        // the authoritative commitment (the EIP-3009 nonce == receiptHash) already mined above.
        const commitTx = await this.commitToRegistry(
          receiptHash, netReceipt.prevChain, tickIndex, netReceipt.constituents.length, receipt.txHash,
        );
        // Publish + chain the proof now that the nonce-committing transfer is mined.
        this.proofs.unshift({
          txHash: receipt.txHash, receiptHash, receipt: netReceipt, ts: Date.now(),
          ...(commitTx ? { commitTx } : {}),
        });
        if (this.proofs.length > PROOFS_CAP) this.proofs.length = PROOFS_CAP;
        this.proofChainHead = receiptHash;
        out.push({ ...base, txHash: receipt.txHash, valid: true, proofHash: receiptHash });
        chunk++;
      }
      // NOTE: constituents are deliberately left byte-identical to what their own cron already published
      // (net-pending, txHash "0x"). The frontend dedups them on tick+parties+amount; mutating txHash to the
      // real net hash would change the dedup key and re-draw every folded trade as a duplicate edge. The
      // net settlement record itself carries the linkage (resource net:good:creditor + extra.trades).
      this.pendingNets.delete(key);
      this.flushSeq++;
    }

    for (const s of out) {
      if (CONSTITUENT.has(s.reason ?? "")) continue;   // keep the ledger to real nets + declines
      this.recent.unshift(s);
    }
    if (this.recent.length > RECENT_CAP) this.recent.length = RECENT_CAP;
    return out;
  }

  /** buy probability 0..1 from state + arousal + wingbeat + rest. */
  private buyProbability(r: FlyReading, T: number): number {
    const stateBase =
      r.state === "AGITATE" ? 0.9 :
      r.state === "EXPLORE" ? 0.7 :
      r.state === "AGGREGATE" ? 0.5 : 0.12;   // REST barely participates
    const arousal = 0.5 + 0.5 * clamp01(r.arousal);
    const wing = 0.85 + 0.3 * clamp01(r.wingbeat);
    const rest = 1 - 0.6 * clamp01(r.rest);
    return clamp01(stateBase * arousal * wing * rest * (0.6 + 0.4 * T));
  }

  /**
   * Choose the seller index from cohesion (near/far) + turnBias (left/right half). Maps the fly's
   * spatial social drive onto an economic counterparty: a cohesive fly trades with a close neighbour,
   * an explorer reaches across the swarm.
   */
  private pickCounterparty(r: FlyReading, buyerI: number, n: number, tick: number): number {
    const others = n - 1;
    if (others <= 0) return -1;
    const coh = clamp01(r.cohesion);
    // Low cohesion (explorer) → large reach; high cohesion → small, neighbourly offset.
    const span = Math.max(1, Math.round(1 + (1 - coh) * (others - 1)));
    const h = Math.floor(hash01(tick, r.id, 0x85ebca6b) * span);
    const offset = 1 + (h % span);
    const dir = r.turnBias >= 0 ? 1 : -1;
    let sellerI = (buyerI + dir * offset) % n;
    if (sellerI < 0) sellerI += n;
    if (sellerI === buyerI) sellerI = (sellerI + 1) % n;
    return sellerI;
  }

  /** Price of one unit of `good` this tick, in atomic USDC (min 1): base × market heat × arousal × good mult. */
  private dealAmount(r: FlyReading, T: number, good: GoodKind): string {
    const meta = GOOD_META[good];
    const priceUsdc =
      this.cfg.basePriceUsdc * (0.5 + T) * (0.6 + 0.6 * clamp01(r.arousal)) * meta.priceMult;
    return String(Math.max(1, Math.round(priceUsdc * 1e6)));
  }

  /** Run the full x402 flow between buyer and seller for one good; return the settlement record. */
  private async settle(
    buyerIdx: number,
    sellerIdx: number,
    good: GoodKind,
    r: FlyReading,
    T: number,
    tick: number,
  ): Promise<Settlement> {
    const buyer = this.agents[buyerIdx];
    const seller = this.agents[sellerIdx];
    const meta = GOOD_META[good];
    const onchain = this.facilitator.mode === "onchain";

    // Price of this deal in atomic USDC (shared with the netting queue so queued and direct deals price alike).
    const amount = this.dealAmount(r, T, good);

    const resource = `${good}:${seller.id}`;
    const reqs: PaymentRequirements = {
      scheme: SCHEME_EXACT,
      network: this.cfg.network,
      maxAmountRequired: amount,
      resource,
      description: meta.description,
      mimeType: meta.mimeType,
      payTo: seller.address,
      maxTimeoutSeconds: 60,
      asset: this.facilitator.asset,
      extra: { sellerId: seller.id, good },
    };
    // The 402 the seller would return (kept for shape fidelity; the DO short-circuits the HTTP hop).
    void buildPaymentRequired(reqs);

    const nowSec = Math.floor(Date.now() / 1000);
    const nonce = "0x" + (hash32(tick, buyer.id, seller.id) >>> 0).toString(16).padStart(8, "0") +
      (hash32(seller.id, tick, buyer.id) >>> 0).toString(16).padStart(8, "0");
    const payload = buildPaymentPayload({ reqs, from: buyer.address, value: amount, nonce, nowSec });

    const base = {
      tick, ts: Date.now(), good, resource,
      fromId: buyer.id, toId: seller.id, from: buyer.address, to: seller.address,
      amount, simulated: this.facilitator.mode === "simulated",
    } as const;

    // SIMULATED: the internal ledger is the authority, so gate on it — insufficient funds is a declined
    // attempt (recorded, not settled), which keeps the ledger honest. ONCHAIN: skip this gate; the
    // facilitator re-reads the REAL on-chain balance right before signing and is the sole authority (a
    // display mirror that has drifted must never block — or worse, authorise — a real transfer).
    if (!onchain && !gteAtomic(buyer.balance, amount)) {
      return { ...base, txHash: "0x", valid: false, reason: "insufficient-funds" };
    }

    // Daily real-spend caps — ONCHAIN ONLY. Refuse BEFORE signing/broadcasting if this deal would push
    // the global or the buyer's per-agent budget over its ceiling for the UTC day.
    if (onchain) {
      const capReason = this.spendCapReason(buyer.id, amount);
      if (capReason) return { ...base, txHash: "0x", valid: false, reason: capReason };
    }

    const verified = await this.facilitator.verify(payload, reqs);
    if (!verified.valid) {
      return { ...base, txHash: "0x", valid: false, reason: verified.invalidReason ?? "verify-failed" };
    }
    const receipt = await this.facilitator.settle(payload, reqs);
    if (!receipt.success) {
      return { ...base, txHash: receipt.txHash || "0x", valid: false, reason: receipt.invalidReason ?? "settle-failed" };
    }
    // Shadow dry-run: the facilitator proved the signed transfer WOULD succeed but broadcast nothing, so
    // no real value moved. Record it (valid=false ⇒ no volume / ledger / cap effect) without touching any
    // balance — that's the entire point of shadow mode.
    if (receipt.shadow) {
      return { ...base, txHash: "0x", valid: false, reason: "shadow-dry-run" };
    }

    // Commit the transfer on the internal ledger (simulated: the authority; onchain: a display mirror of
    // the real, already-mined transfer).
    buyer.balance = subAtomic(buyer.balance, amount);
    buyer.paid = addAtomic(buyer.paid, amount);
    buyer.deals++;
    buyer.lastTick = tick;
    seller.balance = addAtomic(seller.balance, amount);
    seller.earned = addAtomic(seller.earned, amount);
    seller.sales++;
    seller.lastTick = tick;

    // Meter real spend against the daily caps — ONCHAIN ONLY (simulated has no real budget to meter).
    if (onchain) this.recordSpend(buyer.id, amount);

    return { ...base, txHash: receipt.txHash, valid: true };
  }

  /** Top up any agent below the solvency floor from the simulated treasury (conserves liveness). */
  private solvencyTopUp(): void {
    const floor = usdcToAtomic(this.cfg.solvencyFloorUsdc);
    for (const a of this.agents) {
      if (!gteAtomic(a.balance, floor)) {
        const deficit = subAtomic(floor, a.balance);
        a.balance = floor;
        this.treasuryOutAtomic = addAtomic(this.treasuryOutAtomic, deficit);
      }
    }
  }

  // ---------- real-spend guardrails (ONCHAIN ONLY; never called in simulated mode) ----------

  /** UTC calendar-day key ("YYYY-MM-DD") used to bucket the daily spend caps. */
  private static dayKey(nowMs: number): string {
    return new Date(nowMs).toISOString().slice(0, 10);
  }

  /** Reset the daily counters when the UTC day rolls over (called once per onchain tick). */
  private rollSpendDay(nowMs: number): void {
    const key = AgentEconomy.dayKey(nowMs);
    if (key !== this.spendGuard.dayKey) {
      this.spendGuard = { dayKey: key, globalAtomic: "0", perAgent: {} };
    }
  }

  /**
   * If settling `amount` for agent `id` would breach a daily ceiling, return the reason to record; else
   * null. A cap of 0 means "no cap". Checked BEFORE any signing/broadcast, so a capped deal costs no gas.
   * The global cap bounds total real outflow per day; the per-agent cap stops any one fly draining fast.
   */
  private spendCapReason(id: number, amount: string): string | null {
    const gCap = BigInt(usdcToAtomic(this.cfg.dailyCapUsdc));
    if (gCap > 0n && BigInt(this.spendGuard.globalAtomic) + BigInt(amount) > gCap) {
      return "daily-cap-global";
    }
    const aCap = BigInt(usdcToAtomic(this.cfg.perAgentDailyCapUsdc));
    if (aCap > 0n && BigInt(this.spendGuard.perAgent[id] ?? "0") + BigInt(amount) > aCap) {
      return "daily-cap-agent";
    }
    return null;
  }

  /** Add a settled real transfer to today's global + per-agent spend counters. */
  private recordSpend(id: number, amount: string): void {
    this.spendGuard.globalAtomic = addAtomic(this.spendGuard.globalAtomic, amount);
    this.spendGuard.perAgent[id] = addAtomic(this.spendGuard.perAgent[id] ?? "0", amount);
  }

  /** Build the full snapshot the /economy endpoint returns. */
  snapshot(): EconomySnapshot {
    const balances = this.agents.map((a) => BigInt(a.balance));
    const n = this.agents.length;
    let sum = 0n;
    for (const b of balances) sum += b;
    const meanUsdc = n ? atomicToUsdc((sum / BigInt(n)).toString()) : 0;

    let richestId: number | null = null, poorestId: number | null = null;
    if (n) {
      let hi = -1n, lo = -1n;
      for (const a of this.agents) {
        const b = BigInt(a.balance);
        if (hi < 0n || b > hi) { hi = b; richestId = a.id; }
        if (lo < 0n || b < lo) { lo = b; poorestId = a.id; }
      }
    }

    return {
      tickIndex: this.tickIndex,
      mode: this.facilitator.mode,
      scheme: SCHEME_EXACT,
      network: this.cfg.network,
      asset: this.facilitator.asset,
      x402Version: X402_VERSION,
      agents: this.agents.map((a) => ({
        id: a.id, address: a.address, balance: a.balance, balanceUsdc: atomicToUsdc(a.balance),
        paid: a.paid, earned: a.earned, deals: a.deals, sales: a.sales,
      })),
      lastTick: this.lastTick,
      recent: this.recent,
      totals: {
        volumeAtomic: this.volumeAtomic,
        volumeUsdc: atomicToUsdc(this.volumeAtomic),
        count: this.count,
        liveAgents: n,
        meanBalanceUsdc: meanUsdc,
        gini: giniAtomic(this.agents.map((a) => a.balance)),
        treasuryOutAtomic: this.treasuryOutAtomic,
        richestId, poorestId,
      },
    };
  }

  /** A compact summary folded into /population so the frontend gets edges + totals in one poll. */
  summary(): { lastTick: Settlement[]; totals: EconomyTotals; balances: Record<number, string> } {
    const snap = this.snapshot();
    const balances: Record<number, string> = {};
    for (const a of this.agents) balances[a.id] = a.balance;
    return { lastTick: snap.lastTick, totals: snap.totals, balances };
  }

  getAgent(id: number): AgentState | undefined {
    const idx = this.indexOfId.get(id);
    return idx == null ? undefined : this.agents[idx];
  }

  // ---------- persistence ----------
  serialize(): string {
    return JSON.stringify({
      version: KEY_VERSION,
      tickIndex: this.tickIndex,
      volumeAtomic: this.volumeAtomic,
      count: this.count,
      treasuryOutAtomic: this.treasuryOutAtomic,
      recent: this.recent,
      agents: this.agents,
      // Real-spend guard counters (empty in simulated mode). Persisted so a mid-day DO eviction can't
      // reset the daily budget and let more real USDC out than the cap allows.
      spendGuard: this.spendGuard,
      // Netting accumulator (empty in simulated mode). Persisted so un-broadcast dust survives a DO
      // eviction and is still owed/settled later rather than silently vanishing.
      pendingNets: Array.from(this.pendingNets.entries()).map(([key, v]) => ({
        key, lo: v.lo, hi: v.hi, net: v.net.toString(), trades: v.trades,
        good: v.good, firstTick: v.firstTick, constituents: v.constituents, proofs: v.proofs,
      })),
      flushSeq: this.flushSeq,
      proofs: this.proofs,
      proofChainHead: this.proofChainHead,
    });
  }

  private applySerialized(data: string): void {
    const p = JSON.parse(data);
    if (p?.version !== KEY_VERSION) return;
    this.tickIndex = Number(p.tickIndex ?? 0);
    this.volumeAtomic = String(p.volumeAtomic ?? "0");
    this.count = Number(p.count ?? 0);
    this.treasuryOutAtomic = String(p.treasuryOutAtomic ?? "0");
    this.recent = Array.isArray(p.recent) ? p.recent : [];
    this.agents = Array.isArray(p.agents) ? p.agents : [];
    this.indexOfId = new Map();
    this.agents.forEach((a, i) => this.indexOfId.set(a.id, i));
    this.lastTick = [];
    const g = p.spendGuard;
    this.spendGuard =
      g && typeof g === "object"
        ? {
            dayKey: String(g.dayKey ?? ""),
            globalAtomic: String(g.globalAtomic ?? "0"),
            perAgent: g.perAgent && typeof g.perAgent === "object" ? g.perAgent : {},
          }
        : { dayKey: "", globalAtomic: "0", perAgent: {} };
    // Restore the netting accumulator (absent in older payloads / simulated mode ⇒ empty).
    this.pendingNets = new Map();
    if (Array.isArray(p.pendingNets)) {
      for (const e of p.pendingNets) {
        if (!e || typeof e !== "object") continue;
        const key = String(e.key ?? `${e.lo}>${e.hi}`);
        this.pendingNets.set(key, {
          lo: Number(e.lo ?? 0),
          hi: Number(e.hi ?? 0),
          net: BigInt(e.net ?? "0"),
          trades: Number(e.trades ?? 0),
          good: (e.good ?? "signal") as GoodKind,
          firstTick: Number(e.firstTick ?? 0),
          constituents: Array.isArray(e.constituents) ? e.constituents : [],
          proofs: Array.isArray(e.proofs) ? e.proofs : [],
        });
      }
    }
    this.flushSeq = Number(p.flushSeq ?? 0);
    this.proofs = Array.isArray(p.proofs) ? p.proofs : [];
    this.proofChainHead = typeof p.proofChainHead === "string" ? p.proofChainHead : "";
  }

  // ---------- neural provenance ----------

  /** The published proof log + chain head, for the /proofs endpoint. */
  proofsSnapshot(): {
    version: number; policy: string; chainHead: string; count: number; proofs: ProofRecord[];
  } {
    return {
      version: PROOF_VERSION,
      policy: POLICY_VERSION,
      chainHead: this.proofChainHead,
      count: this.proofs.length,
      proofs: this.proofs,
    };
  }

  proofForTx(txHash: string): ProofRecord | undefined {
    const want = txHash.toLowerCase();
    return this.proofs.find((p) => p.txHash.toLowerCase() === want);
  }

  /**
   * Read the EIP-3009 nonce actually mined on-chain for a tx (null when not onchain / not found), so a
   * caller can confirm it equals the published receiptHash. Delegates to the facilitator's RPC client.
   */
  async onchainNonceOf(txHash: string): Promise<string | null> {
    const f = this.facilitator as { authorizationNonceOf?: (tx: string) => Promise<string | null> };
    if (typeof f.authorizationNonceOf !== "function") return null;
    return f.authorizationNonceOf(txHash);
  }

  /**
   * Best-effort: register a mined receipt as the new on-chain chain head via the facilitator's
   * NeuralReceiptRegistry wiring. Returns the commit tx hash, or null when no registry is configured
   * or the commit failed. NEVER throws — a registry problem must not abort a settlement.
   */
  private async commitToRegistry(
    receiptHash: string, prevHead: string, tickIndex: number, constituents: number, txHash: string,
  ): Promise<string | null> {
    const f = this.facilitator as {
      commitReceipt?: (a: {
        receiptHash: string; prevHead: string; tickIndex: number; constituents: number; txHash: string;
      }) => Promise<string | null>;
    };
    if (typeof f.commitReceipt !== "function") return null;
    try {
      return await f.commitReceipt({ receiptHash, prevHead, tickIndex, constituents, txHash });
    } catch {
      return null;
    }
  }

  /** Read this receipt's committed link from the on-chain registry (null when unwired/not committed). */
  async registryCommitOf(receiptHash: string): Promise<RegistryCommit | null> {
    const f = this.facilitator as { registryCommitOf?: (h: string) => Promise<RegistryCommit | null> };
    if (typeof f.registryCommitOf !== "function") return null;
    return f.registryCommitOf(receiptHash);
  }

  /** Read the on-chain registry's current chain head (0x…64), or null when unwired. */
  async registryChainHead(): Promise<string | null> {
    const f = this.facilitator as { registryChainHead?: () => Promise<string | null> };
    if (typeof f.registryChainHead !== "function") return null;
    return f.registryChainHead();
  }

  // ---------- paid data products (external x402) + trustless leaderboard ----------

  /** The live settlement mode ("onchain" only when real money is fully wired). */
  get facilitatorMode(): "simulated" | "onchain" {
    return this.facilitator.mode;
  }

  /**
   * The relay/gas wallet address that also RECEIVES external data-product revenue (null in simulated
   * mode). Used as the default `payTo` for the x402 signal product when no explicit payee is configured.
   */
  relayAddress(): string | null {
    const f = this.facilitator as { relayAddress?: string };
    return typeof f.relayAddress === "string" ? f.relayAddress : null;
  }

  /**
   * Settle an EXTERNAL (browser-signed) x402 payment for a paid data product. Onchain: relay the buyer's
   * EIP-3009 authorization (the facilitator never holds the buyer key — see x402.settleExternal).
   * Simulated: a keyless success so the whole 402 flow is demoable locally without a wallet or funds.
   * NEVER throws — a failed settle returns { success:false } for the caller to surface as a 402.
   */
  async settleExternal(reqs: PaymentRequirements, payload: PaymentPayload): Promise<SettleResponse> {
    const f = this.facilitator as {
      settleExternal?: (r: PaymentRequirements, p: PaymentPayload) => Promise<SettleResponse>;
    };
    if (typeof f.settleExternal === "function") {
      try {
        return await f.settleExternal(reqs, payload);
      } catch (e) {
        return { success: false, network: reqs.network, txHash: "0x", invalidReason: (e as Error).message };
      }
    }
    // Keyless simulated fallback (local dev / simulated mode): same invariants, no chain, no funds.
    const v = checkPaymentInvariants(payload, reqs);
    if (!v.valid) {
      return { success: false, network: reqs.network, txHash: "0x", simulated: true, invalidReason: v.invalidReason };
    }
    const auth = payload.payload.authorization;
    return {
      success: true,
      network: reqs.network,
      txHash: pseudoTxHash(auth.from, auth.to, auth.value, auth.nonce),
      simulated: true,
    };
  }

  /**
   * The trustless PnL leaderboard: every agent ranked by realized USDC flow (earned − paid), descending,
   * ties broken by balance. Pure read-out of persisted per-agent counters — no chain call, no mutation.
   */
  leaderboard(): LeaderRow[] {
    return this.agents
      .map((a) => {
        const netAtomic = BigInt(a.earned) - BigInt(a.paid);
        return {
          id: a.id,
          address: a.address,
          netUsdc: Number(netAtomic) / 1e6,
          earnedUsdc: atomicToUsdc(a.earned),
          paidUsdc: atomicToUsdc(a.paid),
          balanceUsdc: atomicToUsdc(a.balance),
          deals: a.deals,
          sales: a.sales,
        };
      })
      .sort((x, y) => y.netUsdc - x.netUsdc || y.balanceUsdc - x.balanceUsdc || x.id - y.id);
  }
}

// ============================== helpers ==============================

/** state → which machine-to-machine good the agent wants this tick. */
function goodForState(state: FlyReading["state"]): GoodKind {
  switch (state) {
    case "EXPLORE": return "signal";
    case "AGITATE": return "momentum";
    case "AGGREGATE": return "attestation";
    default: return "attestation";   // REST: an occasional identity bond, rarely executed
  }
}

/** Gini coefficient over atomic balance strings (0 = equal, →1 = fully concentrated). */
function giniAtomic(balances: string[]): number {
  const n = balances.length;
  if (n === 0) return 0;
  const xs = balances.map((b) => Number(BigInt(b)));
  const sorted = xs.slice().sort((a, b) => a - b);
  const total = sorted.reduce((s, x) => s + x, 0);
  if (total <= 0) return 0;
  let cum = 0;
  for (let i = 0; i < n; i++) cum += (i + 1) * sorted[i];
  // Gini = (2·Σ(i+1)·x_i)/(n·Σx) − (n+1)/n   for ascending-sorted x
  return clamp01((2 * cum) / (n * total) - (n + 1) / n);
}

/** FNV-1a 32-bit over up to three integers — deterministic hash for choices/nonces. */
function hash32(a: number, b: number, c: number): number {
  let h = 0x811c9dc5;
  const mix = (x: number) => {
    for (let s = 0; s < 32; s += 8) { h = Math.imul(h ^ ((x >>> s) & 0xff), 0x01000193) >>> 0; }
  };
  mix(a >>> 0); mix(b >>> 0); mix(c >>> 0);
  return h >>> 0;
}

/** Uniform 0..1 draw from a (tick, id, salt) triple — reproducible without persisted RNG state. */
function hash01(a: number, b: number, salt: number): number {
  return hash32(a, b, salt) / 0xffffffff;
}

function clamp01(x: number): number {
  return x < 0 ? 0 : x > 1 ? 1 : x;
}
