-- ============================================================
-- precheck-139.sql: release-day forecast for migration 139
-- (139_admin_analytics_by_company.sql), run just BEFORE applying it.
--
-- RUN (read-only: one READ ONLY transaction as the master login, rolled back):
--   bash scripts/run-migrations.sh --report infra/db/reports/precheck-139.sql
--
-- WHY. 139 records eight admin analytics figures with the old function
-- bodies (its section 0b), replaces the bodies, and recomputes the figures
-- with the new ones (section 5b). While no company has a foreman, a company
-- is exactly one employer login, so every figure must be equal, and 139
-- aborts (rolls back whole, writes no ledger row) on the first that differs.
-- With ANY organization_members row of role 'foreman', in any status, 5b
-- skips the comparison and only prints a NOTICE. This report says, before the
-- apply, which of the two will happen, and whether data that already exists
-- would make a correct 139 abort.
--
-- READ THE VERDICT (the last column of the second result):
--   FILTERED: ...   A read came back filtered by row security, so none of the
--                   counts can be trusted. Stop and investigate; do not apply.
--   SKIP: ...       A foreman row exists. 139 applies with its skip NOTICE and
--                   does not compare the figures. Find out whose foremen they
--                   are (they should be internal test companies), capture the
--                   old figures with a --report just before the apply and the
--                   new ones just after, and explain every difference by them.
--   COMPARE: ...    No foreman row and no known breaker below: 139 compares
--                   the eight figures and is expected to pass.
--   COMPARE (will raise: ...) / COMPARE (may raise: ...)
--                   No foreman row, but data that already exists makes a
--                   per-company figure differ from the per-login one, so a
--                   correct 139 WILL (or, depending on dates, MAY) abort with
--                   "differs from the per-login figure". Do not rerun it
--                   expecting a different result: the state is not a race.
--                   Investigate the rows the counts name first.
-- A COMPARE apply can still abort if an employer signs up, a subscription
-- changes or an application arrives between 139's two readings (READ
-- COMMITTED; see 139's header): rerun once in a quieter minute.
--
-- THIS IS A FORECAST. The authoritative record is the apply itself: 5b's skip
-- NOTICE, or its absence, in the apply's .err capture, and its exit status.
-- A foreman who accepts an invite after this report turns COMPARE into SKIP.
--
-- THE KNOWN BREAKERS (per-login vs per-company, with no foreman). Read
-- against 139's sections 0b and 5b and the old bodies (089, 113, 114, 123,
-- 124):
--   payers_paying_in_several_companies  (WILL raise, figure 2)
--       totals.paying_employers was count(DISTINCT user_id) over paying
--       subscriptions and is now count(DISTINCT organization_id). A company
--       holds at most one current subscription (127's
--       subscriptions_one_current_per_organization), so the two differ
--       exactly when one payer pays in two or more companies.
--   payers_in_several_companies, companies_with_several_payers  (MAY raise,
--       figure 6)
--       paying_weekly grouped paying/new/churned by payer and now groups by
--       company. Among subscriptions with history whose payer is an existing,
--       non-test employer login, a payer billed in several companies, or a
--       company billed to several payers (support moved ownership and the new
--       owner subscribed), changes the counts whenever those subscriptions
--       start or stop paying across a week edge in the last 26 weeks.
--   history_rows_naming_another_payer  (MAY raise, figure 6)
--       the old paying_weekly read the payer from subscription_status_history,
--       the new one from subscriptions. A history row whose user_id is not its
--       subscription's payer splits that subscription in the old figure.
--   companies_with_several_members  (MAY raise, figures 5 and 7)
--       template reuse and slowest key a job by its holder's company and that
--       company's active owner. With no foreman this is always 0: an owner row
--       is always active (organization_members_owner_always_active) and a
--       company has one active owner (organization_members_one_active_owner).
--       A non-zero count with no foreman means those constraints drifted.
--   subscriptions_payer_not_active_owner  (context only, not a breaker)
--       the final review's suggested count. A subscription billed to someone
--       who is not now its company's active owner does not by itself change
--       any figure. It is the usual cause of the two breakers above, so a
--       non-zero count says where to look.
-- Figures 1, 3, 4 and 8 (total companies, sign-ups, acquisition, the paying
-- list's payers) cannot differ while no foreman row exists.
--
-- RLS. organization_members, users, subscriptions and
-- subscription_status_history are FORCE ROW LEVEL SECURITY, and jale_admin is
-- not BYPASSRLS. In production the master's posture baseline is
-- row_security_active(public.users) = f, so RLS does not filter it at all; on
-- a test bed it is t. Either way, statement 1 opens two existing SELECT-only
-- gates for jale_admin, local to this transaction (set_config(..., true)
-- writes nothing and is allowed in a read-only transaction): 118's
-- organization_members_name_lookup (app.employer_name_lookup) and 089's
-- admin analytics read policies on users, subscriptions and
-- subscription_status_history (app.admin_analytics_read). Statement 1 prints
-- row_security_active for each table, so the reader knows which case applies.
-- Statement 2's FILTERED checks compare what was visible with
-- pg_stat_user_tables' live-tuple statistic, which RLS never filters, and
-- with each other (every employer login has a membership since 118/119).
--
-- EDITING NOTE. The --report file check (scripts/run-migrations.sh,
-- check_report_file) splits statements on every semicolon, string literals
-- included, and refuses a comment that is not on a line of its own and the
-- words INSERT, UPDATE, DELETE, MERGE and INTO anywhere outside a comment
-- line. So the SQL below holds no semicolon except the two statement ends,
-- no double dash, and none of those words.
-- ============================================================
SELECT current_user AS login,
       set_config('app.employer_name_lookup', 'on', true) AS name_lookup_gate,
       set_config('app.admin_analytics_read', 'on', true) AS analytics_gate,
       row_security_active('public.organization_members') AS members_rls_active,
       row_security_active('public.users') AS users_rls_active,
       row_security_active('public.subscriptions') AS subscriptions_rls_active,
       row_security_active('public.subscription_status_history') AS history_rls_active;

WITH billed AS (
  SELECT s.id, s.user_id, s.organization_id
    FROM public.subscriptions s
    JOIN public.users u ON u.id = s.user_id
   WHERE u.user_type = 'employer'
     AND NOT COALESCE(u.email LIKE '%@jale.test' OR u.cognito_sub LIKE 'seed-%', false)
     AND EXISTS (SELECT 1 FROM public.subscription_status_history h WHERE h.subscription_id = s.id)
), c AS (
  SELECT
    (SELECT count(*) FROM public.organization_members m WHERE m.role = 'foreman') AS foremen_any_status,
    (SELECT count(*) FROM public.organization_members m WHERE m.role = 'foreman' AND m.status = 'active') AS foremen_active,
    (SELECT count(*) FROM public.organization_members m WHERE m.role = 'foreman' AND m.status = 'suspended') AS foremen_suspended,
    (SELECT count(*) FROM public.organization_members m WHERE m.role = 'foreman' AND m.status = 'removed') AS foremen_removed,
    (SELECT count(*)
       FROM (SELECT s.user_id
               FROM public.subscriptions s
              WHERE s.status IN ('active', 'trialing', 'past_due')
              GROUP BY s.user_id
             HAVING count(DISTINCT s.organization_id) > 1) x) AS payers_paying_in_several_companies,
    (SELECT count(*)
       FROM (SELECT b.user_id FROM billed b
              GROUP BY b.user_id
             HAVING count(DISTINCT b.organization_id) > 1) x) AS payers_in_several_companies,
    (SELECT count(*)
       FROM (SELECT b.organization_id FROM billed b
              GROUP BY b.organization_id
             HAVING count(DISTINCT b.user_id) > 1) x) AS companies_with_several_payers,
    (SELECT count(*)
       FROM public.subscription_status_history h
       JOIN public.subscriptions s ON s.id = h.subscription_id
      WHERE h.user_id <> s.user_id) AS history_rows_naming_another_payer,
    (SELECT count(*)
       FROM (SELECT m.organization_id FROM public.organization_members m
              GROUP BY m.organization_id
             HAVING count(*) > 1) x) AS companies_with_several_members,
    (SELECT count(*)
       FROM public.subscriptions s
      WHERE NOT EXISTS (SELECT 1 FROM public.organization_members o
                         WHERE o.organization_id = s.organization_id
                           AND o.user_id = s.user_id
                           AND o.role = 'owner' AND o.status = 'active')) AS subscriptions_payer_not_active_owner,
    (SELECT count(*) FROM public.organization_members m) AS memberships_visible,
    (SELECT count(*) FROM public.organization_members m WHERE m.role = 'owner' AND m.status = 'active') AS active_owners_visible,
    (SELECT count(*) FROM public.users u WHERE u.user_type = 'employer') AS employer_logins_visible,
    (SELECT count(*) FROM public.subscriptions s) AS subscriptions_visible,
    (SELECT st.n_live_tup FROM pg_catalog.pg_stat_user_tables st
      WHERE st.relid = 'public.organization_members'::regclass) AS memberships_live_tuples_stat,
    (SELECT st.n_live_tup FROM pg_catalog.pg_stat_user_tables st
      WHERE st.relid = 'public.subscriptions'::regclass) AS subscriptions_live_tuples_stat
), b AS (
  SELECT c.*,
         concat_ws(', ',
           CASE WHEN c.payers_paying_in_several_companies > 0
                THEN format('figure 2 totals.paying_employers: %s payer(s) paying in several companies',
                            c.payers_paying_in_several_companies) END
         ) AS will_raise,
         concat_ws(', ',
           CASE WHEN c.payers_in_several_companies > 0
                THEN format('figure 6 paying_weekly: %s payer(s) billed in several companies',
                            c.payers_in_several_companies) END,
           CASE WHEN c.companies_with_several_payers > 0
                THEN format('figure 6 paying_weekly: %s company(ies) billed to several payers',
                            c.companies_with_several_payers) END,
           CASE WHEN c.history_rows_naming_another_payer > 0
                THEN format('figure 6 paying_weekly: %s history row(s) naming another payer',
                            c.history_rows_naming_another_payer) END,
           CASE WHEN c.companies_with_several_members > 0
                THEN format('figures 5 and 7 template reuse and slowest: %s company(ies) with several membership rows',
                            c.companies_with_several_members) END
         ) AS may_raise
    FROM c
)
SELECT b.*,
       CASE
         WHEN b.memberships_visible = 0 AND (b.employer_logins_visible > 0 OR b.memberships_live_tuples_stat > 0)
           THEN 'FILTERED: the membership read returned no rows, so do not trust these counts'
         WHEN b.employer_logins_visible > 0 AND b.active_owners_visible = 0
           THEN 'FILTERED: employers exist but no active owner is visible, so do not trust these counts'
         WHEN b.memberships_visible > 0 AND b.employer_logins_visible = 0
           THEN 'FILTERED: memberships exist but no employer login is visible, so do not trust these counts'
         WHEN b.subscriptions_visible = 0 AND b.subscriptions_live_tuples_stat > 0
           THEN 'FILTERED: the subscription read returned no rows, so do not trust these counts'
         WHEN b.foremen_any_status > 0
           THEN 'SKIP: a foreman row exists, so 139 applies with the skip NOTICE and does not compare the eight figures'
         WHEN b.will_raise <> ''
           THEN 'COMPARE (will raise: ' || b.will_raise
                || CASE WHEN b.may_raise <> '' THEN ', and may raise: ' || b.may_raise ELSE '' END
                || '): a correct 139 aborts on this data, so investigate before applying'
         WHEN b.may_raise <> ''
           THEN 'COMPARE (may raise: ' || b.may_raise
                || '): a correct 139 can abort on these rows, depending on their dates, so investigate before applying'
         ELSE 'COMPARE: no foreman row and no known breaker, so 139 compares the eight figures and is expected to pass'
       END AS verdict
  FROM b;
