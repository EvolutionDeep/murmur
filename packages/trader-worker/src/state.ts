// MurmurDO — the Durable Object behind the Arc fly population + its agent economy.
//
// This project OBSERVES Arc whole-chain activity, reduces it to a market temperature (HOT / CALM /
// COLD), and lets a population of spiking-neuron flies FEEL that temperature and react — collectively
// (the whole swarm's mood tracks the regime) and individually (each fly's own connectome decides how
// strongly it reacts and whether it breaks rank).
//
// On top of that reactive layer sits an AGENT ECONOMY (economy.ts + x402.ts): every fly is an
// autonomous economic agent whose neural drives decide what to buy and from whom, and the agents
// settle with each other over x402 micropayments in USDC. By DEFAULT settlement is SIMULATED and
// KEYLESS — the Worker holds no wallet, no key and signs nothing. Real EIP-3009 settlement is OPT-IN:
// it activates ONLY when ECONOMY_FACILITATOR="onchain" AND the ECONOMY_MNEMONIC secret is present, at
// which point buildOnchainDeps() HD-derives the agent wallets + gas wallet and wires them in behind the
// economy's kill switch, daily spend caps, per-deal cap and shadow-only mode. Requested-but-unwireable
// (onchain without a seed) it degrades LOUDLY back to the keyless simulator — it can never half-enable.
//
// Storage layout (this coordinator DO):
//   population:v3      single-DO swarm: JSON of Population.serialize() (every fly's brain).
//   coordinator:v1     sharded swarm (SHARD_COUNT>1): just the {tickIndex, vitality} counter here, while
//                      each FlyShardDO persists its own slice of brains under shardPopulation:v1 in its
//                      own isolate — see swarm.ts (the backend seam) and shard.ts (the shard DO).
//   marketMeter:v1     MarketMeter.toJSON() (the learned activity baseline, survives restarts)
//   market:v1          the last MarketState (temperature / regime / sample) for fast reads
//   lastSnapshot:v1    the last PopulationSnapshot (collective + per-fly drives) the frontend polls
//   economy:v1         JSON of AgentEconomy.serialize() (agent wallets + ledger + totals)
//   prevTemperature    number — the previous tick's temperature (drives the pulse momentum facet)
//   stimuli            StoredStimulus[] (capped) — the visitor "poke the swarm" log
//   lastCron           number

import type { StimulusEvent } from "@fly/fly-brain";
import { genomeWithinBudget, hatchBudgetFromGenesis } from "@fly/fly-brain";
import type { Env, RuntimeConfig } from "./config.js";
import { loadConfig, shardSlice, fliesPerShard } from "./config.js";
import { netReceiptHash } from "./provenance.js";
import { assembleManifest, manifestHash, replayVerifyManifest, type BrainManifest } from "./manifest.js";
import {
  applyBreed,
  genesisLineage,
  genomeHash,
  replayEntry,
  verifyEntryHash,
  type BreedRequest,
  type LineageEntry,
} from "./breed.js";
import { planEvolution, germlineResolver, resolveNovelBreed, lineageAnchorPlan, type EvolutionLimits } from "./evolution.js";
import {
  MarketMeter,
  sampleArcActivity,
  derivePulse,
  type MarketState,
  type Regime,
} from "./market.js";
import {
  handleStimulusVote,
  type StimulusVoteRequest,
  type StimulusVoteResult,
  type StoredStimulus,
} from "./stimulus.js";
import type { FlyReading, PopulationSnapshot } from "./population.js";
import { LocalSwarm, ShardedSwarm, type SwarmBackend } from "./swarm.js";
import { AgentEconomy, type EconomySnapshot, type EconomyConfig, type EconomyDeps, type EconomyTotals, type Settlement, type LeaderRow } from "./economy.js";
import { CultureMembrane } from "./culture.js";
import { FaithMembrane, type FaithSignals } from "./religion.js";
import { TechMembrane, type TechSignals } from "./invention.js";
import { CityMembrane, houseCreditOf, type CitySignals } from "./cities.js";
import { ApprenticeMembrane, type ApprenticeSignals } from "./apprentice.js";
import { ArchiveMembrane, type ArchiveSignals } from "./archive.js";
import { WorkshopMembrane, type WorkshopSignals } from "./workshop.js";
import { BourseMeter, coinStimuli, sampleBourseActivity, type BourseSignals } from "./bourse.js";
import { CourtMembrane, type CourtFacts, type CourtSignals } from "./court.js";
import { GamesMembrane, type GamesFacts, type GamesSignals } from "./games.js";
import { GuildsMembrane, type GuildFacts, type GuildsSignals } from "./guilds.js";
import { LexiconMembrane, type LexiconFacts, type LexiconSignals } from "./lexicon.js";
import { RumorMill, type RumorFacts, type RumorSignals } from "./rumor.js";
import { TreatyMembrane, type TreatyFacts, type TreatySignals } from "./treaty.js";
import { WorksMembrane, type WorksFacts, type WorksSignals } from "./works.js";
import { socialStimuli } from "./socialStimulus.js";
import {
  Poet, poetGrammarHash, recomputePoemHash, replayCompose,
  POET_VERSION, POET_POLICY, POET_HONESTY, type PoemEntry,
} from "./poet.js";
import { CommonsAssembly, type CommonsSeat, type CommonsReadout } from "./commons.js";
import { PinataPinner } from "./ipfs.js";
import { PredictionMarket, type PredictConfig, type PredictFlow, type ResolvedRound } from "./prediction.js";
import { arenaRoundPlan, cursorAfterOpen, tempToR6 } from "./arena.js";
import {
  planWar, cursorAfterWarOpen, housePower, stakeOf, taxLevy, feudPairs, winnerOf, pairKey,
  WIN_ATTACKER, WIN_NONE, type WarCursor,
} from "./war.js";
import { arcNetworkTag, ARC_USDC, makeFacilitator, usdcToAtomic, atomicToUsdc, buildPaymentRequired, b64json, SCHEME_EXACT, X402_VERSION, type PaymentRequirements, type PaymentPayload, type SettleResponse, type ArenaRoundInfo, type WarInfo } from "./x402.js";
import { caip2 } from "./circle.js";
import { publicClient, walletClient } from "./chain.js";
import { deriveAgentKeys } from "./keys.js";
import type { Address, LocalAccount } from "viem";
import { Chronicler, chroniclerRulesHash, CHRONICLE_VERSION, type ChronicleEntry, type ChronicleContext, type ShockKind } from "./chronicler.js";

const KEY_METER = "marketMeter:v1";
const KEY_MARKET = "market:v1";
const KEY_LAST_SNAPSHOT = "lastSnapshot:v1";
const KEY_PREV_TEMP = "prevTemperature";
const KEY_STIMULI = "stimuli";
const KEY_ECONOMY = "economy:v1";
/** Culture membrane (adopted FAP creeds + TTLs) — its OWN key: culture is a read-out overlay, so a
 *  corrupt/absent blob only loses fashions, never ledger state. Bounded (≤64 records), DO-safe. */
const KEY_CULTURE = "culture:v1";
/** ⑪ Faith membrane (god/sect/devotion per fly) — its OWN key: religion is a read-out overlay too, so a
 *  corrupt/absent blob only loses faiths, never ledger state. Bounded (≤64 records), DO-safe. */
const KEY_RELIGION = "religion:v1";
/** ⑬ The ladder of arts (which rungs are in force, who is credited, how far each has diffused) — its OWN key:
 *  a corrupt/absent blob only forgets the arts, never ledger state. Bounded (≤ the twelve rungs), DO-safe. */
const KEY_TECH = "tech:v1";
/** ⑭ The settlement map (which zones have been named, the census accumulators) — its OWN key, same law: a
 *  corrupt/absent blob only forgets the places, never ledger state. Bounded (≤ the sixteen zones), DO-safe. */
const KEY_CITIES = "cities:v1";
/** ⑯ The apprenticeship ledger (which mind carries which art, who taught whom, which schools stand) — its OWN
 *  key, same law: a corrupt/absent blob only forgets the arts people knew, never ledger state. Bounded (≤ the
 *  live population), DO-safe. */
const KEY_APPRENTICE = "apprentice:v1";
const KEY_ARCHIVE = "archive:v1";
const KEY_WORKSHOP = "workshop:v1";
/** ⑳ The Court (live docket, outlaw roll, counts) — its OWN key: a corrupt/absent blob restarts an
 *  empty docket, never ledger state. Bounded (≤ 8 cases / 16 outlaws / 64 matter keys), DO-safe. */
const KEY_COURT = "court:v1";
/** ㉑ The Games (festival roll, standing record, counts) — its OWN key: a corrupt/absent blob restarts an
 *  empty stadium, never ledger state. Bounded (≤ 16 festival eras), DO-safe. */
const KEY_GAMES = "games:v1";
/** ㉒ The Guilds (charter roll, share memory, counts) — its OWN key: a corrupt/absent blob restarts an
 *  empty guildhall, never ledger state. Bounded (≤ 4 seals + 4 shares), DO-safe. */
const KEY_GUILDS = "guilds:v1";
/** ㉓ The Lexicon (coinage desk, dead roll, counts) — its OWN key: a corrupt/absent blob restarts an
 *  empty desk, never ledger state. Bounded (≤ 20 held words + 8 dead), DO-safe. */
const KEY_LEXICON = "lexicon:v1";
/** ㉔ The Rumor Mill (the live tale, its cursor over the roll, counts) — its OWN key: a corrupt/absent
 *  blob restarts a silent market (the boot round seeds the cursor, history is never re-told), never
 *  ledger state. Bounded (one tale + three counters), DO-safe. */
const KEY_RUMOR = "rumor:v1";
/** ㉕ The Treaty (live seals, the ended-roll archive, the per-pair cool, counts) — its OWN key: a
 *  corrupt/absent blob restarts an empty chancery (no seal is back-dated), never ledger state.
 *  Bounded (≤ 6 active + 12 archived + a pruned cool map), DO-safe. */
const KEY_TREATY = "treaty:v1";
/** ㉖ The Public Works yard (the standing works, the ruin archive, the per-kind raise cool, counts) — its
 *  OWN key: a corrupt/absent blob restarts an empty yard, never ledger state. Bounded (≤ 3 standing + 10
 *  archived + a pruned cool map), DO-safe. */
const KEY_WORKS = "works:v1";
/** ⑲ The Bourse (the MURMUR tape's memory: EWMA baselines, tithe total, edge hysteresis) — its OWN key:
 *  a corrupt/absent blob restarts cold (re-learns the norm), never ledger state. Bounded (one small JSON), DO-safe. */
const KEY_BOURSE = "bourse:v1";
const KEY_COMMONS = "commons:v1";
/** ⑮ The Laureate's poem hash chain — its OWN key: a poem is a pure read-out, so a corrupt/absent blob only
 *  forgets the poems, never ledger state. Bounded (≤ POEMS_CAP entries), DO-safe. */
const KEY_POET = "poet:v1";
const KEY_PULSE = "pulse:v1";
const KEY_PREDICT = "predict:v1";
const KEY_ARENA = "arena:v1";
const KEY_WAR = "war:v1";
const KEY_LINEAGE = "lineage:v1";
const KEY_EVOLUTION = "evolution:v1";
const KEY_LAST_CRON = "lastCron";
const MAX_STIMULI = 200;
/** The historian's monotonic trackers + the recent-chronicle ring buffer, both persisted in DO storage.
 *  v2: the entry shape gained the hash-chain fields (tokens/hash/prevHash).
 *  v3: the historian now seeds a mature restart silently (no false "first trade"/milestone re-announcements)
 *  and ERA_OPEN reads honestly for a mid-history start; the version bump + a one-time D1 chronicle wipe clear
 *  the v2 migration's founding-line artifacts so the tamper-proof chain restarts clean from the present. */
const KEY_CHRONICLER = "chronicler:v3";
const KEY_ANNALS = "annals:v3";
/** How many recent chronicle entries to keep hot in the DO (and serve from /annals) — bounded, DO-safe. */
const ANNALS_CAP = 300;
/** Cached /history aggregate (see bumpHistSummary/getHistory): a monotonic running summary kept in the DO so
 *  the history ribbon never has to scan the whole ticks table again. Seeded once from a full aggregate on cold
 *  start, then maintained incrementally per archived tick. Independent of economy state — a /reset that keeps the
 *  D1 archive leaves it valid (the rows it counts are still there). */
const KEY_HIST_SUMMARY = "histSummary:v1";
interface HistSummary {
  n: number;
  firstTick: number | null;
  lastTick: number | null;
  firstTs: number | null;
  lastTs: number | null;
  settlements: number | null;   // lifetime cumulative (monotonic ⇒ running MAX)
  volumeUsdc: number | null;    // lifetime cumulative (monotonic ⇒ running MAX)
}

/** Lifetime stats for the paid x402 "Arc Pulse" signal product (persisted across evictions). */
interface PulseSales {
  sales: number;          // successful paid reads served
  grossAtomic: string;    // cumulative USDC revenue (atomic, 6-dec)
  lastTx: string | null;  // most recent settlement tx hash
  lastBuyer: string | null;
  lastTs: number | null;
}

/** Worker-side cursor for the on-chain human arena: which rounds it has opened/resolved as resolver. */
interface ArenaState {
  openedRound: number;    // last arena roundId openRound() succeeded for (-1 ⇒ none yet)
  resolvedRound: number;  // last arena roundId resolve() succeeded for (-1 ⇒ none yet)
}

/**
 * Worker-side resolver cursor for the on-chain WAR coffer + a per-pair cooldown map, persisted together so a
 * mid-cron DO eviction resumes wars exactly where it left off (never re-declares a bucket, never re-resolves a
 * war, and never lets a freshly-fought pair immediately re-fund). The cursor is war.ts's pure WarCursor; the
 * map keys a canonical "loId-hiId" pair to the unix seconds of its last declaration.
 */
interface WarRuntime {
  cursor: WarCursor;                        // openedWar / resolvedWar high-water marks (-1 ⇒ none yet)
  lastByPair: Record<string, number>;       // pairKey(houseA, houseB) → unix sec of the last declareWar
}

/**
 * Persisted per-UTC-day budget for the autonomous evolution step, so a mid-day DO eviction can't reset the
 * daily breeding count and overspend. Armed (onchain + real spend) evolution only; never written when inert.
 */
interface EvolutionGuard {
  dayKey: string;                    // UTC calendar day ("YYYY-MM-DD") these counters bucket to
  global: number;                    // offspring bred today across the whole swarm
  perAgent: Record<number, number>;  // offspring funded per agent id today
}

/**
 * Lowest VACANT live-population id in [0, cap): the first slot not held by a currently-live fly. With
 * live-retirement this RECYCLES the smallest freed id (reusing its HD wallet + shard slice); when nothing
 * has retired yet it returns the contiguous next id (== the old `size`-based allocation, floored at the first
 * free slot). Returns -1 only when every slot in [0, cap) is occupied (the gate normally catches this first).
 */
export function nextVacantId(occupied: ReadonlySet<number>, cap: number): number {
  for (let id = 0; id < cap; id++) if (!occupied.has(id)) return id;
  return -1;
}

export class FlyStateDO {
  private state: DurableObjectState;
  private env: Env;
  private cfg: RuntimeConfig;
  private swarm: SwarmBackend | null = null;
  private meter: MarketMeter | null = null;
  private economy: AgentEconomy | null = null;
  /** The Lamarckian culture membrane — null while CULTURE_ENABLED=false (byte-for-byte inert). */
  private culture: CultureMembrane | null = null;
  /** ⑪ The faith membrane — null while RELIGION_ENABLED=false (byte-for-byte inert). */
  private religion: FaithMembrane | null = null;
  /** ⑬ The tech membrane (the ladder of arts) — null while TECH_ENABLED=false (byte-for-byte inert). */
  private tech: TechMembrane | null = null;
  /** ⑭ The city membrane (settlements + the census) — null while CITIES_ENABLED=false (byte-for-byte inert). */
  private cities: CityMembrane | null = null;
    /** ⑯ The apprenticeship membrane (education + cumulative culture) — null while APPRENTICE_ENABLED=false (byte-for-byte inert). */
  private apprentice: ApprenticeMembrane | null = null;
  /** ⑰ The Archive (externalized knowledge) — null while ARCHIVE_ENABLED is off. */
  private archive: ArchiveMembrane | null = null;
  /** ⑱ The Workshop (knowledge rebirth) — null while WORKSHOP_ENABLED=false. */
  private workshop: WorkshopMembrane | null = null;
  /** ⑳ The Court (verdicts, exile, amnesty) — null while COURTS_ENABLED=false (byte-for-byte inert). */
  private court: CourtMembrane | null = null;
  /** ㉑ The Games membrane (era bell, champion, record) — null while GAMES_ENABLED=false (byte-for-byte inert). */
  private games: GamesMembrane | null = null;
  /** ㉒ The Guilds membrane (charters, pacts, monopoly) — null while GUILD_ENABLED=false (byte-for-byte inert). */
  private guilds: GuildsMembrane | null = null;
  /** ㉓ The Lexicon membrane (coinage, spread, silence) — null while LEX_ENABLED=false (byte-for-byte inert). */
  private lexicon: LexiconMembrane | null = null;
  /** ㉔ The Rumor Mill membrane (a tale afoot, its bend, its quiet, the telling-day echo) — null while RM_ENABLED=false (byte-for-byte inert). */
  private rumor: RumorMill | null = null;
  /** ㉕ The Treaty chancery (seals set, ratified, broken — the roll of formal peace) — null while TR_ENABLED=false (byte-for-byte inert). */
  private treaty: TreatyMembrane | null = null;
  /** ㉖ The Public Works yard (granaries raised, monuments mended, aqueducts fallen) — null while WORKS_ENABLED=false (byte-for-byte inert). */
  private works: WorksMembrane | null = null;
  /** ⑲ The Bourse meter (the MURMUR tape's memory) — null while BOURSE_ENABLED=false (byte-for-byte inert). */
  private bourse: BourseMeter | null = null;
  /** This cron's bourse signals (null while the bourse is off/failed) — read by the ctx fold + stimulus fold. */
  private bourseSignals: BourseSignals | null = null;
  /** ⑧ The commons (fly self-legislation) — null while LAW_ENABLED/institutions/economy is off. */
  private commons: CommonsAssembly | null = null;
  /** ⑮ The Laureate (the swarm's poet) — null while POET_ENABLED=false (byte-for-byte inert). */
  private poet: Poet | null = null;
  /** Cached poetGrammarHash() — a pure function of the source, computed once per DO lifetime. */
  private poetGrammarHashCache: string | null = null;
  /** Lazily-assembled brain manifest + its sha256 (a pure function of cfg, so cached for this DO's life). */
  private manifestCache: { manifest: BrainManifest; hash: string } | null = null;
  private prediction: PredictionMarket | null = null;
  private arenaState: ArenaState | null = null;
  /** The on-chain WAR coffer resolver cursor + per-pair cooldowns (persisted under KEY_WAR; null while war is inert). */
  private warRuntime: WarRuntime | null = null;
  /**
   * War/tax events the CURRENT cron raised, consumed by observeChronicle (step 7) and cleared each tick.
   * Transient (never persisted): a chronicle line is told once from the cron that saw it, and a miss is not
   * worth replaying. Empty while the war layer is inert, so the chronicle context stays exactly today's.
   */
  private warEvents: {
    kind: "declared" | "resolved" | "taxed" | "seized";
    houseId: number; attackerId: number; defenderId: number; attackerName: string; defenderName: string;
    winnerId: number | null; stakeUsdc: number; potUsdc: number; taxUsdc: number;
    // "seized" only (territory conquest): the zones the winner annexed + the house that lost them. Absent on
    // every other kind, so the pre-territory event shape is byte-for-byte unchanged.
    zonesSeized?: number[]; loserId?: number;
  }[] = [];
  /** The breeding-market lineage store (genesis roots + every bred individual), lazily loaded from DO storage. */
  private lineage: LineageEntry[] | null = null;
  /** Per-day autonomous-evolution breeding budget (persisted so an eviction can't reset it). */
  private evolutionGuard: EvolutionGuard | null = null;
  private lastSnapshot: PopulationSnapshot | null = null;
  private lastEconomy: EconomySnapshot | null = null;
  /** Previous tick's temperature, used for the pulse's momentum facet; null until loaded. */
  private prevTemperature: number | null = null;
  private pendingStimuli: StimulusEvent[] = [];
  /** Reentrancy guard so overlapping crons never drive the population concurrently. */
  private cronRunning = false;
  /** Set once the D1 archival table has been ensured this DO lifetime (avoids re-running DDL per cron). */
  private d1SchemaReady = false;
  /** The deterministic historian (era/record trackers) + its hot recent-chronicle buffer, lazily loaded. */
  private chronicler: Chronicler | null = null;
  private annals: ChronicleEntry[] = [];
  /** Cached /history running summary (see KEY_HIST_SUMMARY); null until loaded/seeded from DO storage. */
  private histSummary: HistSummary | null = null;
  /** Set once the D1 chronicle table has been ensured this DO lifetime. */
  private d1ChronicleReady = false;
  /** Set once the D1 poems table (the Laureate's permanent archive) has been ensured this DO lifetime. */
  private d1PoemsReady = false;
  /** Set once the DO hot ring has been folded into the permanent D1 archive this DO lifetime — a one-time
   *  backfill so poems composed BEFORE the archive shipped are never lost when they age out of the ring. */
  private d1PoemsBackfilled = false;
  /** Cached sha256 of the historian's deterministic rule-set (a pure function of the source tables). */
  private chroniclerRulesHash: string | null = null;
  /** ⑦ EPOCHS — a governance-injected shock awaiting the next historian read (a passed miracle/cataclysm of
   *  intensity ≥ 0.75). In-memory only, exactly like pendingStimuli: lost on eviction, best-effort, never
   *  feeds a decision — it only names an era on the next cron. Null when no shock is queued. */
  private pendingGovernanceShock: { kind: ShockKind; actor?: number } | null = null;

  constructor(state: DurableObjectState, env: Env) {
    this.state = state;
    this.env = env;
    this.cfg = loadConfig(env);
  }

  // ---------- Lifecycle ----------

  /**
   * The swarm is either the single-DO LocalSwarm (SHARD_COUNT = 1 — every brain in this isolate, the
   * behaviour this piece has always run) or a ShardedSwarm coordinator that fans the heavy per-fly LIF
   * advance out to N FlyShardDO isolates. Chosen once from config; both present the same SwarmBackend.
   */
  private get sharding(): boolean {
    return this.cfg.shardCount > 1 && this.env.FLY_SHARD != null;
  }

  private async ensureSwarm(): Promise<SwarmBackend> {
    if (this.swarm) return this.swarm;
    this.swarm = this.sharding
      ? await ShardedSwarm.load(this.cfg, this.env, this.state.storage)
      : await LocalSwarm.load(this.cfg, this.state.storage);
    return this.swarm;
  }

  private async ensureMeter(): Promise<MarketMeter> {
    if (this.meter) return this.meter;
    const stored = await this.state.storage.get<any>(KEY_METER);
    this.meter = stored
      ? MarketMeter.fromJSON(stored)
      : new MarketMeter(
          this.cfg.marketEwmaAlpha,
          this.cfg.regimeHot,
          this.cfg.regimeCold,
          this.cfg.marketGain,
        );
    return this.meter;
  }

  /**
   * True only when real-money settlement is BOTH requested and wireable (a mnemonic secret is present).
   * Anything else — including onchain requested without a seed — runs the keyless simulated economy.
   */
  private onchainWired(): boolean {
    return this.cfg.economy.facilitatorMode === "onchain" && this.cfg.economy.mnemonic != null;
  }

  /** Runtime economy config derived from the loaded RuntimeConfig + chain network tag. */
  private economyCfg(): EconomyConfig {
    return {
      enabled: this.cfg.economy.enabled,
      network: arcNetworkTag(this.cfg.isTestnet),
      initialBalanceUsdc: this.cfg.economy.initialBalanceUsdc,
      basePriceUsdc: this.cfg.economy.basePriceUsdc,
      solvencyFloorUsdc: this.cfg.economy.solvencyFloorUsdc,
      maxDealsPerTick: this.cfg.economy.maxDealsPerTick,
      // Effective mode: onchain ONLY when fully wired, else simulated (so a bad config can never throw).
      facilitatorMode: this.onchainWired() ? "onchain" : "simulated",
      seedBase: this.cfg.populationSeedBase,
      realSpendEnabled: this.cfg.economy.realSpendEnabled,
      dailyCapUsdc: this.cfg.economy.dailyCapUsdc,
      perAgentDailyCapUsdc: this.cfg.economy.perAgentDailyCapUsdc,
      maxDealUsdc: this.cfg.economy.maxDealUsdc,
      netMinBroadcastUsdc: this.cfg.economy.netMinBroadcastUsdc,
      netFlushTicks: this.cfg.economy.netFlushTicks,
      // A hatched offspring (id >= populationSize) opens its display mirror at its real parent-funded
      // bootstrap, not the genesis initialBalance, so the frontend shows a newborn's true (tiny) wallet.
      populationSize: this.cfg.populationSize,
      hatchSeedUsdc: this.cfg.evolution.hatchSeedUsdc,
      // DYNASTY: houses + mortality ride the economy's own ledger (never the connectome); the master
      // switch is DYNASTY_ENABLED (default ON). Absent/false ⇒ every dynasty hook below is inert.
      dynasty: { enabled: this.cfg.dynasty.enabled },
      // INSTITUTIONS: limit books + professions + IOU credit are one integrated switch
      // INSTITUTIONS_ENABLED (default ON). Absent/false ⇒ fixed-formula economy byte-for-byte.
      institutions: {
        enabled: this.cfg.institutions.enabled,
        creditCapBaseUsdc: this.cfg.institutions.creditCapBaseUsdc,
        iouRatePer10: this.cfg.institutions.iouRatePer10,
      },
      // ORGANIC CONFLICT: deterministic negative cross-house bonds (rivalry/envy/embargo/raid) so genuine
      // feuds can surface on-chain. OFF by default (CONFLICT_ENABLED) ⇒ every hook no-ops and houseFeuds
      // stays a pure mean, so the economy is byte-for-byte unchanged. Pure social memory: no money, no neurons.
      conflict: {
        enabled: this.cfg.conflict.enabled,
        rivalStep: this.cfg.conflict.rivalStep,
        envyStep: this.cfg.conflict.envyStep,
        embargoStep: this.cfg.conflict.embargoStep,
        raidStep: this.cfg.conflict.raidStep,
        raidProb: this.cfg.conflict.raidProb,
        feudBlend: this.cfg.conflict.feudBlend,
      },
      // TERRITORY: a fixed zone grid; each house holds ONE home zone, cross-zone trade pays a toll (part-
      // tributed to the zone's controller) and home-zone trade is discounted. OFF by default (TERRITORY_ENABLED)
      // ⇒ applyTerritory is a byte-for-byte passthrough and no zone state is written. Economic-side only: it
      // re-prices a deal the neurons already made, never touching connectome/genome/manifestHash.
      territory: {
        enabled: this.cfg.territory.enabled,
        zoneCount: this.cfg.territory.zoneCount,
        tollPct: this.cfg.territory.tollPct,
        homeDiscountPct: this.cfg.territory.homeDiscountPct,
        tributePct: this.cfg.territory.tributePct,
        exileSeverity: this.cfg.territory.exileSeverity,
        powerPerZone: this.cfg.territory.powerPerZone,
      },
    };
  }

  private async ensureEconomy(): Promise<AgentEconomy> {
    if (this.economy) return this.economy;
    const stored = await this.state.storage.get<string>(KEY_ECONOMY);
    this.economy = this.makeEconomy(stored ?? undefined);
    return this.economy;
  }

  /**
   * Lazily load the culture membrane (null while the switch is off — every hook below then no-ops).
   * A corrupt stored blob restores an EMPTY membrane (fashions are forgotten, the ledger is untouched),
   * so culture can never poison any other layer's state.
   */
  private async ensureCulture(): Promise<CultureMembrane | null> {
    if (!this.cfg.culture.enabled) return null;
    if (this.culture) return this.culture;
    const stored = await this.state.storage.get<string>(KEY_CULTURE);
    this.culture = new CultureMembrane({ enabled: true });
    if (stored) this.culture.restore(stored);
    return this.culture;
  }

  /**
   * ⑪ Lazily load the faith membrane (null while the switch is off — every hook below then no-ops).
   * A corrupt stored blob restores an EMPTY membrane (faiths are forgotten, the ledger is untouched),
   * so religion can never poison any other layer's state.
   */
  private async ensureReligion(): Promise<FaithMembrane | null> {
    if (!this.cfg.religion.enabled) return null;
    if (this.religion) return this.religion;
    const stored = await this.state.storage.get<string>(KEY_RELIGION);
    const r = this.cfg.religion;
    this.religion = new FaithMembrane({ enabled: true, holyEvery: r.holyEvery, devotionMin: r.devotionMin, sectCap: r.sectCap });
    if (stored) this.religion.restore(stored);
    return this.religion;
  }

  /**
   * ⑬ Lazily load the tech membrane (null while the switch is off — every hook below then no-ops).
   * A corrupt stored blob restores an EMPTY ladder (the arts are forgotten, the ledger is untouched),
   * so tech can never poison any other layer's state.
   */
  private async ensureTech(): Promise<TechMembrane | null> {
    if (!this.cfg.tech.enabled) return null;
    if (this.tech) return this.tech;
    const stored = await this.state.storage.get<string>(KEY_TECH);
    const t = this.cfg.tech;
    this.tech = new TechMembrane({ enabled: true, discoverP: t.discoverP, adoptPct: t.adoptPct });
    if (stored) this.tech.restore(stored);
    return this.tech;
  }

  /**
   * ⑭ Lazily load the city membrane (null while the switch is off — every hook below then no-ops).
   * A corrupt stored blob restores an EMPTY map (the places are forgotten, the ledger is untouched),
   * so cities can never poison any other layer's state.
   */
  private async ensureCities(): Promise<CityMembrane | null> {
    if (!this.cfg.cities.enabled) return null;
    if (this.cities) return this.cities;
    const stored = await this.state.storage.get<string>(KEY_CITIES);
    const c = this.cfg.cities;
    this.cities = new CityMembrane({ enabled: true, hamletMin: c.hamletMin, townMin: c.townMin, cityMin: c.cityMin, urbanShare: c.urbanShare });
    if (stored) this.cities.restore(stored);
    return this.cities;
  }

  /**
   * ⑯ Lazily load the apprenticeship membrane (null while the switch is off — every hook below then no-ops).
   * A corrupt stored blob restores an EMPTY ledger (the personal arts are unwitnessed again, the ledger is
   * untouched), so education can never poison any other layer's state.
   */
  private async ensureApprentice(): Promise<ApprenticeMembrane | null> {
    if (!this.cfg.apprentice.enabled) return null;
    if (this.apprentice) return this.apprentice;
    const stored = await this.state.storage.get<string>(KEY_APPRENTICE);
    const a = this.cfg.apprentice;
    this.apprentice = new ApprenticeMembrane({ enabled: true, learnPct: a.learnPct, selfPct: a.selfPct, schoolMin: a.schoolMin });
    if (stored) this.apprentice.restore(stored);
    return this.apprentice;
  }

  /**
   * Lazily load the Archive membrane (null while ARCHIVE_ENABLED=false — byte-for-byte inert rollback).
   * A corrupt/absent blob restarts with an empty archive; it can never poison the ledger.
   */
  private async ensureArchive(): Promise<ArchiveMembrane | null> {
    if (!this.cfg.archive.enabled) return null;
    if (this.archive) return this.archive;
    const stored = await this.state.storage.get<string>(KEY_ARCHIVE);
    const a = this.cfg.archive;
    this.archive = new ArchiveMembrane({ enabled: true, recordP: a.recordP, decodeP: a.decodeP, burnCivMax: a.burnCivMax });
    if (stored) this.archive.restore(stored);
    return this.archive;
  }

  /**
   * Lazily load the Workshop membrane (null while WORKSHOP_ENABLED=false — byte-for-byte inert rollback).
   * A corrupt/absent blob restarts with zero reinventions; it can never poison the ledger.
   */
  private async ensureWorkshop(): Promise<WorkshopMembrane | null> {
    if (!this.cfg.workshop.enabled) return null;
    if (this.workshop) return this.workshop;
    const stored = await this.state.storage.get<string>(KEY_WORKSHOP);
    const w = this.cfg.workshop;
    this.workshop = new WorkshopMembrane({ enabled: true, reinventP: w.reinventP });
    if (stored) this.workshop.restore(stored);
    return this.workshop;
  }

  /**
   * ⑳ Lazily load the Court membrane (null while COURTS_ENABLED=false — byte-for-byte inert rollback).
   * A corrupt/absent blob restarts with an empty docket; it can never poison the ledger.
   */
  private async ensureCourt(): Promise<CourtMembrane | null> {
    if (!this.cfg.court.enabled) return null;
    if (this.court) return this.court;
    const stored = await this.state.storage.get<string>(KEY_COURT);
    const c = this.cfg.court;
    this.court = new CourtMembrane({ enabled: true, fileP: c.fileP, jurySize: c.jurySize });
    if (stored) this.court.restore(stored);
    return this.court;
  }

  /**
   * ㉑ Lazily load the Games membrane (null while GAMES_ENABLED=false — byte-for-byte inert rollback).
   * A corrupt/absent blob restarts with an empty stadium; it can never poison the ledger.
   */
  private async ensureGames(): Promise<GamesMembrane | null> {
    if (!this.cfg.games.enabled) return null;
    if (this.games) return this.games;
    const stored = await this.state.storage.get<string>(KEY_GAMES);
    const g = this.cfg.games;
    this.games = new GamesMembrane({ enabled: true, openP: g.openP });
    if (stored) this.games.restore(stored);
    return this.games;
  }

  /**
   * ㉒ Lazily load the Guilds membrane (null while GUILD_ENABLED=false — byte-for-byte inert rollback).
   * A corrupt/absent blob restarts with an empty guildhall; the first round re-adopts silently, so a
   * restart can never burst into pacts. It can never poison the ledger.
   */
  private async ensureGuilds(): Promise<GuildsMembrane | null> {
    if (!this.cfg.guilds.enabled) return null;
    if (this.guilds) return this.guilds;
    const stored = await this.state.storage.get<string>(KEY_GUILDS);
    const g = this.cfg.guilds;
    this.guilds = new GuildsMembrane({ enabled: true, quorum: g.quorum, shareP: g.shareP });
    if (stored) this.guilds.restore(stored);
    return this.guilds;
  }

  /**
   * ㉓ Lazily load the Lexicon membrane (null while LEX_ENABLED=false — byte-for-byte inert rollback).
   * A corrupt/absent blob restarts with an empty desk; the dictionary rebuilds from the annals roll's own
   * counts, so at worst a few words re-earn their entries (the roll never claims what it does not hold).
   * It can never poison the ledger.
   */
  private async ensureLexicon(): Promise<LexiconMembrane | null> {
    if (!this.cfg.lexicon.enabled) return null;
    if (this.lexicon) return this.lexicon;
    const stored = await this.state.storage.get<string>(KEY_LEXICON);
    this.lexicon = new LexiconMembrane({ enabled: true });
    if (stored) this.lexicon.restore(stored);
    return this.lexicon;
  }

  /**
   * ㉔ Lazily load the Rumor Mill (null while RM_ENABLED=false — byte-for-byte inert rollback). A
   * corrupt/absent blob restarts a silent market: the boot round seeds the cursor from the roll, so a
   * restart never re-tells history. It can never poison the ledger.
   */
  private async ensureRumor(): Promise<RumorMill | null> {
    if (!this.cfg.rumor.enabled) return null;
    if (this.rumor) return this.rumor;
    const stored = await this.state.storage.get<string>(KEY_RUMOR);
    this.rumor = new RumorMill({ enabled: true });
    if (stored) this.rumor.restore(stored);
    return this.rumor;
  }

  /**
   * ㉕ Lazily load the Treaty chancery (null while TR_ENABLED=false — byte-for-byte inert rollback). A
   * corrupt/absent blob restarts an empty chancery: no seal is ever back-dated, and with no treaty live
   * the first round only documents feuds already at depth. It can never poison the ledger.
   */
  private async ensureTreaty(): Promise<TreatyMembrane | null> {
    if (!this.cfg.treaty.enabled) return null;
    if (this.treaty) return this.treaty;
    const stored = await this.state.storage.get<string>(KEY_TREATY);
    this.treaty = new TreatyMembrane({ enabled: true });
    if (stored) this.treaty.restore(stored);
    return this.treaty;
  }

  /**
   * ㉖ Lazily load the Works yard (null while WORKS_ENABLED=false — byte-for-byte inert rollback). A
   * corrupt/absent blob restarts an empty yard: no work is back-dated, and with nothing standing the first
   * round only documents a run or a glory already at its line. It can never poison the ledger.
   */
  private async ensureWorks(): Promise<WorksMembrane | null> {
    if (!this.cfg.works.enabled) return null;
    if (this.works) return this.works;
    const stored = await this.state.storage.get<string>(KEY_WORKS);
    this.works = new WorksMembrane({ enabled: true });
    if (stored) this.works.restore(stored);
    return this.works;
  }

  /**
   * ⑲ Lazily load the Bourse meter (null while BOURSE_ENABLED=false — byte-for-byte inert rollback). A
   * corrupt/absent blob restarts cold: it re-learns the tape's norm from scratch and can never poison
   * the ledger — the bourse only ever READS the chain (getLogs) and never signs a transaction.
   */
  private async ensureBourse(): Promise<BourseMeter | null> {
    if (!this.cfg.bourse.enabled || !this.cfg.bourse.token) return null;
    if (this.bourse) return this.bourse;
    const stored = await this.state.storage.get<string>(KEY_BOURSE);
    this.bourse = new BourseMeter();
    if (stored) this.bourse.restore(stored);
    return this.bourse;
  }

  /**
   * ⑲ Sample the MURMUR tape (read-only getLogs from the meter's lastBlock) and fold it into the meter.
   * Returns null when the bourse is off, or when the RPC failed (lastBlock does NOT advance, so the next
   * cron re-reads the same window — the tape is never silently skipped). Strictly best-effort.
   */
  private async driveBourse(): Promise<BourseSignals | null> {
    const b = await this.ensureBourse();
    if (!b) return null;
    b.setWhaleHint(Number(BigInt(this.cfg.bourse.whaleRaw) / 10n ** 18n));
    const sample = await sampleBourseActivity(this.cfg, b.lastBlock);
    return b.update(sample, { titheMilestoneRaw: BigInt(this.cfg.bourse.titheMilestoneRaw) });
  }

  /**
   * Lazily load the commons (null while LAW_ENABLED is off, or while institutions/economy are off — a
   * commons has no credit system to legislate over otherwise). A corrupt blob restores an EMPTY commons, so
   * self-legislation can never poison the economy it only observes. false ⇒ the cron never convenes and the
   * economy keeps its base config byte-for-byte.
   */
  private async ensureCommons(): Promise<CommonsAssembly | null> {
    if (!this.cfg.law.enabled || !this.cfg.institutions.enabled || !this.cfg.economy.enabled) return null;
    if (this.commons) return this.commons;
    const stored = await this.state.storage.get<string>(KEY_COMMONS);
    this.commons = new CommonsAssembly({
      enabled: true,
      assemblySize: this.cfg.law.assemblySize,
      creditCapBandUsdc: this.cfg.law.creditCapBandUsdc,
      iouRateBand: this.cfg.law.iouRateBand,
    });
    if (stored) this.commons.restore(stored);
    return this.commons;
  }

  /**
   * ⑮ Lazily load the Laureate (null while POET_ENABLED is off — every hook below then no-ops). A corrupt
   * stored blob restores an EMPTY chain (the poems are forgotten, the ledger is untouched), so the poet can
   * never poison any other layer's state.
   */
  private async ensurePoet(): Promise<Poet | null> {
    if (!this.cfg.poet.enabled) return null;
    if (this.poet) return this.poet;
    const stored = await this.state.storage.get<string>(KEY_POET);
    const p = this.cfg.poet;
    this.poet = new Poet({ cap: p.cap, minCrons: p.minCrons });
    if (stored) this.poet.restore(stored);
    return this.poet;
  }

  /** The poet's grammar digest — computed once per DO lifetime (a pure function of the source). */
  private async getPoetGrammarHash(): Promise<string> {
    if (this.poetGrammarHashCache == null) this.poetGrammarHashCache = await poetGrammarHash();
    return this.poetGrammarHashCache;
  }

  /** Runtime prediction-market config derived from the loaded RuntimeConfig + chain network tag. */
  private predictCfg(): PredictConfig {
    const p = this.cfg.predict;
    return {
      enabled: p.enabled,
      network: arcNetworkTag(this.cfg.isTestnet),
      stakeUsdc: p.stakeUsdc,
      maxStakeUsdc: p.maxStakeUsdc,
      flatBand: p.flatBand,
      commit: p.commit,
      recentCap: 16,
    };
  }

  /**
   * The prediction market, or null when it (or the economy it settles through) is disabled. It borrows the
   * economy's wallets + netting + registry, so it is only ever armed alongside an enabled agent economy.
   */
  private async ensurePrediction(): Promise<PredictionMarket | null> {
    if (!this.cfg.predict.enabled || !this.cfg.economy.enabled) return null;
    if (this.prediction) return this.prediction;
    const stored = await this.state.storage.get<string>(KEY_PREDICT);
    this.prediction = new PredictionMarket(this.predictCfg(), stored ?? undefined);
    return this.prediction;
  }

  /** Load (or initialise) the arena resolver cursor. Persisted so an evicted DO resumes correctly. */
  private async ensureArenaState(): Promise<ArenaState> {
    if (this.arenaState) return this.arenaState;
    this.arenaState = (await this.state.storage.get<ArenaState>(KEY_ARENA)) ?? { openedRound: -1, resolvedRound: -1 };
    return this.arenaState;
  }

  /**
   * Drive the on-chain human arena as its authorized resolver — at most one open + one resolve per round
   * window, both best-effort. Rounds are unix time buckets (roundId = floor(now / roundLenSec)): the round
   * that just closed is resolved with THIS cron's temperature as its exit, and the new bucket is opened
   * with the same temperature as its baseline, so entry/exit are continuous across rounds. Gated behind
   * the SAME real-money rails as settlement — no arena writes unless onchain is armed, real spend is on,
   * and not shadow-only (the resolver calls cost real gas). A failed open/resolve is retried next cron
   * within the window; a round never resolved is refundable by anyone after the contract's stale grace.
   */
  private async driveArena(temperature: number, economy: AgentEconomy): Promise<void> {
    const a = this.cfg.arena;
    if (!a.enabled || !a.address) return;
    if (economy.facilitatorMode !== "onchain") return;                                  // no resolver key
    if (!this.cfg.economy.realSpendEnabled || this.cfg.economy.shadowOnly) return;      // master safety rails
    const st = await this.ensureArenaState();
    const exitR6 = tempToR6(temperature);
    // Which round to resolve / open is a PURE function of (now, cadence, cursor) — see arena.ts. The same
    // temperature is prev's exit and cur's entry, so rounds are continuous and the resolver only reports T.
    const plan = arenaRoundPlan(Math.floor(Date.now() / 1000), a.roundLenSec, st);

    // 1) Resolve the round that just closed (prev), using this cron's temperature as its exit.
    if (plan.resolveRound != null) {
      const tx = await economy.arenaResolve(plan.resolveRound, exitR6);
      if (tx) st.resolvedRound = plan.resolveRound;   // on failure leave the cursor put; retried next cron
    }
    // 2) Open the current round, committing its baseline temperature + flat band before betting on the exit.
    if (plan.openRound != null) {
      const tx = await economy.arenaOpen(plan.openRound, exitR6, tempToR6(a.flatBand), plan.betDeadline);
      // cursorAfterOpen also baselines resolvedRound on a fresh mid-stream start, so we never chase a prev we
      // didn't open (see arena.ts) — otherwise every cron this hour re-attempts a reverting resolve(prev).
      if (tx) { const c = cursorAfterOpen(st, plan.openRound); st.openedRound = c.openedRound; st.resolvedRound = c.resolvedRound; }
    }
  }

  /** Load (or initialise) the persisted WAR resolver cursor + per-pair cooldowns (inert until war is armed). */
  private async ensureWarState(): Promise<WarRuntime> {
    if (this.warRuntime) return this.warRuntime;
    const stored = await this.state.storage.get<WarRuntime>(KEY_WAR);
    this.warRuntime = stored ?? { cursor: { openedWar: -1, resolvedWar: -1 }, lastByPair: {} };
    // Normalize a partial/legacy blob so a missing sub-field can never NPE the cron.
    if (!this.warRuntime.cursor) this.warRuntime.cursor = { openedWar: -1, resolvedWar: -1 };
    if (!this.warRuntime.lastByPair) this.warRuntime.lastByPair = {};
    return this.warRuntime;
  }

  /**
   * Drive the on-chain WAR + TAXATION coffer as its authorized resolver — the war sibling of driveArena, and
   * gated on EXACTLY the same real-money rails (enabled + a deployed coffer + onchain facilitator + real spend
   * on + not shadow-only), because every step moves REAL USDC and pays gas. Each cron it may, best-effort:
   *   (1) RESOLVE the war whose bucket just closed — the coffer derives the winner from the powers committed
   *       at declare, so the Worker supplies nothing and cannot steer it; war.ts `winnerOf` (byte-identical to
   *       the contract) is used only to narrate the result for the chronicle;
   *   (2) DECLARE the deepest due feud, first topping both houses' vaults with treasury USDC (under the
   *       coffer's hard cap) so the bounded stake + tax are covered, then committing both powers on-chain;
   *   (3) LEVY the extra on-chain tax from every vault-holding house, and sweep the purse to the dominant
   *       house when taxDest === "dominant".
   * After any mined op it re-reads every house's live vault so the ledger MIRROR tracks the coffer exactly
   * (money is only ever moved inside the contract, never minted). Any throw is swallowed by the caller; a
   * move that never mines degrades to null and changes no mirror.
   */
  private async driveWar(economy: AgentEconomy): Promise<void> {
    const w = this.cfg.war;
    if (!w.enabled || !w.address) return;
    if (economy.facilitatorMode !== "onchain") return;                                 // no resolver key
    if (!this.cfg.economy.realSpendEnabled || this.cfg.economy.shadowOnly) return;     // master safety rails

    const rt = await this.ensureWarState();
    const now = Math.floor(Date.now() / 1000);
    const plan = planWar(now, w.warCadenceSec, rt.cursor);
    const freshBucket = plan.declareWar != null;   // cur not yet opened ⇒ a new war/tax window just began
    const houses = economy.warHouses();
    const byId = new Map(houses.map((h) => [h.id, h]));
    const nameOf = (id: number): string => economy.houseNameById(id) ?? `House ${id}`;
    let anyTx = false;

    // 1) RESOLVE the war whose bucket just closed (the coffer derives the winner; we only trigger + mirror).
    if (plan.resolveWar != null) {
      const info = await economy.warInfoOnchain(plan.resolveWar);
      const tx = await economy.resolveWarOnchain(plan.resolveWar);
      if (tx) {
        rt.cursor.resolvedWar = plan.resolveWar;   // on failure leave the cursor put; retried next cron in the grace
        anyTx = true;
        if (info && info.opened && !info.resolved) {
          const att = Number(info.attacker);
          const def = Number(info.defender);
          // Recompute the winner the SAME way the contract does — this is the runtime lock-step check.
          const { winner } = winnerOf(BigInt(plan.resolveWar), BigInt(info.attacker), BigInt(info.defender), BigInt(info.powerA), BigInt(info.powerB));
          const winnerId = winner === WIN_NONE ? null : winner === WIN_ATTACKER ? att : def;
          this.warEvents.push({
            kind: "resolved", houseId: winnerId ?? att, attackerId: att, defenderId: def,
            attackerName: nameOf(att), defenderName: nameOf(def), winnerId,
            stakeUsdc: atomicToUsdc(info.stake), potUsdc: atomicToUsdc(info.pot), taxUsdc: 0,
          });
          // TERRITORY CONQUEST (ledger-only, additive): with the conquest switch armed, the winner annexes every
          // zone the loser controlled. NO money moves here (the pot already settled on-chain above) — it only
          // re-points zoneControl, leaving the loser exiled. Off by default (TERR_SEIZE_ON_WIN=false, and it also
          // needs TERRITORY_ENABLED) ⇒ a resolved war is byte-for-byte today's. Stable across restarts.
          if (winnerId != null && this.cfg.territory.enabled && this.cfg.territory.seizeOnWin) {
            const loserId = winnerId === att ? def : att;
            const seized = economy.seizeZones(loserId, winnerId);
            if (seized.length) {
              this.warEvents.push({
                kind: "seized", houseId: winnerId, attackerId: att, defenderId: def,
                attackerName: nameOf(att), defenderName: nameOf(def), winnerId,
                stakeUsdc: 0, potUsdc: 0, taxUsdc: 0, zonesSeized: seized, loserId,
              });
            }
          }
        }
      }
    }

    // 2) DECLARE the deepest due feud, funding both vaults first so the bounded stake + tax are covered.
    if (plan.declareWar != null) {
      const candidates = feudPairs(houses, economy.houseFeuds(), w, now, rt.lastByPair);
      const pair = candidates[0];
      const ha = pair ? byId.get(pair.attacker) : undefined;
      const hb = pair ? byId.get(pair.defender) : undefined;
      if (ha && hb) {
        // A vault target that yields a full (capped) stake, bounded so two houses still fit under the cap.
        const target = Math.min(Math.max(w.minVaultUsdc, w.perWarCapUsdc / w.stakePct), w.maxEscrowUsdc / 2);
        for (const h of [ha, hb]) {
          const need = target - h.vaultOnchainUsdc;
          if (need > 0) {
            const dtx = await economy.cofferDeposit(h.id, usdcToAtomic(need));
            if (dtx) anyTx = true;
          }
        }
        // Size the stake off the FUNDED vaults (re-read so a capped/partial deposit is respected).
        const va = await economy.cofferVaultOnchain(ha.id);
        const vb = await economy.cofferVaultOnchain(hb.id);
        const av = va != null ? atomicToUsdc(va) : ha.vaultOnchainUsdc;
        const bv = vb != null ? atomicToUsdc(vb) : hb.vaultOnchainUsdc;
        const stake = stakeOf(av, bv, w);
        // territory-additive: held ground is war power (powerPerZone defaults 0 ⇒ byte-for-byte the old power, so
        // the on-chain winnerOf lock-step is unchanged unless TERR_POWER_PER_ZONE is explicitly armed).
        const ppz = this.cfg.territory.powerPerZone;
        const powerA = housePower(ha, ppz);
        const powerB = housePower(hb, ppz);
        if (stake > 0 && powerA + powerB > 0) {
          const tx = await economy.declareWarOnchain({
            warId: plan.declareWar, attacker: ha.id, defender: hb.id,
            stakeAtomic: usdcToAtomic(stake), powerA, powerB, deadline: plan.declareDeadline,
          });
          if (tx) {
            // cursorAfterWarOpen also baselines resolvedWar on a fresh mid-stream start, so we never chase a
            // prev we never declared (see war.ts) — mirroring arena's cursorAfterOpen discipline.
            const c = cursorAfterWarOpen(rt.cursor, plan.declareWar);
            rt.cursor.openedWar = c.openedWar;
            rt.cursor.resolvedWar = c.resolvedWar;
            rt.lastByPair[pairKey(ha.id, hb.id)] = now;   // per-pair cooldown against an immediate re-fund
            anyTx = true;
            this.warEvents.push({
              kind: "declared", houseId: ha.id, attackerId: ha.id, defenderId: hb.id,
              attackerName: nameOf(ha.id), defenderName: nameOf(hb.id), winnerId: null,
              stakeUsdc: stake, potUsdc: stake * 2, taxUsdc: 0,
            });
          }
        }
      }
    }

    // 3) LEVY the extra on-chain tax — at most once per bucket, from every house that holds a vault.
    if (freshBucket) {
      for (const h of houses) {
        if (h.vaultOnchainUsdc <= 0) continue;
        const levy = taxLevy(h.vaultOnchainUsdc, w);
        const amtAtomic = usdcToAtomic(levy);
        if (levy <= 0 || amtAtomic === "0") continue;
        const tx = await economy.levyTaxOnchain(h.id, amtAtomic);
        if (tx) {
          economy.addWarTax(amtAtomic);   // ledger MIRROR only; the real USDC stayed inside the coffer
          anyTx = true;
          this.warEvents.push({
            kind: "taxed", houseId: h.id, attackerId: h.id, defenderId: h.id,
            attackerName: nameOf(h.id), defenderName: nameOf(h.id), winnerId: null,
            stakeUsdc: 0, potUsdc: 0, taxUsdc: levy,
          });
        }
      }
      // Route the purse to the dominant house when configured to (otherwise it stays the commons purse).
      if (w.taxDest === "dominant") {
        const dom = houses.slice().sort((a, b) => b.capitalShare - a.capitalShare || a.id - b.id)[0];
        if (dom) { const stx = await economy.sweepTaxOnchain(dom.id); if (stx) anyTx = true; }
      }
    }

    // Refresh every vault MIRROR from the live coffer after any mined op, so the ledger tracks the contract.
    if (anyTx) {
      for (const h of houses) {
        const v = await economy.cofferVaultOnchain(h.id);
        if (v != null) economy.setVaultOnchain(h.id, v);
      }
    }
  }

  /** Load (or initialise) the persisted per-day evolution breeding budget. */
  private async ensureEvolutionGuard(): Promise<EvolutionGuard> {
    if (this.evolutionGuard) return this.evolutionGuard;
    this.evolutionGuard =
      (await this.state.storage.get<EvolutionGuard>(KEY_EVOLUTION)) ?? { dayKey: "", global: 0, perAgent: {} };
    return this.evolutionGuard;
  }

  /** Reset the daily breeding counters when the UTC day rolls over. */
  private rollEvolutionDay(g: EvolutionGuard, nowMs: number): void {
    const key = new Date(nowMs).toISOString().slice(0, 10);
    if (key !== g.dayKey) {
      g.dayKey = key;
      g.global = 0;
      g.perAgent = {};
    }
  }

  /**
   * AUTONOMOUS EVOLUTION — let the swarm found its own next generation. Each cron, the fittest agents by
   * realized PnL may breed (mutate/cross) into the on-chain lineage market, paying the breeding fee from
   * their OWN wallet (economy.payBreedingFee → an EIP-3009 transfer the parent signs with its own HD key;
   * the facilitator only relays gas). The offspring is credited to the paying parent (breeder = its address)
   * and committed to ConnectomeLineage best-effort, so ancestry is a public, self-funded fact.
   *
   * Gated behind the SAME master rails as the arena/settlement: it runs only when evolution is enabled AND a
   * treasury is set AND the economy is on AND (onchain) real spend is on and not shadow-only — a simulated
   * or keyless Worker never evolves and never moves funds. Offspring deliberately do NOT join the live 24-fly
   * trading population (the manifest/sharding/funding stay fixed); they live only in the breeding market.
   *
   * Order of operations is spend-safe: the pure planner proposes one breed, applyBreed computes + validates
   * the offspring BEFORE any payment (a no-op mutation or duplicate genome is refused for free), and only a
   * MINED fee persists the child. Best-effort throughout — any failure is logged and never blocks the tick.
   */
  private async driveEvolution(economy: AgentEconomy, tickIndex: number, flies: readonly FlyReading[] | null): Promise<void> {
    const ev = this.cfg.evolution;
    if (!ev.enabled || !ev.treasury || !this.cfg.economy.enabled) return;
    if (economy.facilitatorMode !== "onchain") return;                                  // no parent keys
    if (!this.cfg.economy.realSpendEnabled || this.cfg.economy.shadowOnly) return;      // master safety rails

    const entries = await this.ensureLineage();
    const rows = economy.leaderboard();
    // ANCHOR THE ON-CHAIN FAMILY TREE first (best-effort, bounded): commit every lineage entry whose commitTx
    // is still null and whose parents are already on Arc — the 24 genesis roots first, then their descendants
    // — so ConnectomeLineage becomes a public, tamper-evident ancestry log AND the child bred below finds its
    // parent already committed. Runs EVERY cron (even once the daily breeding budget is spent) so the backfill
    // always progresses. Spends no agent funds: the gas wallet signs and commitLineage swallows any revert.
    await this.anchorLineage(economy, entries, rows);

    const guard = await this.ensureEvolutionGuard();
    this.rollEvolutionDay(guard, Date.now());
    if (ev.globalDaily > 0 && guard.global >= ev.globalDaily) return;                   // daily swarm budget spent
    // GERMLINE ADVANCEMENT: each agent breeds from its OWN most-recent offspring when it has one (so lines
    // accumulate generations and `cross` recombines two diverged germlines), else from its genesis root —
    // the genome the live agent actually runs + earns with. genesis[id] is valid because populationSeeds
    // order == fly-id order (population.ts spawns fly i from populationSeeds[i]); see evolution.ts.
    const genomeHashById = germlineResolver(rows, entries);

    const rngSeed = (Date.now() & 0xffffffff) >>> 0;
    const lim: EvolutionLimits = {
      perCron: ev.maxPerCron, perCronUsed: 0,
      perAgentDaily: ev.perAgentDaily, globalDaily: ev.globalDaily, globalUsed: guard.global,
      perAgentUsed: guard.perAgent, crossBias: ev.crossBias,
    };
    const plan = planEvolution(rows, genomeHashById, lim, Math.random, rngSeed);
    if (!plan) return;                                                                  // nobody fit / budget hit

    // Compute + validate the offspring BEFORE spending. applyBreed is pure and refuses unknown parents and
    // duplicate genomes FOR FREE, so a guaranteed-no-op breed never costs a real fee. resolveNovelBreed
    // retries a duplicate with a fresh seed and downgrades cross→mutate (mutate always reseeds ⇒ novel), so
    // a fee is only ever spent on a genuinely NEW genome; a non-duplicate error (unknown parent) is fatal.
    let child: LineageEntry;
    try {
      const resolved = await resolveNovelBreed(plan, (op, parents, seed) =>
        applyBreed(entries, { op, parents, rngSeed: seed, breeder: plan.payerAddress }),
      );
      if (!resolved) {
        console.warn("[DO] evolution: no novel offspring this cron (every attempt duplicated)");
        return;
      }
      child = resolved.child;
    } catch (e) {
      console.warn("[DO] evolution breed invalid (no fee spent):", (e as Error).message);
      return;
    }

    // Charge the breeding fee to the parent's OWN wallet. Only a MINED transfer (valid) founds the child.
    const fee = await economy.payBreedingFee(plan.payerId, ev.treasury, ev.feeUsdc, tickIndex);
    if (!fee || !fee.valid) {
      console.warn("[DO] evolution breeding fee not settled (no child):", fee?.reason ?? "unarmed");
      return;
    }

    // Paid + mined: persist the offspring, meter the daily budget, and best-effort anchor it on Arc.
    entries.push(child);
    this.lineage = entries;
    await this.state.storage.put(KEY_LINEAGE, entries);
    guard.global++;
    guard.perAgent[plan.payerId] = (guard.perAgent[plan.payerId] ?? 0) + 1;
    await this.state.storage.put(KEY_EVOLUTION, guard);

    if (this.cfg.lineageAddress) {
      const opCode = child.op === "genesis" ? 0 : child.op === "mutate" ? 1 : 2;
      const tx = await economy.commitLineage({
        genomeHash: child.genomeHash,
        parentA: child.parents[0] ?? "",
        parentB: child.parents[1] ?? "",
        op: opCode as 0 | 1 | 2,
        generation: child.generation,
        breeder: plan.payerAddress,
      });
      if (tx) {
        child.commitTx = tx;
        await this.state.storage.put(KEY_LINEAGE, entries);
      }
    }

    // ── OPTIONAL HATCH: grow the LIVE trading population from the bred offspring (default inert) ──────────
    // A strict post-suffix to the breed above: the child is ALREADY persisted + anchored, so anything here
    // failing only means "lineage recorded, no new live fly" — it never blocks the tick and never refunds the
    // breeding fee (reproduction already happened). Parent-funded: the child's opening balance is a bounded
    // real-USDC bootstrap from the payer's OWN wallet, and the child only goes live once that transfer is MINED
    // (so it can never come online with a balance that did not truly land, and the treasury never mints).
    // Bounded by the hard live cap and a per-genome memory budget so a shard can never OOM or bust its 2 MB row.
    try {
      const swarm = this.swarm;
      if (ev.hatchLive && swarm) {
        // Occupancy is the set of CURRENTLY-LIVE ids. After live-retirement the dead have left the swarm, so
        // liveCount tracks the living only and a freed slot re-opens breeding — the gate reads liveCount, and
        // the child claims the LOWEST vacant id in [0, cap) (recycling a genesis founder's slot + its HD wallet).
        const occupied = new Set(swarm.liveIds());
        const liveCount = occupied.size;
        if (liveCount >= this.cfg.maxLivePopulation) {
          console.log(`[DO] evolution: live cap ${this.cfg.maxLivePopulation} reached — lineage kept, no hatch`);
        } else if (!genomeWithinBudget(child.genome, hatchBudgetFromGenesis(this.cfg.brainOpts))) {
          console.log(
            `[DO] evolution: genome over memory budget — lineage kept, no hatch (child=${child.genomeHash.slice(0, 12)})`,
          );
        } else {
          const childId = nextVacantId(occupied, this.cfg.maxLivePopulation);
          if (childId < 0) {
            console.log(`[DO] evolution: no vacant live slot under cap ${this.cfg.maxLivePopulation} — lineage kept, no hatch`);
          } else {
            const seed = await economy.fundOffspring(
              plan.payerId, childId, economy.deriveAddress(childId), ev.hatchSeedUsdc, tickIndex,
            );
            if (!seed?.valid) {
              console.warn(`[DO] evolution: offspring bootstrap not settled — no hatch:`, seed?.reason ?? "unarmed");
            } else {
              const ok = await swarm.hatchLiveFly(childId, child.genome, this.state.storage);
              if (ok) {
                // DYNASTY: the live child enters the kinship ledger — it is born into its parent's house, or
                // this very hatch FLAGS a new one (name + sigil fold from the child's genome hash). When the
                // slot was a RECYCLED one (a retired fly's id), noteHatch reopens it (resets the wallet +
                // severs the previous lineage) before inducting the newborn — pure ledger-side, it can never
                // un-hatch a fly. CULTURE: the founder's creed AT FOUNDING becomes the house's old way.
                economy.noteHatch(plan.payerId, childId, child.genomeHash, flies?.find((f) => f.id === plan.payerId)?.fap);
                console.log(
                  `[DO] evolution hatched #${childId} gen=${child.generation} funded by #${plan.payerId} ` +
                    `${ev.hatchSeedUsdc}USDC tx=${seed.txHash.slice(0, 10)} live=${swarm.size()}/${this.cfg.maxLivePopulation}`,
                );
              } else {
                // Funds landed but the live fly could not be created (cap/route). Extremely rare — both were
                // checked before paying. Log loudly so the funded-but-absent child can be reconciled manually.
                console.error(
                  `[DO] evolution: bootstrap MINED for #${childId} but hatchLiveFly failed — child wallet funded, no live fly`,
                );
              }
            }
          }
        }
      }
    } catch (e) {
      console.warn("[DO] evolution hatch failed (lineage kept, tick continues):", (e as Error).message);
    }

    console.log(
      `[DO] evolution tick#${tickIndex} ${child.op} by #${plan.payerId} (${plan.payerAddress}) ` +
        `fee=${ev.feeUsdc}USDC gen=${child.generation} child=${child.genomeHash.slice(0, 12)} ` +
        `today=${guard.global}/${ev.globalDaily} tx=${fee.txHash.slice(0, 10)}`,
    );
  }

  /**
   * Best-effort on-chain anchoring of the ConnectomeLineage log (idempotent, bounded). Delegates ordering +
   * breeder resolution to the pure lineageAnchorPlan (evolution.ts), then commits each candidate with the gas
   * wallet and records the tx on the entry. Genesis roots anchor first, so descendants — which the contract
   * refuses until both parents are committed — follow on later ticks; the 24 roots backfill over a few crons.
   * A failed commit simply stays null and is retried next tick. Spends no agent funds and never blocks the
   * breed. Returns how many entries were newly anchored.
   */
  private async anchorLineage(
    economy: AgentEconomy,
    entries: LineageEntry[],
    rows: LeaderRow[],
    maxCommits = 6,
  ): Promise<number> {
    if (!this.cfg.lineageAddress || !this.cfg.economy.enabled) return 0;
    const addrById = new Map<number, string>();
    for (const r of rows) if (r.address) addrById.set(r.id, r.address.toLowerCase());
    const plan = lineageAnchorPlan(entries, addrById, maxCommits);
    if (plan.length === 0) return 0;
    let anchored = 0;
    for (const c of plan) {
      const tx = await economy.commitLineage({
        genomeHash: c.genomeHash,
        parentA: c.parentA,
        parentB: c.parentB,
        op: c.op,
        generation: c.generation,
        breeder: c.breeder,
      });
      if (!tx) continue;                                        // reverted / RPC hiccup ⇒ retry next tick
      const e = entries.find((x) => x.genomeHash === c.genomeHash);
      if (e && !e.commitTx) { e.commitTx = tx; anchored++; }
    }
    if (anchored > 0) {
      await this.state.storage.put(KEY_LINEAGE, entries);
      const total = entries.filter((e) => e.commitTx).length;
      console.log(`[DO] lineage anchored ${anchored} genome(s) on Arc (${total}/${entries.length} committed)`);
    }
    return anchored;
  }

  /**
   * Construct the economy with the right dependencies: real-money wiring (HD keys + clients + onchain
   * facilitator) when onchain is requested AND wireable, else the keyless simulated default. Shared by
   * ensureEconomy() and postReset() so BOTH paths arm identically and neither can throw on a misconfig.
   */
  private makeEconomy(stored?: string): AgentEconomy {
    const cfg = this.economyCfg();
    let deps: EconomyDeps | undefined;
    if (cfg.facilitatorMode === "onchain") {
      deps = this.buildOnchainDeps();
    } else if (this.cfg.economy.facilitatorMode === "onchain") {
      // Requested real money but no ECONOMY_MNEMONIC secret — degrade LOUDLY to the keyless simulator
      // rather than throw, so a misconfig can never take the piece down (and never move real funds).
      console.error(
        "[DO] ECONOMY_FACILITATOR=onchain but ECONOMY_MNEMONIC is unset — running the SIMULATED keyless " +
          "economy. Set the mnemonic secret (wrangler secret put ECONOMY_MNEMONIC) to enable real settlement.",
      );
    }
    return new AgentEconomy(cfg, stored, deps);
  }

  /**
   * Wire the real-money path: HD-derive every agent wallet + the gas wallet from the ONE mnemonic
   * secret, build the read/relay clients, and hand the economy an OnChainFacilitator plus a real
   * addressOf. Runs at most once per DO lifetime (the economy instance is cached), so key derivation and
   * client setup happen once. EVERY config safety rail is applied here; only reached when onchainWired().
   */
  private buildOnchainDeps(): EconomyDeps {
    const e = this.cfg.economy;
    // Derive the FULL live-growth range, NOT just the genesis cohort. Live fly ids run 0..maxLivePopulation-1:
    // genesis 0..populationSize-1 PLUS bred offspring hatched into growth slots (id >= populationSize). Their
    // payer wallets are HD-derived exactly like genesis (addressOf is deterministic), so if we only derived
    // populationSize accounts a newly bred fly's address would be absent from byAddress and its on-chain buy
    // would fail "no signer for payer". Derivation is deterministic + lazy, so covering unused slots is free.
    const keys = deriveAgentKeys(e.mnemonic!, this.cfg.maxLivePopulation, e.facilitatorPk ?? undefined);
    const pub = publicClient(this.cfg);
    const wallet = walletClient(this.cfg, keys.facilitator());

    // Reverse map: lowercase agent address → its HD signing account, across the WHOLE live-growth range
    // (keys.count === maxLivePopulation), so every possible buyer — genesis or newly bred — resolves to a signer.
    const byAddress = new Map<string, LocalAccount>();
    for (let id = 0; id < keys.count; id++) {
      byAddress.set(keys.address(id).toLowerCase(), keys.account(id));
    }

    // Optional Circle Facilitator Service backend: when ECONOMY_CIRCLE_FACILITATOR is "external"/"all",
    // hand the per-deal USDC broadcast to Circle's hosted relayer (which screens both parties and pays the
    // settlement gas) instead of this wallet. The CAIP-2 network Circle routes by is derived from chainId,
    // so the SAME wiring serves Arc testnet (eip155:5042002) and mainnet (eip155:5042). "off" ⇒ omitted
    // entirely ⇒ self-broadcast, byte-for-byte today's behaviour. Registry commits + arena open/resolve are
    // NOT USDC transfers, so they always still use this wallet regardless of the Circle scope.
    const circleOpts =
      e.circle.mode === "off"
        ? undefined
        : {
            baseUrl: e.circle.baseUrl,
            networkCaip2: caip2(this.cfg.chainId),
            chainId: this.cfg.chainId,
            apiKey: e.circle.apiKey,
            maxTimeoutSeconds: e.circle.maxTimeoutSeconds,
            scope: e.circle.mode,
          };

    const facilitator = makeFacilitator("onchain", {
      asset: ARC_USDC as Address,
      chainId: this.cfg.chainId,
      publicClient: pub,
      wallet,
      buyerAccount: (addr) => byAddress.get(addr.toLowerCase()),
      domainName: e.usdcEip712Name,
      domainVersion: e.usdcEip712Version,
      maxAmountAtomic: usdcToAtomic(e.maxDealUsdc),
      shadowOnly: e.shadowOnly,
      gasPrice: e.gasPriceGwei != null ? BigInt(Math.round(e.gasPriceGwei * 1e9)) : undefined,
      registryAddress: e.registryAddress ? (e.registryAddress as Address) : undefined,
      arenaAddress: this.cfg.arena.address ? (this.cfg.arena.address as Address) : undefined,
      warAddress: this.cfg.war.address ? (this.cfg.war.address as Address) : undefined,
      lineageAddress: this.cfg.lineageAddress ? (this.cfg.lineageAddress as Address) : undefined,
      circle: circleOpts,
    });

    console.warn(
      `[DO] REAL-MONEY economy ARMED on chainId ${this.cfg.chainId}: ${keys.count} HD agents, gas wallet ` +
        `${keys.facilitatorAddress()}, shadowOnly=${e.shadowOnly}, realSpend=${e.realSpendEnabled}, ` +
        `perDealCap=${e.maxDealUsdc} USDC, dailyCap=${e.dailyCapUsdc} USDC, perAgentDailyCap=${e.perAgentDailyCapUsdc} USDC.`,
    );
    if (circleOpts) {
      console.warn(
        `[DO] Circle Facilitator Service ARMED (scope=${circleOpts.scope}, network=${circleOpts.networkCaip2}, ` +
          `auth=${circleOpts.apiKey ? "api-key" : "keyless seller-proof"}, baseUrl=${circleOpts.baseUrl}): USDC ` +
          `settlement delegated to Circle's hosted relayer; registry/arena still use ${keys.facilitatorAddress()}.`,
      );
    }

    // Optional IPFS pinner: when IPFS_PINNER="pinata" + a JWT, pin each mined net receipt's canonical body to
    // IPFS (best-effort) so anyone can fetch it from a public gateway and confirm sha256(body)==the on-chain
    // receiptHash with no murmur server in the loop. "off"/no JWT ⇒ omitted ⇒ flush skips pinning entirely
    // (byte-for-byte today's behaviour). The trust root stays the on-chain hash, never the CID.
    const pinner =
      e.ipfs.pinner === "pinata" && e.ipfs.jwt ? new PinataPinner({ jwt: e.ipfs.jwt }) : undefined;
    if (pinner) {
      console.warn(
        `[DO] IPFS receipt pinning ARMED (pinata, gateway=${e.ipfs.gateway}): each mined net receipt body is ` +
          `pinned best-effort; verifiers fetch it trustlessly and match sha256(body) to the on-chain receiptHash.`,
      );
    }

    return { facilitator, addressOf: (id) => keys.address(id), pinner };
  }

  private async ensurePrevTemperature(): Promise<number> {
    if (this.prevTemperature == null) {
      this.prevTemperature = (await this.state.storage.get<number>(KEY_PREV_TEMP)) ?? 0.5;
    }
    return this.prevTemperature;
  }

  private async loadSnapshot(): Promise<PopulationSnapshot | null> {
    if (this.lastSnapshot) return this.lastSnapshot;
    this.lastSnapshot =
      (await this.state.storage.get<PopulationSnapshot>(KEY_LAST_SNAPSHOT)) ?? null;
    return this.lastSnapshot;
  }

  private async persist(market: MarketState | null, snapshot: PopulationSnapshot | null): Promise<void> {
    // Swarm-owned state: LocalSwarm writes the whole population:v3 blob; ShardedSwarm writes just the
    // coordinator counter (its shards persisted their own brains on the cron's commit sub-tick).
    if (this.swarm) await this.swarm.persist(this.state.storage);
    // Batch all membrane + coordinator writes into ONE atomic storage.put for minimal DO I/O latency.
    // (Cloudflare DO supports a single put({key:val, …}) for up to 10MB transactional payload; our total
    // is well under 4MB even at 100 flies.) The swarm.persist above stays separate because it has its own
    // internal batch logic across multiple shard DOs via RPC.
    const batch: Record<string, unknown> = {};
    if (this.meter) batch[KEY_METER] = this.meter.toJSON();
    if (this.economy) batch[KEY_ECONOMY] = this.economy.serialize();
    if (this.culture) batch[KEY_CULTURE] = this.culture.serialize();
    if (this.religion) batch[KEY_RELIGION] = this.religion.serialize();
    if (this.tech) batch[KEY_TECH] = this.tech.serialize();
    if (this.cities) batch[KEY_CITIES] = this.cities.serialize();
    if (this.apprentice) batch[KEY_APPRENTICE] = this.apprentice.serialize();
    if (this.archive) batch[KEY_ARCHIVE] = this.archive.serialize();
    if (this.court) batch[KEY_COURT] = this.court.serialize();
    if (this.games) batch[KEY_GAMES] = this.games.serialize();
    if (this.guilds) batch[KEY_GUILDS] = this.guilds.serialize();
    if (this.lexicon) batch[KEY_LEXICON] = this.lexicon.serialize();
    if (this.rumor) batch[KEY_RUMOR] = this.rumor.serialize();
    if (this.treaty) batch[KEY_TREATY] = this.treaty.serialize();
    if (this.works) batch[KEY_WORKS] = this.works.serialize();
    if (this.workshop) batch[KEY_WORKSHOP] = this.workshop.serialize();
    if (this.bourse) batch[KEY_BOURSE] = this.bourse.serialize();
    if (this.commons) batch[KEY_COMMONS] = this.commons.serialize();
    if (this.poet) batch[KEY_POET] = this.poet.serialize();
    if (this.prediction) batch[KEY_PREDICT] = this.prediction.serialize();
    if (this.arenaState) batch[KEY_ARENA] = this.arenaState;
    if (this.warRuntime) batch[KEY_WAR] = this.warRuntime;
    batch[KEY_PREV_TEMP] = this.prevTemperature ?? 0.5;
    if (market) batch[KEY_MARKET] = market;
    if (snapshot) {
      this.lastSnapshot = snapshot;
      batch[KEY_LAST_SNAPSHOT] = snapshot;
    }
    batch[KEY_LAST_CRON] = Date.now();
    await this.state.storage.put(batch);
  }

  // ---------- D1 long-term archival (one row per cron; best-effort, never blocks the tick) ----------

  /**
   * Lazily create the archival table + index on first write, so the DO archives correctly even before
   * schema.sql has been applied remotely (belt-and-braces: the remote schema and this DDL are identical).
   */
  private async ensureD1Schema(db: D1Database): Promise<void> {
    if (this.d1SchemaReady) return;
    await db
      .prepare(
        `CREATE TABLE IF NOT EXISTS ticks (
           tick INTEGER PRIMARY KEY, ts INTEGER NOT NULL, temperature REAL NOT NULL, regime TEXT NOT NULL,
           size INTEGER, deals INTEGER, settlements INTEGER, volume_usdc REAL, gini REAL,
           top_state TEXT, top_states TEXT )`,
      )
      .run();
    await db.prepare(`CREATE INDEX IF NOT EXISTS idx_ticks_ts ON ticks (ts)`).run();
    this.d1SchemaReady = true;
  }

  /**
   * Archive ONE row per cron to D1 — the long-term history the DO's in-memory snapshot and the frontend
   * canvas cannot keep. This is what unlocks historical curves, "since launch" statistics, research
   * export and competition-verifiable history. NEVER throws: a missing binding or any D1 error is logged
   * and swallowed, so archival can't take down a live, real-money tick.
   */
  private async archiveTick(
    tick: number,
    temperature: number,
    regime: Regime,
    deals: number,
    snapshot: PopulationSnapshot | null,
    totals: EconomyTotals | null,
  ): Promise<void> {
    const db = this.env.DB;
    if (!db) return;   // D1 not bound (local dev / older deploy) — archival is strictly optional
    try {
      await this.ensureD1Schema(db);
      const ts = Date.now();
      const states = snapshot?.collective.states ?? null;
      let topState: string | null = null;
      if (states) {
        let best = -1;
        for (const [k, v] of Object.entries(states)) {
          if (v > best) { best = v; topState = k; }
        }
      }
      await db
        .prepare(
          `INSERT OR REPLACE INTO ticks
             (tick, ts, temperature, regime, size, deals, settlements, volume_usdc, gini, top_state, top_states)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .bind(
          tick,
          ts,
          temperature,
          regime,
          snapshot?.collective.size ?? null,
          deals,
          totals?.count ?? null,
          totals?.volumeUsdc ?? null,
          totals?.gini ?? null,
          topState,
          states ? JSON.stringify(states) : null,
        )
        .run();
      // Fold this just-written row into the running /history summary — incremental, so the endpoint never
      // re-scans the whole ticks table. Swallowed with the archive itself (a summary miss is non-fatal).
      await this.bumpHistSummary(db, {
        tick,
        ts,
        settlements: totals?.count ?? null,
        volumeUsdc: totals?.volumeUsdc ?? null,
      });
    } catch (e) {
      console.warn("[DO] D1 archive failed (non-fatal):", (e as Error).message);
    }
  }

  /** Load the cached /history summary from DO storage, or seed it ONCE from a full-table aggregate when the DO
   *  has none (a fresh isolate over an existing archive). After this, getHistory reads it straight from memory —
   *  the per-request full-table scan is gone. */
  private async ensureHistSummary(db: D1Database): Promise<HistSummary> {
    if (this.histSummary) return this.histSummary;
    const stored = await this.state.storage.get<HistSummary>(KEY_HIST_SUMMARY);
    if (stored && typeof stored.n === "number") { this.histSummary = stored; return stored; }
    const agg = await db
      .prepare(
        `SELECT COUNT(*) AS n, MIN(tick) AS firstTick, MAX(tick) AS lastTick, MIN(ts) AS firstTs,
                MAX(ts) AS lastTs, MAX(settlements) AS settlements, MAX(volume_usdc) AS volumeUsdc FROM ticks`,
      )
      .all();
    const a: any = (agg.results ?? [])[0] ?? {};
    const seeded: HistSummary = {
      n: Number(a.n ?? 0),
      firstTick: a.firstTick ?? null,
      lastTick: a.lastTick ?? null,
      firstTs: a.firstTs ?? null,
      lastTs: a.lastTs ?? null,
      settlements: a.settlements ?? null,
      volumeUsdc: a.volumeUsdc ?? null,
    };
    this.histSummary = seeded;
    await this.state.storage.put(KEY_HIST_SUMMARY, seeded).catch(() => {});
    return seeded;
  }

  /** Fold one archived row into the running summary. ticks rise monotonically, so a tick > lastTick is a new
   *  record (count++, advance last/first anchors); a tick == lastTick is an INSERT OR REPLACE rewrite of the
   *  newest row (refresh lifetime MAXes, never double-count). */
  private async bumpHistSummary(
    db: D1Database,
    row: { tick: number; ts: number; settlements: number | null; volumeUsdc: number | null },
  ): Promise<void> {
    const s = await this.ensureHistSummary(db);
    if (s.lastTick == null || row.tick > s.lastTick) {
      s.n += 1;
      s.lastTick = row.tick;
      s.lastTs = row.ts;
      if (s.firstTick == null) { s.firstTick = row.tick; s.firstTs = row.ts; }
    } else if (row.tick === s.lastTick) {
      s.lastTs = Math.max(s.lastTs ?? row.ts, row.ts);
    }
    if (s.firstTick == null || row.tick < s.firstTick) { s.firstTick = row.tick; s.firstTs = row.ts; }
    if (row.settlements != null) s.settlements = s.settlements == null ? row.settlements : Math.max(s.settlements, row.settlements);
    if (row.volumeUsdc != null) s.volumeUsdc = s.volumeUsdc == null ? row.volumeUsdc : Math.max(s.volumeUsdc, row.volumeUsdc);
    await this.state.storage.put(KEY_HIST_SUMMARY, s).catch(() => {});
  }

  // ---------- the chronicle (a deterministic historian over the same read-out the economy uses) ----------

  /**
   * Lazily rebuild the historian + its recent-chronicle buffer after an eviction. If the DO buffer is empty
   * but D1 has rows (a cold isolate), backfill the last ANNALS_CAP so /annals is never blank mid-history.
   */
  private async ensureChronicler(): Promise<Chronicler> {
    if (this.chronicler) return this.chronicler;
    const c = new Chronicler(this.cfg.epochs.enabled);
    const stored = await this.state.storage.get<any>(KEY_CHRONICLER);
    if (stored) c.restore(stored);
    const buf = await this.state.storage.get<ChronicleEntry[]>(KEY_ANNALS);
    this.annals = Array.isArray(buf) ? buf : [];
    if (this.annals.length === 0 && this.env.DB) {
      try {
        const db = this.env.DB;
        await this.ensureD1Chronicle(db);
        const r = await db
          .prepare(`SELECT seq, tick, ts, kind, era, era_name, severity, actors, text, metrics, tokens, hash, prev_hash FROM chronicle WHERE hash IS NOT NULL AND hash <> '' ORDER BY seq DESC LIMIT ?`)
          .bind(ANNALS_CAP).all();
        this.annals = (r.results ?? []).map(parseChronicleRow).reverse();
      } catch (e) {
        console.warn("[DO] chronicle backfill failed (non-fatal):", (e as Error).message);
      }
    }
    this.chronicler = c;
    return c;
  }

  /** Lazy DDL for the append-only chronicle table (mirrored in schema.sql; belt-and-braces like ticks). */
  private async ensureD1Chronicle(db: D1Database): Promise<void> {
    if (this.d1ChronicleReady) return;
    await db.prepare(
      `CREATE TABLE IF NOT EXISTS chronicle (
         seq INTEGER PRIMARY KEY, tick INTEGER NOT NULL, ts INTEGER NOT NULL, kind TEXT NOT NULL,
         era INTEGER NOT NULL, era_name TEXT NOT NULL, severity INTEGER NOT NULL,
         actors TEXT NOT NULL, text TEXT NOT NULL, metrics TEXT,
         tokens TEXT, hash TEXT, prev_hash TEXT )`,
    ).run();
    // Migration: a chronicle table deployed before the hash-chain upgrade lacks these columns. SQLite has no
    // "ADD COLUMN IF NOT EXISTS", so each ALTER is attempted and a duplicate-column error is swallowed — a
    // fresh provisioner skips straight through, an already-live table gains the columns in place.
    for (const col of [`tokens TEXT`, `hash TEXT`, `prev_hash TEXT`]) {
      try { await db.prepare(`ALTER TABLE chronicle ADD COLUMN ${col}`).run(); } catch { /* already present */ }
    }
    await db.prepare(`CREATE INDEX IF NOT EXISTS idx_chronicle_ts ON chronicle (ts)`).run();
    this.d1ChronicleReady = true;
  }

  /** Persist newly-detected entries to D1 (append-only, best-effort — a D1 failure never blocks the tick). */
  private async writeChronicle(entries: ChronicleEntry[]): Promise<void> {
    const db = this.env.DB;
    if (!db) return;
    try {
      await this.ensureD1Chronicle(db);
      await db.batch(entries.map((e) =>
        db.prepare(
          `INSERT OR REPLACE INTO chronicle (seq, tick, ts, kind, era, era_name, severity, actors, text, metrics, tokens, hash, prev_hash)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ).bind(e.seq, e.tick, e.ts, e.kind, e.era, e.eraName, e.severity, JSON.stringify(e.actors), e.text, JSON.stringify(e.metrics), JSON.stringify(e.tokens), e.hash, e.prevHash),
      ));
    } catch (e) {
      console.warn("[DO] chronicle D1 write failed (non-fatal):", (e as Error).message);
    }
  }

  /** Lazy DDL for the Laureate's permanent poem archive (mirrored in schema.sql; belt-and-braces like chronicle). */
  private async ensureD1Poems(db: D1Database): Promise<void> {
    if (this.d1PoemsReady) return;
    await db.prepare(
      `CREATE TABLE IF NOT EXISTS poems (
         seq INTEGER PRIMARY KEY, tick INTEGER NOT NULL, ts INTEGER NOT NULL, era INTEGER NOT NULL,
         era_name TEXT NOT NULL, phase TEXT, laureate_id INTEGER, hash TEXT NOT NULL, prev_hash TEXT,
         entry TEXT NOT NULL )`,
    ).run();
    await db.prepare(`CREATE INDEX IF NOT EXISTS idx_poems_ts ON poems (ts)`).run();
    this.d1PoemsReady = true;
  }

  /**
   * Archive ONE composed poem to D1 so the collection is PERMANENT (the DO ring only keeps POEMS_CAP for the
   * live chain head). Best-effort: a missing binding or any D1 error is logged and swallowed, so it can never
   * block a tick. `entry` is stored verbatim, so /poem/archive serves byte-identical PoemEntry objects that any
   * verifier can recompute (poemReceiptHash) and replay (compose) offline. PURE READ-OUT — no brain/wallet touched.
   */
  private async archivePoem(entry: PoemEntry): Promise<void> {
    const db = this.env.DB;
    if (!db) return;
    try {
      await this.ensureD1Poems(db);
      await db
        .prepare(
          `INSERT OR REPLACE INTO poems
             (seq, tick, ts, era, era_name, phase, laureate_id, hash, prev_hash, entry)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .bind(
          entry.seq, entry.composedAtTick, Date.now(), entry.era.era, entry.era.eraName,
          entry.era.civPhase ?? null, entry.laureate?.id ?? null, entry.hash, entry.prevHash,
          JSON.stringify(entry),
        )
        .run();
    } catch (e) {
      console.warn("[DO] poem D1 archive failed (non-fatal):", (e as Error).message);
    }
  }

  /** Read ONE archived poem's full entry back from D1 (best-effort; null when unbound/absent). Lets /poem/verify
   *  recompute + replay poems the DO hot ring has already evicted, so every archived poem stays verifiable. */
  private async readPoemArchiveEntry(seq: number): Promise<PoemEntry | null> {
    const db = this.env.DB;
    if (!db || !Number.isFinite(seq)) return null;
    try {
      await this.ensureD1Poems(db);
      const r = await db.prepare(`SELECT entry FROM poems WHERE seq = ?`).bind(seq).first<{ entry: string }>();
      if (!r) return null;
      const e = JSON.parse(r.entry) as PoemEntry;
      return e && typeof e.seq === "number" ? e : null;
    } catch { return null; }
  }

  /** One-time, best-effort backfill: fold every poem currently in the DO hot ring into the permanent D1
   *  archive, so poems composed before this archive shipped (the ring head at deploy) survive aging out of
   *  the 64-cap ring. Idempotent (archivePoem is INSERT OR REPLACE on the seq PK) and guarded, so it runs
   *  once per DO life; triggered from both drivePoet (the first cron) and getPoemArchive (a drawer open).
   *  PURE READ-OUT — touches no brain, genome or USDC. */
  private async backfillPoemRing(poet: Poet | null): Promise<void> {
    if (this.d1PoemsBackfilled || !poet || !this.env.DB) return;
    this.d1PoemsBackfilled = true;   // set first: even a partial backfill leaves new poems archiving normally
    try {
      for (const prior of poet.recent(500)) await this.archivePoem(prior);
    } catch (e) {
      console.warn("[DO] poem ring backfill failed (non-fatal):", (e as Error).message);
    }
  }

  /**
   * Run the historian once per cron. PURE READ-OUT: it observes the collective + ethogram + lifetime economy
   * totals and appends any detected history. It never touches a brain, drive, wallet or settlement — so the
   * on-chain manifest and the money path are untouched. Best-effort persistence; a failure can't stop the tick.
   */
  private async observeChronicle(
    tick: number,
    snapshot: PopulationSnapshot | null,
    temperature: number,
    regime: Regime,
    pulse: { richness: number },
  ): Promise<void> {
    try {
      const c = await this.ensureChronicler();
      const col = snapshot?.collective;
      const totals = this.lastEconomy?.totals ?? null;
      const epochsOn = this.cfg.epochs.enabled;
      // The governance shock is consumed once, only while epochs are ON — otherwise it dies with the cron.
      const governanceShock = epochsOn ? this.pendingGovernanceShock : null;
      this.pendingGovernanceShock = null;
      // ⑤ CULTURE + ⑥ INSTITUTIONS chronicle read-outs, folded in ONLY while the matching switch is ON.
      // Off ⇒ the field stays null ⇒ the historian's culture/market detectors never speak ⇒ byte-for-byte
      // the pre-layer chronicle. Both are pure reads of state already computed elsewhere (never feed back).
      const cultureOn = this.cfg.culture.enabled;
      const cul = cultureOn && this.culture && snapshot ? this.culture.signals(snapshot.flies) : null;
      const culture = cul
        ? {
            trend: cul.trend ? { fap: cul.trend.fap, adherents: cul.trend.adherents, share: cul.trend.share } : null,
            tradition: cul.tradition
              ? { houseId: cul.tradition.houseId, name: cul.tradition.name, sigil: cul.tradition.sigil, fap: cul.tradition.fap, streak: cul.tradition.streak }
              : null,
          }
        : null;
      // ⑪ RELIGION chronicle read-out, folded in ONLY while the switch is ON. Off ⇒ the field stays null ⇒
      // the historian's PROPHECY/SCHISM/REVIVAL/PILGRIMAGE detectors never speak ⇒ byte-for-byte the pre-faith
      // chronicle. A pure read of the membrane's own edge-detected signals (never feeds back).
      const religionOn = this.cfg.religion.enabled;
      const relSig = religionOn && this.religion && snapshot ? this.religion.signals(snapshot.flies, regime) : null;
      const religion = relSig
        ? {
            reigning: relSig.reigning,
            holyIn: relSig.holyIn,
            sects: relSig.sects.map((x) => ({ name: x.name, god: x.god, adherents: x.adherents, prophetId: x.prophetId, houseId: x.houseId })),
            prophecy: relSig.prophecy,
            schism: relSig.schism,
            revival: relSig.revival,
            pilgrimage: relSig.pilgrimage,
          }
        : null;
      // ⑬⑭ TECH + CITIES chronicle read-outs, folded in ONLY while the matching switch is ON and step 6b drove
      // the membrane this cron. Off ⇒ the field stays null ⇒ the historian's ladder/map detectors never speak ⇒
      // byte-for-byte the pre-layer chronicle. Both are pure reads of the membranes' OWN edge-detected events,
      // so a standing art or a standing town is never re-announced (the anti-stutter rule).
      const techSig = this.cfg.tech.enabled ? this.tech?.signals() ?? null : null;
      const tech = techSig
        ? {
            discovery: techSig.discovery
              ? { rung: techSig.discovery.rung, name: techSig.discovery.name, gen: techSig.discovery.gen, civ: techSig.discovery.civ, credit: techSig.discovery.credit }
              : null,
            diffusion: techSig.diffusion,
            lostArt: techSig.lostArt,
            rungCount: techSig.rungs.length,
            lostCount: techSig.lost.length,
          }
        : null;
      const citySig = this.cfg.cities.enabled ? this.cities?.signals() ?? null : null;
      const cities = citySig
        ? {
            founding: citySig.founding
              ? { zone: citySig.founding.zone, name: citySig.founding.name, rank: citySig.founding.rank, pop: citySig.founding.pop, house: houseCreditOf(citySig.founding.houseName) }
              : null,
            urbanization: citySig.urbanization
              ? {
                  urban: citySig.urbanization.urban, size: citySig.urbanization.size,
                  settlements: citySig.urbanization.settlements, largest: citySig.urbanization.largest,
                  largestPop: citySig.urbanization.largestPop,
                }
              : null,
            census: citySig.census,
            plagueWave: citySig.plagueWave,
            settlementCount: citySig.settlements.length,
            urbanShare: citySig.urbanShare,
          }
        : null;
      // ⑯ APPRENTICESHIP: fold the membrane's own edge-detected education events. Off ⇒ this.apprentice is null
      // ⇒ no `apprentice` in the context ⇒ the historian's education detectors never speak ⇒ byte-for-byte the
      // pre-education chronicle. transmission/surpass/craftLost already match the facet shape; school is mapped
      // to drop the houseId the historian's template never reads.
      const apprSig = this.cfg.apprentice.enabled ? this.apprentice?.signals() ?? null : null;
      const apprentice = apprSig
        ? {
            transmission: apprSig.transmission,
            surpass: apprSig.surpass,
            school: apprSig.school
              ? { rung: apprSig.school.rung, name: apprSig.school.name, houseName: apprSig.school.houseName, sigil: apprSig.school.sigil, adherents: apprSig.school.adherents }
              : null,
            craftLost: apprSig.craftLost,
            skilled: apprSig.skilled,
            topCraft: apprSig.topCraft,
          }
        : null;
      // ⑰ ARCHIVE: fold the externalized-knowledge read-out ONLY while ARCHIVE is on. Off ⇒ no `archive` key
      // ⇒ the historian's RECORDING/DECODE/ARCHIVE_BURNED detectors never speak.
      const archSig = this.cfg.archive.enabled ? this.archive?.signals() ?? null : null;
      const archive = archSig
        ? {
            recording: archSig.recording,
            decode: archSig.decode,
            archiveBurned: archSig.archiveBurned,
            records: archSig.records.length,
            recorded: archSig.recorded,
            decodes: archSig.decodes,
          }
        : null;
      // ⑱ WORKSHOP: fold the reinvention read-out ONLY while WORKSHOP is on. Off ⇒ no `workshop` key
      // ⇒ the historian's REINVENTION detector never speaks.
      const wrkSig = this.cfg.workshop.enabled ? this.workshop?.signals() ?? null : null;
      const workshop = wrkSig
        ? { reinvention: wrkSig.reinvention, reinventions: wrkSig.reinventions }
        : null;
      // ⑲ BOURSE: fold the coin tape's edge events ONLY while BOURSE is on. Off ⇒ no `bourse` key ⇒ the
      // historian's four coin detectors never speak (the ctx.bourse guards in reckon() stay asleep).
      const bouSig = this.cfg.bourse.enabled ? this.bourseSignals : null;
      const bourse = bouSig
        ? { fever: bouSig.fever, whale: bouSig.whale, tithe: bouSig.tithe, silence: bouSig.silence }
        : null;
      // ⑳ COURT: fold the docket's edge events ONLY while COURT is on. Off ⇒ no `court` key ⇒ the
      // historian's five court detectors never speak (byte-for-byte the pre-court build).
      const court = this.cfg.court.enabled ? this.court?.signals() ?? null : null;
      // ㉑ GAMES: fold the festival's edge events ONLY while GAMES is on. Off ⇒ no `games` key ⇒ the
      // historian's three games detectors never speak (byte-for-byte the pre-Games build).
      const games = this.cfg.games.enabled ? this.games?.signals() ?? null : null;
      // ㉒ GUILDS: fold the guildhall's edge events ONLY while GUILD is on. Off ⇒ no `guilds` key ⇒ the
      // historian's three guild detectors never speak (byte-for-byte the pre-Guilds build).
      const guilds = this.cfg.guilds.enabled ? this.guilds?.signals() ?? null : null;
      // ㉓ LEXICON: fold the desk's word edges ONLY while LEX is on. Off ⇒ no `lexicon` key ⇒ the
      // historian's three lexicon detectors never speak (byte-for-byte the pre-Lexicon build).
      const lexicon = this.cfg.lexicon.enabled ? this.lexicon?.signals() ?? null : null;
      // ㉔ RUMOR MILL: fold the mill's tale edges ONLY while RM is on. Off ⇒ no `rumor` key ⇒ the
      // historian's three rumor detectors never speak (byte-for-byte the pre-Rumor build).
      const rumor = this.cfg.rumor.enabled ? this.rumor?.signals() ?? null : null;
      // ㉕ TREATY: fold the chancery's diplomatic edges ONLY while TR is on. Off ⇒ no `treaty` key ⇒ the
      // historian's three treaty detectors never speak (byte-for-byte the pre-Treaty build).
      const treaty = this.cfg.treaty.enabled ? this.treaty?.signals() ?? null : null;
      // ㉖ WORKS: fold the yard's construction edges ONLY while WORKS is on. Off ⇒ no `works` key ⇒ the
      // historian's three works detectors never speak (byte-for-byte the pre-Works build).
      const works = this.cfg.works.enabled ? this.works?.signals() ?? null : null;
      const mr = this.cfg.institutions.enabled ? this.lastEconomy?.market ?? null : null;
      const market = mr
        ? {
            marks: Object.fromEntries(Object.entries(mr.marks).map(([g, tape]) => [g, tape.length ? Number(tape[tape.length - 1]) / 1e6 : 0])),
            openIous: mr.openIous,
            topIou: mr.topIou,
            run: mr.run,
            badRate: mr.badRate,
            creditors: mr.classes.creditors,
            creditorNetShare: mr.creditorNetShare,
          }
        : null;
      // ⑧ fold the commons read-out ONLY while LAW is on AND the commons instance exists (null when
      // institutions/economy off). Off ⇒ no `commons` key ⇒ the historian's ASSEMBLY/DECREE detectors never speak.
      const comRo = this.cfg.law.enabled ? this.commons?.readout() ?? null : null;
      const commons = comRo
        ? {
            seatedEra: comRo.seatedEra,
            seats: comRo.seats.length,
            decrees: comRo.decrees.map((d) => ({ param: d.param, target: d.target })),
          }
        : null;
      // ⑨ fold driveWar's transient cron events into the historian ONLY while WAR is on. Off (or a cron that
      // mined nothing) ⇒ warEvents is empty ⇒ war stays null ⇒ no WAR/TAX line, byte-for-byte the pre-war build.
      // Declared/resolved take the single bout this cron saw; tax aggregates every vault-holding house's levy.
      const warDeclared = this.warEvents.find((e) => e.kind === "declared") ?? null;
      const warResolved = this.warEvents.find((e) => e.kind === "resolved") ?? null;
      const warSeized = this.warEvents.find((e) => e.kind === "seized") ?? null;
      const taxedEvents = this.warEvents.filter((e) => e.kind === "taxed");
      const war = this.cfg.war.enabled && this.warEvents.length
        ? {
            declared: warDeclared
              ? { attackerId: warDeclared.attackerId, defenderId: warDeclared.defenderId, attackerName: warDeclared.attackerName, defenderName: warDeclared.defenderName, stakeUsdc: warDeclared.stakeUsdc, potUsdc: warDeclared.potUsdc }
              : null,
            resolved: warResolved
              ? { attackerId: warResolved.attackerId, defenderId: warResolved.defenderId, attackerName: warResolved.attackerName, defenderName: warResolved.defenderName, winnerId: warResolved.winnerId, potUsdc: warResolved.potUsdc, stakeUsdc: warResolved.stakeUsdc }
              : null,
            tax: taxedEvents.length
              ? { houseCount: taxedEvents.length, taxUsdc: taxedEvents.reduce((a, e) => a + e.taxUsdc, 0) }
              : null,
            // territory conquest (additive): the zones annexed on a war resolved THIS cron. Present only when a
            // seizure actually mined; null keeps the chronicle byte-for-byte the pre-conquest build. Winner/loser
            // names are derived from the stored bout names (nameOf is scoped to driveWar, not here).
            seized: warSeized
              ? {
                  winnerId: warSeized.winnerId,
                  loserId: warSeized.loserId ?? null,
                  winnerName: warSeized.winnerId === warSeized.attackerId ? warSeized.attackerName : warSeized.defenderName,
                  loserName: warSeized.loserId === warSeized.attackerId ? warSeized.attackerName : warSeized.defenderName,
                  zones: warSeized.zonesSeized ?? [],
                }
              : null,
          }
        : null;
      const ctx: ChronicleContext = {
        tick,
        ts: Date.now(),
        temperature,
        regime,
        size: col?.size ?? 0,
        states: (col?.states ?? {}) as Record<string, number>,
        faps: (col?.faps ?? {}) as Record<string, number>,
        valence: col?.valence ?? 0,
        arousal: col?.arousal ?? 0,
        cohesion: col?.cohesion ?? 0,
        rest: col?.rest ?? 0,
        settlements: totals?.count ?? 0,
        volumeUsdc: totals?.volumeUsdc ?? 0,
        gini: totals?.gini ?? 0,
        richestId: totals?.richestId ?? null,
        poorestId: totals?.poorestId ?? null,
        liveAgents: totals?.liveAgents ?? col?.size ?? 0,
        meanBalanceUsdc: totals?.meanBalanceUsdc ?? 0,
        // SOCIAL signals come from the economy's OWN persisted bonds/reputations (pure read-out — the
        // historian narrates relationships, it never creates or feeds them).
        social: this.economy?.socialSignals() ?? null,
        // DYNASTY signals likewise: foundings, a house holding the swarm's capital, and the newest grave
        // — all read from the economy's persisted kinship ledger. The historian only writes the epitaph.
        dynasty: this.economy?.dynastySignals() ?? null,
        // ⑦ EPOCHS: the shock detectors' extra read-outs. Folded in ONLY while epochs are ON — OFF these
        // stay undefined ⇒ the detectors never fire and era logic is byte-for-byte today's regime drift.
        richness: epochsOn ? pulse.richness : null,
        deathsRecent: epochsOn && this.economy ? this.economy.recentDeaths(tick, 30) : null,
        governanceShock,
        culture,
        market,
        commons,
        war,
        religion,
        tech,
        cities,
        apprentice,
        archive,
        workshop,
        bourse,
        court,
        games,
        guilds,
        lexicon,
        rumor,
        treaty,
        works,
      };
      const entries = await c.observe(ctx);
      if (entries.length) {
        this.annals.push(...entries);
        if (this.annals.length > ANNALS_CAP) this.annals = this.annals.slice(-ANNALS_CAP);
        await this.writeChronicle(entries);
      }
      await this.state.storage.put(KEY_CHRONICLER, c.snapshot());
      if (entries.length) await this.state.storage.put(KEY_ANNALS, this.annals);
    } catch (e) {
      console.warn("[DO] chronicle observe failed (non-fatal):", (e as Error).message);
    }
  }

  /**
   * ⑬⑭ Drive the ladder of arts and the settlement map over ONE cron, so step 7 can fold their edge-detected
   * events into the historian's context. Both membranes live on the HISTORIAN'S fast clock: the generation edge
   * is read off eraInfo(), and each membrane turns only when that generation is newer than the one it last saw
   * — so a DO evicted mid-generation costs one line at most and never double-counts a rung or a census.
   * PURE READ-OUT: the only inputs are the economy's own snapshot (per-fly zone, grave ring, dynasty rows), the
   * snapshot's size and the historian's reckoning; nothing here re-prices a deal, moves a fly, or touches a
   * connectome / genome / manifestHash. Best-effort — a throw can never block the live tick.
   */
  private async driveTechAndCities(tick: number, snapshot: PopulationSnapshot | null): Promise<void> {
    const tech = await this.ensureTech();
    const cities = await this.ensureCities();
    if (!tech && !cities) return;
    try {
      const size = snapshot?.collective.size ?? 0;
      const era = this.chronicler ? this.chronicler.eraInfo() : null;
      const gen = era ? era.generation : 0;
      const econ = this.lastEconomy;
      if (cities && econ) {
        // The zone ledger is the territory layer's own per-fly read-out (a fly sits in its house's home zone);
        // rebuilt here from the snapshot rather than re-deriving anything, and null while territory is off ⇒
        // the map stays empty and only the census speaks.
        const zones: Record<number, number> = {};
        for (const a of econ.agents) if (a.zone != null && !a.dead) zones[a.id] = a.zone;
        const dyn = econ.dynasty ?? null;
        cities.survey({
          tick,
          size,
          zones: Object.keys(zones).length ? zones : null,
          zoneOwners: dyn?.zoneOwners ?? null,
          graves: (dyn?.graves ?? []).map((g) => ({ tick: g.tick, age: g.age, cause: g.cause })),
          living: dyn?.living ?? 0,
          dead: dyn?.dead ?? 0,
          deathsRecent: this.economy ? this.economy.recentDeaths(tick, 30) : 0,
        });
        if (gen > cities.generation()) cities.turnGeneration(tick, gen);
      }
      if (tech) {
        tech.diffuse(tick, size);
        if (gen > tech.generation()) {
          // the ladder's credit goes to the house holding the swarm's capital, if one does — a pure read of the
          // dynasty signals the historian already narrates, never a new claim about who invented what.
          const dom = this.economy?.dynastySignals()?.dominance ?? null;
          tech.turnGeneration(tick, gen, era ? era.civLevel : 0, size, dom ? { id: dom.id, name: dom.name } : null);
        }
      }
    } catch (e) {
      console.warn("[DO] tech/cities drive failed (non-fatal):", (e as Error).message);
    }
  }

  /**
   * ⑯ Drive the apprenticeship membrane over ONE cron, AFTER the ladder has diffused/turned (driveTechAndCities),
   * so the ceiling on what any hand may learn is the swarm's CURRENT invented top. PURE READ-OUT: the inputs are
   * the population snapshot's own readings (the same feeding cohort culture and faith read), the ladder's highest
   * rung, and the economy's houseOf — nothing here re-prices a deal, moves a fly or touches a connectome. If ⑬ is
   * off the ladder is empty (inventedTop 0) and this membrane simply never speaks. Best-effort — a throw can
   * never block the live tick.
   */
  private async driveApprentice(tick: number, snapshot: PopulationSnapshot | null): Promise<void> {
    const appr = await this.ensureApprentice();
    if (!appr || !snapshot) return;
    try {
      // the ceiling on a personal craft = the highest rung ⑬ has actually invented this cron (1-based; 0 ⇒ silent).
      const techSig = this.cfg.tech.enabled ? this.tech?.signals() ?? null : null;
      let inventedTop = 0;
      if (techSig) for (const r of techSig.rungs) if (r.rung > inventedTop) inventedTop = r.rung;
      const econ = this.economy;
      appr.round(tick, snapshot.flies, inventedTop, (id) => econ?.houseOf(id) ?? null);
    } catch (e) {
      console.warn("[DO] apprentice drive failed (non-fatal):", (e as Error).message);
    }
  }

  /**
   * ⑰ ARCHIVE: drive the externalized-knowledge membrane over ONE cron. Reads ⑯'s keeper map, ⑬'s invented top,
   * civLevel from eraInfo, and the live fly list. PURE READ-OUT — never modifies ⑯ or any economic state.
   * Best-effort: a throw can never block the live tick.
   */
  private async driveArchive(tick: number, snapshot: PopulationSnapshot | null): Promise<void> {
    const arch = await this.ensureArchive();
    if (!arch || !snapshot) return;
    try {
      const apprSig = this.cfg.apprentice.enabled ? this.apprentice?.signals() ?? null : null;
      const keeperMap = new Map<number, number>();
      if (apprSig) for (const k of apprSig.keepers) keeperMap.set(k.id, k.craft);
      let inventedTop = 0;
      if (apprSig) inventedTop = apprSig.topCraft;
      const era = this.chronicler ? this.chronicler.eraInfo() : null;
      const civLevel = era ? era.civLevel : 0;
      const flyIds = snapshot.flies.map((f) => f.id);
      arch.round(tick, keeperMap, inventedTop, civLevel, flyIds);
    } catch (e) {
      console.warn("[DO] archive drive failed (non-fatal):", (e as Error).message);
    }
  }

  /**
   * ⑱ THE WORKSHOP — give explorer flies agency to reinvent lost arts between generation edges.
   * Reads the tech membrane's `lost` set and the population's EXPLORE-state flies. On success:
   * restores the art to the ladder (invention.restoreArt) and injects the fly as first keeper
   * (apprentice.injectKeeper). PURE READ-OUT + two writes that only ADD state, never remove.
   */
  private async driveWorkshop(tick: number, snapshot: PopulationSnapshot | null): Promise<void> {
    const wrk = await this.ensureWorkshop();
    if (!wrk || !snapshot) return;
    try {
      const techSig = this.cfg.tech.enabled ? this.tech?.signals() ?? null : null;
      const lostArts = techSig ? techSig.lost : [];
      const explorerIds = snapshot.flies.filter((f) => f.state === "EXPLORE").map((f) => f.id);
      wrk.round(tick, lostArts, explorerIds);
      // On reinvention: restore the art to the ladder and inject the fly as its first new keeper.
      const sig = wrk.signals();
      if (sig.reinvention && this.tech && this.apprentice) {
        const r = sig.reinvention;
        this.tech.restoreArt(r.rung, tick, snapshot.flies.length);
        this.apprentice.injectKeeper(r.id, r.rung);
      }
    } catch (e) {
      console.warn("[DO] workshop drive failed (non-fatal):", (e as Error).message);
    }
  }

  /**
   * ⑳ THE COURT — turn the ledgers' own grievances into docketed cases: indictment, trial, verdict, exile,
   * and the amnesty that turns of an era bring. PURE READ-OUT: every fact is borrowed from the economy's
   * social signals, the historian's era counter and the snapshot's living ids; the court writes only its
   * OWN bounded roll — it moves no money and never touches a connectome, genome, fingerprint or
   * manifestHash. Best-effort: a sitting court can never break the live tick.
   */
  private async driveCourt(tick: number, snapshot: PopulationSnapshot | null): Promise<void> {
    const crt = await this.ensureCourt();
    if (!crt || !snapshot) return;
    try {
      const social = this.economy?.socialSignals() ?? null;
      const era = this.chronicler ? this.chronicler.eraInfo().era : 0;
      const facts: CourtFacts = {
        deadbeat: social?.deadbeat ?? null,
        betrayal: social?.betrayal ?? null,
        feud: social?.topFeud ?? null,
        era,
        livingIds: snapshot.flies.map((f) => f.id),
      };
      crt.round(tick, facts);
    } catch (e) {
      console.warn("[DO] court drive failed (non-fatal):", (e as Error).message);
    }
  }

  /**
   * ㉑ THE GAMES — ring the era bell: a new age may proclaim the festival, and a set span later the living
   * field crowns its own champion by the era's hash, the stadium's mark measured in the champion's OWN
   * lifetime settlements. PURE READ-OUT: every fact is borrowed from the dynasty signals, the historian's
   * era counter, the economy ledger's deal counts and the snapshot's living ids; the games write only their
   * OWN bounded roll — no money moves by any crown. Best-effort: a festival can never break the live tick.
   */
  private async driveGames(tick: number, snapshot: PopulationSnapshot | null): Promise<void> {
    const gms = await this.ensureGames();
    if (!gms || !snapshot) return;
    try {
      const dyn = this.economy?.dynastySignals() ?? null;
      const agents = this.lastEconomy?.agents ?? [];
      const facts: GamesFacts = {
        era: this.chronicler ? this.chronicler.eraInfo().era : 0,
        livingIds: snapshot.flies.map((f) => f.id),
        venueHouse: dyn?.dominance?.name ?? null,
        dealsOf: (id) => {
          const a = agents.find((x) => x.id === id);
          return a ? (a.deals ?? 0) + (a.sales ?? 0) : 0;
        },
        houseOf: (id) => this.economy?.houseOf(id)?.name ?? null,
      };
      gms.round(tick, facts);
    } catch (e) {
      console.warn("[DO] games drive failed (non-fatal):", (e as Error).message);
    }
  }

  /**
   * ㉒ THE GUILDS — read the economy's OWN sticky professions across the living roster: a trade past
   * quorum wins a charter, a fly taking up a chartered trade strikes a pact, and a guild whose share of
   * the working swarm RISES past the mark claims a monopoly. PURE READ-OUT: no seal moves money or tilts
   * a price — the profession ledger is the economy's, this membrane only watches it socially.
   * Best-effort: a guildhall can never break the live tick.
   */
  private async driveGuilds(tick: number, snapshot: PopulationSnapshot | null): Promise<void> {
    const gld = await this.ensureGuilds();
    if (!gld || !snapshot) return;
    try {
      const agents = this.lastEconomy?.agents ?? [];
      const facts: GuildFacts = {
        era: this.chronicler ? this.chronicler.eraInfo().era : 0,
        workforce: snapshot.flies.map((f) => ({
          id: f.id,
          prof: agents.find((x) => x.id === f.id)?.profession ?? null,
        })),
      };
      gld.round(tick, facts);
    } catch (e) {
      console.warn("[DO] guilds drive failed (non-fatal):", (e as Error).message);
    }
  }

  /**
   * ㉓ THE LEXICON — compile the dictionary BACKWARDS out of the chronicle: scan the hot annals roll (the
   * swarm's living memory of its own tellings) for per-kind counts and seq numbers; the desk coins words
   * at LEX_COIN_AT tellings, marks doublings as spread, and buries words the silence has outlasted.
   * PURE READ-OUT: no money moves, no chronicle line changes — naming only names what was already told.
   * Runs after driveGuilds and BEFORE observeChronicle, so the roll it reads is the one already history:
   * a word enters the lexicon after the telling that made it (a one-cron lag by design, not by accident).
   * Best-effort: a lexicographer's desk can never break the live tick.
   */
  private async driveLexicon(tick: number): Promise<void> {
    const lx = await this.ensureLexicon();
    if (!lx) return;
    try {
      const uses: Record<string, number> = {};
      const lastSeq: Record<string, number> = {};
      let maxSeq = 0;
      for (const e of this.annals) {
        if (e.seq > maxSeq) maxSeq = e.seq;
        uses[e.kind] = (uses[e.kind] ?? 0) + 1;
        lastSeq[e.kind] = e.seq;
      }
      const facts: LexiconFacts = {
        era: this.chronicler ? this.chronicler.eraInfo().era : 0,
        uses,
        lastSeq,
        maxSeq,
      };
      lx.round(tick, facts);
    } catch (e) {
      console.warn("[DO] lexicon drive failed (non-fatal):", (e as Error).message);
    }
  }

  /**
   * ㉔ THE RUMOR MILL — listen to the tellings the chronicle has ALREADY spoken: the roll's newest lines
   * are the market's fresh news; the mill adopts ONE tale, counts its ears, lets it bend in the retelling
   * and go quiet. The DRIVE here is pure read-out — the causal leg is apply() in the sub-tick loop (the
   * religion contract: a read-out override on telling-days only), never money, never the stimulus bus.
   * Runs after driveLexicon and BEFORE observeChronicle, so the mill only ever hears tellings already
   * history (the dictionary's one-cron honesty, the same door). Best-effort: a market square can never
   * break the live tick.
   */
  private async driveRumor(tick: number): Promise<void> {
    const rm = await this.ensureRumor();
    if (!rm) return;
    try {
      let maxSeq = 0;
      for (const e of this.annals) if (e.seq > maxSeq) maxSeq = e.seq;
      const facts: RumorFacts = {
        era: this.chronicler ? this.chronicler.eraInfo().era : 0,
        news: this.annals.slice(-20).map((e) => ({ seq: e.seq, kind: e.kind as string, sev: e.severity, actors: e.actors })),
        maxSeq,
      };
      rm.round(tick, facts);
    } catch (e) {
      console.warn("[DO] rumor drive failed (non-fatal):", (e as Error).message);
    }
  }

  /**
   * ㉕ THE TREATY — document the feuds the house-bond ledger has ALREADY recorded: the chancery reads
   * this cron's aggregate cross-house bonds (the very series WarCoffer declares wars over) and sets
   * seals, ratifies them, or records their breach as the bond crosses its own lines. PURE read-out end
   * to end — unlike ㉔ there is NO causal leg: no reading, role or register is ever overridden by a
   * seal. Best-effort: diplomacy can never break the live tick.
   */
  private async driveTreaty(economy: AgentEconomy, tick: number): Promise<void> {
    const tr = await this.ensureTreaty();
    if (!tr) return;
    try {
      tr.setNames((id) => economy.houseNameById(id) ?? `House ${id}`);
      const facts: TreatyFacts = {
        era: this.chronicler ? this.chronicler.eraInfo().era : 0,
        feuds: economy.houseFeuds().map((f) => ({ a: f.a, b: f.b, score: f.score })),
      };
      tr.round(tick, facts);
    } catch (e) {
      console.warn("[DO] treaty drive failed (non-fatal):", (e as Error).message);
    }
  }

  /**
   * ㉖ THE PUBLIC WORKS — read the era's fortune and the credit book's dread and let the yard raise, mend
   * or lose a common work. PURE read-out end to end, NO causal leg: no fly is commanded to build and no
   * purse taxed — the roll only names what eraInfo's reckoning and the market's bad paper already imply.
   * Best-effort: a public work can never break the live tick.
   */
  private async driveWorks(tick: number): Promise<void> {
    const wk = await this.ensureWorks();
    if (!wk) return;
    try {
      const info = this.chronicler ? this.chronicler.eraInfo() : null;
      const snap = this.lastEconomy;
      const facts: WorksFacts = {
        era: info ? info.era : 0,
        generation: info ? info.generation : 0,
        civLevel: info ? info.civLevel : 0,
        civPhase: info ? info.civPhase : "ascendant",
        size: snap ? snap.agents.filter((a) => !a.dead).length : 0,
        credit: snap?.market ? { run: snap.market.run, badRate: snap.market.badRate } : null,
      };
      wk.round(tick, facts);
    } catch (e) {
      console.warn("[DO] works drive failed (non-fatal):", (e as Error).message);
    }
  }

  /**
   * ⑧ THE COMMONS — convene the assembly when the historian has just raised a NEW era. The roster is a
   * pure read-out of the economy snapshot already taken this cron (living agents + their reputations), and
   * the era is the historian's own counter, so the shock/era logic stays single-sourced. Inert while law
   * is off; best-effort so a council can never break the tick.
   */
  private async driveCommons(): Promise<void> {
    const commons = await this.ensureCommons();
    if (!commons || !this.chronicler) return;
    try {
      const snap = this.lastEconomy;
      if (!snap) return;
      const repOf = new Map<number, number>();
      for (const r of snap.social.rep) repOf.set(r.id, r.score);
      const roster: CommonsSeat[] = snap.agents
        .filter((a) => !a.dead)
        .map((a) => ({ id: a.id, address: a.address, balanceAtomic: a.balance, rep: repOf.get(a.id) ?? 0 }));
      if (commons.convene(this.chronicler.eraInfo().era, roster)) {
        const eff = commons.effectiveParams();
        console.log(
          `[DO] commons convened era ${this.chronicler.eraInfo().era} · ${commons.size} seats · ` +
            `credit=${eff.creditCapBaseUsdc ?? "base"} rate=${eff.iouRatePer10 ?? "base"}`,
        );
      }
    } catch (e) {
      console.warn("[DO] commons convene failed (non-fatal):", (e as Error).message);
    }
  }

  /**
   * ⑮ THE LAUREATE — drive the swarm's poet over THIS cron. Crowns a new laureate when the historian has just
   * raised a new era (or the sitting poet died), and writes a poem on that coronation or ≈hourly (minCrons).
   * PURE READ-OUT: the only inputs are the era the historian already reckoned, the decoded FlyReading of the
   * crowned fly, and the economy's own totals/graves — nothing here re-prices a deal, moves a fly, or touches a
   * connectome / genome / manifestHash, and unlike ① it never writes back into the neural input. Best-effort.
   */
  private async drivePoet(tick: number, snapshot: PopulationSnapshot | null, temperature: number, regime: Regime): Promise<void> {
    const poet = await this.ensurePoet();
    if (!poet || !this.chronicler || !snapshot) return;
    try {
      await this.backfillPoemRing(poet);   // preserve any pre-archive ring poems on the first cron post-deploy
      const liveIds = snapshot.flies.map((f) => f.id);
      if (!liveIds.length) return;
      const era = this.chronicler.eraInfo();
      const econ = this.lastEconomy;
      const cron = Math.floor(tick / Math.max(1, this.cfg.ticksPerCron));
      // deaths over ≈ the poem cadence window (best-effort: bounded by the economy's own grave ring)
      const deathsWindow = Math.max(1, this.cfg.poet.minCrons * this.cfg.ticksPerCron);
      const deathsDelta = this.economy ? this.economy.recentDeaths(tick, deathsWindow) : 0;
      const entry = await poet.maybeCompose({
        tick,
        cron,
        era,
        liveIds,
        readingOf: (id) => snapshot.flies.find((f) => f.id === id) ?? null,
        houseOf: (id) => this.economy?.houseOf(id)?.name ?? null,
        temperature,
        regime,
        totals: econ
          ? { volumeUsdc: econ.totals.volumeUsdc, count: econ.totals.count, liveAgents: econ.totals.liveAgents, gini: econ.totals.gini }
          : null,
        deathsDelta,
      });
      if (entry) {
        console.log(`[DO] poet: seq#${entry.seq} crowned #${entry.laureate.id} (era ${entry.era.era}) — "${entry.lines[0]} …"`);
        await this.archivePoem(entry);   // permanent D1 archive (the DO ring is only the hot head)
      }
    } catch (e) {
      console.warn("[DO] poet drive failed (non-fatal):", (e as Error).message);
    }
  }

  // ---------- HTTP routing ----------

  async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url);
    const path = url.pathname;
    try {
      if (req.method === "GET" && path === "/state") return await this.getState();
      if (req.method === "GET" && path === "/population") return await this.getPopulation();
      if (req.method === "GET" && path === "/market") return await this.getMarket();
      if (req.method === "GET" && path === "/economy") return await this.getEconomy(url);
      if (req.method === "GET" && path === "/proofs") return await this.getProofs();
      if (req.method === "GET" && path === "/proofs/verify") return await this.getProofVerify(url);
      if (req.method === "GET" && path === "/manifest") return await this.getManifest();
      if (req.method === "GET" && path === "/manifest/replay") return await this.getManifestReplay();
      if (req.method === "GET" && path === "/signal/pulse") return await this.getSignalPulse(req);
      if (req.method === "GET" && path === "/signal/requirements") return await this.getSignalRequirements();
      if (req.method === "GET" && path === "/leaderboard") return await this.getLeaderboard();
      if (req.method === "GET" && path === "/predictions") return await this.getPredictions();
      if (req.method === "GET" && path === "/predictions/verify") return await this.getPredictVerify(url);
      if (req.method === "GET" && path === "/arena") return await this.getArena();
      if (req.method === "GET" && path === "/war") return await this.getWar();
      if (req.method === "GET" && path === "/bourse") return await this.getBourse();
      if (req.method === "GET" && path === "/lineage") return await this.getLineage(url);
      if (req.method === "GET" && path === "/lineage/verify") return await this.getLineageVerify(url);
      if (req.method === "GET" && path.startsWith("/lineage/")) return await this.getLineageOne(path.split("/")[2]);
      if (req.method === "GET" && path === "/history") return await this.getHistory(url);
      if (req.method === "GET" && path === "/annals") return await this.getAnnals(url);
      if (req.method === "GET" && path === "/annals/verify") return await this.getAnnalsVerify(url);
      if (req.method === "GET" && path === "/poem") return await this.getPoem(url);
      if (req.method === "GET" && path === "/poem/verify") return await this.getPoemVerify(url);
      if (req.method === "GET" && path === "/poem/all") return await this.getPoemAll(url);
      if (req.method === "GET" && path === "/poem/archive") return await this.getPoemArchive(url);
      if (req.method === "GET" && path === "/stimuli") return await this.getStimuli();
      if (req.method === "GET" && path === "/snapshot") return await this.getSnapshot(url);
      if (req.method === "GET" && path.startsWith("/flies/")) return await this.getFly(path.split("/")[2]);
      if (req.method === "POST" && path === "/stimulus") return await this.postStimulus(req);
      if (req.method === "POST" && path === "/breed") return this.adminGate(req) ?? (await this.postBreed(req));
      if (req.method === "POST" && path === "/tick") return this.adminGate(req) ?? (await this.postTick());
      if (req.method === "POST" && path === "/reset") return this.adminGate(req) ?? (await this.postReset());
      return jsonError("not_found", "no such endpoint", 404);
    } catch (e) {
      console.error("[DO] fetch error:", e);
      return jsonError("internal_error", (e as Error).message, 500);
    }
  }

  // ---------- Cron main loop ----------

  async cron(): Promise<void> {
    // Reentrancy guard: a cron can outlive its schedule because the population runs many LIF
    // sub-steps per tick. Overlapping invocations would double-drive the same brains and race the
    // persisted state, so skip any cron that fires while the previous one is still running.
    if (this.cronRunning) {
      console.log("[DO] cron skipped: previous tick still running");
      return;
    }
    this.cronRunning = true;
    try {
      await this.cronInner();
    } catch (e) {
      // The chronicle must NEVER freeze because the simulation body threw. Every non-fatal sub-step
      // (arc sample, prediction, arena, war, evolution) already guards itself, so a throw escaping
      // cronInner is one that happened BEFORE step 5's persist() — the swarm sub-tick loop or an
      // economy settle. Without this, persist() is skipped, lastCron + the tick counter stop advancing,
      // and the historian goes silent (the exact freeze we caught in production). Force a clock-only
      // persist so the swarm's tick and lastCron still move and the next cron starts from a live clock.
      // market/snapshot are passed null so a partial tick never clobbers the last good read-out.
      console.error("[DO] cron threw; force-persisting the clock so it never freezes:", e);
      try {
        await this.persist(null, null);
      } catch (e2) {
        console.error("[DO] emergency clock persist also failed (next cron retries):", e2);
      }
    } finally {
      this.cronRunning = false;
    }
  }

  private async cronInner(): Promise<void> {
    const swarm = await this.ensureSwarm();
    const meter = await this.ensureMeter();
    const prevTemp = await this.ensurePrevTemperature();

    // 1) Observe Arc whole-chain activity → market temperature. A flaky RPC must NOT kill the tick:
    //    on failure we hold the previous temperature so the population keeps a steady, calm state.
    let market: MarketState | null = null;
    try {
      const sample = await sampleArcActivity(this.cfg);
      market = meter.update(sample);
    } catch (e) {
      console.warn("[DO] arc sample failed, holding last temperature:", (e as Error).message);
    }

    const temperature = market?.temperature ?? prevTemp;
    const regime: Regime =
      market?.regime ??
      (temperature >= this.cfg.regimeHot
        ? "HOT"
        : temperature <= this.cfg.regimeCold
          ? "COLD"
          : "CALM");

    // 2) Turn the market state into the sensory pulse the population feels. When the sample failed,
    //    synthesise a neutral pulse at the held temperature so the flies still get a coherent input.
    const pulse = market
      ? derivePulse(market, prevTemp)
      : {
          temperature,
          momentum: 0,
          turbulence: Math.abs(temperature - 0.5) * 2,
          density: 0.5,
          richness: 0.5,
        };
    this.prevTemperature = temperature;

    // 2b) ⑲ THE BOURSE — read the MURMUR tape (read-only getLogs, no signing) and fold it into the meter.
    //     The signals feed BOTH legs: the historian's four coin detectors (step 7's ctx.bourse) and, below,
    //     the coin-climate stimulus fold. Gated behind BOURSE_ENABLED (default OFF ⇒ bourseSignals stays
    //     null and nothing anywhere changes). Best-effort: an RPC failure only means this cron has no coin
    //     reading; the tick itself never blocks (lastBlock does not advance, so nothing is skipped).
    this.bourseSignals = null;
    if (this.cfg.bourse.enabled) {
      try {
        this.bourseSignals = await this.driveBourse();
      } catch (e) {
        console.warn("[DO] bourse sample failed (non-fatal):", (e as Error).message);
      }
    }

    // 3) Collect the visitor stimuli queued since the last tick (injected on the first sub-tick only).
    const stimuli = this.pendingStimuli.splice(0, this.pendingStimuli.length);
    // 3b) ① NEURAL FEEDBACK BUS — fold the civilizational climate the historian ALREADY reckoned (eraInfo's
    //     phase / level / shock, a pure persisted read-out of last cron's society) into the SAME stimulus array,
    //     so the connectome FEELS the age it lives in exactly as it feels a visitor's poke — closing the loop
    //     the read-out membranes (⑤⑦⑨⑩⑬⑭) only ever narrated. Gated behind SOCIAL_STIMULUS_ENABLED (default
    //     OFF ⇒ this appends nothing and `stimuli` is byte-for-byte today's pendingStimuli). It reuses the four
    //     existing visitor channels, so it adds NO sensory channel (manifestHash never rotates), touches no
    //     genome and moves no money; it rides the identical injection path (advanceFlies → encodeStimulus).
    //     this.chronicler is loaded lazily by the historian AFTER the sub-ticks, so on a cold/evicted first cron
    //     it is still null here — the bus simply skips that one cron and the ambient resumes next tick.
    //     Best-effort: a throw can never block the live tick.
    if (this.cfg.socialStimulus.enabled) {
      try {
        const era = this.chronicler ? this.chronicler.eraInfo() : null;
        if (era) {
          const civic = socialStimuli(
            { civPhase: era.civPhase, civLevel: era.civLevel, eraShock: era.eraShock },
            { maxIntensity: this.cfg.socialStimulus.maxIntensity },
          );
          if (civic.length) stimuli.push(...civic);
        }
      } catch (e) {
        console.warn("[DO] social stimulus failed (non-fatal):", (e as Error).message);
      }
    }

    // 3c) ⑲ BOURSE STIMULUS LEG — the coin tape's climate, felt through the SAME four visitor channels
    //     (food/threat/light/dark), exactly like the civic bus above: no sensory channel is added, so the
    //     manifestHash never rotates and no genome is touched. Gated behind TOKEN_STIMULUS_ENABLED (default
    //     OFF ⇒ byte-for-byte today's stimuli). A hard master ceiling (cfg.tokenStimulus.maxIntensity,
    //     default 0.35 — deliberately below the civic bus) caps what ANY coin climate can ever inject, so a
    //     hostile airdrop burst can startle the swarm but never own it. Best-effort: never blocks the tick.
    if (this.cfg.tokenStimulus.enabled && this.bourseSignals) {
      try {
        const coin = coinStimuli(this.bourseSignals.climate, {
          maxIntensity: this.cfg.tokenStimulus.maxIntensity,
        });
        if (coin.length) stimuli.push(...coin);
      } catch (e) {
        console.warn("[DO] token stimulus failed (non-fatal):", (e as Error).message);
      }
    }

    // 4) Run the decision sub-ticks. The agent economy now settles on EVERY sub-tick (not just once per
    //    cron), sharing ONE per-cron deal budget — so trades are ~5× more frequent while the total real
    //    settlements per cron stays bounded. Each sub-tick has a unique tickIndex, so every EIP-3009
    //    nonce stays unique (no replay) even though the economy steps several times per cron.
    const subTicks = this.cfg.ticksPerCron;
    const subSteps = Math.max(1, Math.floor(this.cfg.simStepsPerTick / subTicks));
    let snapshot: PopulationSnapshot | null = null;
    const economy = this.cfg.economy.enabled ? await this.ensureEconomy() : null;
    // CULTURE — the Lamarckian overlay between the brain's decode and every consumer (snapshot,
    // economy, prediction). Null while CULTURE_ENABLED=false ⇒ byte-for-byte today's behaviour.
    const culture = await this.ensureCulture();
    // ⑪ RELIGION — the faith overlay: the SAME read-out line culture occupies, but it rewrites only the
    // devoted, and only on a holy day. Null while RELIGION_ENABLED=false ⇒ byte-for-byte today's behaviour.
    const religion = await this.ensureReligion();
    // ㉔ THE RUMOR MILL — the tale membrane: the drive is pure read-out; its one causal leg is the
    // telling-day override below, on religion's read-out line. Null while RM_ENABLED=false ⇒ byte-for-byte inert.
    const rumorMill = await this.ensureRumor();
    // ⑧ THE COMMONS — apply last era's law to THIS cron's credit line before any sub-tick settles, so the
    // assembly's verdict is in force for the whole cron. ensureCommons() null (or a knob without a decree) ⇒
    // applyLaw(null,…) ⇒ base config, byte-for-byte. Convening the NEXT era's assembly is step 8 below.
    if (economy) {
      const commons = await this.ensureCommons();
      if (commons) {
        const eff = commons.effectiveParams();
        economy.applyLaw(eff.creditCapBaseUsdc, eff.iouRatePer10);
      }
    }
    // Per-CRON settlement budget (previously spent in a single step; now spread across the sub-ticks).
    let econBudget = this.cfg.economy.maxDealsPerTick;
    const cronSettlements: Settlement[] = [];
    let deals = 0;

    // PREDICTION MARKET — resolve the round opened last cron against THIS cron's freshly-sampled
    //    temperature, then fold its parimutuel payouts into the economy's netting BEFORE the sub-ticks so
    //    they flush with this cron's trades under the same real-money rails (kill switch, caps, netting,
    //    registry). Strictly best-effort: any failure is logged and never blocks the live tick.
    const prediction = await this.ensurePrediction();
    let resolvedPredict: { round: ResolvedRound; flows: PredictFlow[] } | null = null;
    if (prediction && economy) {
      try {
        const startTick = swarm.getTickIndex();
        resolvedPredict = await prediction.resolveRound(temperature, startTick);
        if (resolvedPredict) {
          const absorbed = await economy.absorbFlows(resolvedPredict.flows, startTick);
          cronSettlements.push(...absorbed);
          deals += absorbed.filter((s) => s.valid).length;
        }
      } catch (e) {
        console.warn("[DO] predict resolve failed (non-fatal):", (e as Error).message);
      }
    }

    for (let st = 0; st < subTicks; st++) {
      // commit on the final sub-tick so a sharded swarm persists its shards' brains once per cron
      // (LocalSwarm ignores the flag — FlyStateDO.persist() writes its single population blob below).
      snapshot = await swarm.step(pulse, regime, st === 0 ? stimuli : [], subSteps, st === subTicks - 1);
      // 4a-culture) Fashion moves at feeding speed: ONE contact round per cron (the st===0 cohort of
      // feeders/huddlers catches creeds, TTLs burn), then the creed override re-applies to EVERY
      // sub-tick's readings BEFORE the snapshot or the economy sees them. Only fap/role on the read-out
      // line are rewritten — bouts, fingerprints and the connectome never notice (same layer as computeBands).
      if (culture && snapshot) {
        if (st === 0) culture.contagion(swarm.getTickIndex(), snapshot.flies, (id) => economy?.houseOf(id) ?? null);
        culture.apply(snapshot.flies);
      }
      // 4a-religion) Faith moves at worship speed: ONE ritual round per cron (the st===0 cohort of huddlers/
      // resters catches sects, devotion kindles in the gathering and cools in silence, the census names the
      // prophets and the four events), then the holy-day rest override re-applies to EVERY sub-tick's readings
      // — inert on a plain cron. Applied AFTER culture so the holy rest is the last word on the read-out line.
      if (religion && snapshot) {
        if (st === 0) religion.ritual(swarm.getTickIndex(), snapshot.flies, (id) => economy?.houseOf(id) ?? null, regime);
        religion.apply(snapshot.flies, swarm.getTickIndex());
      }
      // 4a-rumor) ㉔ THE RUMOR MILL — the telling-day echo: on every RM_TELL_EVERYth tick the flies that
      // have heard the live tale are READ as what hearing looks like (GROOM — the whispering that IS
      // gossip in every market square; or HALT, the listening freeze, when the tale is heard gravely).
      // The religion contract: read-out line only, rare by construction, inert on every other cron.
      if (rumorMill && snapshot) rumorMill.apply(snapshot.flies, swarm.getTickIndex());
      // 4b) Settle x402 micropayments from the drives this sub-tick produced. One-directional read-out
      //     of the neural layer — it never feeds back into the connectome.
      if (economy && snapshot && econBudget > 0) {
        const made = await economy.step(
          snapshot.flies,
          snapshot.collective,
          swarm.getTickIndex(),
          econBudget,
          st === 0,   // cron boundary: the per-cron RAID gate rolls only on the first sub-tick, not all 6
        );
        cronSettlements.push(...made);
        deals += made.filter((s) => s.valid).length;
        econBudget -= made.length;   // every attempt counts against the cron budget (bounds real spend)
      }
    }
    if (economy) {
      // NETTING flush (onchain only; no-op in simulated mode): broadcast the accumulated bilateral nets
      // whose |net| cleared the min-broadcast threshold or aged past the forced-flush bound. Real txs
      // happen HERE — once per cron at most — instead of one per micropay, amortising gas over many trades.
      const flushed = await economy.flush(swarm.getTickIndex());
      cronSettlements.push(...flushed);
      deals += flushed.filter((s) => s.valid).length;
      // Publish the whole cron's activity to the frontend as one batch (not just the last sub-tick's).
      economy.setLastTick(cronSettlements);
      // DYNASTY mortality sweep — ONCE per cron, ledger-side only (the swarm, shards and canvas never
      // notice): up to one penury + one old-age burial, plus a heat-plague cull of the eldest, estates
      // already inherited. Runs BEFORE the snapshot so the published read-out carries this cron's graves;
      // the historian narrates them via dynastySignals() at step 7. Inert while DYNASTY_ENABLED=false.
      const graves = economy.noteMortality(swarm.getTickIndex(), temperature);
      if (graves.length) {
        console.log(`[DO] dynasty buried ${graves.map((g) => `#${g.id}(${g.cause})`).join(" ")}`);
        // LIVE-RETIRE (POP_LIVE_RETIRE, default on): a dead fly leaves the SWARM too, not just the wallet.
        // Retiring frees its id/slot/shard brain so size()/aliveCount hold ONLY the living and the vacated
        // slot can hatch again — the fix for "越养越少、到顶卡死". Best-effort per id; a shard fetch failure is
        // logged and the next cron retries (the roster already dropped it). Off ⇒ the legacy wallet-only death.
        if (this.cfg.liveRetire) {
          for (const g of graves) {
            try {
              if (await swarm.retireFly(g.id, this.state.storage)) {
                console.log(`[DO] live-retire: retired #${g.id} from the swarm (slot freed, live=${swarm.size()})`);
              }
            } catch (e) {
              console.warn(`[DO] live-retire #${g.id} failed (wallet already buried, roster may retry):`, (e as Error).message);
            }
          }
        }
      }
      // LIVE-RETIRE backlog reconciliation: a fly that died BEFORE retirement shipped (or whose retire fetch
      // failed on an earlier cron) is STILL in the swarm roster even though the economy has entombed it.
      // noteMortality only reports NEW graves, so reconcile the live roster against the economy's dead set and
      // evict any dead-but-still-flying id — freeing its slot so aliveCount/size reflect ONLY the living.
      if (this.cfg.liveRetire) {
        for (const id of swarm.liveIds()) {
          if (!economy.isDead(id)) continue;
          try {
            if (await swarm.retireFly(id, this.state.storage)) {
              console.log(`[DO] live-retire reconcile: evicted dead #${id} still squatting a slot (live=${swarm.size()})`);
            }
          } catch (e) {
            console.warn(`[DO] live-retire reconcile #${id} failed (roster may retry next cron):`, (e as Error).message);
          }
        }
      }
      this.lastEconomy = economy.snapshot();
    }

    // PREDICTION MARKET — commit the resolved round's receipt to the on-chain registry (sharing the SAME
    //    linear chain head as the net receipts, so the resolution is trustlessly verifiable), then open the
    //    next round from this cron's fresh neural read-out to be resolved next cron. Only decisive rounds
    //    with participants are committed: a FLAT refund moves no money, so no gas is spent proving it.
    if (prediction && economy && resolvedPredict) {
      const rr = resolvedPredict.round;
      if (this.cfg.predict.commit && rr.outcome !== "FLAT" && rr.bets.length > 0) {
        try {
          const commitTx = await economy.commitRoundReceipt(rr.receiptHash, swarm.getTickIndex(), rr.bets.length);
          prediction.setCommitTx(rr.round, commitTx);
        } catch (e) {
          console.warn("[DO] predict commit failed (non-fatal):", (e as Error).message);
        }
      }
    }
    if (prediction && economy && snapshot) {
      try {
        prediction.openRound(
          snapshot.flies, temperature, pulse.momentum, swarm.getTickIndex(),
          (id) => economy.getAgent(id)?.balance ?? "0",
        );
      } catch (e) {
        console.warn("[DO] predict open failed (non-fatal):", (e as Error).message);
      }
    }

    // HUMAN ARENA — drive the on-chain MURMUR arena as its resolver (open the new round, resolve the one
    //    that just closed). Best-effort and gated behind the real-money rails; never blocks the live tick.
    if (economy) {
      try {
        await this.driveArena(temperature, economy);
      } catch (e) {
        console.warn("[DO] arena drive failed (non-fatal):", (e as Error).message);
      }
    }

    // WAR + TAXATION — drive the on-chain WarCoffer as its resolver (fund vaults, resolve the war whose
    //    bucket closed, declare the deepest due feud, levy the extra tax). Gated behind the SAME real-money
    //    rails as the arena; best-effort — a throw never blocks the tick. warEvents is cleared every cron
    //    here (before the gated drive) so an inert cron leaves it empty and the chronicle context stays today's.
    this.warEvents = [];
    if (economy) {
      try {
        await this.driveWar(economy);
      } catch (e) {
        console.warn("[DO] war drive failed (non-fatal):", (e as Error).message);
      }
    }

    // AUTONOMOUS EVOLUTION — let the fittest agents found the next generation, self-funded from their OWN
    //    wallets. Best-effort and gated behind the same real-money rails; never blocks the live tick.
    if (economy) {
      try {
        await this.driveEvolution(economy, swarm.getTickIndex(), snapshot?.flies ?? null);
      } catch (e) {
        console.warn("[DO] evolution drive failed (non-fatal):", (e as Error).message);
      }
    }

    // 5) Persist.
    await this.persist(market, snapshot);

    // 6) Archive one row to D1 for the long-term history (best-effort; a D1 failure never blocks the tick).
    await this.archiveTick(
      swarm.getTickIndex(),
      temperature,
      regime,
      deals,
      snapshot,
      this.lastEconomy?.totals ?? null,
    );

    // 6b) ⑬ TECH + ⑭ CITIES — drive the two read-out membranes over THIS cron's state so step 7 can fold their
    //     events into the historian's context. Runs after the archive (its inputs are already final) and before
    //     the historian; pure read-out, best-effort.
    await this.driveTechAndCities(swarm.getTickIndex(), snapshot);
    // ⑥ APPRENTICESHIP rides immediately after the ladder so a lesson's ceiling is the rung count THIS cron.
    await this.driveApprentice(swarm.getTickIndex(), snapshot);
    // ⑰ ARCHIVE rides after apprenticeship: it reads ⑯'s keeper map to decide who inscribes.
    await this.driveArchive(swarm.getTickIndex(), snapshot);
    // ⑱ WORKSHOP rides after archive: it reads the tech membrane's lost set and the population's explorers.
    await this.driveWorkshop(swarm.getTickIndex(), snapshot);
    // ⑳ COURT rides after the workshop: it reads the social ledger facts + the historian's era, and its
    // edge events fold into the SAME cron's historian context (driveCourt must precede observeChronicle).
    await this.driveCourt(swarm.getTickIndex(), snapshot);
    // ㉑ GAMES rides after the court: it reads the era bell + the dynasty's dominant house + the ledger's
    // own deal counts, and its edge events fold into the SAME cron's historian context.
    await this.driveGames(swarm.getTickIndex(), snapshot);
    // ㉒ GUILDS rides after the games: it reads the economy's own profession ledger across the living
    // roster, and its edge events fold into the SAME cron's historian context.
    await this.driveGuilds(swarm.getTickIndex(), snapshot);
    // ㉓ LEXICON rides after the guilds: it reads the annals roll the historian has ALREADY written (the
    // dictionary is compiled from tellings already history), before this cron's observeChronicle.
    await this.driveLexicon(swarm.getTickIndex());
    // ㉔ RUMOR MILL rides after the lexicon: it hears the same already-history roll; its telling-day
    // echo (the apply hook in the sub-tick loop) is the only causal leg — the drive itself is pure read-out.
    await this.driveRumor(swarm.getTickIndex());
    // ㉕ THE TREATY rides after the mill: it reads the SAME house-bond series the war resolver feuds
    // over — pure read-out end to end, no causal leg, no override anywhere. No economy (cold) ⇒ no drive.
    if (economy) await this.driveTreaty(economy, swarm.getTickIndex());

    // ㉖ THE PUBLIC WORKS rides after the chancery: it reads eraInfo's civilizational reckoning and the
    // market's bad paper — pure read-out, no causal leg, and no economy required (a cold swarm simply thirsts less).
    await this.driveWorks(swarm.getTickIndex());

    // 7) The deterministic historian reads the SAME snapshot + lifetime totals and, if this cron crossed
    //    a history-making threshold (era shift, panic, huddle, first settlement, milestone, ...) appends
    //    a narrative line to the chronicle. PURE READ-OUT: never touches brains, wallets or settlements.
    await this.observeChronicle(swarm.getTickIndex(), snapshot, temperature, regime, pulse);

    // 8) THE COMMONS — if the historian just raised a NEW era, convene a deterministic assembly over the
    //    swarm's own read-out condition and let it legislate the two credit knobs for the era ahead (applied
    //    at the top of the next cron). PURE READ-OUT + a sub-switch of INSTITUTIONS: never touches a neuron,
    //    moves no money, inert while LAW_ENABLED=false. Best-effort — a failure only skips a council.
    await this.driveCommons();

    // 8b) ⑮ THE LAUREATE — after the historian has named this cron's era, let the swarm's poet read its OWN
    //     live neural read-out + the on-chain reality and (on a new era, or ≈hourly) decode them through the
    //     public grammar into a verifiable four-line poem on the independent /poem chain. PURE READ-OUT: it
    //     moves no money, writes no chronicle kind and never feeds back into the connectome. Inert while
    //     POET_ENABLED=false; best-effort — a throw can never block the live tick.
    await this.drivePoet(swarm.getTickIndex(), snapshot, temperature, regime);

    console.log(
      `[DO] cron tick#${swarm.getTickIndex()} T=${temperature.toFixed(3)} ${regime} ` +
        `size=${snapshot?.collective.size ?? 0} subTicks=${subTicks} deals=${deals}`,
    );
  }

  // ---------- Endpoint implementations ----------

  /**
   * GET /war — the on-chain house WAR + TAXATION coffer: static wiring (coffer/usdc/treasury/resolver/caps),
   * every house's live on-chain vault mirror, the aggregate coffer totals (commons purse / escrow / cap) read
   * straight from the contract, and the open + just-resolved wars (with the winner recomputed independently in
   * war.ts so a reader can confirm the payout was not steered). Inert (enabled:false) until WAR_ENABLED +
   * WAR_ADDRESS are set and the onchain facilitator is armed.
   */
  private async getWar() {
    const w = this.cfg.war;
    const economy = this.cfg.economy.enabled ? await this.ensureEconomy() : null;
    const base = {
      enabled: w.enabled && w.address != null,
      network: arcNetworkTag(this.cfg.isTestnet),
      chainId: this.cfg.chainId,
      usdc: w.usdc,
      cofferAddress: w.address,
      treasury: w.treasury ?? economy?.relayAddress() ?? null,
      resolver: economy?.relayAddress() ?? null,
      warCadenceSec: w.warCadenceSec,
      stakePct: w.stakePct,
      minVaultUsdc: w.minVaultUsdc,
      perWarCapUsdc: w.perWarCapUsdc,
      maxEscrowUsdc: w.maxEscrowUsdc,
      feudThreshold: w.feudThreshold,
      taxPct: w.taxPct,
      taxDest: w.taxDest,
      armed: economy?.facilitatorMode === "onchain",
    };
    if (!base.enabled || !economy) return json({ ...base, houses: [], stats: null, wars: [], state: null });

    const rt = await this.ensureWarState();
    // Houses + their on-chain vault mirrors (only those that actually carry a vault are worth listing).
    const houses = economy.warHouses().map((h) => ({
      id: h.id, name: economy.houseNameById(h.id), vaultOnchainUsdc: h.vaultOnchainUsdc,
      capitalShare: h.capitalShare, live: h.live, gen: h.gen, power: housePower(h),
    }));
    const stats = await economy.cofferStatsOnchain();

    // The live + just-closed war buckets, with an INDEPENDENT winner recompute (the trustless cross-check).
    const now = Math.floor(Date.now() / 1000);
    const cur = Math.floor(now / w.warCadenceSec);
    const wars: Record<string, unknown>[] = [];
    for (const id of [cur, cur - 1]) {
      if (id < 0) continue;
      const info = await economy.warInfoOnchain(id);
      if (!info || !info.opened) continue;
      const { winner, roll, total } = winnerOf(BigInt(id), BigInt(info.attacker), BigInt(info.defender), BigInt(info.powerA), BigInt(info.powerB));
      wars.push({
        warId: id,
        opened: info.opened,
        resolved: info.resolved,
        onChainWinner: info.winner,
        predictedWinner: winner,          // recomputed from committed powers: must equal onChainWinner once resolved
        roll: roll.toString(),
        totalPower: total.toString(),
        attacker: Number(info.attacker),
        defender: Number(info.defender),
        attackerName: economy.houseNameById(Number(info.attacker)),
        defenderName: economy.houseNameById(Number(info.defender)),
        stakeUsdc: atomicToUsdc(info.stake),
        potUsdc: atomicToUsdc(info.pot),
        powerA: Number(info.powerA),
        powerB: Number(info.powerB),
        deadline: info.deadline,
        openedAt: info.openedAt,
        resolvedAt: info.resolvedAt,
        secondsToDeadline: Math.max(0, info.deadline - now),
      });
    }
    return json({
      ...base, houses, stats, wars,
      state: { openedWar: rt.cursor.openedWar, resolvedWar: rt.cursor.resolvedWar, pairsInCooldown: Object.keys(rt.lastByPair).length },
    });
  }

  /**
   * GET /bourse — ⑲ the MURMUR tape read-out: static wiring (token/tax wallet/whale threshold/milestone),
   * the meter's learned baselines, the cumulative tithe FLOW through the argus tax wallet (never a balance
   * — argus auto-sweeps it) and the current climate. Lazy: a GET never touches the chain; it only reports
   * what the last cron's sample left behind. Inert (enabled:false, climate:null) until BOURSE_ENABLED.
   */
  private async getBourse() {
    const b = this.cfg.bourse;
    const base = {
      enabled: b.enabled && b.token != null,
      network: arcNetworkTag(this.cfg.isTestnet),
      chainId: this.cfg.chainId,
      token: b.token,
      taxWallet: b.taxWallet,
      whaleThresholdMurmur: Number(BigInt(b.whaleRaw) / 10n ** 18n),
      titheMilestoneMurmur: Number(BigInt(b.titheMilestoneRaw) / 10n ** 18n),
      lookbackBlocks: b.lookbackBlocks,
      stimulus: this.cfg.tokenStimulus.enabled,
      maxIntensity: this.cfg.tokenStimulus.maxIntensity,
    };
    if (!base.enabled) return json({ ...base, climate: null, signals: null, lastBlock: 0 });
    const meter = await this.ensureBourse();
    const sig = meter?.signals() ?? null;
    return json({
      ...base,
      climate: sig?.climate ?? null,
      signals: sig
        ? {
            txs: sig.txs,
            volumeMurmur: sig.volumeMurmur,
            taxTotalMurmur: sig.taxTotalMurmur,
            whaleTotal: sig.whaleTotal,
            baselineTxs: sig.baselineTxs,
            baselineVolumeMurmur: sig.baselineVolumeMurmur,
            quietCrons: sig.quietCrons,
            sampledAt: sig.sampledAt,
          }
        : null,
      lastBlock: meter?.lastBlock ?? 0,
    });
  }

  /**
   * GET /arena — the human-vs-swarm prediction arena: static wiring (token/arena/resolver/cadence), the
   * live current-round book read straight from the contract (pools + parimutuel odds), the just-closed
   * round, and the swarm's aggregate hit-rate for the "you vs the swarm" comparison. Inert
   * (enabled:false, current:null) until ARENA_ENABLED + ARENA_ADDRESS are set and onchain is armed.
   */
  private async getArena() {
    const a = this.cfg.arena;
    const economy = this.cfg.economy.enabled ? await this.ensureEconomy() : null;
    const base = {
      enabled: a.enabled && a.address != null,
      network: arcNetworkTag(this.cfg.isTestnet),
      chainId: this.cfg.chainId,
      token: a.token,
      arenaAddress: a.address,
      resolver: economy?.relayAddress() ?? null,
      roundLenSec: a.roundLenSec,
      flatBand: a.flatBand,
      staleGraceSec: a.staleGraceSec,
      armed: economy?.facilitatorMode === "onchain",
    };
    if (!base.enabled || !economy) return json({ ...base, current: null, previous: null, swarm: null, state: null });

    const st = await this.ensureArenaState();
    const now = Math.floor(Date.now() / 1000);
    const cur = Math.floor(now / a.roundLenSec);
    const info = await economy.arenaRoundInfo(cur);
    const prevInfo = cur > 0 ? await economy.arenaRoundInfo(cur - 1) : null;
    const current = info ? this.arenaRoundView(cur, info, now) : null;
    const previous = prevInfo ? this.arenaRoundView(cur - 1, prevInfo, now) : null;

    // Swarm side of the comparison: aggregate the flies' lifetime prediction hit-rate.
    const prediction = await this.ensurePrediction();
    let swarm: { bettors: number; rounds: number; hits: number; hitRate: number } | null = null;
    if (prediction) {
      const rows = prediction.leaderboard();
      const rounds = rows.reduce((s, r) => s + r.rounds, 0);
      const hits = rows.reduce((s, r) => s + r.hits, 0);
      swarm = { bettors: rows.length, rounds, hits, hitRate: rounds ? hits / rounds : 0 };
    }
    return json({ ...base, current, previous, swarm, state: { openedRound: st.openedRound, resolvedRound: st.resolvedRound } });
  }

  /** Shape one on-chain arena round into the frontend view: human-readable MURMUR pools + parimutuel odds. */
  private arenaRoundView(roundId: number, info: ArenaRoundInfo, now: number) {
    const up = BigInt(info.poolUp);
    const down = BigInt(info.poolDown);
    const total = up + down;
    const mur = (x: bigint): number => Number(x) / 1e18;   // MURMUR is 18-dec
    return {
      roundId,
      opened: info.opened,
      resolved: info.resolved,
      outcome: info.outcome,           // 0 pending, 1 UP, 2 DOWN, 3 FLAT, 4 REFUND (stale)
      entryTemp: info.entryTemp,
      exitTemp: info.exitTemp,
      flatBand: info.flatBand,
      betDeadline: info.betDeadline,
      openedAt: info.openedAt,
      resolvedAt: info.resolvedAt,
      secondsToDeadline: Math.max(0, info.betDeadline - now),
      poolUp: info.poolUp,
      poolDown: info.poolDown,
      poolUpMur: mur(up),
      poolDownMur: mur(down),
      totalMur: mur(total),
      bettorCount: info.bettorCount,
      oddsUp: up > 0n ? Number(total) / Number(up) : 0,
      oddsDown: down > 0n ? Number(total) / Number(down) : 0,
      probUp: total > 0n ? Number(up) / Number(total) : 0,
      probDown: total > 0n ? Number(down) / Number(total) : 0,
    };
  }

  private async getState() {
    const swarm = await this.ensureSwarm();
    const snap = await this.loadSnapshot();
    const market = (await this.state.storage.get<MarketState>(KEY_MARKET)) ?? null;
    const econTotals = this.cfg.economy.enabled ? (await this.ensureEconomy()).snapshot().totals : null;
    return json({
      name: "murmur",
      tickIndex: swarm.getTickIndex(),
      // LIVE-ONLY counts: with POP_LIVE_RETIRE on, retired dead have left the swarm, so size() is the number
      // of FLYING flies (aliveCount === totalCount === living). With it off, size() is the legacy monotonic
      // roster. `cap` lets the frontend render "N / cap"; `liveRetire` reports which semantics are active.
      aliveCount: swarm.size(),
      totalCount: swarm.size(),
      cap: this.cfg.maxLivePopulation,
      liveRetire: this.cfg.liveRetire,
      vitality: swarm.getVitality(),
      collective: snap?.collective ?? null,
      economy: econTotals
        ? {
            enabled: true,
            mode: this.cfg.economy.facilitatorMode,
            network: arcNetworkTag(this.cfg.isTestnet),
            ...econTotals,
          }
        : { enabled: false },
      market: market
        ? {
            temperature: market.temperature,
            regime: market.regime,
            blockNumber: market.sample.blockNumber,
            txPerBlock: market.sample.txPerBlock,
            gasPerBlock: market.sample.gasPerBlock,
            sampleBlocks: market.sample.sampleBlocks,
            baselineTx: market.baselineTx,
            baselineGas: market.baselineGas,
          }
        : null,
      lastCron: (await this.state.storage.get<number>(KEY_LAST_CRON)) ?? null,
      config: {
        chainId: this.cfg.chainId,
        isTestnet: this.cfg.isTestnet,
        rpcUrl: this.cfg.rpcUrl,
        populationSize: this.cfg.populationSize,
        maxLivePopulation: this.cfg.maxLivePopulation,
        liveRetire: this.cfg.liveRetire,
        ticksPerCron: this.cfg.ticksPerCron,
        simStepsPerTick: this.cfg.simStepsPerTick,
        marketSampleBlocks: this.cfg.marketSampleBlocks,
        regimeHot: this.cfg.regimeHot,
        regimeCold: this.cfg.regimeCold,
        marketGain: this.cfg.marketGain,
        stimulusCooldownSec: this.cfg.stimulusCooldownSec,
        economyEnabled: this.cfg.economy.enabled,
        economyFacilitator: this.cfg.economy.facilitatorMode,
        economyBasePriceUsdc: this.cfg.economy.basePriceUsdc,
        economyInitialBalanceUsdc: this.cfg.economy.initialBalanceUsdc,
      },
    });
  }

  /** The frontend's main feed: the last population snapshot + a compact economy summary (payment
   *  edges from the last tick + wallet balances + totals) so one poll drives the whole scene. */
  private async getPopulation() {
    await this.ensureSwarm();
    const snap = await this.loadSnapshot();
    const economy = this.cfg.economy.enabled ? (await this.ensureEconomy()).summary() : null;
    // ⑤ Carry the culture read-out on the same hot feed that already drives the chronicle panel's dynasty
    // block, so "the commons in custom" tracks every cron whether or not the drawer is open (open⇒latest).
    if (economy) {
      const culture = await this.cultureReadout(snap);
      if (culture) (economy as { culture?: unknown }).culture = culture;
      const religion = await this.religionReadout(snap);
      if (religion) (economy as { religion?: unknown }).religion = religion;
      // ⑬⑭ the ladder + the map ride the same hot feed, so both chronicle volumes track every cron whether or
      // not the drawer is open. Switch-off ⇒ null ⇒ key absent ⇒ byte-for-byte the pre-layer /population.
      const tech = await this.techReadout();
      if (tech) (economy as { tech?: unknown }).tech = tech;
      const cities = await this.citiesReadout();
      if (cities) (economy as { cities?: unknown }).cities = cities;
      const apprentice = await this.apprenticeReadout();
      if (apprentice) (economy as { apprentice?: unknown }).apprentice = apprentice;
      const archive = await this.archiveReadout();
      if (archive) (economy as { archive?: unknown }).archive = archive;
      const workshop = await this.workshopReadout();
      if (workshop) (economy as { workshop?: unknown }).workshop = workshop;
      const court = await this.courtReadout();
      if (court) (economy as { court?: unknown }).court = court;
      const games = await this.gamesReadout();
      if (games) (economy as { games?: unknown }).games = games;
      const guilds = await this.guildsReadout();
      if (guilds) (economy as { guilds?: unknown }).guilds = guilds;
      const lexicon = await this.lexiconReadout();
      if (lexicon) (economy as { lexicon?: unknown }).lexicon = lexicon;
      const rumor = await this.rumorReadout();
      if (rumor) (economy as { rumor?: unknown }).rumor = rumor;
      const treaty = await this.treatyReadout();
      if (treaty) (economy as { treaty?: unknown }).treaty = treaty;
      const works = await this.worksReadout();
      if (works) (economy as { works?: unknown }).works = works;
      const commons = await this.commonsReadout();
      if (commons) (economy as { commons?: unknown }).commons = commons;
    }
    return json({ snapshot: snap, economy, topology: this.topology() });
  }

  /**
   * Read-only description of how the swarm is distributed across Durable Object isolates, so the
   * frontend can draw the compute topology (which flies live in which FlyShardDO). Purely derived
   * from config via the SAME shardSlice()/fliesPerShard() the coordinator and shards use to route —
   * no stored map, and it never touches the economy. When SHARD_COUNT = 1 (or sharding is off) this
   * reports a single shard, exactly matching the single-DO LocalSwarm reality.
   */
  private topology(): {
    sharded: boolean;
    shardCount: number;
    populationSize: number;
    maxLivePopulation: number;
    fliesPerShard: number;
    shards: { index: number; start: number; end: number }[];
  } {
    const genesis = this.cfg.populationSize;
    const cap = this.cfg.maxLivePopulation;
    const shardCount = this.sharding ? this.cfg.shardCount : 1;
    const shards: { index: number; start: number; end: number }[] = [];
    for (let k = 0; k < shardCount; k++) {
      // Slice by the STABLE cap (maxLivePopulation), exactly as shard.ts/swarm.ts route, so the displayed
      // isolate ranges match reality once the live population grows past genesis (cap > populationSize).
      const { start, end } = shardSlice(cap, shardCount, k);
      if (end > start) shards.push({ index: k, start, end });
    }
    return { sharded: this.sharding, shardCount, populationSize: genesis, maxLivePopulation: cap, fliesPerShard: fliesPerShard(cap, shardCount), shards };
  }

  /** Full agent-economy snapshot: every wallet, the recent settlement ledger and aggregate totals. */
  private async getEconomy(url: URL) {
    const economy = await this.ensureEconomy();
    const snap = economy.snapshot();
    // LIGHT MODE: `?fields=light` returns only totals + top-10 agents by balance — a compact poll
    // payload (~3KB vs ~58KB) for the frontend canvas heartbeat. Full response when param absent.
    if (url.searchParams.get("fields") === "light") {
      const agents = snap.agents.slice().sort((a, b) =>
        BigInt(b.balance) > BigInt(a.balance) ? 1 : BigInt(b.balance) < BigInt(a.balance) ? -1 : 0,
      ).slice(0, 10).map((a) => ({ id: a.id, balance: a.balance, balanceUsdc: a.balanceUsdc, deals: a.deals, sales: a.sales }));
      const light: Record<string, unknown> = { mode: snap.mode, network: snap.network, totals: snap.totals, agents };
      const raw = snap as unknown as Record<string, unknown>;
      if ("market" in raw) light.market = raw.market;
      return json(light);
    }
    // ⑤ CULTURE folded into the same read-out the wallets drawer already draws — a pure read of the
    // membrane. Switch-off ⇒ cultureReadout() null ⇒ key absent ⇒ byte-for-byte the pre-culture /economy.
    const culture = await this.cultureReadout();
    // ⑪ RELIGION folded into the same read-out the wallets drawer already draws — a pure read of the faith
    // membrane. Switch-off ⇒ religionReadout() null ⇒ key absent ⇒ byte-for-byte the pre-faith /economy.
    const religion = await this.religionReadout();
    // ⑧ THE COMMONS — the seated assembly + its live law, a pure read of commons.ts. LAW off ⇒ null ⇒ no
    // key ⇒ byte-for-byte the pre-law /economy.
    const commons = await this.commonsReadout();
    // ⑬⑭ TECH + CITIES folded into the same read-out the wallets drawer already draws — pure reads of the two
    // membranes. Switch-off ⇒ null ⇒ key absent ⇒ byte-for-byte the pre-layer /economy.
    const tech = await this.techReadout();
    const cities = await this.citiesReadout();
    // ⑯ APPRENTICESHIP folded the same way — pure read of the membrane. Switch-off ⇒ null ⇒ key absent.
    const apprentice = await this.apprenticeReadout();
    // ⑰ ARCHIVE folded identically.
    const archive = await this.archiveReadout();
    const workshop = await this.workshopReadout();
    const court = await this.courtReadout();
    const games = await this.gamesReadout();
    const guilds = await this.guildsReadout();
    const lexicon = await this.lexiconReadout();
    const rumor = await this.rumorReadout();
    const treaty = await this.treatyReadout();
    const works = await this.worksReadout();
    if (!culture && !religion && !commons && !tech && !cities && !apprentice && !archive && !workshop && !court && !games && !guilds && !lexicon && !rumor && !treaty && !works) return json(snap);
    return json({
      ...snap,
      ...(culture ? { culture } : null), ...(religion ? { religion } : null), ...(commons ? { commons } : null),
      ...(tech ? { tech } : null), ...(cities ? { cities } : null), ...(apprentice ? { apprentice } : null),
      ...(archive ? { archive } : null),
      ...(workshop ? { workshop } : null),
      ...(court ? { court } : null),
      ...(games ? { games } : null),
      ...(guilds ? { guilds } : null),
      ...(lexicon ? { lexicon } : null),
      ...(rumor ? { rumor } : null),
      ...(treaty ? { treaty } : null),
      ...(works ? { works } : null),
    });
  }

  /**
   * ⑧ The commons read-out (who holds the seats, what law the current era passed, and the effective
   * credit line / rate the economy is now running under). Null while LAW_ENABLED/institutions/economy are
   * off (ensureCommons returns null) — callers then ship NO commons key, staying byte-identical to the
   * pre-law build.
   */
  private async commonsReadout(): Promise<CommonsReadout | null> {
    const com = await this.ensureCommons();
    if (!com) return null;
    return com.readout();
  }

  /**
   * ⑤ The live culture read-out (the dominant fashion + any house holding its old way), computed from the
   * last population snapshot. Returns null while the CULTURE switch is off or no snapshot exists yet —
   * callers then ship NO culture key, so every consumer stays byte-identical to the pre-culture build.
   */
  private async cultureReadout(snapshot?: PopulationSnapshot | null): Promise<{
    trend: { fap: string; adherents: number; share: number } | null;
    tradition: { houseId: number; name: string; sigil: string; fap: string; streak: number } | null;
  } | null> {
    const cul = await this.ensureCulture();
    if (!cul) return null;
    const snap = snapshot !== undefined ? snapshot : await this.loadSnapshot();
    if (!snap) return null;
    const sig = cul.signals(snap.flies);
    return {
      trend: sig.trend ? { fap: String(sig.trend.fap), adherents: sig.trend.adherents, share: sig.trend.share } : null,
      tradition: sig.tradition
        ? { houseId: sig.tradition.houseId, name: sig.tradition.name, sigil: sig.tradition.sigil, fap: String(sig.tradition.fap), streak: sig.tradition.streak }
        : null,
    };
  }

  /**
   * ⑪ The live religion read-out (the reigning god, the holy-day countdown, the sect table with prophets, and
   * this cron's four faith events), computed from the last population snapshot + the last market regime. Returns
   * null while the RELIGION switch is off or no snapshot exists yet — callers then ship NO religion key, so every
   * consumer stays byte-identical to the pre-faith build.
   */
  private async religionReadout(snapshot?: PopulationSnapshot | null): Promise<FaithSignals | null> {
    const rel = await this.ensureReligion();
    if (!rel) return null;
    const snap = snapshot !== undefined ? snapshot : await this.loadSnapshot();
    if (!snap) return null;
    const market = (await this.state.storage.get<MarketState>(KEY_MARKET)) ?? null;
    return rel.signals(snap.flies, market?.regime ?? "CALM");
  }

  /**
   * ⑬ The live tech read-out — the rungs in force (with who is credited and how far each has diffused), the arts
   * a dark age has taken, the next rung's horizon, and this cron's three events. Null while TECH_ENABLED is off,
   * so callers ship NO tech key and every consumer stays byte-identical to the pre-ladder build.
   */
  private async techReadout(): Promise<TechSignals | null> {
    const tech = await this.ensureTech();
    if (!tech) return null;
    return tech.signals();
  }

  /**
   * ⑭ The live city read-out — the settlement map (place, rank, headcount, banner), the urban share, the road
   * between the two greatest places, the demography read off the grave ring, and this cron's four events. Null
   * while CITIES_ENABLED is off, so callers ship NO cities key and every consumer stays byte-identical to the
   * pre-map build.
   */
  private async citiesReadout(): Promise<CitySignals | null> {
    const cities = await this.ensureCities();
    if (!cities) return null;
    return cities.signals();
  }

  /**
   * ⑯ The live apprenticeship read-out — the roster of minds that carry an art, the swarm's remembered peak, the
   * standing schools, the cumulative lesson tally, and this cron's four education events. Null while
   * APPRENTICE_ENABLED is off, so callers ship NO apprentice key and every consumer stays byte-identical to the
   * pre-education build.
   */
  private async apprenticeReadout(): Promise<ApprenticeSignals | null> {
    const appr = await this.ensureApprentice();
    if (!appr) return null;
    return appr.signals();
  }

  /**
   * ⑰ The Archive read-out (records, cumulative tallies, this cron's edge events). Null while ARCHIVE_ENABLED
   * is off — callers then ship NO archive key, staying byte-identical to the pre-archive build.
   */
  private async archiveReadout(): Promise<ArchiveSignals | null> {
    const arch = await this.ensureArchive();
    if (!arch) return null;
    return arch.signals();
  }

  private async workshopReadout(): Promise<WorkshopSignals | null> {
    const wrk = await this.ensureWorkshop();
    if (!wrk) return null;
    return wrk.signals();
  }

  /** ⑳ The court's read-out for the public endpoints (null ⇒ key absent ⇒ byte-identical pre-court build). */
  private async courtReadout(): Promise<CourtSignals | null> {
    const crt = await this.ensureCourt();
    if (!crt) return null;
    return crt.signals();
  }

  /** ㉑ The games read-out for the public endpoints (null ⇒ key absent ⇒ byte-identical pre-Games build). */
  private async gamesReadout(): Promise<GamesSignals | null> {
    const gms = await this.ensureGames();
    if (!gms) return null;
    return gms.signals();
  }

  /** ㉒ The guilds read-out for the public endpoints (null ⇒ key absent ⇒ byte-identical pre-Guilds build). */
  private async guildsReadout(): Promise<GuildsSignals | null> {
    const gld = await this.ensureGuilds();
    if (!gld) return null;
    return gld.signals();
  }

  /** ㉓ The lexicon read-out for the public endpoints (null ⇒ key absent ⇒ byte-identical pre-Lexicon build). */
  private async lexiconReadout(): Promise<LexiconSignals | null> {
    const lx = await this.ensureLexicon();
    if (!lx) return null;
    return lx.signals();
  }

  /** ㉔ The rumor mill read-out for the public endpoints (null ⇒ key absent ⇒ byte-identical pre-Rumor build). */
  private async rumorReadout(): Promise<RumorSignals | null> {
    const rm = await this.ensureRumor();
    if (!rm) return null;
    return rm.signals();
  }

  /** ㉕ The treaty chancery read-out for the public endpoints (null ⇒ key absent ⇒ byte-identical pre-Treaty build). */
  private async treatyReadout(): Promise<TreatySignals | null> {
    const tr = await this.ensureTreaty();
    if (!tr) return null;
    return tr.signals();
  }

  /** ㉖ The public works read-out for the public endpoints (null ⇒ key absent ⇒ byte-identical pre-Works build). */
  private async worksReadout(): Promise<WorksSignals | null> {
    const wk = await this.ensureWorks();
    if (!wk) return null;
    return wk.signals();
  }

  /**
   * Neural provenance log: every real on-chain net transfer carries, as its EIP-3009 nonce, the sha256 of
   * a receipt bundling the frozen neural drives of every trade folded into it. Publishing the receipts
   * here lets anyone recompute the hash and match it to the nonce mined on Arc — proof the connectome,
   * not a human or an LLM, decided each transfer.
   */
  private async getProofs() {
    if (!this.cfg.economy.enabled) return json({ enabled: false, proofs: [], chainHead: "", count: 0 });
    const economy = await this.ensureEconomy();
    // ipfsGateway lets the frontend fetch a pinned receipt body from a public gateway (trustless retrieval,
    // no murmur server in the loop). Published even when pinning is off so the UI can show "not pinned".
    return json({ enabled: true, ipfsGateway: this.cfg.economy.ipfs.gateway, ...economy.proofsSnapshot() });
  }

  /**
   * One-click on-chain verification of a single proof: recompute sha256(receipt) server-side, read the
   * EIP-3009 nonce actually mined for the tx, and report whether they match. `match:true` means the
   * chain itself commits to this exact neural receipt.
   */
  private async getProofVerify(url: URL) {
    if (!this.cfg.economy.enabled) return json({ enabled: false }, 400);
    const tx = (url.searchParams.get("tx") ?? "").trim();
    if (!tx) return jsonError("bad_request", "tx required", 400);
    const economy = await this.ensureEconomy();
    const proof = economy.proofForTx(tx);
    if (!proof) return json({ found: false, txHash: tx });
    const recomputed = await netReceiptHash(proof.receipt);
    const onchainNonce = await economy.onchainNonceOf(tx);
    // Trustless chain-ordering: read our OWN NeuralReceiptRegistry for this receipt's committed link
    // and the registry's current head. Null when no registry is configured (or the commit hasn't
    // landed) — the EIP-3009 nonce match above remains the authoritative on-chain commitment.
    const registryCommit = await economy.registryCommitOf(proof.receiptHash);
    const registryHead = await economy.registryChainHead();
    const committedHead = registryCommit != null;
    const registryTxMatch =
      registryCommit != null &&
      registryCommit.txHash.toLowerCase() === proof.txHash.toLowerCase();
    return json({
      found: true,
      enabled: true,
      txHash: proof.txHash,
      receiptHash: proof.receiptHash,
      recomputedHash: recomputed,
      onchainNonce,
      selfConsistent: recomputed === proof.receiptHash,
      match: onchainNonce != null && onchainNonce === proof.receiptHash,
      commitTx: proof.commitTx ?? null,
      registryAddress: this.cfg.economy.registryAddress ?? null,
      registry: registryCommit == null && registryHead == null ? null : {
        committed: committedHead,
        prevHead: registryCommit?.prevHead ?? null,
        tickIndex: registryCommit?.tickIndex ?? null,
        constituents: registryCommit?.constituents ?? null,
        txHash: registryCommit?.txHash ?? null,
        ts: registryCommit?.ts ?? null,
        chainHead: registryHead,
        isHead: registryHead != null && registryHead.toLowerCase() === `0x${proof.receiptHash}`.toLowerCase(),
        txMatch: registryTxMatch,
      },
      receipt: proof.receipt,
    });
  }

  // ---------- brain manifest: the trustless "prove the brain" commitment ----------

  /**
   * The swarm's brain manifest + its sha256 identity. Deterministic from the runtime config (no clock, no
   * randomness), so it is assembled once and cached for this DO's lifetime. The registry address (when
   * configured) lets a verifier read the committed hash straight off Arc and compare — the browser does
   * that on-chain read directly (eth_call), so the anchor is trustless, not our word. Pure read-out.
   */
  private async getManifest(): Promise<Response> {
    const { manifest, hash } = await this.ensureManifest();
    return json({
      manifestHash: hash,
      registryAddress: this.cfg.manifestRegistryAddress,
      chainId: this.cfg.chainId,
      chainTag: manifest.chainTag,
      manifest,
    });
  }

  /**
   * The OFFLINE REPLAY, run server-side for browsers that can't rebuild a connectome: re-derive every fly's
   * structural spec from the committed (seed, opts) and report PASS/FAIL. A trustless verifier can instead
   * run the identical check offline via `npm run replay` (scripts/replay-brain.ts) — this is the SAME pure
   * function, exposed for convenience. No chain call, no mutation.
   */
  private async getManifestReplay(): Promise<Response> {
    const { manifest, hash } = await this.ensureManifest();
    const replay = replayVerifyManifest(manifest);
    return json({ manifestHash: hash, ...replay });
  }

  /**
   * Assemble (once) + hash the brain manifest; cached because it is a pure function of the config.
   * Cost is bounded: connectomeSpecForSeed builds ONE fly's connectome, digests it and drops it, so peak
   * memory is a single 10,800-neuron brain (tens of MB), not all 24 — safe inside this coordinator DO
   * (which holds no brains at SHARD_COUNT>1). Measured ~0.65s to assemble the full 10x roster locally;
   * a few seconds of CPU on Cloudflare, paid once per DO lifetime and then served from the cache.
   */
  private async ensureManifest(): Promise<{ manifest: BrainManifest; hash: string }> {
    if (!this.manifestCache) {
      const manifest = assembleManifest(this.cfg);
      const hash = await manifestHash(manifest);
      this.manifestCache = { manifest, hash };
    }
    return this.manifestCache;
  }

  // ---------- connectome breeding market: the lineage store + its endpoints ----------

  /**
   * Load the breeding-market lineage from DO storage; on first ever read, seed it with the base population's
   * genomes as generation-0 roots (one per manifest seed) and persist. The store is append-only: breeding
   * adds offspring, nothing is ever removed, so the family tree is stable across evictions.
   */
  private async ensureLineage(): Promise<LineageEntry[]> {
    if (this.lineage) return this.lineage;
    const stored = await this.state.storage.get<LineageEntry[]>(KEY_LINEAGE);
    if (stored && stored.length) {
      this.lineage = stored;
    } else {
      this.lineage = await genesisLineage(this.cfg);
      await this.state.storage.put(KEY_LINEAGE, this.lineage);
    }
    return this.lineage;
  }

  /**
   * GET /lineage — the breeding-market family tree: every committed connectome genome + its ancestry
   * (parents, operator, generation, breeder). Read-only and keyless. Optional filters: ?gen=N (one
   * generation), ?op=genesis|mutate|cross, ?breeder=0x… (one breeder's offspring), ?limit=N (newest first,
   * default 500). Reports the on-chain ConnectomeLineage anchor when configured.
   */
  private async getLineage(url: URL): Promise<Response> {
    const entries = await this.ensureLineage();
    const genParam = url.searchParams.get("gen");
    const op = url.searchParams.get("op");
    const breeder = (url.searchParams.get("breeder") ?? "").trim().toLowerCase();
    const limit = Math.max(1, Math.min(5000, Number(url.searchParams.get("limit") ?? "500") || 500));

    let out = entries.slice();
    if (genParam != null && genParam !== "") {
      const g = Number(genParam);
      if (Number.isFinite(g)) out = out.filter((e) => e.generation === g);
    }
    if (op) out = out.filter((e) => e.op === op);
    if (breeder) out = out.filter((e) => (e.breeder ?? "").toLowerCase() === breeder);

    // Newest first (genesis roots have ts 0 so they sort last), then trim to the limit.
    out.sort((a, b) => b.ts - a.ts || b.generation - a.generation);
    const total = out.length;
    out = out.slice(0, limit);

    const generations = entries.reduce((m, e) => Math.max(m, e.generation), 0);
    const bred = entries.filter((e) => e.op !== "genesis").length;
    // Autonomous-evolution status: whether the swarm is self-breeding, what each offspring costs the parent,
    // the treasury that collects it, and how much of today's budget is used. breedsToday reflects the
    // persisted per-day guard (0 on a fresh UTC day), so /lineage surfaces the live selection pressure.
    const ev = this.cfg.evolution;
    const guard = await this.ensureEvolutionGuard();
    const todayKey = new Date().toISOString().slice(0, 10);
    return json({
      lineageAddress: this.cfg.lineageAddress,
      chainId: this.cfg.chainId,
      count: entries.length,
      genesis: entries.length - bred,
      bred,
      generations,
      matching: total,
      returned: out.length,
      evolution: {
        enabled: ev.enabled && !!ev.treasury && this.cfg.economy.enabled,
        feeUsdc: ev.feeUsdc,
        treasury: ev.treasury,
        breedsToday: guard.dayKey === todayKey ? guard.global : 0,
        globalDailyMax: ev.globalDaily,
        perAgentDailyMax: ev.perAgentDaily,
      },
      entries: out,
    });
  }

  /**
   * GET /lineage/:hash — one individual: its genome body (so anyone can rebuild it offline), its ancestry,
   * the structural spec re-derived from that genome (the per-individual trustless replay), and — when the
   * on-chain ConnectomeLineage is wired — its committed ancestry read straight off Arc.
   */
  private async getLineageOne(hash: string): Promise<Response> {
    const h = (hash ?? "").trim().toLowerCase().replace(/^0x/, "");
    if (!/^[0-9a-f]{64}$/.test(h)) return jsonError("bad_request", "hash must be 64 hex chars", 400);
    const entries = await this.ensureLineage();
    const entry = entries.find((e) => e.genomeHash === h);
    if (!entry) return jsonError("not_found", "no such genome in the lineage", 404);

    const children = entries.filter((e) => e.parents.includes(h)).map((e) => e.genomeHash);
    const onchain =
      this.cfg.lineageAddress && this.cfg.economy.enabled
        ? await (await this.ensureEconomy()).lineageOf(h)
        : null;
    return json({
      lineageAddress: this.cfg.lineageAddress,
      chainId: this.cfg.chainId,
      entry,
      children,
      fertility: children.length,
      spec: replayEntry(entry),
      onchain,
    });
  }

  /**
   * GET /lineage/verify?hash=0x… — the trustless check, run server-side for convenience: recompute
   * sha256(canonical(genome)) from the SERVED genome body (must equal the id), rebuild the connectome and
   * re-derive its spec (proving the published brain is exactly what that genome deterministically generates),
   * and — when wired — confirm the ancestry is committed on Arc. A stranger can run the identical check
   * offline from /lineage/:hash alone; no murmur server is in the trust path.
   */
  private async getLineageVerify(url: URL): Promise<Response> {
    const h = (url.searchParams.get("hash") ?? "").trim().toLowerCase().replace(/^0x/, "");
    if (!/^[0-9a-f]{64}$/.test(h)) return jsonError("bad_request", "hash must be 64 hex chars", 400);
    const entries = await this.ensureLineage();
    const entry = entries.find((e) => e.genomeHash === h);
    if (!entry) return jsonError("not_found", "no such genome in the lineage", 404);

    const hashOk = await verifyEntryHash(entry);
    let spec = null as ReturnType<typeof replayEntry> | null;
    let specOk = false;
    try {
      spec = replayEntry(entry);
      specOk = spec != null && Number.isFinite(spec.neuronCount) && spec.neuronCount > 0;
    } catch {
      specOk = false;
    }
    const onchain =
      this.cfg.lineageAddress && this.cfg.economy.enabled
        ? await (await this.ensureEconomy()).lineageOf(h)
        : null;
    // On-chain agreement: when committed, the recorded op/generation must match the served entry.
    const opCode = entry.op === "genesis" ? 0 : entry.op === "mutate" ? 1 : 2;
    const chainOk = onchain == null ? null : onchain.op === opCode && onchain.generation === entry.generation;
    const pass = hashOk && specOk && chainOk !== false;
    return json({
      genomeHash: h,
      pass,
      checks: { hashOk, specOk, chainOk, committed: onchain != null },
      generation: entry.generation,
      op: entry.op,
      spec,
      onchain,
    });
  }

  /**
   * POST /breed — apply a pure genetic operator to committed parents and record the offspring in the lineage.
   * Admin-gated (like /tick + /reset): breeding mutates the store, so it is not open to anonymous callers yet
   * (a future x402 paywall can front it). Body: { op: "mutate"|"cross", parents: [hash(,hash)], rngSeed?,
   * breeder? }. Because the operators are pure in (parents, rngSeed), the offspring is reproducible by anyone
   * from the recorded fields. When a breeder address is supplied and the on-chain ConnectomeLineage is wired,
   * the offspring is committed to Arc best-effort (a commit failure never fails the breed).
   */
  private async postBreed(req: Request): Promise<Response> {
    let body: BreedRequest;
    try {
      body = (await req.json()) as BreedRequest;
    } catch {
      return jsonError("bad_request", "body must be JSON", 400);
    }
    if (!body || (body.op !== "mutate" && body.op !== "cross")) {
      return jsonError("bad_request", 'op must be "mutate" or "cross"', 400);
    }
    if (!Array.isArray(body.parents)) return jsonError("bad_request", "parents must be an array", 400);
    const parents = body.parents.map((p) => String(p).trim().toLowerCase().replace(/^0x/, ""));
    for (const p of parents) {
      if (!/^[0-9a-f]{64}$/.test(p)) return jsonError("bad_request", "each parent must be a 64-hex genomeHash", 400);
    }

    const entries = await this.ensureLineage();
    let child: LineageEntry;
    try {
      child = await applyBreed(entries, { ...body, parents });
    } catch (e) {
      return jsonError("bad_request", (e as Error).message, 400);
    }

    // Persist the append-only store, then best-effort anchor the offspring on Arc when a breeder is credited
    // (the contract rejects address(0), so a breederless offspring simply isn't committed — it stays verifiable
    // off-chain by hash + replay, exactly like the genesis roots).
    entries.push(child);
    this.lineage = entries;
    await this.state.storage.put(KEY_LINEAGE, entries);

    const breeder = (child.breeder ?? "").trim();
    if (breeder && this.cfg.lineageAddress && this.cfg.economy.enabled) {
      const opCode = child.op === "genesis" ? 0 : child.op === "mutate" ? 1 : 2;
      const tx = await (await this.ensureEconomy()).commitLineage({
        genomeHash: child.genomeHash,
        parentA: child.parents[0] ?? "",
        parentB: child.parents[1] ?? "",
        op: opCode as 0 | 1 | 2,
        generation: child.generation,
        breeder,
      });
      if (tx) {
        child.commitTx = tx;
        await this.state.storage.put(KEY_LINEAGE, entries);
      }
    }

    return json({ ok: true, lineageAddress: this.cfg.lineageAddress, entry: child, spec: replayEntry(child) });
  }

  // ---------- paid data product: the x402 "Arc Pulse" signal (HTTP 402) ----------

  /**
   * Assemble the machine-readable signal sold over x402: the Arc-activity-derived market temperature +
   * its facets (momentum/turbulence/density/richness), the raw activity vs baseline, the swarm's live
   * positioning, and a plain-language read. This is the PREMIUM product — the free /market endpoint only
   * exposes the headline temperature; the full bundle + a trader-readable interpretation is what a payer buys.
   */
  private async buildPulseSignal() {
    const market = (await this.state.storage.get<MarketState>(KEY_MARKET)) ?? null;
    const prevTemp = await this.ensurePrevTemperature();
    const snap = await this.loadSnapshot();
    const swarm = await this.ensureSwarm();
    const collective = snap?.collective ?? null;
    const temperature = market?.temperature ?? prevTemp;
    const regime: Regime =
      market?.regime ??
      (temperature >= this.cfg.regimeHot ? "HOT" : temperature <= this.cfg.regimeCold ? "COLD" : "CALM");
    const pulse = market
      ? derivePulse(market, prevTemp)
      : { temperature, momentum: 0, turbulence: Math.abs(temperature - 0.5) * 2, density: 0.5, richness: 0.5 };
    const states = collective?.states ?? null;
    let topState: string | null = null;
    if (states) { let best = -1; for (const [k, v] of Object.entries(states)) if (v > best) { best = v; topState = k; } }
    return {
      v: 1,
      product: "arc-pulse",
      ts: Date.now(),
      chain: {
        chainId: this.cfg.chainId,
        network: arcNetworkTag(this.cfg.isTestnet),
        isTestnet: this.cfg.isTestnet,
        blockNumber: market?.sample.blockNumber ?? null,
      },
      temperature,
      regime,
      facets: pulse,
      activity: market
        ? {
            txPerBlock: market.sample.txPerBlock,
            gasPerBlock: market.sample.gasPerBlock,
            baselineTx: market.baselineTx,
            baselineGas: market.baselineGas,
            sampleBlocks: market.sample.sampleBlocks,
            txRatio: market.baselineTx > 1e-6 ? market.sample.txPerBlock / market.baselineTx : 1,
            gasRatio: market.baselineGas > 1e-6 ? market.sample.gasPerBlock / market.baselineGas : 1,
          }
        : null,
      swarm: collective
        ? { size: collective.size, states, topState, temperature: collective.temperature }
        : null,
      tickIndex: swarm.getTickIndex(),
      read: pulseRead(regime, pulse.momentum, temperature),
    };
  }

  /** Build the PaymentRequirements for one Arc Pulse read (null payTo ⇒ product unavailable). */
  private async signalRequirements(economy: AgentEconomy): Promise<{ reqs: PaymentRequirements | null; payTo: string | null }> {
    const payTo = this.cfg.signal.payTo ?? economy.relayAddress();
    if (!payTo) return { reqs: null, payTo: null };
    const reqs: PaymentRequirements = {
      scheme: SCHEME_EXACT,
      network: arcNetworkTag(this.cfg.isTestnet),
      maxAmountRequired: usdcToAtomic(this.cfg.signal.priceUsdc),
      resource: "https://api.muros.live/signal/pulse",
      description:
        "murmur Arc Pulse — the machine-readable market-temperature signal derived from Arc whole-chain activity, plus the swarm's live neural positioning. One read.",
      mimeType: "application/json",
      payTo,
      maxTimeoutSeconds: 300,
      asset: ARC_USDC,
      extra: { product: "arc-pulse", priceUsdc: this.cfg.signal.priceUsdc },
    };
    return { reqs, payTo };
  }

  /** Public payment requirements so a browser can build + sign the EIP-3009 authorization (no 402 round-trip needed). */
  private async getSignalRequirements(): Promise<Response> {
    if (!this.cfg.signal.enabled) return json({ enabled: false });
    const economy = await this.ensureEconomy();
    const { reqs, payTo } = await this.signalRequirements(economy);
    if (!reqs) return json({ enabled: false, reason: "no payee configured (set SIGNAL_PAYTO or run onchain)" });
    return json({
      enabled: true,
      mode: economy.facilitatorMode,
      network: reqs.network,
      chainId: this.cfg.chainId,
      asset: reqs.asset,
      payTo,
      priceUsdc: this.cfg.signal.priceUsdc,
      priceAtomic: reqs.maxAmountRequired,
      maxUsdc: this.cfg.signal.maxUsdc,
      maxTimeoutSeconds: reqs.maxTimeoutSeconds,
      eip712: { name: this.cfg.economy.usdcEip712Name, version: this.cfg.economy.usdcEip712Version },
      requirements: reqs,
    });
  }

  /**
   * The x402 resource itself. No payment ⇒ 402 Payment Required (requirements in body + PAYMENT-REQUIRED
   * header). A base64 PaymentPayload in X-PAYMENT ⇒ verify + relay the buyer's EIP-3009 authorization
   * (economy.settleExternal); on success serve the signal + X-PAYMENT-RESPONSE, else re-issue the 402.
   */
  private async getSignalPulse(req: Request): Promise<Response> {
    if (!this.cfg.signal.enabled) return jsonError("not_found", "signal product disabled", 404);
    const economy = await this.ensureEconomy();
    const { reqs } = await this.signalRequirements(economy);
    if (!reqs) return jsonError("service_unavailable", "signal product not configured", 503);

    const payHeader = req.headers.get("X-PAYMENT") ?? req.headers.get("x-payment");
    if (!payHeader) return paymentRequired(reqs, "X-PAYMENT header required");

    let payload: PaymentPayload;
    try {
      payload = JSON.parse(atob(payHeader)) as PaymentPayload;
    } catch {
      return paymentRequired(reqs, "malformed X-PAYMENT (expected base64 JSON PaymentPayload)");
    }

    // Cap what a caller can push through the relay (defense-in-depth beyond the facilitator's own cap).
    const authVal = payload?.payload?.authorization?.value;
    if (authVal != null && /^\d+$/.test(String(authVal)) && BigInt(authVal) > BigInt(usdcToAtomic(this.cfg.signal.maxUsdc))) {
      return paymentRequired(reqs, `value exceeds max ${this.cfg.signal.maxUsdc} USDC`);
    }

    const settlement = await economy.settleExternal(reqs, payload);
    if (!settlement.success) return paymentRequired(reqs, settlement.invalidReason ?? "settlement failed");

    const signal = await this.buildPulseSignal();
    await this.recordPulseSale(settlement, payload);
    return new Response(
      JSON.stringify({
        paid: true,
        product: "arc-pulse",
        signal,
        settlement: {
          txHash: settlement.txHash,
          simulated: !!settlement.simulated,
          shadow: !!settlement.shadow,
          network: settlement.network,
        },
      }),
      {
        status: 200,
        headers: {
          "Content-Type": "application/json; charset=utf-8",
          "X-PAYMENT-RESPONSE": b64json(settlement),
          "Cache-Control": "no-store",
        },
      },
    );
  }

  /** Best-effort revenue telemetry for the paid signal (persisted; never blocks serving the product). */
  private async recordPulseSale(s: SettleResponse, payload: PaymentPayload): Promise<void> {
    try {
      const cur = (await this.state.storage.get<PulseSales>(KEY_PULSE)) ??
        { sales: 0, grossAtomic: "0", lastTx: null, lastBuyer: null, lastTs: null };
      const amt = payload?.payload?.authorization?.value ?? "0";
      cur.sales += 1;
      cur.grossAtomic = (BigInt(cur.grossAtomic) + (/^\d+$/.test(String(amt)) ? BigInt(amt) : 0n)).toString();
      cur.lastTx = s.txHash && s.txHash !== "0x" ? s.txHash : cur.lastTx;
      cur.lastBuyer = payload?.payload?.authorization?.from ?? cur.lastBuyer;
      cur.lastTs = Date.now();
      await this.state.storage.put(KEY_PULSE, cur);
    } catch {
      /* telemetry only */
    }
  }

  // ---------- trustless PnL leaderboard (built on the on-chain receipt registry) ----------

  /**
   * Every agent ranked by realized USDC flow, plus the paid-signal revenue counter. Each row's address is
   * its real on-chain wallet, and the registryAddress lets a viewer re-verify the underlying settlements
   * trustlessly (see /proofs/verify). Pure read-out — no chain call, no mutation.
   */
  private async getLeaderboard(): Promise<Response> {
    if (!this.cfg.economy.enabled) return json({ enabled: false, rows: [] });
    const economy = await this.ensureEconomy();
    const snap = economy.snapshot();
    const pulse = (await this.state.storage.get<PulseSales>(KEY_PULSE)) ??
      { sales: 0, grossAtomic: "0", lastTx: null, lastBuyer: null, lastTs: null };
    return json({
      enabled: true,
      mode: snap.mode,
      network: snap.network,
      asset: snap.asset,
      registryAddress: this.cfg.economy.registryAddress ?? null,
      rows: economy.leaderboard(),
      totals: snap.totals,
      pulse: {
        enabled: this.cfg.signal.enabled,
        priceUsdc: this.cfg.signal.priceUsdc,
        sales: pulse.sales,
        grossUsdc: atomicToUsdc(pulse.grossAtomic),
        lastTx: pulse.lastTx,
        lastBuyer: pulse.lastBuyer,
        lastTs: pulse.lastTs,
      },
    });
  }

  // ---------- on-chain prediction market (agents stake USDC on the next tick's temperature) ----------

  /**
   * The live prediction book: the open round (pools + parimutuel odds + every bet), recent resolutions and
   * the hit-rate leaderboard. Each resolved round carries its receiptHash; pair it with /predictions/verify
   * to recompute the hash and read its on-chain registry commitment (trustless resolution proof).
   */
  private async getPredictions(): Promise<Response> {
    const prediction = await this.ensurePrediction();
    if (!prediction) return json({ enabled: false });
    const economy = this.cfg.economy.enabled ? await this.ensureEconomy() : null;
    return json({
      mode: economy?.facilitatorMode ?? "simulated",
      registryAddress: this.cfg.economy.registryAddress ?? null,
      ...prediction.snapshot(),
    });
  }

  /**
   * One-click trustless verification of a resolved round: recompute sha256(roundReceipt) server-side and
   * read the round's committed link + the registry head from our own NeuralReceiptRegistry. `selfConsistent`
   * means the stored resolution is the one that was hashed; `registry.committed` means it lives on Arc.
   */
  private async getPredictVerify(url: URL): Promise<Response> {
    const prediction = await this.ensurePrediction();
    if (!prediction) return json({ enabled: false }, 400);
    const raw = url.searchParams.get("round");
    const round = raw != null ? Number(raw) : NaN;
    if (!Number.isFinite(round)) return jsonError("bad_request", "round required", 400);
    const economy = this.cfg.economy.enabled ? await this.ensureEconomy() : null;
    const v = await prediction.verifyRound(round);
    if (!v.found || !v.rr) return json({ found: false, round });
    const rr = v.rr;
    const registryCommit = economy ? await economy.registryCommitOf(rr.receiptHash) : null;
    const registryHead = economy ? await economy.registryChainHead() : null;
    return json({
      found: true,
      enabled: true,
      round: rr.round,
      outcome: rr.outcome,
      entryTick: rr.entryTick,
      exitTick: rr.exitTick,
      entryTemp: rr.entryTemp,
      exitTemp: rr.exitTemp,
      delta: rr.delta,
      flatBand: rr.flatBand,
      receiptHash: rr.receiptHash,
      recomputedHash: v.recomputed,
      selfConsistent: v.selfConsistent,
      commitTx: rr.commitTx ?? null,
      registryAddress: this.cfg.economy.registryAddress ?? null,
      registry:
        registryCommit == null && registryHead == null
          ? null
          : {
              committed: registryCommit != null,
              prevHead: registryCommit?.prevHead ?? null,
              tickIndex: registryCommit?.tickIndex ?? null,
              constituents: registryCommit?.constituents ?? null,
              txHash: registryCommit?.txHash ?? null,
              ts: registryCommit?.ts ?? null,
              chainHead: registryHead,
              isHead:
                registryHead != null &&
                registryHead.toLowerCase() === `0x${rr.receiptHash}`.toLowerCase(),
            },
      receipt: v.receipt,
    });
  }

  /**
   * Long-term history from D1: one archived row per cron tick (see archiveTick). Query params:
   *   limit  — max rows (default 500, capped 5000)
   *   before — exclusive upper bound on tick, for backwards pagination
   *   order  — "asc" for oldest-first (default "desc", newest-first)
   * Also returns a cheap aggregate `summary` (row count, first/last tick+ts, lifetime settlements/volume)
   * so the frontend can show "since launch" stats without pulling the whole series. Graceful when D1 is
   * unbound: { enabled:false }.
   */
  private async getHistory(url: URL): Promise<Response> {
    const db = this.env.DB;
    if (!db) return json({ enabled: false, rows: [], summary: null, note: "D1 not bound" });
    const limit = Math.min(5000, Math.max(1, Number(url.searchParams.get("limit") ?? "500") || 500));
    const order = url.searchParams.get("order") === "asc" ? "ASC" : "DESC";
    const beforeRaw = url.searchParams.get("before");
    const COLS = `tick, ts, temperature, regime, size, deals, settlements, volume_usdc, gini, top_state, top_states`;
    try {
      await this.ensureD1Schema(db);
      const hasBefore = beforeRaw != null && Number.isFinite(Number(beforeRaw));
      const page = hasBefore
        ? await db.prepare(`SELECT ${COLS} FROM ticks WHERE tick < ? ORDER BY tick ${order} LIMIT ?`).bind(Number(beforeRaw), limit).all()
        : await db.prepare(`SELECT ${COLS} FROM ticks ORDER BY tick ${order} LIMIT ?`).bind(limit).all();
      const rows = (page.results ?? []).map(parseHistoryRow);
      // The cheap aggregate is a cached running summary (see bumpHistSummary) — no full-table scan here.
      const a = await this.ensureHistSummary(db);
      return json({
        enabled: true,
        order,
        count: rows.length,
        summary: {
          ticks: a.n,
          firstTick: a.firstTick,
          lastTick: a.lastTick,
          firstTs: a.firstTs,
          lastTs: a.lastTs,
          settlements: a.settlements,   // lifetime cumulative (monotonic ⇒ running MAX)
          volumeUsdc: a.volumeUsdc,
        },
        rows,
      });
    } catch (e) {
      return json({ enabled: true, error: (e as Error).message, rows: [], summary: null }, 500);
    }
  }

  /**
   * GET /annals — the chronicle the deterministic historian has been writing. Serves the hot ring buffer
   * (last ANNALS_CAP entries, always available even when D1 is unbound), plus era metadata for the header.
   * Query params:
   *   limit  — max rows to return (default 120, capped 500)
   *   order  — "asc" for oldest-first (default "desc", newest-first)
   *   since  — only entries with seq > this cursor (for a live ticker that appends without duplicates)
   */
  private async getAnnals(url: URL): Promise<Response> {
    await this.ensureChronicler();
    const rawLimit = Number(url.searchParams.get("limit") ?? "120");
    const limit = Math.min(500, Math.max(1, Number.isFinite(rawLimit) ? rawLimit : 120));
    const asc = url.searchParams.get("order") === "asc";
    const sinceRaw = url.searchParams.get("since");
    const since = sinceRaw != null && Number.isFinite(Number(sinceRaw)) ? Number(sinceRaw) : null;
    let rows = this.annals.slice();
    if (since != null) rows = rows.filter((e) => e.seq > since);
    rows.sort((a, b) => (asc ? a.seq - b.seq : b.seq - a.seq));
    rows = rows.slice(0, limit);
    const info = this.chronicler!.eraInfo();
    return json({
      enabled: true,
      version: CHRONICLE_VERSION,
      era: info.era,
      eraName: info.eraName,
      eraRegime: info.eraRegime,
      eraShock: info.eraShock,            // ⑦ which shock forced the CURRENT era (null ⇒ a calm regime age)
      eraShockWilled: info.eraShockWilled, // was it governance-injected ("willed by the commons")?
      seq: info.seq,
      headHash: info.headHash,
      // ⑫ ACCELERATED AGES: the fast civilizational clock's current reading (a pure eraInfo projection).
      generation: info.generation,
      civLevel: info.civLevel,
      civPhase: info.civPhase,
      chroniclerHash: await this.getChroniclerRulesHash(),
      order: asc ? "asc" : "desc",
      count: rows.length,
      entries: rows,
    });
  }

  /**
   * GET /annals/verify — the deterministic-verification companion to /annals. Proves a served line is a real
   * historian output, not an LLM, two ways the visitor can check independently:
   *   • `entry`   — the exact ChronicleEntry (tokens + text + hash + prevHash) so the browser can re-derive
   *                 text = renderTemplate(kind, tokens) and recompute sha256(canonical(entry)‖prevHash).
   *   • `archive` — the D1 `ticks` row for that entry's tick, so the numbers the sentence cites (temperature,
   *                 gini, settlements, volume) are confirmed against the independent per-cron archive.
   * Query: ?seq=<n> (a single entry) or ?from=&to= (a seq range, for a chain re-verification).
   */
  private async getAnnalsVerify(url: URL): Promise<Response> {
    await this.ensureChronicler();
    const seqRaw = url.searchParams.get("seq");
    const chroniclerHash = await this.getChroniclerRulesHash();
    const info = this.chronicler!.eraInfo();
    if (seqRaw != null && Number.isFinite(Number(seqRaw))) {
      const seq = Number(seqRaw);
      const entry = this.annals.find((e) => e.seq === seq) ?? null;
      if (!entry) return json({ enabled: true, chroniclerHash, found: false, seq }, 404);
      return json({
        enabled: true,
        version: CHRONICLE_VERSION,
        chroniclerHash,
        headHash: info.headHash,
        found: true,
        entry,
        archive: await this.readTickArchive(entry.tick),
      });
    }
    // range mode: hand back the raw chain slice so a client can re-verify linkage + re-derive every line.
    const from = Number(url.searchParams.get("from") ?? "0") || 0;
    const toRaw = url.searchParams.get("to");
    const to = toRaw != null && Number.isFinite(Number(toRaw)) ? Number(toRaw) : Number.MAX_SAFE_INTEGER;
    const entries = this.annals.filter((e) => e.seq >= from && e.seq <= to).sort((a, b) => a.seq - b.seq);
    return json({
      enabled: true,
      version: CHRONICLE_VERSION,
      chroniclerHash,
      headHash: info.headHash,
      count: entries.length,
      entries,
    });
  }

  /** Read the archived `ticks` row for one tick (best-effort; null when D1 is unbound or the row is gone). */
  private async readTickArchive(tick: number): Promise<Record<string, unknown> | null> {
    const db = this.env.DB;
    if (!db) return null;
    try {
      await this.ensureD1Schema(db);
      const r = await db
        .prepare(`SELECT tick, ts, temperature, regime, size, deals, settlements, volume_usdc, gini FROM ticks WHERE tick = ?`)
        .bind(tick).first();
      if (!r) return null;
      return {
        tick: (r as any).tick, ts: (r as any).ts, temperature: (r as any).temperature, regime: (r as any).regime,
        size: (r as any).size, deals: (r as any).deals, settlements: (r as any).settlements,
        volumeUsdc: (r as any).volume_usdc, gini: (r as any).gini,
      };
    } catch {
      return null;
    }
  }

  /** The historian's rule-set digest — computed once per DO lifetime (a pure function of the source). */
  private async getChroniclerRulesHash(): Promise<string> {
    if (this.chroniclerRulesHash == null) this.chroniclerRulesHash = await chroniclerRulesHash();
    return this.chroniclerRulesHash;
  }

  /**
   * GET /poem — ⑮ the Laureate's latest poem + the head of its independent hash chain + the recent collection.
   * Serves the grammar hash (so anyone can confirm the decoding rules) and the honest verification boundary.
   * While POET_ENABLED=false (or before the first coronation) it returns an EMPTY chain with a 200 — never a 500.
   */
  private async getPoem(url: URL): Promise<Response> {
    const poet = await this.ensurePoet();
    const grammarHash = await this.getPoetGrammarHash();
    const enabled = this.cfg.poet.enabled;
    if (!poet) {
      return json({ enabled, version: POET_VERSION, policy: POET_POLICY, grammarHash, chainHead: "", headSeq: 0, count: 0, laureate: null, latest: null, entries: [], honesty: POET_HONESTY });
    }
    const rawLimit = Number(url.searchParams.get("limit") ?? "8");
    const limit = Math.min(64, Math.max(1, Number.isFinite(rawLimit) ? rawLimit : 8));
    const entries = poet.recent(limit).slice().reverse(); // newest-first for the feed
    return json({
      enabled,
      version: POET_VERSION,
      policy: POET_POLICY,
      grammarHash,
      chainHead: poet.chainHead,
      headSeq: poet.headSeq,
      count: entries.length,
      laureate: poet.currentLaureate(),
      latest: poet.latest(),
      entries,
      honesty: POET_HONESTY,
    });
  }

  /**
   * GET /poem/verify?seq=N — recompute a poem's receipt hash from its own bytes (selfConsistent) AND replay its
   * text from its published neuralInts + the current grammar (replayMatch). This is the "neurons wrote it, and
   * anyone can check" endpoint: both proofs need only the served entry + the open poet.ts, no trust in us.
   * Defaults to the chain head when seq is omitted.
   */
  private async getPoemVerify(url: URL): Promise<Response> {
    const poet = await this.ensurePoet();
    const grammarHash = await this.getPoetGrammarHash();
    if (!poet) return json({ enabled: this.cfg.poet.enabled, version: POET_VERSION, policy: POET_POLICY, grammarHash, found: false, honesty: POET_HONESTY });
    const seqRaw = url.searchParams.get("seq");
    const seq = seqRaw != null && Number.isFinite(Number(seqRaw)) ? Number(seqRaw) : poet.headSeq;
    const entry = poet.get(seq) ?? (await this.readPoemArchiveEntry(seq));   // hot ring first, then the permanent D1 archive
    if (!entry) return json({ enabled: true, version: POET_VERSION, grammarHash, found: false, seq, honesty: POET_HONESTY }, 404);
    const recomputedHash = await recomputePoemHash(entry);
    const replay = replayCompose(entry);
    return json({
      enabled: true,
      version: POET_VERSION,
      policy: POET_POLICY,
      grammarHash,
      found: true,
      seq,
      entry,
      recomputedHash,
      selfConsistent: recomputedHash === entry.hash,
      replayMatch: replay.match,
      replayText: replay.text,
      grammarMatches: entry.grammarHash === grammarHash,
      honesty: POET_HONESTY,
    });
  }

  /** GET /poem/all?limit=N — the raw recent poem chain (ascending seq) for an offline chain + replay re-verification. */
  private async getPoemAll(url: URL): Promise<Response> {
    const poet = await this.ensurePoet();
    const grammarHash = await this.getPoetGrammarHash();
    if (!poet) return json({ enabled: this.cfg.poet.enabled, version: POET_VERSION, policy: POET_POLICY, grammarHash, chainHead: "", headSeq: 0, count: 0, entries: [] });
    const rawLimit = Number(url.searchParams.get("limit") ?? "64");
    const limit = Math.min(500, Math.max(1, Number.isFinite(rawLimit) ? rawLimit : 64));
    const entries = poet.recent(limit);
    return json({ enabled: true, version: POET_VERSION, policy: POET_POLICY, grammarHash, chainHead: poet.chainHead, headSeq: poet.headSeq, count: entries.length, entries });
  }

  /**
   * GET /poem/archive — the PERMANENT collection from D1 (every poem ever composed, not just the DO hot ring).
   * Query: limit (default 200, max 1000), order (desc default | asc), before (seq cursor for older pages).
   * Serves full PoemEntry objects (byte-identical to the chain) so the frontend can recompute each receipt hash
   * in-browser and replay it. Graceful when D1 is unbound: falls back to the hot ring, flagged archived:false.
   */
  private async getPoemArchive(url: URL): Promise<Response> {
    const poet = await this.ensurePoet();
    const grammarHash = await this.getPoetGrammarHash();
    const enabled = this.cfg.poet.enabled;
    const order = url.searchParams.get("order") === "asc" ? "ASC" : "DESC";
    const ringFallback = (note: string) => {
      const entries = poet ? poet.recent(500).slice().reverse() : [];
      return json({ enabled, version: POET_VERSION, policy: POET_POLICY, grammarHash, archived: false, order, count: entries.length, total: entries.length, headSeq: poet?.headSeq ?? 0, chainHead: poet?.chainHead ?? "", laureate: poet?.currentLaureate() ?? null, entries, honesty: POET_HONESTY, note });
    };
    const db = this.env.DB;
    if (!db) return ringFallback("D1 not bound; serving the hot ring");
    const rawLimit = Number(url.searchParams.get("limit") ?? "200");
    const limit = Math.min(1000, Math.max(1, Number.isFinite(rawLimit) ? rawLimit : 200));
    const beforeRaw = url.searchParams.get("before");
    const before = beforeRaw != null && Number.isFinite(Number(beforeRaw)) ? Number(beforeRaw) : null;
    try {
      await this.ensureD1Poems(db);
      await this.backfillPoemRing(poet);   // a drawer open also folds the ring in immediately (idempotent)
      let sql = `SELECT entry FROM poems`;
      const args: (number | string)[] = [];
      if (before != null) { sql += ` WHERE seq < ?`; args.push(before); }
      sql += ` ORDER BY seq ${order} LIMIT ?`;
      args.push(limit);
      const { results } = await db.prepare(sql).bind(...args).all<{ entry: string }>();
      const entries: PoemEntry[] = [];
      for (const r of results ?? []) {
        try { const e = JSON.parse(r.entry) as PoemEntry; if (e && typeof e.seq === "number") entries.push(e); } catch { /* skip a malformed row */ }
      }
      let total = entries.length;
      try { const c = await db.prepare(`SELECT COUNT(*) AS n FROM poems`).first<{ n: number }>(); total = Number(c?.n) || entries.length; } catch { /* keep entries.length */ }
      return json({ enabled: true, version: POET_VERSION, policy: POET_POLICY, grammarHash, archived: true, order, limit, before, count: entries.length, total, headSeq: poet?.headSeq ?? 0, chainHead: poet?.chainHead ?? "", laureate: poet?.currentLaureate() ?? null, entries, honesty: POET_HONESTY });
    } catch (e) {
      console.warn("[DO] poem archive read failed (non-fatal):", (e as Error).message);
      return ringFallback("archive read failed; serving the hot ring");
    }
  }

  private async getMarket() {
    const meter = await this.ensureMeter();
    const market = (await this.state.storage.get<MarketState>(KEY_MARKET)) ?? null;
    const prevTemperature = await this.ensurePrevTemperature();
    return json({ market, meter: meter.toJSON(), prevTemperature });
  }

  private async getStimuli() {
    const stimuli = (await this.state.storage.get<StoredStimulus[]>(KEY_STIMULI)) ?? [];
    return json({ stimuli });
  }

  /** Full neural snapshot of one fly (membrane / firing rates / spikes) for the generative view. */
  private async getSnapshot(url: URL) {
    const swarm = await this.ensureSwarm();
    const flyIdParam = url.searchParams.get("flyId");
    const flyId = flyIdParam ? Number(flyIdParam) : 0;
    const neural = await swarm.snapshotFly(flyId);
    if (!neural) return jsonError("not_found", `fly ${flyId} not found`, 404);
    // Attach this fly's agent wallet (when the economy is on) so the inspector can show its economy.
    let agent: any = null;
    if (this.cfg.economy.enabled) {
      const a = (await this.ensureEconomy()).getAgent(flyId);
      if (a) agent = { address: a.address, balance: a.balance, paid: a.paid, earned: a.earned, deals: a.deals, sales: a.sales };
    }
    return json({ ...neural, agent });
  }

  private async getFly(flyIdStr: string) {
    const swarm = await this.ensureSwarm();
    const flyId = Number(flyIdStr);
    const detail = await swarm.flyDetail(flyId);
    if (!detail) return jsonError("not_found", "no such fly", 404);
    const b = detail.behavior;
    let agent: any = null;
    if (this.cfg.economy.enabled) {
      const a = (await this.ensureEconomy()).getAgent(flyId);
      if (a) agent = { address: a.address, balance: a.balance, paid: a.paid, earned: a.earned, deals: a.deals, sales: a.sales };
    }
    return json({
      vitals: detail.vitals,
      behavior: b
        ? {
            state: b.state,
            arousal: b.arousal,
            turnBias: b.turnBias,
            cohesion: b.cohesion,
            wingbeat: b.wingbeat,
            rest: b.rest,
            fingerprint: b.neuralFingerprint,
          }
        : null,
      motor: detail.motor,
      agent,
      t: detail.t,
      step: detail.step,
    });
  }

  private async postStimulus(req: Request) {
    const body = (await req.json()) as StimulusVoteRequest;
    const ip =
      req.headers.get("CF-Connecting-IP") ?? req.headers.get("X-Forwarded-For") ?? undefined;
    const result: StimulusVoteResult = await handleStimulusVote(this.cfg, body, ip);
    if (!result.ok || !result.accepted) return json(result, 400);

    // The stimulus is perceived by the WHOLE population on the next tick.
    this.pendingStimuli.push({
      type: result.accepted.type,
      intensity: result.accepted.effectiveIntensity,
      from: result.accepted.voter,
    });

    // ⑦ EPOCHS — a decisive miracle or cataclysm (food/threat, intensity ≥ 0.75) is a SHOCK the commons
    // WILLED: queue it for the historian, which force-opens a new epoch through the SAME entry the fly-side
    // detector uses, only source-labelled. Pure read-out — it names an age, it never touches a neuron/wallet.
    if (this.cfg.epochs.enabled && (result.accepted.type === "food" || result.accepted.type === "threat") &&
        result.accepted.effectiveIntensity >= 0.75) {
      this.pendingGovernanceShock = { kind: result.accepted.type === "food" ? "BOOM" : "PLAGERA" };
    }

    const stored: StoredStimulus = {
      ts: Date.now(),
      type: result.accepted.type,
      intensity: result.accepted.effectiveIntensity,
      voter: result.accepted.voter,
    };
    const list = (await this.state.storage.get<StoredStimulus[]>(KEY_STIMULI)) ?? [];
    list.unshift(stored);
    if (list.length > MAX_STIMULI) list.length = MAX_STIMULI;
    await this.state.storage.put(KEY_STIMULI, list);

    return json(result);
  }

  /**
   * Guard the mutating debug endpoints (POST /tick, /reset). When the optional ADMIN_TOKEN secret is
   * set, a caller must present it (x-admin-token header or ?token=); with no token configured these
   * stay open so local dev and the documented onchain-arming flow (which POSTs /reset) keep working.
   * An operator can lock them on the live deployment with `wrangler secret put ADMIN_TOKEN`.
   */
  private adminGate(req: Request): Response | null {
    const token = (this.env.ADMIN_TOKEN ?? "").trim();
    if (!token) return null;
    const url = new URL(req.url);
    const provided = req.headers.get("x-admin-token") ?? url.searchParams.get("token") ?? "";
    return provided === token ? null : jsonError("forbidden", "forbidden", 403);
  }

  /** Debug: run one cron tick on demand. */
  private async postTick() {
    await this.cron();
    const snap = await this.loadSnapshot();
    const economy = this.cfg.economy.enabled ? (await this.ensureEconomy()).summary() : null;
    return json({ ok: true, collective: snap?.collective ?? null, economy });
  }

  /**
   * Debug: wipe back to a fresh founding population + unlearned market baseline + funded wallets.
   * ALSO the required step when first arming onchain: a DO that already holds simulated state has
   * pseudo-addresses with no signer, so reset re-creates every agent with its real HD address.
   */
  private async postReset() {
    // Fresh founding swarm: LocalSwarm rebuilds a new Population; ShardedSwarm resets every shard plus
    // the coordinator counter. Each persists its own state here, so the wipe survives an eviction.
    const swarm = await this.ensureSwarm();
    await swarm.reset(this.state.storage);
    this.meter = new MarketMeter(
      this.cfg.marketEwmaAlpha,
      this.cfg.regimeHot,
      this.cfg.regimeCold,
      this.cfg.marketGain,
    );
    this.economy = this.makeEconomy();
    this.culture = null;   // a reset swallows the fashions too: culture starts from innate readings
    this.religion = null;  // ⑪ and the faiths: religion restarts from an empty membrane
    this.tech = null;      // ⑬ and the arts: the ladder is forgotten with everything else
    this.cities = null;    // ⑭ and the places: the map goes back to open ground
        this.apprentice = null;  // ⑯ and the educations: every personal art is unwitnessed with everything else
    this.archive = null;     // ⑰ and the archive: every record is burned with everything else
    this.court = null;     // ⑳ and the court: the docket and the outlaw roll are dust with everything else
    this.games = null;     // ㉑ and the games: the stadium and its standing mark are forgotten with everything else
    this.guilds = null;    // ㉒ and the guilds: every seal, pact and monopoly is unspoken with everything else
    this.lexicon = null;   // ㉓ and the lexicon: every coined, spread and buried word is unremembered with everything else
    this.rumor = null;     // ㉔ and the rumor mill: every tale afoot, bent or buried is unsaid with everything else
    this.treaty = null;    // ㉕ and the chancery: every seal set, ratified or broken is void with everything else
    this.works = null;     // ㉖ and the yard: every work raised, mended or lost to ruin is un-built with everything else
    this.poet = null;      // ⑮ and the poet: the laureate's chain is forgotten with everything else
    this.prevTemperature = 0.5;
    this.lastSnapshot = null;
    this.lastEconomy = null;
    await this.state.storage.put(KEY_METER, this.meter.toJSON());
    await this.state.storage.put(KEY_ECONOMY, this.economy.serialize());
    await this.state.storage.put(KEY_PREV_TEMP, 0.5);
    await this.state.storage.delete(KEY_LAST_SNAPSHOT);
    await this.state.storage.delete(KEY_MARKET);
    await this.state.storage.delete(KEY_CULTURE);
    await this.state.storage.delete(KEY_RELIGION);
    await this.state.storage.delete(KEY_TECH);
    await this.state.storage.delete(KEY_CITIES);
    await this.state.storage.delete(KEY_APPRENTICE);
    await this.state.storage.delete(KEY_ARCHIVE);
    await this.state.storage.delete(KEY_WORKSHOP);
    await this.state.storage.delete(KEY_COURT);
    await this.state.storage.delete(KEY_GAMES);
    await this.state.storage.delete(KEY_GUILDS);
    await this.state.storage.delete(KEY_LEXICON);
    await this.state.storage.delete(KEY_RUMOR);
    await this.state.storage.delete(KEY_TREATY);
    await this.state.storage.delete(KEY_WORKS);
    await this.state.storage.delete(KEY_POET);
    return json({ ok: true });
  }
}

/** Shape a raw D1 `ticks` row into clean camelCase JSON, parsing the behavioural-state histogram. */
function parseHistoryRow(r: any) {
  let topStates: Record<string, number> | null = null;
  if (r?.top_states) {
    try { topStates = JSON.parse(r.top_states); } catch { topStates = null; }
  }
  return {
    tick: r?.tick ?? null,
    ts: r?.ts ?? null,
    temperature: r?.temperature ?? null,
    regime: r?.regime ?? null,
    size: r?.size ?? null,
    deals: r?.deals ?? null,
    settlements: r?.settlements ?? null,
    volumeUsdc: r?.volume_usdc ?? null,
    gini: r?.gini ?? null,
    topState: r?.top_state ?? null,
        topStates,
  };
}

/** Shape a raw D1 `chronicle` row back into a ChronicleEntry (JSON-parse actors + metrics + tokens). */
function parseChronicleRow(r: any): ChronicleEntry {
  let actors: number[] = [];
  let metrics: Record<string, number> = {};
  let tokens: Record<string, string | number> = {};
  try { actors = Array.isArray(JSON.parse(r?.actors ?? "[]")) ? JSON.parse(r.actors) : []; } catch { actors = []; }
  try { metrics = r?.metrics ? JSON.parse(r.metrics) : {}; } catch { metrics = {}; }
  try { tokens = r?.tokens ? JSON.parse(r.tokens) : {}; } catch { tokens = {}; }
  return {
    seq: Number(r?.seq ?? 0),
    tick: Number(r?.tick ?? 0),
    ts: Number(r?.ts ?? 0),
    kind: String(r?.kind ?? "ERA_OPEN") as ChronicleEntry["kind"],
    era: Number(r?.era ?? 1),
    eraName: String(r?.era_name ?? ""),
    severity: (Number(r?.severity ?? 1) || 1) as 1 | 2 | 3,
    actors,
    text: String(r?.text ?? ""),
    metrics,
    tokens,
    prevHash: String(r?.prev_hash ?? ""),
    hash: String(r?.hash ?? ""),
  };
}

/** A 402 Payment Required response: the requirements in the body AND base64 in the PAYMENT-REQUIRED header. */
function paymentRequired(reqs: PaymentRequirements, error?: string): Response {
  const body = buildPaymentRequired(reqs, error);
  return new Response(JSON.stringify(body), {
    status: 402,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "PAYMENT-REQUIRED": b64json([reqs]),
      "X-PAYMENT-VERSION": String(X402_VERSION),
      "Cache-Control": "no-store",
    },
  });
}

/** A plain-language, trader-readable interpretation of the current Arc-activity regime. */
function pulseRead(regime: Regime, momentum: number, temperature: number): string {
  const dir = momentum > 0.05 ? "heating" : momentum < -0.05 ? "cooling" : "steady";
  const t = temperature.toFixed(2);
  if (regime === "HOT")
    return `HOT · Arc activity is ${dir} and well above its learned norm (T=${t}) — risk-on, liquidity thick; the swarm is chasing momentum.`;
  if (regime === "COLD")
    return `COLD · Arc activity is ${dir} and below its norm (T=${t}) — thin, risk-off; the swarm is conserving.`;
  return `CALM · Arc activity is ${dir} around its norm (T=${t}) — balanced; the swarm is exploring.`;
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
      "Cache-Control": "no-store",
    },
  });
}

/** Stable machine-readable error slugs for the public API (mirrors components.schemas.ApiError in openapi.ts). */
type ApiErrorCode = "not_found" | "bad_request" | "internal_error" | "payment_required" | "forbidden" | "service_unavailable";

/**
 * The unified public-API error envelope `{ error, code, status }`. `error` stays a plain message string for
 * backward compatibility with existing consumers; `code` is a stable slug and `status` mirrors the HTTP status.
 */
function jsonError(code: ApiErrorCode, message: string, status: number): Response {
  return json({ error: message, code, status }, status);
}
