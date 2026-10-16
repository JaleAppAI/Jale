// T5: old admin URLs land on the new pages with their query (FE-1 §4.6).
// Evaluates next.config.mjs's redirects() with Next's own matcher and
// destination builder (the code the server runs), so this check and a real
// request agree. The build-time proof against a running server is in the FE-1
// plan (Task 8, prod-smoke).
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { adminRoot } from './lib/check-harness.mjs';

const { default: nextConfig } = await import(pathToFileURL(resolve(adminRoot, 'next.config.mjs')).href);
assert.equal(typeof nextConfig.redirects, 'function', 'next.config.mjs defines redirects() for the old admin URLs');
const redirects = await nextConfig.redirects();
assert.deepEqual(
  redirects,
  [
    { source: '/cases', destination: '/inbox?tab=support', permanent: false },
    { source: '/cases/:id', destination: '/inbox/support/:id', permanent: false },
    {
      source: '/reports',
      has: [{ type: 'query', key: 'status', value: '(?<reportStatus>.+)' }],
      destination: '/inbox?tab=reports&reportStatus=:reportStatus',
      permanent: false,
    },
    { source: '/reports', destination: '/inbox?tab=reports', permanent: false },
    { source: '/reports/:id([0-9a-f-]{36})', destination: '/inbox/reports/:id', permanent: false },
    { source: '/verifications', destination: '/inbox?tab=lockouts', permanent: false },
    { source: '/verifications/:id', destination: '/inbox/lockouts/:id', permanent: false },
    { source: '/access-history', destination: '/security', permanent: false },
    { source: '/audit', destination: '/security', permanent: false },
  ],
  'the redirect table is FE-1 §4.6, in order, all temporary',
);

// Next's own matching (options as Next builds redirects) and destination rules.
const require = createRequire(resolve(adminRoot, 'package.json'));
const { getPathMatch } = require('next/dist/shared/lib/router/utils/path-match.js');
const { prepareDestination, matchHas } = require('next/dist/shared/lib/router/utils/prepare-destination.js');
const rules = redirects.map((rule) => ({ ...rule, match: getPathMatch(rule.source, { strict: true, removeUnnamedParams: true }) }));
const follow = (url) => {
  const parsed = new URL(url, 'http://admin.test');
  const query = Object.fromEntries(parsed.searchParams);
  for (const rule of rules) {
    const pathParams = rule.match(parsed.pathname);
    if (!pathParams) continue;
    let params = pathParams;
    if (rule.has) {
      const hasParams = matchHas({ headers: {}, cookies: {} }, query, rule.has, []);
      if (!hasParams) continue;
      params = { ...pathParams, ...hasParams };
    }
    const { parsedDestination } = prepareDestination({ appendParamsToQuery: false, destination: rule.destination, params, query });
    return { pathname: parsedDestination.pathname, query: { ...parsedDestination.query } };
  }
  return null;
};

const REPORT = '00000000-0000-4000-8000-0000000000aa';
const CASE = '00000000-0000-4000-8000-000000000001';
const SUBJECT = '00000000-0000-4000-8000-0000000000a1';
for (const [url, pathname, query] of [
  ['/cases', '/inbox', { tab: 'support' }],
  ['/cases?status=open', '/inbox', { status: 'open', tab: 'support' }],
  ['/cases?tab=reports&x=1', '/inbox', { tab: 'support', x: '1' }],
  [`/cases/${CASE}`, `/inbox/support/${CASE}`, {}],
  // K2.3 (ruled 2026-10-14): the old report `status` becomes `reportStatus`; the
  // other report params pass through. Next cannot drop a request key, so the
  // old `status` rides along; parseInboxQuery ignores it on the Reports tab
  // (reportStatus, when set, replaces the Inbox status there).
  ['/reports?status=new&role=worker', '/inbox', { tab: 'reports', reportStatus: 'new', role: 'worker', status: 'new' }],
  ['/reports?status=new&role=worker&category=billing&verified=true&number=7', '/inbox', { tab: 'reports', reportStatus: 'new', role: 'worker', category: 'billing', verified: 'true', number: '7', status: 'new' }],
  ['/reports?role=worker&before=abc', '/inbox', { role: 'worker', before: 'abc', tab: 'reports' }],
  ['/reports?status=', '/inbox', { status: '', tab: 'reports' }],
  [`/reports/${REPORT}?from=mail`, `/inbox/reports/${REPORT}`, { from: 'mail' }],
  ['/verifications', '/inbox', { tab: 'lockouts' }],
  ['/verifications/abc?x=1', '/inbox/lockouts/abc', { x: '1' }],
  [`/access-history?subject=${SUBJECT}&category=contact_details`, '/security', { subject: SUBJECT, category: 'contact_details' }],
  ['/audit', '/security', {}],
]) {
  assert.deepEqual(follow(url), { pathname, query }, `${url} lands on ${pathname} with its query`);
}
for (const url of ['/reports/settings', '/reports/settings?x=1', '/reports/abc', '/', '/inbox', '/security', '/analytics/ops', '/cases-archive']) {
  assert.equal(follow(url), null, `${url} is not redirected`);
}

// The /audit stub the redirect replaces is gone (CCR-1). verifications/[id] is
// FE-2's to delete (ruled 2026-10-14), so this check names no verifications path.
assert.ok(!Object.keys(follow('/reports?role=worker').query).includes('reportStatus'), 'no status, no reportStatus');
for (const path of ['src/app/(console)/audit/page.tsx']) {
  assert.equal(existsSync(resolve(adminRoot, path)), false, `${path} is replaced by its redirect`);
}
console.log('T5 redirects: ok');
