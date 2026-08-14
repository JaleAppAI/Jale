// Lints infra/scripts/transcribe/vocabulary-es-us.txt — the operator-managed
// Amazon Transcribe custom vocabulary table for the es-US voice-note
// pipeline (see infra/scripts/transcribe/create-vocabulary.sh). This is a
// static asset, not code, but its format constraints are strict enough
// (AWS rejects the whole vocabulary on a single malformed Phrase) that a
// regression here should fail CI rather than surface only at
// `create-vocabulary.sh` runtime.
//
// Rules enforced (AWS Transcribe "custom vocabulary using a table" format,
// Spanish character set — see the research doc's Part A §3):
//   - Header is exactly `Phrase\tDisplayAs\tSoundsLike\tIPA`.
//   - Every row has exactly 4 tab-separated fields.
//   - SoundsLike and IPA are both empty (deprecated by AWS; must still be
//     present as empty columns).
//   - Phrase: no spaces, no digits, no `ü`; only a-zA-Z, the Spanish
//     accented vowels/ñ, apostrophe, hyphen, and period; never starts or
//     ends with `.`/`'`/`-`.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const VOCAB_PATH = join(__dirname, '../../../scripts/transcribe/vocabulary-es-us.txt');

const EXPECTED_HEADER = 'Phrase\tDisplayAs\tSoundsLike\tIPA';

// a-z, A-Z, Spanish accented vowels + ñ/Ñ, apostrophe, hyphen, period.
// Deliberately excludes ü (not in AWS's Spanish charset for Phrase).
const PHRASE_CHARSET_RE = /^[a-zA-ZáéíóúÁÉÍÓÚñÑ'.-]+$/;

function readRows(): string[][] {
  const raw = readFileSync(VOCAB_PATH, 'utf-8');
  const lines = raw.split('\n').filter((line) => line.length > 0);
  return lines.map((line) => line.split('\t'));
}

describe('vocabulary-es-us.txt format', () => {
  it('has the exact required header', () => {
    const raw = readFileSync(VOCAB_PATH, 'utf-8');
    const [headerLine] = raw.split('\n');
    expect(headerLine).toBe(EXPECTED_HEADER);
  });

  it('has at least one data row', () => {
    const rows = readRows();
    expect(rows.length).toBeGreaterThan(1); // header + data
  });

  it('every row (including header) has exactly 4 tab-separated fields', () => {
    const rows = readRows();
    for (const row of rows) {
      expect(row).toHaveLength(4);
    }
  });

  it('every data row has empty SoundsLike and IPA fields', () => {
    const [, ...dataRows] = readRows();
    for (const [phrase, , soundsLike, ipa] of dataRows) {
      expect(soundsLike).toBe('');
      expect(ipa).toBe('');
      // sanity: didn't accidentally read past the phrase column
      expect(phrase.length).toBeGreaterThan(0);
    }
  });

  it('every Phrase is non-empty and passes the es-US charset/format rules', () => {
    const [, ...dataRows] = readRows();
    for (const [phrase] of dataRows) {
      expect(phrase.length).toBeGreaterThan(0);
      expect(phrase).not.toContain(' ');
      expect(phrase).not.toMatch(/[0-9]/);
      expect(phrase).not.toContain('ü');
      expect(phrase).not.toContain('Ü');
      expect(phrase).toMatch(PHRASE_CHARSET_RE);
      expect(phrase.startsWith('.')).toBe(false);
      expect(phrase.startsWith("'")).toBe(false);
      expect(phrase.startsWith('-')).toBe(false);
      expect(phrase.endsWith("'")).toBe(false);
      expect(phrase.endsWith('-')).toBe(false);
      // A trailing period is only valid as the final letter of a
      // period-separated acronym (e.g. `C.D.L.`) — none of this file's
      // entries are acronyms, so no Phrase should end in `.` either.
      expect(phrase.endsWith('.')).toBe(false);
    }
  });

  it('every Phrase is unique (no accidental duplicate rows)', () => {
    const [, ...dataRows] = readRows();
    const phrases = dataRows.map(([phrase]) => phrase);
    expect(new Set(phrases).size).toBe(phrases.length);
  });

  it('every DisplayAs is non-empty', () => {
    const [, ...dataRows] = readRows();
    for (const [, displayAs] of dataRows) {
      expect(displayAs.length).toBeGreaterThan(0);
    }
  });
});
