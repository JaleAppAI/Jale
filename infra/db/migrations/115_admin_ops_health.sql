-- ============================================================
-- 115_admin_ops_health.sql
-- Run manually AFTER 102_admin_identity_lockouts.sql, connected as
-- jale_admin (NOT the RDS master user). Forward-only (ADR-005).
-- Numbered 115 to leave 104-112 for migrations written in parallel; it
-- depends on nothing after 102 (and not on 113 or 114), so it may be applied
-- before or after them.
--
-- Roadmap sub-project 2c
-- (docs/superpowers/specs/2026-10-08-admin-analytics-2c-ops-health-design.md).
--
-- Whether the plumbing is healthy. All math happens here, so no message,
-- extraction or billing event reaches the console -- only counts, shares,
-- week starts, lane ids, model ids, extractor versions, event types and the
-- timestamps listed below:
-- (1) admin_analytics_message_backlog(): per lane, the open messages by age
--     (under 1 h, 1-24 h, 24-48 h), how many are stuck (open longer than
--     the lane's retry window) and the oldest stuck one.
-- (2) admin_analytics_message_failures(p_weeks): per week (Monday 00:00
--     UTC, by created_at) and lane, messages created, given up and failed
--     on delivery, plus whole-window rows (week_start NULL) per lane and for
--     all lanes (lane NULL).
-- (3) admin_analytics_voice_extraction(p_weeks): per week and model, voice
--     extractions processed, failed by cause, usable, and each profile field
--     found at the onboarding confidence gate.
-- (4) admin_analytics_trust_extraction(p_weeks): per week and extractor
--     version, trust extractions, failed, "not enough detail" and the
--     average number of non-empty sections.
-- (5) admin_analytics_billing_inbox(p_weeks): per week (by received_at) and
--     event type, Stripe events received, processed, skipped, failed,
--     retried and payment-failed invoices.
-- (6) admin_analytics_billing_inbox_now(): events received in the last hour
--     that are stuck in received (no live claim) or failed, the oldest of
--     them, and the events still stuck or failed that were received an hour
--     to 14 days ago. The processor dead-letters an event after about 20
--     minutes and the dead-letter queue keeps it 14 days: those can be
--     redriven from the queue; older events have left the queue and must be
--     resent from Stripe.
--
-- LANES (display order) and retry windows ("stuck" = open and created
-- longer ago than the window):
--   reply                whatsapp_outbox, source_type NULL       30 minutes
--   admin                whatsapp_outbox, admin_case             10 minutes
--   worker_notification  whatsapp_outbox, worker_intent          24 hours
--   employer_invite      job_message_outbox, send_kind template  30 minutes
--   employer_freeform    job_message_outbox, send_kind freeform  30 minutes
--   job_alert            whatsapp_outbox, job_alert (dormant; only where
--                        it has rows)                            30 minutes
-- UNSENT = every row that is not sent, except a job_message_outbox failed
-- row with sent_at set: that one was sent and then reported failed by
-- Twilio (097), a DELIVERY FAILURE. Every unsent row is either open or gave
-- up, never both:
-- OPEN = still being retried and created less than 48 hours ago. Still
-- being retried: pending; failed with attempt_count < 5, except a worker
-- notification; a worker_intent send_unknown row whose lease is live.
-- GAVE UP = unsent and not open: failed at 5 attempts; any failed worker
-- notification (093 fails a row that waited 48 hours for template approval
-- after 1-4 attempts, and nothing re-leases a failed row); send_unknown
-- without a live worker_intent lease; and anything still unsent 48 hours
-- after it was created -- nothing in Jale retries a message that late
-- (inbound replies stranded after SQS gave up, the later replies of a
-- failed sequence left pending, a stopped dispatcher or sweeper).
-- DELIVERY FAILURE: also whatsapp_outbox sent with twilio_delivery_status
-- failed / undelivered. A source_type that maps to no lane is left out
-- before grouping (042's origin CHECK admits none today).
--
-- VOICE (worker_profile_ai_extractions, ai_test_profile rows left out):
-- failed = status failed (by the new failure_kind; NULL = not recorded) or a
-- completed row whose extracted_fields or confidence_scores is not a JSON
-- object (cause bad_shape); usable = completed with both objects; a field is
-- found in a usable row when its value is present (a string must not be
-- blank) and its confidence is a JSON number >= 0.75 (onboarding's
-- VOICE_CONFIDENCE_THRESHOLD, inclusive); main_trade_other only counts when
-- main_trade = 'other'. A row is attributed to its model when it is usable
-- or failed with model_call, bad_json or bad_shape; per-model rows count
-- only those, the all-models rows (model NULL) count every row.
-- TRUST (worker_trust_extractions): completed and failed rows only; not
-- enough detail = completed without a model call (model_id NULL); average
-- sections over completed rows with a model call.
-- BILLING (billing_webhook_events): stuck = received with no live lease
-- (expired, or NULL: the processor's own re-claim predicate). The webhook
-- answers 200 once it has queued an event (Stripe never retries), and the
-- processor's SQS queue dead-letters it after about 20 minutes (3 receives,
-- 6 minutes apart, no backoff), so a failed or crashed event is retried for
-- minutes, not days; retried = attempt_count > 1. Right now, stuck and
-- failed count only events received in the last hour; those received an hour
-- to 14 days ago are "unresolved" (dead-lettered in the last 14 days, which
-- is how long the dead-letter queue keeps a message: they can be redriven
-- from the queue). Older events have left the queue and must be resent from
-- Stripe, so they are not counted.
--
-- COLUMN: worker_profile_ai_extractions.failure_kind records why an
-- extraction failed (written by the AI profile writer from this release on).
-- Nullable, no default: adding it is a catalog-only change; the CHECK scans
-- the table once under the lock (every existing row has NULL).
--
-- ACCESS (roadmap rules, 089's pattern): every function is a definer owned by
-- jale_admin with a pinned search path, executable by the admin console role
-- only, and opens app.admin_analytics_read after validating its input.
-- whatsapp_outbox is ENABLE (not FORCE) row level security, so its owner
-- jale_admin already reads it (098 relies on this; the precondition below
-- pins it). job_message_outbox, worker_profile_ai_extractions,
-- worker_trust_extractions and billing_webhook_events are FORCE RLS with no
-- policy a definer satisfies, so a definer read them as zero rows (the 088
-- defect): this migration adds 089's gated read policy to each. No table
-- grant, no index. As with 089, any jale_admin session that sets the flag
-- itself could read these tables' rows; only these definers set it, and none
-- returns a message, a transcript or a Stripe id.
--
-- PLANS: every function is one grouped scan per table it reads and joins no
-- two tables, so no RLS row misestimate can turn into a nested loop (114).
-- whatsapp_outbox has only partial created_at indexes (004, 027, 040: the
-- pending / failed rows of one origin) and is unbounded: the send_unknown
-- branch of "open" and the all-status weekly window need a full scan, so the
-- message functions scan it once, as 098 does. PostgreSQL ORs the new gate
-- after a table's older policies, so 025's employer policy still looks up
-- each job_message_outbox row's conversation, and 086's applicant policy
-- probes job_applications once per trust extraction (index lookups; linear).
-- No new index (the message tables are large and an index build takes
-- locks).
--
-- DEPLOY ORDER: apply BEFORE deploying the WhatsApp stack whose AI profile
-- writer inserts failure_kind, and before the admin console build that calls
-- these functions (/analytics/ops).
-- ============================================================
BEGIN;

-- Fail fast instead of queueing reads and writes of five tables behind a
-- stuck transaction (the column and the policies take AccessExclusiveLocks
-- until COMMIT); a timed-out apply writes no ledger row and can be rerun.
SET LOCAL lock_timeout = '5s';

-- Preconditions: pg_class and pg_policy are catalogs, so RLS never filters
-- this check.
DO $$
BEGIN
  -- whatsapp_outbox has no gated policy: its owner reads it only because
  -- RLS is not forced on it. FORCE (or a new owner) would make 098 and this
  -- page silently read zero messages.
  IF NOT EXISTS (
    SELECT 1 FROM pg_class c
     WHERE c.oid = 'public.whatsapp_outbox'::regclass
       AND NOT c.relforcerowsecurity
       AND c.relowner = 'jale_admin'::regrole::oid
  ) THEN
    RAISE EXCEPTION 'migration 115: whatsapp_outbox is FORCE ROW LEVEL SECURITY or not owned by jale_admin; 098 and the ops page would read zero messages';
  END IF;

  -- A RESTRICTIVE SELECT (or ALL) policy is AND'ed with every gate, so one
  -- that applies to jale_admin on any table read here could zero the page
  -- just as silently: one for jale_admin, for PUBLIC (role 0), or for any
  -- role whose privileges jale_admin has (RLS applies those too:
  -- has_privs_of_role, i.e. pg_has_role USAGE; jale_admin is a non-inheriting
  -- MEMBER of every role it created, which RLS does not apply). A
  -- RESTRICTIVE INSERT, UPDATE or DELETE policy never filters a read, so
  -- only polcmd 'r' (SELECT) and '*' (ALL) count.
  IF EXISTS (
    SELECT 1 FROM pg_policy p
     WHERE p.polrelid IN ('public.whatsapp_outbox'::regclass, 'public.job_message_outbox'::regclass,
                          'public.worker_profile_ai_extractions'::regclass,
                          'public.worker_trust_extractions'::regclass,
                          'public.billing_webhook_events'::regclass)
       AND NOT p.polpermissive
       AND p.polcmd IN ('r', '*')
       AND ('jale_admin'::regrole::oid = ANY (p.polroles) OR 0::OID = ANY (p.polroles)
            OR EXISTS (SELECT 1 FROM unnest(p.polroles) AS r(role_oid)
                        WHERE r.role_oid <> 0 AND pg_has_role('jale_admin', r.role_oid, 'USAGE')))
  ) THEN
    RAISE EXCEPTION 'migration 115: a restrictive policy for jale_admin, a role it inherits, or PUBLIC on a table the ops page reads; it would hide rows';
  END IF;
END $$;

-- ── Why an AI voice extraction failed ───────────────────────
ALTER TABLE public.worker_profile_ai_extractions
  ADD COLUMN failure_kind TEXT,
  ADD CONSTRAINT worker_profile_ai_extractions_failure_kind_check CHECK (
    failure_kind IS NULL OR (
      status = 'failed' AND failure_kind IN ('transcribe', 'empty_transcript',
        'audio_read', 'model_call', 'bad_json', 'bad_shape', 'pipeline_error')));

-- ── 089's gated read on the four FORCE-RLS tables ───────────
-- Each policy is SELECT-only, for jale_admin, and true only while a definer
-- below has opened the transaction-local flag. The predicate reads no table,
-- so it adds no policy recursion.
CREATE POLICY job_message_outbox_admin_analytics_read
  ON public.job_message_outbox FOR SELECT
  TO jale_admin
  USING (current_setting('app.admin_analytics_read', true) = 'on');

CREATE POLICY worker_profile_ai_extractions_admin_analytics_read
  ON public.worker_profile_ai_extractions FOR SELECT
  TO jale_admin
  USING (current_setting('app.admin_analytics_read', true) = 'on');

CREATE POLICY worker_trust_extractions_admin_analytics_read
  ON public.worker_trust_extractions FOR SELECT
  TO jale_admin
  USING (current_setting('app.admin_analytics_read', true) = 'on');

CREATE POLICY billing_webhook_events_admin_analytics_read
  ON public.billing_webhook_events FOR SELECT
  TO jale_admin
  USING (current_setting('app.admin_analytics_read', true) = 'on');

-- ── Message backlog right now ───────────────────────────────
CREATE FUNCTION public.admin_analytics_message_backlog()
RETURNS TABLE (
  lane            TEXT,
  open_under_1h   BIGINT,
  open_1_24h      BIGINT,
  open_24_48h     BIGINT,
  stuck           BIGINT,
  oldest_stuck_at TIMESTAMPTZ
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
#variable_conflict use_column
BEGIN
  -- No arguments to validate.
  PERFORM set_config('app.admin_analytics_read', 'on', true);

  RETURN QUERY
  WITH lanes (id, ord, retry, always_shown) AS (
    VALUES ('reply',               1, interval '30 minutes', true),
           ('admin',               2, interval '10 minutes', true),
           ('worker_notification', 3, interval '24 hours',   true),
           ('employer_invite',     4, interval '30 minutes', true),
           ('employer_freeform',   5, interval '30 minutes', true),
           ('job_alert',           6, interval '30 minutes', false)
  ), open_msgs AS (
    SELECT CASE WHEN o.source_type IS NULL THEN 'reply'
                WHEN o.source_type = 'admin_case' THEN 'admin'
                WHEN o.source_type = 'worker_intent' THEN 'worker_notification'
                WHEN o.source_type = 'job_alert' THEN 'job_alert'
           END AS lane_id,
           o.created_at
      FROM public.whatsapp_outbox o
     -- Open: still being retried, and created less than 48 hours ago.
     WHERE o.created_at > now() - interval '48 hours'
       AND (o.status = 'pending'
            OR (o.status = 'failed' AND o.attempt_count < 5
                AND o.source_type IS DISTINCT FROM 'worker_intent')
            OR (o.status = 'send_unknown' AND o.source_type IS NOT DISTINCT FROM 'worker_intent'
                AND COALESCE(o.worker_intent_leased_until > now(), false)))
    UNION ALL
    SELECT CASE m.send_kind WHEN 'template' THEN 'employer_invite' WHEN 'freeform' THEN 'employer_freeform' END,
           m.created_at
      FROM public.job_message_outbox m
     WHERE m.created_at > now() - interval '48 hours'
       AND (m.status = 'pending'
            OR (m.status = 'failed' AND m.attempt_count < 5 AND m.sent_at IS NULL))
  ), agg AS (
    SELECT x.lane_id,
           count(*) FILTER (WHERE x.created_at > now() - interval '1 hour') AS n_under_1h,
           count(*) FILTER (WHERE x.created_at <= now() - interval '1 hour'
                              AND x.created_at > now() - interval '24 hours') AS n_1_24h,
           count(*) FILTER (WHERE x.created_at <= now() - interval '24 hours') AS n_24_48h,
           count(*) FILTER (WHERE x.created_at < now() - l.retry) AS n_stuck,
           min(x.created_at) FILTER (WHERE x.created_at < now() - l.retry) AS oldest_stuck
      FROM open_msgs x
      JOIN lanes l ON l.id = x.lane_id
     -- A source_type that maps to no lane is left out.
     WHERE x.lane_id IS NOT NULL
     GROUP BY x.lane_id
  )
  SELECT l.id,
         COALESCE(a.n_under_1h, 0),
         COALESCE(a.n_1_24h, 0),
         COALESCE(a.n_24_48h, 0),
         COALESCE(a.n_stuck, 0),
         a.oldest_stuck
    FROM lanes l
    LEFT JOIN agg a ON a.lane_id = l.id
   -- The dormant job-alert lane only when it has open messages.
   WHERE l.always_shown OR a.lane_id IS NOT NULL
   ORDER BY l.ord;
END $$;

-- ── Message failures by week ────────────────────────────────
CREATE FUNCTION public.admin_analytics_message_failures(p_weeks INTEGER)
RETURNS TABLE (
  week_start      TIMESTAMPTZ,
  lane            TEXT,
  created         BIGINT,
  gave_up         BIGINT,
  delivery_failed BIGINT
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
#variable_conflict use_column
DECLARE
  v_from TIMESTAMPTZ;
BEGIN
  IF p_weeks IS NULL OR p_weeks < 1 OR p_weeks > 26 THEN
    RAISE EXCEPTION 'admin_analytics_invalid_weeks';
  END IF;

  -- Set AFTER argument validation so a rejected call never flips the flag.
  PERFORM set_config('app.admin_analytics_read', 'on', true);

  -- Week arithmetic on UTC wall-clock time, so the session TimeZone (and its
  -- daylight-saving shifts) can never move the window edge.
  v_from := (date_trunc('week', now() AT TIME ZONE 'UTC') - make_interval(weeks => p_weeks - 1)) AT TIME ZONE 'UTC';

  RETURN QUERY
  WITH lanes (id, ord, always_shown) AS (
    VALUES ('reply', 1, true), ('admin', 2, true), ('worker_notification', 3, true),
           ('employer_invite', 4, true), ('employer_freeform', 5, true), ('job_alert', 6, false)
  ), weeks AS (
    SELECT (date_trunc('week', now() AT TIME ZONE 'UTC') - make_interval(weeks => g.n)) AT TIME ZONE 'UTC' AS wk
      FROM generate_series(0, p_weeks - 1) AS g(n)
  ), msgs AS (
    SELECT date_trunc('week', o.created_at, 'UTC') AS wk,
           CASE WHEN o.source_type IS NULL THEN 'reply'
                WHEN o.source_type = 'admin_case' THEN 'admin'
                WHEN o.source_type = 'worker_intent' THEN 'worker_notification'
                WHEN o.source_type = 'job_alert' THEN 'job_alert'
           END AS lane_id,
           o.created_at,
           -- Unsent; still being retried (open while younger than 48 hours);
           -- delivery failed after it was sent.
           o.status IN ('pending', 'failed', 'send_unknown') AS is_unsent,
           o.status = 'pending'
             OR (o.status = 'failed' AND o.attempt_count < 5
                 AND o.source_type IS DISTINCT FROM 'worker_intent')
             OR (o.status = 'send_unknown' AND o.source_type IS NOT DISTINCT FROM 'worker_intent'
                 AND COALESCE(o.worker_intent_leased_until > now(), false)) AS is_retrying,
           o.status = 'sent' AND COALESCE(o.twilio_delivery_status IN ('failed', 'undelivered'), false) AS is_delivery_failed
      FROM public.whatsapp_outbox o
     WHERE o.created_at >= v_from
    UNION ALL
    SELECT date_trunc('week', m.created_at, 'UTC'),
           CASE m.send_kind WHEN 'template' THEN 'employer_invite' WHEN 'freeform' THEN 'employer_freeform' END,
           m.created_at,
           m.status IN ('pending', 'send_unknown') OR (m.status = 'failed' AND m.sent_at IS NULL),
           m.status = 'pending' OR (m.status = 'failed' AND m.attempt_count < 5 AND m.sent_at IS NULL),
           m.status = 'failed' AND m.sent_at IS NOT NULL
      FROM public.job_message_outbox m
     WHERE m.created_at >= v_from
  ), agg AS (
    -- (week, lane), (lane) = the whole window per lane, () = all lanes.
    SELECT x.wk,
           x.lane_id,
           count(*) AS n_created,
           -- Gave up = unsent and not open: terminal, or unsent 48 hours on.
           count(*) FILTER (WHERE x.is_unsent
                              AND NOT (x.is_retrying AND x.created_at > now() - interval '48 hours')) AS n_gave_up,
           count(*) FILTER (WHERE x.is_delivery_failed) AS n_delivery_failed
      FROM msgs x
     -- A source_type that maps to no lane is left out before grouping, so
     -- it can never add a second all-lanes (NULL, NULL) row.
     WHERE x.lane_id IS NOT NULL
     GROUP BY GROUPING SETS ((x.wk, x.lane_id), (x.lane_id), ())
  ), keys AS (
    -- Every week x active lane, every active lane over the window, all
    -- lanes over the window; the dormant job-alert lane only where it has rows.
    SELECT w.wk, l.id AS lane_id FROM weeks w CROSS JOIN lanes l WHERE l.always_shown
    UNION ALL
    SELECT NULL::TIMESTAMPTZ, l.id FROM lanes l WHERE l.always_shown
    UNION ALL
    SELECT NULL::TIMESTAMPTZ, NULL::TEXT
    UNION ALL
    SELECT a.wk, a.lane_id FROM agg a WHERE a.lane_id = 'job_alert'
  )
  SELECT k.wk,
         k.lane_id,
         COALESCE(a.n_created, 0),
         COALESCE(a.n_gave_up, 0),
         COALESCE(a.n_delivery_failed, 0)
    FROM keys k
    LEFT JOIN agg a ON a.wk IS NOT DISTINCT FROM k.wk AND a.lane_id IS NOT DISTINCT FROM k.lane_id
    LEFT JOIN lanes l ON l.id = k.lane_id
   ORDER BY k.wk NULLS LAST, l.ord NULLS LAST;
END $$;

-- ── AI voice extraction by week and model ───────────────────
CREATE FUNCTION public.admin_analytics_voice_extraction(p_weeks INTEGER)
RETURNS TABLE (
  week_start               TIMESTAMPTZ,
  model                    TEXT,
  processed                BIGINT,
  failed                   BIGINT,
  failed_transcribe        BIGINT,
  failed_empty_transcript  BIGINT,
  failed_audio_read        BIGINT,
  failed_model_call        BIGINT,
  failed_bad_json          BIGINT,
  failed_bad_shape         BIGINT,
  failed_pipeline_error    BIGINT,
  failed_unrecorded        BIGINT,
  usable                   BIGINT,
  full_name_found          BIGINT,
  city_found               BIGINT,
  main_trade_found         BIGINT,
  main_trade_other_due     BIGINT,
  main_trade_other_found   BIGINT,
  years_experience_found   BIGINT,
  has_transportation_found BIGINT,
  availability_found       BIGINT
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
#variable_conflict use_column
DECLARE
  v_from TIMESTAMPTZ;
BEGIN
  IF p_weeks IS NULL OR p_weeks < 1 OR p_weeks > 26 THEN
    RAISE EXCEPTION 'admin_analytics_invalid_weeks';
  END IF;

  -- Set AFTER argument validation so a rejected call never flips the flag.
  PERFORM set_config('app.admin_analytics_read', 'on', true);

  v_from := (date_trunc('week', now() AT TIME ZONE 'UTC') - make_interval(weeks => p_weeks - 1)) AT TIME ZONE 'UTC';

  RETURN QUERY
  WITH weeks AS (
    -- Every week of the window, plus NULL for the whole-window row.
    SELECT (date_trunc('week', now() AT TIME ZONE 'UTC') - make_interval(weeks => g.n)) AT TIME ZONE 'UTC' AS wk
      FROM generate_series(0, p_weeks - 1) AS g(n)
    UNION ALL
    SELECT NULL::TIMESTAMPTZ
  ), shaped AS (
    SELECT date_trunc('week', x.created_at, 'UTC') AS wk,
           x.bedrock_model_id,
           x.status,
           x.failure_kind,
           x.extracted_fields AS f,
           x.confidence_scores AS c,
           COALESCE(jsonb_typeof(x.extracted_fields) = 'object'
                    AND jsonb_typeof(x.confidence_scores) = 'object', false) AS is_object
      FROM public.worker_profile_ai_extractions x
     WHERE x.created_at >= v_from
       AND NOT x.ai_test_profile
  ), facts AS (
    SELECT s.wk,
           s.bedrock_model_id,
           s.status = 'completed' AND s.is_object AS is_usable,
           -- A completed row the model filled with the wrong shape failed too.
           CASE WHEN s.status = 'failed' THEN COALESCE(s.failure_kind, 'unrecorded')
                WHEN s.status = 'completed' AND NOT s.is_object THEN 'bad_shape'
           END AS cause,
           s.f ->> 'main_trade' = 'other' AS other_trade,
           -- The fields found: a present value (a string must not be blank)
           -- with a JSON-number confidence >= 0.75, onboarding's gate.
           ARRAY(
             SELECT k.name
               FROM unnest(ARRAY['full_name', 'city', 'main_trade', 'main_trade_other',
                                 'years_experience', 'has_transportation', 'availability']) AS k(name)
              WHERE CASE jsonb_typeof(s.f -> k.name)
                      WHEN 'string' THEN (s.f ->> k.name) ~ '[^[:space:]]'
                      WHEN 'null' THEN false
                      ELSE s.f -> k.name IS NOT NULL
                    END
                AND CASE WHEN jsonb_typeof(s.c -> k.name) = 'number'
                      THEN (s.c -> k.name)::NUMERIC >= 0.75
                      ELSE false
                    END
           ) AS found
      FROM shaped s
  ), attributed AS (
    -- model is set only on rows attributed to a model: usable rows and the
    -- model's own failures. Audio, Transcribe and pipeline failures, and
    -- rows whose cause was not recorded, carry no model.
    SELECT f.*,
           CASE WHEN f.is_usable OR f.cause IN ('model_call', 'bad_json', 'bad_shape')
                THEN f.bedrock_model_id END AS model_id
      FROM facts f
  ), agg AS (
    -- (week), () = every row; (week, model), (model) = attributed rows only.
    -- GROUPING(model_id) = 1 marks the every-row sets, so the unattributed
    -- rows' own (week, NULL) and (NULL) groups can be dropped below.
    SELECT a.wk,
           a.model_id,
           GROUPING(a.model_id) = 1 AS every_row,
           count(*) AS n_processed,
           count(*) FILTER (WHERE a.cause IS NOT NULL) AS n_failed,
           count(*) FILTER (WHERE a.cause = 'transcribe') AS n_transcribe,
           count(*) FILTER (WHERE a.cause = 'empty_transcript') AS n_empty_transcript,
           count(*) FILTER (WHERE a.cause = 'audio_read') AS n_audio_read,
           count(*) FILTER (WHERE a.cause = 'model_call') AS n_model_call,
           count(*) FILTER (WHERE a.cause = 'bad_json') AS n_bad_json,
           count(*) FILTER (WHERE a.cause = 'bad_shape') AS n_bad_shape,
           count(*) FILTER (WHERE a.cause = 'pipeline_error') AS n_pipeline_error,
           count(*) FILTER (WHERE a.cause = 'unrecorded') AS n_unrecorded,
           count(*) FILTER (WHERE a.is_usable) AS n_usable,
           count(*) FILTER (WHERE a.is_usable AND 'full_name' = ANY (a.found)) AS n_full_name,
           count(*) FILTER (WHERE a.is_usable AND 'city' = ANY (a.found)) AS n_city,
           count(*) FILTER (WHERE a.is_usable AND 'main_trade' = ANY (a.found)) AS n_main_trade,
           count(*) FILTER (WHERE a.is_usable AND a.other_trade) AS n_other_due,
           count(*) FILTER (WHERE a.is_usable AND a.other_trade AND 'main_trade_other' = ANY (a.found)) AS n_other,
           count(*) FILTER (WHERE a.is_usable AND 'years_experience' = ANY (a.found)) AS n_years,
           count(*) FILTER (WHERE a.is_usable AND 'has_transportation' = ANY (a.found)) AS n_transport,
           count(*) FILTER (WHERE a.is_usable AND 'availability' = ANY (a.found)) AS n_availability
      FROM attributed a
     GROUP BY GROUPING SETS ((a.wk), (), (a.wk, a.model_id), (a.model_id))
  ), keys AS (
    SELECT w.wk, NULL::TEXT AS model_id, true AS every_row FROM weeks w
    UNION ALL
    SELECT a.wk, a.model_id, false FROM agg a WHERE NOT a.every_row AND a.model_id IS NOT NULL
  )
  SELECT k.wk,
         k.model_id,
         COALESCE(a.n_processed, 0),
         COALESCE(a.n_failed, 0),
         COALESCE(a.n_transcribe, 0),
         COALESCE(a.n_empty_transcript, 0),
         COALESCE(a.n_audio_read, 0),
         COALESCE(a.n_model_call, 0),
         COALESCE(a.n_bad_json, 0),
         COALESCE(a.n_bad_shape, 0),
         COALESCE(a.n_pipeline_error, 0),
         COALESCE(a.n_unrecorded, 0),
         COALESCE(a.n_usable, 0),
         COALESCE(a.n_full_name, 0),
         COALESCE(a.n_city, 0),
         COALESCE(a.n_main_trade, 0),
         COALESCE(a.n_other_due, 0),
         COALESCE(a.n_other, 0),
         COALESCE(a.n_years, 0),
         COALESCE(a.n_transport, 0),
         COALESCE(a.n_availability, 0)
    FROM keys k
    LEFT JOIN agg a ON a.every_row = k.every_row
                   AND a.wk IS NOT DISTINCT FROM k.wk
                   AND a.model_id IS NOT DISTINCT FROM k.model_id
   ORDER BY k.wk NULLS LAST, k.model_id NULLS FIRST;
END $$;

-- ── Trust extraction by week and extractor version ──────────
CREATE FUNCTION public.admin_analytics_trust_extraction(p_weeks INTEGER)
RETURNS TABLE (
  week_start        TIMESTAMPTZ,
  extractor_version TEXT,
  extractions       BIGINT,
  failed            BIGINT,
  not_enough_detail BIGINT,
  avg_sections      NUMERIC
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
#variable_conflict use_column
DECLARE
  v_from TIMESTAMPTZ;
BEGIN
  IF p_weeks IS NULL OR p_weeks < 1 OR p_weeks > 26 THEN
    RAISE EXCEPTION 'admin_analytics_invalid_weeks';
  END IF;

  -- Set AFTER argument validation so a rejected call never flips the flag.
  PERFORM set_config('app.admin_analytics_read', 'on', true);

  v_from := (date_trunc('week', now() AT TIME ZONE 'UTC') - make_interval(weeks => p_weeks - 1)) AT TIME ZONE 'UTC';

  RETURN QUERY
  WITH weeks AS (
    SELECT (date_trunc('week', now() AT TIME ZONE 'UTC') - make_interval(weeks => g.n)) AT TIME ZONE 'UTC' AS wk
      FROM generate_series(0, p_weeks - 1) AS g(n)
    UNION ALL
    SELECT NULL::TIMESTAMPTZ
  ), facts AS (
    -- In-flight rows (pending, extracting) are left out.
    SELECT date_trunc('week', t.created_at, 'UTC') AS wk,
           t.extractor_version AS version,
           t.status,
           t.model_id IS NOT NULL AS with_model,
           -- Non-empty arrays among the five sections.
           (SELECT count(*)
              FROM unnest(ARRAY['skills', 'tools', 'experience_signals', 'safety', 'notable']) AS k(name)
             WHERE jsonb_typeof(t.extracted -> k.name) = 'array'
               AND t.extracted -> k.name <> '[]'::JSONB) AS sections
      FROM public.worker_trust_extractions t
     WHERE t.created_at >= v_from
       AND t.status IN ('completed', 'failed')
  ), agg AS (
    -- extractor_version is NOT NULL, so a NULL version is a total.
    SELECT f.wk,
           f.version,
           count(*) AS n_extractions,
           count(*) FILTER (WHERE f.status = 'failed') AS n_failed,
           count(*) FILTER (WHERE f.status = 'completed' AND NOT f.with_model) AS n_not_enough,
           round(avg(f.sections) FILTER (WHERE f.status = 'completed' AND f.with_model), 1) AS avg_sections
      FROM facts f
     GROUP BY GROUPING SETS ((f.wk), (), (f.wk, f.version), (f.version))
  ), keys AS (
    SELECT w.wk, NULL::TEXT AS version FROM weeks w
    UNION ALL
    SELECT a.wk, a.version FROM agg a WHERE a.version IS NOT NULL
  )
  SELECT k.wk,
         k.version,
         COALESCE(a.n_extractions, 0),
         COALESCE(a.n_failed, 0),
         COALESCE(a.n_not_enough, 0),
         a.avg_sections
    FROM keys k
    LEFT JOIN agg a ON a.wk IS NOT DISTINCT FROM k.wk AND a.version IS NOT DISTINCT FROM k.version
   ORDER BY k.wk NULLS LAST, k.version NULLS FIRST;
END $$;

-- ── Billing inbox by week and event type ────────────────────
CREATE FUNCTION public.admin_analytics_billing_inbox(p_weeks INTEGER)
RETURNS TABLE (
  week_start              TIMESTAMPTZ,
  event_type              TEXT,
  received                BIGINT,
  processed               BIGINT,
  skipped                 BIGINT,
  failed                  BIGINT,
  retried                 BIGINT,
  payment_failed_invoices BIGINT
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
#variable_conflict use_column
DECLARE
  v_from TIMESTAMPTZ;
BEGIN
  IF p_weeks IS NULL OR p_weeks < 1 OR p_weeks > 26 THEN
    RAISE EXCEPTION 'admin_analytics_invalid_weeks';
  END IF;

  -- Set AFTER argument validation so a rejected call never flips the flag.
  PERFORM set_config('app.admin_analytics_read', 'on', true);

  v_from := (date_trunc('week', now() AT TIME ZONE 'UTC') - make_interval(weeks => p_weeks - 1)) AT TIME ZONE 'UTC';

  RETURN QUERY
  WITH weeks AS (
    SELECT (date_trunc('week', now() AT TIME ZONE 'UTC') - make_interval(weeks => g.n)) AT TIME ZONE 'UTC' AS wk
      FROM generate_series(0, p_weeks - 1) AS g(n)
    UNION ALL
    SELECT NULL::TIMESTAMPTZ
  ), facts AS (
    SELECT date_trunc('week', b.received_at, 'UTC') AS wk,
           b.event_type AS type,
           b.processing_status,
           b.attempt_count
      FROM public.billing_webhook_events b
     WHERE b.received_at >= v_from
  ), agg AS (
    -- event_type is NOT NULL, so a NULL type is a total.
    SELECT f.wk,
           f.type,
           count(*) AS n_received,
           count(*) FILTER (WHERE f.processing_status = 'processed') AS n_processed,
           count(*) FILTER (WHERE f.processing_status = 'skipped') AS n_skipped,
           count(*) FILTER (WHERE f.processing_status = 'failed') AS n_failed,
           count(*) FILTER (WHERE f.attempt_count > 1) AS n_retried,
           count(*) FILTER (WHERE f.type = 'invoice.payment_failed') AS n_payment_failed
      FROM facts f
     GROUP BY GROUPING SETS ((f.wk), (), (f.wk, f.type), (f.type))
  ), keys AS (
    SELECT w.wk, NULL::TEXT AS type FROM weeks w
    UNION ALL
    SELECT a.wk, a.type FROM agg a WHERE a.type IS NOT NULL
  )
  SELECT k.wk,
         k.type,
         COALESCE(a.n_received, 0),
         COALESCE(a.n_processed, 0),
         COALESCE(a.n_skipped, 0),
         COALESCE(a.n_failed, 0),
         COALESCE(a.n_retried, 0),
         COALESCE(a.n_payment_failed, 0)
    FROM keys k
    LEFT JOIN agg a ON a.wk IS NOT DISTINCT FROM k.wk AND a.type IS NOT DISTINCT FROM k.type
   ORDER BY k.wk NULLS LAST, k.type NULLS FIRST;
END $$;

-- ── Billing inbox right now ─────────────────────────────────
CREATE FUNCTION public.admin_analytics_billing_inbox_now()
RETURNS TABLE (
  stuck_received   BIGINT,
  failed_now       BIGINT,
  unresolved_older BIGINT,
  oldest_stuck_at  TIMESTAMPTZ
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
#variable_conflict use_column
BEGIN
  -- No arguments to validate.
  PERFORM set_config('app.admin_analytics_read', 'on', true);

  -- An aggregate with no GROUP BY: exactly one row, oldest NULL when empty.
  -- The processor dead-letters an event after about 20 minutes (3 SQS
  -- receives, 6 minutes apart, no backoff; the webhook already answered 200,
  -- so Stripe never retries). One hour is the boundary: events received less
  -- than an hour ago are stuck or failed now; those received an hour to
  -- 14 days ago are "unresolved", dead-lettered within the queue's 14-day
  -- retention, so they can be redriven from the queue. Older events have
  -- left the queue and must be resent from Stripe: they are not counted.
  RETURN QUERY
  SELECT count(*) FILTER (WHERE b.processing_status = 'received'
                            AND b.received_at > now() - interval '1 hour'),
         count(*) FILTER (WHERE b.processing_status = 'failed'
                            AND b.received_at > now() - interval '1 hour'),
         count(*) FILTER (WHERE b.received_at <= now() - interval '1 hour'
                            AND b.received_at > now() - interval '14 days'),
         min(b.received_at) FILTER (WHERE b.received_at > now() - interval '1 hour')
    FROM public.billing_webhook_events b
   -- Stuck: received with no live claim -- the processor's own re-claim
   -- predicate (an expired or missing lease). A failed row waits for the
   -- same re-claim, which stops at the dead-letter queue.
   WHERE (b.processing_status = 'received'
          AND (b.lease_expires_at IS NULL OR b.lease_expires_at < now()))
      OR b.processing_status = 'failed';
END $$;

-- ── Ownership + ACL ─────────────────────────────────────────
ALTER FUNCTION public.admin_analytics_message_backlog() OWNER TO jale_admin;
ALTER FUNCTION public.admin_analytics_message_failures(INTEGER) OWNER TO jale_admin;
ALTER FUNCTION public.admin_analytics_voice_extraction(INTEGER) OWNER TO jale_admin;
ALTER FUNCTION public.admin_analytics_trust_extraction(INTEGER) OWNER TO jale_admin;
ALTER FUNCTION public.admin_analytics_billing_inbox(INTEGER) OWNER TO jale_admin;
ALTER FUNCTION public.admin_analytics_billing_inbox_now() OWNER TO jale_admin;

REVOKE ALL ON FUNCTION public.admin_analytics_message_backlog() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.admin_analytics_message_failures(INTEGER) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.admin_analytics_voice_extraction(INTEGER) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.admin_analytics_trust_extraction(INTEGER) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.admin_analytics_billing_inbox(INTEGER) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.admin_analytics_billing_inbox_now() FROM PUBLIC;

GRANT EXECUTE ON FUNCTION public.admin_analytics_message_backlog() TO jale_admin_console;
GRANT EXECUTE ON FUNCTION public.admin_analytics_message_failures(INTEGER) TO jale_admin_console;
GRANT EXECUTE ON FUNCTION public.admin_analytics_voice_extraction(INTEGER) TO jale_admin_console;
GRANT EXECUTE ON FUNCTION public.admin_analytics_trust_extraction(INTEGER) TO jale_admin_console;
GRANT EXECUTE ON FUNCTION public.admin_analytics_billing_inbox(INTEGER) TO jale_admin_console;
GRANT EXECUTE ON FUNCTION public.admin_analytics_billing_inbox_now() TO jale_admin_console;

-- Fail closed if the writer cannot record a cause, if a new policy, the
-- column or its CHECK drifted, if any function drifted from the reviewed
-- model, if the gate does not open, or if bad input is accepted.
DO $$
DECLARE
  v_gate   CONSTANT TEXT := $q$(current_setting('app.admin_analytics_read'::text, true) = 'on'::text)$q$;
  v_check  CONSTANT TEXT := $q$CHECK (((failure_kind IS NULL) OR ((status = 'failed'::text) AND (failure_kind = ANY (ARRAY['transcribe'::text, 'empty_transcript'::text, 'audio_read'::text, 'model_call'::text, 'bad_json'::text, 'bad_shape'::text, 'pipeline_error'::text])))))$q$;
  pol      RECORD;
  fn       RECORD;
  fn_oid   OID;
  v_raised BOOLEAN;
  v_arg    INTEGER;
  v_weekly TEXT;
BEGIN
  -- The AI profile writer (jale_whatsapp) inserts the cause; 011's
  -- table-wide INSERT grant covers the new column.
  IF NOT has_column_privilege('jale_whatsapp', 'public.worker_profile_ai_extractions', 'failure_kind', 'INSERT') THEN
    RAISE EXCEPTION 'migration 115: jale_whatsapp cannot insert worker_profile_ai_extractions.failure_kind; the AI writer would fail every insert';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_attribute a
     WHERE a.attrelid = 'public.worker_profile_ai_extractions'::regclass
       AND a.attname = 'failure_kind'
       AND a.atttypid = 'text'::regtype
       AND NOT a.attnotnull
       AND NOT a.atthasdef
       AND NOT a.attisdropped
  ) THEN
    RAISE EXCEPTION 'migration 115: worker_profile_ai_extractions.failure_kind missing or drifted';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint con
     WHERE con.conrelid = 'public.worker_profile_ai_extractions'::regclass
       AND con.conname = 'worker_profile_ai_extractions_failure_kind_check'
       AND con.contype = 'c'
       AND con.convalidated
       AND pg_get_constraintdef(con.oid) = v_check
  ) THEN
    RAISE EXCEPTION 'migration 115: worker_profile_ai_extractions_failure_kind_check missing or drifted';
  END IF;

  FOR pol IN
    SELECT * FROM (VALUES
      ('public.job_message_outbox', 'job_message_outbox_admin_analytics_read'),
      ('public.worker_profile_ai_extractions', 'worker_profile_ai_extractions_admin_analytics_read'),
      ('public.worker_trust_extractions', 'worker_trust_extractions_admin_analytics_read'),
      ('public.billing_webhook_events', 'billing_webhook_events_admin_analytics_read')
    ) AS expected(rel, name)
  LOOP
    IF NOT EXISTS (
      SELECT 1 FROM pg_policy p
       WHERE p.polrelid = pol.rel::regclass
         AND p.polname = pol.name
         AND p.polcmd = 'r'
         AND p.polpermissive
         AND p.polroles = ARRAY['jale_admin'::regrole::oid]
         AND pg_get_expr(p.polqual, p.polrelid) = v_gate
    ) THEN
      RAISE EXCEPTION 'migration 115: policy % on % missing or drifted; the ops page would read zero rows', pol.name, pol.rel;
    END IF;
  END LOOP;

  FOR fn IN
    SELECT * FROM (VALUES
      ('public.admin_analytics_message_backlog()',
       'TABLE(lane text, open_under_1h bigint, open_1_24h bigint, open_24_48h bigint, stuck bigint, oldest_stuck_at timestamp with time zone)'),
      ('public.admin_analytics_message_failures(integer)',
       'TABLE(week_start timestamp with time zone, lane text, created bigint, gave_up bigint, delivery_failed bigint)'),
      ('public.admin_analytics_voice_extraction(integer)',
       'TABLE(week_start timestamp with time zone, model text, processed bigint, failed bigint, failed_transcribe bigint, failed_empty_transcript bigint, failed_audio_read bigint, failed_model_call bigint, failed_bad_json bigint, failed_bad_shape bigint, failed_pipeline_error bigint, failed_unrecorded bigint, usable bigint, full_name_found bigint, city_found bigint, main_trade_found bigint, main_trade_other_due bigint, main_trade_other_found bigint, years_experience_found bigint, has_transportation_found bigint, availability_found bigint)'),
      ('public.admin_analytics_trust_extraction(integer)',
       'TABLE(week_start timestamp with time zone, extractor_version text, extractions bigint, failed bigint, not_enough_detail bigint, avg_sections numeric)'),
      ('public.admin_analytics_billing_inbox(integer)',
       'TABLE(week_start timestamp with time zone, event_type text, received bigint, processed bigint, skipped bigint, failed bigint, retried bigint, payment_failed_invoices bigint)'),
      ('public.admin_analytics_billing_inbox_now()',
       'TABLE(stuck_received bigint, failed_now bigint, unresolved_older bigint, oldest_stuck_at timestamp with time zone)')
    ) AS expected(sig, result)
  LOOP
    fn_oid := to_regprocedure(fn.sig)::OID;
    IF fn_oid IS NULL THEN
      RAISE EXCEPTION 'migration 115: % missing', fn.sig;
    END IF;
    -- The exact columns the console maps, in order.
    IF pg_get_function_result(fn_oid) IS DISTINCT FROM fn.result THEN
      RAISE EXCEPTION 'migration 115: % result drifted', fn.sig;
    END IF;
    IF NOT EXISTS (
      SELECT 1 FROM pg_proc p
       WHERE p.oid = fn_oid
         AND p.proowner = 'jale_admin'::regrole::oid
         AND p.prosecdef
         -- A NULL proconfig (no pinned search_path) must fail, not skip.
         AND COALESCE(p.proconfig @> ARRAY['search_path=pg_catalog, pg_temp'], false)
    ) THEN
      RAISE EXCEPTION 'migration 115: % owner/secdef/search_path wrong', fn.sig;
    END IF;
    IF NOT has_function_privilege('jale_admin_console', fn_oid, 'EXECUTE') THEN
      RAISE EXCEPTION 'migration 115: % not executable by console', fn.sig;
    END IF;
    -- Exactly the owner and the console may execute (PUBLIC is grantee 0).
    IF EXISTS (
      SELECT 1 FROM pg_proc p, aclexplode(COALESCE(p.proacl, acldefault('f', p.proowner))) a
       WHERE p.oid = fn_oid AND a.privilege_type = 'EXECUTE'
         AND a.grantee NOT IN (p.proowner, 'jale_admin_console'::regrole::oid)
    ) THEN
      RAISE EXCEPTION 'migration 115: % executable by a role other than its owner and the console', fn.sig;
    END IF;
  END LOOP;

  -- 098's pattern: clear the gate before EACH call and read it back. Each
  -- call also plans its whole query, so a wrong table or column fails here.
  PERFORM set_config('app.admin_analytics_read', '', true);
  PERFORM * FROM public.admin_analytics_message_backlog();
  IF current_setting('app.admin_analytics_read', true) IS DISTINCT FROM 'on' THEN
    RAISE EXCEPTION 'migration 115: admin_analytics_message_backlog did not set the read flag';
  END IF;
  PERFORM set_config('app.admin_analytics_read', '', true);
  PERFORM * FROM public.admin_analytics_message_failures(4);
  IF current_setting('app.admin_analytics_read', true) IS DISTINCT FROM 'on' THEN
    RAISE EXCEPTION 'migration 115: admin_analytics_message_failures did not set the read flag';
  END IF;
  PERFORM set_config('app.admin_analytics_read', '', true);
  PERFORM * FROM public.admin_analytics_voice_extraction(4);
  IF current_setting('app.admin_analytics_read', true) IS DISTINCT FROM 'on' THEN
    RAISE EXCEPTION 'migration 115: admin_analytics_voice_extraction did not set the read flag';
  END IF;
  PERFORM set_config('app.admin_analytics_read', '', true);
  PERFORM * FROM public.admin_analytics_trust_extraction(4);
  IF current_setting('app.admin_analytics_read', true) IS DISTINCT FROM 'on' THEN
    RAISE EXCEPTION 'migration 115: admin_analytics_trust_extraction did not set the read flag';
  END IF;
  PERFORM set_config('app.admin_analytics_read', '', true);
  PERFORM * FROM public.admin_analytics_billing_inbox(4);
  IF current_setting('app.admin_analytics_read', true) IS DISTINCT FROM 'on' THEN
    RAISE EXCEPTION 'migration 115: admin_analytics_billing_inbox did not set the read flag';
  END IF;
  PERFORM set_config('app.admin_analytics_read', '', true);
  PERFORM * FROM public.admin_analytics_billing_inbox_now();
  IF current_setting('app.admin_analytics_read', true) IS DISTINCT FROM 'on' THEN
    RAISE EXCEPTION 'migration 115: admin_analytics_billing_inbox_now did not set the read flag';
  END IF;

  FOREACH v_weekly IN ARRAY ARRAY[
    'admin_analytics_message_failures', 'admin_analytics_voice_extraction',
    'admin_analytics_trust_extraction', 'admin_analytics_billing_inbox'
  ] LOOP
    FOREACH v_arg IN ARRAY ARRAY[0, 27] LOOP
      BEGIN
        EXECUTE format('SELECT * FROM public.%I($1)', v_weekly) USING v_arg;
        v_raised := false;
      EXCEPTION WHEN raise_exception THEN
        v_raised := SQLERRM = 'admin_analytics_invalid_weeks';
      END;
      IF NOT v_raised THEN
        RAISE EXCEPTION 'migration 115: %(%) did not reject the window', v_weekly, v_arg;
      END IF;
    END LOOP;
  END LOOP;
END $$;

COMMIT;
