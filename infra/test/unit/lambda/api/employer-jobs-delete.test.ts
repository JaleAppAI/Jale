import type { APIGatewayProxyEvent } from 'aws-lambda';
import { handler } from '../../../../lambda/api/employer-jobs-delete';
import { getDbPool, setInternalUserRlsContext, setRlsContext } from '../../../../lambda/lib/db';
import { checkCompliance } from '../../../../lambda/legal/check-compliance';
import { setAuditContext } from '../../../../lambda/lib/audit/context';
import { callerFor, expectContextBeforeWrite, withRequestId } from './audit-expectations';

jest.mock('../../../../lambda/lib/db');
jest.mock('../../../../lambda/legal/check-compliance');
jest.mock('../../../../lambda/lib/audit/record', () => ({
  ...jest.requireActual('../../../../lambda/lib/audit/record'),
  recordAccess: jest.fn(),
  recordAttempt: jest.fn(),
}));
jest.mock('../../../../lambda/lib/audit/context');

const mockGetDbPool = getDbPool as jest.Mock;
const mockSetRlsContext = setRlsContext as jest.Mock;
const mockSetInternalUserRlsContext = setInternalUserRlsContext as jest.Mock;
const mockCheckCompliance = checkCompliance as jest.Mock;
const mockQuery = jest.fn();
const mockRelease = jest.fn();
const JOB_ID = '11111111-1111-4111-8111-111111111111';

function makeEvent(overrides: Partial<APIGatewayProxyEvent> = {}): APIGatewayProxyEvent {
  return {
    requestContext: { authorizer: { claims: { sub: 'e-sub' } } },
    pathParameters: { jobId: JOB_ID },
    ...overrides,
  } as unknown as APIGatewayProxyEvent;
}

describe('employer-jobs-delete', () => {
  const env = process.env;

  beforeEach(() => {
    jest.resetAllMocks();
    process.env = { ...env, REQUIRED_TOS_VERSION: 'v1.0' };
    mockGetDbPool.mockResolvedValue({ connect: jest.fn().mockResolvedValue({ query: mockQuery, release: mockRelease }) });
    mockSetRlsContext.mockResolvedValue(undefined);
    mockCheckCompliance.mockResolvedValue({ compliant: true, userExists: true });
  });

  afterAll(() => { process.env = env; });

  it('returns 401 when unauthenticated', async () => {
    const res = await handler(makeEvent({ requestContext: { authorizer: { claims: {} } } } as unknown as Partial<APIGatewayProxyEvent>));
    expect(res.statusCode).toBe(401);
    expect(mockGetDbPool).not.toHaveBeenCalled();
  });

  it('returns 400 on an invalid jobId', async () => {
    const res = await handler(makeEvent({ pathParameters: { jobId: 'not-a-uuid' } }));
    expect(res.statusCode).toBe(400);
    expect(mockGetDbPool).not.toHaveBeenCalled();
  });

  it('returns 403 forbidden when the ownership query returns no row', async () => {
    mockQuery.mockImplementation((sql: string) => {
      if (/FROM jobs\s+JOIN users/i.test(sql)) return { rowCount: 0, rows: [] };
      return { rowCount: 1, rows: [] };
    });
    const res = await handler(makeEvent());
    expect(res.statusCode).toBe(403);
    expect(mockQuery).toHaveBeenCalledWith('ROLLBACK');
  });

  it('returns 409 job_has_hired_workers and issues no destructive delete', async () => {
    mockQuery.mockImplementation((sql: string) => {
      if (/FROM jobs\s+JOIN users/i.test(sql)) return { rowCount: 1, rows: [{ id: JOB_ID, hired_count: 2 }] };
      return { rowCount: 1, rows: [] };
    });
    const res = await handler(makeEvent());
    expect(res.statusCode).toBe(409);
    expect(JSON.parse(res.body).error).toBe('job_has_hired_workers');
    expect(mockQuery).toHaveBeenCalledWith('ROLLBACK');
    expect(mockQuery).not.toHaveBeenCalledWith(expect.stringMatching(/DELETE FROM jobs/i), expect.anything());
  });

  it('returns 200, deletes the conversations then the job, leaves documents and tokens to the cascades, and commits', async () => {
    const calls: string[] = [];
    mockQuery.mockImplementation((sql: string) => {
      calls.push(sql.replace(/\s+/g, ' ').trim());
      if (/FROM jobs\s+JOIN users/i.test(sql)) return { rowCount: 1, rows: [{ id: JOB_ID, hired_count: 0, employer_user_id: 'employer-user-id' }] };
      return { rowCount: 1, rows: [] };
    });
    const res = await handler(makeEvent());
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ deleted: true, id: JOB_ID });
    const deletes = calls.filter((c) => c.startsWith('DELETE'));
    expect(deletes).toHaveLength(2);
    expect(deletes[0]).toMatch(/DELETE FROM job_conversations/i);
    expect(deletes[1]).toMatch(/DELETE FROM jobs/i);
    expect(calls.some((c) => /worker_documents|document_upload_tokens/i.test(c))).toBe(false);
    expect(mockQuery).toHaveBeenCalledWith('COMMIT');
  });

  it("sets the employer's internal id from the ownership row before any delete", async () => {
    const order: string[] = [];
    mockQuery.mockImplementation((sql: string) => {
      order.push(sql.replace(/\s+/g, ' ').trim());
      if (/FROM jobs\s+JOIN users/i.test(sql)) return { rowCount: 1, rows: [{ id: JOB_ID, hired_count: 0, employer_user_id: 'employer-user-id' }] };
      return { rowCount: 1, rows: [] };
    });
    mockSetInternalUserRlsContext.mockImplementation(async () => { order.push('SET INTERNAL'); });
    const res = await handler(makeEvent());
    expect(res.statusCode).toBe(200);
    expect(mockSetInternalUserRlsContext).toHaveBeenCalledWith(expect.anything(), 'employer-user-id');
    const ownership = order.findIndex((sql) => /FROM jobs JOIN users/i.test(sql));
    expect(order[ownership]).toMatch(/u\.id AS employer_user_id/);
    expect(order.indexOf('SET INTERNAL')).toBeGreaterThan(ownership);
    expect(order.indexOf('SET INTERNAL')).toBeLessThan(order.findIndex((sql) => sql.startsWith('DELETE')));
  });

  it('returns 500, rolls back and never deletes the job when a conversation survives the delete', async () => {
    mockQuery.mockImplementation((sql: string) => {
      if (/FROM jobs\s+JOIN users/i.test(sql)) return { rowCount: 1, rows: [{ id: JOB_ID, hired_count: 0, employer_user_id: 'employer-user-id' }] };
      if (/SELECT EXISTS \(SELECT 1 FROM job_conversations/i.test(sql)) return { rowCount: 1, rows: [{ remaining: true }] };
      return { rowCount: 1, rows: [] };
    });
    const res = await handler(makeEvent());
    expect(res.statusCode).toBe(500);
    expect(mockQuery).toHaveBeenCalledWith('ROLLBACK');
    expect(mockQuery).not.toHaveBeenCalledWith('COMMIT');
    expect(mockQuery).not.toHaveBeenCalledWith(expect.stringMatching(/DELETE FROM jobs/i), expect.anything());
  });

  it('returns 500 and rolls back when the final job delete affects 0 rows', async () => {
    mockQuery.mockImplementation((sql: string) => {
      if (/FROM jobs\s+JOIN users/i.test(sql)) return { rowCount: 1, rows: [{ id: JOB_ID, hired_count: 0, employer_user_id: 'employer-user-id' }] };
      if (/DELETE FROM jobs/i.test(sql)) return { rowCount: 0, rows: [] };
      return { rowCount: 1, rows: [] };
    });
    const res = await handler(makeEvent());
    expect(res.statusCode).toBe(500);
    expect(mockQuery).toHaveBeenCalledWith('ROLLBACK');
    expect(mockQuery).not.toHaveBeenCalledWith('COMMIT');
  });

  it("enqueues a 'removed' visibility event, BEFORE the DELETEs, when the deleted job was effectively visible", async () => {
    const calls: Array<[string, unknown[] | undefined]> = [];
    mockQuery.mockImplementation((sql: string, params?: unknown[]) => {
      calls.push([sql.replace(/\s+/g, ' ').trim(), params]);
      if (/FROM jobs\s+JOIN users/i.test(sql)) {
        return { rowCount: 1, rows: [{ id: JOB_ID, hired_count: 0, status: 'active', public_listing_enabled: true, public_code: 'ABC123', employer_user_id: 'employer-user-id' }] };
      }
      return { rowCount: 1, rows: [] };
    });
    const res = await handler(makeEvent());
    expect(res.statusCode).toBe(200);

    const enqueueIdx = calls.findIndex(([sql]) => sql.includes('enqueue_job_visibility_event'));
    expect(enqueueIdx).toBeGreaterThanOrEqual(0);
    expect(calls[enqueueIdx][1]).toEqual([JOB_ID, 'ABC123', 'removed']);

    // Must run before any of the destructive deletes, while jobs.id still exists
    // to be referenced -- see the comment in employer-jobs-delete.ts.
    const firstDeleteIdx = calls.findIndex(([sql]) => sql.startsWith('DELETE'));
    expect(enqueueIdx).toBeLessThan(firstDeleteIdx);
  });

  it('does NOT enqueue a visibility event for a paused (non-active) job even if listed', async () => {
    mockQuery.mockImplementation((sql: string) => {
      if (/FROM jobs\s+JOIN users/i.test(sql)) {
        return { rowCount: 1, rows: [{ id: JOB_ID, hired_count: 0, status: 'paused', public_listing_enabled: true, public_code: 'ABC123', employer_user_id: 'employer-user-id' }] };
      }
      return { rowCount: 1, rows: [] };
    });
    await handler(makeEvent());
    const enqueued = mockQuery.mock.calls.some((c) => typeof c[0] === 'string' && c[0].includes('enqueue_job_visibility_event'));
    expect(enqueued).toBe(false);
  });

  describe('change context', () => {
    it('states the employer before the deletes, whose cascades reach covered tables', async () => {
      mockQuery.mockImplementation((sql: string) => {
        if (/FROM jobs\s+JOIN users/i.test(sql)) return { rowCount: 1, rows: [{ id: JOB_ID, hired_count: 0, employer_user_id: 'employer-user-id' }] };
        return { rowCount: 1, rows: [] };
      });
      const res = await handler(withRequestId(makeEvent()));
      expect(res.statusCode).toBe(200);
      expect(setAuditContext).toHaveBeenCalledTimes(1);
      expect(setAuditContext).toHaveBeenCalledWith(
        expect.objectContaining({ query: mockQuery }), callerFor('employer', 'employer-user-id'), 'employer.job_delete');
      expectContextBeforeWrite(mockQuery, setAuditContext as jest.Mock, /DELETE FROM job_conversations/);
      expect((setAuditContext as jest.Mock).mock.invocationCallOrder[0])
        .toBeGreaterThan(mockSetInternalUserRlsContext.mock.invocationCallOrder[0]);
    });

    it('states nothing when the job is not the caller\'s', async () => {
      mockQuery.mockImplementation(() => ({ rowCount: 0, rows: [] }));
      expect((await handler(makeEvent())).statusCode).toBe(403);
      expect(setAuditContext).not.toHaveBeenCalled();
    });
  });
});
