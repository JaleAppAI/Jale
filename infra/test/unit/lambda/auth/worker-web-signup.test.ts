import type { APIGatewayProxyEvent } from 'aws-lambda';
import {
  AdminAddUserToGroupCommand,
  AdminCreateUserCommand,
  AdminConfirmSignUpCommand,
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
  class AdminConfirmSignUpCommand {
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
    AdminConfirmSignUpCommand,
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

  it('repairs and seeds an existing confirmed worker user', async () => {
    mockSend
      .mockRejectedValueOnce({ name: 'UsernameExistsException' })
      .mockResolvedValueOnce({
        UserStatus: 'CONFIRMED',
        UserAttributes: [{ Name: 'sub', Value: 'existing-sub' }],
      })
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({
        UserAttributes: [{ Name: 'sub', Value: 'existing-sub' }],
      })
      .mockResolvedValueOnce({});

    const res = await handler(mkEv({ phone: '+19152272188', fullName: 'Ivan Worker' }));

    expect(res.statusCode).toBe(200);
    expect(mockSend.mock.calls[1][0]).toBeInstanceOf(AdminGetUserCommand);
    expect(mockSend.mock.calls[1][0].input).toEqual({
      UserPoolId: 'worker-pool',
      Username: '+19152272188',
    });
    expect(mockSend.mock.calls[2][0]).toBeInstanceOf(AdminSetUserPasswordCommand);
    expect(mockSend.mock.calls[4][0]).toBeInstanceOf(AdminAddUserToGroupCommand);
    expect(mockSetRlsContext).toHaveBeenCalledWith(expect.any(Object), 'existing-sub');
  });

  it('confirms and seeds a stale unconfirmed worker user', async () => {
    mockSend
      .mockRejectedValueOnce({ name: 'UsernameExistsException' })
      .mockResolvedValueOnce({
        UserStatus: 'UNCONFIRMED',
        UserAttributes: [{ Name: 'sub', Value: 'stale-sub' }],
      })
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({
        UserAttributes: [{ Name: 'sub', Value: 'stale-sub' }],
      })
      .mockResolvedValueOnce({});

    const res = await handler(mkEv({ phone: '+19152272188', fullName: 'Ivan Worker' }));

    expect(res.statusCode).toBe(200);
    expect(mockSend.mock.calls[2][0]).toBeInstanceOf(AdminConfirmSignUpCommand);
    expect(mockSend.mock.calls[2][0].input).toEqual({
      UserPoolId: 'worker-pool',
      Username: '+19152272188',
    });
    expect(mockSend.mock.calls[3][0]).toBeInstanceOf(AdminSetUserPasswordCommand);
    expect(mockSend.mock.calls[5][0]).toBeInstanceOf(AdminAddUserToGroupCommand);
    expect(mockSetRlsContext).toHaveBeenCalledWith(expect.any(Object), 'stale-sub');
  });
});
