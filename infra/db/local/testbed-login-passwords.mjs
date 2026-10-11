#!/usr/bin/env node
// testbed-login-passwords.mjs -- step 8 of bootstrap-testbed.sh.
//
// Prints the SQL that gives every login of the MERGED access manifest its
// fixed test-bed password: infra/db/access/manifest.json plus every
// manifest.d/*.json fragment, so a login a fragment adds needs no edit here.
// The password is `test-<name>-pw`, <name> being the login without its
// `jale_` prefix and without underscores (jale_admin_console ->
// test-adminconsole-pw), the same rule as
// infra/test/unit/db/helpers/login-pool.ts. A login the bed does not have,
// because its migration is not applied, is skipped by the SQL.
//
// For disposable local test beds only. The passwords are fixed test values,
// never secret-shaped, and nothing here touches a real database.
//
// Usage: node testbed-login-passwords.mjs <access-manifest-dir> | psql ...
// Only plain Node is needed: no packages, so it runs before `npm ci`.

import fs from 'node:fs';
import path from 'node:path';

const LOGIN_NAME = /^jale_[a-z]+(?:_[a-z]+)*$/;

function fail(message) {
  process.stderr.write(`testbed-login-passwords: ${message}\n`);
  process.exit(1);
}

function readJson(file, label) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (err) {
    if (err && err.code === 'ENOENT') fail(`${label} is missing`);
    throw err;
  }
  try {
    return JSON.parse(text);
  } catch {
    fail(`${label}: not valid JSON`);
  }
  return undefined;
}

const dir = process.argv[2];
if (!dir) fail('usage: testbed-login-passwords.mjs <access-manifest-dir>');

const base = readJson(path.join(dir, 'manifest.json'), 'manifest.json');
const files = [{ label: 'manifest.json', raw: base }];
const fragmentDir = path.join(dir, 'manifest.d');
if (fs.existsSync(fragmentDir)) {
  const entries = fs.readdirSync(fragmentDir).sort();
  // Refused exactly as the manifest loader refuses them: shell globs skip
  // dot-named files, so every reader must agree on the fragment set.
  const hidden = entries.filter((n) => n.startsWith('.'));
  if (hidden.length > 0) fail(`manifest.d holds dot-named files (${hidden.join(', ')}); shell globs skip them, so rename or remove them`);
  for (const name of entries.filter((n) => n.endsWith('.json'))) {
    files.push({ label: `manifest.d/${name}`, raw: readJson(path.join(fragmentDir, name), `manifest.d/${name}`) });
  }
}

const logins = new Set();
for (const { raw } of files) {
  const section = raw && typeof raw === 'object' && raw.logins && typeof raw.logins === 'object' ? raw.logins : {};
  for (const name of Object.keys(section)) logins.add(name);
}

const rows = [];
for (const login of [...logins].sort()) {
  if (login === base.master) fail(`${login} is the master; it is never a runtime login`);
  if (!LOGIN_NAME.test(login)) fail(`${login} is not a test-bed login name (jale_ followed by lowercase words)`);
  rows.push(`      ('${login}', 'test-${login.slice('jale_'.length).replace(/_/g, '')}-pw')`);
}
if (rows.length === 0) fail('the manifest lists no logins');

process.stdout.write(`DO $$
DECLARE
  r RECORD;
BEGIN
  FOR r IN
    SELECT * FROM (VALUES
${rows.join(',\n')}
    ) AS t(role_name, pw)
  LOOP
    IF EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = r.role_name) THEN
      EXECUTE format('ALTER ROLE %I WITH PASSWORD %L', r.role_name, r.pw);
    END IF;
  END LOOP;
END
$$;
`);
