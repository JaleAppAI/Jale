import type { PoolClient } from 'pg';

// Role-neutral by design (Gigs compatibility): resolves by internal users.id,
// never by users.user_type. Grace is evaluated here at call time — there is no
// entitlement-expiry cron in this release (spec S6.8).
export interface Entitlements {
  planCode: string;
  activeJobLimit: number;
}

export async function resolveEntitlements(
  client: PoolClient,
  userId: string,
): Promise<Entitlements> {
  const res = await client.query(
    `WITH eligible AS (
       SELECT p.code AS plan_code, p.entitlements, 0 AS priority
         FROM subscriptions s
         JOIN billing_plans p ON p.code = s.plan_code
        WHERE s.user_id = $1
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
    [userId],
  );
  if (res.rows.length !== 1) throw new Error('billing_plan_catalog_invalid');
  const limit = Number(res.rows[0].entitlements?.active_job_limit);
  if (!Number.isInteger(limit) || limit < 0) throw new Error('billing_plan_catalog_invalid');
  return { planCode: res.rows[0].plan_code, activeJobLimit: limit };
}
