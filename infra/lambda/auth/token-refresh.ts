import {
  CognitoIdentityProviderClient,
  InitiateAuthCommand,
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
    const { refreshToken, userType } = body as {
      refreshToken: string;
      userType: 'worker' | 'employer';
    };

    if (!refreshToken || !userType) {
      return {
        statusCode: 400,
        headers: CORS_HEADERS,
        body: JSON.stringify({ error: 'missing_params', message: 'refreshToken and userType are required' }),
      };
    }

    const clientId =
      userType === 'worker'
        ? process.env.WORKER_CLIENT_ID!
        : process.env.EMPLOYER_CLIENT_ID!;

    const command = new InitiateAuthCommand({
      AuthFlow: 'REFRESH_TOKEN_AUTH',
      AuthParameters: {
        REFRESH_TOKEN: refreshToken,
      },
      ClientId: clientId,
    });

    const result = await cognito.send(command);
    const auth = result.AuthenticationResult;

    return {
      statusCode: 200,
      headers: CORS_HEADERS,
      body: JSON.stringify({
        accessToken: auth?.AccessToken,
        idToken: auth?.IdToken,
        expiresIn: auth?.ExpiresIn,
      }),
    };
  } catch (err: any) {
    console.error('Token refresh failed:', err);
    return {
      statusCode: 401,
      headers: CORS_HEADERS,
      body: JSON.stringify({
        error: 'refresh_failed',
        message: 'Token refresh failed. Please sign in again.',
      }),
    };
  }
};
