-- 058_referral_open_dedupe_grant.sql
-- The open de-duplication guard in public-job.ts probes job_share_opens
-- (NOT EXISTS over visitor_hash/job_id/opened_at) before inserting, but
-- jale_public_jobs was only ever granted INSERT. In production every open was
-- dropped with "permission denied" while the page rendered fine -- the
-- never-fail-the-request guard swallowed it, so the only symptom was
-- open_count silently staying at zero (found in the first live smoke test,
-- 2026-07-31).
--
-- Two privileges were missing, both required by the statement's shape:
--   1. the NOT EXISTS probe reads visitor_hash/job_id/opened_at;
--   2. RETURNING id needs SELECT on id (an insert's RETURNING clause requires
--      read privilege on every column it returns).
-- Grant exactly those four columns, nothing more: the role still cannot read
-- share_code, device_kind or locale from other visitors' rows.
--
-- Forward-only. Applied manually via bastion (ADR-005).
BEGIN;

GRANT SELECT (id, visitor_hash, job_id, opened_at) ON job_share_opens TO jale_public_jobs;

CREATE POLICY job_share_opens_public_dedupe_read ON job_share_opens
    FOR SELECT TO jale_public_jobs USING (true);

COMMIT;
