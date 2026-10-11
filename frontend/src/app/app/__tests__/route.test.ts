import { describe, expect, it } from 'vitest';
import { GET } from '../route';

const JOB_ID = '3fa85f64-5717-4562-b3fc-2c963f66afa6';

function request(path: string, cookie?: string, origin = 'https://jaleapp.ai'): Request {
  return new Request(`${origin}${path}`, cookie ? { headers: { cookie } } : undefined);
}

/** Every /app response is the same uncached 307; only its Location varies. */
async function locationFor(path: string, cookie?: string, origin?: string): Promise<string> {
  const res = await GET(request(path, cookie, origin));
  expect(res.status).toBe(307);
  expect(res.headers.get('Cache-Control')).toBe('no-store');
  const location = res.headers.get('Location');
  expect(location).not.toBeNull();
  return location as string;
}

describe('GET /app', () => {
  describe('locale', () => {
    it('307-redirects to the Spanish worker sign-up by default', async () => {
      expect(await locationFor('/app')).toBe('/es/auth/worker?step=signup');
    });

    it('uses English for ?lang=en', async () => {
      expect(await locationFor('/app?lang=en')).toBe('/en/auth/worker?step=signup');
    });

    it('uses Spanish for ?lang=es', async () => {
      expect(await locationFor('/app?lang=es')).toBe('/es/auth/worker?step=signup');
    });

    it('falls back to Spanish for an unsupported ?lang', async () => {
      expect(await locationFor('/app?lang=fr')).toBe('/es/auth/worker?step=signup');
    });

    it('matches ?lang strictly (no case folding)', async () => {
      expect(await locationFor('/app?lang=EN')).toBe('/es/auth/worker?step=signup');
    });

    it('honours a NEXT_LOCALE=en cookie the visitor already chose on the site', async () => {
      expect(await locationFor('/app', 'NEXT_LOCALE=en')).toBe('/en/auth/worker?step=signup');
    });

    it('finds NEXT_LOCALE among other cookies', async () => {
      expect(await locationFor('/app', 'jale-theme=dark; NEXT_LOCALE=en; other=1')).toBe(
        '/en/auth/worker?step=signup',
      );
    });

    it('ignores a NEXT_LOCALE cookie that is not exactly en or es', async () => {
      expect(await locationFor('/app', 'NEXT_LOCALE=xx')).toBe('/es/auth/worker?step=signup');
      expect(await locationFor('/app', 'NEXT_LOCALE=EN')).toBe('/es/auth/worker?step=signup');
    });

    it('matches the cookie name exactly', async () => {
      expect(await locationFor('/app', 'XNEXT_LOCALE=en')).toBe('/es/auth/worker?step=signup');
    });

    it('lets ?lang=es beat a NEXT_LOCALE=en cookie', async () => {
      expect(await locationFor('/app?lang=es', 'NEXT_LOCALE=en')).toBe('/es/auth/worker?step=signup');
    });

    it('lets ?lang=en beat a NEXT_LOCALE=es cookie', async () => {
      expect(await locationFor('/app?lang=en', 'NEXT_LOCALE=es')).toBe('/en/auth/worker?step=signup');
    });

    it('falls through an unsupported ?lang to the cookie, not straight to the default', async () => {
      expect(await locationFor('/app?lang=fr', 'NEXT_LOCALE=en')).toBe('/en/auth/worker?step=signup');
    });
  });

  describe('job', () => {
    it('keeps a valid job id', async () => {
      expect(await locationFor(`/app?job=${JOB_ID}`)).toBe(
        `/es/auth/worker?step=signup&job=${JOB_ID}`,
      );
    });

    it('keeps the job id exactly as given (case preserved)', async () => {
      const upper = JOB_ID.toUpperCase();
      expect(await locationFor(`/app?job=${upper}`)).toBe(`/es/auth/worker?step=signup&job=${upper}`);
    });

    it.each(['not-a-uuid', '//evil.com', `/worker/jobs/${JOB_ID}`, `${JOB_ID}x`, ''])(
      'drops a malformed job id %j',
      async (job) => {
        expect(await locationFor(`/app?job=${encodeURIComponent(job)}`)).toBe('/es/auth/worker?step=signup');
      },
    );
  });

  describe('share code', () => {
    it('normalises ?share=abcd-efgh and keeps it', async () => {
      expect(await locationFor('/app?share=abcd-efgh')).toBe('/es/auth/worker?step=signup&share=ABCDEFGH');
    });

    it('normalises a JALE-prefixed share code', async () => {
      expect(await locationFor('/app?share=JALE-ABCD-EFGH')).toBe(
        '/es/auth/worker?step=signup&share=ABCDEFGH',
      );
    });

    it('accepts the ?r= alias that public share URLs use', async () => {
      expect(await locationFor('/app?r=abcd-efgh')).toBe('/es/auth/worker?step=signup&share=ABCDEFGH');
    });

    it('lets ?share beat ?r when both are valid', async () => {
      expect(await locationFor('/app?share=abcd-efgh&r=jkmn-pqrs')).toBe(
        '/es/auth/worker?step=signup&share=ABCDEFGH',
      );
      expect(await locationFor('/app?r=jkmn-pqrs&share=abcd-efgh')).toBe(
        '/es/auth/worker?step=signup&share=ABCDEFGH',
      );
    });

    it('drops an invalid share code', async () => {
      // Six characters after normalising: one short of a share code.
      expect(await locationFor('/app?share=abc-123')).toBe('/es/auth/worker?step=signup');
      // U is outside the alphabet and is never rewritten.
      expect(await locationFor('/app?r=ABCDEFGU')).toBe('/es/auth/worker?step=signup');
    });

    // Decision: the first of share, r that normalises to a valid code wins.
    // An empty or garbled `share` therefore cannot cancel a good `r`.
    it('falls back to a valid ?r when ?share is empty or invalid', async () => {
      expect(await locationFor('/app?share=&r=abcd-efgh')).toBe('/es/auth/worker?step=signup&share=ABCDEFGH');
      expect(await locationFor('/app?share=nope&r=abcd-efgh')).toBe(
        '/es/auth/worker?step=signup&share=ABCDEFGH',
      );
    });
  });

  describe('everything else', () => {
    it('drops returnUrl, utm_* and unknown params', async () => {
      expect(
        await locationFor('/app?returnUrl=%2Fes%2Fworker%2Fprofile&utm_source=flyer&utm_medium=qr&foo=bar'),
      ).toBe('/es/auth/worker?step=signup');
    });

    it('never forwards lang itself', async () => {
      expect(await locationFor('/app?lang=en')).not.toContain('lang=');
    });

    it('emits step, job, share in that order and nothing else', async () => {
      expect(
        await locationFor(`/app?utm_source=qr&r=abcd-efgh&lang=en&job=${JOB_ID}&returnUrl=%2Fx`),
      ).toBe(`/en/auth/worker?step=signup&job=${JOB_ID}&share=ABCDEFGH`);
    });

    it('returns an empty body', async () => {
      const res = await GET(request('/app'));
      expect(await res.text()).toBe('');
    });
  });

  // Behind CloudFront the origin sees the Lambda Function URL host, not
  // jaleapp.ai, so an absolute Location built from request.url would send
  // every visitor to the raw Lambda URL. Only a relative one is correct.
  describe('Location is always relative', () => {
    it.each([
      '/app',
      '/app?lang=en',
      `/app?job=${JOB_ID}&share=abcd-efgh`,
      '/app?job=%2F%2Fevil.com',
      '/app?job=https%3A%2F%2Fevil.com',
      '/app?share=https%3A%2F%2Fevil.com',
      '/app?r=%2F%2Fevil.com',
      '/app?returnUrl=https%3A%2F%2Fevil.com',
      '/app?returnUrl=%2F%2Fevil.com',
      '/app?lang=%2F%2Fevil.com',
      '/app?lang=https%3A%2F%2Fevil.com',
    ])('for %s', async (path) => {
      const location = await locationFor(path, undefined, 'https://abc123.lambda-url.us-east-2.on.aws');
      expect(location).toMatch(/^\/(en|es)\/auth\/worker\?/);
      expect(location).not.toContain('//');
      expect(location).not.toMatch(/^[a-z][a-z\d+.-]*:/i);
      expect(location).not.toContain('lambda-url');
      expect(location).not.toContain('jaleapp.ai');
      expect(location).not.toContain('evil');
    });
  });
});
