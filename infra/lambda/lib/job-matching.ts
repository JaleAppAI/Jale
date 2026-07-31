import type { PoolClient } from 'pg';

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
};

export function extractZip(value: string | null | undefined): string | null {
  const match = value?.match(/\b\d{5}(?:-\d{4})?\b/);
  return match ? match[0].slice(0, 5) : null;
}

function cleanText(value: string | null | undefined): string {
  return (value ?? '')
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

function scoreProfession(worker: WorkerMatchProfile, job: MatchableJobRow, reasons: string[]): number {
  const terms = workerProfessionTerms(worker);
  if (terms.length === 0) {
    return 0;
  }

  const jobText = normalizeProfessionText(`${job.title} ${job.trade_category ?? ''} ${job.description ?? ''}`);
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

function scoreLocation(worker: WorkerMatchProfile, job: MatchableJobRow, reasons: string[]): number {
  const workerLat = toNumber(worker.latitude);
  const workerLon = toNumber(worker.longitude);
  const jobLat = toNumber(job.latitude);
  const jobLon = toNumber(job.longitude);

  if (workerLat !== null && workerLon !== null && jobLat !== null && jobLon !== null) {
    const miles = distanceMiles(workerLat, workerLon, jobLat, jobLon);
    if (miles <= 5) {
      reasons.push('distance_under_5_miles');
      return 30;
    }
    if (miles <= 15) {
      reasons.push('distance_under_15_miles');
      return 24;
    }
    if (miles <= 30) {
      reasons.push('distance_under_30_miles');
      return 16;
    }
    if (miles <= 50) {
      reasons.push('distance_under_50_miles');
      return 8;
    }
    return 0;
  }

  const workerZip = extractZip(worker.profile_location) ?? extractZip(worker.city);
  const jobZip = extractZip(job.location);
  if (workerZip && jobZip && workerZip === jobZip) {
    reasons.push('zip_exact');
    return 30;
  }

  const workerLocation = cleanText(worker.profile_location ?? worker.city);
  const jobLocation = cleanText(job.location);
  if (workerLocation && jobLocation && (jobLocation.includes(workerLocation) || workerLocation.includes(jobLocation))) {
    reasons.push('location_text_match');
    return 18;
  }

  return 0;
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
): ScoredJobCandidate {
  const reasons: string[] = [];
  const components: MatchComponents = {
    profession: scoreProfession(worker, job, reasons),
    location: scoreLocation(worker, job, reasons),
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

type CoordinateTable = 'worker_profiles' | 'jobs';

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
            ${workerCoordinates.longitude} AS longitude
       FROM users u
       LEFT JOIN worker_profiles wp ON wp.user_id = u.id
      WHERE u.id = $1
        AND u.user_type = 'worker'`,
    [workerId],
  );
  const worker = workerResult.rows[0];
  if (!worker) {
    return [];
  }

  const params: unknown[] = [workerId];
  const filters = [
    `j.status = 'active'`,
    `NOT EXISTS (
       SELECT 1
         FROM job_applications ja
        WHERE ja.job_id = j.id
          AND ja.worker_id = $1
     )`,
  ];

  if (options.search?.trim()) {
    params.push(`%${options.search.trim()}%`);
    filters.push(`(j.title ILIKE $${params.length} OR j.description ILIKE $${params.length} OR j.location ILIKE $${params.length})`);
  }

  if (options.jobType?.trim()) {
    params.push(options.jobType.trim());
    filters.push(`j.job_type = $${params.length}`);
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
    .map((job) => scoreJobCandidate(worker, job))
    .filter((job) => !workerHasProfessionData(worker) || job.match_components.profession > 0)
    .sort((a, b) => b.match_score - a.match_score || new Date(b.created_at).getTime() - new Date(a.created_at).getTime() || b.id.localeCompare(a.id));

  const isFiltered = Boolean(options.search?.trim() || options.jobType?.trim());
  const pinned = isFiltered ? null : await referredJobPin(client, worker, workerId, ranked, jobCoordinates);
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
            j.job_type,
            j.description,
            j.required_docs,
            j.created_at,
            j.pay_min,
            j.pay_max,
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

/**
 * The job a worker was referred to must never be hidden by match scoring: a
 * referred worker arrived FOR that job, but the profession filter above knows
 * nothing about referrals (a "Soldador" never saw the "Welder" job their
 * friend sent them). Pins the attributed job to the top of an unfiltered
 * list while it is still active and unapplied; any miss falls through to the
 * ranked list unchanged.
 */
async function referredJobPin(
  client: PoolClient,
  worker: WorkerMatchProfile,
  workerId: string,
  ranked: ScoredJobCandidate[],
  jobCoordinates: { latitude: string; longitude: string },
): Promise<ScoredJobCandidate | null> {
  const attribution = await client.query<{ job_id: string | null }>(
    `SELECT COALESCE(latest_job_id, first_job_id) AS job_id
       FROM worker_attribution
      WHERE worker_id = $1`,
    [workerId],
  );
  const referredJobId = attribution.rows[0]?.job_id;
  if (!referredJobId) {
    return null;
  }

  const alreadyRanked = ranked.find((job) => job.id === referredJobId);
  if (alreadyRanked) {
    alreadyRanked.match_reasons.push('referred_job');
    return alreadyRanked;
  }

  const jobResult = await client.query<MatchableJobRow>(
    `SELECT ${matchableJobColumns(jobCoordinates)}
       FROM jobs j
      WHERE j.id = $2
        AND j.status = 'active'
        AND NOT EXISTS (
          SELECT 1
            FROM job_applications ja
           WHERE ja.job_id = j.id
             AND ja.worker_id = $1
        )`,
    [workerId, referredJobId],
  );
  if (jobResult.rows.length === 0) {
    return null;
  }

  const scored = scoreJobCandidate(worker, jobResult.rows[0]);
  scored.match_reasons.push('referred_job');
  return scored;
}
