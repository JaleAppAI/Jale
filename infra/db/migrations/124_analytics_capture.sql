-- ============================================================
-- 124_analytics_capture.sql
-- Run manually AFTER 123 (sprint 28), connected as jale_admin. Forward-only
-- (ADR-005). ONE transaction. It reads nothing created after 117, so the
-- runner may apply it right after 117 on a bed that lacks 120-123.
--
-- Sprint 28, admin analytics items 16, 17, 18, 20 and 21: start collecting
-- the data those panels need, and the console reads over it.
--
-- (1) Capture tables, each with row-level security enabled and forced, no
--     right for any runtime login, and rows that leave with their account
--     (ON DELETE CASCADE):
--       signup_attribution     where an account's signup started (#16): the
--                              door (web, whatsapp), the entry page (app,
--                              job_link, signup_page, whatsapp) and an
--                              optional first-party campaign code. One row
--                              per account; the first write wins.
--       worker_job_views       a signed-in worker opened a job page (#17):
--                              one row per worker, job and UTC hour, with
--                              where they came from (feed, public_link,
--                              whatsapp, direct).
--       referral_funnel_daily  daily referral counts by day, link kind
--                              (worker, employer) and share channel (#21):
--                              opens, apply intents, intents consumed,
--                              claims parked and claims claimed. Apply
--                              tokens are deleted about 8 days after they
--                              are made, so these counts keep the history.
--     jobs gains created_from_template_id (#18): the saved template the
--     employer started the job from, set by the create endpoint, NULL when
--     the template is later deleted. worker_job_impressions (010) gains an
--     index on delivered_at for the weekly reads.
--
-- (2) Capability owners (107's block): NOLOGIN, NOINHERIT, member of no role,
--     CREATE on jale_cap and not on public.
--       jale_cap_analytics_capture  the four capture functions
--       jale_cap_referral_snapshot  the daily referral snapshot
--     jale_cap_retention (105) is unchanged.
--
-- (3) Capture functions (jale_cap, 105's pattern: SECURITY DEFINER,
--     search_path pg_catalog, pg_temp, closed to PUBLIC):
--       record_signup_source(p_user, p_door, p_entry, p_src)
--           callers jale_api_public (worker web signup) and jale_api
--           (employer first profile save). Writes once per account, and only
--           for an account created in the last 24 hours, so a returning or
--           older account is never re-attributed. A door and entry that do
--           not belong together write nothing; a code that fails the stored
--           pattern is kept as no code. Returns whether a row was written.
--       record_job_view(p_job_id, p_source)
--           caller jale_api. The worker is app.current_internal_user_id
--           (unset or empty raises 42501). One row per worker, job and hour.
--       record_feed_impressions(p_job_ids)
--           caller jale_api. The worker is app.current_internal_user_id. One
--           worker_job_impressions row per job, channel api, window the UTC
--           day (YYYY-MM-DD). Returns the rows written.
--       record_whatsapp_impressions(p_job_ids, p_alert_intent_id)
--           caller jale_whatsapp. As above, channel whatsapp; the window is
--           alert:<intent id> for a job alert, else list:<UTC day> for a job
--           list. 010's unique window (worker, job, window) has no channel,
--           so a list shown the same day as the web feed needs its own key
--           space or one channel's showing would be dropped.
--     Every write is INSERT ... ON CONFLICT DO NOTHING, so a repeat is a
--     no-op. A job or account removed meanwhile writes nothing and is not an
--     error; in a batch of showings only that job is left out. The callers wrap each call in a savepoint and never fail a
--     request because of it.
--
-- (4) referral_funnel_snapshot() (jale_cap, caller jale_job_retention, run by
--     the retention sweeper BEFORE retention_purge). Only tagged events count
--     (a share code whose link still exists); each counter is keyed by its
--     own event day (opens by opened_at, apply intents by the token's
--     created_at, intents consumed by consumed_at, claims parked by the
--     claim's created_at, claims claimed by claimed_at), and link_kind is
--     worker when the link names a referring worker, else employer (the
--     employer-minted links and 056's organic employer shares). A run
--     recomputes today and the two days before. After missed runs it also
--     recomputes the last day written (which may have been written part-way
--     through) and covers every day after it. On an empty table it covers
--     every day that still has a tagged apply token or claim. A day is only
--     ever rewritten while every row it counts still exists: today and the
--     six days before (apply tokens are purged 8 days after they are made);
--     its owner's DELETE policy reaches no further. Idempotent: a second run
--     writes the same rows. This file runs it once (the backfill at apply).
--
-- (5) Console reads (owner jale_admin, EXECUTE jale_admin_console only,
--     114's pattern: argument checked first, then the transaction-local gate
--     app.admin_analytics_read opens): admin_analytics_acquisition,
--     _job_views, _template_reuse, _match_to_apply and _referral_funnel, each
--     (p_weeks 1..26). Rows are zero-filled Monday 00:00 UTC weeks, oldest
--     first; the last is the current week (partial = true); no whole-window
--     row. Counts only; collecting_since (snapshots_since for #21) repeats on
--     every row and is NULL until the first captured row. No test-account
--     exclusion, the rule of admin_analytics_signups, so #16's total matches
--     the signups chart.
--       acquisition     accounts (workers and employers) created per week by
--                       source: campaign_tag (a code), referral (a referral
--                       first touch), shared_link (started on a job page),
--                       direct (web, no code), whatsapp_entry (no web source
--                       and first contact on WhatsApp), unknown.
--       job_views       public page opens; applications to a job the
--                       worker's shared-link credit names (the referral
--                       first or latest touch, as #21 counts them); distinct
--                       (worker, job) views; and those applied to at or after
--                       the first view that week, within 7 days.
--       template_reuse  jobs posted, posted from a template, employers doing
--                       so, templates first saved.
--       match_to_apply  per channel (web, whatsapp): distinct (worker, job)
--                       pairs shown, and those applied to at or after the
--                       first showing that week, within 7 days.
--       referral_funnel tagged opens; apply intents and claims claimed from
--                       the snapshots; applications and hires whose referral
--                       credit names the job.
--     Gated reads for them are added on the three new tables and on
--     worker_job_impressions, employer_job_templates, job_share_opens and
--     worker_attribution (SELECT TO jale_admin, only while a definer has
--     opened the gate). users, jobs, job_applications and
--     whatsapp_conversations already have theirs (checked below).
--     worker_referred_jobs (103) is not read: 103 accepts no policy on it
--     beyond its own two and their reviewed copies.
--
-- ACCESS. The owners' rights are column grants plus policies TO the owner
-- only (sections 6, 7 and 9). The callers already hold USAGE on jale_cap.
-- infra/db/access/manifest.d/analytics-capture.json records all of it.
--
-- DEPLOY ORDER: apply BEFORE the release deploy. The new create-job code
-- writes jobs.created_from_template_id, and the new sweeper calls the
-- snapshot. The deployed code reads none of this, so it keeps working.
--
-- LOCKS. CREATE POLICY and ALTER TABLE hold ACCESS EXCLUSIVE on an existing
-- table (its reads and writes wait); CREATE INDEX holds SHARE on it, and a
-- foreign key SHARE ROW EXCLUSIVE on the table it references (writes wait);
-- each until COMMIT. So the functions come first; then the snapshot's rights
-- on the referral tables (written only by the public referral routes) and
-- the backfill; then, just before the self-audit, whose console reads need
-- them, the two tables that reference users and jobs, the jobs column, the
-- indexes, and the rights and policies on worker_job_impressions,
-- employer_job_templates and worker_attribution; then the self-audit; and
-- last the capture owner's rights and policies on users and jobs, which
-- nothing in this file needs. So while the self-audit runs, jobs (the
-- template-reuse read needs its new column) and those three tables are
-- locked exclusively and writes to users wait; users is locked exclusively
-- only from its policy, after the self-audit, to COMMIT.
--
-- REPLAY. Refused with a clear message once the capture tables exist. Nothing
-- is partially applied, because the file is one transaction.
-- ============================================================
BEGIN;

-- The policies, the jobs column and the indexes lock existing tables (see
-- LOCKS above); never queue behind a stuck transaction (a timed-out apply
-- writes no ledger row and can be rerun).
SET LOCAL lock_timeout = '5s';

-- ── Preconditions ───────────────────────────────────────────
DO $$
DECLARE
  v_gate CONSTANT TEXT := $q$(current_setting('app.admin_analytics_read'::text, true) = 'on'::text)$q$;
  pol RECORD;
BEGIN
  IF pg_catalog.to_regnamespace('jale_cap') IS NULL
     OR (SELECT count(*) FROM pg_catalog.pg_roles
          WHERE rolname IN ('jale_api', 'jale_api_public', 'jale_whatsapp', 'jale_job_retention',
                            'jale_admin_console')) <> 5 THEN
    RAISE EXCEPTION 'migration 124: apply the least-privilege migrations first (jale_cap or a caller login is missing)';
  END IF;
  IF pg_catalog.to_regclass('public.signup_attribution') IS NOT NULL
     OR pg_catalog.to_regclass('public.worker_job_views') IS NOT NULL
     OR pg_catalog.to_regclass('public.referral_funnel_daily') IS NOT NULL THEN
    RAISE EXCEPTION 'migration 124: already applied (the capture tables exist); it is not re-runnable';
  END IF;

  -- pg_policy is a catalog table, so row security never filters this check;
  -- a missing gate would make a panel read zero rows.
  FOR pol IN
    SELECT * FROM (VALUES
      ('public.users', 'users_admin_analytics_read'),
      ('public.jobs', 'jobs_admin_analytics_read'),
      ('public.job_applications', 'job_applications_admin_analytics_read'),
      ('public.whatsapp_conversations', 'whatsapp_conversations_admin_analytics_read')
    ) AS expected(rel, name)
  LOOP
    IF NOT EXISTS (
      SELECT 1 FROM pg_catalog.pg_policy p
       WHERE p.polrelid = pol.rel::regclass
         AND p.polname = pol.name
         AND p.polcmd = 'r'
         AND p.polpermissive
         AND p.polroles = ARRAY['jale_admin'::regrole::oid]
         AND pg_catalog.pg_get_expr(p.polqual, p.polrelid) = v_gate
    ) THEN
      RAISE EXCEPTION 'migration 124: policy % on % missing or drifted; a panel would read zero rows', pol.name, pol.rel;
    END IF;
  END LOOP;

  -- A RESTRICTIVE policy is AND'ed with every gate, so one for jale_admin or
  -- PUBLIC (role 0) on a table read here could zero a panel just as silently.
  IF EXISTS (
    SELECT 1 FROM pg_catalog.pg_policy p
     WHERE p.polrelid IN ('public.users'::regclass, 'public.jobs'::regclass, 'public.job_applications'::regclass,
                          'public.whatsapp_conversations'::regclass, 'public.worker_job_impressions'::regclass,
                          'public.employer_job_templates'::regclass, 'public.job_share_opens'::regclass,
                          'public.worker_attribution'::regclass)
       AND NOT p.polpermissive
       AND ('jale_admin'::regrole::oid = ANY (p.polroles) OR 0::OID = ANY (p.polroles))
  ) THEN
    RAISE EXCEPTION 'migration 124: a restrictive policy for jale_admin or PUBLIC on a table a panel reads; it would hide rows';
  END IF;
END $$;

-- ── 1. The snapshot table (references nothing) ──────────────
CREATE TABLE public.referral_funnel_daily (
  day              DATE   NOT NULL,
  link_kind        TEXT   NOT NULL CHECK (link_kind IN ('worker', 'employer')),
  -- The share link's channel, copied as it is (056's vocabulary today).
  channel          TEXT   NOT NULL CHECK (channel ~ '^[a-z_]{1,32}$'),
  opens            BIGINT NOT NULL DEFAULT 0 CHECK (opens >= 0),
  apply_intents    BIGINT NOT NULL DEFAULT 0 CHECK (apply_intents >= 0),
  intents_consumed BIGINT NOT NULL DEFAULT 0 CHECK (intents_consumed >= 0),
  claims_parked    BIGINT NOT NULL DEFAULT 0 CHECK (claims_parked >= 0),
  claims_claimed   BIGINT NOT NULL DEFAULT 0 CHECK (claims_claimed >= 0),
  PRIMARY KEY (day, link_kind, channel)
);
ALTER TABLE public.referral_funnel_daily ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.referral_funnel_daily FORCE ROW LEVEL SECURITY;

-- ── 2. Capability owners (107's block) ──────────────────────
DO $$
DECLARE
  owner_role TEXT;
  helper pg_catalog.pg_roles%ROWTYPE;
BEGIN
  FOREACH owner_role IN ARRAY ARRAY['jale_cap_analytics_capture', 'jale_cap_referral_snapshot'] LOOP
    SELECT * INTO helper FROM pg_catalog.pg_roles WHERE rolname = owner_role;
    IF NOT FOUND THEN
      EXECUTE format(
        'CREATE ROLE %I NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS',
        owner_role
      );
      SELECT * INTO helper FROM pg_catalog.pg_roles WHERE rolname = owner_role;
    END IF;

    IF helper.rolcanlogin OR helper.rolsuper OR helper.rolcreatedb OR helper.rolcreaterole
       OR helper.rolinherit OR helper.rolreplication OR helper.rolbypassrls THEN
      RAISE EXCEPTION 'migration 124: existing role % has unsafe attributes', owner_role;
    END IF;

    -- An owner belongs to no role, and its only member is the creator's
    -- ADMIN-only row.
    IF EXISTS (
      SELECT 1 FROM pg_catalog.pg_auth_members am
       WHERE am.member = helper.oid
          OR (am.roleid = helper.oid
              AND NOT (am.member = (SELECT oid FROM pg_catalog.pg_roles WHERE rolname = current_user)
                       AND am.admin_option AND NOT am.inherit_option AND NOT am.set_option))
    ) THEN
      RAISE EXCEPTION 'migration 124: role % has unsafe memberships', owner_role;
    END IF;

    IF NOT EXISTS (
      SELECT 1 FROM pg_catalog.pg_auth_members am
       WHERE am.roleid = helper.oid
         AND am.member = (SELECT oid FROM pg_catalog.pg_roles WHERE rolname = current_user)
         AND am.admin_option
    ) THEN
      EXECUTE format('GRANT %I TO %I WITH ADMIN TRUE, INHERIT FALSE, SET FALSE', owner_role, current_user);
    END IF;
  END LOOP;
END;
$$;

-- ALTER FUNCTION ... OWNER TO needs the new owner to hold CREATE on the
-- function's schema.
GRANT CREATE ON SCHEMA jale_cap TO jale_cap_analytics_capture, jale_cap_referral_snapshot;

-- ── 3. Capture functions ────────────────────────────────────
CREATE FUNCTION jale_cap.record_signup_source(
  p_user  UUID,
  p_door  TEXT,
  p_entry TEXT,
  p_src   TEXT
)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $fn$
DECLARE
  v_rows INTEGER := 0;
BEGIN
  IF p_user IS NULL
     OR p_door IS NULL OR p_door NOT IN ('web', 'whatsapp')
     OR p_entry IS NULL OR p_entry NOT IN ('app', 'job_link', 'signup_page', 'whatsapp')
     OR (p_door = 'whatsapp') <> (p_entry = 'whatsapp') THEN
    RETURN false;
  END IF;

  -- First write wins, and only for an account created in the last 24 hours.
  BEGIN
    INSERT INTO public.signup_attribution (user_id, door, entry, src)
    SELECT u.id, p_door, p_entry,
           CASE WHEN p_src ~ '^[a-z0-9-]{2,32}$' THEN p_src END
      FROM public.users u
     WHERE u.id = p_user
       AND u.created_at > now() - interval '24 hours'
    ON CONFLICT DO NOTHING;
    GET DIAGNOSTICS v_rows = ROW_COUNT;
  EXCEPTION WHEN foreign_key_violation THEN
    -- The account was removed meanwhile.
    RETURN false;
  END;
  RETURN v_rows = 1;
END;
$fn$;
REVOKE ALL ON FUNCTION jale_cap.record_signup_source(uuid, text, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION jale_cap.record_signup_source(uuid, text, text, text) TO jale_api_public, jale_api;

CREATE FUNCTION jale_cap.record_job_view(
  p_job_id UUID,
  p_source TEXT
)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $fn$
DECLARE
  v_caller TEXT := pg_catalog.current_setting('app.current_internal_user_id', true);
  v_rows   INTEGER := 0;
BEGIN
  IF v_caller IS NULL OR v_caller = '' THEN
    RAISE EXCEPTION 'record_job_view: no caller context' USING ERRCODE = '42501';
  END IF;
  IF p_job_id IS NULL OR p_source IS NULL
     OR p_source NOT IN ('feed', 'public_link', 'whatsapp', 'direct') THEN
    RETURN false;
  END IF;

  BEGIN
    INSERT INTO public.worker_job_views (worker_id, job_id, source, viewed_hour)
    VALUES (v_caller::uuid, p_job_id, p_source, date_trunc('hour', now(), 'UTC'))
    ON CONFLICT DO NOTHING;
    GET DIAGNOSTICS v_rows = ROW_COUNT;
  EXCEPTION WHEN foreign_key_violation THEN
    -- No such job (any longer).
    RETURN false;
  END;
  RETURN v_rows = 1;
END;
$fn$;
REVOKE ALL ON FUNCTION jale_cap.record_job_view(uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION jale_cap.record_job_view(uuid, text) TO jale_api;

CREATE FUNCTION jale_cap.record_feed_impressions(
  p_job_ids UUID[]
)
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $fn$
DECLARE
  v_caller TEXT := pg_catalog.current_setting('app.current_internal_user_id', true);
  v_rows   INTEGER := 0;
BEGIN
  IF v_caller IS NULL OR v_caller = '' THEN
    RAISE EXCEPTION 'record_feed_impressions: no caller context' USING ERRCODE = '42501';
  END IF;
  IF p_job_ids IS NULL OR pg_catalog.cardinality(p_job_ids) = 0 THEN
    RETURN 0;
  END IF;
  IF pg_catalog.cardinality(p_job_ids) > 200 THEN
    RAISE EXCEPTION 'record_feed_impressions: at most 200 jobs per call' USING ERRCODE = 'invalid_parameter_value';
  END IF;

  BEGIN
    INSERT INTO public.worker_job_impressions (worker_id, job_id, channel, impression_window_key)
    SELECT v_caller::uuid, j.job_id, 'api', to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD')
      FROM (SELECT DISTINCT x AS job_id FROM unnest(p_job_ids) AS x WHERE x IS NOT NULL) j
     WHERE EXISTS (SELECT 1 FROM public.jobs jb WHERE jb.id = j.job_id)
    ON CONFLICT DO NOTHING;
    GET DIAGNOSTICS v_rows = ROW_COUNT;
  EXCEPTION WHEN foreign_key_violation THEN
    -- A listed job was removed after the check above, in the same instant;
    -- this showing is not recorded.
    RETURN 0;
  END;
  RETURN v_rows;
END;
$fn$;
REVOKE ALL ON FUNCTION jale_cap.record_feed_impressions(uuid[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION jale_cap.record_feed_impressions(uuid[]) TO jale_api;

CREATE FUNCTION jale_cap.record_whatsapp_impressions(
  p_job_ids         UUID[],
  p_alert_intent_id UUID
)
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $fn$
DECLARE
  v_caller TEXT := pg_catalog.current_setting('app.current_internal_user_id', true);
  v_rows   INTEGER := 0;
BEGIN
  IF v_caller IS NULL OR v_caller = '' THEN
    RAISE EXCEPTION 'record_whatsapp_impressions: no caller context' USING ERRCODE = '42501';
  END IF;
  IF p_job_ids IS NULL OR pg_catalog.cardinality(p_job_ids) = 0 THEN
    RETURN 0;
  END IF;
  IF pg_catalog.cardinality(p_job_ids) > 200 THEN
    RAISE EXCEPTION 'record_whatsapp_impressions: at most 200 jobs per call' USING ERRCODE = 'invalid_parameter_value';
  END IF;

  BEGIN
    INSERT INTO public.worker_job_impressions (worker_id, job_id, channel, impression_window_key)
    SELECT v_caller::uuid, j.job_id, 'whatsapp',
           CASE WHEN p_alert_intent_id IS NOT NULL THEN 'alert:' || p_alert_intent_id::text
                ELSE 'list:' || to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD') END
      FROM (SELECT DISTINCT x AS job_id FROM unnest(p_job_ids) AS x WHERE x IS NOT NULL) j
     WHERE EXISTS (SELECT 1 FROM public.jobs jb WHERE jb.id = j.job_id)
    ON CONFLICT DO NOTHING;
    GET DIAGNOSTICS v_rows = ROW_COUNT;
  EXCEPTION WHEN foreign_key_violation THEN
    RETURN 0;
  END;
  RETURN v_rows;
END;
$fn$;
REVOKE ALL ON FUNCTION jale_cap.record_whatsapp_impressions(uuid[], uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION jale_cap.record_whatsapp_impressions(uuid[], uuid) TO jale_whatsapp;

-- ── 4. The daily referral snapshot ──────────────────────────
CREATE FUNCTION jale_cap.referral_funnel_snapshot()
RETURNS TABLE (days_covered INTEGER, rows_written INTEGER)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $fn$
#variable_conflict use_column
DECLARE
  v_today   DATE := (now() AT TIME ZONE 'UTC')::date;
  v_from    DATE := (now() AT TIME ZONE 'UTC')::date - 2;
  -- The oldest day whose counted rows all still exist, whenever the last
  -- purge ran: an apply token is purged 8 days after it is made, and a used
  -- one counts on the day after it was made. The DELETE policy matches.
  v_horizon DATE := (now() AT TIME ZONE 'UTC')::date - 6;
  v_last    DATE;
  v_first   DATE;
  v_from_ts TIMESTAMPTZ;
  v_rows    INTEGER := 0;
BEGIN
  -- One run at a time (a manual run beside the schedule).
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('jale_cap.referral_funnel_snapshot', 0));

  SELECT max(d.day) INTO v_last FROM public.referral_funnel_daily d;
  IF v_last IS NULL THEN
    -- First run: every day that still has a tagged apply token or claim.
    SELECT min(x.day) INTO v_first
      FROM (
        SELECT min((t.created_at AT TIME ZONE 'UTC')::date) AS day
          FROM public.referral_apply_tokens t WHERE t.share_code IS NOT NULL
        UNION ALL
        SELECT min((c.created_at AT TIME ZONE 'UTC')::date)
          FROM public.referral_pending_claims c WHERE c.share_code IS NOT NULL
      ) x;
    v_from := LEAST(v_from, COALESCE(v_first, v_from));
  ELSIF v_last < v_from THEN
    -- Runs were missed. The last day written may have been written part-way
    -- through; recompute it too while its rows all still exist, and cover
    -- every day after it. A last day older than that is kept as written.
    v_from := CASE WHEN v_last >= v_horizon THEN v_last ELSE v_last + 1 END;
  END IF;
  v_from_ts := v_from::timestamp AT TIME ZONE 'UTC';

  DELETE FROM public.referral_funnel_daily d WHERE d.day >= v_from;

  INSERT INTO public.referral_funnel_daily
    (day, link_kind, channel, opens, apply_intents, intents_consumed, claims_parked, claims_claimed)
  SELECT ev.day,
         CASE WHEN l.referrer_worker_id IS NOT NULL THEN 'worker' ELSE 'employer' END,
         l.channel,
         count(*) FILTER (WHERE ev.kind = 'open'),
         count(*) FILTER (WHERE ev.kind = 'intent'),
         count(*) FILTER (WHERE ev.kind = 'consumed'),
         count(*) FILTER (WHERE ev.kind = 'parked'),
         count(*) FILTER (WHERE ev.kind = 'claimed')
    FROM (
      SELECT (o.opened_at AT TIME ZONE 'UTC')::date AS day, o.share_code, 'open'::text AS kind
        FROM public.job_share_opens o
       WHERE o.share_code IS NOT NULL AND o.opened_at >= v_from_ts
      UNION ALL
      SELECT (t.created_at AT TIME ZONE 'UTC')::date, t.share_code, 'intent'
        FROM public.referral_apply_tokens t
       WHERE t.share_code IS NOT NULL AND t.created_at >= v_from_ts
      UNION ALL
      SELECT (t.consumed_at AT TIME ZONE 'UTC')::date, t.share_code, 'consumed'
        FROM public.referral_apply_tokens t
       WHERE t.share_code IS NOT NULL AND t.consumed_at >= v_from_ts
      UNION ALL
      SELECT (c.created_at AT TIME ZONE 'UTC')::date, c.share_code, 'parked'
        FROM public.referral_pending_claims c
       WHERE c.share_code IS NOT NULL AND c.created_at >= v_from_ts
      UNION ALL
      SELECT (c.claimed_at AT TIME ZONE 'UTC')::date, c.share_code, 'claimed'
        FROM public.referral_pending_claims c
       WHERE c.share_code IS NOT NULL AND c.claimed_at >= v_from_ts
    ) ev
    JOIN public.job_share_links l ON l.code = ev.share_code
   WHERE ev.day <= v_today
   GROUP BY 1, 2, 3
  ON CONFLICT DO NOTHING;
  GET DIAGNOSTICS v_rows = ROW_COUNT;

  RETURN QUERY SELECT (v_today - v_from + 1)::INTEGER, v_rows;
END;
$fn$;
REVOKE ALL ON FUNCTION jale_cap.referral_funnel_snapshot() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION jale_cap.referral_funnel_snapshot() TO jale_job_retention;

-- ── 5. Console reads ────────────────────────────────────────
-- #16: accounts created per week, by where the signup started.
CREATE FUNCTION public.admin_analytics_acquisition(p_weeks INTEGER)
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

-- #17: public page opens and signed-in job views, each with the applications
-- that followed.
CREATE FUNCTION public.admin_analytics_job_views(p_weeks INTEGER)
RETURNS TABLE (
  week_start               TIMESTAMPTZ,
  partial                  BOOLEAN,
  public_opens             BIGINT,
  public_applications      BIGINT,
  worker_views             BIGINT,
  worker_view_applications BIGINT,
  collecting_since         TIMESTAMPTZ
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

  PERFORM set_config('app.admin_analytics_read', 'on', true);

  v_week0 := date_trunc('week', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC';
  v_from := (date_trunc('week', now() AT TIME ZONE 'UTC') - make_interval(weeks => p_weeks - 1)) AT TIME ZONE 'UTC';

  RETURN QUERY
  WITH weeks AS (
    SELECT (date_trunc('week', now() AT TIME ZONE 'UTC') - make_interval(weeks => g.n)) AT TIME ZONE 'UTC' AS wk
      FROM generate_series(0, p_weeks - 1) AS g(n)
  ), opens AS (
    SELECT date_trunc('week', o.opened_at, 'UTC') AS wk, count(*) AS n
      FROM public.job_share_opens o
     WHERE o.opened_at >= v_from
     GROUP BY 1
  ), public_apps AS (
    -- Applications to a job the worker's shared-link credit names (the
    -- referral first or latest touch, tagged).
    SELECT date_trunc('week', a.applied_at, 'UTC') AS wk, count(*) AS n
      FROM public.job_applications a
     WHERE a.applied_at >= v_from
       AND EXISTS (
         SELECT 1 FROM public.worker_attribution wa
          WHERE wa.worker_id = a.worker_id
            AND ((wa.first_job_id = a.job_id AND wa.first_share_code IS NOT NULL)
              OR (wa.latest_job_id = a.job_id AND wa.latest_share_code IS NOT NULL))
       )
     GROUP BY 1
  ), views AS (
    SELECT date_trunc('week', v.viewed_hour, 'UTC') AS wk, v.worker_id, v.job_id, min(v.viewed_hour) AS first_view
      FROM public.worker_job_views v
     WHERE v.viewed_hour >= v_from
     GROUP BY 1, 2, 3
  ), view_agg AS (
    SELECT vw.wk,
           count(*) AS n_views,
           count(*) FILTER (WHERE EXISTS (
             SELECT 1 FROM public.job_applications a
              WHERE a.job_id = vw.job_id AND a.worker_id = vw.worker_id
                AND a.applied_at >= vw.first_view
                AND a.applied_at < vw.first_view + interval '7 days'
           )) AS n_applied
      FROM views vw
     GROUP BY vw.wk
  ), since AS (
    SELECT min(v.viewed_hour) AS at FROM public.worker_job_views v
  )
  SELECT w.wk,
         w.wk = v_week0,
         COALESCE(o.n, 0),
         COALESCE(pa.n, 0),
         COALESCE(va.n_views, 0),
         COALESCE(va.n_applied, 0),
         (SELECT s.at FROM since s)
    FROM weeks w
    LEFT JOIN opens o ON o.wk = w.wk
    LEFT JOIN public_apps pa ON pa.wk = w.wk
    LEFT JOIN view_agg va ON va.wk = w.wk
   ORDER BY w.wk;
END $$;

-- #18: jobs posted and how many started from a saved template.
CREATE FUNCTION public.admin_analytics_template_reuse(p_weeks INTEGER)
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
           count(DISTINCT j.employer_id) FILTER (WHERE j.created_from_template_id IS NOT NULL) AS n_employers
      FROM public.jobs j
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

-- #20: jobs shown to workers per channel, and those applied to within 7 days.
CREATE FUNCTION public.admin_analytics_match_to_apply(p_weeks INTEGER)
RETURNS TABLE (
  week_start        TIMESTAMPTZ,
  partial           BOOLEAN,
  channel           TEXT,
  shown             BIGINT,
  applied_within_7d BIGINT,
  collecting_since  TIMESTAMPTZ
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

  PERFORM set_config('app.admin_analytics_read', 'on', true);

  v_week0 := date_trunc('week', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC';
  v_from := (date_trunc('week', now() AT TIME ZONE 'UTC') - make_interval(weeks => p_weeks - 1)) AT TIME ZONE 'UTC';

  RETURN QUERY
  WITH weeks AS (
    SELECT (date_trunc('week', now() AT TIME ZONE 'UTC') - make_interval(weeks => g.n)) AT TIME ZONE 'UTC' AS wk
      FROM generate_series(0, p_weeks - 1) AS g(n)
  ), grid AS (
    SELECT w.wk, ch.ch FROM weeks w CROSS JOIN (VALUES ('web'::text), ('whatsapp'::text)) AS ch(ch)
  ), pairs AS (
    SELECT date_trunc('week', i.delivered_at, 'UTC') AS wk,
           CASE WHEN i.channel = 'api' THEN 'web' ELSE 'whatsapp' END AS ch,
           i.worker_id, i.job_id, min(i.delivered_at) AS first_shown
      FROM public.worker_job_impressions i
     WHERE i.delivered_at >= v_from
     GROUP BY 1, 2, 3, 4
  ), agg AS (
    SELECT p.wk, p.ch,
           count(*) AS n_shown,
           count(*) FILTER (WHERE EXISTS (
             SELECT 1 FROM public.job_applications a
              WHERE a.job_id = p.job_id AND a.worker_id = p.worker_id
                AND a.applied_at >= p.first_shown
                AND a.applied_at < p.first_shown + interval '7 days'
           )) AS n_applied
      FROM pairs p
     GROUP BY p.wk, p.ch
  ), since AS (
    SELECT min(i.delivered_at) AS at FROM public.worker_job_impressions i
  )
  SELECT g.wk,
         g.wk = v_week0,
         g.ch,
         COALESCE(a.n_shown, 0),
         COALESCE(a.n_applied, 0),
         (SELECT s.at FROM since s)
    FROM grid g
    LEFT JOIN agg a ON a.wk = g.wk AND a.ch = g.ch
   ORDER BY g.wk, g.ch;
END $$;

-- #21: the referral funnel per week.
CREATE FUNCTION public.admin_analytics_referral_funnel(p_weeks INTEGER)
RETURNS TABLE (
  week_start      TIMESTAMPTZ,
  partial         BOOLEAN,
  opens           BIGINT,
  apply_intents   BIGINT,
  claims          BIGINT,
  applications    BIGINT,
  hires           BIGINT,
  snapshots_since TIMESTAMPTZ
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

  PERFORM set_config('app.admin_analytics_read', 'on', true);

  v_week0 := date_trunc('week', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC';
  v_from := (date_trunc('week', now() AT TIME ZONE 'UTC') - make_interval(weeks => p_weeks - 1)) AT TIME ZONE 'UTC';

  RETURN QUERY
  WITH weeks AS (
    SELECT (date_trunc('week', now() AT TIME ZONE 'UTC') - make_interval(weeks => g.n)) AT TIME ZONE 'UTC' AS wk
      FROM generate_series(0, p_weeks - 1) AS g(n)
  ), opens AS (
    -- Opens are kept 400 days, longer than any window, so they are read live.
    SELECT date_trunc('week', o.opened_at, 'UTC') AS wk, count(*) AS n
      FROM public.job_share_opens o
     WHERE o.share_code IS NOT NULL AND o.opened_at >= v_from
     GROUP BY 1
  ), snap AS (
    SELECT date_trunc('week', d.day::timestamp) AT TIME ZONE 'UTC' AS wk,
           sum(d.apply_intents)::BIGINT AS n_intents,
           sum(d.claims_claimed)::BIGINT AS n_claims
      FROM public.referral_funnel_daily d
     WHERE d.day >= (v_from AT TIME ZONE 'UTC')::date
     GROUP BY 1
  ), referred AS (
    -- Applications whose worker's referral credit (first or latest touch,
    -- tagged) names that job.
    SELECT DISTINCT a.id, a.applied_at, a.hired_at
      FROM public.worker_attribution wa
      JOIN public.job_applications a
        ON a.worker_id = wa.worker_id
       AND ((a.job_id = wa.first_job_id AND wa.first_share_code IS NOT NULL)
         OR (a.job_id = wa.latest_job_id AND wa.latest_share_code IS NOT NULL))
  ), apps AS (
    SELECT date_trunc('week', r.applied_at, 'UTC') AS wk, count(*) AS n
      FROM referred r WHERE r.applied_at >= v_from GROUP BY 1
  ), hires AS (
    SELECT date_trunc('week', r.hired_at, 'UTC') AS wk, count(*) AS n
      FROM referred r WHERE r.hired_at >= v_from GROUP BY 1
  ), since AS (
    SELECT min(d.day)::timestamp AT TIME ZONE 'UTC' AS at FROM public.referral_funnel_daily d
  )
  SELECT w.wk,
         w.wk = v_week0,
         COALESCE(o.n, 0),
         COALESCE(s.n_intents, 0),
         COALESCE(s.n_claims, 0),
         COALESCE(ap.n, 0),
         COALESCE(h.n, 0),
         (SELECT x.at FROM since x)
    FROM weeks w
    LEFT JOIN opens o ON o.wk = w.wk
    LEFT JOIN snap s ON s.wk = w.wk
    LEFT JOIN apps ap ON ap.wk = w.wk
    LEFT JOIN hires h ON h.wk = w.wk
   ORDER BY w.wk;
END $$;

ALTER FUNCTION public.admin_analytics_acquisition(INTEGER) OWNER TO jale_admin;
ALTER FUNCTION public.admin_analytics_job_views(INTEGER) OWNER TO jale_admin;
ALTER FUNCTION public.admin_analytics_template_reuse(INTEGER) OWNER TO jale_admin;
ALTER FUNCTION public.admin_analytics_match_to_apply(INTEGER) OWNER TO jale_admin;
ALTER FUNCTION public.admin_analytics_referral_funnel(INTEGER) OWNER TO jale_admin;

REVOKE ALL ON FUNCTION public.admin_analytics_acquisition(INTEGER) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.admin_analytics_job_views(INTEGER) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.admin_analytics_template_reuse(INTEGER) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.admin_analytics_match_to_apply(INTEGER) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.admin_analytics_referral_funnel(INTEGER) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION public.admin_analytics_acquisition(INTEGER) TO jale_admin_console;
GRANT EXECUTE ON FUNCTION public.admin_analytics_job_views(INTEGER) TO jale_admin_console;
GRANT EXECUTE ON FUNCTION public.admin_analytics_template_reuse(INTEGER) TO jale_admin_console;
GRANT EXECUTE ON FUNCTION public.admin_analytics_match_to_apply(INTEGER) TO jale_admin_console;
GRANT EXECUTE ON FUNCTION public.admin_analytics_referral_funnel(INTEGER) TO jale_admin_console;

-- ── 6. The snapshot's rights, ownership and the backfill ────
-- Snapshot: reads the tagged referral events (share code and times only)
-- and the link's referrer and channel; rewrites only today and the six days
-- before (v_horizon in the function).
GRANT SELECT (share_code, created_at, consumed_at) ON public.referral_apply_tokens TO jale_cap_referral_snapshot;
CREATE POLICY referral_apply_tokens_cap_snapshot_select ON public.referral_apply_tokens
  AS PERMISSIVE FOR SELECT TO jale_cap_referral_snapshot
  USING (share_code IS NOT NULL);
GRANT SELECT (share_code, created_at, claimed_at) ON public.referral_pending_claims TO jale_cap_referral_snapshot;
CREATE POLICY referral_pending_claims_cap_snapshot_select ON public.referral_pending_claims
  AS PERMISSIVE FOR SELECT TO jale_cap_referral_snapshot
  USING (share_code IS NOT NULL);
GRANT SELECT (share_code, opened_at) ON public.job_share_opens TO jale_cap_referral_snapshot;
CREATE POLICY job_share_opens_cap_snapshot_select ON public.job_share_opens
  AS PERMISSIVE FOR SELECT TO jale_cap_referral_snapshot
  USING (share_code IS NOT NULL);
GRANT SELECT (code, referrer_worker_id, channel) ON public.job_share_links TO jale_cap_referral_snapshot;
CREATE POLICY job_share_links_cap_snapshot_select ON public.job_share_links
  AS PERMISSIVE FOR SELECT TO jale_cap_referral_snapshot
  USING (true);
GRANT SELECT, INSERT, DELETE ON public.referral_funnel_daily TO jale_cap_referral_snapshot;
CREATE POLICY referral_funnel_daily_cap_snapshot_select ON public.referral_funnel_daily
  AS PERMISSIVE FOR SELECT TO jale_cap_referral_snapshot
  USING (true);
CREATE POLICY referral_funnel_daily_cap_snapshot_insert ON public.referral_funnel_daily
  AS PERMISSIVE FOR INSERT TO jale_cap_referral_snapshot
  WITH CHECK (true);
CREATE POLICY referral_funnel_daily_cap_snapshot_delete ON public.referral_funnel_daily
  AS PERMISSIVE FOR DELETE TO jale_cap_referral_snapshot
  USING (day >= (now() AT TIME ZONE 'UTC')::date - 6);

-- Ownership transfer (082's window).
DO $$
DECLARE
  owner_role TEXT;
BEGIN
  FOREACH owner_role IN ARRAY ARRAY['jale_cap_analytics_capture', 'jale_cap_referral_snapshot'] LOOP
    EXECUTE format('GRANT %I TO %I WITH SET TRUE, INHERIT FALSE', owner_role, current_user);
  END LOOP;
END;
$$;

ALTER FUNCTION jale_cap.record_signup_source(uuid, text, text, text) OWNER TO jale_cap_analytics_capture;
ALTER FUNCTION jale_cap.record_job_view(uuid, text) OWNER TO jale_cap_analytics_capture;
ALTER FUNCTION jale_cap.record_feed_impressions(uuid[]) OWNER TO jale_cap_analytics_capture;
ALTER FUNCTION jale_cap.record_whatsapp_impressions(uuid[], uuid) OWNER TO jale_cap_analytics_capture;
ALTER FUNCTION jale_cap.referral_funnel_snapshot() OWNER TO jale_cap_referral_snapshot;

-- The one-time backfill at apply: the snapshot runs once as its owner, so it
-- reads exactly what the daily job will. The owner needs USAGE on jale_cap
-- to call its own function; it holds it only for this call.
GRANT USAGE ON SCHEMA jale_cap TO jale_cap_referral_snapshot;
SET LOCAL ROLE jale_cap_referral_snapshot;
DO $$
DECLARE
  r RECORD;
BEGIN
  SELECT * INTO r FROM jale_cap.referral_funnel_snapshot();
  RAISE NOTICE 'migration 124: referral snapshot backfill covered % days and wrote % rows', r.days_covered, r.rows_written;
END;
$$;
RESET ROLE;
REVOKE USAGE ON SCHEMA jale_cap FROM jale_cap_referral_snapshot;

DO $$
DECLARE
  owner_role TEXT;
BEGIN
  FOREACH owner_role IN ARRAY ARRAY['jale_cap_analytics_capture', 'jale_cap_referral_snapshot'] LOOP
    EXECUTE format('GRANT %I TO %I WITH SET FALSE, INHERIT FALSE', owner_role, current_user);
    EXECUTE format('REVOKE %I FROM %I GRANTED BY %I', owner_role, current_user, current_user);
  END LOOP;
END;
$$;

-- ── 7. The tables and rights on the tables every request uses ──
-- Just before the self-audit, whose console reads need them: from here to
-- COMMIT these tables stay locked (see LOCKS in the header).
CREATE TABLE public.signup_attribution (
  user_id    UUID        PRIMARY KEY REFERENCES public.users(id) ON DELETE CASCADE,
  door       TEXT        NOT NULL CHECK (door IN ('web', 'whatsapp')),
  entry      TEXT        NOT NULL CHECK (entry IN ('app', 'job_link', 'signup_page', 'whatsapp')),
  src        TEXT        CHECK (src IS NULL OR src ~ '^[a-z0-9-]{2,32}$'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- The WhatsApp door has only the WhatsApp entry, and the web door never.
  CONSTRAINT signup_attribution_door_entry CHECK ((door = 'whatsapp') = (entry = 'whatsapp'))
);
CREATE INDEX signup_attribution_created_idx ON public.signup_attribution (created_at);
ALTER TABLE public.signup_attribution ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.signup_attribution FORCE ROW LEVEL SECURITY;

CREATE TABLE public.worker_job_views (
  worker_id   UUID        NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  job_id      UUID        NOT NULL REFERENCES public.jobs(id) ON DELETE CASCADE,
  source      TEXT        NOT NULL CHECK (source IN ('feed', 'public_link', 'whatsapp', 'direct')),
  viewed_hour TIMESTAMPTZ NOT NULL CHECK (viewed_hour = date_trunc('hour', viewed_hour, 'UTC')),
  PRIMARY KEY (worker_id, job_id, viewed_hour)
);
CREATE INDEX worker_job_views_hour_idx ON public.worker_job_views (viewed_hour);
-- A job delete cascades here; this keeps that lookup an index scan.
CREATE INDEX worker_job_views_job_idx ON public.worker_job_views (job_id);
ALTER TABLE public.worker_job_views ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.worker_job_views FORCE ROW LEVEL SECURITY;

-- #18: forward-looking, no backfill. ON DELETE SET NULL: deleting a template
-- never blocks and never deletes a job.
ALTER TABLE public.jobs
  ADD COLUMN created_from_template_id UUID REFERENCES public.employer_job_templates(id) ON DELETE SET NULL;
CREATE INDEX jobs_created_from_template_idx ON public.jobs (created_from_template_id)
  WHERE created_from_template_id IS NOT NULL;

CREATE INDEX worker_job_impressions_delivered_idx ON public.worker_job_impressions (delivered_at);

-- Capture: inserts into the capture tables and worker_job_impressions (no
-- read, update or delete). Its reads of users and jobs come after the
-- self-audit (section 9).
GRANT INSERT (user_id, door, entry, src) ON public.signup_attribution TO jale_cap_analytics_capture;
CREATE POLICY signup_attribution_cap_capture_insert ON public.signup_attribution
  AS PERMISSIVE FOR INSERT TO jale_cap_analytics_capture
  WITH CHECK (created_at > now() - interval '1 hour');
GRANT INSERT (worker_id, job_id, source, viewed_hour) ON public.worker_job_views TO jale_cap_analytics_capture;
CREATE POLICY worker_job_views_cap_capture_insert ON public.worker_job_views
  AS PERMISSIVE FOR INSERT TO jale_cap_analytics_capture
  WITH CHECK (viewed_hour >= now() - interval '1 hour');
GRANT INSERT (worker_id, job_id, channel, impression_window_key) ON public.worker_job_impressions TO jale_cap_analytics_capture;
CREATE POLICY worker_job_impressions_cap_capture_insert ON public.worker_job_impressions
  AS PERMISSIVE FOR INSERT TO jale_cap_analytics_capture
  WITH CHECK (delivered_at > now() - interval '1 hour');

-- Gated reads for the console definers: SELECT only, and only while a definer
-- has set the transaction-local read flag.
CREATE POLICY signup_attribution_admin_analytics_read ON public.signup_attribution
  FOR SELECT TO jale_admin USING (current_setting('app.admin_analytics_read', true) = 'on');
CREATE POLICY worker_job_views_admin_analytics_read ON public.worker_job_views
  FOR SELECT TO jale_admin USING (current_setting('app.admin_analytics_read', true) = 'on');
CREATE POLICY referral_funnel_daily_admin_analytics_read ON public.referral_funnel_daily
  FOR SELECT TO jale_admin USING (current_setting('app.admin_analytics_read', true) = 'on');
CREATE POLICY worker_job_impressions_admin_analytics_read ON public.worker_job_impressions
  FOR SELECT TO jale_admin USING (current_setting('app.admin_analytics_read', true) = 'on');
CREATE POLICY employer_job_templates_admin_analytics_read ON public.employer_job_templates
  FOR SELECT TO jale_admin USING (current_setting('app.admin_analytics_read', true) = 'on');
CREATE POLICY job_share_opens_admin_analytics_read ON public.job_share_opens
  FOR SELECT TO jale_admin USING (current_setting('app.admin_analytics_read', true) = 'on');
CREATE POLICY worker_attribution_admin_analytics_read ON public.worker_attribution
  FOR SELECT TO jale_admin USING (current_setting('app.admin_analytics_read', true) = 'on');

-- ── 8. Self-audit ───────────────────────────────────────────
DO $$
DECLARE
  v_gate   CONSTANT TEXT := $q$(current_setting('app.admin_analytics_read'::text, true) = 'on'::text)$q$;
  spec     RECORD;
  fn_oid   OID;
  info     RECORD;
  grantee_name TEXT;
  owner_role TEXT;
  offender TEXT;
  fn_sig   TEXT;
  v_raised BOOLEAN;
  v_arg    INTEGER;
  rel      TEXT;
BEGIN
  -- The capture and snapshot functions: owner, definer, path, language,
  -- and exactly their callers.
  FOR spec IN
    SELECT * FROM (VALUES
      ('jale_cap.record_signup_source(uuid, text, text, text)', 'jale_cap_analytics_capture', ARRAY['jale_api', 'jale_api_public']),
      ('jale_cap.record_job_view(uuid, text)', 'jale_cap_analytics_capture', ARRAY['jale_api']),
      ('jale_cap.record_feed_impressions(uuid[])', 'jale_cap_analytics_capture', ARRAY['jale_api']),
      ('jale_cap.record_whatsapp_impressions(uuid[], uuid)', 'jale_cap_analytics_capture', ARRAY['jale_whatsapp']),
      ('jale_cap.referral_funnel_snapshot()', 'jale_cap_referral_snapshot', ARRAY['jale_job_retention'])
    ) AS t(signature, owner_role, callers)
  LOOP
    fn_oid := pg_catalog.to_regprocedure(spec.signature);
    SELECT pg_catalog.pg_get_userbyid(p.proowner) AS owner_name, p.prosecdef AS definer,
           p.proconfig AS config, l.lanname AS language
      INTO info
      FROM pg_catalog.pg_proc p
      JOIN pg_catalog.pg_language l ON l.oid = p.prolang
     WHERE p.oid = fn_oid;
    IF fn_oid IS NULL OR info.owner_name IS DISTINCT FROM spec.owner_role OR NOT info.definer
       OR info.config IS DISTINCT FROM ARRAY['search_path=pg_catalog, pg_temp']
       OR info.language <> 'plpgsql' THEN
      RAISE EXCEPTION 'migration 124: % has the wrong owner, security, search_path or language', spec.signature;
    END IF;

    SELECT string_agg(CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE pg_catalog.pg_get_userbyid(a.grantee) END, ', ')
      INTO grantee_name
      FROM pg_catalog.pg_proc p, aclexplode(COALESCE(p.proacl, acldefault('f', p.proowner))) a
     WHERE p.oid = fn_oid AND a.privilege_type = 'EXECUTE'
       AND a.grantee <> p.proowner
       AND (a.grantee = 0 OR NOT (pg_catalog.pg_get_userbyid(a.grantee) = ANY (spec.callers)));
    IF grantee_name IS NOT NULL THEN
      RAISE EXCEPTION 'migration 124: % is executable by a role other than its owner and callers (%)', spec.signature, grantee_name;
    END IF;

    FOREACH grantee_name IN ARRAY spec.callers LOOP
      IF NOT pg_catalog.has_function_privilege(grantee_name, fn_oid, 'EXECUTE') THEN
        RAISE EXCEPTION 'migration 124: % is not executable by %', spec.signature, grantee_name;
      END IF;
      IF NOT pg_catalog.has_schema_privilege(grantee_name, 'jale_cap', 'USAGE') THEN
        RAISE EXCEPTION 'migration 124: % lacks USAGE on jale_cap', grantee_name;
      END IF;
    END LOOP;
  END LOOP;

  -- The owners: no SET or INHERIT left on them, CREATE on jale_cap only,
  -- no USAGE (the backfill's grant is gone).
  FOREACH owner_role IN ARRAY ARRAY['jale_cap_analytics_capture', 'jale_cap_referral_snapshot'] LOOP
    IF EXISTS (
      SELECT 1 FROM pg_catalog.pg_auth_members am
       WHERE am.roleid = (SELECT oid FROM pg_catalog.pg_roles WHERE rolname = owner_role)
         AND (am.set_option OR am.inherit_option)
    ) THEN
      RAISE EXCEPTION 'migration 124: a role still holds SET or INHERIT on capability owner %', owner_role;
    END IF;
    IF NOT pg_catalog.has_schema_privilege(owner_role, 'jale_cap', 'CREATE')
       OR pg_catalog.has_schema_privilege(owner_role, 'jale_cap', 'USAGE')
       OR pg_catalog.has_schema_privilege(owner_role, 'public', 'CREATE') THEN
      RAISE EXCEPTION 'migration 124: capability owner % must hold CREATE on jale_cap only', owner_role;
    END IF;
  END LOOP;

  -- The capture tables: row security on and forced, and no role but the
  -- table owner and the two capability owners holds any privilege on them.
  FOREACH rel IN ARRAY ARRAY['public.signup_attribution', 'public.worker_job_views', 'public.referral_funnel_daily'] LOOP
    IF NOT EXISTS (
      SELECT 1 FROM pg_catalog.pg_class c
       WHERE c.oid = rel::regclass AND c.relrowsecurity AND c.relforcerowsecurity
    ) THEN
      RAISE EXCEPTION 'migration 124: % must have row security enabled and forced', rel;
    END IF;
  END LOOP;
  SELECT string_agg(DISTINCT c.relname || ' (' ||
           CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE pg_catalog.pg_get_userbyid(a.grantee) END || ')', ', ')
    INTO offender
    FROM pg_catalog.pg_class c
    CROSS JOIN LATERAL (
      SELECT x.grantee FROM aclexplode(COALESCE(c.relacl, acldefault('r', c.relowner))) x
      UNION ALL
      SELECT y.grantee FROM pg_catalog.pg_attribute att, aclexplode(att.attacl) y
       WHERE att.attrelid = c.oid AND att.attacl IS NOT NULL
    ) a
   WHERE c.oid IN ('public.signup_attribution'::regclass, 'public.worker_job_views'::regclass,
                   'public.referral_funnel_daily'::regclass)
     AND a.grantee <> c.relowner
     AND (a.grantee = 0 OR pg_catalog.pg_get_userbyid(a.grantee) NOT IN (
           'jale_cap_analytics_capture', 'jale_cap_referral_snapshot'));
  IF offender IS NOT NULL THEN
    RAISE EXCEPTION 'migration 124: a login holds a privilege on capture table %', offender;
  END IF;

  -- The gated reads exist as written.
  FOREACH rel IN ARRAY ARRAY['signup_attribution', 'worker_job_views', 'referral_funnel_daily',
                             'worker_job_impressions', 'employer_job_templates', 'job_share_opens',
                             'worker_attribution'] LOOP
    IF NOT EXISTS (
      SELECT 1 FROM pg_catalog.pg_policy p
       WHERE p.polrelid = ('public.' || rel)::regclass
         AND p.polname = rel || '_admin_analytics_read'
         AND p.polcmd = 'r'
         AND p.polpermissive
         AND p.polroles = ARRAY['jale_admin'::regrole::oid]
         AND pg_catalog.pg_get_expr(p.polqual, p.polrelid) = v_gate
    ) THEN
      RAISE EXCEPTION 'migration 124: policy %_admin_analytics_read missing or drifted', rel;
    END IF;
  END LOOP;

  -- The console reads (114's checks): owner, definer, path, exactly the
  -- console, the gate opens, the whole query plans, bad windows refused.
  FOREACH fn_sig IN ARRAY ARRAY[
    'public.admin_analytics_acquisition(integer)',
    'public.admin_analytics_job_views(integer)',
    'public.admin_analytics_template_reuse(integer)',
    'public.admin_analytics_match_to_apply(integer)',
    'public.admin_analytics_referral_funnel(integer)'
  ] LOOP
    fn_oid := pg_catalog.to_regprocedure(fn_sig)::OID;
    IF fn_oid IS NULL THEN
      RAISE EXCEPTION 'migration 124: % missing', fn_sig;
    END IF;
    SELECT owner.rolname AS owner_name, p.prosecdef, p.proconfig INTO info
      FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_roles owner ON owner.oid = p.proowner
     WHERE p.oid = fn_oid;
    IF info.owner_name IS DISTINCT FROM 'jale_admin' OR NOT info.prosecdef
       OR NOT COALESCE(info.proconfig @> ARRAY['search_path=pg_catalog, pg_temp'], false) THEN
      RAISE EXCEPTION 'migration 124: % owner/secdef/search_path wrong', fn_sig;
    END IF;
    IF NOT pg_catalog.has_function_privilege('jale_admin_console', fn_oid, 'EXECUTE') THEN
      RAISE EXCEPTION 'migration 124: % not executable by console', fn_sig;
    END IF;
    IF EXISTS (
      SELECT 1 FROM pg_catalog.pg_proc p, aclexplode(COALESCE(p.proacl, acldefault('f', p.proowner))) a
       WHERE p.oid = fn_oid AND a.privilege_type = 'EXECUTE'
         AND a.grantee NOT IN (p.proowner, 'jale_admin_console'::regrole::oid)
    ) THEN
      RAISE EXCEPTION 'migration 124: % executable by a role other than its owner and the console', fn_sig;
    END IF;

    PERFORM set_config('app.admin_analytics_read', '', true);
    EXECUTE format('SELECT count(*) FROM %s', replace(fn_sig, '(integer)', '(4)'));
    IF current_setting('app.admin_analytics_read', true) IS DISTINCT FROM 'on' THEN
      RAISE EXCEPTION 'migration 124: % did not set the read flag', fn_sig;
    END IF;

    FOREACH v_arg IN ARRAY ARRAY[0, 27] LOOP
      BEGIN
        EXECUTE format('SELECT count(*) FROM %s', replace(fn_sig, '(integer)', '(' || v_arg || ')'));
        v_raised := false;
      EXCEPTION WHEN raise_exception THEN
        v_raised := SQLERRM = 'admin_analytics_invalid_weeks';
      END;
      IF NOT v_raised THEN
        RAISE EXCEPTION 'migration 124: %(%) did not reject the window', fn_sig, v_arg;
      END IF;
    END LOOP;
  END LOOP;
  PERFORM set_config('app.admin_analytics_read', '', true);
END;
$$;

-- ── 9. The capture owner's reads of users and jobs ──────────
-- Last: nothing above needs them, and the policy on users locks it
-- exclusively from here to COMMIT (see LOCKS in the header). The owner reads
-- the id and creation time of accounts made in the last 24 hours (the
-- signup-source age rule) and the ids of jobs.
GRANT SELECT (id, created_at) ON public.users TO jale_cap_analytics_capture;
CREATE POLICY users_cap_capture_recent_read ON public.users
  AS PERMISSIVE FOR SELECT TO jale_cap_analytics_capture
  USING (created_at > now() - interval '24 hours');
-- Job ids only, so a batch of showings leaves out a job removed meanwhile.
GRANT SELECT (id) ON public.jobs TO jale_cap_analytics_capture;
CREATE POLICY jobs_cap_analytics_capture_select ON public.jobs
  AS PERMISSIVE FOR SELECT TO jale_cap_analytics_capture
  USING (true);

-- The two policies exist as written. pg_policy is a catalog, so row security
-- never filters this check, and it reads no table row.
DO $$
DECLARE
  pol RECORD;
BEGIN
  FOR pol IN
    SELECT * FROM (VALUES
      ('public.users', 'users_cap_capture_recent_read', $q$(created_at > (now() - '24:00:00'::interval))$q$),
      ('public.jobs', 'jobs_cap_analytics_capture_select', 'true')
    ) AS expected(rel, name, qual)
  LOOP
    IF NOT EXISTS (
      SELECT 1 FROM pg_catalog.pg_policy p
       WHERE p.polrelid = pol.rel::regclass
         AND p.polname = pol.name
         AND p.polcmd = 'r'
         AND p.polpermissive
         AND p.polroles = ARRAY['jale_cap_analytics_capture'::regrole::oid]
         AND pg_catalog.pg_get_expr(p.polqual, p.polrelid) = pol.qual
         AND p.polwithcheck IS NULL
    ) THEN
      RAISE EXCEPTION 'migration 124: the capture owner policy on % is missing or drifted', pol.rel;
    END IF;
  END LOOP;
END;
$$;

COMMIT;
