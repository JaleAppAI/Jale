import { randomUUID } from 'node:crypto';
import { Client } from 'pg';

// Migration 097 native gate. Employer -> worker invites are TEMPLATE sends:
// job-messaging.ts writes the Twilio SID onto job_message_outbox only and
// deliberately leaves job_conversation_messages alone (a template row must
// stay 'waiting_worker_reply' until the worker replies). Migration 040's
// unified callback only knew about whatsapp_outbox and
// job_conversation_messages.twilio_message_sid, so those callbacks came back
// unmatched -> WhatsAppStatusCallbackUnknownSid + a retryable 503 + a page.
// 097 adds job_message_outbox as a third correlation source.
//
// Modelled on whatsapp-delivery-040.integration.test.ts: the same
// skip-when-no-DB harness, the same "exercise it as jale_whatsapp through a
// disposable unprivileged runner" discipline (the runner name differs so the
// two suites can run together under --runInBand).
const databaseUrl = process.env.JALE_TEST_DATABASE_URL;
const maybeDescribe = databaseUrl ? describe : describe.skip;

if (!databaseUrl) {
  test('CONCERN: migration 097 PostgreSQL gate was not run', () => {
    console.warn('[twilio-callback-job-outbox-097] set JALE_TEST_DATABASE_URL for native verification');
    expect(databaseUrl).toBeUndefined();
  });
}

maybeDescribe('migration 097 Twilio callbacks correlate through job_message_outbox', () => {
  const employerId = randomUUID();
  const workerId = randomUUID();
  const jobId = randomUUID();
  const applicationId = randomUUID();
  const conversationId = randomUUID();
  const templateMessageId = randomUUID();
  const templateOutboxId = randomUUID();
  const freeformMessageId = randomUUID();
  const sid = () => `SM${randomUUID().replaceAll('-', '')}`;
  const templateSid = sid();
  const freeformSid = sid();
  const unknownSid = sid();
  const runtimeRole = 'jale_outbox_callback_test_runner';
  let setupClient: Client;
  let client: Client;

  beforeAll(async () => {
    const runtimeUrl = new URL(databaseUrl!);
    runtimeUrl.username = runtimeRole;
    runtimeUrl.password = 'test-outbox-callback-runner-pw';
    setupClient = new Client({ connectionString: databaseUrl });
    await setupClient.connect();
    await setupClient.query(`DROP ROLE IF EXISTS ${runtimeRole}`);
    await setupClient.query(
      `CREATE ROLE ${runtimeRole}
         LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS
         PASSWORD 'test-outbox-callback-runner-pw'`,
    );
    await setupClient.query(
      `GRANT jale_whatsapp TO ${runtimeRole} WITH SET TRUE, INHERIT FALSE`,
    );
    client = new Client({ connectionString: runtimeUrl.toString() });
    await client.connect();

    await setupClient.query(
      `INSERT INTO users (id, cognito_sub, user_type) VALUES
         ($1, $2, 'employer'), ($3, $4, 'worker')`,
      [employerId, `m97-employer-${employerId}`, workerId, `m97-worker-${workerId}`],
    );
    await setupClient.query(
      `INSERT INTO jobs (id, employer_id, title, location, job_type)
       VALUES ($1, $2, 'Migration 097 job', 'Denver', 'full-time')`,
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

    // The templated invite: the message row is parked in
    // 'waiting_worker_reply' and carries NO SID -- exactly what
    // sendPendingJobMessageOutbox leaves behind for send_kind = 'template'.
    await setupClient.query(
      `INSERT INTO job_conversation_messages
         (id, conversation_id, sender_type, direction, body, status)
       VALUES ($1, $2, 'employer', 'outbound', 'employer invite body', 'waiting_worker_reply')`,
      [templateMessageId, conversationId],
    );
    await setupClient.query(
      `INSERT INTO job_message_outbox
         (id, conversation_id, message_id, whatsapp_number, send_kind,
          content_template, content_variables, status, twilio_message_sid, sent_at)
       VALUES ($1, $2, $3, '+15550000097', 'template', 'employer_invite_en',
               '{}'::jsonb, 'sent', $4, now())`,
      [templateOutboxId, conversationId, templateMessageId, templateSid],
    );

    // The freeform send: 040's branch 2 territory -- the SID lives on the
    // message row itself. 097 must not disturb it.
    await setupClient.query(
      `INSERT INTO job_conversation_messages
         (id, conversation_id, sender_type, direction, body, status, twilio_message_sid)
       VALUES ($1, $2, 'employer', 'outbound', 'freeform follow-up', 'sent', $3)`,
      [freeformMessageId, conversationId, freeformSid],
    );
  });

  afterAll(async () => {
    await setupClient.query('DELETE FROM jobs WHERE id = $1', [jobId]);
    await setupClient.query('DELETE FROM users WHERE id IN ($1, $2)', [employerId, workerId]);
    await client.end();
    await setupClient.query(`DROP ROLE ${runtimeRole}`);
    await setupClient.end();
  });

  // Exercise the unified callback exactly as the status-callback Lambda does:
  // as jale_whatsapp via SET LOCAL ROLE, never as the migration owner.
  const record = async (
    messageSid: string,
    status: string,
    errorCode: string | null = null,
    errorMessage: string | null = null,
  ) => {
    await client.query('BEGIN');
    try {
      await client.query('SET LOCAL ROLE jale_whatsapp');
      const result = await client.query<{ matched: boolean; changed: boolean; source: string | null }>(
        'SELECT * FROM jale_twilio_callback.record_twilio_delivery_status($1, $2, $3, $4)',
        [messageSid, status, errorCode, errorMessage],
      );
      await client.query('COMMIT');
      return result.rows[0];
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    }
  };

  const outboxRow = async () => (await setupClient.query<{ status: string; last_error: string | null }>(
    'SELECT status, last_error FROM job_message_outbox WHERE id = $1',
    [templateOutboxId],
  )).rows[0];

  const messageStatus = async (id: string) => (await setupClient.query<{ status: string }>(
    'SELECT status FROM job_conversation_messages WHERE id = $1',
    [id],
  )).rows[0].status;

  test('a templated employer send is MATCHED, not reported as an unknown SID', async () => {
    // Before 097 both of these returned { matched: false, changed: false,
    // source: null } -- the 503-and-page path.
    expect(await record(templateSid, 'queued')).toEqual({
      matched: true, changed: false, source: 'job_message_outbox',
    });
    expect(await record(templateSid, 'delivered')).toEqual({
      matched: true, changed: false, source: 'job_message_outbox',
    });
    // Non-terminal progress must not disturb either row: the template message
    // has to stay parked so the worker-reply flush still delivers it.
    expect(await outboxRow()).toEqual({ status: 'sent', last_error: null });
    expect(await messageStatus(templateMessageId)).toBe('waiting_worker_reply');
  });

  test('a terminal failure flips both rows exactly once', async () => {
    expect(await record(templateSid, 'failed', '30008', 'Unknown destination handset')).toEqual({
      matched: true, changed: true, source: 'job_message_outbox',
    });
    expect(await outboxRow()).toEqual({
      status: 'failed', last_error: '30008 Unknown destination handset',
    });
    expect(await messageStatus(templateMessageId)).toBe('failed');

    // A Twilio redelivery of the same terminal callback must not re-fire the
    // WhatsAppDeliveryFailure metric.
    expect(await record(templateSid, 'failed', '30008', 'Unknown destination handset')).toEqual({
      matched: true, changed: false, source: 'job_message_outbox',
    });
    expect(await record(templateSid, 'undelivered')).toEqual({
      matched: true, changed: false, source: 'job_message_outbox',
    });
    expect((await outboxRow()).last_error).toBe('30008 Unknown destination handset');
  });

  test('040 branch 2 (a SID stamped on job_conversation_messages) is unchanged', async () => {
    expect(await record(freeformSid, 'delivered')).toEqual({
      matched: true, changed: true, source: 'job_message_outbox',
    });
    expect(await record(freeformSid, 'sent')).toEqual({
      matched: true, changed: false, source: 'job_message_outbox',
    });
    expect(await messageStatus(freeformMessageId)).toBe('delivered');
  });

  test('a genuinely unknown SID still reports unmatched so the Lambda can 503', async () => {
    expect(await record(unknownSid, 'sent')).toEqual({
      matched: false, changed: false, source: null,
    });
  });

  // The whole point of routing this through the NOLOGIN definer role is that
  // the callback Lambda role never gets a direct write path across FORCE RLS.
  test('jale_whatsapp cannot flip a job_message_outbox row outside the definer path', async () => {
    await client.query('BEGIN');
    try {
      await client.query('SET LOCAL ROLE jale_whatsapp');
      // 025 grants jale_whatsapp UPDATE on the table, but its only policy is
      // keyed to the worker GUC, and FORCE RLS makes that binding: without it
      // the row is invisible and the write silently affects nothing.
      const update = await client.query(
        `UPDATE job_message_outbox SET status = 'failed' WHERE id = $1`,
        [templateOutboxId],
      );
      expect(update.rowCount).toBe(0);
      const visible = await client.query(
        'SELECT id FROM job_message_outbox WHERE id = $1', [templateOutboxId],
      );
      expect(visible.rowCount).toBe(0);
    } finally {
      await client.query('ROLLBACK');
    }
  });

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

  test('the helper role holds only the listed job_message_outbox columns', async () => {
    const acl = await setupClient.query<{ column_name: string; privilege_type: string }>(
      `SELECT column_name, privilege_type
         FROM information_schema.column_privileges
        WHERE table_schema = 'public' AND table_name = 'job_message_outbox'
          AND grantee = 'jale_twilio_callback'
        ORDER BY privilege_type, column_name`,
    );
    expect(acl.rows).toEqual([
      { column_name: 'created_at', privilege_type: 'SELECT' },
      { column_name: 'id', privilege_type: 'SELECT' },
      { column_name: 'last_error', privilege_type: 'SELECT' },
      { column_name: 'message_id', privilege_type: 'SELECT' },
      { column_name: 'send_kind', privilege_type: 'SELECT' },
      { column_name: 'status', privilege_type: 'SELECT' },
      { column_name: 'twilio_message_sid', privilege_type: 'SELECT' },
      { column_name: 'last_error', privilege_type: 'UPDATE' },
      { column_name: 'status', privilege_type: 'UPDATE' },
    ]);
    const table = await setupClient.query<{ whole_table: boolean }>(
      `SELECT has_table_privilege('jale_twilio_callback', 'public.job_message_outbox', 'SELECT')
              AS whole_table`,
    );
    expect(table.rows[0].whole_table).toBe(false);
  });
});
