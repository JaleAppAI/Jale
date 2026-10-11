import type { APIGatewayProxyEvent } from 'aws-lambda';
import { createHash } from 'crypto';
import { handler } from '../../../../lambda/api/worker-doc-confirm';
import { getDbPool } from '../../../../lambda/lib/db';
import { S3Client } from '@aws-sdk/client-s3';

import { setAuditContext } from '../../../../lambda/lib/audit/context';
import { expectContextBeforeWrite, idlessCallerFor, withRequestId } from './audit-expectations';

jest.mock('../../../../lambda/lib/db');
jest.mock('../../../../lambda/lib/audit/context');
jest.mock('@aws-sdk/client-s3', () => ({
  S3Client: jest.fn().mockImplementation(() => ({ send: jest.fn() })),
  HeadObjectCommand: jest.fn().mockImplementation((input) => ({ input })),
}));

const mockGetDbPool = getDbPool as jest.Mock;
const mockQuery = jest.fn();
const mockRelease = jest.fn();
const mockS3Send = (S3Client as jest.Mock).mock.results[0].value.send as jest.Mock;

const TOKEN_HASH = createHash('sha256').update('valid-token').digest('hex');
const MAX_FILE_SIZE = 10 * 1024 * 1024;

/** Statements, transaction control and the S3 call, in order. */
const timeline: string[] = [];

interface Answers {
  slot?: string;
  maxFileSize?: number;
  confirm?: string | Error;
}

/**
 * Answers by statement: the slot pre-check returns `slot` (with the slot's
 * max file size on ok), the confirm call returns `confirm` or rejects with it.
 */
function answer({ slot = 'ok', maxFileSize = MAX_FILE_SIZE, confirm = 'ok' }: Answers = {}) {
  mockQuery.mockImplementation((sql: string) => {
    const text = sql.replace(/\s+/g, ' ').trim();
    timeline.push(text);
    if (/jale_cap\.upload_token_slot\(/.test(text)) {
      return Promise.resolve({ rows: [{ outcome: slot, max_file_size: slot === 'ok' ? maxFileSize : null }] });
    }
    if (/jale_cap\.upload_token_confirm\(/.test(text)) {
      if (confirm instanceof Error) return Promise.reject(confirm);
      return Promise.resolve({ rows: [{ outcome: confirm, document_id: confirm === 'ok' ? 'doc-uuid' : null }] });
    }
    return Promise.resolve({ rows: [] });
  });
}

describe('worker-doc-confirm Lambda', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    timeline.length = 0;
    process.env.DOCUMENTS_BUCKET = 'test-bucket';
    process.env.ALLOWED_ORIGIN = 'https://jaleapp.ai';
    mockGetDbPool.mockResolvedValue({
      connect: jest.fn().mockResolvedValue({ query: mockQuery, release: mockRelease }),
    });
    mockS3Send.mockImplementation(async () => {
      timeline.push('S3');
      return headResult;
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

  const headResult = {
    ContentLength: 102400,
    ContentType: 'application/pdf',
    ServerSideEncryption: 'aws:kms',
    VersionId: 'version-1',
  };

  const confirmCall = () => mockQuery.mock.calls.find(([sql]) => /upload_token_confirm\(/.test(String(sql)));

  // ── Request validation, before any database work ──────────────────────

  it('returns 400 if required fields are missing', async () => {
    const res = await handler(makeEvent({ token: 'abc' }));
    expect(res.statusCode).toBe(400);
    expect(mockQuery).not.toHaveBeenCalled();
  });

  it('rejects a bogus doc_type with invalid_doc_type and no `valid` field (response shape preserved)', async () => {
    const res = await handler(makeEvent({ ...validBody, doc_type: 'passport' }));
    expect(res.statusCode).toBe(400);
    const parsed = JSON.parse(res.body);
    expect(parsed.error).toBe('invalid_doc_type');
    expect(parsed.valid).toBeUndefined();
    expect(mockQuery).not.toHaveBeenCalled();
  });

  it('rejects a cert_name on a non-certification doc_type with invalid_cert_name, without querying the DB', async () => {
    const res = await handler(makeEvent({ ...validBody, cert_name: 'OSHA 30' }));
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).error).toBe('invalid_cert_name');
    expect(mockQuery).not.toHaveBeenCalled();
  });

  it('accepts work_auth_doc as a valid doc_type (it reaches the slot check)', async () => {
    answer({ slot: 'invalid_or_confirmed_upload' });
    const res = await handler(makeEvent({ ...validBody, doc_type: 'work_auth_doc' }));
    expect(res.statusCode).toBe(409);
    expect(JSON.parse(res.body).error).toBe('invalid_or_confirmed_upload');
  });

  // ── The slot pre-check: 409 before the object is inspected ──────────────

  it('checks the slot through jale_cap.upload_token_slot with the token hash, doc type, key and MIME type', async () => {
    answer();
    await handler(makeEvent(validBody));
    const slot = mockQuery.mock.calls.find(([sql]) => /upload_token_slot\(/.test(String(sql)));
    expect(String(slot![0])).toMatch(/SELECT outcome, max_file_size FROM jale_cap\.upload_token_slot\(\$1, \$2, \$3, \$4\)/);
    expect(slot![1]).toEqual([TOKEN_HASH, 'resume', validBody.s3_key, 'application/pdf']);
  });

  it('returns 409 for an invalid, confirmed or mismatched slot before any S3 call, with no transaction opened', async () => {
    answer({ slot: 'invalid_or_confirmed_upload' });
    const res = await handler(makeEvent(validBody));
    expect(res.statusCode).toBe(409);
    expect(JSON.parse(res.body).error).toBe('invalid_or_confirmed_upload');
    expect(mockS3Send).not.toHaveBeenCalled();
    expect(timeline).toEqual([expect.stringMatching(/upload_token_slot/)]);
    expect(mockRelease).toHaveBeenCalled();
  });

  // ── The object checks, with no transaction open ─────────────────────────

  it('returns 400 if the S3 object is missing, with nothing confirmed', async () => {
    answer();
    mockS3Send.mockImplementationOnce(async () => {
      timeline.push('S3');
      throw new Error('NotFound');
    });
    const res = await handler(makeEvent(validBody));
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).error).toBe('uploaded_object_not_found');
    expect(confirmCall()).toBeUndefined();
    expect(timeline).not.toContain('BEGIN');
  });

  it('heads the key the slot check accepted', async () => {
    answer();
    await handler(makeEvent(validBody));
    expect(mockS3Send).toHaveBeenCalledWith({ input: { Bucket: 'test-bucket', Key: validBody.s3_key } });
  });

  it('returns 400 if the server-observed size exceeds the slot maximum, with nothing confirmed', async () => {
    answer({ maxFileSize: 1000 });
    const res = await handler(makeEvent(validBody));
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).error).toBe('invalid_file_size');
    expect(confirmCall()).toBeUndefined();
  });

  it('returns 400 for an empty object, with nothing confirmed', async () => {
    answer();
    mockS3Send.mockImplementationOnce(async () => ({ ...headResult, ContentLength: 0 }));
    const res = await handler(makeEvent(validBody));
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).error).toBe('invalid_file_size');
  });

  it('returns 400 if the server-observed MIME type differs, with nothing confirmed', async () => {
    answer();
    mockS3Send.mockImplementationOnce(async () => ({ ...headResult, ContentType: 'image/png' }));
    const res = await handler(makeEvent(validBody));
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).error).toBe('invalid_mime_type');
    expect(confirmCall()).toBeUndefined();
  });

  it('returns 400 if the object is not encrypted, with nothing confirmed', async () => {
    answer();
    mockS3Send.mockImplementationOnce(async () => ({ ...headResult, ServerSideEncryption: undefined }));
    const res = await handler(makeEvent(validBody));
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).error).toBe('missing_encryption');
    expect(confirmCall()).toBeUndefined();
  });

  // ── The confirm: one capability call, in its own transaction ─────────────

  it('returns 200 and confirms through jale_cap.upload_token_confirm in one transaction opened after the S3 check', async () => {
    answer();
    const res = await handler(makeEvent(validBody));
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ success: true });
    expect(timeline).toEqual([
      expect.stringMatching(/upload_token_slot/),
      'S3',
      'BEGIN',
      expect.stringMatching(/upload_token_confirm/),
      'COMMIT',
    ]);
    const [sql, params] = confirmCall()!;
    expect(String(sql)).toMatch(
      /SELECT outcome, document_id FROM jale_cap\.upload_token_confirm\(\$1, \$2, \$3, \$4, \$5, \$6, \$7, \$8\)/,
    );
    // The size and version come from the server's object check, never the client.
    expect(params).toEqual([TOKEN_HASH, 'resume', validBody.s3_key, 'application/pdf', 'resume.pdf', 102400, 'version-1', null]);
    expect(mockRelease).toHaveBeenCalled();
  });

  it('sanitizes the file name before confirming, and falls back to the doc type when nothing is left', async () => {
    answer();
    await handler(makeEvent({ ...validBody, file_name: 'a/b\\c\u0007.pdf' }));
    expect(confirmCall()![1][4]).toBe('a_b_c.pdf');

    mockQuery.mockClear();
    answer();
    await handler(makeEvent({ ...validBody, file_name: '\u0001\u0002' }));
    expect(confirmCall()![1][4]).toBe('resume.pdf');
  });

  it.each([
    ['invalid_or_confirmed_upload', 409],
    ['invalid_file_size', 400],
    ['document_conflict', 409],
    ['certification_document_limit', 409],
    ['certification_document_name_limit', 409],
  ])('maps the confirm outcome %s to %i with that error, and rolls back', async (outcome, status) => {
    answer({ confirm: outcome });
    const res = await handler(makeEvent(validBody));
    expect(res.statusCode).toBe(status);
    expect(JSON.parse(res.body)).toEqual({ error: outcome });
    expect(timeline[timeline.length - 1]).toBe('ROLLBACK');
    expect(timeline).not.toContain('COMMIT');
  });

  it('returns 500 and rolls back when the confirm call fails after the object exists (the object is left for a retry)', async () => {
    jest.spyOn(console, 'error').mockImplementation(() => {});
    answer({ confirm: new Error('connection reset') });
    const res = await handler(makeEvent(validBody));
    expect(res.statusCode).toBe(500);
    expect(JSON.parse(res.body).error).toBe('internal_error');
    expect(timeline[timeline.length - 1]).toBe('ROLLBACK');
    expect(timeline).not.toContain('COMMIT');
    // Today's behaviour: no S3 deletion, only the one HeadObject.
    expect(mockS3Send).toHaveBeenCalledTimes(1);
  });

  it('returns 500 and rolls back on an outcome it does not know', async () => {
    jest.spyOn(console, 'error').mockImplementation(() => {});
    answer({ confirm: 'something_else' });
    const res = await handler(makeEvent(validBody));
    expect(res.statusCode).toBe(500);
    expect(timeline).not.toContain('COMMIT');
  });

  describe('certification_doc', () => {
    const certBody = {
      ...validBody,
      doc_type: 'certification_doc',
      s3_key: 'documents/job-1/worker-1/certification_doc/uuid.pdf',
      file_name: 'cert.pdf',
      cert_name: 'OSHA 30',
    };

    it('passes the trimmed cert_name to the confirm call', async () => {
      answer();
      const res = await handler(makeEvent({ ...certBody, cert_name: '  OSHA 30  ' }));
      expect(res.statusCode).toBe(200);
      expect(confirmCall()![1][7]).toBe('OSHA 30');
    });

    it('allows a certification_doc confirm without cert_name -- optional on this tokenized surface, NULL is passed', async () => {
      const { cert_name, ...bodyWithoutCertName } = certBody;
      answer();
      const res = await handler(makeEvent(bodyWithoutCertName));
      expect(res.statusCode).toBe(200);
      expect(confirmCall()![1][7]).toBeNull();
    });

    it('returns 400 invalid_cert_name when cert_name exceeds 200 chars, without querying the DB', async () => {
      const res = await handler(makeEvent({ ...certBody, cert_name: 'a'.repeat(201) }));
      expect(res.statusCode).toBe(400);
      expect(JSON.parse(res.body).error).toBe('invalid_cert_name');
      expect(mockQuery).not.toHaveBeenCalled();
    });
  });

  describe('change context', () => {
    it('states the token holder, with no id, in the confirm transaction', async () => {
      answer();
      const res = await handler(withRequestId(makeEvent(validBody)));
      expect(res.statusCode).toBe(200);
      expect(setAuditContext).toHaveBeenCalledTimes(1);
      expect(setAuditContext).toHaveBeenCalledWith(
        expect.objectContaining({ query: mockQuery }), idlessCallerFor('token_holder'), 'token_holder.document_confirm');
      expectContextBeforeWrite(mockQuery, setAuditContext as jest.Mock, /jale_cap\.upload_token_confirm/);
    });

    it('states nothing when the slot check refuses, before any transaction', async () => {
      answer({ slot: 'invalid_token' });
      await handler(makeEvent(validBody));
      expect(setAuditContext).not.toHaveBeenCalled();
    });
  });
});
