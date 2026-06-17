-- ============================================================
-- 027_admin_security_hardening.sql
-- Revocable admin application sessions.
-- Connect as: jale_admin (NOT the RDS master user)
-- ============================================================

BEGIN;

CREATE TABLE IF NOT EXISTS admin_sessions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  token_hash CHAR(64) NOT NULL UNIQUE,
  admin_user_id UUID NOT NULL REFERENCES admin_users(id) ON DELETE CASCADE,
  cognito_jti TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at TIMESTAMPTZ NOT NULL,
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  revoked_at TIMESTAMPTZ,
  revoke_reason TEXT,
  user_agent_hash CHAR(64)
);

CREATE INDEX IF NOT EXISTS idx_admin_sessions_active_lookup
  ON admin_sessions (token_hash, expires_at)
  WHERE revoked_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_admin_sessions_admin_user
  ON admin_sessions (admin_user_id, expires_at DESC);

ALTER TABLE admin_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE admin_sessions FORCE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policy
     WHERE polname = 'admin_sessions_service_all'
       AND polrelid = 'public.admin_sessions'::regclass
  ) THEN
    CREATE POLICY admin_sessions_service_all ON admin_sessions
      FOR ALL TO jale_admin USING (true) WITH CHECK (true);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_policy
     WHERE polname = 'admin_sessions_console_select'
       AND polrelid = 'public.admin_sessions'::regclass
  ) THEN
    CREATE POLICY admin_sessions_console_select ON admin_sessions
      FOR SELECT TO jale_admin_console USING (true);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_policy
     WHERE polname = 'admin_sessions_console_insert'
       AND polrelid = 'public.admin_sessions'::regclass
  ) THEN
    CREATE POLICY admin_sessions_console_insert ON admin_sessions
      FOR INSERT TO jale_admin_console WITH CHECK (true);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_policy
     WHERE polname = 'admin_sessions_console_update'
       AND polrelid = 'public.admin_sessions'::regclass
  ) THEN
    CREATE POLICY admin_sessions_console_update ON admin_sessions
      FOR UPDATE TO jale_admin_console USING (true) WITH CHECK (true);
  END IF;
END;
$$;

GRANT SELECT, INSERT, UPDATE, DELETE ON admin_sessions TO jale_admin;
GRANT SELECT, INSERT, UPDATE ON admin_sessions TO jale_admin_console;

ALTER TABLE whatsapp_outbox
  ALTER COLUMN inbound_message_sid DROP NOT NULL,
  ADD COLUMN IF NOT EXISTS source_type TEXT,
  ADD COLUMN IF NOT EXISTS source_id UUID,
  ADD COLUMN IF NOT EXISTS idempotency_key TEXT;

ALTER TABLE whatsapp_outbox DROP CONSTRAINT IF EXISTS whatsapp_outbox_status_check;
ALTER TABLE whatsapp_outbox
  ADD CONSTRAINT whatsapp_outbox_status_check
  CHECK (status IN ('pending', 'sent', 'failed', 'send_unknown'));

CREATE UNIQUE INDEX IF NOT EXISTS idx_whatsapp_outbox_idempotency
  ON whatsapp_outbox (idempotency_key)
  WHERE idempotency_key IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_whatsapp_outbox_admin_pending
  ON whatsapp_outbox (created_at)
  WHERE source_type = 'admin_case' AND status IN ('pending', 'failed');

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'whatsapp_outbox_origin_check'
       AND conrelid = 'public.whatsapp_outbox'::regclass
  ) THEN
    ALTER TABLE whatsapp_outbox
      ADD CONSTRAINT whatsapp_outbox_origin_check CHECK (
        (inbound_message_sid IS NOT NULL AND source_type IS NULL AND source_id IS NULL)
        OR
        (inbound_message_sid IS NULL AND source_type = 'admin_case' AND source_id IS NOT NULL)
      );
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_policy
     WHERE polname = 'whatsapp_outbox_console_select'
       AND polrelid = 'public.whatsapp_outbox'::regclass
  ) THEN
    CREATE POLICY whatsapp_outbox_console_select ON whatsapp_outbox
      FOR SELECT TO jale_admin_console USING (source_type = 'admin_case');
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_policy
     WHERE polname = 'whatsapp_outbox_console_insert'
       AND polrelid = 'public.whatsapp_outbox'::regclass
  ) THEN
    CREATE POLICY whatsapp_outbox_console_insert ON whatsapp_outbox
      FOR INSERT TO jale_admin_console
      WITH CHECK (
        inbound_message_sid IS NULL
        AND source_type = 'admin_case'
        AND source_id IS NOT NULL
        AND idempotency_key IS NOT NULL
      );
  END IF;
END;
$$;

GRANT SELECT, INSERT ON whatsapp_outbox TO jale_admin_console;

CREATE OR REPLACE FUNCTION record_admin_whatsapp_delivery(
  p_outbox_id UUID,
  p_status TEXT,
  p_twilio_message_sid TEXT,
  p_error TEXT
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_case_id UUID;
  v_body TEXT;
BEGIN
  IF p_status NOT IN ('sent', 'failed', 'send_unknown') THEN
    RAISE EXCEPTION 'invalid admin WhatsApp delivery status';
  END IF;

  SELECT source_id, body
    INTO v_case_id, v_body
    FROM whatsapp_outbox
   WHERE id = p_outbox_id
     AND source_type = 'admin_case';

  IF v_case_id IS NULL THEN
    RAISE EXCEPTION 'admin WhatsApp outbox row not found';
  END IF;

  INSERT INTO admin_case_events (case_id, event_type, actor_type, actor_id, payload)
  VALUES (
    v_case_id,
    CASE
      WHEN p_status = 'sent' THEN 'admin_reply_sent'
      WHEN p_status = 'send_unknown' THEN 'admin_reply_send_unknown'
      ELSE 'admin_reply_failed'
    END,
    'system',
    'twilio',
    jsonb_build_object(
      'title', CASE
        WHEN p_status = 'sent' THEN 'WhatsApp reply sent'
        WHEN p_status = 'send_unknown' THEN 'WhatsApp delivery state unknown'
        ELSE 'WhatsApp reply failed'
      END,
      'detail', COALESCE(p_error, v_body),
      'twilioMessageSid', p_twilio_message_sid,
      'outboxId', p_outbox_id
    )
  );

  IF p_status = 'sent' THEN
    UPDATE admin_cases
       SET details = details || jsonb_build_object('lastOutboundTwilioSid', p_twilio_message_sid),
           updated_at = NOW()
     WHERE id = v_case_id;
  END IF;
END;
$$;

REVOKE ALL ON FUNCTION record_admin_whatsapp_delivery(UUID, TEXT, TEXT, TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION record_admin_whatsapp_delivery(UUID, TEXT, TEXT, TEXT) TO jale_whatsapp;

CREATE OR REPLACE FUNCTION reconcile_worker_signup(
  p_cognito_sub TEXT,
  p_phone TEXT,
  p_full_name TEXT
)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_real_id UUID;
  v_placeholder_id UUID;
  v_user_id UUID;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended(p_phone, 0));
  PERFORM set_config('app.worker_reconcile_sub', p_cognito_sub, true);
  PERFORM set_config('app.worker_reconcile_phone', p_phone, true);

  SELECT id
    INTO v_real_id
    FROM users
   WHERE cognito_sub = p_cognito_sub
     AND user_type = 'worker'
   FOR UPDATE;

  SELECT id
    INTO v_placeholder_id
    FROM users
   WHERE cognito_sub = p_phone
     AND phone = p_phone
     AND user_type = 'worker'
   FOR UPDATE;

  IF v_real_id IS NOT NULL
     AND v_placeholder_id IS NOT NULL
     AND v_real_id <> v_placeholder_id THEN
    RAISE EXCEPTION 'worker identity requires manual merge'
      USING ERRCODE = '23505';
  END IF;

  IF v_placeholder_id IS NOT NULL THEN
    UPDATE users
       SET cognito_sub = p_cognito_sub,
           phone = p_phone,
           full_name = COALESCE(NULLIF(p_full_name, ''), full_name)
     WHERE id = v_placeholder_id
     RETURNING id INTO v_user_id;
  ELSIF v_real_id IS NOT NULL THEN
    UPDATE users
       SET phone = p_phone,
           full_name = COALESCE(NULLIF(p_full_name, ''), full_name)
     WHERE id = v_real_id
     RETURNING id INTO v_user_id;
  ELSE
    INSERT INTO users (cognito_sub, user_type, phone, full_name)
    VALUES (p_cognito_sub, 'worker', p_phone, NULLIF(p_full_name, ''))
    RETURNING id INTO v_user_id;
  END IF;

  RETURN v_user_id;
END;
$$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policy
     WHERE polname = 'users_worker_reconcile'
       AND polrelid = 'public.users'::regclass
  ) THEN
    CREATE POLICY users_worker_reconcile ON users
      FOR ALL TO jale_admin
      USING (
        user_type = 'worker'
        AND cognito_sub IN (
          current_setting('app.worker_reconcile_sub', true),
          current_setting('app.worker_reconcile_phone', true)
        )
      )
      WITH CHECK (
        user_type = 'worker'
        AND cognito_sub IN (
          current_setting('app.worker_reconcile_sub', true),
          current_setting('app.worker_reconcile_phone', true)
        )
      );
  END IF;
END;
$$;

REVOKE ALL ON FUNCTION reconcile_worker_signup(TEXT, TEXT, TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION reconcile_worker_signup(TEXT, TEXT, TEXT) TO jale_admin;
GRANT EXECUTE ON FUNCTION reconcile_worker_signup(TEXT, TEXT, TEXT) TO jale_whatsapp;

COMMIT;
