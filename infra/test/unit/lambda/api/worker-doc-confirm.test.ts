import type { APIGatewayProxyEvent } from 'aws-lambda';
import { handler } from '../../../../lambda/api/worker-doc-confirm';
import { getDbPool } from '../../../../lambda/lib/db';
import { S3Client } from '@aws-sdk/client-s3';
import { MAX_CERTIFICATION_FILES, MAX_CERTIFICATION_FILES_PER_NAME } from '../../../../lambda/lib/job-fields';

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

  it('accepts work_auth_doc as a valid doc_type (rejects with invalid_or_confirmed_upload only for lack of a matching slot)', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });
    const res = await handler(makeEvent({ ...validBody, doc_type: 'work_auth_doc' }));
    // No `valid` field on this handler's invalid_doc_type response (preserved
    // shape) -- work_auth_doc must pass validation and reach the slot lookup,
    // which then legitimately 409s because no slot mock was set up for it.
    expect(res.statusCode).toBe(409);
    expect(JSON.parse(res.body).error).toBe('invalid_or_confirmed_upload');
  });

  it('rejects a bogus doc_type with invalid_doc_type and no `valid` field (response shape preserved)', async () => {
    const res = await handler(makeEvent({ ...validBody, doc_type: 'passport' }));
    expect(res.statusCode).toBe(400);
    const parsed = JSON.parse(res.body);
    expect(parsed.error).toBe('invalid_doc_type');
    expect(parsed.valid).toBeUndefined();
  });

  it('rejects a cert_name on a non-certification doc_type with invalid_cert_name, without querying the DB', async () => {
    const res = await handler(makeEvent({ ...validBody, cert_name: 'OSHA 30' }));
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).error).toBe('invalid_cert_name');
    expect(mockQuery).not.toHaveBeenCalled();
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

  it('returns 200, validates the token without marking it used, deletes then inserts the replacement row (non-cert replace semantics)', async () => {
    mockS3Send.mockResolvedValueOnce(headResult);
    mockQuery
      .mockResolvedValueOnce({ rows: [slotRow] }) // slot lookup
      .mockResolvedValueOnce({}) // BEGIN
      .mockResolvedValueOnce({}) // set_config RLS
      .mockResolvedValueOnce({ rows: [slotRow] }) // guarded confirm SELECT
      .mockResolvedValueOnce({ rowCount: 1 }) // DELETE existing row
      .mockResolvedValueOnce({ rows: [{ id: 'doc-uuid' }] }) // INSERT
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
    const atomicSql = mockQuery.mock.calls.find(([sql]) =>
      typeof sql === 'string' && sql.includes('WITH valid_token AS')
    )?.[0] as string;
    expect(atomicSql).toBeDefined();
    // Confirming a slot must only validate the token, never mutate `used` --
    // that would burn the token for every other still-pending document slot.
    expect(atomicSql).not.toContain('SET used = true');
    expect(atomicSql).not.toContain('used_at');
    expect(atomicSql).not.toMatch(/UPDATE\s+document_upload_tokens/);
    expect(atomicSql).toContain('token.used = false');
    expect(atomicSql).toContain('token.expires_at > now()');
    expect(atomicSql).toContain('slots.issued_s3_key = $3');
    expect(atomicSql).toContain('slots.expected_mime_type = $4');
    expect(atomicSql).toContain('slots.confirmed_at IS NULL');
    expect(atomicSql).toContain('SET confirmed_at = now()');
    // The old single-statement ON CONFLICT upsert is gone: confirming the slot
    // and writing worker_documents are now separate statements, since an
    // ON CONFLICT arbiter's WHERE clause must match an index predicate
    // exactly -- 075_worker_documents_multi_certification.sql narrows that
    // predicate to exclude certification_doc, which would otherwise break
    // inference for every doc type, not just certifications.
    expect(atomicSql).not.toContain('INSERT INTO worker_documents');
    expect(atomicSql).not.toContain('ON CONFLICT');

    const deleteSql = mockQuery.mock.calls.find(([sql]) =>
      typeof sql === 'string' && sql.includes('DELETE FROM worker_documents')
    )?.[0] as string;
    const insertSql = mockQuery.mock.calls.find(([sql]) =>
      typeof sql === 'string' && sql.includes('INSERT INTO worker_documents')
    )?.[0] as string;
    expect(deleteSql).toBeDefined();
    expect(insertSql).toBeDefined();
    // Delete must precede insert (replace semantics), and must scope on the
    // per-job triple, not the vault (job_id IS NULL) triple.
    const deleteIdx = mockQuery.mock.calls.findIndex(([sql]) => sql === deleteSql);
    const insertIdx = mockQuery.mock.calls.findIndex(([sql]) => sql === insertSql);
    expect(deleteIdx).toBeLessThan(insertIdx);
    expect(deleteSql).toContain('job_id = $2');
    expect(deleteSql).toContain('doc_type = $3');

    expect(mockQuery).toHaveBeenCalledWith('COMMIT');
    expect(mockRelease).toHaveBeenCalled();
  });

  it('replaces an existing per-job document on a second upload of the same doc_type (single row, no ON CONFLICT)', async () => {
    // Regression test for the replace-semantics requirement: a second confirm
    // of the same (worker, job, doc_type) must DELETE the old row before
    // INSERTing the new one -- never rely on an ON CONFLICT arbiter, which
    // breaks once 075 narrows the per-job unique index's predicate.
    mockS3Send.mockResolvedValueOnce(headResult);
    mockQuery
      .mockResolvedValueOnce({ rows: [slotRow] }) // slot lookup
      .mockResolvedValueOnce({}) // BEGIN
      .mockResolvedValueOnce({}) // set_config RLS
      .mockResolvedValueOnce({ rows: [slotRow] }) // guarded confirm SELECT
      .mockResolvedValueOnce({ rowCount: 1 }) // DELETE existing row (the first upload)
      .mockResolvedValueOnce({ rows: [{ id: 'doc-uuid-2' }] }) // INSERT the replacement
      .mockResolvedValueOnce({}); // COMMIT

    const res = await handler(makeEvent({ ...validBody, file_name: 'resume-v2.pdf' }));

    expect(res.statusCode).toBe(200);
    const calls = mockQuery.mock.calls.map(([sql]) => sql as string);
    expect(calls.filter((sql) => sql.includes('DELETE FROM worker_documents'))).toHaveLength(1);
    expect(calls.filter((sql) => sql.includes('INSERT INTO worker_documents'))).toHaveLength(1);
  });

  it('allows confirming a second document slot on the same still-unused token', async () => {
    // Regression test for the multi-document upload bug: one token covers
    // multiple doc-type slots, and the frontend confirms them sequentially
    // on the same token. Confirming the first slot must not burn the token,
    // so the second slot's confirm succeeds (200) instead of failing the
    // `token.used = false` guard with a 409.
    const secondBody = {
      ...validBody,
      doc_type: 'driver_license',
      s3_key: 'documents/job-1/worker-1/driver_license/uuid2.pdf',
      file_name: 'license.pdf',
    };
    const secondSlotRow = {
      ...slotRow,
      doc_type: 'driver_license',
      issued_s3_key: 'documents/job-1/worker-1/driver_license/uuid2.pdf',
    };

    // First confirm (resume slot).
    mockS3Send.mockResolvedValueOnce(headResult);
    mockQuery
      .mockResolvedValueOnce({ rows: [slotRow] }) // slot lookup
      .mockResolvedValueOnce({}) // BEGIN
      .mockResolvedValueOnce({}) // set_config RLS
      .mockResolvedValueOnce({ rows: [slotRow] }) // guarded confirm SELECT
      .mockResolvedValueOnce({ rowCount: 0 }) // DELETE (no prior row)
      .mockResolvedValueOnce({ rows: [{ id: 'doc-uuid-1' }] }) // INSERT
      .mockResolvedValueOnce({}); // COMMIT

    const firstRes = await handler(makeEvent(validBody));
    expect(firstRes.statusCode).toBe(200);

    // Second confirm (driver_license slot) on the SAME token. The slot
    // lookup still finds `token.used = false` because the fixed
    // implementation never mutated it above.
    mockS3Send.mockResolvedValueOnce(headResult);
    mockQuery
      .mockResolvedValueOnce({ rows: [secondSlotRow] }) // slot lookup
      .mockResolvedValueOnce({}) // BEGIN
      .mockResolvedValueOnce({}) // set_config RLS
      .mockResolvedValueOnce({ rows: [secondSlotRow] }) // guarded confirm SELECT
      .mockResolvedValueOnce({ rowCount: 0 }) // DELETE (no prior row)
      .mockResolvedValueOnce({ rows: [{ id: 'doc-uuid-2' }] }) // INSERT
      .mockResolvedValueOnce({}); // COMMIT

    const secondRes = await handler(makeEvent(secondBody));

    expect(secondRes.statusCode).toBe(200);
    expect(JSON.parse(secondRes.body)).toEqual({ success: true });

    const allAtomicSql = mockQuery.mock.calls
      .filter(([sql]) => typeof sql === 'string' && sql.includes('valid_token'))
      .map(([sql]) => sql as string);
    expect(allAtomicSql).toHaveLength(2);
    for (const sql of allAtomicSql) {
      expect(sql).not.toContain('SET used = true');
    }
  });

  it('returns 409 without inserting when a race confirms the slot before the guarded write', async () => {
    mockS3Send.mockResolvedValueOnce(headResult);
    mockQuery
      .mockResolvedValueOnce({ rows: [slotRow] }) // slot lookup
      .mockResolvedValueOnce({}) // BEGIN
      .mockResolvedValueOnce({}) // set_config RLS
      .mockResolvedValueOnce({ rows: [] }) // guarded confirm SELECT loses the race
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
      .mockRejectedValueOnce(new Error('DB down')) // guarded confirm SELECT
      .mockResolvedValueOnce({}); // ROLLBACK

    const res = await handler(makeEvent(validBody));

    expect(res.statusCode).toBe(500);
    expect(mockQuery).toHaveBeenCalledWith('ROLLBACK');
    expect(mockRelease).toHaveBeenCalled();
  });

  it('maps a 23505 on the non-cert INSERT (concurrent confirms of two slots for one doc_type) to 409 document_conflict', async () => {
    // Two independently-issued tokens can each carry a slot for the same
    // (worker, job, doc_type); confirming both concurrently races the
    // DELETE-then-INSERT and the loser hits worker_documents_per_job_unique.
    mockS3Send.mockResolvedValueOnce(headResult);
    mockQuery
      .mockResolvedValueOnce({ rows: [slotRow] }) // slot lookup
      .mockResolvedValueOnce({}) // BEGIN
      .mockResolvedValueOnce({}) // set_config RLS
      .mockResolvedValueOnce({ rows: [slotRow] }) // guarded confirm SELECT
      .mockResolvedValueOnce({ rowCount: 0 }) // DELETE (concurrent txn's row not yet visible)
      .mockImplementationOnce(() => {
        const err: any = new Error('duplicate key value violates unique constraint');
        err.code = '23505';
        return Promise.reject(err);
      }) // INSERT loses the race
      .mockResolvedValueOnce({}); // ROLLBACK

    const res = await handler(makeEvent(validBody));

    expect(res.statusCode).toBe(409);
    expect(JSON.parse(res.body).error).toBe('document_conflict');
    expect(mockQuery).toHaveBeenCalledWith('ROLLBACK');
  });

  describe('certification_doc (append, capped)', () => {
    const certBody = {
      ...validBody,
      doc_type: 'certification_doc',
      s3_key: 'documents/job-1/worker-1/certification_doc/uuid.pdf',
      file_name: 'cert.pdf',
      cert_name: 'OSHA 30',
    };
    const certSlotRow = {
      ...slotRow,
      doc_type: 'certification_doc',
      issued_s3_key: 'documents/job-1/worker-1/certification_doc/uuid.pdf',
    };

    it('returns 400 missing_cert_name when cert_name is omitted, without querying the DB', async () => {
      const { cert_name, ...bodyWithoutCertName } = certBody;
      const res = await handler(makeEvent(bodyWithoutCertName));
      expect(res.statusCode).toBe(400);
      expect(JSON.parse(res.body).error).toBe('missing_cert_name');
      expect(mockQuery).not.toHaveBeenCalled();
    });

    it('returns 400 invalid_cert_name when cert_name exceeds 200 chars, without querying the DB', async () => {
      const res = await handler(makeEvent({ ...certBody, cert_name: 'a'.repeat(201) }));
      expect(res.statusCode).toBe(400);
      expect(JSON.parse(res.body).error).toBe('invalid_cert_name');
      expect(mockQuery).not.toHaveBeenCalled();
    });

    it('inserts without deleting existing rows when under both caps, writing the trimmed cert_name', async () => {
      mockS3Send.mockResolvedValueOnce(headResult);
      mockQuery
        .mockResolvedValueOnce({ rows: [certSlotRow] }) // slot lookup
        .mockResolvedValueOnce({}) // BEGIN
        .mockResolvedValueOnce({}) // set_config RLS
        .mockResolvedValueOnce({ rows: [{ count: 2 }] }) // total cap count check
        .mockResolvedValueOnce({ rows: [{ count: 1 }] }) // per-name cap count check
        .mockResolvedValueOnce({ rows: [certSlotRow] }) // guarded confirm SELECT
        .mockResolvedValueOnce({ rows: [{ id: 'cert-uuid' }] }) // INSERT (no DELETE)
        .mockResolvedValueOnce({}); // COMMIT

      const res = await handler(makeEvent({ ...certBody, cert_name: '  OSHA 30  ' }));

      expect(res.statusCode).toBe(200);
      const calls = mockQuery.mock.calls.map(([sql]) => sql as string);
      expect(calls.some((sql) => sql.includes('DELETE FROM worker_documents'))).toBe(false);
      // Both pre-checks must fire exactly once each -- a miscount here would
      // silently mean one of the two COUNT queries never ran.
      expect(calls.filter((sql) => sql.includes('SELECT COUNT')).length).toBe(2);
      const insertCall = mockQuery.mock.calls.find(([sql]) => typeof sql === 'string' && sql.includes('INSERT INTO worker_documents'));
      expect(insertCall).toBeDefined();
      expect(insertCall![0]).toContain('cert_name');
      expect(insertCall![1]).toContain('OSHA 30'); // trimmed before persisting
    });

    it('returns 409 certification_document_limit at the total cap, without touching the slot or checking per-name', async () => {
      mockS3Send.mockResolvedValueOnce(headResult);
      mockQuery
        .mockResolvedValueOnce({ rows: [certSlotRow] }) // slot lookup
        .mockResolvedValueOnce({}) // BEGIN
        .mockResolvedValueOnce({}) // set_config RLS
        // BE-T3 (078) raised MAX_CERTIFICATION_FILES from 5 to 20 -- the cap
        // check below is keyed off the constant, not a hardcoded number.
        .mockResolvedValueOnce({ rows: [{ count: MAX_CERTIFICATION_FILES }] }) // total cap count check -- at cap
        .mockResolvedValueOnce({}); // ROLLBACK

      const res = await handler(makeEvent(certBody));

      expect(res.statusCode).toBe(409);
      expect(JSON.parse(res.body).error).toBe('certification_document_limit');
      const calls = mockQuery.mock.calls.map(([sql]) => sql as string);
      // The slot-confirming guarded UPDATE must never run -- a cap rejection
      // must not burn the (single-use) upload slot. The per-name pre-check
      // must not run either -- the total cap short-circuits first.
      expect(calls.filter((sql) => sql.includes('SELECT COUNT')).length).toBe(1);
      expect(calls.some((sql) => sql.includes('WITH valid_token AS'))).toBe(false);
      expect(calls.some((sql) => sql.includes('INSERT INTO worker_documents'))).toBe(false);
      expect(mockQuery).toHaveBeenCalledWith('ROLLBACK');
    });

    it('returns 409 certification_document_name_limit at the per-name cap, without touching the slot', async () => {
      mockS3Send.mockResolvedValueOnce(headResult);
      mockQuery
        .mockResolvedValueOnce({ rows: [certSlotRow] }) // slot lookup
        .mockResolvedValueOnce({}) // BEGIN
        .mockResolvedValueOnce({}) // set_config RLS
        .mockResolvedValueOnce({ rows: [{ count: 10 }] }) // total cap count check -- well under 20
        // BE-T3 (078) per-name cap stays 5 even though the total cap is now
        // 20 -- see 078's header REACHABILITY section.
        .mockResolvedValueOnce({ rows: [{ count: MAX_CERTIFICATION_FILES_PER_NAME }] }) // per-name cap count check -- at cap
        .mockResolvedValueOnce({}); // ROLLBACK

      const res = await handler(makeEvent(certBody));

      expect(res.statusCode).toBe(409);
      expect(JSON.parse(res.body).error).toBe('certification_document_name_limit');
      const calls = mockQuery.mock.calls.map(([sql]) => sql as string);
      expect(calls.filter((sql) => sql.includes('SELECT COUNT')).length).toBe(2);
      expect(calls.some((sql) => sql.includes('WITH valid_token AS'))).toBe(false);
      expect(calls.some((sql) => sql.includes('INSERT INTO worker_documents'))).toBe(false);
      expect(mockQuery).toHaveBeenCalledWith('ROLLBACK');
    });

    it('maps a 23505 unique violation on insert (pre-075 race) to 409 certification_document_limit', async () => {
      mockS3Send.mockResolvedValueOnce(headResult);
      mockQuery
        .mockResolvedValueOnce({ rows: [certSlotRow] }) // slot lookup
        .mockResolvedValueOnce({}) // BEGIN
        .mockResolvedValueOnce({}) // set_config RLS
        .mockResolvedValueOnce({ rows: [{ count: 4 }] }) // total cap count check -- under cap
        .mockResolvedValueOnce({ rows: [{ count: 1 }] }) // per-name cap count check -- under cap
        .mockResolvedValueOnce({ rows: [certSlotRow] }) // guarded confirm SELECT
        .mockImplementationOnce(() => {
          const err: any = new Error('duplicate key value violates unique constraint');
          err.code = '23505';
          return Promise.reject(err);
        }) // INSERT races into a duplicate
        .mockResolvedValueOnce({}); // ROLLBACK

      const res = await handler(makeEvent(certBody));

      expect(res.statusCode).toBe(409);
      expect(JSON.parse(res.body).error).toBe('certification_document_limit');
      expect(mockQuery).toHaveBeenCalledWith('ROLLBACK');
    });

    it('maps a 23514 check-violation from the certification_document_limit trigger (post-075) to 409', async () => {
      mockS3Send.mockResolvedValueOnce(headResult);
      mockQuery
        .mockResolvedValueOnce({ rows: [certSlotRow] }) // slot lookup
        .mockResolvedValueOnce({}) // BEGIN
        .mockResolvedValueOnce({}) // set_config RLS
        .mockResolvedValueOnce({ rows: [{ count: 4 }] }) // total cap count check -- under cap
        .mockResolvedValueOnce({ rows: [{ count: 1 }] }) // per-name cap count check -- under cap
        .mockResolvedValueOnce({ rows: [certSlotRow] }) // guarded confirm SELECT
        .mockImplementationOnce(() => {
          const err: any = new Error('new row violates check constraint "certification_document_limit"');
          err.code = '23514';
          err.constraint = 'certification_document_limit';
          return Promise.reject(err);
        }) // INSERT hits the post-075 DB trigger
        .mockResolvedValueOnce({}); // ROLLBACK

      const res = await handler(makeEvent(certBody));

      expect(res.statusCode).toBe(409);
      expect(JSON.parse(res.body).error).toBe('certification_document_limit');
      expect(mockQuery).toHaveBeenCalledWith('ROLLBACK');
    });

    it('maps a 23514 check-violation from the certification_document_name_limit trigger (078, TOCTOU backstop) to 409', async () => {
      mockS3Send.mockResolvedValueOnce(headResult);
      mockQuery
        .mockResolvedValueOnce({ rows: [certSlotRow] }) // slot lookup
        .mockResolvedValueOnce({}) // BEGIN
        .mockResolvedValueOnce({}) // set_config RLS
        .mockResolvedValueOnce({ rows: [{ count: 10 }] }) // total cap count check -- under cap
        .mockResolvedValueOnce({ rows: [{ count: 2 }] }) // per-name cap count check -- under cap (raced)
        .mockResolvedValueOnce({ rows: [certSlotRow] }) // guarded confirm SELECT
        .mockImplementationOnce(() => {
          const err: any = new Error('new row violates check constraint "certification_document_name_limit"');
          err.code = '23514';
          err.constraint = 'certification_document_name_limit';
          return Promise.reject(err);
        }) // INSERT hits the 078 DB trigger's per-name cap
        .mockResolvedValueOnce({}); // ROLLBACK

      const res = await handler(makeEvent(certBody));

      expect(res.statusCode).toBe(409);
      expect(JSON.parse(res.body).error).toBe('certification_document_name_limit');
      expect(mockQuery).toHaveBeenCalledWith('ROLLBACK');
    });
  });
});
