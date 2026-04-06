import type { APIGatewayProxyEvent } from 'aws-lambda';
import { handler } from '../../../../lambda/api/employer-profile';
import { getDbPool, setRlsContext } from '../../../../lambda/lib/db';
import { checkCompliance } from '../../../../lambda/legal/check-compliance';
import { corsHeaders } from '../../../../lambda/lib/http';

jest.mock('../../../../lambda/lib/db');
jest.mock('../../../../lambda/legal/check-compliance');

const mockGetDbPool = getDbPool as jest.Mock;
const mockSetRlsContext = setRlsContext as jest.Mock;
const mockCheckCompliance = checkCompliance as jest.Mock;
const mockQuery = jest.fn();
const mockRelease = jest.fn();

describe('Employer Profile API Lambda', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    jest.resetAllMocks();
    process.env = { ...originalEnv, REQUIRED_TOS_VERSION: 'v1.0' };
    
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

  const mockEvent = {
    requestContext: {
      authorizer: {
        claims: {
          sub: 'test-user-sub',
        },
      },
    },
  } as unknown as APIGatewayProxyEvent;

  it('should return 409 if user row does not exist (post-confirmation sync failed)', async () => {
    mockCheckCompliance.mockResolvedValue({
      compliant: false,
      currentVersion: null,
      userExists: false,
    });
    mockQuery.mockResolvedValue({});

    const response = await handler(mockEvent);

    expect(response.statusCode).toBe(409);
    expect(JSON.parse(response.body)).toEqual({
      error: 'user_not_provisioned',
      message: 'Account setup incomplete. Please try signing out and back in.',
    });
    expect(mockQuery).toHaveBeenCalledWith('COMMIT');
    expect(mockRelease).toHaveBeenCalled();
  });

  it('should return 403 if legal compliance is not met', async () => {
    mockCheckCompliance.mockResolvedValue({
      compliant: false,
      currentVersion: 'v0.9',
      userExists: true,
    });
    mockQuery.mockResolvedValue({});

    const response = await handler(mockEvent);

    expect(response.statusCode).toBe(403);
    expect(response.headers).toEqual(corsHeaders());
    expect(JSON.parse(response.body)).toEqual({
      error: 'legal_required',
      requiredVersion: 'v1.0',
      currentVersion: 'v0.9',
    });
    
    expect(mockQuery).toHaveBeenCalledWith('BEGIN');
    expect(mockSetRlsContext).toHaveBeenCalledWith(expect.any(Object), 'test-user-sub');
    expect(mockQuery).toHaveBeenCalledWith('COMMIT'); // Commit after blocking
    expect(mockRelease).toHaveBeenCalled();

    // Verify RLS setup order: BEGIN → setRlsContext → checkCompliance → COMMIT
    expect(mockQuery.mock.calls[0]).toEqual(['BEGIN']);
    expect(mockQuery.mock.calls[1]).toEqual(['COMMIT']);
  });

  it('should return 404 if user profile is not found', async () => {
    mockCheckCompliance.mockResolvedValue({ compliant: true, userExists: true });
    // Simulate empty result for user query
    mockQuery.mockImplementation((queryText) => {
      if (queryText.includes('SELECT id, user_type')) {
        return Promise.resolve({ rows: [] });
      }
      return Promise.resolve({});
    });

    const response = await handler(mockEvent);

    expect(response.statusCode).toBe(404);
    expect(JSON.parse(response.body)).toEqual({
      error: 'profile_not_found',
      message: 'Please complete profile setup',
    });
    expect(mockRelease).toHaveBeenCalled();
  });

  it('should return 200 and user profile if successful', async () => {
    mockCheckCompliance.mockResolvedValue({ compliant: true, userExists: true });
    const mockUser = {
      id: 'usr-123',
      user_type: 'employer',
      email: 'test@example.com',
      phone: '1234567890',
      full_name: 'Test Employer',
      tenant_id: 'tnt-123',
      created_at: new Date().toISOString()
    };
    
    mockQuery.mockImplementation((queryText) => {
      if (queryText.includes('SELECT id, user_type')) {
        return Promise.resolve({ rows: [mockUser] });
      }
      return Promise.resolve({});
    });

    const response = await handler(mockEvent);

    expect(response.statusCode).toBe(200);
    expect(JSON.parse(response.body)).toEqual(mockUser);
    expect(mockQuery).toHaveBeenCalledWith('COMMIT');
    expect(mockRelease).toHaveBeenCalled();
  });

  it('should return 500 on internal errors and rollback', async () => {
    mockCheckCompliance.mockRejectedValue(new Error('DB failure'));

    const response = await handler(mockEvent);

    expect(response.statusCode).toBe(500);
    expect(JSON.parse(response.body)).toEqual({
      error: 'internal_error',
      message: 'Internal server error',
    });
    expect(mockQuery).toHaveBeenCalledWith('ROLLBACK');
    expect(mockRelease).toHaveBeenCalled();
  });

  test('should return 401 if cognitoSub is missing from authorizer claims', async () => {
    const event = {
      requestContext: { authorizer: { claims: {} } },
    } as unknown as APIGatewayProxyEvent;

    const result = await handler(event);

    expect(result.statusCode).toBe(401);
    expect(JSON.parse(result.body)).toEqual({ error: 'unauthorized' });
  });
});
