/**
 * worker-application-hired-actions.test.ts -- F19 (sprint 28, K4.3/K4.4):
 * the hired worker's web message and "Remind my employer", forwarded by the
 * details door. The definer and the column grant behind them are proven on a
 * real database in the 125 DB suite; this file pins the HTTP mapping.
 */
import type { APIGatewayProxyEvent } from 'aws-lambda';
import { messageHandler, remindHandler } from '../../../../lambda/api/worker-application-hired-actions';
import { getDbPool, setInternalUserRlsContext } from '../../../../lambda/lib/db';

jest.mock('../../../../lambda/lib/db');

const mockGetDbPool = getDbPool as jest.Mock;
const mockSetInternal = setInternalUserRlsContext as jest.Mock;
const mockQuery = jest.fn();
const mockRelease = jest.fn();

const APP_ID = '33333333-3333-4333-8333-333333333333';
const WORKER_ID = '22222222-2222-4222-8222-222222222222';

function post(action: string, body: unknown, overrides: Partial<APIGatewayProxyEvent> = {}): APIGatewayProxyEvent {
  return {
    httpMethod: 'POST',
    requestContext: { authorizer: { claims: { sub: 'w-sub' } } },
    pathParameters: { applicationId: APP_ID, action },
    body: body === undefined ? null : JSON.stringify(body),
    ...overrides,
  } as unknown as APIGatewayProxyEvent;
}

let messageRow: Record<string, unknown> = {};
let stampedRows = 1;
let remindState: Record<string, unknown> | null = null;

function defaultQuery(sql: string) {
  if (/resolve_worker_internal_id/.test(sql)) return { rows: [{ id: WORKER_ID }] };
  if (/tos_version/.test(sql)) return { rows: [{ tos_version: 'v1.0' }] };
  if (/worker_post_application_message/.test(sql)) return { rows: [messageRow] };
  if (/^\s*UPDATE job_applications/.test(sql)) return { rows: [], rowCount: stampedRows };
  if (/has_details/.test(sql)) return { rows: remindState ? [remindState] : [] };
  return { rows: [], rowCount: 0 };
}

const sqlCalls = () => mockQuery.mock.calls.map((call) => String(call[0]));

describe('worker-application-hired-actions', () => {
  const env = process.env;

  beforeEach(() => {
    jest.resetAllMocks();
    process.env = { ...env, REQUIRED_TOS_VERSION: 'v1.0' };
    messageRow = {
      outcome: 'sent', conversation_id: 'c1', message_id: 'm1', sent_at: new Date('2026-10-14T13:00:00.000Z'),
      retry_after_seconds: null,
    };
    stampedRows = 1;
    remindState = null;
    mockGetDbPool.mockResolvedValue({ connect: jest.fn().mockResolvedValue({ query: mockQuery, release: mockRelease }) });
    mockQuery.mockImplementation(async (sql: string) => defaultQuery(sql));
    mockSetInternal.mockResolvedValue(undefined);
  });

  afterAll(() => { process.env = env; });

  describe('POST message (K4.3)', () => {
    it('201s with the conversation, the message and its time, and commits', async () => {
      const res = await messageHandler(post('message', { body: '  On my way  ' }));
      expect(res.statusCode).toBe(201);
      expect(JSON.parse(res.body)).toEqual({ conversation_id: 'c1', message_id: 'm1', sent_at: '2026-10-14T13:00:00.000Z' });
      const call = mockQuery.mock.calls.find(([sql]) => /worker_post_application_message/.test(String(sql)));
      expect(call?.[1]).toEqual([APP_ID, 'On my way']);
      expect(mockSetInternal).toHaveBeenCalledWith(expect.anything(), WORKER_ID);
      expect(sqlCalls()).toContain('COMMIT');
    });

    it.each([
      ['a missing body', {}],
      ['a blank body', { body: '   ' }],
      ['a body over 2000 characters', { body: 'x'.repeat(2001) }],
      ['a body that is not text', { body: 42 }],
      ['a NUL', { body: 'a\u0000b' }],
    ])('400s %s before the pool', async (_label, body) => {
      const res = await messageHandler(post('message', body));
      expect(res.statusCode).toBe(400);
      expect(JSON.parse(res.body)).toEqual({ error: 'invalid_message' });
      expect(mockGetDbPool).not.toHaveBeenCalled();
    });

    it.each([
      ['not_found', 404, { error: 'not_found' }],
      ['not_hired', 409, { error: 'not_hired' }],
      ['invalid', 400, { error: 'invalid_message' }],
    ])('maps %s to %i and rolls back', async (outcome, status, body) => {
      messageRow = { outcome };
      const res = await messageHandler(post('message', { body: 'Hi' }));
      expect(res.statusCode).toBe(status);
      expect(JSON.parse(res.body)).toEqual(body);
      expect(sqlCalls()).toContain('ROLLBACK');
      expect(sqlCalls()).not.toContain('COMMIT');
    });

    it('429s with the seconds until the next message is allowed', async () => {
      messageRow = { outcome: 'rate_limited', retry_after_seconds: 1234 };
      const res = await messageHandler(post('message', { body: 'Hi' }));
      expect(res.statusCode).toBe(429);
      expect(JSON.parse(res.body)).toEqual({ error: 'rate_limited', retry_after_seconds: 1234 });
    });

    it('401s without a caller, 404s a malformed id and 405s a non-POST, before the pool', async () => {
      expect((await messageHandler(post('message', { body: 'Hi' }, { requestContext: { authorizer: { claims: {} } } } as never))).statusCode).toBe(401);
      expect((await messageHandler(post('message', { body: 'Hi' }, { pathParameters: { applicationId: 'x', action: 'message' } }))).statusCode).toBe(404);
      expect((await messageHandler(post('message', { body: 'Hi' }, { httpMethod: 'GET' }))).statusCode).toBe(405);
      expect(mockGetDbPool).not.toHaveBeenCalled();
    });

    it('403s a worker who has not accepted the terms', async () => {
      mockQuery.mockImplementation(async (sql: string) => (/tos_version/.test(sql) ? { rows: [{ tos_version: 'v0.9' }] } : defaultQuery(sql)));
      const res = await messageHandler(post('message', { body: 'Hi' }));
      expect(res.statusCode).toBe(403);
      expect(sqlCalls().some((sql) => /worker_post_application_message/.test(sql))).toBe(false);
    });
  });

  describe('POST remind-employer (K4.4)', () => {
    it('202s and stamps the reminder in one conditional statement', async () => {
      const res = await remindHandler(post('remind-employer', undefined));
      expect(res.statusCode).toBe(202);
      const update = mockQuery.mock.calls.find(([sql]) => /^\s*UPDATE job_applications/.test(String(sql)));
      const sql = String(update?.[0]).replace(/\s+/g, ' ');
      expect(sql).toContain('SET hire_details_reminded_at = now()');
      expect(sql).toContain("WHERE id = $1 AND worker_id = $2 AND status = 'hired'");
      expect(sql).toContain("hire_details_reminded_at <= now() - interval '24 hours'");
      expect(update?.[1]).toEqual([APP_ID, WORKER_ID]);
      expect(sqlCalls()).toContain('COMMIT');
    });

    it('429s within 24 hours of the last reminder, with the seconds left', async () => {
      stampedRows = 0;
      remindState = { status: 'hired', has_details: false, retry_after_seconds: 7200 };
      const res = await remindHandler(post('remind-employer', undefined));
      expect(res.statusCode).toBe(429);
      expect(JSON.parse(res.body)).toEqual({ error: 'rate_limited', retry_after_seconds: 7200 });
      expect(sqlCalls()).not.toContain('COMMIT');
    });

    it('202s without a stamp once the employer has given details', async () => {
      stampedRows = 0;
      remindState = { status: 'hired', has_details: true, retry_after_seconds: null };
      const res = await remindHandler(post('remind-employer', undefined));
      expect(res.statusCode).toBe(202);
      expect(sqlCalls()).not.toContain('COMMIT');
    });

    it('409s an application that is not hired and 404s one that is not the worker\'s', async () => {
      stampedRows = 0;
      remindState = { status: 'talking', has_details: false, retry_after_seconds: null };
      expect((await remindHandler(post('remind-employer', undefined))).statusCode).toBe(409);
      remindState = null;
      const res = await remindHandler(post('remind-employer', undefined));
      expect(res.statusCode).toBe(404);
      expect(JSON.parse(res.body)).toEqual({ error: 'not_found' });
    });
  });
});
