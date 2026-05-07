-- ============================================================
-- 010_matching_write_semantics.sql
-- Run manually AFTER 009_location_foundation.sql
-- Connect as: jale_admin (NOT the RDS master user)
-- ============================================================

DO $$
BEGIN
  CREATE ROLE jale_matching LOGIN;
EXCEPTION
  WHEN duplicate_object THEN
    RAISE NOTICE 'role jale_matching already exists, skipping CREATE ROLE';
END;
$$;

GRANT SELECT ON jobs TO jale_matching;
GRANT SELECT (id, user_type, main_trade, trust_signals, trust_signals_completed_at) ON users TO jale_matching;
GRANT SELECT ON worker_profiles TO jale_matching;
GRANT SELECT ON worker_skills TO jale_matching;
GRANT SELECT ON worker_documents TO jale_matching;

CREATE POLICY jobs_matching_read ON jobs
  FOR SELECT TO jale_matching USING (true);

CREATE POLICY users_matching_read ON users
  FOR SELECT TO jale_matching USING (user_type IN ('worker', 'employer'));

CREATE POLICY worker_profiles_matching_read ON worker_profiles
  FOR SELECT TO jale_matching USING (true);

CREATE POLICY worker_skills_matching_read ON worker_skills
  FOR SELECT TO jale_matching USING (true);

CREATE POLICY worker_documents_matching_read ON worker_documents
  FOR SELECT TO jale_matching USING (true);

CREATE TABLE job_candidates (
  job_id           UUID NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  worker_id        UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  score            SMALLINT NOT NULL CHECK (score BETWEEN 0 AND 100),
  score_components JSONB NOT NULL DEFAULT '{}',
  candidate_rank   INTEGER NOT NULL CHECK (candidate_rank > 0),
  materialized_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (job_id, worker_id)
);

CREATE UNIQUE INDEX job_candidates_job_rank_unique
  ON job_candidates (job_id, candidate_rank);

CREATE INDEX job_candidates_job_score_idx
  ON job_candidates (job_id, score DESC, candidate_rank ASC);

CREATE TABLE worker_job_impressions (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  worker_id             UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  job_id                UUID NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  channel               TEXT NOT NULL CHECK (channel IN ('api','whatsapp')),
  impression_window_key TEXT NOT NULL,
  delivered_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX worker_job_impressions_unique_window
  ON worker_job_impressions (worker_id, job_id, impression_window_key);

CREATE INDEX worker_job_impressions_worker_idx
  ON worker_job_impressions (worker_id, delivered_at DESC);

CREATE TABLE worker_match_log (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  event_key  TEXT NOT NULL,
  worker_id  UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  job_id     UUID REFERENCES jobs(id) ON DELETE CASCADE,
  event_type TEXT NOT NULL,
  metadata   JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX worker_match_log_event_key_unique
  ON worker_match_log (event_key);

CREATE INDEX worker_match_log_worker_idx
  ON worker_match_log (worker_id, created_at DESC);

GRANT SELECT, INSERT, UPDATE, DELETE ON job_candidates TO jale_matching;
GRANT SELECT, INSERT, UPDATE, DELETE ON worker_job_impressions TO jale_matching;
GRANT SELECT, INSERT, UPDATE, DELETE ON worker_match_log TO jale_matching;

GRANT SELECT ON job_candidates TO jale_admin;
GRANT SELECT ON worker_job_impressions TO jale_admin;
GRANT SELECT ON worker_match_log TO jale_admin;

ALTER TABLE job_candidates ENABLE ROW LEVEL SECURITY;
ALTER TABLE job_candidates FORCE ROW LEVEL SECURITY;
ALTER TABLE worker_job_impressions ENABLE ROW LEVEL SECURITY;
ALTER TABLE worker_job_impressions FORCE ROW LEVEL SECURITY;
ALTER TABLE worker_match_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE worker_match_log FORCE ROW LEVEL SECURITY;

CREATE POLICY matching_write_candidates ON job_candidates
  FOR ALL TO jale_matching USING (true) WITH CHECK (true);

CREATE POLICY employer_read_candidates ON job_candidates FOR SELECT TO jale_admin
  USING (
    EXISTS (
      SELECT 1 FROM jobs j
      WHERE j.id = job_candidates.job_id
        AND j.employer_id = (
          SELECT id FROM users WHERE cognito_sub = current_setting('app.current_user_id', true)
        )
    )
  );

CREATE POLICY worker_read_impressions ON worker_job_impressions FOR SELECT TO jale_admin
  USING (worker_id = (
    SELECT id FROM users WHERE cognito_sub = current_setting('app.current_user_id', true)
  ));

CREATE POLICY matching_write_impressions ON worker_job_impressions
  FOR ALL TO jale_matching USING (true) WITH CHECK (true);

CREATE POLICY worker_read_match_log ON worker_match_log FOR SELECT TO jale_admin
  USING (worker_id = (
    SELECT id FROM users WHERE cognito_sub = current_setting('app.current_user_id', true)
  ));

CREATE POLICY matching_write_match_log ON worker_match_log
  FOR ALL TO jale_matching USING (true) WITH CHECK (true);
