-- ============================================================
-- 127_company_billing.sql
-- Run manually AFTER 126_job_conversations_whatsapp_update_columns.sql
-- and 119_employer_org_owner_access.sql (PR #105),
-- connected as jale_admin. Forward-only (ADR-005). ONE transaction.
--
-- Employer organizations, Phase 2 milestone A, part 1
-- (docs/superpowers/specs/2026-10-15-employer-organizations-design.md,
-- "Billing and limits"). A company pays one subscription. Until now
-- billing_customers and subscriptions were keyed by the paying user only;
-- their organization_id columns (034) were never written.
--
-- (1) STAMPING. public.billing_stamp_organization(), a jale_admin definer,
--     runs BEFORE INSERT and BEFORE UPDATE OF organization_id, user_id on
--     both tables. On INSERT it reads the payer's membership behind the
--     gated jale_admin policy organization_members_trigger_read
--     (app.org_trigger_read, which it opens and closes around its one
--     read), fills a missing organization_id with the payer's company, and
--     refuses (42501): a value that is not the payer's company, a payer
--     with no company, and a billing_customers payer who is not the
--     company's active owner. On UPDATE it reads nothing and refuses
--     (42501) any change of user_id and any change of an organization_id
--     once set. The Lambdas running when this is applied insert without
--     organization_id; the trigger makes those inserts correct. The
--     section opens with LOCK TABLE on both tables IN ACCESS EXCLUSIVE
--     MODE, held until COMMIT, so no billing row is read or written
--     between the back-fill and SET NOT NULL, and no weaker lock is
--     upgraded later.
-- (2) BACK-FILL. Each existing row gets its payer's (user_id's) company.
--     After 118 and 119's catch-up every employer owns a one-person company,
--     so the payer is that company's owner. jale_admin reads and writes the
--     two tables through two temporary gated policies (app.billing_org_
--     backfill), dropped again before COMMIT, reads memberships through
--     118's app.org_bootstrap gate, and reads the payers' user_type (for
--     the refusal details) through 089's users_admin_analytics_read
--     (app.admin_analytics_read), as 100 reuses 089's gate. The back-fill's
--     UPDATEs take the trigger's UPDATE branch, which reads no membership,
--     so the trigger's read policy can wait for section 6. Fail-closed,
--     before and after the UPDATEs: a payer with no company (counted per
--     table), a Stripe customer whose payer is not the company's active
--     owner, a row that already names another company, a company with two
--     Stripe customers or two current subscriptions each stop the migration
--     with the count, and a DETAIL naming up to 20 of the payers (user_id
--     and user_type; the company too for the duplicates).
-- (3) CONSTRAINTS. organization_id NOT NULL on both tables; one Stripe
--     customer per company (billing_customers_one_per_organization); the
--     one-current-subscription rule moves from the user to the company
--     (subscriptions_one_current_per_organization, 034's predicate;
--     subscriptions_one_current_per_user is dropped); a plain index on
--     subscriptions.organization_id for the company reads. subscription_
--     status_history is unchanged: every history row names its
--     subscription, whose organization_id is now NOT NULL and never changes.
-- (4) SEATS. billing_plans.entitlements gains foreman_seat_limit
--     (employer_free 0, employer_pro 3) through a temporary UPDATE policy,
--     as 069 seeded template_limit, then proved.
-- (5) COMPANY READ. subscriptions_org_member_read: an active member
--     (jale_api, after setRlsContext and resolveEmployerActor) reads every
--     subscription of their company, keyed on organization_id, so a foreman
--     resolves the company plan. It shows whole rows, the Stripe
--     subscription id and the billing periods included, to every active
--     member: accepted, as get-billing shows them the same plan. Stripe
--     customers stay readable by the payer only (034's billing_customers_owner).
-- (6) LAST, the membership table. The trigger's gated read policy on
--     organization_members, then the fail-closed check that every
--     employer user has a company (119's catch-up gave one to every
--     employer then; Phase 1's post-confirmation gives one to each new
--     sign-up). The count reads users through 089's existing
--     users_admin_analytics_read (app.admin_analytics_read, opened around
--     the count only); 127 creates no policy on users.
--
-- LOCKS. Every lock is held until COMMIT. Section 1 opens with LOCK TABLE
-- billing_customers, subscriptions IN ACCESS EXCLUSIVE MODE: reads and
-- writes of both wait from there. billing_plans is locked ACCESS EXCLUSIVE
-- in section 4 (CREATE POLICY). Only the remaining ACCESS EXCLUSIVE lock,
-- organization_members' (CREATE POLICY in section 6), comes last; the
-- membership and user tables are only read (ACCESS SHARE) before that.
-- lock_timeout (5s) or a deadlock (40P01) can end either side, this
-- migration or a concurrent request: both are safe to re-run. 127 is one
-- transaction and changes nothing when it fails; a request that fails
-- rolls back and can be retried (Stripe redelivers a failed webhook).
-- Apply in a quiet window (Release runbook).
--
-- DEPLOY ORDER: apply 127, 128 and 129, and let the deployed Lambdas run
-- on them before Phase 2's Lambdas deploy. They keep working: the trigger
-- stamps their inserts, and the per-company index behaves as the per-user
-- one did for one-person companies.
--
-- REPLAY: refused once billing_stamp_organization exists.
-- ============================================================
BEGIN;

SET LOCAL lock_timeout = '5s';

-- ── 0. Preconditions ────────────────────────────────────────
DO $$
BEGIN
  IF session_user <> current_user THEN
    RAISE EXCEPTION 'migration 127: connect as the migration login itself, without SET ROLE';
  END IF;
  IF to_regprocedure('public.billing_stamp_organization()') IS NOT NULL THEN
    RAISE EXCEPTION 'migration 127: already applied (public.billing_stamp_organization exists); it is not re-runnable';
  END IF;
  IF to_regclass('public.organization_members') IS NULL
     OR to_regprocedure('jale_internal.org_member_scope(text)') IS NULL THEN
    RAISE EXCEPTION 'migration 127: apply 118 first (organization_members, jale_internal.org_member_scope)';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policy WHERE polrelid = 'public.jobs'::regclass AND polname = 'jobs_org_owner_update') THEN
    RAISE EXCEPTION 'migration 127: apply 119 (PR #105) first';
  END IF;
  IF to_regclass('public.job_status_events') IS NULL THEN
    RAISE EXCEPTION 'migration 127: apply 125 first';
  END IF;
  IF to_regclass('public.subscriptions_one_current_per_user') IS NULL THEN
    RAISE EXCEPTION 'migration 127: subscriptions_one_current_per_user (034) is missing';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_attribute
              WHERE attrelid IN ('public.billing_customers'::regclass, 'public.subscriptions'::regclass)
                AND attname = 'organization_id' AND attnotnull) THEN
    RAISE EXCEPTION 'migration 127: organization_id is already NOT NULL';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_policy p
     WHERE p.polrelid = 'public.organization_members'::regclass
       AND p.polname = 'organization_members_org_bootstrap'
       AND p.polroles = ARRAY['jale_admin'::regrole::oid]
       AND pg_get_expr(p.polqual, p.polrelid) = $q$(current_setting('app.org_bootstrap'::text, true) = 'on'::text)$q$
  ) THEN
    RAISE EXCEPTION 'migration 127: organization_members_org_bootstrap (118) is missing or drifted; the back-fill could not read memberships';
  END IF;
  -- The refusal details and section 6's count read users through 089's gate
  -- policy. Pinned here (pg_policy is a catalog, so RLS never filters it):
  -- a drifted gate would read zero users and pass the count silently.
  IF NOT EXISTS (
    SELECT 1 FROM pg_policy p
     WHERE p.polrelid = 'public.users'::regclass
       AND p.polname = 'users_admin_analytics_read'
       AND p.polcmd = 'r'
       AND p.polpermissive
       AND p.polroles = ARRAY['jale_admin'::regrole::oid]
       AND pg_get_expr(p.polqual, p.polrelid) = $q$(current_setting('app.admin_analytics_read'::text, true) = 'on'::text)$q$
  ) THEN
    RAISE EXCEPTION 'migration 127: users_admin_analytics_read (089) is missing or drifted; the employer count could not read users';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policy WHERE polrelid = 'public.billing_plans'::regclass AND polname = 'billing_plans_read_all') THEN
    RAISE EXCEPTION 'migration 127: billing_plans_read_all (034) is missing; the seat seed could not be proved';
  END IF;
END $$;

-- ── 1. The stamping trigger ─────────────────────────────────
-- Both billing tables, at once and at the strongest level this migration
-- needs (section 2's CREATE POLICY), so no lock is upgraded later.
LOCK TABLE public.billing_customers, public.subscriptions IN ACCESS EXCLUSIVE MODE;

CREATE FUNCTION public.billing_stamp_organization()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $fn$
DECLARE
  v_org    UUID;
  v_role   TEXT;
  v_status TEXT;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    -- A billing row's payer never changes, and its company, once set, never
    -- changes either (only 127's back-fill fills a NULL).
    IF NEW.user_id IS DISTINCT FROM OLD.user_id THEN
      RAISE EXCEPTION '%: user_id never changes', TG_TABLE_NAME USING ERRCODE = 'insufficient_privilege';
    END IF;
    IF OLD.organization_id IS NOT NULL AND NEW.organization_id IS DISTINCT FROM OLD.organization_id THEN
      RAISE EXCEPTION '%: organization_id never changes', TG_TABLE_NAME USING ERRCODE = 'insufficient_privilege';
    END IF;
    RETURN NEW;
  END IF;

  -- INSERT. This branch runs on every webhook upsert too: INSERT ... ON
  -- CONFLICT DO UPDATE fires BEFORE INSERT on the proposed row before it
  -- finds the conflict. So it must never refuse a payer whose company is
  -- unchanged. subscriptions accept any member status by design (a payer
  -- later suspended keeps receiving webhooks); the active owner is enforced
  -- on billing_customers, where checkout starts.
  PERFORM pg_catalog.set_config('app.org_trigger_read', 'on', true);
  SELECT m.organization_id, m.role, m.status
    INTO v_org, v_role, v_status
    FROM public.organization_members m
   WHERE m.user_id = NEW.user_id;
  PERFORM pg_catalog.set_config('app.org_trigger_read', '', true);

  IF v_org IS NULL THEN
    RAISE EXCEPTION '%: the payer belongs to no company', TG_TABLE_NAME USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF TG_TABLE_NAME = 'billing_customers' AND (v_role <> 'owner' OR v_status <> 'active') THEN
    RAISE EXCEPTION 'billing_customers: only the active owner of a company pays' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF NEW.organization_id IS NULL THEN
    NEW.organization_id := v_org;
  ELSIF NEW.organization_id <> v_org THEN
    RAISE EXCEPTION '%: organization_id is not the payer''s company', TG_TABLE_NAME USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END;
$fn$;
ALTER FUNCTION public.billing_stamp_organization() OWNER TO jale_admin;
REVOKE ALL ON FUNCTION public.billing_stamp_organization() FROM PUBLIC;

CREATE TRIGGER billing_customers_stamp_organization
  BEFORE INSERT OR UPDATE OF organization_id, user_id ON public.billing_customers
  FOR EACH ROW EXECUTE FUNCTION public.billing_stamp_organization();
CREATE TRIGGER subscriptions_stamp_organization
  BEFORE INSERT OR UPDATE OF organization_id, user_id ON public.subscriptions
  FOR EACH ROW EXECUTE FUNCTION public.billing_stamp_organization();

-- ── 2. Back-fill from the payer's company ───────────────────
-- jale_admin is subject to FORCE RLS on both tables; these two policies
-- exist only for this section and are dropped at its end.
CREATE POLICY billing_customers_org_backfill ON public.billing_customers
  AS PERMISSIVE FOR ALL TO jale_admin
  USING (current_setting('app.billing_org_backfill', true) = 'on')
  WITH CHECK (current_setting('app.billing_org_backfill', true) = 'on');
CREATE POLICY subscriptions_org_backfill ON public.subscriptions
  AS PERMISSIVE FOR ALL TO jale_admin
  USING (current_setting('app.billing_org_backfill', true) = 'on')
  WITH CHECK (current_setting('app.billing_org_backfill', true) = 'on');

SELECT set_config('app.billing_org_backfill', 'on', true);
SELECT set_config('app.org_bootstrap', 'on', true);
-- 089's gate, for the payers' user_type in the refusal details only.
SELECT set_config('app.admin_analytics_read', 'on', true);

DO $$
DECLARE
  v_count        BIGINT;
  v_not_employer BIGINT;
  v_detail       TEXT;
BEGIN
  -- A payer with no company, per table. An employer payer needs a company;
  -- a payer who is not an employer (a worker) can never have one.
  SELECT count(*), count(*) FILTER (WHERE u.user_type IS DISTINCT FROM 'employer'),
         array_to_string((array_agg(DISTINCT format('%s (%s)', bc.user_id, coalesce(u.user_type, 'no user row'))))[1:20], ', ')
    INTO v_count, v_not_employer, v_detail
    FROM public.billing_customers bc
    LEFT JOIN public.users u ON u.id = bc.user_id
   WHERE NOT EXISTS (SELECT 1 FROM public.organization_members m WHERE m.user_id = bc.user_id);
  IF v_count <> 0 THEN
    RAISE EXCEPTION 'migration 127: % billing_customers rows have a payer with no company', v_count
      USING DETAIL = 'Payers (user_id, user_type; up to 20): ' || v_detail,
            HINT = concat_ws(' ',
              CASE WHEN v_count > v_not_employer THEN 'Give each employer payer a one-person company, as 119''s catch-up back-fill does.' END,
              CASE WHEN v_not_employer > 0 THEN 'A row whose payer is not an employer must be removed or re-assigned to an employer.' END,
              'Then apply again.');
  END IF;

  SELECT count(*), count(*) FILTER (WHERE u.user_type IS DISTINCT FROM 'employer'),
         array_to_string((array_agg(DISTINCT format('%s (%s)', s.user_id, coalesce(u.user_type, 'no user row'))))[1:20], ', ')
    INTO v_count, v_not_employer, v_detail
    FROM public.subscriptions s
    LEFT JOIN public.users u ON u.id = s.user_id
   WHERE NOT EXISTS (SELECT 1 FROM public.organization_members m WHERE m.user_id = s.user_id);
  IF v_count <> 0 THEN
    RAISE EXCEPTION 'migration 127: % subscriptions rows have a payer with no company', v_count
      USING DETAIL = 'Payers (user_id, user_type; up to 20): ' || v_detail,
            HINT = concat_ws(' ',
              CASE WHEN v_count > v_not_employer THEN 'Give each employer payer a one-person company, as 119''s catch-up back-fill does.' END,
              CASE WHEN v_not_employer > 0 THEN 'A row whose payer is not an employer must be removed or re-assigned to an employer.' END,
              'Then apply again.');
  END IF;

  -- The trigger's rule: only a company's active owner is its Stripe customer.
  SELECT count(*),
         array_to_string((array_agg(format('%s (%s; %s, %s in company %s)', bc.user_id, coalesce(u.user_type, 'no user row'),
                                           m.role, m.status, m.organization_id) ORDER BY bc.user_id))[1:20], ', ')
    INTO v_count, v_detail
    FROM public.billing_customers bc
    JOIN public.organization_members m ON m.user_id = bc.user_id
    LEFT JOIN public.users u ON u.id = bc.user_id
   WHERE m.role <> 'owner' OR m.status <> 'active';
  IF v_count <> 0 THEN
    RAISE EXCEPTION 'migration 127: % Stripe customers belong to a member who is not their company''s active owner', v_count
      USING DETAIL = 'Payers (user_id, user_type, membership; up to 20): ' || v_detail;
  END IF;

  SELECT count(*),
         array_to_string((array_agg(format('%s %s (%s): names company %s, payer''s company is %s', b.tbl, b.user_id,
                                           coalesce(u.user_type, 'no user row'), b.row_org, b.payer_org)
                                    ORDER BY b.user_id, b.tbl))[1:20], '; ')
    INTO v_count, v_detail
    FROM (SELECT 'billing_customers' AS tbl, bc.user_id, bc.organization_id AS row_org, m.organization_id AS payer_org
            FROM public.billing_customers bc
            JOIN public.organization_members m ON m.user_id = bc.user_id
           WHERE bc.organization_id IS NOT NULL AND bc.organization_id <> m.organization_id
          UNION ALL
          SELECT 'subscriptions', s.user_id, s.organization_id, m.organization_id
            FROM public.subscriptions s
            JOIN public.organization_members m ON m.user_id = s.user_id
           WHERE s.organization_id IS NOT NULL AND s.organization_id <> m.organization_id) b
    LEFT JOIN public.users u ON u.id = b.user_id;
  IF v_count <> 0 THEN
    RAISE EXCEPTION 'migration 127: % billing rows already name a company that is not their payer''s', v_count
      USING DETAIL = 'Rows (table, user_id, user_type, companies; up to 20): ' || v_detail;
  END IF;
END $$;

UPDATE public.billing_customers bc
   SET organization_id = m.organization_id
  FROM public.organization_members m
 WHERE m.user_id = bc.user_id
   AND bc.organization_id IS NULL;

UPDATE public.subscriptions s
   SET organization_id = m.organization_id
  FROM public.organization_members m
 WHERE m.user_id = s.user_id
   AND s.organization_id IS NULL;

DO $$
DECLARE
  v_count  BIGINT;
  v_detail TEXT;
BEGIN
  SELECT count(*),
         array_to_string((array_agg(DISTINCT format('%s %s (%s)', b.tbl, b.user_id, coalesce(u.user_type, 'no user row'))))[1:20], ', ')
    INTO v_count, v_detail
    FROM (SELECT 'billing_customers' AS tbl, user_id FROM public.billing_customers WHERE organization_id IS NULL
          UNION ALL
          SELECT 'subscriptions', user_id FROM public.subscriptions WHERE organization_id IS NULL) b
    LEFT JOIN public.users u ON u.id = b.user_id;
  IF v_count <> 0 THEN
    RAISE EXCEPTION 'migration 127: % billing rows still have no company after the back-fill', v_count
      USING DETAIL = 'Rows (table, user_id, user_type; up to 20): ' || v_detail;
  END IF;

  SELECT count(*), array_to_string((array_agg(d.line ORDER BY d.organization_id))[1:20], '; ')
    INTO v_count, v_detail
    FROM (SELECT bc.organization_id,
                 format('company %s: %s', bc.organization_id,
                        string_agg(format('%s (%s)', bc.user_id, coalesce(u.user_type, 'no user row')), ', ' ORDER BY bc.user_id)) AS line
            FROM public.billing_customers bc
            LEFT JOIN public.users u ON u.id = bc.user_id
           GROUP BY bc.organization_id
          HAVING count(*) > 1) d;
  IF v_count <> 0 THEN
    RAISE EXCEPTION 'migration 127: % companies have more than one Stripe customer', v_count
      USING DETAIL = 'Companies and their payers (user_id, user_type; up to 20 companies): ' || v_detail;
  END IF;

  SELECT count(*), array_to_string((array_agg(d.line ORDER BY d.organization_id))[1:20], '; ')
    INTO v_count, v_detail
    FROM (SELECT s.organization_id,
                 format('company %s: %s', s.organization_id,
                        string_agg(DISTINCT format('%s (%s)', s.user_id, coalesce(u.user_type, 'no user row')), ', ')) AS line
            FROM public.subscriptions s
            LEFT JOIN public.users u ON u.id = s.user_id
           WHERE s.status NOT IN ('canceled', 'incomplete_expired')
           GROUP BY s.organization_id
          HAVING count(*) > 1) d;
  IF v_count <> 0 THEN
    RAISE EXCEPTION 'migration 127: % companies have more than one current subscription', v_count
      USING DETAIL = 'Companies and their payers (user_id, user_type; up to 20 companies): ' || v_detail;
  END IF;
END $$;

SELECT set_config('app.admin_analytics_read', 'off', true);
SELECT set_config('app.org_bootstrap', 'off', true);
SELECT set_config('app.billing_org_backfill', 'off', true);

DROP POLICY billing_customers_org_backfill ON public.billing_customers;
DROP POLICY subscriptions_org_backfill ON public.subscriptions;

-- ── 3. Constraints ──────────────────────────────────────────
ALTER TABLE public.billing_customers ALTER COLUMN organization_id SET NOT NULL;
ALTER TABLE public.subscriptions ALTER COLUMN organization_id SET NOT NULL;

CREATE UNIQUE INDEX billing_customers_one_per_organization
  ON public.billing_customers (organization_id);

-- One current subscription per company across non-terminal statuses: 034's
-- rule, keyed on the company instead of the payer.
CREATE UNIQUE INDEX subscriptions_one_current_per_organization
  ON public.subscriptions (organization_id)
  WHERE status NOT IN ('canceled', 'incomplete_expired');
CREATE INDEX subscriptions_organization_idx ON public.subscriptions (organization_id);
DROP INDEX public.subscriptions_one_current_per_user;

COMMENT ON COLUMN public.billing_customers.organization_id IS
  'The company this Stripe customer pays for (127). Stamped from the payer''s membership on insert; never changes, nor does user_id. One customer per company.';
COMMENT ON COLUMN public.subscriptions.organization_id IS
  'The company this subscription entitles (127). Stamped from the payer''s membership on insert; never changes, nor does user_id. One current subscription per company.';

-- ── 4. Foreman seats in the plan catalog ────────────────────
-- billing_plans is FORCE ROW LEVEL SECURITY with SELECT-only policies (034):
-- the owner's UPDATE needs a policy (069's pattern), dropped right after.
CREATE POLICY billing_plans_seat_seed
  ON public.billing_plans FOR UPDATE TO jale_admin USING (true) WITH CHECK (true);

UPDATE public.billing_plans SET entitlements = entitlements || '{"foreman_seat_limit": 0}'::jsonb WHERE code = 'employer_free';
UPDATE public.billing_plans SET entitlements = entitlements || '{"foreman_seat_limit": 3}'::jsonb WHERE code = 'employer_pro';

DROP POLICY billing_plans_seat_seed ON public.billing_plans;

-- ── 5. Every active member reads the company's subscription ─
-- Keyed on the company. The sub-query reads the caller's own membership as
-- jale_api (118's organization_members_self_read), so it needs both caller
-- settings, as every employer handler sets them.
CREATE POLICY subscriptions_org_member_read ON public.subscriptions
  AS PERMISSIVE FOR SELECT TO jale_api
  USING (organization_id IN (SELECT m.organization_id FROM public.organization_members m
                              WHERE m.user_id = ANY ((SELECT jale_internal.org_member_scope(current_setting('app.current_internal_user_id', true)))::uuid[])));

-- ── 6. Last: organization_members (the remaining ACCESS EXCLUSIVE lock) ─
-- Opened only inside jale_admin-owned trigger functions (this migration's
-- billing_stamp_organization and 129's jobs_assignee_must_be_active),
-- around their one membership read.
CREATE POLICY organization_members_trigger_read ON public.organization_members
  AS PERMISSIVE FOR SELECT TO jale_admin
  USING (current_setting('app.org_trigger_read', true) = 'on');

-- Every employer has a company: an employer without one could neither pay
-- (the trigger refuses their Stripe customer) nor post. jale_admin reads
-- users under FORCE RLS through 089's existing users_admin_analytics_read
-- (pinned in section 0), with its gate open around this count only, and
-- memberships through 118's gate. 127 creates no policy on users.
SELECT set_config('app.org_bootstrap', 'on', true);
SELECT set_config('app.admin_analytics_read', 'on', true);

DO $$
DECLARE
  v_missing BIGINT;
  v_detail  TEXT;
BEGIN
  SELECT count(*),
         array_to_string((array_agg(format('%s (%s)', u.id, u.user_type) ORDER BY u.id))[1:20], ', ')
    INTO v_missing, v_detail
    FROM public.users u
   WHERE u.user_type = 'employer'
     AND NOT EXISTS (SELECT 1 FROM public.organization_members m WHERE m.user_id = u.id);
  IF v_missing <> 0 THEN
    RAISE EXCEPTION 'migration 127: % employer users have no company; give each a one-person company as 119''s catch-up back-fill does (and check that Phase 1''s post-confirmation Lambda is deployed), then apply again', v_missing
      USING DETAIL = 'Employers (user_id, user_type; up to 20): ' || v_detail;
  END IF;
END $$;

SELECT set_config('app.admin_analytics_read', 'off', true);
SELECT set_config('app.org_bootstrap', 'off', true);

-- ── Self-check ──────────────────────────────────────────────
DO $$
DECLARE
  v_free INTEGER;
  v_pro  INTEGER;
BEGIN
  SET LOCAL search_path = pg_catalog, pg_temp;

  -- The stamping function and its two triggers, enabled, on INSERT and on a
  -- change of organization_id or user_id.
  IF NOT EXISTS (
       SELECT 1 FROM pg_proc p JOIN pg_roles r ON r.oid = p.proowner
        WHERE p.oid = to_regprocedure('public.billing_stamp_organization()')
          AND r.rolname = 'jale_admin' AND p.prosecdef
          AND p.proconfig = ARRAY['search_path=pg_catalog, pg_temp']::TEXT[]
     ) OR has_function_privilege('public', to_regprocedure('public.billing_stamp_organization()'), 'EXECUTE') THEN
    RAISE EXCEPTION 'migration 127: billing_stamp_organization is missing or drifted';
  END IF;
  IF (SELECT count(*) FROM pg_trigger t
       WHERE t.tgfoid = to_regprocedure('public.billing_stamp_organization()') AND NOT t.tgisinternal
         AND t.tgenabled <> 'D'
         AND ((t.tgrelid = 'public.billing_customers'::regclass AND t.tgname = 'billing_customers_stamp_organization')
           OR (t.tgrelid = 'public.subscriptions'::regclass AND t.tgname = 'subscriptions_stamp_organization'))
         AND pg_get_triggerdef(t.oid) LIKE '%BEFORE INSERT OR UPDATE OF organization_id, user_id ON public.% FOR EACH ROW %') <> 2 THEN
    RAISE EXCEPTION 'migration 127: a stamping trigger is missing, disabled or fires on the wrong events';
  END IF;

  -- NOT NULL and the per-company indexes.
  IF (SELECT count(*) FROM pg_attribute
       WHERE attrelid IN ('public.billing_customers'::regclass, 'public.subscriptions'::regclass)
         AND attname = 'organization_id' AND attnotnull AND NOT attisdropped) <> 2 THEN
    RAISE EXCEPTION 'migration 127: organization_id is not NOT NULL on both billing tables';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_index i WHERE i.indexrelid = to_regclass('public.billing_customers_one_per_organization') AND i.indisunique)
     OR NOT EXISTS (SELECT 1 FROM pg_index i WHERE i.indexrelid = to_regclass('public.subscriptions_one_current_per_organization')
                     AND i.indisunique AND i.indpred IS NOT NULL)
     OR to_regclass('public.subscriptions_organization_idx') IS NULL
     OR to_regclass('public.subscriptions_one_current_per_user') IS NOT NULL THEN
    RAISE EXCEPTION 'migration 127: the per-company indexes are not as reviewed';
  END IF;

  -- The seat seed (jale_admin reads billing_plans through 034's billing_plans_read_all).
  SELECT (entitlements->>'foreman_seat_limit')::INTEGER INTO v_free FROM public.billing_plans WHERE code = 'employer_free';
  SELECT (entitlements->>'foreman_seat_limit')::INTEGER INTO v_pro FROM public.billing_plans WHERE code = 'employer_pro';
  IF v_free IS DISTINCT FROM 0 OR v_pro IS DISTINCT FROM 3 THEN
    RAISE EXCEPTION 'migration 127: foreman_seat_limit seed failed (free %, pro %)', v_free, v_pro;
  END IF;
  IF EXISTS (SELECT 1 FROM public.billing_plans WHERE audience = 'employer' AND NOT (entitlements ? 'foreman_seat_limit')) THEN
    RAISE EXCEPTION 'migration 127: an employer plan has no foreman_seat_limit';
  END IF;

  -- The member read, keyed on the company, and the gated trigger read.
  IF NOT EXISTS (SELECT 1 FROM pg_policy WHERE polrelid = 'public.subscriptions'::regclass AND polname = 'subscriptions_org_member_read'
                    AND polcmd = 'r' AND polpermissive AND polroles = ARRAY['jale_api'::regrole::oid]
                    AND pg_get_expr(polqual, polrelid) LIKE '(organization_id IN ( SELECT m.organization_id%')
     OR NOT EXISTS (SELECT 1 FROM pg_policy WHERE polrelid = 'public.organization_members'::regclass AND polname = 'organization_members_trigger_read'
                    AND polcmd = 'r' AND polpermissive AND polroles = ARRAY['jale_admin'::regrole::oid]
                    AND pg_get_expr(polqual, polrelid) = $q$(current_setting('app.org_trigger_read'::text, true) = 'on'::text)$q$
                    AND polwithcheck IS NULL) THEN
    RAISE EXCEPTION 'migration 127: subscriptions_org_member_read or organization_members_trigger_read is missing or drifted';
  END IF;

  -- No temporary policy and no open gate outlive this migration.
  IF EXISTS (SELECT 1 FROM pg_policy WHERE polname IN ('billing_customers_org_backfill', 'subscriptions_org_backfill',
                                                       'billing_plans_seat_seed', 'users_org_bootstrap_read')) THEN
    RAISE EXCEPTION 'migration 127: a temporary policy was left behind';
  END IF;
  IF current_setting('app.billing_org_backfill', true) IS DISTINCT FROM 'off'
     OR current_setting('app.org_bootstrap', true) IS DISTINCT FROM 'off'
     OR current_setting('app.admin_analytics_read', true) IS DISTINCT FROM 'off'
     OR current_setting('app.org_trigger_read', true) = 'on' THEN
    RAISE EXCEPTION 'migration 127: a gate was left open';
  END IF;

  -- Still no runtime login on organizations, and no new right for the processor's login.
  IF has_any_column_privilege('jale_api', 'public.organizations', 'SELECT')
     OR has_any_column_privilege('jale_billing', 'public.organizations', 'SELECT')
     OR has_any_column_privilege('jale_billing', 'public.organization_members', 'SELECT')
     OR has_table_privilege('jale_billing', 'public.billing_customers', 'INSERT') THEN
    RAISE EXCEPTION 'migration 127: a runtime login holds a right it must not';
  END IF;
END $$;

COMMIT;
