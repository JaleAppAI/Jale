import type { PoolClient } from 'pg';
import { normalizeProfession } from './profession';

export interface WorkerMatchProfile {
  id: string;
  main_trade: string | null;
  main_trade_other: string | null;
  years_experience: string | number | null;
  availability: string | null;
  city: string | null;
  profile_location: string | null;
  latitude: string | number | null;
  longitude: string | number | null;
  /** Loaded alongside the profile row (single-query consolidation) so
   * scoring/alias-lookup never needs a second round trip. */
  worker_skills?: string[] | null;
  /** `COALESCE(latest_job_id, first_job_id)` from `worker_attribution`,
   * loaded via LEFT JOIN on the same query. Null when the worker has no
   * referral attribution on record. */
  attributed_job_id?: string | null;
}

export interface MatchableJobRow {
  id: string;
  title: string;
  company: string | null;
  location: string;
  pay: string | null;
  job_type: string;
  description: string | null;
  required_docs?: string[] | null;
  created_at: string | Date;
  pay_min?: string | number | null;
  pay_max?: string | number | null;
  /** Additive (Task 4, WhatsApp pay localization): not derived from
   * `formatPayRange()`/the stored `pay` column, read directly off `jobs`. */
  pay_interval?: string | null;
  /** Additive (Task 4): the raw `jobs.pay` value, BEFORE the
   * `COALESCE(pay, 'Pay not specified')` this query applies to `pay` above.
   * Pre-023 jobs can carry a genuine free-text `pay` with null pay_min/max
   * (pay was a plain TEXT column from migration 003 until pay_min/pay_max
   * were added in 023) -- callers that want to distinguish "no legacy pay at
   * all" from "the English placeholder the SQL already baked in" need this
   * undecorated value instead of the `pay` column. */
  pay_raw?: string | null;
  start_date?: string | Date | null;
  expected_duration?: string | null;
  shift_schedule?: string | null;
  transportation_required?: boolean | null;
  language_preference?: string[] | null;
  number_of_workers_needed?: string | number | null;
  workers_hired?: string | number | null;
  trade_category?: string | null;
  required_experience_years?: string | number | null;
  certifications?: string[] | null;
  latitude: string | number | null;
  longitude: string | number | null;
}

export interface MatchComponents {
  profession: number;
  location: number;
  experience: number;
  availability: number;
  freshness: number;
}

export interface MatchedJob {
  id: string;
  title: string;
  company: string;
  location: string;
  pay: string;
  job_type: string;
  required_docs?: string[] | null;
  created_at: string | Date;
  pay_min?: string | number | null;
  pay_max?: string | number | null;
  /** Additive (Task 4, WhatsApp pay localization). */
  pay_interval?: string | null;
  /** Additive (Task 4) -- see `MatchableJobRow.pay_raw`. */
  pay_raw?: string | null;
  start_date?: string | Date | null;
  expected_duration?: string | null;
  shift_schedule?: string | null;
  transportation_required?: boolean | null;
  language_preference?: string[] | null;
  number_of_workers_needed?: string | number | null;
  hired_count?: string | number | null;
  open_count?: number;
  trade_category?: string | null;
  required_experience_years?: string | number | null;
  certifications?: string[] | null;
  match_score: number;
  match_components: MatchComponents;
  match_reasons: string[];
}

export interface ScoredJobCandidate extends MatchedJob {
  score: number;
  components: MatchComponents;
  reasons: string[];
}

export interface ListMatchedJobsOptions {
  limit: number;
  channel: 'api' | 'whatsapp';
  search?: string;
  jobType?: string;
  /** Strict filter: only jobs whose city_key is in this list. Applied in SQL
   * (not post-scoring) so workers in low-volume cities aren't starved by the
   * recency-ordered candidate cap. */
  cityKeys?: string[];
  /** Fallback query: only jobs whose city_key is NOT in this list (or NULL). */
  excludeCityKeys?: string[];
  /** Preferred-city centroids (migration 068): distance scoring anchors in
   * addition to the worker's own coordinate. They describe the worker, not
   * the filter -- pass them on fallback (excludeCityKeys) queries too. */
  cityAnchors?: CityAnchor[];
}

/** A row from `trade_aliases` (migration 060) -- the self-growing bilingual
 * trade-alias cache. `aliases` and both canonical names are stored
 * pre-normalized via `normalizeProfession()`. */
export interface TradeAliasRow {
  trade_key: string;
  canonical_en: string;
  canonical_es: string;
  aliases: string[];
  trade_category: string | null;
}

/** Resolved profession-matching inputs for ONE worker, computed once per
 * `listMatchedJobsForWorker` call and threaded through as a plain parameter
 * object so `scoreJobCandidate`/`scoreProfession` stay pure (no DB access). */
export interface WorkerProfessionContext {
  /** Full term pool (legacy fallback terms UNION strongTerms) used only by
   * the substring/hit-counting fallback rule -- unchanged from before this
   * task, so a `trade_aliases` cache miss/failure degrades exactly to the
   * old behavior. */
  terms: string[];
  /** Terms confirmed by an actual matched `trade_aliases` row (its aliases
   * and canonical names). Only THESE are eligible for the length >= 4
   * whole-phrase upgrade to a full score -- a generic free-text word that
   * merely split out of unmatched input is not a confirmed signal. */
  strongTerms: string[];
  categories: string[];
}

const PROFESSION_ALIASES: Record<string, string[]> = {
  electrician: ['electrician', 'electrical', 'wire', 'wiring', 'panel', 'journeyman'],
  plumber: ['plumber', 'plumbing', 'pipe', 'pipes', 'fixture', 'fixtures'],
  carpenter: ['carpenter', 'carpentry', 'framer', 'framing', 'wood', 'trim'],
  concrete: ['concrete', 'cement', 'rebar', 'formwork', 'finisher'],
  painting: ['painter', 'painting', 'paint', 'spray', 'roller'],
  drywall: ['drywall', 'drywaller', 'sheetrock', 'taper', 'taping', 'mud', 'texture', 'hanger', 'tablaroca'],
};

const TRADE_TO_PROFESSION: Record<string, string> = {
  electrician: 'electrician',
  plumber: 'plumber',
  carpenter: 'carpenter',
  concrete: 'concrete',
  painting: 'painting',
  drywall: 'drywall',
};

export function extractZip(value: string | null | undefined): string | null {
  const match = value?.match(/\b\d{5}(?:-\d{4})?\b/);
  return match ? match[0].slice(0, 5) : null;
}

// Accent-fold (NFD, strip combining marks) BEFORE lowercase/punctuation
// stripping so accented free text (e.g. worker-entered 'Albanil' with an accent) collapses onto its unaccented
// form ('albanil') exactly like `normalizeProfession()` in lib/profession.ts.
function cleanText(value: string | null | undefined): string {
  return (value ?? '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function normalizeProfessionText(value: string | null | undefined): string {
  let text = cleanText(value);
  for (const [canonical, aliases] of Object.entries(PROFESSION_ALIASES)) {
    for (const alias of aliases) {
      if (text.includes(alias)) {
        text += ` ${canonical}`;
      }
    }
  }
  return text;
}

function workerProfessionTerms(worker: WorkerMatchProfile): string[] {
  if (worker.main_trade && worker.main_trade !== 'other') {
    const canonical = TRADE_TO_PROFESSION[worker.main_trade] ?? worker.main_trade;
    return Array.from(new Set([canonical, ...(PROFESSION_ALIASES[canonical] ?? [])]));
  }

  const normalized = normalizeProfessionText(worker.main_trade_other);
  for (const canonical of Object.keys(PROFESSION_ALIASES)) {
    if (normalized.includes(canonical)) {
      return Array.from(new Set([canonical, ...PROFESSION_ALIASES[canonical]]));
    }
  }
  return Array.from(new Set(normalized.split(' ').filter((term) => term.length >= 3)));
}

/**
 * Builds the profession-matching term/category sets for a worker: the
 * legacy English-only alias terms (always included, so a cache miss/failure
 * degrades to prior behavior) UNIONED with whatever the bilingual
 * `trade_aliases` cache resolved (aliases + canonical names + trade_category
 * of every matched row). Pure -- no DB access; `aliasRows` is looked up by
 * the caller (see `lookupTradeAliases`).
 */
export function buildWorkerProfessionContext(
  worker: WorkerMatchProfile,
  aliasRows: TradeAliasRow[] = [],
): WorkerProfessionContext {
  const terms = new Set<string>(workerProfessionTerms(worker));
  const strongTerms = new Set<string>();
  const categories = new Set<string>();

  // Strict lookup (no `?? worker.main_trade` fallback): only a trade this
  // repo actually knows how to bridge to a job's enum column resolves here.
  // An unmapped standardized trade must never silently claim a category
  // match -- this is the concrete bug the missing 'drywall' entry above was.
  if (worker.main_trade && worker.main_trade !== 'other') {
    const category = TRADE_TO_PROFESSION[worker.main_trade];
    if (category) categories.add(category);
  }

  for (const row of aliasRows) {
    for (const alias of row.aliases ?? []) {
      const cleaned = cleanText(alias);
      if (cleaned) {
        terms.add(cleaned);
        strongTerms.add(cleaned);
      }
    }
    const canonicalEn = cleanText(row.canonical_en);
    const canonicalEs = cleanText(row.canonical_es);
    if (canonicalEn) {
      terms.add(canonicalEn);
      strongTerms.add(canonicalEn);
    }
    if (canonicalEs) {
      terms.add(canonicalEs);
      strongTerms.add(canonicalEs);
    }
    if (row.trade_category) categories.add(row.trade_category);
  }

  return {
    terms: Array.from(terms),
    strongTerms: Array.from(strongTerms),
    categories: Array.from(categories),
  };
}

/** Whole-phrase (word-boundary-safe) containment check over already-cleaned,
 * single-spaced text: pads both sides with spaces so a short alias like
 * "wire" cannot match inside an unrelated longer word. */
function containsWholePhrase(text: string, phrase: string): boolean {
  return ` ${text} `.includes(` ${phrase} `);
}

function scoreProfession(job: MatchableJobRow, context: WorkerProfessionContext, reasons: string[]): number {
  const { terms, strongTerms, categories } = context;
  if (terms.length === 0 && categories.length === 0) {
    return 0;
  }

  // (a) True enum-to-enum match: the job's own trade_category is one the
  // worker resolved to (directly, or via a matched trade_aliases row).
  if (job.trade_category && categories.includes(job.trade_category)) {
    reasons.push('profession_exact_or_alias');
    return 50;
  }

  const jobText = normalizeProfessionText(`${job.title} ${job.trade_category ?? ''} ${job.description ?? ''}`);

  // (b) A single but strong (length >= 4) alias/canonical term CONFIRMED by
  // a matched trade_aliases row, appearing as a whole word/phrase, is exact
  // enough on its own to award the full score. Deliberately narrower than
  // `terms`: on a cache miss/failure `strongTerms` is empty, so this rule
  // never fires and scoring degrades exactly to rule (c) below (unchanged
  // legacy behavior).
  if (strongTerms.some((term) => term.length >= 4 && containsWholePhrase(jobText, term))) {
    reasons.push('profession_exact_or_alias');
    return 50;
  }

  // (c) Legacy fallback: two or more (possibly weak/substring) term hits.
  const hits = terms.filter((term) => jobText.includes(term));
  if (hits.length >= 2) {
    reasons.push('profession_exact_or_alias');
    return 50;
  }
  if (hits.length === 1) {
    reasons.push('profession_partial');
    return 32;
  }
  return 0;
}

function toNumber(value: string | number | null | undefined): number | null {
  if (value === null || value === undefined) {
    return null;
  }
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(n) ? n : null;
}

function distanceMiles(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const rad = Math.PI / 180;
  const dLat = (lat2 - lat1) * rad;
  const dLon = (lon2 - lon1) * rad;
  const a = Math.sin(dLat / 2) ** 2
    + Math.cos(lat1 * rad) * Math.cos(lat2 * rad) * Math.sin(dLon / 2) ** 2;
  return 3958.8 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function distanceTierScore(miles: number): { score: number; reason: string } | null {
  if (miles <= 5) return { score: 30, reason: 'distance_under_5_miles' };
  if (miles <= 15) return { score: 24, reason: 'distance_under_15_miles' };
  if (miles <= 30) return { score: 16, reason: 'distance_under_30_miles' };
  if (miles <= 50) return { score: 8, reason: 'distance_under_50_miles' };
  return null;
}

function zipOrTextScore(worker: WorkerMatchProfile, job: MatchableJobRow): { score: number; reason: string } | null {
  const workerZip = extractZip(worker.profile_location) ?? extractZip(worker.city);
  const jobZip = extractZip(job.location);
  if (workerZip && jobZip && workerZip === jobZip) {
    return { score: 30, reason: 'zip_exact' };
  }
  const workerLocation = cleanText(worker.profile_location ?? worker.city);
  const jobLocation = cleanText(job.location);
  if (workerLocation && jobLocation && (jobLocation.includes(workerLocation) || workerLocation.includes(jobLocation))) {
    return { score: 18, reason: 'location_text_match' };
  }
  return null;
}

function scoreLocation(
  worker: WorkerMatchProfile,
  job: MatchableJobRow,
  reasons: string[],
  anchors: CityAnchor[] = [],
): number {
  const workerLat = toNumber(worker.latitude);
  const workerLon = toNumber(worker.longitude);
  const jobLat = toNumber(job.latitude);
  const jobLon = toNumber(job.longitude);
  const hasOwnCoordinate = workerLat !== null && workerLon !== null;

  const points: CityAnchor[] = hasOwnCoordinate
    ? [{ latitude: workerLat, longitude: workerLon }, ...anchors]
    : [...anchors];

  let distance: { score: number; reason: string } | null = null;
  if (jobLat !== null && jobLon !== null && points.length > 0) {
    const miles = Math.min(...points.map((p) => distanceMiles(p.latitude, p.longitude, jobLat, jobLon)));
    distance = distanceTierScore(miles);
  }

  // A worker with a real coordinate keeps the legacy distance-only branch
  // (now min-over-anchors): coordinates are strictly better information
  // than ZIP/text, exactly as before this change.
  if (hasOwnCoordinate && jobLat !== null && jobLon !== null) {
    if (distance) reasons.push(distance.reason);
    return distance?.score ?? 0;
  }

  // No own coordinate: anchors must only ever ADD signal. Take the better
  // of the anchor-distance tier and the legacy ZIP/text fallback so a
  // worker whose anchors are all far keeps their zip_exact/text points.
  const fallback = zipOrTextScore(worker, job);
  const winner = (distance?.score ?? 0) >= (fallback?.score ?? 0) ? distance : fallback;
  if (winner) reasons.push(winner.reason);
  return winner?.score ?? 0;
}

function workerYears(value: string | number | null): number | null {
  if (value === null) {
    return null;
  }
  if (typeof value === 'number') {
    return value;
  }
  if (value === '0-1') {
    return 1;
  }
  if (value === '2-4') {
    return 3;
  }
  if (value === '5-9') {
    return 7;
  }
  if (value === '10+') {
    return 10;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function requiredYears(job: MatchableJobRow): number | null {
  const explicitRequired = toNumber(job.required_experience_years);
  if (explicitRequired !== null) {
    return explicitRequired;
  }

  const text = cleanText(`${job.title} ${job.description ?? ''}`);
  const match = text.match(/\b(\d{1,2})\s*\+?\s*(?:years|yrs|anos|anios)\b/);
  return match ? Number(match[1]) : null;
}

function scoreExperience(worker: WorkerMatchProfile, job: MatchableJobRow, reasons: string[]): number {
  const required = requiredYears(job);
  const years = workerYears(worker.years_experience);
  if (required === null) {
    return 6;
  }
  if (years !== null && years >= required) {
    reasons.push('experience_meets_requirement');
    return 10;
  }
  return 2;
}

function scoreAvailability(worker: WorkerMatchProfile, job: MatchableJobRow, reasons: string[]): number {
  if (!worker.availability) {
    return 0;
  }
  if (worker.availability === 'flexible') {
    reasons.push('availability_flexible');
    return 5;
  }
  if (worker.availability === 'full_time' && job.job_type === 'full-time') {
    reasons.push('availability_matches_job_type');
    return 5;
  }
  if (worker.availability === 'part_time' && job.job_type === 'part-time') {
    reasons.push('availability_matches_job_type');
    return 5;
  }
  if (worker.availability === 'weekends' && job.job_type === 'contract') {
    reasons.push('availability_adjacent');
    return 3;
  }
  return 0;
}

function scoreFreshness(job: MatchableJobRow, now: Date, reasons: string[]): number {
  const created = job.created_at instanceof Date ? job.created_at : new Date(job.created_at);
  const ageDays = (now.getTime() - created.getTime()) / 86_400_000;
  if (ageDays <= 7) {
    reasons.push('fresh_posting');
    return 5;
  }
  if (ageDays <= 30) {
    return 3;
  }
  return 0;
}

export function scoreJobCandidate(
  worker: WorkerMatchProfile,
  job: MatchableJobRow,
  now = new Date(),
  context: WorkerProfessionContext = buildWorkerProfessionContext(worker),
  anchors: CityAnchor[] = [],
): ScoredJobCandidate {
  const reasons: string[] = [];
  const components: MatchComponents = {
    profession: scoreProfession(job, context, reasons),
    location: scoreLocation(worker, job, reasons, anchors),
    experience: scoreExperience(worker, job, reasons),
    availability: scoreAvailability(worker, job, reasons),
    freshness: scoreFreshness(job, now, reasons),
  };
  const score = Object.values(components).reduce((sum, value) => sum + value, 0);
  const matchScore = Math.round(score);

  return {
    id: job.id,
    title: job.title,
    company: job.company ?? 'Jale',
    location: job.location,
    pay: job.pay ?? 'Pay not specified',
    job_type: job.job_type,
    required_docs: job.required_docs ?? null,
    created_at: job.created_at,
    pay_min: job.pay_min,
    pay_max: job.pay_max,
    pay_interval: job.pay_interval,
    pay_raw: job.pay_raw,
    start_date: job.start_date,
    expected_duration: job.expected_duration,
    shift_schedule: job.shift_schedule,
    transportation_required: job.transportation_required,
    language_preference: job.language_preference,
    number_of_workers_needed: job.number_of_workers_needed,
    hired_count: job.workers_hired,
    open_count: Math.max(0, Number(job.number_of_workers_needed ?? 0) - Number(job.workers_hired ?? 0)),
    trade_category: job.trade_category,
    required_experience_years: job.required_experience_years,
    certifications: job.certifications,
    match_score: matchScore,
    match_components: components,
    match_reasons: reasons,
    score: matchScore,
    components,
    reasons,
  };
}

function workerHasProfessionData(worker: WorkerMatchProfile): boolean {
  return Boolean(
    (worker.main_trade && worker.main_trade !== 'other')
    || worker.main_trade_other?.trim()
  );
}

type CoordinateTable = 'worker_profiles' | 'jobs' | 'worker_preferred_cities';

async function coordinateSelects(
  client: PoolClient,
  tableName: CoordinateTable,
  tableAlias: string,
): Promise<{ latitude: string; longitude: string }> {
  const result = await client.query<{ column_name: string }>(
    `SELECT column_name
       FROM information_schema.columns
      WHERE table_schema = current_schema()
        AND table_name = $1
        AND column_name = ANY($2::text[])`,
    [tableName, ['latitude', 'longitude']],
  );
  const columns = new Set(result.rows.map((row) => row.column_name));

  return {
    latitude: columns.has('latitude') ? `${tableAlias}.latitude` : 'NULL::numeric',
    longitude: columns.has('longitude') ? `${tableAlias}.longitude` : 'NULL::numeric',
  };
}

/** Builds the normalized key set used to probe `trade_aliases`: the
 * worker's own stated trade (main_trade, or main_trade_other when 'other')
 * PLUS every worker_skills entry -- any of these may independently resolve
 * to a cached trade row (e.g. a skill of "soldador" resolving the welder
 * row even when main_trade is unrelated or empty). */
function buildTradeAliasKeys(worker: WorkerMatchProfile): string[] {
  const raw: string[] = [];
  if (worker.main_trade === 'other') {
    if (worker.main_trade_other) raw.push(worker.main_trade_other);
  } else if (worker.main_trade) {
    raw.push(worker.main_trade);
  }
  for (const skill of worker.worker_skills ?? []) {
    if (skill) raw.push(skill);
  }
  return Array.from(new Set(raw.map((term) => normalizeProfession(term)).filter(Boolean)));
}

/**
 * Probes the bilingual `trade_aliases` cache for every row that could
 * plausibly describe this worker's trade. Guarded end-to-end: a query
 * failure (or an empty key set) degrades to the legacy English-only
 * PROFESSION_ALIASES behavior via `buildWorkerProfessionContext`'s default
 * union -- the jobs list must never 500 because this enhancement failed.
 */
async function lookupTradeAliases(client: PoolClient, worker: WorkerMatchProfile): Promise<TradeAliasRow[]> {
  const keys = buildTradeAliasKeys(worker);
  if (keys.length === 0) {
    return [];
  }

  try {
    const result = await client.query<TradeAliasRow>(
      `SELECT trade_key, canonical_en, canonical_es, aliases, trade_category
         FROM trade_aliases
        WHERE trade_key = ANY($1::text[]) OR aliases && $1::text[]`,
      [keys],
    );
    return result.rows;
  } catch (err) {
    console.warn(JSON.stringify({
      metric: 'TradeAliasLookupFailed',
      reason: (err as { name?: string })?.name ?? 'unknown_error',
    }));
    return [];
  }
}

// Shared eligibility predicate fragment: used by BOTH the main candidate
// listing query and the referral-pin fallback fetch below so they can never
// diverge (a prior version hand-copied this into the pin fetch).
const JOB_ELIGIBLE_STATUS = `j.status = 'active'`;

function jobNotAppliedPredicate(workerIdParam: string): string {
  return `NOT EXISTS (
       SELECT 1
         FROM job_applications ja
        WHERE ja.job_id = j.id
          AND ja.worker_id = ${workerIdParam}
     )`;
}

export interface PreferredCityRow {
  city_key: string;
  latitude: string | number | null;
  longitude: string | number | null;
}

export interface CityAnchor {
  latitude: number;
  longitude: number;
}

/** The worker's chosen feed cities (migration 065), oldest pick first, with
 * their centroids (migration 068; NULL before it applies -- the coordinate
 * columns are probed like worker_profiles/jobs coordinates are). Callers
 * derive `cityKeys` for filtering and `cityAnchors` (via cityAnchorsFrom)
 * for distance scoring. Empty result = no preference = unfiltered. */
export async function loadWorkerPreferredCities(
  client: PoolClient,
  workerId: string,
): Promise<PreferredCityRow[]> {
  const coordinates = await coordinateSelects(client, 'worker_preferred_cities', 'wpc');
  const result = await client.query<PreferredCityRow>(
    `SELECT wpc.city_key,
            ${coordinates.latitude} AS latitude,
            ${coordinates.longitude} AS longitude
       FROM worker_preferred_cities wpc
      WHERE wpc.user_id = $1
      ORDER BY wpc.created_at`,
    [workerId],
  );
  return result.rows;
}

export function cityAnchorsFrom(rows: PreferredCityRow[]): CityAnchor[] {
  return rows.flatMap((row) => {
    const latitude = toNumber(row.latitude);
    const longitude = toNumber(row.longitude);
    return latitude !== null && longitude !== null ? [{ latitude, longitude }] : [];
  });
}

export async function listMatchedJobsForWorker(
  client: PoolClient,
  workerId: string,
  options: ListMatchedJobsOptions,
): Promise<MatchedJob[]> {
  const workerCoordinates = await coordinateSelects(client, 'worker_profiles', 'wp');
  const workerResult = await client.query<WorkerMatchProfile>(
    `SELECT u.id,
            u.main_trade,
            u.main_trade_other,
            u.years_experience,
            u.availability,
            u.city,
            wp.location AS profile_location,
            ${workerCoordinates.latitude} AS latitude,
            ${workerCoordinates.longitude} AS longitude,
            (SELECT COALESCE(array_agg(ws.skill), '{}'::text[])
               FROM worker_skills ws
              WHERE ws.worker_id = u.id) AS worker_skills,
            COALESCE(wa.latest_job_id, wa.first_job_id) AS attributed_job_id
       FROM users u
       LEFT JOIN worker_profiles wp ON wp.user_id = u.id
       LEFT JOIN worker_attribution wa ON wa.worker_id = u.id
      WHERE u.id = $1
        AND u.user_type = 'worker'`,
    [workerId],
  );
  const worker = workerResult.rows[0];
  if (!worker) {
    return [];
  }

  const aliasRows = await lookupTradeAliases(client, worker);
  const professionContext = buildWorkerProfessionContext(worker, aliasRows);
  const anchors = options.cityAnchors ?? [];

  const params: unknown[] = [workerId];
  const filters = [JOB_ELIGIBLE_STATUS, jobNotAppliedPredicate('$1')];

  // Single source of truth for "is this list filtered" (= suppress the
  // referral pin): set exactly where each filter clause is added, instead of
  // re-deriving the same condition separately below (a prior version could
  // silently drift from this). One deliberate exception -- `cityKeys` adds a
  // clause without setting this; see the comment at that branch.
  let isFiltered = false;

  if (options.search?.trim()) {
    isFiltered = true;
    params.push(`%${options.search.trim()}%`);
    filters.push(`(j.title ILIKE $${params.length} OR j.description ILIKE $${params.length} OR j.location ILIKE $${params.length})`);
  }

  if (options.jobType?.trim()) {
    isFiltered = true;
    params.push(options.jobType.trim());
    filters.push(`j.job_type = $${params.length}`);
  }

  // Deliberately does NOT set `isFiltered`: a referral is a stronger signal
  // than a city preference, so a worker referred to a job outside their
  // preferred cities must still see it pinned.
  if (options.cityKeys?.length) {
    params.push(options.cityKeys);
    filters.push(`j.city_key = ANY($${params.length}::text[])`);
  }

  if (options.excludeCityKeys?.length) {
    // The exclude form is only ever the "jobs elsewhere" fallback, which runs
    // beside a primary query that already pinned the referral -- pinning again
    // here would surface the same job in both lists.
    isFiltered = true;
    params.push(options.excludeCityKeys);
    filters.push(`(j.city_key IS NULL OR NOT (j.city_key = ANY($${params.length}::text[])))`);
  }

  const requestedLimit = Math.max(1, Math.min(options.limit, 100));
  const candidateLimit = Math.max(requestedLimit, Math.min(requestedLimit * 10, 100));
  params.push(candidateLimit);

  const jobCoordinates = await coordinateSelects(client, 'jobs', 'j');
  const jobsResult = await client.query<MatchableJobRow>(
    `SELECT ${matchableJobColumns(jobCoordinates)}
       FROM jobs j
      WHERE ${filters.join(' AND ')}
      ORDER BY j.created_at DESC, j.id DESC
      LIMIT $${params.length}`,
    params,
  );

  const ranked = jobsResult.rows
    .map((job) => scoreJobCandidate(worker, job, undefined, professionContext, anchors))
    .filter((job) => !workerHasProfessionData(worker) || job.match_components.profession > 0)
    .sort((a, b) => b.match_score - a.match_score || new Date(b.created_at).getTime() - new Date(a.created_at).getTime() || b.id.localeCompare(a.id));

  const pinned = isFiltered ? null : await referredJobPin(client, worker, ranked, jobCoordinates, professionContext, anchors);
  const listed = pinned ? [pinned, ...ranked.filter((job) => job.id !== pinned.id)] : ranked;

  return listed
    .slice(0, requestedLimit)
    .map(({ score, components, reasons, ...job }) => job);
}

function matchableJobColumns(jobCoordinates: { latitude: string; longitude: string }): string {
  return `j.id,
            j.title,
            COALESCE(j.company, 'Jale') AS company,
            j.location,
            COALESCE(j.pay, 'Pay not specified') AS pay,
            j.pay AS pay_raw,
            j.job_type,
            j.description,
            j.required_docs,
            j.created_at,
            j.pay_min,
            j.pay_max,
            j.pay_interval,
            j.start_date,
            j.expected_duration,
            j.shift_schedule,
            j.transportation_required,
            j.language_preference,
            j.number_of_workers_needed,
            j.workers_hired,
            j.trade_category,
            j.required_experience_years,
            j.certifications,
            ${jobCoordinates.latitude} AS latitude,
            ${jobCoordinates.longitude} AS longitude`;
}

/** Explicitly rewrites BOTH `match_reasons` and `reasons` (rather than
 * mutating one and relying on `scoreJobCandidate` having handed back a
 * shared array reference) so a future refactor of that internal sharing
 * can't silently drop the pin reason from one of the two fields. Prepended
 * (not appended) -- the frontend renders only the first 3 reasons. */
function withReferredReason(job: ScoredJobCandidate): ScoredJobCandidate {
  const reasons = ['referred_job', ...job.match_reasons];
  return { ...job, match_reasons: reasons, reasons };
}

/**
 * The job a worker was referred to must never be hidden by match scoring: a
 * referred worker arrived FOR that job, but the profession filter above knows
 * nothing about referrals (a "Soldador" never saw the "Welder" job their
 * friend sent them). Pins the attributed job to the top of an unfiltered
 * list while it is still active and unapplied; any miss falls through to the
 * ranked list unchanged.
 *
 * `worker.attributed_job_id` is already loaded (single consolidated worker
 * query) -- this function makes AT MOST one more query, and only when the
 * referred job isn't already present in `ranked`. Guarded end-to-end: any
 * failure here degrades to "no pin", never breaks the jobs list.
 */
async function referredJobPin(
  client: PoolClient,
  worker: WorkerMatchProfile,
  ranked: ScoredJobCandidate[],
  jobCoordinates: { latitude: string; longitude: string },
  professionContext: WorkerProfessionContext,
  anchors: CityAnchor[] = [],
): Promise<ScoredJobCandidate | null> {
  const referredJobId = worker.attributed_job_id;
  if (!referredJobId) {
    return null;
  }

  try {
    const alreadyRanked = ranked.find((job) => job.id === referredJobId);
    if (alreadyRanked) {
      return withReferredReason(alreadyRanked);
    }

    const jobResult = await client.query<MatchableJobRow>(
      `SELECT ${matchableJobColumns(jobCoordinates)}
         FROM jobs j
        WHERE j.id = $2
          AND ${JOB_ELIGIBLE_STATUS}
          AND ${jobNotAppliedPredicate('$1')}`,
      [worker.id, referredJobId],
    );
    if (jobResult.rows.length === 0) {
      return null;
    }

    return withReferredReason(scoreJobCandidate(worker, jobResult.rows[0], undefined, professionContext, anchors));
  } catch (err) {
    console.warn(JSON.stringify({
      metric: 'ReferredJobPinFailed',
      reason: (err as { name?: string })?.name ?? 'unknown_error',
    }));
    return null;
  }
}
