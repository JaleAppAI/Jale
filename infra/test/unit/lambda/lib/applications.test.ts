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
    expect(String(query.mock.calls[1][0])).toContain('FOR UPDATE');
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
    expect(String(query.mock.calls[1][0])).toContain('FOR UPDATE');
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
    expect(String(query.mock.calls[1][0])).toContain('FOR UPDATE');
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
});
