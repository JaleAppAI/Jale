import type { APIGatewayProxyEvent } from 'aws-lambda';
import { handler } from '../../../../lambda/api/worker-applications-list';
import { getDbPool, setInternalUserRlsContext, setRlsContext } from '../../../../lambda/lib/db';
import { checkCompliance } from '../../../../lambda/legal/check-compliance';

jest.mock('../../../../lambda/lib/db');
jest.mock('../../../../lambda/legal/check-compliance');
const mockGetDbPool = getDbPool as jest.Mock;
const mockSetRlsContext = setRlsContext as jest.Mock;
const mockSetInternalUserRlsContext = setInternalUserRlsContext as jest.Mock;
const mockCheckCompliance = checkCompliance as jest.Mock;
const mockQuery = jest.fn();
const mockRelease = jest.fn();

const ev = { requestContext: { authorizer: { claims: { sub: 'w' } } } } as unknown as APIGatewayProxyEvent;

describe('worker-applications-list', () => {
  const env = process.env;
  beforeEach(() => {
    jest.resetAllMocks();
    process.env = { ...env, REQUIRED_TOS_VERSION: 'v1.0' };
    mockGetDbPool.mockResolvedValue({ connect: jest.fn().mockResolvedValue({ query: mockQuery, release: mockRelease }) });
    mockCheckCompliance.mockResolvedValue({ compliant: true, userExists: true });
  });
  afterAll(() => { process.env = env; });

  it('returns 200 with applications including job_status, under the internal-id RLS context', async () => {
    const row = {
      application_id: 'a1', job_id: 'j1', job_title: 'T', company_name: 'Acme',
      status: 'pending', applied_at: 'ts', job_status: 'closed',
    };
    mockQuery.mockImplementation((q: string) => {
      if (q.trim().startsWith('SELECT id FROM users')) return Promise.resolve({ rows: [{ id: 'worker-internal-id' }] });
      if (q.includes('FROM job_applications')) return Promise.resolve({ rows: [row] });
      return Promise.resolve({ rows: [] });
    });
    const res = await handler(ev);
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ applications: [row] });

    // The 070 policy is keyed on app.current_internal_user_id — without this
    // call, closed jobs silently vanish from the list again.
    expect(mockSetInternalUserRlsContext).toHaveBeenCalledWith(expect.any(Object), 'worker-internal-id');

    const listSql = mockQuery.mock.calls.find(([q]) => String(q).includes('FROM job_applications'))?.[0] as string;
    // paused is a billing signal — never exposed to workers (spec).
    expect(listSql).toContain("CASE WHEN j.status = 'paused' THEN 'closed' ELSE j.status END AS job_status");
    // Company name comes from the 031 definer function; the users join is
    // gone (no RLS policy lets a worker read an employer's users row).
    expect(listSql).toContain('employer_display_name(j.employer_id) AS company_name');
    expect(listSql).not.toContain('JOIN users');
  });

  it('returns 409 when the internal-id lookup finds no user row', async () => {
    mockQuery.mockImplementation((q: string) => {
      if (q.trim().startsWith('SELECT id FROM users')) return Promise.resolve({ rows: [] });
      return Promise.resolve({ rows: [] });
    });
    const res = await handler(ev);
    expect(res.statusCode).toBe(409);
    expect(JSON.parse(res.body)).toEqual({ error: 'user_not_provisioned' });
    expect(mockSetInternalUserRlsContext).not.toHaveBeenCalled();
  });
});
