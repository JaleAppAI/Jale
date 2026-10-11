/**
 * PostgreSQL-backed verification for migration 039.
 *
 * Set JALE_TEST_DATABASE_URL to an isolated Postgres 16 database with the
 * complete migration chain applied. The URL user must be able to SET ROLE so
 * fixtures can be created as superuser and behavior exercised as
 * jale_whatsapp without granting that application role direct table writes.
 */
import { Client, type QueryResultRow } from 'pg';

const databaseUrl = process.env.JALE_TEST_DATABASE_URL;

if (!databaseUrl) {
  test('CONCERN: migration 039 PostgreSQL gate was not run', () => {
    // eslint-disable-next-line no-console
    console.warn(
      '[whatsapp-support-039] DONE_WITH_CONCERNS: set JALE_TEST_DATABASE_URL ' +
        'to run the support-case function and privilege checks against Postgres 16.',
    );
    expect(databaseUrl).toBeUndefined();
  });
}

function maybeDescribe(name: string, fn: () => void): void {
  if (databaseUrl) describe(name, fn);
  else describe.skip(name, fn);
}

async function queryAsWhatsapp<T extends QueryResultRow = QueryResultRow>(
  sql: string,
  params: unknown[] = [],
  cognitoSub?: string,
): Promise<{ rows: T[]; rowCount: number | null }> {
  const client = new Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    await client.query('BEGIN');
    await client.query('SET LOCAL ROLE jale_whatsapp');
    if (cognitoSub) {
      await client.query(`SELECT set_config('app.current_user_id', $1, true)`, [cognitoSub]);
    }
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

maybeDescribe('migration 039 WhatsApp support cases', () => {
  let workerId: string;
  let conversationId: string;
  let otherWorkerId: string;
  let otherConversationId: string;
  let matchingUnlinkedConversationId: string;
  let mismatchedUnlinkedConversationId: string;

  beforeAll(async () => {
    const client = new Client({ connectionString: databaseUrl });
    await client.connect();
    try {
      const worker = await client.query<{ id: string }>(
        `INSERT INTO users (cognito_sub, user_type, whatsapp_number, phone)
         VALUES ('w1-support-035', 'worker', '+15550000351', '+15550000353')
         RETURNING id`,
      );
      workerId = worker.rows[0].id;
      const conversation = await client.query<{ id: string }>(
        `INSERT INTO whatsapp_conversations (user_id, whatsapp_number, conversation_state)
         VALUES ($1, '+15550000351', 'idle')
         RETURNING id`,
        [workerId],
      );
      conversationId = conversation.rows[0].id;

      const matchingUnlinked = await client.query<{ id: string }>(
        `INSERT INTO whatsapp_conversations (user_id, whatsapp_number, conversation_state)
         VALUES (NULL, '+15550000353', 'awaiting_otp')
         RETURNING id`,
      );
      matchingUnlinkedConversationId = matchingUnlinked.rows[0].id;

      const mismatchedUnlinked = await client.query<{ id: string }>(
        `INSERT INTO whatsapp_conversations (user_id, whatsapp_number, conversation_state)
         VALUES (NULL, '+15550000354', 'awaiting_otp')
         RETURNING id`,
      );
      mismatchedUnlinkedConversationId = mismatchedUnlinked.rows[0].id;

      const otherWorker = await client.query<{ id: string }>(
        `INSERT INTO users (cognito_sub, user_type, whatsapp_number)
         VALUES ('w2-support-035', 'worker', '+15550000352')
         RETURNING id`,
      );
      otherWorkerId = otherWorker.rows[0].id;
      const otherConversation = await client.query<{ id: string }>(
        `INSERT INTO whatsapp_conversations (user_id, whatsapp_number, conversation_state)
         VALUES ($1, '+15550000352', 'idle')
         RETURNING id`,
        [otherWorkerId],
      );
      otherConversationId = otherConversation.rows[0].id;
    } finally {
      await client.end();
    }
  });

  afterAll(async () => {
    const client = new Client({ connectionString: databaseUrl });
    await client.connect();
    try {
      await client.query('DELETE FROM admin_cases WHERE user_id = ANY($1::uuid[])', [[workerId, otherWorkerId]]);
      await client.query(
        'DELETE FROM whatsapp_conversations WHERE id = ANY($1::uuid[])',
        [[conversationId, otherConversationId, matchingUnlinkedConversationId, mismatchedUnlinkedConversationId]],
      );
      await client.query('DELETE FROM users WHERE id = ANY($1::uuid[])', [[workerId, otherWorkerId]]);
    } finally {
      await client.end();
    }
  });

  it('creates one admin-compatible case and reuses it on a repeated command', async () => {
    const first = await queryAsWhatsapp<{ case_id: string; created: boolean }>(
      'SELECT case_id, created FROM create_admin_support_case($1, $2, $3, $4)',
      [workerId, conversationId, '  Need support  ', 'raw support message'],
      'w1-support-035',
    );
    expect(first.rows).toHaveLength(1);
    expect(first.rows[0].created).toBe(true);

    const second = await queryAsWhatsapp<{ case_id: string; created: boolean }>(
      'SELECT case_id, created FROM create_admin_support_case($1, $2, $3, $4)',
      [workerId, conversationId, 'Need support again', 'support'],
      'w1-support-035',
    );
    expect(second.rows).toEqual([{ case_id: first.rows[0].case_id, created: false }]);

    const verifier = new Client({ connectionString: databaseUrl });
    await verifier.connect();
    try {
      const cases = await verifier.query<{
        priority: number;
        status: string;
        details: Record<string, unknown>;
        event_type: string;
        payload: Record<string, unknown>;
      }>(
        `SELECT c.priority, c.status, c.details, e.event_type, e.payload
           FROM admin_cases c
           JOIN admin_case_events e ON e.case_id = c.id
          WHERE c.user_id = $1 AND c.case_type = 'help_request'
          ORDER BY e.created_at ASC`,
        [workerId],
      );
      expect(cases.rows).toHaveLength(1);
      expect(cases.rows[0]).toMatchObject({
        priority: 70,
        status: 'open',
        details: {
          subjectType: 'worker',
          workerLabel: 'Worker',
          conversationRef: conversationId,
          lastMessage: 'raw support message',
          source: 'whatsapp_support_command',
        },
        event_type: 'case_created',
        payload: {
          title: 'Worker requested help',
          detail: 'Need support',
          source: 'whatsapp_support_command',
        },
      });
    } finally {
      await verifier.end();
    }
  });

  it('accepts a matching verified-phone unlinked conversation without binding it', async () => {
    const result = await queryAsWhatsapp<{ case_id: string; created: boolean }>(
      'SELECT case_id, created FROM create_admin_support_case($1, $2, $3, $4)',
      [workerId, matchingUnlinkedConversationId, 'Phone fallback', 'support'],
      'w1-support-035',
    );
    expect(result.rows).toHaveLength(1);

    const verifier = new Client({ connectionString: databaseUrl });
    await verifier.connect();
    try {
      const conversation = await verifier.query<{ user_id: string | null }>(
        'SELECT user_id FROM whatsapp_conversations WHERE id = $1',
        [matchingUnlinkedConversationId],
      );
      expect(conversation.rows[0].user_id).toBeNull();
    } finally {
      await verifier.end();
    }
  });

  it('rejects a conversation that is not linked to the requested worker', async () => {
    await expect(
      queryAsWhatsapp(
        'SELECT * FROM create_admin_support_case($1, $2, $3, $4)',
        [workerId, otherConversationId, 'Invalid relationship', 'support'],
        'w1-support-035',
      ),
    ).rejects.toMatchObject({ code: '23503' });
  });

  it('rejects an unlinked conversation whose number does not match the worker', async () => {
    await expect(
      queryAsWhatsapp(
        'SELECT * FROM create_admin_support_case($1, $2, $3, $4)',
        [workerId, mismatchedUnlinkedConversationId, 'Invalid phone relationship', 'support'],
        'w1-support-035',
      ),
    ).rejects.toMatchObject({ code: '23503' });
  });

  it('does not grant jale_whatsapp direct admin-case writes', async () => {
    await expect(
      queryAsWhatsapp(
        `INSERT INTO admin_cases (case_type, status, user_id, summary)
         VALUES ('help_request', 'open', $1, 'direct write must fail')`,
        [workerId],
      ),
    ).rejects.toMatchObject({ code: '42501' });
  });
});
