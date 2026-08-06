-- 061_job_geo_and_seo_grants.sql
-- Adds employer-facing city/state_region columns to jobs for the public job
-- page and its JSON-LD structured data (jobLocation.address), and extends
-- jale_public_jobs' column-scoped read grant (055/058 pattern) to cover them.
--
-- The BACKFILL LOGIC (parsing jobs.location free text into discrete
-- city/state_region values) is deliberately NOT inline SQL here. jobs.location
-- (009) is free text ("Austin, TX", "Remote", etc.) with no reliable
-- in-database parse; a one-shot UPDATE at migration time cannot be reviewed,
-- re-run, or partially retried the way an operator script can. That parse
-- logic lives in scripts/backfill-job-geo.ts (infra/lambda/lib/job-location-parse.ts).
--
-- This migration DOES add the two SECURITY DEFINER functions that script
-- needs to reach jobs at all, though -- see the section below. Without them,
-- the script (which connects as jale_admin with no app.current_user_id GUC
-- set) would run under jobs' owner-keyed RLS policies (003) and see/affect
-- zero rows, exactly the bug this migration exists to fix.
--
-- No valid_through column by design: the JSON-LD render path computes a
-- render-time backstop for validThrough (e.g. derived from the job's own
-- freshness/status) rather than persisting a stored expiry -- there is no
-- product requirement for a DB-tracked expiry state, and adding one here
-- would be speculative.
--
-- Forward-only. Applied manually via bastion (ADR-005).
--
-- AMENDED IN PLACE (not a new forward migration): this migration is new on
-- this branch and has never been applied to any real database, so it falls
-- under the one documented exception to the forward-only rule. The geo
-- backfill functions below were added in the same amendment that introduced
-- them as a requirement, rather than as 064+.
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

-- ---------------------------------------------------------------------------
-- Geo backfill access: SECURITY DEFINER functions gated by a transaction-
-- local capability flag, following migration 062's documented pattern.
--
-- jobs is ENABLE+FORCE ROW LEVEL SECURITY (migration 003), with
-- jobs_employer_select/insert/update keyed on
-- employer_id = (SELECT id FROM users WHERE cognito_sub = current_setting
-- ('app.current_user_id', true)) -- i.e. they resolve to false for every row
-- when no RLS context is set. scripts/backfill-job-geo.ts connects as
-- jale_admin with no Cognito sub (it is an operator script, not a
-- request-scoped Lambda), so a bare SECURITY DEFINER function here would hit
-- exactly the hazard 062's header describes: FORCE RLS removes the
-- owner-bypass exemption even inside a SECURITY DEFINER function owned by
-- the table's owner (jale_admin owns jobs, same as it owns
-- job_visibility_events). A SELECT would silently return zero rows; an
-- UPDATE would silently affect zero rows (062's "silent zero-row" hazard
-- class, which -- unlike INSERT's WITH CHECK failure -- applies to exactly
-- this UPDATE/SELECT shape).
--
-- The fix is the same capability-flag mechanism 062 used for INSERT, applied
-- here to SELECT and UPDATE instead: each function sets a transaction-local
-- GUC immediately before touching jobs, and two narrow permissive policies
-- (scoped TO jale_admin, same role the existing 003/038 policies target)
-- require that GUC. These policies are ADDITIONAL permissive policies -- for
-- the same command and role, Postgres ORs permissive policies together --
-- so the existing employer-scoped behavior for real request-scoped RLS
-- contexts is unaffected; the new policy only ever admits rows when the flag
-- is on, which only these two functions ever set.
-- ---------------------------------------------------------------------------
CREATE POLICY jobs_geo_backfill_read ON jobs
    FOR SELECT TO jale_admin
    USING (current_setting('jale.job_geo_backfill', true) = 'on');

CREATE POLICY jobs_geo_backfill_write ON jobs
    FOR UPDATE TO jale_admin
    USING     (current_setting('jale.job_geo_backfill', true) = 'on')
    WITH CHECK (current_setting('jale.job_geo_backfill', true) = 'on');

CREATE OR REPLACE FUNCTION list_jobs_missing_geo()
RETURNS TABLE(id UUID, location TEXT)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
    -- is_local = true: scoped to the current transaction only (062's same
    -- rationale) -- the capability never leaks into a later, unrelated
    -- transaction on a pooled connection.
    PERFORM set_config('jale.job_geo_backfill', 'on', true);
    RETURN QUERY
      SELECT jobs.id, jobs.location
        FROM jobs
       WHERE jobs.city IS NULL
         AND jobs.location IS NOT NULL;
END;
$$;

REVOKE ALL ON FUNCTION list_jobs_missing_geo() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION list_jobs_missing_geo() TO jale_admin;

CREATE OR REPLACE FUNCTION set_job_geo(
    p_job_id UUID,
    p_city   TEXT,
    p_state  TEXT
) RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_updated BOOLEAN;
BEGIN
    -- Re-validated here, not just trusted from the caller: this function is
    -- the only write path city/state_region has for the backfill script, so
    -- it must enforce the same invariants the jobs_state_region_format_check
    -- CHECK constraint above enforces for every other write path.
    IF p_city IS NULL OR btrim(p_city) = '' THEN
        RAISE EXCEPTION 'set_job_geo: p_city must be a non-empty string';
    END IF;
    IF p_state IS NULL OR p_state !~ '^[A-Z]{2}$' THEN
        RAISE EXCEPTION 'set_job_geo: p_state must be a 2-letter uppercase code, got %', p_state;
    END IF;

    PERFORM set_config('jale.job_geo_backfill', 'on', true);
    -- AND city IS NULL preserves the original script's clobber guard: two
    -- overlapping backfill runs, or an employer setting city via the Edit
    -- modal between this job being listed and this call, must never
    -- overwrite a value someone else already set. The return value doubles
    -- as "did THIS call set it" -- false means either the id doesn't exist
    -- or someone else's value already won the race.
    UPDATE jobs SET city = p_city, state_region = p_state
     WHERE id = p_job_id AND city IS NULL;
    v_updated := FOUND;
    RETURN v_updated;
END;
$$;

REVOKE ALL ON FUNCTION set_job_geo(UUID, TEXT, TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION set_job_geo(UUID, TEXT, TEXT) TO jale_admin;

COMMIT;
