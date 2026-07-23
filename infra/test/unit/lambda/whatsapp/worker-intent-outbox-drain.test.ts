const mockGetDbPool = jest.fn();
const mockDrain = jest.fn();
const mockCountAged = jest.fn();

jest.mock('../../../../lambda/lib/db', () => ({
  getDbPool: (...args: unknown[]) => mockGetDbPool(...args),
}));
jest.mock('../../../../lambda/whatsapp/lib/outbox', () => ({
  drainWorkerIntentOutbox: (...args: unknown[]) => mockDrain(...args),
  countAgedWorkerIntentOutbox: (...args: unknown[]) => mockCountAged(...args),
}));

import { handler } from '../../../../lambda/whatsapp/worker-intent-outbox-drain';

describe('worker-intent outbox drain entrypoint', () => {
  it('invokes only the worker-intent drain and emits structured counts', async () => {
    const pool = { connect: jest.fn() };
    mockGetDbPool.mockResolvedValue(pool);
    mockDrain.mockResolvedValue({ sent: 2, ambiguous: 1, failed: 1, leaseLost: 0 });
    mockCountAged.mockResolvedValue(3);
    const log = jest.spyOn(console, 'log').mockImplementation(() => undefined);

    await handler({} as any);

    expect(mockDrain).toHaveBeenCalledWith(pool);
    expect(mockCountAged).toHaveBeenCalledWith(pool);
    expect(log).toHaveBeenCalledWith(JSON.stringify({
      metric: 'WorkerIntentOutboxDrain',
      sent: 2,
      ambiguous: 1,
      failed: 1,
      leaseLost: 0,
    }));
    expect(log).toHaveBeenCalledWith(JSON.stringify({
      metric: 'WorkerIntentOutboxSendUnknown',
      count: 1,
    }));
    expect(log).toHaveBeenCalledWith(JSON.stringify({
      metric: 'WorkerIntentOutboxFailure',
      count: 1,
    }));
    expect(log).toHaveBeenCalledWith(JSON.stringify({
      metric: 'WorkerIntentOutboxBacklogAged',
      count: 3,
    }));
    log.mockRestore();
  });
});
