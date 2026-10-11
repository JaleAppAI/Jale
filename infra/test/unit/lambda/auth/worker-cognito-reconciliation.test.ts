import {
  ensureWorkerCognitoAccount,
  reconcileWorkerCognitoAccount,
} from '../../../../lambda/auth/lib/worker-cognito-reconciliation';

jest.mock('@aws-sdk/client-cognito-identity-provider', () => ({
  CognitoIdentityProviderClient: jest.fn(),
  AdminAddUserToGroupCommand: jest.fn((input) => ({ input, type: 'add-group' })),
  AdminCreateUserCommand: jest.fn((input) => ({ input, type: 'create' })),
  AdminEnableUserCommand: jest.fn((input) => ({ input, type: 'enable' })),
  AdminGetUserCommand: jest.fn((input) => ({ input, type: 'get' })),
  AdminSetUserPasswordCommand: jest.fn((input) => ({ input, type: 'set-password' })),
  AdminUpdateUserAttributesCommand: jest.fn((input) => ({ input, type: 'update-attributes' })),
}));

describe('ensureWorkerCognitoAccount', () => {
  it('creates and reconciles a missing worker account before returning it', async () => {
    const phone = '+19152272188';
    const notFound = Object.assign(new Error('not found'), { name: 'UserNotFoundException' });
    const send = jest.fn()
      .mockRejectedValueOnce(notFound)
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({
        Enabled: true,
        UserStatus: 'CONFIRMED',
        UserAttributes: [
          { Name: 'sub', Value: 'new-worker-sub' },
          { Name: 'phone_number', Value: phone },
          { Name: 'phone_number_verified', Value: 'true' },
          { Name: 'custom:user_type', Value: 'worker' },
        ],
      })
      .mockResolvedValueOnce({});

    await expect(ensureWorkerCognitoAccount({
      client: { send } as any,
      userPoolId: 'pool',
      phone,
    })).resolves.toEqual({ cognitoSub: 'new-worker-sub' });

    expect(send.mock.calls.map(([command]) => command.type)).toEqual([
      'get',
      'create',
      'set-password',
      'get',
      'add-group',
    ]);
    expect(send.mock.calls[1][0].input).toEqual(expect.objectContaining({
      UserPoolId: 'pool',
      Username: phone,
      MessageAction: 'SUPPRESS',
      UserAttributes: expect.arrayContaining([
        { Name: 'phone_number', Value: phone },
        // 2026-07-26 hardening: creation is not possession proof; only
        // verify-auth-challenge may flip this to 'true'.
        { Name: 'phone_number_verified', Value: 'false' },
        { Name: 'custom:user_type', Value: 'worker' },
      ]),
    }));
    expect(send.mock.calls[2][0].input).toEqual(expect.objectContaining({
      Username: phone,
      Permanent: true,
    }));
  });
});

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

  it('never force-syncs phone_number_verified to true for an unverified account', async () => {
    // 2026-07-26 hardening: reconciliation runs from unauthenticated paths
    // (repeat web signup, WhatsApp issueChallenge). Possession is unproven
    // there — only verify-auth-challenge's correct-OTP flip may verify.
    const send = jest.fn()
      .mockResolvedValueOnce({
        Enabled: true,
        UserStatus: 'CONFIRMED',
        UserAttributes: [
          { Name: 'sub', Value: 'worker-sub' },
          { Name: 'phone_number', Value: '+19152272188' },
          { Name: 'phone_number_verified', Value: 'false' },
          { Name: 'custom:user_type', Value: 'worker' },
        ],
      })
      .mockResolvedValueOnce({});

    await reconcileWorkerCognitoAccount({
      client: { send } as any,
      userPoolId: 'pool',
      phone: '+19152272188',
    });

    // No update-attributes call at all — the unverified flag stands.
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
