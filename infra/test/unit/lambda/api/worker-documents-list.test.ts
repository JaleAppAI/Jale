import type { APIGatewayProxyEvent } from 'aws-lambda';
jest.mock('@aws-sdk/s3-request-presigner', () => ({ getSignedUrl: jest.fn().mockResolvedValue('https://get.example') }));
jest.mock('../../../../lambda/lib/db');
jest.mock('../../../../lambda/legal/check-compliance');
jest.mock('../../../../lambda/lib/audit/record', () => ({
  ...jest.requireActual('../../../../lambda/lib/audit/record'),
  recordAccess: jest.fn(),
  recordAttempt: jest.fn(),
}));
jest.mock('../../../../lambda/lib/audit/context');
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { DOCUMENT_LINK_TTL_SECONDS, handler } from '../../../../lambda/api/worker-documents-list';
import { recordAccess, recordAttempt } from '../../../../lambda/lib/audit/record';
import {
  callerFor, expectAttemptAfter, expectRecordedInsideTransaction, queryOrder, withRequestId,
} from './audit-expectations';
import { getDbPool, setInternalUserRlsContext, setRlsContext } from '../../../../lambda/lib/db';
import { checkCompliance } from '../../../../lambda/legal/check-compliance';

const mockGetDbPool = getDbPool as jest.Mock;
const mockSetRlsContext = setRlsContext as jest.Mock;
const mockSetInternalUserRlsContext = setInternalUserRlsContext as jest.Mock;
const mockCheckCompliance = checkCompliance as jest.Mock;
const mockGetSignedUrl = getSignedUrl as jest.Mock;
const mockQuery = jest.fn();
const mockRelease = jest.fn();

const ev = { requestContext: { authorizer: { claims: { sub: 'w' } } } } as unknown as APIGatewayProxyEvent;

describe('worker-documents-list', () => {
  const env = process.env;
  beforeEach(() => {
    jest.clearAllMocks();
    process.env = { ...env, REQUIRED_TOS_VERSION: 'v1.0', DOCUMENTS_BUCKET: 'b' };
    mockGetDbPool.mockResolvedValue({ connect: jest.fn().mockResolvedValue({ query: mockQuery, release: mockRelease }) });
    mockCheckCompliance.mockResolvedValue({ compliant: true, userExists: true });
  });
  afterAll(() => { process.env = env; });

  it('returns vault docs with presigned urls, including id and cert_name (WK-T0 backend gap fix)', async () => {
    mockQuery.mockImplementation((q: string) => {
      if (q.includes('SELECT id FROM users')) return Promise.resolve({ rows: [{ id: 'u1' }] });
      if (q.includes('FROM worker_documents')) return Promise.resolve({ rows: [{ id: 'doc-1', doc_type: 'certification_doc', s3_key: 'k', file_name: 'f.pdf', file_size: 10, uploaded_at: 'ts', cert_name: 'OSHA 30' }] });
      return Promise.resolve({});
    });
    const res = await handler(ev);
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.documents[0].url).toBe('https://get.example');
    // The bug this fixes: the SELECT previously omitted `id` entirely, so the
    // frontend's WorkerVaultDoc.id (used to build cert-proof doc_ids) would
    // serialize as undefined/null for every vault doc.
    expect(body.documents[0].id).toBe('doc-1');
    expect(body.documents[0].cert_name).toBe('OSHA 30');
    expect(mockSetRlsContext).toHaveBeenCalledWith(expect.anything(), 'w');
    expect(mockSetInternalUserRlsContext).toHaveBeenCalledWith(expect.anything(), 'u1');
    expect(mockQuery).not.toHaveBeenCalledWith(
      `SELECT set_config('app.current_user_id', $1, true)`,
      ['u1'],
    );
    const listSql = mockQuery.mock.calls.find(([q]) => typeof q === 'string' && q.includes('FROM worker_documents'))?.[0] as string;
    expect(listSql).toContain('id');
    expect(listSql).toContain('cert_name');
  });

  it('never ships the raw s3_key to the browser, but still presigns from it', async () => {
    // `s3_key` has to stay in the SELECT -- it is the only thing the presign
    // can key off -- but it is an internal bucket layout the worker's browser
    // has no use for. The presigned `url` is the whole contract. Same rule the
    // employer side already follows (see frontend/src/lib/api/employer.ts).
    mockQuery.mockImplementation((q: string) => {
      if (q.includes('SELECT id FROM users')) return Promise.resolve({ rows: [{ id: 'u1' }] });
      if (q.includes('FROM worker_documents')) return Promise.resolve({ rows: [{ id: 'doc-1', doc_type: 'work_auth_doc', s3_key: 'workers/u1/secret-layout.pdf', file_name: 'f.pdf', file_size: 10, uploaded_at: 'ts', cert_name: null }] });
      return Promise.resolve({});
    });

    const res = await handler(ev);

    expect(res.statusCode).toBe(200);
    expect(res.body).not.toContain('secret-layout.pdf');
    const body = JSON.parse(res.body);
    expect(body.documents[0]).not.toHaveProperty('s3_key');
    // Everything the browser does need survived the strip.
    expect(body.documents[0]).toEqual({
      id: 'doc-1',
      doc_type: 'work_auth_doc',
      file_name: 'f.pdf',
      file_size: 10,
      uploaded_at: 'ts',
      cert_name: null,
      url: 'https://get.example',
    });
    // The key still reached the presigner -- stripping it from the response
    // must not break the only reason it is selected.
    expect(mockGetSignedUrl).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(mockGetSignedUrl.mock.calls[0][1])).toContain('workers/u1/secret-layout.pdf');
  });

  it('lists a legacy certification_doc row with cert_name NULL fine (no label supplied is not an error)', async () => {
    mockQuery.mockImplementation((q: string) => {
      if (q.includes('SELECT id FROM users')) return Promise.resolve({ rows: [{ id: 'u1' }] });
      if (q.includes('FROM worker_documents')) return Promise.resolve({ rows: [{ id: 'doc-legacy', doc_type: 'certification_doc', s3_key: 'k', file_name: 'legacy.pdf', file_size: 10, uploaded_at: 'ts', cert_name: null }] });
      return Promise.resolve({});
    });
    const res = await handler(ev);
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.documents[0].id).toBe('doc-legacy');
    expect(body.documents[0].cert_name).toBeNull();
  });

  it('does not presign urls when the query returns no vault docs', async () => {
    mockQuery.mockImplementation((q: string) => {
      if (q.includes('SELECT id FROM users')) return Promise.resolve({ rows: [{ id: 'u1' }] });
      if (q.includes('FROM worker_documents')) return Promise.resolve({ rows: [] });
      return Promise.resolve({});
    });

    const res = await handler(ev);

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).documents).toEqual([]);
    expect(mockSetInternalUserRlsContext).toHaveBeenCalledWith(expect.anything(), 'u1');
    expect(mockGetSignedUrl).not.toHaveBeenCalled();
  });

  describe('access record', () => {
    const mockRecordAccess = recordAccess as jest.Mock;
    const mockRecordAttempt = recordAttempt as jest.Mock;
    const worker = callerFor('worker', 'u1');
    const client = expect.objectContaining({ query: mockQuery });
    const now = Date.parse('2026-10-05T12:00:00.000Z');
    let nowSpy: jest.SpyInstance;
    const docRow = { id: 'doc-1', doc_type: 'resume', s3_key: 'k', file_name: 'f.pdf', file_size: 10, uploaded_at: 'ts', cert_name: null };

    beforeEach(() => {
      mockRecordAccess.mockResolvedValue(undefined);
      mockRecordAttempt.mockResolvedValue(undefined);
      mockGetSignedUrl.mockResolvedValue('https://get.example');
      nowSpy = jest.spyOn(Date, 'now').mockReturnValue(now);
      mockQuery.mockImplementation((q: string) => {
        if (q.includes('SELECT id FROM users')) return Promise.resolve({ rows: [{ id: 'u1' }] });
        if (q.includes('FROM worker_documents')) return Promise.resolve({ rows: [docRow] });
        return Promise.resolve({});
      });
    });
    afterEach(() => nowSpy.mockRestore());

    it('records the worker reading their own vault before COMMIT, with the link expiry', async () => {
      const res = await handler(withRequestId(ev));
      expect(res.statusCode).toBe(200);
      const { documents } = JSON.parse(res.body);
      expect(mockRecordAccess).toHaveBeenCalledWith(client, worker, {
        surface: 'worker.vault',
        subjectUserIds: ['u1'],
        recordIds: ['doc-1'],
        resultCount: 1,
        fieldNames: Object.keys(documents[0]).sort(),
        purpose: { kind: 'self' },
        linkExpiresAt: new Date(now + DOCUMENT_LINK_TTL_SECONDS * 1000),
      });
      expectRecordedInsideTransaction(mockQuery, mockRecordAccess, /FROM worker_documents/);
      expect(DOCUMENT_LINK_TTL_SECONDS).toBe(900);
      expect(mockGetSignedUrl).toHaveBeenCalledWith(expect.anything(), expect.anything(), { expiresIn: DOCUMENT_LINK_TTL_SECONDS });
      expect(mockGetSignedUrl.mock.invocationCallOrder[0]).toBeGreaterThan(queryOrder(mockQuery, 'COMMIT'));
    });

    it('answers 500 with no documents and signs nothing when the record cannot be written', async () => {
      mockRecordAccess.mockRejectedValue(new Error('audit'));
      const res = await handler(withRequestId(ev));
      expect(res.statusCode).toBe(500);
      expect(JSON.parse(res.body)).toEqual({ error: 'internal_error' });
      expect(mockGetSignedUrl).not.toHaveBeenCalled();
      expectAttemptAfter(mockQuery, mockRecordAttempt, 'ROLLBACK');
      expect(mockRecordAttempt).toHaveBeenCalledWith(client, worker, {
        surface: 'worker.vault', outcome: 'failed', subjectUserIds: ['u1'], purpose: { kind: 'self' },
      });
    });

    it('records nothing before the worker is known (a 404 for no users row)', async () => {
      mockQuery.mockImplementation(() => Promise.resolve({ rows: [] }));
      const res = await handler(withRequestId(ev));
      expect(res.statusCode).toBe(404);
      expect(mockRecordAccess).not.toHaveBeenCalled();
      expect(mockRecordAttempt).not.toHaveBeenCalled();
    });
  });
});
