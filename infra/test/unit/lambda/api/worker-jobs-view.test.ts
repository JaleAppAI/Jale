import type { APIGatewayProxyEvent } from 'aws-lambda';
import { handler } from '../../../../lambda/api/worker-jobs-view';
import { getDbPool, setInternalUserRlsContext, setRlsContext } from '../../../../lambda/lib/db';
import { corsHeaders } from '../../../../lambda/lib/http';

jest.mock('../../../../lambda/lib/db');

const mockGetDbPool = getDbPool as jest.Mock;
const mockQuery = jest.fn();
const mockRelease = jest.fn();

const JOB = '88888888-8888-4888-8888-888888888888';
const WORKER = '99999999-9999-4999-8999-999999999999';
const RECORD = 'SELECT jale_cap.record_job_view($1, $2)';
const FIND_WORKER = `SELECT id FROM users WHERE cognito_sub = $1 AND user_type = 'worker'`;

const makeEvent = (over: { jobId?: string | undefined; body?: string | null; sub?: string | undefined } = {}) => ({
  httpMethod: 'POST',
  resource: '/worker/jobs/{jobId}/view',
  pathParameters: { jobId: 'jobId' in over ? over.jobId : JOB },
  requestContext: { authorizer: { claims: { sub: 'sub' in over ? over.sub : 'worker-sub' } } },
  body: 'body' in over ? over.body : JSON.stringify({ source: 'feed' }),
} as unknown as APIGatewayProxyEvent);

const statements = () => mockQuery.mock.calls.map(([sql]) => String(sql));

describe('worker-jobs-view (POST /worker/jobs/{jobId}/view)', () => {
  let warn: jest.SpyInstance;

  beforeEach(() => {
    jest.clearAllMocks();
    process.env.ALLOWED_ORIGIN = 'https://example.test';
    mockGetDbPool.mockResolvedValue({ connect: jest.fn().mockResolvedValue({ query: mockQuery, release: mockRelease }) });
    mockQuery.mockImplementation(async (sql: string) => (sql === FIND_WORKER ? { rows: [{ id: WORKER }] } : { rows: [] }));
    warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
  });
  afterEach(() => warn.mockRestore());

  it('records the view as the signed-in worker and answers 204 with no body', async () => {
    const res = await handler(makeEvent());

    expect(res).toEqual({ statusCode: 204, headers: corsHeaders(), body: '' });
    expect(setRlsContext).toHaveBeenCalledWith(expect.objectContaining({ query: mockQuery }), 'worker-sub');
    expect(setInternalUserRlsContext).toHaveBeenCalledWith(expect.objectContaining({ query: mockQuery }), WORKER);
    expect(statements()).toEqual([
      'BEGIN', FIND_WORKER, 'SAVEPOINT analytics_capture', RECORD, 'RELEASE SAVEPOINT analytics_capture', 'COMMIT',
    ]);
    expect(mockQuery).toHaveBeenCalledWith(RECORD, [JOB, 'feed']);
    expect(mockRelease).toHaveBeenCalled();
  });

  it.each(['feed', 'public_link', 'whatsapp', 'direct'])('passes the source %s through', async (source) => {
    await handler(makeEvent({ body: JSON.stringify({ source }) }));
    expect(mockQuery).toHaveBeenCalledWith(RECORD, [JOB, source]);
  });

  it.each([
    ['a job id that is not a uuid', { jobId: 'not-a-job' }],
    ['no job id', { jobId: undefined }],
    ['an unknown source', { body: JSON.stringify({ source: 'newsletter' }) }],
    ['no source', { body: JSON.stringify({}) }],
    ['a body that is not JSON', { body: '{not json' }],
    ['no body', { body: null }],
    ['no signed-in user', { sub: undefined }],
  ])('answers 204 for %s, without touching the database', async (_label, over) => {
    const res = await handler(makeEvent(over));
    expect(res.statusCode).toBe(204);
    expect(mockGetDbPool).not.toHaveBeenCalled();
  });

  it('answers 204 and records nothing for a caller who is not a worker', async () => {
    mockQuery.mockImplementation(async () => ({ rows: [] }));
    const res = await handler(makeEvent());
    expect(res.statusCode).toBe(204);
    expect(statements()).toEqual(['BEGIN', FIND_WORKER, 'COMMIT']);
  });

  it('answers 204 when the record fails, and still closes the transaction', async () => {
    mockQuery.mockImplementation(async (sql: string) => {
      if (sql === FIND_WORKER) return { rows: [{ id: WORKER }] };
      if (sql === RECORD) throw Object.assign(new Error('relation does not exist'), { code: '42P01' });
      return { rows: [] };
    });
    const res = await handler(makeEvent());
    expect(res.statusCode).toBe(204);
    expect(statements().slice(-3)).toEqual(['ROLLBACK TO SAVEPOINT analytics_capture', 'RELEASE SAVEPOINT analytics_capture', 'COMMIT']);
  });

  it('answers 204 on a database error, rolls back, releases the client and logs no id', async () => {
    mockQuery.mockImplementation(async (sql: string) => {
      if (sql === FIND_WORKER) throw Object.assign(new Error(`bad worker ${WORKER}`), { code: '08006' });
      return { rows: [] };
    });
    const res = await handler(makeEvent());
    expect(res.statusCode).toBe(204);
    expect(statements()).toContain('ROLLBACK');
    expect(mockRelease).toHaveBeenCalled();
    expect(JSON.stringify(warn.mock.calls)).not.toContain(WORKER);
    expect(JSON.stringify(warn.mock.calls)).not.toContain(JOB);
  });

  it('answers 204 when no connection can be had', async () => {
    mockGetDbPool.mockRejectedValue(new Error('pool down'));
    const res = await handler(makeEvent());
    expect(res.statusCode).toBe(204);
  });
});
