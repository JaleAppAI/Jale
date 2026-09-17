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
 * THE SECOND BLOCK APPLIES MIGRATION 096 FROM THE FILE ITSELF, as the real
 * non-superuser `jale_admin`. It has to. `employer_last_read_at` has existed
 * since 028:37 with nothing ever writing it, so 096 backfills the history to
 * stop the badge lighting up every thread on day one -- and job_conversations
 * is RLS ENABLE + FORCE with GUC-keyed policies, so that backfill rewrites
 * ZERO rows and reports success if the file forgets its un-force. Applied as
 * the SUPERUSER (who bypasses RLS entirely) a 096 that forgot it would pass
 * perfectly, which is why that block uses a second, password-authenticated
 * connection as jale_admin rather than SET LOCAL ROLE.
 *
 * That block's fixtures are COMMITTED, unlike the first block's: the migration
 * runs on its own connection and cannot see an uncommitted row. They are
 * deleted in its afterAll.
 *
 * Set JALE_TEST_DATABASE_URL to a superuser connection string for an isolated,
 * disposable database with migrations 001-096 applied (see
 * db/local/bootstrap-testbed.sh).
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import { Client, type PoolClient } from 'pg';

import { listEmployerInbox } from '../../../lambda/lib/employer-inbox';

const databaseUrl = process.env.JALE_TEST_DATABASE_URL;

// The mark-read UPDATE moved out of the handler and into the shared
// conversation SQL module in round 2, next to closeEmployerConversation.
const MESSAGING_LIB_PATH = path.join(
  __dirname, '..', '..', '..', 'lambda', 'lib', 'job-messaging.ts',
);

const MIGRATION_096_PATH = path.join(
  __dirname, '..', '..', '..', 'db', 'migrations',
  '096_job_conversations_employer_read_backfill.sql',
);

/** Swap the credentials in the superuser URL for another role's. */
function urlForRole(baseUrl: string, user: string, password: string): string {
  const u = new URL(baseUrl);
  u.username = user;
  u.password = password;
  return u.toString();
}

/**
 * The mark-read UPDATE, lifted out of `markEmployerConversationRead`.
 * `$1` conversation id, `$2` employer id -- the same binding the Lambda uses.
 *
 * Asserted UNIQUE, not just present: job-messaging.ts carries six other
 * `UPDATE job_conversations` statements, and a second writer of this column
 * appearing there is exactly the kind of drift this extraction exists to
 * catch -- it would mean a second, unreviewed way to clear the badge.
 */
function markReadSql(): string {
  const source = fs.readFileSync(MESSAGING_LIB_PATH, 'utf8');
  const matches = source.match(
    /UPDATE job_conversations\s+SET employer_last_read_at = now\(\)[\s\S]*?RETURNING employer_last_read_at/g,
  );
  expect(matches).toHaveLength(1);
  return matches![0];
}

if (!databaseUrl) {
  test('CONCERN: employer conversation mark-read PostgreSQL gate was not run', () => {
    // eslint-disable-next-line no-console
    console.warn(
      '[employer-conversation-read] DONE_WITH_CONCERNS: set JALE_TEST_DATABASE_URL to a ' +
        'disposable PostgreSQL 16 database with migrations 001-096 applied to run the ' +
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
    options: { applicationStatus?: string; inbound?: boolean } = {},
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
         VALUES ($1, $2, $3) RETURNING id`,
        [jobId, worker, options.applicationStatus ?? 'pending'],
      )
    ).rows[0].id;
    const conversationId = (
      await client.query<{ id: string }>(
        `INSERT INTO job_conversations
           (job_id, employer_id, worker_id, application_id, status,
            last_message_at, last_worker_message_at)
         VALUES ($1, $2, $3, $4, 'open', $5, $5) RETURNING id`,
        [jobId, employerId, worker, applicationId, lastWorkerMessageAt],
      )
    ).rows[0].id;
    // A REAL inbound message row. Since round 2 the badge keys on the newest
    // inbound message, not on last_worker_message_at -- which the "Open
    // conversation" path stamps with no message behind it -- so a fixture
    // that only sets the column proves nothing about the badge.
    if (options.inbound !== false && lastWorkerMessageAt !== null) {
      await client.query(
        `INSERT INTO job_conversation_messages
           (conversation_id, sender_type, direction, body, status, created_at)
         VALUES ($1, 'worker', 'inbound', 'probe inbound', 'received', $2)`,
        [conversationId, lastWorkerMessageAt],
      );
    }
    return conversationId;
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
    //
    // A REAL inbound message one second after the read, not just an advanced
    // column: since round 2 the badge keys on the message table, so moving
    // last_worker_message_at alone must NOT light it -- which the
    // opened-but-never-wrote case below pins from the other side.
    it('flips back to unread when a message ARRIVES after the read stamp', async () => {
      const employer = await newEmployer();
      const conversation = await newConversation(employer.id, '2026-09-10T12:00:00Z');

      const inbox = await asEmployer(employer, async () => {
        await client.query(markReadSql(), [conversation, employer.id]);
        await client.query(
          `INSERT INTO job_conversation_messages
             (conversation_id, sender_type, direction, body, status, created_at)
           SELECT id, 'worker', 'inbound', 'later reply', 'received',
                  employer_last_read_at + interval '1 second'
             FROM job_conversations WHERE id = $1`,
          [conversation],
        );
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

    // The mirror image, and the round-2 bug in one case: advancing
    // last_worker_message_at WITHOUT a message -- exactly what
    // openWorkerConversation (job-messaging.ts:813) does when the worker taps
    // "Open conversation" -- must leave the badge off.
    it('does NOT flip back when only last_worker_message_at advances (no message arrived)', async () => {
      const employer = await newEmployer();
      const conversation = await newConversation(employer.id, '2026-09-10T12:00:00Z');

      const inbox = await asEmployer(employer, async () => {
        await client.query(markReadSql(), [conversation, employer.id]);
        await client.query(
          `UPDATE job_conversations
              SET last_worker_message_at = employer_last_read_at + interval '1 hour',
                  accepted_at = COALESCE(accepted_at, now())
            WHERE id = $1`,
          [conversation],
        );
        return listEmployerInbox(client as unknown as PoolClient, employer.id);
      });

      expect(inbox.items[0].last_worker_message_at).not.toBeNull();
      expect(inbox.items[0].unread).toBe(false);
      expect(inbox.unread_count).toBe(0);
    });

    it('treats a read stamped at the EXACT instant of the last inbound message as read', async () => {
      const employer = await newEmployer();
      const conversation = await newConversation(employer.id, '2026-09-10T12:00:00Z');

      const inbox = await asEmployer(employer, async () => {
        await client.query(markReadSql(), [conversation, employer.id]);
        await client.query(
          `UPDATE job_conversation_messages
              SET created_at = (SELECT employer_last_read_at FROM job_conversations WHERE id = $1)
            WHERE conversation_id = $1 AND direction = 'inbound'`,
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

    // ── round 2: the dismissed applicant with a live thread ──────────────
    //
    // Inbound routing (lib/job-messaging.ts:657-688) picks its target by
    // jc.worker_id + jc.status = 'open' and never reads the application's
    // status, so a worker's reply still lands in the thread of somebody the
    // employer marked not-interested. The inbox is now the drawer's only
    // source, so filtering that row out hid a live, still-receiving
    // conversation from every employer surface.
    it('surfaces a not_interested applicant whose thread is still open and unread', async () => {
      const employer = await newEmployer();
      const dismissed = await newConversation(employer.id, '2026-09-10T12:00:00Z', {
        applicationStatus: 'not_interested',
      });

      const inbox = await asEmployer(employer, async () =>
        listEmployerInbox(client as unknown as PoolClient, employer.id));

      expect(inbox.items.map((item) => item.conversation_id)).toEqual([dismissed]);
      // Reachable...
      expect(inbox.items[0].application_status).toBe('not_interested');
      // ...and BADGED: an unanswered message from somebody the employer
      // dismissed is still an unanswered message.
      expect(inbox.items[0].unread).toBe(true);
      expect(inbox.unread_count).toBe(1);
    });

    // The other half of the same WHERE clause: dismissing an applicant the
    // employer never messaged must still remove them from the list, or the
    // "not interested" button does nothing visible.
    it('still drops a not_interested applicant with NO conversation', async () => {
      const employer = await newEmployer();
      seq += 1;
      const jobId = (
        await client.query<{ id: string }>(
          `INSERT INTO jobs (employer_id, title, location, job_type, status)
           VALUES ($1, $2, 'Austin', 'full-time', 'active') RETURNING id`,
          [employer.id, `S26 T3a dismissed-no-thread ${seq}`],
        )
      ).rows[0].id;
      await client.query(
        `INSERT INTO job_applications (job_id, worker_id, status)
         VALUES ($1, $2, 'not_interested')`,
        [jobId, worker],
      );

      const inbox = await asEmployer(employer, async () =>
        listEmployerInbox(client as unknown as PoolClient, employer.id));

      expect(inbox.items).toHaveLength(0);
    });

    // The badge's round-2 definition, against a real message table: the
    // "Open conversation" button stamps last_worker_message_at and inserts
    // NOTHING, so the thread must stay unbadged until a message really lands.
    it('does not badge a thread the worker only OPENED (last_worker_message_at with no message row)', async () => {
      const employer = await newEmployer();
      const opened = await newConversation(employer.id, '2026-09-10T12:00:00Z', {
        inbound: false,
      });

      const inbox = await asEmployer(employer, async () =>
        listEmployerInbox(client as unknown as PoolClient, employer.id));

      expect(inbox.items.map((item) => item.conversation_id)).toEqual([opened]);
      // The column IS set -- this is openWorkerConversation's exact footprint.
      expect(inbox.items[0].last_worker_message_at).not.toBeNull();
      // ...and the badge is still off, because no message exists.
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


/**
 * ── Migration 096: the backfill that keeps the badge from crying wolf ──────
 *
 * Every row predating this sprint carries a NULL `employer_last_read_at`,
 * because nothing has ever written the column. Under the shipped formula that
 * makes EVERY thread a worker ever replied to unread on day one. 096 stamps
 * that history; these cases prove it does, that it does not over-reach, and
 * that a replay is safe.
 *
 * Fixtures here are COMMITTED (the migration runs on its own connection and
 * cannot see an uncommitted row) and deleted in afterAll.
 */
maybeDescribe('migration 096 backfills the employer read stamp', () => {
  const tag = randomUUID().slice(0, 8);
  /** Fixtures and verification reads. Bypasses RLS, so it can never be the
   * connection the migration runs on. */
  const su = new Client({ connectionString: databaseUrl });
  /** The migration's OWN connection: the real, non-superuser jale_admin. */
  let admin: Client;

  const migrationSql = fs.readFileSync(MIGRATION_096_PATH, 'utf8');

  const employerId = randomUUID();
  const employerSub = `s26-096-employer-${tag}`;
  const workerId = randomUUID();
  const jobId = randomUUID();
  const applicationId = randomUUID();
  const conversationId = randomUUID();

  /** The worker's last message, a day before the backfill runs. */
  const workerWroteAt = new Date(Date.now() - 24 * 60 * 60 * 1000);

  /**
   * Applies 096 exactly the way run-migrations.sh does: the whole file, in one
   * simple query, as jale_admin. `pg` sends a multi-statement simple query,
   * which is what carries BEGIN/COMMIT and the dollar-quoted DO blocks intact
   * -- and why no bind parameter may appear here.
   */
  async function apply096(): Promise<void> {
    await admin.query(migrationSql);
  }

  async function stamp(): Promise<Date | null> {
    const res = await su.query<{ employer_last_read_at: Date | null }>(
      'SELECT employer_last_read_at FROM job_conversations WHERE id = $1',
      [conversationId],
    );
    return res.rows[0].employer_last_read_at;
  }

  /** The inbox, read the way the Lambda reads it: as jale_admin, both GUCs
   * bound, in a transaction that is rolled back so it cannot disturb the
   * migration cases around it. */
  async function inboxUnread(): Promise<boolean> {
    await admin.query('BEGIN');
    try {
      await admin.query(`SELECT set_config('app.current_user_id', $1, true)`, [employerSub]);
      await admin.query(`SELECT set_config('app.current_internal_user_id', $1, true)`, [employerId]);
      const inbox = await listEmployerInbox(admin as unknown as PoolClient, employerId);
      expect(inbox.items).toHaveLength(1);
      expect(inbox.items[0].conversation_id).toBe(conversationId);
      expect(inbox.unread_count).toBe(inbox.items[0].unread ? 1 : 0);
      return inbox.items[0].unread;
    } finally {
      await admin.query('ROLLBACK');
    }
  }

  async function forceFlags(): Promise<{ enabled: boolean; forced: boolean }> {
    const res = await su.query<{ relrowsecurity: boolean; relforcerowsecurity: boolean }>(
      `SELECT relrowsecurity, relforcerowsecurity
         FROM pg_catalog.pg_class WHERE oid = 'public.job_conversations'::regclass`,
    );
    return { enabled: res.rows[0].relrowsecurity, forced: res.rows[0].relforcerowsecurity };
  }

  beforeAll(async () => {
    await su.connect();
    if (new URL(databaseUrl as string).username !== 'jale_admin') {
      await su.query(`ALTER ROLE jale_admin WITH PASSWORD 'test-admin-pw'`);
    }
    admin = new Client({
      connectionString: urlForRole(databaseUrl as string, 'jale_admin', 'test-admin-pw'),
    });
    await admin.connect();

    await su.query(
      `INSERT INTO users (id, cognito_sub, user_type)
       VALUES ($1, $2, 'employer'), ($3, $4, 'worker')`,
      [employerId, employerSub, workerId, `s26-096-worker-${tag}`],
    );
    await su.query(
      `INSERT INTO jobs (id, employer_id, title, location, job_type, status)
       VALUES ($1, $2, 'S26 096 backfill', 'Austin', 'full-time', 'active')`,
      [jobId, employerId],
    );
    await su.query(
      `INSERT INTO job_applications (id, job_id, worker_id, status)
       VALUES ($1, $2, $3, 'talking')`,
      [applicationId, jobId, workerId],
    );
    // EXACTLY the shape every pre-sprint-26 row has: the worker has written,
    // and employer_last_read_at is NULL because nothing has ever written it.
    await su.query(
      `INSERT INTO job_conversations
         (id, job_id, employer_id, worker_id, application_id, status,
          last_message_at, last_worker_message_at, employer_last_read_at)
       VALUES ($1, $2, $3, $4, $5, 'open', $6, $6, NULL)`,
      [conversationId, jobId, employerId, workerId, applicationId, workerWroteAt],
    );
    // The MESSAGE behind those columns. Since round 2 the badge keys on the
    // newest inbound message, so a fixture that only set the conversation
    // columns would be measuring nothing. created_at is workerWroteAt, which
    // is also what 096 will stamp -- making this the EQUAL-timestamp case, and
    // equality is what production actually hits: the inbound insert and the
    // conversation UPDATE that follows it (job-messaging.ts:692-701) share one
    // transaction, so now() is identical for both.
    await su.query(
      `INSERT INTO job_conversation_messages
         (conversation_id, sender_type, direction, body, status, created_at)
       VALUES ($1, 'worker', 'inbound', 'pre-096 worker message', 'received', $2)`,
      [conversationId, workerWroteAt],
    );
  });

  afterAll(async () => {
    // job_applications.worker_id is ON DELETE RESTRICT and job_conversations
    // holds a RESTRICT on application_id -- conversations, then applications,
    // then jobs, then users. try/finally: a failed DELETE must still close
    // BOTH clients, or jest hangs on the open pg handles.
    try {
      // job_conversation_messages.conversation_id is ON DELETE CASCADE
      // (025:31), so the messages go with the conversation.
      await su.query('DELETE FROM job_conversations WHERE id = $1', [conversationId]);
      await su.query('DELETE FROM job_applications WHERE id = $1', [applicationId]);
      await su.query('DELETE FROM jobs WHERE id = $1', [jobId]);
      await su.query('DELETE FROM users WHERE id = ANY($1::uuid[])', [[employerId, workerId]]);
    } finally {
      await admin.end();
      await su.end();
    }
  });

  // CASES ARE ORDERED AND STATEFUL: each reads the end state the previous one
  // produced. Do not reorder them.

  it('1. applies as the real jale_admin, non-superuser and table owner -- which is what makes FORCE bind', async () => {
    const who = await admin.query<{ user: string; super: boolean }>(
      `SELECT current_user AS user,
              (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) AS super`,
    );
    expect(who.rows[0].user).toBe('jale_admin');
    // A superuser bypasses RLS entirely, so a 096 that FORGOT its un-force
    // would pass a superuser-applied test perfectly. This is the whole reason
    // this block does not use SET LOCAL ROLE.
    expect(who.rows[0].super).toBe(false);
    const owner = await su.query<{ owner: string }>(
      `SELECT pg_get_userbyid(relowner) AS owner
         FROM pg_class WHERE oid = 'public.job_conversations'::regclass`,
    );
    expect(owner.rows[0].owner).toBe('jale_admin');
  });

  it('2. a pre-096 row reads as UNREAD before the backfill', async () => {
    expect(await stamp()).toBeNull();
    // The day-one wall of stale badges, measured rather than described.
    expect(await inboxUnread()).toBe(true);
  });

  it('3. 096 stamps it to the worker message instant, and it reads as READ', async () => {
    await apply096();

    const after = await stamp();
    expect(after).not.toBeNull();
    // GREATEST(COALESCE(last_message_at, created_at),
    //          COALESCE(last_worker_message_at, created_at)) -- both columns
    // carry workerWroteAt on this row, so the stamp is exactly that instant,
    // NOT now(). A backfill that stamped now() would also read as "read", so
    // the exact value is what distinguishes a correct backfill from a lucky one.
    expect(after!.getTime()).toBe(workerWroteAt.getTime());
    // ...and it lands EXACTLY on the inbound message's created_at, so the
    // suppression depends on the comparison being strict `>`. A `>=` here
    // would leave every backfilled thread badged -- the whole wall 096 exists
    // to prevent -- which makes this the case that ties the migration and the
    // inbox formula together.
    expect(await inboxUnread()).toBe(false);
  });

  it('4. restores ENABLE + FORCE ROW LEVEL SECURITY', async () => {
    // An un-force the file failed to reverse is a permanent, silent hole in
    // the tenant boundary: every employer able to read and write every other
    // employer's conversations.
    expect(await forceFlags()).toEqual({ enabled: true, forced: true });
  });

  it('5. a worker message arriving AFTER the backfill flips the thread back to unread', async () => {
    // A real second inbound message, one second after the stamp 096 wrote --
    // the way a WhatsApp reply arrives the morning after the deploy.
    await su.query(
      `INSERT INTO job_conversation_messages
         (conversation_id, sender_type, direction, body, status, created_at)
       SELECT id, 'worker', 'inbound', 'post-096 worker message', 'received',
              employer_last_read_at + interval '1 second'
         FROM job_conversations WHERE id = $1`,
      [conversationId],
    );
    await su.query(
      `UPDATE job_conversations
          SET last_worker_message_at = employer_last_read_at + interval '1 second',
              last_message_at = employer_last_read_at + interval '1 second'
        WHERE id = $1`,
      [conversationId],
    );
    // The backfill suppresses HISTORY, not the feature. This is the assertion
    // that separates the two.
    expect(await inboxUnread()).toBe(true);
  });

  it('6. replaying 096 is a no-op: it does NOT re-stamp a row that already has one', async () => {
    const before = await stamp();
    const stillUnread = await inboxUnread();
    expect(stillUnread).toBe(true);

    await apply096();

    // `WHERE employer_last_read_at IS NULL` is the idempotence gate. A replay
    // that dropped it would silently mark every genuinely-unread thread in
    // production as read -- the one hazard the file's header calls out.
    expect((await stamp())!.getTime()).toBe(before!.getTime());
    expect(await inboxUnread()).toBe(true);
    expect(await forceFlags()).toEqual({ enabled: true, forced: true });
  });

  it('7. leaves no conversation anywhere carrying a NULL read stamp', async () => {
    // The file's own self-check, asserted from outside it: the invariant the
    // badge depends on, verified as a superuser so RLS cannot hide a row the
    // migration missed.
    const res = await su.query<{ count: string }>(
      'SELECT count(*) AS count FROM job_conversations WHERE employer_last_read_at IS NULL',
    );
    expect(Number(res.rows[0].count)).toBe(0);
  });
});
