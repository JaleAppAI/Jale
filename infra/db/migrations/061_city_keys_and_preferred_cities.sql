-- 061_city_keys_and_preferred_cities.sql
-- Canonical city identity for job/worker matching, plus the worker's chosen
-- cities. Run AFTER 060_trade_aliases.sql, connected as jale_admin (NOT the
-- RDS master user).
--
--   city_key = lower(city) with non-alphanumerics collapsed to '-',
--              trimmed of leading/trailing '-', then '-' + lower(state).
--   Examples: 'El Paso'/'TX' -> 'el-paso-tx'; "Coeur d'Alene"/'ID' ->
--             'coeur-d-alene-id'; 'Winston-Salem'/'NC' -> 'winston-salem-nc'.
--
-- The same rule is implemented in frontend/src/lib/location-search.ts
-- (slugCityKey) and infra/lambda/lib/city-fields.ts. Keep all three in sync:
-- a drift in any one of them silently partitions the feed, because a worker's
-- stored city_key would no longer equal the job's.
--
-- The columns added here are independent of the coordinate columns added by
-- 009_location_foundation.sql and of its completeness CHECK constraints.
--
-- Forward-only. Applied manually via bastion (ADR-005).

BEGIN;

-- ---------------------------------------------------------------------------
-- 1) Jobs: normalized city columns
-- ---------------------------------------------------------------------------
-- Nullable on purpose: `location` is free text and pre-existing rows are not
-- guaranteed to parse. An unparseable row keeps a NULL city_key and simply
-- never matches a city filter, which is the safe failure -- the alternative
-- (guessing) would surface jobs in the wrong city's feed.
--
-- jobs is granted at table level (003/004/010/035), so the new columns are
-- covered by the existing jale_admin / jale_matching / jale_whatsapp grants.
ALTER TABLE jobs
  ADD COLUMN IF NOT EXISTS city_key TEXT,
  ADD COLUMN IF NOT EXISTS city     TEXT,
  ADD COLUMN IF NOT EXISTS state    TEXT CHECK (state ~ '^[A-Z]{2}$');

-- The feed only ever filters city_key among live jobs, so the index is partial
-- on status = 'active' and stays small as closed jobs accumulate.
CREATE INDEX IF NOT EXISTS idx_jobs_city_key_active
  ON jobs (city_key)
  WHERE status = 'active';

-- ---------------------------------------------------------------------------
-- 2) Backfill from the existing free-text location
-- ---------------------------------------------------------------------------
-- Best-effort parse of "City, ST" and "City, ST 12345[-6789]". Anything else
-- (no comma, a full state name, a bare ZIP) is left NULL rather than guessed.
WITH parsed AS (
  SELECT id, m[1] AS city, upper(m[2]) AS state
  FROM (
    SELECT id,
           regexp_match(location, '^\s*([A-Za-z][A-Za-z .''-]*?)\s*,\s*([A-Za-z]{2})(?:\s+\d{5}(?:-\d{4})?)?\s*$') AS m
    FROM jobs
    WHERE city_key IS NULL
  ) x
  WHERE m IS NOT NULL
)
UPDATE jobs j
SET city     = p.city,
    state    = p.state,
    city_key = trim(BOTH '-' FROM lower(regexp_replace(p.city, '[^a-zA-Z0-9]+', '-', 'g')))
               || '-' || lower(p.state)
FROM parsed p
WHERE j.id = p.id;

-- ---------------------------------------------------------------------------
-- 3) Worker preferred cities
-- ---------------------------------------------------------------------------
-- The per-worker cap (10) is enforced by the API, not here: the limit is a
-- product rule that will move, and a CHECK/trigger on a composite-PK table
-- would cost a count on every insert.
CREATE TABLE IF NOT EXISTS worker_preferred_cities (
  user_id    UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  city_key   TEXT NOT NULL,
  city       TEXT NOT NULL,
  state      TEXT NOT NULL CHECK (state ~ '^[A-Z]{2}$'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (user_id, city_key)
);

GRANT SELECT, INSERT, UPDATE, DELETE ON worker_preferred_cities TO jale_admin;

ALTER TABLE worker_preferred_cities ENABLE ROW LEVEL SECURITY;
ALTER TABLE worker_preferred_cities FORCE ROW LEVEL SECURITY;

-- Same shape as employer_profiles_self (016): a worker reaches only their own
-- rows, on both read and write, resolved through cognito_sub.
CREATE POLICY worker_preferred_cities_self
  ON worker_preferred_cities FOR ALL
  USING (
    user_id = (
      SELECT id FROM users
      WHERE cognito_sub = current_setting('app.current_user_id', true)
        AND user_type = 'worker'
    )
  )
  WITH CHECK (
    user_id = (
      SELECT id FROM users
      WHERE cognito_sub = current_setting('app.current_user_id', true)
        AND user_type = 'worker'
    )
  );

-- ---------------------------------------------------------------------------
-- 4) Retire the phantom 'map_pin' worker locations
-- ---------------------------------------------------------------------------
-- No worker has ever dropped a map pin: the profile PATCH handler hard-coded
-- source = 'map_pin' for every coordinate it received, whatever the client had
-- actually done to obtain it. Those rows therefore sit at confidence 100, the
-- top of the setWorkerCoordinates precedence ladder, while the honest sources
-- the handler now sends top out at 70 (geocoded_address) and 30
-- (geocoded_zip). Left alone, the stale value outranks every correction for a
-- week and the worker's re-entered location silently no-ops.
--
-- Rewriting them to 'geocoded_address'/70 restores the truth (an address the
-- client geocoded) and lets a fresh geocode of equal confidence win via the
-- `$5 >= location_confidence` arm. location_updated_at is deliberately NOT
-- touched: the coordinates themselves are unchanged and still as old as they
-- were, so the 7-day staleness escape hatch must keep measuring from the
-- original write.
UPDATE worker_profiles
SET location_source     = 'geocoded_address',
    location_confidence = 70
WHERE location_source = 'map_pin';

COMMIT;
