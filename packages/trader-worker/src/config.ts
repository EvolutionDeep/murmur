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
  NEUROMOD_GATING?: string;         // "true"/"false" (default false) — A3: let the DA/OA neuromodulatory read-out gate exploration/arousal in the decoder. OFF ⇒ the read-out is observed only and behaviour is byte-for-byte unchanged (dark deploy). Manifest-neutral either way.
  FLYWIRE_TOPOLOGY?: string;        // "true"/"false" (default false) — A2 online: use the REAL FAFB 783 FlyWire subgraph (10,361 neurons / 467k synapses) instead of the procedural PRNG generator. OFF ⇒ byte-for-byte the old buildConnectome path. When ON, genome operators mutate PARAMETERS (weight gain / threshold / tau) instead of layer sizes, and the topology is FIXED from the artifact. Manifest-affecting: rotates manifestHash (new structural spec). MUST stay false until shadow-verified + user-approved.
  FLYWIRE_ARTIFACT?: KVNamespace;     // KV namespace holding fafb783-mb-cx.bin.gz.b64 (1.32 MB). Only needed when FLYWIRE_TOPOLOGY=true.
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
  ECONOMY_EVOLUTION_SHADOW?: string;     // "true" = run shadow-compare (evolution decisions mirrored in parallel, never executed) (default "false") — SECRET: occupies one binding slot
  ECONOMY_DAILY_CAP?: string;           // global real-spend ceiling per UTC day, USDC (default 20; 0 = no cap)
  ECONOMY_PER_AGENT_DAILY_CAP?: string; // per-agent real-spend ceiling per UTC day, USDC (default 2; 0 = no cap)
  ECONOMY_MAX_DEAL?: string;            // facilitator hard per-deal ceiling, USDC (default 0.05)
  ECONOMY_NET_MIN_BROADCAST?: string;   // netting: min net USDC per pair before it is broadcast (dust carries; default 0.01)
  ECONOMY_NET_FLUSH_TICKS?: string;     // netting: force-flush any nonzero pending net at least every N sub-ticks (default 1440)
  ECONOMY_GAS_PRICE_GWEI?: string;      // pin the relay gas price in gwei (default: let viem estimate; Arc launched ~20)
  ECONOMY_USDC_EIP712_NAME?: string;    // EIP-712 domain name override (default "USDC" = the Arc precompile's name())
  ECONOMY_USDC_EIP712_VERSION?: string; // EIP-712 domain version override (default "2" = the precompile's version())
  ECONOMY_REGISTRY_ADDRESS?: string;    // deployed NeuralReceiptRegistry (0x…40); when set, each mined net is committed on-chain so the receipt hash-chain head lives on Arc, not just in DO storage. Absent ⇒ commit step skipped (zero behaviour change).
  MANIFEST_REGISTRY_ADDRESS?: string;   // deployed NeuralManifestRegistry (0x…40); when set, GET /manifest reports it so anyone can read the committed brain-manifest hash off Arc and replay the connectomes offline (trustless "prove the brain"). Absent ⇒ the manifest is still served + replayable, just not anchored on-chain yet (zero behaviour change).
  LINEAGE_ADDRESS?: string;             // deployed ConnectomeLineage (0x…40); when set, each bred connectome genome is committed on-chain (best-effort) so its ancestry is a public, tamper-evident fact. Absent ⇒ the lineage store + /lineage endpoints still work, just not anchored on-chain yet (zero behaviour change).
  POCA_REGISTRY_ADDRESS?: string;       // deployed ContinuityRegistry (0x…40) — the Proof-of-Continuous-Agency epoch anchor (openEpoch/sealEpoch/adminAction). Defaults in code to the deployed Arc-mainnet registry so a deploy never needs a wrangler [vars] key; set to the zero address to explicitly DISABLE the on-chain mirror (the OFF-CHAIN epoch chain always runs).

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

  // --- Arc Pulse refund rail (DARK DEPLOY: the code ships, the switch stays off in production) ---
  //     When enabled, a pulse purchase whose signal build throws AFTER payment settled gets a seller-funded
  //     EIP-3009 refund leg back to the buyer, recorded in a bounded on-DO ledger (GET /pulse/refunds).
  //     Default FALSE ⇒ behavior is byte-for-byte today's: the 502 stands and no refund wallet logic runs.
  //     NEVER set as a wrangler var in prod until the operator shadow-proves the rail (POST /pulse/refund-shadow).
  PULSE_REFUNDS?: string;               // "true" to arm the refund rail (anything else, incl. absent ⇒ off)

  // --- System One (Jev) read-out side-plane (DARK DEPLOY: default OFF; a pure read, never money/determinism) ---
  //     Jev (TypeSafe) turns the tick's read-out into typed probabilistic decisions (posture/mood/urgency/
  //     consistency/which-drawer). It is a SIDE-PLANE: its answer NEVER enters the connectome, genome,
  //     manifestHash, PoCA stateDigest, any balance/cap, or the settlement/estate/refund paths. When the switch
  //     is off OR no key is present, the client is inert, issues no request, and /economy ships NO jev key ⇒
  //     byte-for-byte today's build. ARMING THE LIVE CALL needs BOTH JEV_ENABLED="true" AND a JEV_API_KEY; the
  //     128-binding wall is currently full, so the operator must first evict a low-priority var before adding
  //     JEV_API_KEY/JEV_ENABLED as wrangler vars (code-defaults keep the off-state correct meanwhile; see memory).
  JEV_ENABLED?: string;                 // default FALSE (absent ⇒ inert). "true" arms the side-plane ONLY if a key is also present.
  JEV_API_KEY?: string;                 // SECRET (optional): Bearer token for api.typesafe.ai. Absent ⇒ no request even when enabled.
  JEV_BASE_URL?: string;                // default https://api.typesafe.ai (the /v1/systemone path is appended in code).
  JEV_MODEL?: string;                   // default jev-latest.
  JEV_TIMEOUT_MS?: string;              // hard wall-clock budget per call (default 900); expiry ⇒ degrade to null.

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

  // --- ⑲ THE BOURSE: MURMUR's on-chain life as a felt climate (read-only membrane + gated stimulus) ---
  //     One eth_getLogs per cron reads the token's Transfer events; the meter reduces them to a coin fever
  //     (EWMA baseline, the market.ts pattern) and edge-detects whale stirs / tithe milestones / long silences.
  //     Narration is gated by BOURSE_ENABLED; FEELING (the coinStimuli fold into the four visitor channels)
  //     is separately gated by TOKEN_STIMULUS_ENABLED. Both default OFF (dark deploy). No key, no custody,
  //     no spend — the argus-issued token contract and its tax wallet are only ever OBSERVED.
  BOURSE_ENABLED?: string;              // "true"/"false" (default false) — sample + narrate the coin climate
  BOURSE_TOKEN?: string;                // the ERC-20 to watch (default = the MURMUR CA); absent ⇒ the membrane is inert
  BOURSE_TAX_WALLET?: string;           // the argus tax wallet (legs INTO it are the tithe flow; absent ⇒ no tithe tracking)
  BOURSE_WHALE_MURMUR?: string;         // a single main leg ≥ this many whole MURMUR is a whale stir (default 1000000)
  BOURSE_LOOKBACK?: string;             // max blocks one sample may span; also the cold-start window (default 1200)
  BOURSE_TITHE_MILESTONE_MURMUR?: string; // cumulative tithe crossing every this-many MURMUR speaks a TITHE line (default 5000000)
  TOKEN_STIMULUS_ENABLED?: string;      // "true"/"false" (default false) — let the swarm FEEL the coin climate
  TOKEN_STIMULUS_MAX?: string;          // master ceiling on any one felt coin channel, 0..1 (default 0.35; 0 ⇒ nothing felt)

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
  WAR_BOOTSTRAP?: string;               // "true"/"false" (default false) — COLD-START: lift feudPairs' vault gate so driveWar funds the deepest feud's empty vaults from WAR_TREASURY (moves REAL USDC ≤ maxEscrow) and the first war can start; requires an explicit arm

  // --- Organic conflict: deterministic negative social events that let genuine feuds surface (all optional) ---
  // OFF by default ⇒ every conflict hook no-ops and houseFeuds stays a pure mean (byte-for-byte unchanged).
  CONFLICT_ENABLED?: string;            // "true"/"false" (default false) — enable rivalry/envy/embargo/raid grudges
  CONFLICT_RIVAL_STEP?: string;         // grudge per tick between houses competing in the same good's market (default 0.06)
  CONFLICT_ENVY_STEP?: string;          // max grudge a losing house takes toward the dominant house on a hot shock (default 0.10)
  CONFLICT_EMBARGO_STEP?: string;       // grievance accrued on a retaliatory supply-cut / whole-span shun (default 0.05)
  CONFLICT_RAID_STEP?: string;          // heavy social grudge a raided house takes toward the raider house (default 0.40)
  CONFLICT_RAID_PROB?: string;          // per-cron hash-gated probability a raid is attempted (default 0.0003 ≈ one every 2–3 days)
  FEUD_BLEND?: string;                  // 0 ⇒ pure-mean houseFeuds (byte-identical); >0 weights the worst grudges in (default 0)

  // --- Territory & conquest: a fixed zone grid where each house holds ONE home zone; cross-zone (foreign)
  //     trade pays a TOLL (part-tributed to the zone's controller) and home-zone trade is discounted. OFF by
  //     default ⇒ every territory hook no-ops and applyTerritory is a byte-for-byte passthrough. Economic-side
  //     only: it re-prices a deal the neurons already made, never touches connectome/genome/manifestHash. ---
  TERRITORY_ENABLED?: string;           // "true"/"false" (default false) — enable the fixed home-zone grid + toll/discount pricing
  ZONE_COUNT?: string;                  // size of the zone grid (default 16 = HOUSE_CAP ⇒ one unique home zone per house)
  TERR_TOLL_PCT?: string;               // surcharge on a cross-zone (foreign) deal, as a fraction (default 0.12)
  TERR_HOME_DISCOUNT_PCT?: string;      // discount on a deal inside the buyer's own controlled zone (default 0.05)
  TERR_TRIBUTE_PCT?: string;            // fraction of the toll tributed to the zone controller's treasury (default 0.5)
  TERR_EXILE_SEVERITY?: string;         // extra toll multiplier on a landless (conquered) buyer, bounded (default 0.5)
  TERR_POWER_PER_ZONE?: string;         // war power added per controlled zone (default 0 = off; winnerOf lock-step unchanged)
  TERR_SEIZE_ON_WIN?: string;           // "true"/"false" (default false) — a war winner seizes the loser's zones on resolve (ledger-only conquest; needs TERRITORY_ENABLED + the war layer armed)

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
  EVOLUTION_SALT?: string;              // deterministic salt for evolution draws (hex int, default 0x65766f = "evo"); ensures the hash01 PRNG stream never aliases economy/culture/faith draws.

  // --- Phase 4: multi-objective fitness + tournament selection (capability ④) ---
  //     NOTE: armed on CODE DEFAULTS only — the 128 text-binding wall is spent (see wrangler.toml).
  EVOLUTION_MULTI_OBJECTIVE?: string;   // "true"/"false" (default FALSE — ships dark; multi-objective fitness RANKING + hash01 tournament parent selection). NEVER relaxes the netUsdc>0 hard gate or any money/survival cap — it only re-orders who breeds among the already-eligible. OFF ⇒ selection is byte-for-byte the current top-1 / elites-novelty path.
  EVOLUTION_TOURNAMENT_K?: string;      // tournament size: candidates sampled per draw (default 3, clamped 2..16)
  POP_LIVE_RETIRE?: string;             // "true"/"false" (default TRUE) — when a fly dies, RETIRE it from the live swarm (free its id/slot/shard brain) so the population reflects ONLY the living and a dead fly never holds a breeding slot. Reuses the vacated id (and its HD wallet + shard slice) for the next hatch, tombstoned so a cold boot can't resurrect the dead founder. false ⇒ the old behaviour: deaths close a wallet only, roster never shrinks, ids never recycle. Rollback switch.
  LAW_ENABLED?: string;                 // "true"/"false" (default TRUE) — ⑧ THE COMMONS: at each NEW era a deterministic assembly is convened from the swarm's own read-out condition (standing + stake of its wealthiest/honoured living flies) and votes — a pure function of (era, address, hashes) — to nudge TWO bounded institution knobs (the credit line and its interest). ECONOMIC-SIDE ONLY: it re-prices credit the economy already reads, moves no money and touches no neuron. A sub-switch of INSTITUTIONS — false (or institutions off) ⇒ no assembly, effective ≡ base config, byte-for-byte today.
  LAW_ASSEMBLY_SIZE?: string;           // seats in the commons (default 7; clamped 2..16 and to the living population).
  LAW_CREDIT_CAP_BAND?: string;         // "min,max" USDC the assembly may legislate the base credit line into (default "0.01,0.2"); a HARD clamp so self-legislation can never crash the ledger or mint.
  LAW_IOU_RATE_BAND?: string;           // "min,max" the assembly may legislate iouRatePer10 into (default "0,0.05"); a HARD clamp on interest.
  DYNASTY_ENABLED?: string;             // "true"/"false" (default TRUE) — dynasty layer: houses (inherited names + sigils + tithe treasury) and mortality (penury / old-age / plague deaths with estate inheritance). Economic-ledger ONLY — it never touches the connectome, the shards or the live population; false restores the pre-dynasty economy byte-for-byte.
  CULTURE_ENABLED?: string;             // "true"/"false" (default TRUE) — Lamarckian culture layer: feeding-cohort FAP-creed contagion with bounded TTL, house traditions as breakwaters. Overrides the decoded READ-OUT line only (fap/role), before the snapshot + economy ever see it — the connectome, genomes and manifests never notice; false restores today's readings byte-for-byte.
  RELIGION_ENABLED?: string;            // "true"/"false" (default TRUE) — ⑪ RELIGION layer: the faith membrane — three faces of the Tape (regime gods), house ancestor cults, prophet/sect contagion in the worship cohort, and a holy day every RELIGION_HOLY_EVERY crons when the devoted rest (read-out fap → REST for ONE cron). Overrides the decoded READ-OUT line only, exactly like culture; false restores today's readings byte-for-byte.
  RELIGION_HOLY_EVERY?: string;         // crons between holy days (default 48; clamped 2..400)
  RELIGION_DEVOTION_MIN?: string;       // devotion a fly needs to keep the holy rest / count on a pilgrimage (default 0.5; clamped 0..1)
  RELIGION_SECT_CAP?: string;           // hard bound on simultaneous sects in the read-out (default 8; clamped 1..16)
  TECH_ENABLED?: string;                // "true"/"false" (default TRUE) — ⑬ TECH layer: the ladder of arts — twelve public rungs (the Knotted Cord → the Difference Engine), each gated on a swarm generation and a civilisation level, discovered on a generation turn behind a deterministic draw, diffusing through the swarm over the crons that follow, and the top rung UNLEARNED when fortune breaks into a dark age. PURE READ-OUT (it re-prices nothing, moves no money, touches no neuron); false restores today's readings byte-for-byte.
  TECH_DISCOVER_P?: string;             // 0..1 — the draw a gated rung must pass on a generation turn to be invented (default 0.75; 0 ⇒ the ladder never climbs, 1 ⇒ every gated rung lands the generation its gates open)
  TECH_ADOPT_PCT?: string;              // fraction of the live swarm that takes up a discovered art each cron (default 0.1; clamped 0.01..1) — an art becomes a custom once half the swarm works by it
  CITIES_ENABLED?: string;              // "true"/"false" (default TRUE) — ⑭ CITIES layer: settlements and the census — the economy's own zone ledger read as GEOGRAPHY, so a zone where enough kin live becomes a named hamlet/town/city (sixteen fixed names, one per zone), the two greatest are joined by a road a plague wave walks, and a census is struck once a generation off the grave ring. PURE READ-OUT (it narrates burials the ledger already recorded and never causes one); false restores today's readings byte-for-byte.
  CITY_HAMLET_MIN?: string;             // living kin a zone needs to become a named hamlet (default 2; clamped 1..64)
  CITY_TOWN_MIN?: string;               // …to grow into a town (default 5; clamped 1..128)
  CITY_CITY_MIN?: string;               // …to be counted a city (default 9; clamped 1..256)
  CITY_URBAN_SHARE?: string;            // share of the live swarm living in settlements that makes the swarm "urban" (default 0.35; clamped 0..1) — announced once, and only again after the share falls 0.1 below it
  APPRENTICE_ENABLED?: string;          // "true"/"false" (default TRUE) — ⑯ APPRENTICESHIP layer: education and cumulative culture — knowledge leaves ⑬'s public ladder and LIVES IN MINDS, passed hand to hand across the feeding cohort (a fly fed beside a cleverer mate is, behind a deterministic draw, taught that mate's art, capped at the swarm's invented top). Culture turns CUMULATIVE (a student outstrips its first teacher = SURPASS) and FRAGILE (the last living keeper of an art dies untaught = CRAFT_LOST, even though the ladder still shows it). PURE READ-OUT (moves no money, touches no neuron, re-prices nothing); false restores today's readings byte-for-byte.
  APPRENTICE_LEARN_PCT?: string;        // 0..1 — per contact pair per cron, the probability a less-skilled feeder is taught its cohort-mate's art (default 0.22; clamped 0..1)
  APPRENTICE_SELF_PCT?: string;         // 0..1 — per cron, the probability a cohort feeder independently grasps the highest invented art, seeding a first keeper where none exists (default 0.05; clamped 0..1)
  APPRENTICE_SCHOOL_MIN?: string;       // living same-house keepers of one art that make it a named SCHOOL (default 3; clamped 2..64)

  // --- ⑰ ARCHIVE: externalized knowledge — the swarm's first rebellion against CRAFT_LOST (see src/archive.ts) ---
  ARCHIVE_ENABLED?: string;             // "true"/"false" (default TRUE)
  ARCHIVE_RECORD_PCT?: string;          // 0..1 — per keeper per cron, P they inscribe their craft (default 0.02)
  ARCHIVE_DECODE_PCT?: string;          // 0..1 — per unskilled fly per cron, P they are seen studying a record (default 0.08)
  ARCHIVE_BURN_CIV_MAX?: string;        // civLevel at or below this, records may burn (default 15; clamped 0..100)
  WORKSHOP_ENABLED?: string;            // "true"/"false" (default TRUE)
  WORKSHOP_REINVENT_PCT?: string;       // 0..1 — per explorer per cron, P they reinvent a lost art (default 0.03)

  // --- ⑳ COURT: verdicts, exile, amnesty — the legislature ⑧ gave a court to sit under (see src/court.ts) ---
  COURTS_ENABLED?: string;              // "true"/"false" (default TRUE)
  COURT_FILE_PCT?: string;              // 0..1 — per eligible matter per cron, P the court opens a case (default 0.25)
  COURT_JURY_SIZE?: string;             // seated citizen jurors (default 5; clamped 3..9)

  // --- ㉑ GAMES: the era bell's festivals — opening, champion, record (see src/games.ts) ---
  GAMES_ENABLED?: string;               // "true"/"false" (default TRUE)
  GAMES_OPEN_PCT?: string;              // 0..1 — per new era, P the games are proclaimed (default 0.6)

  // --- ㉒ GUILDS: the chartered trades — charter, pact, monopoly (see src/guilds.ts) ---
  //     NOTE: armed on CODE DEFAULTS — the 128 text-binding wall is spent (see wrangler.toml). To flip
  //     a knob live, evict a lower-priority var first; the env keys below are read the moment they exist.
  GUILD_ENABLED?: string;               // "true"/"false" (default TRUE)
  GUILD_QUORUM?: string;                // living hands a trade needs before its guild is chartered (default 8; clamped 3..100)
  GUILD_SHARE_P?: string;               // 0..1 — workforce share a rising guild must pass to claim a monopoly (default 0.5)

  // --- ㉕ PLAYBOOK: consequence-driven long-term memory (Phase 1, capability ①) ---
  //     NOTE: armed on CODE DEFAULTS only — the 128 text-binding wall is spent (see wrangler.toml).
  PLAYBOOK_ENABLED?: string;            // "true"/"false" (default FALSE — ships dark; flip to "true" to arm consequence memory)

  // --- Phase 2b: GP strategy genome + MAP-Elites novelty archive (capability ②) ---
  //     NOTE: armed on CODE DEFAULTS only — the 128 text-binding wall is spent (see wrangler.toml).
  STRATEGY_ENABLED?: string;            // "true"/"false" (default FALSE — ships dark; GP trees modulate decisions within existing caps)
  ELITES_ENABLED?: string;              // "true"/"false" (default FALSE — ships dark; MAP-Elites archive drives novelty selection in planEvolution)

  // --- Phase 3: intergenerational knowledge transfer (capability ③) ---
  //     NOTE: armed on CODE DEFAULTS only — the 128 text-binding wall is spent (see wrangler.toml).
  CULTURAL_TRANSMISSION_ENABLED?: string; // "true"/"false" (default FALSE — ships dark; a真亲子 hatch copies a discounted parent bond/rep + compressed playbook prior to the child)
  LAMARCK_ENABLED?: string;               // "true"/"false" (default FALSE — ships dark; a parent's lifetime performance biases the child's 4 genome scalars ±5% at breed, clamped to bounds)

  // --- ㉖ THE LEXICON: the words the telling makes — coinage, spread, silence (see src/lexicon.ts) ---
  //     NOTE: armed on CODE DEFAULTS — the 128 text-binding wall is spent (see wrangler.toml). The desk has
  //     no knobs (its thresholds are exported constants); only the master switch reads an env key.
  LEX_ENABLED?: string;                 // "true"/"false" (default TRUE)

  // --- ㉔ THE RUMOR MILL: the tale that carries itself — afoot, bent, quiet (see src/rumor.ts) ---
  //     NOTE: armed on CODE DEFAULTS — the 128 text-binding wall is spent (see wrangler.toml). The mill has
  //     no knobs (its bounds are exported constants); only the master switch reads an env key. This is the
  //     SECOND causal membrane (after religion's holy rest): the telling-day hearer override lives on the
  //     SAME read-out line, never on the stimulus bus — whose two precedents stay dark-deployed OFF.
  RM_ENABLED?: string;                  // "true"/"false" (default TRUE)

  // --- ㉛ EMERGENT NORMS: institutions no hand wrote — minted, spread, mutated, dead (see src/norms.ts) ---
  //     NOTE: armed on CODE DEFAULTS — the 128 text-binding wall is spent (see wrangler.toml). The membrane's
  //     bounds are exported constants (NORM_CAP etc.); only the master switch + the causal-leg ceiling read an
  //     env key. This is a PURE READ-OUT of the bond graph plus ONE bounded Channel-A stimulus leg (compliance
  //     the swarm lives up to tastes of plenty; violation is a bounded threat), hard-capped at 0.3 — it never
  //     signs/broadcasts a trade, never touches a multiplier or a purse, and adds no sensory channel.
  //     Shipped DISABLED (dark deploy): NORMS_ENABLED=false ⇒ state.ts never constructs the membrane ⇒ the four
  //     NORM_MINTED/NORM_SPREAD/NORM_MUTATED/NORM_DIED kinds can never speak (byte-for-byte rollback).
  NORMS_ENABLED?: string;               // "true"/"false" (default FALSE — dark deploy; flip on by hand)
  NORMS_STIMULUS_MAX?: string;          // causal-leg ceiling on any one felt channel, 0..0.3 (default 0.3; 0 ⇒ the leg emits nothing)

  // --- ㉜ EMERGENT CONVENTIONS: pairwise repeated-interaction customs (see src/conventions.ts) ---
  //     A pair that keeps trading the same way (steady frequency, low variance, no betrayal) CRYSTALLIZES a
  //     convention; it can spread, be inherited, be breached (a BOUNDED 1.5× Channel-A threat — never money, never
  //     an economic multiplier, never a real-spend cap), decay, die, and be absorbed into a ㉛ norm. Like ㉛ its
  //     bounds are exported constants (CONV_CAP etc.); only the master switch + the causal-leg ceiling read an env
  //     key. PURE READ-OUT of the bond graph + ONE bounded Channel-A leg, hard-capped at 0.3; never signs/broadcasts.
  //     Shipped DISABLED (dark deploy): CONVENTIONS_ENABLED=false ⇒ state.ts never constructs the membrane ⇒ the
  //     five CONVENTION_* kinds can never speak (byte-for-byte rollback).
  CONVENTIONS_ENABLED?: string;         // "true"/"false" (default FALSE — dark deploy; flip on by hand)
  CONVENTIONS_STIMULUS_MAX?: string;    // causal-leg ceiling on any one felt channel AND the 1.5× breach penalty, 0..0.3 (default 0.3)

  // --- ㉝ BOUNDED RULE CREATION: statutes no authority enacted (see src/rules.ts) ---
  //     THE HIGHEST-RISK MEMBRANE: unlike ㉛/㉜ (whose only causal leg is a bounded Channel-A stimulus), a rule's
  //     modifier is a MULTIPLIER on two EXISTING economic decision factors — buyProbability and the counterparty
  //     weight — so it is fenced by a CONSTITUTIONAL BAND (buyProb× ∈ [0.5, 2.0], cp-weight× ∈ [0.5, 2.0]) that no
  //     input, mutation, adoption or restored blob may ever escape (rules.ts clampBuy/clampCp + an independent
  //     re-clamp in economy.ts). The band edges/thresholds/caps are CODE-DEFAULT constants — wrangler.toml is NOT
  //     touched (the 128 text-binding wall is spent); only the master switch reads an env key. It NEVER touches a
  //     settlement, a deal amount, a real-spend cap, a mnemonic, x402, and NEVER signs/broadcasts a transaction.
  //     Shipped DISABLED (dark deploy): RULES_ENABLED=false ⇒ state.ts never constructs the membrane and never
  //     injects a modifier ⇒ the four RULE_* kinds can never speak (byte-for-byte rollback).
  RULES_ENABLED?: string;               // "true"/"false" (default FALSE — dark deploy; flip on by hand)

  // --- ㉕ THE TREATY: formal diplomacy between houses — sealed, ratified, breached (see src/treaty.ts) ---
  //     NOTE: armed on CODE DEFAULTS — the 128 text-binding wall is spent (see wrangler.toml). The chancery
  //     has no knobs (its lines are exported constants: TR_SIGN_AT / TR_BREACH_AT / TR_TERM…); only the
  //     master switch reads an env key. PURE read-out — unlike ㉔ there is no causal leg here at all: the
  //     seal moves no bond, commands no fly and touches no coffer; it only documents the bond series.
  TR_ENABLED?: string;                  // "true"/"false" (default TRUE)

  // --- ㉖ THE PUBLIC WORKS: the common goods the swarm raises for itself — granary, aqueduct, monument (see src/works.ts) ---
  //     NOTE: armed on CODE DEFAULTS — the yard's lines are constants (WK_AGE etc.), no knobs by design. The
  //     master switch reads an env key. PURE read-out: no work is ever built by a fly or paid by a purse — the
  //     roll only names what the eraInfo reckoning and the credit book already imply. WORKS_ENABLED=false ⇒
  //     state.ts never constructs the membrane ⇒ the three WORK_* kinds can never speak (byte-for-byte rollback).
  WORKS_ENABLED?: string;               // "true"/"false" (default TRUE)

  // --- ㉗ THE GUARDIANS: wardship and inheritance — the roll of wards taken, fledged, and the full-circle honors (see src/guardians.ts) ---
  //     NOTE: armed on CODE DEFAULTS — the roll's lines are constants (GD_FLEDGE etc.), no knobs by design. The
  //     master switch reads an env key. PURE read-out: no guardianship re-writes an inheritance — entomb() has
  //     already split the estate before this roll is written. GUARDIANS_ENABLED=false ⇒ state.ts never
  //     constructs the membrane ⇒ the three WARD_*/GUARDIAN_* kinds can never speak (byte-for-byte rollback).
  GUARDIANS_ENABLED?: string;           // "true"/"false" (default TRUE)

  // --- ㉘ REFORM: the society's self-correction — progressive estate duty, the jubilee stabilizer and the
  //     dark-age catalyst (see src/reform.ts). NOTE: armed on CODE DEFAULTS — the reform lines are constants
  //     (ESTATE_BRACKETS, GINI_JUBILEE_THRESHOLD etc.), no knobs by design, and wrangler.toml [vars] is at
  //     capacity so the master switch reads an env key only (NOT added to [vars]). PURE read-out + internal
  //     bookkeeping: v1 is zero-gas — it moves no real money and triggers no chain transaction. Shipped
  //     DISABLED (灰度): REFORM_ENABLED=false ⇒ state.ts never constructs the layer ⇒ the three
  //     ESTATE_LEVIED/JUBILEE_PROCLAIMED/CATALYST_SURGE kinds can never speak (byte-for-byte rollback).
  REFORM_ENABLED?: string;              // "true"/"false" (default FALSE — grey-release; flip on by hand)

  // --- #123 EQUITY TILT: market-side wealth redistribution via counterparty weight (see economy.ts pickCounterparty).
  //     NOTE: armed on CODE DEFAULTS only — the 128 text-binding wall is spent (see wrangler.toml).
  //     OFF ⇒ equityTilt multiplier ≡ 1.0 (multiplicative identity), byte-for-byte unchanged.
  EQUITY_TILT_ENABLED?: string;          // "true"/"false" (default FALSE — ships dark)
  EQUITY_TILT_BAND?: string;             // "lo,hi" clamp band (default "0.5,2.0" — mirrors RULE_FLOOR/RULE_CEIL)
  EQUITY_TILT_STRENGTH?: string;         // 0..1 tilt amplitude (default "0" ⇒ identity even when enabled)

  // --- #123 DEAD HOUSE SWEEP: route estates of houses with zero living members to the commons pool scoreboard
  //     instead of the house treasury (unlocks ~83 USDC of dead capital). NOTE: code-defaults only.
  //     OFF ⇒ entomb branch ② is byte-for-byte unchanged (all estates go to house.treasury as before).
  DEAD_HOUSE_SWEEP_ENABLED?: string;     // "true"/"false" (default FALSE — ships dark)

  // --- #143 ESTATE RELIEF (ONCHAIN): stop a dead house's REAL USDC from sleeping in its orphaned HD wallet.
  //     When armed AND onchain AND the reserved escrow purse is wired, a buried wallet is swept on-chain into
  //     escrow, then escrow is dripped to the POOREST living wallets every Nth cron. All legs move money only
  //     on a mined EIP-3009 receipt, under the ECONOMY_REAL_SPEND kill switch + shadow mode + the per-deal cap.
  //     NOTE: CODE-DEFAULTS ONLY (the 128 text-binding wall is spent, see wrangler.toml). ARMED LIVE as of
  //     2026-09-30 (enabled default TRUE, shadow default FALSE, cadence 6, chunk 0.02, budget 1/day) — every leg
  //     stays inside the same mnemonic's wallets and is bounded far below the money caps. Revert to dry-run by
  //     setting ESTATE_RELIEF_SHADOW=true + redeploy; halt all spend with ECONOMY_REAL_SPEND=false. ---
  ESTATE_RELIEF_ENABLED?: string;             // "true"/"false" (default TRUE — ARMED LIVE; the master switch; ECONOMY_REAL_SPEND is the kill switch)
  ESTATE_RELIEF_EVERY_N_CRON?: string;        // integer N (default "6" = escrow→poor drip every 6th onchain cron; 0 = never disburse)
  ESTATE_RELIEF_CHUNK_USDC?: string;          // max USDC per single escrow→poor leg (further clamped by ECONOMY_MAX_DEAL)
  ESTATE_RELIEF_DAILY_BUDGET_USDC?: string;   // max USDC dripped from escrow per UTC day (a ceiling BELOW the spend caps)
  ESTATE_RELIEF_MAX_SWEEPS_PER_CRON?: string; // estate→escrow sweeps attempted per cron (default 4, wall-clock bound)
  ESTATE_RELIEF_SHADOW?: string;              // "true"/"false" (default FALSE — real USDC moves; set TRUE to revert the layer to DRY-RUN: signs + eth_calls, broadcasts nothing)
  ESTATE_RELIEF_BACKFILL?: string;            // "true"/"false" (default TRUE — ARMED: one-time RETROACTIVE sweep of the CURRENTLY-orphaned this.dead set into the queue; latches once, never re-scans, guard-protected so a reclaimed/living id is never swept. dead=0 live ⇒ captures 0, an immediate no-op)

  // --- #123 REFORM V2: jubilee cooldown re-arm (fixes the permanent deadlock) + levy deductions wired to the
  //     commons pool scoreboard (downward-deduct from the rich, never upward-add to mirrors). NOTE: code-defaults.
  //     OFF ⇒ reform.step() uses the old (broken) Gini-reset re-arm and levyDeductions are discarded.
  REFORM_V2_ENABLED?: string;            // "true"/"false" (default FALSE — ships dark)

  // --- R5 FIX A/B (#126): heal the internal-mirror ↔ on-chain USDC decoupling that makes chain-drained agents
  //     100% settle-fail and netPending climb monotonically. NOTE: armed on CODE DEFAULTS only — the 128 text-
  //     binding wall is spent (see wrangler.toml), so these read env keys but are NOT added to [vars]. Both default
  //     OFF ⇒ the planner/flush path is byte-for-byte today (dark-deploy safe).
  ECONOMY_ONCHAIN_BALANCE_GATE?: string;      // "true"/"false" (default FALSE — Fix A: refuse to queue a pair whose debtor is on-chain-insolvent)
  ECONOMY_MIRROR_RESYNC_EVERY_N_CRON?: string; // integer N (default "0" = disabled — Fix B: overwrite mirror=onchain every Nth cron; NEVER inflates above chain)

  // --- ㉙ TEMPLE: burn-to-influence — a holder sends MURMUR to 0x…dEaD, submits the tx hash, and the Worker
  //     (keyless, read-only, zero gas) re-reads the burn on-chain and queues the requested intervention (see
  //     src/temple.ts). NOTE: armed on CODE DEFAULTS — the tier ladder (TIER_MINIMUMS), the queue/per-cron
  //     caps and the twelve intervention semantics are constants, no knobs by design, and wrangler.toml [vars]
  //     is at capacity so the master switch reads an env key only (NOT added to [vars]). PURE read-out +
  //     internal bookkeeping: the interventions move no real money off the temple's own bounded state, and the
  //     ONLY chain touch is a getTransactionReceipt READ. Shipped ENABLED (the ㉔-㉗ default-ON 口径):
  //     TEMPLE_ENABLED=false ⇒ state.ts never constructs the layer ⇒ the twelve temple kinds can never speak
  //     (byte-for-byte rollback).
  TEMPLE_ENABLED?: string;              // "true"/"false" (default TRUE — the door is open; flip off by hand)

  // --- ㉚ LAND: burn-to-claim pixel parcels (see src/land.ts) ---
  //     The continent is a fixed 24×15 = 360 parcel grid; a holder plants an image on a parcel by sending
  //     MURMUR to 0x…dEaD (provably GONE) and submitting the tx hash + the image. The Worker RE-READS that
  //     hash on-chain (keyless, read-only, zero gas) and only a genuine burn clearing the parcel's price
  //     changes hands; each seizure ratchets the price +100 MURMUR, so the destroyed value only ever grows.
  //     The grid dimensions, the floor price and the ratchet step are constants (no knobs by design), and
  //     wrangler.toml [vars] is at the 128-binding wall, so the master switch reads an env key only (NOT added
  //     to [vars]). PURE read-out + internal bookkeeping: the ONLY chain touch is a getTransactionReceipt READ.
  //     Shipped ENABLED (the ㉔-㉙ default-ON 口径): LAND_ENABLED=false ⇒ state.ts never constructs the layer ⇒
  //     the two land chronicle kinds can never speak (byte-for-byte rollback).
  LAND_ENABLED?: string;                // "true"/"false" (default TRUE — the grid is open; flip off by hand)

  // --- ① NEURAL FEEDBACK BUS: let the swarm FEEL the age it lives in (see src/socialStimulus.ts) ---
  //     The historian already reckons a civilizational fortune (civLevel 0..100) and names its ages (golden /
  //     dark / ascendant / declining + the shock era). This layer folds that SAME reckoning back into the
  //     connectome as a BOUNDED ambient on the four existing visitor stimulus channels (food / threat / light /
  //     dark) — a golden age brightens and tastes of plenty, a dark age dims, a plague/famine is a sustained
  //     aversive stress. It adds NO sensory channel (manifestHash never rotates), touches NO genome, moves NO
  //     money, and writes NO chronicle kind (chroniclerRulesHash never rotates ⇒ no frontend mirror, worker-only).
  //     OFF by default (dark deploy) ⇒ an OFF cron appends nothing, byte-for-byte today's neural input.
  SOCIAL_STIMULUS_ENABLED?: string;     // "true"/"false" (default false) — feed the civilizational climate back into the connectome
  SOCIAL_STIMULUS_MAX?: string;         // master ceiling on any one felt channel's intensity, 0..1 (default 0.5; 0 ⇒ the bus emits nothing)

  // --- ⑮ THE LAUREATE: a poet born in the swarm, writing with neurons instead of an LLM (see src/poet.ts) ---
  //     Each era the swarm deterministically crowns ONE living fly its laureate; each hour that fly decodes its
  //     OWN live neural read-out + the on-chain reality through a PUBLIC grammar into a four-line imagist poem on
  //     an independent /poem hash chain. PURE READ-OUT: it adds NO neuron/channel (manifestHash never rotates),
  //     writes NO chronicle kind (chroniclerRulesHash never rotates ⇒ no frontend mirror, worker-only), touches
  //     NO genome and moves NO money — and unlike ① it never writes back into the connectome. Every poem is
  //     sha256-recomputable and byte-for-byte replayable from its published integers + the open grammar.
  //     OFF by default (dark deploy) ⇒ an OFF cron composes nothing, byte-for-byte today.
  POET_ENABLED?: string;                // "true"/"false" (default false) — crown a laureate + write the hourly neural poem
  POEMS_CAP?: string;                   // how many poems the ring keeps (default 64; like PROOFS_CAP)
  POET_MIN_CRONS?: string;              // fallback cadence guaranteeing ≈one poem per hour (default 60 crons)

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
  /**
   * A3 neuromodulatory gating (NEUROMOD_GATING, default FALSE). When false the DA/OA-like neuromodulatory
   * read-out is computed and surfaced for observability but NEVER modulates a drive, so the decoder output
   * (arousal/turnBias/state/fingerprint/ethogram) — and therefore every economic read-out and provenance
   * receipt derived from it — is byte-for-byte identical to the pre-A3 behaviour (dark deploy). When true the
   * OA-like octopamine tone additionally shades exploration/arousal within a bounded band. Manifest-neutral
   * either way: the gate lives outside DEFAULT_DECODER_CONFIG, so the on-chain brain hash never rotates.
   */
  neuromodGating: boolean;
  /**
   * A2 online: real FlyWire topology (FLYWIRE_TOPOLOGY, default FALSE). When false the procedural PRNG
   * generator (buildConnectome) builds every brain — byte-for-byte today's behaviour. When true the fixed
   * FAFB 783 MB+CX subgraph (10,361 neurons / 467k synapses, fan-in ~45) replaces the PRNG topology;
   * the genome's seed controls only LIF jitter + weight perturbation, and breeding operators mutate
   * PARAMETERS (weightGain/threshGain/tauGain) instead of layer sizes. MANIFEST-AFFECTING: the structural
   * spec changes (different neuronCount/synapseCount/edgeHash), so manifestHash rotates. Dark-deploy only.
   */
  flywireTopology: boolean;
  /** KV namespace holding the FlyWire artifact (only needed when flywireTopology=true). */
  flywireArtifact?: KVNamespace;
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
  /**
   * Deployed ContinuityRegistry address (the Proof-of-Continuous-Agency epoch anchor). Defaults in code to
   * the Arc-mainnet deployment (`env.POCA_REGISTRY_ADDRESS ?? 0x3f67…5b33`) so a deploy never needs a new
   * wrangler [vars] key. The zero address DISABLES on-chain anchoring — every openEpoch/sealEpoch/adminAction
   * is skipped (logged once) while the off-chain epoch chain keeps running.
   */
  pocaRegistryAddress: string;

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
    /** #98 Fix 2: max pendingNets pairs to BROADCAST per cron flush (0 = no cap, legacy behaviour). */
    netFlushBudgetPerCron: number;
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

  // Arc Pulse refund rail (dark-deploy; see Env.PULSE_REFUNDS). Off by default — nothing runs when off.
  refunds: {
    enabled: boolean;
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
    bootstrap: boolean;          // cold-start: lift feudPairs' vault gate so driveWar funds the deepest feud first (default false ⇒ inert)
  };

  // ⑲ THE BOURSE — MURMUR's on-chain life as a read-out membrane (narration) plus an optional felt climate
  // (tokenStimulus). Read-only: one eth_getLogs per cron, no key, no custody, no spend. OFF by default ⇒
  // no sampling, no `bourse` chronicle facet, no coin stimuli — byte-for-byte the pre-bourse build.
  bourse: {
    enabled: boolean;
    token: string | null;        // lowercased 0x CA to watch; null ⇒ the membrane is inert
    taxWallet: string | null;    // lowercased 0x argus tax wallet; null ⇒ no leg is classified as tithe
    whaleRaw: string;            // whale threshold in raw 18-dec units (decimal string; JSON-safe)
    lookbackBlocks: number;      // max blocks one sample spans + the cold-start window
    titheMilestoneRaw: string;   // cumulative-tithe milestone in raw 18-dec units (decimal string)
  };
  tokenStimulus: {
    enabled: boolean;            // FEEL leg gate (independent of narration; default OFF)
    maxIntensity: number;        // master ceiling 0..1 on any one felt coin channel (NaN-safe at parse)
  };

  // ORGANIC CONFLICT: deterministic, on-chain-reachable negative social events (rivalry / envy / embargo /
  // raid) that let genuine house-vs-house feuds surface so war can fire on real hatred. OFF by default ⇒
  // every hook no-ops and houseFeuds stays a pure mean (byte-for-byte today's economy). Pure social-memory
  // writes only — never touches neurons/genome/manifestHash, never moves or mints money. KEY_VERSION stays economy:v1.
  conflict: {
    enabled: boolean;
    rivalStep: number;      // grudge per tick between two houses competing in the same good's market
    envyStep: number;       // max grudge a losing house takes toward the dominant house on a hot shock
    embargoStep: number;    // grievance accrued when a buyer's whole span is shunned (retaliatory hold)
    raidStep: number;       // heavy grudge a raided house's member takes toward the raider house (social only)
    raidProb: number;       // per-cron probability (hash-gated) that a raid is attempted
    feudBlend: number;      // 0 ⇒ pure-mean houseFeuds (byte-identical); >0 weights the worst grudges in
  };

  // TERRITORY & CONQUEST: a fixed zone grid; each house holds ONE home zone. Cross-zone (foreign) trade pays a
  // toll (part-tributed to the zone's controller), home-zone trade is discounted, and a conquered (landless)
  // house pays toll everywhere. OFF by default ⇒ applyTerritory is a byte-for-byte passthrough and no zone
  // state is written. Economic-side only (re-prices a deal the neurons already made); never touches neurons.
  territory: {
    enabled: boolean;
    zoneCount: number;        // the fixed grid size (default 16 = HOUSE_CAP ⇒ one unique home zone per house)
    tollPct: number;          // surcharge on a cross-zone (foreign) deal
    homeDiscountPct: number;  // discount on a deal inside the buyer's own controlled zone
    tributePct: number;       // fraction of the toll tributed to the zone controller's treasury
    exileSeverity: number;    // extra toll multiplier on a landless (conquered) buyer, bounded
    powerPerZone: number;     // war power added per controlled zone (0 ⇒ off; winnerOf lock-step unchanged)
    seizeOnWin: boolean;      // a war winner seizes the loser's zones on resolve (ledger-only conquest; default false)
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
    salt: number;             // deterministic FNV-1a salt for evolution draws (replaces Math.random/Date.now)
    hatchLive: boolean;       // hatch bred offspring into LIVE trading flies (grow to maxLivePopulation) vs lineage-only
    hatchSeedUsdc: number;    // parent→child bootstrap USDC transferred to the offspring's own wallet on hatch
    treasury: string | null;  // revenue address collecting each fee; null ⇒ step skipped entirely
    // Phase 4 capability ④: multi-objective fitness + tournament selection. Default OFF ⇒ parent choice is
    // byte-for-byte the current top-1/elites-novelty path. The dimension weights + normalization caps are
    // CODE-DEFAULT CONSTANTS in mofit.ts (MOFIT_WEIGHTS / MOFIT_*_CAP) — deliberately NOT env knobs, so the
    // fitness function cannot be retuned without rotating CODE_COMMITMENT.
    multiObjective: {
      enabled: boolean;       // master switch (default OFF — dark deploy): multi-objective RANKING + tournament selection
      tournamentK: number;    // candidates sampled per tournament draw (default 3, clamped 2..16)
    };
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

  // Religion (⑪ the faith membrane: regime gods, ancestor cults, prophets & sects, holy days). Pure
  // read-out-line override on holy days only — never the brain, never the ledger.
  religion: {
    enabled: boolean;         // master switch (default ON): false ⇒ every hook is a no-op, byte-for-byte today
    holyEvery: number;        // crons between holy days (default 48)
    devotionMin: number;      // devotion for the holy rest / pilgrimage count (default 0.5)
    sectCap: number;          // max simultaneous sects in the read-out (default 8)
  };

  // Tech (⑬ the ladder of arts: twelve gated rungs, discovered / diffused / unlearned on the historian's own
  // clocks). Pure read-out — an invention re-prices NOTHING, moves no money, never the brain, never the ledger.
  tech: {
    enabled: boolean;         // master switch (default ON): false ⇒ every hook is a no-op, byte-for-byte today
    discoverP: number;        // the draw a gated rung must pass on a generation turn (default 0.75)
    adoptPct: number;         // per-cron fraction of the swarm taking up a discovered art (default 0.1)
  };

  // Cities (⑭ settlements + the census: the zone ledger read as geography, demography read off the grave ring).
  // Pure read-out — it narrates the burials the economy already recorded and never causes one.
  cities: {
    enabled: boolean;         // master switch (default ON): false ⇒ every hook is a no-op, byte-for-byte today
    hamletMin: number;        // living kin that make a zone a named hamlet (default 2)
    townMin: number;          // …a town (default 5)
    cityMin: number;          // …a city (default 9)
    urbanShare: number;      // share of the swarm in settlements that makes it urban (default 0.35)
  };
  
  // Apprenticeship (⑯ education + cumulative culture: arts leave the public ladder and live in individual minds,
  // passed master→apprentice across the feeding cohort). Pure read-out — no lesson moves a coin or touches a neuron.
  apprentice: {
    enabled: boolean;         // master switch (default ON): false ⇒ every hook is a no-op, byte-for-byte today
    learnPct: number;         // per contact pair per cron, P a feeder is taught its cohort-mate's art (default 0.22)
    selfPct: number;          // per cron, P a feeder independently grasps the top invented art (default 0.05)
    schoolMin: number;        // living same-house keepers of one art that make it a school (default 3)
  };
  archive: {
    enabled: boolean;
    recordP: number;          // per keeper per cron, P they inscribe (default 0.02)
    decodeP: number;          // per unskilled fly per cron, P they decode (default 0.08)
    burnCivMax: number;       // civLevel ≤ this ⇒ records may burn (default 15)
  };
  workshop: {
    enabled: boolean;
    reinventP: number;        // per explorer per cron, P they reinvent a lost art (default 0.03)
  };
  court: {
    enabled: boolean;
    fileP: number;            // per eligible matter per cron, P a case is filed (default 0.25)
    jurySize: number;         // seated citizen jurors (default 5, clamped 3..9)
  };
  games: {
    enabled: boolean;
    openP: number;            // per new era, P the festival is proclaimed (default 0.6)
  };
  guilds: {
    enabled: boolean;
    quorum: number;           // living hands before a trade wins its charter (default 8, clamped 3..100)
    shareP: number;           // rising workforce share for a monopoly (default 0.5)
  };
  lexicon: {
    enabled: boolean;         // the desk's thresholds are constants (LEX_COIN_AT etc.) — no knobs by design
  };
  rumor: {
    enabled: boolean;         // the mill's bounds are constants (RM_HEARD_CAP etc.) — no knobs by design
  };
  // ㉛ EMERGENT NORMS: the membrane's bounds are constants (NORM_CAP etc.); the only knob is the causal leg's
  //     Channel-A ceiling. OFF ⇒ state.ts never constructs it, byte-for-byte the pre-Norms build.
  norms: {
    enabled: boolean;         // master switch (default OFF — dark deploy)
    maxIntensity: number;     // ceiling (and master scale) on the causal leg's stimulus, 0..0.3 (default 0.3)
  };
  // ㉜ EMERGENT CONVENTIONS: bounds are constants (CONV_CAP etc.); the only knob is the causal leg's Channel-A
  //     ceiling, which ALSO hard-bounds the 1.5× breach penalty. OFF ⇒ never constructed, pre-Conventions build.
  conventions: {
    enabled: boolean;         // master switch (default OFF — dark deploy)
    maxIntensity: number;     // ceiling (and master scale) on the causal leg + the 1.5× breach penalty, 0..0.3
  };
  // ㉝ BOUNDED RULE CREATION: bounds are constants (RULE_CAP etc.); the knobs are the master switch and the
  //     CONSTITUTIONAL BAND the modifier lives inside. The band edges are code-defaults clamped into the HARD
  //     envelope [0.5, 2.0] (rules.ts HARD_BUY_MIN/MAX, HARD_CP_MIN/MAX) — a config may only NARROW the band,
  //     never widen past the hard floor/ceiling. OFF ⇒ never constructed, byte-for-byte the pre-Rules build.
  rules: {
    enabled: boolean;         // master switch (default OFF — dark deploy)
    buyMin: number;           // constitutional band floor on the buyProbability multiplier (hard 0.5)
    buyMax: number;           // constitutional band ceiling on the buyProbability multiplier (hard 2.0)
    cpMin: number;            // constitutional band floor on the counterparty-weight multiplier (hard 0.5)
    cpMax: number;            // constitutional band ceiling on the counterparty-weight multiplier (hard 2.0)
  };
  treaty: {
    enabled: boolean;         // the chancery's lines are constants (TR_SIGN_AT etc.) — no knobs by design
  };
  works: {
    enabled: boolean;         // the yard's lines are constants (WK_AGE etc.) — no knobs by design
  };
  guardians: {
    enabled: boolean;         // the roll's lines are constants (GD_FLEDGE etc.) — no knobs by design
  };
  reform: {
    enabled: boolean;         // ㉘ the reform lines are constants (ESTATE_BRACKETS etc.) — no knobs by design
    v2Enabled: boolean;       // #123: jubilee cooldown re-arm + levy→commons wiring (default OFF — dark deploy)
  };
  temple: {
    enabled: boolean;         // ㉙ the tier ladder + caps are constants (TIER_MINIMUMS etc.) — no knobs by design
  };
  land: {
    enabled: boolean;         // ㉚ the grid + floor price + ratchet are constants (LAND_BASE_PRICE etc.) — no knobs by design
  };
  playbook: {
    enabled: boolean;         // ㉕ Phase 1 capability ①: consequence-driven long-term memory (default OFF — dark deploy)
  };

  // Phase 2b capability ②: GP strategy genome wired into real economic decisions + MAP-Elites archive.
  // OFF ⇒ every strategy/elites hook no-ops, the economy is byte-for-byte the Phase 1 build.
  strategy: {
    enabled: boolean;         // master switch (default OFF — dark deploy): GP trees modulate buyProbability/pickCounterparty/dealAmount/prediction
  };
  elites: {
    enabled: boolean;         // master switch (default OFF — dark deploy): MAP-Elites archive drives novelty selection in planEvolution
  };

  // Shadow-compare (task #87): mirrors the decision loop with evolution capabilities ON and records
  // baseline-vs-evolved diffs to D1. PURE READ-OUT — never touches facilitator/settle/flush/real fields.
  // OFF ⇒ zero overhead, zero new keys in /economy, byte-for-byte dark deploy.
  shadowCompare: {
    enabled: boolean;         // master switch (default OFF — dark deploy): fail-closed `=== "true"`
    everyNCrons: number;      // run shadow every N crons (default 1 = every cron; code-default only)
    maxDecisionsPerCron: number; // max decision rows computed per cron (default 64; code-default only)
    maxRowsPerCronToD1: number;  // max rows written to D1 per cron (default 32; code-default only)
  };

  // #123 EQUITY TILT: market-side wealth redistribution via counterparty weight tilt. OFF ⇒ equityTilt ≡ 1.0
  // (multiplicative identity), byte-for-byte unchanged. Only tilts cp-weight, NEVER buyProbability.
  equityTilt: {
    enabled: boolean;         // master switch (default OFF — dark deploy)
    band: [number, number];   // [floor, ceil] hard clamp (default [0.5, 2.0], mirrors RULE_FLOOR/RULE_CEIL)
    strength: number;         // tilt amplitude 0..1 (default 0 ⇒ identity even when enabled)
  };

  // #123 DEAD HOUSE SWEEP: route estates of zero-living-member houses to the commons pool scoreboard instead
  // of the house treasury. OFF ⇒ entomb branch ② byte-for-byte unchanged.
  deadHouseSweep: {
    enabled: boolean;         // master switch (default OFF — dark deploy)
  };

  // #143 ESTATE RELIEF (ONCHAIN): sweep an orphaned dead wallet's real USDC into a reserved escrow purse, then
  // drip escrow to the poorest living wallets. OFF (default) ⇒ entomb/cron byte-for-byte today; every leg is
  // bounded by the per-deal cap + a daily relief budget + cadence, under ECONOMY_REAL_SPEND + shadow mode.
  estateRelief: {
    enabled: boolean;            // master switch (default OFF — dark deploy)
    shadow: boolean;             // default TRUE — an enabled layer dry-runs each leg (eth_call, no broadcast); FALSE = real USDC moves
    reliefEveryNCrons: number;   // 0 = never disburse (default); N>0 = escrow→poor drip every Nth cron
    reliefChunkUsdc: number;     // max USDC per escrow→poor leg (further clamped by ECONOMY_MAX_DEAL)
    reliefDailyBudgetUsdc: number; // max USDC dripped per UTC day (below the spend caps)
    maxSweepsPerCron: number;    // estate→escrow sweeps per cron (wall-clock bound)
    backfill: boolean;           // default FALSE — one-time retroactive sweep of the CURRENTLY-orphaned this.dead set into the queue (guard-protected, latches once)
  };

  // System One (Jev) read-out side-plane (see Env.JEV_*). OFF by default (dark deploy) ⇒ inert, no request,
  // no jev key on /economy. A PURE read: NEVER a determinism/money input (no connectome/stateDigest/caps).
  // `live` is only true when enabled AND a non-empty apiKey resolved — a half-configured arm can never fire.
  jev: {
    enabled: boolean;            // master switch (default OFF)
    apiKey: string | null;       // Bearer token (null ⇒ inert even when enabled)
    baseUrl: string;             // default https://api.typesafe.ai
    model: string;               // default jev-latest
    timeoutMs: number;           // per-call wall-clock budget (default 900ms)
  };

  // R5 FIX A (#126): on-chain balance gate in the trade planner. OFF ⇒ queueNet byte-for-byte today (every
  // neuron-picked trade is folded into pendingNets). ON ⇒ each cron reads live balances via ONE multicall and
  // refuses to queue a pair whose debtor cannot cover it on-chain. Read-only, no money, no caps, no digest.
  onchainBalanceGate: {
    enabled: boolean;         // master switch (default OFF — dark deploy): fail-closed `=== "true"`
  };

  // R5 FIX B (#126): periodic mirror re-align to on-chain truth. everyNCrons=0 ⇒ disabled/never (byte-for-byte
  // today). N>0 ⇒ every Nth cron overwrites each live agent's DISPLAY mirror with its real on-chain balance
  // (re-using Fix A's multicall cache), recording the drift. Mirror is only ever set EQUAL to chain, never above.
  mirrorResync: {
    everyNCrons: number;      // 0 = disabled (default); N>0 = re-align every Nth cron (code-default clampInt)
  };

  // Phase 3 capability ③: intergenerational knowledge transfer. Both default OFF (dark deploy) ⇒ a child
  // hatches blank exactly as in Phase 2b (byte-for-byte inert). OFF never touches social/playbook/genome.
  cultural: {
    enabled: boolean;         // master switch (default OFF): vertical cultural transmission at noteHatch (discounted parent bond/rep + compressed playbook prior;真亲子 only)
  };
  lamarck: {
    enabled: boolean;         // master switch (default OFF): Lamarckian genome imprinting — parent lifetime performance biases the child's 4 genome scalars ±5% (clamped) at breed
  };
  
  // ① NEURAL FEEDBACK BUS: the civilizational climate (eraInfo's phase / level / shock) fed back into the
  // connectome as a bounded ambient on the four visitor stimulus channels. Pure + deterministic; it adds NO
  // channel (manifestHash unchanged), touches NO genome, moves NO money and writes NO chronicle kind
  // (chroniclerRulesHash unchanged). OFF ⇒ nothing is appended, byte-for-byte today's neural input.
  socialStimulus: {
    enabled: boolean;         // master switch (default OFF — dark deploy): false ⇒ the cron injects only today's visitor stimuli
    maxIntensity: number;     // ceiling (and master scale) on any one emitted channel's intensity, 0..1 (default 0.5)
  };

  // ⑮ THE LAUREATE: the swarm's poet — a pure read-out membrane on its OWN /poem hash chain. Each era crowns one
  // living fly; each hour it decodes its own neural read-out + the on-chain reality through a public grammar into
  // a verifiable four-line poem. Adds NO neuron/channel (manifestHash unchanged), writes NO chronicle kind
  // (chroniclerRulesHash unchanged), moves NO money, and never writes back into the connectome. OFF ⇒ no poem.
  poet: {
    enabled: boolean;         // master switch (default OFF — dark deploy): false ⇒ the cron composes nothing
    cap: number;              // poems the ring keeps (default 64; like PROOFS_CAP)
    minCrons: number;         // fallback cadence guaranteeing ≈one poem per hour (default 60 crons)
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
  
  // #98 Cron infrastructure knobs (code-defaults only — no wrangler [vars] key needed).
  cron: {
    /** Economy blob bytes above which persist() shards the write (default 262144 = 256 KB). */
    persistShardThreshold: number;
    /** Max bytes per shard part (default 262144 = 256 KB). */
    persistChunkSize: number;
    /** Wall-clock ms above which cron() emits a warning (default 45000 = 45 s). */
    wallClockWarnMs: number;
    /** netPending count above which cron emits a backlog alert (default 500). */
    netPendingAlertThreshold: number;
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
  // shard count must cover it at <=1 fly/shard: one 30,800-neuron brain per isolate stays inside the DO
  // 128 MB heap (its deserialize clone peak) and its per-fly value inside the 2 MB single-value limit.
  const maxLivePopulation = clampInt(
    Number(env.EVOLUTION_MAX_LIVE_POPULATION || String(populationSize)),
    populationSize,
    256,
  );
  // Shards are capped at the growth ceiling only (one shard per fly is the finest useful split AND the
  // memory-safe target: each isolate then hosts exactly ONE 30,800-neuron brain). The old extra cap of 64
  // silently forced flies/shard = ceil(100/64) = 2 at cap 100 — two brains per isolate whose combined
  // deserialize peak (~144 MB) breaches the 128 MB wall and whose ~4.2 s advance brushes the 5 s timeout.
  // Fan-out width is NOT a reason to cap: Cloudflare QUEUES subrequests beyond the 6th (see swarm.ts step()),
  // so 100 shards cost no more round-trip waves than the memory-safe layout already needs. 1 ⇒ single FlyStateDO.
  const shardCount = clampInt(Number(env.SHARD_COUNT || "1"), 1, maxLivePopulation);

  // HATCH GUARD: hatching grows the live population into slots the shards must ALREADY cover at <=1
  // fly/shard (one 30,800-neuron brain alone inside the DO 128 MB heap + 2 MB value ceiling). If SHARD_COUNT
  // wasn't raised to match the cap, flies/shard would exceed 1 and a shard could OOM / overflow — so refuse
  // to hatch (breeding stays lineage-only) rather than risk a live fly that can't be safely hosted alone.
  const hatchLiveRequested = (env.EVOLUTION_HATCH_LIVE ?? "false").toLowerCase() === "true";
  const fliesPerShardAtCap = fliesPerShard(maxLivePopulation, shardCount);
  const hatchLive = hatchLiveRequested && fliesPerShardAtCap <= 1;
  // LIVE-RETIRE (POP_LIVE_RETIRE, default TRUE). Independent of hatchLive: retiring the dead always keeps
  // size()/aliveCount honest about who is actually alive; the freed slots simply become available again.
  const liveRetire = (env.POP_LIVE_RETIRE ?? "true").toLowerCase() !== "false";
  if (hatchLiveRequested && !hatchLive) {
    console.error(
      `[config] EVOLUTION_HATCH_LIVE ignored: need SHARD_COUNT >= cap so flies/shard <= 1 ` +
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
    // A3 dark deploy: OFF unless NEUROMOD_GATING="true". Absent/false ⇒ the neuromodulatory read-out is
    // observed only and the decoder is byte-for-byte the pre-A3 behaviour.
    neuromodGating: (env.NEUROMOD_GATING ?? "false").toLowerCase() === "true",
    // A2 dark deploy: OFF unless FLYWIRE_TOPOLOGY="true". Absent/false ⇒ the procedural PRNG generator
    // builds every brain (byte-for-byte today's behaviour). ON ⇒ the real FAFB 783 subgraph replaces the
    // topology; manifestHash ROTATES (different structural spec). NEVER enable without user approval.
    flywireTopology: (env.FLYWIRE_TOPOLOGY ?? "false").toLowerCase() === "true",
    flywireArtifact: env.FLYWIRE_ARTIFACT,
    shardCount,
    maxLivePopulation,
    liveRetire,

    stimulusCooldownSec: Number(env.STIMULUS_COOLDOWN_SEC || "30"),
    frontendOrigin: env.FRONTEND_ORIGIN || "*",
    manifestRegistryAddress: (env.MANIFEST_REGISTRY_ADDRESS ?? "").trim() || null,
    lineageAddress: (env.LINEAGE_ADDRESS ?? "").trim() || null,
    // PoCA epoch anchor. The code default is the deployed Arc-mainnet ContinuityRegistry (deploy tx
    // 0xd9ef64…dd16, committer = the Worker facilitator); no wrangler [vars] key needed. Setting the env
    // var to the zero address disables the on-chain mirror (off-chain chain unaffected). Trimmed so the
    // zero check in x402.ts is reliable; an empty/whitespace value falls back to the code default, never to "".
    pocaRegistryAddress:
      (env.POCA_REGISTRY_ADDRESS ?? "").trim() || "0x3f67b38030f2d709bafd2f7a3ee2388c35195b33",

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
      // #99 M9: code-defaults synced to the LIVE wrangler [vars] values (ECONOMY_NET_MIN_BROADCAST="0.01",
      // ECONOMY_NET_FLUSH_TICKS="1440", wrangler.toml L128-129, raised from 0.004/30 by c7b53f8 and last
      // written by e7a1a86 — both pre-batch). A fallback that disagrees with production is a trap: any
      // deploy that loses the [vars] block, and every local/test run, would silently trade on 12× tighter
      // dust and 12× more frequent force-flushes than mainnet does. wrangler.toml itself is UNTOUCHED.
      // #133: ECONOMY_NET_FLUSH_TICKS went 360→1440 as the emergency gas valve (−50% real spend/day), and the
      // wrangler edit shipped WITHOUT this fallback — exactly the trap above, and exactly what the M9 drift
      // guard exists to catch (cron99.test.ts:614). Synced here so a lost [vars] block can never silently
      // 4× the force-flush rate and burn the facilitator dry. Live behaviour is unchanged (the [vars] wins).
      netMinBroadcastUsdc: clamp(Number(env.ECONOMY_NET_MIN_BROADCAST ?? "0.01"), 0, 100_000),
      netFlushTicks: clampInt(Number(env.ECONOMY_NET_FLUSH_TICKS ?? "1440"), 0, 100_000),
      netFlushBudgetPerCron: 40,   // #98 Fix 2: code-default only, no env var
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

    refunds: {
      // Dark deploy: absent/empty/typo ⇒ OFF, the refund code path never executes.
      enabled: (env.PULSE_REFUNDS ?? "").trim().toLowerCase() === "true",
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
      // Cold-start funding is OFF by default: it is the ONLY switch that lets the first war move real operator USDC
      // into empty vaults, so it requires an explicit arm (WAR_BOOTSTRAP=true). Off ⇒ the vault gate holds and a cold
      // swarm can never start a war (byte-for-byte today's deadlocked-but-inert behaviour).
      bootstrap: (env.WAR_BOOTSTRAP ?? "false").toLowerCase() === "true",
    },

    bourse: {
      // OFF by default (dark deploy): the membrane ships inert and is opened only after an OFF deploy proves
      // the cron byte-for-byte unchanged. The MURMUR CA is the default watch target (already public on the
      // frontend); the tax wallet default is the address the argus platform skims into (probe-verified 2026-09:
      // ~2% of every transfer, auto-swept, so the pulse is the FLOW). Whole-MURMUR knobs are converted to
      // raw 18-dec decimal strings here so the runtime never re-parses floats into bigint.
      enabled: (env.BOURSE_ENABLED ?? "false").toLowerCase() === "true",
      token: (env.BOURSE_TOKEN ?? "0x8faae5592b9acc27a79fca745c6b872adf514a5d").trim().toLowerCase() || null,
      taxWallet: (env.BOURSE_TAX_WALLET ?? "0xc38e7c9e5cb1b59a53e892b938a7d79f0b741cb3").trim().toLowerCase() || null,
      whaleRaw: murmurToRaw(clamp(Number(env.BOURSE_WHALE_MURMUR ?? "1000000"), 1_000, 1_000_000_000), 1_000_000),
      lookbackBlocks: clampInt(Number(env.BOURSE_LOOKBACK ?? "1200"), 100, 7200),
      titheMilestoneRaw: murmurToRaw(clamp(Number(env.BOURSE_TITHE_MILESTONE_MURMUR ?? "5000000"), 10_000, 1_000_000_000), 5_000_000),
    },

    tokenStimulus: {
      // OFF by default (dark deploy) — the ① lesson: this writes straight into the live neural input, so it
      // ships gated behind BOTH BOURSE_ENABLED (no climate ⇒ nothing felt) and its own switch. The default
      // ceiling (0.35) is deliberately below the civic bus's 0.5: this input is adversarially controllable
      // (anyone can transfer), so a whale's whisper must stay a whisper. NaN-safe like SOCIAL_STIMULUS_MAX.
      enabled: (env.TOKEN_STIMULUS_ENABLED ?? "false").toLowerCase() === "true",
      maxIntensity: (() => {
        const mi = Number(env.TOKEN_STIMULUS_MAX ?? "0.35");
        return clamp(Number.isFinite(mi) ? mi : 0.35, 0, 1);
      })(),
    },

    conflict: {
      // OFF by default: absent/false ⇒ every conflict hook no-ops and houseFeuds stays a pure mean, so the
      // economy is byte-for-byte unchanged. All knobs are deterministic social-memory nudges only.
      enabled: (env.CONFLICT_ENABLED ?? "false").toLowerCase() === "true",
      rivalStep: clamp(Number(env.CONFLICT_RIVAL_STEP ?? "0.06"), 0, 1),
      envyStep: clamp(Number(env.CONFLICT_ENVY_STEP ?? "0.10"), 0, 1),
      embargoStep: clamp(Number(env.CONFLICT_EMBARGO_STEP ?? "0.05"), 0, 1),
      raidStep: clamp(Number(env.CONFLICT_RAID_STEP ?? "0.40"), 0, 1),
      raidProb: clamp(Number(env.CONFLICT_RAID_PROB ?? "0.0003"), 0, 1),
      feudBlend: clamp(Number(env.FEUD_BLEND ?? "0"), 0, 1),
    },

    territory: {
      // OFF by default: absent/false ⇒ every territory hook no-ops, applyTerritory is a byte-for-byte
      // passthrough and no zoneControl is written. All knobs are deterministic economic-side nudges only.
      enabled: (env.TERRITORY_ENABLED ?? "false").toLowerCase() === "true",
      zoneCount: clampInt(Number(env.ZONE_COUNT ?? "16"), 1, 4096),
      tollPct: clamp(Number(env.TERR_TOLL_PCT ?? "0.12"), 0, 5),
      homeDiscountPct: clamp(Number(env.TERR_HOME_DISCOUNT_PCT ?? "0.05"), 0, 1),
      tributePct: clamp(Number(env.TERR_TRIBUTE_PCT ?? "0.5"), 0, 1),
      exileSeverity: clamp(Number(env.TERR_EXILE_SEVERITY ?? "0.5"), 0, 5),
      powerPerZone: clamp(Number(env.TERR_POWER_PER_ZONE ?? "0"), 0, 100000),
      seizeOnWin: (env.TERR_SEIZE_ON_WIN ?? "false").toLowerCase() === "true",
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
      salt: clampInt(Number(env.EVOLUTION_SALT ?? "0x65766f"), 0, 0x7fffffff),
      hatchLive,
      hatchSeedUsdc: clamp(Number(env.EVOLUTION_HATCH_SEED_USDC ?? "0.002"), 0.000001, 100),
      multiObjective: {
        // Phase 4 capability ④: multi-objective fitness + tournament selection. Shipped DISABLED (dark
        //     deploy): default OFF so parent choice is byte-for-byte the current top-1/elites path. When
        //     armed, the eligible pool (netUsdc>0 hard gate UNCHANGED) is ranked by a bounded weighted
        //     score and the primary parent is drawn by hash01 tournament. Set EVOLUTION_MULTI_OBJECTIVE=true to arm.
        enabled: (env.EVOLUTION_MULTI_OBJECTIVE ?? "false").toLowerCase() === "true",
        tournamentK: clampInt(Number(env.EVOLUTION_TOURNAMENT_K ?? "3"), 2, 16),
      },
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

    religion: {
      // ON by default: faith moves no money and touches no neuron — on a holy day it only lets the devoted
      // rest for one cron, and the chronicle gains a religion. Set RELIGION_ENABLED=false to restore today's
      // readings byte-for-byte.
      enabled: (env.RELIGION_ENABLED ?? "true").toLowerCase() !== "false",
      holyEvery: clampInt(Number(env.RELIGION_HOLY_EVERY || "48"), 2, 400),
      devotionMin: clamp(Number(env.RELIGION_DEVOTION_MIN || "0.5"), 0, 1),
      sectCap: clampInt(Number(env.RELIGION_SECT_CAP || "8"), 1, 16),
    },

    tech: {
      // ON by default: an invention moves no money and touches no neuron — it only gives the civilisation
      // level the historian already reckons some CONTENT, and writes chapters into the chronicle. Set
      // TECH_ENABLED=false to restore today's readings byte-for-byte (the permanent fallback / rollback).
      enabled: (env.TECH_ENABLED ?? "true").toLowerCase() !== "false",
      // 0.75 rather than 0.5 so a gated rung lands within a generation or so of its gates opening: the ladder
      // is meant to be seen climbing by anyone who watches for an afternoon.
      discoverP: clamp(Number(env.TECH_DISCOVER_P || "0.75"), 0, 1),
      adoptPct: clamp(Number(env.TECH_ADOPT_PCT || "0.1"), 0.01, 1),
    },

    cities: {
      // ON by default: a settlement moves no money and touches no neuron — it reads the zone ledger the
      // territory layer already keeps and gives the places names. Set CITIES_ENABLED=false to restore today's
      // readings byte-for-byte (the permanent fallback / rollback). Note the map is EMPTY while the territory
      // layer is off (no per-fly zone ⇒ nothing to settle), exactly as the read-out documents.
      enabled: (env.CITIES_ENABLED ?? "true").toLowerCase() !== "false",
      // thresholds sit low on purpose: a fly's zone is its house's home zone, so kin cluster — a house of nine
      // is already a city, and the swarm's first town arrives within the first hour rather than the first day.
      hamletMin: clampInt(Number(env.CITY_HAMLET_MIN || "2"), 1, 64),
      townMin: clampInt(Number(env.CITY_TOWN_MIN || "5"), 1, 128),
      cityMin: clampInt(Number(env.CITY_CITY_MIN || "9"), 1, 256),
      urbanShare: clamp(Number(env.CITY_URBAN_SHARE || "0.35"), 0, 1),
    },

    apprentice: {
      // ON by default (matching ⑤ culture / ⑪ faith / ⑬ tech / ⑭ cities): an apprenticeship moves no money and
      // touches no neuron — it only tells the story of what the swarm actually REMEMBERS as against what it
      // invented. APPRENTICE_ENABLED=false restores today's readings byte-for-byte (the permanent rollback).
      enabled: (env.APPRENTICE_ENABLED ?? "true").toLowerCase() !== "false",
      learnPct: clamp(Number(env.APPRENTICE_LEARN_PCT || "0.22"), 0, 1),
      selfPct: clamp(Number(env.APPRENTICE_SELF_PCT || "0.05"), 0, 1),
      schoolMin: clampInt(Number(env.APPRENTICE_SCHOOL_MIN || "3"), 2, 64),
    },

    archive: {
      enabled: (env.ARCHIVE_ENABLED ?? "true").toLowerCase() !== "false",
      recordP: clamp(Number(env.ARCHIVE_RECORD_PCT || "0.02"), 0, 1),
      decodeP: clamp(Number(env.ARCHIVE_DECODE_PCT || "0.08"), 0, 1),
      burnCivMax: clampInt(Number(env.ARCHIVE_BURN_CIV_MAX || "15"), 0, 100),
    },
    workshop: {
      enabled: (env.WORKSHOP_ENABLED ?? "true").toLowerCase() !== "false",
      reinventP: clamp(Number(env.WORKSHOP_REINVENT_PCT || "0.03"), 0, 1),
    },
    court: {
      enabled: (env.COURTS_ENABLED ?? "true").toLowerCase() !== "false",
      fileP: clamp(Number(env.COURT_FILE_PCT || "0.25"), 0, 1),
      jurySize: clampInt(Number(env.COURT_JURY_SIZE || "5"), 3, 9),
    },
    games: {
      enabled: (env.GAMES_ENABLED ?? "true").toLowerCase() !== "false",
      openP: clamp(Number(env.GAMES_OPEN_PCT || "0.6"), 0, 1),
    },
    guilds: {
      enabled: (env.GUILD_ENABLED ?? "true").toLowerCase() !== "false",
      quorum: clampInt(Number(env.GUILD_QUORUM || "8"), 3, 100),
      shareP: clamp(Number(env.GUILD_SHARE_P || "0.5"), 0, 1),
    },
    lexicon: {
      enabled: (env.LEX_ENABLED ?? "true").toLowerCase() !== "false",
    },
    rumor: {
      enabled: (env.RM_ENABLED ?? "true").toLowerCase() !== "false",
    },
    norms: {
      // ㉛ Shipped DISABLED (dark deploy): the default is "false", so an unset NORMS_ENABLED leaves the membrane
      //     inert and the chronicle byte-for-byte the pre-Norms build. Flip on by hand.
      enabled: (env.NORMS_ENABLED ?? "false").toLowerCase() === "true",
      // NaN-safe + HARD-CAPPED at 0.3 (the Channel-A ceiling the plan mandates): this scales a CURRENT injected
      //     into the connectome, so a malformed env var must fall back to 0.3 rather than leak NaN, and can never
      //     be dialed above the bounded-stimulus red line. clamp() alone does NOT guard NaN, hence the finite check.
      maxIntensity: (() => {
        const mi = Number(env.NORMS_STIMULUS_MAX ?? "0.3");
        return clamp(Number.isFinite(mi) ? mi : 0.3, 0, 0.3);
      })(),
    },
    conventions: {
      // ㉜ Shipped DISABLED (dark deploy): the default is "false", so an unset CONVENTIONS_ENABLED leaves the
      //     membrane inert and the chronicle byte-for-byte the pre-Conventions build. Flip on by hand.
      enabled: (env.CONVENTIONS_ENABLED ?? "false").toLowerCase() === "true",
      // NaN-safe + HARD-CAPPED at 0.3: this scales the Channel-A causal leg AND bounds the 1.5× breach penalty
      //     (min(BREACH_BASE × 1.5, cap)), so the penalty can never exceed the bounded-stimulus red line and a
      //     malformed env var falls back to 0.3 rather than leak NaN. clamp() alone does NOT guard NaN.
      maxIntensity: (() => {
        const mi = Number(env.CONVENTIONS_STIMULUS_MAX ?? "0.3");
        return clamp(Number.isFinite(mi) ? mi : 0.3, 0, 0.3);
      })(),
    },
    rules: {
      // ㉝ Shipped DISABLED (dark deploy): the default is "false", so an unset RULES_ENABLED leaves the membrane
      //     inert, no modifier is ever injected into the economy, and the chronicle is byte-for-byte the pre-Rules
      //     build. Flip on by hand. This is the highest-risk membrane, so it ships dark behind an explicit switch.
      enabled: (env.RULES_ENABLED ?? "false").toLowerCase() === "true",
      // The CONSTITUTIONAL BAND as CODE-DEFAULT constants (wrangler.toml is NOT touched). These are the shipped
      //     band edges; rules.ts normaliseBand() re-clamps them into the HARD envelope [0.5, 2.0] at construction,
      //     and economy.ts re-clamps every modifier independently at each use point — so even a malformed value
      //     here can never let a multiplier escape [HARD_BUY_MIN, HARD_BUY_MAX] / [HARD_CP_MIN, HARD_CP_MAX].
      buyMin: 0.5,
      buyMax: 2.0,
      cpMin: 0.5,
      cpMax: 2.0,
    },
    treaty: {
      enabled: (env.TR_ENABLED ?? "true").toLowerCase() !== "false",
    },
    works: {
      enabled: (env.WORKS_ENABLED ?? "true").toLowerCase() !== "false",
    },
    guardians: {
      enabled: (env.GUARDIANS_ENABLED ?? "true").toLowerCase() !== "false",
    },
    reform: {
      // ㉘ Shipped DISABLED (grey-release): the default is "false", so an unset REFORM_ENABLED leaves the
      //     reform layer inert and the chronicle byte-for-byte the pre-Reform build. Flip on by hand.
      enabled: (env.REFORM_ENABLED ?? "false").toLowerCase() !== "false",
      // #123 Reform V2: jubilee cooldown re-arm (deadlock fix) + levy deductions → commons pool scoreboard.
      //     Shipped DISABLED (dark deploy): OFF ⇒ old behaviour byte-for-byte (broken re-arm + discarded levies).
      v2Enabled: (env.REFORM_V2_ENABLED ?? "false").toLowerCase() === "true",
    },
    temple: {
      // ㉙ Shipped ENABLED (the ㉔-㉗ default-ON 口径): the default is "true", so an unset TEMPLE_ENABLED opens
      //     the burn-to-influence door. Set TEMPLE_ENABLED=false to leave the layer inert and the chronicle
      //     byte-for-byte the pre-Temple build.
      enabled: (env.TEMPLE_ENABLED ?? "true").toLowerCase() !== "false",
    },
    land: {
      // ㉚ Shipped ENABLED (the ㉔-㉙ default-ON 口径): the default is "true", so an unset LAND_ENABLED opens the
      //     burn-to-claim grid. Set LAND_ENABLED=false to leave the layer inert and the chronicle byte-for-byte
      //     the pre-Land build.
      enabled: (env.LAND_ENABLED ?? "true").toLowerCase() !== "false",
    },

    playbook: {
      // ㉕ PLAYBOOK (Phase 1, capability ①): consequence-driven long-term memory. Shipped DISABLED
      //     (dark deploy): default OFF so the economy is byte-for-byte the pre-playbook build until
      //     explicitly armed. Moves no money, touches no neuron; only reweights counterparty choice
      //     and good selection within existing caps. Set PLAYBOOK_ENABLED=true to arm.
      enabled: (env.PLAYBOOK_ENABLED ?? "false").toLowerCase() === "true",
    },

    // Shadow-compare (#87): the evolution decision mirror. Fail-closed: only an exact "true" arms it.
    // The remaining knobs are code-defaults only (no env vars / no binding slots) — same pattern as
    // netFlushBudgetPerCron (#98 Fix 2: "code-default only, no env var").
    shadowCompare: {
      enabled: (env.ECONOMY_EVOLUTION_SHADOW ?? "false").toLowerCase() === "true",
      everyNCrons: 1,
      maxDecisionsPerCron: 64,
      maxRowsPerCronToD1: 32,
    },

    // #123 Equity tilt: market-side counterparty weight redistribution. Fail-closed: only "true" arms it.
    // strength=0 ⇒ multiplier ≡ 1.0 even when enabled (multiplicative identity, zero behavioural change).
    equityTilt: (() => {
      const raw = (env.EQUITY_TILT_BAND ?? "0.5,2.0").split(",");
      const lo = clamp(Number(raw[0]) || 0.5, 0.01, 2.0);
      const hi = clamp(Number(raw[1]) || 2.0, lo, 10.0);
      return {
        enabled: (env.EQUITY_TILT_ENABLED ?? "false").toLowerCase() === "true",
        band: [lo, hi] as [number, number],
        strength: clamp(Number(env.EQUITY_TILT_STRENGTH ?? "0") || 0, 0, 1),
      };
    })(),

    // #123 Dead-house sweep: route zero-living-member house estates to commons pool. Fail-closed.
    deadHouseSweep: {
      enabled: (env.DEAD_HOUSE_SWEEP_ENABLED ?? "false").toLowerCase() === "true",
    },

    // #143 Estate relief (ONCHAIN): dead-wallet USDC → escrow → the poorest living. Fail-safe parsed (clampInt-
    // style) so a bad var can never arm a sub-cron cadence, a negative budget, or an unbounded sweep. ARMED LIVE
    // (2026-09-30): the 128 text-binding wall is spent so an operator cannot add a secret/var — the posture is
    // carried as code defaults instead: enabled TRUE, ESTATE_RELIEF_SHADOW FALSE (real USDC moves), cadence 6,
    // chunk 0.02, daily budget 1 (all far below the money caps). ECONOMY_REAL_SPEND="false" is the instant kill
    // switch (the executors return before any broadcast), and setting ESTATE_RELIEF_SHADOW=true back + redeploy
    // is the seconds-level revert to dry-run. All legs stay on the same mnemonic's wallets (dead → our escrow →
    // living), move money only on a mined EIP-3009 receipt, and re-check the tombstone (a reclaimed id is never swept).
    estateRelief: (() => {
      const everyN = clamp(Math.floor(Number(env.ESTATE_RELIEF_EVERY_N_CRON ?? "6") || 0), 0, 1_000_000);
      const chunk = Math.max(0, Number(env.ESTATE_RELIEF_CHUNK_USDC ?? "0.02") || 0);
      const budget = Math.max(0, Number(env.ESTATE_RELIEF_DAILY_BUDGET_USDC ?? "1") || 0);
      const sweeps = clamp(Math.floor(Number(env.ESTATE_RELIEF_MAX_SWEEPS_PER_CRON ?? "4") || 0), 0, 64);
      return {
        enabled: (env.ESTATE_RELIEF_ENABLED ?? "true").toLowerCase() === "true",
        shadow: (env.ESTATE_RELIEF_SHADOW ?? "false").toLowerCase() !== "false",
        reliefEveryNCrons: everyN,
        reliefChunkUsdc: chunk,
        reliefDailyBudgetUsdc: budget,
        maxSweepsPerCron: sweeps,
        backfill: (env.ESTATE_RELIEF_BACKFILL ?? "true").toLowerCase() === "true",
      };
    })(),

    // System One (Jev) read-out side-plane. DARK: fail-closed `=== "true"`, and the client only ever fires
    // when BOTH enabled AND a resolved apiKey are present (jevIsLive gate). Absent vars ⇒ inert ⇒ no request,
    // no /economy jev key ⇒ byte-for-byte today's build. baseUrl/model/timeout are code-defaults (binding wall
    // is full, so the operator adds JEV_ENABLED/JEV_API_KEY only after evicting a low-priority var).
    jev: {
      enabled: (env.JEV_ENABLED ?? "false").toLowerCase() === "true",
      apiKey: (env.JEV_API_KEY ?? "").trim() || null,
      baseUrl: (env.JEV_BASE_URL ?? "").trim() || "https://api.typesafe.ai",
      model: (env.JEV_MODEL ?? "").trim() || "jev-latest",
      timeoutMs: clamp(Math.floor(Number(env.JEV_TIMEOUT_MS ?? "900") || 900), 100, 15_000),
    },

    // R5 Fix A (#126): on-chain balance gate in the trade planner. Fail-closed: only an exact "true" arms it.
    // OFF (default) ⇒ queueNet never reads on-chain balances and is byte-for-byte today's planner.
    onchainBalanceGate: {
      enabled: (env.ECONOMY_ONCHAIN_BALANCE_GATE ?? "false").toLowerCase() === "true",
    },

    // R5 Fix B (#126): periodic mirror re-align to on-chain truth. Code-default only (no binding slot).
    // 0 (default) ⇒ disabled/never. N>0 ⇒ re-align every Nth cron. Parsed fail-safe: a NaN/negative/huge var
    // clamps to a safe integer in [0, 1e6], so a bad value can never arm a sub-cron or divide-by-zero resync.
    mirrorResync: {
      everyNCrons: clamp(Math.floor(Number(env.ECONOMY_MIRROR_RESYNC_EVERY_N_CRON ?? "0") || 0), 0, 1_000_000),
    },

    strategy: {
      // Phase 2b capability ②: GP strategy genome. Shipped DISABLED (dark deploy): default OFF so the
      //     economy is byte-for-byte the Phase 1 build. When armed, per-fly expression trees modulate
      //     buyProbability / pickCounterparty / dealAmount / prediction score WITHIN existing hard caps.
      //     Never touches connectome/genome/manifestHash. Set STRATEGY_ENABLED=true to arm.
      enabled: (env.STRATEGY_ENABLED ?? "false").toLowerCase() === "true",
    },
    elites: {
      // Phase 2b capability ②: MAP-Elites novelty archive. Shipped DISABLED (dark deploy): default OFF
      //     so planEvolution uses the pure-PnL selection byte-for-byte. When armed, a bounded behavioural
      //     archive drives novelty exploration alongside PnL fitness. Set ELITES_ENABLED=true to arm.
      enabled: (env.ELITES_ENABLED ?? "false").toLowerCase() === "true",
    },

    cultural: {
      // Phase 3 capability ③: vertical cultural transmission. Shipped DISABLED (dark deploy): default OFF
      //     so a child hatches blank, byte-for-byte the Phase 2b build. When armed, a真亲子 hatch copies a
      //     DISCOUNTED subset of the parent's social memory (positive bond ×50%, negative ×25%, rep ×50%)
      //     plus a COMPRESSED playbook summary (per (good,regime) net outcome + valid rate) into the child
      //     as a prior. Strictly真亲子 only: an id-reuse (reopenSlot) hatch never inherits the dead fly's
      //     residue. Moves no money, touches no neuron. Set CULTURAL_TRANSMISSION_ENABLED=true to arm.
      enabled: (env.CULTURAL_TRANSMISSION_ENABLED ?? "false").toLowerCase() === "true",
    },
    lamarck: {
      // Phase 3 capability ③: Lamarckian genome imprinting. Shipped DISABLED (dark deploy): default OFF so
      //     the child genome is exactly the mutate/cross output, byte-for-byte Phase 2b. When armed, the
      //     parent's lifetime performance vector biases the child's 4 heritable genome scalars by ±5% (plus
      //     a small deterministic rngSeed jitter) ON TOP of mutate/cross, then clamps back into legal bounds
      //     — folded into genomeHash so the on-chain identity stays reproducible. manifestHash never rotates
      //     (only scalar VALUES change; no topology, no sensory channel). Set LAMARCK_ENABLED=true to arm.
      enabled: (env.LAMARCK_ENABLED ?? "false").toLowerCase() === "true",
    },

    socialStimulus: {
      // OFF by default (dark deploy): the bus writes straight into the live neural input that drives real
      // trades, so it ships gated and is opened only after an OFF deploy proves the cron byte-for-byte
      // unchanged. Set SOCIAL_STIMULUS_ENABLED=true to let the swarm feel its own civilizational climate.
      enabled: (env.SOCIAL_STIMULUS_ENABLED ?? "false").toLowerCase() === "true",
      // NaN-safe on purpose: this ceiling scales a CURRENT injected into the connectome, so a malformed env
      // var must fall back to 0.5 rather than leak NaN (which would poison every neuron membrane irreversibly).
      // clamp() alone does NOT guard NaN (unlike clampInt), so the finite check is explicit here.
      maxIntensity: (() => {
        const mi = Number(env.SOCIAL_STIMULUS_MAX ?? "0.5");
        return clamp(Number.isFinite(mi) ? mi : 0.5, 0, 1);
      })(),
    },

    poet: {
      // OFF by default (dark deploy): the poet is a pure read-out (it moves no money and never writes back into
      // the connectome), but it ships gated so an OFF deploy first proves /poem serves an empty chain (200, never
      // a 500) before the laureate is crowned. Set POET_ENABLED=true to let the swarm write its hourly poem.
      enabled: (env.POET_ENABLED ?? "false").toLowerCase() === "true",
      // NaN-safe on purpose (the ① lesson): a malformed knob must fall back to its default, never leak NaN into
      // the ring bound / cadence. clampInt is already NaN-safe, but the Number() parse is guarded explicitly too.
      cap: (() => {
        const n = Number(env.POEMS_CAP ?? "64");
        return clampInt(Number.isFinite(n) ? n : 64, 1, 512);
      })(),
      minCrons: (() => {
        const n = Number(env.POET_MIN_CRONS ?? "60");
        return clampInt(Number.isFinite(n) ? n : 60, 1, 100000);
      })(),
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

    cron: {
      persistShardThreshold: 262_144,   // 256 KB — #98 Fix 1
      persistChunkSize: 262_144,        // 256 KB — #98 Fix 1
      wallClockWarnMs: 45_000,          // 45 s  — #98 Fix 4
      netPendingAlertThreshold: 500,    // #98 Fix 3
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

/** Whole-MURMUR → raw 18-dec decimal string. NaN-safe (unlike clamp): a malformed knob falls back to dflt. */
function murmurToRaw(x: number, dflt: number): string {
  const n = Number.isFinite(x) && x > 0 ? x : dflt;
  return (BigInt(Math.floor(n)) * 10n ** 18n).toString();
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
