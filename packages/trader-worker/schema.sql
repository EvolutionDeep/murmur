-- murmur D1 archival schema.
--
-- One row per cron tick: the long-term history that the DO's in-memory snapshot and the frontend's
-- canvas cannot keep. This is what unlocks historical curves, "since launch" statistics, research
-- export and competition-verifiable history. Written best-effort from FlyStateDO.archiveTick() —
-- a D1 failure never blocks the tick (see state.ts). `CREATE TABLE IF NOT EXISTS` keeps this idempotent
-- so it is safe to re-run remotely AND is mirrored lazily in code before the first insert.

CREATE TABLE IF NOT EXISTS ticks (
  tick        INTEGER PRIMARY KEY,        -- population tickIndex at the end of this cron
  ts          INTEGER NOT NULL,           -- unix ms when the cron archived the row
  temperature REAL    NOT NULL,           -- market temperature 0..1 felt this tick
  regime      TEXT    NOT NULL,           -- HOT | CALM | COLD
  size        INTEGER,                    -- flies alive
  deals       INTEGER,                    -- settlements that succeeded THIS cron (netting flushes included)
  settlements INTEGER,                    -- lifetime cumulative successful settlements
  volume_usdc REAL,                       -- lifetime cumulative settled volume (USDC)
  gini        REAL,                       -- wealth concentration 0..1 (emergent from neural diversity)
  top_state   TEXT,                       -- dominant behavioural state this tick
  top_states  TEXT,                       -- JSON of the full behavioural-state histogram
  -- R5 Fix F (#126) ADDITIVE columns (observability debt): the live netting backlog gauge + the lifetime
  -- mirror-drift telemetry. Additive-only — never rewrites/drops an existing column. Already-live tables
  -- gain these in place via the idempotent ALTER migration in state.ts#ensureD1Schema / history.ts (SQLite
  -- has no ADD COLUMN IF NOT EXISTS, so a duplicate-column error is swallowed there). Old rows read NULL.
  net_pending            INTEGER,         -- pair-nets folded and awaiting broadcast at this cron (totals.netPending)
  net_pending_trades     INTEGER,         -- gross trades folded into those pending nets (totals.netPendingTrades)
  mirror_drift_atomic_sum TEXT            -- lifetime Σ|internal-mirror − on-chain| atomic (totals.mirrorDriftAtomicSum; "0"/NULL while Fix B off)
);

-- Time-range scans for the frontend history curve and research export.
CREATE INDEX IF NOT EXISTS idx_ticks_ts ON ticks (ts);

-- ============================================================================================
-- The chronicle (a deterministic historian's narrative timeline). Written once per detected event
-- by FlyStateDO.observeChronicle → writeChronicle, best-effort (a D1 failure never blocks the tick).
-- Served at GET /annals from the DO's hot ring buffer (last 300 entries) with D1 as cold archive.
-- PURE READ-OUT: the historian never mutates a brain, wallet or settlement — the manifestHash and
-- on-chain footprint are unchanged by anything written here. `seq` is the DO-monotonic ordinal.
-- ============================================================================================

CREATE TABLE IF NOT EXISTS chronicle (
  seq       INTEGER PRIMARY KEY,        -- DO-monotonic ordinal across the whole history
  tick      INTEGER NOT NULL,           -- population tickIndex when this was detected
  ts        INTEGER NOT NULL,           -- unix ms of detection
  kind      TEXT    NOT NULL,           -- ERA_OPEN|ERA_SHIFT|FIRST_TRADE|MILESTONE|BIRTH|PANIC|STORM|HUDDLE|FEAST|RECORD_CONC|LEAD_CHANGE
  era       INTEGER NOT NULL,           -- era index at time of writing
  era_name  TEXT    NOT NULL,           -- evocative name of that era ("the Long Frost", …)
  severity  INTEGER NOT NULL,           -- 1 minor | 2 notable | 3 chapter-defining
  actors    TEXT    NOT NULL,           -- JSON number[] of implicated fly ids (may be [])
  text      TEXT    NOT NULL,           -- the rendered narrative line (template, no LLM)
  metrics   TEXT,                       -- JSON object of the raw numbers behind the sentence
  tokens    TEXT,                       -- JSON object of the exact template substitution values (re-derives text)
  hash      TEXT,                       -- sha256(canonical(entryCore ‖ prevHash)) — binds this line to the chain
  prev_hash TEXT                        -- hash of the previous entry (64 zeros for the founding line)
);
CREATE INDEX IF NOT EXISTS idx_chronicle_ts ON chronicle (ts);

-- ============================================================================================
-- The Laureate (⑮): the swarm's own poet. Every poem the laureate composes is archived here so the
-- collection is PERMANENT — the DO only keeps a hot ring (POEMS_CAP) for the live chain head, while D1
-- holds every poem ever written. Written best-effort from FlyStateDO.archivePoem() the moment a poem is
-- composed; a D1 failure never blocks the tick. PURE READ-OUT: archiving a poem changes no brain, wallet
-- or settlement (manifestHash / chroniclerHash unchanged). `entry` is the full PoemEntry JSON, so anyone
-- can recompute its receipt hash and replay it against the public grammar (see /poem/archive).
-- ============================================================================================

CREATE TABLE IF NOT EXISTS poems (
  seq         INTEGER PRIMARY KEY,        -- monotonic poem ordinal (1-based; matches the DO chain)
  tick        INTEGER NOT NULL,           -- swarm tickIndex this poem was composed at
  ts          INTEGER NOT NULL,           -- unix ms when archived (metadata only; NOT part of the receipt)
  era         INTEGER NOT NULL,           -- era ordinal at composition
  era_name    TEXT    NOT NULL,           -- evocative era name ("the Golden Age", …)
  phase       TEXT,                       -- civilization phase (golden|ascendant|declining|dark)
  laureate_id INTEGER,                    -- the crowned poet's fly id (null if none was live)
  hash        TEXT    NOT NULL,           -- poemReceiptHash(entry) — binds this poem to the /poem chain
  prev_hash   TEXT,                       -- the previous poem's hash ("" for the genesis poem)
  entry       TEXT    NOT NULL            -- the full PoemEntry JSON (recompute + replay source of truth)
);
CREATE INDEX IF NOT EXISTS idx_poems_ts ON poems (ts);

-- ============================================================================================
-- Community governance page (off-chain, token-gated forum + weighted voting). Served at
-- muros.live/community; the /community* API is handled in the Worker's fetch (see src/community.ts)
-- and stores here. These tables are created lazily in code (ensureCommunitySchema) AND mirrored here
-- so `wrangler d1 execute murmur-db --remote --file=./schema.sql` provisions them up-front. The feature
-- is READ-ONLY on-chain (a balanceOf gate) and never moves funds.
-- ============================================================================================

-- Plaza posts + proposal replies. proposal_id IS NULL ⇒ a top-level plaza post; non-null ⇒ a reply under
-- that proposal. author_bal is the poster's MURMUR balanceOf snapshot at post time (raw 18dp decimal
-- string) so the feed can display weight without a live chain read per row. sig is UNIQUE ⇒ an exact
-- EIP-712 replay of the same action is rejected as a duplicate (idempotent).
CREATE TABLE IF NOT EXISTS community_posts (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  author      TEXT    NOT NULL,             -- lowercased 0x…40 poster address (== the recovered signer)
  body        TEXT    NOT NULL,             -- post/reply text (<= 4000 chars)
  proposal_id INTEGER,                      -- NULL = plaza post; else the proposal this replies to
  author_bal  TEXT    NOT NULL,             -- MURMUR balanceOf(author) at post time (raw decimal string)
  ts          INTEGER NOT NULL,             -- client-signed unix ms (validated within ±300s of server time)
  sig         TEXT    NOT NULL UNIQUE       -- EIP-712 Post signature (replay guard)
);
CREATE INDEX IF NOT EXISTS idx_community_posts_ts ON community_posts (ts);
CREATE INDEX IF NOT EXISTS idx_community_posts_proposal ON community_posts (proposal_id);

-- Proposals. deadline = ts-created + COMMUNITY_PROPOSAL_WINDOW_HOURS; open while now < deadline. sig UNIQUE.
CREATE TABLE IF NOT EXISTS community_proposals (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  author     TEXT    NOT NULL,              -- lowercased 0x…40 proposer (must hold >= COMMUNITY_PROPOSE_MIN)
  title      TEXT    NOT NULL,              -- <= 200 chars
  body       TEXT    NOT NULL,              -- <= 4000 chars
  author_bal TEXT    NOT NULL,              -- MURMUR balanceOf(author) at creation (raw decimal string)
  deadline   INTEGER NOT NULL,              -- unix ms after which voting closes
  ts         INTEGER NOT NULL,              -- client-signed unix ms
  sig        TEXT    NOT NULL UNIQUE        -- EIP-712 Propose signature (replay guard)
);
CREATE INDEX IF NOT EXISTS idx_community_proposals_ts ON community_proposals (ts);

-- Weighted votes. PK (proposal_id, voter) ⇒ one voter per proposal; INSERT OR REPLACE lets a holder change
-- their vote (latest wins). choice 0=against / 1=for / 2=abstain; weight = MURMUR balanceOf(voter) at vote
-- time (raw decimal string). Tallies are aggregated in JS with BigInt (D1 has no bigint SUM).
CREATE TABLE IF NOT EXISTS community_votes (
  proposal_id INTEGER NOT NULL,
  voter       TEXT    NOT NULL,             -- lowercased 0x…40 voter (must hold >= COMMUNITY_SPEAK_MIN)
  choice      INTEGER NOT NULL,             -- 0 against | 1 for | 2 abstain
  weight      TEXT    NOT NULL,             -- MURMUR balanceOf(voter) at vote time (raw decimal string)
  ts          INTEGER NOT NULL,             -- client-signed unix ms
  sig         TEXT    NOT NULL,             -- EIP-712 Vote signature (a re-vote replaces the row)
  PRIMARY KEY (proposal_id, voter)
);

-- Append-only vote-event log. community_votes keeps ONLY each voter's current ballot (INSERT OR REPLACE), which
-- is enough for the live tally but erases history. This table records EVERY vote and re-vote as an immutable event
-- so GET /community/timeline can rebuild the point-in-time cumulative curve and the per-proposal tally graph —
-- i.e. a late, large swing by a whale is visible on the chart instead of silently overwriting the outcome.
-- recorded_at is server time (stable ordering); ts is the client-signed time. sig UNIQUE ⇒ replay-safe.
CREATE TABLE IF NOT EXISTS community_vote_events (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  proposal_id INTEGER NOT NULL,
  voter       TEXT    NOT NULL,             -- lowercased 0x…40 voter
  choice      INTEGER NOT NULL,             -- 0 against | 1 for | 2 abstain
  weight      TEXT    NOT NULL,             -- MURMUR balanceOf(voter) at that vote (raw decimal string)
  ts          INTEGER NOT NULL,             -- client-signed unix ms
  recorded_at INTEGER NOT NULL,             -- server unix ms when the worker accepted the vote
  sig         TEXT    NOT NULL UNIQUE       -- EIP-712 Vote signature (a re-vote re-signs with a fresh ts)
);
CREATE INDEX IF NOT EXISTS idx_community_vote_events_proposal ON community_vote_events (proposal_id, recorded_at);

-- ============================================================================================
-- P0.3 — Economy era snapshots (the measurement/replay bedrock). ONE row per CLOSED era: the
-- economy.serialize() blob captured at that era's OPEN (the replay seed state) plus the per-cron market
-- temperatures felt DURING the era (the pulse stream). GET /replay/economy re-runs a blob along its recorded
-- pulse stream to reproduce that era's economic trajectory byte-for-byte (see src/economyReplay.ts). Written
-- best-effort from FlyStateDO.trackEraSnapshot() the moment the historian's era index advances; a D1 failure
-- never blocks the tick. PURE READ-OUT archival: it changes no brain, wallet, digest or manifestHash, and the
-- blob is the SAME additive `economy:v1` payload the DO already persists (KEY_VERSION never bumped).
-- `CREATE TABLE IF NOT EXISTS` keeps this idempotent (safe to re-run remotely) and is mirrored lazily in code
-- (ensureEconomySnapshotsSchema) before the first insert.
--   era       — the era that CLOSED (PRIMARY KEY: one snapshot per era; INSERT OR REPLACE is idempotent)
--   tick      — population tickIndex at the era boundary
--   ts        — wall-clock ms of archival (METADATA ONLY; never an input to the replay)
--   blob      — economy.serialize() captured at the era's OPEN (the replay seed state)
--   blob_hash — sha256(blob), tamper-evidence for the seed state
--   temps     — JSON number[] of the per-cron market temperatures recorded DURING the era (the pulse stream)
-- ============================================================================================

CREATE TABLE IF NOT EXISTS economy_snapshots (
  era       INTEGER PRIMARY KEY,
  tick      INTEGER NOT NULL,
  ts        INTEGER NOT NULL,
  blob      TEXT    NOT NULL,
  blob_hash TEXT    NOT NULL,
  temps     TEXT    NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_economy_snapshots_tick ON economy_snapshots (tick);

-- ============================================================================================
-- ㉓ The Lexicon's PERMANENT archive (task #107 — "record the invented words completely, accurately,
-- forever; they are the foundation of civilisation"). The lexicon membrane compiles a closed 20-word
-- dictionary BACKWARDS out of the chronicle's hot roll; the DO blob under `lexicon:v1` is its LIVE truth
-- (tombstones included, survives eviction AND reset). This table is the OFF-DO PERMANENT layer: EVERY
-- COINAGE / SPREAD / SILENCE edge the desk fires is appended here as ONE immutable row — NEVER UPDATEd,
-- NEVER DELETEd. Written best-effort from FlyStateDO.archiveLexiconEvents() (drained each cron) and
-- backfilled once from the persisted dictionary (backfillLexiconDictionary) so words coined before this
-- archive shipped are never lost; a D1 failure never blocks the tick AND is made observable on GET
-- /lexicon (archiveErrors). APPEND-ONLY idempotence: INSERT OR IGNORE on the UNIQUE(kind,event,tick) guard
-- means a retried cron is a no-op, never an overwrite of history. PURE READ-OUT: archiving a word changes
-- no brain, wallet, ledger or settlement (stateDigest / manifestHash / chroniclerHash all unchanged).
-- Served at GET /lexicon (paginated by id). `CREATE TABLE IF NOT EXISTS` keeps this idempotent (safe to
-- re-run remotely) and is mirrored lazily in code (ensureD1Lexicon) before the first insert.
--   event         — COINAGE (a word entered common tongue) | SPREAD (its lifetime tellings doubled) |
--                   SILENCE (it went unspoken for the dormancy gap and was tombstoned, not deleted)
--   uses          — ROLLING window tellings at the moment of the event (can shrink as the roll ages)
--   lifetime_uses — MONOTONE tellings since coinage (the honest "told N times" number, never shrinks)
--   gap           — silence gap in tellings (SILENCE rows only; 0 otherwise)
--   coined_by     — lead actor (fly id) of the telling that was newest when the word was coined (P2-2)
--   born          — the tick the word entered the lexicon
--   grammar_hash  — lexiconGrammarHash() at write time (anchors the word-list + thresholds that made it)
-- ============================================================================================

CREATE TABLE IF NOT EXISTS lexicon_events (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,   -- append order (the /lexicon pagination cursor)
  tick          INTEGER NOT NULL,                    -- swarm tickIndex when the edge fired
  ts            INTEGER NOT NULL,                    -- unix ms when archived (metadata only; NOT a decision input)
  era           INTEGER NOT NULL,                    -- era index at the moment of the event
  era_name      TEXT    NOT NULL,                    -- evocative era name ("the Golden Age", …)
  event         TEXT    NOT NULL,                    -- COINAGE | SPREAD | SILENCE
  kind          TEXT    NOT NULL,                    -- the chronicle kind the word was made from (FEUD, GOLDEN_AGE, …)
  word          TEXT    NOT NULL,                    -- the coined word itself ("feud", "golden age", …)
  uses          INTEGER NOT NULL,                    -- ROLLING window tellings at the event
  lifetime_uses INTEGER NOT NULL,                    -- MONOTONE lifetime tellings at the event
  gap           INTEGER NOT NULL,                    -- silence gap (SILENCE rows; else 0)
  coined_by     TEXT,                                -- lead actor fly id at coinage (null if none)
  born          INTEGER NOT NULL,                    -- tick the word entered the lexicon
  grammar_hash  TEXT    NOT NULL,                    -- lexiconGrammarHash() at write time
  UNIQUE (kind, event, tick)                         -- append-only idempotence guard (a retry never overwrites)
);
CREATE INDEX IF NOT EXISTS idx_lexicon_events_id ON lexicon_events (id);

-- ============================================================================================
-- Shadow-compare (#87 Phase 0) — append-only evidence of the baseline-vs-evolved decision diffs.
-- PURE READ-OUT: written best-effort from FlyStateDO.cronInner() via ctx.waitUntil (off the cron
-- await path); changes no brain, wallet, digest, manifestHash or DO blob. Served at GET /shadow
-- straight from D1 (never a DO round-trip). `CREATE TABLE IF NOT EXISTS` keeps this idempotent
-- and is mirrored lazily in code (ensureShadowSchema) before the first insert.
--   tick           — population tickIndex when the shadow ran
--   cron           — in-memory shadowCronCount (monotone within a DO lifetime)
--   buyer_id       — the fly whose drives produced this decision
--   seller_id_base — counterparty chosen by the BASELINE path (no evolution)
--   seller_id_evo  — counterparty chosen by the EVOLVED path (strategy+playbook+rules ON)
--   good_base/evo  — the good each path would buy
--   want_base/evo  — the drive strength each path sees (0..1)
--   amount_*       — atomic USDC string: baseline, evolved (pre-cap), evolved (post-cap)
--   cap_reason     — why the evolved amount was capped (empty if not capped)
--   tree_hash      — deterministic hash of (tick, buyerId, cronNum) for replay-verification
--   pb_*           — playbook state at decision time (confidence, amplifier, explore flag)
--   regime         — market regime (HOT/CALM/COLD)
--   temp_bucket    — temperature bucket 0..3
-- ============================================================================================

CREATE TABLE IF NOT EXISTS shadow_decisions (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  ts              INTEGER NOT NULL,
  tick            INTEGER NOT NULL,
  cron            INTEGER NOT NULL,
  buyer_id        INTEGER NOT NULL,
  seller_id_base  INTEGER NOT NULL,
  seller_id_evo   INTEGER NOT NULL,
  good_base       TEXT    NOT NULL,
  good_evo        TEXT    NOT NULL,
  want_base       REAL    NOT NULL,
  want_evo        REAL    NOT NULL,
  amount_base     TEXT    NOT NULL,
  amount_evo      TEXT    NOT NULL,
  amount_evo_cap  TEXT    NOT NULL,
  cap_reason      TEXT    NOT NULL DEFAULT '',
  tree_hash       TEXT    NOT NULL DEFAULT '',
  pb_confidence   REAL    NOT NULL DEFAULT 0.5,
  pb_amplifier    REAL    NOT NULL DEFAULT 0.75,
  pb_explore      INTEGER NOT NULL DEFAULT 0,
  regime          TEXT    NOT NULL DEFAULT 'CALM',
  temp_bucket     INTEGER NOT NULL DEFAULT 2
);
CREATE INDEX IF NOT EXISTS idx_shadow_decisions_tick ON shadow_decisions (tick);
CREATE INDEX IF NOT EXISTS idx_shadow_decisions_ts ON shadow_decisions (ts);
