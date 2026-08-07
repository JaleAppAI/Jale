// Canonical city identity shared by jobs and worker_preferred_cities.
// The slug rule must stay in sync with frontend/src/lib/location-search.ts
// (slugCityKey) and the backfill in migration 061.

export interface CityFields {
  city_key: string;
  city: string;
  state: string;
}

// Matches the SQL backfill in migration 061: strip non-alphanumerics to '-'
// FIRST (over the original, mixed-case string), then lowercase, then trim
// leading/trailing '-'. Order matters for Unicode (e.g. 'İzmir').
function slugifyCityPart(city: string): string {
  return city
    .replace(/[^a-zA-Z0-9]+/g, '-')
    .toLowerCase()
    .replace(/^-+|-+$/g, '');
}

export function slugCityKey(city: string, state: string): string {
  return `${slugifyCityPart(city)}-${state.trim().toLowerCase()}`;
}

// Mirrors the SQL backfill parse in migrations 061/063 -- keep the three in
// sync. Accepts "City, ST" and "City, ST 12345[-6789]"; anything else is
// null (never guess -- a wrong city surfaces the job in the wrong feed).
const LOCATION_CITY_RE = /^\s*([A-Za-z][A-Za-z .'-]*?)\s*,\s*([A-Za-z]{2})(?:\s+\d{5}(?:-\d{4})?)?\s*$/;

export function parseCityFromLocation(location: string): CityFields | null {
  // JS \s is wider than Postgres [[:space:]] (NBSP etc.) -- collapsing all
  // whitespace runs to single spaces keeps this a superset of the SQL parse
  // that can never produce a DIFFERENT key for inputs both engines match.
  const normalized = location.replace(/\s+/g, ' ');
  const match = LOCATION_CITY_RE.exec(normalized);
  if (!match) return null;
  const city = match[1].trim();
  const state = match[2].toUpperCase();
  if (slugifyCityPart(city).length === 0) return null;
  return { city_key: slugCityKey(city, state), city, state };
}

const STATE_RE = /^[A-Za-z]{2}$/;
const MAX_CITY_LENGTH = 100;

type Ok<T> = { ok: true; value: T };
type Err = { ok: false; error: string };

function parseOne(item: Record<string, unknown>): Ok<CityFields> | Err {
  const { city_key, city, state } = item as { city_key?: unknown; city?: unknown; state?: unknown };
  if (
    typeof city_key !== 'string' || typeof city !== 'string' || typeof state !== 'string'
    || city.trim().length === 0 || city.trim().length > MAX_CITY_LENGTH
    || !STATE_RE.test(state)
  ) {
    return { ok: false, error: 'invalid_city_fields' };
  }
  const normalized: CityFields = { city_key, city: city.trim(), state: state.toUpperCase() };
  const citySlugPart = slugifyCityPart(normalized.city);
  if (citySlugPart.length === 0) {
    return { ok: false, error: 'invalid_city_fields' };
  }
  if (`${citySlugPart}-${normalized.state.toLowerCase()}` !== city_key) {
    return { ok: false, error: 'invalid_city_key' };
  }
  return { ok: true, value: normalized };
}

/**
 * All-or-none parse of city_key/city/state on a request body.
 * ok+null   → neither city_key nor state present (legal: either the degraded
 *             picker sent nothing, or the caller is using the SEO channel's
 *             `city`-only/`state_region` fields instead).
 * ok+value  → consistent, normalized triple.
 * error     → city_key or state present without a full, consistent triple.
 */
export function parseCityFields(body: Record<string, unknown>): Ok<CityFields | null> | Err {
  const hasKeyOrState = ['city_key', 'state'].some((k) => Object.prototype.hasOwnProperty.call(body, k) && body[k] !== null && body[k] !== undefined);
  if (!hasKeyOrState) return { ok: true, value: null };
  const present = ['city_key', 'city', 'state'].filter((k) => Object.prototype.hasOwnProperty.call(body, k) && body[k] !== null && body[k] !== undefined);
  if (present.length !== 3) return { ok: false, error: 'invalid_city_fields' };
  return parseOne(body);
}

const MAX_PREFERRED_CITIES = 10;

export interface PreferredCityFields extends CityFields {
  latitude: number | null;
  longitude: number | null;
}

// Null and absent both mean "no coordinate": pre-064 rows round-trip through
// GET -> PATCH as latitude/longitude null, and that must stay a valid save.
function parseCoordinatePair(raw: Record<string, unknown>): Ok<{ latitude: number | null; longitude: number | null }> | Err {
  const latitude = (raw.latitude ?? null) as number | null;
  const longitude = (raw.longitude ?? null) as number | null;
  if (latitude === null && longitude === null) return { ok: true, value: { latitude: null, longitude: null } };
  if (
    typeof latitude !== 'number' || !Number.isFinite(latitude) || latitude < -90 || latitude > 90
    || typeof longitude !== 'number' || !Number.isFinite(longitude) || longitude < -180 || longitude > 180
  ) {
    return { ok: false, error: 'invalid_preferred_cities' };
  }
  return { ok: true, value: { latitude, longitude } };
}

/** Validates a preferred-cities replacement list: each item a full triple, deduped, max 10. */
export function parsePreferredCities(items: unknown): Ok<PreferredCityFields[]> | Err {
  if (!Array.isArray(items)) return { ok: false, error: 'invalid_preferred_cities' };
  const out: PreferredCityFields[] = [];
  const seen = new Set<string>();
  for (const raw of items) {
    if (typeof raw !== 'object' || raw === null) return { ok: false, error: 'invalid_preferred_cities' };
    const parsed = parseOne(raw as Record<string, unknown>);
    if (!parsed.ok) return { ok: false, error: 'invalid_preferred_cities' };
    const coords = parseCoordinatePair(raw as Record<string, unknown>);
    if (!coords.ok) return coords;
    if (seen.has(parsed.value.city_key)) continue;
    seen.add(parsed.value.city_key);
    out.push({ ...parsed.value, ...coords.value });
  }
  if (out.length > MAX_PREFERRED_CITIES) return { ok: false, error: 'too_many_preferred_cities' };
  return { ok: true, value: out };
}
