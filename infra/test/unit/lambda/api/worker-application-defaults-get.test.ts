import type { APIGatewayProxyEvent } from 'aws-lambda';
import { handler } from '../../../../lambda/api/worker-application-defaults-get';
import { getDbPool, setRlsContext } from '../../../../lambda/lib/db';
import { checkCompliance } from '../../../../lambda/legal/check-compliance';

jest.mock('../../../../lambda/lib/db');
jest.mock('../../../../lambda/legal/check-compliance');

const mockGetDbPool = getDbPool as jest.Mock;
const mockSetRlsContext = setRlsContext as jest.Mock;
const mockCheckCompliance = checkCompliance as jest.Mock;
const mockQuery = jest.fn();
const mockRelease = jest.fn();

describe('worker-application-defaults-get', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    jest.resetAllMocks();
    jest.spyOn(console, 'error').mockImplementation(() => {});
    process.env = { ...originalEnv, REQUIRED_TOS_VERSION: 'v1.0' };
    mockGetDbPool.mockResolvedValue({
      connect: jest.fn().mockResolvedValue({ query: mockQuery, release: mockRelease }),
    });
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  const mockEvent = {
    requestContext: { authorizer: { claims: { sub: 'worker-sub-123' } } },
  } as unknown as APIGatewayProxyEvent;

  it('returns 401 if cognitoSub is missing', async () => {
    const event = { requestContext: { authorizer: { claims: {} } } } as unknown as APIGatewayProxyEvent;
    const res = await handler(event);
    expect(res.statusCode).toBe(401);
    expect(JSON.parse(res.body)).toEqual({ error: 'unauthorized' });
  });

  it('returns 409 if the user row does not exist', async () => {
    mockCheckCompliance.mockResolvedValue({ compliant: false, currentVersion: null, userExists: false });
    mockQuery.mockResolvedValue({});

    const res = await handler(mockEvent);

    expect(res.statusCode).toBe(409);
    expect(JSON.parse(res.body).error).toBe('user_not_provisioned');
    expect(mockQuery).toHaveBeenCalledWith('COMMIT');
  });

  it('returns 403 if legal compliance is not met', async () => {
    mockCheckCompliance.mockResolvedValue({ compliant: false, currentVersion: 'v0.9', userExists: true });
    mockQuery.mockResolvedValue({});

    const res = await handler(mockEvent);

    expect(res.statusCode).toBe(403);
    expect(JSON.parse(res.body)).toEqual({
      error: 'legal_required',
      requiredVersion: 'v1.0',
      currentVersion: 'v0.9',
    });
    expect(mockSetRlsContext).toHaveBeenCalledWith(expect.any(Object), 'worker-sub-123');
  });

  it('returns 200 with { answers: {} } when the worker has never saved defaults (no row exists)', async () => {
    mockCheckCompliance.mockResolvedValue({ compliant: true, userExists: true });
    mockQuery.mockImplementation((sql: string) => {
      if (sql.includes('LEFT JOIN worker_application_defaults')) {
        return Promise.resolve({ rows: [{ answers: null, updated_at: null }] });
      }
      return Promise.resolve({});
    });

    const res = await handler(mockEvent);

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ answers: {}, updated_at: null });
    expect(mockQuery).toHaveBeenCalledWith('COMMIT');
  });

  it('returns 200 with the stored answers and updated_at when a row exists', async () => {
    mockCheckCompliance.mockResolvedValue({ compliant: true, userExists: true });
    mockQuery.mockImplementation((sql: string) => {
      if (sql.includes('LEFT JOIN worker_application_defaults')) {
        return Promise.resolve({
          rows: [{ answers: { work_authorization: true }, updated_at: '2026-08-01T00:00:00.000Z' }],
        });
      }
      return Promise.resolve({});
    });

    const res = await handler(mockEvent);

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({
      answers: { work_authorization: true },
      updated_at: '2026-08-01T00:00:00.000Z',
    });
    const profileQuery = mockQuery.mock.calls.find(([q]) => String(q).includes('LEFT JOIN worker_application_defaults'))?.[0];
    expect(profileQuery).toContain('WHERE u.cognito_sub = $1');
  });

  it('returns 500 and rolls back on internal errors', async () => {
    mockCheckCompliance.mockRejectedValue(new Error('DB failure'));

    const res = await handler(mockEvent);

    expect(res.statusCode).toBe(500);
    expect(JSON.parse(res.body)).toEqual({ error: 'internal_error', message: 'Internal server error' });
    expect(mockQuery).toHaveBeenCalledWith('ROLLBACK');
    expect(mockRelease).toHaveBeenCalled();
  });
});
