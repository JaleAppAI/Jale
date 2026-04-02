import { corsHeaders } from '../../../../lambda/lib/http';

describe('HTTP Lib', () => {
  const originalEnv = process.env;

  afterAll(() => {
    process.env = originalEnv;
  });

  it('should return default origin when ALLOWED_ORIGIN not set', () => {
    delete process.env.ALLOWED_ORIGIN;
    const headers = corsHeaders();
    expect(headers['Access-Control-Allow-Origin']).toBe('http://localhost:3000');
    expect(headers['Content-Type']).toBe('application/json');
  });

  it('should return custom origin from env when ALLOWED_ORIGIN is set', () => {
    process.env.ALLOWED_ORIGIN = 'https://jale.app';
    const headers = corsHeaders();
    expect(headers['Access-Control-Allow-Origin']).toBe('https://jale.app');
  });
});
