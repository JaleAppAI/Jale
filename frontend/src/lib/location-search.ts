export interface LocationRecord {
  zip: string;
  city: string;
  state: string;
  lat: number;
  lon: number;
  pop?: number;
}

export type LocationSource = 'geocoded_zip' | 'geocoded_address';

export interface LocationSuggestion {
  label: string;
  cityKey: string;
  zip: string;
  city: string;
  state: string;
  latitude: number;
  longitude: number;
  source: LocationSource;
}

/**
 * Canonical city key. MUST stay in sync with infra/lambda/lib/city-fields.ts
 * (slugifyCityPart + slugCityKey) and the SQL backfill in
 * infra/db/migrations/061_city_keys_and_preferred_cities.sql.
 * 'El Paso'/'TX' -> 'el-paso-tx'.
 *
 * Note: unlike the backend's parseCityFields/parsePreferredCities, this
 * function performs no validation (empty-slug rejection, state format
 * checks, etc.) — the frontend only ever slugs real cities out of the
 * bundled dataset, so every input is already well-formed.
 */
export function slugCityKey(city: string, state: string): string {
  const citySlug = city
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')  // fold diacritics before the dash pass
    .replace(/[^a-zA-Z0-9]+/g, '-')   // strip first, then lower — must match the SQL backfill order
    .toLowerCase()
    .replace(/^-+|-+$/g, '');
  return `${citySlug}-${state.trim().toLowerCase()}`;
}

const ZIP_QUERY = /^\d+$/;

/**
 * Pure, framework-free search. Digits → ZIP prefix match. Text → city name
 * (prefix ranked before contains), deduped to one entry per city+state using
 * the highest-population record as the representative point.
 */
export function searchLocations(
  query: string,
  records: LocationRecord[],
  limit = 8,
): LocationSuggestion[] {
  const q = query.trim();
  if (!q) return [];

  if (ZIP_QUERY.test(q)) {
    return records
      .filter((r) => r.zip.startsWith(q))
      .sort((a, b) => a.zip.localeCompare(b.zip))
      .slice(0, limit)
      .map((r) => ({
        label: `${r.city}, ${r.state} ${r.zip}`,
        cityKey: slugCityKey(r.city, r.state),
        zip: r.zip,
        city: r.city,
        state: r.state,
        latitude: r.lat,
        longitude: r.lon,
        source: 'geocoded_zip' as const,
      }));
  }

  // Diacritic-fold the query only (not record city names, not slugCityKey —
  // the dataset's city names are ASCII, and slugCityKey must stay byte-
  // identical to the backend). Lets 'Española' match dataset 'Espanola'.
  const needle = q.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');

  interface Candidate {
    record: LocationRecord;
    rank: 0 | 1;
  }

  const byCity = new Map<string, Candidate>();
  for (const r of records) {
    const name = r.city.toLowerCase();
    if (!name.includes(needle)) continue;
    const key = `${name}|${r.state}`;
    const rank: 0 | 1 = name.startsWith(needle) ? 0 : 1;
    const existing = byCity.get(key);
    if (!existing || (r.pop ?? 0) > (existing.record.pop ?? 0)) {
      byCity.set(key, { record: r, rank });
    }
  }

  return Array.from(byCity.values())
    .sort((a, b) => {
      const byPrefix = a.rank - b.rank;
      if (byPrefix !== 0) return byPrefix;
      const byPop = (b.record.pop ?? 0) - (a.record.pop ?? 0);
      if (byPop !== 0) return byPop;
      return a.record.city.localeCompare(b.record.city) || a.record.state.localeCompare(b.record.state);
    })
    .map(({ record: r }) => r)
    .slice(0, limit)
    .map((r) => ({
      label: `${r.city}, ${r.state}`,
      cityKey: slugCityKey(r.city, r.state),
      zip: r.zip,
      city: r.city,
      state: r.state,
      latitude: r.lat,
      longitude: r.lon,
      source: 'geocoded_address' as const,
    }));
}

let cache: LocationRecord[] | null = null;
let loadFailed = false;

/** Lazily import the bundled dataset (code-split into its own chunk). Memoized. */
export async function loadLocationRecords(): Promise<LocationRecord[]> {
  if (cache) return cache;
  try {
    const mod = await import('@/data/us-locations.json');
    cache = (mod.default ?? mod) as unknown as LocationRecord[];
    loadFailed = false;
    return cache;
  } catch (err) {
    loadFailed = true;
    throw err;
  }
}

/** True when the dataset failed to load — forms then accept free text instead of requiring a pick. */
export function locationDatasetFailed(): boolean {
  return loadFailed;
}

/** Convenience: load (once) then search. Returns [] for empty queries. */
export async function queryLocations(query: string, limit = 8): Promise<LocationSuggestion[]> {
  if (!query.trim()) return [];
  const records = await loadLocationRecords();
  return searchLocations(query, records, limit);
}
