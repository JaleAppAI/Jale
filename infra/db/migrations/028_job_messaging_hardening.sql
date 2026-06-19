-- ============================================================
-- 026_job_messaging_hardening.sql
-- Run manually AFTER 025_job_messaging.sql. Connect as: jale_admin.
--
-- Phase 1 of docs/job-messaging-v2-plan.md:
--   R2  - jale_whatsapp UPDATE grant on job_applications (worker-row-scoped)
--   §4.1 focused-thread column + accepted_at lifecycle
--   §4.4 thread-number counter, twilio sid index, status-callback function,
--        outbox sweeper helper, message status widening
-- ============================================================
BEGIN;

-- ── R2: job_applications UPDATE for jale_whatsapp ─────────────
-- Column-scoped grant; the old FOR ALL USING(true) policy is split so the
-- new UPDATE is row-scoped to the relaying worker (app.current_internal_user_id).
-- SELECT and INSERT intentionally stay permissive (USING/ WITH CHECK true):
-- the WhatsApp role still needs cross-worker application reads for job-alert
-- and apply flows (a deliberate V1 trade-off, cf. ADR-W05). Tightening those
-- is a separate scoped change with its own apply-flow verification, not Phase 1.
GRANT UPDATE (status, updated_at) ON job_applications TO jale_whatsapp;

DROP POLICY IF EXISTS jobapp_whatsapp_all ON job_applications;
DROP POLICY IF EXISTS jobapp_whatsapp_select ON job_applications;
DROP POLICY IF EXISTS jobapp_whatsapp_insert ON job_applications;
DROP POLICY IF EXISTS jobapp_whatsapp_update ON job_applications;
CREATE POLICY jobapp_whatsapp_select ON job_applications
    FOR SELECT TO jale_whatsapp USING (true);
CREATE POLICY jobapp_whatsapp_insert ON job_applications
    FOR INSERT TO jale_whatsapp WITH CHECK (true);
CREATE POLICY jobapp_whatsapp_update ON job_applications
    FOR UPDATE TO jale_whatsapp
    USING (worker_id::text = current_setting('app.current_internal_user_id', true))
    WITH CHECK (worker_id::text = current_setting('app.current_internal_user_id', true));

-- ── Conversation lifecycle columns ────────────────────────────
ALTER TABLE job_conversations ADD COLUMN IF NOT EXISTS accepted_at TIMESTAMPTZ;
ALTER TABLE job_conversations ADD COLUMN IF NOT EXISTS employer_last_read_at TIMESTAMPTZ;
ALTER TABLE job_conversations ADD COLUMN IF NOT EXISTS worker_thread_number INTEGER;

-- Backfills must see ALL rows. jale_admin owns the table but 025 FORCEs
-- RLS, so temporarily un-force, backfill, re-force.
ALTER TABLE job_conversations NO FORCE ROW LEVEL SECURITY;

-- A worker who has ever replied has implicitly accepted the conversation.
UPDATE job_conversations
   SET accepted_at = last_worker_message_at
 WHERE last_worker_message_at IS NOT NULL;

WITH numbered AS (
  SELECT id, row_number() OVER (PARTITION BY worker_id ORDER BY created_at) AS n
  FROM job_conversations
)
UPDATE job_conversations jc
   SET worker_thread_number = numbered.n
  FROM numbered
 WHERE jc.id = numbered.id;

ALTER TABLE job_conversations FORCE ROW LEVEL SECURITY;

-- UNIQUE allows NULLs; NOT NULL is deferred to a Phase 2 migration so a
-- migration-before-deploy window cannot break conversation creation.
CREATE UNIQUE INDEX IF NOT EXISTS job_conversations_worker_thread_number_unique
    ON job_conversations (worker_id, worker_thread_number);

-- ── Per-worker thread-number counter ──────────────────────────
-- createApplicantConversation runs as jale_admin under an EMPLOYER-scoped
-- policy, so a max()+1 there only sees that employer's rows. This counter
-- is SECURITY DEFINER and the counter-row lock serializes per worker.
CREATE TABLE IF NOT EXISTS worker_thread_counters (
    worker_id   UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    last_number INTEGER NOT NULL
);

-- Internal counter: only ever touched via assign_worker_thread_number
-- (SECURITY DEFINER, owned by jale_admin). Grant jale_admin explicitly for
-- parity with the other messaging tables; enable RLS with no policy so any
-- non-owner role is default-denied direct access. RLS is NOT forced — the
-- definer function (running as the owner) must bypass it.
GRANT SELECT, INSERT, UPDATE ON worker_thread_counters TO jale_admin;
ALTER TABLE worker_thread_counters ENABLE ROW LEVEL SECURITY;

INSERT INTO worker_thread_counters (worker_id, last_number)
SELECT worker_id, MAX(worker_thread_number)
  FROM job_conversations
 WHERE worker_thread_number IS NOT NULL
 GROUP BY worker_id
ON CONFLICT (worker_id) DO NOTHING;

CREATE OR REPLACE FUNCTION assign_worker_thread_number(p_worker_id UUID)
RETURNS INTEGER
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_n INTEGER;
BEGIN
  INSERT INTO worker_thread_counters (worker_id, last_number)
       VALUES (p_worker_id, 1)
  ON CONFLICT (worker_id)
       DO UPDATE SET last_number = worker_thread_counters.last_number + 1
  RETURNING last_number INTO v_n;
  RETURN v_n;
END $$;

REVOKE ALL ON FUNCTION assign_worker_thread_number(UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION assign_worker_thread_number(UUID) TO jale_admin, jale_whatsapp;

-- ── Focused-thread column (§4.1) ──────────────────────────────
-- Close is a status flip, not a DELETE, so routing additionally treats a
-- focused-but-closed conversation as NULL at read time (code-side rule).
ALTER TABLE whatsapp_conversations
    ADD COLUMN IF NOT EXISTS focused_job_conversation_id UUID
    REFERENCES job_conversations(id) ON DELETE SET NULL;

-- ── Message status widening + delivery metadata (R9 prep) ─────
-- 025 created this CHECK inline, so PostgreSQL auto-generated its name.
-- Drop it by locating the single-column CHECK on `status` via the catalog
-- rather than depending on the generated name.
-- Locate the status CHECK by its definition text (matches the repo pattern
-- used in 015/019/023), tolerant of the generated name; LIMIT 1 guards
-- against an unexpected duplicate.
DO $$
DECLARE c_name TEXT;
BEGIN
  SELECT con.conname INTO c_name
    FROM pg_constraint con
   WHERE con.conrelid = 'job_conversation_messages'::regclass
     AND con.contype = 'c'
     AND pg_get_constraintdef(con.oid) ILIKE '%status%'
   LIMIT 1;
  IF c_name IS NOT NULL THEN
    EXECUTE format('ALTER TABLE job_conversation_messages DROP CONSTRAINT %I', c_name);
  END IF;
END $$;
ALTER TABLE job_conversation_messages
    ADD CONSTRAINT job_conversation_messages_status_check
    CHECK (status IN ('queued', 'waiting_worker_reply', 'sent', 'delivered',
                      'read', 'undelivered', 'failed', 'received'));
ALTER TABLE job_conversation_messages ADD COLUMN IF NOT EXISTS delivered_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_job_messages_twilio_sid
    ON job_conversation_messages (twilio_message_sid)
    WHERE twilio_message_sid IS NOT NULL;

-- ── Twilio status callback writer (used by Phase 3 route) ─────
-- SECURITY DEFINER: the callback Lambda has only a MessageSid — no worker
-- RLS context — so a plain UPDATE as jale_whatsapp matches 0 rows.
-- Monotonic guard: callbacks arrive out of order and are retried. Note: a
-- `read` callback that arrives before any `delivered` leaves delivered_at
-- NULL (no delivery confirmation ever arrived) — an accepted data gap.
CREATE OR REPLACE FUNCTION record_twilio_status(
    p_sid TEXT, p_status TEXT, p_at TIMESTAMPTZ
) RETURNS BOOLEAN
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_updated INTEGER;
BEGIN
  IF p_status NOT IN ('sent', 'delivered', 'read', 'failed', 'undelivered') THEN
    RETURN false;
  END IF;
  UPDATE job_conversation_messages
     SET status = p_status,
         sent_at      = CASE WHEN p_status = 'sent'
                             THEN COALESCE(sent_at, p_at) ELSE sent_at END,
         delivered_at = CASE WHEN p_status = 'delivered'
                             THEN COALESCE(delivered_at, p_at) ELSE delivered_at END
   WHERE twilio_message_sid = p_sid
     AND status NOT IN ('received', 'failed', 'undelivered')      -- terminal
     AND (
       -- forward-only ladder: queued/waiting(0) < sent(1) < delivered(2) < read(3)
       (p_status = 'sent'        AND status IN ('queued', 'waiting_worker_reply'))
       OR (p_status = 'delivered' AND status IN ('queued', 'waiting_worker_reply', 'sent'))
       OR (p_status = 'read'      AND status IN ('queued', 'waiting_worker_reply', 'sent', 'delivered'))
       -- failure states only before delivery succeeded
       OR (p_status IN ('failed', 'undelivered')
           AND status IN ('queued', 'waiting_worker_reply', 'sent'))
     );
  GET DIAGNOSTICS v_updated = ROW_COUNT;
  RETURN v_updated > 0;
END $$;

REVOKE ALL ON FUNCTION record_twilio_status(TEXT, TEXT, TIMESTAMPTZ) FROM PUBLIC;
-- jale_whatsapp is the planned caller (status route lives in WhatsAppStack);
-- jale_admin granted too so a future API-stack caller needs no new migration.
GRANT EXECUTE ON FUNCTION record_twilio_status(TEXT, TEXT, TIMESTAMPTZ) TO jale_whatsapp, jale_admin;

-- ── Outbox sweeper helper (R8) ────────────────────────────────
-- The sweeper runs as jale_whatsapp; worker-scoped RLS hides other
-- workers' stuck rows, so discovery is SECURITY DEFINER. The sweeper then
-- sets per-worker RLS context and flushes through the normal path.
CREATE OR REPLACE FUNCTION list_stale_job_outbox_workers(
    p_min_age INTERVAL DEFAULT INTERVAL '5 minutes'
) RETURNS TABLE (worker_id UUID)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT DISTINCT jc.worker_id
    FROM job_message_outbox o
    JOIN job_conversations jc ON jc.id = o.conversation_id
   WHERE o.status IN ('pending', 'failed')
     AND o.attempt_count < 5
     AND o.created_at < now() - p_min_age
$$;

REVOKE ALL ON FUNCTION list_stale_job_outbox_workers(INTERVAL) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION list_stale_job_outbox_workers(INTERVAL) TO jale_whatsapp;

COMMIT;
