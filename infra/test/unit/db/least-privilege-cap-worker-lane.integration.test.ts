/**
 * least-privilege-cap-worker-lane.integration.test.ts -- the employer paths'
 * capability functions into the worker lane, on a real bed.
 *
 * The request login holds no rights on the worker lane's tables. The employer
 * messaging and stage-notification paths reach them through three jale_cap
 * functions, owned by jale_cap_worker_lane and called by jale_api with the
 * employer's users.id in app.current_internal_user_id. This suite calls each
 * one over the request login's real connection (never SET ROLE) and proves
 * the observable behaviour the handlers had:
 *   - delivery context: the stored lifecycle (NULL without a gate row), the
 *     workflow language (active run first, else the newest; es by default),
 *     the WhatsApp conversation's language, and the gate row locked for the
 *     rest of the caller's transaction;
 *   - stage recipient: the newest run's language and the stage rule for a
 *     usable number (COALESCE(whatsapp_number, phone), empty is none);
 *   - claim: the gateway's decisions (defer/worker_onboarding,
 *     defer/delivery_disabled, reject/worker_suspended, allow/worker_ready),
 *     the intent's derived fields and dedupe key, one outbox row at most,
 *     reject/renderer_unavailable without a message or a number, and the
 *     terminal-status mapping on a repeat.
 * Another employer's worker, message or application is refused with 42501
 * and writes nothing, whatever capability flags the caller sets.
 *
 * Connection: JALE_TEST_DATABASE_URL (the bed's superuser URL) for fixtures;
 * the caller signs in through helpers/login-pool.
 */
import { randomUUID } from 'node:crypto';
import { Client } from 'pg';
import { setEveryCapabilityFlag, type FlagVictim } from './helpers/capability-flags';
import { loginClient, withLoginClient } from './helpers/login-pool';

const databaseUrl = process.env.JALE_TEST_DATABASE_URL;
if (!databaseUrl) {
  test('CONCERN: least-privilege worker-lane functions PostgreSQL gate was not run', () => {
    console.warn('[least-privilege-cap-worker-lane] JALE_TEST_DATABASE_URL not set; disposable PostgreSQL gate skipped');
    expect(databaseUrl).toBeUndefined();
  });
}
const maybeDescribe = databaseUrl ? describe : describe.skip;

const CONTEXT = 'SELECT * FROM jale_cap.employer_worker_delivery_context($1)';
const RECIPIENT = 'SELECT * FROM jale_cap.employer_stage_recipient($1)';
const CLAIM = 'SELECT * FROM jale_cap.employer_claim_worker_intent($1, $2, $3, $4::jsonb, $5::jsonb)';
const TEMPLATE = { content_template: 'application_update_en', content_variables: { 1: 'Fixture job', 2: 'Fixture Co' } };

interface Context {
  internalUserId?: string;
  flagsFor?: FlagVictim;
}

/** Runs `sql` as the request login in its own transaction, as a handler would, and commits. */
async function callAs<T extends object>(sql: string, params: unknown[], ctx: Context = {}): Promise<T[]> {
  return withLoginClient('jale_api', async (client) => {
    await client.query('BEGIN');
    try {
      if (ctx.internalUserId !== undefined) {
        await client.query(`SELECT set_config('app.current_internal_user_id', $1, true)`, [ctx.internalUserId]);
      }
      if (ctx.flagsFor) await setEveryCapabilityFlag(client, ctx.flagsFor);
      const { rows } = await client.query<T>(sql, params);
      await client.query('COMMIT');
      return rows;
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw err;
    }
  });
}

/** SQLSTATE and message of a refused call; null when it succeeds. */
async function errorOf(promise: Promise<unknown>): Promise<{ code: string; message: string } | null> {
  try {
    await promise;
    return null;
  } catch (err) {
    return { code: (err as { code?: string }).code ?? 'unknown', message: (err as Error).message };
  }
}

async function sqlstate(promise: Promise<unknown>): Promise<string | null> {
  try {
    await promise;
    return null;
  } catch (err) {
    return (err as { code?: string }).code ?? 'unknown';
  }
}

interface ClaimRow {
  intent_id: string;
  decision_action: string;
  decision_reason: string;
  outbox_id: string | null;
  outbox_materialized: boolean;
}

maybeDescribe('worker-lane capability functions', () => {
  let su: Client;
  const stamp = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
  const digits = () => `+1555${String(Math.floor(Math.random() * 1e7)).padStart(7, '0')}`;
  const subs = {
    employerA: `lp-wl-employer-a-${stamp}`,
    employerB: `lp-wl-employer-b-${stamp}`,
    ready: `lp-wl-ready-${stamp}`,
    onboarding: `lp-wl-onboarding-${stamp}`,
    suspended: `lp-wl-suspended-${stamp}`,
    stranger: `lp-wl-stranger-${stamp}`,
  };
  const ids: Record<keyof typeof subs | 'jobA' | 'jobB', string> = {
    employerA: '', employerB: '', ready: '', onboarding: '', suspended: '', stranger: '', jobA: '', jobB: '',
  };
  const applications: Record<'ready' | 'onboarding' | 'suspended' | 'stranger', string> = {
    ready: '', onboarding: '', suspended: '', stranger: '',
  };
  let deferredBefore: boolean | null = null;
  let victimB: FlagVictim;

  async function setDeferredDelivery(enabled: boolean): Promise<void> {
    await su.query(`UPDATE public.whatsapp_runtime_controls SET enabled = $1 WHERE control_key = 'deferred_delivery_enabled'`, [enabled]);
  }

  /** A new message in the open conversation between `employer` and `worker` on `job` (created on first use). */
  async function employerMessage(employer: string, worker: string, job: string, application: string, senderType = 'employer') {
    const existing = (await su.query<{ id: string }>(
      `SELECT id FROM public.job_conversations WHERE job_id = $1 AND employer_id = $2 AND worker_id = $3 AND status = 'open'`,
      [job, employer, worker],
    )).rows[0]?.id;
    const conversation = existing ?? (await su.query<{ id: string }>(
      `INSERT INTO public.job_conversations (job_id, employer_id, worker_id, application_id, status)
       VALUES ($1, $2, $3, $4, 'open') RETURNING id`,
      [job, employer, worker, application],
    )).rows[0].id;
    const message = (await su.query<{ id: string }>(
      `INSERT INTO public.job_conversation_messages (conversation_id, sender_type, direction, body, status)
       VALUES ($1, $2, $3, 'Fixture message', 'waiting_worker_reply') RETURNING id`,
      [conversation, senderType, senderType === 'employer' ? 'outbound' : 'inbound'],
    )).rows[0].id;
    return { conversation, message };
  }

  async function intent(id: string) {
    const { rows } = await su.query(
      `SELECT user_id, category, owner_service, source_type, source_id, dedupe_key, priority, status, policy_version,
              decision_reason, payload, outbox_id,
              abs(extract(epoch FROM expires_at - (now() + interval '7 days'))) < 120 AS seven_days
         FROM public.worker_message_intents WHERE id = $1`,
      [id],
    );
    return rows[0];
  }

  async function setApplicationStatus(application: string, status: string): Promise<{ updated_at: Date }> {
    return (await su.query<{ updated_at: Date }>(
      `UPDATE public.job_applications SET status = $2, updated_at = now() WHERE id = $1 RETURNING updated_at`,
      [application, status],
    )).rows[0];
  }

  beforeAll(async () => {
    su = new Client({ connectionString: databaseUrl });
    await su.connect();
    deferredBefore = (await su.query<{ enabled: boolean }>(
      `SELECT enabled FROM public.whatsapp_runtime_controls WHERE control_key = 'deferred_delivery_enabled'`,
    )).rows[0]?.enabled ?? null;

    for (const [name, type] of [
      ['employerA', 'employer'], ['employerB', 'employer'], ['ready', 'worker'], ['onboarding', 'worker'],
      ['suspended', 'worker'], ['stranger', 'worker'],
    ] as const) {
      ids[name] = (await su.query<{ id: string }>(
        `INSERT INTO public.users (cognito_sub, user_type, whatsapp_number, phone) VALUES ($1, $2, $3, $4) RETURNING id`,
        [subs[name], type, type === 'worker' ? digits() : null, type === 'worker' ? digits() : null],
      )).rows[0].id;
    }
    for (const [job, employer] of [['jobA', 'employerA'], ['jobB', 'employerB']] as const) {
      ids[job] = (await su.query<{ id: string }>(
        `INSERT INTO public.jobs (employer_id, title, location, job_type, status, number_of_workers_needed)
         VALUES ($1, 'Least-privilege worker-lane fixture', 'Austin', 'full-time', 'active', 5) RETURNING id`,
        [ids[employer]],
      )).rows[0].id;
    }
    for (const worker of ['ready', 'onboarding', 'suspended'] as const) {
      applications[worker] = (await su.query<{ id: string }>(
        `INSERT INTO public.job_applications (job_id, worker_id) VALUES ($1, $2) RETURNING id`, [ids.jobA, ids[worker]],
      )).rows[0].id;
    }
    // The stranger applied only to employer B's job.
    applications.stranger = (await su.query<{ id: string }>(
      `INSERT INTO public.job_applications (job_id, worker_id) VALUES ($1, $2) RETURNING id`, [ids.jobB, ids.stranger],
    )).rows[0].id;

    for (const [worker, lifecycle] of [['ready', 'ready'], ['suspended', 'suspended'], ['stranger', 'ready']] as const) {
      await su.query(`INSERT INTO public.worker_onboarding_state (user_id, lifecycle) VALUES ($1, $2)`, [ids[worker], lifecycle]);
    }
    // The ready worker: an older active run in en and a newer completed one in es.
    await su.query(
      `INSERT INTO public.worker_workflow_runs (user_id, workflow_version, current_step_key, status, preferred_language, created_at)
       VALUES ($1, 1, 'start.choose_language', 'active', 'en', now() - interval '2 days'),
              ($1, 1, 'start.choose_language', 'completed', 'es', now() - interval '1 day')`,
      [ids.ready],
    );
    await su.query(
      `INSERT INTO public.whatsapp_conversations (user_id, whatsapp_number, language) VALUES ($1, $2, 'en')`,
      [ids.ready, digits()],
    );
    victimB = { userId: ids.employerB, sub: subs.employerB };
  });

  afterAll(async () => {
    if (!su) return;
    const workers = [ids.ready, ids.onboarding, ids.suspended, ids.stranger].filter(Boolean);
    const outboxIds = (await su.query<{ outbox_id: string }>(
      `SELECT outbox_id FROM public.worker_message_intents WHERE user_id = ANY($1::uuid[]) AND outbox_id IS NOT NULL`, [workers],
    )).rows.map((r) => r.outbox_id);
    await su.query('DELETE FROM public.worker_message_intents WHERE user_id = ANY($1::uuid[])', [workers]);
    await su.query('DELETE FROM public.whatsapp_outbox WHERE id = ANY($1::uuid[])', [outboxIds]);
    await su.query('DELETE FROM public.whatsapp_conversations WHERE user_id = ANY($1::uuid[])', [workers]);
    await su.query('DELETE FROM public.worker_workflow_runs WHERE user_id = ANY($1::uuid[])', [workers]);
    await su.query('DELETE FROM public.worker_onboarding_state WHERE user_id = ANY($1::uuid[])', [workers]);
    await su.query('DELETE FROM public.jobs WHERE id = ANY($1::uuid[])', [[ids.jobA, ids.jobB].filter(Boolean)]);
    await su.query('DELETE FROM public.users WHERE cognito_sub = ANY($1::text[])', [Object.values(subs)]);
    if (deferredBefore !== null) await setDeferredDelivery(deferredBefore);
    await su.end();
  });

  describe('employer_worker_delivery_context', () => {
    it('returns the stored lifecycle, the active run\'s language and the WhatsApp language', async () => {
      expect(await callAs(CONTEXT, [ids.ready], { internalUserId: ids.employerA }))
        .toEqual([{ lifecycle: 'ready', workflow_language: 'en', whatsapp_language: 'en' }]);
      expect(await callAs(CONTEXT, [ids.suspended], { internalUserId: ids.employerA }))
        .toEqual([{ lifecycle: 'suspended', workflow_language: 'es', whatsapp_language: null }]);
    });

    it('answers a NULL lifecycle and es for an applicant with no gate row yet', async () => {
      expect(await callAs(CONTEXT, [ids.onboarding], { internalUserId: ids.employerA }))
        .toEqual([{ lifecycle: null, workflow_language: 'es', whatsapp_language: null }]);
    });

    it('keeps the worker\'s gate row locked until the caller\'s transaction ends', async () => {
      const caller = loginClient('jale_api');
      await caller.connect();
      const other = new Client({ connectionString: databaseUrl });
      await other.connect();
      try {
        await caller.query('BEGIN');
        await caller.query(`SELECT set_config('app.current_internal_user_id', $1, true)`, [ids.employerA]);
        await caller.query(CONTEXT, [ids.ready]);
        await other.query(`SET lock_timeout = '200ms'`);
        expect(await sqlstate(other.query('SELECT 1 FROM public.worker_onboarding_state WHERE user_id = $1 FOR UPDATE', [ids.ready])))
          .toBe('55P03');
        await caller.query('COMMIT');
        expect(await sqlstate(other.query('SELECT 1 FROM public.worker_onboarding_state WHERE user_id = $1 FOR UPDATE', [ids.ready])))
          .toBeNull();
      } finally {
        await caller.query('ROLLBACK').catch(() => undefined);
        await caller.end();
        await other.end();
      }
    });

    it('refuses (42501) another employer\'s applicant, an unset or empty caller, whatever flags are set', async () => {
      expect(await sqlstate(callAs(CONTEXT, [ids.stranger], { internalUserId: ids.employerA, flagsFor: victimB }))).toBe('42501');
      expect(await sqlstate(callAs(CONTEXT, [ids.ready], { flagsFor: victimB }))).toBe('42501');
      expect(await sqlstate(callAs(CONTEXT, [ids.ready], { internalUserId: '' }))).toBe('42501');
      expect(await sqlstate(callAs(CONTEXT, [null], { internalUserId: ids.employerA }))).toBe('22023');
    });

    it('never writes the gate row', async () => {
      const before = (await su.query('SELECT lifecycle, updated_at FROM public.worker_onboarding_state WHERE user_id = $1', [ids.ready])).rows;
      await callAs(CONTEXT, [ids.ready], { internalUserId: ids.employerA });
      expect((await su.query('SELECT lifecycle, updated_at FROM public.worker_onboarding_state WHERE user_id = $1', [ids.ready])).rows)
        .toEqual(before);
    });
  });

  describe('employer_stage_recipient', () => {
    it('returns the worker, the newest run\'s language (not the active one) and whether a number is usable', async () => {
      expect(await callAs(RECIPIENT, [applications.ready], { internalUserId: ids.employerA }))
        .toEqual([{ worker_id: ids.ready, language: 'es', has_whatsapp_number: true }]);
    });

    it('applies the stage number rule: NULL falls through to phone, an empty number is no number', async () => {
      const original = (await su.query('SELECT whatsapp_number, phone FROM public.users WHERE id = $1', [ids.onboarding])).rows[0];
      try {
        await su.query('UPDATE public.users SET whatsapp_number = NULL WHERE id = $1', [ids.onboarding]);
        expect((await callAs<{ has_whatsapp_number: boolean }>(RECIPIENT, [applications.onboarding], { internalUserId: ids.employerA }))[0]
          .has_whatsapp_number).toBe(true);
        await su.query(`UPDATE public.users SET whatsapp_number = '' WHERE id = $1`, [ids.onboarding]);
        expect((await callAs<{ has_whatsapp_number: boolean }>(RECIPIENT, [applications.onboarding], { internalUserId: ids.employerA }))[0]
          .has_whatsapp_number).toBe(false);
        await su.query('UPDATE public.users SET whatsapp_number = NULL, phone = NULL WHERE id = $1', [ids.onboarding]);
        expect(await callAs(RECIPIENT, [applications.onboarding], { internalUserId: ids.employerA }))
          .toEqual([{ worker_id: ids.onboarding, language: 'es', has_whatsapp_number: false }]);
      } finally {
        await su.query('UPDATE public.users SET whatsapp_number = $2, phone = $3 WHERE id = $1',
          [ids.onboarding, original.whatsapp_number, original.phone]);
      }
    });

    it('refuses (42501) an application on another employer\'s job and an unset caller, whatever flags are set', async () => {
      expect(await sqlstate(callAs(RECIPIENT, [applications.stranger], { internalUserId: ids.employerA, flagsFor: victimB }))).toBe('42501');
      expect(await sqlstate(callAs(RECIPIENT, [randomUUID()], { internalUserId: ids.employerA }))).toBe('42501');
      expect(await sqlstate(callAs(RECIPIENT, [applications.ready], {}))).toBe('42501');
    });
  });

  describe('employer_claim_worker_intent', () => {
    it('employer_chat to a worker still onboarding: a deferred intent with the derived fields, and no outbox row', async () => {
      const { conversation, message } = await employerMessage(ids.employerA, ids.onboarding, ids.jobA, applications.onboarding);
      const [row] = await callAs<ClaimRow>(CLAIM, [
        ids.onboarding, 'employer_chat', message, { conversationId: randomUUID(), companyName: 'Fixture Co', jobTitle: 'Fixture job' }, null,
      ], { internalUserId: ids.employerA });
      expect(row).toMatchObject({ decision_action: 'defer', decision_reason: 'worker_onboarding', outbox_id: null, outbox_materialized: false });
      expect(await intent(row.intent_id)).toEqual({
        user_id: ids.onboarding, category: 'employer_chat', owner_service: 'job-messaging', source_type: 'job_conversation_message',
        source_id: message, dedupe_key: `employer-chat:${message}`, priority: 40, status: 'deferred', policy_version: 1,
        decision_reason: 'worker_onboarding', outbox_id: null, seven_days: true,
        // The identifying field is taken from the source, never from the caller.
        payload: { conversationId: conversation, companyName: 'Fixture Co', jobTitle: 'Fixture job' },
      });
    });

    it('employer_chat to a suspended worker is rejected', async () => {
      const { message } = await employerMessage(ids.employerA, ids.suspended, ids.jobA, applications.suspended);
      const [row] = await callAs<ClaimRow>(CLAIM, [ids.suspended, 'employer_chat', message, {}, null], { internalUserId: ids.employerA });
      expect(row).toMatchObject({ decision_action: 'reject', decision_reason: 'worker_suspended', outbox_materialized: false });
      expect(await intent(row.intent_id)).toMatchObject({ status: 'rejected', decision_reason: 'worker_suspended' });
    });

    it('application_stage to a ready worker with delivery on: one outbox row to the worker\'s own number, once', async () => {
      await setDeferredDelivery(true);
      try {
        const { updated_at: updatedAt } = await setApplicationStatus(applications.ready, 'details_requested');
        const payload = { kind: 'forged', status: 'hired', applicationId: randomUUID(), jobId: randomUUID(), jobTitle: 'Fixture job' };
        const [row] = await callAs<ClaimRow>(CLAIM, [ids.ready, 'application_stage', applications.ready, payload, TEMPLATE],
          { internalUserId: ids.employerA });
        expect(row).toMatchObject({ decision_action: 'allow', decision_reason: 'worker_ready', outbox_materialized: true });
        const stored = await intent(row.intent_id);
        expect(stored).toMatchObject({
          category: 'account', owner_service: 'account', source_type: 'application_stage', priority: 30, status: 'eligible',
          outbox_id: row.outbox_id,
          dedupe_key: `application-stage:${applications.ready}:details_requested:${updatedAt.getTime()}`,
          payload: { kind: 'application_stage', status: 'details_requested', applicationId: applications.ready, jobId: ids.jobA, jobTitle: 'Fixture job' },
        });
        const { rows: outbox } = await su.query(
          `SELECT o.whatsapp_number, o.body, o.content_template, o.content_variables, o.source_type, o.source_id, o.sequence,
                  o.inbound_message_sid, o.status, u.whatsapp_number AS own_number
             FROM public.whatsapp_outbox o, public.users u WHERE o.id = $1 AND u.id = $2`,
          [row.outbox_id, ids.ready],
        );
        expect(outbox).toEqual([expect.objectContaining({
          body: null, content_template: TEMPLATE.content_template, content_variables: TEMPLATE.content_variables,
          source_type: 'worker_intent', source_id: row.intent_id, sequence: 1, inbound_message_sid: null, status: 'pending',
        })]);
        expect(outbox[0].whatsapp_number).toBe(outbox[0].own_number);

        // A repeat in the same state finds the same intent and never inserts a second row.
        const [again] = await callAs<ClaimRow>(CLAIM, [ids.ready, 'application_stage', applications.ready, payload, TEMPLATE],
          { internalUserId: ids.employerA });
        expect(again).toEqual({ ...row, outbox_materialized: false });
        expect((await su.query('SELECT count(*)::int AS n FROM public.whatsapp_outbox WHERE source_id = $1', [row.intent_id])).rows)
          .toEqual([{ n: 1 }]);
      } finally {
        await setDeferredDelivery(false);
      }
    });

    it('application_stage to a ready worker with delivery off is deferred (delivery_disabled)', async () => {
      await setApplicationStatus(applications.ready, 'hired');
      const [row] = await callAs<ClaimRow>(CLAIM, [ids.ready, 'application_stage', applications.ready, {}, TEMPLATE],
        { internalUserId: ids.employerA });
      expect(row).toMatchObject({ decision_action: 'defer', decision_reason: 'delivery_disabled', outbox_id: null, outbox_materialized: false });
    });

    it('an allowed delivery with no message, or no usable number, is rejected as renderer_unavailable; a repeat answers invalid_owner', async () => {
      await setDeferredDelivery(true);
      const original = (await su.query('SELECT whatsapp_number FROM public.users WHERE id = $1', [ids.ready])).rows[0].whatsapp_number;
      try {
        await setApplicationStatus(applications.ready, 'details_requested');
        const [noMessage] = await callAs<ClaimRow>(CLAIM, [ids.ready, 'application_stage', applications.ready, {}, null],
          { internalUserId: ids.employerA });
        expect(noMessage).toEqual({
          intent_id: expect.any(String), decision_action: 'reject', decision_reason: 'renderer_unavailable', outbox_id: null, outbox_materialized: false,
        });
        expect(await intent(noMessage.intent_id)).toMatchObject({ status: 'rejected', decision_reason: 'renderer_unavailable', outbox_id: null });
        const [repeat] = await callAs<ClaimRow>(CLAIM, [ids.ready, 'application_stage', applications.ready, {}, TEMPLATE],
          { internalUserId: ids.employerA });
        expect(repeat).toEqual({ ...noMessage, decision_reason: 'invalid_owner' });

        await su.query(`UPDATE public.users SET whatsapp_number = '' WHERE id = $1`, [ids.ready]);
        await setApplicationStatus(applications.ready, 'hired');
        const [noNumber] = await callAs<ClaimRow>(CLAIM, [ids.ready, 'application_stage', applications.ready, {}, TEMPLATE],
          { internalUserId: ids.employerA });
        expect(noNumber).toMatchObject({ decision_action: 'reject', decision_reason: 'renderer_unavailable', outbox_id: null });
      } finally {
        await su.query('UPDATE public.users SET whatsapp_number = $2 WHERE id = $1', [ids.ready, original]);
        await setDeferredDelivery(false);
      }
    });

    it('maps an existing terminal intent the way the gateway does, with no new outbox row', async () => {
      const { message } = await employerMessage(ids.employerA, ids.ready, ids.jobA, applications.ready);
      const outboxId = randomUUID();
      await su.query(
        `INSERT INTO public.whatsapp_outbox (id, sequence, whatsapp_number, body, source_type, source_id)
         VALUES ($1, 1, '+15550000000', 'Delivered fixture', 'worker_intent', $2)`,
        [outboxId, randomUUID()],
      );
      await su.query(
        `INSERT INTO public.worker_message_intents (user_id, category, owner_service, source_type, source_id, dedupe_key, priority, status, policy_version, outbox_id)
         VALUES ($1, 'employer_chat', 'job-messaging', 'job_conversation_message', $2, $3, 40, 'delivered', 1, $4)`,
        [ids.ready, message, `employer-chat:${message}`, outboxId],
      );
      const [row] = await callAs<ClaimRow>(CLAIM, [ids.ready, 'employer_chat', message, {}, { body: 'Hello' }], { internalUserId: ids.employerA });
      expect(row).toMatchObject({ decision_action: 'allow', decision_reason: 'worker_ready', outbox_id: outboxId, outbox_materialized: false });
      await su.query(`UPDATE public.worker_message_intents SET status = 'expired' WHERE dedupe_key = $1`, [`employer-chat:${message}`]);
      const [expired] = await callAs<ClaimRow>(CLAIM, [ids.ready, 'employer_chat', message, {}, null], { internalUserId: ids.employerA });
      expect(expired).toMatchObject({ decision_action: 'expire', decision_reason: 'intent_expired', outbox_materialized: false });
      expect((await su.query('SELECT count(*)::int AS n FROM public.whatsapp_outbox WHERE source_id = $1', [row.intent_id])).rows)
        .toEqual([{ n: 0 }]);
    });

    it('refuses another employer\'s source, a worker who is not the source\'s, a worker\'s own message and an unset caller, writing nothing', async () => {
      const foreign = await employerMessage(ids.employerB, ids.stranger, ids.jobB, applications.stranger);
      const own = await employerMessage(ids.employerA, ids.ready, ids.jobA, applications.ready, 'worker');
      const mine = await employerMessage(ids.employerA, ids.ready, ids.jobA, applications.ready);
      await setApplicationStatus(applications.stranger, 'hired');
      const before = (await su.query('SELECT count(*)::int AS n FROM public.worker_message_intents WHERE user_id = ANY($1::uuid[])',
        [[ids.ready, ids.stranger]])).rows[0].n;
      const asA = { internalUserId: ids.employerA, flagsFor: victimB };
      expect(await sqlstate(callAs(CLAIM, [ids.stranger, 'employer_chat', foreign.message, {}, null], asA))).toBe('42501');
      expect(await sqlstate(callAs(CLAIM, [ids.stranger, 'application_stage', applications.stranger, {}, TEMPLATE], asA))).toBe('42501');
      expect(await sqlstate(callAs(CLAIM, [ids.suspended, 'employer_chat', mine.message, {}, null], asA))).toBe('42501');
      expect(await sqlstate(callAs(CLAIM, [ids.ready, 'employer_chat', own.message, {}, null], asA))).toBe('42501');
      expect(await sqlstate(callAs(CLAIM, [ids.ready, 'employer_chat', mine.message, {}, null], { flagsFor: victimB }))).toBe('42501');
      expect((await su.query('SELECT count(*)::int AS n FROM public.worker_message_intents WHERE user_id = ANY($1::uuid[])',
        [[ids.ready, ids.stranger]])).rows[0].n).toBe(before);
    });

    it('refuses (42501) the caller\'s own conversation with a worker who is not its applicant, by its own check', async () => {
      // A conversation that names a worker the employer has no application
      // from -- the conversation guard refuses to create one -- written past
      // the triggers, as an older, unvalidated row could be.
      const conversation = randomUUID();
      const message = randomUUID();
      await su.query('BEGIN');
      try {
        await su.query(`SET LOCAL session_replication_role = replica`);
        await su.query(
          `INSERT INTO public.job_conversations (id, job_id, employer_id, worker_id, application_id, status)
           VALUES ($1, $2, $3, $4, $5, 'open')`,
          [conversation, ids.jobA, ids.employerA, ids.stranger, applications.ready],
        );
        await su.query(
          `INSERT INTO public.job_conversation_messages (id, conversation_id, sender_type, direction, body, status)
           VALUES ($1, $2, 'employer', 'outbound', 'Fixture message', 'waiting_worker_reply')`,
          [message, conversation],
        );
        await su.query('COMMIT');
      } catch (err) {
        await su.query('ROLLBACK');
        throw err;
      }
      const claim = () => errorOf(callAs(CLAIM, [ids.stranger, 'employer_chat', message, {}, { body: 'Hello' }], { internalUserId: ids.employerA }));
      try {
        expect(await claim()).toEqual({ code: '42501', message: expect.stringMatching(/not one of the caller's applicants/) });
        // The same refusal with the owner's own row security switched off:
        // the function does not depend on its policies.
        await su.query('ALTER ROLE jale_cap_worker_lane BYPASSRLS');
        try {
          expect(await claim()).toEqual({ code: '42501', message: expect.stringMatching(/not one of the caller's applicants/) });
        } finally {
          await su.query('ALTER ROLE jale_cap_worker_lane NOBYPASSRLS');
        }
        expect((await su.query('SELECT count(*)::int AS n FROM public.worker_message_intents WHERE user_id = $1', [ids.stranger])).rows)
          .toEqual([{ n: 0 }]);
      } finally {
        await su.query('DELETE FROM public.job_conversations WHERE id = $1', [conversation]);
      }
    });

    it('raises 22023 for an unknown kind, a status that does not notify, and a malformed message', async () => {
      const { message } = await employerMessage(ids.employerA, ids.onboarding, ids.jobA, applications.onboarding);
      const asA = { internalUserId: ids.employerA };
      expect(await sqlstate(callAs(CLAIM, [ids.onboarding, 'job_alert', message, {}, null], asA))).toBe('22023');
      await setApplicationStatus(applications.onboarding, 'pending');
      expect(await sqlstate(callAs(CLAIM, [ids.onboarding, 'application_stage', applications.onboarding, {}, null], asA))).toBe('22023');
      // Sent as JSON text: node-postgres would turn a bare array into a PostgreSQL array literal.
      for (const bad of [{ body: '' }, { body: 'x', content_template: 't', content_variables: {} }, { content_template: 't' }, ['x']]) {
        expect(await sqlstate(callAs(CLAIM, [ids.onboarding, 'employer_chat', message, '{}', JSON.stringify(bad)], asA))).toBe('22023');
      }
      expect(await sqlstate(callAs(CLAIM, [ids.onboarding, 'employer_chat', message, JSON.stringify(['not an object']), null], asA)))
        .toBe('22023');
    });
  });
});
