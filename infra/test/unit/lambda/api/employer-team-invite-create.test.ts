/**
 * POST /employer/team/invite (employer organizations, Phase 3, Task 7).
 * readCompanyUsage runs for real against the mocked client, so the company
 * lock is visible as employer_org_usage($1 = true) in the query log.
 */
import { createHash } from 'node:crypto';
import type { APIGatewayProxyEvent } from 'aws-lambda';
import { handler } from '../../../../lambda/api/employer-team-invite-create';
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
const CREATED = new Date('2026-10-23T12:00:00Z');
const EXPIRES = new Date('2026-10-30T12:00:00Z');

const ownerActor = { ok: true, actor: { userId: OWNER_ID, organizationId: ORG_ID, role: 'owner', scopeUserIds: [OWNER_ID] } };

const mockQuery = jest.fn();
const mockRelease = jest.fn();
const mockConnect = jest.fn();

type DefinerRow = Record<string, unknown>;
let definerRow: DefinerRow;
let usageError: unknown;

const createdRow = (over: DefinerRow = {}): DefinerRow => ({
  outcome: 'created',
  invite_id: INVITE_ID,
  email: 'ana@example.com',
  contact_name: 'Ana Ruiz',
  created_at: CREATED,
  expires_at: EXPIRES,
  last_sent_at: CREATED,
  company_name: 'Acme Builders',
  cognito_sub: null,
  ...over,
});
const refusal = (outcome: string): DefinerRow => ({
  outcome, invite_id: null, email: null, contact_name: null, created_at: null,
  expires_at: null, last_sent_at: null, company_name: null, cognito_sub: null,
});

const event = (body: unknown, method = 'POST', sub: string | null = 'owner-sub') => ({
  httpMethod: method,
  requestContext: { authorizer: sub ? { claims: { sub } } : undefined },
  body: typeof body === 'string' ? body : JSON.stringify(body),
} as unknown as APIGatewayProxyEvent);

const validBody = { email: 'Ana@Example.com ', contactName: ' Ana Ruiz ', locale: 'en' };

const sqlCalls = () => mockQuery.mock.calls.map((c) => String(c[0]));
const callIndex = (needle: string) => sqlCalls().findIndex((s) => s.includes(needle));
const queryOrder = (needle: string) => mockQuery.mock.invocationCallOrder[callIndex(needle)];
const definerParams = () => mockQuery.mock.calls[callIndex('org_team_invite_create')][1];
const queueParams = () => mockQuery.mock.calls[callIndex('org_team_invite_queue_email')][1];

describe('employer-team-invite-create', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    process.env.TEAM_MANAGEMENT_ENABLED = 'true';
    process.env.PUBLIC_SITE_BASE_URL = 'https://app.example.test';
    process.env.REQUIRED_TOS_VERSION = 'v1.0';
    mockConnect.mockResolvedValue({ query: mockQuery, release: mockRelease });
    mockGetDbPool.mockResolvedValue({ connect: mockConnect });
    mockSetRlsContext.mockResolvedValue(undefined);
    mockCheckCompliance.mockResolvedValue({ compliant: true, userExists: true });
    mockActor.mockResolvedValue(ownerActor);
    mockEntitlements.mockResolvedValue({ planCode: 'employer_pro', activeJobLimit: 10, templateLimit: 10, foremanSeatLimit: 3 });
    mockApplyMemberAccess.mockResolvedValue({ converged: 1, failed: [] });
    definerRow = createdRow();
    usageError = null;
    mockQuery.mockImplementation((sql: string) => {
      if (sql.includes('employer_org_usage')) {
        if (usageError) return Promise.reject(usageError);
        return Promise.resolve({ rows: [{ organization_id: ORG_ID, active_jobs: 0, templates: 0, active_foremen: 1, suspended_foremen: 0, pending_invites: 0 }] });
      }
      if (sql.includes('org_team_invite_create')) return Promise.resolve({ rows: [definerRow] });
      if (sql.includes('org_team_invite_queue_email')) return Promise.resolve({ rows: [{ org_team_invite_queue_email: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd' }] });
      return Promise.resolve({ rows: [] });
    });
  });

  afterAll(() => {
    delete process.env.TEAM_MANAGEMENT_ENABLED;
    delete process.env.PUBLIC_SITE_BASE_URL;
  });

  it('flag off: 404 not_found and no DB connection', async () => {
    process.env.TEAM_MANAGEMENT_ENABLED = 'false';
    const res = await handler(event(validBody));
    expect(res.statusCode).toBe(404);
    expect(JSON.parse(res.body)).toEqual({ error: 'not_found' });
    expect(mockGetDbPool).not.toHaveBeenCalled();
  });

  it('missing sub: 401', async () => {
    const res = await handler(event(validBody, 'POST', null));
    expect(res.statusCode).toBe(401);
    expect(mockGetDbPool).not.toHaveBeenCalled();
  });

  it('GET: 404 not_found', async () => {
    const res = await handler(event(validBody, 'GET'));
    expect(res.statusCode).toBe(404);
    expect(JSON.parse(res.body)).toEqual({ error: 'not_found' });
    expect(mockGetDbPool).not.toHaveBeenCalled();
  });

  it('foreman: 403 owner_required, ROLLBACK, no definer call', async () => {
    mockActor.mockResolvedValue({ ok: true, actor: { ...ownerActor.actor, role: 'foreman' } });
    const res = await handler(event(validBody));
    expect(res.statusCode).toBe(403);
    expect(JSON.parse(res.body)).toEqual({ error: 'owner_required' });
    expect(sqlCalls()).toContain('ROLLBACK');
    expect(callIndex('org_team_invite_create')).toBe(-1);
    expect(callIndex('employer_org_usage')).toBe(-1);
    expect(mockRelease).toHaveBeenCalled();
  });

  it('a login that is not an employer: 403 employer_required', async () => {
    mockActor.mockResolvedValue({ ok: false, status: 409, error: 'user_not_provisioned' });
    const res = await handler(event(validBody));
    expect(res.statusCode).toBe(403);
    expect(JSON.parse(res.body)).toEqual({ error: 'employer_required' });
    expect(callIndex('org_team_invite_create')).toBe(-1);
  });

  it('a removed member: 403 membership_inactive with their status', async () => {
    mockActor.mockResolvedValue({ ok: false, status: 403, error: 'membership_inactive', membershipStatus: 'removed' });
    const res = await handler(event(validBody));
    expect(res.statusCode).toBe(403);
    expect(JSON.parse(res.body)).toEqual({ error: 'membership_inactive', membershipStatus: 'removed' });
  });

  it('legal not accepted: 403 legal_required, no definer call', async () => {
    mockCheckCompliance.mockResolvedValue({ compliant: false, userExists: true, currentVersion: 'v0.9' });
    const res = await handler(event(validBody));
    expect(res.statusCode).toBe(403);
    expect(JSON.parse(res.body)).toEqual({ error: 'legal_required', requiredVersion: 'v1.0', currentVersion: 'v0.9' });
    expect(callIndex('org_team_invite_create')).toBe(-1);
  });

  it('takes the company lock before resolving the plan and before the definer', async () => {
    const res = await handler(event(validBody));
    expect(res.statusCode).toBe(201);
    const usageAt = callIndex('employer_org_usage');
    expect(usageAt).toBeGreaterThanOrEqual(0);
    expect(mockQuery.mock.calls[usageAt][1]).toEqual([true]);
    expect(queryOrder('employer_org_usage')).toBeLessThan(mockEntitlements.mock.invocationCallOrder[0]);
    expect(mockEntitlements.mock.invocationCallOrder[0]).toBeLessThan(queryOrder('org_team_invite_create'));
    expect(mockEntitlements).toHaveBeenCalledWith(expect.anything(), ORG_ID);
    expect(callIndex('BEGIN')).toBeLessThan(usageAt);
  });

  it('passes the plan\'s seat limit, the trimmed email and contact name to the definer', async () => {
    await handler(event(validBody));
    const [email, contactName, hash, seatLimit] = definerParams();
    expect(email).toBe('Ana@Example.com');
    expect(contactName).toBe('Ana Ruiz');
    expect(Buffer.isBuffer(hash)).toBe(true);
    expect(hash).toHaveLength(32);
    expect(seatLimit).toBe(3);
  });

  it('a blank contact name goes to the definer as null', async () => {
    await handler(event({ ...validBody, contactName: '   ' }));
    expect(definerParams()[1]).toBeNull();
    await handler(event({ email: 'a@b.co', locale: 'es' }));
    expect(definerParams()[1]).toBeNull();
  });

  it('created: queues the email through org_team_invite_queue_email with the URL carrying the minted token; COMMIT; 201 with createdAt, lastSentAt and expired false', async () => {
    const res = await handler(event(validBody));
    expect(res.statusCode).toBe(201);
    expect(JSON.parse(res.body)).toEqual({
      invite: {
        inviteId: INVITE_ID,
        email: 'ana@example.com',
        contactName: 'Ana Ruiz',
        createdAt: CREATED.toISOString(),
        expiresAt: EXPIRES.toISOString(),
        lastSentAt: CREATED.toISOString(),
        expired: false,
      },
      accessUpdated: true,
    });
    const [inviteId, subject, bodyText, bodyHtml] = queueParams();
    expect(inviteId).toBe(INVITE_ID);
    expect(subject).toBe('Acme Builders invited you to Jale');
    const match = /https:\/\/app\.example\.test\/en\/auth\/employer\/invite\?token=([A-Za-z0-9_-]{43})/.exec(bodyText);
    expect(match).not.toBeNull();
    expect(bodyHtml).toContain(`token=${match![1]}`);
    expect(bodyText).toContain('Hi Ana Ruiz,');
    // queued inside the transaction, then COMMIT
    const sql = sqlCalls();
    expect(callIndex('org_team_invite_create')).toBeLessThan(callIndex('org_team_invite_queue_email'));
    expect(callIndex('org_team_invite_queue_email')).toBeLessThan(sql.indexOf('COMMIT'));
    expect(sql).not.toContain('ROLLBACK');
    expect(sql.some((s) => /email_outbox/.test(s))).toBe(false);
    expect(mockApplyMemberAccess).not.toHaveBeenCalled();
    expect(mockRelease).toHaveBeenCalledTimes(1);
  });

  it('the email follows the requested locale', async () => {
    await handler(event({ ...validBody, locale: 'es' }));
    const [, subject, bodyText] = queueParams();
    expect(subject).toBe('Acme Builders lo invitó a Jale');
    expect(bodyText).toContain('https://app.example.test/es/auth/employer/invite?token=');
  });

  it('the stored hash is the sha256 of the emailed token', async () => {
    await handler(event(validBody));
    const hash = definerParams()[2] as Buffer;
    const token = /token=([A-Za-z0-9_-]{43})/.exec(queueParams()[2] as string)![1];
    expect(hash.equals(createHash('sha256').update(token, 'utf8').digest())).toBe(true);
  });

  it('seat_limit_reached: 403, ROLLBACK, no email', async () => {
    definerRow = refusal('seat_limit_reached');
    const res = await handler(event(validBody));
    expect(res.statusCode).toBe(403);
    expect(JSON.parse(res.body)).toEqual({ error: 'seat_limit_reached' });
    expect(sqlCalls()).toContain('ROLLBACK');
    expect(sqlCalls()).not.toContain('COMMIT');
    expect(callIndex('org_team_invite_queue_email')).toBe(-1);
  });

  it.each(['email_in_use', 'invite_pending', 'already_member'])('email_in_use / invite_pending / already_member: 409 with that error (%s)', async (outcome) => {
    definerRow = refusal(outcome);
    const res = await handler(event(validBody));
    expect(res.statusCode).toBe(409);
    expect(JSON.parse(res.body)).toEqual({ error: outcome });
    expect(sqlCalls()).toContain('ROLLBACK');
    expect(callIndex('org_team_invite_queue_email')).toBe(-1);
  });

  it('rate_limited: 429 invite_rate_limited', async () => {
    definerRow = refusal('rate_limited');
    const res = await handler(event(validBody));
    expect(res.statusCode).toBe(429);
    expect(JSON.parse(res.body)).toEqual({ error: 'invite_rate_limited' });
  });

  it('the definer\'s invalid_email and not_owner map through the shared table', async () => {
    definerRow = refusal('invalid_email');
    expect((await handler(event(validBody))).statusCode).toBe(400);
    definerRow = refusal('not_owner');
    const res = await handler(event(validBody));
    expect(res.statusCode).toBe(403);
    expect(JSON.parse(res.body)).toEqual({ error: 'owner_required' });
  });

  it('re-inviting a removed member enables their Cognito user after COMMIT', async () => {
    definerRow = createdRow({ cognito_sub: 'removed-sub' });
    const before = Date.now();
    const res = await handler(event(validBody));
    expect(res.statusCode).toBe(201);
    expect(JSON.parse(res.body).accessUpdated).toBe(true);
    expect(mockApplyMemberAccess).toHaveBeenCalledWith(
      [{ cognitoSub: 'removed-sub', enabled: true }],
      expect.objectContaining({ deadlineAt: expect.any(Number) }),
    );
    const deadline = mockApplyMemberAccess.mock.calls[0][1].deadlineAt as number;
    expect(deadline).toBeGreaterThanOrEqual(before + 9000);
    expect(deadline).toBeLessThanOrEqual(Date.now() + 11000);
    const commitAt = mockQuery.mock.invocationCallOrder[sqlCalls().indexOf('COMMIT')];
    expect(commitAt).toBeLessThan(mockApplyMemberAccess.mock.invocationCallOrder[0]);
    // The client is released before Cognito is called.
    expect(mockRelease.mock.invocationCallOrder[0]).toBeLessThan(mockApplyMemberAccess.mock.invocationCallOrder[0]);
  });

  it('a Cognito failure after COMMIT still answers 201, with accessUpdated false', async () => {
    definerRow = createdRow({ cognito_sub: 'removed-sub' });
    mockApplyMemberAccess.mockResolvedValue({ converged: 0, failed: ['removed-sub'] });
    const res = await handler(event(validBody));
    expect(res.statusCode).toBe(201);
    expect(JSON.parse(res.body).accessUpdated).toBe(false);
  });

  it.each([
    [{ ...validBody, email: 42 }, 'invalid_email'],
    [{ ...validBody, email: '   ' }, 'invalid_email'],
    [{ ...validBody, email: `${'a'.repeat(250)}@b.co` }, 'invalid_email'],
    [{ locale: 'en' }, 'invalid_email'],
    [{ ...validBody, contactName: 'x'.repeat(121) }, 'invalid_contact_name'],
    [{ ...validBody, contactName: 7 }, 'invalid_contact_name'],
    [{ ...validBody, locale: 'fr' }, 'invalid_locale'],
    [{ email: 'a@b.co' }, 'invalid_locale'],
  ])('invalid email, contact name or locale: 400 before BEGIN (%#)', async (body, error) => {
    const res = await handler(event(body));
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body)).toEqual({ error });
    expect(mockGetDbPool).not.toHaveBeenCalled();
  });

  it('a 120-character contact name is accepted, counted by code point', async () => {
    const res = await handler(event({ ...validBody, contactName: '😀'.repeat(120) }));
    expect(res.statusCode).toBe(201);
  });

  it('an unparseable body: 400 invalid_body before BEGIN', async () => {
    const res = await handler(event('{not json'));
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body)).toEqual({ error: 'invalid_body' });
    expect(mockGetDbPool).not.toHaveBeenCalled();
  });

  it('a definer 42501 for an inactive caller: 403 membership_inactive', async () => {
    usageError = Object.assign(new Error('employer_org_usage: the caller is not an active member of a company'), { code: '42501' });
    const res = await handler(event(validBody));
    expect(res.statusCode).toBe(403);
    expect(JSON.parse(res.body)).toEqual({ error: 'membership_inactive' });
    expect(sqlCalls()).toContain('ROLLBACK');
    expect(callIndex('org_team_invite_create')).toBe(-1);
  });

  it('usage for another company than the actor\'s: 500, ROLLBACK', async () => {
    mockActor.mockResolvedValue({ ok: true, actor: { ...ownerActor.actor, organizationId: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee' } });
    const res = await handler(event(validBody));
    expect(res.statusCode).toBe(500);
    expect(sqlCalls()).toContain('ROLLBACK');
    expect(callIndex('org_team_invite_create')).toBe(-1);
  });

  it.each([
    ['missing', undefined],
    ['http', 'http://app.example.test'],
    ['a bare host', 'app.example.test'],
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
      expect(spy).toHaveBeenCalledWith(expect.any(String), '', 'invite_base_url_missing');
    } finally {
      spy.mockRestore();
    }
  });

  it('the email names the inviting owner, read as the actor inside the transaction', async () => {
    mockQuery.mockImplementation((sql: string) => {
      if (sql.includes('employer_org_usage')) {
        return Promise.resolve({ rows: [{ organization_id: ORG_ID, active_jobs: 0, templates: 0, active_foremen: 0, suspended_foremen: 0, pending_invites: 0 }] });
      }
      if (sql.includes('org_team_invite_create')) return Promise.resolve({ rows: [definerRow] });
      if (sql.includes('inviter_name')) return Promise.resolve({ rows: [{ inviter_name: 'Luis\r\nOwner' }] });
      return Promise.resolve({ rows: [{}] });
    });
    const res = await handler(event(validBody));
    expect(res.statusCode).toBe(201);
    const at = callIndex('inviter_name');
    expect(mockQuery.mock.calls[at][1]).toEqual([OWNER_ID]);
    expect(String(mockQuery.mock.calls[at][0])).toMatch(/COALESCE\(NULLIF\(btrim\(ep\.contact_name\), ''\), NULLIF\(btrim\(u\.full_name\), ''\)\)/);
    expect(at).toBeGreaterThan(callIndex('org_team_invite_create'));
    expect(at).toBeLessThan(callIndex('org_team_invite_queue_email'));
    const [, , bodyText, bodyHtml] = queueParams();
    expect(bodyText).toContain('Invited by Luis Owner.');
    expect(bodyHtml).toContain('Invited by Luis Owner.');
  });

  it('an owner with no name: no inviter line, still 201', async () => {
    const res = await handler(event(validBody));
    expect(res.statusCode).toBe(201);
    expect(String(queueParams()[2])).not.toContain('Invited by');
  });

  it('a refused invite reads no inviter name', async () => {
    definerRow = refusal('seat_limit_reached');
    await handler(event(validBody));
    expect(callIndex('inviter_name')).toBe(-1);
  });

  it('the raw token never appears in a log line', async () => {
    const spies = (['log', 'info', 'warn', 'error', 'debug'] as const).map((m) => jest.spyOn(console, m).mockImplementation(() => {}));
    try {
      // A queue failure whose message names the token.
      mockQuery.mockImplementation((sql: string, params?: unknown[]) => {
        if (sql.includes('employer_org_usage')) {
          return Promise.resolve({ rows: [{ organization_id: ORG_ID, active_jobs: 0, templates: 0, active_foremen: 0, suspended_foremen: 0, pending_invites: 0 }] });
        }
        if (sql.includes('org_team_invite_create')) return Promise.resolve({ rows: [createdRow()] });
        if (sql.includes('org_team_invite_queue_email')) {
          return Promise.reject(Object.assign(new Error(`boom ${String(params?.[2])}`), { code: '23514' }));
        }
        return Promise.resolve({ rows: [] });
      });
      const res = await handler(event(validBody));
      expect(res.statusCode).toBe(500);
      const token = /token=([A-Za-z0-9_-]{43})/.exec(String(queueParams()[2]))![1];
      const logged = spies.flatMap((s) => s.mock.calls.map((c) => c.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ')));
      expect(logged.length).toBeGreaterThan(0);
      for (const line of logged) expect(line).not.toContain(token);

      // And on success nothing logs it either.
      jest.clearAllMocks();
      mockConnect.mockResolvedValue({ query: mockQuery, release: mockRelease });
      mockGetDbPool.mockResolvedValue({ connect: mockConnect });
      mockActor.mockResolvedValue(ownerActor);
      mockCheckCompliance.mockResolvedValue({ compliant: true, userExists: true });
      mockEntitlements.mockResolvedValue({ foremanSeatLimit: 3 });
      mockApplyMemberAccess.mockResolvedValue({ converged: 1, failed: [] });
      mockQuery.mockImplementation((sql: string) => {
        if (sql.includes('employer_org_usage')) {
          return Promise.resolve({ rows: [{ organization_id: ORG_ID, active_jobs: 0, templates: 0, active_foremen: 0, suspended_foremen: 0, pending_invites: 0 }] });
        }
        if (sql.includes('org_team_invite_create')) return Promise.resolve({ rows: [createdRow({ cognito_sub: 's' })] });
        return Promise.resolve({ rows: [{}] });
      });
      expect((await handler(event(validBody))).statusCode).toBe(201);
      const token2 = /token=([A-Za-z0-9_-]{43})/.exec(String(queueParams()[2]))![1];
      for (const s of spies) for (const c of s.mock.calls) expect(c.map(String).join(' ')).not.toContain(token2);
    } finally {
      for (const s of spies) s.mockRestore();
    }
  });
});
