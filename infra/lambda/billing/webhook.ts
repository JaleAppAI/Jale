/**
 * Billing webhook verifier Lambda.
 *
 * Receives POST /billing/webhook from Stripe (API Gateway).
 * - Preserves exact raw bytes for signature verification.
 * - Verifies signature BEFORE parsing or queueing.
 * - Queues a minimal envelope to SQS (no raw body, no signature in logs).
 * - Returns 2xx ONLY after SQS accepts.
 * - 400 on bad signature; 5xx on internal/SQS errors.
 * - NO DB access, NO Stripe API key, NO STRIPE_SECRET_ARN.
 */
import type { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { SQSClient, SendMessageCommand } from '@aws-sdk/client-sqs';
import { getWebhookSecret, verifyStripeEvent } from '../lib/stripe-webhook';

const sqs = new SQSClient({});

export const handler = async (
  event: APIGatewayProxyEvent,
): Promise<APIGatewayProxyResult> => {
  try {
    // ── 1. Preserve exact API Gateway body bytes ──────────────────────────
    const encodedBody = event.body ?? '';
    if (!encodedBody) {
      return { statusCode: 400, body: 'missing body' };
    }
    const rawBody: Buffer = event.isBase64Encoded
      ? Buffer.from(encodedBody, 'base64')
      : Buffer.from(encodedBody, 'utf8');

    // ── 2. Extract signature header ───────────────────────────────────────
    const signatureHeader =
      event.headers['stripe-signature'] ??
      event.headers['Stripe-Signature'] ??
      '';
    if (!signatureHeader) {
      return { statusCode: 400, body: 'missing stripe-signature' };
    }

    // ── 3. Verify before parsing/queueing ─────────────────────────────────
    const { webhookSigningSecret } = await getWebhookSecret();
    let stripeEvent;
    try {
      stripeEvent = verifyStripeEvent(rawBody, signatureHeader, webhookSigningSecret);
    } catch {
      // Never log the signature or body — they may contain sensitive data
      return { statusCode: 400, body: 'invalid signature' };
    }

    // ── 4. Build minimal verified envelope ───────────────────────────────
    // Raw body (base64-encoded for safe SQS transport) + safe metadata only.
    // The processor re-verifies using the stored raw bytes if needed.
    const receivedAt = new Date().toISOString();
    const envelope = {
      eventId: stripeEvent.id,
      eventType: stripeEvent.type,
      receivedAt,
      rawBody: rawBody.toString('base64'),
    };

    // ── 5. Enqueue — return 2xx only after SQS accepts ────────────────────
    const queueUrl = process.env.QUEUE_URL;
    if (!queueUrl) throw new Error('QUEUE_URL env var not set');

    await sqs.send(
      new SendMessageCommand({
        QueueUrl: queueUrl,
        MessageBody: JSON.stringify(envelope),
      }),
    );

    return { statusCode: 200, body: 'ok' };
  } catch (err) {
    // Log safe metadata only — never the request body or headers
    console.error('[billing-webhook] handler error:', err instanceof Error ? err.message : String(err));
    return { statusCode: 500, body: 'internal error' };
  }
};
