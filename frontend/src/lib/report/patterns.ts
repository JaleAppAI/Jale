/**
 * Address patterns for problem reports: a screen or a request described by its
 * shape, never by the values in it. "/worker/jobs/<uuid>/apply?x=1" is kept as
 * "/worker/jobs/:id/apply".
 *
 * Every segment is either a plain route word or a placeholder:
 *   - a UUID becomes `:id` (a record reference the team can open);
 *   - a 64-hex value becomes `:token`, and so does whatever follows `/upload/`;
 *   - the job code after `/j/` or `/public/jobs/` becomes `:code`;
 *   - a run of digits becomes `:n`;
 *   - anything else that is not a plain lowercase word becomes `:value`.
 * Query strings and fragments are dropped.
 */

export const MAX_PATTERN_LENGTH = 200;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const HEX_64 = /^[0-9a-f]{64}$/i;
const DIGITS = /^\d+$/;
/** Letters only, optionally joined by single hyphens or underscores. */
const ROUTE_WORD = /^[a-z]+(?:[-_][a-z]+)*$/;
const ABSOLUTE_URL = /^[a-z][a-z0-9+.-]*:\/\/[^/?#]*/i;

/** Route params whose values are secrets: never kept as refs, whatever their shape. */
const SECRET_PARAMS = new Set(['token', 'code']);

export type RouteParams = Record<string, string | string[] | undefined>;

function withoutQuery(value: string): string {
  return value.split(/[?#]/, 1)[0];
}

function segmentsOf(path: string): string[] {
  return path.split('/').filter((segment) => segment !== '');
}

function decode(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

/** The placeholder a segment's position forces, whatever the segment holds. */
function positional(segments: string[], index: number): string | null {
  const previous = segments[index - 1];
  if (previous === 'upload') return ':token';
  if (previous === 'j') return ':code';
  if (previous === 'jobs' && segments[index - 2] === 'public') return ':code';
  return null;
}

function bySegmentShape(segment: string): string {
  if (UUID.test(segment)) return ':id';
  if (DIGITS.test(segment)) return ':n';
  if (HEX_64.test(segment)) return ':token';
  if (ROUTE_WORD.test(segment)) return segment;
  return ':value';
}

function join(segments: string[]): string {
  return `/${segments.join('/')}`.slice(0, MAX_PATTERN_LENGTH);
}

/**
 * The pattern of a screen, from next-intl's locale-free pathname and the
 * route's `useParams()`. Each param value is swapped back to its `[name]`, and
 * refs keep the UUID values the team can use to open the same record.
 */
export function routePattern(
  pathname: string,
  params: RouteParams = {},
): { pattern: string; refs: Record<string, string> } {
  const segments = segmentsOf(withoutQuery(pathname ?? ''));
  const entries = Object.entries(params ?? {}).filter(([name]) => name !== 'locale');

  // A localised pathname, should one arrive, loses the locale it names.
  const locale = params?.locale;
  if (typeof locale === 'string' && segments[0] === locale) segments.shift();

  const decoded = segments.map(decode);
  const out: Array<string | null> = segments.map(() => null);
  const ownerOf: Array<string | null> = segments.map(() => null);
  const refs: Record<string, string> = {};

  for (const [name, value] of entries) {
    if (Array.isArray(value)) {
      // A catch-all: its run of segments becomes one `:name`.
      if (value.length === 0) continue;
      for (let start = decoded.length - value.length; start >= 0; start--) {
        const run = decoded.slice(start, start + value.length);
        const free = out.slice(start, start + value.length).every((segment) => segment === null);
        if (!free || run.some((segment, i) => segment !== value[i])) continue;
        out[start] = `:${name}`;
        for (let i = 1; i < value.length; i++) out[start + i] = '';
        break;
      }
      continue;
    }
    if (typeof value !== 'string' || value === '') continue;
    const index = decoded.lastIndexOf(value);
    if (index < 0 || out[index] !== null) continue;
    out[index] = `:${name}`;
    ownerOf[index] = name;
    if (UUID.test(value) && !SECRET_PARAMS.has(name)) refs[name] = value;
  }

  for (let i = 0; i < segments.length; i++) {
    // Already folded into a catch-all's `:name`.
    if (out[i] === '') continue;
    const forced = positional(segments, i);
    if (forced !== null) {
      // The position wins over whatever the params said, and takes any ref with it.
      const owner = ownerOf[i];
      if (owner !== null) delete refs[owner];
      out[i] = forced;
      continue;
    }
    if (out[i] === null) out[i] = bySegmentShape(decoded[i]);
  }

  return { pattern: join(out.filter((segment): segment is string => segment !== '' && segment !== null)), refs };
}

/** The path part of `NEXT_PUBLIC_API_BASE_URL` (for example `/api`), read at call time. */
function apiBasePath(): string {
  const base = process.env.NEXT_PUBLIC_API_BASE_URL;
  if (!base) return '';
  const path = withoutQuery(base).replace(ABSOLUTE_URL, '');
  return path.replace(/\/+$/, '');
}

/**
 * The pattern of a request. `url` may be an API path or an absolute URL; both
 * lose the origin and the API base path, so the same route always reads the
 * same way. The literal `s3:upload` is already a pattern and is kept as it is.
 */
export function apiPathPattern(url: string): string {
  if (url === 's3:upload') return url;
  let path = withoutQuery(String(url ?? '')).replace(ABSOLUTE_URL, '');
  const basePath = apiBasePath();
  if (basePath !== '' && (path === basePath || path.startsWith(`${basePath}/`))) {
    path = path.slice(basePath.length);
  }
  const segments = segmentsOf(path);
  return join(segments.map((segment, i) => positional(segments, i) ?? bySegmentShape(decode(segment))));
}
