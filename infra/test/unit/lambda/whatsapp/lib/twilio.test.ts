import {
  isTwilioMessageSid,
  validateTwilioSignature,
  parseFormBody,
  reconstructWebhookUrl,
  type TwilioSecret,
} from '../../../../../lambda/whatsapp/lib/twilio';
import { createHmac } from 'node:crypto';

describe('twilio.ts — isTwilioMessageSid', () => {
  it.each([
    `SM${'a'.repeat(32)}`,
    `MM${'0'.repeat(32)}`,
    `MM${'A1b2C3d4'.repeat(4)}`,
  ])('accepts Twilio messaging SID %s', (sid) => {
    expect(isTwilioMessageSid(sid)).toBe(true);
  });

  it.each([
    `SM${'a'.repeat(31)}`,
    `SM${'a'.repeat(33)}`,
    `XX${'a'.repeat(32)}`,
    `SM${'G'.repeat(32)}`,
    ` SM${'a'.repeat(32)}`,
    `SM${'a'.repeat(32)} `,
    null,
    undefined,
    12345,
  ])('rejects %p', (value) => {
    expect(isTwilioMessageSid(value)).toBe(false);
  });
});

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

// ── Sprint 23: application-stage entries on TwilioSecret['templates'] ──

describe('twilio.ts — TwilioSecret application-stage template keys', () => {
  // The four names are a contract between three places: the seed script that
  // creates the Content resources, `buildApplicationStageMessage`'s
  // `contentTemplate`, and outbox.ts's ContentSid lookup. This suite owns the
  // type end of it — a key typo'd here compiles as an excess property error,
  // which is the only compile-time signal the lookup will ever silently miss.
  const APPLICATION_TEMPLATE_KEYS = [
    'application_update_es',
    'application_update_en',
    'application_hired_es',
    'application_hired_en',
  ] as const;

  // Placeholder ContentSids: shaped like Twilio's HX ids but deliberately not
  // hex, so nothing here can be mistaken for a real credential.
  function seededSecret(): TwilioSecret {
    return {
      accountSid: 'AC123',
      authToken: 'token',
      messagingServiceSid: 'MG123',
      templates: {
        job_alert_es: 'HXplaceholder-job-alert-es',
        application_update_es: 'HXplaceholder-application-update-es',
        application_update_en: 'HXplaceholder-application-update-en',
        application_hired_es: 'HXplaceholder-application-hired-es',
        application_hired_en: 'HXplaceholder-application-hired-en',
      },
    };
  }

  it('accepts all four keys and carries them through a JSON round trip', () => {
    // Secrets Manager stores the secret as a JSON string, so the shape the
    // Lambda reads back is always the parse of a stringify.
    const roundTripped = JSON.parse(JSON.stringify(seededSecret())) as TwilioSecret;
    for (const key of APPLICATION_TEMPLATE_KEYS) {
      expect(roundTripped.templates?.[key]).toBe(`HXplaceholder-${key.replace(/_/g, '-')}`);
    }
  });

  it('leaves the pre-existing template entries untouched', () => {
    const roundTripped = JSON.parse(JSON.stringify(seededSecret())) as TwilioSecret;
    expect(roundTripped.templates?.job_alert_es).toBe('HXplaceholder-job-alert-es');
    expect(Object.keys(roundTripped.templates ?? {})).toHaveLength(
      APPLICATION_TEMPLATE_KEYS.length + 1,
    );
  });

  it('keeps every application key OPTIONAL, which is what the fallback path needs', () => {
    // Until the seed script runs, none of these exist in the live secret.
    // sendTwilioWhatsAppMessage degrades to the `__fallback_body` content
    // variable in that case, so an un-seeded secret must remain a legal
    // TwilioSecret rather than a type error.
    const unseeded: TwilioSecret = {
      accountSid: 'AC123',
      authToken: 'token',
      messagingServiceSid: 'MG123',
      templates: {},
    };
    for (const key of APPLICATION_TEMPLATE_KEYS) {
      expect(unseeded.templates?.[key]).toBeUndefined();
    }
  });
});
