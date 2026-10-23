import type { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { getDbPool, setRlsContext } from '../lib/db';
import { corsHeaders, errorMessage } from '../lib/http';
import { checkCompliance } from '../legal/check-compliance';
import { resolveCompanyEntitlements } from '../lib/entitlements';
import { readCompanyUsage, CompanyUsageRefusedError } from '../lib/company-usage';
import { employerActorFailureResponse, resolveEmployerActor } from '../lib/employer-actor';

const CORS_HEADERS = corsHeaders();

function response(statusCode: number, body: unknown): APIGatewayProxyResult {
  return { statusCode, headers: CORS_HEADERS, body: JSON.stringify(body) };
}

export const handler = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
  let client;
  try {
    const cognitoSub: string | undefined = event.requestContext.authorizer?.claims?.sub;
    if (!cognitoSub) return response(401, { error: 'unauthorized' });

    const pool = await getDbPool();
    client = await pool.connect();
    await client.query('BEGIN');
    await setRlsContext(client, cognitoSub);

    const compliance = await checkCompliance(client, cognitoSub, process.env.REQUIRED_TOS_VERSION!);
    if (!compliance.userExists) {
      await client.query('COMMIT');
      return response(409, { error: 'user_not_provisioned' });
    }
    if (!compliance.compliant) {
      await client.query('COMMIT');
      return response(403, { error: 'legal_required', requiredVersion: process.env.REQUIRED_TOS_VERSION, currentVersion: compliance.currentVersion });
    }

    const actorResult = await resolveEmployerActor(client, cognitoSub);
    if (!actorResult.ok) {
      await client.query('COMMIT');
      // compliance proved the user exists, so "not provisioned" means "not an employer".
      if (actorResult.status === 409) return response(403, { error: 'employer_required' });
      return employerActorFailureResponse(actorResult, CORS_HEADERS);
    }
    const { actor } = actorResult;

    // The company's plan and company-wide usage (Phase 2): every member sees
    // the same numbers. The owner also sees the foreman seats.
    const entitlements = await resolveCompanyEntitlements(client, actor.organizationId);
    const usage = await readCompanyUsage(client);
    // The plan is resolved for the actor's company, so the count must be the same company's.
    if (usage.organizationId !== actor.organizationId) throw new Error('company_usage_unavailable');
    // A foreman's jobs list shows only their own active jobs, so the frontend
    // adds the rest. The owner lists every member's, so it is always 0 (no
    // subtraction across two unlocked reads that a concurrent post could skew).
    let otherMembersActiveJobs = 0;
    if (actor.role === 'foreman') {
      const visibleRes = await client.query<{ active_jobs: number }>(
        `SELECT count(*)::int AS active_jobs FROM jobs WHERE employer_id = ANY($1::uuid[]) AND status = 'active'`,
        [actor.scopeUserIds],
      );
      const visibleActive = Number(visibleRes.rows[0]?.active_jobs ?? 0);
      otherMembersActiveJobs = Math.max(0, usage.activeJobs - visibleActive);
    }
    const planRes = await client.query(
      `SELECT display_price_minor, currency, billing_interval FROM billing_plans WHERE code = $1 AND active = true`,
      [entitlements.planCode],
    );
    if (planRes.rows.length !== 1) throw new Error('billing_plan_catalog_invalid');
    const subRes = await client.query(
      `SELECT plan_code, status, current_period_start, current_period_end, cancel_at_period_end, grace_ends_at
         FROM subscriptions
        WHERE organization_id = $1
        -- The eligible row first, with the predicate resolveCompanyEntitlements
        -- uses: the processor retires the old row and upserts the new one in one
        -- transaction, so both share updated_at, and the retired row must not win
        -- the tie (it would show a paying owner the lapsed banner).
        ORDER BY CASE WHEN status IN ('active', 'trialing')
                        OR (status = 'past_due' AND grace_ends_at > now())
                      THEN 0 ELSE 1 END,
                 updated_at DESC, created_at DESC, id DESC
        LIMIT 1`,
      [actor.organizationId],
    );

    await client.query('COMMIT');
    return response(200, {
      planCode: entitlements.planCode,
      activeJobLimit: entitlements.activeJobLimit,
      templateLimit: entitlements.templateLimit,
      foremanSeatLimit: entitlements.foremanSeatLimit,
      activeJobUsage: usage.activeJobs,
      templateUsage: usage.templates,
      otherMembersActiveJobs,
      role: actor.role,
      seats: actor.role === 'owner'
        ? { used: usage.activeForemen, limit: entitlements.foremanSeatLimit, suspended: usage.suspendedForemen }
        : null,
      subscription: subRes.rows[0] ?? null,
      display_price_minor: planRes.rows[0].display_price_minor,
      currency: planRes.rows[0].currency,
      billing_interval: planRes.rows[0].billing_interval,
    });
  } catch (err) {
    if (client) { try { await client.query('ROLLBACK'); } catch (_) {} }
    if (err instanceof CompanyUsageRefusedError) {
      // The definer says the caller is no longer an active member: the answer resolveEmployerActor gives.
      return employerActorFailureResponse({ ok: false, status: 403, error: 'membership_inactive' }, CORS_HEADERS);
    }
    console.error('billing-get error:', errorMessage(err));
    return response(500, { error: 'internal_error' });
  } finally {
    if (client) client.release();
  }
};
