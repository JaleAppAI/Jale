import assert from 'node:assert/strict';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import ts from 'typescript';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const outDir = resolve(root, '.test-artifacts/admin-session-store');
const sourcePath = resolve(root, 'src/lib/server/admin-session-store.ts');

assert.equal(existsSync(sourcePath), true, `${sourcePath} should exist`);
mkdirSync(outDir, { recursive: true });

const program = ts.createProgram([sourcePath], {
  module: ts.ModuleKind.ES2022,
  target: ts.ScriptTarget.ES2022,
  moduleResolution: ts.ModuleResolutionKind.Bundler,
  strict: true,
  skipLibCheck: true,
  noEmitOnError: true,
  // TypeScript 6 no longer pulls every node_modules/@types package into a
  // config-less program the way 5.x did, and this source imports node:crypto.
  // Naming the one @types package it needs keeps the diagnostics assertion
  // exactly as strict as before instead of hiding the unresolved import.
  types: ['node'],
  outDir,
});

const diagnostics = ts.getPreEmitDiagnostics(program);
assert.deepEqual(
  diagnostics.map((diagnostic) => ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n')),
  [],
  'admin session store should typecheck without diagnostics',
);

program.emit(undefined, (fileName, data) => {
  if (fileName.endsWith('admin-session-store.js')) {
    writeFileSync(resolve(outDir, 'admin-session-store.mjs'), data);
  }
});

const sessionStore = await import(pathToFileURL(resolve(outDir, 'admin-session-store.mjs')));

const calls = [];
const db = {
  async query(sql, params = []) {
    calls.push({ sql, params });

    if (sql.includes('INSERT INTO admin_sessions')) {
      return { rows: [{ expires_at: new Date('2026-06-15T18:00:00.000Z') }] };
    }

    if (sql.includes('FROM admin_sessions s')) {
      return {
        rows: [{
          session_id: 'session-id',
          admin_user_id: 'admin-id',
          cognito_sub: 'admin-sub',
          admin_email: 'ops@jaleapp.ai',
          role: 'admin_readonly',
          expires_at: new Date('2026-06-15T18:00:00.000Z'),
          active: true,
        }],
      };
    }

    if (sql.includes('WITH revoked AS')) {
      return { rows: [{ revoked_count: 3 }] };
    }

    if (sql.includes('UPDATE admin_sessions')) {
      return { rows: [{ session_id: 'session-id', admin_user_id: 'admin-id', role: 'admin_readonly', live: true }] };
    }

    return { rows: [] };
  },
};

const store = new sessionStore.AdminSessionStore(db, {
  now: () => new Date('2026-06-15T17:00:00.000Z'),
  randomToken: () => 'raw-session-token',
});

const created = await store.create({
  sub: 'admin-sub',
  email: 'ops@jaleapp.ai',
  role: 'admin_ops',
  groups: ['admin_ops'],
}, { userAgent: 'test-browser' });

assert.equal(created.rawToken, 'raw-session-token');
assert.equal(calls[0].params.includes('raw-session-token'), false, 'raw session token must never be stored');
assert.equal(calls[0].params[0], sessionStore.hashAdminSessionToken('raw-session-token'));
// A session lasts one hour from sign-in, and the store says so to the cookie.
assert.equal(sessionStore.ADMIN_SESSION_TTL_SECONDS, 60 * 60);
assert.deepEqual(calls[0].params[2], new Date('2026-06-15T18:00:00.000Z'));

const resolved = await store.resolve('raw-session-token');
assert.deepEqual(resolved, {
  sessionId: 'session-id',
  adminUserId: 'admin-id',
  sub: 'admin-sub',
  email: 'ops@jaleapp.ai',
  role: 'admin_readonly',
  groups: ['admin_readonly'],
  expiresAt: new Date('2026-06-15T18:00:00.000Z'),
});
assert.match(calls[1].sql, /u\.active = true/);
assert.match(calls[1].sql, /s\.revoked_at IS NULL/);
// Expiry is computed, not filtered: an expired session must be seen so that
// exactly one resolve can mark it and record the expiry.
assert.match(calls[1].sql, /s\.expires_at > \$2 AS active/);
assert.doesNotMatch(calls[1].sql.slice(calls[1].sql.indexOf('WHERE')), /expires_at/);

// Sign-out ends a session that has not ended yet, says whose it was, and
// whether it was still live. One conditional UPDATE decides how it ended, on
// the clock resolve uses: a live session takes the sign-out reason, one past
// its expiry is marked expired.
assert.deepEqual(await store.revoke('raw-session-token', 'user_logout'), {
  sessionId: 'session-id',
  adminUserId: 'admin-id',
  role: 'admin_readonly',
  live: true,
});
const revokeSql = calls[2].sql.replace(/\s+/g, ' ').trim();
assert.match(revokeSql, /^UPDATE admin_sessions s SET revoked_at = NOW\(\), revoke_reason = CASE WHEN s\.expires_at > \$3 THEN \$2::text ELSE 'expired' END /);
assert.match(revokeSql, / WHERE s\.token_hash = \$1 AND s\.revoked_at IS NULL AND u\.id = s\.admin_user_id /);
assert.match(revokeSql, / RETURNING s\.id AS session_id, u\.id AS admin_user_id, u\.role, s\.expires_at > \$3 AS live$/);
assert.deepEqual(calls[2].params, [
  sessionStore.hashAdminSessionToken('raw-session-token'),
  'user_logout',
  new Date('2026-06-15T17:00:00.000Z'),
]);

// A session past its expiry ends as expired: the row says it was not live.
const expiredSignOut = new sessionStore.AdminSessionStore({
  async query() {
    return { rows: [{ session_id: 'expired-session-id', admin_user_id: 'admin-id', role: 'admin_ops', live: false }] };
  },
});
assert.deepEqual(await expiredSignOut.revoke('raw-session-token', 'user_logout'), {
  sessionId: 'expired-session-id',
  adminUserId: 'admin-id',
  role: 'admin_ops',
  live: false,
});

assert.equal(await store.revokeAllForAdmin('admin-id', 'security_reset'), 3);
assert.match(calls[3].sql, /admin_user_id = \$1/);
assert.match(calls[3].sql, /revoked_at IS NULL/);
assert.deepEqual(calls[3].params, ['admin-id', 'security_reset']);

const missingStore = new sessionStore.AdminSessionStore({
  async query() {
    return { rows: [] };
  },
});
assert.equal(await missingStore.resolve('unknown-token'), undefined);
assert.equal(await missingStore.revoke('unknown-token', 'user_logout'), undefined, 'an already-revoked session signs out nobody');

// An expired, unrevoked session: one conditional UPDATE ... RETURNING marks it,
// and only the resolve that gets the row back reports the expiry.
function expiringDb({ wins }) {
  const seen = [];
  return {
    seen,
    async query(sql, params = []) {
      seen.push({ sql, params });
      if (sql.includes('FROM admin_sessions s')) {
        return {
          rows: [{
            session_id: 'expired-session-id',
            admin_user_id: 'admin-id',
            cognito_sub: 'admin-sub',
            admin_email: 'ops@jaleapp.ai',
            role: 'admin_superadmin',
            expires_at: new Date('2026-06-15T16:00:00.000Z'),
            active: false,
          }],
        };
      }
      if (sql.includes('UPDATE admin_sessions')) {
        return { rows: wins ? [{ id: 'expired-session-id' }] : [] };
      }
      return { rows: [] };
    },
  };
}

const expiredReports = [];
const winnerDb = expiringDb({ wins: true });
const winner = new sessionStore.AdminSessionStore(winnerDb, {
  now: () => new Date('2026-06-15T17:00:00.000Z'),
  onExpired: async (expired) => { expiredReports.push(expired); },
});
assert.equal(await winner.resolve('raw-session-token'), undefined, 'an expired session never resolves');
assert.equal(winnerDb.seen.length, 2);
assert.equal(
  winnerDb.seen[1].sql.replace(/\s+/g, ' ').trim(),
  "UPDATE admin_sessions SET revoked_at = NOW(), revoke_reason = 'expired' WHERE id = $1 AND revoked_at IS NULL RETURNING id",
);
assert.deepEqual(winnerDb.seen[1].params, ['expired-session-id']);
assert.deepEqual(expiredReports, [{ sessionId: 'expired-session-id', adminUserId: 'admin-id', role: 'admin_superadmin' }]);

const loserDb = expiringDb({ wins: false });
const loser = new sessionStore.AdminSessionStore(loserDb, {
  onExpired: async (expired) => { expiredReports.push(expired); },
});
assert.equal(await loser.resolve('raw-session-token'), undefined);
assert.equal(expiredReports.length, 1, 'a resolve that lost the race reports nothing');

// A failing reporter never turns a resolve into an error.
const noisy = new sessionStore.AdminSessionStore(expiringDb({ wins: true }), {
  onExpired: async () => { throw new Error('reporter failed'); },
});
assert.equal(await noisy.resolve('raw-session-token'), undefined);

console.log('admin session store checks passed');
