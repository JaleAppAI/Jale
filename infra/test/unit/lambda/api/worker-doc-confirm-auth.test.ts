import type { APIGatewayProxyEvent } from 'aws-lambda';
jest.mock('../../../../lambda/lib/db');
jest.mock('../../../../lambda/legal/check-compliance');
jest.mock('../../../../lambda/lib/audit/record', () => ({
  ...jest.requireActual('../../../../lambda/lib/audit/record'),
  recordAccess: jest.fn(),
  recordAttempt: jest.fn(),
}));
jest.mock('../../../../lambda/lib/audit/context');
jest.mock('@aws-sdk/client-s3', () => ({
  S3Client: jest.fn().mockImplementation(() => ({ send: jest.fn() })),
  HeadObjectCommand: jest.fn().mockImplementation((input) => ({ input })),
}));
import { handler } from '../../../../lambda/api/worker-doc-confirm-auth';
import { getDbPool, setInternalUserRlsContext } from '../../../../lambda/lib/db';
import { checkCompliance } from '../../../../lambda/legal/check-compliance';
import { setAuditContext } from '../../../../lambda/lib/audit/context';
import { callerFor, expectContextBeforeWrite, withRequestId } from './audit-expectations';
import { S3Client } from '@aws-sdk/client-s3';
import { MAX_CERTIFICATION_FILES, MAX_CERTIFICATION_FILES_PER_NAME } from '../../../../lambda/lib/job-fields';

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

  it('rejects a cert_name on a non-certification doc_type with invalid_cert_name, without querying the DB', async () => {
    const res = await handler(mkEv({ doc_type: 'resume', s3_key: OWN_KEY, file_name: 'f', file_size: 1, mime_type: 'application/pdf', cert_name: 'OSHA 30' }));
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).error).toBe('invalid_cert_name');
    expect(mockQuery).not.toHaveBeenCalled();
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
    const deleteAt = calls.findIndex((c: string) => c.includes('DELETE FROM worker_documents'));
    expect(deleteAt).toBeGreaterThan(-1);
    // The write transaction (the one holding the DELETE) rolls back; only the
    // earlier read-only caller check committed.
    expect(calls.slice(deleteAt)).toContain('ROLLBACK');
    expect(calls.slice(deleteAt)).not.toContain('COMMIT');
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

  const CERT_KEY = 'documents/vault/u1/certification_doc/uuid.pdf';

  it('accepts work_auth_doc as a valid doc_type', async () => {
    mockS3Send.mockResolvedValueOnce(validHead);
    mockQuery.mockImplementation((q: string) => {
      if (q.includes('SELECT id FROM users')) return Promise.resolve({ rows: [{ id: 'u1' }] });
      if (q.includes('DELETE FROM worker_documents')) return Promise.resolve({ rowCount: 0 });
      if (q.includes('INSERT INTO worker_documents')) return Promise.resolve({ rows: [{ id: 'd1', doc_type: 'work_auth_doc' }] });
      return Promise.resolve({});
    });
    const res = await handler(mkEv({
      doc_type: 'work_auth_doc',
      s3_key: 'documents/vault/u1/work_auth_doc/uuid.pdf',
      file_name: 'f',
      file_size: 1,
      mime_type: 'application/pdf',
    }));
    expect(res.statusCode).toBe(201);
  });

  it('rejects a bogus doc_type and echoes the four valid types', async () => {
    const res = await handler(mkEv({ doc_type: 'passport', s3_key: OWN_KEY, file_name: 'f', file_size: 1, mime_type: 'application/pdf' }));
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).valid).toEqual(['resume', 'driver_license', 'work_auth_doc', 'certification_doc']);
  });

  it('returns 400 missing_cert_name when cert_name is omitted on a certification_doc confirm, without querying the DB', async () => {
    const res = await handler(mkEv({ doc_type: 'certification_doc', s3_key: CERT_KEY, file_name: 'cert.pdf', file_size: 1, mime_type: 'application/pdf' }));
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).error).toBe('missing_cert_name');
    expect(mockQuery).not.toHaveBeenCalled();
  });

  it('returns 400 invalid_cert_name when cert_name exceeds 200 chars, without querying the DB', async () => {
    const res = await handler(mkEv({ doc_type: 'certification_doc', s3_key: CERT_KEY, file_name: 'cert.pdf', file_size: 1, mime_type: 'application/pdf', cert_name: 'a'.repeat(201) }));
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).error).toBe('invalid_cert_name');
    expect(mockQuery).not.toHaveBeenCalled();
  });

  it('appends a new certification_doc row without deleting prior ones, when under both caps, writing the trimmed cert_name', async () => {
    mockS3Send.mockResolvedValueOnce(validHead);
    mockQuery.mockImplementation((q: string) => {
      if (q.includes('SELECT id FROM users')) return Promise.resolve({ rows: [{ id: 'u1' }] });
      // Per-name check first: its SQL is a superset-match of the generic
      // 'SELECT COUNT' the total check also uses, so it must be discriminated
      // ahead of the generic branch below.
      if (q.includes('cert_name IS NOT DISTINCT FROM')) return Promise.resolve({ rows: [{ count: 1 }] });
      if (q.includes('SELECT COUNT')) return Promise.resolve({ rows: [{ count: 2 }] });
      if (q.includes('INSERT INTO worker_documents')) return Promise.resolve({ rows: [{ id: 'd2', doc_type: 'certification_doc' }] });
      return Promise.resolve({});
    });

    const res = await handler(mkEv({ doc_type: 'certification_doc', s3_key: CERT_KEY, file_name: 'cert.pdf', file_size: 1, mime_type: 'application/pdf', cert_name: '  OSHA 30  ' }));

    expect(res.statusCode).toBe(201);
    const calls = mockQuery.mock.calls.map(c => c[0] as string);
    expect(calls.some((c) => c.includes('DELETE FROM worker_documents'))).toBe(false);
    expect(calls.filter((c) => c.includes('SELECT COUNT')).length).toBe(2);
    const insertCall = mockQuery.mock.calls.find(([q]) => typeof q === 'string' && q.includes('INSERT INTO worker_documents'));
    expect(insertCall).toBeDefined();
    expect(insertCall![0]).toContain('cert_name');
    expect(insertCall![1]).toContain('OSHA 30'); // trimmed before persisting
  });

  it('returns 409 certification_document_limit when at the total cap (defense-in-depth count check)', async () => {
    mockS3Send.mockResolvedValueOnce(validHead);
    mockQuery.mockImplementation((q: string) => {
      if (q.includes('SELECT id FROM users')) return Promise.resolve({ rows: [{ id: 'u1' }] });
      // BE-T3 (078) raised MAX_CERTIFICATION_FILES from 5 to 20 -- the cap
      // check below is keyed off the constant, not a hardcoded number.
      if (q.includes('cert_name IS NOT DISTINCT FROM')) return Promise.resolve({ rows: [{ count: 0 }] });
      if (q.includes('SELECT COUNT')) return Promise.resolve({ rows: [{ count: MAX_CERTIFICATION_FILES }] });
      return Promise.resolve({});
    });

    const res = await handler(mkEv({ doc_type: 'certification_doc', s3_key: CERT_KEY, file_name: 'cert.pdf', file_size: 1, mime_type: 'application/pdf', cert_name: 'OSHA 30' }));

    expect(res.statusCode).toBe(409);
    expect(JSON.parse(res.body).error).toBe('certification_document_limit');
    const calls = mockQuery.mock.calls.map(c => c[0]);
    expect(calls.some((c: string) => c.includes('INSERT INTO worker_documents'))).toBe(false);
  });

  it('returns 409 certification_document_name_limit when at the per-name cap (defense-in-depth count check)', async () => {
    mockS3Send.mockResolvedValueOnce(validHead);
    mockQuery.mockImplementation((q: string) => {
      if (q.includes('SELECT id FROM users')) return Promise.resolve({ rows: [{ id: 'u1' }] });
      // Per-name cap stays 5 even though the total cap is now 20 -- see
      // 078's header REACHABILITY section.
      if (q.includes('cert_name IS NOT DISTINCT FROM')) return Promise.resolve({ rows: [{ count: MAX_CERTIFICATION_FILES_PER_NAME }] });
      if (q.includes('SELECT COUNT')) return Promise.resolve({ rows: [{ count: 3 }] }); // total, well under 20
      return Promise.resolve({});
    });

    const res = await handler(mkEv({ doc_type: 'certification_doc', s3_key: CERT_KEY, file_name: 'cert.pdf', file_size: 1, mime_type: 'application/pdf', cert_name: 'OSHA 30' }));

    expect(res.statusCode).toBe(409);
    expect(JSON.parse(res.body).error).toBe('certification_document_name_limit');
    const calls = mockQuery.mock.calls.map(c => c[0]);
    expect(calls.some((c: string) => c.includes('INSERT INTO worker_documents'))).toBe(false);
  });

  it('maps a 23505 unique violation on insert (pre-075 race) to 409 certification_document_limit', async () => {
    mockS3Send.mockResolvedValueOnce(validHead);
    mockQuery.mockImplementation((q: string) => {
      if (q.includes('SELECT id FROM users')) return Promise.resolve({ rows: [{ id: 'u1' }] });
      if (q.includes('cert_name IS NOT DISTINCT FROM')) return Promise.resolve({ rows: [{ count: 1 }] });
      if (q.includes('SELECT COUNT')) return Promise.resolve({ rows: [{ count: 4 }] });
      if (q.includes('INSERT INTO worker_documents')) {
        const err: any = new Error('duplicate key value violates unique constraint');
        err.code = '23505';
        return Promise.reject(err);
      }
      return Promise.resolve({});
    });

    const res = await handler(mkEv({ doc_type: 'certification_doc', s3_key: CERT_KEY, file_name: 'cert.pdf', file_size: 1, mime_type: 'application/pdf', cert_name: 'OSHA 30' }));

    expect(res.statusCode).toBe(409);
    expect(JSON.parse(res.body).error).toBe('certification_document_limit');
    const calls = mockQuery.mock.calls.map(c => c[0]);
    expect(calls).toContain('ROLLBACK');
  });

  it('maps a 23514 check-violation from the certification_document_limit trigger (post-075) to 409', async () => {
    mockS3Send.mockResolvedValueOnce(validHead);
    mockQuery.mockImplementation((q: string) => {
      if (q.includes('SELECT id FROM users')) return Promise.resolve({ rows: [{ id: 'u1' }] });
      if (q.includes('cert_name IS NOT DISTINCT FROM')) return Promise.resolve({ rows: [{ count: 1 }] });
      if (q.includes('SELECT COUNT')) return Promise.resolve({ rows: [{ count: 3 }] });
      if (q.includes('INSERT INTO worker_documents')) {
        const err: any = new Error('new row violates check constraint "certification_document_limit"');
        err.code = '23514';
        err.constraint = 'certification_document_limit';
        return Promise.reject(err);
      }
      return Promise.resolve({});
    });

    const res = await handler(mkEv({ doc_type: 'certification_doc', s3_key: CERT_KEY, file_name: 'cert.pdf', file_size: 1, mime_type: 'application/pdf', cert_name: 'OSHA 30' }));

    expect(res.statusCode).toBe(409);
    expect(JSON.parse(res.body).error).toBe('certification_document_limit');
  });

  it('maps a 23514 check-violation from the certification_document_name_limit trigger (078, TOCTOU backstop) to 409', async () => {
    mockS3Send.mockResolvedValueOnce(validHead);
    mockQuery.mockImplementation((q: string) => {
      if (q.includes('SELECT id FROM users')) return Promise.resolve({ rows: [{ id: 'u1' }] });
      if (q.includes('cert_name IS NOT DISTINCT FROM')) return Promise.resolve({ rows: [{ count: 2 }] });
      if (q.includes('SELECT COUNT')) return Promise.resolve({ rows: [{ count: 3 }] });
      if (q.includes('INSERT INTO worker_documents')) {
        const err: any = new Error('new row violates check constraint "certification_document_name_limit"');
        err.code = '23514';
        err.constraint = 'certification_document_name_limit';
        return Promise.reject(err);
      }
      return Promise.resolve({});
    });

    const res = await handler(mkEv({ doc_type: 'certification_doc', s3_key: CERT_KEY, file_name: 'cert.pdf', file_size: 1, mime_type: 'application/pdf', cert_name: 'OSHA 30' }));

    expect(res.statusCode).toBe(409);
    expect(JSON.parse(res.body).error).toBe('certification_document_name_limit');
  });

  // ---------------------------------------------------------------------------
  // No transaction is held open across the S3 object check
  // ---------------------------------------------------------------------------

  describe('no transaction is open while S3 is called', () => {
    /** Records transaction control and the S3 call in the order they happen. */
    function recordTimeline(head: 'valid' | 'wrong_type' | 'missing'): string[] {
      const timeline: string[] = [];
      mockQuery.mockImplementation((q: string) => {
        const statement = q.trim().toUpperCase();
        if (statement === 'BEGIN' || statement === 'COMMIT' || statement === 'ROLLBACK') timeline.push(statement);
        if (q.includes('SELECT id FROM users')) return Promise.resolve({ rows: [{ id: 'u1' }] });
        if (q.includes('INSERT INTO worker_documents')) return Promise.resolve({ rows: [{ id: 'd1', doc_type: 'resume' }] });
        return Promise.resolve({});
      });
      mockS3Send.mockImplementationOnce(async () => {
        timeline.push('S3');
        if (head === 'missing') throw Object.assign(new Error('NotFound'), { name: 'NotFound' });
        return head === 'valid' ? validHead : { ...validHead, ContentType: 'image/png' };
      });
      return timeline;
    }

    function transactionOpenAtS3(timeline: string[]): boolean {
      let open = false;
      for (const step of timeline) {
        if (step === 'S3') return open;
        open = step === 'BEGIN' ? true : (step === 'COMMIT' || step === 'ROLLBACK') ? false : open;
      }
      throw new Error('S3 was never called');
    }

    const body = { doc_type: 'resume', s3_key: OWN_KEY, file_name: 'f', file_size: 1, mime_type: 'application/pdf' };

    it('on a successful confirm: the caller check commits before S3, and the write runs in a new transaction after it', async () => {
      const timeline = recordTimeline('valid');
      const res = await handler(mkEv(body));
      expect(res.statusCode).toBe(201);
      expect(transactionOpenAtS3(timeline)).toBe(false);
      expect(timeline).toEqual(['BEGIN', 'COMMIT', 'S3', 'BEGIN', 'COMMIT']);
      // The write transaction carries the worker's internal id.
      expect(mockSetInternalUserRlsContext).toHaveBeenCalledWith(expect.anything(), 'u1');
    });

    it('when the object does not match (400 invalid_upload), with nothing left open', async () => {
      const timeline = recordTimeline('wrong_type');
      const res = await handler(mkEv(body));
      expect(res.statusCode).toBe(400);
      expect(JSON.parse(res.body)).toEqual({ error: 'invalid_upload' });
      expect(transactionOpenAtS3(timeline)).toBe(false);
      expect(timeline).toEqual(['BEGIN', 'COMMIT', 'S3']);
    });

    it('when the object is missing (400 uploaded_object_not_found), with nothing left open', async () => {
      jest.spyOn(console, 'error').mockImplementation(() => {});
      const timeline = recordTimeline('missing');
      const res = await handler(mkEv(body));
      expect(res.statusCode).toBe(400);
      expect(JSON.parse(res.body)).toEqual({ error: 'uploaded_object_not_found' });
      expect(transactionOpenAtS3(timeline)).toBe(false);
      expect(timeline).toEqual(['BEGIN', 'COMMIT', 'S3']);
    });

    it('a key outside the caller\'s prefix is still refused (403) before any S3 call', async () => {
      const timeline = recordTimeline('valid');
      const res = await handler(mkEv({ ...body, s3_key: 'documents/vault/someone-else/resume/uuid.pdf' }));
      expect(res.statusCode).toBe(403);
      expect(timeline).toEqual(['BEGIN', 'COMMIT']);
      expect(mockS3Send).not.toHaveBeenCalled();
    });
  });

  // Sprint 28: the documents bucket is versioned, and the job-scoped copies
  // an application keeps carry this row's s3_version_id. Recording the
  // version the upload created is what lets the employer's link name the
  // exact bytes the worker sent.
  describe('object version', () => {
    const insertParams = () => mockQuery.mock.calls
      .find(([q]) => typeof q === 'string' && q.includes('INSERT INTO worker_documents'))![1] as unknown[];
    const insertSql = () => String(mockQuery.mock.calls
      .find(([q]) => typeof q === 'string' && q.includes('INSERT INTO worker_documents'))![0]);

    beforeEach(() => {
      // clearAllMocks keeps queued one-off answers, and an earlier case that
      // refuses before reaching S3 leaves one behind.
      mockS3Send.mockReset();
      mockQuery.mockImplementation((q: string) => {
        if (q.includes('SELECT id FROM users')) return Promise.resolve({ rows: [{ id: 'u1' }] });
        if (q.includes('SELECT COUNT')) return Promise.resolve({ rows: [{ count: 0 }] });
        if (q.includes('DELETE FROM worker_documents')) return Promise.resolve({ rowCount: 0 });
        if (q.includes('INSERT INTO worker_documents')) return Promise.resolve({ rows: [{ id: 'd1' }] });
        return Promise.resolve({});
      });
    });

    it('stores the version HeadObject reports on a single-file upload', async () => {
      mockS3Send.mockResolvedValueOnce({ ...validHead, VersionId: 'version-a' });
      const res = await handler(mkEv({ doc_type: 'resume', s3_key: OWN_KEY, file_name: 'f', file_size: 1, mime_type: 'application/pdf' }));
      expect(res.statusCode).toBe(201);
      expect(insertSql()).toContain('s3_version_id');
      expect(insertParams()).toContain('version-a');
    });

    it('stores the version HeadObject reports on a certificate upload', async () => {
      mockS3Send.mockResolvedValueOnce({ ...validHead, VersionId: 'version-b' });
      const res = await handler(mkEv({ doc_type: 'certification_doc', s3_key: CERT_KEY, file_name: 'c.pdf', file_size: 1, mime_type: 'application/pdf', cert_name: 'OSHA 10' }));
      expect(res.statusCode).toBe(201);
      expect(insertSql()).toContain('s3_version_id');
      expect(insertParams()).toContain('version-b');
    });

    it('stores NULL when the bucket reports no version', async () => {
      mockS3Send.mockResolvedValueOnce(validHead);
      const res = await handler(mkEv({ doc_type: 'resume', s3_key: OWN_KEY, file_name: 'f', file_size: 1, mime_type: 'application/pdf' }));
      expect(res.statusCode).toBe(201);
      // Map the column to its VALUES placeholder ($n), then to its parameter.
      const [columns, values] = [...insertSql().matchAll(/\(([^)]*)\)/g)].slice(0, 2)
        .map((m) => m[1].split(',').map((c) => c.trim()));
      const placeholder = values[columns.indexOf('s3_version_id')];
      expect(placeholder).toMatch(/^\$\d+$/);
      expect(insertParams()[Number(placeholder.slice(1)) - 1]).toBeNull();
    });
  });

  describe('change context', () => {
    it('states the worker in the transaction that replaces the vault row', async () => {
      mockS3Send.mockResolvedValueOnce(validHead);
      mockQuery.mockImplementation((q: string) => {
        if (q.includes('SELECT id FROM users')) return Promise.resolve({ rows: [{ id: 'u1' }] });
        if (q.includes('DELETE FROM worker_documents')) return Promise.resolve({ rowCount: 1 });
        if (q.includes('INSERT INTO worker_documents')) return Promise.resolve({ rows: [{ id: 'd1', doc_type: 'resume' }] });
        return Promise.resolve({});
      });
      const res = await handler(withRequestId(mkEv({ doc_type: 'resume', s3_key: OWN_KEY, file_name: 'f', file_size: 1, mime_type: 'application/pdf' })));
      expect(res.statusCode).toBe(201);
      expect(setAuditContext).toHaveBeenCalledTimes(1);
      expect(setAuditContext).toHaveBeenCalledWith(expect.objectContaining({ query: mockQuery }), callerFor('worker', 'u1'), 'worker.document_confirm');
      expectContextBeforeWrite(mockQuery, setAuditContext as jest.Mock, /DELETE FROM worker_documents/);
    });
  });
});
