/**
 * application-field-reuse.integration.test.ts
 *
 * Sprint 24 L3. The CROSS-JOB REUSE BOUNDARY against REAL PostgreSQL 16 with
 * migrations 001-092 applied, driven through the ACTUAL shared engine
 * (`lambda/lib/application-requirements.ts`) connected as the REAL
 * `jale_whatsapp` role -- not through hand-built SQL and not through a mocked
 * pool.
 *
 * WHY THIS SUITE EXISTS. The 2026-09-04T04:41:58Z incident: a worker tapped
 * Start on a details-requested notification and their application was sent to
 * the employer in the same turn, carrying answers ("worked here before", a
 * start date) they had given to a DIFFERENT company, while the job's required
 * work-authorization DOCUMENT was never asked for because a vault copy had
 * silently satisfied it. The unit suites cover the policy arithmetic. What
 * only a real database can settle:
 *
 *   - `worker_application_defaults` is RLS ENABLE + FORCE (079). 091 grants
 *     jale_whatsapp INSERT/UPDATE plus `worker_application_defaults_whatsapp_write`,
 *     keyed on `app.current_internal_user_id`. So a write with the wrong GUC
 *     (or none) is a ZERO-ROW no-op -- a SQL SUCCESS that a mocked pool
 *     renders as a green write-back. The whole point of the filter is WHICH
 *     keys reach that table, which is unfalsifiable without the real policy.
 *   - the jsonb `-` operator in `clearFieldAnswer`, and its
 *     `details_completed_at IS NULL` guard. Only a real column can show that
 *     the key is REMOVED (so `hasOwnProperty` stops matching and the question
 *     is asked again) rather than set to null, and that a completed
 *     application refuses the correction.
 *   - `copyRequiredDocumentSnapshots`' new `RETURNING doc_type` under
 *     `ON CONFLICT DO NOTHING`. Whether a suppressed insert still returns a
 *     row is a PostgreSQL fact, not an app-level one -- and the entire
 *     "which documents did we attach from your vault" message depends on it
 *     reporting a copy exactly once, never again on the idempotent re-call
 *     the engine performs on every worker-side read and write.
 *
 * CONNECTION. `JALE_TEST_DATABASE_URL` must be a SUPERUSER url for a
 * disposable database: fixtures and verification reads use it, and it ALTERs
 * jale_whatsapp's password to reconnect as that role. The engine itself only
 * ever runs on the jale_whatsapp client.
 *
 * CASES ARE ORDERED AND STATEFUL. They walk one worker's second application
 * exactly as the incident did -- defaults already saved, employer asks for
 * details, seed, answer, correct. Do not reorder them.
 */

import { randomUUID } from 'node:crypto';
import { Client } from 'pg';

import {
  loadRequirementSnapshot,
  computeRemaining,
  seedAnswersFromDefaults,
  mergeFieldAnswers,
  clearFieldAnswer,
} from '../../../lambda/lib/application-requirements';
import { copyRequiredDocumentSnapshots } from '../../../lambda/lib/applications';
import { setInternalUserRlsContext } from '../../../lambda/lib/db';
import { FIELD_REUSE_POLICY } from '../../../lambda/lib/job-fields';

const databaseUrl = process.env.JALE_TEST_DATABASE_URL;

function urlForRole(baseUrl: string, user: string, password: string): string {
  const u = new URL(baseUrl);
  u.username = user;
  u.password = password;
  return u.toString();
}

if (!databaseUrl) {
  test('CONCERN: the application field-reuse DB suite was not run', () => {
    // eslint-disable-next-line no-console
    console.warn(
      '[application-field-reuse] DONE_WITH_CONCERNS: set JALE_TEST_DATABASE_URL to a '
      + 'disposable PostgreSQL 16 superuser URL with migrations 001-092 applied.',
    );
    expect(databaseUrl).toBeUndefined();
  });
}

function maybeDescribe(name: string, fn: () => void): void {
  if (databaseUrl) describe(name, fn);
  else describe.skip(name, fn);
}

maybeDescribe('L3: the cross-job answer-reuse boundary', () => {
  const su = new Client({ connectionString: databaseUrl });
  /** The engine's connection: the REAL least-privilege role. */
  let wa: Client;

  const tag = randomUUID().slice(0, 8);
  let employerId = '';
  let workerId = '';
  let jobId = '';
  let otherJobId = '';
  let applicationId = '';
  let completedApplicationId = '';

  // Both classes, in ONE blob, exactly as the incident's row looked. The
  // stable half is legitimately reusable; the per_application half was
  // answered FOR ANOTHER EMPLOYER and must never be offered again.
  const STABLE_DEFAULTS = {
    work_authorization: { authorized: true },
    date_of_birth: '1990-04-03',
    home_address: { street: '123 Main St', city: 'El Paso', state: 'TX', zip: '79901' },
  };
  const PER_APPLICATION_DEFAULTS = {
    date_available: '2026-09-10',
    worked_here_before: { answer: true },
    desired_pay: { amount: 25, interval: 'hourly' },
    emergency_contact: { name: 'Maria Lopez', phone: '5551234567' },
  };

  /** Reads one application's answers past RLS, as the superuser. */
  async function answersOf(id: string): Promise<Record<string, unknown>> {
    const res = await su.query<{ application_answers: Record<string, unknown> }>(
      `SELECT application_answers FROM job_applications WHERE id = $1`,
      [id],
    );
    return res.rows[0].application_answers;
  }

  /** Reads the worker's saved defaults past RLS, as the superuser. */
  async function savedDefaults(): Promise<Record<string, unknown>> {
    const res = await su.query<{ answers: Record<string, unknown> | null }>(
      `SELECT answers FROM worker_application_defaults WHERE worker_id = $1`,
      [workerId],
    );
    return res.rows[0]?.answers ?? {};
  }

  /** One engine call inside its own transaction on the jale_whatsapp client,
   * with the GUC the FORCE-RLS policies key on -- the same envelope
   * processor.ts and the web door provide per turn/request. */
  async function asWorker<T>(fn: () => Promise<T>): Promise<T> {
    await wa.query('BEGIN');
    try {
      await setInternalUserRlsContext(wa, workerId);
      const out = await fn();
      await wa.query('COMMIT');
      return out;
    } catch (err) {
      await wa.query('ROLLBACK');
      throw err;
    }
  }

  beforeAll(async () => {
    await su.connect();
    if (new URL(databaseUrl as string).username !== 'jale_whatsapp') {
      await su.query(`ALTER ROLE jale_whatsapp WITH PASSWORD 'test-whatsapp-pw'`);
    }
    wa = new Client({
      connectionString: urlForRole(databaseUrl as string, 'jale_whatsapp', 'test-whatsapp-pw'),
    });
    await wa.connect();

    employerId = (await su.query<{ id: string }>(
      `INSERT INTO users (cognito_sub, user_type, email) VALUES ($1, 'employer', $2) RETURNING id`,
      [`l3-employer-${tag}`, `l3-employer-${tag}@example.com`],
    )).rows[0].id;
    await su.query(
      `INSERT INTO employer_profiles (user_id, company_name) VALUES ($1, 'L3 Builders')`,
      [employerId],
    );

    workerId = (await su.query<{ id: string }>(
      `INSERT INTO users (cognito_sub, user_type, phone, email, tos_version)
       VALUES ($1, 'worker', $2, $3, '1.0') RETURNING id`,
      [
        `l3-worker-${tag}`,
        `+1555${Math.floor(1000000 + Math.random() * 8999999)}`,
        `l3-worker-${tag}@example.com`,
      ],
    )).rows[0].id;

    // The job asks for BOTH classes of field plus a work-authorization
    // DOCUMENT -- the incident's exact requirement set.
    jobId = (await su.query<{ id: string }>(
      `INSERT INTO jobs (employer_id, title, location, job_type, status,
                         required_fields, optional_fields, required_docs)
       VALUES ($1, 'L3 Concrete Finisher', 'El Paso', 'full-time', 'active',
               '{work_authorization,date_available,worked_here_before,date_of_birth}',
               '{home_address,desired_pay}',
               '{work_auth_doc}')
       RETURNING id`,
      [employerId],
    )).rows[0].id;

    otherJobId = (await su.query<{ id: string }>(
      `INSERT INTO jobs (employer_id, title, location, job_type, status, required_fields)
       VALUES ($1, 'L3 Helper', 'El Paso', 'full-time', 'active', '{date_available}')
       RETURNING id`,
      [employerId],
    )).rows[0].id;

    // Stage 2 from the start: `details_requested_at` is what the engine gates
    // on, never the literal status (B4.0 §7).
    applicationId = (await su.query<{ id: string }>(
      `INSERT INTO job_applications (job_id, worker_id, status, application_answers, details_requested_at)
       VALUES ($1, $2, 'details_requested', '{}'::jsonb, now()) RETURNING id`,
      [jobId, workerId],
    )).rows[0].id;
    completedApplicationId = (await su.query<{ id: string }>(
      `INSERT INTO job_applications (job_id, worker_id, status, application_answers,
                                     details_requested_at, details_completed_at)
       VALUES ($1, $2, 'details_requested', $3::jsonb, now(), now()) RETURNING id`,
      [otherJobId, workerId, JSON.stringify({ date_available: '2026-10-01' })],
    )).rows[0].id;

    // The worker's saved defaults, as a legacy row: written before the policy
    // existed, so it holds both classes.
    await su.query(
      `INSERT INTO worker_application_defaults (worker_id, answers) VALUES ($1, $2::jsonb)`,
      [workerId, JSON.stringify({ ...STABLE_DEFAULTS, ...PER_APPLICATION_DEFAULTS })],
    );

    // Their work-authorization document sits in the VAULT (job_id IS NULL).
    await su.query(
      `INSERT INTO worker_documents (worker_id, job_id, doc_type, s3_key, file_name, file_size, mime_type)
       VALUES ($1, NULL, 'work_auth_doc', $2, 'permit.pdf', 2048, 'application/pdf')`,
      [workerId, `documents/vault/${workerId}/work_auth_doc/${randomUUID()}.pdf`],
    );
  });

  afterAll(async () => {
    // FK cascades from users cover job_applications / worker_documents /
    // worker_application_defaults; jobs hang off the employer.
    if (workerId) await su.query(`DELETE FROM users WHERE id = $1`, [workerId]);
    if (employerId) await su.query(`DELETE FROM users WHERE id = $1`, [employerId]);
    await wa.end();
    await su.end();
  });

  it('0. the fixture really is a mixed legacy blob, and the policy really does split it', async () => {
    const saved = await savedDefaults();
    for (const key of Object.keys(STABLE_DEFAULTS)) {
      expect(FIELD_REUSE_POLICY[key as keyof typeof FIELD_REUSE_POLICY]).toBe('stable');
      expect(saved).toHaveProperty(key);
    }
    for (const key of Object.keys(PER_APPLICATION_DEFAULTS)) {
      expect(FIELD_REUSE_POLICY[key as keyof typeof FIELD_REUSE_POLICY]).toBe('per_application');
      expect(saved).toHaveProperty(key);
    }
  });

  it('1. the seed lands ONLY the stable keys in application_answers, over the real role and the real GUC', async () => {
    const snapshot = await asWorker(() => loadRequirementSnapshot(wa as any, applicationId));
    expect(snapshot).not.toBeNull();

    const seeded = await asWorker(() => seedAnswersFromDefaults(
      wa as any,
      { applicationId, workerId },
      snapshot!.requiredFields,
      snapshot!.optionalFields,
    ));

    // work_authorization + date_of_birth (required) and home_address
    // (optional) are reusable; the job's date_available / worked_here_before
    // / desired_pay are not, even though the blob holds all three.
    expect([...seeded].sort()).toEqual(['date_of_birth', 'home_address', 'work_authorization']);

    const answers = await answersOf(applicationId);
    expect(Object.keys(answers).sort()).toEqual(['date_of_birth', 'home_address', 'work_authorization']);
    // The incident's two leaked answers are absent from the column itself --
    // not merely absent from a return value.
    expect(answers).not.toHaveProperty('date_available');
    expect(answers).not.toHaveProperty('worked_here_before');
    expect(answers).not.toHaveProperty('desired_pay');
    expect(answers).not.toHaveProperty('emergency_contact');
  });

  it('2. the questions the seed refused are still OUTSTANDING, so the worker is asked them', async () => {
    const snapshot = await asWorker(() => loadRequirementSnapshot(wa as any, applicationId));
    const remaining = computeRemaining(snapshot!);

    expect(remaining.fields).toEqual(['date_available', 'worked_here_before']);
    expect(remaining.complete).toBe(false);
    // The counts the intro advertises can never be "0 y 0" here, which is
    // exactly what the incident reported before completing.
    expect(remaining.counts.fields).toBe(2);
  });

  it('3. answering a per_application field writes the APPLICATION but never the defaults blob', async () => {
    const before = await savedDefaults();

    const result = await asWorker(() => mergeFieldAnswers(wa as any, {
      applicationId,
      workerId,
      answers: { date_available: '2026-12-01', worked_here_before: { answer: false } },
    }));

    expect(result).toMatchObject({ ok: true });
    // The employer asked, so the answers ARE on the application.
    const answers = await answersOf(applicationId);
    expect(answers.date_available).toBe('2026-12-01');
    expect(answers.worked_here_before).toEqual({ answer: false });

    // ...and the saved defaults are byte-identical to before: the new
    // per_application answers were not merged, and nothing else was
    // disturbed either.
    expect(await savedDefaults()).toEqual(before);
  });

  it('4. answering a STABLE field does update the defaults blob (the feature still works)', async () => {
    const result = await asWorker(() => mergeFieldAnswers(wa as any, {
      applicationId,
      workerId,
      answers: { home_address: { street: '900 Oak Ave', city: 'Austin', state: 'TX', zip: '78701' } },
    }));

    expect(result).toMatchObject({ ok: true });
    const saved = await savedDefaults();
    // The jsonb `||` merge replaced this one key and left every other
    // stored key -- including the legacy per_application ones nobody has
    // backfilled away -- untouched.
    expect(saved.home_address).toEqual({ street: '900 Oak Ave', city: 'Austin', state: 'TX', zip: '78701' });
    expect(saved.date_of_birth).toBe('1990-04-03');
    expect(saved).toHaveProperty('date_available');
  });

  it('5. the vault document copy REPORTS itself exactly once, and never again', async () => {
    // First sync: the vault row is copied onto the job and reported, which is
    // what lets the bot say "Documentos adjuntados de tu boveda: ...".
    const first = await asWorker(() => copyRequiredDocumentSnapshots(
      wa as any, workerId, jobId, ['work_auth_doc'],
    ));
    expect(first).toEqual(['work_auth_doc']);

    // Idempotent re-call -- the engine does this on EVERY worker-side read
    // and write. `ON CONFLICT DO NOTHING` suppresses the insert, so
    // `RETURNING` yields nothing and a re-arm reports no reuse. (A mocked
    // pool cannot decide this; PostgreSQL can.)
    const second = await asWorker(() => copyRequiredDocumentSnapshots(
      wa as any, workerId, jobId, ['work_auth_doc'],
    ));
    expect(second).toEqual([]);

    // The copy really did satisfy the requirement, and the VAULT row is
    // still the worker's own (two rows now: vault + job-scoped).
    const rows = await su.query<{ n: string }>(
      `SELECT count(*) AS n FROM worker_documents
        WHERE worker_id = $1 AND doc_type = 'work_auth_doc'`,
      [workerId],
    );
    expect(Number(rows.rows[0].n)).toBe(2);
  });

  it('6. clearFieldAnswer REMOVES the key, so the question comes back (not a stored null)', async () => {
    const cleared = await asWorker(() => clearFieldAnswer(wa as any, {
      applicationId, key: 'date_of_birth',
    }));
    expect(cleared).toBe(true);

    const answers = await answersOf(applicationId);
    expect(Object.prototype.hasOwnProperty.call(answers, 'date_of_birth')).toBe(false);

    // The engine's presence check is hasOwnProperty, so a stored null would
    // still read as answered -- this is the assertion that proves the jsonb
    // `-` operator, not a null merge, is what runs.
    const snapshot = await asWorker(() => loadRequirementSnapshot(wa as any, applicationId));
    expect(computeRemaining(snapshot!).fields).toContain('date_of_birth');

    // A correction is not a profile edit: the saved default stands.
    expect(await savedDefaults()).toHaveProperty('date_of_birth', '1990-04-03');
  });

  it('7. clearFieldAnswer refuses an application the employer already sees as complete', async () => {
    const cleared = await asWorker(() => clearFieldAnswer(wa as any, {
      applicationId: completedApplicationId, key: 'date_available',
    }));

    // Zero rows, because of the `details_completed_at IS NULL` guard -- a
    // hole punched here would make 091's BEFORE-UPDATE hire gate reject the
    // hire later.
    expect(cleared).toBe(false);
    expect(await answersOf(completedApplicationId)).toEqual({ date_available: '2026-10-01' });
  });

  it('8. every write above needed the GUC: without it the defaults write is a silent no-op', async () => {
    const before = await savedDefaults();

    // No setInternalUserRlsContext -- exactly what a caller that forgets the
    // envelope produces. worker_application_defaults is FORCE RLS and
    // `worker_application_defaults_whatsapp_write` keys on the GUC, so the
    // UPDATE matches nothing and the INSERT's ON CONFLICT arm never fires.
    await wa.query('BEGIN');
    let raised: unknown;
    try {
      await mergeFieldAnswers(wa as any, {
        applicationId,
        workerId,
        answers: { date_of_birth: '1988-01-01' },
      });
    } catch (err) {
      raised = err;
    }
    await wa.query('ROLLBACK');

    // Either it raised (RLS refused the row outright) or it silently wrote
    // nothing -- what must NEVER happen is a successful write of a
    // stranger's identity. Both outcomes leave the stored row untouched.
    expect(await savedDefaults()).toEqual(before);
    if (raised) expect(String((raised as Error).message)).not.toContain('1988-01-01');
  });
});
