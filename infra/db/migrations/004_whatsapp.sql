-- ============================================================
-- 004_whatsapp.sql
-- Run manually AFTER 003_jobs_and_applications.sql
-- Connect as: jale_admin (NOT the RDS master user)
--
-- Creates the jale_whatsapp role, whatsapp_conversations table,
-- extends users with profile + WhatsApp columns, and adds
-- role-specific RLS policies for the WhatsApp processor.
--
-- After running this migration, set the jale_whatsapp password:
--   ALTER ROLE jale_whatsapp WITH PASSWORD '<generated>';
-- Then update the jale/whatsapp/db secret in Secrets Manager.
-- ============================================================

-- ── Role ──────────────────────────────────────────────────────
-- jale_whatsapp: dedicated login role for WhatsApp Lambdas.
-- Password is NOT set here — set via ALTER ROLE after migration.
CREATE ROLE jale_whatsapp WITH LOGIN;

-- Job/application/profile access for WhatsApp job alerts and accepts.
GRANT SELECT ON jobs TO jale_whatsapp;
GRANT SELECT, INSERT ON job_applications TO jale_whatsapp;
GRANT SELECT, INSERT, UPDATE ON worker_profiles TO jale_whatsapp;

CREATE POLICY jobs_read_wa ON jobs
    FOR SELECT TO jale_whatsapp USING (true);

CREATE POLICY jobapp_whatsapp_all ON job_applications
    FOR ALL TO jale_whatsapp USING (true) WITH CHECK (true);

CREATE POLICY worker_profiles_whatsapp_all ON worker_profiles
    FOR ALL TO jale_whatsapp
    USING (
        EXISTS (
            SELECT 1 FROM users u
            WHERE u.id = worker_profiles.user_id
              AND u.user_type = 'worker'
        )
    )
    WITH CHECK (
        EXISTS (
            SELECT 1 FROM users u
            WHERE u.id = worker_profiles.user_id
              AND u.user_type = 'worker'
        )
    );

-- ── Users table extensions ────────────────────────────────────
-- WhatsApp linking columns
ALTER TABLE users ADD COLUMN whatsapp_number    VARCHAR(20);
ALTER TABLE users ADD COLUMN whatsapp_linked_at TIMESTAMPTZ;

-- Profile columns (minimum profile for job matching)
ALTER TABLE users ADD COLUMN city               TEXT;
ALTER TABLE users ADD COLUMN main_trade         TEXT
    CHECK (main_trade IN ('electrician','plumber','carpenter',
                          'concrete','painting','other'));
ALTER TABLE users ADD COLUMN main_trade_other   TEXT;
ALTER TABLE users ADD COLUMN years_experience   TEXT
    CHECK (years_experience IN ('0-1','2-4','5-9','10+'));
ALTER TABLE users ADD COLUMN has_transportation BOOLEAN;
ALTER TABLE users ADD COLUMN availability       TEXT
    CHECK (availability IN ('full_time','part_time','weekends','flexible'));

-- If main_trade='other', main_trade_other must be filled
ALTER TABLE users ADD CONSTRAINT chk_trade_other CHECK (
    (main_trade = 'other' AND main_trade_other IS NOT NULL)
    OR (main_trade != 'other')
    OR (main_trade IS NULL)
);

-- Partial unique index: one WhatsApp number per user.
-- Multiple NULLs allowed (users who haven't linked yet).
CREATE UNIQUE INDEX idx_users_whatsapp_number
    ON users(whatsapp_number) WHERE whatsapp_number IS NOT NULL;

-- ── whatsapp_conversations table ──────────────────────────────
CREATE TABLE whatsapp_conversations (
    id                          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id                     UUID REFERENCES users(id),      -- nullable until account linked
    whatsapp_number             VARCHAR(20) NOT NULL UNIQUE,     -- E.164 format
    language                    VARCHAR(2) NOT NULL DEFAULT 'es',-- 'es' or 'en'
    conversation_state          VARCHAR(50) NOT NULL DEFAULT 'new',
    state_context               JSONB DEFAULT '{}',              -- onboarding flow data
    otp_attempts                INTEGER NOT NULL DEFAULT 0,
    otp_expires_at              TIMESTAMPTZ,
    last_processed_message_sid  VARCHAR(50),                     -- Twilio MessageSid for idempotency
    created_at                  TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at                  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_wa_conv_phone ON whatsapp_conversations(whatsapp_number);
CREATE INDEX idx_wa_conv_user  ON whatsapp_conversations(user_id);

-- Auto-update updated_at (reuses the trigger function from 001_initial_schema.sql)
CREATE TRIGGER wa_conversations_updated_at
    BEFORE UPDATE ON whatsapp_conversations
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ── Grants: jale_whatsapp ─────────────────────────────────────
-- whatsapp_conversations: full access
GRANT ALL ON whatsapp_conversations TO jale_whatsapp;

-- users: SELECT for lookups (phone, profile fields, legal status)
GRANT SELECT (id, cognito_sub, phone, whatsapp_number, user_type, full_name,
              city, main_trade, main_trade_other, years_experience,
              has_transportation, availability, tos_version, privacy_version)
    ON users TO jale_whatsapp;

-- users: UPDATE for WhatsApp linking + profile fields + legal columns.
-- Legal columns included because consent uses setRlsContext() (per-user scoped).
GRANT UPDATE (whatsapp_number, whatsapp_linked_at,
              full_name, city, main_trade, main_trade_other,
              years_experience, has_transportation, availability,
              tos_version, tos_accepted_at, privacy_version, privacy_accepted_at)
    ON users TO jale_whatsapp;

-- users: INSERT for defensive new-user provisioning (Door 2).
-- The processor inserts the user row after AdminConfirmSignUp as a safety net
-- in case post-confirmation's DB insert failed silently.
GRANT INSERT ON users TO jale_whatsapp;

-- legal_consent_log: INSERT for consent recording + SELECT for INSERT...SELECT pattern
GRANT INSERT ON legal_consent_log TO jale_whatsapp;
GRANT SELECT ON legal_consent_log TO jale_whatsapp;

-- ── RLS policies ──────────────────────────────────────────────
-- Design note: jale_whatsapp policies on users use USING(true) for SELECT
-- and USING(user_type='worker') for UPDATE/INSERT. These are deliberately
-- broader than jale_admin's per-user policies because the WhatsApp processor
-- needs cross-user access (phone lookup for unidentified callers, linking
-- WhatsApp to a user found by phone number). Compensating controls:
--   - Column-level grants restrict which columns can be touched
--   - user_type='worker' prevents touching employer rows
--   - setRlsContext() is used for consent transactions where per-user scoping is possible

-- whatsapp_conversations: jale_whatsapp gets full access
ALTER TABLE whatsapp_conversations ENABLE ROW LEVEL SECURITY;

CREATE POLICY wa_conv_full ON whatsapp_conversations
    FOR ALL TO jale_whatsapp USING (true);

-- whatsapp_conversations: jale_admin gets user-scoped access via cognito_sub join
CREATE POLICY wa_conv_admin ON whatsapp_conversations
    FOR ALL TO jale_admin
    USING (user_id = (SELECT id FROM users
                      WHERE cognito_sub = current_setting('app.current_user_id', true)));

-- users: jale_whatsapp can SELECT worker rows only (phone lookup during
-- onboarding). Addresses docs/Audit.md Security #7 — a compromised WhatsApp
-- Lambda must not be able to read employer profiles. Aligned with the
-- already-scoped wa_users_update and wa_users_insert policies below.
CREATE POLICY wa_users_read ON users
    FOR SELECT TO jale_whatsapp USING (user_type = 'worker');

-- users: jale_whatsapp can only UPDATE worker rows
CREATE POLICY wa_users_update ON users
    FOR UPDATE TO jale_whatsapp
    USING (user_type = 'worker') WITH CHECK (user_type = 'worker');

-- users: jale_whatsapp can INSERT worker rows (defensive provisioning)
CREATE POLICY wa_users_insert ON users
    FOR INSERT TO jale_whatsapp
    WITH CHECK (user_type = 'worker');

-- legal_consent_log: jale_whatsapp can INSERT + SELECT.
-- Role-specific policies (TO jale_whatsapp) that don't conflict with
-- the existing jale_admin policies in 002_rls_policies.sql.
CREATE POLICY wa_consent_insert ON legal_consent_log
    FOR INSERT TO jale_whatsapp WITH CHECK (true);
CREATE POLICY wa_consent_select ON legal_consent_log
    FOR SELECT TO jale_whatsapp USING (true);

-- ============================================================
-- Reconcile-path grants
--
-- When a worker confirms OTP, reconcileUserRow promotes the placeholder
-- row written during the defensive INSERT:
--   Case A: UPDATE users SET cognito_sub = <real-sub> WHERE cognito_sub = <phone>
--   Case B: DELETE the placeholder if the real user already existed
--
-- GRANT DELETE is table-level; the RLS policy below is what actually
-- restricts which rows jale_whatsapp may delete.
-- ============================================================

GRANT UPDATE (cognito_sub) ON users TO jale_whatsapp;
GRANT DELETE ON users TO jale_whatsapp;

-- Narrow DELETE: only unlinked placeholder rows (cognito_sub = phone AND
-- whatsapp_number IS NULL). A promoted row has whatsapp_number set and is
-- immune. Employer rows are filtered by user_type.
CREATE POLICY wa_users_delete_placeholder ON users
    FOR DELETE TO jale_whatsapp
    USING (
        user_type = 'worker'
        AND cognito_sub = phone
        AND whatsapp_number IS NULL
    );

-- ============================================================
-- whatsapp_processed_messages — atomic MessageSid idempotency
--
-- The processor INSERTs each inbound MessageSid with status='processing'
-- using ON CONFLICT DO NOTHING RETURNING — a losing race returns zero rows
-- and the Lambda skips that message (already claimed by a prior invocation
-- under SQS at-least-once delivery).
-- ============================================================

CREATE TABLE whatsapp_processed_messages (
    message_sid       VARCHAR(50) PRIMARY KEY,
    whatsapp_number   VARCHAR(20) NOT NULL,
    conversation_id   UUID REFERENCES whatsapp_conversations(id) ON DELETE SET NULL,
    status            TEXT NOT NULL DEFAULT 'processing'
                      CHECK (status IN ('processing', 'db_committed', 'completed', 'failed')),
    first_seen_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
    completed_at      TIMESTAMPTZ,
    last_error        TEXT
);

CREATE INDEX idx_wa_processed_number
    ON whatsapp_processed_messages (whatsapp_number, first_seen_at DESC);

GRANT SELECT, INSERT, UPDATE ON whatsapp_processed_messages TO jale_whatsapp;

ALTER TABLE whatsapp_processed_messages ENABLE ROW LEVEL SECURITY;
CREATE POLICY wa_processed_messages_all ON whatsapp_processed_messages
    FOR ALL TO jale_whatsapp
    USING (true) WITH CHECK (true);

-- ============================================================
-- whatsapp_outbox — durable pending replies
--
-- The processor writes intended replies here INSIDE the DB transaction,
-- then sends them via Twilio AFTER commit. A Twilio failure never silently
-- advances state — outbox rows retain status='pending' and can be retried.
-- ============================================================

CREATE TABLE whatsapp_outbox (
    id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    inbound_message_sid  VARCHAR(50) NOT NULL
                         REFERENCES whatsapp_processed_messages(message_sid) ON DELETE CASCADE,
    sequence             INTEGER NOT NULL,
    whatsapp_number      VARCHAR(20) NOT NULL,
    body                 TEXT NOT NULL,
    status               TEXT NOT NULL DEFAULT 'pending'
                         CHECK (status IN ('pending', 'sent', 'failed')),
    twilio_message_sid   TEXT,
    attempt_count        INTEGER NOT NULL DEFAULT 0,
    last_error           TEXT,
    created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
    sent_at              TIMESTAMPTZ,
    UNIQUE (inbound_message_sid, sequence)
);

CREATE INDEX idx_wa_outbox_pending
    ON whatsapp_outbox (status, created_at)
    WHERE status IN ('pending', 'failed');

GRANT SELECT, INSERT, UPDATE ON whatsapp_outbox TO jale_whatsapp;

ALTER TABLE whatsapp_outbox ENABLE ROW LEVEL SECURITY;
CREATE POLICY wa_outbox_all ON whatsapp_outbox
    FOR ALL TO jale_whatsapp
    USING (true) WITH CHECK (true);

-- ============================================================
-- VERIFICATION — run after applying (connect as jale_admin):
--
-- 1. Role exists:
--   SELECT rolname FROM pg_roles WHERE rolname = 'jale_whatsapp';
--
-- 2. Tables exist:
--   \d whatsapp_conversations
--   \d whatsapp_processed_messages
--   \d whatsapp_outbox
--
-- 3. Partial unique index:
--   \di idx_users_whatsapp_number
--
-- 4. CHECK constraint rejects bad values:
--   INSERT INTO users (cognito_sub, user_type, main_trade)
--     VALUES ('test-check', 'worker', 'invalid');  -- must fail
--
-- 5. jale_whatsapp can't UPDATE employer rows:
--   SET ROLE jale_whatsapp;
--   UPDATE users SET full_name='x' WHERE user_type='employer';  -- 0 rows
--   RESET ROLE;
--
-- 6. jale_whatsapp can't SELECT employer rows (Audit Sec #7 fix):
--   SET ROLE jale_whatsapp;
--   SELECT DISTINCT user_type FROM users;  -- should return only 'worker'
--   RESET ROLE;
--
-- 7. wa_users_delete_placeholder only matches unlinked placeholders:
--   SELECT polname, pg_get_expr(polqual, polrelid) FROM pg_policy
--     WHERE polname = 'wa_users_delete_placeholder';
-- ============================================================
