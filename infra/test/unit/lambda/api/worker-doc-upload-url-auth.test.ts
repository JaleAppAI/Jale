import type { APIGatewayProxyEvent } from 'aws-lambda';
jest.mock('@aws-sdk/s3-request-presigner', () => ({ getSignedUrl: jest.fn().mockResolvedValue('https://signed.example') }));
jest.mock('../../../../lambda/lib/db');
jest.mock('../../../../lambda/legal/check-compliance');
import { handler } from '../../../../lambda/api/worker-doc-upload-url-auth';
import { getDbPool } from '../../../../lambda/lib/db';
import { checkCompliance } from '../../../../lambda/legal/check-compliance';

const mockGetDbPool = getDbPool as jest.Mock;
const mockCheckCompliance = checkCompliance as jest.Mock;
const mockQuery = jest.fn();
const mockRelease = jest.fn();

const mkEv = (body: any) => ({
  requestContext: { authorizer: { claims: { sub: 'w' } } },
  body: JSON.stringify(body),
} as unknown as APIGatewayProxyEvent);

describe('worker-doc-upload-url-auth', () => {
  const env = process.env;
  beforeEach(() => {
    jest.clearAllMocks();
    process.env = { ...env, REQUIRED_TOS_VERSION: 'v1.0', DOCUMENTS_BUCKET: 'bucket' };
    mockGetDbPool.mockResolvedValue({ connect: jest.fn().mockResolvedValue({ query: mockQuery, release: mockRelease }) });
    mockCheckCompliance.mockResolvedValue({ compliant: true, userExists: true });
  });
  afterAll(() => { process.env = env; });

  it('rejects invalid doc_type', async () => {
    const res = await handler(mkEv({ doc_type: 'passport', mime_type: 'application/pdf' }));
    expect(res.statusCode).toBe(400);
  });

  it('returns signed url on happy path', async () => {
    mockQuery.mockImplementation((q: string) => {
      if (q.includes('SELECT id FROM users')) return Promise.resolve({ rows: [{ id: 'uuid-worker' }] });
      return Promise.resolve({});
    });
    const res = await handler(mkEv({ doc_type: 'resume', mime_type: 'application/pdf' }));
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.url).toBe('https://signed.example');
    expect(body.s3_key).toMatch(/^documents\/vault\/uuid-worker\/resume\//);
  });
});
