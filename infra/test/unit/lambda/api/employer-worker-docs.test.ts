import type { APIGatewayProxyEvent } from 'aws-lambda';
import { handler } from '../../../../lambda/api/employer-worker-docs';
import { getDbPool } from '../../../../lambda/lib/db';
import { checkCompliance } from '../../../../lambda/legal/check-compliance';

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
const mockQuery = jest.fn();
const mockRelease = jest.fn();

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

  const makeEvent = (sub: string, workerId = 'w1', jobId = 'j1') =>
    ({
      requestContext: { authorizer: { claims: { sub } } },
      pathParameters: { worker_id: workerId },
      queryStringParameters: { job_id: jobId },
    }) as unknown as APIGatewayProxyEvent;

  it('returns 403 if employer does not own the job', async () => {
    mockQuery.mockResolvedValueOnce({}).mockResolvedValue({ rows: [] });
    const res = await handler(makeEvent('emp-sub'));
    expect(res.statusCode).toBe(403);
  });

  it('returns 200 with presigned GET URLs for each uploaded document', async () => {
    mockQuery
      .mockResolvedValueOnce({}) // BEGIN
      .mockResolvedValueOnce({ rows: [{ id: 'j1' }] }) // job ownership
      .mockResolvedValueOnce({
        rows: [
          {
            doc_type: 'resume',
            s3_key: 'documents/j1/w1/resume/uuid.pdf',
            file_name: 'resume.pdf',
            file_size: 1024,
            uploaded_at: new Date().toISOString(),
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
    expect(mockRelease).toHaveBeenCalled();
  });
});
