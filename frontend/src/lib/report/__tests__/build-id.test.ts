import { afterAll, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { computeBuildId, EXCLUDED_PATTERNS, isExcluded } from '../../../../scripts/build-id.mjs';

const FRONTEND_DIR = fileURLToPath(new URL('../../../../', import.meta.url));
const REPO_DIR = join(FRONTEND_DIR, '..');
const CLI = join(FRONTEND_DIR, 'scripts', 'build-id.mjs');
const BUILD_ID_SHAPE = /^[0-9a-f]{12}$/;

const scratch: string[] = [];

afterAll(() => {
  for (const dir of scratch) rmSync(dir, { recursive: true, force: true });
});

/** A small frontend-shaped tree: real inputs, plus files that must not count. */
function makeTree(): string {
  const dir = mkdtempSync(join(tmpdir(), 'build-id-'));
  scratch.push(dir);
  const files: Record<string, string> = {
    'package.json': '{"name":"fixture"}\n',
    'package-lock.json': '{"lockfileVersion":3}\n',
    'next.config.mjs': 'export default {};\n',
    'tsconfig.json': '{}\n',
    'postcss.config.js': 'module.exports = {};\n',
    'src/app/page.tsx': 'export default function Page() { return null; }\n',
    'src/lib/util.ts': 'export const answer = 42;\n',
    'public/logo.svg': '<svg/>\n',
    // Not inputs: tests, env files, docs, logs, and anything outside the list.
    'src/lib/__tests__/util.test.ts': 'a test\n',
    'src/lib/util.spec.tsx': 'a spec\n',
    'src/components/button.test.tsx': 'a component test\n',
    'src/.env.local': 'FAKE_SETTING=1\n',
    '.env.production': 'FAKE_SETTING=1\n',
    'README.md': '# fixture\n',
    'eslint.config.mjs': 'export default [];\n',
  };
  for (const [rel, content] of Object.entries(files)) write(dir, rel, content);
  return dir;
}

function write(dir: string, rel: string, content: string) {
  mkdirSync(dirname(join(dir, rel)), { recursive: true });
  writeFileSync(join(dir, rel), content);
}

function copyOf(dir: string): string {
  const copy = mkdtempSync(join(tmpdir(), 'build-id-copy-'));
  scratch.push(copy);
  cpSync(dir, copy, { recursive: true });
  return copy;
}

describe('computeBuildId', () => {
  it('is 12 lowercase hex characters', () => {
    expect(computeBuildId(makeTree())).toMatch(BUILD_ID_SHAPE);
  });

  it('is the same for the same tree, wherever the tree sits', () => {
    const tree = makeTree();
    const id = computeBuildId(tree);
    expect(computeBuildId(tree)).toBe(id);
    expect(computeBuildId(copyOf(tree))).toBe(id);
  });

  it('changes when one byte of a source file changes', () => {
    const tree = makeTree();
    const before = computeBuildId(tree);
    write(tree, 'src/lib/util.ts', 'export const answer = 43;\n');
    expect(computeBuildId(tree)).not.toBe(before);
  });

  it.each([
    ['package.json', '{"name":"fixture2"}\n'],
    ['package-lock.json', '{"lockfileVersion":2}\n'],
    ['next.config.mjs', 'export default { a: 1 };\n'],
    ['tsconfig.json', '{ }\n'],
    ['postcss.config.js', 'module.exports = { a: 1 };\n'],
    ['public/logo.svg', '<svg />\n'],
    ['src/app/new-page.tsx', 'export default null;\n'],
    ['security-headers.mjs', 'export const a = 1;\n'],
  ])('changes when %s changes', (rel, content) => {
    const tree = makeTree();
    const before = computeBuildId(tree);
    write(tree, rel, content);
    expect(computeBuildId(tree)).not.toBe(before);
  });

  it('changes when a file is renamed, even with the same content', () => {
    const tree = makeTree();
    const before = computeBuildId(tree);
    renameSync(join(tree, 'src/lib/util.ts'), join(tree, 'src/lib/util2.ts'));
    expect(computeBuildId(tree)).not.toBe(before);
  });

  it('does not change for tests, .env files, docs, logs or files outside the inputs', () => {
    const tree = makeTree();
    const before = computeBuildId(tree);
    write(tree, 'src/lib/__tests__/util.test.ts', 'a changed test\n');
    write(tree, 'src/lib/__tests__/helpers.ts', 'a new helper inside a test folder\n');
    write(tree, 'src/lib/util.spec.tsx', 'a changed spec\n');
    write(tree, 'src/components/button.test.tsx', 'a changed component test\n');
    write(tree, 'src/.env.local', 'FAKE_SETTING=2\n');
    write(tree, '.env.production', 'FAKE_SETTING=2\n');
    write(tree, 'README.md', '# changed\n');
    write(tree, 'src/README.md', '# notes\n');
    write(tree, 'src/app/debug.log', 'log line\n');
    write(tree, 'src/coverage/index.html', '<html/>\n');
    write(tree, 'eslint.config.mjs', 'export default [{}];\n');
    write(tree, 'scripts/tool.mjs', 'export {};\n');
    expect(computeBuildId(tree)).toBe(before);
  });
});

describe('the exclusion list', () => {
  const dockerignore = readFileSync(join(FRONTEND_DIR, '.dockerignore'), 'utf8')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== '' && !line.startsWith('#'));

  it('covers every .dockerignore pattern, so a checkout and the image hash the same files', () => {
    expect(dockerignore.length).toBeGreaterThan(0);
    for (const pattern of dockerignore) expect(EXCLUDED_PATTERNS).toContain(pattern);
  });

  it('holds only patterns the segment matcher can express', () => {
    // A path ("a/b"), "**", "?", a character class or a negation in
    // .dockerignore needs this matcher extended before it can be mirrored.
    for (const pattern of [...dockerignore, ...EXCLUDED_PATTERNS]) {
      expect(pattern).not.toMatch(/[/?[\]!\\]|\*\*/);
    }
  });

  it('applies every pattern at any depth, files and folders alike', () => {
    for (const pattern of EXCLUDED_PATTERNS) {
      const name = pattern.replaceAll('*', 'x');
      expect(isExcluded(name)).toBe(true);
      expect(isExcluded(`src/deep/${name}`)).toBe(true);
      expect(isExcluded(`src/deep/${name}/child.ts`)).toBe(true);
    }
    expect(isExcluded('src/lib/api.ts')).toBe(false);
    expect(isExcluded('src/lib/environment.ts')).toBe(false);
    expect(isExcluded('public/legal/terms/2026-05-15.pdf')).toBe(false);
  });
});

describe('the CLI and next.config.mjs', () => {
  it('prints the id of its own checkout, from any working directory', () => {
    const expected = computeBuildId(FRONTEND_DIR);
    expect(expected).toMatch(BUILD_ID_SHAPE);
    const fromRepo = execFileSync(process.execPath, ['frontend/scripts/build-id.mjs'], { cwd: REPO_DIR, encoding: 'utf8' });
    const fromElsewhere = execFileSync(process.execPath, [CLI], { cwd: tmpdir(), encoding: 'utf8' });
    expect(fromRepo).toBe(`${expected}\n`);
    expect(fromElsewhere).toBe(`${expected}\n`);
  }, 30_000);

  it('inlines the value the CLI prints, logs it, and leaves Next\'s own build id alone', () => {
    const cli = execFileSync(process.execPath, [CLI], { encoding: 'utf8' }).trim();
    const configUrl = pathToFileURL(join(FRONTEND_DIR, 'next.config.mjs')).href;
    const probe = [
      `const config = (await import(${JSON.stringify(configUrl)})).default;`,
      'console.log("RESULT " + JSON.stringify({',
      '  build: config.env && config.env.NEXT_PUBLIC_JALE_BUILD,',
      '  customBuildId: "generateBuildId" in config,',
      '}));',
    ].join('\n');
    const out = execFileSync(process.execPath, ['--input-type=module', '-e', probe], { cwd: FRONTEND_DIR, encoding: 'utf8' });
    const lines = out.trim().split('\n');
    const result = JSON.parse(lines.find((line) => line.startsWith('RESULT '))!.slice('RESULT '.length));

    expect(result).toEqual({ build: cli, customBuildId: false });
    expect(lines).toContain(`jale-build ${cli}`);
  }, 30_000);

  it('never sets generateBuildId in the config source', () => {
    const source = readFileSync(join(FRONTEND_DIR, 'next.config.mjs'), 'utf8');
    expect(source).not.toMatch(/generateBuildId/);
    expect(source).toMatch(/NEXT_PUBLIC_JALE_BUILD/);
  });
});
