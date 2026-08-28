-- ============================================================
-- 083_media_board.sql
-- Run manually AFTER 082_employer_digest_settings.sql
-- Connect as: jale_admin (NOT the RDS master user)
--
-- Media board: worker portfolio posts (1-10 photos + caption).
-- Spec: docs/superpowers/specs/2026-08-22-media-board-design.md (v2)
-- Policy construction follows 020b: SECURITY DEFINER relationship
-- helper, explicit TO on every policy (no-TO policies apply to
-- PUBLIC — the 020b root cause), no raw joins in policy text.
-- ============================================================

BEGIN;

CREATE TABLE worker_posts (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  worker_id   UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  caption     TEXT CHECK (caption IS NULL OR char_length(caption) <= 1000),
  source      TEXT NOT NULL CHECK (source IN ('web', 'whatsapp')),
  status      TEXT NOT NULL DEFAULT 'published'
                CHECK (status IN ('published', 'deleted')),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_worker_posts_worker
  ON worker_posts (worker_id, status, created_at DESC, id DESC);

CREATE TABLE worker_post_media (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  post_id            UUID NOT NULL REFERENCES worker_posts(id) ON DELETE CASCADE,
  -- Denormalized from the post so policies stay FLAT (no join back
  -- through worker_posts under FORCE RLS). Posts are immutable, so
  -- this cannot drift.
  worker_id          UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  s3_key             TEXT NOT NULL,
  -- S3 object version captured at confirm/publish. Pins presigned
  -- GETs and the Rekognition call to the exact moderated bytes
  -- (multi-use presigned PUTs make unversioned keys swappable).
  s3_version_id      TEXT,
  sort_order         SMALLINT NOT NULL,
  content_type       TEXT NOT NULL,
  file_size          BIGINT NOT NULL,
  moderation_status  TEXT NOT NULL
                       CHECK (moderation_status IN ('approved', 'flagged')),
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (post_id, sort_order)
);

CREATE INDEX idx_worker_post_media_worker
  ON worker_post_media (worker_id);

-- ── RLS ─────────────────────────────────────────────────────
ALTER TABLE worker_posts ENABLE ROW LEVEL SECURITY;
ALTER TABLE worker_posts FORCE ROW LEVEL SECURITY;
ALTER TABLE worker_post_media ENABLE ROW LEVEL SECURITY;
ALTER TABLE worker_post_media FORCE ROW LEVEL SECURITY;

-- Worker self, Cognito-sub lane (API handlers before internal-id resolution).
CREATE POLICY worker_posts_self_sub ON worker_posts
  FOR ALL TO jale_admin
  USING (worker_id = (SELECT id FROM users
                      WHERE cognito_sub = current_setting('app.current_user_id', true)))
  WITH CHECK (worker_id = (SELECT id FROM users
                           WHERE cognito_sub = current_setting('app.current_user_id', true)));

-- Worker self, internal-id lane (API after resolution; WhatsApp processor).
CREATE POLICY worker_posts_self_internal ON worker_posts
  FOR ALL TO jale_admin, jale_whatsapp
  USING (worker_id::text = current_setting('app.current_internal_user_id', true))
  WITH CHECK (worker_id::text = current_setting('app.current_internal_user_id', true));

-- Employer read: relationship via the 020b SECURITY DEFINER helper.
-- Visibility filters live IN the policy: a handler bug can never
-- serve a deleted post to an employer.
CREATE POLICY worker_posts_employer_select ON worker_posts
  FOR SELECT TO jale_admin
  USING (
    status = 'published'
    AND jale_internal.employer_has_applicant_relationship(
          current_setting('app.current_internal_user_id', true), worker_id)
  );

CREATE POLICY worker_post_media_self_sub ON worker_post_media
  FOR ALL TO jale_admin
  USING (worker_id = (SELECT id FROM users
                      WHERE cognito_sub = current_setting('app.current_user_id', true)))
  WITH CHECK (worker_id = (SELECT id FROM users
                           WHERE cognito_sub = current_setting('app.current_user_id', true)));

CREATE POLICY worker_post_media_self_internal ON worker_post_media
  FOR ALL TO jale_admin, jale_whatsapp
  USING (worker_id::text = current_setting('app.current_internal_user_id', true))
  WITH CHECK (worker_id::text = current_setting('app.current_internal_user_id', true));

-- Employer read: approved media only, published parent only, in-policy.
CREATE POLICY worker_post_media_employer_select ON worker_post_media
  FOR SELECT TO jale_admin
  USING (
    moderation_status = 'approved'
    AND jale_internal.employer_has_applicant_relationship(
          current_setting('app.current_internal_user_id', true), worker_id)
    AND EXISTS (SELECT 1 FROM worker_posts p
                WHERE p.id = worker_post_media.post_id
                  AND p.status = 'published')
  );

-- 083 also touches the pre-existing worker_profile_media table (011).
-- The WhatsApp post lane's profile-photo branch INSERTs into
-- worker_profile_media under app.current_internal_user_id (the internal-id
-- lane), but 011's only policy (worker_profile_media_self) checks
-- app.current_user_id (the Cognito-sub lane) with no TO clause. A
-- jale_whatsapp session on the internal-id lane resolves
-- current_setting('app.current_user_id', true) to NULL, so that policy's
-- USING/WITH CHECK are never satisfied and the INSERT fails RLS (42501) on
-- real Postgres — 011's grants (SELECT/INSERT/UPDATE TO jale_whatsapp,
-- already in place) are necessary but not sufficient without a policy that
-- evaluates true for jale_whatsapp sessions. This adds that policy,
-- mirroring 083's own worker_posts_self_internal /
-- worker_post_media_self_internal shape (and 066/081's precedent for the
-- same self/internal-lane split on other tables), with an explicit TO
-- clause per 083's own rule.
CREATE POLICY worker_profile_media_self_internal ON worker_profile_media
  FOR ALL TO jale_whatsapp
  USING (user_id::text = current_setting('app.current_internal_user_id', true))
  WITH CHECK (user_id::text = current_setting('app.current_internal_user_id', true));

-- ── Grants ───────────────────────────────────────────────────
-- jale_admin = API lane; jale_whatsapp = processor lane.
-- jale_whatsapp UPDATE on worker_posts is REQUIRED: the WhatsApp
-- delete-last-post flow soft-deletes (Ivan, 2026-08-22).
GRANT SELECT, INSERT, UPDATE ON worker_posts TO jale_admin;
GRANT SELECT, INSERT ON worker_post_media TO jale_admin;
GRANT SELECT, INSERT, UPDATE ON worker_posts TO jale_whatsapp;
GRANT SELECT, INSERT ON worker_post_media TO jale_whatsapp;

COMMIT;

-- ============================================================
-- VERIFICATION — run after applying (connect as jale_admin):
--
-- SELECT tablename, rowsecurity FROM pg_tables
--   WHERE tablename IN ('worker_posts', 'worker_post_media');
--
-- SELECT policyname, tablename, roles FROM pg_policies
--   WHERE tablename IN ('worker_posts', 'worker_post_media', 'worker_profile_media');
--   -- every row's roles must name jale_admin and/or jale_whatsapp,
--   -- never {public} — this now also covers the new
--   -- worker_profile_media_self_internal policy (TO jale_whatsapp only;
--   -- 011's original worker_profile_media_self policy remains TO PUBLIC,
--   -- unchanged, covering the Cognito-sub lane).
--
-- SELECT grantee, table_name, privilege_type
--   FROM information_schema.role_table_grants
--   WHERE table_name IN ('worker_posts', 'worker_post_media')
--     AND grantee IN ('jale_admin', 'jale_whatsapp');
--
-- Recursion smoke (must not raise 42P17):
-- SET app.current_internal_user_id = '00000000-0000-4000-8000-000000000000';
-- SELECT count(*) FROM worker_posts; SELECT count(*) FROM worker_post_media;
-- ============================================================
