// Environment / Vars types + runtime config for the murmur Worker.
//
// murmur OBSERVES Arc whole-chain activity, derives a "market temperature" (HOT / CALM / COLD), and
// drives a population of LIF-neuron flies whose collective + individual reactions are visualised. On
// top of that reactive layer sits an agent economy: the Worker READS Arc for the temperature and, when
// the onchain facilitator is armed with a mnemonic secret, WRITES real EIP-3009 USDC transfers between
// the agents. With no mnemonic it runs a keyless simulated ledger and moves nothing (see state.ts).

export interface Env {
  // Durable Object binding (population + market state) — the coordinator singleton.
  FLY_STATE: DurableObjectNamespace;

  // Optional Durable Object binding for the sharded swarm. When SHARD_COUNT > 1 AND this binding is
  // present, FlyStateDO becomes a coordinator that fans the heavy per-fly LIF advance out to N
  // independent FlyShardDO isolates (one slice of the population each) instead of running all brains
  // in a single isolate. Absent (or SHARD_COUNT = 1) ⇒ today's exact single-DO behaviour.
  FLY_SHARD?: DurableObjectNamespace;

  // Optional D1 (long-term archival of market / population snapshots)
  DB?: D1Database;

  // --- Arc chain ---
  CHAIN_ID: string;                 // "5042002" (Arc testnet, default) | "5042" (Arc mainnet)
  RPC_URL: string;                  // public primary RPC URL
  ALCHEMY_ARC_RPC_URL?: string;     // SECRET: private Alchemy Arc mainnet RPC URL

  // --- Market-temperature sampling (Arc whole-chain activity) ---
  MARKET_SAMPLE_BLOCKS?: string;    // recent blocks sampled per cron for tx/gas throughput (default 16)
  MARKET_EWMA_ALPHA?: string;       // baseline smoothing 0..1 (default 0.08; slow so it tracks regime, not spikes)
  REGIME_HOT?: string;              // temperature >= this ⇒ HOT (default 0.66)
  REGIME_COLD?: string;             // temperature <= this ⇒ COLD (default 0.33)
  MARKET_GAIN?: string;             // logistic gain ratio→temperature (default 3.0; higher = twitchier)

  // --- Population ---
  POPULATION_SIZE?: string;         // number of flies (default 24, range 1..256)
  POPULATION_SEED_BASE?: string;    // base seed; fly i uses base + i*7919 (default 42)
  TICKS_PER_CRON?: string;          // simulation sub-ticks per cron (default 6)
  SIM_STEPS_PER_TICK?: string;      // LIF integration steps per sub-tick (default 500)
  SHARD_COUNT?: string;             // swarm shards across N Durable Objects (default 1 = single DO; needs the FLY_SHARD binding)

  // --- Visitor stimulus (optional "poke the swarm" secondary input) ---
  STIMULUS_COOLDOWN_SEC?: string;   // one injection per visitor per N seconds (default 30)
  FRONTEND_ORIGIN?: string;         // CORS origin for the frontend (default *)
  ADMIN_TOKEN?: string;             // SECRET (optional): when set, POST /tick + /reset must present it (x-admin-token header or ?token=)

  // --- Agent economy (x402 micropayments between fly agents) ---
  ECONOMY_ENABLED?: string;           // "true"/"false" (default true) — the fly swarm as an agent economy
  ECONOMY_INITIAL_BALANCE?: string;   // starting USDC per agent wallet (default 6)
  ECONOMY_BASE_PRICE?: string;        // base price of one good in USDC before neural/market scaling (default 0.002)
  ECONOMY_SOLVENCY_FLOOR?: string;    // simulated treasury tops an agent up to this when it falls below (default 0.5)
  ECONOMY_MAX_DEALS?: string;         // max settlements per tick — CPU budget (default = POPULATION_SIZE)
  ECONOMY_FACILITATOR?: string;       // "simulated" (default; keyless ledger) | "onchain" (real EIP-3009; needs the secrets below)

  // --- Real-money (ONCHAIN) settlement: secrets + safety rails. EVERY one is inert unless
  //     ECONOMY_FACILITATOR="onchain" AND ECONOMY_MNEMONIC is set. Set secrets with `wrangler secret put`. ---
  ECONOMY_MNEMONIC?: string;            // SECRET: one BIP-39 seed → all agent wallets + the gas wallet (HD-derived)
  ECONOMY_FACILITATOR_PK?: string;      // SECRET (optional): a dedicated gas-wallet key; else derived from the mnemonic
  ECONOMY_REAL_SPEND?: string;          // kill switch: "false" halts ALL real settlement (default "true")
  ECONOMY_SHADOW?: string;              // "true" = sign + simulate each transfer but NEVER broadcast (default "false")
  ECONOMY_DAILY_CAP?: string;           // global real-spend ceiling per UTC day, USDC (default 20; 0 = no cap)
  ECONOMY_PER_AGENT_DAILY_CAP?: string; // per-agent real-spend ceiling per UTC day, USDC (default 2; 0 = no cap)
  ECONOMY_MAX_DEAL?: string;            // facilitator hard per-deal ceiling, USDC (default 0.05)
  ECONOMY_NET_MIN_BROADCAST?: string;   // netting: min net USDC per pair before it is broadcast (dust carries; default 0.004)
  ECONOMY_NET_FLUSH_TICKS?: string;     // netting: force-flush any nonzero pending net at least every N sub-ticks (default 30)
  ECONOMY_GAS_PRICE_GWEI?: string;      // pin the relay gas price in gwei (default: let viem estimate; Arc launched ~20)
  ECONOMY_USDC_EIP712_NAME?: string;    // EIP-712 domain name override (default "USDC" = the Arc precompile's name())
  ECONOMY_USDC_EIP712_VERSION?: string; // EIP-712 domain version override (default "2" = the precompile's version())

  // --- connectome sizing (optional; omitted ⇒ buildConnectome defaults) ---
  BRAIN_N_SENSORY?: string;
  BRAIN_N_INTER_L1?: string;
  BRAIN_N_INTER_L2?: string;
  BRAIN_N_MODULATORY?: string;
  BRAIN_N_MOTOR_PER_CHANNEL?: string;
  BRAIN_DENSITY?: string;
}

export interface RuntimeConfig {
  // Chain
  chainId: number;
  rpcUrl: string;
  alchemyArcRpcUrl: string | null;
  isTestnet: boolean;

  // Market temperature
  marketSampleBlocks: number;
  marketEwmaAlpha: number;
  regimeHot: number;
  regimeCold: number;
  marketGain: number;

  // Population
  populationSize: number;
  populationSeedBase: number;
  populationSeeds: number[];        // pre-computed per-fly seeds (base + i*7919)
  ticksPerCron: number;
  simStepsPerTick: number;
  /** Durable Objects the swarm is sharded across (1 = the single FlyStateDO, today's behaviour). */
  shardCount: number;

  // Stimulus
  stimulusCooldownSec: number;
  frontendOrigin: string;

  // Agent economy (x402)
  economy: {
    enabled: boolean;
    initialBalanceUsdc: number;
    basePriceUsdc: number;
    solvencyFloorUsdc: number;
    maxDealsPerTick: number;
    facilitatorMode: "simulated" | "onchain";
    // Real-money (onchain) secrets + safety rails — inert in simulated mode:
    mnemonic: string | null;
    facilitatorPk: string | null;
    realSpendEnabled: boolean;
    shadowOnly: boolean;
    dailyCapUsdc: number;
    perAgentDailyCapUsdc: number;
    maxDealUsdc: number;
    netMinBroadcastUsdc: number;
    netFlushTicks: number;
    gasPriceGwei: number | null;
    usdcEip712Name: string;
    usdcEip712Version: string;
  };

  // Connectome sizing (ts-lif)
  brainOpts: {
    nSensory?: number;
    nInterL1?: number;
    nInterL2?: number;
    nModulatory?: number;
    nMotorPerChannel?: number;
    density?: number;
  };
}

/** Positive integer count from an env var; undefined when absent/invalid so defaults apply */
function posCount(v: string | undefined): number | undefined {
  if (v == null || v.trim() === "") return undefined;
  const n = Math.floor(Number(v));
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

/** Fraction in (0,1] from an env var; undefined when absent/invalid so defaults apply */
function posFrac(v: string | undefined): number | undefined {
  if (v == null || v.trim() === "") return undefined;
  const n = Number(v);
  return Number.isFinite(n) && n > 0 && n <= 1 ? n : undefined;
}

export function loadConfig(env: Env): RuntimeConfig {
  const chainId = Number(env.CHAIN_ID || "5042002");
  const isTestnet = chainId !== 5042;

  const populationSize = clampInt(Number(env.POPULATION_SIZE || "24"), 1, 256);
  const populationSeedBase = Number(env.POPULATION_SEED_BASE || "42") >>> 0;
  // Prime step maximises connectome variance across the population
  const populationSeeds = Array.from({ length: populationSize }, (_, i) =>
    (populationSeedBase + i * 7919) >>> 0,
  );

  return {
    chainId,
    rpcUrl:
      env.RPC_URL ||
      (isTestnet ? "https://rpc.testnet.arc.io" : "https://rpc.mainnet.arc.io"),
    alchemyArcRpcUrl: (env.ALCHEMY_ARC_RPC_URL ?? "").trim() || null,
    isTestnet,

    marketSampleBlocks: clampInt(Number(env.MARKET_SAMPLE_BLOCKS || "16"), 2, 128),
    marketEwmaAlpha: clamp(Number(env.MARKET_EWMA_ALPHA || "0.08"), 0.001, 1),
    regimeHot: clamp(Number(env.REGIME_HOT || "0.66"), 0.05, 1),
    regimeCold: clamp(Number(env.REGIME_COLD || "0.33"), 0, 0.95),
    marketGain: clamp(Number(env.MARKET_GAIN || "3"), 0.2, 20),

    populationSize,
    populationSeedBase,
    populationSeeds,
    ticksPerCron: clampInt(Number(env.TICKS_PER_CRON || "6"), 1, 60),
    simStepsPerTick: Math.max(1, Number(env.SIM_STEPS_PER_TICK || "500")),
    // Shards are capped at the population size (one shard per fly is the finest useful split) and at
    // 64 (a sane ceiling on fan-out round-trips per cron). 1 ⇒ the single FlyStateDO, unchanged.
    shardCount: clampInt(Number(env.SHARD_COUNT || "1"), 1, Math.min(64, populationSize)),

    stimulusCooldownSec: Number(env.STIMULUS_COOLDOWN_SEC || "30"),
    frontendOrigin: env.FRONTEND_ORIGIN || "*",

    economy: {
      // On by default: the agent economy is the piece's headline capability. Set ECONOMY_ENABLED="false"
      // to fall back to the pure reactive population.
      enabled: (env.ECONOMY_ENABLED ?? "true").toLowerCase() !== "false",
      initialBalanceUsdc: clamp(Number(env.ECONOMY_INITIAL_BALANCE || "6"), 0.01, 1_000_000),
      basePriceUsdc: clamp(Number(env.ECONOMY_BASE_PRICE || "0.002"), 0.000001, 100),
      solvencyFloorUsdc: clamp(Number(env.ECONOMY_SOLVENCY_FLOOR || "0.5"), 0, 10_000),
      // Default budget = one deal per fly per tick at most.
      maxDealsPerTick: clampInt(Number(env.ECONOMY_MAX_DEALS || String(populationSize)), 0, 4096),
      facilitatorMode: env.ECONOMY_FACILITATOR === "onchain" ? "onchain" : "simulated",
      // --- real-money rails; ALL inert unless facilitatorMode === "onchain" AND a mnemonic is present ---
      mnemonic: (env.ECONOMY_MNEMONIC ?? "").trim() || null,
      facilitatorPk: (env.ECONOMY_FACILITATOR_PK ?? "").trim() || null,
      realSpendEnabled: (env.ECONOMY_REAL_SPEND ?? "true").toLowerCase() !== "false",
      shadowOnly: (env.ECONOMY_SHADOW ?? "false").toLowerCase() === "true",
      dailyCapUsdc: clamp(Number(env.ECONOMY_DAILY_CAP ?? "20"), 0, 1_000_000),
      perAgentDailyCapUsdc: clamp(Number(env.ECONOMY_PER_AGENT_DAILY_CAP ?? "2"), 0, 1_000_000),
      maxDealUsdc: clamp(Number(env.ECONOMY_MAX_DEAL ?? "0.05"), 0, 100_000),
      netMinBroadcastUsdc: clamp(Number(env.ECONOMY_NET_MIN_BROADCAST ?? "0.004"), 0, 100_000),
      netFlushTicks: clampInt(Number(env.ECONOMY_NET_FLUSH_TICKS ?? "30"), 0, 100_000),
      gasPriceGwei: env.ECONOMY_GAS_PRICE_GWEI?.trim()
        ? clamp(Number(env.ECONOMY_GAS_PRICE_GWEI), 0.000001, 100_000)
        : null,
      usdcEip712Name: env.ECONOMY_USDC_EIP712_NAME || "USDC",
      usdcEip712Version: env.ECONOMY_USDC_EIP712_VERSION || "2",
    },

    brainOpts: {
      nSensory: posCount(env.BRAIN_N_SENSORY),
      nInterL1: posCount(env.BRAIN_N_INTER_L1),
      nInterL2: posCount(env.BRAIN_N_INTER_L2),
      nModulatory: posCount(env.BRAIN_N_MODULATORY),
      nMotorPerChannel: posCount(env.BRAIN_N_MOTOR_PER_CHANNEL),
      density: posFrac(env.BRAIN_DENSITY),
    },
  };
}

export function clamp(x: number, lo: number, hi: number): number {
  return x < lo ? lo : x > hi ? hi : x;
}

export function clampInt(x: number, lo: number, hi: number): number {
  if (!Number.isFinite(x)) return lo;
  return Math.max(lo, Math.min(hi, Math.floor(x)));
}

/**
 * Deterministic shard layout — a contiguous, ascending slice of fly ids. Both the coordinator (to fan
 * out + route per-fly reads) and each FlyShardDO (to know which flies it owns) derive the SAME slice
 * from (populationSize, shardCount), so no shard map ever needs to be stored or shipped.
 * Flies per shard = ceil(size / shardCount); the last shard may hold fewer (or none if evenly divided).
 */
export function fliesPerShard(populationSize: number, shardCount: number): number {
  return Math.max(1, Math.ceil(populationSize / Math.max(1, shardCount)));
}

/** Half-open [start, end) range of fly ids owned by shard `k`. */
export function shardSlice(
  populationSize: number,
  shardCount: number,
  k: number,
): { start: number; end: number } {
  const per = fliesPerShard(populationSize, shardCount);
  const start = Math.min(populationSize, k * per);
  const end = Math.min(populationSize, start + per);
  return { start, end };
}

/** Index of the shard that owns `flyId` (clamped so an out-of-range id never yields a bad shard). */
export function shardOf(
  populationSize: number,
  shardCount: number,
  flyId: number,
): number {
  const per = fliesPerShard(populationSize, shardCount);
  return Math.max(0, Math.min(Math.max(1, shardCount) - 1, Math.floor(flyId / per)));
}
