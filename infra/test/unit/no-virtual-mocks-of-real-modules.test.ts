/**
 * `jest.mock(name, factory, { virtual: true })` is for modules that do NOT
 * exist on disk. Used on a module that IS installed it still works inside the
 * file that wrote it -- and silently breaks a LATER test file in the same
 * process.
 *
 * Why: jest shares ONE module resolver per worker (and per process under
 * `--runInBand`, which is how CI runs). The resolver caches module ids by
 * (requiring file, module name). A virtual mock makes the id for
 * `(lambda/whatsapp/lib/trust-transcription.ts, '@aws-sdk/client-sfn')` the
 * bare name instead of the resolved node_modules path. A later test file's
 * ordinary `jest.mock('@aws-sdk/client-sfn', factory)` registers under the
 * resolved-path id, the cached bare-name id never matches it, and the REAL
 * client loads -- "Region is missing", two red tests, only when the two files
 * share a process in that order. Sprint 23 hit exactly this: processor.test.ts
 * mocked client-sfn virtually since 2026-05 and web/onboarding-voice.test.ts
 * paid for it on the first `--runInBand` CI run that ordered them that way.
 *
 * So: a virtual mock is allowed ONLY for a name `require.resolve` cannot find.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

const TEST_ROOT = path.resolve(__dirname);

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (entry.name.endsWith('.test.ts')) out.push(full);
  }
  return out;
}

/**
 * Every `jest.mock(<name>, ...)` call in a file, with the full argument text.
 * A balanced-paren walk (strings, template literals and comments skipped) rather than a
 * regex: a factory spans many lines and a lazy regex happily runs from one
 * mock's name to a LATER mock's `{ virtual: true }`, blaming the wrong module.
 */
function jestMockCalls(source: string): Array<{ name: string; args: string }> {
  const calls: Array<{ name: string; args: string }> = [];
  const open = /jest\.mock\(\s*(['"])([^'"]+)\1/g;
  for (const m of source.matchAll(open)) {
    const name = m[2];
    let i = (m.index ?? 0) + 'jest.mock'.length; // at the opening paren
    let depth = 0;
    let quote: string | null = null;
    const startArgs = i + 1;
    for (; i < source.length; i += 1) {
      const ch = source[i];
      if (quote) {
        if (ch === '\\') { i += 1; continue; }
        if (ch === quote) quote = null;
        continue;
      }
      // Comments inside a factory may contain apostrophes ("don't"); a naive
      // walk would open a string there and run to the end of the file.
      if (ch === '/' && source[i + 1] === '/') {
        const eol = source.indexOf('\n', i);
        i = eol === -1 ? source.length : eol;
        continue;
      }
      if (ch === '/' && source[i + 1] === '*') {
        const close = source.indexOf('*/', i + 2);
        i = close === -1 ? source.length : close + 1;
        continue;
      }
      if (ch === "'" || ch === '"' || ch === '`') { quote = ch; continue; }
      if (ch === '(') depth += 1;
      else if (ch === ')') {
        depth -= 1;
        if (depth === 0) break;
      }
    }
    calls.push({ name, args: source.slice(startArgs, i) });
  }
  return calls;
}

function isVirtual(args: string): boolean {
  return /\{\s*virtual\s*:\s*true\s*\}/.test(args);
}

describe('virtual jest.mock() is reserved for modules that do not exist', () => {
  const offenders: string[] = [];

  for (const file of walk(TEST_ROOT)) {
    const source = fs.readFileSync(file, 'utf8');
    for (const { name, args } of jestMockCalls(source)) {
      if (!isVirtual(args)) continue;
      let resolves = true;
      try {
        require.resolve(name, { paths: [path.dirname(file)] });
      } catch {
        resolves = false;
      }
      if (resolves) offenders.push(`${path.relative(TEST_ROOT, file)} -> ${name}`);
    }
  }

  test('no test file mocks an installed module with { virtual: true }', () => {
    expect(offenders).toEqual([]);
  });
});
