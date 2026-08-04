import type { APIGatewayProxyEvent } from 'aws-lambda';
import { handler } from '../../../../lambda/api/worker-jobs-list';
import { getDbPool, setRlsContext } from '../../../../lambda/lib/db';
import { listMatchedJobsForWorker } from '../../../../lambda/lib/job-matching';
import { checkCompliance } from '../../../../lambda/legal/check-compliance';

jest.mock('../../../../lambda/lib/db');
jest.mock('../../../../lambda/lib/job-matching');
jest.mock('../../../../lambda/legal/check-compliance');

const mockGetDbPool = getDbPool as jest.Mock;
const mockSetRlsContext = setRlsContext as jest.Mock;
const mockListMatchedJobsForWorker = listMatchedJobsForWorker as jest.Mock;
const mockCheckCompliance = checkCompliance as jest.Mock;
const mockQuery = jest.fn();
const mockRelease = jest.fn();

describe('worker-jobs-list', () => {
  const originalEnv = process.env;

  /** Preferred-city rows returned by the `worker_preferred_cities` SELECT.
   * Defaults to none (= today's unfiltered behavior) for every test. */
  let preferredCityKeys: string[] = [];
  function mockCityKeys(keys: string[]): void {
    preferredCityKeys = keys;
  }

  /** Shared dispatching implementation for the handler's own SQL, so adding a
   * query doesn't require touching every test. */
  function mockWorkerQueries(): void {
    mockQuery.mockImplementation((q: string) => {
      if (q.includes('FROM users WHERE cognito_sub')) return Promise.resolve({ rows: [{ id: 'worker-1' }] });
      if (q.includes('worker_preferred_cities')) {
        return Promise.resolve({ rows: preferredCityKeys.map((city_key) => ({ city_key })) });
      }
      return Promise.resolve({});
    });
  }

  function job(id: string): Record<string, unknown> {
    return {
      id, title: id, company: 'Jale', location: 'El Paso, TX', pay: 'x', job_type: 'full-time',
      created_at: '2026-08-01', match_score: 10, match_components: {}, match_reasons: [], required_docs: [],
    };
  }

  beforeEach(() => {
    jest.resetAllMocks();
    process.env = { ...originalEnv, REQUIRED_TOS_VERSION: 'v1.0' };
    mockGetDbPool.mockResolvedValue({
      connect: jest.fn().mockResolvedValue({ query: mockQuery, release: mockRelease }),
    });
    preferredCityKeys = [];
    mockWorkerQueries();
  });
  afterAll(() => { process.env = originalEnv; });

  const baseEvent = {
    requestContext: { authorizer: { claims: { sub: 'worker-sub-1' } } },
    queryStringParameters: null,
  } as unknown as APIGatewayProxyEvent;

  it('returns 401 if cognito sub missing', async () => {
    const res = await handler({ ...baseEvent, requestContext: { authorizer: { claims: {} } } } as any);
    expect(res.statusCode).toBe(401);
  });

  it('returns 403 legal_required if not compliant', async () => {
    mockCheckCompliance.mockResolvedValue({ compliant: false, userExists: true, currentVersion: 'v0.9' });
    const res = await handler(baseEvent);
    expect(res.statusCode).toBe(403);
    expect(JSON.parse(res.body).error).toBe('legal_required');
  });

  it('returns 200 with jobs list on happy path', async () => {
    mockCheckCompliance.mockResolvedValue({ compliant: true, userExists: true });
    const row = {
      id: 'j1', title: 'Forklift', location: 'Houston', job_type: 'full-time',
      company: 'Acme', pay: '$24/hr', required_docs: ['resume'], created_at: '2026-04-20T00:00:00Z',
      match_score: 87, match_components: { profession: 50 }, match_reasons: ['profession_exact_or_alias'],
    };
    mockListMatchedJobsForWorker.mockResolvedValue([row]);
    const res = await handler(baseEvent);
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({
      jobs: [{
        id: 'j1',
        title: 'Forklift',
        location: 'Houston',
        job_type: 'full-time',
        company: 'Acme',
        company_name: 'Acme',
        pay: '$24/hr',
        required_docs: ['resume'],
        created_at: '2026-04-20T00:00:00Z',
        match_score: 87,
        match_reasons: ['profession_exact_or_alias'],
      }],
    });
    expect(mockSetRlsContext).toHaveBeenCalledWith(expect.any(Object), 'worker-sub-1');
    expect(mockListMatchedJobsForWorker).toHaveBeenCalledWith(expect.any(Object), 'worker-1', {
      limit: 100,
      channel: 'api',
      search: '',
      jobType: undefined,
    });
  });

  it('normalizes nullable matching fields for the frontend contract', async () => {
    mockCheckCompliance.mockResolvedValue({ compliant: true, userExists: true });
    mockListMatchedJobsForWorker.mockResolvedValue([{
      id: 'j2',
      title: 'Painter',
      location: 'Austin',
      job_type: 'contract',
      company: 'Jale',
      pay: 'Pay not specified',
      required_docs: null,
      created_at: '2026-04-21T00:00:00Z',
      match_score: 42,
      match_components: { profession: 32 },
      match_reasons: ['profession_partial'],
    }]);

    const res = await handler(baseEvent);

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).jobs[0]).toMatchObject({
      company: 'Jale',
      company_name: 'Jale',
      required_docs: [],
    });
  });

  it('passes search and job_type as query params', async () => {
    mockCheckCompliance.mockResolvedValue({ compliant: true, userExists: true });
    mockListMatchedJobsForWorker.mockResolvedValue([]);
    const ev = { ...baseEvent, queryStringParameters: { search: 'forklift', job_type: 'full-time' } } as any;
    await handler(ev);
    expect(mockListMatchedJobsForWorker).toHaveBeenCalledWith(expect.any(Object), 'worker-1', {
      limit: 100,
      channel: 'api',
      search: 'forklift',
      jobType: 'full-time',
    });
  });

  it('passes preferred keys and skips fallback when results are sufficient', async () => {
    mockCheckCompliance.mockResolvedValue({ compliant: true, userExists: true });
    mockCityKeys(['el-paso-tx']);
    mockListMatchedJobsForWorker.mockResolvedValueOnce([job('a'), job('b'), job('c'), job('d'), job('e')]);
    const res = await handler(baseEvent);
    expect(res.statusCode).toBe(200);
    expect(mockListMatchedJobsForWorker).toHaveBeenCalledTimes(1);
    expect(mockListMatchedJobsForWorker.mock.calls[0][2]).toMatchObject({ cityKeys: ['el-paso-tx'] });
    expect(JSON.parse(res.body).other_jobs).toBeUndefined();
  });

  it('runs the fallback query when city-matched results are thin', async () => {
    mockCheckCompliance.mockResolvedValue({ compliant: true, userExists: true });
    mockCityKeys(['el-paso-tx']);
    mockListMatchedJobsForWorker
      .mockResolvedValueOnce([job('a')])
      .mockResolvedValueOnce([job('x'), job('y')]);
    const ev = { ...baseEvent, queryStringParameters: { search: 'forklift', job_type: 'contract' } } as any;
    const res = await handler(ev);
    expect(res.statusCode).toBe(200);
    expect(mockListMatchedJobsForWorker).toHaveBeenCalledTimes(2);
    // The user's search/filter must narrow the fallback list too -- otherwise
    // `other_jobs` would ignore what they actually asked for.
    expect(mockListMatchedJobsForWorker.mock.calls[1][2]).toMatchObject({
      excludeCityKeys: ['el-paso-tx'],
      search: 'forklift',
      jobType: 'contract',
    });
    const parsed = JSON.parse(res.body);
    expect(parsed.jobs).toHaveLength(1);
    expect(parsed.other_jobs).toHaveLength(2);
    expect(parsed.other_jobs[0]).toMatchObject({ id: 'x', company_name: 'Jale', required_docs: [] });
  });

  it('drops fallback jobs that already appear in the city-matched list', async () => {
    // The referral pin (`referredJobPin`) is fetched by id with no city
    // filter, so the same pinned job can come back from BOTH queries.
    mockCheckCompliance.mockResolvedValue({ compliant: true, userExists: true });
    mockCityKeys(['el-paso-tx']);
    mockListMatchedJobsForWorker
      .mockResolvedValueOnce([job('a')])
      .mockResolvedValueOnce([job('a'), job('x')]);
    const res = await handler(baseEvent);
    expect(res.statusCode).toBe(200);
    const parsed = JSON.parse(res.body);
    expect(parsed.jobs.map((j: { id: string }) => j.id)).toEqual(['a']);
    expect(parsed.other_jobs.map((j: { id: string }) => j.id)).toEqual(['x']);
  });

  it('omits other_jobs when every fallback job was already city-matched', async () => {
    mockCheckCompliance.mockResolvedValue({ compliant: true, userExists: true });
    mockCityKeys(['el-paso-tx']);
    mockListMatchedJobsForWorker
      .mockResolvedValueOnce([job('a')])
      .mockResolvedValueOnce([job('a')]);
    const res = await handler(baseEvent);
    expect(res.statusCode).toBe(200);
    const parsed = JSON.parse(res.body);
    expect(parsed.jobs.map((j: { id: string }) => j.id)).toEqual(['a']);
    expect(parsed.other_jobs).toBeUndefined();
  });

  it('applies no city options when the worker has no preferred cities', async () => {
    mockCheckCompliance.mockResolvedValue({ compliant: true, userExists: true });
    mockCityKeys([]);
    mockListMatchedJobsForWorker.mockResolvedValueOnce([]);
    const res = await handler(baseEvent);
    expect(res.statusCode).toBe(200);
    expect(mockListMatchedJobsForWorker).toHaveBeenCalledTimes(1);
    expect(mockListMatchedJobsForWorker.mock.calls[0][2].cityKeys).toBeUndefined();
    expect(JSON.parse(res.body).other_jobs).toBeUndefined();
  });
});
