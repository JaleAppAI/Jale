import type { APIGatewayProxyEvent } from 'aws-lambda';
import { handler } from '../../../../lambda/api/employer-templates-list';
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
  ...overrides,
} as unknown as APIGatewayProxyEvent);

describe('employer-templates-list', () => {
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
      if (sql.includes('SELECT t.id, t.name, t.payload, t.updated_at')) {
        return Promise.resolve({
          rows: [
            { id: 'tpl-1', name: 'Concrete crew', payload: { title: 'Concrete Finisher' }, updated_at: '2026-08-07T10:00:00Z' },
            { id: 'tpl-2', name: 'Steel work', payload: { title: 'Steel Worker' }, updated_at: '2026-08-06T10:00:00Z' },
          ],
        });
      }
      return Promise.resolve({});
    });
  });

  it('returns 401 without claims', async () => {
    const res = await handler({
      requestContext: { authorizer: { claims: undefined } },
    } as unknown as APIGatewayProxyEvent);

    expect(res.statusCode).toBe(401);
    expect(JSON.parse(res.body).error).toBe('unauthorized');
  });

  it('returns 403 when not compliant', async () => {
    mockCheckCompliance.mockResolvedValue({ compliant: false, userExists: true });

    const res = await handler(makeEvent());

    expect(res.statusCode).toBe(403);
    expect(JSON.parse(res.body).error).toBe('legal_required');
  });

  it('returns templates ordered by updated_at DESC', async () => {
    const res = await handler(makeEvent());

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.templates).toHaveLength(2);
    expect(body.templates[0].id).toBe('tpl-1');
    expect(body.templates[1].id).toBe('tpl-2');

    // Assert the query was called with ORDER BY and the correct params
    const selectCall = mockQuery.mock.calls.find(
      ([sql]) => typeof sql === 'string' && sql.includes('SELECT t.id, t.name, t.payload, t.updated_at'),
    );
    expect(selectCall).toBeDefined();
    expect(selectCall[0]).toContain('ORDER BY t.updated_at DESC');
    expect(selectCall[0]).toContain('jale_internal.shares_org_with($1::text, t.employer_id)');
    expect(selectCall[0]).not.toContain('cognito_sub');
    expect(selectCall[1]).toEqual([EMPLOYER_ID]);
  });

  it('returns empty templates array when none exist', async () => {
    mockQuery.mockImplementation((sql: string) => {
      if (sql.includes('SELECT t.id, t.name, t.payload, t.updated_at')) {
        return Promise.resolve({ rows: [] });
      }
      return Promise.resolve({});
    });

    const res = await handler(makeEvent());

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.templates).toEqual([]);
  });

  it("reads company-wide by organization, not by scope: a foreman's call passes only their own id", async () => {
    mockResolveEmployerActor.mockResolvedValue({
      ok: true,
      actor: { userId: FOREMAN_ID, organizationId: ORG_ID, role: 'foreman', scopeUserIds: [FOREMAN_ID] },
    });

    const res = await handler(makeEvent());

    expect(res.statusCode).toBe(200);
    expect(mockResolveEmployerActor).toHaveBeenCalledWith(expect.anything(), 'employer-sub');
    const selectCall = mockQuery.mock.calls.find(
      ([sql]) => typeof sql === 'string' && sql.includes('SELECT t.id, t.name, t.payload, t.updated_at'),
    );
    expect(selectCall[1]).toEqual([FOREMAN_ID]);
  });

  it("passes the owner's id, never the scope array", async () => {
    mockResolveEmployerActor.mockResolvedValue(ownerActor([EMPLOYER_ID, FOREMAN_ID]));

    await handler(makeEvent());

    const selectCall = mockQuery.mock.calls.find(
      ([sql]) => typeof sql === 'string' && sql.includes('SELECT t.id, t.name, t.payload, t.updated_at'),
    );
    expect(selectCall[1]).toEqual([EMPLOYER_ID]);
  });

  it('returns the actor failure, rolls back, and reads no template when the membership is inactive', async () => {
    mockResolveEmployerActor.mockResolvedValue({ ok: false, status: 403, error: 'membership_inactive' });

    const res = await handler(makeEvent());

    expect(res.statusCode).toBe(403);
    expect(JSON.parse(res.body)).toEqual({ error: 'membership_inactive' });
    expect(mockQuery).toHaveBeenCalledWith('ROLLBACK');
    expect(mockQuery.mock.calls.some(([sql]) => typeof sql === 'string' && sql.includes('employer_job_templates'))).toBe(false);
  });
});
