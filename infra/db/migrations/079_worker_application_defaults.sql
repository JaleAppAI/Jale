-- 079_worker_application_defaults.sql
-- Job-flow redesign (BE-T1): one row per worker holding the answers they
-- want pre-filled onto every future job application (jobs.required_fields /
-- optional_fields from 073/074) -- home address, date of birth, emergency
-- contact, etc. -- so a worker who has already supplied these once is not
-- re-asked on every application.
--
-- CREATE TABLE IF NOT EXISTS worker_application_defaults (
--   worker_id UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
--   answers   JSONB NOT NULL DEFAULT '{}'::jsonb,
--   updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
-- )
--
-- answers is an opaque JSONB bag keyed by the same field identifiers as
-- REQUIRED_FIELD_TYPES (job-fields.ts / 073's jobs_required_fields_valid);
-- shape validation is app-layer, same precedent as job_applications'
-- application_answers column (073) and jobs.certification_requirements
-- (077) -- no per-key CHECK here.
--
-- updated_at is NOT NULL DEFAULT now() but has NO update trigger (unlike
-- job_applications_updated_at, 019): the app layer is expected to set it
-- explicitly on every UPDATE, since every write to this table goes through
-- one narrow helper (upsertWorkerApplicationDefaults in
-- infra/lambda/lib/worker-application-defaults.ts, called inside the web
-- apply transaction) with no multi-path write surface the way
-- job_applications has. A trigger would be redundant machinery for a single
-- call site.
--
-- ── Grants: jale_admin ONLY, by design ───────────────────────────
-- GRANT SELECT, INSERT, UPDATE TO jale_admin -- deliberately NO explicit
-- DELETE in the grant list (unlike worker_preferred_cities in 065, which
-- grants DELETE because a worker can remove a preferred city outright;
-- there is no product action today that deletes a worker's application
-- defaults row wholesale, only ones that overwrite `answers` in place).
-- This GRANT documents intended access, not an enforced restriction: this
-- migration runs as jale_admin, so jale_admin OWNS the table it just
-- created and therefore already holds DELETE (and every other table-level
-- privilege) implicitly via Postgres ownership semantics
-- (aclexplode(acldefault(...))), regardless of what this GRANT list
-- names -- REVOKE would be required to actually remove it, and this
-- migration does not do that, matching 065's own worker_preferred_cities
-- precedent of granting to jale_admin despite the same implicit-ownership
-- fact. Add an explicit DELETE to the GRANT list in a future migration if
-- that becomes the intended interface, purely for documentation clarity.
--
-- Also deliberately NO grant to jale_whatsapp in this migration, even though
-- a WhatsApp fill-flow (Ivan's side) is expected to want one eventually: a
-- worker who has already answered these fields via WhatsApp should be able
-- to have that flow both read and prefill `answers`, but that flow does not
-- exist yet as of this migration. When it lands, add a follow-up migration
-- that does:
--   GRANT SELECT, INSERT, UPDATE ON worker_application_defaults TO jale_whatsapp;
-- (INSERT because a WhatsApp-only worker may create the row before ever
-- touching the web app; no DELETE, same reasoning as jale_admin above).
-- Do NOT add that grant here speculatively -- least-privilege by default,
-- widened only when a real caller needs it, same posture 071_wage_references.sql
-- documents for its own deliberately-excluded roles.
--
-- RLS mirrors worker_preferred_cities_self (065_city_keys_and_preferred_cities.sql)
-- exactly: FOR ALL, resolved through cognito_sub + user_type = 'worker', same
-- USING/WITH CHECK shape, same reasoning (a worker reaches only their own row
-- on both read and write).
--
-- Run AFTER 078_worker_documents_cert_name.sql, connected as jale_admin (NOT
-- the RDS master user). Forward-only (ADR-005).

BEGIN;

CREATE TABLE IF NOT EXISTS worker_application_defaults (
  worker_id  UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  answers    JSONB NOT NULL DEFAULT '{}'::jsonb,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

GRANT SELECT, INSERT, UPDATE ON worker_application_defaults TO jale_admin;

ALTER TABLE worker_application_defaults ENABLE ROW LEVEL SECURITY;
ALTER TABLE worker_application_defaults FORCE ROW LEVEL SECURITY;

-- DROP-guard so a re-apply of this file alone is clean, matching 077/078's
-- IF-EXISTS-guarded DDL (CREATE POLICY has no IF NOT EXISTS form). The chain
-- is still forward-only (ADR-005); this only hardens accidental re-runs.
DROP POLICY IF EXISTS worker_application_defaults_self ON worker_application_defaults;

CREATE POLICY worker_application_defaults_self ON worker_application_defaults FOR ALL
  USING (
    worker_id = (
      SELECT id FROM users
      WHERE cognito_sub = current_setting('app.current_user_id', true)
        AND user_type = 'worker'
    )
  )
  WITH CHECK (
    worker_id = (
      SELECT id FROM users
      WHERE cognito_sub = current_setting('app.current_user_id', true)
        AND user_type = 'worker'
    )
  );

-- ── Verification ─────────────────────────────────────────────────
DO $$
BEGIN
  IF to_regclass('public.worker_application_defaults') IS NULL THEN
    RAISE EXCEPTION 'worker_application_defaults table missing';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'worker_application_defaults'
      AND column_name = 'worker_id' AND is_nullable = 'NO'
  ) THEN
    RAISE EXCEPTION 'worker_application_defaults.worker_id missing or nullable';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'worker_application_defaults'
      AND column_name = 'answers' AND data_type = 'jsonb' AND is_nullable = 'NO'
  ) THEN
    RAISE EXCEPTION 'worker_application_defaults.answers missing, nullable, or not jsonb';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'worker_application_defaults'
      AND column_name = 'updated_at' AND is_nullable = 'NO'
  ) THEN
    RAISE EXCEPTION 'worker_application_defaults.updated_at missing or nullable';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_class rel ON rel.oid = c.conrelid
    WHERE rel.relname = 'worker_application_defaults' AND c.contype = 'p'
  ) THEN
    RAISE EXCEPTION 'worker_application_defaults missing its PRIMARY KEY on worker_id';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_class rel ON rel.oid = c.conrelid
    WHERE rel.relname = 'worker_application_defaults' AND c.contype = 'f'
      AND pg_get_constraintdef(c.oid) ILIKE '%REFERENCES users(id)%ON DELETE CASCADE%'
  ) THEN
    RAISE EXCEPTION 'worker_application_defaults.worker_id missing its ON DELETE CASCADE FK to users(id)';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_class rel
    JOIN pg_namespace n ON n.oid = rel.relnamespace
    WHERE n.nspname = 'public' AND rel.relname = 'worker_application_defaults'
      AND rel.relrowsecurity AND rel.relforcerowsecurity
  ) THEN
    RAISE EXCEPTION 'worker_application_defaults must have RLS ENABLE + FORCE';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_policy p
    JOIN pg_class rel ON rel.oid = p.polrelid
    WHERE rel.relname = 'worker_application_defaults' AND p.polname = 'worker_application_defaults_self'
  ) THEN
    RAISE EXCEPTION 'worker_application_defaults_self policy missing';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_privileges
    WHERE grantee = 'jale_admin' AND table_schema = 'public'
      AND table_name = 'worker_application_defaults' AND privilege_type = 'SELECT'
  ) OR NOT EXISTS (
    SELECT 1 FROM information_schema.table_privileges
    WHERE grantee = 'jale_admin' AND table_schema = 'public'
      AND table_name = 'worker_application_defaults' AND privilege_type = 'INSERT'
  ) OR NOT EXISTS (
    SELECT 1 FROM information_schema.table_privileges
    WHERE grantee = 'jale_admin' AND table_schema = 'public'
      AND table_name = 'worker_application_defaults' AND privilege_type = 'UPDATE'
  ) THEN
    RAISE EXCEPTION 'jale_admin missing SELECT/INSERT/UPDATE grant on worker_application_defaults';
  END IF;

  -- No grant at all to jale_whatsapp -- see header (a future migration adds
  -- one when the WhatsApp fill-flow lands). Not checking for an absent
  -- DELETE grant on jale_admin here: jale_admin owns this table (it ran the
  -- CREATE TABLE above), so information_schema.table_privileges shows it
  -- holding DELETE implicitly via ownership regardless of this migration's
  -- GRANT list -- asserting its absence would be asserting something
  -- Postgres ownership makes impossible, not something this migration
  -- controls. See the header for why the GRANT list omits it anyway.
  IF EXISTS (
    SELECT 1 FROM information_schema.table_privileges
    WHERE grantee = 'jale_whatsapp' AND table_schema = 'public'
      AND table_name = 'worker_application_defaults'
  ) THEN
    RAISE EXCEPTION 'jale_whatsapp unexpectedly has a grant on worker_application_defaults (see header: future migration, not this one)';
  END IF;
END;
$$;

COMMIT;
