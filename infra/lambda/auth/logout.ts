import {
  CognitoIdentityProviderClient,
  GlobalSignOutCommand,
  RevokeTokenCommand,
} from '@aws-sdk/client-cognito-identity-provider';
import type { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { corsHeaders, VALID_USER_TYPES, errorMessage } from '../lib/http';

const cognito = new CognitoIdentityProviderClient({});
const CORS_HEADERS = corsHeaders();

export const handler = async (
  event: APIGatewayProxyEvent,
): Promise<APIGatewayProxyResult> => {
  try {
    const body = JSON.parse(event.body ?? '{}');
    const { accessToken, refreshToken, userType } = body as {
      accessToken: string;
      refreshToken: string;
      userType: string;
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

    if (!VALID_USER_TYPES.includes(userType as any)) {
      return {
        statusCode: 400,
        headers: CORS_HEADERS,
        body: JSON.stringify({
          error: 'invalid_user_type',
          message: 'userType must be "worker" or "employer"',
        }),
      };
    }

    const clientId =
      userType === 'worker'
        ? process.env.WORKER_CLIENT_ID!
        : process.env.EMPLOYER_CLIENT_ID!;

    // Track success of each operation to determine response status
    let globalSignOutOk = false;
    let revokeTokenOk = false;

    // Global sign-out: invalidates all access tokens for the user
    try {
      await cognito.send(
        new GlobalSignOutCommand({ AccessToken: accessToken }),
      );
      globalSignOutOk = true;
    } catch (err: unknown) {
      console.error('GlobalSignOut failed:', errorMessage(err));
    }

    // Revoke refresh token so it cannot be reused
    try {
      await cognito.send(
        new RevokeTokenCommand({
          Token: refreshToken,
          ClientId: clientId,
        }),
      );
      revokeTokenOk = true;
    } catch (err: unknown) {
      console.error('RevokeToken failed:', errorMessage(err));
    }

    // If both operations failed, the user is NOT logged out
    if (!globalSignOutOk && !revokeTokenOk) {
      return {
        statusCode: 500,
        headers: CORS_HEADERS,
        body: JSON.stringify({
          error: 'logout_failed',
          message: 'Both sign-out operations failed. Please try again.',
        }),
      };
    }

    return {
      statusCode: 200,
      headers: CORS_HEADERS,
      body: JSON.stringify({ loggedOut: true }),
    };
  } catch (err: unknown) {
    console.error('Logout failed:', errorMessage(err));
    return {
      statusCode: 500,
      headers: CORS_HEADERS,
      body: JSON.stringify({ error: 'logout_failed', message: 'Logout failed. Please try again.' }),
    };
  }
};
