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
    const copySql = String(query.mock.calls[4][0]);
    expect(String(query.mock.calls[1][0])).not.toContain('FOR UPDATE');
    expect(copySql).toContain('s3_version_id');
    expect(copySql).toContain('AND (job_id IS NULL OR job_id = $1::uuid)');
  });

  it('repairs missing snapshots before returning already_applied', async () => {
    const query = jest.fn()
      .mockResolvedValueOnce({ rows: [] }) // internal RLS context
      .mockResolvedValueOnce({ rows: [{ id: 'job-1', required_docs: ['resume'] }] })
      .mockResolvedValueOnce({ rows: [{ doc_type: 'resume' }] })
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
      .mockResolvedValueOnce({ rows: [{ id: 'app-1', job_id: 'job-1', status: 'pending', applied_at: 'ts' }] });

    const result = await applyWorkerToJob(makeClient(query), {
      workerId: 'worker-1',
      jobId: 'job-1',
      surface: 'web',
      answers: { work_authorization: true },
    });

    expect(result.status).toBe('applied');
    const insertCall = query.mock.calls[2];
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
      .mockResolvedValueOnce({ rows: [{ id: 'app-1', job_id: 'job-1', status: 'pending', applied_at: 'ts' }] });

    const result = await applyWorkerToJob(makeClient(query), {
      workerId: 'worker-1',
      jobId: 'job-1',
      surface: 'web',
    });

    expect(result.status).toBe('applied');
    const insertCall = query.mock.calls[2];
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
      .mockResolvedValueOnce({ rows: [{ id: 'app-1', job_id: 'job-1', status: 'pending', applied_at: 'ts' }] })
      .mockResolvedValueOnce({ rowCount: 1 }) // non-cert copy
      .mockResolvedValueOnce({ rowCount: 1 }); // cert copy

    const result = await applyWorkerToJob(makeClient(query), {
      workerId: 'worker-1',
      jobId: 'job-1',
      surface: 'web',
    });

    expect(result.status).toBe('applied');
    expect(query.mock.calls).toHaveLength(6);
    const nonCertSql = String(query.mock.calls[4][0]);
    const certSql = String(query.mock.calls[5][0]);
    expect(nonCertSql).toContain('DISTINCT ON (doc_type)');
    expect(nonCertSql).not.toContain('certification_doc');
    expect(certSql).not.toContain('DISTINCT ON');
    expect(certSql).toContain("doc_type = 'certification_doc'");
    expect(certSql).toContain('NOT EXISTS');
    expect(certSql).toContain('dst.s3_key = src.s3_key');
    expect(certSql).toContain('ON CONFLICT DO NOTHING');
  });
});
