import { handler } from '../../../lambda/post-confirmation/index';
import { CognitoIdentityProviderClient, AdminAddUserToGroupCommand } from '@aws-sdk/client-cognito-identity-provider';
import { SQSClient, SendMessageCommand } from '@aws-sdk/client-sqs';
import { getDbPool } from '../../../lambda/lib/db';

jest.mock('@aws-sdk/client-cognito-identity-provider');
jest.mock('@aws-sdk/client-sqs');
jest.mock('../../../lambda/lib/db');

const mockGetDbPool = getDbPool as jest.Mock;

describe('Post-confirmation trigger Lambda', () => {
  let mockCognitoSend: jest.Mock;
  let mockSqsSend: jest.Mock;
  let mockQuery: jest.Mock;
  let mockRelease: jest.Mock;

  const originalEnv = process.env;

  beforeEach(() => {
    jest.resetAllMocks();
    process.env = { ...originalEnv, DLQ_URL: 'https://sqs.dlq.url' };

    mockCognitoSend = jest.fn();
    mockSqsSend = jest.fn();
    mockQuery = jest.fn();
    mockRelease = jest.fn();

    (CognitoIdentityProviderClient as jest.Mock).mockImplementation(() => ({
      send: mockCognitoSend,
    }));
    (SQSClient as jest.Mock).mockImplementation(() => ({
      send: mockSqsSend,
    }));

    mockGetDbPool.mockResolvedValue({
      connect: jest.fn().mockResolvedValue({
        query: mockQuery,
        release: mockRelease,
      }),
    });
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  const createEvent = (userType: string | null) => ({
    triggerSource: 'PostConfirmation_ConfirmSignUp',
    userPoolId: 'pool-123',
    userName: 'user-id-123',
    request: {
      userAttributes: {
        'custom:user_type': userType,
        sub: 'sub-183492',
        email: 'test@example.com',
        phone_number: '+1234567890',
        name: 'Test Setup User',
      },
    },
  });

  it('should ignore non PostConfirmation_ConfirmSignUp trigger sources', async () => {
    const event = { triggerSource: 'PreSignUp_AdminCreateUser' };
    const response = await handler(event);

    expect(response).toEqual(event);
    expect(mockCognitoSend).not.toHaveBeenCalled();
    expect(mockQuery).not.toHaveBeenCalled();
  });

  it('should add worker to Workers group and insert into DB', async () => {
    const event = createEvent('worker');
    
    mockCognitoSend.mockResolvedValue({});
    mockQuery.mockResolvedValue({});

    const response = await handler(event);

    expect(response).toEqual(event); // Must return event to Cognito
    expect(AdminAddUserToGroupCommand).toHaveBeenCalledWith({
      UserPoolId: 'pool-123',
      Username: 'user-id-123',
      GroupName: 'Workers',
    });
    
    expect(mockQuery).toHaveBeenCalledWith('BEGIN');
    expect(mockQuery).toHaveBeenCalledWith('SET LOCAL app.current_user_id = $1', ['sub-183492']);
    expect(mockQuery).toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO users'),
      ['sub-183492', 'worker', 'test@example.com', '+1234567890', 'Test Setup User']
    );
    expect(mockQuery).toHaveBeenCalledWith('COMMIT');
    expect(mockRelease).toHaveBeenCalled();
  });

  it('should push to DLQ if user_type is invalid', async () => {
    const event = createEvent('invalid_type');
    
    const response = await handler(event);

    expect(response).toEqual(event); // Still returns event to not block signup
    expect(mockCognitoSend).not.toHaveBeenCalled(); // No group assigned
    expect(mockQuery).not.toHaveBeenCalled(); // DB insert skipped

    expect(SendMessageCommand).toHaveBeenCalledWith(expect.objectContaining({
      QueueUrl: 'https://sqs.dlq.url',
      MessageBody: expect.stringContaining('Invalid user_type: invalid_type'),
    }));
  });

  it('should catch db errors, rollback, push to DLQ, and not block signup', async () => {
    const event = createEvent('employer');
    mockQuery.mockImplementation((queryText) => {
      if (queryText.includes('INSERT INTO users')) {
        return Promise.reject(new Error('DB Duplicate Key'));
      }
      return Promise.resolve();
    });

    const response = await handler(event);

    expect(response).toEqual(event);
    expect(mockQuery).toHaveBeenCalledWith('ROLLBACK');
    expect(mockRelease).toHaveBeenCalled();

    expect(SendMessageCommand).toHaveBeenCalledWith(expect.objectContaining({
      QueueUrl: 'https://sqs.dlq.url',
      MessageBody: expect.stringContaining('DB Duplicate Key'),
    }));
  });
});
