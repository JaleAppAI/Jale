import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { updateWorkerProfile, type WorkerProfilePatch } from '../worker';

/**
 * F7 (sprint 24): `updateWorkerProfile` sends the app locale as an explicit
 * `lang` body field.
 *
 * The lambda's `resolveTradeLang`
 * (infra/lambda/api/worker-profile-update.ts) picks the language for the
 * CANONICALISED custom trade text it stores, preferring an explicit `lang`
 * over `Accept-Language`. It documented the web client as the body-field
 * sender, but the client sent only the patch -- so every save fell through to
 * the header. That happened to work (`apiFetch`'s `appLocaleHeader` sends the
 * same prefix), but it left the documented contract unenforced and one
 * caller-supplied `Accept-Language` away from storing the wrong language.
 *
 * vitest.config.mts runs this suite in the 'node' environment, which has no
 * `window`; each case installs the minimal `window.location.pathname` the
 * locale read needs, the same way frontend/src/lib/__tests__/api.test.ts
 * does for `appLocaleHeader`.
 */

const TOKEN = 'id-token';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

let fetchMock: ReturnType<typeof vi.fn>;

/** The parsed request body of the Nth `fetch` call. */
function sentBody(index = 0): Record<string, unknown> {
  const init = fetchMock.mock.calls[index][1] as RequestInit;
  return JSON.parse(init.body as string) as Record<string, unknown>;
}

beforeEach(() => {
  fetchMock = vi.fn(async () => jsonResponse({ id: 'w-1', phone: '+15550000000' }));
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('updateWorkerProfile — lang', () => {
  it('sends lang "en" on an /en/... path', async () => {
    vi.stubGlobal('window', { location: { pathname: '/en/worker/profile' } });

    await updateWorkerProfile(TOKEN, { main_trade: 'other', main_trade_other: 'Drywall taper' });

    expect(sentBody().lang).toBe('en');
  });

  it('sends lang "es" on an /es/... path', async () => {
    vi.stubGlobal('window', { location: { pathname: '/es/worker/profile' } });

    await updateWorkerProfile(TOKEN, { main_trade: 'other', main_trade_other: 'Tablarroquero' });

    expect(sentBody().lang).toBe('es');
  });

  it('recognises the locale only as the FIRST path segment, and treats a bare /en as one', async () => {
    // The lookahead in the prefix regex is what makes `/en` (no trailing
    // slash) a locale and `/legal/es/terms` not one.
    vi.stubGlobal('window', { location: { pathname: '/en' } });
    await updateWorkerProfile(TOKEN, {});
    expect(sentBody(0).lang).toBe('en');

    vi.stubGlobal('window', { location: { pathname: '/legal/es/terms' } });
    await updateWorkerProfile(TOKEN, {});
    expect(sentBody(1).lang).toBe('es');
  });

  it("falls back to 'es' when there is no window at all (server-side)", async () => {
    await updateWorkerProfile(TOKEN, {});

    expect(sentBody().lang).toBe('es');
  });

  it('leaves the rest of the patch verbatim and does not rewrite the request', async () => {
    // `lang` is ADDED, never a rewrite: nobody should later read this change
    // as "the client now edits the body on its way out". Also proves the
    // patch's own keys survive, including the ones the lambda validates
    // by presence (`skills: []` clears the list).
    vi.stubGlobal('window', { location: { pathname: '/es/worker/profile' } });
    const patch: WorkerProfilePatch = {
      full_name: 'David C',
      skills: [],
      availability: 'full_time',
      years_experience: 5,
      has_transportation: true,
      certifications: ['OSHA 10'],
      latitude: 41.85,
      longitude: -87.65,
      location_source: 'geocoded_zip',
    };

    await updateWorkerProfile(TOKEN, patch);

    expect(sentBody()).toEqual({ ...patch, lang: 'es' });
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toContain('/worker/profile');
    expect(init.method).toBe('PATCH');
  });

  it('never sends a lang the lambda would reject with invalid_lang', async () => {
    // The lambda accepts only 'en' | 'es' (VALID_LANGS); anything else is a
    // 400 that would break every profile save from an unexpected path.
    for (const pathname of ['/fr/worker/profile', '/', '/worker/profile', '/english/x', '/ens/x']) {
      fetchMock.mockClear();
      vi.stubGlobal('window', { location: { pathname } });
      await updateWorkerProfile(TOKEN, {});
      expect(['en', 'es']).toContain(sentBody().lang);
    }
  });
});
