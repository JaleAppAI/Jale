import { createHash, randomBytes } from 'node:crypto';

/**
 * Team management (employer organizations, Phase 3): invite tokens, the
 * feature flag, the invite link, and the maps from the org-team definers'
 * outcomes (migrations 133 and 134) and the database's refusals to HTTP
 * answers. Handlers build their bodies from TeamOutcomeResponse; the success
 * statuses carry no `error`.
 */

/** An invite is live for this many days (133's org_team_invite_create / resend). */
export const INVITE_TTL_DAYS = 7;

/** A token as minted below: 32 random bytes, base64url without padding. */
export const INVITE_TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;

function sha256(token: string): Buffer {
  return createHash('sha256').update(token, 'utf8').digest();
}

/**
 * A new invite token and the hash the database stores. The raw token goes
 * only into the invite link (and the invite email); organization_invites keeps
 * the SHA-256 of its UTF-8 string.
 */
export function mintInviteToken(): { token: string; hash: Buffer } {
  const token = randomBytes(32).toString('base64url');
  return { token, hash: sha256(token) };
}

/** The stored hash of a token from a link, or null when it is not a token's shape. */
export function hashInviteToken(token: string): Buffer | null {
  if (typeof token !== 'string' || !INVITE_TOKEN_PATTERN.test(token)) return null;
  return sha256(token);
}

/** The team-management feature flag: on only for the exact string 'true'. */
export function isTeamManagementEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.TEAM_MANAGEMENT_ENABLED === 'true';
}

/**
 * The invite link. The token is base64url, so it needs no percent-encoding;
 * a trailing slash on the base is dropped. The base must be an https URL
 * (the frontend's origin, from the Lambda's env): a missing or other base
 * throws invite_base_url_missing rather than mail a broken or http link.
 */
export function inviteUrl(baseUrl: string, locale: 'en' | 'es', token: string): string {
  if (typeof baseUrl !== 'string' || !/^https:\/\/[^\s/?#]+(?:\/[^\s?#]*)?$/.test(baseUrl)) {
    throw new Error('invite_base_url_missing');
  }
  return `${baseUrl.replace(/\/+$/, '')}/${locale}/auth/employer/invite?token=${token}`;
}

/**
 * 129's job-assignee trigger refuses an assignee with 42501 and one of these
 * DETAILs. Handlers answer 409 invalid_assignee. The trigger's fifth DETAIL,
 * employer_inactive_for_activation, is not here: Phase 3 never activates a job.
 */
export const ASSIGNEE_REFUSAL_DETAILS: ReadonlySet<string> = new Set([
  'assignee_not_member',
  'assignee_inactive',
  'assignee_other_company',
  'job_employer_not_member',
]);

export function isAssigneeRefusal(err: unknown): boolean {
  const e = err as { code?: unknown; detail?: unknown } | null | undefined;
  return e?.code === '42501' && typeof e.detail === 'string' && ASSIGNEE_REFUSAL_DETAILS.has(e.detail);
}

/**
 * 138's jale_cap.org_job_moved refuses with P0001 and DETAIL
 * org_job_moved_refused (the caller is not the company's active owner, a
 * holder is not a current member, the holders are the same, or a job does not
 * name the new holder). The handlers call it only after their own checks, so a
 * refusal is a bug, not a client error: ROLLBACK, a log line, 500. Not an
 * assignee refusal (that one is 42501).
 */
export function isOrgJobMovedRefusal(err: unknown): boolean {
  const e = err as { code?: unknown; detail?: unknown } | null | undefined;
  return e?.code === 'P0001' && e.detail === 'org_job_moved_refused';
}

/**
 * The caller already has a membership row: organization_members' primary key
 * is user_id (one company per login, 118), so a 23505 on it means another
 * request (an accept, a start-company) gave this login a company first.
 * Handlers answer 409 already_member. 133's accept definers map it themselves;
 * handlers keep their own mapping for any other insert path.
 */
export function isMembershipConflict(err: unknown): boolean {
  const e = err as { code?: unknown; constraint?: unknown } | null | undefined;
  return e?.code === '23505' && e.constraint === 'organization_members_pkey';
}

/** 135's conversation-to-job foreign key (ON UPDATE CASCADE). */
export const JOB_CONVERSATION_FKEY = 'job_conversations_job_employer_fkey';
export const JOB_CONVERSATION_GUARD_MESSAGE = 'job_conversations: a conversation must name its application\'s worker and job, and that job\'s employer';

/**
 * A conversation insert (or employer change) that raced a job move: the job
 * now names another employer, so 135's foreign key refuses it (23503 on
 * job_conversations_job_employer_fkey) or 105's job_conversations_application_guard
 * does (23514 with its message, pinned against 105 in org-team.test.ts).
 * Handlers answer 409; a retry reads the moved job. A genuine mismatch (a
 * handler naming the wrong employer, no race) raises the same errors and is
 * also answered 409, never written.
 */
export function isJobMoveRace(err: unknown): boolean {
  const e = err as { code?: unknown; constraint?: unknown; message?: unknown } | null | undefined;
  if (e?.code === '23503') return e.constraint === JOB_CONVERSATION_FKEY;
  if (e?.code === '23514') return typeof e.message === 'string' && e.message.includes(JOB_CONVERSATION_GUARD_MESSAGE);
  return false;
}

/**
 * The team Lambdas run with a session lock_timeout and statement_timeout
 * (DB_LOCK_TIMEOUT_MS / DB_STATEMENT_TIMEOUT_MS, lambda/lib/db.ts). A request
 * that waited too long for the company lock (55P03 lock_not_available) or ran
 * past the statement limit (57014 query_canceled) changed nothing: its
 * transaction is rolled back. A deadlock (40P01 deadlock_detected) is the same:
 * the move handlers' org_job_moved updates job_applications while holding jobs
 * row locks, and a concurrent worker write can cross it. The victim is rolled
 * back whole. It is answered 503 busy, retryable, never 500.
 */
const DB_BUSY_CODES: ReadonlySet<string> = new Set(['55P03', '57014', '40P01']);
export const DB_BUSY_RETRY_AFTER_SECONDS = 2;

export function isRetryableDbBusy(err: unknown): boolean {
  const code = (err as { code?: unknown } | null | undefined)?.code;
  return typeof code === 'string' && DB_BUSY_CODES.has(code);
}

/**
 * 503 { error: 'busy', retryable: true, retryAfterSeconds } with Retry-After,
 * beside the handler's own headers. The wait is in the body too: the API sends
 * no Access-Control-Expose-Headers, so a browser cannot read Retry-After.
 */
export function dbBusyResponse(headers: Record<string, string>): {
  statusCode: number; headers: Record<string, string>; body: string;
} {
  return {
    statusCode: 503,
    headers: { ...headers, 'Retry-After': String(DB_BUSY_RETRY_AFTER_SECONDS) },
    body: JSON.stringify({ error: 'busy', retryable: true, retryAfterSeconds: DB_BUSY_RETRY_AFTER_SECONDS }),
  };
}

export type TeamOutcomeResponse = { statusCode: number; error?: string; retryAfterSeconds?: number };

type OutcomeMap = Readonly<Record<string, TeamOutcomeResponse>>;

function mapped(map: OutcomeMap, outcome: string): TeamOutcomeResponse {
  if (!Object.prototype.hasOwnProperty.call(map, outcome)) throw new Error('team_outcome_unknown');
  return { ...map[outcome] };
}

const INVITE_WRITE: OutcomeMap = {
  created: { statusCode: 201 },
  resent: { statusCode: 200 },
  revoked: { statusCode: 200 },
  not_owner: { statusCode: 403, error: 'owner_required' },
  invalid_email: { statusCode: 400, error: 'invalid_email' },
  already_member: { statusCode: 409, error: 'already_member' },
  email_in_use: { statusCode: 409, error: 'email_in_use' },
  invite_pending: { statusCode: 409, error: 'invite_pending' },
  rate_limited: { statusCode: 429, error: 'invite_rate_limited' },
  too_soon: { statusCode: 429, error: 'invite_rate_limited' },
  seat_limit_reached: { statusCode: 403, error: 'seat_limit_reached' },
  not_found: { statusCode: 404, error: 'invite_not_found' },
  closed: { statusCode: 409, error: 'invite_closed' },
};

const INVITE_CLOSED: OutcomeMap = {
  not_found: { statusCode: 404, error: 'invite_not_found' },
  expired: { statusCode: 410, error: 'invite_expired' },
  revoked: { statusCode: 410, error: 'invite_revoked' },
  used: { statusCode: 410, error: 'invite_used' },
};

const INVITE_READ: OutcomeMap = {
  valid: { statusCode: 200 },
  ...INVITE_CLOSED,
};

const ACCEPT: OutcomeMap = {
  accepted: { statusCode: 200 },
  rejoined: { statusCode: 200 },
  ...INVITE_CLOSED,
  email_mismatch: { statusCode: 403, error: 'invite_email_mismatch' },
  already_member: { statusCode: 409, error: 'already_member' },
  not_employer: { statusCode: 403, error: 'employer_required' },
};

const REMOVE: OutcomeMap = {
  removed: { statusCode: 200 },
  not_owner: { statusCode: 403, error: 'owner_required' },
  not_found: { statusCode: 404, error: 'member_not_found' },
  is_owner: { statusCode: 409, error: 'cannot_remove_owner' },
  already_removed: { statusCode: 409, error: 'already_removed' },
  has_jobs: { statusCode: 409, error: 'member_has_jobs' },
};

/**
 * org_team_invite_create / _resend / _revoke. `too_soon` carries the
 * definer's wait (whole seconds, at least 1) when it gives one.
 */
export function inviteWriteResponse(outcome: string, retryAfterSeconds?: number | null): TeamOutcomeResponse {
  const res = mapped(INVITE_WRITE, outcome);
  if (outcome === 'too_soon' && typeof retryAfterSeconds === 'number' && Number.isFinite(retryAfterSeconds)) {
    res.retryAfterSeconds = Math.max(1, Math.ceil(retryAfterSeconds));
  }
  return res;
}

/** org_team_invite_lookup. */
export function inviteReadResponse(outcome: string): TeamOutcomeResponse {
  return mapped(INVITE_READ, outcome);
}

/** org_team_remove_member. */
export function removeResponse(outcome: string): TeamOutcomeResponse {
  return mapped(REMOVE, outcome);
}

/** org_team_invite_accept (by token). accept_email's none / ambiguous are post-confirmation's, not here. */
export function acceptResponse(outcome: string): TeamOutcomeResponse {
  return mapped(ACCEPT, outcome);
}
