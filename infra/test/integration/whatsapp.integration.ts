/**
 * WhatsApp webhook integration tests.
 *
 * Runs against a deployed API Gateway. Requires:
 *   - API_URL env var pointing at the deployed stage (e.g. https://xxx.execute-api.us-east-2.amazonaws.com/dev)
 *   - Twilio secret already seeded in Secrets Manager at `jale/whatsapp/twilio`
 *
 * These tests exercise the public webhook surface only — verifying that
 * signature validation actually works end-to-end. They do NOT try to simulate
 * a full onboarding flow (that would require a real Twilio sandbox number +
 * a verified test phone; see docs/whatsapp-v1-smoke-checklist.md).
 */

import { createHmac } from 'node:crypto';

const BASE_URL = process.env.API_URL;
const WEBHOOK_PATH = '/whatsapp/webhook';

/**
 * Build a URL-encoded Twilio-shape webhook body.
 */
function buildBody(params: Record<string, string>): string {
  return new URLSearchParams(params).toString();
}

/**
 * Compute the X-Twilio-Signature header value for a given URL + params.
 * Used only when TWILIO_AUTH_TOKEN is present in env (e.g. for signed tests).
 */
function signRequest(
  url: string,
  params: Record<string, string>,
  authToken: string,
): string {
  const sorted = Object.keys(params).sort();
  const data = url + sorted.map((k) => `${k}${params[k]}`).join('');
  return createHmac('sha1', authToken).update(data).digest('base64');
}

describe('POST /whatsapp/webhook', () => {
  const webhookUrl = `${BASE_URL}${WEBHOOK_PATH}`;
  const fakeBody = buildBody({
    AccountSid: 'AC_fake',
    From: 'whatsapp:+15125551234',
    Body: 'Hola',
    MessageSid: 'SMfake_integration_test',
  });

  it('returns 403 for a request with no signature header', async () => {
    const res = await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: fakeBody,
    });
    expect(res.status).toBe(403);
  });

  it('returns 403 for a request with a forged signature', async () => {
    const res = await fetch(webhookUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'X-Twilio-Signature': 'ThisIsNotAValidSignatureAtAllXyz=',
      },
      body: fakeBody,
    });
    expect(res.status).toBe(403);
  });

  it('returns 400 for an empty body (even with a signature header)', async () => {
    const res = await fetch(webhookUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'X-Twilio-Signature': 'placeholder',
      },
      body: '',
    });
    expect(res.status).toBe(400);
  });

  // Signed-request tests — only run when TWILIO_AUTH_TOKEN is provided as an
  // env var (e.g. from a local `.env.whatsapp.test` or CI secret). Skipped
  // otherwise so CI doesn't require Twilio credentials.
  const authToken = process.env.TWILIO_AUTH_TOKEN;
  (authToken ? describe : describe.skip)('signed requests', () => {
    it('returns 200 for a correctly signed request', async () => {
      const params = {
        AccountSid: 'AC_integration_test',
        From: 'whatsapp:+15125551234',
        Body: 'Hola',
        MessageSid: `SM_integ_${Date.now()}`, // unique to avoid idempotency skip
      };
      const body = buildBody(params);
      const signature = signRequest(webhookUrl, params, authToken!);

      const res = await fetch(webhookUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'X-Twilio-Signature': signature,
        },
        body,
      });

      expect(res.status).toBe(200);
    });

    it('returns 200 for a signed button-callback payload', async () => {
      // Button callbacks arrive as regular POSTs with a ButtonPayload field.
      const params = {
        AccountSid: 'AC_integration_test',
        From: 'whatsapp:+15125551234',
        MessageSid: `SM_btn_${Date.now()}`,
        ButtonPayload: 'decline:job-does-not-exist',
        Body: '',
      };
      const body = buildBody(params);
      const signature = signRequest(webhookUrl, params, authToken!);

      const res = await fetch(webhookUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'X-Twilio-Signature': signature,
        },
        body,
      });

      // The webhook just pushes to SQS — it returns 200 whether or not the
      // downstream processor can find the job.
      expect(res.status).toBe(200);
    });
  });
});
