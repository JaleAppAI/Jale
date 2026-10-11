// Shared harness for the admin check scripts that exercise server modules
// with nested imports (src/lib/server/audit/**, route handlers using `@/`).
//
// compileAdminSources() type-checks the given sources exactly as strictly as
// the older check scripts do, emits them as ES modules while keeping the src/
// tree (so relative and `@/` imports still resolve), and swaps chosen modules
// for fakes:
//   - a bare specifier ('next/headers', '@aws-sdk/client-cloudwatch-logs'), or
//   - an admin source path ('src/lib/server/db.ts')
// maps to a fake file under scripts/fakes/. Fakes read their state from
// globalThis.__adminCheck, which the check script owns.
import assert from 'node:assert/strict';
import { copyFileSync, existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import ts from 'typescript';

export const adminRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const srcRoot = resolve(adminRoot, 'src');
const SOURCE_EXTENSIONS = ['.ts', '.tsx'];

function toPosix(path) {
  return path.split(sep).join('/');
}

function resolveSourceFile(target) {
  for (const extension of SOURCE_EXTENSIONS) {
    if (existsSync(`${target}${extension}`)) return `${target}${extension}`;
  }
  for (const extension of SOURCE_EXTENSIONS) {
    const index = resolve(target, `index${extension}`);
    if (existsSync(index)) return index;
  }
  return undefined;
}

function relativeSpecifier(fromFile, toFile) {
  const path = toPosix(relative(dirname(fromFile), toFile));
  return path.startsWith('.') ? path : `./${path}`;
}

export function compileAdminSources({ name, sources, fakes = {} }) {
  const outDir = resolve(adminRoot, '.test-artifacts', name);
  rmSync(outDir, { recursive: true, force: true });
  mkdirSync(outDir, { recursive: true });

  const rootNames = sources.map((source) => resolve(adminRoot, source));
  for (const rootName of rootNames) {
    assert.equal(existsSync(rootName), true, `${toPosix(relative(adminRoot, rootName))} should exist`);
  }

  const program = ts.createProgram(rootNames, {
    module: ts.ModuleKind.ES2022,
    target: ts.ScriptTarget.ES2022,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    strict: true,
    skipLibCheck: true,
    noEmitOnError: true,
    // A config-less TypeScript 6 program pulls in no @types package unless
    // it is named (see check-admin-session-store.mjs).
    types: ['node'],
    jsx: ts.JsxEmit.ReactJSX,
    paths: { '@/*': [`${toPosix(srcRoot)}/*`] },
    rootDir: srcRoot,
    outDir,
  });

  const diagnostics = ts.getPreEmitDiagnostics(program);
  assert.deepEqual(
    diagnostics.map((diagnostic) => {
      const where = diagnostic.file ? `${toPosix(relative(adminRoot, diagnostic.file.fileName))}: ` : '';
      return `${where}${ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n')}`;
    }),
    [],
    `${name}: sources should typecheck without diagnostics`,
  );

  const fakeTargets = new Map();
  mkdirSync(resolve(outDir, '__fakes__'), { recursive: true });
  for (const [key, fakePath] of Object.entries(fakes)) {
    const target = resolve(outDir, '__fakes__', basename(fakePath));
    copyFileSync(resolve(adminRoot, fakePath), target);
    fakeTargets.set(key.startsWith('src/') ? resolve(adminRoot, key) : key, target);
  }

  const outputs = new Map();
  const emitResult = program.emit(undefined, (fileName, data) => {
    if (fileName.endsWith('.js')) outputs.set(resolve(fileName), data);
  });
  assert.equal(emitResult.emitSkipped, false, `${name}: emit should not be skipped`);

  const outputFor = (sourceFile) => resolve(outDir, relative(srcRoot, sourceFile)).replace(/\.tsx?$/, '.js');
  const sourceFor = (outputFile) => {
    const base = resolve(srcRoot, relative(outDir, outputFile)).replace(/\.js$/, '');
    return resolveSourceFile(base);
  };

  const rewrite = (outputFile, specifier) => {
    if (fakeTargets.has(specifier)) {
      return relativeSpecifier(outputFile, fakeTargets.get(specifier));
    }
    let target;
    if (specifier.startsWith('@/')) {
      target = resolve(srcRoot, specifier.slice(2));
    } else if (specifier.startsWith('./') || specifier.startsWith('../')) {
      target = resolve(dirname(sourceFor(outputFile)), specifier);
    } else {
      return specifier;
    }
    const sourceFile = resolveSourceFile(target);
    assert.ok(sourceFile, `${name}: cannot resolve ${specifier} from ${toPosix(relative(outDir, outputFile))}`);
    if (fakeTargets.has(sourceFile)) {
      return relativeSpecifier(outputFile, fakeTargets.get(sourceFile));
    }
    return relativeSpecifier(outputFile, outputFor(sourceFile));
  };

  for (const [outputFile, data] of outputs) {
    const rewritten = data.replace(
      /(\bfrom\s*|\bimport\s*\(\s*|\bimport\s+)(['"])([^'"\n]+)\2/g,
      (_match, lead, quote, specifier) => `${lead}${quote}${rewrite(outputFile, specifier)}${quote}`,
    );
    mkdirSync(dirname(outputFile), { recursive: true });
    writeFileSync(outputFile, rewritten);
  }
  writeFileSync(resolve(outDir, 'package.json'), '{ "type": "module" }\n');

  return {
    outDir,
    load: (sourcePath) => import(pathToFileURL(outputFor(resolve(adminRoot, sourcePath))).href),
  };
}

// ---------------------------------------------------------------------------
// A fake pg pool. Every query lands in one ordered log across connections, so
// a check can assert transaction order: BEGIN -> reads -> event -> COMMIT.
// `respond` decides each result and may throw to simulate a database error.
// ---------------------------------------------------------------------------
export function normalizeSql(sql) {
  return String(sql).replace(/\s+/g, ' ').trim();
}

export function createFakePool({ respond = () => ({}), connectError } = {}) {
  const log = [];
  let nextConnection = 1;

  async function run(connection, sql, params) {
    const entry = { connection, sql: normalizeSql(sql), params };
    log.push(entry);
    const result = await respond({ ...entry, log });
    return { rows: [], rowCount: 0, ...result };
  }

  const pool = {
    async connect() {
      if (connectError) {
        log.push({ connection: null, op: 'connect_failed' });
        throw connectError;
      }
      const connection = nextConnection++;
      log.push({ connection, op: 'connect' });
      return {
        query: (sql, params) => run(connection, sql, params),
        release: (error) => {
          log.push({ connection, op: 'release', destroyed: Boolean(error) });
        },
      };
    },
    query: (sql, params) => run('pool', sql, params),
  };

  return { pool, log };
}

/** The statements of a fake pool log, in order, as `<connection>: <sql>` lines. */
export function statements(log) {
  return log.map((entry) => (entry.op ? `${entry.connection}: <${entry.op}${entry.destroyed ? ' destroyed' : ''}>` : `${entry.connection}: ${entry.sql}`));
}

export const RECORD_EVENT_SQL = 'SELECT jale_audit.record_event($1::jsonb) AS seq';

/** The event payloads written through record_event, in order. */
export function recordedEvents(log) {
  return log
    .filter((entry) => entry.sql === RECORD_EVENT_SQL)
    .map((entry) => JSON.parse(entry.params[0]));
}

/** Captures console.log / console.error lines written while `fn` runs. */
export async function captureConsole(fn) {
  const lines = { log: [], error: [] };
  const original = { log: console.log, error: console.error };
  console.log = (...args) => { lines.log.push(args); };
  console.error = (...args) => { lines.error.push(args); };
  try {
    const result = await fn();
    return { result, lines };
  } finally {
    console.log = original.log;
    console.error = original.error;
  }
}

/** A fixed, obviously synthetic UUID: 00000000-0000-4000-8000-<12 hex>. */
export function fakeUuid(n) {
  return `00000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;
}
