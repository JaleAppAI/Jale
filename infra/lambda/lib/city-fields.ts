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
 * ok+null   → none of the three fields present (legal: degraded picker).
 * ok+value  → consistent, normalized triple.
 * error     → partial or invalid input.
 */
export function parseCityFields(body: Record<string, unknown>): Ok<CityFields | null> | Err {
  const present = ['city_key', 'city', 'state'].filter((k) => Object.prototype.hasOwnProperty.call(body, k) && body[k] !== null && body[k] !== undefined);
  if (present.length === 0) return { ok: true, value: null };
  if (present.length !== 3) return { ok: false, error: 'invalid_city_fields' };
  return parseOne(body);
}

const MAX_PREFERRED_CITIES = 10;

/** Validates a preferred-cities replacement list: each item a full triple, deduped, max 10. */
export function parsePreferredCities(items: unknown): Ok<CityFields[]> | Err {
  if (!Array.isArray(items)) return { ok: false, error: 'invalid_preferred_cities' };
  const out: CityFields[] = [];
  const seen = new Set<string>();
  for (const raw of items) {
    if (typeof raw !== 'object' || raw === null) return { ok: false, error: 'invalid_preferred_cities' };
    const parsed = parseOne(raw as Record<string, unknown>);
    if (!parsed.ok) return { ok: false, error: 'invalid_preferred_cities' };
    if (seen.has(parsed.value.city_key)) continue;
    seen.add(parsed.value.city_key);
    out.push(parsed.value);
  }
  if (out.length > MAX_PREFERRED_CITIES) return { ok: false, error: 'too_many_preferred_cities' };
  return { ok: true, value: out };
}
