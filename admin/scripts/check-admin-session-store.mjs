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

// --- T4: idle hour, eight-hour day, and a throttled touch ------------------
// The fake evaluates the resolve's expressions from the parameters the store
// sends, the way the SELECT above computes them, so these checks follow the
// store's clock; the SQL text itself is pinned above.
{
  const HOUR = 60 * 60 * 1000;
  const signedInAt = new Date('2026-06-15T08:00:00.000Z');
  const at = (ms) => new Date(signedInAt.getTime() + ms);

  function clockedDb(row) {
    const seen = [];
    return {
      seen,
      row,
      async query(sql, params = []) {
        const text = sql.replace(/\s+/g, ' ').trim();
        seen.push({ sql: text, params });
        if (text.includes('FROM admin_sessions s')) {
          const [, now, idleFloor, dayFloor, touchFloor] = params;
          const active = row.expires_at > now
            && (idleFloor === undefined || row.last_seen_at > idleFloor)
            && (dayFloor === undefined || row.created_at > dayFloor);
          return {
            rows: [{
              session_id: 'session-id',
              admin_user_id: 'admin-id',
              cognito_sub: 'admin-sub',
              admin_email: 'ops@jaleapp.ai',
              role: 'admin_ops',
              expires_at: row.expires_at,
              active,
              ...(touchFloor === undefined ? {} : { needs_touch: row.last_seen_at <= touchFloor }),
            }],
          };
        }
        if (text.startsWith('UPDATE admin_sessions SET last_seen_at')) {
          const [, now, idleEnd, maxSeconds] = params;
          const dayEnd = new Date(row.created_at.getTime() + maxSeconds * 1000);
          row.last_seen_at = now;
          row.expires_at = idleEnd < dayEnd ? idleEnd : dayEnd;
          return { rows: [{ expires_at: row.expires_at }] };
        }
        if (text.startsWith("UPDATE admin_sessions SET revoked_at = NOW(), revoke_reason = 'expired'")) {
          return { rows: [{ id: 'session-id' }] };
        }
        return { rows: [] };
      },
    };
  }

  const resolveAt = async (db, when, reports = []) => new sessionStore.AdminSessionStore(db, {
    now: () => when,
    onExpired: async (expired) => { reports.push(expired); },
  }).resolve('raw-session-token');
  const touches = (db) => db.seen.filter((call) => call.sql.startsWith('UPDATE admin_sessions SET last_seen_at'));
  const expiries = (db) => db.seen.filter((call) => call.sql.includes("revoke_reason = 'expired'"));

  // Idle: an hour with no request ends the session even though its stored
  // expiry (here moved later by hand) has not passed.
  {
    const db = clockedDb({ created_at: signedInAt, last_seen_at: signedInAt, expires_at: at(3 * HOUR) });
    const reports = [];
    assert.equal(await resolveAt(db, at(HOUR), reports), undefined, 'an idle hour ends the session');
    assert.equal(expiries(db).length, 1, 'the idle expiry is recorded once');
    assert.equal(reports.length, 1);
    assert.equal(touches(db).length, 0, 'an ended session is never touched');
  }

  // Absolute: eight hours after sign-in the session ends, however recently
  // it was used and whatever its stored expiry says.
  {
    const db = clockedDb({ created_at: signedInAt, last_seen_at: at(8 * HOUR - 30_000), expires_at: at(9 * HOUR) });
    assert.equal(await resolveAt(db, at(8 * HOUR)), undefined, 'the eight-hour day ends the session');
    assert.equal(expiries(db).length, 1);
  }

  // A request keeps a session alive: each touch moves the idle hour, and
  // touches carry it across the first hour.
  {
    const db = clockedDb({ created_at: signedInAt, last_seen_at: signedInAt, expires_at: at(HOUR) });
    for (const minute of [50, 100, 150, 200]) {
      assert.ok(await resolveAt(db, at(minute * 60_000)), `still signed in at minute ${minute}`);
    }
    assert.equal(touches(db).length, 4, 'one touch per request more than a minute apart');
    assert.deepEqual(db.row.last_seen_at, at(200 * 60_000));
    assert.deepEqual(db.row.expires_at, at(260 * 60_000), 'the idle hour runs from the last request');
  }

  // Throttle: no write within a minute of the last touch; one at a minute.
  {
    const db = clockedDb({ created_at: signedInAt, last_seen_at: at(HOUR), expires_at: at(2 * HOUR) });
    assert.ok(await resolveAt(db, at(HOUR + 30_000)));
    assert.ok(await resolveAt(db, at(HOUR + 59_999)));
    assert.equal(touches(db).length, 0, 'no write within a minute');
    assert.ok(await resolveAt(db, at(HOUR + 60_000)));
    assert.equal(touches(db).length, 1, 'a write once a minute has passed');
    const [touch] = touches(db);
    assert.equal(
      touch.sql,
      'UPDATE admin_sessions SET last_seen_at = $2, expires_at = LEAST($3::timestamptz, created_at + make_interval(secs => $4)) WHERE id = $1 AND revoked_at IS NULL RETURNING expires_at',
    );
    assert.deepEqual(touch.params, ['session-id', at(HOUR + 60_000), at(2 * HOUR + 60_000), 8 * 60 * 60]);
  }

  // The touch never moves the expiry past the eight-hour day.
  {
    const db = clockedDb({ created_at: signedInAt, last_seen_at: at(7 * HOUR + 20 * 60_000), expires_at: at(8 * HOUR) });
    const late = await resolveAt(db, at(7 * HOUR + 30 * 60_000));
    assert.ok(late);
    assert.deepEqual(db.row.expires_at, at(8 * HOUR), 'expires_at = LEAST(now + idle, sign-in + 8h)');
    assert.deepEqual(late.expiresAt, at(8 * HOUR));
  }

  // A touch that fails leaves the session as it was: the request goes on.
  {
    const db = clockedDb({ created_at: signedInAt, last_seen_at: signedInAt, expires_at: at(HOUR) });
    const failing = {
      async query(sql, params) {
        if (sql.replace(/\s+/g, ' ').trim().startsWith('UPDATE admin_sessions SET last_seen_at')) {
          throw new Error('write failed');
        }
        return db.query(sql, params);
      },
    };
    const still = await resolveAt(failing, at(30 * 60_000));
    assert.ok(still, 'a failed touch never ends the session');
    assert.deepEqual(still.expiresAt, at(HOUR));
  }
}

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
// A session ends after an hour without a request, and eight hours after
// sign-in at the latest. A new one starts with the idle hour.
assert.equal(sessionStore.ADMIN_SESSION_IDLE_SECONDS, 60 * 60);
assert.equal(sessionStore.ADMIN_SESSION_MAX_SECONDS, 8 * 60 * 60);
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
// exactly one resolve can mark it and record the expiry. It ends at its
// stored expiry, after an idle hour, or eight hours after sign-in.
assert.match(
  calls[1].sql.replace(/\s+/g, ' '),
  /\(s\.expires_at > \$2 AND s\.last_seen_at > \$3 AND s\.created_at > \$4\) AS active, s\.last_seen_at <= \$5 AS needs_touch/,
);
assert.doesNotMatch(calls[1].sql.slice(calls[1].sql.indexOf('WHERE')), /expires_at|last_seen_at|created_at/);
assert.deepEqual(calls[1].params, [
  sessionStore.hashAdminSessionToken('raw-session-token'),
  new Date('2026-06-15T17:00:00.000Z'),
  new Date('2026-06-15T16:00:00.000Z'),
  new Date('2026-06-15T09:00:00.000Z'),
  new Date('2026-06-15T16:59:00.000Z'),
]);

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
