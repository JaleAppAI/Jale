import type { APIGatewayProxyEvent } from 'aws-lambda';
import { createHash } from 'crypto';
import { handler } from '../../../../lambda/api/worker-doc-submit';
import { getDbPool } from '../../../../lambda/lib/db';

import { setAuditContext } from '../../../../lambda/lib/audit/context';
import { expectContextBeforeWrite, idlessCallerFor, withRequestId } from './audit-expectations';

jest.mock('../../../../lambda/lib/db');
jest.mock('../../../../lambda/lib/audit/context');

const mockGetDbPool = getDbPool as jest.Mock;
const mockQuery = jest.fn();
const mockRelease = jest.fn();

function submitWith(outcome: string) {
  mockQuery.mockImplementation((sql: string) => {
    if (/jale_cap\.upload_token_submit/.test(sql)) return Promise.resolve({ rows: [{ outcome }] });
    return Promise.resolve({ rows: [] });
  });
}

describe('worker-doc-submit Lambda', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    process.env.ALLOWED_ORIGIN = 'https://jaleapp.ai';
    mockGetDbPool.mockResolvedValue({
      connect: jest.fn().mockResolvedValue({ query: mockQuery, release: mockRelease }),
    });
  });

  const makeEvent = (body: object) =>
    ({ body: JSON.stringify(body) }) as unknown as APIGatewayProxyEvent;

  it('returns 400 if token is missing', async () => {
    const res = await handler(makeEvent({}));
    expect(res.statusCode).toBe(400);
    expect(mockQuery).not.toHaveBeenCalled();
  });

  it('submits through jale_cap.upload_token_submit with the token hash, in one statement inside its own transaction', async () => {
    submitWith('ok');
    const res = await handler(makeEvent({ token: 'valid-token' }));
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ success: true });
    // The transaction carries the change-record context (token_holder) to the
    // function's writes; the submit itself is still one statement.
    expect(mockQuery.mock.calls.map(([sql]) => String(sql))).toEqual([
      'BEGIN',
      'SELECT outcome FROM jale_cap.upload_token_submit($1)',
      'COMMIT',
    ]);
    const [, params] = mockQuery.mock.calls[1];
    expect(params).toEqual([createHash('sha256').update('valid-token').digest('hex')]);
    expect(mockRelease).toHaveBeenCalled();
  });

  it('is idempotent: a repeat submit the function reports as ok is still a 200', async () => {
    submitWith('ok');
    expect((await handler(makeEvent({ token: 'valid-token' }))).statusCode).toBe(200);
    expect((await handler(makeEvent({ token: 'valid-token' }))).statusCode).toBe(200);
  });

  it('returns 409 confirm_required when the token is live but has no confirmed slots', async () => {
    submitWith('confirm_required');
    const res = await handler(makeEvent({ token: 'valid-token' }));
    expect(res.statusCode).toBe(409);
    expect(JSON.parse(res.body).error).toBe('confirm_required');
  });

  it('returns 401 for an unknown or expired token', async () => {
    submitWith('invalid_token');
    const res = await handler(makeEvent({ token: 'missing-token' }));
    expect(res.statusCode).toBe(401);
    expect(JSON.parse(res.body).error).toBe('invalid_token');
  });

  it('returns 500 on an outcome it does not know', async () => {
    jest.spyOn(console, 'error').mockImplementation(() => {});
    submitWith('something_else');
    const res = await handler(makeEvent({ token: 'valid-token' }));
    expect(res.statusCode).toBe(500);
    expect(JSON.parse(res.body).error).toBe('internal_error');
  });

  describe('change context', () => {
    it('states the token holder, with no id, before the function writes', async () => {
      submitWith('ok');
      const res = await handler(withRequestId(makeEvent({ token: 'valid-token' })));
      expect(res.statusCode).toBe(200);
      expect(setAuditContext).toHaveBeenCalledTimes(1);
      expect(setAuditContext).toHaveBeenCalledWith(
        expect.objectContaining({ query: mockQuery }), idlessCallerFor('token_holder'), 'token_holder.document_submit');
      expectContextBeforeWrite(mockQuery, setAuditContext as jest.Mock, /jale_cap\.upload_token_submit/);
    });

    it('rolls back, never commits, when the function fails', async () => {
      mockQuery.mockImplementation((sql: string) => (/upload_token_submit/.test(sql)
        ? Promise.reject(new Error('fixture failure'))
        : Promise.resolve({ rows: [] })));
      const res = await handler(makeEvent({ token: 'valid-token' }));
      expect(res.statusCode).toBe(500);
      const calls = mockQuery.mock.calls.map(([sql]) => String(sql));
      expect(calls).toContain('ROLLBACK');
      expect(calls).not.toContain('COMMIT');
    });
  });
});
