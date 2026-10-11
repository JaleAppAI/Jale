/**
 * The audit metrics leave through the shared EMF helper (lambda/lib/emf.ts),
 * on console.log: the one path whose lines CloudWatch is known to turn into
 * metrics. Each metric is one line, the only argument of its call, and none
 * goes to console.error.
 */
import {
  emitAuditFallbackEvent,
  emitAuditFallbackFailed,
  emitAuditWriteFailed,
} from '../../../../../lambda/lib/audit/metrics';

let logSpy: jest.SpyInstance;
let errorSpy: jest.SpyInstance;

beforeEach(() => {
  logSpy = jest.spyOn(console, 'log').mockImplementation(() => undefined);
  errorSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
});

afterEach(() => {
  logSpy.mockRestore();
  errorSpy.mockRestore();
});

function onlyLine(): Record<string, any> {
  expect(errorSpy).not.toHaveBeenCalled();
  expect(logSpy).toHaveBeenCalledTimes(1);
  expect(logSpy.mock.calls[0]).toHaveLength(1);
  return JSON.parse(logSpy.mock.calls[0][0] as string);
}

const envelope = (metric: string, dimensions: string[][]) => [{
  Namespace: 'Jale/Audit',
  Dimensions: dimensions,
  Metrics: [{ Name: metric, Unit: 'Count' }],
}];

describe('audit metrics', () => {
  it('AuditWriteFailed: one console.log line, dimension Surface, with the origin', () => {
    emitAuditWriteFailed('employer.inbox', 'api');
    const line = onlyLine();
    expect(line._aws.CloudWatchMetrics).toEqual(envelope('AuditWriteFailed', [['Surface']]));
    expect(line).toMatchObject({ Surface: 'employer.inbox', origin: 'api', AuditWriteFailed: 1 });
  });

  it('AuditWriteFailed: a malformed surface is reported as invalid', () => {
    emitAuditWriteFailed('Not A Surface', 'api');
    expect(onlyLine().Surface).toBe('invalid');
  });

  it('AuditFallbackEvents: one console.log line, no dimensions, with the origin', () => {
    emitAuditFallbackEvent('whatsapp');
    const line = onlyLine();
    expect(line._aws.CloudWatchMetrics).toEqual(envelope('AuditFallbackEvents', [[]]));
    expect(line).toMatchObject({ origin: 'whatsapp', AuditFallbackEvents: 1 });
  });

  it('AuditFallbackFailed: one console.log line, no dimensions, with the lost record\'s codes and ids', () => {
    emitAuditFallbackFailed('api', {
      kind: 'attempt',
      surface: 'employer.inbox',
      actor_id: '00000000-0000-4000-8000-000000000001',
    });
    const line = onlyLine();
    expect(line._aws.CloudWatchMetrics).toEqual(envelope('AuditFallbackFailed', [[]]));
    expect(line).toMatchObject({
      origin: 'api',
      kind: 'attempt',
      surface: 'employer.inbox',
      actor_id: '00000000-0000-4000-8000-000000000001',
      AuditFallbackFailed: 1,
    });
  });

  it('AuditFallbackFailed: a lost-record field cannot replace the envelope, the metric value or the origin', () => {
    emitAuditFallbackFailed('api', { _aws: 'replaced', AuditFallbackFailed: 0, origin: 'other' });
    const line = onlyLine();
    expect(line._aws.CloudWatchMetrics).toEqual(envelope('AuditFallbackFailed', [[]]));
    expect(line.AuditFallbackFailed).toBe(1);
    expect(line.origin).toBe('api');
  });
});
