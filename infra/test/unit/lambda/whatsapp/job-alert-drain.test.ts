const mockGetDbPool = jest.fn();
const mockDrain = jest.fn();

jest.mock('../../../../lambda/lib/db', () => ({
  getDbPool: (...args: unknown[]) => mockGetDbPool(...args),
}));
jest.mock('../../../../lambda/whatsapp/lib/outbox', () => ({
  drainJobAlertOutbox: (...args: unknown[]) => mockDrain(...args),
}));

import { handler } from '../../../../lambda/whatsapp/job-alert-drain';

describe('job-alert outbox drain entrypoint', () => {
  // Restore in afterEach, not inline: a failing assertion would otherwise
  // leave console.log spied and leak calls into the next test.
  afterEach(() => { jest.restoreAllMocks(); });

  it('emits only the summary line when nothing failed', async () => {
    const pool = { connect: jest.fn() };
    mockGetDbPool.mockResolvedValue(pool);
    mockDrain.mockResolvedValue({ sent: 3, ambiguous: 0, failed: 0 });
    const log = jest.spyOn(console, 'log').mockImplementation(() => undefined);

    await handler({} as any);

    expect(mockDrain).toHaveBeenCalledWith(pool);
    expect(log.mock.calls).toEqual([
      [JSON.stringify({ metric: 'JobAlertOutboxDrain', sent: 3, ambiguous: 0, failed: 0 })],
    ]);
  });

  it.each([
    [{ sent: 1, ambiguous: 0, failed: 2 }],
    [{ sent: 0, ambiguous: 1, failed: 0 }],
  ])('adds a failure line when failed or ambiguous is above zero (%j)', async (result) => {
    mockGetDbPool.mockResolvedValue({ connect: jest.fn() });
    mockDrain.mockResolvedValue(result);
    const log = jest.spyOn(console, 'log').mockImplementation(() => undefined);

    await handler({} as any);

    expect(log.mock.calls).toEqual([
      [JSON.stringify({ metric: 'JobAlertOutboxDrain', ...result })],
      [JSON.stringify({ metric: 'JobAlertOutboxDrainFailure', failed: result.failed, ambiguous: result.ambiguous })],
    ]);
  });
});
