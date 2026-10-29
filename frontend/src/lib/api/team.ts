import { apiFetch } from '../api';
import { ApiError, parseApiError } from './errors';

// ---------------------------------------------------------------------------
// Team management (Phase 3)
//
// Typed to the Lambda responses as built (infra/lambda/api/employer-team*.ts,
// employer-invite-*.ts, employer-membership.ts). Routes, all behind the
// TEAM_MANAGEMENT_ENABLED flag (off: every one answers 404 `not_found`):
//   GET  /employer/team/members       the owner's team list
//   GET  /employer/team/membership    the caller's own membership
//   POST /employer/team/{invite|resend|revoke|remove|reassign}
//   POST /employer/team/membership    start my own company
//   GET  /employer/invites/{token}    public invite lookup (no auth)
//   POST /employer/invites/{token}    accept (no `/accept` suffix)
//
// Errors are `ApiError` with `code` = the backend's `error`. A 403
// `no_organization` / `membership_inactive` never reaches a caller here: with
// the flag on, `apiFetch` raises `MembershipBlockedError` for it first.
//
// 503 `busy` (a lock wait or statement timeout: nothing was written) is
// retried ONCE here, after the body's `retryAfterSeconds` -- the
// `Retry-After` header is not readable cross-origin. A second `busy` is the
// caller's `ApiError(503, 'busy')`.
// ---------------------------------------------------------------------------

export type TeamLocale = 'en' | 'es';

export type TeamSeats = { limit: number; active: number; pending: number; suspended: number };

export type TeamMember = {
  userId: string;
  name: string;
  email: string;
  role: 'owner' | 'foreman';
  /** The list never carries removed members. */
  status: 'active' | 'suspended';
  billingSuspended: boolean;
  joinedAt: string;
  activeJobs: number;
  openJobs: number;
};

export type TeamInvite = {
  inviteId: string;
  email: string;
  contactName: string | null;
  createdAt: string;
  expiresAt: string;
  lastSentAt: string;
  /** Always false on a create or resend answer; the list flags expired-but-pending invites. */
  expired: boolean;
};

export type TeamList = { seats: TeamSeats; members: TeamMember[]; invites: TeamInvite[] };

/** Create and resend. `accessUpdated`: whether the member-access (Cognito) sync after COMMIT finished. */
export type InviteWriteResult = { invite: TeamInvite; accessUpdated: boolean };

export type RevokeInviteResult = { revoked: true; accessUpdated: boolean };

export type RemoveMemberResult = { removed: true; movedJobs: number; accessUpdated: boolean };

export type ReassignJobResult = { jobId: string; assigneeUserId: string; changed: boolean };

export type InviteLookup = {
  companyName: string;
  email: string;
  contactName: string | null;
  existingAccount: boolean;
  /** ISO time; the handler answers null only if the row had none. */
  expiresAt: string | null;
};

export type AcceptInviteResult = { outcome: 'accepted' | 'rejoined'; organizationId: string };

/** GET membership, active member. A blocked one rejects with `MembershipBlockedError`. */
export type MembershipInfo = {
  userId: string;
  organizationId: string;
  role: 'owner' | 'foreman';
  companyName: string;
};

export type StartCompanyResult = { organizationId: string; role: 'owner' };

/** The wait when a `busy` body names none; and the most this client will wait. */
export const BUSY_RETRY_DEFAULT_SECONDS = 2;
export const BUSY_RETRY_MAX_SECONDS = 10;

function busyWaitMs(body: unknown): number {
  const raw = body !== null && typeof body === 'object'
    ? (body as { retryAfterSeconds?: unknown }).retryAfterSeconds
    : undefined;
  const seconds = typeof raw === 'number' && Number.isFinite(raw) && raw >= 0 ? raw : BUSY_RETRY_DEFAULT_SECONDS;
  return Math.min(seconds, BUSY_RETRY_MAX_SECONDS) * 1000;
}

/** One team request, with the single `busy` retry; resolves only on a 2xx. */
async function teamRequest<T>(path: string, init: RequestInit, token: string | undefined, fallbackCode: string): Promise<T> {
  let res = await apiFetch(path, init, token);
  if (res.status === 503) {
    const body: unknown = await res.clone().json().catch(() => null);
    if ((body as { error?: unknown } | null)?.error === 'busy') {
      await new Promise((resolve) => setTimeout(resolve, busyWaitMs(body)));
      res = await apiFetch(path, init, token);
    }
  }
  if (!res.ok) throw await parseApiError(res, fallbackCode);
  return res.json() as Promise<T>;
}

function post(body: unknown): RequestInit {
  return { method: 'POST', body: JSON.stringify(body) };
}

export function getTeam(token: string, signal?: AbortSignal): Promise<TeamList> {
  return teamRequest<TeamList>('/employer/team/members', { signal }, token, 'team_fetch_failed');
}

export function createInvite(
  token: string,
  body: { email: string; contactName?: string; locale: TeamLocale },
): Promise<InviteWriteResult> {
  const payload: Record<string, unknown> = { email: body.email };
  if (body.contactName !== undefined) payload.contactName = body.contactName;
  payload.locale = body.locale;
  return teamRequest<InviteWriteResult>('/employer/team/invite', post(payload), token, 'invite_failed');
}

export function resendInvite(token: string, inviteId: string, locale: TeamLocale): Promise<InviteWriteResult> {
  return teamRequest<InviteWriteResult>('/employer/team/resend', post({ inviteId, locale }), token, 'invite_resend_failed');
}

export function revokeInvite(token: string, inviteId: string): Promise<RevokeInviteResult> {
  return teamRequest<RevokeInviteResult>('/employer/team/revoke', post({ inviteId }), token, 'invite_revoke_failed');
}

export function removeMember(token: string, userId: string, reassignTo: string): Promise<RemoveMemberResult> {
  return teamRequest<RemoveMemberResult>('/employer/team/remove', post({ userId, reassignTo }), token, 'member_remove_failed');
}

export function reassignJob(token: string, jobId: string, userId: string): Promise<ReassignJobResult> {
  return teamRequest<ReassignJobResult>('/employer/team/reassign', post({ jobId, userId }), token, 'job_reassign_failed');
}

/** Public: no Authorization header. 404 `invite_not_found`; 410 `invite_expired` / `invite_revoked` / `invite_used`. */
export function lookupInvite(inviteToken: string, signal?: AbortSignal): Promise<InviteLookup> {
  return teamRequest<InviteLookup>(
    `/employer/invites/${encodeURIComponent(inviteToken)}`,
    { signal },
    undefined,
    'invite_lookup_failed',
  );
}

/** 403 `invite_email_mismatch` / `employer_required`; 409 `already_member`; 410 like the lookup. */
export function acceptInvite(idToken: string, inviteToken: string): Promise<AcceptInviteResult> {
  return teamRequest<AcceptInviteResult>(
    `/employer/invites/${encodeURIComponent(inviteToken)}`,
    { method: 'POST' },
    idToken,
    'invite_accept_failed',
  );
}

/** Rejects with `MembershipBlockedError` (which carries `hasInvite`) for a removed, suspended or orgless login. */
export function getMembership(token: string, signal?: AbortSignal): Promise<MembershipInfo> {
  return teamRequest<MembershipInfo>('/employer/team/membership', { signal }, token, 'membership_fetch_failed');
}

/** 400 `invalid_company_name`; 409 `already_member` (an invite accept landed first: re-read membership). */
export function startCompany(token: string, companyName: string): Promise<StartCompanyResult> {
  return teamRequest<StartCompanyResult>('/employer/team/membership', post({ companyName }), token, 'start_company_failed');
}

// ---------------------------------------------------------------------------
// Error copy
// ---------------------------------------------------------------------------

/**
 * Every team-route code with its own message at `employer_team.errors.<code>`.
 *
 * Deliberately NOT here, so they read `employer_team.errors.generic`:
 *   - the 400s only a client bug produces: `invalid_body`, `invalid_locale`,
 *     `invalid_invite_id`, `invalid_user_id`, `invalid_reassign_to`,
 *     `invalid_job_id`;
 *   - `not_found` (the flag is off server-side, or an unknown action);
 *   - `internal_error`;
 *   - `user_not_provisioned` (apiFetch already retried it with backoff);
 *   - transport failures (`offline`, `timeout`).
 * `invalid_company_name` has its own copy on the access screen
 * (`employer_access.errors`). `legal_required` and the membership-blocked
 * 403s never arrive as `ApiError`: apiFetch raises them as redirects.
 */
export const TEAM_ERROR_CODES = [
  'email_in_use',
  'already_member',
  'invite_pending',
  'seat_limit_reached',
  'invite_rate_limited',
  'invalid_email',
  'invalid_contact_name',
  'invite_closed',
  'invite_not_found',
  'member_not_found',
  'member_has_jobs',
  'already_removed',
  'cannot_remove_owner',
  'invalid_assignee',
  'job_not_found',
  'owner_required',
  'employer_required',
  'busy',
  'job_move_conflict',
] as const;

export type TeamErrorCode = (typeof TEAM_ERROR_CODES)[number];

/**
 * The key, inside the `employer_team` namespace, for a failed team call:
 * `useTranslations('employer_team')(teamErrorMessageKey(err))`.
 */
export function teamErrorMessageKey(err: unknown): `errors.${TeamErrorCode}` | 'errors.generic' {
  if (err instanceof ApiError && (TEAM_ERROR_CODES as readonly string[]).includes(err.code)) {
    return `errors.${err.code as TeamErrorCode}`;
  }
  return 'errors.generic';
}

/**
 * The wait a team route's 429 `invite_rate_limited` / 503 `busy` named
 * (camelCase `retryAfterSeconds`, validated by `parseApiError`); undefined
 * when none, and the caller picks its default (the Team page: 60 s).
 */
export function retryAfterSecondsOf(err: unknown): number | undefined {
  if (!(err instanceof ApiError)) return undefined;
  return err.payload.retryAfterSeconds;
}
