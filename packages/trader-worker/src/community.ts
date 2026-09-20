// community.ts — the off-chain, TOKEN-GATED governance forum behind muros.live/community.
//
// WHAT THIS IS. A standalone community page where MURMUR holders discuss and run weighted, off-chain
// votes. Anyone may BROWSE (feed / proposals / tallies are free, keyless, CORS-open). To POST, PROPOSE or
// VOTE a caller must (1) sign an EIP-712 message with their wallet and (2) hold enough MURMUR — and the
// balance is checked SERVER-SIDE with a live balanceOf(author), never trusted from the client. The front-end
// gate is UX only.
//
// SAFETY POSTURE. This module is READ-ONLY on-chain (a single balanceOf per gated write) and writes ONLY to
// D1. It holds no key, signs no transfer and never touches the treasury or the settlement rails, so its risk
// surface is far below the economy layer. Everything is inert unless cfg.community.enabled.
//
// LAYOUT. Pure logic (EIP-712 shapes, signature recovery, timestamp freshness, gate, weighted tally) is
// exported and dependency-light so community.test.ts can exercise it with no real D1; the D1 I/O + HTTP
// routing sit at the bottom as thin wrappers.

import {
  erc20Abi,
  formatUnits,
  recoverTypedDataAddress,
  type Address,
  type Hex,
} from "viem";
import type { Env, RuntimeConfig } from "./config.js";
import { publicClient } from "./chain.js";

// ============================== constants ==============================

/** Hard content limits (anti-spam / anti-abuse; enforced server-side on every write). */
export const MAX_BODY_LEN = 4000;
export const MAX_TITLE_LEN = 200;
/** A signed action's `ts` (unix ms) must be within ±this many seconds of server time (anti-replay). */
export const TS_WINDOW_SEC = 300;
/** Max rows a single read endpoint returns. */
export const MAX_LIMIT = 100;
export const DEFAULT_LIMIT = 25;
/** Max vote events a single proposal timeline returns (bounds the graph payload). */
export const MAX_TIMELINE_EVENTS = 1000;

/** EIP-712 domain (chainId is added at runtime from cfg so mainnet/testnet both work). */
export const DOMAIN_NAME = "murmur community";
export const DOMAIN_VERSION = "1";

/** Vote choices (stored as INTEGER in community_votes). */
export const CHOICE = { against: 0, for: 1, abstain: 2 } as const;

// ============================== EIP-712 shapes ==============================

/**
 * The three signable actions. Every numeric field is uint256 so the worker (BigInt) and the browser
 * (number/string via eth_signTypedData_v4) encode identically by value — no representation drift.
 * A plaza post signs proposalId = 0; a reply signs the parent proposal's id.
 */
export const COMMUNITY_TYPES = {
  Post: [
    { name: "author", type: "address" },
    { name: "body", type: "string" },
    { name: "proposalId", type: "uint256" },
    { name: "ts", type: "uint256" },
  ],
  Propose: [
    { name: "author", type: "address" },
    { name: "title", type: "string" },
    { name: "body", type: "string" },
    { name: "ts", type: "uint256" },
  ],
  Vote: [
    { name: "author", type: "address" },
    { name: "proposalId", type: "uint256" },
    { name: "choice", type: "uint256" },
    { name: "ts", type: "uint256" },
  ],
} as const;

export type CommunityPrimaryType = keyof typeof COMMUNITY_TYPES;

/** The EIP-712 domain for a given chain (no verifyingContract — this signs against no specific contract). */
export function communityDomain(chainId: number) {
  return { name: DOMAIN_NAME, version: DOMAIN_VERSION, chainId };
}

// Message builders — the worker and the tests both use these so the recovered signer always matches the
// canonical encoding the browser signed. uint256 fields are passed as BigInt for value-exact encoding.
export function postMessage(author: string, body: string, proposalId: number, ts: number) {
  return { author: author as Address, body, proposalId: BigInt(proposalId), ts: BigInt(ts) };
}
export function proposeMessage(author: string, title: string, body: string, ts: number) {
  return { author: author as Address, title, body, ts: BigInt(ts) };
}
export function voteMessage(author: string, proposalId: number, choice: number, ts: number) {
  return { author: author as Address, proposalId: BigInt(proposalId), choice: BigInt(choice), ts: BigInt(ts) };
}

// ============================== pure logic (unit-tested) ==============================

/** Loose 0x-address shape check (checksum is NOT required; we lowercase before storing/comparing). */
export function isAddress(s: unknown): s is string {
  return typeof s === "string" && /^0x[0-9a-fA-F]{40}$/.test(s);
}

/** Anti-replay: `ts` (unix ms) must be within ±TS_WINDOW_SEC of `now` (unix ms). */
export function isTsFresh(ts: number, now: number, windowSec = TS_WINDOW_SEC): boolean {
  if (!Number.isFinite(ts)) return false;
  return Math.abs(now - ts) <= windowSec * 1000;
}

/** Coerce a vote choice to 0|1|2, or null when out of range. */
export function parseChoice(v: unknown): 0 | 1 | 2 | null {
  const n = typeof v === "number" ? v : Number(v);
  return n === 0 || n === 1 || n === 2 ? (n as 0 | 1 | 2) : null;
}

/** Token gate: does this raw balance clear the speak / propose thresholds? */
export function gateOf(balanceRaw: bigint, speakMinRaw: bigint, proposeMinRaw: bigint) {
  return { canSpeak: balanceRaw >= speakMinRaw, canPropose: balanceRaw >= proposeMinRaw };
}

export interface Tally {
  against: bigint;
  forVotes: bigint;
  abstain: bigint;
  total: bigint;
  voters: number;
}

/**
 * Weighted tally. D1 has no bigint SUM, so votes are read back as raw weight strings and accumulated here
 * with BigInt (proposal vote counts are small, so a full scan per proposal is fine). Unknown choices are
 * ignored; malformed weights count as 0 but never throw.
 */
export function tallyVotes(rows: Array<{ choice: number; weight: string }>): Tally {
  let against = 0n;
  let forVotes = 0n;
  let abstain = 0n;
  let voters = 0;
  for (const r of rows) {
    let w = 0n;
    try {
      w = BigInt(r.weight);
    } catch {
      w = 0n;
    }
    if (r.choice === CHOICE.against) against += w;
    else if (r.choice === CHOICE.for) forVotes += w;
    else if (r.choice === CHOICE.abstain) abstain += w;
    else continue; // unknown choice ⇒ not counted, not a voter
    voters++;
  }
  return { against, forVotes, abstain, total: against + forVotes + abstain, voters };
}

/** JSON-safe tally: raw decimal strings (bigint is not serialisable) + human-readable MURMUR amounts. */
export function tallyJson(t: Tally) {
  const human = (x: bigint) => formatUnits(x, 18);
  return {
    for: t.forVotes.toString(),
    against: t.against.toString(),
    abstain: t.abstain.toString(),
    total: t.total.toString(),
    voters: t.voters,
    forFmt: human(t.forVotes),
    againstFmt: human(t.against),
    abstainFmt: human(t.abstain),
    totalFmt: human(t.total),
  };
}

export interface TimelineEvent {
  voter: string;
  choice: 0 | 1 | 2;
  weight: string; // raw 18dp
  weightFmt: string;
  ts: number; // client-signed unix ms
  recordedAt: number; // server unix ms (stable ordering)
  isRevote: boolean; // this voter already had a live vote on the proposal
  isLeadChange: boolean; // the leading option changed at this point
}

export interface TimelinePoint {
  ts: number;
  recordedAt: number;
  for: string;
  against: string;
  abstain: string;
  total: string;
  forFmt: string;
  againstFmt: string;
  abstainFmt: string;
  voters: number;
  leader: "for" | "against" | "abstain" | "none";
  event: TimelineEvent;
}

/**
 * Rebuild the point-in-time weighted tally from the append-only vote-event log. Events are applied in
 * server-record order; a re-vote first REMOVES that voter's previous (choice, weight) before adding the new
 * one, so the cumulative curve stays correct across vote changes. Each returned point is the tally immediately
 * AFTER that event — this is what the per-proposal graph plots, and `isLeadChange` marks every flip of the
 * leading option, so a late, large swing (a whale landing in the final hour) is glaring rather than buried.
 */
export function buildTimeline(
  events: Array<{ voter: string; choice: number; weight: string; ts: number; recorded_at: number }>,
): TimelinePoint[] {
  const ordered = [...events].sort((a, b) => a.recorded_at - b.recorded_at || a.ts - b.ts);
  const current = new Map<string, { choice: number; weight: bigint }>();
  const toW = (s: string): bigint => {
    try {
      return BigInt(s);
    } catch {
      return 0n;
    }
  };
  let against = 0n;
  let forVotes = 0n;
  let abstain = 0n;
  const apply = (choice: number, weight: bigint, sign: 1n | -1n) => {
    const d = sign * weight;
    if (choice === CHOICE.against) against += d;
    else if (choice === CHOICE.for) forVotes += d;
    else if (choice === CHOICE.abstain) abstain += d;
  };
  const leaderOf = (): "for" | "against" | "abstain" | "none" => {
    let best: "for" | "against" | "abstain" | "none" = "none";
    let bv = 0n;
    if (forVotes > bv) { bv = forVotes; best = "for"; }
    if (against > bv) { bv = against; best = "against"; }
    if (abstain > bv) { bv = abstain; best = "abstain"; }
    return best;
  };
  let prevLeader = leaderOf();
  const out: TimelinePoint[] = [];
  for (const e of ordered) {
    const weight = toW(e.weight);
    const prev = current.get(e.voter);
    const isRevote = prev != null;
    if (prev) apply(prev.choice, prev.weight, -1n);
    apply(e.choice, weight, 1n);
    current.set(e.voter, { choice: e.choice, weight });
    const leader = leaderOf();
    const isLeadChange = leader !== prevLeader;
    prevLeader = leader;
    const choice = (e.choice === 1 || e.choice === 2 ? e.choice : 0) as 0 | 1 | 2;
    out.push({
      ts: e.ts,
      recordedAt: e.recorded_at,
      for: forVotes.toString(),
      against: against.toString(),
      abstain: abstain.toString(),
      total: (forVotes + against + abstain).toString(),
      forFmt: formatUnits(forVotes, 18),
      againstFmt: formatUnits(against, 18),
      abstainFmt: formatUnits(abstain, 18),
      voters: current.size,
      leader,
      event: {
        voter: e.voter,
        choice,
        weight: e.weight,
        weightFmt: safeFmt(e.weight),
        ts: e.ts,
        recordedAt: e.recorded_at,
        isRevote,
        isLeadChange,
      },
    });
  }
  return out;
}

export type VerifyOk = { ok: true; signer: Address };
export type VerifyErr = { ok: false; status: number; code: CommunityErrorCode; reason: string };

/**
 * Recover the EIP-712 signer and assert it equals the claimed author. This is the authentication core:
 * a bad signature, an unrecoverable payload, or a signer≠author mismatch is rejected here (the balance gate
 * is a SEPARATE, subsequent server-side check). Returns a ready-to-send error envelope on failure.
 */
export async function verifyCommunitySignature(params: {
  chainId: number;
  primaryType: CommunityPrimaryType;
  message: Record<string, unknown>;
  signature: string;
  claimedAuthor: string;
}): Promise<VerifyOk | VerifyErr> {
  const { chainId, primaryType, message, signature, claimedAuthor } = params;
  if (typeof signature !== "string" || !/^0x[0-9a-fA-F]+$/.test(signature)) {
    return { ok: false, status: 400, code: "bad_request", reason: "missing or malformed signature" };
  }
  let signer: Address;
  try {
    signer = (await recoverTypedDataAddress({
      domain: communityDomain(chainId),
      // Pass the WHOLE types object (viem selects `primaryType` from it); the EIP-712 digest depends only on
      // the primaryType's own definition + the domain, so the unused sibling types are harmless. This mirrors
      // the browser, which signs with { EIP712Domain, <primaryType> }.
      types: COMMUNITY_TYPES,
      primaryType,
      message,
      signature: signature as Hex,
      // viem's recoverTypedDataAddress is deeply generic over the typed-data shape; because we pick the
      // primaryType (and thus the message type) dynamically per action, per-field inference collapses to
      // `never`. Assert the argument once — the shapes above are exactly the COMMUNITY_TYPES we sign against.
    } as never)) as Address;
  } catch {
    return { ok: false, status: 401, code: "forbidden", reason: "signature could not be recovered" };
  }
  if (signer.toLowerCase() !== claimedAuthor.toLowerCase()) {
    return { ok: false, status: 401, code: "forbidden", reason: "signature does not match the claimed author" };
  }
  return { ok: true, signer };
}

// ============================== D1 schema + I/O ==============================

/** Per-isolate guard so CREATE TABLE IF NOT EXISTS runs at most once per Worker isolate lifetime. */
let schemaReady = false;

/** Lazily create the community tables + indexes (idempotent; mirrored in packages/trader-worker/schema.sql). */
export async function ensureCommunitySchema(db: D1Database): Promise<void> {
  if (schemaReady) return;
  await db.batch([
    db.prepare(
      `CREATE TABLE IF NOT EXISTS community_posts (
         id INTEGER PRIMARY KEY AUTOINCREMENT,
         author TEXT NOT NULL,
         body TEXT NOT NULL,
         proposal_id INTEGER,
         author_bal TEXT NOT NULL,
         ts INTEGER NOT NULL,
         sig TEXT NOT NULL UNIQUE
       )`,
    ),
    db.prepare(`CREATE INDEX IF NOT EXISTS idx_community_posts_ts ON community_posts (ts)`),
    db.prepare(`CREATE INDEX IF NOT EXISTS idx_community_posts_proposal ON community_posts (proposal_id)`),
    db.prepare(
      `CREATE TABLE IF NOT EXISTS community_proposals (
         id INTEGER PRIMARY KEY AUTOINCREMENT,
         author TEXT NOT NULL,
         title TEXT NOT NULL,
         body TEXT NOT NULL,
         author_bal TEXT NOT NULL,
         deadline INTEGER NOT NULL,
         ts INTEGER NOT NULL,
         sig TEXT NOT NULL UNIQUE
       )`,
    ),
    db.prepare(`CREATE INDEX IF NOT EXISTS idx_community_proposals_ts ON community_proposals (ts)`),
    db.prepare(
      `CREATE TABLE IF NOT EXISTS community_votes (
         proposal_id INTEGER NOT NULL,
         voter TEXT NOT NULL,
         choice INTEGER NOT NULL,
         weight TEXT NOT NULL,
         ts INTEGER NOT NULL,
         sig TEXT NOT NULL,
         PRIMARY KEY (proposal_id, voter)
       )`,
    ),
    db.prepare(
      `CREATE TABLE IF NOT EXISTS community_vote_events (
         id INTEGER PRIMARY KEY AUTOINCREMENT,
         proposal_id INTEGER NOT NULL,
         voter TEXT NOT NULL,
         choice INTEGER NOT NULL,
         weight TEXT NOT NULL,
         ts INTEGER NOT NULL,
         recorded_at INTEGER NOT NULL,
         sig TEXT NOT NULL UNIQUE
       )`,
    ),
    db.prepare(
      `CREATE INDEX IF NOT EXISTS idx_community_vote_events_proposal ON community_vote_events (proposal_id, recorded_at)`,
    ),
  ]);
  schemaReady = true;
}

/** Reset the schema guard (tests only — lets a fresh in-memory D1 be re-initialised between cases). */
export function _resetSchemaGuard(): void {
  schemaReady = false;
}

interface PostRow {
  id: number;
  author: string;
  body: string;
  proposal_id: number | null;
  author_bal: string;
  ts: number;
  sig: string;
}
interface ProposalRow {
  id: number;
  author: string;
  title: string;
  body: string;
  author_bal: string;
  deadline: number;
  ts: number;
  sig: string;
}
interface VoteRow {
  proposal_id: number;
  choice: number;
  weight: string;
}
interface VoteEventRow {
  voter: string;
  choice: number;
  weight: string;
  ts: number;
  recorded_at: number;
}

/** Serialise a post row for the API (raw + human balance). */
function postJson(r: PostRow) {
  return {
    id: r.id,
    author: r.author,
    body: r.body,
    proposalId: r.proposal_id,
    authorBal: r.author_bal,
    authorBalFmt: safeFmt(r.author_bal),
    ts: r.ts,
    sig: r.sig,
  };
}

function safeFmt(raw: string): string {
  try {
    return formatUnits(BigInt(raw), 18);
  } catch {
    return "0";
  }
}

function clampLimit(raw: string | null): number {
  const n = Number(raw ?? "");
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_LIMIT;
  return Math.min(MAX_LIMIT, Math.floor(n));
}

/** Read a proposal's tally by scanning its votes (small per-proposal cardinality ⇒ fine). */
async function tallyForProposal(db: D1Database, id: number): Promise<Tally> {
  const { results } = await db
    .prepare(`SELECT choice, weight FROM community_votes WHERE proposal_id = ?`)
    .bind(id)
    .all<VoteRow>();
  return tallyVotes((results ?? []) as Array<{ choice: number; weight: string }>);
}

/** Batch tallies for many proposals in ONE query (avoids N+1 on the list endpoint). */
async function tallyForProposals(db: D1Database, ids: number[]): Promise<Map<number, Tally>> {
  const out = new Map<number, Tally>();
  if (ids.length === 0) return out;
  const placeholders = ids.map(() => "?").join(",");
  const { results } = await db
    .prepare(`SELECT proposal_id, choice, weight FROM community_votes WHERE proposal_id IN (${placeholders})`)
    .bind(...ids)
    .all<VoteRow>();
  const grouped = new Map<number, Array<{ choice: number; weight: string }>>();
  for (const r of (results ?? []) as VoteRow[]) {
    const arr = grouped.get(r.proposal_id) ?? [];
    arr.push({ choice: r.choice, weight: r.weight });
    grouped.set(r.proposal_id, arr);
  }
  for (const id of ids) out.set(id, tallyVotes(grouped.get(id) ?? []));
  return out;
}

/** Authoritative on-chain MURMUR balance read (raw). Never trusts a client-supplied balance. */
async function readBalanceRaw(cfg: RuntimeConfig, token: string, addr: string): Promise<bigint> {
  const client = publicClient(cfg);
  const bal = await client.readContract({
    address: token as Address,
    abi: erc20Abi,
    functionName: "balanceOf",
    args: [addr as Address],
  });
  return BigInt(bal as bigint);
}

// ============================== HTTP surface ==============================

type CommunityErrorCode =
  | "not_found"
  | "bad_request"
  | "internal_error"
  | "forbidden"
  | "service_unavailable";

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" },
  });
}

/** The unified public-API error envelope {error, code, status} (mirrors state.ts). */
function jsonError(code: CommunityErrorCode, message: string, status: number): Response {
  return json({ error: message, code, status }, status);
}

export interface CommunityHandlerContext {
  path: string; // /v1 already stripped, e.g. "/community/feed"
  url: URL;
  request: Request;
  env: Env;
  cfg: RuntimeConfig;
}

/**
 * Route a /community* request. Returns 501 when the feature is disabled and 503 when D1 is unbound, so the
 * whole surface is inert (never half-live) unless it is fully configured. CORS is applied by the caller.
 */
export async function handleCommunity(ctx: CommunityHandlerContext): Promise<Response> {
  const { path, url, request, env, cfg } = ctx;
  const c = cfg.community;

  if (!c.enabled) return jsonError("service_unavailable", "community feature is disabled", 501);
  const db = env.DB;
  if (!db) return jsonError("service_unavailable", "community storage is not bound", 503);

  const method = request.method.toUpperCase();
  const seg = path.replace(/^\/community\/?/, "").replace(/\/+$/, "");

  try {
    await ensureCommunitySchema(db);

    // ---- READ endpoints (free, keyless) ----
    if (method === "GET") {
      if (seg === "" ) return json(communityIndex(c));
      if (seg === "feed") return await getFeed(db, url);
      if (seg === "proposals") return await getProposals(db, url);
      if (seg === "proposal") return await getProposal(db, url);
      if (seg === "gate") return await getGate(db, cfg, url);
      if (seg === "timeline") return await getTimeline(db, url);
      return jsonError("not_found", `no such community endpoint: GET /community/${seg}`, 404);
    }

    // ---- WRITE endpoints (wallet signature + server-side balance gate) ----
    if (method === "POST") {
      if (!c.token) return jsonError("service_unavailable", "community token is not configured", 503);
      if (seg === "post") return await postPost(db, cfg, request);
      if (seg === "proposal") return await postProposal(db, cfg, request);
      if (seg === "vote") return await postVote(db, cfg, request);
      return jsonError("not_found", `no such community endpoint: POST /community/${seg}`, 404);
    }

    return jsonError("bad_request", "method not allowed", 405);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    // A D1 UNIQUE(sig) violation is an exact replay of an already-recorded action ⇒ idempotent reject.
    if (/unique|UNIQUE|constraint/i.test(msg)) {
      return jsonError("bad_request", "duplicate signature: this exact action was already recorded", 409);
    }
    console.error("[community] handler error", msg);
    return jsonError("internal_error", "internal community error", 500);
  }
}

function communityIndex(c: RuntimeConfig["community"]) {
  return {
    ok: true,
    feature: "community",
    enabled: c.enabled,
    token: c.token,
    chainId: c.chainId,
    speakMin: c.speakMinRaw.toString(),
    proposeMin: c.proposeMinRaw.toString(),
    speakMinFmt: formatUnits(c.speakMinRaw, 18),
    proposeMinFmt: formatUnits(c.proposeMinRaw, 18),
    proposalWindowMs: c.windowMs,
    postCooldownSec: c.cooldownSec,
    endpoints: [
      "GET  /community/feed?limit=&before=      plaza posts (newest first)",
      "GET  /community/proposals?limit=&status= proposals + weighted tallies (status=open|closed)",
      "GET  /community/proposal?id=               one proposal + tally + its replies",
      "GET  /community/gate?address=              live MURMUR balance + canSpeak/canPropose",
      "GET  /community/timeline?id=               per-proposal vote timeline + cumulative tally graph",
      "POST /community/post                       {author, body, proposalId?, ts, sig}",
      "POST /community/proposal                   {author, title, body, ts, sig}",
      "POST /community/vote                       {author, proposalId, choice, ts, sig}",
    ],
  };
}

// ---- GET /community/feed ----
async function getFeed(db: D1Database, url: URL): Promise<Response> {
  const limit = clampLimit(url.searchParams.get("limit"));
  const before = url.searchParams.get("before");
  const hasBefore = before != null && Number.isFinite(Number(before));
  const { results } = hasBefore
    ? await db
        .prepare(
          `SELECT id, author, body, proposal_id, author_bal, ts, sig FROM community_posts
           WHERE proposal_id IS NULL AND id < ? ORDER BY id DESC LIMIT ?`,
        )
        .bind(Number(before), limit)
        .all<PostRow>()
    : await db
        .prepare(
          `SELECT id, author, body, proposal_id, author_bal, ts, sig FROM community_posts
           WHERE proposal_id IS NULL ORDER BY id DESC LIMIT ?`,
        )
        .bind(limit)
        .all<PostRow>();
  const posts = (results ?? []).map(postJson);
  return json({ posts, nextBefore: posts.length ? posts[posts.length - 1].id : null, limit });
}

// ---- GET /community/proposals ----
async function getProposals(db: D1Database, url: URL): Promise<Response> {
  const limit = clampLimit(url.searchParams.get("limit"));
  const status = (url.searchParams.get("status") ?? "").toLowerCase();
  const now = Date.now();
  let sql = `SELECT id, author, title, body, author_bal, deadline, ts, sig FROM community_proposals`;
  const args: Array<number | string> = [];
  if (status === "open") {
    sql += ` WHERE deadline > ?`;
    args.push(now);
  } else if (status === "closed") {
    sql += ` WHERE deadline <= ?`;
    args.push(now);
  }
  sql += ` ORDER BY id DESC LIMIT ?`;
  args.push(limit);
  const { results } = await db.prepare(sql).bind(...args).all<ProposalRow>();
  const rows = results ?? [];
  const tallies = await tallyForProposals(db, rows.map((r) => r.id));
  const proposals = rows.map((r) => {
    const t = tallies.get(r.id) ?? tallyVotes([]);
    return {
      id: r.id,
      author: r.author,
      title: r.title,
      body: r.body,
      authorBal: r.author_bal,
      authorBalFmt: safeFmt(r.author_bal),
      deadline: r.deadline,
      ts: r.ts,
      open: now < r.deadline,
      tally: tallyJson(t),
    };
  });
  return json({ proposals, now, limit });
}

// ---- GET /community/proposal?id= ----
async function getProposal(db: D1Database, url: URL): Promise<Response> {
  const id = Number(url.searchParams.get("id"));
  if (!Number.isFinite(id) || id <= 0) return jsonError("bad_request", "id must be a positive integer", 400);
  const row = await db
    .prepare(`SELECT id, author, title, body, author_bal, deadline, ts, sig FROM community_proposals WHERE id = ?`)
    .bind(id)
    .first<ProposalRow>();
  if (!row) return jsonError("not_found", `proposal ${id} not found`, 404);
  const now = Date.now();
  const tally = tallyJson(await tallyForProposal(db, id));
  const { results } = await db
    .prepare(
      `SELECT id, author, body, proposal_id, author_bal, ts, sig FROM community_posts
       WHERE proposal_id = ? ORDER BY id ASC LIMIT ?`,
    )
    .bind(id, MAX_LIMIT)
    .all<PostRow>();
  return json({
    proposal: {
      id: row.id,
      author: row.author,
      title: row.title,
      body: row.body,
      authorBal: row.author_bal,
      authorBalFmt: safeFmt(row.author_bal),
      deadline: row.deadline,
      ts: row.ts,
      open: now < row.deadline,
      tally,
    },
    replies: (results ?? []).map(postJson),
    now,
  });
}

// ---- GET /community/gate?address= ----
async function getGate(_db: D1Database, cfg: RuntimeConfig, url: URL): Promise<Response> {
  const c = cfg.community;
  const address = url.searchParams.get("address") ?? "";
  if (!isAddress(address)) return jsonError("bad_request", "address must be a 0x…40 hex address", 400);
  if (!c.token) {
    return json({
      address: address.toLowerCase(),
      balance: "0",
      balanceFmt: "0",
      canSpeak: false,
      canPropose: false,
      speakMin: c.speakMinRaw.toString(),
      proposeMin: c.proposeMinRaw.toString(),
      speakMinFmt: formatUnits(c.speakMinRaw, 18),
      proposeMinFmt: formatUnits(c.proposeMinRaw, 18),
      token: null,
    });
  }
  const bal = await readBalanceRaw(cfg, c.token, address);
  const g = gateOf(bal, c.speakMinRaw, c.proposeMinRaw);
  return json({
    address: address.toLowerCase(),
    balance: bal.toString(),
    balanceFmt: formatUnits(bal, 18),
    canSpeak: g.canSpeak,
    canPropose: g.canPropose,
    speakMin: c.speakMinRaw.toString(),
    proposeMin: c.proposeMinRaw.toString(),
    speakMinFmt: formatUnits(c.speakMinRaw, 18),
    proposeMinFmt: formatUnits(c.proposeMinRaw, 18),
    token: c.token,
  });
}

// ---- GET /community/timeline?id= ----
async function getTimeline(db: D1Database, url: URL): Promise<Response> {
  const id = Number(url.searchParams.get("id"));
  if (!Number.isFinite(id) || id <= 0) return jsonError("bad_request", "id must be a positive integer", 400);
  const prop = await db
    .prepare(`SELECT id, ts, deadline FROM community_proposals WHERE id = ?`)
    .bind(id)
    .first<{ id: number; ts: number; deadline: number }>();
  if (!prop) return jsonError("not_found", `proposal ${id} not found`, 404);
  const { results } = await db
    .prepare(
      `SELECT voter, choice, weight, ts, recorded_at FROM community_vote_events
       WHERE proposal_id = ? ORDER BY recorded_at ASC, ts ASC LIMIT ?`,
    )
    .bind(id, MAX_TIMELINE_EVENTS)
    .all<VoteEventRow>();
  const series = buildTimeline((results ?? []) as VoteEventRow[]);
  return json({
    proposalId: id,
    start: prop.ts,
    deadline: prop.deadline,
    now: Date.now(),
    open: Date.now() < prop.deadline,
    // `tally` is the authoritative current tally (from community_votes, one row per voter);
    // `series` is the point-in-time curve rebuilt from the append-only event log (they agree at the tail).
    tally: tallyJson(await tallyForProposal(db, id)),
    series,
    eventCount: series.length,
  });
}

// ---- shared write-path helpers ----

async function readBody(request: Request): Promise<Record<string, unknown> | null> {
  try {
    const v = await request.json();
    return v && typeof v === "object" ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function str(v: unknown): string {
  return typeof v === "string" ? v : "";
}

/** Validate the common {author, ts, sig} preamble. Returns an error Response or null when OK. */
function validatePreamble(b: Record<string, unknown>): Response | null {
  if (!isAddress(b.author)) return jsonError("bad_request", "author must be a 0x…40 hex address", 400);
  const ts = Number(b.ts);
  if (!isTsFresh(ts, Date.now())) {
    return jsonError("bad_request", `ts must be within ±${TS_WINDOW_SEC}s of server time (anti-replay)`, 400);
  }
  if (typeof b.sig !== "string" || b.sig.length < 8) return jsonError("bad_request", "missing signature", 400);
  return null;
}

/** Enforce the per-address posting cooldown. Returns an error Response or null when OK. */
async function checkCooldown(db: D1Database, author: string, cooldownSec: number): Promise<Response | null> {
  if (cooldownSec <= 0) return null;
  const last = await db
    .prepare(`SELECT ts FROM community_posts WHERE author = ? ORDER BY ts DESC LIMIT 1`)
    .bind(author)
    .first<{ ts: number }>();
  if (last && typeof last.ts === "number") {
    const waitMs = cooldownSec * 1000 - (Date.now() - last.ts);
    if (waitMs > 0) {
      return jsonError(
        "forbidden",
        `posting too fast: wait ${Math.ceil(waitMs / 1000)}s (cooldown ${cooldownSec}s)`,
        429,
      );
    }
  }
  return null;
}

// ---- POST /community/post ----
async function postPost(db: D1Database, cfg: RuntimeConfig, request: Request): Promise<Response> {
  const c = cfg.community;
  const b = await readBody(request);
  if (!b) return jsonError("bad_request", "request body must be JSON", 400);
  const pre = validatePreamble(b);
  if (pre) return pre;

  const author = str(b.author).toLowerCase();
  const body = str(b.body).trim();
  if (!body) return jsonError("bad_request", "body must not be empty", 400);
  if (body.length > MAX_BODY_LEN) return jsonError("bad_request", `body exceeds ${MAX_BODY_LEN} chars`, 400);

  // proposalId: absent/0 ⇒ plaza post (NULL); >0 ⇒ must reference an existing proposal (a reply).
  const rawPid = b.proposalId == null ? 0 : Number(b.proposalId);
  const proposalId = Number.isFinite(rawPid) && rawPid > 0 ? Math.floor(rawPid) : 0;
  if (proposalId > 0) {
    const exists = await db.prepare(`SELECT id FROM community_proposals WHERE id = ?`).bind(proposalId).first();
    if (!exists) return jsonError("not_found", `proposal ${proposalId} not found`, 404);
  }

  const ts = Number(b.ts);
  const v = await verifyCommunitySignature({
    chainId: c.chainId,
    primaryType: "Post",
    message: postMessage(author, body, proposalId, ts) as unknown as Record<string, unknown>,
    signature: str(b.sig),
    claimedAuthor: author,
  });
  if (!v.ok) return jsonError(v.code, v.reason, v.status);

  const cool = await checkCooldown(db, author, c.cooldownSec);
  if (cool) return cool;

  const bal = await readBalanceRaw(cfg, c.token as string, author);
  if (!gateOf(bal, c.speakMinRaw, c.proposeMinRaw).canSpeak) {
    return jsonError(
      "forbidden",
      `insufficient MURMUR to post: have ${formatUnits(bal, 18)}, need ${formatUnits(c.speakMinRaw, 18)}`,
      403,
    );
  }

  const { meta } = await db
    .prepare(
      `INSERT INTO community_posts (author, body, proposal_id, author_bal, ts, sig) VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .bind(author, body, proposalId > 0 ? proposalId : null, bal.toString(), ts, str(b.sig))
    .run();
  return json({ ok: true, id: Number(meta.last_row_id), authorBal: bal.toString(), authorBalFmt: formatUnits(bal, 18) });
}

// ---- POST /community/proposal ----
async function postProposal(db: D1Database, cfg: RuntimeConfig, request: Request): Promise<Response> {
  const c = cfg.community;
  const b = await readBody(request);
  if (!b) return jsonError("bad_request", "request body must be JSON", 400);
  const pre = validatePreamble(b);
  if (pre) return pre;

  const author = str(b.author).toLowerCase();
  const title = str(b.title).trim();
  const body = str(b.body).trim();
  if (!title) return jsonError("bad_request", "title must not be empty", 400);
  if (title.length > MAX_TITLE_LEN) return jsonError("bad_request", `title exceeds ${MAX_TITLE_LEN} chars`, 400);
  if (body.length > MAX_BODY_LEN) return jsonError("bad_request", `body exceeds ${MAX_BODY_LEN} chars`, 400);

  const ts = Number(b.ts);
  const v = await verifyCommunitySignature({
    chainId: c.chainId,
    primaryType: "Propose",
    message: proposeMessage(author, title, body, ts) as unknown as Record<string, unknown>,
    signature: str(b.sig),
    claimedAuthor: author,
  });
  if (!v.ok) return jsonError(v.code, v.reason, v.status);

  const bal = await readBalanceRaw(cfg, c.token as string, author);
  if (!gateOf(bal, c.speakMinRaw, c.proposeMinRaw).canPropose) {
    return jsonError(
      "forbidden",
      `insufficient MURMUR to propose: have ${formatUnits(bal, 18)}, need ${formatUnits(c.proposeMinRaw, 18)}`,
      403,
    );
  }

  const deadline = Date.now() + c.windowMs;
  const { meta } = await db
    .prepare(
      `INSERT INTO community_proposals (author, title, body, author_bal, deadline, ts, sig) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(author, title, body, bal.toString(), deadline, ts, str(b.sig))
    .run();
  return json({
    ok: true,
    id: Number(meta.last_row_id),
    deadline,
    authorBal: bal.toString(),
    authorBalFmt: formatUnits(bal, 18),
  });
}

// ---- POST /community/vote ----
async function postVote(db: D1Database, cfg: RuntimeConfig, request: Request): Promise<Response> {
  const c = cfg.community;
  const b = await readBody(request);
  if (!b) return jsonError("bad_request", "request body must be JSON", 400);
  const pre = validatePreamble(b);
  if (pre) return pre;

  const author = str(b.author).toLowerCase();
  const proposalId = Number(b.proposalId);
  if (!Number.isFinite(proposalId) || proposalId <= 0) {
    return jsonError("bad_request", "proposalId must be a positive integer", 400);
  }
  const choice = parseChoice(b.choice);
  if (choice == null) return jsonError("bad_request", "choice must be 0 (against), 1 (for) or 2 (abstain)", 400);

  const prop = await db
    .prepare(`SELECT id, deadline FROM community_proposals WHERE id = ?`)
    .bind(proposalId)
    .first<{ id: number; deadline: number }>();
  if (!prop) return jsonError("not_found", `proposal ${proposalId} not found`, 404);
  if (Date.now() > prop.deadline) return jsonError("forbidden", "proposal voting has closed", 403);

  const ts = Number(b.ts);
  const v = await verifyCommunitySignature({
    chainId: c.chainId,
    primaryType: "Vote",
    message: voteMessage(author, proposalId, choice, ts) as unknown as Record<string, unknown>,
    signature: str(b.sig),
    claimedAuthor: author,
  });
  if (!v.ok) return jsonError(v.code, v.reason, v.status);

  const bal = await readBalanceRaw(cfg, c.token as string, author);
  if (!gateOf(bal, c.speakMinRaw, c.proposeMinRaw).canSpeak) {
    return jsonError(
      "forbidden",
      `insufficient MURMUR to vote: have ${formatUnits(bal, 18)}, need ${formatUnits(c.speakMinRaw, 18)}`,
      403,
    );
  }

  // One voter per proposal (PK), latest wins ⇒ INSERT OR REPLACE lets a holder change their vote.
  await db
    .prepare(
      `INSERT OR REPLACE INTO community_votes (proposal_id, voter, choice, weight, ts, sig) VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .bind(proposalId, author, choice, bal.toString(), ts, str(b.sig))
    .run();
  // Append-only event log ⇒ the per-proposal tally graph can show the FULL history (including re-votes), so a
  // late, large swing is visible rather than silent. UNIQUE(sig) keeps this replay-safe (a re-vote re-signs with
  // a fresh ts, so it is a distinct event, never a duplicate of the original).
  await db
    .prepare(
      `INSERT INTO community_vote_events (proposal_id, voter, choice, weight, ts, recorded_at, sig) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(proposalId, author, choice, bal.toString(), ts, Date.now(), str(b.sig))
    .run();
  const tally = tallyJson(await tallyForProposal(db, proposalId));
  return json({ ok: true, proposalId, choice, weight: bal.toString(), weightFmt: formatUnits(bal, 18), tally });
}
