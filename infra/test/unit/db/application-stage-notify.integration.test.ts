import { randomUUID } from 'node:crypto';
import { Client } from 'pg';
import type { PoolClient } from 'pg';
import {
  enqueueApplicationStageNotification,
  type ApplicationStageKind,
} from '../../../lambda/lib/application-stage-notify';
import { _clearCategoryRenderersForTests } from '../../../lambda/whatsapp/lib/worker-delivery-gateway';

/**
 * Sprint 23 L2.5 -- the employer stage notification against the REAL policies.
 *
 * This suite exists because the whole feature turns on one GUC that no mocked
 * pool can enforce. `enqueueApplicationStageNotification` runs as jale_admin
 * inside the employer's API transaction, and the renderer's recipient lookup
 * reaches the worker's `users` row ONLY through
 * `users_employer_applicant_read` (020b:261-269, repaired by 038):
 *
 *   USING (user_type = 'worker'
 *          AND jale_internal.employer_has_applicant_relationship(
 *                current_setting('app.current_internal_user_id', true), id))
 *
 * With that GUC holding the EMPLOYER's users.id the SELECT succeeds and the
 * message is queued. With it unset, or pointed at the WORKER (the shape
 * job-messaging.ts:505-529 uses, which only ever runs on the non-rendering
 * deferred branch), the SELECT returns zero rows, the renderer returns null,
 * and the gateway silently rejects the intent as `renderer_unavailable` -- a
 * 200 to the employer and no WhatsApp message, forever. Case (b) below pins
 * that so the bug cannot come back.
 */

const databaseUrl = process.env.JALE_TEST_DATABASE_URL;
if (!databaseUrl) {
  test('CONCERN: the application-stage notification PostgreSQL gate was not run', () => {
    console.warn('[application-stage-notify] JALE_TEST_DATABASE_URL not set; disposable PostgreSQL gate skipped');
    expect(databaseUrl).toBeUndefined();
  });
}
const maybeDescribe = databaseUrl ? describe : describe.skip;

maybeDescribe('application stage notification against the real RLS policies', () => {
  let setup: Client;
  let originalDeferredDeliveryEnabled: boolean | null = null;

  const employerId = randomUUID();
  const workerReady = randomUUID();
  const workerNoPhone = randomUUID();
  const workerOnboarding = randomUUID();
  const workerIds = [workerReady, workerNoPhone, workerOnboarding];

  // One application per case: `worker_message_intent_dedupe` is UNIQUE on the
  // dedupe key, which is derived from the application id. `job_applications`
  // is UNIQUE (job_id, worker_id), so each case also gets its own job.
  const appEmployerGuc = randomUUID();
  const appWorkerGuc = randomUUID();
  const appNoPhone = randomUUID();
  const appOnboarding = randomUUID();
  const appIdempotent = randomUUID();
  const appHired = randomUUID();
  const appResend = randomUUID();
  const applicationIds: string[] = [
    appEmployerGuc, appWorkerGuc, appNoPhone, appOnboarding, appIdempotent, appHired, appResend,
  ];
  const applicationWorkers: string[] = [
    workerReady, workerReady, workerNoPhone, workerOnboarding, workerReady, workerReady, workerReady,
  ];
  const jobIds: string[] = applicationIds.map(() => randomUUID() as string);
  const jobIdFor = (applicationId: string): string => jobIds[applicationIds.indexOf(applicationId)];

  const READY_PHONE = '+15125550143';
  const UPDATED_AT = new Date('2026-09-02T12:00:00.000Z');
  const FRONTEND_BASE_URL = 'https://jaleapp.ai';

  /**
   * One connection per logical operation, mirroring
   * whatsapp-application-fill-080.integration.test.ts: BEGIN, SET LOCAL ROLE
   * jale_admin (transaction-scoped), then the two session GUCs the employer
   * API sets -- `app.current_user_id` (Cognito sub) and
   * `app.current_internal_user_id` (users.id).
   */
  async function connectAsEmployerApi(internalUserId: string | null): Promise<Client> {
    const client = new Client({ connectionString: databaseUrl });
    await client.connect();
    await client.query('BEGIN');
    await client.query('SET LOCAL ROLE jale_admin');
    await client.query(`SELECT set_config('app.current_user_id', $1, true)`, [`t25-employer-${employerId}`]);
    if (internalUserId !== null) {
      await client.query(`SELECT set_config('app.current_internal_user_id', $1, true)`, [internalUserId]);
    }
    return client;
  }

  async function notify(
    client: Client,
    input: { applicationId: string; workerId: string; kind?: ApplicationStageKind; updatedAt?: Date },
  ) {
    return enqueueApplicationStageNotification(client as unknown as PoolClient, {
      applicationId: input.applicationId,
      workerId: input.workerId,
      kind: input.kind ?? 'details_requested',
      jobId: jobIdFor(input.applicationId),
      jobTitle: 'Concrete Finisher',
      companyName: 'RM Construction',
      frontendBaseUrl: FRONTEND_BASE_URL,
      updatedAt: input.updatedAt ?? UPDATED_AT,
    });
  }

  async function readIntentAndOutbox(applicationId: string) {
    const intents = await setup.query(
      `SELECT id, status, decision_reason, outbox_id, category, owner_service, source_type, priority
         FROM worker_message_intents
        WHERE source_id = $1
        ORDER BY created_at`,
      [applicationId],
    );
    const outbox = await setup.query(
      `SELECT o.whatsapp_number, o.body, o.content_template, o.content_variables, o.source_type, o.source_id
         FROM whatsapp_outbox o
         JOIN worker_message_intents i ON i.outbox_id = o.id
        WHERE i.source_id = $1`,
      [applicationId],
    );
    return { intents: intents.rows, outbox: outbox.rows };
  }

  beforeAll(async () => {
    setup = new Client({ connectionString: databaseUrl });
    await setup.connect();

    await setup.query(
      `INSERT INTO users (id, cognito_sub, user_type) VALUES ($1, $2, 'employer')`,
      [employerId, `t25-employer-${employerId}`],
    );
    await setup.query(
      `INSERT INTO users (id, cognito_sub, user_type, phone, whatsapp_number)
       VALUES ($1, $2, 'worker', $3, $4)`,
      [workerReady, `t25-worker-ready-${workerReady}`, READY_PHONE, READY_PHONE],
    );
    // No phone and no whatsapp_number: loadVerifiedRecipient must refuse.
    await setup.query(
      `INSERT INTO users (id, cognito_sub, user_type) VALUES ($1, $2, 'worker')`,
      [workerNoPhone, `t25-worker-nophone-${workerNoPhone}`],
    );
    await setup.query(
      `INSERT INTO users (id, cognito_sub, user_type, phone, whatsapp_number)
       VALUES ($1, $2, 'worker', $3, $4)`,
      [workerOnboarding, `t25-worker-onboarding-${workerOnboarding}`, '+15125550144', '+15125550144'],
    );

    await setup.query(
      `INSERT INTO jobs (id, employer_id, title, location, job_type, status)
       SELECT id, $2, 'Concrete Finisher', 'Austin', 'full-time', 'active'
         FROM unnest($1::uuid[]) AS id`,
      [jobIds, employerId],
    );

    // The applicant relationship users_employer_applicant_read depends on.
    await setup.query(
      `INSERT INTO job_applications (id, job_id, worker_id, status)
       SELECT id, job_id, worker_id, 'talking'
         FROM unnest($1::uuid[], $2::uuid[], $3::uuid[]) AS t(id, job_id, worker_id)`,
      [applicationIds, jobIds, applicationWorkers],
    );

    await setup.query(
      `INSERT INTO worker_onboarding_state (user_id, lifecycle)
       VALUES ($1, 'ready'), ($2, 'ready'), ($3, 'onboarding')`,
      [workerReady, workerNoPhone, workerOnboarding],
    );

    // evaluateDelivery defers every non-onboarding/security intent while
    // deferred_delivery_enabled is false (delivery-policy.ts:51-53). Flip it on
    // for this suite and restore whatever the database had.
    const control = await setup.query<{ enabled: boolean }>(
      `SELECT enabled FROM whatsapp_runtime_controls WHERE control_key = 'deferred_delivery_enabled'`,
    );
    originalDeferredDeliveryEnabled = control.rows[0]?.enabled ?? null;
    await setup.query(
      `UPDATE whatsapp_runtime_controls SET enabled = true WHERE control_key = 'deferred_delivery_enabled'`,
    );
  });

  afterEach(() => {
    _clearCategoryRenderersForTests();
  });

  afterAll(async () => {
    if (!databaseUrl) return;
    if (originalDeferredDeliveryEnabled !== null) {
      await setup.query(
        `UPDATE whatsapp_runtime_controls SET enabled = $1 WHERE control_key = 'deferred_delivery_enabled'`,
        [originalDeferredDeliveryEnabled],
      );
    }
    await setup.query(
      `DELETE FROM whatsapp_outbox
        WHERE id IN (SELECT outbox_id FROM worker_message_intents
                      WHERE source_id = ANY($1::uuid[]) AND outbox_id IS NOT NULL)`,
      [applicationIds],
    );
    await setup.query('DELETE FROM worker_message_intents WHERE source_id = ANY($1::uuid[])', [applicationIds]);
    await setup.query('DELETE FROM worker_onboarding_state WHERE user_id = ANY($1::uuid[])', [workerIds]);
    await setup.query('DELETE FROM job_applications WHERE id = ANY($1::uuid[])', [applicationIds]);
    await setup.query('DELETE FROM jobs WHERE id = ANY($1::uuid[])', [jobIds]);
    await setup.query('DELETE FROM users WHERE id = ANY($1::uuid[])', [[employerId, ...workerIds]]);
    await setup.end();
  });

  it("(a) queues the message when app.current_internal_user_id holds the EMPLOYER's users.id", async () => {
    const client = await connectAsEmployerApi(employerId);
    try {
      const result = await notify(client, { applicationId: appEmployerGuc, workerId: workerReady });
      expect(result).toMatchObject({ outcome: 'enqueued', outboxMaterialized: true });
      expect(result.outcome === 'enqueued' && result.decision).toEqual({ action: 'allow', reason: 'worker_ready' });
      await client.query('COMMIT');
    } finally {
      await client.end();
    }

    const { intents, outbox } = await readIntentAndOutbox(appEmployerGuc);
    expect(intents).toHaveLength(1);
    expect(intents[0]).toMatchObject({
      status: 'eligible',
      category: 'account',
      owner_service: 'account',
      source_type: 'application_stage',
      priority: 30,
    });
    expect(intents[0].outbox_id).not.toBeNull();

    expect(outbox).toHaveLength(1);
    expect(outbox[0].whatsapp_number).toBe(READY_PHONE);
    expect(outbox[0].content_template).toBe('application_update_es');
    expect(outbox[0].source_type).toBe('worker_intent');
    const vars = outbox[0].content_variables as Record<string, string>;
    expect(vars['1']).toBe('Concrete Finisher');
    expect(vars['2']).toBe('RM Construction');
    expect(vars['3']).toBe(`app-${appEmployerGuc}`);
    expect(vars['4']).toBe(`${FRONTEND_BASE_URL}/es/worker/applications/${appEmployerGuc}`);
    expect(typeof vars.__fallback_body).toBe('string');
    expect(vars.__fallback_body).toContain('RM Construction');
  });

  it('(b) is silently dropped when that GUC is pointed at the WORKER instead -- the L2.5 review defect', async () => {
    const client = await connectAsEmployerApi(workerReady);
    try {
      const result = await notify(client, { applicationId: appWorkerGuc, workerId: workerReady });
      expect(result).toEqual({ outcome: 'renderer_unavailable', reason: 'renderer_unavailable' });
      await client.query('COMMIT');
    } finally {
      await client.end();
    }

    const { intents, outbox } = await readIntentAndOutbox(appWorkerGuc);
    expect(intents).toHaveLength(1);
    expect(intents[0]).toMatchObject({ status: 'rejected', decision_reason: 'renderer_unavailable' });
    expect(intents[0].outbox_id).toBeNull();
    expect(outbox).toHaveLength(0);
  });

  it('(c) reports renderer_unavailable for a worker with no phone and no whatsapp_number', async () => {
    const client = await connectAsEmployerApi(employerId);
    try {
      const result = await notify(client, { applicationId: appNoPhone, workerId: workerNoPhone });
      expect(result).toEqual({ outcome: 'renderer_unavailable', reason: 'renderer_unavailable' });
      await client.query('COMMIT');
    } finally {
      await client.end();
    }

    const { intents, outbox } = await readIntentAndOutbox(appNoPhone);
    expect(intents[0]).toMatchObject({ status: 'rejected', decision_reason: 'renderer_unavailable' });
    expect(outbox).toHaveLength(0);
  });

  it('(d) defers -- with no outbox row -- for a worker still in onboarding', async () => {
    const client = await connectAsEmployerApi(employerId);
    try {
      const result = await notify(client, { applicationId: appOnboarding, workerId: workerOnboarding });
      expect(result).toMatchObject({ outcome: 'enqueued', outboxMaterialized: false });
      expect(result.outcome === 'enqueued' && result.decision).toEqual({
        action: 'defer', reason: 'worker_onboarding',
      });
      await client.query('COMMIT');
    } finally {
      await client.end();
    }

    const { intents, outbox } = await readIntentAndOutbox(appOnboarding);
    expect(intents[0]).toMatchObject({ status: 'deferred', decision_reason: 'worker_onboarding' });
    expect(intents[0].outbox_id).toBeNull();
    expect(outbox).toHaveLength(0);
  });

  it('(e) is idempotent: the same updatedAt twice yields one intent and one outbox row', async () => {
    const first = await connectAsEmployerApi(employerId);
    let firstIntentId: string;
    try {
      const result = await notify(first, { applicationId: appIdempotent, workerId: workerReady });
      expect(result).toMatchObject({ outcome: 'enqueued', outboxMaterialized: true });
      firstIntentId = (result as { intentId: string }).intentId;
      await first.query('COMMIT');
    } finally {
      await first.end();
    }

    const second = await connectAsEmployerApi(employerId);
    try {
      const result = await notify(second, { applicationId: appIdempotent, workerId: workerReady });
      expect(result).toMatchObject({ outcome: 'enqueued', outboxMaterialized: false });
      expect((result as { intentId: string }).intentId).toBe(firstIntentId);
      await second.query('COMMIT');
    } finally {
      await second.end();
    }

    const { intents, outbox } = await readIntentAndOutbox(appIdempotent);
    expect(intents).toHaveLength(1);
    expect(outbox).toHaveLength(1);
  });

  it('(g) a RESEND -- same application, later updatedAt -- yields a second intent and outbox row', async () => {
    // Sprint 24 (B7): the employer's "Resend request" re-PATCHes the same
    // status; the handler's UPDATE stamps `updated_at = now()` (the
    // transaction timestamp), so the dedupe key differs from the first send's
    // and the constraint admits a fresh intent. This is the real-Postgres proof
    // of that reasoning -- the handler unit test mocks this module.
    const first = await connectAsEmployerApi(employerId);
    let firstIntentId: string;
    try {
      const result = await notify(first, { applicationId: appResend, workerId: workerReady });
      expect(result).toMatchObject({ outcome: 'enqueued', outboxMaterialized: true });
      firstIntentId = (result as { intentId: string }).intentId;
      await first.query('COMMIT');
    } finally {
      await first.end();
    }

    const resend = await connectAsEmployerApi(employerId);
    try {
      const result = await notify(resend, {
        applicationId: appResend,
        workerId: workerReady,
        updatedAt: new Date(UPDATED_AT.getTime() + 60_000),
      });
      expect(result).toMatchObject({ outcome: 'enqueued', outboxMaterialized: true });
      expect((result as { intentId: string }).intentId).not.toBe(firstIntentId);
      await resend.query('COMMIT');
    } finally {
      await resend.end();
    }

    const { intents, outbox } = await readIntentAndOutbox(appResend);
    expect(intents).toHaveLength(2);
    expect(outbox).toHaveLength(2);
  });

  it('(f) queues the hired template for a hire', async () => {
    const client = await connectAsEmployerApi(employerId);
    try {
      const result = await notify(client, { applicationId: appHired, workerId: workerReady, kind: 'hired' });
      expect(result).toMatchObject({ outcome: 'enqueued', outboxMaterialized: true });
      await client.query('COMMIT');
    } finally {
      await client.end();
    }

    const { outbox } = await readIntentAndOutbox(appHired);
    expect(outbox).toHaveLength(1);
    expect(outbox[0].content_template).toBe('application_hired_es');
    // D6 (2026-09-04): the hired copy no longer opens "Buenas noticias" --
    // that promotional register is what got the template recategorised to
    // MARKETING, which cannot be sent outside the 24h window. The assertion
    // is on the transactional opening the renderer and the seeded template
    // now share byte-for-byte.
    expect((outbox[0].content_variables as Record<string, string>).__fallback_body)
      .toContain('Actualizacion del estado de tu aplicacion para');
    expect((outbox[0].content_variables as Record<string, string>).__fallback_body)
      .not.toContain('Buenas noticias');
  });
});
