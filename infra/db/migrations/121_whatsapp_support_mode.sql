-- ============================================================
-- 121_whatsapp_support_mode.sql
-- Run manually AFTER 117_admin_queues.sql,
-- connected as jale_admin. Forward-only (ADR-005).
-- It reads nothing 120 creates; the runner applies it after 120.
--
-- Sprint 28: WhatsApp support mode. A worker who types SOPORTE / SUPPORT
-- (registered or not) enters support mode: every message and photo goes to
-- one help_request case, the bot stays quiet, and MENU, a closed case or 24
-- quiet hours end the mode. Each active admin is emailed once when a case is
-- created.
--
-- (1) whatsapp_conversations.support_case_id / support_last_activity_at: the
--     mode's state. Written by the WhatsApp login only (it already has full
--     rights on the table); the console never writes the conversation row.
--     The 24-hour idle end is checked lazily on the next inbound, on the
--     database clock; there is no sweeper.
-- (2) support_case_media: one row per attachment the bot stored (key, type,
--     size, 90-day expiry). Forced row security with one gated policy for
--     the definers' owner; no login holds any right on it. The console reads
--     it through a definer of its own (migration 122).
-- (3) Definers, every one owned by jale_admin with a pinned search path and
--     EXECUTE revoked from PUBLIC; six are executable by jale_whatsapp:
--       support_open_case            open or reuse the conversation's case
--       support_append_message       a text or media message on the case
--       support_mode_state           is the case still open, last admin reply
--       support_reentry_case         the case a free-text answer re-enters
--       support_record_mode_change   mode entered / exited on the timeline
--       support_record_admin_delivery  the dispatcher's outcome per reply
--     and support_notify_admins, called only by support_open_case when it
--     creates a case, is executable by no login. jale_whatsapp has no right
--     on admin_cases, admin_case_events, admin_users or email_outbox, so
--     every write there goes through these functions.
-- (4) email_outbox_admin_support_insert: the INSERT policy under which the
--     definers' owner queues support-case mail (source_type
--     admin_support_case). Permissive policies OR together, so it adds this
--     kind beside the employer_digest mail that owner's existing INSERT
--     policy allows (082).
--
-- OWNER. The definers are owned by jale_admin because admin_cases,
-- admin_case_events and admin_users are FORCE ROW LEVEL SECURITY and only
-- jale_admin's policies on them (026) let a definer read and write rows. A
-- definer owned by any other role would read zero admin rows and queue no
-- email without an error; the preconditions below refuse to apply if those
-- policies are missing, and the integration suite asserts the queued rows.
--
-- DEDUPE. One open help_request case per conversation (or per worker, when
-- the number is registered), serialized by a transaction advisory lock on
-- hashtextextended('admin-support-case:' || conversation id, 0). Any other
-- path that opens a support case for a conversation takes the same key.
--
-- DEPLOY ORDER: apply BEFORE deploying the WhatsApp stack whose processor
-- and admin dispatcher call these functions.
-- ============================================================
BEGIN;

-- Fail fast instead of queueing conversation and email reads and writes
-- behind a stuck transaction (the columns, the foreign key and the policy
-- take strong locks until COMMIT); a timed-out apply writes no ledger row
-- and can simply be rerun.
SET LOCAL lock_timeout = '5s';

-- Preconditions. pg_policy and pg_class are catalogs, so row security never
-- filters these checks.
DO $$
DECLARE
  pol RECORD;
BEGIN
  IF session_user <> 'jale_admin' OR current_user <> 'jale_admin' THEN
    RAISE EXCEPTION 'migration 121: connect as jale_admin (this session runs as %)', current_user;
  END IF;

  -- The definers read and write the admin tables through these policies.
  FOR pol IN
    SELECT * FROM (VALUES
      ('public.admin_cases', 'admin_cases_service_all'),
      ('public.admin_case_events', 'admin_case_events_service_all'),
      ('public.admin_users', 'admin_users_self_or_service')
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
         AND pg_catalog.pg_get_expr(p.polwithcheck, p.polrelid) = 'true'
    ) THEN
      RAISE EXCEPTION 'migration 121: policy % on % missing or drifted; the support definers would read or write no rows', pol.name, pol.rel;
    END IF;
  END LOOP;

  -- A RESTRICTIVE policy is AND'ed with the ones above and could hide rows
  -- or refuse the definers' writes just as silently.
  IF EXISTS (
    SELECT 1 FROM pg_catalog.pg_policy p
     WHERE p.polrelid IN ('public.admin_cases'::regclass, 'public.admin_case_events'::regclass,
                          'public.admin_users'::regclass, 'public.email_outbox'::regclass)
       AND NOT p.polpermissive
       AND ('jale_admin'::regrole::oid = ANY (p.polroles) OR 0::oid = ANY (p.polroles))
  ) THEN
    RAISE EXCEPTION 'migration 121: a restrictive policy for jale_admin or PUBLIC on a table the support definers use';
  END IF;

  -- The definers read these two as their owner, which needs them unforced.
  IF EXISTS (
    SELECT 1 FROM pg_catalog.pg_class c
     WHERE c.oid IN ('public.whatsapp_conversations'::regclass, 'public.whatsapp_outbox'::regclass)
       AND (c.relforcerowsecurity OR c.relowner <> 'jale_admin'::regrole)
  ) THEN
    RAISE EXCEPTION 'migration 121: whatsapp_conversations or whatsapp_outbox is forced or not owned by jale_admin';
  END IF;

  -- A worker's follow-up moves a case from pending_worker to pending_admin;
  -- 117's trigger records that on the timeline.
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_trigger t
     WHERE t.tgrelid = 'public.admin_cases'::regclass
       AND t.tgname = 'admin_cases_record_status_change'
  ) THEN
    RAISE EXCEPTION 'migration 121: apply 117 first (admin_cases_record_status_change is missing)';
  END IF;
END $$;

-- ── (1) Support-mode state on the conversation row ──────────
ALTER TABLE public.whatsapp_conversations
  ADD COLUMN support_case_id UUID REFERENCES public.admin_cases(id) ON DELETE SET NULL,
  ADD COLUMN support_last_activity_at TIMESTAMPTZ;

-- Every row starts NULL, so the partial index is empty at build time. It
-- serves the foreign key's ON DELETE SET NULL lookup when a case is deleted.
CREATE INDEX whatsapp_conversations_support_case_idx
  ON public.whatsapp_conversations (support_case_id)
  WHERE support_case_id IS NOT NULL;

-- ── (2) Attachments the bot stored for a case ───────────────
-- The object lives in the private support-media bucket under
-- support/<case id>/<uuid>.<ext>; this row carries the key and the type the
-- bot sniffed from the bytes, never the content.
CREATE TABLE public.support_case_media (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  case_id      UUID NOT NULL REFERENCES public.admin_cases(id) ON DELETE CASCADE,
  event_id     UUID NOT NULL REFERENCES public.admin_case_events(id) ON DELETE CASCADE,
  s3_key       TEXT NOT NULL UNIQUE
               CHECK (s3_key ~ '^support/[0-9a-f-]{36}/[0-9a-f-]{36}\.(jpg|png|webp|ogg|mp3|m4a|pdf)$'),
  media_type   TEXT NOT NULL CHECK (media_type IN ('image', 'audio', 'document')),
  content_type TEXT NOT NULL CHECK (content_type IN (
                 'image/jpeg', 'image/png', 'image/webp', 'audio/ogg', 'audio/mpeg', 'audio/mp4', 'application/pdf')),
  byte_size    INTEGER NOT NULL CHECK (byte_size BETWEEN 1 AND 10485760),
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at   TIMESTAMPTZ NOT NULL,
  CHECK (expires_at > created_at)
);

CREATE INDEX support_case_media_case_idx ON public.support_case_media (case_id, created_at);

ALTER TABLE public.support_case_media ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.support_case_media FORCE ROW LEVEL SECURITY;
REVOKE ALL ON public.support_case_media FROM PUBLIC;

-- The definers that write or read this table open the transaction-local
-- flag around that statement and close it again. No login holds a right on
-- the table, so the flag reaches nothing outside them.
CREATE POLICY support_case_media_definer_access
  ON public.support_case_media FOR ALL
  TO jale_admin
  USING (current_setting('app.support_case_media', true) = 'on')
  WITH CHECK (current_setting('app.support_case_media', true) = 'on');

-- ── (4) Support-case notices in the email queue ─────────────
CREATE POLICY email_outbox_admin_support_insert
  ON public.email_outbox FOR INSERT
  TO jale_admin
  WITH CHECK (source_type = 'admin_support_case');

-- ── (3) Definers ────────────────────────────────────────────

-- One email per active admin (every role) for a newly created case: a fixed
-- text and the case link, nothing about the worker. NULL base address: no
-- email (returns 0). Returns the number of rows queued.
CREATE FUNCTION public.support_notify_admins(p_case_id UUID, p_admin_base_url TEXT)
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $fn$
DECLARE
  v_link TEXT;
  v_href TEXT;
  v_rows INTEGER;
BEGIN
  IF p_admin_base_url IS NULL THEN
    RETURN 0;
  END IF;
  IF p_admin_base_url !~ '^https://[a-z0-9.-]+(:[0-9]+)?$' THEN
    RAISE EXCEPTION 'support_admin_base_url_invalid' USING ERRCODE = '22023';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.admin_cases c WHERE c.id = p_case_id AND c.case_type = 'help_request'
  ) THEN
    RAISE EXCEPTION 'support_case_not_found' USING ERRCODE = 'P0002';
  END IF;

  v_link := p_admin_base_url || '/inbox/support/' || p_case_id::text;
  v_href := pg_catalog.replace(pg_catalog.replace(pg_catalog.replace(pg_catalog.replace(pg_catalog.replace(
              v_link, '&', '&amp;'), '<', '&lt;'), '>', '&gt;'), '"', '&quot;'), '''', '&#39;');

  INSERT INTO public.email_outbox
    (recipient_email, subject, body_text, body_html, source_type, source_id, idempotency_key)
  SELECT a.admin_email,
         'New support case in the Jale admin console',
         'A worker asked for help on WhatsApp. Open the case: ' || v_link,
         '<!doctype html><html lang="en"><body style="margin:0;padding:24px;color:#1a1a1a;'
         || 'font-family:Arial,Helvetica,sans-serif;font-size:15px;line-height:1.5;">'
         || '<p style="margin:0 0 16px;">A worker asked for help on WhatsApp.</p>'
         || '<p style="margin:0;"><a href="' || v_href || '">Open the case</a></p>'
         || '</body></html>',
         'admin_support_case',
         p_case_id,
         'admin-support-case:' || p_case_id::text || ':' || a.id::text
    FROM public.admin_users a
   WHERE a.active
  ON CONFLICT DO NOTHING;
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  RETURN v_rows;
END;
$fn$;

-- Opens the conversation's support case, or reuses the open one. The worker
-- is the conversation's own (NULL for an unregistered number); a caller
-- naming any other worker is refused. Reuse records the message and moves a
-- case waiting on the worker back to waiting on the team; creation records
-- the case and the message and emails the admins once.
CREATE FUNCTION public.support_open_case(
  p_conversation_id UUID,
  p_user_id UUID,
  p_language TEXT,
  p_first_message TEXT,
  p_admin_base_url TEXT
)
RETURNS TABLE (case_id UUID, created BOOLEAN)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $fn$
#variable_conflict use_column
DECLARE
  v_conv_user UUID;
  v_case UUID;
  v_user UUID;
  v_text TEXT;
  v_now_iso TEXT;
  v_count INTEGER;
BEGIN
  IF p_conversation_id IS NULL THEN
    RAISE EXCEPTION 'support_conversation_required' USING ERRCODE = '22004';
  END IF;
  IF p_language IS NULL OR p_language NOT IN ('es', 'en') THEN
    RAISE EXCEPTION 'support_language_invalid' USING ERRCODE = '22023';
  END IF;
  IF p_admin_base_url IS NOT NULL AND p_admin_base_url !~ '^https://[a-z0-9.-]+(:[0-9]+)?$' THEN
    RAISE EXCEPTION 'support_admin_base_url_invalid' USING ERRCODE = '22023';
  END IF;

  SELECT wc.user_id INTO v_conv_user
    FROM public.whatsapp_conversations wc
   WHERE wc.id = p_conversation_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'support_conversation_not_found' USING ERRCODE = '23503';
  END IF;
  IF p_user_id IS DISTINCT FROM v_conv_user THEN
    RAISE EXCEPTION 'support_conversation_worker_mismatch' USING ERRCODE = '23503';
  END IF;

  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('admin-support-case:' || p_conversation_id::text, 0));

  v_text := pg_catalog.left(COALESCE(NULLIF(pg_catalog.btrim(p_first_message), ''), 'support'), 4096);
  v_now_iso := pg_catalog.to_char(pg_catalog.now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"');

  -- The conversation's own open case first, then the worker's.
  SELECT c.id, c.user_id INTO v_case, v_user
    FROM public.admin_cases c
   WHERE c.case_type = 'help_request'
     AND c.status IN ('open', 'pending_worker', 'pending_admin')
     AND (c.conversation_id = p_conversation_id
          OR (v_conv_user IS NOT NULL AND c.user_id = v_conv_user))
   ORDER BY (c.conversation_id IS NOT DISTINCT FROM p_conversation_id) DESC, c.created_at ASC, c.id ASC
   LIMIT 1
   FOR UPDATE;

  IF v_case IS NOT NULL THEN
    v_user := COALESCE(v_user, v_conv_user);
    -- A worker's case found by worker moves to the number they write from now.
    UPDATE public.admin_cases c
       SET status = CASE WHEN c.status = 'pending_worker' THEN 'pending_admin' ELSE c.status END,
           conversation_id = p_conversation_id,
           user_id = v_user,
           details = c.details || pg_catalog.jsonb_build_object(
             'language', p_language,
             'lastMessage', pg_catalog.left(v_text, 2000),
             'lastWorkerMessageAt', v_now_iso,
             'registered', v_user IS NOT NULL),
           updated_at = pg_catalog.now()
     WHERE c.id = v_case;
    INSERT INTO public.admin_case_events (case_id, event_type, actor_type, actor_id, payload, created_at)
    VALUES (v_case, 'worker_message', 'worker', v_user::text,
            pg_catalog.jsonb_build_object('title', 'Worker message', 'detail', v_text),
            pg_catalog.clock_timestamp());
    RETURN QUERY SELECT v_case, false;
    RETURN;
  END IF;

  INSERT INTO public.admin_cases (case_type, status, priority, user_id, conversation_id, summary, details)
  VALUES (
    'help_request',
    'open',
    70,
    v_conv_user,
    p_conversation_id,
    'Worker asked for help on WhatsApp',
    pg_catalog.jsonb_build_object(
      'subjectType', 'worker',
      'workerLabel', CASE WHEN v_conv_user IS NULL THEN 'Unregistered number' ELSE 'Worker' END,
      'conversationRef', p_conversation_id::text,
      'language', p_language,
      'lastMessage', pg_catalog.left(v_text, 2000),
      'lastWorkerMessageAt', v_now_iso,
      'registered', v_conv_user IS NOT NULL,
      'source', 'whatsapp_support_mode'))
  RETURNING id INTO v_case;

  INSERT INTO public.admin_case_events (case_id, event_type, actor_type, actor_id, payload, created_at)
  VALUES (v_case, 'case_created', 'worker', v_conv_user::text,
          pg_catalog.jsonb_build_object(
            'title', 'Support case opened',
            'detail', 'A worker asked for help on WhatsApp',
            'source', 'whatsapp_support_mode'),
          pg_catalog.clock_timestamp());
  INSERT INTO public.admin_case_events (case_id, event_type, actor_type, actor_id, payload, created_at)
  VALUES (v_case, 'worker_message', 'worker', v_conv_user::text,
          pg_catalog.jsonb_build_object('title', 'Worker message', 'detail', v_text),
          pg_catalog.clock_timestamp());

  v_count := public.support_notify_admins(v_case, p_admin_base_url);
  INSERT INTO public.admin_case_events (case_id, event_type, actor_type, actor_id, payload, created_at)
  VALUES (v_case, 'admins_notified', 'system', NULL,
          pg_catalog.jsonb_build_object(
            'title', 'Admins emailed',
            'detail', CASE WHEN v_count = 1 THEN '1 admin was emailed'
                           ELSE v_count::text || ' admins were emailed' END,
            'count', v_count),
          pg_catalog.clock_timestamp());

  RETURN QUERY SELECT v_case, true;
END;
$fn$;

-- A worker message on the conversation's case: text, or one stored
-- attachment (its key must sit under this case's own prefix). A closed case
-- is left untouched and reported as not appended, so the bot can end the
-- mode instead. Moves a case waiting on the worker back to the team.
CREATE FUNCTION public.support_append_message(
  p_case_id UUID,
  p_conversation_id UUID,
  p_kind TEXT,
  p_text TEXT,
  p_media JSONB,
  p_language TEXT
)
RETURNS TABLE (appended BOOLEAN, status_changed BOOLEAN, media_id UUID)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $fn$
#variable_conflict use_column
DECLARE
  v_status TEXT;
  v_user UUID;
  v_conv_user UUID;
  v_text TEXT;
  v_last TEXT;
  v_media_id UUID;
  v_event_id UUID;
  v_key TEXT;
  v_type TEXT;
  v_content TEXT;
  v_size_text TEXT;
  v_size INTEGER;
  v_ext TEXT;
  v_expected_type TEXT;
  v_now_iso TEXT;
BEGIN
  IF p_kind IS NULL OR p_kind NOT IN ('text', 'media') THEN
    RAISE EXCEPTION 'support_message_kind_invalid' USING ERRCODE = '22023';
  END IF;
  IF p_language IS NULL OR p_language NOT IN ('es', 'en') THEN
    RAISE EXCEPTION 'support_language_invalid' USING ERRCODE = '22023';
  END IF;

  SELECT c.status, c.user_id INTO v_status, v_user
    FROM public.admin_cases c
   WHERE c.id = p_case_id
     AND c.conversation_id = p_conversation_id
     AND c.case_type = 'help_request'
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'support_case_not_found' USING ERRCODE = 'P0002';
  END IF;
  IF v_status NOT IN ('open', 'pending_worker', 'pending_admin') THEN
    RETURN QUERY SELECT false, false, NULL::UUID;
    RETURN;
  END IF;

  SELECT wc.user_id INTO v_conv_user FROM public.whatsapp_conversations wc WHERE wc.id = p_conversation_id;
  v_user := COALESCE(v_user, v_conv_user);
  v_text := NULLIF(pg_catalog.left(pg_catalog.btrim(COALESCE(p_text, '')), 4096), '');
  v_now_iso := pg_catalog.to_char(pg_catalog.now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"');

  IF p_kind = 'text' THEN
    IF v_text IS NULL THEN
      RAISE EXCEPTION 'support_message_empty' USING ERRCODE = '22023';
    END IF;
    INSERT INTO public.admin_case_events (case_id, event_type, actor_type, actor_id, payload, created_at)
    VALUES (p_case_id, 'worker_message', 'worker', v_user::text,
            pg_catalog.jsonb_build_object('title', 'Worker message', 'detail', v_text),
            pg_catalog.clock_timestamp());
    v_last := v_text;
  ELSE
    IF p_media IS NULL OR pg_catalog.jsonb_typeof(p_media) <> 'object' THEN
      RAISE EXCEPTION 'support_media_invalid' USING ERRCODE = '22023';
    END IF;
    v_key := p_media ->> 's3Key';
    v_type := p_media ->> 'mediaType';
    v_content := p_media ->> 'contentType';
    v_size_text := p_media ->> 'byteSize';
    v_ext := CASE v_content
               WHEN 'image/jpeg' THEN 'jpg'
               WHEN 'image/png' THEN 'png'
               WHEN 'image/webp' THEN 'webp'
               WHEN 'audio/ogg' THEN 'ogg'
               WHEN 'audio/mpeg' THEN 'mp3'
               WHEN 'audio/mp4' THEN 'm4a'
               WHEN 'application/pdf' THEN 'pdf'
             END;
    v_expected_type := CASE WHEN v_content LIKE 'image/%' THEN 'image'
                            WHEN v_content LIKE 'audio/%' THEN 'audio'
                            ELSE 'document' END;
    IF v_ext IS NULL
       OR v_type IS DISTINCT FROM v_expected_type
       OR v_key IS NULL
       OR v_key !~ ('^support/' || p_case_id::text
                    || '/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.' || v_ext || '$')
       OR v_size_text IS NULL
       OR v_size_text !~ '^[0-9]{1,8}$' THEN
      RAISE EXCEPTION 'support_media_invalid' USING ERRCODE = '22023';
    END IF;
    v_size := v_size_text::INTEGER;
    IF v_size < 1 OR v_size > 10485760 THEN
      RAISE EXCEPTION 'support_media_invalid' USING ERRCODE = '22023';
    END IF;

    v_media_id := pg_catalog.gen_random_uuid();
    INSERT INTO public.admin_case_events (case_id, event_type, actor_type, actor_id, payload, created_at)
    VALUES (p_case_id, 'worker_media', 'worker', v_user::text,
            pg_catalog.jsonb_build_object(
              'title', CASE v_type WHEN 'image' THEN 'Worker sent a photo'
                                   WHEN 'audio' THEN 'Worker sent a voice note'
                                   ELSE 'Worker sent a document' END,
              'detail', v_text,
              'mediaId', v_media_id,
              'mediaType', v_type,
              'caption', v_text),
            pg_catalog.clock_timestamp())
    RETURNING id INTO v_event_id;

    PERFORM pg_catalog.set_config('app.support_case_media', 'on', true);
    INSERT INTO public.support_case_media
      (id, case_id, event_id, s3_key, media_type, content_type, byte_size, created_at, expires_at)
    VALUES (v_media_id, p_case_id, v_event_id, v_key, v_type, v_content, v_size,
            pg_catalog.now(), pg_catalog.now() + interval '90 days');
    PERFORM pg_catalog.set_config('app.support_case_media', '', true);

    v_last := COALESCE(v_text, CASE v_type WHEN 'image' THEN '[photo]'
                                           WHEN 'audio' THEN '[voice note]'
                                           ELSE '[document]' END);
  END IF;

  UPDATE public.admin_cases c
     SET status = CASE WHEN c.status = 'pending_worker' THEN 'pending_admin' ELSE c.status END,
         user_id = v_user,
         details = c.details || pg_catalog.jsonb_build_object(
           'language', p_language,
           'lastMessage', pg_catalog.left(v_last, 2000),
           'lastWorkerMessageAt', v_now_iso,
           'registered', v_user IS NOT NULL),
         updated_at = pg_catalog.now()
   WHERE c.id = p_case_id;

  RETURN QUERY SELECT true, v_status = 'pending_worker', v_media_id;
END;
$fn$;

-- Whether the case is still the conversation's open support case, and when
-- an admin reply to it was last sent. Read-only; one row, always.
CREATE FUNCTION public.support_mode_state(p_case_id UUID, p_conversation_id UUID)
RETURNS TABLE (open BOOLEAN, last_admin_message_at TIMESTAMPTZ)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $fn$
  SELECT COALESCE(c.status IN ('open', 'pending_worker', 'pending_admin'), false),
         (SELECT max(e.created_at)
            FROM public.admin_case_events e
           WHERE e.case_id = c.id
             AND e.event_type = 'admin_reply_sent')
    FROM (SELECT 1) AS one
    LEFT JOIN public.admin_cases c
      ON c.id = p_case_id
     AND c.conversation_id = p_conversation_id
     AND c.case_type = 'help_request'
$fn$;

-- The conversation's latest support case when a free-text answer re-enters
-- it: still open, an admin reply sent in the last 72 hours, and no MENU from
-- the worker since that reply. NULL otherwise. Read-only.
CREATE FUNCTION public.support_reentry_case(p_conversation_id UUID)
RETURNS UUID
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $fn$
  SELECT l.id
    FROM (SELECT c.id, c.status
            FROM public.admin_cases c
           WHERE c.conversation_id = p_conversation_id
             AND c.case_type = 'help_request'
           ORDER BY c.created_at DESC, c.id DESC
           LIMIT 1) AS l
   CROSS JOIN LATERAL (
     SELECT max(e.created_at) AS sent_at
       FROM public.admin_case_events e
      WHERE e.case_id = l.id
        AND e.event_type = 'admin_reply_sent') AS s
   WHERE l.status IN ('open', 'pending_worker', 'pending_admin')
     AND s.sent_at > pg_catalog.now() - interval '72 hours'
     AND NOT EXISTS (
       SELECT 1
         FROM public.admin_case_events x
        WHERE x.case_id = l.id
          AND x.event_type = 'support_mode_exited'
          AND x.payload ->> 'reason' = 'menu'
          AND x.created_at > s.sent_at)
$fn$;

-- Mode entered (command, reentry) or exited (menu, resolved, idle) on the
-- case timeline. A case that is gone or belongs to another conversation is
-- skipped without an error.
CREATE FUNCTION public.support_record_mode_change(
  p_case_id UUID,
  p_conversation_id UUID,
  p_entered BOOLEAN,
  p_reason TEXT
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $fn$
DECLARE
  v_user UUID;
  v_by_worker BOOLEAN;
BEGIN
  IF p_entered IS NULL
     OR (p_entered AND (p_reason IS NULL OR p_reason NOT IN ('command', 'reentry')))
     OR (NOT p_entered AND (p_reason IS NULL OR p_reason NOT IN ('menu', 'resolved', 'idle'))) THEN
    RAISE EXCEPTION 'support_mode_change_invalid' USING ERRCODE = '22023';
  END IF;

  SELECT c.user_id INTO v_user
    FROM public.admin_cases c
   WHERE c.id = p_case_id
     AND c.conversation_id = p_conversation_id
     AND c.case_type = 'help_request';
  IF NOT FOUND THEN
    RETURN;
  END IF;

  v_by_worker := p_reason IN ('command', 'reentry', 'menu');
  INSERT INTO public.admin_case_events (case_id, event_type, actor_type, actor_id, payload, created_at)
  VALUES (
    p_case_id,
    CASE WHEN p_entered THEN 'support_mode_entered' ELSE 'support_mode_exited' END,
    CASE WHEN v_by_worker THEN 'worker' ELSE 'system' END,
    CASE WHEN v_by_worker THEN v_user::text END,
    pg_catalog.jsonb_build_object(
      'title', CASE WHEN p_entered THEN 'Support mode started' ELSE 'Support mode ended' END,
      'detail', CASE p_reason
                  WHEN 'command' THEN 'The worker asked for support and is chatting with the team'
                  WHEN 'reentry' THEN 'The worker replied to the team'
                  WHEN 'menu' THEN 'The worker typed MENU'
                  WHEN 'resolved' THEN 'The case was closed'
                  ELSE 'No messages for 24 hours'
                END,
      'reason', p_reason),
    pg_catalog.clock_timestamp());
END;
$fn$;

-- The admin dispatcher's outcome for one reply: sent (with how: freeform or
-- template), failed, send_unknown, or waiting_for_window (recorded once per
-- reply, however often the reply waits).
CREATE FUNCTION public.support_record_admin_delivery(
  p_outbox_id UUID,
  p_outcome TEXT,
  p_via TEXT,
  p_twilio_message_sid TEXT,
  p_error TEXT
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $fn$
DECLARE
  v_case UUID;
BEGIN
  IF p_outcome IS NULL OR p_outcome NOT IN ('sent', 'failed', 'send_unknown', 'waiting_for_window') THEN
    RAISE EXCEPTION 'support_delivery_outcome_invalid' USING ERRCODE = '22023';
  END IF;
  IF p_via IS NOT NULL AND p_via NOT IN ('freeform', 'template') THEN
    RAISE EXCEPTION 'support_delivery_via_invalid' USING ERRCODE = '22023';
  END IF;
  IF p_outcome = 'sent' AND (p_via IS NULL OR p_twilio_message_sid IS NULL) THEN
    RAISE EXCEPTION 'support_delivery_sent_incomplete' USING ERRCODE = '22023';
  END IF;

  SELECT o.source_id INTO v_case
    FROM public.whatsapp_outbox o
   WHERE o.id = p_outbox_id
     AND o.source_type = 'admin_case';
  IF v_case IS NULL THEN
    RAISE EXCEPTION 'support_admin_outbox_not_found' USING ERRCODE = 'P0002';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.admin_cases c WHERE c.id = v_case) THEN
    RETURN;
  END IF;
  IF p_outcome = 'waiting_for_window' AND EXISTS (
    SELECT 1
      FROM public.admin_case_events e
     WHERE e.case_id = v_case
       AND e.event_type = 'admin_reply_waiting_for_window'
       AND e.payload ->> 'outboxId' = p_outbox_id::text
  ) THEN
    RETURN;
  END IF;

  INSERT INTO public.admin_case_events (case_id, event_type, actor_type, actor_id, payload)
  VALUES (
    v_case,
    CASE p_outcome
      WHEN 'sent' THEN 'admin_reply_sent'
      WHEN 'send_unknown' THEN 'admin_reply_send_unknown'
      WHEN 'waiting_for_window' THEN 'admin_reply_waiting_for_window'
      ELSE 'admin_reply_failed'
    END,
    'system',
    CASE WHEN p_outcome = 'waiting_for_window' THEN NULL ELSE 'twilio' END,
    pg_catalog.jsonb_build_object(
      'title', CASE p_outcome
                 WHEN 'sent' THEN 'WhatsApp reply accepted by Twilio'
                 WHEN 'send_unknown' THEN 'WhatsApp delivery state unknown'
                 WHEN 'waiting_for_window' THEN 'Reply waiting for the worker'
                 ELSE 'WhatsApp reply failed'
               END,
      'detail', CASE WHEN p_outcome = 'waiting_for_window'
                     THEN 'The worker has not written in the last 24 hours and the reply template is not available yet'
                     ELSE pg_catalog.left(p_error, 500) END,
      'outboxId', p_outbox_id,
      'via', p_via,
      'twilioMessageSid', p_twilio_message_sid));

  IF p_outcome = 'sent' THEN
    UPDATE public.admin_cases c
       SET details = c.details || pg_catalog.jsonb_build_object('lastOutboundTwilioSid', p_twilio_message_sid),
           updated_at = pg_catalog.now()
     WHERE c.id = v_case;
  END IF;
END;
$fn$;

REVOKE ALL ON FUNCTION public.support_notify_admins(UUID, TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.support_open_case(UUID, UUID, TEXT, TEXT, TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.support_append_message(UUID, UUID, TEXT, TEXT, JSONB, TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.support_mode_state(UUID, UUID) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.support_reentry_case(UUID) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.support_record_mode_change(UUID, UUID, BOOLEAN, TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.support_record_admin_delivery(UUID, TEXT, TEXT, TEXT, TEXT) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION public.support_open_case(UUID, UUID, TEXT, TEXT, TEXT) TO jale_whatsapp;
GRANT EXECUTE ON FUNCTION public.support_append_message(UUID, UUID, TEXT, TEXT, JSONB, TEXT) TO jale_whatsapp;
GRANT EXECUTE ON FUNCTION public.support_mode_state(UUID, UUID) TO jale_whatsapp;
GRANT EXECUTE ON FUNCTION public.support_reentry_case(UUID) TO jale_whatsapp;
GRANT EXECUTE ON FUNCTION public.support_record_mode_change(UUID, UUID, BOOLEAN, TEXT) TO jale_whatsapp;
GRANT EXECUTE ON FUNCTION public.support_record_admin_delivery(UUID, TEXT, TEXT, TEXT, TEXT) TO jale_whatsapp;

-- Self-check before COMMIT: owner, security, pinned search path and EXECUTE
-- exactly as above; the media table forced and closed to every login.
DO $$
DECLARE
  fn RECORD;
BEGIN
  FOR fn IN
    SELECT * FROM (VALUES
      ('public.support_notify_admins(uuid, text)', false),
      ('public.support_open_case(uuid, uuid, text, text, text)', true),
      ('public.support_append_message(uuid, uuid, text, text, jsonb, text)', true),
      ('public.support_mode_state(uuid, uuid)', true),
      ('public.support_reentry_case(uuid)', true),
      ('public.support_record_mode_change(uuid, uuid, boolean, text)', true),
      ('public.support_record_admin_delivery(uuid, text, text, text, text)', true)
    ) AS expected(sig, whatsapp)
  LOOP
    IF NOT EXISTS (
      SELECT 1 FROM pg_catalog.pg_proc p
       WHERE p.oid = fn.sig::regprocedure
         AND p.prosecdef
         AND p.proowner = 'jale_admin'::regrole
         AND COALESCE(p.proconfig @> ARRAY['search_path=pg_catalog, pg_temp'], false)
         AND NOT pg_catalog.has_function_privilege('public', p.oid, 'EXECUTE')
         AND pg_catalog.has_function_privilege('jale_whatsapp', p.oid, 'EXECUTE') = fn.whatsapp
         AND NOT pg_catalog.has_function_privilege('jale_admin_console', p.oid, 'EXECUTE')
    ) THEN
      RAISE EXCEPTION 'migration 121: % has the wrong owner, security, search_path or grants', fn.sig;
    END IF;
  END LOOP;

  IF NOT EXISTS (
       SELECT 1 FROM pg_catalog.pg_class c
        WHERE c.oid = 'public.support_case_media'::regclass
          AND c.relrowsecurity AND c.relforcerowsecurity)
     OR pg_catalog.has_table_privilege('jale_whatsapp', 'public.support_case_media', 'SELECT')
     OR pg_catalog.has_table_privilege('jale_admin_console', 'public.support_case_media', 'SELECT') THEN
    RAISE EXCEPTION 'migration 121: support_case_media is not forced, or a login can read it';
  END IF;
END $$;

COMMIT;
