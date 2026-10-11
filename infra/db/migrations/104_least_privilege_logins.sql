-- ============================================================
-- 104_least_privilege_logins.sql
-- Run manually AFTER 103_worker_referred_jobs.sql,
-- connected as jale_admin. Forward-only (ADR-005). ONE transaction.
--
-- Sprint 27, least-privilege database access, part 1 of 3:
--   104  the dedicated logins, the capability schema and its owner roles,
--        the operator read-only group, and definer hygiene (this file);
--   105  the capability functions in jale_cap and their owners' rights;
--   106  the reviewed access rights, generated from
--        infra/db/access/manifest.json.
--
-- WHO RUNS THIS. jale_admin, the login every migration runs as, which owns
-- every table.
-- The logins this file creates are the workloads' own; none owns a table.
--
-- (1) Dedicated logins. Each workload gets its own login, holding only the
--     rights its SQL needs (106 grants them, from the manifest):
--       jale_api                    the authenticated request paths
--       jale_api_public             the unauthenticated tokenized endpoints:
--                                   EXECUTE only, no table rights
--       jale_job_email_sender       the email outbox sender
--       jale_job_visibility_drain   the job visibility outbox drain
--       jale_job_digest             the employer digest producer
--       jale_job_ses_feedback       the email delivery feedback handler
--       jale_job_retention          the referral retention sweeper
--       jale_posture                the catalog-only posture check
--     Attributes: LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION
--     NOBYPASSRLS NOINHERIT, member of no role, and a CONNECTION LIMIT: none
--     for the two request logins (they carry the request fleet), 5 for each
--     job login, 2 for the posture check. Each login gets CONNECT on this
--     database and, except the posture login, USAGE on public.
--     Every runtime login except the posture check also ends a session that
--     stays idle inside an open transaction for 60 seconds
--     (idle_in_transaction_session_timeout), so a stalled client never keeps
--     its locks and snapshot.
--     Every login is created WITHOUT a password and cannot sign in until
--     credential preparation (scripts/run-migrations.sh --prepare-logins)
--     sets a SCRAM verifier for an AWS-generated secret. No password ever
--     appears in a migration. jale_admin keeps the ADMIN-only membership
--     PostgreSQL 16 gives a role's creator: it is what lets the migration
--     login set the password later, and it carries neither SET nor INHERIT.
--
-- (2) jale_cap, the schema the capability functions live in: owned by
--     jale_admin and closed to PUBLIC. Its owner roles get CREATE on it here
--     (ALTER FUNCTION ... OWNER TO requires it); 105 gives the callers USAGE.
--
-- (3) Capability owners: one NOLOGIN, NOINHERIT role per capability (082's
--     helper-role block, transcribed). jale_admin holds only the creator's
--     ADMIN membership in each; 105 adds SET only for its ownership-transfer
--     window and removes it again before it commits.
--
-- (4) jale_ops_readonly: the operator read-only group. It has no grants yet.
--     The coverage guard holds every member to three rules: member of this
--     group only, VALID UNTIL set, no write grants.
--
-- (5) Hygiene.
--     a. Pin the eight definers whose search_path lacks pg_temp to
--        `pg_catalog, public, pg_temp`. Only pg_temp moves, from implicitly
--        first to last; every name they use still resolves the same way.
--     b. Revoke PUBLIC EXECUTE on the sync_job_hired_counts() trigger
--        function. Firing a trigger checks no EXECUTE right, so every writer
--        keeps working.
--     c. Remove jale_admin's SET membership in jale_location_backfill (067,
--        086). Nothing runs SET ROLE to it; the geo backfill uses definers.
--     d. ALTER DEFAULT PRIVILEGES: functions jale_admin creates from now on
--        are not executable by PUBLIC. A later migration grants EXECUTE
--        explicitly to whichever login calls a new function -- including an
--        invoker function that a CHECK constraint calls.
--     e. Revoke TEMPORARY on this database from PUBLIC: no login may create
--        temporary tables, and no runtime path uses them.
--        The master keeps TEMPORARY as the database owner (operator scripts).
--
-- DEPLOY ORDER: apply this migration BEFORE the release deploy. The deployed
-- code keeps working on it unchanged: no workload connects as a new login
-- until the release deploy switches it, and the hygiene changes nothing a
-- deployed path relies on.
--
-- REPLAY. Safe at any time. Every role, schema and grant is created only when
-- missing; an existing role whose attributes or memberships differ is
-- refused, never altered. The idle-transaction timeout is simply set again.
-- The pins skip a function 105 has already re-owned. The self-audit at the
-- end re-proves every property either way.
-- ============================================================
BEGIN;

-- Creating roles and altering functions takes only short catalog locks, but
-- never queue behind a stuck transaction: a timed-out apply writes no ledger
-- row and can simply be rerun.
SET LOCAL lock_timeout = '5s';

-- ── 1. Dedicated logins ─────────────────────────────────────
DO $$
DECLARE
  spec RECORD;
  existing pg_catalog.pg_roles%ROWTYPE;
BEGIN
  FOR spec IN
    SELECT * FROM (VALUES
      ('jale_api', -1),
      ('jale_api_public', -1),
      ('jale_job_email_sender', 5),
      ('jale_job_visibility_drain', 5),
      ('jale_job_digest', 5),
      ('jale_job_ses_feedback', 5),
      ('jale_job_retention', 5),
      ('jale_posture', 2)
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
      RAISE EXCEPTION 'migration 104: existing login % has unexpected attributes; refusing to adopt it', spec.login;
    END IF;

    IF EXISTS (
      SELECT 1 FROM pg_catalog.pg_auth_members am
       WHERE am.member = (SELECT oid FROM pg_catalog.pg_roles WHERE rolname = spec.login)
    ) THEN
      RAISE EXCEPTION 'migration 104: login % must not be a member of any role', spec.login;
    END IF;

    -- The only membership IN the login is the creator's ADMIN-only row.
    IF EXISTS (
      SELECT 1 FROM pg_catalog.pg_auth_members am
       WHERE am.roleid = (SELECT oid FROM pg_catalog.pg_roles WHERE rolname = spec.login)
         AND NOT (am.member = (SELECT oid FROM pg_catalog.pg_roles WHERE rolname = current_user)
                  AND am.admin_option AND NOT am.inherit_option AND NOT am.set_option)
    ) THEN
      RAISE EXCEPTION 'migration 104: role % has unsafe memberships', spec.login;
    END IF;
    IF NOT EXISTS (
      SELECT 1 FROM pg_catalog.pg_auth_members am
       WHERE am.roleid = (SELECT oid FROM pg_catalog.pg_roles WHERE rolname = spec.login)
         AND am.member = (SELECT oid FROM pg_catalog.pg_roles WHERE rolname = current_user)
         AND am.admin_option
    ) THEN
      EXECUTE format('GRANT %I TO %I WITH ADMIN TRUE, INHERIT FALSE, SET FALSE', spec.login, current_user);
    END IF;
  END LOOP;
END;
$$;

DO $$
DECLARE
  login TEXT;
BEGIN
  FOREACH login IN ARRAY ARRAY[
    'jale_api', 'jale_api_public', 'jale_job_email_sender', 'jale_job_visibility_drain',
    'jale_job_digest', 'jale_job_ses_feedback', 'jale_job_retention', 'jale_posture'
  ] LOOP
    EXECUTE format('GRANT CONNECT ON DATABASE %I TO %I', current_database(), login);
  END LOOP;
END;
$$;

-- The posture login reads the catalog only and needs no schema right.
GRANT USAGE ON SCHEMA public TO
  jale_api, jale_api_public, jale_job_email_sender, jale_job_visibility_drain,
  jale_job_digest, jale_job_ses_feedback, jale_job_retention;

-- A session idle inside an open transaction for a minute is ended by the
-- server. The posture login runs one short catalog read and is left alone.
ALTER ROLE jale_api SET idle_in_transaction_session_timeout = '60s';
ALTER ROLE jale_api_public SET idle_in_transaction_session_timeout = '60s';
ALTER ROLE jale_job_email_sender SET idle_in_transaction_session_timeout = '60s';
ALTER ROLE jale_job_visibility_drain SET idle_in_transaction_session_timeout = '60s';
ALTER ROLE jale_job_digest SET idle_in_transaction_session_timeout = '60s';
ALTER ROLE jale_job_ses_feedback SET idle_in_transaction_session_timeout = '60s';
ALTER ROLE jale_job_retention SET idle_in_transaction_session_timeout = '60s';

-- ── 2. The capability schema ────────────────────────────────
DO $$
DECLARE
  schema_owner NAME;
BEGIN
  SELECT pg_catalog.pg_get_userbyid(n.nspowner) INTO schema_owner
    FROM pg_catalog.pg_namespace n
   WHERE n.nspname = 'jale_cap';
  IF NOT FOUND THEN
    CREATE SCHEMA jale_cap AUTHORIZATION jale_admin;
  ELSIF schema_owner <> 'jale_admin' THEN
    RAISE EXCEPTION 'migration 104: existing jale_cap schema has unexpected owner %', schema_owner;
  END IF;
END;
$$;

REVOKE ALL ON SCHEMA jale_cap FROM PUBLIC;

-- ── 3-4. Capability owners and the operator read-only group ──
DO $$
DECLARE
  spec RECORD;
  helper pg_catalog.pg_roles%ROWTYPE;
BEGIN
  FOR spec IN
    SELECT * FROM (VALUES
      ('jale_cap_upload_tokens', true),
      ('jale_cap_worker_lane', true),
      ('jale_cap_share_links', true),
      ('jale_cap_ses_feedback', true),
      ('jale_cap_retention', true),
      ('jale_cap_stale_outbox', true),
      ('jale_cap_hired_counts', true),
      ('jale_cap_job_messaging', true),
      ('jale_ops_readonly', false)
    ) AS t(role_name, is_owner)
  LOOP
    SELECT * INTO helper FROM pg_catalog.pg_roles WHERE rolname = spec.role_name;
    IF NOT FOUND THEN
      EXECUTE format(
        'CREATE ROLE %I NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS',
        spec.role_name
      );
      SELECT * INTO helper FROM pg_catalog.pg_roles WHERE rolname = spec.role_name;
    END IF;

    IF helper.rolcanlogin OR helper.rolsuper OR helper.rolcreatedb OR helper.rolcreaterole
       OR helper.rolinherit OR helper.rolreplication OR helper.rolbypassrls THEN
      RAISE EXCEPTION 'migration 104: existing role % has unsafe attributes', spec.role_name;
    END IF;

    -- Neither an owner nor the group may belong to another role. An owner
    -- has no member but the creator's ADMIN-only row; the group's members are
    -- the operator logins, whose rules the coverage guard enforces.
    IF EXISTS (
      SELECT 1 FROM pg_catalog.pg_auth_members am
       WHERE am.member = helper.oid
          OR (spec.is_owner AND am.roleid = helper.oid
              AND NOT (am.member = (SELECT oid FROM pg_catalog.pg_roles WHERE rolname = current_user)
                       AND am.admin_option AND NOT am.inherit_option AND NOT am.set_option))
    ) THEN
      RAISE EXCEPTION 'migration 104: role % has unsafe memberships', spec.role_name;
    END IF;

    IF NOT EXISTS (
      SELECT 1 FROM pg_catalog.pg_auth_members am
       WHERE am.roleid = helper.oid
         AND am.member = (SELECT oid FROM pg_catalog.pg_roles WHERE rolname = current_user)
         AND am.admin_option
    ) THEN
      EXECUTE format('GRANT %I TO %I WITH ADMIN TRUE, INHERIT FALSE, SET FALSE', spec.role_name, current_user);
    END IF;
  END LOOP;
END;
$$;

-- ALTER FUNCTION ... OWNER TO needs the new owner to hold CREATE on the
-- function's schema; 105 transfers each capability function to its owner.
GRANT CREATE ON SCHEMA jale_cap TO
  jale_cap_upload_tokens, jale_cap_worker_lane, jale_cap_share_links, jale_cap_ses_feedback,
  jale_cap_retention, jale_cap_stale_outbox, jale_cap_hired_counts, jale_cap_job_messaging;

-- ── 5a. Pin the definers that lack pg_temp ──────────────────
DO $$
DECLARE
  fn TEXT;
  target REGPROCEDURE;
  info RECORD;
BEGIN
  FOREACH fn IN ARRAY ARRAY[
    'public.assign_worker_thread_number(uuid)',
    'public.enqueue_job_visibility_event(uuid, text, text)',
    'public.list_jobs_missing_geo()',
    'public.list_stale_job_outbox_workers(interval)',
    'public.public_job_company(uuid)',
    'public.public_referrer_context(text, text)',
    'public.set_job_geo(uuid, text, text)',
    'public.sync_job_hired_counts()'
  ] LOOP
    target := pg_catalog.to_regprocedure(fn);
    -- 105 re-owns two of these; a replay after it finds one moved to jale_cap
    -- or turned into an invoker wrapper, and leaves it as 105 left it.
    CONTINUE WHEN target IS NULL;
    SELECT p.prosecdef AS definer, pg_catalog.pg_get_userbyid(p.proowner) AS owner
      INTO info
      FROM pg_catalog.pg_proc p
     WHERE p.oid = target;
    CONTINUE WHEN NOT info.definer OR info.owner <> 'jale_admin';
    EXECUTE format('ALTER FUNCTION %s SET search_path = pg_catalog, public, pg_temp', target);
  END LOOP;
END;
$$;

-- ── 5b. The hired-count trigger function is not PUBLIC-executable ──
DO $$
BEGIN
  IF pg_catalog.to_regprocedure('public.sync_job_hired_counts()') IS NOT NULL THEN
    REVOKE EXECUTE ON FUNCTION public.sync_job_hired_counts() FROM PUBLIC;
  END IF;
END;
$$;

-- ── 5c. No SET membership in the geo backfill helper ────────
-- 067 and 086 granted it as the migration login (WITH SET TRUE). 082's
-- two-step removes exactly that row and keeps the creator's ADMIN-only row.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_catalog.pg_auth_members am
     WHERE am.roleid = (SELECT oid FROM pg_catalog.pg_roles WHERE rolname = 'jale_location_backfill')
       AND am.member = (SELECT oid FROM pg_catalog.pg_roles WHERE rolname = current_user)
       AND am.set_option
  ) THEN
    EXECUTE format('GRANT jale_location_backfill TO %I WITH SET FALSE, INHERIT FALSE', current_user);
    EXECUTE format('REVOKE jale_location_backfill FROM %I GRANTED BY %I', current_user, current_user);
  END IF;
END;
$$;

-- ── 5d. New functions start closed to PUBLIC ────────────────
ALTER DEFAULT PRIVILEGES FOR ROLE jale_admin REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;

-- ── 5e. No temporary tables for PUBLIC ──────────────────────
DO $$
BEGIN
  EXECUTE format('REVOKE TEMPORARY ON DATABASE %I FROM PUBLIC', current_database());
END;
$$;

-- ── Self-audit ──────────────────────────────────────────────
DO $$
DECLARE
  spec RECORD;
  r pg_catalog.pg_roles%ROWTYPE;
  offender TEXT;
BEGIN
  FOR spec IN
    SELECT * FROM (VALUES
      ('jale_api', -1, true, ARRAY['idle_in_transaction_session_timeout=60s']),
      ('jale_api_public', -1, true, ARRAY['idle_in_transaction_session_timeout=60s']),
      ('jale_job_email_sender', 5, true, ARRAY['idle_in_transaction_session_timeout=60s']),
      ('jale_job_visibility_drain', 5, true, ARRAY['idle_in_transaction_session_timeout=60s']),
      ('jale_job_digest', 5, true, ARRAY['idle_in_transaction_session_timeout=60s']),
      ('jale_job_ses_feedback', 5, true, ARRAY['idle_in_transaction_session_timeout=60s']),
      ('jale_job_retention', 5, true, ARRAY['idle_in_transaction_session_timeout=60s']),
      ('jale_posture', 2, false, ARRAY[]::text[])
    ) AS t(login, connection_limit, public_usage, settings)
  LOOP
    SELECT * INTO r FROM pg_catalog.pg_roles WHERE rolname = spec.login;
    IF NOT FOUND OR NOT r.rolcanlogin OR r.rolsuper OR r.rolcreatedb OR r.rolcreaterole
       OR r.rolreplication OR r.rolbypassrls OR r.rolinherit OR r.rolconnlimit <> spec.connection_limit THEN
      RAISE EXCEPTION 'migration 104: existing login % has unexpected attributes; refusing to adopt it', spec.login;
    END IF;
    IF EXISTS (SELECT 1 FROM pg_catalog.pg_auth_members am WHERE am.member = r.oid) THEN
      RAISE EXCEPTION 'migration 104: login % must not be a member of any role', spec.login;
    END IF;
    IF EXISTS (
      SELECT 1 FROM pg_catalog.pg_auth_members am
       WHERE am.roleid = r.oid AND (am.set_option OR am.inherit_option)
    ) THEN
      RAISE EXCEPTION 'migration 104: role % has unsafe memberships', spec.login;
    END IF;
    IF EXISTS (
      SELECT 1 FROM pg_catalog.pg_shdepend d
       WHERE d.refclassid = 'pg_catalog.pg_authid'::regclass AND d.refobjid = r.oid AND d.deptype = 'o'
    ) THEN
      RAISE EXCEPTION 'migration 104: login % owns objects', spec.login;
    END IF;
    IF NOT pg_catalog.has_database_privilege(r.oid, current_database(), 'CONNECT') THEN
      RAISE EXCEPTION 'migration 104: login % lacks CONNECT', spec.login;
    END IF;
    IF pg_catalog.has_database_privilege(r.oid, current_database(), 'TEMPORARY') THEN
      RAISE EXCEPTION 'migration 104: login % holds TEMPORARY on the database', spec.login;
    END IF;
    IF spec.public_usage AND NOT pg_catalog.has_schema_privilege(r.oid, 'public', 'USAGE') THEN
      RAISE EXCEPTION 'migration 104: login % lacks USAGE on public', spec.login;
    END IF;
    IF COALESCE((SELECT array_agg(cfg ORDER BY cfg)
                   FROM pg_catalog.pg_db_role_setting s, unnest(s.setconfig) cfg
                  WHERE s.setrole = r.oid AND s.setdatabase = 0), ARRAY[]::text[]) <> spec.settings
       OR EXISTS (SELECT 1 FROM pg_catalog.pg_db_role_setting s WHERE s.setrole = r.oid AND s.setdatabase <> 0) THEN
      RAISE EXCEPTION 'migration 104: login % does not carry its role settings', spec.login;
    END IF;
  END LOOP;

  FOR spec IN
    SELECT * FROM (VALUES
      ('jale_cap_upload_tokens'), ('jale_cap_worker_lane'), ('jale_cap_share_links'),
      ('jale_cap_ses_feedback'), ('jale_cap_retention'), ('jale_cap_stale_outbox'),
      ('jale_cap_hired_counts'), ('jale_cap_job_messaging'), ('jale_ops_readonly')
    ) AS t(role_name)
  LOOP
    SELECT * INTO r FROM pg_catalog.pg_roles WHERE rolname = spec.role_name;
    IF NOT FOUND OR r.rolcanlogin OR r.rolsuper OR r.rolcreatedb OR r.rolcreaterole
       OR r.rolinherit OR r.rolreplication OR r.rolbypassrls THEN
      RAISE EXCEPTION 'migration 104: existing role % has unsafe attributes', spec.role_name;
    END IF;
    IF EXISTS (SELECT 1 FROM pg_catalog.pg_auth_members am WHERE am.member = r.oid)
       OR (spec.role_name LIKE 'jale\_cap\_%' AND EXISTS (
             SELECT 1 FROM pg_catalog.pg_auth_members am
              WHERE am.roleid = r.oid AND (am.set_option OR am.inherit_option))) THEN
      RAISE EXCEPTION 'migration 104: role % has unsafe memberships', spec.role_name;
    END IF;
    IF spec.role_name LIKE 'jale\_cap\_%'
       AND (NOT pg_catalog.has_schema_privilege(r.oid, 'jale_cap', 'CREATE')
            OR pg_catalog.has_schema_privilege(r.oid, 'public', 'CREATE')) THEN
      RAISE EXCEPTION 'migration 104: capability owner % must hold CREATE on jale_cap and not on public', spec.role_name;
    END IF;
  END LOOP;

  IF (SELECT pg_catalog.pg_get_userbyid(n.nspowner) FROM pg_catalog.pg_namespace n WHERE n.nspname = 'jale_cap')
       IS DISTINCT FROM 'jale_admin'
     OR EXISTS (
       SELECT 1 FROM pg_catalog.pg_namespace n, aclexplode(COALESCE(n.nspacl, acldefault('n', n.nspowner))) a
        WHERE n.nspname = 'jale_cap' AND a.grantee = 0
     ) THEN
    RAISE EXCEPTION 'migration 104: jale_cap must be owned by jale_admin and closed to PUBLIC';
  END IF;

  SELECT string_agg(p.oid::regprocedure::text, ', ' ORDER BY p.oid::regprocedure::text) INTO offender
    FROM pg_catalog.pg_proc p
    JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
   WHERE p.prosecdef
     AND n.nspname NOT IN ('pg_catalog', 'information_schema')
     AND n.nspname NOT LIKE 'pg\_%'
     AND NOT EXISTS (
       SELECT 1 FROM unnest(COALESCE(p.proconfig, '{}'::text[])) cfg
        WHERE cfg LIKE 'search\_path=%' AND btrim(split_part(cfg, ',', -1)) = 'pg_temp'
     );
  IF offender IS NOT NULL THEN
    RAISE EXCEPTION 'migration 104: definer % still lacks a search_path ending in pg_temp', offender;
  END IF;

  IF pg_catalog.to_regprocedure('public.sync_job_hired_counts()') IS NOT NULL
     AND EXISTS (
       SELECT 1 FROM pg_catalog.pg_proc p, aclexplode(COALESCE(p.proacl, acldefault('f', p.proowner))) a
        WHERE p.oid = pg_catalog.to_regprocedure('public.sync_job_hired_counts()')
          AND a.grantee = 0 AND a.privilege_type = 'EXECUTE'
     ) THEN
    RAISE EXCEPTION 'migration 104: sync_job_hired_counts() is still executable by PUBLIC';
  END IF;

  IF EXISTS (
    SELECT 1 FROM pg_catalog.pg_database d, aclexplode(COALESCE(d.datacl, acldefault('d', d.datdba))) a
     WHERE d.datname = current_database() AND a.grantee = 0 AND a.privilege_type = 'TEMPORARY'
  ) THEN
    RAISE EXCEPTION 'migration 104: PUBLIC still holds TEMPORARY on the database';
  END IF;

  IF pg_catalog.pg_has_role(current_user, 'jale_location_backfill', 'SET') THEN
    RAISE EXCEPTION 'migration 104: jale_admin still holds a SET membership in jale_location_backfill';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_default_acl d
     WHERE d.defaclrole = (SELECT oid FROM pg_catalog.pg_roles WHERE rolname = 'jale_admin')
       AND d.defaclnamespace = 0
       AND d.defaclobjtype = 'f'
       AND NOT EXISTS (
         SELECT 1 FROM aclexplode(d.defaclacl) a WHERE a.grantee = 0 AND a.privilege_type = 'EXECUTE'
       )
  ) THEN
    RAISE EXCEPTION 'migration 104: new functions would still be executable by PUBLIC';
  END IF;
END;
$$;

COMMIT;
