import {
  CognitoIdentityProviderClient,
  InitiateAuthCommand,
} from '@aws-sdk/client-cognito-identity-provider';
import type { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { corsHeaders, VALID_USER_TYPES, errorMessage } from '../lib/http';

const cognito = new CognitoIdentityProviderClient({});
const CORS_HEADERS = corsHeaders();

/**
 * Cognito errors that mean "this refresh token is not good any more". Only
 * these are a 401; the browser drops its stored session on 401/403 and keeps
 * it on anything else (`AuthContext.isTokenRefusal`).
 */
const REFUSAL_ERROR_NAMES = new Set([
  'NotAuthorizedException',
  'UserNotFoundException',
  'InvalidParameterException',
  'PasswordResetRequiredException',
  'UserNotConfirmedException',
]);

export const handler = async (
  event: APIGatewayProxyEvent,
): Promise<APIGatewayProxyResult> => {
  try {
    const body = JSON.parse(event.body ?? '{}');
    const { refreshToken, userType } = body as {
      refreshToken: string;
      userType: string;
    };

    if (!refreshToken || !userType) {
      return {
        statusCode: 400,
        headers: CORS_HEADERS,
        body: JSON.stringify({ error: 'missing_params', message: 'refreshToken and userType are required' }),
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
  } catch (err: unknown) {
    const name = (err as { name?: string } | null)?.name ?? '';
    if (err instanceof SyntaxError) {
      return {
        statusCode: 400,
        headers: CORS_HEADERS,
        body: JSON.stringify({ error: 'invalid_json', message: 'Request body must be JSON.' }),
      };
    }
    if (REFUSAL_ERROR_NAMES.has(name)) {
      console.warn('Token refresh refused:', name);
      return {
        statusCode: 401,
        headers: CORS_HEADERS,
        body: JSON.stringify({
          error: 'refresh_failed',
          message: 'Token refresh failed. Please sign in again.',
        }),
      };
    }
    // Throttling, Cognito internal errors, network faults: the token was not
    // judged, so the browser must NOT drop it. A 401 here made every Cognito
    // blip look like a refused session and, since sprint 26's cross-tab
    // sign-out, signed the whole browser out (sprint 26 review, A1).
    console.error('Token refresh unavailable:', name || errorMessage(err));
    return {
      statusCode: 503,
      headers: { ...CORS_HEADERS, 'Retry-After': '5' },
      body: JSON.stringify({
        error: 'refresh_unavailable',
        message: 'Token refresh is temporarily unavailable. Please try again.',
      }),
    };
  }
};
