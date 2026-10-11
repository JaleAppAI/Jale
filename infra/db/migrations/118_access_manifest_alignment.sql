-- ============================================================
-- 118_access_manifest_alignment.sql
-- Run manually AFTER 117_admin_queues.sql,
-- connected as jale_admin. Forward-only (ADR-005). ONE transaction.
-- 116 is left free (see 117); this file does not depend on it.
--
-- Aligns two catalog settings with the reviewed access manifest
-- (infra/db/access/manifest.json), which the posture check compares the
-- catalog with. No migration sets either one differently; this file makes
-- the catalog match wherever it does not, and changes nothing where it does.
--
-- (1) FORCE ROW LEVEL SECURITY. The manifest lists these five tables as not
--     forced, as every migration that touches them leaves them:
--       public.document_upload_tokens
--       public.whatsapp_conversations
--       public.whatsapp_outbox
--       public.whatsapp_processed_messages
--       public.worker_thread_counters
--     Each one that is forced is set to NO FORCE ROW LEVEL SECURITY. Its
--     ENABLE flag, its policies and its grants are left as they are.
--
-- (2) The owner of schema public. The manifest names jale_admin. A database
--     created on PostgreSQL 15 or later starts with pg_database_owner (the
--     role that stands for the database's owner) as the owner of public.
--     When the owner is any role but jale_admin, the schema is handed to
--     jale_admin. Its grants are kept; those the previous owner made are
--     recorded as made by jale_admin, as with any change of owner.
--
-- PRECONDITIONS, all checked before anything changes, each refused with a
-- clear message: the session runs as jale_admin; the five tables exist;
-- jale_admin can act as the owner of each table it must change (it is the
-- owner or has the owner's rights); and, when public must change owner,
-- jale_admin can act as its current owner and holds CREATE on the database,
-- which ALTER SCHEMA ... OWNER TO requires.
--
-- REPLAY. Idempotent: where the catalog already matches, no catalog row is
-- written and no table is locked. A closing check refuses to commit unless
-- the five tables are not forced and jale_admin owns public.
-- ============================================================
BEGIN;

-- NO FORCE takes an ACCESS EXCLUSIVE lock on each table it changes; never
-- queue behind a stuck transaction.
SET LOCAL lock_timeout = '5s';

-- ── 1. Preconditions, then the two changes ──────────────────
DO $$
DECLARE
  v_tables CONSTANT TEXT[] := ARRAY['document_upload_tokens', 'whatsapp_conversations', 'whatsapp_outbox',
                                    'whatsapp_processed_messages', 'worker_thread_counters'];
  v_forced TEXT[] := ARRAY[]::TEXT[];
  v_name TEXT;
  v_owner OID;
  t RECORD;
BEGIN
  IF current_user <> 'jale_admin' THEN
    RAISE EXCEPTION 'migration 118: connect as jale_admin (this session runs as %)', current_user;
  END IF;

  FOR t IN
    SELECT want.relname, c.oid, c.relowner, c.relforcerowsecurity
      FROM unnest(v_tables) AS want(relname)
      LEFT JOIN pg_catalog.pg_class c
        ON c.relname = want.relname
       AND c.relnamespace = 'public'::regnamespace
       AND c.relkind IN ('r', 'p')
     ORDER BY want.relname
  LOOP
    IF t.oid IS NULL THEN
      RAISE EXCEPTION 'migration 118: public.% is missing', t.relname;
    END IF;
    IF t.relforcerowsecurity THEN
      IF NOT pg_catalog.pg_has_role(current_user, t.relowner, 'USAGE') THEN
        RAISE EXCEPTION 'migration 118: public.% is forced, and jale_admin cannot act as its owner %',
          t.relname, pg_catalog.pg_get_userbyid(t.relowner);
      END IF;
      v_forced := v_forced || t.relname::TEXT;
    END IF;
  END LOOP;

  SELECT n.nspowner INTO v_owner FROM pg_catalog.pg_namespace n WHERE n.nspname = 'public';
  IF v_owner IS NULL THEN
    RAISE EXCEPTION 'migration 118: schema public is missing';
  END IF;
  IF v_owner <> 'jale_admin'::regrole THEN
    IF NOT pg_catalog.pg_has_role(current_user, v_owner, 'USAGE') THEN
      RAISE EXCEPTION 'migration 118: schema public is owned by %, and jale_admin cannot act as that role',
        pg_catalog.pg_get_userbyid(v_owner);
    END IF;
    IF NOT pg_catalog.has_database_privilege(current_database(), 'CREATE') THEN
      RAISE EXCEPTION 'migration 118: schema public cannot change owner: jale_admin lacks CREATE on the database';
    END IF;
  END IF;

  FOREACH v_name IN ARRAY v_forced LOOP
    EXECUTE format('ALTER TABLE %I.%I NO FORCE ROW LEVEL SECURITY', 'public', v_name);
  END LOOP;

  IF v_owner <> 'jale_admin'::regrole THEN
    ALTER SCHEMA public OWNER TO jale_admin;
  END IF;

  RAISE NOTICE 'migration 118: % of 5 tables changed to NO FORCE; schema public changed owner: %',
    cardinality(v_forced), CASE WHEN v_owner <> 'jale_admin'::regrole THEN 'yes' ELSE 'no' END;
END;
$$;

-- ── 2. Closing check ────────────────────────────────────────
DO $$
DECLARE
  v_tables CONSTANT TEXT[] := ARRAY['document_upload_tokens', 'whatsapp_conversations', 'whatsapp_outbox',
                                    'whatsapp_processed_messages', 'worker_thread_counters'];
  v_owner TEXT;
  offender TEXT;
BEGIN
  SELECT string_agg('public.' || want.relname, ', ' ORDER BY want.relname) INTO offender
    FROM unnest(v_tables) AS want(relname)
    LEFT JOIN pg_catalog.pg_class c
      ON c.relname = want.relname
     AND c.relnamespace = 'public'::regnamespace
     AND c.relkind IN ('r', 'p')
   WHERE c.oid IS NULL OR c.relforcerowsecurity;
  IF offender IS NOT NULL THEN
    RAISE EXCEPTION 'migration 118: still forced or missing: %', offender;
  END IF;

  SELECT pg_catalog.pg_get_userbyid(n.nspowner) INTO v_owner FROM pg_catalog.pg_namespace n WHERE n.nspname = 'public';
  IF v_owner IS DISTINCT FROM 'jale_admin' THEN
    RAISE EXCEPTION 'migration 118: schema public is owned by %, not jale_admin', v_owner;
  END IF;
END;
$$;

COMMIT;
