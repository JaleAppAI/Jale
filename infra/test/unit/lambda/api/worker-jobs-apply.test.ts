import type { APIGatewayProxyEvent } from 'aws-lambda';
import { handler } from '../../../../lambda/api/worker-jobs-apply';
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

const ev = {
  requestContext: { authorizer: { claims: { sub: 'w-sub' } } },
  pathParameters: { id: 'job-1' },
} as unknown as APIGatewayProxyEvent;

describe('worker-jobs-apply', () => {
  const env = process.env;
  beforeEach(() => {
    jest.resetAllMocks();
    process.env = { ...env, REQUIRED_TOS_VERSION: 'v1.0' };
    mockGetDbPool.mockResolvedValue({ connect: jest.fn().mockResolvedValue({ query: mockQuery, release: mockRelease }) });
    mockCheckCompliance.mockResolvedValue({ compliant: true, userExists: true });
  });
  afterAll(() => { process.env = env; });

  it('returns 410 if job is closed or missing', async () => {
    mockQuery.mockImplementation((q: string) => {
      if (q.includes('SELECT id FROM users')) return Promise.resolve({ rows: [{ id: 'worker-id' }] });
      if (q.includes("FROM jobs")) return Promise.resolve({ rows: [] });
      return Promise.resolve({});
    });
    const res = await handler(ev);
    expect(res.statusCode).toBe(410);
  });

  it('returns 400 missing_documents when required docs not uploaded', async () => {
    mockQuery.mockImplementation((q: string) => {
      if (q.includes('SELECT id FROM users')) return Promise.resolve({ rows: [{ id: 'worker-id' }] });
      if (q.includes('FROM jobs')) return Promise.resolve({ rows: [{ id: 'job-1', required_docs: ['resume', 'driver_license'] }] });
      if (q.includes('FROM worker_documents')) return Promise.resolve({ rows: [{ doc_type: 'resume' }] });
      return Promise.resolve({});
    });
    const res = await handler(ev);
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body)).toEqual({ error: 'missing_documents', missing_docs: ['driver_license'] });
  });

  it('returns 409 if already applied', async () => {
    mockQuery.mockImplementation((q: string) => {
      if (q.includes('SELECT id FROM users')) return Promise.resolve({ rows: [{ id: 'worker-id' }] });
      if (q.includes('FROM jobs')) return Promise.resolve({ rows: [{ id: 'job-1', required_docs: [] }] });
      if (q.includes('FROM worker_documents')) return Promise.resolve({ rows: [] });
      if (q.includes('INSERT INTO job_applications')) {
        return Promise.resolve({ rows: [] });
      }
      if (q.includes('FROM job_applications')) {
        return Promise.resolve({ rows: [{ id: 'a1', job_id: 'job-1', status: 'pending', applied_at: 'ts' }] });
      }
      return Promise.resolve({});
    });
    const res = await handler(ev);
    expect(res.statusCode).toBe(409);
  });

  it('returns 201 with application on happy path and copies docs', async () => {
    const calls: string[] = [];
    mockQuery.mockImplementation((q: string) => {
      calls.push(typeof q === 'string' ? q : '');
      if (q.includes('SELECT id FROM users')) return Promise.resolve({ rows: [{ id: 'worker-id' }] });
      if (q.includes('FROM jobs')) return Promise.resolve({ rows: [{ id: 'job-1', required_docs: ['resume'] }] });
      if (q.includes('FROM worker_documents') && q.includes('DISTINCT doc_type')) return Promise.resolve({ rows: [{ doc_type: 'resume' }] });
      if (q.includes('INSERT INTO job_applications')) {
        return Promise.resolve({ rows: [{ id: 'a1', job_id: 'job-1', status: 'pending', applied_at: 'ts' }] });
      }
      if (q.includes('INSERT INTO worker_documents')) return Promise.resolve({ rowCount: 1 });
      return Promise.resolve({});
    });
    const res = await handler(ev);
    expect(res.statusCode).toBe(201);
    const body = JSON.parse(res.body);
    expect(body.id).toBe('a1');
    const applicationInsert = calls.find(c => c.includes('INSERT INTO job_applications')) as string;
    expect(applicationInsert).toContain('(job_id, worker_id, status)');
    expect(applicationInsert).toContain("'pending'");
    expect(mockSetInternalUserRlsContext).toHaveBeenCalledWith(expect.any(Object), 'worker-id');
    expect(calls.some(c => c.includes('INSERT INTO worker_documents'))).toBe(true);
    const docCopy = calls.find(c => c.includes('INSERT INTO worker_documents')) as string;
    expect(docCopy).toContain('s3_version_id');
  });
});
