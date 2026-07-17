-- ============================================================
-- 041_whatsapp_web_worker_lookup_grant.sql
-- Allow the WhatsApp processor to identify workers who already
-- accepted the terms through the web application.
--
-- Keep this column-scoped: jale_whatsapp must not receive broad
-- SELECT access to users or gain visibility into employer rows.
-- Existing RLS continues to restrict reads to worker rows.
-- ============================================================

BEGIN;

GRANT SELECT (tos_accepted_at) ON users TO jale_whatsapp;

DO $$
BEGIN
  IF NOT has_column_privilege(
    'jale_whatsapp',
    'public.users',
    'tos_accepted_at',
    'SELECT'
  ) THEN
    RAISE EXCEPTION 'jale_whatsapp is missing SELECT on users.tos_accepted_at';
  END IF;

  IF has_table_privilege('jale_whatsapp', 'public.users', 'SELECT') THEN
    RAISE EXCEPTION 'jale_whatsapp unexpectedly has broad SELECT on users';
  END IF;

  IF NOT EXISTS (
    SELECT 1
      FROM pg_class table_class
      JOIN pg_namespace namespace ON namespace.oid = table_class.relnamespace
     WHERE namespace.nspname = 'public'
       AND table_class.relname = 'users'
       AND table_class.relrowsecurity
       AND table_class.relforcerowsecurity
  ) THEN
    RAISE EXCEPTION 'public.users must keep enabled and forced RLS';
  END IF;

  IF NOT EXISTS (
    SELECT 1
      FROM pg_policies
     WHERE schemaname = 'public'
       AND tablename = 'users'
       AND policyname = 'wa_users_read'
       AND cmd = 'SELECT'
       AND roles = ARRAY['jale_whatsapp']::name[]
       AND qual = '(user_type = ''worker''::text)'
       AND with_check IS NULL
  ) THEN
    RAISE EXCEPTION 'wa_users_read must remain worker-only for jale_whatsapp';
  END IF;
END;
$$;

COMMIT;
