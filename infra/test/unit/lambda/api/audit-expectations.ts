/**
 * audit-expectations.ts -- shared assertions for the handler tests that check
 * access and attempt records. Handlers under test have
 * lib/audit/record mocked, so these read the order of the mock calls.
 */
import { RECORD_EVENT_SQL } from '../../../../lambda/lib/audit/record';

export const FIXTURE_REQUEST_ID = 'fixture-request-0001';

/** The event with an API Gateway request id added to its request context. */
export function withRequestId<T extends { requestContext?: unknown }>(event: T, requestId = FIXTURE_REQUEST_ID): T {
  const requestContext = (event.requestContext ?? {}) as Record<string, unknown>;
  return { ...event, requestContext: { ...requestContext, requestId } };
}

/** The caller a handler builds for a signed-in actor on this request. */
export function callerFor(actorKind: 'worker' | 'employer', actorId: string, channel: 'web' | 'whatsapp' = 'web') {
  return { actorKind, actorId, channel, requestId: FIXTURE_REQUEST_ID };
}

function orderOf(mock: jest.Mock, index: number): number {
  const order = mock.mock.invocationCallOrder[index];
  if (order === undefined) throw new Error('expected call was not made');
  return order;
}

/** The invocation order of the first query whose SQL is exactly `sql` (or matches it). */
export function queryOrder(query: jest.Mock, sql: string | RegExp, occurrence = 0): number {
  const matches = query.mock.calls
    .map(([text], index) => ({ text: String(text), index }))
    .filter(({ text }) => (typeof sql === 'string' ? text === sql : sql.test(text)));
  const match = matches[occurrence];
  if (!match) throw new Error(`no query matching ${String(sql)}`);
  return orderOf(query, match.index);
}

/** Every access record was written after `after` and before the transaction's COMMIT. */
export function expectRecordedInsideTransaction(query: jest.Mock, recordAccess: jest.Mock, after?: string | RegExp): void {
  expect(recordAccess).toHaveBeenCalled();
  const first = orderOf(recordAccess, 0);
  const last = orderOf(recordAccess, recordAccess.mock.calls.length - 1);
  expect(last).toBeLessThan(queryOrder(query, 'COMMIT'));
  if (after) expect(first).toBeGreaterThan(queryOrder(query, after));
}

/** The attempt was written after the request's transaction ended with `end`. */
export function expectAttemptAfter(query: jest.Mock, recordAttempt: jest.Mock, end: 'COMMIT' | 'ROLLBACK'): void {
  expect(recordAttempt).toHaveBeenCalledTimes(1);
  expect(orderOf(recordAttempt, 0)).toBeGreaterThan(queryOrder(query, end));
}

/** No record_event SQL went through the handler's own client (the helpers are mocked). */
export function expectNoDirectRecordSql(query: jest.Mock): void {
  expect(query.mock.calls.some(([text]) => String(text) === RECORD_EVENT_SQL)).toBe(false);
}

/** The caller a handler states for an actor without an id (anonymous, platform, token holder). */
export function idlessCallerFor(actorKind: 'anonymous' | 'platform' | 'token_holder', channel: 'web' | 'whatsapp' = 'web') {
  return expect.objectContaining({ actorKind, actorId: null, channel });
}

/**
 * The audit context was stated once per unit of work, inside its transaction
 * (after the BEGIN that opened it) and before the first covered write.
 */
export function expectContextBeforeWrite(query: jest.Mock, setAuditContext: jest.Mock, firstWrite: string | RegExp, occurrence = 0): void {
  expect(setAuditContext).toHaveBeenCalled();
  const write = queryOrder(query, firstWrite, occurrence);
  const stated = setAuditContext.mock.invocationCallOrder.filter((order) => order < write);
  expect(stated.length).toBeGreaterThan(0);
  const last = Math.max(...stated);
  const begins = query.mock.calls
    .map(([text], index) => ({ text: String(text), order: query.mock.invocationCallOrder[index] }))
    .filter(({ text, order }) => text === 'BEGIN' && order < write);
  expect(begins.length).toBeGreaterThan(0);
  expect(last).toBeGreaterThan(Math.max(...begins.map((b) => b.order)));
}
