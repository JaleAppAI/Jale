-- 013_ai_matching_contract.sql
-- Contract between AI trust scoring and job matching.
-- Apply after 012_ai_trust_assessment.sql.

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS trade_competency_profession_key TEXT;

COMMENT ON COLUMN users.trade_competency_profession_key IS
  'Normalized profession key that users.trade_competency_score was scored against. Matching treats the score as 0 when this key no longer matches the worker current profession.';

GRANT SELECT (
  id,
  user_type,
  main_trade,
  main_trade_other,
  trust_signals_completed_at,
  trade_competency_score,
  trade_competency_profession_key
) ON users TO jale_matching;

GRANT UPDATE (
  trade_competency_score,
  trade_competency_profession_key
) ON users TO jale_ai;

CREATE OR REPLACE FUNCTION worker_effective_profession_key(
  p_main_trade TEXT,
  p_main_trade_other TEXT
)
RETURNS TEXT
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT CASE
    WHEN p_main_trade IS NULL THEN NULL
    WHEN p_main_trade = 'other' THEN NULLIF(
      regexp_replace(
        regexp_replace(
          lower(translate(
            trim(COALESCE(p_main_trade_other, '')),
            'áàäâãéèëêíìïîóòöôõúùüûñÁÀÄÂÃÉÈËÊÍÌÏÎÓÒÖÔÕÚÙÜÛÑ',
            'aaaaaeeeeiiiiooooouuuunAAAAAEEEEIIIIOOOOOUUUUN'
          )),
          '[-./]',
          ' ',
          'g'
        ),
        '[[:space:]]+',
        ' ',
        'g'
      ),
      ''
    )
    ELSE p_main_trade
  END
$$;

CREATE TABLE IF NOT EXISTS trust_score_rerank_outbox (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  worker_id       UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  reason          TEXT NOT NULL CHECK (reason IN ('trust_score_updated','trust_score_cleared')),
  payload         JSONB NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(payload) = 'object'),
  status          TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','sent','failed')),
  attempts        INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_error      TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  sent_at         TIMESTAMPTZ
);

CREATE UNIQUE INDEX IF NOT EXISTS trust_score_rerank_outbox_one_pending
  ON trust_score_rerank_outbox (worker_id)
  WHERE status = 'pending';

CREATE INDEX IF NOT EXISTS trust_score_rerank_outbox_pending_idx
  ON trust_score_rerank_outbox (status, next_attempt_at, created_at)
  WHERE status IN ('pending','failed');

ALTER TABLE trust_score_rerank_outbox ENABLE ROW LEVEL SECURITY;
ALTER TABLE trust_score_rerank_outbox FORCE ROW LEVEL SECURITY;

GRANT SELECT, INSERT, UPDATE ON trust_score_rerank_outbox TO jale_ai;

CREATE POLICY trust_score_rerank_outbox_ai_all
  ON trust_score_rerank_outbox
  FOR ALL TO jale_ai
  USING (true)
  WITH CHECK (true);

CREATE TABLE IF NOT EXISTS trust_assessment_enqueue_outbox (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  assessment_id   UUID NOT NULL REFERENCES worker_trust_assessments(id) ON DELETE CASCADE,
  worker_id       UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  profession_key  TEXT NOT NULL,
  status          TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','sent','failed')),
  attempts        INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_error      TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  sent_at         TIMESTAMPTZ,
  UNIQUE (assessment_id)
);

CREATE INDEX IF NOT EXISTS trust_assessment_enqueue_pending_idx
  ON trust_assessment_enqueue_outbox (status, next_attempt_at, created_at)
  WHERE status IN ('pending','failed');

ALTER TABLE trust_assessment_enqueue_outbox ENABLE ROW LEVEL SECURITY;
ALTER TABLE trust_assessment_enqueue_outbox FORCE ROW LEVEL SECURITY;

GRANT SELECT, INSERT, UPDATE ON trust_assessment_enqueue_outbox TO jale_whatsapp;

CREATE POLICY trust_assessment_enqueue_whatsapp_all
  ON trust_assessment_enqueue_outbox
  FOR ALL TO jale_whatsapp
  USING (true)
  WITH CHECK (true);
