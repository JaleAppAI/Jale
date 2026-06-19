-- ============================================================
-- 027_hired_count_trigger_security_definer.sql
-- Run manually AFTER 026_job_messaging_hardening.sql. Connect as: jale_admin.
--
-- Fix: worker WhatsApp replies failed with "permission denied for table jobs"
-- (SQLSTATE 42501).
--
-- Root cause: recordWorkerConversationReply / openWorkerConversation (running as
-- jale_whatsapp) do `UPDATE job_applications SET status='talking'`. That fires the
-- AFTER trigger job_applications_hired_count_sync -> sync_job_hired_counts()
-- (created in 023 as the default SECURITY INVOKER), whose body runs `UPDATE jobs`.
-- As SECURITY INVOKER the cascade inherits the *triggering* role's privileges, and
-- jale_whatsapp has no UPDATE on jobs -> the whole transaction rolls back, so the
-- worker reply is never recorded or relayed.
--
-- Migration 026 granted jale_whatsapp UPDATE on job_applications (R2) but did not
-- account for this trigger cascade into jobs.
--
-- Fix: recreate sync_job_hired_counts() as SECURITY DEFINER (owner = jale_admin,
-- which can update jobs) with a pinned search_path. The trigger maintains an
-- internal derived invariant (workers_hired + job status); it should run with
-- definer rights regardless of which role mutates job_applications. This is the
-- same pattern as 026's assign_worker_thread_number / record_twilio_status.
--
-- Not chosen: granting jale_whatsapp UPDATE on jobs — that would let the WhatsApp
-- role modify arbitrary job fields/status, widening its surface against ADR-W05.
--
-- Body is byte-identical to 023's definition; only SECURITY DEFINER + search_path
-- are added. CREATE OR REPLACE preserves the existing trigger binding, so the
-- job_applications_hired_count_sync trigger is left untouched.
-- ============================================================
BEGIN;

CREATE OR REPLACE FUNCTION sync_job_hired_counts()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  target_job_id UUID;
BEGIN
  IF TG_OP = 'DELETE' THEN
    target_job_id := OLD.job_id;
  ELSE
    target_job_id := NEW.job_id;
  END IF;

  UPDATE jobs
  SET workers_hired = (
        SELECT COUNT(*)::int
        FROM job_applications
        WHERE job_id = target_job_id
          AND status = 'hired'
      ),
      status = CASE
        WHEN status IN ('closed', 'paused') THEN status
        WHEN (
          SELECT COUNT(*)::int
          FROM job_applications
          WHERE job_id = target_job_id
            AND status = 'hired'
        ) >= number_of_workers_needed THEN 'filled'
        WHEN status = 'filled' THEN 'active'
        ELSE status
      END
  WHERE id = target_job_id;

  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;

  RETURN NEW;
END;
$$;

COMMIT;
