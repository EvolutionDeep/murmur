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
