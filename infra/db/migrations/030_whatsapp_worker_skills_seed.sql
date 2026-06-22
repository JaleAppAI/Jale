-- ============================================================
-- 028_whatsapp_worker_skills_seed.sql
-- Run manually AFTER 027_hired_count_trigger_security_definer.sql
-- Connect as: jale_admin (NOT the RDS master user)
--
-- WhatsApp onboarding now seeds a trade-derived starter skill into
-- worker_skills at the end of profile building (see
-- upsertWorkerProfileFromUsers in lambda/whatsapp/lib/profile-flow.ts).
-- 008 granted jale_whatsapp SELECT only, so the Lambda's INSERT would
-- fail with 42501. This adds the INSERT grant plus a worker-scoped
-- INSERT policy mirroring the shape of worker_skills_whatsapp_read.
--
-- MUST be applied BEFORE deploying the WhatsAppStack build that
-- contains the seeding code, or profile completion will start failing.
-- ============================================================

GRANT INSERT ON worker_skills TO jale_whatsapp;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE tablename = 'worker_skills'
      AND policyname = 'worker_skills_whatsapp_insert'
  ) THEN
    CREATE POLICY worker_skills_whatsapp_insert
      ON worker_skills FOR INSERT TO jale_whatsapp
      WITH CHECK (
        EXISTS (
          SELECT 1 FROM users u
          WHERE u.id = worker_skills.worker_id
            AND u.user_type = 'worker'
        )
      );
  END IF;
END $$;
