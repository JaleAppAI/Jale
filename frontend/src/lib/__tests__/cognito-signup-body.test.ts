// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { workerSignUp } from '../cognito';

describe('workerSignUp — the signup body (K3.6)', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn(async () => ({ ok: true, status: 200, json: async () => ({}) }));
    vi.stubGlobal('fetch', fetchMock);
    vi.stubEnv('NEXT_PUBLIC_API_BASE_URL', 'https://api.example.test');
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it('carries signup_source when there is one', async () => {
    await workerSignUp({ phone: '+12100000000', signupSource: { src: 'qr', entry: 'app' } });
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.example.test/auth/worker/signup');
    expect(JSON.parse(init.body as string)).toEqual({ phone: '+12100000000', signup_source: { src: 'qr', entry: 'app' } });
  });

  it('sends the phone alone when there is none', async () => {
    await workerSignUp({ phone: '+12100000000', signupSource: null });
    await workerSignUp({ phone: '+12100000000' });
    for (const [, init] of fetchMock.mock.calls as [string, RequestInit][]) {
      expect(JSON.parse(init.body as string)).toEqual({ phone: '+12100000000' });
    }
  });
});
