-- 062_job_visibility_outbox.sql
-- Durable outbox for downstream "a job became/stopped publicly visible"
-- notifications (e.g. search-index/sitemap sync), following the outbox
-- pattern already established for WhatsApp (004) and job messaging (025):
-- writers enqueue a row in the same transaction as the state change, a
-- separate sweeper drains and marks it sent/failed.
--
-- job_id has NO foreign key to jobs, and public_code is denormalized at
-- enqueue time rather than joined at read time. Both are deliberate: a
-- 'removed' event fires precisely when a job is deleted (or its public
-- listing is turned off), and that event must survive the job row's own
-- deletion so the drain can still tell downstream systems "this code is
-- gone." An ON DELETE CASCADE/RESTRICT FK would either silently destroy the
-- very event that reports the deletion, or block the deletion outright.
--
-- RLS is ENABLE + FORCE, so this table starts default-deny for every role,
-- including the owner (jale_admin) -- the FORCE is deliberate: without it,
-- jale_admin (as table owner) would bypass RLS entirely and a raw INSERT
-- would just succeed, defeating the whole point of routing writes through
-- enqueue_job_visibility_event(). (This is the opposite intent from 028's
-- worker_thread_counters, which explicitly does NOT force RLS so its
-- SECURITY DEFINER function -- also owned by jale_admin -- can rely on
-- plain owner-bypass. Here we want jale_admin's own ad hoc writes blocked
-- too, so bypass-via-ownership is exactly what must NOT happen.)
--
-- That created a real problem, verified empirically against Postgres 16:
-- FORCE ROW LEVEL SECURITY removes the owner-bypass exemption even inside a
-- SECURITY DEFINER function owned by the table owner -- Postgres's own error
-- in that shape is "query would be affected by row-level security policy"
-- with the hint "use ALTER TABLE NO FORCE ROW LEVEL SECURITY", i.e. Postgres
-- is telling you the ONLY way to let an owner-owned definer function bypass
-- FORCE is to stop forcing. Since we need both properties at once (owner's
-- raw INSERT blocked, AND the definer function's INSERT succeeds), plain
-- owner-bypass cannot be the mechanism. (056's "silent zero-row" framing
-- does not apply to INSERT at all -- a failed WITH CHECK on INSERT always
-- raises "new row violates row-level security policy", it never just
-- inserts zero rows; that hazard class is specific to UPDATE/DELETE, where
-- an unmatched USING clause silently matches nothing.)
--
-- The mechanism instead is a capability-flag INSERT policy: the function
-- sets a transaction-local GUC immediately before its INSERT, and the
-- (only) INSERT policy on this table requires that GUC. A caller who skips
-- the function never sets the flag, so their INSERT's WITH CHECK evaluates
-- false and Postgres raises the standard RLS violation error. This is the
-- smallest correct implementation of "only this function may write here"
-- under FORCE RLS -- not a "no policies at all" design, because that shape
-- is unreachable in real Postgres once FORCE is combined with a same-owner
-- SECURITY DEFINER writer.
--
-- Read/drain access (SELECT + UPDATE) is a narrow direct policy rather than
-- a second SECURITY DEFINER pair: this table holds no PII (job_id and
-- public_code are already public information -- public_code literally
-- appears in a public URL), so there is no privacy reason to hide it from
-- jale_admin, only a reason to keep the INSERT path safe from being trivially
-- bypassed.
--
-- Forward-only. Applied manually via bastion (ADR-005).
BEGIN;

CREATE TABLE job_visibility_events (
    id             UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    job_id         UUID        NOT NULL,
    public_code    TEXT        NOT NULL,
    event_kind     TEXT        NOT NULL CHECK (event_kind IN ('published', 'removed')),
    status         TEXT        NOT NULL DEFAULT 'pending'
                                CHECK (status IN ('pending', 'sent', 'failed')),
    attempt_count  INTEGER     NOT NULL DEFAULT 0,
    last_error     TEXT,
    created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    sent_at        TIMESTAMPTZ
);

COMMENT ON COLUMN job_visibility_events.job_id IS
    'Deliberately NOT a foreign key to jobs: a removed event must survive the job row''s own deletion.';
COMMENT ON COLUMN job_visibility_events.public_code IS
    'Denormalized at enqueue time for the same reason as job_id -- jobs.public_code would be unreachable once the job is gone.';

CREATE INDEX job_visibility_events_drain_idx
    ON job_visibility_events (status, created_at)
    WHERE status IN ('pending', 'failed');

ALTER TABLE job_visibility_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE job_visibility_events FORCE  ROW LEVEL SECURITY;

-- ---------------------------------------------------------------------------
-- Enqueue: SECURITY DEFINER, gated by a transaction-local capability flag
-- that only this function sets. See header for why a bare SECURITY DEFINER
-- insert with zero policies cannot work once the table FORCEs RLS.
-- ---------------------------------------------------------------------------
CREATE POLICY job_visibility_events_enqueue ON job_visibility_events
    FOR INSERT TO jale_admin
    WITH CHECK (current_setting('jale.job_visibility_enqueue', true) = 'on');

CREATE OR REPLACE FUNCTION enqueue_job_visibility_event(
    p_job_id      UUID,
    p_public_code TEXT,
    p_kind        TEXT
) RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
    -- is_local = true: scoped to the current transaction only, so the
    -- capability never leaks into a later, unrelated transaction on a
    -- pooled connection.
    PERFORM set_config('jale.job_visibility_enqueue', 'on', true);
    INSERT INTO job_visibility_events (job_id, public_code, event_kind)
    VALUES (p_job_id, p_public_code, p_kind);
END;
$$;

REVOKE ALL ON FUNCTION enqueue_job_visibility_event(UUID, TEXT, TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION enqueue_job_visibility_event(UUID, TEXT, TEXT) TO jale_admin;

-- ---------------------------------------------------------------------------
-- Drain: a narrow direct policy, not a second SECURITY DEFINER pair. The
-- table carries no PII, so there is nothing to hide from jale_admin here --
-- only the INSERT path needed the definer-function workaround.
-- ---------------------------------------------------------------------------
CREATE POLICY job_visibility_events_drain ON job_visibility_events
    FOR SELECT TO jale_admin USING (true);

CREATE POLICY job_visibility_events_drain_update ON job_visibility_events
    FOR UPDATE TO jale_admin USING (true) WITH CHECK (true);

GRANT SELECT, UPDATE ON job_visibility_events TO jale_admin;

COMMIT;
