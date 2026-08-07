-- 064_public_job_context_functions.sql
-- Two SECURITY DEFINER lookups for the public job page: "who referred you"
-- (worker first name / employer, never a full identity) and "who is the
-- employer" (company display name), reached from jale_public_jobs with no
-- Cognito context at all.
--
-- Both functions need to read tables that jale_public_jobs itself has no
-- grant on at all (users, employer_profiles) or only a narrow column-scoped
-- grant on (jobs) -- and jobs/users/employer_profiles all ENABLE+FORCE ROW
-- LEVEL SECURITY, so a bare SECURITY DEFINER body (even one owned by
-- jale_admin, the owner of every one of these tables) sees zero rows unless a
-- policy admits it. This follows the transaction-local capability-flag
-- pattern from 031/061/062: each function sets a GUC immediately before the
-- read, and a narrow permissive policy scoped TO jale_admin requires that GUC.
-- Only these definer functions ever set the flags, so normal jale_admin
-- request-scoped RLS (app.current_user_id-keyed policies) is unaffected --
-- permissive policies for the same command/role are OR'd together.
--
-- public_referrer_context(p_code, p_job_public_code):
--   Reads job_share_links via 059's job_share_links_claim_read policy
--   (`USING (revoked_at IS NULL)`, TO jale_admin) -- that policy already
--   admits any unrevoked row by exact code with no referrer predicate (a
--   share code is a capability token, per 059's header), so no new policy is
--   needed on job_share_links here. Reading jobs (to bind the code to the
--   specific job the caller is viewing, via public_code) and users (to
--   resolve the referring worker's first name) DO need new gated policies,
--   since neither table's existing policies admit a SECURITY DEFINER session
--   with no app.current_user_id set.
--
-- public_job_company(p_job_id):
--   Reads jobs (new jobs_company_lookup policy, same GUC as above) and
--   employer_profiles. employer_profiles already has a gated lookup policy
--   from migration 031 (employer_profiles_name_lookup, GUC
--   app.employer_name_lookup) built for exactly this shape -- reused
--   verbatim here rather than adding a second, redundant employer_profiles
--   policy.
--
-- users_referrer_name_lookup is the first policy the referral chain adds to
-- users -- 056's header states verbatim "No policy here is added to the
-- users table, and no new policy on jobs joins back to users." That note
-- guarded the 020b/038 recursion class, which requires a policy predicate
-- that READS ANOTHER TABLE (there: jobs/job_applications joined back into a
-- users policy). This predicate is a bare current_setting() read with no
-- table reference and no subquery, so it cannot participate in a policy
-- cycle; it is also SELECT-only and scoped TO jale_admin, not PUBLIC.
--
-- Both jale.* flags are TRANSACTION-local, not call-local (set_config's
-- is_local=true scopes to the transaction, not the function invocation): a
-- jale_admin caller that invokes either function mid-transaction keeps the
-- flag set (and therefore unrestricted SELECT on all of users/jobs) until
-- COMMIT or ROLLBACK -- the same residue 061's list_jobs_missing_geo()/
-- set_job_geo() already leave on jobs. Inert for the intended caller
-- (jale_public_jobs: its grants on these functions run as owner jale_admin
-- under SECURITY DEFINER, but jale_public_jobs itself has no grant of any
-- kind on users or employer_profiles -- pinned by migration 064's RLS test
-- (g)). A jale_admin request handler must not call these functions in the
-- middle of a transaction that also relies on employer-scoped RLS reads.
--
-- Neither function exposes anything beyond what the public job page already
-- shows in spirit: a first name (never a full name, phone, or user id) and a
-- company display string (never contact details). No referrer identity is
-- ever returned for an organic (unreferred) share -- the query yields zero
-- rows in that case, not a row with nulls.
--
-- Forward-only. Applied manually via bastion (ADR-005).
BEGIN;

-- ---------------------------------------------------------------------------
-- Gated read policies. Each is TO jale_admin, ADDITIONAL to that table's
-- existing permissive policies (Postgres ORs them), and inert outside the
-- two functions below -- no application path sets either GUC directly.
-- ---------------------------------------------------------------------------
CREATE POLICY jobs_company_lookup ON jobs
    FOR SELECT TO jale_admin
    USING (current_setting('jale.job_company_lookup', true) = 'on');

CREATE POLICY users_referrer_name_lookup ON users
    FOR SELECT TO jale_admin
    USING (current_setting('jale.referrer_name_lookup', true) = 'on');

-- ---------------------------------------------------------------------------
-- public_referrer_context: "who shared this link with you"
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public_referrer_context(
    p_code            TEXT,
    p_job_public_code TEXT
) RETURNS TABLE(kind TEXT, first_name TEXT)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
    -- Transaction-local (is_local = true, 061/062's rationale): the
    -- capability never leaks into a later, unrelated transaction on a
    -- pooled connection.
    PERFORM set_config('jale.referrer_name_lookup', 'on', true);
    PERFORM set_config('jale.job_company_lookup', 'on', true);

    RETURN QUERY
      SELECT
          CASE
              WHEN l.referrer_worker_id IS NOT NULL THEN 'worker'
              WHEN l.referrer_employer_id IS NOT NULL THEN 'employer'
          END AS kind,
          CASE
              WHEN l.referrer_worker_id IS NOT NULL
                  THEN NULLIF(split_part(u.full_name, ' ', 1), '')
              ELSE NULL
          END AS first_name
        FROM job_share_links l
        JOIN jobs j ON j.id = l.job_id
        LEFT JOIN users u ON u.id = l.referrer_worker_id
       WHERE l.code = p_code
         AND l.revoked_at IS NULL
         AND j.public_code = p_job_public_code
         -- Organic shares (both referrer columns NULL) yield NO row -- there
         -- is no referrer to attribute, not a row with a NULL kind.
         AND (l.referrer_worker_id IS NOT NULL OR l.referrer_employer_id IS NOT NULL);
END;
$$;

REVOKE ALL ON FUNCTION public_referrer_context(TEXT, TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public_referrer_context(TEXT, TEXT) TO jale_public_jobs, jale_admin;

-- ---------------------------------------------------------------------------
-- public_job_company: the employer's public-facing company name
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public_job_company(p_job_id UUID)
RETURNS TEXT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_company TEXT;
BEGIN
    PERFORM set_config('jale.job_company_lookup', 'on', true);
    -- Reuses 031's exact GUC/policy (employer_profiles_name_lookup) rather
    -- than adding a second employer_profiles policy.
    PERFORM set_config('app.employer_name_lookup', 'on', true);

    SELECT COALESCE(j.company, ep.company_name)
      INTO v_company
      FROM jobs j
      LEFT JOIN employer_profiles ep ON ep.user_id = j.employer_id
     WHERE j.id = p_job_id;

    RETURN v_company;
END;
$$;

REVOKE ALL ON FUNCTION public_job_company(UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public_job_company(UUID) TO jale_public_jobs, jale_admin;

COMMIT;
