import type { PostConfirmationTriggerEvent } from 'aws-lambda';
import { handler } from '../../../../lambda/post-confirmation/index';
import { CognitoIdentityProviderClient, AdminAddUserToGroupCommand } from '@aws-sdk/client-cognito-identity-provider';
import { SQSClient, SendMessageCommand } from '@aws-sdk/client-sqs';
import { getDbPool, setRlsContext } from '../../../../lambda/lib/db';
import { setAuditContext } from '../../../../lambda/lib/audit/context';
import { expectContextBeforeWrite, idlessCallerFor } from '../api/audit-expectations';

jest.mock('@aws-sdk/client-cognito-identity-provider');
jest.mock('@aws-sdk/client-sqs');
jest.mock('../../../../lambda/lib/db');
jest.mock('../../../../lambda/lib/audit/context');

const mockGetDbPool = getDbPool as jest.Mock;
const mockSetRlsContext = setRlsContext as jest.Mock;

describe('Post-confirmation trigger Lambda', () => {
  let mockCognitoSend: jest.Mock;
  let mockSqsSend: jest.Mock;
  let mockQuery: jest.Mock;
  let mockRelease: jest.Mock;

  const originalEnv = process.env;

  beforeEach(() => {
    jest.resetAllMocks();
    process.env = { ...originalEnv, DLQ_URL: 'https://sqs.dlq.url' };

    mockCognitoSend = jest.fn();
    mockSqsSend = jest.fn();
    mockQuery = jest.fn();
    mockRelease = jest.fn();

    (CognitoIdentityProviderClient as jest.Mock).mockImplementation(() => ({
      send: mockCognitoSend,
    }));
    (SQSClient as jest.Mock).mockImplementation(() => ({
      send: mockSqsSend,
    }));

    mockGetDbPool.mockResolvedValue({
      connect: jest.fn().mockResolvedValue({
        query: mockQuery,
        release: mockRelease,
      }),
    });
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  const createEvent = (userType: string | null) => ({
    triggerSource: 'PostConfirmation_ConfirmSignUp',
    userPoolId: 'pool-123',
    userName: 'user-id-123',
    request: {
      userAttributes: {
        'custom:user_type': userType,
        sub: 'sub-183492',
        email: 'test@example.com',
        phone_number: '+1234567890',
        name: 'Test Setup User',
      },
    },
  }) as unknown as PostConfirmationTriggerEvent;

  it('should ignore non PostConfirmation_ConfirmSignUp trigger sources', async () => {
    const event = { triggerSource: 'PreSignUp_AdminCreateUser' } as unknown as PostConfirmationTriggerEvent;
    const response = await handler(event);

    expect(response).toEqual(event);
    expect(mockCognitoSend).not.toHaveBeenCalled();
    expect(mockQuery).not.toHaveBeenCalled();
  });

  it('should add worker to Workers group and insert into DB', async () => {
    const event = createEvent('worker');
    
    mockCognitoSend.mockResolvedValue({});
    mockQuery.mockResolvedValue({});

    const response = await handler(event);

    expect(response).toEqual(event); // Must return event to Cognito
    expect(AdminAddUserToGroupCommand).toHaveBeenCalledWith({
      UserPoolId: 'pool-123',
      Username: 'user-id-123',
      GroupName: 'Workers',
    });
    
    expect(mockQuery).toHaveBeenCalledWith('BEGIN');
    expect(mockSetRlsContext).toHaveBeenCalledWith(expect.any(Object), 'sub-183492');
    expect(mockQuery).toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO users'),
      ['sub-183492', 'worker', 'test@example.com', '+1234567890', 'Test Setup User']
    );
    expect(mockQuery).toHaveBeenCalledWith('COMMIT');
    expect(mockRelease).toHaveBeenCalled();
  });

  it('should push to DLQ if user_type is invalid', async () => {
    const event = createEvent('invalid_type');
    
    const response = await handler(event);

    expect(response).toEqual(event); // Still returns event to not block signup
    expect(mockCognitoSend).not.toHaveBeenCalled(); // No group assigned
    expect(mockQuery).not.toHaveBeenCalled(); // DB insert skipped

    expect(SendMessageCommand).toHaveBeenCalledWith(expect.objectContaining({
      QueueUrl: 'https://sqs.dlq.url',
      MessageBody: expect.stringContaining('Invalid user_type: invalid_type'),
    }));
  });

  it('should add employer to Employers group and insert into DB', async () => {
    const event = createEvent('employer');

    mockCognitoSend.mockResolvedValue({});
    mockQuery.mockResolvedValue({});

    const response = await handler(event);

    expect(response).toEqual(event);
    expect(AdminAddUserToGroupCommand).toHaveBeenCalledWith({
      UserPoolId: 'pool-123',
      Username: 'user-id-123',
      GroupName: 'Employers',
    });

    expect(mockQuery).toHaveBeenCalledWith('BEGIN');
    expect(mockSetRlsContext).toHaveBeenCalledWith(expect.any(Object), 'sub-183492');
    expect(mockQuery).toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO users'),
      ['sub-183492', 'employer', 'test@example.com', '+1234567890', 'Test Setup User']
    );
    expect(mockQuery).toHaveBeenCalledWith('COMMIT');
    expect(mockRelease).toHaveBeenCalled();
  });

  it('should push to DLQ if user_type is null', async () => {
    const event = createEvent(null);

    const response = await handler(event);

    expect(response).toEqual(event);
    expect(mockCognitoSend).not.toHaveBeenCalled(); // No group to assign
    expect(mockQuery).not.toHaveBeenCalled();       // DB insert skipped

    expect(SendMessageCommand).toHaveBeenCalledWith(expect.objectContaining({
      QueueUrl: 'https://sqs.dlq.url',
      MessageBody: expect.stringContaining('Invalid user_type: null'),
    }));
  });

  it('should catch db errors, rollback, push to DLQ, and not block signup', async () => {
    const event = createEvent('employer');
    mockQuery.mockImplementation((queryText) => {
      if (queryText.includes('INSERT INTO users')) {
        return Promise.reject(new Error('DB Duplicate Key'));
      }
      return Promise.resolve();
    });

    const response = await handler(event);

    expect(response).toEqual(event);
    expect(mockQuery).toHaveBeenCalledWith('ROLLBACK');
    expect(mockRelease).toHaveBeenCalled();

    expect(SendMessageCommand).toHaveBeenCalledWith(expect.objectContaining({
      QueueUrl: 'https://sqs.dlq.url',
      MessageBody: expect.stringContaining('DB Duplicate Key'),
    }));
  });

  it('creates the company for an employer in the same transaction as the users row', async () => {
    mockQuery.mockResolvedValue({ rows: [{ org: 'org-1' }] });
    const event = createEvent('employer');
    (event.request.userAttributes as Record<string, string>)['custom:company_name'] = 'ACME Roofing';

    await handler(event);

    const sqls = mockQuery.mock.calls.map(([sql]) => String(sql));
    const insertAt = sqls.findIndex((s) => s.includes('INSERT INTO users'));
    const ensureAt = sqls.findIndex((s) => s.includes('public.employer_ensure_organization($1)'));
    const commitAt = sqls.lastIndexOf('COMMIT');
    expect(insertAt).toBeGreaterThan(-1);
    expect(ensureAt).toBeGreaterThan(insertAt);
    expect(commitAt).toBeGreaterThan(ensureAt);
    expect(mockQuery.mock.calls[ensureAt][1]).toEqual(['ACME Roofing']);
    // The change context is stated inside the transaction, before the company is created.
    expectContextBeforeWrite(mockQuery, setAuditContext as jest.Mock, /employer_ensure_organization/);
  });

  it('falls back to the name attribute when there is no company_name', async () => {
    mockQuery.mockResolvedValue({ rows: [{ org: 'org-1' }] });
    await handler(createEvent('employer'));
    const call = mockQuery.mock.calls.find(([sql]) => String(sql).includes('employer_ensure_organization'));
    expect(call?.[1]).toEqual(['Test Setup User']);
  });

  it('never creates a company for a worker', async () => {
    mockQuery.mockResolvedValue({ rows: [] });
    await handler(createEvent('worker'));
    expect(mockQuery.mock.calls.some(([sql]) => String(sql).includes('employer_ensure_organization'))).toBe(false);
  });

  it('rolls back the users row too when the company cannot be created, and sends the event to the DLQ', async () => {
    mockQuery.mockImplementation((sql: string) => {
      if (sql.includes('employer_ensure_organization')) return Promise.reject(new Error('boom'));
      return Promise.resolve({ rows: [] });
    });
    const event = createEvent('employer');
    const result = await handler(event);

    const sqls = mockQuery.mock.calls.map(([sql]) => String(sql));
    expect(sqls).toContain('ROLLBACK');
    expect(sqls).not.toContain('COMMIT');
    // The handler's SQS client is built once at import, so assert the command
    // it sends, as the file's other DLQ tests do (lines 111, 151, 170).
    expect(SendMessageCommand).toHaveBeenCalledWith(expect.objectContaining({
      QueueUrl: 'https://sqs.dlq.url',
      MessageBody: expect.stringContaining('boom'),
    }));
    expect(result).toBe(event); // sign-up is never blocked
  });

  it('wraps the company call in a savepoint and releases it on success', async () => {
    mockQuery.mockResolvedValue({ rows: [{ org: 'org-1' }] });
    await handler(createEvent('employer'));

    const sqls = mockQuery.mock.calls.map(([sql]) => String(sql));
    const savepointAt = sqls.indexOf('SAVEPOINT company_bootstrap');
    const ensureAt = sqls.findIndex((s) => s.includes('public.employer_ensure_organization($1)'));
    const releaseAt = sqls.indexOf('RELEASE SAVEPOINT company_bootstrap');
    expect(savepointAt).toBeGreaterThan(sqls.findIndex((s) => s.includes('INSERT INTO users')));
    expect(ensureAt).toBeGreaterThan(savepointAt);
    expect(releaseAt).toBeGreaterThan(ensureAt);
    expect(sqls.lastIndexOf('COMMIT')).toBeGreaterThan(releaseAt);
    expect(sqls).not.toContain('ROLLBACK TO SAVEPOINT company_bootstrap');
  });

  it('keeps the users row when migration 118 is not applied yet (42883), logs loudly, and sends nothing to the DLQ', async () => {
    const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    mockQuery.mockImplementation((sql: string) => {
      if (sql.includes('employer_ensure_organization')) {
        return Promise.reject(Object.assign(new Error('function public.employer_ensure_organization(text) does not exist'), { code: '42883' }));
      }
      return Promise.resolve({ rows: [] });
    });
    const event = createEvent('employer');
    const result = await handler(event);

    const sqls = mockQuery.mock.calls.map(([sql]) => String(sql));
    const ensureAt = sqls.findIndex((s) => s.includes('public.employer_ensure_organization($1)'));
    const rollbackToAt = sqls.indexOf('ROLLBACK TO SAVEPOINT company_bootstrap');
    expect(rollbackToAt).toBeGreaterThan(ensureAt);
    expect(sqls.lastIndexOf('COMMIT')).toBeGreaterThan(rollbackToAt);
    expect(sqls).not.toContain('ROLLBACK');
    expect(sqls).not.toContain('RELEASE SAVEPOINT company_bootstrap');
    expect(SendMessageCommand).not.toHaveBeenCalled();
    expect(errorSpy).toHaveBeenCalledWith(expect.stringMatching(/no company yet.*119/s));
    expect(mockRelease).toHaveBeenCalled();
    expect(result).toBe(event);
    errorSpy.mockRestore();
  });

  it('still rolls back everything and uses the DLQ for any other SQLSTATE from the company call', async () => {
    mockQuery.mockImplementation((sql: string) => {
      if (sql.includes('employer_ensure_organization')) {
        return Promise.reject(Object.assign(new Error('permission denied'), { code: '42501' }));
      }
      return Promise.resolve({ rows: [] });
    });
    const event = createEvent('employer');
    const result = await handler(event);

    const sqls = mockQuery.mock.calls.map(([sql]) => String(sql));
    expect(sqls).toContain('ROLLBACK');
    expect(sqls).not.toContain('ROLLBACK TO SAVEPOINT company_bootstrap');
    expect(sqls).not.toContain('COMMIT');
    expect(SendMessageCommand).toHaveBeenCalledWith(expect.objectContaining({
      QueueUrl: 'https://sqs.dlq.url',
      MessageBody: expect.stringContaining('permission denied'),
    }));
    expect(result).toBe(event);
  });

  describe('team invites (TEAM_MANAGEMENT_ENABLED)', () => {
    const TOKEN = 'T'.repeat(21) + '_' + 'u'.repeat(21); // 43 base64url characters
    const ORG = 'org-invited-1';
    const TOKEN_SQL = /FROM jale_cap\.org_team_invite_accept\(\$1\)/;
    const EMAIL_SQL = /FROM jale_cap\.org_team_invite_accept_email\(\)/;
    const ENSURE_SQL = /public\.employer_ensure_organization\(\$1\)/;
    const LOCK_SQL = /^SET LOCAL lock_timeout = '\d+ms'$/;

    type Answer = string | Error;
    let tokenAnswer: Answer;
    let emailAnswer: Answer;
    let warnSpy: jest.SpyInstance;
    let errorSpy: jest.SpyInstance;
    let logSpy: jest.SpyInstance;
    let infoSpy: jest.SpyInstance;

    const pgError = (code: string, extra: Record<string, unknown> = {}) => Object.assign(new Error(`pg ${code}`), { code, ...extra });
    const answer = (a: Answer) => (a instanceof Error
      ? Promise.reject(a)
      : Promise.resolve({ rows: [{ outcome: a, organization_id: a === 'accepted' ? ORG : null }] }));

    const employerEvent = (
      clientMetadata?: Record<string, string>,
      userType = 'employer',
      attrs: Record<string, string | undefined> = { 'custom:company_name': 'ACME Roofing', email_verified: 'true' },
    ) => {
      const event = createEvent(userType);
      for (const [name, value] of Object.entries(attrs)) {
        if (value !== undefined) (event.request.userAttributes as Record<string, string>)[name] = value;
      }
      if (clientMetadata) (event.request as { clientMetadata?: Record<string, string> }).clientMetadata = clientMetadata;
      return event;
    };
    const sqls = (): string[] => mockQuery.mock.calls.map(([sql]) => String(sql));
    const indexOf = (re: RegExp | string) => sqls().findIndex((s) => (typeof re === 'string' ? s === re : re.test(s)));
    const has = (re: RegExp | string) => indexOf(re) > -1;
    const logged = (spy: jest.SpyInstance, event: string) => spy.mock.calls
      .map(([line]) => { try { return JSON.parse(String(line)); } catch { return null; } })
      .find((entry) => entry?.event === event);

    beforeEach(() => {
      process.env.TEAM_MANAGEMENT_ENABLED = 'true';
      tokenAnswer = 'accepted';
      emailAnswer = 'none';
      mockCognitoSend.mockResolvedValue({});
      mockQuery.mockImplementation((sql: string) => {
        if (TOKEN_SQL.test(sql)) return answer(tokenAnswer);
        if (EMAIL_SQL.test(sql)) return answer(emailAnswer);
        if (ENSURE_SQL.test(sql)) return Promise.resolve({ rows: [{ org: 'org-new' }] });
        return Promise.resolve({ rows: [] });
      });
      warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
      errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
      logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
      infoSpy = jest.spyOn(console, 'info').mockImplementation(() => {});
    });

    afterEach(() => {
      warnSpy.mockRestore();
      errorSpy.mockRestore();
      logSpy.mockRestore();
      infoSpy.mockRestore();
    });

    it('flag on, employer with an inviteToken: accepts the invite and never calls employer_ensure_organization', async () => {
      const event = employerEvent({ inviteToken: TOKEN });
      const result = await handler(event);

      const tokenAt = indexOf(TOKEN_SQL);
      expect(tokenAt).toBeGreaterThan(indexOf(/INSERT INTO users/));
      expect(mockQuery.mock.calls[tokenAt][1]).toHaveLength(1);
      expect(Buffer.isBuffer(mockQuery.mock.calls[tokenAt][1][0])).toBe(true);
      expect(has(EMAIL_SQL)).toBe(false);
      expect(has(ENSURE_SQL)).toBe(false);
      expect(indexOf('RELEASE SAVEPOINT company_bootstrap')).toBeGreaterThan(tokenAt);
      expect(sqls().lastIndexOf('COMMIT')).toBeGreaterThan(tokenAt);
      expect(sqls()).not.toContain('ROLLBACK');
      expect(result).toBe(event);
    });

    it('flag on, no token, the confirmed email has a live invite: accepted, no company created', async () => {
      emailAnswer = 'accepted';
      await handler(employerEvent());

      expect(has(TOKEN_SQL)).toBe(false);
      expect(has(EMAIL_SQL)).toBe(true);
      expect(has(ENSURE_SQL)).toBe(false);
      expect(sqls().lastIndexOf('COMMIT')).toBeGreaterThan(indexOf(EMAIL_SQL));
      expect(logged(warnSpy, 'post_confirmation_invite_refused')).toBeUndefined();
    });

    it('flag on, no token, no invite: the company is ensured as before', async () => {
      emailAnswer = 'none';
      await handler(employerEvent());

      const emailAt = indexOf(EMAIL_SQL);
      const ensureAt = indexOf(ENSURE_SQL);
      expect(emailAt).toBeGreaterThan(-1);
      expect(ensureAt).toBeGreaterThan(emailAt);
      expect(mockQuery.mock.calls[ensureAt][1]).toEqual(['ACME Roofing']);
      expect(indexOf('RELEASE SAVEPOINT company_bootstrap')).toBeGreaterThan(ensureAt);
      expect(sqls().lastIndexOf('COMMIT')).toBeGreaterThan(ensureAt);
      expect(logged(warnSpy, 'post_confirmation_invite_refused')).toBeUndefined();
    });

    it('an empty inviteToken counts as no token', async () => {
      emailAnswer = 'none';
      await handler(employerEvent({ inviteToken: '' }));
      expect(has(TOKEN_SQL)).toBe(false);
      expect(has(ENSURE_SQL)).toBe(true);
    });

    it('a refused token falls back to the email; neither accepting gives no membership, COMMIT of the users row, warn log with both outcomes', async () => {
      tokenAnswer = 'expired';
      emailAnswer = 'none';
      const event = employerEvent({ inviteToken: TOKEN });
      const result = await handler(event);

      const tokenAt = indexOf(TOKEN_SQL);
      const emailAt = indexOf(EMAIL_SQL);
      expect(emailAt).toBeGreaterThan(tokenAt);
      expect(has(ENSURE_SQL)).toBe(false);
      expect(has(/INSERT INTO users/)).toBe(true);
      expect(sqls().lastIndexOf('COMMIT')).toBeGreaterThan(emailAt);
      expect(sqls()).not.toContain('ROLLBACK');
      expect(SendMessageCommand).not.toHaveBeenCalled();
      expect(logged(warnSpy, 'post_confirmation_invite_refused')).toEqual(expect.objectContaining({
        tokenOutcome: 'expired', emailOutcome: 'none',
      }));
      expect(result).toBe(event);
    });

    it('a refused token, then the email accepts: accepted by email, nothing refused', async () => {
      tokenAnswer = 'email_mismatch';
      emailAnswer = 'accepted';
      await handler(employerEvent({ inviteToken: TOKEN }));
      expect(indexOf(EMAIL_SQL)).toBeGreaterThan(indexOf(TOKEN_SQL));
      expect(has(ENSURE_SQL)).toBe(false);
      expect(logged(warnSpy, 'post_confirmation_invite_refused')).toBeUndefined();
    });

    it('a malformed token counts as refused: no accept call by token, the email is tried, no company', async () => {
      emailAnswer = 'none';
      await handler(employerEvent({ inviteToken: 'not-a-token' }));
      expect(has(TOKEN_SQL)).toBe(false);
      expect(has(EMAIL_SQL)).toBe(true);
      expect(has(ENSURE_SQL)).toBe(false);
      expect(logged(warnSpy, 'post_confirmation_invite_refused')).toEqual(expect.objectContaining({
        tokenOutcome: 'malformed', emailOutcome: 'none',
      }));
    });

    it('ambiguous: no membership and no company', async () => {
      emailAnswer = 'ambiguous';
      await handler(employerEvent());
      expect(has(ENSURE_SQL)).toBe(false);
      expect(sqls().lastIndexOf('COMMIT')).toBeGreaterThan(indexOf(EMAIL_SQL));
      expect(logged(warnSpy, 'post_confirmation_invite_refused')).toEqual(expect.objectContaining({
        tokenOutcome: null, emailOutcome: 'ambiguous',
      }));
    });

    it('SET LOCAL lock_timeout is issued inside the savepoint before the invite call', async () => {
      await handler(employerEvent({ inviteToken: TOKEN }));
      const savepointAt = indexOf('SAVEPOINT company_bootstrap');
      const lockAt = indexOf(LOCK_SQL);
      expect(savepointAt).toBeGreaterThan(indexOf(/INSERT INTO users/));
      expect(lockAt).toBeGreaterThan(savepointAt);
      expect(indexOf(TOKEN_SQL)).toBeGreaterThan(lockAt);

      mockQuery.mockClear();
      await handler(employerEvent());
      expect(indexOf(LOCK_SQL)).toBeGreaterThan(indexOf('SAVEPOINT company_bootstrap'));
      expect(indexOf(EMAIL_SQL)).toBeGreaterThan(indexOf(LOCK_SQL));
    });

    it.each([
      ['the token accept', { inviteToken: TOKEN }, 'token'],
      ['the email accept', undefined, 'email'],
    ])('a 55P03 on %s rolls back to the savepoint, commits the users row and logs post_confirmation_invite_deferred', async (_label, metadata, via) => {
      if (via === 'token') tokenAnswer = pgError('55P03');
      else emailAnswer = pgError('55P03');
      const event = employerEvent(metadata as Record<string, string> | undefined);
      const result = await handler(event);

      const callAt = indexOf(via === 'token' ? TOKEN_SQL : EMAIL_SQL);
      const rollbackToAt = indexOf('ROLLBACK TO SAVEPOINT company_bootstrap');
      expect(rollbackToAt).toBeGreaterThan(callAt);
      expect(sqls().lastIndexOf('COMMIT')).toBeGreaterThan(rollbackToAt);
      expect(sqls()).not.toContain('ROLLBACK');
      // No second try and no company after a deferral.
      if (via === 'token') expect(has(EMAIL_SQL)).toBe(false);
      expect(has(ENSURE_SQL)).toBe(false);
      expect(SendMessageCommand).not.toHaveBeenCalled();
      expect(logged(warnSpy, 'post_confirmation_invite_deferred')).toEqual(expect.objectContaining({ step: via }));
      expect(mockRelease).toHaveBeenCalled();
      expect(result).toBe(event);
    });

    it('a 42883 on the accept call rolls back to the savepoint and commits the users row (same as the ensure path)', async () => {
      tokenAnswer = pgError('42883');
      const event = employerEvent({ inviteToken: TOKEN });
      const result = await handler(event);

      const rollbackToAt = indexOf('ROLLBACK TO SAVEPOINT company_bootstrap');
      expect(rollbackToAt).toBeGreaterThan(indexOf(TOKEN_SQL));
      expect(sqls().lastIndexOf('COMMIT')).toBeGreaterThan(rollbackToAt);
      expect(sqls()).not.toContain('ROLLBACK');
      expect(has(ENSURE_SQL)).toBe(false);
      expect(SendMessageCommand).not.toHaveBeenCalled();
      expect(errorSpy).toHaveBeenCalledWith(expect.stringMatching(/CRITICAL.*org_team_invite_accept.*133/s));
      expect(result).toBe(event);
    });

    it.each([
      ['the token accept', { inviteToken: TOKEN }, 'token'],
      ['the email accept', undefined, 'email'],
    ])('a 23505 on organization_members_pkey from %s is already_member: no membership, users row committed', async (_label, metadata, via) => {
      const conflict = pgError('23505', { constraint: 'organization_members_pkey' });
      if (via === 'token') tokenAnswer = conflict;
      else emailAnswer = conflict;
      await handler(employerEvent(metadata as Record<string, string> | undefined));

      const rollbackToAt = indexOf('ROLLBACK TO SAVEPOINT company_bootstrap');
      expect(rollbackToAt).toBeGreaterThan(indexOf(via === 'token' ? TOKEN_SQL : EMAIL_SQL));
      expect(sqls().lastIndexOf('COMMIT')).toBeGreaterThan(rollbackToAt);
      expect(sqls()).not.toContain('ROLLBACK');
      expect(has(ENSURE_SQL)).toBe(false);
      expect(SendMessageCommand).not.toHaveBeenCalled();
      expect(logged(warnSpy, 'post_confirmation_invite_refused')).toEqual(expect.objectContaining(
        via === 'token' ? { tokenOutcome: 'already_member', emailOutcome: null } : { tokenOutcome: null, emailOutcome: 'already_member' },
      ));
    });

    it('any other accept failure never fails the sign-up: savepoint rolled back, users row committed, no membership, logged', async () => {
      emailAnswer = pgError('P0001');
      const event = employerEvent();
      const result = await handler(event);

      const rollbackToAt = indexOf('ROLLBACK TO SAVEPOINT company_bootstrap');
      expect(rollbackToAt).toBeGreaterThan(indexOf(EMAIL_SQL));
      expect(sqls().lastIndexOf('COMMIT')).toBeGreaterThan(rollbackToAt);
      expect(sqls()).not.toContain('ROLLBACK');
      expect(has(ENSURE_SQL)).toBe(false);
      expect(SendMessageCommand).not.toHaveBeenCalled();
      expect(logged(errorSpy, 'post_confirmation_invite_failed')).toEqual(expect.objectContaining({ step: 'email', code: 'P0001' }));
      expect(result).toBe(event);
    });

    it('the ensure call keeps its own rules with the flag on: any other SQLSTATE rolls back everything and goes to the DLQ', async () => {
      mockQuery.mockImplementation((sql: string) => {
        if (EMAIL_SQL.test(sql)) return answer('none');
        if (ENSURE_SQL.test(sql)) return Promise.reject(pgError('42501'));
        return Promise.resolve({ rows: [] });
      });
      const event = employerEvent();
      const result = await handler(event);
      expect(sqls()).toContain('ROLLBACK');
      expect(sqls()).not.toContain('COMMIT');
      expect(SendMessageCommand).toHaveBeenCalled();
      expect(result).toBe(event);
    });

    it('the token is never logged', async () => {
      tokenAnswer = new Error(`boom ${TOKEN}`);
      await handler(employerEvent({ inviteToken: TOKEN }));
      tokenAnswer = 'revoked';
      emailAnswer = 'ambiguous';
      await handler(employerEvent({ inviteToken: TOKEN }));
      const all = JSON.stringify([...warnSpy.mock.calls, ...errorSpy.mock.calls, ...logSpy.mock.calls, ...infoSpy.mock.calls]);
      expect(all).not.toContain(TOKEN);
      expect(all).toContain('post_confirmation_invite_refused');
      expect(all).toContain('post_confirmation_invite_failed');
    });

    it('token rejoined counts as success: no email step, no company, accepted logged with via token', async () => {
      tokenAnswer = 'rejoined';
      mockQuery.mockImplementation((sql: string) => {
        if (TOKEN_SQL.test(sql)) return Promise.resolve({ rows: [{ outcome: 'rejoined', organization_id: ORG }] });
        return Promise.resolve({ rows: [] });
      });
      await handler(employerEvent({ inviteToken: TOKEN }));
      expect(has(EMAIL_SQL)).toBe(false);
      expect(has(ENSURE_SQL)).toBe(false);
      expect(indexOf('RELEASE SAVEPOINT company_bootstrap')).toBeGreaterThan(indexOf(TOKEN_SQL));
      expect(logged(logSpy, 'post_confirmation_invite_accepted')).toEqual(expect.objectContaining({
        via: 'token', organizationId: ORG, cognitoSub: 'sub-183492',
      }));
    });

    it('post_confirmation_invite_accepted is logged with via and the organizationId', async () => {
      await handler(employerEvent({ inviteToken: TOKEN }));
      expect(logged(logSpy, 'post_confirmation_invite_accepted')).toEqual({
        event: 'post_confirmation_invite_accepted', via: 'token', organizationId: ORG, cognitoSub: 'sub-183492',
      });

      logSpy.mockClear();
      emailAnswer = 'accepted';
      await handler(employerEvent());
      expect(logged(logSpy, 'post_confirmation_invite_accepted')).toEqual(expect.objectContaining({ via: 'email', organizationId: ORG }));
    });

    it('an invite-mode sign-up (no custom:company_name) with no token and no invite gets no company of its own', async () => {
      emailAnswer = 'none';
      const event = employerEvent(undefined, 'employer', { email_verified: 'true' });
      expect(event.request.userAttributes['custom:company_name']).toBeUndefined();
      const result = await handler(event);

      expect(has(EMAIL_SQL)).toBe(true);
      expect(has(ENSURE_SQL)).toBe(false);
      expect(indexOf('RELEASE SAVEPOINT company_bootstrap')).toBeGreaterThan(indexOf(EMAIL_SQL));
      expect(sqls().lastIndexOf('COMMIT')).toBeGreaterThan(indexOf(EMAIL_SQL));
      expect(sqls()).not.toContain('ROLLBACK');
      expect(SendMessageCommand).not.toHaveBeenCalled();
      expect(logged(warnSpy, 'post_confirmation_invite_refused')).toEqual(expect.objectContaining({
        reason: 'invite_mode_no_invite', tokenOutcome: null, emailOutcome: 'none',
      }));
      expect(result).toBe(event);

      // A blank company name is no company name either.
      mockQuery.mockClear();
      await handler(employerEvent(undefined, 'employer', { 'custom:company_name': '   ', email_verified: 'true' }));
      expect(has(ENSURE_SQL)).toBe(false);
    });

    it('each lock-waiting step gets what is left of 3.5 s from handler entry (at least 250 ms)', async () => {
      let now = 1_000_000;
      const nowSpy = jest.spyOn(Date, 'now').mockImplementation(() => now);
      try {
        tokenAnswer = 'expired';
        emailAnswer = 'none';
        // Time spent before the invite steps (the group call, the connection,
        // BEGIN) counts: BEGIN stands in for it here.
        let beforeSteps = 300;
        mockQuery.mockImplementation((sql: string) => {
          if (sql === 'BEGIN') now += beforeSteps;
          if (TOKEN_SQL.test(sql)) { now += 1200; return answer(tokenAnswer); }
          if (EMAIL_SQL.test(sql)) { now += 2200; return answer(emailAnswer); }
          return Promise.resolve({ rows: [] });
        });
        await handler(employerEvent({ inviteToken: TOKEN }));

        const locks = sqls().filter((s) => LOCK_SQL.test(s));
        expect(locks).toEqual([
          "SET LOCAL lock_timeout = '3200ms'", // before the token step: 3500 - 300
          "SET LOCAL lock_timeout = '2000ms'", // before the email step: 3500 - 1500
        ]);

        // No token, the budget nearly spent: the email step still waits 250 ms.
        mockQuery.mockClear();
        beforeSteps = 3400;
        await handler(employerEvent());
        expect(sqls().filter((s) => LOCK_SQL.test(s))[0]).toBe("SET LOCAL lock_timeout = '250ms'");
      } finally {
        nowSpy.mockRestore();
      }
    });

    it('a token step that used the budget skips the email step and logs it as deferred', async () => {
      let now = 1_000_000;
      const nowSpy = jest.spyOn(Date, 'now').mockImplementation(() => now);
      try {
        tokenAnswer = 'expired';
        mockQuery.mockImplementation((sql: string) => {
          if (TOKEN_SQL.test(sql)) { now += 3300; return answer(tokenAnswer); }
          if (EMAIL_SQL.test(sql)) return answer('accepted');
          return Promise.resolve({ rows: [] });
        });
        const event = employerEvent({ inviteToken: TOKEN });
        const result = await handler(event);

        expect(has(TOKEN_SQL)).toBe(true);
        expect(has(EMAIL_SQL)).toBe(false);
        expect(has(ENSURE_SQL)).toBe(false);
        expect(indexOf('RELEASE SAVEPOINT company_bootstrap')).toBeGreaterThan(indexOf(TOKEN_SQL));
        expect(sqls().lastIndexOf('COMMIT')).toBeGreaterThan(indexOf(TOKEN_SQL));
        expect(logged(warnSpy, 'post_confirmation_invite_deferred')).toEqual(expect.objectContaining({
          step: 'email', reason: 'time_budget', tokenOutcome: 'expired',
        }));
        expect(result).toBe(event);
      } finally {
        nowSpy.mockRestore();
      }
    });

    it('a 55P03 on the ensure with the flag on rolls back to the savepoint, keeps the users row and logs it, no DLQ', async () => {
      mockQuery.mockImplementation((sql: string) => {
        if (EMAIL_SQL.test(sql)) return answer('none');
        if (ENSURE_SQL.test(sql)) return Promise.reject(pgError('55P03'));
        return Promise.resolve({ rows: [] });
      });
      const event = employerEvent();
      const result = await handler(event);

      const ensureAt = indexOf(ENSURE_SQL);
      const rollbackToAt = indexOf('ROLLBACK TO SAVEPOINT company_bootstrap');
      // The ensure waits under the budget too.
      expect(sqls()[ensureAt - 1]).toMatch(LOCK_SQL);
      expect(rollbackToAt).toBeGreaterThan(ensureAt);
      expect(sqls().lastIndexOf('COMMIT')).toBeGreaterThan(rollbackToAt);
      expect(sqls()).not.toContain('ROLLBACK');
      expect(SendMessageCommand).not.toHaveBeenCalled();
      expect(logged(warnSpy, 'post_confirmation_company_deferred')).toEqual(expect.objectContaining({ cognitoSub: 'sub-183492' }));
      expect(result).toBe(event);
    });

    it('an unverified email: no accept is tried; with no token the company is ensured as in Phase 2', async () => {
      const event = employerEvent(undefined, 'employer', { 'custom:company_name': 'ACME Roofing', email_verified: 'false' });
      await handler(event);
      expect(has(TOKEN_SQL)).toBe(false);
      expect(has(EMAIL_SQL)).toBe(false);
      expect(mockQuery.mock.calls[indexOf(ENSURE_SQL)][1]).toEqual(['ACME Roofing']);
      expect(logged(warnSpy, 'post_confirmation_invite_skipped')).toEqual(expect.objectContaining({
        reason: 'email_unverified', hasToken: false,
      }));

      // With a token (or no company name): no accept, no company, users row committed.
      mockQuery.mockClear();
      warnSpy.mockClear();
      await handler(employerEvent({ inviteToken: TOKEN }, 'employer', { 'custom:company_name': 'ACME Roofing' }));
      expect(has(TOKEN_SQL)).toBe(false);
      expect(has(EMAIL_SQL)).toBe(false);
      expect(has(ENSURE_SQL)).toBe(false);
      expect(sqls().slice(indexOf(/INSERT INTO users/) + 1)).toEqual([
        'SAVEPOINT company_bootstrap', 'RELEASE SAVEPOINT company_bootstrap', 'COMMIT',
      ]);
      expect(logged(warnSpy, 'post_confirmation_invite_skipped')).toEqual(expect.objectContaining({ hasToken: true }));
    });

    it.each([
      ['used', { inviteToken: TOKEN }],
      [null, undefined],
    ])('a Cognito retry (token %s, email already_member): no ensure, COMMIT, no DLQ, logged as a retry at info', async (token, metadata) => {
      tokenAnswer = 'used';
      emailAnswer = 'already_member';
      const event = employerEvent(metadata as Record<string, string> | undefined);
      const result = await handler(event);

      expect(has(ENSURE_SQL)).toBe(false);
      expect(sqls().lastIndexOf('COMMIT')).toBeGreaterThan(indexOf(EMAIL_SQL));
      expect(sqls()).not.toContain('ROLLBACK');
      expect(SendMessageCommand).not.toHaveBeenCalled();
      expect(logged(infoSpy, 'post_confirmation_invite_retry')).toEqual(expect.objectContaining({
        tokenOutcome: token, emailOutcome: 'already_member',
      }));
      expect(logged(warnSpy, 'post_confirmation_invite_refused')).toBeUndefined();
      expect(result).toBe(event);
    });

    it('email already_member after another refused token is still a refusal', async () => {
      tokenAnswer = 'email_mismatch';
      emailAnswer = 'already_member';
      await handler(employerEvent({ inviteToken: TOKEN }));
      expect(logged(infoSpy, 'post_confirmation_invite_retry')).toBeUndefined();
      expect(logged(warnSpy, 'post_confirmation_invite_refused')).toEqual(expect.objectContaining({
        tokenOutcome: 'email_mismatch', emailOutcome: 'already_member',
      }));
    });

    it('flag off: an inviteToken is ignored, no lock_timeout, and the company is ensured as before', async () => {
      process.env.TEAM_MANAGEMENT_ENABLED = 'false';
      await handler(employerEvent({ inviteToken: TOKEN }));

      expect(has(TOKEN_SQL)).toBe(false);
      expect(has(EMAIL_SQL)).toBe(false);
      expect(sqls().some((s) => /lock_timeout/.test(s))).toBe(false);
      // Today's sequence, statement for statement, after the users row.
      expect(sqls().slice(indexOf(/INSERT INTO users/) + 1)).toEqual([
        'SAVEPOINT company_bootstrap',
        'SELECT public.employer_ensure_organization($1) AS org',
        'RELEASE SAVEPOINT company_bootstrap',
        'COMMIT',
      ]);
    });

    it('worker sign-up ignores clientMetadata', async () => {
      await handler(employerEvent({ inviteToken: TOKEN }, 'worker'));
      expect(has(TOKEN_SQL)).toBe(false);
      expect(has(EMAIL_SQL)).toBe(false);
      expect(has(ENSURE_SQL)).toBe(false);
      expect(sqls().some((s) => /lock_timeout|SAVEPOINT/.test(s))).toBe(false);
      expect(sqls().slice(indexOf(/INSERT INTO users/) + 1)).toEqual(['COMMIT']);
    });
  });

  describe('change context', () => {
    it('states an anonymous actor, with no id, before the users row is created', async () => {
      mockCognitoSend.mockResolvedValue({});
      mockQuery.mockResolvedValue({});
      await handler(createEvent('worker'), { awsRequestId: 'fixture-invocation-1' } as never);
      expect(setAuditContext).toHaveBeenCalledTimes(1);
      expect(setAuditContext).toHaveBeenCalledWith(
        expect.objectContaining({ query: mockQuery }),
        expect.objectContaining({ actorKind: 'anonymous', actorId: null, channel: 'web', requestId: 'fixture-invocation-1' }),
        'auth.post_confirmation',
      );
      expectContextBeforeWrite(mockQuery, setAuditContext as jest.Mock, /INSERT INTO users/);
    });

    it('states nothing for other trigger sources', async () => {
      const event = createEvent('worker');
      await handler({ ...event, triggerSource: 'PostConfirmation_ConfirmForgotPassword' } as never);
      expect(setAuditContext).not.toHaveBeenCalled();
    });
  });
});
