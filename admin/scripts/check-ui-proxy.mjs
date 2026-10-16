// Admin UI contract: the request proxy and the session code (BE-1).
// src/proxy.ts, and the session.ts / api/session/route.ts text assertions.
// Split out of check-ui-contract.mjs in sprint 28 step 0; the assertions are
// unchanged.
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { read, root } from './lib/ui-contract-helpers.mjs';

// --- Next 16 async request APIs -------------------------------------------
// Next 16 removed the synchronous compatibility shim: cookies(), params and
// searchParams are Promises now. Reading a property off the un-awaited value
// does not throw -- it silently yields undefined -- and TypeScript cannot catch
// it either, because Next's generated page validator widens page props with
// `& any` (.next/types/validator.ts). So the contract is asserted here.
const sessionLib = read('src/lib/server/session.ts');
const sessionRoute = read('src/app/api/session/route.ts');

for (const [label, source] of [
  ['src/lib/server/session.ts', sessionLib],
  ['src/app/api/session/route.ts', sessionRoute],
]) {
  assert.match(source, /await cookies\(\)/, `${label} must await cookies() -- Next 16 removed the sync shim`);
  assert.doesNotMatch(
    source,
    /cookies\(\)\s*\.\s*get/,
    `${label} must not read a cookie off an un-awaited cookies()`,
  );
}

// --- Next 16 proxy file convention ----------------------------------------
// Next 16 renamed the middleware convention to `proxy`; src/middleware.ts is
// deprecated and stops being picked up in a later release. The rename also
// moves the hook off the Edge runtime onto Node, which does NOT change the
// security boundary: this layer still only checks cookie presence, and
// requireAdminSession() remains the real authz gate.
assert.equal(
  existsSync(resolve(root, 'src/proxy.ts')),
  true,
  'the request hook must live in src/proxy.ts (Next 16 renamed the middleware convention)',
);
assert.equal(
  existsSync(resolve(root, 'src/middleware.ts')),
  false,
  'src/middleware.ts must be gone -- two conventions would fight over the same matcher',
);

const proxyHook = read('src/proxy.ts');

assert.match(
  proxyHook,
  /export function proxy\(/,
  'the proxy file must export a function named `proxy`',
);
assert.doesNotMatch(
  proxyHook,
  /export function middleware\(/,
  'the old `middleware` export must be gone',
);
assert.match(
  proxyHook,
  /matcher:\s*\['\/\(\(\?!\.\*\\\\\.\.\*\)\.\*\)'\]/,
  'the proxy matcher must stay exactly as the middleware matcher was',
);
assert.match(
  proxyHook,
  /requireAdminSession\(\)/,
  'the proxy must keep the note that requireAdminSession() is the real authz boundary',
);

console.log('admin UI proxy contract checks passed');
