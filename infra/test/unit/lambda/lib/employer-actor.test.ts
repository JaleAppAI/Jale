import { resolveEmployerActor, employerActorFailureResponse } from '../../../../lambda/lib/employer-actor';
import { setInternalUserRlsContext } from '../../../../lambda/lib/db';

jest.mock('../../../../lambda/lib/db');

const OWNER = '11111111-1111-4111-8111-111111111111';
const FOREMAN = '22222222-2222-4222-8222-222222222222';
const ORG = '33333333-3333-4333-8333-333333333333';

function clientWith(...results: Array<{ rows: unknown[] }>) {
  const query = jest.fn();
  for (const r of results) query.mockResolvedValueOnce(r);
  return { query } as unknown as import('pg').PoolClient & { query: jest.Mock };
}

describe('resolveEmployerActor', () => {
  beforeEach(() => jest.resetAllMocks());

  it('returns an owner scoped to every member, owner first, and sets the internal caller', async () => {
    const client = clientWith(
      { rows: [{ user_id: OWNER, organization_id: ORG, role: 'owner', status: 'active' }] },
      { rows: [{ user_id: OWNER }, { user_id: FOREMAN }] },
    );
    const result = await resolveEmployerActor(client, 'sub-owner');
    expect(result).toEqual({ ok: true, actor: { userId: OWNER, organizationId: ORG, role: 'owner', scopeUserIds: [OWNER, FOREMAN] } });
    expect(setInternalUserRlsContext).toHaveBeenCalledWith(client, OWNER);
    // The member query runs after the internal caller is set (the owner policy reads it).
    const setAt = (setInternalUserRlsContext as jest.Mock).mock.invocationCallOrder[0];
    const memberQueryAt = client.query.mock.invocationCallOrder[1];
    expect(setAt).toBeLessThan(memberQueryAt);
    expect(client.query.mock.calls[1][1]).toEqual([ORG, OWNER]);
  });

  it('returns a foreman scoped to themself, with no member query', async () => {
    const client = clientWith({ rows: [{ user_id: FOREMAN, organization_id: ORG, role: 'foreman', status: 'active' }] });
    const result = await resolveEmployerActor(client, 'sub-foreman');
    expect(result).toEqual({ ok: true, actor: { userId: FOREMAN, organizationId: ORG, role: 'foreman', scopeUserIds: [FOREMAN] } });
    expect(client.query).toHaveBeenCalledTimes(1);
  });

  it('409 user_not_provisioned when there is no employer users row', async () => {
    const client = clientWith({ rows: [] });
    expect(await resolveEmployerActor(client, 'sub-x')).toEqual({ ok: false, status: 409, error: 'user_not_provisioned' });
    expect(setInternalUserRlsContext).not.toHaveBeenCalled();
  });

  it('403 no_organization when the employer has no membership row', async () => {
    const client = clientWith({ rows: [{ user_id: OWNER, organization_id: null, role: null, status: null }] });
    expect(await resolveEmployerActor(client, 'sub-x')).toEqual({ ok: false, status: 403, error: 'no_organization' });
    expect(setInternalUserRlsContext).not.toHaveBeenCalled();
  });

  it('a suspended member: 403 membership_inactive with membershipStatus suspended', async () => {
    const client = clientWith({ rows: [{ user_id: FOREMAN, organization_id: ORG, role: 'foreman', status: 'suspended' }] });
    expect(await resolveEmployerActor(client, 'sub-x'))
      .toEqual({ ok: false, status: 403, error: 'membership_inactive', membershipStatus: 'suspended' });
    expect(setInternalUserRlsContext).not.toHaveBeenCalled();
  });

  it('a removed member: 403 membership_inactive with membershipStatus removed', async () => {
    const client = clientWith({ rows: [{ user_id: FOREMAN, organization_id: ORG, role: 'foreman', status: 'removed' }] });
    expect(await resolveEmployerActor(client, 'sub-x'))
      .toEqual({ ok: false, status: 403, error: 'membership_inactive', membershipStatus: 'removed' });
    expect(setInternalUserRlsContext).not.toHaveBeenCalled();
  });

  it('a status it does not know is still inactive, with no membershipStatus', async () => {
    const client = clientWith({ rows: [{ user_id: FOREMAN, organization_id: ORG, role: 'foreman', status: 'paused' }] });
    expect(await resolveEmployerActor(client, 'sub-x')).toEqual({ ok: false, status: 403, error: 'membership_inactive' });
    expect(setInternalUserRlsContext).not.toHaveBeenCalled();
  });

  it('locks the users row only when asked', async () => {
    const plain = clientWith({ rows: [{ user_id: FOREMAN, organization_id: ORG, role: 'foreman', status: 'active' }] });
    await resolveEmployerActor(plain, 'sub-x');
    expect(String(plain.query.mock.calls[0][0])).not.toContain('FOR UPDATE');

    const locked = clientWith({ rows: [{ user_id: FOREMAN, organization_id: ORG, role: 'foreman', status: 'active' }] });
    await resolveEmployerActor(locked, 'sub-x', { lockUser: true });
    expect(String(locked.query.mock.calls[0][0])).toContain('FOR UPDATE OF u');
  });

  it('looks the caller up by sub, employers only', async () => {
    const client = clientWith({ rows: [] });
    await resolveEmployerActor(client, 'sub-x');
    const [sql, params] = client.query.mock.calls[0];
    expect(String(sql)).toContain("u.user_type = 'employer'");
    expect(params).toEqual(['sub-x']);
  });
});

describe('employerActorFailureResponse', () => {
  it('maps a failure to its status and error body', () => {
    expect(employerActorFailureResponse({ ok: false, status: 403, error: 'membership_inactive' }, { a: 'b' }))
      .toEqual({ statusCode: 403, headers: { a: 'b' }, body: JSON.stringify({ error: 'membership_inactive' }) });
  });

  it('the failure response body carries membershipStatus', () => {
    const res = employerActorFailureResponse(
      { ok: false, status: 403, error: 'membership_inactive', membershipStatus: 'suspended' }, { a: 'b' },
    );
    expect(res.statusCode).toBe(403);
    expect(JSON.parse(res.body)).toEqual({ error: 'membership_inactive', membershipStatus: 'suspended' });
  });

  it('a removed member\'s failure response body carries membershipStatus removed', async () => {
    const client = clientWith({ rows: [{ user_id: FOREMAN, organization_id: ORG, role: 'foreman', status: 'removed' }] });
    const failure = await resolveEmployerActor(client, 'sub-x');
    if (failure.ok) throw new Error('expected a failure');
    const res = employerActorFailureResponse(failure, { a: 'b' });
    expect(res).toEqual({
      statusCode: 403, headers: { a: 'b' }, body: JSON.stringify({ error: 'membership_inactive', membershipStatus: 'removed' }),
    });
  });

  it('no_organization carries no membershipStatus', async () => {
    const client = clientWith({ rows: [{ user_id: OWNER, organization_id: null, role: null, status: null }] });
    const failure = await resolveEmployerActor(client, 'sub-x');
    if (failure.ok) throw new Error('expected a failure');
    expect(failure).not.toHaveProperty('membershipStatus');
    expect(JSON.parse(employerActorFailureResponse(failure, {}).body)).toEqual({ error: 'no_organization' });
    expect(JSON.parse(employerActorFailureResponse({ ok: false, status: 409, error: 'user_not_provisioned' }, {}).body))
      .toEqual({ error: 'user_not_provisioned' });
  });
});
