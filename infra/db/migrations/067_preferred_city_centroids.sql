-- 067_preferred_city_centroids.sql
-- (Applied to production pre-merge as 064_preferred_city_centroids.sql.)
-- City centroids for the worker's preferred cities, so distance scoring can
-- anchor on every chosen city, not just the single worker_profiles
-- coordinate. Mirrors 009's coordinate conventions (NUMERIC(9,6), range
-- CHECKs, both-or-neither completeness). Nullable: pre-064 rows and
-- degraded-picker saves have no coordinates and degrade to prior scoring.
--
-- Existing table-level grants (064: jale_admin; 065: jale_whatsapp SELECT)
-- cover new columns automatically; no policy changes.
--
-- Run AFTER 066_city_key_backfill_repair.sql, connected as jale_admin
-- (NOT the RDS master user). Forward-only (ADR-005).

BEGIN;

ALTER TABLE worker_preferred_cities
  ADD COLUMN IF NOT EXISTS latitude  NUMERIC(9,6) CHECK (latitude  BETWEEN  -90 AND  90),
  ADD COLUMN IF NOT EXISTS longitude NUMERIC(9,6) CHECK (longitude BETWEEN -180 AND 180);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'worker_preferred_cities_coords_complete'
  ) THEN
    ALTER TABLE worker_preferred_cities
      ADD CONSTRAINT worker_preferred_cities_coords_complete
      CHECK ((latitude IS NULL) = (longitude IS NULL));
  END IF;
END;
$$;

COMMIT;
