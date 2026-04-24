import type { APIGatewayProxyEvent } from 'aws-lambda';
jest.mock('../../../../lambda/lib/db');
jest.mock('../../../../lambda/legal/check-compliance');
import { handler } from '../../../../lambda/api/worker-doc-confirm-auth';
import { getDbPool } from '../../../../lambda/lib/db';
import { checkCompliance } from '../../../../lambda/legal/check-compliance';

const mockGetDbPool = getDbPool as jest.Mock;
const mockCheckCompliance = checkCompliance as jest.Mock;
const mockQuery = jest.fn();
const mockRelease = jest.fn();

const mkEv = (body: any) => ({ requestContext: { authorizer: { claims: { sub: 'w' } } }, body: JSON.stringify(body) } as unknown as APIGatewayProxyEvent);

describe('worker-doc-confirm-auth', () => {
  const env = process.env;
  beforeEach(() => {
    jest.resetAllMocks();
    process.env = { ...env, REQUIRED_TOS_VERSION: 'v1.0' };
    mockGetDbPool.mockResolvedValue({ connect: jest.fn().mockResolvedValue({ query: mockQuery, release: mockRelease }) });
    mockCheckCompliance.mockResolvedValue({ compliant: true, userExists: true });
  });
  afterAll(() => { process.env = env; });

  it('rejects invalid doc_type', async () => {
    const res = await handler(mkEv({ doc_type: 'passport', s3_key: 'k', file_name: 'f', file_size: 1, mime_type: 'application/pdf' }));
    expect(res.statusCode).toBe(400);
  });

  it('deletes existing vault row and inserts new', async () => {
    mockQuery.mockImplementation((q: string) => {
      if (q.includes('SELECT id FROM users')) return Promise.resolve({ rows: [{ id: 'u1' }] });
      if (q.includes('DELETE FROM worker_documents')) return Promise.resolve({ rowCount: 1 });
      if (q.includes('INSERT INTO worker_documents')) return Promise.resolve({ rows: [{ id: 'd1', doc_type: 'resume' }] });
      return Promise.resolve({});
    });
    const res = await handler(mkEv({ doc_type: 'resume', s3_key: 'k', file_name: 'f', file_size: 1, mime_type: 'application/pdf' }));
    expect(res.statusCode).toBe(201);
    const calls = mockQuery.mock.calls.map(c => c[0]);
    expect(calls.some((c: string) => c.includes('DELETE FROM worker_documents'))).toBe(true);
    expect(calls.some((c: string) => c.includes('INSERT INTO worker_documents'))).toBe(true);
  });
});
