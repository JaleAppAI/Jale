import type { APIGatewayProxyEvent } from 'aws-lambda';
import {
  AdminAddUserToGroupCommand,
  AdminCreateUserCommand,
  AdminEnableUserCommand,
  AdminGetUserCommand,
  AdminSetUserPasswordCommand,
  AdminUpdateUserAttributesCommand,
} from '@aws-sdk/client-cognito-identity-provider';
import { handler } from '../../../../lambda/auth/worker-web-signup';
import { getDbPool } from '../../../../lambda/lib/db';
import { setAuditContext } from '../../../../lambda/lib/audit/context';
import { expectContextBeforeWrite, idlessCallerFor } from '../api/audit-expectations';

const mockSend = jest.fn();

jest.mock('@aws-sdk/client-cognito-identity-provider', () => {
  class AdminAddUserToGroupCommand {
    constructor(public input: any) {}
  }
  class AdminCreateUserCommand {
    constructor(public input: any) {}
  }
  class AdminGetUserCommand {
    constructor(public input: any) {}
  }
  class AdminEnableUserCommand {
    constructor(public input: any) {}
  }
  class AdminSetUserPasswordCommand {
    constructor(public input: any) {}
  }
  class AdminUpdateUserAttributesCommand {
    constructor(public input: any) {}
  }

  return {
    CognitoIdentityProviderClient: jest.fn(() => ({
      send: (...args: any[]) => mockSend(...args),
    })),
    AdminAddUserToGroupCommand,
    AdminCreateUserCommand,
    AdminEnableUserCommand,
    AdminGetUserCommand,
    AdminSetUserPasswordCommand,
    AdminUpdateUserAttributesCommand,
  };
});

jest.mock('../../../../lambda/lib/db');
jest.mock('../../../../lambda/lib/audit/context');

const mockGetDbPool = getDbPool as jest.Mock;
const mockQuery = jest.fn();
const mockRelease = jest.fn();

const mkEv = (body: any) => ({
  body: JSON.stringify(body),
} as APIGatewayProxyEvent);

describe('worker-web-signup', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    jest.clearAllMocks();
    mockSend.mockReset();
    mockQuery.mockReset();
    mockRelease.mockReset();

    process.env = {
      ...originalEnv,
      WORKER_POOL_ID: 'worker-pool',
      DB_SECRET_ARN: 'db-secret',
      ALLOWED_ORIGIN: 'http://localhost:3000',
    };

    mockGetDbPool.mockResolvedValue({
      connect: jest.fn().mockResolvedValue({
        query: mockQuery,
        release: mockRelease,
      }),
    });
    mockQuery.mockResolvedValue({});
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  it('creates, confirms, and seeds a worker user', async () => {
    mockSend
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({
        UserAttributes: [{ Name: 'sub', Value: 'worker-sub' }],
      })
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({});

    // R2-C4: the request body is PHONE ONLY. The worker's name is asked for
    // inside the onboarding flow itself, at `profile.name`.
    const res = await handler(mkEv({ phone: '+19155550123' }));

    expect(res.statusCode).toBe(200);
    expect(mockSend.mock.calls[0][0]).toBeInstanceOf(AdminCreateUserCommand);
    expect(mockSend.mock.calls[0][0].input).toEqual(expect.objectContaining({
      UserPoolId: 'worker-pool',
      Username: '+19155550123',
      MessageAction: 'SUPPRESS',
      UserAttributes: expect.arrayContaining([
        { Name: 'phone_number', Value: '+19155550123' },
        // 2026-07-26 hardening: an unauthenticated POST proves nothing.
        // Verified stays 'false' until verify-auth-challenge flips it on a
        // correct OTP.
        { Name: 'phone_number_verified', Value: 'false' },
        { Name: 'custom:user_type', Value: 'worker' },
      ]),
    }));
    // No name reaches Cognito from this unauthenticated endpoint — there is
    // no name to send any more, and pre-registering a stranger's number
    // under an attacker-chosen name was the original poisoning vector.
    const createAttrs = mockSend.mock.calls[0][0].input.UserAttributes as Array<{ Name: string }>;
    expect(createAttrs.some((a) => a.Name === 'name')).toBe(false);
    expect(mockSend.mock.calls[1][0]).toBeInstanceOf(AdminGetUserCommand);
    expect(mockSend.mock.calls[2][0]).toBeInstanceOf(AdminAddUserToGroupCommand);
    expect(mockSend.mock.calls[2][0].input).toEqual({
      UserPoolId: 'worker-pool',
      Username: '+19155550123',
      GroupName: 'Workers',
    });
    expect(mockSend.mock.calls[3][0]).toBeInstanceOf(AdminSetUserPasswordCommand);
    expect(mockSend.mock.calls[3][0].input).toEqual({
      UserPoolId: 'worker-pool',
      Username: '+19155550123',
      Password: expect.any(String),
      Permanent: true,
    });
    // The row is seeded with cognito_sub + phone and NO name — '' is a safe
    // no-op through reconcile_worker_signup's NULLIF/COALESCE. That row is
    // what `resolve_worker_internal_id` (086) hands the onboarding engine;
    // proven end to end against real PostgreSQL in
    // test/unit/db/web-worker-whatsapp-crossover.integration.test.ts.
    expect(mockQuery).toHaveBeenCalledWith('SELECT reconcile_worker_signup($1, $2, $3)', [
      'worker-sub',
      '+19155550123',
      '',
    ]);
    // ...and that is the ONLY statement this endpoint issues: migration
    // 052's staging call is gone (BEGIN/COMMIT bracket it, nothing else).
    const statements = mockQuery.mock.calls.map(([sql]) => sql as string);
    expect(statements).toEqual(['BEGIN', 'SELECT reconcile_worker_signup($1, $2, $3)', 'COMMIT']);
    expect(mockQuery.mock.invocationCallOrder[1]).toBeLessThan(mockSend.mock.invocationCallOrder[3]);
    expect(mockRelease).toHaveBeenCalled();
    // The sign-up is not yet a verified identity, so the
    // change record names an anonymous actor with no id.
    expect(setAuditContext).toHaveBeenCalledTimes(1);
    expect(setAuditContext).toHaveBeenCalledWith(expect.objectContaining({ query: mockQuery }), idlessCallerFor('anonymous'), 'auth.worker_web_signup');
    expectContextBeforeWrite(mockQuery, setAuditContext as jest.Mock, /reconcile_worker_signup/);
  });

  it('repairs an existing worker using Cognito-stored identity data', async () => {
    mockSend
      .mockRejectedValueOnce({ name: 'UsernameExistsException' })
      .mockResolvedValueOnce({
        Enabled: true,
        UserStatus: 'CONFIRMED',
        UserAttributes: [
          { Name: 'sub', Value: 'worker-sub' },
          { Name: 'phone_number', Value: '+19155550123' },
          { Name: 'phone_number_verified', Value: 'true' },
          { Name: 'custom:user_type', Value: 'worker' },
          { Name: 'name', Value: 'Stored Worker' },
        ],
      })
      .mockResolvedValueOnce({});

    const res = await handler(mkEv({ phone: '+19155550123' }));

    expect(res.statusCode).toBe(200);
    expect(mockSend).toHaveBeenCalledTimes(3);
    // The Cognito-stored name is NOT written from this unauthenticated path
    // — '' preserves whatever users.full_name already holds (NULLIF/COALESCE
    // no-op), and `profile.name` inside the flow is the only name writer.
    expect(mockQuery).toHaveBeenCalledWith('SELECT reconcile_worker_signup($1, $2, $3)', [
      'worker-sub',
      '+19155550123',
      '',
    ]);
    const statements = mockQuery.mock.calls.map(([sql]) => sql as string);
    expect(statements).toEqual(['BEGIN', 'SELECT reconcile_worker_signup($1, $2, $3)', 'COMMIT']);
  });

  // ── R2-C4: a stale client that still posts fullName ───────────────────
  //
  // The redesigned form is phone-only, but a cached bundle may keep sending
  // a name through the rollout window. That must be a 200 with the field
  // IGNORED — never a 400 (which would block signup outright) and never a
  // write, since nothing promotes a staged name any more.
  it('accepts and ignores a stale client\'s fullName instead of 400ing', async () => {
    mockSend
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({
        UserAttributes: [{ Name: 'sub', Value: 'worker-sub' }],
      })
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({});
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});

    const res = await handler(mkEv({ phone: '+19155550123', fullName: 'Robin Worker' }));

    expect(res.statusCode).toBe(200);
    // Logged once, and the value itself never appears in the log line.
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(warnSpy.mock.calls)).not.toContain('Robin Worker');
    warnSpy.mockRestore();

    // The name reaches neither Cognito nor the database.
    expect(JSON.stringify(mockSend.mock.calls)).not.toContain('Robin Worker');
    const statements = mockQuery.mock.calls.map(([sql]) => sql as string);
    expect(statements).toEqual(['BEGIN', 'SELECT reconcile_worker_signup($1, $2, $3)', 'COMMIT']);
    expect(mockQuery).toHaveBeenCalledWith('SELECT reconcile_worker_signup($1, $2, $3)', [
      'worker-sub',
      '+19155550123',
      '',
    ]);
  });

  // ── Sprint 28 (K3.6): where the signup started ─────────────────────────
  describe('signup_source', () => {
    const USER_ID = '55555555-5555-4555-8555-555555555555';
    const RECORD = 'SELECT jale_cap.record_signup_source($1, $2, $3, $4)';

    function createsAccount() {
      mockSend
        .mockResolvedValueOnce({})
        .mockResolvedValueOnce({ UserAttributes: [{ Name: 'sub', Value: 'worker-sub' }] })
        .mockResolvedValueOnce({})
        .mockResolvedValueOnce({});
      // reconcile_worker_signup returns the account's id.
      mockQuery.mockImplementation(async (sql: string) => (
        /reconcile_worker_signup/.test(sql) ? { rows: [{ reconcile_worker_signup: USER_ID }] } : {}
      ));
    }
    const statements = () => mockQuery.mock.calls.map(([sql]) => sql as string);

    it('records an allow-listed source for the new account, in the signup transaction', async () => {
      createsAccount();
      const res = await handler(mkEv({ phone: '+19155550123', signup_source: { src: 'qr', entry: 'app' } }));

      expect(res.statusCode).toBe(200);
      expect(statements()).toEqual([
        'BEGIN',
        'SELECT reconcile_worker_signup($1, $2, $3)',
        'SAVEPOINT analytics_capture',
        RECORD,
        'RELEASE SAVEPOINT analytics_capture',
        'COMMIT',
      ]);
      expect(mockQuery).toHaveBeenCalledWith(RECORD, [USER_ID, 'web', 'app', 'qr']);
    });

    it('stores an unknown code as no code, keeping the entry', async () => {
      createsAccount();
      const res = await handler(mkEv({ phone: '+19155550123', signup_source: { src: 'billboard', entry: 'job_link' } }));

      expect(res.statusCode).toBe(200);
      expect(mockQuery).toHaveBeenCalledWith(RECORD, [USER_ID, 'web', 'job_link', null]);
    });

    it('drops a source whose entry is not a web entry, and records nothing', async () => {
      createsAccount();
      const res = await handler(mkEv({ phone: '+19155550123', signup_source: { src: 'qr', entry: 'email' } }));

      expect(res.statusCode).toBe(200);
      expect(statements()).toEqual(['BEGIN', 'SELECT reconcile_worker_signup($1, $2, $3)', 'COMMIT']);
    });

    it('a failing record never fails the signup: the account is still committed and the sign-in set up', async () => {
      createsAccount();
      mockQuery.mockImplementation(async (sql: string) => {
        if (/reconcile_worker_signup/.test(sql)) return { rows: [{ reconcile_worker_signup: USER_ID }] };
        if (sql === RECORD) throw Object.assign(new Error('permission denied'), { code: '42501' });
        return {};
      });
      const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
      const res = await handler(mkEv({ phone: '+19155550123', signup_source: { src: 'qr', entry: 'app' } }));
      warnSpy.mockRestore();

      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.body)).toEqual({ ok: true });
      expect(statements()).toEqual([
        'BEGIN',
        'SELECT reconcile_worker_signup($1, $2, $3)',
        'SAVEPOINT analytics_capture',
        RECORD,
        'ROLLBACK TO SAVEPOINT analytics_capture',
        'RELEASE SAVEPOINT analytics_capture',
        'COMMIT',
      ]);
      expect(mockSend.mock.calls[3][0]).toBeInstanceOf(AdminSetUserPasswordCommand);
    });
  });

  it('rejects a body with no phone at all, and never opens a pool', async () => {
    const res = await handler(mkEv({ fullName: 'Robin Worker' }));

    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body)).toEqual({
      error: 'invalid_phone',
      message: 'Phone must be in E.164 format.',
    });
    expect(mockSend).not.toHaveBeenCalled();
    expect(mockGetDbPool).not.toHaveBeenCalled();
  });

  it('returns a generic retryable error when existing-account inspection fails', async () => {
    mockSend
      .mockRejectedValueOnce({ name: 'UsernameExistsException' })
      .mockRejectedValueOnce(new Error('temporary Cognito failure'));

    const res = await handler(mkEv({ phone: '+19155550123' }));

    expect(res.statusCode).toBe(500);
    expect(JSON.parse(res.body)).toEqual({
      error: 'signup_failed',
      message: 'Worker signup failed.',
    });
    expect(mockSend).toHaveBeenCalledTimes(2);
    expect(mockGetDbPool).not.toHaveBeenCalled();
  });
});
