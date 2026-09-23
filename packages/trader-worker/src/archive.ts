// ⑰ THE ARCHIVE — externalized knowledge as a pure read-out membrane.
//
// Education (⑯) makes knowledge personal and fragile: a craft dies with its last keeper. The Archive is the
// swarm's first rebellion against that fragility — someone carves an art onto a stone so it can outlive every
// living mind that held it. But records themselves can burn.
//
// The membrane is a pure read-out: it never grants a craft, moves no neuron, touches no purse. It only observes
// which keepers inscribe, which unskilled minds are seen studying a record, and which records a dark age destroys.
// The narrative tension with ⑯ is deliberate: CRAFT_LOST says "nobody remembers"; ARCHIVE_BURNED says "nobody
// remembers AND it is no longer written down." Only when both have fired is an art truly, forever gone.
//
// Determinism: every decision is a pure function of (tick, keeper ids, fly ids, civLevel, records) via FNV-1a —
// no RNG state, no wall-clock, no LLM. Two membranes fed the same crons agree byte-for-byte.

import { LADDER } from "./invention.js";

// ─── public types ────────────────────────────────────────────────────────────────────────────────────────

export interface ArchiveRecord {
  rung: number;           // 1-based ladder rung
  name: string;           // LADDER[rung-1].name (the art's permanent public name)
  recordedBy: number;     // fly id who inscribed it
  tick: number;           // when it was carved
}

export interface ArchiveSignals {
  records: ArchiveRecord[];       // surviving records, sorted by rung descending
  recorded: number;               // cumulative count of inscriptions ever made (the ledger's tally)
  decodes: number;                // cumulative count of decode observations
  recording: { id: number; rung: number; name: string } | null;   // this cron's edge event
  decode: { id: number; rung: number; name: string } | null;      // this cron's edge event
  archiveBurned: { rung: number; name: string; recordedBy: number } | null; // this cron's edge event
}

export interface ArchiveConfig {
  enabled: boolean;
  recordP: number;        // probability a keeper inscribes their craft per cron (default 0.02)
  decodeP: number;        // probability an unskilled mind is seen studying a record (default 0.08)
  burnCivMax: number;     // civLevel at or below this, records may burn (default 15)
}

// ─── bounded, deterministic constants (DO-safe) ─────────────────────────────────────────────────────────

const RECORD_SALT = 0x51a7;     // "slab" — which keeper inscribes (never aliases culture/tech/apprentice salts)
const DECODE_SALT = 0xd30d;     // "sowed" — which unskilled mind is seen studying
const BURN_SALT   = 0x8e25;    // "burn" — the dark age's toll on the archive
const RECORDS_CAP = 24;         // hard ceiling: LADDER_LEN × 2 (each rung may hold at most 2 redundant records)
const LADDER_LEN  = LADDER.length;
const ARCHIVE_VERSION = 1;

// ─── FNV-1a private implementation (same algorithm as culture/tech/apprentice, distinct salts) ──────────

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

// ─── the membrane ───────────────────────────────────────────────────────────────────────────────────────

interface Pending {
  recording: { id: number; rung: number; name: string } | null;
  decode: { id: number; rung: number; name: string } | null;
  archiveBurned: { rung: number; name: string; recordedBy: number } | null;
}

export class ArchiveMembrane {
  private readonly cfg: ArchiveConfig;
  private records: ArchiveRecord[] = [];
  private recordedTotal = 0;
  private decodeTotal = 0;
  private pending: Pending = { recording: null, decode: null, archiveBurned: null };

  constructor(cfg: ArchiveConfig) { this.cfg = cfg; }

  /** Drive one cron. keeperIds = Map<flyId, craft> from ⑯; flyIds = all live ids; civLevel from eraInfo(). */
  round(
    tick: number,
    keeperIds: Map<number, number>,
    inventedTop: number,
    civLevel: number,
    flyIds: number[],
  ): void {
    this.pending = { recording: null, decode: null, archiveBurned: null };
    if (!this.cfg.enabled) return;

    // 1) RECORDING — a keeper inscribes their craft onto a permanent record.
    //    Only if that rung doesn't already have RECORDS_CAP/LADDER_LEN redundant copies (max 2 per rung).
    const recordedRungs = new Map<number, number>(); // rung → count
    for (const r of this.records) recordedRungs.set(r.rung, (recordedRungs.get(r.rung) ?? 0) + 1);

    for (const [id, craft] of keeperIds) {
      if (craft < 1 || craft > inventedTop) continue;
      const count = recordedRungs.get(craft) ?? 0;
      if (count >= 2) continue; // max 2 records per rung (bounded)
      if (hash01(tick, id, RECORD_SALT) < this.cfg.recordP) {
        const name = LADDER[craft - 1].name;
        this.records.push({ rung: craft, name, recordedBy: id, tick });
        this.recordedTotal++;
        this.pending.recording = { id, rung: craft, name };
        recordedRungs.set(craft, count + 1);
        break; // one recording per cron (the rarest moment, told once)
      }
    }

    // 2) DECODE — an unskilled mind is seen studying a record.
    //    Only fires if records exist and the fly is NOT already a keeper.
    if (this.records.length > 0 && !this.pending.recording) {
      for (const fid of flyIds) {
        if (keeperIds.has(fid)) continue; // keepers already know things
        if (hash01(tick, fid, DECODE_SALT) < this.cfg.decodeP) {
          // pick the lowest rung that has a record (the first thing a student would grasp)
          let best: ArchiveRecord | null = null;
          for (const r of this.records) if (!best || r.rung < best.rung) best = r;
          if (best) {
            this.decodeTotal++;
            this.pending.decode = { id: fid, rung: best.rung, name: best.name };
          }
          break; // one decode per cron
        }
      }
    }

    // 3) ARCHIVE_BURNED — a dark age destroys the oldest record.
    if (civLevel <= this.cfg.burnCivMax && this.records.length > 0) {
      // at most one burn per cron, gated by a low probability (the dark age doesn't torch everything at once)
      if (hash01(tick, civLevel, BURN_SALT) < 0.08) {
        const lost = this.records.shift()!; // destroy the oldest
        this.pending.archiveBurned = { rung: lost.rung, name: lost.name, recordedBy: lost.recordedBy };
      }
    }

    // 4) BOUND — keep the records array within RECORDS_CAP (DO-safe).
    if (this.records.length > RECORDS_CAP) this.records.splice(0, this.records.length - RECORDS_CAP);
  }

  /** The historian's read-out. */
  signals(): ArchiveSignals {
    const sorted = [...this.records].sort((a, b) => b.rung - a.rung);
    return {
      records: sorted,
      recorded: this.recordedTotal,
      decodes: this.decodeTotal,
      recording: this.pending.recording,
      decode: this.pending.decode,
      archiveBurned: this.pending.archiveBurned,
    };
  }

  /** Serialize for Durable Object storage. */
  serialize(): string {
    return JSON.stringify({
      version: ARCHIVE_VERSION,
      records: this.records,
      recorded: this.recordedTotal,
      decodes: this.decodeTotal,
    });
  }

  /** Restore from stored blob. A corrupt or out-of-range blob restarts empty (never touches the ledger). */
  restore(blob: string): void {
    try {
      const p = JSON.parse(blob);
      if (p.version !== ARCHIVE_VERSION || !Array.isArray(p.records)) return;
      const valid: ArchiveRecord[] = [];
      for (const r of p.records) {
        if (
          Number.isInteger(r.rung) && r.rung >= 1 && r.rung <= LADDER_LEN &&
          typeof r.name === "string" && Number.isInteger(r.recordedBy) && Number.isFinite(r.tick)
        ) {
          valid.push({ rung: r.rung, name: r.name, recordedBy: r.recordedBy, tick: r.tick });
        }
      }
      this.records = valid.slice(0, RECORDS_CAP);
      this.recordedTotal = Number.isFinite(p.recorded) ? Math.max(0, Math.floor(p.recorded)) : 0;
      this.decodeTotal = Number.isFinite(p.decodes) ? Math.max(0, Math.floor(p.decodes)) : 0;
    } catch { /* corrupt blob ⇒ empty start, never a crash */ }
  }
}

/** The null-object returned when ARCHIVE_ENABLED=false — completely inert. */
export const NULL_ARCHIVE = new ArchiveMembrane({ enabled: false, recordP: 0.02, decodeP: 0.08, burnCivMax: 15 });
