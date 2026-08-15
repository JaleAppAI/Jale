const mockQuery = jest.fn();
jest.mock('../../../../lambda/lib/db', () => ({
  getDbPool: jest.fn(() => Promise.resolve({ query: mockQuery })),
}));

import type { ScheduledEvent } from 'aws-lambda';
import { handler } from '../../../../lambda/whatsapp/retrigger-sweep-drain';

describe('retrigger-sweep-drain', () => {
  beforeEach(() => jest.clearAllMocks());

  it('calls the definer with the event id as the sweep run id and logs the metric', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ workers_swept: 3, events_enqueued: 2 }] });
    const logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});

    await handler({ id: 'evt-123' } as unknown as ScheduledEvent);

    expect(mockQuery).toHaveBeenCalledWith(
      expect.stringContaining('retrigger_deferred_ready_workers($1, $2)'),
      ['evt-123', 500],
    );
    const logged = JSON.parse(logSpy.mock.calls.at(-1)![0] as string);
    expect(logged).toEqual({ metric: 'RetriggerSweepDrain', workersSwept: 3, eventsEnqueued: 2 });
    logSpy.mockRestore();
  });

  it('logs zeros when the function returns no row', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });
    const logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
    await handler({ id: 'evt-456' } as unknown as ScheduledEvent);
    const logged = JSON.parse(logSpy.mock.calls.at(-1)![0] as string);
    expect(logged).toEqual({ metric: 'RetriggerSweepDrain', workersSwept: 0, eventsEnqueued: 0 });
    logSpy.mockRestore();
  });
});
