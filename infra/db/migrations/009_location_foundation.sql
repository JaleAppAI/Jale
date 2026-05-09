-- ============================================================
-- 009_location_foundation.sql
-- Run manually AFTER 008_worker_skills.sql
-- Connect as: jale_admin (NOT the RDS master user)
-- ============================================================

-- Source precedence is enforced in Lambda:
-- worker map_pin > geocoded_address > geocoded_zip
-- job manual > geocoded unless the existing manual coordinates are stale.

ALTER TABLE worker_profiles
  ADD COLUMN latitude NUMERIC(9,6) CHECK (latitude BETWEEN -90 AND 90),
  ADD COLUMN longitude NUMERIC(9,6) CHECK (longitude BETWEEN -180 AND 180),
  ADD COLUMN location_source TEXT CHECK (location_source IN
    ('map_pin','geocoded_address','geocoded_zip')),
  ADD COLUMN location_confidence SMALLINT CHECK (location_confidence BETWEEN 0 AND 100),
  ADD COLUMN location_updated_at TIMESTAMPTZ,
  ADD CONSTRAINT worker_profiles_location_complete CHECK (
    (
      latitude IS NULL
      AND longitude IS NULL
      AND location_source IS NULL
      AND location_confidence IS NULL
      AND location_updated_at IS NULL
    )
    OR
    (
      latitude IS NOT NULL
      AND longitude IS NOT NULL
      AND location_source IS NOT NULL
      AND location_confidence IS NOT NULL
      AND location_updated_at IS NOT NULL
    )
  );

ALTER TABLE jobs
  ADD COLUMN latitude NUMERIC(9,6) CHECK (latitude BETWEEN -90 AND 90),
  ADD COLUMN longitude NUMERIC(9,6) CHECK (longitude BETWEEN -180 AND 180),
  ADD COLUMN location_source TEXT CHECK (location_source IN ('manual','geocoded')),
  ADD COLUMN location_updated_at TIMESTAMPTZ,
  ADD CONSTRAINT jobs_location_complete CHECK (
    (
      latitude IS NULL
      AND longitude IS NULL
      AND location_source IS NULL
      AND location_updated_at IS NULL
    )
    OR
    (
      latitude IS NOT NULL
      AND longitude IS NOT NULL
      AND location_source IS NOT NULL
      AND location_updated_at IS NOT NULL
    )
  );
