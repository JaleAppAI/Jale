import { describe, expect, it } from 'vitest';
import { buildLoginUrl, sanitizeReturnPath } from '../login-url';

// Built from char codes rather than escape sequences so the payloads below are
// unambiguous in the source (an invisible literal tab in a string literal is
// exactly the kind of thing that silently stops testing what it claims to).
const BACKSLASH = String.fromCharCode(92);
const TAB = String.fromCharCode(9);
const NEWLINE = String.fromCharCode(10);
const CR = String.fromCharCode(13);
const NUL = String.fromCharCode(0);
const DEL = String.fromCharCode(127);

describe('sanitizeReturnPath', () => {
  const accepted = [
    '/',
    '/en',
    '/worker/home',
    '/es/worker/home?x=1',
    '/es/employer/jobs/6f1b9f0e-0000-4000-8000-000000000000?tab=candidates&sort=score',
    '/en/legal/accept#terms',
    '/en/worker/jobs/abc?t=12:30',
  ];

  it.each(accepted)('accepts the same-origin relative path %s', (path) => {
    expect(sanitizeReturnPath(path)).toBe(path);
  });

  const rejected: Array<[string, string]> = [
    ['protocol-relative', '//evil.com'],
    ['protocol-relative with path', '//evil.com/en/worker/home'],
    ['protocol-relative triple slash', '///evil.com'],
    ['http absolute', 'http://evil.com'],
    ['https absolute', 'https://evil.com/en/worker/home'],
    ['javascript scheme', 'javascript:alert(1)'],
    ['javascript scheme uppercase', 'JavaScript:alert(1)'],
    ['data scheme', 'data:text/html,<script>alert(1)</script>'],
    ['mailto scheme', 'mailto:someone@example.com'],
    ['bare path', 'worker/home'],
    ['bare host', 'evil.com'],
    ['empty', ''],
    ['backslash host', '/' + BACKSLASH + 'evil.com'],
    ['double backslash host', BACKSLASH + BACKSLASH + 'evil.com'],
    ['backslash inside a path', '/en/worker' + BACKSLASH + BACKSLASH + 'evil.com'],
    ['tab-smuggled protocol-relative', '/' + TAB + '/evil.com'],
    ['newline-smuggled protocol-relative', '/' + NEWLINE + '/evil.com'],
    ['carriage-return-smuggled protocol-relative', '/' + CR + '/evil.com'],
    ['NUL byte', '/en/worker/home' + NUL],
    ['DEL byte', '/en/worker/home' + DEL],
  ];

  it.each(rejected)('rejects %s', (_label, payload) => {
    expect(sanitizeReturnPath(payload)).toBeNull();
  });

  it('rejects null and non-string input', () => {
    expect(sanitizeReturnPath(null)).toBeNull();
    expect(sanitizeReturnPath(undefined as unknown as string)).toBeNull();
    expect(sanitizeReturnPath(123 as unknown as string)).toBeNull();
  });

  it('rejects a path longer than 512 characters but accepts one exactly at the limit', () => {
    const atLimit = '/' + 'a'.repeat(511);
    const overLimit = '/' + 'a'.repeat(512);
    expect(atLimit).toHaveLength(512);
    expect(overLimit).toHaveLength(513);
    expect(sanitizeReturnPath(atLimit)).toBe(atLimit);
    expect(sanitizeReturnPath(overLimit)).toBeNull();
  });
});

describe('buildLoginUrl', () => {
  it('builds the plain login URL for each user type', () => {
    expect(buildLoginUrl('en', 'worker')).toBe('/en/auth/worker');
    expect(buildLoginUrl('es', 'employer')).toBe('/es/auth/employer');
  });

  it('defaults an unknown user type to the worker login', () => {
    expect(buildLoginUrl('es', null)).toBe('/es/auth/worker');
  });

  it('appends an encoded returnUrl when the return path is safe', () => {
    expect(buildLoginUrl('es', 'worker', '/es/worker/home?x=1'))
      .toBe('/es/auth/worker?returnUrl=%2Fes%2Fworker%2Fhome%3Fx%3D1');
  });

  it('round-trips the encoded returnUrl back to the original path', () => {
    const returnPath = '/es/employer/jobs/abc?tab=candidates&sort=score';
    const url = buildLoginUrl('es', 'employer', returnPath);
    const query = new URLSearchParams(url.slice(url.indexOf('?')));
    expect(query.get('returnUrl')).toBe(returnPath);
    expect(sanitizeReturnPath(query.get('returnUrl'))).toBe(returnPath);
  });

  it('drops an unsafe return path instead of embedding it', () => {
    expect(buildLoginUrl('en', 'worker', '//evil.com')).toBe('/en/auth/worker');
    expect(buildLoginUrl('en', 'worker', 'javascript:alert(1)')).toBe('/en/auth/worker');
    expect(buildLoginUrl('en', 'worker', '')).toBe('/en/auth/worker');
  });

  it('omits the query entirely when no return path is given', () => {
    expect(buildLoginUrl('en', 'employer')).toBe('/en/auth/employer');
    expect(buildLoginUrl('en', 'employer').includes('?')).toBe(false);
  });
});
