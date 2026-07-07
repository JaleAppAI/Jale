/**
 * Tests for infra/lambda/billing/webhook.ts
 *
 * Covers:
 *  - byte-exact queue envelope assertion (base64 and utf8 paths)
 *  - 2xx only after successful SQS send
 *  - SQS failure → 5xx (not 2xx)
 *  - bad signature → 400 with no SQS send
 *  - missing body → 400
 *  - missing signature header → 400
 *  - no body/signature in any log call
 */
import type { APIGatewayProxyEvent } from 'aws-lambda';
import Stripe = require('stripe');
import { handler } from '../../../lambda/billing/webhook';

// ── Mock stripe-webhook module ─────────────────────────────────────────────
jest.mock('../../../lambda/lib/stripe-webhook');
// eslint-disable-next-line @typescript-eslint/no-require-imports
const stripeWebhookMock = require('../../../lambda/lib/stripe-webhook');
const mockGetWebhookSecret: jest.Mock = stripeWebhookMock.getWebhookSecret;
const mockVerifyStripeEvent: jest.Mock = stripeWebhookMock.verifyStripeEvent;

// ── Mock SQS ──────────────────────────────────────────────────────────────
// Use a plain class (not jest.fn) for SendMessageCommand so jest.resetAllMocks()
// cannot clear its constructor. We expose sqsInputs[] to the test via __getInputs.
jest.mock('@aws-sdk/client-sqs', () => {
  const send = jest.fn();
  // sqsInputs accumulates every SendMessageCommand input; cleared by tests via __clearInputs.
  const sqsInputs: unknown[] = [];
  class SendMessageCommand {
    input: unknown;
    constructor(params: unknown) {
      sqsInputs.push(params);
      this.input = params;
    }
  }
  const SQSClient = jest.fn().mockImplementation(() => ({ send }));
  return {
    SQSClient,
    SendMessageCommand,
    __mockSend: send,
    __getLastInput: () => sqsInputs[sqsInputs.length - 1],
    __clearInputs: () => { sqsInputs.length = 0; },
  };
});
// eslint-disable-next-line @typescript-eslint/no-require-imports
const sqsMock = require('@aws-sdk/client-sqs');
const mockSqsSend: jest.Mock = sqsMock.__mockSend;

// Fake signing secret — never a real value
const FAKE_SECRET = 'whsec_' + '0'.repeat(32);

// Minimal valid Stripe event payload for tests
const PAYLOAD_OBJ = {
  id: 'evt_test000',
  object: 'event',
  type: 'customer.subscription.created',
  data: { object: { id: 'sub_test000' } },
};
const PAYLOAD_STRING = JSON.stringify(PAYLOAD_OBJ);

// Build a real signed header for crypto tests
function makeSignedHeader(payload: string, secret = FAKE_SECRET): string {
  return Stripe.webhooks.generateTestHeaderString({ payload, secret });
}

// Build a fake Stripe event object (what verifyStripeEvent returns)
function fakeEvent(overrides: Partial<{ id: string; type: string }> = {}): Stripe.Event {
  return {
    id: overrides.id ?? 'evt_test000',
    type: overrides.type ?? 'customer.subscription.created',
    object: 'event',
    data: { object: {} },
  } as unknown as Stripe.Event;
}

function makeEvent(overrides: Partial<APIGatewayProxyEvent> = {}): APIGatewayProxyEvent {
  return {
    body: PAYLOAD_STRING,
    isBase64Encoded: false,
    headers: { 'stripe-signature': makeSignedHeader(PAYLOAD_STRING) },
    requestContext: {},
    ...overrides,
  } as unknown as APIGatewayProxyEvent;
}

describe('billing webhook handler', () => {
  const originalEnv = process.env;
  let consoleSpy: jest.SpyInstance;

  beforeEach(() => {
    jest.resetAllMocks();
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    require('@aws-sdk/client-sqs').__clearInputs();
    process.env = { ...originalEnv, QUEUE_URL: 'https://sqs.us-east-1.amazonaws.com/000000000000/billing-test' };
    // Default: secret loads successfully, signature verifies successfully
    mockGetWebhookSecret.mockResolvedValue({ webhookSigningSecret: FAKE_SECRET });
    mockVerifyStripeEvent.mockReturnValue(fakeEvent());
    mockSqsSend.mockResolvedValue({ MessageId: 'msg-id-001' });
    consoleSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    jest.spyOn(console, 'log').mockImplementation(() => {});
    jest.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    consoleSpy.mockRestore();
    jest.restoreAllMocks();
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  // ── Body handling ──────────────────────────────────────────────────────

  it('returns 400 when body is missing', async () => {
    const res = await handler(makeEvent({ body: null }));
    expect(res.statusCode).toBe(400);
    expect(res.body).toContain('missing body');
    expect(mockSqsSend).not.toHaveBeenCalled();
  });

  it('returns 400 when body is empty string', async () => {
    const res = await handler(makeEvent({ body: '' }));
    expect(res.statusCode).toBe(400);
    expect(mockSqsSend).not.toHaveBeenCalled();
  });

  // ── Signature header ───────────────────────────────────────────────────

  it('returns 400 when stripe-signature header is missing', async () => {
    const res = await handler(makeEvent({ headers: {} }));
    expect(res.statusCode).toBe(400);
    expect(res.body).toContain('missing stripe-signature');
    expect(mockSqsSend).not.toHaveBeenCalled();
  });

  it('accepts Stripe-Signature (case variant) header', async () => {
    const res = await handler(makeEvent({ headers: { 'Stripe-Signature': makeSignedHeader(PAYLOAD_STRING) } }));
    expect(res.statusCode).toBe(200);
  });

  // ── Signature verification ─────────────────────────────────────────────

  it('returns 400 and does NOT call SQS when signature verification fails', async () => {
    mockVerifyStripeEvent.mockImplementation(() => {
      throw new Stripe.errors.StripeSignatureVerificationError(
        'test-header',
        'test-payload',
      );
    });
    const res = await handler(makeEvent());
    expect(res.statusCode).toBe(400);
    expect(res.body).toContain('invalid signature');
    expect(mockSqsSend).not.toHaveBeenCalled();
  });

  it('does NOT log body or signature on bad signature', async () => {
    mockVerifyStripeEvent.mockImplementation(() => {
      throw new Error('bad signature');
    });
    await handler(makeEvent());
    // Check all console methods never received body or signature content
    const allCalls = [
      ...consoleSpy.mock.calls,
    ].flat();
    for (const call of allCalls) {
      const str = typeof call === 'string' ? call : JSON.stringify(call);
      expect(str).not.toContain(PAYLOAD_STRING);
      // signature header is 't=...,v1=...' format; we check it doesn't appear
      expect(str).not.toMatch(/t=\d+,v1=/);
    }
  });

  // ── UTF-8 (non-base64) body path ───────────────────────────────────────

  it('sends a byte-exact envelope for UTF-8 body (isBase64Encoded=false)', async () => {
    const res = await handler(makeEvent({ isBase64Encoded: false }));
    expect(res.statusCode).toBe(200);

    expect(mockSqsSend).toHaveBeenCalledTimes(1);
    // Access the input passed to SendMessageCommand constructor
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const sqsModule = require('@aws-sdk/client-sqs');
    const capturedInput = sqsModule.__getLastInput() as { QueueUrl: string; MessageBody: string };
    expect(capturedInput).toBeDefined();
    const envelope = JSON.parse(capturedInput.MessageBody);

    // Envelope must contain safe metadata only (no raw signature)
    expect(envelope.eventId).toBe('evt_test000');
    expect(envelope.eventType).toBe('customer.subscription.created');
    expect(envelope).toHaveProperty('receivedAt');
    expect(envelope).toHaveProperty('rawBody');

    // rawBody must be exactly the base64 of the UTF-8 source bytes
    const expectedBase64 = Buffer.from(PAYLOAD_STRING, 'utf8').toString('base64');
    expect(envelope.rawBody).toBe(expectedBase64);
  });

  // ── Base64 body path ───────────────────────────────────────────────────

  it('sends a byte-exact envelope for base64-encoded body (isBase64Encoded=true)', async () => {
    const base64Body = Buffer.from(PAYLOAD_STRING, 'utf8').toString('base64');
    const res = await handler(makeEvent({ body: base64Body, isBase64Encoded: true }));
    expect(res.statusCode).toBe(200);

    // Access the input passed to SendMessageCommand constructor
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const sqsModuleB64 = require('@aws-sdk/client-sqs');
    const capturedInputB64 = sqsModuleB64.__getLastInput() as { QueueUrl: string; MessageBody: string };
    expect(capturedInputB64).toBeDefined();
    const envelope = JSON.parse(capturedInputB64.MessageBody);

    // Decoded then re-encoded must be byte-identical to original UTF-8 payload
    const decodedRaw = Buffer.from(envelope.rawBody, 'base64').toString('utf8');
    expect(decodedRaw).toBe(PAYLOAD_STRING);

    // verifyStripeEvent must have been called with the decoded Buffer
    expect(mockVerifyStripeEvent).toHaveBeenCalledWith(
      Buffer.from(base64Body, 'base64'), // decoded bytes
      expect.any(String),
      FAKE_SECRET,
    );
  });

  // ── SQS failure → 5xx ─────────────────────────────────────────────────

  it('returns 5xx when SQS send fails — does NOT return 2xx', async () => {
    mockSqsSend.mockRejectedValueOnce(new Error('SQS unavailable'));
    const res = await handler(makeEvent());
    expect(res.statusCode).toBe(500);
    expect(res.statusCode).not.toBe(200);
  });

  // ── Success: 2xx after SQS accepts ────────────────────────────────────

  it('returns 200 after SQS accepts the message', async () => {
    const res = await handler(makeEvent());
    expect(res.statusCode).toBe(200);
    expect(mockSqsSend).toHaveBeenCalledTimes(1);
  });

  // ── QUEUE_URL missing ────────────────────────────────────────────────

  it('returns 5xx when QUEUE_URL is not set', async () => {
    delete process.env.QUEUE_URL;
    const res = await handler(makeEvent());
    expect(res.statusCode).toBe(500);
  });

  // ── verifyStripeEvent receives exact raw bytes ────────────────────────

  it('passes the raw Buffer (not re-serialized JSON) to verifyStripeEvent', async () => {
    await handler(makeEvent({ body: PAYLOAD_STRING, isBase64Encoded: false }));
    const [rawBodyArg] = mockVerifyStripeEvent.mock.calls[0];
    expect(Buffer.isBuffer(rawBodyArg)).toBe(true);
    expect(rawBodyArg.toString('utf8')).toBe(PAYLOAD_STRING);
  });
});
