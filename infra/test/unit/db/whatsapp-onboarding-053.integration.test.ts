/**
 * whatsapp-onboarding-053.integration.test.ts
 *
 * PostgreSQL-backed gate for migration 053's `bypass_onboarding_for_web_worker`
 * SECURITY DEFINER function, against REAL PostgreSQL 16 with migrations
 * 001-053 applied. Exercises the function exactly as jale_whatsapp would call
 * it -- no mock, no TS wrapper -- and reads back every row it touches through
 * a superuser connection.
 *
 * Set JALE_TEST_DATABASE_URL to a superuser connection string for an
 * isolated, disposable database (see db/local/bootstrap-testbed.sh).
 */
import { randomUUID } from 'node:crypto';
import { Client, type QueryResultRow } from 'pg';

const databaseUrl = process.env.JALE_TEST_DATABASE_URL;

if (!databaseUrl) {
  test('CONCERN: whatsapp-onboarding-053 PostgreSQL gate was not run', () => {
    // eslint-disable-next-line no-console
    console.warn(
      '[whatsapp-onboarding-053] DONE_WITH_CONCERNS: set JALE_TEST_DATABASE_URL to a ' +
        'disposable PostgreSQL 16 database with migrations 001-053 applied to run the ' +
        'real-PostgreSQL web-worker-bypass gate.',
    );
    expect(databaseUrl).toBeUndefined();
  });
}

function maybeDescribe(name: string, fn: () => void): void {
  if (databaseUrl) describe(name, fn);
  else describe.skip(name, fn);
}

const BYPASS_SQL = 'SELECT * FROM public.bypass_onboarding_for_web_worker($1,$2,$3,$4,$5)';

async function asWhatsapp<T extends QueryResultRow = QueryResultRow>(
  sql: string, params: unknown[] = [],
): Promise<{ rows: T[]; rowCount: number | null }> {
  const client = new Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    await client.query('BEGIN');
    await client.query('SET LOCAL ROLE jale_whatsapp');
    const result = await client.query<T>(sql, params);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    await client.end();
  }
}

maybeDescribe('migration 053: web-registered worker bypass', () => {
  const workerWeb = randomUUID();
  const workerNoEmail = randomUUID();
  const workerOwner = randomUUID();
  const workerIntruder = randomUUID();
  const workerGrantProbe = randomUUID();

  const conversationHappy = randomUUID();
  const conversationNoEmail = randomUUID();
  const conversationOwned = randomUUID();

  const phoneHappy = '+15550001301';
  const phoneNoEmail = '+15550001302';
  const phoneOwned = '+15550001303';

  const allWorkerIds = [workerWeb, workerNoEmail, workerOwner, workerIntruder, workerGrantProbe];
  const allConversationIds = [conversationHappy, conversationNoEmail, conversationOwned];

  let setup: Client;

  beforeAll(async () => {
    setup = new Client({ connectionString: databaseUrl });
    await setup.connect();

    await setup.query(
      `INSERT INTO users (id, cognito_sub, user_type, email, tos_accepted_at) VALUES
         ($1, $2, 'worker', 'web-worker-053@example.com', now()),
         ($3, $4, 'worker', NULL, now()),
         ($5, $6, 'worker', 'owner-053@example.com', now()),
         ($7, $8, 'worker', 'intruder-053@example.com', now()),
         ($9, $10, 'worker', 'grant-probe-053@example.com', now())`,
      [
        workerWeb, `v2-053-web-${workerWeb}`,
        workerNoEmail, `v2-053-noemail-${workerNoEmail}`,
        workerOwner, `v2-053-owner-${workerOwner}`,
        workerIntruder, `v2-053-intruder-${workerIntruder}`,
        workerGrantProbe, `v2-053-grantprobe-${workerGrantProbe}`,
      ],
    );

    await setup.query(
      `INSERT INTO whatsapp_conversations (id, user_id, whatsapp_number, conversation_state) VALUES
         ($1, NULL, $2, 'new'),
         ($3, NULL, $4, 'new'),
         ($5, $6, $7, 'new')`,
      [
        conversationHappy, phoneHappy,
        conversationNoEmail, phoneNoEmail,
        conversationOwned, workerOwner, phoneOwned,
      ],
    );
  });

  afterAll(async () => {
    await setup.query(
      'DELETE FROM worker_workflow_transitions WHERE run_id IN (SELECT id FROM worker_workflow_runs WHERE user_id = ANY($1::uuid[]))',
      [allWorkerIds],
    );
    await setup.query('DELETE FROM worker_workflow_runs WHERE user_id = ANY($1::uuid[])', [allWorkerIds]);
    await setup.query('DELETE FROM worker_onboarding_state WHERE user_id = ANY($1::uuid[])', [allWorkerIds]);
    await setup.query('DELETE FROM whatsapp_conversations WHERE id = ANY($1::uuid[])', [allConversationIds]);
    await setup.query('DELETE FROM users WHERE id = ANY($1::uuid[])', [allWorkerIds]);
    await setup.end();
  });

  test('happy path: marks a web-registered worker ready with a completed run at legal.review', async () => {
    const result = await asWhatsapp<{ onboarding_state_id: string; run_id: string }>(BYPASS_SQL, [
      workerWeb, conversationHappy, '1', 'es', 'SM053happy',
    ]);
    expect(result.rows).toHaveLength(1);
    const { onboarding_state_id: stateId, run_id: runId } = result.rows[0];
    expect(stateId).toBeTruthy();
    expect(runId).toBeTruthy();

    const state = await setup.query<{ lifecycle: string; ready_at: Date | null }>(
      'SELECT lifecycle, ready_at FROM worker_onboarding_state WHERE user_id = $1',
      [workerWeb],
    );
    expect(state.rows).toHaveLength(1);
    expect(state.rows[0].lifecycle).toBe('ready');
    expect(state.rows[0].ready_at).not.toBeNull();

    const run = await setup.query<{
      status: string; current_step_key: string; workflow_version: number;
      preferred_language: string; completed_at: Date | null;
    }>(
      `SELECT status, current_step_key, workflow_version, preferred_language, completed_at
         FROM worker_workflow_runs WHERE id = $1`,
      [runId],
    );
    expect(run.rows).toEqual([{
      status: 'completed',
      current_step_key: 'legal.review',
      workflow_version: 1,
      preferred_language: 'es',
      completed_at: expect.any(Date),
    }]);

    const transitions = await setup.query<{ reason: string; to_step_key: string; from_step_key: string | null }>(
      'SELECT reason, to_step_key, from_step_key FROM worker_workflow_transitions WHERE run_id = $1',
      [runId],
    );
    expect(transitions.rows).toEqual([{ reason: 'web_worker_bypass', to_step_key: 'legal.review', from_step_key: null }]);

    const conversation = await setup.query<{ user_id: string }>(
      'SELECT user_id FROM whatsapp_conversations WHERE id = $1',
      [conversationHappy],
    );
    expect(conversation.rows).toEqual([{ user_id: workerWeb }]);

    const user = await setup.query<{ whatsapp_number: string; whatsapp_linked_at: Date | null }>(
      'SELECT whatsapp_number, whatsapp_linked_at FROM users WHERE id = $1',
      [workerWeb],
    );
    expect(user.rows[0].whatsapp_number).toBe(phoneHappy);
    expect(user.rows[0].whatsapp_linked_at).not.toBeNull();
  });

  test('idempotency: a second call for the same worker does not duplicate the run or transition', async () => {
    const second = await asWhatsapp<{ onboarding_state_id: string; run_id: string }>(BYPASS_SQL, [
      workerWeb, conversationHappy, '1', 'es', 'SM053replay',
    ]);
    expect(second.rows).toHaveLength(1);

    const runs = await setup.query('SELECT id FROM worker_workflow_runs WHERE user_id = $1', [workerWeb]);
    expect(runs.rowCount).toBe(1);
    expect(runs.rows[0].id).toBe(second.rows[0].run_id);

    const transitions = await setup.query(
      'SELECT id FROM worker_workflow_transitions WHERE run_id = $1',
      [second.rows[0].run_id],
    );
    expect(transitions.rowCount).toBe(1);
  });

  test('denies a worker with no email even when tos_accepted_at is set', async () => {
    await expect(
      asWhatsapp(BYPASS_SQL, [workerNoEmail, conversationNoEmail, '1', 'es', 'SM053noemail']),
    ).rejects.toMatchObject({ code: '23503' });

    const state = await setup.query('SELECT 1 FROM worker_onboarding_state WHERE user_id = $1', [workerNoEmail]);
    expect(state.rowCount).toBe(0);
    const conversation = await setup.query<{ user_id: string | null }>(
      'SELECT user_id FROM whatsapp_conversations WHERE id = $1',
      [conversationNoEmail],
    );
    expect(conversation.rows).toEqual([{ user_id: null }]);
  });

  test('denies a conversation already bound to a different worker', async () => {
    await expect(
      asWhatsapp(BYPASS_SQL, [workerIntruder, conversationOwned, '1', 'es', 'SM053intruder']),
    ).rejects.toMatchObject({ code: '55000' });

    const state = await setup.query('SELECT 1 FROM worker_onboarding_state WHERE user_id = $1', [workerIntruder]);
    expect(state.rowCount).toBe(0);
    const conversation = await setup.query<{ user_id: string }>(
      'SELECT user_id FROM whatsapp_conversations WHERE id = $1',
      [conversationOwned],
    );
    expect(conversation.rows).toEqual([{ user_id: workerOwner }]);
  });

  test('grant probes: jale_whatsapp may execute the definer and read users.email, but never broad users SELECT or a direct onboarding_state INSERT', async () => {
    const privs = await setup.query<{
      can_execute: boolean; can_select_email: boolean; broad_users_select: boolean;
    }>(
      `SELECT
         has_function_privilege(
           'jale_whatsapp',
           'public.bypass_onboarding_for_web_worker(uuid,uuid,text,text,text)',
           'EXECUTE'
         ) AS can_execute,
         has_column_privilege('jale_whatsapp', 'public.users', 'email', 'SELECT') AS can_select_email,
         has_table_privilege('jale_whatsapp', 'public.users', 'SELECT') AS broad_users_select`,
    );
    expect(privs.rows[0]).toEqual({
      can_execute: true,
      can_select_email: true,
      broad_users_select: false,
    });

    // A direct INSERT (bypassing the definer entirely) with no established
    // RLS context for this brand-new worker must be rejected -- this is
    // precisely why the SECURITY DEFINER entry point above is necessary.
    const client = new Client({ connectionString: databaseUrl });
    await client.connect();
    try {
      await client.query('BEGIN');
      await client.query('SET LOCAL ROLE jale_whatsapp');
      await expect(
        client.query(
          `INSERT INTO worker_onboarding_state (user_id, lifecycle) VALUES ($1, 'ready')`,
          [workerGrantProbe],
        ),
      ).rejects.toMatchObject({ code: '42501' });
    } finally {
      await client.query('ROLLBACK').catch(() => undefined);
      await client.end();
    }

    const state = await setup.query('SELECT 1 FROM worker_onboarding_state WHERE user_id = $1', [workerGrantProbe]);
    expect(state.rowCount).toBe(0);
  });
});
