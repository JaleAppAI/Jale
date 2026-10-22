-- ============================================================
-- 127_user_tutorial_progress.sql
-- Run manually AFTER 126_job_conversations_whatsapp_update_columns.sql,
-- connected as jale_admin. Forward-only (ADR-005). ONE transaction.
--
-- Tutorial progress (sprint 29, contract K1): which first-time tutorials an
-- account has finished or skipped, so a tutorial opens on its own at most
-- once per account, on every device and browser.
--
--   * public.user_tutorial_progress holds one row per account and
--     tutorial, keyed (user_id, tutorial_id). user_id is users.id: the
--     post-confirmation trigger creates the users row for both pools before
--     any page loads, so a worker on the first onboarding screen already has
--     one (and no worker_profiles row yet).
--   * tutorial_id is checked for its shape only (a role prefix, then snake
--     case). The API (lambda/api/tutorial-progress.ts) accepts the exact
--     ids, so a later tutorial needs no migration.
--   * outcome is 'completed' or 'skipped'. The first outcome recorded is
--     kept: the API inserts with ON CONFLICT DO NOTHING, then reads the row
--     back.
--   * The request login (jale_api) reads and inserts the caller's own rows,
--     keyed exactly like 118's organization_members_self_read. It holds no
--     UPDATE or DELETE right: a row leaves only with its users row
--     (ON DELETE CASCADE). The WhatsApp sign-in reconcile deletes only the
--     phone-keyed placeholder users row, which never signs in on the web and
--     so owns no progress rows.
--   * Access manifest: manifest.d/user_tutorial_progress.json. Change log:
--     an excluded table (UI progress flags; no personal data beyond the
--     account link).
--
-- DEPLOY ORDER: apply this migration BEFORE deploying the code. The new
-- routes read and write the table; until it exists they answer 500, which
-- the web client reads as "do not open a tutorial on its own".
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
    RAISE EXCEPTION 'migration 127: connect as jale_admin (this session runs as %)', current_user;
  END IF;
  IF pg_catalog.to_regclass('public.users') IS NULL THEN
    RAISE EXCEPTION 'migration 127: public.users is missing';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'jale_api') THEN
    RAISE EXCEPTION 'migration 127: role jale_api is missing';
  END IF;
  IF pg_catalog.to_regclass('public.user_tutorial_progress') IS NOT NULL THEN
    RAISE EXCEPTION 'migration 127: already applied (public.user_tutorial_progress exists); it is not re-runnable';
  END IF;
  -- The closing check compares both policies with this one.
  IF pg_catalog.to_regclass('public.organization_members') IS NULL
     OR NOT EXISTS (
       SELECT 1 FROM pg_catalog.pg_policy p
        WHERE p.polrelid = 'public.organization_members'::regclass
          AND p.polname = 'organization_members_self_read'
     ) THEN
    RAISE EXCEPTION 'migration 127: policy organization_members_self_read (118) is missing';
  END IF;
END;
$$;

-- ── 2. The table ────────────────────────────────────────────
CREATE TABLE public.user_tutorial_progress (
  user_id     UUID        NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  tutorial_id TEXT        NOT NULL CHECK (tutorial_id ~ '^(employer|worker)_[a-z_]{1,40}$'),
  outcome     TEXT        NOT NULL CHECK (outcome IN ('completed', 'skipped')),
  recorded_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, tutorial_id)
);
ALTER TABLE public.user_tutorial_progress ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.user_tutorial_progress FORCE ROW LEVEL SECURITY;

-- ── 3. The request login: the caller's own rows ─────────────
GRANT SELECT, INSERT ON public.user_tutorial_progress TO jale_api;

-- Self-read and self-insert, keyed exactly like 118's
-- organization_members_self_read.
CREATE POLICY user_tutorial_progress_self_read ON public.user_tutorial_progress
  AS PERMISSIVE FOR SELECT TO jale_api
  USING (user_id = (SELECT users.id FROM public.users
                     WHERE users.cognito_sub = current_setting('app.current_user_id', true)));

CREATE POLICY user_tutorial_progress_self_insert ON public.user_tutorial_progress
  AS PERMISSIVE FOR INSERT TO jale_api
  WITH CHECK (user_id = (SELECT users.id FROM public.users
                          WHERE users.cognito_sub = current_setting('app.current_user_id', true)));

-- ── 4. Closing check ────────────────────────────────────────
DO $$
DECLARE
  v_rel CONSTANT REGCLASS := 'public.user_tutorial_progress'::regclass;
  v_self TEXT;
  v_offender TEXT;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_class c
     WHERE c.oid = v_rel AND c.relrowsecurity AND c.relforcerowsecurity
  ) THEN
    RAISE EXCEPTION 'migration 127: user_tutorial_progress must have row security enabled and forced';
  END IF;

  -- The request login reads and inserts; no role but the owner holds any
  -- other right, on the table or on a column.
  IF NOT pg_catalog.has_table_privilege('jale_api', v_rel, 'SELECT')
     OR NOT pg_catalog.has_table_privilege('jale_api', v_rel, 'INSERT') THEN
    RAISE EXCEPTION 'migration 127: jale_api cannot read and insert user_tutorial_progress';
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
     AND NOT (a.grantee = 'jale_api'::regrole::oid AND a.privilege_type IN ('SELECT', 'INSERT'));
  IF v_offender IS NOT NULL THEN
    RAISE EXCEPTION 'migration 127: an unexpected privilege on user_tutorial_progress: %', v_offender;
  END IF;

  -- Exactly the two policies, for jale_api only, each the caller's own row:
  -- the predicate deparses to the same text as 118's self-read.
  IF (SELECT pg_catalog.array_agg(p.polname::TEXT ORDER BY p.polname)
        FROM pg_catalog.pg_policy p WHERE p.polrelid = v_rel)
     IS DISTINCT FROM ARRAY['user_tutorial_progress_self_insert', 'user_tutorial_progress_self_read']::TEXT[] THEN
    RAISE EXCEPTION 'migration 127: user_tutorial_progress policy set drifted';
  END IF;
  SELECT pg_catalog.pg_get_expr(p.polqual, p.polrelid) INTO v_self
    FROM pg_catalog.pg_policy p
   WHERE p.polrelid = 'public.organization_members'::regclass AND p.polname = 'organization_members_self_read';
  IF NOT EXISTS (
       SELECT 1 FROM pg_catalog.pg_policy p
        WHERE p.polrelid = v_rel
          AND p.polname = 'user_tutorial_progress_self_read'
          AND p.polcmd = 'r'
          AND p.polpermissive
          AND p.polroles = ARRAY['jale_api'::regrole::oid]
          AND pg_catalog.pg_get_expr(p.polqual, p.polrelid) = v_self
          AND p.polwithcheck IS NULL)
     OR NOT EXISTS (
       SELECT 1 FROM pg_catalog.pg_policy p
        WHERE p.polrelid = v_rel
          AND p.polname = 'user_tutorial_progress_self_insert'
          AND p.polcmd = 'a'
          AND p.polpermissive
          AND p.polroles = ARRAY['jale_api'::regrole::oid]
          AND p.polqual IS NULL
          AND pg_catalog.pg_get_expr(p.polwithcheck, p.polrelid) = v_self) THEN
    RAISE EXCEPTION 'migration 127: a user_tutorial_progress policy is not the caller''s own row for jale_api';
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
    RAISE EXCEPTION 'migration 127: user_tutorial_progress.user_id must reference users(id) ON DELETE CASCADE';
  END IF;
END;
$$;

COMMIT;
