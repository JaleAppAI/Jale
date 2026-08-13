import type { APIGatewayProxyEvent } from 'aws-lambda';
import { handler } from '../../../../lambda/api/worker-jobs-detail';
import { getDbPool, setInternalUserRlsContext, setRlsContext } from '../../../../lambda/lib/db';
import { checkCompliance } from '../../../../lambda/legal/check-compliance';

jest.mock('../../../../lambda/lib/db');
jest.mock('../../../../lambda/legal/check-compliance');

const mockGetDbPool = getDbPool as jest.Mock;
const mockSetRlsContext = setRlsContext as jest.Mock;
const mockSetInternalUserRlsContext = setInternalUserRlsContext as jest.Mock;
const mockCheckCompliance = checkCompliance as jest.Mock;
const mockQuery = jest.fn();
const mockRelease = jest.fn();

const baseEvent = {
  requestContext: { authorizer: { claims: { sub: 'worker-sub-1' } } },
  pathParameters: { jobId: 'job-1' },
} as unknown as APIGatewayProxyEvent;

describe('worker-jobs-detail', () => {
  const env = process.env;
  beforeEach(() => {
    jest.resetAllMocks();
    process.env = { ...env, REQUIRED_TOS_VERSION: 'v1.0' };
    mockGetDbPool.mockResolvedValue({ connect: jest.fn().mockResolvedValue({ query: mockQuery, release: mockRelease }) });
    mockCheckCompliance.mockResolvedValue({ compliant: true, userExists: true });
  });
  afterAll(() => { process.env = env; });

  it('returns 404 if job not found (RLS-filtered)', async () => {
    mockQuery.mockImplementation((q: string) => {
      if (q.trim().startsWith('SELECT id FROM users')) return Promise.resolve({ rows: [{ id: 'worker-id' }] });
      if (q.includes('FROM jobs')) return Promise.resolve({ rows: [] });
      return Promise.resolve({});
    });
    const res = await handler(baseEvent);
    expect(res.statusCode).toBe(404);
  });

  it('returns job with missing_docs computed from worker_documents', async () => {
    const job = { id: 'job-1', title: 'T', location: 'L', job_type: 'full-time', description: 'D',
                  required_docs: ['resume', 'driver_license'], created_at: 'ts', company_name: 'Acme' };
    mockQuery.mockImplementation((q: string) => {
      if (q.trim().startsWith('SELECT id FROM users')) return Promise.resolve({ rows: [{ id: 'worker-id' }] });
      if (q.includes('FROM jobs')) return Promise.resolve({ rows: [job] });
      if (q.includes('FROM worker_documents')) return Promise.resolve({ rows: [{ doc_type: 'resume' }] });
      if (q.includes('FROM job_applications')) return Promise.resolve({ rows: [] });
      return Promise.resolve({});
    });
    const res = await handler(baseEvent);
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.missing_docs).toEqual(['driver_license']);
    expect(body.already_applied).toBe(false);
    expect(mockSetInternalUserRlsContext).toHaveBeenCalledWith(expect.any(Object), 'worker-id');
    const docsSql = mockQuery.mock.calls.find(([q]) => String(q).includes('FROM worker_documents'))?.[0];
    expect(docsSql).toContain('AND (job_id IS NULL OR job_id = $3::uuid)');
  });

  it('returns already_applied=true when application exists', async () => {
    const job = { id: 'job-1', title: 'T', location: 'L', job_type: 'full-time', description: 'D',
                  required_docs: [], created_at: 'ts', company_name: 'Acme' };
    mockQuery.mockImplementation((q: string) => {
      if (q.trim().startsWith('SELECT id FROM users')) return Promise.resolve({ rows: [{ id: 'worker-id' }] });
      if (q.includes('FROM jobs')) return Promise.resolve({ rows: [job] });
      if (q.includes('FROM worker_documents')) return Promise.resolve({ rows: [] });
      if (q.includes('FROM job_applications')) return Promise.resolve({ rows: [{ status: 'pending' }] });
      return Promise.resolve({});
    });
    const res = await handler(baseEvent);
    const body = JSON.parse(res.body);
    expect(body.already_applied).toBe(true);
    expect(body.application_status).toBe('pending');
  });

  it('exposes public_listing_enabled on the job detail response', async () => {
    const job = { id: 'job-1', title: 'T', location: 'L', job_type: 'full-time', description: 'D',
                  required_docs: [], created_at: 'ts', company_name: 'Acme', public_listing_enabled: true };
    mockQuery.mockImplementation((q: string) => {
      if (q.trim().startsWith('SELECT id FROM users')) return Promise.resolve({ rows: [{ id: 'worker-id' }] });
      if (q.includes('FROM jobs')) return Promise.resolve({ rows: [job] });
      if (q.includes('FROM job_applications')) return Promise.resolve({ rows: [] });
      return Promise.resolve({});
    });
    const res = await handler(baseEvent);
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.public_listing_enabled).toBe(true);
    const jobsSql = mockQuery.mock.calls.find(([q]) => String(q).includes('FROM jobs'))?.[0];
    expect(jobsSql).toContain('public_listing_enabled');
  });

  it('normalizes nullable required_docs for the frontend contract', async () => {
    const job = {
      id: 'job-1',
      title: 'T',
      location: 'L',
      job_type: 'full-time',
      description: 'D',
      required_docs: null,
      created_at: 'ts',
      company_name: 'Acme',
    };
    mockQuery.mockImplementation((q: string) => {
      if (q.trim().startsWith('SELECT id FROM users')) return Promise.resolve({ rows: [{ id: 'worker-id' }] });
      if (q.includes('FROM jobs')) return Promise.resolve({ rows: [job] });
      if (q.includes('FROM job_applications')) return Promise.resolve({ rows: [] });
      return Promise.resolve({});
    });

    const res = await handler(baseEvent);
    const body = JSON.parse(res.body);

    expect(res.statusCode).toBe(200);
    expect(body.required_docs).toEqual([]);
    expect(body.missing_docs).toEqual([]);
  });
});
