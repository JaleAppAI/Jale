-- 061_job_geo_and_seo_grants.sql
-- Adds employer-facing city/state_region columns to jobs for the public job
-- page and its JSON-LD structured data (jobLocation.address), and extends
-- jale_public_jobs' column-scoped read grant (055/058 pattern) to cover them.
--
-- Backfill is deliberately NOT inline SQL here. jobs.location (009) is free
-- text ("Austin, TX", "Remote", etc.) with no reliable in-database parse into
-- discrete city/state_region values; a one-shot UPDATE at migration time
-- cannot be reviewed, re-run, or partially retried the way an operator script
-- can. The backfill is scripts/backfill-job-geo.ts (built by another task) --
-- this migration only adds the columns and the read grant it needs.
--
-- No valid_through column by design: the JSON-LD render path computes a
-- render-time backstop for validThrough (e.g. derived from the job's own
-- freshness/status) rather than persisting a stored expiry -- there is no
-- product requirement for a DB-tracked expiry state, and adding one here
-- would be speculative.
--
-- Forward-only. Applied manually via bastion (ADR-005).
BEGIN;

ALTER TABLE jobs
    ADD COLUMN IF NOT EXISTS city TEXT,
    ADD COLUMN IF NOT EXISTS state_region TEXT;

ALTER TABLE jobs DROP CONSTRAINT IF EXISTS jobs_state_region_format_check;
ALTER TABLE jobs
    ADD CONSTRAINT jobs_state_region_format_check
    CHECK (state_region IS NULL OR state_region ~ '^[A-Z]{2}$');

COMMENT ON COLUMN jobs.city IS
    'Employer/backfill-supplied city for the public job page and JSON-LD jobLocation. Populated by scripts/backfill-job-geo.ts, not by this migration.';
COMMENT ON COLUMN jobs.state_region IS
    'Two-letter region/state code (e.g. US state abbreviation). NULL until backfilled or entered by the employer.';

-- Column-scoped extension of the public read grant (055/058 pattern): only
-- the three columns the public job page/JSON-LD need, nothing else on jobs.
GRANT SELECT (city, state_region, updated_at) ON jobs TO jale_public_jobs;

COMMIT;
