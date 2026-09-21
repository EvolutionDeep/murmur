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
      type: "object",
      description: "The generator sizing (production is the 10x brain).",
      additionalProperties: false,
      properties: {
        nSensory: { type: "integer" },
        nInterL1: { type: "integer" },
        nInterL2: { type: "integer" },
        nModulatory: { type: "integer" },
        nMotorPerChannel: { type: "integer" },
        density: { type: "number" },
      },
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
        flywireLiteral: { type: "boolean", description: "False: connectomes are generated deterministically, not copied literally from FlyWire." },
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
    summary: "Read-only JSON API into a live, autonomous economy of 24 fruit-fly nervous systems settling real USDC on Arc.",
    description: [
      "**murmur** is a population of 24 spiking LIF connectomes (~10,800 neurons each) grown deterministically from a real",
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
        description: "Every agent wallet (address/balance/paid/earned/deals/sales), the recent + last-tick deal feeds, the settlement scheme/network/asset, and cumulative totals. This is the authoritative economy view.",
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
          }, ["agents", "totals"]),
          "Full economy view.",
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
        description: "The complete per-neuron arrays for one fly: firing rates, membrane potentials, last-step spikes, neuron kinds/channels, the decoded motor channels, and the fly's agent wallet. ~600 KB in production (10,800 neurons) — fetch sparingly.",
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
  },
  components: {
    schemas: {
      ApiError: API_ERROR,
      Collective: COLLECTIVE,
      Fly: FLY,
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
    },
  },
} as const;
