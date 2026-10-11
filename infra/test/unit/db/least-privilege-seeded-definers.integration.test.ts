/**
 * least-privilege-seeded-definers.integration.test.ts -- the definers the
 * runtime logins rely on, driven with seeded data from those logins.
 *
 * A definer that cannot reach the rows it needs returns nothing, or changes
 * nothing, without raising. These cases seed real rows and call or
 * fire each definer from the login that does so when deployed, then assert
 * the durable effect:
 *   - sync_job_hired_counts (the hired-count trigger, owned by
 *     jale_cap_hired_counts): every status transition, from the request login
 *     (employer and worker) and the WhatsApp login;
 *   - list_stale_job_outbox_workers (stale employer-message discovery, owned
 *     by jale_cap_stale_outbox): discovery, claim, send and complete on the
 *     WhatsApp login, which sets no caller context for discovery;
 *   - retrigger_deferred_ready_workers: one event for a ready worker with a
 *     deferred intent, none on a repeat;
 *   - the 099-101 history capture triggers: one history row for each tracked
 *     change, from every login that writes the tracked tables.
 * The suite runs in every profile, and the outcomes are the same in each.
 *
 * Connection: JALE_TEST_DATABASE_URL (the bed's superuser URL) for fixtures;
 * the logins sign in through helpers/login-pool.
 */
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { Client } from 'pg';
import { loadManifest } from '../../../db/access/access-manifest';
import { withLoginClient } from './helpers/login-pool';

const databaseUrl = process.env.JALE_TEST_DATABASE_URL;
if (!databaseUrl) {
  test('CONCERN: least-privilege seeded definers PostgreSQL gate was not run', () => {
    console.warn('[least-privilege-seeded-definers] JALE_TEST_DATABASE_URL not set; disposable PostgreSQL gate skipped');
    expect(databaseUrl).toBeUndefined();
  });
}
const maybeDescribe = databaseUrl ? describe : describe.skip;

interface Caller {
  /** app.current_user_id (a Cognito sub). */
  sub?: string;
  /** app.current_internal_user_id (a users.id). */
  internalUserId?: string;
}

/** Runs `sql` as `login` in its own transaction with the caller context set transaction-locally, and commits. */
async function runAs<T extends object>(login: string, caller: Caller, sql: string, params: unknown[] = []): Promise<T[]> {
  return withLoginClient(login, async (client) => {
    await client.query('BEGIN');
    try {
      if (caller.sub !== undefined) await client.query(`SELECT set_config('app.current_user_id', $1, true)`, [caller.sub]);
      if (caller.internalUserId !== undefined) {
        await client.query(`SELECT set_config('app.current_internal_user_id', $1, true)`, [caller.internalUserId]);
      }
      const { rows } = await client.query<T>(sql, params);
      await client.query('COMMIT');
      return rows;
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw err;
    }
  });
}

maybeDescribe('seeded definers on the runtime logins', () => {
  let su: Client;
  const stamp = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
  const subs = {
    employer: `lp-sd-employer-${stamp}`,
    workerA: `lp-sd-worker-a-${stamp}`,
    workerB: `lp-sd-worker-b-${stamp}`,
    workerC: `lp-sd-worker-c-${stamp}`,
  };
  const ids: Record<keyof typeof subs, string> = { employer: '', workerA: '', workerB: '', workerC: '' };
  const employer = () => ({ sub: subs.employer, internalUserId: ids.employer });

  async function newJob(needed: number, status = 'active'): Promise<string> {
    return (await su.query<{ id: string }>(
      `INSERT INTO public.jobs (employer_id, title, location, job_type, status, number_of_workers_needed)
       VALUES ($1, 'Least-privilege seeded fixture', 'Austin', 'full-time', $2, $3) RETURNING id`,
      [ids.employer, status, needed],
    )).rows[0].id;
  }

  async function jobCounts(job: string) {
    return (await su.query<{ workers_hired: number; status: string; updated_at: Date }>(
      'SELECT workers_hired, status, updated_at FROM public.jobs WHERE id = $1', [job])).rows[0];
  }

  beforeAll(async () => {
    su = new Client({ connectionString: databaseUrl });
    await su.connect();
    for (const [name, type] of [['employer', 'employer'], ['workerA', 'worker'], ['workerB', 'worker'], ['workerC', 'worker']] as const) {
      ids[name] = (await su.query<{ id: string }>(
        `INSERT INTO public.users (cognito_sub, user_type) VALUES ($1, $2) RETURNING id`, [subs[name], type],
      )).rows[0].id;
    }
  });

  afterAll(async () => {
    if (!su) return;
    const workers = [ids.workerA, ids.workerB, ids.workerC].filter(Boolean);
    await su.query('DELETE FROM public.worker_domain_outbox WHERE aggregate_id = ANY($1::uuid[])', [workers]);
    await su.query('DELETE FROM public.worker_message_intents WHERE user_id = ANY($1::uuid[])', [workers]);
    await su.query('DELETE FROM public.worker_onboarding_state WHERE user_id = ANY($1::uuid[])', [workers]);
    await su.query('DELETE FROM public.jobs WHERE employer_id = $1', [ids.employer]);
    await su.query('DELETE FROM public.users WHERE cognito_sub = ANY($1::text[])', [Object.values(subs)]);
    await su.end();
  });

  describe('sync_job_hired_counts, fired by every writer of job_applications', () => {
    it('is the hired-count trigger, owned by its capability owner', async () => {
      const { rows } = await su.query(
        `SELECT t.tgfoid::regprocedure::text AS fn, pg_catalog.pg_get_userbyid(p.proowner) AS owner
           FROM pg_catalog.pg_trigger t JOIN pg_catalog.pg_proc p ON p.oid = t.tgfoid
          WHERE t.tgrelid = 'public.job_applications'::regclass AND t.tgname = 'job_applications_hired_count_sync'`,
      );
      expect(rows).toEqual([{ fn: 'jale_cap.sync_job_hired_counts()', owner: 'jale_cap_hired_counts' }]);
    });

    it('counts hires and moves filled and active through every transition, from the request and WhatsApp logins', async () => {
      const job = await newJob(2);
      // The workers apply over the request login (worker path): no hire yet.
      const appA = (await runAs<{ id: string }>('jale_api', { sub: subs.workerA },
        'INSERT INTO public.job_applications (job_id, worker_id) VALUES ($1, $2) RETURNING id', [job, ids.workerA]))[0].id;
      const appB = (await runAs<{ id: string }>('jale_api', { sub: subs.workerB },
        'INSERT INTO public.job_applications (job_id, worker_id) VALUES ($1, $2) RETURNING id', [job, ids.workerB]))[0].id;
      // A WhatsApp apply inserts too.
      const appC = (await runAs<{ id: string }>('jale_whatsapp', { internalUserId: ids.workerC },
        'INSERT INTO public.job_applications (job_id, worker_id) VALUES ($1, $2) RETURNING id', [job, ids.workerC]))[0].id;
      expect(await jobCounts(job)).toMatchObject({ workers_hired: 0, status: 'active' });

      const hire = (application: string) => runAs('jale_api', employer(),
        `UPDATE public.job_applications SET status = 'hired', updated_at = now() WHERE id = $1 RETURNING id`, [application]);
      expect(await hire(appA)).toHaveLength(1);
      expect(await jobCounts(job)).toMatchObject({ workers_hired: 1, status: 'active' });
      expect(await hire(appB)).toHaveLength(1);
      expect(await jobCounts(job)).toMatchObject({ workers_hired: 2, status: 'filled' });

      // A worker's WhatsApp reply moves a hired application back to talking:
      // the recount fires from the WhatsApp login and reopens the job.
      const before = (await jobCounts(job)).updated_at;
      expect(await runAs('jale_whatsapp', { internalUserId: ids.workerB },
        `UPDATE public.job_applications SET status = 'talking', updated_at = now() WHERE id = $1 RETURNING id`, [appB])).toHaveLength(1);
      const reopened = await jobCounts(job);
      expect(reopened).toMatchObject({ workers_hired: 1, status: 'active' });
      expect(reopened.updated_at.getTime()).toBeGreaterThan(before.getTime());

      // The employer un-hires; a closed or paused job keeps its status.
      expect(await runAs('jale_api', employer(),
        `UPDATE public.job_applications SET status = 'not_interested', updated_at = now() WHERE id = $1 RETURNING id`, [appA]))
        .toHaveLength(1);
      expect(await jobCounts(job)).toMatchObject({ workers_hired: 0, status: 'active' });
      await su.query(`UPDATE public.jobs SET status = 'paused' WHERE id = $1`, [job]);
      expect(await hire(appC)).toHaveLength(1);
      expect(await jobCounts(job)).toMatchObject({ workers_hired: 1, status: 'paused' });
    });

    it('a WhatsApp write of the status on a job it cannot read still recounts that job', async () => {
      const job = await newJob(1);
      const app = (await su.query<{ id: string }>(
        `INSERT INTO public.job_applications (job_id, worker_id, status) VALUES ($1, $2, 'talking') RETURNING id`, [job, ids.workerA],
      )).rows[0].id;
      await su.query(`UPDATE public.jobs SET workers_hired = 1, status = 'filled' WHERE id = $1`, [job]);
      expect(await runAs('jale_whatsapp', { internalUserId: ids.workerA },
        `UPDATE public.job_applications SET status = 'talking', updated_at = now() WHERE id = $1 RETURNING id`, [app])).toHaveLength(1);
      expect(await jobCounts(job)).toMatchObject({ workers_hired: 0, status: 'active' });
    });
  });

  describe('list_stale_job_outbox_workers, on the WhatsApp login', () => {
    it('discovers a stale worker with no caller context, then claim, send and complete clear it', async () => {
      const job = await newJob(1);
      const app = (await su.query<{ id: string }>(
        `INSERT INTO public.job_applications (job_id, worker_id) VALUES ($1, $2) RETURNING id`, [job, ids.workerA])).rows[0].id;
      const conversation = (await su.query<{ id: string }>(
        `INSERT INTO public.job_conversations (job_id, employer_id, worker_id, application_id, status)
         VALUES ($1, $2, $3, $4, 'open') RETURNING id`, [job, ids.employer, ids.workerA, app])).rows[0].id;
      const outbox = async (status: string, age: string, attempts: number) => (await su.query<{ id: string }>(
        `INSERT INTO public.job_message_outbox (conversation_id, whatsapp_number, send_kind, body, status, sender_key, attempt_count, created_at)
         VALUES ($1, '+15550000000', 'freeform', 'Fixture', $2, 'fixture', $3, now() - $4::interval) RETURNING id`,
        [conversation, status, attempts, age])).rows[0].id;
      const stale = await outbox('pending', '10 minutes', 0);
      await outbox('pending', '1 minute', 0);
      await outbox('failed', '10 minutes', 5);
      await outbox('sent', '10 minutes', 1);

      const discover = async () => (await runAs<{ worker_id: string }>('jale_whatsapp', {},
        `SELECT worker_id FROM list_stale_job_outbox_workers(INTERVAL '5 minutes')`)).map((r) => r.worker_id);
      expect((await discover()).filter((w) => w === ids.workerA)).toEqual([ids.workerA]);

      // Claim and send under the worker's own context, then complete.
      const claimed = await runAs<{ id: string }>('jale_whatsapp', { internalUserId: ids.workerA },
        `SELECT id FROM public.job_message_outbox
          WHERE status IN ('pending', 'failed') AND attempt_count < 5 AND conversation_id = $1
          ORDER BY created_at`, [conversation]);
      expect(claimed.map((r) => r.id)).toContain(stale);
      expect(await runAs('jale_whatsapp', { internalUserId: ids.workerA },
        `UPDATE public.job_message_outbox SET status = 'sent', sent_at = now() WHERE id = $1 RETURNING id`, [stale])).toHaveLength(1);
      expect(await discover()).not.toContain(ids.workerA);
    });

    it('refuses (22023) a minimum age under five minutes, through either name', async () => {
      for (const sql of [
        `SELECT * FROM jale_cap.list_stale_job_outbox_workers(INTERVAL '1 minute')`,
        `SELECT * FROM list_stale_job_outbox_workers(INTERVAL '-100 years')`,
        `SELECT * FROM jale_cap.list_stale_job_outbox_workers(NULL)`,
      ]) {
        let code: string | null = null;
        try {
          await runAs('jale_whatsapp', {}, sql);
        } catch (err) {
          code = (err as { code?: string }).code ?? 'unknown';
        }
        expect([sql, code]).toEqual([sql, '22023']);
      }
      expect(await runAs('jale_whatsapp', {}, `SELECT * FROM list_stale_job_outbox_workers(INTERVAL '5 minutes')`)).toEqual(expect.any(Array));
    });

    it('reads nothing but sendable outbox rows and their conversations', async () => {
      const { rows } = await su.query(
        `SELECT c.relname AS table_name, pol.polname, pg_catalog.pg_get_expr(pol.polqual, pol.polrelid) AS using
           FROM pg_catalog.pg_policy pol JOIN pg_catalog.pg_class c ON c.oid = pol.polrelid
          WHERE (SELECT oid FROM pg_catalog.pg_roles WHERE rolname = 'jale_cap_stale_outbox') = ANY (pol.polroles)
          ORDER BY 1`,
      );
      expect(rows.map((r) => r.table_name)).toEqual(['job_conversations', 'job_message_outbox']);
      for (const row of rows) expect(row.using).toMatch(/'pending'::text, 'failed'::text[\s\S]*attempt_count < 5/);
    });
  });

  describe('retrigger_deferred_ready_workers, on the WhatsApp login', () => {
    it('enqueues one worker.ready event for a ready worker with a deferred intent, and none on a repeat', async () => {
      await su.query(`INSERT INTO public.worker_onboarding_state (user_id, lifecycle) VALUES ($1, 'ready')`, [ids.workerB]);
      await su.query(
        `INSERT INTO public.worker_message_intents (user_id, category, owner_service, source_type, source_id, dedupe_key, priority, status, policy_version)
         VALUES ($1, 'account', 'account', 'application_stage', $2, $3, 30, 'deferred', 1)`,
        [ids.workerB, randomUUID(), `lp-sd-retrigger-${stamp}`],
      );
      const run = `lp-sd-run-${stamp}`;
      const events = async () => (await su.query(
        `SELECT event_type, event_key FROM public.worker_domain_outbox WHERE aggregate_id = $1`, [ids.workerB])).rows;
      await runAs('jale_whatsapp', {}, 'SELECT * FROM public.retrigger_deferred_ready_workers($1, 500)', [run]);
      expect(await events()).toEqual([{ event_type: 'worker.ready', event_key: `worker.ready:sweep:${ids.workerB}:${run}` }]);
      await runAs('jale_whatsapp', {}, 'SELECT * FROM public.retrigger_deferred_ready_workers($1, 500)', [run]);
      expect(await events()).toHaveLength(1);
    });
  });

  describe('the 099-101 history capture triggers, from every writer login', () => {
    const manifest = loadManifest();
    const writers = (table: string) => Object.entries(manifest.tables[table].access)
      .filter(([role, access]) => role in manifest.logins && (access.insert || access.update))
      .map(([role]) => role)
      .sort();

    it('the writers this suite covers are exactly the logins that may write the tracked tables', () => {
      expect(writers('public.job_applications')).toEqual(['jale_api', 'jale_whatsapp']);
      expect(writers('public.subscriptions')).toEqual(['jale_billing']);
      // worker_identity_challenges is closed to every login; its definer writes it.
      expect(writers('public.worker_identity_challenges')).toEqual([]);
      expect(manifest.functions['public.save_worker_pre_auth(text, jsonb)'].execute).toEqual(['jale_whatsapp']);
    });

    it('job_application_status_events: an insert and each status change, from the request and WhatsApp logins', async () => {
      const job = await newJob(3);
      const events = async (application: string) => (await su.query(
        `SELECT from_status, to_status FROM public.job_application_status_events WHERE application_id = $1 ORDER BY changed_at, id`,
        [application])).rows;
      const fromApi = (await runAs<{ id: string }>('jale_api', { sub: subs.workerC },
        'INSERT INTO public.job_applications (job_id, worker_id) VALUES ($1, $2) RETURNING id', [job, ids.workerC]))[0].id;
      await runAs('jale_api', employer(), `UPDATE public.job_applications SET status = 'contacted', updated_at = now() WHERE id = $1`, [fromApi]);
      expect(await events(fromApi)).toEqual([{ from_status: null, to_status: 'pending' }, { from_status: 'pending', to_status: 'contacted' }]);

      const fromWhatsapp = (await runAs<{ id: string }>('jale_whatsapp', { internalUserId: ids.workerB },
        'INSERT INTO public.job_applications (job_id, worker_id) VALUES ($1, $2) RETURNING id', [job, ids.workerB]))[0].id;
      await runAs('jale_whatsapp', { internalUserId: ids.workerB },
        `UPDATE public.job_applications SET status = 'talking', updated_at = now() WHERE id = $1`, [fromWhatsapp]);
      expect(await events(fromWhatsapp)).toEqual([{ from_status: null, to_status: 'pending' }, { from_status: 'pending', to_status: 'talking' }]);
    });

    it('subscription_status_history: an insert and a status change, from the billing login', async () => {
      const plan = (await su.query<{ code: string }>(`SELECT code FROM public.billing_plans ORDER BY code LIMIT 1`)).rows[0].code;
      const subscription = (await runAs<{ id: string }>('jale_billing', {},
        `INSERT INTO public.subscriptions (user_id, plan_code, provider_subscription_id, status)
         VALUES ($1, $2, $3, 'trialing') RETURNING id`, [ids.employer, plan, `lp-sd-sub-${stamp}`]))[0].id;
      await runAs('jale_billing', {}, `UPDATE public.subscriptions SET status = 'active' WHERE id = $1`, [subscription]);
      expect((await su.query(
        `SELECT from_status, to_status FROM public.subscription_status_history WHERE subscription_id = $1 ORDER BY changed_at, id`,
        [subscription])).rows).toEqual([{ from_status: null, to_status: 'trialing' }, { from_status: 'trialing', to_status: 'active' }]);
      await su.query('DELETE FROM public.subscriptions WHERE id = $1', [subscription]);
    });

    it('worker_identity_challenge_events: the challenge definer, called by the WhatsApp login', async () => {
      const phoneHash = createHash('sha256').update(randomBytes(16)).digest('hex');
      const save = (patch: Record<string, unknown>) => runAs<{ id: string }>('jale_whatsapp', {},
        'SELECT * FROM public.save_worker_pre_auth($1, $2::jsonb)', [phoneHash, JSON.stringify(patch)]);
      try {
        const challenge = (await save({ current_step_key: 'identity.verify_otp' }))[0].id;
        await save({ attempts: 1 });
        expect((await su.query(
          `SELECT from_status, to_status, attempts FROM public.worker_identity_challenge_events WHERE challenge_id = $1 ORDER BY changed_at, id`,
          [challenge])).rows).toEqual([
          { from_status: null, to_status: 'pending', attempts: 0 },
          { from_status: 'pending', to_status: 'pending', attempts: 1 },
        ]);
      } finally {
        await su.query('DELETE FROM public.worker_identity_challenges WHERE phone_hash = $1', [phoneHash]);
      }
    });
  });
});
