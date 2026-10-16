-- ============================================================
-- 120_admin_access.sql
-- Run manually AFTER 117_admin_queues.sql,
-- connected as jale_admin. Forward-only (ADR-005).
--
-- Sprint 28 admin access (contract K1), in two parts:
-- (1) admin_trusted_devices: one row per browser an admin chose to trust
--     for seven days ("Trust this browser for 7 days"). It holds the sha256
--     of the sign-in service's device key, never the key itself. A row is
--     live while ended_at is NULL; an admin has at most one live row per
--     device. expires_at is always trusted_at + 7 days, and an ended row
--     carries its reason:
--       expired                the trust is over, found at sign-in: the
--                              7-day window passed, or the sign-in service
--                              does not remember the browser
--       admin_deactivated      the admin's account was deactivated
--       signed_out_everywhere  every session of the admin was revoked
--                              ("sign out everywhere")
--     The admin console login reads every row, records a new trust (the
--     database stamps trusted_at) and ends a live row with a reason, each
--     through its own policy and column grants. It never deletes, reopens
--     or re-dates a row.
-- (2) Three definers for the Admins page. Each is owned by jale_admin, has a
--     pinned search path, is closed to PUBLIC and is executable by
--     jale_admin_console only:
--       admin_user_invite_record(p_actor, p_email, p_role, p_cognito_sub)
--         records an invited admin (email trimmed and lower-cased).
--       admin_user_set_role(p_actor, p_target, p_role)
--       admin_user_set_active(p_actor, p_target, p_active)
--         deactivation also ends the target's live trusted browsers
--         (end_reason admin_deactivated); the console revokes the target's
--         sessions in the same transaction.
--     Each returns the admin's row, and decides only after it has locked
--     (FOR UPDATE, in id order) every active superadmin row, the actor's
--     and the target's, so two concurrent changes run one after the other
--     and the second sees the first. The guards, raised with the message
--     below as the whole text (the console maps each one):
--       admin_invalid_input    22023  an argument is missing or out of range
--       admin_self_change      55000  p_actor = p_target
--       admin_not_found        P0002  no admin with the target id
--       admin_last_superadmin  55000  the change would leave no active superadmin
--       admin_forbidden        42501  the actor is not an active superadmin
--       admin_already_exists   23505  the email or sign-in id has an account
--     A role change or a deactivation of oneself is refused before any lock;
--     the superadmin count is read after the locks are held.
--
-- admin_users writes leave change records (migration 111); the console sets
-- its audit context in the same transaction before it calls a definer.
--
-- DEPLOY ORDER: apply BEFORE deploying the admin console build that reads
-- admin_trusted_devices and calls these functions.
-- ============================================================
BEGIN;

-- Fail fast instead of queueing admin_users reads behind a stuck
-- transaction; a timed-out apply writes no ledger row and can be rerun.
SET LOCAL lock_timeout = '5s';

-- ── Trusted browsers ─────────────────────────────────────────
CREATE TABLE public.admin_trusted_devices (
  id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  admin_user_id   UUID        NOT NULL REFERENCES public.admin_users(id) ON DELETE CASCADE,
  device_key_hash CHAR(64)    NOT NULL CHECK (device_key_hash ~ '^[0-9a-f]{64}$'),
  trusted_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at      TIMESTAMPTZ NOT NULL,
  ended_at        TIMESTAMPTZ,
  end_reason      TEXT        CHECK (end_reason IN ('expired', 'admin_deactivated', 'signed_out_everywhere')),
  CONSTRAINT admin_trusted_devices_seven_days CHECK (expires_at = trusted_at + interval '7 days'),
  CONSTRAINT admin_trusted_devices_ending CHECK ((ended_at IS NULL) = (end_reason IS NULL))
);

CREATE UNIQUE INDEX admin_trusted_devices_live_key
  ON public.admin_trusted_devices (admin_user_id, device_key_hash)
  WHERE ended_at IS NULL;

ALTER TABLE public.admin_trusted_devices ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.admin_trusted_devices FORCE ROW LEVEL SECURITY;

-- The owner's definers end rows on deactivation.
CREATE POLICY admin_trusted_devices_service_all ON public.admin_trusted_devices
  FOR ALL TO jale_admin USING (true) WITH CHECK (true);
-- The console: sign-in reads a device's trust, the Admins page counts them.
CREATE POLICY admin_trusted_devices_console_read ON public.admin_trusted_devices
  FOR SELECT TO jale_admin_console USING (true);
-- A new trust is always live.
CREATE POLICY admin_trusted_devices_console_insert ON public.admin_trusted_devices
  FOR INSERT TO jale_admin_console WITH CHECK (ended_at IS NULL AND end_reason IS NULL);
-- Only a live row may change, and only by ending.
CREATE POLICY admin_trusted_devices_console_end ON public.admin_trusted_devices
  FOR UPDATE TO jale_admin_console USING (ended_at IS NULL) WITH CHECK (ended_at IS NOT NULL);

GRANT SELECT ON public.admin_trusted_devices TO jale_admin_console;
GRANT INSERT (admin_user_id, device_key_hash, expires_at) ON public.admin_trusted_devices TO jale_admin_console;
GRANT UPDATE (ended_at, end_reason) ON public.admin_trusted_devices TO jale_admin_console;

-- ── Admins definers ──────────────────────────────────────────
CREATE FUNCTION public.admin_user_invite_record(
  p_actor UUID, p_email TEXT, p_role TEXT, p_cognito_sub TEXT
)
RETURNS TABLE (admin_user_id UUID, email TEXT, role TEXT, active BOOLEAN, created_at TIMESTAMPTZ)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
#variable_conflict use_column
DECLARE
  v_email TEXT := lower(btrim(p_email));
  v_sub   TEXT := btrim(p_cognito_sub);
  v_id    UUID;
BEGIN
  IF v_email IS NULL OR char_length(v_email) > 320
     OR v_email !~ '^[^@[:space:]]+@[^@[:space:]]+[.][^@[:space:]]+$'
     OR p_role IS NULL OR p_role NOT IN ('admin_readonly', 'admin_ops', 'admin_superadmin')
     OR v_sub IS NULL OR v_sub = '' OR char_length(v_sub) > 128 THEN
    RAISE EXCEPTION 'admin_invalid_input' USING ERRCODE = '22023';
  END IF;

  PERFORM 1 FROM public.admin_users u
   WHERE (u.active AND u.role = 'admin_superadmin') OR u.id = p_actor
   ORDER BY u.id
     FOR UPDATE;

  IF NOT EXISTS (
    SELECT 1 FROM public.admin_users u
     WHERE u.id = p_actor AND u.active AND u.role = 'admin_superadmin'
  ) THEN
    RAISE EXCEPTION 'admin_forbidden' USING ERRCODE = '42501';
  END IF;

  IF EXISTS (
    SELECT 1 FROM public.admin_users u
     WHERE lower(u.admin_email) = v_email OR u.cognito_sub = v_sub
  ) THEN
    RAISE EXCEPTION 'admin_already_exists' USING ERRCODE = '23505';
  END IF;

  INSERT INTO public.admin_users (cognito_sub, admin_email, role, active)
  VALUES (v_sub, v_email, p_role, true)
  ON CONFLICT DO NOTHING
  RETURNING id INTO v_id;

  IF v_id IS NULL THEN
    RAISE EXCEPTION 'admin_already_exists' USING ERRCODE = '23505';
  END IF;

  RETURN QUERY
    SELECT u.id, u.admin_email, u.role, u.active, u.created_at
      FROM public.admin_users u
     WHERE u.id = v_id;
END $$;

CREATE FUNCTION public.admin_user_set_role(p_actor UUID, p_target UUID, p_role TEXT)
RETURNS TABLE (admin_user_id UUID, email TEXT, role TEXT, active BOOLEAN, created_at TIMESTAMPTZ)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
#variable_conflict use_column
DECLARE
  v_target_role   TEXT;
  v_target_active BOOLEAN;
BEGIN
  IF p_actor IS NULL OR p_target IS NULL
     OR p_role IS NULL OR p_role NOT IN ('admin_readonly', 'admin_ops', 'admin_superadmin') THEN
    RAISE EXCEPTION 'admin_invalid_input' USING ERRCODE = '22023';
  END IF;
  IF p_actor = p_target THEN
    RAISE EXCEPTION 'admin_self_change' USING ERRCODE = '55000';
  END IF;

  PERFORM 1 FROM public.admin_users u
   WHERE (u.active AND u.role = 'admin_superadmin') OR u.id = p_actor OR u.id = p_target
   ORDER BY u.id
     FOR UPDATE;

  SELECT u.role, u.active INTO v_target_role, v_target_active
    FROM public.admin_users u
   WHERE u.id = p_target;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'admin_not_found' USING ERRCODE = 'P0002';
  END IF;

  IF v_target_active AND v_target_role = 'admin_superadmin' AND p_role <> 'admin_superadmin'
     AND NOT EXISTS (
       SELECT 1 FROM public.admin_users u
        WHERE u.active AND u.role = 'admin_superadmin' AND u.id <> p_target
     ) THEN
    RAISE EXCEPTION 'admin_last_superadmin' USING ERRCODE = '55000';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM public.admin_users u
     WHERE u.id = p_actor AND u.active AND u.role = 'admin_superadmin'
  ) THEN
    RAISE EXCEPTION 'admin_forbidden' USING ERRCODE = '42501';
  END IF;

  UPDATE public.admin_users u
     SET role = p_role, updated_at = now()
   WHERE u.id = p_target AND u.role IS DISTINCT FROM p_role;

  RETURN QUERY
    SELECT u.id, u.admin_email, u.role, u.active, u.created_at
      FROM public.admin_users u
     WHERE u.id = p_target;
END $$;

CREATE FUNCTION public.admin_user_set_active(p_actor UUID, p_target UUID, p_active BOOLEAN)
RETURNS TABLE (admin_user_id UUID, email TEXT, role TEXT, active BOOLEAN, created_at TIMESTAMPTZ)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
#variable_conflict use_column
DECLARE
  v_target_role   TEXT;
  v_target_active BOOLEAN;
BEGIN
  IF p_actor IS NULL OR p_target IS NULL OR p_active IS NULL THEN
    RAISE EXCEPTION 'admin_invalid_input' USING ERRCODE = '22023';
  END IF;
  IF p_actor = p_target THEN
    RAISE EXCEPTION 'admin_self_change' USING ERRCODE = '55000';
  END IF;

  PERFORM 1 FROM public.admin_users u
   WHERE (u.active AND u.role = 'admin_superadmin') OR u.id = p_actor OR u.id = p_target
   ORDER BY u.id
     FOR UPDATE;

  SELECT u.role, u.active INTO v_target_role, v_target_active
    FROM public.admin_users u
   WHERE u.id = p_target;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'admin_not_found' USING ERRCODE = 'P0002';
  END IF;

  IF NOT p_active AND v_target_active AND v_target_role = 'admin_superadmin'
     AND NOT EXISTS (
       SELECT 1 FROM public.admin_users u
        WHERE u.active AND u.role = 'admin_superadmin' AND u.id <> p_target
     ) THEN
    RAISE EXCEPTION 'admin_last_superadmin' USING ERRCODE = '55000';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM public.admin_users u
     WHERE u.id = p_actor AND u.active AND u.role = 'admin_superadmin'
  ) THEN
    RAISE EXCEPTION 'admin_forbidden' USING ERRCODE = '42501';
  END IF;

  UPDATE public.admin_users u
     SET active = p_active, updated_at = now()
   WHERE u.id = p_target AND u.active IS DISTINCT FROM p_active;

  IF NOT p_active THEN
    UPDATE public.admin_trusted_devices d
       SET ended_at = now(), end_reason = 'admin_deactivated'
     WHERE d.admin_user_id = p_target AND d.ended_at IS NULL;
  END IF;

  RETURN QUERY
    SELECT u.id, u.admin_email, u.role, u.active, u.created_at
      FROM public.admin_users u
     WHERE u.id = p_target;
END $$;

-- ── Ownership + ACL ─────────────────────────────────────────
ALTER FUNCTION public.admin_user_invite_record(UUID, TEXT, TEXT, TEXT) OWNER TO jale_admin;
ALTER FUNCTION public.admin_user_set_role(UUID, UUID, TEXT) OWNER TO jale_admin;
ALTER FUNCTION public.admin_user_set_active(UUID, UUID, BOOLEAN) OWNER TO jale_admin;

REVOKE ALL ON FUNCTION public.admin_user_invite_record(UUID, TEXT, TEXT, TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.admin_user_set_role(UUID, UUID, TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.admin_user_set_active(UUID, UUID, BOOLEAN) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION public.admin_user_invite_record(UUID, TEXT, TEXT, TEXT) TO jale_admin_console;
GRANT EXECUTE ON FUNCTION public.admin_user_set_role(UUID, UUID, TEXT) TO jale_admin_console;
GRANT EXECUTE ON FUNCTION public.admin_user_set_active(UUID, UUID, BOOLEAN) TO jale_admin_console;

-- Fail closed if the table, its row security, a policy or a function
-- drifted from the reviewed model, or if a guard does not raise.
DO $$
DECLARE
  fn       RECORD;
  pol      RECORD;
  fn_oid   OID;
  v_result CONSTANT TEXT := 'TABLE(admin_user_id uuid, email text, role text, active boolean, created_at timestamp with time zone)';
  v_raised TEXT;
BEGIN
  -- Names in the catalog checks print schema-qualified whatever the
  -- applying role's search_path.
  SET LOCAL search_path = pg_catalog, pg_temp;

  IF NOT EXISTS (
    SELECT 1 FROM pg_class c
     WHERE c.oid = 'public.admin_trusted_devices'::regclass
       AND c.relrowsecurity AND c.relforcerowsecurity
       AND c.relowner = 'jale_admin'::regrole::oid
  ) THEN
    RAISE EXCEPTION 'migration 120: admin_trusted_devices row security or owner drifted';
  END IF;

  FOR pol IN
    SELECT * FROM (VALUES
      ('admin_trusted_devices_service_all', '*', 'jale_admin', 'true', 'true'),
      ('admin_trusted_devices_console_read', 'r', 'jale_admin_console', 'true', NULL),
      ('admin_trusted_devices_console_insert', 'a', 'jale_admin_console', NULL, '((ended_at IS NULL) AND (end_reason IS NULL))'),
      ('admin_trusted_devices_console_end', 'w', 'jale_admin_console', '(ended_at IS NULL)', '(ended_at IS NOT NULL)')
    ) AS expected(name, cmd, role, qual, check_expr)
  LOOP
    IF NOT EXISTS (
      SELECT 1 FROM pg_policy p
       WHERE p.polrelid = 'public.admin_trusted_devices'::regclass
         AND p.polname = pol.name
         AND p.polcmd = pol.cmd::"char"
         AND p.polpermissive
         AND p.polroles = ARRAY[pol.role::regrole::oid]
         AND pg_get_expr(p.polqual, p.polrelid) IS NOT DISTINCT FROM pol.qual
         AND pg_get_expr(p.polwithcheck, p.polrelid) IS NOT DISTINCT FROM pol.check_expr
    ) THEN
      RAISE EXCEPTION 'migration 120: policy % missing or drifted', pol.name;
    END IF;
  END LOOP;
  IF (SELECT count(*) FROM pg_policy p WHERE p.polrelid = 'public.admin_trusted_devices'::regclass) <> 4 THEN
    RAISE EXCEPTION 'migration 120: admin_trusted_devices carries a policy beyond the four reviewed ones';
  END IF;

  FOR fn IN
    SELECT * FROM (VALUES
      ('public.admin_user_invite_record(uuid,text,text,text)'),
      ('public.admin_user_set_role(uuid,uuid,text)'),
      ('public.admin_user_set_active(uuid,uuid,boolean)')
    ) AS expected(sig)
  LOOP
    fn_oid := to_regprocedure(fn.sig)::OID;
    IF fn_oid IS NULL THEN
      RAISE EXCEPTION 'migration 120: % missing', fn.sig;
    END IF;
    IF pg_get_function_result(fn_oid) IS DISTINCT FROM v_result THEN
      RAISE EXCEPTION 'migration 120: % result drifted', fn.sig;
    END IF;
    IF NOT EXISTS (
      SELECT 1 FROM pg_proc p
       WHERE p.oid = fn_oid
         AND p.proowner = 'jale_admin'::regrole::oid
         AND p.prosecdef
         -- A NULL proconfig (no pinned search_path) must fail, not skip.
         AND COALESCE(p.proconfig @> ARRAY['search_path=pg_catalog, pg_temp'], false)
    ) THEN
      RAISE EXCEPTION 'migration 120: % owner/secdef/search_path wrong', fn.sig;
    END IF;
    -- Exactly the owner and the console may execute; PUBLIC is grantee 0.
    IF EXISTS (
      SELECT 1 FROM pg_proc p, aclexplode(COALESCE(p.proacl, acldefault('f', p.proowner))) a
       WHERE p.oid = fn_oid AND a.privilege_type = 'EXECUTE'
         AND a.grantee <> p.proowner
         AND a.grantee <> 'jale_admin_console'::regrole::oid
    ) OR NOT has_function_privilege('jale_admin_console', fn_oid, 'EXECUTE') THEN
      RAISE EXCEPTION 'migration 120: % executable by a role other than its owner and the console', fn.sig;
    END IF;
  END LOOP;

  -- The self guard raises before any lock or read.
  v_raised := NULL;
  BEGIN
    PERFORM * FROM public.admin_user_set_active(
      '00000000-0000-4000-8000-000000000118'::uuid, '00000000-0000-4000-8000-000000000118'::uuid, false);
  EXCEPTION WHEN object_not_in_prerequisite_state THEN
    v_raised := SQLERRM;
  END;
  IF v_raised IS DISTINCT FROM 'admin_self_change' THEN
    RAISE EXCEPTION 'migration 120: admin_user_set_active did not refuse a change to oneself';
  END IF;
END $$;

COMMIT;
