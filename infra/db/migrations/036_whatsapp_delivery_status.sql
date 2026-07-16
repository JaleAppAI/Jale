-- ============================================================
-- 036_whatsapp_delivery_status.sql
-- Durable Twilio delivery lifecycle for WhatsApp outbox sends.
-- Connect as: jale_admin (NOT the RDS master user)
-- ============================================================

BEGIN;

-- A NOLOGIN definer role lets callback functions cross forced RLS without
-- granting the callback Lambda direct table access. Only the signed callback
-- entry point is executable by jale_whatsapp.
DO $$
BEGIN
  CREATE ROLE jale_twilio_callback
    NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS;
EXCEPTION WHEN duplicate_object THEN
  NULL;
END;
$$;
ALTER ROLE jale_twilio_callback
  NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS;
DO $$
BEGIN
  EXECUTE format(
    'GRANT jale_twilio_callback TO %I WITH ADMIN OPTION, SET TRUE, INHERIT FALSE',
    current_user
  );
END;
$$;
CREATE SCHEMA IF NOT EXISTS jale_twilio_callback;
ALTER SCHEMA jale_twilio_callback OWNER TO jale_twilio_callback;
REVOKE ALL ON SCHEMA jale_twilio_callback FROM PUBLIC;
DO $$ BEGIN
  EXECUTE format('GRANT USAGE, CREATE ON SCHEMA jale_twilio_callback TO %I', current_user);
END $$;

ALTER TABLE whatsapp_outbox
  ADD COLUMN IF NOT EXISTS twilio_delivery_status TEXT,
  ADD COLUMN IF NOT EXISTS twilio_error_code TEXT,
  ADD COLUMN IF NOT EXISTS twilio_error_message TEXT,
  ADD COLUMN IF NOT EXISTS twilio_status_updated_at TIMESTAMPTZ;

ALTER TABLE whatsapp_outbox DROP CONSTRAINT IF EXISTS whatsapp_outbox_twilio_delivery_status_check;
ALTER TABLE whatsapp_outbox
  ADD CONSTRAINT whatsapp_outbox_twilio_delivery_status_check
  CHECK (
    twilio_delivery_status IS NULL
    OR twilio_delivery_status IN (
      'queued', 'accepted', 'sent', 'delivered', 'read', 'undelivered', 'failed'
    )
  );

CREATE UNIQUE INDEX IF NOT EXISTS idx_whatsapp_outbox_twilio_message_sid
  ON whatsapp_outbox (twilio_message_sid)
  WHERE twilio_message_sid IS NOT NULL;

REVOKE ALL ON public.job_conversation_messages FROM jale_twilio_callback;
GRANT SELECT (twilio_message_sid, status, sent_at, delivered_at),
      UPDATE (status, sent_at, delivered_at)
  ON public.job_conversation_messages TO jale_twilio_callback;
DROP POLICY IF EXISTS job_messages_twilio_callback ON public.job_conversation_messages;
DROP POLICY IF EXISTS job_messages_twilio_callback_select ON public.job_conversation_messages;
DROP POLICY IF EXISTS job_messages_twilio_callback_update ON public.job_conversation_messages;
CREATE POLICY job_messages_twilio_callback_select ON public.job_conversation_messages
  FOR SELECT TO jale_twilio_callback USING (true);
CREATE POLICY job_messages_twilio_callback_update ON public.job_conversation_messages
  FOR UPDATE TO jale_twilio_callback USING (true) WITH CHECK (true);

-- Preserve migration 028's public signature and grants while hardening its
-- definer, qualifications, and catalog-only search path.
CREATE OR REPLACE FUNCTION public.record_twilio_status(
    p_sid TEXT, p_status TEXT, p_at TIMESTAMPTZ
) RETURNS BOOLEAN
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE v_updated INTEGER;
BEGIN
  IF p_status NOT IN ('sent', 'delivered', 'read', 'failed', 'undelivered') THEN
    RETURN false;
  END IF;
  UPDATE public.job_conversation_messages
     SET status = p_status,
         sent_at = CASE WHEN p_status = 'sent' THEN COALESCE(sent_at, p_at) ELSE sent_at END,
         delivered_at = CASE WHEN p_status = 'delivered' THEN COALESCE(delivered_at, p_at) ELSE delivered_at END
   WHERE twilio_message_sid = p_sid
     AND status NOT IN ('received', 'failed', 'undelivered')
     AND ((p_status = 'sent' AND status IN ('queued', 'waiting_worker_reply'))
       OR (p_status = 'delivered' AND status IN ('queued', 'waiting_worker_reply', 'sent'))
       OR (p_status = 'read' AND status IN ('queued', 'waiting_worker_reply', 'sent', 'delivered'))
       OR (p_status IN ('failed', 'undelivered') AND status IN ('queued', 'waiting_worker_reply', 'sent')));
  GET DIAGNOSTICS v_updated = ROW_COUNT;
  RETURN v_updated > 0;
END $$;
ALTER FUNCTION public.record_twilio_status(TEXT, TEXT, TIMESTAMPTZ)
  OWNER TO jale_twilio_callback;
REVOKE ALL ON FUNCTION public.record_twilio_status(TEXT, TEXT, TIMESTAMPTZ) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.record_twilio_status(TEXT, TEXT, TIMESTAMPTZ)
  TO jale_whatsapp, jale_admin;

-- Job alerts now use the same durable outbox. Preserve the original inbound
-- and admin-case origins while allowing one idempotent row per job/worker.
ALTER TABLE whatsapp_outbox DROP CONSTRAINT IF EXISTS whatsapp_outbox_origin_check;
ALTER TABLE whatsapp_outbox
  ADD CONSTRAINT whatsapp_outbox_origin_check CHECK (
    (inbound_message_sid IS NOT NULL AND source_type IS NULL AND source_id IS NULL)
    OR
    (inbound_message_sid IS NULL AND source_type IN ('admin_case', 'job_alert') AND source_id IS NOT NULL)
  );

CREATE OR REPLACE FUNCTION record_whatsapp_delivery_status(
  p_twilio_message_sid TEXT,
  p_message_status TEXT,
  p_error_code TEXT,
  p_error_message TEXT
)
RETURNS TABLE (matched BOOLEAN, changed BOOLEAN)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_outbox_id UUID;
  v_source_type TEXT;
  v_source_id UUID;
  v_previous_status TEXT;
  v_status TEXT := LOWER(BTRIM(p_message_status));
  v_error_code TEXT := NULLIF(BTRIM(p_error_code), '');
  v_error_message TEXT := NULLIF(BTRIM(p_error_message), '');
  v_transition_allowed BOOLEAN := false;
BEGIN
  IF p_twilio_message_sid IS NULL
     OR p_twilio_message_sid !~ '^SM[0-9A-Fa-f]{32}$' THEN
    RAISE EXCEPTION 'invalid Twilio message SID' USING ERRCODE = '22023';
  END IF;
  IF v_status IS NULL OR v_status NOT IN (
    'queued', 'accepted', 'sent', 'delivered', 'read', 'undelivered', 'failed'
  ) THEN
    RAISE EXCEPTION 'invalid Twilio delivery status' USING ERRCODE = '22023';
  END IF;
  IF v_error_code IS NOT NULL
     AND (v_error_code !~ '^[0-9]{1,10}$') THEN
    RAISE EXCEPTION 'invalid Twilio error code' USING ERRCODE = '22023';
  END IF;
  IF v_error_message IS NOT NULL AND CHAR_LENGTH(v_error_message) > 1000 THEN
    RAISE EXCEPTION 'Twilio error message too long' USING ERRCODE = '22001';
  END IF;

  SELECT o.id, o.source_type, o.source_id, o.twilio_delivery_status
    INTO v_outbox_id, v_source_type, v_source_id, v_previous_status
    FROM whatsapp_outbox o
   WHERE o.twilio_message_sid = p_twilio_message_sid
   FOR UPDATE;

  IF v_outbox_id IS NULL THEN
    RETURN QUERY SELECT false, false;
    RETURN;
  END IF;

  v_transition_allowed := CASE
    WHEN v_previous_status IS NULL THEN true
    WHEN v_previous_status IN ('failed', 'undelivered', 'read') THEN false
    WHEN v_status = v_previous_status THEN false
    WHEN v_status = 'queued' THEN false
    WHEN v_status = 'accepted' THEN v_previous_status = 'queued'
    WHEN v_status = 'sent' THEN v_previous_status IN ('queued', 'accepted')
    WHEN v_status = 'delivered' THEN v_previous_status IN ('queued', 'accepted', 'sent')
    WHEN v_status = 'read' THEN v_previous_status IN ('queued', 'accepted', 'sent', 'delivered')
    WHEN v_status IN ('failed', 'undelivered')
      THEN v_previous_status IN ('queued', 'accepted', 'sent')
    ELSE false
  END;

  IF NOT v_transition_allowed THEN
    RETURN QUERY SELECT true, false;
    RETURN;
  END IF;

  UPDATE whatsapp_outbox
     SET twilio_delivery_status = v_status,
         twilio_error_code = v_error_code,
         twilio_error_message = v_error_message,
         twilio_status_updated_at = clock_timestamp(),
         last_error = CASE
           WHEN v_status IN ('failed', 'undelivered')
             THEN COALESCE(v_error_message, v_error_code, last_error)
           ELSE last_error
         END
   WHERE id = v_outbox_id;

  IF v_source_type = 'admin_case'
     AND v_source_id IS NOT NULL
     AND v_status IN ('delivered', 'read', 'undelivered', 'failed') THEN
    INSERT INTO admin_case_events (case_id, event_type, actor_type, actor_id, payload)
    VALUES (
      v_source_id,
      CASE
        WHEN v_status IN ('undelivered', 'failed') THEN 'admin_reply_delivery_failed'
        WHEN v_status = 'read' THEN 'admin_reply_read'
        ELSE 'admin_reply_delivered'
      END,
      'system',
      'twilio',
      jsonb_build_object(
        'title', CASE
          WHEN v_status IN ('undelivered', 'failed') THEN 'WhatsApp reply delivery failed'
          WHEN v_status = 'read' THEN 'WhatsApp reply read'
          ELSE 'WhatsApp reply delivered'
        END,
        'detail', COALESCE(v_error_message, v_error_code, v_status),
        'twilioMessageSid', p_twilio_message_sid,
        'twilioStatus', v_status,
        'twilioErrorCode', v_error_code,
        'twilioErrorMessage', v_error_message,
        'outboxId', v_outbox_id
      )
    );

    UPDATE admin_cases
       SET details = details || jsonb_build_object(
             'lastOutboundTwilioSid', p_twilio_message_sid,
             'lastOutboundTwilioStatus', v_status,
             'lastOutboundTwilioErrorCode', v_error_code,
             'lastOutboundTwilioErrorMessage', v_error_message
           ),
           updated_at = NOW()
     WHERE id = v_source_id;
  END IF;

  RETURN QUERY SELECT true, true;
END;
$$;

ALTER FUNCTION record_whatsapp_delivery_status(TEXT, TEXT, TEXT, TEXT) OWNER TO jale_admin;
REVOKE ALL ON FUNCTION record_whatsapp_delivery_status(TEXT, TEXT, TEXT, TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION record_whatsapp_delivery_status(TEXT, TEXT, TEXT, TEXT) TO jale_whatsapp;
GRANT EXECUTE ON FUNCTION record_whatsapp_delivery_status(TEXT, TEXT, TEXT, TEXT)
  TO jale_twilio_callback;

-- One callback entry point dispatches to both durable outbound stores. The
-- job-message writer introduced in migration 028 updates its message record;
-- all processor/admin/job-alert sends are correlated through whatsapp_outbox.
DROP FUNCTION IF EXISTS public.record_twilio_delivery_status(TEXT, TEXT, TEXT, TEXT);
CREATE OR REPLACE FUNCTION jale_twilio_callback.record_twilio_delivery_status(
  p_twilio_message_sid TEXT,
  p_message_status TEXT,
  p_error_code TEXT,
  p_error_message TEXT
)
RETURNS TABLE (matched BOOLEAN, changed BOOLEAN, source TEXT)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_whatsapp RECORD;
  v_job_matched BOOLEAN;
  v_job_changed BOOLEAN := false;
  v_status TEXT := LOWER(BTRIM(p_message_status));
BEGIN
  SELECT * INTO v_whatsapp
    FROM public.record_whatsapp_delivery_status(
      p_twilio_message_sid, p_message_status, p_error_code, p_error_message
    );
  IF v_whatsapp.matched THEN
    RETURN QUERY SELECT true, v_whatsapp.changed, 'whatsapp_outbox'::TEXT;
    RETURN;
  END IF;

  SELECT EXISTS (
    SELECT 1 FROM public.job_conversation_messages
     WHERE twilio_message_sid = p_twilio_message_sid
  ) INTO v_job_matched;
  IF v_job_matched AND v_status IN ('sent', 'delivered', 'read', 'failed', 'undelivered') THEN
    SELECT public.record_twilio_status(p_twilio_message_sid, v_status, pg_catalog.clock_timestamp())
      INTO v_job_changed;
  END IF;
  RETURN QUERY SELECT v_job_matched, v_job_changed,
    CASE WHEN v_job_matched THEN 'job_message_outbox'::TEXT ELSE NULL::TEXT END;
END;
$$;

ALTER FUNCTION jale_twilio_callback.record_twilio_delivery_status(TEXT, TEXT, TEXT, TEXT)
  OWNER TO jale_twilio_callback;
REVOKE ALL ON FUNCTION jale_twilio_callback.record_twilio_delivery_status(TEXT, TEXT, TEXT, TEXT) FROM PUBLIC;
GRANT USAGE ON SCHEMA jale_twilio_callback TO jale_whatsapp;
GRANT EXECUTE ON FUNCTION jale_twilio_callback.record_twilio_delivery_status(TEXT, TEXT, TEXT, TEXT)
  TO jale_whatsapp;

-- Dispatch status remains `sent` for compatibility, but its timeline title
-- must not imply final delivery before an asynchronous Twilio callback.
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
  SELECT source_id, body INTO v_case_id, v_body
    FROM whatsapp_outbox
   WHERE id = p_outbox_id AND source_type = 'admin_case';
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
        WHEN p_status = 'sent' THEN 'WhatsApp reply accepted by Twilio'
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

ALTER FUNCTION record_admin_whatsapp_delivery(UUID, TEXT, TEXT, TEXT) OWNER TO jale_admin;
REVOKE ALL ON FUNCTION record_admin_whatsapp_delivery(UUID, TEXT, TEXT, TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION record_admin_whatsapp_delivery(UUID, TEXT, TEXT, TEXT) TO jale_whatsapp;

-- Remove the temporary migration-time SET capability. PostgreSQL 16 retains
-- the creator's ADMIN membership row, but it must be SET=false/INHERIT=false.
DO $$
BEGIN
  EXECUTE format('REVOKE ALL ON SCHEMA jale_twilio_callback FROM %I', current_user);
  EXECUTE format('REVOKE SET OPTION FOR jale_twilio_callback FROM %I', current_user);
END;
$$;

-- Fail closed if any helper-role, ACL, ownership, policy, or function setting
-- drifts while this rerunnable migration is being maintained.
DO $$
DECLARE v_creator OID := (SELECT oid FROM pg_catalog.pg_roles WHERE rolname = current_user);
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_roles
     WHERE rolname = 'jale_twilio_callback'
       AND NOT rolcanlogin AND NOT rolsuper AND NOT rolcreatedb
       AND NOT rolcreaterole AND NOT rolinherit AND NOT rolreplication
       AND NOT rolbypassrls
  ) THEN RAISE EXCEPTION 'jale_twilio_callback role attributes are unsafe'; END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_auth_members m
     JOIN pg_catalog.pg_roles r ON r.oid = m.roleid
    WHERE r.rolname = 'jale_twilio_callback' AND m.member = v_creator
      AND m.admin_option AND NOT m.set_option AND NOT m.inherit_option
  ) THEN RAISE EXCEPTION 'jale_twilio_callback creator membership is unsafe'; END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_namespace n
     JOIN pg_catalog.pg_roles r ON r.oid = n.nspowner
    WHERE n.nspname = 'jale_twilio_callback' AND r.rolname = 'jale_twilio_callback'
      AND NOT pg_catalog.has_schema_privilege('public', n.oid, 'USAGE')
  ) THEN RAISE EXCEPTION 'jale_twilio_callback schema ACL/owner drift'; END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_proc p
     JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
     JOIN pg_catalog.pg_roles r ON r.oid = p.proowner
    WHERE n.nspname = 'jale_twilio_callback'
      AND p.proname = 'record_twilio_delivery_status'
      AND r.rolname = 'jale_twilio_callback'
      AND p.prosecdef
      AND p.proconfig @> ARRAY['search_path=pg_catalog, pg_temp']
  ) THEN RAISE EXCEPTION 'unified callback function hardening drift'; END IF;

  IF (SELECT count(*) FROM pg_catalog.pg_policies
       WHERE schemaname = 'public' AND tablename = 'job_conversation_messages'
         AND policyname IN ('job_messages_twilio_callback_select',
                            'job_messages_twilio_callback_update')) <> 2
  THEN RAISE EXCEPTION 'Twilio callback RLS policies missing'; END IF;

  IF pg_catalog.has_table_privilege('jale_twilio_callback',
       'public.job_conversation_messages', 'SELECT')
     OR NOT pg_catalog.has_column_privilege('jale_twilio_callback',
       'public.job_conversation_messages', 'twilio_message_sid', 'SELECT')
  THEN RAISE EXCEPTION 'Twilio callback table/column ACL drift'; END IF;

  IF pg_catalog.has_function_privilege('public',
       'jale_twilio_callback.record_twilio_delivery_status(text,text,text,text)', 'EXECUTE')
     OR NOT pg_catalog.has_function_privilege('jale_whatsapp',
       'jale_twilio_callback.record_twilio_delivery_status(text,text,text,text)', 'EXECUTE')
  THEN RAISE EXCEPTION 'unified callback execute ACL drift'; END IF;
END;
$$;

COMMIT;
