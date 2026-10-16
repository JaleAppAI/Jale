// Checks two sprint 28 step-0 contract stubs.
//
// 1. The API routes (api/admin-users, api/inbox-actions) resolve the session
//    through the K1.3 helpers: no cookie answers 401 `unauthorized`, a cookie
//    whose session has ended answers 401 `session_expired`, and a signed-in
//    admin reaches the built route: the admin-users route (BE-1) and the Inbox
//    actions (BE-2b) both answer an empty body 400 `invalid_input`.
//    The real session.ts runs against fakes for next/*, the token verifier,
//    the pool, the Logs client and the Cognito admin API.
// 2. The K2.6 lockout reset reasons live in a client-safe module that imports
//    nothing, and lib/server/admin-lockouts.ts re-exports the same values.
import assert from 'node:assert/strict';
import { compileAdminSources, createFakePool, fakeUuid } from './lib/check-harness.mjs';
import { read } from './lib/ui-contract-helpers.mjs';

const ROUTES = ['src/app/api/admin-users/route.ts', 'src/app/api/inbox-actions/route.ts'];

const { load } = compileAdminSources({
  name: 'contract-stubs',
  sources: [
    ...ROUTES,
    'src/lib/server/session.ts',
    'src/lib/server/admin-lockouts.ts',
    'src/lib/lockout-reasons.ts',
  ],
  fakes: {
    'src/lib/server/db.ts': 'scripts/fakes/db.mjs',
    '@aws-sdk/client-cloudwatch-logs': 'scripts/fakes/cloudwatch-logs.mjs',
    '@aws-sdk/client-cognito-identity-provider': 'scripts/fakes/cognito-idp.mjs',
    'next/headers': 'scripts/fakes/next-headers.mjs',
    'next/server': 'scripts/fakes/next-server.mjs',
    'next/navigation': 'scripts/fakes/next-navigation.mjs',
    'aws-jwt-verify': 'scripts/fakes/aws-jwt-verify.mjs',
  },
});

process.env.AUDIT_FALLBACK_LOG_GROUP = 'audit-fallback-check-group';
// The local preview session must never stand in for a real one here.
delete process.env.ADMIN_PREVIEW_ROLE;
delete process.env.ADMIN_ALLOW_LOCAL_PREVIEW;

const check = (globalThis.__adminCheck = { cookies: new Map() });
const COOKIE = 'jale_admin_id_token_v2';
const ADMIN_ID = fakeUuid(0xe1);
const SESSION_ID = fakeUuid(0xe2);

function sessionDb(row) {
  return createFakePool({
    respond: ({ sql }) => {
      if (sql.includes('FROM admin_sessions s')) return { rows: row ? [row] : [] };
      if (sql.startsWith("UPDATE admin_sessions SET revoked_at = NOW(), revoke_reason = 'expired'")) {
        return { rows: [{ id: SESSION_ID }] };
      }
      return {};
    },
  });
}

function sessionRow(overrides = {}) {
  return {
    session_id: SESSION_ID,
    admin_user_id: ADMIN_ID,
    cognito_sub: 'check-admin-sub',
    admin_email: 'check-admin',
    role: 'admin_ops',
    expires_at: new Date(Date.now() + 30 * 60 * 1000),
    active: true,
    ...overrides,
  };
}

// The 401 is a web Response (adminApiUnauthorized); the 501 is the
// NextResponse fake, which carries its JSON on `body`.
async function bodyOf(response) {
  return typeof response.json === 'function' ? response.json() : response.body;
}

// What a signed-in admin's empty POST reaches on each route.
const SIGNED_IN = {
  'src/app/api/admin-users/route.ts': [400, { ok: false, error: 'invalid_input' }],
  'src/app/api/inbox-actions/route.ts': [400, { ok: false, error: 'invalid_input' }],
};
const emptyPost = () => new Request('https://admin.example.test/api/check', {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
});

for (const path of ROUTES) {
  const route = await load(path);

  // No cookie at all: unauthorized.
  check.cookies = new Map();
  check.pool = sessionDb(null).pool;
  {
    const response = await route.POST(emptyPost());
    assert.equal(response.status, 401, `${path}: no cookie should be a 401`);
    assert.deepEqual(await bodyOf(response), { error: 'unauthorized' }, `${path}: no cookie should be unauthorized`);
  }

  // A cookie whose session has ended: session_expired, not unauthorized.
  check.cookies = new Map([[COOKIE, 'raw-session-token']]);
  check.pool = sessionDb(sessionRow({ active: false, expires_at: new Date(Date.now() - 60 * 1000) })).pool;
  {
    const response = await route.POST(emptyPost());
    assert.equal(response.status, 401, `${path}: an ended session should be a 401`);
    assert.deepEqual(await bodyOf(response), { error: 'session_expired' }, `${path}: an ended session should say session_expired`);
  }

  // A live session reaches the route.
  check.cookies = new Map([[COOKIE, 'raw-session-token']]);
  check.pool = sessionDb(sessionRow()).pool;
  {
    const response = await route.POST(emptyPost());
    const [status, body] = SIGNED_IN[path];
    assert.equal(response.status, status, `${path}: a signed-in admin should reach the route`);
    assert.deepEqual(await bodyOf(response), body);
  }

  const source = read(path);
  assert.match(source, /getAdminSessionState\(\)/, `${path} should resolve the session with getAdminSessionState`);
  assert.match(source, /adminApiUnauthorized\(state\)/, `${path} should answer a missing session with adminApiUnauthorized`);
}

// --- K2.6 lockout reset reasons: client-safe, and one source of truth -------
const reasonsSource = read('src/lib/lockout-reasons.ts');
assert.doesNotMatch(
  reasonsSource,
  /^\s*(import|export\s[^\n]*\sfrom)\s/m,
  'src/lib/lockout-reasons.ts must import nothing, so a client component can use it',
);
const reasons = await load('src/lib/lockout-reasons.ts');
const lockouts = await load('src/lib/server/admin-lockouts.ts');
assert.equal(lockouts.LOCKOUT_RESET_REASONS, reasons.LOCKOUT_RESET_REASONS, 'admin-lockouts.ts should re-export the client-safe reasons');
assert.deepEqual(
  reasons.LOCKOUT_RESET_REASONS.map((reason) => reason.code),
  ['codes_not_arriving', 'worker_confused', 'typo_in_details', 'identity_confirmed_elsewhere', 'other'],
);
for (const reason of reasons.LOCKOUT_RESET_REASONS) {
  assert.ok(reason.label.trim().length > 0, `${reason.code} needs a label`);
}

console.log('contract stub checks passed');
