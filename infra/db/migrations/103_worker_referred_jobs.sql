-- ============================================================
-- 103_worker_referred_jobs.sql
-- Run manually AFTER 102_admin_identity_lockouts.sql,
-- connected as jale_admin. Forward-only (ADR-005). ONE transaction.
--
-- The per-worker referred-jobs list.
--
-- A worker opened a friend's job link, finished onboarding, and never saw
-- the job. Until now the server kept a referred job only as referral CREDIT
-- (worker_attribution: one first touch and one latest touch per worker,
-- written only for a tagged link), and the feed pinned exactly one job,
-- COALESCE(latest_job_id, first_job_id). This file adds a separate list: one
-- row per (worker, job) the worker came to Jale for, recorded from every
-- door (the web claim from a job page or a share link, the WhatsApp Apply
-- token, a typed job code) and read by the feed pin (every open, unapplied
-- referred job, newest first) and by the web onboarding Done screen.
-- worker_attribution and its first-touch credit are unchanged.
--
-- (1) worker_referred_jobs. Both foreign keys CASCADE: employers hard-delete
--     jobs, and RESTRICT would turn every such delete into an error. source
--     is where the job was last learned (informational); last_seen_at is
--     refreshed on every re-record and is the sort key, hence the
--     (worker_id, last_seen_at DESC) index. Every statement the application
--     runs on this table carries an explicit `worker_id = $n`: that predicate
--     is the boundary, and the two policies are defence in depth.
--       jale_admin     the worker_attribution_owner shape (056), keyed on the
--                      Cognito sub in app.current_user_id.
--       jale_whatsapp  the 081 shape, keyed on users.id in
--                      app.current_internal_user_id. ::text, so the empty
--                      string a warm pooled connection carries is a non-match
--                      rather than a 22P02.
--     Neither policy reads jobs or job_applications (the 038 recursion
--     class). Only SELECT, INSERT and UPDATE are granted; rows leave with
--     their worker or their job. jale_admin still holds DELETE as the
--     table's OWNER and must keep it: PostgreSQL runs an ON DELETE CASCADE
--     as the referencing table's owner, so an owner without DELETE would turn
--     every job hard-delete and every account delete into a 42501 (measured
--     on the testbed).
--
-- (2) The backfill, so no worker pinned today loses the pin. Sources:
--     worker_attribution.first_job_id (at first_seen_at) and latest_job_id
--     (at latest_seen_at), skipping NULLs (both are ON DELETE SET NULL), and
--     claimed referral_pending_claims (claimed_worker_id IS NOT NULL, at
--     claimed_at). The same pair can arrive more than once -- first = latest
--     for a worker referred once, or a claim repeating an attribution -- and
--     one INSERT ... ON CONFLICT DO UPDATE cannot touch a row twice (21000),
--     so the sources are grouped per pair first: first_seen_at is the
--     earliest touch and last_seen_at the latest. A conflict only widens an
--     existing row's window (LEAST / GREATEST) and keeps its source. jobs is
--     not read: the foreign keys guarantee each job exists, so a job that is
--     no longer active is copied anyway, and the readers check status
--     themselves.
--
-- (3) Two referral-schema repairs, found while building this list and folded
--     in here (decided 2026-10-01). Both concern foreign keys 056 created.
--     a. No employer could hard-delete a job that was any worker's first
--        touch. first_job_id's ON DELETE SET NULL is an UPDATE of
--        worker_attribution, and the 056/063 first-touch trigger rejected it
--        with restrict_violation (measured on the testbed through
--        employer-jobs-delete.ts's own statements). The trigger function
--        keeps 063's body and gains exactly one allowed change: first_job_id
--        going from a job to NULL. Every other first_* change still raises,
--        first_job_id moving to a different job included.
--        The credit survives the job's deletion: first_share_code,
--        first_channel, both referrers and first_seen_at are untouched.
--     b. No worker who had claimed a WhatsApp referral could be deleted.
--        claimed_worker_id's ON DELETE SET NULL cleared the worker but left
--        claimed_at, which referral_pending_claims_claimed_coherent rejects
--        (23514, measured). The foreign key is re-created ON DELETE CASCADE
--        under the name 056's inline REFERENCES gave it,
--        referral_pending_claims_claimed_worker_id_fkey (read from the
--        catalog), so the claim leaves with the worker. The CHECK stays.
--
-- (4) referral_pending_claims.earlier_job_ids: the jobs a phone parked before
--     its last code, kept until the claim. A second code from the same phone
--     takes over the claim, and the credit goes with the last code; while the
--     claim is unclaimed, the job it replaces is appended here, and the claim
--     records each of them on the worker's list, oldest first, before the
--     claimed job. NOT NULL with an empty default, so code that never names
--     the column keeps working; the self-check pins its type and default.
--
-- WHY THE UN-FORCE (the 028/094/095/096 pattern).
-- worker_attribution and referral_pending_claims are ENABLE + FORCE ROW LEVEL
-- SECURITY (056). This file lifts FORCE for the backfill: a precondition
-- checks that the flag really is off, the backfill and its data self-check
-- run inside that window, and then FORCE is restored and a catalog self-check
-- runs. So the result does not depend on how the policies treat the applying
-- session. `row_security = off` is no substitute: it lifts no policy; it makes
-- an affected query fail.
-- worker_referred_jobs is un-forced with them for the same reason. On a first
-- apply that is a no-op (the table is created in this transaction and forced
-- at the end); a replay finds it FORCEd by the first apply, and its upsert
-- must not depend on the policies either.
--
-- LOCK WINDOW. Dropping the old claimed_worker_id foreign key takes
-- ACCESS EXCLUSIVE on users as well as on referral_pending_claims (its RI
-- triggers live on users; measured on the testbed), so until COMMIT no
-- request can even READ users: every signed-in request and every WhatsApp
-- turn waits, as under 094. That is why the swap runs first: users is locked
-- once, at full strength, and never upgraded mid-transaction. ALTER TABLE
-- ... [NO] FORCE ROW LEVEL SECURITY then takes ACCESS EXCLUSIVE on all three
-- referral tables, and the new table's foreign keys take SHARE ROW EXCLUSIVE
-- on jobs, so no job row can be written until it commits either. The tables
-- are tiny and the transaction is short; apply it in a low-traffic window
-- anyway.
--
-- REPLAY. Safe at any time: IF NOT EXISTS, DROP POLICY IF EXISTS before each
-- CREATE POLICY, an already-held GRANT, CREATE OR REPLACE for the trigger
-- function, DROP CONSTRAINT IF EXISTS before the foreign key is re-added, and
-- a backfill that only adds pairs or widens a row's window. It never deletes
-- a row, never narrows one and never rewrites a source. A replay after a later
-- migration has added the reviewed copies of the two policies for a dedicated
-- login accepts those copies by exact name; any other policy on the table
-- still fails the self-check.
--
-- DEPLOY ORDER: apply this migration BEFORE the code deploy. The new code
-- reads and writes worker_referred_jobs (POST /worker/referrals/claim,
-- GET /worker/onboarding, the feed pin and the WhatsApp doors); the old code
-- never touches it, so applying first is safe. Applied after, every claim
-- that reaches a job record is a 500, and until it lands the feed pins
-- nothing and the Done screen shows no job. Production deploys refuse
-- migration diffs, so 103 goes through the bastion runbook first and the
-- code deploy is dispatched after it. Keep that gap short: a referral the
-- old code records in between lands only in worker_attribution, and a
-- replay of this file (see REPLAY) is what picks it up. The two repairs in
-- (3) need no code at all and are safe on either side of the deploy.
-- ============================================================
BEGIN;

-- ── Repairs (3b, then 3a) ───────────────────────────────────
-- The claim foreign key first: dropping it is what locks users, and taking
-- that lock before anything else means it is never upgraded mid-transaction.
ALTER TABLE referral_pending_claims
    DROP CONSTRAINT IF EXISTS referral_pending_claims_claimed_worker_id_fkey;
ALTER TABLE referral_pending_claims
    ADD CONSTRAINT referral_pending_claims_claimed_worker_id_fkey
    FOREIGN KEY (claimed_worker_id) REFERENCES users(id) ON DELETE CASCADE;
ALTER TABLE referral_pending_claims
    ADD COLUMN IF NOT EXISTS earlier_job_ids UUID[] NOT NULL DEFAULT '{}'::uuid[];

-- 063's body, except that first_job_id may go from a job to NULL -- its own
-- ON DELETE SET NULL -- and in no other way. CREATE OR REPLACE keeps the
-- worker_attribution_first_touch_immutable binding (the 029/063 precedent).
CREATE OR REPLACE FUNCTION worker_attribution_reject_first_touch_change()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
    IF NEW.first_share_code           IS DISTINCT FROM OLD.first_share_code
       OR NEW.first_channel              IS DISTINCT FROM OLD.first_channel
       OR (NEW.first_job_id IS DISTINCT FROM OLD.first_job_id
           AND NOT (OLD.first_job_id IS NOT NULL AND NEW.first_job_id IS NULL))
       OR NEW.first_referrer_worker_id   IS DISTINCT FROM OLD.first_referrer_worker_id
       OR NEW.first_referrer_employer_id IS DISTINCT FROM OLD.first_referrer_employer_id
       OR NEW.first_seen_at              IS DISTINCT FROM OLD.first_seen_at
    THEN
        RAISE EXCEPTION
            'worker_attribution first-touch columns are immutable (worker_id=%)', OLD.worker_id
            USING ERRCODE = 'restrict_violation';
    END IF;
    RETURN NEW;
END;
$$;

-- ── The list ────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS worker_referred_jobs (
    worker_id      UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    job_id         UUID NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
    source         TEXT NOT NULL CHECK (source IN
        ('share_link', 'job_page', 'whatsapp_token', 'typed_code', 'backfill')),
    first_seen_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_seen_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (worker_id, job_id)
);

CREATE INDEX IF NOT EXISTS worker_referred_jobs_recent_idx
    ON worker_referred_jobs (worker_id, last_seen_at DESC);

COMMENT ON TABLE worker_referred_jobs IS
    'Jobs each worker came to Jale for, recorded from every door. Not referral credit (that is worker_attribution).';

GRANT SELECT, INSERT, UPDATE ON worker_referred_jobs TO jale_admin, jale_whatsapp;

ALTER TABLE worker_referred_jobs ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS worker_referred_jobs_owner ON worker_referred_jobs;
CREATE POLICY worker_referred_jobs_owner ON worker_referred_jobs
    FOR ALL TO jale_admin
    USING (worker_id = (SELECT id FROM users
                        WHERE cognito_sub = current_setting('app.current_user_id', true)))
    WITH CHECK (worker_id = (SELECT id FROM users
                        WHERE cognito_sub = current_setting('app.current_user_id', true)));

DROP POLICY IF EXISTS worker_referred_jobs_whatsapp ON worker_referred_jobs;
CREATE POLICY worker_referred_jobs_whatsapp ON worker_referred_jobs
    FOR ALL TO jale_whatsapp
    USING (worker_id::text = current_setting('app.current_internal_user_id', true))
    WITH CHECK (worker_id::text = current_setting('app.current_internal_user_id', true));

-- ── un-force the sources and the list for the backfill ──
ALTER TABLE worker_attribution NO FORCE ROW LEVEL SECURITY;
ALTER TABLE referral_pending_claims NO FORCE ROW LEVEL SECURITY;
ALTER TABLE worker_referred_jobs NO FORCE ROW LEVEL SECURITY;

DO $$
DECLARE
  v_table   TEXT;
  v_rows    INTEGER;
  v_missing INTEGER;
BEGIN
  -- PRECONDITION, not a post-condition: the backfill runs only with FORCE
  -- lifted, and the data self-check below reads the same sources, so that
  -- check alone cannot catch a backfill that read nothing. This one can.
  FOREACH v_table IN ARRAY ARRAY['worker_attribution', 'referral_pending_claims', 'worker_referred_jobs'] LOOP
    IF (SELECT relforcerowsecurity FROM pg_catalog.pg_class
         WHERE oid = format('public.%I', v_table)::regclass) THEN
      RAISE EXCEPTION 'migration 103: % is still FORCE RLS -- the backfill would silently copy zero rows', v_table;
    END IF;
  END LOOP;

  -- The backfill: one row per pair, spanning its earliest and latest touch.
  INSERT INTO worker_referred_jobs (worker_id, job_id, source, first_seen_at, last_seen_at)
  SELECT src.worker_id, src.job_id, 'backfill', min(src.seen_at), max(src.seen_at)
    FROM (
      SELECT wa.worker_id, wa.first_job_id AS job_id, wa.first_seen_at AS seen_at
        FROM worker_attribution wa
       WHERE wa.first_job_id IS NOT NULL
      UNION ALL
      SELECT wa.worker_id, wa.latest_job_id, wa.latest_seen_at
        FROM worker_attribution wa
       WHERE wa.latest_job_id IS NOT NULL
      UNION ALL
      SELECT rpc.claimed_worker_id, rpc.job_id, rpc.claimed_at
        FROM referral_pending_claims rpc
       WHERE rpc.claimed_worker_id IS NOT NULL
    ) src
   GROUP BY src.worker_id, src.job_id
  ON CONFLICT (worker_id, job_id) DO UPDATE
     SET first_seen_at = LEAST(worker_referred_jobs.first_seen_at, EXCLUDED.first_seen_at),
         last_seen_at  = GREATEST(worker_referred_jobs.last_seen_at, EXCLUDED.last_seen_at)
   WHERE EXCLUDED.first_seen_at < worker_referred_jobs.first_seen_at
      OR EXCLUDED.last_seen_at > worker_referred_jobs.last_seen_at;
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  RAISE NOTICE 'migration 103: referred (worker, job) pairs added or widened from the referral history: %', v_rows;

  -- ── DATA self-check, WHILE STILL UN-FORCED ──
  -- Every pair the referral history names is now on the list.
  SELECT count(*) INTO v_missing
    FROM (
      SELECT wa.worker_id, wa.first_job_id AS job_id
        FROM worker_attribution wa
       WHERE wa.first_job_id IS NOT NULL
      UNION
      SELECT wa.worker_id, wa.latest_job_id
        FROM worker_attribution wa
       WHERE wa.latest_job_id IS NOT NULL
      UNION
      SELECT rpc.claimed_worker_id, rpc.job_id
        FROM referral_pending_claims rpc
       WHERE rpc.claimed_worker_id IS NOT NULL
    ) src
   WHERE NOT EXISTS (
     SELECT 1
       FROM worker_referred_jobs r
      WHERE r.worker_id = src.worker_id
        AND r.job_id = src.job_id
   );
  IF v_missing > 0 THEN
    RAISE EXCEPTION 'migration 103: % referred (worker, job) pair(s) are missing from worker_referred_jobs -- the backfill did not land', v_missing;
  END IF;
END $$;

-- ── re-force the sources, and force the list ──
ALTER TABLE worker_attribution FORCE ROW LEVEL SECURITY;
ALTER TABLE referral_pending_claims FORCE ROW LEVEL SECURITY;
ALTER TABLE worker_referred_jobs FORCE ROW LEVEL SECURITY;

-- ── CATALOG self-check, AFTER the re-force ──
-- pg_class, pg_policy and the ACL are not filtered by RLS, so these are the
-- assertions that are both meaningful and readable here.
DO $$
DECLARE
  v_table  TEXT;
  v_role   TEXT;
  v_priv   TEXT;
  v_body   TEXT;
  v_column TEXT;
BEGIN
  -- An un-force this file failed to reverse would leave the flags different
  -- from the reviewed schema.
  FOREACH v_table IN ARRAY ARRAY['worker_attribution', 'referral_pending_claims', 'worker_referred_jobs'] LOOP
    IF NOT EXISTS (
      SELECT 1
        FROM pg_catalog.pg_class rel
        JOIN pg_catalog.pg_namespace n ON n.oid = rel.relnamespace
       WHERE n.nspname = 'public' AND rel.relname = v_table
         AND rel.relrowsecurity AND rel.relforcerowsecurity
    ) THEN
      RAISE EXCEPTION 'migration 103: % lost RLS ENABLE + FORCE', v_table;
    END IF;
  END LOOP;

  FOREACH v_role IN ARRAY ARRAY['jale_admin', 'jale_whatsapp'] LOOP
    FOREACH v_priv IN ARRAY ARRAY['SELECT', 'INSERT', 'UPDATE'] LOOP
      IF NOT pg_catalog.has_table_privilege(v_role, 'public.worker_referred_jobs', v_priv) THEN
        RAISE EXCEPTION 'migration 103: % lacks % on worker_referred_jobs', v_role, v_priv;
      END IF;
    END LOOP;
  END LOOP;

  -- jale_admin's DELETE is the owner's, which the two CASCADE foreign keys
  -- run on (see header). Nobody else may delete or truncate.
  IF (SELECT pg_catalog.pg_get_userbyid(relowner) FROM pg_catalog.pg_class
       WHERE oid = 'public.worker_referred_jobs'::regclass) <> 'jale_admin' THEN
    RAISE EXCEPTION 'migration 103: worker_referred_jobs must be owned by jale_admin';
  END IF;
  IF pg_catalog.has_table_privilege('jale_whatsapp', 'public.worker_referred_jobs', 'DELETE') THEN
    RAISE EXCEPTION 'migration 103: jale_whatsapp must not hold DELETE on worker_referred_jobs';
  END IF;
  IF EXISTS (
    SELECT 1
      FROM pg_catalog.pg_class c
      CROSS JOIN LATERAL pg_catalog.aclexplode(c.relacl) acl
     WHERE c.oid = 'public.worker_referred_jobs'::regclass
       AND acl.grantee <> c.relowner
       AND acl.privilege_type IN ('DELETE', 'TRUNCATE')
  ) THEN
    RAISE EXCEPTION 'migration 103: a role other than the owner holds DELETE or TRUNCATE on worker_referred_jobs';
  END IF;

  -- Exactly the two policies: each FOR ALL, each naming its one role, each
  -- keyed on that role's GUC in both USING and WITH CHECK. The only other
  -- policies accepted are the reviewed copies of these two that a later
  -- migration adds for a dedicated login, by exact name (<policy>__api,
  -- <policy>__dg); that migration proves each copy matches its source.
  IF (SELECT count(*) FROM pg_catalog.pg_policy
       WHERE polrelid = 'public.worker_referred_jobs'::regclass
         AND polname IN ('worker_referred_jobs_owner', 'worker_referred_jobs_whatsapp')) <> 2 THEN
    RAISE EXCEPTION 'migration 103: worker_referred_jobs must carry both of its policies';
  END IF;
  IF EXISTS (
    SELECT 1
      FROM pg_catalog.pg_policy
     WHERE polrelid = 'public.worker_referred_jobs'::regclass
       AND polname NOT IN ('worker_referred_jobs_owner', 'worker_referred_jobs_whatsapp',
                           'worker_referred_jobs_owner__api', 'worker_referred_jobs_owner__dg',
                           'worker_referred_jobs_whatsapp__api', 'worker_referred_jobs_whatsapp__dg')
  ) THEN
    RAISE EXCEPTION 'migration 103: worker_referred_jobs carries a policy other than its two and their reviewed copies';
  END IF;
  IF NOT EXISTS (
    SELECT 1
      FROM pg_catalog.pg_policy p
     WHERE p.polrelid = 'public.worker_referred_jobs'::regclass
       AND p.polname = 'worker_referred_jobs_owner'
       AND p.polcmd = '*' AND p.polpermissive
       AND p.polroles = ARRAY[(SELECT oid FROM pg_catalog.pg_roles WHERE rolname = 'jale_admin')]
       AND position('app.current_user_id' IN pg_catalog.pg_get_expr(p.polqual, p.polrelid)) > 0
       AND position('app.current_user_id' IN pg_catalog.pg_get_expr(p.polwithcheck, p.polrelid)) > 0
  ) THEN
    RAISE EXCEPTION 'migration 103: worker_referred_jobs_owner must be FOR ALL TO jale_admin, keyed on app.current_user_id';
  END IF;
  IF NOT EXISTS (
    SELECT 1
      FROM pg_catalog.pg_policy p
     WHERE p.polrelid = 'public.worker_referred_jobs'::regclass
       AND p.polname = 'worker_referred_jobs_whatsapp'
       AND p.polcmd = '*' AND p.polpermissive
       AND p.polroles = ARRAY[(SELECT oid FROM pg_catalog.pg_roles WHERE rolname = 'jale_whatsapp')]
       AND position('app.current_internal_user_id' IN pg_catalog.pg_get_expr(p.polqual, p.polrelid)) > 0
       AND position('app.current_internal_user_id' IN pg_catalog.pg_get_expr(p.polwithcheck, p.polrelid)) > 0
  ) THEN
    RAISE EXCEPTION 'migration 103: worker_referred_jobs_whatsapp must be FOR ALL TO jale_whatsapp, keyed on app.current_internal_user_id';
  END IF;

  -- Repair 3a: the one allowed first-touch change is first_job_id -> NULL,
  -- every other first_* column is still compared, and the trigger is still
  -- bound to the function.
  SELECT regexp_replace(p.prosrc, '\s+', ' ', 'g') INTO v_body
    FROM pg_catalog.pg_proc p
   WHERE p.oid = 'public.worker_attribution_reject_first_touch_change()'::regprocedure;
  IF position('OR (NEW.first_job_id IS DISTINCT FROM OLD.first_job_id AND NOT (OLD.first_job_id IS NOT NULL AND NEW.first_job_id IS NULL))' IN v_body) = 0
     OR position('restrict_violation' IN v_body) = 0 THEN
    RAISE EXCEPTION 'migration 103: worker_attribution_reject_first_touch_change must allow only first_job_id -> NULL';
  END IF;
  FOREACH v_column IN ARRAY ARRAY['first_share_code', 'first_channel', 'first_referrer_worker_id',
                                  'first_referrer_employer_id', 'first_seen_at'] LOOP
    IF position(format('NEW.%s IS DISTINCT FROM OLD.%s', v_column, v_column) IN v_body) = 0 THEN
      RAISE EXCEPTION 'migration 103: worker_attribution_reject_first_touch_change must allow only first_job_id -> NULL (% is no longer guarded)', v_column;
    END IF;
  END LOOP;
  IF NOT EXISTS (
    SELECT 1
      FROM pg_catalog.pg_trigger t
     WHERE t.tgrelid = 'public.worker_attribution'::regclass
       AND t.tgname = 'worker_attribution_first_touch_immutable'
       AND t.tgfoid = 'public.worker_attribution_reject_first_touch_change()'::regprocedure
       AND NOT t.tgisinternal
       AND t.tgenabled = 'O'
       AND (t.tgtype::int & 1) = 1    -- FOR EACH ROW
       AND (t.tgtype::int & 2) = 2    -- BEFORE
       AND (t.tgtype::int & 16) = 16  -- UPDATE
  ) THEN
    RAISE EXCEPTION 'migration 103: worker_attribution_first_touch_immutable trigger is not bound as BEFORE UPDATE FOR EACH ROW';
  END IF;

  -- Repair 3b: claimed_worker_id carries exactly one foreign key, to users,
  -- ON DELETE CASCADE, and the coherence CHECK is still there.
  IF (SELECT count(*)
        FROM pg_catalog.pg_constraint c
       WHERE c.conrelid = 'public.referral_pending_claims'::regclass
         AND c.contype = 'f'
         AND c.conkey = ARRAY[(SELECT a.attnum FROM pg_catalog.pg_attribute a
                                WHERE a.attrelid = 'public.referral_pending_claims'::regclass
                                  AND a.attname = 'claimed_worker_id')]) <> 1
     OR NOT EXISTS (
       SELECT 1
         FROM pg_catalog.pg_constraint c
        WHERE c.conrelid = 'public.referral_pending_claims'::regclass
          AND c.conname = 'referral_pending_claims_claimed_worker_id_fkey'
          AND c.contype = 'f'
          AND c.confrelid = 'public.users'::regclass
          AND c.confdeltype = 'c'
     ) THEN
    RAISE EXCEPTION 'migration 103: referral_pending_claims.claimed_worker_id must have exactly one foreign key, to users ON DELETE CASCADE';
  END IF;
  IF NOT EXISTS (
    SELECT 1
      FROM pg_catalog.pg_constraint c
     WHERE c.conrelid = 'public.referral_pending_claims'::regclass
       AND c.conname = 'referral_pending_claims_claimed_coherent'
       AND c.contype = 'c'
  ) THEN
    RAISE EXCEPTION 'migration 103: referral_pending_claims_claimed_coherent is missing';
  END IF;
  IF NOT EXISTS (
    SELECT 1
      FROM pg_catalog.pg_attribute a
      JOIN pg_catalog.pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
     WHERE a.attrelid = 'public.referral_pending_claims'::regclass
       AND a.attname = 'earlier_job_ids'
       AND NOT a.attisdropped
       AND a.attnotnull
       AND a.atttypid = 'uuid[]'::regtype
       AND pg_catalog.pg_get_expr(d.adbin, d.adrelid) = '''{}''::uuid[]'
  ) THEN
    RAISE EXCEPTION 'migration 103: referral_pending_claims.earlier_job_ids must be a NOT NULL uuid[] defaulting to empty';
  END IF;
END $$;

COMMIT;
