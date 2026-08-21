-- 080_employer_digest_settings.sql
-- Employer daily-digest email preferences plus the least-privilege machinery a
-- scheduled producer needs to enumerate "who is due a digest right now" without
-- being handed the users table.
--
-- CREATE TABLE IF NOT EXISTS employer_digest_settings (
--   employer_id               UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
--   enabled                   BOOLEAN NOT NULL DEFAULT false,
--   send_hour_local           SMALLINT NOT NULL DEFAULT 8 CHECK (send_hour_local BETWEEN 0 AND 23),
--   timezone                  TEXT NOT NULL DEFAULT 'America/Chicago',
--   language                  TEXT NOT NULL DEFAULT 'en' CHECK (language IN ('en', 'es')),
--   last_sent_at              TIMESTAMPTZ,
--   unsubscribe_token_version SMALLINT NOT NULL DEFAULT 1 CHECK (unsubscribe_token_version >= 1),
--   updated_at                TIMESTAMPTZ NOT NULL DEFAULT now()
-- )
--
-- One row per employer. `enabled` defaults to false: the digest is opt-in, so
-- creating a settings row (e.g. when the employer first opens the settings
-- screen) must never by itself start sending mail.
--
-- `send_hour_local` + `timezone` together mean "send at this wall-clock hour in
-- this employer's own zone". The producer sweeps every 15 MINUTES and asks the
-- database which rows match; see jale_digest_internal.due_digest_employers
-- below. The hour predicate is therefore true for up to FOUR consecutive
-- sweeps within the matching local hour, and it is the local-date watermark --
-- not the hour match -- that makes a digest at-most-once per local day: once
-- the producer records last_sent_at, the remaining sweeps in that hour see a
-- watermark whose local date equals p_now's and skip the row. Exactly-once
-- therefore depends on the producer committing the watermark; the hour
-- predicate alone would send four times.
-- `language` is the digest's copy language, matching the platform's bilingual
-- en/es contract (same two-value CHECK shape as elsewhere in the schema).
--
-- `last_sent_at` is the producer's watermark and is compared as a LOCAL date,
-- not a UTC date -- see the due-employers function for why.
--
-- `unsubscribe_token_version` lets a one-click unsubscribe link be invalidated
-- wholesale (bump the version) without deleting the row or rotating a shared
-- secret. It starts at 1 and only ever increases.
--
-- ── updated_at DOES get a trigger here (unlike 079) ──────────────
-- 079_worker_application_defaults.sql deliberately gave its updated_at NO
-- trigger, on the grounds that every write went through exactly one narrow
-- app-layer helper, so a trigger would be redundant machinery for a single
-- call site. That rationale does NOT apply to this table: it has THREE
-- independent writers --
--   (1) the employer-facing settings PATCH handler (web),
--   (2) the scheduled digest producer, updating the last_sent_at watermark,
--   (3) jale_digest_internal.unsubscribe_employer(), a SECURITY DEFINER
--       function owned by a role that is granted UPDATE on exactly one column
--       and therefore cannot set updated_at itself even if it wanted to.
-- With three write paths (one of which structurally cannot maintain the
-- column), the 016_employer_profiles.sql shape -- a BEFORE UPDATE trigger on
-- the shared set_updated_at() from 001 -- is the only way updated_at stays
-- honest. Verified: the column-scoped GRANT UPDATE (enabled) below coexists
-- with this trigger, because Postgres checks column privileges against the
-- statement's SET list, not against what a BEFORE trigger subsequently
-- assigns to NEW.
--
-- ── timezone validation: why a trigger and not a CHECK ───────────
-- The obvious constraint -- CHECK (timezone IN (SELECT name FROM
-- pg_timezone_names)) -- is not merely slow, it is illegal: Postgres rejects a
-- subquery inside a CHECK at parse time with SQLSTATE 0A000
-- (feature_not_supported). So validation has to live in a trigger.
--
-- The other tempting shortcut is worse: casting through `AT TIME ZONE` and
-- letting it raise. It does not raise on garbage. `SELECT now() AT TIME ZONE
-- 'FOOBAR8'` succeeds, because Postgres falls back to interpreting the string
-- as a POSIX-style TZ specification (letters + offset). `AT TIME ZONE` is
-- therefore NEVER a validator for this column.
--
-- What is left is a two-layer defence:
--   (a) employer_digest_settings_timezone_shape, a plain CHECK that pins the
--       lexical shape (trimmed, 1..64 chars, only [A-Za-z0-9_/+-]). Cheap,
--       always enforced, and it keeps hostile text out of the column even in
--       the hypothetical where the trigger is dropped.
--   (b) enforce_valid_iana_timezone(), a BEFORE INSERT OR UPDATE OF timezone
--       trigger that checks real membership in pg_catalog.pg_timezone_names.
-- Note the firing order: a BEFORE ROW trigger runs before CHECK constraints
-- are evaluated, so for a value that violates both -- e.g. the padded string
-- '  America/New_York  ' -- the error the caller sees is the trigger's
-- 'invalid IANA time zone', not the shape CHECK's violation. The shape CHECK
-- is defence-in-depth, not the first responder.
--
-- The trigger function is SECURITY INVOKER on purpose: pg_timezone_names is
-- PUBLIC-readable, so no privilege escalation is needed to read it, and an
-- INVOKER function is the smaller trust surface. search_path is still pinned
-- to pg_catalog, pg_temp.
--
-- ── email_outbox ─────────────────────────────────────────────────
-- The digest producer writes into the generic email_outbox from 037. That
-- table is FORCE ROW LEVEL SECURITY and jale_admin OWNS it (037:34), yet 037
-- gave jale_admin only SELECT and UPDATE policies -- there is no INSERT policy
-- for jale_admin at all, so an INSERT by jale_admin fails with "new row
-- violates row-level security policy" today. This migration adds the missing
-- INSERT policy, scoped to source_type = 'employer_digest', exactly mirroring
-- the email_outbox_billing_insert / billing_pause pair at 037:45-47.
--
-- The accompanying GRANT INSERT ON email_outbox TO jale_admin is
-- documentation-only: jale_admin owns the table, so it already holds INSERT
-- implicitly via Postgres ownership semantics regardless of the GRANT list
-- (only a REVOKE could remove it, and this migration does not do that). The
-- GRANT is written down so the intended interface is visible in one place,
-- the same posture 079's header takes about its own jale_admin grant list.
-- The thing that actually gates the write is the policy, not the grant.
--
-- ── jale_digest_enumerator: the 036 pattern ──────────────────────
-- The scheduled producer needs to answer a question no single tenant-scoped
-- role can answer: "across ALL employers, who is due right now?" Every
-- employer-facing policy on employer_digest_settings keys on
-- app.current_user_id, and the producer has no employer identity to set.
-- Running the producer as a role that can read every employer's row directly
-- would be a standing cross-tenant read grant.
--
-- Instead this follows the machinery 036_billing_job_limit_enforcement.sql
-- established: a NOLOGIN helper role (jale_digest_enumerator) with USING(true)
-- policies, a private schema it owns, and SECURITY DEFINER functions in that
-- schema that jale_admin may EXECUTE but whose underlying tables jale_admin
-- still cannot read cross-tenant. The caller gets exactly two answers -- the
-- due list, and an unsubscribe flip -- and nothing else.
--
-- The role-membership dance (creation guard -> GRANT ... WITH ADMIN TRUE,
-- INHERIT FALSE, SET FALSE -> temporary SET TRUE -> SET FALSE -> REVOKE ...
-- GRANTED BY jale_admin) is transcribed from 036 rather than reinvented, and
-- like 036 it establishes exactly ONE explicit creator ADMIN row that never
-- retains SET or INHERIT, on both plain PostgreSQL 16 and AWS RDS
-- PostgreSQL 16. The creating role is a non-superuser jale_admin with
-- CREATEROLE in BOTH environments -- RDS's master user is a member of
-- rds_superuser but is not rolsuper, and the local testbed creates the same
-- NOSUPERUSER CREATEROLE NOBYPASSRLS owner
-- (infra/db/local/bootstrap-testbed.sh) and applies the chain as it -- so the
-- automatic creator membership PostgreSQL 16 records (grantor = the bootstrap
-- superuser) is present either way, and the cleanup below removes only the
-- extra self-grant. Only the identifiers differ from 036.
--
-- The end state is asserted in the terminal verification block: a second
-- membership row carrying set_option would let jale_admin SET ROLE to the
-- enumerator and read every employer's row cross-tenant, so that assertion is
-- the actual guard, not documentation.
--
-- The enumerator's read of users is column-scoped to exactly
-- (id, cognito_sub, email, user_type) -- the four columns the producer needs to
-- address an email and confirm the account is still an employer. It gets no
-- SELECT on users.phone or users.full_name, and the terminal verification
-- block asserts that negatively, not just the positive four.
--
-- Its write surface on employer_digest_settings is a single column:
-- GRANT UPDATE (enabled). That is the whole of what unsubscribe needs. It
-- cannot change a timezone, a send hour, a language, or a token version.
--
-- Run AFTER 079_worker_application_defaults.sql, connected as jale_admin (NOT
-- the RDS master user). Forward-only (ADR-005).

BEGIN;

-- ── 1. Table ─────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS employer_digest_settings (
  employer_id               UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  enabled                   BOOLEAN NOT NULL DEFAULT false,
  send_hour_local           SMALLINT NOT NULL DEFAULT 8 CHECK (send_hour_local BETWEEN 0 AND 23),
  timezone                  TEXT NOT NULL DEFAULT 'America/Chicago',
  language                  TEXT NOT NULL DEFAULT 'en' CHECK (language IN ('en', 'es')),
  last_sent_at              TIMESTAMPTZ,
  unsubscribe_token_version SMALLINT NOT NULL DEFAULT 1 CHECK (unsubscribe_token_version >= 1),
  updated_at                TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT employer_digest_settings_timezone_shape CHECK (
    timezone = btrim(timezone)
    AND length(timezone) BETWEEN 1 AND 64
    AND timezone !~ '[^A-Za-z0-9_/+-]'
  )
);

-- DROP-guards throughout this file so a re-apply of it alone is clean
-- (CREATE POLICY / CREATE TRIGGER have no IF NOT EXISTS form). The chain is
-- still forward-only (ADR-005); this only hardens accidental re-runs.
DROP TRIGGER IF EXISTS employer_digest_settings_updated_at ON employer_digest_settings;

CREATE TRIGGER employer_digest_settings_updated_at
  BEFORE UPDATE ON employer_digest_settings
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

GRANT SELECT, INSERT, UPDATE ON employer_digest_settings TO jale_admin;

ALTER TABLE employer_digest_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE employer_digest_settings FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS employer_digest_settings_self ON employer_digest_settings;

CREATE POLICY employer_digest_settings_self ON employer_digest_settings FOR ALL
  TO jale_admin
  USING (
    employer_id = (
      SELECT id FROM users
      WHERE cognito_sub = current_setting('app.current_user_id', true)
        AND user_type = 'employer'
    )
  )
  WITH CHECK (
    employer_id = (
      SELECT id FROM users
      WHERE cognito_sub = current_setting('app.current_user_id', true)
        AND user_type = 'employer'
    )
  );

-- ── 2. IANA timezone validation trigger ──────────────────────────
-- Drop the trigger before the function so the function drop is not blocked by
-- a dependency on a re-apply.
DROP TRIGGER IF EXISTS employer_digest_settings_timezone_iana ON employer_digest_settings;
DROP FUNCTION IF EXISTS enforce_valid_iana_timezone();

CREATE FUNCTION enforce_valid_iana_timezone()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, pg_temp
AS $fn$
BEGIN
  -- Short-circuit when timezone did not actually change. This is load-bearing,
  -- not an optimisation:
  --   * pg_timezone_names() is a set-returning function that re-parses the
  --     entire tz database on every call (~14ms, no caching), so skipping it on
  --     the common "employer toggled `enabled`" UPDATE matters; and
  --   * more importantly, the accept-set can SHRINK across OS upgrades -- Debian
  --     trixie moved the compatibility link names (US/Pacific, EST5EDT, ...)
  --     out of tzdata into the separate tzdata-legacy package, so a value that
  --     was valid when it was stored can stop being listed later. Without this
  --     short-circuit, such a row would become un-updatable: the employer could
  --     no longer even turn the digest off, because every UPDATE would re-check
  --     a stored zone the new tzdata no longer lists. Re-validate only what the
  --     caller is actually setting.
  IF TG_OP = 'UPDATE' AND NEW.timezone IS NOT DISTINCT FROM OLD.timezone THEN
    RETURN NEW;
  END IF;

  -- Always qualify NEW.timezone / OLD.timezone. A bare `timezone` here would be
  -- ambiguous in the worst way: it is simultaneously a GUC name and a builtin
  -- function name, so an unqualified reference can silently resolve to
  -- something that is not this column.
  --
  -- pg_timezone_names DOES list three entries that are not portable IANA zone
  -- names and must be refused:
  --   * 'localtime'  -- a host-relative symlink to whatever the machine's local
  --                     zone happens to be; its meaning changes per host, so a
  --                     stored digest hour would mean different instants on the
  --                     bastion, on RDS, and on the testbed.
  --   * 'posixrules' -- a legacy DST-rule template, not a place.
  --   * 'Factory'    -- a deliberate placeholder whose abbreviation is the
  --                     string "Local time zone must be set--see zic manual".
  -- Verified present in pg_timezone_names on PostgreSQL 16.14 / Debian 13, so
  -- this exclusion is live code, not a defensive no-op.
  --
  -- Matching is case-SENSITIVE by design: 'america/new_york' is rejected even
  -- though `SET TIME ZONE` would accept it case-insensitively. Storing exactly
  -- one canonical spelling per zone keeps the value comparable as text and
  -- keeps the digest's rendered "8am America/New_York" copy stable.
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_timezone_names
    WHERE name = NEW.timezone
      AND name NOT IN ('localtime', 'posixrules', 'Factory')
  ) THEN
    RAISE EXCEPTION 'invalid IANA time zone: %', NEW.timezone
      USING ERRCODE = '23514',
            CONSTRAINT = 'timezone_iana_valid';
  END IF;

  RETURN NEW;
END;
$fn$;

-- UPDATE OF timezone (not bare UPDATE) so the expensive tz-database read is
-- not even considered on unrelated column writes. Same UPDATE OF shape as
-- 023's job_applications_hired_count_sync (023:213) and 043's
-- whatsapp_outbox_worker_intent_delivery_state (043:307); same
-- BEFORE-row-guard-that-RAISEs shape as 075:74-101 and 022:10-44.
CREATE TRIGGER employer_digest_settings_timezone_iana
  BEFORE INSERT OR UPDATE OF timezone ON employer_digest_settings
  FOR EACH ROW EXECUTE FUNCTION enforce_valid_iana_timezone();

-- ── 3. email_outbox access for the digest producer ───────────────
-- Documentation-only grant: jale_admin owns email_outbox (037:34) and already
-- holds INSERT through ownership. See the header. The policy is what actually
-- permits the write, because email_outbox is FORCE ROW LEVEL SECURITY.
GRANT INSERT ON email_outbox TO jale_admin;

DROP POLICY IF EXISTS email_outbox_admin_insert ON email_outbox;

CREATE POLICY email_outbox_admin_insert
  ON email_outbox FOR INSERT TO jale_admin
  WITH CHECK (source_type = 'employer_digest');

-- ── 4. jale_digest_enumerator role (036 machinery, transcribed) ──
DO $$
DECLARE
  helper pg_roles%ROWTYPE;
BEGIN
  SELECT * INTO helper FROM pg_roles WHERE rolname = 'jale_digest_enumerator';
  IF NOT FOUND THEN
    CREATE ROLE jale_digest_enumerator
      NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS;
    SELECT * INTO helper FROM pg_roles WHERE rolname = 'jale_digest_enumerator';
  END IF;

  IF helper.rolcanlogin OR helper.rolsuper OR helper.rolcreatedb
     OR helper.rolcreaterole OR helper.rolinherit OR helper.rolreplication
     OR helper.rolbypassrls THEN
    RAISE EXCEPTION 'Existing jale_digest_enumerator role has unsafe attributes';
  END IF;

  IF EXISTS (
    SELECT 1
      FROM pg_auth_members membership
      JOIN pg_roles granted ON granted.oid = membership.roleid
      JOIN pg_roles member ON member.oid = membership.member
      JOIN pg_roles grantor ON grantor.oid = membership.grantor
     WHERE (granted.rolname = helper.rolname OR member.rolname = helper.rolname)
       AND NOT (
         granted.rolname = helper.rolname
         AND member.rolname = 'jale_admin'
         AND membership.admin_option
         AND NOT membership.inherit_option
         AND NOT membership.set_option
         AND grantor.rolsuper
       )
  ) THEN
    RAISE EXCEPTION 'Existing jale_digest_enumerator role has unsafe memberships';
  END IF;

  -- AWS RDS creates no automatic creator membership; plain PostgreSQL may.
  IF NOT EXISTS (
    SELECT 1 FROM pg_auth_members membership
    JOIN pg_roles granted ON granted.oid = membership.roleid
    JOIN pg_roles member ON member.oid = membership.member
    JOIN pg_roles grantor ON grantor.oid = membership.grantor
    WHERE granted.rolname = helper.rolname
      AND member.rolname = 'jale_admin'
      AND membership.admin_option
      AND NOT membership.inherit_option
      AND NOT membership.set_option
      AND grantor.rolsuper
  ) THEN
    EXECUTE 'GRANT jale_digest_enumerator TO jale_admin WITH ADMIN TRUE, INHERIT FALSE, SET FALSE';
  END IF;
END;
$$;

GRANT USAGE ON SCHEMA public TO jale_digest_enumerator;

-- Exactly the four columns the producer needs: the id to key on, the
-- cognito_sub the settings UI resolves employers by, the email to send to, and
-- the user_type to confirm the account is still an employer. No phone, no
-- full_name -- asserted negatively in the verification block.
GRANT SELECT (id, cognito_sub, email, user_type) ON users TO jale_digest_enumerator;
GRANT SELECT ON employer_digest_settings TO jale_digest_enumerator;
-- Single-column write surface: unsubscribe flips `enabled` and nothing else.
GRANT UPDATE (enabled) ON employer_digest_settings TO jale_digest_enumerator;

DROP POLICY IF EXISTS users_digest_enumerator_select ON users;
CREATE POLICY users_digest_enumerator_select
  ON users FOR SELECT TO jale_digest_enumerator USING (true);

DROP POLICY IF EXISTS employer_digest_settings_digest_enumerator_select ON employer_digest_settings;
CREATE POLICY employer_digest_settings_digest_enumerator_select
  ON employer_digest_settings FOR SELECT TO jale_digest_enumerator USING (true);

DROP POLICY IF EXISTS employer_digest_settings_digest_enumerator_update ON employer_digest_settings;
CREATE POLICY employer_digest_settings_digest_enumerator_update
  ON employer_digest_settings FOR UPDATE TO jale_digest_enumerator
  USING (true) WITH CHECK (true);

-- Temporarily add SET capability; cleanup handles plain PG and RDS grantors.
GRANT jale_digest_enumerator TO jale_admin
  WITH SET TRUE, INHERIT FALSE;

DO $$
DECLARE
  internal_schema_owner NAME;
BEGIN
  SELECT owner.rolname INTO internal_schema_owner
    FROM pg_namespace namespace
    JOIN pg_roles owner ON owner.oid = namespace.nspowner
   WHERE namespace.nspname = 'jale_digest_internal';
  IF NOT FOUND THEN
    CREATE SCHEMA jale_digest_internal AUTHORIZATION jale_digest_enumerator;
  ELSIF internal_schema_owner <> 'jale_digest_enumerator' THEN
    RAISE EXCEPTION 'Existing jale_digest_internal schema has unexpected owner %', internal_schema_owner;
  END IF;
END;
$$;

SET LOCAL ROLE jale_digest_enumerator;
REVOKE ALL ON SCHEMA jale_digest_internal FROM PUBLIC;
RESET ROLE;

-- Defensive: an earlier revision of this work could have left same-named
-- functions in public. Same belt-and-braces drop 036:103 does.
DROP FUNCTION IF EXISTS public.due_digest_employers(TIMESTAMPTZ);
DROP FUNCTION IF EXISTS public.unsubscribe_employer(UUID, SMALLINT);

SET LOCAL ROLE jale_digest_enumerator;

DROP FUNCTION IF EXISTS jale_digest_internal.due_digest_employers(TIMESTAMPTZ);
-- Answers "which employers are due a digest at instant p_now?".
--
-- The producer sweeps every 15 minutes with no employer identity, so it cannot
-- satisfy employer_digest_settings_self. This function is SECURITY DEFINER,
-- owned by jale_digest_enumerator, and therefore evaluates under the
-- USING(true) policies granted above -- the only cross-tenant read in the
-- digest feature, and it returns nothing but the fields needed to render,
-- address, and unsubscribe from a digest.
--
-- unsubscribe_token_version is returned so the producer can mint the
-- one-click unsubscribe token from (employer_id, token_version) without a
-- second per-employer query back through this same privilege boundary.
--
-- Both comparisons deliberately convert to the row's OWN zone:
--   * the hour match reads the wall-clock hour in s.timezone, so 08:00 means
--     08:00 in New York for one employer and 08:00 in Los Angeles for another,
--     at two different UTC instants. At a 15-minute sweep cadence the hour
--     predicate is true for up to four consecutive sweeps; see the header --
--     the watermark, not the hour, is what makes the digest at-most-once.
--   * the watermark compares LOCAL dates, not UTC dates. Comparing UTC dates
--     would let an employer whose local day has not rolled over yet receive a
--     second digest (or skip one) whenever their offset straddles UTC midnight.
-- Neither comparison consults the session TimeZone GUC, so the producer's
-- connection settings cannot change who is due.
--
-- ── Why the MATERIALIZED pre-join on pg_timezone_names ───────────
-- `AT TIME ZONE <unlisted zone>` does NOT return NULL, it RAISES (22023,
-- 'time zone "..." not recognized'). Because this function returns a set, a
-- single unusable row would abort the whole RETURN QUERY and every employer
-- would miss their digest -- one bad row causing a total outage. That is not
-- hypothetical: it is exactly the tzdata-shrink case the timezone-trigger
-- comment above describes (Debian trixie moved the link names into
-- tzdata-legacy), where a zone that was valid when it was stored stops being
-- listed after an OS upgrade.
--
-- Joining to pg_timezone_names first turns that outage into a per-row skip:
-- an employer whose zone is no longer listed is silently omitted, everyone
-- else still gets their digest. Operators should alarm on enabled rows that
-- this join drops; losing one employer quietly is the lesser failure, but it
-- is still a failure.
--
-- MATERIALIZED is load-bearing, not decoration. Verified on PostgreSQL 16.14:
-- with a plain (inlinable) CTE the planner still hoists the
-- date_part(... AT TIME ZONE s.timezone) predicate to before the join and the
-- statement raises anyway. MATERIALIZED fences the CTE so the filter provably
-- runs first. pg_timezone_names.name is unique, so the inner join cannot fan
-- out and duplicate an employer (a duplicate here would mean a duplicate
-- email). Cost is one tz-database scan per call (~14ms), which is nothing at a
-- 15-minute cadence.
CREATE FUNCTION jale_digest_internal.due_digest_employers(p_now TIMESTAMPTZ)
RETURNS TABLE (
  employer_id               uuid,
  cognito_sub               text,
  email                     text,
  send_hour_local           smallint,
  timezone                  text,
  language                  text,
  last_sent_at              timestamptz,
  unsubscribe_token_version smallint
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $fn$
BEGIN
  RETURN QUERY
  WITH listed AS MATERIALIZED (
    SELECT s.*
      FROM public.employer_digest_settings s
      JOIN pg_catalog.pg_timezone_names tz ON tz.name = s.timezone
     WHERE s.enabled
  )
  SELECT l.employer_id, u.cognito_sub, u.email, l.send_hour_local,
         l.timezone, l.language, l.last_sent_at, l.unsubscribe_token_version
    FROM listed l
    JOIN public.users u ON u.id = l.employer_id
   WHERE u.user_type = 'employer'
     AND date_part('hour', p_now AT TIME ZONE l.timezone) = l.send_hour_local
     AND (
       l.last_sent_at IS NULL
       OR (l.last_sent_at AT TIME ZONE l.timezone)::date < (p_now AT TIME ZONE l.timezone)::date
     );
END;
$fn$;

DROP FUNCTION IF EXISTS jale_digest_internal.unsubscribe_employer(UUID, SMALLINT);
-- One-click unsubscribe. Returns true when a row was flipped.
--
-- IMPORTANT: this function does NOT verify the unsubscribe token. Token
-- verification (signature/HMAC over the employer id and version, expiry, and
-- constant-time comparison) happens in the Lambda BEFORE this is called; all
-- this function does is refuse to act when the version the caller presents no
-- longer matches the row, which is what makes a version bump invalidate every
-- previously-issued link. Do not treat p_token_version as an authenticator.
--
-- It writes exactly one column, `enabled`, which is the whole of what
-- jale_digest_enumerator is granted UPDATE on. updated_at is maintained by
-- employer_digest_settings_updated_at, not by this function.
CREATE FUNCTION jale_digest_internal.unsubscribe_employer(
  p_employer_id UUID,
  p_token_version SMALLINT
)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $fn$
BEGIN
  UPDATE public.employer_digest_settings
     SET enabled = false
   WHERE employer_id = p_employer_id
     AND unsubscribe_token_version = p_token_version;
  RETURN FOUND;
END;
$fn$;

REVOKE ALL ON FUNCTION jale_digest_internal.due_digest_employers(TIMESTAMPTZ) FROM PUBLIC;
REVOKE ALL ON FUNCTION jale_digest_internal.unsubscribe_employer(UUID, SMALLINT) FROM PUBLIC;
GRANT USAGE ON SCHEMA jale_digest_internal TO jale_admin;
GRANT EXECUTE ON FUNCTION jale_digest_internal.due_digest_employers(TIMESTAMPTZ) TO jale_admin;
GRANT EXECUTE ON FUNCTION jale_digest_internal.unsubscribe_employer(UUID, SMALLINT) TO jale_admin;
RESET ROLE;

-- Disable SET on the selected grantor row, then remove any plain-PG self-grant.
GRANT jale_digest_enumerator TO jale_admin
  WITH SET FALSE, INHERIT FALSE;
REVOKE jale_digest_enumerator FROM jale_admin GRANTED BY jale_admin;

-- ── 5. Verification ──────────────────────────────────────────────
DO $$
DECLARE
  helper pg_roles%ROWTYPE;
  expected_column RECORD;
  expected_policy RECORD;
  definer_name NAME;
  definer_oid OID;
  definer_owner NAME;
  definer_secdef BOOLEAN;
  definer_config TEXT[];
  definer_count INTEGER;
  blocked_role NAME;
  enumerator_users_select TEXT[];
  enumerator_settings_update TEXT[];
  enumerator_priv_types TEXT[];
BEGIN
  IF to_regclass('public.employer_digest_settings') IS NULL THEN
    RAISE EXCEPTION 'employer_digest_settings table missing';
  END IF;

  -- Per-column name / nullability / data_type.
  FOR expected_column IN
    SELECT * FROM (VALUES
      ('employer_id',               'NO',  'uuid'),
      ('enabled',                   'NO',  'boolean'),
      ('send_hour_local',           'NO',  'smallint'),
      ('timezone',                  'NO',  'text'),
      ('language',                  'NO',  'text'),
      ('last_sent_at',              'YES', 'timestamp with time zone'),
      ('unsubscribe_token_version', 'NO',  'smallint'),
      ('updated_at',                'NO',  'timestamp with time zone')
    ) AS t(column_name, is_nullable, data_type)
  LOOP
    IF NOT EXISTS (
      SELECT 1 FROM information_schema.columns c
      WHERE c.table_schema = 'public' AND c.table_name = 'employer_digest_settings'
        AND c.column_name = expected_column.column_name
        AND c.is_nullable = expected_column.is_nullable
        AND c.data_type = expected_column.data_type
    ) THEN
      RAISE EXCEPTION 'employer_digest_settings.% missing, or not (%, %)',
        expected_column.column_name, expected_column.is_nullable, expected_column.data_type;
    END IF;
  END LOOP;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_class rel ON rel.oid = c.conrelid
    WHERE rel.relname = 'employer_digest_settings' AND c.contype = 'p'
  ) THEN
    RAISE EXCEPTION 'employer_digest_settings missing its PRIMARY KEY on employer_id';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_class rel ON rel.oid = c.conrelid
    WHERE rel.relname = 'employer_digest_settings' AND c.contype = 'f'
      AND pg_get_constraintdef(c.oid) ILIKE '%REFERENCES users(id)%ON DELETE CASCADE%'
  ) THEN
    RAISE EXCEPTION 'employer_digest_settings.employer_id missing its ON DELETE CASCADE FK to users(id)';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_class rel ON rel.oid = c.conrelid
    WHERE rel.relname = 'employer_digest_settings' AND c.contype = 'c'
      AND c.conname = 'employer_digest_settings_timezone_shape'
  ) THEN
    RAISE EXCEPTION 'employer_digest_settings_timezone_shape CHECK missing';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_class rel
    JOIN pg_namespace n ON n.oid = rel.relnamespace
    WHERE n.nspname = 'public' AND rel.relname = 'employer_digest_settings'
      AND rel.relrowsecurity AND rel.relforcerowsecurity
  ) THEN
    RAISE EXCEPTION 'employer_digest_settings must have RLS ENABLE + FORCE';
  END IF;

  -- Every policy this migration creates, pinned by SHAPE and not merely by
  -- name: polcmd (so a policy cannot be silently re-scoped from SELECT to ALL)
  -- and polroles (so it cannot be widened to another role or to PUBLIC).
  -- polcmd codes: 'r' SELECT, 'a' INSERT, 'w' UPDATE, '*' ALL.
  --
  -- expect_qual / expect_withcheck are pinned only where the expression is the
  -- literal `true` -- that is the security-relevant part of a USING(true)
  -- helper policy. They are left NULL for employer_digest_settings_self (whose
  -- qual is the cognito_sub subquery) and for email_outbox_admin_insert:
  -- matching Postgres's re-rendered expression text for those would be brittle
  -- without adding real safety, and no sibling migration does it.
  FOR expected_policy IN
    SELECT * FROM (VALUES
      ('employer_digest_settings', 'employer_digest_settings_self',
       '*', 'jale_admin',             NULL::TEXT, NULL::TEXT),
      ('employer_digest_settings', 'employer_digest_settings_digest_enumerator_select',
       'r', 'jale_digest_enumerator', 'true',     NULL::TEXT),
      ('employer_digest_settings', 'employer_digest_settings_digest_enumerator_update',
       'w', 'jale_digest_enumerator', 'true',     'true'),
      ('users',                    'users_digest_enumerator_select',
       'r', 'jale_digest_enumerator', 'true',     NULL::TEXT),
      -- 037 shipped SELECT + UPDATE policies for jale_admin only, so without
      -- this INSERT policy the producer's outbox write fails under FORCE RLS.
      ('email_outbox',             'email_outbox_admin_insert',
       'a', 'jale_admin',             NULL::TEXT, NULL::TEXT)
    ) AS t(relname, polname, polcmd, polrole, expect_qual, expect_withcheck)
  LOOP
    IF NOT EXISTS (
      SELECT 1 FROM pg_policy p
      JOIN pg_class rel ON rel.oid = p.polrelid
      JOIN pg_namespace n ON n.oid = rel.relnamespace
      WHERE n.nspname = 'public'
        AND rel.relname = expected_policy.relname
        AND p.polname = expected_policy.polname
        AND p.polcmd::TEXT = expected_policy.polcmd
        AND p.polroles = ARRAY[(
              SELECT oid FROM pg_roles WHERE rolname = expected_policy.polrole
            )]
        AND (expected_policy.expect_qual IS NULL
             OR pg_get_expr(p.polqual, p.polrelid) = expected_policy.expect_qual)
        AND (expected_policy.expect_withcheck IS NULL
             OR pg_get_expr(p.polwithcheck, p.polrelid) = expected_policy.expect_withcheck)
    ) THEN
      RAISE EXCEPTION 'policy %.% missing or wrong shape (expected cmd=%, role=%)',
        expected_policy.relname, expected_policy.polname,
        expected_policy.polcmd, expected_policy.polrole;
    END IF;
  END LOOP;

  -- Both triggers present as real (non-internal) triggers.
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger t
    JOIN pg_class rel ON rel.oid = t.tgrelid
    WHERE rel.relname = 'employer_digest_settings' AND NOT t.tgisinternal
      AND t.tgname = 'employer_digest_settings_updated_at'
  ) THEN
    RAISE EXCEPTION 'employer_digest_settings_updated_at trigger missing';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger t
    JOIN pg_class rel ON rel.oid = t.tgrelid
    WHERE rel.relname = 'employer_digest_settings' AND NOT t.tgisinternal
      AND t.tgname = 'employer_digest_settings_timezone_iana'
  ) THEN
    RAISE EXCEPTION 'employer_digest_settings_timezone_iana trigger missing';
  END IF;

  -- The private schema must not be reachable by PUBLIC (036:249-257 shape).
  IF EXISTS (
    SELECT 1 FROM pg_namespace n,
      LATERAL aclexplode(COALESCE(n.nspacl, acldefault('n', n.nspowner))) acl
    WHERE n.nspname = 'jale_digest_internal' AND acl.grantee = 0
  ) THEN
    RAISE EXCEPTION 'jale_digest_internal is reachable by PUBLIC';
  END IF;

  -- Exactly the two intended functions live in the private schema -- a stray
  -- third definer function there would inherit the same cross-tenant reach.
  SELECT count(*) INTO definer_count
    FROM pg_proc f JOIN pg_namespace n ON n.oid = f.pronamespace
   WHERE n.nspname = 'jale_digest_internal';
  IF definer_count <> 2 THEN
    RAISE EXCEPTION 'jale_digest_internal holds % functions, expected exactly 2', definer_count;
  END IF;

  -- Both definer functions: present, owned by the enumerator, SECURITY
  -- DEFINER, search_path pinned, not PUBLIC-executable, executable by
  -- jale_admin. prosecdef alone is not enough -- a SECURITY DEFINER function
  -- owned by the wrong role runs with the wrong privileges, and an unpinned
  -- search_path on a definer function is the classic hijack vector.
  FOREACH definer_name IN ARRAY ARRAY[
    'due_digest_employers', 'unsubscribe_employer'
  ]::NAME[] LOOP
    SELECT f.oid, owner.rolname, f.prosecdef, f.proconfig
      INTO definer_oid, definer_owner, definer_secdef, definer_config
      FROM pg_proc f
      JOIN pg_namespace n ON n.oid = f.pronamespace
      JOIN pg_roles owner ON owner.oid = f.proowner
     WHERE n.nspname = 'jale_digest_internal' AND f.proname = definer_name;

    IF NOT FOUND
       OR definer_owner <> 'jale_digest_enumerator'
       OR NOT definer_secdef
       OR definer_config IS DISTINCT FROM ARRAY['search_path=pg_catalog, pg_temp']::TEXT[] THEN
      RAISE EXCEPTION 'jale_digest_internal.% definer invariant failed (owner/SECURITY DEFINER/search_path)',
        definer_name;
    END IF;

    IF EXISTS (
      SELECT 1 FROM pg_proc f,
        LATERAL aclexplode(COALESCE(f.proacl, acldefault('f', f.proowner))) acl
      WHERE f.oid = definer_oid AND acl.grantee = 0 AND acl.privilege_type = 'EXECUTE'
    ) THEN
      RAISE EXCEPTION 'jale_digest_internal.% is EXECUTE-able by PUBLIC', definer_name;
    END IF;

    IF NOT has_function_privilege('jale_admin', definer_oid, 'EXECUTE') THEN
      RAISE EXCEPTION 'jale_admin missing EXECUTE on jale_digest_internal.%', definer_name;
    END IF;
  END LOOP;

  -- Role attribute invariant (same shape as 036's).
  SELECT * INTO helper FROM pg_roles WHERE rolname = 'jale_digest_enumerator';
  IF NOT FOUND OR helper.rolcanlogin OR helper.rolsuper OR helper.rolcreatedb
     OR helper.rolcreaterole OR helper.rolinherit OR helper.rolreplication
     OR helper.rolbypassrls THEN
    RAISE EXCEPTION 'jale_digest_enumerator role attribute invariant failed';
  END IF;

  -- Positive jale_admin grants. jale_admin OWNS this table (it ran the CREATE
  -- TABLE above), so information_schema shows it holding every table-level
  -- privilege via ownership regardless of the GRANT list -- these assertions
  -- pin the intended interface, they do not prove a restriction. Same caveat
  -- 079's verification block documents.
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_privileges
    WHERE grantee = 'jale_admin' AND table_schema = 'public'
      AND table_name = 'employer_digest_settings' AND privilege_type = 'SELECT'
  ) OR NOT EXISTS (
    SELECT 1 FROM information_schema.table_privileges
    WHERE grantee = 'jale_admin' AND table_schema = 'public'
      AND table_name = 'employer_digest_settings' AND privilege_type = 'INSERT'
  ) OR NOT EXISTS (
    SELECT 1 FROM information_schema.table_privileges
    WHERE grantee = 'jale_admin' AND table_schema = 'public'
      AND table_name = 'employer_digest_settings' AND privilege_type = 'UPDATE'
  ) THEN
    RAISE EXCEPTION 'jale_admin missing SELECT/INSERT/UPDATE grant on employer_digest_settings';
  END IF;

  IF NOT has_schema_privilege('jale_admin', 'jale_digest_internal', 'USAGE') THEN
    RAISE EXCEPTION 'jale_admin missing USAGE on jale_digest_internal';
  END IF;

  -- Enumerator: exactly the four users columns, and provably not the PII ones.
  IF NOT has_column_privilege('jale_digest_enumerator', 'users', 'id', 'SELECT')
     OR NOT has_column_privilege('jale_digest_enumerator', 'users', 'cognito_sub', 'SELECT')
     OR NOT has_column_privilege('jale_digest_enumerator', 'users', 'email', 'SELECT')
     OR NOT has_column_privilege('jale_digest_enumerator', 'users', 'user_type', 'SELECT')
     OR has_column_privilege('jale_digest_enumerator', 'users', 'phone', 'SELECT')
     OR has_column_privilege('jale_digest_enumerator', 'users', 'full_name', 'SELECT')
     OR has_table_privilege('jale_digest_enumerator', 'users', 'INSERT,UPDATE,DELETE') THEN
    RAISE EXCEPTION 'jale_digest_enumerator users column privilege invariant failed';
  END IF;

  IF NOT has_table_privilege('jale_digest_enumerator', 'employer_digest_settings', 'SELECT')
     OR NOT has_column_privilege('jale_digest_enumerator', 'employer_digest_settings', 'enabled', 'UPDATE')
     OR has_column_privilege('jale_digest_enumerator', 'employer_digest_settings', 'timezone', 'UPDATE')
     OR has_column_privilege('jale_digest_enumerator', 'employer_digest_settings', 'send_hour_local', 'UPDATE')
     OR has_column_privilege('jale_digest_enumerator', 'employer_digest_settings', 'language', 'UPDATE')
     OR has_column_privilege('jale_digest_enumerator', 'employer_digest_settings', 'unsubscribe_token_version', 'UPDATE')
     OR has_table_privilege('jale_digest_enumerator', 'employer_digest_settings', 'INSERT,DELETE') THEN
    RAISE EXCEPTION 'jale_digest_enumerator employer_digest_settings privilege invariant failed';
  END IF;

  -- EXACT column-grant arrays (036:196-211 shape), not spot probes: a future
  -- widening GRANT must fail this block rather than slip through because
  -- nobody thought to add a probe for the new column.
  --
  -- Scoped by table_name AND privilege_type deliberately. A table-level
  -- GRANT SELECT expands into one row per column in
  -- information_schema.column_privileges (verified on PG 16.14), so the
  -- employer_digest_settings SELECT slice is every column and pinning it as a
  -- literal list would break on any future ADD COLUMN. The two slices pinned
  -- here are the ones that carry the security claim: which four users columns
  -- are readable, and which single settings column is writable.
  SELECT array_agg(column_name::TEXT ORDER BY column_name::TEXT)
    INTO enumerator_users_select
    FROM information_schema.column_privileges
   WHERE grantee = 'jale_digest_enumerator' AND table_schema = 'public'
     AND table_name = 'users' AND privilege_type = 'SELECT';
  IF enumerator_users_select IS DISTINCT FROM
     ARRAY['cognito_sub', 'email', 'id', 'user_type']::TEXT[] THEN
    RAISE EXCEPTION 'jale_digest_enumerator exact users SELECT column grants changed: %',
      COALESCE(enumerator_users_select::TEXT, '<none>');
  END IF;

  SELECT array_agg(column_name::TEXT ORDER BY column_name::TEXT)
    INTO enumerator_settings_update
    FROM information_schema.column_privileges
   WHERE grantee = 'jale_digest_enumerator' AND table_schema = 'public'
     AND table_name = 'employer_digest_settings' AND privilege_type = 'UPDATE';
  IF enumerator_settings_update IS DISTINCT FROM ARRAY['enabled']::TEXT[] THEN
    RAISE EXCEPTION 'jale_digest_enumerator exact employer_digest_settings UPDATE column grants changed: %',
      COALESCE(enumerator_settings_update::TEXT, '<none>');
  END IF;

  -- And no privilege KIND beyond those two on either table, which catches a
  -- widening INSERT/DELETE/REFERENCES grant without hard-coding every column.
  SELECT array_agg(DISTINCT privilege_type::TEXT ORDER BY privilege_type::TEXT)
    INTO enumerator_priv_types
    FROM information_schema.column_privileges
   WHERE grantee = 'jale_digest_enumerator' AND table_schema = 'public'
     AND table_name IN ('users', 'employer_digest_settings');
  IF enumerator_priv_types IS DISTINCT FROM ARRAY['SELECT', 'UPDATE']::TEXT[] THEN
    RAISE EXCEPTION 'jale_digest_enumerator holds unexpected privilege kinds: %',
      COALESCE(enumerator_priv_types::TEXT, '<none>');
  END IF;

  -- No other service role gets anything on this table.
  FOREACH blocked_role IN ARRAY ARRAY[
    'jale_whatsapp', 'jale_matching', 'jale_billing'
  ]::NAME[] LOOP
    IF EXISTS (
      SELECT 1 FROM information_schema.table_privileges
      WHERE grantee = blocked_role::TEXT AND table_schema = 'public'
        AND table_name = 'employer_digest_settings'
    ) OR EXISTS (
      SELECT 1 FROM information_schema.column_privileges
      WHERE grantee = blocked_role::TEXT AND table_schema = 'public'
        AND table_name = 'employer_digest_settings'
    ) THEN
      RAISE EXCEPTION '% unexpectedly has a privilege on employer_digest_settings', blocked_role;
    END IF;
  END LOOP;

  -- tzdata smoke checks. Deliberately NOT using link names such as US/Pacific
  -- or EST5EDT: Debian trixie moved those into the separate tzdata-legacy
  -- package, so they are present on RDS and ABSENT on the Debian-13 testbed
  -- image. Asserting on them would make this block fail for a reason that has
  -- nothing to do with this migration. America/Mexico_City is a real zone in
  -- every tzdata build the platform runs on.
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_timezone_names WHERE name = 'America/Mexico_City'
  ) THEN
    RAISE EXCEPTION 'pg_timezone_names is missing America/Mexico_City -- tzdata unusable for digest scheduling';
  END IF;

  IF EXISTS (
    SELECT 1 FROM pg_catalog.pg_timezone_names WHERE name = 'Zzz/Definitely_Not_A_Zone'
  ) THEN
    RAISE EXCEPTION 'pg_timezone_names matched a nonexistent zone -- the timezone trigger cannot be trusted';
  END IF;

  -- ── Creator-membership end state (036:281-300, transcribed) ────
  -- THE load-bearing assertion of the whole role dance, and on RDS the only
  -- thing that checks it (no Jest runs there). Exactly ONE pg_auth_members row
  -- may reference jale_digest_enumerator, and it must be the jale_admin
  -- creator ADMIN row with neither INHERIT nor SET.
  --
  -- A surviving second row carrying set_option would let jale_admin
  -- `SET ROLE jale_digest_enumerator` and then read EVERY employer's settings
  -- row directly under the USING(true) policies -- i.e. a standing
  -- cross-tenant read, which is precisely what routing all access through the
  -- two definer functions exists to prevent. inherit_option would be worse
  -- still: the enumerator's privileges would apply without any SET ROLE at all.
  IF (SELECT count(*) FROM pg_auth_members membership
       JOIN pg_roles granted ON granted.oid = membership.roleid
       JOIN pg_roles member ON member.oid = membership.member
      WHERE granted.rolname = 'jale_digest_enumerator'
         OR member.rolname = 'jale_digest_enumerator') <> 1
     OR NOT EXISTS (
       SELECT 1 FROM pg_auth_members membership
       JOIN pg_roles granted ON granted.oid = membership.roleid
       JOIN pg_roles member ON member.oid = membership.member
       JOIN pg_roles grantor ON grantor.oid = membership.grantor
      WHERE granted.rolname = 'jale_digest_enumerator'
        AND member.rolname = 'jale_admin'
        AND membership.admin_option
        AND NOT membership.inherit_option
        AND NOT membership.set_option
        AND grantor.rolsuper
     ) THEN
    RAISE EXCEPTION 'jale_digest_enumerator creator membership invariant failed';
  END IF;
END;
$$;

COMMIT;
