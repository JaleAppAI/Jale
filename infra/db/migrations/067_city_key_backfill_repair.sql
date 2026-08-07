-- 067_city_key_backfill_repair.sql
-- (Applied to production pre-merge as 063_city_key_backfill_repair.sql.)
-- Re-runs BOTH data backfills from 065 (applied pre-merge as 061), which silently updated 0 rows:
-- jobs and worker_profiles are FORCE ROW LEVEL SECURITY (003), their
-- policies key on app.current_user_id, and the bastion migration runner
-- (jale_admin, NOBYPASSRLS per 020b) never sets that var -- so every
-- USING clause evaluated to NULL and both UPDATEs matched nothing.
--
-- Fix: the repo's established helper-role pattern (036/038) -- a NOLOGIN
-- role with USING (true) policies, assumed via SET ROLE for the duration
-- of the repair. The UPDATE policies are dropped afterwards (one-shot);
-- the SELECT policy on jobs is kept so ops can run the monitoring query:
--
--   SET ROLE jale_location_backfill;
--   SELECT count(*) FROM jobs WHERE status = 'active' AND city_key IS NULL;
--   RESET ROLE;
--
-- (As plain jale_admin that query reads 0 forever -- RLS, not truth.)
--
-- Run AFTER 066_preferred_cities_whatsapp_read.sql, connected as
-- jale_admin (NOT the RDS master user). Forward-only (ADR-005).

BEGIN;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'jale_location_backfill') THEN
    CREATE ROLE jale_location_backfill
      NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS;
  END IF;
END;
$$;

GRANT USAGE ON SCHEMA public TO jale_location_backfill;
GRANT SELECT, UPDATE ON jobs TO jale_location_backfill;
GRANT SELECT, UPDATE ON worker_profiles TO jale_location_backfill;

DROP POLICY IF EXISTS jobs_location_backfill_select ON jobs;
CREATE POLICY jobs_location_backfill_select
  ON jobs FOR SELECT TO jale_location_backfill USING (true);
DROP POLICY IF EXISTS jobs_location_backfill_update ON jobs;
CREATE POLICY jobs_location_backfill_update
  ON jobs FOR UPDATE TO jale_location_backfill USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS worker_profiles_location_backfill_select ON worker_profiles;
CREATE POLICY worker_profiles_location_backfill_select
  ON worker_profiles FOR SELECT TO jale_location_backfill USING (true);
DROP POLICY IF EXISTS worker_profiles_location_backfill_update ON worker_profiles;
CREATE POLICY worker_profiles_location_backfill_update
  ON worker_profiles FOR UPDATE TO jale_location_backfill USING (true) WITH CHECK (true);

GRANT jale_location_backfill TO jale_admin WITH SET TRUE, INHERIT FALSE;

SET ROLE jale_location_backfill;

-- 1) City backfill: identical parse to 065 section 2 (kept in sync with
--    parseCityFromLocation in infra/lambda/lib/city-fields.ts).
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

-- 2) map_pin confidence rewrite: identical to 065 section 4, same rationale
--    (see that migration's comments); location_updated_at deliberately untouched.
UPDATE worker_profiles
SET location_source     = 'geocoded_address',
    location_confidence = 70
WHERE location_source = 'map_pin';

RESET ROLE;

-- One-shot repair: revoke write access; keep the jobs SELECT policy + role
-- membership for the monitoring query documented above.
DROP POLICY IF EXISTS jobs_location_backfill_update ON jobs;
DROP POLICY IF EXISTS worker_profiles_location_backfill_update ON worker_profiles;
DROP POLICY IF EXISTS worker_profiles_location_backfill_select ON worker_profiles;
REVOKE UPDATE ON jobs FROM jale_location_backfill;
REVOKE SELECT, UPDATE ON worker_profiles FROM jale_location_backfill;

COMMIT;
