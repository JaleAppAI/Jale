import { GlobalSignOutCommand, RevokeTokenCommand } from '@aws-sdk/client-cognito-identity-provider';
import type { APIGatewayProxyEvent } from 'aws-lambda';

const mockSend = jest.fn();

// Mock the AWS SDK
jest.mock('@aws-sdk/client-cognito-identity-provider', () => ({
  CognitoIdentityProviderClient: jest.fn(() => ({
    send: (...args: any[]) => mockSend(...args)
  })),
  GlobalSignOutCommand: jest.fn(),
  RevokeTokenCommand: jest.fn()
}));

describe('Logout API Lambda', () => {
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

    // Load after env vars are set
    handler = require('../../../lambda/auth/logout').handler;
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  const createEvent = (body: any): APIGatewayProxyEvent => ({
    body: JSON.stringify(body),
  } as APIGatewayProxyEvent);

  it('should return 400 if required parameters are missing', async () => {
    const event = createEvent({ accessToken: 'acc' }); // Missing refreshToken and userType
    const response = await handler(event);

    expect(response.statusCode).toBe(400);
    expect(JSON.parse(response.body)).toEqual({
      error: 'missing_params',
      message: 'accessToken, refreshToken, and userType are required',
    });
    expect(mockSend).not.toHaveBeenCalled();
  });

  it('should successfully log out a worker', async () => {
    mockSend.mockResolvedValue({}); // Simulate success for both commands

    const event = createEvent({
      accessToken: 'acc-token',
      refreshToken: 'ref-token',
      userType: 'worker',
    });
    
    const response = await handler(event);

    expect(response.statusCode).toBe(200);
    expect(JSON.parse(response.body)).toEqual({ loggedOut: true });

    expect(mockSend).toHaveBeenCalledTimes(2);
    expect(GlobalSignOutCommand).toHaveBeenCalledWith({ AccessToken: 'acc-token' });
    expect(RevokeTokenCommand).toHaveBeenCalledWith({ Token: 'ref-token', ClientId: 'worker-client-id' });
  });

  it('should successfully log out an employer', async () => {
    mockSend.mockResolvedValue({});

    const event = createEvent({
      accessToken: 'acc-token-emp',
      refreshToken: 'ref-token-emp',
      userType: 'employer',
    });
    
    const response = await handler(event);

    expect(response.statusCode).toBe(200);
    expect(JSON.parse(response.body)).toEqual({ loggedOut: true });

    expect(mockSend).toHaveBeenCalledTimes(2);
    expect(GlobalSignOutCommand).toHaveBeenCalledWith({ AccessToken: 'acc-token-emp' });
    expect(RevokeTokenCommand).toHaveBeenCalledWith({ Token: 'ref-token-emp', ClientId: 'employer-client-id' });
  });

  it('should return 200 even if Cognito calls fail (graceful failure)', async () => {
    // Force the first call to fail (GlobalSignOut) and the second to fail (RevokeToken)
    mockSend.mockRejectedValue(new Error('Cognito error'));

    const event = createEvent({
      accessToken: 'acc-token',
      refreshToken: 'ref-token',
      userType: 'worker',
    });
    
    const response = await handler(event);

    // It still returns 200 because it catches them individually
    expect(response.statusCode).toBe(200);
    expect(JSON.parse(response.body)).toEqual({ loggedOut: true });
    expect(mockSend).toHaveBeenCalledTimes(2);
  });

  it('should return 500 on unexpected outer error', async () => {
    // Malformed JSON body to trigger the outer catch
    const event = { body: 'invalid json {' } as APIGatewayProxyEvent;
    
    const response = await handler(event);

    expect(response.statusCode).toBe(500);
    expect(JSON.parse(response.body)).toEqual({
      error: 'logout_failed',
      message: 'Logout failed. Please try again.',
    });
  });
});
