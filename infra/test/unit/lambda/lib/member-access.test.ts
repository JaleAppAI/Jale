import {
  AdminDisableUserCommand,
  AdminEnableUserCommand,
  AdminGetUserCommand,
  AdminUserGlobalSignOutCommand,
  type CognitoIdentityProviderClient,
} from '@aws-sdk/client-cognito-identity-provider';
import { applyMemberAccess } from '../../../../lambda/lib/member-access';

const POOL = 'us-east-2_TestPool';
const SUB_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const SUB_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

type Command = { constructor: { name: string }; input: Record<string, unknown> };

function cognito(handler: (command: Command) => unknown) {
  const send = jest.fn(async (command: Command) => handler(command));
  return { client: { send } as unknown as CognitoIdentityProviderClient, send };
}

const names = (send: jest.Mock): string[] => send.mock.calls.map(([c]) => (c as Command).constructor.name);
const named = (name: string) => Object.assign(new Error(name), { name });

let logs: { warn: jest.SpyInstance; error: jest.SpyInstance };
beforeEach(() => {
  logs = {
    warn: jest.spyOn(console, 'warn').mockImplementation(() => undefined),
    error: jest.spyOn(console, 'error').mockImplementation(() => undefined),
  };
});
afterEach(() => jest.restoreAllMocks());

const logged = (spy: jest.SpyInstance): Array<Record<string, unknown>> =>
  spy.mock.calls.map(([line]) => JSON.parse(String(line)));

describe('applyMemberAccess', () => {
  it('disables with global sign-out first when enabled is false and Cognito says Enabled', async () => {
    const { client, send } = cognito((c) => (c instanceof AdminGetUserCommand ? { Enabled: true } : {}));
    const result = await applyMemberAccess([{ cognitoSub: SUB_A, enabled: false }], { client, userPoolId: POOL, sleep: jest.fn() });
    expect(result).toEqual({ converged: 1, failed: [] });
    expect(names(send)).toEqual(['AdminGetUserCommand', 'AdminUserGlobalSignOutCommand', 'AdminDisableUserCommand']);
    expect(send.mock.calls[0][0]).toBeInstanceOf(AdminGetUserCommand);
    expect(send.mock.calls[1][0]).toBeInstanceOf(AdminUserGlobalSignOutCommand);
    expect(send.mock.calls[2][0]).toBeInstanceOf(AdminDisableUserCommand);
    for (const [c] of send.mock.calls) expect((c as Command).input).toEqual({ UserPoolId: POOL, Username: SUB_A });
  });

  it('enables when Cognito says disabled', async () => {
    const { client, send } = cognito((c) => (c instanceof AdminGetUserCommand ? { Enabled: false } : {}));
    const result = await applyMemberAccess([{ cognitoSub: SUB_A, enabled: true }], { client, userPoolId: POOL, sleep: jest.fn() });
    expect(result).toEqual({ converged: 1, failed: [] });
    expect(names(send)).toEqual(['AdminGetUserCommand', 'AdminEnableUserCommand']);
    expect(send.mock.calls[1][0]).toBeInstanceOf(AdminEnableUserCommand);
    expect((send.mock.calls[1][0] as Command).input).toEqual({ UserPoolId: POOL, Username: SUB_A });
  });

  it('no call beyond AdminGetUser when already converged', async () => {
    const { client, send } = cognito((c) => ({ Enabled: (c.input.Username as string) === SUB_A }));
    const result = await applyMemberAccess(
      [{ cognitoSub: SUB_A, enabled: true }, { cognitoSub: SUB_B, enabled: false }],
      { client, userPoolId: POOL, sleep: jest.fn() },
    );
    expect(result).toEqual({ converged: 2, failed: [] });
    expect(names(send)).toEqual(['AdminGetUserCommand', 'AdminGetUserCommand']);
  });

  it('UserNotFoundException counts as converged', async () => {
    const { client, send } = cognito(() => { throw named('UserNotFoundException'); });
    const sleep = jest.fn();
    const result = await applyMemberAccess([{ cognitoSub: SUB_A, enabled: false }], { client, userPoolId: POOL, sleep });
    expect(result).toEqual({ converged: 1, failed: [] });
    expect(send).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
    expect(logged(logs.warn)).toEqual([expect.objectContaining({ event: 'member_access_user_missing', cognitoSub: SUB_A })]);
  });

  it('retries 3 times then reports the sub as failed, never throws', async () => {
    const { client, send } = cognito((c) => {
      if ((c.input.Username as string) === SUB_A) throw named('TooManyRequestsException');
      return c instanceof AdminGetUserCommand ? { Enabled: true } : {};
    });
    const sleep = jest.fn(async () => undefined);
    const result = await applyMemberAccess(
      [{ cognitoSub: SUB_A, enabled: false }, { cognitoSub: SUB_B, enabled: false }],
      { client, userPoolId: POOL, sleep },
    );
    expect(result).toEqual({ converged: 1, failed: [SUB_A] });
    expect(names(send).filter((n, i) => n === 'AdminGetUserCommand' && (send.mock.calls[i][0] as Command).input.Username === SUB_A))
      .toHaveLength(3);
    expect(sleep.mock.calls).toEqual([[200], [400]]);
    expect(logged(logs.error)).toEqual([
      expect.objectContaining({ event: 'member_access_failed', cognitoSub: SUB_A, error: 'TooManyRequestsException' }),
    ]);
  });

  it('a failure after the sign-out retries the whole change', async () => {
    let disables = 0;
    const { client, send } = cognito((c) => {
      if (c instanceof AdminGetUserCommand) return { Enabled: true };
      if (c instanceof AdminDisableUserCommand && (disables += 1) === 1) throw named('InternalErrorException');
      return {};
    });
    const result = await applyMemberAccess([{ cognitoSub: SUB_A, enabled: false }], { client, userPoolId: POOL, sleep: jest.fn() });
    expect(result).toEqual({ converged: 1, failed: [] });
    expect(names(send)).toEqual([
      'AdminGetUserCommand', 'AdminUserGlobalSignOutCommand', 'AdminDisableUserCommand',
      'AdminGetUserCommand', 'AdminUserGlobalSignOutCommand', 'AdminDisableUserCommand',
    ]);
  });

  it('never throws, even when the wait itself fails', async () => {
    const { client } = cognito(() => { throw new Error('boom'); });
    const sleep = jest.fn(async () => { throw new Error('sleep failed'); });
    await expect(applyMemberAccess([{ cognitoSub: SUB_A, enabled: true }], { client, userPoolId: POOL, sleep }))
      .resolves.toEqual({ converged: 0, failed: [SUB_A] });
  });

  it.each(['AdminUserGlobalSignOutCommand', 'AdminDisableUserCommand'])(
    'UserNotFoundException on %s counts as converged',
    async (failing) => {
      const { client, send } = cognito((c) => {
        if (c instanceof AdminGetUserCommand) return { Enabled: true };
        if (c.constructor.name === failing) throw named('UserNotFoundException');
        return {};
      });
      const sleep = jest.fn();
      const result = await applyMemberAccess([{ cognitoSub: SUB_A, enabled: false }], { client, userPoolId: POOL, sleep });
      expect(result).toEqual({ converged: 1, failed: [] });
      expect(names(send).at(-1)).toBe(failing);
      expect(sleep).not.toHaveBeenCalled();
      expect(logged(logs.warn)).toEqual([expect.objectContaining({ event: 'member_access_user_missing', cognitoSub: SUB_A })]);
    },
  );

  it.each(['AccessDeniedException', 'ResourceNotFoundException', 'UnrecognizedClientException'])(
    'a pool-level %s fails the rest of the batch with no further call, logged once',
    async (error) => {
      const SUB_C = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
      const { client, send } = cognito((c) => {
        if ((c.input.Username as string) === SUB_B) throw named(error);
        return { Enabled: true };
      });
      const sleep = jest.fn();
      const result = await applyMemberAccess(
        [{ cognitoSub: SUB_A, enabled: true }, { cognitoSub: SUB_B, enabled: true }, { cognitoSub: SUB_C, enabled: true }],
        { client, userPoolId: POOL, sleep },
      );
      expect(result).toEqual({ converged: 1, failed: [SUB_B, SUB_C] });
      expect(send).toHaveBeenCalledTimes(2);
      expect(sleep).not.toHaveBeenCalled();
      expect(logged(logs.error)).toEqual([
        expect.objectContaining({ event: 'member_access_pool_unavailable', error, remaining: 2 }),
      ]);
    },
  );

  it.each(['InvalidParameterException', 'NotAuthorizedException'])(
    '%s is not retried; the change fails and the batch goes on',
    async (error) => {
      const { client, send } = cognito((c) => {
        if ((c.input.Username as string) === SUB_A) throw named(error);
        return { Enabled: true };
      });
      const sleep = jest.fn();
      const result = await applyMemberAccess(
        [{ cognitoSub: SUB_A, enabled: true }, { cognitoSub: SUB_B, enabled: true }],
        { client, userPoolId: POOL, sleep },
      );
      expect(result).toEqual({ converged: 1, failed: [SUB_A] });
      expect(send).toHaveBeenCalledTimes(2);
      expect(sleep).not.toHaveBeenCalled();
      expect(logged(logs.error)).toEqual([expect.objectContaining({ event: 'member_access_failed', cognitoSub: SUB_A, error })]);
    },
  );

  it('a deadline already passed fails every change without a Cognito call, logged once', async () => {
    const { client, send } = cognito(() => ({ Enabled: true }));
    const result = await applyMemberAccess(
      [{ cognitoSub: SUB_A, enabled: false }, { cognitoSub: SUB_B, enabled: true }],
      { client, userPoolId: POOL, sleep: jest.fn(), deadlineAt: Date.now() - 1 },
    );
    expect(result).toEqual({ converged: 0, failed: [SUB_A, SUB_B] });
    expect(send).not.toHaveBeenCalled();
    expect(logged(logs.error)).toEqual([expect.objectContaining({ event: 'member_access_deadline', remaining: 2 })]);
  });

  it('a deadline passed mid-batch (during a retry wait) fails the remaining subs with no further call', async () => {
    let now = 1_000_000;
    jest.spyOn(Date, 'now').mockImplementation(() => now);
    const { client, send } = cognito((c) => {
      if ((c.input.Username as string) === SUB_B) throw named('InternalErrorException');
      return { Enabled: true };
    });
    const sleep = jest.fn(async (ms: number) => { now += ms; });
    const SUB_C = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
    const result = await applyMemberAccess(
      [{ cognitoSub: SUB_A, enabled: true }, { cognitoSub: SUB_B, enabled: true }, { cognitoSub: SUB_C, enabled: true }],
      { client, userPoolId: POOL, sleep, deadlineAt: now + 100 },
    );
    expect(result).toEqual({ converged: 1, failed: [SUB_B, SUB_C] });
    expect(send).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledTimes(1);
    expect(logged(logs.error)).toEqual([expect.objectContaining({ event: 'member_access_deadline', remaining: 2 })]);
  });

  it('builds its default client with bounded timeouts and SDK retries', async () => {
    const send = jest.fn(async () => ({ Enabled: true }));
    const ctor = jest.fn(() => ({ send }));
    let isolated: typeof import('../../../../lambda/lib/member-access') | undefined;
    jest.isolateModules(() => {
      jest.doMock('@aws-sdk/client-cognito-identity-provider', () => ({
        ...jest.requireActual('@aws-sdk/client-cognito-identity-provider'),
        CognitoIdentityProviderClient: ctor,
      }));
      isolated = require('../../../../lambda/lib/member-access');
    });
    await isolated!.applyMemberAccess([{ cognitoSub: SUB_A, enabled: true }], { userPoolId: POOL, sleep: jest.fn() });
    await isolated!.applyMemberAccess([{ cognitoSub: SUB_B, enabled: true }], { userPoolId: POOL, sleep: jest.fn() });
    expect(ctor).toHaveBeenCalledTimes(1);
    expect(ctor).toHaveBeenCalledWith({ maxAttempts: 3, requestHandler: { connectionTimeout: 1000, requestTimeout: 3000 } });
    expect(send).toHaveBeenCalledTimes(2);
    jest.dontMock('@aws-sdk/client-cognito-identity-provider');
  });

  it('missing pool id fails every change without a Cognito call', async () => {
    const before = process.env.EMPLOYER_USER_POOL_ID;
    delete process.env.EMPLOYER_USER_POOL_ID;
    try {
      const { client, send } = cognito(() => ({ Enabled: true }));
      const result = await applyMemberAccess(
        [{ cognitoSub: SUB_A, enabled: false }, { cognitoSub: SUB_B, enabled: true }],
        { client, sleep: jest.fn() },
      );
      expect(result).toEqual({ converged: 0, failed: [SUB_A, SUB_B] });
      expect(send).not.toHaveBeenCalled();
      expect(logged(logs.error)).toEqual([expect.objectContaining({ event: 'member_access_pool_missing' })]);
    } finally {
      if (before !== undefined) process.env.EMPLOYER_USER_POOL_ID = before;
    }
  });

  it('defaults the pool id to EMPLOYER_USER_POOL_ID', async () => {
    const before = process.env.EMPLOYER_USER_POOL_ID;
    process.env.EMPLOYER_USER_POOL_ID = 'us-east-2_FromEnv';
    try {
      const { client, send } = cognito(() => ({ Enabled: true }));
      await applyMemberAccess([{ cognitoSub: SUB_A, enabled: true }], { client, sleep: jest.fn() });
      expect((send.mock.calls[0][0] as Command).input).toEqual({ UserPoolId: 'us-east-2_FromEnv', Username: SUB_A });
    } finally {
      if (before === undefined) delete process.env.EMPLOYER_USER_POOL_ID;
      else process.env.EMPLOYER_USER_POOL_ID = before;
    }
  });

  it('no changes: no call and nothing logged', async () => {
    const { client, send } = cognito(() => ({}));
    expect(await applyMemberAccess([], { client })).toEqual({ converged: 0, failed: [] });
    expect(send).not.toHaveBeenCalled();
    expect(logs.error).not.toHaveBeenCalled();
  });

  it('a change without a sub fails without a Cognito call', async () => {
    const { client, send } = cognito(() => ({ Enabled: true }));
    const result = await applyMemberAccess([{ cognitoSub: '', enabled: false }], { client, userPoolId: POOL, sleep: jest.fn() });
    expect(result).toEqual({ converged: 0, failed: [''] });
    expect(send).not.toHaveBeenCalled();
  });
});
