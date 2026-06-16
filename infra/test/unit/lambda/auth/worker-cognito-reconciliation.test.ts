import { reconcileWorkerCognitoAccount } from '../../../../lambda/auth/lib/worker-cognito-reconciliation';

jest.mock('@aws-sdk/client-cognito-identity-provider', () => ({
  CognitoIdentityProviderClient: jest.fn(),
  AdminAddUserToGroupCommand: jest.fn((input) => ({ input, type: 'add-group' })),
  AdminEnableUserCommand: jest.fn((input) => ({ input, type: 'enable' })),
  AdminGetUserCommand: jest.fn((input) => ({ input, type: 'get' })),
  AdminSetUserPasswordCommand: jest.fn((input) => ({ input, type: 'set-password' })),
  AdminUpdateUserAttributesCommand: jest.fn((input) => ({ input, type: 'update-attributes' })),
}));

describe('reconcileWorkerCognitoAccount', () => {
  it('leaves a healthy account intact and assures group membership', async () => {
    const send = jest.fn()
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

    const result = await reconcileWorkerCognitoAccount({
      client: { send } as any,
      userPoolId: 'pool',
      phone: '+19152272188',
    });

    expect(result).toEqual({ cognitoSub: 'worker-sub', storedName: 'Stored Worker' });
    expect(send).toHaveBeenCalledTimes(2);
    expect(send.mock.calls.map(([command]) => command.type)).toEqual(['get', 'add-group']);
  });

  it('repairs disabled, incomplete, force-change-password accounts', async () => {
    const send = jest.fn()
      .mockResolvedValueOnce({
        Enabled: false,
        UserStatus: 'FORCE_CHANGE_PASSWORD',
        UserAttributes: [{ Name: 'sub', Value: 'worker-sub' }],
      })
      .mockResolvedValue({});

    await reconcileWorkerCognitoAccount({
      client: { send } as any,
      userPoolId: 'pool',
      phone: '+19152272188',
    });

    expect(send.mock.calls.map(([command]) => command.type)).toEqual([
      'get',
      'update-attributes',
      'enable',
      'set-password',
      'add-group',
    ]);
  });

  it('rejects a conflicting non-worker account without mutation', async () => {
    const send = jest.fn().mockResolvedValueOnce({
      Enabled: true,
      UserStatus: 'CONFIRMED',
      UserAttributes: [
        { Name: 'sub', Value: 'employer-sub' },
        { Name: 'phone_number', Value: '+19152272188' },
        { Name: 'custom:user_type', Value: 'employer' },
      ],
    });

    await expect(reconcileWorkerCognitoAccount({
      client: { send } as any,
      userPoolId: 'pool',
      phone: '+19152272188',
    })).rejects.toThrow('conflicting Cognito account type');
    expect(send).toHaveBeenCalledTimes(1);
  });
});
