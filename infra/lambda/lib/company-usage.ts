import type { Client, PoolClient } from 'pg';

/** Company-wide usage counts, as read by readCompanyUsage. */
export interface CompanyUsage {
  organizationId: string;
  activeJobs: number;
  templates: number;
  activeForemen: number;
  suspendedForemen: number;
}

/**
 * The definer refused the caller: it is not an active member of a company
 * (raised 42501 by jale_cap.employer_org_usage, before and after the lock).
 * Handlers answer 403 membership_inactive. No other error maps to this.
 */
export class CompanyUsageRefusedError extends Error {
  constructor() {
    super('membership_inactive');
    this.name = 'CompanyUsageRefusedError';
  }
}

const NOT_ACTIVE_MEMBER = 'the caller is not an active member of a company';

type UsageRow = {
  organization_id: string;
  active_jobs: unknown;
  templates: unknown;
  active_foremen: unknown;
  suspended_foremen: unknown;
};

// Fail closed: only a JS number or a string of digits (the shape pg uses for
// bigint) is a count. null, '', booleans, arrays, signs and decimals are not.
function count(value: unknown): number {
  const n =
    typeof value === 'number' ? value
    : typeof value === 'string' && /^\d+$/.test(value) ? Number(value)
    : NaN;
  if (!Number.isSafeInteger(n) || n < 0) throw new Error('company_usage_unavailable');
  return n;
}

/**
 * Company-wide usage for the caller's company (jale_cap.employer_org_usage,
 * migration 128): every member's active jobs, whatever their membership
 * status (a suspended foreman's active jobs still count), every member's
 * templates, and the active and suspended foremen.
 *
 * With { lock: true } it first takes the company's organizations row
 * FOR NO KEY UPDATE, held until the transaction ends. That is the one lock
 * the plan-limit gates (job create, reactivation, template saves) and the
 * billing enforcer share, so two members cannot both take the last slot and
 * a downgrade never misses a post in flight; an insert that names the
 * company (its foreign-key check) never waits for it. Take it before any
 * job row lock.
 *
 * { lock: true } holds the lock only inside an open transaction (BEGIN).
 * lock_timeout (55P03) and deadlock (40P01) errors pass through to the
 * caller unchanged.
 *
 * Call after resolveEmployerActor, which sets app.current_internal_user_id.
 * The definer re-checks, after the lock, that the caller is an active member
 * and raises 42501 "the caller is not an active member of a company"; that
 * one error (and only it) becomes CompanyUsageRefusedError. Every other
 * error, including the other 42501s (caller context not set, company row
 * missing) and RLS violations, is rethrown unchanged.
 */
export async function readCompanyUsage(
  client: Client | PoolClient,
  options: { lock?: boolean } = {},
): Promise<CompanyUsage> {
  let res;
  try {
    res = await client.query<UsageRow>(
      `SELECT organization_id, active_jobs, templates, active_foremen, suspended_foremen
         FROM jale_cap.employer_org_usage($1)`,
      [options.lock === true],
    );
  } catch (err) {
    const e = err as { code?: unknown; message?: unknown } | null;
    if (e?.code === '42501' && typeof e.message === 'string' && e.message.includes(NOT_ACTIVE_MEMBER)) {
      throw new CompanyUsageRefusedError();
    }
    throw err;
  }
  const row = res.rows[0];
  if (!row || typeof row.organization_id !== 'string' || row.organization_id === '') {
    throw new Error('company_usage_unavailable');
  }
  return {
    organizationId: row.organization_id,
    activeJobs: count(row.active_jobs),
    templates: count(row.templates),
    activeForemen: count(row.active_foremen),
    suspendedForemen: count(row.suspended_foremen),
  };
}
