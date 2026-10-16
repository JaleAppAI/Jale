import type { APIGatewayProxyEvent } from 'aws-lambda';
import { createHash } from 'crypto';
import { handler } from '../../../../lambda/api/employer-upload-token';
import { getDbPool, setInternalUserRlsContext, setRlsContext } from '../../../../lambda/lib/db';
import { checkCompliance } from '../../../../lambda/legal/check-compliance';
import { setAuditContext } from '../../../../lambda/lib/audit/context';
import { callerFor, expectContextBeforeWrite, withRequestId } from './audit-expectations';

jest.mock('../../../../lambda/lib/db');
jest.mock('../../../../lambda/legal/check-compliance');
jest.mock('../../../../lambda/lib/audit/record', () => ({
  ...jest.requireActual('../../../../lambda/lib/audit/record'),
  recordAccess: jest.fn(),
  recordAttempt: jest.fn(),
}));
jest.mock('../../../../lambda/lib/audit/context');

import { resolveEmployerActor } from '../../../../lambda/lib/employer-actor';

jest.mock('../../../../lambda/lib/employer-actor', () => ({
  ...jest.requireActual('../../../../lambda/lib/employer-actor'),
  resolveEmployerActor: jest.fn(),
}));

const mockResolveEmployerActor = resolveEmployerActor as jest.Mock;
const ORG_ID = '99999999-9999-4999-8999-999999999999';
const OWNER_ID = 'aaaaaaaa-1111-4111-8111-111111111111';
const FOREMAN_ID = 'bbbbbbbb-2222-4222-8222-222222222222';
const actorResult = (userId: string, scopeUserIds: string[] = [userId]) => ({
  ok: true as const,
  actor: { userId, organizationId: ORG_ID, role: 'owner' as const, scopeUserIds },
});

const mockGetDbPool = getDbPool as jest.Mock;
const mockSetRlsContext = setRlsContext as jest.Mock;
const mockSetInternalUserRlsContext = setInternalUserRlsContext as jest.Mock;
const mockCheckCompliance = checkCompliance as jest.Mock;
const mockQuery = jest.fn();
const mockRelease = jest.fn();

/** Every statement and context switch, in order. */
const timeline: string[] = [];

type IssueOutcome = 'ok' | 'forbidden' | 'something_else';

function respond(opts: { applicant?: boolean; outcome?: IssueOutcome } = {}) {
  const { applicant = true, outcome = 'ok' } = opts;
  mockQuery.mockImplementation((sql: string) => {
    const text = sql.replace(/\s+/g, ' ').trim();
    timeline.push(text);
    if (/FROM job_applications ja/.test(text)) {
      return Promise.resolve({
        rows: applicant ? [{ job_id: 'j1', worker_id: 'w1', employer_user_id: 'employer-user-id' }] : [],
      });
    }
    if (/jale_cap\.upload_token_issue/.test(text)) {
      return Promise.resolve({ rows: [{ outcome, expires_at: new Date('2026-10-09T00:00:00Z') }] });
    }
    return Promise.resolve({ rows: [] });
  });
}

describe('employer-upload-token Lambda', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    timeline.length = 0;
    process.env.REQUIRED_TOS_VERSION = 'v1.0';
    process.env.ALLOWED_ORIGIN = 'https://jaleapp.ai';
    process.env.FRONTEND_BASE_URL = 'https://jaleapp.ai';
    mockGetDbPool.mockResolvedValue({
      connect: jest.fn().mockResolvedValue({ query: mockQuery, release: mockRelease }),
    });
    mockCheckCompliance.mockResolvedValue({ compliant: true, userExists: true });
    mockSetRlsContext.mockImplementation(async () => { timeline.push('SET SUB'); });
    mockSetInternalUserRlsContext.mockImplementation(async (_client: unknown, id: string) => { timeline.push(`SET INTERNAL ${id}`); });
    mockResolveEmployerActor.mockImplementation(async () => {
      timeline.push('RESOLVE ACTOR');
      return actorResult('employer-user-id');
    });
  });

  const makeEvent = (body: object) =>
    ({
      requestContext: { authorizer: { claims: { sub: 'employer-sub' } } },
      body: JSON.stringify(body),
    }) as unknown as APIGatewayProxyEvent;

  it('returns 400 if job_id or worker_id is missing', async () => {
    const res = await handler(makeEvent({ job_id: 'j1' }));
    expect(res.statusCode).toBe(400);
  });

  it('returns 403 if employer does not own the job or worker is not an applicant, and issues nothing', async () => {
    respond({ applicant: false });
    const res = await handler(makeEvent({ job_id: 'j1', worker_id: 'w1' }));
    expect(res.statusCode).toBe(403);
    expect(JSON.parse(res.body)).toEqual({ error: 'forbidden' });
    expect(timeline.some((step) => /upload_token_issue|document_upload_tokens/.test(step))).toBe(false);
  });

  it('returns 201 with an upload link; the token is issued through jale_cap.upload_token_issue with its hash only', async () => {
    respond();
    const res = await handler(makeEvent({ job_id: 'j1', worker_id: 'w1' }));
    expect(res.statusCode).toBe(201);
    const body = JSON.parse(res.body);
    expect(Object.keys(body)).toEqual(['upload_url']);
    const match = /^https:\/\/jaleapp\.ai\/en\/upload\/([0-9a-f]{64})$/.exec(body.upload_url);
    expect(match).not.toBeNull();

    const issue = mockQuery.mock.calls.find(([sql]) => /jale_cap\.upload_token_issue/.test(String(sql)));
    expect(String(issue![0])).toMatch(/SELECT outcome, expires_at FROM jale_cap\.upload_token_issue\(\$1, \$2, \$3\)/);
    // The database keeps the lower-case hex SHA-256 of the raw token, never the token.
    expect(issue![1]).toEqual([createHash('sha256').update(match![1]).digest('hex'), 'j1', 'w1']);
    expect(JSON.stringify(mockQuery.mock.calls)).not.toContain(match![1]);
    expect(timeline.some((step) => /INSERT INTO document_upload_tokens/.test(step))).toBe(false);
    expect(mockQuery).toHaveBeenCalledWith('COMMIT');
    expect(mockRelease).toHaveBeenCalled();
  });

  it("resolves the caller before the applicant check and never re-points the internal id at the job's employer", async () => {
    respond();
    await handler(makeEvent({ job_id: 'j1', worker_id: 'w1' }));
    const resolve = timeline.indexOf('RESOLVE ACTOR');
    const check = timeline.findIndex((step) => /FROM job_applications ja/.test(step));
    const issue = timeline.findIndex((step) => /upload_token_issue/.test(step));
    expect(resolve).toBeGreaterThan(timeline.indexOf('SET SUB'));
    expect(check).toBeGreaterThan(resolve);
    expect(issue).toBeGreaterThan(check);
    expect(timeline[check]).toContain('j.employer_id = ANY($3::uuid[])');
    expect(timeline[check]).not.toMatch(/employer_user_id|cognito_sub/);
    expect(timeline.some((step) => step.startsWith('SET INTERNAL'))).toBe(false);
  });

  it('answers the actor failure after COMMIT, checks nothing and issues nothing', async () => {
    respond();
    mockResolveEmployerActor.mockImplementation(async () => ({ ok: false, status: 403, error: 'membership_inactive' }));
    const res = await handler(makeEvent({ job_id: 'j1', worker_id: 'w1' }));
    expect(res.statusCode).toBe(403);
    expect(JSON.parse(res.body)).toEqual({ error: 'membership_inactive' });
    expect(mockQuery).toHaveBeenCalledWith('COMMIT');
    expect(timeline.some((step) => /job_applications|upload_token_issue/.test(step))).toBe(false);
    expect(setAuditContext).not.toHaveBeenCalled();
  });

  it("checks the applicant against an owner's whole scope and states the owner as the caller", async () => {
    respond();
    mockResolveEmployerActor.mockImplementation(async () => actorResult(OWNER_ID, [OWNER_ID, FOREMAN_ID]));
    const res = await handler(withRequestId(makeEvent({ job_id: 'j1', worker_id: 'w1' })));
    expect(res.statusCode).toBe(201);
    const check = mockQuery.mock.calls.find(([sql]) => /FROM job_applications ja/.test(String(sql)))!;
    expect(check[1]).toEqual(['j1', 'w1', [OWNER_ID, FOREMAN_ID]]);
    expect(setAuditContext).toHaveBeenCalledWith(
      expect.objectContaining({ query: mockQuery }), callerFor('employer', OWNER_ID), 'employer.upload_link');
  });

  it('returns 403 and rolls back when the function refuses the issue', async () => {
    respond({ outcome: 'forbidden' });
    const res = await handler(makeEvent({ job_id: 'j1', worker_id: 'w1' }));
    expect(res.statusCode).toBe(403);
    expect(JSON.parse(res.body)).toEqual({ error: 'forbidden' });
    expect(mockQuery).toHaveBeenCalledWith('ROLLBACK');
    expect(mockQuery).not.toHaveBeenCalledWith('COMMIT');
  });

  it('returns 500 and rolls back on an outcome it does not know', async () => {
    jest.spyOn(console, 'error').mockImplementation(() => {});
    respond({ outcome: 'something_else' });
    const res = await handler(makeEvent({ job_id: 'j1', worker_id: 'w1' }));
    expect(res.statusCode).toBe(500);
    expect(mockQuery).toHaveBeenCalledWith('ROLLBACK');
    expect(mockQuery).not.toHaveBeenCalledWith('COMMIT');
  });

  describe('change context', () => {
    it('states the employer before the link is issued', async () => {
      respond();
      const res = await handler(withRequestId(makeEvent({ job_id: 'j1', worker_id: 'w1' })));
      expect(res.statusCode).toBe(201);
      expect(setAuditContext).toHaveBeenCalledTimes(1);
      expect(setAuditContext).toHaveBeenCalledWith(
        expect.objectContaining({ query: mockQuery }), callerFor('employer', 'employer-user-id'), 'employer.upload_link');
      expectContextBeforeWrite(mockQuery, setAuditContext as jest.Mock, /jale_cap\.upload_token_issue/);
    });

    it('states nothing for a worker who is not an applicant', async () => {
      respond({ applicant: false });
      expect((await handler(makeEvent({ job_id: 'j1', worker_id: 'w1' }))).statusCode).toBe(403);
      expect(setAuditContext).not.toHaveBeenCalled();
    });
  });
});
