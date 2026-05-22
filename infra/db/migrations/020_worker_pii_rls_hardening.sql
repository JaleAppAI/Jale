-- ============================================================
-- 020_worker_pii_rls_hardening.sql
-- Run manually AFTER 019_application_status_constraint_repair.sql
-- Connect as: jale_admin (NOT the RDS master user)
--
-- Employer access to worker PII is applicant-scoped only.
-- Candidate discovery and matching rows must not unlock contact data.
-- ============================================================

ALTER TABLE users ENABLE ROW LEVEL SECURITY;
ALTER TABLE users FORCE ROW LEVEL SECURITY;
ALTER TABLE worker_profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE worker_profiles FORCE ROW LEVEL SECURITY;
ALTER TABLE worker_skills ENABLE ROW LEVEL SECURITY;
ALTER TABLE worker_skills FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS worker_profiles_employer_read ON worker_profiles;
DROP POLICY IF EXISTS worker_skills_employer_read ON worker_skills;
DROP POLICY IF EXISTS users_employer_applicant_read ON users;

CREATE POLICY users_employer_applicant_read
  ON users FOR SELECT TO jale_admin
  USING (
    user_type = 'worker'
    AND EXISTS (
      SELECT 1
      FROM job_applications ja
      JOIN jobs j ON j.id = ja.job_id
      WHERE ja.worker_id = users.id
        AND j.employer_id::text = current_setting('app.current_internal_user_id', true)
    )
  );

CREATE POLICY worker_profiles_employer_read
  ON worker_profiles FOR SELECT TO jale_admin
  USING (
    EXISTS (
      SELECT 1
      FROM job_applications ja
      JOIN jobs j ON j.id = ja.job_id
      WHERE ja.worker_id = worker_profiles.user_id
        AND j.employer_id::text = current_setting('app.current_internal_user_id', true)
    )
  );

CREATE POLICY worker_skills_employer_read
  ON worker_skills FOR SELECT TO jale_admin
  USING (
    EXISTS (
      SELECT 1
      FROM job_applications ja
      JOIN jobs j ON j.id = ja.job_id
      WHERE ja.worker_id = worker_skills.worker_id
        AND j.employer_id::text = current_setting('app.current_internal_user_id', true)
    )
  );

REVOKE SELECT ON worker_profiles FROM jale_matching;
REVOKE SELECT ON worker_skills FROM jale_matching;
REVOKE SELECT ON worker_documents FROM jale_matching;
REVOKE SELECT (full_name, phone) ON users FROM jale_matching;

DO $$
DECLARE
  matching_profile_columns TEXT;
BEGIN
  SELECT string_agg(quote_ident(column_name), ', ' ORDER BY ordinal_position)
  INTO matching_profile_columns
  FROM information_schema.columns
  WHERE table_schema = 'public'
    AND table_name = 'worker_profiles'
    AND column_name = ANY(ARRAY[
      'user_id',
      'availability',
      'years_experience',
      'location',
      'latitude',
      'longitude',
      'location_source',
      'location_confidence'
    ]);

  IF matching_profile_columns IS NOT NULL THEN
    EXECUTE format('GRANT SELECT (%s) ON worker_profiles TO jale_matching', matching_profile_columns);
  END IF;
END;
$$;
GRANT SELECT (worker_id, skill) ON worker_skills TO jale_matching;

DROP POLICY IF EXISTS worker_documents_matching_read ON worker_documents;

DROP POLICY IF EXISTS worker_profiles_matching_read ON worker_profiles;
CREATE POLICY worker_profiles_matching_read ON worker_profiles
  FOR SELECT TO jale_matching USING (true);

DROP POLICY IF EXISTS worker_skills_matching_read ON worker_skills;
CREATE POLICY worker_skills_matching_read ON worker_skills
  FOR SELECT TO jale_matching USING (true);
