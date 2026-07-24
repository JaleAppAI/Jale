/**
 * Shared assertions for v2 bilingual copy tests, used by both
 * templates.test.ts and interactive-templates.test.ts so the checks
 * cannot drift between the two suites.
 */

/**
 * Matches phrasing that would leak account existence to a worker whose
 * phone number is not yet known to be new or returning (e.g. "welcome
 * back", "your account", "ya tienes cuenta"). Extend this list — do not
 * relax it — if new copy needs a new evasive phrasing checked.
 */
export const ACCOUNT_EXISTENCE_LEAK_PATTERN =
  /existing|already|welcome back|your account|ya tienes|cuenta existente|bienvenido de nuevo|tu cuenta/i;

/** Closed-class words that appear only in the English copy, never the Spanish. */
const EN_ONLY_MARKERS =
  /\b(the|your|and|with|for|please|reply|we|you|to|is|not|have|our|will|it|in)\b/i;

/** Closed-class words that appear only in the Spanish copy, never the English. */
const ES_ONLY_MARKERS =
  /\b(de|el|la|los|las|un|una|y|o|que|para|con|en|tu|te|su|se|del|al|es|no)\b/i;

/**
 * Asserts that `en` reads as English and `es` reads as Spanish by checking
 * for closed-class function words that are exclusive to each language in
 * this copy set. Catches a defect that a plain `en !== es` inequality
 * check would miss: English text pasted into the Spanish slot (or vice
 * versa) that happens to differ from its sibling string.
 */
export function expectDistinctLanguages(en: string, es: string): void {
  expect(en).toMatch(EN_ONLY_MARKERS);
  expect(en).not.toMatch(ES_ONLY_MARKERS);
  expect(es).toMatch(ES_ONLY_MARKERS);
  expect(es).not.toMatch(EN_ONLY_MARKERS);
}
