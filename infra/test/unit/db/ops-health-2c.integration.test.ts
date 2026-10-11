/**
 * ops-health-2c.integration.test.ts
 *
 * PostgreSQL-backed tests for migration 115 (roadmap 2c): the message backlog
 * right now (admin_analytics_message_backlog), message failures by week and
 * lane (admin_analytics_message_failures), AI voice extraction by week and
 * model (admin_analytics_voice_extraction), trust extraction by week and
 * extractor version (admin_analytics_trust_extraction), and the Stripe
 * billing inbox by week and event type (admin_analytics_billing_inbox) and
 * right now (admin_analytics_billing_inbox_now).
 *
 * The functions aggregate the whole database, so counts are asserted as a
 * delta between a baseline call (before fixtures) and a call after them, for
 * every (week, group) row and every whole-window row. The two fixture models
 * and the fixture-only extractor versions appear in no other data, so their
 * rows are compared exactly.
 *
 * FRESH TESTBED REQUIRED for the assertions that are not deltas: the oldest
 * stuck times (a minimum), the average sections (a mean), the empty-database
 * shapes and the 12-week zero-fill. They check the baseline first and fail
 * with an explicit "needs a fresh testbed" message on a database that already
 * held messages, extractions or billing events. So never run this suite after
 * other suites on a long-lived testbed.
 *
 * Fixtures are inserted as the superuser with session_replication_role =
 * replica, so no trigger moves a timestamp. Every time comes from the
 * database clock (now() when the suite starts), never the host's: weekly
 * fixtures are anchored to Monday 00:00 UTC of the previous two weeks (W1,
 * W2), so their week never depends on the weekday the suite runs; "right
 * now" fixtures are minutes or hours before that instant and at least three
 * minutes away from every boundary they test (retry windows, age buckets,
 * the 48-hour horizon, leases); the tests that read them first check that
 * less than two minutes have passed since seeding. Every fixture is at most
 * 21 days old, so a 4-week window holds it.
 *
 * Connection: set JALE_TEST_DATABASE_URL to a disposable Postgres 16 with the
 * full chain applied, as a superuser. When absent the suite is explicitly
 * skipped and says so (Rule 11: no silent skips).
 *   bash infra/db/local/bootstrap-testbed.sh --ephemeral --keep --no-tests --ref none
 *   then: cd infra && JALE_TEST_DATABASE_URL=<printed url> npx jest --runInBand test/unit/db/ops-health-2c.integration.test.ts
 *
 * Always pass --runInBand: the assertions are whole-database deltas, so
 * another suite inserting messages or extractions in a parallel worker would
 * break them.
 */

import { Client } from 'pg';
import { randomBytes, randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';

const databaseUrl = process.env.JALE_TEST_DATABASE_URL;

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const OPERATOR = 'it-2c';
const MARK = 'it-2c fixture';
const MODEL_A = 'it-2c.model-a';
const MODEL_B = 'it-2c.model-b';
const TRUST_MODEL = 'it-2c.trust-model';
const VERSION_2 = 'it-2c-v2';
const VERSION_IN_FLIGHT = 'it-2c-v3';
const EVENT_PREFIX = 'evt_it2c_';

const WINDOW = 'window';
const ALL = 'all';
/** Row key: week start (ISO) or the window, and the group (lane, model, version, type) or all. */
const key = (week: string | null, group: string | null): string => `${week ?? WINDOW}|${group ?? ALL}`;

const ACTIVE_LANES = ['reply', 'admin', 'worker_notification', 'employer_invite', 'employer_freeform'] as const;
type Lane = (typeof ACTIVE_LANES)[number] | 'job_alert';

const BACKLOG = ['open_under_1h', 'open_1_24h', 'open_24_48h', 'stuck'] as const;
const FAILURES = ['created', 'gave_up', 'delivery_failed'] as const;
const CAUSES = ['transcribe', 'empty_transcript', 'audio_read', 'model_call', 'bad_json', 'bad_shape', 'pipeline_error'] as const;
type Cause = (typeof CAUSES)[number];
const FIELDS = ['full_name', 'city', 'main_trade', 'main_trade_other', 'years_experience', 'has_transportation', 'availability'] as const;
type Field = (typeof FIELDS)[number];
const VOICE = [
  'processed', 'failed', 'failed_transcribe', 'failed_empty_transcript', 'failed_audio_read',
  'failed_model_call', 'failed_bad_json', 'failed_bad_shape', 'failed_pipeline_error', 'failed_unrecorded',
  'usable', 'full_name_found', 'city_found', 'main_trade_found', 'main_trade_other_due',
  'main_trade_other_found', 'years_experience_found', 'has_transportation_found', 'availability_found',
] as const;
const TRUST = ['extractions', 'failed', 'not_enough_detail'] as const;
const BILLING = ['received', 'processed', 'skipped', 'failed', 'retried', 'payment_failed_invoices'] as const;

type Row = Record<string, unknown>;
type Counts<K extends string> = Record<K, number>;

const zeros = <K extends string>(cols: readonly K[]): Counts<K> =>
  Object.fromEntries(cols.map((c) => [c, 0])) as Counts<K>;

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

async function rowsOf(url: string, sql: string, args: unknown[] = []): Promise<Row[]> {
  return withClient(url, async (c) => (await c.query(sql, args)).rows);
}

/** Monday 00:00 UTC of the week containing `d` (Postgres date_trunc('week', d, 'UTC')). */
function isoWeekStart(d: Date): string {
  const day = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  return new Date(day.getTime() - ((day.getUTCDay() + 6) % 7) * DAY).toISOString();
}

const iso = (v: unknown): string | null => (v === null ? null : new Date(v as Date).toISOString());

/** Rows keyed by (week, group), each column a number. */
function keyed<K extends string>(rows: Row[], group: string, cols: readonly K[]): Map<string, Counts<K>> {
  const out = new Map<string, Counts<K>>();
  for (const r of rows) {
    out.set(key(iso(r.week_start), r[group] as string | null),
      Object.fromEntries(cols.map((c) => [c, Number(r[c])])) as Counts<K>);
  }
  return out;
}

/** after - before for every row of `after` (a row missing from `before` counts from zero). */
function delta<K extends string>(after: Map<string, Counts<K>>, before: Map<string, Counts<K>>, cols: readonly K[]): Map<string, Counts<K>> {
  const out = new Map<string, Counts<K>>();
  for (const [k, a] of after) {
    const b = before.get(k);
    out.set(k, Object.fromEntries(cols.map((c) => [c, a[c] - (b?.[c] ?? 0)])) as Counts<K>);
  }
  return out;
}

/** Every returned row's delta equals the expectation (zeros where none), and every expected row was returned. */
function expectDeltas<K extends string>(got: Map<string, Counts<K>>, expected: Map<string, Counts<K>>, cols: readonly K[]): void {
  for (const [k, d] of got) {
    expect({ k, d }).toEqual({ k, d: expected.get(k) ?? zeros(cols) });
  }
  for (const k of expected.keys()) expect({ k, returned: got.has(k) }).toEqual({ k, returned: true });
}

function bump<K extends string>(m: Map<string, Counts<K>>, k: string, cols: readonly K[], add: Partial<Counts<K>>): void {
  const row = m.get(k) ?? zeros(cols);
  for (const c of cols) row[c] += add[c] ?? 0;
  m.set(k, row);
}

async function dbNow(url: string): Promise<number> {
  return withClient(url, async (c) => ((await c.query('SELECT now() AS n')).rows[0].n as Date).getTime());
}

const maybeDescribe = databaseUrl ? describe : describe.skip;
if (!databaseUrl) {
  // eslint-disable-next-line no-console
  console.warn('JALE_TEST_DATABASE_URL not set — skipping 2c ops health integration tests');
}

maybeDescribe('2c ops health (115)', () => {
  let superUrl = '';
  let consoleUrl = '';
  let whatsappUrl = '';
  // The database clock when the suite starts; every fixture time derives from it.
  let T = 0;
  let W1 = new Date(0);
  let W2 = new Date(0);
  let W3 = new Date(0);
  let monday = new Date(0);
  const at = (ms: number): Date => new Date(T - ms);
  const plus = (d: Date, ms: number): Date => new Date(d.getTime() + ms);

  const call = {
    backlog: (url: string) => rowsOf(url, 'SELECT * FROM admin_analytics_message_backlog()'),
    failures: (url: string, weeks = 4) => rowsOf(url, 'SELECT * FROM admin_analytics_message_failures($1)', [weeks]),
    voice: (url: string, weeks = 4) => rowsOf(url, 'SELECT * FROM admin_analytics_voice_extraction($1)', [weeks]),
    trust: (url: string, weeks = 4) => rowsOf(url, 'SELECT * FROM admin_analytics_trust_extraction($1)', [weeks]),
    billing: (url: string, weeks = 4) => rowsOf(url, 'SELECT * FROM admin_analytics_billing_inbox($1)', [weeks]),
    billingNow: (url: string) => rowsOf(url, 'SELECT * FROM admin_analytics_billing_inbox_now()'),
  };

  // Baselines, taken before any fixture.
  const before = {
    backlog: [] as Row[], failures: [] as Row[], voice: [] as Row[], trust: [] as Row[],
    billing: [] as Row[], billingNow: [] as Row[],
    failures12: [] as Row[], voice12: [] as Row[], trust12: [] as Row[], billing12: [] as Row[],
  };

  // What the fixtures should add (filled while seeding).
  type MsgOutcome = 'open' | 'gave_up' | 'delivery' | 'sent';
  const msgs: { lane: Lane; at: Date; outcome: MsgOutcome }[] = [];
  const voiceRows: { at: Date; model: string; cause: Cause | 'unrecorded' | null; found: Field[]; otherDue: boolean }[] = [];
  const trustRows: { at: Date; version: string; failed: boolean; withModel: boolean; sections: number }[] = [];
  const billingRows: { at: Date; type: string; status: string; attempts: number }[] = [];
  // The oldest stuck message per lane, and the oldest stuck / failed billing event.
  const oldestStuck: Partial<Record<Lane, Date>> = {};
  let oldestBilling = new Date(0);
  // The worker notification 093's 48-hour template ceiling failed.
  const deferred = { id: randomUUID(), token: randomUUID() };

  /** Mins, means and empty weeks are not deltas: they need a testbed holding only these fixtures. */
  function requireFreshTestbed(): void {
    const window = (rows: Row[], col: string): number =>
      rows.filter((r) => r.week_start === null && (r.lane ?? r.model ?? r.extractor_version ?? r.event_type ?? null) === null)
        .reduce((n, r) => n + Number(r[col]), 0);
    const open = before.backlog.reduce((n, r) => n + BACKLOG.reduce((m, c) => m + Number(r[c]), 0), 0);
    const held = {
      messages: window(before.failures12, 'created'),
      open_messages: open,
      voice_extractions: window(before.voice12, 'processed'),
      trust_extractions: window(before.trust12, 'extractions'),
      billing_events: window(before.billing12, 'received') + Number(before.billingNow[0].stuck_received)
        + Number(before.billingNow[0].failed_now) + Number(before.billingNow[0].unresolved_older),
    };
    if (Object.values(held).some((n) => n !== 0)) {
      throw new Error(
        'This assertion needs a fresh testbed (bootstrap-testbed.sh --ephemeral, then this suite first): '
        + `the database already held ${JSON.stringify(held)} before the fixtures.`,
      );
    }
  }

  /** The "right now" fixtures sit at least three minutes from their edges: fail plainly if the suite stalled. */
  async function requireClockMargin(): Promise<void> {
    const elapsed = (await dbNow(superUrl)) - T;
    if (elapsed > 2 * MIN) {
      throw new Error(`The "right now" fixtures were seeded ${Math.round(elapsed / 1000)} s ago; `
        + 'they sit three minutes from their boundaries, so this suite must reach this test within two minutes.');
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

  const user = async (c: Client, type: 'worker' | 'employer'): Promise<{ id: string; sub: string }> => {
    const sub = `${OPERATOR}-${randomBytes(6).toString('hex')}`;
    const id = (await c.query(
      `INSERT INTO users (cognito_sub, user_type) VALUES ($1, $2) RETURNING id`, [sub, type],
    )).rows[0].id as string;
    return { id, sub };
  };

  /** One whatsapp_outbox row in a lane; reply rows get their inbound message. */
  const wa = async (
    c: Client, lane: Exclude<Lane, 'employer_invite' | 'employer_freeform'>, created: Date, status: string,
    o: { attempts?: number; delivery?: string; leaseUntil?: Date; id?: string; token?: string } = {},
  ): Promise<void> => {
    let sid: string | null = null;
    if (lane === 'reply') {
      sid = `${OPERATOR}-${randomBytes(8).toString('hex')}`;
      await c.query(
        `INSERT INTO whatsapp_processed_messages (message_sid, whatsapp_number, status, first_seen_at)
         VALUES ($1, '+15550002000', 'completed', $2)`,
        [sid, created],
      );
    }
    const source = { reply: null, admin: 'admin_case', worker_notification: 'worker_intent', job_alert: 'job_alert' }[lane];
    await c.query(
      `INSERT INTO whatsapp_outbox
         (id, inbound_message_sid, sequence, whatsapp_number, body, status, attempt_count, created_at, sent_at,
          source_type, source_id, twilio_delivery_status, worker_intent_lease_token, worker_intent_leased_until)
       VALUES ($1, $2, 1, '+15550002000', $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
      [o.id ?? randomUUID(), sid, MARK, status, o.attempts ?? 0, created, status === 'sent' ? created : null,
        source, source === null ? null : randomUUID(), o.delivery ?? null,
        o.leaseUntil ? (o.token ?? randomUUID()) : null, o.leaseUntil ?? null],
    );
  };

  beforeAll(async () => {
    superUrl = databaseUrl!;
    await setServiceRolePasswords(superUrl);
    consoleUrl = urlForRole(superUrl, 'jale_admin_console', 'test-adminconsole-pw');
    whatsappUrl = urlForRole(superUrl, 'jale_whatsapp', 'test-whatsapp-pw');

    T = await dbNow(superUrl);
    monday = new Date(isoWeekStart(new Date(T)));
    // Always 7-14 and 14-21 days old, whatever the weekday.
    W1 = new Date(monday.getTime() - 7 * DAY);
    W2 = new Date(monday.getTime() - 14 * DAY);
    // The first week of a 4-week window.
    W3 = new Date(monday.getTime() - 21 * DAY);

    before.backlog = await call.backlog(consoleUrl);
    before.failures = await call.failures(consoleUrl);
    before.voice = await call.voice(consoleUrl);
    before.trust = await call.trust(consoleUrl);
    before.billing = await call.billing(consoleUrl);
    before.billingNow = await call.billingNow(consoleUrl);
    before.failures12 = await call.failures(consoleUrl, 12);
    before.voice12 = await call.voice(consoleUrl, 12);
    before.trust12 = await call.trust(consoleUrl, 12);
    before.billing12 = await call.billing(consoleUrl, 12);

    // ── WhatsApp lanes. Open = still being retried and created less than
    // 48 h ago; stuck = open longer than the lane's retry window; every unsent
    // row that is not open gave up. Each lane has an open row in every age
    // bucket (under 1 h, 1-24 h, 24-48 h).
    await seed(async (c) => {
      type WaOpts = { attempts?: number; delivery?: string; leaseUntil?: Date; id?: string; token?: string };
      const m = async (lane: Exclude<Lane, 'employer_invite' | 'employer_freeform'>, created: Date, status: string,
        outcome: MsgOutcome, o: WaOpts = {}): Promise<void> => {
        await wa(c, lane, created, status, o);
        msgs.push({ lane, at: created, outcome });
      };
      // Replies (30 min): 27 min is not stuck, 33 min is (failed at 2: open);
      // 5 h and 47 h open and stuck; still unsent at 49 h (pending at attempt
      // 0, the rest of a failed sequence) or 50 h (failed at 3, stranded after
      // SQS gave up) gave up -- nothing retries a message after 48 h; failed
      // at 5 and send_unknown gave up; Twilio failed and undelivered on a sent
      // row are delivery failures.
      await m('reply', at(10 * MIN), 'pending', 'open');
      await m('reply', at(27 * MIN), 'pending', 'open');
      await m('reply', at(33 * MIN), 'failed', 'open', { attempts: 2 });
      await m('reply', at(5 * HOUR), 'pending', 'open');
      await m('reply', at(47 * HOUR), 'pending', 'open');
      oldestStuck.reply = at(47 * HOUR);
      await m('reply', at(49 * HOUR), 'pending', 'gave_up');
      await m('reply', at(50 * HOUR), 'failed', 'gave_up', { attempts: 3 });
      await m('reply', at(2 * HOUR), 'failed', 'gave_up', { attempts: 5 });
      await m('reply', at(3 * HOUR), 'send_unknown', 'gave_up', { attempts: 1 });
      await m('reply', plus(W2, HOUR), 'sent', 'delivery', { attempts: 1, delivery: 'undelivered' });
      await m('reply', plus(W1, 2 * HOUR), 'sent', 'sent', { attempts: 1, delivery: 'delivered' });
      await m('reply', plus(W1, 3 * HOUR), 'sent', 'delivery', { attempts: 1, delivery: 'failed' });
      // Admin replies (10 min): 7 min is not stuck, 13 min is; failed at 4
      // (5 h) and pending at 46 h are open and stuck; 50 h gave up.
      await m('admin', at(7 * MIN), 'pending', 'open');
      await m('admin', at(13 * MIN), 'pending', 'open');
      await m('admin', at(5 * HOUR), 'failed', 'open', { attempts: 4 });
      await m('admin', at(46 * HOUR), 'pending', 'open');
      oldestStuck.admin = at(46 * HOUR);
      await m('admin', at(50 * HOUR), 'pending', 'gave_up');
      await m('admin', plus(W2, 2 * HOUR), 'failed', 'gave_up', { attempts: 5 });
      await m('admin', plus(W1, HOUR), 'sent', 'sent', { attempts: 1 });
      // Worker notifications (24 h): 23 h is not stuck, 25 h is; a live lease
      // is open (in flight); an expired lease and a tokenless send_unknown gave
      // up; a failed notification gave up whatever its attempts (093's 48-hour
      // template ceiling fails a row after 1-4 attempts and nothing re-leases
      // it): failed at 1, 30 h old -- inside the horizon, so only that rule
      // decides it -- and the row the real deferral fails below.
      await m('worker_notification', at(23 * HOUR), 'pending', 'open');
      await m('worker_notification', at(25 * HOUR), 'pending', 'open');
      oldestStuck.worker_notification = at(25 * HOUR);
      await m('worker_notification', at(5 * MIN), 'send_unknown', 'open', { attempts: 1, leaseUntil: plus(new Date(T), 30 * MIN) });
      await m('worker_notification', at(2 * HOUR), 'send_unknown', 'gave_up', { attempts: 1, leaseUntil: at(5 * MIN) });
      await m('worker_notification', at(30 * HOUR), 'failed', 'gave_up', { attempts: 1 });
      await m('worker_notification', plus(W1, 5 * HOUR), 'send_unknown', 'gave_up', { attempts: 1 });
      await m('worker_notification', plus(W2, 3 * HOUR), 'failed', 'gave_up', { attempts: 5 });
      await m('worker_notification', plus(W1, 6 * HOUR), 'sent', 'sent', { attempts: 1, delivery: 'delivered' });
      // Leased 49 h after it was queued; the drain defers it below.
      await m('worker_notification', at(49 * HOUR), 'send_unknown', 'gave_up',
        { attempts: 1, leaseUntil: plus(new Date(T), 10 * MIN), id: deferred.id, token: deferred.token });
      // Job alerts (dormant lane): one open row per age bucket and a delivery
      // failure; the lane exists only where it has rows.
      await m('job_alert', at(20 * MIN), 'pending', 'open');
      await m('job_alert', at(2 * HOUR), 'pending', 'open');
      await m('job_alert', at(26 * HOUR), 'pending', 'open');
      oldestStuck.job_alert = at(26 * HOUR);
      await m('job_alert', plus(W1, 10 * HOUR), 'sent', 'delivery', { attempts: 1, delivery: 'undelivered' });
    });
    // The drain's deferral, as the drain runs it (jale_whatsapp, 093's
    // defer_worker_intent_outbox): past the 48-hour ceiling the row becomes
    // failed and keeps attempt 1.
    const deferredOk = await withClient(whatsappUrl, async (c) => (await c.query(
      `SELECT defer_worker_intent_outbox($1, $2, 'twilio_63016_template_pending', 3600) AS ok`,
      [deferred.id, deferred.token])).rows[0].ok);
    if (deferredOk !== true) throw new Error('defer_worker_intent_outbox did not take the fixture lease');

    // ── Employer messages (job_message_outbox, 30 min). A failed row with
    // sent_at set was sent and then reported failed by Twilio: a delivery
    // failure, never open and never gave up (even at 5 attempts).
    await seed(async (c) => {
      const employer = await user(c, 'employer');
      const worker = await user(c, 'worker');
      const jobId = (await c.query(
        `INSERT INTO jobs (employer_id, title, location, job_type, status, created_at, updated_at)
         VALUES ($1, 'IT 2c outbox job', 'Tijuana', 'full-time', 'active', $2, $2) RETURNING id`,
        [employer.id, W3],
      )).rows[0].id as string;
      const appId = (await c.query(
        `INSERT INTO job_applications (job_id, worker_id, status, applied_at, created_at, updated_at)
         VALUES ($1, $2, 'talking', $3, $3, $3) RETURNING id`,
        [jobId, worker.id, W3],
      )).rows[0].id as string;
      const convId = (await c.query(
        `INSERT INTO job_conversations (job_id, employer_id, worker_id, application_id, status, created_at, updated_at)
         VALUES ($1, $2, $3, $4, 'open', $5, $5) RETURNING id`,
        [jobId, employer.id, worker.id, appId, W3],
      )).rows[0].id as string;
      const m = async (lane: 'employer_invite' | 'employer_freeform', created: Date, status: string,
        outcome: MsgOutcome, o: { attempts?: number; sentAt?: Date } = {}): Promise<void> => {
        const template = lane === 'employer_invite';
        await c.query(
          `INSERT INTO job_message_outbox
             (conversation_id, whatsapp_number, send_kind, content_template, content_variables, body,
              status, attempt_count, created_at, sent_at)
           VALUES ($1, '+15550002001', $2, $3, $4::jsonb, $5, $6, $7, $8, $9)`,
          [convId, template ? 'template' : 'freeform', template ? 'HXit2c' : null, template ? '{}' : null,
            template ? null : MARK, status, o.attempts ?? 0, created, o.sentAt ?? null],
        );
        msgs.push({ lane, at: created, outcome });
      };
      // Invites: 20 min open, 40 min stuck; failed at 2 without sent_at (3 h)
      // and pending at 30 h are open and stuck; failed with sent_at is a
      // delivery failure, not open.
      await m('employer_invite', at(20 * MIN), 'pending', 'open');
      await m('employer_invite', at(40 * MIN), 'pending', 'open');
      await m('employer_invite', at(3 * HOUR), 'failed', 'open', { attempts: 2 });
      await m('employer_invite', at(30 * HOUR), 'pending', 'open');
      oldestStuck.employer_invite = at(30 * HOUR);
      await m('employer_invite', at(4 * HOUR), 'failed', 'delivery', { attempts: 1, sentAt: at(4 * HOUR - MIN) });
      await m('employer_invite', plus(W2, 4 * HOUR), 'failed', 'gave_up', { attempts: 5 });
      await m('employer_invite', plus(W1, 7 * HOUR), 'send_unknown', 'gave_up', { attempts: 1 });
      await m('employer_invite', plus(W1, 8 * HOUR), 'sent', 'sent', { sentAt: plus(W1, 8 * HOUR) });
      // Free text: 15 min open; failed at 1 (6 h) and pending at 45 h open and
      // stuck; 51 h still pending gave up (a stopped sweeper retries nothing).
      await m('employer_freeform', at(15 * MIN), 'pending', 'open');
      await m('employer_freeform', at(6 * HOUR), 'failed', 'open', { attempts: 1 });
      await m('employer_freeform', at(45 * HOUR), 'pending', 'open');
      oldestStuck.employer_freeform = at(45 * HOUR);
      await m('employer_freeform', at(51 * HOUR), 'pending', 'gave_up');
      await m('employer_freeform', plus(W2, 5 * HOUR), 'sent', 'sent', { sentAt: plus(W2, 5 * HOUR) });
      await m('employer_freeform', plus(W1, 9 * HOUR), 'failed', 'delivery', { attempts: 5, sentAt: plus(W1, 9 * HOUR) });
    });

    // ── Voice extractions: every cause, the 0.75 gate, main_trade_other only
    // with main_trade = 'other', two models, and test profiles left out.
    await seed(async (c) => {
      const worker = await user(c, 'worker');
      const v = async (model: string, created: Date, status: 'completed' | 'failed',
        o: { kind?: Cause; fields?: unknown; scores?: unknown; test?: boolean } = {}): Promise<void> => {
        await c.query(
          `INSERT INTO worker_profile_ai_extractions
             (user_id, bedrock_model_id, status, failure_kind, extracted_fields, confidence_scores,
              ai_test_profile, created_at, updated_at)
           VALUES ($1, $2, $3, $4, $5::jsonb, $6::jsonb, $7, $8, $8)`,
          [worker.id, model, status, o.kind ?? null,
            o.fields === undefined ? null : JSON.stringify(o.fields),
            o.scores === undefined ? null : JSON.stringify(o.scores), o.test ?? false, created],
        );
      };
      const all = (score: number): Record<Field, number> =>
        Object.fromEntries(FIELDS.map((f) => [f, score])) as Record<Field, number>;

      // V1 (model A): every field found, a boolean false included, and
      // main_trade_other because main_trade is 'other'.
      await v(MODEL_A, plus(W2, HOUR), 'completed', {
        fields: { full_name: 'Juan Pérez', city: 'Tijuana', main_trade: 'other', main_trade_other: 'Soldador',
          years_experience: '5', has_transportation: false, availability: 'Lunes a viernes' },
        scores: all(0.9),
      });
      voiceRows.push({ at: plus(W2, HOUR), model: MODEL_A, cause: null, found: [...FIELDS], otherDue: true });
      // V2 (model A): 0.75 is in, 0.74 is out; an empty string, a JSON null
      // and a confidence written as a string are not found; main_trade_other
      // is not counted when main_trade is not 'other'.
      await v(MODEL_A, plus(W2, 2 * HOUR), 'completed', {
        fields: { full_name: 'Ana', city: 'Mexicali', main_trade: 'electrician', main_trade_other: 'Pintor',
          years_experience: '', has_transportation: null, availability: 'Mañanas' },
        scores: { full_name: 0.75, city: 0.74, main_trade: 0.8, main_trade_other: 0.9,
          years_experience: 0.9, has_transportation: 0.9, availability: '0.9' },
      });
      voiceRows.push({ at: plus(W2, 2 * HOUR), model: MODEL_A, cause: null, found: ['full_name', 'main_trade'], otherDue: false });
      // V3 (model B): a blank name, a missing field, a low score; main_trade
      // 'other' with no text is due but not found.
      await v(MODEL_B, plus(W1, HOUR), 'completed', {
        fields: { full_name: '   ', city: 'Ensenada', main_trade: 'other', main_trade_other: '',
          years_experience: '3', has_transportation: true },
        scores: { full_name: 0.95, city: 1, main_trade: 0.9, main_trade_other: 0.9,
          years_experience: 0.5, has_transportation: 0.76, availability: 0.9 },
      });
      voiceRows.push({ at: plus(W1, HOUR), model: MODEL_B, cause: null, found: ['city', 'main_trade', 'has_transportation'], otherDue: true });
      // Every recorded cause; audio, Transcribe and pipeline failures are not
      // the model's although the model id is stamped on the row.
      const failures: [string, Date, Cause][] = [
        [MODEL_A, plus(W2, 3 * HOUR), 'transcribe'],
        [MODEL_A, plus(W1, 2 * HOUR), 'empty_transcript'],
        [MODEL_B, plus(W1, 3 * HOUR), 'audio_read'],
        [MODEL_B, plus(W1, 4 * HOUR), 'model_call'],
        [MODEL_A, plus(W2, 4 * HOUR), 'bad_json'],
        [MODEL_A, plus(W1, 5 * HOUR), 'bad_shape'],
        [MODEL_B, plus(W2, 5 * HOUR), 'pipeline_error'],
      ];
      for (const [model, created, kind] of failures) {
        await v(model, created, 'failed', { kind });
        voiceRows.push({ at: created, model, cause: kind, found: [], otherDue: false });
      }
      // A failed row from before 115: cause not recorded.
      await v(MODEL_A, plus(W2, 6 * HOUR), 'failed');
      voiceRows.push({ at: plus(W2, 6 * HOUR), model: MODEL_A, cause: 'unrecorded', found: [], otherDue: false });
      // Completed rows the model filled with the wrong shape: NULL columns,
      // fields that are an array, scores that are an array. All bad_shape.
      await v(MODEL_B, plus(W1, 6 * HOUR), 'completed');
      voiceRows.push({ at: plus(W1, 6 * HOUR), model: MODEL_B, cause: 'bad_shape', found: [], otherDue: false });
      await v(MODEL_A, plus(W2, 7 * HOUR), 'completed', { fields: [], scores: all(0.9) });
      voiceRows.push({ at: plus(W2, 7 * HOUR), model: MODEL_A, cause: 'bad_shape', found: [], otherDue: false });
      // Good fields but scores that are not an object: bad_shape too.
      await v(MODEL_B, plus(W1, 8 * HOUR), 'completed', {
        fields: { full_name: 'Luis', city: 'Rosarito' }, scores: [0.9, 0.9],
      });
      voiceRows.push({ at: plus(W1, 8 * HOUR), model: MODEL_B, cause: 'bad_shape', found: [], otherDue: false });
      // Seed-script test profiles: never counted.
      await v(MODEL_A, plus(W1, 7 * HOUR), 'completed', {
        fields: { full_name: 'Prueba', city: 'Tijuana' }, scores: all(0.99), test: true,
      });
      await v(MODEL_B, plus(W2, 8 * HOUR), 'failed', { kind: 'model_call', test: true });
    });

    // ── Trust extractions: completed with and without a model call, failed,
    // in flight (left out), and a second version.
    await seed(async (c) => {
      const t = async (version: string, created: Date, status: string, model: string | null, extracted: unknown): Promise<void> => {
        const worker = await user(c, 'worker');
        const assessmentId = (await c.query(
          `INSERT INTO worker_trust_assessments (user_id, profession_key, answers, status, created_at)
           VALUES ($1, 'electrician', '[]', 'scored', $2) RETURNING id`,
          [worker.id, created],
        )).rows[0].id as string;
        await c.query(
          `INSERT INTO worker_trust_extractions
             (assessment_id, user_id, status, extracted, model_id, extractor_version, created_at, updated_at)
           VALUES ($1, $2, $3, $4::jsonb, $5, $6, $7, $7)`,
          [assessmentId, worker.id, status, JSON.stringify(extracted), model, version, created],
        );
      };
      const item = [{ label_en: 'x', label_es: 'x', source: [0] }];
      await t('v1', plus(W2, HOUR), 'completed', TRUST_MODEL,
        { skills: item, tools: item, experience_signals: [], safety: [], notable: [] });
      trustRows.push({ at: plus(W2, HOUR), version: 'v1', failed: false, withModel: true, sections: 2 });
      await t('v1', plus(W2, 2 * HOUR), 'completed', TRUST_MODEL,
        { skills: item, tools: item, experience_signals: item, safety: item, notable: item });
      trustRows.push({ at: plus(W2, 2 * HOUR), version: 'v1', failed: false, withModel: true, sections: 5 });
      // Not enough detail: completed without a model call.
      await t('v1', plus(W1, HOUR), 'completed', null, {});
      trustRows.push({ at: plus(W1, HOUR), version: 'v1', failed: false, withModel: false, sections: 0 });
      await t('v1', plus(W1, 2 * HOUR), 'failed', TRUST_MODEL, {});
      trustRows.push({ at: plus(W1, 2 * HOUR), version: 'v1', failed: true, withModel: true, sections: 0 });
      // In flight: never counted.
      await t('v1', plus(W1, 3 * HOUR), 'pending', null, {});
      await t('v1', plus(W2, 3 * HOUR), 'extracting', null, {});
      // A second version: an empty array and a non-array are not sections.
      await t(VERSION_2, plus(W1, 4 * HOUR), 'completed', TRUST_MODEL, { skills: [], tools: 'none', safety: item });
      trustRows.push({ at: plus(W1, 4 * HOUR), version: VERSION_2, failed: false, withModel: true, sections: 1 });
      // Failed before any model call: failed, not "not enough detail".
      await t(VERSION_2, plus(W1, 5 * HOUR), 'failed', null, {});
      trustRows.push({ at: plus(W1, 5 * HOUR), version: VERSION_2, failed: true, withModel: false, sections: 0 });
      // A version with only an in-flight row has no row at all.
      await t(VERSION_IN_FLIGHT, plus(W1, 6 * HOUR), 'extracting', null, {});
    });

    // ── Billing inbox. Stuck = received with no live lease; failed rows
    // wait for a retry; both only within one hour of being received (the
    // processor dead-letters an event after about 20 minutes), and the
    // oldest counts both. Every "right now" row sits at least 10 minutes
    // from the one-hour edge, and the two oldest rows a day from the 14-day
    // edge (the billing dead-letter queue's retention).
    await seed(async (c) => {
      const b = async (type: string, received: Date, status: string, attempts: number, lease: Date | null,
        processed: Date = received): Promise<void> => {
        await c.query(
          `INSERT INTO billing_webhook_events
             (stripe_event_id, event_type, processing_status, attempt_count, lease_expires_at, received_at, processed_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7)`,
          [`${EVENT_PREFIX}${randomBytes(8).toString('hex')}`, type, status, attempts, lease, received,
            status === 'processed' || status === 'skipped' ? processed : null],
        );
        billingRows.push({ at: received, type, status, attempts });
      };
      // In flight: re-claimed with a live lease, whatever their age (6 h, and
      // 50 min, older than every stuck row): not stuck, not unresolved, and
      // never the oldest.
      await b('customer.subscription.updated', at(6 * HOUR), 'received', 2, plus(new Date(T), 30 * MIN));
      await b('invoice.paid', at(50 * MIN), 'received', 1, plus(new Date(T), 5 * MIN));
      // Within the hour: an expired lease (20 min) and a NULL lease (35 min,
      // not live either: the processor re-claims it) are stuck; a failed
      // event (45 min) is failed now, and the oldest of the three.
      await b('invoice.paid', at(20 * MIN), 'received', 1, at(10 * MIN));
      await b('invoice.payment_failed', at(35 * MIN), 'received', 2, null);
      await b('invoice.paid', at(45 * MIN), 'failed', 3, null);
      oldestBilling = at(45 * MIN);
      // Received an hour to 14 days ago and still failed / stuck: dead-lettered
      // in the last 14 days, "unresolved" (redrivable from the queue) -- a
      // failed event at 90 min, an expired claim at 70 min, another at 50 h
      // and a failed one at 13 days (a day inside the cap): not stuck, not
      // failed now, and never the oldest.
      await b('invoice.paid', at(90 * MIN), 'failed', 3, null);
      await b('customer.subscription.updated', at(70 * MIN), 'received', 1, at(65 * MIN));
      await b('customer.subscription.updated', at(50 * HOUR), 'received', 1, at(49 * HOUR));
      await b('invoice.paid', at(13 * DAY), 'failed', 3, null);
      // Failed 15 days ago (a day past the cap): the queue keeps a message 14
      // days, so it has left the queue and must be resent from Stripe. It is
      // in none of the three right-now figures -- and never the oldest -- but
      // it is still a failed event in its week.
      await b('invoice.paid', at(15 * DAY), 'failed', 3, null);
      await b('invoice.payment_failed', plus(W2, HOUR), 'processed', 1, null);
      // Received Sunday 23:00 (W2), processed on the retry Monday 01:00 (W1):
      // it counts in W2, the week it was received.
      await b('customer.subscription.updated', plus(W1, -HOUR), 'processed', 2, null, plus(W1, HOUR));
      await b('customer.created', plus(W1, HOUR), 'skipped', 1, null);
      await b('customer.created', plus(W1, 2 * HOUR), 'skipped', 1, null);
      await b('charge.refunded', plus(W1, 3 * HOUR), 'skipped', 1, null);
      await b('invoice.paid', plus(W1, 4 * HOUR), 'processed', 1, null);
    });
  }, 120_000);

  afterAll(async () => {
    if (!databaseUrl) return;
    await withClient(superUrl, async (su) => {
      // Inbound messages cascade their reply rows; the other lanes by marker.
      await su.query(`DELETE FROM whatsapp_processed_messages WHERE message_sid LIKE $1`, [`${OPERATOR}-%`]);
      await su.query(`DELETE FROM whatsapp_outbox WHERE body = $1`, [MARK]);
      // Jobs cascade applications, conversations and their outbox rows.
      await su.query(
        `DELETE FROM jobs WHERE employer_id IN (SELECT id FROM users WHERE cognito_sub LIKE $1)`, [`${OPERATOR}-%`]);
      await su.query(
        `DELETE FROM worker_profile_ai_extractions WHERE user_id IN (SELECT id FROM users WHERE cognito_sub LIKE $1)`,
        [`${OPERATOR}-%`]);
      await su.query(
        `DELETE FROM worker_profile_media WHERE user_id IN (SELECT id FROM users WHERE cognito_sub LIKE $1)`,
        [`${OPERATOR}-%`]);
      // Users cascade trust assessments and their extractions.
      await su.query(`DELETE FROM users WHERE cognito_sub LIKE $1`, [`${OPERATOR}-%`]);
      await su.query(`DELETE FROM billing_webhook_events WHERE stripe_event_id LIKE $1`, [`${EVENT_PREFIX}%`]);
    });
  }, 60_000);

  const inWindow = (d: Date): boolean => d >= W3;

  it('sorts open messages into age buckets and stuck by each lane retry window', async () => {
    await requireClockMargin();
    const backlogBefore = keyed(before.backlog.map((r) => ({ ...r, week_start: null })), 'lane', BACKLOG);
    const rows = await call.backlog(consoleUrl);
    const after = keyed(rows.map((r) => ({ ...r, week_start: null })), 'lane', BACKLOG);
    const got = Object.fromEntries([...delta(after, backlogBefore, BACKLOG)].map(([k, d]) => [k.split('|')[1], d]));
    expect(got).toEqual({
      // 10 min, 27 min (not stuck), failed@2 33 min (stuck); 5 h (stuck);
      // 47 h (stuck). 49 h and 50 h are past the horizon: gave up, not open.
      reply: { open_under_1h: 3, open_1_24h: 1, open_24_48h: 1, stuck: 3 },
      // 7 min (not stuck), 13 min (stuck); failed@4 5 h; 46 h. 50 h gave up.
      admin: { open_under_1h: 2, open_1_24h: 1, open_24_48h: 1, stuck: 3 },
      // Live lease 5 min (in flight: open, not stuck); 23 h; 25 h (stuck).
      // Failed at 1 (30 h, and the 49 h deferral) gave up: neither is open.
      worker_notification: { open_under_1h: 1, open_1_24h: 1, open_24_48h: 1, stuck: 1 },
      // 20 min; 40 min (stuck); failed@2 3 h; 30 h. Failed with sent_at is not open.
      employer_invite: { open_under_1h: 2, open_1_24h: 1, open_24_48h: 1, stuck: 3 },
      // 15 min; failed@1 6 h; 45 h. 51 h gave up; failed with sent_at is not open.
      employer_freeform: { open_under_1h: 1, open_1_24h: 1, open_24_48h: 1, stuck: 2 },
      // 20 min; 2 h; 26 h: the dormant lane shows up once it has an open row.
      job_alert: { open_under_1h: 1, open_1_24h: 1, open_24_48h: 1, stuck: 2 },
    });
    // Display order, the job-alert lane last.
    expect(rows.map((r) => r.lane)).toEqual([...ACTIVE_LANES, 'job_alert']);
  });

  it('reports the oldest stuck message per lane', async () => {
    requireFreshTestbed();
    await requireClockMargin();
    const rows = await call.backlog(consoleUrl);
    expect(Object.fromEntries(rows.map((r) => [r.lane, iso(r.oldest_stuck_at)]))).toEqual(
      Object.fromEntries(Object.entries(oldestStuck).map(([lane, d]) => [lane, d!.toISOString()])),
    );
  });

  it('returns one zero row per active lane, and no job-alert row, on an empty database', async () => {
    requireFreshTestbed();
    expect(before.backlog.map((r) => ({ ...r }))).toEqual(ACTIVE_LANES.map((lane) => ({
      lane, open_under_1h: '0', open_1_24h: '0', open_24_48h: '0', stuck: '0', oldest_stuck_at: null,
    })));
    expect(before.billingNow).toEqual([{ stuck_received: '0', failed_now: '0', unresolved_older: '0', oldest_stuck_at: null }]);
  });

  it('counts created, gave up and delivery failures per week and lane, and over the window', async () => {
    await requireClockMargin();
    const got = delta(keyed(await call.failures(consoleUrl), 'lane', FAILURES), keyed(before.failures, 'lane', FAILURES), FAILURES);
    const expected = new Map<string, Counts<(typeof FAILURES)[number]>>();
    for (const m of msgs.filter((x) => inWindow(x.at))) {
      const add = { created: 1, gave_up: m.outcome === 'gave_up' ? 1 : 0, delivery_failed: m.outcome === 'delivery' ? 1 : 0 };
      for (const k of [key(isoWeekStart(m.at), m.lane), key(null, m.lane), key(null, null)]) bump(expected, k, FAILURES, add);
    }
    expectDeltas(got, expected, FAILURES);
    // The window rows, whatever the weekday.
    expect(Object.fromEntries([...ACTIVE_LANES, 'job_alert', null].map((lane) => [lane ?? ALL, expected.get(key(null, lane))]))).toEqual({
      reply: { created: 12, gave_up: 4, delivery_failed: 2 },
      admin: { created: 7, gave_up: 2, delivery_failed: 0 },
      worker_notification: { created: 9, gave_up: 5, delivery_failed: 0 },
      employer_invite: { created: 8, gave_up: 2, delivery_failed: 1 },
      employer_freeform: { created: 6, gave_up: 1, delivery_failed: 1 },
      job_alert: { created: 4, gave_up: 0, delivery_failed: 1 },
      [ALL]: { created: 46, gave_up: 14, delivery_failed: 5 },
    });
  });

  it('returns every (week, active lane) pair zero-filled, job alerts only where they exist, then the window rows', async () => {
    requireFreshTestbed();
    const rows = await call.failures(consoleUrl, 12);
    const weeks = Array.from({ length: 12 }, (_, i) => new Date(monday.getTime() - (11 - i) * 7 * DAY).toISOString());
    const alertWeeks = new Set(msgs.filter((m) => m.lane === 'job_alert').map((m) => isoWeekStart(m.at)));
    const expectedKeys = [
      ...weeks.flatMap((w) => [...ACTIVE_LANES, ...(alertWeeks.has(w) ? ['job_alert'] : [])].map((lane) => key(w, lane))),
      ...[...ACTIVE_LANES, 'job_alert'].map((lane) => key(null, lane)),
      key(null, null),
    ];
    expect(rows.map((r) => key(iso(r.week_start), r.lane as string | null))).toEqual(expectedKeys);
    // Weeks 4-11 back hold no fixture.
    for (const r of rows.filter((x) => x.week_start !== null && new Date(x.week_start as Date) < W3)) {
      expect(FAILURES.map((c) => r[c])).toEqual(['0', '0', '0']);
    }
  });

  it('counts voice extractions by cause, usable rows and fields found, per week, per model and over the window', async () => {
    const got = delta(keyed(await call.voice(consoleUrl), 'model', VOICE), keyed(before.voice, 'model', VOICE), VOICE);
    const expected = new Map<string, Counts<(typeof VOICE)[number]>>();
    for (const r of voiceRows.filter((x) => inWindow(x.at))) {
      const usable = r.cause === null;
      const add: Partial<Counts<(typeof VOICE)[number]>> = {
        processed: 1,
        usable: usable ? 1 : 0,
        main_trade_other_due: r.otherDue ? 1 : 0,
        main_trade_other_found: r.otherDue && r.found.includes('main_trade_other') ? 1 : 0,
      };
      if (!usable) {
        add.failed = 1;
        add[`failed_${r.cause}` as (typeof VOICE)[number]] = 1;
      }
      for (const f of FIELDS) if (f !== 'main_trade_other' && r.found.includes(f)) add[`${f}_found` as (typeof VOICE)[number]] = 1;
      const attributed = usable || r.cause === 'model_call' || r.cause === 'bad_json' || r.cause === 'bad_shape';
      const keys = [key(isoWeekStart(r.at), null), key(null, null)];
      if (attributed) keys.push(key(isoWeekStart(r.at), r.model), key(null, r.model));
      for (const k of keys) bump(expected, k, VOICE, add);
    }
    expectDeltas(got, expected, VOICE);
    // The window, whatever the weekday: 14 rows (the two test-profile rows
    // left out), 3 usable, 11 failed of which 4 bad_shape (one recorded,
    // three completed rows with the wrong shape) and 1 not recorded.
    expect(expected.get(key(null, null))).toEqual({
      processed: 14, failed: 11, failed_transcribe: 1, failed_empty_transcript: 1, failed_audio_read: 1,
      failed_model_call: 1, failed_bad_json: 1, failed_bad_shape: 4, failed_pipeline_error: 1, failed_unrecorded: 1,
      usable: 3, full_name_found: 2, city_found: 2, main_trade_found: 3, main_trade_other_due: 2,
      main_trade_other_found: 1, years_experience_found: 1, has_transportation_found: 2, availability_found: 1,
    });
  });

  it('attributes to a model only its usable rows and its own failures', async () => {
    const rows = (await call.voice(consoleUrl)).filter((r) => r.model === MODEL_A || r.model === MODEL_B);
    const byKey = keyed(rows, 'model', VOICE);
    // Exactly these per-model rows: model B has a pipeline failure in W2,
    // which is not its own, so (W2, B) does not exist.
    expect([...byKey.keys()].sort()).toEqual([
      key(W1.toISOString(), MODEL_A), key(W1.toISOString(), MODEL_B), key(W2.toISOString(), MODEL_A),
      key(null, MODEL_A), key(null, MODEL_B),
    ].sort());
    const pick = (k: string): Partial<Counts<(typeof VOICE)[number]>> => {
      const r = byKey.get(k)!;
      return Object.fromEntries(Object.entries(r).filter(([, n]) => n !== 0));
    };
    expect(pick(key(null, MODEL_A))).toEqual({
      processed: 5, failed: 3, failed_bad_json: 1, failed_bad_shape: 2, usable: 2, full_name_found: 2,
      city_found: 1, main_trade_found: 2, main_trade_other_due: 1, main_trade_other_found: 1,
      years_experience_found: 1, has_transportation_found: 1, availability_found: 1,
    });
    expect(pick(key(null, MODEL_B))).toEqual({
      processed: 4, failed: 3, failed_model_call: 1, failed_bad_shape: 2, usable: 1,
      city_found: 1, main_trade_found: 1, main_trade_other_due: 1, has_transportation_found: 1,
    });
  });

  it('counts trust extractions per week and version, leaving in-flight rows out', async () => {
    const got = delta(keyed(await call.trust(consoleUrl), 'extractor_version', TRUST),
      keyed(before.trust, 'extractor_version', TRUST), TRUST);
    const expected = new Map<string, Counts<(typeof TRUST)[number]>>();
    for (const r of trustRows.filter((x) => inWindow(x.at))) {
      const add = { extractions: 1, failed: r.failed ? 1 : 0, not_enough_detail: !r.failed && !r.withModel ? 1 : 0 };
      for (const k of [key(isoWeekStart(r.at), null), key(null, null), key(isoWeekStart(r.at), r.version), key(null, r.version)]) {
        bump(expected, k, TRUST, add);
      }
    }
    expectDeltas(got, expected, TRUST);
    expect(expected.get(key(null, null))).toEqual({ extractions: 6, failed: 2, not_enough_detail: 1 });
    // A version with only in-flight rows has no row.
    const rows = await call.trust(consoleUrl);
    expect(rows.filter((r) => r.extractor_version === VERSION_IN_FLIGHT)).toEqual([]);
  });

  it('averages non-empty sections over completed extractions with a model call', async () => {
    requireFreshTestbed();
    const rows = await call.trust(consoleUrl);
    const avg = Object.fromEntries(rows.map((r) => [key(iso(r.week_start), r.extractor_version as string | null), r.avg_sections]));
    const w1 = W1.toISOString();
    const w2 = W2.toISOString();
    // W2: 2 and 5 sections; W1: the v2 row's 1 (the not-enough-detail row
    // and the failures do not count); window: (2 + 5 + 1) / 3.
    expect(avg).toEqual({
      [key(W3.toISOString(), null)]: null,
      [key(w2, null)]: '3.5',
      [key(w2, 'v1')]: '3.5',
      [key(w1, null)]: '1.0',
      [key(w1, 'v1')]: null,
      [key(w1, VERSION_2)]: '1.0',
      [key(monday.toISOString(), null)]: null,
      [key(null, null)]: '2.7',
      [key(null, 'v1')]: '3.5',
      [key(null, VERSION_2)]: '1.0',
    });
  });

  it('counts billing events per week and type by received_at, and over the window', async () => {
    const got = delta(keyed(await call.billing(consoleUrl), 'event_type', BILLING),
      keyed(before.billing, 'event_type', BILLING), BILLING);
    const expected = new Map<string, Counts<(typeof BILLING)[number]>>();
    for (const r of billingRows.filter((x) => inWindow(x.at))) {
      const add = {
        received: 1,
        processed: r.status === 'processed' ? 1 : 0,
        skipped: r.status === 'skipped' ? 1 : 0,
        failed: r.status === 'failed' ? 1 : 0,
        retried: r.attempts > 1 ? 1 : 0,
        payment_failed_invoices: r.type === 'invoice.payment_failed' ? 1 : 0,
      };
      for (const k of [key(isoWeekStart(r.at), null), key(null, null), key(isoWeekStart(r.at), r.type), key(null, r.type)]) {
        bump(expected, k, BILLING, add);
      }
    }
    expectDeltas(got, expected, BILLING);
    // The 13-day and 15-day failed events are weekly facts like any other.
    expect(expected.get(key(null, null))).toEqual({
      received: 16, processed: 3, skipped: 3, failed: 4, retried: 7, payment_failed_invoices: 2,
    });
    expect(expected.get(key(null, 'customer.created'))).toEqual({
      received: 2, processed: 0, skipped: 2, failed: 0, retried: 0, payment_failed_invoices: 0,
    });
  });

  it('counts billing events stuck in received and failed now within the hour, those dead-lettered in the last 14 days, and the oldest', async () => {
    await requireClockMargin();
    const [now] = await call.billingNow(consoleUrl);
    const [base] = before.billingNow;
    // Stuck (received less than an hour ago): the expired lease (20 min) and
    // the NULL lease (35 min), not the live leases (50 min, 6 h); failed now:
    // the 45 min failure; unresolved (an hour to 14 days ago): the 90 min
    // failure, the 70 min expired claim, the 50 h expired claim and the 13 day
    // failure, which count in neither of the others. The 15 day failure is
    // past the dead-letter queue's 14-day retention: it counts in none of the
    // three.
    expect(Number(now.stuck_received) - Number(base.stuck_received)).toBe(2);
    expect(Number(now.failed_now) - Number(base.failed_now)).toBe(1);
    expect(Number(now.unresolved_older) - Number(base.unresolved_older)).toBe(4);
    requireFreshTestbed();
    // The failed event (45 min) is older than both stuck ones; the in-flight
    // event (50 min), the unresolved ones (70 min, 90 min, 50 h, 13 days) and
    // the one past the cap (15 days) are older still but not stuck or failed
    // now.
    expect(iso(now.oldest_stuck_at)).toBe(oldestBilling.toISOString());
    expect(now).toEqual({
      stuck_received: '2', failed_now: '1', unresolved_older: '4', oldest_stuck_at: oldestBilling,
    });
  });

  it('groups by UTC weeks whatever the session TimeZone', async () => {
    for (const fn of ['admin_analytics_message_failures', 'admin_analytics_voice_extraction',
      'admin_analytics_trust_extraction', 'admin_analytics_billing_inbox']) {
      const rowsIn = async (tz: string): Promise<string[]> => withClient(consoleUrl, async (c) => {
        await c.query(`SET TIME ZONE '${tz}'`);
        const rows = (await c.query(`SELECT * FROM ${fn}(4)`)).rows;
        return rows.map((r) => JSON.stringify({ ...r, week_start: iso(r.week_start) }));
      });
      const utc = await rowsIn('UTC');
      expect({ fn, rows: await rowsIn('Pacific/Auckland') }).toEqual({ fn, rows: utc });
      expect({ fn, rows: await rowsIn('America/Los_Angeles') }).toEqual({ fn, rows: utc });
    }
  });

  it('zero-fills every week of a 12-week window with one all-groups row, then the window rows', async () => {
    requireFreshTestbed();
    const weeks = Array.from({ length: 12 }, (_, i) => new Date(monday.getTime() - (11 - i) * 7 * DAY).toISOString());
    for (const [fn, group, cols] of [
      ['admin_analytics_voice_extraction', 'model', VOICE],
      ['admin_analytics_trust_extraction', 'extractor_version', TRUST],
      ['admin_analytics_billing_inbox', 'event_type', BILLING],
    ] as const) {
      const rows = await rowsOf(consoleUrl, `SELECT * FROM ${fn}(12)`);
      const totals = rows.filter((r) => r[group] === null);
      expect({ fn, weeks: totals.map((r) => iso(r.week_start)) }).toEqual({ fn, weeks: [...weeks, null] });
      for (const r of totals.filter((x) => x.week_start !== null && new Date(x.week_start as Date) < W3)) {
        expect({ fn, week: iso(r.week_start), v: (cols as readonly string[]).map((c) => r[c]) })
          .toEqual({ fn, week: iso(r.week_start), v: (cols as readonly string[]).map(() => '0') });
      }
      // Rows come oldest week first, the all-groups row before its groups, the window rows last.
      const order = rows.map((r) => [iso(r.week_start) ?? 'z', r[group] === null ? '' : String(r[group])].join('|'));
      expect({ fn, order }).toEqual({ fn, order: [...order].sort() });
    }
  });

  it('reads each FORCE-RLS table through its 115 policy, not by luck (the 088 defect)', async () => {
    // Inside one rolled-back transaction per policy: drop it and call as the
    // console. The section it feeds reads exactly zero: no remaining policy
    // lets a definer see a row (each needs a per-user setting the definer
    // never sets), whatever data the testbed holds.
    const without = async (table: string, policy: string, sql: string): Promise<Row[]> =>
      withClient(superUrl, async (su) => {
        await su.query('BEGIN');
        try {
          await su.query(`DROP POLICY ${policy} ON public.${table}`);
          await su.query('SET LOCAL ROLE jale_admin_console');
          return (await su.query(sql)).rows;
        } finally {
          await su.query('ROLLBACK');
        }
      });
    const employerLanes = await without('job_message_outbox', 'job_message_outbox_admin_analytics_read',
      `SELECT lane, created FROM admin_analytics_message_failures(4)
        WHERE week_start IS NULL AND lane IN ('employer_invite', 'employer_freeform', 'reply') ORDER BY lane`);
    // whatsapp_outbox is read as its owner, so the reply lane is unaffected.
    expect(employerLanes.map((r) => [r.lane, Number(r.created) > 0])).toEqual([
      ['employer_freeform', false], ['employer_invite', false], ['reply', true],
    ]);
    const voice = await without('worker_profile_ai_extractions', 'worker_profile_ai_extractions_admin_analytics_read',
      'SELECT processed FROM admin_analytics_voice_extraction(4) WHERE week_start IS NULL AND model IS NULL');
    expect(voice).toEqual([{ processed: '0' }]);
    const trust = await without('worker_trust_extractions', 'worker_trust_extractions_admin_analytics_read',
      'SELECT extractions FROM admin_analytics_trust_extraction(4) WHERE week_start IS NULL AND extractor_version IS NULL');
    expect(trust).toEqual([{ extractions: '0' }]);
    const billing = await without('billing_webhook_events', 'billing_webhook_events_admin_analytics_read',
      `SELECT (SELECT received FROM admin_analytics_billing_inbox(4) WHERE week_start IS NULL AND event_type IS NULL) AS received,
              n.stuck_received, n.failed_now, n.unresolved_older FROM admin_analytics_billing_inbox_now() n`);
    expect(billing).toEqual([{ received: '0', stuck_received: '0', failed_now: '0', unresolved_older: '0' }]);
    // With the policies in place, each section sees the fixtures.
    const failures = keyed(await call.failures(consoleUrl), 'lane', FAILURES);
    expect(failures.get(key(null, 'employer_invite'))!.created).toBeGreaterThanOrEqual(7);
    expect(Number((await call.voice(consoleUrl)).find((r) => r.week_start === null && r.model === null)!.processed)).toBeGreaterThanOrEqual(14);
    expect(Number((await call.billingNow(consoleUrl))[0].unresolved_older)).toBeGreaterThanOrEqual(4);
  });

  it("counts a worker notification failed by 093's 48-hour template ceiling as gave up, never open", async () => {
    // The real deferral left it failed at its single attempt (093 keeps the
    // count as evidence); the backlog and failures tests above count it as
    // gave up and not open.
    const [row] = await rowsOf(superUrl,
      'SELECT status, attempt_count, worker_intent_lease_token FROM whatsapp_outbox WHERE id = $1', [deferred.id]);
    expect(row).toEqual({ status: 'failed', attempt_count: 1, worker_intent_lease_token: null });
  });

  it('leaves a source_type that maps to no lane out of every lane and every total', async () => {
    // 042's origin CHECK admits no other source today; drop it inside a
    // rolled-back transaction and add a row nobody knows.
    const [beforeRows, afterRows] = await withClient(superUrl, async (su): Promise<[Row[][], Row[][]]> => {
      await su.query('BEGIN');
      try {
        const read = async (): Promise<Row[][]> => {
          await su.query('SET LOCAL ROLE jale_admin_console');
          const out = [
            (await su.query('SELECT * FROM admin_analytics_message_backlog()')).rows,
            (await su.query('SELECT * FROM admin_analytics_message_failures(4)')).rows,
          ];
          await su.query('RESET ROLE');
          return out;
        };
        const first = await read();
        await su.query('ALTER TABLE public.whatsapp_outbox DROP CONSTRAINT whatsapp_outbox_origin_check');
        await su.query(
          `INSERT INTO whatsapp_outbox (sequence, whatsapp_number, body, status, attempt_count, created_at, source_type, source_id)
           VALUES (1, '+15550002000', $1, 'pending', 0, now() - interval '2 hours', 'it_2c_unknown', gen_random_uuid())`,
          [MARK]);
        return [first, await read()];
      } finally {
        await su.query('ROLLBACK');
      }
    });
    expect(afterRows).toEqual(beforeRows);
    // Exactly one all-lanes window row.
    expect(afterRows[1].filter((r) => r.week_start === null && r.lane === null)).toHaveLength(1);
  });

  it('shows the job-alert lane in the backlog only while it has open rows, and in the failures wherever it has rows', async () => {
    requireFreshTestbed();
    // Rolled back: every fixture job alert marked sent, so none is open.
    const [lanes, alertRows] = await withClient(superUrl, async (su): Promise<[string[], Row[]]> => {
      await su.query('BEGIN');
      try {
        await su.query(
          `UPDATE whatsapp_outbox SET status = 'sent', sent_at = created_at
            WHERE body = $1 AND source_type = 'job_alert' AND status <> 'sent'`, [MARK]);
        await su.query('SET LOCAL ROLE jale_admin_console');
        return [
          (await su.query('SELECT lane FROM admin_analytics_message_backlog()')).rows.map((r) => r.lane as string),
          (await su.query(`SELECT week_start, created FROM admin_analytics_message_failures(4) WHERE lane = 'job_alert'`)).rows,
        ];
      } finally {
        await su.query('ROLLBACK');
      }
    });
    expect(lanes).toEqual([...ACTIVE_LANES]);
    const alerts = msgs.filter((m) => m.lane === 'job_alert');
    const weeks = [...new Set(alerts.map((m) => isoWeekStart(m.at)))].sort();
    expect(alertRows.map((r) => [iso(r.week_start), Number(r.created)])).toEqual([
      ...weeks.map((w) => [w, alerts.filter((m) => isoWeekStart(m.at) === w).length]),
      [null, alerts.length],
    ]);
  });

  it('reads whatsapp_outbox as its owner, which FORCE row level security would silently break', async () => {
    const replies = await withClient(superUrl, async (su) => {
      await su.query('BEGIN');
      try {
        await su.query('ALTER TABLE public.whatsapp_outbox FORCE ROW LEVEL SECURITY');
        await su.query('SET LOCAL ROLE jale_admin_console');
        return (await su.query(
          `SELECT created FROM admin_analytics_message_failures(4) WHERE week_start IS NULL AND lane = 'reply'`)).rows;
      } finally {
        await su.query('ROLLBACK');
      }
    });
    // Why the migration refuses to apply on a FORCE'd whatsapp_outbox.
    expect(replies).toEqual([{ created: '0' }]);
  });

  it('lets the AI writer record a cause on failed rows only, with the seven causes', async () => {
    const [worker] = await rowsOf(superUrl,
      `SELECT u.id, u.cognito_sub FROM users u JOIN worker_profile_ai_extractions x ON x.user_id = u.id
        WHERE x.bedrock_model_id = $1 LIMIT 1`, [MODEL_A]);
    // As the writer's role (jale_whatsapp) with the writer's RLS context
    // (setRlsContext: app.current_user_id = the worker's sub), rolled back.
    const inserted = await withClient(whatsappUrl, async (c) => {
      await c.query('BEGIN');
      try {
        await c.query(`SELECT set_config('app.current_user_id', $1, true)`, [worker.cognito_sub]);
        const out: string[] = [];
        for (const kind of CAUSES) {
          out.push((await c.query(
            `INSERT INTO worker_profile_ai_extractions (user_id, bedrock_model_id, status, failure_kind)
             VALUES ($1, $2, 'failed', $3) RETURNING failure_kind`,
            [worker.id, MODEL_A, kind])).rows[0].failure_kind as string);
        }
        return out;
      } finally {
        await c.query('ROLLBACK');
      }
    });
    expect(inserted).toEqual([...CAUSES]);
    const reject = async (status: string, kind: string): Promise<void> => {
      await expect(withClient(superUrl, async (su) => {
        await su.query('BEGIN');
        try {
          await su.query(
            `INSERT INTO worker_profile_ai_extractions (user_id, bedrock_model_id, status, failure_kind)
             VALUES ($1, $2, $3, $4)`, [worker.id, MODEL_A, status, kind]);
        } finally {
          await su.query('ROLLBACK');
        }
      })).rejects.toThrow(/worker_profile_ai_extractions_failure_kind_check/);
    };
    await reject('completed', 'model_call');
    await reject('pending', 'transcribe');
    await reject('failed', 'timeout');
  });

  it("lets the AI writer record a failed extraction as jale_whatsapp: its media guard links the worker's own voice note and nulls every other id", async () => {
    // The writer's FAILED-branch statement (ai-profile-writer.ts), run as the
    // writer's role under the writer's RLS context. The media id is a
    // sub-select, so a missing, NULL or RLS-hidden id becomes NULL instead of
    // failing the foreign key: the last-resort failed row is always written.
    const failedInsert = `INSERT INTO worker_profile_ai_extractions
           (user_id, voice_message_media_id, bedrock_model_id, status, failure_kind, asr_metadata)
         VALUES ($1, (SELECT m.id FROM worker_profile_media m WHERE m.id = $2), $3, 'failed', $4, $5)
         RETURNING id`;
    // Fail here, not silently, if the writer's statement drifts from this copy.
    const squash = (text: string): string => text.replace(/\s+/g, ' ');
    const writerSource = fs.readFileSync(
      path.join(__dirname, '..', '..', '..', 'lambda', 'whatsapp', 'ai-profile-writer.ts'), 'utf8');
    expect(squash(writerSource)).toContain(squash(failedInsert));

    const workers = { a: { id: '', sub: '', media: '' }, b: { id: '', sub: '', media: '' } };
    await seed(async (c) => {
      for (const w of [workers.a, workers.b]) {
        const u = await user(c, 'worker');
        w.id = u.id;
        w.sub = u.sub;
        w.media = (await c.query(
          `INSERT INTO worker_profile_media (user_id, media_type, s3_key, content_type)
           VALUES ($1, 'voice_message', $2, 'audio/ogg') RETURNING id`,
          [u.id, `${OPERATOR}/${randomBytes(6).toString('hex')}.ogg`],
        )).rows[0].id as string;
      }
    });

    /** One writer turn for worker A, rolled back: the stored media id and failure kind. */
    const writeFailed = async (
      mediaId: string | null, kind: string,
    ): Promise<{ media: string | null; kind: string | null; hidden: boolean }> =>
      withClient(whatsappUrl, async (c) => {
        await c.query('BEGIN');
        try {
          // setWorkerRlsContextByUserId: the worker's cognito_sub, transaction-local.
          const sub = (await c.query(`SELECT cognito_sub FROM users WHERE id = $1 AND user_type = 'worker'`, [workers.a.id]))
            .rows[0]?.cognito_sub as string;
          expect(sub).toBe(workers.a.sub);
          await c.query(`SELECT set_config('app.current_user_id', $1, true)`, [sub]);
          const { id } = (await c.query(failedInsert, [
            workers.a.id, mediaId, 'it-2c.model', kind, JSON.stringify({ provider: 'transcribe' }),
          ])).rows[0] as { id: string };
          const stored = (await c.query(
            'SELECT voice_message_media_id, failure_kind, status FROM worker_profile_ai_extractions WHERE id = $1', [id],
          )).rows[0] as { voice_message_media_id: string | null; failure_kind: string | null; status: string };
          expect(stored.status).toBe('failed');
          // Can the writer's context see the media row it was given?
          const visible = Number((await c.query(
            'SELECT count(*) AS n FROM worker_profile_media WHERE id = $1', [mediaId])).rows[0].n);
          return { media: stored.voice_message_media_id, kind: stored.failure_kind, hidden: visible === 0 };
        } finally {
          await c.query('ROLLBACK');
        }
      });

    // The worker's own media id: linked.
    expect(await writeFailed(workers.a.media, 'model_call')).toEqual({ media: workers.a.media, kind: 'model_call', hidden: false });
    // A well-formed id with no row (a media id left by a rolled-back processor turn): NULL.
    expect(await writeFailed(randomUUID(), 'bad_json')).toEqual({ media: null, kind: 'bad_json', hidden: true });
    // No media id at all: NULL.
    expect(await writeFailed(null, 'transcribe')).toEqual({ media: null, kind: 'transcribe', hidden: true });
    // Another worker's media id: the row exists, but RLS hides it from this
    // worker's context, so the guard yields NULL and nothing is refused.
    expect(Number((await rowsOf(superUrl, 'SELECT count(*) AS n FROM worker_profile_media WHERE id = $1', [workers.b.media]))[0].n)).toBe(1);
    expect(await writeFailed(workers.b.media, 'pipeline_error')).toEqual({ media: null, kind: 'pipeline_error', hidden: true });
    // Every cause the writer can record passes the column's CHECK, through the same statement.
    for (const kind of CAUSES) {
      expect(await writeFailed(workers.a.media, kind)).toEqual({ media: workers.a.media, kind, hidden: false });
    }
    // Every turn was rolled back.
    expect(await rowsOf(superUrl,
      'SELECT id FROM worker_profile_ai_extractions WHERE user_id = ANY($1)', [[workers.a.id, workers.b.id]])).toEqual([]);
  });

  it('returns exactly the columns the console maps', async () => {
    const cols = async (sql: string): Promise<string[]> =>
      withClient(consoleUrl, async (c) => (await c.query(sql)).fields.map((f) => f.name));
    expect(await cols('SELECT * FROM admin_analytics_message_backlog()')).toEqual(['lane', ...BACKLOG, 'oldest_stuck_at']);
    expect(await cols('SELECT * FROM admin_analytics_message_failures(1)')).toEqual(['week_start', 'lane', ...FAILURES]);
    expect(await cols('SELECT * FROM admin_analytics_voice_extraction(1)')).toEqual(['week_start', 'model', ...VOICE]);
    expect(await cols('SELECT * FROM admin_analytics_trust_extraction(1)')).toEqual(['week_start', 'extractor_version', ...TRUST, 'avg_sections']);
    expect(await cols('SELECT * FROM admin_analytics_billing_inbox(1)')).toEqual(['week_start', 'event_type', ...BILLING]);
    expect(await cols('SELECT * FROM admin_analytics_billing_inbox_now()')).toEqual(['stuck_received', 'failed_now', 'unresolved_older', 'oldest_stuck_at']);
  });

  it('rejects out-of-range weeks', async () => {
    for (const fn of ['admin_analytics_message_failures', 'admin_analytics_voice_extraction',
      'admin_analytics_trust_extraction', 'admin_analytics_billing_inbox']) {
      for (const weeks of [0, 27, null]) {
        await expect(withClient(consoleUrl, (c) => c.query(`SELECT * FROM ${fn}($1)`, [weeks])))
          .rejects.toThrow(/admin_analytics_invalid_weeks/);
      }
    }
  });

  it('is callable by the console role only', async () => {
    for (const sql of [
      'SELECT * FROM admin_analytics_message_backlog()',
      'SELECT * FROM admin_analytics_message_failures(4)',
      'SELECT * FROM admin_analytics_voice_extraction(4)',
      'SELECT * FROM admin_analytics_trust_extraction(4)',
      'SELECT * FROM admin_analytics_billing_inbox(4)',
      'SELECT * FROM admin_analytics_billing_inbox_now()',
    ]) {
      await expect(withClient(whatsappUrl, (c) => c.query(sql))).rejects.toThrow(/permission denied/);
    }
  });
});
