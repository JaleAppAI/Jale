const mockQuery = jest.fn();
const mockRelease = jest.fn();
const mockConnect = jest.fn(() => Promise.resolve({ query: mockQuery, release: mockRelease }));
jest.mock('../../../../lambda/lib/db', () => ({
  getDbPool: jest.fn(() => Promise.resolve({ connect: mockConnect })),
}));
const mockSendPending = jest.fn();
jest.mock('../../../../lambda/lib/job-messaging', () => ({
  sendPendingJobMessageOutbox: mockSendPending,
}));
import { handler } from '../../../../lambda/whatsapp/job-message-outbox-sweeper';

describe('job-message-outbox-sweeper', () => {
  beforeEach(() => jest.clearAllMocks());

  it('flushes per stale worker and survives one worker failing', async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [{ worker_id: 'w1' }, { worker_id: 'w2' }], rowCount: 2 });
    mockSendPending
      .mockRejectedValueOnce(new Error('twilio down'))   // w1 fails
      .mockResolvedValueOnce(undefined);                  // w2 ok
    await handler();
    expect(mockSendPending).toHaveBeenCalledTimes(2);
    expect(mockSendPending).toHaveBeenCalledWith(expect.anything(), { actorUserId: 'w2' });
    expect(mockRelease).toHaveBeenCalled();
  });

  it('releases the client even when discovery returns no workers', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });
    await handler();
    expect(mockSendPending).not.toHaveBeenCalled();
    expect(mockRelease).toHaveBeenCalled();
  });
});
