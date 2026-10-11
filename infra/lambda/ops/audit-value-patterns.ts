/**
 * Value-shaped content in the audit stores.
 *
 * Audit records hold identifiers, codes, field names, counts and times. The
 * only free text is an admin's reveal `reason` and, in the dashboard's frozen
 * action records, a justification, so the export job scans those, and metric
 * filters scan the audit log groups, for three value shapes:
 *
 *   - phone: `+` and 10-15 digits; `(ddd) ddd-dddd`; groups of three, three
 *     and four digits separated by `-`, `.` or white space, in any mix,
 *     bounded by non-word characters;
 *   - email: a local part, `@`, a domain with a dot and a letters-only TLD;
 *   - url: `http://` or `https://`.
 *
 * ONE SOURCE. The patterns are written once, in the regex subset CloudWatch
 * Logs metric filters accept (`%...%`, no parentheses, no spaces, only the
 * documented symbols and operators; `\x28` and `\x29` stand for the
 * parentheses), and the export scanner compiles those same strings. Every
 * construct used means the same thing in both engines, so the scanner and the
 * filters cannot drift apart, and both are tested against one sample table.
 *
 * The non-word boundary is spelled out (`\W` or a line edge) because the
 * subset has no `\b` and no groups.
 */

export const VALUE_KINDS = ['phone', 'email', 'url'] as const;
export type ValueKind = (typeof VALUE_KINDS)[number];

const GROUPED = '\\d{3}[-.\\s]\\d{3}[-.\\s]\\d{4}';

export const CLOUDWATCH_VALUE_PATTERNS: Readonly<Record<ValueKind, string>> = {
  phone: `%${[
    '\\+\\d{10,15}',
    '\\x28\\d{3}\\x29\\s?\\d{3}-\\d{4}',
    `\\W${GROUPED}\\W`,
    `^${GROUPED}\\W`,
    `\\W${GROUPED}$`,
    `^${GROUPED}$`,
  ].join('|')}%`,
  email: '%[\\w.-]+@[\\w-]+\\.[A-Za-z]{2,}%',
  url: '%https?://%',
};

/** The characters the CloudWatch regex subset accepts inside `%...%`. */
const CLOUDWATCH_REGEX_BODY = /^[A-Za-z0-9:_#=@/;,\-^$?[\]{}|\\*+.]+$/;

/**
 * Compiles a CloudWatch `%regex%` pattern for use in JavaScript, refusing
 * anything outside the documented subset.
 */
export function cloudWatchRegexToJs(pattern: string): RegExp {
  const body = pattern.length > 2 && pattern.startsWith('%') && pattern.endsWith('%') ? pattern.slice(1, -1) : '';
  if (!body || body.includes('%') || !CLOUDWATCH_REGEX_BODY.test(body)) {
    throw new Error(`CLOUDWATCH_REGEX_UNSUPPORTED: ${JSON.stringify(pattern)}`);
  }
  return new RegExp(body);
}

const SCANNERS: ReadonlyArray<readonly [ValueKind, RegExp]> = VALUE_KINDS.map(
  (kind) => [kind, cloudWatchRegexToJs(CLOUDWATCH_VALUE_PATTERNS[kind])] as const,
);

/** The value kinds found in `text`, in VALUE_KINDS order, each once. */
export function scanForValues(text: string | null | undefined): ValueKind[] {
  if (typeof text !== 'string' || text.length === 0) return [];
  return SCANNERS.filter(([, regex]) => regex.test(text)).map(([kind]) => kind);
}
