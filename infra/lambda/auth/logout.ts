import {
  CognitoIdentityProviderClient,
  GlobalSignOutCommand,
  RevokeTokenCommand,
} from '@aws-sdk/client-cognito-identity-provider';
import type { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';

const cognito = new CognitoIdentityProviderClient({});

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': process.env.ALLOWED_ORIGIN ?? 'http://localhost:3000',
  'Access-Control-Allow-Headers': 'Content-Type,Authorization',
  'Access-Control-Allow-Methods': 'POST,OPTIONS',
};

export const handler = async (
  event: APIGatewayProxyEvent,
): Promise<APIGatewayProxyResult> => {
  try {
    const body = JSON.parse(event.body ?? '{}');
    const { accessToken, refreshToken, userType } = body as {
      accessToken: string;
      refreshToken: string;
      userType: 'worker' | 'employer';
    };

    if (!accessToken || !refreshToken || !userType) {
      return {
        statusCode: 400,
        headers: CORS_HEADERS,
        body: JSON.stringify({
          error: 'missing_params',
          message: 'accessToken, refreshToken, and userType are required',
        }),
      };
    }

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
  } catch (err: any) {
    console.error('Logout failed:', err);
    return {
      statusCode: 500,
      headers: CORS_HEADERS,
      body: JSON.stringify({ error: 'logout_failed', message: 'Logout failed. Please try again.' }),
    };
  }
};
