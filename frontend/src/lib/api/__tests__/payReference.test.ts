import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../errors';
import { getPayReference } from '../payReference';

function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as Response;
}

const REFERENCE_BODY = {
  trade_category: 'electrician',
  p25_hourly: 24.37,
  p50_hourly: 28.44,
  p75_hourly: 36.12,
  area_kind: 'metro',
  area_label: 'Austin',
  source_tier: 'metro',
  data_vintage: '2024',
};

describe('getPayReference', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    process.env.NEXT_PUBLIC_API_BASE_URL = 'https://api.example.test';
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('GETs /pay-reference with trade + city_key query params and an auth header', async () => {
    fetchMock.mockResolvedValue(jsonResponse(REFERENCE_BODY));

    const result = await getPayReference('id-token-abc', 'electrician', 'austin-tx');

    expect(result.area_label).toBe('Austin');
    expect(result.p50_hourly).toBe(28.44);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://api.example.test/pay-reference?trade=electrician&city_key=austin-tx');
    expect(init.headers.Authorization).toBe('id-token-abc');
  });

  it('URL-encodes a city_key that needs it', async () => {
    fetchMock.mockResolvedValue(jsonResponse(REFERENCE_BODY));
    await getPayReference('id-token-abc', 'electrician', 'austin tx/1');
    const [url] = fetchMock.mock.calls[0];
    expect(url).toBe('https://api.example.test/pay-reference?trade=electrician&city_key=austin+tx%2F1');
  });

  it('surfaces invalid_trade as a typed ApiError (400)', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ error: 'invalid_trade' }, 400));
    const err = await getPayReference('id-token-abc', 'bogus', 'austin-tx').catch((e) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err).toMatchObject({ code: 'invalid_trade', status: 400, message: 'invalid_trade' });
  });

  it('surfaces invalid_city_key as a typed ApiError (400)', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ error: 'invalid_city_key' }, 400));
    const err = await getPayReference('id-token-abc', 'electrician', 'bogus').catch((e) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err).toMatchObject({ code: 'invalid_city_key', status: 400 });
  });

  it('surfaces no_reference as a typed ApiError (404), including for trade "other"', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ error: 'no_reference' }, 404));
    const err = await getPayReference('id-token-abc', 'other', 'austin-tx').catch((e) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err).toMatchObject({ code: 'no_reference', status: 404 });
  });

  it('falls back to the pay_reference_failed code when the error body carries none', async () => {
    fetchMock.mockResolvedValue(jsonResponse({}, 500));
    const err = await getPayReference('id-token-abc', 'electrician', 'austin-tx').catch((e) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err).toMatchObject({ code: 'pay_reference_failed', status: 500 });
  });

  it('forwards an AbortSignal to fetch', async () => {
    fetchMock.mockResolvedValue(jsonResponse(REFERENCE_BODY));
    const controller = new AbortController();
    await getPayReference('id-token-abc', 'electrician', 'austin-tx', controller.signal);
    const [, init] = fetchMock.mock.calls[0];
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });
});
