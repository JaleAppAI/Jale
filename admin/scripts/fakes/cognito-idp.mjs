// Fake for @aws-sdk/client-cognito-identity-provider in the admin check
// scripts. Every command sent is recorded on globalThis.__adminCheck.cognito
// .sent as { name, input }; `behavior(command)` may return a result or an
// Error to throw, and `onSend(command)` lets a check put the call into its
// own ordered log. Errors are thrown with Cognito's exception name.
function state() {
  const check = (globalThis.__adminCheck ??= {});
  return (check.cognito ??= { clients: [], sent: [], behavior: undefined, onSend: undefined });
}

/** An error shaped like the SDK's service exceptions: `name` is the exception. */
export function cognitoError(name, message = name) {
  return Object.assign(new Error(message), { name });
}

function command(name) {
  return class {
    constructor(input) {
      this.name = name;
      this.input = input;
    }
  };
}

export const AdminAddUserToGroupCommand = command('AdminAddUserToGroup');
export const AdminCreateUserCommand = command('AdminCreateUser');
export const AdminDisableUserCommand = command('AdminDisableUser');
export const AdminEnableUserCommand = command('AdminEnableUser');
export const AdminForgetDeviceCommand = command('AdminForgetDevice');
export const AdminGetDeviceCommand = command('AdminGetDevice');
export const AdminGetUserCommand = command('AdminGetUser');
export const AdminListDevicesCommand = command('AdminListDevices');
export const AdminListGroupsForUserCommand = command('AdminListGroupsForUser');
export const AdminRemoveUserFromGroupCommand = command('AdminRemoveUserFromGroup');
export const AdminUpdateDeviceStatusCommand = command('AdminUpdateDeviceStatus');
export const AdminUserGlobalSignOutCommand = command('AdminUserGlobalSignOut');

export class CognitoIdentityProviderClient {
  constructor(config) {
    state().clients.push(config ?? {});
  }

  async send(sent) {
    const current = state();
    current.sent.push({ name: sent.name, input: sent.input });
    current.onSend?.(sent);
    const outcome = current.behavior?.(sent);
    if (outcome instanceof Error) {
      throw outcome;
    }
    return outcome ?? {};
  }
}
