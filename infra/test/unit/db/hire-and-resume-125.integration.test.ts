/**
 * hire-and-resume-125.integration.test.ts
 *
 * Migration 125 on a real PostgreSQL 16 bed, through the real logins:
 *
 *   - hire details: the employer's request login (jale_api) writes them only
 *     through jale_cap.employer_save_hire_details, for a hired applicant on
 *     one of its own jobs; it has no column right of its own;
 *   - the "details added" WhatsApp line: jale_cap.employer_hire_details_notice
 *     queues one freeform line inside the worker's 24-hour window and writes
 *     nothing outside it;
 *   - the worker's web message (jale_whatsapp): jale_cap.
 *     worker_post_application_message creates the conversation when there is
 *     none, adds one inbound worker message, moves last_message_at only, and
 *     limits a hired application to 10 web messages an hour. It never touches
 *     last_worker_message_at (the WhatsApp reply window) or
 *     employer_last_read_at;
 *   - the remind stamp: jale_whatsapp may write hire_details_reminded_at and
 *     still not hired_at;
 *   - the nudge sweep (jale_job_digest): jale_cap.claim_hire_details_nudges
 *     claims a hire once, 24 hours after it, while no details exist, and once
 *     more per worker reminder; and the sweep can queue only its own mail;
 *   - billing: 125's mark (jobs.billing_paused_at) on what a billing pause
 *     pauses; a resume brings back only those, oldest first, up to the limit,
 *     never a closed or filled job, with one job_status_events row per job
 *     and a visibility event for a public job; an employer's own status write
 *     clears the mark; the console reads the resumes through its definer.
 *     133 dropped 125's per-person pause/resume pair, so these cases drive
 *     128's company pair (billing_enforce_org_limits / billing_restore_org)
 *     on the employer's one-person company, with no seat for a foreman;
 *     company-limits-128 covers the pair itself.
 *
 * Fixtures and every read that decides an assertion go through the
 * superuser URL; code under test runs on its own login (login-pool.ts).
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { Client, Pool } from 'pg';
import { createCheckedPool } from '../../../lambda/lib/db';
import { listEmployerInbox } from '../../../lambda/lib/employer-inbox';
import { resolveEmployerActor } from '../../../lambda/lib/employer-actor';
import { queueEmail } from '../../../lambda/lib/email-outbox';
import { queueConversationMessageFromEmployer } from '../../../lambda/lib/job-messaging';
import { apiEvent, FIXTURE_TOS_VERSION, parseResponse, World } from './r-paths-world';
import { describeInProfiles, loginClient, loginUrl } from './helpers/login-pool';

const databaseUrl = process.env.JALE_TEST_DATABASE_URL;

let mockPool: Pool | undefined;
jest.mock('../../../lambda/lib/db', () => {
  const actual = jest.requireActual('../../../lambda/lib/db');
  return { ...actual, getDbPool: async () => mockPool };
});

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { handler: jobsUpdateHandler } = require('../../../lambda/api/employer-jobs-update');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { handler: jobsListHandler } = require('../../../lambda/api/employer-jobs-list');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { handler: applicantDispatch } = require('../../../lambda/api/employer-applicant-dispatch');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { handler: detailsDoor } = require('../../../lambda/api/worker-application-details');

if (!databaseUrl) {
  test('CONCERN: the migration 125 DB suite was not run (JALE_TEST_DATABASE_URL unset)', () => {
    expect(databaseUrl).toBeUndefined();
  });
}

const ALL_PROFILES = ['standard', 'request', 'owner-unrestricted'] as const;
const HOUR_MS = 60 * 60 * 1000;

interface Context {
  sub?: string;
  internal?: string;
}

/** Runs `fn` on `login` in one transaction with the caller context set; commits unless it throws. */
async function asLogin<T>(login: string, ctx: Context, fn: (client: Client) => Promise<T>): Promise<T> {
  const client = loginClient(login);
  await client.connect();
  try {
    await client.query('BEGIN');
    if (ctx.sub) await client.query(`SELECT set_config('app.current_user_id', $1, true)`, [ctx.sub]);
    if (ctx.internal) await client.query(`SELECT set_config('app.current_internal_user_id', $1, true)`, [ctx.internal]);
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    await client.end();
  }
}

/** The SQLSTATE `fn` fails with, or null when it succeeds. */
async function sqlState(promise: Promise<unknown>): Promise<string | null> {
  try {
    await promise;
    return null;
  } catch (err) {
    return (err as { code?: string }).code ?? 'unknown';
  }
}

async function one<T = any>(world: World, sql: string, params: unknown[] = []): Promise<T> {
  const { rows } = await world.su.query(sql, params);
  return rows[0] as T;
}

async function all<T = any>(world: World, sql: string, params: unknown[] = []): Promise<T[]> {
  const { rows } = await world.su.query(sql, params);
  return rows as T[];
}

const SAVE_SQL = `SELECT outcome, application_id, changed, start_date, report_location, contact_name,
                         contact_phone, notes, updated_at
                    FROM jale_cap.employer_save_hire_details($1, $2, $3::date, $4, $5, $6, $7)`;
const NOTICE_SQL = 'SELECT outcome, intent_id, outbox_id FROM jale_cap.employer_hire_details_notice($1, $2)';
const MESSAGE_SQL = `SELECT outcome, conversation_id, message_id, sent_at, retry_after_seconds
                       FROM jale_cap.worker_post_application_message($1, $2)`;
const SENT_SQL = 'SELECT message_id, body, sent_at FROM jale_cap.worker_application_sent_messages($1)';
const MARK_SQL = 'SELECT jale_cap.mark_hire_details_nudged($1) AS marked';
const NUDGE_SQL = `SELECT application_id, job_id, employer_id, employer_email, worker_name, job_title, kind, requested_at
                     FROM jale_cap.claim_hire_details_nudges($1)`;
// 128's company pair, called with the employer's company and no foreman seat
// (133 dropped 125's per-person pair); the columns keep 125's names.
const PAUSE_SQL = `SELECT paused_count, owner_email AS employer_email, paused_titles
                     FROM jale_billing_internal.billing_enforce_org_limits($1, $2, 0)`;
const RESUME_SQL = `SELECT resumed_count, owner_email AS employer_email, resumed_titles
                      FROM jale_billing_internal.billing_restore_org($1, $2, 0)`;

describeInProfiles([...ALL_PROFILES], 'migration 125: the catalog', () => {
  let world: World;
  beforeAll(async () => {
    world = new World(databaseUrl!);
    await world.connect();
  });
  afterAll(async () => { await world.end(); });

  it('adds the hire columns, readable by both worker and employer logins, writable by neither request login', async () => {
    const columns = ['hire_start_date', 'hire_report_location', 'hire_contact_name', 'hire_contact_phone',
      'hire_notes', 'hire_details_updated_at', 'hire_details_nudged_at', 'hire_details_reminded_at'];
    for (const column of columns) {
      const row = await one(world, `SELECT has_column_privilege('jale_api', 'public.job_applications', $1, 'SELECT') AS api_read,
                                           has_column_privilege('jale_api', 'public.job_applications', $1, 'UPDATE') AS api_write,
                                           has_column_privilege('jale_whatsapp', 'public.job_applications', $1, 'SELECT') AS wa_read,
                                           has_column_privilege('jale_whatsapp', 'public.job_applications', $1, 'UPDATE') AS wa_write`, [column]);
      expect({ column, ...row }).toEqual({
        column, api_read: true, api_write: false, wa_read: true, wa_write: column === 'hire_details_reminded_at',
      });
    }
    expect(await one(world, `SELECT has_column_privilege('jale_whatsapp', 'public.job_applications', 'hired_at', 'UPDATE') AS v`))
      .toEqual({ v: false });
  });

  it('keeps the enforcer to its exact column grants, the new marker included', async () => {
    const rows = await all<{ grant: string }>(world, `
      SELECT c.relname || ':' || a.attname || ':' || p.privilege AS grant
        FROM pg_catalog.pg_class c
        JOIN pg_catalog.pg_attribute a ON a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped
        CROSS JOIN (VALUES ('SELECT'), ('UPDATE'), ('INSERT')) p(privilege)
       WHERE c.oid IN ('public.jobs'::regclass, 'public.users'::regclass)
         AND has_column_privilege('jale_billing_job_enforcer', c.oid, a.attname, p.privilege)
       ORDER BY 1`);
    expect(rows.map((r) => r.grant)).toEqual([
      'jobs:billing_paused_at:SELECT', 'jobs:billing_paused_at:UPDATE', 'jobs:created_at:SELECT',
      'jobs:employer_id:SELECT', 'jobs:id:SELECT', 'jobs:number_of_workers_needed:SELECT', 'jobs:public_code:SELECT',
      'jobs:public_listing_enabled:SELECT', 'jobs:status:SELECT', 'jobs:status:UPDATE', 'jobs:title:SELECT',
      'jobs:updated_at:UPDATE', 'jobs:workers_hired:SELECT',
      'users:email:SELECT', 'users:id:SELECT', 'users:id:UPDATE', 'users:user_type:SELECT',
    ]);
  });

  it('owns each new function by its owner, as a pinned definer, executable by its one caller', async () => {
    const rows = await all(world, `
      SELECT p.oid::regprocedure::text AS fn, pg_catalog.pg_get_userbyid(p.proowner) AS owner, p.prosecdef,
             p.proconfig,
             ARRAY(SELECT pg_catalog.pg_get_userbyid(a.grantee) FROM aclexplode(p.proacl) a
                    WHERE a.privilege_type = 'EXECUTE' AND a.grantee <> p.proowner ORDER BY 1)::text[] AS callers,
             EXISTS (SELECT 1 FROM aclexplode(COALESCE(p.proacl, acldefault('f', p.proowner))) a
                      WHERE a.grantee = 0 AND a.privilege_type = 'EXECUTE') AS public_execute
        FROM pg_catalog.pg_proc p
       WHERE p.oid = ANY (ARRAY[
         'jale_cap.employer_save_hire_details(uuid, uuid, date, text, text, text, text)'::regprocedure,
         'jale_cap.employer_hire_details_notice(uuid, text)'::regprocedure,
         'jale_cap.worker_post_application_message(uuid, text)'::regprocedure,
         'jale_cap.worker_application_sent_messages(uuid)'::regprocedure,
         'jale_cap.claim_hire_details_nudges(integer)'::regprocedure,
         'jale_cap.mark_hire_details_nudged(uuid)'::regprocedure,
         'public.admin_recent_job_resumes(integer)'::regprocedure])
       ORDER BY 1`);
    const pinned = ['search_path=pg_catalog, pg_temp'];
    expect(rows).toEqual([
      { fn: 'admin_recent_job_resumes(integer)', owner: 'jale_admin', prosecdef: true, proconfig: pinned, callers: ['jale_admin_console'], public_execute: false },
      { fn: 'jale_cap.claim_hire_details_nudges(integer)', owner: 'jale_cap_hire_nudges', prosecdef: true, proconfig: pinned, callers: ['jale_job_digest'], public_execute: false },
      { fn: 'jale_cap.employer_hire_details_notice(uuid,text)', owner: 'jale_cap_worker_lane', prosecdef: true, proconfig: pinned, callers: ['jale_api'], public_execute: false },
      { fn: 'jale_cap.employer_save_hire_details(uuid,uuid,date,text,text,text,text)', owner: 'jale_cap_hire_details', prosecdef: true, proconfig: pinned, callers: ['jale_api'], public_execute: false },
      { fn: 'jale_cap.mark_hire_details_nudged(uuid)', owner: 'jale_cap_hire_nudges', prosecdef: true, proconfig: pinned, callers: ['jale_job_digest'], public_execute: false },
      { fn: 'jale_cap.worker_application_sent_messages(uuid)', owner: 'jale_cap_worker_messages', prosecdef: true, proconfig: pinned, callers: ['jale_whatsapp'], public_execute: false },
      { fn: 'jale_cap.worker_post_application_message(uuid,text)', owner: 'jale_cap_worker_messages', prosecdef: true, proconfig: pinned, callers: ['jale_whatsapp'], public_execute: false },
    ]);
  });

  it('gives the worker-message owner no right on the employer read stamp or the WhatsApp reply window', async () => {
    const row = await one(world, `
      SELECT has_column_privilege('jale_cap_worker_messages', 'public.job_conversations', 'employer_last_read_at', 'UPDATE') AS read_stamp,
             has_column_privilege('jale_cap_worker_messages', 'public.job_conversations', 'last_worker_message_at', 'UPDATE') AS reply_window,
             has_column_privilege('jale_cap_worker_messages', 'public.job_conversations', 'last_message_at', 'UPDATE') AS last_message,
             has_column_privilege('jale_cap_worker_messages', 'public.job_conversations', 'accepted_at', 'UPDATE') AS accepted,
             has_table_privilege('jale_cap_worker_messages', 'public.job_conversation_messages', 'UPDATE') AS message_update,
             has_table_privilege('jale_cap_worker_messages', 'public.job_conversation_messages', 'DELETE') AS message_delete`);
    expect(row).toEqual({
      read_stamp: false, reply_window: false, last_message: true, accepted: false, message_update: false, message_delete: false,
    });
  });

  it('keeps the job event log closed to runtime logins', async () => {
    const row = await one(world, `
      SELECT c.relrowsecurity AS enabled, c.relforcerowsecurity AS forced,
             has_table_privilege('jale_billing', 'public.job_status_events', 'SELECT') AS billing_read,
             has_table_privilege('jale_api', 'public.job_status_events', 'SELECT') AS api_read,
             has_table_privilege('jale_admin_console', 'public.job_status_events', 'SELECT') AS console_read,
             has_table_privilege('jale_billing_job_enforcer', 'public.job_status_events', 'INSERT') AS enforcer_insert
        FROM pg_catalog.pg_class c WHERE c.oid = 'public.job_status_events'::regclass`);
    expect(row).toEqual({
      enabled: true, forced: true, billing_read: false, api_read: false, console_read: false, enforcer_insert: true,
    });
  });
});

describeInProfiles([...ALL_PROFILES], 'migration 125: hire details and the details-added line', () => {
  let world: World;
  let employer: { id: string; sub: string };
  let otherEmployer: { id: string; sub: string };
  let jobId: string;
  let deliveryWas: boolean | null = null;

  async function setDelivery(enabled: boolean): Promise<void> {
    await world.su.query(
      `UPDATE whatsapp_runtime_controls SET enabled = $1 WHERE control_key = 'deferred_delivery_enabled'`, [enabled]);
  }

  beforeEach(async () => {
    world = new World(databaseUrl!);
    await world.connect();
    // The bed starts with deferred delivery off; a ready worker is reachable
    // only with it on, as in production.
    deliveryWas = (await one(world,
      `SELECT enabled FROM whatsapp_runtime_controls WHERE control_key = 'deferred_delivery_enabled'`))?.enabled ?? null;
    await setDelivery(true);
    employer = await world.employer({ companyName: 'Fixture Hire Co' });
    otherEmployer = await world.employer({ companyName: 'Other Fixture Co' });
    jobId = (await world.job(employer.id, { title: 'Fixture Framer', numberOfWorkersNeeded: 5 })).id;
  });
  afterEach(async () => {
    if (deliveryWas !== null) await setDelivery(deliveryWas);
    await world.su.query(`DELETE FROM whatsapp_processed_messages WHERE message_sid LIKE 'fixture-125-%'`);
    await world.cleanup();
    await world.end();
  });

  async function hiredWorker(lifecycle: 'ready' | 'onboarding' = 'ready') {
    const worker = await world.worker({ lifecycle });
    const applicationId = await world.application(jobId, worker.id, 'hired');
    await world.su.query(`UPDATE job_applications SET hired_at = now() WHERE id = $1`, [applicationId]);
    return { ...worker, applicationId };
  }

  async function inbound(phone: string, at: Date) {
    await world.su.query(
      `INSERT INTO whatsapp_processed_messages (message_sid, whatsapp_number, status, first_seen_at)
       VALUES ($1, $2, 'completed', $3)`,
      [`fixture-125-${randomUUID()}`, phone, at],
    );
  }

  const employerCtx = () => ({ sub: employer.sub, internal: employer.id });

  it('saves details for a hired applicant, reports a change once, and keeps them on the row', async () => {
    const worker = await hiredWorker();
    const first = await asLogin('jale_api', employerCtx(), (c) => c.query(SAVE_SQL,
      [jobId, worker.id, '2026-11-02', ' North gate ', 'Fixture Foreman', '+1 (555) 010-0000', 'Bring boots']));
    expect(first.rows[0]).toMatchObject({
      outcome: 'saved', application_id: worker.applicationId, changed: true, start_date: '2026-11-02',
      report_location: 'North gate', contact_name: 'Fixture Foreman', contact_phone: '+1 (555) 010-0000', notes: 'Bring boots',
    });
    expect(first.rows[0].updated_at).toBeInstanceOf(Date);

    const again = await asLogin('jale_api', employerCtx(), (c) => c.query(SAVE_SQL,
      [jobId, worker.id, '2026-11-02', 'North gate', 'Fixture Foreman', '+1 (555) 010-0000', 'Bring boots']));
    expect(again.rows[0]).toMatchObject({ outcome: 'saved', changed: false });
    expect(again.rows[0].updated_at.getTime()).toBe(first.rows[0].updated_at.getTime());

    const stored = await one(world, `SELECT to_char(hire_start_date, 'YYYY-MM-DD') AS start, hire_report_location, hire_notes,
                                            hire_details_updated_at IS NOT NULL AS stamped
                                       FROM job_applications WHERE id = $1`, [worker.applicationId]);
    expect(stored).toEqual({ start: '2026-11-02', hire_report_location: 'North gate', hire_notes: 'Bring boots', stamped: true });
  });

  it('answers not_hired for an applicant who is not hired and not_found for another employer\'s applicant', async () => {
    const worker = await world.worker({ lifecycle: 'ready' });
    await world.application(jobId, worker.id, 'talking');
    const notHired = await asLogin('jale_api', employerCtx(), (c) => c.query(SAVE_SQL,
      [jobId, worker.id, null, 'Gate', null, null, null]));
    expect(notHired.rows[0]).toMatchObject({ outcome: 'not_hired', application_id: null });

    const hired = await hiredWorker();
    const stranger = await asLogin('jale_api', { sub: otherEmployer.sub, internal: otherEmployer.id }, (c) => c.query(SAVE_SQL,
      [jobId, hired.id, null, 'Gate', null, null, null]));
    expect(stranger.rows[0]).toMatchObject({ outcome: 'not_found', application_id: null });
    expect(await one(world, 'SELECT hire_report_location FROM job_applications WHERE id = $1', [hired.applicationId]))
      .toEqual({ hire_report_location: null });
  });

  it('refuses a call with no caller, a direct column write, and a phone outside the allowed characters', async () => {
    const worker = await hiredWorker();
    expect(await sqlState(asLogin('jale_api', {}, (c) => c.query(SAVE_SQL, [jobId, worker.id, null, 'Gate', null, null, null]))))
      .toBe('42501');
    expect(await sqlState(asLogin('jale_api', employerCtx(), (c) => c.query(
      `UPDATE job_applications SET hire_notes = 'x' WHERE id = $1`, [worker.applicationId]))))
      .toBe('42501');
    expect(await sqlState(asLogin('jale_api', employerCtx(), (c) => c.query(SAVE_SQL,
      [jobId, worker.id, null, null, null, 'call me', null]))))
      .toBe('23514');
  });

  it('queues one details-added line inside the worker\'s window, and nothing outside it or before they are ready', async () => {
    const worker = await hiredWorker('ready');
    await asLogin('jale_api', employerCtx(), (c) => c.query(SAVE_SQL, [jobId, worker.id, '2026-11-02', 'Gate', null, null, null]));

    // No inbound message from the worker yet: outside the window.
    const outside = await asLogin('jale_api', employerCtx(), (c) => c.query(NOTICE_SQL, [worker.applicationId, 'Fixture line']));
    expect(outside.rows[0]).toEqual({ outcome: 'outside_window', intent_id: null, outbox_id: null });
    expect(await all(world, 'SELECT 1 FROM worker_message_intents WHERE user_id = $1', [worker.id])).toEqual([]);

    await inbound(worker.phone!, new Date(Date.now() - HOUR_MS));
    const queued = await asLogin('jale_api', employerCtx(), (c) => c.query(NOTICE_SQL, [worker.applicationId, 'Fixture line']));
    expect(queued.rows[0].outcome).toBe('queued');
    const outbox = await all(world, `SELECT o.whatsapp_number, o.body, o.content_template, i.status, i.category, i.source_type
                                       FROM whatsapp_outbox o JOIN worker_message_intents i ON i.outbox_id = o.id
                                      WHERE i.user_id = $1`, [worker.id]);
    expect(outbox).toEqual([{
      whatsapp_number: worker.phone, body: 'Fixture line', content_template: null,
      status: 'eligible', category: 'account', source_type: 'hire_details',
    }]);

    // The same saved details never send twice.
    const repeat = await asLogin('jale_api', employerCtx(), (c) => c.query(NOTICE_SQL, [worker.applicationId, 'Fixture line']));
    expect(repeat.rows[0].outcome).toBe('duplicate');

    const onboarding = await hiredWorker('onboarding');
    await inbound(onboarding.phone!, new Date(Date.now() - HOUR_MS));
    await asLogin('jale_api', employerCtx(), (c) => c.query(SAVE_SQL, [jobId, onboarding.id, null, 'Gate', null, null, null]));
    const notReady = await asLogin('jale_api', employerCtx(), (c) => c.query(NOTICE_SQL, [onboarding.applicationId, 'Fixture line']));
    expect(notReady.rows[0].outcome).toBe('not_ready');

    expect(await sqlState(asLogin('jale_api', { sub: otherEmployer.sub, internal: otherEmployer.id },
      (c) => c.query(NOTICE_SQL, [worker.applicationId, 'Fixture line'])))).toBe('42501');
  });

  it('a window older than 23h45m counts as closed, and a send the bot made itself never opens one', async () => {
    const worker = await hiredWorker('ready');
    await asLogin('jale_api', employerCtx(), (c) => c.query(SAVE_SQL, [jobId, worker.id, null, 'Gate', null, null, null]));
    await inbound(worker.phone!, new Date(Date.now() - 24 * HOUR_MS));
    await world.su.query(
      `INSERT INTO whatsapp_processed_messages (message_sid, whatsapp_number, status, first_seen_at)
       VALUES ($1, $2, 'completed', now())`,
      [`fixture-125-${randomUUID().slice(0, 30)}#err`, worker.phone],
    );
    const result = await asLogin('jale_api', employerCtx(), (c) => c.query(NOTICE_SQL, [worker.applicationId, 'Fixture line']));
    expect(result.rows[0].outcome).toBe('outside_window');
  });

  it('sends nothing while deferred delivery is off', async () => {
    const worker = await hiredWorker('ready');
    await asLogin('jale_api', employerCtx(), (c) => c.query(SAVE_SQL, [jobId, worker.id, null, 'Gate', null, null, null]));
    await inbound(worker.phone!, new Date(Date.now() - HOUR_MS));
    await setDelivery(false);
    const result = await asLogin('jale_api', employerCtx(), (c) => c.query(NOTICE_SQL, [worker.applicationId, 'Fixture line']));
    expect(result.rows[0].outcome).toBe('delivery_disabled');
    expect(await all(world, 'SELECT 1 FROM worker_message_intents WHERE user_id = $1', [worker.id])).toEqual([]);
  });
});

describeInProfiles([...ALL_PROFILES], 'migration 125: the worker\'s web message and reminder', () => {
  let world: World;
  let employer: { id: string; sub: string };
  let jobId: string;
  let apiPool: Pool;

  beforeAll(async () => {
    apiPool = await createCheckedPool({ connectionString: loginUrl('jale_api'), max: 1 }, 'jale_api', 'test');
  });
  afterAll(async () => { await apiPool.end(); });
  beforeEach(async () => {
    world = new World(databaseUrl!);
    await world.connect();
    employer = await world.employer({ companyName: 'Fixture Message Co' });
    jobId = (await world.job(employer.id, { title: 'Fixture Roofer', numberOfWorkersNeeded: 5 })).id;
  });
  afterEach(async () => {
    await world.cleanup();
    await world.end();
  });

  async function worker(status: string) {
    const w = await world.worker({ lifecycle: 'ready' });
    const applicationId = await world.application(jobId, w.id, status);
    return { ...w, applicationId };
  }

  const post = (w: { id: string }, applicationId: string, body: string) =>
    asLogin('jale_whatsapp', { internal: w.id }, (c) => c.query(MESSAGE_SQL, [applicationId, body]));

  it('opens a conversation, adds one inbound worker message, and raises the employer\'s unread badge', async () => {
    const hired = await worker('hired');
    const result = await post(hired, hired.applicationId, '  Hello from the web  ');
    expect(result.rows[0]).toMatchObject({ outcome: 'sent', retry_after_seconds: null });
    const { conversation_id: conversationId, message_id: messageId } = result.rows[0];

    const conversation = await one(world, `SELECT job_id, employer_id, worker_id, application_id, status,
                                                  last_message_at IS NOT NULL AS has_last_message,
                                                  last_worker_message_at, employer_last_read_at, accepted_at,
                                                  worker_thread_number IS NOT NULL AS numbered
                                             FROM job_conversations WHERE id = $1`, [conversationId]);
    expect(conversation).toEqual({
      job_id: jobId, employer_id: employer.id, worker_id: hired.id, application_id: hired.applicationId, status: 'open',
      has_last_message: true, last_worker_message_at: null, employer_last_read_at: null, accepted_at: null, numbered: true,
    });
    expect(await all(world, `SELECT id, sender_type, direction, body, status, twilio_message_sid
                               FROM job_conversation_messages WHERE conversation_id = $1`, [conversationId]))
      .toEqual([{ id: messageId, sender_type: 'worker', direction: 'inbound', body: 'Hello from the web', status: 'received', twilio_message_sid: null }]);

    const client = await apiPool.connect();
    try {
      await client.query('BEGIN');
      await client.query(`SELECT set_config('app.current_user_id', $1, true)`, [employer.sub]);
      await client.query(`SELECT set_config('app.current_internal_user_id', $1, true)`, [employer.id]);
      const inbox = await listEmployerInbox(client, [employer.id]);
      await client.query('ROLLBACK');
      expect(inbox.unread_count).toBe(1);
      expect(inbox.items.find((item) => item.conversation_id === conversationId)?.unread).toBe(true);
    } finally {
      client.release();
    }
  });

  it('reuses the open conversation and leaves the reply window and the read stamp as they were', async () => {
    const hired = await worker('hired');
    const readAt = new Date(Date.now() - 2 * HOUR_MS);
    const replyAt = new Date(Date.now() - 30 * HOUR_MS);
    const conversationId = await world.conversation({
      jobId, employerId: employer.id, workerId: hired.id, applicationId: hired.applicationId, lastWorkerMessageAt: replyAt,
    });
    await world.su.query('UPDATE job_conversations SET employer_last_read_at = $2 WHERE id = $1', [conversationId, readAt]);

    const result = await post(hired, hired.applicationId, 'Second hello');
    expect(result.rows[0]).toMatchObject({ outcome: 'sent', conversation_id: conversationId });
    const after = await one(world, `SELECT last_worker_message_at, employer_last_read_at FROM job_conversations WHERE id = $1`, [conversationId]);
    expect(after.last_worker_message_at.getTime()).toBe(replyAt.getTime());
    expect(after.employer_last_read_at.getTime()).toBe(readAt.getTime());
    expect(await all(world, 'SELECT id FROM job_conversations WHERE application_id = $1', [hired.applicationId])).toHaveLength(1);
  });

  it('refuses an application that is not hired, one that is not the worker\'s, and a blank or long body', async () => {
    const talking = await worker('talking');
    expect((await post(talking, talking.applicationId, 'Hi')).rows[0].outcome).toBe('not_hired');
    const hired = await worker('hired');
    expect((await post(talking, hired.applicationId, 'Hi')).rows[0].outcome).toBe('not_found');
    expect((await post(hired, hired.applicationId, '   ')).rows[0].outcome).toBe('invalid');
    expect((await post(hired, hired.applicationId, 'x'.repeat(2001))).rows[0].outcome).toBe('invalid');
    expect(await all(world, 'SELECT id FROM job_conversations WHERE application_id = ANY($1::uuid[])',
      [[talking.applicationId, hired.applicationId]])).toEqual([]);
  });

  it('allows 10 web messages an hour per application and names when the next one is allowed', async () => {
    const hired = await worker('hired');
    for (let i = 0; i < 10; i += 1) {
      expect((await post(hired, hired.applicationId, `Message ${i}`)).rows[0].outcome).toBe('sent');
    }
    const limited = await post(hired, hired.applicationId, 'One too many');
    expect(limited.rows[0]).toMatchObject({ outcome: 'rate_limited', conversation_id: null, message_id: null });
    expect(limited.rows[0].retry_after_seconds).toBeGreaterThan(3000);
    expect(limited.rows[0].retry_after_seconds).toBeLessThanOrEqual(3600);
    // An hour later the window has moved on.
    await world.su.query(`UPDATE job_conversation_messages SET created_at = created_at - interval '61 minutes'
                           WHERE conversation_id IN (SELECT id FROM job_conversations WHERE application_id = $1)`,
    [hired.applicationId]);
    expect((await post(hired, hired.applicationId, 'An hour later')).rows[0].outcome).toBe('sent');
  });

  it('does not count the worker\'s WhatsApp replies against the web limit', async () => {
    const hired = await worker('hired');
    const conversationId = await world.conversation({
      jobId, employerId: employer.id, workerId: hired.id, applicationId: hired.applicationId,
    });
    for (let i = 0; i < 10; i += 1) {
      await world.su.query(
        `INSERT INTO job_conversation_messages (conversation_id, sender_type, direction, body, status, twilio_message_sid)
         VALUES ($1, 'worker', 'inbound', $2, 'received', $3)`,
        [conversationId, `WhatsApp ${i}`, `fixture-sid-${randomUUID()}`],
      );
    }
    expect((await post(hired, hired.applicationId, 'From the web')).rows[0].outcome).toBe('sent');
  });

  it('reads back only the worker\'s own web-sent messages, latest 20, oldest first', async () => {
    const hired = await worker('hired');
    const other = await worker('hired');
    const sentIds: string[] = [];
    for (const body of ['First', 'Second', 'Third']) {
      sentIds.push((await post(hired, hired.applicationId, body)).rows[0].message_id);
    }
    await post(other, other.applicationId, 'Not yours');
    const conversationId = (await one(world, 'SELECT id FROM job_conversations WHERE application_id = $1',
      [hired.applicationId])).id;
    // An employer message and a WhatsApp reply in the same conversation never show.
    await world.su.query(
      `INSERT INTO job_conversation_messages (conversation_id, sender_type, direction, body, status)
       VALUES ($1, 'employer', 'outbound', 'Employer says hi', 'sent')`, [conversationId]);
    await world.su.query(
      `INSERT INTO job_conversation_messages (conversation_id, sender_type, direction, body, status, twilio_message_sid)
       VALUES ($1, 'worker', 'inbound', 'Sent on WhatsApp', 'received', $2)`, [conversationId, `fixture-sid-${randomUUID()}`]);
    await world.su.query(`UPDATE job_conversation_messages SET created_at = now() - make_interval(secs => 10 - position)
                            FROM (SELECT unnest($1::uuid[]) AS mid, generate_series(1, 3) AS position) o
                           WHERE id = o.mid`, [sentIds]);

    const sent = await asLogin('jale_whatsapp', { internal: hired.id }, (c) => c.query(SENT_SQL, [hired.applicationId]));
    expect(sent.fields.map((f) => f.name)).toEqual(['message_id', 'body', 'sent_at']);
    expect(sent.rows.map((row) => [row.message_id, row.body])).toEqual([
      [sentIds[0], 'First'], [sentIds[1], 'Second'], [sentIds[2], 'Third'],
    ]);
    // Another worker's application answers nothing, whoever asks.
    expect((await asLogin('jale_whatsapp', { internal: hired.id }, (c) => c.query(SENT_SQL, [other.applicationId]))).rows)
      .toEqual([]);
    expect((await asLogin('jale_whatsapp', { internal: other.id }, (c) => c.query(SENT_SQL, [hired.applicationId]))).rows)
      .toEqual([]);
    expect(await sqlState(asLogin('jale_whatsapp', {}, (c) => c.query(SENT_SQL, [hired.applicationId])))).toBe('42501');
    expect(await sqlState(asLogin('jale_api', { internal: hired.id }, (c) => c.query(SENT_SQL, [hired.applicationId]))))
      .toBe('42501');

    // At most the latest 20.
    for (let i = 0; i < 20; i += 1) {
      await world.su.query(
        `INSERT INTO job_conversation_messages (conversation_id, sender_type, direction, body, status, created_at)
         VALUES ($1, 'worker', 'inbound', $2, 'received', now() + make_interval(secs => $3))`,
        [conversationId, `Later ${i}`, i + 1]);
    }
    const latest = await asLogin('jale_whatsapp', { internal: hired.id }, (c) => c.query(SENT_SQL, [hired.applicationId]));
    expect(latest.rows.map((row) => row.body)).toEqual(Array.from({ length: 20 }, (_, i) => `Later ${i}`));
  });

  it('lets the worker login stamp a reminder on its own hired application and nothing on another worker\'s', async () => {
    const hired = await worker('hired');
    const other = await worker('hired');
    const own = await asLogin('jale_whatsapp', { internal: hired.id }, (c) => c.query(
      `UPDATE job_applications SET hire_details_reminded_at = now() WHERE id = $1 RETURNING id`, [hired.applicationId]));
    expect(own.rowCount).toBe(1);
    const foreign = await asLogin('jale_whatsapp', { internal: hired.id }, (c) => c.query(
      `UPDATE job_applications SET hire_details_reminded_at = now() WHERE id = $1 RETURNING id`, [other.applicationId]));
    expect(foreign.rowCount).toBe(0);
    expect(await sqlState(asLogin('jale_whatsapp', { internal: hired.id }, (c) => c.query(
      `UPDATE job_applications SET hire_notes = 'x' WHERE id = $1`, [hired.applicationId])))).toBe('42501');
  });
});

describeInProfiles([...ALL_PROFILES], 'migration 125: the nudge sweep', () => {
  let world: World;
  let employer: { id: string; sub: string };
  let jobId: string;
  const queued: string[] = [];

  beforeEach(async () => {
    world = new World(databaseUrl!);
    await world.connect();
    employer = await world.employer({ companyName: 'Fixture Nudge Co' });
    jobId = (await world.job(employer.id, { title: 'Fixture Glazier', numberOfWorkersNeeded: 9 })).id;
  });
  afterEach(async () => {
    await world.su.query('DELETE FROM email_outbox WHERE idempotency_key = ANY($1::text[])', [queued]);
    queued.length = 0;
    await world.cleanup();
    await world.end();
  });

  async function hire(hoursAgo: number, fullName = 'Fixture Ana Worker') {
    const w = await world.worker({ fullName });
    const applicationId = await world.application(jobId, w.id, 'hired');
    await world.su.query(`UPDATE job_applications SET hired_at = now() - make_interval(hours => $2) WHERE id = $1`,
      [applicationId, hoursAgo]);
    return { ...w, applicationId };
  }

  /**
   * One sweep, as the producer runs it: claim, then stamp each claimed row,
   * in one transaction. `stamp` false leaves the rows unstamped, as a row
   * whose email failed (or a cut-off sweep) does. The sweep's own rows only:
   * other suites may leave hires on the bed.
   */
  async function claim(stamp = true): Promise<any[]> {
    return asLogin('jale_job_digest', {}, async (c) => {
      const rows = (await c.query(NUDGE_SQL, [200])).rows.filter((row) => row.job_id === jobId);
      if (stamp) for (const row of rows) await c.query(MARK_SQL, [row.application_id]);
      return rows;
    });
  }

  it('claims a hire once, 24 hours after it, while no details exist', async () => {
    const fresh = await hire(2);
    const due = await hire(25);
    const claimed = await claim();
    expect(claimed).toEqual([{
      application_id: due.applicationId, job_id: jobId, employer_id: employer.id,
      employer_email: `${employer.id}@fixture.invalid`, worker_name: 'Fixture Ana Worker', job_title: 'Fixture Glazier', kind: 'auto',
      requested_at: null,
    }]);
    expect(await claim()).toEqual([]);
    expect((await one(world, 'SELECT hire_details_nudged_at FROM job_applications WHERE id = $1', [fresh.applicationId]))
      .hire_details_nudged_at).toBeNull();
  });

  it('claims once more for each reminder, and never once details exist or for an old hire', async () => {
    const recent = await hire(2);
    await world.su.query('UPDATE job_applications SET hire_details_reminded_at = now() WHERE id = $1', [recent.applicationId]);
    const reminded = await one(world, 'SELECT hire_details_reminded_at FROM job_applications WHERE id = $1', [recent.applicationId]);
    expect((await claim()).map((row) => [row.application_id, row.kind, row.requested_at]))
      .toEqual([[recent.applicationId, 'remind', reminded.hire_details_reminded_at]]);
    expect(await claim()).toEqual([]);

    const withDetails = await hire(30);
    await world.su.query(`UPDATE job_applications SET hire_report_location = 'Gate', hire_details_updated_at = now(),
                                 hire_details_reminded_at = now() WHERE id = $1`, [withDetails.applicationId]);
    const old = await hire(24 * 8);
    expect(await claim()).toEqual([]);
    expect((await one(world, 'SELECT hire_details_nudged_at FROM job_applications WHERE id = $1', [old.applicationId]))
      .hire_details_nudged_at).toBeNull();
  });

  it('stamps nothing at claim time: a claimed row that was not stamped is due again (at least once)', async () => {
    const due = await hire(25);
    expect((await claim(false)).map((row) => row.application_id)).toEqual([due.applicationId]);
    expect((await one(world, 'SELECT hire_details_nudged_at FROM job_applications WHERE id = $1', [due.applicationId]))
      .hire_details_nudged_at).toBeNull();
    expect((await claim()).map((row) => row.application_id)).toEqual([due.applicationId]);
    expect(await claim()).toEqual([]);
  });

  it('locks what it claims, so a second sweep in flight skips those rows', async () => {
    const due = await hire(25);
    const holder = loginClient('jale_job_digest');
    await holder.connect();
    try {
      await holder.query('BEGIN');
      const held = (await holder.query(NUDGE_SQL, [200])).rows.filter((row) => row.job_id === jobId);
      expect(held.map((row) => row.application_id)).toEqual([due.applicationId]);
      expect(await claim(false)).toEqual([]);
    } finally {
      await holder.query('ROLLBACK').catch(() => undefined);
      await holder.end();
    }
  });

  it('stamps only a hired application, and refuses a call without an id', async () => {
    const talking = await world.worker();
    const applicationId = await world.application(jobId, talking.id, 'talking');
    const result = await asLogin('jale_job_digest', {}, (c) => c.query(MARK_SQL, [applicationId]));
    expect(result.rows[0].marked).toBe(false);
    expect(await sqlState(asLogin('jale_job_digest', {}, (c) => c.query(MARK_SQL, [null])))).toBe('22023');
    expect(await sqlState(asLogin('jale_api', {}, (c) => c.query(MARK_SQL, [applicationId])))).toBe('42501');
  });

  it('the apply-time backfill stamps hires older than a day, leaves newer ones, and keeps updated_at', async () => {
    // Section 1b of 125, run again on fresh rows, the statement exactly as the
    // migration has it (between its markers).
    const migration = fs.readFileSync(path.join(__dirname, '..', '..', '..', 'db', 'migrations',
      '125_hire_details_and_billing_resume.sql'), 'utf8');
    const backfill = migration.slice(
      migration.indexOf('-- BEGIN hire-details nudge backfill'),
      migration.indexOf('-- END hire-details nudge backfill'),
    );
    expect(backfill).toContain('UPDATE public.job_applications');
    const old = await hire(48);
    const recent = await hire(2);
    const before = await one(world, 'SELECT updated_at FROM job_applications WHERE id = $1', [old.applicationId]);

    await world.su.query('BEGIN');
    try {
      await world.su.query(backfill);
      await world.su.query('COMMIT');
    } catch (err) {
      await world.su.query('ROLLBACK');
      throw err;
    }

    const after = await all(world, `SELECT id, hire_details_nudged_at IS NOT NULL AS stamped, updated_at
                                      FROM job_applications WHERE id = ANY($1::uuid[])`,
    [[old.applicationId, recent.applicationId]]);
    const byId = new Map(after.map((row) => [row.id, row]));
    expect(byId.get(old.applicationId)!.stamped).toBe(true);
    expect(byId.get(recent.applicationId)!.stamped).toBe(false);
    expect(byId.get(old.applicationId)!.updated_at.getTime()).toBe(before.updated_at.getTime());
    expect(await one(world, `SELECT tgenabled FROM pg_trigger
                               WHERE tgrelid = 'public.job_applications'::regclass AND tgname = 'job_applications_updated_at'`))
      .toEqual({ tgenabled: 'O' });

    // The first sweep mails no backlog, and a later reminder still reaches the old hire.
    expect(await claim()).toEqual([]);
    await world.su.query('UPDATE job_applications SET hire_details_reminded_at = now() WHERE id = $1', [old.applicationId]);
    expect((await claim()).map((row) => [row.application_id, row.kind])).toEqual([[old.applicationId, 'remind']]);
  });

  it('lets the sweep queue and read back its own mail, and no other kind', async () => {
    const key = `hire-details-nudge:${randomUUID()}`;
    queued.push(key);
    const client = loginClient('jale_job_digest');
    await client.connect();
    try {
      await client.query('BEGIN');
      const input = {
        recipientEmail: 'fixture-employer@fixture.invalid', subject: 'Fixture', bodyText: 'Fixture body',
        sourceType: 'hire_details_nudge', sourceId: randomUUID(), idempotencyKey: key,
      };
      const first = await queueEmail(client as any, input);
      // The idempotent re-read: the same message under the same key is the same row.
      expect(await queueEmail(client as any, input)).toBe(first);
      await client.query('COMMIT');
      await client.query('BEGIN');
      expect(await sqlState(client.query(
        `INSERT INTO email_outbox (recipient_email, subject, body_text, source_type, source_id)
         VALUES ('fixture@fixture.invalid', 'x', 'x', 'billing_pause', $1)`, [randomUUID()]))).toBe('42501');
    } finally {
      await client.query('ROLLBACK').catch(() => undefined);
      await client.end();
    }
  });
});

describeInProfiles([...ALL_PROFILES], 'migration 125: billing pause and resume', () => {
  let world: World;
  let employer: { id: string; sub: string };
  // The employer's one-person company: 128's pair takes the company (133).
  let org: string;
  const jobs: Record<string, string> = {};
  const publicCodes: Record<string, string> = {};
  const queued: string[] = [];

  beforeAll(async () => {
    process.env.REQUIRED_TOS_VERSION = FIXTURE_TOS_VERSION;
    mockPool = await createCheckedPool({ connectionString: loginUrl('jale_api'), max: 1 }, 'jale_api', 'test');
  });
  afterAll(async () => {
    await mockPool?.end();
    mockPool = undefined;
  });
  beforeEach(async () => {
    world = new World(databaseUrl!);
    await world.connect();
    employer = await world.employer({ companyName: 'Fixture Billing Co' });
    org = (await one<{ organization_id: string }>(world,
      `SELECT organization_id FROM organization_members WHERE user_id = $1 AND role = 'owner'`, [employer.id])).organization_id;
    const spec: Array<[string, 'active' | 'paused' | 'filled' | 'closed', number, boolean]> = [
      ['oldest', 'active', 1, false],
      ['second', 'active', 2, true],
      ['third', 'active', 3, false],
      ['handPaused', 'paused', 4, false],
      ['filled', 'filled', 5, false],
      ['closed', 'closed', 6, false],
    ];
    for (const [name, status, day, isPublic] of spec) {
      const job = await world.job(employer.id, { title: `Fixture ${name}`, status, publicListing: isPublic });
      jobs[name] = job.id;
      publicCodes[name] = job.publicCode;
      await world.su.query(`UPDATE jobs SET created_at = make_date(2026, 1, $2) WHERE id = $1`, [job.id, day]);
    }
  });
  afterEach(async () => {
    await world.su.query('DELETE FROM email_outbox WHERE idempotency_key = ANY($1::text[])', [queued]);
    queued.length = 0;
    await world.cleanup();
    await world.end();
  });

  async function statuses(): Promise<Record<string, [string, boolean]>> {
    const rows = await all<{ id: string; status: string; marked: boolean }>(world,
      'SELECT id, status, billing_paused_at IS NOT NULL AS marked FROM jobs WHERE employer_id = $1', [employer.id]);
    const byId = new Map(rows.map((row) => [row.id, [row.status, row.marked] as [string, boolean]]));
    return Object.fromEntries(Object.entries(jobs).map(([name, id]) => [name, byId.get(id)!]));
  }

  const billing = <T>(fn: (c: Client) => Promise<T>) => asLogin('jale_billing', {}, fn);

  it('marks what the pause pauses, and resumes only those, oldest first, up to the limit', async () => {
    const paused = await billing((c) => c.query(PAUSE_SQL, [org, 1]));
    expect(paused.rows[0]).toMatchObject({ paused_count: 2, paused_titles: ['Fixture second', 'Fixture third'] });
    expect(await statuses()).toEqual({
      oldest: ['active', false], second: ['paused', true], third: ['paused', true],
      handPaused: ['paused', false], filled: ['filled', false], closed: ['closed', false],
    });

    const first = await billing((c) => c.query(RESUME_SQL, [org, 2]));
    expect(first.rows[0]).toEqual({ resumed_count: 1, employer_email: `${employer.id}@fixture.invalid`, resumed_titles: ['Fixture second'] });
    expect((await statuses()).second).toEqual(['active', false]);
    expect((await statuses()).third).toEqual(['paused', true]);

    // No slot left: nothing moves, and repeating is a no-op.
    expect((await billing((c) => c.query(RESUME_SQL, [org, 2]))).rows[0]).toMatchObject({ resumed_count: 0, resumed_titles: [] });

    const rest = await billing((c) => c.query(RESUME_SQL, [org, 10]));
    expect(rest.rows[0]).toMatchObject({ resumed_count: 1, resumed_titles: ['Fixture third'] });
    expect(await statuses()).toEqual({
      oldest: ['active', false], second: ['active', false], third: ['active', false],
      handPaused: ['paused', false], filled: ['filled', false], closed: ['closed', false],
    });

    // 128's pause records each job it pauses too (125's did not): one row per paused job.
    const pauses = await all(world, `SELECT job_id, employer_id, from_status, to_status, actor FROM job_status_events
                                      WHERE employer_id = $1 AND from_status = 'active' AND to_status = 'paused'
                                      ORDER BY job_id`, [employer.id]);
    expect(pauses).toEqual([
      { job_id: jobs.second, employer_id: employer.id, from_status: 'active', to_status: 'paused', actor: 'billing' },
      { job_id: jobs.third, employer_id: employer.id, from_status: 'active', to_status: 'paused', actor: 'billing' },
    ].sort((a, b) => (a.job_id < b.job_id ? -1 : 1)));
    // The resumes, in the order they happened (two transactions).
    const resumes = await all(world, `SELECT job_id, employer_id, from_status, to_status, actor FROM job_status_events
                                       WHERE employer_id = $1 AND from_status = 'paused' AND to_status = 'active'
                                       ORDER BY changed_at, job_id`, [employer.id]);
    expect(resumes).toEqual([
      { job_id: jobs.second, employer_id: employer.id, from_status: 'paused', to_status: 'active', actor: 'billing' },
      { job_id: jobs.third, employer_id: employer.id, from_status: 'paused', to_status: 'active', actor: 'billing' },
    ]);
    expect(await one(world, 'SELECT count(*)::int AS n FROM job_status_events WHERE employer_id = $1', [employer.id]))
      .toEqual({ n: 4 });
    // Only the public job is announced to the visibility drain: removed on the pause, published on the resume.
    expect(await all(world, `SELECT job_id, public_code, event_kind FROM job_visibility_events
                              WHERE job_id = ANY($1::uuid[]) ORDER BY created_at`, [[jobs.second, jobs.third]]))
      .toEqual([
        { job_id: jobs.second, public_code: publicCodes.second, event_kind: 'removed' },
        { job_id: jobs.second, public_code: publicCodes.second, event_kind: 'published' },
      ]);
  });

  it('never resumes a closed or filled job, even one still carrying the mark', async () => {
    await billing((c) => c.query(PAUSE_SQL, [org, 1]));
    await world.su.query(`UPDATE jobs SET status = 'closed' WHERE id = $1`, [jobs.second]);
    await world.su.query(`UPDATE jobs SET billing_paused_at = now() WHERE id = $1`, [jobs.filled]);
    const result = await billing((c) => c.query(RESUME_SQL, [org, 10]));
    expect(result.rows[0]).toMatchObject({ resumed_count: 1, resumed_titles: ['Fixture third'] });
    const after = await statuses();
    expect(after.second[0]).toBe('closed');
    expect(after.filled[0]).toBe('filled');
  });

  it('an employer\'s own status write clears the mark, so a later resume leaves that job alone', async () => {
    await billing((c) => c.query(PAUSE_SQL, [org, 1]));
    const response = parseResponse(await jobsUpdateHandler(apiEvent({
      sub: employer.sub,
      httpMethod: 'PATCH',
      resource: '/employer/jobs/{jobId}',
      pathParameters: { jobId: jobs.third },
      body: { status: 'paused' },
    })));
    expect(response.statusCode).toBe(200);
    expect((await statuses()).third).toEqual(['paused', false]);

    const result = await billing((c) => c.query(RESUME_SQL, [org, 10]));
    expect(result.rows[0]).toMatchObject({ resumed_count: 1, resumed_titles: ['Fixture second'] });
    expect((await statuses()).third).toEqual(['paused', false]);
  });

  it('shows the console the resumes through its definer only: ids and times, newest first, limit clamped', async () => {
    await billing((c) => c.query(PAUSE_SQL, [org, 1]));
    await billing((c) => c.query(RESUME_SQL, [org, 2]));
    await billing((c) => c.query(RESUME_SQL, [org, 10]));
    const ours = new Set([jobs.second, jobs.third]);
    const console = <T>(fn: (c: Client) => Promise<T>) => asLogin('jale_admin_console', {}, fn);

    const result = await console(async (c) => {
      const res = await c.query('SELECT * FROM public.admin_recent_job_resumes(50)');
      const flag = await c.query(`SELECT current_setting('app.admin_analytics_read', true) AS v`);
      return { res, flag: flag.rows[0].v };
    });
    expect(result.res.fields.map((f) => f.name)).toEqual(['event_id', 'job_id', 'changed_at']);
    const mine = result.res.rows.filter((row) => ours.has(row.job_id));
    expect(mine.map((row) => row.job_id)).toEqual([jobs.third, jobs.second]);
    for (let i = 1; i < result.res.rows.length; i += 1) {
      expect(result.res.rows[i - 1].changed_at.getTime()).toBeGreaterThanOrEqual(result.res.rows[i].changed_at.getTime());
    }
    // The definer closes the read flag behind its one query.
    expect(result.flag === '' || result.flag === null).toBe(true);

    for (const [limit, most] of [[0, 1], [-5, 1], [1000, 50], [null, 8]] as const) {
      const rows = await console((c) => c.query('SELECT * FROM public.admin_recent_job_resumes($1)', [limit]));
      expect(rows.rows.length).toBeLessThanOrEqual(most);
      expect(rows.rows.length).toBeGreaterThanOrEqual(1);
    }
    expect((await console((c) => c.query('SELECT * FROM public.admin_recent_job_resumes()'))).rows.length)
      .toBeLessThanOrEqual(8);

    expect(await sqlState(console((c) => c.query('SELECT 1 FROM job_status_events LIMIT 1')))).toBe('42501');
    expect(await sqlState(asLogin('jale_api', {}, (c) => c.query('SELECT * FROM public.admin_recent_job_resumes(1)'))))
      .toBe('42501');
  });

  it('brings a job whose hires already fill it back filled, never active, and neither announces nor mails it', async () => {
    const full = await world.job(employer.id, { title: 'Fixture full', status: 'paused', numberOfWorkersNeeded: 1, publicListing: true });
    const w = await world.worker();
    await world.application(full.id, w.id, 'hired');
    await world.su.query('UPDATE jobs SET billing_paused_at = now() WHERE id = $1', [full.id]);
    expect(await one(world, 'SELECT status, workers_hired FROM jobs WHERE id = $1', [full.id]))
      .toEqual({ status: 'paused', workers_hired: 1 });

    const result = await billing((c) => c.query(RESUME_SQL, [org, 1]));

    expect(result.rows[0].resumed_titles).not.toContain('Fixture full');
    expect(await one(world, 'SELECT status, billing_paused_at IS NULL AS cleared FROM jobs WHERE id = $1', [full.id]))
      .toEqual({ status: 'filled', cleared: true });
    expect(await all(world, 'SELECT from_status, to_status, actor FROM job_status_events WHERE job_id = $1', [full.id]))
      .toEqual([{ from_status: 'paused', to_status: 'filled', actor: 'billing' }]);
    expect(await all(world, 'SELECT id FROM job_visibility_events WHERE job_id = $1', [full.id])).toEqual([]);
  });

  it('refuses a negative limit, keeps the event log closed to the billing login, and lets it queue only billing mail', async () => {
    expect(await sqlState(billing((c) => c.query(RESUME_SQL, [org, -1])))).toBe('22023');
    expect(await sqlState(billing((c) => c.query(RESUME_SQL, [randomUUID(), 1])))).toBe('P0002');
    expect(await sqlState(billing((c) => c.query('SELECT 1 FROM job_status_events LIMIT 1')))).toBe('42501');

    const key = `billing-resume:${randomUUID()}`;
    queued.push(key);
    const input = {
      recipientEmail: 'fixture-employer@fixture.invalid', subject: 'Fixture', bodyText: 'Fixture body',
      sourceType: 'billing_resume', sourceId: randomUUID(), idempotencyKey: key,
    };
    const id = await billing((c) => queueEmail(c as any, input));
    expect(await billing((c) => queueEmail(c as any, input))).toBe(id);
    expect(await sqlState(billing((c) => c.query(
      `INSERT INTO email_outbox (recipient_email, subject, body_text, source_type, source_id)
       VALUES ('fixture@fixture.invalid', 'x', 'x', 'hire_details_nudge', $1)`, [randomUUID()])))).toBe('42501');
  });
});

describeInProfiles([...ALL_PROFILES], 'migration 125: the F19 handlers on real rows', () => {
  let world: World;
  let employer: { id: string; sub: string };
  let jobId: string;
  const pools: Record<string, Pool> = {};

  beforeAll(async () => {
    process.env.REQUIRED_TOS_VERSION = FIXTURE_TOS_VERSION;
    for (const login of ['jale_api', 'jale_whatsapp']) {
      pools[login] = await createCheckedPool({ connectionString: loginUrl(login), max: 1 }, login, 'test');
    }
  });
  afterAll(async () => {
    for (const pool of Object.values(pools)) await pool.end();
    mockPool = undefined;
  });
  beforeEach(async () => {
    world = new World(databaseUrl!);
    await world.connect();
    employer = await world.employer({ companyName: 'Fixture Handler Co' });
    jobId = (await world.job(employer.id, { title: 'Fixture Mason', numberOfWorkersNeeded: 9 })).id;
  });
  afterEach(async () => {
    await world.cleanup();
    await world.end();
  });

  async function as(login: 'jale_api' | 'jale_whatsapp', run: () => Promise<any>) {
    mockPool = pools[login];
    return parseResponse(await run());
  }

  const putDetails = (workerId: string, body: unknown, sub = employer.sub) => as('jale_api', () => applicantDispatch(apiEvent({
    sub,
    httpMethod: 'PUT',
    resource: '/employer/jobs/{jobId}/applicants/{workerId}/{action}',
    pathParameters: { jobId, workerId, action: 'hire-details' },
    body,
  })));
  const workerPost = (w: { sub: string }, applicationId: string, action: string, body?: unknown) => as('jale_whatsapp', () => detailsDoor(apiEvent({
    sub: w.sub,
    httpMethod: 'POST',
    resource: '/worker/applications/{applicationId}/{action}',
    pathParameters: { applicationId, action },
    body,
  })));
  const workerState = (w: { sub: string }, applicationId: string) => as('jale_whatsapp', () => detailsDoor(apiEvent({
    sub: w.sub,
    httpMethod: 'GET',
    resource: '/worker/applications/{applicationId}',
    pathParameters: { applicationId },
  })));

  it('counts, per job, the hires with no start details on the employer\'s job list (K4 CCR-3)', async () => {
    const otherJob = (await world.job(employer.id, { title: 'Fixture Idle' })).id;
    // Three hires, one of them with details, and one applicant still talking.
    const applications: string[] = [];
    for (const status of ['hired', 'hired', 'hired', 'talking']) {
      const w = await world.worker();
      applications.push(await world.application(jobId, w.id, status));
    }
    await world.su.query(`UPDATE job_applications SET hire_notes = 'Bring boots', hire_details_updated_at = now() WHERE id = $1`,
      [applications[0]]);
    const response = await as('jale_api', () => jobsListHandler(apiEvent({ sub: employer.sub, resource: '/employer/jobs' })));
    expect(response.statusCode).toBe(200);
    const byId = new Map(response.body.jobs.map((job: any) => [job.id, job.hire_details_needed_count]));
    expect(byId.get(jobId)).toBe(2);
    expect(byId.get(otherJob)).toBe(0);
  });

  it('saves hire details end to end and answers 409 and 404 as the contract says (K4.2)', async () => {
    const hired = await world.worker({ lifecycle: 'ready' });
    const hiredApp = await world.application(jobId, hired.id, 'hired');
    const talking = await world.worker();
    await world.application(jobId, talking.id, 'talking');

    const saved = await putDetails(hired.id, {
      start_date: '2026-11-02', report_location: ' North gate ', contact_name: null, contact_phone: '+1 (555) 010-0000', notes: '',
    });
    expect(saved.statusCode).toBe(200);
    expect(saved.body.hire_details).toMatchObject({
      start_date: '2026-11-02', report_location: 'North gate', contact_name: null, contact_phone: '+1 (555) 010-0000', notes: null,
    });
    expect(await one(world, `SELECT to_char(hire_start_date, 'YYYY-MM-DD') AS d, hire_report_location AS l FROM job_applications WHERE id = $1`,
      [hiredApp])).toEqual({ d: '2026-11-02', l: 'North gate' });

    // A save that leaves every field empty answers null, as every read does (F4).
    const cleared = await putDetails(hired.id, {
      start_date: null, report_location: '  ', contact_name: null, contact_phone: null, notes: null,
    });
    expect(cleared.statusCode).toBe(200);
    expect(cleared.body).toEqual({ hire_details: null });

    expect((await putDetails(talking.id, { notes: 'x' })).statusCode).toBe(409);
    const stranger = await world.employer({ companyName: 'Stranger Co' });
    expect((await putDetails(hired.id, { notes: 'x' }, stranger.sub)).statusCode).toBe(404);
    expect((await putDetails(hired.id, { contact_phone: 'call me' })).body).toEqual({ error: 'invalid_hire_details', fields: ['contact_phone'] });
  });

  it('announces an employer reply that follows a web message, with a fresh template, and never opens the free-form window', async () => {
    const hired = await world.worker({ lifecycle: 'ready', whatsappLanguage: 'en', workflowLanguage: 'en' });
    const applicationId = await world.application(jobId, hired.id, 'hired');
    const reply = (conversationId: string, body: string) => asLogin('jale_api', { sub: employer.sub, internal: employer.id },
      async (c) => {
        // The caller as every employer route resolves it (Milestone B).
        const resolved = await resolveEmployerActor(c as any, employer.sub);
        if (!resolved.ok) throw new Error(`fixture employer did not resolve: ${resolved.error}`);
        return queueConversationMessageFromEmployer(c as any, conversationId, resolved.actor, body);
      });
    const templates = async (conversationId: string) => (await all(world, `SELECT send_kind, content_template
        FROM job_message_outbox WHERE conversation_id = $1 ORDER BY created_at, id`, [conversationId]));

    const first = await workerPost(hired, applicationId, 'message', { body: 'First web message' });
    expect(first.statusCode).toBe(201);
    const conversationId = first.body.conversation_id;
    expect((await reply(conversationId, 'First reply')).queuedAsTemplate).toBe(true);
    expect(await templates(conversationId)).toEqual([{ send_kind: 'template', content_template: 'employer_message_resume_en' }]);

    // Nothing new from the worker: the un-actioned template still stands.
    await reply(conversationId, 'Second reply');
    expect(await templates(conversationId)).toHaveLength(1);

    // A second web message is the worker's newest action: the next reply is announced again.
    expect((await workerPost(hired, applicationId, 'message', { body: 'Second web message' })).statusCode).toBe(201);
    await reply(conversationId, 'Third reply');
    expect((await templates(conversationId)).map((row) => row.send_kind)).toEqual(['template', 'template']);

    // D2 holds: the web messages opened no WhatsApp window.
    expect(await one(world, 'SELECT last_worker_message_at FROM job_conversations WHERE id = $1', [conversationId]))
      .toEqual({ last_worker_message_at: null });
    expect((await all(world, `SELECT DISTINCT status FROM job_conversation_messages
                                WHERE conversation_id = $1 AND sender_type = 'employer'`, [conversationId])))
      .toEqual([{ status: 'waiting_worker_reply' }]);
  });

  it('runs the worker\'s message, reminder and state through the details door (K4.3, K4.4, CCR-4, CCR-5)', async () => {
    const hired = await world.worker({ lifecycle: 'ready' });
    const applicationId = await world.application(jobId, hired.id, 'hired');
    const other = await world.worker({ lifecycle: 'ready' });
    const otherApp = await world.application(jobId, other.id, 'hired');

    const sent = await workerPost(hired, applicationId, 'message', { body: 'On my way' });
    expect(sent.statusCode).toBe(201);
    expect(Object.keys(sent.body).sort()).toEqual(['conversation_id', 'message_id', 'sent_at']);
    expect((await workerPost(other, otherApp, 'message', { body: 'Not yours' })).statusCode).toBe(201);
    expect((await workerPost(other, applicationId, 'message', { body: 'Hijack' })).statusCode).toBe(404);

    const reminded = await workerPost(hired, applicationId, 'remind-employer');
    expect(reminded.statusCode).toBe(202);
    const again = await workerPost(hired, applicationId, 'remind-employer');
    expect(again.statusCode).toBe(429);
    expect(again.body.error).toBe('rate_limited');
    expect(again.body.retry_after_seconds).toBeGreaterThan(86000);
    expect(again.body.retry_after_seconds).toBeLessThanOrEqual(86400);

    const state = await workerState(hired, applicationId);
    expect(state.statusCode).toBe(200);
    expect(state.body.hire).toMatchObject({ details: null });
    expect(typeof state.body.hire.employer_reminded_at).toBe('string');
    expect(state.body.sent_messages.map((m: any) => [m.message_id, m.body]))
      .toEqual([[sent.body.message_id, 'On my way']]);
  });
});
