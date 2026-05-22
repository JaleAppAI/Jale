import type { APIGatewayProxyEvent } from 'aws-lambda';
jest.mock('@aws-sdk/client-s3', () => {
  const send = jest.fn().mockResolvedValue({});
  return { S3Client: jest.fn().mockImplementation(() => ({ send })), DeleteObjectCommand: jest.fn().mockImplementation((x) => x), __send: send };
});
jest.mock('../../../../lambda/lib/db');
jest.mock('../../../../lambda/legal/check-compliance');
import { handler } from '../../../../lambda/api/worker-doc-delete';
import { getDbPool, setInternalUserRlsContext, setRlsContext } from '../../../../lambda/lib/db';
import { checkCompliance } from '../../../../lambda/legal/check-compliance';

const mockGetDbPool = getDbPool as jest.Mock;
const mockSetRlsContext = setRlsContext as jest.Mock;
const mockSetInternalUserRlsContext = setInternalUserRlsContext as jest.Mock;
const mockCheckCompliance = checkCompliance as jest.Mock;
const mockQuery = jest.fn();
const mockRelease = jest.fn();

const mkEv = (doc_type: string) => ({ requestContext: { authorizer: { claims: { sub: 'w' } } }, pathParameters: { doc_type } } as unknown as APIGatewayProxyEvent);

describe('worker-doc-delete', () => {
  const env = process.env;
  beforeEach(() => {
    jest.clearAllMocks();
    process.env = { ...env, REQUIRED_TOS_VERSION: 'v1.0', DOCUMENTS_BUCKET: 'b' };
    mockGetDbPool.mockResolvedValue({ connect: jest.fn().mockResolvedValue({ query: mockQuery, release: mockRelease }) });
    mockCheckCompliance.mockResolvedValue({ compliant: true, userExists: true });
  });
  afterAll(() => { process.env = env; });

  it('rejects invalid doc_type', async () => {
    const res = await handler(mkEv('passport'));
    expect(res.statusCode).toBe(400);
  });

  it('returns 404 if vault row missing', async () => {
    mockQuery.mockImplementation((q: string) => {
      if (q.includes('SELECT id FROM users')) return Promise.resolve({ rows: [{ id: 'u1' }] });
      if (q.includes('DELETE FROM worker_documents')) return Promise.resolve({ rowCount: 0, rows: [] });
      return Promise.resolve({});
    });
    const res = await handler(mkEv('resume'));
    expect(res.statusCode).toBe(404);
    expect(mockSetRlsContext).toHaveBeenCalledWith(expect.anything(), 'w');
    expect(mockSetInternalUserRlsContext).toHaveBeenCalledWith(expect.anything(), 'u1');
    const deleteSql = mockQuery.mock.calls.find(([q]) => String(q).includes('DELETE FROM worker_documents'))?.[0];
    expect(deleteSql).toContain('job_id IS NULL');
    expect(mockQuery).not.toHaveBeenCalledWith(
      `SELECT set_config('app.current_user_id', $1, true)`,
      ['u1'],
    );
  });

  it('returns 204 on success', async () => {
    mockQuery.mockImplementation((q: string) => {
      if (q.includes('SELECT id FROM users')) return Promise.resolve({ rows: [{ id: 'u1' }] });
      if (q.includes('DELETE FROM worker_documents')) return Promise.resolve({ rowCount: 1, rows: [{ s3_key: 'k' }] });
      return Promise.resolve({});
    });
    const res = await handler(mkEv('resume'));
    expect(res.statusCode).toBe(204);
    expect(mockSetInternalUserRlsContext).toHaveBeenCalledWith(expect.anything(), 'u1');
  });
});
