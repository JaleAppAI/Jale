import type { APIGatewayProxyEvent } from 'aws-lambda';
import { handler } from '../../../../lambda/api/employer-jobs-delete';
import { getDbPool, setRlsContext } from '../../../../lambda/lib/db';
import { checkCompliance } from '../../../../lambda/legal/check-compliance';

jest.mock('../../../../lambda/lib/db');
jest.mock('../../../../lambda/legal/check-compliance');

const mockGetDbPool = getDbPool as jest.Mock;
const mockSetRlsContext = setRlsContext as jest.Mock;
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

  it('returns 200, deletes dependents in order, and commits', async () => {
    const calls: string[] = [];
    mockQuery.mockImplementation((sql: string) => {
      calls.push(sql.replace(/\s+/g, ' ').trim());
      if (/FROM jobs\s+JOIN users/i.test(sql)) return { rowCount: 1, rows: [{ id: JOB_ID, hired_count: 0 }] };
      return { rowCount: 1, rows: [] };
    });
    const res = await handler(makeEvent());
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ deleted: true, id: JOB_ID });
    const deletes = calls.filter((c) => c.startsWith('DELETE'));
    expect(deletes[0]).toMatch(/DELETE FROM job_conversations/i);
    expect(deletes[1]).toMatch(/DELETE FROM worker_documents/i);
    expect(deletes[2]).toMatch(/DELETE FROM document_upload_tokens/i);
    expect(deletes[3]).toMatch(/DELETE FROM jobs/i);
    expect(mockQuery).toHaveBeenCalledWith('COMMIT');
  });

  it('returns 500 and rolls back when the final job delete affects 0 rows', async () => {
    mockQuery.mockImplementation((sql: string) => {
      if (/FROM jobs\s+JOIN users/i.test(sql)) return { rowCount: 1, rows: [{ id: JOB_ID, hired_count: 0 }] };
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
        return { rowCount: 1, rows: [{ id: JOB_ID, hired_count: 0, status: 'active', public_listing_enabled: true, public_code: 'ABC123' }] };
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
        return { rowCount: 1, rows: [{ id: JOB_ID, hired_count: 0, status: 'paused', public_listing_enabled: true, public_code: 'ABC123' }] };
      }
      return { rowCount: 1, rows: [] };
    });
    await handler(makeEvent());
    const enqueued = mockQuery.mock.calls.some((c) => typeof c[0] === 'string' && c[0].includes('enqueue_job_visibility_event'));
    expect(enqueued).toBe(false);
  });
});
