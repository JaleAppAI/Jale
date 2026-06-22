import type { APIGatewayProxyEvent } from 'aws-lambda';
import { createHmac } from 'node:crypto';

// Mock AWS SDK clients BEFORE importing the handler
const mockSqsSend = jest.fn();
const mockSecretsSend = jest.fn();

jest.mock('@aws-sdk/client-sqs', () => ({
  SQSClient: jest.fn(() => ({ send: mockSqsSend })),
  SendMessageCommand: jest.fn((args) => ({ input: args, __type: 'SendMessageCommand' })),
}));

jest.mock('@aws-sdk/client-secrets-manager', () => ({
  SecretsManagerClient: jest.fn(() => ({ send: mockSecretsSend })),
  GetSecretValueCommand: jest.fn((args) => ({ input: args, __type: 'GetSecretValueCommand' })),
}));

import { handler } from '../../../../lambda/whatsapp/webhook';

describe('Webhook Lambda', () => {
  const authToken = 'test-auth-token-1234567890';
  const accountSid = 'AC12345';
  const messagingServiceSid = 'MGtest12345';

  const originalEnv = process.env;

  beforeEach(() => {
    jest.clearAllMocks();
    // Reset module state — clear the in-memory secret cache between tests
    jest.resetModules();
    process.env = {
      ...originalEnv,
      TWILIO_SECRET_ARN: 'arn:aws:secretsmanager:us-east-2:123:secret:jale/whatsapp/twilio',
      SQS_QUEUE_URL: 'https://sqs.us-east-2.amazonaws.com/123/whatsapp-inbound-queue',
    };

    mockSecretsSend.mockResolvedValue({
      SecretString: JSON.stringify({
        accountSid,
        authToken,
        messagingServiceSid,
      }),
    });
    mockSqsSend.mockResolvedValue({ MessageId: 'sqs-msg-123' });
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  // Helper: build a signed API Gateway event that would pass validation
  const buildSignedEvent = (
    body: Record<string, string>,
    opts: { tamper?: boolean; skipSignature?: boolean; base64?: boolean } = {},
  ): APIGatewayProxyEvent => {
    const rawBody = new URLSearchParams(body).toString();
    // Re-parse because URLSearchParams decodes percent-encoded values
    const params = Object.fromEntries(new URLSearchParams(rawBody));
    const fullUrl = 'https://xxx.execute-api.us-east-2.amazonaws.com/dev/whatsapp/webhook';
    const sorted = Object.keys(params).sort();
    const data = fullUrl + sorted.map((k) => `${k}${params[k]}`).join('');
    const sig = createHmac('sha1', authToken).update(data).digest('base64');
    const finalSig = opts.tamper ? 'WRONG_SIGNATURE_VALUE_abc123' : sig;

    return {
      body: opts.base64 ? Buffer.from(rawBody, 'utf8').toString('base64') : rawBody,
      isBase64Encoded: opts.base64,
      headers: opts.skipSignature ? {} : { 'X-Twilio-Signature': finalSig },
      requestContext: {
        domainName: 'xxx.execute-api.us-east-2.amazonaws.com',
        stage: 'dev',
        path: '/dev/whatsapp/webhook',
      } as any,
    } as unknown as APIGatewayProxyEvent;
  };

  it('returns 200 with empty TwiML and pushes to SQS on valid signature', async () => {
    const event = buildSignedEvent({
      AccountSid: accountSid,
      From: 'whatsapp:+15125551234',
      Body: 'Hola',
      MessageSid: 'SM123',
    });

    const result = await handler(event);

    expect(result.statusCode).toBe(200);
    // Twilio rejects non-XML webhook responses (Error 12300) and re-delivers
    // via its fallback URL — the success response must be TwiML.
    expect(result.headers).toEqual({ 'Content-Type': 'text/xml' });
    expect(result.body).toBe('<?xml version="1.0" encoding="UTF-8"?><Response/>');
    expect(mockSqsSend).toHaveBeenCalledTimes(1);
    expect(mockSqsSend).toHaveBeenCalledWith(
      expect.objectContaining({
        input: expect.objectContaining({
          QueueUrl: process.env.SQS_QUEUE_URL,
          MessageBody: event.body,
        }),
      }),
    );
  });

  it('returns 403 and does NOT push to SQS on invalid signature', async () => {
    const event = buildSignedEvent(
      { AccountSid: accountSid, Body: 'Hola', MessageSid: 'SM123' },
      { tamper: true },
    );

    const result = await handler(event);

    expect(result.statusCode).toBe(403);
    expect(mockSqsSend).not.toHaveBeenCalled();
  });

  it('returns 403 when signature header is missing', async () => {
    const event = buildSignedEvent(
      { Body: 'Hola', MessageSid: 'SM123' },
      { skipSignature: true },
    );

    const result = await handler(event);

    expect(result.statusCode).toBe(403);
    expect(mockSqsSend).not.toHaveBeenCalled();
  });

  it('returns 400 on empty body', async () => {
    const event = {
      body: '',
      headers: { 'X-Twilio-Signature': 'xxx' },
      requestContext: {
        domainName: 'xxx.execute-api.us-east-2.amazonaws.com',
        path: '/dev/whatsapp/webhook',
      } as any,
    } as unknown as APIGatewayProxyEvent;

    const result = await handler(event);

    expect(result.statusCode).toBe(400);
    expect(mockSqsSend).not.toHaveBeenCalled();
  });

  it('returns 400 and does NOT queue validly signed malformed Twilio bodies', async () => {
    const event = buildSignedEvent({
      AccountSid: accountSid,
      Body: 'Hola',
      MessageSid: 'SM123',
    });

    const result = await handler(event);

    expect(result.statusCode).toBe(400);
    expect(mockSqsSend).not.toHaveBeenCalled();
  });

  it('decodes base64 API Gateway bodies before signature validation and queueing', async () => {
    const event = buildSignedEvent({
      AccountSid: accountSid,
      From: 'whatsapp:+15125551234',
      Body: 'Hola',
      MessageSid: 'SM-base64',
    }, { base64: true });
    const rawBody = new URLSearchParams({
      AccountSid: accountSid,
      From: 'whatsapp:+15125551234',
      Body: 'Hola',
      MessageSid: 'SM-base64',
    }).toString();

    const result = await handler(event);

    expect(result.statusCode).toBe(200);
    expect(mockSqsSend).toHaveBeenCalledWith(
      expect.objectContaining({
        input: expect.objectContaining({
          MessageBody: rawBody,
        }),
      }),
    );
  });

  it('preserves the raw body when pushing to SQS (not a re-encoded version)', async () => {
    const rawBody =
      'AccountSid=AC1&From=whatsapp%3A%2B15125551234&Body=Hola%20%F0%9F%91%8B&MessageSid=SM9';
    // Build signature over the parsed form
    const params = Object.fromEntries(new URLSearchParams(rawBody));
    const fullUrl = 'https://xxx.execute-api.us-east-2.amazonaws.com/dev/whatsapp/webhook';
    const sig = createHmac('sha1', authToken)
      .update(
        fullUrl +
          Object.keys(params).sort().map((k) => `${k}${params[k]}`).join(''),
      )
      .digest('base64');

    const event = {
      body: rawBody,
      headers: { 'X-Twilio-Signature': sig },
      requestContext: {
        domainName: 'xxx.execute-api.us-east-2.amazonaws.com',
        path: '/dev/whatsapp/webhook',
      } as any,
    } as unknown as APIGatewayProxyEvent;

    const result = await handler(event);
    expect(result.statusCode).toBe(200);

    // SQS receives the RAW (URL-encoded) body, not the decoded form
    expect(mockSqsSend).toHaveBeenCalledWith(
      expect.objectContaining({
        input: expect.objectContaining({
          MessageBody: rawBody,
        }),
      }),
    );
  });

  it('accepts lowercase x-twilio-signature header', async () => {
    const event = buildSignedEvent({
      AccountSid: accountSid,
      From: 'whatsapp:+15125551234',
      Body: 'Hola',
      MessageSid: 'SM123',
    });
    const sig = event.headers['X-Twilio-Signature'];
    const lowercaseEvent = {
      ...event,
      headers: { 'x-twilio-signature': sig },
    };

    const result = await handler(lowercaseEvent as any);

    expect(result.statusCode).toBe(200);
    expect(mockSqsSend).toHaveBeenCalledTimes(1);
  });

  it('uses X-Forwarded-Host for URL reconstruction when present', async () => {
    // Twilio configured with a custom domain — signature must match that domain
    const rawBody = 'From=whatsapp%3A%2B15125551234&MessageSid=SM123&Body=Hola';
    const params = Object.fromEntries(new URLSearchParams(rawBody));
    const fullUrl = 'https://api.jale.com/dev/whatsapp/webhook';
    const sig = createHmac('sha1', authToken)
      .update(
        fullUrl +
          Object.keys(params).sort().map((k) => `${k}${params[k]}`).join(''),
      )
      .digest('base64');

    const event = {
      body: rawBody,
      headers: {
        'X-Twilio-Signature': sig,
        'X-Forwarded-Host': 'api.jale.com',
      },
      requestContext: {
        domainName: 'xxx.execute-api.us-east-2.amazonaws.com',
        path: '/dev/whatsapp/webhook',
      } as any,
    } as unknown as APIGatewayProxyEvent;

    const result = await handler(event);
    expect(result.statusCode).toBe(200);
  });
});
