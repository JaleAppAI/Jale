-- 050_whatsapp_v2_profile_steps.sql
--
-- The WhatsApp v2 onboarding workflow is gaining new profile-collection
-- steps (voice-driven profile capture, photo capture, and richer profile
-- fields). Migration 042's worker_workflow_runs_current_step_key_check CHECK
-- constraint pins current_step_key to a closed list of ten values; writing
-- any new step key would violate that CHECK, roll back the transaction, and
-- strand the worker mid-onboarding.
--
-- This migration drops and recreates that CHECK constraint with the full
-- future-facing set of seventeen step keys. Several of these are not yet
-- reachable from code (they land in a concurrent workstream) — that is
-- intentional: widening the constraint ahead of the handlers avoids a
-- second migration once those handlers ship. No data migration is needed:
-- every existing value is preserved.
--
-- worker_identity_challenges.current_step_key keeps its own, deliberately
-- narrower CHECK (042 line 64, start.choose_language / identity.verify_otp
-- only) — untouched here.

BEGIN;

ALTER TABLE public.worker_workflow_runs
  DROP CONSTRAINT worker_workflow_runs_current_step_key_check;

ALTER TABLE public.worker_workflow_runs
  ADD CONSTRAINT worker_workflow_runs_current_step_key_check
  CHECK (current_step_key IN (
    'start.choose_language',
    'identity.verify_otp',
    'legal.review',
    'profile.voice_choice',
    'profile.voice_processing',
    'profile.name',
    'profile.location',
    'profile.trade',
    'profile.custom_trade',
    'profile.experience',
    'profile.transportation',
    'profile.availability',
    'trust.question.1',
    'trust.question.2',
    'trust.question.3',
    'profile.photo',
    'profile.photo_type'
  ));

DO $migration$
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM pg_catalog.pg_constraint con
      JOIN pg_catalog.pg_class tbl ON tbl.oid = con.conrelid
      JOIN pg_catalog.pg_namespace n ON n.oid = tbl.relnamespace
     WHERE n.nspname = 'public'
       AND tbl.relname = 'worker_workflow_runs'
       AND con.contype = 'c'
       AND con.conname = 'worker_workflow_runs_current_step_key_check'
       AND pg_catalog.pg_get_constraintdef(con.oid) = 'CHECK ((current_step_key = ANY (ARRAY['
         || '''start.choose_language''::text, '
         || '''identity.verify_otp''::text, '
         || '''legal.review''::text, '
         || '''profile.voice_choice''::text, '
         || '''profile.voice_processing''::text, '
         || '''profile.name''::text, '
         || '''profile.location''::text, '
         || '''profile.trade''::text, '
         || '''profile.custom_trade''::text, '
         || '''profile.experience''::text, '
         || '''profile.transportation''::text, '
         || '''profile.availability''::text, '
         || '''trust.question.1''::text, '
         || '''trust.question.2''::text, '
         || '''trust.question.3''::text, '
         || '''profile.photo''::text, '
         || '''profile.photo_type''::text])))'
  ) THEN
    RAISE EXCEPTION 'migration 050 check constraint self-audit failed: worker_workflow_runs.worker_workflow_runs_current_step_key_check';
  END IF;
END;
$migration$;

COMMIT;
