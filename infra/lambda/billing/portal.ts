import type { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { getDbPool, setRlsContext } from '../lib/db';
import { corsHeaders } from '../lib/http';
import { checkCompliance } from '../legal/check-compliance';
import { getStripe, getStripeSecret, StripeConfigError } from '../lib/stripe-client';
import { assertAllowedReturnUrl } from '../lib/billing-operations';

const CORS_HEADERS = corsHeaders();

function response(statusCode: number, body: unknown): APIGatewayProxyResult {
  return { statusCode, headers: CORS_HEADERS, body: JSON.stringify(body) };
}

export const handler = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
  let client;
  try {
    const cognitoSub: string | undefined = event.requestContext.authorizer?.claims?.sub;
    if (!cognitoSub) return response(401, { error: 'unauthorized' });

    let body: { returnUrl?: string };
    try {
      body = JSON.parse(event.body ?? '{}');
    } catch {
      return response(400, { error: 'invalid_json' });
    }
    if (!body.returnUrl) return response(400, { error: 'missing_fields', required: ['returnUrl'] });
    try {
      assertAllowedReturnUrl(body.returnUrl, process.env.ALLOWED_ORIGIN ?? 'http://localhost:3000');
    } catch {
      return response(400, { error: 'invalid_return_origin' });
    }

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

    const customerRes = await client.query(
      `SELECT bc.provider_customer_id
         FROM billing_customers bc
         JOIN users u ON u.id = bc.user_id
        WHERE u.cognito_sub = $1
          AND u.user_type = 'employer'
          AND bc.provider = 'stripe'`,
      [cognitoSub],
    );
    if (customerRes.rows.length !== 1) {
      await client.query('COMMIT');
      return response(404, { error: 'billing_customer_not_found' });
    }
    const customerId = String(customerRes.rows[0].provider_customer_id);
    await client.query('COMMIT');

    const secret = await getStripeSecret();
    if (!secret.portalConfigurationId) {
      throw new StripeConfigError('stripe_portal_configuration_missing');
    }
    const stripe = await getStripe();
    const session = await stripe.billingPortal.sessions.create({
      customer: customerId,
      return_url: body.returnUrl,
      configuration: secret.portalConfigurationId,
    });
    return response(200, { url: session.url });
  } catch (err) {
    if (err instanceof StripeConfigError) {
      // The DB transaction here has already committed by the time
      // getStripeSecret()/getStripe() run (see above), so there is nothing to
      // roll back — just report the permanent config problem, never a
      // retryable outage.
      console.error('billing-portal configuration error:', err.reason);
      return response(500, { error: 'billing_configuration_invalid' });
    }
    if (client) { try { await client.query('ROLLBACK'); } catch (_) {} }
    console.error('billing-portal error');
    return response(500, { error: 'internal_error' });
  } finally {
    if (client) client.release();
  }
};
