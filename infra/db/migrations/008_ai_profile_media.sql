-- ============================================================
-- 009_ai_profile_media.sql
-- Run manually AFTER 008_worker_marketplace.sql
-- Connect as: jale_admin (NOT the RDS master user)
-- ============================================================

BEGIN;

-- ── worker_profile_media ─────────────────────────────────────
-- Stores S3 references for WhatsApp onboarding media.
-- Each row is one file (photo or voice message) sent by a worker.
CREATE TABLE worker_profile_media (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id           UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  media_type        TEXT NOT NULL
                      CHECK (media_type IN ('profile_photo', 'work_sample', 'voice_message')),
  s3_key            TEXT NOT NULL,
  twilio_media_sid  TEXT,
  content_type      TEXT NOT NULL,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_worker_profile_media_user_id
  ON worker_profile_media(user_id);

-- ── worker_profile_ai_extractions ────────────────────────────
-- Records one AI extraction attempt per voice message.
-- extracted_fields + confidence_scores are Bedrock JSON output.
-- ai_test_profile marks rows created by the seed script.
CREATE TABLE worker_profile_ai_extractions (
  id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id                 UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  voice_message_media_id  UUID REFERENCES worker_profile_media(id) ON DELETE SET NULL,
  transcript_text         TEXT,
  bedrock_model_id        TEXT NOT NULL,
  extracted_fields        JSONB,
  confidence_scores       JSONB,
  status                  TEXT NOT NULL DEFAULT 'pending'
                            CHECK (status IN ('pending', 'completed', 'failed')),
  ai_test_profile         BOOLEAN NOT NULL DEFAULT FALSE,
  created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at              TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_worker_profile_ai_extractions_user_id
  ON worker_profile_ai_extractions(user_id);

CREATE INDEX IF NOT EXISTS idx_worker_profile_ai_extractions_test
  ON worker_profile_ai_extractions(ai_test_profile)
  WHERE ai_test_profile = TRUE;

CREATE TRIGGER worker_profile_ai_extractions_updated_at
  BEFORE UPDATE ON worker_profile_ai_extractions
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ── RLS policies ─────────────────────────────────────────────
-- jale_whatsapp role: workers can only see their own rows.

ALTER TABLE worker_profile_media ENABLE ROW LEVEL SECURITY;
ALTER TABLE worker_profile_ai_extractions ENABLE ROW LEVEL SECURITY;

-- jale_admin bypasses RLS by default; force policies for it too.
ALTER TABLE worker_profile_media FORCE ROW LEVEL SECURITY;
ALTER TABLE worker_profile_ai_extractions FORCE ROW LEVEL SECURITY;

CREATE POLICY worker_profile_media_self ON worker_profile_media
  FOR ALL
  USING (
    user_id = (
      SELECT id FROM users
      WHERE cognito_sub = current_setting('app.current_user_id', true)
    )
  )
  WITH CHECK (
    user_id = (
      SELECT id FROM users
      WHERE cognito_sub = current_setting('app.current_user_id', true)
    )
  );

CREATE POLICY worker_profile_ai_extractions_self ON worker_profile_ai_extractions
  FOR ALL
  USING (
    user_id = (
      SELECT id FROM users
      WHERE cognito_sub = current_setting('app.current_user_id', true)
    )
  )
  WITH CHECK (
    user_id = (
      SELECT id FROM users
      WHERE cognito_sub = current_setting('app.current_user_id', true)
    )
  );

-- ── Grants for jale_whatsapp role ────────────────────────────
GRANT SELECT, INSERT, UPDATE ON worker_profile_media TO jale_whatsapp;
GRANT SELECT, INSERT, UPDATE ON worker_profile_ai_extractions TO jale_whatsapp;

COMMIT;

-- ============================================================
-- VERIFICATION — run after applying (connect as jale_admin):
--
-- SELECT table_name FROM information_schema.tables
--   WHERE table_name IN ('worker_profile_media', 'worker_profile_ai_extractions');
--
-- SELECT tablename, rowsecurity FROM pg_tables
--   WHERE tablename IN ('worker_profile_media', 'worker_profile_ai_extractions');
--
-- SELECT grantee, table_name, privilege_type
--   FROM information_schema.role_table_grants
--   WHERE table_name IN ('worker_profile_media', 'worker_profile_ai_extractions')
--     AND grantee = 'jale_whatsapp';
-- ============================================================
