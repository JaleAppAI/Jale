import {
  validateTwilioSignature,
  parseFormBody,
  reconstructWebhookUrl,
} from '../../../../../lambda/whatsapp/lib/twilio';
import { createHmac } from 'node:crypto';

describe('twilio.ts — validateTwilioSignature', () => {
  // Test vector derived from Twilio's documented algorithm. Any valid
  // (url, params, authToken) triple where we compute the signature ourselves
  // and verify the validator accepts it.
  const authToken = '12345678901234567890123456789012';
  const url = 'https://mycompany.com/myapp.php?foo=1&bar=2';
  const params = { Bar: 'value1', Foo: 'value2' };

  // Build the expected signature using the same algorithm as the validator
  // (this is a self-consistency check — not a cryptographic test).
  const buildExpected = (
    u: string,
    p: Record<string, string>,
    token: string,
  ): string => {
    const sorted = Object.keys(p).sort();
    const data = u + sorted.map((k) => `${k}${p[k]}`).join('');
    return createHmac('sha1', token).update(data).digest('base64');
  };

  it('accepts a correctly signed request', () => {
    const sig = buildExpected(url, params, authToken);
    expect(validateTwilioSignature(url, params, sig, authToken)).toBe(true);
  });

  it('rejects a request with no signature header', () => {
    expect(validateTwilioSignature(url, params, undefined, authToken)).toBe(false);
  });

  it('rejects a request with empty signature', () => {
    expect(validateTwilioSignature(url, params, '', authToken)).toBe(false);
  });

  it('rejects when the URL does not match', () => {
    const sig = buildExpected(url, params, authToken);
    const wrongUrl = url + '/';
    expect(validateTwilioSignature(wrongUrl, params, sig, authToken)).toBe(false);
  });

  it('rejects when a param value is tampered', () => {
    const sig = buildExpected(url, params, authToken);
    const tampered = { ...params, Bar: 'attacker-value' };
    expect(validateTwilioSignature(url, tampered, sig, authToken)).toBe(false);
  });

  it('rejects when auth token is wrong', () => {
    const sig = buildExpected(url, params, authToken);
    expect(validateTwilioSignature(url, params, sig, 'wrong-token')).toBe(false);
  });

  it('rejects when signature is the right length but wrong value', () => {
    // Use timingSafeEqual's length check — this verifies we still reject
    // signatures that happen to match in length.
    const fakeSig = Buffer.alloc(28, 'x').toString('base64');
    expect(validateTwilioSignature(url, params, fakeSig, authToken)).toBe(false);
  });

  it('sorts params alphabetically (key order should not matter)', () => {
    const sig = buildExpected(url, params, authToken);
    const reordered = { Foo: 'value2', Bar: 'value1' };
    expect(validateTwilioSignature(url, reordered, sig, authToken)).toBe(true);
  });
});

describe('twilio.ts — parseFormBody', () => {
  it('decodes a typical Twilio POST body', () => {
    const raw =
      'AccountSid=AC123&From=whatsapp%3A%2B15125551234&Body=Hola&MessageSid=SM456';
    expect(parseFormBody(raw)).toEqual({
      AccountSid: 'AC123',
      From: 'whatsapp:+15125551234',
      Body: 'Hola',
      MessageSid: 'SM456',
    });
  });

  it('handles empty body', () => {
    expect(parseFormBody('')).toEqual({});
  });

  it('decodes multiple values by taking the last one', () => {
    // URLSearchParams.entries() yields all; our impl overwrites previous keys.
    // This matches Twilio's convention (no repeated keys in practice).
    expect(parseFormBody('Body=first&Body=second')).toEqual({ Body: 'second' });
  });
});

describe('twilio.ts — reconstructWebhookUrl', () => {
  const baseCtx = {
    domainName: 'xxx.execute-api.us-east-2.amazonaws.com',
    stage: 'dev',
    path: '/dev/whatsapp/webhook',
  };

  it('reconstructs the default API Gateway URL', () => {
    expect(reconstructWebhookUrl(baseCtx, {})).toBe(
      'https://xxx.execute-api.us-east-2.amazonaws.com/dev/whatsapp/webhook',
    );
  });

  it('uses X-Forwarded-Host when present (custom domain scenario)', () => {
    expect(
      reconstructWebhookUrl(baseCtx, {
        'X-Forwarded-Host': 'api.jale.com',
      }),
    ).toBe('https://api.jale.com/dev/whatsapp/webhook');
  });

  it('handles lowercase x-forwarded-host', () => {
    expect(
      reconstructWebhookUrl(baseCtx, {
        'x-forwarded-host': 'api.jale.com',
      }),
    ).toBe('https://api.jale.com/dev/whatsapp/webhook');
  });

  it('tolerates undefined fields gracefully', () => {
    expect(reconstructWebhookUrl({}, {})).toBe('https://');
  });
});
