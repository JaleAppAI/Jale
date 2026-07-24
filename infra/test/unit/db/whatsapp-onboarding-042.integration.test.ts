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
  const workerRebind = randomUUID();
  const sourceA = randomUUID();
  const sourceB = randomUUID();
  const conversationA = randomUUID();
  const conversationB = randomUUID();
  const conflictingConversation = randomUUID();
  const rebindConversation = randomUUID();
  const hashA = 'a'.repeat(64);
  const hashB = 'b'.repeat(64);
  const lockedHash = 'c'.repeat(64);
  const expiredHash = 'd'.repeat(64);
  const rebindHash = 'e'.repeat(64);
  let setup: Client;

  beforeAll(async () => {
    setup = new Client({ connectionString: databaseUrl });
    await setup.connect();
    await applyLocalRlsRecursionWorkaround(setup);
    await setup.query(`INSERT INTO users (id, cognito_sub, user_type) VALUES
      ($1, $2, 'worker'), ($3, $4, 'worker'), ($5, $6, 'worker')`,
    [
      workerA, `v2-a-${workerA}`,
      workerB, `v2-b-${workerB}`,
      workerRebind, `v2-rebind-${workerRebind}`,
    ]);
    await setup.query(`INSERT INTO whatsapp_conversations
      (id, user_id, whatsapp_number, conversation_state) VALUES
      ($1, NULL, '+15550000421', 'awaiting_otp'),
      ($2, NULL, '+15550000422', 'awaiting_otp'),
      ($3, NULL, '+15550000423', 'awaiting_otp'),
      ($4, NULL, '+15550000424', 'awaiting_otp')`,
    [conversationA, conversationB, conflictingConversation, rebindConversation]);
  });

  afterAll(async () => {
    await setup.query('DELETE FROM worker_domain_outbox WHERE aggregate_id = ANY($1::uuid[])', [[workerA, workerB, workerRebind]]);
    await setup.query('DELETE FROM worker_reset_audit WHERE user_id = ANY($1::uuid[])', [[workerA, workerB, workerRebind]]);
    await setup.query('DELETE FROM worker_identity_challenges WHERE phone_hash = ANY($1::text[])', [[hashA, hashB, lockedHash, expiredHash, rebindHash]]);
    await setup.query('DELETE FROM whatsapp_conversations WHERE id = ANY($1::uuid[])', [[conversationA, conversationB, conflictingConversation, rebindConversation]]);
    await setup.query('DELETE FROM users WHERE id = ANY($1::uuid[])', [[workerA, workerB, workerRebind]]);
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

  test('verified binding reuses an existing active workflow run', async () => {
    const existingRun = randomUUID();
    await setup.query(`INSERT INTO worker_onboarding_state (user_id, lifecycle)
      VALUES ($1, 'onboarding')`, [workerRebind]);
    await setup.query(`INSERT INTO worker_workflow_runs
      (id, user_id, workflow_version, current_step_key, status, preferred_language)
      VALUES ($1, $2, 2, 'profile.trade', 'active', 'es')`,
    [existingRun, workerRebind]);
    await asWhatsapp('SELECT * FROM public.save_worker_pre_auth($1, $2::jsonb)', [rebindHash,
      JSON.stringify({
        provider_challenge_id: 'provider-rebind',
        current_step_key: 'identity.verify_otp',
        expires_at: new Date(Date.now() + 300_000).toISOString(),
      })]);

    const result = await asWhatsapp<{ challenge_id: string; onboarding_state_id: string; run_id: string }>(
      'SELECT * FROM public.bind_verified_identity_and_start_workflow($1,$2,$3,2,$4,$5,$6::jsonb)',
      [rebindHash, workerRebind, rebindConversation, 'en', 'SMrebind', '{}'],
    );

    expect(result.rows).toHaveLength(1);
    expect(result.rows[0].run_id).toBe(existingRun);
    const activeRuns = await setup.query<{ id: string; current_step_key: string; preferred_language: string }>(
      `SELECT id, current_step_key, preferred_language
         FROM worker_workflow_runs
        WHERE user_id = $1 AND status = 'active'`,
      [workerRebind],
    );
    expect(activeRuns.rows).toEqual([{
      id: existingRun,
      current_step_key: 'profile.trade',
      preferred_language: 'es',
    }]);
    const conversation = await setup.query<{ user_id: string }>(
      'SELECT user_id FROM whatsapp_conversations WHERE id = $1',
      [rebindConversation],
    );
    expect(conversation.rows).toEqual([{ user_id: workerRebind }]);
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

  test('expired domain-event leases are reclaimed with a new token while fresh and stale owners are fenced', async () => {
    const eventKey = `lease-recovery-042-${randomUUID()}`;
    await setup.query(`INSERT INTO worker_domain_outbox (event_type, aggregate_id, event_key)
      VALUES ('worker.ready', $1, $2)`, [workerA, eventKey]);
    const first = await asWhatsapp<{ event_key: string; lease_token: string; leased_until: Date; attempts: number }>(
      `SELECT event_key, lease_token, leased_until, attempts FROM public.lease_worker_domain_events('worker.ready', 1)`);
    expect(first.rows).toHaveLength(1);
    expect(first.rows[0].event_key).toBe(eventKey);
    expect(first.rows[0].lease_token).toMatch(/^[0-9a-f-]{36}$/);
    expect(new Date(first.rows[0].leased_until).getTime()).toBeGreaterThan(Date.now() + 60_000);
    expect(first.rows[0].attempts).toBe(0);
    expect((await asWhatsapp(`SELECT event_key FROM public.lease_worker_domain_events('worker.ready', 1)`)).rows).toHaveLength(0);
    await setup.query(`UPDATE worker_domain_outbox SET leased_until = now() - interval '1 second' WHERE event_key = $1`, [eventKey]);
    const reclaimed = await asWhatsapp<{ event_key: string; lease_token: string; attempts: number }>(
      `SELECT event_key, lease_token, attempts FROM public.lease_worker_domain_events('worker.ready', 1)`);
    expect(reclaimed.rows).toHaveLength(1);
    expect(reclaimed.rows[0].event_key).toBe(eventKey);
    expect(reclaimed.rows[0].lease_token).not.toBe(first.rows[0].lease_token);
    expect(reclaimed.rows[0].attempts).toBe(1);
    const staleOwner = await asWhatsapp(
      `UPDATE worker_domain_outbox SET status='completed', leased_until=NULL, lease_token=NULL
        WHERE event_key=$1 AND status='processing' AND lease_token=$2`,
      [eventKey, first.rows[0].lease_token], workerA);
    expect(staleOwner.rowCount).toBe(0);
    const currentOwner = await asWhatsapp(
      `UPDATE worker_domain_outbox SET status='completed', leased_until=NULL, lease_token=NULL
        WHERE event_key=$1 AND status='processing' AND lease_token=$2`,
      [eventKey, reclaimed.rows[0].lease_token], workerA);
    expect(currentOwner.rowCount).toBe(1);
  });

  test('an expired processing event reaches the retry cap instead of being leased forever', async () => {
    const eventKey = `lease-cap-042-${randomUUID()}`;
    await setup.query(`INSERT INTO worker_domain_outbox
      (event_type, aggregate_id, event_key, status, attempts, leased_until, lease_token)
      VALUES ('worker.ready', $1, $2, 'processing', 4, now() - interval '1 second', gen_random_uuid())`,
    [workerA, eventKey]);
    expect((await asWhatsapp(
      `SELECT event_key FROM public.lease_worker_domain_events('worker.ready', 1)`)).rows).toHaveLength(0);
    const terminal = await setup.query<{
      status: string; attempts: number; leased_until: Date | null; lease_token: string | null;
    }>(`SELECT status, attempts, leased_until, lease_token FROM worker_domain_outbox WHERE event_key=$1`, [eventKey]);
    expect(terminal.rows).toEqual([{ status: 'failed', attempts: 5, leased_until: null, lease_token: null }]);
  });

  test('reset audit has narrow admin read/insert policies while WhatsApp remains worker-scoped read-only', async () => {
    const auditId = randomUUID();
    await setup.query('BEGIN');
    try {
      await setup.query('SET LOCAL ROLE jale_admin');
      await setup.query(`INSERT INTO worker_reset_audit
        (id, user_id, phone_hash, operator, reason, dry_run)
        VALUES ($1, $2, $3, 'c9-test', 'policy regression', true)`, [auditId, workerA, hashA]);
      expect((await setup.query<{ id: string }>(
        'SELECT id FROM worker_reset_audit WHERE id=$1', [auditId])).rows).toEqual([{ id: auditId }]);
      await setup.query('COMMIT');
    } catch (error) {
      await setup.query('ROLLBACK');
      throw error;
    }
    expect((await asWhatsapp<{ id: string }>(
      'SELECT id FROM worker_reset_audit WHERE id=$1', [auditId], workerA)).rows).toEqual([{ id: auditId }]);
    expect((await asWhatsapp<{ id: string }>(
      'SELECT id FROM worker_reset_audit WHERE id=$1', [auditId], workerB)).rows).toHaveLength(0);
    await expect(asWhatsapp(
      `INSERT INTO worker_reset_audit (user_id, phone_hash, operator, reason, dry_run)
       VALUES ($1, $2, 'whatsapp', 'must fail', true)`, [workerA, hashA], workerA))
      .rejects.toMatchObject({ code: '42501' });
    const policies = await setup.query<{ policyname: string; cmd: string }>(
      `SELECT policyname, cmd FROM pg_policies
        WHERE schemaname='public' AND tablename='worker_reset_audit' ORDER BY policyname`);
    expect(policies.rows).toEqual(expect.arrayContaining([
      { policyname: 'worker_reset_audit_admin_insert', cmd: 'INSERT' },
      { policyname: 'worker_reset_audit_admin_read', cmd: 'SELECT' },
      { policyname: 'worker_reset_audit_worker', cmd: 'SELECT' },
    ]));
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

  test('job-alert readiness exposes only the ready boolean across forced RLS', async () => {
    await setup.query(`INSERT INTO worker_onboarding_state (user_id, lifecycle, ready_at)
      VALUES ($1, 'ready', now()), ($2, 'onboarding', NULL)
      ON CONFLICT (user_id) DO UPDATE SET
        lifecycle = EXCLUDED.lifecycle,
        ready_at = EXCLUDED.ready_at`, [workerA, workerB]);

    const readiness = await asWhatsapp<{ ready_a: boolean; ready_b: boolean }>(
      `SELECT public.is_worker_ready_for_v2_delivery($1) AS ready_a,
              public.is_worker_ready_for_v2_delivery($2) AS ready_b`,
      [workerA, workerB],
    );
    expect(readiness.rows).toEqual([{ ready_a: true, ready_b: false }]);
    expect((await asWhatsapp(
      'SELECT user_id FROM worker_onboarding_state WHERE user_id = $1', [workerA], workerB,
    )).rows).toHaveLength(0);
  });

  test('producer contexts insert worker intents and restore employer scope under forced RLS', async () => {
    const jobSource = randomUUID();
    const chatSource = randomUUID();
    const client = new Client({ connectionString: databaseUrl });
    await client.connect();
    try {
      await client.query('BEGIN');
      await client.query('SET LOCAL ROLE jale_whatsapp');
      await client.query(`SELECT set_config('app.current_internal_user_id', $1, true)`, [workerA]);
      await client.query(`INSERT INTO worker_message_intents
        (user_id, category, owner_service, source_type, source_id, dedupe_key, priority, policy_version)
        VALUES ($1, 'job_alert', 'job-alert', 'job', $2, $3, 30, 1)`,
      [workerA, jobSource, `job-alert-force-rls-${jobSource}`]);
      await client.query('COMMIT');

      await client.query('BEGIN');
      await client.query('SET LOCAL ROLE jale_whatsapp');
      await client.query(`SELECT set_config('app.current_internal_user_id', $1, true)`, [workerB]);
      await client.query(`SELECT set_config('app.current_internal_user_id', $1, true)`, [workerA]);
      await client.query(`INSERT INTO worker_message_intents
        (user_id, category, owner_service, source_type, source_id, dedupe_key, priority, policy_version)
        VALUES ($1, 'employer_chat', 'job-messaging', 'job_conversation_message', $2, $3, 40, 1)`,
      [workerA, chatSource, `employer-chat-force-rls-${chatSource}`]);
      await client.query(`SELECT set_config('app.current_internal_user_id', $1, true)`, [workerB]);
      expect((await client.query<{ restored: string }>(
        `SELECT current_setting('app.current_internal_user_id', true) AS restored`,
      )).rows).toEqual([{ restored: workerB }]);
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      await client.end();
    }

    expect((await setup.query<{ count: string }>(
      'SELECT count(*) FROM worker_message_intents WHERE source_id = ANY($1::uuid[])',
      [[jobSource, chatSource]],
    )).rows).toEqual([{ count: '2' }]);
  });
});
