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
import * as twilioSecretModule from '../../../../lambda/whatsapp/lib/twilio-secret';

const SID = `SM${'a'.repeat(32)}`;
const MM_SID = `MM${'b'.repeat(32)}`;
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

  it('accepts a signed callback with an MM-prefixed message SID', async () => {
    const result = await handler(event({ MessageSid: MM_SID, MessageStatus: 'delivered' }));
    expect(result.statusCode).toBe(200);
    expect(query).toHaveBeenCalledWith(
      expect.stringContaining('record_twilio_delivery_status'),
      [MM_SID, 'delivered', null, null],
    );
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

  // ── Review-1 correction (item 8): signed form edge cases ──────────

  it('correctly decodes percent-encoded and plus-as-space form fields under the signature', async () => {
    // Twilio's ErrorMessage can contain spaces/punctuation that
    // application/x-www-form-urlencoded encodes as '+' or %XX. The
    // signature must be computed over the RAW (undecoded) param values per
    // Twilio's spec, and parseFormBody must still decode them correctly for
    // the bounds checks and DB call.
    const errorMessage = 'rate limit exceeded: too many requests';
    const params = { MessageSid: SID, MessageStatus: 'failed', ErrorCode: '30003', ErrorMessage: errorMessage };
    const result = await handler(event(params));
    expect(result.statusCode).toBe(200);
    expect(query).toHaveBeenCalledWith(expect.any(String), [SID, 'failed', '30003', errorMessage]);
  });

  it('rejects an ErrorCode that does not match the bounded numeric format', async () => {
    const result = await handler(event({
      MessageSid: SID, MessageStatus: 'failed', ErrorCode: 'not-a-code',
    }));
    expect(result.statusCode).toBe(400);
    expect(query).not.toHaveBeenCalled();
  });

  it('rejects an ErrorMessage longer than 1000 characters', async () => {
    const result = await handler(event({
      MessageSid: SID, MessageStatus: 'failed', ErrorMessage: 'x'.repeat(1001),
    }));
    expect(result.statusCode).toBe(400);
    expect(query).not.toHaveBeenCalled();
  });

  it('rejects an undecodable base64 body without ever touching the DB', async () => {
    // Buffer.from(..., 'base64') is lenient in Node (never throws), so an
    // invalid base64 payload decodes to garbage rather than raising —
    // that garbage then fails signature validation. Either way, the
    // contract under test is: never 200, never a DB call.
    const result = await handler({
      body: '%%%not-valid-base64%%%',
      isBase64Encoded: true,
      headers: { 'x-twilio-signature': 'irrelevant' },
    } as any);
    expect(result.statusCode).not.toBe(200);
    expect(query).not.toHaveBeenCalled();
  });

  it('returns 400 for an empty body without touching the DB', async () => {
    const result = await handler({ body: '', isBase64Encoded: false, headers: {} } as any);
    expect(result.statusCode).toBe(400);
    expect(query).not.toHaveBeenCalled();
  });

  it('logs WhatsAppDeliveryFailure exactly once for a changed terminal failure', async () => {
    const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    query.mockResolvedValueOnce({ rows: [{ matched: true, changed: true, source: 'whatsapp_outbox' }] });
    await handler(event({ MessageSid: SID, MessageStatus: 'failed' }));
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('WhatsAppDeliveryFailure'));
    errorSpy.mockRestore();
  });

  it('logs WhatsAppStatusCallbackUnknownSid (not a failure metric) for an unmatched SID', async () => {
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    query.mockResolvedValueOnce({ rows: [{ matched: false, changed: false, source: null }] });
    await handler(event({ MessageSid: SID, MessageStatus: 'sent' }));
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('WhatsAppStatusCallbackUnknownSid'));
    warnSpy.mockRestore();
  });

  it('logs WhatsAppStatusCallbackError and returns 503 with zero DB access on a secret/config failure', async () => {
    const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    jest.spyOn(twilioSecretModule, 'getTwilioSecret').mockRejectedValueOnce(
      new Error('TWILIO_SECRET_ARN not set'),
    );
    const result = await handler(event({ MessageSid: SID, MessageStatus: 'sent' }));
    expect(result.statusCode).toBe(503);
    expect(query).not.toHaveBeenCalled();
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('WhatsAppStatusCallbackError'));
    errorSpy.mockRestore();
  });

  it('never touches the DB when the callback URL configuration itself is invalid', async () => {
    const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    jest.spyOn(twilioSecretModule, 'requireTwilioStatusCallbackUrl').mockImplementationOnce(() => {
      throw new Error('TWILIO_STATUS_CALLBACK_URL must be an HTTPS /whatsapp/status-callback URL');
    });
    const result = await handler(event({ MessageSid: SID, MessageStatus: 'sent' }));
    expect(result.statusCode).toBe(503);
    expect(query).not.toHaveBeenCalled();
    errorSpy.mockRestore();
  });
});
