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
      .mockResolvedValueOnce({ rowCount: 2, rows: [] })
      .mockResolvedValueOnce({ rowCount: 1, rows: [{ tos_version: '2.1' }] });
    const client = { query } as any;

    const result = await recordCanonicalWhatsAppConsent(client, {
      workerId: WORKER_ID,
      documentVersion: '2.1',
    });

    expect(result).toEqual({ verified: true });
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

    const verify = query.mock.calls[3];
    expect(verify[0]).toMatch(/SELECT tos_version FROM users WHERE id = \$1/);
    expect(verify[1]).toEqual([WORKER_ID]);
  });

  it('returns verified: true when the post-write read shows an accepted version', async () => {
    const query = jest.fn()
      .mockResolvedValueOnce({ rowCount: 1, rows: [{ cognito_sub: 'cognito-worker-1' }] })
      .mockResolvedValueOnce({ rowCount: 1, rows: [] })
      .mockResolvedValueOnce({ rowCount: 2, rows: [] })
      .mockResolvedValueOnce({ rowCount: 1, rows: [{ tos_version: '1.0' }] });
    const client = { query } as any;

    const result = await recordCanonicalWhatsAppConsent(client, {
      workerId: WORKER_ID,
      documentVersion: '1.0',
    });

    expect(result).toEqual({ verified: true });
  });

  it('returns verified: true for an idempotent no-op re-acceptance (0-row UPDATE, version already set)', async () => {
    const query = jest.fn()
      .mockResolvedValueOnce({ rowCount: 1, rows: [{ cognito_sub: 'cognito-worker-1' }] })
      .mockResolvedValueOnce({ rowCount: 0, rows: [] })
      .mockResolvedValueOnce({ rowCount: 0, rows: [] })
      .mockResolvedValueOnce({ rowCount: 1, rows: [{ tos_version: '1.0' }] });
    const client = { query } as any;

    const result = await recordCanonicalWhatsAppConsent(client, {
      workerId: WORKER_ID,
      documentVersion: '1.0',
    });

    expect(result).toEqual({ verified: true });
  });

  it('returns verified: false when the write did not stick', async () => {
    const query = jest.fn()
      .mockResolvedValueOnce({ rowCount: 1, rows: [{ cognito_sub: 'cognito-worker-1' }] })
      .mockResolvedValueOnce({ rowCount: 0, rows: [] })
      .mockResolvedValueOnce({ rowCount: 0, rows: [] })
      .mockResolvedValueOnce({ rowCount: 1, rows: [{ tos_version: null }] });
    const client = { query } as any;

    const result = await recordCanonicalWhatsAppConsent(client, {
      workerId: WORKER_ID,
      documentVersion: '1.0',
    });

    expect(result).toEqual({ verified: false });
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
