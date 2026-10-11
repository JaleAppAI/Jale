import type { APIGatewayProxyEvent } from 'aws-lambda';
import { handler } from '../../../../lambda/api/worker-application-defaults-get';
import { getDbPool, setRlsContext } from '../../../../lambda/lib/db';
import { checkCompliance } from '../../../../lambda/legal/check-compliance';

import { recordAccess, recordAttempt } from '../../../../lambda/lib/audit/record';
import { callerFor, expectAttemptAfter, expectRecordedInsideTransaction, withRequestId } from './audit-expectations';

jest.mock('../../../../lambda/lib/db');
jest.mock('../../../../lambda/legal/check-compliance');
jest.mock('../../../../lambda/lib/audit/record', () => ({
  ...jest.requireActual('../../../../lambda/lib/audit/record'),
  recordAccess: jest.fn(),
  recordAttempt: jest.fn(),
}));
jest.mock('../../../../lambda/lib/audit/context');

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

  /** Answers the worker-id lookup the handler makes before its read; every other statement goes to `rest`. */
  const withWorkerId = (rest: (sql: string) => Promise<unknown>) => (sql: string) => (
    /^SELECT id FROM users WHERE cognito_sub = \$1$/.test(String(sql))
      ? Promise.resolve({ rows: [{ id: 'worker-1' }] })
      : rest(sql));

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

  it('returns 409 and reads nothing when the worker id cannot be found', async () => {
    mockCheckCompliance.mockResolvedValue({ compliant: true, userExists: true });
    mockQuery.mockImplementation((sql: string) => Promise.resolve(
      /^SELECT id FROM users WHERE cognito_sub = \$1$/.test(String(sql)) ? { rows: [] } : {},
    ));

    const res = await handler(mockEvent);

    expect(res.statusCode).toBe(409);
    expect(JSON.parse(res.body).error).toBe('user_not_provisioned');
    expect(mockQuery).toHaveBeenCalledWith('COMMIT');
    expect(mockQuery.mock.calls.some(([q]) => String(q).includes('LEFT JOIN worker_application_defaults'))).toBe(false);
    expect(recordAccess).not.toHaveBeenCalled();
    expect(recordAttempt).not.toHaveBeenCalled();
  });

  it('returns 200 with { answers: {} } when the worker has never saved defaults (no row exists)', async () => {
    mockCheckCompliance.mockResolvedValue({ compliant: true, userExists: true });
    mockQuery.mockImplementation(withWorkerId((sql: string) => {
      if (sql.includes('LEFT JOIN worker_application_defaults')) {
        return Promise.resolve({ rows: [{ worker_id: 'worker-1', answers: null, updated_at: null }] });
      }
      return Promise.resolve({});
    }));

    const res = await handler(mockEvent);

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ answers: {}, updated_at: null });
    expect(mockQuery).toHaveBeenCalledWith('COMMIT');
  });

  it('returns 200 with the stored answers and updated_at when a row exists', async () => {
    mockCheckCompliance.mockResolvedValue({ compliant: true, userExists: true });
    mockQuery.mockImplementation(withWorkerId((sql: string) => {
      if (sql.includes('LEFT JOIN worker_application_defaults')) {
        return Promise.resolve({
          rows: [{ worker_id: 'worker-1', answers: { work_authorization: true }, updated_at: '2026-08-01T00:00:00.000Z' }],
        });
      }
      return Promise.resolve({});
    }));

    const res = await handler(mockEvent);

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({
      answers: { work_authorization: true },
      updated_at: '2026-08-01T00:00:00.000Z',
    });
    const profileQuery = mockQuery.mock.calls.find(([q]) => String(q).includes('LEFT JOIN worker_application_defaults'))?.[0];
    expect(profileQuery).toContain('WHERE u.cognito_sub = $1');
  });

  // L3 (decision D2): the web page prefills its editable draft from THIS
  // body, so a per_application key reaching it would put a start date and a
  // pay expectation quoted at ANOTHER employer into this application's form
  // -- the web-door half of the 2026-09-04 incident. The row itself may
  // still hold legacy per_application keys; the door is what refuses to
  // hand them out.
  it('returns only the stable keys, dropping per_application ones a legacy row still holds', async () => {
    mockCheckCompliance.mockResolvedValue({ compliant: true, userExists: true });
    mockQuery.mockImplementation(withWorkerId((sql: string) => {
      if (sql.includes('LEFT JOIN worker_application_defaults')) {
        return Promise.resolve({
          rows: [{
            worker_id: 'worker-1',
            answers: {
              work_authorization: true,
              home_address: { street: '1 Main St' },
              date_available: '2026-09-10',
              desired_pay: { amount: 25, interval: 'hourly' },
              worked_here_before: true,
              emergency_contact: { name: 'Maria Lopez', phone: '5551234567' },
            },
            updated_at: '2026-08-01T00:00:00.000Z',
          }],
        });
      }
      return Promise.resolve({});
    }));

    const res = await handler(mockEvent);

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({
      answers: { work_authorization: true, home_address: { street: '1 Main St' } },
      updated_at: '2026-08-01T00:00:00.000Z',
    });
  });

  it('returns 500 and rolls back on internal errors', async () => {
    mockCheckCompliance.mockRejectedValue(new Error('DB failure'));

    const res = await handler(mockEvent);

    expect(res.statusCode).toBe(500);
    expect(JSON.parse(res.body)).toEqual({ error: 'internal_error', message: 'Internal server error' });
    expect(mockQuery).toHaveBeenCalledWith('ROLLBACK');
    expect(mockRelease).toHaveBeenCalled();
  });

  describe('access record', () => {
    const mockRecordAccess = recordAccess as jest.Mock;
    const mockRecordAttempt = recordAttempt as jest.Mock;
    const worker = callerFor('worker', 'worker-1');
    const client = expect.objectContaining({ query: mockQuery });

    beforeEach(() => {
      mockCheckCompliance.mockResolvedValue({ compliant: true, userExists: true });
      mockRecordAccess.mockResolvedValue(undefined);
      mockRecordAttempt.mockResolvedValue(undefined);
    });

    it('records the worker reading their saved answers before COMMIT', async () => {
      mockQuery.mockImplementation(withWorkerId((sql: string) => (String(sql).includes('LEFT JOIN worker_application_defaults')
        ? Promise.resolve({ rows: [{ worker_id: 'worker-1', answers: { work_authorization: true }, updated_at: '2026-08-01T00:00:00.000Z' }] })
        : Promise.resolve({}))));
      const res = await handler(withRequestId(mockEvent));
      expect(res.statusCode).toBe(200);
      const selected = mockQuery.mock.calls.find(([q]) => String(q).includes('LEFT JOIN worker_application_defaults'))?.[0];
      expect(selected).toMatch(/SELECT\s+u\.id AS worker_id/);
      expect(mockRecordAccess).toHaveBeenCalledWith(client, worker, {
        surface: 'worker.application_defaults',
        subjectUserIds: ['worker-1'],
        resultCount: 1,
        fieldNames: ['answers', 'updated_at'],
        purpose: { kind: 'self' },
      });
      expectRecordedInsideTransaction(mockQuery, mockRecordAccess, /LEFT JOIN worker_application_defaults/);
    });

    it('records a read of nothing saved with a zero count', async () => {
      mockQuery.mockImplementation(withWorkerId((sql: string) => (String(sql).includes('LEFT JOIN worker_application_defaults')
        ? Promise.resolve({ rows: [{ worker_id: 'worker-1', answers: null, updated_at: null }] })
        : Promise.resolve({}))));
      await handler(withRequestId(mockEvent));
      expect(mockRecordAccess.mock.calls[0][2]).toMatchObject({ resultCount: 0 });
    });

    // The worker is known before the read, so a read that fails or finds
    // nothing still leaves its event, as a 500 on any covered surface does.
    const ID_QUERY = /^SELECT id FROM users WHERE cognito_sub = \$1$/;

    it('records a failed attempt when the read itself fails', async () => {
      mockQuery.mockImplementation((sql: string) => {
        if (ID_QUERY.test(String(sql))) return Promise.resolve({ rows: [{ id: 'worker-1' }] });
        if (String(sql).includes('LEFT JOIN worker_application_defaults')) return Promise.reject(new Error('read failed'));
        return Promise.resolve({});
      });
      const res = await handler(withRequestId(mockEvent));
      expect(res.statusCode).toBe(500);
      expect(JSON.parse(res.body)).toEqual({ error: 'internal_error', message: 'Internal server error' });
      expect(mockRecordAccess).not.toHaveBeenCalled();
      expectAttemptAfter(mockQuery, mockRecordAttempt, 'ROLLBACK');
      expect(mockRecordAttempt).toHaveBeenCalledWith(client, worker, {
        surface: 'worker.application_defaults', outcome: 'failed', subjectUserIds: ['worker-1'], purpose: { kind: 'self' },
      });
    });

    it('records an empty self-read when the read returns no row', async () => {
      mockQuery.mockImplementation((sql: string) => {
        if (ID_QUERY.test(String(sql))) return Promise.resolve({ rows: [{ id: 'worker-1' }] });
        if (String(sql).includes('LEFT JOIN worker_application_defaults')) return Promise.resolve({ rows: [] });
        return Promise.resolve({});
      });
      const res = await handler(withRequestId(mockEvent));
      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.body)).toEqual({ answers: {}, updated_at: null });
      expect(mockRecordAccess).toHaveBeenCalledTimes(1);
      expect(mockRecordAccess.mock.calls[0][1]).toEqual(worker);
      expect(mockRecordAccess.mock.calls[0][2]).toMatchObject({
        surface: 'worker.application_defaults', subjectUserIds: ['worker-1'], resultCount: 0, purpose: { kind: 'self' },
      });
      expectRecordedInsideTransaction(mockQuery, mockRecordAccess, /LEFT JOIN worker_application_defaults/);
    });

    it('answers 500 with no answers when the record cannot be written', async () => {
      mockQuery.mockImplementation(withWorkerId((sql: string) => (String(sql).includes('LEFT JOIN worker_application_defaults')
        ? Promise.resolve({ rows: [{ worker_id: 'worker-1', answers: { work_authorization: true }, updated_at: null }] })
        : Promise.resolve({}))));
      mockRecordAccess.mockRejectedValue(new Error('audit'));
      const res = await handler(withRequestId(mockEvent));
      expect(res.statusCode).toBe(500);
      expect(JSON.parse(res.body)).toEqual({ error: 'internal_error', message: 'Internal server error' });
      expect(mockQuery).not.toHaveBeenCalledWith('COMMIT');
      expectAttemptAfter(mockQuery, mockRecordAttempt, 'ROLLBACK');
      expect(mockRecordAttempt).toHaveBeenCalledWith(client, worker, {
        surface: 'worker.application_defaults', outcome: 'failed', subjectUserIds: ['worker-1'], purpose: { kind: 'self' },
      });
    });
  });
});
