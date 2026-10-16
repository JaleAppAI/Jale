import { randomUUID } from 'node:crypto';
import { Client } from 'pg';

const databaseUrl = process.env.JALE_TEST_DATABASE_URL;
const describeWithDatabase = databaseUrl ? describe : describe.skip;

function whatsappUrl(source: string): string {
  const url = new URL(source);
  url.username = 'jale_whatsapp';
  url.password = 'test-whatsapp-pw';
  return url.toString();
}

interface EmployerChatFixture {
  workerId: string;
  employerId: string;
  jobId: string;
  applicationId: string;
  conversationId: string;
  messageIds: string[];
  intentIds: string[];
  outboxId: string;
}

async function createEmployerChatFixture(attemptCount = 0): Promise<EmployerChatFixture> {
  const client = new Client({ connectionString: databaseUrl! });
  await client.connect();
  const fixture: EmployerChatFixture = {
    workerId: randomUUID(),
    employerId: randomUUID(),
    jobId: randomUUID(),
    applicationId: randomUUID(),
    conversationId: randomUUID(),
    messageIds: [randomUUID(), randomUUID()],
    intentIds: [randomUUID(), randomUUID()],
    outboxId: randomUUID(),
  };
  const workerPhone = `+1512${String(Math.floor(Math.random() * 10_000_000)).padStart(7, '0')}`;
  try {
    await client.query(
      `INSERT INTO users (id, cognito_sub, user_type, whatsapp_number)
       VALUES
         ($1, $2, 'worker', $5),
         ($3, $4, 'employer', NULL)`,
      [fixture.workerId, `transport-worker-${fixture.workerId}`,
        fixture.employerId, `transport-employer-${fixture.employerId}`, workerPhone],
    );
    await client.query(
      `INSERT INTO jobs (id, employer_id, title, company, location, job_type, status)
       VALUES ($1, $2, 'Electrician', 'ACME', 'Austin, TX', 'contract', 'active')`,
      [fixture.jobId, fixture.employerId],
    );
    await client.query(
      `INSERT INTO job_applications (id, job_id, worker_id, status)
       VALUES ($1, $2, $3, 'pending')`,
      [fixture.applicationId, fixture.jobId, fixture.workerId],
    );
    await client.query(
      `INSERT INTO job_conversations
         (id, job_id, employer_id, worker_id, application_id, status)
       VALUES ($1, $2, $3, $4, $5, 'open')`,
      [fixture.conversationId, fixture.jobId, fixture.employerId,
        fixture.workerId, fixture.applicationId],
    );
    await client.query(
      `INSERT INTO job_conversation_messages
         (id, conversation_id, sender_type, direction, body, status)
       VALUES
         ($1, $3, 'employer', 'outbound', 'Primary grouped message', 'queued'),
         ($2, $3, 'employer', 'outbound', 'Secondary grouped message', 'queued')`,
      [fixture.messageIds[0], fixture.messageIds[1], fixture.conversationId],
    );
    await client.query(
      `INSERT INTO whatsapp_outbox
         (id, inbound_message_sid, sequence, whatsapp_number, body, source_type,
          source_id, attempt_count)
       VALUES ($1, NULL, 1, '+15125550199', 'Grouped employer summary',
               'worker_intent', $2, $3)`,
      [fixture.outboxId, fixture.intentIds[0], attemptCount],
    );
    await client.query(
      `INSERT INTO worker_message_intents
         (id, user_id, category, owner_service, source_type, source_id, dedupe_key,
          priority, status, policy_version, release_sequence, outbox_id)
       VALUES
         ($1, $3, 'employer_chat', 'job-messaging', 'job_conversation_message',
          $4, $6, 40, 'released', 1, 1, $8),
         ($2, $3, 'employer_chat', 'job-messaging', 'job_conversation_message',
          $5, $7, 40, 'released', 1, 2, $8)`,
      [fixture.intentIds[0], fixture.intentIds[1], fixture.workerId,
        fixture.messageIds[0], fixture.messageIds[1],
        `transport-primary-${fixture.intentIds[0]}`,
        `transport-secondary-${fixture.intentIds[1]}`, fixture.outboxId],
    );
    return fixture;
  } finally {
    await client.end();
  }
}

async function removeEmployerChatFixture(fixture: EmployerChatFixture): Promise<void> {
  const client = new Client({ connectionString: databaseUrl! });
  await client.connect();
  try {
    await client.query('DELETE FROM whatsapp_outbox WHERE id = $1', [fixture.outboxId]);
    await client.query('DELETE FROM job_conversations WHERE id = $1', [fixture.conversationId]);
    await client.query('DELETE FROM job_applications WHERE id = $1', [fixture.applicationId]);
    await client.query('DELETE FROM jobs WHERE id = $1', [fixture.jobId]);
    await client.query('DELETE FROM users WHERE id = ANY($1::uuid[])', [[fixture.workerId, fixture.employerId]]);
  } finally {
    await client.end();
  }
}

async function loadFixtureState(fixture: EmployerChatFixture): Promise<{
  outboxStatus: string;
  intentStatuses: string[];
  messageStatuses: string[];
  messageSids: Array<string | null>;
}> {
  const client = new Client({ connectionString: databaseUrl! });
  await client.connect();
  try {
    const outbox = await client.query<{ status: string }>(
      'SELECT status FROM whatsapp_outbox WHERE id = $1', [fixture.outboxId],
    );
    const intents = await client.query<{ status: string }>(
      `SELECT status FROM worker_message_intents
        WHERE id = ANY($1::uuid[]) ORDER BY release_sequence`, [fixture.intentIds],
    );
    const messages = await client.query<{ status: string; twilio_message_sid: string | null }>(
      `SELECT status, twilio_message_sid FROM job_conversation_messages
        WHERE id = ANY($1::uuid[]) ORDER BY body`, [fixture.messageIds],
    );
    return {
      outboxStatus: outbox.rows[0].status,
      intentStatuses: intents.rows.map((row) => row.status),
      messageStatuses: messages.rows.map((row) => row.status),
      messageSids: messages.rows.map((row) => row.twilio_message_sid),
    };
  } finally {
    await client.end();
  }
}

describeWithDatabase('migration 043 worker-intent transport', () => {
  it('leases in release order without worker context and fences stale completion tokens', async () => {
    const client = new Client({ connectionString: whatsappUrl(databaseUrl!) });
    await client.connect();
    await client.query('BEGIN');
    try {
      const worker = await client.query<{ id: string }>(
        `INSERT INTO users (cognito_sub, user_type, whatsapp_number)
         VALUES ($1, 'worker', $2) RETURNING id`,
        [`transport-043-${randomUUID()}`, `+1512${String(Math.random()).slice(2, 9)}`],
      );
      const workerId = worker.rows[0].id;
      await client.query(`SELECT set_config('app.current_internal_user_id', $1, true)`, [workerId]);

      const intents = await client.query<{ id: string; release_sequence: number }>(
        `INSERT INTO worker_message_intents
           (user_id, category, owner_service, source_type, source_id, dedupe_key,
            priority, status, policy_version, payload, release_sequence)
         VALUES
           ($1, 'job_alert', 'job-alert', 'job', $2, $3, 30, 'released', 1, '{}'::jsonb, 1),
           ($1, 'job_alert', 'job-alert', 'job', $4, $5, 30, 'released', 1, '{}'::jsonb, 2)
         RETURNING id, release_sequence`,
        [workerId, randomUUID(), randomUUID(), randomUUID(), randomUUID()],
      );
      const bySequence = new Map(intents.rows.map((row) => [row.release_sequence, row.id]));
      await client.query(
        `INSERT INTO whatsapp_outbox
           (inbound_message_sid, sequence, whatsapp_number, body, source_type, source_id)
         VALUES
           (NULL, 1, '+15125550199', 'first', 'worker_intent', $1),
           (NULL, 1, '+15125550199', 'second', 'worker_intent', $2)`,
        [bySequence.get(1), bySequence.get(2)],
      );

      await client.query(`SELECT set_config('app.current_internal_user_id', '', true)`);
      const first = await client.query<{ id: string; body: string; lease_token: string }>(
        `SELECT * FROM lease_worker_intent_outbox(25)`,
      );
      expect(first.rows).toHaveLength(1);
      expect(first.rows[0].body).toBe('first');

      const completed = await client.query<{ completed: boolean }>(
        `SELECT complete_worker_intent_outbox($1, $2, $3) AS completed`,
        [first.rows[0].id, first.rows[0].lease_token, `SM${'1'.repeat(32)}`],
      );
      expect(completed.rows[0].completed).toBe(true);

      const stale = await client.query<{ completed: boolean }>(
        `SELECT complete_worker_intent_outbox($1, $2, $3) AS completed`,
        [first.rows[0].id, randomUUID(), `SM${'2'.repeat(32)}`],
      );
      expect(stale.rows[0].completed).toBe(false);

      const second = await client.query<{ body: string }>(
        `SELECT * FROM lease_worker_intent_outbox(25)`,
      );
      expect(second.rows).toHaveLength(1);
      expect(second.rows[0].body).toBe('second');
    } finally {
      await client.query('ROLLBACK');
      await client.end();
    }
  });

  it('propagates provider acceptance and delivery to every grouped employer-chat source', async () => {
    const fixture = await createEmployerChatFixture();
    const client = new Client({ connectionString: whatsappUrl(databaseUrl!) });
    const sid = `SM${randomUUID().replaceAll('-', '')}`;
    await client.connect();
    try {
      const lease = await client.query<{ id: string; lease_token: string }>(
        'SELECT * FROM lease_worker_intent_outbox(1)',
      );
      expect(lease.rows).toHaveLength(1);
      expect(lease.rows[0].id).toBe(fixture.outboxId);

      const completion = await client.query<{ completed: boolean }>(
        'SELECT complete_worker_intent_outbox($1, $2, $3) AS completed',
        [fixture.outboxId, lease.rows[0].lease_token, sid],
      );
      expect(completion.rows[0].completed).toBe(true);
      expect(await loadFixtureState(fixture)).toEqual({
        outboxStatus: 'sent',
        intentStatuses: ['released', 'released'],
        messageStatuses: ['sent', 'sent'],
        messageSids: [sid, sid],
      });

      const callback = await client.query<{ matched: boolean; changed: boolean }>(
        'SELECT * FROM record_whatsapp_delivery_status($1, $2, NULL, NULL)',
        [sid, 'delivered'],
      );
      expect(callback.rows).toEqual([{ matched: true, changed: true }]);
      expect(await loadFixtureState(fixture)).toEqual({
        outboxStatus: 'sent',
        intentStatuses: ['delivered', 'delivered'],
        messageStatuses: ['delivered', 'delivered'],
        messageSids: [sid, sid],
      });
    } finally {
      await client.end();
      await removeEmployerChatFixture(fixture);
    }
  });

  it('propagates a provider callback failure to every grouped employer-chat source', async () => {
    const fixture = await createEmployerChatFixture();
    const client = new Client({ connectionString: whatsappUrl(databaseUrl!) });
    const sid = `SM${randomUUID().replaceAll('-', '')}`;
    await client.connect();
    try {
      const lease = await client.query<{ lease_token: string }>(
        'SELECT * FROM lease_worker_intent_outbox(1)',
      );
      const completion = await client.query<{ completed: boolean }>(
        'SELECT complete_worker_intent_outbox($1, $2, $3) AS completed',
        [fixture.outboxId, lease.rows[0].lease_token, sid],
      );
      expect(completion.rows[0].completed).toBe(true);

      const callback = await client.query<{ matched: boolean; changed: boolean }>(
        'SELECT * FROM record_whatsapp_delivery_status($1, $2, $3, $4)',
        [sid, 'failed', '63016', 'provider rejected message'],
      );
      expect(callback.rows).toEqual([{ matched: true, changed: true }]);

      expect(await loadFixtureState(fixture)).toEqual({
        outboxStatus: 'sent',
        intentStatuses: ['failed', 'failed'],
        messageStatuses: ['failed', 'failed'],
        messageSids: [sid, sid],
      });
      const reasons = await new Client({ connectionString: databaseUrl! });
      await reasons.connect();
      try {
        const result = await reasons.query<{ decision_reason: string }>(
          'SELECT decision_reason FROM worker_message_intents WHERE id = $1',
          [fixture.intentIds[0]],
        );
        expect(result.rows[0].decision_reason).toBe('provider rejected message');
      } finally {
        await reasons.end();
      }
    } finally {
      await client.end();
      await removeEmployerChatFixture(fixture);
    }
  });

  it('keeps grouped sources nonterminal after a retryable definite failure', async () => {
    const fixture = await createEmployerChatFixture();
    const client = new Client({ connectionString: whatsappUrl(databaseUrl!) });
    await client.connect();
    try {
      const lease = await client.query<{ lease_token: string }>(
        'SELECT * FROM lease_worker_intent_outbox(1)',
      );
      const failed = await client.query<{ failed: boolean }>(
        'SELECT fail_worker_intent_outbox($1, $2, $3, false) AS failed',
        [fixture.outboxId, lease.rows[0].lease_token, 'definite rejection'],
      );
      expect(failed.rows[0].failed).toBe(true);
      expect(await loadFixtureState(fixture)).toEqual({
        outboxStatus: 'pending',
        intentStatuses: ['released', 'released'],
        messageStatuses: ['queued', 'queued'],
        messageSids: [null, null],
      });
    } finally {
      await client.end();
      await removeEmployerChatFixture(fixture);
    }
  });

  it.each([
    { label: 'retry-cap failure', attemptCount: 4, ambiguous: false, outboxStatus: 'failed' },
    { label: 'ambiguous send', attemptCount: 0, ambiguous: true, outboxStatus: 'send_unknown' },
  ])('marks every grouped source failed after terminal $label', async ({
    attemptCount,
    ambiguous,
    outboxStatus,
  }) => {
    const fixture = await createEmployerChatFixture(attemptCount);
    const client = new Client({ connectionString: whatsappUrl(databaseUrl!) });
    await client.connect();
    try {
      const lease = await client.query<{ lease_token: string }>(
        'SELECT * FROM lease_worker_intent_outbox(1)',
      );
      const failed = await client.query<{ failed: boolean }>(
        'SELECT fail_worker_intent_outbox($1, $2, $3, $4) AS failed',
        [fixture.outboxId, lease.rows[0].lease_token, 'terminal failure', ambiguous],
      );
      expect(failed.rows[0].failed).toBe(true);
      expect(await loadFixtureState(fixture)).toEqual({
        outboxStatus,
        intentStatuses: ['failed', 'failed'],
        messageStatuses: ['failed', 'failed'],
        messageSids: [null, null],
      });
    } finally {
      await client.end();
      await removeEmployerChatFixture(fixture);
    }
  });

  it('blocks direct application-role mutation of fenced worker-intent rows', async () => {
    const fixture = await createEmployerChatFixture();
    const client = new Client({ connectionString: whatsappUrl(databaseUrl!) });
    await client.connect();
    try {
      const directStatus = await client.query<{ id: string }>(
        `UPDATE whatsapp_outbox
            SET status = 'sent'
          WHERE id = $1
          RETURNING id`,
        [fixture.outboxId],
      );
      expect(directStatus.rows).toHaveLength(0);

      await expect(client.query(
        `UPDATE whatsapp_outbox
            SET worker_intent_lease_token = $2,
                worker_intent_leased_until = now() + interval '15 minutes'
          WHERE id = $1`,
        [fixture.outboxId, randomUUID()],
      )).rejects.toMatchObject({ code: '42501' });

      const state = await loadFixtureState(fixture);
      expect(state.outboxStatus).toBe('pending');
      expect(state.intentStatuses).toEqual(['released', 'released']);
      expect(state.messageStatuses).toEqual(['queued', 'queued']);
    } finally {
      await client.end();
      await removeEmployerChatFixture(fixture);
    }
  });

  it('narrows lease-column privileges and indexes grouped outbox correlation', async () => {
    const client = new Client({ connectionString: databaseUrl! });
    await client.connect();
    try {
      const privileges = await client.query<{
        lease_token_update: boolean;
        leased_until_update: boolean;
      }>(
        `SELECT
           has_column_privilege(
             'jale_whatsapp', 'public.whatsapp_outbox',
             'worker_intent_lease_token', 'UPDATE') AS lease_token_update,
           has_column_privilege(
             'jale_whatsapp', 'public.whatsapp_outbox',
             'worker_intent_leased_until', 'UPDATE') AS leased_until_update`,
      );
      expect(privileges.rows).toEqual([{
        lease_token_update: false,
        leased_until_update: false,
      }]);

      const index = await client.query<{ indexdef: string }>(
        `SELECT indexdef FROM pg_indexes
          WHERE schemaname = 'public'
            AND indexname = 'idx_worker_message_intents_outbox_id'`,
      );
      expect(index.rows).toHaveLength(1);
      expect(index.rows[0].indexdef).toContain('(outbox_id)');
      expect(index.rows[0].indexdef).toContain('WHERE (outbox_id IS NOT NULL)');
    } finally {
      await client.end();
    }
  });
});

// ── Migration 126: a queued worker message is never sent after its intent's
// expires_at ──
//
// Every writer of worker_message_intents.expires_at sets the instant after
// which that message must not go out: a job alert after 72 hours, an employer
// message or stage change after 7 days (105), the web completion line when
// the WhatsApp window it was queued for closes, or its template after 48
// hours. The enqueue and the worker-ready release already check it through
// evaluateDelivery; 126 makes the drain check it too. The lease skips an
// outbox row whose intent has expired, and expire_worker_intent_outbox ends
// such a row the way 093's ceiling ends a row: status 'failed', never sent.
//
// Committed fixtures, because the lease and the expiry pass run on the
// jale_whatsapp login in a second session. This suite runs before any other
// suite can leave a leasable row behind, so a global lease here sees only
// these rows; the assertions still filter by their own ids.

interface ExpiryRowSpec {
  /** An interval relative to now(), or null for no expiry. */
  expiresIn: string | null;
  template?: boolean;
}

interface ExpiryFixture {
  workerId: string;
  intentIds: string[];
  outboxIds: string[];
}

async function createExpiryFixture(rows: ExpiryRowSpec[]): Promise<ExpiryFixture> {
  const fixture: ExpiryFixture = {
    workerId: randomUUID(),
    intentIds: rows.map(() => randomUUID()),
    outboxIds: rows.map(() => randomUUID()),
  };
  const recipient = `+1512${String(Math.floor(Math.random() * 10_000_000)).padStart(7, '0')}`;
  const client = new Client({ connectionString: databaseUrl! });
  await client.connect();
  try {
    await client.query(
      `INSERT INTO users (id, cognito_sub, user_type, whatsapp_number)
       VALUES ($1, $2, 'worker', $3)`,
      [fixture.workerId, `expiry-126-${fixture.workerId}`, recipient],
    );
    for (const [index, spec] of rows.entries()) {
      // 013's whatsapp_outbox_body_or_template CHECK: a body, or a template
      // with its variables, never both.
      await client.query(
        `INSERT INTO whatsapp_outbox
           (id, inbound_message_sid, sequence, whatsapp_number, body, content_template,
            content_variables, source_type, source_id, attempt_count)
         VALUES ($1, NULL, 1, $2, $3, $4, $5::jsonb, 'worker_intent', $6, 0)`,
        [
          fixture.outboxIds[index], recipient,
          spec.template ? null : 'A free-form line',
          spec.template ? 'application_web_completed_es' : null,
          spec.template ? JSON.stringify({ 1: 'Concreto', 2: 'https://example.test/es/worker/applications/x' }) : null,
          fixture.intentIds[index],
        ],
      );
      await client.query(
        `INSERT INTO worker_message_intents
           (id, user_id, category, owner_service, source_type, source_id, dedupe_key,
            priority, status, policy_version, release_sequence, outbox_id, expires_at)
         VALUES ($1, $2, 'account', 'account', 'application_web_completion', $3, $4,
                 45, 'released', 1, $5, $6,
                 CASE WHEN $7::text IS NULL THEN NULL ELSE now() + $7::interval END)`,
        [
          fixture.intentIds[index], fixture.workerId, randomUUID(),
          `expiry-126-${fixture.intentIds[index]}`, index + 1,
          fixture.outboxIds[index], spec.expiresIn,
        ],
      );
    }
    return fixture;
  } finally {
    await client.end();
  }
}

async function removeExpiryFixture(fixture: ExpiryFixture): Promise<void> {
  const client = new Client({ connectionString: databaseUrl! });
  await client.connect();
  try {
    await client.query('DELETE FROM worker_message_intents WHERE id = ANY($1::uuid[])', [fixture.intentIds]);
    await client.query('DELETE FROM whatsapp_outbox WHERE id = ANY($1::uuid[])', [fixture.outboxIds]);
    await client.query('DELETE FROM users WHERE id = $1', [fixture.workerId]);
  } finally {
    await client.end();
  }
}

async function readExpiryState(fixture: ExpiryFixture, index: number): Promise<{
  outboxStatus: string;
  nextAttemptAt: Date | null;
  attemptCount: number;
  lastError: string | null;
  intentStatus: string;
  decisionReason: string | null;
}> {
  const client = new Client({ connectionString: databaseUrl! });
  await client.connect();
  try {
    const result = await client.query<{
      status: string; next_attempt_at: Date | null; attempt_count: number;
      last_error: string | null; intent_status: string; decision_reason: string | null;
    }>(
      `SELECT o.status, o.next_attempt_at, o.attempt_count, o.last_error,
              i.status AS intent_status, i.decision_reason
         FROM whatsapp_outbox o
         JOIN worker_message_intents i ON i.id = o.source_id
        WHERE o.id = $1`,
      [fixture.outboxIds[index]],
    );
    const row = result.rows[0];
    return {
      outboxStatus: row.status,
      nextAttemptAt: row.next_attempt_at,
      attemptCount: row.attempt_count,
      lastError: row.last_error,
      intentStatus: row.intent_status,
      decisionReason: row.decision_reason,
    };
  } finally {
    await client.end();
  }
}

async function leasedIds(client: Client): Promise<string[]> {
  const lease = await client.query<{ id: string }>('SELECT id FROM lease_worker_intent_outbox(100)');
  return lease.rows.map((row) => row.id);
}

async function expiredIds(client: Client): Promise<string[]> {
  const expired = await client.query<{ id: string }>('SELECT id FROM expire_worker_intent_outbox()');
  return expired.rows.map((row) => row.id);
}

describeWithDatabase('migration 126: the drain honours the intent expiry', () => {
  it('never leases a row whose intent has expired, and the expiry pass ends it unsent', async () => {
    const fixture = await createExpiryFixture([{ expiresIn: '-1 minute' }]);
    const client = new Client({ connectionString: whatsappUrl(databaseUrl!) });
    await client.connect();
    try {
      expect(await leasedIds(client)).not.toContain(fixture.outboxIds[0]);
      expect((await readExpiryState(fixture, 0)).outboxStatus).toBe('pending');

      const ended = await expiredIds(client);
      expect(ended.filter((id) => fixture.outboxIds.includes(id))).toEqual([fixture.outboxIds[0]]);
      // 093's terminal shape: 'failed', nothing scheduled, the attempt count
      // untouched (nothing was attempted). The intent reads 'expired', as it
      // would had the enqueue or the release seen the expiry first.
      expect(await readExpiryState(fixture, 0)).toEqual({
        outboxStatus: 'failed',
        nextAttemptAt: null,
        attemptCount: 0,
        lastError: 'worker intent expired before sending',
        intentStatus: 'expired',
        decisionReason: 'intent_expired',
      });

      // Ended once: a second pass and a second lease leave it alone.
      expect(await expiredIds(client)).not.toContain(fixture.outboxIds[0]);
      expect(await leasedIds(client)).not.toContain(fixture.outboxIds[0]);
    } finally {
      await client.end();
      await removeExpiryFixture(fixture);
    }
  });

  it('still leases a template row inside its window and a row with no expiry', async () => {
    const template = await createExpiryFixture([{ expiresIn: '1 hour', template: true }]);
    const open = await createExpiryFixture([{ expiresIn: null }]);
    const client = new Client({ connectionString: whatsappUrl(databaseUrl!) });
    await client.connect();
    try {
      const ended = await expiredIds(client);
      expect(ended).not.toContain(template.outboxIds[0]);
      expect(ended).not.toContain(open.outboxIds[0]);

      const leased = await leasedIds(client);
      expect(leased).toContain(template.outboxIds[0]);
      expect(leased).toContain(open.outboxIds[0]);
      expect((await readExpiryState(template, 0)).outboxStatus).toBe('send_unknown');
      expect((await readExpiryState(open, 0)).outboxStatus).toBe('send_unknown');
    } finally {
      await client.end();
      await removeExpiryFixture(template);
      await removeExpiryFixture(open);
    }
  });

  it("does not let an expired row hold up the same worker's later row", async () => {
    // The lease sends one worker's rows in release order, and an earlier
    // pending row holds the later ones back. An expired row is never sent,
    // so it must not hold anything back.
    const fixture = await createExpiryFixture([{ expiresIn: '-1 minute' }, { expiresIn: '1 hour' }]);
    const client = new Client({ connectionString: whatsappUrl(databaseUrl!) });
    await client.connect();
    try {
      const leased = await leasedIds(client);
      expect(leased).not.toContain(fixture.outboxIds[0]);
      expect(leased).toContain(fixture.outboxIds[1]);
    } finally {
      await client.end();
      await removeExpiryFixture(fixture);
    }
  });

  it('leaves a row that is already being sent alone, even once its intent expires', async () => {
    const fixture = await createExpiryFixture([{ expiresIn: '1 hour' }]);
    const client = new Client({ connectionString: whatsappUrl(databaseUrl!) });
    await client.connect();
    try {
      const lease = await client.query<{ id: string; lease_token: string }>(
        'SELECT id, lease_token FROM lease_worker_intent_outbox(100)',
      );
      const own = lease.rows.find((row) => row.id === fixture.outboxIds[0]);
      expect(own).toBeDefined();

      const owner = new Client({ connectionString: databaseUrl! });
      await owner.connect();
      try {
        await owner.query(
          `UPDATE worker_message_intents SET expires_at = now() - interval '1 minute' WHERE id = $1`,
          [fixture.intentIds[0]],
        );
      } finally {
        await owner.end();
      }

      // Its delivery state is the sender's to settle, not the expiry pass's.
      expect(await expiredIds(client)).not.toContain(fixture.outboxIds[0]);
      expect((await readExpiryState(fixture, 0)).outboxStatus).toBe('send_unknown');
      const completed = await client.query<{ completed: boolean }>(
        'SELECT complete_worker_intent_outbox($1, $2, $3) AS completed',
        [fixture.outboxIds[0], own!.lease_token, `SM${'4'.repeat(32)}`],
      );
      expect(completed.rows[0].completed).toBe(true);
    } finally {
      await client.end();
      await removeExpiryFixture(fixture);
    }
  });

  it('ends every intent a grouped row carries, and the employer messages read failed', async () => {
    const fixture = await createEmployerChatFixture();
    const owner = new Client({ connectionString: databaseUrl! });
    await owner.connect();
    try {
      await owner.query(
        `UPDATE worker_message_intents SET expires_at = now() - interval '1 minute' WHERE id = ANY($1::uuid[])`,
        [fixture.intentIds],
      );
    } finally {
      await owner.end();
    }
    const client = new Client({ connectionString: whatsappUrl(databaseUrl!) });
    await client.connect();
    try {
      expect(await expiredIds(client)).toContain(fixture.outboxId);
      // The intents are ended before the outbox row, so 043's delivery-state
      // trigger (which marks 'released' intents 'failed') finds none left.
      expect(await loadFixtureState(fixture)).toEqual({
        outboxStatus: 'failed',
        intentStatuses: ['expired', 'expired'],
        messageStatuses: ['failed', 'failed'],
        messageSids: [null, null],
      });
    } finally {
      await client.end();
      await removeEmployerChatFixture(fixture);
    }
  });
});
