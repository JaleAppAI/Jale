import type { APIGatewayProxyEvent } from 'aws-lambda';
import { corsHeaders, getHeader } from '../../../../lambda/lib/http';

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
    expect(headers['Access-Control-Allow-Headers']).toContain('Idempotency-Key');
  });

  it('should return custom origin from env when ALLOWED_ORIGIN is set', () => {
    process.env.ALLOWED_ORIGIN = 'https://jale.app';
    const headers = corsHeaders();
    expect(headers['Access-Control-Allow-Origin']).toBe('https://jale.app');
  });
});

describe('getHeader', () => {
  const makeEvent = (headers: Record<string, string>): APIGatewayProxyEvent =>
    ({ headers }) as unknown as APIGatewayProxyEvent;

  it('finds a header by its exact key casing', () => {
    expect(getHeader(makeEvent({ 'User-Agent': 'Mozilla/5.0' }), 'User-Agent')).toBe('Mozilla/5.0');
  });

  it('finds a header case-insensitively (API Gateway does not guarantee casing)', () => {
    expect(getHeader(makeEvent({ 'user-agent': 'Mozilla/5.0' }), 'User-Agent')).toBe('Mozilla/5.0');
    expect(getHeader(makeEvent({ 'USER-AGENT': 'Mozilla/5.0' }), 'user-agent')).toBe('Mozilla/5.0');
  });

  it('returns undefined when the header is absent', () => {
    expect(getHeader(makeEvent({}), 'Accept-Language')).toBeUndefined();
  });

  it('returns undefined when event.headers itself is missing', () => {
    const event = {} as unknown as APIGatewayProxyEvent;
    expect(getHeader(event, 'User-Agent')).toBeUndefined();
  });
});
