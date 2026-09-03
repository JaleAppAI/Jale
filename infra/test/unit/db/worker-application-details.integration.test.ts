/**
 * worker-application-details.integration.test.ts
 *
 * Sprint 23 L2.4. The WEB STAGE-2 DOOR against REAL PostgreSQL 16 with
 * migrations 001-091 applied, driven through the ACTUAL Lambda handler with a
 * fake Cognito claims event -- not through the shared engine, and not through
 * hand-built SQL.
 *
 * WHY THIS SUITE EXISTS. The handler's unit suite mocks
 * `lib/application-requirements`, so it proves the HTTP contract and nothing
 * about the database. Everything this door actually depends on is invisible
 * to a mocked pool:
 *
 *   - `job_applications` is FORCE RLS and `jobapp_whatsapp_select` is
 *     `USING (true)` (028). Whether a worker can read somebody else's
 *     application therefore rests entirely on the handler's own
 *     `AND worker_id = $2`, which only a real policy set can prove.
 *   - `jobapp_whatsapp_update` is keyed on `app.current_internal_user_id`.
 *     A missing GUC is a ZERO-ROW UPDATE -- a SQL success -- so a mocked
 *     pool would show a green 200 over a write that never happened.
 *   - 091's column-scoped grants (`prompt_answers`, `details_completed_at`,
 *     `worker_application_defaults`) are 42501s no unit test can raise.
 *   - `employer_display_name` flips a transaction-local GUC that widens
 *     `employer_profiles` until COMMIT (031); the ordering rule that
 *     protects is only meaningful against a real transaction.
 *   - 091's BEFORE-UPDATE hire gate is a trigger. The whole point of the
 *     stage-2 door is to make that trigger pass, and nothing else in the
 *     repo asserts that it does.
 *
 * CONNECTION. `JALE_TEST_DATABASE_URL` must be a SUPERUSER url for a
 * disposable database (fixtures and verification reads use it). The HANDLER
 * connects on its own, as `jale_whatsapp` -- `getDbPool` is mocked to hand it
 * a pool authenticated with that role's password, which is the only way to
 * prove the column-scoped grants actually cover what the door reads and
 * writes.
 *
 * CASES ARE ORDERED AND STATEFUL. They walk one application from apply-stage
 * through a completed details stage and into a successful hire, exactly as a
 * worker would. Do not reorder them.
 */

import { randomUUID } from 'node:crypto';
import { Client, Pool } from 'pg';
import type { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';

const databaseUrl = process.env.JALE_TEST_DATABASE_URL;

const REQUIRED_TOS = '1.0';

function urlForRole(baseUrl: string, user: string, password: string): string {
  const u = new URL(baseUrl);
  u.username = user;
  u.password = password;
  return u.toString();
}

// The handler builds its own pool via `getDbPool()`. Mocking exactly that one
// export -- and nothing else in the module -- is what lets the REAL handler
// run against the REAL role. `poolHandouts` proves the pre-DB refusals
// (413, malformed JSON) never reach it.
let rolePool: Pool | undefined;
let poolHandouts = 0;
jest.mock('../../../lambda/lib/db', () => {
  const actual = jest.requireActual('../../../lambda/lib/db');
  return {
    ...actual,
    getDbPool: async () => {
      poolHandouts += 1;
      return rolePool;
    },
  };
});

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { handler } = require('../../../lambda/api/worker-application-details');

if (!databaseUrl) {
  test('CONCERN: the worker application details DB suite was not run', () => {
    // eslint-disable-next-line no-console
    console.warn(
      '[worker-application-details] DONE_WITH_CONCERNS: set JALE_TEST_DATABASE_URL to a '
      + 'disposable PostgreSQL 16 superuser URL with migrations 001-091 applied.',
    );
    expect(databaseUrl).toBeUndefined();
  });
}

function maybeDescribe(name: string, fn: () => void): void {
  if (databaseUrl) describe(name, fn);
  else describe.skip(name, fn);
}

interface Response { statusCode: number; body: Record<string, any> }

maybeDescribe('L2.4: the web stage-2 details door, end to end', () => {
  const su = new Client({ connectionString: databaseUrl });

  const tag = randomUUID().slice(0, 8);
  const ids: Record<string, string> = {};
  const subs: Record<string, string> = {};
  let jobId = '';
  let simpleJobId = '';
  let appA = '';
  let appB = '';
  let appC = '';
  let bCertDocId = '';
  let aCertDocId = '';

  const WORKERS = ['owner', 'foreign', 'closed', 'badtos'] as const;

  const HOME_ADDRESS = { street: '123 Main St', city: 'El Paso', state: 'TX', zip: '79901' };

  /** The exact shape API Gateway's Cognito authorizer hands the Lambda. */
  function event(
    sub: string,
    opts: { method?: string; applicationId?: string; action?: string; rawBody?: string; body?: unknown } = {},
  ): APIGatewayProxyEvent {
    const applicationId = opts.applicationId ?? appA;
    // API Gateway's REAL shape: `/worker/applications/{applicationId}` and
    // ONE `{action}` child (ApiStack has no room for named siblings -- see
    // whatsapp-stack.ts), so the segments arrive in `pathParameters` and
    // `resource` is the TEMPLATE.
    return {
      httpMethod: opts.method ?? 'GET',
      resource: opts.action
        ? '/worker/applications/{applicationId}/{action}'
        : '/worker/applications/{applicationId}',
      path: `/worker/applications/${applicationId}${opts.action ? `/${opts.action}` : ''}`,
      pathParameters: opts.action ? { applicationId, action: opts.action } : { applicationId },
      body: opts.rawBody !== undefined
        ? opts.rawBody
        : (opts.body === undefined ? null : JSON.stringify(opts.body)),
      requestContext: { authorizer: { claims: { sub } } },
    } as unknown as APIGatewayProxyEvent;
  }

  async function call(sub: string, opts: Parameters<typeof event>[1] = {}): Promise<Response> {
    const result: APIGatewayProxyResult = await handler(event(sub, opts));
    return { statusCode: result.statusCode, body: JSON.parse(result.body) };
  }

  const getState = (key: string, applicationId?: string) => call(subs[key], { applicationId });
  const postAction = (key: string, action: string, body: unknown, applicationId?: string) =>
    call(subs[key], { method: 'POST', action, body, applicationId });

  /** Reads one application row past RLS, as the superuser. */
  async function row(applicationId: string): Promise<Record<string, any>> {
    const res = await su.query(
      `SELECT status, application_answers, prompt_answers,
              details_requested_at, details_completed_at
         FROM job_applications WHERE id = $1`,
      [applicationId],
    );
    return res.rows[0];
  }

  beforeAll(async () => {
    await su.connect();
    if (new URL(databaseUrl as string).username !== 'jale_whatsapp') {
      await su.query(`ALTER ROLE jale_whatsapp WITH PASSWORD 'test-whatsapp-pw'`);
    }
    rolePool = new Pool({
      connectionString: urlForRole(databaseUrl as string, 'jale_whatsapp', 'test-whatsapp-pw'),
      max: 4,
    });

    // ── Employer + a display name to resolve ──────────────────────
    subs.employer = `l24-employer-${tag}`;
    ids.employer = (await su.query<{ id: string }>(
      `INSERT INTO users (cognito_sub, user_type, email) VALUES ($1, 'employer', $2) RETURNING id`,
      [subs.employer, `l24-employer-${tag}@example.com`],
    )).rows[0].id;
    await su.query(
      `INSERT INTO employer_profiles (user_id, company_name) VALUES ($1, 'L24 Builders')`,
      [ids.employer],
    );

    // ── Workers ───────────────────────────────────────────────────
    for (const key of WORKERS) {
      subs[key] = `l24-${key}-${tag}`;
      ids[key] = (await su.query<{ id: string }>(
        `INSERT INTO users (cognito_sub, user_type, phone, email, tos_version)
         VALUES ($1, 'worker', $2, $3, $4) RETURNING id`,
        [
          subs[key],
          `+1555${Math.floor(1000000 + Math.random() * 8999999)}`,
          `l24-${key}-${tag}@example.com`,
          // The legal wall's negative case gets a stale version; everyone
          // else is compliant.
          key === 'badtos' ? '0.9' : REQUIRED_TOS,
        ],
      )).rows[0].id;
    }

    // ── The job under test ────────────────────────────────────────
    jobId = (await su.query<{ id: string }>(
      `INSERT INTO jobs (employer_id, title, location, job_type, status,
                         required_fields, optional_fields, required_docs, optional_docs,
                         certification_requirements, pre_application_prompts,
                         number_of_workers_needed)
       VALUES ($1, 'L24 Concrete Finisher', 'El Paso', 'full-time', 'active',
               '{home_address,date_available}', '{desired_pay}', '{resume}', '{driver_license}',
               $2::jsonb, $3::jsonb,
               -- THREE openings, not the default one. Hiring A in case 8b
               -- fires job_applications_hired_count_sync, and a job whose last
               -- opening just closed flips to status = filled -- which the
               -- engine write gate reads as closed. A one-opening job would
               -- make every case after the hire 409 for a reason that has
               -- nothing to do with what it is testing.
               3)
       RETURNING id`,
      [
        ids.employer,
        JSON.stringify([{ name: 'OSHA 10', tier: 'required', proof_required: true }]),
        JSON.stringify([{ id: 'p1', text: 'Why you?' }]),
      ],
    )).rows[0].id;

    // A second, requirement-free job, so the `application_closed` case can
    // close a job WITHOUT disturbing the walk on the job above.
    simpleJobId = (await su.query<{ id: string }>(
      `INSERT INTO jobs (employer_id, title, location, job_type, status)
       VALUES ($1, 'L24 Helper', 'El Paso', 'full-time', 'active') RETURNING id`,
      [ids.employer],
    )).rows[0].id;

    // ── Applications ──────────────────────────────────────────────
    // Sprint 23 applies BEFORE any document exists, by design. 091 dropped
    // the 022 required-docs INSERT guard for exactly that reason (verified on
    // this testbed: job_applications carries only updated_at,
    // hired_count_sync and hire_requirements_guard triggers), so the
    // transaction-local bypass below is currently a no-op. It stays because
    // it costs nothing and keeps this fixture correct against a database
    // where the guard is still installed.
    await su.query('BEGIN');
    await su.query(`SELECT set_config('app.allow_incomplete_docs', 'on', true)`);
    appA = (await su.query<{ id: string }>(
      `INSERT INTO job_applications (job_id, worker_id, status, application_answers)
       VALUES ($1, $2, 'talking', '{}'::jsonb) RETURNING id`,
      [jobId, ids.owner],
    )).rows[0].id;
    appB = (await su.query<{ id: string }>(
      `INSERT INTO job_applications (job_id, worker_id, status, application_answers)
       VALUES ($1, $2, 'talking', '{}'::jsonb) RETURNING id`,
      [jobId, ids.foreign],
    )).rows[0].id;
    appC = (await su.query<{ id: string }>(
      `INSERT INTO job_applications (job_id, worker_id, status, application_answers)
       VALUES ($1, $2, 'talking', '{}'::jsonb) RETURNING id`,
      [simpleJobId, ids.closed],
    )).rows[0].id;
    await su.query('COMMIT');

    // ── Documents ─────────────────────────────────────────────────
    // A's resume sits in the VAULT (job_id IS NULL). The door must copy it
    // onto the job on the first read; without that sync a vault-only resume
    // reads as missing forever.
    await su.query(
      `INSERT INTO worker_documents (worker_id, job_id, doc_type, s3_key, file_name, file_size, mime_type)
       VALUES ($1, NULL, 'resume', $2, 'resume.pdf', 1024, 'application/pdf')`,
      [ids.owner, `l24-${tag}-owner-resume`],
    );
    bCertDocId = (await su.query<{ id: string }>(
      `INSERT INTO worker_documents (worker_id, job_id, doc_type, s3_key, file_name, file_size, mime_type)
       VALUES ($1, NULL, 'certification_doc', $2, 'b-osha.pdf', 2048, 'application/pdf')
       RETURNING id`,
      [ids.foreign, `l24-${tag}-foreign-cert`],
    )).rows[0].id;
    aCertDocId = (await su.query<{ id: string }>(
      `INSERT INTO worker_documents (worker_id, job_id, doc_type, s3_key, file_name, file_size, mime_type)
       VALUES ($1, NULL, 'certification_doc', $2, 'a-osha.pdf', 2048, 'application/pdf')
       RETURNING id`,
      [ids.owner, `l24-${tag}-owner-cert`],
    )).rows[0].id;

    process.env.REQUIRED_TOS_VERSION = REQUIRED_TOS;
  }, 60_000);

  afterAll(async () => {
    await rolePool?.end();
    const fixtureIds = Object.values(ids);
    if (fixtureIds.length > 0) {
      await su.query(`DELETE FROM worker_documents WHERE worker_id = ANY($1::uuid[])`, [fixtureIds]);
      await su.query(`DELETE FROM worker_application_defaults WHERE worker_id = ANY($1::uuid[])`, [fixtureIds]);
      await su.query(`DELETE FROM job_applications WHERE worker_id = ANY($1::uuid[])`, [fixtureIds]);
      await su.query(`DELETE FROM jobs WHERE employer_id = ANY($1::uuid[])`, [fixtureIds]);
      await su.query(`DELETE FROM employer_profiles WHERE user_id = ANY($1::uuid[])`, [fixtureIds]);
      await su.query(`DELETE FROM legal_consent_log WHERE user_id = ANY($1::uuid[])`, [fixtureIds]);
      await su.query(`DELETE FROM users WHERE id = ANY($1::uuid[])`, [fixtureIds]);
    }
    await su.end();
  });

  // =====================================================================
  // 1. The read
  // =====================================================================

  test('1. GET renders the state and SYNCS the vault resume onto the job', async () => {
    const res = await getState('owner');

    expect(res.statusCode).toBe(200);
    expect(res.body.application).toMatchObject({
      id: appA,
      job_id: jobId,
      status: 'talking',
      // The employer has not asked yet, so no requirement is outstanding
      // and the stage gate holds.
      details_status: 'not_requested',
      stage: 'apply',
      details_requested_at: null,
      details_completed_at: null,
    });
    // 031's definer resolved through the LAST query of the transaction.
    expect(res.body.job.company_name).toBe('L24 Builders');
    expect(res.body.job.required_fields).toEqual(['home_address', 'date_available']);
    expect(res.body.job.pre_application_prompts).toEqual([{ id: 'p1', text: 'Why you?' }]);

    // The vault row was job_id IS NULL a moment ago; the door's
    // syncDocumentSnapshots pass copied it.
    const doc = res.body.documents.find((d: any) => d.doc_type === 'resume');
    expect(doc).toEqual({ doc_type: 'resume', present: true });
    expect(res.body.documents.find((d: any) => d.doc_type === 'driver_license'))
      .toEqual({ doc_type: 'driver_license', present: false });

    const copied = await su.query(
      `SELECT 1 FROM worker_documents WHERE worker_id = $1 AND job_id = $2 AND doc_type = 'resume'`,
      [ids.owner, jobId],
    );
    expect(copied.rowCount).toBe(1);

    // Stage 1's only question is the prompt; fields/certs/docs are behind
    // the stage gate.
    expect(res.body.next_step).toEqual({ kind: 'prompt', promptId: 'p1', text: 'Why you?' });
    expect(res.body.remaining.prompts).toEqual(['p1']);
  });

  // =====================================================================
  // 2. Cross-tenant
  // =====================================================================

  test('2. neither worker can reach the other\'s application (USING(true) proves nothing)', async () => {
    const before = await su.query(`SELECT updated_at FROM job_applications WHERE id = ANY($1::uuid[])`, [[appA, appB]]);

    const aReadsB = await getState('owner', appB);
    const bReadsA = await getState('foreign', appA);

    expect(aReadsB.statusCode).toBe(404);
    expect(aReadsB.body).toEqual({ error: 'not_found' });
    expect(bReadsA.statusCode).toBe(404);
    expect(bReadsA.body).toEqual({ error: 'not_found' });

    const after = await su.query(`SELECT updated_at FROM job_applications WHERE id = ANY($1::uuid[])`, [[appA, appB]]);
    expect(after.rows).toEqual(before.rows);
  });

  test('2b. a syntactically impossible id is 404, never a 22P02 500', async () => {
    const res = await call(subs.owner, { applicationId: 'not-a-uuid' });
    expect(res.statusCode).toBe(404);
    expect(res.body).toEqual({ error: 'not_found' });
  });

  // =====================================================================
  // 3. The stage gate
  // =====================================================================

  test('3. POST answers before the employer asks is 409 stage_locked, with the state', async () => {
    const res = await postAction('owner', 'answers', { answers: { home_address: HOME_ADDRESS } });

    expect(res.statusCode).toBe(409);
    expect(res.body.error).toBe('stage_locked');
    expect(res.body.state.application.stage).toBe('apply');
    expect(res.body.state.job.company_name).toBe('L24 Builders');

    expect((await row(appA)).application_answers).toEqual({});
  });

  // =====================================================================
  // 4. The employer asks; the questionnaire opens
  // =====================================================================

  test('4. after details_requested_at, POST answers writes and saves the defaults', async () => {
    await su.query(
      `UPDATE job_applications SET details_requested_at = now(), status = 'details_requested' WHERE id = $1`,
      [appA],
    );

    const res = await postAction('owner', 'answers', {
      answers: { home_address: HOME_ADDRESS, date_available: '2026-10-01' },
    });

    expect(res.statusCode).toBe(200);
    // Still 'requested': the certification and the prompt are outstanding.
    expect(res.body.application.details_status).toBe('requested');
    expect(res.body.application.stage).toBe('details');
    expect(res.body.answers).toEqual({ home_address: HOME_ADDRESS, date_available: '2026-10-01' });

    const stored = await row(appA);
    expect(stored.application_answers).toEqual({
      home_address: HOME_ADDRESS,
      date_available: '2026-10-01',
    });
    expect(stored.details_completed_at).toBeNull();

    // B4.0 §9: the same answers are saved as this worker's defaults, through
    // 091's INSERT/UPDATE grant on worker_application_defaults (FORCE RLS,
    // reached only because the door set app.current_internal_user_id).
    const defaults = await su.query<{ answers: Record<string, unknown> }>(
      `SELECT answers FROM worker_application_defaults WHERE worker_id = $1`,
      [ids.owner],
    );
    expect(defaults.rowCount).toBe(1);
    expect(defaults.rows[0].answers).toMatchObject({
      home_address: HOME_ADDRESS,
      date_available: '2026-10-01',
    });
  });

  // =====================================================================
  // 5. All-or-nothing
  // =====================================================================

  test('5. one bad key rejects the WHOLE batch and writes nothing', async () => {
    const before = await row(appA);

    const res = await postAction('owner', 'answers', {
      answers: { home_address: { ...HOME_ADDRESS, street: '999 Elsewhere Ave' }, not_a_field: 'y' },
    });

    expect(res.statusCode).toBe(400);
    expect(res.body.error).toBe('invalid_answers');
    expect(res.body.errors.not_a_field).toBe('unknown_answer_key');

    // The good half of the batch is NOT persisted.
    expect((await row(appA)).application_answers).toEqual(before.application_answers);
  });

  // =====================================================================
  // 6. Certifications: a foreign doc id is dropped, not trusted
  // =====================================================================

  test('6. a claim naming ANOTHER worker\'s certification_doc keeps the claim and drops the id', async () => {
    const res = await postAction('owner', 'certifications', {
      claims: [{ name: 'OSHA 10', has: true, doc_ids: [bCertDocId] }],
    });

    expect(res.statusCode).toBe(200);
    expect(res.body.certifications).toEqual([{ name: 'OSHA 10', has: true, doc_ids: [] }]);
    // Claimed but unproven -- which is exactly what the hire gate will
    // refuse in case 8.
    expect(res.body.remaining.certifications.unproven).toContain('OSHA 10');
    expect(res.body.remaining.certifications.unclaimed).not.toContain('OSHA 10');

    const stored = await row(appA);
    expect(stored.application_answers.certifications).toEqual([
      { name: 'OSHA 10', has: true, doc_ids: [] },
    ]);
    expect(stored.details_completed_at).toBeNull();
  });

  // =====================================================================
  // 7. Prompt answers are write-once, in SQL
  // =====================================================================

  test('7. prompt answers are write-once and an unknown prompt id is rejected', async () => {
    const first = await postAction('owner', 'prompt-answers', { answers: { p1: 'first' } });
    expect(first.statusCode).toBe(200);
    expect(first.body.prompt_answers).toEqual({ p1: 'first' });

    const second = await postAction('owner', 'prompt-answers', { answers: { p1: 'second' } });
    expect(second.statusCode).toBe(200);
    // `$1::jsonb || prompt_answers` -- the EXISTING value wins. Enforced by
    // the statement, not by a read-then-write race.
    expect(second.body.prompt_answers).toEqual({ p1: 'first' });
    expect((await row(appA)).prompt_answers).toEqual({ p1: 'first' });

    const unknown = await postAction('owner', 'prompt-answers', { answers: { p9: 'x' } });
    expect(unknown.statusCode).toBe(400);
    expect(unknown.body.error).toBe('invalid_answers');
    expect((await row(appA)).prompt_answers).toEqual({ p1: 'first' });
  });

  // =====================================================================
  // 8. Completion, and 091's hire gate
  // =====================================================================

  test('8a. proving the certification completes the details stage', async () => {
    const proved = await postAction('owner', 'certifications', {
      claims: [{ name: 'OSHA 10', has: true, doc_ids: [aCertDocId] }],
    });
    expect(proved.statusCode).toBe(200);
    expect(proved.body.certifications).toEqual([
      { name: 'OSHA 10', has: true, doc_ids: [aCertDocId] },
    ]);

    const res = await getState('owner');
    expect(res.statusCode).toBe(200);
    expect(res.body.application.details_status).toBe('complete');
    expect(res.body.application.details_completed_at).not.toBeNull();
    expect(res.body.next_step).toEqual({ kind: 'complete', stage: 'details' });
    expect(res.body.remaining.complete).toBe(true);

    expect((await row(appA)).details_completed_at).not.toBeNull();
  });

  test('8b. the employer can now hire A, and still cannot hire the untouched B', async () => {
    // A real jale_admin employer session: SET LOCAL ROLE so the employer
    // policies (and the 091 trigger) apply exactly as they do in production.
    const hireA = async (applicationId: string) => {
      await su.query('BEGIN');
      try {
        await su.query('SET LOCAL ROLE jale_admin');
        await su.query(`SELECT set_config('app.current_user_id', $1, true)`, [subs.employer]);
        const res = await su.query(
          `UPDATE job_applications SET status = 'hired' WHERE id = $1 RETURNING id`,
          [applicationId],
        );
        await su.query('COMMIT');
        return res.rowCount;
      } catch (err) {
        await su.query('ROLLBACK');
        throw err;
      }
    };

    expect(await hireA(appA)).toBe(1);

    // B never went through the door: no fields, no docs, no cert.
    await expect(hireA(appB)).rejects.toMatchObject({
      code: '23514',
      constraint: 'job_applications_hire_requirements_check',
    });
  });

  // =====================================================================
  // 9. Hostile / malformed input
  // =====================================================================

  test('9a. an over-cap body is 413 and never reaches the pool', async () => {
    const before = poolHandouts;
    const res = await call(subs.owner, {
      method: 'POST',
      action: 'answers',
      body: { answers: { home_address: 'x'.repeat(17 * 1024) } },
    });

    expect(res.statusCode).toBe(413);
    expect(res.body).toEqual({ error: 'payload_too_large' });
    expect(poolHandouts).toBe(before);
  });

  test('9b. malformed JSON is 400 and never reaches the pool', async () => {
    const before = poolHandouts;
    const res = await call(subs.owner, { method: 'POST', action: 'answers', rawBody: '{"answers":' });

    expect(res.statusCode).toBe(400);
    expect(res.body).toEqual({ error: 'invalid_request' });
    expect(poolHandouts).toBe(before);
  });

  test('9c. a __proto__ key is an unknown answer key, not a mutated prototype', async () => {
    // Routed through B, not A: A was HIRED in 8b, and the engine's write gate
    // (`closed` outranks everything) would answer 409 before any key was ever
    // looked at -- which would pass this test for entirely the wrong reason.
    // B needs the stage open for the same reason.
    await su.query(`UPDATE job_applications SET details_requested_at = now() WHERE id = $1`, [appB]);

    const res = await call(subs.foreign, {
      method: 'POST',
      action: 'answers',
      applicationId: appB,
      rawBody: '{"answers":{"__proto__":{"polluted":true}}}',
    });

    expect(res.statusCode).toBe(400);
    expect(res.body.error).toBe('invalid_answers');
    // The rejection is actually NAMED in the body -- an empty map here would
    // mean the door had shipped the prototype-setter no-op it guards against.
    expect(Object.keys(res.body.errors)).toEqual(['__proto__']);
    expect(({} as any).polluted).toBeUndefined();
    expect((Object.prototype as any).polluted).toBeUndefined();
  });

  test('9d. a NUL inside a string value is 400, never the 500 Postgres would raise', async () => {
    // `" "` is legal JSON and survives every length/trim validator, but
    // jsonb refuses it. Without the door's guard this is an unhandled raise.
    const before = await row(appB);
    const res = await call(subs.foreign, {
      method: 'POST',
      action: 'answers',
      rawBody: '{"answers":{"home_address":{"street":"a\\u0000b","city":"El Paso","state":"TX","zip":"79901"}}}',
    });

    expect(res.statusCode).toBe(400);
    expect(res.body).toEqual({ error: 'invalid_request' });
    expect((await row(appB)).application_answers).toEqual(before.application_answers);
  });

  test('9e. an unknown action is 404 and a non-POST on a known one is 405', async () => {
    const unknown = await call(subs.owner, { method: 'POST', action: 'complete', body: {} });
    expect(unknown.statusCode).toBe(404);

    const wrongMethod = await call(subs.owner, { method: 'DELETE', action: 'answers', body: {} });
    expect(wrongMethod.statusCode).toBe(405);
    expect(wrongMethod.body).toEqual({ error: 'method_not_allowed' });
  });

  test('9f. an unresolvable sub is 404 worker_not_found; a missing claim is 401', async () => {
    const nobody = await call(`l24-nobody-${randomUUID()}`);
    expect(nobody.statusCode).toBe(404);
    expect(nobody.body).toEqual({ error: 'worker_not_found' });

    // An EMPLOYER sub resolves to NULL too -- indistinguishable by design.
    const asEmployer = await call(subs.employer);
    expect(asEmployer.statusCode).toBe(404);
    expect(asEmployer.body).toEqual({ error: 'worker_not_found' });

    const result: APIGatewayProxyResult = await handler({
      httpMethod: 'GET',
      pathParameters: { applicationId: appA },
      body: null,
      requestContext: {},
    } as unknown as APIGatewayProxyEvent);
    expect(result.statusCode).toBe(401);
  });

  // =====================================================================
  // 10. The legal wall
  // =====================================================================

  test('10. a worker on a stale ToS version is 403 legal_required', async () => {
    const res = await call(subs.badtos, { applicationId: appC });

    expect(res.statusCode).toBe(403);
    expect(res.body).toMatchObject({
      error: 'legal_required',
      requiredVersion: REQUIRED_TOS,
      currentVersion: '0.9',
    });
  });

  // =====================================================================
  // 11. A closed job closes the door (runs LAST: it mutates the job)
  // =====================================================================

  test('11. a closed job answers 409 application_closed, with the state', async () => {
    await su.query(
      `UPDATE job_applications SET details_requested_at = now() WHERE id = $1`,
      [appC],
    );
    await su.query(`UPDATE jobs SET status = 'closed' WHERE id = $1`, [simpleJobId]);

    const res = await postAction('closed', 'answers', { answers: { home_address: HOME_ADDRESS } }, appC);

    expect(res.statusCode).toBe(409);
    expect(res.body.error).toBe('application_closed');
    expect(res.body.state.job.status).toBe('closed');

    expect((await row(appC)).application_answers).toEqual({});
  });
});
