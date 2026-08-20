import type { APIGatewayProxyEvent } from 'aws-lambda';
jest.mock('@aws-sdk/s3-request-presigner', () => ({ getSignedUrl: jest.fn().mockResolvedValue('https://get.example') }));
jest.mock('../../../../lambda/lib/db');
jest.mock('../../../../lambda/legal/check-compliance');
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { handler } from '../../../../lambda/api/worker-documents-list';
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

  it('does not presign urls when RLS returns no vault docs', async () => {
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
});
