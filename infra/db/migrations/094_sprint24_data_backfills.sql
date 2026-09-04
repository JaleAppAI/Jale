-- 094_sprint24_data_backfills.sql
-- Run manually AFTER 093_worker_intent_outbox_defer.sql
-- Connect as jale_admin (NOT the RDS master user).
--
-- Forward-only (ADR-005). ONE transaction. This file writes DATA only: no
-- table, column, index, policy, grant, role or routine is created, altered or
-- dropped, and the two RLS flips it makes are reversed before it commits.
--
-- ── DEPLOY ORDER: independent of the code deploy ──
-- Unlike 090/091 (apply BEFORE the code) and 092 (apply AFTER it), 094 can be
-- applied on either side of the sprint-24 release. Nothing here adds or
-- removes an object any Lambda references; it only rewrites rows the running
-- code already reads and writes correctly in both their old and new shapes:
--   * step A removes four answer keys. The engine reads `answers` through
--     hasOwnProperty (lambda/lib/application-requirements.ts), so a removed
--     key simply means the question is asked again for this job -- which is
--     the intended behaviour on BOTH the old and the new code.
--   * step B rewrites a trade into the pair lambda/lib/trade-canonical.ts now
--     produces at every write site. On the CUSTOM branch this is invisible to
--     the old code, which stored raw text and reads it back unchanged, so a
--     canonical name is just another string to it.
--     The STANDARD branch is a real change of meaning, not just of spelling:
--     main_trade moves off 'other' onto the enum key and main_trade_other is
--     cleared, so job matching starts treating that worker as a standard
--     trade. That is the intended D4 end state and is an improvement on both
--     the old and the new code -- a worker who typed 'electricista' SHOULD
--     match electrician jobs -- which is why the ordering is still free. It is
--     not, however, a no-op for readers of main_trade, so if the release is
--     being staged, prefer applying this AFTER the code deploy.
-- Apply it in a low-traffic window either way -- see the lock note below.
--
-- ── WHY THIS IS A MIGRATION AND NOT A SCRIPT ──
-- Both backfills were originally sprint-24 operator scripts. They cannot
-- work as scripts against production:
--   * `users` is ENABLE + FORCE ROW LEVEL SECURITY (002_rls_policies.sql) and
--     its only UPDATE policy, users_isolation_update, is keyed on
--     `cognito_sub = current_setting('app.current_user_id', true)`. FORCE
--     means the table OWNER obeys that policy too, so jale_admin with no GUC
--     set matches NULL, which matches no row. The trade backfill in
--     scripts/backfill-trade-canonical.ts therefore updates ZERO rows against
--     production and reports success -- a silent no-op, which is why that
--     script is now labelled inspection/dry-run only.
--   * `worker_application_defaults` is the same shape (079 ENABLE + FORCE,
--     policies keyed on app.current_user_id / app.current_internal_user_id).
-- Measured on the sprint-24 testbed as jale_admin, one matching row: visible
-- un-forced = 1, visible after re-FORCE with no GUC = 0.
--
-- So this follows the pattern 028_job_messaging_hardening.sql set for exactly
-- this problem (028 lines 38-62): NO FORCE, backfill, FORCE. `row_security =
-- off` is NOT an alternative -- it is a no-op for a FORCEd owner and a known
-- trap in this repo.
--
-- ── LOCK WINDOW ──
-- ALTER TABLE ... [NO] FORCE ROW LEVEL SECURITY takes ACCESS EXCLUSIVE on the
-- table, and this transaction holds it on BOTH `users` and
-- `worker_application_defaults` until COMMIT. Every read and write to either
-- table -- so effectively every logged-in request and every WhatsApp turn --
-- blocks for the duration. The two UPDATEs are seq scans over small tables,
-- but apply this in a low-traffic window.
--
-- ── STEP A: per-application answers must not cross employers (decision D2) ──
-- The 2026-09-04T04:41:58Z incident: a worker's application reached an
-- employer carrying answers they had given to a DIFFERENT company. The four
-- keys below are the `per_application` half of FIELD_REUSE_POLICY
-- (lambda/lib/job-fields.ts): date_available and desired_pay are quoted
-- against one posting, worked_here_before is meaningless outside one
-- employer, and emergency_contact is a THIRD party's name and phone. The code
-- fix stops NEW ones being saved; this removes the ones already stored.
--
-- The `stable` half (work_authorization, date_of_birth, home_address,
-- education, military_service, work_history, references) is legitimately
-- reusable and is left completely alone.
--
-- The jsonb `-` operator REMOVES a key. Setting it to null would leave it
-- present, and the engine's hasOwnProperty test would still read it as
-- answered -- the question would never be re-asked.
--
-- ── STEP B: canonical worker trades (decision D4) ──
-- Reproduces scripts/backfill-trade-canonical.ts's --apply behaviour exactly:
-- resolve every custom trade string through the bilingual trade_aliases cache
-- (060) and rewrite it to the pair lambda/lib/trade-canonical.ts produces.
--
-- TWO DELIBERATE DIVERGENCES from canonicalizeWorkerTrade():
--   1. An UNRESOLVED trade is left completely untouched. The TS fallback
--      returns tidyTradeText(raw) (trimmed, whitespace collapsed, first
--      letter upper-cased). Cosmetically rewriting text the alias cache has
--      not learned yet gains nothing and loses the worker's exact words, and
--      lambda/ai/alias-generator.ts may still learn that trade -- after which
--      a re-apply of this file canonicalises it properly.
--   2. The SQL normalizer mirrors normalizeProfession for PRECOMPOSED
--      Latin-1 input only (see the translate() note in the chain below).
--
-- ── IDEMPOTENCE ──
-- Re-applying this file is a no-op that reports 0 rows on both steps: step A
-- is gated on `answers ?| array[...]` and step B on two explicit
-- IS DISTINCT FROM clauses, which is also what gives it exact parity with
-- classifyBackfillRow's `changed` flag in the script.
--
-- The deploy path does not depend on that: run-migrations.sh keeps a ledger
-- (public.schema_migrations) and skips a file it already records, so a normal
-- run never re-applies this one -- only `--force-replay` does. The idempotence
-- above is therefore a safety property, not the mechanism, and it is what
-- makes a --force-replay and a hand re-apply through the bastion both safe.
-- Verified on the sprint-24 testbed: applied 1/4/4 rows, replayed 0/0/0.
--
-- ── WHERE THE SELF-CHECKS LIVE, AND WHY ──
-- The DATA assertions run while RLS is still un-forced. They have to: once
-- FORCE is back on, jale_admin's own SELECTs obey the same GUC-keyed policies
-- and return zero rows, so a data check placed after the re-force can never
-- fail no matter how broken the backfill was. The CATALOG assertion is the
-- opposite -- it reads pg_class, which RLS does not filter, and it must run
-- AFTER the re-force to be asserting the right value.

BEGIN;

-- ── un-force both tables so the backfill can SEE and WRITE every row ──
ALTER TABLE worker_application_defaults NO FORCE ROW LEVEL SECURITY;
ALTER TABLE users NO FORCE ROW LEVEL SECURITY;

DO $$
DECLARE
  v_defaults       INTEGER;
  v_trade_standard INTEGER;
  v_trade_custom   INTEGER;
  v_bad            INTEGER;
BEGIN
  -- ── STEP A ──────────────────────────────────────────────────
  UPDATE worker_application_defaults
     SET answers = answers - 'date_available' - 'desired_pay'
                           - 'worked_here_before' - 'emergency_contact',
         -- 079 gives this column no trigger: every writer sets it explicitly.
         updated_at = now()
   WHERE jsonb_typeof(answers) = 'object'
     AND answers ?| array['date_available','desired_pay','worked_here_before','emergency_contact'];
  GET DIAGNOSTICS v_defaults = ROW_COUNT;
  RAISE NOTICE 'migration 094 step A: worker_application_defaults rows stripped of per-application answers: %', v_defaults;

  -- ── STEP B ──────────────────────────────────────────────────
  -- RETURNING off the FROM side gives the standard/custom split without a
  -- second pass over the chain (which would be a second, drift-prone copy).
  WITH candidate AS (
    -- normalizeProfession() (lambda/lib/profession.ts) in SQL, in its order:
    -- accents folded, then [-./] to a space, then whitespace collapsed, then
    -- trimmed. The translate() pair MUST stay the same length -- translate
    -- pairs its arguments positionally and silently drops the overflow, so one
    -- extra target character shifts every later mapping onto the wrong letter.
    -- The 24 sources are the precomposed Latin-1 letters a Spanish or French
    -- trade name actually carries; a caller that sends an already-DECOMPOSED
    -- string keeps its combining mark here, fails to resolve, and its row is
    -- left untouched -- the safe direction.
    SELECT u.id,
           btrim(regexp_replace(regexp_replace(translate(lower(u.main_trade_other),
                    'áéíóúàèìòùâêîôûäëïöüãñõç', 'aeiouaeiouaeiouaeiouanoc'),
                  '[-./]', ' ', 'g'), '\s+', ' ', 'g')) AS norm,
           u.main_trade_other AS current_other
      FROM users u
     -- The exact candidate filter SELECT_DISTINCT_TRADES uses in
     -- scripts/backfill-trade-canonical.ts.
     WHERE u.main_trade = 'other'
       AND btrim(coalesce(u.main_trade_other, '')) <> ''
  ),
  resolved AS (
    -- resolveTradeAlias(): trade_key or a pre-normalized member of aliases,
    -- then ONE retry with a trailing plural 's' stripped (length > 3 only, so
    -- 'as' -> 'a' stays noise). left(x, -1) drops the last character.
    --
    -- DISTINCT ON + the CASE in ORDER BY is what makes this deterministic. The
    -- TS side does two SEQUENTIAL lookups, so a direct hit always beats the
    -- singular retry; a single SQL join sees both at once. 060's seeds have no
    -- cross-row alias collision, but lambda/ai/alias-generator.ts inserts rows
    -- at runtime and could create one -- and on a colliding alias the TS side's
    -- own unordered LIMIT 1 is arbitrary, so exact parity there is undefined
    -- and this picks the lower trade_key rather than whatever the planner
    -- happened to emit.
    SELECT DISTINCT ON (c.id)
           c.id, c.current_other, a.canonical_es, a.trade_category
      FROM candidate c
      JOIN trade_aliases a
        ON a.trade_key = c.norm
        OR c.norm = ANY(a.aliases)
        OR (length(c.norm) > 3 AND c.norm LIKE '%s'
            AND (a.trade_key = left(c.norm, -1) OR left(c.norm, -1) = ANY(a.aliases)))
     ORDER BY c.id,
              CASE WHEN a.trade_key = c.norm OR c.norm = ANY(a.aliases) THEN 0 ELSE 1 END,
              a.trade_key
  ),
  target AS (
    -- Decision D4, and standardTradeKeyForCategory() exactly: a trade_category
    -- maps back to a main_trade key only when the category IS that key. The
    -- five below are TRADE_KEYS minus 'other' (lambda/lib/worker-vocab.ts) and
    -- also the 004_whatsapp.sql main_trade CHECK list minus 'other'. Categories
    -- like drywall or general_labor are valid jobs.trade_category values with
    -- NO main_trade counterpart, so those trades stay custom -- writing one
    -- would be a 23514 on the CHECK.
    --
    -- Standard: the enum key fully describes the trade, so the free-text column
    -- is cleared and no stale spelling survives beside it.
    -- Custom: canonical_es replaces whatever the worker typed. It is NOT NULL
    -- but not non-blank, so a blank falls back to the row's current text --
    -- mirroring `canonical || tidied` in canonicalizeWorkerTrade, and keeping
    -- chk_trade_other (004) satisfied, which rejects 'other' with a NULL name.
    SELECT r.id,
           CASE WHEN r.trade_category IN ('electrician','plumber','carpenter','concrete','painting')
                  THEN r.trade_category
                ELSE 'other' END AS new_main_trade,
           CASE WHEN r.trade_category IN ('electrician','plumber','carpenter','concrete','painting')
                  THEN NULL
                ELSE coalesce(nullif(btrim(r.canonical_es), ''), r.current_other) END
             AS new_main_trade_other
      FROM resolved r
  ),
  upd AS (
    UPDATE users u
       SET main_trade = t.new_main_trade,
           main_trade_other = t.new_main_trade_other
      FROM target t
     WHERE u.id = t.id
       -- Two explicit clauses, so a row whose pair is ALREADY canonical is
       -- not touched. This is what makes a re-apply report 0 rows, and it is
       -- exactly classifyBackfillRow's `changed` flag.
       AND (u.main_trade IS DISTINCT FROM t.new_main_trade
            OR u.main_trade_other IS DISTINCT FROM t.new_main_trade_other)
    RETURNING t.new_main_trade AS landed
  )
  SELECT count(*) FILTER (WHERE landed <> 'other'),
         count(*) FILTER (WHERE landed = 'other')
    INTO v_trade_standard, v_trade_custom
    FROM upd;
  RAISE NOTICE 'migration 094 step B: users rows moved onto a standard trade key: %', v_trade_standard;
  RAISE NOTICE 'migration 094 step B: users rows given a canonical custom trade name: %', v_trade_custom;

  -- ── DATA self-checks, WHILE STILL UN-FORCED ─────────────────
  SELECT count(*) INTO v_bad
    FROM worker_application_defaults
   WHERE jsonb_typeof(answers) = 'object'
     AND answers ?| array['date_available','desired_pay','worked_here_before','emergency_contact'];
  IF v_bad > 0 THEN
    RAISE EXCEPTION 'migration 094: worker_application_defaults still holds % row(s) carrying a per-application answer key', v_bad;
  END IF;

  -- Re-runs the SAME chain and asserts nothing is left to change: no custom
  -- trade still resolves to a standard category, and no resolved custom trade
  -- still carries a non-canonical name. A check that re-derived the rule
  -- differently would prove nothing about the UPDATE above.
  WITH candidate AS (
    -- normalizeProfession() (lambda/lib/profession.ts) in SQL, in its order:
    -- accents folded, then [-./] to a space, then whitespace collapsed, then
    -- trimmed. The translate() pair MUST stay the same length -- translate
    -- pairs its arguments positionally and silently drops the overflow, so one
    -- extra target character shifts every later mapping onto the wrong letter.
    -- The 24 sources are the precomposed Latin-1 letters a Spanish or French
    -- trade name actually carries; a caller that sends an already-DECOMPOSED
    -- string keeps its combining mark here, fails to resolve, and its row is
    -- left untouched -- the safe direction.
    SELECT u.id,
           btrim(regexp_replace(regexp_replace(translate(lower(u.main_trade_other),
                    'áéíóúàèìòùâêîôûäëïöüãñõç', 'aeiouaeiouaeiouaeiouanoc'),
                  '[-./]', ' ', 'g'), '\s+', ' ', 'g')) AS norm,
           u.main_trade_other AS current_other
      FROM users u
     -- The exact candidate filter SELECT_DISTINCT_TRADES uses in
     -- scripts/backfill-trade-canonical.ts.
     WHERE u.main_trade = 'other'
       AND btrim(coalesce(u.main_trade_other, '')) <> ''
  ),
  resolved AS (
    -- resolveTradeAlias(): trade_key or a pre-normalized member of aliases,
    -- then ONE retry with a trailing plural 's' stripped (length > 3 only, so
    -- 'as' -> 'a' stays noise). left(x, -1) drops the last character.
    --
    -- DISTINCT ON + the CASE in ORDER BY is what makes this deterministic. The
    -- TS side does two SEQUENTIAL lookups, so a direct hit always beats the
    -- singular retry; a single SQL join sees both at once. 060's seeds have no
    -- cross-row alias collision, but lambda/ai/alias-generator.ts inserts rows
    -- at runtime and could create one -- and on a colliding alias the TS side's
    -- own unordered LIMIT 1 is arbitrary, so exact parity there is undefined
    -- and this picks the lower trade_key rather than whatever the planner
    -- happened to emit.
    SELECT DISTINCT ON (c.id)
           c.id, c.current_other, a.canonical_es, a.trade_category
      FROM candidate c
      JOIN trade_aliases a
        ON a.trade_key = c.norm
        OR c.norm = ANY(a.aliases)
        OR (length(c.norm) > 3 AND c.norm LIKE '%s'
            AND (a.trade_key = left(c.norm, -1) OR left(c.norm, -1) = ANY(a.aliases)))
     ORDER BY c.id,
              CASE WHEN a.trade_key = c.norm OR c.norm = ANY(a.aliases) THEN 0 ELSE 1 END,
              a.trade_key
  ),
  target AS (
    -- Decision D4, and standardTradeKeyForCategory() exactly: a trade_category
    -- maps back to a main_trade key only when the category IS that key. The
    -- five below are TRADE_KEYS minus 'other' (lambda/lib/worker-vocab.ts) and
    -- also the 004_whatsapp.sql main_trade CHECK list minus 'other'. Categories
    -- like drywall or general_labor are valid jobs.trade_category values with
    -- NO main_trade counterpart, so those trades stay custom -- writing one
    -- would be a 23514 on the CHECK.
    --
    -- Standard: the enum key fully describes the trade, so the free-text column
    -- is cleared and no stale spelling survives beside it.
    -- Custom: canonical_es replaces whatever the worker typed. It is NOT NULL
    -- but not non-blank, so a blank falls back to the row's current text --
    -- mirroring `canonical || tidied` in canonicalizeWorkerTrade, and keeping
    -- chk_trade_other (004) satisfied, which rejects 'other' with a NULL name.
    SELECT r.id,
           CASE WHEN r.trade_category IN ('electrician','plumber','carpenter','concrete','painting')
                  THEN r.trade_category
                ELSE 'other' END AS new_main_trade,
           CASE WHEN r.trade_category IN ('electrician','plumber','carpenter','concrete','painting')
                  THEN NULL
                ELSE coalesce(nullif(btrim(r.canonical_es), ''), r.current_other) END
             AS new_main_trade_other
      FROM resolved r
  )
  SELECT count(*) INTO v_bad
    FROM target t
    JOIN users u ON u.id = t.id
   WHERE u.main_trade IS DISTINCT FROM t.new_main_trade
      OR u.main_trade_other IS DISTINCT FROM t.new_main_trade_other;
  IF v_bad > 0 THEN
    RAISE EXCEPTION 'migration 094: users rows still resolve to a different canonical trade pair (% row(s)) -- step B did not land', v_bad;
  END IF;
END $$;

-- ── restore the tenant boundary on both tables ──
ALTER TABLE users FORCE ROW LEVEL SECURITY;
ALTER TABLE worker_application_defaults FORCE ROW LEVEL SECURITY;

-- ── CATALOG self-check, AFTER the re-force ──
-- pg_class is not filtered by RLS, so this is the one assertion that is both
-- meaningful and readable here. An un-force this file failed to reverse would
-- be a permanent, silent hole in a tenant boundary: worth its own check even
-- though the statements above are two lines up.
DO $$
DECLARE
  v_table TEXT;
BEGIN
  FOREACH v_table IN ARRAY ARRAY['users', 'worker_application_defaults'] LOOP
    IF NOT EXISTS (
      SELECT 1
        FROM pg_catalog.pg_class rel
        JOIN pg_catalog.pg_namespace n ON n.oid = rel.relnamespace
       WHERE n.nspname = 'public' AND rel.relname = v_table
         AND rel.relrowsecurity AND rel.relforcerowsecurity
    ) THEN
      RAISE EXCEPTION 'migration 094: % lost RLS ENABLE + FORCE', v_table;
    END IF;
  END LOOP;
END $$;

COMMIT;
