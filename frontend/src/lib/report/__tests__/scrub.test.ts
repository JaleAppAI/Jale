import { describe, expect, it } from 'vitest';
import { MAX_MESSAGE_LENGTH, scrubMessage } from '../scrub';

// Fictional numbers only (the 555-01xx range, and a UK number from the range
// set aside for drama), and reserved .test domains.
const PHONES = [
  '+1 (555) 010-0199',
  '(555) 010 0199',
  '555.010.0199',
  '555-010-0199',
  '5550100199',
  '+52 555 010 0142',
  '+44 20 7946 0958',
];

describe('scrubMessage', () => {
  it.each(PHONES)('replaces the phone shape %s', (phone) => {
    const out = scrubMessage(`Could not reach ${phone} today`);
    expect(out).toBe('Could not reach [phone] today');
  });

  it('leaves short numbers alone', () => {
    expect(scrubMessage('HTTP 404 after 3 tries at 12:30, 2 items')).toBe(
      'HTTP 404 after 3 tries at 12:30, 2 items',
    );
  });

  it('replaces email addresses', () => {
    expect(scrubMessage('No account for someone@example.test')).toBe('No account for [email]');
    expect(scrubMessage('first.last+tag@mail.example.test is taken')).toBe('[email] is taken');
  });

  it('replaces URLs, query strings included', () => {
    expect(scrubMessage('Failed to fetch https://app.example.test/api/worker/profile?token=abc')).toBe(
      'Failed to fetch [url]',
    );
    expect(scrubMessage('see www.example.test/path for details')).toBe('see [url] for details');
    expect(scrubMessage('Load failed: blob:https://app.example.test/0000')).toBe('Load failed: [url]');
  });

  it('replaces long digit runs, even inside a word', () => {
    expect(scrubMessage('order ref123456789 failed')).toBe('order ref[number] failed');
    expect(scrubMessage('id 12345678 not found')).not.toMatch(/\d{7}/);
  });

  it('replaces record ids and token-shaped values', () => {
    expect(scrubMessage('job aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa missing')).toBe('job [id] missing');
    expect(scrubMessage(`bad link ${'0f'.repeat(32)}`)).toBe('bad link [token]');
  });

  it('shortens a long message to the cap, and marks the cut', () => {
    const out = scrubMessage('x'.repeat(300));
    expect(out).toHaveLength(MAX_MESSAGE_LENGTH);
    expect(out.endsWith('…')).toBe(true);
    expect(MAX_MESSAGE_LENGTH).toBe(200);
  });

  it('scrubs before it shortens, so nothing is left half-cut', () => {
    const out = scrubMessage(`${'x'.repeat(190)} someone@example.test and more text after it`);
    expect(out.length).toBeLessThanOrEqual(MAX_MESSAGE_LENGTH);
    expect(out).not.toContain('@');
    expect(out).not.toContain('someone');
  });

  it('bounds the work on a huge message without leaving a value half-scrubbed', () => {
    // Nine long URLs collapse to 54 characters, so whatever sits where the
    // input is first cut (at 1000) would otherwise reach the output. The
    // phone starts at 993: the cut leaves "555 010", too short to look like
    // a phone on its own.
    const filler = `https://app.example.test/${'a'.repeat(75)} `.repeat(9);
    const pad = `${'p'.repeat(993 - filler.length - 1)} `;
    expect(filler.length + pad.length).toBe(993);
    const out = scrubMessage(`${filler}${pad}555 010 0199 ${'y '.repeat(5000)}`);
    expect(out.length).toBeLessThanOrEqual(MAX_MESSAGE_LENGTH);
    expect(out).toContain('[url]');
    expect(out).not.toMatch(/555|010/);
  });

  it('collapses whitespace and line breaks', () => {
    expect(scrubMessage('  line one\n\n\tline two  ')).toBe('line one line two');
  });

  it('never splits a surrogate pair at the cut', () => {
    // "x", not a hex letter: a long hex-only run would be scrubbed as a token.
    const out = scrubMessage(`${'x'.repeat(198)}😀😀😀`);
    expect(out).toBe(`${'x'.repeat(198)}…`);
    expect(out.length).toBeLessThanOrEqual(MAX_MESSAGE_LENGTH);
    const beforeEllipsis = out.charCodeAt(out.length - 2);
    expect(beforeEllipsis >= 0xd800 && beforeEllipsis <= 0xdbff).toBe(false);
  });

  it('returns an empty string for anything that is not a string', () => {
    expect(scrubMessage(undefined)).toBe('');
    expect(scrubMessage({ phone: '5550100199' })).toBe('');
  });
});

/**
 * Credentials that are not phone-, email- or URL-shaped. Nothing in the app
 * puts one into an error message today; these guard the promise that
 * passwords and codes are never sent, whatever a dependency or the browser
 * writes into a message. Every value is generated at runtime: none is a
 * literal in this file.
 */
describe('scrubMessage: credentials of other shapes', () => {
  const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

  /** Random characters from `alphabet`, regenerated until it holds a letter and a digit. */
  function randomMixed(length: number, alphabet = ALPHABET): string {
    for (;;) {
      const bytes = crypto.getRandomValues(new Uint8Array(length));
      const value = Array.from(bytes, (b) => alphabet[b % alphabet.length]).join('');
      if (/[A-Za-z]/.test(value) && /\d/.test(value)) return value;
    }
  }
  const hex = (length: number) => randomMixed(length, '0123456789abcdef');

  it('replaces the value of a name=value credential, and keeps the name', () => {
    const value = randomMixed(10);
    for (const name of ['password', 'access_token', 'client_secret', 'api_key', 'session', 'code']) {
      const out = scrubMessage(`Request rejected: ${name}=${value}`);
      expect(out).not.toContain(value);
      expect(out).toContain(name);
    }
    const spaced = scrubMessage(`Header X-Api-Key: ${value} was refused`);
    expect(spaced).not.toContain(value);
    expect(spaced).toContain('was refused');
  });

  it('replaces a quoted value whole, past an escaped quote, in plain text and in JSON', () => {
    const head = randomMixed(8);
    const tail = randomMixed(8);
    for (const message of [
      `Request rejected: password="${head}\\" ${tail}" was refused`,
      `Request rejected: {"password":"${head}\\"${tail}","n":1} was refused`,
      `Request rejected: password='${head}\\' ${tail}' was refused`,
    ]) {
      const out = scrubMessage(message);
      expect(out).not.toContain(head);
      expect(out).not.toContain(tail);
      expect(out).toContain('password');
      expect(out).toContain('was refused');
    }
  });

  it('replaces a quoted value whole when an address or a query ends just before its escaped quote', () => {
    const tail = randomMixed(8);
    for (const message of [
      `Request rejected: password="https://example.invalid/\\" ${tail}" was refused`,
      `Request rejected: {"token":"https://example.invalid/a\\"${tail}","n":1} was refused`,
      `Request rejected: code="/callback?state=x\\" ${tail}" was refused`,
    ]) {
      const out = scrubMessage(message);
      expect(out).not.toContain(tail);
      expect(out).toContain('was refused');
    }
  });

  it('replaces an unterminated quoted value to the end of the message', () => {
    const head = randomMixed(8);
    const tail = randomMixed(8);
    for (const quote of ['"', "'"]) {
      const out = scrubMessage(`Request rejected: password=${quote}${head} ${tail}`);
      expect(out).not.toContain(head);
      expect(out).not.toContain(tail);
      expect(out).toBe('Request rejected: password=[redacted]');
    }
  });

  it('replaces a token in the shape of an attach token, which does not start like a sign-in token', () => {
    const token = randomMixed(43);
    expect(scrubMessage(`attach refused for ${token} today`)).toBe('attach refused for [token] today');
  });

  it('replaces a run of hex shorter than 32 characters, and one glued to a word', () => {
    const short = hex(16);
    expect(scrubMessage(`session ${short} expired`)).toBe('session [token] expired');
    const glued = hex(32);
    const out = scrubMessage(`bad key_${glued} given`);
    expect(out).not.toContain(glued);
    expect(out).toContain('bad key_');
  });

  it('replaces the query and fragment of a relative address, and keeps the path', () => {
    const value = randomMixed(12);
    expect(scrubMessage(`Failed to load /reports/attach?token=${value}&n=1`)).toBe('Failed to load /reports/attach?[query]');
    expect(scrubMessage(`Callback /auth/done#access_token=${value}`)).toBe('Callback /auth/done#[query]');
  });

  it('replaces every part of a sign-in token, all five of an encrypted one', () => {
    const parts = Array.from({ length: 5 }, () => randomMixed(12));
    const out = scrubMessage(`token eyJ${parts.join('.')} rejected`);
    for (const part of parts) expect(out).not.toContain(part);
    expect(out).toBe('token [token] rejected');
  });

  it('replaces the credential after Bearer or Basic, a short one included', () => {
    const value = randomMixed(12);
    expect(scrubMessage(`Authorization was Bearer ${value}`)).not.toContain(value);
    expect(scrubMessage(`sent Basic ${value}`)).not.toContain(value);
    const header = scrubMessage(`Authorization: Bearer ${value} was refused`);
    expect(header).not.toContain(value);
    expect(header).toContain('was refused');
  });

  it('keeps the messages that say what went wrong', () => {
    for (const message of [
      'ChunkLoadError: Loading chunk app-pages-internals failed.',
      "TypeError: Cannot read properties of undefined (reading 'map')",
      'ResizeObserver loop completed with undelivered notifications.',
      'Failed to load /worker/jobs/:id/apply',
      '500 internal',
      'image_decode_failed',
    ]) {
      expect(scrubMessage(message)).toBe(message);
    }
  });
});
