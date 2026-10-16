import type { APIGatewayProxyEvent } from 'aws-lambda';
import { handler } from '../../../../lambda/api/employer-templates-delete';
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

const makeEvent = (overrides: Partial<APIGatewayProxyEvent> = {}) => ({
  requestContext: { authorizer: { claims: { sub: 'employer-sub' } } },
  pathParameters: { templateId: 'tpl-1' },
  ...overrides,
} as unknown as APIGatewayProxyEvent);

describe('employer-templates-delete', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    process.env.REQUIRED_TOS_VERSION = 'v1.0';
    mockGetDbPool.mockResolvedValue({
      connect: jest.fn().mockResolvedValue({ query: mockQuery, release: mockRelease }),
    });
    mockSetRlsContext.mockResolvedValue(undefined);
    mockCheckCompliance.mockResolvedValue({ compliant: true, userExists: true });
    mockResolveEmployerActor.mockResolvedValue(ownerActor());
    mockQuery.mockImplementation((sql: string) => {
      if (sql.includes('DELETE FROM employer_job_templates')) {
        return Promise.resolve({ rowCount: 1 });
      }
      return Promise.resolve({});
    });
  });

  it('returns 401 without claims', async () => {
    const res = await handler({
      requestContext: { authorizer: { claims: undefined } },
      pathParameters: { templateId: 'tpl-1' },
    } as unknown as APIGatewayProxyEvent);

    expect(res.statusCode).toBe(401);
    expect(JSON.parse(res.body).error).toBe('unauthorized');
  });

  it('returns 400 missing_template_id when path parameter is missing', async () => {
    const res = await handler({
      requestContext: { authorizer: { claims: { sub: 'employer-sub' } } },
      pathParameters: { },
    } as unknown as APIGatewayProxyEvent);

    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).error).toBe('missing_template_id');
  });

  it('deletes owned template and returns 204', async () => {
    const res = await handler(makeEvent());

    expect(res.statusCode).toBe(204);
    expect(res.body).toBe('');

    // Assert the DELETE query was called with correct params
    const deleteCall = mockQuery.mock.calls.find(
      ([sql]) => typeof sql === 'string' && sql.includes('DELETE FROM employer_job_templates'),
    );
    expect(deleteCall).toBeDefined();
    expect(deleteCall[0]).toContain('t.employer_id = ANY($2::uuid[])');
    expect(deleteCall[0]).not.toContain('cognito_sub');
    expect(deleteCall[1]).toEqual(['tpl-1', [EMPLOYER_ID]]);
  });

  it('returns 403 forbidden when template not found or unowned', async () => {
    mockQuery.mockImplementation((sql: string) => {
      if (sql.includes('DELETE FROM employer_job_templates')) {
        return Promise.resolve({ rowCount: 0 });
      }
      return Promise.resolve({});
    });

    const res = await handler(makeEvent());

    expect(res.statusCode).toBe(403);
    expect(JSON.parse(res.body).error).toBe('forbidden');
  });

  it('returns 403 when not compliant', async () => {
    mockCheckCompliance.mockResolvedValue({ compliant: false, userExists: true });

    const res = await handler(makeEvent());

    expect(res.statusCode).toBe(403);
    expect(JSON.parse(res.body).error).toBe('legal_required');
  });

  it("passes the owner's whole scope, so the owner can delete a member's template", async () => {
    mockResolveEmployerActor.mockResolvedValue(ownerActor([EMPLOYER_ID, FOREMAN_ID]));

    const res = await handler(makeEvent());

    expect(res.statusCode).toBe(204);
    expect(mockResolveEmployerActor).toHaveBeenCalledWith(expect.anything(), 'employer-sub');
    const deleteCall = mockQuery.mock.calls.find(
      ([sql]) => typeof sql === 'string' && sql.includes('DELETE FROM employer_job_templates'),
    );
    expect(deleteCall[1]).toEqual(['tpl-1', [EMPLOYER_ID, FOREMAN_ID]]);
  });

  it('returns the actor failure, rolls back, and deletes nothing when the membership is inactive', async () => {
    mockResolveEmployerActor.mockResolvedValue({ ok: false, status: 403, error: 'membership_inactive' });

    const res = await handler(makeEvent());

    expect(res.statusCode).toBe(403);
    expect(JSON.parse(res.body)).toEqual({ error: 'membership_inactive' });
    expect(mockQuery).toHaveBeenCalledWith('ROLLBACK');
    expect(mockQuery.mock.calls.some(([sql]) => typeof sql === 'string' && sql.includes('DELETE FROM employer_job_templates'))).toBe(false);
  });
});
