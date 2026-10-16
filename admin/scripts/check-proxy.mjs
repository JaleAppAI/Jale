// Runs src/proxy.ts through the harness (contract K1.3): the proxy forwards
// the requested path and query to the page as `x-admin-next`, always its own
// value and never the client's, and the sign-in redirect for a request with
// no session cookie keeps the query inside `next` only. The proxy stays a
// presence-only check: a cookie of any value passes through.
import assert from 'node:assert/strict';
import { compileAdminSources } from './lib/check-harness.mjs';

const { load } = compileAdminSources({
  name: 'proxy',
  sources: ['src/proxy.ts'],
  fakes: {
    'next/server': 'scripts/fakes/next-server.mjs',
  },
});

delete process.env.ADMIN_PREVIEW_ROLE;
delete process.env.ADMIN_ALLOW_LOCAL_PREVIEW;

const { proxy, config } = await load('src/proxy.ts');
const COOKIE = 'jale_admin_id_token_v2';

class FakeNextUrl extends URL {
  clone() {
    return new FakeNextUrl(this.href);
  }
}

function request(path, { cookie, headers = {} } = {}) {
  return {
    nextUrl: new FakeNextUrl(`https://admin.example.test${path}`),
    headers: new Headers(headers),
    cookies: {
      get: (name) => (cookie !== undefined && name === COOKIE ? { name, value: cookie } : undefined),
    },
  };
}

function forwarded(response) {
  assert.equal(response.redirectTo, undefined, 'the request is passed on, not redirected');
  assert.ok(response.requestHeaders instanceof Headers, 'the proxy forwards its own request headers');
  return response.requestHeaders;
}

// A signed-in request: the page gets the path and query as x-admin-next.
{
  const headers = forwarded(proxy(request('/cases?status=open&page=2', {
    cookie: 'raw-session-token',
    headers: { 'user-agent': 'check-browser', accept: 'text/html' },
  })));
  assert.equal(headers.get('x-admin-next'), '/cases?status=open&page=2');
  assert.equal(headers.get('user-agent'), 'check-browser', 'the other request headers are kept');
  assert.equal(headers.get('accept'), 'text/html');
}

// A client-supplied x-admin-next is always overwritten.
{
  const headers = forwarded(proxy(request('/analytics', {
    cookie: 'raw-session-token',
    headers: { 'x-admin-next': '//evil.example/steal' },
  })));
  assert.equal(headers.get('x-admin-next'), '/analytics');
}
{
  const headers = forwarded(proxy(request('/login?next=%2Fcases', {
    headers: { 'x-admin-next': '//evil.example/steal' },
  })));
  assert.equal(headers.get('x-admin-next'), '/login?next=%2Fcases', 'public paths carry the proxy\'s value too');
}

// The value is passed through safeNextPath: a path the browser sends as
// '//host' is never forwarded as an off-site target.
{
  const headers = forwarded(proxy(request('//evil.example/x', { cookie: 'raw-session-token' })));
  assert.equal(headers.get('x-admin-next'), '/');
}

// No session cookie: to sign-in, with the path and query in `next` and no
// other parameter copied over.
{
  const response = proxy(request('/cases?status=open&page=2'));
  assert.equal(response.status, 307);
  const target = new URL(response.redirectTo);
  assert.equal(target.origin, 'https://admin.example.test');
  assert.equal(target.pathname, '/login');
  assert.deepEqual([...target.searchParams.entries()], [['next', '/cases?status=open&page=2']]);
}
{
  const response = proxy(request('/security'));
  assert.deepEqual([...new URL(response.redirectTo).searchParams.entries()], [['next', '/security']]);
}

// Presence only: an empty cookie value is no cookie, and any non-empty value
// passes (the page's requireAdminSession() is the real check).
{
  assert.ok(proxy(request('/cases', { cookie: '' })).redirectTo, 'an empty cookie value redirects');
  assert.equal(proxy(request('/cases', { cookie: 'anything' })).redirectTo, undefined);
}

// The public prefixes pass without a cookie.
for (const path of ['/login', '/api/session', '/_next/static/chunk', '/favicon.ico']) {
  forwarded(proxy(request(path)));
}

// The local preview (development only) passes without a cookie.
{
  const original = { ...process.env };
  process.env.NODE_ENV = 'development';
  process.env.ADMIN_ALLOW_LOCAL_PREVIEW = 'true';
  process.env.ADMIN_PREVIEW_ROLE = 'admin_ops';
  try {
    assert.equal(forwarded(proxy(request('/cases?x=1'))).get('x-admin-next'), '/cases?x=1');
  } finally {
    for (const key of ['NODE_ENV', 'ADMIN_ALLOW_LOCAL_PREVIEW', 'ADMIN_PREVIEW_ROLE']) {
      if (original[key] === undefined) delete process.env[key];
      else process.env[key] = original[key];
    }
  }
}

assert.deepEqual(config.matcher, ['/((?!.*\\..*).*)'], 'the matcher is unchanged');

console.log('admin proxy checks passed');
