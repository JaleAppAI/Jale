-- 043_applications_employer_update_repair.sql
-- Idempotent restore of the migration-015 employer update policy for any DB
-- that reached later schema with it absent (see 020b header). No-op where it
-- already exists. Standalone forward migration (not an edit to shipped 038).
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
     WHERE schemaname = 'public'
       AND tablename = 'job_applications'
       AND policyname = 'applications_employer_update'
  ) THEN
    CREATE POLICY applications_employer_update
      ON job_applications FOR UPDATE
      USING (
        job_id IN (
          SELECT id FROM jobs
           WHERE employer_id = (
             SELECT id FROM users
              WHERE cognito_sub = current_setting('app.current_user_id', true)
           )
        )
      )
      WITH CHECK (
        job_id IN (
          SELECT id FROM jobs
           WHERE employer_id = (
             SELECT id FROM users
              WHERE cognito_sub = current_setting('app.current_user_id', true)
           )
        )
      );
  END IF;
END;
$$;

ALTER POLICY applications_employer_update ON job_applications TO jale_admin;
