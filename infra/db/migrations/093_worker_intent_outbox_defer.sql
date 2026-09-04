-- Defer-without-counting for the 043 worker_intent outbox transport.
-- Run manually AFTER 092_onboarding_cleanup_drops.sql
-- Connect as jale_admin (NOT the RDS master user).
--
-- Forward-only (ADR-005). ONE transaction, purely additive: it creates one
-- SECURITY DEFINER function and touches no table, grant, policy or existing
-- routine. 043's three RPCs are left exactly as they are and are re-checked
-- at the bottom of this file.
--
-- ── DEPLOY ORDER: APPLY THIS MIGRATION *BEFORE* DEPLOYING THE CODE ──
-- The 090/091 rule, not 092's. `drainWorkerIntentOutbox` starts calling
-- defer_worker_intent_outbox as soon as the new Lambda code is live, and a
-- call to a function that does not exist yet is a 42883 that fails the whole
-- drain -- including the rows that would have sent fine.
--
-- ── WHY A THIRD OUTCOME EXISTS ──
-- 043 gave a leased worker_intent row two ends: complete (sent) or fail
-- (ambiguous -> terminal send_unknown, definite -> backoff, terminal 'failed'
-- at attempt 5). Both spend the attempt budget, which is correct when the
-- failure is about THIS send.
--
-- On 2026-09-04 two employer-triggered notifications died to Twilio 63016 --
-- "freeform message outside the 24-hour session window". The four
-- `application_*` Content templates were still PENDING Meta approval, so the
-- sender had no ContentSid and fell back to a plain body, which Meta refuses
-- outside the window. Nothing about the row was wrong; the template simply
-- was not approved yet. Retrying five times over ~an hour burned the budget
-- against a condition that only a Meta review changes, and the worker never
-- heard that an employer wanted to hire them.
--
-- So: a third outcome that RESCHEDULES without counting. The caller decides
-- when the failure is of that class (see the 63016 + `application_` branch in
-- lambda/whatsapp/lib/outbox.ts); this function only enforces the two limits
-- that must not live in application code:
--
--   * the 48-hour ceiling. Budget-neutral retrying is unbounded by
--     construction, so age -- not attempt count -- is what makes it stop. A
--     row older than 48h goes terminally 'failed' with the caller's reason,
--     because a two-day-old "the employer wants your details" is not worth
--     delivering and an outbox that never gives up is an outbox nobody reads.
--   * the fence. Same as fail_worker_intent_outbox: the lease token must
--     match AND the lease must not have expired. Token-only would let a
--     drain whose 15-minute lease already lapsed -- and whose delivery state
--     is therefore UNKNOWN, which is exactly why 043 never requeues an
--     expired lease -- push the row back to 'pending' and resend it.
--
-- ── WHY THE PENDING BRANCH REFUNDS attempt_count ──
-- Leaving attempt_count alone is NOT budget-neutral, and getting this wrong
-- is the whole bug in miniature. 043 charges the attempt at LEASE time --
-- `attempt_count = o.attempt_count + 1` inside its claimed CTE -- not at
-- failure time. So a defer that merely declines to increment still leaves the
-- lease's +1 on the row, and 043's own sweep
-- (`status = 'pending' AND attempt_count >= 5` -> 'failed', re-evaluated on
-- every lease call) would end the row after the FIFTH hourly retry, roughly
-- five hours in. The 48-hour ceiling below would never be reached and the
-- function would be a slower spelling of fail_worker_intent_outbox.
--
-- Hence `GREATEST(attempt_count - 1, 0)` on the pending branch: it refunds
-- the increment this lease just charged, so the row returns to the counter it
-- carried before the deferred send and the budget really is untouched.
-- GREATEST clamps at zero so a hand-edited or legacy row can never go
-- negative (attempt_count has no CHECK of its own). The counter therefore
-- means "attempts that COUNTED", which is what the five-attempt cap is about.
--
-- The 48h-expired branch does NOT refund: that row is terminal, the counter
-- is evidence for whoever asks why the notification never arrived, and
-- rewinding it would erase the last attempt from the record.
--
-- BOTH lease columns are nulled on BOTH branches. 043's
-- whatsapp_outbox_worker_intent_lease_consistency CHECK admits a set token
-- only alongside a set deadline AND status = 'send_unknown', so clearing one
-- of the pair (or leaving the pair set while moving to 'pending') is a 23514
-- rather than a defer.
BEGIN;

CREATE OR REPLACE FUNCTION public.defer_worker_intent_outbox(
  p_id UUID, p_lease_token UUID, p_error TEXT, p_delay_seconds INTEGER
)
RETURNS BOOLEAN
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE v_updated INTEGER;
BEGIN
  -- A NULL or absurd delay is a caller bug, and a definer must never guess on
  -- one: 22023 is what 043's lease function raises for the same class.
  IF p_id IS NULL OR p_lease_token IS NULL OR p_delay_seconds IS NULL
     OR p_delay_seconds < 1 OR p_delay_seconds > 86400 THEN
    RAISE EXCEPTION 'invalid worker intent deferral' USING ERRCODE = '22023';
  END IF;

  UPDATE public.whatsapp_outbox
     SET status = CASE
           WHEN created_at < pg_catalog.now() - interval '48 hours' THEN 'failed'
           ELSE 'pending' END,
         next_attempt_at = CASE
           WHEN created_at < pg_catalog.now() - interval '48 hours' THEN NULL
           ELSE pg_catalog.now()
                + pg_catalog.make_interval(secs => p_delay_seconds) END,
         -- Refund the +1 that lease_worker_intent_outbox charged when it
         -- claimed this row. Without it the five-attempt cap ends the row
         -- after ~5 hourly retries and the 48h ceiling never applies. The
         -- terminal branch keeps the attempt as evidence.
         attempt_count = CASE
           WHEN created_at < pg_catalog.now() - interval '48 hours' THEN attempt_count
           ELSE GREATEST(attempt_count - 1, 0) END,
         last_error = LEFT(COALESCE(p_error, 'worker intent send deferred'), 1000),
         worker_intent_lease_token = NULL,
         worker_intent_leased_until = NULL
   WHERE id = p_id
     AND source_type = 'worker_intent'
     AND status = 'send_unknown'
     AND worker_intent_lease_token = p_lease_token
     AND worker_intent_leased_until > pg_catalog.now();
  GET DIAGNOSTICS v_updated = ROW_COUNT;
  RETURN v_updated = 1;
END $$;
ALTER FUNCTION public.defer_worker_intent_outbox(UUID, UUID, TEXT, INTEGER) OWNER TO jale_admin;
REVOKE ALL ON FUNCTION public.defer_worker_intent_outbox(UUID, UUID, TEXT, INTEGER) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.defer_worker_intent_outbox(UUID, UUID, TEXT, INTEGER) TO jale_whatsapp;

-- ── Self-verifying end state (082/091/092 precedent) ──
-- The RDS side of this repo has no post-apply assertion step, so the file has
-- to be its own. Everything below is a catalog or ACL fact, which is exactly
-- the class that a typecheck and a mocked pool are both blind to.
DO $$
DECLARE
  v_oid OID;
  v_rpc TEXT;
BEGIN
  SELECT p.oid INTO v_oid
    FROM pg_catalog.pg_proc p
    JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public'
     AND p.proname = 'defer_worker_intent_outbox'
     AND pg_catalog.pg_get_function_identity_arguments(p.oid)
         = 'uuid, uuid, text, integer';
  IF v_oid IS NULL THEN
    RAISE EXCEPTION 'migration 093: defer_worker_intent_outbox is missing';
  END IF;

  -- Not merely present: the drain reaches this row through a role that holds
  -- no UPDATE on a worker_intent row at all, so an INVOKER-rights function
  -- here is a silent zero-row UPDATE (a SQL SUCCESS) on every call.
  IF NOT (SELECT p.prosecdef FROM pg_catalog.pg_proc p WHERE p.oid = v_oid) THEN
    RAISE EXCEPTION 'migration 093: defer_worker_intent_outbox must be SECURITY DEFINER';
  END IF;

  IF NOT pg_catalog.has_function_privilege('jale_whatsapp', v_oid, 'EXECUTE') THEN
    RAISE EXCEPTION 'migration 093: jale_whatsapp cannot execute defer_worker_intent_outbox';
  END IF;

  -- grantee = 0 is the PUBLIC pseudo-role. A definer that PUBLIC can execute
  -- hands every login role a write path into the outbox.
  IF EXISTS (
    SELECT 1
      FROM pg_catalog.pg_proc p,
           pg_catalog.aclexplode(p.proacl) a
     WHERE p.oid = v_oid AND a.grantee = 0 AND a.privilege_type = 'EXECUTE'
  ) THEN
    RAISE EXCEPTION 'migration 093: PUBLIC can still execute defer_worker_intent_outbox';
  END IF;

  -- This file ADDS a fourth outcome; it replaces none of 043's three. A
  -- CREATE OR REPLACE typo that changed one of their signatures would leave
  -- an orphaned overload behind and break the drain at runtime, not here.
  FOREACH v_rpc IN ARRAY ARRAY[
    'public.lease_worker_intent_outbox(integer)',
    'public.complete_worker_intent_outbox(uuid, uuid, text)',
    'public.fail_worker_intent_outbox(uuid, uuid, text, boolean)'
  ] LOOP
    IF pg_catalog.to_regprocedure(v_rpc) IS NULL THEN
      RAISE EXCEPTION 'migration 093: 043 RPC % disappeared', v_rpc;
    END IF;
  END LOOP;
END $$;

COMMIT;
