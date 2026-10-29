import type { APIGatewayProxyEvent } from 'aws-lambda';
import { handler, INVITE_LOOKUP_DB_LOGIN } from '../../../../lambda/api/employer-invite-lookup';
import { getDbPool, setRlsContext } from '../../../../lambda/lib/db';
import { hashInviteToken } from '../../../../lambda/lib/org-team';

jest.mock('../../../../lambda/lib/db');

const mockGetDbPool = getDbPool as jest.Mock;
const mockQuery = jest.fn();
const mockRelease = jest.fn();
const mockConnect = jest.fn();

const TOKEN = 'A'.repeat(20) + '_' + 'b'.repeat(20) + '-z'; // 43 base64url characters

function event(token: string | undefined): APIGatewayProxyEvent {
  return {
    httpMethod: 'GET',
    headers: {},
    pathParameters: token === undefined ? null : { token },
    requestContext: {},
  } as unknown as APIGatewayProxyEvent;
}

const VALID_ROW = {
  outcome: 'valid',
  company_name: 'ACME Roofing',
  email: 'foreman@example.com',
  contact_name: 'Pat Foreman',
  existing_account: false,
  expires_at: new Date('2026-10-30T12:00:00.000Z'),
};

describe('GET /employer/invites/{token} (employer-invite-lookup)', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    jest.clearAllMocks();
    mockQuery.mockReset();
    process.env = {
      ...originalEnv,
      TEAM_MANAGEMENT_ENABLED: 'true',
      DB_EXPECTED_LOGIN: 'jale_api_public',
      ALLOWED_ORIGIN: 'http://localhost:3000',
    };
    mockConnect.mockResolvedValue({ query: mockQuery, release: mockRelease });
    mockGetDbPool.mockResolvedValue({ connect: mockConnect, query: mockQuery });
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  it('flag off: 404 not_found', async () => {
    process.env.TEAM_MANAGEMENT_ENABLED = 'false';
    const res = await handler(event(TOKEN));
    expect(res.statusCode).toBe(404);
    expect(JSON.parse(res.body)).toEqual({ error: 'not_found' });
    expect(mockGetDbPool).not.toHaveBeenCalled();
  });

  it.each([
    ['missing', undefined],
    ['too short', 'abc'],
    ['42 characters', 'A'.repeat(42)],
    ['a + character', 'A'.repeat(42) + '+'],
    ['padding', 'A'.repeat(42) + '='],
  ])('malformed token: 404 invite_not_found without a DB call (%s)', async (_label, token) => {
    const res = await handler(event(token));
    expect(res.statusCode).toBe(404);
    expect(JSON.parse(res.body)).toEqual({ error: 'invite_not_found' });
    expect(mockGetDbPool).not.toHaveBeenCalled();
    expect(mockQuery).not.toHaveBeenCalled();
  });

  it('valid: 200 with the five fields', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [VALID_ROW] });
    const res = await handler(event(TOKEN));

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({
      companyName: 'ACME Roofing',
      email: 'foreman@example.com',
      contactName: 'Pat Foreman',
      existingAccount: false,
      expiresAt: '2026-10-30T12:00:00.000Z',
    });
    expect(res.headers).toEqual(expect.objectContaining({
      'Access-Control-Allow-Origin': 'http://localhost:3000',
      'Cache-Control': 'no-store',
    }));
    // The definer gets the token's hash, never the token.
    const [sql, params] = mockQuery.mock.calls[0];
    expect(String(sql)).toMatch(/FROM jale_cap\.org_team_invite_lookup\(\$1\)/);
    expect(params).toEqual([hashInviteToken(TOKEN)]);
    expect(JSON.stringify(mockQuery.mock.calls)).not.toContain(TOKEN);
    expect(mockRelease).toHaveBeenCalledTimes(1);
  });

  it('valid with an existing account and no contact name', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ ...VALID_ROW, existing_account: true, contact_name: null }] });
    const res = await handler(event(TOKEN));
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual(expect.objectContaining({ existingAccount: true, contactName: null }));
  });

  it.each([
    ['expired', 'invite_expired'],
    ['revoked', 'invite_revoked'],
    ['used', 'invite_used'],
  ])('expired / revoked / used: 410 with each error (%s)', async (outcome, error) => {
    mockQuery.mockResolvedValueOnce({ rows: [{ outcome, company_name: null, email: null, contact_name: null, existing_account: null, expires_at: null }] });
    const res = await handler(event(TOKEN));
    expect(res.statusCode).toBe(410);
    expect(JSON.parse(res.body)).toEqual({ error });
    expect(res.headers).toEqual(expect.objectContaining({ 'Cache-Control': 'no-store' }));
  });

  it('every answer is no-store (flag off, malformed, error)', async () => {
    const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    const malformed = await handler(event('x'));
    mockQuery.mockRejectedValueOnce(new Error('boom'));
    const failed = await handler(event(TOKEN));
    process.env.TEAM_MANAGEMENT_ENABLED = 'false';
    const off = await handler(event(TOKEN));
    for (const res of [malformed, failed, off]) {
      expect(res.headers).toEqual(expect.objectContaining({ 'Cache-Control': 'no-store' }));
    }
    errorSpy.mockRestore();
  });

  it('an unknown token: 404 invite_not_found', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ outcome: 'not_found', company_name: null, email: null, contact_name: null, existing_account: null, expires_at: null }] });
    const res = await handler(event(TOKEN));
    expect(res.statusCode).toBe(404);
    expect(JSON.parse(res.body)).toEqual({ error: 'invite_not_found' });
  });

  it('no Authorization needed; uses the jale_api_public pool', async () => {
    expect(INVITE_LOOKUP_DB_LOGIN).toBe('jale_api_public');
    mockQuery.mockResolvedValueOnce({ rows: [VALID_ROW] });
    // No authorizer claims and no Authorization header at all.
    const res = await handler(event(TOKEN));
    expect(res.statusCode).toBe(200);
    expect(mockGetDbPool).toHaveBeenCalledTimes(1);
    // A public request has no caller to state: no RLS context, no transaction.
    expect(setRlsContext).not.toHaveBeenCalled();
    expect(mockQuery.mock.calls.map(([sql]) => String(sql))).not.toContain('BEGIN');
  });

  it('refuses to run on any other login than jale_api_public (fail closed, no DB call)', async () => {
    const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    for (const login of ['jale_api', undefined]) {
      if (login === undefined) delete process.env.DB_EXPECTED_LOGIN;
      else process.env.DB_EXPECTED_LOGIN = login;
      const res = await handler(event(TOKEN));
      expect(res.statusCode).toBe(500);
      expect(JSON.parse(res.body)).toEqual({ error: 'internal_error' });
    }
    expect(mockGetDbPool).not.toHaveBeenCalled();
    errorSpy.mockRestore();
  });

  it('the token is never logged', async () => {
    const spies = (['log', 'info', 'warn', 'error', 'debug'] as const)
      .map((level) => jest.spyOn(console, level).mockImplementation(() => {}));
    try {
      // A DB failure whose message would carry the path, and an unknown outcome.
      mockQuery.mockRejectedValueOnce(new Error(`connection reset while serving /employer/invites/${TOKEN}`));
      const failed = await handler(event(TOKEN));
      expect(failed.statusCode).toBe(500);
      expect(JSON.parse(failed.body)).toEqual({ error: 'internal_error' });

      mockQuery.mockResolvedValueOnce({ rows: [{ outcome: 'surprise' }] });
      const unknown = await handler(event(TOKEN));
      expect(unknown.statusCode).toBe(500);

      mockQuery.mockResolvedValueOnce({ rows: [] });
      const empty = await handler(event(TOKEN));
      expect(empty.statusCode).toBe(500);

      const logged = JSON.stringify(spies.flatMap((spy) => spy.mock.calls));
      expect(spies.some((spy) => spy.mock.calls.length > 0)).toBe(true);
      expect(logged).not.toContain(TOKEN);
      expect(mockRelease).toHaveBeenCalledTimes(3);
    } finally {
      spies.forEach((spy) => spy.mockRestore());
    }
  });
});
