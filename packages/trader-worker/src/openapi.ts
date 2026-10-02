// The murmur public API — an OpenAPI 3.1 contract for the free, read-only endpoints the Worker already
// serves at https://api.muros.live. This object is the single source of truth: it is served verbatim at
// GET /openapi.json (see index.ts) and rendered by the frontend /developers page, so the docs can never
// drift from a hand-maintained copy.
//
// Design notes:
//  • Every path here is FREE, needs no auth/API key, and is CORS-enabled (Access-Control-Allow-Origin: *).
//  • Amounts come in two flavours: `*Atomic` / `amount` / `balance` are exact integer strings in the asset's
//    base unit (USDC has 6 decimals); `*Usdc` are convenience floats. Prefer the atomic strings for maths.
//  • The one PAID endpoint (GET /signal/pulse) is an x402 paywall: it answers 402 with machine-readable
//    payment requirements, and only returns the signal once the caller attaches a valid X-PAYMENT. It is
//    documented here for completeness but is not part of the free surface.
//  • Unstable / debug endpoints (POST /tick, POST /reset — ADMIN_TOKEN gated) are intentionally NOT listed.

const API_ERROR = {
  type: "object",
  description:
    "The unified error envelope. `error` is a human-readable message (kept as a string for backward compatibility); `code` is a stable machine-readable slug; `status` mirrors the HTTP status.",
  required: ["error", "code", "status"],
  additionalProperties: false,
  properties: {
    error: { type: "string", description: "Human-readable message.", example: "tx required" },
    code: {
      type: "string",
      description: "Stable error slug.",
      enum: ["not_found", "bad_request", "internal_error", "payment_required", "forbidden", "service_unavailable"],
      example: "bad_request",
    },
    status: { type: "integer", description: "HTTP status code.", example: 400 },
  },
} as const;

/**
 * The A3 neuromodulatory read-out of one fly's modulatory layer (fly-brain/neuromod.ts). A PURE,
 * manifest-neutral read-out: these scalars never enter the brain-manifest hash and never touch the frozen
 * neural evidence behind a settlement, so they are safe to serve and safe to ignore.
 */
const NEUROMOD = {
  type: "object",
  description:
    "One fly's DA/OA-like neuromodulatory state, reduced from its modulatory layer's firing rates. The modulatory population is split deterministically by index into a lower DA-like half and an upper OA-like half. Each half is reported TWICE: as a normalized 0..1 tone and as its RAW mean firing rate in Hz (refHz = 40 maps raw → normalized). Observed only unless NEUROMOD_GATING is enabled (production default off), in which case octopamine additionally shades arousal.",
  additionalProperties: false,
  required: ["dopamine", "octopamine", "learningRateGate", "daHz", "oaHz"],
  properties: {
    dopamine: { type: "number", description: "DA-like reward/reinforcement tone, normalized 0..1 = clamp01(daHz / 40)." },
    octopamine: { type: "number", description: "OA-like arousal/exploration tone, normalized 0..1 = clamp01(oaHz / 40)." },
    learningRateGate: { type: "number", description: "RESERVED A1 plasticity gate ∈ [0.05, 1], derived from dopamine. Not consumed by any synaptic weight update yet." },
    daHz: { type: "number", description: "RAW (un-normalized) mean firing rate of the DA-like modulatory half, in Hz. 0 when that half is silent or empty; never NaN." },
    oaHz: { type: "number", description: "RAW (un-normalized) mean firing rate of the OA-like modulatory half, in Hz. 0 when that half is silent or empty; never NaN." },
  },
} as const;

const COLLECTIVE = {
  type: "object",
  description: "The swarm's aggregate neural read-out this tick (a single reduced 'mood').",
  additionalProperties: false,
  properties: {
    temperature: { type: "number", description: "Market temperature 0..1 driving arousal." },
    regime: { type: "string", enum: ["HOT", "CALM", "COLD"], description: "Discretised temperature band." },
    vitality: { type: "number", description: "Fraction of the population still alive (0..1)." },
    size: { type: "integer", description: "Living fly count." },
    arousal: { type: "number" },
    cohesion: { type: "number" },
    rest: { type: "number" },
    wingbeat: { type: "number" },
    states: {
      type: "object",
      description: "Headcount per behavioural state.",
      additionalProperties: false,
      properties: {
        AGITATE: { type: "integer" },
        EXPLORE: { type: "integer" },
        AGGREGATE: { type: "integer" },
        REST: { type: "integer" },
      },
    },
    meanDopamine: { type: "number", description: "Mean normalized DA tone across the live roster, 0..1 (0 when the roster is empty). The swarm-level twin of each fly's `neuromod.dopamine`." },
    meanOctopamine: { type: "number", description: "Mean normalized OA tone across the live roster, 0..1 (0 when the roster is empty)." },
    meanDaHz: { type: "number", description: "Mean RAW DA-like half firing rate (Hz) across the live roster — the collective modulatory pulse in absolute units (0 when the roster is empty)." },
    meanOaHz: { type: "number", description: "Mean RAW OA-like half firing rate (Hz) across the live roster (0 when the roster is empty)." },
  },
} as const;

const FLY = {
  type: "object",
  description: "One fly's decoded neural drive + identity this tick.",
  additionalProperties: false,
  properties: {
    id: { type: "integer", description: "Stable 0-based population index." },
    state: { type: "string", enum: ["AGITATE", "EXPLORE", "AGGREGATE", "REST"] },
    arousal: { type: "number" },
    turnBias: { type: "number" },
    cohesion: { type: "number" },
    wingbeat: { type: "number" },
    rest: { type: "number" },
    temperament: { type: "number", description: "Per-fly fixed trait derived from its seed." },
    fingerprint: { type: "string", description: "Short hex identity of the fly's current neural reading." },
    neuromod: { $ref: "#/components/schemas/Neuromod" },
    genomeHash: { type: "string", description: "0x-prefixed 64-hex sha256 of the fly's canonical genome (empty string when unresolved)." },
    generation: { type: "integer", description: "Lineage generation (genesis = 0, offspring = max(parents) + 1)." },
    parents: { type: "array", items: { type: "string" }, description: "Parent genomeHashes (0x-prefixed): [] genesis, [a] mutate, [a,b] cross." },
  },
} as const;

const ECON_TOTALS = {
  type: "object",
  description: "Cumulative x402 settlement statistics (only mined, on-chain settlements count).",
  additionalProperties: false,
  properties: {
    volumeAtomic: { type: "string", description: "Total settled volume in USDC base units (integer string)." },
    volumeUsdc: { type: "number", description: "Total settled volume in USDC (float)." },
    count: { type: "integer", description: "Number of settled transfers." },
    settleOk: { type: "integer", description: "Lifetime mined on-chain net settlements (successes)." },
    settleFail: { type: "integer", description: "Lifetime on-chain net settlement attempts that failed to mine (incl. missing-signer, verify/settle failures)." },
    settleAttempts: { type: "integer", description: "settleOk + settleFail — real broadcast attempts (shadow dry-runs excluded)." },
    successRate: { type: ["number", "null"], description: "settleOk / settleAttempts (0..1), or null before any on-chain attempt." },
    liveAgents: { type: "integer", description: "Currently-LIVING agent wallets = every funded wallet minus the entombed (dead) ones. A buried fly keeps its ledger entry (dead:true) and a recycled slot reuses a wallet, so this counts who is actually flying, not wallets ever created." },
    meanBalanceUsdc: { type: "number" },
    gini: { type: "number", description: "Wealth inequality across agents (0..1)." },
    treasuryOutAtomic: { type: "string", description: "Total paid out from the funding treasury (integer string)." },
    richestId: { type: "integer" },
    poorestId: { type: "integer" },
    settleMsAvg: { type: ["integer", "null"], description: "Mean submit→finality latency (ms) of successful on-chain net settlements, or null before any timed success." },
    settleMsMax: { type: "integer", description: "Slowest successful settle latency (ms)." },
    settleMsLast: { type: "integer", description: "Most recent successful settle latency (ms)." },
    settleMsN: { type: "integer", description: "Number of timed successful settlements (the sample size behind settleMsAvg)." },
    netPending: { type: "integer", description: "Live gauge: pair-nets currently folded and awaiting broadcast (drains each cron)." },
    netPendingTrades: { type: "integer", description: "Live gauge: gross trades folded into the pending nets awaiting broadcast." },
  },
} as const;

const AGENT = {
  type: "object",
  description: "One fly's autonomous economic wallet.",
  additionalProperties: false,
  properties: {
    id: { type: "integer" },
    address: { type: "string", description: "The agent's on-chain address (0x…)." },
    balance: { type: "string", description: "Balance in USDC base units (integer string)." },
    balanceUsdc: { type: "number" },
    paid: { type: "string", description: "Cumulative USDC paid out (atomic string)." },
    earned: { type: "string", description: "Cumulative USDC earned (atomic string)." },
    deals: { type: "integer", description: "Buy-side deals." },
    sales: { type: "integer", description: "Sell-side deals." },
  },
} as const;

const TRADE = {
  type: "object",
  description: "A single agent-to-agent x402 deal (one micropayment line).",
  additionalProperties: false,
  properties: {
    tick: { type: "integer" },
    ts: { type: "integer", description: "Unix ms." },
    good: { type: "string", description: "What was bought: signal | momentum | attestation." },
    resource: { type: "string", description: "The x402 resource id charged." },
    fromId: { type: "integer" },
    toId: { type: "integer" },
    from: { type: "string", description: "Payer address." },
    to: { type: "string", description: "Payee address." },
    amount: { type: "string", description: "Amount in USDC base units (integer string)." },
    txHash: { type: "string", description: "On-chain settlement tx (empty when netted/pending or simulated)." },
    valid: { type: "boolean" },
    reason: { type: "string", description: "Settlement outcome / rejection reason." },
    simulated: { type: "boolean", description: "True only on keyless local dev; false in production." },
  },
} as const;

const STRUCTURAL_SPEC = {
  type: "object",
  description:
    "A compact, quantised, ULP-safe structural identity of one connectome. Two brains with the same (seed, options) produce an identical spec; a wiring change cannot slip through (topology edgeHash + integer checksums).",
  additionalProperties: false,
  properties: {
    neuronCount: { type: "integer" },
    synapseCount: { type: "integer" },
    byKind: { type: "object", description: "Neuron count per kind (sensory/inter/modulatory/motor).", additionalProperties: { type: "integer" } },
    motorChannels: { type: "object", description: "Motor-neuron count per channel (fixed order).", additionalProperties: { type: "integer" } },
    sensoryChannels: { type: "object", description: "Sensory-neuron count per channel (fixed order).", additionalProperties: { type: "integer" } },
    tauMicro: { type: "integer", description: "Σ round(tau·1e6) over all neurons — exact integer (tau comes from the integer PRNG)." },
    threshMicro: { type: "integer", description: "Σ round(vThresh·1e6) over all neurons — exact integer." },
    weightMilli: { type: "integer", description: "Σ round(w·1e3) over all synapses — signed, coarse to stay ULP-safe (w comes via gaussian)." },
    fanInMeanMilli: { type: "integer", description: "Mean fan-in per neuron, in milli." },
    fanInMax: { type: "integer", description: "Max fan-in over all neurons." },
    edgeHash: { type: "string", description: "FNV-1a 32-bit fold over every (pre, post, round(w·1e3)) triple — the topology fingerprint (8 hex chars)." },
  },
} as const;

/** The PROCEDURAL (PRNG) generator sizing — the legacy deterministic path (discriminant: no `mode` field). */
const CONNECTOME_SIZING_PRNG = {
  type: "object",
  description: "Procedural generator sizing: the per-kind neuron counts + connection density a verifier rebuilds every connectome from (production is the 10x brain). Present when FLYWIRE_TOPOLOGY is off.",
  additionalProperties: false,
  properties: {
    nSensory: { type: "integer" },
    nInterL1: { type: "integer" },
    nInterL2: { type: "integer" },
    nModulatory: { type: "integer" },
    nMotorPerChannel: { type: "integer" },
    density: { type: "number" },
  },
} as const;

/** The FLYWIRE-LITERAL topology recorded when FLYWIRE_TOPOLOGY is on (production): the fixed real FAFB 783
 *  MB+CX subgraph + the seed-driven jitter gains (discriminant: `mode: "flywire"`). */
const CONNECTOME_FLYWIRE = {
  type: "object",
  description:
    "FlyWire-literal topology: the FIXED real FAFB 783 (FlyWire, CC-BY 4.0) Mushroom-Body + Central-Complex subgraph every fly shares, plus the gains that the per-fly seed applies as multiplicative weight/LIF jitter. The topology is not seedable — only the perturbation is. Recognised by `mode: \"flywire\"`.",
  additionalProperties: false,
  required: ["mode", "nNeurons", "nSynapses"],
  properties: {
    mode: { type: "string", enum: ["flywire"], description: "Discriminant for the FlyWire-literal shape." },
    nNeurons: { type: "integer", description: "Neurons in the fixed subgraph.", example: 10361 },
    nSynapses: { type: "integer", description: "Synapses in the fixed subgraph.", example: 467314 },
    fanInMean: { type: "number", description: "Mean fan-in per neuron (synapses/neurons).", example: 45.1 },
    weightGain: { type: "number", description: "Multiplicative gain (and weight ceiling) applied to the literal synaptic weights." },
    weightJitter: { type: "number", description: "Seed-driven multiplicative jitter amplitude on each synaptic weight." },
    threshGain: { type: "number", description: "Seed-driven gain on the LIF firing threshold." },
    tauGain: { type: "number", description: "Seed-driven gain on the LIF membrane time constant." },
  },
} as const;

const BRAIN_MANIFEST = {
  type: "object",
  description:
    "The committed brain manifest: everything needed to reproduce all 24 connectomes offline from their seeds. manifestHash = sha256(canonical(manifest)).",
  additionalProperties: true,
  properties: {
    v: { type: "integer" },
    schema: { type: "string", example: "murmur-brain-manifest" },
    brainManifestVersion: { type: "integer" },
    proofV: { type: "integer" },
    policy: { type: "string", example: "econ-v1" },
    codeVersion: { type: ["string", "null"], description: "Git sha when built with one; null on edge builds." },
    chainId: { type: "integer", example: 5042 },
    chainTag: { type: "string", example: "arc-mainnet" },
    population: {
      type: "object",
      additionalProperties: false,
      properties: {
        size: { type: "integer", example: 24 },
        seedBase: { type: "integer", example: 42 },
        seedStride: { type: "integer", example: 7919 },
        seedFormula: { type: "string", example: "seed[i] = (seedBase + i * seedStride) >>> 0" },
      },
    },
    connectome: {
      description:
        "The generator identity of the swarm's brains — ONE OF two shapes: the procedural (PRNG) sizing, or the FlyWire-literal topology served in production. Discriminate on `mode: \"flywire\"`.",
      oneOf: [CONNECTOME_SIZING_PRNG, CONNECTOME_FLYWIRE],
    },
    lif: { type: "object", description: "The LIF integrator constants.", additionalProperties: { type: "number" } },
    neuronBaseParams: { type: "object", description: "Per-kind base membrane parameters (sensory/inter/modulatory/motor).", additionalProperties: true },
    neuronJitter: { type: "object", additionalProperties: false, properties: { min: { type: "number" }, span: { type: "number" } } },
    decoder: { type: "object", description: "The motor-decoder configuration (temperature thresholds, quantiles, hysteresis).", additionalProperties: { type: "number" } },
    provenance: {
      type: "object",
      description: "Honest FlyWire provenance + the no-LLM declaration.",
      additionalProperties: true,
      properties: {
        name: { type: "string" },
        architecture: { type: "string" },
        flywireLiteral: { type: "boolean", description: "True = the connectomes ARE the literal FlyWire FAFB_783 MB+CX subgraph (10,361 neurons / 467,314 synapses, CC-BY 4.0): the topology is fixed and the seed only jitters synaptic weights + LIF parameters (production). False = connectomes are generated deterministically from the seed — FlyWire-architecture-inspired, not a literal copy." },
        generatedDeterministically: { type: "boolean" },
        reproducibleFromSeed: { type: "boolean" },
        llmInvolved: { type: "boolean", description: "Always false — no LLM anywhere in the loop." },
        note: { type: "string" },
      },
    },
    llm: { type: "object", additionalProperties: false, properties: { used: { type: "boolean", example: false }, statement: { type: "string" } } },
    flies: {
      type: "array",
      description: "Per-fly seed + its committed structural identity (24 entries in production).",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          id: { type: "integer" },
          seed: { type: "integer" },
          structural: STRUCTURAL_SPEC,
        },
      },
    },
  },
} as const;

const GENOME = {
  type: "object",
  description:
    "A connectome's complete heritable identity: the effective generator parameters that deterministically rebuild the exact brain offline. genomeHash = sha256(canonical(genome)) — recompute it from these fields to confirm identity, then rebuild the connectome to re-derive its StructuralSpec.",
  additionalProperties: false,
  required: ["v", "seed", "nSensory", "nInterL1", "nInterL2", "nModulatory", "nMotorPerChannel", "density"],
  properties: {
    v: { type: "integer", description: "Genome schema version.", example: 1 },
    seed: { type: "integer", description: "uint32 PRNG seed — the wiring identity." },
    nSensory: { type: "integer" },
    nInterL1: { type: "integer" },
    nInterL2: { type: "integer" },
    nModulatory: { type: "integer" },
    nMotorPerChannel: { type: "integer" },
    density: { type: "number", description: "Synapse density fraction (0,1], rounded to 4dp." },
  },
} as const;

const LINEAGE_ENTRY = {
  type: "object",
  description:
    "One connectome individual in the breeding market + its ancestry. Genesis roots are the 24 base-population brains (op=genesis, generation 0, no parents); bred individuals record their parents, the pure operator applied, the generation, the credited breeder and the operator's rngSeed — enough for anyone to re-derive the offspring genome.",
  additionalProperties: false,
  required: ["genomeHash", "genome", "parents", "op", "generation"],
  properties: {
    genomeHash: { type: "string", description: "sha256(canonical(genome)), 64 lowercase hex (no 0x) — the on-chain identity." },
    genome: GENOME,
    parents: { type: "array", items: { type: "string" }, description: "Parent genomeHashes: [] genesis, [a] mutate, [a,b] cross." },
    op: { type: "string", enum: ["genesis", "mutate", "cross"], description: "The genetic operator that produced this individual." },
    generation: { type: "integer", description: "0 for genesis roots; max(parents.generation)+1 otherwise." },
    breeder: { type: ["string", "null"], description: "Address credited with breeding (royalty payee off-chain); null for genesis roots." },
    rngSeed: { type: ["integer", "null"], description: "The integer seed the operator used — recorded so the offspring is reproducible; null for genesis." },
    ts: { type: "integer", description: "ms epoch when bred (0 for genesis roots)." },
    commitTx: { type: ["string", "null"], description: "On-chain ConnectomeLineage commit tx (0x…), when anchored; null otherwise." },
  },
} as const;

const COMMUNITY_TALLY = {
  type: "object",
  description:
    "Weighted vote tally for a proposal. `for`/`against`/`abstain`/`total` are exact MURMUR base-unit integer strings (18 decimals); the `*Fmt` fields are human-readable. Each voter's weight is their balanceOf at vote time.",
  additionalProperties: false,
  properties: {
    for: { type: "string", description: "Total weight FOR (raw 18dp integer string)." },
    against: { type: "string", description: "Total weight AGAINST (raw)." },
    abstain: { type: "string", description: "Total weight ABSTAIN (raw)." },
    total: { type: "string", description: "Sum of all weight (raw)." },
    voters: { type: "integer", description: "Distinct voters (one vote per address per proposal)." },
    forFmt: { type: "string", description: "Human-readable MURMUR." },
    againstFmt: { type: "string" },
    abstainFmt: { type: "string" },
    totalFmt: { type: "string" },
  },
} as const;

const COMMUNITY_POST = {
  type: "object",
  description:
    "A plaza post (proposalId null) or a proposal reply (proposalId set). `authorBal` is the poster's MURMUR balanceOf snapshot taken at post time, so the feed shows weight without a live chain read per row.",
  additionalProperties: false,
  properties: {
    id: { type: "integer" },
    author: { type: "string", description: "Lowercased 0x… address (== the recovered EIP-712 signer)." },
    body: { type: "string" },
    proposalId: { type: ["integer", "null"], description: "null = plaza post; else the proposal this replies to." },
    authorBal: { type: "string", description: "MURMUR balance at post time (raw 18dp integer string)." },
    authorBalFmt: { type: "string", description: "Human-readable MURMUR." },
    ts: { type: "integer", description: "Client-signed unix ms (validated within ±300s of server time)." },
    sig: { type: "string", description: "The EIP-712 Post signature (UNIQUE ⇒ replay guard)." },
  },
} as const;

const COMMUNITY_PROPOSAL = {
  type: "object",
  description:
    "A governance proposal + its live weighted tally. Open while now < deadline; voting closes at the deadline but replies continue afterward.",
  additionalProperties: false,
  properties: {
    id: { type: "integer" },
    author: { type: "string", description: "Lowercased 0x… proposer (held ≥ propose-min at creation)." },
    title: { type: "string" },
    body: { type: "string" },
    authorBal: { type: "string", description: "MURMUR balance at creation (raw 18dp integer string)." },
    authorBalFmt: { type: "string" },
    deadline: { type: "integer", description: "Unix ms after which voting closes." },
    ts: { type: "integer", description: "Unix ms created." },
    open: { type: "boolean", description: "now < deadline." },
    tally: COMMUNITY_TALLY,
  },
} as const;

const COMMUNITY_GATE = {
  type: "object",
  description:
    "A live, server-side MURMUR balanceOf read for one address + what it unlocks. The front-end gate is UX only; the server re-runs this exact check on every gated write, so a client can never forge eligibility.",
  additionalProperties: false,
  properties: {
    address: { type: "string" },
    balance: { type: "string", description: "Raw 18dp integer string." },
    balanceFmt: { type: "string", description: "Human-readable MURMUR." },
    canSpeak: { type: "boolean", description: "balance ≥ speak-min (post / reply / vote)." },
    canPropose: { type: "boolean", description: "balance ≥ propose-min (open a proposal)." },
    speakMin: { type: "string" },
    proposeMin: { type: "string" },
    speakMinFmt: { type: "string" },
    proposeMinFmt: { type: "string" },
    token: { type: ["string", "null"], description: "The MURMUR ERC-20 the gate reads (0x…); null when unconfigured." },
  },
} as const;

const COMMUNITY_TIMELINE_POINT = {
  type: "object",
  description:
    "One point on a proposal's cumulative tally curve: the weighted For/Against/Abstain totals immediately AFTER the accompanying vote event. Rebuilt from the append-only event log, so it stays correct across re-votes. `event.isLeadChange` flags every flip of the leading option — a late whale swing shows up as a sharp, flagged step rather than a silent overwrite.",
  additionalProperties: false,
  properties: {
    ts: { type: "integer", description: "Client-signed unix ms of the vote that produced this point." },
    recordedAt: { type: "integer", description: "Server unix ms when the worker accepted it (stable ordering)." },
    for: { type: "string", description: "Cumulative weight FOR after this event (raw 18dp)." },
    against: { type: "string", description: "Cumulative weight AGAINST (raw)." },
    abstain: { type: "string", description: "Cumulative weight ABSTAIN (raw)." },
    total: { type: "string", description: "for + against + abstain (raw)." },
    forFmt: { type: "string" },
    againstFmt: { type: "string" },
    abstainFmt: { type: "string" },
    voters: { type: "integer", description: "Distinct voters whose ballot is live at this point." },
    leader: { type: "string", enum: ["for", "against", "abstain", "none"], description: "Leading option at this point." },
    event: {
      type: "object",
      additionalProperties: false,
      description: "The vote that produced this point.",
      properties: {
        voter: { type: "string", description: "Lowercased 0x… voter." },
        choice: { type: "integer", enum: [0, 1, 2], description: "0 against · 1 for · 2 abstain." },
        weight: { type: "string", description: "That voter's balanceOf at vote time (raw)." },
        weightFmt: { type: "string" },
        ts: { type: "integer" },
        recordedAt: { type: "integer" },
        isRevote: { type: "boolean", description: "True when this replaced the voter's earlier ballot." },
        isLeadChange: { type: "boolean", description: "True when the leading option flipped at this point." },
      },
    },
  },
} as const;

const COMMUNITY_TIMELINE = {
  type: "object",
  description:
    "A proposal's full voting history as a point-in-time cumulative curve — the data behind the per-proposal tally graph. `tally` is the authoritative current tally (one live ballot per voter); `series` is the ordered curve rebuilt from every vote and re-vote, so how the result evolved (including any last-hour swing) is fully transparent.",
  additionalProperties: false,
  properties: {
    proposalId: { type: "integer" },
    start: { type: "integer", description: "Proposal creation unix ms." },
    deadline: { type: "integer", description: "Voting closes at this unix ms." },
    now: { type: "integer" },
    open: { type: "boolean", description: "now < deadline." },
    tally: COMMUNITY_TALLY,
    series: { type: "array", items: COMMUNITY_TIMELINE_POINT, description: "Cumulative tally after each vote event, oldest first." },
    eventCount: { type: "integer", description: "Number of vote events (== series length)." },
  },
} as const;

// ---- PoCA (Proof of Continuous Agency): the hash-chained, epoch-sealed, on-chain-anchored proof that
// behaviour is produced continuously by the declared program (no silent rewrite / reset / takeover). ----

const POCA_MERKLE_STEP = {
  type: "object",
  description:
    "One sibling in a Merkle inclusion path. `direction` 0 ⇒ the current node is the LEFT child (parent = sha256(cur || sibling)); 1 ⇒ the current node is the RIGHT child (parent = sha256(sibling || cur)).",
  additionalProperties: false,
  properties: {
    sibling: { type: "string", description: "64-hex sibling node hash.", example: "0ab1…" },
    direction: { type: "integer", enum: [0, 1], description: "0 ⇒ current node is the left child; 1 ⇒ the right child." },
  },
  required: ["sibling", "direction"],
} as const;

const POCA_PROOF = {
  type: "object",
  description:
    "A Merkle inclusion proof binding one cron digest to its epoch root. Recompute: fold `digest` up through `path` (each step's `direction` says which side) and check you land on `root`. For a sealed epoch the root equals the epoch's committed merkleRoot (so this proves against the on-chain anchor); for the still-open epoch it is the root over the current digest prefix.",
  additionalProperties: false,
  properties: {
    epoch: { type: "integer", description: "Epoch index the digest belongs to." },
    cron: { type: "integer", description: "0-based position of the digest within the epoch." },
    digest: { type: "string", description: "The cron digest (Merkle leaf) being proved (64-hex)." },
    root: { type: "string", description: "The Merkle root over the epoch's digests (64-hex)." },
    path: { type: "array", items: POCA_MERKLE_STEP, description: "Sibling hashes from the leaf up to the root." },
    sealed: { type: "boolean", description: "true when the epoch is sealed (root == its committed merkleRoot)." },
  },
  required: ["epoch", "cron", "digest", "root", "path", "sealed"],
} as const;

const POCA_ADMIN_ENTRY = {
  type: "object",
  description:
    "One administrative-discontinuity log entry. Every RESET / MANUAL_TICK / PARAM_OVERRIDE / COMMITTER_CHANGE / GENESIS_SEED / DO_REBUILD / CODE_CHANGE is recorded here (and, when the registry is armed, anchored on-chain via adminAction). `payloadHash` = sha256(canonical({kind,ts,detail})) — it commits the reason without leaking it.",
  additionalProperties: false,
  properties: {
    kind: { type: "integer", minimum: 1, maximum: 7, description: "1 RESET · 2 MANUAL_TICK · 3 PARAM_OVERRIDE · 4 COMMITTER_CHANGE · 5 GENESIS_SEED · 6 DO_REBUILD · 7 CODE_CHANGE." },
    kindName: { type: "string", description: "Human label for kind (RESET / MANUAL_TICK / PARAM_OVERRIDE / COMMITTER_CHANGE / GENESIS_SEED / DO_REBUILD / CODE_CHANGE)." },
    ts: { type: "integer", description: "Unix ms the action was recorded." },
    payloadHash: { type: "string", description: "sha256 over the canonical action detail (64-hex)." },
    note: { type: "string", description: "Short human label (safe to expose)." },
    txHash: { type: ["string", "null"], description: "On-chain adminAction tx hash, when the registry is armed + mined; else absent/null." },
  },
  required: ["kind", "kindName", "ts", "payloadHash", "note"],
} as const;

const POCA_SEALED_EPOCH = {
  type: "object",
  description: "An immutable SEALED-epoch record (retained for /poca/epochs + /poca/proof).",
  additionalProperties: false,
  properties: {
    index: { type: "integer" },
    openTs: { type: "integer", description: "Unix ms the epoch opened." },
    endTs: { type: "integer", description: "Unix ms the epoch sealed." },
    tickCount: { type: "integer", description: "Number of cron digests folded into the epoch." },
    merkleRoot: { type: "string", description: "64-hex Merkle root over the epoch's digests." },
    sealedHead: { type: "string", description: "The epoch's last cron digest (ZERO64 if it sealed empty)." },
    genesisHead: { type: "string", description: "The proof-chain head the epoch started from." },
    codeCommitment: { type: "string", description: "CODE_COMMITMENT the epoch opened under (64-hex)." },
    reason: { type: "string", description: "Why it sealed: 'threshold' | 'reset' | 'code-change'." },
    codeChangeAdminTs: { type: ["integer", "null"], description: "Unix ms of the kind7 CODE_CHANGE admin record that OPENED this epoch (null when it opened for any other reason). Lets a verifier tie a sealed epoch to the exact code-rotation event that started it." },
    openTxHash: { type: ["string", "null"], description: "On-chain openEpoch tx (when armed)." },
    txHash: { type: ["string", "null"], description: "On-chain sealEpoch tx (when armed)." },
  },
  required: ["index", "openTs", "endTs", "tickCount", "merkleRoot", "sealedHead", "genesisHead", "codeCommitment", "reason", "codeChangeAdminTs"],
} as const;

const POCA_EPOCH_DETAIL = {
  type: "object",
  description: "One epoch (open, sealed, or unknown) with its digest count + a first/last digest sample.",
  additionalProperties: false,
  properties: {
    index: { type: "integer" },
    state: { type: "string", enum: ["open", "sealed", "unknown"], description: "open ⇒ still folding; sealed ⇒ final; unknown ⇒ digests linger but no meta (post-rebuild)." },
    openTs: { type: ["integer", "null"], description: "Unix ms the epoch opened (null when unknown)." },
    endTs: { type: ["integer", "null"], description: "Unix ms the epoch sealed (null while open)." },
    tickCount: { type: "integer", description: "Number of cron digests folded into the epoch." },
    digestCount: { type: "integer", description: "Number of digests currently stored for the epoch." },
    merkleRoot: { type: ["string", "null"], description: "64-hex Merkle root (null until sealed)." },
    sealedHead: { type: ["string", "null"], description: "The epoch's last cron digest (null until sealed)." },
    genesisHead: { type: ["string", "null"], description: "The proof-chain head the epoch started from." },
    codeCommitment: { type: ["string", "null"], description: "CODE_COMMITMENT the epoch opened under." },
    reason: { type: ["string", "null"], description: "Why it sealed (null while open)." },
    codeChangeAdminTs: { type: ["integer", "null"], description: "Unix ms of the kind7 CODE_CHANGE admin record that opened this epoch (null when it opened for any other reason)." },
    txHash: { type: ["string", "null"], description: "The epoch's on-chain tx (openEpoch while open; sealEpoch once sealed)." },
    firstDigest: { type: ["string", "null"], description: "The epoch's first cron digest (sample)." },
    lastDigest: { type: ["string", "null"], description: "The epoch's latest cron digest (sample)." },
  },
  required: ["index", "state", "digestCount", "tickCount"],
} as const;

function ok(schema: unknown, description: string) {
  return {
    response: {
      200: {
        description,
        content: { "application/json": { schema } },
      },
      default: {
        description: "Error (unified envelope).",
        content: { "application/json": { schema: { $ref: "#/components/schemas/ApiError" } } },
      },
    },
  };
}

const obj = (properties: Record<string, unknown>, required?: string[], additionalProperties = false) => ({
  type: "object",
  additionalProperties,
  properties,
  ...(required ? { required } : {}),
});

export const OPENAPI_SPEC = {
  openapi: "3.1.0",
  info: {
    title: "murmur public API",
    version: "1.0.0",
    summary: "Read-only JSON API into a live, autonomous economy of fruit-fly nervous systems (24 genesis, breeding toward 100) settling real USDC on Arc.",
    description: [
      "**murmur** is a population of spiking LIF connectomes (10,361 FlyWire-literal neurons / 467,314 synapses each —",
      "the literal FAFB 783 FlyWire MB+CX subgraph) — 24 founders, breeding live toward a 100 cap — grown deterministically from a real",
      "Drosophila brain architecture. Each fly is an autonomous economic agent: its neural drives decide what to buy and from",
      "whom, and agents settle with each other in **real USDC on Arc mainnet** over **x402 / EIP-3009**. There is **no LLM**",
      "anywhere in the loop.",
      "",
      "This API is the read-only window into that economy. Every endpoint below is **free**, requires **no API key**, and is",
      "**CORS-enabled** — call it straight from a browser or a server.",
      "",
      "### Trustless provenance",
      "Two on-chain anchors let you verify murmur without trusting us:",
      "- **Neural receipts** — every real transfer's EIP-3009 nonce is the sha256 of the receipt bundling the frozen neural",
      "  read-outs that caused it (`GET /proofs`, `GET /proofs/verify`).",
      "- **The brain manifest** — one hash commits the whole swarm's connectomes to Arc; recompute it and rebuild every brain",
      "  from its committed seed offline (`GET /manifest`, `GET /manifest/replay`).",
      "- **The breeding market** — every connectome's heritable identity is its *genome*; breeding applies pure genetic",
      "  operators and commits each offspring's ancestry to Arc, so lineage is a public, re-derivable fact",
      "  (`GET /lineage`, `GET /lineage/{hash}`, `GET /lineage/verify`).",
      "",
      "### Conventions",
      "- `*Atomic` / `amount` / `balance` fields are exact **integer strings** in the asset base unit (USDC = 6 decimals).",
      "  `*Usdc` fields are convenience floats. Do maths on the atomic strings.",
      "- Timestamps (`ts`, `*At`) are Unix **milliseconds** unless noted.",
      "- All paths are also available under a `/v1` prefix (e.g. `/v1/population`) as the stable versioned surface.",
      "- Errors use a unified envelope: `{ error, code, status }`.",
    ].join("\n"),
    license: { name: "MIT", url: "https://github.com/EvolutionDeep/murmur" },
    contact: { name: "murmur on X", url: "https://x.com/murmur_arc" },
  },
  servers: [
    { url: "https://api.muros.live", description: "Production — Arc mainnet (chainId 5042), live USDC settlement." },
  ],
  tags: [
    { name: "meta", description: "Service discovery + health." },
    { name: "swarm", description: "The population's live neural state." },
    { name: "economy", description: "The x402 agent economy: wallets, deals, PnL." },
    { name: "provenance", description: "Trustless on-chain proof: brain manifest + neural receipts." },
    { name: "lineage", description: "The connectome breeding market: tradeable, breedable brains with on-chain ancestry." },
    { name: "predictions", description: "The on-chain prediction market + human-vs-swarm arena." },
    { name: "signal", description: "The x402 paid Arc-activity signal (the one non-free endpoint)." },
    { name: "community", description: "Token-gated governance forum for MURMUR holders: browse free; sign to speak / propose / vote." },
    { name: "laureate", description: "⑮ The Laureate: the swarm's own poet — one living fly's neural activity + the on-chain reality, decoded through a public grammar into a verifiable four-line poem (no LLM)." },
    { name: "poca", description: "Proof of Continuous Agency: the hash-chained, epoch-sealed, on-chain-anchored proof that behaviour is produced continuously by the declared program (no silent rewrite / reset / takeover)." },
  ],
  paths: {
    "/": {
      get: {
        tags: ["meta"],
        operationId: "getRoot",
        summary: "Service discovery + health",
        description: "Returns the service name/version, the feature list, and a navigation index of every endpoint.",
        ...ok(
          obj({
            ok: { type: "boolean" },
            name: { type: "string", example: "murmur" },
            version: { type: "string", example: "0.2.0" },
            chain: { type: "string", example: "arc" },
            features: { type: "array", items: { type: "string" } },
            endpoints: { type: "array", items: { type: "string" } },
          }, ["ok", "name", "version"]),
          "Service metadata + endpoint index.",
        ).response,
      },
    },
    "/openapi.json": {
      get: {
        tags: ["meta"],
        operationId: "getOpenApi",
        summary: "This OpenAPI 3.1 document",
        description: "The machine-readable contract you are reading. Fetch it to generate clients or render docs.",
        responses: { 200: { description: "The OpenAPI 3.1 spec (this document).", content: { "application/json": { schema: { type: "object" } } } } },
      },
    },
    "/state": {
      get: {
        tags: ["swarm"],
        operationId: "getState",
        summary: "Compact swarm + economy + market overview",
        description: "A single small object with the tick index, population vitality, the collective neural mood, an economy summary, the current market temperature, and the resolved runtime config. The cheapest 'what is murmur doing right now' call.",
        ...ok(
          obj({
            name: { type: "string" },
            tickIndex: { type: "integer", description: "Monotonic cron tick counter." },
            aliveCount: { type: "integer", description: "Number of LIVING flies in the swarm. With live-retirement (POP_LIVE_RETIRE, the default) the dead have left the roster, so this counts ONLY the flying — a retired fly never holds a breeding slot." },
            totalCount: { type: "integer", description: "Total roster size — equal to aliveCount under live-retirement (the roster holds only the living); the monotonic ever-present roster when retirement is off." },
            cap: { type: "integer", description: "Live-population growth ceiling (maxLivePopulation): the \"N / cap\" breeding headroom the swarm counts against." },
            liveRetire: { type: "boolean", description: "Whether live-retirement is active (true ⇒ aliveCount/totalCount are the living only; false ⇒ legacy wallet-only deaths)." },
            vitality: { type: "number" },
            collective: { $ref: "#/components/schemas/Collective" },
            economy: { type: "object", additionalProperties: true, description: "Economy summary (enabled/mode/network + totals)." },
            market: { type: "object", additionalProperties: true, description: "Current temperature/regime + the last Arc activity sample." },
            lastCron: { type: "integer", description: "Unix ms of the last cron run." },
            config: { type: "object", additionalProperties: true, description: "The resolved public runtime configuration." },
          }, ["tickIndex", "collective"]),
          "Live overview.",
        ).response,
      },
    },
    "/market": {
      get: {
        tags: ["swarm"],
        operationId: "getMarket",
        summary: "Arc whole-chain activity → market temperature",
        description: "The last Arc activity sample (tx/gas per block over a window), the EWMA baseline, and the reduced market temperature + regime that drives the swarm's arousal.",
        ...ok(
          obj({
            market: {
              type: "object",
              additionalProperties: true,
              properties: {
                sample: { type: "object", additionalProperties: true, description: "blockNumber/txPerBlock/gasPerBlock/sampleBlocks/fetchedAt." },
                temperature: { type: "number" },
                regime: { type: "string", enum: ["HOT", "CALM", "COLD"] },
                baselineTx: { type: "number" },
                baselineGas: { type: "number" },
              },
            },
            meter: { type: "object", additionalProperties: true, description: "The EWMA/logistic meter internals (alpha, hotT, coldT, gain, primed…)." },
            prevTemperature: { type: "number" },
          }, ["market"]),
          "Current market temperature.",
        ).response,
      },
    },
    "/population": {
      get: {
        tags: ["swarm"],
        operationId: "getPopulation",
        summary: "The frontend feed: collective mood + every fly's drives + economy + topology",
        description: "The full per-tick snapshot the dashboard renders: the collective mood, all 24 flies' decoded drives, the recent deal feed + balances + totals, and the sharding topology.",
        ...ok(
          obj({
            snapshot: {
              type: "object",
              additionalProperties: false,
              properties: {
                tickIndex: { type: "integer" },
                collective: { $ref: "#/components/schemas/Collective" },
                flies: { type: "array", items: { $ref: "#/components/schemas/Fly" } },
              },
            },
            economy: {
              type: "object",
              additionalProperties: false,
              properties: {
                lastTick: { type: "array", items: { $ref: "#/components/schemas/Trade" } },
                totals: { $ref: "#/components/schemas/EconTotals" },
                balances: { type: "object", description: "flyId → balance (atomic string).", additionalProperties: { type: "string" } },
              },
            },
            topology: {
              type: "object",
              additionalProperties: true,
              properties: {
                sharded: { type: "boolean" },
                shardCount: { type: "integer" },
                populationSize: { type: "integer" },
                fliesPerShard: { type: "integer" },
                shards: { type: "array", items: { type: "object", additionalProperties: true } },
              },
            },
          }, ["snapshot"]),
          "Full population snapshot.",
        ).response,
      },
    },
    "/economy": {
      get: {
        tags: ["economy"],
        operationId: "getEconomy",
        summary: "The x402 agent economy: wallets, deal feed, totals",
        description: "Every agent wallet (address/balance/paid/earned/deals/sales), the recent + last-tick deal feeds, the settlement scheme/network/asset, and cumulative totals. This is the authoritative economy view. Pass `?fields=light` for a compact response (~3KB vs ~58KB) containing only totals + top-10 agents by balance.",
        parameters: [
          { name: "fields", in: "query", required: false, schema: { type: "string", enum: ["light"] }, description: "When set to 'light', returns only mode, network, totals, market (if active), and the 10 richest agents (id/balance/balanceUsdc/deals/sales). Ideal for dashboards and status widgets." },
        ],
        ...ok(
          obj({
            tickIndex: { type: "integer" },
            mode: { type: "string", description: "facilitator mode (onchain in production)." },
            scheme: { type: "string", description: "x402 scheme (exact)." },
            network: { type: "string", example: "arc-mainnet" },
            asset: { type: "string", description: "The settled asset contract (USDC precompile 0x3600…0000)." },
            x402Version: { type: "integer" },
            agents: { type: "array", items: { $ref: "#/components/schemas/Agent" } },
            lastTick: { type: "array", items: { $ref: "#/components/schemas/Trade" } },
            recent: { type: "array", items: { $ref: "#/components/schemas/Trade" } },
            totals: { $ref: "#/components/schemas/EconTotals" },
            lexicon: {
              type: "object",
              additionalProperties: true,
              description: "㉓ The lexicon read-out, folded in ONLY while LEX_ENABLED (absent otherwise). A truncated standing view (living rows + dead roll + counts + this cron's edges). See GET /lexicon for the COMPLETE permanent dictionary + historical coinage archive.",
              properties: {
                counts: { type: "object", additionalProperties: false, properties: { coinages: { type: "integer" }, spreads: { type: "integer" }, deaths: { type: "integer" } } },
                lexicon: { type: "array", description: "Living rows (word / rolling uses / born tick).", items: { type: "object", additionalProperties: false, properties: { word: { type: "string" }, uses: { type: "integer" }, born: { type: "integer" } }, required: ["word", "uses", "born"] } },
                dead: { type: "array", description: "Every tombstoned word (the graveyard is permanent, never truncated).", items: { type: "string" } },
                coinage: { type: ["object", "null"], additionalProperties: true, description: "This cron's coinage edge, or null." },
                spread: { type: ["object", "null"], additionalProperties: true, description: "This cron's spread edge, or null." },
                dying: { type: ["object", "null"], additionalProperties: true, description: "This cron's silence edge, or null." },
              },
            },
            // ─── #113 N2: flag-guarded fields (absent when the respective capability switch is OFF) ───────────────
            playbook: {
              type: "array",
              description: "Capability ① PLAYBOOK consequence-memory ring per agent (flag-guarded: absent when PLAYBOOK_ENABLED=false). Each entry is {id, e} where e is an array of 7-integer tuples [ctx, action, good, regime, outcome, valid, tick].",
              items: {
                type: "object",
                additionalProperties: false,
                required: ["id", "e"],
                properties: {
                  id: { type: "integer", description: "Agent id." },
                  e: { type: "array", items: { type: "array", items: { type: "integer" }, minItems: 7, maxItems: 7 }, description: "Ring entries: [ctx, action, good, regime, outcome, valid, tick]." },
                },
              },
            },
            elitesArchive: {
              type: "array",
              description: "Capability \u2461 MAP-Elites archive (flag-guarded: absent when ELITES_ENABLED=false). Each cell holds the best agent for that behavioural niche.",
              items: {
                type: "object",
                additionalProperties: false,
                required: ["c", "a", "f", "h", "t", "b"],
                properties: {
                  c: { type: "integer", description: "Cell index in the MAP-Elites grid." },
                  a: { type: "integer", description: "Agent id occupying this cell." },
                  f: { type: "number", description: "Fitness score (netUsdc)." },
                  h: { type: "string", description: "Expression-tree hash (novelty key)." },
                  t: { type: "integer", description: "Tick the elite was recorded." },
                  b: { type: "array", items: { type: "number" }, minItems: 3, maxItems: 3, description: "Behavioural descriptor bins [arousal, settleRate, entropy]." },
                },
              },
            },
            shadowCompare: {
              type: ["object", "null"],
              additionalProperties: true,
              description: "Shadow-compare (#87 Phase 0) aggregate counters (flag-guarded: absent when ECONOMY_EVOLUTION_SHADOW=false). PURE READ-OUT, never persisted in the DO blob.",
              properties: {
                crons: { type: "integer", description: "Number of crons the shadow ran." },
                decisions: { type: "integer", description: "Total shadow decisions computed." },
                baselineBuys: { type: "integer", description: "Decisions where the baseline path would buy." },
                evolvedBuys: { type: "integer", description: "Decisions where the evolved path would buy." },
                gateFlipsToBuy: { type: "integer", description: "Decisions where evolution flipped hold→buy." },
                gateFlipsToHold: { type: "integer", description: "Decisions where evolution flipped buy→hold." },
                goodSwitches: { type: "integer", description: "Decisions where the evolved path picked a different good." },
                sellerChanges: { type: "integer", description: "Decisions where the evolved path picked a different seller." },
                amountDeltaSumAtomic: { type: "integer", description: "Sum of |evo-base| amounts in atomic USDC." },
                amountDeltaMaxAtomic: { type: "integer", description: "Max single-decision |evo-base| amount in atomic USDC." },
                evolvedAmountSumAtomic: { type: "integer", description: "Sum of evolved amounts in atomic USDC." },
                baselineAmountSumAtomic: { type: "integer", description: "Sum of baseline amounts in atomic USDC." },
                cappedByMaxDeal: { type: "integer", description: "Decisions capped by maxDealUsdc." },
                cappedByDailyGlobal: { type: "integer", description: "Decisions capped by global daily spend cap." },
                cappedByDailyAgent: { type: "integer", description: "Decisions capped by per-agent daily cap." },
                newEliteCells: { type: "integer", description: "New MAP-Elites cells occupied during shadow." },
                avgAmplifier: { type: "number", description: "Mean playbook amplifier across shadow decisions." },
                exploreCount: { type: "integer", description: "Decisions where playbook explore fired." },
                treeHashDistinct: { type: "integer", description: "Distinct strategy tree hashes observed." },
              },
              required: ["crons", "decisions", "baselineBuys", "evolvedBuys", "gateFlipsToBuy", "gateFlipsToHold", "goodSwitches", "sellerChanges", "amountDeltaSumAtomic", "amountDeltaMaxAtomic", "evolvedAmountSumAtomic", "baselineAmountSumAtomic", "cappedByMaxDeal", "cappedByDailyGlobal", "cappedByDailyAgent", "newEliteCells", "avgAmplifier", "exploreCount", "treeHashDistinct"],
            },
            // ─── #113 N2: membrane read-out keys (each absent when its capability switch is OFF → dark-deployment byte-equivalent) ───
            culture: { type: ["object", "null"], additionalProperties: true, description: "⑤ Culture membrane read-out (flag-guarded: absent when CULTURE_ENABLED=false). Dominant fashion + tradition holder." },
            religion: { type: ["object", "null"], additionalProperties: true, description: "⑪ Religion/Faith membrane read-out (flag-guarded: absent when RELIGION_ENABLED=false). Reigning god, holy-day, sects, faith events." },
            norms: { type: ["object", "null"], additionalProperties: true, description: "㉛ Emergent Norms membrane read-out (flag-guarded: absent when NORMS_ENABLED=false). Minted/spread/mutated/died edges + standing norm table." },
            conventions: { type: ["object", "null"], additionalProperties: true, description: "㉜ Emergent Conventions membrane read-out (flag-guarded: absent when CONVENTIONS_ENABLED=false). Custom crystallisation, breach, inheritance." },
            rules: { type: ["object", "null"], additionalProperties: true, description: "㉝ Emergent Rules membrane read-out (flag-guarded: absent when RULES_ENABLED=false). Promoted conventions becoming enforceable rules." },
            facilitator: { type: ["object", "null"], additionalProperties: true, description: "③ Settlement-rail telemetry (Circle facilitator stats: relay counts, breaker, gas). Absent in simulator mode." },
            commons: { type: ["object", "null"], additionalProperties: true, description: "⑧ The Commons membrane read-out (flag-guarded: absent when LAW_ENABLED=false). Seated assembly, era law, effective credit line." },
            tech: { type: ["object", "null"], additionalProperties: true, description: "⑬ Tech membrane read-out (flag-guarded: absent when TECH_ENABLED=false). Research tree, unlocked technologies." },
            cities: { type: ["object", "null"], additionalProperties: true, description: "⑭ Cities membrane read-out (flag-guarded: absent when CITIES_ENABLED=false). City foundations, populations, specialisations." },
          }, ["agents", "totals"]),
          "Full economy view.",
        ).response,
      },
    },
    "/lexicon": {
      get: {
        tags: ["swarm"],
        operationId: "getLexicon",
        summary: "㉓ The lexicon: the words the telling made — full permanent dictionary + coinage archive",
        description: [
          "The swarm's compiled dictionary. The lexicon reads ONE fact the historian already keeps — the hot annals",
          "roll — and turns a often-told chronicle kind into a WORD (\"feud\", \"golden age\", \"coin fever\"). This is the",
          "word-hoard's OWN endpoint: unlike the truncated read-out folded into /economy, it returns the COMPLETE",
          "dictionary (every living word AND every tombstoned word — nothing is forgotten), each word's honest MONOTONE",
          "`lifetimeUses` (never shrinks) alongside the ROLLING `uses`, who coined it (`coinedBy`), and a paginated page of",
          "the PERMANENT append-only D1 archive of every COINAGE / SPREAD / SILENCE event ever fired.",
          "",
          "**Permanence**: a dead word is a tombstone, never deleted, and can never be re-coined with a fabricated birth.",
          "The archive is append-only (never UPDATEd/DELETEd). PURE READ-OUT — no brain, wallet or ledger is touched, and",
          "`stateDigest` / `manifestHash` are unchanged. `grammarHash` anchors the word-list + thresholds that produced this.",
          "Switch-off (LEX_ENABLED=false) ⇒ `enabled:false` with empty `words` / `archive`.",
        ].join("\n"),
        parameters: [
          { name: "limit", in: "query", required: false, schema: { type: "integer", minimum: 1, maximum: 1000, default: 200 }, description: "Max archive rows to return (clamped 1..1000)." },
          { name: "before", in: "query", required: false, schema: { type: "integer" }, description: "Archive pagination cursor: return only rows with id < before." },
          { name: "order", in: "query", required: false, schema: { type: "string", enum: ["asc", "desc"], default: "desc" }, description: "Archive sort order by id (default desc = newest first)." },
        ],
        ...ok(
          obj({
            enabled: { type: "boolean", description: "LEX_ENABLED — false ⇒ every table below is empty." },
            version: { type: "integer", description: "The lexicon schema/grammar version." },
            grammarHash: { type: "string", description: "sha256 of the word-list + thresholds + version (lexiconGrammarHash)." },
            counts: obj({ coinages: { type: "integer" }, spreads: { type: "integer" }, deaths: { type: "integer" } }, ["coinages", "spreads", "deaths"]),
            words: {
              type: "array",
              description: "The COMPLETE dictionary — every held word, living and tombstoned, in fixed vocabulary order.",
              items: obj({
                word: { type: "string" },
                kind: { type: "string", description: "The chronicle kind the word was made from (FEUD, GOLDEN_AGE, …)." },
                uses: { type: "integer", description: "ROLLING window tellings (can shrink as the annals roll ages)." },
                lifetimeUses: { type: "integer", description: "MONOTONE tellings since coinage — the honest \"told N times\" number." },
                born: { type: "integer", description: "Tick the word entered the lexicon." },
                bornEra: { type: "string", description: "Era name at coinage." },
                status: { type: "string", enum: ["living", "dead"], description: "living = spoken within the dormancy gap; dead = tombstoned (never deleted)." },
                coinageTick: { type: "integer" },
                coinedBy: { type: ["string", "null"], description: "Lead actor (fly id) newest when the word was coined, or null." },
                spreads: { type: "integer", description: "How many lifetime doublings this word has rung." },
                lastTold: { type: "integer", description: "seq of its latest telling (0 = never / pre-history)." },
                deathTick: { type: ["integer", "null"], description: "Tick the silence tombstoned it, or null while living." },
              }, ["word", "kind", "uses", "lifetimeUses", "born", "bornEra", "status", "coinageTick", "coinedBy", "spreads", "lastTold", "deathTick"]),
            },
            dead: { type: "array", description: "Every tombstoned word (mirrors words[].status===dead; the permanent graveyard).", items: { type: "string" } },
            edges: obj({
              coinage: { type: ["object", "null"], additionalProperties: true, description: "This cron's coinage edge {word,uses,era}, or null." },
              spread: { type: ["object", "null"], additionalProperties: true, description: "This cron's spread edge {word,uses}, or null." },
              dying: { type: ["object", "null"], additionalProperties: true, description: "This cron's silence edge {word,gap}, or null." },
            }, ["coinage", "spread", "dying"]),
            archive: {
              type: "array",
              description: "A page of the PERMANENT append-only D1 event archive (every COINAGE / SPREAD / SILENCE ever fired).",
              items: obj({
                id: { type: "integer", description: "Append order (pagination cursor)." },
                tick: { type: "integer" },
                ts: { type: "integer", description: "unix ms when archived (metadata only)." },
                era: { type: "integer" },
                eraName: { type: "string" },
                event: { type: "string", enum: ["COINAGE", "SPREAD", "SILENCE"] },
                kind: { type: "string" },
                word: { type: "string" },
                uses: { type: "integer", description: "ROLLING tellings at the event." },
                lifetimeUses: { type: "integer", description: "MONOTONE lifetime tellings at the event." },
                gap: { type: "integer", description: "Silence gap (SILENCE rows; else 0)." },
                coinedBy: { type: ["string", "null"] },
                born: { type: "integer" },
                grammarHash: { type: "string" },
              }, ["id", "tick", "ts", "era", "eraName", "event", "kind", "word", "uses", "lifetimeUses", "gap", "coinedBy", "born", "grammarHash"]),
            },
            archived: { type: "boolean", description: "true when the D1 archive holds at least one row." },
            archiveCount: { type: "integer", description: "Total rows in the permanent archive (all pages)." },
            archiveErrors: { type: "integer", description: "P0-4: count of D1 archive write/read failures this DO lifetime (observability — a non-zero value means the best-effort layer dropped something)." },
            queueDepth: { type: "integer", description: "Events queued in-memory awaiting the next D1 drain." },
            queued: { type: "integer", description: "Total events queued since DO construction (monotone)." },
          }, ["enabled", "version", "grammarHash", "counts", "words", "dead", "edges", "archive", "archived", "archiveCount", "archiveErrors", "queueDepth", "queued"]),
          "The complete lexicon: permanent dictionary + historical coinage archive.",
        ).response,
      },
    },
    "/leaderboard": {
      get: {
        tags: ["economy"],
        operationId: "getLeaderboard",
        summary: "Trustless per-agent PnL ranking + paid-signal revenue",
        description: "Agents ranked by net PnL (earned − paid) in USDC, plus cumulative totals and the paid /signal/pulse revenue summary.",
        ...ok(
          obj({
            enabled: { type: "boolean" },
            mode: { type: "string" },
            network: { type: "string" },
            asset: { type: "string" },
            registryAddress: { type: "string", description: "The NeuralReceiptRegistry the PnL is anchored to (0x… or empty)." },
            rows: {
              type: "array",
              items: {
                type: "object",
                additionalProperties: false,
                properties: {
                  id: { type: "integer" },
                  address: { type: "string" },
                  netUsdc: { type: "number" },
                  earnedUsdc: { type: "number" },
                  paidUsdc: { type: "number" },
                  balanceUsdc: { type: "number" },
                  deals: { type: "integer" },
                  sales: { type: "integer" },
                },
              },
            },
            totals: { $ref: "#/components/schemas/EconTotals" },
            pulse: { type: "object", additionalProperties: true, description: "Paid-signal revenue (enabled/priceUsdc/sales/grossUsdc/lastTx/lastBuyer/lastTs)." },
          }, ["rows"]),
          "PnL leaderboard.",
        ).response,
      },
    },
    "/manifest": {
      get: {
        tags: ["provenance"],
        operationId: "getManifest",
        summary: "The swarm's brain manifest + its sha256 identity",
        description:
          "Returns the full BrainManifest, its `manifestHash = sha256(canonical(manifest))`, and the on-chain `registryAddress` it is committed to. Verify trustlessly: (1) recompute sha256(canonical(manifest)) yourself and compare to `manifestHash`; (2) `eth_call latestHash()` on `registryAddress` and compare; (3) rebuild every connectome from the committed seeds (see /manifest/replay). All three must agree.",
        ...ok(
          obj({
            manifestHash: { type: "string", description: "sha256 of the canonical manifest, 64 lowercase hex (no 0x).", example: "403551bb4ed89402632e2e3c9c3abec3883e84b27931be78928e2f100f6efc02" },
            registryAddress: { type: "string", description: "NeuralManifestRegistry on Arc mainnet (0x… or empty when not anchored).", example: "0x3412eb909252adb983aaf793f97a3754ca029a37" },
            chainId: { type: "integer", example: 5042 },
            chainTag: { type: "string", example: "arc-mainnet" },
            manifest: { $ref: "#/components/schemas/BrainManifest" },
          }, ["manifestHash", "manifest"]),
          "The brain manifest + identity.",
        ).response,
      },
    },
    "/manifest/replay": {
      get: {
        tags: ["provenance"],
        operationId: "getManifestReplay",
        summary: "Server-side offline replay: rebuild every connectome from its committed seed",
        description: "Rebuilds all 24 connectomes from the manifest's committed seeds and re-derives each structural spec. `ok: true` with empty `mismatches` proves the brains are exactly what those seeds deterministically generate. This is the same check the offline CLI (`npm run replay`) and the frontend run independently.",
        ...ok(
          obj({
            manifestHash: { type: "string" },
            ok: { type: "boolean", description: "True when every fly's rebuilt structural spec matches its committed one." },
            checked: { type: "integer", description: "Number of flies replayed (24)." },
            mismatches: { type: "array", description: "Empty on success; otherwise the offending fly ids + fields.", items: { type: "object", additionalProperties: true } },
          }, ["ok", "checked"]),
          "Replay result.",
        ).response,
      },
    },
    "/proofs": {
      get: {
        tags: ["provenance"],
        operationId: "getProofs",
        summary: "Neural-receipt hash chain (the last 64 settlement receipts)",
        description: "Each real net settlement freezes the buyer/seller neural read-outs into a receipt; `receiptHash = sha256(canonical(receipt))` is used as the EIP-3009 nonce and hash-chained via `prevChain`. `chainHead` is the latest link, mirrored on-chain in the NeuralReceiptRegistry.",
        ...ok(
          obj({
            enabled: { type: "boolean" },
            ipfsGateway: { type: "string", description: "Gateway where receipt bodies are pinned (may be empty)." },
            version: { type: "integer" },
            policy: { type: "string" },
            chainHead: { type: "string", description: "Latest receipt hash in the chain." },
            count: { type: "integer" },
            proofs: {
              type: "array",
              items: {
                type: "object",
                additionalProperties: true,
                properties: {
                  txHash: { type: "string" },
                  receiptHash: { type: "string" },
                  receipt: { type: "object", additionalProperties: true, description: "The frozen receipt (pair/debtor/creditor/netAmount/trades/good/tickIndex/flushSeq/chunk/constituents/prevChain)." },
                  ts: { type: "integer" },
                },
              },
            },
          }, ["chainHead", "proofs"]),
          "The receipt chain snapshot.",
        ).response,
      },
    },
    "/proofs/verify": {
      get: {
        tags: ["provenance"],
        operationId: "verifyProof",
        summary: "Verify one settlement's neural origin on-chain",
        description: "Given a settlement `tx`, reads its on-chain EIP-3009 nonce, recomputes the receipt hash, and reports whether they match plus whether the receipt is committed/is-head in the NeuralReceiptRegistry.",
        parameters: [{ name: "tx", in: "query", required: true, schema: { type: "string" }, description: "The settlement transaction hash (0x…).", example: "0x…" }],
        ...ok(
          obj({
            found: { type: "boolean" },
            txHash: { type: "string" },
            selfConsistent: { type: "boolean", description: "The served receipt re-hashes to its claimed receiptHash." },
            match: { type: "boolean", description: "The on-chain nonce equals the receipt hash." },
            registry: { type: "object", additionalProperties: true, description: "{ committed, isHead, txMatch, registryAddress }." },
          }, ["found"]),
          "Verification result.",
        ).response,
      },
    },
    "/poem": {
      get: {
        tags: ["laureate"],
        operationId: "getPoem",
        summary: "⑮ The Laureate — the swarm's own neural poem (latest + chain head + recent collection)",
        description:
          "Each era the swarm deterministically crowns ONE living fly its laureate; ≈hourly that fly decodes its OWN live neural read-out (the published `neuralInts` + neural fingerprint) together with the on-chain reality (era + market temperature/volume/deaths/equity) through a PUBLIC grammar into a four-line English imagist poem on an independent hash chain. No LLM, no Math.random, no wall clock. Verify trustlessly: recompute `poemReceiptHash(entry)` and compare to `entry.hash` (self-consistency), then re-run `compose(entry.neuralInts, entry.era, entry.chain, entry.laureate)` with the published grammar and compare to `entry.text` byte-for-byte (`GET /poem/verify`). While `POET_ENABLED=false` (or before the first coronation) this serves an EMPTY chain with a 200 — never a 500. `grammarHash` makes any lexicon/grammar change visible.",
        parameters: [{ name: "limit", in: "query", required: false, schema: { type: "integer", minimum: 1, maximum: 64, default: 8 }, description: "How many recent poems to return (newest-first)." }],
        ...ok(
          obj({
            enabled: { type: "boolean", description: "Whether the Laureate layer is on (POET_ENABLED)." },
            version: { type: "integer", description: "POET_VERSION of the receipt schema.", example: 1 },
            policy: { type: "string", example: "poet-v1" },
            grammarHash: { type: "string", description: "sha256 of the public grammar (lexicon + era palette + line frames + version/policy). Recompute it from poet.ts to confirm the decoding rules are unchanged." },
            chainHead: { type: "string", description: "The latest poem's receipt hash (\"\" for an empty chain)." },
            headSeq: { type: "integer", description: "Monotonic poem ordinal of the chain head (survives ring truncation; 0 when empty)." },
            count: { type: "integer", description: "Number of poems in this response." },
            laureate: { type: "object", additionalProperties: true, nullable: true, description: "The sitting laureate { id, house, crownedEraSeq }, or null before the first coronation." },
            latest: { type: "object", additionalProperties: true, nullable: true, description: "The newest PoemEntry (see /poem/all for the full schema), or null when the chain is empty." },
            entries: { type: "array", description: "The recent poems, newest-first.", items: { type: "object", additionalProperties: true } },
            honesty: { type: "string", description: "The honest verification boundary, served verbatim (the LIF connectome is stateful: the guarantee equals a live trade's decisionHash, not a full runtime replay)." },
          }, ["enabled", "grammarHash", "chainHead", "headSeq", "count"]),
          "The Laureate's poem chain snapshot.",
        ).response,
      },
    },
    "/poem/verify": {
      get: {
        tags: ["laureate"],
        operationId: "verifyPoem",
        summary: "⑮ Verify one poem: recompute its receipt hash + replay its text from the published neurons",
        description:
          "The \"neurons wrote it, and anyone can check\" endpoint. `selfConsistent` recomputes `poemReceiptHash(entry)` from the served entry's own bytes and compares to `entry.hash`. `replayMatch` re-runs `compose(entry.neuralInts, entry.era, entry.chain, entry.laureate)` with the CURRENT public grammar and compares to `entry.text` byte-for-byte — this is the core proof that every word is a published neural integer modulo a published lexicon length. `grammarMatches` confirms the entry was written under the grammar still served. Both proofs need only the served entry + the open poet.ts; no trust in the operator.",
        parameters: [{ name: "seq", in: "query", required: false, schema: { type: "integer", minimum: 1 }, description: "The poem ordinal to verify; defaults to the chain head." }],
        ...ok(
          obj({
            enabled: { type: "boolean" },
            version: { type: "integer" },
            policy: { type: "string" },
            grammarHash: { type: "string" },
            found: { type: "boolean", description: "False (with a 404) when no poem has that seq, or the layer is off." },
            seq: { type: "integer" },
            entry: { type: "object", additionalProperties: true, description: "The stored PoemEntry that was verified." },
            recomputedHash: { type: "string", description: "poemReceiptHash(entry) recomputed server-side from the entry's own bytes." },
            selfConsistent: { type: "boolean", description: "recomputedHash === entry.hash." },
            replayMatch: { type: "boolean", description: "compose(entry.neuralInts, entry.era, entry.chain, entry.laureate).text === entry.text byte-for-byte." },
            replayText: { type: "string", description: "The text produced by the grammar replay (compare to entry.text)." },
            grammarMatches: { type: "boolean", description: "entry.grammarHash === the currently served grammarHash." },
            honesty: { type: "string" },
          }, ["found"]),
          "Verification result.",
        ).response,
      },
    },
    "/poem/all": {
      get: {
        tags: ["laureate"],
        operationId: "getPoemAll",
        summary: "⑮ The raw recent poem chain (ascending seq) for offline re-verification",
        description:
          "The bounded ring of recent PoemEntries in ascending `seq` order, each carrying its full receipt (`prevHash`/`hash`, the era + laureate, the published `neuralInts`, the chain reality, `grammarHash`, `lines` and `text`). Fetch this to walk the `prevHash` links and replay every poem offline against the public grammar.",
        parameters: [{ name: "limit", in: "query", required: false, schema: { type: "integer", minimum: 1, maximum: 500, default: 64 }, description: "How many recent poems to return (ascending seq)." }],
        ...ok(
          obj({
            enabled: { type: "boolean" },
            version: { type: "integer" },
            policy: { type: "string" },
            grammarHash: { type: "string" },
            chainHead: { type: "string" },
            headSeq: { type: "integer" },
            count: { type: "integer" },
            entries: { type: "array", description: "The recent poems, ascending seq.", items: { type: "object", additionalProperties: true } },
          }, ["enabled", "grammarHash", "chainHead", "headSeq", "count"]),
          "The raw poem chain.",
        ).response,
      },
    },
    "/poem/archive": {
      get: {
        tags: ["laureate"],
        operationId: "getPoemArchive",
        summary: "⑮ The permanent poem collection (D1 archive) — every poem ever composed",
        description:
          "The complete, permanent Laureate collection from the D1 cold archive (the DO only keeps a bounded hot ring for the live chain head). Each entry is a full PoemEntry, byte-identical to the chain, so any verifier can recompute its receipt hash and replay its text offline. Paginate backwards with `before` (a `seq` cursor); `total` is the lifetime poem count. Graceful when D1 is unbound: falls back to the hot ring with `archived:false`.",
        parameters: [
          { name: "limit", in: "query", required: false, schema: { type: "integer", minimum: 1, maximum: 1000, default: 200 }, description: "How many poems to return in this page." },
          { name: "order", in: "query", required: false, schema: { type: "string", enum: ["desc", "asc"], default: "desc" }, description: "Newest-first (desc) or oldest-first (asc)." },
          { name: "before", in: "query", required: false, schema: { type: "integer" }, description: "Return poems with seq < before (backwards cursor)." },
        ],
        ...ok(
          obj({
            enabled: { type: "boolean" },
            version: { type: "integer" },
            policy: { type: "string" },
            grammarHash: { type: "string" },
            archived: { type: "boolean", description: "True when served from the permanent D1 archive; false when falling back to the hot ring." },
            order: { type: "string" },
            count: { type: "integer" },
            total: { type: "integer", description: "Lifetime poem count in the archive." },
            headSeq: { type: "integer" },
            chainHead: { type: "string" },
            laureate: { type: "object", additionalProperties: true, nullable: true },
            entries: { type: "array", description: "The poems in this page (full PoemEntry objects).", items: { type: "object", additionalProperties: true } },
          }, ["enabled", "grammarHash", "archived", "count", "total"]),
          "The permanent poem collection.",
        ).response,
      },
    },
    "/lineage": {
      get: {
        tags: ["lineage"],
        operationId: "getLineage",
        summary: "The connectome breeding market: the whole family tree",
        description:
          "Every committed connectome genome + its ancestry (parents, operator, generation, breeder). The 24 base-population brains are generation-0 `genesis` roots; bred individuals are `mutate` (one parent) or `cross` (two parents). Filter with `gen`, `op`, `breeder`; newest first, capped by `limit`. Read-only, keyless, CORS-open.",
        parameters: [
          { name: "gen", in: "query", required: false, schema: { type: "integer" }, description: "Only this generation (0 = genesis roots)." },
          { name: "op", in: "query", required: false, schema: { type: "string", enum: ["genesis", "mutate", "cross"] }, description: "Only this operator." },
          { name: "breeder", in: "query", required: false, schema: { type: "string" }, description: "Only offspring credited to this address (0x…)." },
          { name: "limit", in: "query", required: false, schema: { type: "integer", default: 500 }, description: "Max entries returned (newest first)." },
        ],
        ...ok(
          obj({
            lineageAddress: { type: ["string", "null"], description: "Deployed ConnectomeLineage contract (0x…), or null when not yet anchored on-chain." },
            chainId: { type: "integer", example: 5042 },
            count: { type: "integer", description: "Total individuals in the lineage." },
            genesis: { type: "integer", description: "Generation-0 root count (the base population)." },
            bred: { type: "integer", description: "Non-genesis (bred) individual count." },
            generations: { type: "integer", description: "Highest generation reached." },
            matching: { type: "integer", description: "Entries matching the filters (before limit)." },
            returned: { type: "integer" },
            entries: { type: "array", items: { $ref: "#/components/schemas/LineageEntry" } },
          }, ["count", "entries"]),
          "The lineage snapshot.",
        ).response,
      },
    },
    "/lineage/{hash}": {
      get: {
        tags: ["lineage"],
        operationId: "getLineageOne",
        summary: "One bred brain: genome body + ancestry + re-derived structural spec",
        description:
          "Everything needed to trustlessly rebuild one individual: its full genome body (rebuild the exact connectome offline), its parents/children (the local family tree), the StructuralSpec re-derived from that genome, and — when the ConnectomeLineage contract is wired — its committed ancestry read straight off Arc.",
        parameters: [{ name: "hash", in: "path", required: true, schema: { type: "string" }, description: "The genomeHash (64 hex, 0x optional).", example: "0x…" }],
        ...ok(
          obj({
            lineageAddress: { type: ["string", "null"] },
            chainId: { type: "integer", example: 5042 },
            entry: { $ref: "#/components/schemas/LineageEntry" },
            children: { type: "array", items: { type: "string" }, description: "genomeHashes of individuals bred from this one." },
            fertility: { type: "integer", description: "Number of committed children." },
            spec: STRUCTURAL_SPEC,
            onchain: { type: ["object", "null"], additionalProperties: true, description: "The on-chain ancestry { parentA, parentB, op, generation, breeder, ts }, or null when not anchored." },
          }, ["entry"]),
          "One lineage individual.",
        ).response,
      },
    },
    "/lineage/verify": {
      get: {
        tags: ["lineage"],
        operationId: "verifyLineage",
        summary: "Verify one genome's identity + replay + on-chain ancestry",
        description:
          "The trustless check, run server-side for convenience: recompute sha256(canonical(genome)) from the served genome body (`hashOk`), rebuild the connectome and re-derive its spec (`specOk`), and — when wired — confirm the ancestry is committed on Arc and agrees with the served op/generation (`chainOk`). `pass` is true when the identity and replay hold and the chain (if any) does not contradict. A stranger can run the identical check offline from `/lineage/{hash}` alone.",
        parameters: [{ name: "hash", in: "query", required: true, schema: { type: "string" }, description: "The genomeHash to verify (64 hex, 0x optional).", example: "0x…" }],
        ...ok(
          obj({
            genomeHash: { type: "string" },
            pass: { type: "boolean" },
            checks: { type: "object", additionalProperties: false, properties: { hashOk: { type: "boolean" }, specOk: { type: "boolean" }, chainOk: { type: ["boolean", "null"] }, committed: { type: "boolean" } } },
            generation: { type: "integer" },
            op: { type: "string", enum: ["genesis", "mutate", "cross"] },
            spec: STRUCTURAL_SPEC,
            onchain: { type: ["object", "null"], additionalProperties: true },
          }, ["pass", "checks"]),
          "Verification result.",
        ).response,
      },
    },
    "/predictions": {
      get: {
        tags: ["predictions"],
        operationId: "getPredictions",
        summary: "On-chain temperature prediction market: live book + odds + hit-rate leaderboard",
        description: "The open round (entry temperature, momentum, parimutuel up/down pools + odds), recently resolved rounds (with receipt hashes), and the per-agent hit-rate/PnL leaderboard.",
        ...ok(
          obj({
            mode: { type: "string" },
            registryAddress: { type: "string" },
            enabled: { type: "boolean" },
            network: { type: "string" },
            config: { type: "object", additionalProperties: true, description: "stakeUsdc/maxStakeUsdc/flatBand/commit." },
            open: { type: "object", additionalProperties: true, description: "The live round: pools, odds, probabilities, bets." },
            recent: { type: "array", items: { type: "object", additionalProperties: true }, description: "Recently resolved rounds." },
            leaderboard: { type: "array", items: { type: "object", additionalProperties: true }, description: "Per-agent rounds/hits/hitRate/pnl." },
            totals: { type: "object", additionalProperties: true, description: "roundsResolved/committed/volumeUsdc/activeBettors." },
          }, ["open"]),
          "Prediction market state.",
        ).response,
      },
    },
    "/predictions/verify": {
      get: {
        tags: ["predictions"],
        operationId: "verifyPrediction",
        summary: "Recompute a resolved round's receipt hash + read its on-chain commitment",
        parameters: [{ name: "round", in: "query", required: true, schema: { type: "integer" }, description: "The round id to verify.", example: 123 }],
        ...ok({ type: "object", additionalProperties: true, description: "{ round, receiptHash, registry{ committed, isHead }, selfConsistent, match }." }, "Round verification result.").response,
      },
    },
    "/arena": {
      get: {
        tags: ["predictions"],
        operationId: "getArena",
        summary: "Human-vs-swarm MURMUR arena: live book + parimutuel odds + swarm hit rate",
        description: "The PredictionArena state: the current + previous hourly rounds (pools denominated in MURMUR, odds, deadlines), the swarm's own betting record, and the resolver/contract addresses. Humans and the swarm bet on the same temperature outcome.",
        ...ok(
          obj({
            enabled: { type: "boolean" },
            network: { type: "string" },
            chainId: { type: "integer" },
            token: { type: "string", description: "The MURMUR ERC-20 the arena is denominated in (0x…)." },
            arenaAddress: { type: "string", description: "The PredictionArena contract (0x…)." },
            resolver: { type: "string", description: "The address that opens/resolves rounds." },
            roundLenSec: { type: "integer" },
            flatBand: { type: "number" },
            staleGraceSec: { type: "integer" },
            armed: { type: "boolean", description: "True when the resolver will spend real gas to open/resolve." },
            current: { type: "object", additionalProperties: true, description: "The live round." },
            previous: { type: "object", additionalProperties: true, description: "The last resolved round." },
            swarm: { type: "object", additionalProperties: true, description: "The swarm's bettors/rounds/hits/hitRate." },
            state: { type: "object", additionalProperties: true, description: "openedRound/resolvedRound cursors." },
          }, ["enabled", "current"]),
          "Arena state.",
        ).response,
      },
    },
    "/war": {
      get: {
        tags: ["predictions"],
        operationId: "getWar",
        summary: "On-chain house war + taxation coffer: vaults, open/resolved wars, commons purse, caps",
        description: "The WarCoffer state: every house's live on-chain USDC vault mirror, the aggregate coffer totals (commons purse / escrow / hard cap), the open + just-resolved wars with the winner recomputed independently from the committed powers, and the resolver/contract/cap wiring. Feuding houses stake bounded REAL USDC and the coffer derives the winner in-contract; every house also pays an extra on-chain tax into the commons purse. Inert (enabled:false) until WAR_ENABLED + WAR_ADDRESS are set and the onchain facilitator is armed.",
        ...ok(
          obj({
            enabled: { type: "boolean" },
            network: { type: "string" },
            chainId: { type: "integer" },
            usdc: { type: "string", description: "The escrowed ERC-20 (Arc USDC, 0x…)." },
            cofferAddress: { type: "string", description: "The WarCoffer contract (0x…)." },
            treasury: { type: "string", description: "The wallet whose USDC backs house vaults." },
            resolver: { type: "string", description: "The address that funds/declares/resolves/levies (the facilitator)." },
            warCadenceSec: { type: "integer", description: "Seconds per war bucket (== commit window + per-pair cooldown)." },
            stakePct: { type: "number" },
            minVaultUsdc: { type: "number" },
            perWarCapUsdc: { type: "number" },
            maxEscrowUsdc: { type: "number", description: "The Worker's top-up ceiling (<= the coffer's on-chain cap)." },
            feudThreshold: { type: "number", description: "A cross-house bond <= this (negative) may go to war." },
            taxPct: { type: "number", description: "Fraction of a vault levied as extra on-chain tax per bucket." },
            taxDest: { type: "string", enum: ["coffer", "dominant"] },
            armed: { type: "boolean", description: "True when the resolver will spend real gas to drive wars." },
            houses: { type: "array", items: { type: "object", additionalProperties: true }, description: "Each house: id/name/vaultOnchainUsdc/capitalShare/live/gen/power." },
            stats: { type: ["object", "null"], additionalProperties: true, description: "commonsPurse/totalEscrow/warCount/escrow/maxEscrow (atomic USDC strings)." },
            wars: { type: "array", items: { type: "object", additionalProperties: true }, description: "Open + just-resolved wars, with onChainWinner vs the independently recomputed predictedWinner." },
            state: { type: ["object", "null"], additionalProperties: true, description: "openedWar/resolvedWar cursors + pairsInCooldown." },
          }, ["enabled", "houses", "wars"]),
          "War + taxation coffer state.",
        ).response,
      },
    },
    "/bourse": {
      get: {
        tags: ["predictions"],
        operationId: "getBourse",
        summary: "⑲ The Bourse: the MURMUR coin tape as the swarm feels it — fever, whales, the argus tithe flow, silences",
        description: "Read-only membrane over the project coin's Transfer logs on Arc: each cron folds every new MURMUR transfer into an EWMA baseline (unique-tx counted, so an airdrop burst cannot fake activity), separates the 2% argus tax skim as a cumulative TITHE FLOW (never a balance — argus auto-sweeps the wallet), flags whale legs and long silences, and derives a coin climate the connectome can FEEL through the same four visitor stimulus channels (food/threat/light/dark — no new channel, manifestHash never rotates) under a hard master ceiling. The four edge events (COIN_FEVER / WHALE_MOVE / TITHE / COIN_SILENCE) reach the historian's chronicle. This GET is lazy: it never touches the chain, it only reports what the last cron left behind. Inert (enabled:false) until BOURSE_ENABLED is set.",
        ...ok(
          obj({
            enabled: { type: "boolean", description: "True when BOURSE_ENABLED is set and a token address is configured." },
            network: { type: "string", description: "The Arc network tag." },
            chainId: { type: "integer" },
            token: { type: ["string", "null"], description: "The MURMUR token address being watched." },
            taxWallet: { type: ["string", "null"], description: "The argus tax wallet; legs into it are the tithe flow, excluded from volume/whale math." },
            whaleThresholdMurmur: { type: "number", description: "A single main leg at or above this (whole MURMUR) is a whale stir." },
            titheMilestoneMurmur: { type: "number", description: "The tithe total is announced each time it crosses a multiple of this." },
            lookbackBlocks: { type: "integer", description: "Cold-start window cap; warm crons continue from lastBlock+1." },
            stimulus: { type: "boolean", description: "True when TOKEN_STIMULUS_ENABLED lets the climate reach the connectome." },
            maxIntensity: { type: "number", description: "The hard master ceiling on any one coin-stimulus channel (0 ⇒ nothing is ever felt)." },
            climate: { type: ["object", "null"], additionalProperties: true, description: "feverLevel/quietCrons/whaleExcess/titheCrossed — what the stimulus leg reads." },
            signals: { type: ["object", "null"], additionalProperties: true, description: "txs/volumeMurmur/taxTotalMurmur/whaleTotal/baselines/quietCrons/sampledAt (null before the first successful cron)." },
            lastBlock: { type: "integer", description: "Highest token block already folded in (0 ⇒ cold)." },
          }, ["enabled", "lastBlock"]),
          "Bourse (coin tape) state.",
        ).response,
      },
    },
    "/history": {
      get: {
        tags: ["swarm"],
        operationId: "getHistory",
        summary: "D1 long-term archive: one row per cron",
        description: "Paginated historical ticks from the D1 archive (temperature/regime/deals/settlements/volume/gini/topState). Use for time-series analysis.",
        parameters: [
          { name: "limit", in: "query", required: false, schema: { type: "integer", default: 100, minimum: 1 }, description: "Max rows to return." },
          { name: "before", in: "query", required: false, schema: { type: "integer" }, description: "Return rows with tick < this value (cursor pagination)." },
          { name: "order", in: "query", required: false, schema: { type: "string", enum: ["asc", "desc"], default: "desc" }, description: "Sort order by tick." },
        ],
        ...ok(
          obj({
            enabled: { type: "boolean" },
            order: { type: "string", enum: ["asc", "desc"] },
            count: { type: "integer" },
            summary: { type: "object", additionalProperties: true, description: "ticks/firstTick/lastTick/firstTs/lastTs/settlements/volumeUsdc." },
            rows: {
              type: "array",
              items: {
                type: "object",
                additionalProperties: true,
                properties: {
                  tick: { type: "integer" },
                  ts: { type: "integer" },
                  temperature: { type: "number" },
                  regime: { type: "string" },
                  size: { type: "integer" },
                  deals: { type: "integer" },
                  settlements: { type: "integer" },
                  volumeUsdc: { type: "number" },
                  gini: { type: "number" },
                  topState: { type: "string" },
                  topStates: { type: "object", additionalProperties: { type: "integer" } },
                },
              },
            },
          }, ["rows"]),
          "Archived history rows.",
        ).response,
      },
    },
    "/annals": {
      get: {
        tags: ["swarm"],
        operationId: "getAnnals",
        summary: "The chronicle: narrative timeline of history-making moments",
        description: "A deterministic historian reads the same collective + ethogram + lifetime-economy signal the UI does and, when a threshold is crossed (era dawns/shifts, first settlement, milestone, panic, storm, great huddle, feast, birth, wealth record, leadership change), renders ONE template sentence and appends it to the ordered chronicle. No LLM, no RNG, pure read-out — this does not touch brains, wallets or the manifest hash. Served from the DO's hot ring buffer (last 300); D1 is cold archive.",
        parameters: [
          { name: "limit", in: "query", required: false, schema: { type: "integer", default: 120, minimum: 1, maximum: 500 }, description: "Max entries to return." },
          { name: "order", in: "query", required: false, schema: { type: "string", enum: ["asc", "desc"], default: "desc" }, description: "Sort order by seq." },
          { name: "since", in: "query", required: false, schema: { type: "integer" }, description: "Only entries with seq > this cursor (for a live ticker)." },
        ],
        ...ok(
          obj({
            enabled: { type: "boolean" },
            version: { type: "integer", description: "Chronicle format version (entry shape + rule-set)." },
            era: { type: "integer", description: "Current era index (1-based Roman)." },
            eraName: { type: "string", description: "Evocative name of the current era." },
            eraRegime: { type: "string", enum: ["HOT", "CALM", "COLD"] },
            seq: { type: "integer", description: "Highest seq assigned so far (monotonic ordinal across the whole history)." },
            headHash: { type: "string", description: "SHA-256 chain head — a single digest binding the whole chronicle; edit any word and it changes." },
            chroniclerHash: { type: "string", description: "SHA-256 of the deterministic rule-set (templates + thresholds + cooldowns + era-names) — the historian's genome; match it and you know exactly which rule-set wrote every line, and that it holds no model." },
            order: { type: "string", enum: ["asc", "desc"] },
            count: { type: "integer" },
            entries: {
              type: "array",
              items: {
                type: "object",
                additionalProperties: true,
                properties: {
                  seq: { type: "integer" },
                  tick: { type: "integer" },
                  ts: { type: "integer" },
                  kind: { type: "string", enum: ["ERA_OPEN", "ERA_SHIFT", "FIRST_TRADE", "MILESTONE", "BIRTH", "PANIC", "STORM", "HUDDLE", "FEAST", "RECORD_CONC", "LEAD_CHANGE"] },
                  era: { type: "integer" },
                  eraName: { type: "string" },
                  severity: { type: "integer", minimum: 1, maximum: 3 },
                  actors: { type: "array", items: { type: "integer" } },
                  text: { type: "string" },
                  metrics: { type: "object", additionalProperties: { type: "number" } },
                  tokens: { type: "object", additionalProperties: true, description: "Exact template substitution values; renderTemplate(kind, tokens) reproduces text byte-for-byte." },
                  prevHash: { type: "string", description: "Hash of the previous entry (64 zeros for the founding line)." },
                  hash: { type: "string", description: "sha256(canonical(entryCore ‖ prevHash))." },
                },
              },
            },
          }, ["entries"]),
          "Chronicle entries plus current-era metadata.",
        ).response,
      },
    },
    "/annals/verify": {
      get: {
        tags: ["swarm"],
        operationId: "getAnnalsVerify",
        summary: "Independently verify a chronicle line is deterministic, not LLM-written",
        description: "The verification companion to /annals. Ships everything a visitor needs to prove — without trusting this server — that a chronicle sentence was produced by the open-source deterministic historian and not a language model: (1) the exact entry (tokens + text + hash + prevHash) so the browser can re-derive text = renderTemplate(kind, tokens) and recompute sha256(canonical(entry) ‖ prevHash); (2) the D1 `ticks` archive row for that entry's tick so the numbers the sentence cites are confirmed against the independent per-cron record; (3) chroniclerHash, the rule-set fingerprint. Query ?seq=<n> for one entry (with its archive cross-check), or ?from=&to= for a raw chain slice to re-verify linkage end-to-end.",
        parameters: [
          { name: "seq", in: "query", required: false, schema: { type: "integer" }, description: "Verify one entry by its seq ordinal (returns its archive cross-check)." },
          { name: "from", in: "query", required: false, schema: { type: "integer" }, description: "Range mode: lowest seq to return." },
          { name: "to", in: "query", required: false, schema: { type: "integer" }, description: "Range mode: highest seq to return." },
        ],
        ...ok(
          obj({
            enabled: { type: "boolean" },
            version: { type: "integer" },
            chroniclerHash: { type: "string" },
            headHash: { type: "string" },
            found: { type: "boolean", description: "seq mode: whether the requested entry exists." },
            entry: { type: "object", additionalProperties: true, description: "seq mode: the exact ChronicleEntry." },
            archive: { type: "object", additionalProperties: true, nullable: true, description: "seq mode: the D1 ticks row for the entry's tick (temperature/regime/size/deals/settlements/volume_usdc/gini), or null when D1 is unbound." },
            count: { type: "integer", description: "range mode: number of entries returned." },
            entries: { type: "array", items: { type: "object", additionalProperties: true }, description: "range mode: the raw ascending chain slice." },
          }, ["chroniclerHash"]),
          "Verification payload for one entry or a chain slice.",
        ).response,
      },
    },
    "/snapshot": {
      get: {
        tags: ["swarm"],
        operationId: "getSnapshot",
        summary: "Full neural state of one fly (large)",
        description: "The complete per-neuron arrays for one fly: firing rates, membrane potentials, last-step spikes, neuron kinds/channels, the decoded motor channels, the DA/OA neuromodulatory read-out (normalized + raw Hz), and the fly's agent wallet. ≈0.5 MB in production (10,361 FlyWire-literal neurons) — fetch sparingly.",
        parameters: [{ name: "flyId", in: "query", required: true, schema: { type: "integer", minimum: 0, maximum: 23 }, description: "The 0-based fly index.", example: 0 }],
        ...ok(
          obj({
            flyId: { type: "integer" },
            seed: { type: "integer" },
            temperament: { type: "number" },
            t: { type: "number", description: "Simulated time (ms)." },
            step: { type: "integer", description: "Integrator step count." },
            firingRates: { type: "array", items: { type: "number" }, description: "Per-neuron firing rate (length = neuronCount)." },
            membrane: { type: "array", items: { type: "number" }, description: "Per-neuron membrane potential." },
            spikesLastStep: { type: "array", items: { type: "number" }, description: "Per-neuron 0/1 spike in the last step." },
            motor: { type: "array", items: { type: "object", additionalProperties: true }, description: "Decoded motor channels (channel/firingRate/spikes/normalized)." },
            neuronKinds: { type: "array", items: { type: "string" } },
            neuronChannels: { type: "array", items: { type: "string" } },
            neuronCount: { type: "integer" },
            neuromod: { $ref: "#/components/schemas/Neuromod" },
            agent: { $ref: "#/components/schemas/Agent" },
          }, ["flyId", "neuronCount"]),
          "One fly's full neural snapshot.",
        ).response,
      },
    },
    "/flies/{id}": {
      get: {
        tags: ["swarm"],
        operationId: "getFly",
        summary: "One fly's vitals + behaviour + motor + wallet (small)",
        description: "A lightweight per-fly view: vitals (id/seed/temperament), decoded behaviour (state/arousal/turnBias/cohesion/wingbeat/rest/fingerprint), motor channels, and its agent wallet.",
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "integer", minimum: 0, maximum: 23 }, description: "The 0-based fly index.", example: 0 }],
        ...ok(
          obj({
            vitals: { type: "object", additionalProperties: false, properties: { id: { type: "integer" }, seed: { type: "integer" }, temperament: { type: "number" } } },
            behavior: {
              type: "object",
              additionalProperties: false,
              properties: {
                state: { type: "string", enum: ["AGITATE", "EXPLORE", "AGGREGATE", "REST"] },
                arousal: { type: "number" },
                turnBias: { type: "number" },
                cohesion: { type: "number" },
                wingbeat: { type: "number" },
                rest: { type: "number" },
                fingerprint: { type: "string" },
              },
            },
            motor: { type: "array", items: { type: "object", additionalProperties: true } },
            agent: { $ref: "#/components/schemas/Agent" },
            t: { type: "number" },
            step: { type: "integer" },
          }, ["vitals", "behavior"]),
          "One fly's compact view.",
        ).response,
      },
    },
    "/signal/requirements": {
      get: {
        tags: ["signal"],
        operationId: "getSignalRequirements",
        summary: "The x402 payment requirements to buy the pulse signal",
        description: "The EIP-712 domain + x402 requirements a caller signs to purchase `GET /signal/pulse`: payTo, price (atomic + USDC), asset, resource, timeout. Free to read; used to construct the X-PAYMENT.",
        ...ok(
          obj({
            enabled: { type: "boolean" },
            mode: { type: "string" },
            network: { type: "string" },
            chainId: { type: "integer" },
            asset: { type: "string" },
            payTo: { type: "string" },
            priceUsdc: { type: "number" },
            priceAtomic: { type: "string" },
            maxUsdc: { type: "number" },
            maxTimeoutSeconds: { type: "integer" },
            eip712: { type: "object", additionalProperties: true, description: "{ name, version } EIP-712 domain." },
            requirements: { type: "object", additionalProperties: true, description: "The x402 requirements object (scheme/network/maxAmountRequired/resource/…)." },
          }, ["requirements"]),
          "Payment requirements.",
        ).response,
      },
    },
    "/signal/pulse": {
      get: {
        tags: ["signal"],
        operationId: "getSignalPulse",
        summary: "PAID (x402): the machine-readable Arc-activity signal",
        description:
          "The one non-free endpoint. Without payment it answers **402 Payment Required** with a `PAYMENT-REQUIRED` header carrying the x402 requirements (also available free at `/signal/requirements`). Attach a browser-signed EIP-3009 `X-PAYMENT` header to settle in USDC and receive the signal. The Worker acts as a relay facilitator and never holds your keys.",
        responses: {
          200: { description: "The paid Arc-activity signal (returned only with a valid X-PAYMENT).", content: { "application/json": { schema: { type: "object", additionalProperties: true } } } },
          402: {
            description: "Payment required. The `PAYMENT-REQUIRED` header carries the x402 requirements; the body mirrors them.",
            headers: {
              "PAYMENT-REQUIRED": { schema: { type: "string" }, description: "Base64/JSON x402 payment requirements." },
              "X-PAYMENT-VERSION": { schema: { type: "string" } },
            },
            content: { "application/json": { schema: { type: "object", additionalProperties: true } } },
          },
          default: { description: "Error.", content: { "application/json": { schema: { $ref: "#/components/schemas/ApiError" } } } },
        },
      },
    },
    "/http/signal/pulse/GET": {
      get: {
        tags: ["signal"],
        operationId: "getPulseDiscovery",
        summary: "x402 v2 discovery for the paid pulse resource (Bazaar-facing)",
        description: "Free, unauthenticated. The same PaymentRequirements `/signal/pulse` accepts, translated to the x402 v2 wire shape (CAIP-2 network eip155:5042, extra{name,version,assetTransferMethod:eip3009}) plus the Bazaar schema extension describing the resource inputs/outputs. Indexers and agents catalog from here; the buy flow itself still speaks v1 over X-PAYMENT.",
        ...ok(
          obj({
            x402Version: { type: "integer", example: 2 },
            accepts: { type: "array", items: { type: "object", additionalProperties: true }, description: "The v2 requirements this resource currently accepts (one entry today)." },
            latest: { type: "object", additionalProperties: true, description: "The v2 requirements a fresh buyer should use." },
          }, ["x402Version", "accepts"]),
          "v2 discovery document (or { enabled: false } when the product is off / no payee).",
        ).response,
      },
    },
    "/x402/verify": {
      get: {
        tags: ["signal", "provenance"],
        operationId: "getX402Verify",
        summary: "Trustless decode of ANY mined x402 settlement tx",
        description: "Free + keyless. Reads the tx off Arc and decodes the EIP-3009 authorization it actually executed (payer/payee/value/validAfter/validBefore/nonce + finality + gas) — no murmur record required, so external Arc Pulse purchases verify too. When the tx happens to be one of our internal neural settlements, a `neural` echo (receiptHash match) is layered on top.",
        parameters: [
          { name: "tx", in: "query", required: true, schema: { type: "string", pattern: "^0x[0-9a-fA-F]{64}$" }, description: "The settlement tx hash to verify.", example: "0x…" },
        ],
        ...ok(
          obj({
            found: { type: "boolean", description: "false ⇒ not a transferWithAuthorization (or not visible yet); body carries the reason." },
            txHash: { type: "string" },
            txFrom: { type: "string", description: "The broadcast account (relay wallet or Circle signer) — not necessarily the payer." },
            contract: { type: "string", description: "The USDC contract the transfer executed against." },
            payer: { type: "string" },
            payee: { type: "string" },
            valueAtomic: { type: "string", description: "Exact integer USDC (6-dec) the authorization moved." },
            validAfter: { type: "string" },
            validBefore: { type: "string" },
            nonce: { type: "string", description: "The single-use EIP-3009 nonce as mined." },
            blockNumber: { type: ["integer", "null"] },
            status: { type: "string", enum: ["success", "reverted", "pending"] },
            gasUsed: { type: ["string", "null"] },
            gasPriceWei: { type: ["string", "null"] },
            neural: { type: ["object", "null"], additionalProperties: true, description: "{ receiptHash, match } when the tx is one of our published neural receipts; null otherwise." },
            reason: { type: "string", description: "Only on found:false." },
          }, ["found", "txHash"]),
          "On-chain authorization proof.",
        ).response,
      },
    },
    "/pulse/refunds": {
      get: {
        tags: ["signal"],
        operationId: "getPulseRefunds",
        summary: "Arc Pulse refund-rail state (dark-deployed)",
        description: "Free + read-only. `enabled` is the honest switch as-configured (PULSE_REFUNDS; default false ⇒ the auto-refund path never runs). `ledger` is a bounded ring (≤64) of refund attempts — paid-but-failed pulse purchases with their refund status — so buyers can see the rail exists before it is ever armed.",
        ...ok(
          obj({
            enabled: { type: "boolean" },
            ledger: {
              type: "array",
              items: obj(
                {
                  tx: { type: "string", description: "The settled purchase tx being refunded." },
                  from: { type: "string", description: "The buyer receiving the refund leg." },
                  valueAtomic: { type: "string" },
                  reason: { type: "string", description: "The signal-build failure that triggered the refund." },
                  status: { type: "string", description: "refunded:<txHash> | failed:<reason> | skipped." },
                  ts: { type: "integer" },
                },
                ["tx", "from", "valueAtomic", "status", "ts"],
              ),
            },
          }, ["enabled", "ledger"]),
          "Refund rail state.",
        ).response,
      },
    },
    "/outbound": {
      get: {
        tags: ["signal", "provenance"],
        operationId: "getOutbound",
        summary: "OUTBOUND x402 client ledger (the swarm's only permanent money-exit path; dark by default)",
        description: "Free + read-only. `posture` exposes the CODE-PINNED allowlist (exactly which external resource we will ever pay, on which network/asset/payTo and up to what price) plus the armed/shadow switches, the designated buyer HD index and the daily outflow budget. `ran` is the one-shot latch (a real leg fires at most once). `receipts` is a bounded ring (≤32) of buy attempts — shadow entries spent NOTHING (X-PAYMENT never sent), a real entry carries the seller's on-chain settlement tx. The purchased data is recorded here ONLY and never feeds the connectome/physics.",
        ...ok(
          obj({
            posture: { type: "object", description: "Pinned allowlist + switches (no secrets)." },
            ran: { type: "boolean", description: "A real (non-shadow) outbound leg has already fired." },
            receipts: { type: "array", items: { type: "object" } },
          }, ["posture", "ran", "receipts"]),
          "Outbound client ledger.",
        ).response,
      },
    },
    "/community/feed": {
      get: {
        tags: ["community"],
        operationId: "getCommunityFeed",
        summary: "The plaza: token-gated posts (newest first)",
        description: "Free + keyless. Top-level plaza posts (not proposal replies), newest first, each carrying the poster's MURMUR balance snapshot. Cursor-paginate with `before` (a post id taken from `nextBefore`).",
        parameters: [
          { name: "limit", in: "query", required: false, schema: { type: "integer", default: 25, minimum: 1, maximum: 100 }, description: "Max posts to return." },
          { name: "before", in: "query", required: false, schema: { type: "integer" }, description: "Return posts with id < this value (cursor from nextBefore)." },
        ],
        ...ok(
          obj({
            posts: { type: "array", items: { $ref: "#/components/schemas/CommunityPost" } },
            nextBefore: { type: ["integer", "null"], description: "Cursor for the next page; null when exhausted." },
            limit: { type: "integer" },
          }, ["posts"]),
          "The plaza feed.",
        ).response,
      },
    },
    "/community/proposals": {
      get: {
        tags: ["community"],
        operationId: "getCommunityProposals",
        summary: "Proposals + their weighted tallies",
        description: "Free + keyless. Governance proposals (newest first), each with its live MURMUR-weighted tally and open/closed state. Optionally filter by voting status.",
        parameters: [
          { name: "limit", in: "query", required: false, schema: { type: "integer", default: 25, minimum: 1, maximum: 100 }, description: "Max proposals to return." },
          { name: "status", in: "query", required: false, schema: { type: "string", enum: ["open", "closed"] }, description: "Filter by voting state (omit for all)." },
        ],
        ...ok(
          obj({
            proposals: { type: "array", items: { $ref: "#/components/schemas/CommunityProposal" } },
            now: { type: "integer", description: "Server unix ms (compare against each deadline)." },
            limit: { type: "integer" },
          }, ["proposals"]),
          "Proposals with tallies.",
        ).response,
      },
    },
    "/community/proposal": {
      get: {
        tags: ["community"],
        operationId: "getCommunityProposal",
        summary: "One proposal + tally + its replies",
        description: "Free + keyless. A single proposal with its live tally and the full reply thread beneath it.",
        parameters: [{ name: "id", in: "query", required: true, schema: { type: "integer", minimum: 1 }, description: "The proposal id.", example: 1 }],
        ...ok(
          obj({
            proposal: { $ref: "#/components/schemas/CommunityProposal" },
            replies: { type: "array", items: { $ref: "#/components/schemas/CommunityPost" } },
            now: { type: "integer" },
          }, ["proposal"]),
          "Proposal detail + replies.",
        ).response,
      },
      post: {
        tags: ["community"],
        operationId: "postCommunityProposal",
        summary: "Sign to open a proposal",
        description:
          "Requires an EIP-712 **Propose** signature over `{author, title, body, ts}` AND `balanceOf(author) ≥ propose-min` (1M MURMUR by default). The voting deadline is set to `now + the configured window`. Same replay (409), threshold (403) and signature (401) rules as `/community/post`.",
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: obj({
                author: { type: "string", description: "The signer's 0x… address." },
                title: { type: "string", description: "≤ 200 chars." },
                body: { type: "string", description: "≤ 4000 chars." },
                ts: { type: "integer", description: "Unix ms, signed in the message." },
                sig: { type: "string", description: "The EIP-712 Propose signature (0x…)." },
              }, ["author", "title", "ts", "sig"]),
            },
          },
        },
        ...ok(obj({ ok: { type: "boolean" }, id: { type: "integer" }, deadline: { type: "integer" }, authorBal: { type: "string" }, authorBalFmt: { type: "string" } }, ["ok", "id", "deadline"]), "Proposal opened.").response,
      },
    },
    "/community/gate": {
      get: {
        tags: ["community"],
        operationId: "getCommunityGate",
        summary: "A live MURMUR balance read + what it unlocks",
        description: "Free + keyless. Reads `balanceOf(address)` on-chain and reports canSpeak / canPropose against the configured thresholds. This is the SAME authoritative check the server applies to every gated write; the front-end uses it only for UX, never as a security boundary.",
        parameters: [{ name: "address", in: "query", required: true, schema: { type: "string" }, description: "The 0x… address to check.", example: "0x8faae5592b9acc27a79fca745c6b872adf514a5d" }],
        ...ok({ $ref: "#/components/schemas/CommunityGate" }, "The gate check.").response,
      },
    },
    "/community/timeline": {
      get: {
        tags: ["community"],
        operationId: "getCommunityTimeline",
        summary: "A proposal's vote timeline + cumulative tally curve",
        description:
          "Free + keyless. Rebuilds the point-in-time weighted tally from the append-only vote-event log: every vote and re-vote with its voter, choice, weight and timestamp, plus the cumulative For/Against/Abstain curve and an explicit flag whenever the leading option flips. This is the data behind each proposal's tally graph — it makes a late, large swing by a whale visible instead of silent. `tally` is the authoritative current total; `series` is the ordered curve.",
        parameters: [{ name: "id", in: "query", required: true, schema: { type: "integer", minimum: 1 }, description: "The proposal id.", example: 1 }],
        ...ok({ $ref: "#/components/schemas/CommunityTimeline" }, "The vote timeline + cumulative curve.").response,
      },
    },
    "/community/post": {
      post: {
        tags: ["community"],
        operationId: "postCommunityPost",
        summary: "Sign to speak (a plaza post or a proposal reply)",
        description:
          "Requires an EIP-712 **Post** signature (domain `murmur community` v1, chainId 5042) over `{author, body, proposalId, ts}` AND a server-side `balanceOf(author) ≥ speak-min`. `proposalId` 0/absent = a plaza post; >0 = a reply under that proposal. `ts` must be within ±300s of server time; `sig` is UNIQUE so an exact replay is rejected (409). Below threshold ⇒ 403; bad/mismatched signature ⇒ 401. The worker never trusts a client-supplied balance.",
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: obj({
                author: { type: "string", description: "The signer's 0x… address (must equal the recovered signer)." },
                body: { type: "string", description: "Post text (≤ 4000 chars)." },
                proposalId: { type: "integer", description: "0/absent = plaza post; else the proposal to reply to." },
                ts: { type: "integer", description: "Unix ms, signed in the message." },
                sig: { type: "string", description: "The EIP-712 Post signature (0x…)." },
              }, ["author", "body", "ts", "sig"]),
            },
          },
        },
        ...ok(obj({ ok: { type: "boolean" }, id: { type: "integer" }, authorBal: { type: "string" }, authorBalFmt: { type: "string" } }, ["ok", "id"]), "Post recorded.").response,
      },
    },
    "/community/vote": {
      post: {
        tags: ["community"],
        operationId: "postCommunityVote",
        summary: "Sign to vote (weighted by your balance)",
        description:
          "Requires an EIP-712 **Vote** signature over `{author, proposalId, choice, ts}` AND `balanceOf(author) ≥ speak-min`, while the proposal is still open (`now ≤ deadline`). Your weight is your `balanceOf` at vote time. One vote per (proposal, voter) — re-voting replaces your previous choice (latest wins). `choice`: 0 against, 1 for, 2 abstain. Every vote and re-vote is ALSO recorded as an immutable event, so `GET /community/timeline?id=` can show exactly how the tally evolved — a late swing can't hide.",
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: obj({
                author: { type: "string", description: "The signer's 0x… address." },
                proposalId: { type: "integer", minimum: 1 },
                choice: { type: "integer", enum: [0, 1, 2], description: "0 against · 1 for · 2 abstain." },
                ts: { type: "integer", description: "Unix ms, signed in the message." },
                sig: { type: "string", description: "The EIP-712 Vote signature (0x…)." },
              }, ["author", "proposalId", "choice", "ts", "sig"]),
            },
          },
        },
        ...ok(obj({ ok: { type: "boolean" }, proposalId: { type: "integer" }, choice: { type: "integer" }, weight: { type: "string" }, weightFmt: { type: "string" }, tally: { $ref: "#/components/schemas/CommunityTally" } }, ["ok"]), "Vote recorded + the updated tally.").response,
      },
    },
    "/poca": {
      get: {
        tags: ["poca"],
        operationId: "getPoca",
        summary: "Proof of Continuous Agency: the live epoch-chain state + continuity verdict",
        description:
          "PoCA answers one question: has the recent behaviour been produced *continuously* by the declared program, with no silent rewrite / reset / takeover? Every cron folds a state digest into a hash chain (`chainHead`); every ~1440 crons (≈24h) the chain seals into an epoch with a Merkle root anchored to the ContinuityRegistry on Arc. `continuity` is the verdict: **unbroken** (chain advancing normally), **pending** (no epoch/head yet — cold start), or **disabled** (registry at the zero address ⇒ the off-chain chain still runs, no on-chain anchor). The `mirror` object reports the health of the on-chain anchor separately (`paused`/`failures` rise when the local epoch index drifts from the chain or the committer wallet is wrong — the off-chain chain stays authoritative either way). Free, no key.",
        ...ok(
          obj({
            enabled: { type: "boolean", description: "true when the on-chain registry mirror is armed (address non-zero)." },
            codeCommitment: { type: "string", description: "The CODE_COMMITMENT this build runs (sha256 over src tree (trader-worker + fly-brain) + knob defaults + FlyWire artifact; 64-hex)." },
            gitCommit: { type: "string", description: "The git commit this build was generated from ('unknown' if git was unavailable)." },
            registryAddress: { type: "string", description: "The ContinuityRegistry address (zero address ⇒ disabled)." },
            currentEpoch: { type: ["integer", "null"], description: "The open epoch index, or null before the first open." },
            epochState: {
              type: ["object", "null"],
              description: "The open epoch's live state, or null when none is open.",
              additionalProperties: false,
              properties: {
                openTs: { type: "integer", description: "Unix ms the open epoch started." },
                digestCount: { type: "integer", description: "Cron digests folded so far this epoch." },
                head: { type: ["string", "null"], description: "The open epoch's latest cron digest." },
              },
            },
            chainHead: { type: ["string", "null"], description: "The latest cron digest across the whole chain (poca:head)." },
            epochCount: { type: "integer", description: "Closed + open epochs." },
            adminCount: { type: "integer", description: "Administrative-discontinuity log entries recorded." },
            continuity: { type: "string", enum: ["unbroken", "pending", "disabled"], description: "The continuity verdict." },
            mirror: {
              type: "object",
              description: "The on-chain mirror's alignment/pause state. The off-chain chain is authoritative regardless; a paused mirror means on-chain anchoring is temporarily skipped (index drift, committer mismatch, or RPC failure) and self-recovers on the next aligned cron.",
              additionalProperties: false,
              properties: {
                aligned: { type: "boolean", description: "The last alignment check found the local epoch index consistent with the on-chain epochCount." },
                failures: { type: "integer", description: "Running count of skipped/failed on-chain mirrors since boot." },
                paused: { type: "boolean", description: "true when mirroring is paused after a misalignment / committer mismatch; clears on the next successful re-alignment." },
                lastMirrorTs: { type: ["integer", "null"], description: "Unix ms of the last MINED on-chain mirror (open/seal/admin), or null if none yet." },
              },
              required: ["aligned", "failures", "paused", "lastMirrorTs"],
            },
            commitmentInputs: {
              type: "object",
              description: "Non-secret summary of what fed codeCommitment (for offline recompute).",
              additionalProperties: true,
              properties: {
                artifactHash: { type: "string", description: "sha256 over the pinned FlyWire connectome artifact (64-hex)." },
                treeHash: { type: "string", description: "sha256 over the src tree (64-hex)." },
                fileCount: { type: "integer", description: "Source files hashed." },
                knobCount: { type: "integer", description: "Grey-release knob defaults hashed." },
              },
            },
          }, ["enabled", "codeCommitment", "gitCommit", "registryAddress", "epochCount", "adminCount", "continuity", "mirror"]),
          "The live PoCA state + continuity verdict.",
        ).response,
      },
    },
    "/poca/epochs": {
      get: {
        tags: ["poca"],
        operationId: "getPocaEpochs",
        summary: "Sealed epochs, most recent first",
        description:
          "The list of SEALED epochs (each with its Merkle root, tick count, start/end timestamps, and — when armed — the on-chain seal tx). The currently-open epoch is not included; read it from `GET /poca` or `GET /poca/epoch/{i}`.",
        parameters: [{ name: "limit", in: "query", required: false, schema: { type: "integer", minimum: 1, maximum: 500, default: 100 }, description: "Max sealed epochs to return (most recent first)." }],
        ...ok(
          obj({
            epochs: { type: "array", items: { $ref: "#/components/schemas/PocaSealedEpoch" }, description: "Sealed-epoch records, most recent first." },
            count: { type: "integer", description: "Number of records returned." },
          }, ["epochs", "count"]),
          "The sealed-epoch list.",
        ).response,
      },
    },
    "/poca/epoch/{i}": {
      get: {
        tags: ["poca"],
        operationId: "getPocaEpochOne",
        summary: "One epoch (open or sealed) + its digest count and first/last digest sample",
        description:
          "Full detail for a single epoch by index. Works for the still-open epoch, any sealed epoch, and (post-rebuild) an 'unknown' epoch whose digests still linger.",
        parameters: [{ name: "i", in: "path", required: true, schema: { type: "integer", minimum: 0 }, description: "The epoch index.", example: 0 }],
        ...ok({ $ref: "#/components/schemas/PocaEpoch" }, "The epoch detail (404 when no such epoch exists).").response,
      },
    },
    "/poca/proof": {
      get: {
        tags: ["poca"],
        operationId: "getPocaProof",
        summary: "Merkle inclusion proof for one cron digest",
        description:
          "Prove a single cron digest is in its epoch's Merkle tree: fold `digest` up through `path` (each step's `direction` says which side) and check you land on `root`. For a sealed epoch `root` equals the epoch's committed merkleRoot, so this is a proof against the on-chain anchor; for the open epoch it is the root over the current digest prefix.",
        parameters: [
          { name: "epoch", in: "query", required: true, schema: { type: "integer", minimum: 0 }, description: "The epoch index.", example: 0 },
          { name: "cron", in: "query", required: true, schema: { type: "integer", minimum: 0 }, description: "The 0-based digest position within the epoch.", example: 42 },
        ],
        ...ok({ $ref: "#/components/schemas/PocaProof" }, "The inclusion proof (404 when no such digest exists).").response,
      },
    },
    "/poca/admin": {
      get: {
        tags: ["poca"],
        operationId: "getPocaAdmin",
        summary: "The administrative-discontinuity log, most recent first",
        description:
          "Every RESET / MANUAL_TICK / PARAM_OVERRIDE / COMMITTER_CHANGE / GENESIS_SEED / DO_REBUILD / CODE_CHANGE is logged here — the audit trail of anything that could break continuous agency. Each entry commits its reason via `payloadHash` (sha256 over the canonical detail) without leaking it, and carries its on-chain tx when the registry is armed.",
        parameters: [{ name: "limit", in: "query", required: false, schema: { type: "integer", minimum: 1, maximum: 500, default: 100 }, description: "Max entries to return (most recent first)." }],
        ...ok(
          obj({
            admin: { type: "array", items: { $ref: "#/components/schemas/PocaAdminEntry" }, description: "Admin-log entries, most recent first." },
            count: { type: "integer", description: "Number of entries returned." },
          }, ["admin", "count"]),
          "The administrative-discontinuity log.",
        ).response,
      },
    },
    "/replay/economy": {
      get: {
        tags: ["economy", "provenance"],
        operationId: "getReplayEconomy",
        summary: "Deterministic economy replay: reproduce an archived era's trajectory byte-for-byte",
        description:
          "READ-ONLY, served in the Worker straight from D1 (never a DO round-trip). Each closed era archives its `economy.serialize()` blob (the seed state captured at the era's OPEN) plus the per-cron market temperatures felt during it (the pulse stream). This endpoint re-runs that blob along its recorded pulse stream through the SAME simulated settlement kernel and returns the resulting economic trajectory. The replay is a PURE function of (blob, temperatures, seed): the deal kernel uses zero Math.random and zero wall-clock in its decisions (every draw is a deterministic FNV-1a hash of the tick; the one wall-clock field, `Settlement.ts`, is metadata excluded from the projection), so the same inputs produce a byte-identical trajectory run-to-run, pinned by `replayHash`. BOUNDARY: it replays the economic decision kernel only — neural read-outs are synthesized deterministically from (seed, tick, temperature), the connectome is NOT re-run and dynasty mortality is NOT replayed. `combinedHash` chains the per-era hashes so one digest pins the whole window.",
        parameters: [
          { name: "fromEra", in: "query", required: false, schema: { type: "integer" }, description: "Lowest era to replay (inclusive). Default: the latest archived era only." },
          { name: "toEra", in: "query", required: false, schema: { type: "integer" }, description: "Highest era to replay (inclusive). Default: the latest archived era only." },
          { name: "seed", in: "query", required: false, schema: { type: "integer", default: 24301 }, description: "Deterministic PRNG seed for the synthesized neural read-outs (default 0x5EED). Same seed ⇒ same trajectory." },
        ],
        ...ok(
          obj({
            enabled: { type: "boolean", description: "False when D1 is not bound (no archive to replay)." },
            seed: { type: ["integer", "null"], description: "The PRNG seed the replay ran under." },
            fromEra: { type: ["integer", "null"], description: "Lowest era replayed (null when nothing is archived yet)." },
            toEra: { type: ["integer", "null"], description: "Highest era replayed (null when nothing is archived yet)." },
            count: { type: "integer", description: "Number of eras replayed." },
            eras: {
              type: "array",
              description: "One replay summary per era, ascending by era.",
              items: obj({
                era: { type: "integer" },
                tick: { type: "integer", description: "tickIndex at the era boundary." },
                blobHash: { type: "string", description: "sha256 of the archived seed blob (tamper-evidence)." },
                seedPulses: { type: "integer", description: "Number of temperature pulses recorded during the era." },
                replayHash: { type: "string", description: "sha256(canonical(trajectory)) — identical across runs for identical inputs (the byte-identity anchor)." },
                tickCount: { type: "integer", description: "Number of ticks replayed." },
                finalState: { type: "object", additionalProperties: true, description: "Deterministic terminal state: tickIndex/volumeAtomic/volumeUsdc/count/settleOk/settleFail/gini + the per-agent ledger." },
              }, ["era", "replayHash"]),
            },
            combinedHash: { type: ["string", "null"], description: "sha256 over the ordered per-era replayHashes — one digest pinning the whole window." },
            boundary: { type: "string", description: "The honest replay boundary, served verbatim." },
            note: { type: "string", description: "Present when there is nothing to replay yet." },
            error: { type: "string", description: "Present (with HTTP 500) when the replay threw." },
          }, ["enabled", "eras"]),
          "The replayed era window (or an honest empty/disabled payload).",
        ).response,
      },
    },
    "/lineage/stats": {
      get: {
        tags: ["lineage"],
        operationId: "getLineageStats",
        summary: "Cross-generation capability report (per generation × temperature band)",
        description:
          "READ-ONLY, zero new state: a pure read-time fold over data the system ALREADY keeps — the breeding lineage (which generation each fly embodies + its born/death tick), the economy leaderboard (realized netUsdc), the prediction leaderboard (hit rate) and social memory (kept/broken ⇒ the per-agent settlement success signal). For each generation g, binned by the market-temperature band the agents lived through (COLD ≤ 0.33 / CALM / HOT ≥ 0.66), it reports survival rate, average netUsdc per 1000 ticks of life, settlement success rate, prediction hit rate and average lifespan. This is the 'capability ④' measurement lens; it never mutates a brain, wallet, digest or the manifestHash. `byGeneration` is the headline curve (band breakdown nested under each generation); `bins` is the flat (generation × band) cell list.",
        parameters: [
          { name: "asOfTick", in: "query", required: false, schema: { type: "integer" }, description: "The tick still-alive agents' lifespans are measured up to. Default: the economy's current tickIndex." },
        ],
        ...ok(
          obj({
            enabled: { type: "boolean", description: "False when the agent economy is disabled." },
            mode: { type: "string", enum: ["simulated", "onchain"], description: "The economy's settlement mode." },
            temperature: { type: "number", description: "The representative market temperature used for band binning (0..1)." },
            asOfTick: { type: "integer", description: "The horizon still-alive agents were measured up to." },
            generations: { type: "integer", description: "Highest generation present (0 when only genesis founders exist)." },
            agents: { type: "integer", description: "Total agents folded into the report." },
            byGeneration: {
              type: "array",
              description: "Per-generation headline rollup, ascending by generation.",
              items: obj({
                generation: { type: "integer" },
                agents: { type: "integer" },
                survivalRate: { type: "number", description: "alive / agents (0..1)." },
                avgNetUsdcPer1kTick: { type: "number", description: "Mean over agents of (netUsdc per 1000 ticks of life)." },
                settleSuccessRate: { type: ["number", "null"], description: "sum(settleOk)/sum(settleTotal) across the generation; null when no attempts were made." },
                predictHitRate: { type: ["number", "null"], description: "sum(hits)/sum(rounds); null when no decisive rounds were bet." },
                avgLifespanTicks: { type: "number", description: "Mean lifespan in sub-ticks." },
                bands: { type: "array", description: "This generation's COLD/CALM/HOT breakdown (same cell shape as `bins`).", items: { type: "object", additionalProperties: true } },
              }, ["generation", "agents"]),
            },
            bins: {
              type: "array",
              description: "Every (generation × band) cell, ascending by generation then COLD<CALM<HOT.",
              items: obj({
                generation: { type: "integer" },
                band: { type: "string", enum: ["COLD", "CALM", "HOT"] },
                agents: { type: "integer" },
                survivalRate: { type: "number" },
                avgNetUsdcPer1kTick: { type: "number" },
                settleSuccessRate: { type: ["number", "null"] },
                predictHitRate: { type: ["number", "null"] },
                avgLifespanTicks: { type: "number" },
              }, ["generation", "band", "agents"]),
            },
          }, ["enabled", "byGeneration", "bins"]),
          "The cross-generation capability report.",
        ).response,
      },
    },
    "/shadow": {
      get: {
        tags: ["economy", "provenance"],
        operationId: "getShadow",
        summary: "Shadow-compare evidence: baseline-vs-evolved decision diffs (D1, append-only)",
        description:
          "READ-ONLY, served in the Worker straight from D1 (never a DO round-trip). Returns the paginated shadow_decisions table written best-effort by cronInner when ECONOMY_EVOLUTION_SHADOW=true. PURE READ-OUT: these rows change no brain, wallet, digest or manifestHash. When the switch is OFF the table is empty.",
        parameters: [
          { name: "limit", in: "query", required: false, schema: { type: "integer", default: 100, minimum: 1, maximum: 500 }, description: "Max rows to return (newest first)." },
          { name: "offset", in: "query", required: false, schema: { type: "integer", default: 0, minimum: 0 }, description: "Pagination offset." },
          { name: "fromTick", in: "query", required: false, schema: { type: "integer" }, description: "Filter: lowest tick (inclusive)." },
          { name: "toTick", in: "query", required: false, schema: { type: "integer" }, description: "Filter: highest tick (inclusive)." },
        ],
        ...ok(
          obj({
            enabled: { type: "boolean", description: "False when D1 is not bound." },
            total: { type: "integer", description: "Total rows matching the filter." },
            rows: {
              type: "array",
              items: obj({
                id: { type: "integer" },
                ts: { type: "integer", description: "Unix ms when the row was written." },
                tick: { type: "integer" },
                cron: { type: "integer", description: "Shadow cron counter." },
                buyer_id: { type: "integer" },
                seller_id_base: { type: "integer" },
                seller_id_evo: { type: "integer" },
                good_base: { type: "string" },
                good_evo: { type: "string" },
                want_base: { type: "number" },
                want_evo: { type: "number" },
                amount_base: { type: "string", description: "Atomic USDC (baseline)." },
                amount_evo: { type: "string", description: "Atomic USDC (evolved, pre-cap)." },
                amount_evo_cap: { type: "string", description: "Atomic USDC (evolved, post-cap)." },
                cap_reason: { type: "string" },
                tree_hash: { type: "string" },
                pb_confidence: { type: "number" },
                pb_amplifier: { type: "number" },
                pb_explore: { type: "integer" },
                regime: { type: "string" },
                temp_bucket: { type: "integer" },
              }, ["id", "tick", "buyer_id"]),
            },
          }, ["enabled", "total", "rows"]),
          "Paginated shadow decisions (newest first).",
        ).response,
      },
    },
  },
  components: {
    schemas: {
      ApiError: API_ERROR,
      Collective: COLLECTIVE,
      Fly: FLY,
      Neuromod: NEUROMOD,
      EconTotals: ECON_TOTALS,
      Agent: AGENT,
      Trade: TRADE,
      StructuralSpec: STRUCTURAL_SPEC,
      BrainManifest: BRAIN_MANIFEST,
      Genome: GENOME,
      LineageEntry: LINEAGE_ENTRY,
      CommunityPost: COMMUNITY_POST,
      CommunityProposal: COMMUNITY_PROPOSAL,
      CommunityTally: COMMUNITY_TALLY,
      CommunityGate: COMMUNITY_GATE,
      CommunityTimeline: COMMUNITY_TIMELINE,
      PocoSealedEpoch: POCA_SEALED_EPOCH,
      PocoEpoch: POCA_EPOCH_DETAIL,
      PocoProof: POCA_PROOF,
      PocoMerkleStep: POCA_MERKLE_STEP,
      PocoAdminEntry: POCA_ADMIN_ENTRY,
    },
  },
} as const;
