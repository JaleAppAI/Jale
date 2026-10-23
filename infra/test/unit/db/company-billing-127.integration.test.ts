/**
 * company-billing-127 -- migration 127 on a real bed: billing rows belong to
 * the payer's company. As the deployed logins: the request login's own
 * Stripe-customer insert and the billing login's subscription insert (both
 * written without organization_id by the Lambdas deployed before Phase 2)
 * get the payer's company; a wrong or changed company, a payer with no
 * company, a changed payer and a foreman as Stripe customer are refused
 * (42501); a company has one current subscription (23505 on the new index);
 * every active member reads the company's subscription, only the payer its
 * Stripe customer.
 * Fixtures through the superuser URL; afterAll removes them.
 *
 * Run: bash infra/db/local/bootstrap-testbed.sh --ephemeral --ref none -- \
 *   bash infra/scripts/run-whatsapp-v2-db-tests.sh --suite test/unit/db/company-billing-127.integration.test.ts
 */
import { randomUUID } from 'node:crypto';
import { Client } from 'pg';
import { describeInProfiles, withLoginClient } from './helpers/login-pool';

const databaseUrl = process.env.JALE_TEST_DATABASE_URL;
if (!databaseUrl) {
  test('CONCERN: company-billing-127 needs JALE_TEST_DATABASE_URL (see header)', () => {
    expect(databaseUrl).toBeUndefined();
  });
}
const maybeDescribe = databaseUrl ? describe : describe.skip;

type Person = { id: string; sub: string };

// The webhook processor's upsert, copied verbatim from
// infra/lambda/billing/processor.ts (the Lambda deployed before Phase 2).
const PROCESSOR_UPSERT = `INSERT INTO subscriptions (
          user_id, plan_code, provider_subscription_id, status,
          current_period_start, current_period_end, cancel_at_period_end,
          grace_ends_at, updated_at
        ) VALUES ($1, $2, $3, $4, $5, $6, $7,
          CASE WHEN $4 = 'past_due' AND $8::timestamptz IS NULL
               THEN now() + interval '7 days'
               ELSE $8::timestamptz
          END,
          now())
       ON CONFLICT (provider_subscription_id)
         DO UPDATE SET
           status               = EXCLUDED.status,
           current_period_start = EXCLUDED.current_period_start,
           current_period_end   = EXCLUDED.current_period_end,
           cancel_at_period_end = EXCLUDED.cancel_at_period_end,
           grace_ends_at        = CASE
             WHEN EXCLUDED.status = 'past_due' AND subscriptions.status = 'past_due' AND subscriptions.grace_ends_at IS NOT NULL
               THEN subscriptions.grace_ends_at        -- preserve existing deadline
             WHEN EXCLUDED.status = 'past_due'
               THEN EXCLUDED.grace_ends_at             -- new deadline (now+7d)
             ELSE NULL                                 -- non-past_due: clear
           END,
           updated_at           = now()
       RETURNING id`;

// The same upsert naming the payer's company ($9), as a Phase 2 processor may.
const PROCESSOR_UPSERT_WITH_ORG = PROCESSOR_UPSERT
  .replace('user_id, plan_code,', 'user_id, organization_id, plan_code,')
  .replace('VALUES ($1, $2,', 'VALUES ($1, $9, $2,');

maybeDescribe('migration 127: billing belongs to the company', () => {
  let su: Client;
  const companies: string[] = [];

  beforeAll(async () => {
    su = new Client({ connectionString: databaseUrl });
    await su.connect();
  });
  afterAll(async () => {
    try {
      // Every person this suite made has a cognito_sub starting bill127-.
      const ids = (await su.query<{ id: string }>(`SELECT id FROM users WHERE cognito_sub LIKE 'bill127-%'`))
        .rows.map((r) => r.id);
      // Billing rows restrict their payer and their company.
      await su.query(`DELETE FROM subscriptions WHERE user_id = ANY($1::uuid[])`, [ids]);
      await su.query(`DELETE FROM billing_customers WHERE user_id = ANY($1::uuid[])`, [ids]);
      await su.query(`DELETE FROM organization_members WHERE organization_id = ANY($1::uuid[])`, [companies]);
      await su.query(`DELETE FROM organizations WHERE id = ANY($1::uuid[])`, [companies]);
      await su.query(`DELETE FROM users WHERE id = ANY($1::uuid[])`, [ids]);
    } finally {
      await su.end();
    }
  });

  async function user(): Promise<Person> {
    const sub = `bill127-${randomUUID()}`;
    const { rows } = await su.query<{ id: string }>(
      `INSERT INTO users (cognito_sub, user_type, email) VALUES ($1, 'employer', $2) RETURNING id`,
      [sub, `${sub}@example.invalid`],
    );
    return { id: rows[0].id, sub };
  }

  /** A company whose active owner is `owner`. */
  async function company(owner: Person): Promise<string> {
    const org = (await su.query<{ id: string }>(`INSERT INTO organizations (name) VALUES ('Bill127 Co') RETURNING id`)).rows[0].id;
    companies.push(org);
    await su.query(`INSERT INTO organization_members (user_id, organization_id, role) VALUES ($1, $2, 'owner')`, [owner.id, org]);
    return org;
  }

  async function foreman(org: string, person: Person, status: 'active' | 'suspended' = 'active'): Promise<void> {
    await su.query(
      `INSERT INTO organization_members (user_id, organization_id, role, status) VALUES ($1, $2, 'foreman', $3)`,
      [person.id, org, status],
    );
  }

  /** Runs fn as jale_api inside a transaction with both caller settings, then rolls back. */
  async function asApi<T>(caller: Person, fn: (c: Client) => Promise<T>): Promise<T> {
    return withLoginClient('jale_api', async (c) => {
      await c.query('BEGIN');
      try {
        await c.query(`SELECT set_config('app.current_user_id', $1, true)`, [caller.sub]);
        await c.query(`SELECT set_config('app.current_internal_user_id', $1, true)`, [caller.id]);
        return await fn(c);
      } finally {
        await c.query('ROLLBACK');
      }
    });
  }

  /** Runs fn as the webhook processor's login inside a transaction, then rolls back. */
  async function asBilling<T>(fn: (c: Client) => Promise<T>): Promise<T> {
    return withLoginClient('jale_billing', async (c) => {
      await c.query('BEGIN');
      try {
        return await fn(c);
      } finally {
        await c.query('ROLLBACK');
      }
    });
  }

  /** Runs an expected-error statement under a savepoint, so the transaction stays usable. */
  async function rejects(c: Client, sql: string, params: unknown[], code: string): Promise<void> {
    await c.query('SAVEPOINT expected_error');
    await expect(c.query(sql, params)).rejects.toMatchObject({ code });
    await c.query('ROLLBACK TO SAVEPOINT expected_error');
  }

  describeInProfiles(['standard', 'request', 'owner-unrestricted'], 'the catalog', () => {
    it('makes organization_id NOT NULL and keys the one-current-subscription rule on the company', async () => {
      const columns = await su.query<{ table_name: string; is_nullable: string }>(
        `SELECT table_name::text, is_nullable::text FROM information_schema.columns
          WHERE table_schema = 'public' AND column_name = 'organization_id'
            AND table_name IN ('billing_customers', 'subscriptions')
          ORDER BY table_name`,
      );
      expect(columns.rows).toEqual([
        { table_name: 'billing_customers', is_nullable: 'NO' },
        { table_name: 'subscriptions', is_nullable: 'NO' },
      ]);
      const indexes = await su.query<{ indexname: string; indexdef: string }>(
        `SELECT indexname::text, indexdef FROM pg_indexes
          WHERE schemaname = 'public' AND indexname = ANY($1::text[]) ORDER BY indexname`,
        [['billing_customers_one_per_organization', 'subscriptions_one_current_per_organization',
          'subscriptions_one_current_per_user', 'subscriptions_organization_idx']],
      );
      expect(indexes.rows.map((r) => r.indexname)).toEqual([
        'billing_customers_one_per_organization', 'subscriptions_one_current_per_organization', 'subscriptions_organization_idx',
      ]);
      expect(indexes.rows[0].indexdef).toBe(
        'CREATE UNIQUE INDEX billing_customers_one_per_organization ON public.billing_customers USING btree (organization_id)');
      expect(indexes.rows[1].indexdef).toBe(
        'CREATE UNIQUE INDEX subscriptions_one_current_per_organization ON public.subscriptions USING btree (organization_id) '
        + "WHERE (status <> ALL (ARRAY['canceled'::text, 'incomplete_expired'::text]))");
    });

    it('gives each employer plan its foreman seat limit', async () => {
      const { rows } = await su.query<{ code: string; seats: number }>(
        `SELECT code, (entitlements->>'foreman_seat_limit')::int AS seats FROM billing_plans
          WHERE code IN ('employer_free', 'employer_pro') ORDER BY code`,
      );
      expect(rows).toEqual([{ code: 'employer_free', seats: 0 }, { code: 'employer_pro', seats: 3 }]);
    });

    it('stamps through one pinned jale_admin definer that no login may call', async () => {
      const { rows } = await su.query(
        `SELECT pg_catalog.pg_get_userbyid(p.proowner) AS owner, p.prosecdef AS definer, p.proconfig AS config,
                has_function_privilege('jale_api', p.oid, 'EXECUTE') AS api,
                has_function_privilege('jale_billing', p.oid, 'EXECUTE') AS billing,
                (SELECT array_agg(t.tgname::text ORDER BY t.tgname) FROM pg_trigger t
                  WHERE t.tgfoid = p.oid AND NOT t.tgisinternal) AS triggers
           FROM pg_proc p WHERE p.oid = 'public.billing_stamp_organization()'::regprocedure`,
      );
      expect(rows).toEqual([{
        owner: 'jale_admin', definer: true, config: ['search_path=pg_catalog, pg_temp'], api: false, billing: false,
        triggers: ['billing_customers_stamp_organization', 'subscriptions_stamp_organization'],
      }]);
      // On insert, and on a change of the company or of the payer.
      const defs = await su.query<{ def: string }>(
        `SELECT pg_get_triggerdef(t.oid) AS def FROM pg_trigger t
          WHERE t.tgfoid = 'public.billing_stamp_organization()'::regprocedure ORDER BY t.tgname`,
      );
      expect(defs.rows.map((r) => r.def.replace(/ EXECUTE FUNCTION .*$/, ''))).toEqual([
        'CREATE TRIGGER billing_customers_stamp_organization BEFORE INSERT OR UPDATE OF organization_id, user_id ON public.billing_customers FOR EACH ROW',
        'CREATE TRIGGER subscriptions_stamp_organization BEFORE INSERT OR UPDATE OF organization_id, user_id ON public.subscriptions FOR EACH ROW',
      ]);
    });

    it('leaves none of its temporary policies behind', async () => {
      const { rows } = await su.query(
        `SELECT polname FROM pg_policy
          WHERE polname IN ('billing_customers_org_backfill', 'subscriptions_org_backfill', 'billing_plans_seat_seed',
                            'users_org_bootstrap_read')`,
      );
      expect(rows).toEqual([]);
    });
  });

  describeInProfiles(['standard', 'request'], 'stamping', () => {
    it('the payer\'s own Stripe-customer insert (the pre-Phase-2 checkout) gets the payer\'s company', async () => {
      const owner = await user();
      const org = await company(owner);
      const stamped = await asApi(owner, async (c) => (await c.query<{ organization_id: string }>(
        `INSERT INTO billing_customers (user_id, provider, provider_customer_id) VALUES ($1, 'stripe', $2) RETURNING organization_id`,
        [owner.id, `cus_bill127_${randomUUID()}`],
      )).rows[0].organization_id);
      expect(stamped).toBe(org);
    });

    it('a foreman cannot become the company\'s Stripe customer', async () => {
      const owner = await user();
      const org = await company(owner);
      const f = await user();
      await foreman(org, f);
      // The per-person RLS policy lets a foreman insert a row for themself; the trigger refuses it.
      await asApi(f, (c) => rejects(c,
        `INSERT INTO billing_customers (user_id, provider, provider_customer_id) VALUES ($1, 'stripe', $2)`,
        [f.id, `cus_bill127_${randomUUID()}`], '42501'));
    });

    it('the billing login\'s insert without a company (the pre-Phase-2 processor) is stamped; a wrong or changed company is refused', async () => {
      const owner = await user();
      const org = await company(owner);
      const other = await user();
      const otherOrg = await company(other);
      await asBilling(async (c) => {
        const row = (await c.query<{ id: string; organization_id: string }>(
          `INSERT INTO subscriptions (user_id, plan_code, provider_subscription_id, status)
           VALUES ($1, 'employer_pro', $2, 'active') RETURNING id, organization_id`,
          [owner.id, `sub_bill127_${randomUUID()}`],
        )).rows[0];
        expect(row.organization_id).toBe(org);
        // The Phase 2 processor names the company itself: accepted when it is the payer's.
        const named = await c.query(
          `INSERT INTO subscriptions (user_id, organization_id, plan_code, provider_subscription_id, status)
           VALUES ($1, $2, 'employer_pro', $3, 'canceled')`,
          [owner.id, org, `sub_bill127_${randomUUID()}`],
        );
        expect(named.rowCount).toBe(1);
        await rejects(c,
          `INSERT INTO subscriptions (user_id, organization_id, plan_code, provider_subscription_id, status)
           VALUES ($1, $2, 'employer_pro', $3, 'canceled')`,
          [owner.id, otherOrg, `sub_bill127_${randomUUID()}`], '42501');
        await rejects(c, `UPDATE subscriptions SET organization_id = $1 WHERE id = $2`, [otherOrg, row.id], '42501');
      });
    });

    it('the processor\'s webhook upsert on an existing row passes, with or without the company, while the payer is a suspended foreman', async () => {
      expect(PROCESSOR_UPSERT_WITH_ORG).toContain('user_id, organization_id, plan_code,');
      expect(PROCESSOR_UPSERT_WITH_ORG).toContain('VALUES ($1, $9, $2,');
      const owner = await user();
      const org = await company(owner);
      const f = await user();
      await foreman(org, f, 'suspended');
      const providerSubId = `sub_bill127_${randomUUID()}`;
      // The existing row (subscriptions accept any member status; it is stamped).
      const existing = (await su.query<{ id: string; organization_id: string }>(
        `INSERT INTO subscriptions (user_id, plan_code, provider_subscription_id, status) VALUES ($1, 'employer_pro', $2, 'active')
         RETURNING id, organization_id`,
        [f.id, providerSubId],
      )).rows[0];
      expect(existing.organization_id).toBe(org);
      const params = [f.id, 'employer_pro', providerSubId, 'past_due',
        new Date('2026-10-01T00:00:00Z'), new Date('2026-11-01T00:00:00Z'), false, null];
      // ON CONFLICT DO UPDATE fires BEFORE INSERT on the proposed row first:
      // the trigger must accept a payer whose company is unchanged.
      await asBilling(async (c) => {
        // (a) The processor's upsert as deployed (infra/lambda/billing/processor.ts), without organization_id.
        const a = await c.query<{ id: string }>(PROCESSOR_UPSERT, params);
        expect(a.rows).toEqual([{ id: existing.id }]);
        // (b) The same upsert naming the payer's own company.
        const b = await c.query<{ id: string }>(PROCESSOR_UPSERT_WITH_ORG, [...params, org]);
        expect(b.rows).toEqual([{ id: existing.id }]);
        const after = await c.query<{ organization_id: string; status: string }>(
          `SELECT organization_id, status FROM subscriptions WHERE id = $1`, [existing.id]);
        expect(after.rows).toEqual([{ organization_id: org, status: 'past_due' }]);
      });
    });

    it('a billing row\'s payer and company never change, whoever updates', async () => {
      const owner = await user();
      await company(owner);
      const other = await user();
      const otherOrg = await company(other);
      await su.query('BEGIN');
      try {
        const sub = (await su.query<{ id: string }>(
          `INSERT INTO subscriptions (user_id, plan_code, provider_subscription_id, status) VALUES ($1, 'employer_pro', $2, 'canceled') RETURNING id`,
          [owner.id, `sub_bill127_${randomUUID()}`],
        )).rows[0].id;
        await su.query(
          `INSERT INTO billing_customers (user_id, provider, provider_customer_id) VALUES ($1, 'stripe', $2)`,
          [owner.id, `cus_bill127_${randomUUID()}`],
        );
        // The superuser passes every policy; the trigger is the database's rule.
        await rejects(su, `UPDATE subscriptions SET user_id = $1 WHERE id = $2`, [other.id, sub], '42501');
        await rejects(su, `UPDATE subscriptions SET organization_id = $1 WHERE id = $2`, [otherOrg, sub], '42501');
        await rejects(su, `UPDATE billing_customers SET user_id = $1 WHERE user_id = $2`, [other.id, owner.id], '42501');
        // Writing the same values back is no change.
        expect((await su.query(
          `UPDATE subscriptions SET user_id = user_id, organization_id = organization_id WHERE id = $1`, [sub])).rowCount).toBe(1);
      } finally {
        await su.query('ROLLBACK');
      }
    });

    it('a payer with no company is refused, whoever inserts', async () => {
      const loner = await user();
      await su.query('BEGIN');
      try {
        await rejects(su, `INSERT INTO subscriptions (user_id, plan_code, status) VALUES ($1, 'employer_pro', 'active')`,
          [loner.id], '42501');
        await rejects(su, `INSERT INTO billing_customers (user_id, provider, provider_customer_id) VALUES ($1, 'stripe', $2)`,
          [loner.id, `cus_bill127_${randomUUID()}`], '42501');
      } finally {
        await su.query('ROLLBACK');
      }
    });

    it('one current subscription per company: a second current row is refused by the new index', async () => {
      const owner = await user();
      await company(owner);
      await su.query('BEGIN');
      try {
        await su.query(
          `INSERT INTO subscriptions (user_id, plan_code, provider_subscription_id, status) VALUES ($1, 'employer_pro', $2, 'active')`,
          [owner.id, `sub_bill127_${randomUUID()}`],
        );
        await su.query('SAVEPOINT collide');
        const err = await su.query(
          `INSERT INTO subscriptions (user_id, plan_code, provider_subscription_id, status) VALUES ($1, 'employer_pro', $2, 'past_due')`,
          [owner.id, `sub_bill127_${randomUUID()}`],
        ).then(() => null, (e: { code?: string; message?: string }) => e);
        expect(err?.code).toBe('23505');
        // Named, so the provider_subscription_id UNIQUE constraint cannot pass for it.
        expect(String(err?.message)).toContain('subscriptions_one_current_per_organization');
        await su.query('ROLLBACK TO SAVEPOINT collide');
        // A canceled row sits outside the index.
        await su.query(
          `INSERT INTO subscriptions (user_id, plan_code, provider_subscription_id, status) VALUES ($1, 'employer_pro', $2, 'canceled')`,
          [owner.id, `sub_bill127_${randomUUID()}`],
        );
      } finally {
        await su.query('ROLLBACK');
      }
    });
  });

  describeInProfiles(['standard', 'request'], 'company reads as jale_api', () => {
    it('every active member reads the company subscription; a suspended member and a stranger do not', async () => {
      const owner = await user();
      const org = await company(owner);
      const f = await user();
      await foreman(org, f);
      const suspended = await user();
      await foreman(org, suspended, 'suspended');
      const stranger = await user();
      await company(stranger);
      await su.query(
        `INSERT INTO subscriptions (user_id, plan_code, provider_subscription_id, status) VALUES ($1, 'employer_pro', $2, 'active')`,
        [owner.id, `sub_bill127_${randomUUID()}`],
      );
      const reads = (p: Person) => asApi(p, async (c) =>
        (await c.query(`SELECT id FROM subscriptions WHERE organization_id = $1`, [org])).rows.length);
      expect(await reads(owner)).toBe(1);
      expect(await reads(f)).toBe(1);
      expect(await reads(suspended)).toBe(0);
      expect(await reads(stranger)).toBe(0);
    });

    it('only the payer reads the company\'s Stripe customer', async () => {
      const owner = await user();
      const org = await company(owner);
      const f = await user();
      await foreman(org, f);
      await su.query(
        `INSERT INTO billing_customers (user_id, provider, provider_customer_id) VALUES ($1, 'stripe', $2)`,
        [owner.id, `cus_bill127_${randomUUID()}`],
      );
      const reads = (p: Person) => asApi(p, async (c) =>
        (await c.query(`SELECT 1 FROM billing_customers WHERE organization_id = $1`, [org])).rows.length);
      expect(await reads(owner)).toBe(1);
      expect(await reads(f)).toBe(0);
    });
  });
});
