import { getDbPool } from '../../../../lambda/lib/db';
import { sendPendingAdminOutbox } from '../../../../lambda/whatsapp/lib/outbox';
import { handler } from '../../../../lambda/whatsapp/admin-outbox-dispatcher';

jest.mock('../../../../lambda/lib/db');
jest.mock('../../../../lambda/whatsapp/lib/outbox');

describe('admin-outbox-dispatcher', () => {
  const release = jest.fn();
  const client = { query: jest.fn(), release };

  beforeEach(() => {
    jest.clearAllMocks();
    (getDbPool as jest.Mock).mockResolvedValue({ connect: jest.fn().mockResolvedValue(client) });
    (sendPendingAdminOutbox as jest.Mock).mockResolvedValue(undefined);
  });

  it('drains the admin outbox as the platform on WhatsApp, named by the invocation id', async () => {
    await handler({} as never, { awsRequestId: 'fixture-invocation-0002' } as never);
    expect(sendPendingAdminOutbox).toHaveBeenCalledWith(client, {
      actorKind: 'platform',
      actorId: null,
      channel: 'whatsapp',
      requestId: 'fixture-invocation-0002',
    });
    expect(release).toHaveBeenCalled();
  });

  it('releases the client when the drain fails', async () => {
    (sendPendingAdminOutbox as jest.Mock).mockRejectedValue(new Error('fixture failure'));
    await expect(handler({} as never, {} as never)).rejects.toThrow('fixture failure');
    expect(release).toHaveBeenCalled();
  });
});
