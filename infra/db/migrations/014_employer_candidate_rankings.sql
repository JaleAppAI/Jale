-- ============================================================
-- 014_employer_candidate_rankings.sql
-- Run manually AFTER 013_whatsapp_template_outbox.sql
-- Connect as: jale_admin
-- ============================================================

-- Employer candidate reranking reads only applied workers. The matching role
-- needs narrow read access to applications plus denormalized worker trust score.
GRANT SELECT ON job_applications TO jale_matching;
GRANT SELECT (id, user_type, full_name, phone, main_trade, main_trade_other, years_experience, availability, city, trade_competency_score)
  ON users TO jale_matching;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'job_applications'
      AND policyname = 'applications_matching_read'
  ) THEN
    CREATE POLICY applications_matching_read
      ON job_applications FOR SELECT TO jale_matching
      USING (true);
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS employer_candidate_rankings (
  job_id UUID NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  worker_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  application_id UUID NOT NULL REFERENCES job_applications(id) ON DELETE CASCADE,
  rank INTEGER NOT NULL CHECK (rank > 0),
  score SMALLINT NOT NULL CHECK (score BETWEEN 0 AND 100),
  score_band TEXT NOT NULL CHECK (score_band IN ('strong','good','fair')),
  reasons JSONB NOT NULL DEFAULT '[]',
  ranking_version TEXT NOT NULL,
  model_id TEXT,
  source_hash TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'ready' CHECK (status IN ('ready','failed')),
  computed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (job_id, worker_id)
);

CREATE INDEX IF NOT EXISTS employer_candidate_rankings_job_rank_idx
  ON employer_candidate_rankings (job_id, rank ASC, computed_at DESC);

CREATE INDEX IF NOT EXISTS employer_candidate_rankings_job_hash_idx
  ON employer_candidate_rankings (job_id, source_hash);

GRANT SELECT, INSERT, UPDATE, DELETE ON employer_candidate_rankings TO jale_matching;
GRANT SELECT ON employer_candidate_rankings TO jale_admin;

ALTER TABLE employer_candidate_rankings ENABLE ROW LEVEL SECURITY;
ALTER TABLE employer_candidate_rankings FORCE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'employer_candidate_rankings'
      AND policyname = 'employer_candidate_rankings_matching_all'
  ) THEN
    CREATE POLICY employer_candidate_rankings_matching_all
      ON employer_candidate_rankings
      FOR ALL TO jale_matching
      USING (true)
      WITH CHECK (true);
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'employer_candidate_rankings'
      AND policyname = 'employer_candidate_rankings_employer_read'
  ) THEN
    CREATE POLICY employer_candidate_rankings_employer_read
      ON employer_candidate_rankings
      FOR SELECT TO jale_admin
      USING (
        EXISTS (
          SELECT 1
          FROM jobs j
          WHERE j.id = employer_candidate_rankings.job_id
            AND j.employer_id = (
              SELECT id
              FROM users
              WHERE cognito_sub = current_setting('app.current_user_id', true)
            )
        )
      );
  END IF;
END $$;
