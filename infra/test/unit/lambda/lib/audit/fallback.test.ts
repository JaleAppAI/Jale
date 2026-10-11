const mockSend = jest.fn();
jest.mock('@aws-sdk/client-cloudwatch-logs', () => {
  const actual = jest.requireActual('@aws-sdk/client-cloudwatch-logs');
  return {
    ...actual,
    CloudWatchLogsClient: jest.fn().mockImplementation(() => ({ send: mockSend })),
  };
});

import type { AuditEventPayload } from '../../../../../lambda/lib/audit/record';

type FallbackModule = typeof import('../../../../../lambda/lib/audit/fallback');

const GROUP = 'fixture-audit-fallback-group';
const STREAM = /^api\/[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

const payload: AuditEventPayload = {
  kind: 'attempt',
  outcome: 'denied',
  actor_kind: 'employer',
  actor_id: '22222222-2222-4222-8222-222222222222',
  channel: 'web',
  surface: 'employer.worker_documents',
  categories: ['documents'],
  subject_user_ids: ['11111111-1111-4111-8111-111111111111'],
  record_type: 'worker_document',
  record_ids: [],
  result_count: 0,
  field_names: [],
  part: 1,
  parts: 1,
  request_id: 'c6af9ac6-7b61-11e6-9a41-93e8deadbeef',
};
const occurredAt = new Date('2026-10-05T12:00:00.000Z');

function freshFallback(): FallbackModule {
  let mod!: FallbackModule;
  jest.isolateModules(() => {
    mod = require('../../../../../lambda/lib/audit/fallback');
  });
  return mod;
}

function commands(name: string): Array<{ input: Record<string, any> }> {
  return mockSend.mock.calls.map(([command]) => command).filter((command) => command.constructor.name === name);
}

let logSpy: jest.SpyInstance;
let errorSpy: jest.SpyInstance;
const savedEnv = { ...process.env };
beforeEach(() => {
  mockSend.mockReset();
  mockSend.mockResolvedValue({});
  logSpy = jest.spyOn(console, 'log').mockImplementation(() => undefined);
  errorSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
  process.env = { ...savedEnv, AUDIT_FALLBACK_LOG_GROUP: GROUP, DB_EXPECTED_LOGIN: 'jale_api' };
});
afterEach(() => {
  logSpy.mockRestore();
  errorSpy.mockRestore();
  process.env = { ...savedEnv };
});

function emfLines(spy: jest.SpyInstance): Record<string, any>[] {
  return spy.mock.calls.map(([line]) => JSON.parse(line as string));
}

describe('writeAuditFallback', () => {
  it('creates its stream once, then writes one line per record and emits AuditFallbackEvents', async () => {
    const { writeAuditFallback } = freshFallback();
    await writeAuditFallback(payload, occurredAt);
    await writeAuditFallback({ ...payload, outcome: 'not_found' }, occurredAt);

    const created = commands('CreateLogStreamCommand');
    expect(created).toHaveLength(1);
    expect(created[0].input.logGroupName).toBe(GROUP);
    expect(created[0].input.logStreamName).toMatch(STREAM);

    const puts = commands('PutLogEventsCommand');
    expect(puts).toHaveLength(2);
    for (const put of puts) {
      expect(put.input.logGroupName).toBe(GROUP);
      expect(put.input.logStreamName).toBe(created[0].input.logStreamName);
      expect(put.input.logEvents).toHaveLength(1);
      expect(put.input.logEvents[0].timestamp).toBe(occurredAt.getTime());
    }
    expect(JSON.parse(puts[0].input.logEvents[0].message)).toEqual({
      ...payload,
      occurred_at: '2026-10-05T12:00:00.000Z',
      origin: 'api',
    });

    const emf = emfLines(logSpy);
    expect(emf).toHaveLength(2);
    for (const line of emf) {
      expect(line._aws.CloudWatchMetrics).toEqual([
        { Namespace: 'Jale/Audit', Dimensions: [[]], Metrics: [{ Name: 'AuditFallbackEvents', Unit: 'Count' }] },
      ]);
      expect(line.AuditFallbackEvents).toBe(1);
    }
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it('names its stream and lines after the WhatsApp engine on that login', async () => {
    process.env.DB_EXPECTED_LOGIN = 'jale_whatsapp';
    const { writeAuditFallback } = freshFallback();
    await writeAuditFallback(payload, occurredAt);
    const put = commands('PutLogEventsCommand')[0];
    expect(put.input.logStreamName).toMatch(/^whatsapp\//);
    expect(JSON.parse(put.input.logEvents[0].message).origin).toBe('whatsapp');
  });

  it('accepts a stream that already exists', async () => {
    mockSend.mockImplementation(async (command: { constructor: { name: string } }) => {
      if (command.constructor.name === 'CreateLogStreamCommand') {
        throw Object.assign(new Error('exists'), { name: 'ResourceAlreadyExistsException' });
      }
      return {};
    });
    const { writeAuditFallback } = freshFallback();
    await writeAuditFallback(payload, occurredAt);
    expect(commands('PutLogEventsCommand')).toHaveLength(1);
    expect(emfLines(logSpy)[0].AuditFallbackEvents).toBe(1);
  });

  it('reports a lost record with codes and ids only when no group is configured', async () => {
    delete process.env.AUDIT_FALLBACK_LOG_GROUP;
    const { writeAuditFallback } = freshFallback();
    await expect(writeAuditFallback({ ...payload, link_expires_at: '2026-10-05T12:15:00.000Z' }, occurredAt)).resolves.toBeUndefined();
    expect(mockSend).not.toHaveBeenCalled();
    expect(errorSpy).not.toHaveBeenCalled();
    const [line] = emfLines(logSpy);
    expect(line._aws.CloudWatchMetrics[0].Metrics).toEqual([{ Name: 'AuditFallbackFailed', Unit: 'Count' }]);
    expect(line._aws.CloudWatchMetrics[0].Dimensions).toEqual([[]]);
    expect(line).toMatchObject({
      AuditFallbackFailed: 1,
      origin: 'api',
      occurred_at: '2026-10-05T12:00:00.000Z',
      kind: 'attempt',
      surface: 'employer.worker_documents',
      actor_id: payload.actor_id,
      subject_user_ids: payload.subject_user_ids,
    });
    expect(line).not.toHaveProperty('link_expires_at');
  });

  it('never throws, never prints the error text, and tries the stream again after a failure', async () => {
    mockSend.mockRejectedValueOnce(new Error('fixture SDK failure text'));
    const { writeAuditFallback } = freshFallback();
    await expect(writeAuditFallback(payload, occurredAt)).resolves.toBeUndefined();
    expect(errorSpy).not.toHaveBeenCalled();
    expect(logSpy).toHaveBeenCalledTimes(1);
    expect(String(logSpy.mock.calls[0][0])).not.toContain('fixture SDK failure text');
    expect(emfLines(logSpy)[0].AuditFallbackFailed).toBe(1);

    await writeAuditFallback(payload, occurredAt);
    expect(commands('CreateLogStreamCommand')).toHaveLength(2);
    expect(commands('PutLogEventsCommand')).toHaveLength(1);
  });

  it('reports a lost record when the write itself fails', async () => {
    mockSend.mockImplementation(async (command: { constructor: { name: string } }) => {
      if (command.constructor.name === 'PutLogEventsCommand') throw new Error('throttled');
      return {};
    });
    const { writeAuditFallback } = freshFallback();
    await expect(writeAuditFallback(payload, occurredAt)).resolves.toBeUndefined();
    expect(emfLines(logSpy)).toEqual([expect.objectContaining({ AuditFallbackFailed: 1 })]);
    expect(errorSpy).not.toHaveBeenCalled();
  });
});
