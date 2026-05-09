-- ============================================================
-- 008_worker_skills.sql
-- Run manually AFTER 007_worker_marketplace.sql
-- Connect as: jale_admin (NOT the RDS master user)
-- ============================================================

CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE TABLE worker_skills (
  worker_id  UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  skill      TEXT NOT NULL CHECK (char_length(skill) BETWEEN 1 AND 100),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (worker_id, skill)
);

CREATE INDEX IF NOT EXISTS worker_skills_skill_gin
  ON worker_skills USING GIN (skill gin_trgm_ops);

GRANT SELECT, INSERT, UPDATE, DELETE ON worker_skills TO jale_admin;
GRANT SELECT ON worker_skills TO jale_whatsapp;

ALTER TABLE worker_skills ENABLE ROW LEVEL SECURITY;
ALTER TABLE worker_skills FORCE ROW LEVEL SECURITY;

CREATE POLICY worker_skills_self
  ON worker_skills FOR ALL TO jale_admin
  USING (worker_id = (SELECT id FROM users WHERE cognito_sub = current_setting('app.current_user_id', true)))
  WITH CHECK (worker_id = (SELECT id FROM users WHERE cognito_sub = current_setting('app.current_user_id', true)));

CREATE POLICY worker_skills_employer_read
  ON worker_skills FOR SELECT TO jale_admin
  USING ((SELECT user_type FROM users WHERE cognito_sub = current_setting('app.current_user_id', true)) = 'employer');

CREATE POLICY worker_skills_whatsapp_read
  ON worker_skills FOR SELECT TO jale_whatsapp
  USING (
    EXISTS (
      SELECT 1 FROM users u
      WHERE u.id = worker_skills.worker_id
        AND u.user_type = 'worker'
    )
  );

INSERT INTO worker_skills (worker_id, skill)
SELECT wp.user_id, s.skill
FROM worker_profiles wp
CROSS JOIN LATERAL (
  SELECT DISTINCT lower(btrim(raw_skill.skill)) AS skill
  FROM unnest(wp.skills) AS raw_skill(skill)
  WHERE char_length(btrim(raw_skill.skill)) BETWEEN 1 AND 100
) s
WHERE wp.skills IS NOT NULL
  AND array_length(wp.skills, 1) > 0
ON CONFLICT DO NOTHING;

ALTER TABLE worker_profiles DROP COLUMN skills;
