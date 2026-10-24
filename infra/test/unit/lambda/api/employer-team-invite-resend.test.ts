/**
 * POST /employer/team/resend (employer organizations, Phase 3, Task 7).
 */
import { createHash } from 'node:crypto';
import type { APIGatewayProxyEvent } from 'aws-lambda';
import { handler } from '../../../../lambda/api/employer-team-invite-resend';
import { getDbPool, setRlsContext } from '../../../../lambda/lib/db';
import { checkCompliance } from '../../../../lambda/legal/check-compliance';
import { resolveCompanyEntitlements } from '../../../../lambda/lib/entitlements';
import { resolveEmployerActor } from '../../../../lambda/lib/employer-actor';
import { applyMemberAccess } from '../../../../lambda/lib/member-access';

jest.mock('../../../../lambda/lib/db');
jest.mock('../../../../lambda/legal/check-compliance');
jest.mock('../../../../lambda/lib/entitlements');
jest.mock('../../../../lambda/lib/member-access');
jest.mock('../../../../lambda/lib/employer-actor', () => ({
  ...jest.requireActual('../../../../lambda/lib/employer-actor'),
  resolveEmployerActor: jest.fn(),
}));

const mockGetDbPool = getDbPool as jest.Mock;
const mockSetRlsContext = setRlsContext as jest.Mock;
const mockCheckCompliance = checkCompliance as jest.Mock;
const mockEntitlements = resolveCompanyEntitlements as jest.Mock;
const mockActor = resolveEmployerActor as jest.Mock;
const mockApplyMemberAccess = applyMemberAccess as jest.Mock;

const OWNER_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const ORG_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const INVITE_ID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const CREATED = new Date('2026-10-20T12:00:00Z');
const EXPIRES = new Date('2026-10-30T12:00:00Z');
const SENT = new Date('2026-10-23T12:00:00Z');

const ownerActor = { ok: true, actor: { userId: OWNER_ID, organizationId: ORG_ID, role: 'owner', scopeUserIds: [OWNER_ID] } };

const mockQuery = jest.fn();
const mockRelease = jest.fn();

let definerRow: Record<string, unknown>;

const resentRow = (over: Record<string, unknown> = {}) => ({
  outcome: 'resent',
  invite_id: INVITE_ID,
  email: 'ana@example.com',
  contact_name: null,
  created_at: CREATED,
  expires_at: EXPIRES,
  last_sent_at: SENT,
  company_name: 'Acme Builders',
  cognito_sub: null,
  retry_after_seconds: null,
  ...over,
});
const refusal = (outcome: string, retry: number | null = null) => ({
  outcome, invite_id: null, email: null, contact_name: null, created_at: null, expires_at: null,
  last_sent_at: null, company_name: null, cognito_sub: null, retry_after_seconds: retry,
});

const event = (body: unknown, method = 'POST') => ({
  httpMethod: method,
  requestContext: { authorizer: { claims: { sub: 'owner-sub' } } },
  body: JSON.stringify(body),
} as unknown as APIGatewayProxyEvent);

const validBody = { inviteId: INVITE_ID, locale: 'en' };
const sqlCalls = () => mockQuery.mock.calls.map((c) => String(c[0]));
const callIndex = (needle: string) => sqlCalls().findIndex((s) => s.includes(needle));
const definerParams = () => mockQuery.mock.calls[callIndex('org_team_invite_resend')][1];
const queueParams = () => mockQuery.mock.calls[callIndex('org_team_invite_queue_email')][1];
/** The key 133's queue_email derives: the invite id and the first 8 bytes of the stored hash. */
const idempotencyKey = (hash: Buffer) => `org-invite:${INVITE_ID}:${hash.subarray(0, 8).toString('hex')}`;

describe('employer-team-invite-resend', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    process.env.TEAM_MANAGEMENT_ENABLED = 'true';
    process.env.PUBLIC_SITE_BASE_URL = 'https://app.example.test';
    process.env.REQUIRED_TOS_VERSION = 'v1.0';
    mockGetDbPool.mockResolvedValue({ connect: jest.fn().mockResolvedValue({ query: mockQuery, release: mockRelease }) });
    mockSetRlsContext.mockResolvedValue(undefined);
    mockCheckCompliance.mockResolvedValue({ compliant: true, userExists: true });
    mockActor.mockResolvedValue(ownerActor);
    mockEntitlements.mockResolvedValue({ planCode: 'employer_pro', foremanSeatLimit: 2 });
    mockApplyMemberAccess.mockResolvedValue({ converged: 1, failed: [] });
    definerRow = resentRow();
    mockQuery.mockImplementation((sql: string) => {
      if (sql.includes('employer_org_usage')) {
        return Promise.resolve({ rows: [{ organization_id: ORG_ID, active_jobs: 0, templates: 0, active_foremen: 0, suspended_foremen: 0, pending_invites: 1 }] });
      }
      if (sql.includes('org_team_invite_resend')) return Promise.resolve({ rows: [definerRow] });
      return Promise.resolve({ rows: [{}] });
    });
  });

  afterAll(() => {
    delete process.env.TEAM_MANAGEMENT_ENABLED;
    delete process.env.PUBLIC_SITE_BASE_URL;
  });

  it('flag off: 404 not_found and no DB connection', async () => {
    delete process.env.TEAM_MANAGEMENT_ENABLED;
    const res = await handler(event(validBody));
    expect(res.statusCode).toBe(404);
    expect(mockGetDbPool).not.toHaveBeenCalled();
  });

  it('GET: 404 not_found', async () => {
    const res = await handler(event(validBody, 'GET'));
    expect(res.statusCode).toBe(404);
    expect(JSON.parse(res.body)).toEqual({ error: 'not_found' });
  });

  it.each([
    [{ inviteId: 'nope', locale: 'en' }, 'invalid_invite_id'],
    [{ locale: 'en' }, 'invalid_invite_id'],
    [{ inviteId: INVITE_ID, locale: 'de' }, 'invalid_locale'],
  ])('invalid invite id or locale: 400 before BEGIN (%#)', async (body, error) => {
    const res = await handler(event(body));
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body)).toEqual({ error });
    expect(mockGetDbPool).not.toHaveBeenCalled();
  });

  it('foreman: 403 owner_required, ROLLBACK, no definer call', async () => {
    mockActor.mockResolvedValue({ ok: true, actor: { ...ownerActor.actor, role: 'foreman' } });
    const res = await handler(event(validBody));
    expect(res.statusCode).toBe(403);
    expect(JSON.parse(res.body)).toEqual({ error: 'owner_required' });
    expect(sqlCalls()).toContain('ROLLBACK');
    expect(callIndex('org_team_invite_resend')).toBe(-1);
  });

  it('takes the company lock before resolving the plan and before the definer', async () => {
    await handler(event(validBody));
    const usageAt = callIndex('employer_org_usage');
    expect(mockQuery.mock.calls[usageAt][1]).toEqual([true]);
    expect(mockQuery.mock.invocationCallOrder[usageAt]).toBeLessThan(mockEntitlements.mock.invocationCallOrder[0]);
    expect(mockEntitlements.mock.invocationCallOrder[0])
      .toBeLessThan(mockQuery.mock.invocationCallOrder[callIndex('org_team_invite_resend')]);
    const [inviteId, hash, seatLimit] = definerParams();
    expect(inviteId).toBe(INVITE_ID);
    expect(hash).toHaveLength(32);
    expect(seatLimit).toBe(2);
  });

  it('too_soon: 429 with retry_after_seconds', async () => {
    definerRow = refusal('too_soon', 42);
    const res = await handler(event(validBody));
    expect(res.statusCode).toBe(429);
    expect(JSON.parse(res.body)).toEqual({ error: 'invite_rate_limited', retry_after_seconds: 42 });
    expect(sqlCalls()).toContain('ROLLBACK');
    expect(callIndex('org_team_invite_queue_email')).toBe(-1);
  });

  it('rate_limited (6th resend): 429 invite_rate_limited', async () => {
    definerRow = refusal('rate_limited');
    const res = await handler(event(validBody));
    expect(res.statusCode).toBe(429);
    expect(JSON.parse(res.body)).toEqual({ error: 'invite_rate_limited' });
    expect(callIndex('org_team_invite_queue_email')).toBe(-1);
  });

  // A unit test cannot see the key itself: 133's queue_email derives it in SQL
  // from the stored hash (org-invite:<id>:<hex of hash[0..8]>). This pins the
  // input to that derivation (a fresh token, and the hash of exactly the
  // emailed token). The real key, read back from email_outbox, was checked to
  // differ between two sends on the DB probe (task-7-report.md).
  it('resent: each resend emails a freshly minted token whose stored hash (the input of 133\'s idempotency key) differs from the previous send\'s', async () => {
    const res1 = await handler(event(validBody));
    expect(res1.statusCode).toBe(200);
    const hash1 = definerParams()[1] as Buffer;
    const token1 = /token=([A-Za-z0-9_-]{43})/.exec(String(queueParams()[2]))![1];
    expect(hash1.equals(createHash('sha256').update(token1).digest())).toBe(true);
    expect(sqlCalls()).toContain('COMMIT');
    expect(JSON.parse(res1.body)).toEqual({
      invite: {
        inviteId: INVITE_ID,
        email: 'ana@example.com',
        contactName: null,
        createdAt: CREATED.toISOString(),
        expiresAt: EXPIRES.toISOString(),
        lastSentAt: SENT.toISOString(),
        expired: false,
      },
      accessUpdated: true,
    });
    expect(String(queueParams()[2]).split('\n\n')[0]).toBe('Hi,');

    mockQuery.mockClear();
    await handler(event(validBody));
    const hash2 = definerParams()[1] as Buffer;
    const token2 = /token=([A-Za-z0-9_-]{43})/.exec(String(queueParams()[2]))![1];
    expect(token2).not.toBe(token1);
    expect(hash2.equals(createHash('sha256').update(token2).digest())).toBe(true);
    expect(idempotencyKey(hash2)).not.toBe(idempotencyKey(hash1));
  });

  it('resent for a removed member enables their Cognito user after COMMIT', async () => {
    definerRow = resentRow({ cognito_sub: 'removed-sub' });
    const res = await handler(event(validBody));
    expect(res.statusCode).toBe(200);
    expect(mockApplyMemberAccess).toHaveBeenCalledWith([{ cognitoSub: 'removed-sub', enabled: true }], expect.objectContaining({ deadlineAt: expect.any(Number) }));
    const commitAt = mockQuery.mock.invocationCallOrder[sqlCalls().indexOf('COMMIT')];
    expect(commitAt).toBeLessThan(mockApplyMemberAccess.mock.invocationCallOrder[0]);
    expect(mockRelease.mock.invocationCallOrder[0]).toBeLessThan(mockApplyMemberAccess.mock.invocationCallOrder[0]);
  });

  it('not_found: 404 invite_not_found', async () => {
    definerRow = refusal('not_found');
    const res = await handler(event(validBody));
    expect(res.statusCode).toBe(404);
    expect(JSON.parse(res.body)).toEqual({ error: 'invite_not_found' });
  });

  it('closed: 409 invite_closed', async () => {
    definerRow = refusal('closed');
    const res = await handler(event(validBody));
    expect(res.statusCode).toBe(409);
    expect(JSON.parse(res.body)).toEqual({ error: 'invite_closed' });
  });

  it('seat_limit_reached for an expired invite: 403, ROLLBACK, no email', async () => {
    definerRow = refusal('seat_limit_reached');
    const res = await handler(event(validBody));
    expect(res.statusCode).toBe(403);
    expect(JSON.parse(res.body)).toEqual({ error: 'seat_limit_reached' });
    expect(sqlCalls()).toContain('ROLLBACK');
    expect(sqlCalls()).not.toContain('COMMIT');
    expect(callIndex('org_team_invite_queue_email')).toBe(-1);
    expect(mockApplyMemberAccess).not.toHaveBeenCalled();
  });

  it.each([
    ['email_in_use', 409, 'email_in_use'],
    ['already_member', 409, 'already_member'],
    ['not_owner', 403, 'owner_required'],
  ])('%s: %i %s, ROLLBACK, no email', async (outcome, status, error) => {
    definerRow = refusal(outcome);
    const res = await handler(event(validBody));
    expect(res.statusCode).toBe(status);
    expect(JSON.parse(res.body)).toEqual({ error });
    expect(sqlCalls()).toContain('ROLLBACK');
    expect(sqlCalls()).not.toContain('COMMIT');
    expect(callIndex('org_team_invite_queue_email')).toBe(-1);
  });

  it.each([
    ['missing', undefined],
    ['http', 'http://app.example.test'],
  ])('a %s site base URL: 500 before any DB work (no lock, nothing written)', async (_label, base) => {
    if (base === undefined) delete process.env.PUBLIC_SITE_BASE_URL;
    else process.env.PUBLIC_SITE_BASE_URL = base;
    const spy = jest.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const res = await handler(event(validBody));
      expect(res.statusCode).toBe(500);
      expect(JSON.parse(res.body)).toEqual({ error: 'internal_error' });
      expect(mockGetDbPool).not.toHaveBeenCalled();
      expect(mockQuery).not.toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  });

  it('the resent email names the inviting owner, read as the actor before the email is queued', async () => {
    mockQuery.mockImplementation((sql: string) => {
      if (sql.includes('employer_org_usage')) {
        return Promise.resolve({ rows: [{ organization_id: ORG_ID, active_jobs: 0, templates: 0, active_foremen: 0, suspended_foremen: 0, pending_invites: 1 }] });
      }
      if (sql.includes('org_team_invite_resend')) return Promise.resolve({ rows: [definerRow] });
      if (sql.includes('inviter_name')) return Promise.resolve({ rows: [{ inviter_name: 'Luis Owner' }] });
      return Promise.resolve({ rows: [{}] });
    });
    await handler(event({ ...validBody, locale: 'es' }));
    const at = callIndex('inviter_name');
    expect(mockQuery.mock.calls[at][1]).toEqual([OWNER_ID]);
    expect(at).toBeLessThan(callIndex('org_team_invite_queue_email'));
    expect(String(queueParams()[2])).toContain('Invitación enviada por Luis Owner.');
  });

  it.each(['55P03', '57014'])('the company lock busy (%s): 503 busy, Retry-After 2, ROLLBACK, nothing sent, no Cognito', async (code) => {
    mockQuery.mockImplementation((sql: string) => (sql.includes('employer_org_usage')
      ? Promise.reject(Object.assign(new Error('lock timeout'), { code }))
      : Promise.resolve({ rows: [{}] })));
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const res = await handler(event(validBody));
    warn.mockRestore();
    expect(res.statusCode).toBe(503);
    expect(JSON.parse(res.body)).toEqual({ error: 'busy', retryable: true, retryAfterSeconds: 2 });
    expect(res.headers).toEqual(expect.objectContaining({ 'Retry-After': '2' }));
    const sqls = mockQuery.mock.calls.map((c) => String(c[0]));
    expect(sqls).toContain('ROLLBACK');
    expect(sqls).not.toContain('COMMIT');
    expect(sqls.some((s) => s.includes('org_team_invite_resend'))).toBe(false);
    expect(mockApplyMemberAccess).not.toHaveBeenCalled();
    expect(mockRelease).toHaveBeenCalled();
  });
});
