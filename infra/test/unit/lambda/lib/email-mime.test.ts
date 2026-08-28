import {
  base64Part,
  buildRawEmail,
  encodeHeaderValue,
  encodeHeaderWord,
  formatAddressHeader,
  rfc5322Date,
} from '../../../../lambda/lib/email-mime';

const FROM = 'Jale <no-reply@jaleapp.ai>';
const TO = 'employer@example.com';
const FIXED_DATE = new Date(Date.UTC(2026, 7, 28, 9, 5, 3));

function build(overrides: Partial<Parameters<typeof buildRawEmail>[0]> = {}): string {
  return buildRawEmail({
    from: FROM,
    to: TO,
    subject: 'Subject line',
    bodyText: 'Plain body',
    bodyHtml: '<p>HTML body</p>',
    date: FIXED_DATE,
    ...overrides,
  }).toString('utf8');
}

/** Everything before the first blank line. */
function headerBlock(message: string): string {
  return message.slice(0, message.indexOf('\r\n\r\n'));
}

function boundaryOf(message: string): string {
  const match = /boundary="([^"]+)"/.exec(headerBlock(message));
  if (!match) throw new Error('no multipart boundary in the header block');
  return match[1];
}

function decodePart(message: string, contentType: string): string {
  const boundary = boundaryOf(message);
  const part = message
    .split(`--${boundary}`)
    .find((chunk) => chunk.includes(`Content-Type: ${contentType}`));
  if (!part) throw new Error(`no ${contentType} part`);
  const body = part.slice(part.indexOf('\r\n\r\n') + 4).replace(/\r\n$/, '');
  return Buffer.from(body.replace(/\r\n/g, ''), 'base64').toString('utf8');
}

describe('email MIME builder', () => {
  // ── Header block shape ────────────────────────────────────────────────────

  it('emits the RFC 5322 envelope headers with CRLF line endings and a blank-line separator', () => {
    const message = build();
    const headers = headerBlock(message);

    expect(headers).toContain(`From: ${FROM}`);
    expect(headers).toContain(`To: ${TO}`);
    expect(headers).toContain('Subject: Subject line');
    expect(headers).toContain('MIME-Version: 1.0');
    expect(headers).toContain('Date: Fri, 28 Aug 2026 09:05:03 +0000');
    expect(message).toContain('\r\n\r\n');
    // No bare LF anywhere: SMTP wants CRLF and a bare LF is what breaks
    // signature canonicalisation downstream.
    expect(message.replace(/\r\n/g, '')).not.toContain('\n');
  });

  it('formats the date as RFC 5322 with a numeric zone, not the obsolete GMT token', () => {
    expect(rfc5322Date(new Date(Date.UTC(2026, 0, 1, 0, 0, 0)))).toBe('Thu, 01 Jan 2026 00:00:00 +0000');
    expect(rfc5322Date(FIXED_DATE)).not.toContain('GMT');
  });

  // ── List-Unsubscribe ──────────────────────────────────────────────────────

  it('omits both List-Unsubscribe headers when the row carries no unsubscribe URL', () => {
    const headers = headerBlock(build());
    expect(headers).not.toContain('List-Unsubscribe');
    expect(headers).not.toContain('List-Unsubscribe-Post');
  });

  it('emits the RFC 8058 pair, angle-bracketed, when the row carries an unsubscribe URL', () => {
    const url = 'https://jaleapp.ai/api/public/employer-digest/unsubscribe?token=abc.def';
    const headers = headerBlock(build({ unsubscribeUrl: url }));
    expect(headers).toContain(`List-Unsubscribe: <${url}>`);
    expect(headers).toContain('List-Unsubscribe-Post: List-Unsubscribe=One-Click');
  });

  it('refuses an unsubscribe URL that could break out of its angle brackets', () => {
    expect(() => build({ unsubscribeUrl: 'https://jaleapp.ai/x>, <https://evil.test/y' }))
      .toThrow(/email_mime_unsubscribe_url_invalid/);
  });

  // ── Configuration set ─────────────────────────────────────────────────────

  it('adds X-SES-CONFIGURATION-SET only when a configuration set is supplied', () => {
    expect(headerBlock(build())).not.toContain('X-SES-CONFIGURATION-SET');
    expect(headerBlock(build({ configurationSet: 'jale-employer-email' })))
      .toContain('X-SES-CONFIGURATION-SET: jale-employer-email');
  });

  // ── Subject encoding ──────────────────────────────────────────────────────

  it('leaves a pure-ASCII subject alone', () => {
    expect(encodeHeaderValue('No new applicants')).toBe('No new applicants');
  });

  it('RFC 2047-encodes a subject with an em dash (every English digest subject has one)', () => {
    const subject = 'No new applicants — Jale';
    const encoded = encodeHeaderValue(subject);
    expect(encoded).toMatch(/^=\?UTF-8\?B\?[A-Za-z0-9+/=]+\?=$/);
    expect(Buffer.from(/=\?UTF-8\?B\?([^?]+)\?=/.exec(encoded)![1], 'base64').toString('utf8'))
      .toBe(subject);
    expect(headerBlock(build({ subject }))).toContain(`Subject: ${encoded}`);
  });

  it('RFC 2047-encodes the accented Spanish subjects', () => {
    const subject = '3 postulantes nuevos — revise su resumen diario de Jale';
    const encoded = encodeHeaderValue(subject);
    const decoded = encoded
      .split('\r\n ')
      .map((word) => Buffer.from(/=\?UTF-8\?B\?([^?]+)\?=/.exec(word)![1], 'base64').toString('utf8'))
      .join('');
    expect(decoded).toBe(subject);
  });

  it('never emits an encoded word longer than the RFC 2047 limit, and never splits a character', () => {
    // 200 characters is DIGEST_SUBJECT_MAX; accented so every one is 2 bytes.
    const subject = 'ó'.repeat(200);
    const encoded = encodeHeaderWord(subject);
    const words = encoded.split('\r\n ');
    expect(words.length).toBeGreaterThan(1);
    for (const word of words) {
      expect(word.length).toBeLessThanOrEqual(75);
      expect(word.startsWith('=?UTF-8?B?')).toBe(true);
    }
    const decoded = words
      .map((word) => Buffer.from(/=\?UTF-8\?B\?([^?]+)\?=/.exec(word)![1], 'base64').toString('utf8'))
      .join('');
    expect(decoded).toBe(subject);
  });

  it('folds continuation encoded words with CRLF and a single space', () => {
    const encoded = encodeHeaderWord('ó'.repeat(100));
    expect(encoded).toContain('\r\n ');
    expect(encoded).not.toContain('\r\n\t');
  });

  // ── Address headers ───────────────────────────────────────────────────────

  it('keeps an ASCII From verbatim and encodes only the display name of a non-ASCII one', () => {
    expect(formatAddressHeader(FROM)).toBe(FROM);
    const formatted = formatAddressHeader('Jalé <no-reply@jaleapp.ai>');
    expect(formatted).toMatch(/^=\?UTF-8\?B\?[A-Za-z0-9+/=]+\?= <no-reply@jaleapp\.ai>$/);
  });

  it('refuses a non-ASCII address with no display-name form to hide behind', () => {
    expect(() => formatAddressHeader('nö-reply@jaleapp.ai')).toThrow(/email_mime_address_not_ascii/);
  });

  // ── Header injection ──────────────────────────────────────────────────────

  it('refuses a CR or LF in any header value rather than mailing the injected headers', () => {
    for (const injected of ['a\r\nBcc: evil@example.test', 'a\nBcc: evil@example.test']) {
      expect(() => build({ subject: injected })).toThrow(/email_mime_header_injection/);
      expect(() => build({ to: injected })).toThrow(/email_mime_header_injection/);
      expect(() => build({ from: injected })).toThrow(/email_mime_header_injection/);
    }
  });

  it('refuses an empty To or Subject', () => {
    expect(() => build({ to: '' })).toThrow(/email_mime_header_empty/);
    expect(() => build({ subject: '' })).toThrow(/email_mime_header_empty/);
  });

  // ── Body parts ────────────────────────────────────────────────────────────

  it('produces a multipart/alternative with text first, html second, both base64', () => {
    const message = build();
    const boundary = boundaryOf(message);

    expect(headerBlock(message)).toContain(`Content-Type: multipart/alternative; boundary="${boundary}"`);
    expect(message).toContain(`--${boundary}\r\nContent-Type: text/plain; charset=UTF-8`);
    expect(message).toContain('Content-Transfer-Encoding: base64');
    expect(message.endsWith(`--${boundary}--\r\n`)).toBe(true);

    // text/plain must precede text/html: RFC 2046 says the LAST renderable
    // part wins, so the order is what makes an HTML client show HTML.
    expect(message.indexOf('text/plain')).toBeLessThan(message.indexOf('text/html'));

    expect(decodePart(message, 'text/plain; charset=UTF-8')).toBe('Plain body');
    expect(decodePart(message, 'text/html; charset=UTF-8')).toBe('<p>HTML body</p>');
  });

  it('round-trips non-ASCII body content through base64 without loss', () => {
    const bodyText = 'Revise sus postulantes — “Instalación eléctrica”';
    const bodyHtml = `<p>${bodyText}</p>`;
    const message = build({ bodyText, bodyHtml });
    expect(decodePart(message, 'text/plain; charset=UTF-8')).toBe(bodyText);
    expect(decodePart(message, 'text/html; charset=UTF-8')).toBe(bodyHtml);
  });

  it('falls back to a single text/plain part when the row has no HTML body', () => {
    const message = build({ bodyHtml: null });
    expect(headerBlock(message)).toContain('Content-Type: text/plain; charset=UTF-8');
    expect(headerBlock(message)).not.toContain('multipart/alternative');
    const body = message.slice(message.indexOf('\r\n\r\n') + 4).replace(/\r\n/g, '');
    expect(Buffer.from(body, 'base64').toString('utf8')).toBe('Plain body');
  });

  it('wraps base64 at 76 characters so no line can exceed the SMTP limit', () => {
    const encoded = base64Part('x'.repeat(10_000));
    for (const line of encoded.split('\r\n')) {
      expect(line.length).toBeLessThanOrEqual(76);
    }
    expect(Buffer.from(encoded.replace(/\r\n/g, ''), 'base64').toString('utf8')).toBe('x'.repeat(10_000));
  });

  it('gives every message a fresh boundary', () => {
    expect(boundaryOf(build())).not.toBe(boundaryOf(build()));
  });
});
