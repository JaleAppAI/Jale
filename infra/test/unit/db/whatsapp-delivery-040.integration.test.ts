import { randomUUID } from 'node:crypto';
import { Client } from 'pg';

const databaseUrl = process.env.JALE_TEST_DATABASE_URL;
const maybeDescribe = databaseUrl ? describe : describe.skip;

if (!databaseUrl) {
  test('CONCERN: migration 040 PostgreSQL gate was not run', () => {
    console.warn('[whatsapp-delivery-040] set JALE_TEST_DATABASE_URL for native verification');
    expect(databaseUrl).toBeUndefined();
  });
}

maybeDescribe('migration 040 Twilio delivery correlation', () => {
  const employerId = randomUUID();
  const workerId = randomUUID();
  const jobId = randomUUID();
  const applicationId = randomUUID();
  const conversationId = randomUUID();
  const messageId = randomUUID();
  const outboxId = randomUUID();
  const jobMessageSid = `SM${randomUUID().replaceAll('-', '')}`;
  const whatsappSid = `SM${randomUUID().replaceAll('-', '')}`;
  const unknownSid = `SM${randomUUID().replaceAll('-', '')}`;
  const runtimeRole = 'jale_callback_test_runner';
  let setupClient: Client;
  let client: Client;

  beforeAll(async () => {
    // Use the bootstrap connection only for fixtures and a disposable,
    // unprivileged runner for runtime assertions. The runner can SET LOCAL
    // ROLE to jale_whatsapp but has no path to the helper role. This keeps
    // FORCE RLS from making fixture setup impossible without accidentally
    // giving callback assertions superuser session semantics.
    const runtimeUrl = new URL(databaseUrl!);
    runtimeUrl.username = runtimeRole;
    runtimeUrl.password = 'test-callback-runner-pw';
    setupClient = new Client({ connectionString: databaseUrl });
    await setupClient.connect();
    await setupClient.query(`DROP ROLE IF EXISTS ${runtimeRole}`);
    await setupClient.query(
      `CREATE ROLE ${runtimeRole}
         LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS
         PASSWORD 'test-callback-runner-pw'`,
    );
    await setupClient.query(
      `GRANT jale_whatsapp TO ${runtimeRole} WITH SET TRUE, INHERIT FALSE`,
    );
    client = new Client({ connectionString: runtimeUrl.toString() });
    await client.connect();
    // Review-1 correction (item 3, native gate integrity): this test must
    // run against a database bootstrapped as the plain jale_admin owner
    // (NOSUPERUSER NOCREATEDB CREATEROLE NOBYPASSRLS — the exact production
    // ownership model) with migrations 001..039 applied byte-for-byte, in
    // order, as that same non-superuser role. No ownership rewrites, no RLS
    // bypass, no ALTER TABLE ... OWNER TO shortcuts. See
    // The 020b recursion-prevention migration lets that plain-owner chain
    // reach this migration without the historical migration-023 42P17 abort.
    await setupClient.query(
      `INSERT INTO users (id, cognito_sub, user_type) VALUES
         ($1, $2, 'employer'), ($3, $4, 'worker')`,
      [employerId, `w2-employer-${employerId}`, workerId, `w2-worker-${workerId}`],
    );
    await setupClient.query(
      `INSERT INTO jobs (id, employer_id, title, location, job_type)
       VALUES ($1, $2, 'W2 job', 'Denver', 'full-time')`,
      [jobId, employerId],
    );
    await setupClient.query(
      `INSERT INTO job_applications (id, job_id, worker_id) VALUES ($1, $2, $3)`,
      [applicationId, jobId, workerId],
    );
    await setupClient.query(
      `INSERT INTO job_conversations
         (id, job_id, employer_id, worker_id, application_id)
       VALUES ($1, $2, $3, $4, $5)`,
      [conversationId, jobId, employerId, workerId, applicationId],
    );
    await setupClient.query(
      `INSERT INTO job_conversation_messages
         (id, conversation_id, sender_type, direction, body, status, twilio_message_sid)
       VALUES ($1, $2, 'employer', 'outbound', 'hello', 'sent', $3)`,
      [messageId, conversationId, jobMessageSid],
    );
    await setupClient.query(
      `INSERT INTO whatsapp_outbox
         (id, sequence, whatsapp_number, body, status, content_template,
          content_variables, source_type, source_id, idempotency_key, twilio_message_sid)
       VALUES ($1, 1, '+15550000001', NULL, 'sent', 'job_alert_en', '{}'::jsonb,
               'job_alert', $2, $3, $4)`,
      [outboxId, jobId, `job-alert:${jobId}:${workerId}`, whatsappSid],
    );
  });

  afterAll(async () => {
    await setupClient.query('DELETE FROM jobs WHERE id = $1', [jobId]);
    await setupClient.query('DELETE FROM users WHERE id IN ($1, $2)', [employerId, workerId]);
    await client.end();
    await setupClient.query(`DROP ROLE ${runtimeRole}`);
    await setupClient.end();
  });

  // Review-1 correction (item 3): exercise the unified callback exactly as
  // production does — as jale_whatsapp via SET LOCAL ROLE inside a
  // transaction, not as the jale_admin migration owner.
  const record = async (sid: string, status: string) => {
    await client.query('BEGIN');
    try {
      await client.query('SET LOCAL ROLE jale_whatsapp');
      const result = await client.query<{ matched: boolean; changed: boolean; source: string | null }>(
        'SELECT * FROM jale_twilio_callback.record_twilio_delivery_status($1, $2, NULL, NULL)',
        [sid, status],
      );
      await client.query('COMMIT');
      return result.rows[0];
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    }
  };

  test('whatsapp outbox transitions are monotonic and idempotent', async () => {
    expect(await record(whatsappSid, 'sent')).toEqual({
      matched: true, changed: true, source: 'whatsapp_outbox',
    });
    expect(await record(whatsappSid, 'delivered')).toEqual({
      matched: true, changed: true, source: 'whatsapp_outbox',
    });
    expect(await record(whatsappSid, 'sent')).toEqual({
      matched: true, changed: false, source: 'whatsapp_outbox',
    });
  });

  test('known stale job-message SID is distinct from an unknown SID', async () => {
    expect(await record(jobMessageSid, 'delivered')).toEqual({
      matched: true, changed: true, source: 'job_message_outbox',
    });
    expect(await record(jobMessageSid, 'sent')).toEqual({
      matched: true, changed: false, source: 'job_message_outbox',
    });
    expect(await record(unknownSid, 'sent')).toEqual({
      matched: false, changed: false, source: null,
    });
  });

  test('Lambda role cannot assume the NOLOGIN helper role or invoke a public alias', async () => {
    await client.query('BEGIN');
    try {
      await client.query('SET LOCAL ROLE jale_whatsapp');
      const acl = await client.query<{
        can_set_helper: boolean; public_alias: boolean; unified: boolean;
      }>(
        `SELECT
           pg_has_role(current_user, 'jale_twilio_callback', 'SET') AS can_set_helper,
           to_regprocedure('public.record_twilio_delivery_status(text,text,text,text)') IS NOT NULL
             AS public_alias,
           has_function_privilege(current_user,
             'jale_twilio_callback.record_twilio_delivery_status(text,text,text,text)', 'EXECUTE')
             AS unified`,
      );
      expect(acl.rows[0]).toEqual({
        can_set_helper: false, public_alias: false, unified: true,
      });
    } finally {
      await client.query('ROLLBACK');
    }
  });

  // Review-1 correction (item 3): admin_case_events is admin-console-owned
  // (migration 026/027) — jale_whatsapp has no grant on it at all. The
  // admin-event write on delivery/read/failure MUST happen exclusively
  // inside the SECURITY DEFINER dispatch, never as a direct app-code write,
  // and this proves jale_whatsapp cannot bypass that.
  test('jale_whatsapp cannot write admin_case_events directly (only via the SECURITY DEFINER dispatch)', async () => {
    await client.query('BEGIN');
    try {
      await client.query('SET LOCAL ROLE jale_whatsapp');
      await expect(client.query(
        `INSERT INTO admin_case_events (case_id, event_type, actor_type, actor_id, payload)
         VALUES ($1, 'admin_reply_delivered', 'system', 'twilio', '{}'::jsonb)`,
        [randomUUID()],
      )).rejects.toThrow(/permission denied/i);
    } finally {
      await client.query('ROLLBACK');
    }
  });

  // Review-1 correction (item 3): the NOLOGIN jale_twilio_callback role
  // itself must never be directly reachable by anything other than the
  // migration-time grantor — no application role should be able to SET
  // ROLE into it (that would let a compromised Lambda role bypass the
  // dispatch function's validation and call the raw locked implementations
  // with arbitrary inputs). Covered structurally in the ACL test above via
  // can_set_helper === false; this test proves the negative outcome too.
  test('jale_whatsapp cannot SET ROLE into jale_twilio_callback', async () => {
    await client.query('BEGIN');
    try {
      await client.query('SET LOCAL ROLE jale_whatsapp');
      await expect(client.query('SET LOCAL ROLE jale_twilio_callback'))
        .rejects.toThrow(/permission denied/i);
    } finally {
      await client.query('ROLLBACK');
    }
  });
});
