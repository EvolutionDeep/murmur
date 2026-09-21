// Environment / Vars types + runtime config for the murmur Worker.
//
// murmur OBSERVES Arc whole-chain activity, derives a "market temperature" (HOT / CALM / COLD), and
// drives a population of LIF-neuron flies whose collective + individual reactions are visualised. On
// top of that reactive layer sits an agent economy: the Worker READS Arc for the temperature and, when
// the onchain facilitator is armed with a mnemonic secret, WRITES real EIP-3009 USDC transfers between
// the agents. With no mnemonic it runs a keyless simulated ledger and moves nothing (see state.ts).

import { parseUnits } from "viem";

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
  EVOLUTION_MAX_LIVE_POPULATION?: string; // live-population growth ceiling (default = POPULATION_SIZE = no growth). ALSO the STABLE basis for shard slices, so raising it MUST be paired with SHARD_COUNT = ceil(cap/2) to keep 2 flies/shard (no brain ever migrates as the population grows).

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
  MANIFEST_REGISTRY_ADDRESS?: string;   // deployed NeuralManifestRegistry (0x…40); when set, GET /manifest reports it so anyone can read the committed brain-manifest hash off Arc and replay the connectomes offline (trustless "prove the brain"). Absent ⇒ the manifest is still served + replayable, just not anchored on-chain yet (zero behaviour change).
  LINEAGE_ADDRESS?: string;             // deployed ConnectomeLineage (0x…40); when set, each bred connectome genome is committed on-chain (best-effort) so its ancestry is a public, tamper-evident fact. Absent ⇒ the lineage store + /lineage endpoints still work, just not anchored on-chain yet (zero behaviour change).

  // --- Circle Facilitator Service (the OFFICIAL hosted x402 facilitator; see src/circle.ts) ---
  //     Circle's relayer screens both parties, submits the buyer's EIP-3009 USDC transfer and pays the
  //     settlement gas, so murmur no longer has to self-fund a gas wallet for the USDC hop. ALL inert unless
  //     ECONOMY_FACILITATOR="onchain" AND ECONOMY_CIRCLE_FACILITATOR is "external"/"all". Registry commits +
  //     arena open/resolve are NOT USDC transfers, so they always still use murmur's own wallet.
  ECONOMY_CIRCLE_FACILITATOR?: string;  // "off" (default; self-broadcast, byte-for-byte today's behaviour) | "external" (only the Arc Pulse seller side routes via Circle) | "all" (+ the internal agent economy)
  CIRCLE_FACILITATOR_URL?: string;      // Circle API base URL (default https://api.circle.com; sandbox https://api-sandbox.circle.com). One host routes testnet+mainnet by the CAIP-2 network in the body.
  CIRCLE_MAX_TIMEOUT_SECONDS?: string;  // seconds Circle may wait for terminal settlement before returning "pending" (default 12; Arc settles with instant finality).
  CIRCLE_API_KEY?: string;              // SECRET (optional): Circle API key → Bearer auth in production. Absent ⇒ keyless trial, authenticating each settle with an EIP-712 seller proof signed by the payTo key we already hold. Set with `wrangler secret put CIRCLE_API_KEY`.

  // --- Trustless receipt availability: pin each neural receipt BODY to IPFS (see src/ipfs.ts) ---
  //     The receipt HASH is already committed on-chain (EIP-3009 nonce + registry); pinning the BODY lets
  //     anyone fetch it from a content-addressed gateway and confirm sha256(body)==receiptHash with NO murmur
  //     server in the loop. ALL inert unless IPFS_PINNER="pinata" AND PINATA_JWT is set, and best-effort, so a
  //     pin failure never blocks, delays, or invalidates a settlement.
  IPFS_PINNER?: string;                 // "off" (default; no pinning, byte-for-byte today's behaviour) | "pinata" (pin each mined net receipt body)
  PINATA_JWT?: string;                  // SECRET (optional): Pinata API JWT → Bearer auth for pinning. Set with `wrangler secret put PINATA_JWT`.
  IPFS_GATEWAY?: string;                // public gateway the frontend fetches pinned bodies from (default https://ipfs.io)

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

  // --- On-chain house WAR + TAXATION: feuding houses stake real USDC in a dedicated coffer; every house pays an EXTRA on-chain tax ---
  //     A dedicated WarCoffer contract escrows REAL USDC per house vault and settles both the war payout and the
  //     tax levy ITSELF. The winner is derived IN-CONTRACT from the powers committed at declare (the resolver
  //     supplies nothing at resolve, so it cannot steer a result). ALL of it is inert unless WAR_ENABLED="true"
  //     AND WAR_ADDRESS + WAR_TREASURY are set AND the onchain facilitator is armed with real spend on (it moves
  //     real USDC + pays gas). Bounded stake only — whole-vault annexation is a deliberate non-goal of this layer.
  WAR_ENABLED?: string;                 // "true"/"false" (default false) — drive the on-chain war + tax coffer
  WAR_ADDRESS?: string;                 // deployed WarCoffer (0x…40); absent ⇒ the war step is skipped entirely
  WAR_USDC?: string;                    // the escrowed ERC-20 (default = the Arc USDC precompile 0x3600..0000)
  WAR_TREASURY?: string;               // the wallet whose USDC backs house vaults (REQUIRED; absent ⇒ step skipped)
  WAR_STAKE_PCT?: string;               // fraction of the smaller vault posted by EACH side (default 0.05)
  WAR_MIN_VAULT_USDC?: string;          // both houses need at least this on-chain vault to feud (default 1)
  WAR_PER_WAR_CAP_USDC?: string;        // hard ceiling on one side's stake regardless of vault size (default 5)
  WAR_MAX_ESCROW_USDC?: string;         // ceiling the Worker tops vaults up to; must be <= the coffer's on-chain hard cap (default 50)
  WAR_CADENCE_SEC?: string;             // seconds per war bucket == the commit/resolve window + the per-pair cooldown (default 3600)
  WAR_FEUD_THRESHOLD?: string;          // a cross-house bond <= this (negative) may go to war (default -0.6)
  WAR_TAX_PCT?: string;                 // fraction of a house vault levied as EXTRA on-chain tax per cron (default 0.01)
  WAR_TAX_DEST?: string;                // "coffer" (commons purse, default) | "dominant" (sweep to the wealthiest house)

  // --- Autonomous evolution: profitable agents self-fund breeding from their OWN wallets ---
  //     Each cron, the top agents by realized PnL (netUsdc>0) may autonomously initiate a mutate/cross over
  //     the SAME x402/EIP-3009 rails, paying the breeding fee from the parent's own HD wallet (the
  //     facilitator only relays gas). Offspring enter the on-chain lineage market (breeder = the paying
  //     parent's address); they do NOT join the live trading population (the 24-fly manifest stays fixed).
  //     ALL inert unless EVOLUTION_ENABLED="true" AND EVOLUTION_TREASURY is set AND the onchain facilitator
  //     is armed with real spend on (it moves real USDC + pays gas). Denominated in the swarm's USDC.
  EVOLUTION_ENABLED?: string;           // "true"/"false" (default false) — run the autonomous evolution step
  EVOLUTION_TREASURY?: string;          // revenue address (0x…40) collecting each breeding fee; REQUIRED (absent ⇒ step skipped)
  EVOLUTION_FEE_USDC?: string;          // breeding fee per offspring, USDC, paid by the parent (default 0.002)
  EVOLUTION_MAX_PER_CRON?: string;      // max offspring bred per cron tick (default 1; bounds CPU + spend)
  EVOLUTION_PER_AGENT_DAILY?: string;   // max offspring one agent may fund per UTC day (default 1)
  EVOLUTION_GLOBAL_DAILY?: string;      // max offspring bred per UTC day across the swarm (default 4)
  EVOLUTION_CROSS_BIAS?: string;        // 0..1 — with ≥2 eligible, P(cross top-2) else mutate top-1 (default 0.5)
  EVOLUTION_HATCH_LIVE?: string;        // "true"/"false" (default false) — hatch each bred offspring into a LIVE trading fly (grows the population up to EVOLUTION_MAX_LIVE_POPULATION) instead of lineage-only. Inert unless evolution is already armed (onchain + real spend); the parent self-funds the child's opening balance via EVOLUTION_HATCH_SEED_USDC.
  EVOLUTION_HATCH_SEED_USDC?: string;   // parent→child bootstrap transferred to the offspring's OWN HD wallet on hatch, USDC (default 0.002); bounded by the same kill switch + daily caps as the breeding fee, and only ever moved once (a MINED transfer is what founds the live child).
  POP_LIVE_RETIRE?: string;             // "true"/"false" (default TRUE) — when a fly dies, RETIRE it from the live swarm (free its id/slot/shard brain) so the population reflects ONLY the living and a dead fly never holds a breeding slot. Reuses the vacated id (and its HD wallet + shard slice) for the next hatch, tombstoned so a cold boot can't resurrect the dead founder. false ⇒ the old behaviour: deaths close a wallet only, roster never shrinks, ids never recycle. Rollback switch.
  LAW_ENABLED?: string;                 // "true"/"false" (default TRUE) — ⑧ THE COMMONS: at each NEW era a deterministic assembly is convened from the swarm's own read-out condition (standing + stake of its wealthiest/honoured living flies) and votes — a pure function of (era, address, hashes) — to nudge TWO bounded institution knobs (the credit line and its interest). ECONOMIC-SIDE ONLY: it re-prices credit the economy already reads, moves no money and touches no neuron. A sub-switch of INSTITUTIONS — false (or institutions off) ⇒ no assembly, effective ≡ base config, byte-for-byte today.
  LAW_ASSEMBLY_SIZE?: string;           // seats in the commons (default 7; clamped 2..16 and to the living population).
  LAW_CREDIT_CAP_BAND?: string;         // "min,max" USDC the assembly may legislate the base credit line into (default "0.01,0.2"); a HARD clamp so self-legislation can never crash the ledger or mint.
  LAW_IOU_RATE_BAND?: string;           // "min,max" the assembly may legislate iouRatePer10 into (default "0,0.05"); a HARD clamp on interest.
  DYNASTY_ENABLED?: string;             // "true"/"false" (default TRUE) — dynasty layer: houses (inherited names + sigils + tithe treasury) and mortality (penury / old-age / plague deaths with estate inheritance). Economic-ledger ONLY — it never touches the connectome, the shards or the live population; false restores the pre-dynasty economy byte-for-byte.
  CULTURE_ENABLED?: string;             // "true"/"false" (default TRUE) — Lamarckian culture layer: feeding-cohort FAP-creed contagion with bounded TTL, house traditions as breakwaters. Overrides the decoded READ-OUT line only (fap/role), before the snapshot + economy ever see it — the connectome, genomes and manifests never notice; false restores today's readings byte-for-byte.
  INSTITUTIONS_ENABLED?: string;        // "true"/"false" (default TRUE) — institutions layer ⑥: deterministic aggregate limit books (per-tick 4×2 ladder, deals CROSS the book, marks persist), sticky professions, IOU credit + runs, class read-out. Economic-side ONLY (behaviour→economy stays one-way); false restores the fixed-formula economy byte-for-byte.
    EPOCHS_ENABLED?: string;              // "true"/"false" (default TRUE) — epochs layer ⑦: the historian's shock detector force-opens a new era on a FAMINE/PLAGERA/BOOM/GREAT_HUDDLE/DYNASTIC, or on a governance-injected miracle/cataclysm. PURE READ-OUT of existing state (never feeds back); false leaves only the slow regime-driven era logic of today.
  CREDIT_CAP_BASE_USDC?: string;        // base IOU credit line per fly, USDC (default 0.05; traders double it, reputation scales up to 3×). SIMULATED LEDGER ONLY — onchain balances have no offline credit. Bounded 0..1000 (0 ⇒ credit off, books stay).
  IOU_RATE_PER_10TICK?: string;         // interest charged per 10 sub-ticks on live IOUs (default 0.002, i.e. 0.2% per 10 ticks; cap 0.2). Interest accrues to at most 50% of principal before a note is delinquent.

  // --- Community governance page (off-chain, token-gated forum + weighted voting; D1-backed) ---
  //     A standalone /community page: anyone may browse, but posting / proposing / voting requires a wallet
  //     EIP-712 signature AND a SERVER-SIDE balanceOf(author) check against the MURMUR token — the front-end
  //     gate is UX only, never a security boundary. Read-only on-chain (balanceOf) + D1 writes; it NEVER signs
  //     a transfer or touches the treasury, so its risk surface is far below the settlement layer. ALL inert
  //     unless COMMUNITY_ENABLED="true".
  COMMUNITY_ENABLED?: string;               // "true"/"false" (default false) — serve the /community* endpoints
  COMMUNITY_TOKEN?: string;                 // MURMUR ERC-20 the gate is denominated in (0x…40; default = ARENA_TOKEN)
  COMMUNITY_SPEAK_MIN?: string;             // min MURMUR balance to post / reply / vote (human units, default 50000)
  COMMUNITY_PROPOSE_MIN?: string;           // min MURMUR balance to open a proposal (human units, default 1000000)
  COMMUNITY_PROPOSAL_WINDOW_HOURS?: string; // hours a proposal stays open for voting (default 72)
  COMMUNITY_POST_COOLDOWN_SEC?: string;     // anti-spam: seconds between posts by one address (default 60)

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
  /**
   * Live-population growth ceiling (>= populationSize). The manifest/genesis population stays fixed at
   * populationSize; hatched offspring grow the LIVE trading population up to this cap. ALSO the STABLE
   * basis for shard slices (shardSlice/shardOf/fliesPerShard derive from THIS, not the current live
   * count), so an id's owning shard never changes as the population grows — no brain ever migrates.
   */
  maxLivePopulation: number;
  /**
   * Live-population RETIREMENT (POP_LIVE_RETIRE, default TRUE): when a fly dies it is removed from the
   * swarm roster (freeing its id + HD wallet + shard brain), so size()/aliveCount track ONLY the living
   * and a dead fly never squats a breeding slot. The vacated id is reused by the next hatch; the dead are
   * tombstoned so a cold boot can't resurrect a retired founder. false ⇒ legacy behaviour (deaths close a
   * wallet only; roster is monotonic; ids never recycle). Independent of hatchLive — retire just shrinks
   * the live set; hatching refills it from the lowest vacant id.
   */
  liveRetire: boolean;

  // Stimulus
  stimulusCooldownSec: number;
  frontendOrigin: string;
  /** Deployed NeuralManifestRegistry address (the brain-manifest on-chain anchor), or null when not configured. */
  manifestRegistryAddress: string | null;
  /** Deployed ConnectomeLineage address (the breeding-market on-chain ancestry anchor), or null when not configured. */
  lineageAddress: string | null;

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
    /**
     * Trustless receipt-body availability. pinner "off" ⇒ no pinning (today's behaviour, zero change).
     * "pinata" + a JWT ⇒ each mined net receipt's canonical body is pinned to IPFS (best-effort) and its CID
     * published via /proofs, so anyone can fetch the body and check sha256(body)==the on-chain receiptHash
     * without trusting murmur. gateway is the public IPFS gateway the frontend reads pinned bodies from.
     */
    ipfs: {
      pinner: "off" | "pinata";
      jwt: string | null;
      gateway: string;
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

  // On-chain house war + taxation (a dedicated WarCoffer escrows real USDC per house vault; the coffer
  // derives the war winner itself and levies an extra on-chain tax beyond the internal 2% tithe).
  war: {
    enabled: boolean;
    address: string | null;      // deployed WarCoffer, or null (war step skipped — zero behaviour change)
    usdc: string;                // the escrowed ERC-20 (default = the Arc USDC precompile)
    treasury: string | null;     // the wallet whose USDC backs vaults; null ⇒ the whole step is skipped
    stakePct: number;            // fraction of the smaller vault posted by EACH side
    minVaultUsdc: number;        // both houses need at least this on-chain vault to feud
    perWarCapUsdc: number;       // hard ceiling on one side's stake
    maxEscrowUsdc: number;       // the Worker's own top-up ceiling (must be <= the coffer's on-chain cap)
    warCadenceSec: number;       // seconds per war bucket (== the commit window + per-pair cooldown)
    feudThreshold: number;       // cross-house bond <= this (negative) may go to war
    taxPct: number;              // fraction of a house vault levied as extra on-chain tax per cron
    taxDest: "coffer" | "dominant";  // commons purse, or swept to the dominant house
  };

  // Community governance page (off-chain token-gated forum + weighted voting; D1-backed, read-only on-chain)
  community: {
    enabled: boolean;
    token: string | null;       // MURMUR ERC-20 the gate is denominated in (defaults to arena.token)
    speakMinRaw: bigint;        // min balance (raw, 18dp) to post / reply / vote
    proposeMinRaw: bigint;      // min balance (raw, 18dp) to open a proposal
    windowMs: number;           // how long a proposal stays open for voting (ms)
    cooldownSec: number;        // anti-spam: min seconds between posts by one address
    chainId: number;            // EIP-712 domain chainId (== the configured Arc chain)
  };

  // Autonomous evolution (profitable agents self-fund breeding from their own wallets)
  evolution: {
    enabled: boolean;
    feeUsdc: number;          // breeding fee per offspring, paid by the parent from its own wallet
    maxPerCron: number;       // max offspring bred per cron tick
    perAgentDaily: number;    // max offspring one agent may fund per UTC day
    globalDaily: number;      // max offspring bred per UTC day across the swarm
    crossBias: number;        // 0..1 — P(cross top-2) when ≥2 eligible, else mutate top-1
    hatchLive: boolean;       // hatch bred offspring into LIVE trading flies (grow to maxLivePopulation) vs lineage-only
    hatchSeedUsdc: number;    // parent→child bootstrap USDC transferred to the offspring's own wallet on hatch
    treasury: string | null;  // revenue address collecting each fee; null ⇒ step skipped entirely
  };

  // Dynasty (economic-ledger layer: houses/inheritance/death — purely downstream of the economy, the
  // swarm's liveness is population dynamics' alone, so this switch cannot change the population)
  dynasty: {
    enabled: boolean;         // master switch (default ON): house names/sigils/tithe + mortality/inheritance
  };

  // Culture (Lamarckian layer above the genome: contagion of FAP creeds in the feeding cohort, house
  // traditions as breakwaters). Pure read-out-line override — never the brain, never the ledger.
  culture: {
    enabled: boolean;         // master switch (default ON): false ⇒ every hook is a no-op, byte-for-byte today
  };

  // Institutions (layer ⑥: limit-book price discovery, professions, IOU credit, classes) — one
  // integrated switch for the whole economic-institution complex, so OFF is provably the old economy.
  institutions: {
    enabled: boolean;         // master switch (default ON): false ⇒ fixed-formula pricing, no jobs, no credit
    creditCapBaseUsdc: number; // base IOU line per fly (USDC); traders ×2, reputation up to ×3 more
    iouRatePer10: number;      // interest per 10 sub-ticks on live IOUs
  };

  // Epochs (layer ⑦): the historian's shock detector + governance-injected miracles/cataclysms. Pure
  // read-out of state already computed elsewhere; OFF leaves only today's slow regime-driven era logic.
  epochs: {
    enabled: boolean;         // master switch (default ON): false ⇒ the shock detectors never receive their signals
  };

  // The Commons (layer ⑧): fly self-legislation — a sub-switch of INSTITUTIONS. A pure read-out of the
  // economy/social state convenes a deterministic assembly at each new era which votes to nudge two
  // bounded credit knobs; the effective values are hard-clamped to the bands below and recomputed every
  // cron, so the layer never writes a neuron, never moves money, and never persists into the economy
  // payload (KEY_VERSION stays "economy:v1"). LAW_ENABLED=false ⇒ effective ≡ base config, byte-for-byte.
  law: {
    enabled: boolean;         // master switch (default ON)
    assemblySize: number;     // seats (default 7, clamped)
    creditCapBandUsdc: [number, number];  // hard clamp on any legislated base credit line (USDC)
    iouRateBand: [number, number];        // hard clamp on any legislated interest rate
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

/**
 * Parse a human token amount (e.g. "50000") into raw bigint units at `decimals`; falls back to `def` on any
 * absent/invalid input so a malformed env var can never crash config load or silently zero a gate.
 */
function parseRawUnits(v: string | undefined, decimals: number, def: bigint): bigint {
  const s = (v ?? "").trim();
  if (!s) return def;
  try {
    return parseUnits(s, decimals);
  } catch {
    return def;
  }
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

  // Live-population growth ceiling (>= populationSize). ALSO the STABLE basis for shard slices, so the
  // shard count must cover it at <=2 flies/shard to keep every brain within the DO memory + 2 MB value limits.
  const maxLivePopulation = clampInt(
    Number(env.EVOLUTION_MAX_LIVE_POPULATION || String(populationSize)),
    populationSize,
    256,
  );
  // Shards are capped at the growth ceiling (one shard per fly is the finest useful split) and at 64 (a
  // sane ceiling on fan-out round-trips per cron). 1 ⇒ the single FlyStateDO, unchanged.
  const shardCount = clampInt(Number(env.SHARD_COUNT || "1"), 1, Math.min(64, maxLivePopulation));

  // HATCH GUARD: hatching grows the live population into slots the shards must ALREADY cover at <=2
  // flies/shard (the DO 128 MB heap + 2 MB value ceiling). If SHARD_COUNT wasn't raised to match the cap,
  // flies/shard would exceed 2 and a shard could OOM / overflow — so refuse to hatch (breeding stays
  // lineage-only, exactly today's behaviour) rather than risk a live fly that can't be safely hosted.
  const hatchLiveRequested = (env.EVOLUTION_HATCH_LIVE ?? "false").toLowerCase() === "true";
  const fliesPerShardAtCap = fliesPerShard(maxLivePopulation, shardCount);
  const hatchLive = hatchLiveRequested && fliesPerShardAtCap <= 2;
  // LIVE-RETIRE (POP_LIVE_RETIRE, default TRUE). Independent of hatchLive: retiring the dead always keeps
  // size()/aliveCount honest about who is actually alive; the freed slots simply become available again.
  const liveRetire = (env.POP_LIVE_RETIRE ?? "true").toLowerCase() !== "false";
  if (hatchLiveRequested && !hatchLive) {
    console.error(
      `[config] EVOLUTION_HATCH_LIVE ignored: need SHARD_COUNT >= ceil(cap/2) so flies/shard <= 2 ` +
        `(have cap=${maxLivePopulation}, shards=${shardCount}, flies/shard=${fliesPerShardAtCap}). ` +
        `Breeding stays lineage-only.`,
    );
  }

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
    shardCount,
    maxLivePopulation,
    liveRetire,

    stimulusCooldownSec: Number(env.STIMULUS_COOLDOWN_SEC || "30"),
    frontendOrigin: env.FRONTEND_ORIGIN || "*",
    manifestRegistryAddress: (env.MANIFEST_REGISTRY_ADDRESS ?? "").trim() || null,
    lineageAddress: (env.LINEAGE_ADDRESS ?? "").trim() || null,

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
      ipfs: {
        pinner: (env.IPFS_PINNER ?? "").trim().toLowerCase() === "pinata" ? "pinata" : "off",
        jwt: (env.PINATA_JWT ?? "").trim() || null,
        gateway: (env.IPFS_GATEWAY ?? "").trim() || "https://ipfs.io",
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

    war: {
      // OFF by default and inert until BOTH WAR_ADDRESS and WAR_TREASURY are set AND the onchain facilitator
      // is armed with real spend on — a simulated/keyless Worker has no vault-funding wallet, so it never moves
      // the escrow. The step is additionally gated in state.ts on the same master rails as the arena.
      enabled: (env.WAR_ENABLED ?? "false").toLowerCase() === "true",
      address: (env.WAR_ADDRESS ?? "").trim() || null,
      // The Arc USDC precompile (6-dec FiatTokenV2) is the default escrow asset; override for a drill chain.
      usdc: (env.WAR_USDC ?? "").trim() || "0x3600000000000000000000000000000000000000",
      treasury: (env.WAR_TREASURY ?? "").trim() || null,
      stakePct: clamp(Number(env.WAR_STAKE_PCT ?? "0.05"), 0.0001, 1),
      minVaultUsdc: clamp(Number(env.WAR_MIN_VAULT_USDC ?? "1"), 0, 100_000),
      perWarCapUsdc: clamp(Number(env.WAR_PER_WAR_CAP_USDC ?? "5"), 0.0001, 100_000),
      maxEscrowUsdc: clamp(Number(env.WAR_MAX_ESCROW_USDC ?? "50"), 0.0001, 1_000_000),
      warCadenceSec: clampInt(Number(env.WAR_CADENCE_SEC ?? "3600"), 300, 7 * 86400),
      feudThreshold: clamp(Number(env.WAR_FEUD_THRESHOLD ?? "-0.6"), -1, 1),
      taxPct: clamp(Number(env.WAR_TAX_PCT ?? "0.01"), 0, 1),
      taxDest: (env.WAR_TAX_DEST ?? "").trim().toLowerCase() === "dominant" ? "dominant" : "coffer",
    },

    community: {
      // OFF by default and inert until COMMUNITY_ENABLED="true". Read-only on-chain (balanceOf) + D1 writes —
      // it never signs a transfer or touches the treasury, so its risk surface is far below the settlement layer.
      enabled: (env.COMMUNITY_ENABLED ?? "false").toLowerCase() === "true",
      // Default to the arena's MURMUR token so the gate is denominated in the project's own ERC-20.
      token: (env.COMMUNITY_TOKEN ?? "").trim() || (env.ARENA_TOKEN ?? "").trim() || null,
      speakMinRaw: parseRawUnits(env.COMMUNITY_SPEAK_MIN, 18, 50_000n * 10n ** 18n),
      proposeMinRaw: parseRawUnits(env.COMMUNITY_PROPOSE_MIN, 18, 1_000_000n * 10n ** 18n),
      windowMs: clampInt(Number(env.COMMUNITY_PROPOSAL_WINDOW_HOURS ?? "72"), 1, 24 * 30) * 3_600_000,
      cooldownSec: clampInt(Number(env.COMMUNITY_POST_COOLDOWN_SEC ?? "60"), 0, 86400),
      chainId,
    },

    evolution: {
      // OFF by default and inert until EVOLUTION_TREASURY is set AND the onchain facilitator is armed with
      // real spend on — it moves real USDC (the breeding fee) and pays gas, so a simulated/keyless Worker
      // never evolves. The step is additionally gated in state.ts on the same master rails as the arena.
      enabled: (env.EVOLUTION_ENABLED ?? "false").toLowerCase() === "true",
      treasury: (env.EVOLUTION_TREASURY ?? "").trim() || null,
      feeUsdc: clamp(Number(env.EVOLUTION_FEE_USDC ?? "0.002"), 0.000001, 100),
      maxPerCron: clampInt(Number(env.EVOLUTION_MAX_PER_CRON ?? "1"), 0, 64),
      perAgentDaily: clampInt(Number(env.EVOLUTION_PER_AGENT_DAILY ?? "1"), 0, 1000),
      globalDaily: clampInt(Number(env.EVOLUTION_GLOBAL_DAILY ?? "4"), 0, 1000),
      crossBias: clamp(Number(env.EVOLUTION_CROSS_BIAS ?? "0.5"), 0, 1),
      hatchLive,
      hatchSeedUsdc: clamp(Number(env.EVOLUTION_HATCH_SEED_USDC ?? "0.002"), 0.000001, 100),
    },

    dynasty: {
      // ON by default: with no houses and no deaths the ledger is still a ledger, but the dynasty layer
      // only MOVES money between wallets already in it and never mints, so there is nothing to gate behind
      // real money. Set DYNASTY_ENABLED=false to restore the pre-dynasty economy byte-for-byte.
      enabled: (env.DYNASTY_ENABLED ?? "true").toLowerCase() !== "false",
    },

    culture: {
      // ON by default: culture moves no money and touches no neuron — it only lets the swarm's decoded
      // readings catch fashions — so there is nothing riskier to gate than the ethogram read-out itself.
      // Set CULTURE_ENABLED=false to restore today's readings byte-for-byte.
      enabled: (env.CULTURE_ENABLED ?? "true").toLowerCase() !== "false",
    },

    institutions: {
      // ON by default: the book only re-prices deals the two flies already agreed to make, credit only
      // DEFERS settlement of money that later moves through the exact same x402 rails, and professions
      // scale economic intent — never a neuron. INSTITUTIONS_ENABLED=false ⇒ the pre-institution
      // fixed-formula economy byte-for-byte (the OFF path is also the permanent fallback).
      enabled: (env.INSTITUTIONS_ENABLED ?? "true").toLowerCase() !== "false",
      creditCapBaseUsdc: clamp(Number(env.CREDIT_CAP_BASE_USDC ?? "0.05"), 0, 1000),
      iouRatePer10: clamp(Number(env.IOU_RATE_PER_10TICK ?? "0.002"), 0, 0.2),
    },

    epochs: {
      // ON by default: the epoch detectors only NAME an age from state already on screen (a volume record,
      // a run of thin pulse-richness, a wave of burials, a house's grip) or from a passed governance vote.
      // EPOCHS_ENABLED=false ⇒ state.ts stops folding those signals into the historian, so era behaviour is
      // byte-for-byte today's slow regime drift.
      enabled: (env.EPOCHS_ENABLED ?? "true").toLowerCase() !== "false",
    },

    law: (() => {
      // ⑧ THE COMMONS. ON by default, but a SUB-SWITCH of institutions (state.ts convenes only when both
      // are on). The two bands are HARD clamps the assembly can never legislate past — the guard rail that
      // lets a society rewrite its own credit rules without ever being able to mint or crash its ledger.
      const band = (raw: string | undefined, def: [number, number], lo: number, hi: number): [number, number] => {
        if (!raw) return def;
        const parts = raw.split(",").map((x) => Number(x.trim()));
        const min = clamp(Number.isFinite(parts[0]) ? parts[0] : def[0], lo, hi);
        const max = clamp(Number.isFinite(parts[1]) ? parts[1] : def[1], lo, hi);
        return min <= max ? [min, max] : def;
      };
      const size = Math.round(Number(env.LAW_ASSEMBLY_SIZE ?? "7"));
      return {
        enabled: (env.LAW_ENABLED ?? "true").toLowerCase() !== "false",
        assemblySize: clamp(Number.isFinite(size) ? size : 7, 2, 16),
        creditCapBandUsdc: band(env.LAW_CREDIT_CAP_BAND, [0.01, 0.2], 0, 1000),
        iouRateBand: band(env.LAW_IOU_RATE_BAND, [0, 0.05], 0, 0.2),
      };
    })(),

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
 * from (size, shardCount), so no shard map ever needs to be stored or shipped.
 * Flies per shard = ceil(size / shardCount); the last shard may hold fewer (or none if evenly divided).
 *
 * IMPORTANT: callers pass the STABLE growth ceiling `maxLivePopulation` as `size`, NOT the current live
 * count. Deriving slices from a fixed ceiling means an id's owning shard never changes as offspring hatch
 * (ids fill pre-assigned slots), so no persisted brain ever migrates between shards. Slots above the
 * current live count simply stay empty until a hatch lands there.
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
