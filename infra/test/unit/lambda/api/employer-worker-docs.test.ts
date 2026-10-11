import type { APIGatewayProxyEvent } from 'aws-lambda';
import { DOCUMENT_LINK_TTL_SECONDS, handler } from '../../../../lambda/api/employer-worker-docs';
import { getDbPool, setInternalUserRlsContext, setRlsContext } from '../../../../lambda/lib/db';
import { checkCompliance } from '../../../../lambda/legal/check-compliance';
import { GetObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

import { recordAccess, recordAttempt } from '../../../../lambda/lib/audit/record';
import {
  callerFor, expectAttemptAfter, expectRecordedInsideTransaction, queryOrder, withRequestId,
} from './audit-expectations';

jest.mock('../../../../lambda/lib/db');
jest.mock('../../../../lambda/legal/check-compliance');
jest.mock('../../../../lambda/lib/audit/record', () => ({
  ...jest.requireActual('../../../../lambda/lib/audit/record'),
  recordAccess: jest.fn(),
  recordAttempt: jest.fn(),
}));
jest.mock('../../../../lambda/lib/audit/context');
jest.mock('@aws-sdk/client-s3', () => ({
  S3Client: jest.fn().mockImplementation(() => ({})),
  GetObjectCommand: jest.fn().mockImplementation((input) => ({ input })),
}));
jest.mock('@aws-sdk/s3-request-presigner', () => ({
  getSignedUrl: jest.fn().mockResolvedValue('https://s3.example.com/presigned-get'),
}));

const mockGetDbPool = getDbPool as jest.Mock;
const mockSetRlsContext = setRlsContext as jest.Mock;
const mockSetInternalUserRlsContext = setInternalUserRlsContext as jest.Mock;
const mockCheckCompliance = checkCompliance as jest.Mock;
const mockGetSignedUrl = getSignedUrl as jest.Mock;
const mockRecordAccess = recordAccess as jest.Mock;
const mockRecordAttempt = recordAttempt as jest.Mock;
const mockQuery = jest.fn();
const mockRelease = jest.fn();
const workerId = '11111111-1111-4111-8111-111111111111';
const jobId = '22222222-2222-4222-8222-222222222222';

/**
 * Query-text-dispatching mock, matching `employer-worker-profile.test.ts`.
 * The handler gained an employer-id resolution query (the internal-user RLS
 * lane), and a positional `mockResolvedValueOnce` chain silently mis-assigns
 * every stub after an inserted query.
 */
type QueryStubs = {
  employer?: unknown;
  applicant?: unknown;
  documents?: unknown;
};

function setupMockQuery(overrides: QueryStubs = {}) {
  const {
    employer = { rows: [{ id: 'employer-id' }] },
    applicant = { rows: [{ '?column?': 1 }] },
    documents = { rows: [] },
  } = overrides;

  mockQuery.mockImplementation((text: string) => {
    const t = String(text);
    if (t.includes('FROM users WHERE cognito_sub')) return Promise.resolve(employer);
    if (t.includes('FROM worker_documents wd')) return Promise.resolve(documents);
    if (t.includes('FROM job_applications ja')) return Promise.resolve(applicant);
    return Promise.resolve({});
  });
}

const resumeRow = {
  id: 'doc-1',
  doc_type: 'resume',
  s3_key: 'documents/j1/w1/resume/uuid.pdf',
  file_name: 'resume.pdf',
  file_size: 1024,
  uploaded_at: '2026-08-20T00:00:00.000Z',
  s3_version_id: 'version-1',
  cert_name: null,
};

describe('employer-worker-docs Lambda', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    process.env.REQUIRED_TOS_VERSION = 'v1.0';
    process.env.DOCUMENTS_BUCKET = 'test-bucket';
    process.env.ALLOWED_ORIGIN = 'https://jaleapp.ai';
    mockGetDbPool.mockResolvedValue({
      connect: jest.fn().mockResolvedValue({ query: mockQuery, release: mockRelease }),
    });
    mockCheckCompliance.mockResolvedValue({ compliant: true, userExists: true });
    mockSetRlsContext.mockResolvedValue(undefined);
    mockSetInternalUserRlsContext.mockResolvedValue(undefined);
  });

  const makeEvent = (sub: string, requestedWorkerId = workerId, requestedJobId = jobId) =>
    ({
      requestContext: { authorizer: { claims: { sub } } },
      pathParameters: { worker_id: requestedWorkerId },
      queryStringParameters: { job_id: requestedJobId },
    }) as unknown as APIGatewayProxyEvent;

  it('returns 400 for malformed UUID params', async () => {
    const res = await handler(makeEvent('emp-sub', 'w1', 'j1'));

    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).error).toBe('invalid_params');
    expect(mockGetDbPool).not.toHaveBeenCalled();
  });

  it('returns 403 if the worker is not an applicant for the employer job', async () => {
    setupMockQuery({ applicant: { rows: [] } });
    const res = await handler(makeEvent('emp-sub'));

    expect(res.statusCode).toBe(403);
    expect(mockGetSignedUrl).not.toHaveBeenCalled();
    expect(GetObjectCommand).not.toHaveBeenCalled();
    const queries = mockQuery.mock.calls.map(([q]) => String(q));
    expect(queries.some((q) => q.includes('FROM job_applications ja'))).toBe(true);
    expect(queries.some((q) => q.includes('FROM worker_documents'))).toBe(false);
  });

  it('returns 409 when the caller has no users row to bind the internal lane to', async () => {
    setupMockQuery({ employer: { rows: [] } });
    const res = await handler(makeEvent('emp-sub'));

    expect(res.statusCode).toBe(409);
    expect(JSON.parse(res.body).error).toBe('user_not_provisioned');
    expect(mockSetInternalUserRlsContext).not.toHaveBeenCalled();
  });

  it('binds BOTH RLS lanes: the sub-keyed one the doc policy uses, then the internal-id one', async () => {
    // `worker_documents_employer_select` (018) resolves the employer through
    // `current_setting('app.current_user_id')`, so the sub lane must stay
    // bound. `setInternalUserRlsContext` writes a DIFFERENT GUC
    // (`app.current_internal_user_id`) and never clears the first -- it is
    // purely additive, and it must carry the EMPLOYER's id, never the
    // worker's, or the worker-self policies elsewhere would match instead.
    setupMockQuery({ documents: { rows: [resumeRow] } });
    await handler(makeEvent('emp-sub'));

    expect(mockSetRlsContext).toHaveBeenCalledWith(expect.anything(), 'emp-sub');
    expect(mockSetInternalUserRlsContext).toHaveBeenCalledWith(expect.anything(), 'employer-id');
    const rlsOrder = mockSetRlsContext.mock.invocationCallOrder[0];
    const internalOrder = mockSetInternalUserRlsContext.mock.invocationCallOrder[0];
    expect(rlsOrder).toBeLessThan(internalOrder);
  });

  it('returns 200 with presigned GET URLs for each uploaded document', async () => {
    setupMockQuery({ documents: { rows: [resumeRow] } });

    const res = await handler(makeEvent('emp-sub'));
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.documents).toHaveLength(1);
    expect(body.documents[0].url).toBe('https://s3.example.com/presigned-get');
    expect(body.documents[0].doc_type).toBe('resume');
    expect(body.documents[0].id).toBe('doc-1');
    expect(GetObjectCommand).toHaveBeenCalledWith({
      Bucket: 'test-bucket',
      Key: 'documents/j1/w1/resume/uuid.pdf',
      VersionId: 'version-1',
    });
    const queries = mockQuery.mock.calls.map(([q]) => String(q));
    expect(queries.some((q) => q.includes('FROM job_applications ja'))).toBe(true);
    expect(queries.some((q) => q.includes('JOIN job_applications ja ON ja.worker_id = wd.worker_id'))).toBe(true);
    expect(queries.some((q) => q.includes('JOIN jobs j ON j.id = ja.job_id'))).toBe(true);
    expect(queries.some((q) => q.includes('JOIN users employer ON employer.id = j.employer_id'))).toBe(true);
    const docsSql = queries.find((q) => q.includes('FROM worker_documents wd'));
    expect(docsSql).toContain('cert_name');
    // `id` is the stable React key for the multi-file certification slot,
    // which can hold several rows of the same doc_type.
    expect(docsSql).toContain('id');
    expect(mockRelease).toHaveBeenCalled();
  });

  it('never puts the raw S3 key (or its version id) on the wire', async () => {
    // The bucket is private and every read is a server-minted presigned URL;
    // the key is an internal storage address the browser has no use for, and
    // it names the worker/job it belongs to.
    setupMockQuery({ documents: { rows: [resumeRow] } });

    const res = await handler(makeEvent('emp-sub'));
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.documents[0]).not.toHaveProperty('s3_key');
    expect(body.documents[0]).not.toHaveProperty('s3_version_id');
    expect(res.body).not.toContain('documents/j1/w1/resume/uuid.pdf');
    // Still selected in SQL -- it is what the presigner signs.
    const docsSql = mockQuery.mock.calls
      .map(([q]) => String(q))
      .find((q) => q.includes('FROM worker_documents wd'));
    expect(docsSql).toContain('s3_key');
    // ...and the version pin still reaches S3, so an employer keeps seeing the
    // exact bytes the worker uploaded rather than a later overwrite.
    expect(GetObjectCommand).toHaveBeenCalledWith(
      expect.objectContaining({ VersionId: 'version-1' }),
    );
  });

  it('surfaces cert_name to the employer for a labeled certification_doc snapshot (additive response field)', async () => {
    setupMockQuery({
      documents: {
        rows: [
          {
            id: 'doc-2',
            doc_type: 'certification_doc',
            s3_key: 'documents/j1/w1/certification_doc/uuid.pdf',
            file_name: 'osha30.pdf',
            file_size: 2048,
            uploaded_at: '2026-08-20T00:00:00.000Z',
            s3_version_id: null,
            cert_name: 'OSHA 30',
          },
        ],
      },
    });

    const res = await handler(makeEvent('emp-sub'));
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.documents[0].cert_name).toBe('OSHA 30');
  });
  it('never mints a presigned URL for a retired ssn document', async () => {
    // No surface renders `ssn` any more, so a row that reaches the response is
    // pure exposure: unlike the `s3_key` removed above -- inert against a
    // private bucket -- a presigned GET is directly fetchable for 15 minutes
    // by anyone who reads the payload. Asserting `getSignedUrl` ran exactly
    // once is what proves the card was never signed, not merely omitted after.
    setupMockQuery({
      documents: {
        rows: [
          resumeRow,
          {
            id: 'doc-ssn',
            doc_type: 'ssn',
            s3_key: 'documents/j1/w1/ssn/uuid.pdf',
            file_name: 'social-security-card.pdf',
            file_size: 512,
            uploaded_at: '2026-08-20T00:00:00.000Z',
            s3_version_id: null,
            cert_name: null,
          },
        ],
      },
    });

    const res = await handler(makeEvent('emp-sub'));
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.documents).toHaveLength(1);
    expect(body.documents[0].doc_type).toBe('resume');
    expect(res.body).not.toContain('social-security-card.pdf');
    expect(mockGetSignedUrl).toHaveBeenCalledTimes(1);
    expect(GetObjectCommand).toHaveBeenCalledTimes(1);
  });

  describe('access record', () => {
    const employer = callerFor('employer', 'employer-id');
    const client = expect.objectContaining({ query: mockQuery });
    const event = () => withRequestId({
      requestContext: { authorizer: { claims: { sub: 'employer-sub' } } },
      pathParameters: { worker_id: workerId },
      queryStringParameters: { job_id: jobId },
    } as unknown as APIGatewayProxyEvent);
    const ssnRow = { ...resumeRow, id: 'doc-ssn', doc_type: 'ssn', s3_key: 'documents/j1/w1/ssn/uuid.pdf' };
    const now = Date.parse('2026-10-05T12:00:00.000Z');
    let nowSpy: jest.SpyInstance;

    beforeEach(() => {
      mockRecordAccess.mockResolvedValue(undefined);
      mockRecordAttempt.mockResolvedValue(undefined);
      mockGetSignedUrl.mockResolvedValue('https://s3.example.com/presigned-get');
      nowSpy = jest.spyOn(Date, 'now').mockReturnValue(now);
    });
    afterEach(() => nowSpy.mockRestore());

    it('records the documents it will sign, after the legacy-slot filter and before COMMIT', async () => {
      setupMockQuery({ documents: { rows: [resumeRow, ssnRow] } });
      const res = await handler(event());
      expect(res.statusCode).toBe(200);
      const { documents } = JSON.parse(res.body);
      expect(documents.map((d: { id: string }) => d.id)).toEqual(['doc-1']);
      expect(mockRecordAccess).toHaveBeenCalledTimes(1);
      expect(mockRecordAccess).toHaveBeenCalledWith(client, employer, {
        surface: 'employer.worker_documents',
        subjectUserIds: [workerId],
        recordIds: ['doc-1'],
        resultCount: 1,
        fieldNames: Object.keys(documents[0]).sort(),
        purpose: { kind: 'job', id: jobId },
        linkExpiresAt: new Date(now + DOCUMENT_LINK_TTL_SECONDS * 1000),
      });
      expectRecordedInsideTransaction(mockQuery, mockRecordAccess, /FROM worker_documents wd/);
    });

    it('signs after COMMIT, with the same lifetime the record states', async () => {
      setupMockQuery({ documents: { rows: [resumeRow] } });
      await handler(event());
      expect(DOCUMENT_LINK_TTL_SECONDS).toBe(900);
      expect(mockGetSignedUrl).toHaveBeenCalledWith(expect.anything(), expect.anything(), { expiresIn: DOCUMENT_LINK_TTL_SECONDS });
      expect(mockGetSignedUrl.mock.invocationCallOrder[0]).toBeGreaterThan(queryOrder(mockQuery, 'COMMIT'));
    });

    it('answers 500 with no documents and signs nothing when the record cannot be written', async () => {
      setupMockQuery({ documents: { rows: [resumeRow] } });
      mockRecordAccess.mockRejectedValue(new Error('audit: the access record could not be written'));
      const res = await handler(event());
      expect(res.statusCode).toBe(500);
      expect(JSON.parse(res.body)).toEqual({ error: 'internal_error' });
      expect(mockGetSignedUrl).not.toHaveBeenCalled();
      expect(mockQuery.mock.calls.some(([q]) => q === 'COMMIT')).toBe(false);
      expectAttemptAfter(mockQuery, mockRecordAttempt, 'ROLLBACK');
      expect(mockRecordAttempt.mock.calls[0][2]).toEqual({
        surface: 'employer.worker_documents',
        outcome: 'failed',
        subjectUserIds: [workerId],
        purpose: { kind: 'job', id: jobId },
      });
    });

    it('records a denied attempt after the 403 commits', async () => {
      setupMockQuery({ applicant: { rows: [] } });
      const res = await handler(event());
      expect(res.statusCode).toBe(403);
      expect(mockRecordAccess).not.toHaveBeenCalled();
      expectAttemptAfter(mockQuery, mockRecordAttempt, 'COMMIT');
      expect(mockRecordAttempt).toHaveBeenCalledWith(client, employer, {
        surface: 'employer.worker_documents',
        outcome: 'denied',
        subjectUserIds: [workerId],
        purpose: { kind: 'job', id: jobId },
      });
    });

    it('records a failed attempt when signing fails after the read committed', async () => {
      setupMockQuery({ documents: { rows: [resumeRow] } });
      mockGetSignedUrl.mockRejectedValue(new Error('signing failed'));
      const res = await handler(event());
      expect(res.statusCode).toBe(500);
      expect(mockRecordAccess).toHaveBeenCalledTimes(1);
      expect(mockRecordAttempt.mock.calls[0][2]).toMatchObject({ outcome: 'failed' });
    });
  });
});
