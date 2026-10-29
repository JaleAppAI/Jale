import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  ASSIGNEE_REFUSAL_DETAILS,
  JOB_CONVERSATION_GUARD_MESSAGE,
  INVITE_TOKEN_PATTERN,
  INVITE_TTL_DAYS,
  acceptResponse,
  hashInviteToken,
  inviteReadResponse,
  inviteUrl,
  inviteWriteResponse,
  DB_BUSY_RETRY_AFTER_SECONDS,
  dbBusyResponse,
  isAssigneeRefusal,
  isJobMoveRace,
  isOrgJobMovedRefusal,
  isRetryableDbBusy,
  isMembershipConflict,
  isTeamManagementEnabled,
  mintInviteToken,
  removeResponse,
} from '../../../../lambda/lib/org-team';

const sha256 = (s: string): Buffer => createHash('sha256').update(s, 'utf8').digest();

describe('invite tokens', () => {
  it('INVITE_TTL_DAYS is 7', () => {
    expect(INVITE_TTL_DAYS).toBe(7);
  });

  it('mintInviteToken: 43 base64url characters and the sha256 of the token string', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 50; i += 1) {
      const { token, hash } = mintInviteToken();
      expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
      expect(token).toMatch(INVITE_TOKEN_PATTERN);
      expect(Buffer.from(token, 'base64url')).toHaveLength(32);
      expect(Buffer.isBuffer(hash)).toBe(true);
      expect(hash).toHaveLength(32);
      expect(hash.equals(sha256(token))).toBe(true);
      expect(hashInviteToken(token)!.equals(hash)).toBe(true);
      seen.add(token);
    }
    expect(seen.size).toBe(50);
  });

  it('hashInviteToken refuses 42/44 characters, "+" and "/"', () => {
    const ok = 'A'.repeat(43);
    expect(hashInviteToken(ok)!.equals(sha256(ok))).toBe(true);
    expect(hashInviteToken('A'.repeat(42))).toBeNull();
    expect(hashInviteToken('A'.repeat(44))).toBeNull();
    expect(hashInviteToken(`${'A'.repeat(42)}+`)).toBeNull();
    expect(hashInviteToken(`${'A'.repeat(42)}/`)).toBeNull();
    expect(hashInviteToken(`${'A'.repeat(42)}=`)).toBeNull();
    expect(hashInviteToken('')).toBeNull();
    expect(hashInviteToken(`${ok}\n`)).toBeNull();
    expect(hashInviteToken(undefined as unknown as string)).toBeNull();
  });
});

describe('isTeamManagementEnabled', () => {
  it('isTeamManagementEnabled only for the exact string true', () => {
    expect(isTeamManagementEnabled({ TEAM_MANAGEMENT_ENABLED: 'true' })).toBe(true);
    for (const value of [undefined, '', 'TRUE', 'True', '1', 'yes', ' true', 'true ', 'false']) {
      expect(isTeamManagementEnabled({ TEAM_MANAGEMENT_ENABLED: value })).toBe(false);
    }
  });

  it('reads process.env by default', () => {
    const before = process.env.TEAM_MANAGEMENT_ENABLED;
    try {
      process.env.TEAM_MANAGEMENT_ENABLED = 'true';
      expect(isTeamManagementEnabled()).toBe(true);
      delete process.env.TEAM_MANAGEMENT_ENABLED;
      expect(isTeamManagementEnabled()).toBe(false);
    } finally {
      if (before === undefined) delete process.env.TEAM_MANAGEMENT_ENABLED;
      else process.env.TEAM_MANAGEMENT_ENABLED = before;
    }
  });
});

describe('inviteUrl', () => {
  it('inviteUrl percent-free and locale-prefixed', () => {
    const { token } = mintInviteToken();
    const en = inviteUrl('https://app.jaleapp.ai', 'en', token);
    expect(en).toBe(`https://app.jaleapp.ai/en/auth/employer/invite?token=${token}`);
    expect(en).not.toContain('%');
    expect(new URL(en).searchParams.get('token')).toBe(token);
    expect(inviteUrl('https://app.jaleapp.ai/', 'es', token)).toBe(`https://app.jaleapp.ai/es/auth/employer/invite?token=${token}`);
  });

  it('throws invite_base_url_missing unless the base is an https URL', () => {
    const { token } = mintInviteToken();
    for (const base of [
      '', 'http://app.jaleapp.ai', 'app.jaleapp.ai', 'https://', 'https:///x', ' https://app.jaleapp.ai',
      'https://app.jaleapp.ai?x=1', 'https://app.jaleapp.ai#x', 'ftp://app.jaleapp.ai', undefined as unknown as string,
    ]) {
      expect(() => inviteUrl(base, 'en', token)).toThrow('invite_base_url_missing');
    }
    expect(inviteUrl('https://staging.jaleapp.ai/app', 'en', token)).toBe(`https://staging.jaleapp.ai/app/en/auth/employer/invite?token=${token}`);
  });
});

describe('isAssigneeRefusal', () => {
  const refusal = (detail?: string, code = '42501') => Object.assign(new Error('job assignee refused'), { code, detail });

  it('isAssigneeRefusal for each 129 DETAIL, not for employer_inactive_for_activation or a 42501 without detail', () => {
    const details = ['assignee_not_member', 'assignee_inactive', 'job_employer_not_member', 'assignee_other_company'];
    expect([...ASSIGNEE_REFUSAL_DETAILS].sort()).toEqual([...details].sort());
    for (const detail of details) expect(isAssigneeRefusal(refusal(detail))).toBe(true);
    expect(isAssigneeRefusal(refusal('employer_inactive_for_activation'))).toBe(false);
    expect(isAssigneeRefusal(refusal(undefined))).toBe(false);
    expect(isAssigneeRefusal(refusal('assignee_inactive', 'P0001'))).toBe(false);
    expect(isAssigneeRefusal(null)).toBe(false);
    expect(isAssigneeRefusal(undefined)).toBe(false);
    expect(isAssigneeRefusal('assignee_inactive')).toBe(false);
  });
});

describe('isOrgJobMovedRefusal', () => {
  const pg = (code: string, detail?: string) => Object.assign(new Error('org_job_moved: refused'), { code, detail });

  it('P0001 with DETAIL org_job_moved_refused is the refusal; nothing else is', () => {
    expect(isOrgJobMovedRefusal(pg('P0001', 'org_job_moved_refused'))).toBe(true);
    expect(isOrgJobMovedRefusal(pg('P0001'))).toBe(false);
    expect(isOrgJobMovedRefusal(pg('P0001', 'something_else'))).toBe(false);
    expect(isOrgJobMovedRefusal(pg('42501', 'org_job_moved_refused'))).toBe(false);
    expect(isOrgJobMovedRefusal(pg('42501', 'assignee_inactive'))).toBe(false);
    expect(isOrgJobMovedRefusal(pg('22023'))).toBe(false);
    expect(isOrgJobMovedRefusal(null)).toBe(false);
    expect(isOrgJobMovedRefusal(undefined)).toBe(false);
    expect(isOrgJobMovedRefusal('org_job_moved_refused')).toBe(false);
  });
});

describe('isMembershipConflict', () => {
  const pgError = (code: string, constraint?: string) => Object.assign(new Error('duplicate key'), { code, constraint });

  it('a 23505 on organization_members_pkey is a membership conflict; nothing else is', () => {
    expect(isMembershipConflict(pgError('23505', 'organization_members_pkey'))).toBe(true);
    expect(isMembershipConflict(pgError('23505', 'organization_members_one_owner_per_org'))).toBe(false);
    expect(isMembershipConflict(pgError('23505'))).toBe(false);
    expect(isMembershipConflict(pgError('23503', 'organization_members_pkey'))).toBe(false);
    expect(isMembershipConflict(null)).toBe(false);
    expect(isMembershipConflict(undefined)).toBe(false);
  });
});

describe('isJobMoveRace', () => {
  const pgError = (code: string, fields: Record<string, unknown>) => Object.assign(new Error(String(fields.message ?? 'x')), { code, ...fields });

  it('the conversations foreign key (23503) and the application guard (23514) are a race with a job move', () => {
    expect(isJobMoveRace(pgError('23503', { constraint: 'job_conversations_job_employer_fkey' }))).toBe(true);
    expect(isJobMoveRace(pgError('23514', {
      message: 'job_conversations: a conversation must name its application\'s worker and job, and that job\'s employer',
    }))).toBe(true);
  });

  it('matches 105\'s guard message exactly as the migration raises it', () => {
    const dir = path.join(__dirname, '../../../../db/migrations');
    const [file] = fs.readdirSync(dir).filter((f) => /^105_.*\.sql$/.test(f));
    expect(file).toBeDefined();
    // SQL doubles a quote inside a literal; the raised message has one.
    const sql = fs.readFileSync(path.join(dir, file), 'utf8').replace(/''/g, "'");
    expect(sql).toContain(`RAISE EXCEPTION '${JOB_CONVERSATION_GUARD_MESSAGE}'`);
  });

  it('other foreign keys, checks and codes are not', () => {
    expect(isJobMoveRace(pgError('23503', { constraint: 'job_conversations_job_id_fkey' }))).toBe(false);
    expect(isJobMoveRace(pgError('23514', { message: 'new row violates check constraint "x"', constraint: 'x' }))).toBe(false);
    expect(isJobMoveRace(pgError('23505', { constraint: 'job_conversations_job_employer_fkey' }))).toBe(false);
    expect(isJobMoveRace(null)).toBe(false);
  });
});

describe('isRetryableDbBusy', () => {
  const pgError = (code: unknown) => Object.assign(new Error('x'), { code });

  it('a lock wait past lock_timeout (55P03), a statement past statement_timeout (57014) and a deadlock victim (40P01) are busy', () => {
    expect(isRetryableDbBusy(pgError('55P03'))).toBe(true);
    expect(isRetryableDbBusy(pgError('57014'))).toBe(true);
    expect(isRetryableDbBusy(pgError('40P01'))).toBe(true);
  });

  it('nothing else is: other SQLSTATEs, a serialization failure, no code, a non-error', () => {
    for (const code of ['40001', '23505', '42501', 'P0001', '55P0', '57014 ', 57014, undefined]) {
      expect(isRetryableDbBusy(pgError(code))).toBe(false);
    }
    expect(isRetryableDbBusy(null)).toBe(false);
    expect(isRetryableDbBusy(undefined)).toBe(false);
    expect(isRetryableDbBusy('55P03')).toBe(false);
  });
});

describe('dbBusyResponse', () => {
  it('503 { error: busy, retryable: true } with Retry-After: 2 beside the given headers', () => {
    expect(DB_BUSY_RETRY_AFTER_SECONDS).toBe(2);
    const res = dbBusyResponse({ 'Access-Control-Allow-Origin': 'https://app.example.test' });
    expect(res).toEqual({
      statusCode: 503,
      headers: { 'Access-Control-Allow-Origin': 'https://app.example.test', 'Retry-After': '2' },
      body: JSON.stringify({ error: 'busy', retryable: true, retryAfterSeconds: 2 }),
    });
  });

  it('does not change the headers object it is given', () => {
    const headers = { 'Cache-Control': 'no-store' };
    dbBusyResponse(headers);
    expect(headers).toEqual({ 'Cache-Control': 'no-store' });
  });
});

describe('inviteWriteResponse', () => {
  it.each([
    ['created', { statusCode: 201 }],
    ['resent', { statusCode: 200 }],
    ['revoked', { statusCode: 200 }],
    ['not_owner', { statusCode: 403, error: 'owner_required' }],
    ['invalid_email', { statusCode: 400, error: 'invalid_email' }],
    ['already_member', { statusCode: 409, error: 'already_member' }],
    ['email_in_use', { statusCode: 409, error: 'email_in_use' }],
    ['invite_pending', { statusCode: 409, error: 'invite_pending' }],
    ['rate_limited', { statusCode: 429, error: 'invite_rate_limited' }],
    ['too_soon', { statusCode: 429, error: 'invite_rate_limited' }],
    ['seat_limit_reached', { statusCode: 403, error: 'seat_limit_reached' }],
    ['not_found', { statusCode: 404, error: 'invite_not_found' }],
    ['closed', { statusCode: 409, error: 'invite_closed' }],
  ])('%s', (outcome, expected) => {
    expect(inviteWriteResponse(outcome)).toEqual(expected);
  });

  it('too_soon carries retryAfterSeconds; other outcomes never do', () => {
    expect(inviteWriteResponse('too_soon', 42)).toEqual({ statusCode: 429, error: 'invite_rate_limited', retryAfterSeconds: 42 });
    expect(inviteWriteResponse('too_soon', null)).toEqual({ statusCode: 429, error: 'invite_rate_limited' });
    expect(inviteWriteResponse('rate_limited', 42)).toEqual({ statusCode: 429, error: 'invite_rate_limited' });
    expect(inviteWriteResponse('created', 42)).toEqual({ statusCode: 201 });
  });

  it('too_soon rounds a zero or fractional wait up to 1 and ignores NaN and Infinity', () => {
    expect(inviteWriteResponse('too_soon', 0).retryAfterSeconds).toBe(1);
    expect(inviteWriteResponse('too_soon', -5).retryAfterSeconds).toBe(1);
    expect(inviteWriteResponse('too_soon', 1.2).retryAfterSeconds).toBe(2);
    expect(inviteWriteResponse('too_soon', Number.NaN)).toEqual({ statusCode: 429, error: 'invite_rate_limited' });
    expect(inviteWriteResponse('too_soon', Number.POSITIVE_INFINITY)).toEqual({ statusCode: 429, error: 'invite_rate_limited' });
  });

  it('returns a fresh object each time', () => {
    const a = inviteWriteResponse('too_soon', 5);
    expect(inviteWriteResponse('too_soon')).toEqual({ statusCode: 429, error: 'invite_rate_limited' });
    expect(a.retryAfterSeconds).toBe(5);
  });
});

describe('inviteReadResponse', () => {
  it.each([
    ['valid', { statusCode: 200 }],
    ['not_found', { statusCode: 404, error: 'invite_not_found' }],
    ['expired', { statusCode: 410, error: 'invite_expired' }],
    ['revoked', { statusCode: 410, error: 'invite_revoked' }],
    ['used', { statusCode: 410, error: 'invite_used' }],
  ])('%s', (outcome, expected) => {
    expect(inviteReadResponse(outcome)).toEqual(expected);
  });
});

describe('acceptResponse', () => {
  it.each([
    ['accepted', { statusCode: 200 }],
    ['rejoined', { statusCode: 200 }],
    ['not_found', { statusCode: 404, error: 'invite_not_found' }],
    ['expired', { statusCode: 410, error: 'invite_expired' }],
    ['revoked', { statusCode: 410, error: 'invite_revoked' }],
    ['used', { statusCode: 410, error: 'invite_used' }],
    ['email_mismatch', { statusCode: 403, error: 'invite_email_mismatch' }],
    ['already_member', { statusCode: 409, error: 'already_member' }],
    ['not_employer', { statusCode: 403, error: 'employer_required' }],
  ])('%s', (outcome, expected) => {
    expect(acceptResponse(outcome)).toEqual(expected);
  });
});

describe('removeResponse', () => {
  it.each([
    ['removed', { statusCode: 200 }],
    ['not_owner', { statusCode: 403, error: 'owner_required' }],
    ['not_found', { statusCode: 404, error: 'member_not_found' }],
    ['is_owner', { statusCode: 409, error: 'cannot_remove_owner' }],
    ['already_removed', { statusCode: 409, error: 'already_removed' }],
    ['has_jobs', { statusCode: 409, error: 'member_has_jobs' }],
  ])('%s', (outcome, expected) => {
    expect(removeResponse(outcome)).toEqual(expected);
  });
});

describe('unknown outcomes', () => {
  it('unknown outcome throws team_outcome_unknown', () => {
    for (const map of [inviteWriteResponse, inviteReadResponse, acceptResponse, removeResponse]) {
      expect(() => map('surprise')).toThrow('team_outcome_unknown');
      expect(() => map('')).toThrow('team_outcome_unknown');
      expect(() => map('toString')).toThrow('team_outcome_unknown');
      expect(() => map('__proto__')).toThrow('team_outcome_unknown');
    }
    // Each map knows only its own definer's outcomes.
    expect(() => inviteReadResponse('accepted')).toThrow('team_outcome_unknown');
    expect(() => acceptResponse('valid')).toThrow('team_outcome_unknown');
    expect(() => acceptResponse('none')).toThrow('team_outcome_unknown');
    expect(() => acceptResponse('ambiguous')).toThrow('team_outcome_unknown');
    expect(() => removeResponse('closed')).toThrow('team_outcome_unknown');
    expect(() => inviteWriteResponse('removed')).toThrow('team_outcome_unknown');
  });
});

describe('every definer outcome is mapped', () => {
  const MIGRATIONS = path.join(__dirname, '../../../../db/migrations');

  /** The outcome literals one definer can return: `'x'::text` and `v_outcome := 'x'`. */
  function outcomesOf(file: string, fn: string): string[] {
    const sql = fs.readFileSync(path.join(MIGRATIONS, file), 'utf8');
    const start = sql.indexOf(`CREATE FUNCTION jale_cap.${fn}(`);
    expect(start).toBeGreaterThanOrEqual(0);
    const end = sql.indexOf('$fn$;', start);
    expect(end).toBeGreaterThan(start);
    const body = sql.slice(start, end);
    const found = new Set<string>();
    for (const m of body.matchAll(/'([a-z_]+)'::text/g)) found.add(m[1]);
    for (const m of body.matchAll(/v_outcome\s*:=\s*'([a-z_]+)'/g)) found.add(m[1]);
    return [...found].sort();
  }

  /**
   * accept_email's own outcomes, answered by post-confirmation (Task 8), never
   * over HTTP: `none` (no live invite for the confirmed email: create a
   * company as before) and `ambiguous` (more than one: create no membership).
   */
  const ACCEPT_EMAIL_ONLY: ReadonlySet<string> = new Set(['none', 'ambiguous']);
  const NONE: ReadonlySet<string> = new Set();

  it.each([
    ['133_org_team_invites.sql', 'org_team_invite_create', inviteWriteResponse, NONE],
    ['133_org_team_invites.sql', 'org_team_invite_resend', inviteWriteResponse, NONE],
    ['133_org_team_invites.sql', 'org_team_invite_revoke', inviteWriteResponse, NONE],
    ['133_org_team_invites.sql', 'org_team_invite_lookup', inviteReadResponse, NONE],
    ['133_org_team_invites.sql', 'org_team_invite_accept', acceptResponse, NONE],
    ['133_org_team_invites.sql', 'org_team_invite_accept_email', acceptResponse, ACCEPT_EMAIL_ONLY],
    ['134_org_team_members.sql', 'org_team_remove_member', removeResponse, NONE],
  ] as Array<[string, string, (outcome: string) => unknown, ReadonlySet<string>]>)('%s %s', (file, fn, map, excluded) => {
    const outcomes = outcomesOf(file, fn);
    expect(outcomes.length).toBeGreaterThan(1);
    const unmapped = outcomes.filter((o) => !excluded.has(o)).filter((o) => {
      try {
        map(o);
        return false;
      } catch {
        return true;
      }
    });
    expect(unmapped).toEqual([]);
    for (const o of excluded) {
      expect(outcomes).toContain(o);
      expect(() => map(o)).toThrow('team_outcome_unknown');
    }
  });
});
