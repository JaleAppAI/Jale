/**
 * employer-health-2b.integration.test.ts
 *
 * PostgreSQL-backed tests for migration 114 (roadmap 2b): first response to
 * applications, reply time to worker turns and time to hire by week
 * (admin_analytics_employer_weekly), the slowest employers
 * (admin_analytics_slowest_employers) and active jobs with no recent employer
 * action (admin_analytics_stale_jobs).
 *
 * The functions aggregate the whole database, so counts are asserted as a
 * delta between a baseline call (before fixtures) and a call after them, per
 * week and for the whole-window row. The slowest-employer and stale-job rows
 * are fixture-only by construction (each fixture employer and job is new), so
 * they are compared exactly.
 *
 * FRESH TESTBED REQUIRED for two tests: medians / p75 are not additive, and
 * the 12-week zero-fill test needs weeks with no data at all. Both check the
 * baseline first and fail with an explicit "needs a fresh testbed" message
 * on a database that already held applications, turns or hires. So never run
 * this suite after other suites on a long-lived testbed.
 *
 * Fixtures are inserted as the superuser with session_replication_role =
 * replica, so no trigger adds status events or moves timestamps. Times that
 * matter for a week are anchored to Monday 00:00 UTC of the previous two
 * weeks (W1, W2), so their week never depends on the weekday the suite runs;
 * every fixture except one deliberately old application is at most 21 days
 * old, so a 4-week window holds them. Expectations that depend on "7 days
 * ago" or "days idle" are computed from the database's now(), not the host
 * clock.
 *
 * Connection: set JALE_TEST_DATABASE_URL to a disposable Postgres 16 with the
 * full chain applied, as a superuser. When absent the suite is explicitly
 * skipped and says so (Rule 11: no silent skips).
 *   bash infra/db/local/bootstrap-testbed.sh --ephemeral --keep --no-tests --ref none
 *   then: cd infra && JALE_TEST_DATABASE_URL=<printed url> npx jest --runInBand test/unit/db/employer-health-2b.integration.test.ts
 *
 * Always pass --runInBand: the assertions are whole-database deltas, so
 * another suite inserting jobs or applications in a parallel worker would
 * break them.
 */

import { Client } from 'pg';
import { randomBytes } from 'node:crypto';

const databaseUrl = process.env.JALE_TEST_DATABASE_URL;

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const OPERATOR = 'it-2b';
const LONG_COMPANY = 'Construcciones y Remodelaciones Lenta del Noroeste, S.A. de C.V.';
const LONG_TITLE = 'Ayudante general de construcción para obra residencial en Tijuana: colado, cimbra y acabados, turno matutino de lunes a sábado';

const COUNTS = [
  'applications', 'answered', 'answered_untimed', 'unanswered_7d', 'applications_due',
  'worker_turns', 'turns_unanswered_7d', 'turns_due', 'hires', 'hires_approximate',
] as const;
type CountKey = (typeof COUNTS)[number];
type Counts = Record<CountKey, number>;
const PCTS = [
  'first_response_p50_hours', 'first_response_p75_hours', 'reply_p50_hours', 'reply_p75_hours',
  'time_to_hire_p50_days', 'time_to_hire_p75_days',
] as const;
type PctKey = (typeof PCTS)[number];
type WeekRow = Counts & Record<PctKey, number | null> & { active_jobs: number | null };

const WINDOW = 'window';
const zero = (): Counts => Object.fromEntries(COUNTS.map((k) => [k, 0])) as Counts;

async function setServiceRolePasswords(superuserUrl: string): Promise<void> {
  const client = new Client({ connectionString: superuserUrl });
  await client.connect();
  try {
    await client.query(`ALTER ROLE jale_whatsapp WITH PASSWORD 'test-whatsapp-pw'`);
    await client.query(`ALTER ROLE jale_admin_console WITH PASSWORD 'test-adminconsole-pw'`);
  } finally {
    await client.end();
  }
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

/** Monday 00:00 UTC of the week containing `d` (Postgres date_trunc('week', d, 'UTC')). */
function isoWeekStart(d: Date): string {
  const day = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  return new Date(day.getTime() - ((day.getUTCDay() + 6) % 7) * DAY).toISOString();
}

/** percentile_cont(p) rounded to one decimal, as the functions return it; null for no values. */
function pct(values: number[], p: number): number | null {
  if (values.length === 0) return null;
  const s = [...values].sort((a, b) => a - b);
  const pos = (s.length - 1) * p;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return Math.round((s[lo] + (s[hi] - s[lo]) * (pos - lo)) * 10) / 10;
}

const num = (v: string | null): number | null => (v === null ? null : Number(v));

function toWeekRows(rows: Record<string, string | Date | null>[]): Map<string, WeekRow> {
  const byKey = new Map<string, WeekRow>();
  for (const r of rows) {
    const row = { active_jobs: num(r.active_jobs as string | null) } as WeekRow;
    for (const k of COUNTS) row[k] = Number(r[k]);
    for (const k of PCTS) row[k] = num(r[k] as string | null);
    byKey.set(r.week_start === null ? WINDOW : new Date(r.week_start as Date).toISOString(), row);
  }
  return byKey;
}

async function weekly(url: string, weeks = 4): Promise<Map<string, WeekRow>> {
  return toWeekRows(await withClient(url, async (c) =>
    (await c.query('SELECT * FROM admin_analytics_employer_weekly($1)', [weeks])).rows));
}

async function dbNow(url: string): Promise<number> {
  return withClient(url, async (c) => ((await c.query('SELECT now() AS n')).rows[0].n as Date).getTime());
}

const maybeDescribe = databaseUrl ? describe : describe.skip;
if (!databaseUrl) {
  // eslint-disable-next-line no-console
  console.warn('JALE_TEST_DATABASE_URL not set — skipping 2b employer health integration tests');
}

maybeDescribe('2b employer health (114)', () => {
  let superUrl = '';
  let consoleUrl = '';
  let whatsappUrl = '';
  const now = new Date();
  const ago = (ms: number): Date => new Date(now.getTime() - ms);
  const plus = (d: Date, ms: number): Date => new Date(d.getTime() + ms);
  const monday = new Date(isoWeekStart(now));
  // Always 14-21 and 7-14 days old, whatever the weekday.
  const W2 = new Date(monday.getTime() - 14 * DAY);
  const W1 = new Date(monday.getTime() - 7 * DAY);
  // The first week of a 4-week window.
  const W3 = new Date(monday.getTime() - 21 * DAY);

  let before = new Map<string, WeekRow>();
  let before12 = new Map<string, WeekRow>();

  // What the non-test fixtures should add (filled while seeding).
  const appsExpected: { at: Date; outcome: 'timed' | 'untimed' | 'unanswered' | 'waiting'; hours?: number }[] = [];
  const turnsExpected: { at: Date; outcome: 'answered' | 'unanswered' | 'open'; hours?: number }[] = [];
  const hiresExpected: { at: Date; days: number; approx: boolean }[] = [];
  // Stale-list expectations: the last employer action of each fixture job.
  const lastAction: Record<string, Date> = {};

  const ids: Record<string, string> = {};

  /** Percentiles and empty weeks are not deltas: they need a testbed holding only these fixtures. */
  function requireFreshTestbed(): void {
    const held = [before.get(WINDOW)!, before12.get(WINDOW)!]
      .map((r) => r.applications + r.worker_turns + r.hires)
      .reduce((a, b) => a + b, 0);
    if (held !== 0) {
      throw new Error(
        'This assertion needs a fresh testbed (bootstrap-testbed.sh --ephemeral, then this suite first): '
        + `the 12-week window already held ${before12.get(WINDOW)!.applications} applications, `
        + `${before12.get(WINDOW)!.worker_turns} worker turns and ${before12.get(WINDOW)!.hires} hires before the fixtures.`,
      );
    }
  }

  /** Runs `fn` in one superuser transaction with triggers suppressed. */
  async function seed(fn: (c: Client) => Promise<void>): Promise<void> {
    await withClient(superUrl, async (c) => {
      await c.query('BEGIN');
      await c.query('SET LOCAL session_replication_role = replica');
      await fn(c);
      await c.query('COMMIT');
    });
  }

  const employer = async (
    c: Client, company: string | null, opts: { email?: string; seedSub?: boolean } = {},
  ): Promise<string> => {
    const sub = `${opts.seedSub ? 'seed-' : ''}${OPERATOR}-${randomBytes(6).toString('hex')}`;
    const id = (await c.query(
      `INSERT INTO users (cognito_sub, user_type, email) VALUES ($1, 'employer', $2) RETURNING id`,
      [sub, opts.email ?? null],
    )).rows[0].id;
    if (company !== null) {
      await c.query(`INSERT INTO employer_profiles (user_id, company_name) VALUES ($1, $2)`, [id, company]);
    }
    return id;
  };

  const job = async (c: Client, employerId: string, title: string, status: string, createdAt: Date, updatedAt = createdAt): Promise<string> =>
    (await c.query(
      `INSERT INTO jobs (employer_id, title, location, job_type, status, created_at, updated_at)
       VALUES ($1, $2, 'Tijuana', 'full-time', $3, $4, $5) RETURNING id`,
      [employerId, title, status, createdAt, updatedAt],
    )).rows[0].id;

  type AppOpts = {
    detailsRequestedAt?: Date; detailsCompletedAt?: Date;
    hiredAt?: Date; hiredSeenAt?: Date; hiredAckAt?: Date; updatedAt?: Date;
  };
  /** One application by a fresh worker; returns [applicationId, workerId]. */
  const application = async (c: Client, jobId: string, status: string, appliedAt: Date, o: AppOpts = {}): Promise<[string, string]> => {
    const workerId = (await c.query(
      `INSERT INTO users (cognito_sub, user_type) VALUES ($1, 'worker') RETURNING id`,
      [`${OPERATOR}-${randomBytes(6).toString('hex')}`],
    )).rows[0].id;
    const appId = (await c.query(
      `INSERT INTO job_applications
         (job_id, worker_id, status, applied_at, created_at, updated_at,
          details_requested_at, details_completed_at, hired_at, hired_seen_at, hired_ack_at)
       VALUES ($1, $2, $3, $4, $4, $5, $6, $7, $8, $9, $10) RETURNING id`,
      [jobId, workerId, status, appliedAt, o.updatedAt ?? appliedAt, o.detailsRequestedAt ?? null,
        o.detailsCompletedAt ?? null, o.hiredAt ?? null, o.hiredSeenAt ?? null, o.hiredAckAt ?? null],
    )).rows[0].id;
    return [appId, workerId];
  };

  type ConvOpts = { status?: 'open' | 'closed'; closedAt?: Date; employerLastReadAt?: Date; touchedAt?: Date };
  const conversation = async (
    c: Client, jobId: string, employerId: string, app: [string, string], createdAt: Date, o: ConvOpts = {},
  ): Promise<string> =>
    (await c.query(
      `INSERT INTO job_conversations
         (job_id, employer_id, worker_id, application_id, status, closed_at, created_at, updated_at,
          last_message_at, last_worker_message_at, employer_last_read_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $8, $8, $9) RETURNING id`,
      [jobId, employerId, app[1], app[0], o.status ?? 'open', o.closedAt ?? null, createdAt,
        o.touchedAt ?? createdAt, o.employerLastReadAt ?? null],
    )).rows[0].id;

  const message = async (
    c: Client, convId: string, sender: 'employer' | 'worker' | 'system', at: Date, status?: string, id?: string,
  ): Promise<void> => {
    await c.query(
      `INSERT INTO job_conversation_messages (id, conversation_id, sender_type, direction, body, status, created_at)
       VALUES (COALESCE($6::uuid, gen_random_uuid()), $1, $2, $3, 'it-2b fixture', $4, $5)`,
      [convId, sender, sender === 'worker' ? 'inbound' : 'outbound',
        status ?? (sender === 'worker' ? 'received' : 'sent'), at, id ?? null],
    );
  };

  const statusEvent = async (
    c: Client, app: [string, string], jobId: string, from: string | null, to: string, at: Date, backfill = false,
  ): Promise<void> => {
    await c.query(
      `INSERT INTO job_application_status_events (application_id, job_id, from_status, to_status, changed_at, is_backfill)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [app[0], jobId, from, to, at, backfill],
    );
  };

  beforeAll(async () => {
    superUrl = databaseUrl!;
    await setServiceRolePasswords(superUrl);
    consoleUrl = urlForRole(superUrl, 'jale_admin_console', 'test-adminconsole-pw');
    whatsappUrl = urlForRole(superUrl, 'jale_whatsapp', 'test-whatsapp-pw');

    before = await weekly(consoleUrl);
    before12 = await weekly(consoleUrl, 12);

    // ── E_A, a long company name: two unanswered, one answered by message,
    // a stale job (long title) with waiting applicants, a recently messaged
    // job, a paused job.
    await seed(async (c) => {
      const ea = await employer(c, LONG_COMPANY);
      ids.ea = ea;
      const main = await job(c, ea, 'IT 2b Lenta main', 'active', ago(21 * DAY));
      const stale = await job(c, ea, LONG_TITLE, 'active', ago(20 * DAY));
      ids.jaMain = main;
      ids.jaStale = stale;
      lastAction[stale] = ago(20 * DAY);
      // Paused and idle 20 days: never stale, not an active job.
      ids.jaPaused = await job(c, ea, 'IT 2b Lenta paused', 'paused', ago(20 * DAY));

      // A1: pending 15 days, no action -> unanswered (and waiting on the stale job).
      await application(c, stale, 'pending', ago(15 * DAY));
      appsExpected.push({ at: ago(15 * DAY), outcome: 'unanswered' });
      // A2: pending 2 days -> in applications, not yet due or unanswered (waiting on the stale job).
      await application(c, stale, 'pending', ago(2 * DAY));
      appsExpected.push({ at: ago(2 * DAY), outcome: 'waiting' });
      ids.a2AppliedAt = ago(2 * DAY).toISOString();
      // A3: pending since W2 -> unanswered.
      await application(c, main, 'pending', plus(W2, 2 * HOUR));
      appsExpected.push({ at: plus(W2, 2 * HOUR), outcome: 'unanswered' });
      // A4: answered by a message 50 h later; a second message yesterday keeps
      // the job off the stale list (the recent-employer-message case).
      const a4At = plus(W2, 3 * HOUR);
      const a4 = await application(c, main, 'contacted', a4At);
      const conv = await conversation(c, main, ea, a4, plus(a4At, 50 * HOUR));
      await message(c, conv, 'employer', plus(a4At, 50 * HOUR));
      await message(c, conv, 'employer', ago(DAY), 'queued');
      appsExpected.push({ at: a4At, outcome: 'timed', hours: 50 });
    });

    // ── E_C, no company name -> 'Empleador': one unanswered, two answered
    // with no recorded time (so no median); its only job is stale.
    await seed(async (c) => {
      const ec = await employer(c, null);
      ids.ec = ec;
      const main = await job(c, ec, 'IT 2b Empleador stale', 'active', ago(19 * DAY));
      ids.jcMain = main;
      lastAction[main] = ago(19 * DAY);
      // C1: unanswered.
      await application(c, main, 'pending', ago(16 * DAY));
      appsExpected.push({ at: ago(16 * DAY), outcome: 'unanswered' });
      // C2: contacted before history existed: only a backfill event -> answered, untimed.
      const c2 = await application(c, main, 'contacted', ago(10 * DAY));
      await statusEvent(c, c2, main, null, 'contacted', plus(ago(10 * DAY), HOUR), true);
      appsExpected.push({ at: ago(10 * DAY), outcome: 'untimed' });
      // C3: talking (a worker-driven status) -> answered, untimed; the talking
      // event is not an employer action.
      const c3 = await application(c, main, 'talking', ago(9 * DAY));
      await statusEvent(c, c3, main, null, 'pending', ago(9 * DAY));
      await statusEvent(c, c3, main, 'pending', 'talking', plus(ago(9 * DAY), HOUR));
      appsExpected.push({ at: ago(9 * DAY), outcome: 'untimed' });
      ids.c3AppliedAt = ago(9 * DAY).toISOString();
    });

    // ── E_E "Media SA": one unanswered; a details request after 20 h; two
    // conversations on one application (the earliest, 40 h, counts).
    await seed(async (c) => {
      const ee = await employer(c, 'Media SA');
      ids.ee = ee;
      const main = await job(c, ee, 'IT 2b Media main', 'active', ago(21 * DAY));
      await application(c, main, 'pending', plus(W2, 5 * HOUR));
      appsExpected.push({ at: plus(W2, 5 * HOUR), outcome: 'unanswered' });
      // E2: no status event, so only details_requested_at can answer it.
      await application(c, main, 'details_requested', W1, { detailsRequestedAt: plus(W1, 20 * HOUR) });
      appsExpected.push({ at: W1, outcome: 'timed', hours: 20 });
      const e3 = await application(c, main, 'contacted', W1);
      const first = await conversation(c, main, ee, e3, plus(W1, 40 * HOUR),
        { status: 'closed', closedAt: plus(W1, 46 * HOUR) });
      await message(c, first, 'employer', plus(W1, 40 * HOUR));
      const second = await conversation(c, main, ee, e3, plus(W1, 100 * HOUR));
      await message(c, second, 'employer', plus(W1, 100 * HOUR));
      appsExpected.push({ at: W1, outcome: 'timed', hours: 40 });
    });

    // ── E_B "Rapida SA": one unanswered; a not_interested event after 1 h;
    // a waiting_worker_reply message after 3 h (no event: the message alone).
    await seed(async (c) => {
      const eb = await employer(c, 'Rapida SA');
      ids.eb = eb;
      const main = await job(c, eb, 'IT 2b Rapida main', 'active', ago(21 * DAY));
      await application(c, main, 'pending', plus(W2, 6 * HOUR));
      appsExpected.push({ at: plus(W2, 6 * HOUR), outcome: 'unanswered' });
      const b2 = await application(c, main, 'not_interested', W1);
      await statusEvent(c, b2, main, 'pending', 'not_interested', plus(W1, HOUR));
      appsExpected.push({ at: W1, outcome: 'timed', hours: 1 });
      const b3 = await application(c, main, 'contacted', W1);
      const conv = await conversation(c, main, eb, b3, plus(W1, 3 * HOUR));
      await message(c, conv, 'employer', plus(W1, 3 * HOUR), 'waiting_worker_reply');
      appsExpected.push({ at: W1, outcome: 'timed', hours: 3 });
    });

    // ── E_D "Contrata SA" (2 applications in any window): a real hire after
    // 8 days; a 095-backfilled hire (hired_at = hired_seen_at = hired_ack_at)
    // after 7, which counts as a hire but is not an action time; and a hire
    // this window of an application 90 days old.
    await seed(async (c) => {
      const ed = await employer(c, 'Contrata SA');
      ids.ed = ed;
      const main = await job(c, ed, 'IT 2b Contrata main', 'active', ago(21 * DAY));
      const d1At = plus(W2, 10 * HOUR);
      const d1 = await application(c, main, 'hired', d1At, {
        detailsRequestedAt: plus(d1At, 2 * HOUR),
        detailsCompletedAt: plus(d1At, 20 * HOUR),
        hiredAt: plus(d1At, 8 * DAY),
        hiredSeenAt: plus(d1At, 8 * DAY + 6 * HOUR),
      });
      await statusEvent(c, d1, main, 'pending', 'details_requested', plus(d1At, 2 * HOUR));
      await statusEvent(c, d1, main, 'details_requested', 'hired', plus(d1At, 8 * DAY));
      appsExpected.push({ at: d1At, outcome: 'timed', hours: 2 });
      hiresExpected.push({ at: plus(d1At, 8 * DAY), days: 8, approx: false });
      const d2At = plus(W2, 20 * HOUR);
      const d2Hired = plus(d2At, 7 * DAY);
      const d2 = await application(c, main, 'hired', d2At, { hiredAt: d2Hired, hiredSeenAt: d2Hired, hiredAckAt: d2Hired });
      await statusEvent(c, d2, main, null, 'hired', d2Hired, true);
      // Its only action time is approximate: answered, untimed.
      appsExpected.push({ at: d2At, outcome: 'untimed' });
      hiresExpected.push({ at: d2Hired, days: 7, approx: true });
      // O1: applied 90 days before its hire, so outside every window; the
      // hire still counts in its own week. Seen at the hire instant but never
      // acknowledged: two of the three times match, which is not 095's marker.
      const o1Hired = plus(W1, 30 * HOUR);
      const o1At = new Date(o1Hired.getTime() - 90 * DAY);
      const old = await job(c, ed, 'IT 2b Contrata old', 'filled', new Date(o1At.getTime() - DAY));
      const o1 = await application(c, old, 'hired', o1At, { hiredAt: o1Hired, hiredSeenAt: o1Hired });
      await statusEvent(c, o1, old, 'details_requested', 'hired', o1Hired);
      appsExpected.push({ at: o1At, outcome: 'timed', hours: 90 * 24 });
      hiresExpected.push({ at: o1Hired, days: 90, approx: false });
    });

    // ── E_R "Charla SA" (2 applications): the worker turns.
    await seed(async (c) => {
      const er = await employer(c, 'Charla SA');
      ids.er = er;
      const main = await job(c, er, 'IT 2b Charla main', 'active', ago(21 * DAY));
      const r1At = plus(W2, HOUR);
      const r1 = await application(c, main, 'talking', r1At);
      // An older conversation the worker closed with no reply: its turn is
      // left out (it would otherwise be unanswered after 7 days).
      const old = await conversation(c, main, er, r1, plus(r1At, HOUR), { status: 'closed', closedAt: plus(r1At, 5 * HOUR) });
      await message(c, old, 'employer', plus(r1At, HOUR));
      await message(c, old, 'worker', plus(r1At, 3 * HOUR));
      await message(c, old, 'system', plus(r1At, 5 * HOUR));
      appsExpected.push({ at: r1At, outcome: 'timed', hours: 1 });
      const conv = await conversation(c, main, er, r1, plus(W2, 30 * HOUR), { touchedAt: ago(DAY) });
      await message(c, conv, 'employer', plus(W2, 30 * HOUR));
      // Three worker messages in a row = one turn; replied 6 h after the first.
      await message(c, conv, 'worker', plus(W2, 40 * HOUR));
      await message(c, conv, 'worker', plus(W2, 41 * HOUR));
      await message(c, conv, 'worker', plus(W2, 42 * HOUR));
      await message(c, conv, 'employer', plus(W2, 46 * HOUR));
      turnsExpected.push({ at: plus(W2, 40 * HOUR), outcome: 'answered', hours: 6 });
      // A system row between two worker messages neither splits the turn
      // nor answers it: one turn, replied after 2 h.
      await message(c, conv, 'worker', plus(W2, 50 * HOUR));
      await message(c, conv, 'system', plus(W2, 50 * HOUR + 20 * MIN));
      await message(c, conv, 'worker', plus(W2, 50 * HOUR + 40 * MIN));
      await message(c, conv, 'employer', plus(W2, 52 * HOUR));
      turnsExpected.push({ at: plus(W2, 50 * HOUR), outcome: 'answered', hours: 2 });
      // A turn at Monday 00:00 of W1, replied after 30 h.
      await message(c, conv, 'worker', W1);
      await message(c, conv, 'employer', plus(W1, 30 * HOUR));
      turnsExpected.push({ at: W1, outcome: 'answered', hours: 30 });
      // Yesterday's worker message: a turn, not yet due or unanswered.
      await message(c, conv, 'worker', ago(DAY));
      turnsExpected.push({ at: ago(DAY), outcome: 'open' });

      const r2At = plus(W2, 60 * HOUR);
      const r2 = await application(c, main, 'talking', r2At);
      const conv2 = await conversation(c, main, er, r2, plus(r2At, 2 * HOUR));
      await message(c, conv2, 'employer', plus(r2At, 2 * HOUR));
      appsExpected.push({ at: r2At, outcome: 'timed', hours: 2 });
      // Never replied, 7+ days old.
      await message(c, conv2, 'worker', plus(r2At, 10 * HOUR));
      turnsExpected.push({ at: plus(r2At, 10 * HOUR), outcome: 'unanswered' });
    });

    // ── E_S "Quieta SA" (2 applications): stale despite recent activity
    // that is not the employer's, and a stale job nobody applied to.
    await seed(async (c) => {
      const es = await employer(c, 'Quieta SA');
      ids.es = es;
      // Only worker activity is recent: messages, a talking event, and every
      // updated_at / last_*_at they move.
      const busy = await job(c, es, 'IT 2b Quieta worker', 'active', ago(19 * DAY), ago(DAY));
      ids.jsWorker = busy;
      const s1At = ago(18 * DAY);
      ids.s1AppliedAt = s1At.toISOString();
      const s1 = await application(c, busy, 'talking', s1At, { updatedAt: ago(DAY) });
      const conv = await conversation(c, busy, es, s1, plus(s1At, 2 * HOUR), { touchedAt: ago(DAY) });
      await message(c, conv, 'employer', plus(s1At, 2 * HOUR));
      await statusEvent(c, s1, busy, 'pending', 'contacted', plus(s1At, 2 * HOUR));
      await message(c, conv, 'worker', plus(s1At, 3 * HOUR));
      await message(c, conv, 'worker', ago(DAY));
      await statusEvent(c, s1, busy, 'contacted', 'talking', ago(DAY));
      appsExpected.push({ at: s1At, outcome: 'timed', hours: 2 });
      turnsExpected.push({ at: plus(s1At, 3 * HOUR), outcome: 'unanswered' });
      lastAction[busy] = plus(s1At, 2 * HOUR);

      // Only employer_last_read_at is recent (the thread was open on screen).
      const read = await job(c, es, 'IT 2b Quieta read', 'active', ago(17 * DAY));
      ids.jsRead = read;
      const s2At = ago(16 * DAY);
      ids.s2AppliedAt = s2At.toISOString();
      const s2 = await application(c, read, 'contacted', s2At);
      const conv2 = await conversation(c, read, es, s2, plus(s2At, 5 * HOUR),
        { employerLastReadAt: ago(HOUR), touchedAt: ago(HOUR) });
      await message(c, conv2, 'employer', plus(s2At, 5 * HOUR));
      await statusEvent(c, s2, read, 'pending', 'contacted', plus(s2At, 5 * HOUR));
      appsExpected.push({ at: s2At, outcome: 'timed', hours: 5 });
      lastAction[read] = plus(s2At, 5 * HOUR);

      // Posted 18 days ago, no application at all.
      const empty = await job(c, es, 'IT 2b Quieta empty', 'active', ago(18 * DAY));
      ids.jsEmpty = empty;
      lastAction[empty] = ago(18 * DAY);
    });

    // ── E_X "Bordes SA" (2 applications): the Monday 00:00 UTC edge. X1 at
    // exactly Monday 00:00:00.000 belongs to W1; X2 one second earlier
    // belongs to W2 although it was answered on Monday (an answer counts in
    // the application's week).
    await seed(async (c) => {
      const ex = await employer(c, 'Bordes SA');
      ids.ex = ex;
      const main = await job(c, ex, 'IT 2b Bordes main', 'active', ago(21 * DAY));
      await application(c, main, 'details_requested', W1, { detailsRequestedAt: plus(W1, HOUR) });
      appsExpected.push({ at: W1, outcome: 'timed', hours: 1 });
      const x2At = new Date(W1.getTime() - 1000);
      await application(c, main, 'details_requested', x2At, { detailsRequestedAt: plus(x2At, 2 * HOUR) });
      appsExpected.push({ at: x2At, outcome: 'timed', hours: 2 });
    });

    // ── E_V "Vuelta SA" (2 applications, closed job): P1 was contacted after
    // 4 h and moved back to pending -> answered, timed, never unanswered; U1
    // was hired after 3 days and later marked not_interested -> the hire
    // still counts.
    await seed(async (c) => {
      const ev = await employer(c, 'Vuelta SA');
      ids.ev = ev;
      const main = await job(c, ev, 'IT 2b Vuelta closed', 'closed', ago(21 * DAY));
      const p1At = plus(W2, 7 * HOUR);
      const p1 = await application(c, main, 'pending', p1At);
      await statusEvent(c, p1, main, 'pending', 'contacted', plus(p1At, 4 * HOUR));
      await statusEvent(c, p1, main, 'contacted', 'pending', plus(p1At, 13 * HOUR));
      appsExpected.push({ at: p1At, outcome: 'timed', hours: 4 });
      const u1At = plus(W2, 8 * HOUR);
      const u1 = await application(c, main, 'not_interested', u1At, { hiredAt: plus(u1At, 3 * DAY) });
      await statusEvent(c, u1, main, 'details_requested', 'hired', plus(u1At, 3 * DAY));
      await statusEvent(c, u1, main, 'hired', 'not_interested', plus(u1At, 3 * DAY + 20 * HOUR));
      appsExpected.push({ at: u1At, outcome: 'timed', hours: 72 });
      hiresExpected.push({ at: plus(u1At, 3 * DAY), days: 3, approx: false });
    });

    // ── E_Q "Turnos SA" (1 application): a reply that lands in the next
    // week, and a worker and an employer message with the same created_at
    // (the order is (created_at, id): the employer's smaller id goes first,
    // so the worker message starts a turn). The worker message is inserted
    // first, so ordering by created_at alone would likely put it first.
    await seed(async (c) => {
      const eq = await employer(c, 'Turnos SA');
      ids.eq = eq;
      const main = await job(c, eq, 'IT 2b Turnos main', 'active', ago(21 * DAY));
      const q1At = plus(W2, 95 * HOUR);
      const q1 = await application(c, main, 'talking', q1At);
      const conv = await conversation(c, main, eq, q1, plus(q1At, 4 * HOUR), { touchedAt: plus(W1, 3 * HOUR) });
      await message(c, conv, 'employer', plus(q1At, 4 * HOUR));
      appsExpected.push({ at: q1At, outcome: 'timed', hours: 4 });
      await message(c, conv, 'worker', plus(W2, 101 * HOUR));
      await message(c, conv, 'worker', plus(W2, 110 * HOUR), undefined, '2b7e0000-0000-4000-8000-000000000002');
      await message(c, conv, 'employer', plus(W2, 110 * HOUR), undefined, '2b7e0000-0000-4000-8000-000000000001');
      turnsExpected.push({ at: plus(W2, 101 * HOUR), outcome: 'answered', hours: 9 });
      // The tied employer message comes first, so it cannot answer this turn:
      // 7 h, not 0 h.
      await message(c, conv, 'employer', plus(W2, 117 * HOUR));
      turnsExpected.push({ at: plus(W2, 110 * HOUR), outcome: 'answered', hours: 7 });
      // Sunday 22:00 UTC (W2), replied Monday 03:00 (W1): counts in W2.
      await message(c, conv, 'worker', new Date(W1.getTime() - 2 * HOUR));
      await message(c, conv, 'employer', plus(W1, 3 * HOUR));
      turnsExpected.push({ at: new Date(W1.getTime() - 2 * HOUR), outcome: 'answered', hours: 5 });
    });

    // ── Test employers: every kind of activity, none of it counted.
    await seed(async (c) => {
      const t1 = await employer(c, 'Prueba SA', { email: `${OPERATOR}-${randomBytes(4).toString('hex')}@jale.test` });
      ids.t1 = t1;
      const idle = await job(c, t1, 'IT 2b Prueba stale', 'active', ago(20 * DAY));
      ids.jt1 = idle;
      for (const d of [15, 12, 11]) await application(c, idle, 'pending', ago(d * DAY));
      const busy = await job(c, t1, 'IT 2b Prueba busy', 'active', ago(21 * DAY));
      ids.jt1b = busy;
      const t4At = plus(W2, HOUR);
      const t4 = await application(c, busy, 'hired', t4At, { hiredAt: plus(W1, 10 * HOUR), hiredSeenAt: plus(W1, 12 * HOUR) });
      await statusEvent(c, t4, busy, 'contacted', 'hired', plus(W1, 10 * HOUR));
      const conv = await conversation(c, busy, t1, t4, plus(t4At, 4 * HOUR));
      await message(c, conv, 'employer', plus(t4At, 4 * HOUR));
      await message(c, conv, 'worker', plus(t4At, 5 * HOUR));

      const t2 = await employer(c, null, { seedSub: true });
      ids.t2 = t2;
      const idle2 = await job(c, t2, 'IT 2b Seed stale', 'active', ago(20 * DAY));
      ids.jt2 = idle2;
      for (const d of [15, 13, 12]) await application(c, idle2, 'pending', ago(d * DAY));
    });
  }, 120_000);

  afterAll(async () => {
    if (!databaseUrl) return;
    await withClient(superUrl, async (su) => {
      // Jobs cascade applications, conversations, messages and status events.
      await su.query(
        `DELETE FROM jobs WHERE employer_id IN
           (SELECT id FROM users WHERE cognito_sub LIKE $1 OR cognito_sub LIKE $2)`,
        [`${OPERATOR}-%`, `seed-${OPERATOR}-%`],
      );
      await su.query(`DELETE FROM users WHERE cognito_sub LIKE $1 OR cognito_sub LIKE $2`, [`${OPERATOR}-%`, `seed-${OPERATOR}-%`]);
    });
  }, 60_000);

  /** Expected count deltas for a week key, or for the 4-week window; "due" uses the database clock. */
  function expectedCounts(key: string, nowMs: number): Counts {
    const inKey = (d: Date): boolean => (key === WINDOW ? d >= W3 : isoWeekStart(d) === key);
    const due = (d: Date): boolean => d.getTime() <= nowMs - 7 * DAY;
    const counts = zero();
    for (const a of appsExpected.filter((x) => inKey(x.at))) {
      counts.applications += 1;
      if (due(a.at)) counts.applications_due += 1;
      if (a.outcome === 'timed' || a.outcome === 'untimed') counts.answered += 1;
      if (a.outcome === 'untimed') counts.answered_untimed += 1;
      if (a.outcome === 'unanswered') counts.unanswered_7d += 1;
    }
    for (const t of turnsExpected.filter((x) => inKey(x.at))) {
      counts.worker_turns += 1;
      if (due(t.at)) counts.turns_due += 1;
      if (t.outcome === 'unanswered') counts.turns_unanswered_7d += 1;
    }
    for (const h of hiresExpected.filter((x) => inKey(x.at))) {
      counts.hires += 1;
      if (h.approx) counts.hires_approximate += 1;
    }
    return counts;
  }

  /** Expected percentiles for a week key, or for the 4-week window (fixtures only). */
  function expectedPcts(key: string): Record<PctKey, number | null> {
    const inKey = (d: Date): boolean => (key === WINDOW ? d >= W3 : isoWeekStart(d) === key);
    const fr = appsExpected.filter((x) => inKey(x.at) && x.hours !== undefined).map((x) => x.hours!);
    const rt = turnsExpected.filter((x) => inKey(x.at) && x.hours !== undefined).map((x) => x.hours!);
    const th = hiresExpected.filter((x) => inKey(x.at)).map((x) => x.days);
    return {
      first_response_p50_hours: pct(fr, 0.5),
      first_response_p75_hours: pct(fr, 0.75),
      reply_p50_hours: pct(rt, 0.5),
      reply_p75_hours: pct(rt, 0.75),
      time_to_hire_p50_days: pct(th, 0.5),
      time_to_hire_p75_days: pct(th, 0.75),
    };
  }

  it('counts every fixture in its week and in the window row, and nothing else', async () => {
    const nowMs = await dbNow(superUrl);
    const after = await weekly(consoleUrl);
    expect(after.size).toBe(5);
    for (const key of after.keys()) {
      const b = before.get(key);
      const a = after.get(key)!;
      const delta = Object.fromEntries(COUNTS.map((k) => [k, a[k] - (b?.[k] ?? 0)]));
      expect({ key, delta }).toEqual({ key, delta: expectedCounts(key, nowMs) });
    }
    // The window row, whatever the weekday: A2 (2 days old) is the only
    // application not yet due, yesterday's turn the only turn not yet due;
    // P1 (moved back to pending) is answered; D2's approximate hire time
    // makes it untimed; O1 is older than the window.
    expect(expectedCounts(WINDOW, nowMs)).toEqual({
      applications: 24, answered: 18, answered_untimed: 3, unanswered_7d: 5, applications_due: 23,
      worker_turns: 9, turns_unanswered_7d: 2, turns_due: 8, hires: 4, hires_approximate: 1,
    });
  });

  it('counts active jobs of real employers on the window row only', async () => {
    const after = await weekly(consoleUrl);
    // Twelve active fixture jobs; the paused, closed and filled ones and the
    // three test-employer jobs are left out.
    expect(after.get(WINDOW)!.active_jobs! - before.get(WINDOW)!.active_jobs!).toBe(12);
    for (const [key, row] of after) {
      if (key !== WINDOW) expect({ key, active_jobs: row.active_jobs }).toEqual({ key, active_jobs: null });
    }
  });

  it('computes medians and p75 over the window itself, not over weekly medians', async () => {
    requireFreshTestbed();
    const after = await weekly(consoleUrl);
    for (const [key, row] of after) {
      const got = Object.fromEntries(PCTS.map((k) => [k, row[k]]));
      expect({ key, got }).toEqual({ key, got: expectedPcts(key) });
    }
    const w = after.get(WINDOW)!;
    // First response over 15 timed answers: 1 1 1 2 2 2 2 3 4 4 5 20 40 50 72
    // (D2's approximate hire time is not one of them).
    expect([w.first_response_p50_hours, w.first_response_p75_hours]).toEqual([3, 12.5]);
    // Reply over six answered turns: 2 5 6 7 9 30. W2 holds 2 5 6 7 9
    // (median 6), W1 holds 30, so a mean of weekly medians would read 18.
    expect([w.reply_p50_hours, w.reply_p75_hours]).toEqual([6.5, 8.5]);
    // Time to hire over 3, 7, 8 and 90 days.
    expect([w.time_to_hire_p50_days, w.time_to_hire_p75_days]).toEqual([7.5, 28.5]);
  });

  it('puts the edge cases in the right week', async () => {
    const after = await weekly(consoleUrl);
    const w1 = W1.toISOString();
    const w2 = W2.toISOString();
    const delta = (key: string, k: CountKey): number => after.get(key)![k] - (before.get(key)?.[k] ?? 0);
    // Hires by hire week: W1 gets D1, D2 (approximate) and O1, whose
    // application is 90 days old; W2 gets U1, whose status moved on.
    expect([delta(w1, 'hires'), delta(w1, 'hires_approximate'), delta(w2, 'hires')]).toEqual([3, 1, 1]);
    requireFreshTestbed();
    // W1's timed answers: X1 (applied Monday 00:00:00.000, 1 h), B2 1, B3 3,
    // E2 20, E3 40. X2 (Sunday 23:59:59, answered on Monday) stays in W2.
    expect([after.get(w1)!.first_response_p50_hours, after.get(w1)!.first_response_p75_hours]).toEqual([3, 20]);
    // W2's replies include the Sunday 22:00 turn answered on Monday (5 h) and
    // the turn that starts at the tied timestamp (7 h): 2 5 6 7 9.
    expect([after.get(w2)!.reply_p50_hours, after.get(w2)!.reply_p75_hours]).toEqual([6, 7]);
    expect([after.get(w1)!.reply_p50_hours, after.get(w1)!.reply_p75_hours]).toEqual([30, 30]);
    expect([after.get(w1)!.time_to_hire_p50_days, after.get(w1)!.time_to_hire_p75_days]).toEqual([8, 49]);
    expect([after.get(w2)!.time_to_hire_p50_days, after.get(w2)!.time_to_hire_p75_days]).toEqual([3, 3]);
  });

  it('groups by UTC weeks whatever the session TimeZone', async () => {
    const rowsIn = async (tz: string): Promise<string[]> => withClient(consoleUrl, async (c) => {
      await c.query(`SET TIME ZONE '${tz}'`);
      const rows = (await c.query('SELECT * FROM admin_analytics_employer_weekly(4)')).rows;
      return rows.map((r) => JSON.stringify({ ...r, week_start: r.week_start === null ? null : new Date(r.week_start).toISOString() }));
    });
    const utc = await rowsIn('UTC');
    expect(await rowsIn('Pacific/Auckland')).toEqual(utc);
    expect(await rowsIn('America/Los_Angeles')).toEqual(utc);
  });

  it('returns every week of the window, oldest first, zero-filled, then the window row', async () => {
    requireFreshTestbed();
    const rows = await withClient(consoleUrl, async (c) =>
      (await c.query('SELECT * FROM admin_analytics_employer_weekly(12)')).rows);
    expect(rows).toHaveLength(13);
    const weeks = Array.from({ length: 12 }, (_, i) => new Date(monday.getTime() - (11 - i) * 7 * DAY).toISOString());
    expect(rows.slice(0, 12).map((r) => new Date(r.week_start).toISOString())).toEqual(weeks);
    expect(rows[12].week_start).toBeNull();
    for (const r of rows) {
      for (const k of COUNTS) expect({ week: r.week_start, k, v: r[k] }).toEqual({ week: r.week_start, k, v: expect.any(String) });
    }
    // Weeks 5-12 back hold no fixture (O1 was applied 13+ weeks ago).
    for (const r of rows.slice(0, 8)) {
      expect(COUNTS.map((k) => Number(r[k]))).toEqual(COUNTS.map(() => 0));
      expect(PCTS.map((k) => r[k])).toEqual(PCTS.map(() => null));
    }
  });

  it('ranks employers with 3+ applications by unanswered, then slowest median, no timed answer last', async () => {
    const rows = await withClient(consoleUrl, async (c) =>
      (await c.query('SELECT * FROM admin_analytics_slowest_employers(4, 100)')).rows);
    const mine = new Set([ids.ea, ids.ec, ids.ee, ids.eb, ids.ed, ids.er, ids.es, ids.ex, ids.ev, ids.eq, ids.t1, ids.t2]);
    const got = rows.filter((r) => mine.has(r.employer_id)).map((r) => ({
      employer_id: r.employer_id,
      display_name: r.display_name,
      applications: Number(r.applications),
      unanswered_7d: Number(r.unanswered_7d),
      first_response_p50_hours: num(r.first_response_p50_hours),
      active_jobs: Number(r.active_jobs),
    }));
    // E_C's median is NULL (only untimed answers): it ranks below the
    // measured employers with the same unanswered count. Contrata, Charla,
    // Quieta, Bordes, Vuelta and Turnos have 1-2 applications in the window;
    // the test employers never appear.
    expect(got).toEqual([
      { employer_id: ids.ea, display_name: LONG_COMPANY, applications: 4, unanswered_7d: 2, first_response_p50_hours: 50, active_jobs: 2 },
      { employer_id: ids.ee, display_name: 'Media SA', applications: 3, unanswered_7d: 1, first_response_p50_hours: 30, active_jobs: 1 },
      { employer_id: ids.eb, display_name: 'Rapida SA', applications: 3, unanswered_7d: 1, first_response_p50_hours: 2, active_jobs: 1 },
      { employer_id: ids.ec, display_name: 'Empleador', applications: 3, unanswered_7d: 1, first_response_p50_hours: null, active_jobs: 1 },
    ]);
  });

  it('applies the limit after ranking', async () => {
    const all = await withClient(consoleUrl, async (c) =>
      (await c.query('SELECT employer_id FROM admin_analytics_slowest_employers(4, 100)')).rows);
    const two = await withClient(consoleUrl, async (c) =>
      (await c.query('SELECT employer_id FROM admin_analytics_slowest_employers(4, 2)')).rows);
    expect(two).toEqual(all.slice(0, 2));
    const byDefault = await withClient(consoleUrl, async (c) =>
      (await c.query('SELECT employer_id FROM admin_analytics_slowest_employers(4)')).rows);
    expect(byDefault).toEqual(all.slice(0, 10));
  });

  it('lists active jobs idle for p_days by last employer action, most idle first', async () => {
    const mine = [ids.jaMain, ids.jaStale, ids.jaPaused, ids.jcMain, ids.jsWorker, ids.jsRead, ids.jsEmpty, ids.jt1, ids.jt1b, ids.jt2];
    const stale = async (days: number) => {
      const rows = await withClient(consoleUrl, async (c) =>
        (await c.query('SELECT * FROM admin_analytics_stale_jobs($1)', [days])).rows);
      return rows.filter((r) => mine.includes(r.job_id));
    };
    const nowMs = await dbNow(superUrl);
    const idle = (jobId: string): number => Math.floor((nowMs - lastAction[jobId].getTime()) / DAY);
    const rows = await stale(14);
    const expected = [
      // Posted 20 days ago (long title), never acted on; A1 and A2 wait.
      { job_id: ids.jaStale, title: LONG_TITLE, employer_id: ids.ea, display_name: LONG_COMPANY,
        waiting_applicants: 2, last_application_at: ids.a2AppliedAt },
      // A backfill event and a worker-driven status are not employer actions.
      { job_id: ids.jcMain, title: 'IT 2b Empleador stale', employer_id: ids.ec, display_name: 'Empleador',
        waiting_applicants: 1, last_application_at: ids.c3AppliedAt },
      // Nobody applied: waiting 0, no last application.
      { job_id: ids.jsEmpty, title: 'IT 2b Quieta empty', employer_id: ids.es, display_name: 'Quieta SA',
        waiting_applicants: 0, last_application_at: null },
      // Recent worker messages, status change and updated_at do not count.
      { job_id: ids.jsWorker, title: 'IT 2b Quieta worker', employer_id: ids.es, display_name: 'Quieta SA',
        waiting_applicants: 0, last_application_at: ids.s1AppliedAt },
      // A thread read an hour ago does not count either.
      { job_id: ids.jsRead, title: 'IT 2b Quieta read', employer_id: ids.es, display_name: 'Quieta SA',
        waiting_applicants: 0, last_application_at: ids.s2AppliedAt },
    ].map((e) => ({ ...e, last_employer_action_at: lastAction[e.job_id].toISOString(), days_idle: idle(e.job_id) }))
      .sort((a, b) => b.days_idle - a.days_idle || (a.job_id < b.job_id ? -1 : 1));
    // Nominally 20, 19, 18, 17 and 15 days; computed from the database clock.
    expect(rows.map((r) => ({
      job_id: r.job_id,
      title: r.title,
      employer_id: r.employer_id,
      display_name: r.display_name,
      waiting_applicants: Number(r.waiting_applicants),
      last_application_at: r.last_application_at === null ? null : new Date(r.last_application_at).toISOString(),
      last_employer_action_at: new Date(r.last_employer_action_at).toISOString(),
      days_idle: r.days_idle,
    }))).toEqual(expected);
    expect(new Date(rows[0].posted_at).toISOString()).toBe(ago(20 * DAY).toISOString());
    // p_days is inclusive: the 17-day job is in at 17 and out at 18.
    expect((await stale(idle(ids.jsWorker))).map((r) => r.job_id)).toContain(ids.jsWorker);
    expect((await stale(idle(ids.jsWorker) + 1)).map((r) => r.job_id)).not.toContain(ids.jsWorker);
  });

  it('leaves test employers out of every figure', async () => {
    const slowest = await withClient(consoleUrl, async (c) =>
      (await c.query('SELECT employer_id FROM admin_analytics_slowest_employers(26, 100)')).rows);
    const slowestIds = slowest.map((r) => r.employer_id);
    expect(slowestIds).not.toContain(ids.t1);
    expect(slowestIds).not.toContain(ids.t2);
    const stale = await withClient(consoleUrl, async (c) =>
      (await c.query('SELECT job_id FROM admin_analytics_stale_jobs(1)')).rows);
    const staleIds = stale.map((r) => r.job_id);
    for (const id of [ids.jt1, ids.jt1b, ids.jt2]) expect(staleIds).not.toContain(id);
    // The weekly deltas and active jobs (first two tests) already match the
    // non-test fixtures exactly.
  });

  it('reads job_conversations through the 114 policy, not by luck (the 088 defect)', async () => {
    // Inside one rolled-back transaction: drop the policy and call as the
    // console. Every conversation-based figure vanishes, so the policy is
    // what makes them readable. With the policy gone, the remaining
    // job_conversations_employer_all needs app.current_internal_user_id, which
    // the definer never sets, so no conversation is visible at all: the figure
    // is exactly 0, whatever data the testbed already holds.
    const withoutPolicy = await withClient(superUrl, async (su) => {
      await su.query('BEGIN');
      try {
        await su.query('DROP POLICY job_conversations_admin_analytics_read ON public.job_conversations');
        await su.query('SET LOCAL ROLE jale_admin_console');
        return (await su.query('SELECT * FROM admin_analytics_employer_weekly(4) WHERE week_start IS NULL')).rows[0];
      } finally {
        await su.query('ROLLBACK');
      }
    });
    expect(Number(withoutPolicy.worker_turns)).toBe(0);
    const after = await weekly(consoleUrl);
    expect(after.get(WINDOW)!.worker_turns - before.get(WINDOW)!.worker_turns).toBe(9);
  });

  it('returns exactly the columns the console maps, and no person', async () => {
    const cols = async (sql: string): Promise<string[]> =>
      withClient(consoleUrl, async (c) => (await c.query(sql)).fields.map((f) => f.name));
    expect(await cols('SELECT * FROM admin_analytics_employer_weekly(1)')).toEqual([
      'week_start', 'applications', 'answered', 'answered_untimed', 'unanswered_7d', 'applications_due',
      'first_response_p50_hours', 'first_response_p75_hours', 'worker_turns', 'turns_unanswered_7d', 'turns_due',
      'reply_p50_hours', 'reply_p75_hours', 'hires', 'hires_approximate',
      'time_to_hire_p50_days', 'time_to_hire_p75_days', 'active_jobs',
    ]);
    expect(await cols('SELECT * FROM admin_analytics_slowest_employers(1)')).toEqual([
      'employer_id', 'display_name', 'applications', 'unanswered_7d', 'first_response_p50_hours', 'active_jobs',
    ]);
    expect(await cols('SELECT * FROM admin_analytics_stale_jobs()')).toEqual([
      'job_id', 'title', 'employer_id', 'display_name', 'posted_at', 'last_employer_action_at',
      'days_idle', 'waiting_applicants', 'last_application_at',
    ]);
  });

  it('rejects out-of-range arguments', async () => {
    const call = (sql: string, args: unknown[]) => withClient(consoleUrl, (c) => c.query(sql, args));
    for (const weeks of [0, 27, null]) {
      await expect(call('SELECT * FROM admin_analytics_employer_weekly($1)', [weeks])).rejects.toThrow(/admin_analytics_invalid_weeks/);
      await expect(call('SELECT * FROM admin_analytics_slowest_employers($1, 10)', [weeks])).rejects.toThrow(/admin_analytics_invalid_weeks/);
    }
    for (const limit of [0, 101, null]) {
      await expect(call('SELECT * FROM admin_analytics_slowest_employers(4, $1)', [limit])).rejects.toThrow(/admin_analytics_invalid_limit/);
    }
    for (const days of [0, 366, null]) {
      await expect(call('SELECT * FROM admin_analytics_stale_jobs($1)', [days])).rejects.toThrow(/admin_analytics_invalid_days/);
    }
  });

  it('is callable by the console role only', async () => {
    for (const sql of [
      'SELECT * FROM admin_analytics_employer_weekly(4)',
      'SELECT * FROM admin_analytics_slowest_employers(4)',
      'SELECT * FROM admin_analytics_stale_jobs()',
    ]) {
      await expect(withClient(whatsappUrl, (c) => c.query(sql))).rejects.toThrow(/permission denied/);
    }
  });
});
