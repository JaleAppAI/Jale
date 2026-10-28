import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../errors';
import { MembershipBlockedError } from '../../api';
import {
  acceptInvite,
  createInvite,
  getMembership,
  getTeam,
  lookupInvite,
  reassignJob,
  removeMember,
  resendInvite,
  retryAfterSecondsOf,
  revokeInvite,
  startCompany,
  TEAM_ERROR_CODES,
  teamErrorMessageKey,
} from '../team';

// Node environment: apiFetch touches status / clone / json on what fetch returns.
function jsonResponse(body: unknown, status = 200): Response {
  const res = {
    ok: status >= 200 && status < 300,
    status,
    clone() { return res; },
    json: async () => body,
  };
  return res as unknown as Response;
}

type Init = RequestInit & { headers: Record<string, string> };

describe('team API client', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    vi.stubEnv('NEXT_PUBLIC_API_BASE_URL', 'https://api.example.test');
    vi.stubEnv('NEXT_PUBLIC_TEAM_MANAGEMENT_ENABLED', 'true');
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  function call(index = 0): { url: string; init: Init } {
    const [url, init] = fetchMock.mock.calls[index] as [string, Init];
    return { url, init };
  }

  const invite = {
    inviteId: '11111111-1111-4111-8111-111111111111',
    email: 'ana@example.com',
    contactName: 'Ana',
    createdAt: '2026-10-20T00:00:00.000Z',
    expiresAt: '2026-10-27T00:00:00.000Z',
    lastSentAt: '2026-10-20T00:00:00.000Z',
    expired: false,
  };

  it('getTeam: GET /employer/team/members with the auth header', async () => {
    const body = {
      seats: { limit: 3, active: 1, pending: 1, suspended: 0 },
      members: [],
      invites: [invite],
    };
    fetchMock.mockResolvedValue(jsonResponse(body));

    await expect(getTeam('tok')).resolves.toEqual(body);
    const { url, init } = call();
    expect(url).toBe('https://api.example.test/employer/team/members');
    expect(init.method ?? 'GET').toBe('GET');
    expect(init.headers.Authorization).toBe('tok');
  });

  it('createInvite: POST /employer/team/invite with email, contactName and locale', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ invite, accessUpdated: false }, 201));

    await expect(createInvite('tok', { email: 'ana@example.com', contactName: 'Ana', locale: 'es' }))
      .resolves.toEqual({ invite, accessUpdated: false });
    const { url, init } = call();
    expect(url).toBe('https://api.example.test/employer/team/invite');
    expect(init.method).toBe('POST');
    expect(init.headers.Authorization).toBe('tok');
    expect(JSON.parse(init.body as string)).toEqual({ email: 'ana@example.com', contactName: 'Ana', locale: 'es' });
  });

  it('createInvite: leaves contactName out when not given', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ invite, accessUpdated: false }, 201));
    await createInvite('tok', { email: 'ana@example.com', locale: 'en' });
    expect(JSON.parse(call().init.body as string)).toEqual({ email: 'ana@example.com', locale: 'en' });
  });

  it('resendInvite: POST /employer/team/resend with inviteId and locale', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ invite, accessUpdated: true }));

    await expect(resendInvite('tok', invite.inviteId, 'en')).resolves.toEqual({ invite, accessUpdated: true });
    const { url, init } = call();
    expect(url).toBe('https://api.example.test/employer/team/resend');
    expect(init.method).toBe('POST');
    expect(init.headers.Authorization).toBe('tok');
    expect(JSON.parse(init.body as string)).toEqual({ inviteId: invite.inviteId, locale: 'en' });
  });

  it('revokeInvite: POST /employer/team/revoke with inviteId', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ revoked: true, accessUpdated: false }));

    await expect(revokeInvite('tok', invite.inviteId)).resolves.toEqual({ revoked: true, accessUpdated: false });
    const { url, init } = call();
    expect(url).toBe('https://api.example.test/employer/team/revoke');
    expect(init.method).toBe('POST');
    expect(init.headers.Authorization).toBe('tok');
    expect(JSON.parse(init.body as string)).toEqual({ inviteId: invite.inviteId });
  });

  it('removeMember: POST /employer/team/remove with userId and reassignTo', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ removed: true, movedJobs: 2, accessUpdated: true }));

    await expect(removeMember('tok', 'u-foreman', 'u-owner')).resolves.toEqual({ removed: true, movedJobs: 2, accessUpdated: true });
    const { url, init } = call();
    expect(url).toBe('https://api.example.test/employer/team/remove');
    expect(init.method).toBe('POST');
    expect(init.headers.Authorization).toBe('tok');
    expect(JSON.parse(init.body as string)).toEqual({ userId: 'u-foreman', reassignTo: 'u-owner' });
  });

  it('reassignJob: POST /employer/team/reassign with jobId and userId', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ jobId: 'j1', assigneeUserId: 'u2', changed: true }));

    await expect(reassignJob('tok', 'j1', 'u2')).resolves.toEqual({ jobId: 'j1', assigneeUserId: 'u2', changed: true });
    const { url, init } = call();
    expect(url).toBe('https://api.example.test/employer/team/reassign');
    expect(init.method).toBe('POST');
    expect(init.headers.Authorization).toBe('tok');
    expect(JSON.parse(init.body as string)).toEqual({ jobId: 'j1', userId: 'u2' });
  });

  it('lookupInvite: GET /employer/invites/{token} with NO auth header, the token URL-encoded', async () => {
    const body = { companyName: 'Acme', email: 'ana@example.com', contactName: null, existingAccount: false, expiresAt: '2026-10-27T00:00:00.000Z' };
    fetchMock.mockResolvedValue(jsonResponse(body));

    await expect(lookupInvite('abc/def+_-')).resolves.toEqual(body);
    const { url, init } = call();
    expect(url).toBe('https://api.example.test/employer/invites/abc%2Fdef%2B_-');
    expect(init.method ?? 'GET').toBe('GET');
    expect(init.headers.Authorization).toBeUndefined();
  });

  it('lookupInvite: a 410 surfaces as ApiError with the backend code', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ error: 'invite_expired' }, 410));
    await expect(lookupInvite('t')).rejects.toMatchObject({ status: 410, code: 'invite_expired' });
  });

  it('acceptInvite: POST /employer/invites/{token} (no /accept suffix) with the id token', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ outcome: 'rejoined', organizationId: 'org-1' }));

    await expect(acceptInvite('id-tok', 'inv-tok')).resolves.toEqual({ outcome: 'rejoined', organizationId: 'org-1' });
    const { url, init } = call();
    expect(url).toBe('https://api.example.test/employer/invites/inv-tok');
    expect(init.method).toBe('POST');
    expect(init.headers.Authorization).toBe('id-tok');
  });

  it('getMembership: GET /employer/team/membership', async () => {
    const body = { userId: 'u1', organizationId: 'org-1', role: 'foreman', companyName: 'Acme' };
    fetchMock.mockResolvedValue(jsonResponse(body));

    await expect(getMembership('tok')).resolves.toEqual(body);
    const { url, init } = call();
    expect(url).toBe('https://api.example.test/employer/team/membership');
    expect(init.method ?? 'GET').toBe('GET');
    expect(init.headers.Authorization).toBe('tok');
  });

  it('getMembership: a blocked membership rejects with MembershipBlockedError carrying hasInvite', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ error: 'membership_inactive', membershipStatus: 'removed', hasInvite: true }, 403));
    const err = await getMembership('tok').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(MembershipBlockedError);
    expect(err).toMatchObject({ reason: 'removed', hasInvite: true });
  });

  it('startCompany: POST /employer/team/membership with companyName', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ organizationId: 'org-9', role: 'owner' }, 201));

    await expect(startCompany('tok', 'Acme Roofing')).resolves.toEqual({ organizationId: 'org-9', role: 'owner' });
    const { url, init } = call();
    expect(url).toBe('https://api.example.test/employer/team/membership');
    expect(init.method).toBe('POST');
    expect(init.headers.Authorization).toBe('tok');
    expect(JSON.parse(init.body as string)).toEqual({ companyName: 'Acme Roofing' });
  });

  it('errors surface as ApiError with code = the backend error and the camelCase wait', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ error: 'invite_rate_limited', retryAfterSeconds: 30 }, 429));
    const err = await createInvite('tok', { email: 'a@b.co', locale: 'en' }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err).toMatchObject({ status: 429, code: 'invite_rate_limited' });
    expect(retryAfterSecondsOf(err)).toBe(30);
  });

  it('a 503 busy is retried once after the body\'s retryAfterSeconds', async () => {
    vi.useFakeTimers();
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ error: 'busy', retryable: true, retryAfterSeconds: 2 }, 503))
      .mockResolvedValueOnce(jsonResponse({ removed: true, movedJobs: 0, accessUpdated: true }));

    const promise = removeMember('tok', 'u-foreman', 'u-owner');
    await vi.advanceTimersByTimeAsync(1999);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    await expect(promise).resolves.toEqual({ removed: true, movedJobs: 0, accessUpdated: true });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(JSON.parse(call(1).init.body as string)).toEqual({ userId: 'u-foreman', reassignTo: 'u-owner' });
  });

  it('a second 503 busy is surfaced as ApiError(503, busy), never a third attempt', async () => {
    vi.useFakeTimers();
    fetchMock.mockResolvedValue(jsonResponse({ error: 'busy', retryable: true, retryAfterSeconds: 2 }, 503));

    const promise = getTeam('tok').catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(2000);
    const err = await promise;
    expect(err).toMatchObject({ status: 503, code: 'busy' });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('a busy without a usable wait retries after 2 s; an absurd wait is capped', async () => {
    vi.useFakeTimers();
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ error: 'busy' }, 503))
      .mockResolvedValueOnce(jsonResponse({ outcome: 'accepted', organizationId: 'o' }));
    const first = acceptInvite('tok', 'inv');
    await vi.advanceTimersByTimeAsync(2000);
    await expect(first).resolves.toEqual({ outcome: 'accepted', organizationId: 'o' });

    fetchMock
      .mockResolvedValueOnce(jsonResponse({ error: 'busy', retryAfterSeconds: 3600 }, 503))
      .mockResolvedValueOnce(jsonResponse({ organizationId: 'o', role: 'owner' }, 201));
    const second = startCompany('tok', 'Acme');
    await vi.advanceTimersByTimeAsync(10_000);
    await expect(second).resolves.toEqual({ organizationId: 'o', role: 'owner' });
  });

  it('a 503 that is not busy is not retried', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ error: 'service_unavailable' }, 503));
    await expect(getTeam('tok')).rejects.toMatchObject({ status: 503, code: 'service_unavailable' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe('teamErrorMessageKey', () => {
  it('maps a known team code to employer_team.errors.<code> and anything else to errors.generic', () => {
    expect(teamErrorMessageKey(new ApiError(409, 'email_in_use'))).toBe('errors.email_in_use');
    expect(teamErrorMessageKey(new ApiError(409, 'job_move_conflict'))).toBe('errors.job_move_conflict');
    expect(teamErrorMessageKey(new ApiError(503, 'busy'))).toBe('errors.busy');
    expect(teamErrorMessageKey(new ApiError(500, 'internal_error'))).toBe('errors.generic');
    expect(teamErrorMessageKey(new ApiError(0, 'offline'))).toBe('errors.generic');
    expect(teamErrorMessageKey(new Error('boom'))).toBe('errors.generic');
    expect(teamErrorMessageKey(undefined)).toBe('errors.generic');
  });

  it('covers every team-route code in the backend contract', () => {
    for (const code of [
      'email_in_use', 'already_member', 'invite_pending', 'seat_limit_reached', 'invite_rate_limited',
      'invalid_email', 'invalid_contact_name', 'invite_closed', 'invite_not_found', 'member_not_found',
      'member_has_jobs', 'already_removed', 'cannot_remove_owner', 'invalid_assignee', 'job_not_found',
      'owner_required', 'employer_required', 'busy', 'job_move_conflict',
    ]) {
      expect(TEAM_ERROR_CODES).toContain(code);
    }
  });
});

describe('retryAfterSecondsOf', () => {
  it('reads the camelCase wait only, and is undefined otherwise', () => {
    expect(retryAfterSecondsOf(new ApiError(429, 'invite_rate_limited', { retryAfterSeconds: 9 }))).toBe(9);
    // The worker routes' snake_case key is not a team wait.
    expect(retryAfterSecondsOf(new ApiError(429, 'rate_limited', { retry_after_seconds: 5 }))).toBeUndefined();
    expect(retryAfterSecondsOf(new ApiError(429, 'invite_rate_limited'))).toBeUndefined();
    expect(retryAfterSecondsOf(new Error('x'))).toBeUndefined();
  });
});
