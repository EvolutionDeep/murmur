// community.test.ts — pure-logic unit tests for the token-gated governance module (src/community.ts).
//
// These exercise everything that is a SECURITY BOUNDARY without touching a real D1 or chain:
//   · config parsing of the MURMUR thresholds (parseUnits → raw bigint) + safe fallbacks,
//   · the EIP-712 sign→recover roundtrip for all three actions (with a local viem account),
//   · the browser(String)↔worker(BigInt) uint256 encoding equivalence the whole scheme rests on,
//   · signer≠author rejection, malformed/unrecoverable signature rejection,
//   · timestamp freshness (anti-replay), vote-choice range, the token gate, and BigInt weighted tallying.
// The D1 CRUD + HTTP routing stay thin wrappers over these primitives (verified live in the deploy step).

import test from "node:test";
import assert from "node:assert/strict";
import { privateKeyToAccount } from "viem/accounts";

import { loadConfig, type Env } from "./config.js";
import {
  COMMUNITY_TYPES,
  communityDomain,
  postMessage,
  proposeMessage,
  voteMessage,
  isAddress,
  isTsFresh,
  parseChoice,
  gateOf,
  tallyVotes,
  tallyJson,
  verifyCommunitySignature,
  buildTimeline,
  TS_WINDOW_SEC,
} from "./community.js";

// The well-known Hardhat/Anvil test key #0 — public, controls no real funds on any chain. Used ONLY to
// produce a real EIP-712 signature so we can assert recoverTypedDataAddress round-trips our exact shapes.
const PK = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
const acct = privateKeyToAccount(PK);
const CHAIN = 5042;

function envWith(over: Partial<Env> = {}): Env {
  return { CHAIN_ID: "5042", RPC_URL: "https://rpc.mainnet.arc.io", ...over } as unknown as Env;
}

// ============================== config parsing ==============================

test("community config: safe defaults when env is unset (disabled, 50K/1M, 72h, 60s)", () => {
  const c = loadConfig(envWith()).community;
  assert.equal(c.enabled, false);
  assert.equal(c.speakMinRaw, 50_000n * 10n ** 18n);   // 5e22
  assert.equal(c.proposeMinRaw, 1_000_000n * 10n ** 18n); // 1e24
  assert.equal(c.windowMs, 72 * 3_600_000);
  assert.equal(c.cooldownSec, 60);
  assert.equal(c.chainId, 5042);
  assert.equal(c.token, null);
});

test("community config: parses thresholds to raw bigint + token falls back to ARENA_TOKEN", () => {
  const c = loadConfig(
    envWith({
      COMMUNITY_ENABLED: "true",
      COMMUNITY_SPEAK_MIN: "50000",
      COMMUNITY_PROPOSE_MIN: "1000000",
      COMMUNITY_PROPOSAL_WINDOW_HOURS: "48",
      ARENA_TOKEN: "0x8faae5592b9acc27a79fca745c6b872adf514a5d",
    }),
  ).community;
  assert.equal(c.enabled, true);
  assert.equal(c.speakMinRaw, 5n * 10n ** 22n);
  assert.equal(c.proposeMinRaw, 10n ** 24n);
  assert.equal(c.windowMs, 48 * 3_600_000);
  assert.equal(c.token, "0x8faae5592b9acc27a79fca745c6b872adf514a5d");
});

test("community config: an explicit COMMUNITY_TOKEN wins over ARENA_TOKEN", () => {
  const c = loadConfig(
    envWith({ COMMUNITY_TOKEN: "0x1111111111111111111111111111111111111111", ARENA_TOKEN: "0x2222222222222222222222222222222222222222" }),
  ).community;
  assert.equal(c.token, "0x1111111111111111111111111111111111111111");
});

test("community config: a malformed threshold falls back to the safe default (never zeroes the gate)", () => {
  const c = loadConfig(envWith({ COMMUNITY_SPEAK_MIN: "not-a-number" })).community;
  assert.equal(c.speakMinRaw, 50_000n * 10n ** 18n);
});

// ============================== pure validators ==============================

test("isAddress accepts 0x…40 hex and rejects everything else", () => {
  assert.equal(isAddress("0x8faae5592b9acc27a79fca745c6b872adf514a5d"), true);
  assert.equal(isAddress("0x8FAAE5592B9ACC27A79FCA745C6B872ADF514A5D"), true);
  assert.equal(isAddress("0x123"), false);
  assert.equal(isAddress("nope"), false);
  assert.equal(isAddress(null), false);
  assert.equal(isAddress(42), false);
});

test("isTsFresh enforces the ±300s anti-replay window (past, future, NaN all rejected)", () => {
  const now = Date.now();
  assert.equal(isTsFresh(now, now), true);
  assert.equal(isTsFresh(now - 10_000, now), true);
  assert.equal(isTsFresh(now + 10_000, now), true);
  assert.equal(isTsFresh(now - (TS_WINDOW_SEC + 5) * 1000, now), false);
  assert.equal(isTsFresh(now + (TS_WINDOW_SEC + 5) * 1000, now), false);
  assert.equal(isTsFresh(NaN, now), false);
});

test("parseChoice allows only 0/1/2 (coercing numeric strings) and rejects the rest", () => {
  assert.equal(parseChoice(0), 0);
  assert.equal(parseChoice("1"), 1);
  assert.equal(parseChoice(2), 2);
  assert.equal(parseChoice(3), null);
  assert.equal(parseChoice(-1), null);
  assert.equal(parseChoice("x"), null);
  assert.equal(parseChoice(undefined), null);
});

test("gateOf is inclusive at the threshold and independent per action", () => {
  const speak = 5n * 10n ** 22n;
  const propose = 10n ** 24n;
  assert.deepEqual(gateOf(speak, speak, propose), { canSpeak: true, canPropose: false });
  assert.deepEqual(gateOf(speak - 1n, speak, propose), { canSpeak: false, canPropose: false });
  assert.deepEqual(gateOf(propose, speak, propose), { canSpeak: true, canPropose: true });
});

// ============================== weighted tally (BigInt) ==============================

test("tallyVotes accumulates weights per choice with BigInt, ignoring unknown choices", () => {
  const rows = [
    { choice: 1, weight: (10n ** 18n).toString() },        // for 1
    { choice: 1, weight: (2n * 10n ** 18n).toString() },   // for 2
    { choice: 0, weight: (5n * 10n ** 17n).toString() },   // against 0.5
    { choice: 2, weight: (3n * 10n ** 18n).toString() },   // abstain 3
    { choice: 9, weight: (100n * 10n ** 18n).toString() }, // unknown ⇒ not counted, not a voter
    { choice: 1, weight: "not-a-number" },                 // malformed weight ⇒ 0 but still a voter
  ];
  const t = tallyVotes(rows);
  assert.equal(t.forVotes, 3n * 10n ** 18n);
  assert.equal(t.against, 5n * 10n ** 17n);
  assert.equal(t.abstain, 3n * 10n ** 18n);
  assert.equal(t.total, t.forVotes + t.against + t.abstain);
  assert.equal(t.voters, 5);
});

test("tallyVotes on an empty set is all-zero; tallyJson emits raw strings + human values", () => {
  const empty = tallyVotes([]);
  assert.equal(empty.total, 0n);
  assert.equal(empty.voters, 0);
  const j = tallyJson(tallyVotes([{ choice: 1, weight: (3n * 10n ** 18n).toString() }]));
  assert.equal(j.for, (3n * 10n ** 18n).toString());
  assert.equal(j.forFmt, "3");
  assert.equal(j.against, "0");
  assert.equal(j.voters, 1);
});

// ============================== EIP-712 sign → recover roundtrip ==============================

test("verifyCommunitySignature round-trips a real Post signature (signer == author)", async () => {
  const ts = Date.now();
  const message = postMessage(acct.address, "hello plaza", 0, ts);
  const signature = await acct.signTypedData({
    domain: communityDomain(CHAIN),
    types: COMMUNITY_TYPES,
    primaryType: "Post",
    message: message as never,
  });
  const res = await verifyCommunitySignature({
    chainId: CHAIN,
    primaryType: "Post",
    message: message as unknown as Record<string, unknown>,
    signature,
    claimedAuthor: acct.address,
  });
  assert.equal(res.ok, true);
  if (res.ok) assert.equal(res.signer.toLowerCase(), acct.address.toLowerCase());
});

test("verifyCommunitySignature round-trips Propose and Vote", async () => {
  const ts = Date.now();
  const pmsg = proposeMessage(acct.address, "Fund the swarm", "body text", ts);
  const psig = await acct.signTypedData({ domain: communityDomain(CHAIN), types: COMMUNITY_TYPES, primaryType: "Propose", message: pmsg as never });
  const pres = await verifyCommunitySignature({ chainId: CHAIN, primaryType: "Propose", message: pmsg as unknown as Record<string, unknown>, signature: psig, claimedAuthor: acct.address });
  assert.equal(pres.ok, true);

  const vmsg = voteMessage(acct.address, 7, 1, ts);
  const vsig = await acct.signTypedData({ domain: communityDomain(CHAIN), types: COMMUNITY_TYPES, primaryType: "Vote", message: vmsg as never });
  const vres = await verifyCommunitySignature({ chainId: CHAIN, primaryType: "Vote", message: vmsg as unknown as Record<string, unknown>, signature: vsig, claimedAuthor: acct.address });
  assert.equal(vres.ok, true);
});

test("a browser signing uint256 fields as STRINGS recovers against the worker's BigInt message", async () => {
  // The browser (eth_signTypedData_v4) sends uint256 as decimal strings; the worker rebuilds the message with
  // BigInt. EIP-712 encodes uint256 by value, so both must yield the identical digest — this pins that contract.
  const ts = Date.now();
  const browserMessage = { author: acct.address, body: "cross-check", proposalId: "0", ts: String(ts) };
  const signature = await acct.signTypedData({
    domain: communityDomain(CHAIN),
    types: COMMUNITY_TYPES,
    primaryType: "Post",
    message: browserMessage as never,
  });
  const res = await verifyCommunitySignature({
    chainId: CHAIN,
    primaryType: "Post",
    message: postMessage(acct.address, "cross-check", 0, ts) as unknown as Record<string, unknown>,
    signature,
    claimedAuthor: acct.address,
  });
  assert.equal(res.ok, true);
});

test("a signature whose signer ≠ the claimed author is rejected with 401", async () => {
  const ts = Date.now();
  const message = postMessage(acct.address, "impersonation attempt", 0, ts);
  const signature = await acct.signTypedData({ domain: communityDomain(CHAIN), types: COMMUNITY_TYPES, primaryType: "Post", message: message as never });
  const res = await verifyCommunitySignature({
    chainId: CHAIN,
    primaryType: "Post",
    message: message as unknown as Record<string, unknown>,
    signature,
    claimedAuthor: "0x0000000000000000000000000000000000000001",
  });
  assert.equal(res.ok, false);
  if (!res.ok) assert.equal(res.status, 401);
});

test("signing against the wrong chainId does not recover on the expected chain", async () => {
  const ts = Date.now();
  const message = postMessage(acct.address, "wrong chain", 0, ts);
  const signature = await acct.signTypedData({ domain: communityDomain(1), types: COMMUNITY_TYPES, primaryType: "Post", message: message as never });
  const res = await verifyCommunitySignature({ chainId: CHAIN, primaryType: "Post", message: message as unknown as Record<string, unknown>, signature, claimedAuthor: acct.address });
  assert.equal(res.ok, false); // the domain separator differs ⇒ a different (non-matching) signer
});

test("a malformed signature is a 400 and an unrecoverable one is a 401", async () => {
  const ts = Date.now();
  const message = postMessage(acct.address, "x", 0, ts) as unknown as Record<string, unknown>;
  const bad = await verifyCommunitySignature({ chainId: CHAIN, primaryType: "Post", message, signature: "0xnothex", claimedAuthor: acct.address });
  assert.equal(bad.ok, false);
  if (!bad.ok) assert.equal(bad.status, 400);

  const garbage = await verifyCommunitySignature({ chainId: CHAIN, primaryType: "Post", message, signature: "0x" + "11".repeat(65), claimedAuthor: acct.address });
  assert.equal(garbage.ok, false);
});

// ============================== vote timeline (append-only, point-in-time) ==============================
// This is the transparency layer that answers the "a late whale can swing the tally" critique: every vote AND
// re-vote is an immutable event, and buildTimeline rebuilds the cumulative curve so a last-hour swing is visible.

const W = (n: bigint) => (n * 10n ** 18n).toString(); // n whole MURMUR → raw 18dp string
const VA = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const VB = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const VC = "0xcccccccccccccccccccccccccccccccccccccccc";

test("buildTimeline is empty for no events", () => {
  assert.deepEqual(buildTimeline([]), []);
});

test("buildTimeline accumulates point-in-time across distinct voters", () => {
  const series = buildTimeline([
    { voter: VA, choice: 1, weight: W(10n), ts: 1000, recorded_at: 1000 }, // for 10
    { voter: VB, choice: 0, weight: W(4n), ts: 2000, recorded_at: 2000 },   // against 4
    { voter: VC, choice: 1, weight: W(6n), ts: 3000, recorded_at: 3000 },   // for +6 = 16
  ]);
  assert.equal(series.length, 3);
  assert.equal(series[0].for, W(10n));
  assert.equal(series[0].against, "0");
  assert.equal(series[1].against, W(4n));
  assert.equal(series[2].for, W(16n));
  assert.equal(series[2].total, W(20n));
  assert.equal(series[2].voters, 3);
  assert.equal(series[2].leader, "for");
});

test("a re-vote removes the old weight before adding the new (isRevote, voters unchanged, never double-counted)", () => {
  const series = buildTimeline([
    { voter: VA, choice: 1, weight: W(10n), ts: 1000, recorded_at: 1000 }, // for 10
    { voter: VA, choice: 0, weight: W(10n), ts: 5000, recorded_at: 5000 }, // A flips to against 10
  ]);
  assert.equal(series[1].event.isRevote, true);
  assert.equal(series[1].for, "0");        // the old FOR weight is removed
  assert.equal(series[1].against, W(10n)); // the new AGAINST weight is added
  assert.equal(series[1].voters, 1);       // still one distinct voter
  assert.equal(series[1].total, W(10n));   // total never double-counts A
});

test("buildTimeline flags every lead change (the whale-swing signal)", () => {
  const series = buildTimeline([
    { voter: VA, choice: 1, weight: W(5n), ts: 1000, recorded_at: 1000 },   // for 5  → leader for (from none)
    { voter: VB, choice: 0, weight: W(3n), ts: 2000, recorded_at: 2000 },   // against 3 → still for
    { voter: VC, choice: 0, weight: W(50n), ts: 3000, recorded_at: 3000 },  // against 53 → flips to against (WHALE)
  ]);
  assert.equal(series[0].event.isLeadChange, true); // none → for
  assert.equal(series[0].leader, "for");
  assert.equal(series[1].event.isLeadChange, false); // still for
  assert.equal(series[1].leader, "for");
  assert.equal(series[2].event.isLeadChange, true); // for → against
  assert.equal(series[2].leader, "against");
});

test("buildTimeline orders by recorded_at even if the input array is shuffled", () => {
  const series = buildTimeline([
    { voter: VB, choice: 0, weight: W(2n), ts: 20, recorded_at: 2000 },
    { voter: VA, choice: 1, weight: W(1n), ts: 10, recorded_at: 1000 },
  ]);
  assert.equal(series[0].event.voter, VA); // recorded_at 1000 sorts first
  assert.equal(series[1].event.voter, VB);
});

test("the timeline tail equals the authoritative dedup-by-voter tally (community_votes)", () => {
  const series = buildTimeline([
    { voter: VA, choice: 1, weight: W(10n), ts: 1000, recorded_at: 1000 },
    { voter: VB, choice: 1, weight: W(5n), ts: 2000, recorded_at: 2000 },
    { voter: VA, choice: 0, weight: W(10n), ts: 3000, recorded_at: 3000 }, // A re-votes against
  ]);
  const last = series[series.length - 1];
  // community_votes would hold exactly: A = against 10, B = for 5.
  const authoritative = tallyVotes([
    { choice: 0, weight: W(10n) },
    { choice: 1, weight: W(5n) },
  ]);
  assert.equal(last.against, authoritative.against.toString());
  assert.equal(last.for, authoritative.forVotes.toString());
  assert.equal(last.voters, authoritative.voters);
  assert.equal(last.total, authoritative.total.toString());
});
