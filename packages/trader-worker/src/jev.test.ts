/**
 * SYSTEM ONE (Jev) client — the read-out side-plane.
 *
 * The whole point of these tests is to pin the IRON GUARDRAILS, not the intelligence of Jev:
 *   GATE  — inert unless enabled AND a key is present (jevIsLive). An off/half-configured client issues ZERO
 *           requests, so an unarmed build is byte-for-byte today's (no jev key ever reaches /economy).
 *   OPEN  — evaluate() NEVER throws: a transport error, a non-2xx status, a timeout/abort, or a malformed
 *           body all collapse to null ("no read-out this tick").
 *   SHAPE — a valid response maps to typed answers, and numbers are clamped into [0,1] so a wild model value
 *           can never leak a nonsense magnitude into a read-out. interpretJev drops a drawer outside our
 *           fixed whitelist (it must only ever name a panel that exists).
 *
 * No real network: a mock transport is injected. Only fixed inputs are used (no RNG/clock in assertions).
 */
import test from "node:test";
import assert from "node:assert/strict";

import {
  JevClient,
  jevIsLive,
  normalizeResponse,
  buildJevRequest,
  interpretJev,
  JEV_DRAWERS,
  JEV_QID,
  type JevFetch,
  type JevJsonValue,
  type JevQuestion,
} from "./jev.js";

// --- helpers ---------------------------------------------------------------------------------

/** A transport that records calls and returns a canned ok/JSON. */
function mockFetch(
  result: { ok: boolean; status: number; body?: unknown } | (() => Promise<never>),
): { fetch: JevFetch; calls: { url: string; auth: string; body: string }[] } {
  const calls: { url: string; auth: string; body: string }[] = [];
  const fetch: JevFetch = async (input, init) => {
    calls.push({ url: input, auth: init.headers.Authorization, body: init.body });
    if (typeof result === "function") return result();
    return {
      ok: result.ok,
      status: result.status,
      json: async () => result.body,
    };
  };
  return { fetch, calls };
}

const LIVE = { enabled: true, apiKey: "sk-test" } as const;
const STATE: JevJsonValue = { temperature: 0.8, regime: "HOT", swarm_size: 100, latest_record: "PLAGUE: a fever sweeps the swarm" };
const ONE_Q: Record<string, JevQuestion> = { x: { type: "noul", instructions: "hot?" } };

// --- GATE -------------------------------------------------------------------------------------

test("J1 disabled → null, no request", async () => {
  const { fetch, calls } = mockFetch({ ok: true, status: 200, body: {} });
  const c = new JevClient({ enabled: false, apiKey: "sk", baseUrl: "https://x", model: "jev-latest", timeoutMs: 900, fetchImpl: fetch });
  assert.equal(await c.evaluate(STATE, ONE_Q), null);
  assert.equal(calls.length, 0);
  assert.equal(c.live, false);
});

test("J2 enabled but NO key → null, no request (half-config can never fire)", async () => {
  const { fetch, calls } = mockFetch({ ok: true, status: 200, body: {} });
  for (const key of [null, "", "   "]) {
    const c = new JevClient({ enabled: true, apiKey: key, baseUrl: "https://x", model: "jev-latest", timeoutMs: 900, fetchImpl: fetch });
    assert.equal(c.live, false);
    assert.equal(await c.evaluate(STATE, ONE_Q), null);
  }
  assert.equal(calls.length, 0);
  assert.equal(jevIsLive({ enabled: false, apiKey: "sk" }), false);
  assert.equal(jevIsLive({ enabled: true, apiKey: "sk" }), true);
});

// --- OPEN (fail-open) -------------------------------------------------------------------------

test("J3 transport throws → null", async () => {
  const { fetch } = mockFetch(() => {
    throw new Error("connection reset");
  });
  const c = new JevClient({ ...LIVE, baseUrl: "https://x", model: "jev-latest", timeoutMs: 900, fetchImpl: fetch });
  assert.equal(await c.evaluate(STATE, ONE_Q), null);
});

test("J4 non-2xx (429 / 529 / 401 / 422) → null", async () => {
  for (const status of [401, 422, 429, 529, 500]) {
    const { fetch } = mockFetch({ ok: false, status, body: { detail: "nope" } });
    const c = new JevClient({ ...LIVE, baseUrl: "https://x", model: "jev-latest", timeoutMs: 900, fetchImpl: fetch });
    assert.equal(await c.evaluate(STATE, ONE_Q), null, `status ${status} must degrade to null`);
  }
});

test("J5 timeout / abort → null (never hang the caller)", async () => {
  // A transport that resolves only when the abort signal fires — mimics a stalled endpoint.
  const hangingFetch: JevFetch = (_input, init) =>
    new Promise((_res, rej) => {
      const sig = init.signal;
      if (!sig) return;
      if (sig.aborted) return rej(new Error("aborted"));
      sig.addEventListener("abort", () => rej(new Error("aborted")));
    });
  const c = new JevClient({ ...LIVE, baseUrl: "https://x", model: "jev-latest", timeoutMs: 20, fetchImpl: hangingFetch });
  const t0 = Date.now();
  assert.equal(await c.evaluate(STATE, ONE_Q), null);
  assert.ok(Date.now() - t0 < 2_000, "must return promptly, not hang");
});

test("J6 malformed body → null", async () => {
  const cases: unknown[] = [null, undefined, 42, "str", {}, { answers: null }, { answers: {} }, { answers: { a: { type: "weird" } } }];
  for (const body of cases) {
    const { fetch } = mockFetch({ ok: true, status: 200, body });
    const c = new JevClient({ ...LIVE, baseUrl: "https://x", model: "jev-latest", timeoutMs: 900, fetchImpl: fetch });
    assert.equal(await c.evaluate(STATE, ONE_Q), null, `body ${JSON.stringify(body)} must degrade to null`);
  }
});

// --- SHAPE (success + clamping + mapping) -----------------------------------------------------

test("J7 success maps the request shape (Bearer + path + model + questions)", async () => {
  const body = { model: "jev-1.13.0", answers: { x: { type: "noul", noul: 0.9 } }, usage: { input_tokens: 10, output_tokens: 2 } };
  const { fetch, calls } = mockFetch({ ok: true, status: 200, body });
  const c = new JevClient({ ...LIVE, baseUrl: "https://api.typesafe.ai/", model: "jev-latest", timeoutMs: 900, fetchImpl: fetch });
  const resp = await c.evaluate(STATE, ONE_Q);
  assert.ok(resp);
  assert.equal(resp!.model, "jev-1.13.0");
  assert.equal((resp!.answers.x as { noul: number }).noul, 0.9);
  assert.equal(calls[0].url, "https://api.typesafe.ai/v1/systemone", "trailing slash must not double up");
  assert.equal(calls[0].auth, "Bearer sk-test");
  const sent = JSON.parse(calls[0].body);
  assert.equal(sent.model, "jev-latest");
  assert.deepEqual(sent.state, STATE);
  assert.deepEqual(Object.keys(sent.questions), ["x"]);
});

test("J8 normalizeResponse clamps probabilities/noul/confidence into [0,1] and drops non-numbers", () => {
  const r = normalizeResponse({
    model: "jev-x",
    answers: {
      n: { type: "noul", noul: 1.7 },
      ch: { type: "choice", choice: "a", probabilities: { a: 1.4, b: -0.2, c: "x" }, confidence: 5 },
      sc: { type: "score", score: 2.1, legend: { "0": "low", "1": "high" }, probabilities: { "0": 0.3, "1": 0.7 }, confidence: -3 },
      bad: { type: "noul", noul: "nope" },
    },
  });
  assert.ok(r);
  assert.equal((r!.answers.n as { type: "noul"; noul: number }).noul, 1); // clamped
  const ch = r!.answers.ch as { type: "choice"; probabilities: Record<string, number>; confidence: number };
  assert.equal(ch.probabilities.a, 1);
  assert.equal(ch.probabilities.b, 0);
  assert.equal("c" in ch.probabilities, false); // non-number dropped
  assert.equal(ch.confidence, 1);
  const sc = r!.answers.sc as { type: "score"; confidence: number };
  assert.equal(sc.confidence, 0); // -3 clamped up to 0
  assert.equal("bad" in r!.answers, false); // invalid answer omitted
});

test("J9 interpretJev maps every field and enforces the drawer whitelist", () => {
  const req = buildJevRequest({
    temperature: 0.9, regime: "HOT", momentum: 0.2, turbulence: 0.8, swarmSize: 100, topDrive: "FORAGE", chronicleHeadline: "PLAGUE: x",
  });
  const insight = interpretJev(
    req,
    {
      model: "jev-1.13.0",
      answers: {
        [JEV_QID.posture]: { type: "choice", choice: "fevered", probabilities: { fevered: 0.9 }, confidence: 0.7 },
        [JEV_QID.mood]: { type: "score", score: 3.4, legend: {}, probabilities: {}, confidence: 0.6 },
        [JEV_QID.urgent]: { type: "noul", noul: 0.82 },
        [JEV_QID.consistent]: { type: "noul", noul: 0.55 },
        drawer: { type: "choice", choice: "chronicle", probabilities: { chronicle: 0.8 }, confidence: 0.9 },
      },
    },
    1_700_000_000_000,
  );
  assert.equal(insight.model, "jev-1.13.0");
  assert.equal(insight.ts, 1_700_000_000_000);
  assert.equal(insight.posture!.choice, "fevered");
  assert.equal(insight.mood!.score, 3.4);
  assert.equal(insight.urgent, 0.82);
  assert.equal(insight.consistent, 0.55);
  assert.equal(insight.drawer!.choice, "chronicle");

  // A drawer name that is NOT one of our panels must be dropped to null (never route to a phantom panel).
  const bad = interpretJev(req, { model: "m", answers: { drawer: { type: "choice", choice: "secrets", probabilities: {}, confidence: 1 } } }, 1);
  assert.equal(bad.drawer, null);
  // Missing answers → the corresponding fields are null, never throw.
  const empty = interpretJev(req, { model: "m", answers: {} }, 1);
  assert.equal(empty.posture, null);
  assert.equal(empty.urgent, null);
});

test("J10 buildJevRequest asks the 5 murmur questions with valid criteria arity", () => {
  const req = buildJevRequest({ temperature: 0.5, regime: "CALM", momentum: 0, turbulence: 0.2, swarmSize: 40, topDrive: "REST", chronicleHeadline: null });
  const q = req.questions;
  assert.equal(q[JEV_QID.posture].type, "choice");
  assert.equal(q[JEV_QID.mood].type, "score");
  assert.equal((q[JEV_QID.mood] as { criteria: unknown[] }).criteria.length >= 2, true, "score needs ≥2 levels");
  assert.equal(q[JEV_QID.urgent].type, "noul");
  assert.equal(q[JEV_QID.consistent].type, "noul");
  assert.equal(q.drawer.type, "choice");
  const drawerOpts = Object.keys((q.drawer as { criteria: Record<string, unknown> }).criteria);
  assert.deepEqual(drawerOpts.slice().sort(), JEV_DRAWERS.slice().sort());
});
