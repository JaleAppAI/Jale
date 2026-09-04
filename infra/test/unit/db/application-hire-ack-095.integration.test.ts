/**
 * application-hire-ack-095.integration.test.ts
 *
 * Sprint 24 hotfix. Migration 095's THREE COLUMNS, its BACKFILL and its
 * COLUMN-SCOPED GRANT against REAL PostgreSQL 16 -- the migration applied from
 * the FILE ITSELF, connected as the REAL `jale_admin` role, and the two write
 * statements the shipped Lambdas issue extracted from THEIR OWN SOURCE and
 * executed against the real policies.
 *
 * WHY THIS SUITE EXISTS, AND WHY NONE OF IT CAN BE MOCKED.
 *
 * `job_applications` is ENABLE + FORCE ROW LEVEL SECURITY (003:98-99) and
 * every applicable policy is keyed on a GUC: `applications_worker_select` /
 * `applications_employer_*` on `app.current_user_id` (003) and
 * `jobapp_whatsapp_update` on `app.current_internal_user_id` (028). FORCE is
 * the part that matters -- it makes the table OWNER obey those policies too.
 * `jale_admin` owns this table AND is the role migrations run as, so with no
 * GUC set every policy evaluates `= NULL` and matches NOTHING. A bulk UPDATE
 * in the migration would rewrite ZERO rows and report success, which is
 * exactly the silent no-op 094 was written around and the reason 095 un-forces
 * first. Case 1 measures that no-op rather than asserting it in prose.
 *
 * So the connection the migration runs on is load-bearing. A SUPERUSER
 * bypasses RLS entirely, which means a 095 that FORGOT its `NO FORCE` would
 * pass a superuser-applied test perfectly. Fixtures and verification reads
 * therefore go through the superuser client (`su`), and the MIGRATION goes
 * through a second client connected as the real, non-superuser `jale_admin`.
 *
 * The other half is PRIVILEGE, which no mocked pool has at all:
 *   * the worker's own door runs as `jale_whatsapp` and is granted UPDATE on
 *     `hired_seen_at` / `hired_ack_at` ONLY. That its UPDATE of `hired_at` is
 *     a 42501 -- and not a silently ignored column -- is a fact only a real
 *     database states (case 5).
 *   * `jobapp_whatsapp_select` is `USING (true)`, so a READ proves nothing
 *     about ownership; the write policy is what separates two workers, and a
 *     policy mismatch is a ZERO-ROW result rather than an error (case 4). A
 *     mocked pool reports whatever the test told it to.
 *   * 095 must not re-run 091's hire gate or re-sync `jobs.workers_hired` for
 *     historical hires. Both are `UPDATE OF status` triggers, so the proof is
 *     that a backfill which does not name `status` leaves the counts alone --
 *     a trigger fact (case 3).
 *
 * BOTH SHIPPED STATEMENTS ARE EXTRACTED FROM THE HANDLER SOURCES, not
 * re-typed here. A copy would drift, and a copy is exactly what this suite is
 * supposed to catch: the employer's UPDATE (case 6) and the worker's two
 * hire-ack variants (case 4) are read out of the .ts files and executed
 * verbatim.
 *
 * HOW THE PRE-095 STATE IS REPRODUCED ON A TESTBED THAT IS ALREADY AT 095.
 * The columns exist by the time this runs, so a "pre-existing hire" is a row
 * INSERTed with `status = 'hired'` and a NULL `hired_at` -- byte-identical to
 * what a hire made before 095 looks like -- and the migration FILE is then
 * re-applied. That path is the file's idempotence (ADD COLUMN IF NOT EXISTS, a
 * backfill gated on `hired_at IS NULL`, an already-held GRANT) and it is the
 * only way the backfill is falsifiable at all: on a virgin database the table
 * is empty and the UPDATE has nothing to prove.
 *
 * CASES ARE ORDERED AND STATEFUL: 2-7 read the end state case 2 produced. Do
 * not reorder them.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import { Client } from 'pg';

import { setInternalUserRlsContext } from '../../../lambda/lib/db';
import { buildHireSummary } from '../../../lambda/lib/application-hire-view';

const databaseUrl = process.env.JALE_TEST_DATABASE_URL;

const INFRA_ROOT = path.join(__dirname, '..', '..', '..');
const MIGRATION_PATH = path.join(
  INFRA_ROOT, 'db', 'migrations', '095_application_hire_ack.sql',
);
const EMPLOYER_HANDLER_PATH = path.join(
  INFRA_ROOT, 'lambda', 'api', 'employer-application-status-update.ts',
);
const WORKER_HANDLER_PATH = path.join(
  INFRA_ROOT, 'lambda', 'api', 'worker-application-details.ts',
);
const LIST_HANDLER_PATH = path.join(
  INFRA_ROOT, 'lambda', 'api', 'worker-applications-list.ts',
);

function urlForRole(baseUrl: string, user: string, password: string): string {
  const u = new URL(baseUrl);
  u.username = user;
  u.password = password;
  return u.toString();
}

/**
 * The employer's status UPDATE, lifted out of its handler. `$1` status,
 * `$2` job id, `$3` worker id -- the same binding the Lambda uses.
 */
function employerUpdateSql(): string {
  const source = fs.readFileSync(EMPLOYER_HANDLER_PATH, 'utf8');
  const match = source.match(
    /UPDATE job_applications\s+SET status = \$1[\s\S]*?RETURNING[\s\S]*?details_completed_at/,
  );
  expect(match).not.toBeNull();
  return match![0];
}

/**
 * The worker door's two hire-ack variants, lifted out of their handler in
 * source order. `$1` application id, `$2` worker id.
 */
function hireAckSql(): { dismissed: string; seen: string } {
  const source = fs.readFileSync(WORKER_HANDLER_PATH, 'utf8');
  const found = source.match(
    /UPDATE job_applications\s+SET hired_[\s\S]*?RETURNING hired_seen_at, hired_ack_at/g,
  ) ?? [];
  // Exactly two: the 'dismissed' branch (both columns) and the 'seen' branch.
  expect(found).toHaveLength(2);
  const dismissed = found.find((sql) => sql.includes('hired_ack_at = COALESCE'));
  const seen = found.find((sql) => !sql.includes('hired_ack_at = COALESCE'));
  expect(dismissed).toBeDefined();
  expect(seen).toBeDefined();
  return { dismissed: dismissed!, seen: seen! };
}

/**
 * `GET /worker/applications`' single SELECT, lifted out of its handler. It
 * takes no bind parameters -- RLS is what scopes it to the caller.
 */
function listSql(): string {
  const source = fs.readFileSync(LIST_HANDLER_PATH, 'utf8');
  const match = source.match(/SELECT a\.id AS application_id[\s\S]*?LIMIT 200/);
  expect(match).not.toBeNull();
  return match![0];
}

if (!databaseUrl) {
  test('CONCERN: the migration-095 hire-acknowledgement DB suite was not run', () => {
    // eslint-disable-next-line no-console
    console.warn(
      '[application-hire-ack-095] DONE_WITH_CONCERNS: set JALE_TEST_DATABASE_URL to a '
      + 'disposable PostgreSQL 16 superuser URL with migrations 001-095 applied.',
    );
    expect(databaseUrl).toBeUndefined();
  });
}

function maybeDescribe(name: string, fn: () => void): void {
  if (databaseUrl) describe(name, fn);
  else describe.skip(name, fn);
}

interface HireRow {
  status: string;
  hired_at: Date | null;
  hired_seen_at: Date | null;
  hired_ack_at: Date | null;
  updated_at: Date;
}

maybeDescribe('sprint 24: migration 095 stamps and grants the hire acknowledgement columns', () => {
  /** Fixtures and verification reads. Bypasses RLS, so it can never be the
   * connection the migration runs on. */
  const su = new Client({ connectionString: databaseUrl });
  /** The migration's OWN connection: the real, non-superuser jale_admin. */
  let admin: Client;

  const tag = randomUUID().slice(0, 8);
  const migrationSql = fs.readFileSync(MIGRATION_PATH, 'utf8');

  const employerId = randomUUID();
  const employerSub = `s24-095-employer-${tag}`;
  /** The worker whose hire this suite acknowledges. */
  const workerOwner = randomUUID();
  /** A second worker, whose hired row the first one must never reach. */
  const workerOther = randomUUID();

  const jobHired = randomUUID();
  const jobPending = randomUUID();
  const jobOther = randomUUID();
  /** The job case 6 hires on: no requirements, so 091's gate passes. */
  const jobFresh = randomUUID();

  const appHired = randomUUID();
  const appPending = randomUUID();
  const appOther = randomUUID();
  const appFresh = randomUUID();

  const jobIds = [jobHired, jobPending, jobOther, jobFresh];
  const workerIds = [workerOwner, workerOther];

  /** updated_at as SEEDED, per application, before 095 ran. */
  const seededUpdatedAt = new Map<string, Date>();
  /** jobs.workers_hired as SEEDED, per job -- 023's AFTER trigger set it. */
  const seededWorkersHired = new Map<string, number>();

  async function appRow(id: string): Promise<HireRow> {
    const res = await su.query<HireRow>(
      `SELECT status, hired_at, hired_seen_at, hired_ack_at, updated_at
         FROM job_applications WHERE id = $1`,
      [id],
    );
    expect(res.rows).toHaveLength(1);
    return res.rows[0];
  }

  async function workersHired(jobId: string): Promise<number> {
    const res = await su.query<{ workers_hired: number }>(
      `SELECT workers_hired FROM jobs WHERE id = $1`,
      [jobId],
    );
    return Number(res.rows[0].workers_hired);
  }

  /** Applies 095 exactly the way run-migrations.sh does: the whole file, in
   * one simple query, as jale_admin. `pg` sends a multi-statement simple
   * query, which is what carries BEGIN/COMMIT and the dollar-quoted DO blocks
   * intact -- and why no bind parameter may appear here. */
  async function apply095(client: Client = admin): Promise<void> {
    await client.query(migrationSql);
  }

  /** A jale_whatsapp session with the worker's INTERNAL id GUC set, the way
   * the stage-2 door does. Rolled back by the caller. */
  async function connectAsWhatsapp(workerId: string): Promise<Client> {
    const client = new Client({
      connectionString: urlForRole(databaseUrl as string, 'jale_whatsapp', 'test-whatsapp-pw'),
    });
    await client.connect();
    await client.query('BEGIN');
    await setInternalUserRlsContext(client, workerId);
    return client;
  }

  beforeAll(async () => {
    await su.connect();
    for (const [role, password] of [
      ['jale_admin', 'test-admin-pw'],
      ['jale_whatsapp', 'test-whatsapp-pw'],
    ]) {
      if (new URL(databaseUrl as string).username !== role) {
        await su.query(`ALTER ROLE ${role} WITH PASSWORD '${password}'`);
      }
    }
    admin = new Client({
      connectionString: urlForRole(databaseUrl as string, 'jale_admin', 'test-admin-pw'),
    });
    await admin.connect();

    await su.query(
      `INSERT INTO users (id, cognito_sub, user_type) VALUES ($1, $2, 'employer')`,
      [employerId, employerSub],
    );
    await su.query(
      `INSERT INTO users (id, cognito_sub, user_type)
       VALUES ($1, $2, 'worker'), ($3, $4, 'worker')`,
      [workerOwner, `s24-095-owner-${tag}`, workerOther, `s24-095-other-${tag}`],
    );

    // number_of_workers_needed = 5 everywhere so 023's hired-count sync never
    // flips a job to 'filled' mid-suite, and no requirement of any kind, so
    // 091's hire gate passes in case 6.
    await su.query(
      `INSERT INTO jobs (id, employer_id, title, location, job_type, status,
                         number_of_workers_needed, required_fields, required_docs,
                         certification_requirements, start_date, city, state,
                         pay, pay_min, pay_max, pay_interval, shift_schedule)
       VALUES
         ($1, $5, 'S24 095 hired',   'El Paso, TX', 'full-time', 'active', 5, '{}', '{}', NULL,
            '2026-09-15', 'El Paso', 'TX', '$22-$26/hour', 22, 26, 'hourly', 'L-V 7am-3pm'),
         ($2, $5, 'S24 095 pending', 'El Paso, TX', 'full-time', 'active', 5, '{}', '{}', NULL,
            NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL),
         ($3, $5, 'S24 095 other',   'El Paso, TX', 'full-time', 'active', 5, '{}', '{}', NULL,
            NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL),
         ($4, $5, 'S24 095 fresh',   'El Paso, TX', 'full-time', 'active', 5, '{}', '{}', NULL,
            NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL)`,
      [jobHired, jobPending, jobOther, jobFresh, employerId],
    );

    // The EMPLOYER's cognito sub, on this session, for the whole suite. It is
    // not decoration: 023's job_applications_hired_count_sync is SECURITY
    // DEFINER (029) so it re-counts as jale_admin -- and `jobs` is ENABLE +
    // FORCE RLS with jobs_employer_update keyed on app.current_user_id, so
    // with no GUC set the definer's own UPDATE matches ZERO rows and
    // workers_hired silently stays 0. Setting it makes the seeded counts real,
    // which is what makes case 3's "the counts did not move" assertion
    // non-vacuous. (The superuser's own statements bypass RLS either way; this
    // only reaches the definer.)
    await su.query(`SELECT set_config('app.current_user_id', $1, false)`, [employerSub]);

    // The pre-095 shapes. A hired row with a NULL hired_at is byte-identical
    // to a hire made before the migration existed; the pending row is the
    // control the backfill must not touch.
    await su.query(
      `INSERT INTO job_applications (id, job_id, worker_id, status)
       VALUES ($1, $5, $9, 'hired'), ($2, $6, $9, 'pending'),
              ($3, $7, $10, 'hired'), ($4, $8, $9, 'talking')`,
      [
        appHired, appPending, appOther, appFresh,
        jobHired, jobPending, jobOther, jobFresh,
        workerOwner, workerOther,
      ],
    );

    for (const id of [appHired, appPending, appOther, appFresh]) {
      seededUpdatedAt.set(id, (await appRow(id)).updated_at);
    }
    for (const id of jobIds) {
      seededWorkersHired.set(id, await workersHired(id));
    }
    // The GUC above really did let the definer through, so case 3 is comparing
    // a real count against itself rather than two zeroes.
    expect(seededWorkersHired.get(jobHired)).toBe(1);
    expect(seededWorkersHired.get(jobOther)).toBe(1);
    expect(seededWorkersHired.get(jobPending)).toBe(0);
  });

  afterAll(async () => {
    // job_applications.worker_id is ON DELETE RESTRICT and jobs.employer_id
    // cascades from users -- so applications first, then jobs, then users.
    // try/finally: a failed DELETE must still close BOTH clients, or jest
    // hangs on the open pg handles.
    try {
      await su.query(`DELETE FROM job_applications WHERE job_id = ANY($1::uuid[])`, [jobIds]);
      await su.query(`DELETE FROM jobs WHERE id = ANY($1::uuid[])`, [jobIds]);
      await su.query(`DELETE FROM users WHERE id = ANY($1::uuid[])`, [
        [employerId, ...workerIds],
      ]);
    } finally {
      await admin.end();
      await su.end();
    }
  });

  // ── 1. the connection the migration runs on ────────────────────
  it('1. applies as the real jale_admin, which under FORCE sees NONE of the rows it must stamp', async () => {
    const who = await admin.query<{ user: string; super: boolean }>(
      `SELECT current_user AS user, (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) AS super`,
    );
    expect(who.rows[0].user).toBe('jale_admin');
    expect(who.rows[0].super).toBe(false);
    // ...and it OWNS the table, which is precisely why FORCE binds it.
    const owned = await admin.query<{ relname: string }>(
      `SELECT relname FROM pg_class
        WHERE relname = 'job_applications' AND pg_get_userbyid(relowner) = 'jale_admin'`,
    );
    expect(owned.rows.map((r) => r.relname)).toEqual(['job_applications']);

    // THE no-op, measured. The migration's own candidate filter, run as
    // jale_admin with no GUC set: zero rows, though the fixtures above planted
    // two hired ones.
    const forced = await admin.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM job_applications
        WHERE status = 'hired' AND hired_at IS NULL`,
    );
    expect(Number(forced.rows[0].n)).toBe(0);
    const visible = await su.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM job_applications
        WHERE status = 'hired' AND hired_at IS NULL`,
    );
    expect(Number(visible.rows[0].n)).toBeGreaterThanOrEqual(2);
  });

  // ── 2. the backfill ───────────────────────────────────────────
  it('2. stamps a pre-existing hire on all three columns from its own updated_at, and leaves a pending row NULL', async () => {
    await expect(apply095()).resolves.not.toThrow();

    const seeded = seededUpdatedAt.get(appHired)!;
    const hired = await appRow(appHired);
    // Not "equal to updated_at" -- equal to the value updated_at HELD BEFORE
    // the migration. 003's unconditional set_updated_at trigger advances
    // updated_at on this very UPDATE, so asserting against the seeded value is
    // what distinguishes `hired_at = updated_at` from a `hired_at = now()`
    // that would have congratulated a worker hired months ago.
    expect(hired.hired_at?.getTime()).toBe(seeded.getTime());
    expect(hired.hired_seen_at?.getTime()).toBe(seeded.getTime());
    // Pre-ACKNOWLEDGED as well as pre-seen: this is the whole "no retroactive
    // celebration" guarantee, and the two columns the web reads.
    expect(hired.hired_ack_at?.getTime()).toBe(seeded.getTime());
    // ...and the trigger really did fire, so the equality above was not a
    // coincidence of a frozen clock.
    expect(hired.updated_at.getTime()).toBeGreaterThan(seeded.getTime());

    // The OTHER worker's hire is stamped too -- the backfill is global, not
    // fixture-scoped.
    const other = await appRow(appOther);
    expect(other.hired_at?.getTime()).toBe(seededUpdatedAt.get(appOther)!.getTime());

    // The control rows: never hired, so all three columns stay NULL and their
    // updated_at never moved. A backfill that rewrote every row would pass
    // every assertion above and fail this one.
    for (const id of [appPending, appFresh]) {
      const row = await appRow(id);
      expect({
        hired_at: row.hired_at, hired_seen_at: row.hired_seen_at, hired_ack_at: row.hired_ack_at,
      }).toEqual({ hired_at: null, hired_seen_at: null, hired_ack_at: null });
      expect(row.updated_at.getTime()).toBe(seededUpdatedAt.get(id)!.getTime());
    }
  });

  it('3. re-applies as a no-op, and never re-fires the status triggers', async () => {
    const before = await appRow(appHired);
    // The self-checks are inside the file; a replay re-runs them against the
    // end state the first apply produced, and `hired_at IS NULL` means it
    // changes nothing. Only the migration LEDGER refuses a replay in the
    // deploy path -- never the SQL.
    await expect(apply095()).resolves.not.toThrow();
    const after = await appRow(appHired);
    expect(after.hired_at?.getTime()).toBe(before.hired_at?.getTime());
    // No row was written at all, so not even the updated_at trigger ran.
    expect(after.updated_at.getTime()).toBe(before.updated_at.getTime());

    // 091's job_applications_hire_requirements_guard and 023's
    // job_applications_hired_count_sync are both `UPDATE OF status` triggers.
    // The backfill does not name `status`, so neither fired -- if either had,
    // this count would have been re-synced (and the gate would have re-judged
    // requirements for hires made months ago).
    for (const id of jobIds) {
      expect(await workersHired(id)).toBe(seededWorkersHired.get(id)!);
    }
    // The hired job really does have a hire on it (asserted at seed time), so
    // the comparison above is not comparing two zeroes.
    expect(seededWorkersHired.get(jobHired)).toBe(1);
  });

  // ── 4. the worker's own door, as the role it actually runs as ──
  it("4. lets jale_whatsapp acknowledge its OWN hire and nobody else's", async () => {
    const { seen, dismissed } = hireAckSql();
    // A row the celebration has not been shown for yet: the fixtures' hired
    // rows were pre-acknowledged by the migration, so this is a FRESH hire,
    // made the way production makes one (case 6 re-uses it afterwards).
    await su.query(
      `UPDATE job_applications SET status = 'hired', hired_at = now() WHERE id = $1`,
      [appFresh],
    );

    const wa = await connectAsWhatsapp(workerOwner);
    try {
      // (a) its own hired row: one row, and the stamp comes back.
      const own = await wa.query<{ hired_seen_at: Date | null; hired_ack_at: Date | null }>(
        seen, [appFresh, workerOwner],
      );
      expect(own.rowCount).toBe(1);
      expect(own.rows[0].hired_seen_at).not.toBeNull();
      expect(own.rows[0].hired_ack_at).toBeNull();
      const firstSeen = own.rows[0].hired_seen_at!;

      // (b) idempotent: COALESCE keeps the FIRST stamp, so a re-shown modal
      // cannot rewrite when the worker actually saw the hire.
      const again = await wa.query<{ hired_seen_at: Date }>(seen, [appFresh, workerOwner]);
      expect(again.rows[0].hired_seen_at.getTime()).toBe(firstSeen.getTime());

      // (c) dismissed fills the ack AND leaves seen alone.
      const gone = await wa.query<{ hired_seen_at: Date; hired_ack_at: Date | null }>(
        dismissed, [appFresh, workerOwner],
      );
      expect(gone.rows[0].hired_ack_at).not.toBeNull();
      expect(gone.rows[0].hired_seen_at.getTime()).toBe(firstSeen.getTime());

      // (d) ANOTHER worker's hired row: zero rows, twice over. Not an error
      // -- a filtered write, which is what makes a missing FORCE or a broken
      // policy so quiet.
      //   * with the caller's own id bound, the statement's own
      //     `worker_id = $2` predicate refuses it;
      //   * with the OWNER's id bound -- the shape a compromised or confused
      //     caller would send -- the predicate matches and 028's
      //     jobapp_whatsapp_update policy is the only thing left refusing,
      //     because this session's GUC is a different worker.
      const foreignBySelf = await wa.query(dismissed, [appOther, workerOwner]);
      expect(foreignBySelf.rowCount).toBe(0);
      const foreignByPolicy = await wa.query(dismissed, [appOther, workerOther]);
      expect(foreignByPolicy.rowCount).toBe(0);
      // ...and the row IS readable from this session: jobapp_whatsapp_select
      // is USING (true), so a read proves nothing about ownership and only
      // the WRITE side is separated.
      const readable = await wa.query(
        `SELECT id FROM job_applications WHERE id = $1`, [appOther],
      );
      expect(readable.rows).toHaveLength(1);

      // (e) its own row that is NOT hired: zero rows, because of the
      // statement's `status = 'hired'` predicate and nothing else. Without
      // that predicate the same session updates it, which is what makes this
      // a test of the handler's SQL rather than of RLS.
      const notHired = await wa.query(seen, [appPending, workerOwner]);
      expect(notHired.rowCount).toBe(0);
      const withoutPredicate = await wa.query(
        `UPDATE job_applications SET hired_seen_at = now()
          WHERE id = $1 AND worker_id = $2 RETURNING id`,
        [appPending, workerOwner],
      );
      expect(withoutPredicate.rowCount).toBe(1);

      // The whole case rolls back -- including (a)-(c). What it proves is
      // which statements the database ACCEPTS from this role on which row,
      // not a persisted end state, and case 6 re-hires this row from scratch.
      await wa.query('ROLLBACK');
    } catch (error) {
      await wa.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      await wa.end();
    }

    // The rollback means the pending row's columns are still NULL -- proof
    // that (e)'s un-predicated write really was undone.
    const pending = await appRow(appPending);
    expect(pending.hired_seen_at).toBeNull();
  });

  it('5. refuses a jale_whatsapp write to hired_at with 42501, rather than ignoring it', async () => {
    const wa = await connectAsWhatsapp(workerOwner);
    try {
      // Column privileges, not RLS: 095 grants that role UPDATE on the two
      // acknowledgement columns only, so naming hired_at is a hard
      // insufficient_privilege error even on a row it owns. If this ever
      // became a zero-row filter instead, a worker forging their own hire
      // date would fail silently rather than loudly.
      await expect(wa.query(
        `UPDATE job_applications SET hired_at = now() WHERE id = $1 AND worker_id = $2`,
        [appFresh, workerOwner],
      )).rejects.toMatchObject({ code: '42501' });
    } finally {
      await wa.query('ROLLBACK').catch(() => undefined);
      await wa.end();
    }

    // ...and the same role CAN still read it, which is what the list endpoint
    // and the details door depend on (004's table-level SELECT covers columns
    // added later).
    const reader = await connectAsWhatsapp(workerOwner);
    try {
      const res = await reader.query<{ hired_at: Date | null }>(
        `SELECT hired_at FROM job_applications WHERE id = $1`, [appFresh],
      );
      expect(res.rows[0].hired_at).not.toBeNull();
    } finally {
      await reader.query('ROLLBACK').catch(() => undefined);
      await reader.end();
    }
  });

  // ── 6. the employer's own statement, twice ─────────────────────
  it('6. stamps hired_at once: the employer UPDATE applied twice keeps the FIRST hire date', async () => {
    const sql = employerUpdateSql();
    // Back to a pre-hire status so the transition is the real one. Done as the
    // superuser: this is fixture setup, not the behaviour under test.
    await su.query(
      `UPDATE job_applications
          SET status = 'talking', hired_at = NULL, hired_seen_at = NULL, hired_ack_at = NULL
        WHERE id = $1`,
      [appFresh],
    );

    // An EMPLOYER web session: jale_admin with the cognito-sub GUC, which is
    // what applications_employer_update is keyed on.
    const employer = new Client({
      connectionString: urlForRole(databaseUrl as string, 'jale_admin', 'test-admin-pw'),
    });
    await employer.connect();
    try {
      await employer.query('BEGIN');
      await employer.query(`SELECT set_config('app.current_user_id', $1, true)`, [employerSub]);

      const first = await employer.query<{ status: string }>(sql, ['hired', jobFresh, workerOwner]);
      expect(first.rowCount).toBe(1);
      expect(first.rows[0].status).toBe('hired');
      const stamped = await employer.query<{ hired_at: Date }>(
        `SELECT hired_at FROM job_applications WHERE id = $1`, [appFresh],
      );
      expect(stamped.rows[0].hired_at).not.toBeNull();
      const firstHiredAt = stamped.rows[0].hired_at;

      // Re-assert 'hired' -- the shape a stale employer tab produces. 091's
      // gate has a WHEN clause (hired -> hired does not re-fire it), and this
      // statement's COALESCE is what keeps the date.
      const second = await employer.query(sql, ['hired', jobFresh, workerOwner]);
      expect(second.rowCount).toBe(1);
      const after = await employer.query<{ hired_at: Date }>(
        `SELECT hired_at FROM job_applications WHERE id = $1`, [appFresh],
      );
      expect(after.rows[0].hired_at.getTime()).toBe(firstHiredAt.getTime());

      // A different status leaves the stamp alone as well: the ELSE branch
      // rewrites the column with its own value, so an un-hire keeps the
      // history and a later re-hire cannot re-celebrate.
      const unhired = await employer.query(sql, ['talking', jobFresh, workerOwner]);
      expect(unhired.rowCount).toBe(1);
      const kept = await employer.query<{ hired_at: Date; hired_seen_at: Date | null }>(
        `SELECT hired_at, hired_seen_at FROM job_applications WHERE id = $1`, [appFresh],
      );
      expect(kept.rows[0].hired_at.getTime()).toBe(firstHiredAt.getTime());

      // And the employer statement never touches the worker's acknowledgement
      // columns -- only the two hire-ack variants write those, which is what
      // keeps an employer's re-assert from resurrecting a dismissed banner.
      expect(sql).not.toContain('hired_seen_at');
      expect(sql).not.toContain('hired_ack_at');
      expect(hireAckSql().dismissed).toContain('hired_seen_at = COALESCE');
      expect(kept.rows[0].hired_seen_at).toBeNull();

      await employer.query('ROLLBACK');
    } finally {
      await employer.end();
    }
  });

  // ── 7. the catalog end state ───────────────────────────────────
  it('7. leaves job_applications with RLS ENABLE + FORCE restored, and the grant exactly as scoped', async () => {
    const rls = await su.query<{ relrowsecurity: boolean; relforcerowsecurity: boolean }>(
      `SELECT rel.relrowsecurity, rel.relforcerowsecurity
         FROM pg_class rel JOIN pg_namespace n ON n.oid = rel.relnamespace
        WHERE n.nspname = 'public' AND rel.relname = 'job_applications'`,
    );
    expect(rls.rows).toEqual([{ relrowsecurity: true, relforcerowsecurity: true }]);
    // And the migration's own catalog self-check is what would have refused to
    // commit otherwise -- assert the guard exists, by message.
    expect(migrationSql).toContain('migration 095: job_applications lost RLS ENABLE + FORCE');

    // The privilege end state, per column: UPDATE on the two acknowledgement
    // columns, never on hired_at, and SELECT on all three (004's table-level
    // grant, which covers columns added later).
    const priv = await su.query<{ column_name: string; privilege_type: string }>(
      `SELECT column_name, privilege_type FROM information_schema.column_privileges
        WHERE grantee = 'jale_whatsapp' AND table_schema = 'public'
          AND table_name = 'job_applications' AND column_name LIKE 'hired%'
          AND privilege_type IN ('SELECT', 'UPDATE')
        ORDER BY column_name, privilege_type`,
    );
    expect(priv.rows).toEqual([
      { column_name: 'hired_ack_at', privilege_type: 'SELECT' },
      { column_name: 'hired_ack_at', privilege_type: 'UPDATE' },
      { column_name: 'hired_at', privilege_type: 'SELECT' },
      { column_name: 'hired_seen_at', privilege_type: 'SELECT' },
      { column_name: 'hired_seen_at', privilege_type: 'UPDATE' },
    ]);

    // The three columns really are timestamptz -- the type the handlers hand
    // to JSON.stringify expecting an ISO string.
    const columns = await su.query<{ column_name: string; data_type: string }>(
      `SELECT column_name, data_type FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'job_applications'
          AND column_name IN ('hired_at', 'hired_seen_at', 'hired_ack_at')
        ORDER BY column_name`,
    );
    expect(columns.rows).toEqual([
      { column_name: 'hired_ack_at', data_type: 'timestamp with time zone' },
      { column_name: 'hired_at', data_type: 'timestamp with time zone' },
      { column_name: 'hired_seen_at', data_type: 'timestamp with time zone' },
    ]);
  });

  // ── 8. the list endpoint's own SELECT, on real rows ────────────
  // The one thing a mocked pool can never check about this feature: that the
  // nine columns the celebration needs are SELECTable, correctly named, and
  // reachable by `jale_admin` through the worker's two GUCs. A typo, a column
  // that lives on the other table, or a privilege this role does not hold is a
  // 42703/42501/42702 that only a real database raises -- and it would take out
  // EVERY /worker/applications request, hired or not.
  //
  // The row that comes back is then fed to the REAL `buildHireSummary`, which
  // is what proves the pure view against pg's own types (Date for timestamptz,
  // a string for the to_char'd DATE, numbers for the INTEGER pay bounds)
  // rather than against hand-written fixtures.
  it("8. the list SELECT runs as the worker's own session and yields the celebration payload", async () => {
    const sql = listSql();
    const worker = new Client({
      connectionString: urlForRole(databaseUrl as string, 'jale_admin', 'test-admin-pw'),
    });
    await worker.connect();
    try {
      await worker.query('BEGIN');
      // Both GUCs, exactly as the handler sets them: the cognito sub for
      // applications_worker_select (003) and the INTERNAL id for 070's
      // jobs_worker_read_applied, without which the jobs join drops rows.
      await worker.query(`SELECT set_config('app.current_user_id', $1, true)`, [`s24-095-owner-${tag}`]);
      await setInternalUserRlsContext(worker, workerOwner);

      const res = await worker.query<Record<string, any>>(sql);
      const byId = new Map(res.rows.map((row) => [row.application_id, row]));
      // RLS scoped it to this worker: the OTHER worker's application is absent.
      expect(byId.has(appOther)).toBe(false);

      const hired = byId.get(appHired);
      expect(hired).toBeDefined();
      expect(hired!.status).toBe('hired');
      // 095 stamped it, and the projection carries all three columns.
      expect(hired!.hired_at).toBeInstanceOf(Date);
      expect((hired!.hired_at as Date).getTime()).toBe(seededUpdatedAt.get(appHired)!.getTime());
      expect(hired!.hired_seen_at).not.toBeNull();
      expect(hired!.hired_ack_at).not.toBeNull();
      // to_char, not a Date: this is the assertion that would have caught the
      // DATE round trip rendering the previous calendar day west of UTC.
      expect(hired!.job_start_date).toBe('2026-09-15');
      expect(typeof hired!.job_start_date).toBe('string');

      // The whole contract, end to end, off a real row.
      expect(buildHireSummary(hired!)).toEqual({
        hired_at: (hired!.hired_at as Date).toISOString(),
        seen_at: (hired!.hired_seen_at as Date).toISOString(),
        acknowledged_at: (hired!.hired_ack_at as Date).toISOString(),
        start_date: '2026-09-15',
        location: 'El Paso, TX',
        pay: '$22-$26/hour',
        shift_schedule: 'L-V 7am-3pm',
      });
      // Pre-acknowledged, so the web shows NOTHING for this historical hire --
      // the entire point of the backfill.
      expect(buildHireSummary(hired!)!.acknowledged_at).not.toBeNull();

      // The pending row: its PROJECTED hired_at is its own updated_at, because
      // the COALESCE is unconditional. That is exactly why the handler gates
      // the `hire` key on `status === 'hired'` and not on this value.
      const pending = byId.get(appPending);
      expect(pending).toBeDefined();
      expect(pending!.status).toBe('pending');
      expect((pending!.hired_at as Date).getTime())
        .toBe(seededUpdatedAt.get(appPending)!.getTime());
      expect(pending!.hired_seen_at).toBeNull();
      expect(pending!.hired_ack_at).toBeNull();
      // A job with none of the celebration facts set: every one comes back
      // NULL rather than raising, which is what the view's null-tolerance is
      // for.
      expect(pending!.job_start_date).toBeNull();
      expect(pending!.job_pay).toBeNull();
      expect(pending!.job_city).toBeNull();

      await worker.query('ROLLBACK');
    } finally {
      await worker.end();
    }
  });
});
