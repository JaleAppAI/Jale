import type { Client, PoolClient } from 'pg';

// A plan's limits. Phase 2 resolves them per company (resolveCompanyEntitlements);
// grace is evaluated at call time — there is no entitlement-expiry cron.
export interface Entitlements {
  planCode: string;
  activeJobLimit: number;
  templateLimit: number;
}

/** A plan's limits for a company: the job and template limits, and the foreman seats (127). */
export interface CompanyEntitlements extends Entitlements {
  foremanSeatLimit: number;
}

// The 128 definers take PostgreSQL integer limits; a larger one would raise 22003.
const PG_INT_MAX = 2147483647;

// Fail closed: only a JS number or a string of digits (the shape pg uses for
// bigint) is a limit. null, '', booleans, arrays, signs and decimals are not.
function parseLimit(entitlements: Record<string, unknown> | null | undefined, key: string): number {
  const raw = entitlements?.[key];
  const value =
    typeof raw === 'number' ? raw
    : typeof raw === 'string' && /^\d+$/.test(raw) ? Number(raw)
    : NaN;
  if (!Number.isSafeInteger(value) || value < 0 || value > PG_INT_MAX) throw new Error('billing_plan_catalog_invalid');
  return value;
}

/**
 * The plan a COMPANY is entitled to: its eligible subscription (active,
 * trialing, or past_due inside grace; the most recently updated), else the
 * active employer_free catalog row. A company pays one subscription
 * (subscriptions.organization_id, 127), and its limits are shared by every
 * member. Grace is evaluated here at call time, as before.
 *
 * As jale_api, call it after resolveEmployerActor: a member reads the
 * company's subscription through subscriptions_org_member_read, keyed on
 * app.current_internal_user_id. jale_billing reads every row.
 */
export async function resolveCompanyEntitlements(
  client: Client | PoolClient,
  organizationId: string,
): Promise<CompanyEntitlements> {
  const res = await client.query(
    `WITH eligible AS (
       SELECT p.code AS plan_code, p.entitlements, 0 AS priority
         FROM subscriptions s
         JOIN billing_plans p ON p.code = s.plan_code
        WHERE s.organization_id = $1
          AND (s.status IN ('active', 'trialing')
               OR (s.status = 'past_due' AND s.grace_ends_at > now()))
        ORDER BY s.updated_at DESC
        LIMIT 1
     ), fallback AS (
       SELECT code AS plan_code, entitlements, 1 AS priority
         FROM billing_plans
        WHERE code = 'employer_free' AND active = true
     )
     SELECT plan_code, entitlements FROM (
       SELECT * FROM eligible UNION ALL SELECT * FROM fallback
     ) plans ORDER BY priority LIMIT 1`,
    [organizationId],
  );
  if (res.rows.length !== 1) throw new Error('billing_plan_catalog_invalid');
  const entitlements = res.rows[0].entitlements as Record<string, unknown> | null;
  return {
    planCode: res.rows[0].plan_code,
    activeJobLimit: parseLimit(entitlements, 'active_job_limit'),
    templateLimit: parseLimit(entitlements, 'template_limit'),
    foremanSeatLimit: parseLimit(entitlements, 'foreman_seat_limit'),
  };
}
