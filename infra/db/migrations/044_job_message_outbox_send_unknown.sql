-- 044_job_message_outbox_send_unknown.sql
-- Add terminal 'send_unknown' to job_message_outbox.status so an ambiguous
-- Twilio send (accepted-but-timed-out) can be parked without auto-retry,
-- matching whatsapp_outbox / email_outbox. The existing partial sweep index
-- (WHERE status IN ('pending','failed')) already excludes it.
DO $$
DECLARE
  conname TEXT;
BEGIN
  SELECT con.conname INTO conname
    FROM pg_constraint con
    JOIN pg_class rel ON rel.oid = con.conrelid
   WHERE rel.relname = 'job_message_outbox'
     AND con.contype = 'c'
     AND pg_get_constraintdef(con.oid) ILIKE '%status%';
  IF conname IS NOT NULL THEN
    EXECUTE format('ALTER TABLE job_message_outbox DROP CONSTRAINT %I', conname);
  END IF;
END;
$$;

ALTER TABLE job_message_outbox
  ADD CONSTRAINT job_message_outbox_status_check
  CHECK (status IN ('pending', 'sent', 'failed', 'send_unknown'));
