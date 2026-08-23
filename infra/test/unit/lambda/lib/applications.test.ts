import { applyWorkerToJob } from '../../../../lambda/lib/applications';

const makeClient = (query: jest.Mock) => ({ query }) as any;

describe('applyWorkerToJob', () => {
  it('returns job_closed when the active job is not visible', async () => {
    const query = jest.fn()
      .mockResolvedValueOnce({ rows: [] }) // internal RLS context
      .mockResolvedValueOnce({ rows: [] }); // job lookup

    const result = await applyWorkerToJob(makeClient(query), {
      workerId: 'worker-1',
      jobId: 'job-1',
      surface: 'web',
    });

    expect(result).toEqual({ status: 'job_closed' });
    // No FOR UPDATE: the row lock needs UPDATE on `jobs`, which jale_whatsapp
    // lacks (ADR-W05). Idempotency comes from INSERT ... ON CONFLICT instead.
    expect(String(query.mock.calls[1][0])).not.toContain('FOR UPDATE');
  });

  it('returns missing_documents using only vault or same-job docs', async () => {
    const query = jest.fn()
      .mockResolvedValueOnce({ rows: [] }) // internal RLS context
      .mockResolvedValueOnce({ rows: [{ id: 'job-1', required_docs: ['resume', 'driver_license'] }] })
      .mockResolvedValueOnce({ rows: [{ doc_type: 'resume' }] });

    const result = await applyWorkerToJob(makeClient(query), {
      workerId: 'worker-1',
      jobId: 'job-1',
      surface: 'web',
    });

    expect(result).toEqual({ status: 'missing_documents', missing_docs: ['driver_license'] });
    expect(String(query.mock.calls[1][0])).not.toContain('FOR UPDATE');
    const docsSql = String(query.mock.calls[2][0]);
    expect(docsSql).toContain('job_id IS NULL OR job_id = $3::uuid');
  });

  it('inserts the application and copies required document snapshots with S3 version IDs', async () => {
    const query = jest.fn()
      .mockResolvedValueOnce({ rows: [] }) // internal RLS context
      .mockResolvedValueOnce({ rows: [{ id: 'job-1', required_docs: ['resume'] }] })
      .mockResolvedValueOnce({ rows: [{ doc_type: 'resume' }] })
      .mockResolvedValueOnce({}) // worker_application_defaults upsert
      .mockResolvedValueOnce({ rows: [{ id: 'app-1', job_id: 'job-1', status: 'pending', applied_at: 'ts' }] })
      .mockResolvedValueOnce({ rowCount: 1 });

    const result = await applyWorkerToJob(makeClient(query), {
      workerId: 'worker-1',
      jobId: 'job-1',
      surface: 'web',
    });

    expect(result).toEqual({
      status: 'applied',
      application: { id: 'app-1', job_id: 'job-1', status: 'pending', applied_at: 'ts' },
    });
    const copySql = String(query.mock.calls[5][0]);
    expect(String(query.mock.calls[1][0])).not.toContain('FOR UPDATE');
    expect(copySql).toContain('s3_version_id');
    expect(copySql).toContain('AND (job_id IS NULL OR job_id = $1::uuid)');
  });

  it('repairs missing snapshots before returning already_applied', async () => {
    const query = jest.fn()
      .mockResolvedValueOnce({ rows: [] }) // internal RLS context
      .mockResolvedValueOnce({ rows: [{ id: 'job-1', required_docs: ['resume'] }] })
      .mockResolvedValueOnce({ rows: [{ doc_type: 'resume' }] })
      .mockResolvedValueOnce({}) // worker_application_defaults upsert
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rowCount: 1 }) // snapshot repair
      .mockResolvedValueOnce({ rows: [{ id: 'app-1', job_id: 'job-1', status: 'pending', applied_at: 'ts' }] });

    const result = await applyWorkerToJob(makeClient(query), {
      workerId: 'worker-1',
      jobId: 'job-1',
      surface: 'web',
    });

    expect(result.status).toBe('already_applied');
    expect(query.mock.calls.some(([sql]) => String(sql).includes('INSERT INTO worker_documents'))).toBe(true);
  });

  it('returns missing_answers listing unanswered required fields (web)', async () => {
    const query = jest.fn()
      .mockResolvedValueOnce({ rows: [] }) // internal RLS context
      .mockResolvedValueOnce({
        rows: [{
          id: 'job-1', required_docs: [], optional_docs: [],
          required_fields: ['work_authorization', 'date_available'], optional_fields: [],
        }],
      });

    const result = await applyWorkerToJob(makeClient(query), {
      workerId: 'worker-1',
      jobId: 'job-1',
      surface: 'web',
      answers: { work_authorization: true },
    });

    expect(result).toEqual({ status: 'missing_answers', missing_fields: ['date_available'] });
  });

  it('returns invalid_answers when the answers payload is not a plain object (web)', async () => {
    const query = jest.fn()
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({
        rows: [{ id: 'job-1', required_docs: [], optional_docs: [], required_fields: [], optional_fields: [] }],
      });

    const result = await applyWorkerToJob(makeClient(query), {
      workerId: 'worker-1',
      jobId: 'job-1',
      surface: 'web',
      answers: ['not', 'an', 'object'] as any,
    });

    expect(result).toEqual({ status: 'invalid_answers', error: 'invalid_answers' });
  });

  it('returns invalid_answers for an unknown answer key (web)', async () => {
    const query = jest.fn()
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({
        rows: [{ id: 'job-1', required_docs: [], optional_docs: [], required_fields: [], optional_fields: ['date_available'] }],
      });

    const result = await applyWorkerToJob(makeClient(query), {
      workerId: 'worker-1',
      jobId: 'job-1',
      surface: 'web',
      answers: { bogus_key: 'x' },
    });

    expect(result).toEqual({ status: 'invalid_answers', error: 'unknown_answer_key' });
  });

  it('persists validated answers as the third INSERT param (web)', async () => {
    const query = jest.fn()
      .mockResolvedValueOnce({ rows: [] }) // internal RLS context
      .mockResolvedValueOnce({
        rows: [{
          id: 'job-1', required_docs: [], optional_docs: [],
          required_fields: ['work_authorization'], optional_fields: [],
        }],
      })
      .mockResolvedValueOnce({}) // worker_application_defaults upsert
      .mockResolvedValueOnce({ rows: [{ id: 'app-1', job_id: 'job-1', status: 'pending', applied_at: 'ts' }] });

    const result = await applyWorkerToJob(makeClient(query), {
      workerId: 'worker-1',
      jobId: 'job-1',
      surface: 'web',
      answers: { work_authorization: true },
    });

    expect(result.status).toBe('applied');
    const insertCall = query.mock.calls[3];
    expect(String(insertCall[0])).toContain('application_answers');
    expect(insertCall[1]).toEqual(['job-1', 'worker-1', JSON.stringify({ work_authorization: true })]);
  });

  it('applies successfully when an optional field is absent from answers (web)', async () => {
    const query = jest.fn()
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({
        rows: [{
          id: 'job-1', required_docs: [], optional_docs: [],
          required_fields: [], optional_fields: ['work_authorization'],
        }],
      })
      .mockResolvedValueOnce({}) // worker_application_defaults upsert
      .mockResolvedValueOnce({ rows: [{ id: 'app-1', job_id: 'job-1', status: 'pending', applied_at: 'ts' }] });

    const result = await applyWorkerToJob(makeClient(query), {
      workerId: 'worker-1',
      jobId: 'job-1',
      surface: 'web',
    });

    expect(result.status).toBe('applied');
    const insertCall = query.mock.calls[3];
    expect(insertCall[1]).toEqual(['job-1', 'worker-1', JSON.stringify({})]);
  });

  it('whatsapp surface bypasses the answers gate on a job with non-empty required_fields', async () => {
    const query = jest.fn()
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({
        rows: [{
          id: 'job-1', required_docs: [], optional_docs: [],
          required_fields: ['work_authorization', 'date_available'], optional_fields: [],
        }],
      })
      .mockResolvedValueOnce({ rows: [] }) // set_config('app.allow_incomplete_docs', ...)
      .mockResolvedValueOnce({ rows: [{ id: 'app-1', job_id: 'job-1', status: 'pending', applied_at: 'ts' }] });

    const result = await applyWorkerToJob(makeClient(query), {
      workerId: 'worker-1',
      jobId: 'job-1',
      surface: 'whatsapp',
    });

    expect(result.status).toBe('applied');
    const insertCall = query.mock.calls[3];
    expect(insertCall[1]).toEqual(['job-1', 'worker-1', JSON.stringify({})]);
  });

  it('whatsapp surface never persists a non-plain-object answers payload as-is', async () => {
    const query = jest.fn()
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({
        rows: [{ id: 'job-1', required_docs: [], optional_docs: [], required_fields: [], optional_fields: [] }],
      })
      .mockResolvedValueOnce({ rows: [] }) // set_config('app.allow_incomplete_docs', ...)
      .mockResolvedValueOnce({ rows: [{ id: 'app-1', job_id: 'job-1', status: 'pending', applied_at: 'ts' }] });

    const result = await applyWorkerToJob(makeClient(query), {
      workerId: 'worker-1',
      jobId: 'job-1',
      surface: 'whatsapp',
      answers: ['bad', 'shape'] as any,
    });

    expect(result.status).toBe('applied');
    const insertCall = query.mock.calls[3];
    expect(insertCall[1]).toEqual(['job-1', 'worker-1', JSON.stringify({})]);
  });

  it('whatsapp surface skips the missing-documents bounce and inserts', async () => {
    const query = jest.fn()
      .mockResolvedValueOnce({ rows: [] }) // internal RLS context
      .mockResolvedValueOnce({
        rows: [{ id: 'job-1', required_docs: ['resume'], optional_docs: [], required_fields: [], optional_fields: [] }],
      })
      .mockResolvedValueOnce({ rows: [] }) // missing-docs check -- worker has no documents
      .mockResolvedValueOnce({ rows: [] }) // set_config('app.allow_incomplete_docs', ...)
      .mockResolvedValueOnce({ rows: [{ id: 'app-1', job_id: 'job-1', status: 'pending', applied_at: 'ts' }] })
      .mockResolvedValueOnce({ rowCount: 0 }); // snapshot copy finds nothing to copy -- worker has no docs

    const result = await applyWorkerToJob(makeClient(query), {
      workerId: 'worker-1',
      jobId: 'job-1',
      surface: 'whatsapp',
    });

    expect(result.status).toBe('applied');
    const queries = query.mock.calls.map(([sql]) => String(sql));
    expect(queries).toContainEqual(expect.stringContaining("set_config('app.allow_incomplete_docs'"));
  });

  it('web surface still bounces on missing documents', async () => {
    const query = jest.fn()
      .mockResolvedValueOnce({ rows: [] }) // internal RLS context
      .mockResolvedValueOnce({
        rows: [{ id: 'job-1', required_docs: ['resume'], optional_docs: [], required_fields: [], optional_fields: [] }],
      })
      .mockResolvedValueOnce({ rows: [] }); // missing-docs check -- worker has no documents

    const result = await applyWorkerToJob(makeClient(query), {
      workerId: 'worker-1',
      jobId: 'job-1',
      surface: 'web',
    });

    expect(result).toEqual({ status: 'missing_documents', missing_docs: ['resume'] });
  });

  it('maps 23514 job_applications_required_docs_check to guard_blocked', async () => {
    const guardError = Object.assign(new Error('check constraint violated'), {
      code: '23514',
      constraint: 'job_applications_required_docs_check',
    });
    const query = jest.fn()
      .mockResolvedValueOnce({ rows: [] }) // internal RLS context
      .mockResolvedValueOnce({
        rows: [{ id: 'job-1', required_docs: ['resume'], optional_docs: [], required_fields: [], optional_fields: [] }],
      })
      .mockResolvedValueOnce({ rows: [] }) // missing-docs check -- worker has no documents
      .mockResolvedValueOnce({ rows: [] }) // set_config('app.allow_incomplete_docs', ...)
      .mockRejectedValueOnce(guardError);

    const result = await applyWorkerToJob(makeClient(query), {
      workerId: 'worker-1',
      jobId: 'job-1',
      surface: 'whatsapp',
    });

    expect(result).toEqual({ status: 'guard_blocked' });
  });

  it('already_applied never patches application_answers, even with valid answers supplied', async () => {
    const query = jest.fn()
      .mockResolvedValueOnce({ rows: [] }) // internal RLS context
      .mockResolvedValueOnce({
        rows: [{
          id: 'job-1', required_docs: [], optional_docs: [],
          required_fields: ['work_authorization'], optional_fields: [],
        }],
      })
      .mockResolvedValueOnce({}) // worker_application_defaults upsert
      .mockResolvedValueOnce({ rows: [] }) // INSERT conflicts -- already applied
      .mockResolvedValueOnce({ rows: [{ id: 'app-1', job_id: 'job-1', status: 'pending', applied_at: 'ts' }] }); // existing select

    const result = await applyWorkerToJob(makeClient(query), {
      workerId: 'worker-1',
      jobId: 'job-1',
      surface: 'web',
      answers: { work_authorization: true },
    });

    expect(result.status).toBe('already_applied');
    expect(query.mock.calls.some(([sql]) => /UPDATE\s+job_applications/i.test(String(sql)))).toBe(false);
  });

  it('still applies for a legacy job requiring the ssn doc type', async () => {
    const query = jest.fn()
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({
        rows: [{ id: 'job-1', required_docs: ['ssn'], optional_docs: [], required_fields: [], optional_fields: [] }],
      })
      .mockResolvedValueOnce({ rows: [{ doc_type: 'ssn' }] }) // missing-docs check
      .mockResolvedValueOnce({}) // worker_application_defaults upsert
      .mockResolvedValueOnce({ rows: [{ id: 'app-1', job_id: 'job-1', status: 'pending', applied_at: 'ts' }] })
      .mockResolvedValueOnce({ rowCount: 1 }); // non-cert snapshot copy

    const result = await applyWorkerToJob(makeClient(query), {
      workerId: 'worker-1',
      jobId: 'job-1',
      surface: 'web',
    });

    expect(result.status).toBe('applied');
  });

  it('does not block application when an optional doc is missing', async () => {
    const query = jest.fn()
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({
        rows: [{ id: 'job-1', required_docs: [], optional_docs: ['driver_license'], required_fields: [], optional_fields: [] }],
      })
      .mockResolvedValueOnce({}) // worker_application_defaults upsert
      .mockResolvedValueOnce({ rows: [{ id: 'app-1', job_id: 'job-1', status: 'pending', applied_at: 'ts' }] })
      .mockResolvedValueOnce({ rowCount: 0 }); // snapshot copy finds nothing to copy -- not an error

    const result = await applyWorkerToJob(makeClient(query), {
      workerId: 'worker-1',
      jobId: 'job-1',
      surface: 'web',
    });

    expect(result.status).toBe('applied');
  });

  it('copies certification_doc rows with a dedicated dedup-by-s3_key query, separate from the non-cert DISTINCT ON copy', async () => {
    const query = jest.fn()
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({
        rows: [{
          id: 'job-1', required_docs: ['resume', 'certification_doc'], optional_docs: [],
          required_fields: [], optional_fields: [],
        }],
      })
      .mockResolvedValueOnce({ rows: [{ doc_type: 'resume' }, { doc_type: 'certification_doc' }] }) // missing-docs check
      .mockResolvedValueOnce({}) // worker_application_defaults upsert
      .mockResolvedValueOnce({ rows: [{ id: 'app-1', job_id: 'job-1', status: 'pending', applied_at: 'ts' }] })
      .mockResolvedValueOnce({ rowCount: 1 }) // non-cert copy
      .mockResolvedValueOnce({ rowCount: 1 }); // cert copy

    const result = await applyWorkerToJob(makeClient(query), {
      workerId: 'worker-1',
      jobId: 'job-1',
      surface: 'web',
    });

    expect(result.status).toBe('applied');
    // 7, not 6: worker_application_defaults upsert (web-surface-only, added
    // alongside per-certification claim support) now runs between the
    // missing-docs check and the job_applications INSERT.
    expect(query.mock.calls).toHaveLength(7);
    const nonCertSql = String(query.mock.calls[5][0]);
    const certSql = String(query.mock.calls[6][0]);
    expect(nonCertSql).toContain('DISTINCT ON (doc_type)');
    expect(nonCertSql).not.toContain('certification_doc');
    expect(certSql).not.toContain('DISTINCT ON');
    expect(certSql).toContain("doc_type = 'certification_doc'");
    expect(certSql).toContain('NOT EXISTS');
    expect(certSql).toContain('dst.s3_key = src.s3_key');
    expect(certSql).toContain('ON CONFLICT DO NOTHING');
  });
});

function makeUuid(i: number): string {
  return `00000000-0000-4000-8000-${i.toString(16).padStart(12, '0')}`;
}

// mockImplementation-based helper: routes by SQL substring instead of call
// position, so these integration-style tests don't need to track exactly
// where the new worker_application_defaults upsert lands in the sequence.
function makeRoutedClient(routes: Array<[string, unknown]>) {
  const query = jest.fn((sql: string, _params?: unknown[]) => {
    for (const [needle, result] of routes) {
      if (sql.includes(needle)) {
        return result instanceof Error ? Promise.reject(result) : Promise.resolve(result);
      }
    }
    return Promise.resolve({});
  });
  return { client: { query } as any, query };
}

describe('applyWorkerToJob -- certification_requirements', () => {
  const JOB_ROW = {
    id: 'job-1', required_docs: [], optional_docs: [], required_fields: [], optional_fields: [],
  };

  it('legacy-job byte-identity: certification_requirements NULL runs no doc-ownership query and stores no certifications key', async () => {
    const { client, query } = makeRoutedClient([
      ['FROM jobs', { rows: [{ ...JOB_ROW, certification_requirements: null }] }],
      ['INSERT INTO job_applications', { rows: [{ id: 'app-1', job_id: 'job-1', status: 'pending', applied_at: 'ts' }] }],
    ]);

    const result = await applyWorkerToJob(client, { workerId: 'worker-1', jobId: 'job-1', surface: 'web' });

    expect(result).toEqual({
      status: 'applied',
      application: { id: 'app-1', job_id: 'job-1', status: 'pending', applied_at: 'ts' },
    });
    expect(query.mock.calls.some(([sql]) => String(sql).includes("doc_type = 'certification_doc'") && String(sql).includes('id = ANY'))).toBe(false);
    const insertCall = query.mock.calls.find(([sql]) => String(sql).includes('INSERT INTO job_applications'));
    expect(insertCall?.[1]).toEqual(['job-1', 'worker-1', JSON.stringify({})]);
  });

  it('legacy-job byte-identity: certification_requirements [] behaves identically to NULL', async () => {
    const { client, query } = makeRoutedClient([
      ['FROM jobs', { rows: [{ ...JOB_ROW, certification_requirements: [] }] }],
      ['INSERT INTO job_applications', { rows: [{ id: 'app-1', job_id: 'job-1', status: 'pending', applied_at: 'ts' }] }],
    ]);

    const result = await applyWorkerToJob(client, { workerId: 'worker-1', jobId: 'job-1', surface: 'web' });

    expect(result.status).toBe('applied');
    const insertCall = query.mock.calls.find(([sql]) => String(sql).includes('INSERT INTO job_applications'));
    expect(insertCall?.[1]).toEqual(['job-1', 'worker-1', JSON.stringify({})]);
  });

  it('required cert claimed yes with an owned, correctly-typed doc id: applies and stores the claim', async () => {
    const docId = makeUuid(1);
    const { client, query } = makeRoutedClient([
      ['FROM jobs', { rows: [{ ...JOB_ROW, certification_requirements: [{ name: 'osha30', tier: 'required', proof_required: true }] }] }],
      ['FROM worker_documents', { rows: [{ id: docId }] }],
      ['INSERT INTO job_applications', { rows: [{ id: 'app-1', job_id: 'job-1', status: 'pending', applied_at: 'ts' }] }],
    ]);

    const result = await applyWorkerToJob(client, {
      workerId: 'worker-1', jobId: 'job-1', surface: 'web',
      certificationClaims: [{ name: 'osha30', has: true, doc_ids: [docId] }],
    });

    expect(result.status).toBe('applied');
    const insertCall = query.mock.calls.find(([sql]) => String(sql).includes('INSERT INTO job_applications'));
    expect(insertCall?.[1]).toEqual([
      'job-1', 'worker-1',
      JSON.stringify({ certifications: [{ name: 'osha30', has: true, doc_ids: [docId] }] }),
    ]);
    const ownershipQuery = query.mock.calls.find(([sql]) => String(sql).includes('id = ANY'));
    expect(String(ownershipQuery?.[0])).toContain("doc_type = 'certification_doc'");
    expect(ownershipQuery?.[1]).toEqual(['worker-1', [docId]]);
  });

  it('the doc-ownership query never filters on cert_name: a legacy unlabeled cert file is valid proof', async () => {
    // Pins the invariant by construction: the ownership check has no way to
    // require cert_name equality if the query never mentions the column at
    // all. If a future edit adds a cert_name filter, this test catches it.
    const docId = makeUuid(3);
    const { client, query } = makeRoutedClient([
      ['FROM jobs', { rows: [{ ...JOB_ROW, certification_requirements: [{ name: 'osha30', tier: 'required', proof_required: true }] }] }],
      ['FROM worker_documents', { rows: [{ id: docId }] }], // DB row backing this id has cert_name NULL -- irrelevant to the query
      ['INSERT INTO job_applications', { rows: [{ id: 'app-1', job_id: 'job-1', status: 'pending', applied_at: 'ts' }] }],
    ]);

    const result = await applyWorkerToJob(client, {
      workerId: 'worker-1', jobId: 'job-1', surface: 'web',
      certificationClaims: [{ name: 'osha30', has: true, doc_ids: [docId] }],
    });

    expect(result.status).toBe('applied');
    const ownershipQuery = query.mock.calls.find(([sql]) => String(sql).includes('id = ANY'));
    expect(String(ownershipQuery?.[0])).not.toContain('cert_name');
  });

  it('required cert never claimed: missing_certification_claims, apply never reaches the INSERT', async () => {
    const { client, query } = makeRoutedClient([
      ['FROM jobs', { rows: [{ ...JOB_ROW, certification_requirements: [{ name: 'osha10', tier: 'required', proof_required: false }] }] }],
    ]);

    const result = await applyWorkerToJob(client, { workerId: 'worker-1', jobId: 'job-1', surface: 'web' });

    expect(result).toEqual({ status: 'missing_certification_claims' });
    expect(query.mock.calls.some(([sql]) => String(sql).includes('INSERT INTO job_applications'))).toBe(false);
  });

  it('required + proof_required cert claimed yes with zero doc ids: missing_certification_proof with certs list', async () => {
    const { client, query } = makeRoutedClient([
      ['FROM jobs', { rows: [{ ...JOB_ROW, certification_requirements: [{ name: 'osha30', tier: 'required', proof_required: true }] }] }],
    ]);

    const result = await applyWorkerToJob(client, {
      workerId: 'worker-1', jobId: 'job-1', surface: 'web',
      certificationClaims: [{ name: 'osha30', has: true }],
    });

    expect(result).toEqual({ status: 'missing_certification_proof', certs: ['osha30'] });
    // Purely structural (zero doc_ids on the claim itself) -- never reaches
    // the DB doc-ownership query.
    expect(query.mock.calls.some(([sql]) => String(sql).includes('id = ANY'))).toBe(false);
  });

  it('a hostile/unowned doc id is filtered out, not trusted: missing_certification_proof once nothing valid remains', async () => {
    const someoneElsesDocId = makeUuid(2);
    const { client } = makeRoutedClient([
      ['FROM jobs', { rows: [{ ...JOB_ROW, certification_requirements: [{ name: 'osha30', tier: 'required', proof_required: true }] }] }],
      ['FROM worker_documents', { rows: [] }], // DB confirms: not owned / not a certification_doc
    ]);

    const result = await applyWorkerToJob(client, {
      workerId: 'worker-1', jobId: 'job-1', surface: 'web',
      certificationClaims: [{ name: 'osha30', has: true, doc_ids: [someoneElsesDocId] }],
    });

    expect(result).toEqual({ status: 'missing_certification_proof', certs: ['osha30'] });
  });

  it('optional certs never block: unclaimed and claimed-yes-without-proof both submit successfully', async () => {
    const requirements = [
      { name: 'forklift', tier: 'optional', proof_required: false },
      { name: 'crane', tier: 'optional', proof_required: true },
    ];

    const unclaimed = makeRoutedClient([
      ['FROM jobs', { rows: [{ ...JOB_ROW, certification_requirements: requirements }] }],
      ['INSERT INTO job_applications', { rows: [{ id: 'app-1', job_id: 'job-1', status: 'pending', applied_at: 'ts' }] }],
    ]);
    const unclaimedResult = await applyWorkerToJob(unclaimed.client, { workerId: 'worker-1', jobId: 'job-1', surface: 'web' });
    expect(unclaimedResult.status).toBe('applied');

    const claimedNoProof = makeRoutedClient([
      ['FROM jobs', { rows: [{ ...JOB_ROW, certification_requirements: requirements }] }],
      ['INSERT INTO job_applications', { rows: [{ id: 'app-1', job_id: 'job-1', status: 'pending', applied_at: 'ts' }] }],
    ]);
    const claimedResult = await applyWorkerToJob(claimedNoProof.client, {
      workerId: 'worker-1', jobId: 'job-1', surface: 'web',
      certificationClaims: [{ name: 'crane', has: true }],
    });
    expect(claimedResult.status).toBe('applied');
    const insertCall = claimedNoProof.query.mock.calls.find(([sql]) => String(sql).includes('INSERT INTO job_applications'));
    expect(insertCall?.[1]).toEqual([
      'job-1', 'worker-1',
      JSON.stringify({ certifications: [{ name: 'crane', has: true }] }),
    ]);
  });

  it('tier drift: a claim for a cert no longer in the job requirements is dropped silently, not a 500', async () => {
    const { client, query } = makeRoutedClient([
      ['FROM jobs', { rows: [{ ...JOB_ROW, certification_requirements: [{ name: 'osha10', tier: 'optional', proof_required: false }] }] }],
      ['INSERT INTO job_applications', { rows: [{ id: 'app-1', job_id: 'job-1', status: 'pending', applied_at: 'ts' }] }],
    ]);

    const result = await applyWorkerToJob(client, {
      workerId: 'worker-1', jobId: 'job-1', surface: 'web',
      certificationClaims: [{ name: 'cert-employer-removed-since-page-load', has: true }],
    });

    expect(result.status).toBe('applied');
    const insertCall = query.mock.calls.find(([sql]) => String(sql).includes('INSERT INTO job_applications'));
    expect(insertCall?.[1]).toEqual(['job-1', 'worker-1', JSON.stringify({ certifications: [] })]);
  });

  it('reserved key: a client-supplied answers.certifications is rejected as unknown_answer_key, never merged with cert claims', async () => {
    const { client, query } = makeRoutedClient([
      ['FROM jobs', {
        rows: [{
          id: 'job-1', required_docs: [], optional_docs: [], required_fields: [], optional_fields: ['date_available'],
          certification_requirements: null,
        }],
      }],
    ]);

    const result = await applyWorkerToJob(client, {
      workerId: 'worker-1', jobId: 'job-1', surface: 'web',
      answers: { certifications: [{ name: 'osha10', has: true }] },
    });

    expect(result).toEqual({ status: 'invalid_answers', error: 'unknown_answer_key' });
    expect(query.mock.calls.some(([sql]) => String(sql).includes('INSERT INTO job_applications'))).toBe(false);
  });

  it('16KB recheck fires on the MERGED object even though the pre-merge answers object is tiny', async () => {
    // ~500 UUID-shaped doc ids, all confirmed valid -- big enough on its own
    // to push the merged object over MAX_MERGED_ANSWERS_JSON_LENGTH even
    // though the answers object validateApplicationAnswers saw pre-merge
    // was `{}`.
    const docIds = Array.from({ length: 500 }, (_, i) => makeUuid(i));
    const { client, query } = makeRoutedClient([
      ['FROM jobs', { rows: [{ ...JOB_ROW, certification_requirements: [{ name: 'osha30', tier: 'required', proof_required: true }] }] }],
      ['FROM worker_documents', { rows: docIds.map((id) => ({ id })) }],
      ['INSERT INTO job_applications', { rows: [{ id: 'app-1', job_id: 'job-1', status: 'pending', applied_at: 'ts' }] }],
    ]);

    const result = await applyWorkerToJob(client, {
      workerId: 'worker-1', jobId: 'job-1', surface: 'web',
      certificationClaims: [{ name: 'osha30', has: true, doc_ids: docIds }],
    });

    expect(result).toEqual({ status: 'invalid_answers', error: 'invalid_answers' });
    expect(query.mock.calls.some(([sql]) => String(sql).includes('INSERT INTO job_applications'))).toBe(false);
    expect(query.mock.calls.some(([sql]) => String(sql).includes('INSERT INTO worker_application_defaults'))).toBe(false);
  });
});

describe('applyWorkerToJob -- worker_application_defaults', () => {
  it('upserts defaults with the reserved certifications key stripped, after validation succeeds', async () => {
    const { client, query } = makeRoutedClient([
      ['FROM jobs', {
        rows: [{
          id: 'job-1', required_docs: [], optional_docs: [],
          required_fields: ['work_authorization'], optional_fields: [],
          certification_requirements: [{ name: 'osha10', tier: 'required', proof_required: false }],
        }],
      }],
      ['INSERT INTO job_applications', { rows: [{ id: 'app-1', job_id: 'job-1', status: 'pending', applied_at: 'ts' }] }],
    ]);

    const result = await applyWorkerToJob(client, {
      workerId: 'worker-1', jobId: 'job-1', surface: 'web',
      answers: { work_authorization: true },
      certificationClaims: [{ name: 'osha10', has: true }],
    });

    expect(result.status).toBe('applied');
    const defaultsCall = query.mock.calls.find(([sql]) => String(sql).includes('INSERT INTO worker_application_defaults'));
    expect(defaultsCall).toBeDefined();
    expect(defaultsCall?.[1]).toEqual(['worker-1', JSON.stringify({ work_authorization: true })]);
  });

  it('never upserts defaults for the whatsapp surface', async () => {
    const { client, query } = makeRoutedClient([
      ['FROM jobs', {
        rows: [{
          id: 'job-1', required_docs: [], optional_docs: [],
          required_fields: ['work_authorization'], optional_fields: [],
          certification_requirements: null,
        }],
      }],
      ['INSERT INTO job_applications', { rows: [{ id: 'app-1', job_id: 'job-1', status: 'pending', applied_at: 'ts' }] }],
    ]);

    const result = await applyWorkerToJob(client, { workerId: 'worker-1', jobId: 'job-1', surface: 'whatsapp' });

    expect(result.status).toBe('applied');
    expect(query.mock.calls.some(([sql]) => String(sql).includes('INSERT INTO worker_application_defaults'))).toBe(false);
  });

  it('a defaults-upsert failure propagates (rejects), never swallowed, so the caller can roll back', async () => {
    const { client } = makeRoutedClient([
      ['FROM jobs', {
        rows: [{
          id: 'job-1', required_docs: [], optional_docs: [], required_fields: [], optional_fields: [],
          certification_requirements: null,
        }],
      }],
      ['INSERT INTO worker_application_defaults', new Error('defaults write failed')],
    ]);

    await expect(
      applyWorkerToJob(client, { workerId: 'worker-1', jobId: 'job-1', surface: 'web' }),
    ).rejects.toThrow('defaults write failed');
  });
});

describe('applyWorkerToJob -- 078 trigger cap constraint mapping', () => {
  const jobWithLegacyCertDoc = {
    id: 'job-1', required_docs: ['certification_doc'], optional_docs: [], required_fields: [], optional_fields: [],
    certification_requirements: null,
  };

  it.each([
    ['certification_document_limit'],
    ['certification_document_name_limit'],
  ])('maps a 23514 %s from the snapshot copy to a graceful certification_document_limit result, not a 500', async (constraint) => {
    const pgErr = Object.assign(new Error('trigger cap'), { code: '23514', constraint });
    const { client } = makeRoutedClient([
      ['FROM jobs', { rows: [jobWithLegacyCertDoc] }],
      ['DISTINCT doc_type', { rows: [{ doc_type: 'certification_doc' }] }],
      ['INSERT INTO job_applications', { rows: [{ id: 'app-1', job_id: 'job-1', status: 'pending', applied_at: 'ts' }] }],
      ['INSERT INTO worker_documents', pgErr],
    ]);

    const result = await applyWorkerToJob(client, { workerId: 'worker-1', jobId: 'job-1', surface: 'web' });

    expect(result).toEqual({ status: 'certification_document_limit' });
  });
});
