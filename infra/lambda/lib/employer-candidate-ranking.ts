import { createHash } from 'node:crypto';
import type { PoolClient } from 'pg';

export type RankingStatus = 'deterministic' | 'llm_cached';
export type ScoreBand = 'strong' | 'good' | 'fair';
export type RankingVersion = 'sql-v1' | 'llm-v1';

export interface EmployerCandidate {
  application_id: string;
  worker_id: string;
  display_name: string;
  phone: string | null;
  status: string;
  applied_at: string | Date;
  skills: string[];
  availability: string | null;
  years_experience: string | number | null;
  location: string | null;
  trust_score: number | null;
  match_score: number;
  score_band: ScoreBand;
  match_reasons: string[];
}

export interface EmployerCandidateResponse {
  ranking_status: RankingStatus;
  ranking_version: RankingVersion;
  candidates: EmployerCandidate[];
  total: number;
  computed_at: string;
}

export interface EmployerCandidateRankingResult {
  response: EmployerCandidateResponse;
  sourceHash: string;
  shouldEnqueueRerank: boolean;
}

export interface EmployerCandidateJob {
  id: string;
  title: string;
  location: string;
  job_type: string;
  description: string | null;
  required_docs: string[] | null;
  created_at: string | Date;
}

interface AppliedCandidateRow {
  application_id: string;
  worker_id: string;
  full_name: string | null;
  phone: string | null;
  status: string;
  applied_at: string | Date;
  skills: string[] | null;
  profile_skills?: string[] | null;
  location: string | null;
  availability: string | null;
  profile_years_experience: number | string | null;
  main_trade: string | null;
  main_trade_other: string | null;
  user_years_experience: string | number | null;
  user_availability: string | null;
  city: string | null;
  trust_score: number | string | null;
}

interface CacheRow {
  worker_id: string;
  score: number | string;
  score_band: ScoreBand;
  reasons: string[] | unknown;
  computed_at: string | Date;
}

const SQL_RANKING_VERSION: RankingVersion = 'sql-v1';
const LLM_RANKING_VERSION: RankingVersion = 'llm-v1';
const MAX_API_LIMIT = 100;
const MAX_SHORTLIST = 150;

const STOP_WORDS = new Set([
  'and', 'the', 'for', 'with', 'need', 'needed', 'job', 'work', 'this', 'that',
  'from', 'have', 'has', 'are', 'you', 'your', 'our', 'full', 'time',
]);

export function scoreBandForMatch(score: number): ScoreBand {
  if (score >= 70) return 'strong';
  if (score >= 45) return 'good';
  return 'fair';
}

function cleanText(value: unknown): string {
  return String(value ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function keywords(value: unknown): string[] {
  const words = cleanText(value)
    .split(' ')
    .filter((word) => word.length >= 3 && !STOP_WORDS.has(word));
  return Array.from(new Set(words));
}

function toNumber(value: string | number | null): number | null {
  if (value === null) return null;
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function workerYears(value: string | number | null): number | null {
  if (value === null) return null;
  if (typeof value === 'number') return value;
  if (value === '0-1') return 1;
  if (value === '2-4') return 3;
  if (value === '5-9') return 7;
  if (value === '10+') return 10;
  return toNumber(value);
}

function normalizeSkills(values: Array<string | null | undefined>): string[] {
  return Array.from(new Set(values.map(cleanText).filter(Boolean)));
}

function scoreCandidate(job: EmployerCandidateJob, row: AppliedCandidateRow): EmployerCandidate {
  const reasons: string[] = [];
  const jobText = cleanText(`${job.title} ${job.description ?? ''} ${job.job_type}`);
  const jobKeywords = keywords(jobText);
  const skillValues = [
    ...(row.skills ?? []),
    ...(row.profile_skills ?? []),
  ];
  const skills = normalizeSkills(skillValues);
  const trustScore = toNumber(row.trust_score);
  const years = row.profile_years_experience ?? row.user_years_experience;
  const availability = row.availability ?? row.user_availability;
  const location = row.location ?? row.city;

  let score = 0;

  if (trustScore !== null) {
    const trustPoints = Math.round(Math.max(0, Math.min(trustScore, 100)) * 0.35);
    score += trustPoints;
    if (trustScore >= 80) reasons.push('High trust score');
  }

  const trade = cleanText(row.main_trade === 'other' ? row.main_trade_other : row.main_trade);
  if (trade && jobText.includes(trade)) {
    score += 25;
    reasons.push('Trade match');
  } else if (trade && jobKeywords.some((term) => trade.includes(term) || term.includes(trade))) {
    score += 12;
    reasons.push('Related trade');
  }

  const matchedSkills = skills.filter((skill) => jobText.includes(skill));
  if (matchedSkills.length > 0) {
    score += Math.min(25, 8 + matchedSkills.length * 6);
    reasons.push(`Relevant skills: ${matchedSkills.slice(0, 4).join(', ')}`);
  }

  if (availability && job.job_type === 'full-time' && availability === 'full_time') {
    score += 3;
    reasons.push('Availability match');
  } else if (availability && job.job_type === 'part-time' && availability === 'part_time') {
    score += 3;
    reasons.push('Availability match');
  } else if (availability === 'flexible') {
    score += 2;
    reasons.push('Flexible availability');
  }

  const yearsValue = workerYears(years);
  if (yearsValue !== null && yearsValue >= 5) {
    score += 2;
  }

  if (['submitted', 'viewed', 'contacted'].includes(row.status)) {
    score += 3;
  }

  const matchScore = Math.max(0, Math.min(100, Math.round(score)));

  return {
    application_id: row.application_id,
    worker_id: row.worker_id,
    display_name: row.full_name ?? `Worker ${row.worker_id.slice(0, 8)}`,
    phone: row.phone,
    status: row.status,
    applied_at: row.applied_at,
    skills,
    availability,
    years_experience: years,
    location,
    trust_score: trustScore,
    match_score: matchScore,
    score_band: scoreBandForMatch(matchScore),
    match_reasons: reasons.length > 0 ? reasons : ['Applied to this job'],
  };
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(',')}]`;
  }
  if (value && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => `${JSON.stringify(key)}:${stableStringify(item)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

export function buildEmployerCandidateSourceHash(input: unknown): string {
  return createHash('sha256').update(stableStringify(input)).digest('hex');
}

export function sanitizeCandidateForLlm(candidate: EmployerCandidate): Record<string, unknown> {
  return {
    application_id: candidate.application_id,
    status: candidate.status,
    applied_at: candidate.applied_at,
    skills: candidate.skills,
    availability: candidate.availability,
    years_experience: candidate.years_experience,
    location: candidate.location,
    trust_score: candidate.trust_score,
    match_score: candidate.match_score,
    score_band: candidate.score_band,
    match_reasons: candidate.match_reasons,
  };
}

function cacheReasons(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.filter((item): item is string => typeof item === 'string');
  }
  return [];
}

function applyCacheRows(candidates: EmployerCandidate[], cacheRows: CacheRow[]): EmployerCandidate[] {
  const byWorker = new Map(candidates.map((candidate) => [candidate.worker_id, candidate]));
  return cacheRows
    .map((row) => {
      const candidate = byWorker.get(row.worker_id);
      if (!candidate) return null;
      const score = Number(row.score);
      return {
        ...candidate,
        match_score: Number.isFinite(score) ? score : candidate.match_score,
        score_band: row.score_band,
        match_reasons: cacheReasons(row.reasons),
      };
    })
    .filter((candidate): candidate is EmployerCandidate => candidate !== null);
}

export async function readFreshEmployerCandidateCache(
  client: PoolClient,
  jobId: string,
  sourceHash: string,
): Promise<CacheRow[]> {
  const result = await client.query<CacheRow>(
    `SELECT worker_id, score, score_band, reasons, computed_at
       FROM employer_candidate_rankings
      WHERE job_id = $1
        AND source_hash = $2
        AND status = 'ready'
        AND computed_at > now() - interval '24 hours'
      ORDER BY rank ASC`,
    [jobId, sourceHash],
  );
  return result.rows;
}

export async function listEmployerCandidates(
  client: PoolClient,
  jobId: string,
  options: { limit: number; includeContact?: boolean },
): Promise<EmployerCandidateRankingResult> {
  const limit = Math.max(1, Math.min(Math.trunc(options.limit || MAX_API_LIMIT), MAX_API_LIMIT));
  const shortlistLimit = Math.min(limit * 3, MAX_SHORTLIST);
  const fullNameSelect = options.includeContact
    ? 'COALESCE(wp.full_name, u.full_name) AS full_name'
    : 'NULL::text AS full_name';
  const phoneSelect = options.includeContact
    ? 'COALESCE(wp.phone, u.phone) AS phone'
    : 'NULL::text AS phone';

  const jobResult = await client.query<EmployerCandidateJob>(
    `SELECT id, title, location, job_type, description, required_docs, created_at
       FROM jobs
      WHERE id = $1`,
    [jobId],
  );
  const job = jobResult.rows[0];

  if (!job) {
    return {
      response: {
        ranking_status: 'deterministic',
        ranking_version: SQL_RANKING_VERSION,
        candidates: [],
        total: 0,
        computed_at: new Date().toISOString(),
      },
      sourceHash: buildEmployerCandidateSourceHash({ jobId, candidates: [] }),
      shouldEnqueueRerank: false,
    };
  }

  const candidatesResult = await client.query<AppliedCandidateRow>(
    `SELECT ja.id AS application_id,
            ja.worker_id,
            ${fullNameSelect},
            ${phoneSelect},
            ja.status,
            ja.applied_at,
            ARRAY(
              SELECT ws.skill
                FROM worker_skills ws
               WHERE ws.worker_id = ja.worker_id
              ORDER BY ws.skill
            ) AS skills,
            NULL::text[] AS profile_skills,
            wp.location,
            wp.availability,
            wp.years_experience AS profile_years_experience,
            u.main_trade,
            u.main_trade_other,
            u.years_experience AS user_years_experience,
            u.availability AS user_availability,
            u.city,
            u.trade_competency_score AS trust_score
       FROM job_applications ja
       JOIN users u ON u.id = ja.worker_id
       LEFT JOIN worker_profiles wp ON wp.user_id = ja.worker_id
      WHERE ja.job_id = $1
      ORDER BY ja.applied_at DESC
      LIMIT $2`,
    [jobId, shortlistLimit],
  );

  const deterministic = candidatesResult.rows
    .map((row) => scoreCandidate(job, row))
    .sort((a, b) => b.match_score - a.match_score || new Date(a.applied_at).getTime() - new Date(b.applied_at).getTime())
    .slice(0, limit);

  const sourceHash = buildEmployerCandidateSourceHash({
    job: {
      id: job.id,
      title: job.title,
      description: job.description,
      job_type: job.job_type,
      required_docs: job.required_docs ?? [],
    },
    candidates: deterministic.map((candidate) => ({
      worker_id: candidate.worker_id,
      application_id: candidate.application_id,
      trust_score: candidate.trust_score,
      match_score: candidate.match_score,
      skills: candidate.skills,
      reasons: candidate.match_reasons,
    })),
  });

  const cacheRows = deterministic.length > 0
    ? await readFreshEmployerCandidateCache(client, jobId, sourceHash)
    : [];
  const cachedCandidates = cacheRows.length > 0 ? applyCacheRows(deterministic, cacheRows).slice(0, limit) : [];
  const useCache = cachedCandidates.length > 0;

  return {
    response: {
      ranking_status: useCache ? 'llm_cached' : 'deterministic',
      ranking_version: useCache ? LLM_RANKING_VERSION : SQL_RANKING_VERSION,
      candidates: useCache ? cachedCandidates : deterministic,
      total: candidatesResult.rowCount ?? deterministic.length,
      computed_at: useCache ? new Date(cacheRows[0].computed_at).toISOString() : new Date().toISOString(),
    },
    sourceHash,
    shouldEnqueueRerank: deterministic.length > 0 && !useCache,
  };
}
