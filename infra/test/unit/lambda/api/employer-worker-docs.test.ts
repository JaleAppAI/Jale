import type { APIGatewayProxyEvent } from 'aws-lambda';
import { handler } from '../../../../lambda/api/employer-worker-docs';
import { getDbPool } from '../../../../lambda/lib/db';
import { checkCompliance } from '../../../../lambda/legal/check-compliance';
import { GetObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

jest.mock('../../../../lambda/lib/db');
jest.mock('../../../../lambda/legal/check-compliance');
jest.mock('@aws-sdk/client-s3', () => ({
  S3Client: jest.fn().mockImplementation(() => ({})),
  GetObjectCommand: jest.fn().mockImplementation((input) => ({ input })),
}));
jest.mock('@aws-sdk/s3-request-presigner', () => ({
  getSignedUrl: jest.fn().mockResolvedValue('https://s3.example.com/presigned-get'),
}));

const mockGetDbPool = getDbPool as jest.Mock;
const mockCheckCompliance = checkCompliance as jest.Mock;
const mockGetSignedUrl = getSignedUrl as jest.Mock;
const mockQuery = jest.fn();
const mockRelease = jest.fn();
const workerId = '11111111-1111-4111-8111-111111111111';
const jobId = '22222222-2222-4222-8222-222222222222';

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
    mockQuery.mockResolvedValueOnce({}).mockResolvedValue({ rows: [] });
    const res = await handler(makeEvent('emp-sub'));

    expect(res.statusCode).toBe(403);
    expect(mockGetSignedUrl).not.toHaveBeenCalled();
    expect(GetObjectCommand).not.toHaveBeenCalled();
    const queries = mockQuery.mock.calls.map(([q]) => String(q));
    expect(queries.some((q) => q.includes('FROM job_applications ja'))).toBe(true);
    expect(queries.some((q) => q.includes('FROM worker_documents'))).toBe(false);
  });

  it('returns 200 with presigned GET URLs for each uploaded document', async () => {
    mockQuery
      .mockResolvedValueOnce({}) // BEGIN
      .mockResolvedValueOnce({ rows: [{ '?column?': 1 }] }) // applicant relationship
      .mockResolvedValueOnce({
        rows: [
          {
            doc_type: 'resume',
            s3_key: 'documents/j1/w1/resume/uuid.pdf',
            file_name: 'resume.pdf',
            file_size: 1024,
            uploaded_at: new Date().toISOString(),
            s3_version_id: 'version-1',
            cert_name: null,
          },
        ],
      }) // docs query
      .mockResolvedValueOnce({}); // COMMIT

    const res = await handler(makeEvent('emp-sub'));
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.documents).toHaveLength(1);
    expect(body.documents[0].url).toBe('https://s3.example.com/presigned-get');
    expect(body.documents[0].doc_type).toBe('resume');
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
    expect(mockRelease).toHaveBeenCalled();
  });

  it('surfaces cert_name to the employer for a labeled certification_doc snapshot (additive response field)', async () => {
    mockQuery
      .mockResolvedValueOnce({}) // BEGIN
      .mockResolvedValueOnce({ rows: [{ '?column?': 1 }] }) // applicant relationship
      .mockResolvedValueOnce({
        rows: [
          {
            doc_type: 'certification_doc',
            s3_key: 'documents/j1/w1/certification_doc/uuid.pdf',
            file_name: 'osha30.pdf',
            file_size: 2048,
            uploaded_at: new Date().toISOString(),
            s3_version_id: null,
            cert_name: 'OSHA 30',
          },
        ],
      }) // docs query
      .mockResolvedValueOnce({}); // COMMIT

    const res = await handler(makeEvent('emp-sub'));
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.documents[0].cert_name).toBe('OSHA 30');
  });
});
