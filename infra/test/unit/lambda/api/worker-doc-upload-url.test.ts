import type { APIGatewayProxyEvent } from 'aws-lambda';
import { handler } from '../../../../lambda/api/worker-doc-upload-url';
import { getDbPool } from '../../../../lambda/lib/db';
import { PutObjectCommand } from '@aws-sdk/client-s3';

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
      .mockResolvedValueOnce({ rows: [{ issued_s3_key: 'documents/job-uuid/worker-uuid/resume/uuid.pdf' }] })
      .mockResolvedValueOnce({}); // COMMIT
    const res = await handler(
      makeEvent({ token: 'valid-token', doc_type: 'resume', mime_type: 'application/pdf' }),
    );
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.url).toBe('https://s3.example.com/presigned-put');
    expect(body.s3_key).toMatch(/^documents\/job-uuid\/worker-uuid\/resume\/.+\.pdf$/);
    expect(PutObjectCommand).toHaveBeenCalledWith(
      expect.objectContaining({
        Bucket: 'test-bucket',
        ContentType: 'application/pdf',
        Key: expect.stringMatching(/^documents\/job-uuid\/worker-uuid\/resume\/.+\.pdf$/),
      }),
    );
    expect(mockRelease).toHaveBeenCalled();
  });

  it('returns 409 if a document slot was already confirmed', async () => {
    mockQuery
      .mockResolvedValueOnce({}) // BEGIN
      .mockResolvedValueOnce({ rows: [{ worker_id: 'worker-uuid', job_id: 'job-uuid' }] })
      .mockResolvedValueOnce({ rows: [] }) // slot upsert skipped by confirmed_at guard
      .mockResolvedValueOnce({}); // ROLLBACK

    const res = await handler(
      makeEvent({ token: 'valid-token', doc_type: 'resume', mime_type: 'application/pdf' }),
    );
    expect(res.statusCode).toBe(409);
    expect(JSON.parse(res.body).error).toBe('document_already_confirmed');
    expect(mockRelease).toHaveBeenCalled();
  });
});
