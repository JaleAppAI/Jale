import { handler } from '../../../lambda/legal/accept-tos';
import { getDbPool } from '../../../lambda/lib/db';
import { corsHeaders } from '../../../lambda/lib/http';

jest.mock('../../../lambda/lib/db');

const mockGetDbPool = getDbPool as jest.Mock;
const mockQuery = jest.fn();
const mockRelease = jest.fn();

describe('Accept ToS API Lambda', () => {
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

  const createEvent = (claims: any, body: any): any => ({
    requestContext: {
      authorizer: {
        claims,
      },
      identity: {
        sourceIp: '127.0.0.1'
      }
    },
    headers: {
      'User-Agent': 'Jest Test'
    },
    body: JSON.stringify(body),
  });

  it('should return 401 if missing user sub', async () => {
    const event = createEvent({}, { tosVersion: 'v1.0' });
    const response = await handler(event);

    expect(response.statusCode).toBe(401);
    expect(JSON.parse(response.body).error).toBe('unauthorized');
  });

  it('should return 400 if tosVersion is missing', async () => {
    const event = createEvent({ sub: 'test-user' }, {});
    const response = await handler(event);

    expect(response.statusCode).toBe(400);
    expect(JSON.parse(response.body).error).toBe('bad_request');
  });

  it('should return 400 if tosVersion does not match required version', async () => {
    const event = createEvent({ sub: 'test-user' }, { tosVersion: 'v0.9' });
    const response = await handler(event);

    expect(response.statusCode).toBe(400);
    expect(JSON.parse(response.body).error).toBe('invalid_tos_version');
  });

  it('should successfully update tos and log consent', async () => {
    const event = createEvent({ sub: 'test-user' }, { tosVersion: 'v1.0' });
    mockQuery.mockResolvedValue({});

    const response = await handler(event);

    expect(response.statusCode).toBe(200);
    expect(JSON.parse(response.body)).toEqual({ accepted: true, version: 'v1.0' });

    // Verify transaction blocks
    expect(mockQuery).toHaveBeenCalledWith('BEGIN');
    expect(mockQuery).toHaveBeenCalledWith('SET LOCAL app.current_user_id = $1', ['test-user']);
    expect(mockQuery).toHaveBeenCalledWith(expect.stringContaining('UPDATE users'), ['v1.0', 'test-user']);
    expect(mockQuery).toHaveBeenCalledWith(
      expect.stringContaining("document_type, document_version"), 
      ['v1.0', '127.0.0.1', 'Jest Test', 'test-user']
    );
    expect(mockQuery).toHaveBeenCalledWith('COMMIT');
    expect(mockRelease).toHaveBeenCalled();
  });

  it('should rollback transaction on db error', async () => {
    const event = createEvent({ sub: 'test-user' }, { tosVersion: 'v1.0' });
    // Make an UPDATE query throw an error
    mockQuery.mockImplementation((queryText) => {
      if (queryText.includes('UPDATE')) {
        return Promise.reject(new Error('DB failure'));
      }
      return Promise.resolve();
    });

    const response = await handler(event);

    expect(response.statusCode).toBe(500);
    expect(JSON.parse(response.body).error).toBe('internal_error');
    
    expect(mockQuery).toHaveBeenCalledWith('ROLLBACK');
    expect(mockRelease).toHaveBeenCalled();
  });
});
