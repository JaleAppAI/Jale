import type { APIGatewayProxyEvent } from 'aws-lambda';
import {
  AdminAddUserToGroupCommand,
  AdminCreateUserCommand,
  AdminGetUserCommand,
  AdminSetUserPasswordCommand,
} from '@aws-sdk/client-cognito-identity-provider';
import { handler } from '../../../../lambda/auth/worker-web-signup';
import { getDbPool, setRlsContext } from '../../../../lambda/lib/db';

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
  class AdminSetUserPasswordCommand {
    constructor(public input: any) {}
  }

  return {
    CognitoIdentityProviderClient: jest.fn(() => ({
      send: (...args: any[]) => mockSend(...args),
    })),
    AdminAddUserToGroupCommand,
    AdminCreateUserCommand,
    AdminGetUserCommand,
    AdminSetUserPasswordCommand,
  };
});

jest.mock('../../../../lambda/lib/db');

const mockGetDbPool = getDbPool as jest.Mock;
const mockSetRlsContext = setRlsContext as jest.Mock;
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
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({
        UserAttributes: [{ Name: 'sub', Value: 'worker-sub' }],
      })
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
        { Name: 'phone_number_verified', Value: 'true' },
        { Name: 'name', Value: 'Ivan Worker' },
        { Name: 'custom:user_type', Value: 'worker' },
      ]),
    }));
    expect(mockSend.mock.calls[1][0]).toBeInstanceOf(AdminSetUserPasswordCommand);
    expect(mockSend.mock.calls[1][0].input).toEqual({
      UserPoolId: 'worker-pool',
      Username: '+19152272188',
      Password: expect.any(String),
      Permanent: true,
    });
    expect(mockSend.mock.calls[2][0]).toBeInstanceOf(AdminGetUserCommand);
    expect(mockSend.mock.calls[3][0]).toBeInstanceOf(AdminAddUserToGroupCommand);
    expect(mockSend.mock.calls[3][0].input).toEqual({
      UserPoolId: 'worker-pool',
      Username: '+19152272188',
      GroupName: 'Workers',
    });
    expect(mockSetRlsContext).toHaveBeenCalledWith(expect.any(Object), 'worker-sub');
    expect(mockQuery).toHaveBeenCalledWith(expect.stringContaining('INSERT INTO users'), [
      'worker-sub',
      '+19152272188',
      'Ivan Worker',
    ]);
    expect(mockRelease).toHaveBeenCalled();
  });

  it('does not mutate an existing confirmed worker before OTP ownership proof', async () => {
    mockSend
      .mockRejectedValueOnce({ name: 'UsernameExistsException' })
      .mockResolvedValueOnce({});

    const res = await handler(mkEv({ phone: '+19152272188', fullName: 'Attacker Rename' }));

    expect(res.statusCode).toBe(200);
    expect(mockSend).toHaveBeenCalledTimes(1);
    expect(mockGetDbPool).not.toHaveBeenCalled();
    expect(mockSetRlsContext).not.toHaveBeenCalled();
  });

  it('does not repair a stale unconfirmed worker through the unauthenticated endpoint', async () => {
    mockSend
      .mockRejectedValueOnce({ name: 'UsernameExistsException' });

    const res = await handler(mkEv({ phone: '+19152272188', fullName: 'Ivan Worker' }));

    expect(res.statusCode).toBe(200);
    expect(mockSend).toHaveBeenCalledTimes(1);
    expect(mockGetDbPool).not.toHaveBeenCalled();
  });
});
