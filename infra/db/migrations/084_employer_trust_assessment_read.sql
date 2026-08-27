-- 084_employer_trust_assessment_read.sql
--
-- Employer worker-profile page shows the applicant's trust assessment.
-- Until now only the worker's own cognito_sub could read
-- worker_trust_assessments (012's wta_worker_own_rows); FORCE RLS made a
-- naive employer JOIN return nothing. This adds employer read access,
-- gated on the recursion-safe applicant-relationship predicate (020b/038).
-- SELECT only: employers never write assessments.
--
-- Forward-only. Applied manually via bastion (ADR-005), connected as
-- jale_admin (NOT the RDS master user) -- same convention as 066/083.

BEGIN;

CREATE POLICY wta_employer_applicant_read ON worker_trust_assessments
  FOR SELECT TO jale_admin
  USING (jale_internal.employer_has_applicant_relationship(
           current_setting('app.current_internal_user_id', true), user_id));

COMMIT;
