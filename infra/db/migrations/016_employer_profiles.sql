-- ============================================================
-- 016_employer_profiles.sql
-- Run manually AFTER 015_application_status_alignment.sql
-- Connect as: jale_admin (NOT the RDS master user)
--
-- Dedicated employer profile rows for web account creation.
-- ============================================================

CREATE TABLE IF NOT EXISTS employer_profiles (
  user_id             UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  company_name        TEXT,
  contact_name        TEXT,
  phone               TEXT,
  city                TEXT,
  service_area        TEXT,
  hiring_trades       TEXT[] NOT NULL DEFAULT '{}'
                      CHECK (hiring_trades <@ ARRAY[
                        'electrician',
                        'plumber',
                        'carpenter',
                        'concrete',
                        'painting',
                        'other'
                      ]::TEXT[]),
  typical_job_types   TEXT[] NOT NULL DEFAULT '{}'
                      CHECK (typical_job_types <@ ARRAY[
                        'full-time',
                        'part-time',
                        'contract'
                      ]::TEXT[]),
  company_size        TEXT CHECK (company_size IN ('1-10', '11-50', '51-200', '200+')),
  company_description TEXT,
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TRIGGER employer_profiles_updated_at
  BEFORE UPDATE ON employer_profiles
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

GRANT SELECT, INSERT, UPDATE ON employer_profiles TO jale_admin;

ALTER TABLE employer_profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE employer_profiles FORCE ROW LEVEL SECURITY;

CREATE POLICY employer_profiles_self
  ON employer_profiles FOR ALL
  USING (
    user_id = (
      SELECT id FROM users
      WHERE cognito_sub = current_setting('app.current_user_id', true)
        AND user_type = 'employer'
    )
  )
  WITH CHECK (
    user_id = (
      SELECT id FROM users
      WHERE cognito_sub = current_setting('app.current_user_id', true)
        AND user_type = 'employer'
    )
  );
