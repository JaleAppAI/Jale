-- ============================================================
-- 122_admin_inbox.sql
-- Run manually AFTER 121_whatsapp_support_mode.sql,
-- connected as jale_admin. Forward-only (ADR-005).
--
-- Sprint 28: the admin Inbox. The console answers support cases, opens a
-- photo a worker sent, reveals a number on purpose, and resets a lockout,
-- all without ever reading a worker's number or a challenge's phone hash.
--
-- (1) admin_cases.case_number: a display number (S-<n>), unique, assigned
--     by an identity column; existing cases are numbered in creation order.
-- (2) identity_lockout_resets: one row per lockout an admin reset, with the
--     reason code. Forced row security with one gated policy for the
--     definers' owner; no login holds any right on it. The phone hash is
--     kept only while the challenge exists (it is cleared with it).
-- (2b) admin_inbox_requests: the request ledger that makes every Inbox
--     action safe to repeat (same table rules as (2); payload fingerprints
--     only, kept 24 hours).
-- (3) The console no longer inserts into whatsapp_outbox itself: its
--     support messages go through admin_queue_support_message, which reads
--     the number from the case's conversation in SQL.
-- (4) Definers, every one owned by jale_admin with a pinned search path and
--     EXECUTE revoked from PUBLIC; seven are executable by
--     jale_admin_console and nothing else:
--       admin_support_case_view          window, language, worker context,
--                                        masked number
--       admin_support_media_link         the key of one attachment of a case
--       admin_support_reveal_phone       the number of a case, on purpose
--       admin_queue_support_message      reply / request_info / closing
--       admin_identity_challenge_detail  a lockout's history, no hash
--       admin_reset_identity_lockout     clear a lock, record it, tell the
--                                        worker
--       admin_open_support_from_lockout  open or reuse the number's case
--     The three that change something (queue, reset, open) return
--     (result_id, replayed): replayed is true when the same admin sent the
--     same request in the last 24 hours and its first result is returned.
--     Helpers no login may execute: admin_inbox_actor_role,
--     admin_support_last_inbound, admin_support_one_line,
--     admin_support_utf16_length, admin_inbox_request_seen,
--     admin_inbox_request_remember, admin_support_enqueue and
--     admin_identity_challenge_state, plus the resets table's trigger
--     function.
--
-- REFUSALS. A refusal raises with the K2.7 code as the message: SQLSTATE
-- P0001 for case_closed, reply_too_long_for_template, no_reply_target and
-- not_locked; P0002 not_found; 42501 forbidden (the acting admin is not an
-- active Ops or Superadmin admin); 22023 invalid_input. Nothing is written
-- by a refused call.
--
-- WINDOW. WhatsApp delivers free text only within 24 hours of the worker's
-- last message. As isWithinSessionWindow does, the last message is the
-- newest inbound log row for the number whose sid carries no '#', with a
-- 15-minute margin (23h45m), on the database clock. With the window closed
-- the reply travels inside the support template, so it is capped at 250
-- characters, counted as the console counts them (whitespace runs as one
-- space, trimmed, UTF-16 code units) and never cut. A window that closes
-- within 30 minutes counts as closed for the cap, so a send retried past the
-- edge still fits the template; the dispatcher decides at send time.
--
-- OWNER. jale_admin, because admin_cases, admin_case_events, admin_users,
-- worker_identity_challenges and worker_workflow_runs are forced and only
-- jale_admin's policies on them let a definer read and write rows; users and
-- worker_identity_challenge_events are read through 089's gated policies,
-- opened after argument validation and closed before returning. The
-- preconditions refuse to apply if any of those policies is missing.
--
-- DEDUPE. Opening a support case from a lockout takes the same advisory
-- lock key as the bot's support_open_case (121):
-- hashtextextended('admin-support-case:' || conversation id, 0), and picks
-- the open case the same way, so both end up on one case. A lockout reset
-- takes the pre-auth save's key, hashtextextended(phone hash, 0).
--
-- DEPLOY ORDER: apply BEFORE deploying the admin console that calls these
-- functions. From the apply until that deploy, the previous console's
-- reply action is refused (it inserted into whatsapp_outbox itself).
-- ============================================================
BEGIN;

-- Fail fast instead of queueing case and outbox writes behind a stuck
-- transaction (the new column and the policy change take strong locks until
-- COMMIT); a timed-out apply writes no ledger row and can simply be rerun.
SET LOCAL lock_timeout = '5s';

-- Preconditions. pg_policy and pg_class are catalogs, so row security never
-- filters these checks.
DO $$
DECLARE
  pol RECORD;
BEGIN
  IF session_user <> 'jale_admin' OR current_user <> 'jale_admin' THEN
    RAISE EXCEPTION 'migration 122: connect as jale_admin (this session runs as %)', current_user;
  END IF;

  IF to_regprocedure('public.support_open_case(uuid, uuid, text, text, text)') IS NULL
     OR to_regclass('public.support_case_media') IS NULL THEN
    RAISE EXCEPTION 'migration 122: apply 121 first (support_open_case or support_case_media is missing)';
  END IF;
  IF to_regprocedure('public.admin_mask_phone(text)') IS NULL THEN
    RAISE EXCEPTION 'migration 122: apply 102 first (admin_mask_phone is missing)';
  END IF;

  -- Unconditional policies for the definers' owner.
  FOR pol IN
    SELECT * FROM (VALUES
      ('public.admin_cases', 'admin_cases_service_all'),
      ('public.admin_case_events', 'admin_case_events_service_all'),
      ('public.admin_users', 'admin_users_self_or_service'),
      ('public.worker_identity_challenges', 'worker_identity_challenges_definer'),
      ('public.worker_onboarding_state', 'worker_onboarding_state_definer'),
      ('public.worker_workflow_runs', 'worker_workflow_runs_definer')
    ) AS expected(rel, name)
  LOOP
    IF NOT EXISTS (
      SELECT 1 FROM pg_catalog.pg_policy p
       WHERE p.polrelid = pol.rel::regclass
         AND p.polname = pol.name
         AND p.polcmd = '*'
         AND p.polpermissive
         AND p.polroles = ARRAY['jale_admin'::regrole::oid]
         AND pg_catalog.pg_get_expr(p.polqual, p.polrelid) = 'true'
    ) THEN
      RAISE EXCEPTION 'migration 122: policy % on % missing or drifted; the Inbox definers would read no rows', pol.name, pol.rel;
    END IF;
  END LOOP;

  -- Gated reads the definers open with app.admin_analytics_read (089, 101)
  -- and app.support_case_media (121).
  FOR pol IN
    SELECT * FROM (VALUES
      ('public.users', 'users_admin_analytics_read', 'r', 'app.admin_analytics_read'),
      ('public.worker_identity_challenge_events', 'worker_identity_challenge_events_admin_analytics_read', 'r', 'app.admin_analytics_read'),
      ('public.support_case_media', 'support_case_media_definer_access', '*', 'app.support_case_media')
    ) AS expected(rel, name, cmd, flag)
  LOOP
    IF NOT EXISTS (
      SELECT 1 FROM pg_catalog.pg_policy p
       WHERE p.polrelid = pol.rel::regclass
         AND p.polname = pol.name
         AND p.polcmd = pol.cmd::"char"
         AND p.polpermissive
         AND p.polroles = ARRAY['jale_admin'::regrole::oid]
         AND pg_catalog.pg_get_expr(p.polqual, p.polrelid)
             = format('(current_setting(%L::text, true) = %L::text)', pol.flag, 'on')
    ) THEN
      RAISE EXCEPTION 'migration 122: gated policy % on % missing or drifted', pol.name, pol.rel;
    END IF;
  END LOOP;

  -- A RESTRICTIVE policy is AND'ed with the ones above and could hide rows
  -- or refuse the definers' writes silently.
  IF EXISTS (
    SELECT 1 FROM pg_catalog.pg_policy p
     WHERE p.polrelid IN ('public.admin_cases'::regclass, 'public.admin_case_events'::regclass,
                          'public.admin_users'::regclass, 'public.worker_identity_challenges'::regclass,
                          'public.worker_identity_challenge_events'::regclass, 'public.users'::regclass,
                          'public.whatsapp_outbox'::regclass)
       AND NOT p.polpermissive
       AND ('jale_admin'::regrole::oid = ANY (p.polroles) OR 0::oid = ANY (p.polroles))
  ) THEN
    RAISE EXCEPTION 'migration 122: a restrictive policy for jale_admin or PUBLIC on a table the Inbox definers use';
  END IF;

  -- Read and written as their owner: they must stay unforced and owned by
  -- jale_admin.
  IF EXISTS (
    SELECT 1 FROM pg_catalog.pg_class c
     WHERE c.oid IN ('public.whatsapp_conversations'::regclass, 'public.whatsapp_outbox'::regclass,
                     'public.whatsapp_processed_messages'::regclass)
       AND (c.relforcerowsecurity OR c.relowner <> 'jale_admin'::regrole)
  ) THEN
    RAISE EXCEPTION 'migration 122: whatsapp_conversations, whatsapp_outbox or whatsapp_processed_messages is forced or not owned by jale_admin';
  END IF;

  IF EXISTS (
    SELECT 1 FROM pg_catalog.pg_attribute a
     WHERE a.attrelid = 'public.admin_cases'::regclass AND a.attname = 'case_number' AND NOT a.attisdropped
  ) THEN
    RAISE EXCEPTION 'migration 122: already applied (admin_cases.case_number exists); it is not re-runnable';
  END IF;
END $$;

-- ── (1) Case numbers ────────────────────────────────────────
-- An identity column added in one step would number existing rows in
-- storage order. Numbered here in creation order first; the identity then
-- continues after the highest number. The update changes no change-logged
-- column, so it leaves no change record.
-- BEGIN case_number backfill (the admin-inbox-122 suite re-runs this block)
ALTER TABLE public.admin_cases ADD COLUMN case_number BIGINT;
UPDATE public.admin_cases c
   SET case_number = n.rn
  FROM (SELECT k.id, pg_catalog.row_number() OVER (ORDER BY k.created_at, k.id) AS rn
          FROM public.admin_cases k) AS n
 WHERE n.id = c.id;
ALTER TABLE public.admin_cases ALTER COLUMN case_number SET NOT NULL;
ALTER TABLE public.admin_cases ALTER COLUMN case_number ADD GENERATED BY DEFAULT AS IDENTITY;
SELECT pg_catalog.setval(
  pg_catalog.pg_get_serial_sequence('public.admin_cases', 'case_number'),
  COALESCE((SELECT max(k.case_number) FROM public.admin_cases k), 0) + 1,
  false);
ALTER TABLE public.admin_cases ADD CONSTRAINT admin_cases_case_number_key UNIQUE (case_number);
-- END case_number backfill

-- ── (2) Lockout resets ──────────────────────────────────────
CREATE TABLE public.identity_lockout_resets (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  challenge_id  UUID REFERENCES public.worker_identity_challenges(id) ON DELETE SET NULL,
  -- For counting earlier resets of the same number. Never returned; cleared
  -- when the challenge goes.
  phone_hash    TEXT CHECK (phone_hash ~ '^[0-9a-f]{64}$'),
  reason_code   TEXT NOT NULL CHECK (reason_code IN (
                  'codes_not_arriving', 'worker_confused', 'typo_in_details',
                  'identity_confirmed_elsewhere', 'other')),
  note          TEXT CHECK (note IS NULL OR pg_catalog.char_length(note) BETWEEN 1 AND 300),
  admin_user_id UUID REFERENCES public.admin_users(id) ON DELETE SET NULL,
  case_id       UUID REFERENCES public.admin_cases(id) ON DELETE SET NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (reason_code <> 'other' OR note IS NOT NULL),
  CHECK (phone_hash IS NOT NULL OR challenge_id IS NULL)
);

CREATE INDEX identity_lockout_resets_challenge_idx ON public.identity_lockout_resets (challenge_id);
CREATE INDEX identity_lockout_resets_phone_idx ON public.identity_lockout_resets (phone_hash) WHERE phone_hash IS NOT NULL;
CREATE INDEX identity_lockout_resets_case_idx ON public.identity_lockout_resets (case_id);

ALTER TABLE public.identity_lockout_resets ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.identity_lockout_resets FORCE ROW LEVEL SECURITY;
REVOKE ALL ON public.identity_lockout_resets FROM PUBLIC;

-- The definers below open the transaction-local flag around their reads and
-- writes and close it again. No login holds a right on the table.
CREATE POLICY identity_lockout_resets_definer_access
  ON public.identity_lockout_resets FOR ALL
  TO jale_admin
  USING (current_setting('app.identity_lockout_resets', true) = 'on')
  WITH CHECK (current_setting('app.identity_lockout_resets', true) = 'on');

-- When the challenge is deleted (with its worker, or by an operator reset),
-- its foreign key clears challenge_id; the phone hash goes with it. Reads
-- nothing, so it runs as the writer.
CREATE FUNCTION public.identity_lockout_resets_forget_phone()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $fn$
BEGIN
  NEW.phone_hash := NULL;
  RETURN NEW;
END;
$fn$;

CREATE TRIGGER identity_lockout_resets_forget_phone
  BEFORE UPDATE OF challenge_id ON public.identity_lockout_resets
  FOR EACH ROW
  WHEN (NEW.challenge_id IS NULL)
  EXECUTE FUNCTION public.identity_lockout_resets_forget_phone();

-- ── (2b) Admin requests, for repeats ──────────────────────
-- Every Inbox action carries a request id. For 24 hours per admin, the same
-- id with the same payload answers the first outcome without running again
-- (a retried reply never reaches the worker twice); the same id with another
-- payload is refused. The payload is kept as an MD5 fingerprint only, never
-- the text. Rows older than 24 hours are removed by the next request of the
-- same admin.
CREATE TABLE public.admin_inbox_requests (
  admin_user_id UUID NOT NULL REFERENCES public.admin_users(id) ON DELETE CASCADE,
  request_id    UUID NOT NULL,
  action        TEXT NOT NULL CHECK (action IN ('reply', 'request_info', 'resolve', 'reset_lockout', 'open_support')),
  fingerprint   TEXT NOT NULL CHECK (fingerprint ~ '^[0-9a-f]{32}$'),
  result_id     UUID,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (admin_user_id, request_id)
);

CREATE INDEX admin_inbox_requests_age_idx ON public.admin_inbox_requests (admin_user_id, created_at);

ALTER TABLE public.admin_inbox_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.admin_inbox_requests FORCE ROW LEVEL SECURITY;
REVOKE ALL ON public.admin_inbox_requests FROM PUBLIC;

CREATE POLICY admin_inbox_requests_definer_access
  ON public.admin_inbox_requests FOR ALL
  TO jale_admin
  USING (current_setting('app.admin_inbox_requests', true) = 'on')
  WITH CHECK (current_setting('app.admin_inbox_requests', true) = 'on');

-- ── (3) Support messages go through the definer only ────────
DROP POLICY whatsapp_outbox_console_insert ON public.whatsapp_outbox;
REVOKE INSERT ON public.whatsapp_outbox FROM jale_admin_console;

-- ── (4a) Helpers (no login may execute them)────────────────

-- The acting admin's role label, or 42501 when the id names no active Ops
-- or Superadmin admin.
CREATE FUNCTION public.admin_inbox_actor_role(p_actor UUID)
RETURNS TEXT
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $fn$
DECLARE
  v_role TEXT;
BEGIN
  SELECT a.role INTO v_role
    FROM public.admin_users a
   WHERE a.id = p_actor
     AND a.active
     AND a.role IN ('admin_ops', 'admin_superadmin');
  IF v_role IS NULL THEN
    RAISE EXCEPTION 'forbidden' USING ERRCODE = '42501';
  END IF;
  RETURN CASE v_role WHEN 'admin_superadmin' THEN 'Superadmin' ELSE 'Ops' END;
END;
$fn$;

-- When the worker last wrote from this number (NULL: never). Rows whose sid
-- carries a '#' are the bot's own.
CREATE FUNCTION public.admin_support_last_inbound(p_number TEXT)
RETURNS TIMESTAMPTZ
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $fn$
  SELECT max(m.first_seen_at)
    FROM public.whatsapp_processed_messages m
   WHERE m.whatsapp_number = p_number
     AND pg_catalog.strpos(m.message_sid, '#') = 0
$fn$;

-- Where a challenge stands: verified, superseded, locked (a lock in force),
-- stuck_at_code (at the code step with a lapsed lock, or a code that expired
-- over an hour ago), expired, or in_progress. Reads nothing.
CREATE FUNCTION public.admin_identity_challenge_state(
  p_status TEXT,
  p_step TEXT,
  p_locked_until TIMESTAMPTZ,
  p_expires_at TIMESTAMPTZ,
  p_updated_at TIMESTAMPTZ,
  p_verified_user UUID
)
RETURNS TEXT
LANGUAGE sql
STABLE
SET search_path = pg_catalog, pg_temp
AS $fn$
  SELECT CASE
           WHEN p_status = 'verified' OR p_verified_user IS NOT NULL THEN 'verified'
           WHEN p_status = 'superseded' THEN 'superseded'
           WHEN p_status = 'locked' AND p_locked_until > pg_catalog.now() THEN 'locked'
           WHEN p_step = 'identity.verify_otp'
                AND (p_status = 'locked'
                     OR (p_status IN ('pending', 'expired')
                         AND COALESCE(p_expires_at, p_updated_at) < pg_catalog.now() - interval '1 hour'))
             THEN 'stuck_at_code'
           WHEN p_status = 'expired' THEN 'expired'
           ELSE 'in_progress'
         END
$fn$;

-- A reply as the support template carries it: every whitespace run (line
-- breaks included) one space, trimmed. The class is JavaScript's \s, so the
-- console and this function measure the same text.
CREATE FUNCTION public.admin_support_one_line(p_text TEXT)
RETURNS TEXT
LANGUAGE sql
IMMUTABLE
SET search_path = pg_catalog, pg_temp
AS $fn$
  SELECT pg_catalog.btrim(pg_catalog.regexp_replace(p_text, U&'[\0009-\000D\0020\00A0\1680\2000-\200A\2028\2029\202F\205F\3000\FEFF]+', ' ', 'g'), ' ')
$fn$;

-- A text's length as JavaScript counts it (UTF-16 code units): characters
-- outside the Basic Multilingual Plane count twice.
CREATE FUNCTION public.admin_support_utf16_length(p_text TEXT)
RETURNS INTEGER
LANGUAGE sql
IMMUTABLE
SET search_path = pg_catalog, pg_temp
AS $fn$
  SELECT pg_catalog.char_length(p_text)
         + pg_catalog.char_length(pg_catalog.regexp_replace(p_text, '[^\U00010000-\U0010FFFF]', '', 'g'))
$fn$;

-- Whether this admin already ran this request: (true, its result) for the
-- same action and payload, 22023 invalid_input for another one, (false,
-- NULL) for a new request. Serializes repeats of one request and forgets the
-- admin's requests older than 24 hours.
CREATE FUNCTION public.admin_inbox_request_seen(
  p_actor UUID,
  p_request_id UUID,
  p_action TEXT,
  p_fingerprint TEXT
)
RETURNS TABLE (seen BOOLEAN, result_id UUID)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $fn$
#variable_conflict use_column
DECLARE
  v_action TEXT;
  v_fingerprint TEXT;
  v_result UUID;
  v_found BOOLEAN;
BEGIN
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('admin-inbox-request:' || p_actor::text || ':' || p_request_id::text, 0));
  PERFORM pg_catalog.set_config('app.admin_inbox_requests', 'on', true);
  DELETE FROM public.admin_inbox_requests r
   WHERE r.admin_user_id = p_actor
     AND r.created_at < pg_catalog.now() - interval '24 hours';
  SELECT r.action, r.fingerprint, r.result_id INTO v_action, v_fingerprint, v_result
    FROM public.admin_inbox_requests r
   WHERE r.admin_user_id = p_actor
     AND r.request_id = p_request_id;
  v_found := FOUND;
  PERFORM pg_catalog.set_config('app.admin_inbox_requests', '', true);

  IF v_found AND (v_action <> p_action OR v_fingerprint <> p_fingerprint) THEN
    RAISE EXCEPTION 'invalid_input' USING ERRCODE = '22023';
  END IF;
  RETURN QUERY SELECT v_found, v_result;
END;
$fn$;

-- Records a request's result, in the transaction that produced it.
CREATE FUNCTION public.admin_inbox_request_remember(
  p_actor UUID,
  p_request_id UUID,
  p_action TEXT,
  p_fingerprint TEXT,
  p_result_id UUID
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $fn$
BEGIN
  PERFORM pg_catalog.set_config('app.admin_inbox_requests', 'on', true);
  INSERT INTO public.admin_inbox_requests (admin_user_id, request_id, action, fingerprint, result_id)
  VALUES (p_actor, p_request_id, p_action, p_fingerprint, p_result_id);
  PERFORM pg_catalog.set_config('app.admin_inbox_requests', '', true);
END;
$fn$;

-- One support message for the worker of a case: the outbox row (template
-- admin_support_reply_v2_<language>, the text as one line of at most 250
-- characters for the template and in full for a free-text send) and its
-- admin_reply_queued event. The idempotency key is admin-<kind>:<request>.
CREATE FUNCTION public.admin_support_enqueue(
  p_case_id UUID,
  p_number TEXT,
  p_request_id UUID,
  p_kind TEXT,
  p_text TEXT,
  p_language TEXT,
  p_actor UUID,
  p_role TEXT
)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $fn$
DECLARE
  v_line TEXT;
  v_cut INTEGER;
  v_id UUID;
BEGIN
  IF p_kind NOT IN ('reply', 'request_info', 'closing', 'lockout_notice')
     OR p_language NOT IN ('es', 'en')
     OR p_number IS NULL OR p_text IS NULL OR p_request_id IS NULL THEN
    RAISE EXCEPTION 'invalid_input' USING ERRCODE = '22023';
  END IF;

  -- The template copy. Over 250 only when the window had more than 30
  -- minutes left (the caller refuses it otherwise), when the dispatcher sends
  -- the full text instead; the copy is then shortened, counted as the console
  -- counts, only to keep the row well formed. The dispatcher holds a row
  -- whose copy was shortened rather than send it as a template.
  v_line := public.admin_support_one_line(p_text);
  IF public.admin_support_utf16_length(v_line) > 250 THEN
    v_cut := 249;
    WHILE public.admin_support_utf16_length(pg_catalog.left(v_line, v_cut)) > 249 LOOP
      v_cut := v_cut - 1;
    END LOOP;
    v_line := pg_catalog.rtrim(pg_catalog.left(v_line, v_cut)) || U&'\2026';
  END IF;

  INSERT INTO public.whatsapp_outbox
    (inbound_message_sid, sequence, whatsapp_number, body, content_template, content_variables,
     status, source_type, source_id, idempotency_key)
  VALUES (NULL, 0, p_number, NULL, 'admin_support_reply_v2_' || p_language,
          pg_catalog.jsonb_build_object('1', v_line, '__fallback_body', p_text),
          'pending', 'admin_case', p_case_id, 'admin-' || p_kind || ':' || p_request_id::text)
  ON CONFLICT (idempotency_key) WHERE idempotency_key IS NOT NULL DO NOTHING
  RETURNING id INTO v_id;
  IF v_id IS NULL THEN
    -- The key is taken by another message: the request id was reused.
    RAISE EXCEPTION 'invalid_input' USING ERRCODE = '22023';
  END IF;

  INSERT INTO public.admin_case_events (case_id, event_type, actor_type, actor_id, payload, created_at)
  VALUES (p_case_id, 'admin_reply_queued', 'admin', p_actor::text,
          pg_catalog.jsonb_build_object(
            'title', CASE p_kind
                       WHEN 'reply' THEN 'Reply queued'
                       WHEN 'request_info' THEN 'Request for more information queued'
                       WHEN 'closing' THEN 'Closing message queued'
                       ELSE 'Verification notice queued'
                     END,
            'detail', p_text,
            'outboxId', v_id,
            'via', NULL::TEXT,
            'kind', p_kind,
            'byRole', p_role),
          pg_catalog.clock_timestamp());
  RETURN v_id;
END;
$fn$;

-- ── (4b) Console definers ───────────────────────────────────

-- What the conversation page shows about a case beyond the case row: the
-- chat window, the language, the worker's progress and a masked number.
-- No row for an unknown case. The number itself never leaves.
CREATE FUNCTION public.admin_support_case_view(p_case_id UUID)
RETURNS TABLE (
  case_id             UUID,
  has_conversation    BOOLEAN,
  language            TEXT,
  window_open         BOOLEAN,
  window_closes_at    TIMESTAMPTZ,
  window_closed_at    TIMESTAMPTZ,
  registered          BOOLEAN,
  onboarding_step_key TEXT,
  failed_codes_today  INTEGER,
  joined_at           TIMESTAMPTZ,
  masked_phone        TEXT
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $fn$
#variable_conflict use_column
DECLARE
  v_user UUID;
  v_conv UUID;
  v_details JSONB;
  v_number TEXT;
  v_conv_lang TEXT;
  v_conv_user UUID;
  v_lang TEXT;
  v_last TIMESTAMPTZ;
  v_open BOOLEAN;
  v_hash TEXT;
  v_step TEXT;
  v_lifecycle TEXT;
  v_failed INTEGER;
  v_joined TIMESTAMPTZ;
BEGIN
  IF p_case_id IS NULL THEN
    RAISE EXCEPTION 'invalid_input' USING ERRCODE = '22023';
  END IF;

  SELECT k.user_id, k.conversation_id, k.details INTO v_user, v_conv, v_details
    FROM public.admin_cases k
   WHERE k.id = p_case_id;
  IF NOT FOUND THEN
    RETURN;
  END IF;

  IF v_conv IS NOT NULL THEN
    SELECT wc.whatsapp_number, wc.language, wc.user_id INTO v_number, v_conv_lang, v_conv_user
      FROM public.whatsapp_conversations wc
     WHERE wc.id = v_conv;
  END IF;
  v_user := COALESCE(v_user, v_conv_user);
  v_lang := CASE
              WHEN v_details ->> 'language' IN ('es', 'en') THEN v_details ->> 'language'
              WHEN v_conv_lang IN ('es', 'en') THEN v_conv_lang
              ELSE 'es'
            END;

  IF v_number IS NOT NULL THEN
    v_last := public.admin_support_last_inbound(v_number);
    v_hash := pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(pg_catalog.btrim(v_number), 'UTF8')), 'hex');
  END IF;
  v_open := COALESCE(v_last > pg_catalog.now() - interval '23 hours 45 minutes', false);

  -- Set after argument validation; closed again before returning.
  PERFORM pg_catalog.set_config('app.admin_analytics_read', 'on', true);

  IF v_user IS NOT NULL THEN
    SELECT u.created_at INTO v_joined FROM public.users u WHERE u.id = v_user;
    SELECT s.lifecycle INTO v_lifecycle FROM public.worker_onboarding_state s WHERE s.user_id = v_user;
    IF v_lifecycle = 'ready' THEN
      v_step := 'ready';
    ELSE
      SELECT r.current_step_key INTO v_step
        FROM public.worker_workflow_runs r
       WHERE r.user_id = v_user
       ORDER BY (r.status = 'active') DESC, r.created_at DESC, r.id DESC
       LIMIT 1;
    END IF;
  END IF;

  IF v_hash IS NOT NULL THEN
    IF v_step IS NULL THEN
      SELECT ch.current_step_key INTO v_step
        FROM public.worker_identity_challenges ch
       WHERE ch.phone_hash = v_hash
         AND ch.status IN ('pending', 'locked')
       ORDER BY ch.created_at DESC, ch.id DESC
       LIMIT 1;
    END IF;

    -- Wrong codes in the last 24 hours: each rise in a challenge's attempt
    -- count, plus each move into a lock (the third wrong code).
    SELECT COALESCE(sum(
             GREATEST(t.attempts - COALESCE(t.prev_attempts, 0), 0)
             + CASE WHEN t.to_status = 'locked' AND t.from_status IS DISTINCT FROM 'locked' THEN 1 ELSE 0 END
           ), 0)::INTEGER
      INTO v_failed
      FROM (SELECT e.changed_at, e.is_backfill, e.to_status, e.from_status, e.attempts,
                   pg_catalog.lag(e.attempts) OVER (PARTITION BY e.challenge_id ORDER BY e.changed_at, e.id) AS prev_attempts
              FROM public.worker_identity_challenge_events e
              JOIN public.worker_identity_challenges ch ON ch.id = e.challenge_id
             WHERE ch.phone_hash = v_hash) AS t
     WHERE t.changed_at > pg_catalog.now() - interval '24 hours'
       AND NOT t.is_backfill;
  END IF;

  PERFORM pg_catalog.set_config('app.admin_analytics_read', '', true);

  RETURN QUERY SELECT
    p_case_id,
    v_number IS NOT NULL,
    v_lang,
    v_open,
    CASE WHEN v_open THEN v_last + interval '23 hours 45 minutes' END,
    CASE WHEN NOT v_open AND v_last IS NOT NULL THEN v_last + interval '23 hours 45 minutes' END,
    v_user IS NOT NULL,
    v_step,
    v_failed,
    v_joined,
    public.admin_mask_phone(v_number);
END;
$fn$;

-- The stored key and type of one attachment of one case, for a short-lived
-- link: ok, not_found (no such attachment on this case) or media_expired.
CREATE FUNCTION public.admin_support_media_link(p_case_id UUID, p_media_id UUID)
RETURNS TABLE (outcome TEXT, s3_key TEXT, content_type TEXT)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $fn$
#variable_conflict use_column
DECLARE
  v_key TEXT;
  v_type TEXT;
  v_expires TIMESTAMPTZ;
BEGIN
  IF p_case_id IS NULL OR p_media_id IS NULL THEN
    RAISE EXCEPTION 'invalid_input' USING ERRCODE = '22023';
  END IF;

  PERFORM pg_catalog.set_config('app.support_case_media', 'on', true);
  SELECT m.s3_key, m.content_type, m.expires_at INTO v_key, v_type, v_expires
    FROM public.support_case_media m
   WHERE m.id = p_media_id
     AND m.case_id = p_case_id;
  PERFORM pg_catalog.set_config('app.support_case_media', '', true);

  IF v_key IS NULL THEN
    RETURN QUERY SELECT 'not_found'::TEXT, NULL::TEXT, NULL::TEXT;
  ELSIF v_expires <= pg_catalog.now() THEN
    RETURN QUERY SELECT 'media_expired'::TEXT, NULL::TEXT, NULL::TEXT;
  ELSE
    RETURN QUERY SELECT 'ok'::TEXT, v_key, v_type;
  END IF;
END;
$fn$;

-- The full number of a case's conversation, for a reveal the console records
-- with the admin's reason. NULL when the case has no conversation.
CREATE FUNCTION public.admin_support_reveal_phone(p_case_id UUID)
RETURNS TEXT
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $fn$
  SELECT wc.whatsapp_number::TEXT
    FROM public.admin_cases k
    JOIN public.whatsapp_conversations wc ON wc.id = k.conversation_id
   WHERE k.id = p_case_id
$fn$;

-- A reply, a request for more information, or the closing message (kind
-- 'closing', a fixed text that also resolves the case). Returns the outbox
-- id; NULL when a case with no conversation is resolved without a message.
-- The same request again answers the row it queued and changes nothing.
CREATE FUNCTION public.admin_queue_support_message(
  p_actor UUID,
  p_case_id UUID,
  p_request_id UUID,
  p_kind TEXT,
  p_text TEXT
)
RETURNS TABLE (result_id UUID, replayed BOOLEAN)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $fn$
#variable_conflict use_column
DECLARE
  v_role TEXT;
  v_action TEXT;
  v_fingerprint TEXT;
  v_seen BOOLEAN;
  v_prior UUID;
  v_text TEXT;
  v_status TEXT;
  v_conv UUID;
  v_details JSONB;
  v_number TEXT;
  v_conv_lang TEXT;
  v_lang TEXT;
  v_last TIMESTAMPTZ;
  v_open BOOLEAN;
  v_outbox UUID;
BEGIN
  IF p_case_id IS NULL OR p_request_id IS NULL OR p_kind IS NULL
     OR p_kind NOT IN ('reply', 'request_info', 'closing') THEN
    RAISE EXCEPTION 'invalid_input' USING ERRCODE = '22023';
  END IF;
  IF p_kind <> 'closing' THEN
    v_text := pg_catalog.regexp_replace(COALESCE(p_text, ''), U&'^[\0009-\000D\0020\00A0\1680\2000-\200A\2028\2029\202F\205F\3000\FEFF]+|[\0009-\000D\0020\00A0\1680\2000-\200A\2028\2029\202F\205F\3000\FEFF]+$', '', 'g');
    IF v_text = '' OR public.admin_support_utf16_length(v_text) > 1000 THEN
      RAISE EXCEPTION 'invalid_input' USING ERRCODE = '22023';
    END IF;
  END IF;

  v_role := public.admin_inbox_actor_role(p_actor);

  v_action := CASE p_kind WHEN 'closing' THEN 'resolve' ELSE p_kind END;
  v_fingerprint := pg_catalog.md5(pg_catalog.jsonb_build_array(p_case_id, p_kind, p_text)::text);
  SELECT s.seen, s.result_id INTO v_seen, v_prior
    FROM public.admin_inbox_request_seen(p_actor, p_request_id, v_action, v_fingerprint) AS s;
  IF v_seen THEN
    RETURN QUERY SELECT v_prior, true;
    RETURN;
  END IF;

  SELECT k.status, k.conversation_id, k.details INTO v_status, v_conv, v_details
    FROM public.admin_cases k
   WHERE k.id = p_case_id
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'not_found' USING ERRCODE = 'P0002';
  END IF;

  IF v_status IN ('resolved', 'dismissed') THEN
    RAISE EXCEPTION 'case_closed' USING ERRCODE = 'P0001';
  END IF;

  IF v_conv IS NOT NULL THEN
    SELECT wc.whatsapp_number, wc.language INTO v_number, v_conv_lang
      FROM public.whatsapp_conversations wc
     WHERE wc.id = v_conv;
  END IF;

  IF v_number IS NULL THEN
    IF p_kind <> 'closing' THEN
      RAISE EXCEPTION 'no_reply_target' USING ERRCODE = 'P0001';
    END IF;
    UPDATE public.admin_cases k
       SET status = 'resolved', resolved_at = pg_catalog.now(), updated_at = pg_catalog.now()
     WHERE k.id = p_case_id;
    INSERT INTO public.admin_case_events (case_id, event_type, actor_type, actor_id, payload, created_at)
    VALUES (p_case_id, 'admin_note', 'admin', p_actor::text,
            pg_catalog.jsonb_build_object(
              'title', 'Case resolved',
              'detail', 'Resolved without a WhatsApp message: the case has no conversation',
              'action', 'resolve',
              'byRole', v_role),
            pg_catalog.clock_timestamp());
    PERFORM public.admin_inbox_request_remember(p_actor, p_request_id, v_action, v_fingerprint, NULL);
    RETURN QUERY SELECT NULL::UUID, false;
    RETURN;
  END IF;

  v_lang := CASE
              WHEN v_details ->> 'language' IN ('es', 'en') THEN v_details ->> 'language'
              WHEN v_conv_lang IN ('es', 'en') THEN v_conv_lang
              ELSE 'es'
            END;
  IF p_kind = 'closing' THEN
    v_text := CASE v_lang
                WHEN 'en' THEN 'Your support case is closed. Send SOPORTE / SUPPORT any time to chat with us again.'
                ELSE U&'Tu caso de soporte est\00E1 cerrado. Escribe SOPORTE cuando quieras para volver a hablar con nosotros.'
              END;
  END IF;

  -- A window that closes within 30 minutes (23h15m after the last message)
  -- counts as closed for the cap.
  v_last := public.admin_support_last_inbound(v_number);
  v_open := COALESCE(v_last > pg_catalog.now() - interval '23 hours 15 minutes', false);
  IF NOT v_open AND public.admin_support_utf16_length(public.admin_support_one_line(v_text)) > 250 THEN
    RAISE EXCEPTION 'reply_too_long_for_template' USING ERRCODE = 'P0001';
  END IF;

  v_outbox := public.admin_support_enqueue(p_case_id, v_number, p_request_id, p_kind, v_text, v_lang, p_actor, v_role);

  UPDATE public.admin_cases k
     SET status = CASE WHEN p_kind = 'closing' THEN 'resolved' ELSE 'pending_worker' END,
         resolved_at = CASE WHEN p_kind = 'closing' THEN pg_catalog.now() ELSE k.resolved_at END,
         updated_at = pg_catalog.now()
   WHERE k.id = p_case_id;

  PERFORM public.admin_inbox_request_remember(p_actor, p_request_id, v_action, v_fingerprint, v_outbox);
  RETURN QUERY SELECT v_outbox, false;
END;
$fn$;

-- A lockout's page: where the challenge stands, its history (status changes
-- and admin resets, oldest first), the resets of the number's earlier
-- challenges (this challenge's own are in its history), the
-- typical time to verify over the last 30 days, and the number's open
-- support case. No phone hash, no user id, a masked number only. No row for
-- an unknown challenge.
CREATE FUNCTION public.admin_identity_challenge_detail(p_challenge_id UUID)
RETURNS TABLE (
  challenge_id              UUID,
  state                     TEXT,
  language                  TEXT,
  masked_phone              TEXT,
  attempts                  INTEGER,
  locked_until              TIMESTAMPTZ,
  started_at                TIMESTAMPTZ,
  earlier_resets            INTEGER,
  typical_minutes_to_verify INTEGER,
  support_case_id           UUID,
  timeline                  JSONB
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $fn$
#variable_conflict use_column
DECLARE
  c RECORD;
  v_conv UUID;
  v_number TEXT;
  v_conv_user UUID;
  v_resets INTEGER;
  v_typical INTEGER;
  v_case UUID;
  v_timeline JSONB;
BEGIN
  IF p_challenge_id IS NULL THEN
    RAISE EXCEPTION 'invalid_input' USING ERRCODE = '22023';
  END IF;

  SELECT ch.id, ch.phone_hash, ch.status, ch.current_step_key, ch.preferred_language, ch.attempts,
         ch.locked_until, ch.expires_at, ch.updated_at, ch.created_at, ch.verified_user_id
    INTO c
    FROM public.worker_identity_challenges ch
   WHERE ch.id = p_challenge_id;
  IF NOT FOUND THEN
    RETURN;
  END IF;

  -- whatsapp_number is unique and stored as trimmed E.164, so in practice
  -- one row matches (102's lookup).
  SELECT wc.id, wc.whatsapp_number, wc.user_id INTO v_conv, v_number, v_conv_user
    FROM public.whatsapp_conversations wc
   WHERE pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(pg_catalog.btrim(wc.whatsapp_number), 'UTF8')), 'hex') = c.phone_hash
   ORDER BY wc.created_at DESC, wc.id DESC
   LIMIT 1;

  PERFORM pg_catalog.set_config('app.admin_analytics_read', 'on', true);
  PERFORM pg_catalog.set_config('app.identity_lockout_resets', 'on', true);

  SELECT pg_catalog.count(*)::INTEGER INTO v_resets
    FROM public.identity_lockout_resets r
   WHERE r.phone_hash = c.phone_hash
     AND r.challenge_id IS DISTINCT FROM c.id;

  -- Minutes from a challenge's start to its verification, for challenges
  -- started in the last 30 days with recorded (not backfilled) history.
  SELECT pg_catalog.round((pg_catalog.percentile_cont(0.5) WITHIN GROUP (ORDER BY t.minutes))::NUMERIC)::INTEGER
    INTO v_typical
    FROM (SELECT EXTRACT(EPOCH FROM (v.verified_at - s.changed_at)) / 60 AS minutes
            FROM public.worker_identity_challenge_events s
            CROSS JOIN LATERAL (
              SELECT min(e.changed_at) AS verified_at
                FROM public.worker_identity_challenge_events e
               WHERE e.challenge_id = s.challenge_id
                 AND e.to_status = 'verified'
                 AND NOT e.is_backfill) AS v
           WHERE s.from_status IS NULL
             AND NOT s.is_backfill
             AND s.changed_at >= pg_catalog.now() - interval '30 days'
             AND v.verified_at IS NOT NULL) AS t;

  IF v_conv IS NOT NULL THEN
    SELECT k.id INTO v_case
      FROM public.admin_cases k
     WHERE k.case_type = 'help_request'
       AND k.status IN ('open', 'pending_worker', 'pending_admin')
       AND (k.conversation_id = v_conv OR (v_conv_user IS NOT NULL AND k.user_id = v_conv_user))
     ORDER BY (k.conversation_id IS NOT DISTINCT FROM v_conv) DESC, k.created_at ASC, k.id ASC
     LIMIT 1;
  END IF;

  SELECT COALESCE(pg_catalog.jsonb_agg(t.item ORDER BY t.occurred, t.ord, t.seq), '[]'::JSONB) INTO v_timeline
    FROM (
      SELECT e.changed_at AS occurred, 1 AS ord, e.id AS seq,
             pg_catalog.jsonb_build_object(
               'kind', 'status',
               'at', e.changed_at,
               'from_status', e.from_status,
               'to_status', e.to_status,
               'attempts', e.attempts,
               'locked_until', e.locked_until,
               'is_backfill', e.is_backfill) AS item
        FROM public.worker_identity_challenge_events e
       WHERE e.challenge_id = c.id
      UNION ALL
      SELECT r.created_at, 0, 0,
             pg_catalog.jsonb_build_object(
               'kind', 'reset',
               'at', r.created_at,
               'reason_code', r.reason_code,
               'by_role', CASE a.role
                            WHEN 'admin_superadmin' THEN 'Superadmin'
                            WHEN 'admin_ops' THEN 'Ops'
                            WHEN 'admin_readonly' THEN 'Read-only'
                          END)
        FROM public.identity_lockout_resets r
        LEFT JOIN public.admin_users a ON a.id = r.admin_user_id
       WHERE r.challenge_id = c.id
    ) AS t;

  PERFORM pg_catalog.set_config('app.identity_lockout_resets', '', true);
  PERFORM pg_catalog.set_config('app.admin_analytics_read', '', true);

  RETURN QUERY SELECT
    c.id,
    public.admin_identity_challenge_state(c.status, c.current_step_key, c.locked_until, c.expires_at,
                                          c.updated_at, c.verified_user_id),
    c.preferred_language,
    public.admin_mask_phone(v_number),
    c.attempts,
    c.locked_until,
    c.created_at,
    v_resets,
    v_typical,
    v_case,
    v_timeline;
END;
$fn$;

-- Resets a locked or stuck challenge so the worker's next code attempt
-- starts fresh: status pending, no attempts, no lock, no code expiry, and a
-- fresh resend budget. Records the reset with its reason, opens a resolved
-- verification case for the number holding a lockout_reset event, and
-- queues the notice in the worker's language. Returns that case. The same
-- request again answers the same case.
CREATE FUNCTION public.admin_reset_identity_lockout(
  p_actor UUID,
  p_challenge_id UUID,
  p_reason TEXT,
  p_note TEXT,
  p_request_id UUID
)
RETURNS TABLE (result_id UUID, replayed BOOLEAN)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $fn$
#variable_conflict use_column
DECLARE
  v_note TEXT;
  v_role TEXT;
  v_fingerprint TEXT;
  v_seen BOOLEAN;
  v_prior UUID;
  v_hash TEXT;
  c RECORD;
  v_conv UUID;
  v_number TEXT;
  v_conv_user UUID;
  v_lang TEXT;
  v_ref TEXT;
  v_case UUID;
BEGIN
  v_note := NULLIF(pg_catalog.regexp_replace(COALESCE(p_note, ''), U&'^[\0009-\000D\0020\00A0\1680\2000-\200A\2028\2029\202F\205F\3000\FEFF]+|[\0009-\000D\0020\00A0\1680\2000-\200A\2028\2029\202F\205F\3000\FEFF]+$', '', 'g'), '');
  IF p_challenge_id IS NULL OR p_request_id IS NULL OR p_reason IS NULL
     OR p_reason NOT IN ('codes_not_arriving', 'worker_confused', 'typo_in_details',
                         'identity_confirmed_elsewhere', 'other')
     OR public.admin_support_utf16_length(v_note) > 300
     OR (p_reason = 'other' AND v_note IS NULL) THEN
    RAISE EXCEPTION 'invalid_input' USING ERRCODE = '22023';
  END IF;

  v_role := public.admin_inbox_actor_role(p_actor);

  v_fingerprint := pg_catalog.md5(pg_catalog.jsonb_build_array(p_challenge_id, p_reason, p_note)::text);
  SELECT s.seen, s.result_id INTO v_seen, v_prior
    FROM public.admin_inbox_request_seen(p_actor, p_request_id, 'reset_lockout', v_fingerprint) AS s;
  IF v_seen THEN
    RETURN QUERY SELECT v_prior, true;
    RETURN;
  END IF;

  SELECT ch.phone_hash INTO v_hash FROM public.worker_identity_challenges ch WHERE ch.id = p_challenge_id;
  IF v_hash IS NULL THEN
    RAISE EXCEPTION 'not_found' USING ERRCODE = 'P0002';
  END IF;
  -- The pre-auth save's lock (save_worker_pre_auth, 042): the bot never
  -- writes this number's challenge while the reset runs.
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(v_hash, 0));

  SELECT ch.id, ch.status, ch.current_step_key, ch.preferred_language, ch.locked_until, ch.expires_at,
         ch.updated_at, ch.verified_user_id
    INTO c
    FROM public.worker_identity_challenges ch
   WHERE ch.id = p_challenge_id
   FOR UPDATE;
  IF public.admin_identity_challenge_state(c.status, c.current_step_key, c.locked_until, c.expires_at,
                                           c.updated_at, c.verified_user_id) NOT IN ('locked', 'stuck_at_code') THEN
    RAISE EXCEPTION 'not_locked' USING ERRCODE = 'P0001';
  END IF;

  SELECT wc.id, wc.whatsapp_number, wc.user_id INTO v_conv, v_number, v_conv_user
    FROM public.whatsapp_conversations wc
   WHERE pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(pg_catalog.btrim(wc.whatsapp_number), 'UTF8')), 'hex') = v_hash
   ORDER BY wc.created_at DESC, wc.id DESC
   LIMIT 1;
  IF v_conv IS NULL THEN
    RAISE EXCEPTION 'no_reply_target' USING ERRCODE = 'P0001';
  END IF;

  UPDATE public.worker_identity_challenges ch
     SET status = 'pending',
         attempts = 0,
         locked_until = NULL,
         expires_at = NULL,
         context = ch.context - 'otpSendHistory',
         updated_at = pg_catalog.now()
   WHERE ch.id = c.id;

  v_lang := CASE WHEN c.preferred_language IN ('es', 'en') THEN c.preferred_language ELSE 'es' END;
  v_ref := 'V-' || pg_catalog.upper(pg_catalog.left(c.id::text, 8));

  INSERT INTO public.admin_cases (case_type, status, priority, user_id, conversation_id, summary, details, resolved_at)
  VALUES (
    'verification_blocker', 'resolved', 50, v_conv_user, v_conv, 'Verification lockout reset',
    pg_catalog.jsonb_build_object(
      'subjectType', 'worker',
      'workerLabel', CASE WHEN v_conv_user IS NULL THEN 'Unregistered number' ELSE 'Worker' END,
      'conversationRef', v_conv::text,
      'language', v_lang,
      'registered', v_conv_user IS NOT NULL,
      'source', 'admin_lockout_reset',
      'challengeRef', v_ref),
    pg_catalog.now())
  RETURNING id INTO v_case;

  INSERT INTO public.admin_case_events (case_id, event_type, actor_type, actor_id, payload, created_at)
  VALUES (v_case, 'case_created', 'admin', p_actor::text,
          pg_catalog.jsonb_build_object(
            'title', 'Verification case opened',
            'detail', 'Opened by a lockout reset',
            'byRole', v_role),
          pg_catalog.clock_timestamp());
  INSERT INTO public.admin_case_events (case_id, event_type, actor_type, actor_id, payload, created_at)
  VALUES (v_case, 'lockout_reset', 'admin', p_actor::text,
          pg_catalog.jsonb_build_object(
            'title', 'Verification reset',
            'detail', 'Reason: ' || CASE p_reason
                                      WHEN 'codes_not_arriving' THEN 'Codes not arriving'
                                      WHEN 'worker_confused' THEN 'Worker confused by the steps'
                                      WHEN 'typo_in_details' THEN 'Typo in their details'
                                      WHEN 'identity_confirmed_elsewhere' THEN 'Confirmed identity another way'
                                      ELSE 'Other'
                                    END,
            'reasonCode', p_reason,
            'challengeRef', v_ref,
            'byRole', v_role),
          pg_catalog.clock_timestamp());

  PERFORM public.admin_support_enqueue(
    v_case, v_number, p_request_id, 'lockout_notice',
    CASE v_lang
      WHEN 'en' THEN 'You can verify again now. Reply RESEND to get a new code.'
      ELSE U&'Ya puedes verificar de nuevo. Responde REENVIAR para recibir un c\00F3digo nuevo.'
    END,
    v_lang, p_actor, v_role);

  PERFORM pg_catalog.set_config('app.identity_lockout_resets', 'on', true);
  INSERT INTO public.identity_lockout_resets
    (challenge_id, phone_hash, reason_code, note, admin_user_id, case_id)
  VALUES (c.id, v_hash, p_reason, v_note, p_actor, v_case);
  PERFORM pg_catalog.set_config('app.identity_lockout_resets', '', true);

  PERFORM public.admin_inbox_request_remember(p_actor, p_request_id, 'reset_lockout', v_fingerprint, v_case);
  RETURN QUERY SELECT v_case, false;
END;
$fn$;

-- Opens the number's support case from a lockout page, or reuses the open
-- one (the bot's dedupe and lock key), with an admin_note naming the
-- lockout. Sends nothing: the admin's first reply starts the conversation.
CREATE FUNCTION public.admin_open_support_from_lockout(p_actor UUID, p_challenge_id UUID, p_request_id UUID)
RETURNS TABLE (result_id UUID, replayed BOOLEAN)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $fn$
#variable_conflict use_column
DECLARE
  v_role TEXT;
  v_fingerprint TEXT;
  v_seen BOOLEAN;
  v_prior UUID;
  v_hash TEXT;
  v_lang TEXT;
  v_conv UUID;
  v_conv_user UUID;
  v_case UUID;
  v_ref TEXT;
BEGIN
  IF p_challenge_id IS NULL OR p_request_id IS NULL THEN
    RAISE EXCEPTION 'invalid_input' USING ERRCODE = '22023';
  END IF;

  v_role := public.admin_inbox_actor_role(p_actor);

  v_fingerprint := pg_catalog.md5(pg_catalog.jsonb_build_array(p_challenge_id)::text);
  SELECT s.seen, s.result_id INTO v_seen, v_prior
    FROM public.admin_inbox_request_seen(p_actor, p_request_id, 'open_support', v_fingerprint) AS s;
  IF v_seen THEN
    RETURN QUERY SELECT v_prior, true;
    RETURN;
  END IF;

  SELECT ch.phone_hash, ch.preferred_language INTO v_hash, v_lang
    FROM public.worker_identity_challenges ch
   WHERE ch.id = p_challenge_id;
  IF v_hash IS NULL THEN
    RAISE EXCEPTION 'not_found' USING ERRCODE = 'P0002';
  END IF;
  v_lang := CASE WHEN v_lang IN ('es', 'en') THEN v_lang ELSE 'es' END;
  v_ref := 'V-' || pg_catalog.upper(pg_catalog.left(p_challenge_id::text, 8));

  SELECT wc.id, wc.user_id INTO v_conv, v_conv_user
    FROM public.whatsapp_conversations wc
   WHERE pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(pg_catalog.btrim(wc.whatsapp_number), 'UTF8')), 'hex') = v_hash
   ORDER BY wc.created_at DESC, wc.id DESC
   LIMIT 1;
  IF v_conv IS NULL THEN
    RAISE EXCEPTION 'no_reply_target' USING ERRCODE = 'P0001';
  END IF;

  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('admin-support-case:' || v_conv::text, 0));

  -- The conversation's own open case first, then the worker's (121).
  SELECT k.id INTO v_case
    FROM public.admin_cases k
   WHERE k.case_type = 'help_request'
     AND k.status IN ('open', 'pending_worker', 'pending_admin')
     AND (k.conversation_id = v_conv OR (v_conv_user IS NOT NULL AND k.user_id = v_conv_user))
   ORDER BY (k.conversation_id IS NOT DISTINCT FROM v_conv) DESC, k.created_at ASC, k.id ASC
   LIMIT 1
   FOR UPDATE;

  IF v_case IS NOT NULL THEN
    UPDATE public.admin_cases k
       SET conversation_id = v_conv,
           user_id = COALESCE(k.user_id, v_conv_user),
           updated_at = pg_catalog.now()
     WHERE k.id = v_case;
  ELSE
    INSERT INTO public.admin_cases (case_type, status, priority, user_id, conversation_id, summary, details)
    VALUES (
      'help_request', 'open', 70, v_conv_user, v_conv, 'Support conversation opened from a lockout',
      pg_catalog.jsonb_build_object(
        'subjectType', 'worker',
        'workerLabel', CASE WHEN v_conv_user IS NULL THEN 'Unregistered number' ELSE 'Worker' END,
        'conversationRef', v_conv::text,
        'language', v_lang,
        'registered', v_conv_user IS NOT NULL,
        'source', 'admin_lockout'))
    RETURNING id INTO v_case;
    INSERT INTO public.admin_case_events (case_id, event_type, actor_type, actor_id, payload, created_at)
    VALUES (v_case, 'case_created', 'admin', p_actor::text,
            pg_catalog.jsonb_build_object(
              'title', 'Support case opened',
              'detail', 'Opened by an admin from a lockout',
              'byRole', v_role),
            pg_catalog.clock_timestamp());
  END IF;

  INSERT INTO public.admin_case_events (case_id, event_type, actor_type, actor_id, payload, created_at)
  VALUES (v_case, 'admin_note', 'admin', p_actor::text,
          pg_catalog.jsonb_build_object(
            'title', 'Opened from a lockout',
            'detail', 'Opened from lockout ' || v_ref,
            'action', 'open_support',
            'challengeRef', v_ref,
            'byRole', v_role),
          pg_catalog.clock_timestamp());

  PERFORM public.admin_inbox_request_remember(p_actor, p_request_id, 'open_support', v_fingerprint, v_case);
  RETURN QUERY SELECT v_case, false;
END;
$fn$;

REVOKE ALL ON FUNCTION public.identity_lockout_resets_forget_phone() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.admin_inbox_actor_role(UUID) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.admin_support_last_inbound(TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.admin_identity_challenge_state(TEXT, TEXT, TIMESTAMPTZ, TIMESTAMPTZ, TIMESTAMPTZ, UUID) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.admin_support_enqueue(UUID, TEXT, UUID, TEXT, TEXT, TEXT, UUID, TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.admin_support_case_view(UUID) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.admin_support_media_link(UUID, UUID) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.admin_support_reveal_phone(UUID) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.admin_queue_support_message(UUID, UUID, UUID, TEXT, TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.admin_identity_challenge_detail(UUID) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.admin_reset_identity_lockout(UUID, UUID, TEXT, TEXT, UUID) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.admin_open_support_from_lockout(UUID, UUID, UUID) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.admin_support_one_line(TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.admin_support_utf16_length(TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.admin_inbox_request_seen(UUID, UUID, TEXT, TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.admin_inbox_request_remember(UUID, UUID, TEXT, TEXT, UUID) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION public.admin_support_case_view(UUID) TO jale_admin_console;
GRANT EXECUTE ON FUNCTION public.admin_support_media_link(UUID, UUID) TO jale_admin_console;
GRANT EXECUTE ON FUNCTION public.admin_support_reveal_phone(UUID) TO jale_admin_console;
GRANT EXECUTE ON FUNCTION public.admin_queue_support_message(UUID, UUID, UUID, TEXT, TEXT) TO jale_admin_console;
GRANT EXECUTE ON FUNCTION public.admin_identity_challenge_detail(UUID) TO jale_admin_console;
GRANT EXECUTE ON FUNCTION public.admin_reset_identity_lockout(UUID, UUID, TEXT, TEXT, UUID) TO jale_admin_console;
GRANT EXECUTE ON FUNCTION public.admin_open_support_from_lockout(UUID, UUID, UUID) TO jale_admin_console;

-- Self-check before COMMIT: owner, security, pinned search path and EXECUTE
-- exactly as above; the resets table forced and closed to every login; the
-- console's outbox insert gone; the case number unique.
DO $$
DECLARE
  fn RECORD;
BEGIN
  FOR fn IN
    SELECT * FROM (VALUES
      ('public.identity_lockout_resets_forget_phone()', false, false),
      ('public.admin_inbox_actor_role(uuid)', true, false),
      ('public.admin_support_last_inbound(text)', true, false),
      ('public.admin_identity_challenge_state(text, text, timestamp with time zone, timestamp with time zone, timestamp with time zone, uuid)', false, false),
      ('public.admin_support_enqueue(uuid, text, uuid, text, text, text, uuid, text)', true, false),
      ('public.admin_support_case_view(uuid)', true, true),
      ('public.admin_support_media_link(uuid, uuid)', true, true),
      ('public.admin_support_reveal_phone(uuid)', true, true),
      ('public.admin_queue_support_message(uuid, uuid, uuid, text, text)', true, true),
      ('public.admin_identity_challenge_detail(uuid)', true, true),
      ('public.admin_reset_identity_lockout(uuid, uuid, text, text, uuid)', true, true),
      ('public.admin_open_support_from_lockout(uuid, uuid, uuid)', true, true),
      ('public.admin_support_one_line(text)', false, false),
      ('public.admin_support_utf16_length(text)', false, false),
      ('public.admin_inbox_request_seen(uuid, uuid, text, text)', true, false),
      ('public.admin_inbox_request_remember(uuid, uuid, text, text, uuid)', true, false)
    ) AS expected(sig, definer, console)
  LOOP
    IF NOT EXISTS (
      SELECT 1 FROM pg_catalog.pg_proc p
       WHERE p.oid = fn.sig::regprocedure
         AND p.prosecdef = fn.definer
         AND p.proowner = 'jale_admin'::regrole
         AND COALESCE(p.proconfig @> ARRAY['search_path=pg_catalog, pg_temp'], false)
         AND NOT pg_catalog.has_function_privilege('public', p.oid, 'EXECUTE')
         AND pg_catalog.has_function_privilege('jale_admin_console', p.oid, 'EXECUTE') = fn.console
         AND NOT pg_catalog.has_function_privilege('jale_whatsapp', p.oid, 'EXECUTE')
    ) THEN
      RAISE EXCEPTION 'migration 122: % has the wrong owner, security, search_path or grants', fn.sig;
    END IF;
  END LOOP;

  IF NOT EXISTS (
       SELECT 1 FROM pg_catalog.pg_class c
        WHERE c.oid = 'public.identity_lockout_resets'::regclass
          AND c.relrowsecurity AND c.relforcerowsecurity)
     OR pg_catalog.has_table_privilege('jale_admin_console', 'public.identity_lockout_resets', 'SELECT')
     OR pg_catalog.has_table_privilege('jale_whatsapp', 'public.identity_lockout_resets', 'SELECT') THEN
    RAISE EXCEPTION 'migration 122: identity_lockout_resets is not forced, or a login can read it';
  END IF;
  IF NOT EXISTS (
       SELECT 1 FROM pg_catalog.pg_class c
        WHERE c.oid = 'public.admin_inbox_requests'::regclass
          AND c.relrowsecurity AND c.relforcerowsecurity)
     OR pg_catalog.has_table_privilege('jale_admin_console', 'public.admin_inbox_requests', 'SELECT')
     OR pg_catalog.has_table_privilege('jale_whatsapp', 'public.admin_inbox_requests', 'SELECT') THEN
    RAISE EXCEPTION 'migration 122: admin_inbox_requests is not forced, or a login can read it';
  END IF;

  IF pg_catalog.has_table_privilege('jale_admin_console', 'public.whatsapp_outbox', 'INSERT')
     OR EXISTS (SELECT 1 FROM pg_catalog.pg_policy p
                 WHERE p.polrelid = 'public.whatsapp_outbox'::regclass
                   AND p.polname = 'whatsapp_outbox_console_insert') THEN
    RAISE EXCEPTION 'migration 122: the console can still insert into whatsapp_outbox';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_attribute a
     WHERE a.attrelid = 'public.admin_cases'::regclass
       AND a.attname = 'case_number'
       AND a.attnotnull
       AND a.attidentity = 'd'
  ) OR NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_constraint k
     WHERE k.conrelid = 'public.admin_cases'::regclass
       AND k.conname = 'admin_cases_case_number_key'
       AND k.contype = 'u'
  ) THEN
    RAISE EXCEPTION 'migration 122: admin_cases.case_number is not a unique identity';
  END IF;
END $$;

COMMIT;
