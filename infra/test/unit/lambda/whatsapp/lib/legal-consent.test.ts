import { setRlsContext } from '../../../../../lambda/lib/db';
import { recordCanonicalWhatsAppConsent } from '../../../../../lambda/whatsapp/lib/legal-consent';

jest.mock('../../../../../lambda/lib/db', () => ({
  setRlsContext: jest.fn().mockResolvedValue(undefined),
}));

const WORKER_ID = 'aaaaaaaa-0000-0000-0000-000000000001';

describe('recordCanonicalWhatsAppConsent', () => {
  beforeEach(() => jest.clearAllMocks());

  it('updates both canonical versions and inserts only missing immutable tos/privacy audit rows', async () => {
    const query = jest.fn()
      .mockResolvedValueOnce({ rowCount: 1, rows: [{ cognito_sub: 'cognito-worker-1' }] })
      .mockResolvedValueOnce({ rowCount: 1, rows: [] })
      .mockResolvedValueOnce({ rowCount: 2, rows: [] });
    const client = { query } as any;

    await recordCanonicalWhatsAppConsent(client, {
      workerId: WORKER_ID,
      documentVersion: '2.1',
    });

    expect(setRlsContext).toHaveBeenCalledWith(client, 'cognito-worker-1');
    const update = query.mock.calls[1];
    expect(update[0]).toMatch(/tos_version = \$2/);
    expect(update[0]).toMatch(/privacy_version = \$2/);
    expect(update[0]).toMatch(/tos_version IS DISTINCT FROM \$2/);
    expect(update[0]).toMatch(/privacy_version IS DISTINCT FROM \$2/);
    expect(update[1]).toEqual([WORKER_ID, '2.1']);

    const insert = query.mock.calls[2];
    expect(insert[0]).toMatch(/VALUES \('tos'\), \('privacy'\)/);
    expect(insert[0]).toMatch(/NOT EXISTS/);
    expect(insert[0]).toMatch(/document_version = \$2/);
    expect(insert[1]).toEqual([WORKER_ID, '2.1']);
  });

  it('fails closed when the worker does not exist', async () => {
    const query = jest.fn().mockResolvedValueOnce({ rowCount: 0, rows: [] });

    await expect(recordCanonicalWhatsAppConsent({ query } as any, {
      workerId: WORKER_ID,
      documentVersion: '2.1',
    })).rejects.toThrow('user missing at consent time');

    expect(setRlsContext).not.toHaveBeenCalled();
    expect(query).toHaveBeenCalledTimes(1);
  });
});
