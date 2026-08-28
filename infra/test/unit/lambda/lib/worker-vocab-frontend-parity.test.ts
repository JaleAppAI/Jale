/**
 * Drift guard, not a behavior test.
 *
 * `lambda/lib/worker-vocab.ts` owns the worker-profile vocabularies for the
 * backend. The Next.js app cannot import across the package boundary, so it
 * keeps a hand-written copy at `frontend/src/lib/worker-vocab.ts`. Nothing in
 * either type system notices when the two fall out of step — a trade added on
 * one side only, or an option list reordered, produces no compile error and
 * surfaces as a 400 from the worker-profile API or a picker showing a value
 * the DB CHECK constraint will reject.
 *
 * So this test reads the frontend file as TEXT (it is not compiled by this
 * package's ts-jest) and compares the key arrays it declares against
 * `WORKER_VOCAB`. Order matters: these lists are rendered as numbered
 * pickers, and WhatsApp answers are parsed by 1-based index.
 *
 * Reading source as text is only as trustworthy as the parser, so `extractKeys`
 * is itself unit-tested below against inline fixtures, covering the ways a
 * naive regex silently reads the wrong thing: a correct list quoted in a
 * comment above a misordered live one, a `]` inside an in-array comment, an
 * apostrophe in a comment, multi-line arrays, and `as const satisfies`. Those
 * fixture tests ALWAYS run — they do not depend on the frontend file existing.
 *
 * WHILE THE FRONTEND FILE DOES NOT EXIST YET the comparison suite SKIPS with
 * a loud warning rather than failing — it lands in a sibling task of the same
 * release. It is skip-when-absent, fail-when-present-but-different: the
 * moment the sibling's file appears, this becomes a hard gate with no further
 * change here. If you are reading this warning in CI long after that sibling
 * shipped, the file was deleted or moved — fix the path, do not delete the
 * test.
 */

import * as fs from 'fs';
import * as path from 'path';
import { WORKER_VOCAB, WORKER_VOCAB_VERSION } from '../../../../lambda/lib/worker-vocab';

const FRONTEND_VOCAB_PATH = path.resolve(
  __dirname,
  '../../../../../frontend/src/lib/worker-vocab.ts',
);

const frontendVocabExists = fs.existsSync(FRONTEND_VOCAB_PATH);

if (!frontendVocabExists) {
  const bar = '='.repeat(72);
  console.warn(
    [
      '',
      bar,
      'SKIPPED: worker-vocab frontend/backend parity guard is NOT running.',
      '',
      `  expected: ${FRONTEND_VOCAB_PATH}`,
      '  status:   file does not exist',
      '',
      '  The frontend copy of the worker-profile vocabularies lands in a',
      '  sibling task. Until it does, nothing is checking that the two',
      '  copies agree. Once the file exists this suite runs automatically.',
      bar,
      '',
    ].join('\n'),
  );
}

// ── Source parser ───────────────────────────────────────────────

/**
 * Removes block and line comments so nothing inside one can be mistaken for
 * code. This is what stops a stale-but-correct list quoted in a JSDoc above a
 * misordered live array from being read instead of the array, and it also
 * removes the two characters that break naive scanning: a `]` inside an
 * in-array comment, and an apostrophe in prose ("don't reorder these").
 *
 * Not a full lexer — a `//` or a comment opener inside a STRING literal would
 * be stripped wrongly. That cannot happen in a file whose only strings are
 * lowercase vocabulary slugs, and the parser tests below pin the behavior we
 * actually rely on.
 */
function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/.*$/gm, '');
}

/** Single- or double-quoted string literal, honoring backslash escapes. */
const STRING_LITERAL_RE = /(['"])((?:\\.|(?!\1).)*)\1/g;

/**
 * Pulls the string literals out of `export const <name> = [ ... ]`.
 *
 * Anchored at the start of a line (`m` flag) so only a real top-level export
 * matches. Tolerant of formatting — a type annotation, `as const`, `as const
 * satisfies ...`, one element per line, single or double quotes (see
 * `frontend/src/lib/trades.ts`, which indents arrays four spaces
 * one-per-line). NOT tolerant of order or content: that is the whole point.
 *
 * The `export const ` anchor keeps `TRADE_KEYS` from matching inside
 * `STANDARD_TRADE_KEYS`.
 */
function extractKeys(source: string, name: string): string[] {
  const stripped = stripComments(source);
  const match = new RegExp(
    `^export const ${name}\\s*(?::[^=]+)?=\\s*\\[([^\\]]*)\\]`,
    'm',
  ).exec(stripped);
  if (!match) {
    throw new Error(
      `${name} not found as a top-level exported array literal in ${FRONTEND_VOCAB_PATH}. `
      + 'The parity guard reads that file as text; keep the vocabularies as plain '
      + 'exported array literals so it can.',
    );
  }
  return [...match[1].matchAll(STRING_LITERAL_RE)].map((m) => m[2]);
}

/** Full RHS must be a bare integer literal, so `1_2`, `1 + 1` or a computed
 *  value fails rather than being read as `1`. */
function extractVersion(source: string): number | null {
  const match = /^export const WORKER_VOCAB_VERSION\s*(?::[^=]+)?=\s*(\d+)\s*(?:as const\s*)?;/m
    .exec(stripComments(source));
  return match ? Number(match[1]) : null;
}

// ── Parser tests (always run — no frontend file needed) ─────────

describe('worker-vocab parity guard — source parser', () => {
  it('reads the live array, not a correct-looking one quoted in a comment above it', () => {
    const fixture = [
      '/**',
      " * Mirrors the backend: ['electrician', 'plumber', 'carpenter', 'concrete', 'painting', 'other']",
      ' */',
      "// export const TRADE_KEYS = ['electrician', 'plumber', 'carpenter', 'concrete', 'painting', 'other'];",
      "export const TRADE_KEYS = ['plumber', 'electrician', 'carpenter', 'concrete', 'painting', 'other'] as const;",
    ].join('\n');

    expect(extractKeys(fixture, 'TRADE_KEYS')).toEqual([
      'plumber', 'electrician', 'carpenter', 'concrete', 'painting', 'other',
    ]);
    // ...and that is exactly what must fail the comparison below.
    expect(extractKeys(fixture, 'TRADE_KEYS')).not.toEqual([...WORKER_VOCAB.trades]);
  });

  it('is not truncated by a "]" inside an in-array comment', () => {
    const fixture = [
      'export const EXPERIENCE_KEYS = [',
      "    '0-1', // users.years_experience[0] — lowest band",
      "    '2-4',",
      "    '5-9',",
      "    '10+',",
      '] as const;',
    ].join('\n');

    expect(extractKeys(fixture, 'EXPERIENCE_KEYS')).toEqual([...WORKER_VOCAB.experience]);
  });

  it('is not confused by an apostrophe in a comment', () => {
    const fixture = [
      "// don't reorder these — the WhatsApp picker parses answers by index",
      "/* the worker's availability, in picker order; don't touch */",
      "export const AVAILABILITY_KEYS = ['full_time', 'part_time', 'weekends', 'flexible'] as const;",
    ].join('\n');

    expect(extractKeys(fixture, 'AVAILABILITY_KEYS')).toEqual([...WORKER_VOCAB.availability]);
  });

  it('reads multi-line arrays, in either quote style', () => {
    const fixture = [
      'export const TRADE_KEYS = [',
      '    "electrician",',
      "    'plumber',",
      '    "carpenter",',
      "    'concrete',",
      '    "painting",',
      "    'other',",
      '] as const;',
    ].join('\n');

    expect(extractKeys(fixture, 'TRADE_KEYS')).toEqual([...WORKER_VOCAB.trades]);
  });

  it('reads through "as const satisfies ..." without swallowing the type\'s brackets', () => {
    const fixture =
      "export const STANDARD_TRADE_KEYS = ['electrician', 'plumber', 'carpenter', 'concrete', 'painting']"
      + ' as const satisfies readonly string[];';

    expect(extractKeys(fixture, 'STANDARD_TRADE_KEYS')).toEqual([...WORKER_VOCAB.standardTrades]);
  });

  it('reads through an explicit type annotation', () => {
    const fixture =
      "export const TRANSPORT_KEYS: readonly ('yes' | 'no')[] = ['yes', 'no'];";

    expect(extractKeys(fixture, 'TRANSPORT_KEYS')).toEqual([...WORKER_VOCAB.transport]);
  });

  it('does not let TRADE_KEYS match inside STANDARD_TRADE_KEYS', () => {
    const fixture = [
      "export const STANDARD_TRADE_KEYS = ['electrician', 'plumber', 'carpenter', 'concrete', 'painting'] as const;",
      "export const TRADE_KEYS = ['electrician', 'plumber', 'carpenter', 'concrete', 'painting', 'other'] as const;",
    ].join('\n');

    expect(extractKeys(fixture, 'TRADE_KEYS')).toEqual([...WORKER_VOCAB.trades]);
    expect(extractKeys(fixture, 'STANDARD_TRADE_KEYS')).toEqual([...WORKER_VOCAB.standardTrades]);
  });

  it('throws rather than silently passing when the export is missing', () => {
    expect(() => extractKeys('export const SOMETHING_ELSE = [];', 'TRADE_KEYS')).toThrow(/TRADE_KEYS not found/);
  });

  it('accepts only a bare integer version', () => {
    expect(extractVersion('export const WORKER_VOCAB_VERSION = 1;')).toBe(1);
    expect(extractVersion('export const WORKER_VOCAB_VERSION = 1 as const;')).toBe(1);
    expect(extractVersion('export const WORKER_VOCAB_VERSION: number = 12;')).toBe(12);
    expect(extractVersion('export const WORKER_VOCAB_VERSION = 1_2;')).toBeNull();
    expect(extractVersion('export const WORKER_VOCAB_VERSION = 1 + 1;')).toBeNull();
    expect(extractVersion('export const WORKER_VOCAB_VERSION = VERSIONS.current;')).toBeNull();
    expect(extractVersion('// export const WORKER_VOCAB_VERSION = 1;')).toBeNull();
  });
});

// ── The guard itself ────────────────────────────────────────────

const describeWhenPresent = frontendVocabExists ? describe : describe.skip;

describeWhenPresent('worker-vocab frontend/backend parity', () => {
  const source = frontendVocabExists ? fs.readFileSync(FRONTEND_VOCAB_PATH, 'utf8') : '';

  it('declares the same trade slugs, in the same order', () => {
    expect(extractKeys(source, 'TRADE_KEYS')).toEqual([...WORKER_VOCAB.trades]);
  });

  it('declares the same experience bands, in the same order', () => {
    expect(extractKeys(source, 'EXPERIENCE_KEYS')).toEqual([...WORKER_VOCAB.experience]);
  });

  it('declares the same availability slugs, in the same order', () => {
    expect(extractKeys(source, 'AVAILABILITY_KEYS')).toEqual([...WORKER_VOCAB.availability]);
  });

  it('declares the same transportation keys, in the same order', () => {
    expect(extractKeys(source, 'TRANSPORT_KEYS')).toEqual([...WORKER_VOCAB.transport]);
  });

  it('declares the same standard trades when it spells them out', () => {
    // Optional on the frontend side: it may legitimately derive this one
    // (`TRADE_KEYS.filter(...)`), in which case there is nothing to drift and
    // nothing to read. Checked only when it is written as its own literal.
    if (!/^export const STANDARD_TRADE_KEYS\s*(?::[^=]+)?=\s*\[/m.test(stripComments(source))) return;
    expect(extractKeys(source, 'STANDARD_TRADE_KEYS')).toEqual([...WORKER_VOCAB.standardTrades]);
  });

  it('is pinned to the same vocabulary version', () => {
    expect(extractVersion(source)).toBe(WORKER_VOCAB_VERSION);
  });
});
