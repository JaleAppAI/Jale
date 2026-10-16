import type { APIGatewayProxyEvent } from 'aws-lambda';
jest.mock('@aws-sdk/client-s3', () => {
  const send = jest.fn().mockResolvedValue({});
  return { S3Client: jest.fn().mockImplementation(() => ({ send })), DeleteObjectCommand: jest.fn().mockImplementation((x) => x), __send: send };
});
jest.mock('../../../../lambda/lib/db');
jest.mock('../../../../lambda/legal/check-compliance');
jest.mock('../../../../lambda/lib/audit/record', () => ({
  ...jest.requireActual('../../../../lambda/lib/audit/record'),
  recordAccess: jest.fn(),
  recordAttempt: jest.fn(),
}));
jest.mock('../../../../lambda/lib/audit/context');
import { handler } from '../../../../lambda/api/worker-doc-delete';
import { getDbPool, setInternalUserRlsContext, setRlsContext } from '../../../../lambda/lib/db';
import { checkCompliance } from '../../../../lambda/legal/check-compliance';
import { setAuditContext } from '../../../../lambda/lib/audit/context';
import { callerFor, expectContextBeforeWrite, withRequestId } from './audit-expectations';

const mockGetDbPool = getDbPool as jest.Mock;
const mockSetRlsContext = setRlsContext as jest.Mock;
const mockSetInternalUserRlsContext = setInternalUserRlsContext as jest.Mock;
const mockCheckCompliance = checkCompliance as jest.Mock;
const mockQuery = jest.fn();
const mockRelease = jest.fn();
const mockS3Send = (jest.requireMock('@aws-sdk/client-s3') as { __send: jest.Mock }).__send;

const DOC_ID = '0b6f3c2a-4d5e-4f60-8a71-92b3c4d5e6f7';
const OTHER_DOC_ID = '1c7a4d3b-5e6f-4a71-9b82-a3c4d5e6f708';
const LEGACY_DOC_ID = '2d8b5e4c-6f70-4b82-8c93-b4d5e6f70819';
const LICENSE_DOC_ID = '3e9c6f5d-7081-4c93-9da4-c5e6f708192a';

const mkEv = (doc_type: string, id?: string) => ({
  requestContext: { authorizer: { claims: { sub: 'w' } } },
  pathParameters: { doc_type },
  queryStringParameters: id ? { id } : null,
} as unknown as APIGatewayProxyEvent);

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

  it('deletes only the row matching id and the route\'s document type when id is provided, scoped to job_id IS NULL', async () => {
    mockQuery.mockImplementation((q: string) => {
      if (q.includes('SELECT id FROM users')) return Promise.resolve({ rows: [{ id: 'u1' }] });
      if (q.includes('DELETE FROM worker_documents')) return Promise.resolve({ rowCount: 1, rows: [{ s3_key: 'k' }] });
      return Promise.resolve({});
    });
    const res = await handler(mkEv('certification_doc', DOC_ID));
    expect(res.statusCode).toBe(204);
    const deleteCall = mockQuery.mock.calls.find(([q]) => String(q).includes('DELETE FROM worker_documents'));
    expect(deleteCall).toBeDefined();
    const [deleteSql, deleteParams] = deleteCall as [string, unknown[]];
    expect(deleteSql).toContain('id = $2');
    expect(deleteSql).toContain('doc_type = $3');
    expect(deleteSql).toContain('job_id IS NULL');
    expect(deleteParams).toEqual(['u1', DOC_ID, 'certification_doc']);
  });

  it('an id of another document type on this route deletes nothing: 404, and the row and its object stay', async () => {
    // The caller's own driver_license row, addressed by its id through the
    // resume route. The fake applies each predicate the statement states.
    const vault = [{ id: LICENSE_DOC_ID, worker_id: 'u1', doc_type: 'driver_license', job_id: null as string | null, s3_key: 'k-license' }];
    mockQuery.mockImplementation((q: string, params: unknown[] = []) => {
      if (q.includes('SELECT id FROM users')) return Promise.resolve({ rows: [{ id: 'u1' }] });
      if (q.includes('DELETE FROM worker_documents')) {
        const bound = (column: string) => {
          const m = new RegExp(`\\b${column} = \\$(\\d+)`).exec(q);
          return m ? params[Number(m[1]) - 1] : undefined;
        };
        const hits = vault.filter((r) => r.worker_id === bound('worker_id') && r.job_id === null
          && (bound('id') === undefined || r.id === bound('id'))
          && (bound('doc_type') === undefined || r.doc_type === bound('doc_type')));
        for (const hit of hits) vault.splice(vault.indexOf(hit), 1);
        return Promise.resolve({ rowCount: hits.length, rows: hits.map((r) => ({ s3_key: r.s3_key })) });
      }
      return Promise.resolve({});
    });
    const res = await handler(mkEv('resume', LICENSE_DOC_ID));
    expect(res.statusCode).toBe(404);
    expect(JSON.parse(res.body).error).toBe('not_found');
    expect(vault.map((r) => r.id)).toEqual([LICENSE_DOC_ID]);
    expect(mockS3Send).not.toHaveBeenCalled();
  });

  it('rejects an id that is not a UUID with 400, before any database access', async () => {
    const res = await handler(mkEv('certification_doc', 'doc-123'));
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).error).toBe('invalid_document_id');
    expect(mockGetDbPool).not.toHaveBeenCalled();
    expect(mockS3Send).not.toHaveBeenCalled();
  });

  it('returns 404 when id is provided but does not match a row (foreign or missing id)', async () => {
    mockQuery.mockImplementation((q: string) => {
      if (q.includes('SELECT id FROM users')) return Promise.resolve({ rows: [{ id: 'u1' }] });
      if (q.includes('DELETE FROM worker_documents')) return Promise.resolve({ rowCount: 0, rows: [] });
      return Promise.resolve({});
    });
    const res = await handler(mkEv('certification_doc', OTHER_DOC_ID));
    expect(res.statusCode).toBe(404);
    expect(JSON.parse(res.body).error).toBe('not_found');
  });

  it('deletes a legacy certification_doc row with cert_name NULL by id fine (delete is cert_name-agnostic)', async () => {
    // BE-T3 regression coverage: cert_name is nullable (078) and this lambda's
    // DELETE never references the column at all, so a pre-078 row (cert_name
    // NULL) must delete exactly like a labeled one.
    mockQuery.mockImplementation((q: string) => {
      if (q.includes('SELECT id FROM users')) return Promise.resolve({ rows: [{ id: 'u1' }] });
      if (q.includes('DELETE FROM worker_documents')) return Promise.resolve({ rowCount: 1, rows: [{ s3_key: 'k' }] });
      return Promise.resolve({});
    });
    const res = await handler(mkEv('certification_doc', LEGACY_DOC_ID));
    expect(res.statusCode).toBe(204);
    const deleteCall = mockQuery.mock.calls.find(([q]) => String(q).includes('DELETE FROM worker_documents'));
    const [deleteSql, deleteParams] = deleteCall as [string, unknown[]];
    expect(deleteSql).not.toContain('cert_name');
    expect(deleteParams).toEqual(['u1', LEGACY_DOC_ID, 'certification_doc']);
  });

  it('without id, preserves the existing type-wide vault delete behavior unchanged', async () => {
    mockQuery.mockImplementation((q: string) => {
      if (q.includes('SELECT id FROM users')) return Promise.resolve({ rows: [{ id: 'u1' }] });
      if (q.includes('DELETE FROM worker_documents')) return Promise.resolve({ rowCount: 1, rows: [{ s3_key: 'k' }] });
      return Promise.resolve({});
    });
    const res = await handler(mkEv('resume'));
    expect(res.statusCode).toBe(204);
    const deleteCall = mockQuery.mock.calls.find(([q]) => String(q).includes('DELETE FROM worker_documents'));
    const [deleteSql, deleteParams] = deleteCall as [string, unknown[]];
    expect(deleteSql).toContain('doc_type = $2');
    expect(deleteParams).toEqual(['u1', 'resume']);
  });

  // Sprint 28: an application's documents are job-scoped copies that share
  // the vault row's s3_key. The object stays while any row still names it.
  describe('shared S3 object', () => {
    const REFERENCE = /SELECT EXISTS \(SELECT 1 FROM worker_documents WHERE worker_id = \$1 AND s3_key = \$2\)/;

    function stub(referenced: boolean) {
      mockQuery.mockImplementation((q: string) => {
        if (q.includes('SELECT id FROM users')) return Promise.resolve({ rows: [{ id: 'u1' }] });
        if (q.includes('DELETE FROM worker_documents')) return Promise.resolve({ rowCount: 1, rows: [{ s3_key: 'k-shared' }] });
        if (REFERENCE.test(q)) return Promise.resolve({ rows: [{ referenced }] });
        return Promise.resolve({});
      });
    }

    it('keeps the object while another row (an application\'s copy) still references the key', async () => {
      stub(true);
      const res = await handler(mkEv('certification_doc', DOC_ID));
      expect(res.statusCode).toBe(204);
      expect(mockS3Send).not.toHaveBeenCalled();
      const check = mockQuery.mock.calls.find(([q]) => REFERENCE.test(String(q)));
      expect(check?.[1]).toEqual(['u1', 'k-shared']);
    });

    it('deletes the object once no row references the key', async () => {
      stub(false);
      const res = await handler(mkEv('resume'));
      expect(res.statusCode).toBe(204);
      expect(mockS3Send).toHaveBeenCalledTimes(1);
      expect(mockS3Send.mock.calls[0][0]).toEqual({ Bucket: 'b', Key: 'k-shared' });
    });

    it('checks the references inside the transaction, after the row is deleted and before COMMIT', async () => {
      stub(true);
      await handler(mkEv('resume'));
      const sql = mockQuery.mock.calls.map(([q]) => String(q));
      const iDelete = sql.findIndex((q) => q.includes('DELETE FROM worker_documents'));
      const iCheck = sql.findIndex((q) => REFERENCE.test(q));
      const iCommit = sql.lastIndexOf('COMMIT');
      expect(iDelete).toBeGreaterThan(-1);
      expect(iCheck).toBeGreaterThan(iDelete);
      expect(iCommit).toBeGreaterThan(iCheck);
    });
  });

  describe('change context', () => {
    it('states the worker before the vault row is deleted', async () => {
      mockQuery.mockImplementation((q: string) => {
        if (q.includes('SELECT id FROM users')) return Promise.resolve({ rows: [{ id: 'u1' }] });
        if (q.includes('DELETE FROM worker_documents')) return Promise.resolve({ rowCount: 1, rows: [{ s3_key: 'k' }] });
        return Promise.resolve({});
      });
      const res = await handler(withRequestId(mkEv('resume')));
      expect(res.statusCode).toBe(204);
      expect(setAuditContext).toHaveBeenCalledTimes(1);
      expect(setAuditContext).toHaveBeenCalledWith(expect.objectContaining({ query: mockQuery }), callerFor('worker', 'u1'), 'worker.document_delete');
      expectContextBeforeWrite(mockQuery, setAuditContext as jest.Mock, /DELETE FROM worker_documents/);
    });
  });
});
