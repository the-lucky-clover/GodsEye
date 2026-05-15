-- God's Eye — D1 database schema
-- Apply with:  wrangler d1 execute godseye-db --file schema.sql --remote

-- ── TLE cache ────────────────────────────────────────────────────────────────
-- Individual TLE records from CelesTrak. The Worker inserts up to 5,000
-- records per hourly fetch and prunes records older than 24 hours.
-- Primary key is (name, fetched_at) so a re-fetch can use INSERT OR REPLACE.
CREATE TABLE IF NOT EXISTS tle_cache (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  name       TEXT    NOT NULL,
  line1      TEXT    NOT NULL,
  line2      TEXT    NOT NULL,
  fetched_at INTEGER NOT NULL   -- unix epoch seconds
);

CREATE INDEX IF NOT EXISTS idx_tle_name     ON tle_cache(name);
CREATE INDEX IF NOT EXISTS idx_tle_fetched  ON tle_cache(fetched_at);

-- ── Aircraft snapshots ────────────────────────────────────────────────────────
-- Optional: uncomment to persist aircraft positions for replay / analytics.
-- Free-tier write budget (100 k/day) supports ~1 write/s; at 15-second
-- poll intervals with thousands of aircraft this table fills quickly.
-- Only enable if you plan to implement a replay feature.

-- CREATE TABLE IF NOT EXISTS aircraft_snapshot (
--   icao24     TEXT    NOT NULL,
--   callsign   TEXT,
--   lat        REAL,
--   lon        REAL,
--   alt_m      REAL,
--   speed_kts  REAL,
--   heading    REAL,
--   squawk     TEXT,
--   updated_at INTEGER NOT NULL,
--   PRIMARY KEY (icao24, updated_at)
-- );
-- CREATE INDEX IF NOT EXISTS idx_ac_updated ON aircraft_snapshot(updated_at);
-- CREATE INDEX IF NOT EXISTS idx_ac_icao    ON aircraft_snapshot(icao24);
