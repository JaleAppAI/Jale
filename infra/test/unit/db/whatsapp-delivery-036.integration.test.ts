import { randomUUID } from 'node:crypto';
import { Client } from 'pg';

const databaseUrl = process.env.JALE_TEST_DATABASE_URL;
const maybeDescribe = databaseUrl ? describe : describe.skip;

if (!databaseUrl) {
  test('CONCERN: migration 036 PostgreSQL gate was not run', () => {
    console.warn('[whatsapp-delivery-036] set JALE_TEST_DATABASE_URL for native verification');
    expect(databaseUrl).toBeUndefined();
  });
}

maybeDescribe('migration 036 Twilio delivery correlation', () => {
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
  let client: Client;

  beforeAll(async () => {
    client = new Client({ connectionString: databaseUrl });
    await client.connect();
    // Production migrations run as the jale_admin cluster owner. Normalize the
    // disposable superuser-applied testbed to that ownership model.
    await client.query('ALTER TABLE whatsapp_outbox OWNER TO jale_admin');
    await client.query(
      `INSERT INTO users (id, cognito_sub, user_type) VALUES
         ($1, $2, 'employer'), ($3, $4, 'worker')`,
      [employerId, `w2-employer-${employerId}`, workerId, `w2-worker-${workerId}`],
    );
    await client.query(
      `INSERT INTO jobs (id, employer_id, title, location, job_type)
       VALUES ($1, $2, 'W2 job', 'Denver', 'full-time')`,
      [jobId, employerId],
    );
    await client.query(
      `INSERT INTO job_applications (id, job_id, worker_id) VALUES ($1, $2, $3)`,
      [applicationId, jobId, workerId],
    );
    await client.query(
      `INSERT INTO job_conversations
         (id, job_id, employer_id, worker_id, application_id)
       VALUES ($1, $2, $3, $4, $5)`,
      [conversationId, jobId, employerId, workerId, applicationId],
    );
    await client.query(
      `INSERT INTO job_conversation_messages
         (id, conversation_id, sender_type, direction, body, status, twilio_message_sid)
       VALUES ($1, $2, 'employer', 'outbound', 'hello', 'sent', $3)`,
      [messageId, conversationId, jobMessageSid],
    );
    await client.query(
      `INSERT INTO whatsapp_outbox
         (id, sequence, whatsapp_number, body, status, content_template,
          content_variables, source_type, source_id, idempotency_key, twilio_message_sid)
       VALUES ($1, 1, '+15550000001', NULL, 'sent', 'job_alert_en', '{}'::jsonb,
               'job_alert', $2, $3, $4)`,
      [outboxId, jobId, `job-alert:${jobId}:${workerId}`, whatsappSid],
    );
  });

  afterAll(async () => {
    await client.query('DELETE FROM jobs WHERE id = $1', [jobId]);
    await client.query('DELETE FROM users WHERE id IN ($1, $2)', [employerId, workerId]);
    await client.end();
  });

  const record = async (sid: string, status: string) => {
    const result = await client.query<{ matched: boolean; changed: boolean; source: string | null }>(
      'SELECT * FROM jale_twilio_callback.record_twilio_delivery_status($1, $2, NULL, NULL)',
      [sid, status],
    );
    return result.rows[0];
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
});
