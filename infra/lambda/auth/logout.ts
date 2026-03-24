import {
  CognitoIdentityProviderClient,
  GlobalSignOutCommand,
  RevokeTokenCommand,
} from '@aws-sdk/client-cognito-identity-provider';
import type { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';

const cognito = new CognitoIdentityProviderClient({});

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': 'http://localhost:3000',
  'Access-Control-Allow-Headers': 'Content-Type,Authorization',
  'Access-Control-Allow-Methods': 'POST,OPTIONS',
};

export const handler = async (
  event: APIGatewayProxyEvent,
): Promise<APIGatewayProxyResult> => {
  const body = JSON.parse(event.body ?? '{}');
  const { accessToken, refreshToken, userType } = body as {
    accessToken: string;
    refreshToken: string;
    userType: 'worker' | 'employer';
  };

  const clientId =
    userType === 'worker'
      ? process.env.WORKER_CLIENT_ID!
      : process.env.EMPLOYER_CLIENT_ID!;

  // Global sign-out: invalidates all access tokens for the user
  try {
    await cognito.send(
      new GlobalSignOutCommand({ AccessToken: accessToken }),
    );
  } catch (err: any) {
    console.error('GlobalSignOut failed:', err.message);
  }

  // Revoke refresh token so it cannot be reused
  try {
    await cognito.send(
      new RevokeTokenCommand({
        Token: refreshToken,
        ClientId: clientId,
      }),
    );
  } catch (err: any) {
    console.error('RevokeToken failed:', err.message);
  }

  return {
    statusCode: 200,
    headers: CORS_HEADERS,
    body: JSON.stringify({ loggedOut: true }),
  };
};
