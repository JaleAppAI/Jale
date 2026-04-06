import { handler } from '../../../../lambda/legal/accept-tos';
import { getDbPool, setRlsContext } from '../../../../lambda/lib/db';
import { corsHeaders } from '../../../../lambda/lib/http';

jest.mock('../../../../lambda/lib/db');

const mockGetDbPool = getDbPool as jest.Mock;
const mockSetRlsContext = setRlsContext as jest.Mock;
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

  it('should successfully update tos and log consent (first acceptance)', async () => {
    const event = createEvent({ sub: 'test-user' }, { tosVersion: 'v1.0' });
    mockQuery.mockImplementation((queryText: string) => {
      if (queryText.includes('UPDATE users')) {
        return Promise.resolve({ rowCount: 1 });
      }
      return Promise.resolve({});
    });

    const response = await handler(event);

    expect(response.statusCode).toBe(200);
    expect(JSON.parse(response.body)).toEqual({ accepted: true, version: 'v1.0' });

    // Verify transaction blocks
    expect(mockQuery).toHaveBeenCalledWith('BEGIN');
    expect(mockSetRlsContext).toHaveBeenCalledWith(expect.any(Object), 'test-user');
    expect(mockQuery).toHaveBeenCalledWith(expect.stringContaining('UPDATE users'), ['v1.0', 'test-user']);
    // Both consent log inserts must happen — one for 'tos' and one for 'privacy'
    expect(mockQuery).toHaveBeenCalledWith(
      expect.stringContaining("SELECT id, 'tos'"),
      ['v1.0', '127.0.0.1', 'Jest Test', 'test-user']
    );
    expect(mockQuery).toHaveBeenCalledWith(
      expect.stringContaining("SELECT id, 'privacy'"),
      ['v1.0', '127.0.0.1', 'Jest Test', 'test-user']
    );
    expect(mockQuery).toHaveBeenCalledTimes(5); // BEGIN + UPDATE + INSERT tos + INSERT privacy + COMMIT
    expect(mockQuery).toHaveBeenCalledWith('COMMIT');
    expect(mockRelease).toHaveBeenCalled();
  });

  it('should skip consent log inserts when same version already accepted (idempotent)', async () => {
    const event = createEvent({ sub: 'test-user' }, { tosVersion: 'v1.0' });
    mockQuery.mockImplementation((queryText: string) => {
      if (queryText.includes('UPDATE users')) {
        return Promise.resolve({ rowCount: 0 }); // no rows changed — already accepted
      }
      if (queryText.includes('SELECT 1 FROM users')) {
        return Promise.resolve({ rows: [{ '?column?': 1 }] }); // user exists
      }
      return Promise.resolve({});
    });

    const response = await handler(event);

    expect(response.statusCode).toBe(200);
    expect(JSON.parse(response.body)).toEqual({ accepted: true, version: 'v1.0' });

    // Should have BEGIN + UPDATE + existence check SELECT + COMMIT (no INSERT calls)
    expect(mockQuery).toHaveBeenCalledWith('BEGIN');
    expect(mockQuery).toHaveBeenCalledWith(expect.stringContaining('UPDATE users'), ['v1.0', 'test-user']);
    expect(mockQuery).toHaveBeenCalledWith(expect.stringContaining('SELECT 1 FROM users'), ['test-user']);
    expect(mockQuery).not.toHaveBeenCalledWith(
      expect.stringContaining("SELECT id, 'tos'"),
      expect.any(Array)
    );
    expect(mockQuery).toHaveBeenCalledTimes(4); // BEGIN + UPDATE + SELECT existence + COMMIT
    expect(mockQuery).toHaveBeenCalledWith('COMMIT');
    expect(mockRelease).toHaveBeenCalled();
  });

  it('should return 409 when user row does not exist (post-confirmation sync failed)', async () => {
    const event = createEvent({ sub: 'ghost-user' }, { tosVersion: 'v1.0' });
    mockQuery.mockImplementation((queryText: string) => {
      if (queryText.includes('UPDATE users')) {
        return Promise.resolve({ rowCount: 0 }); // no rows changed — user doesn't exist
      }
      if (queryText.includes('SELECT 1 FROM users')) {
        return Promise.resolve({ rows: [] }); // user not found
      }
      return Promise.resolve({});
    });

    const response = await handler(event);

    expect(response.statusCode).toBe(409);
    expect(JSON.parse(response.body)).toEqual({
      error: 'user_not_provisioned',
      message: 'Account setup incomplete. Please try signing out and back in.',
    });
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
