-- ============================================================
-- 055_job_conversations_application_index.sql
-- Index job_conversations.application_id for the employer inbox query.
-- Connect as: jale_admin (NOT the RDS master user)
--
-- Migration 025 created job_conversations with a NOT NULL FK to
-- job_applications but no index on that column (PostgreSQL does not
-- index foreign keys automatically). Its three indexes lead with
-- job_id/employer_id/worker_id, so none of them serve a lookup keyed
-- on application_id.
--
-- The employer inbox query (infra/lambda/lib/employer-inbox.ts) selects
-- the representative conversation per application through a correlated
-- lateral join:
--
--   LEFT JOIN LATERAL (
--     SELECT ... FROM job_conversations jc
--      WHERE jc.application_id = ja.id
--      ORDER BY (jc.status = 'open') DESC,
--               COALESCE(jc.last_message_at, jc.created_at) DESC
--      LIMIT 1
--   ) c ON true
--
-- Its outer ORDER BY reads values produced inside the lateral, so the
-- outer LIMIT cannot be pushed down: the lateral is evaluated once per
-- surviving job_applications row. Without this index each of those
-- evaluations scans job_conversations, on a query that runs every time
-- an employer opens the messaging tab.
--
-- Single column deliberately. application_id is the whole fix -- it
-- turns each per-application probe into an index lookup. Appending
-- status/last_message_at/created_at would NOT let the planner skip the
-- lateral's sort, because that sort is on the expressions
-- `(status = 'open')` and `COALESCE(last_message_at, created_at)`
-- rather than on the bare columns, and a btree cannot order by an
-- expression it does not index. The rows behind one application_id are
-- few (the job_conversations_open_unique partial index permits at most
-- one open thread per job+employer+worker, plus any closed history), so
-- sorting that group in memory is cheap and the extra index width would
-- buy nothing.
--
-- OPERATOR NOTE (lock window): this builds without CONCURRENTLY inside
-- the migration transaction, matching the deliberate trade documented
-- in 040 -- CREATE INDEX CONCURRENTLY cannot run inside a transaction
-- block, and keeping migrations atomic is the established convention
-- here. The build takes ACCESS EXCLUSIVE on job_conversations and so
-- blocks concurrent readers and writers (employer sends, inbound
-- WhatsApp replies, the outbox sweeper) for the duration of one scan of
-- the table. At current row counts that window is small; apply during a
-- low-traffic window. If job_conversations ever grows large enough that
-- the window matters, write a NEW migration using CREATE INDEX
-- CONCURRENTLY outside a transaction instead of editing this file.
-- ============================================================

BEGIN;

CREATE INDEX IF NOT EXISTS idx_job_conversations_application
  ON job_conversations (application_id);

COMMIT;
