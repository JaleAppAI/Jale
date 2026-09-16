-- 096_job_conversations_employer_read_backfill.sql
-- Run manually AFTER 095_application_hire_ack.sql
-- Connect as jale_admin (NOT the RDS master user).
--
-- Forward-only (ADR-005). ONE transaction. NO schema change: this file only
-- BACKFILLS a column that has existed, unused, since migration 028.
--
-- ── WHAT THIS IS FOR ──────────────────────────────────────────────────────
-- Sprint 26 gives the employer inbox an unread badge. A thread is unread when
-- the worker has written and the employer has not read since:
--
--     last_worker_message_at IS NOT NULL
--     AND (employer_last_read_at IS NULL
--          OR last_worker_message_at > employer_last_read_at)
--
-- `job_conversations.employer_last_read_at` was added by
-- 028_job_messaging_hardening.sql:37 and NOTHING has ever written it --
-- lambda/api/employer-conversations-read.ts, new in this sprint, is the first
-- and only writer. So on the day the badge ships every single row in the table
-- still carries NULL, and the formula above lights up EVERY conversation the
-- worker has ever replied to, including threads the employer read months ago
-- in the UI that existed before any of this.
--
-- That is not a cosmetic problem. A wall of stale badges on day one teaches
-- employers that the badge means nothing, and a badge nobody reads is worse
-- than no badge. This file stamps the history so the badge starts CLEAN and
-- only ever lights up for messages that arrive after it shipped.
--
-- ── WHY `GREATEST(...)` AND NOT THE MESSAGE TIMESTAMP ALONE ───────────────
-- The stamp has to be at least as late as the newest worker message on the
-- row, or the row stays badged and the file has not done its job. Two columns
-- can carry that instant, plus `created_at` as the floor for a thread that has
-- no messages at all (created_at is NOT NULL -- 025:14 -- which is what makes
-- the expression total, and therefore what makes the self-check below able to
-- assert zero remaining NULLs):
--
--   last_message_at         the newest message of ANY kind
--   last_worker_message_at  the newest message FROM THE WORKER
--
-- For every row the shipped code has ever written these two move together or
-- last_message_at is later: lib/job-messaging.ts:697-701 sets BOTH in one
-- statement on an inbound worker message, and :568-571 advances only
-- last_message_at on an outbound employer message. So on real data
-- `GREATEST(...)` and the simpler `COALESCE(last_message_at, created_at)` pick
-- exactly the same instant.
--
-- GREATEST is used anyway, for the row the old code COULD have left behind but
-- the new code must not be broken by: last_worker_message_at set with
-- last_message_at NULL. `COALESCE(last_message_at, created_at)` would stamp
-- such a row with created_at -- EARLIER than its worker message -- leaving it
-- badged, which is the one outcome this file exists to prevent. Being total
-- over legacy-shaped data costs one function call here; a stale badge that
-- survives the backfill costs the badge its credibility.
--
-- ── WHY THE UN-FORCE IS MANDATORY (the 028/094/095 pattern) ───────────────
-- job_conversations is ENABLE + FORCE ROW LEVEL SECURITY (025:87-88). FORCE is
-- the part that matters: it makes the table OWNER obey its policies too.
-- jale_admin owns this table AND is the role migrations run as, and both
-- applicable policies are keyed on a GUC -- job_conversations_employer_all on
-- app.current_internal_user_id (025:93-97) and job_conversations_worker_all on
-- the same GUC (025, worker side). With no GUC set they evaluate `= NULL`,
-- which matches NO row, so a bulk UPDATE here would rewrite ZERO rows and
-- report success. That is the silent no-op 094 and 095 were written around,
-- and this file follows the same shape 028_job_messaging_hardening.sql set on
-- THIS VERY TABLE (028:42-58): NO FORCE, backfill, FORCE.
-- `row_security = off` is NOT an alternative -- it is a no-op for a FORCEd
-- owner and a known trap in this repo.
--
-- ── THE set_updated_at SIDE EFFECT (accepted, not hidden) ─────────────────
-- 025:74-76 puts an UNCONDITIONAL `BEFORE UPDATE ... EXECUTE FUNCTION
-- set_updated_at()` trigger on job_conversations, so the backfill MOVES
-- updated_at to now() on every row it touches. The SET expression reads the
-- OLD values, so the stamp itself gets the historical instant -- only the
-- row's own updated_at advances. Accepted rather than worked around:
--   * 028 does exactly this to this same table and does not disable it;
--   * nothing orders, sweeps or dedupes on job_conversations.updated_at --
--     every conversation list and the inbox order by
--     COALESCE(last_message_at, created_at) (lib/job-messaging.ts:270, :803,
--     :877 and lib/employer-inbox.ts) -- so the only visible consequence is a
--     newer updated_at on the conversation summary the frontend already gets;
--   * DISABLE TRIGGER would trade a cosmetic drift for a far worse failure
--     mode: an un-reversed disable is permanent, silent loss of updated_at
--     maintenance for every writer of the table.
--
-- ── DEPLOY ORDER: apply BEFORE the code deploy ────────────────────────────
-- Not for schema reasons -- there is no schema change, and nothing reads a
-- column that does not already exist, so neither order can error. It is about
-- what employers SEE. Applied first, the badge is correct from the instant the
-- code lands. Applied after, every employer gets the wall of stale badges this
-- file exists to prevent for however long the gap lasts.
--
-- ── LOCK WINDOW ───────────────────────────────────────────────────────────
-- ALTER TABLE ... [NO] FORCE ROW LEVEL SECURITY takes ACCESS EXCLUSIVE on
-- job_conversations, and this transaction holds it until COMMIT. Every read
-- and write of the table blocks for the duration -- so the employer inbox,
-- every conversation view, every employer send, and every inbound WhatsApp
-- worker reply, which is most of the messaging surface.
--
-- Neither statement rewrites the table (they only flip a pg_class flag), but
-- the backfill between them is ONE seq scan plus a row version per
-- conversation, and it is held inside that same ACCESS EXCLUSIVE window. The
-- table is small (one row per employer/worker/job thread, not per message --
-- messages live in job_conversation_messages) so this is seconds, not minutes.
-- Apply it in a low-traffic window anyway: a blocked inbound WhatsApp reply is
-- a worker staring at an app that has stopped answering.
--
-- ── IDEMPOTENCE, AND THE ONE REAL HAZARD ──────────────────────────────────
-- Re-applying this file is a no-op: the UPDATE is gated on
-- `employer_last_read_at IS NULL`, so a second run matches zero rows, reports
-- `backfilled: 0`, and passes the self-check (which asserts only that no NULL
-- remains -- a property the first run established and nothing un-does, since
-- the shipped writer only ever sets the column to now()).
--
-- The hazard is not idempotence, it is TIMING. Run this file again AFTER the
-- badge has shipped and it also matches every conversation created since --
-- i.e. every thread a worker has written to that its employer has genuinely
-- not read yet -- and marks them read. Nobody loses data; those employers lose
-- one round of notifications. run-migrations.sh keeps a ledger
-- (public.schema_migrations) and skips a file it already records, so this can
-- only happen via `--force-replay` or a hand re-apply through the bastion.
-- Don't.
--
-- ── WHERE THE SELF-CHECK LIVES, AND WHY ───────────────────────────────────
-- Inside the un-forced window. It has to be: once FORCE is back on,
-- jale_admin's own SELECTs obey the same GUC-keyed policies and return ZERO
-- rows, so a data check placed after the re-force can never fail no matter how
-- broken the backfill was. The catalog assertion is the opposite -- pg_class is
-- not filtered by RLS, and asserting FORCE before the re-force would assert
-- the wrong value.

BEGIN;

-- ── un-force so the backfill can SEE and WRITE every row ──
ALTER TABLE job_conversations NO FORCE ROW LEVEL SECURITY;

DO $$
DECLARE
  v_backfilled INTEGER;
  v_null_left  INTEGER;
  v_still_unread INTEGER;
BEGIN
  -- PRECONDITION, not a post-condition: the statement above must actually have
  -- un-forced the table. Under FORCE RLS jale_admin's UPDATE is a silent
  -- zero-row no-op AND the NULL count below sees zero rows too (the policies
  -- filter them all away), so that check alone reads a total failure as a
  -- perfect success. This one cannot.
  IF (SELECT relforcerowsecurity FROM pg_catalog.pg_class
       WHERE oid = 'public.job_conversations'::regclass) THEN
    RAISE EXCEPTION 'migration 096: job_conversations is still FORCE RLS -- the backfill would silently update zero rows';
  END IF;

  -- The backfill. `employer_last_read_at IS NULL` is both the "not yet
  -- stamped" filter and the idempotence gate. created_at is NOT NULL, so the
  -- expression cannot itself produce a NULL.
  UPDATE job_conversations
     SET employer_last_read_at = GREATEST(
           COALESCE(last_message_at, created_at),
           COALESCE(last_worker_message_at, created_at)
         )
   WHERE employer_last_read_at IS NULL;
  GET DIAGNOSTICS v_backfilled = ROW_COUNT;
  RAISE NOTICE 'migration 096: conversations stamped as read-up-to-now: %', v_backfilled;

  -- ── DATA self-check, WHILE STILL UN-FORCED ─────────────────
  -- The invariant the badge depends on, and the ONLY one asserted here: after
  -- this file, no conversation carries a NULL read stamp. Everything the
  -- employer inbox shows as unread from here on is a message that arrived
  -- after the backfill.
  SELECT count(*) INTO v_null_left
    FROM job_conversations
   WHERE employer_last_read_at IS NULL;
  IF v_null_left > 0 THEN
    RAISE EXCEPTION 'migration 096: % conversation(s) still carry a NULL employer_last_read_at -- the backfill did not land', v_null_left;
  END IF;

  -- Reported, deliberately NOT asserted. On a first run this is 0 and says so.
  -- On a REPLAY after the badge has shipped it is legitimately non-zero -- a
  -- worker who wrote after their employer last read is genuinely unread, and
  -- the backfill above correctly leaves that row alone because its stamp is
  -- not NULL. Asserting zero here would make a later --force-replay fail on
  -- perfectly correct data, which is exactly the mutable-value trap 095's
  -- header warns about.
  SELECT count(*) INTO v_still_unread
    FROM job_conversations
   WHERE last_worker_message_at IS NOT NULL
     AND (employer_last_read_at IS NULL
          OR last_worker_message_at > employer_last_read_at);
  RAISE NOTICE 'migration 096: conversations still reading as unread after the backfill: %', v_still_unread;
END $$;

-- ── restore the tenant boundary ──
ALTER TABLE job_conversations FORCE ROW LEVEL SECURITY;

-- ── CATALOG self-check, AFTER the re-force ──
DO $$
BEGIN
  -- An un-force this file failed to reverse would be a permanent, silent hole
  -- in a tenant boundary -- every employer able to read and write every other
  -- employer's conversations. Worth its own check even though the statement
  -- above is three lines up.
  IF NOT EXISTS (
    SELECT 1
      FROM pg_catalog.pg_class rel
      JOIN pg_catalog.pg_namespace n ON n.oid = rel.relnamespace
     WHERE n.nspname = 'public' AND rel.relname = 'job_conversations'
       AND rel.relrowsecurity AND rel.relforcerowsecurity
  ) THEN
    RAISE EXCEPTION 'migration 096: job_conversations lost RLS ENABLE + FORCE';
  END IF;

  -- The column this file backfills, and the role that reads and writes it.
  -- No GRANT is issued here: 025:78 gives jale_admin table-level
  -- SELECT, INSERT, UPDATE on job_conversations and a table-level privilege
  -- covers columns added later -- which is why 028 needed no grant for
  -- employer_last_read_at either. Proven rather than assumed, so a future
  -- migration narrowing that grant to a column list fails HERE instead of
  -- 500ing every mark-read request.
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'job_conversations'
       AND column_name = 'employer_last_read_at'
  ) THEN
    RAISE EXCEPTION 'migration 096: job_conversations.employer_last_read_at is missing -- 028 did not run';
  END IF;
  IF NOT has_column_privilege('jale_admin', 'public.job_conversations', 'employer_last_read_at', 'UPDATE') THEN
    RAISE EXCEPTION 'migration 096: jale_admin cannot UPDATE job_conversations.employer_last_read_at -- the mark-read endpoint needs it';
  END IF;
  IF NOT has_column_privilege('jale_admin', 'public.job_conversations', 'employer_last_read_at', 'SELECT') THEN
    RAISE EXCEPTION 'migration 096: jale_admin cannot SELECT job_conversations.employer_last_read_at -- the inbox needs it';
  END IF;
END $$;

COMMIT;
