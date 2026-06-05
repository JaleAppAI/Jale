import assert from 'node:assert/strict';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import ts from 'typescript';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const outDir = resolve(root, '.test-artifacts/server-db-helpers');
const sourceFiles = [
  'src/lib/server/db-secret.ts',
  'src/lib/server/db.ts',
].map((relativePath) => resolve(root, relativePath));

for (const sourcePath of sourceFiles) {
  assert.equal(existsSync(sourcePath), true, `${sourcePath} should exist`);
}

mkdirSync(outDir, { recursive: true });

const program = ts.createProgram(sourceFiles, {
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
  'admin server DB helper modules should typecheck without diagnostics',
);

program.emit(undefined, (fileName, data) => {
  if (fileName.endsWith('.js')) {
    const moduleName = fileName.slice(fileName.lastIndexOf('/') + 1, -3);
    writeFileSync(
      resolve(outDir, `${moduleName}.mjs`),
      data
        .replaceAll('"./db-secret"', '"./db-secret.mjs"')
        .replaceAll("'./db-secret'", "'./db-secret.mjs'"),
    );
  }
});

const dbSecret = await import(pathToFileURL(resolve(outDir, 'db-secret.mjs')));
const db = await import(pathToFileURL(resolve(outDir, 'db.mjs')));

const parsed = dbSecret.parseDbSecret(JSON.stringify({
  host: 'database.internal',
  port: '5432',
  dbname: 'jale',
  username: 'jale_admin_console',
  password: 'secret-password',
}));

assert.deepEqual(parsed, {
  host: 'database.internal',
  port: 5432,
  dbname: 'jale',
  username: 'jale_admin_console',
  password: 'secret-password',
});

assert.throws(
  () => dbSecret.parseDbSecret(JSON.stringify({
    host: 'database.internal',
    port: 5432,
    username: 'jale_admin',
    password: 'secret-password',
  })),
  /DB secret is missing required field: dbname/,
);

assert.throws(
  () => dbSecret.requireDbSecretArn(undefined),
  /DB_SECRET_ARN is required/,
);

assert.equal(dbSecret.requireDbSecretArn('arn:test'), 'arn:test');

// Test local-only DB secret overrides without touching AWS Secrets Manager.
const originalNodeEnv = process.env.NODE_ENV;
const originalLocalSecretJson = process.env.ADMIN_LOCAL_DB_SECRET_JSON;
const originalLocalSecretFile = process.env.ADMIN_LOCAL_DB_SECRET_FILE;
const originalSslMode = process.env.ADMIN_DB_SSL_MODE;

const localSecret = JSON.stringify({
  host: '127.0.0.1',
  port: 55432,
  dbname: 'jale',
  username: 'jale_admin_console',
  password: 'local-admin-console-password',
});

try {
  process.env.NODE_ENV = 'development';
  process.env.ADMIN_LOCAL_DB_SECRET_JSON = localSecret;
  delete process.env.ADMIN_LOCAL_DB_SECRET_FILE;
  dbSecret.clearAdminDbSecretCache();

  assert.deepEqual(await dbSecret.getAdminDbSecret(), {
    host: '127.0.0.1',
    port: 55432,
    dbname: 'jale',
    username: 'jale_admin_console',
    password: 'local-admin-console-password',
  });

  const localSecretFile = resolve(outDir, 'local-admin-db-secret.json');
  writeFileSync(localSecretFile, localSecret);
  delete process.env.ADMIN_LOCAL_DB_SECRET_JSON;
  process.env.ADMIN_LOCAL_DB_SECRET_FILE = localSecretFile;
  dbSecret.clearAdminDbSecretCache();

  assert.equal((await dbSecret.getAdminDbSecret()).host, '127.0.0.1');

  process.env.NODE_ENV = 'production';
  process.env.ADMIN_LOCAL_DB_SECRET_JSON = localSecret;
  dbSecret.clearAdminDbSecretCache();

  await assert.rejects(
    () => dbSecret.getAdminDbSecret(),
    /Local admin DB secret override is not allowed in production/,
  );

  delete process.env.ADMIN_LOCAL_DB_SECRET_JSON;
  delete process.env.ADMIN_LOCAL_DB_SECRET_FILE;

  // Test dynamic pool sizing based on NODE_ENV.
  process.env.NODE_ENV = 'production';
  const prodConfig = db.buildAdminPoolConfig(parsed);
  assert.equal(prodConfig.max, 1);

  process.env.NODE_ENV = 'development';
  const devConfig = db.buildAdminPoolConfig(parsed);
  assert.equal(devConfig.max, 5);

  process.env.ADMIN_DB_SSL_MODE = 'disable';
  const localNoSslConfig = db.buildAdminPoolConfig(parsed);
  assert.equal(localNoSslConfig.ssl, false);

  process.env.NODE_ENV = 'production';
  assert.throws(
    () => db.buildAdminPoolConfig(parsed),
    /ADMIN_DB_SSL_MODE=disable is not allowed in production/,
  );
} finally {
  process.env.NODE_ENV = originalNodeEnv;
  if (originalLocalSecretJson === undefined) {
    delete process.env.ADMIN_LOCAL_DB_SECRET_JSON;
  } else {
    process.env.ADMIN_LOCAL_DB_SECRET_JSON = originalLocalSecretJson;
  }
  if (originalLocalSecretFile === undefined) {
    delete process.env.ADMIN_LOCAL_DB_SECRET_FILE;
  } else {
    process.env.ADMIN_LOCAL_DB_SECRET_FILE = originalLocalSecretFile;
  }
  if (originalSslMode === undefined) {
    delete process.env.ADMIN_DB_SSL_MODE;
  } else {
    process.env.ADMIN_DB_SSL_MODE = originalSslMode;
  }
}
const poolConfig = db.buildAdminPoolConfig(parsed);
assert.equal(poolConfig.host, 'database.internal');
assert.equal(poolConfig.port, 5432);
assert.equal(poolConfig.database, 'jale');
assert.equal(poolConfig.user, 'jale_admin_console');
assert.equal(poolConfig.password, 'secret-password');

assert.equal(poolConfig.idleTimeoutMillis, 10000);
assert.equal(poolConfig.connectionTimeoutMillis, 2000);
assert.equal(poolConfig.ssl.rejectUnauthorized, true);

// The internet-facing admin Lambda must run as the least-privilege
// jale_admin_console role, never the shared jale_admin owner role.
assert.throws(
  () => db.buildAdminPoolConfig({ ...parsed, username: 'jale_admin' }),
  /jale_admin_console/,
);

console.log('admin server DB helper checks passed');
