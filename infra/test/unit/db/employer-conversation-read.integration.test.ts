/**
 * employer-conversation-read.integration.test.ts
 *
 * Sprint 26 T3a. The employer unread badge against REAL PostgreSQL 16: the
 * mark-read UPDATE that `lambda/api/employer-conversations-read.ts` issues,
 * executed AS THE TEXT IN THAT FILE against the real `job_conversations`
 * policies, and the inbox `unread` derivation driven through
 * `listEmployerInbox` on the same connection.
 *
 * WHY A MOCKED POOL CANNOT COVER ANY OF THIS.
 *
 * `job_conversations` is ENABLE + FORCE ROW LEVEL SECURITY (025:87-88) and the
 * policy that governs this write is `job_conversations_employer_all FOR ALL TO
 * jale_admin` (025:93-97), keyed on the `app.current_internal_user_id` GUC.
 * FORCE is the part that matters: `jale_admin` OWNS this table and is the role
 * the API Lambdas connect as, so without FORCE the owner would bypass the
 * policy entirely.
 *
 * That makes every interesting outcome here a ZERO-ROW result rather than an
 * error:
 *   * another employer's conversation -> the policy filters the row out and
 *     the UPDATE reports success having changed nothing. A mocked pool returns
 *     whatever the test told it to, so the unit suite's 404 case proves only
 *     that the handler maps rowCount 0 to a 404 -- NOT that the database
 *     actually produces rowCount 0 for a foreign row. This file is the half
 *     that proves it.
 *   * a missing `setInternalUserRlsContext` -> the policy evaluates
 *     `employer_id::text = NULL`, which matches NOTHING, and the employer gets
 *     a 404 on their OWN conversation. Case 4 measures that trap rather than
 *     describing it, because it is the single most likely way this endpoint
 *     breaks in production.
 *
 * Case 3 is the verification skill's checklist item 1, stated as a test: the
 * mark-read UPDATE with its WHERE clause REMOVED must still be confined to the
 * calling employer's own rows. If a future migration relaxes that policy to
 * `USING (true)`, the handler's own `employer_id = $2` predicate keeps the
 * shipped statement correct while this case goes red -- which is the point of
 * probing the policy separately from the statement.
 *
 * THE STATEMENT IS EXTRACTED FROM THE HANDLER SOURCE, not re-typed. A copy
 * would drift from the shipped SQL the first time either side was edited, and
 * drift is exactly what the unit suite cannot catch.
 *
 * The unread derivation is driven through the REAL `listEmployerInbox`, which
 * settles a fact no string fixture can: `node-postgres` hands `timestamptz`
 * back as a `Date`, and comparing two Dates as strings ("Thu Sep 10 ...") is
 * not chronological. The unit suite pins the Date path with hand-built Dates;
 * this one proves the driver really does return them.
 *
 * Everything -- seed and assertions alike -- happens in ONE transaction on ONE
 * connection, rolled back at the end. `SET LOCAL ROLE jale_admin` is what
 * subjects the superuser session to RLS (a superuser that has SET ROLE'd to a
 * non-superuser role is no longer exempt), the same approach
 * employer-worker-reads.integration.test.ts uses, so no role passwords are
 * needed. Seeding happens under `RESET ROLE`.
 *
 * NO MIGRATION IS APPLIED HERE. `job_conversations.employer_last_read_at` has
 * existed since 028:37; sprint 26 is the first code to write it.
 *
 * Set JALE_TEST_DATABASE_URL to a superuser connection string for an isolated,
 * disposable database (see db/local/bootstrap-testbed.sh).
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import { Client, type PoolClient } from 'pg';

import { listEmployerInbox } from '../../../lambda/lib/employer-inbox';

const databaseUrl = process.env.JALE_TEST_DATABASE_URL;

const HANDLER_PATH = path.join(
  __dirname, '..', '..', '..', 'lambda', 'api', 'employer-conversations-read.ts',
);

/**
 * The mark-read UPDATE, lifted out of the handler. `$1` conversation id,
 * `$2` employer id -- the same binding the Lambda uses.
 */
function markReadSql(): string {
  const source = fs.readFileSync(HANDLER_PATH, 'utf8');
  const match = source.match(
    /UPDATE job_conversations\s+SET employer_last_read_at = now\(\)[\s\S]*?RETURNING employer_last_read_at/,
  );
  expect(match).not.toBeNull();
  return match![0];
}

if (!databaseUrl) {
  test('CONCERN: employer conversation mark-read PostgreSQL gate was not run', () => {
    // eslint-disable-next-line no-console
    console.warn(
      '[employer-conversation-read] DONE_WITH_CONCERNS: set JALE_TEST_DATABASE_URL to a ' +
        'disposable PostgreSQL 16 database with migrations 001-095 applied to run the ' +
        'real-PostgreSQL gate for the employer unread badge.',
    );
    expect(databaseUrl).toBeUndefined();
  });
}

const maybeDescribe = databaseUrl ? describe : describe.skip;

maybeDescribe('employer conversation mark-read against real PostgreSQL', () => {
  const suffix = randomUUID().slice(0, 8);
  const workerSub = `s26t3a-worker-${suffix}`;

  let client: Client;
  let worker: string;
  let seq = 0;
  let scenario = 0;

  /**
   * Every case gets its OWN employer, and every conversation its own job.
   *
   * Not tidiness: the cases MUTATE shared state (case 3 is a blanket UPDATE
   * over everything the caller can see, and the inbox reads count rows across
   * the whole employer), so a shared fixture would make each case's result
   * depend on the order the previous ones ran in. Fresh employers make the
   * suite order-independent, which is what lets a single failure be read as a
   * single cause.
   */
  type Employer = { id: string; sub: string };

  async function newEmployer(): Promise<Employer> {
    seq += 1;
    const sub = `s26t3a-employer-${suffix}-${seq}`;
    const id = (
      await client.query<{ id: string }>(
        `INSERT INTO users (cognito_sub, user_type) VALUES ($1, 'employer') RETURNING id`,
        [sub],
      )
    ).rows[0].id;
    return { id, sub };
  }

  /**
   * One job + one application + one open conversation. A job per conversation
   * because 025's `job_conversations_open_unique` is partial on
   * (job_id, employer_id, worker_id) WHERE status = 'open', so one employer
   * cannot hold two open threads with the same worker on the same job.
   */
  async function newConversation(
    employerId: string,
    lastWorkerMessageAt: string | null,
  ): Promise<string> {
    seq += 1;
    const jobId = (
      await client.query<{ id: string }>(
        `INSERT INTO jobs (employer_id, title, location, job_type, status)
         VALUES ($1, $2, 'Austin', 'full-time', 'active') RETURNING id`,
        [employerId, `S26 T3a unread ${seq}`],
      )
    ).rows[0].id;
    const applicationId = (
      await client.query<{ id: string }>(
        `INSERT INTO job_applications (job_id, worker_id, status)
         VALUES ($1, $2, 'pending') RETURNING id`,
        [jobId, worker],
      )
    ).rows[0].id;
    return (
      await client.query<{ id: string }>(
        `INSERT INTO job_conversations
           (job_id, employer_id, worker_id, application_id, status,
            last_message_at, last_worker_message_at)
         VALUES ($1, $2, $3, $4, 'open', $5, $5) RETURNING id`,
        [jobId, employerId, worker, applicationId, lastWorkerMessageAt],
      )
    ).rows[0].id;
  }

  /**
   * Runs `fn` as jale_admin with the two RLS session variables the handler
   * binds, then hands the session back to the superuser. Both GUCs are
   * transaction-local and this whole suite is one transaction, so every
   * scenario sets both explicitly rather than inheriting the last one.
   *
   * `employer` of `null` deliberately leaves `app.current_internal_user_id`
   * EMPTY -- case 4's trap. `app.current_user_id` is still bound to the real
   * cognito_sub in that case, because the handler binds it first and the trap
   * being measured is the MISSING SECOND context, not an unauthenticated call.
   */
  async function asEmployer<T>(
    employer: Employer,
    fn: () => Promise<T>,
    options: { withInternalUserContext?: boolean } = {},
  ): Promise<T> {
    // A SAVEPOINT per scenario: one raise would otherwise abort the shared
    // transaction and bury the real cause under "current transaction is
    // aborted" from every later case.
    const savepoint = `s_${(scenario += 1)}`;
    await client.query(`SAVEPOINT ${savepoint}`);
    // Both GUCs, as the handler binds them: app.current_user_id carries the
    // Cognito sub that the users/jobs/job_applications policies key on (the
    // inbox query joins all three, so a wrong sub is a silently EMPTY inbox,
    // not an error), and app.current_internal_user_id is what 025's
    // job_conversations policy keys on.
    await client.query(`SELECT set_config('app.current_user_id', $1, true)`, [employer.sub]);
    await client.query(
      `SELECT set_config('app.current_internal_user_id', $1, true)`,
      [options.withInternalUserContext === false ? '' : employer.id],
    );
    await client.query('SET LOCAL ROLE jale_admin');
    try {
      const result = await fn();
      await client.query('RESET ROLE');
      await client.query(`RELEASE SAVEPOINT ${savepoint}`);
      return result;
    } catch (error) {
      await client.query(`ROLLBACK TO SAVEPOINT ${savepoint}`).catch(() => undefined);
      await client.query('RESET ROLE').catch(() => undefined);
      throw error;
    }
  }

  /** Superuser read -- RLS-free, so "missing" here means missing, not filtered. */
  async function readStamp(conversationId: string): Promise<Date | null> {
    const res = await client.query<{ employer_last_read_at: Date | null }>(
      'SELECT employer_last_read_at FROM job_conversations WHERE id = $1',
      [conversationId],
    );
    return res.rows[0].employer_last_read_at;
  }

  beforeAll(async () => {
    client = new Client({ connectionString: databaseUrl });
    await client.connect();
    await client.query('BEGIN');
    worker = (
      await client.query<{ id: string }>(
        `INSERT INTO users (cognito_sub, user_type) VALUES ($1, 'worker') RETURNING id`,
        [workerSub],
      )
    ).rows[0].id;
  });

  afterAll(async () => {
    if (!client) return;
    await client.query('ROLLBACK').catch(() => undefined);
    await client.end();
  });

  // ── Case 1 — the shipped statement, on the caller's own row ──────────────
  it("stamps the employer's OWN conversation and returns the new value", async () => {
    const employer = await newEmployer();
    const conversation = await newConversation(employer.id, '2026-09-10T12:00:00Z');
    expect(await readStamp(conversation)).toBeNull();

    const result = await asEmployer(employer, async () =>
      client.query<{ employer_last_read_at: Date }>(markReadSql(), [conversation, employer.id]));

    expect(result.rowCount).toBe(1);
    expect(result.rows[0].employer_last_read_at).toBeInstanceOf(Date);

    const after = await readStamp(conversation);
    expect(after).not.toBeNull();
    expect(after!.getTime()).toBe(result.rows[0].employer_last_read_at.getTime());
  });

  // ── Case 2 — the foreign row: zero rows, not an error, nothing touched ───
  it("touches ZERO rows on another employer's conversation, and leaves it untouched", async () => {
    const employerA = await newEmployer();
    const employerB = await newEmployer();
    const conversationB = await newConversation(employerB.id, '2026-09-10T12:00:00Z');
    expect(await readStamp(conversationB)).toBeNull();

    const result = await asEmployer(employerA, async () =>
      client.query(markReadSql(), [conversationB, employerA.id]));

    // No error: the policy FILTERS, it does not raise. rowCount 0 is the only
    // signal the handler gets, and it is what its 404 is built on.
    expect(result.rowCount).toBe(0);
    expect(await readStamp(conversationB)).toBeNull();
  });

  it('touches ZERO rows for a conversation id that does not exist at all', async () => {
    const employer = await newEmployer();
    const result = await asEmployer(employer, async () =>
      client.query(markReadSql(), [randomUUID(), employer.id]));
    // Indistinguishable from case 2 -- which is what keeps the endpoint from
    // being an existence oracle over every conversation id in the system.
    expect(result.rowCount).toBe(0);
  });

  // ── Case 3 — RLS scoping, checklist item 1: the WHERE clause removed ─────
  it("confines an UNQUALIFIED blanket UPDATE to the calling employer's own rows", async () => {
    const employerA = await newEmployer();
    const employerB = await newEmployer();
    const ownFirst = await newConversation(employerA.id, '2026-09-10T12:00:00Z');
    const ownSecond = await newConversation(employerA.id, '2026-09-10T13:00:00Z');
    const foreign = await newConversation(employerB.id, '2026-09-10T14:00:00Z');

    const result = await asEmployer(employerA, async () =>
      client.query('UPDATE job_conversations SET employer_last_read_at = now()'));

    // Exactly A's two rows, out of every job_conversations row in the
    // database. B's survives an UPDATE that named no rows at all -- that is
    // the policy doing the work, not the handler's WHERE clause.
    expect(result.rowCount).toBe(2);
    expect(await readStamp(ownFirst)).not.toBeNull();
    expect(await readStamp(ownSecond)).not.toBeNull();
    expect(await readStamp(foreign)).toBeNull();
  });

  // ── Case 4 — the trap: a missing internal-user GUC is a SILENT no-op ─────
  it("touches ZERO rows on the employer's OWN conversation when the internal-user GUC is unset", async () => {
    const employer = await newEmployer();
    const conversation = await newConversation(employer.id, '2026-09-10T12:00:00Z');

    const result = await asEmployer(
      employer,
      async () => client.query(markReadSql(), [conversation, employer.id]),
      { withInternalUserContext: false },
    );

    // `employer_id::text = current_setting(..., true)` against an empty GUC
    // matches nothing. No error, no rows -- so a handler that forgot
    // setInternalUserRlsContext would 404 the employer on their own thread,
    // and every unit test with a mocked pool would still be green.
    expect(result.rowCount).toBe(0);
    expect(await readStamp(conversation)).toBeNull();
  });

  // ── Case 5 — the read side, end to end, with REAL Date values ────────────
  describe('listEmployerInbox unread derivation', () => {
    it('reports unread with no read stamp, and clears exactly the thread that was read', async () => {
      const employer = await newEmployer();
      const read = await newConversation(employer.id, '2026-09-10T12:00:00Z');
      const untouched = await newConversation(employer.id, '2026-09-10T13:00:00Z');

      const before = await asEmployer(employer, async () =>
        listEmployerInbox(client as unknown as PoolClient, employer.id));

      expect(before.unread_count).toBe(2);
      expect(before.items.every((item) => item.unread)).toBe(true);
      // The raw stamp stays server-side.
      expect(Object.keys(before.items[0])).not.toContain('employer_last_read_at');

      const after = await asEmployer(employer, async () => {
        await client.query(markReadSql(), [read, employer.id]);
        return listEmployerInbox(client as unknown as PoolClient, employer.id);
      });

      expect(after.unread_count).toBe(1);
      expect(after.items.find((item) => item.conversation_id === read)?.unread).toBe(false);
      expect(after.items.find((item) => item.conversation_id === untouched)?.unread).toBe(true);
    });

    // The Date-vs-string fact. node-postgres returns timestamptz as a Date,
    // and Dates compared as strings ("Thu Sep 10 ...") are not chronological.
    it('flips back to unread when the worker writes AFTER the read stamp', async () => {
      const employer = await newEmployer();
      const conversation = await newConversation(employer.id, '2026-09-10T12:00:00Z');

      const inbox = await asEmployer(employer, async () => {
        await client.query(markReadSql(), [conversation, employer.id]);
        await client.query(
          `UPDATE job_conversations
              SET last_worker_message_at = employer_last_read_at + interval '1 second',
                  last_message_at = employer_last_read_at + interval '1 second'
            WHERE id = $1`,
          [conversation],
        );
        return listEmployerInbox(client as unknown as PoolClient, employer.id);
      });

      expect(inbox.unread_count).toBe(1);
      expect(inbox.items[0].unread).toBe(true);
    });

    it('treats a read stamped at the EXACT instant of the last worker message as read', async () => {
      const employer = await newEmployer();
      const conversation = await newConversation(employer.id, '2026-09-10T12:00:00Z');

      const inbox = await asEmployer(employer, async () => {
        await client.query(markReadSql(), [conversation, employer.id]);
        await client.query(
          `UPDATE job_conversations
              SET last_worker_message_at = employer_last_read_at
            WHERE id = $1`,
          [conversation],
        );
        return listEmployerInbox(client as unknown as PoolClient, employer.id);
      });

      expect(inbox.unread_count).toBe(0);
      expect(inbox.items[0].unread).toBe(false);
    });

    // A never-messaged applicant has a job and an application but no
    // conversation row, so both timestamps arrive NULL from the LATERAL.
    it('never counts an applicant the worker has not written to', async () => {
      const employer = await newEmployer();
      seq += 1;
      const jobId = (
        await client.query<{ id: string }>(
          `INSERT INTO jobs (employer_id, title, location, job_type, status)
           VALUES ($1, $2, 'Austin', 'full-time', 'active') RETURNING id`,
          [employer.id, `S26 T3a no-thread ${seq}`],
        )
      ).rows[0].id;
      await client.query(
        `INSERT INTO job_applications (job_id, worker_id, status) VALUES ($1, $2, 'pending')`,
        [jobId, worker],
      );

      const inbox = await asEmployer(employer, async () =>
        listEmployerInbox(client as unknown as PoolClient, employer.id));

      expect(inbox.items).toHaveLength(1);
      expect(inbox.items[0].conversation_id).toBeNull();
      expect(inbox.items[0].unread).toBe(false);
      expect(inbox.unread_count).toBe(0);
    });

    it("never counts another employer's unread threads", async () => {
      const employerA = await newEmployer();
      const employerB = await newEmployer();
      await newConversation(employerA.id, '2026-09-10T12:00:00Z');
      const ownB = await newConversation(employerB.id, '2026-09-10T12:00:00Z');

      const inbox = await asEmployer(employerB, async () =>
        listEmployerInbox(client as unknown as PoolClient, employerB.id));

      expect(inbox.items.map((item) => item.conversation_id)).toEqual([ownB]);
      expect(inbox.unread_count).toBe(1);
    });
  });
});
