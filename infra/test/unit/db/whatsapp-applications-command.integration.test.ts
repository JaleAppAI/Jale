// infra/test/unit/db/whatsapp-applications-command.integration.test.ts
//
// The two NEW statements sprint 23's WhatsApp lane adds, against real
// PostgreSQL with migrations 001-091 applied and under the production
// ownership model:
//
//   1. `loadWorkerApplications` (whatsapp/lib/applications-command.ts) -- the
//      `aplicaciones` listing. Its worker scoping is NOT enforced by RLS:
//      `jobapp_whatsapp_select` (028) is `USING (true)`, so the
//      `WHERE ja.worker_id = $1` predicate is the ONLY thing standing between
//      one worker and another's applications. A unit test with a mocked
//      client cannot prove that; this can. It also proves jale_whatsapp can
//      resolve the company through `employer_display_name` (031) despite
//      holding no grant on `employer_profiles` at all.
//
//   2. `findContinueOtherOffer` (whatsapp/lib/application-fill.ts) -- whose
//      WHERE clause gained the sprint-23 stage predicate. The offer must
//      never name an application the employer has not asked details for, nor
//      one already finished.
//
// Role handling mirrors whatsapp-application-fill-080.integration.test.ts:
// one Client per logical operation, BEGIN + SET LOCAL ROLE jale_whatsapp
// (transaction-scoped, reverts at COMMIT/ROLLBACK), fixtures inserted by the
// superuser setup client.
import { randomUUID } from 'node:crypto';
import { Client } from 'pg';
import { loadWorkerApplications } from '../../../lambda/whatsapp/lib/applications-command';
import { findContinueOtherOffer } from '../../../lambda/whatsapp/lib/application-fill';

const databaseUrl = process.env.JALE_TEST_DATABASE_URL;
if (!databaseUrl) {
  test('CONCERN: the sprint-23 applications-command PostgreSQL gate was not run', () => {
    console.warn('[whatsapp-applications-command] JALE_TEST_DATABASE_URL not set; disposable PostgreSQL gate skipped');
    expect(databaseUrl).toBeUndefined();
  });
}
const maybeDescribe = databaseUrl ? describe : describe.skip;

// The lane's helpers are typed on `PoolClient` (they always run inside the
// processor's pooled per-turn transaction), but a role-switching integration
// test needs its OWN connection per logical operation, which is a plain
// `Client`. The two differ only by `release()`, which none of these helpers
// calls -- the same narrowing the sibling DB suites use.
type LaneClient = Parameters<typeof loadWorkerApplications>[0];
const asLaneClient = (client: Client): LaneClient => client as unknown as LaneClient;

async function connectAsWhatsapp(workerId: string): Promise<Client> {
  const client = new Client({ connectionString: databaseUrl });
  await client.connect();
  await client.query('BEGIN');
  await client.query('SET LOCAL ROLE jale_whatsapp');
  // 070's jobs_worker_read_applied is keyed on this GUC; without it the join
  // silently drops every non-active job the worker applied to.
  await client.query(`SELECT set_config('app.current_internal_user_id', $1, true)`, [workerId]);
  return client;
}

maybeDescribe('sprint 23 WhatsApp applications-command DB contract', () => {
  let setup: Client;

  const employerId = randomUUID();
  const otherEmployerId = randomUUID();
  const workerId = randomUUID();
  const strangerId = randomUUID();

  // Jobs: all ask ONE field and NO documents, so the engine's snapshot load
  // never enters its document-sync branch (which would need write access to
  // worker_documents for this role in these read-only assertions).
  const jobNeedsDetails = randomUUID();
  const jobNotRequested = randomUUID();
  const jobCompleted = randomUUID();
  const jobStranger = randomUUID();

  const appNeedsDetails = randomUUID();
  const appNotRequested = randomUUID();
  const appCompleted = randomUUID();
  const appStranger = randomUUID();
  const appAnchor = randomUUID();
  const jobAnchor = randomUUID();

  beforeAll(async () => {
    setup = new Client({ connectionString: databaseUrl });
    await setup.connect();

    // The cognito_sub values are passed as their own parameters rather than
    // built with `'prefix' || $n::text`: reusing one placeholder as both uuid
    // and text makes Postgres refuse the statement (inconsistent types
    // deduced for parameter $1).
    await setup.query(
      `INSERT INTO users (id, cognito_sub, user_type)
       VALUES ($1::uuid, $5, 'employer'),
              ($2::uuid, $6, 'employer'),
              ($3::uuid, $7, 'worker'),
              ($4::uuid, $8, 'worker')`,
      [
        employerId, otherEmployerId, workerId, strangerId,
        `s23-emp-${employerId}`, `s23-emp-${otherEmployerId}`,
        `s23-wrk-${workerId}`, `s23-wrk-${strangerId}`,
      ],
    );
    await setup.query(
      `INSERT INTO employer_profiles (user_id, company_name)
       VALUES ($1, 'RM Construction'), ($2, 'Other Co')`,
      [employerId, otherEmployerId],
    );

    await setup.query(
      `INSERT INTO jobs (id, employer_id, title, location, job_type, status, required_fields)
       VALUES ($1, $5, 'S23 needs details', 'Austin', 'full-time', 'active', '{work_authorization}'),
              ($2, $5, 'S23 not requested', 'Austin', 'full-time', 'active', '{work_authorization}'),
              ($3, $5, 'S23 completed',     'Austin', 'full-time', 'active', '{work_authorization}'),
              ($4, $6, 'S23 stranger',      'Austin', 'full-time', 'active', '{work_authorization}')`,
      [jobNeedsDetails, jobNotRequested, jobCompleted, jobStranger, employerId, otherEmployerId],
    );
    await setup.query(
      `INSERT INTO jobs (id, employer_id, title, location, job_type, status, required_fields)
       VALUES ($1, $2, 'S23 anchor', 'Austin', 'full-time', 'active', '{work_authorization}')`,
      [jobAnchor, employerId],
    );

    // applied_at is set explicitly so the "needs-details first, then newest"
    // ordering is provable: the not-requested row is the NEWEST, so if the
    // stage key were dropped from the ORDER BY it would sort first.
    await setup.query(
      `INSERT INTO job_applications
         (id, job_id, worker_id, status, applied_at, details_requested_at, details_completed_at)
       VALUES
         ($1, $5, $9,  'contacted', now() - interval '3 days', now() - interval '1 day', NULL),
         ($2, $6, $9,  'pending',   now() - interval '1 hour', NULL,                     NULL),
         ($3, $7, $9,  'talking',   now() - interval '2 days', now() - interval '2 days', now() - interval '1 day'),
         ($4, $8, $10, 'contacted', now() - interval '3 days', now() - interval '1 day', NULL)`,
      [
        appNeedsDetails, appNotRequested, appCompleted, appStranger,
        jobNeedsDetails, jobNotRequested, jobCompleted, jobStranger,
        workerId, strangerId,
      ],
    );
    await setup.query(
      `INSERT INTO job_applications (id, job_id, worker_id, status, applied_at, details_requested_at)
       VALUES ($1, $2, $3, 'contacted', now(), now())`,
      [appAnchor, jobAnchor, workerId],
    );
  });

  afterAll(async () => {
    if (!setup) return;
    await setup.query(`DELETE FROM job_applications WHERE worker_id = ANY($1::uuid[])`, [[workerId, strangerId]]);
    await setup.query(`DELETE FROM jobs WHERE id = ANY($1::uuid[])`, [
      [jobNeedsDetails, jobNotRequested, jobCompleted, jobStranger, jobAnchor],
    ]);
    await setup.query(`DELETE FROM employer_profiles WHERE user_id = ANY($1::uuid[])`, [[employerId, otherEmployerId]]);
    await setup.query(`DELETE FROM users WHERE id = ANY($1::uuid[])`, [
      [employerId, otherEmployerId, workerId, strangerId],
    ]);
    await setup.end();
  });

  describe('loadWorkerApplications', () => {
    it('returns ONLY the calling worker\'s applications, needs-details first', async () => {
      const client = await connectAsWhatsapp(workerId);
      try {
        const rows = await loadWorkerApplications(asLaneClient(client), workerId);

        const ids = rows.map((row) => row.applicationId);
        // The stranger's row is visible to the POLICY (USING (true)) and is
        // kept out by the predicate alone -- that is the whole point.
        expect(ids).not.toContain(appStranger);
        expect(new Set(ids)).toEqual(new Set([appNeedsDetails, appNotRequested, appCompleted, appAnchor]));

        // Needs-details rows sort ahead of the NEWEST non-needs-details row.
        const needsDetails = rows.filter((row) => row.needsDetails).map((row) => row.applicationId);
        expect(new Set(needsDetails)).toEqual(new Set([appNeedsDetails, appAnchor]));
        expect(rows.slice(0, 2).every((row) => row.needsDetails)).toBe(true);
        expect(rows[rows.length - 1].applicationId).not.toBe(appNeedsDetails);
      } finally {
        await client.query('ROLLBACK');
        await client.end();
      }
    });

    it('resolves the company through employer_display_name despite no employer_profiles grant', async () => {
      const client = await connectAsWhatsapp(workerId);
      try {
        // Proof the definer function is doing the work: the same role cannot
        // read the table directly.
        await expect(client.query('SELECT company_name FROM employer_profiles LIMIT 1'))
          .rejects.toMatchObject({ code: '42501' });
      } finally {
        await client.query('ROLLBACK');
        await client.end();
      }

      const reader = await connectAsWhatsapp(workerId);
      try {
        const rows = await loadWorkerApplications(asLaneClient(reader), workerId);
        const row = rows.find((r) => r.applicationId === appNeedsDetails);
        expect(row?.companyName).toBe('RM Construction');
        expect(row?.jobTitle).toBe('S23 needs details');
        expect(row?.status).toBe('contacted');
      } finally {
        await reader.query('ROLLBACK');
        await reader.end();
      }
    });

    it('a completed application is listed but NOT marked as needing details', async () => {
      const client = await connectAsWhatsapp(workerId);
      try {
        const rows = await loadWorkerApplications(asLaneClient(client), workerId);
        expect(rows.find((r) => r.applicationId === appCompleted)?.needsDetails).toBe(false);
        expect(rows.find((r) => r.applicationId === appNotRequested)?.needsDetails).toBe(false);
      } finally {
        await client.query('ROLLBACK');
        await client.end();
      }
    });
  });

  describe('findContinueOtherOffer', () => {
    it('offers only an application the employer HAS asked details for and that is unfinished', async () => {
      const client = await connectAsWhatsapp(workerId);
      try {
        const offer = await findContinueOtherOffer(asLaneClient(client), workerId, appAnchor);
        expect(offer).not.toBeNull();
        expect(offer?.applicationId).toBe(appNeedsDetails);
        expect(offer?.jobTitle).toBe('S23 needs details');
      } finally {
        await client.query('ROLLBACK');
        await client.end();
      }
    });

    it('never offers a not-yet-requested or an already-completed application', async () => {
      const client = await connectAsWhatsapp(workerId);
      try {
        // Exclude the only genuinely offerable row; what is left is exactly
        // the not-requested one and the completed one, both of which the
        // sprint-23 stage predicate must filter out in SQL.
        const offer = await findContinueOtherOffer(asLaneClient(client), workerId, appNeedsDetails);
        expect(offer?.applicationId).not.toBe(appNotRequested);
        expect(offer?.applicationId).not.toBe(appCompleted);
        // The anchor itself is still requested-and-incomplete, so it is the
        // one legitimate answer here.
        expect(offer?.applicationId).toBe(appAnchor);
      } finally {
        await client.query('ROLLBACK');
        await client.end();
      }
    });

    it('never offers another worker\'s application', async () => {
      const client = await connectAsWhatsapp(strangerId);
      try {
        const offer = await findContinueOtherOffer(asLaneClient(client), strangerId, appStranger);
        expect(offer).toBeNull();
      } finally {
        await client.query('ROLLBACK');
        await client.end();
      }
    });
  });
});
