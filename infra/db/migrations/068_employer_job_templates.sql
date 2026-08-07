-- 068_employer_job_templates.sql
-- Named, reusable job-posting templates for employers, plus the per-plan
-- template_limit entitlement. The payload column stores EXACTLY the
-- employer-jobs-create request-body shape, validated at write time by the
-- same helpers the create endpoint uses (parseJobFields/parseRequiredDocs/
-- parseCityFields/parseOptionalCoordinates) -- start_date is stripped by the
-- API and never stored.
--
-- Only the employer web API reads or writes templates, so grants go to
-- jale_admin alone. RLS mirrors the jobs employer-self policies.
--
-- Run AFTER 067_preferred_city_centroids.sql, connected as jale_admin
-- (NOT the RDS master user). Forward-only (ADR-005). Deploy BEFORE the
-- lambda rollout: resolveEntitlements parses template_limit strictly.

BEGIN;

CREATE TABLE employer_job_templates (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  employer_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name        TEXT NOT NULL CHECK (char_length(name) BETWEEN 1 AND 80),
  payload     JSONB NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (employer_id, name)
);

GRANT SELECT, INSERT, UPDATE, DELETE ON employer_job_templates TO jale_admin;

ALTER TABLE employer_job_templates ENABLE ROW LEVEL SECURITY;
ALTER TABLE employer_job_templates FORCE ROW LEVEL SECURITY;

-- Same resolution shape as the jobs employer policies: the caller reaches
-- only their own rows, on both read and write, via cognito_sub.
CREATE POLICY employer_job_templates_self
  ON employer_job_templates FOR ALL
  USING (
    employer_id = (
      SELECT id FROM users
      WHERE cognito_sub = current_setting('app.current_user_id', true)
        AND user_type = 'employer'
    )
  )
  WITH CHECK (
    employer_id = (
      SELECT id FROM users
      WHERE cognito_sub = current_setting('app.current_user_id', true)
        AND user_type = 'employer'
    )
  );

-- Per-plan template caps (product knobs -- adjust in review, not in code).
--
-- billing_plans is FORCE ROW LEVEL SECURITY with SELECT-only policies (034),
-- so even the table owner's UPDATE matches ZERO rows silently -- the same
-- failure mode that voided the 061 backfill. Open a temporary write policy
-- for the seed, drop it, then PROVE both rows changed: a silent no-op here
-- becomes a platform-wide employer outage once resolveEntitlements starts
-- parsing template_limit strictly.
DROP POLICY IF EXISTS billing_plans_template_seed ON billing_plans;
CREATE POLICY billing_plans_template_seed
  ON billing_plans FOR UPDATE TO jale_admin USING (true) WITH CHECK (true);

UPDATE billing_plans SET entitlements = entitlements || '{"template_limit": 2}'  WHERE code = 'employer_free';
UPDATE billing_plans SET entitlements = entitlements || '{"template_limit": 20}' WHERE code = 'employer_pro';

DROP POLICY IF EXISTS billing_plans_template_seed ON billing_plans;

DO $$
DECLARE seeded integer;
BEGIN
  SELECT count(*) INTO seeded
  FROM billing_plans
  WHERE code IN ('employer_free', 'employer_pro')
    AND entitlements ? 'template_limit';
  IF seeded <> 2 THEN
    RAISE EXCEPTION 'template_limit seed failed: % of 2 plans updated', seeded;
  END IF;
END;
$$;

COMMIT;
