import type { APIGatewayProxyEvent } from 'aws-lambda';
import { handler } from '../../../../lambda/api/worker-doc-upload-url';
import { getDbPool } from '../../../../lambda/lib/db';

jest.mock('../../../../lambda/lib/db');
jest.mock('@aws-sdk/client-s3', () => ({
  S3Client: jest.fn().mockImplementation(() => ({})),
  PutObjectCommand: jest.fn().mockImplementation((input) => ({ input })),
}));
jest.mock('@aws-sdk/s3-request-presigner', () => ({
  getSignedUrl: jest.fn().mockResolvedValue('https://s3.example.com/presigned-put'),
}));

const mockGetDbPool = getDbPool as jest.Mock;
const mockQuery = jest.fn();
const mockRelease = jest.fn();

describe('worker-doc-upload-url Lambda', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    process.env.DOCUMENTS_BUCKET = 'test-bucket';
    process.env.ALLOWED_ORIGIN = 'https://jaleapp.ai';
    mockGetDbPool.mockResolvedValue({
      connect: jest.fn().mockResolvedValue({ query: mockQuery, release: mockRelease }),
    });
  });

  const makeEvent = (body: object) =>
    ({ body: JSON.stringify(body) }) as unknown as APIGatewayProxyEvent;

  it('returns 400 if token or doc_type is missing', async () => {
    const res = await handler(makeEvent({ token: 'abc' }));
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).error).toBe('missing_fields');
  });

  it('returns 400 if doc_type is invalid', async () => {
    const res = await handler(
      makeEvent({ token: 'abc', doc_type: 'passport', mime_type: 'application/pdf' }),
    );
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).error).toBe('invalid_doc_type');
  });

  it('returns 401 if token not found or expired', async () => {
    mockQuery
      .mockResolvedValueOnce({}) // BEGIN
      .mockResolvedValueOnce({ rows: [] }) // token lookup — empty
      .mockResolvedValueOnce({}); // ROLLBACK
    const res = await handler(
      makeEvent({ token: 'bad-token', doc_type: 'resume', mime_type: 'application/pdf' }),
    );
    expect(res.statusCode).toBe(401);
    expect(JSON.parse(res.body).error).toBe('invalid_token');
  });

  it('returns 200 with presigned URL on valid token', async () => {
    mockQuery
      .mockResolvedValueOnce({}) // BEGIN
      .mockResolvedValueOnce({ rows: [{ worker_id: 'worker-uuid', job_id: 'job-uuid' }] })
      .mockResolvedValueOnce({}); // COMMIT
    const res = await handler(
      makeEvent({ token: 'valid-token', doc_type: 'resume', mime_type: 'application/pdf' }),
    );
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.url).toBe('https://s3.example.com/presigned-put');
    expect(body.s3_key).toMatch(/^documents\/job-uuid\/worker-uuid\/resume\/.+\.pdf$/);
    expect(mockRelease).toHaveBeenCalled();
  });
});
