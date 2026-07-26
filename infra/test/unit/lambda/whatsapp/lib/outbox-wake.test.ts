import {
  publishOutboxWakes,
  type OutboxWakeDeps,
} from '../../../../../lambda/whatsapp/lib/outbox-wake';

describe('outbox-wake', () => {
  let logSpy: jest.SpyInstance;
  let logs: string[];

  beforeEach(() => {
    logs = [];
    logSpy = jest.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
      logs.push(args.map(String).join(' '));
    });
  });

  afterEach(() => {
    logSpy.mockRestore();
  });

  function deps(sendMessage = jest.fn().mockResolvedValue(undefined)): OutboxWakeDeps {
    return {
      workerIntentQueueUrl: 'https://sqs.test/worker-wake',
      domainQueueUrl: 'https://sqs.test/domain-wake',
      sendMessage,
    };
  }

  it('sends one non-PII wake to each requested queue', async () => {
    const sendMessage = jest.fn().mockResolvedValue(undefined);

    const result = await publishOutboxWakes(
      { workerIntent: true, domain: true },
      deps(sendMessage),
    );

    expect(result).toEqual({ sent: 2, failed: 0 });
    expect(sendMessage.mock.calls).toEqual([
      ['https://sqs.test/worker-wake', JSON.stringify({ kind: 'worker_intent' })],
      ['https://sqs.test/domain-wake', JSON.stringify({ kind: 'domain' })],
    ]);
    expect(JSON.stringify(sendMessage.mock.calls)).not.toMatch(/\+?\d{7,}|otp|phone/i);
  });

  it('does nothing when the committed transaction materialized no wakeable work', async () => {
    const sendMessage = jest.fn().mockResolvedValue(undefined);

    const result = await publishOutboxWakes(
      { workerIntent: false, domain: false },
      deps(sendMessage),
    );

    expect(result).toEqual({ sent: 0, failed: 0 });
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it('does not reject committed work when wake publication fails', async () => {
    const sendMessage = jest.fn()
      .mockRejectedValueOnce(new Error('queue unavailable'))
      .mockResolvedValueOnce(undefined);

    const result = await publishOutboxWakes(
      { workerIntent: true, domain: true },
      deps(sendMessage),
    );

    expect(result).toEqual({ sent: 1, failed: 1 });
    expect(sendMessage).toHaveBeenCalledTimes(2);
    expect(logs).toContain(JSON.stringify({
      metric: 'WhatsAppOutboxWakeFailure',
      kind: 'worker_intent',
      count: 1,
    }));
    expect(logs.join(' ')).not.toContain('queue unavailable');
  });

  it('treats a missing configured queue URL as a recoverable wake failure', async () => {
    const sendMessage = jest.fn().mockResolvedValue(undefined);

    const result = await publishOutboxWakes(
      { workerIntent: true, domain: false },
      { ...deps(sendMessage), workerIntentQueueUrl: undefined },
    );

    expect(result).toEqual({ sent: 0, failed: 1 });
    expect(sendMessage).not.toHaveBeenCalled();
  });
});
