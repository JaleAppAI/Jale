import type { APIGatewayProxyEvent } from 'aws-lambda';
jest.mock('../../../../lambda/lib/db');
jest.mock('../../../../lambda/legal/check-compliance');
jest.mock('@aws-sdk/client-s3', () => ({
  S3Client: jest.fn().mockImplementation(() => ({ send: jest.fn() })),
  HeadObjectCommand: jest.fn().mockImplementation((input) => ({ input })),
}));
import { handler } from '../../../../lambda/api/worker-doc-confirm-auth';
import { getDbPool, setInternalUserRlsContext } from '../../../../lambda/lib/db';
import { checkCompliance } from '../../../../lambda/legal/check-compliance';
import { S3Client } from '@aws-sdk/client-s3';

const mockGetDbPool = getDbPool as jest.Mock;
const mockSetInternalUserRlsContext = setInternalUserRlsContext as jest.Mock;
const mockCheckCompliance = checkCompliance as jest.Mock;
const mockQuery = jest.fn();
const mockRelease = jest.fn();
const mockS3Send = (S3Client as jest.Mock).mock.results[0].value.send as jest.Mock;

const mkEv = (body: any) => ({ requestContext: { authorizer: { claims: { sub: 'w' } } }, body: JSON.stringify(body) } as unknown as APIGatewayProxyEvent);

// Vault uploads are always issued under `documents/vault/<workerId>/...` by
// worker-doc-upload-url-auth.ts; the resolved workerId in these tests is 'u1'.
const OWN_KEY = 'documents/vault/u1/resume/uuid.pdf';

const validHead = {
  ContentLength: 1,
  ContentType: 'application/pdf',
  ServerSideEncryption: 'aws:kms',
};

const stubUserLookup = () => {
  mockQuery.mockImplementation((q: string) => {
    if (q.includes('SELECT id FROM users')) return Promise.resolve({ rows: [{ id: 'u1' }] });
    return Promise.resolve({});
  });
};

describe('worker-doc-confirm-auth', () => {
  const env = process.env;
  beforeEach(() => {
    jest.clearAllMocks();
    process.env = { ...env, REQUIRED_TOS_VERSION: 'v1.0', DOCUMENTS_BUCKET: 'test-bucket' };
    mockGetDbPool.mockResolvedValue({ connect: jest.fn().mockResolvedValue({ query: mockQuery, release: mockRelease }) });
    mockCheckCompliance.mockResolvedValue({ compliant: true, userExists: true });
  });
  afterAll(() => { process.env = env; });

  it('rejects invalid doc_type', async () => {
    const res = await handler(mkEv({ doc_type: 'passport', s3_key: OWN_KEY, file_name: 'f', file_size: 1, mime_type: 'application/pdf' }));
    expect(res.statusCode).toBe(400);
  });

  it('deletes existing vault row and inserts new', async () => {
    mockS3Send.mockResolvedValueOnce(validHead);
    mockQuery.mockImplementation((q: string) => {
      if (q.includes('SELECT id FROM users')) return Promise.resolve({ rows: [{ id: 'u1' }] });
      if (q.includes('DELETE FROM worker_documents')) return Promise.resolve({ rowCount: 1 });
      if (q.includes('INSERT INTO worker_documents')) return Promise.resolve({ rows: [{ id: 'd1', doc_type: 'resume' }] });
      return Promise.resolve({});
    });
    const res = await handler(mkEv({ doc_type: 'resume', s3_key: OWN_KEY, file_name: 'f', file_size: 1, mime_type: 'application/pdf' }));
    expect(res.statusCode).toBe(201);
    const calls = mockQuery.mock.calls.map(c => c[0]);
    expect(calls.some((c: string) => c.includes('DELETE FROM worker_documents'))).toBe(true);
    expect(calls.some((c: string) => c.includes('INSERT INTO worker_documents'))).toBe(true);
    expect(mockSetInternalUserRlsContext).toHaveBeenCalledWith(expect.anything(), 'u1');
    expect(mockS3Send).toHaveBeenCalledWith({ input: { Bucket: 'test-bucket', Key: OWN_KEY } });
  });

  it('rolls back if insert fails after deleting the previous vault row', async () => {
    mockS3Send.mockResolvedValueOnce(validHead);
    mockQuery.mockImplementation((q: string) => {
      if (q.includes('SELECT id FROM users')) return Promise.resolve({ rows: [{ id: 'u1' }] });
      if (q.includes('DELETE FROM worker_documents')) return Promise.resolve({ rowCount: 1 });
      if (q.includes('INSERT INTO worker_documents')) return Promise.reject(new Error('insert failed'));
      return Promise.resolve({});
    });

    const res = await handler(mkEv({ doc_type: 'resume', s3_key: OWN_KEY, file_name: 'f', file_size: 1, mime_type: 'application/pdf' }));

    expect(res.statusCode).toBe(500);
    const calls = mockQuery.mock.calls.map(c => c[0]);
    expect(calls.some((c: string) => c.includes('DELETE FROM worker_documents'))).toBe(true);
    expect(calls).toContain('ROLLBACK');
    expect(calls).not.toContain('COMMIT');
  });

  it("rejects an s3_key outside the caller's own vault prefix as forbidden, without touching S3 or inserting", async () => {
    stubUserLookup();

    const res = await handler(mkEv({
      doc_type: 'resume',
      s3_key: 'documents/vault/other-worker/resume/uuid.pdf',
      file_name: 'f',
      file_size: 1,
      mime_type: 'application/pdf',
    }));

    expect(res.statusCode).toBe(403);
    expect(JSON.parse(res.body).error).toBe('forbidden');
    expect(mockS3Send).not.toHaveBeenCalled();
    const calls = mockQuery.mock.calls.map(c => c[0]);
    expect(calls.some((c: string) => c.includes('INSERT INTO worker_documents'))).toBe(false);
    expect(calls).toContain('COMMIT');
  });

  it('returns 400 when the uploaded object cannot be found in S3', async () => {
    mockS3Send.mockRejectedValueOnce(new Error('not found'));
    stubUserLookup();

    const res = await handler(mkEv({ doc_type: 'resume', s3_key: OWN_KEY, file_name: 'f', file_size: 1, mime_type: 'application/pdf' }));

    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).error).toBe('uploaded_object_not_found');
    const calls = mockQuery.mock.calls.map(c => c[0]);
    expect(calls.some((c: string) => c.includes('INSERT INTO worker_documents'))).toBe(false);
  });

  it('returns 400 when the S3 object content type does not match the declared mime_type', async () => {
    mockS3Send.mockResolvedValueOnce({ ...validHead, ContentType: 'image/png' });
    stubUserLookup();

    const res = await handler(mkEv({ doc_type: 'resume', s3_key: OWN_KEY, file_name: 'f', file_size: 1, mime_type: 'application/pdf' }));

    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).error).toBe('invalid_upload');
    const calls = mockQuery.mock.calls.map(c => c[0]);
    expect(calls.some((c: string) => c.includes('INSERT INTO worker_documents'))).toBe(false);
  });

  it('returns 400 when the S3 object is missing server-side encryption', async () => {
    mockS3Send.mockResolvedValueOnce({ ...validHead, ServerSideEncryption: undefined });
    stubUserLookup();

    const res = await handler(mkEv({ doc_type: 'resume', s3_key: OWN_KEY, file_name: 'f', file_size: 1, mime_type: 'application/pdf' }));

    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).error).toBe('invalid_upload');
    const calls = mockQuery.mock.calls.map(c => c[0]);
    expect(calls.some((c: string) => c.includes('INSERT INTO worker_documents'))).toBe(false);
  });

  it('returns 400 when the S3 object has a non-positive content length', async () => {
    mockS3Send.mockResolvedValueOnce({ ...validHead, ContentLength: 0 });
    stubUserLookup();

    const res = await handler(mkEv({ doc_type: 'resume', s3_key: OWN_KEY, file_name: 'f', file_size: 1, mime_type: 'application/pdf' }));

    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).error).toBe('invalid_upload');
    const calls = mockQuery.mock.calls.map(c => c[0]);
    expect(calls.some((c: string) => c.includes('INSERT INTO worker_documents'))).toBe(false);
  });
});
