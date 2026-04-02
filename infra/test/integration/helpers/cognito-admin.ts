// infra/test/integration/helpers/cognito-admin.ts

import {
  CognitoIdentityProviderClient,
  AdminCreateUserCommand,
  AdminSetUserPasswordCommand,
  AdminGetUserCommand,
  AdminDeleteUserCommand,
  AdminInitiateAuthCommand,
} from '@aws-sdk/client-cognito-identity-provider';
import { LambdaClient, InvokeCommand } from '@aws-sdk/client-lambda';
import { fromIni } from '@aws-sdk/credential-provider-ini';

// Uses AWS_PROFILE and AWS_REGION from process.env (loaded by dotenv in global-setup).
// Credentials are passed explicitly because the default provider chain does not reliably
// pick up AWS_PROFILE when it is set dynamically via process.env.
function getCredentials() {
  const profile = process.env.AWS_PROFILE;
  return profile ? fromIni({ profile }) : undefined;
}

function makeCognito() {
  return new CognitoIdentityProviderClient({
    region: process.env.AWS_REGION,
    credentials: getCredentials(),
  });
}

function makeLambda() {
  return new LambdaClient({
    region: process.env.AWS_REGION,
    credentials: getCredentials(),
  });
}

export interface TestUserTokens {
  idToken: string;
  accessToken: string;
  refreshToken: string;
}

/**
 * Creates a Cognito user, sets a permanent password, invokes the post-confirmation
 * Lambda directly (to create the DB record), then authenticates.
 *
 * Workers use phone numbers as usernames (e.g. "+19999000001") — the Worker pool
 * is configured with signInAliases: { phone: true } and has no email attribute.
 * Employers use email addresses as usernames — the Employer pool is email-based.
 *
 * Returns tokens for use in tests.
 */
export async function createTestUser(
  poolId: string,
  clientId: string,
  username: string,          // phone number (workers) or email address (employers)
  password: string,
  userType: 'employer' | 'worker',
  postConfirmationLambdaArn: string,
): Promise<TestUserTokens> {
  const cognito = makeCognito();

  // Build pool-specific user attributes
  const userAttributes =
    userType === 'worker'
      ? [
          { Name: 'custom:user_type', Value: 'worker' },
          { Name: 'phone_number', Value: username },
          { Name: 'phone_number_verified', Value: 'true' },
        ]
      : [
          { Name: 'custom:user_type', Value: 'employer' },
          { Name: 'email', Value: username },
          { Name: 'email_verified', Value: 'true' },
        ];

  // Step 1: Create user (suppress welcome message)
  await cognito.send(new AdminCreateUserCommand({
    UserPoolId: poolId,
    Username: username,
    MessageAction: 'SUPPRESS',
    TemporaryPassword: `${password}Temp!`,
    UserAttributes: userAttributes,
  }));

  // Step 2: Set permanent password (skips FORCE_CHANGE_PASSWORD state)
  await cognito.send(new AdminSetUserPasswordCommand({
    UserPoolId: poolId,
    Username: username,
    Password: password,
    Permanent: true,
  }));

  // Step 3: Get the user's Cognito sub (needed for the post-confirmation event)
  const userDetails = await cognito.send(new AdminGetUserCommand({
    UserPoolId: poolId,
    Username: username,
  }));
  const sub = userDetails.UserAttributes?.find(a => a.Name === 'sub')?.Value;
  if (!sub) throw new Error('Failed to get cognito sub for test user');

  // Step 4: Invoke post-confirmation Lambda directly to create the DB record.
  // AdminCreateUser does NOT trigger the PostConfirmation Cognito trigger,
  // so we manually invoke the Lambda with a crafted Cognito event.
  const lambda = makeLambda();

  // Mirror the real Cognito event shape the Lambda expects
  const eventUserAttributes: Record<string, string> =
    userType === 'worker'
      ? { sub, 'custom:user_type': 'worker', phone_number: username, phone_number_verified: 'true' }
      : { sub, 'custom:user_type': 'employer', email: username, email_verified: 'true' };

  const cognitoEvent = {
    triggerSource: 'PostConfirmation_ConfirmSignUp',
    userName: username,
    userPoolId: poolId,
    region: process.env.AWS_REGION,
    request: { userAttributes: eventUserAttributes },
    response: {},
  };

  const invokeResult = await lambda.send(new InvokeCommand({
    FunctionName: postConfirmationLambdaArn,
    Payload: Buffer.from(JSON.stringify(cognitoEvent)),
  }));

  // Check Lambda didn't error
  if (invokeResult.FunctionError) {
    const errPayload = invokeResult.Payload
      ? Buffer.from(invokeResult.Payload).toString()
      : 'unknown error';
    throw new Error(`post-confirmation Lambda failed: ${errPayload}`);
  }

  // Step 5: Authenticate to get tokens
  return getTokens(poolId, clientId, username, password);
}

/**
 * Authenticates an existing user and returns tokens.
 */
export async function getTokens(
  poolId: string,
  clientId: string,
  username: string,
  password: string,
): Promise<TestUserTokens> {
  const cognito = makeCognito();
  const result = await cognito.send(new AdminInitiateAuthCommand({
    UserPoolId: poolId,
    ClientId: clientId,
    AuthFlow: 'ADMIN_USER_PASSWORD_AUTH',
    AuthParameters: {
      USERNAME: username,
      PASSWORD: password,
    },
  }));

  const auth = result.AuthenticationResult;
  if (!auth?.IdToken || !auth?.AccessToken || !auth?.RefreshToken) {
    throw new Error('AdminInitiateAuth did not return expected tokens');
  }

  return {
    idToken: auth.IdToken,
    accessToken: auth.AccessToken,
    refreshToken: auth.RefreshToken,
  };
}

/**
 * Deletes a Cognito test user. Safe to call even if user doesn't exist.
 */
export async function deleteTestUser(poolId: string, username: string): Promise<void> {
  const cognito = makeCognito();
  try {
    await cognito.send(new AdminDeleteUserCommand({
      UserPoolId: poolId,
      Username: username,
    }));
  } catch (err: unknown) {
    // UserNotFoundException means user was already cleaned up — not an error
    if (err instanceof Error && err.name === 'UserNotFoundException') return;
    throw err;
  }
}
