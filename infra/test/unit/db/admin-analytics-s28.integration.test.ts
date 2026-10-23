/**
 * admin-analytics-s28.integration.test.ts
 *
 * PostgreSQL-backed tests for migration 123 (sprint 28, the analytics read
 * side): paying employers by week, resets by reason, open cases by age and
 * resolution times, onboarding step by step, the identity verification
 * funnel, candidate ranking freshness, the billing inbox's 24-hour failures,
 * and the Home metrics and health figures. Every function is called as the
 * admin console login (jale_admin_console), the way the console calls it.
 *
 * The functions aggregate the whole database, so counts are asserted as a
 * delta between a baseline call (before the fixtures) and a call after them.
 * Fixture accounts, jobs, cases and challenges are new, so their counts add
 * up. Medians cannot be asserted as deltas: those tests first assert that
 * the baseline has nothing to time in the fixtures' weeks, then the exact
 * values. Every account a section does not mean to count is created long
 * before every window.
 *
 * Fixtures are inserted as the superuser with session_replication_role =
 * replica, so no trigger moves a timestamp or writes a history row: the
 * history rows (subscription status, challenge events, case events) are
 * inserted explicitly. Every time comes from the database clock (now() when
 * the suite starts): weekly fixtures are anchored to Monday 00:00 UTC of the
 * previous weeks (W1, W2, W3), current-state fixtures sit well away from
 * every bucket edge. A suite starting less than 5 minutes before Monday
 * 00:00 UTC first waits until that Monday has begun.
 *
 * Connection: set JALE_TEST_DATABASE_URL to a disposable Postgres 16 with the
 * full chain applied, as a superuser. When absent the suite is explicitly
 * skipped and says so (no silent skips).
 *   bash infra/db/local/bootstrap-testbed.sh --ephemeral --keep --no-tests --ref none
 *   then: cd infra && JALE_TEST_DATABASE_URL=<printed url> npx jest --runInBand test/unit/db/admin-analytics-s28.integration.test.ts
 *
 * Always pass --runInBand: the assertions are whole-database deltas.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { Client } from 'pg';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { dropCompanies, ensureOwnerCompany } from './helpers/org-fixtures';

const databaseUrl = process.env.JALE_TEST_DATABASE_URL;

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const OPERATOR = 'it-123';
const MARK = 'it-123 fixture';
const PLAN = 'it-123-plan';
const EVENT_PREFIX = 'evt_it123_';

const GATE = "(current_setting('app.admin_analytics_read'::text, true) = 'on'::text)";
const WEEKLY = [
  'admin_analytics_paying_weekly', 'admin_analytics_case_resolution', 'admin_analytics_identity_funnel',
] as const;
const FUNCTIONS = [
  'public.admin_analytics_paying_weekly(integer)',
  'public.admin_analytics_reset_reasons(integer)',
  'public.admin_analytics_case_aging()',
  'public.admin_analytics_case_resolution(integer)',
  'public.admin_analytics_onboarding_steps(integer, text)',
  'public.admin_analytics_identity_funnel(integer)',
  'public.admin_analytics_ranking_freshness()',
  'public.admin_analytics_billing_inbox_now()',
  'public.admin_analytics_home_metrics()',
  'public.admin_analytics_system_health()',
];
const STEP_ORDER = [
  'start.choose_language', 'identity.verify_otp', 'legal.review', 'profile.voice_choice',
  'profile.voice_processing', 'profile.name', 'profile.location', 'profile.trade', 'profile.custom_trade',
  'profile.experience', 'profile.transportation', 'profile.availability', 'trust.question.1',
  'trust.question.2', 'trust.question.3', 'profile.photo', 'profile.photo_type',
];
const RESET_CODES = ['codes_not_arriving', 'worker_confused', 'typo_in_details', 'identity_confirmed_elsewhere', 'other'];

type Row = Record<string, unknown>;

/**
 * A statement the console runs, read from admin/src/lib/server/admin-analytics.ts
 * (the module that runs it) and never copied, so a renamed column or function
 * fails here instead of in production.
 */
function consoleAnalyticsSql(name: 'HOME_METRICS_SQL' | 'SYSTEM_HEALTH_SQL'): string {
  const source = fs.readFileSync(
    path.join(__dirname, '..', '..', '..', '..', 'admin', 'src', 'lib', 'server', 'admin-analytics.ts'), 'utf8');
  const m = source.match(new RegExp(`export const ${name} = \`([^\`]*)\`;`));
  if (!m) throw new Error(`admin-analytics.ts: template const ${name} not found`);
  return m[1];
}

function urlForRole(baseUrl: string, user: string, password: string): string {
  const u = new URL(baseUrl);
  u.username = user;
  u.password = password;
  return u.toString();
}

async function withClient<T>(url: string, fn: (c: Client) => Promise<T>): Promise<T> {
  const client = new Client({ connectionString: url });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}

async function rowsOf(url: string, sql: string, args: unknown[] = []): Promise<Row[]> {
  return withClient(url, async (c) => (await c.query(sql, args)).rows);
}

async function errorOf(url: string, sql: string, args: unknown[] = []): Promise<{ code?: string; message: string } | null> {
  try {
    await rowsOf(url, sql, args);
    return null;
  } catch (e) {
    const err = e as { code?: string; message: string };
    return { code: err.code, message: err.message };
  }
}

/** Monday 00:00 UTC of the week containing `d` (Postgres date_trunc('week', d, 'UTC')). */
function isoWeekStart(d: Date): Date {
  const day = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  return new Date(day.getTime() - ((day.getUTCDay() + 6) % 7) * DAY);
}

const iso = (v: unknown): string | null => (v === null ? null : new Date(v as Date).toISOString());
const num = (v: unknown): number | null => (v === null ? null : Number(v));
const phoneHash = (phone: string): string => createHash('sha256').update(phone.trim()).digest('hex');
/** A random +52 664 number (synthetic). */
const freshPhone = (): string => `+52664${String(1_000_000 + (randomBytes(3).readUIntBE(0, 3) % 9_000_000))}`;

async function dbNow(url: string): Promise<number> {
  return withClient(url, async (c) => ((await c.query('SELECT now() AS n')).rows[0].n as Date).getTime());
}

/** Per-key numeric columns of after minus before (a key missing before counts from zero). */
function deltaBy(before: Row[], after: Row[], keyOf: (r: Row) => string, cols: readonly string[]): Map<string, Record<string, number>> {
  const base = new Map(before.map((r) => [keyOf(r), r]));
  return new Map(after.map((r) => {
    const b = base.get(keyOf(r));
    return [keyOf(r), Object.fromEntries(cols.map((c) => [c, Number(r[c]) - Number(b?.[c] ?? 0)]))];
  }));
}

const maybeDescribe = databaseUrl ? describe : describe.skip;
if (!databaseUrl) {
  // eslint-disable-next-line no-console
  console.warn('JALE_TEST_DATABASE_URL not set — skipping the 123 admin analytics integration tests');
}

maybeDescribe('sprint 28 admin analytics read side (123)', () => {
  let superUrl = '';
  let consoleUrl = '';
  let T = 0;
  let monday = new Date(0);
  let W1 = new Date(0);
  let W2 = new Date(0);
  let W3 = new Date(0);
  let OLD = new Date(0);
  const plus = (d: Date, ms: number): Date => new Date(d.getTime() + ms);
  const ago = (ms: number): Date => new Date(T - ms);

  const call = {
    paying: (url: string, weeks = 4) => rowsOf(url, 'SELECT * FROM admin_analytics_paying_weekly($1)', [weeks]),
    resets: (url: string, days = 30) => rowsOf(url, 'SELECT * FROM admin_analytics_reset_reasons($1)', [days]),
    aging: (url: string) => rowsOf(url, 'SELECT * FROM admin_analytics_case_aging()'),
    resolution: (url: string, weeks = 4) => rowsOf(url, 'SELECT * FROM admin_analytics_case_resolution($1)', [weeks]),
    steps: (url: string, door: string, weeks = 4) => rowsOf(url, 'SELECT * FROM admin_analytics_onboarding_steps($1, $2)', [weeks, door]),
    identity: (url: string, weeks = 2) => rowsOf(url, 'SELECT * FROM admin_analytics_identity_funnel($1)', [weeks]),
    rankings: (url: string) => rowsOf(url, 'SELECT * FROM admin_analytics_ranking_freshness()'),
    billingNow: (url: string) => rowsOf(url, 'SELECT * FROM admin_analytics_billing_inbox_now()'),
    home: (url: string) => rowsOf(url, 'SELECT * FROM admin_analytics_home_metrics()'),
    health: (url: string) => rowsOf(url, 'SELECT * FROM admin_analytics_system_health()'),
  };
  const before = {} as Record<string, Row[]>;
  const after = {} as Record<string, Row[]>;
  const snapshot = async (into: Record<string, Row[]>): Promise<void> => {
    into.paying = await call.paying(consoleUrl);
    into.resets = await call.resets(consoleUrl);
    into.aging = await call.aging(consoleUrl);
    into.resolution = await call.resolution(consoleUrl);
    into.stepsAll = await call.steps(consoleUrl, 'all');
    into.stepsWhatsapp = await call.steps(consoleUrl, 'whatsapp');
    into.stepsWeb = await call.steps(consoleUrl, 'web');
    into.identity = await call.identity(consoleUrl);
    into.rankings = await call.rankings(consoleUrl);
    into.billingNow = await call.billingNow(consoleUrl);
    into.home = await call.home(consoleUrl);
    into.health = await call.health(consoleUrl);
  };

  // Fixture ids, for the expectations and the cleanup.
  const users: string[] = [];
  const employerCreated: Date[] = [];
  const jobs: string[] = [];
  const cases: string[] = [];
  const challenges: string[] = [];
  const phones: string[] = [];
  const companies: string[] = [];

  /** Runs `fn` in one superuser transaction with triggers suppressed. */
  async function seed(fn: (c: Client) => Promise<void>): Promise<void> {
    await withClient(superUrl, async (c) => {
      await c.query('BEGIN');
      await c.query('SET LOCAL session_replication_role = replica');
      await fn(c);
      await c.query('COMMIT');
    });
  }

  /** A user; `test` makes it a test account (a seed- subject). Non-test employers are tracked for the denominator. */
  const user = async (c: Client, type: 'worker' | 'employer', createdAt: Date = OLD, o: { test?: boolean; phone?: string } = {}): Promise<string> => {
    const sub = `${o.test ? 'seed-' : ''}${OPERATOR}-${randomBytes(6).toString('hex')}`;
    const id = (await c.query(
      `INSERT INTO users (cognito_sub, user_type, whatsapp_number, created_at, updated_at) VALUES ($1, $2, $3, $4, $4) RETURNING id`,
      [sub, type, o.phone ?? null, createdAt],
    )).rows[0].id as string;
    users.push(id);
    if (type === 'employer' && !o.test) employerCreated.push(createdAt);
    return id;
  };

  const job = async (c: Client, employerId: string, status: string, createdAt: Date): Promise<string> => {
    const id = (await c.query(
      `INSERT INTO jobs (employer_id, title, location, job_type, status, created_at, updated_at)
       VALUES ($1, $2, 'Tijuana', 'full-time', $3, $4, $4) RETURNING id`,
      [employerId, MARK, status, createdAt],
    )).rows[0].id as string;
    jobs.push(id);
    return id;
  };

  const application = async (c: Client, jobId: string, at: Date, hiredAt: Date | null = null): Promise<[string, string]> => {
    const workerId = await user(c, 'worker');
    const appId = (await c.query(
      `INSERT INTO job_applications (job_id, worker_id, status, applied_at, created_at, updated_at, hired_at)
       VALUES ($1, $2, $3, $4, $4, $4, $5) RETURNING id`,
      [jobId, workerId, hiredAt ? 'hired' : 'pending', at, hiredAt],
    )).rows[0].id as string;
    return [appId, workerId];
  };

  const adminCase = async (
    c: Client, status: string, createdAt: Date, changedAt: Date, o: { userId?: string | null; resolvedAt?: Date | null } = {},
  ): Promise<string> => {
    const id = (await c.query(
      `INSERT INTO admin_cases (case_type, status, priority, user_id, summary, created_at, updated_at, status_changed_at, resolved_at)
       VALUES ('help_request', $1, 50, $2, $3, $4, $4, $5, $6) RETURNING id`,
      [status, o.userId ?? null, MARK, createdAt, changedAt, o.resolvedAt ?? null],
    )).rows[0].id as string;
    cases.push(id);
    return id;
  };

  const caseEvent = async (c: Client, caseId: string, from: string, to: string, at: Date): Promise<void> => {
    await c.query(
      `INSERT INTO admin_case_events (case_id, event_type, actor_type, payload, created_at)
       VALUES ($1, 'status_changed', 'admin', $2::jsonb, $3)`,
      [caseId, JSON.stringify({ title: 'Status changed', from, to }), at],
    );
  };

  type ChallengeOpts = {
    step?: string; status?: string; attempts?: number; expiresAt?: Date | null;
    candidate?: string | null; verifiedUser?: string | null; phone?: string;
  };
  const challenge = async (c: Client, createdAt: Date, o: ChallengeOpts = {}): Promise<string> => {
    const phone = o.phone ?? freshPhone();
    phones.push(phone);
    const id = (await c.query(
      `INSERT INTO worker_identity_challenges
         (phone_hash, current_step_key, status, attempts, expires_at, candidate_user_id, verified_user_id, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $8) RETURNING id`,
      [phoneHash(phone), o.step ?? 'identity.verify_otp', o.status ?? 'pending', o.attempts ?? 0, o.expiresAt ?? null,
        o.candidate ?? null, o.verifiedUser ?? null, createdAt],
    )).rows[0].id as string;
    challenges.push(id);
    return id;
  };

  type Ev = [from: string | null, to: string, attempts: number, at: Date];
  const challengeEvents = async (c: Client, challengeId: string, events: Ev[], backfill = false): Promise<void> => {
    for (const [from, to, attempts, at] of events) {
      await c.query(
        `INSERT INTO worker_identity_challenge_events (challenge_id, from_status, to_status, attempts, changed_at, is_backfill)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [challengeId, from, to, attempts, at, backfill],
      );
    }
  };

  beforeAll(async () => {
    superUrl = databaseUrl!;
    await withClient(superUrl, (c) => c.query(`ALTER ROLE jale_admin_console WITH PASSWORD 'test-adminconsole-pw'`));
    consoleUrl = urlForRole(superUrl, 'jale_admin_console', 'test-adminconsole-pw');

    T = await dbNow(superUrl);
    const nextMonday = isoWeekStart(new Date(T)).getTime() + 7 * DAY;
    if (nextMonday - T < 5 * MIN) {
      while ((await dbNow(superUrl)) < nextMonday + 1_000) {
        await new Promise((resolve) => setTimeout(resolve, 5_000));
      }
      T = await dbNow(superUrl);
    }
    monday = isoWeekStart(new Date(T));
    W1 = new Date(monday.getTime() - 7 * DAY);
    W2 = new Date(monday.getTime() - 14 * DAY);
    W3 = new Date(monday.getTime() - 21 * DAY);
    OLD = new Date(T - 400 * DAY);

    await snapshot(before);

    // ── #2 paying employers. E1 pays from W2 and cancels in W1; E2 starts a
    // trial in W1 and keeps it; E3 signs up in W1 and never pays; a test
    // employer pays from W2 and counts nowhere.
    await seed(async (c) => {
      await c.query(
        `INSERT INTO billing_plans (code, audience, display_name, entitlements) VALUES ($1, 'employer', 'IT 123 plan', '{}')
         ON CONFLICT (code) DO NOTHING`, [PLAN]);
      const subscription = async (userId: string, status: string, history: [string | null, string, Date, boolean?][]): Promise<void> => {
        // A subscription belongs to the payer's company (127). seed() runs with
        // triggers off, so the row names its company itself.
        const org = await ensureOwnerCompany(c, userId);
        companies.push(org);
        const subId = (await c.query(
          `INSERT INTO subscriptions (user_id, organization_id, plan_code, status) VALUES ($1, $4, $2, $3) RETURNING id`,
          [userId, PLAN, status, org],
        )).rows[0].id as string;
        for (const [from, to, at, backfill] of history) {
          await c.query(
            `INSERT INTO subscription_status_history
               (subscription_id, user_id, from_status, to_status, plan_code, cancel_at_period_end, changed_at, is_backfill)
             VALUES ($1, $2, $3, $4, $5, false, $6, $7)`,
            [subId, userId, from, to, PLAN, at, backfill ?? false],
          );
        }
      };
      const e1 = await user(c, 'employer', plus(W3, HOUR));
      const e2 = await user(c, 'employer', plus(W3, HOUR));
      await user(c, 'employer', plus(W1, 3 * DAY));
      const eTest = await user(c, 'employer', plus(W3, HOUR), { test: true });
      await subscription(e1, 'canceled', [[null, 'active', plus(W2, DAY)], ['active', 'canceled', plus(W1, DAY)]]);
      await subscription(e2, 'trialing', [[null, 'trialing', plus(W1, 2 * DAY)]]);
      await subscription(eTest, 'active', [[null, 'active', plus(W2, DAY)]]);
    });

    // ── #5 resets by reason (last 30 days). Lockout resets: two "codes not
    // arriving", one "other"; one 40 days ago and one of a test account's
    // challenge are left out. Operator resets: two real ones; a dry run, a
    // test account's and one 31 days ago are left out.
    await seed(async (c) => {
      const testWorker = await user(c, 'worker', OLD, { test: true });
      const lockout = async (code: string, at: Date, o: { candidate?: string; note?: string } = {}): Promise<void> => {
        const ch = await challenge(c, OLD, { candidate: o.candidate ?? null });
        const hash = (await c.query('SELECT phone_hash FROM worker_identity_challenges WHERE id = $1', [ch])).rows[0].phone_hash;
        await c.query(
          `INSERT INTO identity_lockout_resets (challenge_id, phone_hash, reason_code, note, created_at)
           VALUES ($1, $2, $3, $4, $5)`,
          [ch, hash, code, o.note ?? (code === 'other' ? MARK : null), at],
        );
      };
      await lockout('codes_not_arriving', ago(2 * DAY));
      await lockout('codes_not_arriving', ago(10 * DAY));
      await lockout('other', ago(3 * DAY));
      await lockout('worker_confused', ago(40 * DAY));
      await lockout('typo_in_details', ago(DAY), { candidate: testWorker });
      const reset = async (userId: string, at: Date, dryRun = false): Promise<void> => {
        await c.query(
          `INSERT INTO worker_reset_audit (user_id, phone_hash, operator, reason, dry_run, created_at) VALUES ($1, $2, $3, $4, $5, $6)`,
          [userId, phoneHash(freshPhone()), OPERATOR, MARK, dryRun, at],
        );
      };
      await reset(await user(c, 'worker'), ago(DAY));
      await reset(await user(c, 'worker'), ago(20 * DAY));
      await reset(await user(c, 'worker'), ago(DAY), true);
      await reset(testWorker, ago(DAY));
      await reset(await user(c, 'worker'), ago(31 * DAY));
    });

    // ── #6 open cases by age and resolution times.
    await seed(async (c) => {
      const testWorker = await user(c, 'worker', OLD, { test: true });
      await adminCase(c, 'open', ago(30 * DAY), ago(30 * MIN));
      await adminCase(c, 'pending_admin', ago(30 * DAY), ago(2 * HOUR));
      await adminCase(c, 'pending_worker', ago(30 * DAY), ago(5 * HOUR));
      await adminCase(c, 'open', ago(30 * DAY), ago(2 * DAY));
      await adminCase(c, 'pending_worker', ago(30 * DAY), ago(4 * DAY));
      // Closed long before every resolution window.
      await adminCase(c, 'resolved', ago(30 * DAY), ago(29 * DAY), { resolvedAt: ago(29 * DAY) });
      await adminCase(c, 'open', ago(30 * DAY), ago(30 * MIN), { userId: testWorker });

      // Resolutions: two in W2 (10 h and 30 h after opening), one in W1
      // resolved before the timeline existed (no event: resolved_at, 4 h);
      // a case created already resolved, a dismissal and a test account's
      // case are left out. R1 was reopened and resolved again: both count.
      const r1 = await adminCase(c, 'resolved', W2, plus(W2, 10 * HOUR), { resolvedAt: plus(W2, 10 * HOUR) });
      await caseEvent(c, r1, 'open', 'resolved', plus(W2, 10 * HOUR));
      const r2 = await adminCase(c, 'resolved', W2, plus(W2, 30 * HOUR), { resolvedAt: plus(W2, 30 * HOUR) });
      await caseEvent(c, r2, 'pending_worker', 'resolved', plus(W2, 30 * HOUR));
      await adminCase(c, 'resolved', W1, plus(W1, 4 * HOUR), { resolvedAt: plus(W1, 4 * HOUR) });
      await adminCase(c, 'resolved', plus(W1, 5 * HOUR), plus(W1, 5 * HOUR), { resolvedAt: plus(W1, 5 * HOUR) });
      const dismissed = await adminCase(c, 'dismissed', W1, plus(W1, 6 * HOUR), { resolvedAt: plus(W1, 6 * HOUR) });
      await caseEvent(c, dismissed, 'open', 'dismissed', plus(W1, 6 * HOUR));
      const testCase = await adminCase(c, 'resolved', W1, plus(W1, 7 * HOUR), { userId: testWorker, resolvedAt: plus(W1, 7 * HOUR) });
      await caseEvent(c, testCase, 'open', 'resolved', plus(W1, 7 * HOUR));
      const reopened = await adminCase(c, 'resolved', W2, plus(W1, 2 * HOUR), { resolvedAt: plus(W1, 2 * HOUR) });
      await caseEvent(c, reopened, 'open', 'resolved', plus(W2, 20 * HOUR));
      await caseEvent(c, reopened, 'resolved', 'open', plus(W2, 21 * HOUR));
      await caseEvent(c, reopened, 'open', 'resolved', plus(W1, 2 * HOUR));
    });

    // ── #14 onboarding step by step, cohort week W3. P1 (WhatsApp) takes
    // the voice branch; P2 (WhatsApp) types its profile and picks "other"
    // trade; P3 (WhatsApp) never chose a language step's code; P4 (WhatsApp)
    // reached the code and stopped; P5 (web) reached the name step. A test
    // account's web signup is left out.
    await seed(async (c) => {
      const conversation = async (phone: string, userId: string | null, at: Date): Promise<void> => {
        phones.push(phone);
        await c.query(
          `INSERT INTO whatsapp_conversations (whatsapp_number, user_id, created_at, updated_at) VALUES ($1, $2, $3, $3)`,
          [phone, userId, at],
        );
      };
      const run = async (userId: string, moves: [string | null, string, string, Date][]): Promise<void> => {
        const runId = (await c.query(
          `INSERT INTO worker_workflow_runs (user_id, workflow_version, current_step_key, status, created_at, updated_at)
           VALUES ($1, 2, $2, 'active', $3, $3) RETURNING id`,
          [userId, moves[moves.length - 1][1], moves[0][3]],
        )).rows[0].id as string;
        for (const [from, to, reason, at] of moves) {
          await c.query(
            `INSERT INTO worker_workflow_transitions (run_id, from_step_key, to_step_key, reason, created_at) VALUES ($1, $2, $3, $4, $5)`,
            [runId, from, to, reason, at],
          );
        }
      };
      const h = (hours: number): Date => plus(W3, hours * HOUR);

      const p1Phone = freshPhone();
      const p1 = await user(c, 'worker', h(2), { phone: p1Phone });
      await conversation(p1Phone, p1, h(1));
      await challenge(c, h(1), { status: 'verified', verifiedUser: p1, phone: p1Phone });
      await run(p1, [
        ['identity.verify_otp', 'legal.review', 'otp_verified', h(2)],
        ['legal.review', 'profile.voice_choice', 'legal_accept', h(3)],
        ['profile.voice_choice', 'profile.voice_processing', 'profile_voice_received', h(4)],
        ['profile.voice_processing', 'profile.location', 'profile_voice_extracted', h(5)],
      ]);

      const p2Phone = freshPhone();
      const p2 = await user(c, 'worker', h(2), { phone: p2Phone });
      await conversation(p2Phone, p2, h(1));
      await challenge(c, h(1), { status: 'verified', verifiedUser: p2, phone: p2Phone });
      await run(p2, [
        ['identity.verify_otp', 'legal.review', 'otp_verified', h(2)],
        ['legal.review', 'profile.voice_choice', 'legal_accept', h(3)],
        ['profile.voice_choice', 'profile.name', 'profile_voice_choice_opted_text', h(4)],
        ['profile.name', 'profile.location', 'profile_name_recorded', h(5)],
        ['profile.location', 'profile.trade', 'profile_location_recorded', h(6)],
        ['profile.trade', 'profile.custom_trade', 'profile_trade_recorded', h(7)],
        ['profile.custom_trade', 'profile.experience', 'profile_custom_trade_recorded', h(8)],
      ]);

      const p3Phone = freshPhone();
      await conversation(p3Phone, null, h(1));
      await challenge(c, h(1), { step: 'start.choose_language', phone: p3Phone });

      const p4Phone = freshPhone();
      await conversation(p4Phone, null, h(1));
      await challenge(c, h(1), { step: 'identity.verify_otp', phone: p4Phone, expiresAt: h(2) });

      const p5 = await user(c, 'worker', h(3));
      await run(p5, [
        [null, 'legal.review', 'web_start', h(3)],
        ['legal.review', 'profile.voice_choice', 'legal_accept', h(4)],
        ['profile.voice_choice', 'profile.name', 'profile_voice_choice_opted_text', h(5)],
      ]);

      const pTest = await user(c, 'worker', h(3), { test: true });
      await run(pTest, [[null, 'legal.review', 'web_start', h(3)]]);
    });

    // ── #15 identity verification, challenges created in W1 (a 2-week
    // window). C1: one wrong code, verified 10 min after starting. C2: two
    // wrong codes, then the third locks it. C3: reached the code and let it
    // expire. C4: never reached the code. C5: verified first time, 30 min.
    // C6: only a backfill row (verified, 2 wrong codes): counted, never
    // timed. A test account's challenge and one from W3 are left out.
    await seed(async (c) => {
      const h = (hours: number, minutes = 0): Date => plus(W1, hours * HOUR + minutes * MIN);
      const c1 = await challenge(c, h(1), { status: 'verified', attempts: 1 });
      await challengeEvents(c, c1, [[null, 'pending', 0, h(1)], ['pending', 'pending', 1, h(1, 5)], ['pending', 'verified', 1, h(1, 10)]]);
      const c2 = await challenge(c, h(2), { status: 'locked', attempts: 2 });
      await challengeEvents(c, c2, [[null, 'pending', 0, h(2)], ['pending', 'pending', 1, h(2, 1)],
        ['pending', 'pending', 2, h(2, 2)], ['pending', 'locked', 2, h(2, 3)]]);
      const c3 = await challenge(c, h(3), { status: 'pending', expiresAt: h(3, 10) });
      await challengeEvents(c, c3, [[null, 'pending', 0, h(3)]]);
      const c4 = await challenge(c, h(4), { step: 'start.choose_language' });
      await challengeEvents(c, c4, [[null, 'pending', 0, h(4)]]);
      const c5 = await challenge(c, h(5), { status: 'verified' });
      await challengeEvents(c, c5, [[null, 'pending', 0, h(5)], ['pending', 'verified', 0, h(5, 30)]]);
      const c6 = await challenge(c, h(6), { status: 'verified', attempts: 2 });
      await challengeEvents(c, c6, [[null, 'verified', 2, h(6, 20)]], true);
      const testWorker = await user(c, 'worker', OLD, { test: true });
      const c7 = await challenge(c, h(7), { status: 'verified', verifiedUser: testWorker });
      await challengeEvents(c, c7, [[null, 'pending', 0, h(7)], ['pending', 'verified', 0, h(7, 1)]]);
      const c8 = await challenge(c, plus(W3, 2 * HOUR), { status: 'verified' });
      await challengeEvents(c, c8, [[null, 'pending', 0, plus(W3, 2 * HOUR)], ['pending', 'verified', 0, plus(W3, 3 * HOUR)]]);
    });

    // ── #19 ranking freshness (active jobs of real employers). J1 ranked
    // 30 min ago by the model; J2 ranked 2 days ago by the fallback; J3 has
    // an application and no ranking. A closed job and a test employer's job
    // are left out.
    await seed(async (c) => {
      const rank = async (jobId: string, at: Date, version: string): Promise<void> => {
        const [appId, workerId] = await application(c, jobId, ago(2 * DAY));
        await c.query(
          `INSERT INTO employer_candidate_rankings
             (job_id, worker_id, application_id, rank, score, score_band, reasons, ranking_version, model_id, source_hash, status, computed_at)
           VALUES ($1, $2, $3, 1, 80, 'strong', '[]', $4, $5, 'it-123', 'ready', $6)`,
          [jobId, workerId, appId, version, version === 'sql-v1' ? null : 'it-123-model', at],
        );
      };
      const employer = await user(c, 'employer');
      await rank(await job(c, employer, 'active', ago(DAY)), ago(30 * MIN), 'ai-v2');
      await rank(await job(c, employer, 'active', ago(3 * DAY)), ago(2 * DAY), 'sql-v1');
      await application(c, await job(c, employer, 'active', ago(DAY)), ago(HOUR));
      await rank(await job(c, employer, 'closed', ago(9 * DAY)), ago(5 * DAY), 'ai-v2');
      const testEmployer = await user(c, 'employer', OLD, { test: true });
      await rank(await job(c, testEmployer, 'active', ago(DAY)), ago(10 * HOUR), 'ai-v2');
    });

    // ── Billing inbox: failed 30 min ago (now and 24 h), failed 5 h ago
    // (24 h only), failed 30 h ago (neither).
    await seed(async (c) => {
      for (const at of [ago(30 * MIN), ago(5 * HOUR), ago(30 * HOUR)]) {
        await c.query(
          `INSERT INTO billing_webhook_events (stripe_event_id, event_type, processing_status, attempt_count, received_at)
           VALUES ($1, 'invoice.paid', 'failed', 3, $2)`,
          [`${EVENT_PREFIX}${randomBytes(8).toString('hex')}`, at],
        );
      }
    });

    // ── Home metrics: three hires in the last 30 days on two jobs; a hire
    // 40 days ago and a test employer's hire are left out; one active job
    // idle for 20 days is stale.
    await seed(async (c) => {
      const employer = await user(c, 'employer');
      const hj1 = await job(c, employer, 'active', ago(3 * DAY));
      await application(c, hj1, ago(3 * DAY), ago(2 * DAY));
      await application(c, hj1, ago(3 * DAY), ago(2 * DAY));
      await application(c, await job(c, employer, 'filled', ago(3 * DAY)), ago(3 * DAY), ago(DAY));
      await application(c, await job(c, employer, 'closed', ago(50 * DAY)), ago(45 * DAY), ago(40 * DAY));
      const testEmployer = await user(c, 'employer', OLD, { test: true });
      await application(c, await job(c, testEmployer, 'active', ago(3 * DAY)), ago(3 * DAY), ago(2 * DAY));
      await job(c, employer, 'active', ago(20 * DAY));
    });

    // ── System health: WhatsApp sends of the last 24 hours that gave up or
    // failed on delivery (2 here, 1 employer message below); an open one, one
    // still retrying and one 30 h old are not. Voice notes of the last 7
    // days: 2 usable, 1 failed, 1 completed with the wrong shape (4
    // finished); a pending one, a test profile and one 8 days old are not.
    await seed(async (c) => {
      const wa = async (created: Date, status: string, attempts: number, delivery: string | null = null): Promise<void> => {
        await c.query(
          `INSERT INTO whatsapp_outbox
             (id, inbound_message_sid, sequence, whatsapp_number, body, status, attempt_count, created_at, sent_at,
              source_type, source_id, twilio_delivery_status)
           VALUES ($1, NULL, 1, $2, $3, $4, $5, $6, $7, 'admin_case', $8, $9)`,
          [randomUUID(), freshPhone(), MARK, status, attempts, created, status === 'sent' ? created : null, randomUUID(), delivery],
        );
      };
      await wa(ago(2 * HOUR), 'failed', 5);
      await wa(ago(3 * HOUR), 'sent', 1, 'undelivered');
      await wa(ago(HOUR), 'pending', 0);
      await wa(ago(4 * HOUR), 'failed', 2);
      await wa(ago(30 * HOUR), 'failed', 5);

      const employer = await user(c, 'employer');
      const jobId = await job(c, employer, 'closed', ago(10 * DAY));
      const [appId, workerId] = await application(c, jobId, ago(10 * DAY));
      const convId = (await c.query(
        `INSERT INTO job_conversations (job_id, employer_id, worker_id, application_id, status, created_at, updated_at)
         VALUES ($1, $2, $3, $4, 'open', $5, $5) RETURNING id`,
        [jobId, employer, workerId, appId, ago(10 * DAY)],
      )).rows[0].id as string;
      await c.query(
        `INSERT INTO job_message_outbox (conversation_id, whatsapp_number, send_kind, body, status, attempt_count, created_at, sent_at)
         VALUES ($1, $2, 'freeform', $3, 'failed', 1, $4, $4)`,
        [convId, freshPhone(), MARK, ago(2 * HOUR)],
      );

      const worker = await user(c, 'worker');
      const voice = async (created: Date, status: string, o: { fields?: unknown; test?: boolean } = {}): Promise<void> => {
        await c.query(
          `INSERT INTO worker_profile_ai_extractions
             (user_id, bedrock_model_id, status, extracted_fields, confidence_scores, ai_test_profile, created_at, updated_at)
           VALUES ($1, 'it-123-model', $2, $3::jsonb, $4::jsonb, $5, $6, $6)`,
          [worker, status, o.fields === undefined ? null : JSON.stringify(o.fields),
            o.fields === undefined ? null : JSON.stringify({}), o.test ?? false, created],
        );
      };
      await voice(ago(DAY), 'completed', { fields: {} });
      await voice(ago(2 * DAY), 'completed', { fields: {} });
      await voice(ago(3 * DAY), 'failed');
      await voice(ago(4 * DAY), 'completed', { fields: [] });
      await voice(ago(HOUR), 'pending');
      await voice(ago(DAY), 'completed', { fields: {}, test: true });
      await voice(ago(8 * DAY), 'completed', { fields: {} });
    });

    await snapshot(after);
  }, 180_000);

  afterAll(async () => {
    if (!databaseUrl) return;
    // Foreign keys stay on here (no replica role), so each delete cascades to
    // the rows that hang off it: history, events, runs and extractions.
    await withClient(superUrl, async (su) => {
      await su.query('BEGIN');
      await su.query(`DELETE FROM billing_webhook_events WHERE stripe_event_id LIKE $1`, [`${EVENT_PREFIX}%`]);
      await su.query(`DELETE FROM whatsapp_outbox WHERE body = $1`, [MARK]);
      await su.query(`DELETE FROM job_message_outbox WHERE body = $1`, [MARK]);
      await su.query(`DELETE FROM identity_lockout_resets WHERE challenge_id = ANY($1::uuid[])`, [challenges]);
      await su.query(`DELETE FROM worker_reset_audit WHERE operator = $1`, [OPERATOR]);
      await su.query(`DELETE FROM admin_cases WHERE id = ANY($1::uuid[])`, [cases]);
      await su.query(`DELETE FROM worker_identity_challenges WHERE id = ANY($1::uuid[])`, [challenges]);
      await su.query(`DELETE FROM whatsapp_conversations WHERE whatsapp_number = ANY($1::text[])`, [phones]);
      await su.query(`DELETE FROM job_conversations WHERE job_id = ANY($1::uuid[])`, [jobs]);
      await su.query(`DELETE FROM employer_candidate_rankings WHERE job_id = ANY($1::uuid[])`, [jobs]);
      await su.query(`DELETE FROM job_applications WHERE job_id = ANY($1::uuid[])`, [jobs]);
      await su.query(`DELETE FROM jobs WHERE id = ANY($1::uuid[])`, [jobs]);
      await su.query(`DELETE FROM subscriptions WHERE plan_code = $1`, [PLAN]);
      // Extractions restrict their account's deletion.
      await su.query(`DELETE FROM worker_profile_ai_extractions WHERE user_id = ANY($1::uuid[])`, [users]);
      await su.query(`DELETE FROM users WHERE id = ANY($1::uuid[])`, [users]);
      await dropCompanies(su, companies);
      await su.query(`DELETE FROM billing_plans WHERE code = $1`, [PLAN]);
      await su.query('COMMIT');
    });
  }, 60_000);

  // ── Arguments ────────────────────────────────────────────────
  it('rejects every out-of-range argument with its exact error, as the console', async () => {
    for (const fn of WEEKLY) {
      for (const bad of [null, 0, 27]) {
        expect({ fn, bad, err: (await errorOf(consoleUrl, `SELECT * FROM ${fn}($1)`, [bad]))?.message })
          .toEqual({ fn, bad, err: 'admin_analytics_invalid_weeks' });
      }
    }
    for (const [weeks, door, message] of [
      [0, 'all', 'admin_analytics_invalid_weeks'], [27, 'web', 'admin_analytics_invalid_weeks'],
      [null, 'all', 'admin_analytics_invalid_weeks'], [4, 'sms', 'admin_analytics_invalid_door'],
      [4, null, 'admin_analytics_invalid_door'],
    ] as const) {
      expect({ weeks, door, err: (await errorOf(consoleUrl, 'SELECT * FROM admin_analytics_onboarding_steps($1, $2)', [weeks, door]))?.message })
        .toEqual({ weeks, door, err: message });
    }
    for (const bad of [null, 0, 91]) {
      expect({ bad, err: (await errorOf(consoleUrl, 'SELECT * FROM admin_analytics_reset_reasons($1)', [bad]))?.message })
        .toEqual({ bad, err: 'admin_analytics_invalid_days' });
    }
  });

  // ── #2 ───────────────────────────────────────────────────────
  it('#2: paying employers per week, with transitions, the denominator and the approximate-before date', async () => {
    const rows = after.paying;
    expect(rows.map((r) => iso(r.week_start))).toEqual([W3, W2, W1, monday].map((d) => d.toISOString()));
    expect(rows.map((r) => r.partial)).toEqual([false, false, false, true]);
    const ends = [W2, W1, monday, new Date(T)];
    const employersBy = (end: Date): number => employerCreated.filter((d) => d < end).length;
    const d = deltaBy(before.paying, rows, (r) => iso(r.week_start)!, ['employers', 'paying', 'new_paying', 'churned']);
    expect([W3, W2, W1, monday].map((w) => d.get(w.toISOString()))).toEqual([
      { employers: employersBy(ends[0]), paying: 0, new_paying: 0, churned: 0 },
      { employers: employersBy(ends[1]), paying: 1, new_paying: 1, churned: 0 },
      { employers: employersBy(ends[2]), paying: 1, new_paying: 1, churned: 1 },
      { employers: employersBy(ends[3]), paying: 1, new_paying: 0, churned: 0 },
    ]);
    const since = new Set(rows.map((r) => iso(r.approximate_before)));
    expect(since.size).toBe(1);
    const first = [...since][0];
    expect(first).not.toBeNull();
    expect(new Date(first!).getTime()).toBeLessThanOrEqual(plus(W2, DAY).getTime());
  });

  // ── #5 ───────────────────────────────────────────────────────
  it('#5: resets in the last 30 days by reason code, then operator resets, as codes only', async () => {
    const key = (r: Row): string => `${r.source as string}|${(r.reason_code as string | null) ?? '-'}`;
    expect(after.resets.map(key)).toEqual([...RESET_CODES.map((code) => `lockout_reset|${code}`), 'operator_reset|-']);
    expect(Object.keys(after.resets[0]).sort()).toEqual(['reason_code', 'resets', 'source']);
    const d = deltaBy(before.resets, after.resets, key, ['resets']);
    expect(Object.fromEntries([...d].map(([k, v]) => [k, v.resets]))).toEqual({
      'lockout_reset|codes_not_arriving': 2,
      'lockout_reset|worker_confused': 0,
      'lockout_reset|typo_in_details': 0,
      'lockout_reset|identity_confirmed_elsewhere': 0,
      'lockout_reset|other': 1,
      'operator_reset|-': 2,
    });
  });

  // ── #6 ───────────────────────────────────────────────────────
  it('#6: open cases by time in their status and by whom they wait on', async () => {
    expect(after.aging.map((r) => r.bucket)).toEqual(['under_1h', '1_4h', '4_24h', '1_3d', 'over_3d']);
    const d = deltaBy(before.aging, after.aging, (r) => r.bucket as string, ['waiting_on_us', 'waiting_on_worker']);
    expect(Object.fromEntries(d)).toEqual({
      under_1h: { waiting_on_us: 1, waiting_on_worker: 0 },
      '1_4h': { waiting_on_us: 1, waiting_on_worker: 0 },
      '4_24h': { waiting_on_us: 0, waiting_on_worker: 1 },
      '1_3d': { waiting_on_us: 1, waiting_on_worker: 0 },
      over_3d: { waiting_on_us: 0, waiting_on_worker: 1 },
    });
  });

  it('#6: resolutions per week with median and p75 hours from opening', async () => {
    const byWeek = (rows: Row[]) => new Map(rows.map((r) => [iso(r.week_start), r]));
    const b = byWeek(before.resolution);
    // The medians are whole-database figures: the fixtures' weeks must start empty.
    expect([W2, W1].map((w) => Number(b.get(w.toISOString())?.resolved))).toEqual([0, 0]);
    const a = byWeek(after.resolution);
    expect([...a.keys()]).toEqual([W3, W2, W1, monday].map((d) => d.toISOString()));
    expect(after.resolution.map((r) => r.partial)).toEqual([false, false, false, true]);
    const w2 = a.get(W2.toISOString())!;
    const w1 = a.get(W1.toISOString())!;
    // W2: 10 h, 20 h (the first resolution of the reopened case), 30 h.
    expect({ resolved: num(w2.resolved), median: num(w2.median_hours), p75: num(w2.p75_hours) })
      .toEqual({ resolved: 3, median: 20, p75: 25 });
    // W1: 4 h (no event, resolved_at) and 2 h + 7 days (the reopened case's second resolution).
    expect({ resolved: num(w1.resolved), median: num(w1.median_hours), p75: num(w1.p75_hours) })
      .toEqual({ resolved: 2, median: 87, p75: 128.5 });
    const d = deltaBy(before.resolution, after.resolution, (r) => iso(r.week_start)!, ['resolved']);
    expect([W3, monday].map((w) => d.get(w.toISOString())?.resolved)).toEqual([0, 0]);
  });

  // ── #14 ──────────────────────────────────────────────────────
  it('#14: every step reached by the cohort, per door, with branches marked', async () => {
    const expected: Record<string, Record<string, number>> = {
      all: {
        'start.choose_language': 5, 'identity.verify_otp': 4, 'legal.review': 3, 'profile.voice_choice': 3,
        'profile.voice_processing': 1, 'profile.name': 2, 'profile.location': 2, 'profile.trade': 1,
        'profile.custom_trade': 1, 'profile.experience': 1,
      },
      whatsapp: {
        'start.choose_language': 4, 'identity.verify_otp': 3, 'legal.review': 2, 'profile.voice_choice': 2,
        'profile.voice_processing': 1, 'profile.name': 1, 'profile.location': 2, 'profile.trade': 1,
        'profile.custom_trade': 1, 'profile.experience': 1,
      },
      web: { 'legal.review': 1, 'profile.voice_choice': 1, 'profile.name': 1 },
    };
    const started = { all: 5, whatsapp: 4, web: 1 };
    for (const [door, b, a] of [
      ['all', before.stepsAll, after.stepsAll], ['whatsapp', before.stepsWhatsapp, after.stepsWhatsapp],
      ['web', before.stepsWeb, after.stepsWeb],
    ] as const) {
      const steps = door === 'web' ? STEP_ORDER.slice(2) : STEP_ORDER;
      expect({ door, steps: a.map((r) => r.step_key) }).toEqual({ door, steps });
      expect({ door, order: a.map((r) => r.step_order) }).toEqual({ door, order: steps.map((s) => STEP_ORDER.indexOf(s) + 1) });
      expect({ door, branch: a.filter((r) => r.branch).map((r) => r.step_key) })
        .toEqual({ door, branch: ['profile.voice_processing', 'profile.custom_trade'] });
      expect({ door, started: Number(a[0].started) - Number(b[0]?.started ?? 0) }).toEqual({ door, started: started[door] });
      expect(new Set(a.map((r) => Number(r.started))).size).toBe(1);
      const d = deltaBy(b, a, (r) => r.step_key as string, ['reached']);
      expect({ door, reached: Object.fromEntries([...d].map(([k, v]) => [k, v.reached]).filter(([, n]) => n !== 0)) })
        .toEqual({ door, reached: expected[door] });
    }
  });

  // ── #15 ──────────────────────────────────────────────────────
  it('#15: the identity funnel, attempt buckets and the time to verify', async () => {
    expect(after.identity).toHaveLength(1);
    const cols = ['challenges', 'reached_code', 'verified', 'locked_once', 'expired_unused',
      'attempts_zero', 'attempts_one', 'attempts_two', 'attempts_three_plus'] as const;
    const d = deltaBy(before.identity, after.identity, () => 'one', cols).get('one');
    expect(d).toEqual({
      challenges: 6, reached_code: 5, verified: 3, locked_once: 1, expired_unused: 1,
      attempts_zero: 2, attempts_one: 1, attempts_two: 1, attempts_three_plus: 1,
    });
    // The attempt buckets split the challenges that reached the code.
    const a = after.identity[0];
    expect(cols.slice(5).reduce((s, c) => s + Number(a[c]), 0)).toBe(Number(a.reached_code));
    // Timings: the baseline had nothing to time; C1 took 10 min, C5 30 min.
    expect(before.identity[0].median_minutes_to_verify).toBeNull();
    expect({ median: num(a.median_minutes_to_verify), p75: num(a.p75_minutes_to_verify) }).toEqual({ median: 20, p75: 25 });
    expect(a.timings_since).not.toBeNull();
    expect(new Date(a.timings_since as Date).getTime()).toBeLessThanOrEqual(plus(W1, HOUR).getTime());
  });

  // ── #19 ──────────────────────────────────────────────────────
  it('#19: ranking freshness reads the rankings (a gated policy, not zero rows)', async () => {
    const cols = ['under_1h', 'from_1h_to_6h', 'from_6h_to_24h', 'from_1d_to_3d', 'over_3d',
      'ranked_jobs', 'fallback_jobs', 'jobs_with_applications_no_ranking'] as const;
    expect(after.rankings).toHaveLength(1);
    expect(deltaBy(before.rankings, after.rankings, () => 'one', cols).get('one')).toEqual({
      under_1h: 1, from_1h_to_6h: 0, from_6h_to_24h: 0, from_1d_to_3d: 1, over_3d: 0,
      // J3, and the Home section's active job whose applications were hired.
      ranked_jobs: 2, fallback_jobs: 1, jobs_with_applications_no_ranking: 2,
    });
    expect(Number(after.rankings[0].ranked_jobs)).toBeGreaterThan(0);
  });

  // ── Billing inbox now (CR-3) ─────────────────────────────────
  it('billing inbox now: failed in the last 24 hours, beside failed in the last hour', async () => {
    expect(Object.keys(after.billingNow[0])).toEqual(['stuck_received', 'failed_now', 'failed_last_24h', 'unresolved_older', 'oldest_stuck_at']);
    const d = deltaBy(before.billingNow, after.billingNow, () => 'one', ['stuck_received', 'failed_now', 'failed_last_24h', 'unresolved_older']).get('one');
    expect(d).toEqual({ stuck_received: 0, failed_now: 1, failed_last_24h: 2, unresolved_older: 2 });
  });

  // ── Home ─────────────────────────────────────────────────────
  it('Home metrics: hires and jobs with a hire in 30 days, and stale jobs at 14 days', async () => {
    expect(after.home).toHaveLength(1);
    expect(deltaBy(before.home, after.home, () => 'one', ['hires_last_30d', 'jobs_with_hire_last_30d', 'stale_jobs_14d']).get('one'))
      .toEqual({ hires_last_30d: 3, jobs_with_hire_last_30d: 2, stale_jobs_14d: 1 });
    // The stale count is admin_analytics_stale_jobs(14)'s, without its rows.
    const staleRows = await rowsOf(consoleUrl, 'SELECT count(*)::INT AS n FROM admin_analytics_stale_jobs(14)');
    expect(Number(after.home[0].stale_jobs_14d)).toBe(staleRows[0].n);
  });

  it('system health: failed WhatsApp sends in 24 hours and usable voice notes in 7 days', async () => {
    expect(after.health).toHaveLength(1);
    expect(deltaBy(before.health, after.health, () => 'one', ['whatsapp_failed_24h', 'ai_finished_7d', 'ai_usable_7d']).get('one'))
      .toEqual({ whatsapp_failed_24h: 3, ai_finished_7d: 4, ai_usable_7d: 2 });
  });

  it("the console's Home and health statements run as the console and agree with the definers", async () => {
    const home = await rowsOf(consoleUrl, consoleAnalyticsSql('HOME_METRICS_SQL'));
    expect(home).toHaveLength(1);
    expect(Object.keys(home[0])).toEqual(['total_workers', 'total_employers', 'paying_employers', 'jobs_active',
      'paying_new_this_week', 'hires_last_30d', 'jobs_with_hire_last_30d', 'stale_jobs_14d']);
    const [metrics] = await call.home(consoleUrl);
    expect([home[0].hires_last_30d, home[0].jobs_with_hire_last_30d, home[0].stale_jobs_14d])
      .toEqual([metrics.hires_last_30d, metrics.jobs_with_hire_last_30d, metrics.stale_jobs_14d]);
    const thisWeek = (await call.paying(consoleUrl, 1))[0];
    expect(home[0].paying_new_this_week).toBe(thisWeek.new_paying);

    const health = await rowsOf(consoleUrl, consoleAnalyticsSql('SYSTEM_HEALTH_SQL'));
    expect(health).toHaveLength(1);
    expect(Object.keys(health[0])).toEqual(['whatsapp_failed_24h', 'ai_finished_7d', 'ai_usable_7d',
      'queued_over_1h', 'stuck_messages', 'billing_failed_24h']);
    const [now] = await call.billingNow(consoleUrl);
    expect(health[0].billing_failed_24h).toBe(now.failed_last_24h);
    const backlog = await rowsOf(consoleUrl, 'SELECT * FROM admin_analytics_message_backlog()');
    const sum = (col: string): number => backlog.reduce((n, r) => n + Number(r[col]), 0);
    expect([Number(health[0].queued_over_1h), Number(health[0].stuck_messages)])
      .toEqual([sum('open_1_24h') + sum('open_24_48h'), sum('stuck')]);
  });

  // ── Access ───────────────────────────────────────────────────
  it('the console executes each function but cannot read the sources it has no grant on', async () => {
    for (const table of [
      'employer_candidate_rankings', 'subscription_status_history', 'identity_lockout_resets',
      'worker_identity_challenge_events', 'worker_identity_challenges', 'worker_reset_audit',
      'billing_webhook_events', 'worker_profile_ai_extractions', 'job_message_outbox',
    ]) {
      expect({ table, code: (await errorOf(consoleUrl, `SELECT 1 FROM public.${table} LIMIT 1`))?.code })
        .toEqual({ table, code: '42501' });
    }
  });

  it('every function is a jale_admin definer with a pinned path, executable by the console and no other role', async () => {
    const rows = await rowsOf(superUrl,
      `SELECT f.sig,
              p.proowner = 'jale_admin'::regrole AS owner_ok,
              p.prosecdef,
              COALESCE(p.proconfig @> ARRAY['search_path=pg_catalog, pg_temp'], false) AS path_ok,
              ARRAY(SELECT DISTINCT a.grantee::regrole::text
                      FROM aclexplode(COALESCE(p.proacl, acldefault('f', p.proowner))) a
                     WHERE a.privilege_type = 'EXECUTE' AND a.grantee <> p.proowner ORDER BY 1) AS executors
         FROM unnest($1::text[]) AS f(sig)
         LEFT JOIN pg_proc p ON p.oid = to_regprocedure(f.sig)`, [FUNCTIONS]);
    for (const r of rows) {
      expect(r).toEqual({ sig: r.sig, owner_ok: true, prosecdef: true, path_ok: true, executors: ['jale_admin_console'] });
    }
  });

  it('adds exactly the two gated read policies the definers need', async () => {
    const rows = await rowsOf(superUrl,
      `SELECT c.relname, p.polname, p.polcmd::text AS cmd, p.polpermissive,
              ARRAY(SELECT r::regrole::text FROM unnest(p.polroles) r) AS roles,
              pg_get_expr(p.polqual, p.polrelid) AS qual, p.polwithcheck IS NULL AS no_check
         FROM pg_policy p JOIN pg_class c ON c.oid = p.polrelid
        WHERE p.polname IN ('employer_candidate_rankings_admin_analytics_read', 'identity_lockout_resets_admin_analytics_read')
        ORDER BY p.polname`);
    expect(rows).toEqual([
      { relname: 'employer_candidate_rankings', polname: 'employer_candidate_rankings_admin_analytics_read', cmd: 'r',
        polpermissive: true, roles: ['jale_admin'], qual: GATE, no_check: true },
      { relname: 'identity_lockout_resets', polname: 'identity_lockout_resets_admin_analytics_read', cmd: 'r',
        polpermissive: true, roles: ['jale_admin'], qual: GATE, no_check: true },
    ]);
  });
});
