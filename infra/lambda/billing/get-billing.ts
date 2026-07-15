import type { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { getDbPool, setRlsContext } from '../lib/db';
import { corsHeaders, errorMessage } from '../lib/http';
import { checkCompliance } from '../legal/check-compliance';
import { resolveEntitlements } from '../lib/entitlements';

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

    const userRes = await client.query(`SELECT id FROM users WHERE cognito_sub = $1 AND user_type = 'employer'`, [cognitoSub]);
    if (userRes.rows.length !== 1) {
      await client.query('COMMIT');
      return response(403, { error: 'employer_required' });
    }
    const userId = String(userRes.rows[0].id);
    const entitlements = await resolveEntitlements(client, userId);
    const usageRes = await client.query(`SELECT count(*)::int AS active_jobs FROM jobs WHERE employer_id = $1 AND status = 'active'`, [userId]);
    const planRes = await client.query(
      `SELECT display_price_minor, currency, billing_interval FROM billing_plans WHERE code = $1 AND active = true`,
      [entitlements.planCode],
    );
    if (planRes.rows.length !== 1) throw new Error('billing_plan_catalog_invalid');
    const subRes = await client.query(
      `SELECT plan_code, status, current_period_start, current_period_end, cancel_at_period_end, grace_ends_at
         FROM subscriptions
        WHERE user_id = $1
        ORDER BY updated_at DESC
        LIMIT 1`,
      [userId],
    );

    await client.query('COMMIT');
    return response(200, {
      planCode: entitlements.planCode,
      activeJobLimit: entitlements.activeJobLimit,
      activeJobUsage: Number(usageRes.rows[0]?.active_jobs ?? 0),
      subscription: subRes.rows[0] ?? null,
      display_price_minor: planRes.rows[0].display_price_minor,
      currency: planRes.rows[0].currency,
      billing_interval: planRes.rows[0].billing_interval,
    });
  } catch (err) {
    if (client) { try { await client.query('ROLLBACK'); } catch (_) {} }
    console.error('billing-get error:', errorMessage(err));
    return response(500, { error: 'internal_error' });
  } finally {
    if (client) client.release();
  }
};
