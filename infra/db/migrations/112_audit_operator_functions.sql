-- ============================================================
-- 112_audit_operator_functions.sql
-- Run manually AFTER 111_audit_change_log.sql,
-- connected as jale_admin. Forward-only (ADR-005). ONE transaction.
--
-- Sprint 27, audit records, part 4 of 4. Operator read functions, and the procedures that manage
-- personal operator logins.
--
-- (1) jale_ops holds the operator read functions. Each is a definer owned by
--     jale_ops_owner with a pinned search_path, executable by the operator
--     group jale_ops_readonly. The two audit count functions are also
--     executable by jale_admin, for the release checks that run before any
--     personal login exists. They return identifiers, codes, times and
--     counts only: never a name, a contact value, message text, an answer,
--     a score or error text.
--       find_user(kind, value)          the users.id for an email address,
--                                       a phone or WhatsApp number, or a
--                                       sign-in subject, passed as a bound
--                                       parameter; NULL when none matches
--       user_status(user_id)            account codes and times
--       onboarding_status(user_id)      onboarding state, workflow runs and
--                                       steps, identity challenges
--       trust_assessment_status(user_id) assessment statuses, no scores
--       outbox_status(user_id)          domain events and message intents
--       delivery_status(user_id)        WhatsApp, job message and email
--                                       delivery statuses
--       migration_ledger()              the migration ledger
--       audit_export_status()           the archive export, per stream
--       audit_event_counts(since)       access events per kind, outcome and
--                                       surface since a time
--
-- (2) The owner's reads. jale_ops_owner holds SELECT on exactly the columns
--     these functions read, and one SELECT policy of its own on each of
--     those tables with row security. The migration ledger is granted only
--     where it exists: scripts/run-migrations.sh keeps it, and a database
--     migrated by hand may lack it. No role but jale_audit_owner reads an
--     audit table, so the two audit counts call two count-only definers
--     that jale_audit_owner adds to jale_audit, executable by jale_ops_owner
--     alone.
--
-- (2b) The held-row listing. jale_audit.list_holds() lists, for the
--     master's supervised release or redaction of held rows, each row the
--     export job held back and nobody has released: its stream, seq, time
--     and surface, when it was held, and the kind of value its free text
--     holds ('url', 'email', 'phone', 'several' or 'none'). Never the text,
--     nor a subject. EXECUTE: jale_admin only. The kind comes from
--     jale_audit.value_span_kind(text), which applies migration 110's
--     value-span patterns in 110's order, so it names exactly what the
--     shared redaction removes.
--
-- (3) Personal operator logins: a section of its own (section 5), with its
--     own checks; nothing else in this file depends on it.
--     provision_person(handle, verifier, valid_days), renew_person(handle,
--     verifier, valid_days) and remove_person(handle) are invoker
--     procedures that jale_admin runs; PUBLIC holds no EXECUTE. A login is
--     jale_person_<handle>: LOGIN, CONNECTION LIMIT 2, a VALID UNTIL at most
--     90 days ahead, a SCRAM-SHA-256 verifier computed by the person (never
--     a password), a member of jale_ops_readonly WITH INHERIT TRUE, SET
--     FALSE and of nothing else, read-only by default with a 30-second
--     statement timeout, and statement audit logging when the pgaudit
--     extension is installed. It owns nothing and holds no table, column or
--     sequence privilege. The procedures never print the verifier.
--
-- infra/db/access/AUDIT.md documents every signature.
--
-- DEPLOY ORDER: apply after 111 and BEFORE the release deploy. The deployed
-- code never calls jale_ops, so it keeps working unchanged.
--
-- REPLAY. Refused with a clear message once jale_ops holds a function.
-- ============================================================
BEGIN;

-- CREATE POLICY takes a SHARE ROW EXCLUSIVE lock on each table it reads;
-- never queue behind a stuck transaction. A timed-out apply writes no ledger
-- row and can simply be rerun.
SET LOCAL lock_timeout = '5s';

DO $$
BEGIN
  IF pg_catalog.to_regnamespace('jale_ops') IS NULL OR pg_catalog.to_regrole('jale_ops_owner') IS NULL
     OR pg_catalog.to_regrole('jale_ops_readonly') IS NULL THEN
    RAISE EXCEPTION 'migration 112: apply the audit storage (109) first';
  END IF;
  IF pg_catalog.to_regprocedure('jale_audit.capture_change()') IS NULL THEN
    RAISE EXCEPTION 'migration 112: apply the change records (111) first';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_proc p WHERE p.pronamespace = 'jale_ops'::regnamespace) THEN
    RAISE EXCEPTION 'migration 112: already applied (jale_ops holds functions); it is not re-runnable';
  END IF;
END;
$$;

-- ── 1. Open the SET window (082's sequence, as 109) ─────────
DO $$
DECLARE
  role_name TEXT;
BEGIN
  FOREACH role_name IN ARRAY ARRAY['jale_audit_owner', 'jale_ops_owner'] LOOP
    EXECUTE format('GRANT %I TO %I WITH SET TRUE, INHERIT FALSE', role_name, current_user);
  END LOOP;
END;
$$;

-- ── 2. The owner's reads ────────────────────────────────────
-- Exactly the columns the functions below read, and one SELECT policy per
-- table with row security. Every output is built from these columns; the
-- contact columns are read only to match a lookup or to report presence.
GRANT SELECT (id, user_type, tenant_id, cognito_sub, email, phone, whatsapp_number, whatsapp_linked_at,
              tos_version, tos_accepted_at, privacy_version, privacy_accepted_at, created_at, updated_at)
  ON public.users TO jale_ops_owner;
CREATE POLICY users_ops_owner_read ON public.users
  FOR SELECT TO jale_ops_owner USING (true);

GRANT SELECT (id, user_id, lifecycle, lifecycle_changed_at, ready_at, created_at, updated_at)
  ON public.worker_onboarding_state TO jale_ops_owner;
CREATE POLICY worker_onboarding_state_ops_owner_read ON public.worker_onboarding_state
  FOR SELECT TO jale_ops_owner USING (true);

GRANT SELECT (id, user_id, current_step_key, status, created_at, updated_at, completed_at)
  ON public.worker_workflow_runs TO jale_ops_owner;
CREATE POLICY worker_workflow_runs_ops_owner_read ON public.worker_workflow_runs
  FOR SELECT TO jale_ops_owner USING (true);

GRANT SELECT (id, run_id, from_step_key, to_step_key, created_at)
  ON public.worker_workflow_transitions TO jale_ops_owner;
CREATE POLICY worker_workflow_transitions_ops_owner_read ON public.worker_workflow_transitions
  FOR SELECT TO jale_ops_owner USING (true);

GRANT SELECT (id, candidate_user_id, verified_user_id, current_step_key, status, attempts, expires_at,
              locked_until, created_at, updated_at)
  ON public.worker_identity_challenges TO jale_ops_owner;
CREATE POLICY worker_identity_challenges_ops_owner_read ON public.worker_identity_challenges
  FOR SELECT TO jale_ops_owner USING (true);

GRANT SELECT (id, user_id, profession_key, status, rubric_version, scoring_model_id, created_at, scored_at)
  ON public.worker_trust_assessments TO jale_ops_owner;
CREATE POLICY worker_trust_assessments_ops_owner_read ON public.worker_trust_assessments
  FOR SELECT TO jale_ops_owner USING (true);

GRANT SELECT (id, event_type, aggregate_id, status, attempts, next_attempt_at, created_at, updated_at)
  ON public.worker_domain_outbox TO jale_ops_owner;
CREATE POLICY worker_domain_outbox_ops_owner_read ON public.worker_domain_outbox
  FOR SELECT TO jale_ops_owner USING (true);

GRANT SELECT (id, user_id, category, owner_service, status, priority, expires_at, outbox_id, created_at, updated_at)
  ON public.worker_message_intents TO jale_ops_owner;
CREATE POLICY worker_message_intents_ops_owner_read ON public.worker_message_intents
  FOR SELECT TO jale_ops_owner USING (true);

GRANT SELECT (id, whatsapp_number, source_type, status, twilio_delivery_status, twilio_error_code, attempt_count,
              next_attempt_at, created_at, sent_at, twilio_status_updated_at)
  ON public.whatsapp_outbox TO jale_ops_owner;
CREATE POLICY whatsapp_outbox_ops_owner_read ON public.whatsapp_outbox
  FOR SELECT TO jale_ops_owner USING (true);

GRANT SELECT (id, whatsapp_number, send_kind, status, attempt_count, created_at, sent_at)
  ON public.job_message_outbox TO jale_ops_owner;
CREATE POLICY job_message_outbox_ops_owner_read ON public.job_message_outbox
  FOR SELECT TO jale_ops_owner USING (true);

GRANT SELECT (id, recipient_email, source_type, status, attempt_count, next_attempt_at, created_at, sent_at)
  ON public.email_outbox TO jale_ops_owner;
CREATE POLICY email_outbox_ops_owner_read ON public.email_outbox
  FOR SELECT TO jale_ops_owner USING (true);

-- The migration ledger has no row security. Granted only where it exists.
DO $$
BEGIN
  IF pg_catalog.to_regclass('public.schema_migrations') IS NOT NULL THEN
    GRANT SELECT (filename, applied_at, checksum, applied_by) ON public.schema_migrations TO jale_ops_owner;
  END IF;
END;
$$;

-- ── 3. jale_audit: the two count-only definers ──────────────
SET LOCAL ROLE jale_audit_owner;

-- Per stream: the watermark, the batches, and the rows held back for review.
-- held_rows counts held rows not yet exported in a release batch;
-- released_pending counts those of them released and waiting for one.
CREATE FUNCTION jale_audit.export_status()
RETURNS TABLE (
  stream            TEXT,
  watermark         XID8,
  watermark_at      TIMESTAMPTZ,
  unexported_rows   BIGINT,
  batches           BIGINT,
  last_batch_at     TIMESTAMPTZ,
  last_batch_rows   INTEGER,
  held_rows         BIGINT,
  released_pending  BIGINT
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $fn$
  SELECT s.stream, s.watermark, s.updated_at,
         CASE s.stream
           WHEN 'events' THEN (SELECT count(*) FROM jale_audit.events e WHERE e.xact >= s.watermark)
           WHEN 'changes' THEN (SELECT count(*) FROM jale_audit.changes c WHERE c.xact >= s.watermark)
           ELSE (SELECT count(*) FROM public.admin_audit_log l WHERE l.xact >= s.watermark)
         END,
         (SELECT count(*) FROM jale_audit.export_batches b WHERE b.stream = s.stream),
         (SELECT max(b.committed_at) FROM jale_audit.export_batches b WHERE b.stream = s.stream),
         (SELECT b.row_count FROM jale_audit.export_batches b WHERE b.stream = s.stream ORDER BY b.seq DESC LIMIT 1),
         (SELECT count(*) FROM jale_audit.export_holds h
           WHERE h.stream = s.stream AND h.action = 'hold'
             AND NOT EXISTS (SELECT 1 FROM jale_audit.export_holds x
                              WHERE x.stream = h.stream AND x.row_seq = h.row_seq AND x.action = 'export')),
         (SELECT count(*) FROM jale_audit.export_holds h
           WHERE h.stream = s.stream AND h.action = 'release'
             AND NOT EXISTS (SELECT 1 FROM jale_audit.export_holds x
                              WHERE x.stream = h.stream AND x.row_seq = h.row_seq AND x.action = 'export'))
    FROM jale_audit.export_state s
   ORDER BY s.stream;
$fn$;
REVOKE ALL ON FUNCTION jale_audit.export_status() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION jale_audit.export_status() TO jale_ops_owner;

-- Access events since a time, counted per kind, outcome and surface.
CREATE FUNCTION jale_audit.event_counts(p_since TIMESTAMPTZ)
RETURNS TABLE (kind TEXT, outcome TEXT, surface TEXT, events BIGINT)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $fn$
BEGIN
  IF p_since IS NULL THEN
    RAISE EXCEPTION 'event_counts: since is required' USING ERRCODE = '22023';
  END IF;
  RETURN QUERY
    SELECT e.kind, e.outcome, e.surface, count(*)
      FROM jale_audit.events e
     WHERE e.occurred_at >= p_since
     GROUP BY e.kind, e.outcome, e.surface
     ORDER BY e.kind, e.outcome, e.surface;
END;
$fn$;
REVOKE ALL ON FUNCTION jale_audit.event_counts(timestamptz) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION jale_audit.event_counts(timestamptz) TO jale_ops_owner;

-- The kind of value a text holds, by the shared value-span rule: the
-- patterns of jale_audit.redact_value_spans (migration 110), character for
-- character and in its order, each applied to what the earlier ones left.
-- 'url', 'email' or 'phone' when one kind is found, 'several' when more than
-- one, 'none' when none is or the text is NULL. The owner's own helper.
CREATE FUNCTION jale_audit.value_span_kind(p_text TEXT)
RETURNS TEXT
LANGUAGE sql
IMMUTABLE
SET search_path = pg_catalog, pg_temp
AS $fn$
  SELECT CASE (x.url::int + x.email::int + x.phone::int)
           WHEN 0 THEN 'none'
           WHEN 1 THEN CASE WHEN x.url THEN 'url' WHEN x.email THEN 'email' ELSE 'phone' END
           ELSE 'several'
         END
    FROM (
      SELECT t.t0 IS DISTINCT FROM t.t1 AS url, t.t1 IS DISTINCT FROM t.t2 AS email, t.t2 IS DISTINCT FROM t.t3 AS phone
        FROM (
          SELECT u.t0, u.t1, u.t2,
                 regexp_replace(
                   regexp_replace(
                     regexp_replace(
                       u.t2,
                       '\+[0-9]{10,15}(?![0-9])', '[removed]', 'g'),
                     '\([0-9]{3}\) ?[0-9]{3}-[0-9]{4}(?![[:alnum:]_])', '[removed]', 'g'),
                   '(?<![[:alnum:]_])([0-9]{3}-[0-9]{3}-[0-9]{4}|[0-9]{3}\.[0-9]{3}\.[0-9]{4}|[0-9]{3} [0-9]{3} [0-9]{4})(?![[:alnum:]_])',
                   '[removed]', 'g') AS t3
            FROM (
              SELECT v.t0, v.t1,
                     regexp_replace(v.t1, '[A-Za-z0-9._%+-]+@([A-Za-z0-9-]+\.)+[A-Za-z]{2,63}(?![A-Za-z0-9-])', '[removed]', 'g') AS t2
                FROM (SELECT p_text AS t0, regexp_replace(p_text, 'https?://[^[:space:]]*', '[removed]', 'gi') AS t1) v
            ) u
        ) t
    ) x
$fn$;
REVOKE ALL ON FUNCTION jale_audit.value_span_kind(text) FROM PUBLIC;

-- Every held row nobody has released, oldest stream position first. The
-- free text is read only to name the kind of value it holds: an event's
-- reason, a dashboard record's metadata; a change record has none.
CREATE FUNCTION jale_audit.list_holds()
RETURNS TABLE (
  stream       TEXT,
  seq          BIGINT,
  occurred_at  TIMESTAMPTZ,
  surface      TEXT,
  held_at      TIMESTAMPTZ,
  pattern_kind TEXT
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $fn$
  SELECT h.stream, h.row_seq,
         COALESCE(e.occurred_at, c.occurred_at, l.created_at),
         COALESCE(e.surface, c.surface),
         h.recorded_at,
         CASE h.stream
           WHEN 'events' THEN jale_audit.value_span_kind(e.reason)
           WHEN 'admin_actions_legacy' THEN jale_audit.value_span_kind(l.metadata::text)
           ELSE 'none'
         END
    FROM jale_audit.export_holds h
    LEFT JOIN jale_audit.events e ON h.stream = 'events' AND e.seq = h.row_seq
    LEFT JOIN jale_audit.changes c ON h.stream = 'changes' AND c.seq = h.row_seq
    LEFT JOIN public.admin_audit_log l ON h.stream = 'admin_actions_legacy' AND l.seq = h.row_seq
   WHERE h.action = 'hold'
     AND NOT EXISTS (SELECT 1 FROM jale_audit.export_holds r
                      WHERE r.stream = h.stream AND r.row_seq = h.row_seq AND r.action = 'release')
   ORDER BY h.stream, h.row_seq;
$fn$;
REVOKE ALL ON FUNCTION jale_audit.list_holds() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION jale_audit.list_holds() TO jale_admin;

GRANT USAGE ON SCHEMA jale_audit TO jale_ops_owner;
RESET ROLE;

-- ── 4. jale_ops: the operator read functions ────────────────
SET LOCAL ROLE jale_ops_owner;

-- The users.id for one lookup value. The value is never echoed: not in an
-- error, not in a notice. Email addresses match without regard to case;
-- phone and WhatsApp numbers match on their digits, so punctuation and
-- spacing do not matter. More than one match is refused (21000).
CREATE FUNCTION jale_ops.find_user(p_kind TEXT, p_value TEXT)
RETURNS UUID
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $fn$
DECLARE
  v_ids    UUID[];
  v_value  TEXT;
  v_digits TEXT;
BEGIN
  IF p_kind IS NULL OR p_kind NOT IN ('email', 'phone', 'whatsapp', 'cognito_sub') THEN
    RAISE EXCEPTION 'find_user: the kind must be email, phone, whatsapp or cognito_sub' USING ERRCODE = '22023';
  END IF;
  v_value := btrim(p_value);
  IF v_value IS NULL OR v_value = '' OR length(v_value) > 320 THEN
    RAISE EXCEPTION 'find_user: the value must be 1 to 320 characters' USING ERRCODE = '22023';
  END IF;

  IF p_kind = 'email' THEN
    SELECT array_agg(u.id) INTO v_ids FROM public.users u WHERE lower(u.email) = lower(v_value);
  ELSIF p_kind = 'cognito_sub' THEN
    SELECT array_agg(u.id) INTO v_ids FROM public.users u WHERE u.cognito_sub = v_value;
  ELSE
    v_digits := regexp_replace(v_value, '[^0-9]', '', 'g');
    IF length(v_digits) NOT BETWEEN 7 AND 15 THEN
      RAISE EXCEPTION 'find_user: a phone or WhatsApp number needs 7 to 15 digits' USING ERRCODE = '22023';
    END IF;
    IF p_kind = 'phone' THEN
      SELECT array_agg(u.id) INTO v_ids FROM public.users u
       WHERE u.phone IS NOT NULL AND regexp_replace(u.phone, '[^0-9]', '', 'g') = v_digits;
    ELSE
      SELECT array_agg(u.id) INTO v_ids FROM public.users u
       WHERE u.whatsapp_number IS NOT NULL AND regexp_replace(u.whatsapp_number, '[^0-9]', '', 'g') = v_digits;
    END IF;
  END IF;

  IF cardinality(v_ids) > 1 THEN
    RAISE EXCEPTION 'find_user: % users match; look the user up by another kind', cardinality(v_ids)
      USING ERRCODE = '21000';
  END IF;
  RETURN v_ids[1];
END;
$fn$;

-- One user's account codes and times; contact values only as presence.
CREATE FUNCTION jale_ops.user_status(p_user_id UUID)
RETURNS TABLE (
  user_id             UUID,
  user_type           TEXT,
  tenant_id           UUID,
  has_email           BOOLEAN,
  has_phone           BOOLEAN,
  has_whatsapp        BOOLEAN,
  whatsapp_linked_at  TIMESTAMPTZ,
  tos_version         TEXT,
  tos_accepted_at     TIMESTAMPTZ,
  privacy_version     TEXT,
  privacy_accepted_at TIMESTAMPTZ,
  created_at          TIMESTAMPTZ,
  updated_at          TIMESTAMPTZ
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $fn$
  SELECT u.id, u.user_type, u.tenant_id, u.email IS NOT NULL, u.phone IS NOT NULL, u.whatsapp_number IS NOT NULL,
         u.whatsapp_linked_at, u.tos_version, u.tos_accepted_at, u.privacy_version, u.privacy_accepted_at,
         u.created_at, u.updated_at
    FROM public.users u
   WHERE u.id = p_user_id;
$fn$;

-- One worker's onboarding: the state row, the workflow runs, the newest 100
-- step changes, and the identity challenges naming the user. Each row's
-- source says which; columns a source does not have are NULL.
--   onboarding_state    status = lifecycle, changed_at = lifecycle change,
--                       completed_at = ready
--   workflow_run        status, step_key = current step
--   workflow_transition run_id, step_key = from, to_step_key = to
--   identity_challenge  status, step_key = current step, attempts,
--                       expires_at, locked_until
CREATE FUNCTION jale_ops.onboarding_status(p_user_id UUID)
RETURNS TABLE (
  source        TEXT,
  record_id     UUID,
  run_id        UUID,
  status        TEXT,
  step_key      TEXT,
  to_step_key   TEXT,
  attempts      INTEGER,
  created_at    TIMESTAMPTZ,
  changed_at    TIMESTAMPTZ,
  completed_at  TIMESTAMPTZ,
  expires_at    TIMESTAMPTZ,
  locked_until  TIMESTAMPTZ
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $fn$
  SELECT x.source, x.record_id, x.run_id, x.status, x.step_key, x.to_step_key, x.attempts,
         x.created_at, x.changed_at, x.completed_at, x.expires_at, x.locked_until
    FROM (
      SELECT 1 AS ord, 'onboarding_state'::text AS source, s.id AS record_id, NULL::uuid AS run_id,
             s.lifecycle AS status, NULL::text AS step_key, NULL::text AS to_step_key, NULL::integer AS attempts,
             s.created_at, s.lifecycle_changed_at AS changed_at, s.ready_at AS completed_at,
             NULL::timestamptz AS expires_at, NULL::timestamptz AS locked_until
        FROM public.worker_onboarding_state s
       WHERE s.user_id = p_user_id
      UNION ALL
      SELECT 2, 'workflow_run', r.id, NULL, r.status, r.current_step_key, NULL, NULL,
             r.created_at, r.updated_at, r.completed_at, NULL, NULL
        FROM public.worker_workflow_runs r
       WHERE r.user_id = p_user_id
      UNION ALL
      SELECT 3, 'workflow_transition', t.id, t.run_id, NULL, t.from_step_key, t.to_step_key, NULL,
             t.created_at, NULL, NULL, NULL, NULL
        FROM (SELECT t.id, t.run_id, t.from_step_key, t.to_step_key, t.created_at
                FROM public.worker_workflow_transitions t
                JOIN public.worker_workflow_runs r ON r.id = t.run_id
               WHERE r.user_id = p_user_id
               ORDER BY t.created_at DESC, t.id DESC
               LIMIT 100) t
      UNION ALL
      SELECT 4, 'identity_challenge', c.id, NULL, c.status, c.current_step_key, NULL, c.attempts,
             c.created_at, c.updated_at, NULL, c.expires_at, c.locked_until
        FROM public.worker_identity_challenges c
       WHERE c.candidate_user_id = p_user_id OR c.verified_user_id = p_user_id
    ) x
   ORDER BY x.ord, x.created_at, x.record_id;
$fn$;

-- One worker's trust assessments: statuses and versions, never a score, a
-- component, a rationale or an answer.
CREATE FUNCTION jale_ops.trust_assessment_status(p_user_id UUID)
RETURNS TABLE (
  assessment_id    UUID,
  profession_key   TEXT,
  status           TEXT,
  rubric_version   TEXT,
  scoring_model_id TEXT,
  created_at       TIMESTAMPTZ,
  scored_at        TIMESTAMPTZ
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $fn$
  SELECT a.id, a.profession_key, a.status, a.rubric_version, a.scoring_model_id, a.created_at, a.scored_at
    FROM public.worker_trust_assessments a
   WHERE a.user_id = p_user_id
   ORDER BY a.created_at DESC, a.id;
$fn$;

-- One worker's domain events and message intents, newest 200: types,
-- statuses, attempts and times. Never a payload, a key or error text.
--   domain_event    kind = event type
--   message_intent  kind = category, service = owner service, outbox_id
CREATE FUNCTION jale_ops.outbox_status(p_user_id UUID)
RETURNS TABLE (
  source          TEXT,
  record_id       UUID,
  kind            TEXT,
  service         TEXT,
  status          TEXT,
  attempts        INTEGER,
  priority        INTEGER,
  outbox_id       UUID,
  created_at      TIMESTAMPTZ,
  updated_at      TIMESTAMPTZ,
  next_attempt_at TIMESTAMPTZ,
  expires_at      TIMESTAMPTZ
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $fn$
  SELECT x.source, x.record_id, x.kind, x.service, x.status, x.attempts, x.priority, x.outbox_id,
         x.created_at, x.updated_at, x.next_attempt_at, x.expires_at
    FROM (
      SELECT 'domain_event'::text AS source, d.id AS record_id, d.event_type AS kind, NULL::text AS service,
             d.status, d.attempts, NULL::integer AS priority, NULL::uuid AS outbox_id,
             d.created_at, d.updated_at, d.next_attempt_at, NULL::timestamptz AS expires_at
        FROM public.worker_domain_outbox d
       WHERE d.aggregate_id = p_user_id
      UNION ALL
      SELECT 'message_intent', i.id, i.category, i.owner_service, i.status, NULL, i.priority, i.outbox_id,
             i.created_at, i.updated_at, NULL, i.expires_at
        FROM public.worker_message_intents i
       WHERE i.user_id = p_user_id
    ) x
   ORDER BY x.created_at DESC, x.record_id
   LIMIT 200;
$fn$;

-- One user's message deliveries, newest 200: WhatsApp messages and job
-- messages to the user's WhatsApp number, and email to the user's address.
-- Statuses, provider status codes, attempts and times only; never a body,
-- a template, a provider message id or error text.
--   whatsapp     kind = source type ('reply' for a reply to an inbound
--                message), provider_status = the provider's delivery
--                status, provider_error_code = its numeric error code
--   job_message  kind = send kind
--   email        kind = source type
CREATE FUNCTION jale_ops.delivery_status(p_user_id UUID)
RETURNS TABLE (
  channel             TEXT,
  record_id           UUID,
  kind                TEXT,
  status              TEXT,
  provider_status     TEXT,
  provider_error_code TEXT,
  attempts            INTEGER,
  created_at          TIMESTAMPTZ,
  sent_at             TIMESTAMPTZ,
  status_updated_at   TIMESTAMPTZ,
  next_attempt_at     TIMESTAMPTZ
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $fn$
  SELECT x.channel, x.record_id, x.kind, x.status, x.provider_status, x.provider_error_code, x.attempts,
         x.created_at, x.sent_at, x.status_updated_at, x.next_attempt_at
    FROM (
      SELECT 'whatsapp'::text AS channel, o.id AS record_id, COALESCE(o.source_type, 'reply') AS kind, o.status,
             o.twilio_delivery_status AS provider_status, o.twilio_error_code AS provider_error_code,
             o.attempt_count AS attempts, o.created_at, o.sent_at, o.twilio_status_updated_at AS status_updated_at,
             o.next_attempt_at
        FROM public.users u
        JOIN public.whatsapp_outbox o ON o.whatsapp_number = u.whatsapp_number
       WHERE u.id = p_user_id
      UNION ALL
      SELECT 'job_message', o.id, o.send_kind, o.status, NULL, NULL, o.attempt_count, o.created_at, o.sent_at, NULL, NULL
        FROM public.users u
        JOIN public.job_message_outbox o ON o.whatsapp_number = u.whatsapp_number
       WHERE u.id = p_user_id
      UNION ALL
      SELECT 'email', o.id, o.source_type, o.status, NULL, NULL, o.attempt_count, o.created_at, o.sent_at, NULL,
             o.next_attempt_at
        FROM public.users u
        JOIN public.email_outbox o ON lower(o.recipient_email) = lower(u.email)
       WHERE u.id = p_user_id
    ) x
   ORDER BY x.created_at DESC, x.record_id
   LIMIT 200;
$fn$;

-- The migration ledger, in file order. No rows where the ledger does not
-- exist.
CREATE FUNCTION jale_ops.migration_ledger()
RETURNS TABLE (filename TEXT, applied_at TIMESTAMPTZ, checksum TEXT, applied_by TEXT)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $fn$
BEGIN
  IF pg_catalog.to_regclass('public.schema_migrations') IS NULL THEN
    RETURN;
  END IF;
  RETURN QUERY
    SELECT m.filename, m.applied_at, m.checksum, m.applied_by
      FROM public.schema_migrations m
     ORDER BY m.filename;
END;
$fn$;

-- The archive export, per stream (jale_audit.export_status).
CREATE FUNCTION jale_ops.audit_export_status()
RETURNS TABLE (
  stream            TEXT,
  watermark         XID8,
  watermark_at      TIMESTAMPTZ,
  unexported_rows   BIGINT,
  batches           BIGINT,
  last_batch_at     TIMESTAMPTZ,
  last_batch_rows   INTEGER,
  held_rows         BIGINT,
  released_pending  BIGINT
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $fn$
  SELECT s.stream, s.watermark, s.watermark_at, s.unexported_rows, s.batches, s.last_batch_at, s.last_batch_rows,
         s.held_rows, s.released_pending
    FROM jale_audit.export_status() s;
$fn$;

-- Access events since a time, per kind, outcome and surface
-- (jale_audit.event_counts).
CREATE FUNCTION jale_ops.audit_event_counts(p_since TIMESTAMPTZ)
RETURNS TABLE (kind TEXT, outcome TEXT, surface TEXT, events BIGINT)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $fn$
  SELECT c.kind, c.outcome, c.surface, c.events
    FROM jale_audit.event_counts(p_since) c;
$fn$;

-- Functions this owner creates start closed to PUBLIC (109's default
-- privileges); the REVOKEs say so again.
REVOKE ALL ON FUNCTION
  jale_ops.find_user(text, text),
  jale_ops.user_status(uuid),
  jale_ops.onboarding_status(uuid),
  jale_ops.trust_assessment_status(uuid),
  jale_ops.outbox_status(uuid),
  jale_ops.delivery_status(uuid),
  jale_ops.migration_ledger(),
  jale_ops.audit_export_status(),
  jale_ops.audit_event_counts(timestamptz)
FROM PUBLIC;
GRANT EXECUTE ON FUNCTION
  jale_ops.find_user(text, text),
  jale_ops.user_status(uuid),
  jale_ops.onboarding_status(uuid),
  jale_ops.trust_assessment_status(uuid),
  jale_ops.outbox_status(uuid),
  jale_ops.delivery_status(uuid),
  jale_ops.migration_ledger(),
  jale_ops.audit_export_status(),
  jale_ops.audit_event_counts(timestamptz)
TO jale_ops_readonly;
GRANT EXECUTE ON FUNCTION jale_ops.audit_export_status(), jale_ops.audit_event_counts(timestamptz) TO jale_admin;

GRANT USAGE ON SCHEMA jale_ops TO jale_ops_readonly, jale_admin;
RESET ROLE;

-- ── 5. Personal operator logins ─────────────────────────────
-- A separate unit: the three procedures, their grants and their own checks
-- below. Nothing else in this file uses them.
--
-- Invoker procedures: they run with jale_admin's own rights (CREATEROLE)
-- and hold none of their own. A handle is 2 to 16 lower-case letters and
-- digits, starting with a letter. The verifier is a SCRAM-SHA-256 verifier
-- the person computed from their own password: 4096 or more iterations, a
-- base64 salt, and two 32-byte base64 keys; PostgreSQL stores it as given.
-- No message names the verifier or any rejected input.
SET LOCAL ROLE jale_ops_owner;

CREATE PROCEDURE jale_ops.provision_person(p_handle TEXT, p_verifier TEXT, p_valid_days INTEGER)
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, pg_temp
AS $fn$
DECLARE
  v_role  TEXT;
  v_until TEXT;
  v_oid   OID;
BEGIN
  IF p_handle IS NULL OR p_handle !~ '^[a-z][a-z0-9]{1,15}$' THEN
    RAISE EXCEPTION 'provision_person: the handle must be 2 to 16 lower-case letters and digits, starting with a letter'
      USING ERRCODE = '22023';
  END IF;
  -- The shape first: only then is the iteration count known to be digits.
  IF p_verifier IS NULL
     OR p_verifier !~ '^SCRAM-SHA-256\$[1-9][0-9]{3,6}:(?:[A-Za-z0-9+/]{4}){2,}(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?\$[A-Za-z0-9+/]{43}=:[A-Za-z0-9+/]{43}=$' THEN
    RAISE EXCEPTION 'provision_person: the verifier must be a SCRAM-SHA-256 verifier with at least 4096 iterations'
      USING ERRCODE = '22023';
  END IF;
  IF split_part(split_part(p_verifier, '$', 2), ':', 1)::integer < 4096 THEN
    RAISE EXCEPTION 'provision_person: the verifier must be a SCRAM-SHA-256 verifier with at least 4096 iterations'
      USING ERRCODE = '22023';
  END IF;
  IF p_valid_days IS NULL OR p_valid_days NOT BETWEEN 1 AND 90 THEN
    RAISE EXCEPTION 'provision_person: the login must expire in 1 to 90 days' USING ERRCODE = '22023';
  END IF;

  v_role := 'jale_person_' || p_handle;
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_roles r WHERE r.rolname = v_role) THEN
    RAISE EXCEPTION 'provision_person: % already exists; renew or remove it', v_role USING ERRCODE = '42710';
  END IF;
  v_until := to_char((date_trunc('second', now()) + make_interval(days => p_valid_days)) AT TIME ZONE 'UTC',
                     'YYYY-MM-DD"T"HH24:MI:SS"Z"');

  EXECUTE format('CREATE ROLE %I LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS INHERIT '
                 'CONNECTION LIMIT 2 VALID UNTIL %L PASSWORD %L', v_role, v_until, p_verifier);
  EXECUTE format('GRANT jale_ops_readonly TO %I WITH INHERIT TRUE, SET FALSE', v_role);
  EXECUTE format('ALTER ROLE %I SET default_transaction_read_only = on', v_role);
  EXECUTE format('ALTER ROLE %I SET statement_timeout = %L', v_role, '30s');
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_extension e WHERE e.extname = 'pgaudit') THEN
    EXECUTE format('ALTER ROLE %I SET pgaudit.log = %L', v_role, 'all');
  END IF;

  -- The login has exactly the one accepted membership and nothing else.
  SELECT r.oid INTO v_oid FROM pg_catalog.pg_roles r WHERE r.rolname = v_role;
  IF (SELECT count(*) FROM pg_catalog.pg_auth_members am WHERE am.member = v_oid) <> 1
     OR NOT EXISTS (SELECT 1 FROM pg_catalog.pg_auth_members am
                     WHERE am.member = v_oid AND am.roleid = 'jale_ops_readonly'::regrole
                       AND am.inherit_option AND NOT am.set_option AND NOT am.admin_option) THEN
    RAISE EXCEPTION 'provision_person: % does not have the operator membership shape', v_role;
  END IF;

  RAISE NOTICE 'provision_person: % can sign in until %', v_role, v_until;
END;
$fn$;

-- A new verifier and a new expiry for an existing personal login. Its
-- LOGIN, CONNECTION LIMIT and settings are set again; a login that no longer
-- has the operator shape is refused (remove it instead).
CREATE PROCEDURE jale_ops.renew_person(p_handle TEXT, p_verifier TEXT, p_valid_days INTEGER)
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, pg_temp
AS $fn$
DECLARE
  v_role  TEXT;
  v_until TEXT;
  v_oid   OID;
BEGIN
  IF p_handle IS NULL OR p_handle !~ '^[a-z][a-z0-9]{1,15}$' THEN
    RAISE EXCEPTION 'renew_person: the handle must be 2 to 16 lower-case letters and digits, starting with a letter'
      USING ERRCODE = '22023';
  END IF;
  -- The shape first: only then is the iteration count known to be digits.
  IF p_verifier IS NULL
     OR p_verifier !~ '^SCRAM-SHA-256\$[1-9][0-9]{3,6}:(?:[A-Za-z0-9+/]{4}){2,}(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?\$[A-Za-z0-9+/]{43}=:[A-Za-z0-9+/]{43}=$' THEN
    RAISE EXCEPTION 'renew_person: the verifier must be a SCRAM-SHA-256 verifier with at least 4096 iterations'
      USING ERRCODE = '22023';
  END IF;
  IF split_part(split_part(p_verifier, '$', 2), ':', 1)::integer < 4096 THEN
    RAISE EXCEPTION 'renew_person: the verifier must be a SCRAM-SHA-256 verifier with at least 4096 iterations'
      USING ERRCODE = '22023';
  END IF;
  IF p_valid_days IS NULL OR p_valid_days NOT BETWEEN 1 AND 90 THEN
    RAISE EXCEPTION 'renew_person: the login must expire in 1 to 90 days' USING ERRCODE = '22023';
  END IF;

  v_role := 'jale_person_' || p_handle;
  SELECT r.oid INTO v_oid FROM pg_catalog.pg_roles r WHERE r.rolname = v_role;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'renew_person: % does not exist', v_role USING ERRCODE = '42704';
  END IF;
  IF (SELECT count(*) FROM pg_catalog.pg_auth_members am WHERE am.member = v_oid) <> 1
     OR NOT EXISTS (SELECT 1 FROM pg_catalog.pg_auth_members am
                     WHERE am.member = v_oid AND am.roleid = 'jale_ops_readonly'::regrole
                       AND am.inherit_option AND NOT am.set_option AND NOT am.admin_option) THEN
    RAISE EXCEPTION 'renew_person: % does not have the operator membership shape; remove it instead', v_role
      USING ERRCODE = '22023';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_roles r
              WHERE r.oid = v_oid
                AND (r.rolsuper OR r.rolcreatedb OR r.rolcreaterole OR r.rolreplication OR r.rolbypassrls)) THEN
    RAISE EXCEPTION 'renew_person: % carries an elevated attribute; remove it instead', v_role USING ERRCODE = '22023';
  END IF;
  v_until := to_char((date_trunc('second', now()) + make_interval(days => p_valid_days)) AT TIME ZONE 'UTC',
                     'YYYY-MM-DD"T"HH24:MI:SS"Z"');

  EXECUTE format('ALTER ROLE %I LOGIN CONNECTION LIMIT 2 VALID UNTIL %L PASSWORD %L', v_role, v_until, p_verifier);
  EXECUTE format('ALTER ROLE %I SET default_transaction_read_only = on', v_role);
  EXECUTE format('ALTER ROLE %I SET statement_timeout = %L', v_role, '30s');
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_extension e WHERE e.extname = 'pgaudit') THEN
    EXECUTE format('ALTER ROLE %I SET pgaudit.log = %L', v_role, 'all');
  END IF;

  RAISE NOTICE 'renew_person: % can sign in until %', v_role, v_until;
END;
$fn$;

-- Drops a personal login. Its membership and settings go with it; a
-- session still open loses the operator group at once. The notice gives the
-- number of such sessions.
CREATE PROCEDURE jale_ops.remove_person(p_handle TEXT)
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, pg_temp
AS $fn$
DECLARE
  v_role     TEXT;
  v_sessions BIGINT;
BEGIN
  IF p_handle IS NULL OR p_handle !~ '^[a-z][a-z0-9]{1,15}$' THEN
    RAISE EXCEPTION 'remove_person: the handle must be 2 to 16 lower-case letters and digits, starting with a letter'
      USING ERRCODE = '22023';
  END IF;
  v_role := 'jale_person_' || p_handle;
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles r WHERE r.rolname = v_role) THEN
    RAISE EXCEPTION 'remove_person: % does not exist', v_role USING ERRCODE = '42704';
  END IF;
  SELECT count(*) INTO v_sessions FROM pg_catalog.pg_stat_activity a WHERE a.usename = v_role;
  EXECUTE format('DROP ROLE %I', v_role);
  RAISE NOTICE 'remove_person: % removed; % open sessions', v_role, v_sessions;
END;
$fn$;

REVOKE ALL ON PROCEDURE
  jale_ops.provision_person(text, text, integer),
  jale_ops.renew_person(text, text, integer),
  jale_ops.remove_person(text)
FROM PUBLIC;
GRANT EXECUTE ON PROCEDURE
  jale_ops.provision_person(text, text, integer),
  jale_ops.renew_person(text, text, integer),
  jale_ops.remove_person(text)
TO jale_admin;
RESET ROLE;

-- ── 6. Close the SET window ─────────────────────────────────
DO $$
DECLARE
  role_name TEXT;
BEGIN
  FOREACH role_name IN ARRAY ARRAY['jale_audit_owner', 'jale_ops_owner'] LOOP
    EXECUTE format('GRANT %I TO %I WITH SET FALSE, INHERIT FALSE', role_name, current_user);
    EXECUTE format('REVOKE %I FROM %I GRANTED BY %I', role_name, current_user, current_user);
  END LOOP;
END;
$$;

-- ── Self-audit: the operator functions and the owner's reads ─
DO $$
DECLARE
  spec RECORD;
  info RECORD;
  fn_oid OID;
  offender TEXT;
BEGIN
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_auth_members am
              WHERE am.roleid IN ('jale_audit_owner'::regrole, 'jale_ops_owner'::regrole)
                AND (am.set_option OR am.inherit_option)) THEN
    RAISE EXCEPTION 'migration 112: the ownership window is still open';
  END IF;

  FOR spec IN
    SELECT * FROM (VALUES
      ('jale_ops.find_user(text, text)', 'jale_ops_owner', 'jale_ops_readonly'),
      ('jale_ops.user_status(uuid)', 'jale_ops_owner', 'jale_ops_readonly'),
      ('jale_ops.onboarding_status(uuid)', 'jale_ops_owner', 'jale_ops_readonly'),
      ('jale_ops.trust_assessment_status(uuid)', 'jale_ops_owner', 'jale_ops_readonly'),
      ('jale_ops.outbox_status(uuid)', 'jale_ops_owner', 'jale_ops_readonly'),
      ('jale_ops.delivery_status(uuid)', 'jale_ops_owner', 'jale_ops_readonly'),
      ('jale_ops.migration_ledger()', 'jale_ops_owner', 'jale_ops_readonly'),
      ('jale_ops.audit_export_status()', 'jale_ops_owner', 'jale_admin,jale_ops_readonly'),
      ('jale_ops.audit_event_counts(timestamp with time zone)', 'jale_ops_owner', 'jale_admin,jale_ops_readonly'),
      ('jale_audit.export_status()', 'jale_audit_owner', 'jale_ops_owner'),
      ('jale_audit.event_counts(timestamp with time zone)', 'jale_audit_owner', 'jale_ops_owner'),
      ('jale_audit.list_holds()', 'jale_audit_owner', 'jale_admin')
    ) AS t(signature, owner, grantees)
  LOOP
    fn_oid := pg_catalog.to_regprocedure(spec.signature);
    SELECT pg_catalog.pg_get_userbyid(p.proowner) AS owner, p.prosecdef, p.proconfig,
           (SELECT string_agg(pg_catalog.pg_get_userbyid(a.grantee), ',' ORDER BY pg_catalog.pg_get_userbyid(a.grantee))
              FROM aclexplode(p.proacl) a
             WHERE a.privilege_type = 'EXECUTE' AND a.grantee <> p.proowner) AS grantees,
           EXISTS (SELECT 1 FROM aclexplode(COALESCE(p.proacl, acldefault('f', p.proowner))) a
                    WHERE a.grantee = 0) AS public_execute
      INTO info
      FROM pg_catalog.pg_proc p WHERE p.oid = fn_oid;
    IF fn_oid IS NULL OR info.owner <> spec.owner OR NOT info.prosecdef
       OR info.proconfig IS DISTINCT FROM ARRAY['search_path=pg_catalog, pg_temp']
       OR info.grantees IS DISTINCT FROM spec.grantees OR info.public_execute THEN
      RAISE EXCEPTION 'migration 112: % has the wrong owner, security, search_path or grants', spec.signature;
    END IF;
  END LOOP;

  -- The value-kind helper: the audit owner's own, closed to everyone else.
  SELECT pg_catalog.pg_get_userbyid(p.proowner) AS owner, p.prosecdef, p.proconfig,
         EXISTS (SELECT 1 FROM aclexplode(COALESCE(p.proacl, acldefault('f', p.proowner))) a
                  WHERE a.privilege_type = 'EXECUTE' AND a.grantee <> p.proowner) AS shared
    INTO info
    FROM pg_catalog.pg_proc p WHERE p.oid = pg_catalog.to_regprocedure('jale_audit.value_span_kind(text)');
  IF info.owner IS DISTINCT FROM 'jale_audit_owner' OR info.prosecdef
     OR info.proconfig IS DISTINCT FROM ARRAY['search_path=pg_catalog, pg_temp'] OR info.shared THEN
    RAISE EXCEPTION 'migration 112: jale_audit.value_span_kind has the wrong owner, security, search_path or grants';
  END IF;

  -- jale_ops: USAGE for the operator group and jale_admin; nothing else.
  SELECT string_agg(pg_catalog.pg_get_userbyid(a.grantee) || ':' || a.privilege_type, ', '
                    ORDER BY pg_catalog.pg_get_userbyid(a.grantee), a.privilege_type)
    INTO offender
    FROM pg_catalog.pg_namespace n, aclexplode(COALESCE(n.nspacl, acldefault('n', n.nspowner))) a
   WHERE n.nspname = 'jale_ops' AND a.grantee <> n.nspowner;
  IF offender IS DISTINCT FROM 'jale_admin:USAGE, jale_ops_readonly:USAGE' THEN
    RAISE EXCEPTION 'migration 112: jale_ops grants are % instead of USAGE for the operator group and jale_admin', offender;
  END IF;

  -- jale_audit: the callers 109 lists, and the operator owner.
  SELECT string_agg(pg_catalog.pg_get_userbyid(a.grantee) || ':' || a.privilege_type, ', '
                    ORDER BY pg_catalog.pg_get_userbyid(a.grantee), a.privilege_type)
    INTO offender
    FROM pg_catalog.pg_namespace n, aclexplode(n.nspacl) a
   WHERE n.nspname = 'jale_audit' AND a.grantee <> n.nspowner;
  IF offender IS DISTINCT FROM 'jale_admin:USAGE, jale_admin_console:USAGE, jale_api:USAGE, jale_job_audit_export:USAGE, jale_ops_owner:USAGE, jale_whatsapp:USAGE' THEN
    RAISE EXCEPTION 'migration 112: jale_audit grants are %', offender;
  END IF;

  -- The operator owner reads columns only, holds no table-level privilege
  -- and no CREATE on public; the operator group holds no privilege on any
  -- table, column or sequence.
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_class c, aclexplode(c.relacl) a
              WHERE a.grantee IN ('jale_ops_owner'::regrole, 'jale_ops_readonly'::regrole)) THEN
    RAISE EXCEPTION 'migration 112: the operator owner or group holds a table-level privilege';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_attribute att, aclexplode(att.attacl) a
              WHERE a.grantee = 'jale_ops_readonly'::regrole
                 OR (a.grantee = 'jale_ops_owner'::regrole AND a.privilege_type <> 'SELECT')) THEN
    RAISE EXCEPTION 'migration 112: the operator owner may only read columns, and the group none';
  END IF;
  IF pg_catalog.has_schema_privilege('jale_ops_owner', 'public', 'CREATE') THEN
    RAISE EXCEPTION 'migration 112: jale_ops_owner must not hold CREATE on public';
  END IF;

  -- One SELECT policy for the operator owner on each table it reads that has
  -- row security, and no other policy for it.
  SELECT string_agg(c.relname, ', ' ORDER BY c.relname) INTO offender
    FROM pg_catalog.pg_class c
   WHERE c.relnamespace = 'public'::regnamespace AND c.relkind = 'r' AND c.relrowsecurity
     AND EXISTS (SELECT 1 FROM pg_catalog.pg_attribute att, aclexplode(att.attacl) a
                  WHERE att.attrelid = c.oid AND a.grantee = 'jale_ops_owner'::regrole)
     AND (SELECT count(*) FROM pg_catalog.pg_policy pol
           WHERE pol.polrelid = c.oid AND pol.polroles = ARRAY['jale_ops_owner'::regrole::oid]
             AND pol.polcmd = 'r' AND pol.polpermissive
             AND pg_catalog.pg_get_expr(pol.polqual, pol.polrelid) = 'true') <> 1;
  IF offender IS NOT NULL THEN
    RAISE EXCEPTION 'migration 112: tables the operator owner reads without exactly one read policy: %', offender;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_policy pol
              WHERE 'jale_ops_owner'::regrole::oid = ANY (pol.polroles)
                AND NOT (pol.polcmd = 'r' AND pol.polroles = ARRAY['jale_ops_owner'::regrole::oid])) THEN
    RAISE EXCEPTION 'migration 112: a policy for the operator owner does more than read';
  END IF;
END;
$$;

-- ── Self-audit: the personal-login procedures (section 5) ───
DO $$
DECLARE
  spec RECORD;
  info RECORD;
  fn_oid OID;
BEGIN
  FOR spec IN
    SELECT * FROM (VALUES
      ('jale_ops.provision_person(text, text, integer)'),
      ('jale_ops.renew_person(text, text, integer)'),
      ('jale_ops.remove_person(text)')
    ) AS t(signature)
  LOOP
    fn_oid := pg_catalog.to_regprocedure(spec.signature);
    SELECT pg_catalog.pg_get_userbyid(p.proowner) AS owner, p.prokind, p.prosecdef, p.proconfig,
           (SELECT string_agg(pg_catalog.pg_get_userbyid(a.grantee), ',' ORDER BY pg_catalog.pg_get_userbyid(a.grantee))
              FROM aclexplode(p.proacl) a
             WHERE a.privilege_type = 'EXECUTE' AND a.grantee <> p.proowner) AS grantees,
           EXISTS (SELECT 1 FROM aclexplode(COALESCE(p.proacl, acldefault('f', p.proowner))) a
                    WHERE a.grantee = 0) AS public_execute
      INTO info
      FROM pg_catalog.pg_proc p WHERE p.oid = fn_oid;
    IF fn_oid IS NULL OR info.owner <> 'jale_ops_owner' OR info.prokind <> 'p' OR info.prosecdef
       OR info.proconfig IS DISTINCT FROM ARRAY['search_path=pg_catalog, pg_temp']
       OR info.grantees IS DISTINCT FROM 'jale_admin' OR info.public_execute THEN
      RAISE EXCEPTION 'migration 112: % has the wrong owner, kind, security, search_path or grants', spec.signature;
    END IF;
  END LOOP;
END;
$$;

COMMIT;
