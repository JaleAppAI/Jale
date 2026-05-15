-- ============================================================
-- 013_whatsapp_template_outbox.sql
-- Run manually AFTER 012_ai_trust_assessment.sql
-- Connect as: jale_admin (NOT the RDS master user)
-- ============================================================

ALTER TABLE whatsapp_outbox
  ALTER COLUMN body DROP NOT NULL,
  ADD COLUMN IF NOT EXISTS content_template TEXT,
  ADD COLUMN IF NOT EXISTS content_variables JSONB;

ALTER TABLE whatsapp_outbox
  ADD CONSTRAINT whatsapp_outbox_body_or_template CHECK (
    (body IS NOT NULL AND content_template IS NULL AND content_variables IS NULL)
    OR
    (body IS NULL AND content_template IS NOT NULL AND content_variables IS NOT NULL)
  );

-- Keep this optional: worker-facing matching no longer depends on
-- job_candidates, but older/future materialization environments may have it.
DO $$
BEGIN
  IF to_regclass('public.job_candidates') IS NOT NULL THEN
    GRANT SELECT (job_id, worker_id, candidate_rank) ON job_candidates TO jale_whatsapp;

    IF NOT EXISTS (
      SELECT 1
        FROM pg_policy
       WHERE polname = 'whatsapp_read_ranked_jobs'
         AND polrelid = 'public.job_candidates'::regclass
    ) THEN
      CREATE POLICY whatsapp_read_ranked_jobs ON job_candidates FOR SELECT TO jale_whatsapp
        USING (worker_id::text = current_setting('app.current_internal_user_id', true));
    END IF;
  END IF;
END;
$$;
