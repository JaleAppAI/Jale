/**
 * r-paths-stage-notify.integration.test.ts
 *
 * PATCH /employer/jobs/{jobId}/applicants/{workerId}
 * (employer-application-status-update.ts) for the two stages the worker hears
 * about off-app, details_requested and hired, driven end to end on the
 * request login, jale_api, against seeded data. The worker's language and
 * number come from jale_cap.employer_stage_recipient and the intent, the
 * delivery decision and the WhatsApp outbox row from
 * jale_cap.employer_claim_worker_intent. These cases pin today's behaviour on
 * that path:
 *
 *   - a notifying PATCH succeeds and queues the template in the worker's
 *     language (English for an English worker, never a silent Spanish
 *     fallback; Spanish when the worker has no workflow run), to the worker's
 *     own number, under the per-change dedupe key
 *     application-stage:<application>:<status>:<updated_at ms>;
 *   - a worker mid-onboarding gets a deferred intent and no outbox row;
 *   - a worker with no usable number is a 200 that reports renderer_unavailable,
 *     with the rejected intent kept;
 *   - a resend is a new notification, while a repeat claim of the same change
 *     never adds a second outbox row;
 *   - another employer can neither change the status nor reach the
 *     capability functions for the application.
 *
 * Every assertion reads through the superuser.
 */
import type { Pool } from 'pg';
import { createCheckedPool } from '../../../lambda/lib/db';
import { enqueueApplicationStageNotification } from '../../../lambda/lib/application-stage-notify';
import { apiEvent, fakePhone, FIXTURE_TOS_VERSION, parseResponse, World } from './r-paths-world';
import { describeInProfiles, loginClient, loginUrl } from './helpers/login-pool';

const databaseUrl = process.env.JALE_TEST_DATABASE_URL;

let mockPool: Pool | undefined;
jest.mock('../../../lambda/lib/db', () => {
  const actual = jest.requireActual('../../../lambda/lib/db');
  return { ...actual, getDbPool: async () => mockPool };
});

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { handler } = require('../../../lambda/api/employer-application-status-update');

if (!databaseUrl) {
  test('CONCERN: the stage notification DB suite was not run (JALE_TEST_DATABASE_URL unset)', () => {
    expect(databaseUrl).toBeUndefined();
  });
}

const COMPANY = 'Fixture Stage Co';
const JOB_TITLE = 'Fixture Carpenter';
const FRONTEND_BASE_URL = 'https://fixture.invalid';

interface Case {
  workerId: string;
  number: string | null;
  jobId: string;
  applicationId: string;
}

interface Scene {
  world: World;
  employer: { id: string; sub: string };
  otherEmployer: { id: string; sub: string };
  readyEn: Case;
  readyEs: Case;
  /** readyEs's WhatsApp number, which wins over the phone. */
  readyEsWhatsapp: string;
  readyNoRun: Case;
  onboarding: Case;
  noNumber: Case;
}

async function scene(): Promise<Scene> {
  const world = new World(databaseUrl!);
  await world.connect();
  const employer = await world.employer({ companyName: COMPANY });
  const otherEmployer = await world.employer({ companyName: 'Other Fixture Co' });

  // One job per case, so a hire never meets another case's headcount.
  async function applicant(opts: Parameters<World['worker']>[0]): Promise<Case> {
    const worker = await world.worker(opts);
    const job = await world.job(employer.id, { title: JOB_TITLE });
    const applicationId = await world.application(job.id, worker.id, 'talking');
    return { workerId: worker.id, number: opts?.whatsappNumber ?? worker.phone, jobId: job.id, applicationId };
  }

  const readyEsWhatsapp = fakePhone();
  return {
    world,
    employer,
    otherEmployer,
    readyEn: await applicant({ lifecycle: 'ready', workflowLanguage: 'en', whatsappLanguage: 'en' }),
    readyEs: await applicant({ lifecycle: 'ready', workflowLanguage: 'es', whatsappNumber: readyEsWhatsapp }),
    readyEsWhatsapp,
    readyNoRun: await applicant({ lifecycle: 'ready' }),
    onboarding: await applicant({ lifecycle: 'onboarding', workflowLanguage: 'en' }),
    noNumber: await applicant({ lifecycle: 'ready', workflowLanguage: 'en', phone: null, whatsappNumber: null }),
  };
}

async function patch(sub: string, c: Case, body: Record<string, unknown>) {
  return parseResponse(await handler(apiEvent({
    sub,
    httpMethod: 'PATCH',
    resource: '/employer/jobs/{jobId}/applicants/{workerId}',
    pathParameters: { jobId: c.jobId, workerId: c.workerId },
    body,
  })));
}

async function rows(s: Scene, sql: string, params: unknown[]): Promise<any[]> {
  return (await s.world.su.query(sql, params)).rows;
}

async function intentsFor(s: Scene, c: Case) {
  return rows(s, `SELECT id, category, owner_service, source_type, source_id, dedupe_key, priority, status,
                         decision_reason, payload, outbox_id
                    FROM worker_message_intents WHERE source_id = $1 ORDER BY created_at, id`, [c.applicationId]);
}

async function outboxFor(s: Scene, c: Case) {
  return rows(s, `SELECT o.whatsapp_number, o.body, o.content_template, o.content_variables, o.source_type
                    FROM whatsapp_outbox o
                    JOIN worker_message_intents i ON i.outbox_id = o.id
                   WHERE i.source_id = $1 ORDER BY o.created_at, o.id`, [c.applicationId]);
}

/** The key the handler built before the claim function derived it: status and updated_at in ms. */
async function expectedDedupeKey(s: Scene, c: Case): Promise<string> {
  const [row] = await rows(s, `SELECT status, updated_at FROM job_applications WHERE id = $1`, [c.applicationId]);
  return `application-stage:${c.applicationId}:${row.status}:${(row.updated_at as Date).getTime()}`;
}

/** Runs `fn` on a jale_api client inside a transaction carrying `caller`'s context. */
async function asEmployer<T>(caller: { id: string; sub: string }, fn: (client: any) => Promise<T>, commit = false): Promise<T> {
  const client = loginClient('jale_api');
  await client.connect();
  try {
    await client.query('BEGIN');
    await client.query(`SELECT set_config('app.current_user_id', $1, true)`, [caller.sub]);
    await client.query(`SELECT set_config('app.current_internal_user_id', $1, true)`, [caller.id]);
    const result = await fn(client);
    await client.query(commit ? 'COMMIT' : 'ROLLBACK');
    return result;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    await client.end();
  }
}

async function errorCodeOf(promise: Promise<unknown>): Promise<string | undefined> {
  try {
    await promise;
    return undefined;
  } catch (err) {
    return (err as { code?: string }).code ?? (err as Error).message;
  }
}

describeInProfiles(['standard', 'request', 'owner-unrestricted'], 'application stage notifications on jale_api', () => {
  let s: Scene;
  let su: World;
  let originalDeferredDelivery: boolean | null = null;

  beforeAll(async () => {
    process.env.REQUIRED_TOS_VERSION = FIXTURE_TOS_VERSION;
    process.env.FRONTEND_BASE_URL = FRONTEND_BASE_URL;
    mockPool = await createCheckedPool({ connectionString: loginUrl('jale_api'), max: 1 }, 'jale_api', 'test');
    // A ready worker is sent to only while deferred delivery is on; turn it
    // on for the suite and put back whatever the bed had.
    su = new World(databaseUrl!);
    await su.connect();
    const control = await su.su.query<{ enabled: boolean }>(
      `SELECT enabled FROM whatsapp_runtime_controls WHERE control_key = 'deferred_delivery_enabled'`,
    );
    originalDeferredDelivery = control.rows[0]?.enabled ?? null;
    await su.su.query(`UPDATE whatsapp_runtime_controls SET enabled = true WHERE control_key = 'deferred_delivery_enabled'`);
  });
  afterAll(async () => {
    if (originalDeferredDelivery !== null) {
      await su.su.query(
        `UPDATE whatsapp_runtime_controls SET enabled = $1 WHERE control_key = 'deferred_delivery_enabled'`,
        [originalDeferredDelivery],
      );
    }
    await su.end();
    delete process.env.FRONTEND_BASE_URL;
    await mockPool?.end();
    mockPool = undefined;
  });
  beforeEach(async () => {
    s = await scene();
  });
  afterEach(async () => {
    await s.world.cleanup();
    await s.world.end();
  });

  it('details_requested for an English worker: 200 notified, the English template to their own number, one eligible intent', async () => {
    const response = await patch(s.employer.sub, s.readyEn, { status: 'details_requested' });
    expect(response.statusCode).toBe(200);
    expect(response.body).toMatchObject({ status: 'details_requested', notified: true });
    expect(response.body).not.toHaveProperty('notify_reason');

    const intents = await intentsFor(s, s.readyEn);
    expect(intents).toHaveLength(1);
    expect(intents[0]).toMatchObject({
      category: 'account',
      owner_service: 'account',
      source_type: 'application_stage',
      priority: 30,
      status: 'eligible',
      dedupe_key: await expectedDedupeKey(s, s.readyEn),
    });
    expect(intents[0].outbox_id).not.toBeNull();
    expect(intents[0].payload).toEqual({
      kind: 'application_stage',
      status: 'details_requested',
      applicationId: s.readyEn.applicationId,
      jobId: s.readyEn.jobId,
      jobTitle: JOB_TITLE,
      companyName: COMPANY,
      frontendBaseUrl: FRONTEND_BASE_URL,
    });

    const outbox = await outboxFor(s, s.readyEn);
    expect(outbox).toHaveLength(1);
    expect(outbox[0]).toMatchObject({
      whatsapp_number: s.readyEn.number,
      body: null,
      content_template: 'application_update_en',
      source_type: 'worker_intent',
    });
    expect(outbox[0].content_variables).toMatchObject({
      '1': JOB_TITLE,
      '2': COMPANY,
      '3': `app-${s.readyEn.applicationId}`,
      '4': `${FRONTEND_BASE_URL}/en/worker/applications/${s.readyEn.applicationId}`,
    });
    expect(outbox[0].content_variables.__fallback_body).toMatch(/^Application update for Fixture Carpenter: /);
  });

  it('hired for a Spanish worker: the Spanish hired template, to the WhatsApp number', async () => {
    const response = await patch(s.employer.sub, s.readyEs, { status: 'hired' });
    expect(response.statusCode).toBe(200);
    expect(response.body).toMatchObject({ status: 'hired', notified: true });

    const outbox = await outboxFor(s, s.readyEs);
    expect(outbox).toHaveLength(1);
    expect(outbox[0].whatsapp_number).toBe(s.readyEsWhatsapp);
    expect(outbox[0].content_template).toBe('application_hired_es');
    expect(outbox[0].content_variables['4']).toBe(`${FRONTEND_BASE_URL}/es/worker/applications/${s.readyEs.applicationId}`);
    expect((await intentsFor(s, s.readyEs))[0].dedupe_key).toBe(await expectedDedupeKey(s, s.readyEs));
  });

  it('a worker with no workflow run is written to in Spanish, as before', async () => {
    expect((await patch(s.employer.sub, s.readyNoRun, { status: 'details_requested' })).statusCode).toBe(200);
    expect((await outboxFor(s, s.readyNoRun)).map((row) => row.content_template)).toEqual(['application_update_es']);
  });

  it('a worker mid-onboarding: 200 notified, a deferred intent and no outbox row', async () => {
    const response = await patch(s.employer.sub, s.onboarding, { status: 'details_requested' });
    expect(response.statusCode).toBe(200);
    expect(response.body).toMatchObject({ notified: true });
    const intents = await intentsFor(s, s.onboarding);
    expect(intents.map((row) => [row.status, row.decision_reason, row.outbox_id])).toEqual([
      ['deferred', 'worker_onboarding', null],
    ]);
    expect(await outboxFor(s, s.onboarding)).toEqual([]);
  });

  it('a worker with no usable number: the status change commits, the answer says renderer_unavailable, the rejected intent is kept', async () => {
    const response = await patch(s.employer.sub, s.noNumber, { status: 'details_requested' });
    expect(response.statusCode).toBe(200);
    expect(response.body).toMatchObject({ status: 'details_requested', notified: false, notify_reason: 'renderer_unavailable' });
    expect(await rows(s, `SELECT status FROM job_applications WHERE id = $1`, [s.noNumber.applicationId]))
      .toEqual([{ status: 'details_requested' }]);
    const intents = await intentsFor(s, s.noNumber);
    expect(intents.map((row) => [row.status, row.decision_reason, row.outbox_id])).toEqual([
      ['rejected', 'renderer_unavailable', null],
    ]);
    expect(await outboxFor(s, s.noNumber)).toEqual([]);
  });

  it('a resend is a new notification; a repeat claim of the same change adds no outbox row', async () => {
    expect((await patch(s.employer.sub, s.readyEn, { status: 'details_requested' })).statusCode).toBe(200);
    expect((await patch(s.employer.sub, s.readyEn, { status: 'details_requested', resend: true })).statusCode).toBe(200);
    let intents = await intentsFor(s, s.readyEn);
    expect(intents).toHaveLength(2);
    expect(new Set(intents.map((row) => row.dedupe_key)).size).toBe(2);
    expect(await outboxFor(s, s.readyEn)).toHaveLength(2);

    // The same change claimed again -- a retried request that did not touch
    // the row -- names the latest intent and materializes nothing new.
    // (`updatedAt` is the row's own; the claim derives the key from the row.)
    const [current] = await rows(s, `SELECT updated_at FROM job_applications WHERE id = $1`, [s.readyEn.applicationId]);
    const repeat = await asEmployer(s.employer, (client) => enqueueApplicationStageNotification(client, {
      applicationId: s.readyEn.applicationId,
      workerId: s.readyEn.workerId,
      kind: 'details_requested',
      jobId: s.readyEn.jobId,
      jobTitle: JOB_TITLE,
      companyName: COMPANY,
      frontendBaseUrl: FRONTEND_BASE_URL,
      updatedAt: current.updated_at,
    } as Parameters<typeof enqueueApplicationStageNotification>[1]), true);
    intents = await intentsFor(s, s.readyEn);
    expect(repeat).toMatchObject({ outcome: 'enqueued', outboxMaterialized: false, intentId: intents[1].id });
    expect(intents).toHaveLength(2);
    expect(await outboxFor(s, s.readyEn)).toHaveLength(2);
  });

  it('another employer can neither change the status nor reach the capability functions for the application', async () => {
    const response = await patch(s.otherEmployer.sub, s.readyEn, { status: 'hired' });
    expect(response.statusCode).toBe(403);
    expect(response.body).toEqual({ error: 'forbidden' });
    expect(await rows(s, `SELECT status FROM job_applications WHERE id = $1`, [s.readyEn.applicationId]))
      .toEqual([{ status: 'talking' }]);

    expect(await errorCodeOf(asEmployer(s.otherEmployer, (client) => client.query(
      `SELECT * FROM jale_cap.employer_stage_recipient($1)`, [s.readyEn.applicationId],
    )))).toBe('42501');
    expect(await errorCodeOf(asEmployer(s.otherEmployer, (client) => client.query(
      `SELECT * FROM jale_cap.employer_claim_worker_intent($1, 'application_stage', $2, '{}'::jsonb, NULL)`,
      [s.readyEn.workerId, s.readyEn.applicationId],
    )))).toBe('42501');
    expect(await intentsFor(s, s.readyEn)).toEqual([]);
  });

  it("the claim refuses a worker other than the application's", async () => {
    expect(await errorCodeOf(asEmployer(s.employer, (client) => client.query(
      `SELECT * FROM jale_cap.employer_claim_worker_intent($1, 'application_stage', $2, '{}'::jsonb, NULL)`,
      [s.readyEs.workerId, s.readyEn.applicationId],
    )))).toBe('42501');
    expect(await intentsFor(s, s.readyEn)).toEqual([]);
  });

  it("the stage recipient answers for the caller's application with the worker's language and number", async () => {
    const answer = await asEmployer(s.employer, async (client) => (await client.query(
      `SELECT worker_id, language, has_whatsapp_number FROM jale_cap.employer_stage_recipient($1)`,
      [s.readyEn.applicationId],
    )).rows);
    expect(answer).toEqual([{ worker_id: s.readyEn.workerId, language: 'en', has_whatsapp_number: true }]);

    const none = await asEmployer(s.employer, async (client) => (await client.query(
      `SELECT worker_id, language, has_whatsapp_number FROM jale_cap.employer_stage_recipient($1)`,
      [s.noNumber.applicationId],
    )).rows);
    expect(none).toEqual([{ worker_id: s.noNumber.workerId, language: 'en', has_whatsapp_number: false }]);
  });
});
