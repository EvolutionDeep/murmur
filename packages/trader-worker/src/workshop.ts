/**
 * ⑱ The Workshop — knowledge rebirth.
 *
 * When a dark age strips an art from the ladder (invention.ts adds it to `lost`), the Workshop
 * gives individual flies agency to rediscover it BEFORE the next generation edge. An exploring
 * fly that passes a hash-gated draw attempts reinvention; on success the art returns to the
 * ladder with the fly credited as its first new keeper.
 *
 * Design:
 *   - Reads: tech signals (lost arts), population snapshot (explorer fly IDs).
 *   - Writes: nothing directly — state.ts calls invention.restoreArt() + apprentice.injectKeeper()
 *     upon seeing a reinvention signal. The Workshop itself is a pure observer + narrator.
 *   - New ChronicleKind: REINVENTION (one per event, CD 80).
 *   - DO key: workshop:v1. Bounded: one event per cron, serialize <1KB.
 *   - Kill switch: WORKSHOP_ENABLED=false → null object, zero side effects.
 *
 * The Workshop closes the knowledge loop opened by ⑬ (discovery) + ⑯ (transmission) + ⑰ (externalization):
 *   Discovery → Transmission → Externalization → Loss → **Reinvention** → ...
 */

import { LADDER } from "./invention.js";

// ─── deterministic constants ──────────────────────────────────────────────────────────────────────────

const REINVENT_SALT = 0x776b;   // "wrk" — unique, never aliases culture/tech/apprentice/archive salts
const WORKSHOP_VERSION = 1;
const LADDER_LEN = LADDER.length;

function hash32(a: number, b: number, salt: number): number {
  let h = 0x811c9dc5 ^ salt;
  for (const v of [a, b]) {
    h ^= (v & 0xff); h = Math.imul(h, 0x01000193);
    h ^= ((v >>> 8) & 0xff); h = Math.imul(h, 0x01000193);
    h ^= ((v >>> 16) & 0xff); h = Math.imul(h, 0x01000193);
    h ^= ((v >>> 24) & 0xff); h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}
const hash01 = (a: number, b: number, salt: number): number => hash32(a, b, salt) / 0x100000000;

// ─── the membrane ─────────────────────────────────────────────────────────────────────────────────────

export interface WorkshopConfig {
  enabled: boolean;
  reinventP: number;       // per-explorer hash-gated chance to attempt reinvention (default 0.03)
}

export interface WorkshopSignals {
  reinventions: number;    // cumulative count of arts reinvented since membrane inception
  reinvention: { id: number; rung: number; name: string } | null;  // this cron's edge event (or null)
}

export class WorkshopMembrane {
  private reinventionTotal = 0;
  private pending: { reinvention: WorkshopSignals["reinvention"] } = { reinvention: null };

  constructor(private readonly cfg: WorkshopConfig) {}

  /**
   * One round per cron. Pass in the lost arts (from tech signals) and the IDs of flies
   * currently in EXPLORE state. The first explorer to pass the hash gate triggers reinvention
   * of the highest lost rung (the most impressive feat).
   */
  round(tick: number, lostArts: { rung: number; name: string }[], explorerIds: number[]): void {
    if (!this.cfg.enabled) return;
    this.pending.reinvention = null;

    if (lostArts.length === 0 || explorerIds.length === 0) return;

    // Pick the highest lost rung (1-based from tech signals) as the reinvention target.
    let target: { rung: number; name: string } | null = null;
    for (const a of lostArts) {
      if (!target || a.rung > target.rung) target = a;
    }
    if (!target) return;

    // Each explorer gets one hash-gated chance; first success wins.
    for (const id of explorerIds) {
      if (hash01(tick, id, REINVENT_SALT) < this.cfg.reinventP) {
        this.reinventionTotal++;
        this.pending.reinvention = { id, rung: target.rung, name: target.name };
        break;  // at most one reinvention per cron
      }
    }
  }

  signals(): WorkshopSignals {
    return {
      reinventions: this.reinventionTotal,
      reinvention: this.pending.reinvention,
    };
  }

  // ─── persistence ──────────────────────────────────────────────────────────────────────────────────

  serialize(): string {
    return JSON.stringify({
      v: WORKSHOP_VERSION,
      reinventions: this.reinventionTotal,
    });
  }

  restore(blob: unknown): void {
    if (typeof blob !== "string" || !blob) return;
    try {
      const p = JSON.parse(blob);
      if (!p || typeof p !== "object") return;
      this.reinventionTotal = Number.isFinite(Number(p.reinventions)) ? Math.max(0, Math.floor(Number(p.reinventions))) : 0;
    } catch { /* corrupt → keep defaults */ }
  }
}
