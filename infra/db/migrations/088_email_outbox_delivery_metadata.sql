-- ============================================================
-- 088_email_outbox_delivery_metadata.sql
-- Run manually AFTER 087_bind_reuses_ready_web_worker.sql
-- Connect as: jale_admin (NOT the RDS master user)
--
-- DEPLOY ORDER (REVERSE of migration 086's rule): apply THIS migration BEFORE
-- deploying the Release-3 code. lib/email-outbox.ts names `headers` and
-- `ses_message_id` unconditionally in queueEmail / the claim query / the
-- finalize UPDATE, and queueEmail is shared with the billing pause emails --
-- code-first is a total outbound-email outage (42703 undefined_column on every
-- send) until this file lands. Applying first is safe: the old code never
-- reads the new columns.
--
-- SEQUENCING NOTE. This file was written as 087 and renumbered to 088 when
-- release 2 claimed that slot for 087_bind_reuses_ready_web_worker.sql (a fix
-- to 047's bind function). 087 does NOT exist on this branch, so the
-- registration points here list 086 -> 088 with a gap; the gap closes when the
-- two releases integrate, and 087 must be inserted BEFORE this file in all of
-- them at that point. Nothing in this migration depends on 087 -- disjoint
-- objects, either order applies cleanly -- so the ordering matters only for
-- the numbering invariant, not for correctness.
--
-- There are FIVE registration points, not the four usually quoted:
--   1  scripts/run-migrations.sh                              MIGRATIONS array
--   2  scripts/run-migrations.ps1                             $Migrations list
--   3  infra/test/unit/db/migrations.test.ts                  number sequence
--   4  infra/test/unit/db/migrations/apply-order.test.ts      baseline list
--   5  infra/test/unit/scripts/run-migrations-sh.test.ts      compares (1) to
--      the on-disk directory. It extracts the list with
--      /\d{3}b?_[a-zA-Z0-9_]+\.sql/g over the whole block, so a COMMENT that
--      names a migration file reads as a list entry and fails the comparison
--      -- which is why the gap comments here and in (1)-(4) say "migration
--      087" in prose rather than naming the file.
--
-- Next free migration after this one: 089.
--
-- Sprint 22 release 3, employer emails phase 4. Two parts:
--
--   Part 1  email_outbox learns what SES did with a row. `ses_message_id`
--           is the provider's own identifier for the accepted message, and
--           `headers` is the small JSONB bag of per-row header material the
--           sweeper needs at MIME-build time (today: `unsubscribe_url`, for
--           RFC 8058 List-Unsubscribe / List-Unsubscribe-Post).
--
--   Part 2  public.disable_digest_for_employer(uuid) -- the SECURITY DEFINER
--           the new SES bounce/complaint handler calls to switch an
--           employer's daily digest off after a PERMANENT bounce or a
--           complaint, and to invalidate every unsubscribe link already
--           mailed to the dead address.
--
-- Forward-only. Applied manually via bastion (ADR-005), connected as
-- jale_admin (NOT the RDS master user) -- same convention as 082/085/086.
--
-- ============================================================
-- Part 1 -- email_outbox delivery metadata
-- ============================================================
--
-- WHY ses_message_id IS THE JOIN KEY, AND WHY IT IS THE ONLY ONE
--
-- An SES bounce/complaint notification carries `mail.messageId` and nothing
-- else that identifies OUR row: the notification's own address list is the
-- envelope, not our primary key. Persisting the MessageId that SendEmail
-- returns is therefore the whole mechanism -- 037 threw it away
-- (email-outbox.ts discarded the response), so until now a bounce was
-- unattributable.
--
-- UNIQUE, but partial: every row that has NOT been handed to SES has NULL
-- here, and NULLs never collide in a btree, so the partial predicate exists
-- purely to keep the index off the (large, permanent) NULL population rather
-- than to permit duplicates. A second row claiming an id SES already issued
-- to another row is a bug we want to hear about as a 23505, not a silent
-- mis-attribution of somebody else's bounce.
--
-- WHY headers IS JSONB AND NOT COLUMNS
--
-- The sweeper is generic (billing pause mail and digest mail share it), and
-- only the digest producer has an unsubscribe URL to contribute. A dedicated
-- `unsubscribe_url` column would be NULL for every billing row and would have
-- to be joined by another ALTER the next time a producer needs a header. The
-- CHECK pins the shape to a JSON OBJECT -- `'[]'::jsonb`, `'null'::jsonb` and
-- `'"x"'::jsonb` are all legal JSONB values and all useless to a MIME builder
-- that is about to do `headers->>'unsubscribe_url'`. The length cap is there
-- because this ends up inside an SMTP header block: a megabyte of JSON in a
-- row would produce a message SES rejects at send time, which is a far worse
-- place to find out than at INSERT time.
--
-- THE SWEEP INDEX / MAX_EMAIL_SEND_ATTEMPTS RECONCILIATION
--
-- 037:32 hardcodes `attempt_count < 5` into email_outbox_sweeper_idx while
-- lambda/lib/email-outbox.ts binds MAX_EMAIL_SEND_ATTEMPTS into the claim
-- query. The two are NOT in conflict today: the constant is also 5, so the
-- index predicate and the query predicate select exactly the same rows and
-- the partial index is usable for the claim scan. Recreating the index with a
-- different bound, or moving the constant, would CHANGE which rows the
-- sweeper retries in production -- so this migration deliberately changes
-- NEITHER. What it adds is the missing enforcement: the 088 integration suite
-- reads pg_get_indexdef() and asserts the literal in the index equals the
-- TypeScript constant, so the next person who edits one side is stopped by a
-- red test instead of by a silent full-table scan (or, worse, an index that
-- hides rows the sweeper still wants).
--
-- GRANTS
--
-- Deliberately none that are new. 037 grants `SELECT, UPDATE ON email_outbox
-- TO jale_admin` at TABLE level, and a table-level grant covers columns added
-- later -- so the sweeper (BillingStack's EmailOutboxSweeperLambda, which
-- connects with appDbSecret = jale_admin) can write ses_message_id, and the
-- bounce handler (also jale_admin, and covered by 037's
-- email_outbox_admin_select USING (true)) can read it back with no RLS GUC
-- set. The GRANT below is re-issued verbatim so the intent is written down at
-- the point the columns appear, and so the self-audit has something to assert
-- against; it is a no-op on a cluster that already ran 037.
--
-- jale_billing keeps the table-wide SELECT, INSERT 037 gave it, which now
-- formally includes the two new columns. That is not a privilege escalation
-- worth a column-level carve-out: its INSERTs are already fenced to
-- source_type = 'billing_pause' by email_outbox_billing_insert, PostgreSQL
-- cannot revoke a single column out of a table-level grant anyway, and the
-- worst a compromised billing producer could do with `headers` is mail itself
-- a List-Unsubscribe header on its own message.

BEGIN;

ALTER TABLE email_outbox
  ADD COLUMN IF NOT EXISTS ses_message_id TEXT,
  ADD COLUMN IF NOT EXISTS headers        JSONB;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_class rel ON rel.oid = c.conrelid
    WHERE rel.relname = 'email_outbox'
      AND c.conname = 'email_outbox_ses_message_id_shape'
  ) THEN
    ALTER TABLE email_outbox
      ADD CONSTRAINT email_outbox_ses_message_id_shape
      CHECK (ses_message_id IS NULL OR length(ses_message_id) BETWEEN 1 AND 255);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_class rel ON rel.oid = c.conrelid
    WHERE rel.relname = 'email_outbox'
      AND c.conname = 'email_outbox_headers_object'
  ) THEN
    ALTER TABLE email_outbox
      ADD CONSTRAINT email_outbox_headers_object
      CHECK (
        headers IS NULL
        OR (jsonb_typeof(headers) = 'object' AND length(headers::text) <= 4000)
      );
  END IF;
END;
$$;

CREATE UNIQUE INDEX IF NOT EXISTS email_outbox_ses_message_id_unique
  ON email_outbox (ses_message_id)
  WHERE ses_message_id IS NOT NULL;

-- Bounce triage by address, for PEOPLE. Nothing in the code path uses it: the
-- handler's only lookup is by ses_message_id (the unique index above), and it
-- never reads `users` at all -- it goes straight from the outbox row's
-- source_id to the definer. This index exists for the query an operator runs
-- with psql after a bounce report -- "what else did we send this address, and
-- did any of it land?" -- which without it is a seq scan over the whole
-- outbox, a table that only ever grows.
--
-- lower() because the address an operator pastes out of a bounce notification
-- or a support thread rarely matches the stored casing, and an expression
-- index is the only way that query uses an index at all. It does NOT make the
-- column case-insensitive for any other purpose; the local part of an address
-- is case-sensitive per RFC 5321, which is why this is a triage aid and not a
-- uniqueness or matching rule.
CREATE INDEX IF NOT EXISTS email_outbox_recipient_email_idx
  ON email_outbox (lower(recipient_email));

-- No-op re-issue of 037's grant; see the GRANTS note above.
GRANT SELECT, UPDATE ON email_outbox TO jale_admin;

-- ============================================================
-- Part 2 -- disable_digest_for_employer(uuid)
-- ============================================================
--
-- WHY A DEFINER AT ALL
--
-- employer_digest_settings is ENABLE + FORCE ROW LEVEL SECURITY (082), and
-- FORCE means the TABLE OWNER obeys policies too. The only policy that lets
-- jale_admin touch a row is employer_digest_settings_self, which resolves
-- app.current_user_id to a cognito_sub. The bounce handler has no session and
-- no sub -- it has an SES notification -- so a plain UPDATE from it matches
-- zero rows and, because an RLS-filtered UPDATE that hits nothing raises
-- NOTHING, it would fail SILENTLY. That is the exact shape of bug the digest
-- producer's `digest_watermark_not_advanced` guard exists to catch.
--
-- WHY BY EMPLOYER ID AND NOT BY EMAIL ADDRESS
--
-- The obvious signature is disable_digest_for_email(text): take the bounced
-- address, find the user, switch them off. It is the wrong one here, twice
-- over.
--
--   1. It cannot be implemented without ALSO widening jale_admin's read of
--      `users`. There is no policy on users that lets jale_admin look a row
--      up by email (002's is by cognito_sub, 038's needs an applicant
--      relationship), so an email-keyed definer would need a second
--      GUC-gated policy on the PII table itself.
--   2. It is less accurate. email_outbox rows written by the digest producer
--      carry source_type = 'employer_digest' and source_id = the employer's
--      users.id (employer-digest-producer.ts passes it directly). That is a
--      recorded fact about the message that bounced; re-deriving the employer
--      from the address is a guess that goes wrong the moment an employer
--      changes their email between send and bounce, and that silently hits
--      the WRONG account if two accounts ever share an address.
--
-- So the handler reads source_type/source_id off the outbox row it already
-- had to fetch by ses_message_id, refuses anything that is not
-- 'employer_digest', and passes the employer id here. No users read, no
-- address matching, one new GUC, one table.
--
-- WHY THE POLICIES BELOW ARE PERMISSIVE, AND WHAT THAT COSTS
--
-- PostgreSQL ORs permissive policies together, so
-- employer_digest_settings_delivery_feedback_{select,update} do not narrow
-- employer_digest_settings_self -- they ADD a second way in, available to ANY
-- jale_admin session that sets app.digest_feedback_employer_id. Every
-- jale_admin session is our own Lambda code, and the pinning happens inside
-- the definer (which restores the previous value before returning), so the
-- practical reachable surface is "code that calls this function". That is the
-- same posture 086 Part 2 took for the web onboarding door, and it is stated
-- here rather than left to be discovered: this is a defence-in-depth
-- boundary, not a hard one. The hard part is the GRANT -- nothing but
-- jale_admin can execute the function, and nothing but jale_admin holds
-- UPDATE on the table.
--
-- Unset GUC => current_setting(..., true) is NULL => `employer_id::text =
-- NULL` is NULL => not true => no row qualifies. The policies fail CLOSED by
-- construction, and 088's integration suite asserts it with a direct UPDATE
-- from jale_admin with no GUCs set.
--
-- WHY BOTH A SELECT AND AN UPDATE POLICY
--
-- The UPDATE below reads columns in its WHERE clause and in the SET
-- expression, and PostgreSQL applies SELECT policies to an UPDATE that
-- references the table's columns. A FOR UPDATE policy alone would pass the
-- update check and then find nothing to update. Splitting select/update
-- rather than writing one FOR ALL policy keeps INSERT and DELETE out of the
-- GUC-gated path entirely -- the same split 082 used for
-- jale_digest_enumerator.

DROP POLICY IF EXISTS employer_digest_settings_delivery_feedback_select
  ON employer_digest_settings;
CREATE POLICY employer_digest_settings_delivery_feedback_select
  ON employer_digest_settings FOR SELECT TO jale_admin
  USING (employer_id::text = current_setting('app.digest_feedback_employer_id', true));

DROP POLICY IF EXISTS employer_digest_settings_delivery_feedback_update
  ON employer_digest_settings;
CREATE POLICY employer_digest_settings_delivery_feedback_update
  ON employer_digest_settings FOR UPDATE TO jale_admin
  USING (employer_id::text = current_setting('app.digest_feedback_employer_id', true))
  WITH CHECK (employer_id::text = current_setting('app.digest_feedback_employer_id', true));

-- Returns the number of rows actually switched off: 1 the first time, 0 for
-- every repeat (SES retries a notification, and a mailbox that hard-bounces
-- once hard-bounces again on the next digest attempt). The caller treats 0 as
-- "already off", never as an error.
--
-- The `AND s.enabled` guard is what makes the repeat a no-op, and it is also
-- what bounds the version counter: unsubscribe_token_version is a SMALLINT
-- with a `>= 1` CHECK, and an unguarded +1 on every duplicate notification
-- would walk it to 32767 and then start raising 22003 in a Lambda that has no
-- business failing. LEAST() is belt-and-braces on the same bound.
--
-- Bumping the version at all is deliberate: the address is dead, so every
-- unsubscribe link already sitting in that mailbox should be dead with it.
-- (Token expiry itself remains "none by design" -- see
-- lambda/lib/unsubscribe-token.ts; the version counter IS the revocation
-- mechanism, and this is the second thing that turns it.)

CREATE OR REPLACE FUNCTION public.disable_digest_for_employer(p_employer_id UUID)
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $fn$
DECLARE
  v_prior TEXT;
  v_count INTEGER;
BEGIN
  IF p_employer_id IS NULL THEN
    RETURN 0;
  END IF;

  v_prior := pg_catalog.current_setting('app.digest_feedback_employer_id', true);
  PERFORM pg_catalog.set_config('app.digest_feedback_employer_id', p_employer_id::text, true);

  UPDATE public.employer_digest_settings s
     SET enabled = false,
         unsubscribe_token_version = LEAST(s.unsubscribe_token_version + 1, 32767)
   WHERE s.employer_id = p_employer_id
     AND s.enabled;
  GET DIAGNOSTICS v_count = ROW_COUNT;

  -- Restore before returning, exactly as 086's definers do: this function is
  -- called on an autocommit connection today, but a caller that ever wraps it
  -- in a transaction must not inherit a pinned GUC.
  PERFORM pg_catalog.set_config('app.digest_feedback_employer_id',
                                COALESCE(v_prior, ''), true);
  RETURN v_count;
END;
$fn$;

ALTER FUNCTION public.disable_digest_for_employer(UUID) OWNER TO jale_admin;
REVOKE ALL ON FUNCTION public.disable_digest_for_employer(UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.disable_digest_for_employer(UUID) TO jale_admin;

-- ============================================================
-- Self-audit. On RDS there is no Jest: this DO block is the only thing
-- standing between a half-applied 088 and a bounce handler that silently
-- does nothing.
-- ============================================================
DO $$
DECLARE
  v_col RECORD;
  v_indexdef TEXT;
  v_secdef BOOLEAN;
  v_owner NAME;
  v_config TEXT[];
  v_oid OID;
BEGIN
  ---------------------------------------------------------------- Part 1
  FOR v_col IN
    SELECT * FROM (VALUES
      ('ses_message_id', 'YES', 'text'),
      ('headers',        'YES', 'jsonb')
    ) AS t(column_name, is_nullable, data_type)
  LOOP
    IF NOT EXISTS (
      SELECT 1 FROM information_schema.columns c
      WHERE c.table_schema = 'public' AND c.table_name = 'email_outbox'
        AND c.column_name = v_col.column_name
        AND c.is_nullable = v_col.is_nullable
        AND c.data_type = v_col.data_type
    ) THEN
      RAISE EXCEPTION 'migration 088: email_outbox.% missing, or not (%, %)',
        v_col.column_name, v_col.is_nullable, v_col.data_type;
    END IF;
  END LOOP;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c JOIN pg_class rel ON rel.oid = c.conrelid
    WHERE rel.relname = 'email_outbox' AND c.contype = 'c'
      AND c.conname = 'email_outbox_headers_object'
  ) THEN
    RAISE EXCEPTION 'migration 088: email_outbox_headers_object CHECK missing';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c JOIN pg_class rel ON rel.oid = c.conrelid
    WHERE rel.relname = 'email_outbox' AND c.contype = 'c'
      AND c.conname = 'email_outbox_ses_message_id_shape'
  ) THEN
    RAISE EXCEPTION 'migration 088: email_outbox_ses_message_id_shape CHECK missing';
  END IF;

  SELECT pg_get_indexdef(i.indexrelid) INTO v_indexdef
    FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid
   WHERE c.relname = 'email_outbox_ses_message_id_unique' AND i.indisunique;
  IF v_indexdef IS NULL THEN
    RAISE EXCEPTION 'migration 088: email_outbox_ses_message_id_unique missing or not UNIQUE';
  END IF;
  IF v_indexdef NOT LIKE '%WHERE (ses_message_id IS NOT NULL)%' THEN
    RAISE EXCEPTION 'migration 088: email_outbox_ses_message_id_unique is not the partial index (%)',
      v_indexdef;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_class c WHERE c.relname = 'email_outbox_recipient_email_idx'
  ) THEN
    RAISE EXCEPTION 'migration 088: email_outbox_recipient_email_idx missing';
  END IF;

  -- The reconciliation this migration promises but does not silently change.
  SELECT pg_get_indexdef(i.indexrelid) INTO v_indexdef
    FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid
   WHERE c.relname = 'email_outbox_sweeper_idx';
  IF v_indexdef IS NULL OR v_indexdef NOT LIKE '%attempt_count < 5%' THEN
    RAISE EXCEPTION 'migration 088: email_outbox_sweeper_idx no longer bounds attempt_count < 5, '
      'which is what lambda/lib/email-outbox.ts MAX_EMAIL_SEND_ATTEMPTS binds (%)', v_indexdef;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_privileges
    WHERE grantee = 'jale_admin' AND table_schema = 'public'
      AND table_name = 'email_outbox' AND privilege_type = 'UPDATE'
  ) OR NOT EXISTS (
    SELECT 1 FROM information_schema.table_privileges
    WHERE grantee = 'jale_admin' AND table_schema = 'public'
      AND table_name = 'email_outbox' AND privilege_type = 'SELECT'
  ) THEN
    RAISE EXCEPTION 'migration 088: jale_admin lost SELECT/UPDATE on email_outbox';
  END IF;

  ---------------------------------------------------------------- Part 2
  IF NOT EXISTS (
    SELECT 1 FROM pg_policy p JOIN pg_class rel ON rel.oid = p.polrelid
    WHERE rel.relname = 'employer_digest_settings'
      AND p.polname = 'employer_digest_settings_delivery_feedback_select'
      AND p.polcmd::TEXT = 'r'
      AND p.polroles = ARRAY[(SELECT oid FROM pg_roles WHERE rolname = 'jale_admin')]
  ) THEN
    RAISE EXCEPTION 'migration 088: the delivery-feedback SELECT policy is missing or not scoped to jale_admin';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_policy p JOIN pg_class rel ON rel.oid = p.polrelid
    WHERE rel.relname = 'employer_digest_settings'
      AND p.polname = 'employer_digest_settings_delivery_feedback_update'
      AND p.polcmd::TEXT = 'w'
      AND p.polroles = ARRAY[(SELECT oid FROM pg_roles WHERE rolname = 'jale_admin')]
      AND p.polwithcheck IS NOT NULL
  ) THEN
    RAISE EXCEPTION 'migration 088: the delivery-feedback UPDATE policy is missing, not scoped to jale_admin, '
      'or has no WITH CHECK';
  END IF;

  SELECT f.oid, owner.rolname, f.prosecdef, f.proconfig
    INTO v_oid, v_owner, v_secdef, v_config
    FROM pg_proc f
    JOIN pg_namespace n ON n.oid = f.pronamespace
    JOIN pg_roles owner ON owner.oid = f.proowner
   WHERE n.nspname = 'public' AND f.proname = 'disable_digest_for_employer';
  IF NOT FOUND
     OR v_owner <> 'jale_admin'
     OR NOT v_secdef
     OR v_config IS DISTINCT FROM ARRAY['search_path=pg_catalog, pg_temp']::TEXT[] THEN
    RAISE EXCEPTION 'migration 088: disable_digest_for_employer definer invariant failed '
      '(owner=%, secdef=%, config=%)', v_owner, v_secdef, v_config;
  END IF;

  IF EXISTS (
    SELECT 1 FROM pg_proc f,
      LATERAL aclexplode(COALESCE(f.proacl, acldefault('f', f.proowner))) acl
    WHERE f.oid = v_oid AND acl.grantee = 0 AND acl.privilege_type = 'EXECUTE'
  ) THEN
    RAISE EXCEPTION 'migration 088: disable_digest_for_employer is EXECUTE-able by PUBLIC';
  END IF;

  IF NOT has_function_privilege('jale_admin', v_oid, 'EXECUTE') THEN
    RAISE EXCEPTION 'migration 088: jale_admin cannot execute disable_digest_for_employer';
  END IF;

  -- Smoke: a random uuid owns no settings row, so the function must report 0
  -- rather than raise -- and must leave no GUC behind.
  IF public.disable_digest_for_employer('00000000-0000-4000-8000-000000000000'::uuid) <> 0 THEN
    RAISE EXCEPTION 'migration 088 smoke: disable_digest_for_employer claimed to disable an impossible employer';
  END IF;
  IF COALESCE(current_setting('app.digest_feedback_employer_id', true), '') <> '' THEN
    RAISE EXCEPTION 'migration 088 smoke: disable_digest_for_employer leaked its GUC';
  END IF;
END;
$$;

COMMIT;
