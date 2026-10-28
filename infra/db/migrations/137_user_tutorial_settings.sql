-- ============================================================
-- 137_user_tutorial_settings.sql
-- Run manually AFTER 136_retire_per_person_billing.sql,
-- connected as jale_admin. Forward-only (ADR-005). ONE transaction.
--
-- Guide settings (hotfix 2026-10-23, contract K1-v2): how first-time guides
-- behave for an account, kept on the server so the choice follows the person
-- across devices and browsers, like the tutorial progress of 130.
--
--   * public.user_tutorial_settings holds one row per account, keyed
--     user_id (users.id). An account with no row reads as the defaults:
--     always_show false, muted empty.
--   * always_show: guides open every time their task starts, not only the
--     first time.
--   * muted: the tutorials turned off with "Don't show this again". The
--     CHECK user_tutorial_settings_muted_valid holds the list to
--       - at most 16 elements, in one dimension (an empty array has none, so
--         its array_ndims is NULL, as in 131);
--       - no NULL element: array_to_string renders a NULL as '*', which the
--         id pattern never matches;
--       - every element of 130's tutorial_id shape (a role prefix, then
--         snake case): the elements joined with ',' must match the shape
--         repeated with ',' between, and splitting that string on ',' must
--         give back as many parts as the array has elements, so an element
--         that holds a ',' or is empty is refused too.
--     The API (lambda/api/tutorial-progress.ts) accepts the exact ids, the
--     role's tutorial ids only, so the ids stay out of the database and a
--     later tutorial needs no migration.
--   * updated_at is set by the API's upsert (now()); there is no trigger.
--   * The request login (jale_api) reads, inserts and updates the caller's
--     own row, keyed exactly like 130's policies (118's
--     organization_members_self_read). It holds no DELETE right: a row
--     leaves only with its users row (ON DELETE CASCADE).
--   * Access manifest: manifest.d/user_tutorial_settings.json. Change log:
--     an excluded table (UI guide settings; no personal data beyond the
--     account link).
--
-- DEPLOY ORDER: apply this migration BEFORE deploying the code. GET and
-- PATCH read and write the table; until it exists they answer 500, which the
-- web client reads as the defaults, so no guide opens on its own.
--
-- REPLAY. Refused with a clear message once the table exists. Nothing is
-- partially applied, because the file is one transaction.
-- ============================================================
BEGIN;

-- The foreign key locks public.users while the table is created; never queue
-- behind a stuck transaction.
SET LOCAL lock_timeout = '5s';

-- ── 1. Preconditions ────────────────────────────────────────
DO $$
BEGIN
  IF current_user <> 'jale_admin' THEN
    RAISE EXCEPTION 'migration 137: connect as jale_admin (this session runs as %)', current_user;
  END IF;
  IF pg_catalog.to_regclass('public.users') IS NULL THEN
    RAISE EXCEPTION 'migration 137: public.users is missing';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'jale_api') THEN
    RAISE EXCEPTION 'migration 137: role jale_api is missing';
  END IF;
  IF pg_catalog.to_regclass('public.user_tutorial_settings') IS NOT NULL THEN
    RAISE EXCEPTION 'migration 137: already applied (public.user_tutorial_settings exists); it is not re-runnable';
  END IF;
  -- The closing check compares every policy with this one.
  IF pg_catalog.to_regclass('public.organization_members') IS NULL
     OR NOT EXISTS (
       SELECT 1 FROM pg_catalog.pg_policy p
        WHERE p.polrelid = 'public.organization_members'::regclass
          AND p.polname = 'organization_members_self_read'
     ) THEN
    RAISE EXCEPTION 'migration 137: policy organization_members_self_read (118) is missing';
  END IF;
END;
$$;

-- ── 2. The table ────────────────────────────────────────────
CREATE TABLE public.user_tutorial_settings (
  user_id     UUID        PRIMARY KEY REFERENCES public.users(id) ON DELETE CASCADE,
  always_show BOOLEAN     NOT NULL DEFAULT false,
  muted       TEXT[]      NOT NULL DEFAULT '{}',
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT user_tutorial_settings_muted_valid CHECK (
    cardinality(muted) <= 16
    AND (array_ndims(muted) IS NULL OR array_ndims(muted) = 1)
    AND array_to_string(muted, ',', '*') ~ '^((employer|worker)_[a-z_]{1,40}(,(employer|worker)_[a-z_]{1,40})*)?$'
    AND cardinality(string_to_array(array_to_string(muted, ',', '*'), ',')) = cardinality(muted)
  )
);
ALTER TABLE public.user_tutorial_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.user_tutorial_settings FORCE ROW LEVEL SECURITY;

-- ── 3. The request login: the caller's own row ──────────────
GRANT SELECT, INSERT, UPDATE ON public.user_tutorial_settings TO jale_api;

-- Self-read, self-insert and self-update, keyed exactly like 130's policies
-- (118's organization_members_self_read).
CREATE POLICY user_tutorial_settings_self_read ON public.user_tutorial_settings
  AS PERMISSIVE FOR SELECT TO jale_api
  USING (user_id = (SELECT users.id FROM public.users
                     WHERE users.cognito_sub = current_setting('app.current_user_id', true)));

CREATE POLICY user_tutorial_settings_self_insert ON public.user_tutorial_settings
  AS PERMISSIVE FOR INSERT TO jale_api
  WITH CHECK (user_id = (SELECT users.id FROM public.users
                          WHERE users.cognito_sub = current_setting('app.current_user_id', true)));

CREATE POLICY user_tutorial_settings_self_update ON public.user_tutorial_settings
  AS PERMISSIVE FOR UPDATE TO jale_api
  USING (user_id = (SELECT users.id FROM public.users
                     WHERE users.cognito_sub = current_setting('app.current_user_id', true)))
  WITH CHECK (user_id = (SELECT users.id FROM public.users
                          WHERE users.cognito_sub = current_setting('app.current_user_id', true)));

-- ── 4. Closing check ────────────────────────────────────────
DO $$
DECLARE
  v_rel CONSTANT REGCLASS := 'public.user_tutorial_settings'::regclass;
  v_self TEXT;
  v_offender TEXT;
  v_check TEXT;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_class c
     WHERE c.oid = v_rel AND c.relrowsecurity AND c.relforcerowsecurity
  ) THEN
    RAISE EXCEPTION 'migration 137: user_tutorial_settings must have row security enabled and forced';
  END IF;

  -- The request login reads, inserts and updates; no role but the owner
  -- holds any other right, on the table or on a column.
  IF NOT pg_catalog.has_table_privilege('jale_api', v_rel, 'SELECT')
     OR NOT pg_catalog.has_table_privilege('jale_api', v_rel, 'INSERT')
     OR NOT pg_catalog.has_table_privilege('jale_api', v_rel, 'UPDATE') THEN
    RAISE EXCEPTION 'migration 137: jale_api cannot read, insert and update user_tutorial_settings';
  END IF;
  SELECT string_agg(DISTINCT
           CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE pg_catalog.pg_get_userbyid(a.grantee) END
           || ' ' || a.privilege_type, ', ')
    INTO v_offender
    FROM pg_catalog.pg_class c
    CROSS JOIN LATERAL (
      SELECT x.grantee, x.privilege_type
        FROM pg_catalog.aclexplode(COALESCE(c.relacl, pg_catalog.acldefault('r', c.relowner))) x
      UNION ALL
      SELECT y.grantee, y.privilege_type
        FROM pg_catalog.pg_attribute att, pg_catalog.aclexplode(att.attacl) y
       WHERE att.attrelid = c.oid AND att.attacl IS NOT NULL
    ) a
   WHERE c.oid = v_rel
     AND a.grantee <> c.relowner
     AND NOT (a.grantee = 'jale_api'::regrole::oid AND a.privilege_type IN ('SELECT', 'INSERT', 'UPDATE'));
  IF v_offender IS NOT NULL THEN
    RAISE EXCEPTION 'migration 137: an unexpected privilege on user_tutorial_settings: %', v_offender;
  END IF;

  -- Exactly the three policies, for jale_api only, each the caller's own
  -- row: the predicate deparses to the same text as 118's self-read, as
  -- 130's policies do.
  IF (SELECT pg_catalog.array_agg(p.polname::TEXT ORDER BY p.polname)
        FROM pg_catalog.pg_policy p WHERE p.polrelid = v_rel)
     IS DISTINCT FROM ARRAY['user_tutorial_settings_self_insert', 'user_tutorial_settings_self_read',
                            'user_tutorial_settings_self_update']::TEXT[] THEN
    RAISE EXCEPTION 'migration 137: user_tutorial_settings policy set drifted';
  END IF;
  SELECT pg_catalog.pg_get_expr(p.polqual, p.polrelid) INTO v_self
    FROM pg_catalog.pg_policy p
   WHERE p.polrelid = 'public.organization_members'::regclass AND p.polname = 'organization_members_self_read';
  IF NOT EXISTS (
       SELECT 1 FROM pg_catalog.pg_policy p
        WHERE p.polrelid = v_rel
          AND p.polname = 'user_tutorial_settings_self_read'
          AND p.polcmd = 'r'
          AND p.polpermissive
          AND p.polroles = ARRAY['jale_api'::regrole::oid]
          AND pg_catalog.pg_get_expr(p.polqual, p.polrelid) = v_self
          AND p.polwithcheck IS NULL)
     OR NOT EXISTS (
       SELECT 1 FROM pg_catalog.pg_policy p
        WHERE p.polrelid = v_rel
          AND p.polname = 'user_tutorial_settings_self_insert'
          AND p.polcmd = 'a'
          AND p.polpermissive
          AND p.polroles = ARRAY['jale_api'::regrole::oid]
          AND p.polqual IS NULL
          AND pg_catalog.pg_get_expr(p.polwithcheck, p.polrelid) = v_self)
     OR NOT EXISTS (
       SELECT 1 FROM pg_catalog.pg_policy p
        WHERE p.polrelid = v_rel
          AND p.polname = 'user_tutorial_settings_self_update'
          AND p.polcmd = 'w'
          AND p.polpermissive
          AND p.polroles = ARRAY['jale_api'::regrole::oid]
          AND pg_catalog.pg_get_expr(p.polqual, p.polrelid) = v_self
          AND pg_catalog.pg_get_expr(p.polwithcheck, p.polrelid) = v_self) THEN
    RAISE EXCEPTION 'migration 137: a user_tutorial_settings policy is not the caller''s own row for jale_api';
  END IF;

  -- The list CHECK, as written above.
  SELECT pg_catalog.pg_get_constraintdef(k.oid) INTO v_check
    FROM pg_catalog.pg_constraint k
   WHERE k.conrelid = v_rel
     AND k.conname = 'user_tutorial_settings_muted_valid'
     AND k.contype = 'c'
     AND k.convalidated;
  IF v_check IS DISTINCT FROM
     'CHECK (((cardinality(muted) <= 16) AND ((array_ndims(muted) IS NULL) OR (array_ndims(muted) = 1)) AND (array_to_string(muted, '',''::text, ''*''::text) ~ ''^((employer|worker)_[a-z_]{1,40}(,(employer|worker)_[a-z_]{1,40})*)?$''::text) AND (cardinality(string_to_array(array_to_string(muted, '',''::text, ''*''::text), '',''::text)) = cardinality(muted))))' THEN
    RAISE EXCEPTION 'migration 137: user_tutorial_settings_muted_valid is missing or reads %', COALESCE(v_check, '<absent>');
  END IF;

  -- A row leaves with its account.
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_constraint k
     WHERE k.conrelid = v_rel
       AND k.contype = 'f'
       AND k.confrelid = 'public.users'::regclass
       AND k.confdeltype = 'c'
       AND k.conkey = ARRAY[(SELECT att.attnum FROM pg_catalog.pg_attribute att
                              WHERE att.attrelid = v_rel AND att.attname = 'user_id')]
  ) THEN
    RAISE EXCEPTION 'migration 137: user_tutorial_settings.user_id must reference users(id) ON DELETE CASCADE';
  END IF;
END;
$$;

COMMIT;
