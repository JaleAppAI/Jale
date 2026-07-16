const mockQuery = jest.fn();
const mockRelease = jest.fn();
const mockSendPendingEmails = jest.fn();
jest.mock('../../../lambda/lib/db', () => ({
  getDbPool: jest.fn(() => Promise.resolve({
    connect: jest.fn(() => Promise.resolve({ query: mockQuery, release: mockRelease })),
  })),
}));
jest.mock('../../../lambda/lib/email-outbox', () => ({ sendPendingEmails: mockSendPendingEmails }));

import { handler } from '../../../lambda/billing/email-outbox-sweeper';

describe('billing email outbox sweeper', () => {
  beforeEach(() => jest.clearAllMocks());

  it('drains pending email rows and releases the jale_admin connection', async () => {
    mockSendPendingEmails.mockResolvedValue(2);
    await handler();
    expect(mockSendPendingEmails).toHaveBeenCalledWith(expect.objectContaining({ query: mockQuery }));
    expect(mockRelease).toHaveBeenCalledTimes(1);
  });

  it('rethrows failures for EventBridge retry and still releases the connection', async () => {
    mockSendPendingEmails.mockRejectedValue(new Error('db unavailable'));
    const errorLog = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    await expect(handler()).rejects.toThrow('db unavailable');
    expect(errorLog).toHaveBeenCalledWith('billing-email-outbox-sweeper failed', { code: 'Error' });
    expect(mockRelease).toHaveBeenCalledTimes(1);
    errorLog.mockRestore();
  });
});
