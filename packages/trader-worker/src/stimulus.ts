// Visitor stimulus — "poke the swarm".
//
// Any visitor can inject a short stimulus (feed / threat / light / dark) into the fly population.
// It rides on top of the Arc market pulse as a secondary sensory input: the whole swarm perceives it
// on the next tick and its behaviour shifts for a moment. No wallet, no token, no signature — just a
// click, rate-limited to one per visitor per cooldown window.
//
// Trust model:
//   1. The frontend generates an anonymous clientId (persisted in localStorage) and sends it.
//   2. The Worker keys the cooldown on clientId (falling back to CF-Connecting-IP, then "anon").
//   3. Each key may fire at most once per STIMULUS_COOLDOWN_SEC seconds.
//   4. On accept, the stimulus is queued for the population and logged for the frontend feed.

import type { RuntimeConfig } from "./config.js";
import type { StimulusEvent } from "@fly/fly-brain";

export interface StimulusVotePayload {
  stimulus: StimulusEvent["type"];
  intensity: number;          // 0..1
  clientId?: string;          // Frontend anonymous id (preferred cooldown key)
  voter?: string;             // Optional display handle for who poked the swarm
}

export interface StimulusVoteRequest {
  payload: StimulusVotePayload;
  clientId?: string;          // Also allowed at the top level
}

export interface StimulusVoteResult {
  ok: boolean;
  reason?: string;
  retryAfterSec?: number;
  accepted?: StimulusEvent & { voter: string; effectiveIntensity: number };
}

/** Cooldown cache (in-process, lives for the duration of the Workers isolate) */
const lastVoteAt = new Map<string, number>();

/**
 * Handle one stimulus vote (no wallet required).
 * @param ip Caller-supplied fallback IP, used only when clientId / voter are missing.
 */
export async function handleStimulusVote(
  cfg: RuntimeConfig,
  req: StimulusVoteRequest,
  ip?: string,
): Promise<StimulusVoteResult> {
  const payload = req?.payload;

  // 1) Basic validation
  if (!payload) return { ok: false, reason: "missing payload" };
  if (!["food", "threat", "light", "dark"].includes(payload.stimulus)) {
    return { ok: false, reason: "invalid stimulus type" };
  }
  if (!(payload.intensity >= 0 && payload.intensity <= 1)) {
    return { ok: false, reason: "intensity out of range" };
  }

  // 2) Cooldown key: clientId > voter > ip
  const ident = (req.clientId || payload.clientId || payload.voter || ip || "anon")
    .toString().trim().toLowerCase() || "anon";

  const now = Date.now();
  const cooldownMs = cfg.stimulusCooldownSec * 1000;
  const last = lastVoteAt.get(ident) ?? 0;
  if (now - last < cooldownMs) {
    const retryAfterSec = Math.ceil((cooldownMs - (now - last)) / 1000);
    return { ok: false, reason: `cooldown: wait ${retryAfterSec}s`, retryAfterSec };
  }

  // 3) Record the cooldown & accept (no signature, no balance check — anyone can participate)
  lastVoteAt.set(ident, now);
  if (lastVoteAt.size > 20000) {
    // Prevent unbounded memory growth: prune expired entries
    for (const [k, t] of lastVoteAt) if (now - t > cooldownMs) lastVoteAt.delete(k);
  }

  const ev: StimulusEvent & { voter: string; effectiveIntensity: number } = {
    type: payload.stimulus,
    intensity: payload.intensity,
    from: payload.voter ?? ident,
    voter: payload.voter ?? ident,
    effectiveIntensity: Math.min(1, payload.intensity),
  };
  return { ok: true, accepted: ev };
}

/** Shape of a stimulus entry persisted in the DO store */
export interface StoredStimulus {
  ts: number;
  type: StimulusEvent["type"];
  intensity: number;
  voter: string;
}
