-- ============================================================
-- 097_twilio_callback_job_message_outbox.sql
-- Connect as: jale_admin (NOT the RDS master user)
--
-- BUG: employer -> worker WhatsApp invites are sent as TEMPLATE rows out of
-- job_message_outbox, and the sender (infra/lambda/lib/job-messaging.ts,
-- sendPendingJobMessageOutbox) deliberately writes the Twilio SID onto
-- job_message_outbox.twilio_message_sid only -- it must NOT copy it onto the
-- job_conversation_messages row, because a template row has to stay
-- 'waiting_worker_reply' until the worker replies and the freeform flush runs.
-- Migration 040's unified callback, however, only looks at whatsapp_outbox and
-- then at job_conversation_messages.twilio_message_sid, so every Twilio status
-- callback for a templated employer message came back matched=false: the
-- status-callback Lambda then logged WhatsAppStatusCallbackUnknownSid and
-- returned a retryable 503, which pages an alarm and makes Twilio retry
-- forever. This migration adds job_message_outbox as a third correlation
-- source so those callbacks are matched (and a terminal failure is recorded)
-- without changing either of the first two branches.
--
-- Everything that reads or writes across FORCE RLS still runs inside the
-- jale_twilio_callback-owned locked schema, SECURITY DEFINER, catalog-only
-- search_path, fully-qualified relation names -- exactly as 040/042/043 do.
--
-- OPERATOR NOTE (lock window): the index below is built WITHOUT CONCURRENTLY
-- so the whole migration stays one atomic transaction (SET LOCAL ROLE, which
-- the locked-schema work requires, needs a transaction). job_message_outbox is
-- small (one row per employer message) so the scan window is negligible.
-- Deploy order: order-free with respect to application code -- the sender is
-- unchanged. Apply as soon as possible; until then the alarm keeps firing.
-- ============================================================

BEGIN;

-- ------------------------------------------------------------
-- 1. Correlation index. The callback looks rows up by SID; without this the
--    third branch would seq-scan the outbox on every Twilio callback.
--    Deliberately NOT unique, unlike whatsapp_outbox's: nothing in the schema
--    enforces one row per SID. In practice a SID is unique -- job-messaging.ts
--    stamps exactly one Twilio SID onto exactly one outbox row, keyed by id,
--    and Twilio SIDs are globally unique -- so the lookup below takes LIMIT 1
--    and does not need a tiebreak column in the helper's SELECT grant.
-- ------------------------------------------------------------
CREATE INDEX IF NOT EXISTS idx_job_message_outbox_twilio_message_sid
  ON public.job_message_outbox (twilio_message_sid)
  WHERE twilio_message_sid IS NOT NULL;

-- ------------------------------------------------------------
-- 2. Helper-role ACL + RLS policies on job_message_outbox (025 puts FORCE ROW
--    LEVEL SECURITY on this table and every existing policy is GUC-keyed to an
--    employer, so the NOLOGIN helper needs its own policies to see anything).
--    REVOKE first so a re-apply converges on exactly the column list below
--    rather than accumulating whatever drifted in -- this is what makes the
--    self-audit at the end of this file able to assert an exact ACL.
--    Mirrors 040's whatsapp_outbox / admin_cases / job_conversation_messages
--    blocks, including WITH CHECK (true) on the UPDATE policy.
-- ------------------------------------------------------------
REVOKE ALL ON public.job_message_outbox FROM jale_twilio_callback;
GRANT SELECT (id, message_id, send_kind, status, twilio_message_sid, last_error),
      UPDATE (status, last_error)
  ON public.job_message_outbox TO jale_twilio_callback;
DROP POLICY IF EXISTS job_outbox_twilio_callback_select ON public.job_message_outbox;
DROP POLICY IF EXISTS job_outbox_twilio_callback_update ON public.job_message_outbox;
CREATE POLICY job_outbox_twilio_callback_select ON public.job_message_outbox
  FOR SELECT TO jale_twilio_callback USING (true);
CREATE POLICY job_outbox_twilio_callback_update ON public.job_message_outbox
  FOR UPDATE TO jale_twilio_callback USING (true) WITH CHECK (true);

-- ------------------------------------------------------------
-- 3. The unified callback dispatch, re-created with a third branch.
--
--    Temporarily restore SET-capable membership exactly as migrations 042 and
--    043 do: after 040 the migration role holds jale_twilio_callback with
--    SET FALSE / INHERIT FALSE and has no USAGE on the locked schema, so it
--    is not the owner for CREATE OR REPLACE purposes and cannot replace this
--    function without becoming the helper for the duration.
-- ------------------------------------------------------------
DO $$ BEGIN
  EXECUTE format('GRANT jale_twilio_callback TO %I WITH SET TRUE, INHERIT FALSE', current_user);
END $$;
SET LOCAL ROLE jale_twilio_callback;

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
  v_outbox_id UUID;
  v_outbox_message_id UUID;
  v_outbox_status TEXT;
  v_outbox_changed BOOLEAN := false;
  v_last_error TEXT;
BEGIN
  -- Branch 1 (040): whatsapp_outbox. Unchanged. The implementation it calls
  -- also performs all the input validation (SID shape, status vocabulary,
  -- error-code/-message bounds) and RAISEs on bad input, so the branches
  -- below can rely on v_status being one of the seven known values.
  SELECT * INTO v_whatsapp
    FROM jale_twilio_callback.record_whatsapp_delivery_status(
      p_twilio_message_sid, p_message_status, p_error_code, p_error_message
    );
  IF v_whatsapp.matched THEN
    RETURN QUERY SELECT true, v_whatsapp.changed, 'whatsapp_outbox'::TEXT;
    RETURN;
  END IF;

  -- Branch 2 (040): a SID stamped directly onto job_conversation_messages --
  -- freeform employer messages, and v2 worker-intent sends. Behaviour is
  -- unchanged; the only edit is that an unmatched lookup now falls through to
  -- branch 3 instead of returning (false, false, NULL) immediately.
  SELECT EXISTS (
    SELECT 1 FROM public.job_conversation_messages
     WHERE twilio_message_sid = p_twilio_message_sid
  ) INTO v_job_matched;
  IF v_job_matched THEN
    IF v_status IN ('sent', 'delivered', 'read', 'failed', 'undelivered') THEN
      SELECT jale_twilio_callback.record_twilio_status(
               p_twilio_message_sid, v_status, pg_catalog.clock_timestamp())
        INTO v_job_changed;
    END IF;
    RETURN QUERY SELECT true, v_job_changed, 'job_message_outbox'::TEXT;
    RETURN;
  END IF;

  -- Branch 3 (097): the templated employer -> worker invite. The SID lives on
  -- job_message_outbox and NOWHERE else, by design -- see the header. LIMIT 1
  -- because the index is not declared unique even though a SID is unique in
  -- practice; if that ever stopped holding, either row answers the only
  -- question the callback asks ("is this SID ours?") the same way.
  SELECT o.id, o.message_id, o.status
    INTO v_outbox_id, v_outbox_message_id, v_outbox_status
    FROM public.job_message_outbox o
   WHERE o.twilio_message_sid = p_twilio_message_sid
   LIMIT 1
   FOR UPDATE;

  IF v_outbox_id IS NULL THEN
    RETURN QUERY SELECT false, false, NULL::TEXT;
    RETURN;
  END IF;

  -- Only a terminal failure on a row still believed 'sent' is a state change.
  -- queued/accepted/sent/delivered/read are progress reports on a row that is
  -- already terminally 'sent' from the sender's point of view, and a repeat
  -- failure lands on a row that is already 'failed' -- both report
  -- changed = false so the Lambda does not re-emit WhatsAppDeliveryFailure.
  IF v_status IN ('failed', 'undelivered') AND v_outbox_status = 'sent' THEN
    v_last_error := COALESCE(
      NULLIF(CONCAT_WS(' ', BTRIM(COALESCE(p_error_code, '')), BTRIM(COALESCE(p_error_message, ''))), ''),
      v_status
    );
    UPDATE public.job_message_outbox
       SET status = 'failed',
           last_error = v_last_error
     WHERE id = v_outbox_id;

    -- Keep the employer-visible message in step. A template row's message is
    -- parked in 'waiting_worker_reply' (or still 'queued') precisely because
    -- the sender must not advance it; a terminal Twilio failure is the one
    -- signal that it will never be delivered. message_id is nullable
    -- (025: ON DELETE SET NULL), so guard it.
    IF v_outbox_message_id IS NOT NULL THEN
      UPDATE public.job_conversation_messages
         SET status = 'failed'
       WHERE id = v_outbox_message_id
         AND status IN ('queued', 'waiting_worker_reply');
    END IF;

    v_outbox_changed := true;
  END IF;

  RETURN QUERY SELECT true, v_outbox_changed, 'job_message_outbox'::TEXT;
END;
$$;

ALTER FUNCTION jale_twilio_callback.record_twilio_delivery_status(TEXT, TEXT, TEXT, TEXT)
  OWNER TO jale_twilio_callback;
REVOKE ALL ON FUNCTION jale_twilio_callback.record_twilio_delivery_status(TEXT, TEXT, TEXT, TEXT)
  FROM PUBLIC;
GRANT EXECUTE ON FUNCTION jale_twilio_callback.record_twilio_delivery_status(TEXT, TEXT, TEXT, TEXT)
  TO jale_whatsapp;
RESET ROLE;

-- Restore migration 040's exact end state: one superuser-granted membership
-- row with ADMIN TRUE, SET FALSE, INHERIT FALSE and no self-grant.
DO $$ BEGIN
  EXECUTE format('GRANT jale_twilio_callback TO %I WITH SET FALSE, INHERIT FALSE', current_user);
  EXECUTE format('REVOKE jale_twilio_callback FROM %I GRANTED BY %I', current_user, current_user);
END $$;

-- ------------------------------------------------------------
-- 4. Fail closed on any hardening, ownership or ACL drift.
-- ------------------------------------------------------------
DO $$
DECLARE
  v_extra TEXT;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_proc p
     JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
     JOIN pg_catalog.pg_roles r ON r.oid = p.proowner
    WHERE n.nspname = 'jale_twilio_callback'
      AND p.proname = 'record_twilio_delivery_status'
      AND p.proargtypes = '25 25 25 25'::pg_catalog.oidvector
      AND r.rolname = 'jale_twilio_callback'
      AND p.prosecdef
      AND p.proconfig @> ARRAY['search_path=pg_catalog, pg_temp']
  ) THEN
    RAISE EXCEPTION 'migration 097: unified callback must be owned by jale_twilio_callback, SECURITY DEFINER, with search_path=pg_catalog, pg_temp';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_indexes
     WHERE schemaname = 'public' AND tablename = 'job_message_outbox'
       AND indexname = 'idx_job_message_outbox_twilio_message_sid'
  ) THEN
    RAISE EXCEPTION 'migration 097: job_message_outbox SID correlation index is missing';
  END IF;

  IF (SELECT count(*) FROM pg_catalog.pg_policies
       WHERE schemaname = 'public' AND tablename = 'job_message_outbox'
         AND policyname IN ('job_outbox_twilio_callback_select',
                            'job_outbox_twilio_callback_update')) <> 2 THEN
    RAISE EXCEPTION 'migration 097: job_message_outbox Twilio callback RLS policies missing';
  END IF;

  -- A whole-table grant would hand the helper every column, including the
  -- employer body/content_variables it has no business reading.
  IF pg_catalog.has_table_privilege('jale_twilio_callback', 'public.job_message_outbox', 'SELECT')
     OR pg_catalog.has_table_privilege('jale_twilio_callback', 'public.job_message_outbox', 'UPDATE')
     OR pg_catalog.has_table_privilege('jale_twilio_callback', 'public.job_message_outbox', 'INSERT')
     OR pg_catalog.has_table_privilege('jale_twilio_callback', 'public.job_message_outbox', 'DELETE')
  THEN
    RAISE EXCEPTION 'migration 097: jale_twilio_callback must hold column-scoped privileges only on job_message_outbox';
  END IF;

  IF NOT pg_catalog.has_column_privilege(
       'jale_twilio_callback', 'public.job_message_outbox', 'twilio_message_sid', 'SELECT')
     OR NOT pg_catalog.has_column_privilege(
       'jale_twilio_callback', 'public.job_message_outbox', 'status', 'UPDATE')
     OR NOT pg_catalog.has_column_privilege(
       'jale_twilio_callback', 'public.job_message_outbox', 'last_error', 'UPDATE')
  THEN
    RAISE EXCEPTION 'migration 097: jale_twilio_callback is missing a required job_message_outbox column privilege';
  END IF;

  -- And nothing BEYOND the listed columns/privileges.
  SELECT string_agg(format('%s:%s', cp.column_name, cp.privilege_type), ', ' ORDER BY cp.column_name)
    INTO v_extra
    FROM information_schema.column_privileges cp
   WHERE cp.table_schema = 'public'
     AND cp.table_name = 'job_message_outbox'
     AND cp.grantee = 'jale_twilio_callback'
     AND NOT (
       (cp.privilege_type = 'SELECT' AND cp.column_name IN
          ('id', 'message_id', 'send_kind', 'status', 'twilio_message_sid', 'last_error'))
       OR
       (cp.privilege_type = 'UPDATE' AND cp.column_name IN ('status', 'last_error'))
     );
  IF v_extra IS NOT NULL THEN
    RAISE EXCEPTION 'migration 097: jale_twilio_callback holds unexpected job_message_outbox column privileges: %', v_extra;
  END IF;

  -- The locked function must stay unreachable by PUBLIC and reachable by the
  -- callback Lambda role. Resolve by catalog OID: jale_admin has no USAGE on
  -- the locked schema at this point, so a qualified regprocedure lookup would
  -- fail with permission denied.
  IF EXISTS (
    SELECT 1
      FROM pg_catalog.pg_proc p
      JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace,
      LATERAL pg_catalog.aclexplode(
        COALESCE(p.proacl, pg_catalog.acldefault('f', p.proowner))) acl
     WHERE n.nspname = 'jale_twilio_callback'
       AND p.proname = 'record_twilio_delivery_status'
       AND acl.grantee = 0
       AND acl.privilege_type = 'EXECUTE'
  ) OR NOT EXISTS (
    SELECT 1
      FROM pg_catalog.pg_proc p
      JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'jale_twilio_callback'
       AND p.proname = 'record_twilio_delivery_status'
       AND pg_catalog.has_function_privilege('jale_whatsapp', p.oid, 'EXECUTE')
  ) THEN
    RAISE EXCEPTION 'migration 097: unified callback execute ACL drift';
  END IF;

  IF pg_catalog.to_regprocedure('public.record_twilio_delivery_status(text,text,text,text)') IS NOT NULL
  THEN
    RAISE EXCEPTION 'migration 097: legacy public unified callback alias must not exist';
  END IF;
END;
$$;

COMMIT;
