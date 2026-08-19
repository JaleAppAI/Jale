import type { APIGatewayProxyEvent } from 'aws-lambda';
import { handler } from '../../../../lambda/api/employer-jobs-detail';
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

describe('employer-jobs-detail', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    jest.resetAllMocks();
    process.env = { ...originalEnv, REQUIRED_TOS_VERSION: 'v1.0' };
    mockGetDbPool.mockResolvedValue({
      connect: jest.fn().mockResolvedValue({ query: mockQuery, release: mockRelease }),
    });
    mockCheckCompliance.mockResolvedValue({ compliant: true, userExists: true });
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  const baseEvent = {
    requestContext: { authorizer: { claims: { sub: 'employer-sub-1' } } },
    pathParameters: { jobId: JOB_ID },
  } as unknown as APIGatewayProxyEvent;

  it('returns 400 when jobId is not a valid UUID', async () => {
    const res = await handler({
      requestContext: { authorizer: { claims: { sub: 'employer-sub-1' } } },
      pathParameters: { jobId: 'not-a-uuid' },
    } as unknown as APIGatewayProxyEvent);

    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).error).toBe('invalid_job_id');
  });

  it('returns full job posting details', async () => {
    const row = {
      id: JOB_ID,
      title: 'Forklift Driver',
      location: 'Houston',
      state_region: 'TX',
      job_type: 'full-time',
      status: 'active',
      description: 'Unload trucks and stage materials.',
      required_docs: ['driver_license'],
      created_at: '2026-04-20T00:00:00Z',
      applicant_count: 2,
      city_key: 'houston-tx',
      city: 'Houston',
      state: 'TX',
      latitude: 29.76,
      longitude: -95.37,
    };
    mockQuery.mockImplementation((sql: string) => {
      if (sql.includes('SELECT id, title, location')) return Promise.resolve({ rows: [row] });
      return Promise.resolve({});
    });

    const res = await handler(baseEvent);

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({
      ...row,
      optional_docs: [],
      required_fields: [],
      optional_fields: [],
    });
    expect(JSON.parse(res.body).city).toBe('Houston');
    expect(JSON.parse(res.body).state_region).toBe('TX');
    expect(mockSetRlsContext).toHaveBeenCalledWith(expect.any(Object), 'employer-sub-1');
  });

  it('selects the city triple and coordinates so jobToForm prefill has them', async () => {
    const row = {
      id: JOB_ID,
      title: 'Forklift Driver',
      location: 'Houston',
      job_type: 'full-time',
      status: 'active',
      description: null,
      required_docs: [],
      created_at: '2026-04-20T00:00:00Z',
      applicant_count: 0,
      city_key: 'houston-tx',
      city: 'Houston',
      state: 'TX',
      latitude: 29.76,
      longitude: -95.37,
    };
    let capturedSql = '';
    mockQuery.mockImplementation((sql: string) => {
      if (sql.includes('SELECT id, title, location')) {
        capturedSql = sql;
        return Promise.resolve({ rows: [row] });
      }
      return Promise.resolve({});
    });

    const res = await handler(baseEvent);
    const body = JSON.parse(res.body);

    expect(capturedSql).toMatch(/city_key,\s*city,\s*state,\s*latitude::float8 AS latitude,\s*longitude::float8 AS longitude/);
    expect(body).toMatchObject({
      city_key: 'houston-tx',
      city: 'Houston',
      state: 'TX',
      latitude: 29.76,
      longitude: -95.37,
    });
  });

  it('selects city and state_region in the job lookup query', async () => {
    mockQuery.mockImplementation((sql: string) => {
      if (sql.includes('SELECT id, title, location')) return Promise.resolve({ rows: [] });
      return Promise.resolve({});
    });
    await handler(baseEvent);
    const jobLookupCall = mockQuery.mock.calls.find((c) => typeof c[0] === 'string' && c[0].includes('SELECT id, title, location'));
    expect(jobLookupCall![0]).toMatch(/\bcity\b/);
    expect(jobLookupCall![0]).toMatch(/\bstate_region\b/);
  });

  it('selects and returns all four requirement arrays so EditJobModal round-trips them', async () => {
    // Regression: this endpoint feeds jobToForm/EditJobModal, whose save
    // payload ALWAYS re-sends the four arrays. Omitting any of them here
    // wiped stored requirements on the next save (or permanently 409-locked
    // a frozen job) — the adversarial integration review's critical finding.
    const row = {
      id: JOB_ID,
      title: 'Concrete Finisher',
      location: 'Kyle, TX',
      job_type: 'full-time',
      status: 'active',
      description: null,
      required_docs: ['driver_license'],
      optional_docs: ['resume'],
      required_fields: ['work_authorization', 'references'],
      optional_fields: ['education'],
      created_at: '2026-08-18T00:00:00Z',
      applicant_count: 1,
      city_key: 'kyle-tx',
      city: 'Kyle',
      state: 'TX',
      latitude: 29.99,
      longitude: -97.88,
    };
    let capturedSql = '';
    mockQuery.mockImplementation((sql: string) => {
      if (sql.includes('SELECT id, title, location')) {
        capturedSql = sql;
        return Promise.resolve({ rows: [row] });
      }
      return Promise.resolve({});
    });

    const res = await handler(baseEvent);

    expect(res.statusCode).toBe(200);
    for (const col of ['optional_docs', 'required_fields', 'optional_fields'] as const) {
      expect(capturedSql).toContain(col);
      expect(JSON.parse(res.body)[col]).toEqual(row[col]);
    }
    expect(JSON.parse(res.body).required_docs).toEqual(['driver_license']);
  });

  it('normalizes nullable required_docs for the frontend contract', async () => {
    mockQuery.mockImplementation((sql: string) => {
      if (sql.includes('SELECT id, title, location')) {
        return Promise.resolve({
          rows: [{
            id: JOB_ID,
            title: 'Painter',
            location: 'Austin',
            job_type: 'contract',
            status: 'active',
            description: null,
            required_docs: null,
            created_at: '2026-04-20T00:00:00Z',
            applicant_count: 0,
          }],
        });
      }
      return Promise.resolve({});
    });

    const res = await handler(baseEvent);

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).required_docs).toEqual([]);
  });
});
