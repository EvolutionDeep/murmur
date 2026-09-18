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
import { arcNetworkTag, ARC_USDC, makeFacilitator, usdcToAtomic } from "./x402.js";
import { publicClient, walletClient } from "./chain.js";
import { deriveAgentKeys } from "./keys.js";
import type { Address, LocalAccount } from "viem";

const KEY_METER = "marketMeter:v1";
const KEY_MARKET = "market:v1";
const KEY_LAST_SNAPSHOT = "lastSnapshot:v1";
const KEY_PREV_TEMP = "prevTemperature";
const KEY_STIMULI = "stimuli";
const KEY_ECONOMY = "economy:v1";
const KEY_LAST_CRON = "lastCron";
const MAX_STIMULI = 200;

export class FlyStateDO {
  private state: DurableObjectState;
  private env: Env;
  private cfg: RuntimeConfig;
  private swarm: SwarmBackend | null = null;
  private meter: MarketMeter | null = null;
  private economy: AgentEconomy | null = null;
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
    });

    console.warn(
      `[DO] REAL-MONEY economy ARMED on chainId ${this.cfg.chainId}: ${keys.count} HD agents, gas wallet ` +
        `${keys.facilitatorAddress()}, shadowOnly=${e.shadowOnly}, realSpend=${e.realSpendEnabled}, ` +
        `perDealCap=${e.maxDealUsdc} USDC, dailyCap=${e.dailyCapUsdc} USDC, perAgentDailyCap=${e.perAgentDailyCapUsdc} USDC.`,
    );

    return { facilitator, addressOf: (id) => keys.address(id) };
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
