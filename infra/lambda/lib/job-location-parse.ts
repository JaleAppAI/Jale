/**
 * Pure parser for jobs.location -> jobs.city / jobs.state_region.
 *
 * Backs both the operator backfill script (scripts/backfill-job-geo.ts) and
 * the create/update handlers' city/state_region recompute. Never guesses: an
 * unrecognized shape returns null rather than a best-effort city, because a
 * wrong city/state on a public job page is worse than a missing one.
 */

export interface ParsedJobLocation {
  city: string;
  state_region: string;
}

// Curated bare-city allowlist. A location with no comma and no trailing state
// token (e.g. "Austin") is only trusted against this list -- Jale's footprint
// is Texas, so a bare city name elsewhere in the country must not silently
// resolve to TX.
const TEXAS_CITIES: readonly string[] = [
  'Austin',
  'San Antonio',
  'Houston',
  'Dallas',
  'El Paso',
  'Fort Worth',
  'Round Rock',
  'Georgetown',
  'Pflugerville',
  'Kyle',
  'San Marcos',
  'New Braunfels',
  'Cedar Park',
  'Killeen',
  'Laredo',
  'Corpus Christi',
];

const TEXAS_CITY_CANONICAL_BY_LOWER = new Map(
  TEXAS_CITIES.map((city) => [city.toLowerCase(), city] as const),
);

// Real USPS 2-letter state/territory codes. Validating against this set
// (rather than "any 2 letters") keeps a stray 2-letter word ("Rd", "St") in a
// free-text location from being misread as a state.
const USPS_STATE_CODES = new Set([
  'AL', 'AK', 'AZ', 'AR', 'CA', 'CO', 'CT', 'DE', 'FL', 'GA', 'HI', 'ID', 'IL', 'IN', 'IA',
  'KS', 'KY', 'LA', 'ME', 'MD', 'MA', 'MI', 'MN', 'MS', 'MO', 'MT', 'NE', 'NV', 'NH', 'NJ',
  'NM', 'NY', 'NC', 'ND', 'OH', 'OK', 'OR', 'PA', 'RI', 'SC', 'SD', 'TN', 'TX', 'UT', 'VT',
  'VA', 'WA', 'WV', 'WI', 'WY', 'DC',
]);

// Full state names, at minimum Texas (per spec); the rest are low-cost to
// include and make the parser correct for any employer typing a full name.
const FULL_STATE_NAME_TO_CODE: Record<string, string> = {
  ALABAMA: 'AL', ALASKA: 'AK', ARIZONA: 'AZ', ARKANSAS: 'AR', CALIFORNIA: 'CA',
  COLORADO: 'CO', CONNECTICUT: 'CT', DELAWARE: 'DE', FLORIDA: 'FL', GEORGIA: 'GA',
  HAWAII: 'HI', IDAHO: 'ID', ILLINOIS: 'IL', INDIANA: 'IN', IOWA: 'IA', KANSAS: 'KS',
  KENTUCKY: 'KY', LOUISIANA: 'LA', MAINE: 'ME', MARYLAND: 'MD', MASSACHUSETTS: 'MA',
  MICHIGAN: 'MI', MINNESOTA: 'MN', MISSISSIPPI: 'MS', MISSOURI: 'MO', MONTANA: 'MT',
  NEBRASKA: 'NE', NEVADA: 'NV', 'NEW HAMPSHIRE': 'NH', 'NEW JERSEY': 'NJ',
  'NEW MEXICO': 'NM', 'NEW YORK': 'NY', 'NORTH CAROLINA': 'NC', 'NORTH DAKOTA': 'ND',
  OHIO: 'OH', OKLAHOMA: 'OK', OREGON: 'OR', PENNSYLVANIA: 'PA', 'RHODE ISLAND': 'RI',
  'SOUTH CAROLINA': 'SC', 'SOUTH DAKOTA': 'SD', TENNESSEE: 'TN', TEXAS: 'TX', UTAH: 'UT',
  VERMONT: 'VT', VIRGINIA: 'VA', WASHINGTON: 'WA', 'WEST VIRGINIA': 'WV',
  WISCONSIN: 'WI', WYOMING: 'WY', 'DISTRICT OF COLUMBIA': 'DC',
};

const ZIP_ONLY_RE = /^\d{5}(-\d{4})?$/;

function titleCase(input: string): string {
  return input
    .split(' ')
    .filter(Boolean)
    .map((word) => word[0].toUpperCase() + word.slice(1).toLowerCase())
    .join(' ');
}

/** Resolves a single trailing token (or a whole comma-delimited segment) to a USPS code, or null. */
function resolveStateToken(token: string): string | null {
  const upper = token.trim().toUpperCase();
  if (/^[A-Z]{2}$/.test(upper) && USPS_STATE_CODES.has(upper)) return upper;
  return FULL_STATE_NAME_TO_CODE[upper] ?? null;
}

/**
 * Parses a free-text jobs.location value into {city, state_region}.
 * Recognizes "City, ST", "City, State Name", and "City ST" (comma optional).
 * A bare city with no state token is only resolved via the curated Texas
 * city allowlist. Anything else -- including a bare ZIP -- returns null.
 */
export function parseJobLocation(location: string | null | undefined): ParsedJobLocation | null {
  if (location === null || location === undefined) return null;
  const trimmed = location.trim().replace(/\s+/g, ' ');
  if (!trimmed) return null;

  // A bare ZIP carries no city/state text at all -- never guess one.
  if (ZIP_ONLY_RE.test(trimmed)) return null;

  if (trimmed.includes(',')) {
    const parts = trimmed.split(',').map((p) => p.trim()).filter(Boolean);
    if (parts.length < 2) return null;
    const cityPart = parts.slice(0, -1).join(', ');
    const stateCode = resolveStateToken(parts[parts.length - 1]);
    if (!stateCode || !cityPart) return null;
    return { city: titleCase(cityPart), state_region: stateCode };
  }

  const tokens = trimmed.split(' ');
  if (tokens.length > 1) {
    const stateCode = resolveStateToken(tokens[tokens.length - 1]);
    if (stateCode) {
      const cityPart = tokens.slice(0, -1).join(' ');
      if (cityPart) return { city: titleCase(cityPart), state_region: stateCode };
    }
  }

  const canonical = TEXAS_CITY_CANONICAL_BY_LOWER.get(trimmed.toLowerCase());
  if (canonical) return { city: canonical, state_region: 'TX' };

  return null;
}

const CITY_MAX_LENGTH = 120;
const STATE_REGION_RE = /^[A-Z]{2}$/;

export interface ResolvedJobLocationFields {
  city: string | null;
  state_region: string | null;
}

export type ResolveJobLocationFieldsResult =
  | { ok: true; value: ResolvedJobLocationFields }
  | { ok: false; error: 'invalid_city' | 'invalid_state_region' };

/**
 * Combines the parsed location with optional explicit city/state_region body
 * fields, which win over the parse when present. Used by employer-jobs-create
 * and employer-jobs-update's field-edit path so an employer can always
 * correct a location the parser can't handle.
 */
export function resolveJobLocationFields(
  location: string,
  explicitCity: unknown,
  explicitStateRegion: unknown,
): ResolveJobLocationFieldsResult {
  const parsed = parseJobLocation(location);
  let city: string | null = parsed?.city ?? null;
  let state_region: string | null = parsed?.state_region ?? null;

  if (explicitCity !== undefined && explicitCity !== null) {
    if (typeof explicitCity !== 'string') return { ok: false, error: 'invalid_city' };
    const trimmed = explicitCity.trim();
    if (!trimmed || trimmed.length > CITY_MAX_LENGTH) return { ok: false, error: 'invalid_city' };
    city = trimmed;
  }

  if (explicitStateRegion !== undefined && explicitStateRegion !== null) {
    if (typeof explicitStateRegion !== 'string') return { ok: false, error: 'invalid_state_region' };
    const upper = explicitStateRegion.trim().toUpperCase();
    if (!STATE_REGION_RE.test(upper)) return { ok: false, error: 'invalid_state_region' };
    state_region = upper;
  }

  return { ok: true, value: { city, state_region } };
}
