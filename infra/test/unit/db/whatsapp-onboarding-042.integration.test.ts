import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { Client, type QueryResultRow } from 'pg';

const databaseUrl = process.env.JALE_TEST_DATABASE_URL;
if (!databaseUrl) {
  test('CONCERN: migration 042 PostgreSQL gate was not run', () => {
    console.warn('[whatsapp-onboarding-042] DONE_WITH_CONCERNS: set JALE_TEST_DATABASE_URL to a disposable PostgreSQL 16 database.');
    expect(databaseUrl).toBeUndefined();
  });
}
const maybeDescribe = databaseUrl ? describe : describe.skip;

async function applyLocalRlsRecursionWorkaround(client: Client): Promise<void> {
  await client.query(`
    CREATE OR REPLACE FUNCTION employer_has_applicant_relationship(
      p_employer_internal_id text,
      p_worker_id uuid
    ) RETURNS boolean
    LANGUAGE sql
    STABLE
    SECURITY DEFINER
    SET search_path = public
    AS $fn$
      SELECT EXISTS (
        SELECT 1
          FROM job_applications ja
          JOIN jobs j ON j.id = ja.job_id
         WHERE ja.worker_id = p_worker_id
           AND j.employer_id::text = p_employer_internal_id
      );
    $fn$;
  `);
  await client.query('DROP POLICY IF EXISTS users_employer_applicant_read ON users');
  await client.query(`CREATE POLICY users_employer_applicant_read ON users FOR SELECT TO jale_admin
    USING (user_type = 'worker' AND employer_has_applicant_relationship(
      current_setting('app.current_internal_user_id', true), id))`);
}

async function asWhatsapp<T extends QueryResultRow = QueryResultRow>(
  sql: string, params: unknown[] = [], userId?: string,
): Promise<{ rows: T[]; rowCount: number | null }> {
  const client = new Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    await client.query('BEGIN');
    await client.query('SET LOCAL ROLE jale_whatsapp');
    if (userId) await client.query(`SELECT set_config('app.current_internal_user_id', $1, true)`, [userId]);
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

maybeDescribe('migration 042 WhatsApp onboarding gate', () => {
  const workerA = randomUUID();
  const workerB = randomUUID();
  const sourceA = randomUUID();
  const sourceB = randomUUID();
  const conversationA = randomUUID();
  const conversationB = randomUUID();
  const conflictingConversation = randomUUID();
  const hashA = 'a'.repeat(64);
  const hashB = 'b'.repeat(64);
  const lockedHash = 'c'.repeat(64);
  const expiredHash = 'd'.repeat(64);
  let setup: Client;

  beforeAll(async () => {
    setup = new Client({ connectionString: databaseUrl });
    await setup.connect();
    await applyLocalRlsRecursionWorkaround(setup);
    await setup.query(`INSERT INTO users (id, cognito_sub, user_type) VALUES
      ($1, $2, 'worker'), ($3, $4, 'worker')`,
    [workerA, `v2-a-${workerA}`, workerB, `v2-b-${workerB}`]);
    await setup.query(`INSERT INTO whatsapp_conversations
      (id, user_id, whatsapp_number, conversation_state) VALUES
      ($1, NULL, '+15550000421', 'awaiting_otp'),
      ($2, NULL, '+15550000422', 'awaiting_otp'),
      ($3, NULL, '+15550000423', 'awaiting_otp')`,
    [conversationA, conversationB, conflictingConversation]);
  });

  afterAll(async () => {
    await setup.query('DELETE FROM worker_domain_outbox WHERE aggregate_id = ANY($1::uuid[])', [[workerA, workerB]]);
    await setup.query('DELETE FROM worker_identity_challenges WHERE phone_hash = ANY($1::text[])', [[hashA, hashB, lockedHash, expiredHash]]);
    await setup.query('DELETE FROM whatsapp_conversations WHERE id = ANY($1::uuid[])', [[conversationA, conversationB, conflictingConversation]]);
    await setup.query('DELETE FROM users WHERE id = ANY($1::uuid[])', [[workerA, workerB]]);
    await setup.end();
  });

  test('baseline contains all eight migration 042 tables', async () => {
    const tables = await setup.query<{ table_name: string }>(`
      SELECT table_name FROM information_schema.tables
      WHERE table_schema = 'public' AND table_name = ANY($1::text[])
    `, [[
      'worker_onboarding_state', 'worker_workflow_runs', 'worker_workflow_transitions',
      'worker_identity_challenges', 'worker_message_intents', 'worker_domain_outbox',
      'whatsapp_runtime_controls', 'worker_reset_audit',
    ]]);
    expect(tables.rows).toHaveLength(8);
  });

  test('enforces active workflow, intent, and event uniqueness', async () => {
    await setup.query(`INSERT INTO worker_workflow_runs
      (user_id, workflow_version, current_step_key) VALUES ($1, 2, 'legal.review')`, [workerA]);
    await expect(setup.query(`INSERT INTO worker_workflow_runs
      (user_id, workflow_version, current_step_key) VALUES ($1, 2, 'profile.name')`, [workerA]))
      .rejects.toMatchObject({ code: '23505', constraint: 'worker_workflow_one_active' });
    await setup.query(`UPDATE worker_workflow_runs
      SET status = 'completed', completed_at = now() WHERE user_id = $1 AND status = 'active'`, [workerA]);

    await setup.query(`INSERT INTO worker_message_intents
      (user_id, category, owner_service, source_type, source_id, dedupe_key, priority, policy_version)
      VALUES ($1, 'job_alert', 'job-alert', 'job', $2, 'dedupe-042', 10, 1)`, [workerA, sourceA]);
    await expect(setup.query(`INSERT INTO worker_message_intents
      (user_id, category, owner_service, source_type, source_id, dedupe_key, priority, policy_version)
      VALUES ($1, 'job_alert', 'job-alert', 'job', $2, 'dedupe-042', 10, 1)`, [workerB, sourceB]))
      .rejects.toMatchObject({ code: '23505', constraint: 'worker_message_intent_dedupe' });

    await setup.query(`INSERT INTO worker_domain_outbox (event_type, aggregate_id, event_key)
      VALUES ('assessment.requested', $1, 'event-042')`, [workerA]);
    await expect(setup.query(`INSERT INTO worker_domain_outbox (event_type, aggregate_id, event_key)
      VALUES ('worker.ready', $1, 'event-042')`, [workerB]))
      .rejects.toMatchObject({ code: '23505', constraint: 'worker_domain_outbox_event_key' });
  });

  test('pre-auth cannot mark a challenge verified and bind rejects locked or expired challenges', async () => {
    await expect(asWhatsapp('SELECT * FROM public.save_worker_pre_auth($1, $2::jsonb)', [lockedHash,
      JSON.stringify({ status: 'verified' })])).rejects.toMatchObject({ code: '22023' });

    await asWhatsapp('SELECT * FROM public.save_worker_pre_auth($1, $2::jsonb)', [lockedHash,
      JSON.stringify({
        provider_challenge_id: 'locked-provider',
        current_step_key: 'identity.verify_otp',
        status: 'locked',
        expires_at: new Date(Date.now() + 60_000).toISOString(),
        locked_until: new Date(Date.now() + 60_000).toISOString(),
      })]);
    await expect(asWhatsapp('SELECT * FROM public.save_worker_pre_auth($1, $2::jsonb)', [lockedHash,
      JSON.stringify({ status: 'pending', locked_until: '' })]))
      .rejects.toMatchObject({ code: '22023' });
    await expect(asWhatsapp(
      'SELECT * FROM public.bind_verified_identity_and_start_workflow($1,$2,$3,2,$4,$5,$6::jsonb)',
      [lockedHash, workerA, conflictingConversation, 'en', 'SMlocked', '{}'],
    )).rejects.toMatchObject({ code: '55000' });

    await asWhatsapp('SELECT * FROM public.save_worker_pre_auth($1, $2::jsonb)', [expiredHash,
      JSON.stringify({
        provider_challenge_id: 'expired-provider',
        current_step_key: 'identity.verify_otp',
        status: 'pending',
        expires_at: new Date(Date.now() - 60_000).toISOString(),
      })]);
    await expect(asWhatsapp(
      'SELECT * FROM public.bind_verified_identity_and_start_workflow($1,$2,$3,2,$4,$5,$6::jsonb)',
      [expiredHash, workerA, conflictingConversation, 'en', 'SMexpired', '{}'],
    )).rejects.toMatchObject({ code: '55000' });
  });

  test('verified binding is positive, sequentially and concurrently replay-safe, and rejects conflicts', async () => {
    await asWhatsapp('SELECT * FROM public.save_worker_pre_auth($1, $2::jsonb)', [hashA,
      JSON.stringify({
        provider_challenge_id: 'provider-a', current_step_key: 'identity.verify_otp',
        expires_at: new Date(Date.now() + 300_000).toISOString(),
      })]);
    const argsA = [hashA, workerA, conversationA, 'en', 'SMbind-a', '{}'];
    const sql = 'SELECT * FROM public.bind_verified_identity_and_start_workflow($1,$2,$3,2,$4,$5,$6::jsonb)';
    const first = await asWhatsapp<{ challenge_id: string; onboarding_state_id: string; run_id: string }>(sql, argsA);
    expect(first.rows).toHaveLength(1);
    expect((await asWhatsapp(sql, argsA)).rows).toEqual(first.rows);
    const concurrent = await Promise.all([asWhatsapp(sql, argsA), asWhatsapp(sql, argsA)]);
    expect(concurrent[0].rows).toEqual(first.rows);
    expect(concurrent[1].rows).toEqual(first.rows);
    await setup.query(`UPDATE worker_workflow_runs SET status = 'completed', completed_at = now()
      WHERE id = $1`, [first.rows[0].run_id]);
    await setup.query(`INSERT INTO worker_workflow_runs
      (user_id, workflow_version, current_step_key, status, preferred_language)
      VALUES ($1, 3, 'profile.name', 'active', 'en')`, [workerA]);
    expect((await asWhatsapp(sql, argsA)).rows).toEqual(first.rows);
    await expect(asWhatsapp(sql, [hashA, workerB, conversationA, 'en', 'SMconflict-user', '{}']))
      .rejects.toMatchObject({ code: '55000' });
    await expect(asWhatsapp(sql, [hashA, workerA, conflictingConversation, 'en', 'SMconflict-conversation', '{}']))
      .rejects.toMatchObject({ code: '55000' });

    await asWhatsapp('SELECT * FROM public.save_worker_pre_auth($1, $2::jsonb)', [hashB,
      JSON.stringify({
        provider_challenge_id: 'provider-b', current_step_key: 'identity.verify_otp',
        expires_at: new Date(Date.now() + 300_000).toISOString(),
      })]);
    const argsB = [hashB, workerB, conversationB, 'es', 'SMbind-b', '{}'];
    const raced = await Promise.all([asWhatsapp(sql, argsB), asWhatsapp(sql, argsB)]);
    expect(raced[0].rows).toEqual(raced[1].rows);
    expect(raced[0].rows).toHaveLength(1);
  });

  test('pre-auth functions expose only one exact validated hash', async () => {
    await asWhatsapp('SELECT * FROM public.save_worker_pre_auth($1, $2::jsonb)', [hashA,
      JSON.stringify({ preferred_language: 'en', current_step_key: 'identity.verify_otp' })]);
    const exact = await asWhatsapp<{ phone_hash: string; preferred_language: string }>(
      'SELECT phone_hash, preferred_language FROM public.load_worker_pre_auth($1)', [hashA]);
    expect(exact.rows).toEqual([{ phone_hash: hashA, preferred_language: 'en' }]);
    expect((await asWhatsapp('SELECT * FROM public.load_worker_pre_auth($1)', [hashB])).rows).toHaveLength(0);
    await expect(asWhatsapp('SELECT * FROM public.load_worker_pre_auth($1)', ['+15551234567']))
      .rejects.toMatchObject({ code: '22023' });

    const directPrivilege = await setup.query<{ allowed: boolean }>(
      "SELECT has_any_column_privilege('jale_whatsapp', 'public.worker_identity_challenges', 'SELECT') AS allowed");
    expect(directPrivilege.rows).toEqual([{ allowed: false }]);
    await expect(asWhatsapp('SELECT id FROM worker_identity_challenges'))
      .rejects.toMatchObject({ code: '42501' });
    await expect(asWhatsapp('INSERT INTO worker_identity_challenges (phone_hash) VALUES ($1)', [hashB]))
      .rejects.toMatchObject({ code: '42501' });
  });

  test('concurrent event leases are disjoint and bounded', async () => {
    for (let index = 0; index < 4; index += 1) {
      await setup.query(`INSERT INTO worker_domain_outbox (event_type, aggregate_id, event_key)
        VALUES ('worker.ready', $1, $2)`, [workerA, `lease-042-${index}`]);
    }
    const one = new Client({ connectionString: databaseUrl });
    const two = new Client({ connectionString: databaseUrl });
    await Promise.all([one.connect(), two.connect()]);
    try {
      await Promise.all([one.query('BEGIN'), two.query('BEGIN')]);
      await Promise.all([one.query('SET LOCAL ROLE jale_whatsapp'), two.query('SET LOCAL ROLE jale_whatsapp')]);
      const first = await one.query<{ event_key: string }>(
        `SELECT event_key FROM public.lease_worker_domain_events('worker.ready', 2)`);
      const second = await two.query<{ event_key: string }>(
        `SELECT event_key FROM public.lease_worker_domain_events('worker.ready', 10)`);
      const keys = [...first.rows, ...second.rows].map((row) => row.event_key);
      expect(first.rows).toHaveLength(2);
      expect(second.rows.length).toBeGreaterThanOrEqual(2);
      expect(new Set(keys).size).toBe(keys.length);
      await Promise.all([one.query('COMMIT'), two.query('COMMIT')]);
    } finally {
      await Promise.all([one.end(), two.end()]);
    }
    await expect(asWhatsapp(`SELECT * FROM public.lease_worker_domain_events('worker.ready', 0)`))
      .rejects.toMatchObject({ code: '22023' });
    await expect(asWhatsapp(`SELECT * FROM public.lease_worker_domain_events('worker.ready', 101)`))
      .rejects.toMatchObject({ code: '22023' });
    await expect(asWhatsapp(`SELECT * FROM public.lease_worker_domain_events(NULL::text, 1)`))
      .rejects.toMatchObject({ code: '22023' });
    await expect(asWhatsapp(`SELECT * FROM public.lease_worker_domain_events('worker.ready', NULL::integer)`))
      .rejects.toMatchObject({ code: '22023' });
    const attempts = await setup.query<{ attempts: number }>(
      `SELECT attempts FROM worker_domain_outbox WHERE event_key LIKE 'lease-042-%' ORDER BY event_key`);
    expect(attempts.rows.every((row) => row.attempts === 0)).toBe(true);
  });

  test('migration 042 executes cleanly a second time as the plain migration owner', async () => {
    const ownerUrl = new URL(databaseUrl!);
    ownerUrl.username = 'jale_admin';
    ownerUrl.password = 'test-admin-pw';
    const owner = new Client({ connectionString: ownerUrl.toString() });
    await owner.connect();
    try {
      const migration = fs.readFileSync(
        path.join(__dirname, '..', '..', '..', 'db', 'migrations', '042_whatsapp_onboarding_gate.sql'),
        'utf8',
      );
      await owner.query(migration);
    } finally {
      await owner.end();
    }
  });

  test('accepts MM callbacks and rejects unknown prefixes', async () => {
    const sid = `MM${randomUUID().replaceAll('-', '')}`;
    await setup.query(`INSERT INTO whatsapp_outbox
      (sequence, whatsapp_number, body, status, content_template, content_variables,
       source_type, source_id, idempotency_key, twilio_message_sid)
      VALUES (1, '+15550000420', NULL, 'sent', 'job_alert_en', '{}'::jsonb,
              'job_alert', $1, $2, $3)`, [sourceA, `mm-042-${sourceA}`, sid]);
    expect((await asWhatsapp<{ matched: boolean; changed: boolean }>(
      `SELECT * FROM jale_twilio_callback.record_whatsapp_delivery_status($1, 'delivered', NULL, NULL)`,
      [sid])).rows).toEqual([{ matched: true, changed: true }]);
    await expect(asWhatsapp(
      `SELECT * FROM jale_twilio_callback.record_whatsapp_delivery_status($1, 'delivered', NULL, NULL)`,
      [`XX${'a'.repeat(32)}`])).rejects.toMatchObject({ code: '22023' });
  });

  test('RLS prevents cross-worker reads and runtime-control writes', async () => {
    await setup.query(`INSERT INTO worker_message_intents
      (user_id, category, owner_service, source_type, source_id, dedupe_key, priority, policy_version)
      VALUES ($1, 'employer_chat', 'job-messaging', 'message', $2, 'worker-b-042', 50, 1)`,
    [workerB, sourceB]);
    expect((await asWhatsapp<{ user_id: string }>(
      'SELECT user_id FROM worker_message_intents ORDER BY user_id', [], workerA)).rows)
      .toEqual([{ user_id: workerA }]);
    await expect(asWhatsapp(`UPDATE whatsapp_runtime_controls SET enabled = true
      WHERE control_key = 'onboarding_v2_enabled'`, [], workerA))
      .rejects.toMatchObject({ code: '42501' });
  });
});
