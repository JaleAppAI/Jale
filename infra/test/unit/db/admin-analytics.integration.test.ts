/**
 * admin-analytics.integration.test.ts
 *
 * PostgreSQL-backed behavioral + privilege tests for the five SECURITY DEFINER
 * analytics functions introduced in migration 086 (admin console Analytics tab).
 *
 * Connection: set JALE_TEST_DATABASE_URL to a local Postgres 16 URL with the full
 * migration chain (001→086) already applied. When absent, the whole suite is
 * explicitly skipped and the concern is logged (Rule 11: no silent skips).
 *
 * The URL must point to an already-migrated database (migrations are NOT applied
 * here). The DB user in the URL must be a superuser (e.g. `postgres`) so the test
 * can set role passwords and insert fixtures into RLS-forced tables.
 *
 * Example (Docker gate — same one billing-rls.integration.test.ts documents):
 *   bash infra/db/local/bootstrap-testbed.sh --ephemeral --keep --ref none --no-tests
 *   JALE_TEST_DATABASE_URL=postgres://postgres:test@127.0.0.1:55443/jale \
 *     npx jest admin-analytics.integration
 *
 * What this suite guards:
 * - the aggregates actually reflect seeded rows (totals, signups, jobs activity,
 *   message traffic across both in-app and WhatsApp sources);
 * - admin_analytics_paying_employers() exposes the BUSINESS display name only —
 *   never worker/employer PII — and excludes canceled subscriptions;
 * - the bucket argument is validated (admin_analytics_invalid_bucket);
 * - jale_admin_console still has NO direct table grants on the source tables —
 *   the definer functions are its only path to this data. That last test is the
 *   regression guard against someone "fixing" a future query by handing the
 *   console role a table GRANT.
 */

import { Client } from 'pg';

// ---------------------------------------------------------------------------
// Harness helpers (mirrors billing-rls.integration.test.ts)
// ---------------------------------------------------------------------------

const databaseUrl = process.env.JALE_TEST_DATABASE_URL;

/**
 * Set test-only login passwords on all service roles created by the migrations.
 * This is idempotent — safe to call on an already-configured DB.
 */
async function setServiceRolePasswords(superuserUrl: string): Promise<void> {
  const client = new Client({ connectionString: superuserUrl });
  await client.connect();
  try {
    // When the disposable database itself is bootstrapped as jale_admin, keep
    // its base URL valid. Otherwise configure the separate app role login.
    if (new URL(superuserUrl).username !== 'jale_admin') {
      await client.query(`ALTER ROLE jale_admin WITH PASSWORD 'test-admin-pw'`);
    }
    await client.query(`ALTER ROLE jale_billing WITH PASSWORD 'test-billing-pw'`);
    await client.query(`ALTER ROLE jale_matching WITH PASSWORD 'test-matching-pw'`);
    await client.query(`ALTER ROLE jale_whatsapp WITH PASSWORD 'test-whatsapp-pw'`);
    await client.query(`ALTER ROLE jale_ai WITH PASSWORD 'test-ai-pw'`);
    await client.query(`ALTER ROLE jale_admin_console WITH PASSWORD 'test-adminconsole-pw'`);
  } finally {
    await client.end();
  }
}

/** Parse a postgres URL and replace the user+password for a different role. */
function urlForRole(baseUrl: string, user: string, password: string): string {
  const u = new URL(baseUrl);
  u.username = user;
  u.password = password;
  return u.toString();
}

/** Run a block on a fresh jale_admin_console connection. */
async function asConsole<T>(consoleUrl: string, fn: (client: Client) => Promise<T>): Promise<T> {
  const client = new Client({ connectionString: consoleUrl });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}

const maybeDescribe = databaseUrl ? describe : describe.skip;
if (!databaseUrl) {
  // Rule 11: explicit, loud skip — not a silent pass.
  // eslint-disable-next-line no-console
  console.warn('JALE_TEST_DATABASE_URL not set — skipping admin analytics integration tests');
}

maybeDescribe('admin analytics definer functions', () => {
  let superUrl: string;
  let consoleUrl: string;

  // Fixture ids — all created in beforeAll, removed in afterAll.
  const subs = ['it-analytics-worker-1', 'it-analytics-employer-1', 'it-analytics-employer-2'];
  let workerId: string;
  let employer1Id: string; // paying, has company profile
  let employer2Id: string; // canceled subscription
  let jobActiveId: string;
  let jobClosedId: string;
  const waSids = ['it-analytics-wa-1', 'it-analytics-wa-2'];
  const PLAN = 'it_analytics_plan';

  beforeAll(async () => {
    superUrl = databaseUrl!;
    await setServiceRolePasswords(superUrl);
    consoleUrl = urlForRole(superUrl, 'jale_admin_console', 'test-adminconsole-pw');

    const su = new Client({ connectionString: superUrl });
    await su.connect();
    try {
      // Users: 1 worker + 2 employers (signups inside the 30d window).
      const users = await su.query(
        `INSERT INTO users (cognito_sub, user_type, created_at) VALUES
           ($1, 'worker',   now() - interval '2 days'),
           ($2, 'employer', now() - interval '2 days'),
           ($3, 'employer', now() - interval '3 days')
         RETURNING id`,
        subs,
      );
      [workerId, employer1Id, employer2Id] = users.rows.map((r) => r.id);

      await su.query(
        `INSERT INTO employer_profiles (user_id, company_name) VALUES ($1, 'IT Analytics Co')`,
        [employer1Id],
      );

      // Billing: dedicated test plan; employer1 paying, employer2 canceled.
      await su.query(
        `INSERT INTO billing_plans (code, audience, display_name, entitlements)
         VALUES ($1, 'employer', 'IT Analytics Plan', '{}') ON CONFLICT (code) DO NOTHING`,
        [PLAN],
      );
      await su.query(
        `INSERT INTO subscriptions (user_id, plan_code, status, cancel_at_period_end) VALUES
           ($1, $3, 'active', false),
           ($2, $3, 'canceled', false)`,
        [employer1Id, employer2Id, PLAN],
      );

      // Jobs: one active (recent), one closed (outside the 7d window).
      const jobs = await su.query(
        `INSERT INTO jobs (employer_id, title, location, job_type, status, created_at) VALUES
           ($1, 'IT Analytics Active Job', 'Austin', 'full-time', 'active', now() - interval '1 day'),
           ($1, 'IT Analytics Closed Job', 'Austin', 'full-time', 'closed', now() - interval '40 days')
         RETURNING id`,
        [employer1Id],
      );
      [jobActiveId, jobClosedId] = jobs.rows.map((r) => r.id);

      const app = await su.query(
        `INSERT INTO job_applications (job_id, worker_id, created_at)
         VALUES ($1, $2, now() - interval '1 day') RETURNING id`,
        [jobActiveId, workerId],
      );

      // In-app messages: 1 outbound sent, 1 outbound failed, 1 inbound received.
      const conv = await su.query(
        `INSERT INTO job_conversations (job_id, employer_id, worker_id, application_id)
         VALUES ($1, $2, $3, $4) RETURNING id`,
        [jobActiveId, employer1Id, workerId, app.rows[0].id],
      );
      await su.query(
        `INSERT INTO job_conversation_messages (conversation_id, sender_type, direction, body, status, created_at) VALUES
           ($1, 'employer', 'outbound', 'it-analytics ping', 'sent',     now() - interval '1 day'),
           ($1, 'employer', 'outbound', 'it-analytics fail', 'failed',   now() - interval '1 day'),
           ($1, 'worker',   'inbound',  'it-analytics pong', 'received', now() - interval '1 day')`,
        [conv.rows[0].id],
      );

      // WhatsApp: 2 inbound processed, 2 outbox rows (1 sent, 1 failed).
      await su.query(
        `INSERT INTO whatsapp_processed_messages (message_sid, whatsapp_number, status, first_seen_at) VALUES
           ($1, '+15550001111', 'completed', now() - interval '1 day'),
           ($2, '+15550001111', 'completed', now() - interval '1 day')`,
        waSids,
      );
      await su.query(
        `INSERT INTO whatsapp_outbox (inbound_message_sid, sequence, whatsapp_number, body, status, created_at) VALUES
           ($1, 1, '+15550001111', 'it-analytics out ok',   'sent',   now() - interval '1 day'),
           ($2, 1, '+15550001111', 'it-analytics out fail', 'failed', now() - interval '1 day')`,
        waSids,
      );
    } finally {
      await su.end();
    }
  }, 60_000);

  afterAll(async () => {
    if (!databaseUrl) return;
    const su = new Client({ connectionString: superUrl });
    await su.connect();
    try {
      // FK-safe teardown order; users cascade jobs/apps/conversations/messages.
      await su.query(`DELETE FROM whatsapp_outbox WHERE inbound_message_sid = ANY($1)`, [waSids]);
      await su.query(`DELETE FROM whatsapp_processed_messages WHERE message_sid = ANY($1)`, [waSids]);
      await su.query(`DELETE FROM subscriptions WHERE user_id IN (SELECT id FROM users WHERE cognito_sub = ANY($1))`, [subs]);
      await su.query(`DELETE FROM billing_plans WHERE code = $1`, [PLAN]);
      await su.query(`DELETE FROM jobs WHERE employer_id IN (SELECT id FROM users WHERE cognito_sub = ANY($1))`, [subs]);
      await su.query(`DELETE FROM employer_profiles WHERE user_id IN (SELECT id FROM users WHERE cognito_sub = ANY($1))`, [subs]);
      await su.query(`DELETE FROM users WHERE cognito_sub = ANY($1)`, [subs]);
    } finally {
      await su.end();
    }
  }, 60_000);

  it('totals reflect seeded fixtures', async () => {
    const row = await asConsole(consoleUrl, async (c) =>
      (await c.query('SELECT * FROM admin_analytics_totals()')).rows[0]);
    expect(Number(row.total_workers)).toBeGreaterThanOrEqual(1);
    expect(Number(row.total_employers)).toBeGreaterThanOrEqual(2);
    expect(Number(row.paying_employers)).toBeGreaterThanOrEqual(1);
    expect(Number(row.jobs_active)).toBeGreaterThanOrEqual(1);
    expect(Number(row.jobs_closed)).toBeGreaterThanOrEqual(1);
  });

  it('signups bucket by day within the window', async () => {
    const res = await asConsole(consoleUrl, (c) =>
      c.query(`SELECT * FROM admin_analytics_signups(now() - interval '7 days', 'day')`));
    const workers = res.rows.reduce((n, r) => n + Number(r.worker_signups), 0);
    const employers = res.rows.reduce((n, r) => n + Number(r.employer_signups), 0);
    expect(workers).toBeGreaterThanOrEqual(1);
    expect(employers).toBeGreaterThanOrEqual(2);
  });

  it('jobs activity excludes rows before p_from', async () => {
    const res = await asConsole(consoleUrl, (c) =>
      c.query(`SELECT * FROM admin_analytics_jobs_activity(now() - interval '7 days', 'day')`));
    const posted = res.rows.reduce((n, r) => n + Number(r.jobs_posted), 0);
    const applied = res.rows.reduce((n, r) => n + Number(r.applications_submitted), 0);
    expect(posted).toBeGreaterThanOrEqual(1); // active job only; 40-day-old closed job excluded
    expect(applied).toBeGreaterThanOrEqual(1);

    // Prove the exclusion rather than merely asserting a lower bound: every
    // check above is `>=`, so they would all still pass if p_from were ignored
    // outright. Widening the window to 60 days must pull in exactly the one
    // extra seeded row the 7-day window leaves out — the 40-day-old closed job.
    const wide = await asConsole(consoleUrl, (c) =>
      c.query(`SELECT * FROM admin_analytics_jobs_activity(now() - interval '60 days', 'day')`));
    const widePosted = wide.rows.reduce((n, r) => n + Number(r.jobs_posted), 0);
    expect(widePosted).toBe(posted + 1);

    // And that extra row lands in its own UTC day bucket, absent from the 7d
    // result. Read the expected bucket as the superuser — the console role has
    // no grant on `jobs` (see the privilege test below), by design.
    const su = new Client({ connectionString: superUrl });
    await su.connect();
    let closedBucket: Date;
    try {
      closedBucket = (await su.query(
        `SELECT date_trunc('day', created_at, 'UTC') AS b FROM jobs WHERE id = $1`,
        [jobClosedId],
      )).rows[0].b;
    } finally {
      await su.end();
    }
    const bucketKeys = (rows: any[]) => rows.map((r) => new Date(r.bucket_start).toISOString());
    expect(bucketKeys(wide.rows)).toContain(new Date(closedBucket).toISOString());
    expect(bucketKeys(res.rows)).not.toContain(new Date(closedBucket).toISOString());
  });

  it('message traffic counts in-app and whatsapp sources', async () => {
    const res = await asConsole(consoleUrl, (c) =>
      c.query(`SELECT * FROM admin_analytics_message_traffic(now() - interval '7 days', 'day')`));
    const sum = (key: string) => res.rows.reduce((n, r) => n + Number(r[key]), 0);
    expect(sum('job_messages_out')).toBeGreaterThanOrEqual(2);
    expect(sum('job_messages_in')).toBeGreaterThanOrEqual(1);
    expect(sum('job_messages_failed')).toBeGreaterThanOrEqual(1);
    expect(sum('wa_inbound')).toBeGreaterThanOrEqual(2);
    expect(sum('wa_outbound')).toBeGreaterThanOrEqual(2);
    expect(sum('wa_failed')).toBeGreaterThanOrEqual(1);
  });

  it('paying employers lists business display name, not PII', async () => {
    const res = await asConsole(consoleUrl, (c) =>
      c.query('SELECT * FROM admin_analytics_paying_employers()'));
    const mine = res.rows.find((r) => r.employer_id === employer1Id);
    expect(mine).toBeDefined();
    expect(mine.display_name).toBe('IT Analytics Co');
    expect(mine.plan_code).toBe(PLAN);
    expect(mine.status).toBe('active');
    expect(res.rows.some((r) => r.employer_id === employer2Id)).toBe(false); // canceled excluded
  });

  it('rejects invalid bucket argument', async () => {
    await expect(asConsole(consoleUrl, (c) =>
      c.query(`SELECT * FROM admin_analytics_signups(now(), 'hour')`),
    )).rejects.toThrow(/admin_analytics_invalid_bucket/);
  });

  it('console role still cannot read source tables directly', async () => {
    // `users` is deliberately NOT in this list. jale_admin_console has had
    // column-level SELECT on users plus the `users_admin_console_read`
    // (USING true) policy since the admin-panel migrations (026/027) — that
    // predates 086 and is what the existing admin console screens run on.
    // The four below have no console grant at all, so the definer functions
    // are the console's only path to them; that is the property 086 must not
    // regress.
    for (const table of ['jobs', 'subscriptions', 'job_conversation_messages', 'whatsapp_processed_messages']) {
      await expect(asConsole(consoleUrl, (c) =>
        c.query(`SELECT count(*) FROM ${table}`),
      )).rejects.toThrow(/permission denied/);
    }
  });
});
