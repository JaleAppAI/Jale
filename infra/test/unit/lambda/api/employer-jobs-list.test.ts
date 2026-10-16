import type { APIGatewayProxyEvent } from 'aws-lambda';
import { handler } from '../../../../lambda/api/employer-jobs-list';
import { getDbPool, setRlsContext } from '../../../../lambda/lib/db';
import { checkCompliance } from '../../../../lambda/legal/check-compliance';

jest.mock('../../../../lambda/lib/db');
jest.mock('../../../../lambda/legal/check-compliance');

const mockGetDbPool = getDbPool as jest.Mock;
const mockSetRlsContext = setRlsContext as jest.Mock;
const mockCheckCompliance = checkCompliance as jest.Mock;
const mockQuery = jest.fn();
const mockRelease = jest.fn();

describe('employer-jobs-list', () => {
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
  } as unknown as APIGatewayProxyEvent;

  it('returns 401 when cognito sub is missing', async () => {
    const res = await handler({
      ...baseEvent,
      requestContext: { authorizer: { claims: {} } },
    } as any);

    expect(res.statusCode).toBe(401);
  });

  it('returns 200 with jobs and applicant counts', async () => {
    const row = {
      id: 'job-1',
      title: 'Forklift Driver',
      location: 'Houston',
      job_type: 'full-time',
      status: 'active',
      created_at: '2026-04-20T00:00:00Z',
      applicant_count: 3,
    };

    mockQuery.mockImplementation((sql: string) => {
      if (sql.includes('FROM jobs j')) return Promise.resolve({ rows: [row] });
      if (sql.includes('FROM users')) return Promise.resolve({ rows: [{ id: 'employer-1' }] });
      return Promise.resolve({});
    });

    const res = await handler(baseEvent);

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ jobs: [row] });
    expect(mockSetRlsContext).toHaveBeenCalledWith(expect.any(Object), 'employer-sub-1');
    expect(mockQuery).toHaveBeenCalledWith(expect.stringContaining('FROM jobs j'), ['employer-sub-1']);
  });

  // K4 CCR-3 (F19): the dashboard's "Add start details" prompt counts, per
  // job, the hires that still have no start details. The 125 DB suite runs
  // this statement on real rows; here the SQL is pinned to that definition.
  it('counts, per job, the hires with no start details', async () => {
    mockQuery.mockImplementation((sql: string) => (sql.includes('FROM jobs j')
      ? Promise.resolve({ rows: [{ id: 'job-1', hire_details_needed_count: 2 }] })
      : Promise.resolve({})));

    const res = await handler(baseEvent);

    expect(JSON.parse(res.body).jobs[0].hire_details_needed_count).toBe(2);
    const sql = String(mockQuery.mock.calls.find(([q]) => String(q).includes('FROM jobs j'))![0]).replace(/\s+/g, ' ');
    expect(sql).toContain(
      "SELECT COUNT(*)::int FROM job_applications ja WHERE ja.job_id = j.id AND ja.status = 'hired' "
      + 'AND ja.hire_start_date IS NULL AND ja.hire_report_location IS NULL AND ja.hire_contact_name IS NULL '
      + 'AND ja.hire_contact_phone IS NULL AND ja.hire_notes IS NULL ) AS hire_details_needed_count',
    );
  });
});
