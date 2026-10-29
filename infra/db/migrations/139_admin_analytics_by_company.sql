-- ============================================================
-- 139_admin_analytics_by_company.sql
-- Run manually AFTER 138_org_worker_naming.sql,
-- connected as jale_admin. Forward-only (ADR-005). ONE transaction.
--
-- Employer organizations, Phase 5: admin analytics count companies, not
-- employer logins
-- (docs/superpowers/specs/2026-10-15-employer-organizations-design.md,
-- "Admin analytics", "Phase 5"). A company with an owner and two foremen
-- counts once everywhere.
--
-- WHAT A COMPANY IS. An employer login (users.user_type = 'employer') with no
-- organization_members row of role 'foreman', in any status, keyed
-- COALESCE(its organization_id, its own id): a login with no membership (an
-- invalid invite, a test fixture) is a one-person company. A job belongs to
-- the company of its holder (jobs.employer_id), looked up with a LEFT join so
-- a memberless holder is never dropped; a removed member keeps their
-- organization_id, so their old jobs stay with the company. A row that names
-- a person for a company names its active owner, or the holder when there is
-- no membership or no active owner (the owner login was deleted): never NULL.
-- A test company is one whose OWNER is a test account (089's rule); a test
-- foreman never removes a real company's data.
--
-- (1) SAME COLUMNS, NEW MEANING (CREATE OR REPLACE; ACLs are kept):
--       admin_analytics_totals: total_employers counts companies (every
--         account, as before); paying_employers counts distinct
--         subscriptions.organization_id;
--       admin_analytics_signups: employer_signups counts new companies, by
--         the owner login's created_at (a foreman joining is not a new
--         employer, so Home's cumulative series still adds up to the total);
--       admin_analytics_acquisition: foreman logins are left out, so total
--         still equals the sign-ups chart's workers plus companies;
--       admin_analytics_paying_weekly: paying, new and churned count
--         companies (subscriptions.organization_id); the test filter stays
--         on the payer (subscriptions.user_id, immutable, the owner unless
--         support moved ownership); employers counts non-test companies;
--       admin_analytics_template_reuse: employers_using_templates counts
--         companies.
-- (2) NEW COLUMNS (DROP + CREATE; every old column keeps its name, type and
--     place, the new ones are appended):
--       admin_analytics_paying_employers: + organization_id and the seat
--         meter; rows, order and (no) test filter unchanged; seat_limit is
--         the row's own plan's foreman_seat_limit;
--       admin_analytics_slowest_employers: one row per company, keyed by its
--         owner as above; active_jobs counts the company's; + organization_id
--         (NULL for a memberless login).
-- (3) NEW DEFINERS:
--       admin_analytics_companies(p_limit, p_organization_id): one row per
--         company with an active owner: plan, members, seats, active jobs.
--         The plan follows resolveCompanyEntitlements (entitlements.ts);
--       admin_analytics_company_members(p_organization_id): every membership
--         row of one company, removed members included, named by contact
--         name, else account name. Never an email or a phone.
--     Seats follow the owner's billing meter (get-billing.ts, 128's
--     employer_org_usage): used = active foremen, pending = live invites,
--     suspended = billing-suspended foremen; the owner takes no seat.
-- (4) TWO GATED READS for jale_admin, which is not BYPASSRLS and meets FORCE
--     RLS (the 088 defect): organization_members and organization_invites,
--     SELECT only, while a definer has set app.admin_analytics_read.
--     organizations is never read. company_members reads employer_profiles
--     through 031's employer_profiles_name_lookup, which it opens itself.
--
-- ACCESS (089's pattern): every function is a definer owned by jale_admin
-- with a pinned search path, executable by the admin console only, and opens
-- app.admin_analytics_read after validating its arguments. No table grant,
-- no index, no new login right.
--
-- LOCKS. CREATE POLICY takes ACCESS EXCLUSIVE on organization_members and
-- organization_invites until COMMIT, and every employer request reads
-- organization_members, so the policies are the last statements before the
-- self-check and lock_timeout fails a stuck apply fast; a timed-out apply
-- writes no ledger row and can simply be rerun. The self-check runs the
-- console's widest windows (26 weeks) while the two locks are held: about
-- milliseconds at today's volume.
--
-- RELEASE INVARIANT. While no company has a foreman, a company is exactly
-- one employer login, so every changed figure must equal the per-login
-- figure it replaces. The migration asserts that itself: section 0b records
-- eight figures from the OLD bodies, section 5b recomputes them from the new
-- ones in the same transaction (now() fixed) and aborts the apply on the
-- first that differs. With a foreman anywhere it is skipped with a NOTICE.
-- The transaction is READ COMMITTED, so an employer sign-up, subscription
-- change or application committed by another session between the two
-- readings could also abort it; such an apply rolls back whole and can be
-- rerun, in the quiet window the locks already call for.
--
-- DEPLOY ORDER: apply BEFORE deploying the admin console build that reads the
-- new columns and calls the new functions. The deployed console reads the
-- old columns by name, so it keeps working in between. If a figure proves
-- wrong, a forward migration restores the earlier bodies; never edit this
-- file once applied.
--
-- REPLAY: refused once public.admin_analytics_companies exists.
-- ============================================================
BEGIN;

SET LOCAL lock_timeout = '5s';

-- ── 0. Preconditions ────────────────────────────────────────
-- pg_policy is a catalog table, so row security never filters these checks; a
-- missing or drifted policy would otherwise make a figure silently zero.
DO $$
DECLARE
  v_gate CONSTANT TEXT := $q$(current_setting('app.admin_analytics_read'::text, true) = 'on'::text)$q$;
  v_name CONSTANT TEXT := $q$(current_setting('app.employer_name_lookup'::text, true) = 'on'::text)$q$;
  pol RECORD;
BEGIN
  IF to_regprocedure('jale_cap.employer_contact_name(uuid)') IS NULL THEN
    RAISE EXCEPTION 'migration 139: apply 138 first (jale_cap.employer_contact_name is missing)';
  END IF;
  IF to_regprocedure('public.admin_analytics_companies(integer, uuid)') IS NOT NULL
     OR to_regprocedure('public.admin_analytics_company_members(uuid)') IS NOT NULL THEN
    RAISE EXCEPTION 'migration 139: already applied (public.admin_analytics_companies exists); it is not re-runnable';
  END IF;

  -- Every policy the nine bodies read through, exactly as reviewed.
  FOR pol IN
    SELECT * FROM (VALUES
      ('public.users', 'users_admin_analytics_read', 'r', v_gate),
      ('public.jobs', 'jobs_admin_analytics_read', 'r', v_gate),
      ('public.job_applications', 'job_applications_admin_analytics_read', 'r', v_gate),
      ('public.subscriptions', 'subscriptions_admin_analytics_read', 'r', v_gate),
      ('public.job_conversation_messages', 'job_conversation_messages_admin_analytics_read', 'r', v_gate),
      ('public.subscription_status_history', 'subscription_status_history_admin_analytics_read', 'r', v_gate),
      ('public.job_application_status_events', 'job_application_status_events_admin_analytics_read', 'r', v_gate),
      ('public.whatsapp_conversations', 'whatsapp_conversations_admin_analytics_read', 'r', v_gate),
      ('public.job_conversations', 'job_conversations_admin_analytics_read', 'r', v_gate),
      ('public.signup_attribution', 'signup_attribution_admin_analytics_read', 'r', v_gate),
      ('public.worker_attribution', 'worker_attribution_admin_analytics_read', 'r', v_gate),
      ('public.employer_job_templates', 'employer_job_templates_admin_analytics_read', 'r', v_gate),
      ('public.worker_workflow_runs', 'worker_workflow_runs_definer', '*', 'true'),
      ('public.employer_profiles', 'employer_profiles_name_lookup', 'r', v_name),
      ('public.billing_plans', 'billing_plans_read_all', 'r', 'true')
    ) AS expected(rel, name, cmd, qual)
  LOOP
    IF NOT EXISTS (
      SELECT 1 FROM pg_policy p
       WHERE p.polrelid = pol.rel::regclass
         AND p.polname = pol.name
         AND p.polcmd::text = pol.cmd
         AND p.polpermissive
         AND p.polroles = ARRAY['jale_admin'::regrole::oid]
         AND pg_get_expr(p.polqual, p.polrelid) = pol.qual
    ) THEN
      RAISE EXCEPTION 'migration 139: policy % on % missing or drifted; a figure would read zero rows', pol.name, pol.rel;
    END IF;
  END LOOP;

  -- A RESTRICTIVE SELECT (or ALL) policy is AND'ed with every policy above,
  -- so one that applies to jale_admin on any table read here could hide rows
  -- just as silently: one for jale_admin, for PUBLIC (role 0), or for any
  -- role whose privileges jale_admin has.
  IF EXISTS (
    SELECT 1 FROM pg_policy p
     WHERE p.polrelid IN ('public.users'::regclass, 'public.jobs'::regclass, 'public.job_applications'::regclass,
                          'public.subscriptions'::regclass, 'public.job_conversation_messages'::regclass,
                          'public.subscription_status_history'::regclass,
                          'public.job_application_status_events'::regclass,
                          'public.whatsapp_conversations'::regclass, 'public.job_conversations'::regclass,
                          'public.signup_attribution'::regclass, 'public.worker_attribution'::regclass,
                          'public.employer_job_templates'::regclass, 'public.worker_workflow_runs'::regclass,
                          'public.organization_members'::regclass, 'public.organization_invites'::regclass,
                          'public.employer_profiles'::regclass, 'public.billing_plans'::regclass)
       AND p.polcmd IN ('r', '*')
       AND NOT p.polpermissive
       AND ('jale_admin'::regrole::oid = ANY (p.polroles) OR 0::OID = ANY (p.polroles)
            OR EXISTS (SELECT 1 FROM unnest(p.polroles) AS r(role_oid)
                        WHERE r.role_oid <> 0 AND pg_has_role('jale_admin', r.role_oid, 'USAGE')))
  ) THEN
    RAISE EXCEPTION 'migration 139: a restrictive policy for jale_admin, a role it inherits, or PUBLIC on a table 139 reads; it would hide rows';
  END IF;

  -- Company names come from 031/118's definer, called as jale_admin.
  IF NOT has_function_privilege('jale_admin', 'public.employer_display_name(uuid)', 'EXECUTE') THEN
    RAISE EXCEPTION 'migration 139: jale_admin cannot execute employer_display_name(uuid)';
  END IF;
END $$;

-- ── 0b. The release invariant: the figures before 139 ──────
-- While no company has a foreman, a company is exactly one employer login,
-- so every company figure must equal the per-login figure it replaces (the
-- plan's release invariant). Each figure's query is stored once, run here
-- with the OLD bodies, and run again with the new ones after the policies
-- exist (section 5); now() is fixed for the whole transaction, so the week
-- and sign-up windows match exactly. Temporary tables, as 118 and 119 use;
-- both go at COMMIT.
CREATE TEMP TABLE m139_figure_sql (
  ord    INTEGER PRIMARY KEY,
  figure TEXT NOT NULL,
  sql    TEXT NOT NULL
) ON COMMIT DROP;
CREATE TEMP TABLE m139_figures_before (
  ord   INTEGER PRIMARY KEY,
  value JSONB
) ON COMMIT DROP;

INSERT INTO pg_temp.m139_figure_sql (ord, figure, sql) VALUES
  (1, 'admin_analytics_totals().total_employers',
      'SELECT to_jsonb(t.total_employers) FROM public.admin_analytics_totals() t'),
  (2, 'admin_analytics_totals().paying_employers',
      'SELECT to_jsonb(t.paying_employers) FROM public.admin_analytics_totals() t'),
  (3, 'admin_analytics_signups(now() - 26 weeks, week).employer_signups',
      $q$SELECT jsonb_agg(jsonb_build_array(s.bucket_start, s.employer_signups) ORDER BY s.bucket_start)
           FROM public.admin_analytics_signups(now() - interval '26 weeks', 'week') s
          WHERE s.employer_signups > 0$q$),
  (4, 'admin_analytics_acquisition(26).total',
      $q$SELECT jsonb_agg(jsonb_build_array(a.week_start, a.total) ORDER BY a.week_start)
           FROM public.admin_analytics_acquisition(26) a$q$),
  (5, 'admin_analytics_template_reuse(26).employers_using_templates',
      $q$SELECT jsonb_agg(jsonb_build_array(r.week_start, r.employers_using_templates) ORDER BY r.week_start)
           FROM public.admin_analytics_template_reuse(26) r$q$),
  (6, 'admin_analytics_paying_weekly(26) employers, paying, new_paying, churned',
      $q$SELECT jsonb_agg(jsonb_build_array(w.week_start, w.employers, w.paying, w.new_paying, w.churned) ORDER BY w.week_start)
           FROM public.admin_analytics_paying_weekly(26) w$q$),
  (7, 'admin_analytics_slowest_employers(26, 100) employer_id, applications, unanswered_7d, active_jobs',
      $q$SELECT jsonb_agg(jsonb_build_array(x.employer_id, x.applications, x.unanswered_7d, x.active_jobs) ORDER BY x.employer_id)
           FROM public.admin_analytics_slowest_employers(26, 100) x$q$),
  (8, 'admin_analytics_paying_employers().employer_id',
      $q$SELECT jsonb_agg(p.employer_id ORDER BY p.employer_id)
           FROM public.admin_analytics_paying_employers() p$q$);

DO $$
DECLARE
  f       RECORD;
  v_value JSONB;
BEGIN
  FOR f IN SELECT q.ord, q.sql FROM pg_temp.m139_figure_sql q ORDER BY q.ord LOOP
    -- Each definer opens its own gate; start every call closed.
    PERFORM set_config('app.admin_analytics_read', '', true);
    EXECUTE f.sql INTO v_value;
    INSERT INTO pg_temp.m139_figures_before (ord, value) VALUES (f.ord, v_value);
  END LOOP;
END $$;

-- ── 1. Same columns, new meaning ────────────────────────────

-- Totals: total_employers counts companies, paying_employers paying
-- companies. Every other figure is 113's.
CREATE OR REPLACE FUNCTION public.admin_analytics_totals()
RETURNS TABLE (
  total_workers          BIGINT,
  total_employers        BIGINT,
  paying_employers       BIGINT,
  jobs_active            BIGINT,
  jobs_paused            BIGINT,
  jobs_filled            BIGINT,
  jobs_closed            BIGINT,
  hires_total            BIGINT,
  jobs_with_hire         BIGINT,
  total_verified_workers BIGINT
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
#variable_conflict use_column
BEGIN
  PERFORM set_config('app.admin_analytics_read', 'on', true);

  RETURN QUERY
  SELECT
    (SELECT count(*) FROM public.users u WHERE u.user_type = 'worker'),
    -- Companies: employer logins that are not foremen. Every account, as
    -- before (no test filter); a company whose owner login was deleted has
    -- no login left to count.
    (SELECT count(*) FROM public.users u
      WHERE u.user_type = 'employer'
        AND NOT EXISTS (SELECT 1 FROM public.organization_members m
                         WHERE m.user_id = u.id AND m.role = 'foreman')),
    -- A company pays one current subscription (127), so count companies.
    (SELECT count(DISTINCT s.organization_id) FROM public.subscriptions s
      WHERE s.status IN ('active', 'trialing', 'past_due')),
    (SELECT count(*) FROM public.jobs j WHERE j.status = 'active'),
    (SELECT count(*) FROM public.jobs j WHERE j.status = 'paused'),
    (SELECT count(*) FROM public.jobs j WHERE j.status = 'filled'),
    (SELECT count(*) FROM public.jobs j WHERE j.status = 'closed'),
    (SELECT count(*) FROM public.job_applications a WHERE a.hired_at IS NOT NULL),
    (SELECT count(*) FROM public.jobs j WHERE j.workers_hired > 0),
    (SELECT count(*) FROM public.users u
      WHERE u.user_type = 'worker'
        AND EXISTS (SELECT 1 FROM public.worker_workflow_runs r WHERE r.user_id = u.id));
END $$;

-- Sign-ups: a company signs up with its owner's login, so a foreman joining
-- one is not a new employer. Buckets and the worker columns are 113's.
CREATE OR REPLACE FUNCTION public.admin_analytics_signups(p_from TIMESTAMPTZ, p_bucket TEXT)
RETURNS TABLE (
  bucket_start            TIMESTAMPTZ,
  worker_signups          BIGINT,
  employer_signups        BIGINT,
  worker_signups_verified BIGINT
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
#variable_conflict use_column
BEGIN
  IF p_from IS NULL THEN
    RAISE EXCEPTION 'admin_analytics_invalid_from';
  END IF;
  IF p_bucket IS DISTINCT FROM 'day' AND p_bucket IS DISTINCT FROM 'week' THEN
    RAISE EXCEPTION 'admin_analytics_invalid_bucket';
  END IF;

  -- Set AFTER argument validation so a rejected call never flips the flag.
  PERFORM set_config('app.admin_analytics_read', 'on', true);

  RETURN QUERY
  WITH verified_users AS (
    SELECT DISTINCT r.user_id FROM public.worker_workflow_runs r
  )
  SELECT date_trunc(p_bucket, u.created_at, 'UTC'),
         count(*) FILTER (WHERE u.user_type = 'worker'),
         count(*) FILTER (WHERE u.user_type = 'employer' AND f.user_id IS NULL),
         count(*) FILTER (WHERE u.user_type = 'worker' AND v.user_id IS NOT NULL)
    FROM public.users u
    LEFT JOIN verified_users v ON v.user_id = u.id
    -- The membership primary key: one row at most.
    LEFT JOIN public.organization_members f ON f.user_id = u.id AND f.role = 'foreman'
   WHERE u.created_at >= p_from
   GROUP BY 1
   ORDER BY 1;
END $$;

-- Acquisition (#16): accounts created per week, by where the sign-up
-- started. Foreman logins are left out, so total still equals the sign-ups
-- chart's workers plus companies. Everything else is 124's.
CREATE OR REPLACE FUNCTION public.admin_analytics_acquisition(p_weeks INTEGER)
RETURNS TABLE (
  week_start          TIMESTAMPTZ,
  partial             BOOLEAN,
  from_shared_link    BIGINT,
  from_campaign_tag   BIGINT,
  from_referral       BIGINT,
  from_direct         BIGINT,
  from_whatsapp_entry BIGINT,
  from_unknown        BIGINT,
  total               BIGINT,
  collecting_since    TIMESTAMPTZ
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
#variable_conflict use_column
DECLARE
  v_week0 TIMESTAMPTZ;
  v_from  TIMESTAMPTZ;
BEGIN
  IF p_weeks IS NULL OR p_weeks < 1 OR p_weeks > 26 THEN
    RAISE EXCEPTION 'admin_analytics_invalid_weeks';
  END IF;

  -- Set AFTER argument validation so a rejected call never flips the flag.
  PERFORM set_config('app.admin_analytics_read', 'on', true);

  -- Week arithmetic on UTC wall-clock time, so the session TimeZone (and its
  -- daylight-saving shifts) can never move a week edge.
  v_week0 := date_trunc('week', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC';
  v_from := (date_trunc('week', now() AT TIME ZONE 'UTC') - make_interval(weeks => p_weeks - 1)) AT TIME ZONE 'UTC';

  RETURN QUERY
  WITH weeks AS (
    SELECT (date_trunc('week', now() AT TIME ZONE 'UTC') - make_interval(weeks => g.n)) AT TIME ZONE 'UTC' AS wk
      FROM generate_series(0, p_weeks - 1) AS g(n)
  ), signups AS (
    SELECT date_trunc('week', u.created_at, 'UTC') AS wk,
           CASE
             WHEN sa.src IS NOT NULL THEN 'campaign_tag'
             WHEN wa.first_channel IS NOT NULL THEN 'referral'
             WHEN sa.entry = 'job_link' THEN 'shared_link'
             WHEN sa.door = 'web' THEN 'direct'
             WHEN sa.door = 'whatsapp' THEN 'whatsapp_entry'
             WHEN u.user_type = 'worker' AND EXISTS (
               -- First contact on WhatsApp: a conversation of this account
               -- that started no later than the account (113's door rule).
               SELECT 1 FROM public.whatsapp_conversations c
                WHERE c.user_id = u.id AND c.created_at <= u.created_at
             ) THEN 'whatsapp_entry'
             ELSE 'unknown'
           END AS source
      FROM public.users u
      LEFT JOIN public.signup_attribution sa ON sa.user_id = u.id
      LEFT JOIN public.worker_attribution wa ON wa.worker_id = u.id
     WHERE u.created_at >= v_from
       AND u.user_type IN ('worker', 'employer')
       -- A foreman joins a company; the company signed up with its owner.
       AND NOT EXISTS (SELECT 1 FROM public.organization_members m
                        WHERE m.user_id = u.id AND m.role = 'foreman')
  ), agg AS (
    SELECT s.wk,
           count(*) FILTER (WHERE s.source = 'shared_link')    AS shared_link,
           count(*) FILTER (WHERE s.source = 'campaign_tag')   AS campaign_tag,
           count(*) FILTER (WHERE s.source = 'referral')       AS referral,
           count(*) FILTER (WHERE s.source = 'direct')         AS direct,
           count(*) FILTER (WHERE s.source = 'whatsapp_entry') AS whatsapp_entry,
           count(*) FILTER (WHERE s.source = 'unknown')        AS unknown_source,
           count(*)                                            AS total
      FROM signups s
     GROUP BY s.wk
  ), since AS (
    SELECT min(sa.created_at) AS at FROM public.signup_attribution sa
  )
  SELECT w.wk,
         w.wk = v_week0,
         COALESCE(a.shared_link, 0),
         COALESCE(a.campaign_tag, 0),
         COALESCE(a.referral, 0),
         COALESCE(a.direct, 0),
         COALESCE(a.whatsapp_entry, 0),
         COALESCE(a.unknown_source, 0),
         COALESCE(a.total, 0),
         (SELECT s.at FROM since s)
    FROM weeks w
    LEFT JOIN agg a ON a.wk = w.wk
   ORDER BY w.wk;
END $$;

-- Paying by week (#2): paying, new and churned count companies; employers
-- counts non-test companies whose owner login existed by the week's end.
-- The test filter stays on the payer. Week edges and history probes are 123's.
CREATE OR REPLACE FUNCTION public.admin_analytics_paying_weekly(p_weeks INTEGER)
RETURNS TABLE (
  week_start         TIMESTAMPTZ,
  partial            BOOLEAN,
  employers          BIGINT,
  paying             BIGINT,
  new_paying         BIGINT,
  churned            BIGINT,
  approximate_before TIMESTAMPTZ
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
#variable_conflict use_column
DECLARE
  v_week0  TIMESTAMPTZ;
  v_approx TIMESTAMPTZ;
BEGIN
  IF p_weeks IS NULL OR p_weeks < 1 OR p_weeks > 26 THEN
    RAISE EXCEPTION 'admin_analytics_invalid_weeks';
  END IF;

  -- Set AFTER argument validation so a rejected call never flips the flag.
  PERFORM set_config('app.admin_analytics_read', 'on', true);

  -- Week arithmetic on UTC wall-clock time, so the session TimeZone (and its
  -- daylight-saving shifts) can never move a week edge.
  v_week0 := date_trunc('week', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC';

  SELECT min(h.changed_at) INTO v_approx
    FROM public.subscription_status_history h
   WHERE NOT h.is_backfill;

  RETURN QUERY
  WITH weeks AS (
    SELECT t.wk_utc AT TIME ZONE 'UTC' AS wk,
           least((t.wk_utc + interval '7 days') AT TIME ZONE 'UTC', now()) AS wk_end
      FROM (SELECT date_trunc('week', now() AT TIME ZONE 'UTC') - make_interval(weeks => g.n) AS wk_utc
              FROM generate_series(0, p_weeks - 1) AS g(n)) t
  ), subs AS (
    -- Each subscription in the history with its company and its payer. The
    -- history row cascades with its subscription (100) and organization_id
    -- is NOT NULL (127), so the inner join drops nothing.
    SELECT DISTINCT h.subscription_id, s.organization_id, s.user_id
      FROM public.subscription_status_history h
      JOIN public.subscriptions s ON s.id = h.subscription_id
  ), paid AS (
    -- Subscriptions whose payer still exists, is an employer and is not a
    -- test account.
    SELECT b.subscription_id, b.organization_id
      FROM subs b
      CROSS JOIN LATERAL (
        SELECT 1
          FROM public.users u
         WHERE u.id = b.user_id
           AND u.user_type = 'employer'
           AND NOT COALESCE(u.email LIKE '%@jale.test' OR u.cognito_sub LIKE 'seed-%', false)
         LIMIT 1
      ) e
  ), edges AS (
    -- Each subscription's latest status before the week starts and before
    -- it ends, by an index probe.
    SELECT w.wk,
           o.organization_id,
           COALESCE(st.to_status IN ('active', 'trialing', 'past_due'), false) AS paying_start,
           COALESCE(en.to_status IN ('active', 'trialing', 'past_due'), false) AS paying_end
      FROM weeks w
      CROSS JOIN paid o
      LEFT JOIN LATERAL (
        SELECT h.to_status
          FROM public.subscription_status_history h
         WHERE h.subscription_id = o.subscription_id
           AND h.changed_at < w.wk
         ORDER BY h.changed_at DESC, h.id DESC
         LIMIT 1
      ) st ON true
      LEFT JOIN LATERAL (
        SELECT h.to_status
          FROM public.subscription_status_history h
         WHERE h.subscription_id = o.subscription_id
           AND h.changed_at < w.wk_end
         ORDER BY h.changed_at DESC, h.id DESC
         LIMIT 1
      ) en ON true
  ), per_company AS (
    -- A company that changed payer (support moved ownership) counts once.
    SELECT e.wk, e.organization_id, bool_or(e.paying_start) AS at_start, bool_or(e.paying_end) AS at_end
      FROM edges e
     GROUP BY e.wk, e.organization_id
  ), agg AS (
    SELECT p.wk,
           count(*) FILTER (WHERE p.at_end) AS n_paying,
           count(*) FILTER (WHERE p.at_end AND NOT p.at_start) AS n_new,
           count(*) FILTER (WHERE p.at_start AND NOT p.at_end) AS n_churned
      FROM per_company p
     GROUP BY p.wk
  ), emp AS (
    -- Companies: employer logins that are not foremen, and not test accounts.
    SELECT w.wk, count(x.created_at) AS n_employers
      FROM weeks w
      LEFT JOIN (
        SELECT u.created_at
          FROM public.users u
         WHERE u.user_type = 'employer'
           AND NOT COALESCE(u.email LIKE '%@jale.test' OR u.cognito_sub LIKE 'seed-%', false)
           AND NOT EXISTS (SELECT 1 FROM public.organization_members m
                            WHERE m.user_id = u.id AND m.role = 'foreman')
      ) x ON x.created_at < w.wk_end
     GROUP BY w.wk
  )
  SELECT w.wk,
         w.wk = v_week0,
         COALESCE(m.n_employers, 0),
         COALESCE(a.n_paying, 0),
         COALESCE(a.n_new, 0),
         COALESCE(a.n_churned, 0),
         v_approx
    FROM weeks w
    LEFT JOIN emp m ON m.wk = w.wk
    LEFT JOIN agg a ON a.wk = w.wk
   ORDER BY w.wk;
END $$;

-- Template reuse (#18): employers_using_templates counts companies. A job
-- belongs to its holder's company, or to a holder with no membership.
CREATE OR REPLACE FUNCTION public.admin_analytics_template_reuse(p_weeks INTEGER)
RETURNS TABLE (
  week_start                TIMESTAMPTZ,
  partial                   BOOLEAN,
  jobs                      BIGINT,
  from_template             BIGINT,
  employers_using_templates BIGINT,
  templates_saved           BIGINT,
  collecting_since          TIMESTAMPTZ
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
#variable_conflict use_column
DECLARE
  v_week0 TIMESTAMPTZ;
  v_from  TIMESTAMPTZ;
BEGIN
  IF p_weeks IS NULL OR p_weeks < 1 OR p_weeks > 26 THEN
    RAISE EXCEPTION 'admin_analytics_invalid_weeks';
  END IF;

  -- Set AFTER argument validation so a rejected call never flips the flag.
  PERFORM set_config('app.admin_analytics_read', 'on', true);

  v_week0 := date_trunc('week', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC';
  v_from := (date_trunc('week', now() AT TIME ZONE 'UTC') - make_interval(weeks => p_weeks - 1)) AT TIME ZONE 'UTC';

  RETURN QUERY
  WITH weeks AS (
    SELECT (date_trunc('week', now() AT TIME ZONE 'UTC') - make_interval(weeks => g.n)) AT TIME ZONE 'UTC' AS wk
      FROM generate_series(0, p_weeks - 1) AS g(n)
  ), posted AS (
    SELECT date_trunc('week', j.created_at, 'UTC') AS wk,
           count(*) AS n_jobs,
           count(*) FILTER (WHERE j.created_from_template_id IS NOT NULL) AS n_from_template,
           count(DISTINCT COALESCE(jm.organization_id, j.employer_id))
             FILTER (WHERE j.created_from_template_id IS NOT NULL) AS n_employers
      FROM public.jobs j
      -- The holder's company, by a primary-key probe per job; none for a
      -- memberless holder, who is then a company of one.
      LEFT JOIN LATERAL (
        SELECT m.organization_id
          FROM public.organization_members m
         WHERE m.user_id = j.employer_id
         LIMIT 1
      ) jm ON true
     WHERE j.created_at >= v_from
     GROUP BY 1
  ), saved AS (
    SELECT date_trunc('week', t.created_at, 'UTC') AS wk, count(*) AS n
      FROM public.employer_job_templates t
     WHERE t.created_at >= v_from
     GROUP BY 1
  ), since AS (
    SELECT min(j.created_at) AS at FROM public.jobs j WHERE j.created_from_template_id IS NOT NULL
  )
  SELECT w.wk,
         w.wk = v_week0,
         COALESCE(p.n_jobs, 0),
         COALESCE(p.n_from_template, 0),
         COALESCE(p.n_employers, 0),
         COALESCE(s.n, 0),
         (SELECT x.at FROM since x)
    FROM weeks w
    LEFT JOIN posted p ON p.wk = w.wk
    LEFT JOIN saved s ON s.wk = w.wk
   ORDER BY w.wk;
END $$;

-- ── 2. New columns, and two new definers ────────────────────

-- Paying employers: 089's rows, order and (absent) test filter, plus the
-- company and its seat meter. Business identity only: employer_display_name()
-- returns the company name or 'Empleador'. seat_limit is the row's own plan's
-- foreman_seat_limit (the Companies list applies the grace rule instead);
-- NULL when the plan does not set a whole number.
DROP FUNCTION public.admin_analytics_paying_employers();

CREATE FUNCTION public.admin_analytics_paying_employers()
RETURNS TABLE (
  employer_id          UUID,
  display_name         TEXT,
  plan_code            TEXT,
  status               TEXT,
  current_period_end   TIMESTAMPTZ,
  cancel_at_period_end BOOLEAN,
  organization_id      UUID,
  members_active       BIGINT,
  seats_used           BIGINT,
  seats_pending        BIGINT,
  seats_suspended      BIGINT,
  seat_limit           INTEGER
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
#variable_conflict use_column
BEGIN
  PERFORM set_config('app.admin_analytics_read', 'on', true);

  RETURN QUERY
  SELECT s.user_id,
         public.employer_display_name(s.user_id),
         s.plan_code,
         s.status,
         s.current_period_end,
         s.cancel_at_period_end,
         s.organization_id,
         mc.members_active,
         mc.seats_used,
         ic.seats_pending,
         mc.seats_suspended,
         CASE WHEN p.entitlements ->> 'foreman_seat_limit' ~ '^[0-9]{1,9}$'
              THEN (p.entitlements ->> 'foreman_seat_limit')::INTEGER END
    FROM public.subscriptions s
    -- Members by status: active members (the owner included), active
    -- foremen (seats used) and billing-suspended foremen.
    CROSS JOIN LATERAL (
      SELECT count(*) FILTER (WHERE m.status = 'active') AS members_active,
             count(*) FILTER (WHERE m.role = 'foreman' AND m.status = 'active') AS seats_used,
             count(*) FILTER (WHERE m.role = 'foreman' AND m.status = 'suspended'
                                AND m.billing_suspended_at IS NOT NULL) AS seats_suspended
        FROM public.organization_members m
       WHERE m.organization_id = s.organization_id
    ) mc
    -- Live invites hold a seat.
    CROSS JOIN LATERAL (
      SELECT count(*) AS seats_pending
        FROM public.organization_invites i
       WHERE i.organization_id = s.organization_id
         AND i.accepted_at IS NULL AND i.revoked_at IS NULL AND i.expires_at > now()
    ) ic
    LEFT JOIN public.billing_plans p ON p.code = s.plan_code
   WHERE s.status IN ('active', 'trialing', 'past_due')
   ORDER BY public.employer_display_name(s.user_id) ASC, s.created_at ASC;
END $$;

-- Slowest employers: one row per company. A job is keyed by its company's
-- active owner, else by its holder (no membership, or no active owner), so
-- employer_id is never NULL. The test filter is on that key. Applications,
-- first response and ranking are 114's; active_jobs counts the jobs the same
-- key covers.
DROP FUNCTION public.admin_analytics_slowest_employers(INTEGER, INTEGER);

CREATE FUNCTION public.admin_analytics_slowest_employers(p_weeks INTEGER, p_limit INTEGER DEFAULT 10)
RETURNS TABLE (
  employer_id              UUID,
  display_name             TEXT,
  applications             BIGINT,
  unanswered_7d            BIGINT,
  first_response_p50_hours NUMERIC,
  active_jobs              BIGINT,
  organization_id          UUID
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
#variable_conflict use_column
DECLARE
  v_from TIMESTAMPTZ;
BEGIN
  IF p_weeks IS NULL OR p_weeks < 1 OR p_weeks > 26 THEN
    RAISE EXCEPTION 'admin_analytics_invalid_weeks';
  END IF;
  IF p_limit IS NULL OR p_limit < 1 OR p_limit > 100 THEN
    RAISE EXCEPTION 'admin_analytics_invalid_limit';
  END IF;

  -- Set AFTER argument validation so a rejected call never flips the flag.
  PERFORM set_config('app.admin_analytics_read', 'on', true);

  v_from := (date_trunc('week', now() AT TIME ZONE 'UTC') - make_interval(weeks => p_weeks - 1)) AT TIME ZONE 'UTC';

  RETURN QUERY
  WITH employers AS (
    SELECT u.id
      FROM public.users u
     WHERE u.user_type = 'employer'
       AND NOT COALESCE(u.email LIKE '%@jale.test' OR u.cognito_sub LIKE 'seed-%', false)
  ), win_apps AS (
    SELECT a.id, a.job_id, a.status, a.applied_at, a.details_requested_at, a.hired_at,
           COALESCE(a.hired_at = a.hired_seen_at AND a.hired_at = a.hired_ack_at, false) AS hire_approx
      FROM public.job_applications a
     WHERE a.applied_at >= v_from
  ), job_keys AS (
    -- Each job with an application in the window, once: its company (none
    -- for a memberless holder; a removed member keeps theirs) and that
    -- company's active owner, each by an index probe (the membership primary
    -- key, then organization_members_one_active_owner).
    SELECT j.id AS job_id,
           COALESCE(ow.user_id, j.employer_id) AS owner_id,
           jm.organization_id AS org_id,
           ow.user_id IS NOT NULL AS owned
      FROM (SELECT DISTINCT w.job_id FROM win_apps w) wj
      JOIN public.jobs j ON j.id = wj.job_id
      LEFT JOIN LATERAL (
        SELECT m.organization_id
          FROM public.organization_members m
         WHERE m.user_id = j.employer_id
         LIMIT 1
      ) jm ON true
      LEFT JOIN LATERAL (
        SELECT o.user_id
          FROM public.organization_members o
         WHERE o.organization_id = jm.organization_id
           AND o.role = 'owner' AND o.status = 'active'
         LIMIT 1
      ) ow ON true
  ), apps AS (
    -- A test owner leaves the whole company out; a test foreman does not.
    SELECT w.id, w.status, w.applied_at, w.details_requested_at, w.hired_at, w.hire_approx,
           k.owner_id AS emp, k.org_id, k.owned
      FROM win_apps w
      JOIN job_keys k ON k.job_id = w.job_id
      JOIN employers e ON e.id = k.owner_id
  ), app_facts AS (
    SELECT ap.emp, ap.org_id, ap.owned,
           (fa.first_at IS NULL AND ap.status = 'pending'
              AND ap.applied_at <= now() - interval '7 days') AS is_unanswered,
           extract(epoch FROM fa.first_at - ap.applied_at)::DOUBLE PRECISION / 3600 AS hours
      FROM apps ap
      -- The earliest employer action on the application, by index lookups.
      LEFT JOIN LATERAL (
        SELECT min(x.at) AS first_at
          FROM (
            SELECT min(cm.created_at) AS at
              FROM public.job_conversations c
              JOIN public.job_conversation_messages cm ON cm.conversation_id = c.id
             WHERE c.application_id = ap.id
               AND cm.sender_type = 'employer'
            UNION ALL
            SELECT ap.details_requested_at
            UNION ALL
            SELECT ap.hired_at WHERE NOT ap.hire_approx
            UNION ALL
            SELECT min(ev.changed_at)
              FROM public.job_application_status_events ev
             WHERE ev.application_id = ap.id
               AND NOT ev.is_backfill
               AND ev.to_status IN ('contacted', 'details_requested', 'hired', 'not_interested')
          ) x
      ) fa ON true
  ), ranked AS (
    -- emp decides org_id and owned, so each company is one group.
    SELECT f.emp, f.org_id, f.owned,
           count(*) AS n_apps,
           count(*) FILTER (WHERE f.is_unanswered) AS n_unanswered,
           round(percentile_cont(0.5) WITHIN GROUP (ORDER BY f.hours)::NUMERIC, 1) AS p50
      FROM app_facts f
     GROUP BY f.emp, f.org_id, f.owned
    HAVING count(*) >= 3
  )
  SELECT r.emp,
         public.employer_display_name(r.emp),
         r.n_apps,
         r.n_unanswered,
         r.p50,
         CASE WHEN r.owned THEN
           -- Every member's jobs, removed members included.
           (SELECT count(*)
              FROM public.organization_members m
              JOIN public.jobs j ON j.employer_id = m.user_id
             WHERE m.organization_id = r.org_id AND j.status = 'active')
         ELSE
           (SELECT count(*) FROM public.jobs j WHERE j.employer_id = r.emp AND j.status = 'active')
         END,
         r.org_id
    FROM ranked r
   -- No timed answer is not evidence of slowness (all fresh, or answered
   -- before history began): those rank below measured employers.
   ORDER BY r.n_unanswered DESC, r.p50 DESC NULLS LAST, r.emp
   LIMIT p_limit;
END $$;

-- Companies: one row per company with an active owner. Without
-- p_organization_id, the non-test companies holding the most seats, at most
-- p_limit (a page bound). With it, that company alone, test or not.
-- created_at is the owner login's. The plan follows resolveCompanyEntitlements
-- (entitlements.ts): the eligible subscription (active or trialing, or
-- past_due inside grace; the most recently updated), else the active
-- employer_free row with no plan_status. Seats are the owner's billing meter.
CREATE FUNCTION public.admin_analytics_companies(p_limit INTEGER, p_organization_id UUID DEFAULT NULL)
RETURNS TABLE (
  organization_id UUID,
  owner_id        UUID,
  display_name    TEXT,
  created_at      TIMESTAMPTZ,
  plan_code       TEXT,
  plan_status     TEXT,
  members_active  BIGINT,
  seats_used      BIGINT,
  seats_pending   BIGINT,
  seats_suspended BIGINT,
  seat_limit      INTEGER,
  active_jobs     BIGINT
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
#variable_conflict use_column
BEGIN
  IF p_limit IS NULL OR p_limit < 1 OR p_limit > 500 THEN
    RAISE EXCEPTION 'admin_analytics_invalid_limit';
  END IF;

  -- Set AFTER argument validation so a rejected call never flips the flag.
  PERFORM set_config('app.admin_analytics_read', 'on', true);

  RETURN QUERY
  WITH companies AS (
    -- organization_members_one_active_owner: one owner row per company.
    SELECT o.organization_id AS org_id, o.user_id AS owner_id, u.created_at AS owner_created_at
      FROM public.organization_members o
      JOIN public.users u ON u.id = o.user_id
     WHERE o.role = 'owner' AND o.status = 'active'
       AND (p_organization_id IS NULL OR o.organization_id = p_organization_id)
       AND (p_organization_id IS NOT NULL
            OR NOT COALESCE(u.email LIKE '%@jale.test' OR u.cognito_sub LIKE 'seed-%', false))
  )
  SELECT c.org_id,
         c.owner_id,
         public.employer_display_name(c.owner_id),
         c.owner_created_at,
         pl.plan_code,
         pl.plan_status,
         mc.members_active,
         mc.seats_used,
         ic.seats_pending,
         mc.seats_suspended,
         CASE WHEN pl.entitlements ->> 'foreman_seat_limit' ~ '^[0-9]{1,9}$'
              THEN (pl.entitlements ->> 'foreman_seat_limit')::INTEGER END,
         jc.active_jobs
    FROM companies c
    -- A LEFT join: a company stays listed even if the catalog lost its free row.
    LEFT JOIN LATERAL (
      SELECT x.plan_code, x.plan_status, x.entitlements
        FROM (
          (SELECT s.plan_code, s.status AS plan_status, p.entitlements, 0 AS priority
             FROM public.subscriptions s
             JOIN public.billing_plans p ON p.code = s.plan_code
            WHERE s.organization_id = c.org_id
              AND (s.status IN ('active', 'trialing') OR (s.status = 'past_due' AND s.grace_ends_at > now()))
            ORDER BY s.updated_at DESC
            LIMIT 1)
          UNION ALL
          (SELECT p.code, NULL::TEXT, p.entitlements, 1
             FROM public.billing_plans p
            WHERE p.code = 'employer_free' AND p.active)
        ) x
       ORDER BY x.priority
       LIMIT 1
    ) pl ON true
    -- Members by status: active members (the owner included), active
    -- foremen (seats used) and billing-suspended foremen.
    CROSS JOIN LATERAL (
      SELECT count(*) FILTER (WHERE m.status = 'active') AS members_active,
             count(*) FILTER (WHERE m.role = 'foreman' AND m.status = 'active') AS seats_used,
             count(*) FILTER (WHERE m.role = 'foreman' AND m.status = 'suspended'
                                AND m.billing_suspended_at IS NOT NULL) AS seats_suspended
        FROM public.organization_members m
       WHERE m.organization_id = c.org_id
    ) mc
    -- Live invites hold a seat.
    CROSS JOIN LATERAL (
      SELECT count(*) AS seats_pending
        FROM public.organization_invites i
       WHERE i.organization_id = c.org_id
         AND i.accepted_at IS NULL AND i.revoked_at IS NULL AND i.expires_at > now()
    ) ic
    -- Every member's active jobs, removed members included.
    CROSS JOIN LATERAL (
      SELECT count(*) AS active_jobs
        FROM public.organization_members m
        JOIN public.jobs j ON j.employer_id = m.user_id
       WHERE m.organization_id = c.org_id AND j.status = 'active'
    ) jc
   ORDER BY mc.seats_used + ic.seats_pending DESC, mc.members_active DESC, jc.active_jobs DESC,
            c.owner_created_at DESC, c.org_id
   LIMIT CASE WHEN p_organization_id IS NULL THEN p_limit END;
END $$;

-- Company members: every membership row of one company, removed members
-- included: the owner, then active, suspended and removed members, each by
-- when they joined. A member is named by their contact name, else their
-- account name as they typed it.
CREATE FUNCTION public.admin_analytics_company_members(p_organization_id UUID)
RETURNS TABLE (
  user_id           UUID,
  display_name      TEXT,
  role              TEXT,
  status            TEXT,
  billing_suspended BOOLEAN,
  joined_at         TIMESTAMPTZ,
  status_changed_at TIMESTAMPTZ,
  active_jobs       BIGINT
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
#variable_conflict use_column
DECLARE
  v_members UUID[];
BEGIN
  IF p_organization_id IS NULL THEN
    RAISE EXCEPTION 'admin_analytics_invalid_organization';
  END IF;

  -- Set AFTER argument validation so a rejected call never flips the flag.
  PERFORM set_config('app.admin_analytics_read', 'on', true);

  -- Who the members are, read through this migration's gated policy alone:
  -- the name gate below also opens organization_members to jale_admin
  -- (118's organization_members_name_lookup), so the ids are fixed first.
  SELECT array_agg(m.user_id) INTO v_members
    FROM public.organization_members m
   WHERE m.organization_id = p_organization_id;

  -- Contact names: employer_profiles opens to jale_admin only through 031's
  -- employer_profiles_name_lookup. The policy is evaluated when the scan
  -- starts, so the gate opens here, before the query.
  PERFORM set_config('app.employer_name_lookup', 'on', true);

  RETURN QUERY
  SELECT m.user_id,
         COALESCE(NULLIF(btrim(ep.contact_name), ''), NULLIF(btrim(u.full_name), '')),
         m.role,
         m.status,
         m.billing_suspended_at IS NOT NULL,
         m.joined_at,
         m.status_changed_at,
         (SELECT count(*) FROM public.jobs j WHERE j.employer_id = m.user_id AND j.status = 'active')
    FROM public.organization_members m
    LEFT JOIN public.users u ON u.id = m.user_id
    LEFT JOIN public.employer_profiles ep ON ep.user_id = m.user_id
   WHERE m.organization_id = p_organization_id
     AND m.user_id = ANY (v_members)
   ORDER BY CASE WHEN m.role = 'owner' THEN 0 ELSE 1 END,
            CASE m.status WHEN 'active' THEN 0 WHEN 'suspended' THEN 1 ELSE 2 END,
            m.joined_at, m.user_id;
END $$;

-- ── 3. Ownership and ACL ────────────────────────────────────
-- The two drops discarded their ACLs and the new functions have none, so all
-- nine are stated here; for the five replaced in place these are no-ops.
ALTER FUNCTION public.admin_analytics_totals() OWNER TO jale_admin;
ALTER FUNCTION public.admin_analytics_signups(TIMESTAMPTZ, TEXT) OWNER TO jale_admin;
ALTER FUNCTION public.admin_analytics_acquisition(INTEGER) OWNER TO jale_admin;
ALTER FUNCTION public.admin_analytics_paying_weekly(INTEGER) OWNER TO jale_admin;
ALTER FUNCTION public.admin_analytics_template_reuse(INTEGER) OWNER TO jale_admin;
ALTER FUNCTION public.admin_analytics_paying_employers() OWNER TO jale_admin;
ALTER FUNCTION public.admin_analytics_slowest_employers(INTEGER, INTEGER) OWNER TO jale_admin;
ALTER FUNCTION public.admin_analytics_companies(INTEGER, UUID) OWNER TO jale_admin;
ALTER FUNCTION public.admin_analytics_company_members(UUID) OWNER TO jale_admin;

REVOKE ALL ON FUNCTION public.admin_analytics_totals() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.admin_analytics_signups(TIMESTAMPTZ, TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.admin_analytics_acquisition(INTEGER) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.admin_analytics_paying_weekly(INTEGER) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.admin_analytics_template_reuse(INTEGER) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.admin_analytics_paying_employers() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.admin_analytics_slowest_employers(INTEGER, INTEGER) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.admin_analytics_companies(INTEGER, UUID) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.admin_analytics_company_members(UUID) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION public.admin_analytics_totals() TO jale_admin_console;
GRANT EXECUTE ON FUNCTION public.admin_analytics_signups(TIMESTAMPTZ, TEXT) TO jale_admin_console;
GRANT EXECUTE ON FUNCTION public.admin_analytics_acquisition(INTEGER) TO jale_admin_console;
GRANT EXECUTE ON FUNCTION public.admin_analytics_paying_weekly(INTEGER) TO jale_admin_console;
GRANT EXECUTE ON FUNCTION public.admin_analytics_template_reuse(INTEGER) TO jale_admin_console;
GRANT EXECUTE ON FUNCTION public.admin_analytics_paying_employers() TO jale_admin_console;
GRANT EXECUTE ON FUNCTION public.admin_analytics_slowest_employers(INTEGER, INTEGER) TO jale_admin_console;
GRANT EXECUTE ON FUNCTION public.admin_analytics_companies(INTEGER, UUID) TO jale_admin_console;
GRANT EXECUTE ON FUNCTION public.admin_analytics_company_members(UUID) TO jale_admin_console;

-- ── 4. Last: the two gated reads ────────────────────────────
-- 089's gate on the two company tables: SELECT only, for the master login,
-- only while a definer has set the transaction-local flag. Each takes ACCESS
-- EXCLUSIVE on its table until COMMIT.
CREATE POLICY organization_members_admin_analytics_read ON public.organization_members
  AS PERMISSIVE FOR SELECT TO jale_admin
  USING (current_setting('app.admin_analytics_read', true) = 'on');
CREATE POLICY organization_invites_admin_analytics_read ON public.organization_invites
  AS PERMISSIVE FOR SELECT TO jale_admin
  USING (current_setting('app.admin_analytics_read', true) = 'on');

-- ── 5. Self-check ───────────────────────────────────────────
-- Fail closed if a function drifted from the reviewed model (arguments,
-- result, owner, security, search path, EXECUTE), if a policy drifted, if a
-- gate does not open, or if bad input is accepted. The calls are small: the
-- two policy locks are held until COMMIT.
DO $$
DECLARE
  v_gate   CONSTANT TEXT := $q$(current_setting('app.admin_analytics_read'::text, true) = 'on'::text)$q$;
  spec     RECORD;
  fn       RECORD;
  pol      RECORD;
  bad      RECORD;
  v_raised BOOLEAN;
BEGIN
  FOR spec IN
    SELECT * FROM (VALUES
      ('admin_analytics_totals', '', 'TABLE(total_workers bigint, total_employers bigint, paying_employers bigint, jobs_active bigint, jobs_paused bigint, jobs_filled bigint, jobs_closed bigint, hires_total bigint, jobs_with_hire bigint, total_verified_workers bigint)'),
      ('admin_analytics_signups', 'p_from timestamp with time zone, p_bucket text', 'TABLE(bucket_start timestamp with time zone, worker_signups bigint, employer_signups bigint, worker_signups_verified bigint)'),
      ('admin_analytics_acquisition', 'p_weeks integer', 'TABLE(week_start timestamp with time zone, partial boolean, from_shared_link bigint, from_campaign_tag bigint, from_referral bigint, from_direct bigint, from_whatsapp_entry bigint, from_unknown bigint, total bigint, collecting_since timestamp with time zone)'),
      ('admin_analytics_paying_weekly', 'p_weeks integer', 'TABLE(week_start timestamp with time zone, partial boolean, employers bigint, paying bigint, new_paying bigint, churned bigint, approximate_before timestamp with time zone)'),
      ('admin_analytics_template_reuse', 'p_weeks integer', 'TABLE(week_start timestamp with time zone, partial boolean, jobs bigint, from_template bigint, employers_using_templates bigint, templates_saved bigint, collecting_since timestamp with time zone)'),
      ('admin_analytics_paying_employers', '', 'TABLE(employer_id uuid, display_name text, plan_code text, status text, current_period_end timestamp with time zone, cancel_at_period_end boolean, organization_id uuid, members_active bigint, seats_used bigint, seats_pending bigint, seats_suspended bigint, seat_limit integer)'),
      ('admin_analytics_slowest_employers', 'p_weeks integer, p_limit integer DEFAULT 10', 'TABLE(employer_id uuid, display_name text, applications bigint, unanswered_7d bigint, first_response_p50_hours numeric, active_jobs bigint, organization_id uuid)'),
      ('admin_analytics_companies', 'p_limit integer, p_organization_id uuid DEFAULT NULL::uuid', 'TABLE(organization_id uuid, owner_id uuid, display_name text, created_at timestamp with time zone, plan_code text, plan_status text, members_active bigint, seats_used bigint, seats_pending bigint, seats_suspended bigint, seat_limit integer, active_jobs bigint)'),
      ('admin_analytics_company_members', 'p_organization_id uuid', 'TABLE(user_id uuid, display_name text, role text, status text, billing_suspended boolean, joined_at timestamp with time zone, status_changed_at timestamp with time zone, active_jobs bigint)')
    ) AS expected(fn_name, args, result)
  LOOP
    -- Exactly one function of that name: a recreate left no old overload.
    IF (SELECT count(*) FROM pg_proc p
         WHERE p.pronamespace = 'public'::regnamespace AND p.proname = spec.fn_name) <> 1 THEN
      RAISE EXCEPTION 'migration 139: public.% is missing or overloaded', spec.fn_name;
    END IF;
    SELECT p.oid, owner.rolname AS owner_name, p.prosecdef, p.proconfig,
           pg_get_function_arguments(p.oid) AS args, pg_get_function_result(p.oid) AS result
      INTO fn
      FROM pg_proc p JOIN pg_roles owner ON owner.oid = p.proowner
     WHERE p.pronamespace = 'public'::regnamespace AND p.proname = spec.fn_name;
    IF fn.owner_name IS DISTINCT FROM 'jale_admin' OR NOT fn.prosecdef
       OR fn.proconfig IS DISTINCT FROM ARRAY['search_path=pg_catalog, pg_temp']
       OR fn.args IS DISTINCT FROM spec.args OR fn.result IS DISTINCT FROM spec.result THEN
      RAISE EXCEPTION 'migration 139: public.% has the wrong owner, security, search_path, arguments or result', spec.fn_name;
    END IF;
    IF NOT has_function_privilege('jale_admin_console', fn.oid, 'EXECUTE') THEN
      RAISE EXCEPTION 'migration 139: public.% is not executable by the console', spec.fn_name;
    END IF;
    -- Exactly the owner and the console may execute (PUBLIC is grantee 0).
    IF EXISTS (
      SELECT 1 FROM pg_proc p, aclexplode(COALESCE(p.proacl, acldefault('f', p.proowner))) a
       WHERE p.oid = fn.oid AND a.privilege_type = 'EXECUTE'
         AND a.grantee NOT IN (p.proowner, 'jale_admin_console'::regrole::oid)
    ) THEN
      RAISE EXCEPTION 'migration 139: public.% is executable by a role other than its owner and the console', spec.fn_name;
    END IF;
  END LOOP;

  FOR pol IN
    SELECT * FROM (VALUES
      ('public.organization_members', 'organization_members_admin_analytics_read'),
      ('public.organization_invites', 'organization_invites_admin_analytics_read')
    ) AS expected(rel, name)
  LOOP
    IF NOT EXISTS (
      SELECT 1 FROM pg_policy p
       WHERE p.polrelid = pol.rel::regclass
         AND p.polname = pol.name
         AND p.polcmd = 'r'
         AND p.polpermissive
         AND p.polroles = ARRAY['jale_admin'::regrole::oid]
         AND pg_get_expr(p.polqual, p.polrelid) = v_gate
         AND p.polwithcheck IS NULL
    ) THEN
      RAISE EXCEPTION 'migration 139: policy % on % missing or drifted', pol.name, pol.rel;
    END IF;
  END LOOP;

  -- 098's pattern: clear the gate before EACH call and read it back.
  PERFORM set_config('app.admin_analytics_read', '', true);
  PERFORM * FROM public.admin_analytics_totals();
  IF current_setting('app.admin_analytics_read', true) IS DISTINCT FROM 'on' THEN
    RAISE EXCEPTION 'migration 139: admin_analytics_totals did not set the read flag';
  END IF;
  PERFORM set_config('app.admin_analytics_read', '', true);
  PERFORM * FROM public.admin_analytics_signups(now(), 'day');
  IF current_setting('app.admin_analytics_read', true) IS DISTINCT FROM 'on' THEN
    RAISE EXCEPTION 'migration 139: admin_analytics_signups did not set the read flag';
  END IF;
  PERFORM set_config('app.admin_analytics_read', '', true);
  PERFORM * FROM public.admin_analytics_acquisition(1);
  IF current_setting('app.admin_analytics_read', true) IS DISTINCT FROM 'on' THEN
    RAISE EXCEPTION 'migration 139: admin_analytics_acquisition did not set the read flag';
  END IF;
  PERFORM set_config('app.admin_analytics_read', '', true);
  PERFORM * FROM public.admin_analytics_paying_weekly(1);
  IF current_setting('app.admin_analytics_read', true) IS DISTINCT FROM 'on' THEN
    RAISE EXCEPTION 'migration 139: admin_analytics_paying_weekly did not set the read flag';
  END IF;
  PERFORM set_config('app.admin_analytics_read', '', true);
  PERFORM * FROM public.admin_analytics_template_reuse(1);
  IF current_setting('app.admin_analytics_read', true) IS DISTINCT FROM 'on' THEN
    RAISE EXCEPTION 'migration 139: admin_analytics_template_reuse did not set the read flag';
  END IF;
  PERFORM set_config('app.admin_analytics_read', '', true);
  PERFORM * FROM public.admin_analytics_paying_employers();
  IF current_setting('app.admin_analytics_read', true) IS DISTINCT FROM 'on' THEN
    RAISE EXCEPTION 'migration 139: admin_analytics_paying_employers did not set the read flag';
  END IF;
  -- The old console passes employer_id to the audit as a subject: never NULL.
  PERFORM set_config('app.admin_analytics_read', '', true);
  IF EXISTS (SELECT 1 FROM public.admin_analytics_slowest_employers(26, 100) WHERE employer_id IS NULL) THEN
    RAISE EXCEPTION 'migration 139: admin_analytics_slowest_employers returned a NULL employer_id';
  END IF;
  IF current_setting('app.admin_analytics_read', true) IS DISTINCT FROM 'on' THEN
    RAISE EXCEPTION 'migration 139: admin_analytics_slowest_employers did not set the read flag';
  END IF;
  PERFORM set_config('app.admin_analytics_read', '', true);
  PERFORM * FROM public.admin_analytics_companies(500);
  IF current_setting('app.admin_analytics_read', true) IS DISTINCT FROM 'on' THEN
    RAISE EXCEPTION 'migration 139: admin_analytics_companies did not set the read flag';
  END IF;
  PERFORM set_config('app.admin_analytics_read', '', true);
  PERFORM * FROM public.admin_analytics_companies(1, gen_random_uuid());
  IF current_setting('app.admin_analytics_read', true) IS DISTINCT FROM 'on' THEN
    RAISE EXCEPTION 'migration 139: admin_analytics_companies did not set the read flag';
  END IF;
  -- company_members opens both gates.
  PERFORM set_config('app.admin_analytics_read', '', true);
  PERFORM set_config('app.employer_name_lookup', '', true);
  PERFORM * FROM public.admin_analytics_company_members(gen_random_uuid());
  IF current_setting('app.admin_analytics_read', true) IS DISTINCT FROM 'on' THEN
    RAISE EXCEPTION 'migration 139: admin_analytics_company_members did not set the read flag';
  END IF;
  IF current_setting('app.employer_name_lookup', true) IS DISTINCT FROM 'on' THEN
    RAISE EXCEPTION 'migration 139: admin_analytics_company_members did not set the name lookup flag';
  END IF;

  -- Each argument check raises its own code.
  FOR bad IN
    SELECT * FROM (VALUES
      ('SELECT * FROM public.admin_analytics_companies(0)', 'admin_analytics_invalid_limit'),
      ('SELECT * FROM public.admin_analytics_companies(501)', 'admin_analytics_invalid_limit'),
      ('SELECT * FROM public.admin_analytics_companies(NULL)', 'admin_analytics_invalid_limit'),
      ('SELECT * FROM public.admin_analytics_company_members(NULL)', 'admin_analytics_invalid_organization'),
      ('SELECT * FROM public.admin_analytics_slowest_employers(4, 0)', 'admin_analytics_invalid_limit'),
      ('SELECT * FROM public.admin_analytics_slowest_employers(4, 101)', 'admin_analytics_invalid_limit'),
      ('SELECT * FROM public.admin_analytics_slowest_employers(27)', 'admin_analytics_invalid_weeks'),
      ('SELECT * FROM public.admin_analytics_acquisition(0)', 'admin_analytics_invalid_weeks'),
      ('SELECT * FROM public.admin_analytics_paying_weekly(27)', 'admin_analytics_invalid_weeks'),
      ('SELECT * FROM public.admin_analytics_template_reuse(0)', 'admin_analytics_invalid_weeks'),
      ('SELECT * FROM public.admin_analytics_signups(NULL, ''week'')', 'admin_analytics_invalid_from'),
      ('SELECT * FROM public.admin_analytics_signups(now(), ''month'')', 'admin_analytics_invalid_bucket')
    ) AS expected(q, err)
  LOOP
    BEGIN
      EXECUTE bad.q;
      v_raised := false;
    EXCEPTION WHEN raise_exception THEN
      v_raised := SQLERRM = bad.err;
    END;
    IF NOT v_raised THEN
      RAISE EXCEPTION 'migration 139: % did not raise %', bad.q, bad.err;
    END IF;
  END LOOP;
END $$;

-- ── 5b. The release invariant: the figures after 139 ───────
-- Section 0b's figures again, now from the new bodies. Only while no company
-- has a foreman must they match; once one does, the company figures are
-- meant to differ and the comparison is skipped with a notice. The foreman
-- check reads organization_members through this migration's own gated
-- policy (the self-check above proved it). A figure that differs aborts the
-- apply, which leaves the old bodies in place.
DO $$
DECLARE
  f       RECORD;
  v_after JSONB;
BEGIN
  PERFORM set_config('app.admin_analytics_read', 'on', true);
  IF EXISTS (SELECT 1 FROM public.organization_members m WHERE m.role = 'foreman') THEN
    RAISE NOTICE 'migration 139: a company has a foreman, so the company figures may differ from the per-login ones; the release invariant was not compared';
    RETURN;
  END IF;

  FOR f IN
    SELECT q.ord, q.figure, q.sql, b.value AS before
      FROM pg_temp.m139_figure_sql q
      JOIN pg_temp.m139_figures_before b ON b.ord = q.ord
     ORDER BY q.ord
  LOOP
    PERFORM set_config('app.admin_analytics_read', '', true);
    EXECUTE f.sql INTO v_after;
    IF v_after IS DISTINCT FROM f.before THEN
      RAISE EXCEPTION 'migration 139: with no foreman in any company, % differs from the per-login figure (before %, after %)',
        f.figure, left(f.before::text, 300), left(v_after::text, 300);
    END IF;
  END LOOP;

  -- Every figure was compared.
  IF (SELECT count(*) FROM pg_temp.m139_figures_before) <> 8 THEN
    RAISE EXCEPTION 'migration 139: the release invariant compared % figures, not 8',
      (SELECT count(*) FROM pg_temp.m139_figures_before);
  END IF;
END $$;

COMMIT;
