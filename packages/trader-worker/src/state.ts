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
import type { Env, RuntimeConfig } from "./config.js";
import { loadConfig, shardSlice, fliesPerShard } from "./config.js";
import { netReceiptHash } from "./provenance.js";
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
import type { PopulationSnapshot } from "./population.js";
import { LocalSwarm, ShardedSwarm, type SwarmBackend } from "./swarm.js";
import { AgentEconomy, type EconomySnapshot, type EconomyConfig, type EconomyDeps, type EconomyTotals, type Settlement } from "./economy.js";
import { PinataPinner } from "./ipfs.js";
import { PredictionMarket, type PredictConfig, type PredictFlow, type ResolvedRound } from "./prediction.js";
import { arenaRoundPlan, cursorAfterOpen, tempToR6 } from "./arena.js";
import { arcNetworkTag, ARC_USDC, makeFacilitator, usdcToAtomic, atomicToUsdc, buildPaymentRequired, b64json, SCHEME_EXACT, X402_VERSION, type PaymentRequirements, type PaymentPayload, type SettleResponse, type ArenaRoundInfo } from "./x402.js";
import { caip2 } from "./circle.js";
import { publicClient, walletClient } from "./chain.js";
import { deriveAgentKeys } from "./keys.js";
import type { Address, LocalAccount } from "viem";

const KEY_METER = "marketMeter:v1";
const KEY_MARKET = "market:v1";
const KEY_LAST_SNAPSHOT = "lastSnapshot:v1";
const KEY_PREV_TEMP = "prevTemperature";
const KEY_STIMULI = "stimuli";
const KEY_ECONOMY = "economy:v1";
const KEY_PULSE = "pulse:v1";
const KEY_PREDICT = "predict:v1";
const KEY_ARENA = "arena:v1";
const KEY_LAST_CRON = "lastCron";
const MAX_STIMULI = 200;

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

export class FlyStateDO {
  private state: DurableObjectState;
  private env: Env;
  private cfg: RuntimeConfig;
  private swarm: SwarmBackend | null = null;
  private meter: MarketMeter | null = null;
  private economy: AgentEconomy | null = null;
  private prediction: PredictionMarket | null = null;
  private arenaState: ArenaState | null = null;
  private lastSnapshot: PopulationSnapshot | null = null;
  private lastEconomy: EconomySnapshot | null = null;
  /** Previous tick's temperature, used for the pulse's momentum facet; null until loaded. */
  private prevTemperature: number | null = null;
  private pendingStimuli: StimulusEvent[] = [];
  /** Reentrancy guard so overlapping crons never drive the population concurrently. */
  private cronRunning = false;
  /** Set once the D1 archival table has been ensured this DO lifetime (avoids re-running DDL per cron). */
  private d1SchemaReady = false;

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
    };
  }

  private async ensureEconomy(): Promise<AgentEconomy> {
    if (this.economy) return this.economy;
    const stored = await this.state.storage.get<string>(KEY_ECONOMY);
    this.economy = this.makeEconomy(stored ?? undefined);
    return this.economy;
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
    const keys = deriveAgentKeys(e.mnemonic!, this.cfg.populationSize, e.facilitatorPk ?? undefined);
    const pub = publicClient(this.cfg);
    const wallet = walletClient(this.cfg, keys.facilitator());

    // Reverse map: lowercase agent address → its HD signing account. Fly ids are 0..populationSize-1
    // (see population.ts), exactly the range we derive, so every possible buyer resolves to a signer.
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
    if (this.meter) await this.state.storage.put(KEY_METER, this.meter.toJSON());
    if (this.economy) await this.state.storage.put(KEY_ECONOMY, this.economy.serialize());
    if (this.prediction) await this.state.storage.put(KEY_PREDICT, this.prediction.serialize());
    if (this.arenaState) await this.state.storage.put(KEY_ARENA, this.arenaState);
    await this.state.storage.put(KEY_PREV_TEMP, this.prevTemperature ?? 0.5);
    if (market) await this.state.storage.put(KEY_MARKET, market);
    if (snapshot) {
      this.lastSnapshot = snapshot;
      await this.state.storage.put(KEY_LAST_SNAPSHOT, snapshot);
    }
    await this.state.storage.put(KEY_LAST_CRON, Date.now());
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
          Date.now(),
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
    } catch (e) {
      console.warn("[DO] D1 archive failed (non-fatal):", (e as Error).message);
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
      if (req.method === "GET" && path === "/economy") return await this.getEconomy();
      if (req.method === "GET" && path === "/proofs") return await this.getProofs();
      if (req.method === "GET" && path === "/proofs/verify") return await this.getProofVerify(url);
      if (req.method === "GET" && path === "/signal/pulse") return await this.getSignalPulse(req);
      if (req.method === "GET" && path === "/signal/requirements") return await this.getSignalRequirements();
      if (req.method === "GET" && path === "/leaderboard") return await this.getLeaderboard();
      if (req.method === "GET" && path === "/predictions") return await this.getPredictions();
      if (req.method === "GET" && path === "/predictions/verify") return await this.getPredictVerify(url);
      if (req.method === "GET" && path === "/arena") return await this.getArena();
      if (req.method === "GET" && path === "/history") return await this.getHistory(url);
      if (req.method === "GET" && path === "/stimuli") return await this.getStimuli();
      if (req.method === "GET" && path === "/snapshot") return await this.getSnapshot(url);
      if (req.method === "GET" && path.startsWith("/flies/")) return await this.getFly(path.split("/")[2]);
      if (req.method === "POST" && path === "/stimulus") return await this.postStimulus(req);
      if (req.method === "POST" && path === "/tick") return this.adminGate(req) ?? (await this.postTick());
      if (req.method === "POST" && path === "/reset") return this.adminGate(req) ?? (await this.postReset());
      return json({ error: "not found" }, 404);
    } catch (e) {
      console.error("[DO] fetch error:", e);
      return json({ error: (e as Error).message }, 500);
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

    // 3) Collect the visitor stimuli queued since the last tick (injected on the first sub-tick only).
    const stimuli = this.pendingStimuli.splice(0, this.pendingStimuli.length);

    // 4) Run the decision sub-ticks. The agent economy now settles on EVERY sub-tick (not just once per
    //    cron), sharing ONE per-cron deal budget — so trades are ~5× more frequent while the total real
    //    settlements per cron stays bounded. Each sub-tick has a unique tickIndex, so every EIP-3009
    //    nonce stays unique (no replay) even though the economy steps several times per cron.
    const subTicks = this.cfg.ticksPerCron;
    const subSteps = Math.max(1, Math.floor(this.cfg.simStepsPerTick / subTicks));
    let snapshot: PopulationSnapshot | null = null;
    const economy = this.cfg.economy.enabled ? await this.ensureEconomy() : null;
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
      // 4b) Settle x402 micropayments from the drives this sub-tick produced. One-directional read-out
      //     of the neural layer — it never feeds back into the connectome.
      if (economy && snapshot && econBudget > 0) {
        const made = await economy.step(
          snapshot.flies,
          snapshot.collective,
          swarm.getTickIndex(),
          econBudget,
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

    console.log(
      `[DO] cron tick#${swarm.getTickIndex()} T=${temperature.toFixed(3)} ${regime} ` +
        `size=${snapshot?.collective.size ?? 0} subTicks=${subTicks} deals=${deals}`,
    );
  }

  // ---------- Endpoint implementations ----------

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
      aliveCount: swarm.size(),
      totalCount: swarm.size(),
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
    fliesPerShard: number;
    shards: { index: number; start: number; end: number }[];
  } {
    const size = this.cfg.populationSize;
    const shardCount = this.sharding ? this.cfg.shardCount : 1;
    const shards: { index: number; start: number; end: number }[] = [];
    for (let k = 0; k < shardCount; k++) {
      const { start, end } = shardSlice(size, shardCount, k);
      if (end > start) shards.push({ index: k, start, end });
    }
    return { sharded: this.sharding, shardCount, populationSize: size, fliesPerShard: fliesPerShard(size, shardCount), shards };
  }

  /** Full agent-economy snapshot: every wallet, the recent settlement ledger and aggregate totals. */
  private async getEconomy() {
    const economy = await this.ensureEconomy();
    return json(economy.snapshot());
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
    if (!tx) return json({ error: "tx required" }, 400);
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
    if (!this.cfg.signal.enabled) return json({ error: "signal product disabled" }, 404);
    const economy = await this.ensureEconomy();
    const { reqs } = await this.signalRequirements(economy);
    if (!reqs) return json({ error: "signal product not configured" }, 503);

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
    if (!Number.isFinite(round)) return json({ error: "round required" }, 400);
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
      const agg = await db
        .prepare(
          `SELECT COUNT(*) AS n, MIN(tick) AS firstTick, MAX(tick) AS lastTick, MIN(ts) AS firstTs,
                  MAX(ts) AS lastTs, MAX(settlements) AS settlements, MAX(volume_usdc) AS volumeUsdc FROM ticks`,
        )
        .all();
      const rows = (page.results ?? []).map(parseHistoryRow);
      const a: any = (agg.results ?? [])[0] ?? {};
      return json({
        enabled: true,
        order,
        count: rows.length,
        summary: {
          ticks: Number(a.n ?? 0),
          firstTick: a.firstTick ?? null,
          lastTick: a.lastTick ?? null,
          firstTs: a.firstTs ?? null,
          lastTs: a.lastTs ?? null,
          settlements: a.settlements ?? null,   // lifetime cumulative (monotonic ⇒ MAX)
          volumeUsdc: a.volumeUsdc ?? null,
        },
        rows,
      });
    } catch (e) {
      return json({ enabled: true, error: (e as Error).message, rows: [], summary: null }, 500);
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
    if (!neural) return json({ error: `fly ${flyId} not found` }, 404);
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
    if (!detail) return json({ error: "not found" }, 404);
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
    return provided === token ? null : json({ error: "forbidden" }, 403);
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
    this.prevTemperature = 0.5;
    this.lastSnapshot = null;
    this.lastEconomy = null;
    await this.state.storage.put(KEY_METER, this.meter.toJSON());
    await this.state.storage.put(KEY_ECONOMY, this.economy.serialize());
    await this.state.storage.put(KEY_PREV_TEMP, 0.5);
    await this.state.storage.delete(KEY_LAST_SNAPSHOT);
    await this.state.storage.delete(KEY_MARKET);
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
