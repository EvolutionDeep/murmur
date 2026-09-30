// ============================================================================
// jev.ts — a TypeSafe "Jev" (System One) client for murmur's READ-OUT side-plane.
//
// Jev is NOT an LLM and NOT a chat model: you send an unstructured `state` plus a map of
// typed `questions` (Choice / Score / Noul) and get back typed probabilistic decisions —
// `{choice, probabilities, confidence}`, `{score, probabilities, confidence}`, `{noul}`.
// Wire contract (docs.typesafe.ai/api): POST https://api.typesafe.ai/v1/systemone,
//   Authorization: Bearer <API_KEY>, body { state, model:"jev-latest", questions:{id:Question} },
//   response { model, answers:{id:Answer}, usage }. 401/422/429/529 are the error statuses.
//
// HARD BOUNDARY — the reason this file is allowed to exist at all. Jev output is:
//   * NEVER a determinism input. It never enters the connectome, genome, manifestHash, or the
//     PoCA stateDigest. The fly brains decide from their own drives; Jev only READS the result.
//   * NEVER a money input. It never touches balances, caps, pendingNets, the settlement/estate/
//     refund paths, or any wallet. It is attached to a read-out and the paid signal bundle as an
//     extra facet a human/machine may look at — nothing more.
//   * FAIL-OPEN by construction. `evaluate()` returns `null` on disabled, timeout, any thrown
//     error, a non-2xx status, or a malformed body. A null means "no Jev this tick", and every
//     consumer must then ship NO jev key — so an unarmed/off build is byte-for-byte today's.
//   * OPTIONAL & DARK. Disabled unless JEV_ENABLED="true" AND a JEV_API_KEY is present. With no
//     credentials the client is inert and never issues a request (see `active`).
// ============================================================================

/** A JSON value we can hand to Jev for `state` / `instructions` / option descriptions. */
export type JevJsonValue = string | number | boolean | null | JevJsonValue[] | { [k: string]: JevJsonValue };

// --- Request question types (the three primitives; one `type` discriminates) --------------

/** A yes/no question. Returns the probability the answer is yes. */
export interface JevNoulQuestion {
  type: "noul";
  instructions: JevJsonValue;
  criteria?: { true?: JevJsonValue; false?: JevJsonValue };
}

/** Pick one option from a set (max 255 options). Returns the choice + full distribution + confidence. */
export interface JevChoiceQuestion {
  type: "choice";
  instructions: JevJsonValue;
  /** option key → a rubric description, or null when the option needs no extra detail. */
  criteria: Record<string, JevJsonValue | null>;
}

/** Rate the state against an ordered rubric (2..10 levels). Returns a weighted score + confidence. */
export interface JevScoreQuestion {
  type: "score";
  instructions: JevJsonValue;
  /** ordered level descriptions, lowest → highest. */
  criteria: JevJsonValue[];
}

export type JevQuestion = JevNoulQuestion | JevChoiceQuestion | JevScoreQuestion;

/** The full request body. `questions` is keyed by ids WE choose; answers come back under the same ids. */
export interface JevRequest {
  state: JevJsonValue;
  model: string;
  questions: Record<string, JevQuestion>;
}

// --- Response answer types ----------------------------------------------------------------

export interface JevNoulAnswer {
  type: "noul";
  noul: number; // 0 (no) .. 1 (yes)
}

export interface JevChoiceAnswer {
  type: "choice";
  choice: string;
  probabilities: Record<string, number>; // sums to 1
  confidence: number; // 0..1, derived from the distribution
}

export interface JevScoreAnswer {
  type: "score";
  score: number; // probability-weighted; can land between levels
  legend: Record<string, string>; // level index (string) → description
  probabilities: Record<string, number>;
  confidence: number;
}

export type JevAnswer = JevNoulAnswer | JevChoiceAnswer | JevScoreAnswer;

export interface JevResponse {
  model: string;
  answers: Record<string, JevAnswer>;
  usage?: { input_tokens?: number; output_tokens?: number };
}

// --- Client config + transport seam -------------------------------------------------------

/** Injectable fetch so the client is unit-testable with a mock and Worker-native in prod. */
export type JevFetch = (
  input: string,
  init: {
    method: string;
    headers: Record<string, string>;
    body: string;
    signal?: AbortSignal;
  },
) => Promise<{ ok: boolean; status: number; json: () => Promise<unknown> }>;

export interface JevClientConfig {
  /** master switch; false ⇒ inert, no request ever leaves the Worker. */
  enabled: boolean;
  /** the Bearer token; null/empty ⇒ inert even when `enabled` (a partial config can never fire). */
  apiKey: string | null;
  /** HTTP base, default https://api.typesafe.ai (the /v1/systemone path is appended by the client). */
  baseUrl: string;
  /** model id or alias, default "jev-latest". */
  model: string;
  /** hard wall-clock budget per call; on expiry we abort and return null (never hang the caller). */
  timeoutMs: number;
  /** transport override (tests inject a mock; prod uses the global fetch). */
  fetchImpl?: JevFetch;
}

/** true only when BOTH armed and a key is present — the single gate every caller must respect. */
export function jevIsLive(cfg: Pick<JevClientConfig, "enabled" | "apiKey">): boolean {
  return cfg.enabled === true && typeof cfg.apiKey === "string" && cfg.apiKey.trim().length > 0;
}

// ============================================================================
// The client. One public method, `evaluate`, which NEVER throws.
// ============================================================================
export class JevClient {
  private readonly cfg: JevClientConfig;
  private readonly transport: JevFetch;

  constructor(cfg: JevClientConfig) {
    this.cfg = cfg;
    this.transport = cfg.fetchImpl ?? ((globalThis as unknown as { fetch: JevFetch }).fetch);
  }

  /** whether this client will actually issue requests (see jevIsLive). */
  get live(): boolean {
    return jevIsLive(this.cfg);
  }

  /**
   * Ask Jev the typed `questions` about `state`. Returns a validated JevResponse, or `null` on
   * ANY of: not live, a thrown error, an abort/timeout, a non-2xx status, or a malformed body.
   * The caller MUST treat null as "no read-out this tick" and ship no jev key.
   */
  async evaluate(state: JevJsonValue, questions: Record<string, JevQuestion>): Promise<JevResponse | null> {
    if (!this.live) return null;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), Math.max(1, this.cfg.timeoutMs));
    try {
      const url = `${this.cfg.baseUrl.replace(/\/+$/, "")}/v1/systemone`;
      const body: JevRequest = { state, model: this.cfg.model, questions };
      const res = await this.transport(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${this.cfg.apiKey as string}`,
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      if (!res.ok) return null; // 401/422/429/529/… — degrade, never retry inline (the caller is on a soft cadence)
      const parsed = (await res.json()) as unknown;
      return normalizeResponse(parsed);
    } catch {
      return null; // abort / network / JSON parse — all fail-open
    } finally {
      clearTimeout(timer);
    }
  }
}

// --- Response validation ------------------------------------------------------------------

function isFiniteNumber(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v);
}

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

/**
 * Validate + sanitize an arbitrary parsed body into a JevResponse. Anything structurally wrong
 * returns null. Numbers are clamped (probabilities 0..1, noul 0..1) so a wild model value can
 * never propagate a nonsense magnitude into a read-out.
 */
export function normalizeResponse(raw: unknown): JevResponse | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  const answersRaw = o.answers;
  if (!answersRaw || typeof answersRaw !== "object") return null;
  const answers: Record<string, JevAnswer> = {};
  for (const [id, a] of Object.entries(answersRaw as Record<string, unknown>)) {
    const ans = normalizeAnswer(a);
    if (ans) answers[id] = ans;
  }
  if (Object.keys(answers).length === 0) return null; // nothing usable → treat as no read-out
  const usageRaw = o.usage;
  const usage =
    usageRaw && typeof usageRaw === "object"
      ? {
          input_tokens: isFiniteNumber((usageRaw as Record<string, unknown>).input_tokens)
            ? (usageRaw as Record<string, number>).input_tokens
            : undefined,
          output_tokens: isFiniteNumber((usageRaw as Record<string, unknown>).output_tokens)
            ? (usageRaw as Record<string, number>).output_tokens
            : undefined,
        }
      : undefined;
  return {
    model: typeof o.model === "string" ? o.model : "unknown",
    answers,
    ...(usage ? { usage } : null),
  };
}

function normalizeAnswer(a: unknown): JevAnswer | null {
  if (!a || typeof a !== "object") return null;
  const o = a as Record<string, unknown>;
  switch (o.type) {
    case "noul":
      return isFiniteNumber(o.noul) ? { type: "noul", noul: clamp01(o.noul) } : null;
    case "choice": {
      if (typeof o.choice !== "string") return null;
      return {
        type: "choice",
        choice: o.choice,
        probabilities: normalizeProbs(o.probabilities),
        confidence: isFiniteNumber(o.confidence) ? clamp01(o.confidence) : 0,
      };
    }
    case "score": {
      if (!isFiniteNumber(o.score)) return null;
      return {
        type: "score",
        score: o.score,
        legend: normalizeLegend(o.legend),
        probabilities: normalizeProbs(o.probabilities),
        confidence: isFiniteNumber(o.confidence) ? clamp01(o.confidence) : 0,
      };
    }
    default:
      return null;
  }
}

function normalizeProbs(v: unknown): Record<string, number> {
  const out: Record<string, number> = {};
  if (v && typeof v === "object") {
    for (const [k, p] of Object.entries(v as Record<string, unknown>)) {
      if (isFiniteNumber(p)) out[k] = clamp01(p);
    }
  }
  return out;
}

function normalizeLegend(v: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (v && typeof v === "object") {
    for (const [k, d] of Object.entries(v as Record<string, unknown>)) {
      if (typeof d === "string") out[k] = d;
    }
  }
  return out;
}

// ============================================================================
// murmur-specific questions + interpretation (the "two systems" read-out). PURE: it takes
// already-computed numbers/strings (a market temperature, a regime tag, a swarm summary, the
// latest chronicle headline) and returns a Jev request + a mapping of the answers. It reads the
// world; it never writes to it and never feeds anything back into the economy or the brains.
// ============================================================================

/** The compact live picture we hand Jev as `state` (all read-out side; no wallet, no brain internals). */
export interface JevStateSummary {
  temperature: number | null; // 0..1 whole-chain market temperature
  regime: string | null; // the deterministic regime tag (CALM/HOT/COLD)
  momentum: number | null; // signed temperature delta vs the previous tick
  turbulence: number | null; // 0..1
  swarmSize: number | null; // live flies
  topDrive: string | null; // the modal behavioural state right now
  chronicleHeadline: string | null; // the historian's most recent one-line record (kind + text)
}

/** Question ids we ask, in one batched call (Jev evaluates them in parallel; adding questions
 *  barely changes latency and batching is cheaper). */
export const JEV_QID = {
  posture: "posture", // Choice: how "hot/active" is the environment described
  mood: "mood", // Score: intensity of the swarm's collective arousal, on a rubric
  urgent: "urgent", // Noul: does the current state read as a stress/pressure moment
  consistent: "consistent", // Noul: does the latest chronicle line match the numeric state
} as const;

/** Drawer names the frontend already has, so `drawer` routes a visitor to an existing panel. */
export const JEV_DRAWERS = ["market", "wallets", "neural", "chronicle", "dynasty", "commons"] as const;

/** The read-out we publish (all optional; a null answer for a question ⇒ that field is dropped). */
export interface JevInsight {
  model: string;
  ts: number;
  posture: { choice: string; confidence: number } | null;
  mood: { score: number; confidence: number } | null;
  urgent: number | null;
  consistent: number | null;
  drawer: { choice: string; confidence: number } | null;
}

/** Build the batched request from a state summary. Deterministic given the summary — but the
 *  summary is a READ of the world, and the answer only ever decorates a read-out. */
export function buildJevRequest(s: JevStateSummary): JevRequest {
  const state: Record<string, JevJsonValue> = {
    temperature: s.temperature,
    regime: s.regime,
    momentum: s.momentum,
    turbulence: s.turbulence,
    swarm_size: s.swarmSize,
    top_drive: s.topDrive,
    latest_record: s.chronicleHeadline,
  };
  return {
    state,
    model: "jev-latest", // overwritten by the client cfg.model at send time
    questions: {
      [JEV_QID.posture]: {
        type: "choice",
        instructions: "Given this Arc-chain market temperature and swarm state, how active is the environment?",
        criteria: {
          dormant: "temperature low, chain quiet, little flow",
          steady: "temperature middling, ordinary activity",
          fevered: "temperature high, dense chain activity and fast trading",
        },
      },
      [JEV_QID.mood]: {
        type: "score",
        instructions: "How intense is the swarm's collective arousal right now?",
        criteria: ["at rest", "calm", "stirring", "restless", "frantic"],
      },
      [JEV_QID.urgent]: {
        type: "noul",
        instructions: "Does this state read as a stress or pressure moment for the swarm?",
        criteria: { true: "high turbulence or a fevered environment", false: "settled, ordinary conditions" },
      },
      [JEV_QID.consistent]: {
        type: "noul",
        instructions:
          "Does `latest_record` describe a market mood that is consistent with the numeric temperature/regime fields?",
        criteria: { true: "the record matches the numbers", false: "the record contradicts the numbers" },
      },
      drawer: {
        type: "choice",
        instructions: "Which panel on the dashboard should a returning visitor look at first to understand this moment?",
        criteria: Object.fromEntries(JEV_DRAWERS.map((d) => [d, null])),
      },
    },
  };
}

/** Map a validated JevResponse into the published JevInsight. Missing/odd answers are dropped to null. */
export function interpretJev(req: JevRequest, resp: JevResponse, now: number): JevInsight {
  const a = resp.answers;
  const posture = a[JEV_QID.posture];
  const mood = a[JEV_QID.mood];
  const urgent = a[JEV_QID.urgent];
  const consistent = a[JEV_QID.consistent];
  const drawer = a.drawer;
  return {
    model: resp.model,
    ts: now,
    posture:
      posture && posture.type === "choice"
        ? { choice: posture.choice, confidence: posture.confidence }
        : null,
    mood: mood && mood.type === "score" ? { score: mood.score, confidence: mood.confidence } : null,
    urgent: urgent && urgent.type === "noul" ? urgent.noul : null,
    consistent: consistent && consistent.type === "noul" ? consistent.noul : null,
    drawer:
      drawer && drawer.type === "choice" && (JEV_DRAWERS as readonly string[]).includes(drawer.choice)
        ? { choice: drawer.choice, confidence: drawer.confidence }
        : null,
  };
}
