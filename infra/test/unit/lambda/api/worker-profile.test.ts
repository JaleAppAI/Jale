import type { APIGatewayProxyEvent } from 'aws-lambda';
import { handler } from '../../../../lambda/api/worker-profile';
import { getDbPool } from '../../../../lambda/lib/db';
import { checkCompliance } from '../../../../lambda/legal/check-compliance';
import { corsHeaders } from '../../../../lambda/lib/http';

jest.mock('../../../../lambda/lib/db');
jest.mock('../../../../lambda/legal/check-compliance');

const mockGetDbPool = getDbPool as jest.Mock;
const mockCheckCompliance = checkCompliance as jest.Mock;
const mockQuery = jest.fn();
const mockRelease = jest.fn();

describe('Worker Profile API Lambda', () => {
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
          sub: 'worker-sub-123',
        },
      },
    },
  } as unknown as APIGatewayProxyEvent;

  it('should return 403 if legal compliance is not met', async () => {
    mockCheckCompliance.mockResolvedValue({
      compliant: false,
      currentVersion: 'v0.9'
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
    expect(mockQuery).toHaveBeenCalledWith('SET LOCAL app.current_user_id = $1', ['worker-sub-123']);
    expect(mockQuery).toHaveBeenCalledWith('COMMIT'); // Commit after blocking
    expect(mockRelease).toHaveBeenCalled();

    // Verify RLS setup order: BEGIN → SET LOCAL → checkCompliance → COMMIT
    // If SET LOCAL were moved after checkCompliance, the query would run without RLS context
    expect(mockQuery.mock.calls[0]).toEqual(['BEGIN']);
    expect(mockQuery.mock.calls[1]).toEqual(['SET LOCAL app.current_user_id = $1', ['worker-sub-123']]);
    expect(mockQuery.mock.calls[2]).toEqual(['COMMIT']);
  });

  it('should return 404 if user profile is not found', async () => {
    mockCheckCompliance.mockResolvedValue({ compliant: true });
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
    mockCheckCompliance.mockResolvedValue({ compliant: true });
    const mockUser = {
      id: 'usr-456',
      user_type: 'worker',
      email: 'worker@example.com',
      phone: '0987654321',
      full_name: 'Test Worker',
      tenant_id: null,
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
