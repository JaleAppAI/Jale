import { InitiateAuthCommand } from '@aws-sdk/client-cognito-identity-provider';
import type { APIGatewayProxyEvent } from 'aws-lambda';

const mockSend = jest.fn();

// Mock the AWS SDK
jest.mock('@aws-sdk/client-cognito-identity-provider', () => ({
  CognitoIdentityProviderClient: jest.fn(() => ({
    send: (...args: any[]) => mockSend(...args)
  })),
  InitiateAuthCommand: jest.fn()
}));

describe('Token Refresh API Lambda', () => {
  const originalEnv = process.env;
  let handler: any;

  beforeEach(() => {
    mockSend.mockReset();
    jest.clearAllMocks();
    process.env = {
      ...originalEnv,
      WORKER_CLIENT_ID: 'worker-client-id',
      EMPLOYER_CLIENT_ID: 'employer-client-id',
      ALLOWED_ORIGIN: 'http://localhost:3000',
    };

    handler = require('../../../lambda/auth/token-refresh').handler;
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  const createEvent = (body: any): APIGatewayProxyEvent => ({
    body: JSON.stringify(body),
  } as APIGatewayProxyEvent);

  it('should return 400 if required parameters are missing', async () => {
    const event = createEvent({ userType: 'worker' }); // Missing refreshToken
    const response = await handler(event);

    expect(response.statusCode).toBe(400);
    expect(JSON.parse(response.body)).toEqual({
      error: 'missing_params',
      message: 'refreshToken and userType are required',
    });
    expect(mockSend).not.toHaveBeenCalled();
  });

  it('should return 200 and auth tokens for valid worker refresh', async () => {
    mockSend.mockResolvedValue({
      AuthenticationResult: {
        AccessToken: 'new-acc-token',
        IdToken: 'new-id-token',
        ExpiresIn: 3600,
      }
    });

    const event = createEvent({
      refreshToken: 'valid-ref-token',
      userType: 'worker',
    });
    
    const response = await handler(event);

    expect(response.statusCode).toBe(200);
    expect(JSON.parse(response.body)).toEqual({
      accessToken: 'new-acc-token',
      idToken: 'new-id-token',
      expiresIn: 3600,
    });

    expect(mockSend).toHaveBeenCalledTimes(1);
    expect(InitiateAuthCommand).toHaveBeenCalledWith({
      AuthFlow: 'REFRESH_TOKEN_AUTH',
      AuthParameters: {
        REFRESH_TOKEN: 'valid-ref-token',
      },
      ClientId: 'worker-client-id',
    });
  });

  it('should return 200 and auth tokens for valid employer refresh', async () => {
    mockSend.mockResolvedValue({
      AuthenticationResult: {
        AccessToken: 'emp-acc-token',
        IdToken: 'emp-id-token',
        ExpiresIn: 3600,
      }
    });

    const event = createEvent({
      refreshToken: 'valid-ref-token-emp',
      userType: 'employer',
    });
    
    const response = await handler(event);

    expect(response.statusCode).toBe(200);
    expect(JSON.parse(response.body)).toEqual({
      accessToken: 'emp-acc-token',
      idToken: 'emp-id-token',
      expiresIn: 3600,
    });

    expect(InitiateAuthCommand).toHaveBeenCalledWith({
      AuthFlow: 'REFRESH_TOKEN_AUTH',
      AuthParameters: {
        REFRESH_TOKEN: 'valid-ref-token-emp',
      },
      ClientId: 'employer-client-id',
    });
  });

  it('should return 401 if Cognito refresh fails', async () => {
    mockSend.mockRejectedValue(new Error('Invalid Refresh Token'));

    const event = createEvent({
      refreshToken: 'invalid-ref-token',
      userType: 'worker',
    });
    
    const response = await handler(event);

    expect(response.statusCode).toBe(401);
    expect(JSON.parse(response.body)).toEqual({
      error: 'refresh_failed',
      message: 'Token refresh failed. Please sign in again.',
    });
  });

  it('should return 401 on unexpected outer error', async () => {
    // Malformed JSON to trigger the catch block
    const event = { body: 'invalid json {' } as APIGatewayProxyEvent;
    
    const response = await handler(event);

    expect(response.statusCode).toBe(401);
  });
});
