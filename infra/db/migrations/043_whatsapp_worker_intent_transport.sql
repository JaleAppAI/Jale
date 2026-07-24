-- Fenced, least-privilege transport for worker_intent outbox rows.
-- Connect as jale_admin.
BEGIN;

ALTER TABLE public.whatsapp_outbox
  ADD COLUMN IF NOT EXISTS worker_intent_lease_token UUID,
  ADD COLUMN IF NOT EXISTS worker_intent_leased_until TIMESTAMPTZ;

ALTER TABLE public.whatsapp_outbox
  DROP CONSTRAINT IF EXISTS whatsapp_outbox_worker_intent_lease_consistency;
ALTER TABLE public.whatsapp_outbox
  ADD CONSTRAINT whatsapp_outbox_worker_intent_lease_consistency CHECK (
    (worker_intent_lease_token IS NULL AND worker_intent_leased_until IS NULL)
    OR (worker_intent_lease_token IS NOT NULL
        AND worker_intent_leased_until IS NOT NULL
        AND source_type = 'worker_intent' AND status = 'send_unknown')
  );

CREATE INDEX IF NOT EXISTS idx_whatsapp_outbox_worker_intent_due
  ON public.whatsapp_outbox (next_attempt_at, created_at, id)
  WHERE source_type = 'worker_intent' AND status = 'pending';

CREATE INDEX IF NOT EXISTS idx_worker_message_intents_outbox_id
  ON public.worker_message_intents (outbox_id)
  WHERE outbox_id IS NOT NULL;

-- Migration 004 granted table-wide UPDATE to the shared application role.
-- Preserve the legacy drain columns but remove access to transport fencing
-- and make worker-intent rows writable only through the definer RPCs.
REVOKE UPDATE ON public.whatsapp_outbox FROM jale_whatsapp;
GRANT UPDATE (
  status, sent_at, twilio_message_sid, attempt_count, last_error,
  next_attempt_at
) ON public.whatsapp_outbox TO jale_whatsapp;
DROP POLICY IF EXISTS whatsapp_outbox_worker_intent_rpc_only
  ON public.whatsapp_outbox;
CREATE POLICY whatsapp_outbox_worker_intent_rpc_only
  ON public.whatsapp_outbox AS RESTRICTIVE
  FOR UPDATE TO jale_whatsapp
  USING (source_type IS DISTINCT FROM 'worker_intent')
  WITH CHECK (source_type IS DISTINCT FROM 'worker_intent');

-- worker_message_intents uses FORCE RLS. Only the definer gets global access;
-- application sessions retain the worker-scoped policy from migration 042.
DROP POLICY IF EXISTS worker_message_intents_definer ON public.worker_message_intents;
CREATE POLICY worker_message_intents_definer ON public.worker_message_intents
  TO jale_admin USING (true) WITH CHECK (true);

-- Delivery propagation runs as the locked NOLOGIN callback helper. Give it
-- only the correlation/state columns it needs; ordinary application roles
-- retain their existing worker/employer-scoped policies.
REVOKE ALL ON public.worker_message_intents FROM jale_twilio_callback;
GRANT SELECT (id, source_type, source_id, status, outbox_id),
      UPDATE (status, decision_reason, updated_at)
  ON public.worker_message_intents TO jale_twilio_callback;
DROP POLICY IF EXISTS worker_message_intents_twilio_callback_select
  ON public.worker_message_intents;
DROP POLICY IF EXISTS worker_message_intents_twilio_callback_update
  ON public.worker_message_intents;
CREATE POLICY worker_message_intents_twilio_callback_select
  ON public.worker_message_intents FOR SELECT TO jale_twilio_callback USING (true);
CREATE POLICY worker_message_intents_twilio_callback_update
  ON public.worker_message_intents FOR UPDATE TO jale_twilio_callback
  USING (true) WITH CHECK (true);

-- Migration 040 already limits this helper to status-callback columns and
-- supplies the FORCE-RLS policies. The v2 transport also needs to correlate
-- by message id and persist the provider SID at API acceptance.
GRANT SELECT (id, twilio_message_sid, status, sent_at, delivered_at),
      UPDATE (twilio_message_sid, status, sent_at, delivered_at)
  ON public.job_conversation_messages TO jale_twilio_callback;

CREATE OR REPLACE FUNCTION public.lease_worker_intent_outbox(p_limit INTEGER)
RETURNS TABLE (
  id UUID, whatsapp_number VARCHAR, body TEXT, content_template TEXT,
  content_variables JSONB, attempt_count INTEGER, lease_token UUID
)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF p_limit IS NULL OR p_limit < 1 OR p_limit > 100 THEN
    RAISE EXCEPTION 'invalid worker intent lease limit' USING ERRCODE = '22023';
  END IF;

  -- Expired ownership is ambiguous: clear the token but never requeue.
  UPDATE public.whatsapp_outbox o
     SET worker_intent_lease_token = NULL,
         worker_intent_leased_until = NULL,
         last_error = COALESCE(o.last_error, 'worker intent lease expired; delivery state unknown')
   WHERE o.source_type = 'worker_intent' AND o.status = 'send_unknown'
     AND o.worker_intent_leased_until <= pg_catalog.now();

  UPDATE public.whatsapp_outbox o
     SET status = 'failed', next_attempt_at = NULL,
         last_error = COALESCE(o.last_error, 'worker intent retry cap reached')
   WHERE o.source_type = 'worker_intent' AND o.status = 'pending'
     AND o.attempt_count >= 5;

  RETURN QUERY
  WITH candidates AS (
    SELECT o.id, i.release_sequence, o.created_at
      FROM public.whatsapp_outbox o
      JOIN public.worker_message_intents i ON i.id = o.source_id
     WHERE o.source_type = 'worker_intent' AND o.status = 'pending'
       AND o.attempt_count < 5
       AND (o.next_attempt_at IS NULL OR o.next_attempt_at <= pg_catalog.now())
       AND NOT EXISTS (
         SELECT 1
           FROM public.whatsapp_outbox earlier_o
           JOIN public.worker_message_intents earlier_i ON earlier_i.id = earlier_o.source_id
          WHERE earlier_o.source_type = 'worker_intent'
            AND earlier_i.user_id = i.user_id
            AND earlier_o.status IN ('pending', 'send_unknown')
            AND earlier_o.id <> o.id
            AND (
              COALESCE(earlier_i.release_sequence, 2147483647)
                < COALESCE(i.release_sequence, 2147483647)
              OR (COALESCE(earlier_i.release_sequence, 2147483647)
                    = COALESCE(i.release_sequence, 2147483647)
                  AND (earlier_o.created_at, earlier_o.id) < (o.created_at, o.id))
            )
       )
     ORDER BY COALESCE(i.release_sequence, 2147483647), o.created_at, o.id
     FOR UPDATE OF o SKIP LOCKED LIMIT p_limit
  ), claimed AS (
    UPDATE public.whatsapp_outbox o
       SET status = 'send_unknown', attempt_count = o.attempt_count + 1,
           next_attempt_at = NULL,
           worker_intent_lease_token = pg_catalog.gen_random_uuid(),
           worker_intent_leased_until = pg_catalog.now() + interval '15 minutes'
      FROM candidates c WHERE o.id = c.id
     RETURNING o.id, o.whatsapp_number, o.body, o.content_template,
               o.content_variables, o.attempt_count, o.worker_intent_lease_token
  )
  SELECT claimed.id, claimed.whatsapp_number, claimed.body, claimed.content_template,
         claimed.content_variables, claimed.attempt_count, claimed.worker_intent_lease_token
    FROM claimed
    JOIN candidates ON candidates.id = claimed.id
   ORDER BY COALESCE(candidates.release_sequence, 2147483647), candidates.created_at, candidates.id;
END $$;
ALTER FUNCTION public.lease_worker_intent_outbox(INTEGER) OWNER TO jale_admin;
REVOKE ALL ON FUNCTION public.lease_worker_intent_outbox(INTEGER) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.lease_worker_intent_outbox(INTEGER) TO jale_whatsapp;

CREATE OR REPLACE FUNCTION public.complete_worker_intent_outbox(
  p_outbox_id UUID, p_lease_token UUID, p_twilio_sid TEXT
)
RETURNS BOOLEAN
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE v_updated INTEGER;
BEGIN
  IF p_outbox_id IS NULL OR p_lease_token IS NULL OR p_twilio_sid IS NULL
     OR p_twilio_sid !~ '^(SM|MM)[0-9A-Fa-f]{32}$' THEN
    RAISE EXCEPTION 'invalid worker intent completion' USING ERRCODE = '22023';
  END IF;
  UPDATE public.whatsapp_outbox
     SET status = 'sent', sent_at = pg_catalog.now(),
         twilio_message_sid = p_twilio_sid, last_error = NULL,
         next_attempt_at = NULL, worker_intent_lease_token = NULL,
         worker_intent_leased_until = NULL
   WHERE id = p_outbox_id AND source_type = 'worker_intent'
     AND status = 'send_unknown' AND worker_intent_lease_token = p_lease_token
     AND worker_intent_leased_until > pg_catalog.now();
  GET DIAGNOSTICS v_updated = ROW_COUNT;
  RETURN v_updated = 1;
END $$;
ALTER FUNCTION public.complete_worker_intent_outbox(UUID, UUID, TEXT) OWNER TO jale_admin;
REVOKE ALL ON FUNCTION public.complete_worker_intent_outbox(UUID, UUID, TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.complete_worker_intent_outbox(UUID, UUID, TEXT) TO jale_whatsapp;

CREATE OR REPLACE FUNCTION public.fail_worker_intent_outbox(
  p_outbox_id UUID, p_lease_token UUID, p_error TEXT, p_ambiguous BOOLEAN
)
RETURNS BOOLEAN
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE v_updated INTEGER;
BEGIN
  IF p_outbox_id IS NULL OR p_lease_token IS NULL OR p_ambiguous IS NULL THEN
    RAISE EXCEPTION 'invalid worker intent failure' USING ERRCODE = '22023';
  END IF;
  UPDATE public.whatsapp_outbox
     SET status = CASE WHEN p_ambiguous THEN 'send_unknown'
                       WHEN attempt_count >= 5 THEN 'failed' ELSE 'pending' END,
         last_error = LEFT(COALESCE(p_error, 'worker intent send failed'), 1000),
         next_attempt_at = CASE
           WHEN p_ambiguous OR attempt_count >= 5 THEN NULL
           ELSE pg_catalog.now() + interval '1 second'
             * LEAST(1800, 30 * POWER(2, GREATEST(attempt_count - 1, 0))) END,
         worker_intent_lease_token = NULL, worker_intent_leased_until = NULL
   WHERE id = p_outbox_id AND source_type = 'worker_intent'
     AND status = 'send_unknown' AND worker_intent_lease_token = p_lease_token
     AND worker_intent_leased_until > pg_catalog.now();
  GET DIAGNOSTICS v_updated = ROW_COUNT;
  RETURN v_updated = 1;
END $$;
ALTER FUNCTION public.fail_worker_intent_outbox(UUID, UUID, TEXT, BOOLEAN) OWNER TO jale_admin;
REVOKE ALL ON FUNCTION public.fail_worker_intent_outbox(UUID, UUID, TEXT, BOOLEAN) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.fail_worker_intent_outbox(UUID, UUID, TEXT, BOOLEAN) TO jale_whatsapp;

-- Keep the intent/source records in lockstep with the one grouped transport
-- row. The helper role is NOLOGIN and already owns the locked Twilio callback
-- functions, so propagation crosses FORCE RLS without giving either
-- application role global table access.
DO $$ BEGIN
  EXECUTE format('GRANT jale_twilio_callback TO %I WITH SET TRUE, INHERIT FALSE', current_user);
END $$;
SET LOCAL ROLE jale_twilio_callback;
CREATE OR REPLACE FUNCTION jale_twilio_callback.propagate_worker_intent_delivery_state()
RETURNS TRIGGER
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_terminal_failure BOOLEAN;
  v_failure_reason TEXT;
BEGIN
  IF NEW.source_type IS DISTINCT FROM 'worker_intent' THEN
    RETURN NEW;
  END IF;

  -- A successful Messages API response is provider acceptance, not final
  -- delivery. Preserve intent='released', but correlate each represented
  -- employer message to the provider SID and acceptance timestamp.
  IF NEW.status = 'sent' AND NEW.twilio_message_sid IS NOT NULL
     AND (OLD.status IS DISTINCT FROM NEW.status
          OR OLD.twilio_message_sid IS DISTINCT FROM NEW.twilio_message_sid) THEN
    UPDATE public.job_conversation_messages message
       SET status = 'sent',
           twilio_message_sid = NEW.twilio_message_sid,
           sent_at = COALESCE(message.sent_at, NEW.sent_at, pg_catalog.now())
      FROM public.worker_message_intents intent
     WHERE intent.outbox_id = NEW.id
       AND intent.source_type = 'job_conversation_message'
       AND message.id = intent.source_id
       AND message.status IN ('queued', 'waiting_worker_reply', 'sent');
  END IF;

  IF NEW.twilio_delivery_status IS DISTINCT FROM OLD.twilio_delivery_status
     AND NEW.twilio_delivery_status IN ('delivered', 'read') THEN
    UPDATE public.worker_message_intents
       SET status = 'delivered', decision_reason = NULL,
           updated_at = pg_catalog.now()
     WHERE outbox_id = NEW.id AND status = 'released';

    UPDATE public.job_conversation_messages message
       SET status = NEW.twilio_delivery_status,
           delivered_at = CASE
             WHEN NEW.twilio_delivery_status = 'delivered'
               THEN COALESCE(message.delivered_at, NEW.twilio_status_updated_at, pg_catalog.now())
             ELSE message.delivered_at
           END
      FROM public.worker_message_intents intent
     WHERE intent.outbox_id = NEW.id
       AND intent.source_type = 'job_conversation_message'
       AND message.id = intent.source_id
       AND message.status IN ('queued', 'waiting_worker_reply', 'sent', 'delivered');
  END IF;

  v_terminal_failure :=
    (NEW.twilio_delivery_status IS DISTINCT FROM OLD.twilio_delivery_status
      AND NEW.twilio_delivery_status IN ('failed', 'undelivered'))
    OR (NEW.status = 'failed' AND OLD.status IS DISTINCT FROM NEW.status)
    OR (NEW.status = 'send_unknown'
      AND NEW.worker_intent_lease_token IS NULL
      AND OLD.worker_intent_lease_token IS NOT NULL);

  IF v_terminal_failure THEN
    v_failure_reason := LEFT(COALESCE(
      NEW.twilio_error_message,
      NEW.twilio_error_code,
      NEW.last_error,
      CASE WHEN NEW.status = 'send_unknown'
        THEN 'worker intent delivery state unknown'
        ELSE 'worker intent delivery failed' END
    ), 1000);

    UPDATE public.worker_message_intents
       SET status = 'failed', decision_reason = v_failure_reason,
           updated_at = pg_catalog.now()
     WHERE outbox_id = NEW.id AND status = 'released';

    UPDATE public.job_conversation_messages message
       SET status = CASE
             WHEN NEW.twilio_delivery_status IN ('failed', 'undelivered')
               THEN NEW.twilio_delivery_status
             ELSE 'failed'
           END
      FROM public.worker_message_intents intent
     WHERE intent.outbox_id = NEW.id
       AND intent.source_type = 'job_conversation_message'
       AND message.id = intent.source_id
       AND message.status IN ('queued', 'waiting_worker_reply', 'sent');
  END IF;

  RETURN NEW;
END $$;
ALTER FUNCTION jale_twilio_callback.propagate_worker_intent_delivery_state()
  OWNER TO jale_twilio_callback;
REVOKE ALL ON FUNCTION jale_twilio_callback.propagate_worker_intent_delivery_state()
  FROM PUBLIC;
DO $$ BEGIN
  EXECUTE format('GRANT USAGE ON SCHEMA jale_twilio_callback TO %I', session_user);
  EXECUTE format('GRANT EXECUTE ON FUNCTION jale_twilio_callback.propagate_worker_intent_delivery_state() TO %I', session_user);
END $$;
RESET ROLE;

DROP TRIGGER IF EXISTS whatsapp_outbox_worker_intent_delivery_state
  ON public.whatsapp_outbox;
CREATE TRIGGER whatsapp_outbox_worker_intent_delivery_state
  AFTER UPDATE OF status, twilio_message_sid, twilio_delivery_status,
                  worker_intent_lease_token
  ON public.whatsapp_outbox
  FOR EACH ROW
  EXECUTE FUNCTION jale_twilio_callback.propagate_worker_intent_delivery_state();

SET LOCAL ROLE jale_twilio_callback;
DO $$ BEGIN
  EXECUTE format('REVOKE ALL ON SCHEMA jale_twilio_callback FROM %I', session_user);
  EXECUTE format('REVOKE ALL ON FUNCTION jale_twilio_callback.propagate_worker_intent_delivery_state() FROM %I', session_user);
END $$;
RESET ROLE;
DO $$ BEGIN
  EXECUTE format('GRANT jale_twilio_callback TO %I WITH SET FALSE, INHERIT FALSE', current_user);
  EXECUTE format('REVOKE jale_twilio_callback FROM %I GRANTED BY %I', current_user, current_user);
END $$;

-- Fail closed if any definer property or ACL drifts.
DO $$
DECLARE fn RECORD; v_count INTEGER := 0;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_policy
     WHERE polname = 'worker_message_intents_definer'
       AND polrelid = 'public.worker_message_intents'::regclass
  ) THEN RAISE EXCEPTION 'migration 043 definer policy self-audit failed'; END IF;

  IF EXISTS (
    SELECT 1 FROM (VALUES
      ('worker_message_intents_twilio_callback_select'),
      ('worker_message_intents_twilio_callback_update')
    ) expected(policy_name)
    WHERE NOT EXISTS (
      SELECT 1 FROM pg_catalog.pg_policy policy
       WHERE policy.polname = expected.policy_name
         AND policy.polrelid = 'public.worker_message_intents'::regclass
    )
  ) THEN
    RAISE EXCEPTION 'migration 043 callback policy self-audit failed';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_policy
     WHERE polname = 'whatsapp_outbox_worker_intent_rpc_only'
       AND polrelid = 'public.whatsapp_outbox'::regclass
       AND NOT polpermissive
  )
  OR pg_catalog.has_column_privilege(
       'jale_whatsapp', 'public.whatsapp_outbox',
       'worker_intent_lease_token', 'UPDATE')
  OR pg_catalog.has_column_privilege(
       'jale_whatsapp', 'public.whatsapp_outbox',
       'worker_intent_leased_until', 'UPDATE')
  OR NOT pg_catalog.has_column_privilege(
       'jale_whatsapp', 'public.whatsapp_outbox', 'status', 'UPDATE')
  THEN
    RAISE EXCEPTION 'migration 043 application-role outbox fencing self-audit failed';
  END IF;

  IF NOT EXISTS (
    SELECT 1
      FROM pg_catalog.pg_index index
      JOIN pg_catalog.pg_class relation ON relation.oid = index.indrelid
      JOIN pg_catalog.pg_class index_relation ON index_relation.oid = index.indexrelid
      JOIN pg_catalog.pg_namespace namespace ON namespace.oid = relation.relnamespace
     WHERE namespace.nspname = 'public'
       AND relation.relname = 'worker_message_intents'
       AND index_relation.relname = 'idx_worker_message_intents_outbox_id'
       AND index.indisvalid
       AND index.indpred IS NOT NULL
  ) THEN
    RAISE EXCEPTION 'migration 043 grouped intent correlation index self-audit failed';
  END IF;

  IF NOT EXISTS (
    SELECT 1
      FROM pg_catalog.pg_proc function
      JOIN pg_catalog.pg_namespace namespace ON namespace.oid = function.pronamespace
      JOIN pg_catalog.pg_roles owner ON owner.oid = function.proowner
      JOIN pg_catalog.pg_trigger trigger ON trigger.tgfoid = function.oid
     WHERE namespace.nspname = 'jale_twilio_callback'
       AND function.proname = 'propagate_worker_intent_delivery_state'
       AND function.prosecdef
       AND owner.rolname = 'jale_twilio_callback'
       AND function.proconfig IS NOT NULL
       AND 'search_path=pg_catalog, pg_temp' = ANY(function.proconfig)
       AND trigger.tgname = 'whatsapp_outbox_worker_intent_delivery_state'
       AND trigger.tgrelid = 'public.whatsapp_outbox'::regclass
       AND NOT trigger.tgisinternal
       AND NOT EXISTS (
         SELECT 1
           FROM pg_catalog.aclexplode(COALESCE(
             function.proacl, pg_catalog.acldefault('f', function.proowner))) acl
          WHERE acl.grantee = 0 AND acl.privilege_type = 'EXECUTE'
       )
  ) THEN
    RAISE EXCEPTION 'migration 043 delivery propagation self-audit failed';
  END IF;

  FOR fn IN
    SELECT p.oid, p.oid::regprocedure AS signature, p.prosecdef,
           r.rolname AS owner, p.proconfig, p.proacl, p.proowner
      FROM pg_catalog.pg_proc p
      JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
      JOIN pg_catalog.pg_roles r ON r.oid = p.proowner
     WHERE n.nspname = 'public' AND p.proname IN (
       'lease_worker_intent_outbox', 'complete_worker_intent_outbox',
       'fail_worker_intent_outbox')
  LOOP
    v_count := v_count + 1;
    IF NOT fn.prosecdef OR fn.owner <> 'jale_admin' OR fn.proconfig IS NULL
       OR NOT ('search_path=pg_catalog, pg_temp' = ANY(fn.proconfig))
       OR EXISTS (
         SELECT 1
           FROM pg_catalog.aclexplode(
             COALESCE(fn.proacl, pg_catalog.acldefault('f', fn.proowner))) acl
          WHERE acl.grantee = 0 AND acl.privilege_type = 'EXECUTE'
       )
       OR NOT has_function_privilege('jale_whatsapp', fn.oid, 'EXECUTE') THEN
      RAISE EXCEPTION 'migration 043 function hardening self-audit failed: %', fn.signature;
    END IF;
  END LOOP;
  IF v_count <> 3 THEN
    RAISE EXCEPTION 'migration 043 expected three transport functions, found %', v_count;
  END IF;
END $$;

COMMIT;
