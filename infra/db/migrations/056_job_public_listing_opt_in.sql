-- 056_job_public_listing_opt_in.sql
-- Public job listing becomes OPT-IN.
--
-- Migration 055 added public_listing_enabled with DEFAULT true, and nothing in
-- the product ever wrote the column. Applying 055 plus the public route would
-- therefore have made every existing job's title, company, location,
-- description and pay readable by anyone, with no employer consent step and no
-- way to switch it off outside direct SQL against production. Existing
-- employers never agreed to that, so every current row is set false and new
-- jobs start private. The write path is a dedicated single-field endpoint,
-- PATCH /employer/jobs/{jobId}/public-listing, ownership-scoped by the
-- existing jobs_employer_update policy.
--
-- Forward-only. Applied manually via bastion (ADR-005). Must be applied BEFORE
-- the public route is deployed, or every existing job is briefly public.

BEGIN;

ALTER TABLE jobs ALTER COLUMN public_listing_enabled SET DEFAULT false;

-- Nobody consented, so nobody is opted in.
UPDATE jobs SET public_listing_enabled = false WHERE public_listing_enabled;

-- Supports the visitor de-duplication probe in public-job.ts, which filters on
-- (visitor_hash, job_id, opened_at) to decide whether an arrival is a repeat
-- rather than a new open. Without it that probe is a sequential scan over a
-- table that grows with every public page view.
CREATE INDEX IF NOT EXISTS job_share_opens_visitor_dedupe_idx
    ON job_share_opens (visitor_hash, job_id, opened_at DESC)
    WHERE visitor_hash IS NOT NULL;

COMMENT ON COLUMN jobs.public_listing_enabled IS
    'Employer opt-IN to a public job page. Default false: a job is private until the employer chooses to publish it. Written only by PATCH /employer/jobs/{jobId}/public-listing.';

COMMIT;
