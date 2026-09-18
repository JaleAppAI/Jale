import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GET } from '../route';

// The business number is never hardcoded anywhere new -- including here.
// This is a syntactically valid, obviously-fake E.164 test double, never the
// real Jale WhatsApp number.
const TEST_NUMBER = '15005550006';

function request(path: string): Request {
  return new Request(`https://jaleapp.ai${path}`);
}

describe('GET /whatsapp', () => {
  let errorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    process.env.WHATSAPP_BUSINESS_NUMBER = TEST_NUMBER;
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    delete process.env.WHATSAPP_BUSINESS_NUMBER;
    errorSpy.mockRestore();
  });

  it('307-redirects to wa.me with the default (Spanish) prefilled text', async () => {
    const res = await GET(request('/whatsapp'));
    expect(res.status).toBe(307);
    expect(res.headers.get('Location')).toBe(`https://wa.me/${TEST_NUMBER}?text=Hola`);
  });

  it('uses the English prefilled text for ?lang=en', async () => {
    const res = await GET(request('/whatsapp?lang=en'));
    expect(res.headers.get('Location')).toBe(`https://wa.me/${TEST_NUMBER}?text=Hello`);
  });

  it('falls back to the default text for an unrecognized ?lang', async () => {
    const res = await GET(request('/whatsapp?lang=fr'));
    expect(res.headers.get('Location')).toBe(`https://wa.me/${TEST_NUMBER}?text=Hola`);
  });

  it('sets Cache-Control: no-store on the redirect', async () => {
    const res = await GET(request('/whatsapp'));
    expect(res.headers.get('Cache-Control')).toBe('no-store');
  });

  it('returns 500 with a plain-text body and never emits a broken wa.me URL when the env var is missing', async () => {
    delete process.env.WHATSAPP_BUSINESS_NUMBER;
    const res = await GET(request('/whatsapp'));
    expect(res.status).toBe(500);
    expect(res.headers.get('Location')).toBeNull();
    expect(res.headers.get('Content-Type')).toContain('text/plain');
    expect(errorSpy).toHaveBeenCalled();
  });

  it('returns 500 and never emits a broken wa.me URL when the env var is malformed (non-digits)', async () => {
    process.env.WHATSAPP_BUSINESS_NUMBER = '+1 555 000 6';
    const res = await GET(request('/whatsapp'));
    expect(res.status).toBe(500);
    expect(res.headers.get('Location')).toBeNull();
  });

  it('returns 500 when the env var is too short to be a real number', async () => {
    process.env.WHATSAPP_BUSINESS_NUMBER = '123';
    const res = await GET(request('/whatsapp'));
    expect(res.status).toBe(500);
  });

  it('returns 500 when the env var is too long', async () => {
    process.env.WHATSAPP_BUSINESS_NUMBER = '1234567890123456';
    const res = await GET(request('/whatsapp'));
    expect(res.status).toBe(500);
  });

  it('never logs the business number value itself on failure', async () => {
    process.env.WHATSAPP_BUSINESS_NUMBER = 'not-a-number';
    await GET(request('/whatsapp'));
    const loggedText = errorSpy.mock.calls.flat().map((v: unknown) => JSON.stringify(v)).join(' ');
    expect(loggedText).not.toContain('not-a-number');
  });
});
