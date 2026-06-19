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
        }],
      };
    }

    if (sql.includes('WITH revoked AS')) {
      return { rows: [{ revoked_count: 3 }] };
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
assert.match(calls[1].sql, /s\.expires_at > \$2/);

await store.revoke('raw-session-token', 'user_logout');
assert.match(calls[2].sql, /UPDATE admin_sessions/);
assert.deepEqual(calls[2].params, [
  sessionStore.hashAdminSessionToken('raw-session-token'),
  'user_logout',
]);

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

console.log('admin session store checks passed');
