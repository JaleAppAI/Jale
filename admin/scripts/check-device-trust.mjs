// Trusted browsers (contract K1.2, BE-1 §4.3): POST /api/session verifies the
// ID and the access token (same pool, client and subject), reads the access
// token's device key, and applies the rules through device-trust.ts:
//   - a device the pool remembers signed in without a code: accepted only with
//     a live trust record younger than 7 days; otherwise the device is
//     un-remembered, the record ended as expired, a sign_in_rejected event
//     recorded and device_trust_expired returned;
//   - a device the pool does not remember signed in with a code: when the
//     admin ticked "Trust this browser", the server records the trust and
//     then remembers the device; if the pool refuses, the record ends at
//     once, so the pool never remembers a device without a live record;
//   - only 'remembered' is remembered, and only 'not_remembered' or no
//     status is not; any other status fails the sign-in closed;
//   - no device key: trustDevice is ignored;
//   - a Cognito error during the check fails closed (invalid_admin_token).
// The route runs against fakes for next/*, the token verifier, the pool, the
// Logs client and the Cognito admin API.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  RECORD_EVENT_SQL,
  compileAdminSources,
  createFakePool,
  fakeUuid,
  recordedEvents,
} from './lib/check-harness.mjs';

const { load } = compileAdminSources({
  name: 'device-trust',
  sources: ['src/app/api/session/route.ts', 'src/lib/server/device-trust.ts', 'src/lib/server/cognito-admin.ts'],
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

process.env.NEXT_PUBLIC_ADMIN_USER_POOL_ID = 'check-region_CheckPool';
process.env.NEXT_PUBLIC_ADMIN_CLIENT_ID = 'check-client';
process.env.NEXT_PUBLIC_ADMIN_REGION = 'check-region';
process.env.AUDIT_FALLBACK_LOG_GROUP = 'audit-fallback-check-group';
delete process.env.ADMIN_PREVIEW_ROLE;
delete process.env.ADMIN_ALLOW_LOCAL_PREVIEW;

const deviceTrust = await load('src/lib/server/device-trust.ts');
const route = await load('src/app/api/session/route.ts');

const check = (globalThis.__adminCheck = { cookies: new Map() });
const COOKIE = 'jale_admin_id_token_v2';
const ADMIN_ID = fakeUuid(0xd1);
const SESSION_ID = fakeUuid(0xd2);
const TRUST_ID = fakeUuid(0xd3);
const NEW_TRUST_ID = fakeUuid(0xd4);
const SUB = 'check-admin-sub';
const USERNAME = 'check-admin-username';
const DEVICE_KEY = 'check-region_00000000-0000-4000-8000-0000000000d7';
const DEVICE_HASH = createHash('sha256').update(DEVICE_KEY).digest('hex');

// --- The switch and the hash ------------------------------------------------
assert.equal(deviceTrust.isDeviceTrustEnabled(), true, 'the spike passed: trusted browsers ship');
assert.equal(deviceTrust.DEVICE_TRUST_ENABLED, true);
assert.equal(deviceTrust.DEVICE_TRUST_DAYS, 7);
assert.equal(deviceTrust.hashDeviceKey(DEVICE_KEY), DEVICE_HASH, 'the database keeps the sha256, never the key');

// --- The route --------------------------------------------------------------
/**
 * One sign-in's world: the database (an active admin; a trust row or none),
 * the pool's view of the device, and the tokens.
 */
function world({ trust = null, remembered = 'not_remembered', cognitoFails = false, rememberFails = false, admin = true } = {}) {
  const writes = [];
  // Trust writes and Cognito calls, in the order they happen.
  const order = [];
  const { pool, log } = createFakePool({
    respond: ({ sql, params }) => {
      if (sql.startsWith('SELECT id, role FROM admin_users')) {
        return { rows: admin ? [{ id: ADMIN_ID, role: 'admin_ops' }] : [] };
      }
      if (sql.startsWith('SELECT id, expires_at > now() AS fresh FROM admin_trusted_devices')) {
        writes.push(['read-trust', params]);
        return { rows: trust ? [{ id: TRUST_ID, fresh: trust === 'fresh' }] : [] };
      }
      if (sql.startsWith('UPDATE admin_trusted_devices')) {
        writes.push(['end-trust', sql, params]);
        order.push('end-trust');
        return { rows: [], rowCount: trust ? 1 : 0 };
      }
      if (sql.startsWith('INSERT INTO admin_trusted_devices')) {
        writes.push(['add-trust', sql, params]);
        order.push('add-trust');
        return { rows: [{ id: NEW_TRUST_ID }], rowCount: 1 };
      }
      if (sql.startsWith('INSERT INTO admin_sessions')) {
        writes.push(['session']);
        return { rows: [{ expires_at: new Date(Date.now() + 3600 * 1000) }] };
      }
      if (sql.includes('FROM admin_sessions s')) {
        return {
          rows: [{
            session_id: SESSION_ID, admin_user_id: ADMIN_ID, cognito_sub: SUB, admin_email: 'ops-admin@example.test',
            role: 'admin_ops', expires_at: new Date(Date.now() + 3600 * 1000), active: true,
          }],
        };
      }
      return {};
    },
  });
  check.pool = pool;
  check.cognito = {
    clients: [],
    sent: [],
    onSend: (command) => { order.push(`cognito:${command.name}`); },
    behavior: (command) => {
      if (cognitoFails) return Object.assign(new Error('Service unavailable'), { name: 'InternalErrorException' });
      if (rememberFails && command.name === 'AdminUpdateDeviceStatus') {
        return Object.assign(new Error('Service unavailable'), { name: 'InternalErrorException' });
      }
      if (command.name === 'AdminGetDevice') {
        const attributes = remembered === null ? [] : [{ Name: 'dev:device_remembered_status', Value: remembered }];
        return { Device: { DeviceKey: command.input.DeviceKey, DeviceAttributes: attributes } };
      }
      return {};
    },
  };
  return { log, writes, order };
}

function tokens({ deviceKey = DEVICE_KEY, accessSub = SUB } = {}) {
  check.verifyToken = async (token, config) => {
    if (config.tokenUse === 'id' && token === 'id-token') {
      return { sub: SUB, email: 'ops-admin@example.test', 'cognito:groups': ['admin_ops'], token_use: 'id' };
    }
    if (config.tokenUse === 'access' && token === 'access-token') {
      return { sub: accessSub, username: USERNAME, token_use: 'access', ...(deviceKey ? { device_key: deviceKey } : {}) };
    }
    throw new Error('Token not valid for this verifier');
  };
}

function signIn(body) {
  return route.POST(new Request('https://admin.example.test/api/session', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'user-agent': 'check-browser' },
    body: JSON.stringify(body),
  }));
}

const body = (trustDevice) => ({ idToken: 'id-token', accessToken: 'access-token', trustDevice });
const sent = () => check.cognito.sent.map((command) => [command.name, command.input]);
const POOL = 'check-region_CheckPool';

// Remembered device, live trust younger than 7 days: signed in without a
// code, and the sign-in names the trusted browser.
{
  const { log, writes } = world({ trust: 'fresh', remembered: 'remembered' });
  tokens();
  const response = await signIn(body(false));
  assert.equal(response.status, 200);
  assert.equal(response.cookieSets[0]?.name, COOKIE);
  assert.deepEqual(sent(), [['AdminGetDevice', { UserPoolId: POOL, Username: USERNAME, DeviceKey: DEVICE_KEY }]]);
  assert.deepEqual(writes.map(([kind]) => kind), ['read-trust', 'session']);
  assert.deepEqual(writes[0][1], [ADMIN_ID, DEVICE_HASH]);
  const [event] = recordedEvents(log);
  assert.deepEqual([event.outcome, event.actor_id, event.field_names], ['signed_in', ADMIN_ID, ['trusted_device']]);
  assert.doesNotMatch(JSON.stringify(log), new RegExp(DEVICE_KEY), 'the raw device key never reaches the database');
}

// Remembered device whose trust has passed 7 days (or has no record): the
// device is un-remembered, the record ended, the sign-in refused.
for (const trust of ['stale', null]) {
  const { log, writes } = world({ trust, remembered: 'remembered' });
  tokens();
  const response = await signIn(body(true));
  assert.equal(response.status, 401);
  assert.deepEqual(response.body, { error: 'device_trust_expired' });
  assert.deepEqual(response.cookieSets, []);
  assert.deepEqual(sent(), [
    ['AdminGetDevice', { UserPoolId: POOL, Username: USERNAME, DeviceKey: DEVICE_KEY }],
    ['AdminUpdateDeviceStatus', { UserPoolId: POOL, Username: USERNAME, DeviceKey: DEVICE_KEY, DeviceRememberedStatus: 'not_remembered' }],
  ]);
  assert.deepEqual(writes.map(([kind]) => kind), ['read-trust', 'end-trust'], 'no session is created');
  assert.match(writes[1][1], /SET ended_at = now\(\), end_reason = 'expired' WHERE admin_user_id = \$1 AND device_key_hash = \$2 AND ended_at IS NULL/);
  assert.deepEqual(writes[1][2], [ADMIN_ID, DEVICE_HASH]);
  const [event] = recordedEvents(log);
  assert.deepEqual(
    [event.kind, event.outcome, event.actor_kind, event.actor_id, 'actor_session' in event],
    ['session', 'sign_in_rejected', 'admin', ADMIN_ID, false],
  );
}

// Not remembered, the admin entered a code and ticked the box: the server
// records a 7-day trust, then remembers the device.
{
  const { log, writes, order } = world({ remembered: 'not_remembered' });
  tokens();
  const response = await signIn(body(true));
  assert.equal(response.status, 200);
  assert.deepEqual(sent(), [
    ['AdminGetDevice', { UserPoolId: POOL, Username: USERNAME, DeviceKey: DEVICE_KEY }],
    ['AdminUpdateDeviceStatus', { UserPoolId: POOL, Username: USERNAME, DeviceKey: DEVICE_KEY, DeviceRememberedStatus: 'remembered' }],
  ]);
  assert.deepEqual(writes.map(([kind]) => kind), ['end-trust', 'add-trust', 'session']);
  assert.equal(
    writes[1][1],
    "INSERT INTO admin_trusted_devices (admin_user_id, device_key_hash, expires_at) VALUES ($1, $2, now() + interval '7 days') RETURNING id",
  );
  assert.deepEqual(
    order,
    ['cognito:AdminGetDevice', 'end-trust', 'add-trust', 'cognito:AdminUpdateDeviceStatus'],
    'the record exists before the pool remembers the device',
  );
  assert.deepEqual(writes[1][2], [ADMIN_ID, DEVICE_HASH]);
  const [event] = recordedEvents(log);
  assert.deepEqual([event.outcome, event.field_names], ['signed_in', []], 'a code sign-in did not use a trusted browser');
}

// The pool refuses to remember the device: the new record ends at once (the
// pool never remembers a device without a live record) and the sign-in fails
// closed with no session.
{
  const { log, writes, order } = world({ remembered: 'not_remembered', rememberFails: true });
  tokens();
  const response = await signIn(body(true));
  assert.equal(response.status, 401);
  assert.deepEqual(response.body, { error: 'invalid_admin_token' });
  assert.deepEqual(order, [
    'cognito:AdminGetDevice', 'end-trust', 'add-trust', 'cognito:AdminUpdateDeviceStatus', 'end-trust',
  ]);
  assert.deepEqual(writes.map(([kind]) => kind), ['end-trust', 'add-trust', 'end-trust']);
  const ended = writes[2];
  assert.equal(
    ended[1],
    "UPDATE admin_trusted_devices SET ended_at = now(), end_reason = 'expired' WHERE id = $1 AND ended_at IS NULL",
  );
  assert.deepEqual(ended[2], [NEW_TRUST_ID]);
  assert.ok(!writes.some(([kind]) => kind === 'session'), 'no session');
  const [event] = recordedEvents(log);
  assert.equal(event.outcome, 'sign_in_rejected');
}

// The remembered status must be one Cognito defines: no status reads as not
// remembered (a code was asked); any other value fails closed before any
// trust is read or written.
{
  const { writes } = world({ remembered: null });
  tokens();
  const response = await signIn(body(false));
  assert.equal(response.status, 200);
  assert.deepEqual(writes.map(([kind]) => kind), ['end-trust', 'session']);
}
for (const remembered of ['REMEMBERED', 'unknown', '']) {
  const { writes } = world({ remembered, trust: 'fresh' });
  tokens();
  const response = await signIn(body(true));
  assert.equal(response.status, 401, `status ${JSON.stringify(remembered)}`);
  assert.deepEqual(response.body, { error: 'invalid_admin_token' });
  assert.deepEqual(writes, [], 'no trust read or write and no session');
  assert.deepEqual(sent().map(([name]) => name), ['AdminGetDevice']);
}

// Not remembered, box not ticked: nothing remembered, nothing recorded.
// The same holds whether or not the pool has seen this device before: the
// server never asks Cognito whether a confirmation is pending.
{
  const { writes } = world({ remembered: 'not_remembered' });
  tokens();
  const response = await signIn(body(false));
  assert.equal(response.status, 200);
  assert.deepEqual(sent().map(([name]) => name), ['AdminGetDevice']);
  assert.deepEqual(writes.map(([kind]) => kind), ['end-trust', 'session']);
}

// No device key in the access token: trustDevice is ignored, Cognito is not asked.
{
  const { writes } = world();
  tokens({ deviceKey: null });
  const response = await signIn(body(true));
  assert.equal(response.status, 200);
  assert.deepEqual(sent(), []);
  assert.deepEqual(writes.map(([kind]) => kind), ['session']);
}

// A Cognito error during the device check fails closed.
{
  const { log, writes } = world({ cognitoFails: true, remembered: 'remembered', trust: 'fresh' });
  tokens();
  const response = await signIn(body(false));
  assert.equal(response.status, 401);
  assert.deepEqual(response.body, { error: 'invalid_admin_token' });
  assert.deepEqual(writes.map(([kind]) => kind), [], 'no trust read and no session');
  const [event] = recordedEvents(log);
  assert.deepEqual([event.outcome, event.actor_kind], ['sign_in_rejected', 'anonymous']);
}

// The two tokens must name the same subject, each verified as its own use.
{
  const { writes } = world();
  tokens({ accessSub: 'someone-else' });
  const response = await signIn(body(false));
  assert.equal(response.status, 401);
  assert.deepEqual(response.body, { error: 'invalid_admin_token' });
  assert.deepEqual(writes, []);
  const uses = check.verifierConfigs.map((config) => config.tokenUse).sort();
  assert.deepEqual([...new Set(uses)], ['access', 'id']);
  for (const config of check.verifierConfigs) {
    assert.deepEqual({ pool: config.userPoolId, client: config.clientId }, { pool: POOL, client: 'check-client' });
  }
  // An access token in the ID token's place (or the reverse) does not verify.
  world();
  tokens();
  assert.equal((await signIn({ idToken: 'access-token', accessToken: 'id-token', trustDevice: false })).status, 401);
}

// Both tokens are required; a missing one is a 400 that records nothing.
for (const missing of [{ idToken: 'id-token', trustDevice: true }, { accessToken: 'access-token' }]) {
  const { log } = world();
  tokens();
  const response = await signIn(missing);
  assert.equal(response.status, 400);
  assert.deepEqual(log, []);
}

// An unknown or inactive admin: rejected without an actor, before any device call.
{
  const { log } = world({ admin: false, remembered: 'remembered', trust: 'fresh' });
  tokens();
  const response = await signIn(body(true));
  assert.equal(response.status, 401);
  assert.deepEqual(sent(), []);
  const [event] = recordedEvents(log);
  assert.deepEqual([event.outcome, event.actor_kind], ['sign_in_rejected', 'anonymous']);
  assert.equal(log.filter((entry) => entry.sql === RECORD_EVENT_SQL).length, 1);
}

console.log('admin device trust checks passed');
