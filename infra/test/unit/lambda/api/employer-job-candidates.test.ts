import type { APIGatewayProxyEvent } from 'aws-lambda';
import { SendMessageCommand, SQSClient } from '@aws-sdk/client-sqs';
import { handler } from '../../../../lambda/api/employer-job-candidates';
import { getDbPool, setRlsContext } from '../../../../lambda/lib/db';
import { listEmployerCandidates } from '../../../../lambda/lib/employer-candidate-ranking';
import { checkCompliance } from '../../../../lambda/legal/check-compliance';

jest.mock('@aws-sdk/client-sqs');
jest.mock('../../../../lambda/lib/db');
jest.mock('../../../../lambda/lib/employer-candidate-ranking');
jest.mock('../../../../lambda/legal/check-compliance');

const mockGetDbPool = getDbPool as jest.Mock;
const mockSetRlsContext = setRlsContext as jest.Mock;
const mockListEmployerCandidates = listEmployerCandidates as jest.Mock;
const mockCheckCompliance = checkCompliance as jest.Mock;
const mockQuery = jest.fn();
const mockRelease = jest.fn();
const mockSqsSend = jest.fn();

const makeEvent = (overrides: Partial<APIGatewayProxyEvent> = {}) => ({
  requestContext: { authorizer: { claims: { sub: 'employer-sub' } } },
  pathParameters: { jobId: 'job-uuid' },
  queryStringParameters: null,
  ...overrides,
} as unknown as APIGatewayProxyEvent);

describe('employer-job-candidates Lambda', () => {
  beforeEach(() => {
    jest.resetAllMocks();
    (SQSClient as jest.Mock).mockImplementation(() => ({ send: mockSqsSend }));
    process.env.REQUIRED_TOS_VERSION = 'v1.0';
    process.env.EMPLOYER_CANDIDATE_RERANK_QUEUE_URL = 'https://sqs.example/rerank';
    mockGetDbPool.mockResolvedValue({
      connect: jest.fn().mockResolvedValue({ query: mockQuery, release: mockRelease }),
    });
    mockSetRlsContext.mockResolvedValue(undefined);
    mockCheckCompliance.mockResolvedValue({ compliant: true, userExists: true });
    mockListEmployerCandidates.mockResolvedValue({
      sourceHash: 'hash-1',
      shouldEnqueueRerank: false,
      response: {
        ranking_status: 'deterministic',
        ranking_version: 'sql-v1',
        candidates: [],
        total: 0,
        computed_at: '2026-05-15T00:00:00.000Z',
      },
    });
    mockSqsSend.mockResolvedValue({});
  });

  it('returns 401 if Cognito sub is missing', async () => {
    const res = await handler(makeEvent({ requestContext: { authorizer: { claims: {} } } } as any));
    expect(res.statusCode).toBe(401);
  });

  it('returns 400 when jobId is missing', async () => {
    const res = await handler(makeEvent({ pathParameters: {} }));
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).error).toBe('missing_job_id');
  });

  it('returns 403 when RLS ownership check cannot see the job', async () => {
    mockQuery
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({ rows: [], rowCount: 0 })
      .mockResolvedValueOnce({});

    const res = await handler(makeEvent());

    expect(res.statusCode).toBe(403);
    expect(mockListEmployerCandidates).not.toHaveBeenCalled();
  });

  it('returns legal_required when compliance fails', async () => {
    mockCheckCompliance.mockResolvedValue({ compliant: false, userExists: true, currentVersion: '0.9' });
    mockQuery
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({});

    const res = await handler(makeEvent());

    expect(res.statusCode).toBe(403);
    expect(JSON.parse(res.body).error).toBe('legal_required');
  });

  it('returns candidates and enqueues rerank after commit when cache is stale', async () => {
    mockQuery
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({ rows: [{ id: 'job-uuid' }], rowCount: 1 })
      .mockResolvedValueOnce({});
    mockListEmployerCandidates.mockResolvedValue({
      sourceHash: 'hash-1',
      shouldEnqueueRerank: true,
      response: {
        ranking_status: 'deterministic',
        ranking_version: 'sql-v1',
        candidates: [{ worker_id: 'worker-1', match_score: 91 }],
        total: 1,
        computed_at: '2026-05-15T00:00:00.000Z',
      },
    });

    const res = await handler(makeEvent({ queryStringParameters: { limit: '25' } }));

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).ranking_status).toBe('deterministic');
    expect(mockListEmployerCandidates).toHaveBeenCalledWith(expect.any(Object), 'job-uuid', { limit: 25 });
    expect(mockSqsSend).toHaveBeenCalledWith(expect.any(SendMessageCommand));
    expect(mockQuery.mock.calls.map(([q]) => q)).toContain('COMMIT');
  });

  it('does not enqueue rerank when cache is fresh', async () => {
    mockQuery
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({ rows: [{ id: 'job-uuid' }], rowCount: 1 })
      .mockResolvedValueOnce({});
    mockListEmployerCandidates.mockResolvedValue({
      sourceHash: 'hash-1',
      shouldEnqueueRerank: false,
      response: {
        ranking_status: 'llm_cached',
        ranking_version: 'llm-v1',
        candidates: [],
        total: 0,
        computed_at: '2026-05-15T00:00:00.000Z',
      },
    });

    const res = await handler(makeEvent());

    expect(res.statusCode).toBe(200);
    expect(mockSqsSend).not.toHaveBeenCalled();
  });
});
