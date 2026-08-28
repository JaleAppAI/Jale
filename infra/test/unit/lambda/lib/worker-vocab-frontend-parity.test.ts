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
 * WHILE THE FRONTEND FILE DOES NOT EXIST YET this suite SKIPS with a loud
 * warning rather than failing — it lands in a sibling task of the same
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

/**
 * Pulls the string literals out of `export const <name> = [ ... ]`.
 *
 * Deliberately tolerant of formatting — the frontend file is written by
 * hand and may use a type annotation, `as const`, one element per line, or
 * double quotes (see `frontend/src/lib/trades.ts`, which indents arrays four
 * spaces one-per-line). It is NOT tolerant of order or content: that is the
 * whole point of the guard.
 *
 * The `export const ` anchor keeps `TRADE_KEYS` from matching inside
 * `STANDARD_TRADE_KEYS`.
 */
function extractKeys(source: string, name: string): string[] {
  const match = new RegExp(`export const ${name}\\s*(?::[^=]+)?=\\s*\\[([^\\]]*)\\]`).exec(source);
  if (!match) {
    throw new Error(
      `${name} not found as an exported array literal in ${FRONTEND_VOCAB_PATH}. `
      + 'The parity guard reads that file as text; keep the vocabularies as plain '
      + 'exported array literals so it can.',
    );
  }
  return [...match[1].matchAll(/['"]([^'"]+)['"]/g)].map((m) => m[1]);
}

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
    // (`TRADE_KEYS.filter(...)`), in which case there is nothing to drift.
    // Checked only when it is written as its own literal.
    if (!/export const STANDARD_TRADE_KEYS\s*(?::[^=]+)?=\s*\[/.test(source)) {
      expect(source).toContain('STANDARD_TRADE_KEYS');
      return;
    }
    expect(extractKeys(source, 'STANDARD_TRADE_KEYS')).toEqual([...WORKER_VOCAB.standardTrades]);
  });

  it('is pinned to the same vocabulary version', () => {
    const match = /export const WORKER_VOCAB_VERSION\s*(?::[^=]+)?=\s*(\d+)/.exec(source);
    expect(match).not.toBeNull();
    expect(Number(match![1])).toBe(WORKER_VOCAB_VERSION);
  });
});
