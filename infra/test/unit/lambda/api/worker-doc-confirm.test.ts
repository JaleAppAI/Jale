import type { APIGatewayProxyEvent } from 'aws-lambda';
import { handler } from '../../../../lambda/api/worker-doc-confirm';
import { getDbPool } from '../../../../lambda/lib/db';

jest.mock('../../../../lambda/lib/db');

const mockGetDbPool = getDbPool as jest.Mock;
const mockQuery = jest.fn();
const mockRelease = jest.fn();

describe('worker-doc-confirm Lambda', () => {
  beforeEach(() => {
    jest.clearAllMocks();
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

  it('returns 400 if required fields are missing', async () => {
    const res = await handler(makeEvent({ token: 'abc' }));
    expect(res.statusCode).toBe(400);
  });

  it('returns 401 if token is invalid or expired', async () => {
    mockQuery.mockResolvedValueOnce({}).mockResolvedValue({ rows: [] });
    const res = await handler(makeEvent(validBody));
    expect(res.statusCode).toBe(401);
    expect(JSON.parse(res.body).error).toBe('invalid_token');
  });

  it('returns 200 and inserts worker_documents row on valid token', async () => {
    mockQuery
      .mockResolvedValueOnce({}) // BEGIN
      .mockResolvedValueOnce({ rows: [{ worker_id: 'worker-1', job_id: 'job-1' }] })
      .mockResolvedValueOnce({}) // set_config RLS
      .mockResolvedValueOnce({ rows: [{ id: 'doc-uuid' }] }) // INSERT
      .mockResolvedValueOnce({}); // COMMIT

    const res = await handler(makeEvent(validBody));
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ success: true });
    expect(mockQuery).toHaveBeenCalledWith('COMMIT');
    expect(mockRelease).toHaveBeenCalled();
  });

  it('returns 500 and rolls back on DB error', async () => {
    mockQuery
      .mockResolvedValueOnce({}) // BEGIN
      .mockRejectedValue(new Error('DB down'));

    const res = await handler(makeEvent(validBody));
    expect(res.statusCode).toBe(500);
    expect(mockQuery).toHaveBeenCalledWith('ROLLBACK');
    expect(mockRelease).toHaveBeenCalled();
  });
});
