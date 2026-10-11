import { afterEach, describe, expect, it, vi } from 'vitest';
import { apiPathPattern, MAX_PATTERN_LENGTH, routePattern } from '../patterns';

// Obviously fake values, built here rather than copied from anywhere real.
const JOB_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const WORKER_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const APPLICATION_ID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const UPLOAD_TOKEN = '0f'.repeat(32); // the 64-hex shape of an upload link
const JOB_CODE = 'ABC234';
const SHARE_CODE = 'XYZ23456';
const DIGEST_TOKEN = 'e1'.repeat(32);

/** Every value a pattern must never carry, whatever route it came from. */
const SECRETS = [UPLOAD_TOKEN, JOB_CODE, SHARE_CODE, DIGEST_TOKEN];

function expectNoSecrets(pattern: string) {
  for (const secret of SECRETS) expect(pattern).not.toContain(secret);
}

describe('routePattern: the dynamic routes', () => {
  // Every bracketed route under [locale], with the params useParams() gives
  // for it (locale already removed, as the report provider passes them).
  it.each([
    ['/employer/jobs/[id]', `/employer/jobs/${JOB_ID}`, { id: JOB_ID }, '/employer/jobs/:id', { id: JOB_ID }],
    [
      '/employer/workers/[worker_id]',
      `/employer/workers/${WORKER_ID}`,
      { worker_id: WORKER_ID },
      '/employer/workers/:worker_id',
      { worker_id: WORKER_ID },
    ],
    ['/j/[code]', `/j/${JOB_CODE}`, { code: JOB_CODE }, '/j/:code', {}],
    ['/upload/[token]', `/upload/${UPLOAD_TOKEN}`, { token: UPLOAD_TOKEN }, '/upload/:token', {}],
    [
      '/worker/applications/[id]',
      `/worker/applications/${APPLICATION_ID}`,
      { id: APPLICATION_ID },
      '/worker/applications/:id',
      { id: APPLICATION_ID },
    ],
    ['/worker/jobs/[id]', `/worker/jobs/${JOB_ID}`, { id: JOB_ID }, '/worker/jobs/:id', { id: JOB_ID }],
    ['/[...rest]', '/no/such/page', { rest: ['no', 'such', 'page'] }, '/:rest', {}],
  ])('%s', (_route, pathname, params, pattern, refs) => {
    expect(routePattern(pathname, params)).toEqual({ pattern, refs });
  });

  it('keeps every static page route as it is', () => {
    const staticRoutes = [
      '/',
      '/auth/employer',
      '/auth/worker',
      '/digest-unsubscribe',
      '/employer/applicants',
      '/employer/billing',
      '/employer/conversations',
      '/employer/dashboard',
      '/employer/profile',
      '/employer/templates',
      '/legal/accept',
      '/worker/applications',
      '/worker/home',
      '/worker/onboarding',
      '/worker/profile',
    ];
    for (const route of staticRoutes) {
      expect(routePattern(route, {})).toEqual({ pattern: route, refs: {} });
    }
  });
});

describe('routePattern: secret-bearing segments', () => {
  it('never keeps the upload token, even when the params are missing or wrong', () => {
    for (const params of [{}, { id: UPLOAD_TOKEN }, { token: UPLOAD_TOKEN }]) {
      const { pattern, refs } = routePattern(`/upload/${UPLOAD_TOKEN}`, params);
      expect(pattern).toBe('/upload/:token');
      expect(refs).toEqual({});
    }
  });

  it('never keeps the job code or the share code from /j/[code]?r=', () => {
    for (const params of [{}, { code: JOB_CODE }]) {
      const { pattern, refs } = routePattern(`/j/${JOB_CODE}?r=${SHARE_CODE}`, params);
      expect(pattern).toBe('/j/:code');
      expect(refs).toEqual({});
      expectNoSecrets(pattern);
    }
  });

  it('drops the digest-unsubscribe token with the rest of the query', () => {
    const { pattern } = routePattern(`/digest-unsubscribe?token=${DIGEST_TOKEN}`, {});
    expect(pattern).toBe('/digest-unsubscribe');
  });

  it('never keeps a token or code param as a ref, even one shaped like a UUID', () => {
    expect(routePattern(`/upload/${JOB_ID}`, { token: JOB_ID })).toEqual({ pattern: '/upload/:token', refs: {} });
    expect(routePattern(`/j/${JOB_ID}`, { code: JOB_ID })).toEqual({ pattern: '/j/:code', refs: {} });
  });

  it('keeps refs for UUID values only', () => {
    expect(routePattern('/worker/jobs/not-a-uuid', { id: 'not-a-uuid' })).toEqual({
      pattern: '/worker/jobs/:id',
      refs: {},
    });
  });

  it('turns a record reference into :id even without params', () => {
    expect(routePattern(`/worker/jobs/${JOB_ID}`, {})).toEqual({ pattern: '/worker/jobs/:id', refs: {} });
  });
});

describe('routePattern: input shapes', () => {
  it('ignores a stray locale param and a locale prefix it names', () => {
    expect(routePattern('/worker/home', { locale: 'es' })).toEqual({ pattern: '/worker/home', refs: {} });
    expect(routePattern(`/es/worker/jobs/${JOB_ID}`, { locale: 'es', id: JOB_ID })).toEqual({
      pattern: '/worker/jobs/:id',
      refs: { id: JOB_ID },
    });
  });

  it('normalises empty and trailing-slash paths', () => {
    expect(routePattern('', {}).pattern).toBe('/');
    expect(routePattern('/worker/home/', {}).pattern).toBe('/worker/home');
  });

  it('replaces a segment that is not a plain word', () => {
    expect(routePattern('/Some/Page2', {}).pattern).toBe('/:value/:value');
  });

  it('caps the pattern length', () => {
    const long = `/${'segment/'.repeat(60)}`;
    expect(routePattern(long, {}).pattern.length).toBeLessThanOrEqual(MAX_PATTERN_LENGTH);
  });
});

describe('apiPathPattern', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('drops the query string and the fragment', () => {
    expect(apiPathPattern('/worker/jobs?search=welder&job_type=full_time')).toBe('/worker/jobs');
    expect(apiPathPattern('/worker/profile#section')).toBe('/worker/profile');
    expect(apiPathPattern(`/pay-reference?zip=${'9'.repeat(5)}`)).toBe('/pay-reference');
  });

  it('replaces UUID segments with :id', () => {
    expect(apiPathPattern(`/employer/jobs/${JOB_ID}/applicants?stage=new`)).toBe('/employer/jobs/:id/applicants');
    expect(apiPathPattern(`/employer/jobs/${JOB_ID}/applicants/${WORKER_ID}`)).toBe(
      '/employer/jobs/:id/applicants/:id',
    );
  });

  it('replaces 64-hex segments with :token', () => {
    expect(apiPathPattern(`/documents/${UPLOAD_TOKEN}`)).toBe('/documents/:token');
  });

  it('replaces the job code after /public/jobs/ and /j/ with :code', () => {
    expect(apiPathPattern(`/public/jobs/${JOB_CODE}`)).toBe('/public/jobs/:code');
    expect(apiPathPattern(`/public/jobs/${JOB_CODE}/referrer?r=${SHARE_CODE}`)).toBe('/public/jobs/:code/referrer');
    expect(apiPathPattern(`/public/jobs/${JOB_CODE}/apply-intent?r=${SHARE_CODE}`)).toBe(
      '/public/jobs/:code/apply-intent',
    );
    expect(apiPathPattern(`/public/jobs/${JOB_CODE}/open`)).toBe('/public/jobs/:code/open');
    expect(apiPathPattern(`/j/${JOB_CODE}`)).toBe('/j/:code');
    expect(apiPathPattern('/public/jobs?limit=500&cursor=abc')).toBe('/public/jobs');
  });

  it('replaces pure digit runs with :n', () => {
    expect(apiPathPattern('/worker/posts/12345')).toBe('/worker/posts/:n');
  });

  it('keeps hyphenated and underscored route words readable', () => {
    expect(apiPathPattern('/public/employer-digest/unsubscribe')).toBe('/public/employer-digest/unsubscribe');
    expect(apiPathPattern('/worker/documents/upload-url')).toBe('/worker/documents/upload-url');
    expect(apiPathPattern('/worker/vault/driver_license')).toBe('/worker/vault/driver_license');
  });

  it('turns an alphanumeric id segment into :value', () => {
    expect(apiPathPattern('/employer/templates/tpl9x2')).toBe('/employer/templates/:value');
    expect(apiPathPattern('/employer/templates/Mixed')).toBe('/employer/templates/:value');
  });

  it('normalises an absolute URL to the API route form', () => {
    vi.stubEnv('NEXT_PUBLIC_API_BASE_URL', 'https://app.example.test/api');
    expect(apiPathPattern('https://app.example.test/api/public/reports/create')).toBe('/public/reports/create');
    expect(apiPathPattern(`https://app.example.test/api/public/jobs/${JOB_CODE}/open`)).toBe(
      '/public/jobs/:code/open',
    );
  });

  it('takes an API path as it is', () => {
    vi.stubEnv('NEXT_PUBLIC_API_BASE_URL', 'https://app.example.test/api');
    expect(apiPathPattern('/public/reports/create')).toBe('/public/reports/create');
  });

  it('strips the base path only at a segment boundary', () => {
    vi.stubEnv('NEXT_PUBLIC_API_BASE_URL', 'https://app.example.test/api');
    expect(apiPathPattern('https://app.example.test/apiary/visits')).toBe('/apiary/visits');
  });

  it('strips an origin that has no base path', () => {
    vi.stubEnv('NEXT_PUBLIC_API_BASE_URL', 'http://localhost:3001');
    expect(apiPathPattern('http://localhost:3001/worker/profile?x=1')).toBe('/worker/profile');
  });

  it('keeps the literal s3:upload verbatim', () => {
    expect(apiPathPattern('s3:upload')).toBe('s3:upload');
  });

  it('never carries a token or a code', () => {
    vi.stubEnv('NEXT_PUBLIC_API_BASE_URL', 'https://app.example.test/api');
    const urls = [
      `/public/jobs/${JOB_CODE}/referrer?r=${SHARE_CODE}`,
      `https://app.example.test/api/public/jobs/${JOB_CODE}/apply-intent?r=${SHARE_CODE}`,
      `/documents/${UPLOAD_TOKEN}/view`,
      `/public/employer-digest/unsubscribe?token=${DIGEST_TOKEN}`,
    ];
    for (const url of urls) expectNoSecrets(apiPathPattern(url));
  });

  it('caps the pattern length', () => {
    expect(apiPathPattern(`/${'word/'.repeat(80)}`).length).toBeLessThanOrEqual(MAX_PATTERN_LENGTH);
  });
});
