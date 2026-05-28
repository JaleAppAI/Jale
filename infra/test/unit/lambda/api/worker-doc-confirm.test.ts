import type { APIGatewayProxyEvent } from 'aws-lambda';
import { handler } from '../../../../lambda/api/worker-doc-confirm';
import { getDbPool } from '../../../../lambda/lib/db';
import { S3Client } from '@aws-sdk/client-s3';

jest.mock('../../../../lambda/lib/db');
jest.mock('@aws-sdk/client-s3', () => ({
  S3Client: jest.fn().mockImplementation(() => ({ send: jest.fn() })),
  HeadObjectCommand: jest.fn().mockImplementation((input) => ({ input })),
}));

const mockGetDbPool = getDbPool as jest.Mock;
const mockQuery = jest.fn();
const mockRelease = jest.fn();
const mockS3Send = (S3Client as jest.Mock).mock.results[0].value.send as jest.Mock;

describe('worker-doc-confirm Lambda', () => {
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

  const validBody = {
    token: 'valid-token',
    s3_key: 'documents/job-1/worker-1/resume/uuid.pdf',
    doc_type: 'resume',
    file_name: 'resume.pdf',
    file_size: 102400,
    mime_type: 'application/pdf',
  };

  const slotRow = {
    worker_id: 'worker-1',
    job_id: 'job-1',
    doc_type: 'resume',
    issued_s3_key: 'documents/job-1/worker-1/resume/uuid.pdf',
    expected_mime_type: 'application/pdf',
    max_file_size: 10 * 1024 * 1024,
  };

  const headResult = {
    ContentLength: 102400,
    ContentType: 'application/pdf',
    ServerSideEncryption: 'aws:kms',
    VersionId: 'version-1',
  };

  it('returns 400 if required fields are missing', async () => {
    const res = await handler(makeEvent({ token: 'abc' }));
    expect(res.statusCode).toBe(400);
  });

  it('returns 409 if the upload slot is invalid, confirmed, or mismatched', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });

    const res = await handler(makeEvent(validBody));

    expect(res.statusCode).toBe(409);
    expect(JSON.parse(res.body).error).toBe('invalid_or_confirmed_upload');
    expect(mockS3Send).not.toHaveBeenCalled();
    expect(mockQuery).not.toHaveBeenCalledWith(expect.stringContaining('INSERT INTO worker_documents'), expect.anything());
    expect(mockQuery).not.toHaveBeenCalledWith('COMMIT');
  });

  it('returns 200 and atomically consumes token while inserting the verified document row', async () => {
    mockS3Send.mockResolvedValueOnce(headResult);
    mockQuery
      .mockResolvedValueOnce({ rows: [slotRow] }) // slot lookup
      .mockResolvedValueOnce({}) // BEGIN
      .mockResolvedValueOnce({}) // set_config RLS
      .mockResolvedValueOnce({ rows: [{ id: 'doc-uuid' }] }) // guarded CTE
      .mockResolvedValueOnce({}); // COMMIT

    const res = await handler(makeEvent(validBody));

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ success: true });
    expect(mockS3Send).toHaveBeenCalledWith({
      input: {
        Bucket: 'test-bucket',
        Key: 'documents/job-1/worker-1/resume/uuid.pdf',
      },
    });
    expect(mockQuery).toHaveBeenCalledWith('BEGIN');
    expect(mockQuery).toHaveBeenCalledWith(
      expect.stringContaining('SET used = true, used_at = now()'),
      expect.arrayContaining(['version-1', 'resume.pdf', 102400]),
    );
    const atomicSql = mockQuery.mock.calls.find(([sql]) =>
      typeof sql === 'string' && sql.includes('WITH consumed_token AS')
    )?.[0] as string;
    expect(atomicSql).toContain('token.used = false');
    expect(atomicSql).toContain('token.expires_at > now()');
    expect(atomicSql).toContain('slots.issued_s3_key = $3');
    expect(atomicSql).toContain('slots.expected_mime_type = $4');
    expect(atomicSql).toContain('slots.confirmed_at IS NULL');
    expect(atomicSql).toContain('SET confirmed_at = now()');
    expect(atomicSql).toContain('INSERT INTO worker_documents');
    expect(mockQuery).toHaveBeenCalledWith('COMMIT');
    expect(mockRelease).toHaveBeenCalled();
  });

  it('returns 409 without inserting when a race consumes the token before the guarded write', async () => {
    mockS3Send.mockResolvedValueOnce(headResult);
    mockQuery
      .mockResolvedValueOnce({ rows: [slotRow] }) // slot lookup
      .mockResolvedValueOnce({}) // BEGIN
      .mockResolvedValueOnce({}) // set_config RLS
      .mockResolvedValueOnce({ rows: [] }) // guarded CTE loses the race
      .mockResolvedValueOnce({}); // ROLLBACK

    const res = await handler(makeEvent(validBody));

    expect(res.statusCode).toBe(409);
    expect(JSON.parse(res.body).error).toBe('invalid_or_confirmed_upload');
    expect(mockQuery).toHaveBeenCalledWith('ROLLBACK');
    expect(mockQuery).not.toHaveBeenCalledWith('COMMIT');
  });

  it('rejects a mismatched client s3_key before S3 access', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });

    const res = await handler(makeEvent({
      ...validBody,
      s3_key: 'documents/job-1/worker-1/resume/other.pdf',
    }));

    expect(res.statusCode).toBe(409);
    expect(mockS3Send).not.toHaveBeenCalled();
  });

  it('returns 400 if S3 object is missing without consuming the token', async () => {
    mockS3Send.mockRejectedValueOnce(new Error('not found'));
    mockQuery.mockResolvedValueOnce({ rows: [slotRow] });

    const res = await handler(makeEvent(validBody));

    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).error).toBe('uploaded_object_not_found');
    expect(mockQuery).not.toHaveBeenCalledWith('BEGIN');
    expect(mockQuery).not.toHaveBeenCalledWith(expect.stringContaining('SET used = true'), expect.anything());
  });

  it('returns 400 if server-observed file size exceeds slot max without consuming the token', async () => {
    mockS3Send.mockResolvedValueOnce({
      ContentLength: 11 * 1024 * 1024,
      ContentType: 'application/pdf',
      ServerSideEncryption: 'aws:kms',
    });
    mockQuery.mockResolvedValueOnce({ rows: [slotRow] });

    const res = await handler(makeEvent(validBody));

    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).error).toBe('invalid_file_size');
    expect(mockQuery).not.toHaveBeenCalledWith('BEGIN');
    expect(mockQuery).not.toHaveBeenCalledWith(expect.stringContaining('SET used = true'), expect.anything());
  });

  it('returns 400 if server-observed MIME type differs from slot without consuming the token', async () => {
    mockS3Send.mockResolvedValueOnce({
      ContentLength: 102400,
      ContentType: 'image/png',
      ServerSideEncryption: 'aws:kms',
    });
    mockQuery.mockResolvedValueOnce({ rows: [slotRow] });

    const res = await handler(makeEvent(validBody));

    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).error).toBe('invalid_mime_type');
    expect(mockQuery).not.toHaveBeenCalledWith('BEGIN');
    expect(mockQuery).not.toHaveBeenCalledWith(expect.stringContaining('SET used = true'), expect.anything());
  });

  it('returns 500 and rolls back on DB error inside the atomic transaction', async () => {
    mockS3Send.mockResolvedValueOnce(headResult);
    mockQuery
      .mockResolvedValueOnce({ rows: [slotRow] }) // slot lookup
      .mockResolvedValueOnce({}) // BEGIN
      .mockResolvedValueOnce({}) // set_config RLS
      .mockRejectedValueOnce(new Error('DB down')) // guarded CTE
      .mockResolvedValueOnce({}); // ROLLBACK

    const res = await handler(makeEvent(validBody));

    expect(res.statusCode).toBe(500);
    expect(mockQuery).toHaveBeenCalledWith('ROLLBACK');
    expect(mockRelease).toHaveBeenCalled();
  });
});
