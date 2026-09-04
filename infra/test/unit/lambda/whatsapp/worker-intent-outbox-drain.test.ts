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
  // Restoration must NOT rely on the inline `log.mockRestore()` at the end of
  // each test: a failing assertion throws before it, console.log stays spied,
  // and the NEXT `jest.spyOn(console, 'log')` hands back the same spy with the
  // previous test's calls still on it. That is not hypothetical -- while these
  // tests were red, 'fires the failure signal for an expired row' passed on a
  // WorkerIntentOutboxFailure line logged by the test above it.
  afterEach(() => { jest.restoreAllMocks(); });

  it('invokes only the worker-intent drain and emits structured counts', async () => {
    const pool = { connect: jest.fn() };
    mockGetDbPool.mockResolvedValue(pool);
    mockDrain.mockResolvedValue({
      sent: 2, ambiguous: 1, failed: 1, leaseLost: 0, deferred: 2, expired: 0,
    });
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
      deferred: 2,
      expired: 0,
    }));
    // A deferred row is neither sent nor failed: it is a row waiting on a
    // Meta template approval. Without `deferred` on this line, a lane whose
    // template is stuck reads as a quiet drain that sent nothing and failed
    // nothing -- and the per-row WorkerIntentOutboxTemplatePending metric
    // (emitted by outbox.ts) is the only trace left.
    expect(log).not.toHaveBeenCalledWith(JSON.stringify({
      metric: 'WorkerIntentOutboxFailure',
      count: 2,
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

  // F4. `expired` is migration 093's 48-hour terminal branch, and it is a
  // DEATH, not a deferral: the row will never be delivered. It has to reach
  // the same WorkerIntentOutboxFailure line the RPC-side terminal failures
  // use, or the WhatsAppWorkerIntentFailures alarm stays silent while an
  // employer's "we want to hire you" quietly expires. So the line's count is
  // failed + expired, not failed.
  it('folds the 48h expired count into the terminal failure signal', async () => {
    const pool = { connect: jest.fn() };
    mockGetDbPool.mockResolvedValue(pool);
    mockDrain.mockResolvedValue({
      sent: 0, ambiguous: 0, failed: 1, leaseLost: 0, deferred: 1, expired: 2,
    });
    mockCountAged.mockResolvedValue(0);
    const log = jest.spyOn(console, 'log').mockImplementation(() => undefined);

    await handler({} as any);

    expect(log).toHaveBeenCalledWith(JSON.stringify({
      metric: 'WorkerIntentOutboxDrain',
      sent: 0,
      ambiguous: 0,
      failed: 1,
      leaseLost: 0,
      deferred: 1,
      expired: 2,
    }));
    expect(log).toHaveBeenCalledWith(JSON.stringify({
      metric: 'WorkerIntentOutboxFailure',
      count: 3,
    }));
    log.mockRestore();
  });

  it('fires the failure signal for an expired row even when nothing failed', async () => {
    // The regression this guards: with `if (result.failed > 0)`, an expiry is
    // the ONE terminal outcome that emits no failure metric at all.
    const pool = { connect: jest.fn() };
    mockGetDbPool.mockResolvedValue(pool);
    mockDrain.mockResolvedValue({
      sent: 0, ambiguous: 0, failed: 0, leaseLost: 0, deferred: 0, expired: 1,
    });
    mockCountAged.mockResolvedValue(0);
    const log = jest.spyOn(console, 'log').mockImplementation(() => undefined);

    await handler({} as any);

    expect(log).toHaveBeenCalledWith(JSON.stringify({
      metric: 'WorkerIntentOutboxFailure',
      count: 1,
    }));
    log.mockRestore();
  });

  it('emits no failure signal when every row was merely deferred', async () => {
    // The other half of the contract: a parked row is not a death, so folding
    // `expired` in must not drag `deferred` along with it.
    const pool = { connect: jest.fn() };
    mockGetDbPool.mockResolvedValue(pool);
    mockDrain.mockResolvedValue({
      sent: 0, ambiguous: 0, failed: 0, leaseLost: 0, deferred: 3, expired: 0,
    });
    mockCountAged.mockResolvedValue(0);
    const log = jest.spyOn(console, 'log').mockImplementation(() => undefined);

    await handler({} as any);

    expect(log.mock.calls.some(
      ([line]) => String(line).includes('WorkerIntentOutboxFailure'),
    )).toBe(false);
    log.mockRestore();
  });
});
