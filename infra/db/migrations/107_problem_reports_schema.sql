-- ============================================================
-- 107_problem_reports_schema.sql
-- Run manually AFTER 106_least_privilege_access_rights.sql,
-- connected as jale_admin. Forward-only (ADR-005). ONE transaction.
--
-- Sprint 27, report a problem, part 1 of 2: where reports are kept and who
-- may reach them.
--   107  the report tables, the report-number sequence, the settings row,
--        two dedicated logins and three capability owners (this file);
--   108  the jale_cap functions, the only way to read or write a report.
--
-- (1) Tables. Every one has row-level security enabled and forced, and no
--     runtime login holds any right on any of them.
--       problem_reports              the header, kept for counting: the
--                                    number, category, role, status, flags
--                                    and dates
--       problem_report_contents      the personal content, erased at 12
--                                    months: the words, the reporter link,
--                                    the typed contact, the technical
--                                    context and the team's note. It leaves
--                                    with its report and with its account
--                                    (ON DELETE CASCADE).
--       problem_report_rate_buckets  per-address request counts for reports
--                                    sent while signed out
--       problem_report_settings      one row: the pause switches, the daily
--                                    limit for signed-out reports, and the
--                                    team email's recipient and dashboard
--                                    address. Both stay NULL until an
--                                    operator sets them in the admin
--                                    dashboard; nothing is emailed until then.
--     Report numbers come from public.problem_report_number_seq, from 1000.
--
-- (2) Dedicated logins, with the least-privilege attributes of 104:
--       jale_api_public_reports   the signed-out report intake: EXECUTE on
--                                 five report functions, no table rights
--       jale_job_report_cleanup   the daily report clean-up job: EXECUTE on
--                                 one function
--     LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS
--     NOINHERIT, member of no role, CONNECT on this database, and a
--     CONNECTION LIMIT of 10 and 5. 108 gives them USAGE on jale_cap and
--     their EXECUTE rights. Neither gets USAGE on public. Both are created
--     without a password and cannot sign in until credential preparation
--     (scripts/run-migrations.sh --prepare-logins) sets a SCRAM verifier.
--     Like 104's runtime logins, a session left idle inside an open
--     transaction for 60 seconds is ended by the server.
--
-- (3) Capability owners: NOLOGIN, NOINHERIT roles that own 108's functions,
--     one per caller group (104's block, transcribed):
--       jale_cap_problem_reports        the intake functions
--       jale_cap_problem_reports_admin  the admin console functions
--       jale_cap_report_cleanup         the clean-up function
--     Each gets CREATE on jale_cap (ALTER FUNCTION ... OWNER TO requires it)
--     and none on public. jale_admin keeps only the creator's ADMIN-only
--     membership; 108 adds SET for its ownership-transfer window and removes
--     it again before it commits.
--
-- (4) What each owner holds: exactly what its functions need, as column
--     grants where a function needs only some columns. PostgreSQL needs
--     SELECT on every column a WHERE reads, so the key and date columns are
--     listed. The intake owner never reads the words, the typed contact, the
--     context or the note; the clean-up owner reads keys and dates only.
--
-- (5) Row-level security. Every policy is TO one capability owner; none is
--     for a runtime login or PUBLIC.
--       intake    the reports of the last 24 hours (its whole working
--                 window), the current rate-limit buckets and the settings;
--       console   rows are visible only while one of its functions runs:
--                 each sets app.problem_report_console for that call, after
--                 checking its arguments;
--       clean-up  only rows past their retention age.
--     On existing tables, five policies: the intake owner reads the
--     caller's own users row and queues report mail; the console owner
--     reads the users rows that have a report; the clean-up owner reads and
--     deletes report mail the sender will no longer retry.
--
-- DEPLOY ORDER: apply BEFORE the release deploy. No deployed code reads
-- these tables or connects as these logins, so the previous artifact keeps
-- working unchanged.
--
-- REPLAY. Refused with a clear message once the report tables exist. Nothing
-- is partially applied, because the file is one transaction.
-- ============================================================
BEGIN;

-- Creating tables and roles takes only short locks, but never queue behind a
-- stuck transaction: a timed-out apply writes no ledger row and can be rerun.
SET LOCAL lock_timeout = '5s';

DO $$
BEGIN
  IF pg_catalog.to_regnamespace('jale_cap') IS NULL
     OR NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'jale_api') THEN
    RAISE EXCEPTION 'migration 107: apply the least-privilege migrations first (jale_cap or jale_api is missing)';
  END IF;
  IF pg_catalog.to_regclass('public.problem_reports') IS NOT NULL
     OR pg_catalog.to_regclass('public.problem_report_contents') IS NOT NULL
     OR pg_catalog.to_regclass('public.problem_report_rate_buckets') IS NOT NULL
     OR pg_catalog.to_regclass('public.problem_report_settings') IS NOT NULL
     OR pg_catalog.to_regclass('public.problem_report_number_seq') IS NOT NULL THEN
    RAISE EXCEPTION 'migration 107: already applied (the report tables exist); it is not re-runnable';
  END IF;
END;
$$;

-- ── 1. Tables ───────────────────────────────────────────────
CREATE SEQUENCE public.problem_report_number_seq AS BIGINT START WITH 1000 MINVALUE 1000 NO CYCLE;

CREATE TABLE public.problem_reports (
  id                UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  report_number     BIGINT      NOT NULL UNIQUE DEFAULT nextval('public.problem_report_number_seq'),
  client_key        UUID        NOT NULL UNIQUE,
  role              TEXT        NOT NULL CHECK (role IN ('worker', 'employer', 'unknown')),
  verified          BOOLEAN     NOT NULL,
  category          TEXT        NOT NULL,
  stops_work        BOOLEAN,
  locale            TEXT        NOT NULL CHECK (locale IN ('es', 'en')),
  include_technical BOOLEAN     NOT NULL,
  status            TEXT        NOT NULL DEFAULT 'new'
                    CHECK (status IN ('new', 'looking', 'fixed', 'wont_fix')),
  has_image         BOOLEAN     NOT NULL DEFAULT false,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  status_changed_at TIMESTAMPTZ,
  content_erased_at TIMESTAMPTZ,
  image_deleted_at  TIMESTAMPTZ,
  CONSTRAINT problem_reports_category_code CHECK (category IN (
    'sign_in', 'finding_jobs', 'applying', 'uploads', 'profile', 'whatsapp',
    'account', 'job_posting', 'applicants', 'messages', 'billing', 'emails', 'company_profile',
    'other'
  )),
  -- Each role reports from its own list; a page that implies no role uses
  -- the worker list.
  CONSTRAINT problem_reports_category_role CHECK (
    (role IN ('worker', 'unknown')
      AND category IN ('sign_in', 'finding_jobs', 'applying', 'uploads', 'profile', 'whatsapp', 'other'))
    OR (role = 'employer'
      AND category IN ('account', 'job_posting', 'applicants', 'messages', 'billing', 'emails',
                       'company_profile', 'other'))
  ),
  CONSTRAINT problem_reports_stops_work_employer CHECK (stops_work IS NULL OR role = 'employer'),
  CONSTRAINT problem_reports_verified_role CHECK (NOT verified OR role IN ('worker', 'employer'))
);

ALTER SEQUENCE public.problem_report_number_seq OWNED BY public.problem_reports.report_number;

CREATE INDEX problem_reports_status_created_idx ON public.problem_reports (status, created_at DESC);
CREATE INDEX problem_reports_created_idx ON public.problem_reports (created_at DESC);
CREATE INDEX problem_reports_verified_created_idx ON public.problem_reports (verified, created_at);

CREATE TABLE public.problem_report_contents (
  report_id            UUID        PRIMARY KEY
                                   REFERENCES public.problem_reports (id) ON DELETE CASCADE,
  -- Copied from the header, so the age rules need no join.
  created_at           TIMESTAMPTZ NOT NULL,
  reporter_user_id     UUID        REFERENCES public.users (id) ON DELETE CASCADE,
  -- The verified sign-in, when no account row existed yet.
  reporter_sub         TEXT        CHECK (char_length(reporter_sub) BETWEEN 1 AND 255),
  description          TEXT        NOT NULL CHECK (char_length(description) BETWEEN 1 AND 2000),
  -- Signed-out reports only, kept exactly as typed; never matched to an account.
  typed_contact        TEXT        CHECK (char_length(typed_contact) BETWEEN 1 AND 200),
  context              JSONB       NOT NULL DEFAULT '{}'::jsonb
                                   CHECK (jsonb_typeof(context) = 'object' AND pg_column_size(context) <= 32768),
  internal_note        TEXT        CHECK (char_length(internal_note) BETWEEN 1 AND 4000),
  -- SHA-256 hex of the attach token. It stays after the attach, so a retry
  -- is answered already_attached; the attached image keeps it to one.
  attach_token_hash    TEXT        CHECK (attach_token_hash ~ '^[0-9a-f]{64}$'),
  pending_upload_key   TEXT        CHECK (pending_upload_key ~ '^incoming/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'),
  pending_content_type TEXT        CHECK (pending_content_type IN ('image/jpeg', 'image/png', 'image/webp')),
  upload_issued_at     TIMESTAMPTZ,
  -- One key per upload, images/<report>/<upload>.<ext>. Every attempt of
  -- that upload names the same key; a refusal never names another upload's.
  image_key            TEXT        CHECK (image_key ~ '^images/[0-9a-f-]{36}/[0-9a-f-]{36}\.(jpg|png|webp)$'),
  CONSTRAINT problem_report_contents_one_reporter CHECK (reporter_user_id IS NULL OR reporter_sub IS NULL),
  CONSTRAINT problem_report_contents_pending_complete CHECK (
    (pending_upload_key IS NULL) = (pending_content_type IS NULL)
    AND (pending_upload_key IS NULL) = (upload_issued_at IS NULL)
  )
);

CREATE INDEX problem_report_contents_created_idx ON public.problem_report_contents (created_at);
CREATE INDEX problem_report_contents_reporter_user_idx ON public.problem_report_contents (reporter_user_id, created_at)
  WHERE reporter_user_id IS NOT NULL;
CREATE INDEX problem_report_contents_reporter_sub_idx ON public.problem_report_contents (reporter_sub, created_at)
  WHERE reporter_sub IS NOT NULL;
CREATE INDEX problem_report_contents_image_idx ON public.problem_report_contents (created_at)
  WHERE image_key IS NOT NULL;
CREATE INDEX problem_report_contents_pending_idx ON public.problem_report_contents (upload_issued_at)
  WHERE pending_upload_key IS NOT NULL;

CREATE TABLE public.problem_report_rate_buckets (
  address_hash  TEXT        NOT NULL CHECK (address_hash ~ '^[0-9a-f]{64}$'),
  window_kind   TEXT        NOT NULL CHECK (window_kind IN ('hour', 'day')),
  bucket_start  TIMESTAMPTZ NOT NULL,
  request_count INTEGER     NOT NULL CHECK (request_count >= 1),
  PRIMARY KEY (address_hash, window_kind, bucket_start)
);

CREATE INDEX problem_report_rate_buckets_start_idx ON public.problem_report_rate_buckets (bucket_start);

CREATE TABLE public.problem_report_settings (
  id                   BOOLEAN     PRIMARY KEY DEFAULT true CHECK (id),
  reporting_enabled    BOOLEAN     NOT NULL DEFAULT true,
  signed_out_enabled   BOOLEAN     NOT NULL DEFAULT true,
  screenshots_enabled  BOOLEAN     NOT NULL DEFAULT true,
  team_email_enabled   BOOLEAN     NOT NULL DEFAULT true,
  signed_out_daily_cap INTEGER     NOT NULL DEFAULT 200 CHECK (signed_out_daily_cap BETWEEN 0 AND 5000),
  team_recipient       TEXT        CHECK (char_length(team_recipient) BETWEEN 3 AND 320
                                          AND team_recipient ~ '^[^@[:space:]]+@[^@[:space:]]+$'),
  admin_base_url       TEXT        CHECK (admin_base_url ~ '^https://[a-z0-9.-]+(:[0-9]+)?$'),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by_admin     UUID
);

-- The single settings row, with every default and no recipient or dashboard
-- address. It is written before row-level security is switched on below.
INSERT INTO public.problem_report_settings (id) VALUES (true);

DO $$
BEGIN
  IF (SELECT count(*) FROM public.problem_report_settings) <> 1
     OR NOT EXISTS (
       SELECT 1 FROM public.problem_report_settings s
        WHERE s.id AND s.reporting_enabled AND s.signed_out_enabled AND s.screenshots_enabled
          AND s.team_email_enabled AND s.signed_out_daily_cap = 200
          AND s.team_recipient IS NULL AND s.admin_base_url IS NULL AND s.updated_by_admin IS NULL
     ) THEN
    RAISE EXCEPTION 'migration 107: the settings row is missing or carries a recipient or dashboard address';
  END IF;
END;
$$;

ALTER TABLE public.problem_reports ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.problem_reports FORCE ROW LEVEL SECURITY;
ALTER TABLE public.problem_report_contents ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.problem_report_contents FORCE ROW LEVEL SECURITY;
ALTER TABLE public.problem_report_rate_buckets ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.problem_report_rate_buckets FORCE ROW LEVEL SECURITY;
ALTER TABLE public.problem_report_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.problem_report_settings FORCE ROW LEVEL SECURITY;

-- Nothing reaches the report objects by default.
REVOKE ALL ON public.problem_reports, public.problem_report_contents,
              public.problem_report_rate_buckets, public.problem_report_settings FROM PUBLIC;
REVOKE ALL ON SEQUENCE public.problem_report_number_seq FROM PUBLIC;

-- ── 2. Dedicated logins ─────────────────────────────────────
DO $$
DECLARE
  spec RECORD;
  existing pg_catalog.pg_roles%ROWTYPE;
BEGIN
  FOR spec IN
    SELECT * FROM (VALUES
      ('jale_api_public_reports', 10),
      ('jale_job_report_cleanup', 5)
    ) AS t(login, connection_limit)
  LOOP
    SELECT * INTO existing FROM pg_catalog.pg_roles WHERE rolname = spec.login;
    IF NOT FOUND THEN
      EXECUTE format(
        'CREATE ROLE %I LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS NOINHERIT CONNECTION LIMIT %s',
        spec.login, spec.connection_limit
      );
    ELSIF NOT existing.rolcanlogin OR existing.rolsuper OR existing.rolcreatedb
       OR existing.rolcreaterole OR existing.rolreplication OR existing.rolbypassrls
       OR existing.rolinherit OR existing.rolconnlimit <> spec.connection_limit THEN
      RAISE EXCEPTION 'migration 107: existing login % has unexpected attributes; refusing to adopt it', spec.login;
    END IF;

    IF EXISTS (
      SELECT 1 FROM pg_catalog.pg_auth_members am
       WHERE am.member = (SELECT oid FROM pg_catalog.pg_roles WHERE rolname = spec.login)
    ) THEN
      RAISE EXCEPTION 'migration 107: login % must not be a member of any role', spec.login;
    END IF;

    -- The only membership IN the login is the creator's ADMIN-only row.
    IF EXISTS (
      SELECT 1 FROM pg_catalog.pg_auth_members am
       WHERE am.roleid = (SELECT oid FROM pg_catalog.pg_roles WHERE rolname = spec.login)
         AND NOT (am.member = (SELECT oid FROM pg_catalog.pg_roles WHERE rolname = current_user)
                  AND am.admin_option AND NOT am.inherit_option AND NOT am.set_option)
    ) THEN
      RAISE EXCEPTION 'migration 107: role % has unsafe memberships', spec.login;
    END IF;
    IF NOT EXISTS (
      SELECT 1 FROM pg_catalog.pg_auth_members am
       WHERE am.roleid = (SELECT oid FROM pg_catalog.pg_roles WHERE rolname = spec.login)
         AND am.member = (SELECT oid FROM pg_catalog.pg_roles WHERE rolname = current_user)
         AND am.admin_option
    ) THEN
      EXECUTE format('GRANT %I TO %I WITH ADMIN TRUE, INHERIT FALSE, SET FALSE', spec.login, current_user);
    END IF;

    EXECUTE format('GRANT CONNECT ON DATABASE %I TO %I', current_database(), spec.login);
  END LOOP;
END;
$$;

-- ── 3. Capability owners ────────────────────────────────────
DO $$
DECLARE
  owner_role TEXT;
  helper pg_catalog.pg_roles%ROWTYPE;
BEGIN
  FOREACH owner_role IN ARRAY ARRAY[
    'jale_cap_problem_reports', 'jale_cap_problem_reports_admin', 'jale_cap_report_cleanup'
  ] LOOP
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
      RAISE EXCEPTION 'migration 107: existing role % has unsafe attributes', owner_role;
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
      RAISE EXCEPTION 'migration 107: role % has unsafe memberships', owner_role;
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
-- function's schema; 108 transfers each report function to its owner.
GRANT CREATE ON SCHEMA jale_cap TO jale_cap_problem_reports, jale_cap_problem_reports_admin, jale_cap_report_cleanup;

-- A session idle inside an open transaction for a minute is ended by the
-- server, so a stalled client never keeps its locks and snapshot.
ALTER ROLE jale_api_public_reports SET idle_in_transaction_session_timeout = '60s';
ALTER ROLE jale_job_report_cleanup SET idle_in_transaction_session_timeout = '60s';

-- ── 4. What each owner holds ────────────────────────────────
-- Intake: creates reports, issues and attaches uploads, queues the team
-- email. No SELECT on the words, the typed contact, the context or the note.
GRANT SELECT, INSERT ON public.problem_reports TO jale_cap_problem_reports;
GRANT UPDATE (has_image, updated_at) ON public.problem_reports TO jale_cap_problem_reports;
GRANT INSERT ON public.problem_report_contents TO jale_cap_problem_reports;
GRANT SELECT (report_id, created_at, reporter_user_id, reporter_sub, attach_token_hash,
              pending_upload_key, pending_content_type, upload_issued_at, image_key)
  ON public.problem_report_contents TO jale_cap_problem_reports;
GRANT UPDATE (attach_token_hash, pending_upload_key, pending_content_type, upload_issued_at, image_key)
  ON public.problem_report_contents TO jale_cap_problem_reports;
GRANT SELECT, INSERT, UPDATE ON public.problem_report_rate_buckets TO jale_cap_problem_reports;
GRANT SELECT ON public.problem_report_settings TO jale_cap_problem_reports;
GRANT SELECT (id, cognito_sub, user_type) ON public.users TO jale_cap_problem_reports;
GRANT INSERT (recipient_email, subject, body_text, body_html, source_type, source_id, idempotency_key)
  ON public.email_outbox TO jale_cap_problem_reports;
GRANT USAGE ON SEQUENCE public.problem_report_number_seq TO jale_cap_problem_reports;

-- Admin console: reads reports and the reporters' contact (masked in SQL),
-- sets the status, the note and the settings. Not users.full_name.
GRANT SELECT ON public.problem_reports TO jale_cap_problem_reports_admin;
GRANT UPDATE (status, status_changed_at, updated_at) ON public.problem_reports TO jale_cap_problem_reports_admin;
GRANT SELECT ON public.problem_report_contents TO jale_cap_problem_reports_admin;
GRANT UPDATE (internal_note) ON public.problem_report_contents TO jale_cap_problem_reports_admin;
GRANT SELECT, UPDATE ON public.problem_report_settings TO jale_cap_problem_reports_admin;
GRANT SELECT (id, cognito_sub, user_type, email, phone) ON public.users TO jale_cap_problem_reports_admin;
GRANT EXECUTE ON FUNCTION public.admin_mask_phone(text) TO jale_cap_problem_reports_admin;

-- Clean-up: keys and dates only, and DELETE where rows expire.
GRANT SELECT (id, content_erased_at, image_deleted_at) ON public.problem_reports TO jale_cap_report_cleanup;
GRANT UPDATE (content_erased_at, image_deleted_at) ON public.problem_reports TO jale_cap_report_cleanup;
GRANT SELECT (report_id, created_at, image_key, pending_upload_key, upload_issued_at)
  ON public.problem_report_contents TO jale_cap_report_cleanup;
GRANT UPDATE (image_key, pending_upload_key, pending_content_type, upload_issued_at)
  ON public.problem_report_contents TO jale_cap_report_cleanup;
GRANT DELETE ON public.problem_report_contents TO jale_cap_report_cleanup;
GRANT SELECT (address_hash, window_kind, bucket_start) ON public.problem_report_rate_buckets TO jale_cap_report_cleanup;
GRANT DELETE ON public.problem_report_rate_buckets TO jale_cap_report_cleanup;
GRANT SELECT (id, source_type, status, attempt_count, created_at) ON public.email_outbox TO jale_cap_report_cleanup;
GRANT DELETE ON public.email_outbox TO jale_cap_report_cleanup;

-- The create functions call the team-email helper and the detail function
-- calls the email mask, both in jale_cap, so those two owners need USAGE
-- there. The clean-up owner calls nothing.
GRANT USAGE ON SCHEMA jale_cap TO jale_cap_problem_reports, jale_cap_problem_reports_admin;

-- ── 5. Row-level security policies ──────────────────────────
-- Intake: the last 24 hours.
CREATE POLICY problem_reports_intake_read ON public.problem_reports
  FOR SELECT TO jale_cap_problem_reports
  USING (created_at > now() - interval '24 hours');
CREATE POLICY problem_reports_intake_insert ON public.problem_reports
  FOR INSERT TO jale_cap_problem_reports
  WITH CHECK (created_at > now() - interval '24 hours');
CREATE POLICY problem_reports_intake_update ON public.problem_reports
  FOR UPDATE TO jale_cap_problem_reports
  USING (created_at > now() - interval '24 hours');
CREATE POLICY problem_report_contents_intake_read ON public.problem_report_contents
  FOR SELECT TO jale_cap_problem_reports
  USING (created_at > now() - interval '24 hours');
CREATE POLICY problem_report_contents_intake_insert ON public.problem_report_contents
  FOR INSERT TO jale_cap_problem_reports
  WITH CHECK (created_at > now() - interval '24 hours');
CREATE POLICY problem_report_contents_intake_update ON public.problem_report_contents
  FOR UPDATE TO jale_cap_problem_reports
  USING (created_at > now() - interval '24 hours');
CREATE POLICY problem_report_rate_buckets_intake_read ON public.problem_report_rate_buckets
  FOR SELECT TO jale_cap_problem_reports
  USING (bucket_start > now() - interval '2 days');
CREATE POLICY problem_report_rate_buckets_intake_insert ON public.problem_report_rate_buckets
  FOR INSERT TO jale_cap_problem_reports
  WITH CHECK (bucket_start > now() - interval '2 days');
CREATE POLICY problem_report_rate_buckets_intake_update ON public.problem_report_rate_buckets
  FOR UPDATE TO jale_cap_problem_reports
  USING (bucket_start > now() - interval '2 days');
CREATE POLICY problem_report_settings_intake_read ON public.problem_report_settings
  FOR SELECT TO jale_cap_problem_reports
  USING (id);

-- Admin console: only while one of its functions runs.
CREATE POLICY problem_reports_console_read ON public.problem_reports
  FOR SELECT TO jale_cap_problem_reports_admin
  USING (current_setting('app.problem_report_console', true) = 'on');
CREATE POLICY problem_reports_console_update ON public.problem_reports
  FOR UPDATE TO jale_cap_problem_reports_admin
  USING (current_setting('app.problem_report_console', true) = 'on');
CREATE POLICY problem_report_contents_console_read ON public.problem_report_contents
  FOR SELECT TO jale_cap_problem_reports_admin
  USING (current_setting('app.problem_report_console', true) = 'on');
CREATE POLICY problem_report_contents_console_update ON public.problem_report_contents
  FOR UPDATE TO jale_cap_problem_reports_admin
  USING (current_setting('app.problem_report_console', true) = 'on');
CREATE POLICY problem_report_settings_console_read ON public.problem_report_settings
  FOR SELECT TO jale_cap_problem_reports_admin
  USING (current_setting('app.problem_report_console', true) = 'on');
CREATE POLICY problem_report_settings_console_update ON public.problem_report_settings
  FOR UPDATE TO jale_cap_problem_reports_admin
  USING (current_setting('app.problem_report_console', true) = 'on');

-- Clean-up: only rows past their retention age (images 90 days, uploads a
-- day, content 12 months, buckets 2 days).
CREATE POLICY problem_reports_cleanup_read ON public.problem_reports
  FOR SELECT TO jale_cap_report_cleanup
  USING (created_at < now() - interval '90 days');
CREATE POLICY problem_reports_cleanup_update ON public.problem_reports
  FOR UPDATE TO jale_cap_report_cleanup
  USING (created_at < now() - interval '90 days');
CREATE POLICY problem_report_contents_cleanup_read ON public.problem_report_contents
  FOR SELECT TO jale_cap_report_cleanup
  USING (created_at < now() - interval '1 day');
CREATE POLICY problem_report_contents_cleanup_update ON public.problem_report_contents
  FOR UPDATE TO jale_cap_report_cleanup
  USING (created_at < now() - interval '1 day');
CREATE POLICY problem_report_contents_cleanup_delete ON public.problem_report_contents
  FOR DELETE TO jale_cap_report_cleanup
  USING (created_at < now() - interval '12 months');
CREATE POLICY problem_report_rate_buckets_cleanup_read ON public.problem_report_rate_buckets
  FOR SELECT TO jale_cap_report_cleanup
  USING (bucket_start < now() - interval '2 days');
CREATE POLICY problem_report_rate_buckets_cleanup_delete ON public.problem_report_rate_buckets
  FOR DELETE TO jale_cap_report_cleanup
  USING (bucket_start < now() - interval '2 days');

-- Existing tables: five policies, none copied from elsewhere.
CREATE POLICY users_problem_reports_intake_read ON public.users
  FOR SELECT TO jale_cap_problem_reports
  USING (cognito_sub = current_setting('app.current_user_id', true));
CREATE POLICY users_problem_reports_admin_read ON public.users
  FOR SELECT TO jale_cap_problem_reports_admin
  USING (EXISTS (
    SELECT 1 FROM public.problem_report_contents c
     WHERE c.reporter_user_id = users.id OR c.reporter_sub = users.cognito_sub
  ));
CREATE POLICY email_outbox_problem_report_insert ON public.email_outbox
  FOR INSERT TO jale_cap_problem_reports
  WITH CHECK (source_type = 'problem_report');
-- The last term keeps every row the sender would still retry: its pick
-- query takes pending and failed rows below the attempt limit of 5.
CREATE POLICY email_outbox_problem_report_cleanup_read ON public.email_outbox
  FOR SELECT TO jale_cap_report_cleanup
  USING (source_type = 'problem_report' AND created_at < now() - interval '1 day'
         AND NOT (status IN ('pending', 'failed') AND attempt_count < 5));
CREATE POLICY email_outbox_problem_report_cleanup_delete ON public.email_outbox
  FOR DELETE TO jale_cap_report_cleanup
  USING (source_type = 'problem_report' AND created_at < now() - interval '1 day'
         AND NOT (status IN ('pending', 'failed') AND attempt_count < 5));

-- ── Self-audit ──────────────────────────────────────────────
DO $$
DECLARE
  spec RECORD;
  r pg_catalog.pg_roles%ROWTYPE;
  rel TEXT;
BEGIN
  FOREACH rel IN ARRAY ARRAY[
    'public.problem_reports', 'public.problem_report_contents',
    'public.problem_report_rate_buckets', 'public.problem_report_settings'
  ] LOOP
    IF NOT EXISTS (
      SELECT 1 FROM pg_catalog.pg_class c
       WHERE c.oid = pg_catalog.to_regclass(rel)
         AND c.relkind = 'r' AND c.relrowsecurity AND c.relforcerowsecurity
         AND pg_catalog.pg_get_userbyid(c.relowner) = 'jale_admin'
    ) THEN
      RAISE EXCEPTION 'migration 107: % is missing, or its row-level security is not enabled and forced', rel;
    END IF;
  END LOOP;

  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_sequences s
     WHERE s.schemaname = 'public' AND s.sequencename = 'problem_report_number_seq'
       AND s.start_value = 1000 AND s.min_value = 1000 AND NOT s.cycle
  ) THEN
    RAISE EXCEPTION 'migration 107: public.problem_report_number_seq is missing or does not start at 1000';
  END IF;

  FOR spec IN
    SELECT * FROM (VALUES
      ('jale_api_public_reports', 10),
      ('jale_job_report_cleanup', 5)
    ) AS t(login, connection_limit)
  LOOP
    SELECT * INTO r FROM pg_catalog.pg_roles WHERE rolname = spec.login;
    IF NOT FOUND OR NOT r.rolcanlogin OR r.rolsuper OR r.rolcreatedb OR r.rolcreaterole
       OR r.rolreplication OR r.rolbypassrls OR r.rolinherit OR r.rolconnlimit <> spec.connection_limit THEN
      RAISE EXCEPTION 'migration 107: existing login % has unexpected attributes; refusing to adopt it', spec.login;
    END IF;
    IF EXISTS (SELECT 1 FROM pg_catalog.pg_auth_members am WHERE am.member = r.oid) THEN
      RAISE EXCEPTION 'migration 107: login % must not be a member of any role', spec.login;
    END IF;
    IF EXISTS (
      SELECT 1 FROM pg_catalog.pg_auth_members am
       WHERE am.roleid = r.oid AND (am.set_option OR am.inherit_option)
    ) THEN
      RAISE EXCEPTION 'migration 107: role % has unsafe memberships', spec.login;
    END IF;
    IF EXISTS (
      SELECT 1 FROM pg_catalog.pg_shdepend d
       WHERE d.refclassid = 'pg_catalog.pg_authid'::regclass AND d.refobjid = r.oid AND d.deptype = 'o'
    ) THEN
      RAISE EXCEPTION 'migration 107: login % owns objects', spec.login;
    END IF;
    IF NOT pg_catalog.has_database_privilege(r.oid, current_database(), 'CONNECT') THEN
      RAISE EXCEPTION 'migration 107: login % lacks CONNECT', spec.login;
    END IF;
    IF COALESCE((SELECT array_agg(cfg ORDER BY cfg)
                   FROM pg_catalog.pg_db_role_setting s, unnest(s.setconfig) cfg
                  WHERE s.setrole = r.oid AND s.setdatabase = 0), ARRAY[]::text[])
         <> ARRAY['idle_in_transaction_session_timeout=60s']
       OR EXISTS (SELECT 1 FROM pg_catalog.pg_db_role_setting s WHERE s.setrole = r.oid AND s.setdatabase <> 0) THEN
      RAISE EXCEPTION 'migration 107: login % does not carry its role settings', spec.login;
    END IF;
  END LOOP;

  FOREACH rel IN ARRAY ARRAY[
    'jale_cap_problem_reports', 'jale_cap_problem_reports_admin', 'jale_cap_report_cleanup'
  ] LOOP
    SELECT * INTO r FROM pg_catalog.pg_roles WHERE rolname = rel;
    IF NOT FOUND OR r.rolcanlogin OR r.rolsuper OR r.rolcreatedb OR r.rolcreaterole
       OR r.rolinherit OR r.rolreplication OR r.rolbypassrls THEN
      RAISE EXCEPTION 'migration 107: existing role % has unsafe attributes', rel;
    END IF;
    IF EXISTS (SELECT 1 FROM pg_catalog.pg_auth_members am WHERE am.member = r.oid)
       OR EXISTS (
         SELECT 1 FROM pg_catalog.pg_auth_members am
          WHERE am.roleid = r.oid AND (am.set_option OR am.inherit_option)
       ) THEN
      RAISE EXCEPTION 'migration 107: role % has unsafe memberships', rel;
    END IF;
    IF NOT pg_catalog.has_schema_privilege(r.oid, 'jale_cap', 'CREATE')
       OR pg_catalog.has_schema_privilege(r.oid, 'public', 'CREATE') THEN
      RAISE EXCEPTION 'migration 107: capability owner % must hold CREATE on jale_cap and not on public', rel;
    END IF;
  END LOOP;
END;
$$;

-- ── Self-audit: rights and policies, printed as the inventory ──
DO $$
DECLARE
  spec RECORD;
  actual RECORD;
  offender TEXT;
BEGIN
  -- Each owner's effective rights on each table it touches, column by
  -- column; '*' is every column and '' is none.
  FOR spec IN
    SELECT * FROM (VALUES
      ('jale_cap_problem_reports', 'public.problem_reports', '*', '*', 'has_image,updated_at', false),
      ('jale_cap_problem_reports', 'public.problem_report_contents',
         'report_id,created_at,reporter_user_id,reporter_sub,attach_token_hash,pending_upload_key,pending_content_type,upload_issued_at,image_key',
         '*', 'attach_token_hash,pending_upload_key,pending_content_type,upload_issued_at,image_key', false),
      ('jale_cap_problem_reports', 'public.problem_report_rate_buckets', '*', '*', '*', false),
      ('jale_cap_problem_reports', 'public.problem_report_settings', '*', '', '', false),
      ('jale_cap_problem_reports', 'public.users', 'id,cognito_sub,user_type', '', '', false),
      ('jale_cap_problem_reports', 'public.email_outbox', '',
         'recipient_email,subject,body_text,body_html,source_type,source_id,idempotency_key', '', false),
      ('jale_cap_problem_reports_admin', 'public.problem_reports', '*', '', 'status,status_changed_at,updated_at', false),
      ('jale_cap_problem_reports_admin', 'public.problem_report_contents', '*', '', 'internal_note', false),
      ('jale_cap_problem_reports_admin', 'public.problem_report_rate_buckets', '', '', '', false),
      ('jale_cap_problem_reports_admin', 'public.problem_report_settings', '*', '', '*', false),
      ('jale_cap_problem_reports_admin', 'public.users', 'id,cognito_sub,user_type,email,phone', '', '', false),
      ('jale_cap_problem_reports_admin', 'public.email_outbox', '', '', '', false),
      ('jale_cap_report_cleanup', 'public.problem_reports', 'id,content_erased_at,image_deleted_at', '',
         'content_erased_at,image_deleted_at', false),
      ('jale_cap_report_cleanup', 'public.problem_report_contents',
         'report_id,created_at,image_key,pending_upload_key,upload_issued_at', '',
         'image_key,pending_upload_key,pending_content_type,upload_issued_at', true),
      ('jale_cap_report_cleanup', 'public.problem_report_rate_buckets', 'address_hash,window_kind,bucket_start', '', '', true),
      ('jale_cap_report_cleanup', 'public.problem_report_settings', '', '', '', false),
      ('jale_cap_report_cleanup', 'public.users', '', '', '', false),
      ('jale_cap_report_cleanup', 'public.email_outbox', 'id,source_type,status,attempt_count,created_at', '', '', true)
    ) AS t(owner_role, rel, sel, ins, upd, del)
  LOOP
    SELECT
      COALESCE(string_agg(a.attname::text, ',' ORDER BY a.attname::text COLLATE "C")
                 FILTER (WHERE pg_catalog.has_column_privilege(spec.owner_role, a.attrelid, a.attnum, 'SELECT')), '') AS sel,
      COALESCE(string_agg(a.attname::text, ',' ORDER BY a.attname::text COLLATE "C")
                 FILTER (WHERE pg_catalog.has_column_privilege(spec.owner_role, a.attrelid, a.attnum, 'INSERT')), '') AS ins,
      COALESCE(string_agg(a.attname::text, ',' ORDER BY a.attname::text COLLATE "C")
                 FILTER (WHERE pg_catalog.has_column_privilege(spec.owner_role, a.attrelid, a.attnum, 'UPDATE')), '') AS upd,
      string_agg(a.attname::text, ',' ORDER BY a.attname::text COLLATE "C") AS all_columns,
      pg_catalog.has_table_privilege(spec.owner_role, spec.rel, 'DELETE') AS del,
      pg_catalog.has_table_privilege(spec.owner_role, spec.rel, 'TRUNCATE')
        OR pg_catalog.has_any_column_privilege(spec.owner_role, spec.rel, 'REFERENCES')
        OR pg_catalog.has_table_privilege(spec.owner_role, spec.rel, 'TRIGGER') AS other
      INTO actual
      FROM pg_catalog.pg_attribute a
     WHERE a.attrelid = pg_catalog.to_regclass(spec.rel) AND a.attnum > 0 AND NOT a.attisdropped;

    IF actual.sel IS DISTINCT FROM (CASE spec.sel WHEN '*' THEN actual.all_columns ELSE
         COALESCE((SELECT string_agg(x, ',' ORDER BY x COLLATE "C") FROM unnest(string_to_array(spec.sel, ',')) x), '') END)
       OR actual.ins IS DISTINCT FROM (CASE spec.ins WHEN '*' THEN actual.all_columns ELSE
         COALESCE((SELECT string_agg(x, ',' ORDER BY x COLLATE "C") FROM unnest(string_to_array(spec.ins, ',')) x), '') END)
       OR actual.upd IS DISTINCT FROM (CASE spec.upd WHEN '*' THEN actual.all_columns ELSE
         COALESCE((SELECT string_agg(x, ',' ORDER BY x COLLATE "C") FROM unnest(string_to_array(spec.upd, ',')) x), '') END)
       OR actual.del IS DISTINCT FROM spec.del
       OR actual.other THEN
      RAISE EXCEPTION 'migration 107: % does not hold exactly its reviewed rights on %', spec.owner_role, spec.rel;
    END IF;
    RAISE NOTICE 'migration 107: % on %: select(%) insert(%) update(%) delete(%)',
      spec.owner_role, spec.rel, spec.sel, spec.ins, spec.upd, CASE WHEN spec.del THEN 'yes' ELSE 'no' END;
  END LOOP;

  -- The number sequence: USAGE for the intake owner only. The phone mask:
  -- EXECUTE for the console owner only.
  IF NOT pg_catalog.has_sequence_privilege('jale_cap_problem_reports', 'public.problem_report_number_seq', 'USAGE')
     OR pg_catalog.has_sequence_privilege('jale_cap_problem_reports', 'public.problem_report_number_seq', 'SELECT')
     OR pg_catalog.has_sequence_privilege('jale_cap_problem_reports', 'public.problem_report_number_seq', 'UPDATE')
     OR pg_catalog.has_sequence_privilege('jale_cap_problem_reports_admin', 'public.problem_report_number_seq', 'USAGE, SELECT, UPDATE')
     OR pg_catalog.has_sequence_privilege('jale_cap_report_cleanup', 'public.problem_report_number_seq', 'USAGE, SELECT, UPDATE') THEN
    RAISE EXCEPTION 'migration 107: public.problem_report_number_seq does not grant exactly USAGE to the intake owner';
  END IF;
  RAISE NOTICE 'migration 107: jale_cap_problem_reports on public.problem_report_number_seq: usage';
  IF NOT pg_catalog.has_function_privilege('jale_cap_problem_reports_admin', 'public.admin_mask_phone(text)', 'EXECUTE')
     OR pg_catalog.has_function_privilege('jale_cap_problem_reports', 'public.admin_mask_phone(text)', 'EXECUTE')
     OR pg_catalog.has_function_privilege('jale_cap_report_cleanup', 'public.admin_mask_phone(text)', 'EXECUTE') THEN
    RAISE EXCEPTION 'migration 107: public.admin_mask_phone(text) is not executable by exactly the console owner';
  END IF;
  RAISE NOTICE 'migration 107: jale_cap_problem_reports_admin on public.admin_mask_phone(text): execute';

  -- Exactly the reviewed policies, each permissive and TO one owner.
  SELECT string_agg(COALESCE(e.tbl || '.' || e.policy, a.tbl || '.' || a.policy), ', ')
    INTO offender
    FROM (VALUES
      ('problem_reports', 'problem_reports_intake_read', 'SELECT', 'jale_cap_problem_reports'),
      ('problem_reports', 'problem_reports_intake_insert', 'INSERT', 'jale_cap_problem_reports'),
      ('problem_reports', 'problem_reports_intake_update', 'UPDATE', 'jale_cap_problem_reports'),
      ('problem_reports', 'problem_reports_console_read', 'SELECT', 'jale_cap_problem_reports_admin'),
      ('problem_reports', 'problem_reports_console_update', 'UPDATE', 'jale_cap_problem_reports_admin'),
      ('problem_reports', 'problem_reports_cleanup_read', 'SELECT', 'jale_cap_report_cleanup'),
      ('problem_reports', 'problem_reports_cleanup_update', 'UPDATE', 'jale_cap_report_cleanup'),
      ('problem_report_contents', 'problem_report_contents_intake_read', 'SELECT', 'jale_cap_problem_reports'),
      ('problem_report_contents', 'problem_report_contents_intake_insert', 'INSERT', 'jale_cap_problem_reports'),
      ('problem_report_contents', 'problem_report_contents_intake_update', 'UPDATE', 'jale_cap_problem_reports'),
      ('problem_report_contents', 'problem_report_contents_console_read', 'SELECT', 'jale_cap_problem_reports_admin'),
      ('problem_report_contents', 'problem_report_contents_console_update', 'UPDATE', 'jale_cap_problem_reports_admin'),
      ('problem_report_contents', 'problem_report_contents_cleanup_read', 'SELECT', 'jale_cap_report_cleanup'),
      ('problem_report_contents', 'problem_report_contents_cleanup_update', 'UPDATE', 'jale_cap_report_cleanup'),
      ('problem_report_contents', 'problem_report_contents_cleanup_delete', 'DELETE', 'jale_cap_report_cleanup'),
      ('problem_report_rate_buckets', 'problem_report_rate_buckets_intake_read', 'SELECT', 'jale_cap_problem_reports'),
      ('problem_report_rate_buckets', 'problem_report_rate_buckets_intake_insert', 'INSERT', 'jale_cap_problem_reports'),
      ('problem_report_rate_buckets', 'problem_report_rate_buckets_intake_update', 'UPDATE', 'jale_cap_problem_reports'),
      ('problem_report_rate_buckets', 'problem_report_rate_buckets_cleanup_read', 'SELECT', 'jale_cap_report_cleanup'),
      ('problem_report_rate_buckets', 'problem_report_rate_buckets_cleanup_delete', 'DELETE', 'jale_cap_report_cleanup'),
      ('problem_report_settings', 'problem_report_settings_intake_read', 'SELECT', 'jale_cap_problem_reports'),
      ('problem_report_settings', 'problem_report_settings_console_read', 'SELECT', 'jale_cap_problem_reports_admin'),
      ('problem_report_settings', 'problem_report_settings_console_update', 'UPDATE', 'jale_cap_problem_reports_admin'),
      ('users', 'users_problem_reports_intake_read', 'SELECT', 'jale_cap_problem_reports'),
      ('users', 'users_problem_reports_admin_read', 'SELECT', 'jale_cap_problem_reports_admin'),
      ('email_outbox', 'email_outbox_problem_report_insert', 'INSERT', 'jale_cap_problem_reports'),
      ('email_outbox', 'email_outbox_problem_report_cleanup_read', 'SELECT', 'jale_cap_report_cleanup'),
      ('email_outbox', 'email_outbox_problem_report_cleanup_delete', 'DELETE', 'jale_cap_report_cleanup')
    ) AS e(tbl, policy, cmd, role_name)
    FULL JOIN (
      SELECT p.tablename::text AS tbl, p.policyname::text AS policy, p.cmd AS cmd, p.roles AS roles, p.permissive AS permissive
        FROM pg_catalog.pg_policies p
       WHERE p.schemaname = 'public'
         AND (p.tablename IN ('problem_reports', 'problem_report_contents', 'problem_report_rate_buckets', 'problem_report_settings')
              OR p.policyname LIKE '%problem\_report%')
    ) a ON a.tbl = e.tbl AND a.policy = e.policy
   WHERE e.policy IS NULL OR a.policy IS NULL OR a.cmd <> e.cmd
      OR a.roles <> ARRAY[e.role_name]::name[] OR a.permissive <> 'PERMISSIVE';
  IF offender IS NOT NULL THEN
    RAISE EXCEPTION 'migration 107: the report policies differ from the reviewed set (%)', offender;
  END IF;
  FOR actual IN
    SELECT p.tablename, p.policyname, p.cmd, p.roles::text AS roles,
           COALESCE(p.qual, '') AS qual, COALESCE(p.with_check, '') AS with_check
      FROM pg_catalog.pg_policies p
     WHERE p.schemaname = 'public'
       AND (p.tablename IN ('problem_reports', 'problem_report_contents', 'problem_report_rate_buckets', 'problem_report_settings')
            OR p.policyname LIKE '%problem\_report%')
     ORDER BY p.tablename COLLATE "C", p.policyname COLLATE "C"
  LOOP
    RAISE NOTICE 'migration 107: policy % on % for % to %: using (%) check (%)',
      actual.policyname, actual.tablename, actual.cmd, actual.roles, actual.qual, actual.with_check;
  END LOOP;
END;
$$;

COMMIT;
