import type { APIGatewayProxyEvent } from 'aws-lambda';
import { SendMessageCommand, SQSClient } from '@aws-sdk/client-sqs';
import { handler } from '../../../../lambda/api/employer-job-candidates';
import { getDbPool, setRlsContext } from '../../../../lambda/lib/db';
import { listEmployerCandidates } from '../../../../lambda/lib/employer-candidate-ranking';
import { checkCompliance } from '../../../../lambda/legal/check-compliance';

import { recordAccess, recordAttempt } from '../../../../lambda/lib/audit/record';
import { callerFor, expectAttemptAfter, expectRecordedInsideTransaction, withRequestId } from './audit-expectations';

jest.mock('@aws-sdk/client-sqs');
jest.mock('../../../../lambda/lib/db');
jest.mock('../../../../lambda/lib/audit/record', () => ({
  ...jest.requireActual('../../../../lambda/lib/audit/record'),
  recordAccess: jest.fn(),
  recordAttempt: jest.fn(),
}));
jest.mock('../../../../lambda/lib/audit/context');
jest.mock('../../../../lambda/lib/employer-candidate-ranking');
jest.mock('../../../../lambda/legal/check-compliance');

const mockGetDbPool = getDbPool as jest.Mock;
const mockSetRlsContext = setRlsContext as jest.Mock;
const mockListEmployerCandidates = listEmployerCandidates as jest.Mock;
const mockCheckCompliance = checkCompliance as jest.Mock;
const mockQuery = jest.fn();
const mockRelease = jest.fn();
const mockSqsSend = jest.fn();

const JOB_ID = '11111111-1111-4111-8111-111111111111';

const makeEvent = (overrides: Partial<APIGatewayProxyEvent> = {}) => ({
  requestContext: { authorizer: { claims: { sub: 'employer-sub' } } },
  pathParameters: { jobId: JOB_ID },
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

  it('returns 400 when jobId is not a valid UUID', async () => {
    const res = await handler(makeEvent({ pathParameters: { jobId: 'not-a-uuid' } }));
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).error).toBe('invalid_job_id');
  });

  it('returns 403 when the ownership query finds no job', async () => {
    mockQuery
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({ rows: [{ id: 'employer-id' }] })
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
      .mockResolvedValueOnce({ rows: [{ id: 'employer-id' }] })
      .mockResolvedValueOnce({ rows: [{ id: JOB_ID }], rowCount: 1 })
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
    expect(mockListEmployerCandidates).toHaveBeenCalledWith(expect.any(Object), JOB_ID, { limit: 25, includeContact: true });
    expect(mockSqsSend).toHaveBeenCalledWith(expect.any(SendMessageCommand));
    expect(mockQuery.mock.calls.map(([q]) => q)).toContain('COMMIT');
  });

  it('does not enqueue rerank when cache is fresh', async () => {
    mockQuery
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({ rows: [{ id: 'employer-id' }] })
      .mockResolvedValueOnce({ rows: [{ id: JOB_ID }], rowCount: 1 })
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

  describe('access record', () => {
    const mockRecordAccess = recordAccess as jest.Mock;
    const mockRecordAttempt = recordAttempt as jest.Mock;
    const employer = callerFor('employer', 'employer-id');
    const client = expect.objectContaining({ query: mockQuery });
    const ranked = (rankingStatus: string) => ({
      sourceHash: 'hash-1',
      shouldEnqueueRerank: true,
      response: {
        ranking_status: rankingStatus,
        ranking_version: 'sql-v1',
        candidates: [
          { worker_id: 'worker-1', display_name: 'Fixture Name', phone: 'fixture-phone', match_score: 91 },
          { worker_id: 'worker-2', display_name: 'Fixture Name', phone: 'fixture-phone', match_score: 80 },
        ],
        total: 2,
        computed_at: '2026-05-15T00:00:00.000Z',
      },
    });

    function queueOwnedJob(): void {
      mockQuery
        .mockResolvedValueOnce({})
        .mockResolvedValueOnce({ rows: [{ id: 'employer-id' }] })
        .mockResolvedValueOnce({ rows: [{ id: JOB_ID }], rowCount: 1 })
        .mockResolvedValue({});
    }

    it.each(['deterministic', 'llm_cached'])('records the %s ranking it returns, before COMMIT', async (status) => {
      queueOwnedJob();
      mockListEmployerCandidates.mockResolvedValue(ranked(status));
      const res = await handler(withRequestId(makeEvent()));
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(mockRecordAccess).toHaveBeenCalledTimes(1);
      expect(mockRecordAccess).toHaveBeenCalledWith(client, employer, {
        surface: 'employer.job_candidates',
        subjectUserIds: ['worker-1', 'worker-2'],
        recordIds: ['worker-1', 'worker-2'],
        resultCount: 2,
        fieldNames: Object.keys(body.candidates[0]).sort(),
        purpose: { kind: 'job', id: JOB_ID },
      });
      expect(mockRecordAccess.mock.invocationCallOrder[0])
        .toBeGreaterThan(mockListEmployerCandidates.mock.invocationCallOrder[0]);
      expectRecordedInsideTransaction(mockQuery, mockRecordAccess);
    });

    it('answers 500 with no candidates and enqueues nothing when the record cannot be written', async () => {
      queueOwnedJob();
      mockListEmployerCandidates.mockResolvedValue(ranked('deterministic'));
      mockRecordAccess.mockRejectedValue(new Error('audit: the access record could not be written'));
      const res = await handler(withRequestId(makeEvent()));
      expect(res.statusCode).toBe(500);
      expect(JSON.parse(res.body)).toEqual({ error: 'internal_error' });
      expect(mockSqsSend).not.toHaveBeenCalled();
      expectAttemptAfter(mockQuery, mockRecordAttempt, 'ROLLBACK');
      expect(mockRecordAttempt.mock.calls[0][2]).toEqual({
        surface: 'employer.job_candidates', outcome: 'failed', purpose: { kind: 'job', id: JOB_ID },
      });
    });

    it('records the denial after its ROLLBACK, in its own transaction', async () => {
      mockQuery
        .mockResolvedValueOnce({})
        .mockResolvedValueOnce({ rows: [{ id: 'employer-id' }] })
        .mockResolvedValueOnce({ rows: [], rowCount: 0 })
        .mockResolvedValue({});
      const res = await handler(withRequestId(makeEvent()));
      expect(res.statusCode).toBe(403);
      expect(mockRecordAccess).not.toHaveBeenCalled();
      expectAttemptAfter(mockQuery, mockRecordAttempt, 'ROLLBACK');
      expect(mockRecordAttempt).toHaveBeenCalledWith(client, employer, {
        surface: 'employer.job_candidates', outcome: 'denied', purpose: { kind: 'job', id: JOB_ID },
      });
    });
  });
});
