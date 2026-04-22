import type { CreateAuthChallengeTriggerEvent } from 'aws-lambda';
import {
  SecretsManagerClient,
  GetSecretValueCommand,
} from '@aws-sdk/client-secrets-manager';

/**
 * CreateAuthChallenge: Generates a 6-digit OTP, sends it via Twilio SMS to the
 * user's phone, and stores the OTP in privateChallengeParameters (server-side only).
 *
 * Cognito passes privateChallengeParameters to VerifyAuthChallenge during the
 * user's RespondToAuthChallenge call. The OTP is never sent to the client.
 *
 * publicChallengeParameters carries a UI-safe hint only ("SMS sent to +1***1234").
 *
 * Fix Plan v3 (Fix 6, 2026-04-17): Twilio credentials are loaded from AWS
 * Secrets Manager (`jale/whatsapp/otp-twilio`), not from plaintext Lambda
 * environment variables. The secret JSON shape is:
 *   { accountSid, authToken, messagingServiceSid }
 * The auth-stack sets TWILIO_SECRET_ARN on the Lambda and grants read via
 * IAM. An operator seeds the secret value manually before first OTP flow.
 * The Messaging Service is shared with the WhatsApp secret — it carries
 * both an SMS-capable sender and a WhatsApp sender on the same number.
 */

// ── Module-level Secrets Manager client + 5-minute cache ──────────────────
// Secrets Manager credentials rotate on a schedule, so a 5-minute TTL lets a
// warm Lambda container pick up a new value within 5 minutes of rotation
// instead of holding stale creds until cold-start.
interface OtpTwilioSecret {
  accountSid: string;
  authToken: string;
  messagingServiceSid: string;
}

const secretsManager = new SecretsManagerClient({});
let cachedSecret: OtpTwilioSecret | null = null;
let cachedAt = 0;
const CACHE_TTL_MS = 5 * 60 * 1000;

async function getOtpTwilioSecret(): Promise<OtpTwilioSecret> {
  const now = Date.now();
  if (cachedSecret && now - cachedAt < CACHE_TTL_MS) {
    return cachedSecret;
  }
  const arn = process.env.TWILIO_SECRET_ARN;
  if (!arn) {
    throw new Error(
      'Missing TWILIO_SECRET_ARN env var; expected Secrets Manager ARN for jale/whatsapp/otp-twilio',
    );
  }
  const resp = await secretsManager.send(
    new GetSecretValueCommand({ SecretId: arn }),
  );
  if (!resp.SecretString) {
    throw new Error('TWILIO_SECRET_ARN secret has no SecretString');
  }
  const parsed = JSON.parse(resp.SecretString) as Partial<OtpTwilioSecret>;
  if (!parsed.accountSid || !parsed.authToken || !parsed.messagingServiceSid) {
    throw new Error(
      'jale/whatsapp/otp-twilio secret missing required fields accountSid/authToken/messagingServiceSid',
    );
  }
  cachedSecret = parsed as OtpTwilioSecret;
  cachedAt = now;
  return cachedSecret;
}

export const handler = async (
  event: CreateAuthChallengeTriggerEvent,
): Promise<CreateAuthChallengeTriggerEvent> => {
  // Only generate a new OTP on the first attempt of this session.
  // On retries, reuse the previously issued challenge so the user can
  // re-enter the same OTP they received.
  let otp: string;
  const session = event.request.session;

  if (session.length > 0 && session[session.length - 1].challengeMetadata) {
    // Reuse OTP from previous challenge (stored in challengeMetadata)
    otp = session[session.length - 1].challengeMetadata as string;
  } else {
    // Generate a new 6-digit OTP using crypto.randomInt (cryptographically secure)
    otp = generateOtp();

    // Send OTP via Twilio SMS to the user's phone
    const phoneNumber = event.request.userAttributes.phone_number;
    if (!phoneNumber) {
      throw new Error('Missing phone_number attribute on user');
    }

    await sendTwilioSms(phoneNumber, `Your Jale verification code is: ${otp}`);
  }

  // Mask the phone number for display (e.g. "+1***1234")
  const phone = event.request.userAttributes.phone_number ?? '';
  const phoneHint = maskPhone(phone);

  event.response.publicChallengeParameters = {
    hint: `SMS sent to ${phoneHint}`,
  };
  event.response.privateChallengeParameters = {
    otp,
  };
  // challengeMetadata is included in the next session entry, enabling OTP reuse on retry
  event.response.challengeMetadata = otp;

  return event;
};

async function sendTwilioSms(to: string, body: string): Promise<void> {
  const { accountSid, authToken, messagingServiceSid } = await getOtpTwilioSecret();

  const auth = Buffer.from(`${accountSid}:${authToken}`).toString('base64');
  const url = `https://api.twilio.com/2010-04-01/Accounts/${accountSid}/Messages.json`;
  const body_ = new URLSearchParams({
    To: to,
    MessagingServiceSid: messagingServiceSid,
    Body: body,
  });

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${auth}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: body_,
  });

  if (!response.ok) {
    const data = (await response.json().catch(() => ({}))) as { message?: string; code?: number };
    const detail = data.message ?? `HTTP ${response.status}`;
    throw new Error(`Twilio SMS send failed: ${detail}`);
  }
}

function generateOtp(): string {
  // 6-digit OTP using Node's built-in crypto (available in Lambda Node.js 20 runtime)
  const crypto = require('node:crypto');
  const n = crypto.randomInt(0, 1_000_000);
  return n.toString().padStart(6, '0');
}

function maskPhone(phone: string): string {
  // E.164 format like +15125551234 → "+1***1234"
  if (phone.length < 4) return '***';
  return phone.slice(0, 2) + '***' + phone.slice(-4);
}

// Exported only for tests — clear the module-level cache between scenarios.
export function _clearSecretCacheForTests(): void {
  cachedSecret = null;
  cachedAt = 0;
}
