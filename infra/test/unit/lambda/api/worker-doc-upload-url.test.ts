import type { APIGatewayProxyEvent } from 'aws-lambda';
import { createHash } from 'crypto';
import { handler } from '../../../../lambda/api/worker-doc-upload-url';
import { getDbPool } from '../../../../lambda/lib/db';
import { PutObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

jest.mock('../../../../lambda/lib/db');
jest.mock('@aws-sdk/client-s3', () => ({
  S3Client: jest.fn().mockImplementation(() => ({})),
  PutObjectCommand: jest.fn().mockImplementation((input) => ({ input })),
}));
jest.mock('@aws-sdk/s3-request-presigner', () => ({
  getSignedUrl: jest.fn(),
}));

const mockGetDbPool = getDbPool as jest.Mock;
const mockGetSignedUrl = getSignedUrl as jest.Mock;
const mockQuery = jest.fn();
const mockRelease = jest.fn();

const ISSUED_KEY = 'documents/job-uuid/worker-uuid/resume/uuid.pdf';
const timeline: string[] = [];

/** Answers by statement: the resolve call returns `outcome` (and the key on ok). */
function resolveWith(outcome: string, s3Key: string | null = outcome === 'ok' ? ISSUED_KEY : null) {
  mockQuery.mockImplementation((sql: string) => {
    timeline.push(sql.replace(/\s+/g, ' ').trim());
    if (/jale_cap\.upload_token_resolve/.test(sql)) return Promise.resolve({ rows: [{ outcome, s3_key: s3Key }] });
    return Promise.resolve({ rows: [] });
  });
}

describe('worker-doc-upload-url Lambda', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    timeline.length = 0;
    process.env.DOCUMENTS_BUCKET = 'test-bucket';
    process.env.ALLOWED_ORIGIN = 'https://jaleapp.ai';
    mockGetDbPool.mockResolvedValue({
      connect: jest.fn().mockResolvedValue({ query: mockQuery, release: mockRelease }),
    });
    mockGetSignedUrl.mockImplementation(async () => {
      timeline.push('PRESIGN');
      return 'https://s3.example.com/presigned-put';
    });
  });

  const makeEvent = (body: object) =>
    ({ body: JSON.stringify(body) }) as unknown as APIGatewayProxyEvent;

  it('returns 400 if token or doc_type is missing', async () => {
    const res = await handler(makeEvent({ token: 'abc' }));
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).error).toBe('missing_fields');
  });

  it('returns 400 if doc_type is invalid, without querying the DB', async () => {
    const res = await handler(
      makeEvent({ token: 'abc', doc_type: 'passport', mime_type: 'application/pdf' }),
    );
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).error).toBe('invalid_doc_type');
    expect(mockQuery).not.toHaveBeenCalled();
  });

  it('returns 400 if the MIME type is not supported, without querying the DB', async () => {
    const res = await handler(makeEvent({ token: 'abc', doc_type: 'resume', mime_type: 'text/plain' }));
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body)).toEqual({
      error: 'invalid_mime_type', valid: ['application/pdf', 'image/jpeg', 'image/png'],
    });
    expect(mockQuery).not.toHaveBeenCalled();
  });

  it('resolves the token through jale_cap.upload_token_resolve with its hash, the doc type and the MIME type', async () => {
    resolveWith('ok');
    await handler(makeEvent({ token: 'valid-token', doc_type: 'resume', mime_type: 'application/pdf' }));
    const resolve = mockQuery.mock.calls.find(([sql]) => /upload_token_resolve/.test(String(sql)));
    expect(String(resolve![0])).toMatch(/SELECT outcome, s3_key FROM jale_cap\.upload_token_resolve\(\$1, \$2, \$3\)/);
    expect(resolve![1]).toEqual([createHash('sha256').update('valid-token').digest('hex'), 'resume', 'application/pdf']);
    expect(timeline.some((step) => /document_upload_tokens|document_upload_token_slots|job_applications/.test(step))).toBe(false);
  });

  it('returns 401 when the token does not resolve', async () => {
    resolveWith('invalid_token');
    const res = await handler(
      makeEvent({ token: 'bad-token', doc_type: 'resume', mime_type: 'application/pdf' }),
    );
    expect(res.statusCode).toBe(401);
    expect(JSON.parse(res.body).error).toBe('invalid_token');
    expect(timeline).toEqual(['BEGIN', expect.stringMatching(/upload_token_resolve/), 'ROLLBACK']);
    expect(mockGetSignedUrl).not.toHaveBeenCalled();
  });

  it('returns 200 with a URL presigned for the key the database issued, inside the resolve transaction', async () => {
    resolveWith('ok');
    const res = await handler(
      makeEvent({ token: 'valid-token', doc_type: 'resume', mime_type: 'application/pdf' }),
    );
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ url: 'https://s3.example.com/presigned-put', s3_key: ISSUED_KEY });
    expect(PutObjectCommand).toHaveBeenCalledWith({ Bucket: 'test-bucket', Key: ISSUED_KEY, ContentType: 'application/pdf' });
    expect(timeline).toEqual(['BEGIN', expect.stringMatching(/upload_token_resolve/), 'PRESIGN', 'COMMIT']);
    expect(mockRelease).toHaveBeenCalled();
  });

  it('returns 409 if a document slot was already confirmed', async () => {
    resolveWith('document_already_confirmed');
    const res = await handler(
      makeEvent({ token: 'valid-token', doc_type: 'resume', mime_type: 'application/pdf' }),
    );
    expect(res.statusCode).toBe(409);
    expect(JSON.parse(res.body).error).toBe('document_already_confirmed');
    expect(timeline[timeline.length - 1]).toBe('ROLLBACK');
    expect(mockRelease).toHaveBeenCalled();
  });

  it('maps a database refusal of the doc type or MIME type to the same 400 bodies as the pre-checks', async () => {
    resolveWith('invalid_doc_type');
    const docRes = await handler(makeEvent({ token: 't', doc_type: 'resume', mime_type: 'application/pdf' }));
    expect(docRes.statusCode).toBe(400);
    expect(JSON.parse(docRes.body).error).toBe('invalid_doc_type');

    resolveWith('invalid_mime_type');
    const mimeRes = await handler(makeEvent({ token: 't', doc_type: 'resume', mime_type: 'application/pdf' }));
    expect(mimeRes.statusCode).toBe(400);
    expect(JSON.parse(mimeRes.body)).toEqual({
      error: 'invalid_mime_type', valid: ['application/pdf', 'image/jpeg', 'image/png'],
    });
  });

  it('returns 500 and rolls back when presigning fails, so no slot is left issued', async () => {
    jest.spyOn(console, 'error').mockImplementation(() => {});
    resolveWith('ok');
    mockGetSignedUrl.mockRejectedValueOnce(new Error('no credentials'));
    const res = await handler(makeEvent({ token: 'valid-token', doc_type: 'resume', mime_type: 'application/pdf' }));
    expect(res.statusCode).toBe(500);
    expect(timeline[timeline.length - 1]).toBe('ROLLBACK');
    expect(timeline).not.toContain('COMMIT');
  });

  it('returns 500 and rolls back on an outcome it does not know', async () => {
    jest.spyOn(console, 'error').mockImplementation(() => {});
    resolveWith('something_else');
    const res = await handler(makeEvent({ token: 'valid-token', doc_type: 'resume', mime_type: 'application/pdf' }));
    expect(res.statusCode).toBe(500);
    expect(timeline).not.toContain('COMMIT');
  });

  describe('cert_name validation (BE-T3, fail-fast before presigning)', () => {
    it('rejects a cert_name on a non-certification doc_type with invalid_cert_name, without querying the DB', async () => {
      const res = await handler(
        makeEvent({ token: 'valid-token', doc_type: 'resume', mime_type: 'application/pdf', cert_name: 'OSHA 30' }),
      );
      expect(res.statusCode).toBe(400);
      expect(JSON.parse(res.body).error).toBe('invalid_cert_name');
      expect(mockQuery).not.toHaveBeenCalled();
    });

    it('rejects a cert_name over 200 chars on certification_doc with invalid_cert_name, without querying the DB', async () => {
      const res = await handler(
        makeEvent({ token: 'valid-token', doc_type: 'certification_doc', mime_type: 'application/pdf', cert_name: 'a'.repeat(201) }),
      );
      expect(res.statusCode).toBe(400);
      expect(JSON.parse(res.body).error).toBe('invalid_cert_name');
      expect(mockQuery).not.toHaveBeenCalled();
    });

    it('allows a certification_doc upload-url request without cert_name -- optional at this stage, required only at confirm', async () => {
      resolveWith('ok', 'documents/job-uuid/worker-uuid/certification_doc/uuid.pdf');
      const res = await handler(
        makeEvent({ token: 'valid-token', doc_type: 'certification_doc', mime_type: 'application/pdf' }),
      );
      expect(res.statusCode).toBe(200);
    });
  });
});
