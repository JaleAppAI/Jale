import type { PoolClient } from 'pg';
import { buildHireDetails, hireDetailsNeeded, type HireDetails } from './application-hire-view';

export type ApplicantOverviewItem = {
  application_id: string;
  worker_id: string;
  worker_name: string | null;
  job_id: string;
  job_title: string;
  job_city: string | null;
  job_status: string;
  application_status: string;
  applied_at: string;
  skills: string[];
  availability: string | null;
  years_experience: number | null;
  /** From the employer_candidate_rankings cache; null when never computed. */
  match_score: number | null;
  score_band: 'strong' | 'good' | 'fair' | null;
  /**
   * `users.trade_competency_score` (012:122) -- how the worker came across
   * when asked about their trade, NOT how well they fit this job. An INTEGER
   * column, so node-pg hands it back as a number; null means never assessed,
   * which the pill renders differently from a zero.
   */
  trust_score: number | null;
  /** F19 (K4.2): the start details the employer saved for a hire, or null. */
  hire_details: HireDetails | null;
  /** F19 (K4.2): hired with no start details yet. */
  hire_details_needed: boolean;
};

export type OverviewJob = { job_id: string; title: string; city: string | null; status: string };

export type ApplicantsOverview = {
  applicants: ApplicantOverviewItem[];
  jobs: OverviewJob[];
  total: number;
};

// One row per non-dismissed application across ALL the jobs in the caller's scope.
// The ranking cache is a LEFT JOIN on purpose: a missing score renders as
// "not scored", never blocks the row. Status vocabulary is the 091 set
// (pending|contacted|talking|details_requested|hired|not_interested) plus the
// same legacy normalization employer-job-applicants keeps ('reviewed' ->
// 'contacted'; 'rejected' rows are excluded outright) so the two surfaces
// never disagree. This overview deliberately does NOT compute the 091
// stageView/prompt answers -- that depth belongs to the per-job surface.
const OVERVIEW_QUERY = `
  SELECT
    ja.id AS application_id,
    ja.worker_id,
    COALESCE(wp.full_name, u.full_name) AS worker_name,
    j.id AS job_id,
    j.title AS job_title,
    j.city AS job_city,
    j.status AS job_status,
    CASE ja.status
      WHEN 'reviewed' THEN 'contacted'
      ELSE ja.status
    END AS application_status,
    ja.applied_at,
    ARRAY(
      SELECT ws.skill
      FROM worker_skills ws
      WHERE ws.worker_id = ja.worker_id
      ORDER BY ws.skill
    ) AS skills,
    wp.availability,
    wp.years_experience,
    ecr.score AS match_score,
    ecr.score_band,
    -- Same expression employer-candidate-ranking.ts:338 uses, so the cross-job
    -- overview and the per-job list can never show a different trust number
    -- for the same worker. The users JOIN below is already there for the name,
    -- and users_employer_applicant_read (020b:261-269) is what admits the row
    -- -- resolveEmployerActor sets app.current_internal_user_id before this runs.
    u.trade_competency_score AS trust_score,
    -- F19 (125): the start details, published only as hire_details.
    to_char(ja.hire_start_date, 'YYYY-MM-DD') AS hire_start_date,
    ja.hire_report_location,
    ja.hire_contact_name,
    ja.hire_contact_phone,
    ja.hire_notes,
    ja.hire_details_updated_at
  FROM job_applications ja
  JOIN jobs j ON j.id = ja.job_id AND j.employer_id = ANY($1::uuid[])
  JOIN users u ON u.id = ja.worker_id
  LEFT JOIN worker_profiles wp ON wp.user_id = ja.worker_id
  LEFT JOIN employer_candidate_rankings ecr
    ON ecr.job_id = ja.job_id AND ecr.worker_id = ja.worker_id
  WHERE ja.status NOT IN ('not_interested', 'rejected')
  ORDER BY ja.applied_at DESC
  LIMIT 500`;

export async function listEmployerApplicantsOverview(
  client: PoolClient,
  scopeUserIds: string[],
): Promise<ApplicantsOverview> {
  const result = await client.query<Record<string, any>>(OVERVIEW_QUERY, [scopeUserIds]);
  const applicants: ApplicantOverviewItem[] = result.rows.map((row) => {
    const {
      hire_start_date: _hireStartDate, hire_report_location: _hireReportLocation, hire_contact_name: _hireContactName,
      hire_contact_phone: _hireContactPhone, hire_notes: _hireNotes, hire_details_updated_at: _hireDetailsUpdatedAt,
      ...item
    } = row;
    const hireDetails = row.application_status === 'hired' ? buildHireDetails(row) : null;
    return {
      ...(item as Omit<ApplicantOverviewItem, 'hire_details' | 'hire_details_needed'>),
      hire_details: hireDetails,
      hire_details_needed: hireDetailsNeeded(row.application_status, hireDetails),
    };
  });

  const jobs: OverviewJob[] = [];
  const seen = new Set<string>();
  for (const item of applicants) {
    if (seen.has(item.job_id)) continue;
    seen.add(item.job_id);
    jobs.push({ job_id: item.job_id, title: item.job_title, city: item.job_city, status: item.job_status });
  }

  return { applicants, jobs, total: applicants.length };
}
