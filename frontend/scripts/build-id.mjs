/**
 * The frontend's build identity: the first 12 hex characters of a SHA-256
 * over the files `next build` turns into the app, so it changes when the code
 * does and only then. `next.config.mjs` inlines it as NEXT_PUBLIC_JALE_BUILD,
 * and problem reports carry it.
 *
 * It must be the same value in a checkout and inside the image, where
 * `next build` runs on a Docker context filtered by `frontend/.dockerignore`.
 * So the files that list leaves out never count, here or there.
 *
 * Usage: `node frontend/scripts/build-id.mjs` prints the id of the checkout
 * the script sits in, from any working directory.
 */

import { createHash } from 'node:crypto';
import { lstatSync, readdirSync, readFileSync, readlinkSync, realpathSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const FRONTEND_DIR = resolve(dirname(SCRIPT_PATH), '..');

/** Folders whose files are hashed, at any depth. */
export const HASHED_DIRECTORIES = ['src', 'public'];

/** Single files at the top of the frontend that are hashed when present. */
export const HASHED_FILES = [
  'package.json',
  'package-lock.json',
  'next.config.mjs',
  'security-headers.mjs',
  'tsconfig.json',
  'postcss.config.js',
];

/**
 * Every pattern in `frontend/.dockerignore`, mirrored here because that file
 * is itself excluded from the Docker context, so the build inside the image
 * cannot read it. A guard test fails when the two lists drift apart.
 *
 * Each pattern is applied to every path segment at any depth, which is a
 * deliberate superset of Docker's own matching (anchored at the context
 * root): a test file deep in `src/` never changes the id, wherever Docker
 * would have put it. Patterns may use `*` only; a path, `**`, `?`, a
 * character class or a negation needs this matcher extended first.
 */
export const EXCLUDED_PATTERNS = [
  'node_modules',
  '.next',
  'out',
  '.git',
  '.gitignore',
  '.env*',
  'README.md',
  '*.log',
  '.DS_Store',
  'Dockerfile',
  '.dockerignore',
  '.vscode',
  '.idea',
  'coverage',
  '__tests__',
  '*.test.ts',
  '*.test.tsx',
  '*.spec.ts',
  '*.spec.tsx',
];

/** @param {string} pattern */
function segmentMatcher(pattern) {
  const source = pattern
    .split('*')
    .map((literal) => literal.replace(/[.+^${}()|[\]\\?]/g, '\\$&'))
    .join('.*');
  return new RegExp(`^${source}$`);
}

const EXCLUDED_MATCHERS = EXCLUDED_PATTERNS.map(segmentMatcher);

/**
 * Whether a POSIX path relative to the frontend folder is left out of the
 * hash: true when any of its segments matches an excluded pattern.
 *
 * @param {string} relativePath
 * @returns {boolean}
 */
export function isExcluded(relativePath) {
  return relativePath
    .split('/')
    .some((segment) => EXCLUDED_MATCHERS.some((matcher) => matcher.test(segment)));
}

/**
 * @param {string} a
 * @param {string} b
 */
function byCodeUnit(a, b) {
  if (a < b) return -1;
  return a > b ? 1 : 0;
}

/**
 * @param {string} root
 * @param {string} relativeDir
 * @param {string[]} out
 */
function collectDirectory(root, relativeDir, out) {
  let entries;
  try {
    entries = readdirSync(join(root, ...relativeDir.split('/')), { withFileTypes: true });
  } catch (err) {
    if (/** @type {NodeJS.ErrnoException} */ (err).code === 'ENOENT') return;
    throw err;
  }
  for (const entry of entries) {
    const relativePath = `${relativeDir}/${entry.name}`;
    if (isExcluded(relativePath)) continue;
    // Symbolic links are hashed as links and never followed, as Docker copies them.
    if (entry.isDirectory()) collectDirectory(root, relativePath, out);
    else if (entry.isFile() || entry.isSymbolicLink()) out.push(relativePath);
  }
}

/**
 * The hashed files of a frontend folder, as sorted POSIX paths.
 *
 * @param {string} root
 * @returns {string[]}
 */
function hashedFiles(root) {
  const files = [];
  for (const name of HASHED_FILES) {
    if (isExcluded(name)) continue;
    try {
      const stat = lstatSync(join(root, name));
      if (stat.isFile() || stat.isSymbolicLink()) files.push(name);
    } catch (err) {
      if (/** @type {NodeJS.ErrnoException} */ (err).code !== 'ENOENT') throw err;
    }
  }
  for (const dir of HASHED_DIRECTORIES) {
    if (!isExcluded(dir)) collectDirectory(root, dir, files);
  }
  return files.sort(byCodeUnit);
}

/**
 * The build id of a frontend folder: SHA-256 over each hashed file's path,
 * length and content, in path order, cut to 12 hex characters.
 *
 * @param {string} [frontendDir] defaults to the folder this script sits in.
 * @returns {string}
 */
export function computeBuildId(frontendDir = FRONTEND_DIR) {
  const root = resolve(frontendDir);
  const hash = createHash('sha256');
  for (const relativePath of hashedFiles(root)) {
    const fullPath = join(root, ...relativePath.split('/'));
    const isLink = lstatSync(fullPath).isSymbolicLink();
    const content = isLink ? Buffer.from(readlinkSync(fullPath), 'utf8') : readFileSync(fullPath);
    // Framed by kind, path and length, so no two different trees hash the same input.
    hash.update(`${isLink ? 'link' : 'file'}\0${relativePath}\0${content.length}\0`);
    hash.update(content);
  }
  return hash.digest('hex').slice(0, 12);
}

function invokedDirectly() {
  if (!process.argv[1]) return false;
  try {
    return realpathSync(process.argv[1]) === realpathSync(SCRIPT_PATH);
  } catch {
    return false;
  }
}

if (invokedDirectly()) {
  process.stdout.write(`${computeBuildId()}\n`);
}
