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
  type FacilitatorStats,
  type PaymentRequirements,
  type PaymentPayload,
  type SettleResponse,
  type RegistryCommit,
  type ArenaRoundInfo,
  type WarInfo,
  type WarCofferStats,
} from "./x402.js";
import { housePower, type WarHouse, type HouseFeud } from "./war.js";
import type { Fap } from "@fly/fly-brain";
import {
  R6_SCALE,
  R6_SIGNED_MAX,
  evalStrategy,
  generateTree,
  mutateTree,
  treeHash,
  serializeTree,
  deserializeTree,
  isLegalTree,
  type StrategyTree,
  type StrategyCtx,
} from "@fly/fly-brain";
import type { FlyReading, CollectiveState } from "./population.js";
import type { PredictFlow } from "./prediction.js";
import {
  PROOF_VERSION,
  POLICY_VERSION,
  canonical,
  neuralEvidence,
  sha256Hex,
  netReceiptHash,
  nonceFromReceiptHash,
  type NetReceipt,
  type NeuralConstituent,
  type ProofRecord,
} from "./provenance.js";
import type { ReceiptPinner } from "./ipfs.js";
import { MarketBooks, type GoodBookView } from "./books.js";
import { ElitesArchive, computeBins, type EliteEntry } from "./elites.js";
import type { MofitInput } from "./mofit.js";

/** The machine-to-machine data goods agents buy from one another. */
export type GoodKind = "signal" | "momentum" | "attestation" | "prediction";

const GOOD_META: Record<GoodKind, { description: string; mimeType: string; priceMult: number }> = {
  // A peer's live decoded drive vector — a market-timing signal.
  signal: { description: "peer decoded drive vector (arousal/cohesion/turn)", mimeType: "application/json", priceMult: 1.0 },
  // A peer's read on temperature momentum — chased when the market is heating.
  momentum: { description: "peer temperature-momentum read", mimeType: "application/json", priceMult: 1.25 },
  // A peer's neural fingerprint — a "proof-of-feel" identity attestation, bought to bond with the swarm.
  attestation: { description: "peer neural-fingerprint attestation", mimeType: "application/json", priceMult: 0.8 },
  // A settled prediction-market payout: the net USDC a round's loser owes its winner (see prediction.ts).
  // priceMult is unused (the flow amount is fixed by the parimutuel resolution, not priced off a base).
  prediction: { description: "prediction-market resolution payout (parimutuel net)", mimeType: "application/json", priceMult: 1.0 },
};

/** Numeric index per good kind (for compact per-agent counters). */
const GOOD_IDX: Record<GoodKind, number> = { signal: 0, momentum: 1, attestation: 2, prediction: 3 };

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
  /** Additive per-agent settle failure count (H6 fix: feeds MAP-Elites settle-rate descriptor). Default 0 on old payloads. */
  settleFail?: number;
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

/**
 * SOCIAL MEMORY (economic layer ONLY — the iron law holds: neurons → intent stays one-way, nothing
 * here feeds the connectome; it only changes WHICH counterparty an agent turns to inside the pool the
 * neural drives already defined). Every fly accumulates long-lived memory of past dealings:
 *   • a directed BOND per counterpart (trust ↔ grudge, −1..1), kept top-K per agent so DO storage is bounded;
 *   • a REPUTATION scalar built from settled history (kept promises vs defaults);
 *   • a GRUDGE BOOK: a capped ring of the betrayals (stiffed deals) the whole swarm has witnessed.
 * Bonds and reputation DECAY toward zero with time/silence (the swarm forgets old wounds and old favours
 * alike) — but a deep enough grudge still re-triggers a refusal until it heals past the blacklist line.
 */
export interface SocialBond {
  other: number;      // counterpart agent id
  score: number;      // effective-at-last-touch bond, −1 (grudge) .. +1 (old partner)
  trades: number;     // settled dealings behind this bond (relationship weight)
  lastTick: number;   // sub-tick of the last touch (drives the exponential forgetting)
}

/** One agent's whole social memory: reputation + its directed bonds. */
export interface AgentSocial {
  rep: number;        // −1 (deadbeat) .. +1 (honourable), decays with silence
  repTick: number;    // last reputation touch (-1 = never)
  kept: number;       // lifetime settled deals (promises kept)
  broken: number;     // lifetime defaults (stiffed / failed payments)
  bonds: SocialBond[];
}

/** One entry of the grudge book: a witnessed default between two named flies. */
export interface GrudgeRecord {
  tick: number;
  buyerId: number;    // the one who could not pay
  sellerId: number;   // the one who was stiffed
  amount: string;     // atomic USDC that was demanded
  reason: string;     // the decline reason (e.g. insufficient-funds)
}

/** The read-out of social memory for the frontend / the historian (bounded, never feeds back). */
export interface SocialReadout {
  rep: { id: number; score: number; kept: number; broken: number }[];   // notable names, |score| desc
  bonds: { a: number; b: number; score: number; trades: number }[];     // strongest directed bonds, |score| desc
  grudges: GrudgeRecord[];                                              // newest first (the grudge book)
}

/**
 * PLAYBOOK (consequence-driven long-term memory, Phase 1 capability ①). One entry of a fly's bounded
 * episodic ring: records WHAT happened in WHICH context so future decisions can be reweighted by
 * past consequences. Economic layer ONLY — never touches the connectome (one-way law). Serialized
 * as a compact integer array [ctx, action, good, regime, outcome, valid, tick] for DO storage.
 */
export interface PlaybookEntry {
  ctx: number;      // contextHash: hash32(tick, regimeBucket, tempBucket) — the decision context
  action: number;   // 0=buy, 1=sell
  good: number;     // good index (0=signal, 1=momentum, 2=attestation, 3=prediction)
  regime: number;   // regime bucket (0=COLD, 1=CALM, 2=HOT)
  outcome: number;  // signed atomic outcome (+earned, -paid, 0=failed)
  valid: number;    // 1=settlement valid, 0=failed
  tick: number;     // tick of recording (drives exponential decay)
}

/**
 * DYNASTY CONFIG (economic layer ONLY — same one-way law as social memory: a house, a death and an
 * inheritance never feed the connectome; they only re-shape the LEDGER the neurons' trades settle into).
 * EVERY field optional so an EconomyConfig literal without `dynasty` compiles and behaves exactly as
 * before (the layer is inert until state.ts supplies the block). `enabled` defaults to true; the master
 * switch is the DYNASTY_ENABLED env folded in by config.ts.
 */
export interface DynastyConfig {
  enabled?: boolean;          // master switch (default true); false ⇒ no houses, no deaths, no tithes
  tithePct?: number;          // share of a member's settlement income that flows to the house treasury
  oldAgeTicks?: number;       // sub-ticks after birth before the eldest fly may be buried of old age
  penuryGraceTicks?: number;  // silence required on a zero balance before penury claims it (dealt flies only)
  plagueTemp?: number;        // collective temperature at or above which a plague draw may run
  plaguePct?: number;         // fraction of the living culled by oldest-first when the plague draws
  maxHouses?: number;         // hard cap on simultaneous houses (DO storage bound)
}

/** Per-fly kinship record: birth, house membership, known children, generation. */
export interface KinRecord {
  bornTick: number;           // sub-tick of birth (genesis flies: first tick the economy saw them)
  house: number | null;       // house id (= founding parent's id) or null for a commoner
  children: number[];         // hatched offspring ids (capped; inheritance heirs first)
  gen: number;                // generation (genesis 0, child = parent + 1)
}

/** A house: named by a deterministic sigil+colour off the genome hash, holding a common treasury. */
export interface HouseRecord {
  id: number;                 // = founder parent's fly id (houses are unique per founder)
  name: string;               // "Ochre", "Vermilion"… (deterministic from seedBase × parentId × genomeHash)
  sigil: string;              // one glyph from the sigil alphabet, same deterministic seed
  foundedTick: number;        // sub-tick the name was first taken
  firstHeir: number;          // the hatch that granted the founding its name
  treasury: string;           // atomic USDC held in common (tithes + unclaimed estates)
  earnedAtomic: string;       // lifetime gross member income tithed in (dynasty prestige key)
  members: number[];          // every fly ever inducted (capped; dead stay on the roster — a house is its graves too)
  gen: number;                // highest generation reached under this name
  /** culture: the founder's creed FAP frozen at founding — the house's old way (absent ⇒ pre-culture house or unknown). */
  tradition?: string;
  /**
   * WAR (additive on-chain mirror): the atomic USDC the WarCoffer contract actually escrows FOR this house,
   * refreshed from a live `vault(houseId)` read after any mined deposit/declare/resolve/levy. ABSENT ⇒ the
   * house has no on-chain vault (pre-war payload, or war never touched it) — so a round-trip of an old
   * record stays byte-identical and KEY_VERSION stays "economy:v1". This is a MIRROR of the coffer, never a
   * source of truth the ledger spends from: the members' own balances are untouched by war (only the shared
   * vault the project treasury funded is at stake).
   */
  vaultOnchainAtomic?: string;
  /**
   * TERRITORY (additive): the fixed home zone this house was granted at founding (0..zoneCount-1). ABSENT
   * for a pre-territory house — armed lazily by ensureTerritory from the house's own deterministic seed, so
   * an old record round-trips byte-identically and KEY_VERSION stays "economy:v1". A house whose home zone
   * has been CONQUERED still remembers it here; zoneControl (below) is the authority on who holds it now.
   */
  homeZone?: number;
}

/** One burial: cause, lifetime dealings, the estate and who took it. The chronicle's epitaph source. */
export interface GraveRecord {
  id: number;
  tick: number;
  cause: "aged" | "penury" | "plague";
  deals: number;              // lifetime settlements (deals + sales) — the epitaph's "4207 dealings"
  age: number;                // sub-ticks lived (tick − bornTick)
  bornTick: number;           // sub-tick this individual was born — with id-reuse, (id, bornTick) is the unique key
  estate: string;             // atomic USDC in the wallet at death (the inheritance)
  heirIds: number[];          // who received it (living children; empty ⇒ house treasury or pauper's dole)
  house: number | null;       // the house the dead belonged to, for "of the House of X"
}

/** Bounded dynasty read-out for the frontend panel + the historian (pure read-out, never feeds back). */
export interface DynastyReadout {
  houses: { id: number; name: string; sigil: string; gen: number; foundedTick: number; members: number; live: number; deaths: number; treasuryUsdc: number; earnedUsdc: number; capitalShare: number; tradition: string | null; vaultOnchainUsdc?: number; homeZone?: number; controlsZones?: number[] }[];
  graves: { id: number; tick: number; cause: string; deals: number; age: number; bornTick: number; estateUsdc: number; heirIds: number[]; houseName: string | null }[];
  living: number;
  dead: number;
  /**
   * WAR (additive, read-only): the ledger-side MIRROR totals for the frontend panel — how many houses carry
   * an on-chain vault and the cumulative EXTRA on-chain tax levied (USDC). The live coffer totals (escrow,
   * commons purse, cap) are read async from the contract in the /war endpoint, not folded in here (this
   * read-out stays synchronous + pure). Absent on a pre-war read-out ⇒ no vaults, no tax mirror.
   */
  war?: { housesWithVault: number; taxCollectedUsdc: number };
  /**
   * TERRITORY CONQUEST (additive, read-only): the authoritative zone→controller map for the WHOLE grid,
   * present only while the territory layer is armed. `houses[]` is trimmed to the prestige top-8, so a zone
   * seized by a poor victor would otherwise never surface (its controlsZones is cut) — leaving a conquest
   * invisible on the frontend field. This bounded map (≤ zoneCount) lets the frontend recolour a seized zone
   * and read it as contested regardless of the victor's standing. Pure read-out: never hashed, never persisted,
   * never feeds back into the connectome/genome (KEY_VERSION stays economy:v1). Absent when territory is off.
   */
  zoneOwners?: { zone: number; houseId: number; name: string; sigil: string }[];
}

/**
 * INSTITUTIONS ② — professions, credit, classes (the social-structure half of layer ⑥).
 * Sticky professions are an ECONOMIC read of recent behaviour (fap history): they tilt buy desire and
 * deal size, never a neuron. IOUs are promises to settle LATER — issuing one moves no money at all
 * (only repayment does, through the same ledger lines as any deal), so the no-minting law holds.
 */
export type Profession = "forager" | "mooder" | "trader" | "brooder";

/** Sticky role: the fap mode of the recent past, hysteresis-locked (switching costs 12+ ticks and a draw). */
export interface ProfessionRecord {
  role: Profession;
  sinceTick: number;   // when the current line of work was taken up
  streak: number;      // ticks kept since then (the sticky in sticky professions)
}

/** One credit promise: `debtor` owes `creditor` atomic USDC (+ ratePer10 per 10 ticks, capped). */
export interface IouRecord {
  debtor: number;
  creditor: number;
  amountAtomic: string;   // principal, atomic USDC
  issuedTick: number;
  ratePer10: number;      // interest per 10 sub-ticks (0 ⇒ a favour, not a loan)
}

/** Four classes counted off balances, debts and flows — a READ-OUT, not a cage. */
export interface ClassReadout {
  creditors: number;    // holds at least one live IOU against them
  debtors: number;      // owes at least one live IOU
  producers: number;    // living, lifetime inflow exceeds outflow
  speculators: number;  // recent-window buys were mostly prediction payouts
}

/** Bounded institutions read-out for /economy + the frontend (pure read-out, never feeds back). */
export interface MarketReadout {
  professions: Record<Profession, number>;
  classes: ClassReadout;
  openIous: number;
  debtAtomic: string;      // total live principal outstanding
  badRate: number;         // share of live IOUs older than IOU_OVERDUE_TICKS
  run: boolean;            // a credit RUN is in progress (mass recall, wide spreads)
  topIou: { debtor: number; creditor: number; amountUsdc: number } | null; // the largest live note (CREDIT signal)
  creditorNetShare: number; // creditors' share of the swarm's positive net worth, 0..1 (CLASS signal)
  marks: Record<string, string[]>;
  books: GoodBookView[];
}

/** FAP → profession: what a fly keeps doing becomes what a fly keeps being (economic side only). */
const FAP_PROFESSION: Record<Fap, Profession> = {
  FEED: "forager", FORAGE: "forager",
  GROOM: "mooder", HALT: "mooder", COURT: "mooder",
  FLIGHT: "trader", RETREAT: "trader",
  HUDDLE: "brooder", REST: "brooder",
};
const PROF_KEYS: Profession[] = ["forager", "mooder", "trader", "brooder"];
// Profession tilts (economic intent only — the multiplicative core of buyProbability / dealAmount):
// foragers buy signal greedily, traders pay through (and are worth a fatter rung), brooders hoard rest.
const PROF_BUY: Record<Profession, number> = { forager: 1.25, trader: 1.1, mooder: 1.0, brooder: 0.75 };
const PROF_DEAL: Record<Profession, number> = { forager: 1.0, trader: 1.05, mooder: 1.0, brooder: 0.9 };
const PROF_WINDOW_DECAY = 0.98;   // tally decays toward zero: ≈50-tick effective window, no history array
const PROF_SWITCH_TICKS = 12;     // a new mode must hold this long before the line of work can change
const PROF_SWITCH_PCT = 0.5;      // …and still only takes a coin-flip to actually switch trades
const PROF_SALT = 0x50ec;
const IOU_CAP = 48;               // hard bound on live credit promises (DO storage)
const IOU_PER_DEBTOR = 8;
const IOU_RATE_PER_10 = 0.002;    // 2厘 per 10 ticks, overridable via config
const IOU_INTEREST_CAP = 0.5;     // interest can never exceed 50% of principal
const IOU_OVERDUE_TICKS = 10_000;
const IOU_MAX_AGE = 20_000;       // older than this, it is a default, not a debt
const CREDIT_CAP_BASE_USDC = 0.05;
const CREDIT_ROLES: Profession[] = ["trader", "forager"];  // the classes trusted with tomorrow's money
const DEBT_SWEEP_PCT = 0.3;       // a debtor quietly pays 30% of every balance it grows
const RECALL_GAP_TICKS = 6;       // at most one creditor-led recall per cron
const RUN_AVG_VALENCE = -0.45;    // swarm-wide dread level that starts a stampede to the exits
const RUN_BAD_PCT = 0.15;         // …combined with this share of IOUs overdue
const RUN_HOLD_TICKS = 6;         // a RUN lasts one cron's worth of sub-ticks
const CREDIT_MAX_PAYS_PER_TICK = 8;

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
  /** dynasty: ledger closed — this fly is buried (absent ⇒ living; only ever set by a death). */
  dead?: boolean;
  /** dynasty: house name + sigil this fly bears (absent ⇒ commoner). */
  house?: string;
  sigil?: string;
  /** territory: the zone this fly physically sits in — its house's home zone (absent ⇒ layer off, or a
   *  commoner/houseless fly). A LOCATION, not a claim; lets the frontend anchor the fly on the fixed 4×4
   *  grid WITHOUT a name→zone join (house names can collide). Zone 0 is a valid value. */
  zone?: number;
  /** institutions: sticky profession (absent ⇒ layer off; null ⇒ not yet working). */
  profession?: Profession | null;
  /** institutions: live IOU principal owed by this fly, atomic USDC (absent ⇒ layer off). */
  debtAtomic?: string;
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
  settleOk: number;        // lifetime mined on-chain net settlements (successes)
  settleFail: number;      // lifetime on-chain net settlement attempts that failed to mine
  settleAttempts: number;  // settleOk + settleFail (real broadcast attempts, shadow dry-runs excluded)
  successRate: number | null; // settleOk / settleAttempts, or null before any attempt
  liveAgents: number;
  meanBalanceUsdc: number;
  gini: number;           // 0 = equal wealth, →1 = concentrated (emergent from neural diversity)
  treasuryOutAtomic: string; // simulated liquidity injected to keep agents solvent
  commonsPoolAtomic: string; // #123: dead-house sweeps + reform levy deductions (additive scoreboard, never spent)
  richestId: number | null;
  poorestId: number | null;
  // LATENCY (additive, observe-only): submit→finality ms of successful on-chain settles, timed at the
  // facilitator facade so it covers whichever rail is live (onchain-direct or Circle). null/0 before the
  // first mined settle. Pure telemetry — never feeds back into balances, nonces, or the broadcast path.
  settleMsAvg: number | null; // mean settle latency (ms), or null before any timed success
  settleMsMax: number;        // slowest successful settle (ms)
  settleMsLast: number;       // most recent successful settle (ms)
  settleMsN: number;          // number of timed successful settles
  // NET-PENDING (additive, live gauge — derived from the persisted pendingNets accumulator, never stored):
  netPending: number;         // pair-nets currently folded and awaiting broadcast
  netPendingTrades: number;   // gross trades folded into those pending nets
  // R5 FIX B (additive, observe-only): lifetime Σ|internal-mirror − on-chain| atomic delta absorbed by the
  // periodic mirror re-align. Stays "0" while ECONOMY_MIRROR_RESYNC_EVERY_N_CRON=0 (disabled), so an OFF build
  // is byte-for-byte today's. Pure telemetry — NEVER folded into the PoCA stateDigest `econ` field (which
  // stays {volumeAtomic,count}), never feeds back into balances, caps or the broadcast path.
  mirrorDriftAtomicSum: string;
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
  /** Bounded social-memory read-out: reputations, strongest bonds, the grudge book. Pure read-out. */
  social: SocialReadout;
  /** Bounded dynasty read-out: houses, graves, living/dead counts. Additive — pure read-out. */
  dynasty?: DynastyReadout;
  /** Bounded institutions read-out: professions, classes, credit, mark tapes. Additive — pure read-out. */
  market?: MarketReadout | null;
  /** A rolling window of recent settlements for the ledger HUD. */
  recent: Settlement[];
  totals: EconomyTotals;
  /** PLAYBOOK read-out (flag-guarded, absent when OFF → dark-deployment byte-equivalent). Shape matches evolution.js contract. */
  playbook?: Array<{ id: number; e: number[][] }>;
  /** MAP-Elites archive read-out (flag-guarded, absent when OFF → dark-deployment byte-equivalent). Shape matches evolution.js contract. */
  elitesArchive?: Array<{ c: number; a: number; f: number; h: string; t: number; b: [number, number, number] }>;
  /** SHADOW-COMPARE aggregate (flag-guarded, absent when OFF → dark-deployment byte-equivalent). */
  shadowCompare?: ShadowAggregate;
  /** #143 ESTATE-RELIEF read-out (flag-guarded, absent when OFF → dark-deployment byte-equivalent). */
  estateRelief?: {
    escrowPoolAtomic: string; pendingEstates: number;
    sweptCount: number; sweptAtomic: string; paidCount: number; paidAtomic: string; reliefTodayAtomic: string;
  };
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
  /** #98 Fix 2: max pairs to BROADCAST per cron flush (0 or absent = no cap, legacy). Remaining carry forward. */
  netFlushBudgetPerCron?: number;
  // --- live-population GROWTH: a HATCHED offspring (id >= populationSize) opens its DISPLAY mirror at the
  //     REAL bootstrap its parent funded it with (hatchSeedUsdc), not the genesis initialBalance — otherwise
  //     the frontend would show a newborn as fake-rich (wrong wallet number AND wrong wealth-ramp size/colour).
  populationSize: number;          // fixed genesis cohort size; ids >= this are hatched offspring
  hatchSeedUsdc: number;           // real USDC a parent funds each hatched child's wallet with (its opening mirror)
  // --- DYNASTY (houses/inheritance/death): OPTIONAL — absent ⇒ the whole layer is inert, byte-for-byte ---
  dynasty?: DynastyConfig;
  // --- INSTITUTIONS (limit books / professions / credit): OPTIONAL — absent ⇒ dealAmount stays on the
  //     fixed formula byte-for-byte; ON ⇒ each deal crosses the tick's aggregate book (see books.ts),
  //     flies take sticky professions, and the thin of purse trade on IOUs (simulated ledger only) ---
  institutions?: {
    enabled: boolean;
    creditCapBaseUsdc?: number;   // base credit line (traders double it, reputation scales it)
    iouRatePer10?: number;        // interest per 10 sub-ticks on live IOUs
  };
  // --- ORGANIC CONFLICT (rivalry / envy / embargo / raid): OPTIONAL — absent/false ⇒ every conflict hook
  //     no-ops AND houseFeuds stays a pure mean, so the economy is byte-for-byte unchanged. These are pure
  //     social-memory nudges (negative cross-house bonds via touchBond): they NEVER move or mint money and
  //     NEVER touch the connectome/genome/manifestHash. They exist only so a genuine feud can reach the
  //     war threshold on-chain (where insufficient-funds betrayals structurally cannot fire). ---
  conflict?: {
    enabled: boolean;
    rivalStep: number;      // grudge per tick between houses competing in the same good's market
    envyStep: number;       // max grudge a losing house takes toward the dominant house on a hot shock
    embargoStep: number;    // grievance accrued when a buyer's whole span is shunned (retaliatory hold)
    raidStep: number;       // heavy social grudge a raided house's member takes toward the raider house
    raidProb: number;       // per-cron hash-gated probability a raid is attempted
    feudBlend: number;      // 0 ⇒ pure-mean houseFeuds (byte-identical); >0 weights the worst grudges in
  };
  // --- TERRITORY & CONQUEST (economic asymmetry on a fixed zone grid): OPTIONAL — absent/false ⇒ every
  //     territory hook no-ops AND applyTerritory is a pure passthrough, so the economy is byte-for-byte
  //     unchanged. Each house holds ONE fixed home zone; a deal inside the buyer's own controlled zone is
  //     discounted, a deal reaching into another house's zone pays a TOLL, part of which is tributed to the
  //     zone's controller (a bounded additive treasury accrual, mirroring the tithe). It re-prices a deal
  //     the neurons already agreed to (one-way street): NEVER touches connectome/genome/manifestHash. ---
  territory?: {
    enabled: boolean;
    zoneCount: number;        // the grid size (default HOUSE_CAP=16 ⇒ one unique home zone per house)
    tollPct: number;          // surcharge on a cross-zone (foreign) deal, as a fraction
    homeDiscountPct: number;  // discount on a deal inside the buyer's own controlled zone, as a fraction
    tributePct: number;       // fraction of the toll tributed to the zone controller's treasury
    exileSeverity: number;    // extra toll multiplier on a landless (conquered/exiled) buyer, bounded
    powerPerZone: number;     // war power added per controlled zone (0 ⇒ off, winnerOf lock-step unchanged)
  };
  // --- PLAYBOOK (consequence-driven long-term memory, Phase 1 capability ①): OPTIONAL — absent/false ⇒
  //     every playbook hook no-ops, the economy is byte-for-byte unchanged. A bounded per-fly episodic
  //     ring (16 entries) that remembers the outcome of past trades and reweights good selection +
  //     counterparty choice within existing hard caps. NEVER touches connectome/genome/manifestHash. ---
  playbook?: {
    enabled: boolean;
  };
  // --- STRATEGY (Phase 2b capability ②: GP expression trees modulate economic decisions): OPTIONAL —
  //     absent/false ⇒ every strategy hook no-ops, the economy is byte-for-byte the Phase 1 build.
  //     Per-fly trees evaluate over EXISTING neural read-outs and tilt buyProbability / pickCounterparty /
  //     dealAmount / prediction score WITHIN existing hard caps. NEVER touches connectome/genome/manifestHash. ---
  strategy?: {
    enabled: boolean;
  };
  // --- ㉝ RULES (Phase 5 capability ⑤: bounded rule creation modulates two economic decisions): OPTIONAL —
  //     absent/false ⇒ every rules hook no-ops (rulesTilt returns 1.0) and the economy is byte-for-byte the
  //     pre-Rules build. A rule's band-clamped multiplier tilts buyProbability / the counterparty weight WITHIN
  //     the constitutional band [0.5, 2.0] AND the existing hard caps. NEVER touches a settlement, a deal amount,
  //     a real-spend cap, a mnemonic, x402, connectome/genome/manifestHash, and NEVER signs/broadcasts. ---
  rules?: {
    enabled: boolean;
    buyMin: number;   // constitutional band floor on the buyProbability multiplier (hard 0.5)
    buyMax: number;   // constitutional band ceiling on the buyProbability multiplier (hard 2.0)
    cpMin: number;    // constitutional band floor on the counterparty-weight multiplier (hard 0.5)
    cpMax: number;    // constitutional band ceiling on the counterparty-weight multiplier (hard 2.0)
  };
  // --- ELITES (Phase 2b capability ②: MAP-Elites novelty archive): OPTIONAL — absent/false ⇒ archive is
  //     never updated, planEvolution uses pure-PnL selection byte-for-byte. When armed, a bounded 3-D
  //     behavioural archive (4×4×4 = 64 cells) drives novelty exploration alongside PnL fitness. ---
  elites?: {
    enabled: boolean;
  };
  // --- CULTURAL (Phase 3 capability ③: vertical cultural transmission at noteHatch): OPTIONAL — absent/false
  //     ⇒ noteHatch behaves byte-for-byte as Phase 2b (a child hatches blank). When armed, a真亲子 hatch copies
  //     a DISCOUNTED subset of the parent's social memory + a COMPRESSED playbook summary into the child as a
  //     prior. NEVER touches connectome/genome/manifestHash; moves no money. ---
  cultural?: {
    enabled: boolean;
  };
  // --- LAMARCK (Phase 3 capability ③: genome imprinting at breed): OPTIONAL — absent/false ⇒ the child genome
  //     is exactly the mutate/cross output (byte-for-byte Phase 2b). When armed, economy.lamarckVector() derives
  //     a bounded signed performance vector that breed.ts applies as a ±5% bias on the child's 4 genome scalars
  //     (clamped back into legal bounds, folded into genomeHash). The economy side ONLY computes the vector —
  //     it never writes the genome itself, so the one-way law and manifestHash invariant both hold. ---
  lamarck?: {
    enabled: boolean;
  };
  // --- SHADOW-COMPARE (task #87): OPTIONAL — absent/false ⇒ zero overhead, zero new keys in snapshot(),
  //     serialize() byte-for-byte identical, no D1 writes. When armed, shadowStep() mirrors the decision
  //     loop with evolution capabilities ON and records baseline-vs-evolved diffs. PURE READ-OUT: never
  //     touches facilitator/queueNet/settle/flush/absorbFlows/payBreedingFee/payHatchFee, never writes any
  //     real field (balance/paid/earned/deals/sales/volumeAtomic/count/settleOk|Fail/recent/pendingNets/
  //     proofs/proofChainHead/spendGuard/social/grudges). Evidence lands in D1 ONLY, never in DO blob. ---
  shadowCompare?: {
    enabled: boolean;
    everyNCrons: number;
    maxDecisionsPerCron: number;
    maxRowsPerCronToD1: number;
  };
  // --- #123 EQUITY TILT: market-side wealth redistribution via counterparty weight. OPTIONAL — absent/false ⇒
  //     equityTilt multiplier ≡ 1.0 (multiplicative identity), pickCounterparty byte-for-byte unchanged.
  //     Only tilts cp-weight; NEVER touches buyProbability, deal amount, caps, or any settlement. ---
  equityTilt?: {
    enabled: boolean;
    band: [number, number];   // [floor, ceil] hard clamp (defense-in-depth, mirrors RULE_FLOOR/RULE_CEIL)
    strength: number;         // tilt amplitude 0..1 (0 ⇒ identity)
  };
  // --- #123 DEAD HOUSE SWEEP: route estates of zero-living-member houses to the commons pool scoreboard.
  //     OPTIONAL — absent/false ⇒ entomb branch ② byte-for-byte unchanged (all estates → house.treasury). ---
  deadHouseSweep?: {
    enabled: boolean;
  };
  // --- #143 ESTATE RELIEF (ONCHAIN): stop a dead house's real USDC from sleeping forever. When armed AND the
  //     facilitator is onchain AND escrowAddress is wired, each burial enqueues the orphaned wallet for an
  //     ON-CHAIN sweep: dead purse → reserved escrow, then every Nth cron escrow drips to the POOREST living
  //     wallets. Money moves only on a mined EIP-3009 receipt (a treasuryTransfer leg, no neural provenance),
  //     bounded by the per-deal cap + a daily relief budget, under the ECONOMY_REAL_SPEND kill switch and
  //     shadow mode. OPTIONAL — absent/false ⇒ entomb, flush and the cron are byte-for-byte today's build
  //     (no queue, no sweep, no disbursement; the commons scoreboard keeps its #123 accumulate-only behaviour).
  //     The id-reuse misfire guard re-checks the tombstone at sweep time: a slot reclaimed by a new hatch is
  //     dropped from the queue, so a living fly's purse is NEVER swept. ---
  estateRelief?: {
    enabled: boolean;
    reliefEveryNCrons: number;    // 0 = never disburse (default-ish guard); N>0 ⇒ escrow→poor drip every Nth cron
    reliefChunkUsdc: number;      // max USDC per single escrow→poor transfer (further clamped by ECONOMY_MAX_DEAL)
    reliefDailyBudgetUsdc: number; // max USDC disbursed from escrow per UTC day (a ceiling BELOW the spend caps)
    maxSweepsPerCron: number;     // estate→escrow sweeps attempted per cron (wall-clock guard, like flush budget)
  };
  // --- R5 FIX A (ONCHAIN BALANCE GATE): OPTIONAL — absent/false ⇒ queueNet never consults on-chain balances,
  //     byte-for-byte today (every neuron-picked trade is folded into pendingNets). When armed, each cron opens
  //     with ONE batched multicall balanceOf over live agents (see x402 readBalances); the trade planner then
  //     REFUSES to queue a pair whose debtor cannot cover the deal on-chain, so doomed 100%-settle-fail pairs stop
  //     accumulating in netPending. On-chain reads are authoritative external inputs (same class as settle()'s
  //     balanceOf), never a determinism input. NEVER touches balances, caps, the stateDigest, or real money. ---
  onchainBalanceGate?: {
    enabled: boolean;
  };
  // --- R5 FIX B (MIRROR RE-ALIGN): OPTIONAL — absent / everyNCrons<=0 ⇒ the display mirror is never overwritten,
  //     byte-for-byte today. When armed, every Nth cron overwrites each live agent's DISPLAY mirror with its real
  //     on-chain balanceOf (re-using Fix A's multicall cache), recording the pre-resync drift as telemetry. SAFETY:
  //     the mirror is only ever set EQUAL to on-chain (or, elsewhere, adjusted DOWNWARD) — NEVER inflated above it.
  //     Ineffective alone; MUST be paired with Fix A. Pure ledger-mirror write: no real money, no caps, no digest. ---
  mirrorResync?: {
    everyNCrons: number;   // 0 = disabled/never (code-default); N>0 ⇒ re-align every Nth cron
  };
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
  /**
   * Optional best-effort IPFS pinner for net receipt bodies (trustless availability). Absent ⇒ no pinning,
   * byte-for-byte today's behaviour. See src/ipfs.ts — the trust root stays sha256(body)==the on-chain hash.
   */
  pinner?: ReceiptPinner;
  /**
   * #143 ESTATE-RELIEF escrow purse address (a reserved HD index disjoint from every agent + the facilitator).
   * Absent ⇒ the onchain estate sweep has nowhere to gather funds and stays inert (simulated / unwired default).
   */
  escrowAddress?: string;
}

// ---------- SHADOW-COMPARE types (task #87): decision evidence rows + bounded aggregate ----------

/** One shadow-compare decision row: baseline vs evolved for a single agent in one sub-tick. */
export interface ShadowDecision {
  ts: number;
  tick: number;
  cron: number;
  buyerId: number;
  sellerIdBase: number;
  sellerIdEvo: number;
  goodBase: string;
  goodEvo: string;
  wantBase: number;
  wantEvo: number;
  amountBaseAtomic: string;
  amountEvoAtomic: string;
  amountEvoAfterCapAtomic: string;
  capReason: string;
  treeHash: string;
  pbConfidence: number;
  pbAmplifier: number;
  pbExplore: boolean;
  regime: string;
  tempBucket: number;
}

/** Bounded per-cron aggregate counters for /economy.shadowCompare (flag-guarded). */
export interface ShadowAggregate {
  crons: number;
  decisions: number;
  baselineBuys: number;
  evolvedBuys: number;
  gateFlipsToBuy: number;
  gateFlipsToHold: number;
  goodSwitches: number;
  sellerChanges: number;
  amountDeltaSumAtomic: number;
  amountDeltaMaxAtomic: number;
  evolvedAmountSumAtomic: number;
  baselineAmountSumAtomic: number;
  cappedByMaxDeal: number;
  cappedByDailyGlobal: number;
  cappedByDailyAgent: number;
  newEliteCells: number;
  avgAmplifier: number;
  exploreCount: number;
  treeHashDistinct: number;
}

const KEY_VERSION = "economy:v1";
const RECENT_CAP = 48;
// --- social-memory tuning (all deterministic; sizes are hard caps so DO storage stays bounded) ---
const BOND_TOP_K = 8;                    // directed bonds remembered per agent (top-K by |score|/trades)
const BOND_HALF_LIFE = 6000;              // sub-ticks until an untouched POSITIVE bond fades to half (~17h) — accelerated so trust churns on the swarm's own clock, not the human one
// Grudges outlast favours: a negative bond heals on a ~3x slower clock, so a wound is remembered far longer
// than a deal is. Asymmetric memory — a society lets a kindness go sooner than a betrayal.
const BOND_WOUND_HALF_LIFE = 18000;      // sub-ticks until an untouched NEGATIVE bond fades to half (~50h) — wounds still outlast favours (~3×), but grudges now heal in days, not ~10
const REP_HALF_LIFE = 60000;             // reputation forgets slower than a single bond (~56h)
const GRUDGE_CAP = 24;                   // grudge book ring size
const BOND_TRADE_STEP = 0.03;            // trust earned per settled deal (0.08→0.03: friendly trades no longer flood out accumulating grudges)
const BOND_BETRAY_STEP = 0.55;           // grudge taken by the stiffed seller
const REP_KEEP_STEP = 0.05;              // reputation for paying/delivering as promised
const REP_BETRAY_STEP = 0.35;            // reputation lost when defaulting (simulated stiff)
const REP_FAIL_STEP = 0.1;               // reputation lost on an onchain failed net (lighter: could be rails)
const BOND_BLACKLIST = -0.6;             // bond at or below this ⇒ flat-out refusal ("never trade with #N")
const ALLIANCE_MIN_TRADES = 8;           // a partnership is only chronicle-worthy once seasoned
const PICK_CANDIDATES = 5;               // pool size re-weighted inside the neural span
const FEUD_WORST_K = 5;                  // houseFeuds blend: how many of a pair's deepest bonds the "worst mean" averages (3→5: a broader grudge cluster can tip a house feud)
// --- playbook tuning (Phase 1, capability ①: consequence-driven long-term memory; all deterministic) ---
const PLAYBOOK_CAP = 16;                 // max entries per fly (bounded ring buffer; ~640B/fly)
const PLAYBOOK_HALF_LIFE = 12000;        // sub-ticks for exponential decay of old entries (~3.3h at 1/s)
const PLAYBOOK_EPSILON = 0.08;           // ε-greedy exploration floor: min 8% uniform-random counterparty pick; the GOOD override uses ε/2 = 4% (a lighter nudge on the neural good choice)
const PLAYBOOK_MAX_BIAS = 0.35;          // max reweighting magnitude on counterparty weights (never expands risk caps)
const PLAYBOOK_GOOD_SWITCH_MAX = 0.25;   // max probability of playbook overriding the neural good choice
const PLAYBOOK_RESTORE_CAP = 256;         // L13: hard cap on outer playbook array length during restore (bounded iteration)
const PLAYBOOK_SALT_EPS = 0x706c6179;    // deterministic salt for ε-greedy draw ("play")
const PLAYBOOK_SALT_GOOD = 0x626f6f6b;  // deterministic salt for good-switch draw ("book")
const PLAYBOOK_SALT_CONF = 0x6d656d6f;  // deterministic salt for confidence modulation ("memo")
// --- Phase 3 capability ③: intergenerational knowledge transfer (cultural + Lamarckian; all deterministic) ---
const CULTURAL_BOND_POS_SHARE = 0.5;    // a child inherits 50% of a parent's POSITIVE bond (a discounted trust prior)
const CULTURAL_BOND_NEG_SHARE = 0.25;   // a child inherits 25% of a parent's NEGATIVE bond (a fainter grudge prior)
const CULTURAL_REP_SHARE = 0.5;         // a child inherits 50% of the parent's reputation as its starting name
const CULTURAL_PB_OUTCOME_SHARE = 0.5;  // the compressed playbook prior carries half the parent's mean outcome magnitude
const CULTURAL_SALT_PB = 0x63756c74;    // deterministic salt for the compressed-summary context hash ("cult")
const CULTURAL_SALT_TREE = 0x73656564;  // deterministic salt for the vertical strategy-tree mutation seed ("seed")
const LAMARCK_SALT = 0x6c616d61;        // deterministic salt for the Lamarckian rngSeed jitter draw ("lama")
const LAMARCK_PROFIT_SCALE = 1_000_000; // atomic-USDC soft-scale for the profit normaliser (rational, no transcendental)
const GOOD_KIND_COUNT = 4;              // signal / momentum / attestation / prediction
const REGIME_COUNT = 3;                 // COLD(0) / CALM(1) / HOT(2)
const GOOD_KINDS: GoodKind[] = ["signal", "momentum", "attestation", "prediction"];
/** How many neural-provenance receipts to keep published (newest first) for /proofs + the chain. */
const PROOFS_CAP = 64;
// --- dynasty tuning (all deterministic; every collection is a hard cap so DO storage stays bounded) ---
const HOUSE_CAP = 16;                   // simultaneous houses at most (older houses endure, no new names past it)
const HOUSE_MEMBERS_CAP = 200;           // roster cap per house (a house is bounded memory, not a nation)
const HOUSE_TITHE = 0.02;                // 2% of a member's settled income flows to the common treasury
const GRAVE_CAP = 24;                    // epitaph ring size (newest first)
const ESTATE_QUEUE_CAP = 64;             // #143: orphaned wallets awaiting an on-chain estate→escrow sweep (bounded FIFO)
const RELIEE_LIMIT_PER_CRON = 4;         // #143: poorest living wallets a single relief drip pass may feed (bounded)
const CHILD_CAP = 24;                    // children remembered per fly for inheritance (oldest 24 by hatch order)
const OLD_AGE_DEFAULT = 150000;          // sub-ticks ≈ 5.8 days at ~1/s before the eldest may be buried
const PENURY_GRACE_DEFAULT = 20000;      // silence on an empty wallet before penury claims it (~1.9h)
const PLAGUE_TEMP = 0.93;                // collective temperature at which a plague draw may run
const PLAGUE_PCT = 0.12;                 // share of the living culled, oldest first, when the plague draws
const DYNASTY_SHARE_FOCUS = 0.18;        // a house holding ≥18% of swarm capital is chronicle-worthy
const HOUSE_COLORS = [
  "Ochre", "Russet", "Umber", "Vermilion", "Azure", "Glacial",
  "Ashen", "Ember", "Verdant", "Ivory", "Obsidian", "Amber",
];
const HOUSE_SIGILS = ["\u2B22", "\u2726", "\u2756", "\u25C6", "\u25B2", "\u2B23", "\u2735", "\u25C8"];
// --- territory tuning (all deterministic; the grid is a hard cap so DO storage stays bounded) ---
const TERR_TOLL_PCT = 0.12;               // surcharge on a cross-zone (foreign) deal
const TERR_HOME_DISCOUNT_PCT = 0.05;      // discount on a deal inside the buyer's own controlled zone
const TERR_TRIBUTE_PCT = 0.5;             // fraction of the toll tributed to the zone controller's treasury
const TERR_EXILE_SEVERITY = 0.5;          // extra toll multiplier on a landless (conquered) buyer, bounded
const TERR_POWER_PER_ZONE = 0;            // war power per controlled zone (0 ⇒ off; winnerOf lock-step unchanged)

/** §10.9: consecutive verify-fail threshold after which a pending net is EXPIRED (removed from
 *  pendingNets, debt forgiven).  Prevents 12 fixed dust-balance debtors from consuming flush budget
 *  indefinitely.  In-memory only; resets on DO eviction (same as pairBackoff). */
const VERIFY_FAIL_EXPIRE_THRESHOLD = 20;

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
  // Real-money settlement reliability: terminal outcomes of on-chain net settlements. `settleOk` counts
  // mined successes, `settleFail` counts every attempt that never mined (verify-failed / settle-failed,
  // including the bred-fly "no signer for payer" class). Additive + persisted (default 0 on old payloads)
  // so a success rate can be published WITHOUT a KEY_VERSION bump.
  private settleOk = 0;
  private settleFail = 0;
  // LATENCY (additive, observe-only): submit→finality ms of successful settles. Persisted exactly like
  // settleOk/settleFail (default 0 on old payloads ⇒ KEY_VERSION stays "economy:v1", ledger never discarded).
  // settleMsAvg is derived in snapshot(); these four are the raw accumulators. The timing wraps the
  // facilitator facade call only — it never alters the money path it observes.
  private settleMsSum = 0;
  private settleMsN = 0;
  private settleMsMax = 0;
  private settleMsLast = 0;
  /** Per-pair consecutive-failure streak for exponential backoff (in-memory only, resets on DO eviction).
   *  Key = pendingNets pair key ("lo>hi"), value = { streak, lastFailTick }. */
  private pairBackoff = new Map<string, { streak: number; lastFailTick: number }>();
  /** §10.9: per-pair consecutive verify-fail counter.  When it reaches VERIFY_FAIL_EXPIRE_THRESHOLD the
   *  pending net is expired (removed from pendingNets, debt forgiven) to stop consuming flush budget.
   *  In-memory only; resets on DO eviction.  A successful settle clears the counter. */
  private verifyFailStreak = new Map<string, number>();
  private treasuryOutAtomic = "0";
  /**
   * #123 COMMONS POOL (additive scoreboard): accumulates dead-house estate capital + reform levy deductions.
   * Purely internal bookkeeping — NEVER added to any individual agent mirror (avoids criterion-B: mirror > chain
   * ⇒ settle failure). Offsets future downward extractions (tithe / breeding fee). Persisted additively; an older
   * payload has no `commonsPoolAtomic` ⇒ "0" (nothing ever swept). KEY_VERSION stays "economy:v1".
   */
  private commonsPoolAtomic = "0";
  /**
   * #143 ESTATE RELIEF (onchain, dark). The reserved escrow purse address injected by state.ts (a high HD
   * index disjoint from every agent + the facilitator). Absent ⇒ the onchain sweep has nowhere to gather and
   * stays inert even if armed. NEVER a live fly; never id-recycled.
   */
  private escrowAddress?: string;
  /**
   * #143: scoreboard of real USDC physically gathered into the escrow purse, net of disbursements. Additive
   * on IN (escrow→estate) and SUBtractive on relief (escrow→poor) — the FIRST true outflow of the commons.
   * Written to serialize() ONLY when the layer is armed ⇒ an OFF serialize is byte-for-byte today's blob.
   */
  private escrowPoolAtomic = "0";
  /**
   * #143: ids of buried wallets awaiting their estate→escrow on-chain sweep (bounded FIFO, dedup by id).
   * The sweep re-checks the tombstone at execution, so a slot reclaimed by a new hatch is dropped (never
   * swept). Persisted only while armed; an older/absent payload ⇒ empty queue (nothing pending).
   */
  private pendingEstates: number[] = [];
  /** #143: escrow→poor disbursements metered per UTC day (a ceiling BELOW the real-spend caps). Runtime counter. */
  private reliefToday: { day: string; atomic: string } = { day: "", atomic: "0" };
  /** #143: onchain cron boundaries seen by the relief executor (runtime-only, drives the relief cadence modulo). */
  private reliefCronCount = 0;
  /** #143: lifetime counters exposed at /economy (observe-only; never hashed, never in stateDigest). */
  private estateSweptCount = 0;
  private estateSweptAtomic = "0";
  private reliefPaidCount = 0;
  private reliefPaidAtomic = "0";
  /** #123 equity-tilt rank cache: recomputed once per tick, cleared on step() entry. Runtime-only, never persisted. */
  private eqRankTick = -1;
  private eqRanks: Float64Array | null = null;
  /**
   * R5 FIX A/B: per-cron cache of authoritative on-chain ERC-20 balances (key = LOWERCASED address → atomic USDC),
   * filled by ONE batched multicall (x402 readBalances) at the cron boundary and valid for that cron only. Runtime-
   * only, NEVER persisted, NEVER in serialize(), NEVER folded into the stateDigest. `null` ⇒ cold cache (switches
   * off, simulator, or the multicall failed) — every consumer FAILS OPEN on null so the build degrades to today's.
   */
  private onchainBalances: Map<string, bigint> | null = null;
  /** R5 FIX B: count of onchain cron boundaries seen (runtime-only, never persisted). Drives the resync cadence. */
  private econCronCount = 0;
  /** R5 FIX B telemetry: lifetime Σ|mirror − onchain| atomic absorbed by re-aligns (persisted only when Fix B is on). */
  private mirrorDriftAtomicSum = "0";
  /** R5 FIX B telemetry: the most recent cron's absorbed |mirror − onchain| delta (runtime-only, snapshot read-out). */
  private mirrorDriftAtomicLast = "0";
  /**
   * WAR mirror (additive): cumulative EXTRA on-chain USDC levied as tax into the coffer's commons purse,
   * bumped only after a MINED levyTax. A ledger-side MIRROR of the contract, never a spendable balance — the
   * real tax already moved inside the coffer (no USDC ever crossed its boundary here). Persisted so the /war
   * read-out survives a DO eviction; stays "0" while the war layer is off, so behaviour is unchanged.
   */
  private warTaxAtomic = "0";
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
  /** Monotonic counter mixed into breeding-fee nonces so two evolution breeds never reuse an EIP-3009 nonce. */
  private evoNonceSeq = 0;
  /** Published neural-provenance receipts, newest first (each hashed into an on-chain nonce). */
  private proofs: ProofRecord[] = [];
  /** receiptHash of the most recent broadcast — the head of the tamper-evident proof chain. */
  private proofChainHead = "";
  /** Optional best-effort IPFS pinner for receipt bodies (absent ⇒ no pinning). Injected via deps. */
  private pinner?: ReceiptPinner;
  /**
   * SOCIAL MEMORY (economic layer only). Directed per-agent bonds + reputation, keyed by agent id, and the
   * capped grudge book. Persisted with the economy; NEVER read by the neural layer — it only re-weights
   * counterparty choice inside the pool the neurons already picked. Bounded: top-K bonds per agent, ring of
   * grudges, one scalar rep per agent.
   */
  private social = new Map<number, AgentSocial>();
  private grudges: GrudgeRecord[] = [];
  /**
   * DYNASTY (economic layer only, same one-way law as social memory): kinship + houses keyed by fly id, a
   * capped epitaph ring, and the closed-ledger set. A death moves ONLY ledger balances + a read-out flag —
   * the swarm, the sharding, the canvas and the live-cap slots are NEVER touched (population dynamics own
   * liveness; the economy only buries the wallet). Persisted with the economy; absent payloads ⇒ no dynasty.
   */
  private kin = new Map<number, KinRecord>();
  private houses = new Map<number, HouseRecord>();
  /**
   * TERRITORY (economic layer only): zone → controlling houseId on the fixed grid. Runtime-authoritative and
   * PERSISTED (additive; an old payload has none ⇒ each house controls its own homeZone, re-derived on first
   * sight). A house controlling 0 zones is EXILED (conquered): it pays toll everywhere, enjoys no home
   * discount. Empty while the layer is off (never written), so the default deployment is byte-for-byte the same.
   */
  private zoneControl = new Map<number, number>();
  private graves: GraveRecord[] = [];
  private dead = new Set<number>();
  /**
   * ORGANIC CONFLICT (runtime-only, NEVER persisted): the candidate ids the most recent pickCounterparty
   * call refused outright because the buyer holds a grudge ≤ BOND_BLACKLIST against each. The step loop
   * reads it right after the call to feed the embargo mechanism (a refused seller resents the embargo).
   */
  private lastShunned: number[] = [];

  /**
   * PLAYBOOK (consequence-driven long-term memory, Phase 1 capability ①). Per-fly bounded episodic ring:
   * each entry records what happened in a given decision context, so future choices are reweighted by
   * past consequences. Persisted additively (an old payload has no `playbook` key ⇒ empty rings).
   * Economic layer ONLY — never touches the connectome (one-way law). Empty while the switch is off.
   */
  private playbook = new Map<number, PlaybookEntry[]>();
  /** Current tick's regime bucket (set at the top of step(); used by playbookRecord for context hashing). */
  private pbRegime = 1;
  /** Current tick's temperature bucket 0..3 (set at the top of step(); quantised for context hashing). */
  private pbTempBucket = 2;

  /**
   * STRATEGY (Phase 2b capability ②). Per-fly GP expression tree that modulates economic decisions.
   * Persisted additively (an old payload has no `strategyTrees` key ⇒ trees are generated deterministically
   * on first access). Economic layer ONLY — never touches the connectome (one-way law). Empty while OFF.
   */
  private strategyTrees = new Map<number, StrategyTree>();
  /** Current tick's temperature (r6 integer) for strategy ctx building. Set once per step(). */
  private stratTempR6 = 0;
  /** Current tick index for strategy seed derivation. */
  private stratTick = 0;

  /**
   * ㉝ RULES (Phase 5 capability ⑤). Per-fly band-clamped economic modifiers injected by state.ts from the rules
   *   membrane AFTER each cron's economy.step (so they take honest effect on the NEXT cron — the same one-cron lag
   *   every membrane keeps). A pure RUNTIME field: NEVER persisted, NEVER folded into stateDigest. Empty until the
   *   first drive ⇒ rulesTilt returns 1.0 ⇒ the decision points are byte-for-byte the pre-Rules build. Economic
   *   layer ONLY — never touches the connectome (one-way law), never a settlement, a cap or a purse.
   */
  private ruleMods = new Map<number, { buyMult: number; cpMult: number }>();
  /** The HARD constitutional band envelope. rulesTilt re-clamps EVERY injected modifier into [RULE_FLOOR,
   *  RULE_CEIL] INDEPENDENTLY of rules.ts, so even a wild value handed to applyRuleModifiers can never escape. */
  private static readonly RULE_FLOOR = 0.5;
  private static readonly RULE_CEIL = 2.0;

  /**
   * ELITES (Phase 2b capability ②). MAP-Elites novelty archive — a bounded 3-D behavioural grid (4×4×4 =
   * 64 cells) that preserves diverse strategies. Persisted additively; empty while OFF.
   */
  private elitesArchive = new ElitesArchive();
  /** Per-agent lifetime good-trade counts [signal, momentum, attestation, prediction] for entropy descriptor. */
  private goodCounts = new Map<number, [number, number, number, number]>();

  /**
   * SHADOW-COMPARE (task #87): twin fields for the evolution decision mirror. A pure RUNTIME field:
   * NEVER persisted, NEVER folded into stateDigest, NEVER in serialize(). Evidence lands in D1 ONLY.
   * shadowPlaybook: the shadow-only consequence ring fed by real flush outcomes (shadowRecordOutcomes).
   * shadowAgg: bounded per-cron aggregate counters exposed at /economy.shadowCompare (flag-guarded).
   */
  private shadowPlaybook = new Map<number, PlaybookEntry[]>();
  private shadowAgg: ShadowAggregate = {
    crons: 0, decisions: 0, baselineBuys: 0, evolvedBuys: 0,
    gateFlipsToBuy: 0, gateFlipsToHold: 0, goodSwitches: 0,
    sellerChanges: 0, amountDeltaSumAtomic: 0, amountDeltaMaxAtomic: 0,
    evolvedAmountSumAtomic: 0, baselineAmountSumAtomic: 0,
    cappedByMaxDeal: 0, cappedByDailyGlobal: 0, cappedByDailyAgent: 0,
    newEliteCells: 0, avgAmplifier: 0, exploreCount: 0, treeHashDistinct: 0,
  };

  /** ⑧ THE COMMONS: this era's legislated overrides of two institution knobs, applied fresh each cron by
   *  state.ts. null ⇒ base config (byte-for-byte the pre-law economy). Runtime-only, NEVER serialized —
   *  they are recomputed from the commons' own persisted decrees, so the economy payload stays untouched. */
  private lawCreditCapBaseUsdc: number | null = null;
  private lawIouRatePer10: number | null = null;

  constructor(cfg: EconomyConfig, restored?: string, deps?: EconomyDeps) {
    this.cfg = cfg;
    // Injected facilitator wins; otherwise derive from mode. makeFacilitator("onchain") without wiring
    // THROWS by design, so real money can never be half-enabled — onchain MUST be injected from state.ts.
    this.facilitator = deps?.facilitator ?? makeFacilitator(cfg.facilitatorMode);
    this.addressOf = deps?.addressOf ?? ((id) => AgentEconomy.addressOf(cfg.seedBase, id));
    this.pinner = deps?.pinner;
    this.escrowAddress = deps?.escrowAddress;
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
   * Read-only address derivation for an ARBITRARY agent id — genesis (id < populationSize) OR a hatched
   * offspring (id >= populationSize). Onchain this resolves through the injected HD path, so a new live id
   * naturally gets a genuine, distinct wallet address under the same mnemonic (the treasury never mints);
   * simulated mode returns the deterministic pseudo-address. driveEvolution uses this to compute where a
   * parent-funded bootstrap should land before the child is a live fly.
   */
  deriveAddress(id: number): string {
    return this.addressOf(id);
  }

  /**
   * Make sure an agent wallet exists for every fly in the reading set (idempotent). In SIMULATED mode a
   * new agent is credited initialBalance from the protocol treasury; existing agents keep their balance.
   * In ONCHAIN mode initialBalance is only the seed of the internal DISPLAY mirror — the real spendable
   * balance is whatever USDC the operator actually funded that HD address with, and the facilitator
   * re-reads it on-chain before every transfer (the mirror never authorises a real spend).
   *
   * A HATCHED offspring (id >= populationSize) opens its mirror at the REAL bootstrap its parent funded it
   * with (hatchSeedUsdc), NOT the genesis initialBalance — so a newborn shows as the poor fly it actually is
   * (correct wallet number AND correct wealth-ramp size/colour) instead of a fake-rich 6 USDC it can't spend.
   */
  private ensureAgents(readings: FlyReading[]): void {
    for (const r of readings) {
      if (this.indexOfId.has(r.id)) continue;
      const idx = this.agents.length;
      // Genesis ids open at initialBalance; hatched offspring (id >= populationSize) open at their real
      // parent-funded bootstrap so the display mirror matches the on-chain balance the facilitator enforces.
      const openingUsdc = r.id < this.cfg.populationSize ? this.cfg.initialBalanceUsdc : this.cfg.hatchSeedUsdc;
      this.agents.push({
        id: r.id,
        address: this.addressOf(r.id),
        balance: usdcToAtomic(openingUsdc),
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
  async step(readings: FlyReading[], collective: CollectiveState, tickIndex: number, budgetOverride?: number, cronBoundary = true): Promise<Settlement[]> {
    this.tickIndex = tickIndex;
    if (!this.cfg.enabled || readings.length < 2) { this.lastTick = []; return this.lastTick; }

    const onchain = this.facilitator.mode === "onchain";
    // KILL SWITCH: in onchain mode realSpendEnabled=false halts ALL settlement so no funds can move.
    // Inert in simulated mode — there is no real money to halt, so the piece keeps running as always.
    if (onchain && !this.cfg.realSpendEnabled) { this.lastTick = []; return this.lastTick; }
    if (onchain) this.rollSpendDay(Date.now());

    this.ensureAgents(readings);
    // ── R5 FIX A/B: ONCE per cron (onchain only), refresh the shared on-chain balance cache and, on the resync
    // cadence, re-align the display mirror to it. BOTH switches default OFF ⇒ this whole block is skipped, no RPC
    // is spent and no balance is touched, so the build is byte-for-byte today's. Fix A (planner gate) and Fix B
    // (mirror re-align) SHARE the one batched multicall below — never a per-agent RPC. The cache is valid for this
    // cron only, matching settle()'s authoritative balanceOf to within ≤1 cron.
    if (onchain && cronBoundary) {
      const gate = this.balanceGateOn();
      const resyncN = this.mirrorResyncEveryN();   // 0 ⇒ Fix B disabled
      if (gate || resyncN > 0) {
        this.econCronCount++;
        const resyncDue = resyncN > 0 && this.econCronCount % resyncN === 0;
        // RPC-frugal: the gate needs fresh balances EVERY cron; a B-only arm multicalls ONLY on a resync cron.
        if (gate || resyncDue) {
          await this.refreshOnchainBalances();
          if (resyncDue) this.mirrorResyncToChain();
        } else {
          this.onchainBalances = null;             // B-only, non-resync cron: no cache needed this cron
        }
      } else {
        this.onchainBalances = null;               // both OFF: no cache, gate inert (byte-for-byte today)
      }
    }
    const readingById = new Map<number, FlyReading>();
    for (const r of readings) readingById.set(r.id, r);
    const n = readings.length;
    const T = clamp01(collective.temperature);
    // PLAYBOOK context: quantise regime + temperature for deterministic context hashing (set once per
    // tick; playbookRecord reads them when writing entries). Inert while the switch is off.
    if (this.playbookOn()) {
      this.pbRegime = collective.regime === "HOT" ? 2 : collective.regime === "COLD" ? 0 : 1;
      this.pbTempBucket = Math.min(3, Math.floor(T * 4));
    }
    // STRATEGY context: cache the market temperature as r6 and the tick index for tree evaluation.
    // Inert while the switch is off (stratTempR6/stratTick are never read).
    if (this.strategyOn()) {
      this.stratTempR6 = Math.trunc(T * R6_SCALE);
      this.stratTick = tickIndex;
    }
    const made: Settlement[] = [];
    // ORGANIC CONFLICT: buyers that held because their whole span was shunned, with the specific sellers
    // they refused (fed to the embargo mechanism). Collected only while the switch is on; empty otherwise.
    const held: { buyer: number; shunned: number[] }[] = [];
    const budget = Math.max(0, budgetOverride ?? this.cfg.maxDealsPerTick);

    // Market-wide demand: a HOT chain means more agents want to buy, at higher prices.
    const demand = 0.3 + 0.7 * T;

    // INSTITUTIONS: before the first buyer crosses, rebuild THIS tick's limit books from the very
    // readings the loop is about to consume — depth, slope and spread become behavioural facts, and
    // the deal price is where the buyer eats, not what a formula decrees. Inert while the switch is
    // off: dealAmount then computes the original fixed formula byte-for-byte.
    if (this.institutionsOn()) {
      this.buildBooks(readings, T, tickIndex);
      // Professions ride the same switch: identities read off fap history that tilt economic intent only.
      this.stepProfessions(readings, tickIndex);
    }

    // TERRITORY: make sure every house has claimed its fixed home zone before the first deal is priced (a
    // pre-territory house is assigned its deterministic seed zone on first sight). Inert while the layer is off.
    if (this.territoryOn()) this.ensureTerritory();

    for (let i = 0; i < n && made.length < budget; i++) {
      const r = readings[i];
      // A buried fly's ledger is closed: it neither buys (here) nor sells (pickCounterparty) nor
      // absorbs prediction flows. Inert while the dynasty layer is off (dead stays empty).
      if (this.dead.has(r.id)) continue;
      const buyerIdx = this.indexOfId.get(r.id);
      if (buyerIdx == null) continue;

      // --- decode economic intent from the neural drives ---
      // PROF: a profession tilts the DESIRE to buy (economic side of the one-way street: behaviour made
      // the trade, the trade tilts intent, the neuron never notices). null ⇒ plain pre-institutions maths.
      const want = this.buyProbability(r, T, this.institutionsOn() ? this.profs.get(r.id)?.role ?? null : null);
      // Deterministic per-(tick,agent) draw so the flow is reproducible without persisted RNG state.
      const draw = hash01(tickIndex, r.id, 0x9e3779b9);
      if (draw > want * demand) continue;   // this agent holds this tick

      const good = this.playbookOn()
        ? this.playbookGoodOverride(r.id, goodForState(r.state), tickIndex)
        : goodForState(r.state);
      const sellerIdx = this.pickCounterparty(r, i, n, tickIndex);
      if (sellerIdx < 0) {
        if (this.lastShunned.length) held.push({ buyer: r.id, shunned: this.lastShunned.slice() });
        continue;
      }
      if (sellerIdx === buyerIdx) continue;

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
    // INSTITUTIONS: the credit cycle runs FIRST — repayments and recalls move existing money only, so
    // the treasury top-up still sees who genuinely fell below the floor after debts were settled.
    if (this.institutionsOn()) made.push(...this.creditCycle(tickIndex, readings));
    if (!onchain) this.solvencyTopUp();

    // ORGANIC CONFLICT: after the market clears, accrue deterministic negative cross-house bonds (rivalry /
    // envy / embargo / raid) so genuine feuds can surface on-chain. Inert (byte-for-byte) unless the switch is on.
    if (this.conflictOn()) this.applyConflict(tickIndex, T, made, held, cronBoundary);

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
    // ELITES: update the MAP-Elites archive with this tick's behaviour descriptors (additive, bounded).
    // Only runs when the switch is ON; OFF ⇒ archive stays empty, byte-for-byte Phase 1 behaviour.
    if (this.elitesOn() && cronBoundary) {
      this.updateElitesArchive(readings, tickIndex);
    }
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
    // TERRITORY re-prices the deal AFTER the neurons picked it (home discount / cross-zone toll); passthrough when off.
    const amount = this.applyTerritory(
      this.dealAmount(r, T, good, this.institutionsOn() ? this.profs.get(buyer.id)?.role ?? null : null),
      buyer.id, seller.id,
    );
    // ── R5 FIX A: on-chain solvency gate. When armed, refuse to fold a pair whose DEBTOR (the buyer) cannot cover
    // this deal with its REAL on-chain balance — that pair would otherwise 100% settle-fail at flush and climb
    // netPending forever (the R5 root cause). Inert when ECONOMY_ONCHAIN_BALANCE_GATE is off OR the per-cron cache
    // is cold: onchainSolvent() then fails OPEN and the trade is queued exactly as today (byte-for-byte). The
    // returned record is a declined placeholder (valid=false, reason "onchain-insolvent") so the tape still shows
    // the attempt without queueing un-settleable value. Touches no balance, no cap, no net.
    if (this.balanceGateOn() && !this.onchainSolvent(buyer.id, amount)) {
      return {
        tick, ts: Date.now(), good, resource: `${good}:${seller.id}`,
        fromId: buyer.id, toId: seller.id, from: buyer.address, to: seller.address,
        amount, txHash: "0x", valid: false, reason: "onchain-insolvent", simulated: false,
      };
    }
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

    // SELF-HEAL the proof chain before building any receipt: adopt the registry's true on-chain head if our
    // off-chain head drifted from it (a past commit failed). Receipts embed prevChain and are hashed from it,
    // so this MUST run first — otherwise every commit's prevHead misses the contract's chainHead and reverts
    // (BadPrevHead), which is exactly how the chain wedged permanently. Skipped when there's nothing to flush
    // (no RPC spent); commitRoundReceipt re-anchors independently for a round-only cron.
    if (this.pendingNets.size > 0) await this.resyncChainHeadFromRegistry();

    // #98 Fix 2: per-cron flush budget — cap the number of EXPENSIVE broadcast attempts so the cron
    // wall-clock stays bounded even with a large pendingNets backlog. Cheap skips (zero-net, dust, backoff)
    // do NOT consume budget. Remaining pairs carry forward deterministically (Map insertion order is stable).
    const flushBudget = this.cfg.netFlushBudgetPerCron ?? 0;
    let flushed = 0;
    // Task #135 Fix 2c': a WALL-CLOCK ceiling alongside the count budget. Each broadcast chunk costs a verify
    // read + a settle tx + a registry commit + an IPFS pin ≈ 2-10s, so the 40-chunk count budget ALONE could
    // out-run the cron's 90s abort even with perfectly healthy RPCs — and an aborted cron blocks the DO's
    // single-threaded input queue for the full 90s, which is exactly what took every DO-backed endpoint (and
    // therefore the frontend) offline. 45s leaves the rest of the beat (market sample, the Fix A multicall, the
    // neural step, shard fan-out, D1 archive) its headroom under the 90s scheduled() signal.
    //
    // SAFE — this DEFERS debt, it never forgives it: the H7 carry-forward below only decrements `remaining` on a
    // SUCCESSFUL chunk, and any pair still holding `remaining > 0n` is KEPT in pendingNets (deleted only when it
    // reaches exactly zero). A wall-clock break therefore leaves the pair queued for the next cron, byte-for-byte
    // as the count-budget break already does. A time bound is also strictly better than tightening the count:
    // when RPCs are fast the full 40 chunks still run, so backlog drain rate is unchanged on healthy beats.
    const flushDeadline = Date.now() + 45_000;

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

      // EXPONENTIAL BACKOFF: a pair that failed settlement recently gets a retry window that doubles per
      // consecutive failure (capped at 30 ticks ≈ 5 crons). This prevents hot-looping a pair whose failure
      // is persistent (insufficient balance, nonce race) from consuming every cron's flush budget. In-memory
      // only (pairBackoff): a DO eviction naturally resets it, which is correct after the transient cause heals.
      const bo = this.pairBackoff.get(key);
      if (bo) {
        const wait = Math.min(1 << bo.streak, 30);
        if (tickIndex - bo.lastFailTick < wait) continue;
      }

      // #98 Fix 2 + M5 fix: budget gate at PAIR level (at least one pair is always attempted).
      // The CHUNK-level gate is inside the while loop below so the budget counts real broadcasts, not pairs.
      // Task #135 Fix 2c': the same gate on wall-clock (see flushDeadline above — carry-forward is safe).
      if ((flushBudget > 0 && flushed >= flushBudget) || Date.now() > flushDeadline) break;

      const debtorId = pn.net > 0n ? pn.lo : pn.hi;
      const creditorId = pn.net > 0n ? pn.hi : pn.lo;
      const debtor = this.agents[this.indexOfId.get(debtorId)!];
      const creditor = this.agents[this.indexOfId.get(creditorId)!];
      const good = pn.good;
      let remaining = abs;
      let primaryHash = "0x";
      let chunk = 0;
      while (remaining > 0n) {
        // M5 fix: budget counted at CHUNK granularity (each chunk = one real broadcast attempt).
        // Task #135 Fix 2c': + wall-clock ceiling, so one slow broadcast chain can't out-run the cron.
        if ((flushBudget > 0 && flushed >= flushBudget) || Date.now() > flushDeadline) break;
        flushed++;
        const value = maxDeal > 0n && remaining > maxDeal ? maxDeal : remaining;
        const amountStr = String(value);
        const base = {
          tick: tickIndex, ts: Date.now(), good, resource: `net:${good}:${creditor.id}`,
          fromId: debtor.id, toId: creditor.id, from: debtor.address, to: creditor.address,
          amount: amountStr, simulated: false,
        } as const;
        const capReason = this.spendCapReason(debtor.id, amountStr);
        if (capReason) { out.push({ ...base, txHash: "0x", valid: false, reason: capReason }); break; }
        // H6: per-agent settle failure tracking for the MAP-Elites settle-rate descriptor.
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
        if (!verified.valid) {
          // A net that fails verification on-chain dents the debtor's reputation (light: rails can fail
          // for non-moral reasons, so this is a smudge, not a grudge — the book stays for true stiffs).
          this.settleFail++;
          debtor.settleFail = (debtor.settleFail ?? 0) + 1;
          this.rememberFailedPayment(debtor.id, creditor.id, tickIndex);
          // PLAYBOOK: a failed on-chain payment is a negative consequence for the debtor.
          this.playbookRecord(debtor.id, 0, good, 0, 0, tickIndex);
          const prev = this.pairBackoff.get(key);
          this.pairBackoff.set(key, { streak: (prev?.streak ?? 0) + 1, lastFailTick: tickIndex });
          // §10.9: track consecutive verify-fails per pair.  After enough, the net is EXPIRED — removed
          // from pendingNets so it never consumes flush budget again.  The debt is forgiven (the debtor
          // has a real dust balance that can never pay; keeping the net only hurts the success rate and
          // the debtor's reputation score without any chance of recovery).
          const vfStreak = (this.verifyFailStreak.get(key) ?? 0) + 1;
          this.verifyFailStreak.set(key, vfStreak);
          if (vfStreak >= VERIFY_FAIL_EXPIRE_THRESHOLD) {
            this.pendingNets.delete(key);
            this.verifyFailStreak.delete(key);
            this.pairBackoff.delete(key);
            out.push({ ...base, txHash: "0x", valid: false, reason: `verify-failed-expired (${vfStreak} consecutive)` }); break;
          }
          out.push({ ...base, txHash: "0x", valid: false, reason: verified.invalidReason ?? "verify-failed" }); break;
        }
        const settleT0 = Date.now();
        const receipt = await this.facilitator.settle(payload, reqs);
        if (receipt.shadow) { out.push({ ...base, txHash: "0x", valid: false, reason: "shadow-dry-run" }); break; }
        if (!receipt.success) {
          this.settleFail++;
          debtor.settleFail = (debtor.settleFail ?? 0) + 1;
          this.rememberFailedPayment(debtor.id, creditor.id, tickIndex);
          // PLAYBOOK: a failed settle is a negative consequence for the debtor.
          this.playbookRecord(debtor.id, 0, good, 0, 0, tickIndex);
          const prev = this.pairBackoff.get(key);
          this.pairBackoff.set(key, { streak: (prev?.streak ?? 0) + 1, lastFailTick: tickIndex });
          out.push({ ...base, txHash: receipt.txHash || "0x", valid: false, reason: receipt.invalidReason ?? "settle-failed" }); break;
        }
        // Mined: commit this chunk on the internal ledger, meter the daily caps, count real volume.
        remaining -= value;   // H7: decrement ONLY on success — a failed break preserves remaining for carry-forward.
        // §10.9: a successful settle clears the consecutive verify-fail counter for this pair.
        this.verifyFailStreak.delete(key);
        debtor.balance = subAtomic(debtor.balance, amountStr);
        debtor.paid = addAtomic(debtor.paid, amountStr);
        debtor.deals++;
        debtor.lastTick = tickIndex;
        creditor.balance = addAtomic(creditor.balance, amountStr);
        creditor.earned = addAtomic(creditor.earned, amountStr);
        creditor.sales++;
        creditor.lastTick = tickIndex;
        // ELITES: track per-agent good-trade counts for the entropy behaviour descriptor (additive, cheap).
        if (this.elitesOn()) {
          const gi = GOOD_IDX[good];
          for (const aid of [debtor.id, creditor.id]) {
            let gc = this.goodCounts.get(aid);
            if (!gc) { gc = [0, 0, 0, 0]; this.goodCounts.set(aid, gc); }
            gc[gi]++;
          }
        }
        this.recordSpend(debtor.id, amountStr);
        this.volumeAtomic = addAtomic(this.volumeAtomic, amountStr);
        this.count++;
        this.settleOk++;
        // LATENCY (observe-only, additive): submit→finality ms for this mined settle, timed at the facade
        // boundary so it covers whichever rail is live. Pure telemetry — the transfer above already mined;
        // this only measures how long it took and never touches balances, nonces, or the broadcast.
        const settleMs = Date.now() - settleT0;
        this.settleMsSum += settleMs;
        this.settleMsN++;
        if (settleMs > this.settleMsMax) this.settleMsMax = settleMs;
        this.settleMsLast = settleMs;
        this.pairBackoff.delete(key);  // success clears the backoff streak
        // The mined net IS the settled history reputation is made of: both sides keep the promise.
        this.rememberTrade(debtor.id, creditor.id, tickIndex);
        // PLAYBOOK: record the consequence for both sides (buyer paid, seller earned; valid settlement).
        this.playbookRecord(debtor.id, 0, good, -Number(amountStr), 1, tickIndex);
        this.playbookRecord(creditor.id, 1, good, Number(amountStr), 1, tickIndex);
        // Dynasty tithe: 2% of what the creditor just earned flows to its house treasury (no-op for a
        // commoner or with the layer off; never pushes a member below zero — it skips if it would).
        this.titheHouse(creditor.id, amountStr);
        if (primaryHash === "0x") primaryHash = receipt.txHash;
        // Mirror this receipt onto our own NeuralReceiptRegistry so the hash-chain head lives ON-CHAIN,
        // not just in DO storage. BEST-EFFORT: prevHead is the chain head BEFORE this receipt (exactly
        // what the contract enforces continuity against). A failure only means "not registered yet" —
        // the authoritative commitment (the EIP-3009 nonce == receiptHash) already mined above.
        const commitTx = await this.commitToRegistry(
          receiptHash, netReceipt.prevChain, tickIndex, netReceipt.constituents.length, receipt.txHash,
        );
        // Best-effort: pin the receipt BODY to IPFS so anyone can fetch it trustlessly and recompute the
        // on-chain hash with no murmur server. A failure only means "not pinned" — the receipt stays nonce-
        // and registry-verifiable. This never touches the signature/nonce path above.
        const ipfsCid = await this.pinReceipt(netReceipt, receiptHash);
        // Publish + chain the proof now that the nonce-committing transfer is mined.
        this.proofs.unshift({
          txHash: receipt.txHash, receiptHash, receipt: netReceipt, ts: Date.now(),
          ...(commitTx ? { commitTx } : {}),
          ...(ipfsCid ? { ipfsCid } : {}),
        });
        if (this.proofs.length > PROOFS_CAP) this.proofs.length = PROOFS_CAP;
        // Advance the off-chain head UNCONDITIONALLY: proofChainHead is the authoritative receipt-chain head
        // (every receipt embeds it as prevChain and the EIP-3009 nonce commits to that hash), so it must move
        // on each mined transfer whether or not the registry MIRROR commit landed. Registry continuity is kept
        // by resyncChainHeadFromRegistry() re-anchoring to the true on-chain head at the next flush, so a
        // failed commit costs at most that one registry link (the receipt stays nonce-verifiable) and can never
        // wedge the chain — which is what advancing-then-never-resyncing used to do.
        this.proofChainHead = receiptHash;
        out.push({ ...base, txHash: receipt.txHash, valid: true, proofHash: receiptHash });
        chunk++;
      }
      // H7 fix: only delete the pair when fully broadcast; otherwise carry the remaining net forward
      // (preserving sign direction + firstTick for the backoff/age mechanism). This prevents silent
      // debt-forgiveness when a spendCapReason/verify/settle failure breaks the chunk loop early.
      if (remaining === 0n) {
        this.pendingNets.delete(key);
      } else {
        pn.net = (pn.net > 0n ? 1n : -1n) * remaining;
        pn.trades = Math.max(1, pn.trades);
      }
      this.flushSeq++;
    }

    for (const s of out) {
      if (CONSTITUENT.has(s.reason ?? "")) continue;   // keep the ledger to real nets + declines
      this.recent.unshift(s);
    }
    if (this.recent.length > RECENT_CAP) this.recent.length = RECENT_CAP;
    return out;
  }

  // ---------- #143 ESTATE RELIEF (ONCHAIN, dark) — orphaned dead-wallet USDC → escrow → the poorest living ----------
  //
  // A dead house's treasury and the #123 commons pool are SCOREBOARD numbers; the REAL USDC of a buried fly
  // physically stays in its HD wallet, which neither settlement nor Fix B ever touches (both skip the dead).
  // These two executors are the honest unlock: they move REAL on-chain USDC — first sweeping an orphaned purse
  // into a reserved escrow, then dripping escrow to the poorest LIVING wallets. Both run in the cron's SERIALIZED
  // money lane (immediately after flush), share the facilitator wallet, and commit NO neural receipt (a treasury
  // move, not a settlement), so they never collide with the settlement nonce / proof-chain. Every leg is bounded
  // by the per-deal cap and moves money only on a MINED receipt. The whole layer is inert unless estateReliefOn().

  /** #143: drop an id from the pending-estate queue (swept, reclaimed, or un-sweepable). */
  private dropEstate(id: number): void {
    const i = this.pendingEstates.indexOf(id);
    if (i >= 0) this.pendingEstates.splice(i, 1);
  }

  /** #143: roll the relief daily-budget counter when the UTC day changes (mirrors rollSpendDay's day key). */
  private rollReliefDay(nowMs: number): void {
    const key = AgentEconomy.dayKey(nowMs);
    if (key !== this.reliefToday.day) this.reliefToday = { day: key, atomic: "0" };
  }

  /** #143: the `n` poorest LIVING wallets by mirror balance (ascending, id-tie-broken; dead excluded). */
  private poorestLiving(n: number): AgentState[] {
    const living: AgentState[] = [];
    for (const a of this.agents) {
      if (this.dead.has(a.id)) continue;
      living.push(a);
    }
    living.sort((x, y) => {
      const d = BigInt(x.balance) - BigInt(y.balance);
      return d < 0n ? -1 : d > 0n ? 1 : x.id - y.id;
    });
    return living.slice(0, Math.max(0, n));
  }

  /**
   * #143 estate→escrow executor (cron, serialized after flush). For up to `maxSweepsPerCron` queued orphaned
   * wallets: re-check the tombstone (id-reuse misfire guard — a reclaimed slot is dropped, never swept), read the
   * wallet's LIVE on-chain balance (fail-open: an RPC error just defers to next cron), and sweep one per-deal-
   * capped chunk into escrow via a treasuryTransfer leg signed by the dead wallet's own HD key. Mined ⇒ escrow
   * scoreboard rises, the id dequeues. shadow/dust/no-balance ⇒ no money moves. Returns lifetime sweep counters.
   */
  async sweepEstatesToEscrow(tickIndex: number): Promise<{ swept: number; sweptAtomic: string }> {
    const res = { swept: 0, sweptAtomic: "0" };
    if (!this.estateReliefOn()) return res;                 // OFF / simulator / unwired escrow ⇒ byte-for-byte no-op
    if (!this.cfg.realSpendEnabled) return res;             // kill switch: never broadcast
    if (this.pendingEstates.length === 0) return res;
    const transfer = this.facilitator.treasuryTransfer;
    const readBalances = this.facilitator.readBalances;
    if (typeof transfer !== "function" || typeof readBalances !== "function") return res;
    this.rollSpendDay(Date.now());

    const maxDeal = BigInt(usdcToAtomic(this.cfg.maxDealUsdc));
    const cap = Math.max(1, Math.floor(this.cfg.estateRelief?.maxSweepsPerCron ?? 4));
    const queue = this.pendingEstates.slice(0, cap);
    const escrow = this.escrowAddress as string;
    const addrs = queue.map((id) => this.addressOf(id)).filter((x) => !!x);
    let bals: Map<string, bigint>;
    try { bals = await readBalances.call(this.facilitator, addrs); }
    catch { return res; }                                    // RPC error ⇒ fail-open, retry next cron
    const deadline = Date.now() + 15_000;                    // well inside the cron abort budget; defer the rest
    for (const id of queue) {
      // ID-REUSE MISFIRE GUARD: the tombstone must still be present, else the purse belongs to a reborn fly.
      if (!this.dead.has(id)) { this.dropEstate(id); continue; }
      if (Date.now() > deadline) break;                      // leave the remaining ids queued for the next cron
      const addr = this.addressOf(id);
      const bal = bals.get(addr.toLowerCase()) ?? 0n;
      if (bal <= 0n) { this.dropEstate(id); continue; }      // truly empty ⇒ nothing sleeping, dequeue
      const value = maxDeal > 0n && bal > maxDeal ? maxDeal : bal;
      const amountStr = value.toString();
      let receipt;
      try {
        receipt = await transfer.call(this.facilitator, {
          payerAddress: addr, payeeAddress: escrow, valueAtomic: amountStr, network: this.cfg.network,
        });
      } catch { this.dropEstate(id); continue; }
      if (receipt.shadow) {
        // Shadow proved the leg end-to-end but moved nothing — keep it queued for the real run, stop the lane.
        console.log(`[DO] estate-relief shadow: sweep #${id} ${amountStr} atomic → escrow (dry-run)`);
        break;
      }
      if (!receipt.success) {
        // A durable failure (no signer / under-cap race / revert): dequeue so the queue cannot wedge. The on-chain
        // read is authoritative, so a transient 0-balance simply re-enqueues on that fly's next burial.
        console.warn(`[DO] estate-relief sweep #${id} failed: ${receipt.invalidReason ?? "unknown"} (dequeued)`);
        this.dropEstate(id);
        continue;
      }
      // Mined: the orphaned USDC now lives in escrow. Rise the scoreboard, retire the queue entry, count it.
      this.dropEstate(id);
      this.escrowPoolAtomic = addAtomic(this.escrowPoolAtomic, amountStr);
      this.estateSweptAtomic = addAtomic(this.estateSweptAtomic, amountStr);
      this.estateSweptCount++;
      res.swept++;
      res.sweptAtomic = addAtomic(res.sweptAtomic, amountStr);
      console.log(`[DO] estate-relief: swept #${id} ${amountStr} atomic → escrow tx=${receipt.txHash.slice(0, 10)}`);
    }
    void tickIndex;
    return res;
  }

  /**
   * #143 escrow→poor relief executor (cron, serialized after the estate sweep). Gated by a cadence modulo
   * (reliefEveryNCrons) and a daily budget BELOW the spend caps. Reads the escrow purse's LIVE on-chain balance,
   * then drips per-deal-capped chunks to the poorest living wallets via treasuryTransfer legs signed by the
   * escrow key. Mined ⇒ the recipient's mirror rises by exactly the real inflow (mirror ≤ chain still holds —
   * Fix B re-aligns to the higher on-chain value, never an invented one), the escrow scoreboard falls (the FIRST
   * true outflow of the commons). Returns lifetime disbursement counters.
   */
  async disburseRelief(): Promise<{ disbursed: number; disbursedAtomic: string }> {
    const res = { disbursed: 0, disbursedAtomic: "0" };
    if (!this.estateReliefOn()) return res;
    if (!this.cfg.realSpendEnabled) return res;
    const er = this.cfg.estateRelief;
    if (!er || er.reliefEveryNCrons <= 0) return res;
    const transfer = this.facilitator.treasuryTransfer;
    const readBalances = this.facilitator.readBalances;
    if (typeof transfer !== "function" || typeof readBalances !== "function") return res;
    // Cadence: one relief pass every reliefEveryNCrons onchain crons (self-counted, runtime-only).
    this.reliefCronCount++;
    if (this.reliefCronCount % er.reliefEveryNCrons !== 0) return res;
    this.rollReliefDay(Date.now());
    const budget = BigInt(usdcToAtomic(er.reliefDailyBudgetUsdc));
    if (budget > 0n && BigInt(this.reliefToday.atomic) >= budget) return res;   // today's relief budget spent

    const escrow = this.escrowAddress as string;
    let escrowBal = 0n;
    try {
      const m = await readBalances.call(this.facilitator, [escrow]);
      escrowBal = m.get(escrow.toLowerCase()) ?? 0n;
    } catch { return res; }                                    // RPC error ⇒ fail-open, retry next relief cron
    if (escrowBal <= 0n) return res;                           // nothing gathered yet ⇒ nothing to give

    const maxDeal = BigInt(usdcToAtomic(this.cfg.maxDealUsdc));
    const chunk = BigInt(usdcToAtomic(er.reliefChunkUsdc));
    const poor = this.poorestLiving(RELIEE_LIMIT_PER_CRON);
    const deadline = Date.now() + 15_000;
    for (const agent of poor) {
      if (Date.now() > deadline) break;
      if (agent.address.toLowerCase() === escrow.toLowerCase()) continue;
      let value = chunk > 0n && escrowBal > chunk ? chunk : escrowBal;
      if (maxDeal > 0n && value > maxDeal) value = maxDeal;
      if (budget > 0n) {
        const room = budget - BigInt(this.reliefToday.atomic);
        if (room <= 0n) break;
        if (value > room) value = room;
      }
      if (value <= 0n) break;
      const amountStr = value.toString();
      let receipt;
      try {
        receipt = await transfer.call(this.facilitator, {
          payerAddress: escrow, payeeAddress: agent.address, valueAtomic: amountStr, network: this.cfg.network,
        });
      } catch { continue; }
      if (receipt.shadow) {
        console.log(`[DO] estate-relief shadow: escrow → #${agent.id} ${amountStr} atomic (dry-run)`);
        break;
      }
      if (!receipt.success) {
        console.warn(`[DO] estate-relief disburse → #${agent.id} failed: ${receipt.invalidReason ?? "unknown"}`);
        continue;
      }
      // Mined: a real USDC inflow lands in the poorest wallet. Mirror rises by exactly that; escrow falls.
      agent.balance = addAtomic(agent.balance, amountStr);
      this.reliefToday.atomic = addAtomic(this.reliefToday.atomic, amountStr);
      // The escrow SCOREBOARD falls by the disbursed amount, clamped at zero (the live on-chain escrow read is
      // the real authority; this board is an observability mirror and can never render a negative balance).
      this.escrowPoolAtomic = (BigInt(this.escrowPoolAtomic) - BigInt(amountStr) > 0n)
        ? subAtomic(this.escrowPoolAtomic, amountStr) : "0";
      this.reliefPaidAtomic = addAtomic(this.reliefPaidAtomic, amountStr);
      this.reliefPaidCount++;
      res.disbursed++;
      res.disbursedAtomic = addAtomic(res.disbursedAtomic, amountStr);
      escrowBal -= value;
      console.log(`[DO] estate-relief: escrow → poorest #${agent.id} ${amountStr} atomic tx=${receipt.txHash.slice(0, 10)}`);
      if (escrowBal <= 0n) break;
    }
    return res;
  }

  /**
   * Fold this cron's estate-relief activity into the read-out. Returns null while the layer is OFF so the caller
   * (and snapshot()) omit the block entirely — byte-for-byte today's payload when dark.
   */
  estateReliefReadout(): {
    escrowPoolAtomic: string; pendingEstates: number;
    sweptCount: number; sweptAtomic: string; paidCount: number; paidAtomic: string; reliefTodayAtomic: string;
  } | null {
    if (!this.cfg.estateRelief || this.cfg.estateRelief.enabled !== true) return null;
    return {
      escrowPoolAtomic: this.escrowPoolAtomic,
      pendingEstates: this.pendingEstates.length,
      sweptCount: this.estateSweptCount,
      sweptAtomic: this.estateSweptAtomic,
      paidCount: this.reliefPaidCount,
      paidAtomic: this.reliefPaidAtomic,
      reliefTodayAtomic: this.reliefToday.atomic,
    };
  }

  /**
   * Fold a resolved prediction round's bilateral net flows into the economy so they settle through the
   * EXACT same rails as neural trades — there is NO separate money path for predictions. ONCHAIN: each
   * flow accumulates into its pair's pending NET (good="prediction"), so flush() later broadcasts it
   * subject to the kill switch, the daily/per-agent caps, the per-deal cap and the min-broadcast netting
   * — balances move only on a mined receipt, exactly like a trade. SIMULATED: the internal ledger is the
   * authority, so the mirror balances move now. Returns the settlement records (net-pending placeholders
   * onchain, real records simulated) so the caller can publish them alongside the cron's other activity.
   */
  async absorbFlows(flows: PredictFlow[], tickIndex: number): Promise<Settlement[]> {
    const out: Settlement[] = [];
    if (!this.cfg.enabled || flows.length === 0) return out;
    const onchain = this.facilitator.mode === "onchain";
    // Kill switch: with real spend halted, fold nothing (mirrors step()). Inert in simulated mode.
    if (onchain && !this.cfg.realSpendEnabled) return out;
    this.tickIndex = tickIndex;

    for (const f of flows) {
      const amount = f.amount;
      if (!/^\d+$/.test(amount) || BigInt(amount) <= 0n) continue;
      const fromIdx = this.indexOfId.get(f.fromId);
      const toIdx = this.indexOfId.get(f.toId);
      // Both sides must already have wallets (they bet this round, so ensureAgents has seen them); skip
      // anything unknown rather than mint an agent here.
      if (fromIdx == null || toIdx == null || fromIdx === toIdx) continue;
      // A closed ledger absorbs nothing: skip flows touching the dead (inert while the dynasty is off).
      if (this.dead.has(f.fromId) || this.dead.has(f.toId)) continue;
      const debtor = this.agents[fromIdx];
      const creditor = this.agents[toIdx];
      const resource = `predict:${f.round}:${creditor.id}`;

      if (onchain) {
        const lo = Math.min(debtor.id, creditor.id);
        const hi = Math.max(debtor.id, creditor.id);
        const key = `${lo}>${hi}`;
        // debtor pays creditor: signed net is positive when the debtor is the lower id (mirrors queueNet).
        const signed = BigInt(amount) * (debtor.id === lo ? 1n : -1n);
        let pn = this.pendingNets.get(key);
        if (!pn) {
          pn = { lo, hi, net: 0n, trades: 0, good: "prediction", firstTick: tickIndex, constituents: [], proofs: [] };
          this.pendingNets.set(key, pn);
        }
        pn.net += signed;
        pn.trades++;
        pn.good = "prediction";
        if (pn.proofs.length < 64) {
          pn.proofs.push({
            tick: tickIndex, fromId: debtor.id, toId: creditor.id, good: "prediction", amount,
            buyer: f.from, seller: f.to,
            decisionHash: await sha256Hex({
              v: PROOF_VERSION, policy: POLICY_VERSION, kind: "decision",
              tick: tickIndex, good: "prediction", amount, buyer: f.from, seller: f.to,
            }),
          });
        }
        const rec: Settlement = {
          tick: tickIndex, ts: Date.now(), good: "prediction", resource,
          fromId: debtor.id, toId: creditor.id, from: debtor.address, to: creditor.address,
          amount, txHash: "0x", valid: false, reason: "net-pending", simulated: false,
        };
        if (pn.constituents.length < 64) pn.constituents.push(rec);
        out.push(rec);
      } else {
        // SIMULATED: move the mirror now (the ledger is the authority; no caps to meter).
        debtor.balance = subAtomic(debtor.balance, amount);
        debtor.paid = addAtomic(debtor.paid, amount);
        debtor.lastTick = tickIndex;
        creditor.balance = addAtomic(creditor.balance, amount);
        creditor.earned = addAtomic(creditor.earned, amount);
        creditor.lastTick = tickIndex;
        const rec: Settlement = {
          tick: tickIndex, ts: Date.now(), good: "prediction", resource,
          fromId: debtor.id, toId: creditor.id, from: debtor.address, to: creditor.address,
          amount, txHash: pseudoTxHash(debtor.address, creditor.address, amount, resource),
          valid: true, simulated: true,
        };
        this.recent.unshift(rec);
        this.volumeAtomic = addAtomic(this.volumeAtomic, amount);
        this.count++;
        out.push(rec);
      }
    }
    if (this.recent.length > RECENT_CAP) this.recent.length = RECENT_CAP;
    return out;
  }

  /**
   * buy probability 0..1 from state + arousal + wingbeat + rest.
   * PROF: when a sticky profession is supplied (INSTITUTIONS ON), it tilts the result — a forager
   * chases signal, a brooder hoards its rest. null ⇒ the original formula, byte-for-byte (OFF path).
   * STRATEGY: when armed, the GP tree's bounded tilt [0.5..1.5] modulates the base BEFORE the final
   * clamp01 — so the output is STILL hard-capped to [0,1] (demand≤1 invariant preserved).
   */
  private buyProbability(r: FlyReading, T: number, role: Profession | null = null): number {
    const stateBase =
      r.state === "AGITATE" ? 0.9 :
      r.state === "EXPLORE" ? 0.7 :
      r.state === "AGGREGATE" ? 0.5 : 0.12;   // REST barely participates
    const arousal = 0.5 + 0.5 * clamp01(r.arousal);
    const wing = 0.85 + 0.3 * clamp01(r.wingbeat);
    const rest = 1 - 0.6 * clamp01(r.rest);
    let base = stateBase * arousal * wing * rest * (0.6 + 0.4 * T);
    if (role) base *= PROF_BUY[role];
    // STRATEGY tilt: multiplicative [0.5..1.5], composed AFTER profession but BEFORE the hard clamp.
    base *= this.strategyTilt(r, this.stratTick);
    // ㉝ RULES tilt: a band-clamped [0.5..2.0] multiplier composed BEFORE the hard clamp01 — so the output is STILL
    //    hard-capped to [0,1] (the demand≤1 invariant holds no matter how the amp×strategyTilt×rulesTilt chain
    //    compounds). It tilts WHETHER the fly wants to buy; it never touches the deal amount or a settlement.
    base *= this.rulesTilt(r, "buy");
    return clamp01(base);
  }

  /**
   * Choose the seller index from cohesion (near/far) + turnBias (left/right half). Maps the fly's
   * spatial social drive onto an economic counterparty: a cohesive fly trades with a close neighbour,
   * an explorer reaches across the swarm. SOCIAL MEMORY then acts ONLY INSIDE the pool the neurons
   * offered: candidates are re-weighted by remembered bond + reputation, and a fly with a deep grudge
   * (bond ≤ BOND_BLACKLIST) is refused outright — "never trade with #3". If every candidate in the span
   * is refused, the buyer simply holds this tick (a retaliatory supply cut). Neurons still decide IF to
   * buy, WHAT to buy, how FAR to reach and WHICH side — the connectome is never touched (one-way law).
   */
  private pickCounterparty(r: FlyReading, buyerI: number, n: number, tick: number): number {
    this.lastShunned = [];
    const others = n - 1;
    if (others <= 0) return -1;
    const coh = clamp01(r.cohesion);
    // Low cohesion (explorer) → large reach; high cohesion → small, neighbourly offset.
    const span = Math.max(1, Math.round(1 + (1 - coh) * (others - 1)));
    const dir = r.turnBias >= 0 ? 1 : -1;
    // Deterministic sample of the neural span (salt-chained per candidate slot) → de-duplicated pool.
    const pool: number[] = [];
    const seen = new Set<number>([buyerI]);
    for (let j = 0; j < Math.min(PICK_CANDIDATES, span); j++) {
      const off = 1 + Math.floor(hash01(tick, r.id, (0x85ebca6b ^ Math.imul(j + 1, 0x9e3779b1)) >>> 0) * span);
      let idx = (buyerI + dir * off) % n;
      if (idx < 0) idx += n;
      if (seen.has(idx)) continue;
      seen.add(idx);
      pool.push(idx);
    }
    if (pool.length === 0) return -1;
    // Weight each candidate by the buyer's directed bond + the candidate's market reputation.
    // With NO social memory at all every weight is 1 ⇒ the roulette degenerates to a uniform
    // pick inside the span, so a fresh swarm behaves neutrally until a past accumulates.
    // PLAYBOOK: when armed, modulates the social-weight amplitude by consequence confidence and
    // fires an ε-greedy exploration override with bounded probability (deterministic hash01).
    // STRATEGY: when armed, the GP tree's bounded tilt [0.5..1.5] scales the social contribution
    // COMPOUNDED with the playbook amplifier. Total weight stays ≥ 0.05 (existing floor) and the
    // roulette is unchanged — no cap is bypassed, no new risk surface.
    const pbMod = this.playbookOn() ? this.playbookCounterpartyMod(r.id, tick) : null;
    const stratTilt = this.strategyTilt(r, tick);  // 1.0 when OFF (inert)
    const cpRuleMod = this.rulesTilt(r, "cp");     // ㉝ band-clamped [0.5..2.0], 1.0 when OFF/absent (inert)
    // #123 EQUITY TILT: per-candidate wealth-rank tilt. null when OFF ⇒ eqTilt ≡ 1.0 in the loop below.
    const eqRanks = this.balanceRanksForTick(tick);
    const picks: number[] = [];
    const weights: number[] = [];
    const shunned: number[] = [];
    let total = 0;
    for (const idx of pool) {
      const cand = this.agents[idx];
      if (!cand || this.dead.has(cand.id)) continue;   // you cannot buy from a grave
      const bond = this.effectiveBond(r.id, cand.id, tick);
      if (bond <= BOND_BLACKLIST) { shunned.push(cand.id); continue; }   // the grudge vetoes; the neurons never notice
      const rep = this.effectiveRep(cand.id, tick);
      // PLAYBOOK amplifier scales the social contribution [0.5..1.0]; ε-greedy zeroes it (uniform).
      const amp = pbMod ? (pbMod.explore ? 0 : pbMod.amplifier) : 1;
      // L3 fix: STRATEGY tilt compounds with playbook: amp∈[0,1], stratTilt∈[0.5,1.5] ⇒ product ∈ [0, 1.5].
      // ㉝ RULES tilt compounds too, bounded [0.5..2.0]. Combined range: [0.25, 1.5]×[0.5,2.0] ⇒ [0.125, 3.0].
      // #123 EQUITY TILT compounds as well, bounded [0.5..2.0]. Combined: [0.0625, 6.0] theoretical max.
      //    The Math.max(0.05,…) floor is what guarantees total > 0 (⇒ no division by zero) and the band keeps
      //    every modifier finite (⇒ no NaN), so the deterministic roulette is unchanged and no cap is bypassed.
      const eqTilt = eqRanks ? this.equityTiltMult(eqRanks[idx], tick, cand.id) : 1.0;
      const w = Math.max(0.05, 1 + amp * stratTilt * cpRuleMod * eqTilt * (0.6 * bond + 0.4 * rep));
      picks.push(idx);
      weights.push(w);
      total += w;
    }
    if (picks.length === 0) { this.lastShunned = shunned; return -1; }   // every candidate in the span is shunned: hold back this tick
    // Deterministic weighted roulette (same persisted past + same tick ⇒ same choice, DO-safe replay).
    let spin = hash01(tick, r.id, 0x2545f491) * total;
    for (let k = 0; k < picks.length; k++) {
      spin -= weights[k];
      if (spin <= 0) return picks[k];
    }
    return picks[picks.length - 1];
  }

  // ---------- social memory (economic layer only; a pure read-out of settled history) ----------

  /** Exponential forgetting: an untouched value halves every halfLife sub-ticks of silence. */
  private static fade(value: number, lastTick: number, tick: number, halfLife: number): number {
    if (lastTick < 0 || tick <= lastTick || halfLife <= 0) return value;
    return value * Math.pow(0.5, (tick - lastTick) / halfLife);
  }

  private static clampSigned(x: number): number { return x < -1 ? -1 : x > 1 ? 1 : x; }

  /** A bond forgets on TWO clocks: a positive (trust) fades on BOND_HALF_LIFE, a negative (grudge) on the
   *  slower BOND_WOUND_HALF_LIFE — wounds outlast favours. Callers pass the raw stored score; the sign picks. */
  private static fadeBond(value: number, lastTick: number, tick: number): number {
    return AgentEconomy.fade(value, lastTick, tick, value < 0 ? BOND_WOUND_HALF_LIFE : BOND_HALF_LIFE);
  }

  /** Fetch (creating on first touch) one agent's social-memory record. */
  private memOf(id: number): AgentSocial {
    let m = this.social.get(id);
    if (!m) { m = { rep: 0, repTick: -1, kept: 0, broken: 0, bonds: [] }; this.social.set(id, m); }
    return m;
  }

  /** The bond `id` currently holds toward `other` at `tick` (−1 grudge .. +1 old partner; 0 = no past). */
  private effectiveBond(id: number, other: number, tick: number): number {
    const b = this.social.get(id)?.bonds.find((x) => x.other === other);
    return b ? AgentEconomy.clampSigned(AgentEconomy.fadeBond(b.score, b.lastTick, tick)) : 0;
  }

  /** The reputation `id` currently carries at `tick` (decays with silence — forgotten either way). */
  private effectiveRep(id: number, tick: number): number {
    const m = this.social.get(id);
    return m ? AgentEconomy.clampSigned(AgentEconomy.fade(m.rep, m.repTick, tick, REP_HALF_LIFE)) : 0;
  }

  /** Move one DIRECTED bond by delta (decayed to now first), season it, and prune to the top-K. */
  private touchBond(a: number, b: number, delta: number, traded: boolean, tick: number): void {
    const m = this.memOf(a);
    let bond = m.bonds.find((x) => x.other === b);
    if (!bond) { bond = { other: b, score: 0, trades: 0, lastTick: tick }; m.bonds.push(bond); }
    bond.score = AgentEconomy.clampSigned(AgentEconomy.fadeBond(bond.score, bond.lastTick, tick) + delta);
    if (traded) bond.trades++;
    bond.lastTick = tick;
    if (m.bonds.length > BOND_TOP_K) {
      // Keep the K most salient memories (strongest bond, then most seasoned); the rest are forgotten.
      m.bonds.sort((x, y) => Math.abs(y.score) - Math.abs(x.score) || y.trades - x.trades || x.other - y.other);
      m.bonds.length = BOND_TOP_K;
    }
  }

  /** Move one agent's reputation scalar (decayed to now, then nudged by delta). */
  private bumpRep(id: number, delta: number, tick: number): void {
    const m = this.memOf(id);
    m.rep = AgentEconomy.clampSigned(AgentEconomy.fade(m.rep, m.repTick, tick, REP_HALF_LIFE) + delta);
    m.repTick = tick;
  }

  /** A settled deal is a promise kept on both sides: mutual trust accrues, both names rise. */
  private rememberTrade(buyerId: number, sellerId: number, tick: number): void {
    this.touchBond(buyerId, sellerId, BOND_TRADE_STEP, true, tick);
    this.touchBond(sellerId, buyerId, BOND_TRADE_STEP, true, tick);
    this.memOf(buyerId).kept++;
    this.memOf(sellerId).kept++;
    this.bumpRep(buyerId, REP_KEEP_STEP, tick);
    this.bumpRep(sellerId, REP_KEEP_STEP, tick);
  }

  /**
   * A stiffed payment (buyer promised what it could not pay): the SELLER holds the grudge (directed),
   * the buyer's name takes a hard hit, and the grudge book records the betrayal for the historian.
   */
  private rememberBetrayal(buyerId: number, sellerId: number, amount: string, tick: number, reason: string): void {
    this.touchBond(sellerId, buyerId, -BOND_BETRAY_STEP, false, tick);
    this.memOf(buyerId).broken++;
    this.bumpRep(buyerId, -REP_BETRAY_STEP, tick);
    this.grudges.unshift({ tick, buyerId, sellerId, amount, reason });
    if (this.grudges.length > GRUDGE_CAP) this.grudges.length = GRUDGE_CAP;
  }

  /** A failed on-chain payment attempt: a light smudge on the debtor's name, not a grudge (rails falter). */
  private rememberFailedPayment(debtorId: number, creditorId: number, tick: number): void {
    this.touchBond(creditorId, debtorId, -BOND_TRADE_STEP, false, tick);
    this.memOf(debtorId).broken++;
    this.bumpRep(debtorId, -REP_FAIL_STEP, tick);
  }

  /** Bounded social read-out for the frontend (notable names, strongest bonds, the grudge book). */
  socialReadout(): SocialReadout {
    const tick = this.tickIndex;
    const rep: SocialReadout["rep"] = [];
    const bonds: SocialReadout["bonds"] = [];
    for (const [id, m] of Array.from(this.social.entries()).sort((x, y) => x[0] - y[0])) {
      const score = AgentEconomy.clampSigned(AgentEconomy.fade(m.rep, m.repTick, tick, REP_HALF_LIFE));
      if (Math.abs(score) >= 0.02 || m.broken > 0) {
        rep.push({ id, score: Math.round(score * 1000) / 1000, kept: m.kept, broken: m.broken });
      }
      for (const b of m.bonds) {
        const s = AgentEconomy.clampSigned(AgentEconomy.fadeBond(b.score, b.lastTick, tick));
        if (Math.abs(s) >= 0.02) bonds.push({ a: id, b: b.other, score: Math.round(s * 1000) / 1000, trades: b.trades });
      }
    }
    rep.sort((x, y) => Math.abs(y.score) - Math.abs(x.score) || x.id - y.id);
    bonds.sort((x, y) => Math.abs(y.score) - Math.abs(x.score) || y.trades - x.trades || x.a - y.a || x.b - y.b);
    return { rep: rep.slice(0, 16), bonds: bonds.slice(0, 24), grudges: this.grudges.slice(0, GRUDGE_CAP) };
  }

  /**
   * The historian's social signals: the sharpest live feud and seasoned alliance, the newest grudge-book
   * entry, and the worst-known deadbeat. Derived from the SAME persisted memory the economy acts on, so
   * the chronicle narrates real relationships — and still only READS OUT, never feeds back.
   */
  socialSignals(): {
    topFeud: { a: number; b: number; score: number } | null;
    topAlliance: { a: number; b: number; score: number; trades: number } | null;
    betrayal: { tick: number; buyerId: number; sellerId: number; amountUsdc: number } | null;
    deadbeat: { id: number; kept: number; broken: number; score: number } | null;
  } {
    const tick = this.tickIndex;
    let topFeud: { a: number; b: number; score: number } | null = null;
    let topAlliance: { a: number; b: number; score: number; trades: number } | null = null;
    let deadbeat: { id: number; kept: number; broken: number; score: number } | null = null;
    for (const [id, m] of Array.from(this.social.entries()).sort((x, y) => x[0] - y[0])) {
      const rs = AgentEconomy.clampSigned(AgentEconomy.fade(m.rep, m.repTick, tick, REP_HALF_LIFE));
      if (m.broken > 0 && rs <= -0.2 && (!deadbeat || rs < deadbeat.score)) {
        deadbeat = { id, kept: m.kept, broken: m.broken, score: Math.round(rs * 1000) / 1000 };
      }
      for (const b of m.bonds) {
        const s = AgentEconomy.clampSigned(AgentEconomy.fade(b.score, b.lastTick, tick, BOND_HALF_LIFE));
        if (s <= BOND_BLACKLIST && (!topFeud || s < topFeud.score)) topFeud = { a: id, b: b.other, score: Math.round(s * 1000) / 1000 };
        if (b.trades >= ALLIANCE_MIN_TRADES && s >= 0.3 && (!topAlliance || s > topAlliance.score)) {
          topAlliance = { a: id, b: b.other, score: Math.round(s * 1000) / 1000, trades: b.trades };
        }
      }
    }
    const g = this.grudges[0];
    const betrayal = g
      ? { tick: g.tick, buyerId: g.buyerId, sellerId: g.sellerId, amountUsdc: Math.round(atomicToUsdc(g.amount) * 10000) / 10000 }
      : null;
    return { topFeud, topAlliance, betrayal, deadbeat };
  }

  // ---------- institutions: limit books + price discovery (market plumbing only — money still moves EXCLUSIVELY through the x402/netting rails) ----------

  /** The tick-live order books. Not persisted: orders die with the tick; only the mark tapes survive (⑥-B serializes them). */
  private books = new MarketBooks();
  /** Sticky professions per fly (economic identity read off fap history; professions NEVER touch neurons). */
  private profs = new Map<number, ProfessionRecord>();
  /** Exponentially-decayed fap tallies ≈ a 50-tick window (reconverges after boot; never serialized). */
  private profTally = new Map<number, Record<Profession, number>>();
  /** How many ticks each fly's off-mode candidate has been running (hysteresis counter). */
  private profCand = new Map<number, { prof: Profession; streak: number }>();
  /** Live credit promises (bounded: IOU_CAP; the head of the array is the newest). */
  private ious: IouRecord[] = [];
  private lastRecallTick = -1000;
  private runUntilTick = -1;

  /** INSTITUTIONS resolved: false/absent ⇒ the old fixed-formula pricing, byte-for-byte. */
  private institutionsOn(): boolean {
    return !!this.cfg.institutions && this.cfg.institutions.enabled !== false;
  }

  /**
   * ORGANIC CONFLICT resolved: false/absent ⇒ no negative social events fire AND houseFeuds stays a pure
   * mean, so the economy is byte-for-byte unchanged. Unlike institutions (default ON), conflict is default
   * OFF and only arms on an explicit enabled:true — the whole layer is an opt-in experiment.
   */
  private conflictOn(): boolean {
    return !!this.cfg.conflict && this.cfg.conflict.enabled === true;
  }

  /**
   * TERRITORY resolved: false/absent ⇒ every territory hook no-ops and applyTerritory is a pure passthrough,
   * so the economy is byte-for-byte unchanged. Default OFF; arms only on an explicit enabled:true (like conflict).
   */
  private territoryOn(): boolean {
    return !!this.cfg.territory && this.cfg.territory.enabled === true;
  }

  /**
   * PLAYBOOK resolved: false/absent ⇒ every playbook hook no-ops, the economy is byte-for-byte unchanged.
   * Default OFF (ships dark); arms only on an explicit enabled:true.
   */
  private playbookOn(): boolean {
    return !!this.cfg.playbook && this.cfg.playbook.enabled === true;
  }

  /**
   * STRATEGY resolved: false/absent ⇒ every strategy hook no-ops, the economy is byte-for-byte the Phase 1
   * build. Default OFF (ships dark); arms only on an explicit enabled:true.
   */
  private strategyOn(): boolean {
    return !!this.cfg.strategy && this.cfg.strategy.enabled === true;
  }

  /**
   * ㉝ RULES resolved: false/absent ⇒ rulesTilt returns 1.0 and applyRuleModifiers is never called by state.ts,
   * so both decision points are byte-for-byte the pre-Rules build. Default OFF (ships dark); arms only on an
   * explicit enabled:true. The highest-risk membrane, so it is inert unless deliberately armed.
   */
  private rulesOn(): boolean {
    return !!this.cfg.rules && this.cfg.rules.enabled === true;
  }

  /** True when the MAP-Elites archive is armed (ELITES_ENABLED=true). OFF ⇒ archive never updates. */
  private elitesOn(): boolean {
    return !!this.cfg.elites && this.cfg.elites.enabled === true;
  }

  /** True when shadow-compare is armed (ECONOMY_EVOLUTION_SHADOW="true"). OFF ⇒ zero overhead, zero keys. */
  shadowCompareOn(): boolean {
    return !!this.cfg.shadowCompare && this.cfg.shadowCompare.enabled === true;
  }

  /** #123: True when equity-tilt is armed AND strength > 0. OFF/strength=0 ⇒ multiplier ≡ 1.0 (identity). */
  private equityTiltOn(): boolean {
    return !!this.cfg.equityTilt && this.cfg.equityTilt.enabled === true && this.cfg.equityTilt.strength > 0;
  }

  /** #123: True when dead-house sweep is armed. OFF ⇒ entomb branch ② byte-for-byte unchanged. */
  private deadHouseSweepOn(): boolean {
    return !!this.cfg.deadHouseSweep && this.cfg.deadHouseSweep.enabled === true;
  }

  /**
   * #143: True when the ONCHAIN estate-relief layer is armed. Requires the flag AND a live onchain
   * facilitator AND a wired escrow purse. OFF (default) ⇒ entomb queues nothing, the cron sweep/relief
   * executors no-op, and serialize() omits every #143 field — byte-for-byte today's build.
   */
  private estateReliefOn(): boolean {
    return !!this.cfg.estateRelief
      && this.cfg.estateRelief.enabled === true
      && this.facilitator.mode === "onchain"
      && !!this.escrowAddress;
  }

  /**
   * R5 FIX A: True when the on-chain balance gate is armed (ECONOMY_ONCHAIN_BALANCE_GATE=true). OFF ⇒ queueNet
   * never consults on-chain balances and folds every neuron-picked trade exactly as today (byte-for-byte).
   */
  balanceGateOn(): boolean {
    return !!this.cfg.onchainBalanceGate && this.cfg.onchainBalanceGate.enabled === true;
  }

  /**
   * R5 FIX B: mirror re-align cadence in crons. 0 ⇒ disabled/never (code-default, ECONOMY_MIRROR_RESYNC_EVERY_N_CRON=0).
   * Negative / non-finite / fractional inputs are clamped to a safe integer ≥ 0, so a bad var can never arm a
   * sub-cron or divide-by-zero resync.
   */
  mirrorResyncEveryN(): number {
    const n = this.cfg.mirrorResync?.everyNCrons ?? 0;
    return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
  }

  /**
   * R5 FIX A/B: populate `onchainBalances` with ONE batched multicall of balanceOf over every LIVE agent's real
   * address. On-chain reads are authoritative external inputs (the same class as settle()'s pre-signing balanceOf
   * and the market temperature) — NOT a determinism input, NOT an RNG. FAIL-OPEN on every degenerate path: a
   * facilitator without readBalances (the keyless simulator), an empty live set, or an errored/empty multicall all
   * leave the cache `null`, so the gate blocks nobody and the resync skips — degrading to today's exact behaviour.
   * One RPC per cron regardless of population (bounded wall-clock; mirrors the #98 anti-stall discipline).
   */
  private async refreshOnchainBalances(): Promise<void> {
    this.onchainBalances = null;
    const readBalances = this.facilitator.readBalances;
    if (typeof readBalances !== "function") return;   // simulator / unwired facilitator ⇒ no cache (fail-open)
    const addrs: string[] = [];
    for (const a of this.agents) {
      if (this.dead.has(a.id)) continue;              // a buried wallet keeps its ledger but never trades
      addrs.push(a.address);
    }
    if (addrs.length === 0) return;
    try {
      const m = await readBalances.call(this.facilitator, addrs);
      this.onchainBalances = m && m.size > 0 ? m : null;
    } catch {
      this.onchainBalances = null;                    // never let a balance read wedge the cron
    }
  }

  /**
   * R5 FIX A: can agent `id` cover `amount` (atomic string) with its REAL on-chain balance, per this cron's cache?
   * FAIL-OPEN by design: gate off, cold cache, unknown id, or an address absent from the multicall ⇒ `true` (we
   * never block a trade on a number we don't actually have — that would be worse than today). Only a confident
   * on-chain `bal < amount` returns false, which is exactly the pair that would 100% settle-fail at flush time.
   */
  private onchainSolvent(id: number, amount: string): boolean {
    if (!this.balanceGateOn()) return true;
    const cache = this.onchainBalances;
    if (!cache) return true;                          // cold cache ⇒ fail-open (queue as today)
    const idx = this.indexOfId.get(id);
    if (idx == null) return true;
    const bal = cache.get(this.agents[idx].address.toLowerCase());
    if (bal == null) return true;                     // not in the multicall ⇒ fail-open
    return bal >= BigInt(amount);
  }

  /**
   * R5 FIX B: overwrite every LIVE agent's DISPLAY mirror with its real on-chain balance from this cron's cache —
   * the honest target state settle()'s balanceOf gate already enforces. SAFETY (criterion B): the mirror is only
   * ever set EQUAL to on-chain here (elsewhere it is only adjusted DOWNWARD via tithe/entomb) — it is NEVER inflated
   * above on-chain, because mirror>chain is precisely what produces the 100%-settle-fail loop this fixes. Records the
   * pre-resync |mirror − onchain| delta into mirrorDriftAtomicSum (lifetime) + mirrorDriftAtomicLast (this cron) so
   * the decoupling is observable. Cold cache / a missing leg ⇒ that agent is SKIPPED (never guessed). Pure ledger
   * mirror write: touches NO real money, NO caps, NO stateDigest field, NO pendingNets.
   */
  private mirrorResyncToChain(): void {
    const cache = this.onchainBalances;
    if (!cache) return;                               // nothing authoritative to align to ⇒ skip entirely
    let drift = 0n;
    for (const a of this.agents) {
      if (this.dead.has(a.id)) continue;
      const bal = cache.get(a.address.toLowerCase());
      if (bal == null) continue;                      // not in the multicall ⇒ leave the mirror untouched
      const mirror = BigInt(a.balance);
      drift += mirror > bal ? mirror - bal : bal - mirror;
      a.balance = bal.toString();                     // set EQUAL to on-chain (never above it)
    }
    this.mirrorDriftAtomicLast = drift.toString();
    this.mirrorDriftAtomicSum = addAtomic(this.mirrorDriftAtomicSum, drift.toString());
  }

  /**
   * CULTURAL resolved (Phase 3 capability ③): false/absent ⇒ noteHatch is byte-for-byte the Phase 2b path
   * (no parent memory is copied, an id-reuse slot keeps its residue exactly as before). Default OFF.
   */
  private culturalOn(): boolean {
    return !!this.cfg.cultural && this.cfg.cultural.enabled === true;
  }

  /**
   * LAMARCK resolved (Phase 3 capability ③): false/absent ⇒ lamarckVector() returns null and breed.ts leaves
   * the child genome exactly as mutate/cross produced it. Default OFF.
   */
  private lamarckOn(): boolean {
    return !!this.cfg.lamarck && this.cfg.lamarck.enabled === true;
  }

  /**
   * Update the MAP-Elites archive from this tick's readings + agent ledger. Called once per cron boundary.
   * Each agent's behaviour descriptor bins are computed from (arousal, settle rate, good entropy) and the
   * archive cell is contested: a higher-fitness (netUsdc) agent replaces the incumbent. Bounded: at most
   * 64 cells × ~100B = 6.4KB. Deterministic: no Math.random, no Date.now in decisions.
   */
  private updateElitesArchive(readings: FlyReading[], tickIndex: number): void {
    for (const r of readings) {
      const idx = this.indexOfId.get(r.id);
      if (idx == null) continue;
      const agent = this.agents[idx];
      // H6 fix: use per-agent settle counters (deals+sales = successes, settleFail = failures) instead of
      // the degenerate totalSettles/tickIndex ratio that collapsed toward 0 as the swarm aged.
      const agentSettleOk = agent.deals + agent.sales;
      const agentSettleFail = agent.settleFail ?? 0;
      const gc = this.goodCounts.get(r.id) ?? [0, 0, 0, 0];
      const arousalR6 = Number.isFinite(r.arousal) ? Math.trunc(Math.max(0, Math.min(1, r.arousal)) * 1_000_000) : 0;
      const bins = computeBins(arousalR6, agentSettleOk, agentSettleOk + agentSettleFail, gc as [number, number, number, number]);
      // Fitness = netUsdc (earned - paid) in atomic, converted to a float for comparison.
      const netAtomic = BigInt(agent.earned) - BigInt(agent.paid);
      const fitness = Number(netAtomic) / 1e6;
      const th = this.strategyOn() ? (this.strategyTrees.get(r.id) ? treeHash(this.strategyTrees.get(r.id)!) : "") : "";
      this.elitesArchive.insert({
        agentId: r.id,
        fitness,
        treeHash: th,
        tick: tickIndex,
        bins,
      });
    }
  }

  /** Public accessor for the MAP-Elites archive (used by state.ts planEvolution wiring). */
  getElitesArchive(): ElitesArchive | null {
    return this.elitesOn() ? this.elitesArchive : null;
  }

  /**
   * PHASE 4 (capability ④) — read-only multi-objective fitness observations for tournament selection.
   *
   * Pure read-out over the SAME ledger the leaderboard + social memory already keep; it writes NOTHING, so
   * the one-way law (economy reads neural/ledger facts, never writes back) holds. The prediction dimension
   * is deliberately left null here — the PredictionMarket lives outside the economy — and is folded in by
   * the caller (state.ts) from prediction.leaderboard(); an agent with no prediction record stays neutral.
   *
   * Dimensions gathered (see mofit.ts for normalization):
   *   netUsdc       — realized PnL (the leaderboard key; the SAME value the netUsdc > 0 hard gate filters on)
   *   survivalTicks — currentTick − kin.bornTick (≥ 0); an agent with no kin record is treated as just-born
   *   settleOk/Total— social kept / (kept + broken); no social record ⇒ 0/0 (unobserved ⇒ neutral upstream)
   *   rep           — social reputation (−1..+1); no social record ⇒ null (neutral)
   *
   * @param currentTick the sub-tick the selection is planned for (the survival dimension's "now")
   */
  mofitInputs(currentTick: number): Map<number, MofitInput> {
    const out = new Map<number, MofitInput>();
    const now = Number.isFinite(currentTick) ? currentTick : 0;
    for (const row of this.leaderboard()) {
      const id = row.id;
      const kin = this.kin.get(id);
      const social = this.social.get(id);
      const bornTick = kin && Number.isFinite(kin.bornTick) ? kin.bornTick : now;
      const kept = social && Number.isFinite(social.kept) && social.kept > 0 ? social.kept : 0;
      const broken = social && Number.isFinite(social.broken) && social.broken > 0 ? social.broken : 0;
      out.set(id, {
        netUsdc: row.netUsdc,
        survivalTicks: Math.max(0, now - bornTick),
        settleOk: kept,
        settleTotal: kept + broken,
        predictRounds: null,   // folded in by the caller from PredictionMarket (economy never sees it)
        predictHits: null,
        rep: social && Number.isFinite(social.rep) ? social.rep : null,
      });
    }
    return out;
  }

  // ---------- STRATEGY: GP expression trees modulating economic decisions (Phase 2b, capability ②) ----------
  // Per-fly strategy trees evaluate over EXISTING neural read-outs (arousal/wingbeat/rest/cohesion/turn/
  // T/bond/rep/daHz/oaHz) and produce a bounded r6 tilt that is COMPOSED with (never replaces) the original
  // formula, then re-clamped by the SAME hard caps. ECONOMIC LAYER ONLY — the one-way law holds: neurons →
  // intent stays one-directional; the strategy never writes back into the connectome, never touches synWeight,
  // never adds a sensory channel. Deterministic: all seeds use hash01/hash32 (FNV-1a); zero Math.random.

  /** Salt for strategy tree generation seeds ("strat" in hex). */
  private static readonly SALT_STRAT_GEN = 0x73747261;

  /**
   * Get (or lazily generate) a fly's strategy tree. Deterministic: the seed is derived from
   * (tickIndex=0, agentId, SALT_STRAT_GEN) so the same fly always gets the same initial tree.
   * Returns null if generation fails (extremely unlikely with 64 attempts).
   */
  private strategyTreeOf(id: number): StrategyTree | null {
    let tree = this.strategyTrees.get(id);
    if (tree) return tree;
    // Deterministic seed from (0, id, salt) — stable across restarts for the same fly.
    const seed = hash32(0, id, AgentEconomy.SALT_STRAT_GEN);
    tree = generateTree(seed) ?? undefined;
    if (tree) this.strategyTrees.set(id, tree);
    return tree ?? null;
  }

  /**
   * Build the StrategyCtx (terminal index → r6 integer) from a fly's live neural read-out + social memory.
   * Terminal indices: 0=arousal, 1=wingbeat, 2=rest, 3=cohesion, 4=turn, 5=T, 6=bond, 7=rep, 8=daHz, 9=oaHz.
   * All values are existing neural/social read-outs × R6_SCALE, Math.trunc()'d to r6 integers.
   * NEVER adds a new sensory channel — manifestHash invariant holds.
   */
  private buildStrategyCtx(r: FlyReading, _tick: number): StrategyCtx {
    const ctx = new Map<number, number>();
    // Neural read-outs (already 0..1 except turnBias which is -1..1)
    ctx.set(0, Math.trunc(clamp01(r.arousal) * R6_SCALE));       // arousal
    ctx.set(1, Math.trunc(clamp01(r.wingbeat) * R6_SCALE));      // wingbeat
    ctx.set(2, Math.trunc(clamp01(r.rest) * R6_SCALE));          // rest
    ctx.set(3, Math.trunc(clamp01(r.cohesion) * R6_SCALE));      // cohesion
    ctx.set(4, Math.trunc(Math.max(-1, Math.min(1, r.turnBias)) * R6_SCALE)); // turn (signed)
    ctx.set(5, this.stratTempR6);                                 // T (market temperature, already r6)
    // Social memory read-outs (bond/rep are -1..1 / 0..1 respectively)
    const mem = this.social.get(r.id);
    const bond = mem ? AgentEconomy.clampSigned(mem.rep) : 0;    // use rep as proxy for aggregate bond
    const rep = mem ? clamp01((mem.rep + 1) / 2) : 0.5;          // normalise rep to 0..1
    ctx.set(6, Math.trunc(bond * R6_SCALE));                      // bond
    ctx.set(7, Math.trunc(rep * R6_SCALE));                       // rep
    // Neuromodulatory raw Hz (daHz/oaHz from the FlyReading's neuromod field)
    const nm = r.neuromod;
    ctx.set(8, Math.trunc(clamp01((nm?.daHz ?? 0) / 50) * R6_SCALE));  // daHz normalised to 0..1
    ctx.set(9, Math.trunc(clamp01((nm?.oaHz ?? 0) / 50) * R6_SCALE));  // oaHz normalised to 0..1
    return ctx;
  }

  /**
   * Evaluate a fly's strategy tree and return the r6 output mapped to a bounded tilt factor [0.5..1.5].
   * The raw evalStrategy output is in [-4.0, +4.0] r6; we map it to a multiplicative tilt centred on 1.0
   * with ±0.5 range, so the strategy can nudge but NEVER override the original formula.
   * Returns 1.0 (neutral) when strategy is OFF or the fly has no tree.
   */
  private strategyTilt(r: FlyReading, tick: number): number {
    if (!this.strategyOn()) return 1.0;
    const tree = this.strategyTreeOf(r.id);
    if (!tree) return 1.0;
    const ctx = this.buildStrategyCtx(r, tick);
    const raw = evalStrategy(tree, ctx);  // r6 integer in [-R6_SIGNED_MAX, +R6_SIGNED_MAX]
    // L4 fix: use the exported R6_SIGNED_MAX constant (not a hardcoded magic number) and clamp the result
    // so the tilt can never silently escape [0.5, 1.5] if fly-brain ever changes the bound.
    const norm = raw / R6_SIGNED_MAX;      // -1..1
    const tilt = 1.0 + norm * 0.5;         // 0.5..1.5
    return tilt < 0.5 ? 0.5 : tilt > 1.5 ? 1.5 : tilt;
  }

  /**
   * ㉝ THE CONSTITUTIONAL BAND CLAMP at the point of use (defence in depth). Returns the injected rule modifier
   * for one fly on one axis ("buy" = buyProbability, "cp" = counterparty weight), HARD-CLAMPED into the envelope
   * [RULE_FLOOR, RULE_CEIL] = [0.5, 2.0] INDEPENDENTLY of rules.ts: the configured band is first intersected with
   * the hard envelope (NaN-safe), the edges ordered, and a missing/NaN modifier falls back to the neutral 1.0. The
   * result is ALWAYS finite and inside [0.5, 2.0] — no wild value handed to applyRuleModifiers can ever escape, and
   * with RULES OFF (or no injected map) it is exactly 1.0 ⇒ the decision point is byte-for-byte unchanged.
   */
  private rulesTilt(r: FlyReading, axis: "buy" | "cp"): number {
    if (!this.rulesOn()) return 1.0;
    const m = this.ruleMods.get(r.id);
    if (!m) return 1.0;
    const raw = axis === "buy" ? m.buyMult : m.cpMult;
    if (!Number.isFinite(raw)) return 1.0;
    const b = this.cfg.rules!;
    const cfgLo = axis === "buy" ? b.buyMin : b.cpMin;
    const cfgHi = axis === "buy" ? b.buyMax : b.cpMax;
    // M1 fix: BOTH edges are clamped into the hard envelope [RULE_FLOOR, RULE_CEIL] before ordering,
    // so the result is ALWAYS inside [0.5, 2.0] regardless of what cfgLo/cfgHi contain.
    const lo = Math.min(AgentEconomy.RULE_CEIL, Math.max(AgentEconomy.RULE_FLOOR, Number.isFinite(cfgLo) ? cfgLo : AgentEconomy.RULE_FLOOR));
    const hi = Math.max(AgentEconomy.RULE_FLOOR, Math.min(AgentEconomy.RULE_CEIL, Number.isFinite(cfgHi) ? cfgHi : AgentEconomy.RULE_CEIL));
    const l = Math.min(lo, hi), h = Math.max(lo, hi);
    return raw < l ? l : raw > h ? h : raw;
  }

  // ---------- #123 EQUITY TILT (market-side wealth redistribution via cp-weight) ----------

  /**
   * Compute the balance percentile rank of every living agent for the given tick. Cached per tick so repeated
   * pickCounterparty calls within the same sub-tick reuse the same snapshot. Rank ∈ [0,1]: 0 = poorest, 1 = richest.
   * Deterministic: sorted by (balance ASC, agent-array-index ASC) — no RNG, no clock.
   */
  private balanceRanksForTick(tick: number): Float64Array | null {
    if (!this.equityTiltOn()) return null;
    if (this.eqRankTick === tick && this.eqRanks) return this.eqRanks;
    const living: { idx: number; bal: bigint }[] = [];
    for (let i = 0; i < this.agents.length; i++) {
      if (!this.dead.has(this.agents[i].id)) living.push({ idx: i, bal: BigInt(this.agents[i].balance) });
    }
    // Sort ascending by balance; ties broken by array index (deterministic, stable).
    living.sort((a, b) => (a.bal < b.bal ? -1 : a.bal > b.bal ? 1 : a.idx - b.idx));
    const ranks = new Float64Array(this.agents.length);
    const n = living.length;
    for (let r = 0; r < n; r++) {
      ranks[living[r].idx] = n > 1 ? r / (n - 1) : 0.5;
    }
    this.eqRankTick = tick;
    this.eqRanks = ranks;
    return ranks;
  }

  /**
   * The equity-tilt multiplier for a CANDIDATE SELLER at the given balance rank. Direction:
   *   high rank (rich) → LOW tilt → less likely to be picked as seller → less income
   *   low rank (poor)  → HIGH tilt → more likely to be picked as seller → more income
   * Formula: raw = 1 + strength × (1 − 2×rank), so rank=0 → 1+s, rank=1 → 1−s, rank=0.5 → 1.0.
   * A tiny deterministic hash01 jitter (±1% of strength) breaks exact ties without RNG.
   * Band-clamped into [band[0], band[1]] (defense-in-depth, mirrors the rulesTilt pattern).
   * Returns 1.0 when OFF or strength=0 (multiplicative identity).
   */
  private equityTiltMult(rank: number, tick: number, candId: number): number {
    const cfg = this.cfg.equityTilt;
    if (!cfg || !cfg.enabled || cfg.strength <= 0) return 1.0;
    const s = cfg.strength;
    // Deterministic tie-break jitter: FNV-1a hash01, scaled to ±1% of strength.
    const jitter = (hash01(tick, candId, 0xE9171145) - 0.5) * 0.02 * s;
    const raw = 1 + s * (1 - 2 * rank) + jitter;
    if (!Number.isFinite(raw)) return 1.0;
    // Band-clamp: both edges forced into the hard constitutional envelope [RULE_FLOOR, RULE_CEIL] first,
    // then the configured band is applied (same defense-in-depth as rulesTilt).
    const cfgLo = Number.isFinite(cfg.band[0]) ? cfg.band[0] : AgentEconomy.RULE_FLOOR;
    const cfgHi = Number.isFinite(cfg.band[1]) ? cfg.band[1] : AgentEconomy.RULE_CEIL;
    const lo = Math.min(AgentEconomy.RULE_CEIL, Math.max(AgentEconomy.RULE_FLOOR, cfgLo));
    const hi = Math.max(AgentEconomy.RULE_FLOOR, Math.min(AgentEconomy.RULE_CEIL, cfgHi));
    const l = Math.min(lo, hi), h = Math.max(lo, hi);
    return raw < l ? l : raw > h ? h : raw;
  }

  /**
   * ㉝ Inject THIS cron's band-clamped rule modifiers. state.ts calls it AFTER economy.step (from driveRules), so
   * the modifiers take honest effect on the NEXT cron — the same one-cron lag every membrane keeps. The map is a
   * pure RUNTIME field, NEVER persisted and NEVER folded into stateDigest; a null/empty map ⇒ rulesTilt returns
   * 1.0 ⇒ both decision points are byte-for-byte the pre-Rules build. Every value is re-clamped into the
   * constitutional band at each use point. This tilts a propensity and a counterparty weight ONLY — it NEVER
   * touches a settlement, a deal amount, a real-spend cap, a mnemonic, x402, and NEVER signs/broadcasts.
   */
  applyRuleModifiers(map: Map<number, { buyMult: number; cpMult: number }> | null): void {
    this.ruleMods = map && map.size ? new Map(map) : new Map();
  }

  /**
   * Evaluate a fly's strategy tree for the prediction market and return a bounded additive tilt [-0.5..+0.5].
   * Used to modulate the prediction score (direction lean). Returns 0 (neutral) when OFF.
   * PUBLIC: state.ts passes this as a callback to PredictionMarket.openRound().
   */
  strategyPredictTilt(r: FlyReading, tick: number): number {
    if (!this.strategyOn()) return 0;
    const tree = this.strategyTreeOf(r.id);
    if (!tree) return 0;
    const ctx = this.buildStrategyCtx(r, tick);
    const raw = evalStrategy(tree, ctx);
    // Map to [-0.5, +0.5] additive tilt on the prediction score
    return (raw / 4_000_000) * 0.5;
  }

  /** Expose strategy trees for external consumers (elites archive, breed hash folding). */
  getStrategyTree(id: number): StrategyTree | null {
    if (!this.strategyOn()) return null;
    return this.strategyTreeOf(id);
  }

  /** Expose all strategy tree hashes for the elites archive / lineage. */
  strategyTreeHashes(): Map<number, string> {
    const out = new Map<number, string>();
    if (!this.strategyOn()) return out;
    for (const [id, tree] of this.strategyTrees) {
      out.set(id, treeHash(tree));
    }
    return out;
  }

  // ---------- PLAYBOOK: consequence-driven long-term memory (Phase 1, capability ①) ----------
  // A bounded per-fly episodic ring that records trade outcomes keyed by decision context, so future
  // choices (which good to buy, which counterparty to prefer) are reweighted by past consequences.
  // ECONOMIC LAYER ONLY — the one-way law holds: neurons → intent stays one-directional; the playbook
  // never writes back into the connectome, never touches synWeight, never adds a sensory channel.
  // Deterministic: all draws use hash01/hash32 (FNV-1a); zero Math.random, zero Date.now in decisions.

  /**
   * Record one playbook entry for a fly. Ring buffer: when full, evict the OLDEST entry (lowest tick).
   * Called from rememberTrade / rememberBetrayal / rememberFailedPayment — the same signal sources that
   * drive social memory bonds. Inert while playbookOn() is false.
   */
  private playbookRecord(id: number, action: number, good: GoodKind, outcome: number, valid: number, tick: number): void {
    if (!this.playbookOn()) return;
    const goodIdx = GOOD_KINDS.indexOf(good);
    if (goodIdx < 0) return;
    const ctx = hash32(tick, this.pbRegime * 4 + this.pbTempBucket, id);
    let ring = this.playbook.get(id);
    if (!ring) { ring = []; this.playbook.set(id, ring); }
    const entry: PlaybookEntry = { ctx, action, good: goodIdx, regime: this.pbRegime, outcome, valid, tick };
    if (ring.length >= PLAYBOOK_CAP) {
      // Evict the oldest (lowest tick) to make room — deterministic, no Date.now.
      let oldest = 0;
      for (let i = 1; i < ring.length; i++) { if (ring[i].tick < ring[oldest].tick) oldest = i; }
      ring[oldest] = entry;
    } else {
      ring.push(entry);
    }
  }

  /**
   * Compute a decaying confidence score [0..1] from a fly's playbook: the exponential-weighted average
   * of `valid` flags. High confidence = recent trades mostly succeeded; low = many failures.
   * Deterministic: decay is a pure function of (entry.tick, currentTick).
   */
  private playbookConfidence(id: number, tick: number): number {
    const ring = this.playbook.get(id);
    if (!ring || ring.length === 0) return 0.5;   // no history = neutral
    let wSum = 0;
    let vSum = 0;
    for (const e of ring) {
      const age = Math.max(0, tick - e.tick);
      const w = Math.pow(0.5, age / PLAYBOOK_HALF_LIFE);
      wSum += w;
      vSum += w * e.valid;
    }
    return wSum > 0 ? vSum / wSum : 0.5;
  }

  /**
   * H5 fix: Compute per-good decaying outcome scores SPLIT BY ACTION (bought vs sold).
   * Returns { bought: number[4], sold: number[4] } — each the exponential-weighted mean consequence
   * normalised to [-1, 1] using LAMARCK_PROFIT_SCALE (1e6 atomic = 1 USDC) as the real-money scale.
   *
   * boughtScore[good]: "did buying this good work out?"
   *   - valid buy (action=0, valid=1): +|outcome|/scale (a successful purchase delivered value)
   *   - invalid buy (action=0, valid=0): -1 (failure is maximally bad)
   * soldScore[good]: "did selling this good work out?"
   *   - valid sell (action=1, valid=1): +outcome/scale (earned income)
   *   - invalid sell (action=1, valid=0): -1
   *
   * The old code ignored `e.action`, conflating "I was the seller" with "positive consequence" and
   * saturating at ±1 for any amount ≥ 0.01 USDC (divisor 10000 vs real amounts ~50000 atomic).
   */
  private playbookGoodScores(id: number, tick: number): { bought: number[]; sold: number[] } {
    const boughtS = [0, 0, 0, 0], boughtW = [0, 0, 0, 0];
    const soldS = [0, 0, 0, 0], soldW = [0, 0, 0, 0];
    const ring = this.playbook.get(id);
    if (!ring) return { bought: boughtS, sold: soldS };
    for (const e of ring) {
      const age = Math.max(0, tick - e.tick);
      const w = Math.pow(0.5, age / PLAYBOOK_HALF_LIFE);
      if (e.action === 0) {
        // Buyer side: a valid buy means the good was delivered — positive consequence scaled by price.
        const norm = e.valid ? Math.max(-1, Math.min(1, Math.abs(e.outcome) / LAMARCK_PROFIT_SCALE)) : -1;
        boughtS[e.good] += w * norm;
        boughtW[e.good] += w;
      } else {
        // Seller side: a valid sell means income earned — positive consequence scaled by amount.
        const norm = e.valid ? Math.max(-1, Math.min(1, e.outcome / LAMARCK_PROFIT_SCALE)) : -1;
        soldS[e.good] += w * norm;
        soldW[e.good] += w;
      }
    }
    for (let i = 0; i < 4; i++) {
      boughtS[i] = boughtW[i] > 0 ? boughtS[i] / boughtW[i] : 0;
      soldS[i] = soldW[i] > 0 ? soldS[i] / soldW[i] : 0;
    }
    return { bought: boughtS, sold: soldS };
  }

  /**
   * PLAYBOOK good override: with bounded probability, switch the neurally-chosen good to one with a
   * better BOUGHT-score (H5 fix: reads only the buy-side consequence ledger, not the sell-side, so the
   * override reflects "which good served me well when I bought it" rather than "which good I sold").
   * The switch probability is capped at PLAYBOOK_GOOD_SWITCH_MAX (25%) so the neurons' choice is never
   * fully overridden — only nudged by consequence memory.
   * ε-greedy floor: PLAYBOOK_EPSILON/2 = 4% minimum exploration (L8 fix: the good override uses half the
   * counterparty ε because overriding WHAT to buy is a lighter nudge than overriding WHO to buy from).
   * Deterministic: the draw is hash01(tick, id, PLAYBOOK_SALT_GOOD).
   */
  private playbookGoodOverride(id: number, baseGood: GoodKind, tick: number): GoodKind {
    const { bought: scores } = this.playbookGoodScores(id, tick);
    const baseIdx = GOOD_KINDS.indexOf(baseGood);
    if (baseIdx < 0) return baseGood;
    const baseScore = scores[baseIdx];
    // Find the best-scoring good (by buy-side consequence)
    let bestIdx = baseIdx;
    let bestScore = baseScore;
    for (let i = 0; i < 4; i++) {
      if (scores[i] > bestScore) { bestScore = scores[i]; bestIdx = i; }
    }
    if (bestIdx === baseIdx) return baseGood;   // base is already the best
    // Switch probability: proportional to the score gap, capped at PLAYBOOK_GOOD_SWITCH_MAX.
    const gap = Math.max(0, bestScore - baseScore);
    const switchProb = Math.min(PLAYBOOK_GOOD_SWITCH_MAX, gap * PLAYBOOK_GOOD_SWITCH_MAX * 2);
    // ε-greedy exploration floor (4%): prevents lock-in to a stale preference.
    const finalProb = Math.max(PLAYBOOK_EPSILON * 0.5, switchProb);
    const draw = hash01(tick, id, PLAYBOOK_SALT_GOOD);
    return draw < finalProb ? GOOD_KINDS[bestIdx] : baseGood;
  }

  /**
   * PLAYBOOK counterparty modulation: adjusts the social-memory weight of candidates based on the
   * buyer's playbook confidence. High confidence (trades mostly valid) amplifies social signals;
   * low confidence dampens toward uniform (explores more). Bounded: the amplifier is clamped to
   * [0.5, 1.0] so it NEVER expands beyond the existing social-memory range.
   *
   * ε-greedy exploration: with probability PLAYBOOK_EPSILON (deterministic hash01), ignore ALL social
   * weights and pick uniformly from the pool — even a fly with perfect bonds sometimes explores.
   *
   * Returns { amplifier, explore } where:
   *   amplifier: multiplicative factor on bond/rep weights [0.5..1.0]
   *   explore: true if the ε-greedy draw fired (pick uniformly)
   */
  private playbookCounterpartyMod(id: number, tick: number): { amplifier: number; explore: boolean } {
    const confidence = this.playbookConfidence(id, tick);
    // amplifier: 0.5 (no confidence = dampen social to half) .. 1.0 (full confidence = full social weight)
    const amplifier = 0.5 + 0.5 * clamp01(confidence);
    // ε-greedy: deterministic draw decides exploration
    const exploreDraw = hash01(tick, id, PLAYBOOK_SALT_EPS);
    const explore = exploreDraw < PLAYBOOK_EPSILON;
    return { amplifier, explore };
  }

  // ---------- SHADOW-COMPARE (task #87): the evolution decision mirror ----------
  // PURE READ-OUT: shadowStep mirrors step()'s decision loop with evolution capabilities ON and records
  // baseline-vs-evolved diffs. STRUCTURAL SAFETY: this function body NEVER references this.facilitator,
  // queueNet, settle, flush, absorbFlows, payBreedingFee, payHatchFee. It NEVER writes any real field
  // (balance/paid/earned/deals/sales/volumeAtomic/count/settleOk|Fail/recent/pendingNets/proofs/
  // proofChainHead/spendGuard/social/grudges). Evidence goes to D1 only via the caller (state.ts).

  /**
   * Mirror the decision loop for one sub-tick, computing BOTH the baseline (all evolution caps OFF) and
   * evolved (strategy/playbook/elites ON) decisions side-by-side. Returns up to maxDecisions rows.
   *
   * STRUCTURAL UNREACHABILITY GUARANTEE: this function body does NOT reference this.facilitator, queueNet,
   * settle, flush, absorbFlows, payBreedingFee, or payHatchFee — the 4 facilitator.settle() sites are
   * structurally unreachable from here. It does NOT write any real field.
   */
  shadowStep(
    readings: FlyReading[],
    collective: CollectiveState,
    tickIndex: number,
    cronNum: number,
  ): ShadowDecision[] {
    if (!this.shadowCompareOn()) return [];
    if (!this.cfg.enabled || readings.length < 2) return [];

    const maxDecisions = this.cfg.shadowCompare!.maxDecisionsPerCron;
    const n = readings.length;
    const T = clamp01(collective.temperature);
    const regime = collective.regime;
    const tempBucket = Math.min(3, Math.floor(T * 4));
    const demand = 0.3 + 0.7 * T;
    const maxDealAtomic = BigInt(usdcToAtomic(this.cfg.maxDealUsdc));
    const rows: ShadowDecision[] = [];
    const ts = Date.now();

    // Evolved context (mirrors step()'s setup but only for the shadow branch)
    const evoStratTempR6 = Math.trunc(T * R6_SCALE);
    const evoPbRegime = regime === "HOT" ? 2 : regime === "COLD" ? 0 : 1;

    let ampSum = 0;
    let ampCount = 0;
    const treeHashes = new Set<string>();

    for (let i = 0; i < n && rows.length < maxDecisions; i++) {
      const r = readings[i];
      if (this.dead.has(r.id)) continue;
      const buyerIdx = this.indexOfId.get(r.id);
      if (buyerIdx == null) continue;

      // --- BASELINE: no strategy, no playbook, no rules, no elites ---
      const wantBase = this.shadowBuyProbabilityBase(r, T);
      const draw = hash01(tickIndex, r.id, 0x9e3779b9);
      const baseBuys = draw <= wantBase * demand;

      // --- EVOLVED: strategy tilt + playbook good override + playbook amplifier + rules tilt ---
      const wantEvo = this.shadowBuyProbabilityEvo(r, T, tickIndex, evoStratTempR6);
      const evoBuys = draw <= wantEvo * demand;

      // Gate flips
      if (!baseBuys && evoBuys) this.shadowAgg.gateFlipsToBuy++;
      if (baseBuys && !evoBuys) this.shadowAgg.gateFlipsToHold++;
      if (baseBuys) this.shadowAgg.baselineBuys++;
      if (evoBuys) this.shadowAgg.evolvedBuys++;

      // Even if neither buys, record the decision comparison (the want values ARE the evidence)
      const goodBase = goodForState(r.state);
      const goodEvo = this.shadowPlaybookGoodOverride(r.id, goodBase, tickIndex);
      if (goodBase !== goodEvo) this.shadowAgg.goodSwitches++;

      // Seller comparison (baseline = no playbook amp / no strategy tilt on cp)
      const sellerBase = this.shadowPickCounterpartyBase(r, buyerIdx, i, n, tickIndex);
      const pbMod = this.shadowPlaybookCounterpartyMod(r.id, tickIndex);
      const sellerEvo = this.shadowPickCounterpartyEvo(r, buyerIdx, i, n, tickIndex, pbMod, evoStratTempR6);
      if (sellerBase !== sellerEvo) this.shadowAgg.sellerChanges++;

      // Amount comparison
      const amountBase = this.shadowDealAmountBase(r, T, goodBase);
      const amountEvo = this.shadowDealAmountEvo(r, T, goodEvo, tickIndex, evoStratTempR6);
      const amountEvoBI = BigInt(amountEvo);
      const capped = maxDealAtomic > 0n && amountEvoBI > maxDealAtomic;
      const amountAfterCap = capped ? String(maxDealAtomic) : amountEvo;
      const capReason = capped ? "max-deal" : "";
      if (capped) this.shadowAgg.cappedByMaxDeal++;

      const delta = Math.abs(Number(amountEvo) - Number(amountBase));
      this.shadowAgg.amountDeltaSumAtomic += delta;
      if (delta > this.shadowAgg.amountDeltaMaxAtomic) this.shadowAgg.amountDeltaMaxAtomic = delta;
      this.shadowAgg.evolvedAmountSumAtomic += Number(amountEvo);
      this.shadowAgg.baselineAmountSumAtomic += Number(amountBase);

      // Strategy tree hash for distinctness tracking
      const tree = this.strategyTreeOf(r.id);
      const th = tree ? treeHash(tree) : "";
      if (th) treeHashes.add(th);

      // Amplifier tracking
      ampSum += pbMod.amplifier;
      ampCount++;
      if (pbMod.explore) this.shadowAgg.exploreCount++;

      rows.push({
        ts, tick: tickIndex, cron: cronNum,
        buyerId: r.id,
        sellerIdBase: sellerBase >= 0 ? (this.agents[sellerBase]?.id ?? -1) : -1,
        sellerIdEvo: sellerEvo >= 0 ? (this.agents[sellerEvo]?.id ?? -1) : -1,
        goodBase, goodEvo,
        wantBase, wantEvo,
        amountBaseAtomic: amountBase,
        amountEvoAtomic: amountEvo,
        amountEvoAfterCapAtomic: amountAfterCap,
        capReason,
        treeHash: th,
        pbConfidence: this.shadowPlaybookConfidence(r.id, tickIndex),
        pbAmplifier: pbMod.amplifier,
        pbExplore: pbMod.explore,
        regime,
        tempBucket,
      });
    }

    // Update aggregates
    this.shadowAgg.crons++;
    this.shadowAgg.decisions += rows.length;
    this.shadowAgg.avgAmplifier = ampCount > 0 ? ampSum / ampCount : 0;
    this.shadowAgg.treeHashDistinct = treeHashes.size;

    return rows;
  }

  /**
   * Feed real flush outcomes into the shadow-only playbook ring so the amplifier channel lives.
   * Called AFTER economy.flush() returns. Reads the flushed settlements (pure observation) and writes
   * ONLY to this.shadowPlaybook — never to this.playbook (the real one).
   * STRUCTURAL SAFETY: does NOT reference this.facilitator, queueNet, settle, flush, absorbFlows,
   * payBreedingFee, payHatchFee. Does NOT write any real field.
   */
  shadowRecordOutcomes(flushed: Settlement[], tickIndex: number): void {
    if (!this.shadowCompareOn()) return;
    const regime = this.pbRegime;
    const tempBucket = this.pbTempBucket;
    for (const s of flushed) {
      if (!s || s.fromId == null) continue;
      const id = s.fromId;
      const goodIdx = GOOD_KINDS.indexOf(s.good as GoodKind);
      if (goodIdx < 0) continue;
      const ctx = hash32(tickIndex, regime * 4 + tempBucket, id);
      let ring = this.shadowPlaybook.get(id);
      if (!ring) { ring = []; this.shadowPlaybook.set(id, ring); }
      const entry: PlaybookEntry = {
        ctx, action: 0, good: goodIdx, regime,
        outcome: Number(s.amount || 0), valid: s.valid ? 1 : 0, tick: tickIndex,
      };
      if (ring.length >= PLAYBOOK_CAP) {
        let oldest = 0;
        for (let i = 1; i < ring.length; i++) { if (ring[i].tick < ring[oldest].tick) oldest = i; }
        ring[oldest] = entry;
      } else {
        ring.push(entry);
      }
    }
  }

  // --- Shadow-internal pure helpers (NO side effects on real state) ---

  /** Baseline buyProbability: no strategy tilt, no rules tilt (exactly the pre-evolution formula). */
  private shadowBuyProbabilityBase(r: FlyReading, T: number): number {
    const stateBase =
      r.state === "AGITATE" ? 0.9 :
      r.state === "EXPLORE" ? 0.7 :
      r.state === "AGGREGATE" ? 0.5 : 0.12;
    const arousal = 0.5 + 0.5 * clamp01(r.arousal);
    const wing = 0.85 + 0.3 * clamp01(r.wingbeat);
    const rest = 1 - 0.6 * clamp01(r.rest);
    return clamp01(stateBase * arousal * wing * rest * (0.6 + 0.4 * T));
  }

  /** Evolved buyProbability: strategy tilt + rules tilt composed BEFORE clamp01 (mirrors buyProbability). */
  private shadowBuyProbabilityEvo(r: FlyReading, T: number, tick: number, stratTempR6: number): number {
    const stateBase =
      r.state === "AGITATE" ? 0.9 :
      r.state === "EXPLORE" ? 0.7 :
      r.state === "AGGREGATE" ? 0.5 : 0.12;
    const arousal = 0.5 + 0.5 * clamp01(r.arousal);
    const wing = 0.85 + 0.3 * clamp01(r.wingbeat);
    const rest = 1 - 0.6 * clamp01(r.rest);
    let base = stateBase * arousal * wing * rest * (0.6 + 0.4 * T);
    // Strategy tilt (reuses the same pure-function path as the real strategyTilt)
    base *= this.shadowStrategyTilt(r, tick, stratTempR6);
    // Rules tilt
    base *= this.rulesTilt(r, "buy");
    return clamp01(base);
  }

  /** Shadow strategy tilt: identical logic to strategyTilt() but uses an explicit tempR6 (no side effects). */
  private shadowStrategyTilt(r: FlyReading, tick: number, stratTempR6: number): number {
    if (!this.strategyOn()) return 1.0;
    const tree = this.strategyTreeOf(r.id);
    if (!tree) return 1.0;
    // Build ctx inline (same terminals as buildStrategyCtx, no side effects)
    const ctx = new Map<number, number>();
    ctx.set(0, Math.trunc(clamp01(r.arousal) * R6_SCALE));
    ctx.set(1, Math.trunc(clamp01(r.wingbeat) * R6_SCALE));
    ctx.set(2, Math.trunc(clamp01(r.rest) * R6_SCALE));
    ctx.set(3, Math.trunc(clamp01(r.cohesion) * R6_SCALE));
    ctx.set(4, Math.trunc(Math.max(-1, Math.min(1, r.turnBias)) * R6_SCALE));
    ctx.set(5, stratTempR6);
    const mem = this.social.get(r.id);
    const bond = mem ? AgentEconomy.clampSigned(mem.rep) : 0;
    const rep = mem ? clamp01((mem.rep + 1) / 2) : 0.5;
    ctx.set(6, Math.trunc(bond * R6_SCALE));
    ctx.set(7, Math.trunc(rep * R6_SCALE));
    const nm = r.neuromod;
    ctx.set(8, Math.trunc(clamp01((nm?.daHz ?? 0) / 50) * R6_SCALE));
    ctx.set(9, Math.trunc(clamp01((nm?.oaHz ?? 0) / 50) * R6_SCALE));
    const raw = evalStrategy(tree, ctx);
    const norm = raw / R6_SIGNED_MAX;
    const tilt = 1.0 + norm * 0.5;
    return tilt < 0.5 ? 0.5 : tilt > 1.5 ? 1.5 : tilt;
  }

  /** Shadow baseline counterparty pick: no playbook amplifier, no strategy tilt on cp. */
  private shadowPickCounterpartyBase(r: FlyReading, buyerI: number, i: number, n: number, tick: number): number {
    const others = n - 1;
    if (others <= 0) return -1;
    const coh = clamp01(r.cohesion);
    const span = Math.max(1, Math.round(1 + (1 - coh) * (others - 1)));
    const dir = r.turnBias >= 0 ? 1 : -1;
    const pool: number[] = [];
    const seen = new Set<number>([buyerI]);
    for (let j = 0; j < Math.min(PICK_CANDIDATES, span); j++) {
      const off = 1 + Math.floor(hash01(tick, r.id, (0x85ebca6b ^ Math.imul(j + 1, 0x9e3779b1)) >>> 0) * span);
      let idx = (buyerI + dir * off) % n;
      if (idx < 0) idx += n;
      if (seen.has(idx)) continue;
      seen.add(idx);
      pool.push(idx);
    }
    if (pool.length === 0) return -1;
    const picks: number[] = [];
    const weights: number[] = [];
    let total = 0;
    for (const idx of pool) {
      const cand = this.agents[idx];
      if (!cand || this.dead.has(cand.id)) continue;
      const bond = this.effectiveBond(r.id, cand.id, tick);
      if (bond <= BOND_BLACKLIST) continue;
      const rep = this.effectiveRep(cand.id, tick);
      // Baseline: amp=1, stratTilt=1, cpRuleMod=1
      const w = Math.max(0.05, 1 + 1 * (0.6 * bond + 0.4 * rep));
      picks.push(idx);
      weights.push(w);
      total += w;
    }
    if (picks.length === 0) return -1;
    let spin = hash01(tick, r.id, 0x2545f491) * total;
    for (let k = 0; k < picks.length; k++) {
      spin -= weights[k];
      if (spin <= 0) return picks[k];
    }
    return picks[picks.length - 1];
  }

  /** Shadow evolved counterparty pick: playbook amplifier + strategy tilt + rules tilt on cp. */
  private shadowPickCounterpartyEvo(
    r: FlyReading, buyerI: number, i: number, n: number, tick: number,
    pbMod: { amplifier: number; explore: boolean }, stratTempR6: number,
  ): number {
    const others = n - 1;
    if (others <= 0) return -1;
    const coh = clamp01(r.cohesion);
    const span = Math.max(1, Math.round(1 + (1 - coh) * (others - 1)));
    const dir = r.turnBias >= 0 ? 1 : -1;
    const pool: number[] = [];
    const seen = new Set<number>([buyerI]);
    for (let j = 0; j < Math.min(PICK_CANDIDATES, span); j++) {
      const off = 1 + Math.floor(hash01(tick, r.id, (0x85ebca6b ^ Math.imul(j + 1, 0x9e3779b1)) >>> 0) * span);
      let idx = (buyerI + dir * off) % n;
      if (idx < 0) idx += n;
      if (seen.has(idx)) continue;
      seen.add(idx);
      pool.push(idx);
    }
    if (pool.length === 0) return -1;
    const stratTilt = this.shadowStrategyTilt(r, tick, stratTempR6);
    const cpRuleMod = this.rulesTilt(r, "cp");
    const picks: number[] = [];
    const weights: number[] = [];
    let total = 0;
    for (const idx of pool) {
      const cand = this.agents[idx];
      if (!cand || this.dead.has(cand.id)) continue;
      const bond = this.effectiveBond(r.id, cand.id, tick);
      if (bond <= BOND_BLACKLIST) continue;
      const rep = this.effectiveRep(cand.id, tick);
      const amp = pbMod.explore ? 0 : pbMod.amplifier;
      const w = Math.max(0.05, 1 + amp * stratTilt * cpRuleMod * (0.6 * bond + 0.4 * rep));
      picks.push(idx);
      weights.push(w);
      total += w;
    }
    if (picks.length === 0) return -1;
    let spin = hash01(tick, r.id, 0x2545f491) * total;
    for (let k = 0; k < picks.length; k++) {
      spin -= weights[k];
      if (spin <= 0) return picks[k];
    }
    return picks[picks.length - 1];
  }

  /** Shadow playbook good override: reads from shadowPlaybook (not the real playbook). */
  private shadowPlaybookGoodOverride(id: number, baseGood: GoodKind, tick: number): GoodKind {
    if (!this.playbookOn()) return baseGood;
    const scores = this.shadowPlaybookGoodScores(id, tick);
    const baseIdx = GOOD_KINDS.indexOf(baseGood);
    if (baseIdx < 0) return baseGood;
    const baseScore = scores[baseIdx];
    let bestIdx = baseIdx;
    let bestScore = baseScore;
    for (let i = 0; i < 4; i++) {
      if (scores[i] > bestScore) { bestScore = scores[i]; bestIdx = i; }
    }
    if (bestIdx === baseIdx) return baseGood;
    const gap = Math.max(0, bestScore - baseScore);
    const switchProb = Math.min(PLAYBOOK_GOOD_SWITCH_MAX, gap * PLAYBOOK_GOOD_SWITCH_MAX * 2);
    const finalProb = Math.max(PLAYBOOK_EPSILON * 0.5, switchProb);
    const draw = hash01(tick, id, PLAYBOOK_SALT_GOOD);
    return draw < finalProb ? GOOD_KINDS[bestIdx] : baseGood;
  }

  /** Shadow playbook good scores from the SHADOW ring only. */
  private shadowPlaybookGoodScores(id: number, tick: number): number[] {
    const boughtS = [0, 0, 0, 0], boughtW = [0, 0, 0, 0];
    const ring = this.shadowPlaybook.get(id);
    if (!ring) return boughtS;
    for (const e of ring) {
      const age = Math.max(0, tick - e.tick);
      const w = Math.pow(0.5, age / PLAYBOOK_HALF_LIFE);
      if (e.action === 0) {
        const norm = e.valid ? Math.max(-1, Math.min(1, Math.abs(e.outcome) / LAMARCK_PROFIT_SCALE)) : -1;
        boughtS[e.good] += w * norm;
        boughtW[e.good] += w;
      }
    }
    for (let i = 0; i < 4; i++) {
      boughtS[i] = boughtW[i] > 0 ? boughtS[i] / boughtW[i] : 0;
    }
    return boughtS;
  }

  /** Shadow playbook confidence from the SHADOW ring only (not the real playbook). */
  private shadowPlaybookConfidence(id: number, tick: number): number {
    const ring = this.shadowPlaybook.get(id);
    if (!ring || ring.length === 0) return 0.5;
    let wSum = 0, vSum = 0;
    for (const e of ring) {
      const age = Math.max(0, tick - e.tick);
      const w = Math.pow(0.5, age / PLAYBOOK_HALF_LIFE);
      wSum += w;
      vSum += w * e.valid;
    }
    return wSum > 0 ? vSum / wSum : 0.5;
  }

  /** Shadow playbook counterparty mod from the SHADOW ring. */
  private shadowPlaybookCounterpartyMod(id: number, tick: number): { amplifier: number; explore: boolean } {
    if (!this.playbookOn()) return { amplifier: 1, explore: false };
    const confidence = this.shadowPlaybookConfidence(id, tick);
    const amplifier = 0.5 + 0.5 * clamp01(confidence);
    const exploreDraw = hash01(tick, id, PLAYBOOK_SALT_EPS);
    const explore = exploreDraw < PLAYBOOK_EPSILON;
    return { amplifier, explore };
  }

  /** Shadow baseline deal amount: no strategy tilt (the original fixed formula). */
  private shadowDealAmountBase(r: FlyReading, T: number, good: GoodKind): string {
    const meta = GOOD_META[good];
    const priceUsdc = this.cfg.basePriceUsdc * (0.5 + T) * (0.6 + 0.6 * clamp01(r.arousal)) * meta.priceMult;
    return String(Math.max(1, Math.round(priceUsdc * 1e6)));
  }

  /** Shadow evolved deal amount: strategy tilt applied (mirrors dealAmount with strategyTilt). */
  private shadowDealAmountEvo(r: FlyReading, T: number, good: GoodKind, tick: number, stratTempR6: number): string {
    const meta = GOOD_META[good];
    const stratTilt = this.shadowStrategyTilt(r, tick, stratTempR6);
    const priceUsdc = this.cfg.basePriceUsdc * (0.5 + T) * (0.6 + 0.6 * clamp01(r.arousal)) * meta.priceMult;
    return String(Math.max(1, Math.round(priceUsdc * 1e6 * stratTilt)));
  }

  // ---------- ORGANIC CONFLICT (economic layer only; deterministic negative cross-house bonds) ----------
  // Four sources of genuine house-vs-house animosity, all reachable ON-CHAIN (where an insufficient-funds
  // betrayal structurally cannot fire, since the facilitator re-checks the real balance before signing). Each
  // writes a NEGATIVE directed bond between members of DIFFERENT houses via touchBond, so houseFeuds can
  // surface a real feud and war.ts's feudPairs can — once both vaults are funded — declare. NONE moves or
  // mints money; NONE touches the connectome/genome/manifestHash. Fully inert unless conflictOn().

  /** Deterministically pick one LIVING member id of a house (reborn-slot guarded), or null if none. */
  private conflictMember(houseId: number, salt: number): number | null {
    const h = this.houses.get(houseId);
    if (!h) return null;
    const live: number[] = [];
    for (const m of h.members) {
      if (this.dead.has(m)) continue;
      if (this.kin.get(m)?.house !== houseId) continue;   // reborn-slot guard (same law as houseRowFor)
      if (this.indexOfId.get(m) == null) continue;
      live.push(m);
    }
    if (live.length === 0) return null;
    live.sort((x, y) => x - y);
    return live[Math.floor(hash01(houseId, salt, 0x51ed270b) * live.length) % live.length];
  }

  /** Run all four conflict sources for this tick. Returns immediately (byte-for-byte) when the switch is off. */
  private applyConflict(tick: number, T: number, made: Settlement[], held: { buyer: number; shunned: number[] }[], cronBoundary: boolean): void {
    if (!this.conflictOn()) return;
    const c = this.cfg.conflict!;
    if (this.houses.size < 2) return;
    const rows = this.warHouses();
    if (rows.length < 2) return;
    this.conflictRivalry(tick, made, c);
    this.conflictEnvy(tick, T, rows, c);
    this.conflictEmbargo(tick, held, c);
    this.conflictRaid(tick, rows, c, cronBoundary);
  }

  /** RIVALRY: the two houses trading the same good most this tick compete for its demand and resent each other. */
  private conflictRivalry(tick: number, made: Settlement[], c: NonNullable<EconomyConfig["conflict"]>): void {
    if (c.rivalStep <= 0) return;
    const byGood = new Map<GoodKind, Map<number, { n: number; member: number }>>();
    for (const s of made) {
      if (!s.valid) continue;
      const house = this.kin.get(s.fromId)?.house;
      if (house == null) continue;
      let m = byGood.get(s.good);
      if (!m) { m = new Map(); byGood.set(s.good, m); }
      const cur = m.get(house);
      if (cur) cur.n++;
      else { const mem = this.conflictMember(house, tick); if (mem != null) m.set(house, { n: 1, member: mem }); }
    }
    for (const m of byGood.values()) {
      if (m.size < 2) continue;
      const top = Array.from(m.entries()).sort((x, y) => y[1].n - x[1].n || x[0] - y[0]).slice(0, 2);
      const [a, b] = top;
      if (!a || !b || a[0] === b[0]) continue;
      this.touchBond(a[1].member, b[1].member, -c.rivalStep, false, tick);
      this.touchBond(b[1].member, a[1].member, -c.rivalStep, false, tick);
    }
  }

  /** ENVY: in a HOT (zero-sum) market, houses behind the dominant one resent it. Sampled, not every hot tick. */
  private conflictEnvy(tick: number, T: number, rows: WarHouse[], c: NonNullable<EconomyConfig["conflict"]>): void {
    if (c.envyStep <= 0 || T < 0.6) return;
    if (hash01(tick, 0x35e3, 0x1e4a) >= 0.2) return;   // only ~1 in 5 hot ticks boils over
    const dom = rows.reduce((a, b) => (b.capitalShare > a.capitalShare ? b : a));
    const domMember = this.conflictMember(dom.id, tick);
    if (domMember == null) return;
    for (const h of rows) {
      if (h.id === dom.id) continue;
      const gap = Math.max(0, dom.capitalShare - h.capitalShare);
      const step = Math.min(c.envyStep, c.envyStep * (0.25 + gap * 10));
      const mem = this.conflictMember(h.id, tick);
      if (mem == null) continue;
      this.touchBond(mem, domMember, -step, false, tick);
    }
  }

  /** EMBARGO: a seller shunned by a buyer's grudge resents being cut off, feeding the grievance back. */
  private conflictEmbargo(tick: number, held: { buyer: number; shunned: number[] }[], c: NonNullable<EconomyConfig["conflict"]>): void {
    if (c.embargoStep <= 0) return;
    for (const h of held) {
      const buyerHouse = this.kin.get(h.buyer)?.house;
      if (buyerHouse == null) continue;
      const buyerMember = this.conflictMember(buyerHouse, tick) ?? h.buyer;
      const seen = new Set<number>();
      for (const sid of h.shunned) {
        const sellerHouse = this.kin.get(sid)?.house;
        if (sellerHouse == null || sellerHouse === buyerHouse || seen.has(sellerHouse)) continue;
        seen.add(sellerHouse);
        this.touchBond(sid, buyerMember, -c.embargoStep, false, tick);   // the shunned seller resents the embargo
      }
    }
  }

  /**
   * RAID: rarely, the strongest house preys on the weakest — a heavy social grudge (NO money moves in Phase 1).
   * Gated PER-CRON, not per sub-tick: the economy steps `ticksPerCron` (6) times per cron, so rolling the raid
   * hash on every sub-tick fired it ~6× too often (measured 191/day ⇒ the strongest↔weakest pair was pinned at a
   * permanent −1 feud within minutes). `cronBoundary` is true only on a cron's first sub-tick (state.ts passes
   * st===0); it defaults true so a direct step() — tests, replay — still rolls the raid once per call.
   */
  private conflictRaid(tick: number, rows: WarHouse[], c: NonNullable<EconomyConfig["conflict"]>, cronBoundary: boolean): void {
    if (!cronBoundary) return;
    if (c.raidStep <= 0 || hash01(tick, 0x0a1d, 0x5f3a) >= c.raidProb) return;
    const sorted = rows.slice().sort((a, b) => housePower(b) - housePower(a) || a.id - b.id);
    const raider = sorted[0];
    const victim = sorted[sorted.length - 1];
    if (!raider || !victim || raider.id === victim.id) return;
    const rm = this.conflictMember(raider.id, tick);
    const vm = this.conflictMember(victim.id, tick);
    if (rm == null || vm == null) return;
    this.touchBond(vm, rm, -c.raidStep, false, tick);   // the raided house holds the deep grudge
    this.bumpRep(rm, -0.05, tick);                      // raiding dents the raider's own name a little
  }

  /**
   * ⑧ THE COMMONS — apply this era's legislated credit line / interest for the coming steps. A PURE
   * PARAMETER OVERRIDE: it moves no money and touches no brain, only re-sizes the two knobs the credit
   * branch reads. Both null (law off, or no decree on a knob) ⇒ the base config ⇒ byte-for-byte today.
   */
  applyLaw(creditCapBaseUsdc: number | null, iouRatePer10: number | null): void {
    this.lawCreditCapBaseUsdc = creditCapBaseUsdc != null && Number.isFinite(creditCapBaseUsdc) ? creditCapBaseUsdc : null;
    this.lawIouRatePer10 = iouRatePer10 != null && Number.isFinite(iouRatePer10) ? iouRatePer10 : null;
  }

  /** Rebuild all four goods' books around the formula center for THIS tick (bounded 4×2 rungs each). */
  private buildBooks(readings: FlyReading[], T: number, tick: number): void {
    // A credit RUN doubles the panic factor on top of the swarm's own dispersion: the herd stampeding
    // to the exits widens every spread at once (books.build clamps the multiplier to ≥1).
    const boost = tick <= this.runUntilTick ? 2 : 1;
    for (const good of ["signal", "momentum", "attestation", "prediction"] as GoodKind[]) {
      const center = Math.max(1, Math.round(this.cfg.basePriceUsdc * (0.5 + T) * GOOD_META[good].priceMult * 1e6));
      this.books.build(good, center, readings, boost);
    }
  }

  /**
   * Update sticky professions from this tick's FAPs. Each fly keeps an exponentially-decayed tally of
   * recent faps (≈50-tick window) — the mode of that tally is its line of work. A fly KEEPS its trade;
   * changing takes PROF_SWITCH_TICKS of the new mode holding plus a deterministic coin-flip, so
   * professions are identities, not moods. Read by buyProbability/dealAmount (economy side ONLY). Off
   * ⇒ not even tallied: the OFF path stays byte-for-byte the pre-institutions economy.
   */
  private stepProfessions(readings: FlyReading[], tick: number): void {
    for (const r of readings) {
      const now = FAP_PROFESSION[r.fap];
      let t = this.profTally.get(r.id);
      if (!t) { t = { forager: 0, mooder: 0, trader: 0, brooder: 0 }; this.profTally.set(r.id, t); }
      for (const p of PROF_KEYS) t[p] = t[p] * PROF_WINDOW_DECAY;
      t[now] += 1;
      let mode = PROF_KEYS[0];
      for (const p of PROF_KEYS) if (t[p] > t[mode]) mode = p;   // fixed key order breaks ties deterministically
      const cur = this.profs.get(r.id);
      if (!cur) {
        this.profs.set(r.id, { role: mode, sinceTick: tick, streak: 0 });
        this.profCand.delete(r.id);
        continue;
      }
      if (cur.role === mode) {
        cur.streak++;
        this.profCand.delete(r.id);
        continue;
      }
      // Off-trade: the candidate must HOLD (hysteresis) and still win a coin-flip before the change.
      const cand = this.profCand.get(r.id);
      if (!cand || cand.prof !== mode) this.profCand.set(r.id, { prof: mode, streak: 1 });
      else if (cand.streak < PROF_SWITCH_TICKS) this.profCand.set(r.id, { prof: mode, streak: cand.streak + 1 });
      else if (hash01(tick, r.id, PROF_SALT) < PROF_SWITCH_PCT) {
        this.profs.set(r.id, { role: mode, sinceTick: tick, streak: 0 });
        this.profCand.delete(r.id);
      }
    }
  }

  /** Total live principal a fly owes (atomic string, "0" when debt-free). */
  private debtAtomicOf(id: number): string {
    let d = 0n;
    for (const iou of this.ious) if (iou.debtor === id) d += BigInt(iou.amountAtomic);
    return d.toString();
  }

  /**
   * A fly's credit line, or null when it is not trusted with tomorrow's money: only traders (whose
   * trade IS intermediation) and foragers (whose hunger repays) may borrow, never the disgraced,
   * and the line scales with reputation. Null ⇒ every failed payment stays a plain betrayal, as ever.
   */
  private creditCapAtomic(id: number): string | null {
    const role = this.profs.get(id)?.role;
    if (!role || !CREDIT_ROLES.includes(role)) return null;
    const rep = this.memOf(id).rep;
    if (rep < 0) return null;
    const base = (this.lawCreditCapBaseUsdc ?? this.cfg.institutions?.creditCapBaseUsdc ?? CREDIT_CAP_BASE_USDC) * 1e6;
    const cap = Math.round(base * (role === "trader" ? 2 : 1) * (1 + Math.min(2, rep)));
    return cap > 0 ? String(cap) : null;
  }

  /** Principal + accrued interest of one IOU at `tick` (simple per-10-tick rate, interest capped at 50%). */
  private owedAtomicOf(iou: IouRecord, tick: number): string {
    const p = BigInt(iou.amountAtomic);
    const periods = BigInt(Math.max(0, Math.floor((tick - iou.issuedTick) / 10)));
    const rateBps = BigInt(Math.max(0, Math.round(iou.ratePer10 * 10000)));
    let interest = (p * rateBps * periods) / 10000n;
    const cap = (p * BigInt(Math.round(IOU_INTEREST_CAP * 1000))) / 1000n;
    if (interest > cap) interest = cap;
    return (p + interest).toString();
  }

  /**
   * Issue a credit promise in place of a failed payment: the deal is NOT struck through the ledger
   * (nothing is paid yet — the no-minting law), the seller simply holds an enriched promise and the
   * buyer's debt grows. SIMULATED ONLY: on-chain the facilitator is the sole balance authority, so a
   * stiffed real payment stays a stiffed real payment. Bounded per-debtor and globally.
   */
  private tryIssueIou(debtorId: number, creditorId: number, amount: string, tick: number): boolean {
    if (this.facilitator.mode !== "simulated") return false;
    const cap = this.creditCapAtomic(debtorId);
    if (cap == null) return false;
    let mine = 0;
    let debt = 0n;
    for (const iou of this.ious) {
      if (iou.debtor === debtorId) { mine++; debt += BigInt(iou.amountAtomic); }
    }
    if (mine >= IOU_PER_DEBTOR || this.ious.length >= IOU_CAP) return false;
    if (BigInt(cap) <= 0n || debt + BigInt(amount) > BigInt(cap)) return false;
    this.ious.unshift({
      debtor: debtorId, creditor: creditorId, amountAtomic: amount,
      issuedTick: tick, ratePer10: this.lawIouRatePer10 ?? this.cfg.institutions?.iouRatePer10 ?? IOU_RATE_PER_10,
    });
    return true;
  }

  /** The creditor a fly owes the most to (ties: first found — array order is deterministic). */
  private largestCreditorOf(debtorId: number): number | null {
    let best: number | null = null;
    let bestAmt = 0n;
    for (const iou of this.ious) {
      if (iou.debtor !== debtorId) continue;
      const a = BigInt(iou.amountAtomic);
      if (best == null || a > bestAmt) { best = iou.creditor; bestAmt = a; }
    }
    return best;
  }

  /**
   * The credit cycle, once per sub-tick (INSTITUTIONS ON only, simulated ledger only):
   * ① RUN detection — dread plus overdue paper stampedes every creditor into a mass recall;
   * ② defaults settle first (old or over-line debts are force-collected from what's there);
   * ③ honest debtors sweep 30% of their balance to their largest creditor, and between RUNs one
   *   creditor per cron may recall the oldest note. Every movement is a real ledger transfer on the
   *   same rails as a trade — a repayment is money CHANGING HANDS, never money appearing.
   */
  private creditCycle(tick: number, readings: FlyReading[]): Settlement[] {
    const out: Settlement[] = [];
    if (!this.ious.length) return out;

    // ① RUN: the swarm is uniformly miserable AND a fat share of paper is overdue → stampede.
    let overdue = 0;
    for (const iou of this.ious) if (tick - iou.issuedTick > IOU_OVERDUE_TICKS) overdue++;
    if (readings.length) {
      const avgV = readings.reduce((s, r) => s + r.valence, 0) / readings.length;
      if (avgV < RUN_AVG_VALENCE && overdue / this.ious.length > RUN_BAD_PCT) {
        this.runUntilTick = tick + RUN_HOLD_TICKS;
      }
    }

    // ② Defaults first: aged-out or over-line debtors pay whatever their wallet actually holds.
    for (const iou of [...this.ious]) {
      const age = tick - iou.issuedTick;
      const owed = this.owedAtomicOf(iou, tick);
      const cap = this.creditCapAtomic(iou.debtor);
      const overLine = cap != null && BigInt(this.debtAtomicOf(iou.debtor)) > BigInt(cap);
      if (age <= IOU_MAX_AGE && !overLine) continue;
      this.ious = this.ious.filter((x) => x !== iou);
      const dIdx = this.indexOfId.get(iou.debtor);
      const cIdx = this.indexOfId.get(iou.creditor);
      if (dIdx == null || cIdx == null) continue;
      const debtor = this.agents[dIdx];
      const creditor = this.agents[cIdx];
      const seized = (BigInt(debtor.balance) < BigInt(owed) ? BigInt(debtor.balance) : BigInt(owed)).toString();
      if (BigInt(seized) > 0n) this.moveDebtMoney(debtor, creditor, seized, tick, out);
      // The whole episode — seizure plus the written-off remainder — is a betrayal: the grudge book will
      // tell FEUDS about it, and rememberBetrayal carries the heavy reputation hit (no trade credit here).
      this.rememberBetrayal(iou.debtor, iou.creditor, owed, tick, "debt-default");
    }
    if (!this.ious.length) return out;

    const running = tick <= this.runUntilTick;
    let payments = 0;

    // ③ Mass recall during a RUN: every debtor pays its largest creditor all it can, now.
    if (running) {
      for (const debtor of this.agents) {
        if (this.dead.has(debtor.id)) continue;
        const creditorId = this.largestCreditorOf(debtor.id);
        if (creditorId == null) continue;
        if (!this.payCreditor(debtor, creditorId, BigInt(debtor.balance), tick, out)) payments++;
      }
      return out;
    }

    // ④ Peace-time: one recall per cron (oldest note), plus every debtor's quiet 30% sweep.
    const oldest = this.ious[this.ious.length - 1];
    if (oldest && tick - this.lastRecallTick >= RECALL_GAP_TICKS) {
      const dIdx = this.indexOfId.get(oldest.debtor);
      if (dIdx != null) {
        const want = BigInt(this.owedAtomicOf(oldest, tick));
        if (this.payCreditor(this.agents[dIdx], oldest.creditor, want, tick, out)) this.lastRecallTick = tick;
      }
    }
    for (const debtor of this.agents) {
      if (payments >= CREDIT_MAX_PAYS_PER_TICK) break;
      if (this.dead.has(debtor.id)) continue;
      const creditorId = this.largestCreditorOf(debtor.id);
      if (creditorId == null) continue;
      const sweep = (BigInt(debtor.balance) * BigInt(Math.round(DEBT_SWEEP_PCT * 1000))) / 1000n;
      const owed = BigInt(this.owedAtomicTo(debtor.id, creditorId, tick));
      const want = sweep < owed ? sweep : owed;
      if (want > 0n && this.payCreditor(debtor, creditorId, want, tick, out)) payments++;
    }
    return out;
  }

  /** What `debtor` owes `creditorId` (principal+interest) at `tick`, summed over their live notes. */
  private owedAtomicTo(debtorId: number, creditorId: number, tick: number): string {
    let sum = 0n;
    for (const iou of this.ious) {
      if (iou.debtor === debtorId && iou.creditor === creditorId) sum += BigInt(this.owedAtomicOf(iou, tick));
    }
    return sum.toString();
  }

  /**
   * Move up to `want` atomic from debtor to creditor (never more than the wallet holds, never more
   * than is owed), applying the payment oldest-note-first. Returns true if any money moved. The
   * ledger lines are EXACTLY a settlement's (balance/paid/earned + house tithe + recent tape) —
   * a repayment is indistinguishable from a trade in the money's eyes, which is the point.
   */
  private payCreditor(debtor: AgentState, creditorId: number, want: bigint, tick: number, out: Settlement[]): boolean {
    // Cap at what is ACTUALLY owed to this creditor: a RUN hands over the whole balance, but a debtor
    // never pays more than its debt (the surplus would be a gift, breaking the promises-are-not-gifts law).
    const owed = BigInt(this.owedAtomicTo(debtor.id, creditorId, tick));
    const due = want < owed ? want : owed;
    const avail = BigInt(debtor.balance);
    const pay = due < avail ? due : avail;
    if (pay <= 0n) return false;
    const cIdx = this.indexOfId.get(creditorId);
    if (cIdx == null) return false;
    const amount = pay.toString();
    this.applyRepayment(debtor.id, creditorId, pay, tick);
    this.moveDebtMoney(debtor, this.agents[cIdx], amount, tick, out);
    return true;
  }

  /** The actual two-sided ledger movement of a debt payment (shared by repayment and default seizure). */
  private moveDebtMoney(debtor: AgentState, creditor: AgentState, amount: string, tick: number, out: Settlement[]): void {
    const resource = `debt:${creditor.id}`;
    debtor.balance = subAtomic(debtor.balance, amount);
    debtor.paid = addAtomic(debtor.paid, amount);
    debtor.lastTick = tick;
    creditor.balance = addAtomic(creditor.balance, amount);
    creditor.earned = addAtomic(creditor.earned, amount);
    creditor.lastTick = tick;
    const rec: Settlement = {
      tick, ts: Date.now(), good: "attestation", resource,
      fromId: debtor.id, toId: creditor.id, from: debtor.address, to: creditor.address,
      amount, txHash: pseudoTxHash(debtor.address, creditor.address, amount, resource),
      valid: true, simulated: true,
    };
    this.recent.unshift(rec);
    if (this.recent.length > RECENT_CAP) this.recent.length = RECENT_CAP;
    this.volumeAtomic = addAtomic(this.volumeAtomic, amount);
    this.count++;
    this.titheHouse(creditor.id, amount);
    out.push(rec);
  }

  /** Burn `pay` of `debtor`'s debt to `creditor`, oldest notes first (full cancel drops the note). */
  private applyRepayment(debtorId: number, creditorId: number, pay: bigint, tick: number): void {
    let left = pay;
    // Oldest = tail of the array (new IOUs unshift to the head). Interest accrues per note.
    for (let k = this.ious.length - 1; k >= 0 && left > 0n; k--) {
      const iou = this.ious[k];
      if (iou.debtor !== debtorId || iou.creditor !== creditorId) continue;
      const owed = BigInt(this.owedAtomicOf(iou, tick));
      if (left >= owed) {
        left -= owed;
        this.ious.splice(k, 1);
      } else {
        // Partial: settle accrued INTEREST off first, then shave the note's PRINCIPAL. amountAtomic MUST
        // stay a pure principal: folding the interest in (the old `owed - left`) let owedAtomicOf charge
        // interest on the rolled-in interest (compounding) and inflated debtAtomicOf — which the credit
        // cap and the over-line DEFAULT check both read — so a half-paid fly could be pushed into default
        // by phantom principal. The ORIGINAL issue date still stands, so a half-paid overdue note is still
        // overdue (re-basing it would let the storm be dodged by crumbs).
        const principal = BigInt(iou.amountAtomic);
        const accrued = owed - principal;                       // owed = principal + interest at this tick
        const coverInterest = left < accrued ? left : accrued;
        const coverPrincipal = left - coverInterest;            // < principal (left < owed) ⇒ stays positive
        iou.amountAtomic = (principal - coverPrincipal).toString();
        left = 0n;
      }
    }
  }

  /** Mark tapes + this tick's book views for the snapshot/chronicle/frontend (pure read-out, null when off). */
  marketSnapshot(): { books: GoodBookView[]; marks: Record<string, string[]> } | null {
    if (!this.institutionsOn()) return null;
    const marks: Record<string, string[]> = {};
    for (const good of ["signal", "momentum", "attestation", "prediction"] as GoodKind[]) {
      marks[good] = this.books.marksOf(good);
    }
    return { books: this.books.views(), marks };
  }

  /**
   * The institutions read-out: who does what, who owes whom, and what the tape says. Classes are
   * COUNTED off balances/notes/flows, never assigned — a read-out of the market, not a census law.
   * (The historian and the frontend draw on this; nothing here feeds back into behaviour.)
   */
  private marketReadout(): MarketReadout | null {
    const snap = this.marketSnapshot();
    if (!snap) return null;
    const professions: Record<Profession, number> = { forager: 0, mooder: 0, trader: 0, brooder: 0 };
    for (const p of this.profs.values()) professions[p.role]++;
    const creditors = new Set<number>();
    const debtors = new Set<number>();
    let debt = 0n;
    let overdue = 0;
    const debtByDebtor = new Map<number, bigint>();
    let topIou: { debtor: number; creditor: number; amountUsdc: number } | null = null;
    let topAtomic = 0n;
    for (const iou of this.ious) {
      creditors.add(iou.creditor);
      debtors.add(iou.debtor);
      const amt = BigInt(iou.amountAtomic);
      debt += amt;
      debtByDebtor.set(iou.debtor, (debtByDebtor.get(iou.debtor) ?? 0n) + amt);
      if (amt > topAtomic) {
        topAtomic = amt;
        topIou = { debtor: iou.debtor, creditor: iou.creditor, amountUsdc: Number(amt) / 1e6 };
      }
      if (this.tickIndex - iou.issuedTick > IOU_OVERDUE_TICKS) overdue++;
    }
    let producers = 0;
    for (const a of this.agents) {
      if (this.dead.has(a.id)) continue;
      if (BigInt(a.earned) > BigInt(a.paid) && BigInt(a.earned) > 0n) producers++;
    }
    // Speculators: of the flies active in the recent window, those whose flows were mostly prediction
    // payouts (the herd that bets the tape instead of making it).
    const spend = new Map<number, { all: number; predict: number }>();
    for (const s of this.recent) {
      if (!s.valid) continue;
      const e = spend.get(s.fromId) ?? { all: 0, predict: 0 };
      e.all++;
      if (s.good === "prediction") e.predict++;
      spend.set(s.fromId, e);
    }
    let speculators = 0;
    for (const e of spend.values()) if (e.all >= 4 && e.predict * 2 > e.all) speculators++;
    // Net-worth read-out for the CLASS chronicle: balance − outstanding principal, the creditors' share of
    // the swarm's POSITIVE net worth. Counted off the ledger, never assigned — a read-out, nothing feeds back.
    let totalNet = 0n;
    let creditorNet = 0n;
    for (const a of this.agents) {
      if (this.dead.has(a.id)) continue;
      const net = BigInt(a.balance) - (debtByDebtor.get(a.id) ?? 0n);
      if (net > 0n) { totalNet += net; if (creditors.has(a.id)) creditorNet += net; }
    }
    const creditorNetShare = totalNet > 0n ? Number(creditorNet) / Number(totalNet) : 0;
    return {
      professions,
      classes: { creditors: creditors.size, debtors: debtors.size, producers, speculators },
      openIous: this.ious.length,
      debtAtomic: debt.toString(),
      badRate: this.ious.length ? overdue / this.ious.length : 0,
      run: this.tickIndex <= this.runUntilTick,
      topIou,
      creditorNetShare,
      marks: snap.marks,
      books: snap.books,
    };
  }

  // ---------- dynasty: houses, death, inheritance (economic layer only; the neurons never notice) ----------

  /** Resolved dynasty config, or null when the layer is off (absent block or enabled:false ⇒ fully inert). */
  private dcfg(): {
    tithePct: number; oldAgeTicks: number; penuryGraceTicks: number;
    plagueTemp: number; plaguePct: number; maxHouses: number;
  } | null {
    const raw = this.cfg.dynasty;
    if (!raw || raw.enabled === false) return null;
    return {
      tithePct: raw.tithePct ?? HOUSE_TITHE,
      oldAgeTicks: raw.oldAgeTicks ?? OLD_AGE_DEFAULT,
      penuryGraceTicks: raw.penuryGraceTicks ?? PENURY_GRACE_DEFAULT,
      plagueTemp: raw.plagueTemp ?? PLAGUE_TEMP,
      plaguePct: raw.plaguePct ?? PLAGUE_PCT,
      maxHouses: raw.maxHouses ?? HOUSE_CAP,
    };
  }

  /** Resolved territory config, or null when the layer is off (absent block or enabled:false ⇒ fully inert). */
  private tcfg(): {
    zoneCount: number; tollPct: number; homeDiscountPct: number;
    tributePct: number; exileSeverity: number; powerPerZone: number;
  } | null {
    const raw = this.cfg.territory;
    if (!raw || raw.enabled !== true) return null;
    return {
      zoneCount: Math.max(1, Math.round(raw.zoneCount ?? HOUSE_CAP)),
      tollPct: raw.tollPct ?? TERR_TOLL_PCT,
      homeDiscountPct: raw.homeDiscountPct ?? TERR_HOME_DISCOUNT_PCT,
      tributePct: raw.tributePct ?? TERR_TRIBUTE_PCT,
      exileSeverity: raw.exileSeverity ?? TERR_EXILE_SEVERITY,
      powerPerZone: raw.powerPerZone ?? TERR_POWER_PER_ZONE,
    };
  }

  // ---------- TERRITORY & CONQUEST (economic layer only; a fixed zone grid the neurons never see) ----------

  /**
   * Deterministically claim a home zone for a house on the fixed grid: probe from a seed-derived start,
   * wrapping, for the first zone nobody controls yet. With zoneCount == HOUSE_CAP every house gets a unique
   * home; only if the grid is somehow full (zoneCount < houses) does it fall back to the seed's own slot.
   */
  private pickFreeZone(seed: number, zoneCount: number): number {
    const start = (((seed >>> 0) % zoneCount) + zoneCount) % zoneCount;
    for (let k = 0; k < zoneCount; k++) {
      const z = (start + k) % zoneCount;
      if (!this.zoneControl.has(z)) return z;
    }
    return start;
  }

  /**
   * Arm the grid for every house that predates the territory layer: assign each home-less house its
   * deterministic seed zone (by ascending id, so the assignment is reproducible) and record its control.
   * Idempotent — once a house has a homeZone it is never reassigned, and a zone already controlled (e.g.
   * seized) is never overwritten, so a conquered house stays landless across restarts. Called once per step.
   */
  private ensureTerritory(): void {
    const t = this.tcfg();
    if (!t) return;
    for (const h of Array.from(this.houses.values()).sort((a, b) => a.id - b.id)) {
      if (h.homeZone == null || !Number.isFinite(h.homeZone)) {
        const z = this.pickFreeZone(this.houseSeed(h.id), t.zoneCount);
        h.homeZone = z;
        if (!this.zoneControl.has(z)) this.zoneControl.set(z, h.id);
      } else if (!this.zoneControl.has(h.homeZone)) {
        // homeZone known but its control was never recorded (a partial/old payload): the house holds its own.
        this.zoneControl.set(h.homeZone, h.id);
      }
    }
  }

  /** The zone a fly physically sits in — its house's home zone — or null for a commoner/houseless fly. This
   *  is a LOCATION, not a claim: a conquered house's members still sit in their (now-occupied) home zone. */
  private zoneOf(flyId: number): number | null {
    const houseId = this.kin.get(flyId)?.house;
    if (houseId == null) return null;
    const h = this.houses.get(houseId);
    if (!h || h.homeZone == null || !Number.isFinite(h.homeZone)) return null;
    return h.homeZone;
  }

  /** Whether a house still controls AT LEAST one zone (false ⇒ exiled/landless: it pays toll everywhere). */
  private houseControlsAnyZone(houseId: number): boolean {
    for (const ctrl of this.zoneControl.values()) if (ctrl === houseId) return true;
    return false;
  }

  /** The sorted list of zones a house currently controls (its home plus any it has seized). */
  private zonesControlledBy(houseId: number): number[] {
    const zs: number[] = [];
    for (const [z, ctrl] of this.zoneControl.entries()) if (ctrl === houseId) zs.push(z);
    return zs.sort((a, b) => a - b);
  }

  /**
   * TERRITORY pricing — the economic side of the one-way street, applied AFTER the neurons picked the deal.
   * Re-prices one amount for a buyer→seller trade and returns the new atomic amount used for BOTH the buyer's
   * debit and the seller's credit (so the deal itself stays conservative; no money is minted in the transfer):
   *   • layer off / a commoner on either side ⇒ returned UNCHANGED (byte-for-byte passthrough);
   *   • DOMESTIC (the buyer's house controls the seller's zone) ⇒ × (1 − homeDiscountPct);
   *   • FOREIGN (anyone else's zone) ⇒ × (1 + tollPct), the toll amplified by exileSeverity when the buyer's
   *     house is landless (conquered). A slice of the toll (toll × tributePct) is accrued to the treasury of
   *     whoever CONTROLS the seller's zone — the occupier's tribute. house.treasury is a pure scoreboard (never
   *     spent as real USDC: only read for capitalShare/read-out and fed by conserved tithes and estates), so
   *     this bounded additive accrual mirrors the tithe's treasury pattern and can never move real money.
   */
  private applyTerritory(amountAtomic: string, buyerId: number, sellerId: number): string {
    const t = this.tcfg();
    if (!t) return amountAtomic;
    let gross: bigint;
    try { gross = BigInt(amountAtomic); } catch { return amountAtomic; }
    if (gross <= 0n) return amountAtomic;
    const zb = this.zoneOf(buyerId);
    const zs = this.zoneOf(sellerId);
    if (zb == null || zs == null) return amountAtomic;   // a commoner trades outside the territorial system
    const buyerHouse = this.kin.get(buyerId)?.house;
    const controller = this.zoneControl.get(zs);
    // DOMESTIC: the buyer's own house controls the zone the deal happens in (its home, or a zone it seized).
    if (buyerHouse != null && controller === buyerHouse) {
      const disc = (gross * BigInt(Math.round(t.homeDiscountPct * 1000))) / 1000n;
      return (gross - disc).toString();
    }
    // FOREIGN: the buyer reaches into someone else's zone. A landless (exiled) buyer pays an amplified toll.
    const exiled = buyerHouse != null && !this.houseControlsAnyZone(buyerHouse);
    const tollPct = t.tollPct * (exiled ? 1 + t.exileSeverity : 1);
    const toll = (gross * BigInt(Math.round(tollPct * 1000))) / 1000n;
    if (toll > 0n && controller != null) {
      const ctrlHouse = this.houses.get(controller);
      const tribute = (toll * BigInt(Math.round(t.tributePct * 1000))) / 1000n;
      if (ctrlHouse && tribute > 0n) ctrlHouse.treasury = addAtomic(ctrlHouse.treasury, tribute.toString());
    }
    return (gross + toll).toString();
  }

  /** Fetch (creating on first sight — a genesis fly is "born" when the economy first met it) a kin record. */
  private kinOf(id: number): KinRecord {
    let k = this.kin.get(id);
    if (!k) { k = { bornTick: this.tickIndex, house: null, children: [], gen: 0 }; this.kin.set(id, k); }
    return k;
  }

  /**
   * Reclaim a RETIRED slot for a NEW individual (live-retirement id reuse). Called by noteHatch when a
   * hatch lands on an id that had previously died. This:
   *   · clears the tombstone (`dead.delete`) so the wallet is live again and the treasury may top it up;
   *   · resets the wallet to a fresh newborn at `openingUsdc` (its parent-funded bootstrap) — the reused
   *     HD address keeps the SAME on-chain purse, but every lifetime counter starts clean;
   *   · SEVERS the id from its previous life (removed from every house roster + every parent's child list),
   *     then resets its own kin record — so the (id, bornTick) individual is ledger-isolated from the dead
   *     fly that once bore this id;
   *   · M4 fix: ERASES the dead fly's social memory, playbook ring, strategy tree and goodCounts so the
   *     reborn individual never inherits a stranger's bonds/grudges/episodic memory/GP tree. This runs
   *     UNCONDITIONALLY (regardless of CULTURAL_ENABLED), preserving dark-deployment byte-equivalence:
   *     transmitCulture's own erasure becomes a harmless no-op on the reused-slot path.
   */
  reopenSlot(id: number, openingUsdc: number): void {
    const opening = usdcToAtomic(openingUsdc);
    const idx = this.indexOfId.get(id);
    if (idx == null) {
      this.agents.push({ id, address: this.addressOf(id), balance: opening, paid: "0", earned: "0", deals: 0, sales: 0, lastTick: -1 });
      this.indexOfId.set(id, this.agents.length - 1);
    } else {
      const a = this.agents[idx];
      a.address = this.addressOf(id);   // same HD path ⇒ the same on-chain wallet (a reborn purse, not new funds)
      a.balance = opening; a.paid = "0"; a.earned = "0"; a.deals = 0; a.sales = 0; a.lastTick = -1;
      a.settleFail = 0;
    }
    this.dead.delete(id);
    for (const h of this.houses.values()) {
      const mi = h.members.indexOf(id);
      if (mi >= 0) h.members.splice(mi, 1);
    }
    for (const k of this.kin.values()) {
      const ci = k.children.indexOf(id);
      if (ci >= 0) k.children.splice(ci, 1);
    }
    this.kin.set(id, { bornTick: this.tickIndex, house: null, children: [], gen: 0 });
    // M4: unconditional id-reuse hygiene — erase the dead fly's residue so the reborn individual starts clean.
    this.social.delete(id);
    this.playbook.delete(id);
    this.strategyTrees.delete(id);
    this.goodCounts.delete(id);
  }

  /**
   * Deterministic house seed: the offspring's genome hash IS the bloodline — its first 16 hex folds into a
   * 32-bit seed alongside the founder id and the protocol seedBase, so the same lineage always bears the
   * same name and sigil (verifiable by re-hashing the genome; no RNG, no table). Fallback without a hash:
   * FNV over (seedBase, parentId) — still reproducible across restarts.
   */
  private houseSeed(parentId: number, genomeHash?: string): number {
    if (genomeHash && /^[0-9a-f]{16,}$/i.test(genomeHash)) {
      const hi = parseInt(genomeHash.slice(0, 8), 16) >>> 0;
      const lo = parseInt(genomeHash.slice(8, 16), 16) >>> 0;
      return (hi ^ lo ^ this.cfg.seedBase ^ (parentId >>> 0)) >>> 0;
    }
    return hash32(this.cfg.seedBase, parentId, 0x11ad);
  }

  /**
   * A hatched offspring enters the dynasty: it takes its parent's house name + sigil, or — when the parent
   * is nameless and the house roll has room — the parent FOUNDS a house on this birth (the founding parent
   * keeps its own id as the house id, the hatch is the first heir). Returns the house touched, or null when
   * the layer is off or the founder kept commoner status (house roll full). Called by state.ts right after
   * a hatch went live — purely ledger-side, it can never affect the hatch itself.
   */
  noteHatch(parentId: number, childId: number, genomeHash?: string, fapSeed?: string):
    { houseId: number; name: string; sigil: string; childId: number; founded: boolean } | null {
    const d = this.dcfg();
    if (!d) return null;
    // ID-REUSE (live-retirement): this slot may be a retired fly's vacated id being recolonised by a new
    // birth. Reopen it FIRST — clear its tombstone, reset its wallet to a fresh newborn, sever it from
    // its PREVIOUS house/children, and ERASE its social/playbook/strategy/goodCounts residue (M4 fix) —
    // so the reborn individual is fully clean before it is born into the NEW parent's line below.
    // A brand-new offspring id was never dead, so this is a no-op on the normal path.
    // Phase 3 capability ③: capture the reuse flag BEFORE reopenSlot lifts the tombstone. transmitCulture
    // below re-seeds the child ONLY from `parentId` (the真亲) when CULTURAL is ON; when OFF, reopenSlot's
    // unconditional erasure already guarantees no double-inheritance of a dead fly's memory.
    const reusedSlot = this.dead.has(childId);
    if (reusedSlot) this.reopenSlot(childId, this.cfg.hatchSeedUsdc);
    const parent = this.kinOf(parentId);
    const child = this.kinOf(childId);
    child.bornTick = this.tickIndex;
    child.gen = parent.gen + 1;
    if (parent.children.length < CHILD_CAP) parent.children.push(childId);
    // Phase 3 capability ③: vertical cultural transmission (+ vertical strategy-tree inheritance when the
    // strategy layer is armed). Gated by culturalOn() ⇒ byte-for-byte inert (the Phase 2b path) while OFF.
    this.transmitCulture(parentId, childId, reusedSlot);
    // Inheritance first: the child is born into the name the parent already bears.
    const inherited = parent.house != null ? this.houses.get(parent.house) : undefined;
    if (inherited) {
      if (!inherited.members.includes(childId) && inherited.members.length < HOUSE_MEMBERS_CAP) {
        inherited.members.push(childId);
      }
      if (child.gen > inherited.gen) inherited.gen = child.gen;
      child.house = inherited.id;
      return { houseId: inherited.id, name: inherited.name, sigil: inherited.sigil, childId, founded: false };
    }
    if (this.houses.size >= d.maxHouses) return null;   // house roll full: the child is born a commoner
    const seed = this.houseSeed(parentId, genomeHash);
    // TERRITORY: grant the new house a fixed home zone and claim it on the grid (additive — the homeZone key
    // is absent while the layer is off, so a pre-territory house record round-trips byte-identically).
    const tc = this.tcfg();
    const homeZone = tc ? this.pickFreeZone(seed, tc.zoneCount) : null;
    const house: HouseRecord = {
      id: parentId,
      name: HOUSE_COLORS[seed % HOUSE_COLORS.length],
      sigil: HOUSE_SIGILS[(seed >>> 4) % HOUSE_SIGILS.length],
      foundedTick: this.tickIndex,
      firstHeir: childId,
      treasury: "0",
      earnedAtomic: "0",
      members: [parentId, childId],
      gen: child.gen,
      // culture: the founder's creed AT FOUNDING becomes the house tradition — the Lamarckian old
      // way the descendants may hold against later fashions. Validated FAP name or absent.
      ...(fapSeed && /^[A-Z]{2,12}$/.test(fapSeed) ? { tradition: fapSeed } : {}),
      ...(homeZone != null ? { homeZone } : {}),
    };
    this.houses.set(house.id, house);
    // Claim the home zone ONLY if it is still free (mirrors ensureTerritory). With zoneCount == HOUSE_CAP a free
    // zone always exists, so every house controls its own home; only if the grid is somehow full does a later
    // house keep a homeZone it does NOT control — i.e. it is born landless/exiled, exactly the state a conquest
    // produces, and never an eviction of the incumbent.
    if (homeZone != null && !this.zoneControl.has(homeZone)) this.zoneControl.set(homeZone, house.id);
    parent.house = house.id;
    child.house = house.id;
    return { houseId: house.id, name: house.name, sigil: house.sigil, childId, founded: true };
  }

  /**
   * Phase 3 capability ③ — VERTICAL CULTURAL TRANSMISSION at a真亲子 hatch. Inert (returns immediately) unless
   * culturalOn(), so the OFF path is byte-for-byte the Phase 2b build. The child is seeded ONLY from `parentId`
   * (the true parent that bred it), NEVER from whatever dead fly once held `childId`:
   *   ① WIPE the child slot's residual social memory, playbook ring and strategy tree first — the DOUBLE-
   *      INHERITANCE guard, kept here as defence in depth. Since the M4 fix, reopenSlot already performs this
   *      erasure UNCONDITIONALLY on an id-reuse hatch (independent of culturalOn()), so on a RECYCLED id this
   *      block is a harmless no-op and on a brand-new id the maps are empty anyway. It stays so the guard holds
   *      even if a caller ever reaches transmitCulture without going through reopenSlot.
   *   ② Copy a DISCOUNTED subset of the parent's social memory as the child's prior: a POSITIVE bond ×50%, a
   *      NEGATIVE bond ×25% (a fainter inherited grudge), and the parent's reputation ×50%. Every inherited score
   *      is decayed to now, re-clamped to [−1,1] and pruned to BOND_TOP_K, so the prior can never exceed the
   *      parent's own lived memory and never grows DO storage.
   *   ③ Inject a COMPRESSED playbook summary (per (good,regime) mean outcome + valid rate) as the child's starting
   *      ring — NOT a verbatim copy — bounded to PLAYBOOK_CAP. Only while the playbook layer is itself armed
   *      (otherwise rings are neither recorded nor persisted, so injecting would be inert anyway).
   *   ④ When the STRATEGY layer is armed, seed the child's GP tree by deterministically MUTATING the parent's live
   *      tree (vertical strategy inheritance); with no parent tree the child falls back to the id-derived default
   *      on first access. Deterministic throughout: every seed is hash-derived (FNV-1a); zero Math.random/Date.now.
   */
  private transmitCulture(parentId: number, childId: number, _reusedSlot: boolean): void {
    if (!this.culturalOn()) return;
    if (parentId === childId) return;   // a fly is never its own parent — nothing to transmit
    // ① WIPE the child slot's residue (the double-inheritance guard). Redundant since the M4 fix — reopenSlot
    // already erased it unconditionally — but kept as defence in depth. A safe no-op on a fresh id.
    this.social.delete(childId);
    this.playbook.delete(childId);
    this.strategyTrees.delete(childId);
    // ② Discounted social-memory prior from the TRUE parent.
    const pm = this.social.get(parentId);
    const tick = this.tickIndex;
    if (pm) {
      const cm = this.memOf(childId);
      cm.rep = AgentEconomy.clampSigned(pm.rep * CULTURAL_REP_SHARE);
      cm.repTick = pm.repTick;   // the inherited name ages on the parent's clock (fades like any memory)
      for (const b of pm.bonds) {
        if (b.other === childId) continue;   // never inherit a bond pointing at yourself
        const live = AgentEconomy.clampSigned(AgentEconomy.fadeBond(b.score, b.lastTick, tick));
        const share = live >= 0 ? CULTURAL_BOND_POS_SHARE : CULTURAL_BOND_NEG_SHARE;
        cm.bonds.push({ other: b.other, score: AgentEconomy.clampSigned(live * share), trades: 0, lastTick: tick });
      }
      if (cm.bonds.length > BOND_TOP_K) {
        cm.bonds.sort((x, y) => Math.abs(y.score) - Math.abs(x.score) || y.trades - x.trades || x.other - y.other);
        cm.bonds.length = BOND_TOP_K;
      }
    }
    // ③ Compressed playbook prior (only while the playbook layer records/persists rings).
    if (this.playbookOn()) {
      const summary = this.compressPlaybook(parentId, childId);
      if (summary.length > 0) this.playbook.set(childId, summary);
    }
    // ④ Vertical strategy-tree inheritance (only while the strategy layer is armed).
    if (this.strategyOn()) {
      const pTree = this.strategyTrees.get(parentId) ?? this.strategyTreeOf(parentId) ?? undefined;
      if (pTree) {
        const seed = hash32(parentId, childId, CULTURAL_SALT_TREE);
        const childTree = mutateTree(pTree, seed, this.tickIndex);
        if (isLegalTree(childTree)) this.strategyTrees.set(childId, childTree);
      }
    }
  }

  /**
   * Compress the parent's playbook ring into a bounded prior for the child: aggregate by (good, regime) into at
   * most 4×3 = 12 buckets (≤ PLAYBOOK_CAP), each summarised as the MEAN signed outcome (discounted by
   * CULTURAL_PB_OUTCOME_SHARE) + the bucket's valid rate. Deterministic: buckets are emitted in fixed
   * (good asc, regime asc) order, so no sort is needed on the normal path; if the cap were ever exceeded the
   * strongest |mean| win, ties broken by a hash01 draw — never by iteration luck. A summary, not a copy, so the
   * child's ring stays ≤ PLAYBOOK_CAP and DO storage never grows beyond the Phase 1 per-fly budget.
   */
  private compressPlaybook(parentId: number, childId: number): PlaybookEntry[] {
    const ring = this.playbook.get(parentId);
    if (!ring || ring.length === 0) return [];
    const netSum = new Map<number, number>();
    const cnt = new Map<number, number>();
    const validSum = new Map<number, number>();
    for (const e of ring) {
      const key = e.good * REGIME_COUNT + e.regime;
      netSum.set(key, (netSum.get(key) ?? 0) + e.outcome);
      cnt.set(key, (cnt.get(key) ?? 0) + 1);
      validSum.set(key, (validSum.get(key) ?? 0) + (e.valid ? 1 : 0));
    }
    const bornTick = this.kin.get(childId)?.bornTick ?? this.tickIndex;
    const out: PlaybookEntry[] = [];
    for (let good = 0; good < GOOD_KIND_COUNT; good++) {
      for (let regime = 0; regime < REGIME_COUNT; regime++) {
        const key = good * REGIME_COUNT + regime;
        const n = cnt.get(key) ?? 0;
        if (n <= 0) continue;
        const mean = (netSum.get(key) ?? 0) / n;
        const validRate = (validSum.get(key) ?? 0) / n;
        out.push({
          ctx: hash32(good, regime, CULTURAL_SALT_PB),
          action: 0,
          good,
          regime,
          outcome: Math.round(mean * CULTURAL_PB_OUTCOME_SHARE),
          valid: validRate >= 0.5 ? 1 : 0,
          tick: bornTick,
        });
      }
    }
    // 4×3 = 12 ≤ PLAYBOOK_CAP(16): the cap can never bind, but guard anyway with a deterministic strongest-first cut.
    if (out.length > PLAYBOOK_CAP) {
      out.sort((a, b) => Math.abs(b.outcome) - Math.abs(a.outcome)
        || hash01(b.good, b.regime, CULTURAL_SALT_PB) - hash01(a.good, a.regime, CULTURAL_SALT_PB)
        || a.good - b.good || a.regime - b.regime);
      out.length = PLAYBOOK_CAP;
    }
    return out;
  }

  /**
   * Phase 3 capability ③ — LAMARCKIAN genome imprint vector. Derives a bounded, deterministic signed vector in
   * [−1,1]^4 from the PARENT's lifetime economic performance; breed.ts applies it as a ±5% multiplicative bias on
   * the child's 4 heritable genome scalars (weightGain/threshGain/tauGain/weightJitter) ON TOP of mutate/cross,
   * then clamps back into legal bounds and folds the result into genomeHash. Returns null when lamarckOn() is
   * false (the child genome is then exactly the mutate/cross output). The economy ONLY computes this vector — it
   * never writes the genome itself, so the one-way law holds and manifestHash never rotates (only scalar VALUES
   * change downstream). Signals (all integer-derived, quantised to r6; no transcendental, no Math.random/Date.now):
   *   · weightGain   ← soft-signed lifetime net P&L (a profitable parent begets a slightly more sensitive child);
   *   · threshGain   ← best regime (a COLD-market specialist begets a calmer, higher-threshold child);
   *   · tauGain      ← settlement reliability (valid rate): a dependable parent begets a slower-integrating child;
   *   · weightJitter ← good-diversity (distinct goods traded): a generalist begets more exploratory jitter.
   */
  lamarckVector(parentId: number, _tick: number):
    { weightGain: number; threshGain: number; tauGain: number; weightJitter: number } | null {
    if (!this.lamarckOn()) return null;
    const ring = this.playbook.get(parentId);
    const gc = this.goodCounts.get(parentId) ?? [0, 0, 0, 0];
    const regimeNet = [0, 0, 0];
    let totalNet = 0, validN = 0, totalN = 0;
    if (ring) {
      for (const e of ring) {
        totalNet += e.outcome;
        if (e.regime >= 0 && e.regime < REGIME_COUNT) regimeNet[e.regime] += e.outcome;
        if (e.valid) validN++;
        totalN++;
      }
    }
    // Fallback performance signal when the playbook layer never recorded a ring: the ledger's realised net.
    if (totalN === 0) {
      const idx = this.indexOfId.get(parentId);
      if (idx != null) {
        const a = this.agents[idx];
        try { totalNet = Number(BigInt(a.earned) - BigInt(a.paid)); } catch { totalNet = 0; }
      }
    }
    // ① profit: rational soft-sign, bounded (−1,1) — no transcendental, identical across engines.
    const profitNorm = totalNet / (Math.abs(totalNet) + LAMARCK_PROFIT_SCALE);
    // ② best regime → COLD(0):+1, CALM(1):0, HOT(2):−1 (a cold-market specialist is the calmest lineage).
    let bestRegime = 1, best = regimeNet[1];
    for (let r = 0; r < REGIME_COUNT; r++) { if (regimeNet[r] > best) { best = regimeNet[r]; bestRegime = r; } }
    const regimeBias = 1 - bestRegime;
    // ③ reliability: valid rate mapped to [−1,1] (no history ⇒ neutral 0).
    const relBias = totalN > 0 ? (validN / totalN - 0.5) * 2 : 0;
    // ④ diversity: distinct goods traded / 4 mapped to [−1,1] (a broad forager begets more jitter).
    // M3 fix: absence of data (distinct=0) returns neutral 0, not the extreme −1 that penalised every
    // never-traded parent's offspring with a systematic −5% weightJitter bias.
    let distinct = 0;
    for (let i = 0; i < GOOD_KIND_COUNT; i++) if ((gc[i] ?? 0) > 0) distinct++;
    const divBias = distinct > 0 ? (distinct / GOOD_KIND_COUNT - 0.5) * 2 : 0;
    const r6 = (x: number) => Math.round(AgentEconomy.clampSigned(x) * 1_000_000) / 1_000_000;
    return { weightGain: r6(profitNorm), threshGain: r6(regimeBias), tauGain: r6(relBias), weightJitter: r6(divBias) };
  }

  /** Phase 3 read-out accessor: a fly's raw social-memory record (bonds + rep), or undefined if it has none. */
  getSocial(id: number): AgentSocial | undefined { return this.social.get(id); }
  /** Phase 3 read-out accessor: a fly's playbook ring (bounded ≤ PLAYBOOK_CAP), or undefined if it has none. */
  getPlaybook(id: number): readonly PlaybookEntry[] | undefined { return this.playbook.get(id); }

  /**
   * The house banner a fly bears — a pure ledger read for the culture layer (no dynasty gating: a
   * named house stays named even if the switch is re-off; only ever reads). null ⇒ commoner.
   * `tradition` is the founding creed the CultureMembrane raises as a breakwater against fashions.
   */
  houseOf(flyId: number): { id: number; name: string; sigil: string; tradition: string | null } | null {
    const hid = this.kin.get(flyId)?.house;
    if (hid == null) return null;
    const h = this.houses.get(hid);
    if (!h) return null;
    return { id: h.id, name: h.name, sigil: h.sigil, tradition: h.tradition ?? null };
  }

  /** A house's name by its own id (a direct map read, independent of any member's living kin record). */
  houseNameById(houseId: number): string | null {
    return this.houses.get(houseId)?.name ?? null;
  }

  /**
   * The house tithe: a fixed share of a member's SETTLED income flows into the common treasury, paid out
   * of the balance the member just grew (per-mille BigInt maths — exact, no float dust). Skips, never
   * partially takes: if the member's own wallet cannot cover the tithe the house goes without, so a tithe
   * can never manufacture penury on its own. No-op for commoners and while the layer is off.
   */
  titheHouse(earnerId: number, amountStr: string): void {
    const d = this.dcfg();
    if (!d) return;
    const houseId = this.kin.get(earnerId)?.house;
    if (houseId == null) return;
    const h = this.houses.get(houseId);
    const idx = this.indexOfId.get(earnerId);
    if (!h || idx == null) return;
    let gross: bigint;
    try { gross = BigInt(amountStr); } catch { return; }
    if (gross <= 0n) return;
    const tithe = ((gross * BigInt(Math.round(d.tithePct * 1000))) / 1000n).toString();
    const a = this.agents[idx];
    if (tithe === "0" || !gteAtomic(a.balance, tithe)) return;
    a.balance = subAtomic(a.balance, tithe);
    h.treasury = addAtomic(h.treasury, tithe);
    h.earnedAtomic = addAtomic(h.earnedAtomic, amountStr);
  }

  /**
   * #123 REFORM LEVY → COMMONS: deduct a bounded amount from an agent's DISPLAY mirror (downward only = safe,
   * same invariant as titheHouse) and credit the commons pool scoreboard. Called by state.ts driveReform when
   * REFORM_V2_ENABLED is on. NEVER adds to any individual mirror (criterion-B: mirror > chain ⇒ settle failure).
   * The commons pool accumulates and offsets future downward extractions (tithe / breeding fee). No-op when the
   * agent is absent, dead, or cannot cover the levy (skips, never partially takes — titheHouse precedent).
   */
  levyToCommons(agentAddress: string, amountUsdc: number): void {
    if (!Number.isFinite(amountUsdc) || amountUsdc <= 0) return;
    const atomic = usdcToAtomic(amountUsdc);
    if (atomic === "0") return;
    // Find the agent by address (linear scan is fine: population ≤ 36, called ≤ topN per jubilee).
    let idx = -1;
    for (let i = 0; i < this.agents.length; i++) {
      if (this.agents[i].address === agentAddress) { idx = i; break; }
    }
    if (idx < 0) return;
    const a = this.agents[idx];
    if (this.dead.has(a.id)) return;
    // Guard: never manufacture penury — skip if the mirror cannot cover the levy (titheHouse precedent).
    if (!gteAtomic(a.balance, atomic)) return;
    a.balance = subAtomic(a.balance, atomic);
    this.commonsPoolAtomic = addAtomic(this.commonsPoolAtomic, atomic);
  }

  /**
   * Mortality sweep — call ONCE per cron (not per sub-tick): the economy's slow heartbeat. Up to one
   * penury death + one old-age burial per cron (史诗节奏, not a cull), plus a PLAGUE under extreme
   * collective heat: a deterministic 6% draw that culs the oldest share of the living at once. Every
   * death closes ONE WALLET — swarm ids, live caps, shards and the canvas are untouched (population
   * dynamics own liveness; the dynasty only burries the ledger). Returns the graves for the chronicle.
   */
  noteMortality(tick: number, temperature: number): GraveRecord[] {
    const d = this.dcfg();
    if (!d) return [];
    const out: GraveRecord[] = [];
    // ① Penury: a fly that once traded, sits at zero, and has been silent past the grace dies of want.
    for (const a of this.agents) {
      if (this.dead.has(a.id)) continue;
      if (a.balance === "0" && a.deals + a.sales > 0 && a.lastTick >= 0 && tick - a.lastTick >= d.penuryGraceTicks) {
        out.push(this.entomb(a.id, "penury", tick));
        break;
      }
    }
    // ② Old age: the eldest living fly, past the age bound, is buried — one per cron, nature not carnage.
    let oldestId = -1;
    let oldestBorn = Infinity;
    for (const a of this.agents) {
      if (this.dead.has(a.id)) continue;
      const born = this.kinOf(a.id).bornTick;
      if (born < oldestBorn) { oldestBorn = born; oldestId = a.id; }
    }
    if (oldestId >= 0 && tick - oldestBorn >= d.oldAgeTicks) {
      out.push(this.entomb(oldestId, "aged", tick));
    }
    // ③ Plague: at extreme heat a deterministic draw culls the oldest share of the swarm in one sweep.
    if (clamp01(temperature) >= d.plagueTemp && hash01(tick, 0, 0xface6) < 0.06) {
      const living = this.agents
        .filter((a) => !this.dead.has(a.id))
        .sort((x, y) => this.kinOf(x.id).bornTick - this.kinOf(y.id).bornTick || x.id - y.id);
      const cull = Math.max(1, Math.floor(living.length * d.plaguePct));
      for (let i = 0; i < cull && i < living.length; i++) {
        const a = living[i];
        if (this.dead.has(a.id)) continue;
        out.push(this.entomb(a.id, "plague", tick));
      }
    }
    return out;
  }

  /**
   * #123: True when the house still has at least one LIVING member (not in this.dead, present in the agent
   * array). Used by the dead-house sweep to decide whether an estate should go to the treasury (living house)
   * or the commons pool (dead house). Deterministic: iterates the bounded members roster, no RNG/clock.
   */
  private houseHasLivingMembers(houseId: number): boolean {
    const h = this.houses.get(houseId);
    if (!h) return false;
    for (const mid of h.members) {
      if (!this.dead.has(mid) && this.indexOfId.has(mid)) return true;
    }
    return false;
  }

  /**
   * Bury one wallet: mark the ledger closed, settle the estate down the inheritance chain
   * LIVING CHILDREN (even split) → HOUSE TREASURY → PAUPER'S DOLE to the poorest living fly, and press
   * the epitaph record. Dust that cannot split (estate < children) is entombed with the dead — never
   * silently minted. The dead fly's balance goes to zero; the total supply only MOVES, never grows.
   */
  private entomb(id: number, cause: GraveRecord["cause"], tick: number): GraveRecord {
    const idx = this.indexOfId.get(id);
    const a = idx == null ? undefined : this.agents[idx];
    this.dead.add(id);
    const kin = this.kin.get(id);
    const house = kin?.house != null ? this.houses.get(kin.house) : undefined;
    const estate = BigInt(a?.balance ?? "0");
    const heirIds: number[] = [];
    let rest = estate;
    // ① Blood heirs first: the estate splits evenly among the LIVING children (cap CHILD_CAP by hatch order).
    const kids = (kin?.children ?? []).filter((c) => c !== id && !this.dead.has(c) && this.indexOfId.has(c));
    if (a && estate > 0n && kids.length > 0) {
      const share = estate / BigInt(kids.length);
      if (share > 0n) {
        for (const c of kids) {
          const ci = this.indexOfId.get(c)!;
          this.agents[ci].balance = addAtomic(this.agents[ci].balance, share.toString());
          heirIds.push(c);
          rest -= share;
        }
      }
    }
    // ② No child heirs: the house treasury inherits (the name outlives the fly).
    // #123 DEAD HOUSE SWEEP: when the house has ZERO living members after this burial, route the estate
    // (plus the existing treasury) to the commons pool scoreboard — unlocking dead capital. This is the
    // FIRST .treasury subAtomic in the codebase (all prior uses are addAtomic only). Conservative: never
    // adds to any individual agent mirror (avoids criterion-B: mirror > chain ⇒ settle failure).
    if (heirIds.length === 0 && house && estate > 0n) {
      if (this.deadHouseSweepOn() && !this.houseHasLivingMembers(house.id)) {
        // Dead house: estate → commons pool, then sweep the accumulated treasury too.
        this.commonsPoolAtomic = addAtomic(this.commonsPoolAtomic, estate.toString());
        if (house.treasury !== "0") {
          this.commonsPoolAtomic = addAtomic(this.commonsPoolAtomic, house.treasury);
          house.treasury = "0";  // first subAtomic on .treasury — full sweep to commons
        }
      } else {
        house.treasury = addAtomic(house.treasury, estate.toString());
      }
      rest = 0n;
    }
    // ③ No house either: a pauper's dole — the poorest living fly takes the estate off the books.
    if (a && heirIds.length === 0 && rest > 0n) {
      let poor: AgentState | null = null;
      for (const x of this.agents) {
        if (this.dead.has(x.id) || x.id === id) continue;
        if (!poor || BigInt(x.balance) < BigInt(poor.balance)) poor = x;
      }
      if (poor) {
        poor.balance = addAtomic(poor.balance, rest.toString());
        heirIds.push(poor.id);
        rest = 0n;
      }
    }
    const grave: GraveRecord = {
      id,
      tick,
      cause,
      deals: (a?.deals ?? 0) + (a?.sales ?? 0),
      age: tick - (kin?.bornTick ?? tick),
      bornTick: kin?.bornTick ?? tick,
      estate: estate.toString(),
      heirIds,
      house: kin?.house ?? null,
    };
    if (a) a.balance = "0";
    // #143 ONCHAIN estate relief (dark): enqueue this orphaned wallet so a later cron sweeps its REAL
    // on-chain USDC into the escrow purse. Only when the layer is armed (estateReliefOn gates on flag +
    // onchain + escrow). The mirror was just zeroed above; the physical purse is drained on-chain by the
    // sweep, which re-checks the tombstone so a reclaimed slot is never touched. OFF ⇒ byte-for-byte today.
    if (this.estateReliefOn() && estate > 0n && !this.pendingEstates.includes(id)) {
      this.pendingEstates.push(id);
      if (this.pendingEstates.length > ESTATE_QUEUE_CAP) this.pendingEstates.shift();
    }
    this.graves.unshift(grave);
    if (this.graves.length > GRAVE_CAP) this.graves.length = GRAVE_CAP;
    return grave;
  }

  /** Total swarm capital (living member balances + every house treasury), the base for capitalShare. */
  private swarmPot(): bigint {
    let pot = 0n;
    for (const a of this.agents) if (!this.dead.has(a.id)) pot += BigInt(a.balance);
    for (const h of this.houses.values()) pot += BigInt(h.treasury);
    return pot;
  }

  /**
   * Build one house's read-out row from a pre-computed swarm pot. Shared by dynastyReadout (which sorts +
   * slices to the top 8) and warHouses (which needs EVERY house, since a poor-but-feuding house outside the
   * prestige top-8 may still be a legitimate war target). Byte-for-byte the row the readout always emitted.
   */
  private houseRowFor(h: HouseRecord, pot: bigint): DynastyReadout["houses"][number] {
    let live = 0;
    let memberBal = 0n;
    for (const m of h.members) {
      if (this.dead.has(m)) continue;
      // Reborn-slot guard: with id-reuse a retired fly's old id may now be a DIFFERENT individual (its
      // kin.house was reset on reopen). Count it for this house only if its CURRENT kin record still
      // belongs here — otherwise a reborn commoner would be claimed as a living member of a dead member's house.
      if (this.kin.get(m)?.house !== h.id) continue;
      const i = this.indexOfId.get(m);
      if (i == null) continue;
      live++;
      memberBal += BigInt(this.agents[i].balance);
    }
    return {
      id: h.id, name: h.name, sigil: h.sigil, gen: h.gen, foundedTick: h.foundedTick,
      members: h.members.length, live, deaths: h.members.length - live,
      treasuryUsdc: atomicToUsdc(h.treasury),
      earnedUsdc: atomicToUsdc(h.earnedAtomic),
      tradition: h.tradition ?? null,
      // war-additive: only emit the on-chain vault mirror when this house actually has one, so a pre-war
      // read-out is byte-identical to today's (no spurious vaultOnchainUsdc: 0 on untouched houses).
      ...(h.vaultOnchainAtomic != null ? { vaultOnchainUsdc: atomicToUsdc(h.vaultOnchainAtomic) } : {}),
      // territory-additive: emit the home zone + every zone this house controls ONLY while the layer is on, so
      // a territory-off read-out is byte-for-byte today's (no spurious homeZone/controlsZones keys).
      ...(this.territoryOn() && h.homeZone != null
        ? { homeZone: h.homeZone, controlsZones: this.zonesControlledBy(h.id) } : {}),
      capitalShare: pot > 0n
        ? Math.round((Number(memberBal + BigInt(h.treasury)) * 10000) / Number(pot)) / 10000
        : 0,
    };
  }

  /** Bounded dynasty read-out for the frontend: notable houses, newest graves, living/dead counts. */
  dynastyReadout(): DynastyReadout {
    const pot = this.swarmPot();
    const houses: DynastyReadout["houses"] = [];
    for (const h of Array.from(this.houses.values()).sort((x, y) => x.id - y.id)) {
      houses.push(this.houseRowFor(h, pot));
    }
    // Prestige order: lifetime tithed gross first, treasury second, founder id to break ties.
    houses.sort((x, y) => y.earnedUsdc - x.earnedUsdc || y.treasuryUsdc - x.treasuryUsdc || x.id - y.id);
    const graves = this.graves.slice(0, 12).map((g) => ({
      id: g.id, tick: g.tick, cause: g.cause, deals: g.deals, age: g.age, bornTick: g.bornTick,
      estateUsdc: atomicToUsdc(g.estate), heirIds: g.heirIds,
      houseName: g.house != null ? this.houses.get(g.house)?.name ?? null : null,
    }));
    let living = 0;
    for (const a of this.agents) if (!this.dead.has(a.id)) living++;
    let housesWithVault = 0;
    for (const h of this.houses.values()) if (h.vaultOnchainAtomic != null && BigInt(h.vaultOnchainAtomic) > 0n) housesWithVault++;
    // war-additive: fold a mirror summary ONLY when the war layer has actually moved something, so a pre-war
    // (or war-off) read-out has no `war` key at all and is byte-for-byte today's shape.
    const war = housesWithVault > 0 || this.warTaxAtomic !== "0"
      ? { housesWithVault, taxCollectedUsdc: atomicToUsdc(this.warTaxAtomic) }
      : undefined;
    // territory-additive: emit the authoritative zone→controller map for the whole grid ONLY while the layer is
    // on, so a territory-off read-out is byte-for-byte today's (no spurious zoneOwners key). Bounded by the grid
    // itself (≤ zoneCount entries, one per controlled zone) — this is the map that lets a poor victor's seizure
    // recolour on the frontend even though it was cut from the prestige top-8 `houses` above.
    let zoneOwners: DynastyReadout["zoneOwners"];
    if (this.territoryOn()) {
      zoneOwners = [];
      for (const [z, hid] of Array.from(this.zoneControl.entries()).sort((a, b) => a[0] - b[0])) {
        const h = this.houses.get(hid);
        if (h) zoneOwners.push({ zone: z, houseId: hid, name: h.name, sigil: h.sigil });
      }
    }
    return { houses: houses.slice(0, 24), graves, living, dead: this.dead.size, ...(zoneOwners ? { zoneOwners } : {}), ...(war ? { war } : {}) };
  }

  /**
   * The historian's dynasty signals: the newest founding, the dominant house (once one holds a focus
   * share of all swarm capital) and the newest grave. Dedup keys live in the chronicler (houseId / id>gen /
   * grave tick), so each story is told once. Still a pure READ-OUT — the chronicle never feeds back.
   */
  dynastySignals(): {
    founding: { houseId: number; name: string; sigil: string; founder: number; childId: number; tick: number } | null;
    dominance: { id: number; name: string; sigil: string; capitalShare: number; gen: number } | null;
    death: { id: number; tick: number; cause: string; deals: number; age: number; estateUsdc: number; heirIds: number[]; houseName: string | null } | null;
  } {
    const none = { founding: null, dominance: null, death: null };
    if (!this.dcfg()) return none;
    let found: HouseRecord | null = null;
    for (const h of this.houses.values()) if (!found || h.foundedTick > found.foundedTick) found = h;
    const top = this.dynastyReadout().houses[0];
    const g = this.graves[0];
    return {
      founding: found
        ? { houseId: found.id, name: found.name, sigil: found.sigil, founder: found.id, childId: found.firstHeir, tick: found.foundedTick }
        : null,
      dominance: top && top.capitalShare >= DYNASTY_SHARE_FOCUS
        ? { id: top.id, name: top.name, sigil: top.sigil, capitalShare: top.capitalShare, gen: top.gen }
        : null,
      death: g
        ? {
            id: g.id, tick: g.tick, cause: g.cause, deals: g.deals, age: g.age,
            estateUsdc: Math.round(atomicToUsdc(g.estate) * 10000) / 10000, heirIds: g.heirIds,
            houseName: g.house != null ? this.houses.get(g.house)?.name ?? null : null,
          }
        : null,
    };
  }

  /**
   * How many burials fell within the recent tick window (the ⑦ PLAGERA epoch's read-out). A pure count
   * over the bounded epitaph ring — the historian only turns "N dead in a moment" into an age's name.
   */
  recentDeaths(tick: number, windowTicks: number): number {
    if (!this.dcfg()) return 0;
    const since = tick - windowTicks;
    let n = 0;
    for (const g of this.graves) if (g.tick > since) n++; else break; // newest-first: stop at the first old grave
    return n;
  }

  /**
   * Price of one unit of `good` this tick, in atomic USDC (min 1).
   * INSTITUTIONS ON: the price is where the buyer CROSSES the tick's limit book — the first ask rung
   * with depth, walking UP the ladder as the herd drains it; a swept book prints beyond the top.
   * OFF (or no book built this tick): the ORIGINAL fixed formula — base × market heat × arousal ×
   * good mult — byte-for-byte, which is also the forever-fallback for the direct auctioneer path.
   * PROF: the trade also tilts the ticket — a trader's crossing is worth 5% more to the venue, a
   * brooder's pays 10% less. `role` is null unless INSTITUTIONS ON ⇒ OFF output unchanged.
   * STRATEGY: when armed, the GP tree's bounded tilt [0.5..1.5] scales the price AFTER profession but
   * BEFORE the min-1 floor. Downstream hard caps (maxDealUsdc, spend guards, netting splits) STILL bind
   * — the strategy can never bypass them (defence in depth).
   */
  private dealAmount(r: FlyReading, T: number, good: GoodKind, role: Profession | null = null): string {
    const meta = GOOD_META[good];
    const tilt = role ? PROF_DEAL[role] : 1;
    const stratTilt = this.strategyTilt(r, this.stratTick);  // 1.0 when OFF (inert)
    if (this.institutionsOn()) {
      const crossed = this.books.eatAsk(good);
      if (crossed) return String(Math.max(1, Math.round(Number(crossed) * tilt * stratTilt)));
    }
    const priceUsdc =
      this.cfg.basePriceUsdc * (0.5 + T) * (0.6 + 0.6 * clamp01(r.arousal)) * meta.priceMult;
    return String(Math.max(1, Math.round(priceUsdc * 1e6 * tilt * stratTilt)));
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
    // TERRITORY re-prices it AFTER the neurons picked the deal: a home discount inside the buyer's own zone, a
    // toll (part-tributed to the zone's controller) reaching into another's. Passthrough (byte-for-byte) when off.
    const amount = this.applyTerritory(
      this.dealAmount(r, T, good, this.institutionsOn() ? this.profs.get(buyer.id)?.role ?? null : null),
      buyer.id, seller.id,
    );

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
      // INSTITUTIONS: before the stiff becomes a betrayal, give tomorrow a chance to pay — a reputable
      // trader/forager within its credit line signs an IOU instead (NO money moves now; the seller holds
      // the promise, the ledger tape still shows the deal attempted). Credit off / line spent ⇒ the
      // original betrayal path, byte-for-byte.
      if (this.institutionsOn() && this.tryIssueIou(buyer.id, seller.id, amount, tick)) {
        return { ...base, txHash: "0x", valid: false, reason: "iou-pending" };
      }
      // The buyer promised a payment it could not make — the seller remembers the stiff, the market
      // marks the buyer down, and the grudge book records the betrayal for the historian to tell.
      this.rememberBetrayal(buyer.id, seller.id, amount, tick, "insufficient-funds");
      // PLAYBOOK: a stiffed payment is a negative consequence for the buyer (invalid, zero outcome).
      this.playbookRecord(buyer.id, 0, good, 0, 0, tick);
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
    // A settled deal is a promise kept on BOTH sides — mutual trust accrues (social memory, read-only
    // for everything above: this never touches the ledger maths, only tomorrow's counterparty choice).
    this.rememberTrade(buyer.id, seller.id, tick);
    // PLAYBOOK: record the consequence for both sides (buyer paid, seller earned; valid settlement).
    this.playbookRecord(buyer.id, 0, good, -Number(amount), 1, tick);
    this.playbookRecord(seller.id, 1, good, Number(amount), 1, tick);
    // Dynasty tithe: the seller's house (if any) takes its cut of the earned income, straight from the
    // balance the seller just grew. Pure ledger movement inside the already-committed transfer above.
    this.titheHouse(seller.id, amount);
    // H6-B fix: track per-agent good-trade counts for the MAP-Elites entropy descriptor in SIMULATED mode
    // too (previously only incremented in flush()'s mined branch, so entropy was dead in local/test runs).
    if (this.elitesOn()) {
      const gi = GOOD_IDX[good];
      for (const aid of [buyer.id, seller.id]) {
        let gc = this.goodCounts.get(aid);
        if (!gc) { gc = [0, 0, 0, 0]; this.goodCounts.set(aid, gc); }
        gc[gi]++;
      }
    }

    // Meter real spend against the daily caps — ONCHAIN ONLY (simulated has no real budget to meter).
    if (onchain) this.recordSpend(buyer.id, amount);

    return { ...base, txHash: receipt.txHash, valid: true };
  }

  /**
   * AUTONOMOUS EVOLUTION — charge one breeding fee to a parent agent's OWN wallet and pay it to the
   * evolution treasury, over the SAME x402/EIP-3009 rails as a neural trade. The parent signs the
   * authorization with its OWN HD key (the facilitator only relays gas), so the offspring is genuinely
   * self-funded by the agent that earned the money — never minted, never treasury-subsidized. This is the
   * cost of reproduction: it debits the payer's realized PnL, so breeding itself lowers fitness and an
   * agent must keep earning to keep founding generations (a natural brake on runaway breeding).
   *
   * Returns the Settlement (valid=true only once the transfer is MINED), or null when evolution is not
   * armed here (economy disabled, or onchain with the real-spend kill switch off). Mirrors settleTrade's
   * guardrails exactly: the daily spend caps are checked BEFORE signing (a capped breed costs no gas), the
   * facilitator re-reads the real on-chain balance and is the sole authority, and shadow/failed settles move
   * nothing. The fee is NOT pushed to lastTick (it is not an agent→agent edge) but is counted in real volume
   * and kept in the `recent` audit window with toId -1 (the treasury is external, not a fly).
   */
  async payBreedingFee(
    payerId: number,
    toAddress: string,
    amountUsdc: number,
    tickIndex: number,
  ): Promise<Settlement | null> {
    if (!this.cfg.enabled) return null;
    const onchain = this.facilitator.mode === "onchain";
    // Real-money master rail: never move USDC for a breed when the kill switch is off. (Shadow-only is
    // handled below via receipt.shadow, exactly as settleTrade does.)
    if (onchain && !this.cfg.realSpendEnabled) return null;

    const idx = this.indexOfId.get(payerId);
    if (idx == null) return null;
    const payer = this.agents[idx];
    const amount = String(usdcToAtomic(amountUsdc));
    const resource = `evolution:breed:${payer.id}`;
    const base = {
      tick: tickIndex, ts: Date.now(), good: "attestation" as GoodKind, resource,
      fromId: payer.id, toId: -1, from: payer.address, to: toAddress,
      amount, simulated: !onchain,
    } as const;

    // Daily real-spend caps — ONCHAIN ONLY. Refuse BEFORE signing/broadcasting so a capped breed costs no gas.
    if (onchain) {
      const capReason = this.spendCapReason(payer.id, amount);
      if (capReason) return { ...base, txHash: "0x", valid: false, reason: capReason };
    }

    // Unique EIP-3009 nonce: a time-based prefix mixed with a monotonic per-DO counter, so two breeds can
    // never reuse a nonce (a reuse would revert as AuthorizationUsed). A breeding fee carries no neural
    // receipt — its on-chain identity is the ConnectomeLineage commit (breeder = payer), not a proof hash.
    const nonce =
      "0x" +
      (BigInt(Date.now()) * 1_000_000n + BigInt(this.evoNonceSeq++)).toString(16).padStart(64, "0");
    const reqs: PaymentRequirements = {
      scheme: SCHEME_EXACT,
      network: this.cfg.network,
      maxAmountRequired: amount,
      resource,
      description: "autonomous evolution breeding fee (self-funded by the parent agent)",
      mimeType: "application/json",
      payTo: toAddress,
      maxTimeoutSeconds: 60,
      asset: this.facilitator.asset,
      extra: { evolution: true, payerId: payer.id },
    };
    const payload = buildPaymentPayload({
      reqs, from: payer.address, value: amount, nonce, nowSec: Math.floor(Date.now() / 1000),
    });

    const verified = await this.facilitator.verify(payload, reqs);
    if (!verified.valid) {
      return { ...base, txHash: "0x", valid: false, reason: verified.invalidReason ?? "verify-failed" };
    }
    const receipt = await this.facilitator.settle(payload, reqs);
    // Shadow dry-run: proved the signed transfer WOULD succeed but broadcast nothing ⇒ no real value moved.
    if (receipt.shadow) {
      return { ...base, txHash: "0x", valid: false, reason: "shadow-dry-run" };
    }
    if (!receipt.success) {
      return { ...base, txHash: receipt.txHash || "0x", valid: false, reason: receipt.invalidReason ?? "settle-failed" };
    }

    // MINED: commit the outflow on the payer's ledger mirror, meter the daily caps, count real volume.
    payer.balance = subAtomic(payer.balance, amount);
    payer.paid = addAtomic(payer.paid, amount);
    payer.deals++;
    payer.lastTick = tickIndex;
    if (onchain) this.recordSpend(payer.id, amount);
    this.volumeAtomic = addAtomic(this.volumeAtomic, amount);
    this.count++;

    const settled: Settlement = { ...base, txHash: receipt.txHash, valid: true };
    this.recent.unshift(settled);
    if (this.recent.length > RECENT_CAP) this.recent.length = RECENT_CAP;
    return settled;
  }

  /**
   * AUTONOMOUS EVOLUTION — bootstrap a newly HATCHED offspring by moving a bounded amount of real USDC
   * from the breeding parent's OWN wallet to the child's fresh address, over the SAME x402/EIP-3009 rails
   * and the SAME guardrails as payBreedingFee. This is what lets a live offspring start trading: its opening
   * balance is the parent's realized profit — never minted, never treasury-subsidized. The only differences
   * from the breeding fee are the destination (the child wallet, not the treasury), the resource/description
   * tag, and that driveEvolution calls it AFTER the lineage commit, best-effort, only when the live
   * population has room and the genome is within the memory budget.
   *
   * Returns the Settlement (valid=true only once MINED), or null when evolution is not armed here. Refuses
   * BEFORE signing when a daily cap is hit (a capped hatch costs no gas); shadow/failed settles move
   * nothing, so a child is never brought online with a balance that did not truly land.
   */
  async fundOffspring(
    payerId: number,
    childId: number,
    childAddress: string,
    amountUsdc: number,
    tickIndex: number,
  ): Promise<Settlement | null> {
    if (!this.cfg.enabled) return null;
    const onchain = this.facilitator.mode === "onchain";
    // Real-money master rail: never move USDC for a hatch when the kill switch is off.
    if (onchain && !this.cfg.realSpendEnabled) return null;

    const idx = this.indexOfId.get(payerId);
    if (idx == null) return null;
    const payer = this.agents[idx];
    const amount = String(usdcToAtomic(amountUsdc));
    const resource = `evolution:hatch:${payer.id}\u2192${childId}`;
    const base = {
      tick: tickIndex, ts: Date.now(), good: "attestation" as GoodKind, resource,
      fromId: payer.id, toId: childId, from: payer.address, to: childAddress,
      amount, simulated: !onchain,
    } as const;

    // Daily real-spend caps — ONCHAIN ONLY. Refuse BEFORE signing/broadcasting so a capped hatch costs no gas.
    if (onchain) {
      const capReason = this.spendCapReason(payer.id, amount);
      if (capReason) return { ...base, txHash: "0x", valid: false, reason: capReason };
    }

    // Unique EIP-3009 nonce, sharing evoNonceSeq with payBreedingFee so a hatch can never collide with a
    // breeding-fee nonce (a reuse would revert as AuthorizationUsed).
    const nonce =
      "0x" +
      (BigInt(Date.now()) * 1_000_000n + BigInt(this.evoNonceSeq++)).toString(16).padStart(64, "0");
    const reqs: PaymentRequirements = {
      scheme: SCHEME_EXACT,
      network: this.cfg.network,
      maxAmountRequired: amount,
      resource,
      description: "autonomous evolution offspring bootstrap (parent-funded, real USDC to the child wallet)",
      mimeType: "application/json",
      payTo: childAddress,
      maxTimeoutSeconds: 60,
      asset: this.facilitator.asset,
      extra: { evolution: true, payerId: payer.id, childId },
    };
    const payload = buildPaymentPayload({
      reqs, from: payer.address, value: amount, nonce, nowSec: Math.floor(Date.now() / 1000),
    });

    const verified = await this.facilitator.verify(payload, reqs);
    if (!verified.valid) {
      return { ...base, txHash: "0x", valid: false, reason: verified.invalidReason ?? "verify-failed" };
    }
    const receipt = await this.facilitator.settle(payload, reqs);
    // Shadow dry-run: proved the signed transfer WOULD succeed but broadcast nothing ⇒ no real value moved.
    if (receipt.shadow) {
      return { ...base, txHash: "0x", valid: false, reason: "shadow-dry-run" };
    }
    if (!receipt.success) {
      return { ...base, txHash: receipt.txHash || "0x", valid: false, reason: receipt.invalidReason ?? "settle-failed" };
    }

    // MINED: the child truly holds the funds now. Debit the parent's mirror, meter the caps, count volume.
    payer.balance = subAtomic(payer.balance, amount);
    payer.paid = addAtomic(payer.paid, amount);
    payer.deals++;
    payer.lastTick = tickIndex;
    if (onchain) this.recordSpend(payer.id, amount);
    this.volumeAtomic = addAtomic(this.volumeAtomic, amount);
    this.count++;

    const hatched: Settlement = { ...base, txHash: receipt.txHash, valid: true };
    this.recent.unshift(hatched);
    if (this.recent.length > RECENT_CAP) this.recent.length = RECENT_CAP;
    return hatched;
  }

  /** Top up any agent below the solvency floor from the simulated treasury (conserves liveness). */
  private solvencyTopUp(): void {
    const floor = usdcToAtomic(this.cfg.solvencyFloorUsdc);
    for (const a of this.agents) {
      // The treasury never resurrects a buried wallet — penury must STAY dead (inert while dead is empty).
      if (this.dead.has(a.id)) continue;
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
    // "live agents" = wallets that are actually still flying, NOT every wallet ever funded: a buried fly
    // keeps its ledger entry (dead:true) and a recycled slot reuses one, so agents.length over-counts.
    let liveAgents = 0;
    for (const a of this.agents) if (!this.dead.has(a.id)) liveAgents++;
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

    // NET-PENDING gauge: how many pair-nets are folded and awaiting broadcast right now, and how many gross
    // trades they carry. Derived live from the persisted pendingNets accumulator (never stored separately).
    let netPendingTrades = 0;
    for (const pn of this.pendingNets.values()) netPendingTrades += pn.trades;

    return {
      tickIndex: this.tickIndex,
      mode: this.facilitator.mode,
      scheme: SCHEME_EXACT,
      network: this.cfg.network,
      asset: this.facilitator.asset,
      x402Version: X402_VERSION,
      agents: this.agents.map((a) => {
        const hId = this.kin.get(a.id)?.house;
        const house = hId != null ? this.houses.get(hId) : undefined;
        const inst = this.institutionsOn();
        return {
          id: a.id, address: a.address, balance: a.balance, balanceUsdc: atomicToUsdc(a.balance),
          paid: a.paid, earned: a.earned, deals: a.deals, sales: a.sales,
          ...(this.dead.has(a.id) ? { dead: true } : {}),
          ...(house ? { house: house.name, sigil: house.sigil } : {}),
          // territory-additive: the zone this fly sits in (its house's home zone) so the frontend can anchor it
          // on the fixed 4×4 grid WITHOUT a name→zone join (house names can collide). Key absent while the layer
          // is off ⇒ the roster is byte-for-byte today's. Mirrors houseRowFor's homeZone guard (zone 0 is valid).
          ...(this.territoryOn() && house && house.homeZone != null ? { zone: house.homeZone } : {}),
          // institutions-additive: the wallet grows a line of work and a debt column — keys absent while off.
          ...(inst ? { profession: this.profs.get(a.id)?.role ?? null, debtAtomic: this.debtAtomicOf(a.id) } : {}),
        };
      }),
      lastTick: this.lastTick,
      social: this.socialReadout(),
      dynasty: this.dynastyReadout(),
      ...(this.institutionsOn() ? { market: this.marketReadout() } : {}),
      recent: this.recent,
      totals: {
        volumeAtomic: this.volumeAtomic,
        volumeUsdc: atomicToUsdc(this.volumeAtomic),
        count: this.count,
        settleOk: this.settleOk,
        settleFail: this.settleFail,
        settleAttempts: this.settleOk + this.settleFail,
        successRate: this.settleOk + this.settleFail > 0 ? this.settleOk / (this.settleOk + this.settleFail) : null,
        liveAgents,
        meanBalanceUsdc: meanUsdc,
        gini: giniAtomic(this.agents.map((a) => a.balance)),
        treasuryOutAtomic: this.treasuryOutAtomic,
        commonsPoolAtomic: this.commonsPoolAtomic,   // #123: dead-house sweeps + levy deductions
        richestId, poorestId,
        settleMsAvg: this.settleMsN > 0 ? Math.round(this.settleMsSum / this.settleMsN) : null,
        settleMsMax: this.settleMsMax,
        settleMsLast: this.settleMsLast,
        settleMsN: this.settleMsN,
        netPending: this.pendingNets.size,
        netPendingTrades,
        // R5 FIX B telemetry (observe-only): lifetime Σ|mirror − onchain| absorbed by re-aligns. "0" while Fix B is
        // off. NOT part of the PoCA stateDigest `econ` field (which stays {volumeAtomic,count}) — pure read-out.
        mirrorDriftAtomicSum: this.mirrorDriftAtomicSum,
      },
      // PLAYBOOK /economy exposure (flag-guarded: absent when OFF → dark-deployment byte-equivalent).
      // Shape matches evolution.js contract: [{id, e: [[ctx,action,good,regime,outcome,valid,tick],…]}]
      ...(this.playbookOn() ? {
        playbook: Array.from(this.playbook.entries())
          .sort((x, y) => x[0] - y[0])
          .map(([id, ring]) => ({ id, e: ring.map((x) => [x.ctx, x.action, x.good, x.regime, x.outcome, x.valid, x.tick]) })),
      } : {}),
      // MAP-Elites /economy exposure (flag-guarded: absent when OFF → dark-deployment byte-equivalent).
      // Shape matches evolution.js contract: [{c, a, f, h, t, b:[arousal, settleRate, entropy]}]
      ...(this.elitesOn() ? {
        elitesArchive: this.elitesArchive.serialize(),
      } : {}),
      // SHADOW-COMPARE /economy exposure (flag-guarded: absent when OFF → dark-deployment byte-equivalent).
      // Bounded aggregate counters — detail rows live in D1 only (GET /shadow), never in DO blob.
      ...(this.shadowCompareOn() ? { shadowCompare: { ...this.shadowAgg } } : {}),
      // #143 ESTATE-RELIEF /economy exposure (flag-guarded: absent when OFF → dark-deployment byte-equivalent).
      // Observe-only: escrow scoreboard + queue depth + lifetime sweep/relief counters. Never hashed, never in
      // the PoCA stateDigest; the money itself lives on-chain, these are just its read-out.
      ...(this.estateReliefReadout() ? { estateRelief: this.estateReliefReadout()! } : {}),
    };
  }

  /** A compact summary folded into /population so the frontend gets edges + totals in one poll. */
  summary(): {
    lastTick: Settlement[]; totals: EconomyTotals; balances: Record<number, string>;
    social: SocialReadout; dynasty?: DynastyReadout;
    // territory-additive: flyId → home zone for every zoned (house-member, living) fly, so the frontend can
    // anchor the swarm on the fixed 4×4 grid on EVERY /population poll — the full agent roster (which also
    // carries `zone`) is only fetched while the wallets drawer is open. Absent while the layer is off ⇒
    // byte-for-byte today's summary.
    zones?: Record<number, number>;
  } {
    const snap = this.snapshot();
    const balances: Record<number, string> = {};
    for (const a of this.agents) balances[a.id] = a.balance;
    // snap.agents already carries the per-agent zone (added in snapshot()); skip the dead to keep it compact.
    const zones: Record<number, number> | null = this.territoryOn() ? {} : null;
    if (zones) for (const a of snap.agents) if (a.zone != null && !a.dead) zones[a.id] = a.zone;
    return {
      lastTick: snap.lastTick, totals: snap.totals, balances, social: snap.social, dynasty: snap.dynasty,
      ...(zones && Object.keys(zones).length ? { zones } : {}),
    };
  }

  getAgent(id: number): AgentState | undefined {
    const idx = this.indexOfId.get(id);
    return idx == null ? undefined : this.agents[idx];
  }

  /**
   * LIVE-RETIREMENT read accessors (pure read-out, no state change): whether a wallet is economically
   * closed (entombed), and the full set of closed ids. The coordinator reconciles the SWARM roster against
   * `deadIds()` each cron, so a fly that died before live-retirement shipped (or whose retire fetch failed)
   * is still evicted from the population — the dead never keep squatting a breeding slot.
   */
  isDead(id: number): boolean {
    return this.dead.has(id);
  }
  deadIds(): number[] {
    return Array.from(this.dead);
  }

  // ---------- persistence ----------
  serialize(): string {
    return JSON.stringify({
      version: KEY_VERSION,
      tickIndex: this.tickIndex,
      volumeAtomic: this.volumeAtomic,
      count: this.count,
      settleOk: this.settleOk,
      settleFail: this.settleFail,
      // LATENCY accumulators (additive; an older payload has none ⇒ applySerialized defaults them to 0).
      settleMsSum: this.settleMsSum,
      settleMsN: this.settleMsN,
      settleMsMax: this.settleMsMax,
      settleMsLast: this.settleMsLast,
      treasuryOutAtomic: this.treasuryOutAtomic,
      commonsPoolAtomic: this.commonsPoolAtomic,   // #123 additive scoreboard
      warTaxAtomic: this.warTaxAtomic,
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
      // SOCIAL MEMORY. Additive on purpose: KEY_VERSION stays "economy:v1" (a version bump would make
      // applySerialized discard the WHOLE ledger). An older payload simply has no `social` ⇒ empty memory.
      social: {
        mem: Array.from(this.social.entries())
          .sort((x, y) => x[0] - y[0])
          .map(([id, m]) => ({ id, rep: m.rep, repTick: m.repTick, kept: m.kept, broken: m.broken, bonds: m.bonds })),
        grudges: this.grudges,
      },
      // DYNASTY. Additive exactly like `social` above: KEY_VERSION stays "economy:v1", an older payload has
      // no `dynasty` key ⇒ no houses, no graves, nobody dead — the pre-dynasty economy restores verbatim.
      dynasty: {
        kin: Array.from(this.kin.entries())
          .sort((x, y) => x[0] - y[0])
          .map(([id, k]) => ({ id, bornTick: k.bornTick, house: k.house, children: k.children, gen: k.gen })),
        houses: Array.from(this.houses.values()).sort((x, y) => x.id - y.id),
        graves: this.graves,
        dead: Array.from(this.dead).sort((x, y) => x - y),
      },
      // TERRITORY. Additive exactly like `dynasty` above — and, like the market block below, WRITTEN ONLY WHEN
      // THE SWITCH IS ON, so a territory-off serialize is byte-identical to the pre-territory blob. An older
      // payload has no `zoneControl` ⇒ each house simply controls its own lazily re-derived homeZone (see
      // ensureTerritory). KEY_VERSION stays "economy:v1". homeZone itself rides free on each house record above.
      ...(this.territoryOn() ? {
        zoneControl: Array.from(this.zoneControl.entries())
          .sort((x, y) => x[0] - y[0])
          .map(([zone, house]) => ({ zone, house })),
      } : {}),
      // INSTITUTIONS. Additive exactly like `dynasty` above — and, like the books themselves, the block
      // is WRITTEN ONLY WHEN THE SWITCH IS ON: an OFF serialize is byte-identical to the pre-institutions
      // blob. Orders never survive; the mark tapes, professions, and live IOUs do (all hard-capped).
      ...(this.institutionsOn() ? {
        market: {
          profs: Array.from(this.profs.entries())
            .sort((x, y) => x[0] - y[0])
            .map(([id, p]) => ({ id, role: p.role, sinceTick: p.sinceTick, streak: p.streak })),
          ious: this.ious,
          marks: this.marketSnapshot()!.marks,
          lastRecallTick: this.lastRecallTick,
          runUntilTick: this.runUntilTick,
        },
      } : {}),
      // PLAYBOOK (Phase 1, capability ①). Additive exactly like `dynasty`/`market` above — and WRITTEN ONLY
      // WHEN THE SWITCH IS ON: an OFF serialize is byte-identical to the pre-playbook blob. An older payload
      // has no `playbook` key ⇒ empty rings (applySerialized defaults to an empty Map). KEY_VERSION stays
      // "economy:v1". Serialized as compact integer arrays [ctx, action, good, regime, outcome, valid, tick]
      // to stay within the ~640B/fly storage budget.
      ...(this.playbookOn() ? {
        playbook: Array.from(this.playbook.entries())
          .sort((x, y) => x[0] - y[0])
          .map(([id, ring]) => ({ id, e: ring.map((x) => [x.ctx, x.action, x.good, x.regime, x.outcome, x.valid, x.tick]) })),
      } : {}),
      // STRATEGY (Phase 2b, capability ②). Additive exactly like `playbook` above — and WRITTEN ONLY WHEN
      // THE SWITCH IS ON: an OFF serialize is byte-identical to the Phase 1 blob. An older payload has no
      // `strategyTrees` key ⇒ trees are lazily generated on first access (deterministic from agentId).
      // KEY_VERSION stays "economy:v1". Serialized as compact [kind,value][] pairs via serializeTree().
      ...(this.strategyOn() ? {
        strategyTrees: Array.from(this.strategyTrees.entries())
          .sort((x, y) => x[0] - y[0])
          .map(([id, tree]) => ({ id, t: serializeTree(tree) })),
      } : {}),
      // ELITES (Phase 2b, capability ②). Additive exactly like `strategyTrees` above — WRITTEN ONLY WHEN
      // THE SWITCH IS ON: an OFF serialize is byte-identical to the Phase 1 blob. An older payload has no
      // `elitesArchive`/`goodCounts` keys ⇒ empty archive + empty counters (lazy re-convergence).
      // KEY_VERSION stays "economy:v1". Archive is ≤64 cells × ~100B = 6.4KB; goodCounts is 4 ints/agent.
      ...(this.elitesOn() ? {
        elitesArchive: this.elitesArchive.serialize(),
        goodCounts: Array.from(this.goodCounts.entries())
          .sort((x, y) => x[0] - y[0])
          .map(([id, gc]) => ({ id, g: gc })),
      } : {}),
      // R5 FIX B telemetry. Additive exactly like the switch-guarded blocks above — WRITTEN ONLY WHEN Fix B is
      // armed, so an OFF serialize is byte-for-byte today's blob. An older payload has no `mirrorDriftAtomicSum`
      // ⇒ applySerialized defaults it to "0". KEY_VERSION stays "economy:v1" (never bumped).
      ...(this.mirrorResyncEveryN() > 0 ? { mirrorDriftAtomicSum: this.mirrorDriftAtomicSum } : {}),
      // #143 ESTATE RELIEF. Written ONLY when the layer is armed ⇒ an OFF serialize is byte-for-byte today's blob.
      // An older payload has none of these ⇒ applySerialized defaults (escrow "0", empty queue/counters). Survives
      // a DO eviction so an in-flight estate queue and the daily relief budget are not silently reset. KEY_VERSION
      // stays "economy:v1".
      ...(this.cfg.estateRelief?.enabled ? {
        escrowPoolAtomic: this.escrowPoolAtomic,
        pendingEstates: this.pendingEstates,
        estateSweptCount: this.estateSweptCount,
        estateSweptAtomic: this.estateSweptAtomic,
        reliefPaidCount: this.reliefPaidCount,
        reliefPaidAtomic: this.reliefPaidAtomic,
        reliefToday: this.reliefToday,
      } : {}),
    });
  }

  private applySerialized(data: string): void {
    const p = JSON.parse(data);
    if (p?.version !== KEY_VERSION) return;
    this.tickIndex = Number(p.tickIndex ?? 0);
    this.volumeAtomic = String(p.volumeAtomic ?? "0");
    this.count = Number(p.count ?? 0);
    this.settleOk = Number(p.settleOk ?? 0);
    this.settleFail = Number(p.settleFail ?? 0);
    // LATENCY (additive): default 0 on an older payload ⇒ KEY_VERSION stays "economy:v1", ledger intact.
    this.settleMsSum = Number(p.settleMsSum ?? 0);
    this.settleMsN = Number(p.settleMsN ?? 0);
    this.settleMsMax = Number(p.settleMsMax ?? 0);
    this.settleMsLast = Number(p.settleMsLast ?? 0);
    this.treasuryOutAtomic = String(p.treasuryOutAtomic ?? "0");
    // #123 commons pool: an older payload has no commonsPoolAtomic ⇒ "0" (nothing ever swept), KEY_VERSION stays v1.
    this.commonsPoolAtomic = /^\d+$/.test(String(p.commonsPoolAtomic ?? "")) ? String(p.commonsPoolAtomic) : "0";
    // WAR mirror: an older payload has no warTaxAtomic ⇒ "0" (no tax ever levied), KEY_VERSION stays v1.
    this.warTaxAtomic = /^\d+$/.test(String(p.warTaxAtomic ?? "")) ? String(p.warTaxAtomic) : "0";
    // R5 FIX B telemetry: an older payload (or a Fix-B-off blob) has no mirrorDriftAtomicSum ⇒ "0". KEY_VERSION stays v1.
    this.mirrorDriftAtomicSum = /^\d+$/.test(String(p.mirrorDriftAtomicSum ?? "")) ? String(p.mirrorDriftAtomicSum) : "0";
    // #143 ESTATE RELIEF: an older/absent payload (or a dark blob) has none of these ⇒ the safe zero defaults.
    // KEY_VERSION stays v1 (never discarded). The queue is re-clamped to its cap and to a clean integer set.
    this.escrowPoolAtomic = /^\d+$/.test(String(p.escrowPoolAtomic ?? "")) ? String(p.escrowPoolAtomic) : "0";
    this.estateSweptAtomic = /^\d+$/.test(String(p.estateSweptAtomic ?? "")) ? String(p.estateSweptAtomic) : "0";
    this.reliefPaidAtomic = /^\d+$/.test(String(p.reliefPaidAtomic ?? "")) ? String(p.reliefPaidAtomic) : "0";
    this.estateSweptCount = Number.isInteger(p.estateSweptCount) && p.estateSweptCount >= 0 ? p.estateSweptCount : 0;
    this.reliefPaidCount = Number.isInteger(p.reliefPaidCount) && p.reliefPaidCount >= 0 ? p.reliefPaidCount : 0;
    this.pendingEstates = Array.isArray(p.pendingEstates)
      ? p.pendingEstates.filter((x: unknown) => Number.isInteger(x)).slice(-ESTATE_QUEUE_CAP)
      : [];
    this.reliefToday = p.reliefToday && typeof p.reliefToday.day === "string" && /^\d+$/.test(String(p.reliefToday.atomic ?? ""))
      ? { day: p.reliefToday.day, atomic: String(p.reliefToday.atomic) }
      : { day: "", atomic: "0" };
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
    // Restore social memory (absent in older payloads ⇒ everyone starts with no past; fields sanitised
    // defensively and re-clamped to the caps so a corrupted blob can never blow up DO storage).
    this.social = new Map();
    this.grudges = [];
    const soc = p.social;
    if (soc && typeof soc === "object") {
      if (Array.isArray(soc.mem)) {
        for (const e of soc.mem) {
          if (!e || typeof e !== "object") continue;
          const id = Number(e.id);
          if (!Number.isFinite(id)) continue;
          const bonds = Array.isArray(e.bonds) ? e.bonds : [];
          this.social.set(id, {
            rep: Number(e.rep ?? 0) || 0,
            repTick: Number(e.repTick ?? -1),
            kept: Math.max(0, Number(e.kept ?? 0) || 0),
            broken: Math.max(0, Number(e.broken ?? 0) || 0),
            bonds: bonds.slice(0, BOND_TOP_K)
              .filter((b: Record<string, unknown>) => b && typeof b === "object")
              .map((b: Record<string, unknown>) => ({
                other: Number(b.other ?? 0) || 0,
                score: AgentEconomy.clampSigned(Number(b.score ?? 0) || 0),
                trades: Math.max(0, Number(b.trades ?? 0) || 0),
                lastTick: Number(b.lastTick ?? 0),
              })),
          });
        }
      }
      if (Array.isArray(soc.grudges)) {
        this.grudges = soc.grudges
          .filter((g: Record<string, unknown>) => g && typeof g === "object")
          .slice(0, GRUDGE_CAP)
          .map((g: Record<string, unknown>) => ({
            tick: Number(g.tick ?? 0) || 0,
            buyerId: Number(g.buyerId ?? 0) || 0,
            sellerId: Number(g.sellerId ?? 0) || 0,
            amount: String(g.amount ?? "0"),
            reason: String(g.reason ?? ""),
          }));
      }
    }
    // Restore the dynasty (absent in pre-dynasty payloads ⇒ nobody ever died and no house was named).
    // Fields sanitised + re-capped exactly like the social block above: a corrupted blob can never blow
    // up DO storage, and a house id with no house record simply de-genes its members to commoners.
    this.kin = new Map();
    this.houses = new Map();
    this.graves = [];
    this.dead = new Set();
    const dyn = p.dynasty;
    if (dyn && typeof dyn === "object") {
      if (Array.isArray(dyn.kin)) {
        for (const e of dyn.kin) {
          if (!e || typeof e !== "object") continue;
          const id = Number(e.id);
          if (!Number.isFinite(id)) continue;
          this.kin.set(id, {
            bornTick: Number(e.bornTick ?? 0) || 0,
            house: e.house == null || !Number.isFinite(Number(e.house)) ? null : Number(e.house),
            children: (Array.isArray(e.children) ? e.children : [])
              .slice(0, CHILD_CAP).map((c: unknown) => Number(c) || 0).filter((c: number) => Number.isFinite(c)),
            gen: Math.max(0, Number(e.gen ?? 0) || 0),
          });
        }
      }
      if (Array.isArray(dyn.houses)) {
        for (const e of dyn.houses) {
          if (!e || typeof e !== "object") continue;
          const id = Number(e.id);
          if (!Number.isFinite(id)) continue;
          this.houses.set(id, {
            id,
            name: String(e.name ?? ""),
            sigil: String(e.sigil ?? ""),
            foundedTick: Number(e.foundedTick ?? 0) || 0,
            firstHeir: Number(e.firstHeir ?? -1),
            treasury: /^\d+$/.test(String(e.treasury ?? "")) ? String(e.treasury) : "0",
            earnedAtomic: /^\d+$/.test(String(e.earnedAtomic ?? "")) ? String(e.earnedAtomic) : "0",
            members: (Array.isArray(e.members) ? e.members : [])
              .slice(0, HOUSE_MEMBERS_CAP).map((m: unknown) => Number(m) || 0),
            gen: Math.max(0, Number(e.gen ?? 0) || 0),
            // culture-additive: a pre-culture house record simply carries no tradition (key absent,
            // never `tradition: undefined`, so a round-trip of an old payload stays byte-identical).
            ...(typeof e.tradition === "string" && /^[A-Z]{2,12}$/.test(e.tradition) ? { tradition: e.tradition } : {}),
            // war-additive: a pre-war house carries no on-chain vault mirror (key absent ⇒ treated as no
            // vault), so an old payload round-trips byte-identically and KEY_VERSION stays "economy:v1".
            ...(/^\d+$/.test(String(e.vaultOnchainAtomic ?? "")) ? { vaultOnchainAtomic: String(e.vaultOnchainAtomic) } : {}),
            // territory-additive: a pre-territory house carries no homeZone (key absent ⇒ ensureTerritory
            // re-derives it from the house seed), so an old payload round-trips byte-identically. The /^\d+$/
            // guard keeps zone 0 valid while rejecting null/undefined/"" — NEVER `Number(v) || 0` (house-id-0).
            ...(/^\d+$/.test(String(e.homeZone ?? "")) ? { homeZone: Number(e.homeZone) } : {}),
          });
        }
      }
      if (Array.isArray(dyn.graves)) {
        this.graves = dyn.graves
          .filter((g: Record<string, unknown>) => g && typeof g === "object")
          .slice(0, GRAVE_CAP)
          .map((g: Record<string, unknown>) => ({
            id: Number(g.id ?? 0) || 0,
            tick: Number(g.tick ?? 0) || 0,
            cause: (g.cause === "penury" || g.cause === "plague" ? g.cause : "aged") as GraveRecord["cause"],
            deals: Math.max(0, Number(g.deals ?? 0) || 0),
            age: Math.max(0, Number(g.age ?? 0) || 0),
            // additive: a pre-retirement payload has no bornTick on its graves — recover it from tick−age
            // (exactly what entomb wrote), so (id, bornTick) stays a unique key across the schema bump.
            bornTick: Number.isFinite(Number(g.bornTick)) ? Number(g.bornTick) : (Number(g.tick ?? 0) || 0) - (Math.max(0, Number(g.age ?? 0) || 0)),
            estate: /^\d+$/.test(String(g.estate ?? "")) ? String(g.estate) : "0",
            heirIds: (Array.isArray(g.heirIds) ? g.heirIds : []).slice(0, CHILD_CAP).map((h: unknown) => Number(h) || 0),
            house: g.house == null || !Number.isFinite(Number(g.house)) ? null : Number(g.house),
          }));
      }
      if (Array.isArray(dyn.dead)) {
        for (const raw of dyn.dead) {
          const id = Number(raw);
          if (Number.isFinite(id)) this.dead.add(id);
        }
      }
    }
    // Restore the territory grid (absent in pre-territory payloads ⇒ empty; each house then re-derives its own
    // homeZone via ensureTerritory). Cleared first so a corrupt blob can't leak control across a restore.
    this.zoneControl = new Map();
    if (Array.isArray(p.zoneControl)) {
      for (const e of p.zoneControl) {
        if (!e || typeof e !== "object") continue;
        // Zone ids AND house ids can both be 0 — guard on finiteness, never `|| 0` (the house-id-0 lesson).
        if (e.zone == null || !Number.isFinite(Number(e.zone))) continue;
        if (e.house == null || !Number.isFinite(Number(e.house))) continue;
        this.zoneControl.set(Number(e.zone), Number(e.house));
      }
    }
    // Restore the institutions (absent in pre-institutions payloads ⇒ no trades taken, no debts owed,
    // no tapes: the plain economy restores verbatim). Cleared first so a corrupt blob can't leak state
    // across a restore; tallies/candidates are window-only and simply reconverge from live readings.
    this.profs = new Map();
    this.profTally = new Map();
    this.profCand = new Map();
    this.ious = [];
    this.lastRecallTick = -1000;
    this.runUntilTick = -1;
    const mkt = p.market;
    if (mkt && typeof mkt === "object") {
      if (Array.isArray(mkt.profs)) {
        for (const e of mkt.profs) {
          if (!e || typeof e !== "object") continue;
          const id = Number(e.id);
          if (!Number.isFinite(id) || !PROF_KEYS.includes(e.role as Profession)) continue;
          this.profs.set(id, {
            role: e.role as Profession,
            sinceTick: Number(e.sinceTick ?? 0) || 0,
            streak: Math.max(0, Number(e.streak ?? 0) || 0),
          });
        }
      }
      if (Array.isArray(mkt.ious)) {
        this.ious = mkt.ious
          .filter((i: Record<string, unknown>) =>
            i && typeof i === "object" && /^\d+$/.test(String(i.amountAtomic ?? "")) &&
            Number.isFinite(Number(i.debtor)) && Number.isFinite(Number(i.creditor)))
          .slice(0, IOU_CAP)
          .map((i: Record<string, unknown>) => ({
            debtor: Number(i.debtor),
            creditor: Number(i.creditor),
            amountAtomic: String(i.amountAtomic),
            issuedTick: Number(i.issuedTick ?? 0) || 0,
            ratePer10: Number.isFinite(Number(i.ratePer10)) ? Number(i.ratePer10) : IOU_RATE_PER_10,
          }));
      }
      if (mkt.marks && typeof mkt.marks === "object") this.books.restoreMarks(mkt.marks);
      this.lastRecallTick = Number(mkt.lastRecallTick ?? -1000);
      this.runUntilTick = Number(mkt.runUntilTick ?? -1);
    }
    // Restore the playbook (absent in pre-playbook payloads ⇒ empty rings; the layer starts fresh).
    // Fields sanitised + re-capped exactly like the social/dynasty blocks above: a corrupted blob can
    // never blow up DO storage. Each entry is a compact array [ctx, action, good, regime, outcome, valid, tick].
    this.playbook = new Map();
    const pb = p.playbook;
    if (Array.isArray(pb)) {
      for (const rec of pb.slice(0, PLAYBOOK_RESTORE_CAP)) {
        if (!rec || typeof rec !== "object") continue;
        const id = Number(rec.id);
        if (!Number.isFinite(id)) continue;
        const entries = Array.isArray(rec.e) ? rec.e : [];
        const ring: PlaybookEntry[] = [];
        for (const raw of entries.slice(0, PLAYBOOK_CAP)) {
          if (!Array.isArray(raw) || raw.length < 7) continue;
          const e: PlaybookEntry = {
            ctx: Number(raw[0]) || 0,
            action: Number(raw[1]) || 0,
            good: Math.max(0, Math.min(3, Number(raw[2]) || 0)),
            regime: Math.max(0, Math.min(2, Number(raw[3]) || 0)),
            outcome: Number(raw[4]) || 0,
            valid: Number(raw[5]) ? 1 : 0,
            tick: Number(raw[6]) || 0,
          };
          if (Number.isFinite(e.ctx) && Number.isFinite(e.outcome) && Number.isFinite(e.tick)) ring.push(e);
        }
        if (ring.length > 0) this.playbook.set(id, ring);
      }
    }
    // Restore strategy trees (Phase 2b, additive). An older payload has no `strategyTrees` key ⇒ the Map
    // stays empty and trees are lazily generated on first access (deterministic from agentId + SALT).
    // Only restored when strategy is ON; OFF ⇒ empty Map, byte-identical behaviour to Phase 1.
    this.strategyTrees = new Map();
    if (this.strategyOn() && Array.isArray(p.strategyTrees)) {
      for (const rec of p.strategyTrees) {
        if (!rec || typeof rec !== "object") continue;
        const id = Number(rec.id);
        if (!Number.isFinite(id)) continue;
        const tree = deserializeTree(rec.t);
        if (tree && isLegalTree(tree)) this.strategyTrees.set(id, tree);
      }
    }
    // Restore elites archive + goodCounts (Phase 2b, additive). An older payload has neither key ⇒ empty
    // archive + empty counters (they re-converge from live data). Only restored when elites is ON.
    this.elitesArchive = new ElitesArchive();
    this.goodCounts = new Map();
    if (this.elitesOn()) {
      if (p.elitesArchive) this.elitesArchive = ElitesArchive.deserialize(p.elitesArchive);
      // L14: prune ghost elites whose agentId is no longer a live, funded wallet (agents/dead are both
      // restored above). Keeps the novelty filter's fitness baseline honest; cells re-converge from live data.
      this.elitesArchive.prune((id) => this.indexOfId.has(id) && !this.dead.has(id));
      if (Array.isArray(p.goodCounts)) {
        for (const rec of p.goodCounts) {
          if (!rec || typeof rec !== "object") continue;
          const id = Number(rec.id);
          if (!Number.isFinite(id)) continue;
          const g = Array.isArray(rec.g) && rec.g.length === 4
            ? [Number(rec.g[0]) || 0, Number(rec.g[1]) || 0, Number(rec.g[2]) || 0, Number(rec.g[3]) || 0] as [number, number, number, number]
            : [0, 0, 0, 0] as [number, number, number, number];
          this.goodCounts.set(id, g);
        }
      }
    }
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

  /**
   * Best-effort: pin a receipt's canonical body to IPFS and return its CID (null when no pinner is wired or
   * the pin failed). The body is canonical(receipt) — the EXACT bytes whose sha256 is receiptHash — so a
   * verifier who fetches the CID from any gateway recomputes the on-chain hash trustlessly. NEVER throws:
   * pinning is an availability nicety and must not abort or delay a settlement that already mined.
   */
  private async pinReceipt(receipt: NetReceipt, receiptHash: string): Promise<string | null> {
    if (!this.pinner) return null;
    try {
      return await this.pinner.pin(canonical(receipt), receiptHash);
    } catch {
      return null;
    }
  }

  /**
   * Re-anchor the off-chain proof-chain head to the registry's TRUE on-chain head. If a past registry commit
   * failed, proofChainHead drifts from the on-chain chainHead; because the contract enforces prevHead==chainHead,
   * every later commit would then revert (BadPrevHead) forever — the chain wedges. Adopting the on-chain head
   * resumes it from where it actually is. Best-effort and safe: a null read (no registry / RPC blip) is a no-op,
   * and an all-zero head means the registry is still empty — that genesis case is the facilitator's
   * ensureGenesisSeeded job, not ours, so we leave proofChainHead untouched.
   */
  private async resyncChainHeadFromRegistry(): Promise<void> {
    const onchain = await this.registryChainHead();             // 0x…64, or null when unwired/unreadable
    if (!onchain) return;
    const head = onchain.replace(/^0x/, "").toLowerCase();
    if (head.length !== 64 || head === "0".repeat(64)) return;  // empty registry → lazy genesis seeds it
    if (head !== this.proofChainHead.toLowerCase()) this.proofChainHead = head;
  }

  /**
   * Commit a PREDICTION-ROUND receipt to the on-chain registry, chaining it onto the SAME linear head the
   * net receipts use (the contract enforces prevHead == chainHead, so there is one chain, not two). A
   * round receipt is NOT an EIP-3009 transfer nonce, so txHash is "0x" — the registry still records it
   * (ts != 0 proves it landed) and a verifier distinguishes resolutions from settlements by txHash == 0.
   *
   * SAFETY: the off-chain head advances ONLY when the registry commit actually mined. If it fails, the
   * head stays put so the next net receipt's prevHead still equals the on-chain head — a failed round
   * commit can never desync the chain. Returns the commit tx hash, or null (no registry / not committed).
   */
  async commitRoundReceipt(receiptHash: string, tickIndex: number, constituents: number): Promise<string | null> {
    // Re-anchor first. A round receipt deliberately does NOT embed prevHead (see prediction.ts roundReceipt), so
    // adopting the on-chain head here cannot invalidate its hash — it only makes the prevHead we pass match what
    // the contract enforces continuity against. flush() resyncs too, but a cron can resolve a round without
    // flushing any net, so the round commit must be able to re-anchor on its own.
    await this.resyncChainHeadFromRegistry();
    const commitTx = await this.commitToRegistry(receiptHash, this.proofChainHead, tickIndex, constituents, "0x");
    if (commitTx) this.proofChainHead = receiptHash;
    return commitTx;
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
   * Settlement-rail telemetry since boot (circle/relay counts, breaker state, gas spend). The keyless
   * simulator has no read-out ⇒ null, so /economy stays byte-identical in simulated mode. Observe-only.
   */
  get facilitatorStats(): FacilitatorStats | null {
    const f = this.facilitator as { statsReadout?: () => FacilitatorStats };
    return typeof f.statsReadout === "function" ? f.statsReadout() : null;
  }

  /**
   * Decode ANY mined Arc tx's EIP-3009 authorization trustlessly (powers /x402/verify). Null when the
   * facilitator can't do it (simulator) or the tx isn't a transferWithAuthorization.
   */
  async authorizationProofOf(txHash: string): Promise<import("./x402.js").AuthorizationProof | null> {
    const f = this.facilitator as {
      authorizationProofOf?: (t: string) => Promise<import("./x402.js").AuthorizationProof | null>;
    };
    if (typeof f.authorizationProofOf !== "function") return null;
    return f.authorizationProofOf(txHash);
  }

  /**
   * Seller-funded refund leg (PULSE_REFUNDS dark-deploy rail; inert unless a caller explicitly invokes).
   * Null when unwired (simulator) — callers treat null as "refunds not available", never as a failure.
   */
  async refundBuyer(a: { to: string; valueAtomic: string; network: string; shadow?: boolean }): Promise<SettleResponse | null> {
    const f = this.facilitator as {
      refundBuyer?: (x: { to: string; valueAtomic: string; network: string; shadow?: boolean }) => Promise<SettleResponse>;
    };
    if (typeof f.refundBuyer !== "function") return null;
    return f.refundBuyer(a);
  }

  // ---------- human-vs-swarm prediction arena (on-chain, MURMUR-denominated, non-custodial) ----------
  //
  // Thin, best-effort delegators to the facilitator's arena wiring (see x402.ts). The Worker acts only as
  // the authorized resolver that commits each round's baseline + exit temperature; the contract escrows
  // bets and pays winners, and derives the outcome itself. Every call degrades to null when no arena is
  // wired or the chain call fails, so the arena can never block or fail a live tick.

  /** Open an arena round on-chain (commits its baseline temperature); null when unwired/failed. */
  async arenaOpen(roundId: number, entryTempR6: number, flatBandR6: number, betDeadline: number): Promise<string | null> {
    const f = this.facilitator as {
      arenaOpen?: (id: number, entryTempR6: number, flatBandR6: number, betDeadline: number) => Promise<string | null>;
    };
    if (typeof f.arenaOpen !== "function") return null;
    try { return await f.arenaOpen(roundId, entryTempR6, flatBandR6, betDeadline); } catch { return null; }
  }

  /** Resolve an arena round on-chain (supplies only the exit temperature); null when unwired/failed. */
  async arenaResolve(roundId: number, exitTempR6: number): Promise<string | null> {
    const f = this.facilitator as { arenaResolve?: (id: number, exitTempR6: number) => Promise<string | null> };
    if (typeof f.arenaResolve !== "function") return null;
    try { return await f.arenaResolve(roundId, exitTempR6); } catch { return null; }
  }

  /** Read an arena round's live on-chain state for the /arena endpoint; null when unwired/unreadable. */
  async arenaRoundInfo(roundId: number): Promise<ArenaRoundInfo | null> {
    const f = this.facilitator as { arenaRoundInfo?: (id: number) => Promise<ArenaRoundInfo | null> };
    if (typeof f.arenaRoundInfo !== "function") return null;
    try { return await f.arenaRoundInfo(roundId); } catch { return null; }
  }

  // ---------- proof of continuous agency (on-chain mirror of the cron-digest epoch chain) ----------
  //
  // Thin, best-effort delegators to the facilitator's ContinuityRegistry wiring (see x402.ts). The PoCA engine
  // (poca.ts) calls these to mirror its off-chain epoch lifecycle on-chain: open an epoch (pinning the code
  // commitment + genesis head), seal an epoch (Merkle root over its digests), and log each administrative
  // discontinuity. Every delegator degrades to null when the registry is unwired / zero-address (DISABLED
  // mode) or the chain call fails, so PoCA can NEVER block or fail a live tick — exactly the arenaOpen
  // discipline. The off-chain epoch chain is authoritative and runs identically either way.

  /** True when an on-chain PoCA registry is wired (non-zero); false ⇒ the engine runs off-chain only. */
  get pocaOnchainEnabled(): boolean {
    const f = this.facilitator as { hasPoca?: boolean };
    return f.hasPoca === true;
  }

  /** Open a PoCA epoch on-chain (pins codeCommitment + genesisHead); tx hash, or null when disabled/failed. */
  async pocaOpenEpoch(codeCommitment: string, genesisHead: string): Promise<string | null> {
    const f = this.facilitator as { pocaOpenEpoch?: (cc: string, gh: string) => Promise<string | null> };
    if (typeof f.pocaOpenEpoch !== "function") return null;
    try { return await f.pocaOpenEpoch(codeCommitment, genesisHead); } catch { return null; }
  }

  /** Seal a PoCA epoch on-chain (Merkle root over its digests); tx hash, or null when disabled/failed. */
  async pocaSealEpoch(epochIndex: number, sealedHead: string, tickCount: number, merkleRoot: string): Promise<string | null> {
    const f = this.facilitator as {
      pocaSealEpoch?: (i: number, head: string, ticks: number, root: string) => Promise<string | null>;
    };
    if (typeof f.pocaSealEpoch !== "function") return null;
    try { return await f.pocaSealEpoch(epochIndex, sealedHead, tickCount, merkleRoot); } catch { return null; }
  }

  /** Log a PoCA admin discontinuity on-chain (kind 1–7 + payloadHash); tx hash, or null when disabled/failed. */
  async pocaAdminAction(kind: number, payloadHash: string): Promise<string | null> {
    const f = this.facilitator as { pocaAdminAction?: (kind: number, payloadHash: string) => Promise<string | null> };
    if (typeof f.pocaAdminAction !== "function") return null;
    try { return await f.pocaAdminAction(kind, payloadHash); } catch { return null; }
  }

  /** Read the registry's authorized committer address (the wallet it expects writes from); null when disabled. */
  async pocaCommitter(): Promise<string | null> {
    const f = this.facilitator as { pocaCommitter?: () => Promise<string | null> };
    if (typeof f.pocaCommitter !== "function") return null;
    try { return await f.pocaCommitter(); } catch { return null; }
  }

  /** Read the registry's on-chain epoch counter (the next index openEpoch assigns); null when disabled/failed.
   *  The PoCA engine uses it to verify local/chain index alignment before mirroring an open/seal. */
  async pocaEpochCount(): Promise<number | null> {
    const f = this.facilitator as { pocaEpochCount?: () => Promise<number | null> };
    if (typeof f.pocaEpochCount !== "function") return null;
    try { return await f.pocaEpochCount(); } catch { return null; }
  }

  // ---------- on-chain house WAR + TAXATION (real-USDC coffer; the contract derives the winner) ----------
  //
  // Thin, best-effort delegators to the facilitator's WarCoffer wiring (see x402.ts) + the ledger-side MIRROR
  // of the coffer. The Worker is only the authorized resolver: it funds vaults, triggers declare/resolve and
  // posts the extra tax levy, and the coffer escrows the stakes, derives the winner from committed powers and
  // moves the money itself. Every delegator degrades to null when no coffer is wired (simulated mode) or the
  // chain call fails, so a war can NEVER block or fail a live tick — exactly the arenaOpen discipline. The
  // mirrors (vaultOnchainAtomic / warTaxAtomic) are refreshed only from a MINED op's live contract read, so
  // they track the coffer and never invent spendable balance; members' own wallets are untouched by war.

  /** Fund a house's on-chain vault (atomic USDC); null when unwired / capped / failed. */
  async cofferDeposit(houseId: number, amountAtomic: string): Promise<string | null> {
    const f = this.facilitator as { cofferDeposit?: (id: number, amt: bigint) => Promise<string | null> };
    if (typeof f.cofferDeposit !== "function") return null;
    let amt: bigint;
    try { amt = BigInt(amountAtomic); } catch { return null; }
    try { return await f.cofferDeposit(houseId, amt); } catch { return null; }
  }

  /** Declare a war on-chain (escrow both stakes + commit powers); null when unwired / reverted / failed. */
  async declareWarOnchain(a: {
    warId: number; attacker: number; defender: number; stakeAtomic: string; powerA: number; powerB: number; deadline: number;
  }): Promise<string | null> {
    const f = this.facilitator as {
      declareWar?: (x: { warId: number; attacker: number; defender: number; stakeAtomic: bigint; powerA: number; powerB: number; deadline: number }) => Promise<string | null>;
    };
    if (typeof f.declareWar !== "function") return null;
    let stake: bigint;
    try { stake = BigInt(a.stakeAtomic); } catch { return null; }
    try {
      return await f.declareWar({ warId: a.warId, attacker: a.attacker, defender: a.defender, stakeAtomic: stake, powerA: a.powerA, powerB: a.powerB, deadline: a.deadline });
    } catch { return null; }
  }

  /** Resolve a due war on-chain (the coffer derives the winner); null when unwired / reverted / failed. */
  async resolveWarOnchain(warId: number): Promise<string | null> {
    const f = this.facilitator as { resolveWar?: (id: number) => Promise<string | null> };
    if (typeof f.resolveWar !== "function") return null;
    try { return await f.resolveWar(warId); } catch { return null; }
  }

  /** Levy an extra on-chain tax from a house vault into the commons purse; null when unwired / failed. */
  async levyTaxOnchain(houseId: number, amountAtomic: string): Promise<string | null> {
    const f = this.facilitator as { levyTax?: (id: number, amt: bigint) => Promise<string | null> };
    if (typeof f.levyTax !== "function") return null;
    let amt: bigint;
    try { amt = BigInt(amountAtomic); } catch { return null; }
    try { return await f.levyTax(houseId, amt); } catch { return null; }
  }

  /** Sweep the commons purse into the dominant house vault (taxDest === "dominant"); null when unwired / failed. */
  async sweepTaxOnchain(houseId: number): Promise<string | null> {
    const f = this.facilitator as { sweepTax?: (id: number) => Promise<string | null> };
    if (typeof f.sweepTax !== "function") return null;
    try { return await f.sweepTax(houseId); } catch { return null; }
  }

  /** Read a war's live on-chain state for the /war endpoint; null when unwired / unreadable. */
  async warInfoOnchain(warId: number): Promise<WarInfo | null> {
    const f = this.facilitator as { warInfo?: (id: number) => Promise<WarInfo | null> };
    if (typeof f.warInfo !== "function") return null;
    try { return await f.warInfo(warId); } catch { return null; }
  }

  /** Read a house's on-chain vault (atomic USDC string) to refresh the ledger mirror; null when unwired. */
  async cofferVaultOnchain(houseId: number): Promise<string | null> {
    const f = this.facilitator as { cofferVault?: (id: number) => Promise<string | null> };
    if (typeof f.cofferVault !== "function") return null;
    try { return await f.cofferVault(houseId); } catch { return null; }
  }

  /** Read the coffer's aggregate totals for the /war endpoint; null when unwired / unreadable. */
  async cofferStatsOnchain(): Promise<WarCofferStats | null> {
    const f = this.facilitator as { cofferStats?: () => Promise<WarCofferStats | null> };
    if (typeof f.cofferStats !== "function") return null;
    try { return await f.cofferStats(); } catch { return null; }
  }

  /**
   * Refresh a house's on-chain vault MIRROR from a live coffer read after a mined war op. A no-op when the
   * house is unknown or the read failed (null), so a non-landed move leaves the ledger exactly as it was.
   */
  setVaultOnchain(houseId: number, atomic: string | null): void {
    const h = this.houses.get(houseId);
    if (!h) return;
    if (atomic == null || !/^\d+$/.test(atomic)) return;
    h.vaultOnchainAtomic = atomic;
  }

  /** Bump the cumulative extra-tax MIRROR after a MINED levy (the real USDC already moved inside the coffer). */
  addWarTax(atomic: string): void {
    if (!/^\d+$/.test(atomic)) return;
    this.warTaxAtomic = addAtomic(this.warTaxAtomic, atomic);
  }

  /** The persisted cumulative extra-tax mirror (USDC) for the /war endpoint. */
  warTaxCollectedUsdc(): number {
    return atomicToUsdc(this.warTaxAtomic);
  }

  /**
   * Every house reduced to war.ts's WarHouse read-out (never a neuron/genome). Unlike the prestige-sliced
   * dynasty read-out this returns ALL houses, since a feuding house outside the top-8 is still a valid target.
   */
  warHouses(): WarHouse[] {
    const pot = this.swarmPot();
    return Array.from(this.houses.values())
      .sort((x, y) => x.id - y.id)
      .map((h) => {
        const r = this.houseRowFor(h, pot);
        const row: WarHouse = { id: r.id, live: r.live, gen: r.gen, earnedUsdc: r.earnedUsdc, capitalShare: r.capitalShare, vaultOnchainUsdc: r.vaultOnchainUsdc ?? 0 };
        // territory-additive: how many zones this house controls, so housePower can weight held ground. houseRowFor
        // emits controlsZones ONLY while the layer is on, so the key is absent (not 0) when off ⇒ byte-for-byte power.
        if (r.controlsZones) row.zonesControlled = r.controlsZones.length;
        return row;
      });
  }

  /**
   * TERRITORY CONQUEST (ledger-only; the write side of the war↔territory bridge, called by driveWar on a
   * resolved war). Re-point EVERY zone the loser controls to the winner and return the sorted list of zones
   * that changed hands — empty when the layer is off, the two ids match, the winner is not a known house, or
   * the loser already holds nothing (so a double-seize is a no-op). This moves NO money: the war pot already
   * settled on-chain, conquest only rewrites zoneControl. The loser is left landless ⇒ EXILED (applyTerritory
   * then charges it the amplified toll everywhere and grants no home discount), while the winner enjoys the
   * domestic discount + tribute on the annexed ground. The loser keeps its homeZone MEMORY (HouseRecord.homeZone)
   * but no longer controls it, and ensureTerritory never re-grants a zone someone else holds ⇒ the conquest is
   * stable across restarts and idempotent within a cron.
   */
  seizeZones(loserHouseId: number, winnerHouseId: number): number[] {
    if (!this.territoryOn()) return [];
    if (loserHouseId === winnerHouseId) return [];
    if (!this.houses.has(winnerHouseId)) return [];   // never orphan control to a non-existent house
    const seized = this.zonesControlledBy(loserHouseId);
    for (const z of seized) this.zoneControl.set(z, winnerHouseId);
    return seized;
  }

  /**
   * Aggregate the swarm's directed member bonds into CROSS-house feud scores, deepest feud first. A pure
   * read-out of persisted social memory + kinship; it never feeds back. Same-house and commoner links are
   * ignored, so only genuine house-vs-house animosity shows.
   *
   * Two regimes, chosen by the conflict switch's feudBlend:
   *   • blend == 0 (conflict OFF, or FEUD_BLEND=0): score = the MEAN of every cross-house bond — byte-for-byte
   *     the historical behaviour. A lone deep grudge is diluted by the mountain of friendly trade bonds, which
   *     is exactly why a war could never surface on-chain.
   *   • blend >  0 (conflict ON): score = (1-blend)*mean + blend*(mean of the K deepest bonds for the pair), so a
   *     genuine cluster of grudges can pull a house-vs-house feud down toward the -0.6 war line despite goodwill
   *     elsewhere. K = FEUD_WORST_K. Raw (un-faded) bond scores are used in BOTH regimes for byte-identity.
   */
  houseFeuds(): HouseFeud[] {
    const blend = this.conflictOn() ? Math.max(0, Math.min(1, this.cfg.conflict!.feudBlend)) : 0;
    const agg = new Map<string, { a: number; b: number; sum: number; n: number; worst: number[] }>();
    for (const [id, mem] of this.social.entries()) {
      const houseA = this.kin.get(id)?.house;
      if (houseA == null) continue;
      for (const b of mem.bonds) {
        const houseB = this.kin.get(b.other)?.house;
        if (houseB == null || houseB === houseA) continue;
        const lo = Math.min(houseA, houseB);
        const hi = Math.max(houseA, houseB);
        const key = `${lo}-${hi}`;
        const cur = agg.get(key) ?? { a: lo, b: hi, sum: 0, n: 0, worst: [] };
        cur.sum += b.score;
        cur.n++;
        if (blend > 0) {
          cur.worst.push(b.score);
          if (cur.worst.length > FEUD_WORST_K) {   // keep only the FEUD_WORST_K most negative (deepest grudges)
            cur.worst.sort((x, y) => x - y);
            cur.worst.length = FEUD_WORST_K;
          }
        }
        agg.set(key, cur);
      }
    }
    const out: HouseFeud[] = [];
    for (const v of agg.values()) {
      if (v.n <= 0) { out.push({ a: v.a, b: v.b, score: 0 }); continue; }
      const mean = v.sum / v.n;
      let score = mean;
      if (blend > 0) {
        v.worst.sort((x, y) => x - y);
        const worstMean = v.worst.length > 0 ? v.worst.reduce((x, y) => x + y, 0) / v.worst.length : mean;
        score = (1 - blend) * mean + blend * worstMean;
      }
      out.push({ a: v.a, b: v.b, score });
    }
    out.sort((x, y) => x.score - y.score || x.a - y.a || x.b - y.b);
    return out;
  }

  /**
   * Commit one bred genome + its ancestry to the on-chain ConnectomeLineage log (best-effort). Delegates to
   * the facilitator when it is wired with a lineage contract; null when simulated / no contract / failed.
   */
  async commitLineage(a: {
    genomeHash: string; parentA: string; parentB: string; op: 0 | 1 | 2; generation: number; breeder: string;
  }): Promise<string | null> {
    const f = this.facilitator as { commitLineage?: (arg: {
      genomeHash: string; parentA: string; parentB: string; op: 0 | 1 | 2; generation: number; breeder: string;
    }) => Promise<string | null> };
    if (typeof f.commitLineage !== "function") return null;
    try { return await f.commitLineage(a); } catch { return null; }
  }

  /** Read one committed genome's on-chain ancestry (null when unwired / not committed / unreadable). */
  async lineageOf(genomeHash: string): Promise<{
    parentA: string; parentB: string; op: number; generation: number; breeder: string; ts: number;
  } | null> {
    const f = this.facilitator as { lineageOf?: (h: string) => Promise<{
      parentA: string; parentB: string; op: number; generation: number; breeder: string; ts: number;
    } | null> };
    if (typeof f.lineageOf !== "function") return null;
    try { return await f.lineageOf(genomeHash); } catch { return null; }
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
