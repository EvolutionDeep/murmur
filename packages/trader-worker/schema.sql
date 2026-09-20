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
  top_states  TEXT                        -- JSON of the full behavioural-state histogram
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
