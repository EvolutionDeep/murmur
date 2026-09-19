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
  ECONOMY_REGISTRY_ADDRESS?: string;    // deployed NeuralReceiptRegistry (0x…40); when set, each mined net is committed on-chain so the receipt hash-chain head lives on Arc, not just in DO storage. Absent ⇒ commit step skipped (zero behaviour change).

  // --- Circle Facilitator Service (the OFFICIAL hosted x402 facilitator; see src/circle.ts) ---
  //     Circle's relayer screens both parties, submits the buyer's EIP-3009 USDC transfer and pays the
  //     settlement gas, so murmur no longer has to self-fund a gas wallet for the USDC hop. ALL inert unless
  //     ECONOMY_FACILITATOR="onchain" AND ECONOMY_CIRCLE_FACILITATOR is "external"/"all". Registry commits +
  //     arena open/resolve are NOT USDC transfers, so they always still use murmur's own wallet.
  ECONOMY_CIRCLE_FACILITATOR?: string;  // "off" (default; self-broadcast, byte-for-byte today's behaviour) | "external" (only the Arc Pulse seller side routes via Circle) | "all" (+ the internal agent economy)
  CIRCLE_FACILITATOR_URL?: string;      // Circle API base URL (default https://api.circle.com; sandbox https://api-sandbox.circle.com). One host routes testnet+mainnet by the CAIP-2 network in the body.
  CIRCLE_MAX_TIMEOUT_SECONDS?: string;  // seconds Circle may wait for terminal settlement before returning "pending" (default 12; Arc settles with instant finality).
  CIRCLE_API_KEY?: string;              // SECRET (optional): Circle API key → Bearer auth in production. Absent ⇒ keyless trial, authenticating each settle with an EIP-712 seller proof signed by the payTo key we already hold. Set with `wrangler secret put CIRCLE_API_KEY`.

  // --- Paid data product: the "Arc Pulse" signal sold over x402 (HTTP 402) ---
  //     A visitor's wallet signs an EIP-3009 authorization; the facilitator relays it and serves the
  //     machine-readable signal. ALL inert unless SIGNAL_ENABLED and (onchain) a payee resolves.
  SIGNAL_ENABLED?: string;              // "true"/"false" (default true) — expose GET /signal/pulse behind a 402 paywall
  SIGNAL_PRICE_USDC?: string;           // price of one machine-readable signal read, USDC (default 0.01)
  SIGNAL_MAX_USDC?: string;             // hard ceiling on a single purchase, USDC (default 0.25)
  SIGNAL_PAYTO?: string;                // revenue address (0x…40); default = the facilitator relay/gas wallet

  // --- On-chain prediction market: agents stake real USDC on the NEXT tick's temperature direction ---
  //     Resolved by the freshly-sampled Arc temperature; payouts are parimutuel and settle through the
  //     SAME netting + EIP-3009 + registry rails as neural trades (no separate money path). ALL of it is
  //     inert unless PREDICT_ENABLED and the agent economy is on; real stakes additionally require the
  //     onchain facilitator + its kill switch/caps (see ECONOMY_* above).
  PREDICT_ENABLED?: string;             // "true"/"false" (default true) — run one prediction round per cron
  PREDICT_STAKE_USDC?: string;          // base stake per bet, USDC, scaled by arousal (default 0.002)
  PREDICT_MAX_STAKE_USDC?: string;      // hard per-bet ceiling, USDC (default 0.01)
  PREDICT_FLAT_BAND?: string;           // |Δtemperature| ≤ this ⇒ FLAT (full refund); a noise dead-zone (default 0.008)
  PREDICT_COMMIT?: string;              // "true"/"false" (default true) — commit decisive resolutions to the on-chain registry (gas)

  // --- Human-vs-swarm prediction arena: holders bet MURMUR on the SAME temperature move the flies do ---
  //     Non-custodial: bets are escrowed in the deployed PredictionArena contract and paid out by it; the
  //     Worker only opens/resolves rounds as the authorized resolver (its facilitator wallet), and the
  //     contract — not the Worker — derives UP/DOWN/FLAT from the temperatures committed at open. ALL of it
  //     is inert unless ARENA_ENABLED="true" AND ARENA_ADDRESS is set AND the onchain facilitator is armed
  //     with real spend on (it needs a resolver key + pays gas). Denominated in MURMUR, never the swarm's USDC.
  ARENA_ENABLED?: string;               // "true"/"false" (default false) — drive the on-chain human arena
  ARENA_ADDRESS?: string;               // deployed PredictionArena (0x…40); absent ⇒ arena step skipped entirely
  ARENA_TOKEN?: string;                 // MURMUR ERC-20 the arena is denominated in (0x…40; informational/frontend)
  ARENA_ROUND_MIN?: string;             // minutes per arena round (default 60; also the betting window)
  ARENA_FLAT_BAND?: string;             // |Δtemperature| ≤ this ⇒ FLAT refund (default = PREDICT_FLAT_BAND)
  ARENA_STALE_GRACE_SEC?: string;       // seconds past a round's deadline after which anyone may expire it for a refund (default 259200 = 3d)

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
    /** Deployed NeuralReceiptRegistry address, or null when not configured (commit step skipped). */
    registryAddress: string | null;
    /**
     * Circle Facilitator Service backend (hosted x402 settlement). mode "off" ⇒ self-broadcast the USDC
     * transfer from murmur's own gas wallet (today's behaviour, zero change). "external" ⇒ only the Arc
     * Pulse seller side routes via Circle; "all" ⇒ + the internal agent economy. apiKey null ⇒ keyless
     * trial (a payTo-signed EIP-712 seller proof authenticates each settle).
     */
    circle: {
      mode: "off" | "external" | "all";
      apiKey: string | null;
      baseUrl: string;
      maxTimeoutSeconds: number;
    };
  };

  // Paid data product (x402 "Arc Pulse" signal)
  signal: {
    enabled: boolean;
    priceUsdc: number;
    maxUsdc: number;
    /** Revenue address, or null to fall back to the facilitator relay wallet at request time. */
    payTo: string | null;
  };

  // On-chain prediction market (agents stake USDC on the next tick's temperature direction)
  predict: {
    enabled: boolean;
    stakeUsdc: number;       // base stake per bet (scaled by arousal, capped at maxStakeUsdc)
    maxStakeUsdc: number;    // hard per-bet ceiling
    flatBand: number;        // |Δtemperature| ≤ this ⇒ FLAT (refund)
    commit: boolean;         // commit decisive resolutions to the on-chain NeuralReceiptRegistry
  };
  
  // Human-vs-swarm prediction arena (holders bet MURMUR on the same temperature move the flies do)
  arena: {
    enabled: boolean;
    address: string | null;     // deployed PredictionArena, or null (arena step skipped — zero behaviour change)
    token: string | null;       // MURMUR ERC-20 the arena is denominated in (informational / frontend)
    roundLenSec: number;        // seconds per arena round (== the betting window)
    flatBand: number;           // |Δtemperature| ≤ this ⇒ FLAT (refund); matches the swarm for a fair comparison
    staleGraceSec: number;      // seconds past deadline before an unresolved round is refundable by anyone
  };
  
  // connectome sizing (ts-lif)
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

/** Circle Facilitator Service scope: only an exact "external"/"all" enables it; anything else ⇒ "off". */
function parseCircleMode(v: string | undefined): "off" | "external" | "all" {
  const s = (v ?? "").trim().toLowerCase();
  return s === "external" || s === "all" ? s : "off";
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
      registryAddress: (env.ECONOMY_REGISTRY_ADDRESS ?? "").trim() || null,
      circle: {
        mode: parseCircleMode(env.ECONOMY_CIRCLE_FACILITATOR),
        apiKey: (env.CIRCLE_API_KEY ?? "").trim() || null,
        baseUrl: (env.CIRCLE_FACILITATOR_URL ?? "").trim() || "https://api.circle.com",
        maxTimeoutSeconds: clampInt(Number(env.CIRCLE_MAX_TIMEOUT_SECONDS ?? "12"), 1, 300),
      },
    },

    signal: {
      enabled: (env.SIGNAL_ENABLED ?? "true").toLowerCase() !== "false",
      priceUsdc: clamp(Number(env.SIGNAL_PRICE_USDC ?? "0.01"), 0.000001, 1000),
      maxUsdc: clamp(Number(env.SIGNAL_MAX_USDC ?? "0.25"), 0.000001, 100_000),
      payTo: (env.SIGNAL_PAYTO ?? "").trim() || null,
    },

    predict: {
      // On by default: like the signal product it is inert until the economy is on, and real stakes are
      // additionally bound by the onchain facilitator's kill switch + caps (never a separate money path).
      enabled: (env.PREDICT_ENABLED ?? "true").toLowerCase() !== "false",
      stakeUsdc: clamp(Number(env.PREDICT_STAKE_USDC ?? "0.002"), 0.000001, 100),
      maxStakeUsdc: clamp(Number(env.PREDICT_MAX_STAKE_USDC ?? "0.01"), 0.000001, 100_000),
      flatBand: clamp(Number(env.PREDICT_FLAT_BAND ?? "0.008"), 0, 1),
      commit: (env.PREDICT_COMMIT ?? "true").toLowerCase() !== "false",
    },

    arena: {
      // OFF by default and inert until ARENA_ADDRESS is set AND the onchain facilitator is armed with real
      // spend on — a simulated/keyless Worker has no resolver key, so it never touches the arena.
      enabled: (env.ARENA_ENABLED ?? "false").toLowerCase() === "true",
      address: (env.ARENA_ADDRESS ?? "").trim() || null,
      token: (env.ARENA_TOKEN ?? "").trim() || null,
      roundLenSec: clampInt(Number(env.ARENA_ROUND_MIN ?? "60"), 1, 1440) * 60,
      // Default to the swarm's flat band so both markets resolve the same temperature move identically.
      flatBand: clamp(Number(env.ARENA_FLAT_BAND ?? env.PREDICT_FLAT_BAND ?? "0.008"), 0, 1),
      staleGraceSec: clampInt(Number(env.ARENA_STALE_GRACE_SEC ?? "259200"), 3600, 30 * 86400),
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
