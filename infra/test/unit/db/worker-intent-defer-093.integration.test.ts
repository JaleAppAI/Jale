import { randomUUID } from 'node:crypto';
import { Client } from 'pg';

/**
 * Migration 093's `defer_worker_intent_outbox`, against a real database.
 *
 * It belongs here rather than in a mocked suite for three reasons, none of
 * which a mocked pool can hold:
 *
 *  1. 043's `whatsapp_outbox_worker_intent_lease_consistency` CHECK. It
 *     admits a set lease token ONLY alongside a set deadline AND
 *     status = 'send_unknown'. A defer that clears one column of the pair, or
 *     moves the row to 'pending' with the pair still set, is a 23514 -- and
 *     the SQL that does it type-checks perfectly.
 *  2. The fence. `worker_intent_lease_token = p_lease_token` AND
 *     `worker_intent_leased_until > now()` are two conditions in a WHERE
 *     clause; dropping either one is a zero-row-vs-one-row difference that
 *     only real MVCC and a real clock decide.
 *  3. attempt_count. The reason this function exists is that it does NOT
 *     advance the retry budget. Proving that means leasing a row (which
 *     increments it), deferring, and reading the counter back.
 *
 * Every case runs the lease and the defer as `jale_whatsapp`, the role the
 * drain Lambda actually connects as. That role holds no UPDATE on a
 * worker_intent outbox row at all (043 revoked it and added a RESTRICTIVE
 * policy), so if the definer or its EXECUTE grant were wrong these would fail
 * rather than pass on ambient privilege -- and one case proves that directly.
 */
const databaseUrl = process.env.JALE_TEST_DATABASE_URL;
const describeWithDatabase = databaseUrl ? describe : describe.skip;

const DEFER_REASON = 'twilio_63016_template_pending';
const ONE_HOUR_SECONDS = 3600;

function whatsappUrl(source: string): string {
  const url = new URL(source);
  url.username = 'jale_whatsapp';
  url.password = 'test-whatsapp-pw';
  return url.toString();
}

interface DeferFixture {
  workerId: string;
  intentId: string;
  outboxId: string;
}

interface OutboxState {
  status: string;
  attemptCount: number;
  nextAttemptAt: Date | null;
  lastError: string | null;
  leaseToken: string | null;
  leasedUntil: Date | null;
}

async function superuser(): Promise<Client> {
  const client = new Client({ connectionString: databaseUrl! });
  await client.connect();
  return client;
}

/**
 * A committed worker + intent + pending worker_intent outbox row. Committed
 * (rather than living inside one rolled-back transaction, as the 043 suite's
 * first case does) because two of the cases below have to back-date a column
 * `jale_whatsapp` is not granted -- created_at and worker_intent_leased_until
 * -- which means a second connection has to see the row.
 */
async function createDeferFixture(
  options: { createdAtHoursAgo?: number } = {},
): Promise<DeferFixture> {
  const fixture: DeferFixture = {
    workerId: randomUUID(),
    intentId: randomUUID(),
    outboxId: randomUUID(),
  };
  const client = await superuser();
  try {
    await client.query(
      `INSERT INTO users (id, cognito_sub, user_type, whatsapp_number)
       VALUES ($1, $2, 'worker', $3)`,
      [
        fixture.workerId,
        `defer-093-${fixture.workerId}`,
        // A distinct number per fixture: `whatsapp_number` is the transport
        // address, and two live fixtures sharing one would make the lease
        // ordering assertions depend on test execution order.
        `+1512${String(Math.floor(Math.random() * 10_000_000)).padStart(7, '0')}`,
      ],
    );
    // 013's whatsapp_outbox_body_or_template CHECK is exclusive: a templated
    // row carries content_template + content_variables and a NULL body. This
    // is the shape application-stage-notify.ts enqueues -- an
    // `application_*` template, which is precisely the class 63016 rejects
    // while Meta approval is pending.
    await client.query(
      `INSERT INTO whatsapp_outbox
         (id, inbound_message_sid, sequence, whatsapp_number, body, content_template,
          content_variables, source_type, source_id, attempt_count, created_at)
       VALUES ($1, NULL, 1, '+15125550199', NULL, 'application_update_en',
               '{"1": "Concrete Finisher"}'::jsonb, 'worker_intent', $2, 0,
               now() - make_interval(hours => $3::int))`,
      [fixture.outboxId, fixture.intentId, options.createdAtHoursAgo ?? 0],
    );
    await client.query(
      `INSERT INTO worker_message_intents
         (id, user_id, category, owner_service, source_type, source_id, dedupe_key,
          priority, status, policy_version, release_sequence, outbox_id)
       VALUES ($1, $2, 'account', 'account', 'job_application', $3, $4,
               40, 'released', 1, 1, $5)`,
      [fixture.intentId, fixture.workerId, randomUUID(),
        `defer-093-${fixture.intentId}`, fixture.outboxId],
    );
    return fixture;
  } finally {
    await client.end();
  }
}

async function removeDeferFixture(fixture: DeferFixture): Promise<void> {
  const client = await superuser();
  try {
    // worker_message_intents.outbox_id is ON DELETE SET NULL, so the intent
    // has to go first or the outbox delete leaves an orphan behind.
    await client.query('DELETE FROM worker_message_intents WHERE id = $1', [fixture.intentId]);
    await client.query('DELETE FROM whatsapp_outbox WHERE id = $1', [fixture.outboxId]);
    await client.query('DELETE FROM users WHERE id = $1', [fixture.workerId]);
  } finally {
    await client.end();
  }
}

async function readOutbox(outboxId: string): Promise<OutboxState> {
  const client = await superuser();
  try {
    const result = await client.query<{
      status: string;
      attempt_count: number;
      next_attempt_at: Date | null;
      last_error: string | null;
      worker_intent_lease_token: string | null;
      worker_intent_leased_until: Date | null;
    }>(
      `SELECT status, attempt_count, next_attempt_at, last_error,
              worker_intent_lease_token, worker_intent_leased_until
         FROM whatsapp_outbox WHERE id = $1`,
      [outboxId],
    );
    const row = result.rows[0];
    return {
      status: row.status,
      attemptCount: Number(row.attempt_count),
      nextAttemptAt: row.next_attempt_at,
      lastError: row.last_error,
      leaseToken: row.worker_intent_lease_token,
      leasedUntil: row.worker_intent_leased_until,
    };
  } finally {
    await client.end();
  }
}

/**
 * Leases through 043's definer and returns the token for OUR row. The lease
 * is global (it is a definer owned by jale_admin, and it deliberately ignores
 * the caller's worker context), so a testbed carrying rows from another suite
 * would hand back more than one -- and would advance THEIR attempt_count as a
 * side effect. Hence two things: the row is looked up by id rather than by
 * asserting on the batch size, and this suite is registered LAST in
 * scripts/run-whatsapp-v2-db-tests.sh so the side effect cannot reach a suite
 * that has yet to run.
 */
async function leaseOwnRow(client: Client, outboxId: string): Promise<string> {
  const leased = await client.query<{ id: string; lease_token: string }>(
    'SELECT * FROM lease_worker_intent_outbox(100)',
  );
  const mine = leased.rows.find((row) => row.id === outboxId);
  if (!mine) throw new Error('fixture row was not leased');
  return mine.lease_token;
}

describeWithDatabase('migration 093 defer_worker_intent_outbox', () => {
  const su = new Client({ connectionString: databaseUrl });

  beforeAll(async () => {
    await su.connect();
    if (new URL(databaseUrl as string).username !== 'jale_whatsapp') {
      await su.query(`ALTER ROLE jale_whatsapp WITH PASSWORD 'test-whatsapp-pw'`);
    }
  });

  afterAll(async () => {
    await su.end();
  });

  it('reschedules a leased row without spending an attempt', async () => {
    const fixture = await createDeferFixture();
    const client = new Client({ connectionString: whatsappUrl(databaseUrl!) });
    await client.connect();
    try {
      const leaseToken = await leaseOwnRow(client, fixture.outboxId);
      const afterLease = await readOutbox(fixture.outboxId);
      expect(afterLease.status).toBe('send_unknown');
      expect(afterLease.attemptCount).toBe(1);

      const deferred = await client.query<{ deferred: boolean }>(
        'SELECT defer_worker_intent_outbox($1, $2, $3, $4) AS deferred',
        [fixture.outboxId, leaseToken, DEFER_REASON, ONE_HOUR_SECONDS],
      );
      expect(deferred.rows[0].deferred).toBe(true);

      const state = await readOutbox(fixture.outboxId);
      expect(state.status).toBe('pending');
      // THE contract: the lease spent attempt 1 and the defer spent nothing.
      // fail_worker_intent_outbox in the same position would leave 1 here too
      // but would have consumed one of the five, and would come back at 5.
      expect(state.attemptCount).toBe(1);
      expect(state.lastError).toBe(DEFER_REASON);

      // ~1 hour out, not "now" and not never. Asserted as a window because
      // now() is the database's clock, not this process's.
      expect(state.nextAttemptAt).not.toBeNull();
      const delaySeconds = (state.nextAttemptAt!.getTime() - Date.now()) / 1000;
      expect(delaySeconds).toBeGreaterThan(ONE_HOUR_SECONDS - 300);
      expect(delaySeconds).toBeLessThan(ONE_HOUR_SECONDS + 300);

      // Both lease columns released together -- 043's CHECK would have
      // rejected the UPDATE outright otherwise, so reaching this line at all
      // is half the assertion.
      expect(state.leaseToken).toBeNull();
      expect(state.leasedUntil).toBeNull();
    } finally {
      await client.end();
      await removeDeferFixture(fixture);
    }
  });

  it('is re-leasable once the deferral window has passed', async () => {
    const fixture = await createDeferFixture();
    const client = new Client({ connectionString: whatsappUrl(databaseUrl!) });
    await client.connect();
    try {
      const leaseToken = await leaseOwnRow(client, fixture.outboxId);
      await client.query(
        'SELECT defer_worker_intent_outbox($1, $2, $3, $4) AS deferred',
        [fixture.outboxId, leaseToken, DEFER_REASON, ONE_HOUR_SECONDS],
      );

      // Still parked: the lease must not hand back a row whose next_attempt_at
      // is an hour away, or the defer would be a no-op busy loop.
      const early = await client.query<{ id: string }>(
        'SELECT * FROM lease_worker_intent_outbox(100)',
      );
      expect(early.rows.some((row) => row.id === fixture.outboxId)).toBe(false);

      // Pull the deadline into the past (a column jale_whatsapp is not
      // granted) and it comes back, on attempt 2 -- so the row really is
      // alive, not merely 'pending' on paper.
      await su.query(
        `UPDATE whatsapp_outbox SET next_attempt_at = now() - interval '1 minute'
          WHERE id = $1`,
        [fixture.outboxId],
      );
      const releasedToken = await leaseOwnRow(client, fixture.outboxId);
      expect(releasedToken).not.toBe(leaseToken);
      expect((await readOutbox(fixture.outboxId)).attemptCount).toBe(2);
    } finally {
      await client.end();
      await removeDeferFixture(fixture);
    }
  });

  it('ends a row older than 48 hours instead of deferring it forever', async () => {
    // Budget-neutral retrying is unbounded by construction, so age is the
    // only thing that stops it. 72h in: terminal.
    const fixture = await createDeferFixture({ createdAtHoursAgo: 72 });
    const client = new Client({ connectionString: whatsappUrl(databaseUrl!) });
    await client.connect();
    try {
      const leaseToken = await leaseOwnRow(client, fixture.outboxId);
      const deferred = await client.query<{ deferred: boolean }>(
        'SELECT defer_worker_intent_outbox($1, $2, $3, $4) AS deferred',
        [fixture.outboxId, leaseToken, DEFER_REASON, ONE_HOUR_SECONDS],
      );
      // TRUE: the row was claimed and written. The outcome is terminal, but
      // the caller's fence held, which is what the boolean reports.
      expect(deferred.rows[0].deferred).toBe(true);

      const state = await readOutbox(fixture.outboxId);
      expect(state.status).toBe('failed');
      // No further attempt is ever scheduled, and the reason survives for the
      // operator who has to explain the missing notification.
      expect(state.nextAttemptAt).toBeNull();
      expect(state.lastError).toBe(DEFER_REASON);
      expect(state.attemptCount).toBe(1);
      expect(state.leaseToken).toBeNull();
      expect(state.leasedUntil).toBeNull();
    } finally {
      await client.end();
      await removeDeferFixture(fixture);
    }
  });

  it('keeps a row one second short of 48 hours deferrable', async () => {
    // The boundary in the other direction: 47h is still inside the window, so
    // an off-by-one comparison (>= vs <, or an interval typo) is caught here
    // rather than by a notification that silently stopped arriving a day early.
    const fixture = await createDeferFixture({ createdAtHoursAgo: 47 });
    const client = new Client({ connectionString: whatsappUrl(databaseUrl!) });
    await client.connect();
    try {
      const leaseToken = await leaseOwnRow(client, fixture.outboxId);
      await client.query(
        'SELECT defer_worker_intent_outbox($1, $2, $3, $4) AS deferred',
        [fixture.outboxId, leaseToken, DEFER_REASON, ONE_HOUR_SECONDS],
      );
      const state = await readOutbox(fixture.outboxId);
      expect(state.status).toBe('pending');
      expect(state.nextAttemptAt).not.toBeNull();
    } finally {
      await client.end();
      await removeDeferFixture(fixture);
    }
  });

  it('refuses a wrong lease token and changes nothing', async () => {
    const fixture = await createDeferFixture();
    const client = new Client({ connectionString: whatsappUrl(databaseUrl!) });
    await client.connect();
    try {
      const leaseToken = await leaseOwnRow(client, fixture.outboxId);
      const before = await readOutbox(fixture.outboxId);

      const deferred = await client.query<{ deferred: boolean }>(
        'SELECT defer_worker_intent_outbox($1, $2, $3, $4) AS deferred',
        [fixture.outboxId, randomUUID(), DEFER_REASON, ONE_HOUR_SECONDS],
      );
      expect(deferred.rows[0].deferred).toBe(false);

      const after = await readOutbox(fixture.outboxId);
      expect(after).toEqual(before);
      // The real holder's lease is untouched, so the drain that owns it can
      // still complete or fail the row.
      expect(after.leaseToken).toBe(leaseToken);
      expect(after.status).toBe('send_unknown');
    } finally {
      await client.end();
      await removeDeferFixture(fixture);
    }
  });

  it('refuses an expired lease even with the correct token', async () => {
    // The second half of the fence, and the reason it is not token-only: once
    // the 15-minute lease lapses the delivery state is UNKNOWN (043 clears
    // the token but deliberately never requeues such a row). Deferring it
    // back to 'pending' would resend a message Twilio may already have taken.
    const fixture = await createDeferFixture();
    const client = new Client({ connectionString: whatsappUrl(databaseUrl!) });
    await client.connect();
    try {
      const leaseToken = await leaseOwnRow(client, fixture.outboxId);
      await su.query(
        `UPDATE whatsapp_outbox SET worker_intent_leased_until = now() - interval '1 minute'
          WHERE id = $1`,
        [fixture.outboxId],
      );
      const before = await readOutbox(fixture.outboxId);

      const deferred = await client.query<{ deferred: boolean }>(
        'SELECT defer_worker_intent_outbox($1, $2, $3, $4) AS deferred',
        [fixture.outboxId, leaseToken, DEFER_REASON, ONE_HOUR_SECONDS],
      );
      expect(deferred.rows[0].deferred).toBe(false);
      expect(await readOutbox(fixture.outboxId)).toEqual(before);
    } finally {
      await client.end();
      await removeDeferFixture(fixture);
    }
  });

  it.each([
    ['zero', 0],
    ['negative', -1],
    ['beyond one day', 86_401],
  ])('rejects a %s delay rather than guessing (22023)', async (_label, delaySeconds) => {
    const fixture = await createDeferFixture();
    const client = new Client({ connectionString: whatsappUrl(databaseUrl!) });
    await client.connect();
    try {
      const leaseToken = await leaseOwnRow(client, fixture.outboxId);
      await expect(client.query(
        'SELECT defer_worker_intent_outbox($1, $2, $3, $4) AS deferred',
        [fixture.outboxId, leaseToken, DEFER_REASON, delaySeconds],
      )).rejects.toMatchObject({ code: '22023' });
      // The row is left exactly as leased -- a rejected call must not be a
      // half-applied one.
      expect((await readOutbox(fixture.outboxId)).status).toBe('send_unknown');
    } finally {
      await client.end();
      await removeDeferFixture(fixture);
    }
  });

  it('is the ONLY way jale_whatsapp can reschedule a worker_intent row', async () => {
    // Without this, every assertion above could be passing on ambient
    // privilege rather than on the definer. 043 took the fencing columns out
    // of the role's UPDATE grant (a 42501) and added a RESTRICTIVE policy
    // that hides worker_intent rows from the columns it kept (a silent
    // zero-row UPDATE, which is the more dangerous of the two).
    const fixture = await createDeferFixture();
    const client = new Client({ connectionString: whatsappUrl(databaseUrl!) });
    await client.connect();
    try {
      await expect(client.query(
        `UPDATE whatsapp_outbox SET worker_intent_lease_token = NULL WHERE id = $1`,
        [fixture.outboxId],
      )).rejects.toMatchObject({ code: '42501' });

      const direct = await client.query(
        `UPDATE whatsapp_outbox
            SET status = 'pending', next_attempt_at = now() + interval '1 hour'
          WHERE id = $1`,
        [fixture.outboxId],
      );
      expect(direct.rowCount).toBe(0);
      expect((await readOutbox(fixture.outboxId)).status).toBe('pending');
      expect((await readOutbox(fixture.outboxId)).nextAttemptAt).toBeNull();
    } finally {
      await client.end();
      await removeDeferFixture(fixture);
    }
  });
});
