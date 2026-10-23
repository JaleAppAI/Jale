-- ============================================================
-- 132_job_limit_increase.sql
-- Run manually AFTER 131,
-- connected as jale_admin. Forward-only (ADR-005). ONE transaction.
--
-- Raises the active-job limits in the plan catalog: Free from 1 to 15
-- active jobs, Pro from 10 to 50. The template limits stay 2 (Free) and 20
-- (Pro). No job changes status here: a paused job stays paused.
--
-- resolveEntitlements (infra/lambda/lib/entitlements.ts) reads billing_plans
-- on every call, so the next job create or reactivation applies the new
-- limits with no deploy. The billing resume (125) brings back billing-paused
-- jobs up to the plan's limit when a subscription recovers; on Pro that
-- limit is now 50.
--
-- billing_plans forces row security and has read policies only (034). As in
-- 069, a write policy for jale_admin exists for this transaction only: it is
-- created before the two UPDATEs and dropped right after them. The closing
-- check refuses to commit unless both plans carry the new limits, the
-- template limits are unchanged, and the write policy is gone.
--
-- REPLAY. Idempotent: the UPDATEs merge the same values on every run.
-- ============================================================
BEGIN;

-- The policy DDL locks billing_plans, which every job create reads; never
-- queue behind a stuck transaction.
SET LOCAL lock_timeout = '5s';

-- ── 1. Preconditions ────────────────────────────────────────
DO $$
BEGIN
  IF current_user <> 'jale_admin' THEN
    RAISE EXCEPTION 'migration 132: connect as jale_admin (this session runs as %)', current_user;
  END IF;
  IF pg_catalog.to_regclass('public.billing_plans') IS NULL THEN
    RAISE EXCEPTION 'migration 132: public.billing_plans is missing';
  END IF;
END;
$$;

-- ── 2. The new limits ───────────────────────────────────────
DROP POLICY IF EXISTS billing_plans_job_limit_seed ON billing_plans;
CREATE POLICY billing_plans_job_limit_seed
  ON billing_plans FOR UPDATE TO jale_admin USING (true) WITH CHECK (true);

UPDATE billing_plans SET entitlements = entitlements || '{"active_job_limit": 15}' WHERE code = 'employer_free';
UPDATE billing_plans SET entitlements = entitlements || '{"active_job_limit": 50}' WHERE code = 'employer_pro';

DROP POLICY IF EXISTS billing_plans_job_limit_seed ON billing_plans;

-- ── 3. Closing check ────────────────────────────────────────
DO $$
DECLARE
  v_free_jobs      JSONB;
  v_free_templates JSONB;
  v_pro_jobs       JSONB;
  v_pro_templates  JSONB;
BEGIN
  SELECT p.entitlements -> 'active_job_limit', p.entitlements -> 'template_limit'
    INTO v_free_jobs, v_free_templates
    FROM public.billing_plans p
   WHERE p.code = 'employer_free';
  SELECT p.entitlements -> 'active_job_limit', p.entitlements -> 'template_limit'
    INTO v_pro_jobs, v_pro_templates
    FROM public.billing_plans p
   WHERE p.code = 'employer_pro';

  IF v_free_jobs IS DISTINCT FROM '15'::jsonb OR v_pro_jobs IS DISTINCT FROM '50'::jsonb THEN
    RAISE EXCEPTION 'migration 132: active_job_limit is % (employer_free) and % (employer_pro), expected 15 and 50',
      v_free_jobs, v_pro_jobs;
  END IF;
  IF v_free_templates IS DISTINCT FROM '2'::jsonb OR v_pro_templates IS DISTINCT FROM '20'::jsonb THEN
    RAISE EXCEPTION 'migration 132: template_limit is % (employer_free) and % (employer_pro), expected 2 and 20',
      v_free_templates, v_pro_templates;
  END IF;
  IF EXISTS (
    SELECT 1
      FROM pg_catalog.pg_policies
     WHERE schemaname = 'public' AND tablename = 'billing_plans' AND policyname = 'billing_plans_job_limit_seed'
  ) THEN
    RAISE EXCEPTION 'migration 132: the write policy billing_plans_job_limit_seed is still present';
  END IF;
END;
$$;

COMMIT;
