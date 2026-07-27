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

    const res = await handler(mkEv({ phone: '+19152272188', fullName: 'Ivan Worker' }));

    expect(res.statusCode).toBe(200);
    expect(mockSend.mock.calls[0][0]).toBeInstanceOf(AdminCreateUserCommand);
    expect(mockSend.mock.calls[0][0].input).toEqual(expect.objectContaining({
      UserPoolId: 'worker-pool',
      Username: '+19152272188',
      MessageAction: 'SUPPRESS',
      UserAttributes: expect.arrayContaining([
        { Name: 'phone_number', Value: '+19152272188' },
        // 2026-07-26 hardening: an unauthenticated POST proves nothing.
        // Verified stays 'false' until verify-auth-challenge flips it on a
        // correct OTP.
        { Name: 'phone_number_verified', Value: 'false' },
        { Name: 'custom:user_type', Value: 'worker' },
      ]),
    }));
    // The caller-supplied name must NOT reach Cognito from this
    // unauthenticated endpoint (pre-registration poisoning vector); it
    // arrives via the authenticated post-OTP profile update instead.
    const createAttrs = mockSend.mock.calls[0][0].input.UserAttributes as Array<{ Name: string }>;
    expect(createAttrs.some((a) => a.Name === 'name')).toBe(false);
    expect(mockSend.mock.calls[1][0]).toBeInstanceOf(AdminGetUserCommand);
    expect(mockSend.mock.calls[2][0]).toBeInstanceOf(AdminAddUserToGroupCommand);
    expect(mockSend.mock.calls[2][0].input).toEqual({
      UserPoolId: 'worker-pool',
      Username: '+19152272188',
      GroupName: 'Workers',
    });
    expect(mockSend.mock.calls[3][0]).toBeInstanceOf(AdminSetUserPasswordCommand);
    expect(mockSend.mock.calls[3][0].input).toEqual({
      UserPoolId: 'worker-pool',
      Username: '+19152272188',
      Password: expect.any(String),
      Permanent: true,
    });
    // Seeded WITHOUT the caller-supplied name — '' is a safe no-op through
    // reconcile_worker_signup's NULLIF/COALESCE.
    expect(mockQuery).toHaveBeenCalledWith('SELECT reconcile_worker_signup($1, $2, $3)', [
      'worker-sub',
      '+19152272188',
      '',
    ]);
    // The submitted name IS staged (not written to full_name directly) so
    // verify-auth-challenge can promote it on the first correct OTP.
    expect(mockQuery).toHaveBeenCalledWith('SELECT stage_worker_pending_name($1, $2)', [
      'worker-sub',
      'Ivan Worker',
    ]);
    expect(mockQuery.mock.invocationCallOrder[1]).toBeLessThan(mockSend.mock.invocationCallOrder[3]);
    expect(mockRelease).toHaveBeenCalled();
  });

  it('repairs an existing worker using Cognito-stored identity data', async () => {
    mockSend
      .mockRejectedValueOnce({ name: 'UsernameExistsException' })
      .mockResolvedValueOnce({
        Enabled: true,
        UserStatus: 'CONFIRMED',
        UserAttributes: [
          { Name: 'sub', Value: 'worker-sub' },
          { Name: 'phone_number', Value: '+19152272188' },
          { Name: 'phone_number_verified', Value: 'true' },
          { Name: 'custom:user_type', Value: 'worker' },
          { Name: 'name', Value: 'Stored Worker' },
        ],
      })
      .mockResolvedValueOnce({});

    const res = await handler(mkEv({ phone: '+19152272188', fullName: 'Attacker Rename' }));

    expect(res.statusCode).toBe(200);
    expect(mockSend).toHaveBeenCalledTimes(3);
    // Neither the attacker-supplied rename NOR the Cognito-stored name is
    // written from this unauthenticated path — '' preserves whatever
    // users.full_name already holds (NULLIF/COALESCE no-op) and the
    // authenticated post-OTP profile update remains the only name writer.
    expect(mockQuery).toHaveBeenCalledWith('SELECT reconcile_worker_signup($1, $2, $3)', [
      'worker-sub',
      '+19152272188',
      '',
    ]);
    // The attacker-supplied name is staged, not written directly — it can
    // only ever be promoted by a correct OTP, and only while full_name is
    // still NULL (promote_worker_pending_name enforces both).
    expect(mockQuery).toHaveBeenCalledWith('SELECT stage_worker_pending_name($1, $2)', [
      'worker-sub',
      'Attacker Rename',
    ]);
  });

  it('does not fail signup when staging the pending name throws', async () => {
    mockSend
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({
        UserAttributes: [{ Name: 'sub', Value: 'worker-sub' }],
      })
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({});

    mockQuery.mockImplementation(async (sql: string) => {
      if (sql === 'SELECT stage_worker_pending_name($1, $2)') {
        throw new Error('staging boom');
      }
      return {};
    });
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});

    const res = await handler(mkEv({ phone: '+19152272188', fullName: 'Ivan Worker' }));

    expect(res.statusCode).toBe(200);
    expect(warnSpy).toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  it('does not fail the reconcile-path signup when staging the pending name throws', async () => {
    mockSend
      .mockRejectedValueOnce({ name: 'UsernameExistsException' })
      .mockResolvedValueOnce({
        Enabled: true,
        UserStatus: 'CONFIRMED',
        UserAttributes: [
          { Name: 'sub', Value: 'worker-sub' },
          { Name: 'phone_number', Value: '+19152272188' },
          { Name: 'phone_number_verified', Value: 'true' },
          { Name: 'custom:user_type', Value: 'worker' },
          { Name: 'name', Value: 'Stored Worker' },
        ],
      })
      .mockResolvedValueOnce({});

    mockQuery.mockImplementation(async (sql: string) => {
      if (sql === 'SELECT stage_worker_pending_name($1, $2)') {
        throw new Error('staging boom');
      }
      return {};
    });
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});

    const res = await handler(mkEv({ phone: '+19152272188', fullName: 'Attacker Rename' }));

    expect(res.statusCode).toBe(200);
    expect(warnSpy).toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  it('returns a generic retryable error when existing-account inspection fails', async () => {
    mockSend
      .mockRejectedValueOnce({ name: 'UsernameExistsException' })
      .mockRejectedValueOnce(new Error('temporary Cognito failure'));

    const res = await handler(mkEv({ phone: '+19152272188', fullName: 'Ivan Worker' }));

    expect(res.statusCode).toBe(500);
    expect(JSON.parse(res.body)).toEqual({
      error: 'signup_failed',
      message: 'Worker signup failed.',
    });
    expect(mockSend).toHaveBeenCalledTimes(2);
    expect(mockGetDbPool).not.toHaveBeenCalled();
  });
});
