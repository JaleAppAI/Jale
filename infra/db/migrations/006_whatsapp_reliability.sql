-- =========================================================================
-- 006_whatsapp_reliability.sql
--
-- Most of what this file originally did (whatsapp_processed_messages,
-- whatsapp_outbox tables, jale_whatsapp reconcile grants, job_applications
-- FK flip) was folded into 003_whatsapp.sql and 005_job_applications.sql
-- on 2026-04-20 after confirming those files had not yet been applied to
-- any environment (see docs/Audit.md Status Log, Sec #7 fix).
--
-- What remains here: flip legal_consent_log.user_id FK from ON DELETE
-- CASCADE to ON DELETE RESTRICT. This fix cannot be baked in at source
-- because legal_consent_log is defined in 001_initial_schema.sql, which
-- has already been applied to the dev RDS. Schema changes to live tables
-- must ride as forward-only ALTER migrations.
--
-- Effect: a stray DELETE on users can no longer silently wipe consent
-- audit history. The DELETE will fail with foreign_key_violation, which
-- is the intended behaviour for a legal/compliance log.
-- =========================================================================

BEGIN;

ALTER TABLE legal_consent_log
    DROP CONSTRAINT legal_consent_log_user_id_fkey;

ALTER TABLE legal_consent_log
    ADD CONSTRAINT legal_consent_log_user_id_fkey
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE RESTRICT;

COMMIT;

-- ── Verification (run manually as jale_admin after migration) ──
-- SELECT conname, confdeltype FROM pg_constraint
--   WHERE conname = 'legal_consent_log_user_id_fkey';
-- Expected confdeltype = 'r' (RESTRICT).
