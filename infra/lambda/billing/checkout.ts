import type { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { getDbPool } from '../lib/db';
import { corsHeaders, errorMessage } from '../lib/http';
import { getStripe, getStripeSecret, StripeConfigError } from '../lib/stripe-client';
import {
  assertAllowedReturnUrl,
  BillingCustomerConflictError,
  isUuid,
  markCheckoutSucceeded,
  persistBillingCustomer,
  prepareCheckoutOperation,
  recordCheckoutFailure,
  type CheckoutRequest,
} from '../lib/billing-operations';

const CORS_HEADERS = corsHeaders();

function response(statusCode: number, body: unknown): APIGatewayProxyResult {
  return { statusCode, headers: CORS_HEADERS, body: JSON.stringify(body) };
}

function stripeErrorCode(err: unknown): { code: string; terminal: boolean; statusCode: number } {
  const e = err as { statusCode?: number; code?: string; type?: string };
  const providerStatus = e.statusCode ?? 500;
  if (providerStatus === 429 || providerStatus >= 500) {
    return { code: e.code ?? e.type ?? 'stripe_retryable_error', terminal: false, statusCode: 503 };
  }
  return { code: e.code ?? e.type ?? 'stripe_terminal_error', terminal: true, statusCode: 502 };
}

export const handler = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
  let client;
  let operationId: string | undefined;
  let cognitoSub: string | undefined;
  try {
    cognitoSub = event.requestContext.authorizer?.claims?.sub;
    if (!cognitoSub) return response(401, { error: 'unauthorized' });

    const key = event.headers?.['Idempotency-Key'] ?? event.headers?.['idempotency-key'];
    if (!isUuid(key)) return response(400, { error: 'invalid_idempotency_key' });

    let body: CheckoutRequest;
    try {
      body = JSON.parse(event.body ?? '{}');
    } catch {
      return response(400, { error: 'invalid_json' });
    }
    if (!body?.planCode || !body?.successUrl || !body?.cancelUrl) {
      return response(400, { error: 'missing_fields', required: ['planCode', 'successUrl', 'cancelUrl'] });
    }

    const allowedOrigin = process.env.ALLOWED_ORIGIN ?? 'http://localhost:3000';
    try {
      assertAllowedReturnUrl(body.successUrl, allowedOrigin);
      assertAllowedReturnUrl(body.cancelUrl, allowedOrigin);
    } catch {
      return response(400, { error: 'invalid_return_origin' });
    }

    const pool = await getDbPool();
    client = await pool.connect();
    const prepared = await prepareCheckoutOperation(
      client,
      cognitoSub,
      key,
      { planCode: body.planCode, successUrl: body.successUrl, cancelUrl: body.cancelUrl },
      process.env.REQUIRED_TOS_VERSION!,
    );

    if (prepared.kind === 'error') return response(prepared.statusCode, { error: prepared.error, ...prepared.extra });
    if (prepared.kind === 'replay') return response(200, prepared.response);

    operationId = prepared.operationId;
    const secret = await getStripeSecret();
    if (!secret.priceIdEmployerPro) {
      throw new StripeConfigError('stripe_price_missing');
    }

    const stripe = await getStripe();
    let customerId = prepared.existingProviderCustomerId;
    if (!customerId) {
      const customer = await stripe.customers.create(
        { email: prepared.email ?? undefined, metadata: { userId: prepared.userId } },
        { idempotencyKey: prepared.customerIdempotencyKey },
      );
      try {
        await persistBillingCustomer(client, cognitoSub, prepared.userId, customer.id);
        customerId = customer.id;
      } catch (err) {
        if (err instanceof BillingCustomerConflictError) {
          // A concurrent checkout persisted a different customer between our prepare-time
          // lookup and now. Reuse the persisted winner rather than looping as retryable —
          // the just-created Stripe customer is simply not linked to this user.
          customerId = err.persistedCustomerId;
        } else {
          throw err;
        }
      }
    }

    const session = await stripe.checkout.sessions.create(
      {
        mode: 'subscription',
        customer: customerId,
        line_items: [{ price: secret.priceIdEmployerPro, quantity: 1 }],
        success_url: body.successUrl,
        cancel_url: body.cancelUrl,
        client_reference_id: prepared.userId,
        metadata: { userId: prepared.userId, planCode: prepared.planCode, operationId },
      },
      { idempotencyKey: prepared.checkoutIdempotencyKey },
    );

    if (!session.url || !session.expires_at) {
      await recordCheckoutFailure(client, cognitoSub, operationId, 'stripe_checkout_session_invalid', true);
      return response(502, { error: 'provider_error' });
    }

    const cached = { url: session.url, sessionId: session.id };
    await markCheckoutSucceeded(client, cognitoSub, operationId, session.id, new Date(session.expires_at * 1000), cached);
    return response(200, cached);
  } catch (err) {
    if (err instanceof StripeConfigError) {
      // Permanent config problem (missing/malformed secret, bad key/price
      // prefix, unreadable SM entry) — never present this as a retryable
      // provider outage. getStripeSecret()/getStripe() are only reachable
      // after prepareCheckoutOperation returned `ready`, so operationId and
      // client are always set here; the fallback branch below only guards
      // against a future call site moving the Stripe secret lookup earlier.
      if (client && operationId && cognitoSub) {
        try { await recordCheckoutFailure(client, cognitoSub, operationId, err.reason, true); } catch (_) {}
      } else if (client) {
        try { await client.query('ROLLBACK'); } catch (_) {}
      }
      console.error('billing-checkout configuration error:', err.reason);
      return response(500, { error: 'billing_configuration_invalid' });
    }
    if (client && operationId && cognitoSub) {
      const mapped = stripeErrorCode(err);
      try { await recordCheckoutFailure(client, cognitoSub, operationId, mapped.code, mapped.terminal); } catch (_) {}
      console.error('billing-checkout provider error:', mapped.code);
      return response(mapped.statusCode, { error: mapped.terminal ? 'provider_error' : 'provider_retryable' });
    }
    if (client) { try { await client.query('ROLLBACK'); } catch (_) {} }
    console.error('billing-checkout error:', errorMessage(err));
    return response(500, { error: 'internal_error' });
  } finally {
    if (client) client.release();
  }
};
