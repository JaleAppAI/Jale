-- ============================================================
-- 126_job_conversations_whatsapp_update_columns.sql
-- Run manually AFTER 125,
-- connected as jale_admin. Forward-only (ADR-005). ONE transaction.
--
-- Narrows the WhatsApp login's UPDATE on public.job_conversations from the
-- whole row (025) to the five columns its paths write. The writers, all in
-- infra/lambda/lib/job-messaging.ts:
--   recordWorkerConversationReply     last_message_at, last_worker_message_at,
--                                     accepted_at
--   openWorkerConversation (buttons)  last_worker_message_at, accepted_at
--   closeWorkerConversation           status, closed_at
--   declineWorkerConversation         status, closed_at
-- The employer's read marker (employer_last_read_at) and the columns that
-- say whom a conversation is between are written by the request login only
-- (106 grants it its own column list); updated_at is set by the
-- job_conversations_updated_at trigger, which needs no column right.
-- SELECT ... FOR UPDATE, which the reply path uses, needs UPDATE on at least
-- one column, so the column grant keeps it working.
--
-- INSERT is revoked too: no WhatsApp-login path creates a conversation. The
-- employer opens one on the request login (job-messaging.ts
-- createApplicantConversation), and the worker's web message (125) does its
-- INSERT inside a capability function, as that function's owner.
--
-- Unchanged: SELECT (025), the row policy job_conversations_worker_all (025),
-- and every other login's rights.
-- jale_whatsapp predates 104, so 106 (generated from the access manifest for
-- the 104 logins only) is not regenerated; the manifest records the new set.
--
-- REVOKE comes first: revoking a table-level right also clears the column
-- grants of that kind, so the reverse order would leave nothing granted.
--
-- REPLAY. Idempotent: the REVOKEs and the GRANT reach the same end state on
-- every run. A closing check refuses to commit unless the login can UPDATE
-- exactly the five columns, holds no table-level UPDATE and no INSERT, and
-- still reads the table.
--
-- ── PART B: THE DRAIN HONOURS worker_message_intents.expires_at ──
-- Every writer of expires_at sets the instant after which that message is
-- not to be sent: a job alert 72 hours on (job-alert.ts), an employer
-- message or stage change 7 days on (105's employer_claim_worker_intent),
-- the web completion line when the WhatsApp window it was queued for closes
-- or, as its template, 48 hours on (lib/application-web-completion.ts).
-- Onboarding intents carry none. The enqueue (enqueueWorkerMessage), the
-- claim (105) and the worker-ready release all check it through
-- evaluateDelivery or its SQL twin and end such an intent as 'expired'.
-- The drain did not: once an outbox row existed, 043's lease handed it to
-- the sender at any age.
--
--   * lease_worker_intent_outbox is replaced with the same signature and two
--     added conditions: it never leases a pending row whose intent's
--     expires_at has passed, and such a row no longer holds back the same
--     worker's later rows (it will never be sent).
--   * expire_worker_intent_outbox() ends those rows the way 093's 48-hour
--     ceiling ends one: outbox status 'failed', nothing scheduled, the
--     attempt count kept. Every intent the row carries reads 'expired' /
--     'intent_expired', written BEFORE the outbox row so 043's delivery-state
--     trigger finds no 'released' intent to mark 'failed'. It returns the
--     ids it ended, and drainWorkerIntentOutbox counts them in `expired`,
--     which the drain handler already adds to WorkerIntentOutboxFailure.
--   * Only 'pending' rows. A 'send_unknown' row is in flight or of unknown
--     delivery state; settling it stays with the sender and the callbacks.
--
-- DEPLOY ORDER: apply this migration BEFORE deploying the code. The new
-- drain calls expire_worker_intent_outbox(), and a call to a function that
-- does not exist yet fails the whole drain (093's rule). Applied first, the
-- old drain is unaffected: the replaced lease simply skips expired rows,
-- which wait, unsent and holding nothing back, until the new drain ends them.
-- ============================================================
BEGIN;

-- REVOKE and GRANT rewrite the table's ACL; never queue behind a stuck
-- transaction.
SET LOCAL lock_timeout = '5s';

-- ── 1. Preconditions ────────────────────────────────────────
DO $$
DECLARE
  v_columns CONSTANT TEXT[] := ARRAY['status', 'closed_at', 'last_message_at', 'last_worker_message_at', 'accepted_at'];
  v_missing TEXT;
BEGIN
  IF current_user <> 'jale_admin' THEN
    RAISE EXCEPTION 'migration 126: connect as jale_admin (this session runs as %)', current_user;
  END IF;
  IF pg_catalog.to_regclass('public.job_conversations') IS NULL THEN
    RAISE EXCEPTION 'migration 126: public.job_conversations is missing';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'jale_whatsapp') THEN
    RAISE EXCEPTION 'migration 126: role jale_whatsapp is missing';
  END IF;

  SELECT string_agg(want.attname, ', ' ORDER BY want.attname) INTO v_missing
    FROM unnest(v_columns) AS want(attname)
   WHERE NOT EXISTS (
           SELECT 1 FROM pg_catalog.pg_attribute a
            WHERE a.attrelid = 'public.job_conversations'::regclass
              AND a.attname = want.attname
              AND a.attnum > 0
              AND NOT a.attisdropped);
  IF v_missing IS NOT NULL THEN
    RAISE EXCEPTION 'migration 126: job_conversations lacks the columns %', v_missing;
  END IF;
END;
$$;

-- ── 2. The change ───────────────────────────────────────────
REVOKE UPDATE ON public.job_conversations FROM jale_whatsapp;
REVOKE INSERT ON public.job_conversations FROM jale_whatsapp;
GRANT UPDATE (status, closed_at, last_message_at, last_worker_message_at, accepted_at) ON public.job_conversations TO jale_whatsapp;

-- ── 3. Closing check ────────────────────────────────────────
DO $$
DECLARE
  v_columns CONSTANT TEXT[] := ARRAY['status', 'closed_at', 'last_message_at', 'last_worker_message_at', 'accepted_at'];
  v_drift TEXT;
BEGIN
  -- Every live column: UPDATE allowed exactly when it is one of the five.
  SELECT string_agg(a.attname || CASE WHEN a.attname = ANY (v_columns) THEN ' (missing)' ELSE ' (extra)' END,
                    ', ' ORDER BY a.attname)
    INTO v_drift
    FROM pg_catalog.pg_attribute a
   WHERE a.attrelid = 'public.job_conversations'::regclass
     AND a.attnum > 0
     AND NOT a.attisdropped
     AND pg_catalog.has_column_privilege('jale_whatsapp', 'public.job_conversations'::regclass, a.attname, 'UPDATE')
         IS DISTINCT FROM (a.attname = ANY (v_columns));
  IF v_drift IS NOT NULL THEN
    RAISE EXCEPTION 'migration 126: jale_whatsapp UPDATE rights on job_conversations drifted: %', v_drift;
  END IF;

  IF pg_catalog.has_table_privilege('jale_whatsapp', 'public.job_conversations', 'UPDATE') THEN
    RAISE EXCEPTION 'migration 126: jale_whatsapp still holds a table-level right it should not (UPDATE)';
  END IF;
  IF pg_catalog.has_any_column_privilege('jale_whatsapp', 'public.job_conversations', 'INSERT') THEN
    RAISE EXCEPTION 'migration 126: jale_whatsapp still holds a table-level right it should not (INSERT)';
  END IF;
  -- What the engine still needs, unchanged by this file.
  IF NOT pg_catalog.has_table_privilege('jale_whatsapp', 'public.job_conversations', 'SELECT') THEN
    RAISE EXCEPTION 'migration 126: jale_whatsapp lost SELECT on job_conversations';
  END IF;
END;
$$;

-- ── 4. The lease skips an expired row (part B) ──────────────
-- 043's function, unchanged except for the two conditions marked 126. Same
-- signature and result, so CREATE OR REPLACE keeps its owner and grants;
-- the closing check below re-reads both.
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
       -- 126: never past the intent's expiry.
       AND (i.expires_at IS NULL OR i.expires_at > pg_catalog.now())
       AND NOT EXISTS (
         SELECT 1
           FROM public.whatsapp_outbox earlier_o
           JOIN public.worker_message_intents earlier_i ON earlier_i.id = earlier_o.source_id
          WHERE earlier_o.source_type = 'worker_intent'
            AND earlier_i.user_id = i.user_id
            AND earlier_o.status IN ('pending', 'send_unknown')
            -- 126: an expired pending row is never sent, so it holds nothing back.
            AND NOT (earlier_o.status = 'pending'
                     AND earlier_i.expires_at IS NOT NULL
                     AND earlier_i.expires_at <= pg_catalog.now())
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

-- ── 5. The expiry pass (part B) ─────────────────────────────
-- Called by the drain before each lease. Ends every pending worker_intent
-- row whose intent's expires_at has passed and returns the ids it ended.
-- A row another session holds is skipped (SKIP LOCKED) and ended on the
-- next pass. The intent is read through the outbox row's source_id, the
-- same join the lease uses; a grouped row (one message for several
-- intents) ends every intent it carries.
CREATE OR REPLACE FUNCTION public.expire_worker_intent_outbox()
RETURNS TABLE (id UUID)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_ids UUID[];
BEGIN
  SELECT COALESCE(pg_catalog.array_agg(o.id), ARRAY[]::UUID[]) INTO v_ids
    FROM (
      SELECT o.id
        FROM public.whatsapp_outbox o
        JOIN public.worker_message_intents i ON i.id = o.source_id
       WHERE o.source_type = 'worker_intent'
         AND o.status = 'pending'
         AND i.expires_at IS NOT NULL
         AND i.expires_at <= pg_catalog.now()
         FOR UPDATE OF o SKIP LOCKED
    ) o;

  IF pg_catalog.cardinality(v_ids) = 0 THEN
    RETURN;
  END IF;

  -- The intents first: 043's whatsapp_outbox_worker_intent_delivery_state
  -- trigger marks a 'released' intent 'failed' when its outbox row fails,
  -- and an intent already 'expired' is not one it touches.
  UPDATE public.worker_message_intents wi
     SET status = 'expired', decision_reason = 'intent_expired',
         updated_at = pg_catalog.now()
   WHERE wi.outbox_id = ANY (v_ids)
     AND wi.status IN ('eligible', 'released');

  RETURN QUERY
  WITH ended AS (
    UPDATE public.whatsapp_outbox o
       SET status = 'failed', next_attempt_at = NULL,
           last_error = 'worker intent expired before sending'
     WHERE o.id = ANY (v_ids)
       AND o.source_type = 'worker_intent'
       AND o.status = 'pending'
    RETURNING o.id
  )
  SELECT ended.id FROM ended;
END $$;
ALTER FUNCTION public.expire_worker_intent_outbox() OWNER TO jale_admin;
REVOKE ALL ON FUNCTION public.expire_worker_intent_outbox() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.expire_worker_intent_outbox() TO jale_whatsapp;

-- ── 6. Closing check (part B) ───────────────────────────────
-- Both functions: SECURITY DEFINER, owned by jale_admin, search_path pinned,
-- EXECUTE for jale_whatsapp and not for PUBLIC.
DO $$
DECLARE
  v_signature TEXT;
  v_oid OID;
BEGIN
  FOREACH v_signature IN ARRAY ARRAY[
    'public.lease_worker_intent_outbox(integer)',
    'public.expire_worker_intent_outbox()'
  ] LOOP
    v_oid := pg_catalog.to_regprocedure(v_signature)::oid;
    IF v_oid IS NULL THEN
      RAISE EXCEPTION 'migration 126: % is missing', v_signature;
    END IF;
    IF NOT EXISTS (
      SELECT 1
        FROM pg_catalog.pg_proc p
        JOIN pg_catalog.pg_roles r ON r.oid = p.proowner
       WHERE p.oid = v_oid
         AND p.prosecdef
         AND r.rolname = 'jale_admin'
         AND p.proconfig IS NOT NULL
         AND 'search_path=pg_catalog, pg_temp' = ANY (p.proconfig)
    ) THEN
      RAISE EXCEPTION 'migration 126: % has the wrong owner, security or search_path', v_signature;
    END IF;
    IF NOT pg_catalog.has_function_privilege('jale_whatsapp', v_oid, 'EXECUTE') THEN
      RAISE EXCEPTION 'migration 126: jale_whatsapp cannot execute %', v_signature;
    END IF;
    IF EXISTS (
      SELECT 1
        FROM pg_catalog.pg_proc p,
             pg_catalog.aclexplode(COALESCE(p.proacl, pg_catalog.acldefault('f', p.proowner))) a
       WHERE p.oid = v_oid AND a.grantee = 0 AND a.privilege_type = 'EXECUTE'
    ) THEN
      RAISE EXCEPTION 'migration 126: PUBLIC can execute %', v_signature;
    END IF;
  END LOOP;
END;
$$;

COMMIT;
