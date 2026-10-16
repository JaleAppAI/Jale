/**
 * The admin pool's directory, for the Admins page (contract K1.5) and trusted
 * browsers (K1.2): a thin wrapper over the Cognito admin API, scoped to the
 * console's own user pool (the Lambda role may call these actions on that
 * pool's ARN only).
 *
 * `username` names the pool user. The pool signs users in by email (email is
 * its username attribute, not an alias), and Cognito's usernames are
 * case-sensitive, so a stored email in another case does not resolve. Calls
 * on an existing admin pass the user's sign-in id (`sub`, admin_users
 * .cognito_sub), which Cognito accepts as the username; device calls pass the
 * verified access token's `username` claim. Only creating the user and
 * sending the invitation again name the user by its (lower-case) email.
 *
 * Errors are Cognito's own, rethrown; `directoryErrorName(error)` reads the
 * exception name (e.g. UsernameExistsException) for the callers that branch
 * on one. Nothing here logs a value.
 */
import {
  AdminAddUserToGroupCommand,
  AdminCreateUserCommand,
  AdminDisableUserCommand,
  AdminEnableUserCommand,
  AdminForgetDeviceCommand,
  AdminGetDeviceCommand,
  AdminGetUserCommand,
  AdminListDevicesCommand,
  AdminListGroupsForUserCommand,
  AdminRemoveUserFromGroupCommand,
  AdminUpdateDeviceStatusCommand,
  AdminUserGlobalSignOutCommand,
  CognitoIdentityProviderClient,
} from '@aws-sdk/client-cognito-identity-provider';
import { getAdminAuthConfig } from '../auth';

/** A user as the Admins page needs it: the sign-in id and the account state. */
export type AdminDirectoryUser = {
  sub: string;
  /** Cognito's UserStatus, e.g. FORCE_CHANGE_PASSWORD (invited, never signed in) or CONFIRMED. */
  status: string;
  enabled: boolean;
};

export interface AdminDirectory {
  /** Creates the user and sends the invitation email. Returns its sign-in id. */
  createUser(email: string): Promise<{ sub: string }>;
  /** Sends the invitation again, with a new temporary password. */
  resendInvitation(email: string): Promise<void>;
  /** The user, or undefined when the pool has none by that name. */
  getUser(username: string): Promise<AdminDirectoryUser | undefined>;
  addToGroup(username: string, group: string): Promise<void>;
  removeFromGroup(username: string, group: string): Promise<void>;
  listGroups(username: string): Promise<string[]>;
  disableUser(username: string): Promise<void>;
  enableUser(username: string): Promise<void>;
  /** Revokes the user's refresh tokens; it does not forget remembered devices. */
  globalSignOut(username: string): Promise<void>;
  /** Every device key the pool holds for the user. */
  listDeviceKeys(username: string): Promise<string[]>;
  forgetDevice(username: string, deviceKey: string): Promise<void>;
  /** 'remembered', 'not_remembered', or undefined when the pool reports none. */
  getDeviceRememberedStatus(username: string, deviceKey: string): Promise<string | undefined>;
  setDeviceRemembered(username: string, deviceKey: string, remembered: boolean): Promise<void>;
}

/** The Cognito exception name of an error, or undefined. */
export function directoryErrorName(error: unknown): string | undefined {
  if (error && typeof error === 'object' && 'name' in error && typeof (error as { name: unknown }).name === 'string') {
    return (error as { name: string }).name;
  }
  return undefined;
}

let client: CognitoIdentityProviderClient | undefined;

function poolClient(): { client: CognitoIdentityProviderClient; UserPoolId: string } {
  const config = getAdminAuthConfig();
  if (!config.userPoolId) {
    throw new Error('Admin Cognito user pool ID is required for directory calls');
  }
  client ??= new CognitoIdentityProviderClient({ region: config.region });
  return { client, UserPoolId: config.userPoolId };
}

function attribute(attributes: Array<{ Name?: string; Value?: string }> | undefined, name: string): string | undefined {
  return attributes?.find((entry) => entry.Name === name)?.Value;
}

const LIST_PAGE_LIMIT = 60;
const MAX_PAGES = 50;

/** The directory of the console's own user pool. The SDK client is built on first use. */
export function getAdminDirectory(): AdminDirectory {
  return {
    async createUser(email) {
      const { client: c, UserPoolId } = poolClient();
      const result = await c.send(new AdminCreateUserCommand({
        UserPoolId,
        Username: email,
        UserAttributes: [
          { Name: 'email', Value: email },
          { Name: 'email_verified', Value: 'true' },
        ],
        DesiredDeliveryMediums: ['EMAIL'],
      }));
      const sub = attribute(result.User?.Attributes, 'sub');
      if (!sub) {
        throw new Error('Cognito returned no sign-in id for the new user');
      }
      return { sub };
    },

    async resendInvitation(email) {
      const { client: c, UserPoolId } = poolClient();
      await c.send(new AdminCreateUserCommand({
        UserPoolId,
        Username: email,
        MessageAction: 'RESEND',
        DesiredDeliveryMediums: ['EMAIL'],
      }));
    },

    async getUser(username) {
      const { client: c, UserPoolId } = poolClient();
      try {
        const result = await c.send(new AdminGetUserCommand({ UserPoolId, Username: username }));
        return {
          sub: attribute(result.UserAttributes, 'sub') ?? '',
          status: result.UserStatus ?? '',
          enabled: result.Enabled === true,
        };
      } catch (error) {
        if (directoryErrorName(error) === 'UserNotFoundException') return undefined;
        throw error;
      }
    },

    async addToGroup(username, group) {
      const { client: c, UserPoolId } = poolClient();
      await c.send(new AdminAddUserToGroupCommand({ UserPoolId, Username: username, GroupName: group }));
    },

    async removeFromGroup(username, group) {
      const { client: c, UserPoolId } = poolClient();
      await c.send(new AdminRemoveUserFromGroupCommand({ UserPoolId, Username: username, GroupName: group }));
    },

    async listGroups(username) {
      const { client: c, UserPoolId } = poolClient();
      const groups: string[] = [];
      let NextToken: string | undefined;
      for (let page = 0; page < MAX_PAGES; page += 1) {
        const result = await c.send(new AdminListGroupsForUserCommand({
          UserPoolId, Username: username, Limit: LIST_PAGE_LIMIT, NextToken,
        }));
        for (const group of result.Groups ?? []) {
          if (group.GroupName) groups.push(group.GroupName);
        }
        NextToken = result.NextToken;
        if (!NextToken) return groups;
      }
      throw new Error('Cognito group listing did not end');
    },

    async disableUser(username) {
      const { client: c, UserPoolId } = poolClient();
      await c.send(new AdminDisableUserCommand({ UserPoolId, Username: username }));
    },

    async enableUser(username) {
      const { client: c, UserPoolId } = poolClient();
      await c.send(new AdminEnableUserCommand({ UserPoolId, Username: username }));
    },

    async globalSignOut(username) {
      const { client: c, UserPoolId } = poolClient();
      await c.send(new AdminUserGlobalSignOutCommand({ UserPoolId, Username: username }));
    },

    async listDeviceKeys(username) {
      const { client: c, UserPoolId } = poolClient();
      const keys: string[] = [];
      let PaginationToken: string | undefined;
      for (let page = 0; page < MAX_PAGES; page += 1) {
        const result = await c.send(new AdminListDevicesCommand({
          UserPoolId, Username: username, Limit: LIST_PAGE_LIMIT, PaginationToken,
        }));
        for (const device of result.Devices ?? []) {
          if (device.DeviceKey) keys.push(device.DeviceKey);
        }
        PaginationToken = result.PaginationToken;
        if (!PaginationToken) return keys;
      }
      throw new Error('Cognito device listing did not end');
    },

    async forgetDevice(username, deviceKey) {
      const { client: c, UserPoolId } = poolClient();
      await c.send(new AdminForgetDeviceCommand({ UserPoolId, Username: username, DeviceKey: deviceKey }));
    },

    async getDeviceRememberedStatus(username, deviceKey) {
      const { client: c, UserPoolId } = poolClient();
      const result = await c.send(new AdminGetDeviceCommand({ UserPoolId, Username: username, DeviceKey: deviceKey }));
      return attribute(result.Device?.DeviceAttributes, 'dev:device_remembered_status');
    },

    async setDeviceRemembered(username, deviceKey, remembered) {
      const { client: c, UserPoolId } = poolClient();
      await c.send(new AdminUpdateDeviceStatusCommand({
        UserPoolId,
        Username: username,
        DeviceKey: deviceKey,
        DeviceRememberedStatus: remembered ? 'remembered' : 'not_remembered',
      }));
    },
  };
}
