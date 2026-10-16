import type { APIGatewayProxyEvent } from 'aws-lambda';
import { handler } from '../../../../lambda/api/employer-jobs-list';
import { getDbPool, setRlsContext } from '../../../../lambda/lib/db';
import { checkCompliance } from '../../../../lambda/legal/check-compliance';
import { resolveEmployerActor } from '../../../../lambda/lib/employer-actor';

jest.mock('../../../../lambda/lib/db');
jest.mock('../../../../lambda/legal/check-compliance');
jest.mock('../../../../lambda/lib/employer-actor', () => ({
  ...jest.requireActual('../../../../lambda/lib/employer-actor'),
  resolveEmployerActor: jest.fn(),
}));

const mockGetDbPool = getDbPool as jest.Mock;
const mockSetRlsContext = setRlsContext as jest.Mock;
const mockCheckCompliance = checkCompliance as jest.Mock;
const mockQuery = jest.fn();
const mockRelease = jest.fn();
const mockResolveEmployerActor = resolveEmployerActor as jest.Mock;
const EMPLOYER_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const ORG_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const FOREMAN_ID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const ownerActor = (scopeUserIds: string[] = [EMPLOYER_ID]) => ({
  ok: true,
  actor: { userId: EMPLOYER_ID, organizationId: ORG_ID, role: 'owner', scopeUserIds },
});

describe('employer-jobs-list', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    jest.resetAllMocks();
    process.env = { ...originalEnv, REQUIRED_TOS_VERSION: 'v1.0' };
    mockGetDbPool.mockResolvedValue({
      connect: jest.fn().mockResolvedValue({ query: mockQuery, release: mockRelease }),
    });
    mockCheckCompliance.mockResolvedValue({ compliant: true, userExists: true });
    mockResolveEmployerActor.mockResolvedValue(ownerActor());
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
    expect(mockResolveEmployerActor).toHaveBeenCalledWith(expect.anything(), 'employer-sub-1');
    expect(mockQuery).toHaveBeenCalledWith(expect.stringContaining('j.employer_id = ANY($1::uuid[])'), [[EMPLOYER_ID]]);
  });

  it("passes the owner's whole scope as the uuid[] parameter, with no cognito_sub lookup", async () => {
    mockResolveEmployerActor.mockResolvedValue(ownerActor([EMPLOYER_ID, FOREMAN_ID]));
    mockQuery.mockImplementation((sql: string) => {
      if (sql.includes('FROM jobs j')) return Promise.resolve({ rows: [] });
      return Promise.resolve({});
    });

    const res = await handler(baseEvent);

    expect(res.statusCode).toBe(200);
    const listCall = mockQuery.mock.calls.find((c) => typeof c[0] === 'string' && c[0].includes('FROM jobs j'));
    expect(listCall![0]).not.toContain('cognito_sub');
    expect(listCall![1]).toEqual([[EMPLOYER_ID, FOREMAN_ID]]);
  });

  it('returns the actor failure, commits, and lists nothing when the membership is inactive', async () => {
    mockResolveEmployerActor.mockResolvedValue({ ok: false, status: 403, error: 'membership_inactive' });
    mockQuery.mockResolvedValue({});

    const res = await handler(baseEvent);

    expect(res.statusCode).toBe(403);
    expect(JSON.parse(res.body)).toEqual({ error: 'membership_inactive' });
    expect(mockQuery).toHaveBeenCalledWith('COMMIT');
    expect(mockQuery.mock.calls.some((c) => typeof c[0] === 'string' && c[0].includes('FROM jobs'))).toBe(false);
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
