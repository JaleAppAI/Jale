import {
  AdminAddUserToGroupCommand,
  AdminCreateUserCommand,
  AdminEnableUserCommand,
  AdminGetUserCommand,
  AdminSetUserPasswordCommand,
  AdminUpdateUserAttributesCommand,
  CognitoIdentityProviderClient,
} from '@aws-sdk/client-cognito-identity-provider';
import { randomInt } from 'node:crypto';

type CognitoClient = {
  send(command: unknown): Promise<any>;
};

const cognito = new CognitoIdentityProviderClient({});

export async function ensureWorkerCognitoAccount(input: {
  client?: CognitoClient;
  userPoolId: string;
  phone: string;
}): Promise<{ cognitoSub: string; storedName?: string }> {
  const client = input.client ?? cognito;
  try {
    return await reconcileWorkerCognitoAccount({ ...input, client });
  } catch (err) {
    if ((err as { name?: string } | undefined)?.name !== 'UserNotFoundException') {
      throw err;
    }
  }

  const password = randomPermanentPassword();
  try {
    await client.send(new AdminCreateUserCommand({
      UserPoolId: input.userPoolId,
      Username: input.phone,
      MessageAction: 'SUPPRESS',
      TemporaryPassword: password,
      UserAttributes: [
        { Name: 'phone_number', Value: input.phone },
        { Name: 'phone_number_verified', Value: 'true' },
        { Name: 'custom:user_type', Value: 'worker' },
      ],
    }));
    await client.send(new AdminSetUserPasswordCommand({
      UserPoolId: input.userPoolId,
      Username: input.phone,
      Password: password,
      Permanent: true,
    }));
  } catch (err) {
    if ((err as { name?: string } | undefined)?.name !== 'UsernameExistsException') {
      throw err;
    }
  }

  return reconcileWorkerCognitoAccount({ ...input, client });
}

export async function reconcileWorkerCognitoAccount(input: {
  client?: CognitoClient;
  userPoolId: string;
  phone: string;
}): Promise<{ cognitoSub: string; storedName?: string }> {
  const client = input.client ?? cognito;
  const user = await client.send(new AdminGetUserCommand({
    UserPoolId: input.userPoolId,
    Username: input.phone,
  }));
  const attributes = new Map<string, string>(
    (user.UserAttributes ?? [])
      .filter((attribute: { Name?: string; Value?: string }) => attribute.Name && attribute.Value)
      .map((attribute: { Name: string; Value: string }) => [attribute.Name, attribute.Value]),
  );
  const cognitoSub = attributes.get('sub');
  if (!cognitoSub) {
    throw new Error('worker Cognito account is missing sub');
  }

  const accountType = attributes.get('custom:user_type');
  if (accountType && accountType !== 'worker') {
    throw new Error('conflicting Cognito account type');
  }
  const storedPhone = attributes.get('phone_number');
  if (storedPhone && storedPhone !== input.phone) {
    throw new Error('conflicting Cognito phone attribute');
  }

  const requiredAttributes: Array<{ Name: string; Value: string }> = [];
  if (storedPhone !== input.phone) {
    requiredAttributes.push({ Name: 'phone_number', Value: input.phone });
  }
  if (attributes.get('phone_number_verified') !== 'true') {
    requiredAttributes.push({ Name: 'phone_number_verified', Value: 'true' });
  }
  if (accountType !== 'worker') {
    requiredAttributes.push({ Name: 'custom:user_type', Value: 'worker' });
  }
  if (requiredAttributes.length > 0) {
    await client.send(new AdminUpdateUserAttributesCommand({
      UserPoolId: input.userPoolId,
      Username: input.phone,
      UserAttributes: requiredAttributes,
    }));
  }

  if (user.Enabled === false) {
    await client.send(new AdminEnableUserCommand({
      UserPoolId: input.userPoolId,
      Username: input.phone,
    }));
  }

  if (user.UserStatus === 'FORCE_CHANGE_PASSWORD' || user.UserStatus === 'RESET_REQUIRED') {
    await client.send(new AdminSetUserPasswordCommand({
      UserPoolId: input.userPoolId,
      Username: input.phone,
      Password: randomPermanentPassword(),
      Permanent: true,
    }));
  }

  await client.send(new AdminAddUserToGroupCommand({
    UserPoolId: input.userPoolId,
    Username: input.phone,
    GroupName: 'Workers',
  }));

  return {
    cognitoSub,
    ...(attributes.get('name') ? { storedName: attributes.get('name') } : {}),
  };
}

function randomPermanentPassword(): string {
  const alphabet = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  let token = '';
  for (let index = 0; index < 24; index += 1) {
    token += alphabet[randomInt(0, alphabet.length)];
  }
  return `Jale!${token}9aA`;
}
