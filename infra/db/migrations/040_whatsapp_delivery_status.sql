-- ============================================================
-- 040_whatsapp_delivery_status.sql
-- Durable Twilio delivery lifecycle for WhatsApp outbox sends.
-- Connect as: jale_admin (NOT the RDS master user)
--
-- Review-1 correction round: the privileged callback role/schema is
-- created with safe flags ONLY when absent (no unconditional ALTER
-- ROLE against production); the recorder implementations that write
-- across whatsapp_outbox / job_conversation_messages / admin_case*
-- live in the jale_twilio_callback-owned locked schema, fully
-- qualified, under a catalog-only search_path; narrow public wrappers
-- preserve prior signatures/grants for existing callers.
--
-- OPERATOR NOTE (lock window): the CHECK-constraint additions and the
-- two index builds on whatsapp_outbox below run inside this single
-- transaction WITHOUT `NOT VALID`/`CONCURRENTLY`, so they block
-- concurrent writers to whatsapp_outbox for the duration of their
-- table scans. This is a deliberate trade: keeping the whole migration
-- one atomic transaction preserves the fail-closed invariant design,
-- and at current outbox row counts the scan window is small. Apply
-- during a low-traffic window (the 1-min admin dispatcher and 5-min
-- sweeper/drain schedules will simply retry after commit). If
-- whatsapp_outbox ever grows large enough that this window matters,
-- write a NEW migration using NOT VALID + VALIDATE CONSTRAINT and
-- CREATE INDEX CONCURRENTLY in separate transactions instead of
-- editing this file.
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
  -- Rerun against an environment where the role already exists: validate its
  -- attributes instead of forcing ALTER ROLE, which requires elevated
  -- privilege in production and could silently overwrite operator-managed
  -- attributes. Fail closed if the existing role is not exactly as safe as
  -- what we would have created.
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_roles
     WHERE rolname = 'jale_twilio_callback'
       AND NOT rolcanlogin AND NOT rolsuper AND NOT rolcreatedb
       AND NOT rolcreaterole AND NOT rolinherit AND NOT rolreplication
       AND NOT rolbypassrls
  ) THEN
    RAISE EXCEPTION 'jale_twilio_callback role already exists with unsafe attributes';
  END IF;
END;
$$;

-- AWS RDS creates no automatic creator membership; plain PostgreSQL may.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_auth_members membership
    JOIN pg_catalog.pg_roles granted ON granted.oid = membership.roleid
    JOIN pg_catalog.pg_roles member ON member.oid = membership.member
    JOIN pg_catalog.pg_roles grantor ON grantor.oid = membership.grantor
    WHERE granted.rolname = 'jale_twilio_callback'
      AND member.rolname = current_user
      AND membership.admin_option
      AND NOT membership.inherit_option
      AND NOT membership.set_option
      AND grantor.rolsuper
  ) THEN
    EXECUTE format(
      'GRANT jale_twilio_callback TO %I WITH ADMIN TRUE, SET FALSE, INHERIT FALSE',
      current_user
    );
  END IF;
END;
$$;

-- Temporarily add SET capability. Plain PG16 records a self-grant while RDS
-- updates its rdsadmin grant; cleanup below safely handles both shapes.
DO $$
BEGIN
  EXECUTE format(
    'GRANT jale_twilio_callback TO %I WITH SET TRUE, INHERIT FALSE',
    current_user
  );
END;
$$;

-- PostgreSQL requires a function's new owner to hold CREATE on the
-- containing schema. Grant it temporarily so the narrow public wrappers can
-- be transferred to the helper, then revoke it before commit.
GRANT CREATE ON SCHEMA public TO jale_twilio_callback;

CREATE SCHEMA IF NOT EXISTS jale_twilio_callback;
ALTER SCHEMA jale_twilio_callback OWNER TO jale_twilio_callback;
-- Schema-level GRANT/REVOKE are owner-only operations. Static SET-capable
-- membership (above) is sufficient to transfer OWNERSHIP (ALTER ... OWNER
-- TO, just above), but exercising owner privileges to grant/revoke ON the
-- schema itself requires an ACTIVE SET ROLE, since the membership is
-- deliberately INHERIT FALSE. Scope that to exactly these two statements
-- and reset immediately after.
SET LOCAL ROLE jale_twilio_callback;
REVOKE ALL ON SCHEMA jale_twilio_callback FROM PUBLIC;
DO $$ BEGIN
  EXECUTE format('GRANT USAGE, CREATE ON SCHEMA jale_twilio_callback TO %I', session_user);
END $$;
RESET ROLE;

-- On a rerun the callback functions below are already helper-owned. The
-- migration runner deliberately cannot drop those objects through its
-- NOINHERIT membership, so remove them while the temporary SET grant is
-- active. Drop callers before callees to avoid CASCADE and keep the exact
-- object surface explicit.
SET LOCAL ROLE jale_twilio_callback;
DO $$
DECLARE
  target RECORD;
BEGIN
  FOR target IN
    SELECT function.oid
      FROM pg_catalog.pg_proc function
      JOIN pg_catalog.pg_namespace namespace ON namespace.oid = function.pronamespace
     WHERE function.proowner = (SELECT oid FROM pg_catalog.pg_roles WHERE rolname = current_user)
       AND (
         (namespace.nspname = 'public' AND function.proname IN (
           'record_twilio_status', 'record_whatsapp_delivery_status',
           'record_admin_whatsapp_delivery'
         ))
         OR
         (namespace.nspname = 'jale_twilio_callback' AND function.proname IN (
           'record_twilio_status', 'record_whatsapp_delivery_status',
           'record_twilio_delivery_status', 'record_admin_whatsapp_delivery'
         ))
       )
     ORDER BY CASE
       WHEN namespace.nspname = 'public' THEN 0
       WHEN function.proname = 'record_twilio_delivery_status' THEN 1
       ELSE 2
     END
  LOOP
    EXECUTE pg_catalog.format('DROP FUNCTION %s', target.oid::pg_catalog.regprocedure);
  END LOOP;
END;
$$;
RESET ROLE;

ALTER TABLE whatsapp_outbox
  ADD COLUMN IF NOT EXISTS twilio_delivery_status TEXT,
  ADD COLUMN IF NOT EXISTS twilio_error_code TEXT,
  ADD COLUMN IF NOT EXISTS twilio_error_message TEXT,
  ADD COLUMN IF NOT EXISTS twilio_status_updated_at TIMESTAMPTZ,
  -- Backoff scheduling for definite non-acceptance in the crash-safe
  -- job-alert drain (see job-alert-drain.ts). Ambiguous sends remain
  -- terminally send_unknown and are never scheduled automatically.
  ADD COLUMN IF NOT EXISTS next_attempt_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_whatsapp_outbox_job_alert_pending
  ON whatsapp_outbox (created_at)
  WHERE source_type = 'job_alert' AND status = 'pending';

ALTER TABLE whatsapp_outbox DROP CONSTRAINT IF EXISTS whatsapp_outbox_twilio_delivery_status_check;
ALTER TABLE whatsapp_outbox
  ADD CONSTRAINT whatsapp_outbox_twilio_delivery_status_check
  CHECK (
    twilio_delivery_status IS NULL
    OR twilio_delivery_status IN (
      'queued', 'accepted', 'sent', 'delivered', 'read', 'undelivered', 'failed'
    )
  );

-- DB-level bounds on error fields (defense in depth; the recorder function
-- also validates these before writing).
ALTER TABLE whatsapp_outbox DROP CONSTRAINT IF EXISTS whatsapp_outbox_twilio_error_code_check;
ALTER TABLE whatsapp_outbox
  ADD CONSTRAINT whatsapp_outbox_twilio_error_code_check
  CHECK (twilio_error_code IS NULL OR twilio_error_code ~ '^[0-9]{1,10}$');
ALTER TABLE whatsapp_outbox DROP CONSTRAINT IF EXISTS whatsapp_outbox_twilio_error_message_check;
ALTER TABLE whatsapp_outbox
  ADD CONSTRAINT whatsapp_outbox_twilio_error_message_check
  CHECK (twilio_error_message IS NULL OR char_length(twilio_error_message) <= 1000);

CREATE UNIQUE INDEX IF NOT EXISTS idx_whatsapp_outbox_twilio_message_sid
  ON whatsapp_outbox (twilio_message_sid)
  WHERE twilio_message_sid IS NOT NULL;

-- The locked SECURITY DEFINER implementations run as the NOLOGIN helper,
-- not as the table-owning migration role. Give that helper only the columns
-- its validated callback paths read or update, together with helper-specific
-- RLS policies (admin tables use FORCE ROW LEVEL SECURITY).
REVOKE ALL ON public.whatsapp_outbox FROM jale_twilio_callback;
GRANT SELECT (id, source_type, source_id, twilio_delivery_status,
              twilio_message_sid, body, last_error),
      UPDATE (twilio_delivery_status, twilio_error_code,
              twilio_error_message, twilio_status_updated_at, last_error)
  ON public.whatsapp_outbox TO jale_twilio_callback;
DROP POLICY IF EXISTS whatsapp_outbox_twilio_callback_select ON public.whatsapp_outbox;
DROP POLICY IF EXISTS whatsapp_outbox_twilio_callback_update ON public.whatsapp_outbox;
CREATE POLICY whatsapp_outbox_twilio_callback_select ON public.whatsapp_outbox
  FOR SELECT TO jale_twilio_callback USING (true);
CREATE POLICY whatsapp_outbox_twilio_callback_update ON public.whatsapp_outbox
  FOR UPDATE TO jale_twilio_callback USING (true) WITH CHECK (true);

REVOKE ALL ON public.admin_cases FROM jale_twilio_callback;
GRANT SELECT (id, details), UPDATE (details, updated_at)
  ON public.admin_cases TO jale_twilio_callback;
DROP POLICY IF EXISTS admin_cases_twilio_callback_select ON public.admin_cases;
DROP POLICY IF EXISTS admin_cases_twilio_callback_update ON public.admin_cases;
CREATE POLICY admin_cases_twilio_callback_select ON public.admin_cases
  FOR SELECT TO jale_twilio_callback USING (true);
CREATE POLICY admin_cases_twilio_callback_update ON public.admin_cases
  FOR UPDATE TO jale_twilio_callback USING (true) WITH CHECK (true);

REVOKE ALL ON public.admin_case_events FROM jale_twilio_callback;
GRANT INSERT (case_id, event_type, actor_type, actor_id, payload)
  ON public.admin_case_events TO jale_twilio_callback;
DROP POLICY IF EXISTS admin_case_events_twilio_callback_insert ON public.admin_case_events;
CREATE POLICY admin_case_events_twilio_callback_insert ON public.admin_case_events
  FOR INSERT TO jale_twilio_callback WITH CHECK (true);

REVOKE ALL ON public.job_conversation_messages FROM jale_twilio_callback;
GRANT SELECT (id, twilio_message_sid, status, sent_at, delivered_at),
      UPDATE (twilio_message_sid, status, sent_at, delivered_at)
  ON public.job_conversation_messages TO jale_twilio_callback;
DROP POLICY IF EXISTS job_messages_twilio_callback ON public.job_conversation_messages;
DROP POLICY IF EXISTS job_messages_twilio_callback_select ON public.job_conversation_messages;
DROP POLICY IF EXISTS job_messages_twilio_callback_update ON public.job_conversation_messages;
CREATE POLICY job_messages_twilio_callback_select ON public.job_conversation_messages
  FOR SELECT TO jale_twilio_callback USING (true);
CREATE POLICY job_messages_twilio_callback_update ON public.job_conversation_messages
  FOR UPDATE TO jale_twilio_callback USING (true) WITH CHECK (true);

-- ============================================================
-- Locked implementations. Everything that actually touches
-- whatsapp_outbox / job_conversation_messages / admin_case* lives here,
-- owned by jale_twilio_callback, with a catalog-only search_path and
-- fully-qualified relation names so a hijacked search_path cannot redirect
-- these privileged writes.
-- ============================================================

DROP FUNCTION IF EXISTS jale_twilio_callback.record_twilio_status(TEXT, TEXT, TIMESTAMPTZ);
CREATE FUNCTION jale_twilio_callback.record_twilio_status(
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
ALTER FUNCTION jale_twilio_callback.record_twilio_status(TEXT, TEXT, TIMESTAMPTZ)
  OWNER TO jale_twilio_callback;

-- Public compatibility wrapper: preserves migration 028's public signature
-- for jale_whatsapp. It is helper-owned so the wrapper can call the locked
-- implementation without granting jale_admin access to the locked schema.
DROP FUNCTION IF EXISTS public.record_twilio_status(TEXT, TEXT, TIMESTAMPTZ);
CREATE FUNCTION public.record_twilio_status(
    p_sid TEXT, p_status TEXT, p_at TIMESTAMPTZ
) RETURNS BOOLEAN
LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  SELECT jale_twilio_callback.record_twilio_status(p_sid, p_status, p_at);
$$;
ALTER FUNCTION public.record_twilio_status(TEXT, TEXT, TIMESTAMPTZ)
  OWNER TO jale_twilio_callback;

-- Job alerts now use the same durable outbox. Preserve the original inbound
-- and admin-case origins while allowing one idempotent row per job/worker.
ALTER TABLE whatsapp_outbox DROP CONSTRAINT IF EXISTS whatsapp_outbox_origin_check;
ALTER TABLE whatsapp_outbox
  ADD CONSTRAINT whatsapp_outbox_origin_check CHECK (
    (inbound_message_sid IS NOT NULL AND source_type IS NULL AND source_id IS NULL)
    OR
    (inbound_message_sid IS NULL AND source_type IN ('admin_case', 'job_alert', 'worker_intent') AND source_id IS NOT NULL)
  );

DROP FUNCTION IF EXISTS jale_twilio_callback.record_whatsapp_delivery_status(TEXT, TEXT, TEXT, TEXT);
CREATE FUNCTION jale_twilio_callback.record_whatsapp_delivery_status(
  p_twilio_message_sid TEXT,
  p_message_status TEXT,
  p_error_code TEXT,
  p_error_message TEXT
)
RETURNS TABLE (matched BOOLEAN, changed BOOLEAN)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
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
    FROM public.whatsapp_outbox o
   WHERE o.twilio_message_sid = p_twilio_message_sid
   FOR UPDATE;

  IF v_outbox_id IS NULL THEN
    RETURN QUERY SELECT false, false;
    RETURN;
  END IF;

  -- Duplicate same-status callback: Twilio may re-deliver a status callback
  -- (retry, at-least-once delivery). Refresh the callback timestamp and any
  -- updated error detail so operators see the latest callback time, but do
  -- not re-fire admin events and report changed=false.
  IF v_previous_status IS NOT NULL AND v_status = v_previous_status THEN
    UPDATE public.whatsapp_outbox
       SET twilio_error_code = v_error_code,
           twilio_error_message = v_error_message,
           twilio_status_updated_at = pg_catalog.clock_timestamp(),
           last_error = CASE
             WHEN v_status IN ('failed', 'undelivered')
               THEN COALESCE(v_error_message, v_error_code, last_error)
             ELSE last_error
           END
     WHERE id = v_outbox_id;
    RETURN QUERY SELECT true, false;
    RETURN;
  END IF;

  v_transition_allowed := CASE
    WHEN v_previous_status IS NULL THEN true
    WHEN v_previous_status IN ('failed', 'undelivered', 'read') THEN false
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

  UPDATE public.whatsapp_outbox
     SET twilio_delivery_status = v_status,
         twilio_error_code = v_error_code,
         twilio_error_message = v_error_message,
         twilio_status_updated_at = pg_catalog.clock_timestamp(),
         last_error = CASE
           WHEN v_status IN ('failed', 'undelivered')
             THEN COALESCE(v_error_message, v_error_code, last_error)
           ELSE last_error
         END
   WHERE id = v_outbox_id;

  IF v_source_type = 'admin_case'
     AND v_source_id IS NOT NULL
     AND v_status IN ('delivered', 'read', 'undelivered', 'failed')
     AND EXISTS (SELECT 1 FROM public.admin_cases WHERE id = v_source_id) THEN
    INSERT INTO public.admin_case_events (case_id, event_type, actor_type, actor_id, payload)
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

    UPDATE public.admin_cases
       SET details = details || jsonb_build_object(
             'lastOutboundTwilioSid', p_twilio_message_sid,
             'lastOutboundTwilioStatus', v_status,
             'lastOutboundTwilioErrorCode', v_error_code,
             'lastOutboundTwilioErrorMessage', v_error_message
           ),
           updated_at = pg_catalog.now()
     WHERE id = v_source_id;
  END IF;

  RETURN QUERY SELECT true, true;
END;
$$;

ALTER FUNCTION jale_twilio_callback.record_whatsapp_delivery_status(TEXT, TEXT, TEXT, TEXT)
  OWNER TO jale_twilio_callback;

-- Public compatibility wrapper preserving the prior public signature/grants.
DROP FUNCTION IF EXISTS public.record_whatsapp_delivery_status(TEXT, TEXT, TEXT, TEXT);
CREATE FUNCTION public.record_whatsapp_delivery_status(
  p_twilio_message_sid TEXT,
  p_message_status TEXT,
  p_error_code TEXT,
  p_error_message TEXT
)
RETURNS TABLE (matched BOOLEAN, changed BOOLEAN)
LANGUAGE sql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
  SELECT * FROM jale_twilio_callback.record_whatsapp_delivery_status(
    p_twilio_message_sid, p_message_status, p_error_code, p_error_message
  );
$$;
ALTER FUNCTION public.record_whatsapp_delivery_status(TEXT, TEXT, TEXT, TEXT)
  OWNER TO jale_twilio_callback;

-- One callback entry point dispatches to both durable outbound stores. The
-- job-message writer introduced in migration 028 updates its message record;
-- all processor/admin/job-alert sends are correlated through whatsapp_outbox.
-- Calls the locked, fully-qualified implementations directly rather than the
-- public wrappers, so the dispatch path never depends on public search_path
-- resolution.
DROP FUNCTION IF EXISTS public.record_twilio_delivery_status(TEXT, TEXT, TEXT, TEXT);
DROP FUNCTION IF EXISTS jale_twilio_callback.record_twilio_delivery_status(TEXT, TEXT, TEXT, TEXT);
CREATE FUNCTION jale_twilio_callback.record_twilio_delivery_status(
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
    FROM jale_twilio_callback.record_whatsapp_delivery_status(
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
    SELECT jale_twilio_callback.record_twilio_status(p_twilio_message_sid, v_status, pg_catalog.clock_timestamp())
      INTO v_job_changed;
  END IF;
  RETURN QUERY SELECT v_job_matched, v_job_changed,
    CASE WHEN v_job_matched THEN 'job_message_outbox'::TEXT ELSE NULL::TEXT END;
END;
$$;

ALTER FUNCTION jale_twilio_callback.record_twilio_delivery_status(TEXT, TEXT, TEXT, TEXT)
  OWNER TO jale_twilio_callback;

DROP FUNCTION IF EXISTS jale_twilio_callback.record_admin_whatsapp_delivery(UUID, TEXT, TEXT, TEXT);
CREATE FUNCTION jale_twilio_callback.record_admin_whatsapp_delivery(
  p_outbox_id UUID,
  p_status TEXT,
  p_twilio_message_sid TEXT,
  p_error TEXT
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_case_id UUID;
  v_body TEXT;
BEGIN
  IF p_status NOT IN ('sent', 'failed', 'send_unknown') THEN
    RAISE EXCEPTION 'invalid admin WhatsApp delivery status';
  END IF;
  SELECT source_id, body INTO v_case_id, v_body
    FROM public.whatsapp_outbox
   WHERE id = p_outbox_id AND source_type = 'admin_case';
  IF v_case_id IS NULL THEN
    RAISE EXCEPTION 'admin WhatsApp outbox row not found';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.admin_cases WHERE id = v_case_id) THEN
    RETURN;
  END IF;
  INSERT INTO public.admin_case_events (case_id, event_type, actor_type, actor_id, payload)
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
    UPDATE public.admin_cases
       SET details = details || jsonb_build_object('lastOutboundTwilioSid', p_twilio_message_sid),
           updated_at = pg_catalog.now()
     WHERE id = v_case_id;
  END IF;
END;
$$;
ALTER FUNCTION jale_twilio_callback.record_admin_whatsapp_delivery(UUID, TEXT, TEXT, TEXT)
  OWNER TO jale_twilio_callback;

-- Dispatch status remains `sent` for compatibility, but its timeline title
-- must not imply final delivery before an asynchronous Twilio callback.
-- Public compatibility wrapper preserves migration 027's public signature
-- and jale_whatsapp grant.
DROP FUNCTION IF EXISTS public.record_admin_whatsapp_delivery(UUID, TEXT, TEXT, TEXT);
CREATE FUNCTION public.record_admin_whatsapp_delivery(
  p_outbox_id UUID,
  p_status TEXT,
  p_twilio_message_sid TEXT,
  p_error TEXT
)
RETURNS VOID
LANGUAGE sql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
  SELECT jale_twilio_callback.record_admin_whatsapp_delivery(
    p_outbox_id, p_status, p_twilio_message_sid, p_error
  );
$$;
ALTER FUNCTION public.record_admin_whatsapp_delivery(UUID, TEXT, TEXT, TEXT)
  OWNER TO jale_twilio_callback;

-- Apply every helper-owned ACL while the helper role is active. Performing
-- these grants after ownership transfer as jale_admin only emits warnings
-- and grants nothing when membership is NOINHERIT.
SET LOCAL ROLE jale_twilio_callback;
REVOKE ALL ON FUNCTION jale_twilio_callback.record_twilio_status(TEXT, TEXT, TIMESTAMPTZ) FROM PUBLIC;
REVOKE ALL ON FUNCTION jale_twilio_callback.record_whatsapp_delivery_status(TEXT, TEXT, TEXT, TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION jale_twilio_callback.record_twilio_delivery_status(TEXT, TEXT, TEXT, TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION jale_twilio_callback.record_admin_whatsapp_delivery(UUID, TEXT, TEXT, TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.record_twilio_status(TEXT, TEXT, TIMESTAMPTZ) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.record_whatsapp_delivery_status(TEXT, TEXT, TEXT, TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.record_admin_whatsapp_delivery(UUID, TEXT, TEXT, TEXT) FROM PUBLIC;
GRANT USAGE ON SCHEMA jale_twilio_callback TO jale_whatsapp;
GRANT EXECUTE ON FUNCTION jale_twilio_callback.record_twilio_delivery_status(TEXT, TEXT, TEXT, TEXT)
  TO jale_whatsapp;
GRANT EXECUTE ON FUNCTION public.record_twilio_status(TEXT, TEXT, TIMESTAMPTZ)
  TO jale_whatsapp;
GRANT EXECUTE ON FUNCTION public.record_whatsapp_delivery_status(TEXT, TEXT, TEXT, TEXT)
  TO jale_whatsapp;
GRANT EXECUTE ON FUNCTION public.record_admin_whatsapp_delivery(UUID, TEXT, TEXT, TEXT)
  TO jale_whatsapp;
RESET ROLE;
REVOKE CREATE ON SCHEMA public FROM jale_twilio_callback;

-- Disable SET on the selected grantor row, then remove any plain-PG self-grant.
-- Object ownership is unaffected by updating membership options.
SET LOCAL ROLE jale_twilio_callback;
DO $$ BEGIN
  EXECUTE format('REVOKE ALL ON SCHEMA jale_twilio_callback FROM %I', session_user);
END $$;
RESET ROLE;
DO $$
BEGIN
  EXECUTE format(
    'GRANT jale_twilio_callback TO %I WITH SET FALSE, INHERIT FALSE',
    current_user
  );
  EXECUTE format(
    'REVOKE jale_twilio_callback FROM %I GRANTED BY %I',
    current_user, current_user
  );
END;
$$;

-- Fail closed if any helper-role, ACL, ownership, policy, or function setting
-- drifts while this rerunnable migration is being maintained.
DO $$
DECLARE
  v_creator OID := (SELECT oid FROM pg_catalog.pg_roles WHERE rolname = current_user);
  v_unified_callback OID := (
    SELECT function.oid
      FROM pg_catalog.pg_proc function
      JOIN pg_catalog.pg_namespace namespace ON namespace.oid = function.pronamespace
     WHERE namespace.nspname = 'jale_twilio_callback'
       AND function.proname = 'record_twilio_delivery_status'
       AND function.proargtypes = '25 25 25 25'::pg_catalog.oidvector
  );
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_roles
     WHERE rolname = 'jale_twilio_callback'
       AND NOT rolcanlogin AND NOT rolsuper AND NOT rolcreatedb
       AND NOT rolcreaterole AND NOT rolinherit AND NOT rolreplication
       AND NOT rolbypassrls
  ) THEN RAISE EXCEPTION 'jale_twilio_callback role attributes are unsafe'; END IF;

  -- PG16 fail-closed assertion: exactly one explicit creator-membership row
  -- remains with ADMIN=true, SET=false, INHERIT=false. The grantor is the
  -- environment superuser (for AWS RDS this is rdsadmin). Reject any
  -- additional membership in either direction, including making the helper
  -- a member of another role.
  IF (SELECT count(*) FROM pg_catalog.pg_auth_members membership
       JOIN pg_catalog.pg_roles granted ON granted.oid = membership.roleid
       JOIN pg_catalog.pg_roles member ON member.oid = membership.member
       JOIN pg_catalog.pg_roles grantor ON grantor.oid = membership.grantor
      WHERE granted.rolname = 'jale_twilio_callback'
         OR member.rolname = 'jale_twilio_callback') <> 1
     OR NOT EXISTS (
       SELECT 1 FROM pg_catalog.pg_auth_members membership
       JOIN pg_catalog.pg_roles granted ON granted.oid = membership.roleid
       JOIN pg_catalog.pg_roles member ON member.oid = membership.member
       JOIN pg_catalog.pg_roles grantor ON grantor.oid = membership.grantor
      WHERE granted.rolname = 'jale_twilio_callback'
        AND member.oid = v_creator
        AND membership.admin_option
        AND NOT membership.set_option
        AND NOT membership.inherit_option
        AND grantor.rolsuper
     )
  THEN RAISE EXCEPTION 'jale_twilio_callback creator membership is unsafe'; END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_namespace n
     JOIN pg_catalog.pg_roles r ON r.oid = n.nspowner
    WHERE n.nspname = 'jale_twilio_callback' AND r.rolname = 'jale_twilio_callback'
      AND NOT pg_catalog.has_schema_privilege('public', n.oid, 'USAGE')
  ) THEN RAISE EXCEPTION 'jale_twilio_callback schema ACL/owner drift'; END IF;

  IF pg_catalog.has_schema_privilege('jale_twilio_callback', 'public', 'CREATE')
     OR (SELECT count(*)
           FROM pg_catalog.pg_proc function
           JOIN pg_catalog.pg_namespace namespace ON namespace.oid = function.pronamespace
           JOIN pg_catalog.pg_roles owner ON owner.oid = function.proowner
          WHERE namespace.nspname = 'public'
            AND function.proname IN (
              'record_twilio_status',
              'record_whatsapp_delivery_status',
              'record_admin_whatsapp_delivery'
            )
            AND owner.rolname = 'jale_twilio_callback'
            AND function.prosecdef
            AND function.proconfig @> ARRAY['search_path=pg_catalog, pg_temp']) <> 3
  THEN RAISE EXCEPTION 'callback wrapper owner/schema privilege drift'; END IF;

  IF EXISTS (
    SELECT 1
      FROM pg_catalog.pg_proc function
      JOIN pg_catalog.pg_namespace namespace ON namespace.oid = function.pronamespace,
      LATERAL pg_catalog.aclexplode(
        COALESCE(function.proacl, pg_catalog.acldefault('f', function.proowner))
      ) acl
     WHERE namespace.nspname = 'public'
       AND function.proname IN (
         'record_twilio_status',
         'record_whatsapp_delivery_status',
         'record_admin_whatsapp_delivery'
       )
       AND acl.grantee = 0
       AND acl.privilege_type = 'EXECUTE'
  ) OR (SELECT count(*)
          FROM pg_catalog.pg_proc function
          JOIN pg_catalog.pg_namespace namespace ON namespace.oid = function.pronamespace
         WHERE namespace.nspname = 'public'
           AND function.proname IN (
             'record_twilio_status',
             'record_whatsapp_delivery_status',
             'record_admin_whatsapp_delivery'
           )
           AND pg_catalog.has_function_privilege(
             'jale_whatsapp', function.oid, 'EXECUTE'
           )) <> 3
  THEN RAISE EXCEPTION 'callback wrapper execute ACL drift'; END IF;

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

  IF EXISTS (
    SELECT 1 FROM pg_catalog.pg_proc p
     JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'jale_twilio_callback'
      AND p.proname IN ('record_whatsapp_delivery_status', 'record_twilio_status',
                         'record_admin_whatsapp_delivery')
      AND (NOT p.proconfig @> ARRAY['search_path=pg_catalog, pg_temp'] OR NOT p.prosecdef)
  ) THEN RAISE EXCEPTION 'locked helper implementations must be SECURITY DEFINER with a catalog-only search_path'; END IF;

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

  -- Use the catalog OID here: jale_admin intentionally has no USAGE on the
  -- locked schema by this point, so resolving a regprocedure by qualified
  -- name would make the self-audit fail with permission denied.
  IF v_unified_callback IS NULL
     OR pg_catalog.has_function_privilege('public', v_unified_callback, 'EXECUTE')
     OR NOT pg_catalog.has_function_privilege('jale_whatsapp', v_unified_callback, 'EXECUTE')
  THEN RAISE EXCEPTION 'unified callback execute ACL drift'; END IF;

  IF pg_catalog.to_regprocedure('public.record_twilio_delivery_status(text,text,text,text)') IS NOT NULL
  THEN RAISE EXCEPTION 'legacy public unified callback alias must not exist'; END IF;
END;
$$;

COMMIT;
