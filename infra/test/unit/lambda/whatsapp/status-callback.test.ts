import { createHmac } from 'node:crypto';

const query = jest.fn();
jest.mock('../../../../lambda/lib/db', () => ({
  getDbPool: jest.fn(async () => ({ query })),
}));
jest.mock('../../../../lambda/whatsapp/lib/twilio-secret', () => ({
  getTwilioSecret: jest.fn(async () => ({ authToken: 'auth-token' })),
  requireTwilioStatusCallbackUrl: jest.fn(() =>
    'https://custom.example.test/prod/whatsapp/status-callback'),
}));

import { handler } from '../../../../lambda/whatsapp/status-callback';

const SID = `SM${'a'.repeat(32)}`;
const URL = 'https://custom.example.test/prod/whatsapp/status-callback';

function signature(url: string, params: Record<string, string>): string {
  const data = url + Object.keys(params).sort().map((key) => `${key}${params[key]}`).join('');
  return createHmac('sha1', 'auth-token').update(data).digest('base64');
}

function event(params: Record<string, string>, options: {
  base64?: boolean;
  signedUrl?: string;
  signatureHeader?: string;
} = {}): any {
  const raw = new URLSearchParams(params).toString();
  const sig = signature(options.signedUrl ?? URL, params);
  return {
    body: options.base64 ? Buffer.from(raw).toString('base64') : raw,
    isBase64Encoded: options.base64 ?? false,
    headers: { [options.signatureHeader ?? 'x-TWILIO-signature']: sig },
    requestContext: { domainName: 'ignored.execute-api.test', path: '/wrong/path' },
  };
}

describe('WhatsApp status callback', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    query.mockResolvedValue({
      rows: [{ matched: true, changed: true, source: 'whatsapp_outbox' }],
    });
  });

  it('validates a base64 form against the exact configured custom-domain URL', async () => {
    const result = await handler(event(
      { MessageSid: SID, MessageStatus: 'delivered' },
      { base64: true, signatureHeader: 'X-Twilio-Signature' },
    ));
    expect(result.statusCode).toBe(200);
    expect(query).toHaveBeenCalledWith(expect.stringContaining('record_twilio_delivery_status'), [
      SID, 'delivered', null, null,
    ]);
  });

  it('accepts SmsStatus as the fallback status field', async () => {
    const result = await handler(event({ MessageSid: SID, SmsStatus: 'sent' }));
    expect(result.statusCode).toBe(200);
    expect(query).toHaveBeenCalledWith(expect.any(String), [SID, 'sent', null, null]);
  });

  it('rejects a signature made for a different URL before DB access', async () => {
    const result = await handler(event(
      { MessageSid: SID, MessageStatus: 'sent' },
      { signedUrl: 'https://wrong.example.test/prod/whatsapp/status-callback' },
    ));
    expect(result.statusCode).toBe(403);
    expect(query).not.toHaveBeenCalled();
  });

  it('returns 400 for signed but invalid bounded parameters', async () => {
    const result = await handler(event({ MessageSid: 'bad', MessageStatus: 'sent' }));
    expect(result.statusCode).toBe(400);
    expect(query).not.toHaveBeenCalled();
  });

  it('returns retryable 503 for a SID not yet persisted', async () => {
    query.mockResolvedValueOnce({ rows: [{ matched: false, changed: false, source: null }] });
    const result = await handler(event({ MessageSid: SID, MessageStatus: 'sent' }));
    expect(result.statusCode).toBe(503);
  });

  it('returns 200 for a known duplicate or stale callback', async () => {
    query.mockResolvedValueOnce({
      rows: [{ matched: true, changed: false, source: 'job_message_outbox' }],
    });
    const result = await handler(event({ MessageSid: SID, MessageStatus: 'sent' }));
    expect(result.statusCode).toBe(200);
  });

  it('returns retryable 503 when persistence fails', async () => {
    query.mockRejectedValueOnce(new Error('database unavailable'));
    const result = await handler(event({ MessageSid: SID, MessageStatus: 'failed' }));
    expect(result.statusCode).toBe(503);
  });
});
