import * as fs from 'fs';
import * as path from 'path';
import { TRUST_OPTION_LABELS_ES, buildTrustQuestion } from '../../../../../lambda/whatsapp/lib/flows';

/**
 * Drift guard, not a behavior test.
 *
 * `frontend/src/lib/trust-assessment.ts` hand-mirrors two things from this
 * package (see the comment above its `MENU_LABEL_ES`):
 *   1. Every `TRUST_OPTION_LABELS_ES` English->Spanish menu-option pair.
 *   2. The literal `'Reply with the number'` marker flows.ts's English trust
 *      question templates always end with, which the frontend uses to
 *      recognize a menu-style answer (`isMenuAnswer`).
 *
 * Nothing in the type system enforces either mirror stays in sync -- a
 * change to either side here silently breaks the employer trust panel's
 * Spanish labels or its menu-answer detection without a compile error. This
 * test reads both sources' actual text so CI fails the moment they drift,
 * instead of leaving it to be noticed in the UI.
 */

const FRONTEND_TRUST_ASSESSMENT_PATH = path.resolve(
  __dirname,
  '../../../../../../frontend/src/lib/trust-assessment.ts',
);

function readFrontendSource(): string {
  return fs.readFileSync(FRONTEND_TRUST_ASSESSMENT_PATH, 'utf8');
}

/** Matches how both sources format an object entry: bare identifier when the
 *  key is a valid one, quoted otherwise (e.g. `Framing: 'Framing',` vs.
 *  `'Drain/sewer': 'Drenaje',`) -- verbatim per the frontend file's own
 *  comment that it's a mirror. */
const VALID_IDENTIFIER_RE = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

function formatPair(key: string, label: string): string {
  const formattedKey = VALID_IDENTIFIER_RE.test(key) ? key : `'${key}'`;
  return `${formattedKey}: '${label}'`;
}

describe('trust panel frontend/backend parity', () => {
  it('mirrors every TRUST_OPTION_LABELS_ES pair from flows.ts', () => {
    const frontendSource = readFrontendSource();
    const missing = Object.entries(TRUST_OPTION_LABELS_ES)
      .map(([key, label]) => formatPair(key, label))
      .filter((pair) => !frontendSource.includes(pair));
    expect(missing).toEqual([]);
  });

  it('carries the "Reply with the number" menu marker on both sides', () => {
    // All three trust question steps (specialization, seniority, tasks), in
    // English, must end with this marker -- it's what the frontend's
    // `isMenuAnswer` keys off of to recognize a stored answer as a menu pick
    // rather than free text or a voice transcript.
    for (let step = 0; step < 3; step++) {
      const question = buildTrustQuestion(step, 'electrician', 'en');
      expect(question).toContain('Reply with the number');
    }
    const frontendSource = readFrontendSource();
    expect(frontendSource).toContain('Reply with the number');
  });
});
