/**
 * ㉔ THE RUMOR MILL — the tale that carries itself: afoot, bent, quiet (packages/trader-worker/src/rumor.ts).
 *
 * ㉓ named the words the telling makes; this layer watches what a SINGLE telling does while it travels. An
 * event the chronicle has already spoken becomes a tale: ears lean in (the mill counts hearers), the telling
 * BENDS — nobody agrees any more on what was first said — and at last the tale quiets. And, for the first
 * time in this project's history, the tale reaches back: on a telling-day the flies that heard it are read
 * as what hearing looks like — a grave tale stops a fly mid-walk (HALT, the listening freeze), a lighter one
 * draws the social preening of whispering neighbors (GROOM, the grooming that primates traded for language).
 * This is the SECOND causal membrane ever shipped, and it is deliberately built in religion.ts's shape — a
 * read-out override on the SAME line culture and the holy rest already occupy — NOT on the stimulus-bus
 * path, whose two precedents (the civic bus ①, the coin bus ⑲) both remain dark-deployed OFF.
 *
 * THE FOUR IRON RULES:
 *   1. THE OVERWRITE IS A READ-OUT OVERWRITE ONLY. apply() rewrites fap/role on the decoded reading AFTER
 *     the brain speaks and BEFORE any consumer sees it (snapshot / economy / prediction) — exactly the holy
 *     rest's contract. No connectome, genome, fingerprint or manifest hash is touched; the receipts still
 *     bind the FROZEN neural drives, so "provably no LLM" is untouched. Money never moves here: the mill
 *     overrides which act a hearer is OBSERVED doing; settlement stays the economy's.
 *   2. RARE + BOUNDED BY CONSTRUCTION. At most ONE active tale; the override only runs on a telling-day
 *     (every RM_TELL_EVERYth tick) and only for the fraction of the swarm that has heard (hash draw below
 *     heard/RM_HEARD_CAP — a fly that hears keeps hearing: the draw is id-only, so membership grows
 *     monotonically). The loud rest of the crons, apply() returns 0 and touches nothing.
 *   3. DETERMINISM. No RNG, no clock, no LLM. Growth, bending and hearing are hash01 draws over (tick,
 *     tale seq, fly id) with private salts — replayable by anyone holding the annals roll.
 *   4. PURE READ-OUT OF THE ALREADY-TOLD. The mill may only adopt entries whose seq is ABOVE the roll's
 *     newest seq at boot (the guild-seeded silent adoption: a restored mill never re-tells history) and
 *     never writes a chronicle line itself; its three kinds are emitted by the historian from its signals.
 *
 * RM_ENABLED=false ⇒ state.ts never constructs the mill (ensureRumor returns null), folds no `rumor` key
 * into the historian's context AND never calls apply() ⇒ the three kinds can never speak and no reading is
 * ever rewritten ⇒ every line and every byte of behavior is the pre-Rumor build.
 */

import { FAP_ROLE, type Fap } from "@fly/fly-brain";
import type { FlyReading } from "./population.js";

const RM_VERSION = 1;

// ─── bounded, deterministic constants (the calibration is FROZEN IN CODE — the binding wall is spent) ──

/** Hard ceiling of hearers a tale can ever gather (the telling-day override's denominator). */
export const RM_HEARD_CAP = 48;
/** Hearers that turn a new tale into news for the chronicle (RUMOR_AFOOT's edge). */
export const RM_AFOOT_AT = 4;
/** Hearers past which a telling may bend in the retelling (the halfway mark of the cap). */
export const RM_TWIST_AT = 24;
/** Minimum hearers a tale needs before its quiet is worth recording (a hush over nothing is not an event). */
export const RM_TELL = 6;
/** How many crons a tale lives before the mill lets it go quiet on its own. */
export const RM_LIFE = 30;
/** A tale heard at THIS severity (or above) is grave: hearers freeze (HALT) instead of whisper (GROOM). */
export const RM_THREAT_SEV = 4;
/** Every RM_TELL_EVERYth tick is a telling-day: the ONLY ticks on which hearers are rewritten at all. */
export const RM_TELL_EVERY = 16;
/** Base growth per cron (1 + a hash draw below RM_GROW ⇒ 1..RM_GROW new ears). */
export const RM_GROW = 3;
/** The bend's probability, drawn once per tale (a hash of the tale's own seq — never re-rolled). */
export const RM_TWIST_P = 0.5;

/** Private salts (duplicated by design, like every layer's — a rumor draw can alias no other layer's). */
const GROW_SALT = 0x7a1e;   // how fast the tale travels this cron
const BEND_SALT = 0x33c9;   // whether the tale bends at all (rolled once, keyed by the tale's seq)
const LOUD_SALT = 0x51f2;   // graver or lighter, once the bend is decided
const EARS_SALT = 0x6d0b;   // which fly is among the hearers (id-only ⇒ hearing never un-hears)

/** The tales' nouns: kind → the word the market talks. An unlisted kind keeps its own lowercase name. */
export const RM_TOPICS: Record<string, string> = {
  FEUD: "feud", BETRAYAL: "betrayal", RAID: "raid", WAR_DECLARED: "war", WAR_RESOLVED: "war's ending",
  VERDICT: "verdict", EXILE: "exile", AMNESTY: "amnesty", INDICTMENT: "indictment",
  CHAMPION: "champion", RECORD: "record", GUILD_MONOPOLY: "monopoly", GUILD_CHARTER: "a new charter",
  SCHISM: "schism", PROPHECY: "prophecy", PILGRIMAGE: "pilgrimage", PLAGUE: "the rot",
  FAMINE: "famine", GREAT_HUDDLE: "the long cold", BOOM: "boom", STORM: "storm",
  MIGRATION: "migration", INVENTION: "invention", CRAFT_LOST: "a lost craft", GOLDEN_AGE: "a golden age",
  DARK_AGE: "a dark age", RUN: "the run on the banks", DEATH: "a death", GENESIS: "the founding",
};

/** The topic a kind is talked as — listed kinds win, the rest get their lowercase name. */
export function rumorTopic(kind: string): string {
  return RM_TOPICS[kind] ?? kind.toLowerCase().replace(/_/g, " ");
}

// ─── the facts the mill may read (state.ts folds entries NEWER than the mill's last seen seq) ─────────

export interface RumorNews {
  seq: number;
  kind: string;
  sev: number;
  actors: number[];
}

export interface RumorFacts {
  /** The historian's current era — the age a tale is told in. */
  era: number;
  /** Entries spoken since the mill last listened, ascending seq (state caps this roll). */
  news: RumorNews[];
  /** The roll's newest seq — the boot-adoption's measuring stick. */
  maxSeq: number;
}

export interface RumorConfig {
  enabled: boolean;
}

// ─── the signals (edge events for THIS cron + the standing read-out) ──────────────────────────────────

export interface ActiveTale {
  topic: string;
  seq: number;        // the chronicle line this tale is told from
  sev0: number;       // how it actually happened
  sevHeard: number;   // how it is heard (drifts once, at the bend, if at all)
  heard: number;      // ears so far (capped at RM_HEARD_CAP)
  era: number;
  bent: boolean;
}

export interface RumorSignals {
  afoot: { topic: string; heard: number; era: number; holders: number[] } | null;
  bent: { topic: string; heard: number; heardAs: string } | null;
  faded: { topic: string; heard: number } | null;
  active: ActiveTale | null;
  counts: { afoot: number; bends: number; faded: number };
  /** The live override's shape, for the drawer: the act a hearer is read as on a telling-day. */
  echo: { act: "HALT" | "GROOM"; ratio: number } | null;
}

// ─── the mill ──────────────────────────────────────────────────────────────────────────────────────────

export class RumorMill {
  private active: (ActiveTale & { bornTick: number; afootFired: boolean; bendFired: boolean; holders: number[] }) | null = null;
  private lastMaxSeq = 0;
  /** Boot gate: the FIRST round a mill sees only seeds the roll — history is never re-told (guild law). */
  private seen = false;
  private counts = { afoot: 0, bends: 0, faded: 0 };
  private pending: RumorSignals = {
    afoot: null, bent: null, faded: null, active: null, counts: { ...this.counts }, echo: null,
  };

  constructor(private readonly cfg: RumorConfig) {}

  /** One round per cron, AFTER driveLexicon and BEFORE observeChronicle — the mill only ever hears
   *  tellings that are already history (the same one-cron honesty as the dictionary). */
  round(tick: number, facts: RumorFacts): void {
    if (!this.cfg.enabled) return;
    this.pending = {
      afoot: null, bent: null, faded: null,
      active: this.active ? this.view() : null,
      counts: { ...this.counts }, echo: this.echo(),
    };

    // 0) SILENT ADOPTION — a freshly restored mill seeds its cursor from the roll and listens for what
    //    comes after. Without this, every restart would re-tell the whole living memory at once.
    if (!this.seen) {
      this.seen = true;
      this.lastMaxSeq = facts.maxSeq;
      return;
    }

    // 1) NEW TALENS — a newer, GRAVER telling displaces the current tale (a market talks one thing at a
    //    time); the displaced one goes quiet only if it gathered real ears (a hush over nothing is not news).
    const fresh = facts.news.filter((n) => n.seq > this.lastMaxSeq).sort((a, b) => a.seq - b.seq);
    for (const n of fresh) {
      if (n.seq > this.lastMaxSeq) this.lastMaxSeq = n.seq;
      if (!this.active) {
        this.adopt(n, facts.era, tick);
        continue;
      }
      if (n.sev > this.active.sev0) {
        this.quiet(n.sev, tick);           // fades the old tale (may emit RUMOR_FADED)
        this.adopt(n, facts.era, tick);
      }
    }

    // 2) TRAVEL — the tale grows ears every cron (1..RM_GROW, a hash draw keyed by the tale's own seq).
    const a = this.active;
    if (a) {
      a.heard = Math.min(RM_HEARD_CAP, a.heard + 1 + Math.floor(hash01(tick, a.seq, GROW_SALT) * RM_GROW));

      // 2a) AFOOT — the first time enough ears lean in, the chronicle notices the tale, not the event.
      if (!a.afootFired && a.heard >= RM_AFOOT_AT) {
        a.afootFired = true;
        this.counts.afoot++;
        this.pending.afoot = { topic: a.topic, heard: a.heard, era: a.era, holders: a.holders.slice() };
      }

      // 2b) THE BEND — past the halfway mark the telling is drawn ONCE (keyed by the tale's seq, so a
      //     replay bends it identically): half of all tales bend. Graver or lighter is a second draw.
      if (!a.bendFired && a.heard >= RM_TWIST_AT) {
        a.bendFired = true;
        if (hash01(0, a.seq, BEND_SALT) < RM_TWIST_P) {
          const graver = hash01(1, a.seq, LOUD_SALT) < 0.5;
          a.bent = graver;
          a.sevHeard = Math.max(1, Math.min(5, a.sev0 + (graver ? 1 : -1)));
          this.counts.bends++;
          this.pending.bent = { topic: a.topic, heard: a.heard, heardAs: graver ? "graver" : "lighter" };
        }
      }
    }

    // 3) THE QUIET — a tale lives RM_LIFE crons at most; past that the mill lets it go, and the market
    //    is ready for the next one. (Displacement in step 1 fades it early, the same judgment.)
    if (this.active && tick - this.active.bornTick >= RM_LIFE) this.quiet(0, tick);

    // Read-out closes on the END-of-round truth.
    this.pending.active = this.active ? this.view() : null;
    this.pending.counts = { ...this.counts };
    this.pending.echo = this.echo();
  }

  /** Take up a telling as THE tale: it starts with the actors' own mouths (heard = 1). */
  private adopt(n: RumorNews, era: number, tick: number): void {
    this.active = {
      topic: rumorTopic(n.kind), seq: n.seq, sev0: n.sev, sevHeard: n.sev,
      heard: 1, era, bornTick: tick, afootFired: false, bendFired: false, bent: false,
      holders: n.actors.slice(0, 4),
    };
  }

  /** Lay a tale to rest: emit RUMOR_FADED only if it gathered real ears (graver displacings included). */
  private quiet(_bySev: number, _tick: number): void {
    const a = this.active;
    if (!a) return;
    if (a.heard >= RM_TELL) {
      this.counts.faded++;
      this.pending.faded = { topic: a.topic, heard: a.heard };
    }
    this.active = null;
  }

  private view(): ActiveTale {
    const a = this.active as NonNullable<RumorMill["active"]>;
    return { topic: a.topic, seq: a.seq, sev0: a.sev0, sevHeard: a.sevHeard, heard: a.heard, era: a.era, bent: a.bent };
  }

  /** The override's live shape (null between tales): the act hearers are read as + the heard fraction. */
  private echo(): RumorSignals["echo"] {
    const a = this.active;
    if (!a) return null;
    return {
      act: a.sevHeard >= RM_THREAT_SEV ? "HALT" : "GROOM",
      ratio: Math.min(1, a.heard / RM_HEARD_CAP),
    };
  }

  /**
   * THE CAUSAL LEG — the religion contract: rewrite ONLY the read-out line, ONLY of the flies that have
   * heard the tale, ONLY on a telling-day (every RM_TELL_EVERYth tick), and ONLY for as long as the tale
   * lives. A grave tale (heard severity ≥ RM_THREAT_SEV) freezes its hearers mid-walk (HALT — the
   * listening freeze); a lighter one draws GROOM, the social preening that IS gossip in every primate
   * market square. Inert on every other cron and with no tale afoot: safe to call unconditionally, and
   * byte-for-byte nothing when the switch is off (state.ts then holds no mill at all).
   */
  apply(readings: FlyReading[], tick: number): number {
    const a = this.active;
    if (!this.cfg.enabled || !a || tick % RM_TELL_EVERY !== 0) return 0;
    const ratio = Math.min(1, a.heard / RM_HEARD_CAP);
    const fap: Fap = a.sevHeard >= RM_THREAT_SEV ? "HALT" : "GROOM";
    let n = 0;
    for (const r of readings) {
      // id-only draw ⇒ hearing is monotonic: a fly that has heard keeps hearing as the ratio grows.
      if (hash01(0, r.id, EARS_SALT) >= ratio) continue;
      if (r.fap === fap) continue;
      r.fap = fap;
      r.role = FAP_ROLE[fap];
      n++;
    }
    return n;
  }

  signals(): RumorSignals { return this.pending; }

  // ─── persistence (bounded, additive; a corrupt blob restarts an empty market, never a poisoned ledger) ─

  serialize(): string {
    const a = this.active;
    return JSON.stringify({
      v: RM_VERSION,
      lastMaxSeq: this.lastMaxSeq,
      seen: this.seen,
      counts: this.counts,
      active: a
        ? { topic: a.topic, seq: a.seq, sev0: a.sev0, sevHeard: a.sevHeard, heard: a.heard, era: a.era, bornTick: a.bornTick, afootFired: a.afootFired, bendFired: a.bendFired, bent: a.bent, holders: a.holders }
        : null,
    });
  }

  restore(blob: unknown): void {
    if (typeof blob !== "string" || !blob) return;
    try {
      const p = JSON.parse(blob);
      if (!p || typeof p !== "object") return;
      const num = (x: unknown, d: number) => (Number.isFinite(Number(x)) ? Math.floor(Number(x)) : d);
      const c = p.counts ?? {};
      this.counts = { afoot: num(c.afoot, 0), bends: num(c.bends, 0), faded: num(c.faded, 0) };
      this.lastMaxSeq = Math.max(0, num(p.lastMaxSeq, 0));
      this.seen = p.seen === true;
      const a = p.active;
      if (a && typeof a === "object" && typeof a.topic === "string" && num(a.heard, -1) >= 1) {
        const sev0 = Math.max(1, Math.min(5, num(a.sev0, 2)));
        this.active = {
          topic: a.topic, seq: num(a.seq, this.lastMaxSeq), sev0,
          sevHeard: Math.max(1, Math.min(5, num(a.sevHeard, sev0))),
          heard: Math.min(RM_HEARD_CAP, num(a.heard, 1)),
          era: num(a.era, 0), bornTick: num(a.bornTick, 0),
          afootFired: a.afootFired === true, bendFired: a.bendFired === true, bent: a.bent === true,
          holders: Array.isArray(a.holders) ? a.holders.filter((x: unknown) => Number.isFinite(Number(x))).slice(0, 4).map((x: unknown) => Number(x)) : [],
        };
      } else {
        this.active = null;
      }
    } catch { /* corrupt → defaults: an empty market, a cursor at zero, nothing re-told */ }
  }
}

// FNV-1a 32-bit + uniform 0..1 draw — the SAME construction every membrane duplicates by design (private
// salts ⇒ a rumor draw can alias no culture, faith or economy draw).
function hash32(a: number, b: number, c: number): number {
  let h = 0x811c9dc5;
  const mix = (x: number) => {
    for (let s = 0; s < 32; s += 8) { h = Math.imul(h ^ ((x >>> s) & 0xff), 0x01000193) >>> 0; }
  };
  mix(a >>> 0); mix(b >>> 0); mix(c >>> 0);
  return h >>> 0;
}

function hash01(a: number, b: number, salt: number): number {
  return hash32(a, b, salt) / 0xffffffff;
}
