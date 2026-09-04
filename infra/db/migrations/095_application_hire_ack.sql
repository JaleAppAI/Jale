-- 095_application_hire_ack.sql
-- Run manually AFTER 094_sprint24_data_backfills.sql
-- Connect as jale_admin (NOT the RDS master user).
--
-- Forward-only (ADR-005). ONE transaction. Three nullable columns on
-- job_applications, one backfill of the rows that are ALREADY hired, and one
-- column-scoped UPDATE grant for the role the worker's own API runs as.
--
-- ── WHAT THIS IS FOR ──────────────────────────────────────────────────────
-- A worker who gets hired now sees a celebration on the web: a modal once,
-- then a dismissible banner. Both pieces of "already seen this" state have to
-- live SERVER-side or the modal re-fires on every device the worker signs in
-- from, so the three columns are:
--
--   hired_at       when the application became 'hired'. Written by the
--                  employer's own status update (lambda/api/
--                  employer-application-status-update.ts) as
--                  COALESCE(hired_at, now()), so an un-hire/re-hire keeps the
--                  FIRST hire date and cannot re-trigger a celebration.
--   hired_seen_at  the celebration modal has been shown.
--   hired_ack_at   the banner has been dismissed.
--
-- ── DEPLOY ORDER: apply BEFORE the code deploy ────────────────────────────
-- Unlike 094 (order-free), this file adds columns the new code SELECTs by
-- name: worker-applications-list.ts projects all three and
-- worker-application-details.ts UPDATEs two of them. Deployed first, the code
-- would raise 42703 on every /worker/applications request. Applied first, the
-- OLD code is unaffected -- it names none of these columns -- so the window
-- between the two is safe in that direction only.
--
-- One consequence of that window is deliberate: an employer who hires
-- somebody after this file lands but before the code deploy leaves a hired row
-- with a NULL hired_at (nothing writes it yet). The list endpoint reads
-- COALESCE(hired_at, updated_at) for exactly that reason, so such a worker
-- still gets their celebration rather than silently losing it.
--
-- ── NO RETROACTIVE CELEBRATION ────────────────────────────────────────────
-- Every row that is ALREADY 'hired' when this runs is stamped on all THREE
-- columns from its own updated_at. hired_seen_at and hired_ack_at are what
-- matter: a worker hired three weeks ago must not be congratulated by the
-- deploy. updated_at is the closest thing the schema has to "when this became
-- hired" (015/019/091 all move the status through this same column), and its
-- exact value is cosmetic here -- what the celebration keys on is the pair of
-- non-NULL acknowledgement stamps.
--
-- ── WHY THE BACKFILL NEEDS THE UN-FORCE (the 028/094 pattern) ─────────────
-- job_applications is ENABLE + FORCE ROW LEVEL SECURITY (003_jobs_and_
-- applications.sql:98-99). FORCE is the part that matters: it makes the table
-- OWNER obey its policies too. jale_admin owns this table AND is the role
-- migrations run as, and every applicable policy is keyed on a GUC
-- (applications_worker_select / applications_employer_select on
-- app.current_user_id, jobapp_whatsapp_* on app.current_internal_user_id).
-- With no GUC set they all evaluate `= NULL`, which matches NO row -- so a
-- bulk UPDATE here would rewrite ZERO rows and report success. That is the
-- silent no-op 094's header measures, and the reason this file follows the
-- same shape 028_job_messaging_hardening.sql set (028:38-62): NO FORCE,
-- backfill, FORCE. `row_security = off` is NOT an alternative -- it is a
-- no-op for a FORCEd owner and a known trap in this repo.
--
-- ── THE set_updated_at SIDE EFFECT (accepted, not hidden) ─────────────────
-- 003:51-53 (recreated by 019:55-57) puts an UNCONDITIONAL
-- `BEFORE UPDATE ... EXECUTE FUNCTION set_updated_at()` trigger on this
-- table, so the backfill below MOVES updated_at to now() on every row it
-- touches. The SET expressions still read the OLD value, so hired_at gets the
-- historical timestamp -- only the row's own updated_at advances. That is
-- accepted rather than worked around:
--   * 028 does exactly the same thing to job_conversations (025:74-76 carries
--     the identical trigger) and does not disable it;
--   * nothing sweeps, orders or dedupes on job_applications.updated_at except
--     lib/application-stage-notify.ts's dedupe key, for which a NEWER stamp
--     is strictly more permissive (it can only admit a later notification,
--     never suppress one);
--   * DISABLE TRIGGER would trade a cosmetic drift for a far worse failure
--     mode -- an un-reversed disable is permanent, silent loss of updated_at
--     maintenance for every writer of the table.
-- `status` is deliberately NOT in the UPDATE's SET list, which is what keeps
-- 091's job_applications_hire_requirements_guard and 023's
-- job_applications_hired_count_sync (both `UPDATE OF status` triggers) from
-- firing: this file must not re-run the hire gate or re-sync jobs.workers_hired
-- for hires that happened months ago.
--
-- ── GRANTS ────────────────────────────────────────────────────────────────
-- The worker's own door runs as jale_whatsapp, because 028's
-- jobapp_whatsapp_update is the ONLY worker-scoped UPDATE policy on this table
-- (see the header of lambda/api/worker-application-details.ts). That role's
-- write authority is column-scoped by convention (028: status, updated_at;
-- 073: application_answers; 091: prompt_answers, details_completed_at), so
-- this file grants it hired_seen_at and hired_ack_at and NOTHING else.
-- hired_at is left ungranted on purpose: it is the employer's claim about
-- when the hire happened, and a worker who could rewrite it could forge their
-- own hire date. The self-check below asserts BOTH halves of that.
--
-- No read grant is needed or wanted: 004_whatsapp.sql:22 gives jale_whatsapp
-- a TABLE-level (table-wide SELECT) privilege on job_applications, and a
-- table-level privilege covers columns added later -- the same reasoning
-- 065:34-35 spells out for jobs. The check below proves it rather than
-- assuming it. jale_admin, the role the list endpoint runs as, holds
-- table-level SELECT/INSERT/UPDATE from 003:77 for the same reason.
--
-- ── LOCK WINDOW ───────────────────────────────────────────────────────────
-- ALTER TABLE ... [NO] FORCE ROW LEVEL SECURITY takes ACCESS EXCLUSIVE on
-- job_applications and this transaction holds it until COMMIT, as does the
-- ADD COLUMN itself. Every read and write of the table -- so effectively every
-- logged-in worker request, every employer applicant list and every WhatsApp
-- turn -- blocks for the duration. The three ADD COLUMNs are metadata-only
-- (nullable, no default, so no table rewrite on PostgreSQL 11+) and the
-- backfill is one seq scan over the hired rows, but apply this in a
-- low-traffic window.
--
-- ── IDEMPOTENCE ───────────────────────────────────────────────────────────
-- Re-applying this file is a no-op: ADD COLUMN IF NOT EXISTS (the convention
-- 017/077/090/091 follow), a backfill gated on `hired_at IS NULL`, and a GRANT
-- that is already held. The deploy path does not depend on that --
-- run-migrations.sh keeps a ledger (public.schema_migrations) and skips a file
-- it already records -- so idempotence here is a safety property that makes a
-- --force-replay and a hand re-apply through the bastion both safe.
--
-- ── WHERE THE SELF-CHECKS LIVE, AND WHY ───────────────────────────────────
-- The DATA assertion runs while RLS is still un-forced. It has to: once FORCE
-- is back on, jale_admin's own SELECTs obey the same GUC-keyed policies and
-- return zero rows, so a data check placed after the re-force can never fail
-- no matter how broken the backfill was. The CATALOG and PRIVILEGE assertions
-- are the opposite -- pg_class and the privilege catalogs are not filtered by
-- RLS, and asserting FORCE before the re-force would assert the wrong value.

BEGIN;

-- ── the three columns ──────────────────────────────────────────
-- Nullable, no default. NULL is load-bearing: on hired_at it means "not
-- hired" (or, for the deploy window above, "hired by the old code"), and on
-- the two acknowledgement columns it means "not seen / not dismissed yet",
-- which is exactly what makes the celebration fire once.
ALTER TABLE job_applications
  ADD COLUMN IF NOT EXISTS hired_at      TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS hired_seen_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS hired_ack_at  TIMESTAMPTZ;

-- ── un-force so the backfill can SEE and WRITE every row ──
ALTER TABLE job_applications NO FORCE ROW LEVEL SECURITY;

DO $$
DECLARE
  v_stamped INTEGER;
  v_bad     INTEGER;
BEGIN
  -- Pre-existing hires: stamped, and PRE-ACKNOWLEDGED. All three columns from
  -- the row's own updated_at (the SET expressions read the OLD row, so the
  -- set_updated_at trigger firing on this same statement cannot contaminate
  -- them). `hired_at IS NULL` is both the "not yet stamped" filter and the
  -- idempotence gate.
  UPDATE job_applications
     SET hired_at      = updated_at,
         hired_seen_at = updated_at,
         hired_ack_at  = updated_at
   WHERE status = 'hired'
     AND hired_at IS NULL;
  GET DIAGNOSTICS v_stamped = ROW_COUNT;
  RAISE NOTICE 'migration 095: pre-existing hired applications stamped and pre-acknowledged: %', v_stamped;

  -- ── DATA self-check, WHILE STILL UN-FORCED ─────────────────
  -- The one invariant the celebration depends on: at COMMIT time no hired row
  -- is missing its hired_at, so the list endpoint's COALESCE fallback can only
  -- ever fire for a hire made AFTER this file ran -- never for a historical
  -- one, which is what "no retroactive celebration" means.
  --
  -- Deliberately NOT asserted: "no non-hired row carries a hire timestamp".
  -- An employer may legitimately move a hired application back to talking or
  -- rejected, which leaves a stamped row with a non-hired status -- an
  -- assertion on that would make a later --force-replay of this file fail on
  -- perfectly correct data.
  SELECT count(*) INTO v_bad
    FROM job_applications
   WHERE status = 'hired'
     AND hired_at IS NULL;
  IF v_bad > 0 THEN
    RAISE EXCEPTION 'migration 095: % hired application(s) still carry a NULL hired_at -- the backfill did not land', v_bad;
  END IF;
END $$;

-- ── restore the tenant boundary ──
ALTER TABLE job_applications FORCE ROW LEVEL SECURITY;

-- ── the worker's write authority: those two columns, nothing else ──
GRANT UPDATE (hired_seen_at, hired_ack_at) ON job_applications TO jale_whatsapp;

-- ── CATALOG + PRIVILEGE self-checks, AFTER the re-force ──
DO $$
DECLARE
  v_col TEXT;
BEGIN
  -- An un-force this file failed to reverse would be a permanent, silent hole
  -- in a tenant boundary: worth its own check even though the statement above
  -- is three lines up.
  IF NOT EXISTS (
    SELECT 1
      FROM pg_catalog.pg_class rel
      JOIN pg_catalog.pg_namespace n ON n.oid = rel.relnamespace
     WHERE n.nspname = 'public' AND rel.relname = 'job_applications'
       AND rel.relrowsecurity AND rel.relforcerowsecurity
  ) THEN
    RAISE EXCEPTION 'migration 095: job_applications lost RLS ENABLE + FORCE';
  END IF;

  -- The two writable columns, checked BOTH ways: has_column_privilege is what
  -- the planner actually consults, and information_schema.column_privileges is
  -- what an operator reads -- a table-level grant shows up expanded per column
  -- there, so a disagreement between the two would mean the grant landed
  -- somewhere other than where it looks like it did.
  FOREACH v_col IN ARRAY ARRAY['hired_seen_at', 'hired_ack_at'] LOOP
    IF NOT has_column_privilege('jale_whatsapp', 'public.job_applications', v_col, 'UPDATE') THEN
      RAISE EXCEPTION 'migration 095: jale_whatsapp missing UPDATE grant on job_applications.%', v_col;
    END IF;
    IF NOT EXISTS (
      SELECT 1 FROM information_schema.column_privileges
       WHERE grantee = 'jale_whatsapp' AND table_schema = 'public'
         AND table_name = 'job_applications' AND column_name = v_col
         AND privilege_type = 'UPDATE'
    ) THEN
      RAISE EXCEPTION 'migration 095: jale_whatsapp missing UPDATE grant on job_applications.% (information_schema)', v_col;
    END IF;
  END LOOP;

  -- ...and the column that must stay read-only for that role. A worker who
  -- could rewrite this could forge their own hire date.
  IF has_column_privilege('jale_whatsapp', 'public.job_applications', 'hired_at', 'UPDATE') THEN
    RAISE EXCEPTION 'migration 095: jale_whatsapp can UPDATE job_applications.hired_at -- only the employer status update may set it';
  END IF;

  -- All three must be READABLE by that role (004's table-level privilege,
  -- which covers columns added later). Proven, not assumed: this is the check
  -- that would catch a future migration narrowing that grant to a column list.
  FOREACH v_col IN ARRAY ARRAY['hired_at', 'hired_seen_at', 'hired_ack_at'] LOOP
    IF NOT has_column_privilege('jale_whatsapp', 'public.job_applications', v_col, 'SELECT') THEN
      RAISE EXCEPTION 'migration 095: jale_whatsapp cannot SELECT job_applications.%', v_col;
    END IF;
    IF NOT has_column_privilege('jale_admin', 'public.job_applications', v_col, 'SELECT') THEN
      RAISE EXCEPTION 'migration 095: jale_admin cannot SELECT job_applications.%', v_col;
    END IF;
  END LOOP;
END $$;

COMMIT;
