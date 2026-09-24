/**
 * ㉒ GUILDS — the chartered trades: founding, apprenticeship pacts, monopoly (packages/trader-worker/src/guilds.ts).
 *
 * ㉑ gave the swarm a stadium; a society also organises its labour. The Guilds read ONLY facts the economy
 * already recorded: the sticky professions institutions hang on every living fly (economy.ts, the fap-mode
 * roles), the historian's era counter, and the workforce's own headcounts. A trade whose living hands pass
 * the quorum wins a CHARTER; a fly taking up a chartered trade strikes a PACT beneath its banner; and when
 * one guild holds the rising majority of the working swarm, a MONOPOLY is proclaimed. Nothing here is a new
 * fact — it is the profession ledger, read socially.
 *
 * THE THREE IRON RULES (the culture/faith/workshop/court/games law, restated):
 *   1. PURE READ-OUT. The Guilds MOVE NO MONEY and never touch a connectome, genome, fingerprint or
 *      manifest hash. Chartering a trade changes no price and no buy probability — the tilt stays the
 *      economy's own profession logic, untouched by this membrane.
 *   2. DETERMINISM. No RNG, no clock, no LLM. Charters, pacts and monopolies are edges over the current
 *      headcounts (quorum crossings, first-seen roles, rising-share crossings); when several flies take up
 *      the same trade in one cron the pact's signatory is the lowest hash(tick, flyId, salt).
 *   3. BOUNDED. The roll holds ≤ one entry per trade (four), one share per trade, counts; the last-role
 *      map exists only for the living roster (≤ population) and never persists. serialize() stays < 1 KB.
 *      A corrupt blob restarts an empty guildhall.
 *
 * BOOT & RESTORE ADOPTION: the FIRST round a fresh (or restored) membrane sees is adopted SILENTLY —
 * trades already past quorum are marked chartered without a chronicle line, plateaus already past the
 * share mark are pinned, and every current role is recorded so no wholesale "apprenticeship" burst can
 * follow a restart. Only later edges speak. GUILD_ENABLED=false ⇒ state.ts never constructs the membrane
 * (ensureGuilds returns null), folds no `guilds` key into the historian's context ⇒ the three new
 * chronicle kinds can never speak ⇒ every old line is byte-for-byte the pre-Guilds build.
 */

// ─── deterministic constants ──────────────────────────────────────────────────────────────────────────

const GUILD_SALT = 0x67756c;           // "gul" — never aliases games/court/tech/religion/workshop salts
const GUILD_PACT_SALT = 0x706163;      // "pac"
const GUILDS_VERSION = 1;

/** The four lines of work the economy's institutions recognise (economy.ts Profession, mirrored). */
export const GUILD_ROLES = ["forager", "mooder", "trader", "brooder"] as const;

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
const round3 = (x: number): number => Math.round(x * 1000) / 1000;

// ─── the facts the guildhall may read (all already persisted elsewhere; this layer borrows, never owns) ─

export interface GuildFacts {
  /** The historian's current era index — the age that seals a charter. */
  era: number;
  /** The living workforce: each fly and its CURRENT sticky profession (null = not yet working). */
  workforce: { id: number; prof: string | null }[];
}

export interface GuildsConfig {
  enabled: boolean;
  quorum: number;    // living hands a trade needs before its guild is chartered (default 8)
  shareP: number;    // workforce share a chartered guild must RISE past to claim a monopoly (default 0.5)
}

// ─── the signals (edge events for THIS cron + the standing read-out) ──────────────────────────────────

export interface GuildRosterRow {
  role: string;
  members: number;
  share: number;     // 0..1 of the working swarm (0 when nobody works yet)
}

export interface GuildsSignals {
  charter: { role: string; members: number; quorum: number; era: number } | null;
  pact: { id: number; role: string; members: number } | null;
  monopoly: { role: string; share: number } | null;   // share = whole percents, as spoken
  roster: GuildRosterRow[];
  counts: { charters: number; pacts: number; monopolies: number };
}

// ─── the membrane ─────────────────────────────────────────────────────────────────────────────────────

export class GuildsMembrane {
  private adopted = false;                        // first round after boot/restore is silent
  private chartered: string[] = [];               // ≤ one seal per trade, fixed order
  private lastShare: Record<string, number> = {}; // per-role last seen share (rising-edge memory; 1 = plateau-pinned)
  private lastProf = new Map<number, string>();   // pact edge — living-only, NEVER serialized
  private counts = { charters: 0, pacts: 0, monopolies: 0 };
  private lastRoster: GuildRosterRow[] = [];

  // this cron's edge events (≤ one per kind per cron by construction — crossings are paced by the ledger)
  private pending: GuildsSignals = {
    charter: null, pact: null, monopoly: null,
    roster: [], counts: { ...this.counts },
  };

  constructor(private readonly cfg: GuildsConfig) {}

  /** One round per cron, BEFORE observeChronicle so this cron's edge events fold into the same context. */
  round(tick: number, facts: GuildFacts): void {
    if (!this.cfg.enabled) return;
    this.pending = {
      charter: null, pact: null, monopoly: null,
      roster: this.lastRoster.map((r) => ({ ...r })),
      counts: { ...this.counts },
    };

    // Count today's guild strength straight off the workforce — the economy's own profession ledger.
    const members: Record<string, number> = {};
    for (const role of GUILD_ROLES) members[role] = 0;
    let workers = 0;
    for (const f of facts.workforce) {
      if (typeof f.prof === "string" && f.prof in members) { members[f.prof]++; workers++; }
    }
    const shareOf = (role: string) => (workers > 0 ? members[role] / workers : 0);

    if (!this.adopted) {
      // BOOT/RESTORE ADOPTION — seal full, plateau pinned, no word spoken (the iron silence of games.ts).
      for (const role of GUILD_ROLES) {
        if (members[role] >= this.cfg.quorum && !this.chartered.includes(role)) this.chartered.push(role);
        const s = shareOf(role);
        this.lastShare[role] = this.chartered.includes(role) && s >= this.cfg.shareP ? 1 : s;
      }
      for (const f of facts.workforce) {
        if (typeof f.prof === "string") this.lastProf.set(f.id, f.prof);
        else this.lastProf.delete(f.id);
      }
      this.adopted = true;
    } else {
      // 1) THE CHARTER — the first unsealed trade past quorum wins its roll this cron (queue is self-pacing).
      for (const role of GUILD_ROLES) {
        if (!this.chartered.includes(role) && members[role] >= this.cfg.quorum) {
          this.chartered.push(role);
          this.counts.charters++;
          this.pending.charter = { role, members: members[role], quorum: this.cfg.quorum, era: facts.era };
          break;
        }
      }

      // 2) THE PACT — flies taking up a CHARTERED trade this cron; the roll's signatory is the lowest hash.
      const newcomers: { id: number; prof: string }[] = [];
      for (const f of facts.workforce) {
        if (typeof f.prof === "string" && this.chartered.includes(f.prof) && this.lastProf.get(f.id) !== f.prof) {
          newcomers.push({ id: f.id, prof: f.prof });
        }
      }
      if (newcomers.length) {
        let picked = newcomers[0];
        let best = hash01(tick, picked.id, GUILD_PACT_SALT);
        for (const n of newcomers.slice(1)) {
          const h = hash01(tick, n.id, GUILD_PACT_SALT);
          if (h < best) { picked = n; best = h; }
        }
        this.counts.pacts++;
        this.pending.pact = { id: picked.id, role: picked.prof, members: members[picked.prof] };
      }
      for (const f of facts.workforce) {
        if (typeof f.prof === "string") this.lastProf.set(f.id, f.prof);
        else this.lastProf.delete(f.id);
      }
      // prune the dead: the pact memory tracks ONLY the living roster (never serialized, never leaks)
      const live = new Set(facts.workforce.map((f) => f.id));
      for (const id of Array.from(this.lastProf.keys())) if (!live.has(id)) this.lastProf.delete(id);

      // 3) THE MONOPOLY — a chartered guild whose share RISES past the mark holds the field (edge, not state).
      for (const role of GUILD_ROLES) {
        const s = shareOf(role);
        const prev = this.lastShare[role] ?? 0;
        if (this.chartered.includes(role) && prev < this.cfg.shareP && s >= this.cfg.shareP) {
          this.counts.monopolies++;
          this.pending.monopoly = { role, share: Math.round(s * 100) };
          break;
        }
        this.lastShare[role] = s;
      }
      for (const role of GUILD_ROLES) this.lastShare[role] = shareOf(role);
    }

    // Read-out closes on the END-of-round truth (the historian and the drawer read signals() post-round).
    this.lastRoster = GUILD_ROLES.map((role) => ({ role, members: members[role], share: round3(shareOf(role)) }));
    this.pending.roster = this.lastRoster.map((r) => ({ ...r }));
    this.pending.counts = { ...this.counts };
  }

  signals(): GuildsSignals { return this.pending; }

  // ─── persistence (bounded, additive) ───────────────────────────────────────────────────────────────

  serialize(): string {
    return JSON.stringify({
      v: GUILDS_VERSION,
      chartered: this.chartered,
      lastShare: this.lastShare,
      counts: this.counts,
    });
  }

  restore(blob: unknown): void {
    this.adopted = false;   // ALWAYS re-adopt silently: the lastProf map is memory, not ledger
    if (typeof blob !== "string" || !blob) return;
    try {
      const p = JSON.parse(blob);
      if (!p || typeof p !== "object") return;
      const num = (x: unknown, d: number) => (Number.isFinite(Number(x)) ? Math.floor(Number(x)) : d);
      const c = p.counts ?? {};
      this.counts = { charters: num(c.charters, 0), pacts: num(c.pacts, 0), monopolies: num(c.monopolies, 0) };
      if (Array.isArray(p.chartered)) {
        const seen = new Set<string>();
        this.chartered = p.chartered
          .filter((r: unknown) => typeof r === "string" && (GUILD_ROLES as readonly string[]).includes(r))
          .filter((r: string) => (seen.has(r) ? false : (seen.add(r), true)))
          .slice(0, GUILD_ROLES.length);
      }
      if (p.lastShare && typeof p.lastShare === "object") {
        const next: Record<string, number> = {};
        for (const role of GUILD_ROLES) {
          const v = Number((p.lastShare as Record<string, unknown>)[role]);
          next[role] = Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : 0;
        }
        this.lastShare = next;
      }
    } catch { /* corrupt → keep defaults: an empty guildhall, never a poisoned ledger */ }
  }
}
