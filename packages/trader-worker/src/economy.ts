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
  type ArenaRoundInfo,
  type WarInfo,
  type WarCofferStats,
} from "./x402.js";
import type { WarHouse, HouseFeud } from "./war.js";
import type { Fap } from "@fly/fly-brain";
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
  houses: { id: number; name: string; sigil: string; gen: number; foundedTick: number; members: number; live: number; deaths: number; treasuryUsdc: number; earnedUsdc: number; capitalShare: number; tradition: string | null; vaultOnchainUsdc?: number }[];
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
  /** Bounded social-memory read-out: reputations, strongest bonds, the grudge book. Pure read-out. */
  social: SocialReadout;
  /** Bounded dynasty read-out: houses, graves, living/dead counts. Additive — pure read-out. */
  dynasty?: DynastyReadout;
  /** Bounded institutions read-out: professions, classes, credit, mark tapes. Additive — pure read-out. */
  market?: MarketReadout | null;
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
}

const KEY_VERSION = "economy:v1";
const RECENT_CAP = 48;
// --- social-memory tuning (all deterministic; sizes are hard caps so DO storage stays bounded) ---
const BOND_TOP_K = 8;                    // directed bonds remembered per agent (top-K by |score|/trades)
const BOND_HALF_LIFE = 30000;            // sub-ticks until an untouched bond fades to half (~28h)
const REP_HALF_LIFE = 60000;             // reputation forgets slower than a single bond (~56h)
const GRUDGE_CAP = 24;                   // grudge book ring size
const BOND_TRADE_STEP = 0.08;            // trust earned per settled deal
const BOND_BETRAY_STEP = 0.55;           // grudge taken by the stiffed seller
const REP_KEEP_STEP = 0.05;              // reputation for paying/delivering as promised
const REP_BETRAY_STEP = 0.35;            // reputation lost when defaulting (simulated stiff)
const REP_FAIL_STEP = 0.1;               // reputation lost on an onchain failed net (lighter: could be rails)
const BOND_BLACKLIST = -0.6;             // bond at or below this ⇒ flat-out refusal ("never trade with #N")
const ALLIANCE_MIN_TRADES = 8;           // a partnership is only chronicle-worthy once seasoned
const PICK_CANDIDATES = 5;               // pool size re-weighted inside the neural span
/** How many neural-provenance receipts to keep published (newest first) for /proofs + the chain. */
const PROOFS_CAP = 64;
// --- dynasty tuning (all deterministic; every collection is a hard cap so DO storage stays bounded) ---
const HOUSE_CAP = 16;                   // simultaneous houses at most (older houses endure, no new names past it)
const HOUSE_MEMBERS_CAP = 200;           // roster cap per house (a house is bounded memory, not a nation)
const HOUSE_TITHE = 0.02;                // 2% of a member's settled income flows to the common treasury
const GRAVE_CAP = 24;                    // epitaph ring size (newest first)
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
  private treasuryOutAtomic = "0";
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
  private graves: GraveRecord[] = [];
  private dead = new Set<number>();

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

    // INSTITUTIONS: before the first buyer crosses, rebuild THIS tick's limit books from the very
    // readings the loop is about to consume — depth, slope and spread become behavioural facts, and
    // the deal price is where the buyer eats, not what a formula decrees. Inert while the switch is
    // off: dealAmount then computes the original fixed formula byte-for-byte.
    if (this.institutionsOn()) {
      this.buildBooks(readings, T, tickIndex);
      // Professions ride the same switch: identities read off fap history that tilt economic intent only.
      this.stepProfessions(readings, tickIndex);
    }

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
    // INSTITUTIONS: the credit cycle runs FIRST — repayments and recalls move existing money only, so
    // the treasury top-up still sees who genuinely fell below the floor after debts were settled.
    if (this.institutionsOn()) made.push(...this.creditCycle(tickIndex, readings));
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
    const amount = this.dealAmount(r, T, good, this.institutionsOn() ? this.profs.get(buyer.id)?.role ?? null : null);
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
        if (!verified.valid) {
          // A net that fails verification on-chain dents the debtor's reputation (light: rails can fail
          // for non-moral reasons, so this is a smudge, not a grudge — the book stays for true stiffs).
          this.settleFail++;
          this.rememberFailedPayment(debtor.id, creditor.id, tickIndex);
          out.push({ ...base, txHash: "0x", valid: false, reason: verified.invalidReason ?? "verify-failed" }); break;
        }
        const receipt = await this.facilitator.settle(payload, reqs);
        if (receipt.shadow) { out.push({ ...base, txHash: "0x", valid: false, reason: "shadow-dry-run" }); break; }
        if (!receipt.success) {
          this.settleFail++;
          this.rememberFailedPayment(debtor.id, creditor.id, tickIndex);
          out.push({ ...base, txHash: receipt.txHash || "0x", valid: false, reason: receipt.invalidReason ?? "settle-failed" }); break;
        }
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
        this.settleOk++;
        // The mined net IS the settled history reputation is made of: both sides keep the promise.
        this.rememberTrade(debtor.id, creditor.id, tickIndex);
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
   */
  private buyProbability(r: FlyReading, T: number, role: Profession | null = null): number {
    const stateBase =
      r.state === "AGITATE" ? 0.9 :
      r.state === "EXPLORE" ? 0.7 :
      r.state === "AGGREGATE" ? 0.5 : 0.12;   // REST barely participates
    const arousal = 0.5 + 0.5 * clamp01(r.arousal);
    const wing = 0.85 + 0.3 * clamp01(r.wingbeat);
    const rest = 1 - 0.6 * clamp01(r.rest);
    const base = stateBase * arousal * wing * rest * (0.6 + 0.4 * T);
    return clamp01(role ? base * PROF_BUY[role] : base);
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
    const picks: number[] = [];
    const weights: number[] = [];
    let total = 0;
    for (const idx of pool) {
      const cand = this.agents[idx];
      if (!cand || this.dead.has(cand.id)) continue;   // you cannot buy from a grave
      const bond = this.effectiveBond(r.id, cand.id, tick);
      if (bond <= BOND_BLACKLIST) continue;   // the grudge vetoes; the neurons never notice
      const rep = this.effectiveRep(cand.id, tick);
      const w = Math.max(0.05, 1 + 0.6 * bond + 0.4 * rep);
      picks.push(idx);
      weights.push(w);
      total += w;
    }
    if (picks.length === 0) return -1;   // every candidate in the span is shunned: hold back this tick
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

  /** Fetch (creating on first touch) one agent's social-memory record. */
  private memOf(id: number): AgentSocial {
    let m = this.social.get(id);
    if (!m) { m = { rep: 0, repTick: -1, kept: 0, broken: 0, bonds: [] }; this.social.set(id, m); }
    return m;
  }

  /** The bond `id` currently holds toward `other` at `tick` (−1 grudge .. +1 old partner; 0 = no past). */
  private effectiveBond(id: number, other: number, tick: number): number {
    const b = this.social.get(id)?.bonds.find((x) => x.other === other);
    return b ? AgentEconomy.clampSigned(AgentEconomy.fade(b.score, b.lastTick, tick, BOND_HALF_LIFE)) : 0;
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
    bond.score = AgentEconomy.clampSigned(AgentEconomy.fade(bond.score, bond.lastTick, tick, BOND_HALF_LIFE) + delta);
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
        const s = AgentEconomy.clampSigned(AgentEconomy.fade(b.score, b.lastTick, tick, BOND_HALF_LIFE));
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
   *     fly that once bore this id. Known trade-off: SOCIAL memory (rep/bonds/grudges) and institutions
   *     stay keyed by the reused id/address — a deliberate scope cut, since those are trust-scores on the
   *     SAME purse and this ledger never mints; a full per-(id,bornTick) social split is a future step.
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
    // birth. Reopen it FIRST — clear its tombstone, reset its wallet to a fresh newborn, and sever it from
    // its PREVIOUS house/children — so the reborn individual is ledger-clean before it is born into the NEW
    // parent's line below. A brand-new offspring id was never dead, so this is a no-op on the normal path.
    if (this.dead.has(childId)) this.reopenSlot(childId, this.cfg.hatchSeedUsdc);
    const parent = this.kinOf(parentId);
    const child = this.kinOf(childId);
    child.bornTick = this.tickIndex;
    child.gen = parent.gen + 1;
    if (parent.children.length < CHILD_CAP) parent.children.push(childId);
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
    };
    this.houses.set(house.id, house);
    parent.house = house.id;
    child.house = house.id;
    return { houseId: house.id, name: house.name, sigil: house.sigil, childId, founded: true };
  }

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
    if (heirIds.length === 0 && house && estate > 0n) {
      house.treasury = addAtomic(house.treasury, estate.toString());
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
    return { houses: houses.slice(0, 8), graves, living, dead: this.dead.size, ...(war ? { war } : {}) };
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
   */
  private dealAmount(r: FlyReading, T: number, good: GoodKind, role: Profession | null = null): string {
    const meta = GOOD_META[good];
    const tilt = role ? PROF_DEAL[role] : 1;
    if (this.institutionsOn()) {
      const crossed = this.books.eatAsk(good);
      if (crossed) return String(Math.max(1, Math.round(Number(crossed) * tilt)));
    }
    const priceUsdc =
      this.cfg.basePriceUsdc * (0.5 + T) * (0.6 + 0.6 * clamp01(r.arousal)) * meta.priceMult;
    return String(Math.max(1, Math.round(priceUsdc * 1e6 * tilt)));
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
    const amount = this.dealAmount(r, T, good, this.institutionsOn() ? this.profs.get(buyer.id)?.role ?? null : null);

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
    // Dynasty tithe: the seller's house (if any) takes its cut of the earned income, straight from the
    // balance the seller just grew. Pure ledger movement inside the already-committed transfer above.
    this.titheHouse(seller.id, amount);

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
        richestId, poorestId,
      },
    };
  }

  /** A compact summary folded into /population so the frontend gets edges + totals in one poll. */
  summary(): {
    lastTick: Settlement[]; totals: EconomyTotals; balances: Record<number, string>;
    social: SocialReadout; dynasty?: DynastyReadout;
  } {
    const snap = this.snapshot();
    const balances: Record<number, string> = {};
    for (const a of this.agents) balances[a.id] = a.balance;
    return { lastTick: snap.lastTick, totals: snap.totals, balances, social: snap.social, dynasty: snap.dynasty };
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
      treasuryOutAtomic: this.treasuryOutAtomic,
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
    this.treasuryOutAtomic = String(p.treasuryOutAtomic ?? "0");
    // WAR mirror: an older payload has no warTaxAtomic ⇒ "0" (no tax ever levied), KEY_VERSION stays v1.
    this.warTaxAtomic = /^\d+$/.test(String(p.warTaxAtomic ?? "")) ? String(p.warTaxAtomic) : "0";
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
        return { id: r.id, live: r.live, gen: r.gen, earnedUsdc: r.earnedUsdc, capitalShare: r.capitalShare, vaultOnchainUsdc: r.vaultOnchainUsdc ?? 0 };
      });
  }

  /**
   * Aggregate the swarm's directed member bonds into CROSS-house feud scores (mean bond across every member
   * pair straddling two houses), deepest feud first. A pure read-out of persisted social memory + kinship; it
   * never feeds back. Same-house and commoner links are ignored, so only genuine house-vs-house animosity shows.
   */
  houseFeuds(): HouseFeud[] {
    const agg = new Map<string, { a: number; b: number; sum: number; n: number }>();
    for (const [id, mem] of this.social.entries()) {
      const houseA = this.kin.get(id)?.house;
      if (houseA == null) continue;
      for (const b of mem.bonds) {
        const houseB = this.kin.get(b.other)?.house;
        if (houseB == null || houseB === houseA) continue;
        const lo = Math.min(houseA, houseB);
        const hi = Math.max(houseA, houseB);
        const key = `${lo}-${hi}`;
        const cur = agg.get(key) ?? { a: lo, b: hi, sum: 0, n: 0 };
        cur.sum += b.score;
        cur.n++;
        agg.set(key, cur);
      }
    }
    const out: HouseFeud[] = [];
    for (const v of agg.values()) out.push({ a: v.a, b: v.b, score: v.n > 0 ? v.sum / v.n : 0 });
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
