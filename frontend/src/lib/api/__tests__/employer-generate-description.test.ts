import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError, generateJobDescription } from '../employer';

function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as Response;
}

describe('generateJobDescription', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    process.env.NEXT_PUBLIC_API_BASE_URL = 'https://api.example.test';
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('POSTs to the generate-description endpoint with an auth header and the given payload', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({ description_en: 'We need an electrician...', description_es: 'Buscamos un electricista...' }),
    );

    const payload = {
      title: 'Helper needed',
      trade_category: 'electrician',
      city: 'Austin',
      state: 'TX',
      pay_min: 20,
      pay_max: 30,
      pay_interval: 'hourly',
      expected_duration: '3 months',
      shift_schedule: 'Mon-Fri, 7am-3pm',
    };

    const result = await generateJobDescription('id-token-abc', payload);

    expect(result).toEqual({
      description_en: 'We need an electrician...',
      description_es: 'Buscamos un electricista...',
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://api.example.test/employer/jobs/generate-description');
    expect(init.method).toBe('POST');
    expect(init.headers.Authorization).toBe('id-token-abc');
    expect(JSON.parse(init.body)).toEqual(payload);
  });

  it('sends only trade_category when every other field is omitted', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ description_en: 'x', description_es: 'y' }));

    await generateJobDescription('id-token-abc', { trade_category: 'plumber' });

    const [, init] = fetchMock.mock.calls[0];
    expect(JSON.parse(init.body)).toEqual({ trade_category: 'plumber' });
  });

  it('surfaces unsupported_trade_category as a typed ApiError (400)', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ error: 'unsupported_trade_category' }, 400));
    const err = await generateJobDescription('id-token-abc', { trade_category: 'other' }).catch((e) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err).toMatchObject({ code: 'unsupported_trade_category', status: 400 });
  });

  it('surfaces invalid_* validation errors as a typed ApiError (400)', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ error: 'invalid_title' }, 400));
    const err = await generateJobDescription('id-token-abc', { trade_category: 'electrician' }).catch((e) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err).toMatchObject({ code: 'invalid_title', status: 400 });
  });

  it('surfaces generation_limit_reached as a typed ApiError (429)', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ error: 'generation_limit_reached' }, 429));
    const err = await generateJobDescription('id-token-abc', { trade_category: 'electrician' }).catch((e) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err).toMatchObject({ code: 'generation_limit_reached', status: 429 });
  });

  it('surfaces generation_failed as a typed ApiError (502)', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ error: 'generation_failed' }, 502));
    const err = await generateJobDescription('id-token-abc', { trade_category: 'electrician' }).catch((e) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err).toMatchObject({ code: 'generation_failed', status: 502 });
  });

  it('surfaces a 401 as a typed ApiError', async () => {
    fetchMock.mockResolvedValue(jsonResponse({}, 401));
    const err = await generateJobDescription('id-token-abc', { trade_category: 'electrician' }).catch((e) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err).toMatchObject({ status: 401 });
  });

  it('falls back to the generate_failed code when the error body carries none', async () => {
    fetchMock.mockResolvedValue(jsonResponse({}, 500));
    const err = await generateJobDescription('id-token-abc', { trade_category: 'electrician' }).catch((e) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err).toMatchObject({ code: 'generate_failed', status: 500 });
  });
});
